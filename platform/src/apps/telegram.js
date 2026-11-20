const path = require('path');
const crypto = require('crypto');
const spendContext = require('./spend-context');

// Per-app Telegram bots. One encrypted registry keyed by app name (mirrors
// google-auth.js / email-accounts.js). Each app owns its own bot token; the
// platform runs one inbound stream per bot (long-poll by default, webhook when
// a public URL is known) and routes updates back to the owning app by name.
// A webhook bot whose public URL is unreachable (tunnel down) falls back to
// long-poll until the URL answers again — see the delivery monitor below.

let appsDir = null;
let secretStore = null;
let broadcaster = null;
let config = { publicUrl: '', apps: {} };

// appName → Set<handler> — backend (routes.js) inbound subscribers.
const updateHandlers = new Map();
// appName → { active: boolean } — live long-poll loops.
const pollers = new Map();
let started = false;

// Resolves after `ms`, or at once when `signal` aborts.
const sleep = (ms, signal) => new Promise((r) => {
  if (signal?.aborted) return r();
  const t = setTimeout(r, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
});

function configPath() {
  return path.join(appsDir, '.telegram.enc');
}

function loadConfig() {
  const cfg = secretStore.readSecretFile(configPath(), appsDir, {
    fallback: { publicUrl: '', apps: {} },
  });
  if (!cfg.apps) cfg.apps = {};
  if (typeof cfg.publicUrl !== 'string') cfg.publicUrl = '';
  return cfg;
}

function saveConfig() {
  secretStore.writeSecretFile(configPath(), config, appsDir);
}

// Bots that are claimed by a one-time CODE from the owner's authenticated
// dashboard, never by whoever messages first (claim-on-first stays for the
// restricted per-app bots). The platform control bot is the only member: it
// carries every privileged control action. Reserved key — an app name can
// never start with an underscore.
const CODE_CLAIM_KEYS = new Set(['__platform__']);
const isCodeClaim = (appName) => CODE_CLAIM_KEYS.has(appName);

function init(dir, store, bc) {
  appsDir = dir;
  secretStore = store;
  broadcaster = bc;
  config = loadConfig();
  claimCodes.clear();
  fallbacks.clear();
  webhookSetAt.clear();
  lastChecks.clear();
  for (const key of CODE_CLAIM_KEYS) {
    const bot = config.apps[key];
    if (bot?.restricted && bot.allowedChatIds?.length && claimedOwner(key) == null) {
      console.warn(`[telegram] "${key}" was claimed by a chat that is not the owner's private chat (${bot.allowedChatIds.join(', ')}); treating it as unclaimed — claim it again from the dashboard.`);
    }
  }
}

// --- Low-level Bot API ---

async function apiCall(token, method, params, timeoutMs, abortSignal) {
  if (!token) throw new Error('No bot token');
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const signals = [timeoutMs ? AbortSignal.timeout(timeoutMs) : null, abortSignal].filter(Boolean);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
    signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
  });
  return res.json();
}

// --- Bot registration ---

async function setBot(appName, token) {
  if (!appName) return { ok: false, error: 'App name is required' };
  if (!token || typeof token !== 'string') return { ok: false, error: 'Bot token is required' };
  token = token.trim();

  let me;
  try {
    me = await apiCall(token, 'getMe', {}, 15000);
  } catch (err) {
    return { ok: false, error: `Could not reach Telegram: ${err.message}` };
  }
  if (!me.ok) return { ok: false, error: me.description || 'Invalid bot token' };

  const existing = config.apps[appName] || {};
  config.apps[appName] = {
    token,
    botId: me.result.id,
    botUsername: me.result.username,
    mode: existing.mode || 'poll',
    offset: existing.offset || 0,
    restricted: existing.restricted || false,
    allowedChatIds: existing.allowedChatIds || [],
    ...(existing.ownerUserId != null ? { ownerUserId: existing.ownerUserId } : {}),
    webhookSecret: existing.webhookSecret || crypto.randomBytes(24).toString('hex'),
    webAppEnabled: existing.webAppEnabled || false,
    addedAt: existing.addedAt || Date.now(),
  };
  saveConfig();

  // If a public URL is configured, register a webhook; otherwise long-poll.
  if (config.publicUrl) {
    await enableWebhook(appName).catch(() => {});
    kickDeliveryCheck();
  } else {
    config.apps[appName].mode = 'poll';
    saveConfig();
    syncPolling();
  }

  return { ok: true, botId: me.result.id, botUsername: me.result.username };
}

async function removeBot(appName) {
  const bot = config.apps[appName];
  if (!bot) return { ok: false, error: 'No bot configured for this app' };
  stopPolling(appName);
  fallbacks.delete(appName);
  lastChecks.delete(appName);
  try { await apiCall(bot.token, 'deleteWebhook', {}, 10000); } catch {}
  claimCodes.delete(appName);
  delete config.apps[appName];
  saveConfig();
  return { ok: true };
}

function getBot(appName) {
  return config.apps[appName] || null;
}

function hasBot(appName) {
  return !!config.apps[appName];
}

function getToken(appName) {
  return config.apps[appName]?.token || null;
}

function listBots() {
  return Object.entries(config.apps).map(([appName, b]) => ({
    appName,
    botId: b.botId,
    botUsername: b.botUsername,
    mode: b.mode,
    ...inboundOf(appName),
    webAppEnabled: !!b.webAppEnabled,
    restricted: !!b.restricted,
    allowedChatIds: b.allowedChatIds || [],
    addedAt: b.addedAt,
  }));
}

// Toggle access restriction for a bot. Enabling with an empty allowlist arms
// claim-on-first (a code-claimed bot waits for its claim code instead);
// disabling leaves the allowlist intact but stops enforcing it.
function setRestricted(appName, restricted) {
  const bot = config.apps[appName];
  if (!bot) return { ok: false, error: 'No bot configured for this app' };
  bot.restricted = !!restricted;
  saveConfig();
  return { ok: true, restricted: bot.restricted };
}

function removeAllowedChat(appName, chatId) {
  const bot = config.apps[appName];
  if (!bot) return { ok: false, error: 'No bot configured for this app' };
  const cid = Number(chatId);
  bot.allowedChatIds = (bot.allowedChatIds || []).filter((c) => c !== cid);
  if (isCodeClaim(appName)) {
    // Never re-opens an inbound claim: removing the owner's chat leaves the bot
    // unclaimed (fails closed) until the owner claims it again with a code.
    if (claimedOwner(appName) == null) delete bot.ownerUserId;
  } else if (!bot.allowedChatIds.length) {
    // An empty allowlist re-arms claim-on-first; the next claimer is the owner.
    delete bot.ownerUserId;
  }
  saveConfig();
  return { ok: true, allowedChatIds: bot.allowedChatIds };
}

// Is this chat permitted to access the bot's surfaces (chat + WebApp)?
// Mirrors the inbound dispatch policy in dispatchUpdate, but NEVER claims-on-first
// (a WebApp open must not be able to claim an unbound bot). An unrestricted bot is
// open to everyone; a restricted bot admits only ids already on the allowlist.
function isAllowed(appName, chatId) {
  const bot = config.apps[appName];
  if (!bot) return false;
  if (!bot.restricted) return true;
  const cid = Number(chatId);
  if (!Number.isFinite(cid)) return false;
  // A code-claimed bot admits its owner's private chat and nobody else.
  if (isCodeClaim(appName)) return claimedOwner(appName) === cid;
  return (bot.allowedChatIds || []).some((c) => Number(c) === cid);
}

// The Telegram USER who claimed a restricted bot (claim-on-first records
// `from.id`). A bot claimed before that was recorded falls back to its first
// allowlisted chat when that is a private chat (a positive id — a private
// chat's id is its user's id), persisted once. Null when unknown.
function ownerUserId(appName) {
  const bot = config.apps[appName];
  if (!bot || !bot.allowedChatIds?.length) return null;
  const own = Number(bot.ownerUserId);
  if (bot.ownerUserId != null && Number.isSafeInteger(own) && own > 0) return own;
  const first = Number(bot.allowedChatIds[0]);
  if (!Number.isSafeInteger(first) || first <= 0) return null;
  bot.ownerUserId = first;
  saveConfig();
  return first;
}

// The owner of a code-claimed bot: the Telegram user whose PRIVATE chat is on
// the allowlist (a private chat's id is its user's id). Null while unclaimed —
// including a bot an older version let a group chat claim.
function claimedOwner(appName) {
  const uid = ownerUserId(appName);
  const bot = config.apps[appName];
  if (uid == null || !bot) return null;
  return (bot.allowedChatIds || []).some((c) => Number(c) === uid) ? uid : null;
}

// THE owner check for a code-claimed bot — the only place privilege is decided
// (platform-telegram.isPrivileged, platform-login, agent/horst-jobs): the bot
// is restricted, the act is in a private chat, and the sender is the claimed
// owner talking in their own chat (chat.id === from.id).
function isOwnerAct(appName, chat, from) {
  const bot = config.apps[appName];
  if (!bot?.restricted || !isCodeClaim(appName)) return false;
  const uid = claimedOwner(appName);
  return uid != null && chat?.type === 'private'
    && Number(from?.id) === uid && Number(chat?.id) === uid;
}

// --- Claim codes ---
// One live code per bot, in memory (a restart drops it), random, 10 minutes,
// single-use, and dead after a few wrong guesses. Shown only to the owner's
// authenticated dashboard; redeemed by `/start claim_<code>` in a private chat.

const CLAIM_TTL_MS = 10 * 60 * 1000;
const CLAIM_MAX_FAILS = 5;
const CLAIM_START = /^\/start(?:@\w+)?\s+claim_([A-Za-z0-9_-]{8,64})\s*$/;
// appName → { code, expiresAt, fails }
const claimCodes = new Map();

function createClaimCode(appName) {
  const bot = config.apps[appName];
  if (!bot) return { ok: false, error: 'No bot configured' };
  if (!isCodeClaim(appName)) return { ok: false, error: 'This bot is not claimed with a code' };
  if (!bot.restricted) return { ok: false, error: 'Enable restricted mode first' };
  const code = crypto.randomBytes(15).toString('base64url');
  const expiresAt = Date.now() + CLAIM_TTL_MS;
  claimCodes.set(appName, { code, expiresAt, fails: 0 });
  return {
    ok: true, code, expiresAt,
    link: bot.botUsername ? `https://t.me/${bot.botUsername}?start=claim_${code}` : null,
  };
}

function claimCodeOf(update) {
  const text = update?.message?.text;
  const m = typeof text === 'string' ? CLAIM_START.exec(text.trim()) : null;
  return m ? m[1] : null;
}
const isClaimStart = (update) => claimCodeOf(update) != null;

// Redeem the code carried by a `/start claim_<code>` message. A valid code in
// the sender's own private chat makes that user the owner and that chat the
// only allowlisted one; the code is spent either way it is guessed right.
function redeemClaim(appName, update) {
  const bot = config.apps[appName];
  const code = claimCodeOf(update);
  const msg = update?.message;
  if (!bot || !bot.restricted || !isCodeClaim(appName) || !code) return { ok: false, reason: 'invalid' };
  const live = claimCodes.get(appName);
  if (!live || live.expiresAt <= Date.now()) { claimCodes.delete(appName); return { ok: false, reason: 'expired' }; }
  const a = Buffer.from(code);
  const b = Buffer.from(live.code);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    if (++live.fails >= CLAIM_MAX_FAILS) claimCodes.delete(appName);
    return { ok: false, reason: 'invalid' };
  }
  const uid = msg?.from?.id;
  if (msg?.chat?.type !== 'private' || !Number.isSafeInteger(uid) || uid <= 0 || Number(msg.chat.id) !== uid) {
    return { ok: false, reason: 'not-private' }; // the code stays valid for the real owner
  }
  claimCodes.delete(appName);
  bot.allowedChatIds = [uid];
  bot.ownerUserId = uid;
  saveConfig();
  if (broadcaster) broadcaster.broadcast({ type: 'app:setup:accountsChanged', change: 'telegram.claimed', appName });
  return { ok: true, userId: uid };
}

// A short note to a stranger, at most once a minute per chat — never a reply
// loop an outsider can use to make the bot chatter.
const notices = new Map();
function notifyOnce(appName, update, text) {
  const msg = update?.message;
  if (!msg || msg.chat?.type !== 'private') return;
  const k = `${appName}:${msg.chat.id}`;
  const now = Date.now();
  if (now - (notices.get(k) || 0) < 60000) return;
  notices.set(k, now);
  if (notices.size > 200) notices.delete(notices.keys().next().value);
  module.exports.call(appName, 'sendMessage', { chat_id: msg.chat.id, text }).catch(() => {});
}

// A deep link carrying a dashboard login code. It is shown as a QR on a login
// page anyone can open, so it must never claim an unclaimed bot.
const LOGIN_START = /^\/start(?:@\w+)?\s+login_/;
function isLoginStart(update) {
  const text = update?.message?.text ?? update?.edited_message?.text;
  return typeof text === 'string' && LOGIN_START.test(text.trim());
}

function status(appName) {
  if (appName) {
    const b = config.apps[appName];
    return {
      configured: !!b,
      botUsername: b?.botUsername || null,
      botId: b?.botId || null,
      mode: b?.mode || null,
      ...(b ? inboundOf(appName) : { inbound: null, fallback: null, lastCheck: null, monitored: false }),
      webAppEnabled: !!b?.webAppEnabled,
      restricted: !!b?.restricted,
      allowedChatIds: b?.allowedChatIds || [],
    };
  }
  return { publicUrl: config.publicUrl || '', bots: listBots() };
}

// --- Outbound ---

async function send(appName, chatId, text, opts) {
  const token = getToken(appName);
  if (!token) throw new Error(`No Telegram bot configured for app "${appName}"`);
  return apiCall(token, 'sendMessage', { chat_id: chatId, text, ...(opts || {}) }, 20000);
}

async function call(appName, method, params) {
  const token = getToken(appName);
  if (!token) throw new Error(`No Telegram bot configured for app "${appName}"`);
  return apiCall(token, method, params, 20000);
}

// Multipart Bot API call — used to UPLOAD binary files (a freshly-rendered image
// buffer) that apiCall's JSON body can't carry. `fields` are text form fields;
// `files` is { field: { buffer, filename, contentType } }. Node 23 ships native
// FormData/Blob, so this needs no deps; we must NOT set Content-Type ourselves —
// fetch derives the multipart boundary from the FormData body.
async function apiCallMultipart(token, method, fields, files, timeoutMs) {
  if (!token) throw new Error('No bot token');
  const form = new FormData();
  for (const [k, v] of Object.entries(fields || {})) {
    if (v == null) continue;
    form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  for (const [field, f] of Object.entries(files || {})) {
    if (!f || !f.buffer) continue;
    const blob = new Blob([f.buffer], { type: f.contentType || 'application/octet-stream' });
    form.append(field, blob, f.filename || 'file');
  }
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    body: form,
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  return res.json();
}

// Coerce a caller-supplied photo into either an upload buffer or a string
// reference (http(s) URL or existing file_id). Accepts a Buffer, a data-URI, a
// bare base64 string, or a URL/file_id string.
function resolvePhoto(photo) {
  if (Buffer.isBuffer(photo)) return { buffer: photo, contentType: 'image/png' };
  if (photo && photo.buffer && Buffer.isBuffer(photo.buffer)) {
    return { buffer: photo.buffer, contentType: photo.contentType || 'image/png', filename: photo.filename };
  }
  if (typeof photo === 'string') {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(photo);
    if (m) {
      const contentType = m[1] || 'image/png';
      const buffer = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
      return { buffer, contentType };
    }
    if (/^https?:\/\//i.test(photo)) return { ref: photo };  // remote URL
    if (/^[A-Za-z0-9_-]+$/.test(photo) && photo.length < 200) return { ref: photo };  // file_id
    // Otherwise treat as raw base64.
    return { buffer: Buffer.from(photo, 'base64'), contentType: 'image/png' };
  }
  throw new Error('sendPhoto: unsupported `photo` value');
}

// Send a photo. `photo` may be a Buffer / data-URI / base64 (uploaded as
// multipart) or an http(s) URL / file_id (sent as a plain JSON reference).
// Voice/audio upload (multipart) — mirrors sendPhoto's buffer path.
async function sendAudio(appName, { chatId, audio, filename, contentType, caption, options } = {}) {
  const token = getToken(appName);
  if (!token) throw new Error(`No Telegram bot configured for app "${appName}"`);
  if (chatId == null) throw new Error('sendAudio: chatId required');
  if (!Buffer.isBuffer(audio)) throw new Error('sendAudio: audio must be a Buffer');
  const fields = { chat_id: chatId, ...(caption != null ? { caption } : {}), ...(options || {}) };
  return apiCallMultipart(
    token,
    'sendAudio',
    fields,
    { audio: { buffer: audio, contentType: contentType || 'audio/mpeg', filename: filename || 'reply.mp3' } },
    30000,
  );
}

async function sendPhoto(appName, { chatId, photo, caption, options } = {}) {
  const token = getToken(appName);
  if (!token) throw new Error(`No Telegram bot configured for app "${appName}"`);
  if (chatId == null) throw new Error('sendPhoto: chatId required');
  if (photo == null) throw new Error('sendPhoto: photo required');

  const resolved = resolvePhoto(photo);
  const fields = { chat_id: chatId, ...(caption != null ? { caption } : {}), ...(options || {}) };

  if (resolved.ref != null) {
    return apiCall(token, 'sendPhoto', { ...fields, photo: resolved.ref }, 20000);
  }
  return apiCallMultipart(
    token,
    'sendPhoto',
    fields,
    { photo: { buffer: resolved.buffer, contentType: resolved.contentType, filename: resolved.filename || 'photo.png' } },
    30000,
  );
}

// Documents: anything that is not a photo or an audio track — an email
// attachment forwarded to a chat, a generated report. Telegram keeps the
// filename, which `sendPhoto` does not.
async function sendDocument(appName, { chatId, document, filename, contentType, caption, options } = {}) {
  const token = getToken(appName);
  if (!token) throw new Error(`No Telegram bot configured for app "${appName}"`);
  if (chatId == null) throw new Error('sendDocument: chatId required');
  if (document == null) throw new Error('sendDocument: document required');
  const fields = { chat_id: chatId, ...(caption != null ? { caption } : {}), ...(options || {}) };
  // A string is a file_id or URL Telegram fetches itself; a Buffer is uploaded.
  if (typeof document === 'string') {
    return apiCall(token, 'sendDocument', { ...fields, document }, 20000);
  }
  if (!Buffer.isBuffer(document)) throw new Error('sendDocument: document must be a Buffer, file_id or URL');
  return apiCallMultipart(
    token,
    'sendDocument',
    fields,
    { document: { buffer: document, contentType: contentType || 'application/octet-stream', filename: filename || 'file' } },
    60000,
  );
}

// --- Public URL / webhooks ---

function getPublicUrl() {
  return config.publicUrl || '';
}

function webhookPath(appName) {
  return `/pro/telegram/${appName}/webhook`;
}

// The app root on the platform base. `{ customDomain: true }` asks for the
// recorded custom domain instead (proxied AT the app subtree, so its root is
// the app root), falling back to the platform base when none is recorded.
// The default stays the platform base: that is what a bot's web_app button opens.
function webAppUrl(appName, opts) {
  if (opts && opts.customDomain) {
    let domain = null;
    try { domain = require('./app-manager').readManifest(appName)?.domain || null; } catch {}
    if (typeof domain === 'string' && domain) return `https://${domain}/`;
  }
  const base = getPublicUrl().replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/apps/${appName}/`;
}

// The cookieless entry page of a users-level app — what a bot's web_app menu
// button and inline buttons open. Apps must not hardcode the file name.
function entryUrl(appName, opts) {
  const base = webAppUrl(appName, opts);
  return base ? `${base}${require('./surfaces').ENTRY}.html` : null;
}

async function enableWebhook(appName) {
  const bot = config.apps[appName];
  if (!bot) return { ok: false, error: 'No bot configured' };
  const base = getPublicUrl().replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'No public URL configured' };
  if (!bot.webhookSecret) bot.webhookSecret = crypto.randomBytes(24).toString('hex');

  // Never two consumers: a running poll loop is stopped, its in-flight
  // getUpdates aborted and what it already fetched confirmed BEFORE the
  // webhook exists (Telegram 409s getUpdates while one is registered).
  await quiescePolling(appName);
  const res = await apiCall(bot.token, 'setWebhook', {
    url: `${base}${webhookPath(appName)}`,
    secret_token: bot.webhookSecret,
    allowed_updates: ['message', 'edited_message', 'callback_query', 'inline_query'],
  }, 15000);
  if (!res.ok) return { ok: false, error: res.description || 'setWebhook failed' };

  bot.mode = 'webhook';
  saveConfig();
  stopPolling(appName);
  fallbacks.delete(appName);
  webhookSetAt.set(appName, Date.now());
  return { ok: true };
}

// Re-key an app's bot on app rename. The webhook path embeds the app name, so
// a webhook-mode bot must be re-registered under the new path (an external API
// call that can fail — the caller surfaces that to the user); a poll-mode bot
// just resumes polling under the new key.
async function renameApp(oldName, newName) {
  const bot = config.apps[oldName];
  if (!bot) return { moved: false };
  stopPolling(oldName);
  fallbacks.delete(oldName);
  config.apps[newName] = bot;
  delete config.apps[oldName];
  saveConfig();
  let webhook = null;
  if (bot.mode === 'webhook') {
    webhook = await enableWebhook(newName).catch((err) => ({ ok: false, error: err.message }));
  } else {
    syncPolling();
  }
  return { moved: true, botUsername: bot.botUsername || null, webhook };
}

async function disableWebhook(appName) {
  const bot = config.apps[appName];
  if (!bot) return { ok: false, error: 'No bot configured' };
  try { await apiCall(bot.token, 'deleteWebhook', {}, 10000); } catch {}
  bot.mode = 'poll';
  fallbacks.delete(appName);
  saveConfig();
  syncPolling();
  return { ok: true };
}

async function setPublicUrl(url) {
  config.publicUrl = (url || '').trim().replace(/\/+$/, '');
  saveConfig();
  // Re-resolve every bot's inbound mode against the new public URL.
  for (const appName of Object.keys(config.apps)) {
    if (config.publicUrl) {
      await enableWebhook(appName).catch(() => {});
    } else {
      await disableWebhook(appName).catch(() => {});
    }
  }
  // The control bot's menu button opens the Mini App, which exists only when a
  // public URL does — so it is re-resolved here too, not just at boot. Required
  // lazily: platform-telegram requires this module, so a top-level require
  // would close a cycle.
  try { await require('./platform-telegram').syncMenuButton(); } catch {}
  kickDeliveryCheck();
  return { ok: true, publicUrl: config.publicUrl };
}

// --- Inbound dispatch ---

function registerUpdateHandler(appName, handler) {
  if (!updateHandlers.has(appName)) updateHandlers.set(appName, new Set());
  updateHandlers.get(appName).add(handler);
  return () => { updateHandlers.get(appName)?.delete(handler); };
}

function clearUpdateHandlers(appName) {
  updateHandlers.delete(appName);
}

function chatIdOf(update) {
  return update?.message?.chat?.id
    ?? update?.edited_message?.chat?.id
    ?? update?.callback_query?.message?.chat?.id
    ?? null;
}

function dispatchUpdate(appName, update) {
  const bot = config.apps[appName];
  if (!bot) return;
  // Access restriction. When enabled, the bot only serves an approved chat
  // allowlist. If the allowlist is empty, the first chat to message the bot
  // claims it (claim-on-first); everyone after that is rejected.
  // A code-claimed bot (the control bot) NEVER claims from inbound traffic: only
  // a valid `/start claim_<code>` in a private chat does, and until then it
  // fails closed.
  if (bot.restricted && isCodeClaim(appName)) {
    const cid = chatIdOf(update);
    if (cid == null) return;
    if (isClaimStart(update)) {
      const r = redeemClaim(appName, update);
      if (!r.ok) {
        notifyOnce(appName, update, 'This claim link is invalid or has expired. Ask the dashboard for a new one.');
        return;
      }
      // Claimed: the handler below confirms it in the owner's chat.
    } else if (claimedOwner(appName) == null) {
      if (!isLoginStart(update)) notifyOnce(appName, update, 'This bot is not set up yet.');
      return;
    } else if (!(bot.allowedChatIds || []).some((c) => Number(c) === Number(cid))) {
      return;
    }
  } else if (bot.restricted) {
    const cid = chatIdOf(update);
    if (cid == null) return;
    if (!bot.allowedChatIds?.length) {
      if (isLoginStart(update)) return; // a login QR never claims a bot
      bot.allowedChatIds = [cid];
      const uid = update.message?.from?.id ?? update.edited_message?.from?.id ?? update.callback_query?.from?.id;
      if (Number.isSafeInteger(uid) && uid > 0) bot.ownerUserId = uid;
      else delete bot.ownerUserId;
      saveConfig();
      if (broadcaster) {
        broadcaster.broadcast({ type: 'app:setup:accountsChanged', change: 'telegram.claimed', appName });
      }
    } else if (!bot.allowedChatIds.includes(cid)) {
      return;
    }
  }
  // Backend (routes.js) subscribers.
  const handlers = updateHandlers.get(appName);
  if (handlers) {
    const guard = require('./app-guard');
    const from = update.message?.from?.id ?? update.callback_query?.from?.id ?? update.edited_message?.from?.id ?? null;
    const principal = from != null ? `tg:${from}` : null;
    for (const h of handlers) guard.run(appName, 'telegram.onUpdate', () => spendContext.run({ app: appName, origin: 'bot', principal }, () => h(update)));
  }
  // Frontend iframe via the existing app:bridge:event bus.
  if (broadcaster) {
    broadcaster.broadcast({ type: 'app:bridge:event', appName, event: 'telegram:update', data: update });
  }
}

// --- Long-poll supervisor ---

// The mode a bot is consumed in right now: its configured mode, except a
// webhook bot in fallback (its webhook deleted, tunnel down) is polled.
function effectiveMode(appName) {
  const fb = fallbacks.get(appName);
  if (fb && !fb.recovering) return 'poll';
  return config.apps[appName]?.mode || null;
}

async function pollLoop(appName, poller) {
  let backoff = 1000;
  while (poller.active) {
    const bot = config.apps[appName];
    if (!bot || effectiveMode(appName) !== 'poll') break;
    try {
      const res = await apiCall(bot.token, 'getUpdates', {
        offset: bot.offset || 0,
        timeout: 50,
        allowed_updates: ['message', 'edited_message', 'callback_query', 'inline_query'],
      }, 60000, poller.abort.signal);
      if (res.ok && Array.isArray(res.result)) {
        backoff = 1000;
        if (res.result.length) {
          for (const update of res.result) {
            bot.offset = update.update_id + 1;
            dispatchUpdate(appName, update);
          }
          saveConfig(); // persist cursor — survives GUI/server reloads
        }
      } else if (!res.ok) {
        // 409 = a webhook is set; drop to webhook mode and stop polling.
        // EXCEPT when this loop was already told to stop (active=false):
        // poll ownership just moved to another process (a standalone or
        // dashboard-managed own-process runner), and the 409 is our
        // in-flight getUpdates being superseded by the new owner — flipping
        // the shared mode to 'webhook' would silently kill the bot.
        // A fallback ends too: someone registered a webhook; the delivery
        // monitor re-judges it on its next check.
        if (res.error_code === 409) {
          if (poller.active) {
            fallbacks.delete(appName);
            bot.mode = 'webhook';
            saveConfig();
          }
          break;
        }
        await sleep(backoff, poller.abort.signal);
        backoff = Math.min(backoff * 2, 30000);
      }
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') continue;
      await sleep(backoff, poller.abort.signal);
      backoff = Math.min(backoff * 2, 30000);
    }
  }
  if (pollers.get(appName) === poller) pollers.delete(appName);
}

function startPolling(appName) {
  if (pollers.get(appName)?.active) return;
  const poller = { active: true, abort: new AbortController(), done: null };
  pollers.set(appName, poller);
  poller.done = pollLoop(appName, poller).catch(() => {
    if (pollers.get(appName) === poller) pollers.delete(appName);
  });
}

function stopPolling(appName) {
  const p = pollers.get(appName);
  if (p) { p.active = false; p.abort.abort(); }
}

// Stop a running poll loop and wait until it is gone: the in-flight
// getUpdates is aborted, then the offset the loop reached is confirmed with
// short getUpdates calls (whatever they still return is dispatched), so an
// update is never handed out twice once a webhook takes over.
async function quiescePolling(appName) {
  const p = pollers.get(appName);
  if (!p) return;
  stopPolling(appName);
  await p.done;
  const bot = config.apps[appName];
  if (!bot) return;
  for (let i = 0; i < 5; i++) {
    let res;
    try {
      res = await apiCall(bot.token, 'getUpdates', { offset: bot.offset || 0, timeout: 0 }, 10000);
    } catch { return; }
    if (!res?.ok || !Array.isArray(res.result) || !res.result.length) return;
    for (const update of res.result) {
      bot.offset = update.update_id + 1;
      dispatchUpdate(appName, update);
    }
    saveConfig();
  }
}

// Reconcile live poll loops with the registry: poll-mode bots get a loop,
// everyone else is stopped. `appFilter` (set via start) scopes which apps this
// process may poll — a bot token allows ONE getUpdates consumer, so a bot
// owned by a standalone runner must never also be polled by the dashboard.
function syncPolling() {
  if (!started) return;
  for (const appName of Object.keys(config.apps)) {
    if (effectiveMode(appName) === 'poll' && owns(appName)) startPolling(appName);
    else stopPolling(appName);
  }
  for (const appName of pollers.keys()) {
    if (effectiveMode(appName) !== 'poll' || !owns(appName)) stopPolling(appName);
  }
}

let appFilter = null;
const owns = (appName) => !appFilter || appFilter(appName);

// --- Delivery monitor: webhook → long-poll fallback ---
// A webhook needs the public URL (an ngrok tunnel on the owner's PC) to be
// reachable from Telegram; long-poll needs only outbound HTTPS. Every
// CHECK_MS (and right at start) this process checks the webhook bots it owns:
//   - the public URL is probed once (POST to a bot's webhook path without
//     the secret — our own route answers 403; a dead tunnel answers anything
//     else or nothing);
//   - each webhook bot's getWebhookInfo: updates pending with a recent
//     delivery error mean Telegram cannot reach us, whatever the probe saw.
// Broken → deleteWebhook (pending updates kept) and poll. Healthy again →
// stop the poll loop, confirm its offset, setWebhook. The fallback lives in
// memory only: the configured mode stays 'webhook', a restart re-checks.

const CHECK_MS = 60 * 1000;
const ERROR_WINDOW_MS = 10 * 60 * 1000;   // a delivery error this recent counts
const ERROR_HOLD_MS = 10 * 60 * 1000;     // poll this long after Telegram-reported errors
// appName → { since, reason, holdUntil, recovering }
const fallbacks = new Map();
// appName → when this process last registered its webhook
const webhookSetAt = new Map();
// appName → { at, ok, reason } — the monitor's last verdict on that bot
const lastChecks = new Map();
let checkTimer = null;
let checking = null;

// `monitored` false = another process (the app's own runner) consumes and
// watches this bot; its fallback state is not visible here.
function inboundOf(appName) {
  const fb = fallbacks.get(appName);
  return {
    inbound: effectiveMode(appName),
    fallback: fb && !fb.recovering ? { since: fb.since, reason: fb.reason } : null,
    lastCheck: lastChecks.get(appName) || null,
    monitored: started && owns(appName),
  };
}

const noteCheck = (appName, ok, reason) => lastChecks.set(appName, { at: Date.now(), ok: !!ok, reason: reason || null });

// One probe of the public URL, through the tunnel to our own webhook route.
async function probePublicUrl(appName) {
  const base = getPublicUrl().replace(/\/+$/, '');
  if (!base) return { ok: false, reason: 'no public URL' };
  try {
    const res = await fetch(`${base}${webhookPath(appName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 403) return { ok: true };
    return { ok: false, reason: `public URL answered HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: `public URL unreachable (${err.cause?.code || err.name || err.message})` };
  }
}

async function enterFallback(appName, reason, holdMs) {
  const bot = config.apps[appName];
  if (!bot || fallbacks.has(appName)) return false;
  // Polling while a webhook is registered 409s — the webhook must go first.
  // drop_pending_updates stays off: what queued up while the tunnel was down
  // is fetched by the first getUpdates.
  let res;
  try { res = await apiCall(bot.token, 'deleteWebhook', { drop_pending_updates: false }, 10000); }
  catch (err) { console.warn(`[telegram] "${appName}": webhook unreachable (${reason}) but deleteWebhook failed: ${err.message}`); return false; }
  if (!res?.ok) { console.warn(`[telegram] "${appName}": webhook unreachable (${reason}) but deleteWebhook failed: ${res?.description || 'unknown'}`); return false; }
  const now = Date.now();
  fallbacks.set(appName, { since: now, reason, holdUntil: now + (holdMs || 0), recovering: false });
  webhookSetAt.delete(appName);
  console.warn(`[telegram] "${appName}": webhook → poll (${reason})`);
  if (broadcaster) broadcaster.broadcast({ type: 'app:setup:accountsChanged', change: 'telegram.inbound', appName, inbound: 'poll', reason });
  syncPolling();
  return true;
}

async function leaveFallback(appName) {
  const fb = fallbacks.get(appName);
  if (!fb) return false;
  fb.recovering = true;   // effectiveMode → 'webhook': no poll loop restarts meanwhile
  const r = await enableWebhook(appName).catch((err) => ({ ok: false, error: err.message }));
  if (!r.ok) {
    if (fallbacks.get(appName) === fb) fb.recovering = false;
    // setWebhook failed, so no webhook is registered: polling is safe.
    syncPolling();
    console.warn(`[telegram] "${appName}": public URL answers again but setWebhook failed (${r.error}); staying on poll`);
    return false;
  }
  console.log(`[telegram] "${appName}": poll → webhook (public URL reachable again)`);
  if (broadcaster) broadcaster.broadcast({ type: 'app:setup:accountsChanged', change: 'telegram.inbound', appName, inbound: 'webhook' });
  return true;
}

// Telegram's own view of a registered webhook: is delivery failing now?
function webhookFailing(appName, info) {
  if (!info?.last_error_date || !(info.pending_update_count > 0)) return null;
  const at = info.last_error_date * 1000;
  if (at < Date.now() - ERROR_WINDOW_MS || at < (webhookSetAt.get(appName) || 0)) return null;
  return `Telegram cannot deliver: ${info.last_error_message || 'webhook error'}`;
}

async function runDeliveryCheck(only) {
  const base = getPublicUrl().replace(/\/+$/, '');
  const owned = Object.keys(config.apps).filter((n) => owns(n) && (!only || n === only));
  // Without a public URL every bot polls (setPublicUrl → disableWebhook).
  if (!base) {
    for (const appName of owned) if (fallbacks.has(appName)) fallbacks.delete(appName);
    syncPolling();
    return;
  }
  const watched = owned.filter((n) => config.apps[n].mode === 'webhook' || fallbacks.has(n));
  if (!watched.length) return;
  const probe = await probePublicUrl(watched[0]);
  for (const appName of watched) {
    if (!started) return;
    const bot = config.apps[appName];
    if (!bot) continue;
    const fb = fallbacks.get(appName);
    if (fb) {
      if (fb.recovering) continue;
      const held = Date.now() < fb.holdUntil;
      noteCheck(appName, probe.ok, probe.ok ? (held ? `public URL answers; held on poll after: ${fb.reason}` : null) : probe.reason);
      if (probe.ok && !held) await leaveFallback(appName);
      else syncPolling(); // keep the poll loop alive
      continue;
    }
    if (!probe.ok) {
      noteCheck(appName, false, probe.reason || 'tunnel unreachable');
      await enterFallback(appName, probe.reason || 'tunnel unreachable');
      continue;
    }
    let info;
    try { info = await apiCall(bot.token, 'getWebhookInfo', {}, 10000); }
    catch (err) { noteCheck(appName, false, `getWebhookInfo failed: ${err.message}`); continue; }
    if (!info?.ok) { noteCheck(appName, false, `getWebhookInfo failed: ${info?.description || 'unknown'}`); continue; }
    const failing = webhookFailing(appName, info.result);
    noteCheck(appName, !failing, failing);
    if (failing) { await enterFallback(appName, failing, ERROR_HOLD_MS); continue; }
    // Configured for webhook but none (or another URL) registered: nobody
    // consumes the bot. The URL answers, so register ours.
    if (info.result?.url !== `${base}${webhookPath(appName)}`) {
      const r = await enableWebhook(appName).catch((err) => ({ ok: false, error: err.message }));
      console.warn(`[telegram] "${appName}": webhook was ${info.result?.url ? `set to another URL` : 'not registered'}; re-registered${r.ok ? '' : ` — failed: ${r.error}`}`);
    }
  }
}

// One check now; a check already running is joined, never doubled. With
// `appName`, only that bot is checked (after a running check finishes).
function checkDelivery(appName) {
  if (!started) return Promise.resolve();
  if (checking) return appName ? checking.then(() => checkDelivery(appName)) : checking;
  checking = runDeliveryCheck(appName)
    .catch((err) => console.warn(`[telegram] delivery check failed: ${err.message}`))
    .finally(() => { checking = null; });
  return checking;
}

// The dashboard's "check now" (owner-authed WS): check one bot's delivery and
// return its fresh status. A bot another process consumes is checked there.
// Bounded: a check slower than CHECK_NOW_MAX_MS (dead probe + Bot API
// timeouts) answers with the status so far and `pending: true`; the check
// finishes on its own and its switch is pushed (`telegram.inbound`).
const CHECK_NOW_MAX_MS = 12 * 1000;
async function checkNow(appName, { maxMs = CHECK_NOW_MAX_MS } = {}) {
  if (!config.apps[appName]) return { ok: false, error: 'No bot configured' };
  if (!started || !owns(appName)) {
    return { ok: false, error: 'This bot is consumed by its app\'s own process; its delivery is checked there', status: status(appName) };
  }
  let timer;
  try {
    const finished = await Promise.race([
      checkDelivery(appName).then(() => true),
      new Promise((r) => { timer = setTimeout(() => r(false), maxMs); }),
    ]);
    return { ok: true, status: status(appName), ...(finished ? {} : { pending: true }) };
  } catch (err) {
    return { ok: false, error: `Delivery check failed: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

function kickDeliveryCheck() {
  if (started) checkDelivery();
}

function start(filter) {
  if (filter !== undefined) appFilter = filter;
  started = true;
  syncPolling();
  if (!checkTimer) {
    checkTimer = setInterval(() => { checkDelivery(); }, CHECK_MS);
    checkTimer.unref?.();
  }
  // At boot a dead tunnel is found now, not one interval later.
  checkDelivery();
}

function shutdown() {
  started = false;
  if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
  for (const appName of pollers.keys()) stopPolling(appName);
}

async function downloadFile(appName, fileId) {
  const token = getToken(appName);
  if (!token) throw new Error(`No Telegram bot configured for app "${appName}"`);
  const res = await apiCall(token, 'getFile', { file_id: fileId }, 15000);
  if (!res.ok) throw new Error(res.description || 'getFile failed');
  const url = `https://api.telegram.org/file/bot${token}/${res.result.file_path}`;
  const dl = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!dl.ok) throw new Error(`File download failed: ${dl.status}`);
  const buffer = Buffer.from(await dl.arrayBuffer());
  return { buffer, contentType: dl.headers.get('content-type'), filePath: res.result.file_path };
}

// Normalize a raw Telegram Update into the flat, channel-neutral shape delivered
// as ctx.telegram.onUpdate's second arg — the mirror of whatsapp.normalizeMessage,
// so a channel-agnostic handler sees ONE shape on both channels. Deliberately
// minimal (text + button selection + chatId/userId); everything else is `.raw`.
// Applied by the telegram capability module (src/apps/capabilities/telegram.js);
// dispatchUpdate itself still hands handlers only the raw update.
function normalizeTelegramUpdate(u) {
  const msg = u?.message || u?.edited_message || null;
  const cq = u?.callback_query || null;
  const chatId = msg?.chat?.id ?? cq?.message?.chat?.id ?? null;
  const from = msg?.from || cq?.from || null;
  let text = null;
  let type = 'other';
  let selection = null;
  let media = null;
  if (cq) { selection = { id: cq.data, title: null }; text = cq.data ?? null; type = 'button'; }
  else if (msg?.text != null) { text = msg.text; type = 'text'; }
  else if (msg?.voice) { type = 'voice'; media = { file_id: msg.voice.file_id, duration: msg.voice.duration, mime_type: msg.voice.mime_type || 'audio/ogg' }; }
  else if (msg?.audio) { type = 'audio'; media = { file_id: msg.audio.file_id, duration: msg.audio.duration, mime_type: msg.audio.mime_type || 'audio/mpeg' }; }
  else if (msg?.video_note) { type = 'video_note'; media = { file_id: msg.video_note.file_id, duration: msg.video_note.duration, mime_type: 'video/mp4' }; }
  else if (msg?.photo) type = 'image';
  return {
    channel: 'telegram',
    chatId,
    userId: from?.id != null ? String(from.id) : null,
    name: from ? [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || null : null,
    text,
    type,
    selection,
    media,
    messageId: msg?.message_id ?? null,
    raw: u,
  };
}

// The webhook route's check of Telegram's X-Telegram-Bot-Api-Secret-Token
// header against this bot's secret, in constant time.
function webhookSecretOk(bot, headerValue) {
  return require('./secret-equal').secretEqual(headerValue, bot?.webhookSecret);
}

module.exports = {
  webhookSecretOk,
  normalizeTelegramUpdate,
  init, start, shutdown, syncPolling, checkDelivery, checkNow,
  setBot, removeBot, hasBot, getBot, getToken, listBots, status,
  setRestricted, removeAllowedChat, isAllowed, ownerUserId, isLoginStart,
  claimedOwner, isOwnerAct, createClaimCode, redeemClaim, isClaimStart, CLAIM_TTL_MS,
  send, call, sendPhoto, sendAudio, sendDocument, downloadFile,
  getPublicUrl, setPublicUrl, webhookPath, webAppUrl, entryUrl,
  enableWebhook, disableWebhook, renameApp,
  registerUpdateHandler, clearUpdateHandlers, dispatchUpdate,
};
