require('dotenv').config();
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');
const os = require('os');
const rateLimit = require('express-rate-limit');
const { OUTPUTS_DIR, DATA_HOME, PACKAGE_ROOT, ensureDir, setProcessBroadcaster, spawnClaude, buildClaudeArgs } = require('./src/utils');
const InteractionStore = require('./src/store');
const DashboardBroadcaster = require('./src/dashboard-ws');
const createProxyRouter = require('./src/proxy');
const { pendingQuestions } = createProxyRouter;
const CliSessionManager = require('./src/cli-sessions');
const caps = require('./src/capabilities');
const mcp = require('./src/mcp');
const { createLicensing } = require('./src/licensing');
const addons = require('./src/addons');
const { createAddonCtx } = require('./src/addon-host');
const { createAuth } = require('./src/auth');
let proModule = null;   // the loaded ./vistaclair-pro module (for licensing/update)
let proAddon = null;    // its registered descriptor (null until init succeeds)
let proLicenseValid = false;
const isDev = process.argv.includes('dev');
if (isDev && !process.env.DEV_LICENCING_SERVER) {
  console.error('Error: DEV_LICENCING_SERVER is not set. Create a .env file with DEV_LICENCING_SERVER=http://localhost:8888');
  process.exit(1);
}
const licensing = createLicensing({ dataHome: DATA_HOME, isDev });
const { proDir, validateLicense, fetchProductInfo, checkProUpdates, npmInstall } = licensing;
const ruleHandler = require('./src/proxy-rule-handler');
const createApiRouter = require('./src/api');

// Check and auto-install native dependencies, then restart so they load
(function checkDependencies() {
  const { execFileSync } = require('child_process');
  const missing = [];
  try { require.resolve('node-pty'); } catch { missing.push('node-pty'); }
  if (missing.length === 0) return;
  if (process.env.VISTACLAIR_SERVER === '1') {
    // Server mode: never mutate the install at boot — install at deploy time.
    console.warn(`Warning: missing dependencies: ${missing.join(', ')}. CLI terminal feature will be unavailable. Run: npm install ${missing.join(' ')}`);
    return;
  }
  console.log(`Installing missing dependencies: ${missing.join(', ')}...`);
  try {
    execFileSync('npm', ['install', '--no-save', ...missing], { cwd: __dirname, stdio: 'inherit' });
  } catch (err) {
    console.error(`Failed to install dependencies: ${err.message}`);
    console.error('CLI terminal feature will be unavailable. Run manually: npm install ' + missing.join(' '));
    return;
  }
  console.log('Dependencies installed. Restarting...\n');
  const child = require('child_process').spawnSync(process.execPath, process.argv.slice(1), { cwd: __dirname, stdio: 'inherit' });
  process.exit(child.status ?? 1);
})();

(async () => {

const fs = require('fs');
fetchProductInfo();
setInterval(fetchProductInfo, 60 * 60 * 1000);

if (fs.existsSync(proDir)) {
  const result = await validateLicense();
  proLicenseValid = result.valid;
  if (proLicenseValid) {
    try { proModule = require('./vistaclair-pro'); } catch (e) {
      // Self-heal installs that were cloned before deps were installed (older
      // installer) or whose install was interrupted — otherwise the GUI loops
      // on needsRestart forever (installed && licensed && !loaded).
      if (e.code === 'MODULE_NOT_FOUND') {
        console.error('  Pro: missing dependencies, installing...');
        try {
          npmInstall(proDir);
          proModule = require('./vistaclair-pro');
          console.log('  Pro: dependencies installed');
        } catch (e2) {
          console.error('  Pro: dependency install failed:', e2.message);
        }
      } else {
        console.error('  Pro: failed to load:', e.message);
      }
    }
  } else {
    console.log(`  Pro: license invalid (${result.reason}) — running in free mode`);
  }
}

const PROXY_PORT = parseInt(process.env.PROXY_PORT || '3456');
const PORT_ARG = process.argv.slice(2).find(a => /^\d+$/.test(a));
const DASHBOARD_PORT = parseInt(PORT_ARG || process.env.DASHBOARD_PORT || '3457');
const TARGET_URL = process.env.ANTHROPIC_TARGET_URL || 'https://api.anthropic.com';
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '200');
const SERVER_MODE = process.env.VISTACLAIR_SERVER === '1';
// Server mode: a generated token would rotate on every pm2 restart, breaking
// internal callers (MCP tools, app-runners) that hold the old value.
if (SERVER_MODE && !process.env.AUTH_TOKEN) {
  console.error('Error: VISTACLAIR_SERVER=1 requires an explicit AUTH_TOKEN env variable.');
  process.exit(1);
}
const AUTH_TOKEN = process.env.AUTH_TOKEN || crypto.randomUUID();
const AUTH_TOKEN_SOURCE = process.env.AUTH_TOKEN ? 'env' : 'generated';
const DASHBOARD_HOST = process.env.DASHBOARD_HOST || (SERVER_MODE ? '127.0.0.1' : undefined);

// Shared store
const store = new InteractionStore(MAX_HISTORY);

// Telegram device-code login + dashboard sessions
const { createTgLogin } = require('./src/tg-login');
const tgLogin = createTgLogin({ dataHome: DATA_HOME });
tgLogin.start();

// --- Proxy server (port 3456) ---
const proxyApp = express();
let broadcaster = { broadcast() {} };

const proxyRouter = createProxyRouter(store, { broadcast: (...args) => broadcaster.broadcast(...args) }, TARGET_URL);
proxyApp.use(proxyRouter);
const proxyServer = http.createServer(proxyApp);

// --- Dashboard server (port 3457) ---
const dashboardApp = express();
dashboardApp.set('trust proxy', 'loopback')  // proxies (nginx/ngrok/cloudflared) all run on localhost
// verify stashes the raw bytes so HMAC-authenticated webhooks (e.g. WhatsApp's
// X-Hub-Signature-256) can validate against exactly what was sent, since this
// global parser consumes the stream before per-route express.raw() can run.
dashboardApp.use(express.json({ limit: '50mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
dashboardApp.use(express.urlencoded({ extended: false }));

// Owner authentication — one definition (src/auth.js) shared by the HTTP
// middleware, the WS upgrade, host-local endpoints, and the addon ctx.
const auth = createAuth({ authToken: AUTH_TOKEN, tgLogin });
const { isLoopback, safeEqual, getSidFromCookies, tokenLoginAllowed, isInternal } = auth;

function authCookie(name, value, extra = '') {
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/${SERVER_MODE ? '; Secure' : ''}${extra}`;
}

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, try again in a minute' },
});

// Login routes (no auth required)
dashboardApp.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

dashboardApp.post('/login', authLimiter, (req, res) => {
  if (tokenLoginAllowed(req) && safeEqual(req.body.token, AUTH_TOKEN)) {
    res.setHeader('Set-Cookie', authCookie('token', AUTH_TOKEN));
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});

dashboardApp.get('/login/auto', authLimiter, (req, res) => {
  if (!isLoopback(req)) return res.redirect('/login');
  if (safeEqual(req.query.token, AUTH_TOKEN)) {
    res.setHeader('Set-Cookie', authCookie('token', AUTH_TOKEN));
    return res.redirect('/');
  }
  res.redirect('/login');
});

// Telegram device-code login (unauthenticated challenge endpoints)
dashboardApp.get('/login/tg/info', (req, res) => {
  res.json({ configured: tgLogin.configured(), tokenLoginAllowed: tokenLoginAllowed(req) });
});

dashboardApp.post('/login/tg/start', authLimiter, (req, res) => {
  if (!tgLogin.configured()) return res.status(404).json({ error: 'Telegram login not configured' });
  const challenge = tgLogin.startChallenge({ ip: req.ip, ua: req.headers['user-agent'] });
  if (!challenge) return res.status(429).json({ error: 'Too many pending logins' });
  res.json(challenge);
});

dashboardApp.post('/login/tg/poll', (req, res) => {
  const result = tgLogin.pollChallenge(req.body?.nonce);
  if (result === 'pending') return res.json({ status: 'pending' });
  if (result === 'expired') return res.json({ status: 'expired' });
  res.setHeader('Set-Cookie', authCookie('sid', result.sid));
  res.json({ status: 'ok' });
});

// One-time login link redemption (minted host-locally via `vistaclair login-link`)
dashboardApp.get('/login/once', authLimiter, (req, res) => {
  const sid = tgLogin.redeemOneTimeLink(req.query.k, { ip: req.ip, ua: req.headers['user-agent'] });
  if (!sid) return res.redirect('/login');
  res.setHeader('Set-Cookie', authCookie('sid', sid));
  res.redirect('/');
});

// Hook reporter endpoint (auth via body token, no cookie needed)
let hookSeq = 0;
dashboardApp.post('/api/hook-report', (req, res) => {
  if (!safeEqual(req.body?.token, AUTH_TOKEN)) return res.status(401).end();
  try {
    const hookData = typeof req.body.hookData === 'string' ? JSON.parse(req.body.hookData) : req.body.hookData;
    const id = `hook-${Date.now()}-${++hookSeq}`;
    const hookTs = hookData.timestamp || Date.now();
    const hookEvent = hookData.hook_event_name || 'unknown';
    const interaction = {
      id, timestamp: hookTs, isHook: true,
      instanceId: req.body.instanceId || null,
      hookEvent,
      toolName: hookData.tool_name || null,
      toolUseId: hookData.tool_use_id || null,
      hookAgentId: hookData.agent_id || null,
      request: hookData,
      response: { status: 200, body: hookData.tool_response || null },
      timing: { startedAt: hookTs, duration: hookData.duration_ms || 0 },
      status: 'complete', isStreaming: false,
    };
    const sessId = hookData.session_id
      || (interaction.instanceId?.startsWith('cli-') ? interaction.instanceId.slice(4) : null);

    // Stand up the authoritative trace index as soon as we learn the transcript
    // path (SessionStart carries it; so do most subsequent hooks).
    if (sessId && hookData.transcript_path) {
      store.attachTraceIndex(sessId, hookData.transcript_path, broadcaster);
    }

    // Every hook that carries an agent_id belongs to that subagent — stamp it
    // directly (instant, no file read). Tool-call hooks without agent_id are
    // resolved by tool_use_id via the trace index inside store.save/applyResolution.
    if (hookData.agent_id) {
      let metaDescription = hookData.description || null;
      let metaToolUseId = null;
      const ti = sessId ? store.getTraceIndex(sessId) : null;
      const meta = ti ? ti.getAgentMeta(hookData.agent_id) : null;
      if (meta) {
        metaDescription = metaDescription || meta.description;
        metaToolUseId = meta.toolUseId;
      }
      if (!metaDescription && hookData.transcript_path) {
        try {
          const sessionDir = path.join(path.dirname(hookData.transcript_path), path.basename(hookData.transcript_path, '.jsonl'));
          const metaPath = path.join(sessionDir, 'subagents', `agent-${hookData.agent_id}.meta.json`);
          const m = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          metaDescription = m.description || metaDescription;
          metaToolUseId = metaToolUseId || m.toolUseId || null;
        } catch {}
      }
      interaction.subagent = {
        agentId: hookData.agent_id,
        agentType: hookData.agent_type || meta?.agentType || 'agent',
        description: metaDescription,
        toolUseId: metaToolUseId,
      };
    }
    store.add(interaction);
    store.save(interaction.id);
    broadcaster.broadcast({ type: 'interaction:start', interaction });
    broadcaster.broadcast({ type: 'interaction:complete', interaction });

    // SubagentStop / Stop are authoritative "transcript just flushed" signals —
    // force an immediate rescan so pending LLM turns enrich without watcher lag.
    if ((hookEvent === 'SubagentStop' || hookEvent === 'Stop') && sessId) {
      store.rescanTrace(sessId);
    }
  } catch {}
  res.status(200).end();
});

// AskUserQuestion endpoint — called by vista-AskUserQuestion MCP tool handler.
// Broadcasts the question to the dashboard and waits for the user's answer.
const { getInstanceContext } = require('./src/utils');
let askSeq = 0;
dashboardApp.post('/api/ask', async (req, res) => {
  if (!safeEqual(req.body?.token, AUTH_TOKEN)) return res.status(401).end();
  const { instanceId, formData, questions } = req.body;
  const askId = `ask-${Date.now()}-${++askSeq}`;
  const ctx = instanceId ? getInstanceContext(instanceId) : null;
  const tabId = ctx?.tabId || null;
  const session = instanceId ? cliSessionManager.getByInstanceId(instanceId) : null;
  const title = session?.title || null;
  const cwd = session?.cwd || null;

  const promise = new Promise((resolve, reject) => {
    pendingQuestions.set(askId, { formData: formData || {}, questions: questions || [], resolve, reject, ctx });
  });

  // If the MCP tool gives up (4h timeout) it destroys the socket; reject the
  // pending question and tell clients to close the stale modal. Listen on the
  // response, not the request: req 'close' fires as soon as the body is read.
  res.on('close', () => {
    if (res.writableEnded) return;
    const pending = pendingQuestions.get(askId);
    if (pending) {
      pendingQuestions.delete(askId);
      if (pending.reject) pending.reject(new Error('Question timed out'));
      broadcaster.broadcast({ type: 'ask:timeout', askId });
    }
  });

  broadcaster.broadcast({
    type: 'ask:question',
    askId,
    toolUseIds: [askId],
    forms: [{ toolUseId: askId, formData: formData || {}, questions: questions || [] }],
    title,
    cwd,
    ...(tabId ? { tabId } : {}),
  });
  console.log(`[api/ask] Broadcasting ask:question askId=${askId} tabId=${tabId || '(none)'}`);

  try {
    const answer = await promise;
    res.json({ ok: true, answer });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  } finally {
    pendingQuestions.delete(askId);
  }
});

// Landing page (public, no auth)
dashboardApp.use('/landing_page', express.static(path.join(__dirname, 'public', 'landing_page')));

// Health check (no auth — used by client to detect restart completion)
dashboardApp.get('/api/ping', (req, res) => res.json({ ok: true }));

// Auth middleware for all other routes
dashboardApp.use((req, res, next) => {
  // Add-on-declared public paths (e.g. OAuth callbacks) — SameSite=Lax cookies
  // aren't sent on cross-site redirects, so these must bypass auth. Declarative
  // per-add-on list, no hardcoded product knowledge here.
  if (addons.isAuthExempt(req.path)) return next();
  // App-tool-call uses ephemeral per-session tokens validated by its own handler
  if (isLoopback(req) && req.path === '/api/app-tool-call') return next();
  // Internal header (MCP tools), Telegram session, or the static token where
  // tokenLoginAllowed — see src/auth.js.
  if (auth.isOwnerRequest(req)) return next();
  // API routes get 401 JSON; browser routes get redirect
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
});

dashboardApp.use(express.static(path.join(__dirname, 'public')));

// Serve chat outputs at /outputs (directory auto-created)
ensureDir(OUTPUTS_DIR);
dashboardApp.use('/outputs', express.static(OUTPUTS_DIR));

// Pro update check (background)
if (fs.existsSync(proDir) && proLicenseValid) {
  checkProUpdates();
  setInterval(checkProUpdates, 60 * 60 * 1000);
}

// Mount the /api/pro/* licensing routes. The lifecycle adapter bridges to the
// Pro module-load state that this file owns as the composition root.
dashboardApp.use('/api', licensing.createLicenseRouter({
  getPro: () => proModule,
  isProLoaded: () => !!proAddon,
  getProLicenseValid: () => proLicenseValid,
  getProClientModules: () => (proAddon ? addons.getClientModules() : null),
  scheduleRestart: () => scheduleRestart(),
  revalidate: async () => {
    const result = await validateLicense();
    proLicenseValid = result.valid;
  },
}));

const dashboardServer = http.createServer(dashboardApp);

const cliSessionManager = new CliSessionManager(PROXY_PORT, { broadcast: (...args) => broadcaster.broadcast(...args) }, store, { authToken: AUTH_TOKEN, dashboardPort: DASHBOARD_PORT });

// WebSocket server on dashboard (with auth)
const wss = new WebSocketServer({ noServer: true });
broadcaster = new DashboardBroadcaster(wss, store, { authToken: AUTH_TOKEN, proxyPort: PROXY_PORT, cliSessionManager });
setProcessBroadcaster(broadcaster);
store.setBroadcaster(broadcaster);

dashboardServer.on('upgrade', (req, socket, head) => {
  // Same owner decision as the HTTP middleware, against the upgrade socket.
  if (!auth.isOwnerUpgrade(req, socket)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  // Offer the upgrade to add-ons (e.g. Pro's VNC websockify proxy) first.
  if (addons.handleUpgrade(req, socket, head)) return;

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

cliSessionManager.broadcaster = broadcaster;

// Wire CLI settings getter for proxy model mapping
createProxyRouter._cliSettingsGetter = (instanceId) => cliSessionManager.getSettingsByInstanceId(instanceId);

// Initialize MCP Server Manager
mcp.init({ broadcaster, store, authToken: AUTH_TOKEN, dashboardPort: DASHBOARD_PORT });

// Initialize add-ons (Pro Apps Platform, etc.) and register their descriptors.
// init() returns a versioned descriptor; core consumes it generically — routers
// are mounted after auth (below), upgrades/clientModules/auth-exempt paths are
// dispatched through the addon registry. No per-add-on branching here.
// The ctx is built by the same factory the headless app-runner uses
// (src/addon-host.js) — one definition, two profiles. Only the dashboard-process
// services are supplied here.
const addonCtx = createAddonCtx({
  dataHome: DATA_HOME,
  dashboard: {
    authToken: AUTH_TOKEN, dashboardPort: DASHBOARD_PORT, proxyPort: PROXY_PORT,
    broadcaster, store, cliSessionManager,
    scheduleRestart: () => scheduleRestart(),
    pendingQuestions,
    clearPendingQuestionsForTab: createProxyRouter.clearPendingQuestionsForTab,
    isOwnerRequest: auth.isOwnerRequest,
    tgLoginConfigured: () => tgLogin.configured(),
  },
});
if (proModule) {
  try {
    const descriptor = proModule.init(addonCtx);
    proAddon = addons.registerAddon(descriptor);
    if (proAddon) console.log('  Pro: loaded');
    else console.error('  Pro: descriptor rejected (contract mismatch)');
  } catch (e) {
    console.error('  Pro: init failed:', e.message);
  }
}
// Mount add-on routers AFTER the auth middleware (declared above) so add-on
// routes are auth-gated by construction, except their declared authExemptPaths.
addons.mountRouters(dashboardApp);

ruleHandler.init({ broadcaster, store, proxyPort: PROXY_PORT, dashboardPort: DASHBOARD_PORT, authToken: AUTH_TOKEN });

// Mount REST API
dashboardApp.use('/api', createApiRouter({ broadcaster, store, proxyPort: PROXY_PORT, dashboardPort: DASHBOARD_PORT, authToken: AUTH_TOKEN, cliSessionManager }));

function scheduleRestart() {
  setTimeout(() => {
    broadcaster.broadcast({ type: 'server:restarting' });
    for (const client of wss.clients) {
      try { client.terminate(); } catch {}
    }
    dashboardServer.closeAllConnections?.();
    proxyServer.closeAllConnections?.();
    cliSessionManager.saveAllToHistory();
    cliSessionManager.killAll();
    mcp.shutdown();

    // Server mode: pm2 supervises us — a detached child would race the pm2
    // respawn for the ports. Just exit cleanly and let pm2 restart.
    const spawnNew = SERVER_MODE ? () => process.exit(0) : () => {
      const child = spawn(process.argv[0], process.argv.slice(1), {
        detached: true, stdio: 'inherit', cwd: process.cwd(),
        env: { ...process.env, AUTH_TOKEN, NO_OPEN: '1' },
      });
      child.unref();
      process.exit(0);
    };

    let closed = 0;
    const onClosed = () => { if (++closed >= 2) spawnNew(); };
    dashboardServer.close(onClosed);
    proxyServer.close(onClosed);
    setTimeout(spawnNew, 2000);
  }, 300);
}

// How long an idle headless (`claude -p` / ai.prompt) interaction dir is kept.
// Interactive CLI tabs are exempt — their dirs live and die with the tab and
// its saved-session entry.
const INTERACTIONS_TTL_MS = Number(process.env.VISTACLAIR_INTERACTIONS_TTL_MS) || 60 * 60 * 1000;
const INTERACTIONS_SWEEP_MS = 15 * 60 * 1000;

function sweepInteractions() {
  const pinned = cliSessionManager.getPinnedSessionIds();
  for (const id of addons.collectPinnedSessions()) pinned.add(id);
  const { swept, bytes } = store.sweepStaleSessions({ ttlMs: INTERACTIONS_TTL_MS, pinned });
  if (swept.length) {
    console.log(`  Interactions: swept ${swept.length} idle session dir(s), reclaimed ${(bytes / 1048576).toFixed(1)} MB`);
  }
}

// Broadcast relay for out-of-process addon hosts (Pro app-runners). Reachable
// only via loopback + internal header (the auth middleware admits nothing else
// here from outside, and this re-checks to be explicit).
dashboardApp.post('/api/internal/broadcast', (req, res) => {
  if (!isInternal(req)) {
    return res.status(403).json({ error: 'Internal only' });
  }
  if (!req.body || typeof req.body.type !== 'string') {
    return res.status(400).json({ error: 'Message must have a type' });
  }
  broadcaster.broadcast(req.body);
  res.json({ ok: true });
});

// --- TG login management (auth handled by middleware) ---
dashboardApp.get('/api/tg-login/config', (req, res) => {
  res.json(tgLogin.getConfigInfo());
});

dashboardApp.post('/api/tg-login/config', (req, res) => {
  const { botToken, ownerUserId, sessionTtlDays } = req.body || {};
  if (botToken !== undefined && botToken !== '' && !/^\d+:[\w-]+$/.test(String(botToken).trim())) {
    return res.status(400).json({ error: 'Invalid bot token format' });
  }
  if (ownerUserId !== undefined && ownerUserId !== '' && !/^\d+$/.test(String(ownerUserId).trim())) {
    return res.status(400).json({ error: 'Owner user id must be numeric' });
  }
  tgLogin.setConfig({ botToken, ownerUserId, sessionTtlDays });
  res.json(tgLogin.getConfigInfo());
});

dashboardApp.get('/api/sessions', (req, res) => {
  res.json({ sessions: tgLogin.listSessions(getSidFromCookies(req.headers.cookie)) });
});

dashboardApp.delete('/api/sessions/:id', (req, res) => {
  res.json({ ok: tgLogin.revokeSession(req.params.id) });
});

dashboardApp.delete('/api/sessions', (req, res) => {
  // "Log out everywhere" keeps the caller's own session unless ?all=1
  tgLogin.revokeAll(req.query.all === '1' ? {} : { exceptSid: getSidFromCookies(req.headers.cookie) });
  res.json({ ok: true });
});

dashboardApp.post('/api/logout', (req, res) => {
  const sid = getSidFromCookies(req.headers.cookie);
  const s = sid && tgLogin.getSession(sid);
  if (s) tgLogin.revokeSession(s.id);
  res.setHeader('Set-Cookie', [
    authCookie('sid', '', '; Max-Age=0'),
    authCookie('token', '', '; Max-Age=0'),
  ]);
  res.json({ ok: true });
});

// Break-glass: mint a one-time login URL. Loopback+internal-header only, so it
// is reachable exclusively from the host itself (`vistaclair login-link`).
dashboardApp.post('/api/tg-login/login-link', (req, res) => {
  if (!isInternal(req)) {
    return res.status(403).json({ error: 'Host-local only' });
  }
  const key = tgLogin.createOneTimeLink();
  res.json({ path: `/login/once?k=${key}`, expiresInMs: 5 * 60 * 1000 });
});

// Restart endpoint (auth handled by middleware)
dashboardApp.post('/api/restart', (req, res) => {
  res.json({ ok: true, message: 'Server restarting...' });
  scheduleRestart();
});

// Kill stale processes on our ports before binding (handles unclean restarts)
function killStalePortProcesses() {
  try {
    const { execSync } = require('child_process');
    const myPid = process.pid;
    for (const port of [PROXY_PORT, DASHBOARD_PORT]) {
      try {
        const out = execSync(`lsof -ti :${port} 2>/dev/null`, { encoding: 'utf-8' }).trim();
        for (const pidStr of out.split('\n').filter(Boolean)) {
          const pid = parseInt(pidStr);
          if (pid && pid !== myPid) {
            try { process.kill(pid, 'SIGKILL'); } catch {}
          }
        }
      } catch {}
    }
  } catch {}
}
// Server mode: pm2 owns process lifecycle — never kill by port; fail fast instead.
if (!SERVER_MODE) killStalePortProcesses();

for (const srv of [proxyServer, dashboardServer]) {
  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Error: port ${err.port} is already in use.${SERVER_MODE ? ' Another instance running? Check pm2.' : ''}`);
      process.exit(1);
    }
    throw err;
  });
}

// Start both servers (proxy on localhost only)
proxyServer.listen(PROXY_PORT, '127.0.0.1', () => {
  dashboardServer.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
    mcp.autoStart();

    // Hook reporters live once at user scope (~/.claude/settings.json), which
    // every `claude` spawn on this box reads — interactive tab or headless, any
    // cwd. Installed at boot so a slave install (same server) gets them too.
    // Reporters used to be written per project dir before each tab spawn; sweep
    // those copies out so the Hooks page and the project dirs stay clean.
    caps.ensureHookReporters(path.join(os.homedir(), '.claude', 'settings.json'), path.join(PACKAGE_ROOT, 'lib', 'hook-reporter.js'));
    const swept = caps.pruneProjectHookReporters();
    if (swept.removed) {
      console.log(`  Hooks: removed project-scope reporter copies from ${swept.removed} dir(s) (reporters now live in ~/.claude/settings.json)`);
    }

    // Bring back the CLI tabs that were open when the previous process stopped.
    // Server-owned, so it happens whether or not a dashboard is connected.
    const restore = cliSessionManager.restoreOpenTabs();
    if (restore.restored || restore.dropped) {
      console.log(`  CLI tabs: restoring ${restore.restored}${restore.dropped ? `, dropped ${restore.dropped}` : ''}`);
    }

    // Reclaim idle headless (`claude -p`) interaction dirs. Runs after the tab
    // restore so those sessions are already registered, and on a timer well
    // under the TTL so a dir is never much more than an hour past its last use.
    sweepInteractions();
    setInterval(sweepInteractions, INTERACTIONS_SWEEP_MS);

    console.log('');
    console.log('  Claude Code API Proxy running.');
    console.log('');
    console.log(`  Proxy:     http://127.0.0.1:${PROXY_PORT} (localhost only)`);
    console.log(`  Dashboard: http://localhost:${DASHBOARD_PORT}`);
    console.log(`  Upstream:  ${TARGET_URL}`);
    console.log('');
    if (AUTH_TOKEN_SOURCE === 'generated') {
      console.log(`  Auth token (auto-generated):`);
    } else {
      console.log(`  Auth token (from AUTH_TOKEN env):`);
    }
    console.log(`  ${AUTH_TOKEN}`);
    console.log('');
    console.log('  Usage:');
    console.log(`    ANTHROPIC_BASE_URL=http://localhost:${PROXY_PORT} claude -p "your prompt"`);
    console.log('');

    // Auto-open dashboard in the default browser (skip with NO_OPEN=1 or server mode)
    if (!process.env.NO_OPEN && !SERVER_MODE) {
      const url = `http://localhost:${DASHBOARD_PORT}/login/auto?token=${AUTH_TOKEN}`;
      const { execFile } = require('child_process');
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      execFile(cmd, [url]);
    }

    // Re-validate license every 4 hours
    setInterval(async () => {
      if (!proAddon) return;
      const result = await validateLicense();
      if (!result.valid && result.reason !== 'offline-grace') {
        console.log(`  Pro: license no longer valid (${result.reason}) — disabling`);
        try { proAddon.shutdown?.(); } catch {}
        addons.removeAddon(proAddon.id);
        proAddon = null;
        proModule = null;
        proLicenseValid = false;
        broadcaster.broadcast({ type: 'pro:disabled', reason: result.reason });
      }
    }, 4 * 60 * 60 * 1000);
  });
});

// Clean shutdown: unregister MCP servers and stop running apps
function gracefulShutdown() {
  tgLogin.stop();
  cliSessionManager.saveAllToHistory();
  cliSessionManager.killAll();
  addons.shutdownAll();
  mcp.shutdown();
  process.exit(0);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('SIGHUP', gracefulShutdown);

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

})();
