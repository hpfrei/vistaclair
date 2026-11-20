// Admin-owned spend policy per app — WHAT an app may spend, per deployment mode.
//
// Stored under core's dataHome (<dataHome>/spend-policy/<app>.json), never in
// the app directory: a redeploy, git pull or publish can never widen what an
// app may do or spend. The manifest may REQUEST a policy (`spend` field); the
// admin GRANTS. Precedence, strongest first:
//
//   admin policy (this store)  >  manifest `spend`  >  mode default
//
// Each layer is a whole profile per mode; the strongest present layer wins
// outright (field-level merging would make "what applies right now" a puzzle).
// `grants` — admin revocations of capabilities below the manifest — exist on
// the admin layer only.
//
// Presets:
//   unlimited  everything passes; the gate returns before it reads the ledger
//              or asks for an identity. No meter keys, no sessions, no caps.
//              Metering still records.
//   metered    per-app + per-principal daily/monthly caps in credits (defaults
//              2000/day app, 100/day per user; caps given on top apply);
//              unattributed spend capped at zero (forces attribution).
//   budgeted   the same real caps WITHOUT the zero-unattributed rule: one pool,
//              spent with or without an identity. For work that has no user to
//              attribute to — the host profile below, or an app with no user
//              accounts. Caps given on top apply.
//   locked     paused — every metered call fails with E_PAUSED.
//   custom     the fields below, as given.
//
// Credits: 1 credit = USD 0.001 (1000 credits = $1), from the pricing tables.
//
// The host file (<dataHome>/spend-policy/_host.json) carries the deployment
// mode override, the enforce/observe switch, unit-price overrides and the
// profile that governs platform-owned spend (Horst, CLI tabs, pseudo-apps).
const fs = require('fs');
const path = require('path');

const PRESETS = ['unlimited', 'metered', 'budgeted', 'locked', 'custom'];
// The host profile governs platform-owned spend — Horst's heartbeat, briefing
// and triage, and cron jobs with no app. None of that has a user to attribute
// to, so `metered` (unattributed: 0) would refuse every one of those calls the
// moment it was selected. The host is offered `budgeted` instead.
const HOST_PRESETS = ['unlimited', 'budgeted', 'locked'];
const MODES = ['local', 'deployed'];
const CREDITS_PER_USD = 1000;

// Subscriber handling per cap (spend-context resolves `subscribed` at the edge):
//   count     everyone draws from the one pool (default — today's behaviour)
//   separate  subscribed principals draw from subscriberDay/subscriberMonth
//   exempt    subscribed principals bypass this cap (deliberately three-way:
//             an exempt subscriber account is an unlimited spend hole if
//             compromised, so exemption is the admin's explicit choice)
const SUBSCRIBER_MODES = ['count', 'separate', 'exempt'];

let dir = null;
const cache = new Map(); // app → { mtimeMs, policy } ; '_host' for the host file

function init(options = {}) {
  const home = options.dataHome;
  if (!home) throw new Error('spend-policy.init requires dataHome');
  dir = path.join(home, 'spend-policy');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function ready() { return !!dir; }
function policyPath(app) { return path.join(dir, `${app}.json`); }
function hostPath() { return path.join(dir, '_host.json'); }

// --- normalisation ------------------------------------------------------------

function capValue(v, fallback) {
  if (v === undefined || v === null) return fallback;
  if (v === 'unlimited' || v === Infinity) return 'unlimited';
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`cap must be a non-negative number or "unlimited" (got ${JSON.stringify(v)})`);
  return Math.floor(n);
}

function capPair(obj, fallback = {}) {
  const o = obj && typeof obj === 'object' ? obj : {};
  return { day: capValue(o.day, fallback.day), month: capValue(o.month, fallback.month) };
}

function subscriberMode(v, fallback = 'count') {
  if (v === undefined || v === null) return fallback;
  if (!SUBSCRIBER_MODES.includes(v)) throw new Error(`subscribers must be one of ${SUBSCRIBER_MODES.join(', ')} (got ${JSON.stringify(v)})`);
  return v;
}

// A cap pair with a subscriber mode (app + principal caps; the unattributed
// bucket keeps a plain pair — anonymous spend is never subscribed).
function capGroup(obj, fallback = {}) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const out = { ...capPair(o, fallback), subscribers: subscriberMode(o.subscribers, fallback.subscribers || 'count') };
  if (out.subscribers === 'separate') {
    out.subscriberDay = capValue(o.subscriberDay, fallback.subscriberDay ?? 'unlimited');
    out.subscriberMonth = capValue(o.subscriberMonth, fallback.subscriberMonth ?? 'unlimited');
  }
  return out;
}

const PRESET_PROFILES = {
  unlimited: () => ({
    caps: { app: { day: 'unlimited', month: 'unlimited', subscribers: 'count' }, principal: { day: 'unlimited', month: 'unlimited', subscribers: 'count', source: 'fixed' }, unattributed: { day: 'unlimited', month: 'unlimited' } },
    rate: { principalPerMinute: 'unlimited', appPerMinute: 'unlimited' },
    paused: false,
  }),
  metered: () => ({
    caps: { app: { day: 2000, month: 30000, subscribers: 'count' }, principal: { day: 100, month: 1500, subscribers: 'count', source: 'fixed' }, unattributed: { day: 0, month: 0 } },
    rate: { principalPerMinute: 30, appPerMinute: 300 },
    paused: false,
  }),
  // Real caps, no attribution requirement: every bucket draws on the same
  // ceiling, so the app cap is what actually binds. Rate is left unlimited —
  // a per-minute limit on a heartbeat is a different failure from a budget,
  // and conflating them makes a breach unreadable.
  budgeted: () => ({
    caps: { app: { day: 2000, month: 30000, subscribers: 'count' }, principal: { day: 2000, month: 30000, subscribers: 'count', source: 'fixed' }, unattributed: { day: 2000, month: 30000 } },
    rate: { principalPerMinute: 'unlimited', appPerMinute: 'unlimited' },
    paused: false,
  }),
  locked: () => ({
    caps: { app: { day: 0, month: 0, subscribers: 'count' }, principal: { day: 0, month: 0, subscribers: 'count', source: 'fixed' }, unattributed: { day: 0, month: 0 } },
    rate: { principalPerMinute: 0, appPerMinute: 0 },
    paused: true,
  }),
};

// Normalise one mode profile (any layer). Throws on a malformed shape.
function normalizeProfile(input, { allowGrants = false } = {}) {
  let p = input;
  if (typeof p === 'string') p = { preset: p };
  if (!p || typeof p !== 'object') throw new Error('profile must be an object or a preset name');
  const preset = p.preset || 'custom';
  if (!PRESETS.includes(preset)) throw new Error(`unknown preset "${preset}" (expected ${PRESETS.join(', ')})`);
  const base = preset === 'custom' ? PRESET_PROFILES.metered() : PRESET_PROFILES[preset]();
  const out = {
    preset,
    caps: {
      app: capGroup(p.caps && p.caps.app, base.caps.app),
      principal: { ...capGroup(p.caps && p.caps.principal, base.caps.principal), source: (p.caps && p.caps.principal && p.caps.principal.source === 'tier') ? 'tier' : 'fixed' },
      unattributed: capPair(p.caps && p.caps.unattributed, base.caps.unattributed),
    },
    overrides: {},
    rate: {
      principalPerMinute: capValue(p.rate && p.rate.principalPerMinute, base.rate.principalPerMinute),
      appPerMinute: capValue(p.rate && p.rate.appPerMinute, base.rate.appPerMinute),
    },
    alerts: {
      appDayPct: Math.min(100, Math.max(1, Number((p.alerts && p.alerts.appDayPct) ?? 80) || 80)),
      anomalyFactor: Math.max(1, Number((p.alerts && p.alerts.anomalyFactor) ?? 3) || 3),
    },
    // Daily NEW-storage cap in MB (storage-meter.js sweeps hourly; breach →
    // alert + pause, never a blocked write). Enforcement is per-app in v1 —
    // the subscriber flag is carried for the coming per-principal attribution
    // but does not change the pause decision yet.
    storage: {
      dailyMB: capValue(p.storage && p.storage.dailyMB, 'unlimited'),
      subscribers: subscriberMode(p.storage && p.storage.subscribers, 'count'),
    },
    paused: p.paused === undefined ? base.paused : !!p.paused,
  };
  // `unlimited` and `locked` are exactly their preset — caps given alongside
  // are ignored so "unlimited" can never be quietly narrowed by a stray field.
  // `metered` is the metered defaults with any caps/rate given on top.
  // `budgeted` is one pool: raising the app cap raises the bucket every
  // unattributed call draws on, or the admin would set 5000/day and still
  // watch the heartbeat refused at 2000 by a bucket they never saw.
  if (preset === 'budgeted' && !(p.caps && p.caps.unattributed)) {
    out.caps.unattributed = { day: out.caps.app.day, month: out.caps.app.month };
  }
  if (preset === 'unlimited' || preset === 'locked') {
    out.caps = base.caps;
    out.rate = base.rate;
    out.storage = { dailyMB: 'unlimited', subscribers: 'count' };
    out.paused = preset === 'locked' ? true : (p.paused === true);
  }
  if (p.overrides && typeof p.overrides === 'object') {
    for (const [k, v] of Object.entries(p.overrides)) {
      if (!k || k.length > 200) continue;
      out.overrides[k] = capPair(v, {});
    }
  }
  if (allowGrants && p.grants && typeof p.grants === 'object') {
    out.grants = {};
    for (const [k, v] of Object.entries(p.grants)) if (/^[a-z][a-z0-9-]*$/.test(k)) out.grants[k] = v !== false;
  }
  return out;
}

function defaultProfile(mode) {
  return mode === 'deployed' ? normalizeProfile({ preset: 'metered' }) : normalizeProfile({ preset: 'unlimited' });
}

// --- per-app store ------------------------------------------------------------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}

// The raw admin policy for an app, or null when the admin has set nothing.
function get(app) {
  if (!dir) return null;
  const file = policyPath(app);
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { cache.delete(app); return null; }
  const hit = cache.get(app);
  if (hit && hit.mtimeMs === mtimeMs) return hit.policy;
  const raw = readJson(file);
  const policy = raw && typeof raw === 'object' ? raw : null;
  cache.set(app, { mtimeMs, policy });
  return policy;
}

// Validate + persist an admin policy. `policy` = { local?, deployed?, note? }.
// A mode left out keeps falling through to the manifest / default layers.
function set(app, policy) {
  if (!dir) throw new Error('spend policy store not initialised');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(app))) throw new Error('invalid app name');
  const out = { v: 1, updatedAt: Date.now() };
  for (const mode of MODES) {
    if (policy && policy[mode] !== undefined && policy[mode] !== null) out[mode] = normalizeProfile(policy[mode], { allowGrants: true });
  }
  if (policy && typeof policy.note === 'string') out.note = policy.note.slice(0, 500);
  if (policy && policy.migrated) out.migrated = policy.migrated;
  writeJson(policyPath(app), out);
  cache.delete(app);
  return out;
}

function remove(app) {
  if (!dir) return;
  try { fs.unlinkSync(policyPath(app)); } catch {}
  cache.delete(app);
}

function listApps() {
  if (!dir) return [];
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')).map((f) => f.slice(0, -5));
  } catch { return []; }
}

// --- host settings --------------------------------------------------------------

const HOST_DEFAULTS = () => ({
  v: 1,
  mode: 'auto',          // 'auto' | 'local' | 'deployed'
  enforce: true,         // false = observe only (decisions recorded, nothing blocked)
  unitPrices: {},        // method or method@model → USD per unit (admin override)
  host: { local: { preset: 'budgeted' }, deployed: { preset: 'budgeted' } }, // platform-owned spend (Horst, cron with no app, pseudo-apps)
  reviewNotice: false,   // set by migrate(): "review spend policies" once
});

function loadHost() {
  if (!dir) return HOST_DEFAULTS();
  const file = hostPath();
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return HOST_DEFAULTS(); }
  const hit = cache.get('_host');
  if (hit && hit.mtimeMs === mtimeMs) return hit.policy;
  const raw = readJson(file) || {};
  const merged = { ...HOST_DEFAULTS(), ...raw };
  cache.set('_host', { mtimeMs, policy: merged });
  return merged;
}

function saveHost(patch) {
  if (!dir) throw new Error('spend policy store not initialised');
  const cur = loadHost();
  const next = { ...cur, ...(patch || {}) };
  if (!['auto', 'local', 'deployed'].includes(next.mode)) throw new Error('mode must be auto, local or deployed');
  next.enforce = next.enforce !== false;
  if (next.unitPrices && typeof next.unitPrices === 'object') {
    const prices = {};
    for (const [k, v] of Object.entries(next.unitPrices)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0 && /^[a-zA-Z.][a-zA-Z0-9._@-]*$/.test(k)) prices[k] = n;
    }
    next.unitPrices = prices;
  } else next.unitPrices = {};
  const host = {};
  for (const mode of MODES) {
    const src = (patch && patch.host && patch.host[mode]) || (cur.host && cur.host[mode]) || { preset: 'budgeted' };
    const preset = typeof src === 'string' ? src : (src && src.preset) || 'custom';
    if (!HOST_PRESETS.includes(preset)) throw new Error(`host profile must be one of ${HOST_PRESETS.join(', ')} (got ${JSON.stringify(preset)}) — platform spend has no user to attribute to, so "metered" would refuse every heartbeat`);
    host[mode] = normalizeProfile(src);
  }
  next.host = host;
  next.updatedAt = Date.now();
  writeJson(hostPath(), next);
  cache.delete('_host');
  return next;
}

// --- resolution ---------------------------------------------------------------

// The effective profile for one app in one mode, with the layer it came from.
// `manifest` may carry `spend: { local?, deployed? }` requests.
function resolve(app, mode, manifest) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode "${mode}"`);
  const admin = get(app);
  const sources = { profile: 'default', grants: null };
  let profile = defaultProfile(mode);
  const req = manifest && manifest.spend;
  if (req && req[mode] !== undefined && req[mode] !== null) {
    try { profile = normalizeProfile(req[mode]); sources.profile = 'manifest'; }
    catch (err) { profile = { ...profile, manifestError: err.message }; }
  }
  let grants = null;
  if (admin && admin[mode]) {
    try {
      const a = normalizeProfile(admin[mode], { allowGrants: true });
      grants = a.grants || null;
      delete a.grants;
      profile = a;
      sources.profile = 'admin';
      if (grants) sources.grants = 'admin';
    } catch (err) { profile = { ...profile, adminError: err.message }; }
  }
  return { app, mode, ...profile, grants, sources, migrated: !!(admin && admin.migrated) };
}

// Platform-owned spend (Horst, CLI tabs, `platform` pseudo-app) resolves
// against the host profile, never an app file.
function resolveHost(mode) {
  const host = loadHost();
  const prof = (host.host && host.host[mode]) ? normalizeProfile(host.host[mode]) : normalizeProfile({ preset: 'unlimited' });
  return { app: '_host', mode, ...prof, grants: null, sources: { profile: 'host', grants: null }, migrated: false };
}

// Back-compat on first boot after the upgrade: every existing app keeps
// today's behaviour (nothing blocked) in BOTH modes until the admin reviews.
// Returns the names migrated. Sets host.reviewNotice when any were.
function migrate(appNames) {
  if (!dir) return [];
  const done = [];
  for (const name of appNames || []) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) continue;
    if (fs.existsSync(policyPath(name))) continue;
    try {
      set(name, { local: { preset: 'unlimited' }, deployed: { preset: 'unlimited' }, migrated: Date.now(), note: 'Migrated on upgrade: kept unlimited (previous behaviour). Review before deploying.' });
      done.push(name);
    } catch {}
  }
  if (done.length) { try { saveHost({ reviewNotice: true }); } catch {} }
  return done;
}

// The host profile gained real caps in phase 8F. An install from before that
// has no _host.json at all, so it would silently inherit the new default —
// write it down instead, and raise the review notice so the owner learns that
// Horst now has a budget rather than discovering it at a refusal.
function migrateHost() {
  if (!dir || fs.existsSync(hostPath())) return false;
  try {
    saveHost({ reviewNotice: true, hostNote: 'Platform spend (Horst, cron) gained a daily budget on upgrade. Raise or remove it here.' });
    return true;
  } catch { return false; }
}

function isUnlimited(profile) {
  return !!profile && profile.preset === 'unlimited' && !profile.paused;
}

// --- grants → structural revocation ------------------------------------------

// The owner services an OPEN app loses by default (seeded on the flip to open;
// the admin may re-grant any of them in Spend & permissions).
const OPEN_REVOKED = ['email', 'calendar', 'google', 'telegram', 'whatsapp', 'apps', 'governance'];

// The capability keys the admin revoked for this app in this mode, limited to
// modules that declare `revocable` (capabilities.js) — the set app-manager
// hands to buildCtx (module absent from the ctx) and app-bridge (call refused).
// Grants stored for a non-revocable key are ignored here (spend-gate still
// blocks a revoked metered call live).
function revokedCapabilities(app, mode) {
  const out = new Set();
  if (!MODES.includes(mode)) return out;
  const admin = get(app);
  if (!admin || !admin[mode]) return out;
  let grants = null;
  try { grants = normalizeProfile(admin[mode], { allowGrants: true }).grants || null; } catch { return out; }
  if (!grants) return out;
  const caps = require('./capabilities');
  for (const [key, ok] of Object.entries(grants)) {
    if (ok !== false) continue;
    const cap = caps.get(key);
    if (cap && cap.revocable) out.add(key);
  }
  return out;
}

// Seed the open-level revocations for an app in BOTH modes without touching
// preset/caps: each mode's profile is rebuilt from what is effective now
// (resolve — admin layer, else manifest, else default) plus the grants, so a
// grants-only write can never fall to `custom` (= metered caps). Keys the admin
// already set are left alone. Returns the keys newly revoked.
function seedOpenGrants(app, manifest) {
  if (!dir) return [];
  const admin = get(app) || {};
  const policy = {};
  const added = [];
  for (const mode of MODES) {
    const eff = resolve(app, mode, manifest);
    const { app: _a, mode: _m, sources: _s, migrated: _g, grants: cur, manifestError: _e1, adminError: _e2, ...profile } = eff;
    const grants = { ...(cur || {}) };
    for (const key of OPEN_REVOKED) {
      if (key in grants) continue;
      grants[key] = false;
      if (!added.includes(key)) added.push(key);
    }
    policy[mode] = { ...profile, grants };
  }
  if (typeof admin.note === 'string') policy.note = admin.note;
  if (admin.migrated) policy.migrated = admin.migrated;
  set(app, policy);
  return added;
}

module.exports = {
  PRESETS, MODES, CREDITS_PER_USD, SUBSCRIBER_MODES,
  init, ready, get, set, remove, listApps,
  loadHost, saveHost,
  normalizeProfile, defaultProfile, resolve, resolveHost, migrate, migrateHost, isUnlimited,
  PRESETS, HOST_PRESETS,
  OPEN_REVOKED, revokedCapabilities, seedOpenGrants,
};
