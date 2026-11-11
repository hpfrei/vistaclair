// The permanent owner token must not leak to a command line, a log or a
// session's environment:
//   A. the boot auto-open uses a single-use login code, never the token
//   B. no start-up output (any start mode) contains the token
//   C. an add-on mints a single-use login code through ctx.login
//   D. sessions get a per-session token, accepted only on their endpoints
//   E. the add-on services object carries the proxy secret + its header name
// Temp dirs, ephemeral ports, fake sessions; never a live server. Token values
// are never printed: assertions report lengths and presence only.
//
//   node --test test/security-token.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-sectoken-')));
process.env.VISTACLAIR_HOME = HOME;

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createLogin } = require('../src/login');
const { waitFor } = require('./wait-for');

const ROOT = path.join(__dirname, '..');
const quiet = { error() {}, log() {} };
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, setCookie: res.headers['set-cookie'] || [] }));
    });
    req.on('error', reject);
    req.end();
  });
}

// --- A + B: boot server.js in a scratch home -----------------------------
// A fake `xdg-open` on PATH records its argv (the command line any local user
// could read). HOME and VISTACLAIR_HOME are scratch, so nothing real is touched.
async function boot(t, { token, serverMode = false, noOpen = false }) {
  const home = fs.mkdtempSync(path.join(HOME, 'boot-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const opened = path.join(home, 'opened');
  fs.writeFileSync(path.join(bin, 'xdg-open'), `#!/bin/sh\necho "$@" >> '${opened}'\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(home, 'h'));
  fs.mkdirSync(path.join(home, 'vc'));
  const dash = await freePort();
  const proxy = await freePort();
  const env = {
    PATH: `${bin}:${process.env.PATH}`, HOME: path.join(home, 'h'), VISTACLAIR_HOME: path.join(home, 'vc'),
    DASHBOARD_PORT: String(dash), PROXY_PORT: String(proxy), DASHBOARD_HOST: '127.0.0.1',
  };
  if (token) env.AUTH_TOKEN = token;
  if (serverMode) env.VISTACLAIR_SERVER = '1';
  if (noOpen) env.NO_OPEN = '1';
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: path.join(home, 'vc'), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  await waitFor(() => /Usage:/.test(out), { timeoutMs: 30000, what: 'start-up banner' });
  // The banner is printed just before the browser would be opened.
  await new Promise(r => setTimeout(r, 500));
  return { out: () => out, dash, opened, home };
}

test('A: boot auto-open command line carries no permanent token; its code logs in once', async (t) => {
  const token = 'tok-' + crypto.randomBytes(16).toString('hex');
  const b = await boot(t, { token });
  await waitFor(() => fs.existsSync(b.opened), { what: 'xdg-open called' });
  const argv = fs.readFileSync(b.opened, 'utf8').trim();
  assert.ok(argv.startsWith(`http://localhost:${b.dash}/`), 'opens the dashboard');
  assert.strictEqual(argv.includes(token), false, 'the opened URL carries the permanent token');
  assert.strictEqual(UUID_RE.test(argv), false);
  assert.strictEqual(/[?&]token=/.test(argv), false, 'no token= parameter');
  const u = new URL(argv);
  assert.strictEqual(u.pathname, '/login/once');
  assert.ok((u.searchParams.get('k') || '').length >= 64, '256-bit code');
  const first = await get(b.dash, u.pathname + u.search);
  assert.strictEqual(first.status, 302);
  assert.strictEqual(first.location, '/');
  assert.ok(first.setCookie.some(c => c.startsWith('sid=')), 'a dashboard session starts');
  assert.strictEqual(first.setCookie.some(c => c.startsWith('token=')), false, 'the token is not handed out as a cookie');
  const second = await get(b.dash, u.pathname + u.search);
  assert.strictEqual(second.location, '/login', 'second use refused');
  assert.strictEqual(second.setCookie.length, 0);
});

test('B: no start-up output holds the token (env token, generated token, server mode)', async (t) => {
  const token = 'tok-' + crypto.randomBytes(16).toString('hex');
  for (const opts of [{ token }, { token, noOpen: true }, { token, serverMode: true }, { noOpen: true }]) {
    const label = JSON.stringify({ ...opts, token: opts.token ? 'set' : 'generated' });
    const b = await boot(t, opts);
    const out = b.out();
    assert.ok(out.length > 100, `${label}: captured start-up output`);
    if (opts.token) assert.strictEqual(out.includes(token), false, `${label}: the token is in the output`);
    else assert.strictEqual(UUID_RE.test(out), false, `${label}: a generated token (UUID) is in the output`);
    assert.strictEqual(/[?&]token=/.test(out), false, `${label}: a token= URL is printed`);
  }
});

// --- C: the add-on ctx mints a single-use code ----------------------------
test('C: ctx.login.createOneTimeLink mints a single-use code with a bounded lifetime', () => {
  const { createAddonCtx } = require('../src/addon-host');
  const dataHome = fs.mkdtempSync(path.join(HOME, 'c-'));
  let clock = 1_000_000;
  const login = createLogin({ dataHome, log: quiet, now: () => clock });
  const ctx = createAddonCtx({ dataHome, dashboard: { broadcaster: { broadcast() {} }, store: {}, cliSessionManager: {}, login: login.api } });
  assert.strictEqual(typeof ctx.login.createOneTimeLink, 'function');
  const a = ctx.login.createOneTimeLink();
  assert.ok(/^\/login\/once\?k=[0-9a-f]{64}$/.test(a.path), 'a /login/once path with a 256-bit key');
  assert.strictEqual(a.expiresInMs, login.LINK_TTL_MS);
  assert.ok(login.redeemOneTimeLink(a.key), 'first redeem logs in');
  assert.strictEqual(login.redeemOneTimeLink(a.key), null, 'second redeem refused');
  // A short lifetime is honoured, a longer one than the cap is capped.
  const short = ctx.login.createOneTimeLink({ ttlMs: 10_000 });
  assert.strictEqual(short.expiresInMs, 10_000);
  clock += 10_001;
  assert.strictEqual(login.redeemOneTimeLink(short.key), null, 'expired');
  const long = ctx.login.createOneTimeLink({ ttlMs: 24 * 3600 * 1000 });
  assert.strictEqual(long.expiresInMs, login.LINK_TTL_MS, 'capped at the link lifetime');
  assert.notStrictEqual(ctx.login.createOneTimeLink().key, ctx.login.createOneTimeLink().key);
  assert.strictEqual('login' in createAddonCtx({ dataHome }), false, 'absent headless');
});

// --- E: the proxy secret on the add-on services object ---------------------
test('E: the add-on ctx carries getProxySecret and proxySecretHeader', () => {
  const { createAddonCtx } = require('../src/addon-host');
  const utils = require('../src/utils');
  const dataHome = fs.mkdtempSync(path.join(HOME, 'e-'));
  const ctxs = [
    createAddonCtx({ dataHome, dashboard: { broadcaster: { broadcast() {} }, store: {}, cliSessionManager: {} } }),
    createAddonCtx({ dataHome }),
  ];
  for (const ctx of ctxs) {
    assert.strictEqual(ctx.getProxySecret, utils.getProxySecret);
    assert.strictEqual(ctx.proxySecretHeader, 'x-vistaclair-proxy-secret');
    assert.strictEqual(ctx.proxySecretHeader, utils.PROXY_SECRET_HEADER);
    assert.strictEqual(typeof ctx.getProxySecret(), 'string');
  }
});

// --- The files that hold the token are owner-only --------------------------
test('tightenSecretFiles: .env with AUTH_TOKEN and the server logs become 0600; an unrelated .env is left', () => {
  const { tightenSecretFiles } = require('../src/boot');
  const d = fs.mkdtempSync(path.join(HOME, 'm-'));
  const envFile = path.join(d, '.env');
  const logDir = path.join(d, 'logs');
  fs.mkdirSync(logDir);
  fs.writeFileSync(envFile, 'AUTH_TOKEN=x\n', { mode: 0o664 });
  fs.writeFileSync(path.join(logDir, 'server.log'), 'a', { mode: 0o664 });
  fs.writeFileSync(path.join(logDir, 'server.log.1'), 'a', { mode: 0o664 });
  fs.writeFileSync(path.join(logDir, 'other.log'), 'a', { mode: 0o664 });
  for (const f of [envFile, path.join(logDir, 'server.log'), path.join(logDir, 'server.log.1'), path.join(logDir, 'other.log')]) fs.chmodSync(f, 0o664);
  assert.strictEqual(tightenSecretFiles({ envFile, logDir }).length, 3);
  const mode = (f) => fs.statSync(f).mode & 0o777;
  assert.strictEqual(mode(envFile), 0o600);
  assert.strictEqual(mode(path.join(logDir, 'server.log')), 0o600);
  assert.strictEqual(mode(path.join(logDir, 'server.log.1')), 0o600);
  assert.strictEqual(mode(path.join(logDir, 'other.log')), 0o664);
  fs.writeFileSync(envFile, 'PORT=1\n'); fs.chmodSync(envFile, 0o664);
  assert.deepStrictEqual(tightenSecretFiles({ envFile, logDir }), []);
  assert.strictEqual(mode(envFile), 0o664);
});

// ════════════════════════════════════════════════════════════════════════════
// D. Per-session tokens (src/session-tokens.js)
// ════════════════════════════════════════════════════════════════════════════
// The server.js wiring in miniature: the two session-facing routes that sit
// before the owner gate, the gate, then a catch-all that records what reached
// it. Real consumers (lib/*.js, the ask tool) are pointed at it.
const express = require('express');
const { WebSocketServer } = require('ws');
const { createAuth } = require('../src/auth');
const { mountLoginRoutes, mountLoginApi } = require('../src/login-routes');
const { createSessionTokens, scopesFor } = require('../src/session-tokens');

const OWNER = 'owner-' + crypto.randomBytes(16).toString('hex');

async function startGate(t) {
  const dataHome = fs.mkdtempSync(path.join(HOME, 'gate-'));
  const tokens = createSessionTokens();
  const login = createLogin({ dataHome, log: quiet });
  const auth = createAuth({ authToken: OWNER, login, sessionTokens: tokens });
  const reached = [];
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  const loginDeps = {
    login, authToken: OWNER,
    authCookie: (name, value, extra = '') => `${name}=${value}; HttpOnly; SameSite=Lax; Path=/${extra}`,
    authLimiter: (req, res, next) => next(),
    isLoopback: auth.isLoopback, isInternal: auth.isInternal,
    getSidFromCookies: auth.getSidFromCookies, safeEqual: auth.safeEqual,
    publicDir: path.join(ROOT, 'public'),
  };
  mountLoginRoutes(app, loginDeps);
  const record = (req) => reached.push({ method: req.method, path: req.path, body: req.body, vc: req.vcSession || null });
  app.post('/api/hook-report', tokens.acceptOrOwner((req) => auth.decide(req)), (req, res) => { record(req); res.status(200).end(); });
  app.post('/api/ask', tokens.acceptOrOwner((req) => auth.decide(req)), (req, res) => { record(req); res.json({ ok: true, answer: ['yes'] }); });
  app.use(auth.gateMiddleware({ isAuthExempt: () => false, log() {} }));
  mountLoginApi(app, loginDeps); // the real /api/login/login-link, behind the gate as in server.js
  app.use((req, res) => { record(req); res.json({ reached: true }); });
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => ws.close());
  server.on('upgrade', (req, socket, head) => {
    if (!auth.isOwnerUpgrade(req, socket)) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { wss.close(); server.closeAllConnections?.(); server.close(() => r()); }));
  return { port: server.address().port, tokens, reached, login };
}

function call(port, { method = 'POST', path: p, headers = {}, body } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: p, method, agent: false,
      headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers },
    }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
function upgradeStatus(port, headers) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', agent: false, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
    const done = (status, socket) => { socket.on('error', () => {}); socket.destroy(); resolve(status); };
    req.on('upgrade', (res, socket) => done(res.statusCode, socket));
    req.on('response', (res) => { res.resume(); done(res.statusCode, res.socket); });
    req.on('error', () => resolve(0));
    req.end();
  });
}
const S = (token) => ({ 'x-vistaclair-session': token });
const ORCH = (name) => `/api/orchestration/${name}`;
const WORKER_OK = ['report', 'send-message', 'list-agents'];
const ORCH_ONLY = ['launch', 'cancel-launch', 'workers', 'end', 'undo-landing', 'resume-worker', 'close-worker', 'stop-worker', 'owner-items', 'tool-params'];

test('D1: a session token is random, vcs_-prefixed, never the owner token, bound to one instance', () => {
  const tokens = createSessionTokens();
  const a = tokens.mint('cli-a');
  const b = tokens.mint('cli-b');
  assert.ok(a.startsWith('vcs_') && a.length >= 40, 'prefix and length');
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a, OWNER);
  tokens.mint('cli-a'); // a second spawn of the same session replaces the first
  const req = (token) => ({ headers: { 'x-vistaclair-session': token }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', path: '/api/hook-report', body: {}, query: {} });
  assert.strictEqual(tokens.check(req(a)), null, 'the replaced token is not a session token any more');
  assert.strictEqual(tokens.check(req(b)).instanceId, 'cli-b');
  assert.deepStrictEqual(scopesFor({}), ['session']);
  assert.deepStrictEqual(scopesFor({ orchestration: { role: 'worker' } }), ['session', 'run', 'worker']);
  assert.deepStrictEqual(scopesFor({ orchestration: { role: 'orchestrator' } }), ['session', 'run', 'orchestrator']);
  assert.throws(() => tokens.mint(''), /instanceId/);
});

test('D2 hook reporter: lib/hook-reporter.js reaches /api/hook-report with the session token only', async (t) => {
  const g = await startGate(t);
  const token = g.tokens.mint('cli-hook');
  const run = (env) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'lib', 'hook-reporter.js')], { env: { PATH: process.env.PATH, VISTACLAIR_DASHBOARD_PORT: String(g.port), ...env }, stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('exit', (code) => resolve(code));
    p.stdin.end(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'x' }));
  });
  assert.strictEqual(await run({ VISTACLAIR_SESSION_TOKEN: token, VISTACLAIR_INSTANCE_ID: 'cli-hook' }), 0);
  assert.strictEqual(g.reached.length, 1, 'the report arrived');
  assert.strictEqual(g.reached[0].vc.instanceId, 'cli-hook');
  assert.strictEqual(g.reached[0].body.instanceId, 'cli-hook');
  assert.strictEqual('token' in g.reached[0].body, false, 'no token in the body');
  // The owner token in the old place (the body) is no credential any more.
  const old = await call(g.port, { path: '/api/hook-report', body: { token: OWNER, hookData: '{}', instanceId: 'cli-hook' } });
  assert.strictEqual(old.status, 401);
  // No variable: fails open, sends nothing.
  assert.strictEqual(await run({ VISTACLAIR_INSTANCE_ID: 'cli-hook' }), 0);
  // The legacy variable alone (what an old session may still carry) is not read.
  assert.strictEqual(await run({ VISTACLAIR_AUTH_TOKEN: token, VISTACLAIR_INSTANCE_ID: 'cli-hook' }), 0);
  assert.strictEqual(g.reached.length, 1);
  g.tokens.revoke(token);
  assert.strictEqual(await run({ VISTACLAIR_SESSION_TOKEN: token, VISTACLAIR_INSTANCE_ID: 'cli-hook' }), 0, 'fails open after the session ended');
  assert.strictEqual(g.reached.length, 1, 'a revoked token reaches nothing');
});

test('D2 orchestration hook: lib/orchestration-hook.js needs a run member (scope run)', async (t) => {
  const g = await startGate(t);
  const run = (token) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'lib', 'orchestration-hook.js')], { env: { PATH: process.env.PATH, VISTACLAIR_DASHBOARD_PORT: String(g.port), VISTACLAIR_INSTANCE_ID: 'cli-w', VISTACLAIR_SESSION_TOKEN: token }, stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('exit', resolve);
    p.stdin.end(JSON.stringify({ hook_event_name: 'Stop' }));
  });
  await run(g.tokens.mint('cli-w', { scopes: scopesFor({ orchestration: { role: 'worker' } }) }));
  assert.strictEqual(g.reached.length, 1);
  assert.strictEqual(g.reached[0].path, ORCH('hook'));
  assert.strictEqual(g.reached[0].vc.instanceId, 'cli-w');
  // A plain session (scope session only) has no business here.
  await run(g.tokens.mint('cli-w', { scopes: scopesFor({}) }));
  assert.strictEqual(g.reached.length, 1, 'a plain session token is refused on the orchestration hook');
});

// The orchestrator MCP server (lib/orchestrator-mcp.js), driven over JSON-RPC.
const MCP_SDK = path.join(ROOT, 'mcp-servers', 'integrated', 'node_modules', '@modelcontextprotocol', 'sdk');
function mcpTool(port, env, name, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'lib', 'orchestrator-mcp.js')], {
      env: { PATH: process.env.PATH, VISTACLAIR_DASHBOARD_PORT: String(port), ...env }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('no tools/call answer')); }, 15000);
    p.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 2) { clearTimeout(timer); p.kill(); resolve(m.result?.content?.[0]?.text ?? JSON.stringify(m)); }
      }
    });
    const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
  });
}

test('D2 orchestrator MCP: a worker reports with its token; an orchestrator launches; a revoked one gets nothing', { skip: !fs.existsSync(MCP_SDK) && 'MCP SDK not installed' }, async (t) => {
  const g = await startGate(t);
  const wTok = g.tokens.mint('cli-w1', { scopes: scopesFor({ orchestration: { role: 'worker' } }) });
  const wEnv = { VISTACLAIR_SESSION_TOKEN: wTok, VISTACLAIR_INSTANCE_ID: 'cli-w1', VISTACLAIR_ORCH_ROLE: 'worker' };
  const r = await mcpTool(g.port, wEnv, 'report', { status: 'done', summary: 'x' });
  assert.ok(/reached/.test(r), 'the report reached the dashboard');
  assert.deepStrictEqual(g.reached.map(x => [x.path, x.vc.instanceId]), [[ORCH('report'), 'cli-w1']]);
  assert.strictEqual('token' in g.reached[0].body, false);

  const oTok = g.tokens.mint('cli-o1', { scopes: scopesFor({ orchestration: { role: 'orchestrator' } }) });
  const oEnv = { VISTACLAIR_SESSION_TOKEN: oTok, VISTACLAIR_INSTANCE_ID: 'cli-o1', VISTACLAIR_ORCH_ROLE: 'orchestrator' };
  const l = await mcpTool(g.port, oEnv, 'launch_cli', { title: 't', task: 'x', cwd: '/tmp' });
  assert.ok(/reached/.test(l), 'an orchestrator launches');
  assert.strictEqual(g.reached.at(-1).path, ORCH('launch'));

  // The legacy owner-token variable carries no owner right into the tool.
  const legacy = await mcpTool(g.port, { ...oEnv, VISTACLAIR_SESSION_TOKEN: '', VISTACLAIR_AUTH_TOKEN: OWNER }, 'launch_cli', { title: 't', task: 'x', cwd: '/tmp' });
  assert.ok(/Unauthorized/.test(legacy), 'the owner token in the old variable is not read, and is no credential');

  const before = g.reached.length;
  g.tokens.revoke(wTok); g.tokens.revoke(oTok);
  assert.ok(/Unauthorized/.test(await mcpTool(g.port, wEnv, 'report', { status: 'done', summary: 'x' })));
  assert.ok(/Unauthorized/.test(await mcpTool(g.port, oEnv, 'launch_cli', { title: 't', task: 'x', cwd: '/tmp' })));
  assert.strictEqual(g.reached.length, before, 'after the session ends nothing arrives');
});

test('D2 ask tool: vista-AskUserQuestion sends the session token and gets the answer', async (t) => {
  const g = await startGate(t);
  const token = g.tokens.mint('cli-ask');
  const mod = await import(path.join(ROOT, 'mcp-servers', 'integrated', 'tools', 'vista-ask-user-question.js'));
  let handler;
  mod.default({ tool: (name, desc, schema, fn) => { handler = fn; } });
  const saved = { ...process.env };
  Object.assign(process.env, { VISTACLAIR_DASHBOARD_PORT: String(g.port), VISTACLAIR_SESSION_TOKEN: token, VISTACLAIR_INSTANCE_ID: 'cli-ask' });
  try {
    const out = await handler({ questions: [{ question: 'ok?' }] }, {});
    assert.deepStrictEqual(JSON.parse(out.content[0].text), ['yes']);
    assert.strictEqual(g.reached[0].vc.instanceId, 'cli-ask');
    assert.strictEqual('token' in g.reached[0].body, false);
    g.tokens.revoke(token);
    const after = await handler({ questions: [{ question: 'ok?' }] }, {});
    assert.deepStrictEqual(JSON.parse(after.content[0].text), { cancelled: true }, 'refused after the session ended');
    assert.strictEqual(g.reached.length, 1);
  } finally {
    for (const k of ['VISTACLAIR_DASHBOARD_PORT', 'VISTACLAIR_SESSION_TOKEN', 'VISTACLAIR_INSTANCE_ID']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test('D2 Pro scripts/app-change.js: a session token in the legacy header reaches its change-request routes only', async (t) => {
  const g = await startGate(t);
  const token = g.tokens.mint('cli-ac');
  const legacy = { 'x-vistaclair-internal': token };
  const ok = [
    ['POST', '/pro/apps/change-requests', { instanceId: 'cli-ac', to: 'a' }],
    ['GET', '/pro/apps/change-requests/abc123', undefined],
    ['GET', '/pro/apps/change-requests/abc123/wait?timeoutMs=10', undefined],
    ['POST', '/pro/apps/change-requests/abc123/done', { instanceId: 'cli-ac' }],
    ['POST', '/pro/apps/change-requests/abc123/cancel', { instanceId: 'cli-ac' }],
    ['POST', '/pro/apps/deps/depend', { instanceId: 'cli-ac', on: 'b' }],
  ];
  for (const [method, p, body] of ok) assert.strictEqual((await call(g.port, { method, path: p, headers: legacy, body })).status, 200, `${method} ${p}`);
  assert.strictEqual(g.reached.length, ok.length);
  for (const [method, p] of [['POST', '/pro/apps/change-requests/abc123/other'], ['GET', '/pro/apps/change-requests'], ['POST', '/pro/apps/change-requests/abc/done/'], ['POST', '/pro/apps/PEER/x'], ['POST', '/pro/apps/change-requests/../x']]) {
    // (a browser path outside /api/ is redirected to the login page, an API path gets 401)
    assert.ok([302, 401].includes((await call(g.port, { method, path: p, headers: legacy, body: {} })).status), `${method} ${p}`);
  }
  assert.strictEqual(g.reached.length, ok.length, 'none of the others reached a handler');
  g.tokens.revoke(token);
  assert.ok([302, 401].includes((await call(g.port, { path: '/pro/apps/deps/depend', headers: legacy, body: { on: 'b' } })).status), 'refused after the session ended');
  assert.strictEqual(g.reached.length, ok.length);
});

test('D3: a session token is refused for login, cookies, bearer, WebSocket upgrades and every session-driving or owner endpoint', async (t) => {
  const g = await startGate(t);
  const wTok = g.tokens.mint('cli-w', { scopes: scopesFor({ orchestration: { role: 'worker' } }) });
  const oTok = g.tokens.mint('cli-o', { scopes: scopesFor({ orchestration: { role: 'orchestrator' } }) });
  const plain = g.tokens.mint('cli-p');
  const login = g.login;
  const sessionsBefore = login.listSessions().length;

  for (const token of [plain, wTok, oTok]) {
    // Login routes: never a login, never a cookie.
    const forms = [
      await call(g.port, { path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: undefined }),
    ];
    const post = await new Promise((resolve, reject) => {
      const body = `token=${encodeURIComponent(token)}`;
      const req = http.request({ host: '127.0.0.1', port: g.port, path: '/login', method: 'POST', agent: false, headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
      req.on('error', reject); req.end(body);
    });
    assert.strictEqual(post.headers.location, '/login?error=1', 'POST /login');
    assert.strictEqual((post.headers['set-cookie'] || []).length, 0);
    const auto = await call(g.port, { method: 'GET', path: `/login/auto?token=${encodeURIComponent(token)}` });
    assert.strictEqual(auto.headers.location, '/login');
    assert.strictEqual(auto.headers['set-cookie'], undefined);
    void forms;

    // Credentials an owner would use: cookie, bearer, internal header, on an owner API.
    for (const [label, headers] of [['cookie token', { cookie: `token=${token}` }], ['cookie sid', { cookie: `sid=${token}` }], ['bearer', { authorization: `Bearer ${token}` }]]) {
      assert.strictEqual((await call(g.port, { method: 'GET', path: '/api/state', headers })).status, 401, label);
    }
    // The internal-header owner endpoints.
    assert.strictEqual((await call(g.port, { path: '/api/login/login-link', headers: { 'x-vistaclair-internal': token } })).status, 401, 'login-link (internal header)');
    assert.strictEqual((await call(g.port, { path: '/api/login/login-link', headers: S(token) })).status, 401, 'login-link (session header)');
    assert.strictEqual((await call(g.port, { path: '/api/internal/broadcast', headers: S(token), body: { type: 'x' } })).status, 401, 'broadcast relay');

    // WebSocket upgrades, by every header it could ride.
    for (const headers of [S(token), { 'x-vistaclair-internal': token }, { cookie: `token=${token}` }, { cookie: `sid=${token}` }, { authorization: `Bearer ${token}` }]) {
      assert.notStrictEqual(await upgradeStatus(g.port, headers), 101, `upgrade ${Object.keys(headers)[0]}`);
    }
    // Endpoints that start or drive sessions, and the rest of the dashboard API.
    for (const p of ['/api/cli/spawn', '/api/cli/input', '/api/restart', '/api/sdk/send', '/api/mcp/tools', '/api/orchestration/pause', '/api/orchestration/refresh', '/api/orchestration/resume-run', '/api/orchestration/delete-run', '/api/orchestration/owner-resolve', '/api/orchestration/owner-delete', '/api/cli-isolation/land', '/api/state']) {
      const r = await call(g.port, { path: p, headers: S(token), body: {} });
      assert.strictEqual(r.status, 401, p);
    }
    assert.strictEqual((await call(g.port, { method: 'GET', path: '/api/orchestration/run', headers: S(token) })).status, 401);
    assert.strictEqual((await call(g.port, { method: 'GET', path: '/api/orchestration/owner-items', headers: S(token) })).status, 401, 'GET variants are not the tool routes');
    // Path variants of an allowed endpoint: exact method and path only.
    for (const p of ['/api/hook-report/', '/API/hook-report', '/api/Hook-Report', '/api/hook-report/x']) {
      assert.notStrictEqual((await call(g.port, { path: p, headers: S(token), body: { instanceId: 'x' } })).status, 200, p);
    }
    assert.strictEqual((await call(g.port, { method: 'GET', path: '/api/hook-report', headers: S(token) })).status, 401, 'method');
  }
  // Reached nothing, started no dashboard session.
  assert.strictEqual(g.reached.length, 0);
  assert.strictEqual(login.listSessions().length, sessionsBefore, 'no login happened');

  // Scopes: the orchestration endpoints per role.
  for (const n of WORKER_OK) {
    assert.strictEqual((await call(g.port, { path: ORCH(n), headers: S(wTok), body: {} })).status, 200, `worker ${n}`);
    assert.strictEqual((await call(g.port, { path: ORCH(n), headers: S(oTok), body: {} })).status, n === 'report' ? 401 : 200, `orchestrator ${n}`);
    assert.strictEqual((await call(g.port, { path: ORCH(n), headers: S(plain), body: {} })).status, 401, `plain ${n}`);
  }
  for (const n of ORCH_ONLY) {
    assert.strictEqual((await call(g.port, { path: ORCH(n), headers: S(oTok), body: {} })).status, 200, `orchestrator ${n}`);
    assert.strictEqual((await call(g.port, { path: ORCH(n), headers: S(wTok), body: {} })).status, 401, `worker ${n}`);
    assert.strictEqual((await call(g.port, { path: ORCH(n), headers: S(plain), body: {} })).status, 401, `plain ${n}`);
  }
});

test('D3: a session token is refused from a tunnel (X-Forwarded-For) and the owner token still works where it did', async (t) => {
  const g = await startGate(t);
  const token = g.tokens.mint('cli-t');
  assert.strictEqual((await call(g.port, { path: '/api/hook-report', headers: { ...S(token), 'x-forwarded-for': '203.0.113.9' }, body: { instanceId: 'cli-t' } })).status, 401);
  assert.strictEqual((await call(g.port, { path: '/api/hook-report', headers: S(token), body: { instanceId: 'cli-t' } })).status, 200);
  // Unchanged for the owner: Bearer, internal header, and an owner login on the owner APIs.
  assert.strictEqual((await call(g.port, { path: '/api/hook-report', headers: { authorization: `Bearer ${OWNER}` }, body: { instanceId: 'cli-t' } })).status, 200);
  assert.strictEqual((await call(g.port, { path: ORCH('launch'), headers: { 'x-vistaclair-internal': OWNER }, body: {} })).status, 200);
  assert.strictEqual((await call(g.port, { path: ORCH('launch'), body: {} })).status, 401);
  // An unknown vcs_ value is just a wrong credential.
  assert.strictEqual((await call(g.port, { path: ORCH('launch'), headers: { 'x-vistaclair-internal': 'vcs_nope' }, body: {} })).status, 401);
});

test('D4: a session token is bound to its session — it cannot name another', async (t) => {
  const g = await startGate(t);
  const a = g.tokens.mint('cli-a', { scopes: scopesFor({ orchestration: { role: 'worker' } }) });
  g.tokens.mint('cli-b', { scopes: scopesFor({ orchestration: { role: 'worker' } }) });
  const other = await call(g.port, { path: ORCH('report'), headers: S(a), body: { instanceId: 'cli-b', status: 'done', summary: 'x' } });
  assert.strictEqual(other.status, 403);
  assert.strictEqual((await call(g.port, { path: '/api/hook-report', headers: S(a), body: { instanceId: 'cli-b' } })).status, 403);
  assert.strictEqual((await call(g.port, { path: '/api/ask', headers: S(a), body: { instanceId: 'cli-b' } })).status, 403);
  assert.strictEqual((await call(g.port, { path: `${ORCH('report')}?instanceId=cli-b`, headers: S(a), body: {} })).status, 403);
  assert.strictEqual(g.reached.length, 0);
  // Absent or null: filled in with the bound one, so a handler cannot be sent elsewhere.
  await call(g.port, { path: ORCH('report'), headers: S(a), body: { status: 'done', summary: 'x' } });
  await call(g.port, { path: ORCH('report'), headers: S(a), body: { instanceId: null, status: 'done' } });
  assert.deepStrictEqual(g.reached.map(r => r.body.instanceId), ['cli-a', 'cli-a']);
  // A token in the body (an old tool copy) works like the header, still bound.
  assert.strictEqual((await call(g.port, { path: '/api/ask', body: { token: a, instanceId: 'cli-a' } })).status, 200);
  assert.strictEqual((await call(g.port, { path: '/api/ask', body: { token: a, instanceId: 'cli-b' } })).status, 403);
});

// --- D5: where tokens are minted and revoked ---
const utilsMod = require('../src/utils');
const ptySpawns = [];
utilsMod.spawnClaudePty = (args, o) => {
  ptySpawns.push({ args, o });
  let exit; return { pid: 0, onData() {}, onExit(fn) { exit = fn; ptySpawns.at(-1).exit = (c) => exit({ exitCode: c }); }, write() {}, resize() {} };
};
const claudeAuth = require('../src/claude-auth');
const AUTH_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none' });
claudeAuth.authStatus.setRunner({ run: async () => AUTH_OUT, runSync: () => AUTH_OUT });
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
const CliSession = require('../src/cli-session');
const SdkSession = require('../src/sdk-session');
const { shared: registry } = require('../src/session-tokens');
const memStore = { registerSession() {}, unregisterSession() {}, loadSessionIntoMemory: () => [], deleteSessionData() {} };
const WORKER_SETTINGS = { name: 'w', engine: 'sdk', orchestration: { runId: 'r1', role: 'worker', workerId: 'w1' } };
const fakeReq = (token, p = '/api/hook-report') => ({ headers: { 'x-vistaclair-session': token }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', path: p, body: {}, query: {} });
const live = (token, p) => registry.check(fakeReq(token, p))?.ok === true;

test('D5 CLI tab: the spawn holds a session token in its env and MCP config, revoked on kill, exit and respawn', () => {
  process.env.AUTH_TOKEN = OWNER; // what a server that did not scrub its env would hand down
  try {
    const cli = new CliSession(9999, { broadcast() {} }, memStore, { authToken: OWNER, dashboardPort: 4321 });
    cli.updateSettings(WORKER_SETTINGS);
    cli.spawn(HOME, 80, 24, {});
    const { args, o } = ptySpawns.at(-1);
    const token = o.sessionToken;
    assert.ok(token.startsWith('vcs_'));
    assert.strictEqual('authToken' in o, false, 'the owner token is not handed to the spawn');
    assert.ok(live(token), 'live while the session runs');
    assert.ok(live(token, ORCH('report')), 'a worker may report');
    assert.strictEqual(live(token, ORCH('launch')), false, 'a worker may not launch');
    const cfg = fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8');
    assert.ok(cfg.includes(token));
    assert.strictEqual(cfg.includes(OWNER), false, 'the MCP config has no owner token');
    // Respawn: the old token ends, a new one lives.
    cli.spawn(HOME, 80, 24, { resumeSessionId: cli.sessId });
    const t2 = ptySpawns.at(-1).o.sessionToken;
    assert.notStrictEqual(t2, token);
    assert.strictEqual(live(token), false, 'old token revoked on respawn');
    assert.ok(live(t2));
    // The process exits on its own.
    ptySpawns.at(-1).exit(0);
    assert.strictEqual(live(t2), false, 'revoked on exit');
    cli.spawn(HOME, 80, 24, {});
    const t3 = ptySpawns.at(-1).o.sessionToken;
    assert.ok(live(t3));
    cli.kill();
    assert.strictEqual(live(t3), false, 'revoked on kill');
    // A plain (non-run) tab is a `session` scope: no orchestration at all.
    const plain = new CliSession(9999, { broadcast() {} }, memStore, { dashboardPort: 4321 });
    plain.spawn(HOME, 80, 24, {});
    const pt = ptySpawns.at(-1).o.sessionToken;
    assert.ok(live(pt));
    assert.strictEqual(live(pt, ORCH('report')), false);
    plain.kill();
  } finally { delete process.env.AUTH_TOKEN; }
});

test('D5 SDK session: the spawn holds a session token in its env and MCP config, revoked on kill and respawn', () => {
  const calls = [];
  const sdk = { query({ options }) { calls.push(options); return { [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return: async () => ({ done: true }), close() {} }; } };
  const s = new SdkSession(9999, { broadcast() {} }, memStore, { sdk, claudeBin: '/opt/claude', dashboardPort: 4321 });
  s.updateSettings(WORKER_SETTINGS);
  s.spawn(HOME, 80, 24, {});
  const o = calls[0];
  const cfg = JSON.parse(fs.readFileSync(o.extraArgs['mcp-config'], 'utf8')).mcpServers;
  const token = cfg.orchestrator.env.VISTACLAIR_SESSION_TOKEN;
  assert.ok(token.startsWith('vcs_'));
  assert.strictEqual(o.env.VISTACLAIR_SESSION_TOKEN, token);
  assert.strictEqual(o.env.VISTACLAIR_AUTH_TOKEN, token);
  assert.ok(live(token));
  s.spawn(HOME, 80, 24, {});
  assert.strictEqual(live(token), false, 'revoked on respawn');
  const t2 = calls[1].env.VISTACLAIR_SESSION_TOKEN;
  assert.ok(live(t2));
  s.kill();
  assert.strictEqual(live(t2), false, 'revoked on kill');
});

test('D5 a refused SDK launch leaves no live token behind', () => {
  const sdk = { query() { throw new Error('boom'); } };
  const s = new SdkSession(9999, { broadcast() {} }, memStore, { sdk, claudeBin: '/opt/claude', dashboardPort: 4321 });
  const minted = [];
  const realMint = registry.mint;
  registry.mint = (...a) => { const tk = realMint.apply(registry, a); minted.push(tk); return tk; };
  try { try { s.spawn(HOME, 80, 24, {}); } catch {} } finally { registry.mint = realMint; }
  assert.ok(minted.length >= 1, 'a token was minted for the spawn');
  for (const tk of minted) assert.strictEqual(live(tk), false);
});

// --- D6/D7: the processes' environments ---
test('D6 the integrated MCP bridge opens no dashboard connection', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => wss.once('listening', r));
  let connections = 0;
  wss.on('connection', () => { connections++; });
  const p = spawn(process.execPath, [path.join(ROOT, 'lib', 'mcp-bridge.js'), 'integrated'], {
    env: { PATH: process.env.PATH, VISTACLAIR_SESSION_TOKEN: 'vcs_x', MCP_DASHBOARD_URL: `ws://127.0.0.1:${wss.address().port}`, VISTACLAIR_DATA_HOME: HOME },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  await new Promise(r => setTimeout(r, 1500));
  p.kill();
  wss.close();
  assert.strictEqual(connections, 0);
  assert.strictEqual(/new WebSocket|MCP_AUTH_TOKEN|x-vistaclair-internal/i.test(fs.readFileSync(path.join(ROOT, 'lib', 'mcp-bridge.js'), 'utf8')), false);
});

test('D7 buildClaudeEnv: no owner token under any name; the session token under two; Pro\'s tool token (extraEnv) is kept', () => {
  const saved = { ...process.env };
  Object.assign(process.env, { AUTH_TOKEN: OWNER, VISTACLAIR_AUTH_TOKEN: OWNER, MCP_AUTH_TOKEN: OWNER, VISTACLAIR_SESSION_TOKEN: OWNER });
  try {
    const env = utilsMod.buildClaudeEnv({ proxyPort: 1, dashboardPort: 2, sessionToken: 'vcs_abc', instanceId: 'cli-x', extraEnv: {}, autoMemory: false });
    assert.strictEqual(env.AUTH_TOKEN, undefined);
    assert.strictEqual(env.MCP_AUTH_TOKEN, undefined);
    assert.strictEqual(env.VISTACLAIR_SESSION_TOKEN, 'vcs_abc');
    assert.strictEqual(env.VISTACLAIR_AUTH_TOKEN, 'vcs_abc');
    assert.strictEqual(Object.values(env).includes(OWNER), false, 'the owner token is in no variable');
    const none = utilsMod.buildClaudeEnv({ proxyPort: 1, dashboardPort: 2, instanceId: 'cli-x', autoMemory: false, authToken: OWNER });
    assert.strictEqual(Object.values(none).includes(OWNER), false, 'a caller passing authToken does not hand it down');
    assert.strictEqual(none.VISTACLAIR_AUTH_TOKEN, undefined);
    const pro = utilsMod.buildClaudeEnv({ proxyPort: 1, dashboardPort: 2, instanceId: 'cli-x', autoMemory: false, extraEnv: { VISTACLAIR_AUTH_TOKEN: 'tool-token', AUTH_TOKEN: undefined } });
    assert.strictEqual(pro.VISTACLAIR_AUTH_TOKEN, 'tool-token');
    assert.strictEqual(pro.AUTH_TOKEN, undefined);
    assert.strictEqual(Object.values(utilsMod.withoutOwnerToken(process.env)).includes(OWNER), false);
  } finally {
    for (const k of ['AUTH_TOKEN', 'VISTACLAIR_AUTH_TOKEN', 'MCP_AUTH_TOKEN', 'VISTACLAIR_SESSION_TOKEN']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test('D7 the server scrubs the owner token from its own environment at boot; the shell tab and the tool probe inherit none', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(/for \(const name of \['AUTH_TOKEN', 'VISTACLAIR_AUTH_TOKEN', 'MCP_AUTH_TOKEN', 'VISTACLAIR_SESSION_TOKEN'\]\) delete process\.env\[name\]/.test(server));
  assert.ok(server.indexOf('delete process.env[name]') > server.indexOf("const AUTH_TOKEN_SOURCE"), 'after the token is read');
  assert.ok(/env: withoutOwnerToken\(process\.env\)/.test(fs.readFileSync(path.join(ROOT, 'src', 'cli-session.js'), 'utf8')), 'shell tab');
  assert.ok(/withoutOwnerToken\(process\.env\)/.test(fs.readFileSync(path.join(ROOT, 'src', 'mcp', 'index.js'), 'utf8')), 'spawnBridge');
  for (const f of ['src/cli-session.js', 'src/sdk-session.js', 'src/utils.js', 'src/mcp/index.js']) {
    assert.strictEqual(/process\.env\.AUTH_TOKEN|_authToken|opts\.authToken/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), false, `${f} reads no owner token`);
  }
  assert.ok(/\.\.\.sessionToken|sessionTokens\.acceptOrOwner/.test(server) || /sessionTokens\.acceptOrOwner/.test(server));
});

test('D8 Pro slave login: the add-on keeps the owner token and POST /api/login/login-link still works; a session token does not', async (t) => {
  const g = await startGate(t);
  // What the add-on holds: ctx.authToken is the real owner token.
  const { createAddonCtx } = require('../src/addon-host');
  const ctx = createAddonCtx({ dataHome: fs.mkdtempSync(path.join(HOME, 'd8-')), dashboard: { broadcaster: { broadcast() {} }, store: {}, cliSessionManager: {}, authToken: OWNER } });
  assert.strictEqual(ctx.authToken, OWNER, 'the add-on still receives the owner token');
  // peer-server.js style call: loopback + internal header with options.authToken.
  const viaAddon = await call(g.port, { path: '/api/login/login-link', headers: { 'x-vistaclair-internal': ctx.authToken } });
  assert.strictEqual(viaAddon.status, 200);
  const link = JSON.parse(viaAddon.text);
  assert.ok(/^\/login\/once\?k=[0-9a-f]{64}$/.test(link.path), 'a single-use login path');
  const redeem = await call(g.port, { method: 'GET', path: link.path });
  assert.ok((redeem.headers['set-cookie'] || []).some(c => c.startsWith('sid=')));
  // Every session-scoped credential form is refused on that route.
  for (const tokenScopes of [['session'], scopesFor({ orchestration: { role: 'worker' } }), scopesFor({ orchestration: { role: 'orchestrator' } })]) {
    const tok = g.tokens.mint('cli-d8', { scopes: tokenScopes });
    for (const headers of [{ 'x-vistaclair-internal': tok }, S(tok), { authorization: `Bearer ${tok}` }]) {
      const r = await call(g.port, { path: '/api/login/login-link', headers });
      assert.strictEqual(r.status, 401, 'session token on login-link');
      assert.strictEqual(r.text.includes('/login/once'), false);
    }
  }
});

// --- bin/supervisor.js: the log is owner-only, the rescue page tells the truth ---
async function startSupervisor(t, { oldLog }) {
  const home = fs.mkdtempSync(path.join(HOME, 'sup-'));
  const logDir = path.join(home, 'data', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  if (oldLog) {
    fs.writeFileSync(path.join(logDir, 'server.log'), 'old\n');
    fs.chmodSync(path.join(logDir, 'server.log'), 0o664);
  }
  const ctrl = path.join(home, 'ctrl');
  fs.writeFileSync(ctrl, 'crash');
  fs.writeFileSync(path.join(home, 'spawns'), '');
  const port = await freePort();
  const env = {
    ...process.env,
    VISTACLAIR_SUPERVISOR_CHILD: path.join(__dirname, 'fixtures', 'supervisor-child.js'), VISTACLAIR_HOME: home,
    DASHBOARD_PORT: String(port), DASHBOARD_HOST: '127.0.0.1', AUTH_TOKEN: OWNER,
    VISTACLAIR_BOOT_TIMEOUT_MS: '3000', VISTACLAIR_HEALTH_INTERVAL_MS: '300', VISTACLAIR_KILL_GRACE_MS: '500',
    FAKE_CTRL: ctrl, FAKE_SPAWNS: path.join(home, 'spawns'),
  };
  delete env.VISTACLAIR_SERVER; delete env.VISTACLAIR_SUPERVISED; delete env.VISTA_SECRETS_KEY;
  const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'supervisor.js')], { cwd: home, env, stdio: 'ignore', detached: true });
  t.after(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} });
  return { port, log: path.join(logDir, 'server.log') };
}
const modeOf = (f) => fs.statSync(f).mode & 0o777;

test('supervisor: a new server.log is created 0600, an older 0664 one is tightened', async (t) => {
  const fresh = await startSupervisor(t, { oldLog: false });
  await waitFor(() => fs.existsSync(fresh.log), { timeoutMs: 15000, what: 'a new server.log' });
  assert.strictEqual(modeOf(fresh.log), 0o600, 'created 0600');
  const old = await startSupervisor(t, { oldLog: true });
  await waitFor(() => modeOf(old.log) === 0o600, { timeoutMs: 15000, what: 'the old log tightened' });
});

test('supervisor: the rescue login text no longer claims the token is printed', async (t) => {
  const sup = await startSupervisor(t, { oldLog: false });
  let page = null;
  for (let i = 0; i < 100 && !page; i++) {
    const r = await call(sup.port, { method: 'GET', path: '/login' }).catch(() => null);
    if (r && r.status === 200) page = r.text;
    else await new Promise(r2 => setTimeout(r2, 100));
  }
  assert.ok(page, 'the rescue login page is served');
  assert.strictEqual(/printed in the server/i.test(page), false, 'the stale claim is gone');
  assert.ok(/never printed/.test(page));
});
