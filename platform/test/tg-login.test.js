// Dashboard QR login through the control bot (platform-login.js, core's
// ctx.login). What must hold: the deep link exists only when the claimed,
// restricted bot knows its owner and its own username; only the OWNER in their
// private chat can approve or refuse a login; a `/start login_` message never
// claims a bot and earns strangers no reply; core's onLogin turns the card
// into a log-out button; token logins from outside the host are announced;
// with no ctx.login nothing of this exists.
// Real telegram.js dispatch over a temp config, stubbed Bot API, fake ctx.login.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const telegram = require('../src/apps/telegram');
const platformTelegram = require('../src/apps/platform-telegram');
const platformLogin = require('../src/apps/platform-login');

const KEY = '__platform__';
const OWNER = 111;
const OTHER = 222;
const GROUP = -100777;
const CODE = 'ABCD2345';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-tglogin-'));
const cfgPath = path.join(dir, '.telegram.enc');
const secretStore = {
  readSecretFile: (p, _d, { fallback }) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } },
  writeSecretFile: (p, obj) => fs.writeFileSync(p, JSON.stringify(obj)),
};
const saved = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8')).apps[KEY];

// --- the Bot API: every outgoing call in order ---------------------------------
const tg = [];
let nextId = 500;
let getMe = { ok: true, result: { username: 'vc_control_bot' } };
telegram.call = async (key, method, params) => {
  if (method === 'getMe') { tg.push({ method }); return getMe; }
  if (method === 'answerCallbackQuery' || method === 'setChatMenuButton' || method === 'sendChatAction') return { ok: true, result: true };
  tg.push({ method, ...params });
  return { ok: true, result: { message_id: nextId++ } };
};
const sends = () => tg.filter((o) => o.method === 'sendMessage');
const edits = () => tg.filter((o) => o.method === 'editMessageText');

// --- core's ctx.login -------------------------------------------------------------
function fakeLogin() {
  const L = {
    providers: [], loginFns: [], calls: [], unregistered: 0,
    challenges: new Map(),
    sessions: [
      { id: 'sess-1', createdAt: Date.now(), expiresAt: Date.now() + 1e6, ip: '203.0.113.5', ua: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0', via: 'telegram-qr', who: '@hp (111)' },
      { id: 'sess-2', createdAt: Date.now(), expiresAt: Date.now() + 1e6, ip: '198.51.100.9', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1', via: 'login-link', who: null },
    ],
    registerProvider(p) { L.providers.push(p); return () => { L.unregistered++; L.providers = L.providers.filter((x) => x !== p); }; },
    describe(code) { return L.challenges.get(code) || null; },
    approve(code, opts) {
      L.calls.push(['approve', code, opts]);
      const c = L.challenges.get(code);
      if (!c) return { ok: false, reason: 'unknown' };
      if (c.status !== 'pending') return { ok: false, reason: c.status === 'denied' ? 'denied' : 'used' };
      c.status = 'approved';
      return { ok: true };
    },
    deny(code) { L.calls.push(['deny', code]); const c = L.challenges.get(code); if (c) c.status = 'denied'; return !!c; },
    listSessions() { return L.sessions.slice(); },
    revokeSession(id) { L.calls.push(['revoke', id]); const n = L.sessions.length; L.sessions = L.sessions.filter((s) => s.id !== id); return L.sessions.length < n; },
    revokeAll() { L.calls.push(['revokeAll']); const n = L.sessions.length; L.sessions = []; return n; },
    onLogin(fn) { L.loginFns.push(fn); return () => { L.loginFns = L.loginFns.filter((f) => f !== fn); }; },
    fire(ev) { for (const f of L.loginFns) f(ev); },
    challenge(code = CODE) {
      L.challenges.set(code, { code, createdAt: new Date(2026, 10, 1, 9, 8, 7).getTime(), expiresAt: Date.now() + 60000, ip: '203.0.113.5', ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', status: 'pending' });
    },
  };
  return L;
}

// A fresh world: the control bot's config on disk, telegram.js reloaded,
// platform-login re-initialised with a fresh fake (or none).
function world(bot, { login = true } = {}) {
  const apps = bot ? { [KEY]: { token: 'tok-1', botId: 9, mode: 'poll', offset: 0, restricted: false, allowedChatIds: [], webhookSecret: 's', addedAt: 1, ...bot } } : {};
  fs.writeFileSync(cfgPath, JSON.stringify({ publicUrl: '', apps }));
  telegram.init(dir, secretStore, { broadcast() {} });
  const L = login ? fakeLogin() : null;
  platformLogin.init({ login: L });
  tg.length = 0;
  return L;
}
const claimed = (extra = {}) => ({ restricted: true, allowedChatIds: [OWNER], ownerUserId: OWNER, botUsername: 'vc_control_bot', ...extra });

const settle = () => new Promise((r) => setTimeout(r, 25));
const user = (id, username = 'hp') => ({ id, is_bot: false, first_name: 'H', username });
const privateMsg = (from, text) => ({ update_id: nextId++, message: { message_id: nextId++, chat: { id: from, type: 'private' }, from: user(from), text } });
const groupMsg = (from, text) => ({ update_id: nextId++, message: { message_id: nextId++, chat: { id: GROUP, type: 'group' }, from: user(from), text } });
const tap = (chat, from, data, messageId) => ({ update_id: nextId++, callback_query: { id: `cq${nextId++}`, from: user(from), data, message: { message_id: messageId, chat } } });
const dispatch = async (u) => { telegram.dispatchUpdate(KEY, u); await settle(); };
const ownerChat = { id: OWNER, type: 'private' };

test.before(() => {
  world(null);
  platformTelegram.init('auth-token', {});
});
test.after(() => {
  platformLogin.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- the link -----------------------------------------------------------------

test('the provider is registered and link() is null until restricted + claimed + owner + username', async () => {
  let L = world(null);
  assert.equal(L.providers.length, 1);
  assert.equal(L.providers[0].id, 'telegram');
  assert.equal(L.providers[0].label, 'Telegram');
  const link = (code = CODE) => L.providers[0].link(code);
  assert.equal(link(), null, 'no bot');

  L = world({ restricted: false, botUsername: 'vc_control_bot' });
  assert.equal(L.providers[0].link(CODE), null, 'unrestricted');

  L = world({ restricted: true, allowedChatIds: [], botUsername: 'vc_control_bot' });
  assert.equal(L.providers[0].link(CODE), null, 'unclaimed');

  L = world({ restricted: true, allowedChatIds: [GROUP], ownerUserId: OWNER, botUsername: 'vc_control_bot' });
  assert.equal(L.providers[0].link(CODE), null, 'claimed by a group: the owner has no private control chat');

  L = world(claimed({ ownerUserId: undefined, allowedChatIds: [GROUP, OWNER] }));
  assert.equal(L.providers[0].link(CODE), null, 'claimed, owner unknown (a group is first, no migration)');

  L = world(claimed({ botUsername: undefined }));
  getMe = { ok: true, result: { username: 'vc_control_bot' } };
  assert.equal(L.providers[0].link(CODE), null, 'username unknown yet');
  await settle();
  assert.deepEqual(tg.filter((o) => o.method === 'getMe').length, 1, 'getMe asked once');
  assert.equal(L.providers[0].link(CODE), `https://t.me/vc_control_bot?start=login_${CODE}`);
  assert.equal(tg.filter((o) => o.method === 'getMe').length, 1, 'cached');

  L = world(claimed());
  assert.equal(L.providers[0].link(CODE), `https://t.me/vc_control_bot?start=login_${CODE}`);
  assert.equal(L.providers[0].link('bad code!'), null, 'a malformed code gets no link');
});

// --- owner identity -------------------------------------------------------------

test('an inbound message never claims the control bot; a claim code does, and sets the owner', async () => {
  world({ restricted: true, allowedChatIds: [] });
  await dispatch(privateMsg(OWNER, 'hello'));
  await dispatch(tap({ id: OTHER, type: 'private' }, OTHER, 'vc_cancel', 1));
  assert.deepEqual(saved().allowedChatIds, []);
  assert.equal(saved().ownerUserId, undefined);

  const { code } = telegram.createClaimCode(KEY);
  await dispatch(privateMsg(OWNER, `/start claim_${code}`));
  assert.deepEqual(saved().allowedChatIds, [OWNER]);
  assert.equal(saved().ownerUserId, OWNER);
  assert.equal(telegram.ownerUserId(KEY), OWNER);

  // Removing the owner's chat leaves the bot unclaimed — it does not re-open a claim.
  telegram.removeAllowedChat(KEY, OWNER);
  assert.equal(saved().ownerUserId, undefined);
  assert.equal(telegram.ownerUserId(KEY), null);
  await dispatch(privateMsg(OTHER, 'hello'));
  assert.deepEqual(saved().allowedChatIds, []);
});

test('migration: a private-chat claim stays the owner (persisted); a group claim is unclaimed', () => {
  world({ restricted: true, allowedChatIds: [OWNER, OTHER] });
  assert.equal(telegram.ownerUserId(KEY), OWNER);
  assert.equal(saved().ownerUserId, OWNER, 'persisted');
  assert.equal(telegram.claimedOwner(KEY), OWNER);

  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  try { world({ restricted: true, allowedChatIds: [GROUP], ownerUserId: OTHER }); } finally { console.warn = warn; }
  assert.equal(telegram.claimedOwner(KEY), null, 'a group-chat claim is unclaimed until re-claimed');
  assert.equal(warned.length, 1);
  assert.match(warned[0], /treating it as unclaimed/);
});

// --- /start login_<code> ----------------------------------------------------------

test("the owner's private /start login_X gets a card; ✅ approves with via telegram-qr", async () => {
  const L = world(claimed());
  L.challenge();
  await dispatch(privateMsg(OWNER, `/start login_${CODE}`));
  assert.equal(sends().length, 1, 'one card, no menu, no Horst turn');
  const card = sends()[0];
  assert.equal(card.chat_id, OWNER);
  assert.match(card.text, /^Log in a browser\? Chrome · Linux · IP 203\.0\.113\.5 · requested 09:08:07\. Only approve if this is the screen in front of you\.$/);
  assert.deepEqual(card.reply_markup.inline_keyboard[0].map((b) => [b.text, b.callback_data]), [
    ['✅ Log in', `vc_login:${CODE}:ok`], ['✖ Not me', `vc_login:${CODE}:no`],
  ]);
  const cardId = nextId - 1;

  tg.length = 0;
  await dispatch(tap(ownerChat, OWNER, `vc_login:${CODE}:ok`, cardId));
  assert.deepEqual(L.calls, [['approve', CODE, { via: 'telegram-qr', who: '@hp (111)' }]]);
  assert.equal(edits().length, 1);
  assert.equal(edits()[0].message_id, cardId);
  assert.equal(edits()[0].text, '✓ Approved — the browser is logging in…');

  // A second tap: core refuses, the card says so.
  tg.length = 0;
  await dispatch(tap(ownerChat, OWNER, `vc_login:${CODE}:ok`, cardId));
  assert.match(edits()[0].text, /^✖ Not logged in: this login code was already used\.$/);
});

test('✖ Not me denies the code and names the IP', async () => {
  const L = world(claimed());
  L.challenge();
  await dispatch(privateMsg(OWNER, `/start login_${CODE}`));
  const cardId = nextId - 1;
  tg.length = 0;
  await dispatch(tap(ownerChat, OWNER, `vc_login:${CODE}:no`, cardId));
  assert.deepEqual(L.calls, [['deny', CODE]]);
  assert.equal(edits()[0].text, '✖ Refused. If you did not open this login page, someone else has it open (IP 203.0.113.5).');
});

test('an expired code earns the owner a hint, nothing else', async () => {
  world(claimed());
  await dispatch(privateMsg(OWNER, '/start login_ZZZZ9999'));
  assert.deepEqual(sends().map((s) => s.text), ['This login code has expired — the page shows a fresh QR.']);
});

test('a non-owner whitelisted chat, a group, an unclaimed and an unrestricted bot: silent drop, no claim', async () => {
  let L = world(claimed({ allowedChatIds: [OWNER, OTHER, GROUP] }));
  L.challenge();
  await dispatch(privateMsg(OTHER, `/start login_${CODE}`));
  await dispatch(groupMsg(OWNER, `/start login_${CODE}`));
  await dispatch(groupMsg(OTHER, `/start login_${CODE}`));
  assert.equal(tg.length, 0, 'no reply to anyone');
  // Taps from them do nothing either (a forwarded card, a crafted callback).
  await dispatch(tap({ id: OTHER, type: 'private' }, OTHER, `vc_login:${CODE}:ok`, 1));
  await dispatch(tap({ id: GROUP, type: 'group' }, OWNER, `vc_login:${CODE}:ok`, 1));
  await dispatch(tap({ id: OWNER, type: 'private' }, OTHER, `vc_login:${CODE}:ok`, 1));
  assert.deepEqual(L.calls, []);
  assert.equal(tg.length, 0);

  L = world({ restricted: true, allowedChatIds: [], botUsername: 'vc_control_bot' });
  L.challenge();
  await dispatch(privateMsg(OWNER, `/start login_${CODE}`));
  await dispatch(privateMsg(OWNER, `/start@vc_control_bot login_${CODE}`));
  assert.deepEqual(saved().allowedChatIds, [], 'never claims');
  assert.equal(saved().ownerUserId, undefined);
  assert.equal(tg.length, 0);
  assert.deepEqual(L.calls, []);

  L = world({ restricted: false, allowedChatIds: [], botUsername: 'vc_control_bot' });
  L.challenge();
  await dispatch(privateMsg(OWNER, `/start login_${CODE}`));
  assert.equal(tg.length, 0, 'unrestricted: no reply');
  assert.deepEqual(L.calls, []);
});

test("core's onLogin for the code turns the card into a log-out button that revokes the session", async () => {
  const L = world(claimed());
  L.challenge();
  await dispatch(privateMsg(OWNER, `/start login_${CODE}`));
  const cardId = nextId - 1;
  await dispatch(tap(ownerChat, OWNER, `vc_login:${CODE}:ok`, cardId));
  tg.length = 0;

  L.fire({ via: 'telegram-qr', ip: '203.0.113.5', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/131.0', sessionId: 'sess-1', code: CODE, external: true });
  await settle();
  assert.equal(sends().length, 0, 'no alert for a telegram-qr login');
  assert.equal(edits().length, 1);
  assert.equal(edits()[0].message_id, cardId);
  assert.equal(edits()[0].text, '✓ Logged in: Firefox · Windows · IP 203.0.113.5');
  assert.deepEqual(edits()[0].reply_markup.inline_keyboard, [[{ text: '🚪 Log out this browser', callback_data: 'vc_logout:sess-1' }]]);

  tg.length = 0;
  await dispatch(tap(ownerChat, OWNER, 'vc_logout:sess-1', cardId));
  assert.deepEqual(L.calls.at(-1), ['revoke', 'sess-1']);
  assert.equal(edits()[0].text, '🚪 Logged out: Firefox · Windows · IP 203.0.113.5');
});

// --- alerts -----------------------------------------------------------------------

test('a token / login-link login is announced only when external', async () => {
  const L = world(claimed());
  L.fire({ via: 'token', ip: '127.0.0.1', ua: 'curl/8', sessionId: null, code: null, external: false });
  L.fire({ via: 'login-link', ip: '127.0.0.1', ua: 'curl/8', sessionId: 's', code: null, external: false });
  L.fire({ via: 'telegram-qr', ip: '203.0.113.5', ua: 'x', sessionId: 's', code: 'NOCARD12', external: true });
  await settle();
  assert.equal(tg.length, 0);

  L.fire({ via: 'token', ip: '203.0.113.5', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1', sessionId: null, code: null, external: true });
  L.fire({ via: 'login-link', ip: '198.51.100.9', ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0', sessionId: 's2', code: null, external: true });
  await settle();
  assert.deepEqual(sends().map((s) => [s.chat_id, s.text]), [
    [OWNER, '🔑 Dashboard login with the auth token from IP 203.0.113.5 (Safari · macOS)'],
    [OWNER, '🔑 Dashboard login with a one-time login link from IP 198.51.100.9 (Chrome · Android)'],
  ]);
});

// --- sessions -----------------------------------------------------------------------

test('/sessions and the menu button list sessions, revoke one, and log out everywhere after a confirm', async () => {
  const L = world(claimed());
  await dispatch(privateMsg(OWNER, '/menu'));
  const menu = sends()[0].reply_markup.inline_keyboard.flat();
  assert.ok(menu.some((b) => b.text === '🖥 Dashboard sessions' && b.callback_data === 'vc_sess'));
  assert.ok(!menu.some((b) => b.callback_data === 'vc_get_auth_token'), 'no auth-token button');

  tg.length = 0;
  await dispatch(privateMsg(OWNER, '/sessions'));
  const list = sends()[0];
  assert.match(list.text, /^Dashboard sessions \(2\):/);
  assert.match(list.text, /telegram-qr · @hp \(111\) · IP 203\.0\.113\.5 · Chrome · Linux/);
  assert.match(list.text, /login-link · IP 198\.51\.100\.9 · Safari · iOS/);
  const rows = list.reply_markup.inline_keyboard;
  assert.deepEqual(rows.map((r) => r[0].callback_data), ['vc_sess_rv:sess-1', 'vc_sess_rv:sess-2', 'vc_sess_all']);
  const listId = nextId - 1;

  tg.length = 0;
  await dispatch(tap(ownerChat, OWNER, 'vc_sess_rv:sess-2', listId));
  assert.deepEqual(L.calls, [['revoke', 'sess-2']]);
  assert.match(edits()[0].text, /^Dashboard sessions \(1\):/);

  tg.length = 0;
  await dispatch(tap(ownerChat, OWNER, 'vc_sess_all', listId));
  assert.deepEqual(L.calls, [['revoke', 'sess-2']], 'a confirm first');
  assert.equal(edits()[0].reply_markup.inline_keyboard[0][0].callback_data, 'vc_sess_all_ok');
  await dispatch(tap(ownerChat, OWNER, 'vc_sess_all_ok', listId));
  assert.deepEqual(L.calls.at(-1), ['revokeAll']);
  assert.match(edits().at(-1).text, /^🚪 Logged out everywhere \(1 session\)\.$/);

  // Not for another whitelisted chat.
  world(claimed({ allowedChatIds: [OWNER, OTHER] }));
  await dispatch(privateMsg(OTHER, '/menu'));
  assert.equal(sends()[0].reply_markup, undefined, 'a non-owner chat gets no buttons at all');
});

// --- inert without ctx.login --------------------------------------------------------

test('without ctx.login: no provider, no card, no menu button, /sessions is just a command', async () => {
  world(claimed(), { login: false });
  assert.equal(platformLogin.available(), false);
  assert.equal(platformLogin.link(CODE), null);
  await dispatch(privateMsg(OWNER, `/start login_${CODE}`));
  assert.equal(tg.length, 0, 'the deep link is dropped');
  await dispatch(privateMsg(OWNER, '/menu'));
  assert.ok(!sends()[0].reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'vc_sess'), 'no sessions button without ctx.login');
  tg.length = 0;
  await dispatch(privateMsg(OWNER, '/sessions'));
  assert.equal(sends().length, 1);
  assert.doesNotMatch(sends()[0].text, /Dashboard sessions/);
});

test('shutdown unregisters the provider and the onLogin listener', () => {
  const L = world(claimed());
  assert.equal(L.providers.length, 1);
  assert.equal(L.loginFns.length, 1);
  platformLogin.shutdown();
  assert.equal(L.unregistered, 1);
  assert.equal(L.loginFns.length, 0);
  assert.equal(platformLogin.available(), false);
});
