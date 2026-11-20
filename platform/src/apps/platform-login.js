const telegram = require('./telegram');

// Dashboard QR login through the control bot (docs/telegram-control.md
// "Telegram"). Core's dashboard ctx offers `ctx.login` (docs/seam.md); absent
// (older core, headless runner) everything here is inert.
//
// - Provider `telegram`: core asks `link(code)` for every login challenge; the
//   answer is a t.me deep link `/start login_<code>` to the control bot, or
//   null while the bot cannot approve anything (no QR is shown then).
// - `/start login_<code>`: only the bot's OWNER (the Telegram user who claimed
//   it with a dashboard claim code) in their private chat gets the confirm card; anyone else is dropped
//   without a reply. telegram.js never lets that message claim a bot.
// - Cards: ✅ approve / ✖ deny; `onLogin` turns an approved card into
//   "Logged in" with a log-out button. The code → card map lives in memory
//   (a restart loses it: the card then just stays at "Approved").
// - `/sessions` + the menu button list core's dashboard sessions, revocable.
// - Token / login-link logins from outside the host push an alert.
//
// The platform-telegram module is required lazily: it requires this one.

const PROVIDER = { id: 'telegram', label: 'Telegram' };
const VIA = 'telegram-qr';
const CODE_RE = /^[A-Za-z0-9]{4,32}$/;
const CARD_TTL_MS = 60 * 60 * 1000;
const CARD_MAX = 100;

let login = null;
let unregister = null;
let unsubscribe = null;
// code → { chatId, messageId, ip, ua, state: 'pending'|'approved'|'loggedIn'|'done', at }
const cards = new Map();
// Session ids too long for a callback_data are referred to by a short index.
const sessRefs = new Map();
let sessSeq = 0;
// { token, username, pending } — the control bot's @username for the deep link.
let me = { token: null, username: null, pending: false };

const pt = () => require('./platform-telegram');
const KEY = () => pt().KEY;
const call = (method, params) => telegram.call(KEY(), method, params).catch(() => null);

function available() {
  return !!login;
}

// --- Owner ----------------------------------------------------------------------

// The owner's private chat id when the control bot is restricted and claimed
// (a private chat's id is its user's id), else null. The rule itself lives in
// telegram.isOwnerAct, shared with platform-telegram.isPrivileged.
function ownerChatReady() {
  const bot = telegram.getBot(KEY());
  if (!bot || !bot.restricted) return null;
  return telegram.claimedOwner(KEY());
}

function isOwnerAct(chat, from) {
  return telegram.isOwnerAct(KEY(), chat, from);
}

// --- Provider -------------------------------------------------------------------

function botUsername() {
  const bot = telegram.getBot(KEY());
  if (!bot?.token) return null;
  if (me.token !== bot.token) me = { token: bot.token, username: bot.botUsername || null, pending: false };
  if (!me.username && !me.pending) {
    me.pending = true;
    const token = bot.token;
    Promise.resolve(telegram.call(KEY(), 'getMe', {}))
      .then((r) => { if (me.token === token && r?.ok && r.result?.username) me.username = r.result.username; })
      .catch(() => {})
      .finally(() => { if (me.token === token) me.pending = false; });
  }
  return me.username;
}

function link(code) {
  if (!login || !CODE_RE.test(String(code || ''))) return null;
  if (ownerChatReady() == null) return null;
  const username = botUsername();
  if (!username || !/^\w{3,64}$/.test(username)) return null;
  return `https://t.me/${username}?start=login_${code}`;
}

// --- Formatting -----------------------------------------------------------------

function shortUa(ua) {
  const s = String(ua || '');
  if (!s) return 'unknown browser';
  const browser = /Edg(e|A|iOS)?\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
    : /Firefox\/|FxiOS/.test(s) ? 'Firefox'
    : /Chrome\/|CriOS/.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari'
    : /curl\//i.test(s) ? 'curl'
    : null;
  const os = /Android/.test(s) ? 'Android'
    : /iPhone|iPad|iPod/.test(s) ? 'iOS'
    : /CrOS/.test(s) ? 'ChromeOS'
    : /Windows/.test(s) ? 'Windows'
    : /Mac OS X|Macintosh/.test(s) ? 'macOS'
    : /Linux/.test(s) ? 'Linux'
    : null;
  if (browser || os) return [browser, os].filter(Boolean).join(' · ');
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 60);
}

const ipOf = (ip) => String(ip || 'unknown').slice(0, 64);
const hms = (t) => {
  const d = new Date(t || Date.now());
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
};

function whoOf(from) {
  const name = from?.username ? `@${from.username}` : [from?.first_name, from?.last_name].filter(Boolean).join(' ');
  return `${name || 'owner'} (${from?.id})`.slice(0, 100);
}

function sessRef(id) {
  const s = String(id);
  if (Buffer.byteLength(`vc_sess_rv:${s}`) <= 64 && /^[\w.-]+$/.test(s)) return s;
  const ref = `#${++sessSeq}`;
  sessRefs.set(ref, s);
  if (sessRefs.size > 500) sessRefs.delete(sessRefs.keys().next().value);
  return ref;
}
const sessOf = (ref) => (ref.startsWith('#') ? sessRefs.get(ref) || null : ref);

function pruneCards() {
  const now = Date.now();
  for (const [code, c] of cards) if (now - c.at > CARD_TTL_MS) cards.delete(code);
  while (cards.size > CARD_MAX) cards.delete(cards.keys().next().value);
}

async function edit(chatId, messageId, text, markup) {
  return call('editMessageText', {
    chat_id: chatId, message_id: messageId, text,
    reply_markup: markup || { inline_keyboard: [] },
  });
}

// --- /start login_<code> ----------------------------------------------------------

// Handles a `/start login_…` message. Always consumes it (never reaches the
// menu, a bound session, Horst or a claim); replies only to the owner.
async function handleStart(msg) {
  if (!login) return true;
  if (!isOwnerAct(msg.chat, msg.from)) return true;
  const chatId = msg.chat.id;
  const code = String(msg.text || '').trim().replace(/^\/start(?:@\w+)?\s+login_/, '').trim();
  const info = CODE_RE.test(code) ? safe(() => login.describe(code)) : null;
  if (!info) {
    await call('sendMessage', { chat_id: chatId, text: 'This login code has expired — the page shows a fresh QR.' });
    return true;
  }
  if (info.status !== 'pending') {
    await call('sendMessage', { chat_id: chatId, text: info.status === 'approved' ? 'This login was already approved.' : 'This login was refused.' });
    return true;
  }
  const text = `Log in a browser? ${shortUa(info.ua)} · IP ${ipOf(info.ip)} · requested ${hms(info.createdAt)}. `
    + 'Only approve if this is the screen in front of you.';
  const res = await call('sendMessage', {
    chat_id: chatId, text,
    reply_markup: { inline_keyboard: [[
      { text: '✅ Log in', callback_data: `vc_login:${code}:ok` },
      { text: '✖ Not me', callback_data: `vc_login:${code}:no` },
    ]] },
  });
  const messageId = res?.result?.message_id;
  if (messageId) {
    cards.set(code, { chatId, messageId, ip: info.ip, ua: info.ua, state: 'pending', at: Date.now() });
    pruneCards();
  }
  return true;
}

const REFUSED = {
  unknown: 'this login code is unknown or has expired',
  expired: 'this login code has expired — the page shows a fresh QR',
  used: 'this login code was already used',
  denied: 'this login was already refused',
};

function safe(fn) {
  try { return fn(); } catch { return null; }
}

// --- Callbacks ----------------------------------------------------------------------

function handles(data) {
  return /^vc_(login:|logout:|sess($|_))/.test(String(data || ''));
}

// vc_login:<code>:ok|no · vc_logout:<sessionId> · vc_sess · vc_sess_rv:<ref> ·
// vc_sess_all · vc_sess_all_ok. Each re-checks the owner's private chat; a
// tap from anyone else is ignored.
async function handleCallback(cq) {
  const chat = cq.message?.chat;
  if (!login || !isOwnerAct(chat, cq.from)) return;
  const chatId = chat.id;
  const messageId = cq.message.message_id;
  const data = cq.data || '';

  if (data.startsWith('vc_login:')) {
    const [, code, act] = data.split(':');
    if (!CODE_RE.test(code || '')) return;
    const known = cards.get(code);
    const info = safe(() => login.describe(code));
    const ip = info?.ip ?? known?.ip;
    if (act === 'ok') {
      const card = known || { chatId, messageId, ip, ua: info?.ua, at: Date.now() };
      card.chatId = chatId; card.messageId = messageId; card.state = 'approved';
      cards.set(code, card);
      let r;
      try { r = await login.approve(code, { via: VIA, who: whoOf(cq.from) }); } catch (err) { r = { ok: false, reason: err.message }; }
      if (r?.ok) {
        if (card.state === 'approved') await edit(chatId, messageId, '✓ Approved — the browser is logging in…');
      } else {
        cards.delete(code);
        await edit(chatId, messageId, `✖ Not logged in: ${REFUSED[r?.reason] || 'the login was refused'}.`);
      }
    } else if (act === 'no') {
      safe(() => login.deny(code));
      cards.delete(code);
      await edit(chatId, messageId, `✖ Refused. If you did not open this login page, someone else has it open (IP ${ipOf(ip)}).`);
    }
  } else if (data.startsWith('vc_logout:')) {
    const id = sessOf(data.slice('vc_logout:'.length));
    const ok = id ? !!safe(() => login.revokeSession(id)) : false;
    let card = null;
    for (const [code, c] of cards) if (c.sessionId === id) { card = c; cards.delete(code); break; }
    const what = card ? `: ${shortUa(card.ua)} · IP ${ipOf(card.ip)}` : '.';
    await edit(chatId, messageId, ok ? `🚪 Logged out${what}` : 'That browser session had already ended.');
  } else if (data === 'vc_sess') {
    await sendSessions(chatId);
  } else if (data.startsWith('vc_sess_rv:')) {
    const id = sessOf(data.slice('vc_sess_rv:'.length));
    if (id) safe(() => login.revokeSession(id));
    const view = sessionsView();
    await edit(chatId, messageId, view.text, view.markup);
  } else if (data === 'vc_sess_all') {
    await edit(chatId, messageId, 'Log out every dashboard browser? Each must sign in again; the auth token keeps working.', {
      inline_keyboard: [[
        { text: '🚪 Yes, log out everywhere', callback_data: 'vc_sess_all_ok' },
        { text: '✖ Cancel', callback_data: 'vc_sess' },
      ]],
    });
  } else if (data === 'vc_sess_all_ok') {
    const n = safe(() => login.revokeAll());
    await edit(chatId, messageId, `🚪 Logged out everywhere${typeof n === 'number' ? ` (${n} session${n === 1 ? '' : 's'})` : ''}.`);
  }
}

// --- Sessions ---------------------------------------------------------------------------

function sessionsView() {
  const list = safe(() => login.listSessions()) || [];
  if (!list.length) return { text: 'No dashboard browser sessions.', markup: { inline_keyboard: [] } };
  const lines = [`Dashboard sessions (${list.length}):`, ''];
  const rows = [];
  list.slice(0, 20).forEach((s, i) => {
    const created = s.createdAt ? new Date(s.createdAt).toLocaleString() : '?';
    lines.push(`${i + 1}. ${s.via || '?'}${s.who ? ` · ${String(s.who).slice(0, 100)}` : ''} · IP ${ipOf(s.ip)} · ${shortUa(s.ua)} · since ${created}`);
    rows.push([{ text: `🚪 Log out ${i + 1} (${shortUa(s.ua)})`.slice(0, 60), callback_data: `vc_sess_rv:${sessRef(s.id)}` }]);
  });
  if (list.length > 20) lines.push(`…and ${list.length - 20} more.`);
  rows.push([{ text: 'Log out everywhere', callback_data: 'vc_sess_all' }]);
  return { text: lines.join('\n'), markup: { inline_keyboard: rows } };
}

async function sendSessions(chatId) {
  const view = sessionsView();
  await call('sendMessage', { chat_id: chatId, text: view.text, reply_markup: view.markup });
}

// `/sessions`: true when handled (the owner's private chat with ctx.login),
// false to let the caller treat it as any other unknown command.
async function handleSessionsCommand(msg) {
  if (!login || !isOwnerAct(msg.chat, msg.from)) return false;
  await sendSessions(msg.chat.id);
  return true;
}

// The main-menu row, for the owner's private chat only.
function menuRow(chatId) {
  if (!login) return null;
  const uid = ownerChatReady();
  if (uid == null || Number(chatId) !== uid) return null;
  return [{ text: '🖥 Dashboard sessions', callback_data: 'vc_sess' }];
}

// --- onLogin -----------------------------------------------------------------------------

async function onLogin(ev) {
  if (!ev) return;
  const card = ev.code ? cards.get(ev.code) : null;
  if (card) {
    card.state = 'loggedIn';
    card.sessionId = ev.sessionId || null;
    const ua = ev.ua ?? card.ua;
    const ip = ev.ip ?? card.ip;
    card.ua = ua; card.ip = ip;
    const markup = ev.sessionId
      ? { inline_keyboard: [[{ text: '🚪 Log out this browser', callback_data: `vc_logout:${sessRef(ev.sessionId)}` }]] }
      : undefined;
    await edit(card.chatId, card.messageId, `✓ Logged in: ${shortUa(ua)} · IP ${ipOf(ip)}`, markup);
    return;
  }
  if (ev.external !== true || (ev.via !== 'token' && ev.via !== 'login-link')) return;
  const chatId = ownerChatReady() ?? safe(() => require('./platform-horst').controlChatId());
  if (chatId == null) return;
  const how = ev.via === 'token' ? 'with the auth token' : 'with a one-time login link';
  await call('sendMessage', { chat_id: chatId, text: `🔑 Dashboard login ${how} from IP ${ipOf(ev.ip)} (${shortUa(ev.ua)})` });
}

// --- Lifecycle ---------------------------------------------------------------------------

function init({ login: l } = {}) {
  shutdown();
  if (!l || typeof l.registerProvider !== 'function') return;
  login = l;
  try {
    const u = l.registerProvider({ ...PROVIDER, link });
    unregister = typeof u === 'function' ? u : null;
  } catch (err) {
    console.warn('[platform-login] registerProvider:', err.message);
  }
  if (typeof l.onLogin === 'function') {
    const u = l.onLogin((ev) => { onLogin(ev).catch(() => {}); });
    unsubscribe = typeof u === 'function' ? u : null;
  }
}

function shutdown() {
  try { if (unregister) unregister(); } catch {}
  try { if (unsubscribe) unsubscribe(); } catch {}
  unregister = null;
  unsubscribe = null;
  login = null;
  cards.clear();
  sessRefs.clear();
  me = { token: null, username: null, pending: false };
}

module.exports = {
  init, shutdown, available, link, handleStart, handleCallback, handles,
  handleSessionsCommand, menuRow, shortUa,
  _cards: cards,
};
