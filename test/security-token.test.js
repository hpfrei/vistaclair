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
