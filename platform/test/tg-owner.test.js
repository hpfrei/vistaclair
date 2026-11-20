// Privilege on the platform control bot is decided by SENDER, never by chat id,
// and the bot is claimed by a one-time dashboard code, never by inbound
// traffic. Real telegram.js dispatch over a temp config, stubbed Bot API, no
// network: group chats (owner or not) and non-owner private chats are not
// privileged; callbacks (proposals, launches, restart), job answers and
// relayed text from a non-owner are refused; an unclaimed bot serves nobody;
// a valid claim code in a private chat claims, an expired / used / wrong one
// does not; the auth-token button is gone; a Mini App bearer dies with the
// owner. Unrestricted app bots keep their behaviour.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const telegram = require('../src/apps/telegram');
const platformTelegram = require('../src/apps/platform-telegram');
const platformHorst = require('../src/apps/platform-horst');
const tgSession = require('../src/apps/platform-tg-session');
const horstJobs = require('../src/apps/agent/horst-jobs');
const miniAppAuth = require('../src/apps/tg-miniapp-auth');

const KEY = '__platform__';
const OWNER = 111;
const OTHER = 222;
const GROUP = -100777;
const BOT_TOKEN = '123456:AAHfake-bot-token-for-tests';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-tgowner-'));
const cfgPath = path.join(dir, '.telegram.enc');
const secretStore = {
  readSecretFile: (p, _d, { fallback }) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } },
  writeSecretFile: (p, obj) => fs.writeFileSync(p, JSON.stringify(obj)),
};
const saved = (key = KEY) => JSON.parse(fs.readFileSync(cfgPath, 'utf8')).apps[key];

const tg = [];
let nextId = 700;
telegram.call = async (key, method, params) => {
  if (method === 'answerCallbackQuery' || method === 'setChatMenuButton' || method === 'sendChatAction') return { ok: true, result: true };
  tg.push({ key, method, ...params });
  return { ok: true, result: { message_id: nextId++ } };
};
const sends = () => tg.filter((o) => o.method === 'sendMessage');

function world(bot, extraApps = {}) {
  const apps = { ...extraApps };
  if (bot) apps[KEY] = { token: BOT_TOKEN, botId: 9, botUsername: 'vc_control_bot', mode: 'poll', offset: 0, restricted: true, allowedChatIds: [], webhookSecret: 's', addedAt: 1, ...bot };
  fs.writeFileSync(cfgPath, JSON.stringify({ publicUrl: '', apps }));
  telegram.init(dir, secretStore, { broadcast() {} });
  tg.length = 0;
}
const claimed = (extra = {}) => ({ allowedChatIds: [OWNER], ownerUserId: OWNER, ...extra });

const settle = () => new Promise((r) => setTimeout(r, 25));
const user = (id) => ({ id, is_bot: false, first_name: 'H' });
const privateMsg = (from, text, extra = {}) => ({ update_id: nextId++, message: { message_id: nextId++, chat: { id: from, type: 'private' }, from: user(from), text, ...extra } });
const groupMsg = (from, text, extra = {}) => ({ update_id: nextId++, message: { message_id: nextId++, chat: { id: GROUP, type: 'supergroup' }, from: user(from), text, ...extra } });
const tap = (chat, from, data) => ({ update_id: nextId++, callback_query: { id: `cq${nextId++}`, from: user(from), data, message: { message_id: 5, chat } } });
const dispatch = async (u) => { telegram.dispatchUpdate(KEY, u); await settle(); };
const direct = async (u) => { await handleUpdate(u); await settle(); };

let handleUpdate;
test.before(() => {
  world(null);
  const register = telegram.registerUpdateHandler;
  telegram.registerUpdateHandler = (key, fn) => { if (key === KEY) handleUpdate = fn; return register(key, fn); };
  platformTelegram.init('t', {});
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// --- isPrivileged ----------------------------------------------------------------

test('isPrivileged: only the claimed owner, in their private chat, on a restricted bot', () => {
  world(claimed());
  const msg = (chat, from) => ({ chat, from: user(from) });
  const priv = { id: OWNER, type: 'private' };
  assert.equal(platformTelegram.isPrivileged(msg(priv, OWNER)), true);
  assert.equal(platformTelegram.isPrivileged(msg({ id: GROUP, type: 'supergroup' }, OWNER)), false, 'owner in a group');
  assert.equal(platformTelegram.isPrivileged(msg({ id: GROUP, type: 'supergroup' }, OTHER)), false, 'non-owner in a group');
  assert.equal(platformTelegram.isPrivileged(msg({ id: OTHER, type: 'private' }, OTHER)), false, 'non-owner private');
  assert.equal(platformTelegram.isPrivileged(msg({ id: OWNER, type: 'private' }, OTHER)), false, 'owner chat, other sender');
  assert.equal(platformTelegram.isPrivileged(msg({ id: OTHER, type: 'private' }, OWNER)), false, 'chat.id !== from.id');
  assert.equal(platformTelegram.isPrivileged(OWNER), false, 'a bare chat id is never enough');
  assert.equal(platformTelegram.isPrivileged(null), false);
  // A callback query: the chat is the message's, the sender is cq.from.
  const cb = (chat, from) => ({ id: 'x', data: 'vc_x', from: user(from), message: { chat } });
  assert.equal(platformTelegram.isPrivileged(cb(priv, OWNER)), true);
  assert.equal(platformTelegram.isPrivileged(cb(priv, OTHER)), false);
  assert.equal(platformTelegram.isPrivileged(cb({ id: GROUP, type: 'group' }, OWNER)), false);

  world(claimed({ restricted: false }));
  assert.equal(platformTelegram.isPrivileged(msg(priv, OWNER)), false, 'unrestricted bot');
  world(claimed({ allowedChatIds: [GROUP], ownerUserId: OWNER }));
  assert.equal(platformTelegram.isPrivileged(msg(priv, OWNER)), false, 'group claim = unclaimed');
  world({ allowedChatIds: [] });
  assert.equal(platformTelegram.isPrivileged(msg(priv, OWNER)), false, 'unclaimed');
});

// --- group chats and strangers ----------------------------------------------------

test('group chats (owner or not) and non-owner private chats get nothing', async () => {
  world(claimed({ allowedChatIds: [OWNER, GROUP, OTHER] })); // a legacy allowlist that also holds a group and a stranger
  const launches = [];
  const orig = { launch: tgSession.launch };
  tgSession.launch = (...a) => { launches.push(a); };
  try {
    for (const u of [
      groupMsg(OWNER, '/menu'), groupMsg(OTHER, '/menu'), groupMsg(OTHER, 'hello Horst'), groupMsg(OWNER, 'hello Horst'),
      privateMsg(OTHER, 'hello Horst'),
    ]) await direct(u);
    assert.deepEqual(sends().filter((s) => s.chat_id === GROUP), [], 'no reply in a group');
    for (const s of sends()) assert.equal(s.reply_markup, undefined, 'no buttons for a non-owner');
    for (const s of sends()) assert.doesNotMatch(s.text, /Horst here|token/i, 'no control menu, no Horst chat');

    tg.length = 0;
    for (const [chat, from] of [[{ id: GROUP, type: 'group' }, OWNER], [{ id: GROUP, type: 'group' }, OTHER], [{ id: OTHER, type: 'private' }, OTHER], [{ id: OWNER, type: 'private' }, OTHER]]) {
      for (const data of ['vc_restart_confirm', 'vc_directives', 'vc_app:my-gym', 'vc_pro_cli', 'vc_get_auth_token', 'horst_prop:p1:approve:1', 'vr_list', 'vc_end_force']) {
        await direct(tap(chat, from, data));
      }
    }
    assert.deepEqual(tg, [], 'every callback from a non-owner is dropped silently');
    assert.deepEqual(launches, []);
  } finally {
    tgSession.launch = orig.launch;
  }
});

test('proposal decide and session launch from a non-owner are refused; the owner still can', async () => {
  world(claimed());
  const decided = [];
  const launched = [];
  const orig = { decide: platformHorst.decideProposal, launch: tgSession.launch };
  platformHorst.decideProposal = async (...a) => { decided.push(a); return { status: 'executed', summary: 's' }; };
  tgSession.launch = (...a) => { launched.push(a); };
  try {
    const ownerChat = { id: OWNER, type: 'private' };
    // A forwarded proposal card tapped by someone else, in the owner's chat or elsewhere.
    await direct(tap(ownerChat, OTHER, 'horst_prop:p1:approve:1'));
    await direct(tap({ id: GROUP, type: 'group' }, OWNER, 'horst_prop:p1:approve:1'));
    assert.deepEqual(decided, []);

    // Launch: the prompt reply of a non-owner in the owner's pending state goes nowhere.
    await direct(tap(ownerChat, OWNER, 'vc_pro_cli'));
    await direct(groupMsg(OTHER, 'rm -rf everything'));
    await direct(privateMsg(OTHER, 'rm -rf everything'));
    assert.deepEqual(launched, [], 'a pending launch prompt is the owner\'s alone');

    await direct(tap(ownerChat, OWNER, 'horst_prop:p1:approve:1'));
    assert.equal(decided.length, 1, 'the owner decides');
    await direct(privateMsg(OWNER, 'check the repo'));
    assert.equal(launched.length, 1, 'the owner launches');
  } finally {
    platformHorst.decideProposal = orig.decide;
    tgSession.launch = orig.launch;
  }
});

test('a non-owner cannot answer a long-running tool\'s question; text is not relayed into a bound session', async () => {
  world(claimed());
  const answers = [];
  const relayed = [];
  const orig = { answer: horstJobs.answerFromTelegram, sendTurn: tgSession.sendTurn, binding: tgSession.getBinding };
  horstJobs.answerFromTelegram = (...a) => { answers.push(a); return { ok: true, text: 'sent' }; };
  tgSession.sendTurn = (...a) => { relayed.push(a); };
  tgSession.getBinding = () => ({ target: { type: 'pro' } });
  try {
    const q = { reply_to_message: { message_id: 9 } };
    await direct(groupMsg(OTHER, 'blue', q));
    await direct(groupMsg(OWNER, 'blue', q));
    await direct(privateMsg(OTHER, 'blue', q));
    await direct(privateMsg(OTHER, 'also this'));
    assert.deepEqual(answers, []);
    assert.deepEqual(relayed, []);
    await direct(privateMsg(OWNER, 'blue', q));
    assert.equal(answers.length, 1);
    await direct(privateMsg(OWNER, 'next step'));
    assert.deepEqual(relayed, [[OWNER, 'next step']]);
  } finally {
    horstJobs.answerFromTelegram = orig.answer;
    tgSession.sendTurn = orig.sendTurn;
    tgSession.getBinding = orig.binding;
  }
});

test('horst-jobs.answerFromTelegram itself checks the sender when wired to the owner check', () => {
  const sent = [];
  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-tgowner-jobs-'));
  try {
    horstJobs.init({
      dir: jobsDir, governance: {}, appendMessage: () => {}, sendControlMessage: async () => [], controlChatId: () => OWNER,
      telegram: { call: async (m, p) => { sent.push([m, p]); return { ok: true }; } },
      isOwnerAct: (chat, from) => chat?.type === 'private' && chat.id === OWNER && from?.id === OWNER,
    });
    fs.writeFileSync(path.join(jobsDir, 'tool-jobs-tg.json'), JSON.stringify({ jobs: {}, questions: { [`${OWNER}:9`]: 'job-1' } }));
    horstJobs.init({
      dir: jobsDir, governance: {}, appendMessage: () => {}, sendControlMessage: async () => [], controlChatId: () => OWNER,
      telegram: { call: async () => ({ ok: true }) },
      isOwnerAct: (chat, from) => chat?.type === 'private' && chat.id === OWNER && from?.id === OWNER,
    });
    const group = { chat: { id: GROUP, type: 'group' }, from: user(OWNER) };
    assert.equal(horstJobs.answerFromTelegram(OWNER, 9, 'x', group), null, 'wrong chat type');
    assert.equal(horstJobs.answerFromTelegram(OWNER, 9, 'x', { chat: { id: OWNER, type: 'private' }, from: user(OTHER) }), null, 'wrong sender');
    assert.equal(horstJobs.answerFromTelegram(OWNER, 9, 'x'), null, 'no actor at all');
    const q = JSON.parse(fs.readFileSync(path.join(jobsDir, 'tool-jobs-tg.json'), 'utf8')).questions;
    assert.equal(q[`${OWNER}:9`], 'job-1', 'a refused answer does not consume the question');
  } finally {
    fs.rmSync(jobsDir, { recursive: true, force: true });
    horstJobs.init({});
  }
});

// --- claiming ---------------------------------------------------------------------

test('an unclaimed restricted control bot never claims from inbound traffic and fails closed', async () => {
  world({ allowedChatIds: [] });
  await dispatch(privateMsg(OWNER, 'hello'));
  await dispatch(privateMsg(OWNER, '/start'));
  await dispatch(tap({ id: OTHER, type: 'private' }, OTHER, 'vc_cancel'));
  await dispatch(groupMsg(OTHER, 'hello'));
  assert.deepEqual(saved().allowedChatIds, []);
  assert.equal(saved().ownerUserId, undefined);
  assert.equal(telegram.claimedOwner(KEY), null);
  assert.ok(sends().length <= 1, 'at most one short notice (rate-limited), none in groups or to taps');
  for (const s of sends()) assert.match(s.text, /not set up/);
  assert.equal(sends().filter((s) => s.chat_id === GROUP).length, 0);

  // Emptying the allowlist of a claimed bot does not re-open a claim either.
  world(claimed());
  telegram.removeAllowedChat(KEY, OWNER);
  await dispatch(privateMsg(OTHER, 'hello'));
  assert.deepEqual(saved().allowedChatIds, []);
  assert.equal(saved().ownerUserId, undefined);
});

test('a valid claim code in a private chat claims; the owner then controls the bot', async () => {
  world({ allowedChatIds: [] });
  const made = telegram.createClaimCode(KEY);
  assert.equal(made.ok, true);
  assert.match(made.code, /^[A-Za-z0-9_-]{20}$/);
  assert.equal(made.link, `https://t.me/vc_control_bot?start=claim_${made.code}`);
  assert.ok(made.expiresAt > Date.now() + 9 * 60000 && made.expiresAt <= Date.now() + 10 * 60000);

  // Wrong user context first: the same code in a group does not claim and is not spent.
  await dispatch(groupMsg(OTHER, `/start claim_${made.code}`));
  assert.deepEqual(saved().allowedChatIds, []);

  await dispatch(privateMsg(OWNER, `/start claim_${made.code}`));
  assert.deepEqual(saved().allowedChatIds, [OWNER]);
  assert.equal(saved().ownerUserId, OWNER);
  assert.equal(platformTelegram.status().claimed, true);
  const hello = sends().find((s) => s.chat_id === OWNER);
  assert.match(hello.text, /now controls Vistaclair/);
  assert.ok(hello.reply_markup.inline_keyboard.flat().length > 0, 'the owner gets the menu');

  // The code is single-use.
  tg.length = 0;
  await dispatch(privateMsg(333, `/start claim_${made.code}`)); // (a fresh chat: notices are rate-limited per chat)
  assert.equal(saved().ownerUserId, OWNER, 'a used code never moves the owner');
  assert.match(sends()[0].text, /invalid or has expired/);
});

test('expired, wrong and exhausted claim codes do not claim', async () => {
  world({ allowedChatIds: [] });
  const made = telegram.createClaimCode(KEY);
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60000 + 1;
  try {
    await dispatch(privateMsg(OWNER, `/start claim_${made.code}`));
  } finally { Date.now = realNow; }
  assert.equal(saved().ownerUserId, undefined, 'expired');

  const fresh = telegram.createClaimCode(KEY);
  await dispatch(privateMsg(OWNER, '/start claim_AAAAAAAAAAAAAAAAAAAA'));
  assert.equal(saved().ownerUserId, undefined, 'wrong');
  for (let i = 0; i < 5; i++) telegram.redeemClaim(KEY, privateMsg(OTHER, `/start claim_BBBBBBBBBBBBBBBBBBB${i}`));
  await dispatch(privateMsg(OWNER, `/start claim_${fresh.code}`));
  assert.equal(saved().ownerUserId, undefined, 'a code is dead after repeated wrong guesses');

  // A new code replaces the old one.
  const a = telegram.createClaimCode(KEY);
  const b = telegram.createClaimCode(KEY);
  await dispatch(privateMsg(OWNER, `/start claim_${a.code}`));
  assert.equal(saved().ownerUserId, undefined, 'a superseded code');
  await dispatch(privateMsg(OWNER, `/start claim_${b.code}`));
  assert.equal(saved().ownerUserId, OWNER);
});

test('a claim code needs restricted mode, the control bot, and re-claiming moves the owner', async () => {
  world({ allowedChatIds: [], restricted: false });
  assert.equal(telegram.createClaimCode(KEY).ok, false);
  assert.equal(telegram.createClaimCode('some-app').ok, false);
  world(claimed());
  const c = telegram.createClaimCode(KEY);
  await dispatch(privateMsg(OTHER, `/start claim_${c.code}`));
  assert.deepEqual(saved().allowedChatIds, [OTHER], 'the dashboard owner re-claims for a new account');
  assert.equal(saved().ownerUserId, OTHER);
  assert.equal(platformTelegram.isPrivileged({ chat: { id: OWNER, type: 'private' }, from: user(OWNER) }), false, 'the old owner lost control');
});

test('a group-chat claim from before is unclaimed until re-claimed; a private claim stays the owner', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try { world({ allowedChatIds: [GROUP], ownerUserId: OWNER }); } finally { console.warn = warn; }
  assert.equal(telegram.claimedOwner(KEY), null);
  assert.equal(platformHorst.controlChatId(), null, 'no control chat while unclaimed');
  await dispatch(groupMsg(OWNER, 'hi'));
  assert.deepEqual(sends().filter((s) => s.chat_id === GROUP), []);
  const c = telegram.createClaimCode(KEY);
  await dispatch(privateMsg(OWNER, `/start claim_${c.code}`));
  assert.deepEqual(saved().allowedChatIds, [OWNER], 'the group is dropped from the allowlist');

  world({ allowedChatIds: [OWNER] });
  assert.equal(telegram.claimedOwner(KEY), OWNER);
  assert.equal(platformHorst.controlChatId(), OWNER);
});

// --- the token button is gone ------------------------------------------------------

test('no auth-token button in any menu, and a stale one yields nothing', async () => {
  world(claimed());
  await dispatch(privateMsg(OWNER, '/menu'));
  const buttons = sends()[0].reply_markup.inline_keyboard.flat();
  assert.ok(buttons.length > 3);
  assert.ok(!buttons.some((b) => /token/i.test(b.text) || b.callback_data === 'vc_get_auth_token'));
  tg.length = 0;
  process.env.AUTH_TOKEN = 'super-secret-dashboard-token';
  try {
    await dispatch(tap({ id: OWNER, type: 'private' }, OWNER, 'vc_get_auth_token'));
  } finally { delete process.env.AUTH_TOKEN; }
  assert.deepEqual(tg, [], 'an old button does nothing, not even for the owner');
  assert.equal(Object.keys(platformTelegram).includes('authToken'), false);
});

// --- Mini App bearers ----------------------------------------------------------------

test('a Mini App bearer is revoked when the owner changes, the chat is removed or the bot is unrestricted', async () => {
  world(claimed());
  const initData = (id) => {
    const p = new URLSearchParams({ user: JSON.stringify({ id, first_name: 'x' }), auth_date: String(Math.floor(Date.now() / 1000)) });
    const check = [...p].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    p.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
    return p.toString();
  };
  const routes = new Map();
  const router = { post: (p, h) => routes.set(`POST ${p}`, h), get: (p, h) => routes.set(`GET ${p}`, h) };
  const { resolveToken } = miniAppAuth.mountAuth(router, '/m/api', { key: KEY, header: 'X-T' });
  const auth = async (id) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes.get('POST /m/api/auth')({ body: { initData: initData(id) }, headers: {} }, res);
    return res;
  };
  const resolve = (token) => resolveToken({ headers: { 'x-t': token } });

  assert.equal((await auth(OTHER)).statusCode, 403, 'a non-owner gets no bearer');
  assert.equal(miniAppAuth.DEFAULT_TTL_MS <= 12 * 3600 * 1000, true);

  // Owner change: re-claiming for another user kills the old owner's bearer.
  let token = (await auth(OWNER)).body.token;
  assert.ok(resolve(token));
  const c = telegram.createClaimCode(KEY);
  telegram.redeemClaim(KEY, privateMsg(OTHER, `/start claim_${c.code}`));
  assert.equal(resolve(token), null, 'owner changed');

  // Chat removed.
  token = (await auth(OTHER)).body.token;
  assert.ok(resolve(token));
  telegram.removeAllowedChat(KEY, OTHER);
  assert.equal(resolve(token), null, 'chat removed');

  // Unrestricted.
  world(claimed());
  token = (await auth(OWNER)).body.token;
  assert.ok(resolve(token));
  telegram.setRestricted(KEY, false);
  assert.equal(resolve(token), null, 'unrestricted');
});

test('Mini App initData older than an hour is refused', async () => {
  world(claimed());
  const initData = (ageS) => {
    const p = new URLSearchParams({ user: JSON.stringify({ id: OWNER, first_name: 'x' }), auth_date: String(Math.floor(Date.now() / 1000) - ageS) });
    const check = [...p].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    p.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
    return p.toString();
  };
  const routes = new Map();
  miniAppAuth.mountAuth({ post: (p, h) => routes.set(p, h), get() {} }, '/m/api', { key: KEY, header: 'X-T' });
  const call = async (ageS) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes.get('/m/api/auth')({ body: { initData: initData(ageS) }, headers: {} }, res);
    return res.statusCode;
  };
  assert.equal(await call(30 * 60), 200);
  assert.equal(await call(2 * 3600), 401);
  assert.equal(miniAppAuth.INITDATA_MAX_AGE_S, 3600);
});

// --- app bots are untouched ------------------------------------------------------------

test('app bots: unrestricted stays public; a restricted app bot still claims on first', async () => {
  const app = { token: 't', botId: 1, botUsername: 'gym_bot', mode: 'poll', offset: 0, webhookSecret: 's', addedAt: 1, allowedChatIds: [] };
  world(null, { 'my-gym': { ...app, restricted: false }, 'tiny-app': { ...app, restricted: true } });
  const got = [];
  telegram.registerUpdateHandler('my-gym', (u) => got.push(['my-gym', u]));
  telegram.registerUpdateHandler('tiny-app', (u) => got.push(['tiny-app', u]));
  telegram.dispatchUpdate('my-gym', privateMsg(OTHER, 'hi'));
  telegram.dispatchUpdate('my-gym', groupMsg(OTHER, 'hi'));
  telegram.dispatchUpdate('my-gym', privateMsg(OTHER, '/start claim_ABCDEFGHIJKL'));
  assert.equal(got.filter(([k]) => k === 'my-gym').length, 3, 'every message reaches the open app bot');
  assert.deepEqual(saved('my-gym').allowedChatIds, []);
  assert.equal(telegram.isAllowed('my-gym', GROUP), true);

  telegram.dispatchUpdate('tiny-app', privateMsg(OWNER, 'hi'));
  assert.deepEqual(saved('tiny-app').allowedChatIds, [OWNER], 'restricted app bots keep claim-on-first');
  telegram.dispatchUpdate('tiny-app', privateMsg(OTHER, 'hi'));
  assert.equal(got.filter(([k]) => k === 'tiny-app').length, 1);
  telegram.clearUpdateHandlers('my-gym');
  telegram.clearUpdateHandlers('tiny-app');
  assert.equal(telegram.createClaimCode('my-gym').ok, false, 'claim codes exist for the control bot only');
});
