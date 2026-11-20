// Platform-owned app identity. Apps no longer hand-roll Telegram initData
// validation, link-code stores, or dashboard session tokens — they call
// ctx.identity.* and get one resolved user, keyed by the Telegram user id.
//
// Three primitives, all scoped by appName so one app can never act as another:
//   1. validateInitData  — verify a Telegram WebApp initData HMAC against the
//      app's bot token (the cookieless mini-app boundary).
//   2. issueLinkCode / redeemLinkCode — short-lived 6-digit codes (secure RNG,
//      rate-limited redeem) that bridge a Telegram chat to the dashboard.
//   3. issueSession / verifySession — opaque platform-signed tokens the
//      dashboard frontend stores and replays (stateless; survive restarts).
//
// The durable identity is always the app's own user row (PK = Telegram user id).
// Link codes are in-memory and ephemeral by design — losing a pending code on
// restart just means the user re-runs /link; no data is lost.

const crypto = require('crypto');
const path = require('path');

let secretStore = null;
let appsDir = null;
let signingKey = null; // Buffer — HMAC key for session tokens, persisted across restarts.

// code -> { appName, userId, expiresAt }
const linkCodes = new Map();
// appName -> { count, resetAt } — redeem-attempt throttle.
const redeemThrottle = new Map();

const DEFAULT_LINK_TTL_MS = 10 * 60 * 1000;        // 10 minutes
const DEFAULT_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const DEFAULT_INITDATA_MAX_AGE_S = 24 * 60 * 60;   // 24 hours
const REDEEM_WINDOW_MS = 60 * 1000;
const REDEEM_MAX_PER_WINDOW = 10;

function configPath() {
  return path.join(appsDir, '.identity.enc');
}

// Load (or generate + persist) the HMAC signing key so session tokens issued
// before a restart remain valid afterwards (dashboard "stay signed in").
function init(dir, store) {
  appsDir = dir;
  secretStore = store;
  let cfg = {};
  try {
    cfg = secretStore.readSecretFile(configPath(), appsDir, { fallback: {} }) || {};
  } catch { cfg = {}; }
  if (!cfg.sessionKey || typeof cfg.sessionKey !== 'string') {
    cfg.sessionKey = crypto.randomBytes(32).toString('hex');
    try { secretStore.writeSecretFile(configPath(), cfg, appsDir); } catch {}
  }
  signingKey = Buffer.from(cfg.sessionKey, 'hex');
}

// --- 1. Telegram WebApp initData validation --------------------------------

// Verify an initData string per
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// Returns the parsed `user` object (with a numeric `id`) on success, else null.
// Enforces an auth_date freshness window to blunt replay of leaked initData.
function validateInitData(appName, initData, opts) {
  const botToken = require('./telegram').getToken(appName);
  if (!botToken || !initData) return null;
  let params;
  try { params = new URLSearchParams(initData); } catch { return null; }
  const hash = params.get('hash');
  if (!hash) return null;

  const pairs = [];
  for (const [k, v] of params) { if (k !== 'hash') pairs.push(`${k}=${v}`); }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex')); } catch { ok = false; }
  if (!ok) return null;

  // Freshness: reject initData older than the max-age window.
  const maxAgeS = opts && Number.isFinite(opts.maxAgeS) ? opts.maxAgeS : DEFAULT_INITDATA_MAX_AGE_S;
  if (maxAgeS > 0) {
    const authDate = Number(params.get('auth_date'));
    if (!Number.isFinite(authDate)) return null;
    const ageS = Math.floor(Date.now() / 1000) - authDate;
    if (ageS > maxAgeS || ageS < -300) return null; // allow small clock skew
  }

  try {
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || user.id == null) return null;
    return user;
  } catch { return null; }
}

// --- 2. Link codes (Telegram chat -> dashboard) ----------------------------

function sweep() {
  const now = Date.now();
  for (const [code, rec] of linkCodes) {
    if (rec.expiresAt <= now) linkCodes.delete(code);
  }
}

function genCode() {
  // 6-digit, cryptographically random (NOT Date.now-derived — that's guessable).
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// Issue a fresh code binding (appName, userId). Replaces any prior code for the
// same pair so a user only ever has one live code. Returns the code string.
// `opts.via` tags the channel the userId belongs to ('telegram' default, or
// 'whatsapp') so redemption can find-or-create the right credential. Defaulting
// to 'telegram' keeps existing callers unchanged.
function issueLinkCode(appName, userId, opts) {
  sweep();
  const uid = String(userId);
  const via = (opts && opts.via) || 'telegram';
  for (const [code, rec] of linkCodes) {
    if (rec.appName === appName && rec.userId === uid && rec.via === via) linkCodes.delete(code);
  }
  let code = genCode();
  let guard = 0;
  while (linkCodes.has(code) && guard++ < 50) code = genCode();
  const ttl = opts && Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_LINK_TTL_MS;
  linkCodes.set(code, { appName, userId: uid, via, expiresAt: Date.now() + ttl });
  return code;
}

function throttled(appName) {
  const now = Date.now();
  let t = redeemThrottle.get(appName);
  if (!t || t.resetAt <= now) { t = { count: 0, resetAt: now + REDEEM_WINDOW_MS }; redeemThrottle.set(appName, t); }
  t.count++;
  return t.count > REDEEM_MAX_PER_WINDOW;
}

// Redeem a code for this app. Scoped by appName (an app can't redeem another
// app's code). Rate-limited per app to make 6-digit codes brute-force-proof.
// Consumes the code on success. Returns { userId, via } (strings) or null.
function redeemLinkCode(appName, code) {
  if (throttled(appName)) return null;
  sweep();
  const rec = linkCodes.get(String(code || '').trim());
  if (!rec || rec.appName !== appName) return null;
  if (rec.expiresAt <= Date.now()) { linkCodes.delete(code); return null; }
  linkCodes.delete(String(code).trim());
  return { userId: rec.userId, via: rec.via || 'telegram' };
}

// --- 3. Session tokens (dashboard) -----------------------------------------

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Issue an opaque signed token wrapping { appName, userId }. Stateless — no
// server-side storage — so it survives restarts as long as the signing key does.
// `opts.via` tags the CHANNEL the userId belongs to ('telegram' | 'whatsapp'):
// a tagged token lets app-auth's guard map the id to an account by that
// channel; an untagged token's userId is an app-auth account id. There is no
// guessing between the two (a Telegram id must never resolve to a stranger's
// account row that happens to share the number).
const SESSION_CHANNELS = new Set(['telegram', 'whatsapp']);
function issueSession(appName, userId, opts) {
  if (!signingKey) throw new Error('app-identity not initialized');
  const ttl = opts && Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_SESSION_TTL_MS;
  const payload = { a: appName, u: String(userId), iat: Date.now(), exp: Date.now() + ttl };
  if (opts && SESSION_CHANNELS.has(opts.via)) payload.v = opts.via;
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', signingKey).update(body).digest());
  return `${body}.${sig}`;
}

// Verify a token for this app. Returns { userId, channel } (channel null for an
// untagged token) or null (bad sig, wrong app, expired, or malformed).
function verifySession(appName, token) {
  if (!signingKey || !token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(crypto.createHmac('sha256', signingKey).update(body).digest());
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { ok = false; }
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(body).toString('utf-8')); } catch { return null; }
  if (!payload || payload.a !== appName) return null;
  if (!Number.isFinite(payload.exp) || payload.exp <= Date.now()) return null;
  return { userId: payload.u, channel: SESSION_CHANNELS.has(payload.v) ? payload.v : null };
}

// --- 4. Password hashing + random tokens (email/password credential) -------

// scrypt-based password hashing — zero new deps (Node built-in crypto).
// Stored format: scrypt$<saltHex>$<hashHex>. Verification is constant-time.
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

function hashPassword(plain) {
  if (typeof plain !== 'string' || !plain) throw new Error('password required');
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const hash = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt, expected;
  try {
    salt = Buffer.from(parts[1], 'hex');
    expected = Buffer.from(parts[2], 'hex');
  } catch { return false; }
  if (!salt.length || expected.length !== SCRYPT_KEYLEN) return false;
  let actual;
  try { actual = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN); } catch { return false; }
  try { return crypto.timingSafeEqual(actual, expected); } catch { return false; }
}

// Opaque random token (hex) for email-verification links etc.
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

// --- Unified request resolver ----------------------------------------------

// Resolve a request to { userId } from EITHER context, given the raw inputs the
// app extracts from the request. Tries a dashboard session bearer first, then
// Telegram initData. Returns null if neither authenticates.
//   initData: the X-Telegram-Init-Data header (or ?initData= for EventSource)
//   bearer:   the dashboard session token (Authorization: Bearer / header)
// A session result carries `channel` ('telegram' | 'whatsapp' | null) — the
// tag the token was issued with (see issueSession).
function resolve(appName, { initData, bearer } = {}) {
  if (bearer) {
    const s = verifySession(appName, bearer);
    if (s) return { userId: s.userId, via: 'session', channel: s.channel };
  }
  if (initData) {
    const u = validateInitData(appName, initData);
    if (u) return { userId: String(u.id), via: 'telegram', user: u };
  }
  return null;
}

module.exports = {
  init,
  validateInitData,
  issueLinkCode, redeemLinkCode,
  issueSession, verifySession,
  hashPassword, verifyPassword, randomToken,
  resolve,
};
