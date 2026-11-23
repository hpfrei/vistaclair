// AgySession: a session run by Google's Antigravity CLI (`agy`) instead of
// Claude Code (docs/agy-workers.md). Same surface as SdkSession (kind 'sdk',
// SDK-shaped transcript.jsonl), so the panel, the run board, totals and
// history need nothing new; `engine` is 'agy'.
//
// One `agy -p … --output-format stream-json [--conversation <id>]` process per
// turn, in the session's worktree, in its own process group. agy runs exactly
// as a normal agy does: documented flags, the per-workspace `.agents/` config
// and `--settings` (src/agy-worker-config.js). Nothing here alters agy's
// requests; its HTTPS goes through the agy MITM proxy (src/agy-mitm.js) only
// while interception is on, and directly otherwise.
//
// The session knows no orchestration. Its owner (the manager, for an
// orchestration run src/orchestration.js handleHook) answers Claude-shaped hook
// events it synthesises at the turn boundaries:
//   SessionStart       at spawn ({ source: 'startup' | 'resume' })
//   UserPromptSubmit   before a fresh turn (not before a continuation)
//   Stop               after a turn ({ stop_hook_active } on a continuation)
//   AgyBlocked         a turn that cannot go on ({ kind, reason })
// An additionalContext answer is added to the turn's prompt; a Stop answer
// { decision: 'block', reason } runs one more turn with that reason (at most
// MAX_CHAIN in a row). The role text (settings.appendSystemPrompt) and the
// tool policy are parameters: nothing assumes a worker.
//
// Billing: agy runs only on the owner's Google AI subscription login.
// agyEnv() strips every API-key / ADC variable.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn: spawnChild } = require('child_process');
const agyAuth = require('./agy-auth');
const config = require('./agy-worker-config');
const { shared: sessionTokens, scopesFor } = require('./session-tokens');
const { buildClaudeEnv, trackInstance, DATA_HOME } = require('./utils');
const { buildMcpServers, writeInternalJson, DEFAULT_SETTINGS } = require('./cli-session');
const { toolPackContributions, releaseToolPacks } = require('./tool-packs');

const NEON_MODEL = 'gemini-4-neon-medium';
const AGY_MODEL_RE = /^gemini-[a-z0-9][a-z0-9.-]*$/i;
const REFUSED_MODEL_RE = /^(claude|gpt)-/i;
const MAX_CHAIN = 8;                 // continuation turns after one fresh turn, at most
const KILL_GRACE_MS = 5000;
const MAX_ARG_PROMPT = 100 * 1024;   // a longer prompt goes through a file
const STDERR_TAIL = 8000;
const QUOTA_RE = /RESOURCE[_ ]?EXHAUSTED|\b429\b|quota (?:exceeded|exhausted)|rate limit exceeded|exhausted your capacity/i;
const UNKNOWN_CONV_RE = /conversation[^\n]{0,60}(?:not found|unknown|does not exist|no such)/i;

// The agy short names (docs/agy-workers.md "Launch"). A tier alone runs at
// medium effort; `<tier>-<effort>` and `flash[-<effort>]` pick the effort.
const AGY_TIERS = { neon: ['low', 'medium', 'high', 'xhigh'], argon: ['low', 'medium', 'high'], hydrogen: ['low', 'medium', 'high', 'xhigh'] };
const AGY_FLASH_EFFORTS = ['low', 'medium', 'high'];
const AGY_ALIAS_RE = /^(neon|argon|hydrogen|flash)(?:-([a-z]+))?$/;

// The one line that names every agy choice (errors, cards, the launch schema).
function agyNamesText() {
  return 'neon | argon | hydrogen (medium effort; suffix -low | -medium | -high | -xhigh, e.g. hydrogen-high; argon has no xhigh), flash[-low | -medium | -high], or a full gemini-… id (gemini-4-<tier>-<effort>, gemini-3.8-flash-<effort>, gemini-pro-orchestrator-<neon|g1-pro>)';
}

// True when the name is one agy runs: a short name or a gemini-… id.
function isAgyModelName(model) {
  const m = String(model || '').trim();
  return AGY_ALIAS_RE.test(m.toLowerCase()) || AGY_MODEL_RE.test(m);
}

// A short name → its agy id, null when it is not a short name; throws for a
// short name whose effort does not exist.
function agyAliasId(model) {
  const m = String(model || '').trim().toLowerCase();
  const hit = AGY_ALIAS_RE.exec(m);
  if (!hit) return null;
  const [, tier, effort] = hit;
  if (tier === 'flash') {
    if (effort && !AGY_FLASH_EFFORTS.includes(effort)) throw new Error(`agy model "${model}": flash has the efforts ${AGY_FLASH_EFFORTS.join(', ')}`);
    return `gemini-3.8-flash-${effort || 'medium'}`;
  }
  if (!effort) return tier === 'neon' ? NEON_MODEL : `gemini-4-${tier}-medium`;
  if (!AGY_TIERS[tier].includes(effort)) throw new Error(`agy model "${model}": ${tier} has the efforts ${AGY_TIERS[tier].join(', ')}`);
  return `gemini-4-${tier}-${effort}`;
}

// A short name or an agy Gemini id → the id; anything else throws, naming the
// valid choices. `liveIds`: the ids of the last `agy models` probe; when it has
// some, the id must be one of them.
function resolveAgyModel(model, { liveIds } = {}) {
  const m = String(model || '').trim();
  if (REFUSED_MODEL_RE.test(m)) throw new Error(`agy model ${m}: only Google (gemini-…) models run on agy; Claude models run as Claude workers`);
  const id = agyAliasId(m) || (AGY_MODEL_RE.test(m) ? m : null);
  if (!id) throw new Error(`agy model must be ${agyNamesText()}, not "${m}"`);
  if (Array.isArray(liveIds) && liveIds.length && !liveIds.includes(id)) {
    throw new Error(`agy model ${id} is not in agy's model list. Available: ${liveIds.filter(x => !REFUSED_MODEL_RE.test(x)).join(', ')}`);
  }
  return id;
}

// The role text speaks Claude's tool names; agy names MCP tools mcp_<server>_<tool>.
function agyToolNames(text) {
  return String(text || '').replace(/mcp__([A-Za-z0-9_-]+?)__([A-Za-z0-9_]+)/g, 'mcp_$1_$2');
}

// The pids under `root` (children first walked from /proc), for a kill that
// must also reach what agy's tools started (they can outlive agy).
function descendants(root) {
  const kids = new Map();
  let entries = [];
  try { entries = fs.readdirSync('/proc'); } catch { return []; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${e}/stat`, 'utf8');
      const ppid = parseInt(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1], 10);
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(parseInt(e, 10));
    } catch {}
  }
  const out = [];
  const todo = [root];
  while (todo.length) {
    const p = todo.pop();
    for (const c of kids.get(p) || []) { out.push(c); todo.push(c); }
  }
  return out;
}

function signal(pid, sig) { try { process.kill(pid, sig); return true; } catch { return false; } }

function hookText(answer) {
  try {
    const j = answer && answer.stdout ? JSON.parse(answer.stdout) : null;
    if (!j) return { context: null, block: null };
    if (j.decision === 'block' && j.reason) return { context: null, block: String(j.reason) };
    return { context: j.hookSpecificOutput?.additionalContext || null, block: null };
  } catch { return { context: null, block: null }; }
}

// When an empty quota will reset, if the error says (ISO time, or a retry delay).
function quotaReset(text) {
  const s = String(text || '');
  const iso = s.match(/"?reset(?:Time|_time|At)"?\s*[:=]\s*"?([0-9]{4}-[0-9]{2}-[0-9]{2}T[^"\s,}]+)/i);
  if (iso && !Number.isNaN(Date.parse(iso[1]))) return new Date(iso[1]).toISOString();
  const delay = s.match(/"?retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s/i) || s.match(/reset(?:s)? (?:after|in) (\d+(?:\.\d+)?)\s*s/i);
  if (delay) return new Date(Date.now() + parseFloat(delay[1]) * 1000).toISOString();
  return null;
}

class AgySession {
  // opts: dashboardPort; tests: agyBin, agyMitm, agyAuthStatus, reportAgyAuthFailure.
  constructor(proxyPort, broadcaster, store, opts = {}) {
    this.proxyPort = proxyPort;
    this.broadcaster = broadcaster;
    this.store = store;
    this.cwd = null;
    this.tabId = null;
    this.kind = 'sdk';
    this.engine = 'agy';
    this.sessId = null;
    this._instanceId = null;
    this.title = null;
    this.settings = { ...DEFAULT_SETTINGS };
    this.status = 'idle';
    this.hidden = false;
    this.owner = null;
    this.busy = false;
    this.busySince = null;
    this.state = 'idle';
    this.costUsd = 0;               // billed: always 0 (the Google AI subscription pays)
    this.apiUsd = 0;                // this session id's calls at Google's API list prices (seeded from its transcript on a resume)
    this.context = { tokens: null, window: null, compactAt: null, windowEstimated: false };
    this.autoMemory = false;
    this.actualModel = null;
    this.blocked = null;            // { kind: 'auth'|'quota'|'error'|'loop', reason, at }
    this.onStateChange = null;
    this.onSettingsChange = null;
    this.hookHandler = null;        // (instanceId, input) → hook answer; set by the manager
    this._opts = opts;
    this._dashboardPort = opts.dashboardPort || 3457;
    this._spawnGen = 0;
    this._proc = null;
    this._turn = null;              // the running turn
    this._queued = [];              // text submitted while busy: PreInvocation or the next turn
    this._startContext = null;      // SessionStart's context, for the first turn
    this._chain = 0;
    this._authWait = null;          // { text, continuation } waiting for a sign-in
    this._sessionToken = null;
    this._packs = null;
    this._files = null;
    this._unknownTools = new Set();
    this._onAuthChange = (status) => this._authChanged(status);
    this._onCloudCode = (ev) => this._cloudCode(ev);
  }

  get instanceId() { return this._instanceId; }
  get running() { return this.status === 'running'; }
  get runId() { return this.settings.orchestration?.runId || null; }
  get conversationId() { return this.settings.agy?.conversationId || null; }

  sessionDir() {
    return this.settings.sessionDir || (this.sessId ? path.join(DATA_HOME, 'interactions', this.sessId) : null);
  }

  uploadsDir() {
    const dir = this.sessionDir();
    return dir ? path.join(dir, 'uploads') : null;
  }

  _mitm() { return this._opts.agyMitm || require('./agy-mitm'); }
  _mitmEvents() { const m = this._mitm(); return typeof m.instance === 'function' ? m.instance() : m; }
  _auth() { return this._opts.agyAuthStatus || agyAuth.authStatus; }
  _reportAuth(info) {
    const fn = this._opts.reportAgyAuthFailure || require('./ws/agy-auth-handler').reportAgyAuthFailure;
    try { return fn(info); } catch (e) { console.error('[agy-session] reportAgyAuthFailure:', e.message); return null; }
  }
  _bin() {
    const b = this._opts.agyBin;
    return (typeof b === 'function' ? b() : b) || agyAuth.findAgyBin();
  }

  _hook(input) {
    if (typeof this.hookHandler !== 'function' || !this.instanceId) return {};
    try { return this.hookHandler(this.instanceId, input) || {}; } catch (e) { console.error('[agy-session] hook:', e.message); return {}; }
  }

  // --- spawn / kill ---

  spawn(cwd, cols, rows, { resumeSessionId, autoMemory } = {}) {
    const model = resolveAgyModel(this.settings.model);
    if (!this._bin()) throw new Error('agy (the Antigravity CLI) is not installed: see Models → Gemini → Antigravity');
    if (!cwd || !fs.existsSync(cwd)) throw new Error(`agy session: no directory ${cwd}`);
    const tracked = config.trackedAgentsFiles(cwd);
    if (tracked.length) throw new Error(`agy session: the repo tracks ${tracked.join(', ')}; merging a repo's own agy config is not supported`);
    if (this.running) this.kill('respawn');
    this._spawnGen++;
    this.cwd = cwd;
    this.autoMemory = autoMemory === true;
    this.sessId = resumeSessionId || crypto.randomUUID();
    this._instanceId = `cli-${this.sessId}`;
    // A fresh start is a new agy conversation; a resume continues its own.
    if (!resumeSessionId && this.settings.agy?.conversationId) this.settings = { ...this.settings, agy: { ...this.settings.agy, conversationId: null } };
    this.settings = { ...this.settings, model };
    this.status = 'running';
    this.blocked = null;
    this._queued = [];
    this._chain = 0;
    this._authWait = null;
    this._unknownTools.clear();
    this._sessionToken = sessionTokens.mint(this.instanceId, { scopes: scopesFor(this.settings) });
    this.store.registerSession(this.instanceId, this.sessId);
    this._instanceExit = trackInstance(this.instanceId, { kill: () => this.kill() }, { tabId: this.tabId }, cwd, this.autoMemory);
    try {
      this._writeConfig();
    } catch (e) {
      this._release('refused');
      this.status = 'idle';
      throw e;
    }
    this._auth().on?.('change', this._onAuthChange);
    this._mitmEvents().on?.('cloudcode-response', this._onCloudCode);
    this.costUsd = 0;
    // A resumed session (same id, same folder) goes on from what its transcript recorded.
    this.apiUsd = 0;
    try {
      const dir = this.sessionDir();
      if (dir) this.apiUsd = require('./sdk-session').transcriptTotals(dir).apiOwn(this.sessId) || 0;
    } catch {}
    // A context budget (settings.agyContextLimit, tokens) makes the context
    // ratio countable: an orchestrator's auto-refresh reads tokens / compactAt.
    const limit = Number(this.settings.agyContextLimit) || null;
    this.context = { ...this.context, compactAt: limit, window: this.context.window || limit };
    this._setState('idle', { force: true });
    this.broadcaster.broadcast({
      type: 'cli:spawned', tabId: this.tabId, instanceId: this.instanceId, cwd: this.cwd, title: this.title,
      settings: this.settings, autoMemory: this.autoMemory, hidden: this.hidden, kind: 'sdk', engine: 'agy',
    });
    try { writeInternalJson(this, { mode: 'agy', resumed: !!resumeSessionId, resumedFrom: resumeSessionId || null, model }); } catch {}
    // agy's SessionStart (the role card) fires only for a new conversation: with
    // settings.agyRoleOnResume, a resume re-sends the card at its first model
    // call (takeResumeRole, the PreInvocation injection).
    this._resumeRole = !!resumeSessionId && this.settings.agyRoleOnResume === true;
    const ss = hookText(this._hook({ hook_event_name: 'SessionStart', source: resumeSessionId ? 'resume' : 'startup', cwd }));
    this._startContext = ss.context;
  }

  spawnShell() { throw new Error('an agy session has no shell'); }

  // The policy the hook reads (lib/agy-hook.js).
  _policy() {
    const s = this.settings;
    const roots = [this.cwd, s.sessionDir].filter(Boolean);
    const role = s.appendSystemPrompt ? agyToolNames(s.appendSystemPrompt) : '';
    return {
      writeRoots: roots,
      mainConversation: this.conversationId,
      pausing: this.pausing === true,
      sessionStartText: role || null,
      ...(s.agyPolicy && typeof s.agyPolicy === 'object' ? s.agyPolicy : {}),
    };
  }

  _configDir() {
    const runDir = this.settings.orchestration?.runDir;
    return runDir ? path.join(runDir, 'sessions') : (this.sessionDir() || path.join(DATA_HOME, 'interactions', this.sessId));
  }

  _writeConfig() {
    const mcpOpts = { settings: this.settings, instanceId: this.instanceId, dashboardPort: this._dashboardPort, sessionToken: this._sessionToken, cwd: this.cwd, sessId: this.sessId };
    if (this._packs) releaseToolPacks(this._packs, 'respawn');
    this._packs = toolPackContributions(mcpOpts);
    const servers = buildMcpServers(mcpOpts, this._packs);
    if (servers.orchestrator?.env) servers.orchestrator.env.VISTACLAIR_ORCH_ENGINE = 'agy';
    this._files = config.writeAgyConfig({
      cwd: this.cwd, dir: this._configDir(), name: this.settings.name || this.sessId,
      servers, policy: this._policy(), eager: config.eagerFor(this.settings.orchestration?.role),
    });
    config.excludeAgents(this.cwd);
  }

  // Rewrite the policy when what it holds changed (the pause, the conversation).
  syncPolicy() {
    if (!this._files || !this.running) return;
    try { config.writePolicy(this._files.policyFile, this._policy()); } catch (e) { console.error('[agy-session] policy:', e.message); }
  }

  _release(reason) {
    sessionTokens.revoke(this._sessionToken);
    this._sessionToken = null;
    if (this._packs) { releaseToolPacks(this._packs, reason); this._packs = null; }
    try { this._mitm().revokeTag?.(this.instanceId); } catch {}
    this._auth().off?.('change', this._onAuthChange);
    this._mitmEvents().off?.('cloudcode-response', this._onCloudCode);
    if (this.cwd) config.removeAgyConfig({ cwd: this.cwd, dir: this._files ? path.dirname(this._files.policyFile) : null, name: this.settings.name || this.sessId });
    this._files = null;
  }

  // Ends the session: the turn's process group (and what its tools started)
  // gets SIGTERM, then SIGKILL; the token, the MITM tag and the `.agents`
  // files go. cli:exit follows once.
  kill(reason = 'kill') {
    if (this.status !== 'running') return;
    const gen = this._spawnGen;
    this.status = 'idle';
    this._authWait = null;
    this._queued = [];
    const done = this._turn?.exited || Promise.resolve();
    this._terminate('SIGTERM');
    this._release(reason);
    // A respawn's old turn ends quietly: the new spawn owns the tab.
    if (reason !== 'respawn') done.then(() => setImmediate(() => this._ended(gen, 0)));
  }

  close() { this.kill('close'); }

  _ended(gen, exitCode) {
    if (gen !== this._spawnGen || this._endedGen === gen) return;
    this._endedGen = gen;
    this.store.unregisterSession(this.instanceId);
    this._instanceExit?.();
    this.status = 'exited';
    this._setState('exited', { force: true });
    this.broadcaster.broadcast({ type: 'cli:exit', tabId: this.tabId, exitCode });
  }

  // Signal the running turn: agy first (SIGINT interrupts it cleanly), then,
  // after it exits, the group and the snapshot of its descendants.
  _terminate(sig) {
    const t = this._turn;
    if (!t || t.done) return;
    t.pids = [...new Set([...(t.pids || []), ...descendants(t.pid)])];
    if (sig === 'SIGINT') signal(t.pid, 'SIGINT');
    else { signal(-t.pid, sig); for (const p of t.pids) signal(p, sig); }
    clearTimeout(t.killTimer);
    t.killTimer = setTimeout(() => {
      signal(-t.pid, 'SIGKILL');
      for (const p of t.pids) signal(p, 'SIGKILL');
    }, KILL_GRACE_MS);
    t.killTimer.unref?.();
  }

  // --- input ---

  submit(text, { priority, images, from } = {}) {
    if (!this.running) throw new Error('this session is not running');
    const body = String(text ?? '');
    if (Array.isArray(images) && images.length) throw new Error('images are not supported in agy sessions');
    if (!body.trim()) throw new Error('nothing to send');
    const id = crypto.randomUUID();
    if (this._turn) {
      this._queued.push({ id, text: body, from });
      this.emitEvent({ user: { id, text: body, pending: true, ...(from ? { from } : {}) } });
      return { ok: true, id, images: [] };
    }
    this.blocked = null;
    this._authWait = null;
    this._chain = 0;
    this._startTurn(body, { id, from, fresh: true });
    return { ok: true, id, images: [] };
  }

  // The role card once after a resume (settings.agyRoleOnResume), else null.
  takeResumeRole() {
    if (!this._resumeRole) return null;
    this._resumeRole = false;
    const role = this.settings.appendSystemPrompt ? agyToolNames(this.settings.appendSystemPrompt) : '';
    return role ? `[vistaclair] Your role card, again after a resume (it stays in force):\n\n${role}` : null;
  }

  // What the PreInvocation hook injects: the text submitted during the turn.
  takeQueued() {
    const q = this._queued.splice(0);
    for (const u of q) this.emitEvent({ user: { id: u.id, text: u.text, ...(u.from ? { from: u.from } : {}) } });
    return q.map(u => u.text);
  }

  async interrupt() {
    const t = this._turn;
    if (!t) return;
    t.interrupted = true;
    this._terminate('SIGINT');
    await t.exited;
  }

  write() {}
  writeWhenReady(data) { if (data && String(data).trim()) try { this.submit(String(data)); } catch {} }
  resize() {}
  resizeFrom() {}
  claim() {}
  getScrollback() { return ''; }
  setAwaiting() {}
  unsentInputs() { return []; }
  seedCost() {}
  // A finished call of this session (cli-sessions noteInteraction): its API-equivalent
  // price (agy-pricing.js) adds to apiUsd. costUsd, the billed amount, stays 0.
  addRequestCost(usage, pricing) {
    if (!usage || !pricing?.apiEquivalent) return;
    const per = (tok, rate) => (tok || 0) * (rate || 0) / 1e6;
    const usd = per(usage.input_tokens, pricing.inputCostPerMTok) + per(usage.output_tokens, pricing.outputCostPerMTok)
      + per(usage.cache_read_input_tokens, pricing.cacheReadCostPerMTok || pricing.inputCostPerMTok)
      + per(usage.cache_creation_input_tokens, pricing.cacheCreateCostPerMTok || pricing.inputCostPerMTok);
    if (!(usd > 0)) return;
    this.apiUsd += usd;
    this._emitStatus();
  }
  setAuth() { return { ok: false, error: 'an agy session runs on the Google AI subscription only' }; }

  setModel(model) {
    let id;
    try { id = resolveAgyModel(model); } catch (e) { return { ok: false, error: e.message }; }
    this.updateSettings({ model: id });
    this.onSettingsChange?.(this);
    this._emitStatus();
    return { ok: true, model: id };
  }

  // --- turns ---

  _startTurn(text, { id, from, fresh, continuation = false }) {
    let prompt = text;
    const extra = [];
    if (fresh) {
      if (this._startContext) { extra.push(this._startContext); this._startContext = null; }
      const ups = hookText(this._hook({ hook_event_name: 'UserPromptSubmit', prompt: text, cwd: this.cwd }));
      if (ups.context) extra.push(ups.context);
      this.emitEvent({ user: { id: id || crypto.randomUUID(), text, ...(from ? { from } : {}) } });
    } else {
      this.emitEvent({ user: { text, from: 'vistaclair' } });
    }
    if (extra.length) prompt = `${text}\n\n${extra.join('\n\n')}`;
    this._run(prompt, { text, continuation, from });
  }

  _argsFor(prompt) {
    let p = prompt;
    if (Buffer.byteLength(p) > MAX_ARG_PROMPT) {
      const dir = this.sessionDir() || this.cwd;
      const file = path.join(dir, `agy-prompt-${Date.now()}.md`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, p);
      p = `Your message is long, so it is in the file ${file}. Read that whole file first: it is your message.`;
    }
    const args = ['-p', p, '--model', this.settings.model, '--output-format', 'stream-json'];
    if (this.conversationId) args.push('--conversation', this.conversationId);
    if (this._files?.settingsFile) args.push('--settings', this._files.settingsFile);
    return args;
  }

  async _env() {
    const base = buildClaudeEnv({
      proxyPort: null, dashboardPort: this._dashboardPort, sessionToken: this._sessionToken, instanceId: this.instanceId,
      extraEnv: { GIT_CEILING_DIRECTORIES: this.cwd }, autoMemory: true,
    });
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_BASE_URL', ...config.PROXY_ENV]) delete base[k];
    const env = agyAuth.agyEnv({ env: base });
    env.VISTACLAIR_ORCH_ROLE = this.settings.orchestration?.role || '';
    env.VISTACLAIR_ORCH_ENGINE = 'agy';
    if (this._files?.policyFile) env.VISTACLAIR_AGY_POLICY = this._files.policyFile;
    env.NO_PROXY = env.no_proxy = 'localhost,127.0.0.1,::1';
    // Through the MITM only while interception is on (B1's kill switch).
    const mitm = this._mitm();
    let tagged = false;
    try {
      if (mitm.interceptionEnabled()) {
        await mitm.ensureStarted();
        const { proxyUrl } = mitm.registerTag(this.instanceId);
        env.HTTPS_PROXY = proxyUrl;
        env.SSL_CERT_FILE = mitm.bundlePath();
        tagged = true;
      } else {
        mitm.revokeTag?.(this.instanceId);
      }
    } catch (e) {
      console.error(`[agy-session] MITM unavailable, running agy direct: ${e.message}`);
      delete env.HTTPS_PROXY;
      delete env.SSL_CERT_FILE;
    }
    return { env, tagged };
  }

  _run(prompt, { text, continuation, from, freshRetry = false }) {
    const gen = this._spawnGen;
    let resolveExit;
    const turn = {
      prompt, text, continuation, from, freshRetry, pid: null, pids: [], done: false, interrupted: false,
      stdout: '', stderr: '', result: null, lastText: '', quota: null, steps: new Map(), tagged: false,
      exited: new Promise(r => { resolveExit = r; }),
    };
    this._turn = turn;
    this._setState('busy');
    this.syncPolicy();
    const finish = (code, sig, err) => {
      if (turn.done) return;
      turn.done = true;
      clearTimeout(turn.killTimer);
      // What its tools started and left behind goes with it.
      const left = [...new Set([...turn.pids, ...(turn.pid ? descendants(turn.pid) : [])])];
      if (turn.pid) signal(-turn.pid, 'SIGTERM');
      for (const p of left) signal(p, 'SIGTERM');
      if (left.length || turn.pid) setTimeout(() => { if (turn.pid) signal(-turn.pid, 'SIGKILL'); for (const p of left) signal(p, 'SIGKILL'); }, KILL_GRACE_MS).unref?.();
      if (this._turn === turn) this._turn = null;
      resolveExit();
      if (gen !== this._spawnGen || !this.running) return;
      try { this._turnEnded(turn, code, sig, err); } catch (e) { console.error('[agy-session] turn end:', e); this._setState('idle'); }
    };
    this._env().then(({ env, tagged }) => {
      if (gen !== this._spawnGen || !this.running) { finish(null, null, new Error('ended')); return; }
      turn.tagged = tagged;
      turn.env = { HTTPS_PROXY: env.HTTPS_PROXY || null, SSL_CERT_FILE: env.SSL_CERT_FILE || null };
      let child;
      try {
        child = spawnChild(this._bin(), this._argsFor(prompt), { cwd: this.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) { finish(null, null, e); return; }
      this._proc = child;
      turn.pid = child.pid;
      let buf = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        turn.stdout = (turn.stdout + d).slice(-STDERR_TAIL);
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) this._onLine(turn, line);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => { turn.stderr = (turn.stderr + d).slice(-STDERR_TAIL); });
      child.on('error', (e) => finish(null, null, e));
      child.on('close', (code, sig) => {
        if (buf.trim()) this._onLine(turn, buf.trim());
        this._proc = null;
        finish(code, sig, null);
      });
    }, (e) => finish(null, null, e));
  }

  _onLine(turn, line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const ev = msg && msg.event;
    if (ev === 'init') {
      const conv = msg.conversation_id;
      if (conv && conv !== this.conversationId) {
        this.updateSettings({ agy: { ...(this.settings.agy || {}), conversationId: conv } });
        this.onSettingsChange?.(this);
        this.syncPolicy();
        try { this._mitm().setMainConversation?.(this.instanceId, conv); } catch {}
      }
      this.emitEvent({ sdk: { type: 'system', subtype: 'init', session_id: this.sessId, model: msg.init?.model || this.settings.model, cwd: msg.init?.cwd || this.cwd, tools: msg.init?.tools || [], engine: 'agy', conversation_id: conv } });
      return;
    }
    if (ev === 'step_update') {
      const s = msg.step_update || {};
      if (s.conversation_id && this.conversationId && s.conversation_id !== this.conversationId) return;   // a subagent's
      const idx = s.step_index;
      const model = this.settings.model;
      if (s.step_type === 'agent_response' && s.state === 'DONE') {
        if (s.usage) this._noteUsage(s.usage);
        // A blank step text (measured: a final DONE step of "\n") shows
        // nothing; the turn's result text stands in for it (_turnEnded).
        if (s.text_delta && String(s.text_delta).trim()) {
          turn.lastText = s.text_delta;
          turn.shown = `${turn.shown || ''}\n${s.text_delta}`;
          this.emitEvent({ sdk: { type: 'assistant', session_id: this.sessId, parent_tool_use_id: null, message: { id: `agy-${idx}`, role: 'assistant', model, content: [{ type: 'text', text: s.text_delta }], usage: this._usage(s.usage) } } });
        }
        return;
      }
      if (s.step_type === 'tool' || s.step_type === 'subagent') {
        const id = `agy-${idx}`;
        const info = s.tool_info || {};
        if (s.state === 'ACTIVE' && !turn.steps.has(idx)) {
          turn.steps.set(idx, true);
          this.emitEvent({ sdk: { type: 'assistant', session_id: this.sessId, parent_tool_use_id: null, message: { id: `${id}-use`, role: 'assistant', model, content: [{ type: 'tool_use', id, name: s.tool_name || info.name || 'tool', input: info.parameters || {} }] } } });
        } else if (s.state === 'DONE' || s.state === 'ERROR') {
          if (!turn.steps.has(idx)) {
            turn.steps.set(idx, true);
            this.emitEvent({ sdk: { type: 'assistant', session_id: this.sessId, parent_tool_use_id: null, message: { id: `${id}-use`, role: 'assistant', model, content: [{ type: 'tool_use', id, name: s.tool_name || info.name || 'tool', input: info.parameters || {} }] } } });
          }
          const err = s.state === 'ERROR';
          const content = err ? String(info.error?.message || 'error') : String(info.output ?? '');
          this.emitEvent({ sdk: { type: 'user', session_id: this.sessId, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: err }] } } });
        }
      }
      return;
    }
    if (ev === 'result') {
      turn.result = msg.result || {};
    }
  }

  _usage(u) {
    if (!u) return undefined;
    return { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cache_read_input_tokens: u.cache_read_tokens || 0, cache_creation_input_tokens: 0 };
  }

  _noteUsage(u) {
    const tokens = (u.input_tokens || 0) + (u.cache_read_tokens || 0);
    if (tokens) this.context = { ...this.context, tokens };
  }

  _cloudCode(ev) {
    if (!ev || ev.instanceId !== this.instanceId || !this._turn) return;
    const status = Number(ev.status) || 0;
    const body = (() => { try { return JSON.stringify(ev.json); } catch { return ''; } })();
    if (status === 429 || /RESOURCE_EXHAUSTED/.test(body)) this._turn.quota = { resetsAt: quotaReset(body) };
  }

  _turnEnded(turn, code, sig, err) {
    const r = turn.result;
    const status = String(r?.status || '').toUpperCase();
    const errText = r?.error ? (typeof r.error === 'string' ? r.error : String(r.error.message || JSON.stringify(r.error))) : '';
    const ok = !err && code === 0 && status !== 'ERROR';
    const interrupted = turn.interrupted || r?.finished_reason === 'interrupted';
    // The answer the steps did not show (agy's result text), as the turn's last reply.
    const answer = String(r?.response || '').trim();
    if (ok && answer && !String(turn.shown || '').includes(answer)) {
      turn.lastText = answer;
      this.emitEvent({ sdk: { type: 'assistant', session_id: this.sessId, parent_tool_use_id: null, message: { id: `agy-result-${Date.now()}`, role: 'assistant', model: this.settings.model, content: [{ type: 'text', text: answer }] } } });
    }
    this.emitEvent({ sdk: {
      type: 'result', subtype: ok ? 'success' : 'error_during_execution', is_error: !ok, session_id: this.sessId,
      result: r?.response || turn.lastText || '', num_turns: r?.num_turns || 0,
      duration_ms: Math.round((r?.duration_seconds || 0) * 1000), total_cost_usd: 0,
      usage: this._usage(r?.usage) || this._usage({}), engine: 'agy', credential: 'agy-subscription',
    } });

    if (!ok && !interrupted) {
      const info = { exitCode: code, stdout: turn.stdout, stderr: turn.stderr, json: r || null };
      const authReason = agyAuth.agyAuthFailureReason(info);
      if (authReason) {
        this._reportAuth(info);
        this._authWait = { prompt: turn.prompt, text: turn.text, continuation: turn.continuation, from: turn.from };
        return this._block('auth', authReason === 'keyring-locked'
          ? 'agy sign-in needed: the keyring is locked (unlock it, then the turn re-runs by itself)'
          : 'agy sign-in needed (sign in to Antigravity in the dashboard; the turn re-runs by itself)');
      }
      const all = `${turn.stderr}\n${errText}`;
      if (turn.quota || QUOTA_RE.test(all)) {
        const at = turn.quota?.resetsAt || quotaReset(all);
        return this._block('quota', `agy quota exhausted (resets ${at || 'at a time agy did not say'})`);
      }
      if (UNKNOWN_CONV_RE.test(all) && this.conversationId && !turn.freshRetry) {
        // agy no longer knows the conversation: once, as a fresh one.
        this.updateSettings({ agy: { ...(this.settings.agy || {}), conversationId: null } });
        this.emitEvent({ platform: { kind: 'notice', level: 'warn', text: 'agy no longer knows this conversation: it starts a fresh one.' } });
        return this._run(turn.prompt, { text: turn.text, continuation: turn.continuation, from: turn.from, freshRetry: true });
      }
      const tail = (errText || turn.stderr || (err && err.message) || `exit ${code}${sig ? ` (${sig})` : ''}`).trim().split('\n').slice(-3).join(' ');
      return this._block('error', `agy run failed: ${tail.slice(0, 300)}`);
    }

    // Text sent while it ran comes next, as a turn of its own.
    if (this._queued.length) {
      const q = this._queued.splice(0);
      for (const u of q) this.emitEvent({ user: { id: u.id, text: u.text, ...(u.from ? { from: u.from } : {}) } });
      this._chain = 0;
      return this._startTurn(q.map(u => u.text).join('\n\n'), { fresh: true, from: q[0].from });
    }
    const stop = hookText(this._hook({ hook_event_name: 'Stop', stop_hook_active: turn.continuation, last_assistant_message: turn.lastText || r?.response || '', interrupted, cwd: this.cwd }));
    if (stop.block && !interrupted && this.running) {
      if (this._chain >= MAX_CHAIN) {
        return this._block('loop', `agy session stopped after ${MAX_CHAIN} automatic follow-up turns without ending its work`);
      }
      this._chain++;
      return this._startTurn(stop.block, { fresh: false, continuation: true });
    }
    this._setState('idle');
  }

  _block(kind, reason) {
    this.blocked = { kind, reason, at: new Date().toISOString() };
    this.emitEvent({ platform: { kind: 'notice', level: 'error', text: reason } });
    this._setState('idle');
    this._hook({ hook_event_name: 'AgyBlocked', kind, reason });
  }

  _authChanged(status) {
    if (!status?.signedIn || !this._authWait || !this.running || this._turn) return;
    const w = this._authWait;
    this._authWait = null;
    this.blocked = null;
    this.emitEvent({ platform: { kind: 'notice', text: 'agy is signed in again: the turn re-runs.' } });
    this._run(w.prompt, { text: w.text, continuation: w.continuation, from: w.from });
  }

  // --- transcript ---

  _setState(state, { force = false } = {}) {
    if (this.state === state && !force) return;
    this.state = state;
    const busy = state === 'busy';
    const changed = this.busy !== busy;
    this.busy = busy;
    if (changed && busy) this.busySince = Date.now();
    this._emitStatus();
    if (changed) this.onStateChange?.(this);
  }

  _emitStatus() {
    this.emitEvent({ platform: {
      kind: 'status', state: this.state, costUsd: 0, apiUsd: this.apiUsd, model: this.settings.model, actualModel: this.settings.model,
      mappedTo: null, credential: 'agy-subscription', engine: 'agy', context: this.context,
      ...(this.blocked ? { blocked: this.blocked } : {}),
    } });
  }

  emitEvent(ev) {
    if (!this.sessId) return;
    const env = { sessId: this.sessId, ...(this.runId ? { runId: this.runId } : {}), ts: Date.now(), ev };
    const dir = this.sessionDir();
    let off = null;
    if (dir) { try { off = fs.statSync(path.join(dir, 'transcript.jsonl')).size; } catch { off = 0; } }
    this.broadcaster.broadcast({ type: 'sdk:event', ...env, ...(off != null ? { off } : {}) });
    if (!dir) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'transcript.jsonl');
      const text = JSON.stringify(env) + '\n';
      fs.appendFileSync(file, text);
      const SdkSession = require('./sdk-session');
      const to = fs.statSync(file).size;
      SdkSession.totalsAppended?.(dir, [env], to - Buffer.byteLength(text), to);
    } catch (e) {
      console.error(`[agy-session] transcript ${dir}: ${e.message}`);
    }
  }

  historyPage({ limit, before } = {}) {
    const SdkSession = require('./sdk-session');
    const dir = this.sessionDir();
    if (!dir) return { events: [], hasMore: false, before: null, totals: { costUsd: 0, compactions: 0 } };
    return { ...SdkSession.readTranscriptPage(dir, { sessId: this.sessId, limit, before }), totals: SdkSession.historyTotals(dir, this) };
  }

  history(opts) { return this.historyPage(opts).events; }

  // The server-side unknown-tool log: once per name per spawn.
  noteUnknownTool(name) {
    const n = String(name || '').slice(0, 80);
    if (!n || this._unknownTools.has(n)) return false;
    this._unknownTools.add(n);
    console.log(`[agy-session] ${this.instanceId}: agy tool "${n}" is not in the policy table (allowed)`);
    return true;
  }

  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
  }

  getSettings() {
    return { ...this.settings };
  }
}

module.exports = AgySession;
module.exports.AgySession = AgySession;
module.exports.resolveAgyModel = resolveAgyModel;
module.exports.isAgyModelName = isAgyModelName;
module.exports.agyNamesText = agyNamesText;
module.exports.parseAgyModelList = agyAuth.parseAgyModelList;
module.exports.agyToolNames = agyToolNames;
module.exports.quotaReset = quotaReset;
module.exports.descendants = descendants;
module.exports.NEON_MODEL = NEON_MODEL;
module.exports.MAX_CHAIN = MAX_CHAIN;
