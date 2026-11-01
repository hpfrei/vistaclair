// Dashboard login (src/login.js, src/login-routes.js, src/auth.js): the
// challenge lifecycle, the long-poll route, onLogin, login providers, the
// static token from external callers, old sessions.json entries, and the
// addon ctx.login contract. Temp DATA_HOME dirs and ephemeral ports only.
//
//   node --test test/login.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-login-')));
process.env.VISTACLAIR_HOME = HOME;

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { createLogin, MAX_PENDING_CHALLENGES } = require('../src/login');
const { mountLoginRoutes, mountLoginApi } = require('../src/login-routes');
const { createAuth } = require('../src/auth');

const TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex');
const XFF = { 'x-forwarded-for': '203.0.113.7' };
const quiet = { error() {}, log() {} };

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

function tmpHome(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-login-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function clock(start = 1_700_000_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

// The real routes on a throwaway express app, the way server.js mounts them:
// public login routes, then the owner gate, then the owner-only login API.
async function startApp(t, { loginOpts = {}, deps = {} } = {}) {
  const home = tmpHome(t);
  const login = createLogin({ dataHome: home, log: quiet, ...loginOpts });
  const auth = createAuth({ authToken: TOKEN, login });
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  const loginDeps = {
    login, authToken: TOKEN,
    authCookie: (name, value, extra = '') => `${name}=${value}; HttpOnly; SameSite=Lax; Path=/${extra}`,
    authLimiter: (req, res, next) => next(),
    isLoopback: auth.isLoopback, isInternal: auth.isInternal,
    getSidFromCookies: auth.getSidFromCookies, safeEqual: auth.safeEqual,
    publicDir: path.join(__dirname, '..', 'public'),
    ...deps,
  };
  mountLoginRoutes(app, loginDeps);
  app.use((req, res, next) => (auth.isOwnerRequest(req) ? next() : res.status(401).json({ error: 'Unauthorized' })));
  mountLoginApi(app, loginDeps);
  app.get('/api/whoami', (req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeAllConnections?.(); server.close(r); }));
  return { login, home, port: server.address().port };
}

function request(port, { method = 'GET', path: p = '/', headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    let payload = body;
    const h = { ...headers };
    if (body && typeof body === 'object') { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, signal }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function cookieFrom(res, name) {
  for (const c of [].concat(res.headers['set-cookie'] || [])) {
    const m = c.match(new RegExp(`^${name}=([^;]*)`));
    if (m) return m[1];
  }
  return null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- src/login.js: the challenge lifecycle ---

test('challenge: approve → poll redeems a session carrying via/who; single use', (t) => {
  const login = createLogin({ dataHome: tmpHome(t), log: quiet });
  const ch = login.startChallenge({ ip: '10.0.0.1', ua: 'UA/1' });
  assert.match(ch.code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.match(ch.nonce, /^[0-9a-f]{32}$/);
  assert.strictEqual(ch.expiresInMs, 2 * 60 * 1000);

  const d = login.describe(ch.code);
  assert.deepStrictEqual(Object.keys(d).sort(), ['code', 'createdAt', 'expiresAt', 'ip', 'status', 'ua']);
  assert.strictEqual(d.status, 'pending');
  assert.strictEqual(d.ip, '10.0.0.1');
  assert.strictEqual(d.expiresAt - d.createdAt, 2 * 60 * 1000);
  assert.strictEqual(login.describe(ch.code.toLowerCase()).code, ch.code, 'codes match case-insensitively');
  assert.strictEqual(login.pollChallenge(ch.nonce), 'pending');

  assert.deepStrictEqual(login.approve(ch.code, { via: 'telegram-qr', who: 'x'.repeat(150) }), { ok: true });
  assert.strictEqual(login.describe(ch.code).status, 'approved');
  assert.deepStrictEqual(login.approve(ch.code, { via: 'telegram-qr' }), { ok: false, reason: 'used' });

  const r = login.pollChallenge(ch.nonce);
  assert.ok(r.sid && r.sessionId);
  const s = login.getSession(r.sid);
  assert.strictEqual(s.id, r.sessionId);
  assert.strictEqual(s.via, 'telegram-qr');
  assert.strictEqual(s.who, 'x'.repeat(100), 'who truncated to 100 chars');
  assert.strictEqual(s.ip, '10.0.0.1');

  // Consumed: the nonce, the code and a second approval are all spent.
  assert.strictEqual(login.pollChallenge(ch.nonce), 'expired');
  assert.strictEqual(login.describe(ch.code), null);
  assert.deepStrictEqual(login.approve(ch.code, { via: 'telegram-qr' }), { ok: false, reason: 'used' });
  assert.deepStrictEqual(login.approve('ZZZZZZZZ', { via: 'telegram-qr' }), { ok: false, reason: 'unknown' });
});

test('challenge: deny → poll answers denied; approve after deny refused', (t) => {
  const login = createLogin({ dataHome: tmpHome(t), log: quiet });
  const ch = login.startChallenge({});
  assert.strictEqual(login.deny(ch.code), true);
  assert.strictEqual(login.deny(ch.code), false, 'already denied');
  assert.strictEqual(login.describe(ch.code).status, 'denied');
  assert.strictEqual(login.pollChallenge(ch.nonce), 'denied');
  assert.strictEqual(login.pollChallenge(ch.nonce), 'denied');
  assert.deepStrictEqual(login.approve(ch.code, { via: 'x' }), { ok: false, reason: 'denied' });
  assert.strictEqual(login.deny('NOPE2345'), false);
});

test('challenge: expires after 2 minutes (injected clock)', (t) => {
  const c = clock();
  const login = createLogin({ dataHome: tmpHome(t), log: quiet, now: c.now });
  const ch = login.startChallenge({});
  c.t += 2 * 60 * 1000 - 1;
  assert.strictEqual(login.pollChallenge(ch.nonce), 'pending');
  c.t += 1;
  assert.strictEqual(login.pollChallenge(ch.nonce), 'expired');
  assert.strictEqual(login.describe(ch.code), null);
  assert.deepStrictEqual(login.approve(ch.code, { via: 'x' }), { ok: false, reason: 'expired' });
  assert.strictEqual(login.deny(ch.code), false);

  // An approved challenge that is not redeemed in time expires too.
  const ch2 = login.startChallenge({});
  login.approve(ch2.code, { via: 'x' });
  c.t += 2 * 60 * 1000;
  assert.strictEqual(login.pollChallenge(ch2.nonce), 'expired');
});

test('challenge: replaces deletes the previous challenge', (t) => {
  const login = createLogin({ dataHome: tmpHome(t), log: quiet });
  const a = login.startChallenge({});
  const b = login.startChallenge({ replaces: a.nonce });
  assert.notStrictEqual(a.code, b.code);
  assert.strictEqual(login.pollChallenge(a.nonce), 'expired');
  assert.strictEqual(login.describe(a.code), null);
  assert.deepStrictEqual(login.approve(a.code, { via: 'x' }), { ok: false, reason: 'expired' });
  assert.strictEqual(login.describe(b.code).status, 'pending');
  // An unknown `replaces` is ignored.
  assert.ok(login.startChallenge({ replaces: 'f'.repeat(32) }));
});

test('challenge: at most 50 pending; replacing at the cap still works', (t) => {
  const login = createLogin({ dataHome: tmpHome(t), log: quiet });
  const all = [];
  for (let i = 0; i < MAX_PENDING_CHALLENGES; i++) all.push(login.startChallenge({}));
  assert.strictEqual(MAX_PENDING_CHALLENGES, 50);
  assert.ok(all.every(Boolean));
  assert.strictEqual(new Set(all.map(c => c.code)).size, 50, 'codes unique');
  assert.strictEqual(login.startChallenge({}), null);
  assert.ok(login.startChallenge({ replaces: all[0].nonce }), 'rotation frees its own slot');
  assert.strictEqual(login.startChallenge({}), null);
});

test('approve: invalid via throws', (t) => {
  const login = createLogin({ dataHome: tmpHome(t), log: quiet });
  const ch = login.startChallenge({});
  for (const via of [undefined, '', 'Telegram', 'a_b', 'x'.repeat(33)]) {
    assert.throws(() => login.approve(ch.code, { via }), TypeError);
  }
  assert.strictEqual(login.describe(ch.code).status, 'pending');
});

test('old-format sessions.json entries still validate', (t) => {
  const home = tmpHome(t);
  const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
  const sidA = crypto.randomBytes(32).toString('hex');
  const sidB = crypto.randomBytes(32).toString('hex');
  const sidOld = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify([
    { id: 'aaaaaaaaaaaa', sidHash: sha(sidA), createdAt: now - 1000, expiresAt: now + 86400000, ip: '1.2.3.4', ua: 'UA', via: 'telegram' },
    { id: 'bbbbbbbbbbbb', sidHash: sha(sidB), createdAt: now - 1000, expiresAt: now + 86400000 },
    { id: 'cccccccccccc', sidHash: sha(sidOld), createdAt: 0, expiresAt: now - 1 },
  ], null, 2));
  const login = createLogin({ dataHome: home, log: quiet });
  assert.strictEqual(login.getSession(sidA).id, 'aaaaaaaaaaaa');
  assert.strictEqual(login.getSession(sidB).id, 'bbbbbbbbbbbb');
  assert.strictEqual(login.getSession(sidOld), null);
  const list = login.api.listSessions();
  assert.deepStrictEqual(list.map(s => [s.id, s.via, s.who]), [['aaaaaaaaaaaa', 'telegram', null], ['bbbbbbbbbbbb', null, null]]);
  assert.deepStrictEqual(Object.keys(list[0]).sort(), ['createdAt', 'expiresAt', 'id', 'ip', 'ua', 'via', 'who']);
  // A new session keeps the same on-disk format, plus via/who.
  login.createSession({ via: 'login-link' });
  const disk = JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'), 'utf-8'));
  assert.strictEqual(disk.length, 3);
  assert.deepStrictEqual(Object.keys(disk[2]).sort(), ['createdAt', 'expiresAt', 'id', 'ip', 'sidHash', 'ua', 'via', 'who']);
});

test('api: listSessions / revokeSession / revokeAll', (t) => {
  const login = createLogin({ dataHome: tmpHome(t), log: quiet });
  const a = login.createSession({ via: 'token' });
  const b = login.createSession({ via: 'x', who: 'w' });
  assert.strictEqual(login.api.listSessions().length, 2);
  assert.strictEqual(login.api.revokeSession(a.sessionId), true);
  assert.strictEqual(login.api.revokeSession(a.sessionId), false);
  assert.strictEqual(login.getSession(a.sid), null);
  assert.ok(login.getSession(b.sid));
  login.api.revokeAll();
  assert.deepStrictEqual(login.api.listSessions(), []);
});

// --- Routes ---

test('long poll resolves as soon as the code is approved; the sid then authenticates', async (t) => {
  const { login, port } = await startApp(t);
  const start = await request(port, { method: 'POST', path: '/login/challenge/start', body: {}, headers: { 'user-agent': 'Browser/1' } });
  assert.strictEqual(start.status, 200);
  const { nonce, code, expiresInMs, providers } = start.json;
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.strictEqual(expiresInMs, 120000);
  assert.deepStrictEqual(providers, []);

  const t0 = Date.now();
  const poll = request(port, { method: 'POST', path: '/login/challenge/poll', body: { nonce } });
  await sleep(150);
  assert.strictEqual(login.describe(code).ua, 'Browser/1');
  login.approve(code, { via: 'telegram-qr', who: 'Owner (@owner)' });
  const res = await poll;
  const took = Date.now() - t0;
  assert.deepStrictEqual(res.json, { status: 'ok' });
  assert.ok(took < 3000, `resolved in ${took} ms`);
  assert.ok(took >= 140, 'was held until the approval');
  const sid = cookieFrom(res, 'sid');
  assert.match(sid, /^[0-9a-f]{64}$/);

  assert.strictEqual((await request(port, { path: '/api/whoami' })).status, 401);
  assert.strictEqual((await request(port, { path: '/api/whoami', headers: { cookie: `sid=${sid}`, ...XFF } })).status, 200);
  const sessions = await request(port, { path: '/api/sessions', headers: { cookie: `sid=${sid}` } });
  assert.strictEqual(sessions.json.sessions.length, 1);
  const [s] = sessions.json.sessions;
  assert.strictEqual(s.via, 'telegram-qr');
  assert.strictEqual(s.who, 'Owner (@owner)');
  assert.strictEqual(s.current, true);

  // Single use over HTTP too.
  assert.deepStrictEqual((await request(port, { method: 'POST', path: '/login/challenge/poll', body: { nonce } })).json, { status: 'expired' });
});

test('long poll: deny answers early; expiry answers expired; bad nonce is expired', async (t) => {
  const { login, port } = await startApp(t, { loginOpts: { challengeTtlMs: 400 } });
  const a = (await request(port, { method: 'POST', path: '/login/challenge/start', body: {} })).json;
  const pollA = request(port, { method: 'POST', path: '/login/challenge/poll', body: { nonce: a.nonce } });
  await sleep(100);
  login.deny(a.code);
  assert.deepStrictEqual((await pollA).json, { status: 'denied' });

  const b = (await request(port, { method: 'POST', path: '/login/challenge/start', body: {} })).json;
  const t0 = Date.now();
  const res = await request(port, { method: 'POST', path: '/login/challenge/poll', body: { nonce: b.nonce } });
  assert.deepStrictEqual(res.json, { status: 'expired' });
  assert.ok(Date.now() - t0 < 2000, 'answered at the challenge expiry, not the 25 s hold');

  assert.deepStrictEqual((await request(port, { method: 'POST', path: '/login/challenge/poll', body: { nonce: 'nope' } })).json, { status: 'expired' });
  assert.deepStrictEqual((await request(port, { method: 'POST', path: '/login/challenge/poll', body: {} })).json, { status: 'expired' });
});

test('long poll: a replaced challenge releases its held poll as expired', async (t) => {
  const { port } = await startApp(t);
  const a = (await request(port, { method: 'POST', path: '/login/challenge/start', body: {} })).json;
  const pollA = request(port, { method: 'POST', path: '/login/challenge/poll', body: { nonce: a.nonce } });
  await sleep(100);
  const b = (await request(port, { method: 'POST', path: '/login/challenge/start', body: { replaces: a.nonce } })).json;
  assert.ok(b.nonce && b.nonce !== a.nonce);
  assert.deepStrictEqual((await pollA).json, { status: 'expired' });
});

test('long poll: the hold ends with pending; held polls are capped; a disconnect frees its slot', async (t) => {
  const { login, port } = await startApp(t, { deps: { pollHoldMs: 300, maxHeldPolls: 1 } });
  const a = (await request(port, { method: 'POST', path: '/login/challenge/start', body: {} })).json;
  let t0 = Date.now();
  assert.deepStrictEqual((await request(port, { method: 'POST', path: '/login/challenge/poll', body: { nonce: a.nonce } })).json, { status: 'pending' });
  assert.ok(Date.now() - t0 >= 280, 'held for the hold time');

  // One held poll; the next answers pending at once.
  const ctrl = new AbortController();
  const held = request(port, { method: 'POST', path: '/login/challenge/poll', body: { nonce: a.nonce }, signal: ctrl.signal }).catch(e => e);
  await sleep(50);
  t0 = Date.now();
  assert.deepStrictEqual((await request(port, { method: 'POST', path: '/login/challenge/poll', body: { nonce: a.nonce } })).json, { status: 'pending' });
  assert.ok(Date.now() - t0 < 200, 'over the cap: immediate');

  // The held client goes away: its slot is free again.
  ctrl.abort();
  await held;
  await sleep(50);
  const next = request(port, { method: 'POST', path: '/login/challenge/poll', body: { nonce: a.nonce } });
  await sleep(50);
  login.approve(a.code, { via: 'test' });
  assert.deepStrictEqual((await next).json, { status: 'ok' }, 'held (not the over-cap pending)');
});

test('providers: registered list, ready links only, QR SVG, unregister, invalid id', async (t) => {
  const { login, port } = await startApp(t);
  const api = login.api;
  assert.deepStrictEqual((await request(port, { path: '/login/challenge/info' })).json, { providers: [], tokenLogin: true });

  const seen = [];
  const offQr = api.registerProvider({ id: 'telegram-qr', label: 'Telegram', link: (code) => { seen.push(code); return `https://t.me/somebot?start=${code}`; } });
  const offNull = api.registerProvider({ id: 'not-ready', label: 'Not ready', link: () => null });
  const offThrow = api.registerProvider({ id: 'broken', label: 'Broken', link: () => { throw new Error('boom'); } });
  const offHttp = api.registerProvider({ id: 'plain-http', label: 'HTTP', link: () => 'http://example.com/x' });
  assert.throws(() => api.registerProvider({ id: 'Bad_Id', label: 'x', link: () => null }), TypeError);
  assert.throws(() => api.registerProvider({ id: 'x'.repeat(33), label: 'x', link: () => null }), TypeError);
  assert.throws(() => api.registerProvider({ id: '', label: 'x', link: () => null }), TypeError);

  const info = (await request(port, { path: '/login/challenge/info' })).json;
  assert.deepStrictEqual(info, {
    providers: [{ id: 'telegram-qr', label: 'Telegram' }, { id: 'not-ready', label: 'Not ready' }, { id: 'broken', label: 'Broken' }, { id: 'plain-http', label: 'HTTP' }],
    tokenLogin: true,
  });

  const start = (await request(port, { method: 'POST', path: '/login/challenge/start', body: {} })).json;
  assert.deepStrictEqual(seen, [start.code], 'link() gets the challenge code');
  assert.strictEqual(start.providers.length, 1);
  const [p] = start.providers;
  assert.deepStrictEqual(Object.keys(p).sort(), ['id', 'label', 'link', 'qrSvg']);
  assert.strictEqual(p.id, 'telegram-qr');
  assert.strictEqual(p.label, 'Telegram');
  assert.strictEqual(p.link, `https://t.me/somebot?start=${start.code}`);
  assert.match(p.qrSvg, /^<svg[\s>]/);
  assert.match(p.qrSvg, /<\/svg>\s*$/);

  offQr(); offNull(); offThrow(); offHttp();
  offQr(); // idempotent
  assert.deepStrictEqual((await request(port, { path: '/login/challenge/info' })).json.providers, []);
  const again = (await request(port, { method: 'POST', path: '/login/challenge/start', body: { replaces: start.nonce } })).json;
  assert.deepStrictEqual(again.providers, []);
});

test('challenge/start answers 429 at the pending cap', async (t) => {
  const { port } = await startApp(t);
  for (let i = 0; i < MAX_PENDING_CHALLENGES; i++) {
    assert.strictEqual((await request(port, { method: 'POST', path: '/login/challenge/start', body: {} })).status, 200);
  }
  const r = await request(port, { method: 'POST', path: '/login/challenge/start', body: {} });
  assert.strictEqual(r.status, 429);
});

test('static token from an external caller: cookie, Bearer and the login form', async (t) => {
  const { port } = await startApp(t);
  assert.strictEqual((await request(port, { path: '/api/whoami', headers: { cookie: `token=${TOKEN}`, ...XFF } })).status, 200);
  assert.strictEqual((await request(port, { path: '/api/whoami', headers: { authorization: `Bearer ${TOKEN}`, ...XFF } })).status, 200);
  assert.strictEqual((await request(port, { path: '/api/whoami', headers: { authorization: 'Bearer wrong', ...XFF } })).status, 401);
  assert.strictEqual((await request(port, { path: '/api/whoami', headers: { cookie: 'token=wrong', ...XFF } })).status, 401);

  const form = { 'content-type': 'application/x-www-form-urlencoded', ...XFF };
  const ok = await request(port, { method: 'POST', path: '/login', headers: form, body: `token=${encodeURIComponent(TOKEN)}` });
  assert.strictEqual(ok.status, 302);
  assert.strictEqual(ok.headers.location, '/');
  assert.strictEqual(cookieFrom(ok, 'token'), TOKEN);
  const bad = await request(port, { method: 'POST', path: '/login', headers: form, body: 'token=nope' });
  assert.strictEqual(bad.headers.location, '/login?error=1');

  // /login/auto stays host-only.
  const auto = await request(port, { path: `/login/auto?token=${TOKEN}`, headers: XFF });
  assert.strictEqual(auto.headers.location, '/login');
});

test('onLogin fires for token, login-link and challenge logins with the right fields', async (t) => {
  const { login, port } = await startApp(t);
  const events = [];
  const off = login.api.onLogin((e) => { events.push(e); });
  login.api.onLogin(() => { throw new Error('listener bug'); });
  login.api.onLogin(async () => { throw new Error('async listener bug'); });

  const form = { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Form/1' };
  assert.strictEqual((await request(port, { method: 'POST', path: '/login', headers: form, body: `token=${TOKEN}` })).headers.location, '/');
  assert.strictEqual((await request(port, { method: 'POST', path: '/login', headers: { ...form, ...XFF }, body: `token=${TOKEN}` })).headers.location, '/');
  assert.strictEqual((await request(port, { path: `/login/auto?token=${TOKEN}` })).headers.location, '/');
  await request(port, { method: 'POST', path: '/login', headers: form, body: 'token=wrong' });

  // Login link: minted host-locally with the internal header, redeemed externally.
  assert.strictEqual((await request(port, { method: 'POST', path: '/api/login/login-link', headers: { cookie: `token=${TOKEN}` } })).status, 403);
  const link = await request(port, { method: 'POST', path: '/api/login/login-link', headers: { 'x-vistaclair-internal': TOKEN } });
  assert.strictEqual(link.json.expiresInMs, 5 * 60 * 1000);
  assert.match(link.json.path, /^\/login\/once\?k=[0-9a-f]{64}$/);
  const once = await request(port, { path: link.json.path, headers: XFF });
  assert.strictEqual(once.headers.location, '/');
  const linkSid = cookieFrom(once, 'sid');
  assert.strictEqual((await request(port, { path: link.json.path })).headers.location, '/login', 'single use');

  // Challenge.
  const ch = (await request(port, { method: 'POST', path: '/login/challenge/start', body: {}, headers: XFF })).json;
  login.approve(ch.code, { via: 'telegram-qr', who: 'Owner' });
  const poll = await request(port, { method: 'POST', path: '/login/challenge/poll', body: { nonce: ch.nonce }, headers: XFF });
  assert.deepStrictEqual(poll.json, { status: 'ok' });
  const chSid = cookieFrom(poll, 'sid');

  assert.deepStrictEqual(events.map(e => Object.keys(e).sort()), events.map(() => ['code', 'external', 'ip', 'sessionId', 'ua', 'via']));
  assert.deepStrictEqual(events.map(e => [e.via, e.external, e.sessionId, e.code]), [
    ['token', false, null, null],
    ['token', true, null, null],
    ['token', false, null, null],
    ['login-link', true, login.getSession(linkSid).id, null],
    ['telegram-qr', true, login.getSession(chSid).id, ch.code],
  ]);
  assert.strictEqual(events[0].ua, 'Form/1');
  assert.strictEqual(events[1].ip, '203.0.113.7', 'ip honours the loopback proxy');
  assert.strictEqual(login.getSession(linkSid).via, 'login-link');

  off();
  await request(port, { method: 'POST', path: '/login', headers: form, body: `token=${TOKEN}` });
  assert.strictEqual(events.length, 5, 'unsubscribed');
});

test('session API: logout revokes the caller, revoke one, revoke all but current', async (t) => {
  const { login, port } = await startApp(t);
  const a = login.createSession({ via: 'x' });
  const b = login.createSession({ via: 'y', who: 'B' });
  const c = login.createSession({ via: 'z' });
  const asA = { cookie: `sid=${a.sid}` };
  const list = (await request(port, { path: '/api/sessions', headers: asA })).json.sessions;
  assert.deepStrictEqual(list.map(s => [s.via, s.who, s.current]), [['x', null, true], ['y', 'B', false], ['z', null, false]]);
  assert.deepStrictEqual((await request(port, { method: 'DELETE', path: `/api/sessions/${b.sessionId}`, headers: asA })).json, { ok: true });
  assert.strictEqual(login.getSession(b.sid), null);
  await request(port, { method: 'DELETE', path: '/api/sessions', headers: asA });
  assert.strictEqual(login.getSession(c.sid), null);
  assert.ok(login.getSession(a.sid));
  const out = await request(port, { method: 'POST', path: '/api/logout', headers: asA });
  assert.deepStrictEqual(out.json, { ok: true });
  assert.strictEqual(login.getSession(a.sid), null);
});

// --- The addon ctx contract ---

test('ctx.login: exact shape in the dashboard profile, absent headless', (t) => {
  const { createAddonCtx } = require('../src/addon-host');
  const login = createLogin({ dataHome: tmpHome(t), log: quiet });
  const ctx = createAddonCtx({ dataHome: HOME, dashboard: { broadcaster: { broadcast() {} }, store: {}, cliSessionManager: {}, login: login.api } });
  assert.deepStrictEqual(Object.keys(ctx.login).sort(), ['approve', 'deny', 'describe', 'listSessions', 'onLogin', 'registerProvider', 'revokeAll', 'revokeSession']);
  assert.ok(Object.isFrozen(ctx.login));
  assert.strictEqual(ctx.tgLoginConfigured, undefined);
  const headless = createAddonCtx({ dataHome: HOME });
  assert.strictEqual('login' in headless, false);
  assert.strictEqual(headless.tgLoginConfigured, undefined);

  // End to end through the ctx: provider → challenge → approve → redeem.
  const off = ctx.login.registerProvider({ id: 'p1', label: 'P1', link: (code) => `https://x.test/${code}` });
  assert.strictEqual(typeof off, 'function');
  const ch = login.startChallenge({ ip: '1.1.1.1', ua: 'U' });
  assert.strictEqual(ctx.login.describe(ch.code).status, 'pending');
  assert.deepStrictEqual(ctx.login.approve(ch.code, { via: 'p1', who: 'me' }), { ok: true });
  const r = login.pollChallenge(ch.nonce);
  assert.deepStrictEqual(ctx.login.listSessions().map(s => [s.id, s.via, s.who, s.ip]), [[r.sessionId, 'p1', 'me', '1.1.1.1']]);
  assert.strictEqual(ctx.login.revokeSession(r.sessionId), true);
  ctx.login.revokeAll();
  off();
});
