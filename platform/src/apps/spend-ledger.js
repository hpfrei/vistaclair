// Spend ledger — every metered platform call, per app, unconditionally.
//
// Replaces ai-usage.js (LLM-only, appDir/.ai-usage.json). One file per app
// under <dataHome>/spend-ledger/<app>.json, day buckets, 93-day retention.
// Every record is folded into four views of the same day: the day total, by
// principal ('owner' / 'acct:<id>' / 'user:<id>' / 'meter:<key>' / '_app'
// for unattributed), by origin (route / bridge / job / bot / tool / horst /
// cron / cli) and by method. Blocked decisions are counted too, so observe
// mode shows what enforcement WOULD have stopped.
//
// Units: credits = USD × 1000. costUsd is stored; credits are derived.
//
// The old ledger is imported once (per app) the first time the new one is
// opened, so ai.usage / ctx.aiUsage keep returning history across the upgrade.
const fs = require('fs');
const path = require('path');

const RETENTION_DAYS = 93;
const FLUSH_MS = 2000;
const CREDITS_PER_USD = 1000;

let dir = null;
let _store = null; // core InteractionStore (fallback fold for headless runners)
let _relay = null; // headless runner: forward records to the dashboard instead of writing
const ledgers = new Map(); // app → { data, dirty, timer }
const minuteWindow = new Map(); // `${app}|${principal}` → number[] (timestamps)

function init(options = {}) {
  if (options.dataHome) {
    dir = path.join(options.dataHome, 'spend-ledger');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }
  if (options.store) _store = options.store;
  if (typeof options.relay === 'function') _relay = options.relay;
}

function ledgerPath(app) { return path.join(dir, `${app}.json`); }

// Same 4-term fold as core's inspector (cache rates fall back to the input
// rate) — duplicated rather than imported to respect the core⇄Pro seam.
function computeCost(usage, pricing) {
  if (!pricing || !usage) return null;
  let cost = 0;
  cost += (usage.input_tokens || 0) * (pricing.inputCostPerMTok || 0) / 1e6;
  cost += (usage.output_tokens || 0) * (pricing.outputCostPerMTok || 0) / 1e6;
  cost += (usage.cache_read_input_tokens || 0) * (pricing.cacheReadCostPerMTok || pricing.inputCostPerMTok || 0) / 1e6;
  cost += (usage.cache_creation_input_tokens || 0) * (pricing.cacheCreateCostPerMTok || pricing.inputCostPerMTok || 0) / 1e6;
  return cost;
}

function dayKey(offset = 0) {
  return new Date(Date.now() - offset * 86400e3).toISOString().slice(0, 10);
}
function monthPrefix() { return dayKey().slice(0, 7); }

function emptyTotal() { return { calls: 0, costUsd: 0, inTok: 0, outTok: 0, cacheTok: 0, units: 0, unpriced: 0 }; }

// `sub` is the slice of `total` spent by subscribed principals (spend-context
// `subscribed`) — additive since the subscriber-aware caps; older day buckets
// without it read as zero subscriber spend.
function emptyDay() { return { total: emptyTotal(), sub: emptyTotal(), principals: {}, origins: {}, methods: {}, blocked: {} }; }

function legacyPath(appDir) { return path.join(appDir, '.ai-usage.json'); }

// Import the v1 ledger (day → meterKey buckets) into v2 day views.
function importLegacy(data, appDir) {
  if (!appDir) return;
  let legacy = null;
  try { legacy = JSON.parse(fs.readFileSync(legacyPath(appDir), 'utf-8')); } catch { return; }
  if (!legacy || typeof legacy.days !== 'object') return;
  for (const [day, buckets] of Object.entries(legacy.days)) {
    const d = data.days[day] || (data.days[day] = emptyDay());
    for (const [key, b] of Object.entries(buckets || {})) {
      const t = { calls: b.calls || 0, costUsd: b.costUsd || 0, inTok: b.inTok || 0, outTok: b.outTok || 0, cacheTok: b.cacheTok || 0, units: 0, unpriced: 0 };
      if (key === '_app') {
        add(d.total, t);
        add(d.methods['ai.prompt'] || (d.methods['ai.prompt'] = emptyTotal()), t);
        add(d.origins.legacy || (d.origins.legacy = emptyTotal()), t);
      } else {
        add(d.principals[`meter:${key}`] || (d.principals[`meter:${key}`] = emptyTotal()), t);
      }
    }
  }
  // Legacy '_app' was bumped on every call; attributed calls were bumped twice
  // (once per key) so principals are a breakdown of total, not an addition.
  const unattributed = {};
  for (const [day, d] of Object.entries(data.days)) {
    const attributed = Object.values(d.principals).reduce((s, t) => s + (t.costUsd || 0), 0);
    if (d.total.costUsd > attributed) unattributed[day] = d.total.costUsd - attributed;
    const calls = Object.values(d.principals).reduce((s, t) => s + (t.calls || 0), 0);
    if (d.total.calls > calls || unattributed[day]) {
      d.principals._app = d.principals._app || emptyTotal();
      d.principals._app.calls += Math.max(0, d.total.calls - calls);
      d.principals._app.costUsd += unattributed[day] || 0;
    }
  }
  data.importedLegacyAt = Date.now();
}

function add(t, r) {
  t.calls += r.calls || 0;
  t.costUsd += r.costUsd || 0;
  t.inTok += r.inTok || 0;
  t.outTok += r.outTok || 0;
  t.cacheTok += r.cacheTok || 0;
  t.units += r.units || 0;
  t.unpriced += r.unpriced || 0;
}

function load(app, appDir) {
  let led = ledgers.get(app);
  if (led) return led;
  let data = null;
  if (dir) { try { data = JSON.parse(fs.readFileSync(ledgerPath(app), 'utf-8')); } catch {} }
  if (!data || typeof data !== 'object' || data.v !== 2 || typeof data.days !== 'object') {
    data = { v: 2, days: {} };
    importLegacy(data, appDir);
  }
  led = { data, dirty: !!data.importedLegacyAt, timer: null };
  ledgers.set(app, led);
  if (led.dirty) scheduleFlush(app, led);
  return led;
}

function prune(led) {
  const cutoff = dayKey(RETENTION_DAYS);
  for (const day of Object.keys(led.data.days)) if (day < cutoff) delete led.data.days[day];
}

function flush(app, led) {
  if (led.timer) { clearTimeout(led.timer); led.timer = null; }
  if (!led.dirty || !dir) return;
  prune(led);
  const file = ledgerPath(app);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(led.data), 'utf-8');
  fs.renameSync(tmp, file);
  led.dirty = false;
}

function scheduleFlush(app, led) {
  led.dirty = true;
  if (led.timer) return;
  led.timer = setTimeout(() => { led.timer = null; try { flush(app, led); } catch {} }, FLUSH_MS);
  if (led.timer.unref) led.timer.unref();
}

function flushAll() {
  for (const [app, led] of ledgers) { try { flush(app, led); } catch {} }
}

// --- writes -------------------------------------------------------------------

// record({ app, appDir?, method, principal?, origin?, subscribed?, costUsd,
//          priced?, units?, inTok?, outTok?, cacheTok? })
function record(entry) {
  const app = entry.app;
  if (!app) return;
  // A process-isolated app runner never writes the shared ledger file (two
  // writers would clobber each other): it relays the record to the dashboard,
  // whose broadcast tap folds it in. Reads here stay on the last flushed file.
  if (_relay) { try { _relay({ ...entry, appDir: undefined }); } catch {} noteCall(app, entry.principal || '_app'); noteCall(app, '__all__'); return; }
  const led = load(app, entry.appDir);
  const d = led.data.days[dayKey()] || (led.data.days[dayKey()] = emptyDay());
  const t = {
    calls: 1, costUsd: Number(entry.costUsd) || 0,
    inTok: entry.inTok || 0, outTok: entry.outTok || 0, cacheTok: entry.cacheTok || 0,
    units: Number(entry.units) || 0, unpriced: entry.priced === false ? 1 : 0,
  };
  add(d.total, t);
  if (entry.subscribed) add(d.sub || (d.sub = emptyTotal()), t);
  const pk = entry.principal || '_app';
  add(d.principals[pk] || (d.principals[pk] = emptyTotal()), t);
  const ok = entry.origin || 'unknown';
  add(d.origins[ok] || (d.origins[ok] = emptyTotal()), t);
  const mk = entry.method || 'unknown';
  add(d.methods[mk] || (d.methods[mk] = emptyTotal()), t);
  scheduleFlush(app, led);
  noteCall(app, pk);
  noteCall(app, '__all__');
}

function recordBlocked(app, code, appDir) {
  if (!app) return;
  const led = load(app, appDir);
  const d = led.data.days[dayKey()] || (led.data.days[dayKey()] = emptyDay());
  d.blocked[code] = (d.blocked[code] || 0) + 1;
  scheduleFlush(app, led);
}

// Sliding one-minute call counter per (app, principal) for rate limits.
function noteCall(app, principal) {
  const key = `${app}|${principal || '_app'}`;
  const now = Date.now();
  const arr = (minuteWindow.get(key) || []).filter((t) => now - t < 60000);
  arr.push(now);
  minuteWindow.set(key, arr);
  if (minuteWindow.size > 5000) { for (const k of minuteWindow.keys()) { if (minuteWindow.size <= 4000) break; minuteWindow.delete(k); } }
}
function callsLastMinute(app, principal) {
  const now = Date.now();
  return ((minuteWindow.get(`${app}|${principal || '_app'}`) || []).filter((t) => now - t < 60000)).length;
}

// --- reads --------------------------------------------------------------------

function usdToCredits(usd) { return Math.round((Number(usd) || 0) * CREDITS_PER_USD); }

// Spend in credits for one bucket over today or this calendar month.
//   scope: 'day' | 'month'; view: 'total' | 'sub' (subscriber slice of total)
//   | 'principal' | 'origin' | 'method'; key for principal/origin/method views
function spent(app, { scope = 'day', view = 'total', key } = {}, appDir) {
  const led = load(app, appDir);
  const days = scope === 'month'
    ? Object.keys(led.data.days).filter((d) => d.startsWith(monthPrefix()))
    : [dayKey()];
  let usd = 0, calls = 0;
  for (const day of days) {
    const d = led.data.days[day];
    if (!d) continue;
    let t = null;
    if (view === 'total') t = d.total;
    else if (view === 'sub') t = d.sub;
    else if (view === 'principal') t = d.principals[key];
    else if (view === 'origin') t = d.origins[key];
    else if (view === 'method') t = d.methods[key];
    if (!t) continue;
    usd += t.costUsd || 0;
    calls += t.calls || 0;
  }
  return { costUsd: usd, credits: usdToCredits(usd), calls };
}

// Dashboard summary for one app.
function summary(app, { days = 30 } = {}, appDir) {
  const led = load(app, appDir);
  const n = Math.min(RETENTION_DAYS, Math.max(1, Number(days) || 30));
  const out = {
    today: emptyTotal(), month: emptyTotal(), window: emptyTotal(), days: n,
    subscribed: { today: emptyTotal(), month: emptyTotal() },
    byPrincipal: {}, byOrigin: {}, byMethod: {}, blocked: {}, series: [], yesterdayAvg7: 0,
  };
  const mp = monthPrefix();
  for (let i = 0; i < n; i++) {
    const day = dayKey(i);
    const d = led.data.days[day];
    out.series.unshift({ day, costUsd: d ? d.total.costUsd : 0, calls: d ? d.total.calls : 0 });
    if (!d) continue;
    add(out.window, d.total);
    if (i === 0) add(out.today, d.total);
    if (day.startsWith(mp)) add(out.month, d.total);
    if (d.sub) {
      if (i === 0) add(out.subscribed.today, d.sub);
      if (day.startsWith(mp)) add(out.subscribed.month, d.sub);
    }
    for (const [k, t] of Object.entries(d.principals)) add(out.byPrincipal[k] || (out.byPrincipal[k] = emptyTotal()), t);
    for (const [k, t] of Object.entries(d.origins)) add(out.byOrigin[k] || (out.byOrigin[k] = emptyTotal()), t);
    for (const [k, t] of Object.entries(d.methods)) add(out.byMethod[k] || (out.byMethod[k] = emptyTotal()), t);
    for (const [k, c] of Object.entries(d.blocked)) out.blocked[k] = (out.blocked[k] || 0) + c;
  }
  // Baseline for anomaly detection: mean of the previous 7 days.
  let sum = 0;
  for (let i = 1; i <= 7; i++) { const d = led.data.days[dayKey(i)]; sum += d ? d.total.costUsd : 0; }
  out.yesterdayAvg7 = sum / 7;
  for (const t of [out.today, out.month, out.window]) t.credits = usdToCredits(t.costUsd);
  return out;
}

// Legacy `ai.usage` / `ctx.aiUsage` shape, unchanged for apps:
//   { meterKey, days, calls, inTok, outTok, cacheTok, costUsd }
// meterKey buckets are stored as principal 'meter:<key>'; omitted → app-wide.
function query(appDir, params) {
  const p = params || {};
  const app = path.basename(appDir);
  const n = Math.min(RETENTION_DAYS, Math.max(1, Number(p.days) || 30));
  const key = p.meterKey != null && p.meterKey !== '' ? String(p.meterKey) : null;
  const led = load(app, appDir);
  const out = { meterKey: key, days: n, calls: 0, inTok: 0, outTok: 0, cacheTok: 0, costUsd: 0 };
  for (let i = 0; i < n; i++) {
    const d = led.data.days[dayKey(i)];
    if (!d) continue;
    const t = key ? (d.principals[`meter:${key}`] || d.principals[key]) : d.total;
    if (!t) continue;
    out.calls += t.calls || 0;
    out.inTok += t.inTok || 0;
    out.outTok += t.outTok || 0;
    out.cacheTok += t.cacheTok || 0;
    out.costUsd += t.costUsd || 0;
  }
  return out;
}

// --- storage ------------------------------------------------------------------
// One measurement per sweep (storage-meter.js, hourly): the app's total bytes
// (app dir minus node_modules, plus its DB). Stored in the same per-app ledger
// file under `storage`: per-day first/last totals — new storage today is
// last − first (the first measurement of the day is the midnight baseline).
// `overCount` counts consecutive over-cap measurements for the breach grace
// window (a breach must persist 2 measurements before anything is paused).

function storageOf(led) {
  return led.data.storage || (led.data.storage = { days: {}, overCount: 0 });
}

function recordStorage(app, bytes, appDir, { breakdown } = {}) {
  const led = load(app, appDir);
  const s = storageOf(led);
  const day = dayKey();
  const d = s.days[day] || (s.days[day] = { first: bytes });
  d.last = bytes;
  s.lastAt = Date.now();
  if (breakdown) s.breakdown = breakdown;
  const cutoff = dayKey(RETENTION_DAYS);
  for (const k of Object.keys(s.days)) if (k < cutoff) delete s.days[k];
  scheduleFlush(app, led);
  return storageStatus(app, appDir);
}

// Consecutive over-cap counter: bumped while over, reset the moment a
// measurement is back under (or the cap is lifted). Returns the new count.
function noteStorageOver(app, over, appDir) {
  const led = load(app, appDir);
  const s = storageOf(led);
  const next = over ? (s.overCount || 0) + 1 : 0;
  if (next !== (s.overCount || 0)) { s.overCount = next; scheduleFlush(app, led); }
  return next;
}

// { measuredAt, bytes, todayStartBytes, deltaBytes, overCount, breakdown }
// deltaBytes may be negative (the app freed space today).
function storageStatus(app, appDir) {
  const led = load(app, appDir);
  const s = led.data.storage;
  if (!s) return { measuredAt: null, bytes: null, todayStartBytes: null, deltaBytes: 0, overCount: 0, breakdown: null };
  const d = s.days[dayKey()];
  return {
    measuredAt: s.lastAt || null,
    bytes: d ? d.last : null,
    todayStartBytes: d ? d.first : null,
    deltaBytes: d ? (d.last - d.first) : 0,
    overCount: s.overCount || 0,
    breakdown: s.breakdown || null,
  };
}

// What one aiPrompt session burned, folded out of core's InteractionStore by the
// instanceId that call returns. READ-ONLY — it records nothing — so a caller who
// only wants the number can ask without double-counting against whichever path
// actually settles the session: the proxy's interaction:complete tap, or the
// fold in closeAiCall.
function usageOfInstance(instanceId) {
  const out = { inTok: 0, outTok: 0, cacheTok: 0, costUsd: 0, turns: 0 };
  if (!_store || typeof _store.getAll !== 'function') return out;
  for (const it of _store.getAll()) {
    if (!it || it.instanceId !== instanceId || it.isHook || it.isMcp || !it.usage) continue;
    out.turns++;
    out.inTok += it.usage.input_tokens || 0;
    out.outTok += it.usage.output_tokens || 0;
    out.cacheTok += (it.usage.cache_read_input_tokens || 0) + (it.usage.cache_creation_input_tokens || 0);
    out.costUsd += computeCost(it.usage, it.pricing) || 0;
  }
  return out;
}

function recordSession(appName, appDir, instanceId, { principal, origin, subscribed } = {}) {
  if (!_store || typeof _store.getAll !== 'function') return false;
  const u = usageOfInstance(instanceId);
  if (u.turns === 0) return false;
  record({
    app: appName, appDir, method: 'ai.prompt', principal, origin, subscribed,
    costUsd: u.costUsd, priced: true, inTok: u.inTok, outTok: u.outTok, cacheTok: u.cacheTok, units: u.turns,
  });
  return true;
}

module.exports = {
  RETENTION_DAYS, CREDITS_PER_USD,
  init, record, recordBlocked, recordSession, usageOfInstance, spent, summary, query, flushAll, computeCost, usdToCredits, callsLastMinute, dayKey,
  recordStorage, noteStorageOver, storageStatus,
};
