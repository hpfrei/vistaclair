// The one Mini App auth implementation.
//
// This subtree is auth-EXEMPT — Telegram's webview carries no owner cookie —
// so these checks ARE the perimeter. Two properties matter beyond "a good
// signature works": a bearer minted for one Mini App must not authenticate the
// other (they expose different authorities), and the two apps must not share a
// header or storage key, since both are global to the origin.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const telegram = require('../src/apps/telegram');
const miniAppAuth = require('../src/apps/tg-miniapp-auth');

const BOT_TOKEN = '123456:AAHfake-bot-token-for-tests';
const KEY = '__platform__';
const OWNER = { id: 4242, first_name: 'HP' };
const STRANGER = { id: 9999, first_name: 'Mallory' };

// telegram's exports are a plain object and app-identity resolves the token at
// CALL time, so patching here is enough — no bot state is written to disk.
let allowed = [OWNER.id];
let restricted = true;
telegram.getToken = () => BOT_TOKEN;
telegram.getBot = () => ({ restricted });
telegram.isAllowed = (_key, id) => allowed.includes(Number(id));

// Build initData exactly as Telegram does: HMAC-SHA256 over the sorted
// data-check string, keyed by HMAC('WebAppData', botToken).
function makeInitData({ user = OWNER, authDate = Math.floor(Date.now() / 1000), token = BOT_TOKEN, corrupt = false } = {}) {
  const params = new URLSearchParams();
  params.set('user', JSON.stringify(user));
  params.set('auth_date', String(authDate));
  const pairs = [];
  for (const [k, v] of params) pairs.push(`${k}=${v}`);
  pairs.sort();
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  params.set('hash', corrupt ? hash.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) : hash);
  return params.toString();
}

function fakeRouter() {
  const routes = new Map();
  return {
    routes,
    post: (p, h) => routes.set(`POST ${p}`, h),
    get: (p, h) => routes.set(`GET ${p}`, h),
  };
}

function fakeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function callAuth(router, base, initData) {
  const res = fakeRes();
  await router.routes.get(`POST ${base}/auth`)({ body: { initData }, headers: {} }, res);
  return res;
}

function mount(base, header) {
  const router = fakeRouter();
  const guards = miniAppAuth.mountAuth(router, base, { key: KEY, header });
  return { router, guards };
}

test.beforeEach(() => { allowed = [OWNER.id]; restricted = true; });

// --- the exchange -------------------------------------------------------------

test('a valid initData from an allowlisted owner mints a bearer', async () => {
  const { router } = mount('/pro/vista/api', 'X-Vista-Session');
  const res = await callAuth(router, '/pro/vista/api', makeInitData());
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token, 'no token issued');
  assert.match(res.body.token, /^[0-9a-f]{48}$/, 'the bearer must be opaque random hex');
});

test('a tampered hash is refused', async () => {
  const { router } = mount('/pro/vista/api', 'X-Vista-Session');
  const res = await callAuth(router, '/pro/vista/api', makeInitData({ corrupt: true }));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.token, undefined);
});

test('initData signed with a different bot token is refused', async () => {
  const { router } = mount('/pro/vista/api', 'X-Vista-Session');
  const res = await callAuth(router, '/pro/vista/api', makeInitData({ token: '999:other-bot' }));
  assert.equal(res.statusCode, 401);
});

test('a stale auth_date is refused even with a perfect signature', async () => {
  const { router } = mount('/pro/vista/api', 'X-Vista-Session');
  // 25 h old — the signature is valid, the freshness window is not.
  const old = Math.floor(Date.now() / 1000) - 25 * 60 * 60;
  const res = await callAuth(router, '/pro/vista/api', makeInitData({ authDate: old }));
  assert.equal(res.statusCode, 401);
});

test('a correctly-signed non-allowlisted user gets 403, not a token', async () => {
  const { router } = mount('/pro/vista/api', 'X-Vista-Session');
  const res = await callAuth(router, '/pro/vista/api', makeInitData({ user: STRANGER }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.token, undefined);
});

test('an unrestricted bot has no Mini App at all', async () => {
  restricted = false;
  const { router } = mount('/pro/vista/api', 'X-Vista-Session');
  const res = await callAuth(router, '/pro/vista/api', makeInitData());
  assert.equal(res.statusCode, 403);
});

// --- the bearer ---------------------------------------------------------------

test('authed() admits a minted bearer and refuses everything else', async () => {
  const base = '/pro/vista/api';
  const { router, guards } = mount(base, 'X-Vista-Session');
  const token = (await callAuth(router, base, makeInitData())).body.token;

  const handler = guards.authed(async (req, res, rec) => res.json({ ok: true, chatId: rec.chatId }));

  const good = fakeRes();
  await handler({ headers: { 'x-vista-session': token }, body: {} }, good);
  assert.equal(good.statusCode, 200);
  // For the control bot the chat id IS the user id (a private chat).
  assert.equal(good.body.chatId, OWNER.id);

  for (const headers of [{}, { 'x-vista-session': 'not-a-token' }, { 'x-tg-session': token }]) {
    const res = fakeRes();
    await handler({ headers, body: {} }, res);
    assert.equal(res.statusCode, 401, `admitted a request with headers ${JSON.stringify(headers)}`);
  }
});

test('an expired bearer is refused and forgotten', async () => {
  const base = '/pro/vista/api';
  const router = fakeRouter();
  // A TTL in the past: the bearer is stale the instant it is minted, so the
  // 401 below can only come from expiry — this must be ONE mount, or the
  // refusal would really be cross-app token isolation passing for the wrong
  // reason.
  const guards = miniAppAuth.mountAuth(router, base, { key: KEY, header: 'X-Vista-Session', ttlMs: -1 });
  const token = (await callAuth(router, base, makeInitData())).body.token;
  const res = fakeRes();
  await guards.authed(async (_req, r) => r.json({ ok: true }))({ headers: { 'x-vista-session': token }, body: {} }, res);
  assert.equal(res.statusCode, 401);
});

test('a handler that throws becomes a 400, never an unhandled rejection', async () => {
  const base = '/pro/vista/api';
  const { router, guards } = mount(base, 'X-Vista-Session');
  const token = (await callAuth(router, base, makeInitData())).body.token;
  const res = fakeRes();
  await guards.authed(async () => { throw new Error('kaboom'); })({ headers: { 'x-vista-session': token }, body: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'kaboom');
});

// --- the two-Mini-App collision ----------------------------------------------

test('a bearer for one Mini App does NOT authenticate the other', async () => {
  const vista = mount('/pro/vista/api', 'X-Vista-Session');
  const session = mount('/pro/tg-session/api', 'X-TG-Session');
  const vistaToken = (await callAuth(vista.router, '/pro/vista/api', makeInitData())).body.token;

  // Same user, same bot, but a different app: the token must not carry across.
  const res = fakeRes();
  await session.guards.authed(async (_req, r) => r.json({ ok: true }))(
    { headers: { 'x-tg-session': vistaToken }, body: {} }, res,
  );
  assert.equal(res.statusCode, 401, 'a token minted for Vista authenticated the CLI session app');
});

test('the two Mini Apps declare distinct header and storage names', () => {
  const fs = require('fs');
  const path = require('path');
  const miniapp = require('../src/apps/platform-miniapp');
  const tgSessionSrc = fs.readFileSync(path.join(__dirname, '../src/apps/platform-tg-session.js'), 'utf8');
  const vistaSrc = fs.readFileSync(path.join(__dirname, '../public/vista/vista.js'), 'utf8');
  const sessionClientSrc = fs.readFileSync(path.join(__dirname, '../public/tg-session/tg-session.js'), 'utf8');

  assert.equal(miniapp.SESSION_HEADER, 'X-Vista-Session');
  assert.match(tgSessionSrc, /SESSION_HEADER = 'X-TG-Session'/);
  assert.notEqual(miniapp.SESSION_HEADER, 'X-TG-Session');

  // sessionStorage is global to the origin and both apps live under /pro/*, so
  // a shared key would have them overwrite each other's bearer.
  assert.match(vistaSrc, /storageKey: 'vcVistaToken'/);
  assert.match(sessionClientSrc, /storageKey: 'vcTgToken'/);
  assert.match(sessionClientSrc, /header: 'X-TG-Session'/);
});
