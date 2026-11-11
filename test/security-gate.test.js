// The owner login gate (src/auth.js, src/addons.js, bin/supervisor.js):
//   1. a WebSocket upgrade that relies on the owner gate is refused when its
//      Origin names another host (a browser sends Origin on every upgrade)
//   2. a cookie-authenticated mutating request is refused (403) when its
//      Origin names another host; Bearer / internal callers are unaffected
//   3. a non-ASCII credential of equal length is a clean refusal, never a throw
//   4. dot segments never walk out of an auth-exempt prefix
//   5. the rescue page loads xterm from the repo's vendored copy, not a CDN
// Temp dirs and ephemeral ports only.
//
//   node --test test/security-gate.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-secgate-')));
process.env.VISTACLAIR_HOME = HOME;

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createLogin } = require('../src/login');
const { mountLoginRoutes } = require('../src/login-routes');
const { createAuth, safeEqual } = require('../src/auth');
const addons = require('../src/addons');

const TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex');
const quiet = { error() {}, log() {} };

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

// ── helpers ─────────────────────────────────────────────────────────────

// The server.js wiring in miniature: public login routes, then the owner gate,
// then static client assets and some owner-only API routes. An add-on declares
// '/pro/tg-session' (prefix) and an app-root pattern as auth-exempt.
async function startApp(t) {
  const dataHome = fs.mkdtempSync(path.join(HOME, 'app-'));
  const login = createLogin({ dataHome, log: quiet });
  const auth = createAuth({ authToken: TOKEN, login });
  const sid = login.createSession({ via: 'test' }).sid;

  const pub = path.join(dataHome, 'public');
  fs.mkdirSync(path.join(pub, 'pro', 'tg-session'), { recursive: true });
  fs.writeFileSync(path.join(pub, 'index.html'), 'OWNER-INDEX');
  fs.writeFileSync(path.join(pub, 'pro', 'tg-session', 'page.txt'), 'EXEMPT-PAGE');

  const descriptor = {
    contractVersion: addons.CONTRACT_VERSION, id: 'sec-gate-test',
    authExemptPaths: ['/pro/tg-session'],
    authExemptPatterns: [/^\/apps\/demo\/$/],
  };
  assert.ok(addons.registerAddon(descriptor));
  t.after(() => addons.removeAddon('sec-gate-test'));

  const logs = [];
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  mountLoginRoutes(app, {
    login, authToken: TOKEN,
    authCookie: (name, value, extra = '') => `${name}=${value}; HttpOnly; SameSite=Lax; Path=/${extra}`,
    authLimiter: (req, res, next) => next(),
    isLoopback: auth.isLoopback, isInternal: auth.isInternal,
    getSidFromCookies: auth.getSidFromCookies, safeEqual: auth.safeEqual,
    publicDir: path.join(__dirname, '..', 'public'),
  });
  app.use(auth.gateMiddleware({ isAuthExempt: (p) => addons.isAuthExempt(p), log: (line) => logs.push(line) }));
  app.use(express.static(pub));
  app.post('/api/restart', (req, res) => res.json({ ok: true }));
  app.post('/api/logout-test', (req, res) => res.json({ ok: true }));
  app.get('/api/state', (req, res) => res.json({ ok: true }));
  app.use((req, res) => res.status(404).end());

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => ws.close());
  const sockets = [];
  const upgradeHandler = addons.createUpgradeHandler({ isOwnerUpgrade: (req, socket) => auth.isOwnerUpgrade(req, socket), wss });
  server.on('upgrade', (req, socket, head) => { sockets.push(socket); upgradeHandler(req, socket, head); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { wss.close(); server.closeAllConnections?.(); server.close(() => r()); }));
  const port = server.address().port;
  return { port, sid, auth, logs, sockets, origin: `http://127.0.0.1:${port}` };
}

// A raw request: the path is sent exactly as given (no normalisation).
function request(port, { path: p = '/', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false, timeout: 4000 }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// One upgrade → { status, closed } where `closed` says the server side of the
// connection was ended (no hanging socket).
function upgrade(port, headers = {}, p = '/') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: p, agent: false,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers,
      },
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error('upgrade hung: socket left open')); }, 4000);
    const finish = (status, socket) => {
      socket.on('close', () => { clearTimeout(timer); resolve({ status }); });
      socket.on('error', () => {});
      socket.resume();
      if (status === 101) socket.destroy();
    };
    req.on('upgrade', (res, socket) => finish(res.statusCode, socket));
    req.on('response', (res) => { res.resume(); finish(res.statusCode, res.socket); });
    req.on('error', (e) => { clearTimeout(timer); resolve({ status: 0, error: e.code || e.message }); });
    req.end();
  });
}

const bearer = { authorization: `Bearer ${TOKEN}` };
const cookieSid = (s) => ({ cookie: `sid=${s.sid}` });
const cookieToken = { cookie: `token=${TOKEN}` };
// Same length as the token, but a non-ASCII character: its byte length differs.
const NON_ASCII = TOKEN.slice(0, -1) + 'é';

// ── 1. WebSocket Origin ─────────────────────────────────────────────────

test('upgrade: valid cookie + foreign Origin is refused, same Origin is accepted', async (t) => {
  const s = await startApp(t);
  const foreign = await upgrade(s.port, { ...cookieSid(s), origin: 'http://evil.example' });
  assert.strictEqual(foreign.status, 403);
  const otherPort = await upgrade(s.port, { ...cookieSid(s), origin: 'http://127.0.0.1:1' });
  assert.strictEqual(otherPort.status, 403, 'same host, other port (cookies ignore ports)');
  const asNull = await upgrade(s.port, { ...cookieSid(s), origin: 'null' });
  assert.strictEqual(asNull.status, 403);
  const tokenForeign = await upgrade(s.port, { ...cookieToken, origin: 'https://evil.example' });
  assert.strictEqual(tokenForeign.status, 403);
  const bearerForeign = await upgrade(s.port, { ...bearer, origin: 'http://evil.example' });
  assert.strictEqual(bearerForeign.status, 403, 'every owner-gated upgrade is checked');

  const same = await upgrade(s.port, { ...cookieSid(s), origin: s.origin });
  assert.strictEqual(same.status, 101);
  const sameToken = await upgrade(s.port, { ...cookieToken, origin: s.origin });
  assert.strictEqual(sameToken.status, 101);
});

test('upgrade: no Origin (non-browser clients) stays allowed; no credentials is still 401', async (t) => {
  const s = await startApp(t);
  assert.strictEqual((await upgrade(s.port, bearer)).status, 101);
  assert.strictEqual((await upgrade(s.port, { 'x-vistaclair-internal': TOKEN })).status, 101);
  assert.strictEqual((await upgrade(s.port, cookieSid(s))).status, 101);
  assert.strictEqual((await upgrade(s.port, { origin: s.origin })).status, 401);
});

test('upgrade: a proxied host is accepted via X-Forwarded-Host from a loopback peer only', async (t) => {
  const s = await startApp(t);
  const proxied = { ...cookieSid(s), origin: 'https://dash.example.com', 'x-forwarded-host': 'dash.example.com', 'x-forwarded-for': '203.0.113.9' };
  assert.strictEqual((await upgrade(s.port, proxied)).status, 101);
  assert.strictEqual((await upgrade(s.port, { ...proxied, origin: 'https://evil.example' })).status, 403);

  // A non-loopback peer cannot name its own host with a forged header.
  const req = (peer, headers) => ({ socket: { remoteAddress: peer }, headers });
  assert.strictEqual(s.auth.originAllowed(req('203.0.113.5', { host: 'a.test', origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' })), false);
  assert.strictEqual(s.auth.originAllowed(req('127.0.0.1', { host: 'a.test', origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' })), true);
  assert.strictEqual(s.auth.originAllowed(req('203.0.113.5', { host: 'a.test', origin: 'https://a.test' })), true);
  assert.strictEqual(s.auth.originAllowed(req('203.0.113.5', { host: 'a.test:8443', origin: 'https://a.test:8443' })), true);
  assert.strictEqual(s.auth.originAllowed(req('203.0.113.5', { host: 'a.test', origin: 'https://a.test:8443' })), false);
  assert.strictEqual(s.auth.originAllowed(req('203.0.113.5', { host: 'a.test' })), true, 'no Origin');
});

test('upgrade: an exempt add-on path (peer channel) is not Origin-checked; it authenticates itself', async (t) => {
  const s = await startApp(t);
  const seen = [];
  const d = {
    contractVersion: addons.CONTRACT_VERSION, id: 'sec-gate-peer', authExemptUpgradePaths: ['/api/peer/channel'],
    handleUpgrade(req, socket) {
      seen.push(req.headers.origin);
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      socket.destroy();
      return true;
    },
  };
  assert.ok(addons.registerAddon(d));
  t.after(() => addons.removeAddon('sec-gate-peer'));
  const r = await upgrade(s.port, { origin: 'http://evil.example' }, '/api/peer/channel');
  assert.strictEqual(r.status, 101);
  assert.deepStrictEqual(seen, ['http://evil.example']);
});

// ── 2. cookie POST + foreign Origin ─────────────────────────────────────

test('http: cookie-authenticated POST with a foreign Origin gets 403 and one log line', async (t) => {
  const s = await startApp(t);
  for (const headers of [cookieSid(s), cookieToken]) {
    for (const origin of ['http://evil.example', 'http://127.0.0.1:1', 'null']) {
      const r = await request(s.port, { path: '/api/restart', method: 'POST', headers: { ...headers, origin } });
      assert.strictEqual(r.status, 403, `${Object.keys(headers)} ${origin}`);
    }
  }
  assert.strictEqual(s.logs.length, 6, 'one line per refusal');
  for (const line of s.logs) {
    assert.match(line, /cross-origin/i);
    assert.ok(!line.includes(TOKEN) && !line.includes(s.sid), 'no secrets in the log line');
  }
});

test('http: same-origin cookie POST passes; GET, no-Origin and proxied same-origin pass', async (t) => {
  const s = await startApp(t);
  const post = (headers) => request(s.port, { path: '/api/restart', method: 'POST', headers });
  assert.strictEqual((await post({ ...cookieSid(s), origin: s.origin })).status, 200);
  assert.strictEqual((await post({ ...cookieToken, origin: s.origin })).status, 200);
  assert.strictEqual((await post(cookieSid(s))).status, 200, 'cookie, no Origin: non-browser client');
  const proxied = { ...cookieSid(s), origin: 'https://dash.example.com', 'x-forwarded-host': 'dash.example.com', 'x-forwarded-for': '203.0.113.9' };
  assert.strictEqual((await post(proxied)).status, 200);
  assert.strictEqual((await post({ ...proxied, origin: 'https://evil.example' })).status, 403);
  const get = await request(s.port, { path: '/api/state', headers: { ...cookieSid(s), origin: 'http://evil.example' } });
  assert.strictEqual(get.status, 200, 'safe methods are not restricted');
  assert.strictEqual(s.logs.length, 1);
});

test('http: Bearer / internal-header POST with a foreign Origin is not affected', async (t) => {
  const s = await startApp(t);
  const post = (headers) => request(s.port, { path: '/api/restart', method: 'POST', headers: { ...headers, origin: 'http://evil.example' } });
  assert.strictEqual((await post(bearer)).status, 200);
  assert.strictEqual((await post({ 'x-vistaclair-internal': TOKEN })).status, 200);
  assert.strictEqual((await post({ ...bearer, ...cookieSid(s) })).status, 200, 'Bearer decides when both are sent');
  assert.strictEqual((await post({})).status, 401, 'no credentials: still 401');
  assert.strictEqual(s.logs.length, 0);
});

test('http: the login form post and a cookie-less token login keep working with any Origin', async (t) => {
  const s = await startApp(t);
  const r = await request(s.port, {
    path: '/login', method: 'POST', body: `token=${encodeURIComponent(TOKEN)}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: s.origin },
  });
  assert.ok(r.status === 200 || r.status === 302, `login post status ${r.status}`);
  assert.match(String(r.headers['set-cookie']), /token=/);
});

test('ctx.isOwnerRequest (add-ons) applies the same cookie + Origin rule', async (t) => {
  const s = await startApp(t);
  const req = (method, headers) => ({ method, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'a.test', ...headers } });
  assert.strictEqual(s.auth.isOwnerRequest(req('POST', { ...cookieToken, origin: 'https://evil.example' })), false);
  assert.strictEqual(s.auth.isOwnerRequest(req('POST', { ...cookieToken, origin: 'http://a.test' })), true);
  assert.strictEqual(s.auth.isOwnerRequest(req('GET', { ...cookieToken, origin: 'https://evil.example' })), true);
  assert.strictEqual(s.auth.isOwnerRequest(req('POST', { ...bearer, origin: 'https://evil.example' })), true);
});

// ── 3. safeEqual / upgrade errors ───────────────────────────────────────

test('safeEqual: a non-ASCII value of equal length is false, not a throw', () => {
  assert.strictEqual(NON_ASCII.length, TOKEN.length);
  assert.notStrictEqual(Buffer.byteLength(NON_ASCII), Buffer.byteLength(TOKEN));
  assert.strictEqual(safeEqual(NON_ASCII, TOKEN), false);
  assert.strictEqual(safeEqual(TOKEN, NON_ASCII), false);
  assert.strictEqual(safeEqual(TOKEN, TOKEN), true);
  assert.strictEqual(safeEqual('é'.repeat(5), 'é'.repeat(5)), true);
  assert.strictEqual(safeEqual('a', 'b'), false);
  assert.strictEqual(safeEqual('abc', 'abcd'), false);
  assert.strictEqual(safeEqual(undefined, TOKEN), false);
  assert.strictEqual(safeEqual(null, null), false);
});

test('upgrade: a non-ASCII token of equal length is a clean 401 and the socket is closed', async (t) => {
  const s = await startApp(t);
  const viaBearer = await upgrade(s.port, { authorization: `Bearer ${NON_ASCII}` });
  assert.strictEqual(viaBearer.status, 401);
  const viaCookie = await upgrade(s.port, { cookie: `token=${NON_ASCII}` });
  assert.strictEqual(viaCookie.status, 401);
  const viaInternal = await upgrade(s.port, { 'x-vistaclair-internal': NON_ASCII });
  assert.strictEqual(viaInternal.status, 401);
  assert.ok(s.sockets.every(sock => sock.destroyed), 'every upgrade socket was destroyed');
});

test('http: a non-ASCII token of equal length is a plain 401', async (t) => {
  const s = await startApp(t);
  const r = await request(s.port, { path: '/api/state', headers: { authorization: `Bearer ${NON_ASCII}` } });
  assert.strictEqual(r.status, 401);
});

test('upgrade: any error in the handler destroys the socket instead of leaving it hanging', async (t) => {
  const wss = new WebSocketServer({ noServer: true });
  const handler = addons.createUpgradeHandler({ isOwnerUpgrade: () => { throw new Error('boom'); }, wss });
  const server = http.createServer();
  const sockets = [];
  server.on('upgrade', (req, socket, head) => { sockets.push(socket); handler(req, socket, head); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { wss.close(); server.closeAllConnections?.(); server.close(() => r()); }));
  const r = await upgrade(server.address().port);
  assert.ok([0, 401, 500].includes(r.status), `status ${r.status}`);
  assert.ok(sockets[0].destroyed);
});

// ── 4. dot segments vs exempt prefixes ──────────────────────────────────

test('exempt paths: a normal exempt path passes, dot segments never do (unit)', (t) => {
  assert.ok(addons.registerAddon({
    contractVersion: addons.CONTRACT_VERSION, id: 'sec-gate-exempt',
    authExemptPaths: ['/pro/tg-session', '/pro/auth/google/callback'],
    authExemptPatterns: [/^\/apps\/demo\/.*$/],
  }));
  t.after(() => addons.removeAddon('sec-gate-exempt'));
  const ex = addons.isAuthExempt;
  for (const ok of [
    '/pro/tg-session', '/pro/tg-session/', '/pro/tg-session/a/b.js', '/pro/auth/google/callback',
    '/apps/demo/', '/apps/demo/app.html',
  ]) assert.strictEqual(ex(ok), true, ok);
  for (const bad of [
    '/pro/tg-session/../../index.html', '/pro/tg-session/./a', '/pro/tg-session/..',
    '/pro/tg-session/%2e%2e/%2e%2e/index.html', '/pro/tg-session/%2E%2E/index.html',
    '/pro/tg-session/.%2e/index.html', '/pro/tg-session/%2e./index.html', '/pro/tg-session/%2e/a',
    '/pro/tg-session/..%2f..%2findex.html', '/pro/tg-session/a%2f..%2f..%2findex.html',
    '/pro/tg-session//a', '/pro/tg-session/%',
    '/apps/demo/../../index.html', '/apps/demo/%2e%2e/x',
  ]) assert.strictEqual(ex(bad), false, bad);
});

test('http: /pro/tg-session/../../index.html (raw and %2e) without credentials is not served', async (t) => {
  const s = await startApp(t);
  const normal = await request(s.port, { path: '/pro/tg-session/page.txt' });
  assert.strictEqual(normal.status, 200);
  assert.strictEqual(normal.body, 'EXEMPT-PAGE', 'a normal exempt path still passes');

  for (const p of [
    '/pro/tg-session/../../index.html',
    '/pro/tg-session/%2e%2e/%2e%2e/index.html',
    '/pro/tg-session/%2E%2E/%2E%2E/index.html',
    '/pro/tg-session/.%2e/.%2e/index.html',
    '/apps/demo/../../index.html',
  ]) {
    const r = await request(s.port, { path: p });
    assert.ok(!r.body.includes('OWNER-INDEX'), `${p} served the owner page`);
    assert.strictEqual(r.status, 302, p);
    assert.strictEqual(r.headers.location, '/login', p);
  }
  // The owner still reaches those shapes through the normal gate.
  const owner = await request(s.port, { path: '/pro/tg-session/../../index.html', headers: bearer });
  assert.strictEqual(owner.status, 200);
});

// ── 5. rescue page: no CDN ──────────────────────────────────────────────

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

test('rescue page loads xterm from the repo copy, with no third-party script or stylesheet', async (t) => {
  const home = fs.mkdtempSync(path.join(HOME, 'sup-'));
  const ctrl = path.join(home, 'ctrl');
  fs.writeFileSync(ctrl, 'crash');
  fs.writeFileSync(path.join(home, 'spawns'), '');
  const port = await freePort();
  const env = {
    ...process.env,
    VISTACLAIR_SUPERVISOR_CHILD: path.join(__dirname, 'fixtures', 'supervisor-child.js'), VISTACLAIR_HOME: home,
    DASHBOARD_PORT: String(port), DASHBOARD_HOST: '127.0.0.1', AUTH_TOKEN: TOKEN,
    VISTACLAIR_BOOT_TIMEOUT_MS: '3000', VISTACLAIR_HEALTH_INTERVAL_MS: '300', VISTACLAIR_KILL_GRACE_MS: '500',
    FAKE_CTRL: ctrl, FAKE_SPAWNS: path.join(home, 'spawns'),
  };
  delete env.VISTACLAIR_SERVER; delete env.VISTACLAIR_SUPERVISED; delete env.VISTA_SECRETS_KEY;
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'supervisor.js')], { cwd: home, env, stdio: 'ignore' });
  t.after(async () => {
    proc.kill('SIGTERM');
    await new Promise(r => { proc.once('exit', r); setTimeout(() => { proc.kill('SIGKILL'); r(); }, 3000); });
    fs.rmSync(home, { recursive: true, force: true });
  });
  let page;
  for (let i = 0; i < 100; i++) {
    const ping = await request(port, { path: '/api/ping' }).catch(() => null);
    if (ping && ping.status === 503) {
      page = await request(port, { path: '/', headers: cookieToken });
      break;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(page && page.status === 200, 'rescue page served');
  const refs = [...page.body.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g)].map(m => m[1]);
  assert.ok(refs.length >= 3, 'xterm css, xterm js, fit addon');
  for (const ref of refs) {
    assert.ok(ref.startsWith('/'), `no third-party load: ${ref}`);
    const asset = await request(port, { path: ref, headers: cookieToken });
    assert.strictEqual(asset.status, 200, ref);
    assert.ok(asset.body.length > 1000, ref);
  }
  const vendor = path.join(__dirname, '..', 'public', 'vendor');
  const js = refs.find(r => r.endsWith('xterm.js'));
  assert.strictEqual((await request(port, { path: js, headers: cookieToken })).body, fs.readFileSync(path.join(vendor, 'xterm-5.5.0', 'xterm.js'), 'utf8'));
  // Assets sit behind the same owner gate as the page.
  assert.strictEqual((await request(port, { path: js })).status, 401);
});
