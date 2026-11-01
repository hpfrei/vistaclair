// Dashboard login state: sessions, one-time login links, and provider-neutral
// login challenges.
//
// The static token (src/auth.js) is always a credential. Everything else that
// issues a session goes through here:
//   - one-time login links, minted host-locally (`vistaclair login-link`);
//   - challenges: the login page asks for one (a short code + a nonce the
//     browser keeps), shows the code and each registered provider's link for
//     it (e.g. a QR code an add-on's bot understands), and long-polls with the
//     nonce. A provider approves or denies the code out of band; the browser's
//     next poll redeems an approved challenge for a session. Core ships no
//     provider — add-ons such as Vistaclair Pro register them (addon ctx.login).
//
// Sessions persist across restarts in <DATA_HOME>/sessions.json. Only sid
// hashes are stored, so a disk read cannot yield a usable cookie.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I; 32 chars, so b % 32 is unbiased
const CODE_LENGTH = 8;
const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING_CHALLENGES = 50;
const TOMBSTONE_TTL_MS = 10 * 60 * 1000; // how long approve() can still tell 'expired'/'used' from 'unknown'
const LINK_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ID_RE = /^[a-z0-9-]{1,32}$/;
const WHO_MAX = 100;

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function randomCode() {
  let code = '';
  for (const b of crypto.randomBytes(CODE_LENGTH)) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

function normCode(code) {
  return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

function cleanWho(who) {
  if (who === undefined || who === null || who === '') return null;
  return String(who).slice(0, WHO_MAX);
}

function createLogin({
  dataHome,
  now = Date.now,
  challengeTtlMs = CHALLENGE_TTL_MS,
  sessionTtlMs = SESSION_TTL_MS,
  log = console,
} = {}) {
  const sessionsPath = path.join(dataHome, 'sessions.json');

  // --- Sessions ---

  let sessions = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'));
    if (Array.isArray(parsed)) sessions = parsed.filter(s => s && typeof s.sidHash === 'string');
  } catch {}
  function saveSessions() {
    try {
      fs.writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2), { mode: 0o600 });
    } catch (e) { log.error('  login: failed to persist sessions:', e.message); }
  }
  function pruneSessions() {
    const t = now();
    const before = sessions.length;
    sessions = sessions.filter(s => s.expiresAt > t);
    if (sessions.length !== before) saveSessions();
  }

  // Returns { sid, sessionId }. The sid goes into the cookie and is never stored.
  function createSession({ ip, ua, via, who } = {}) {
    pruneSessions();
    const sid = crypto.randomBytes(32).toString('hex');
    const id = crypto.randomBytes(6).toString('hex');
    const t = now();
    sessions.push({
      id,
      sidHash: sha256(sid),
      createdAt: t,
      expiresAt: t + sessionTtlMs,
      ip: ip || null,
      ua: (ua || '').slice(0, 200) || null,
      via: via || null,
      who: cleanWho(who),
    });
    saveSessions();
    return { sid, sessionId: id };
  }

  function getSession(sid) {
    if (!sid || typeof sid !== 'string') return null;
    const hash = sha256(sid);
    const s = sessions.find(x => x.sidHash === hash);
    if (!s) return null;
    if (s.expiresAt <= now()) { pruneSessions(); return null; }
    return s;
  }

  function sessionView(s) {
    return {
      id: s.id, createdAt: s.createdAt, expiresAt: s.expiresAt,
      ip: s.ip ?? null, ua: s.ua ?? null, via: s.via ?? null, who: s.who ?? null,
    };
  }

  // currentSid marks the caller's own session (`current`), for the Security page.
  function listSessions(currentSid) {
    pruneSessions();
    const currentHash = currentSid ? sha256(currentSid) : null;
    return sessions.map(s => ({ ...sessionView(s), current: s.sidHash === currentHash }));
  }

  function revokeSession(id) {
    const before = sessions.length;
    sessions = sessions.filter(s => s.id !== id);
    if (sessions.length !== before) { saveSessions(); return true; }
    return false;
  }

  function revokeAll({ exceptSid } = {}) {
    const keepHash = exceptSid ? sha256(exceptSid) : null;
    sessions = sessions.filter(s => s.sidHash === keepHash);
    saveSessions();
  }

  // --- Challenges ---

  const challenges = new Map(); // nonce -> { code, createdAt, expiresAt, ip, ua, status, via, who }
  const byCode = new Map();     // code -> nonce
  const tombstones = new Map(); // code -> { reason: 'expired' | 'used', at }
  const watchers = new Map();   // nonce -> Set<fn>

  function notify(nonce) {
    const set = watchers.get(nonce);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(); } catch (e) { log.error('  login: challenge watcher error:', e.message); }
    }
  }

  function dropChallenge(nonce, reason) {
    const ch = challenges.get(nonce);
    if (!ch) return;
    challenges.delete(nonce);
    byCode.delete(ch.code);
    tombstones.set(ch.code, { reason, at: now() });
    notify(nonce);
  }

  function pruneChallenges() {
    const t = now();
    for (const [nonce, ch] of challenges) {
      if (ch.expiresAt <= t) dropChallenge(nonce, 'expired');
    }
    for (const [code, ts] of tombstones) {
      if (t - ts.at > TOMBSTONE_TTL_MS) tombstones.delete(code);
    }
  }

  // → { nonce, code, expiresInMs }, or null at the pending-challenge cap.
  // `replaces` is the browser's previous nonce (a rotating QR): it is deleted
  // first, so rotation never piles up challenges.
  function startChallenge({ ip, ua, replaces } = {}) {
    pruneChallenges();
    if (typeof replaces === 'string' && challenges.has(replaces)) dropChallenge(replaces, 'expired');
    if (challenges.size >= MAX_PENDING_CHALLENGES) return null; // flood guard; the rate limiter is the main gate
    const nonce = crypto.randomBytes(16).toString('hex');
    let code;
    do { code = randomCode(); } while (byCode.has(code) || tombstones.has(code));
    const t = now();
    challenges.set(nonce, {
      code, createdAt: t, expiresAt: t + challengeTtlMs,
      ip: ip || null, ua: (ua || '').slice(0, 200) || null,
      status: 'pending', via: null, who: null,
    });
    byCode.set(code, nonce);
    return { nonce, code, expiresInMs: challengeTtlMs };
  }

  // → 'pending' | 'expired' | 'denied' | { sid, sessionId, via, who, code, ip, ua }.
  // Redeeming an approved challenge creates the session and consumes it.
  function pollChallenge(nonce) {
    pruneChallenges();
    const ch = typeof nonce === 'string' ? challenges.get(nonce) : null;
    if (!ch) return 'expired';
    if (ch.status === 'pending') return 'pending';
    if (ch.status === 'denied') return 'denied';
    dropChallenge(nonce, 'used');
    const { sid, sessionId } = createSession({ ip: ch.ip, ua: ch.ua, via: ch.via, who: ch.who });
    return { sid, sessionId, via: ch.via, who: ch.who, code: ch.code, ip: ch.ip, ua: ch.ua };
  }

  // Calls fn whenever the challenge changes (approved, denied, expired,
  // replaced, consumed). → unsubscribe().
  function watchChallenge(nonce, fn) {
    if (!watchers.has(nonce)) watchers.set(nonce, new Set());
    const set = watchers.get(nonce);
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size && watchers.get(nonce) === set) watchers.delete(nonce);
    };
  }

  function challengeTimeLeft(nonce) {
    const ch = challenges.get(nonce);
    return ch ? Math.max(0, ch.expiresAt - now()) : 0;
  }

  function findByCode(code) {
    pruneChallenges();
    const c = normCode(code);
    const nonce = byCode.get(c);
    return nonce ? { nonce, ch: challenges.get(nonce), code: c } : { nonce: null, ch: null, code: c };
  }

  function describe(code) {
    const { ch } = findByCode(code);
    if (!ch) return null;
    return { code: ch.code, createdAt: ch.createdAt, expiresAt: ch.expiresAt, ip: ch.ip, ua: ch.ua, status: ch.status };
  }

  function approve(code, { via, who } = {}) {
    if (typeof via !== 'string' || !ID_RE.test(via)) throw new TypeError('login.approve: via must match /^[a-z0-9-]{1,32}$/');
    const { nonce, ch, code: c } = findByCode(code);
    if (!ch) return { ok: false, reason: tombstones.get(c)?.reason || 'unknown' };
    if (ch.status === 'denied') return { ok: false, reason: 'denied' };
    if (ch.status === 'approved') return { ok: false, reason: 'used' };
    ch.status = 'approved';
    ch.via = via;
    ch.who = cleanWho(who);
    notify(nonce);
    return { ok: true };
  }

  function deny(code) {
    const { nonce, ch } = findByCode(code);
    if (!ch || ch.status !== 'pending') return false;
    ch.status = 'denied';
    notify(nonce);
    return true;
  }

  // --- Providers (add-ons that approve challenges out of band) ---

  const providers = new Map(); // id -> { id, label, link }

  function registerProvider({ id, label, link } = {}) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new TypeError('login.registerProvider: id must match /^[a-z0-9-]{1,32}$/');
    if (typeof link !== 'function') throw new TypeError('login.registerProvider: link(code) must be a function');
    const entry = { id, label: String(label || id).slice(0, 60), link };
    providers.set(id, entry);
    return function unregister() {
      if (providers.get(id) === entry) providers.delete(id);
    };
  }

  function listProviders() {
    return [...providers.values()].map(p => ({ id: p.id, label: p.label }));
  }

  // [{ id, label, link }] for every provider whose link(code) is an https URL;
  // null, a non-https value or a throw hides that provider.
  function providerLinks(code) {
    const out = [];
    for (const p of providers.values()) {
      let link = null;
      try { link = p.link(code); } catch (e) { log.error(`  login: provider "${p.id}" link() threw:`, e.message); }
      if (typeof link === 'string' && /^https:\/\//i.test(link)) out.push({ id: p.id, label: p.label, link });
    }
    return out;
  }

  // --- Login listeners ---

  const loginListeners = new Set();

  function onLogin(fn) {
    if (typeof fn !== 'function') throw new TypeError('login.onLogin: fn must be a function');
    loginListeners.add(fn);
    return () => { loginListeners.delete(fn); };
  }

  // evt: { via, ip, ua, sessionId, code, external }. A listener never breaks a login.
  function emitLogin(evt) {
    for (const fn of [...loginListeners]) {
      try {
        const r = fn({ ...evt });
        if (r && typeof r.catch === 'function') r.catch(e => log.error('  login: onLogin listener failed:', e?.message || e));
      } catch (e) {
        log.error('  login: onLogin listener failed:', e?.message || e);
      }
    }
  }

  // --- One-time login links (break-glass, minted host-locally) ---

  const oneTimeLinks = new Map(); // key -> expiresAt

  function createOneTimeLink() {
    for (const [k, exp] of oneTimeLinks) { if (exp <= now()) oneTimeLinks.delete(k); }
    const key = crypto.randomBytes(32).toString('hex');
    oneTimeLinks.set(key, now() + LINK_TTL_MS);
    return key;
  }

  // → { sid, sessionId } or null.
  function redeemOneTimeLink(key, { ip, ua } = {}) {
    if (!key || typeof key !== 'string') return null;
    const exp = oneTimeLinks.get(key);
    oneTimeLinks.delete(key); // single-use even on expiry race
    if (!exp || exp <= now()) return null;
    return createSession({ ip, ua, via: 'login-link' });
  }

  // The add-on facing API (addon ctx.login, dashboard process only). Frozen
  // contract — see the README's "Login" section.
  const api = Object.freeze({
    registerProvider,
    describe,
    approve,
    deny,
    listSessions: () => { pruneSessions(); return sessions.map(sessionView); },
    revokeSession: (id) => revokeSession(String(id ?? '')),
    revokeAll: () => { revokeAll(); },
    onLogin,
  });

  pruneSessions();

  return {
    api,
    // sessions
    createSession, getSession, listSessions, revokeSession, revokeAll,
    // challenges
    startChallenge, pollChallenge, watchChallenge, challengeTimeLeft, describe, approve, deny,
    // providers + listeners
    registerProvider, listProviders, providerLinks, onLogin, emitLogin,
    // one-time links
    createOneTimeLink, redeemOneTimeLink, LINK_TTL_MS,
  };
}

module.exports = { createLogin, CODE_ALPHABET, CODE_LENGTH, CHALLENGE_TTL_MS, MAX_PENDING_CHALLENGES };
