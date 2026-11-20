const path = require('path');
const crypto = require('crypto');
const spendContext = require('./spend-context');

// Per-app WhatsApp Cloud API integration. One encrypted registry keyed by app
// name (mirrors telegram.js / google-auth.js / email-accounts.js). Each app owns
// its own WhatsApp Business phone number + access token; the platform receives
// inbound messages via a single public webhook per app and routes them back to
// the owning app by name.
//
// Unlike Telegram, the Cloud API has NO long-poll: inbound is webhook-only, so a
// public callback URL is mandatory (configured in Meta's App dashboard, not here).
// The `mode` field is always 'webhook'; there is no poll supervisor.
//
// Graph API is pinned at v21.0. Outbound messages POST to
//   https://graph.facebook.com/v21.0/<phoneNumberId>/messages
// Inbound webhooks are verified two ways: a GET hub.challenge handshake at
// registration (hub.verify_token === the app's verifyToken) and a per-POST
// X-Hub-Signature-256 HMAC over the raw body keyed by the app's appSecret. Both
// live in index.js; this module owns the registry, dispatch, and transport.

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

let appsDir = null;
let secretStore = null;
let broadcaster = null;
let config = { apps: {} };

// appName → Set<handler> — backend (routes.js) inbound subscribers.
const updateHandlers = new Map();
let started = false;

function configPath() {
  return path.join(appsDir, '.whatsapp.enc');
}

function loadConfig() {
  const cfg = secretStore.readSecretFile(configPath(), appsDir, {
    fallback: { apps: {} },
  });
  if (!cfg.apps) cfg.apps = {};
  return cfg;
}

function saveConfig() {
  secretStore.writeSecretFile(configPath(), config, appsDir);
}

function init(dir, store, bc) {
  appsDir = dir;
  secretStore = store;
  broadcaster = bc;
  config = loadConfig();
}

// --- Low-level Graph API ---

// JSON Graph call against an arbitrary path (e.g. `<phoneNumberId>/messages`).
async function graphCall(token, apiPath, method, body, timeoutMs) {
  if (!token) throw new Error('No access token');
  const url = `${GRAPH_BASE}/${apiPath}`;
  const res = await fetch(url, {
    method: method || 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  return res.json();
}

// Post a fully-formed message object to <phoneNumberId>/messages. Every send
// helper funnels through here so messaging_product is stamped exactly once.
async function postMessage(account, message, timeoutMs) {
  return graphCall(
    account.accessToken,
    `${account.phoneNumberId}/messages`,
    'POST',
    { messaging_product: 'whatsapp', ...message },
    timeoutMs || 20000,
  );
}

// --- Account registration ---

async function setAccount(appName, creds) {
  if (!appName) return { ok: false, error: 'App name is required' };
  const phoneNumberId = (creds?.phoneNumberId || '').trim();
  const accessToken = (creds?.accessToken || '').trim();
  const appSecret = (creds?.appSecret || '').trim();
  if (!phoneNumberId) return { ok: false, error: 'Phone Number ID is required' };

  // When editing an existing account, allow blank token/secret to keep current values.
  const existing = config.apps[appName] || {};
  const finalToken = accessToken || existing.accessToken || '';
  const finalSecret = appSecret || existing.appSecret || '';
  if (!finalToken) return { ok: false, error: 'Access token is required' };
  if (!finalSecret) return { ok: false, error: 'App secret is required' };

  // Validate the token + phone number id by reading the phone number node.
  let probe;
  try {
    probe = await graphCall(finalToken, `${phoneNumberId}`, 'GET', null, 15000);
  } catch (err) {
    return { ok: false, error: `Could not reach WhatsApp Cloud API: ${err.message}` };
  }
  if (probe?.error) {
    return { ok: false, error: probe.error.message || 'Invalid phone number id or token' };
  }

  config.apps[appName] = {
    phoneNumberId,
    accessToken: finalToken,
    appSecret: finalSecret,
    wabaId: (creds?.wabaId || existing.wabaId || '').trim(),
    displayPhone: probe?.display_phone_number || existing.displayPhone || '',
    verifiedName: probe?.verified_name || existing.verifiedName || '',
    // Verify token for the GET webhook handshake. Generated once, surfaced in the
    // setup UI for the user to paste into Meta's webhook config.
    verifyToken: existing.verifyToken || crypto.randomBytes(24).toString('hex'),
    mode: 'webhook',
    restricted: existing.restricted || false,
    allowedChatIds: existing.allowedChatIds || [],
    addedAt: existing.addedAt || Date.now(),
  };
  saveConfig();

  return {
    ok: true,
    phoneNumberId,
    displayPhone: config.apps[appName].displayPhone,
    verifyToken: config.apps[appName].verifyToken,
  };
}

async function removeAccount(appName) {
  const acct = config.apps[appName];
  if (!acct) return { ok: false, error: 'No WhatsApp account configured for this app' };
  delete config.apps[appName];
  saveConfig();
  return { ok: true };
}

// Re-key an app's WhatsApp account on app rename. The Meta webhook callback URL
// (/pro/whatsapp/<app>/webhook) embeds the app name and can only be changed in
// the Meta developer dashboard — callers must surface that manual step.
function renameApp(oldName, newName) {
  const acct = config.apps[oldName];
  if (!acct) return { moved: false };
  config.apps[newName] = acct;
  delete config.apps[oldName];
  saveConfig();
  const handlers = updateHandlers.get(oldName);
  if (handlers) {
    updateHandlers.set(newName, handlers);
    updateHandlers.delete(oldName);
  }
  return { moved: true, displayPhone: acct.displayPhone || null };
}

function getAccount(appName) {
  return config.apps[appName] || null;
}

function hasAccount(appName) {
  return !!config.apps[appName];
}

// Reverse lookup: which app owns a given inbound phone_number_id. Guards against
// a misconfigured Meta App pointing one number at the wrong app's webhook path.
function getByPhoneNumberId(phoneNumberId) {
  for (const [appName, a] of Object.entries(config.apps)) {
    if (a.phoneNumberId === String(phoneNumberId)) return { appName, account: a };
  }
  return null;
}

function listAccounts() {
  return Object.entries(config.apps).map(([appName, a]) => ({
    appName,
    phoneNumberId: a.phoneNumberId,
    displayPhone: a.displayPhone || null,
    verifiedName: a.verifiedName || null,
    wabaId: a.wabaId || null,
    mode: a.mode,
    restricted: !!a.restricted,
    allowedChatIds: a.allowedChatIds || [],
    verifyToken: a.verifyToken || null,
    addedAt: a.addedAt,
  }));
}

// Toggle access restriction. Enabling with an empty allowlist arms claim-on-first
// (the first wa_id to message claims the bot); disabling leaves the allowlist
// intact but stops enforcing it. Mirrors telegram.js.
function setRestricted(appName, restricted) {
  const acct = config.apps[appName];
  if (!acct) return { ok: false, error: 'No WhatsApp account configured for this app' };
  acct.restricted = !!restricted;
  saveConfig();
  return { ok: true, restricted: acct.restricted };
}

function removeAllowedChat(appName, chatId) {
  const acct = config.apps[appName];
  if (!acct) return { ok: false, error: 'No WhatsApp account configured for this app' };
  const cid = String(chatId);
  acct.allowedChatIds = (acct.allowedChatIds || []).filter((c) => String(c) !== cid);
  saveConfig();
  return { ok: true, allowedChatIds: acct.allowedChatIds };
}

// Is this chat (wa_id) permitted? Mirrors the inbound dispatch policy but never
// claims-on-first. Unrestricted → open to everyone; restricted → only ids already
// on the allowlist.
function isAllowed(appName, chatId) {
  const acct = config.apps[appName];
  if (!acct) return false;
  if (!acct.restricted) return true;
  const cid = String(chatId);
  return (acct.allowedChatIds || []).some((c) => String(c) === cid);
}

function status(appName) {
  if (appName) {
    const a = config.apps[appName];
    return {
      configured: !!a,
      phoneNumberId: a?.phoneNumberId || null,
      displayPhone: a?.displayPhone || null,
      verifiedName: a?.verifiedName || null,
      wabaId: a?.wabaId || null,
      mode: a?.mode || null,
      restricted: !!a?.restricted,
      allowedChatIds: a?.allowedChatIds || [],
      verifyToken: a?.verifyToken || null,
    };
  }
  return { accounts: listAccounts() };
}

function getAccessToken(appName) {
  return config.apps[appName]?.accessToken || null;
}

// --- Outbound: symmetric surface (mirrors telegram.js send/call/sendPhoto) ---

// Send a plain text message. Signature mirrors telegram.send(chatId, text, opts).
// `opts` may carry { previewUrl } and is otherwise reserved for future fields.
async function send(appName, chatId, text, opts) {
  const acct = config.apps[appName];
  if (!acct) throw new Error(`No WhatsApp account configured for app "${appName}"`);
  if (chatId == null) throw new Error('send: chatId required');
  return postMessage(acct, {
    to: String(chatId),
    type: 'text',
    text: { body: String(text == null ? '' : text), preview_url: !!(opts && opts.previewUrl) },
  });
}

// Raw escape hatch. `method` is an action verb; `params` the message object (minus
// messaging_product, which postMessage stamps). Mirrors telegram.call shape but
// maps onto the single /messages endpoint plus a few read/lookup verbs.
async function call(appName, method, params) {
  const acct = config.apps[appName];
  if (!acct) throw new Error(`No WhatsApp account configured for app "${appName}"`);
  switch (method) {
    case 'sendMessage':
    case 'messages':
      return postMessage(acct, params || {});
    case 'getPhoneNumber':
      return graphCall(acct.accessToken, `${acct.phoneNumberId}`, 'GET', null, 15000);
    default:
      // Treat an unknown method as a message-type shorthand: call('image', {...}).
      return postMessage(acct, { type: method, to: params?.to, [method]: params?.[method] ?? params });
  }
}

// --- Media (two-step: upload buffer -> media id -> send by id) ---

async function uploadMedia(appName, { buffer, contentType, filename } = {}) {
  const acct = config.apps[appName];
  if (!acct) throw new Error(`No WhatsApp account configured for app "${appName}"`);
  if (!buffer) throw new Error('uploadMedia: buffer required');
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  const blob = new Blob([buffer], { type: contentType || 'application/octet-stream' });
  form.append('file', blob, filename || 'file');
  const res = await fetch(`${GRAPH_BASE}/${acct.phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${acct.accessToken}` },
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  return res.json();
}

async function downloadMedia(appName, mediaId) {
  const acct = config.apps[appName];
  if (!acct) throw new Error(`No WhatsApp account configured for app "${appName}"`);
  const meta = await graphCall(acct.accessToken, `${mediaId}`, 'GET', null, 15000);
  if (!meta?.url) throw new Error(meta?.error?.message || 'media url unavailable');
  const res = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${acct.accessToken}` },
    signal: AbortSignal.timeout(30000),
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType: meta.mime_type || res.headers.get('content-type'), meta };
}

// Coerce a caller-supplied photo into either an http(s) URL/media-id reference or
// an upload buffer. Accepts Buffer, data-URI, bare base64, or URL/media-id string.
function resolveMedia(photo) {
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
    if (/^https?:\/\//i.test(photo)) return { link: photo };
    if (/^\d+$/.test(photo)) return { id: photo }; // numeric media id
    return { buffer: Buffer.from(photo, 'base64'), contentType: 'image/png' };
  }
  throw new Error('sendPhoto: unsupported `photo` value');
}

// Send a photo. `photo` may be a Buffer / data-URI / base64 (uploaded to /media
// first) or an http(s) URL / media-id (sent by reference). Signature mirrors
// telegram.sendPhoto({ chatId, photo, caption?, options? }).
async function sendPhoto(appName, { chatId, photo, caption, options } = {}) {
  const acct = config.apps[appName];
  if (!acct) throw new Error(`No WhatsApp account configured for app "${appName}"`);
  if (chatId == null) throw new Error('sendPhoto: chatId required');
  if (photo == null) throw new Error('sendPhoto: photo required');

  const resolved = resolveMedia(photo);
  let image;
  if (resolved.link) image = { link: resolved.link };
  else if (resolved.id) image = { id: resolved.id };
  else {
    const up = await uploadMedia(appName, {
      buffer: resolved.buffer,
      contentType: resolved.contentType,
      filename: resolved.filename || 'photo.png',
    });
    if (!up?.id) throw new Error(up?.error?.message || 'media upload failed');
    image = { id: up.id };
  }
  if (caption != null) image.caption = String(caption);
  return postMessage(acct, { to: String(chatId), type: 'image', image: { ...image, ...(options || {}) } });
}

// --- WhatsApp-only interactive messages (no Telegram analog) ---
//
// These map onto the Cloud API `interactive` message type. Each enforces WA's
// hard limits up front with a clear error rather than letting Graph reject with
// an opaque code. `chatId` is the recipient wa_id.

function acct(appName) {
  const a = config.apps[appName];
  if (!a) throw new Error(`No WhatsApp account configured for app "${appName}"`);
  return a;
}

// Reply buttons: up to 3, title <= 20 chars. Beyond 3, the caller should use a
// list — we refuse rather than silently truncate.
async function sendButtons(appName, chatId, { text, buttons, header, footer } = {}) {
  const a = acct(appName);
  if (chatId == null) throw new Error('sendButtons: chatId required');
  if (!text) throw new Error('sendButtons: text required');
  if (!Array.isArray(buttons) || !buttons.length) throw new Error('sendButtons: buttons[] required');
  if (buttons.length > 3) throw new Error('sendButtons: WhatsApp allows at most 3 reply buttons — use sendList for more');
  const action = {
    buttons: buttons.map((b) => {
      const title = String(b.title ?? '');
      if (!b.id) throw new Error('sendButtons: each button needs an id');
      if (title.length > 20) throw new Error(`sendButtons: button title "${title}" exceeds 20 chars`);
      return { type: 'reply', reply: { id: String(b.id), title } };
    }),
  };
  const interactive = { type: 'button', body: { text: String(text) }, action };
  if (header) interactive.header = { type: 'text', text: String(header) };
  if (footer) interactive.footer = { text: String(footer) };
  return postMessage(a, { to: String(chatId), type: 'interactive', interactive });
}

// List menu: up to 10 sections, 10 rows TOTAL across all sections; row title
// <= 24 chars, description <= 72.
async function sendList(appName, chatId, { text, button, sections, header, footer } = {}) {
  const a = acct(appName);
  if (chatId == null) throw new Error('sendList: chatId required');
  if (!text) throw new Error('sendList: text required');
  if (!Array.isArray(sections) || !sections.length) throw new Error('sendList: sections[] required');
  if (sections.length > 10) throw new Error('sendList: WhatsApp allows at most 10 sections');
  let rowCount = 0;
  const outSections = sections.map((s) => {
    const rows = (s.rows || []).map((r) => {
      if (!r.id) throw new Error('sendList: each row needs an id');
      const title = String(r.title ?? '');
      if (title.length > 24) throw new Error(`sendList: row title "${title}" exceeds 24 chars`);
      rowCount++;
      const row = { id: String(r.id), title };
      if (r.description != null) {
        const d = String(r.description);
        if (d.length > 72) throw new Error('sendList: row description exceeds 72 chars');
        row.description = d;
      }
      return row;
    });
    return { title: s.title ? String(s.title) : undefined, rows };
  });
  if (rowCount > 10) throw new Error('sendList: WhatsApp allows at most 10 rows total across all sections');
  const interactive = {
    type: 'list',
    body: { text: String(text) },
    action: { button: String(button || 'Menu'), sections: outSections },
  };
  if (header) interactive.header = { type: 'text', text: String(header) };
  if (footer) interactive.footer = { text: String(footer) };
  return postMessage(a, { to: String(chatId), type: 'interactive', interactive });
}

// Single call-to-action URL button.
async function sendCta(appName, chatId, { text, title, url, header, footer } = {}) {
  const a = acct(appName);
  if (chatId == null) throw new Error('sendCta: chatId required');
  if (!text) throw new Error('sendCta: text required');
  if (!title || !url) throw new Error('sendCta: title and url required');
  const interactive = {
    type: 'cta_url',
    body: { text: String(text) },
    action: { name: 'cta_url', parameters: { display_text: String(title), url: String(url) } },
  };
  if (header) interactive.header = { type: 'text', text: String(header) };
  if (footer) interactive.footer = { text: String(footer) };
  return postMessage(a, { to: String(chatId), type: 'interactive', interactive });
}

async function sendLocation(appName, chatId, { lat, long, latitude, longitude, name, address } = {}) {
  const a = acct(appName);
  if (chatId == null) throw new Error('sendLocation: chatId required');
  const location = {
    latitude: Number(lat ?? latitude),
    longitude: Number(long ?? longitude),
  };
  if (name) location.name = String(name);
  if (address) location.address = String(address);
  return postMessage(a, { to: String(chatId), type: 'location', location });
}

async function requestLocation(appName, chatId, { text } = {}) {
  const a = acct(appName);
  if (chatId == null) throw new Error('requestLocation: chatId required');
  return postMessage(a, {
    to: String(chatId),
    type: 'interactive',
    interactive: { type: 'location_request_message', body: { text: String(text || 'Please share your location') }, action: { name: 'send_location' } },
  });
}

// Generic media send for document/video/audio/sticker. `media` accepts the same
// shapes as sendPhoto's photo (Buffer/data-URI/base64/url/media-id).
async function sendMedia(appName, chatId, { type, media, caption, filename, options } = {}) {
  const a = acct(appName);
  if (chatId == null) throw new Error('sendMedia: chatId required');
  if (!type) throw new Error('sendMedia: type required (document|video|audio|sticker|image)');
  if (media == null) throw new Error('sendMedia: media required');
  const resolved = resolveMedia(media);
  let node;
  if (resolved.link) node = { link: resolved.link };
  else if (resolved.id) node = { id: resolved.id };
  else {
    const up = await uploadMedia(appName, { buffer: resolved.buffer, contentType: resolved.contentType, filename: filename || 'file' });
    if (!up?.id) throw new Error(up?.error?.message || 'media upload failed');
    node = { id: up.id };
  }
  if (caption != null && type !== 'audio' && type !== 'sticker') node.caption = String(caption);
  if (filename && type === 'document') node.filename = String(filename);
  return postMessage(a, { to: String(chatId), type, [type]: { ...node, ...(options || {}) } });
}

async function react(appName, chatId, messageId, emoji) {
  const a = acct(appName);
  if (chatId == null) throw new Error('react: chatId required');
  if (!messageId) throw new Error('react: messageId required');
  return postMessage(a, { to: String(chatId), type: 'reaction', reaction: { message_id: String(messageId), emoji: emoji || '' } });
}

async function markRead(appName, messageId) {
  const a = acct(appName);
  if (!messageId) throw new Error('markRead: messageId required');
  return graphCall(a.accessToken, `${a.phoneNumberId}/messages`, 'POST', {
    messaging_product: 'whatsapp', status: 'read', message_id: String(messageId),
  }, 15000);
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

// Normalize one inbound Cloud API message into the flat, channel-neutral shape
// delivered as onUpdate's second arg. Deliberately minimal — text + button/list
// selection + chatId/userId; everything else is read from `.raw`. Mirrors the
// Telegram normalizer in app-manager.js so a channel-agnostic handler sees one
// shape on both channels.
function normalizeMessage(msg, contacts) {
  const chatId = msg?.from || null;
  let text = null;
  let type = msg?.type || 'other';
  let selection = null;

  if (msg?.type === 'text') text = msg.text?.body ?? null;
  else if (msg?.type === 'interactive') {
    const ir = msg.interactive;
    if (ir?.type === 'button_reply') { selection = { id: ir.button_reply.id, title: ir.button_reply.title }; type = 'button'; }
    else if (ir?.type === 'list_reply') { selection = { id: ir.list_reply.id, title: ir.list_reply.title }; type = 'list'; }
    if (selection) text = selection.title;
  } else if (msg?.type === 'button') {
    // Template quick-reply button.
    selection = { id: msg.button?.payload, title: msg.button?.text };
    text = msg.button?.text ?? null;
    type = 'button';
  }

  const contact = Array.isArray(contacts) ? contacts.find((c) => c.wa_id === chatId) : null;
  return {
    channel: 'whatsapp',
    chatId,
    userId: chatId,
    name: contact?.profile?.name || null,
    text,
    type,
    selection,
    messageId: msg?.id || null,
    raw: msg,
  };
}

// chatId of an inbound webhook value's first message (for the restriction check).
function firstMessageFrom(value) {
  return value?.messages?.[0]?.from ?? null;
}

// Dispatch a single Cloud API webhook `change.value` to the owning app. A value
// may carry messages[] and/or statuses[] (delivery/read receipts).
function dispatchUpdate(appName, value) {
  const acct = config.apps[appName];
  if (!acct) return;

  // Delivery/read receipts → status event only (no restriction gating).
  if (Array.isArray(value?.statuses) && value.statuses.length) {
    if (broadcaster) {
      for (const st of value.statuses) {
        broadcaster.broadcast({ type: 'app:bridge:event', appName, event: 'whatsapp:status', data: st });
      }
    }
  }

  const messages = Array.isArray(value?.messages) ? value.messages : [];
  if (!messages.length) return;

  // Access restriction (claim-on-first), keyed on the first inbound wa_id.
  if (acct.restricted) {
    const cid = firstMessageFrom(value);
    if (cid == null) return;
    if (!acct.allowedChatIds?.length) {
      acct.allowedChatIds = [cid];
      saveConfig();
      if (broadcaster) {
        broadcaster.broadcast({ type: 'app:setup:accountsChanged', change: 'whatsapp.claimed', appName });
      }
    } else if (!acct.allowedChatIds.map(String).includes(String(cid))) {
      return;
    }
  }

  const handlers = updateHandlers.get(appName);
  for (const msg of messages) {
    const normalized = normalizeMessage(msg, value.contacts);
    if (handlers) {
      const guard = require('./app-guard');
      const waFrom = (normalized && (normalized.from || normalized.waId)) || (msg && msg.from) || null;
      for (const h of handlers) guard.run(appName, 'whatsapp.onUpdate', () => spendContext.run({ app: appName, origin: 'bot', principal: waFrom ? `wa:${waFrom}` : null }, () => h(msg, normalized)));
    }
    if (broadcaster) {
      broadcaster.broadcast({ type: 'app:bridge:event', appName, event: 'whatsapp:update', data: { message: msg, normalized } });
    }
  }
}

// Walk a full webhook body (entry[].changes[].value) and dispatch each value to
// the app it belongs to. `expectedApp` is the app from the webhook URL path; a
// value whose phone_number_id maps to a different app is dropped (misroute guard).
function dispatchWebhookBody(expectedApp, body) {
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      let appName = expectedApp;
      if (phoneNumberId) {
        const owner = getByPhoneNumberId(phoneNumberId);
        if (owner) appName = owner.appName;
      }
      if (appName !== expectedApp) {
        console.warn(`[whatsapp] webhook for "${expectedApp}" carried phone_number_id owned by "${appName}" — dropping`);
        continue;
      }
      dispatchUpdate(appName, value);
    }
  }
}

// --- Lifecycle (no poll supervisor — webhook-only) ---

function start() { started = true; }
function shutdown() { started = false; }

module.exports = {
  init, start, shutdown,
  GRAPH_VERSION,
  setAccount, removeAccount, renameApp, hasAccount, getAccount, getByPhoneNumberId,
  getAccessToken, listAccounts, status,
  setRestricted, removeAllowedChat, isAllowed,
  send, call, sendPhoto, uploadMedia, downloadMedia,
  sendButtons, sendList, sendCta, sendLocation, requestLocation, sendMedia, react, markRead,
  registerUpdateHandler, clearUpdateHandlers, dispatchUpdate, dispatchWebhookBody,
  normalizeMessage,
};
