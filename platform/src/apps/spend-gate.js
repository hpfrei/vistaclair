// The spend gate — ONE decision for every metered platform call, wherever it
// entered (owner Bridge, routes.js ctx, a job, a bot handler, a tool call).
//
//   authorize(app, method, opts)  before the provider call
//   settle(app, method, cost)     after it, whatever the outcome
//
// authorize walks a fixed sequence:
//   1. hard rules      (user-bridge callers may only reach user-audience methods)
//   2. resolve policy  for the host's deployment mode — preset `unlimited`
//                      returns OK HERE, before the ledger or any identity
//   3. paused          → E_PAUSED ; capability revoked by the admin → E_NOT_GRANTED
//   4. principal bucket (override > principal > unattributed) and the app
//                      bucket must both have credits left → else E_NO_CREDITS ;
//                      per-minute rate → E_RATE_LIMIT
//   5. execute, then settle() debits the actual cost
//
// Enforcement can be switched to observe-only from the host settings: the
// same decisions are recorded (ledger `blocked` counts) but nothing is refused.
//
// Free methods (cost 'free' in the capability registry) never reach step 2.
// Platform-owned spend (Horst, CLI tabs, the `platform` pseudo-app) resolves
// against the host profile, which defaults to unlimited.
const fs = require('fs');
const os = require('os');
const path = require('path');
const spendContext = require('./spend-context');
const spendPolicy = require('./spend-policy');
const spendLedger = require('./spend-ledger');
const spendPricing = require('./spend-pricing');
const deploymentMode = require('./deployment-mode');

const CODES = {
  E_PAUSED: 'This app is paused by the platform admin (spend policy).',
  E_NOT_GRANTED: 'Capability revoked by the platform admin (spend policy).',
  E_NO_CREDITS: 'Spend cap reached (spend policy).',
  E_RATE_LIMIT: 'Too many calls per minute (spend policy).',
  E_NOT_EXPOSED: 'This method is not available to app users.',
};

const PSEUDO_APPS = new Set(['platform', '__platform__', 'horst', '_host']);

class SpendError extends Error {
  constructor(code, message, extra) {
    super(message || CODES[code] || code);
    this.name = 'SpendError';
    this.code = code;
    Object.assign(this, extra || {});
  }
}

const observers = new Set();
function observe(fn) { observers.add(fn); return () => observers.delete(fn); }
function emit(ev) { for (const fn of observers) { try { fn(ev); } catch {} } }

// Once-per-day dedupe for alerts: `${app}|${kind}|${key}` → dayKey
const alerted = new Map();
function once(key) {
  const day = spendLedger.dayKey();
  if (alerted.get(key) === day) return false;
  alerted.set(key, day);
  if (alerted.size > 5000) alerted.clear();
  return true;
}

// --- classification -----------------------------------------------------------

function classify(method) {
  let caps;
  try { caps = require('./capabilities'); } catch { return { capKey: null, cost: 'free', audiences: ['owner'] }; }
  const key = caps.capabilityKeyForMethod(method);
  const cap = key ? caps.get(key) : null;
  return { capKey: key, cost: (cap && cap.cost) || 'free', audiences: (cap && cap.audiences) || ['owner'] };
}

function manifestOf(app) {
  try { return require('./app-manager').readManifest(app) || {}; } catch { return {}; }
}
function appDirOf(app) {
  try { return path.join(require('./app-manager').APPS_DIR, app); } catch { return undefined; }
}

function policyFor(app, mode) {
  if (!app || PSEUDO_APPS.has(app)) return spendPolicy.resolveHost(mode);
  return spendPolicy.resolve(app, mode, manifestOf(app));
}

// --- budget arithmetic --------------------------------------------------------

function remaining(cap, spentCredits) {
  if (cap === 'unlimited' || cap === undefined || cap === null) return Infinity;
  return Math.max(0, Number(cap) - spentCredits);
}

// Credits a principal may still spend today / this month under `profile`.
// Subscriber modes on the principal cap: `exempt` lifts it for subscribed
// principals, `separate` swaps in the subscriber caps; the spend measured is
// always the principal's own bucket. Overrides and the owner stay strongest;
// tier credits (the app's own licence tiers) beat the generic subscriber cap.
function bucketFor(profile, principal, tierCredits, subscribed) {
  if (!principal) return { key: '_app', day: profile.caps.unattributed.day, month: profile.caps.unattributed.month, source: 'unattributed' };
  const ov = profile.overrides && profile.overrides[principal];
  if (ov) return { key: principal, day: ov.day, month: ov.month, source: 'override' };
  if (principal === 'owner') return { key: 'owner', day: 'unlimited', month: 'unlimited', source: 'owner' };
  const pc = profile.caps.principal;
  if (subscribed && pc.subscribers === 'exempt') return { key: principal, day: 'unlimited', month: 'unlimited', source: 'subscriber-exempt' };
  if (pc.source === 'tier' && tierCredits) {
    return { key: principal, day: tierCredits.day ?? pc.day, month: tierCredits.month ?? pc.month, source: 'tier' };
  }
  if (subscribed && pc.subscribers === 'separate') {
    return { key: principal, day: pc.subscriberDay, month: pc.subscriberMonth, source: 'subscriber' };
  }
  return { key: principal, day: pc.day, month: pc.month, source: 'principal' };
}

// The app-wide pool for this caller. `separate` splits the day into a
// subscriber pool (ledger `sub` view) and a general pool (total − sub);
// `exempt` lifts the app cap for subscribed callers.
function appPool(app, profile, subscribed, appDir) {
  const ac = profile.caps.app;
  const day = spendLedger.spent(app, { scope: 'day' }, appDir).credits;
  const month = spendLedger.spent(app, { scope: 'month' }, appDir).credits;
  if (subscribed && ac.subscribers === 'exempt') {
    return { pool: 'exempt', day: { cap: 'unlimited', spent: day }, month: { cap: 'unlimited', spent: month } };
  }
  if (ac.subscribers === 'separate') {
    const sDay = spendLedger.spent(app, { scope: 'day', view: 'sub' }, appDir).credits;
    const sMonth = spendLedger.spent(app, { scope: 'month', view: 'sub' }, appDir).credits;
    return subscribed
      ? { pool: 'subscriber', day: { cap: ac.subscriberDay, spent: sDay }, month: { cap: ac.subscriberMonth, spent: sMonth } }
      : { pool: 'general', day: { cap: ac.day, spent: day - sDay }, month: { cap: ac.month, spent: month - sMonth } };
  }
  return { pool: 'all', day: { cap: ac.day, spent: day }, month: { cap: ac.month, spent: month } };
}

function budgetState(app, profile, principal, tierCredits, subscribed) {
  const appDir = appDirOf(app);
  const b = bucketFor(profile, principal, tierCredits, subscribed);
  const pDay = spendLedger.spent(app, { scope: 'day', view: 'principal', key: b.key }, appDir).credits;
  const pMonth = spendLedger.spent(app, { scope: 'month', view: 'principal', key: b.key }, appDir).credits;
  const a = appPool(app, profile, subscribed, appDir);
  const w = (x) => ({ cap: x.cap, spent: x.spent, left: remaining(x.cap, x.spent) });
  return {
    bucket: b,
    subscribed: !!subscribed,
    pool: a.pool,
    principal: { day: { cap: b.day, spent: pDay, left: remaining(b.day, pDay) }, month: { cap: b.month, spent: pMonth, left: remaining(b.month, pMonth) } },
    app: { day: w(a.day), month: w(a.month) },
  };
}

function exhaustedCode(state) {
  if (state.app.day.left <= 0 || state.app.month.left <= 0) return { code: 'E_NO_CREDITS', scope: 'app' };
  if (state.principal.day.left <= 0 || state.principal.month.left <= 0) return { code: 'E_NO_CREDITS', scope: state.bucket.source };
  return null;
}

// --- authorize ----------------------------------------------------------------

// opts: { via: 'ctx'|'bridge'|'user-bridge', principal?, subscribed?,
//         meterKey?, tierCredits? }
// Returns { ok: true, unlimited?, mode, principal, wouldBlock? }; throws
// SpendError when enforcing.
function authorize(app, method, opts = {}) {
  const cls = classify(method);
  const via = opts.via || 'ctx';
  // 1. Hard rules: a user-facing bridge caller can only reach user-audience methods.
  if (via === 'user-bridge' && !cls.audiences.includes('user') && !cls.audiences.includes('anonymous')) {
    throw new SpendError('E_NOT_EXPOSED', `${method} is owner-only`, { method, app });
  }
  if (cls.cost !== 'metered') return { ok: true, free: true, method };

  const det = deploymentMode.detect();
  const mode = det.mode;
  const enforce = det.enforce;
  const profile = policyFor(app, mode);
  const principal = opts.principal !== undefined ? opts.principal
    : (spendContext.principal() || (opts.meterKey ? `meter:${opts.meterKey}` : null));
  const subscribed = subscribedFor(opts.subscribed, principal);
  const result = { ok: true, mode, principal, subscribed, preset: profile.preset, method };

  const block = (code, extra, { always = false } = {}) => {
    spendLedger.recordBlocked(app, code, appDirOf(app));
    emit({ type: 'blocked', app, method, code, principal, mode, enforced: enforce || always, ...(extra || {}) });
    if (enforce || always) throw new SpendError(code, undefined, { method, app, principal, ...(extra || {}) });
    return { ...result, wouldBlock: code };
  };

  // 2. Revoked: a permission the admin took away is refused in EVERY preset
  //    (unlimited included) and is never merely observed — it is not spend.
  if (profile.grants && cls.capKey && profile.grants[cls.capKey] === false) return block('E_NOT_GRANTED', { capability: cls.capKey }, { always: true });

  // 3. Unlimited: nothing else is consulted — no ledger, no identity, no caps.
  if (spendPolicy.isUnlimited(profile)) return { ...result, unlimited: true };

  // 4. Paused.
  if (profile.paused) return block('E_PAUSED');

  // 5. Credits and rate.
  const state = budgetState(app, profile, principal, opts.tierCredits, subscribed);
  const ex = exhaustedCode(state);
  if (ex) return block(ex.code, { scope: ex.scope, state: publicState(state) });
  if (mode === 'deployed' && !principal && once(`${app}|unattributed`)) emit({ type: 'unattributed', app, method, mode });
  const rp = profile.rate.principalPerMinute;
  if (rp !== 'unlimited' && spendLedger.callsLastMinute(app, principal || '_app') >= Number(rp)) return block('E_RATE_LIMIT', { scope: 'principal' });
  const ra = profile.rate.appPerMinute;
  if (ra !== 'unlimited' && spendLedger.callsLastMinute(app, '__all__') >= Number(ra)) return block('E_RATE_LIMIT', { scope: 'app' });
  return { ...result, state: publicState(state) };
}

function publicState(state) {
  const f = (x) => ({ cap: x.cap, spent: x.spent, left: x.left === Infinity ? 'unlimited' : x.left });
  return {
    bucket: state.bucket.key, source: state.bucket.source,
    subscribed: state.subscribed, pool: state.pool,
    principal: { day: f(state.principal.day), month: f(state.principal.month) },
    app: { day: f(state.app.day), month: f(state.app.month) },
  };
}

// --- settle -------------------------------------------------------------------

// The subscriber flag of a call: explicit (tests, registered LLM sessions),
// else the ambient spend context, else derived from the principal alone
// (owner is always subscribed).
function subscribedFor(explicit, principal) {
  if (explicit !== undefined) return !!explicit;
  if (spendContext.current()) return spendContext.subscribed();
  return principal === 'owner';
}

// Record the actual cost of a finished call. `units`/`unit`/`model` price
// non-LLM calls through spend-pricing; LLM calls pass costUsd + tokens.
function settle(app, method, info = {}) {
  const principal = info.principal !== undefined ? info.principal : (spendContext.principal() || (info.meterKey ? `meter:${info.meterKey}` : null));
  const subscribed = subscribedFor(info.subscribed, principal);
  const origin = info.origin || spendContext.origin() || 'unknown';
  let costUsd = info.costUsd;
  let priced = info.priced;
  if (costUsd === undefined) {
    const p = spendPricing.price(method, info.model, info.units);
    costUsd = p.costUsd;
    priced = p.priced;
  }
  spendLedger.record({
    app, appDir: appDirOf(app), method, principal, origin, subscribed,
    costUsd, priced: priced !== false, units: info.units || 0,
    inTok: info.inTok || 0, outTok: info.outTok || 0, cacheTok: info.cacheTok || 0,
    model: info.model, apiUsd: info.apiUsd,
  });
  afterSettle(app, method, principal, info.instanceId, subscribed);
  return { costUsd, priced: priced !== false, principal, origin, subscribed };
}

// LLM cost from the proxy's interaction:complete broadcast (dashboard tap).
function settleInteraction(interaction) {
  if (!interaction || !interaction.instanceId || interaction.isHook || interaction.isMcp) return false;
  if (interaction.endpoint && interaction.endpoint !== '/v1/messages') return false;
  const id = interaction.instanceId;
  const info = spendContext.instanceInfo(id);
  const app = (info && info.app) || spendContext.appFromInstanceId(id);
  if (!app) return false;
  if (!interaction.usage) return false;
  const usage = interaction.usage;
  const costUsd = spendLedger.computeCost(usage, interaction.pricing);
  const subscribed = !!(info && info.subscribed);
  spendLedger.record({
    app, appDir: appDirOf(app), method: 'ai.prompt',
    principal: info ? info.principal : null, origin: info ? info.origin : 'unknown', subscribed,
    costUsd: costUsd || 0, priced: costUsd != null, units: 1,
    // The recorded cost IS the API list price (a subscription call is priced
    // the same; `subscribed` only picks the cap slice), so apiUsd == costUsd.
    model: (interaction.request && interaction.request.model) || interaction.model || undefined, apiUsd: costUsd || 0,
    inTok: usage.input_tokens || 0, outTok: usage.output_tokens || 0,
    cacheTok: (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
  });
  afterSettle(app, 'ai.prompt', info ? info.principal : null, id, subscribed);
  return true;
}

// Post-settle bookkeeping: threshold / exhaustion / anomaly alerts, and the
// mid-session cut for LLM sessions that just ran out.
function afterSettle(app, method, principal, instanceId, subscribed) {
  let det, profile;
  try { det = deploymentMode.detect(); profile = policyFor(app, det.mode); } catch { return; }
  if (spendPolicy.isUnlimited(profile)) return;
  const state = budgetState(app, profile, principal, undefined, subscribed);
  const ex = exhaustedCode(state);
  if (ex) {
    if (once(`${app}|exhausted|${state.bucket.key}|${ex.scope}`)) {
      emit({ type: 'exhausted', app, method, principal, scope: ex.scope, bucket: state.bucket.key, mode: det.mode, state: publicState(state) });
    }
    if (instanceId && det.enforce) writeBlockedMarker(instanceId, ex.code, `Spend cap reached for ${app} (${ex.scope})`);
  } else if (profile.caps.app.day !== 'unlimited') {
    const pct = state.app.day.spent / Math.max(1, Number(profile.caps.app.day)) * 100;
    if (pct >= profile.alerts.appDayPct && once(`${app}|threshold`)) {
      emit({ type: 'threshold', app, pct: Math.round(pct), mode: det.mode, state: publicState(state) });
    }
  }
  try {
    const s = spendLedger.summary(app, { days: 8 }, appDirOf(app));
    const factor = profile.alerts.anomalyFactor;
    if (s.yesterdayAvg7 > 0.001 && s.today.costUsd > s.yesterdayAvg7 * factor && s.today.costUsd > 0.05 && once(`${app}|anomaly`)) {
      emit({ type: 'anomaly', app, todayUsd: s.today.costUsd, baselineUsd: s.yesterdayAvg7, factor, mode: det.mode });
    }
  } catch {}
}

// Storage breach events enter the same observer stream as the spend alerts
// (dashboard toast + the spend capability's Horst sense). Emitted by
// storage-meter.js after its grace window; ev: { app, deltaBytes, capMB,
// bytes, mode, paused }.
function reportStorageBreach(ev) {
  emit({ type: 'storage-breach', ...ev });
}

// --- LLM session marker (read by core's spend-guard proxy rule) --------------

function markerPath(instanceId) {
  return path.join(os.tmpdir(), `vistaclair-ai-spend-${instanceId}.json`);
}
function writeBlockedMarker(instanceId, code, message) {
  if (!/^app-[A-Za-z0-9._-]+-ai-[a-f0-9]+$/.test(String(instanceId))) return;
  try { fs.writeFileSync(markerPath(instanceId), JSON.stringify({ blocked: true, code, message })); } catch {}
}
function clearMarker(instanceId) {
  try { fs.unlinkSync(markerPath(instanceId)); } catch {}
}

// --- status (UI / ctx.spendStatus) -------------------------------------------

function status(app, { principal, subscribed } = {}) {
  const det = deploymentMode.detect();
  const profile = policyFor(app, det.mode);
  const p = principal !== undefined ? principal : spendContext.principal();
  const sub = subscribedFor(subscribed, p);
  const out = { app, mode: det.mode, enforce: det.enforce, preset: profile.preset, paused: profile.paused, source: profile.sources.profile, principal: p, subscribed: sub, unlimited: spendPolicy.isUnlimited(profile) };
  if (!out.unlimited) out.state = publicState(budgetState(app, profile, p, undefined, sub));
  return out;
}

// Wrap a service function (appName, params, ...) as a metered call: authorize
// before, settle after (success only — a failed provider call is not billed).
function wrap(method, fn, unitsOf) {
  return async function metered(appName, params, ...rest) {
    authorize(appName, method, { via: 'ctx', meterKey: params && params.meterKey });
    const result = await fn(appName, params, ...rest);
    try { settle(appName, method, { model: result && result.model, units: unitsOf ? unitsOf(params, result) : 1, meterKey: params && params.meterKey }); } catch {}
    return result;
  };
}

// Whether the proxy broadcast tap (LLM settle per request) is wired in this
// process — the dashboard sets it; headless runners fold sessions themselves.
let _tapActive = false;
function setTapActive(v) { _tapActive = !!v; }
function tapActive() { return _tapActive; }

module.exports = { CODES, SpendError, observe, classify, policyFor, authorize, settle, settleInteraction, status, clearMarker, writeBlockedMarker, markerPath, budgetState, wrap, setTapActive, tapActive, reportStorageBreach };
