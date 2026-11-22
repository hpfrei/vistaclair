// Spend ledger — every metered platform call, per app, unconditionally.
//
// Replaces ai-usage.js (LLM-only, appDir/.ai-usage.json). One file per app
// under <dataHome>/spend-ledger/<app>.json, day buckets, NO age cutoff: the
// file holds the current month's days; at flush every earlier month moves into
// its own shard <dataHome>/spend-ledger/<app>/<YYYY-MM>.json, read lazily.
// Every record is folded into five views of the same day: the day total, by
// principal ('owner' / 'acct:<id>' / 'user:<id>' / 'meter:<key>' / '_app'
// for unattributed), by origin (route / bridge / job / bot / tool / horst /
// cron / cli), by method, and by (principal, model) with the API list-price
// cost beside the recorded one (`usage`, read by query()). Blocked decisions
// are counted too, so observe mode shows what enforcement WOULD have stopped.
//
// Units: credits = USD × 1000. costUsd is stored; credits are derived.
//
// The old ledger is imported once (per app) the first time the new one is
// opened, so ai.usage / ctx.aiUsage keep returning history across the upgrade.
const fs = require('fs');
const path = require('path');

const SUMMARY_MAX_DAYS = 366; // the dashboard summary's series window, not a retention limit
const STORAGE_HISTORY_DAYS = 93; // storage-measurement days kept (today's delta is all that is read)
const FLUSH_MS = 2000;
const CREDITS_PER_USD = 1000;

let dir = null;
let _store = null; // core InteractionStore (fallback fold for headless runners)
let _relay = null; // headless runner: forward records to the dashboard instead of writing
const ledgers = new Map(); // app → { app, data, dirty, timer, shards: Map<YYYY-MM, { days, dirty }> }
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

// `usage` is the per-day (principal → model) view: { calls, costUsd, apiUsd,
// inTok, outTok, cacheTok, unpriced }. Model key '' = no model recorded.
// Days recorded before it existed (or partly before) have no `usage` for the
// part that predates it: usageBuckets() derives that residual from `principals`.
function emptyUsage() { return { calls: 0, costUsd: 0, apiUsd: 0, inTok: 0, outTok: 0, cacheTok: 0, unpriced: 0 }; }

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
  led = { app, data, dirty: !!data.importedLegacyAt, timer: null, shards: new Map() };
  ledgers.set(app, led);
  if (led.dirty) scheduleFlush(app, led);
  return led;
}

// --- month shards ---------------------------------------------------------------

function shardDir(app) { return path.join(dir, app); }
function shardPath(app, month) { return path.join(shardDir(app), `${month}.json`); }

// The shard of one earlier month, read once and cached (an absent file is an
// empty shard). Only months before the current one ever live in a shard.
function shardOf(led, month) {
  let sh = led.shards.get(month);
  if (sh) return sh;
  sh = { days: {}, dirty: false };
  if (dir) {
    try {
      const j = JSON.parse(fs.readFileSync(shardPath(led.app, month), 'utf-8'));
      if (j && typeof j.days === 'object') sh.days = j.days;
    } catch {}
  }
  led.shards.set(month, sh);
  return sh;
}

// One day's bucket wherever it lives: the main file, else its month's shard.
function dayOf(led, day) {
  const cur = led.data.days[day];
  if (cur) return cur;
  const month = day.slice(0, 7);
  if (month >= monthPrefix()) return undefined;
  return shardOf(led, month).days[day];
}

// Every day key present (main + shards) within [from, to], ascending.
function daysInRange(led, from, to) {
  const out = new Set();
  for (const day of Object.keys(led.data.days)) if (day >= from && day <= to) out.add(day);
  if (dir) {
    const fromM = from.slice(0, 7), toM = to.slice(0, 7);
    let files = [];
    try { files = fs.readdirSync(shardDir(led.app)); } catch {}
    const months = new Set(files.map((f) => /^(\d{4}-\d{2})\.json$/.exec(f)).filter(Boolean).map((m) => m[1]));
    for (const m of led.shards.keys()) months.add(m);
    for (const m of months) {
      if (m < fromM || m > toM || m >= monthPrefix()) continue;
      for (const day of Object.keys(shardOf(led, m).days)) if (day >= from && day <= to) out.add(day);
    }
  }
  return [...out].sort();
}

// Move every day of an earlier month out of the main file into its shard.
function migrate(led) {
  const cur = monthPrefix();
  for (const day of Object.keys(led.data.days)) {
    const month = day.slice(0, 7);
    if (month >= cur) continue;
    const sh = shardOf(led, month);
    sh.days[day] = led.data.days[day];
    sh.dirty = true;
    delete led.data.days[day];
  }
}

function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf-8');
  fs.renameSync(tmp, file);
}

function flush(app, led) {
  if (led.timer) { clearTimeout(led.timer); led.timer = null; }
  if (!led.dirty || !dir) return;
  migrate(led);
  // Shards first: a crash between the writes leaves a day in both places
  // (identical content), never in neither.
  for (const [month, sh] of led.shards) {
    if (!sh.dirty) continue;
    fs.mkdirSync(shardDir(app), { recursive: true });
    writeJson(shardPath(app, month), { v: 2, month, days: sh.days });
    sh.dirty = false;
  }
  writeJson(ledgerPath(app), led.data);
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
//          priced?, units?, inTok?, outTok?, cacheTok?, model?, apiUsd?, calls? })
// `costUsd` is what the spend caps count; `apiUsd` (default: costUsd) is the
// call's tokens × the model's API list price. `calls` defaults to 1 (0 books
// the extra per-model slices of one call).
function record(entry) {
  const app = entry.app;
  if (!app) return;
  // A process-isolated app runner never writes the shared ledger file (two
  // writers would clobber each other): it relays the record to the dashboard,
  // whose broadcast tap folds it in. Reads here stay on the last flushed file.
  if (_relay) { try { _relay({ ...entry, appDir: undefined }); } catch {} noteCall(app, entry.principal || '_app'); noteCall(app, '__all__'); return; }
  const led = load(app, entry.appDir);
  const d = led.data.days[dayKey()] || (led.data.days[dayKey()] = emptyDay());
  const calls = Number.isFinite(entry.calls) ? entry.calls : 1;
  const t = {
    calls, costUsd: Number(entry.costUsd) || 0,
    inTok: entry.inTok || 0, outTok: entry.outTok || 0, cacheTok: entry.cacheTok || 0,
    units: Number(entry.units) || 0, unpriced: entry.priced === false ? calls : 0,
  };
  add(d.total, t);
  if (entry.subscribed) add(d.sub || (d.sub = emptyTotal()), t);
  const pk = entry.principal || '_app';
  add(d.principals[pk] || (d.principals[pk] = emptyTotal()), t);
  const ok = entry.origin || 'unknown';
  add(d.origins[ok] || (d.origins[ok] = emptyTotal()), t);
  const mk = entry.method || 'unknown';
  add(d.methods[mk] || (d.methods[mk] = emptyTotal()), t);
  const byPrincipal = (d.usage || (d.usage = {}))[pk] || (d.usage[pk] = {});
  const u = byPrincipal[entry.model ? String(entry.model) : ''] || (byPrincipal[entry.model ? String(entry.model) : ''] = emptyUsage());
  u.calls += t.calls; u.costUsd += t.costUsd; u.inTok += t.inTok; u.outTok += t.outTok; u.cacheTok += t.cacheTok;
  u.apiUsd += entry.apiUsd != null ? (Number(entry.apiUsd) || 0) : t.costUsd;
  u.unpriced += t.unpriced;
  scheduleFlush(app, led);
  if (calls > 0) { noteCall(app, pk); noteCall(app, '__all__'); }
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
  const n = Math.min(SUMMARY_MAX_DAYS, Math.max(1, Number(days) || 30));
  const out = {
    today: emptyTotal(), month: emptyTotal(), window: emptyTotal(), days: n,
    subscribed: { today: emptyTotal(), month: emptyTotal() },
    byPrincipal: {}, byOrigin: {}, byMethod: {}, blocked: {}, series: [], yesterdayAvg7: 0,
  };
  const mp = monthPrefix();
  for (let i = 0; i < n; i++) {
    const day = dayKey(i);
    const d = dayOf(led, day);
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
  for (let i = 1; i <= 7; i++) { const d = dayOf(led, dayKey(i)); sum += d ? d.total.costUsd : 0; }
  out.yesterdayAvg7 = sum / 7;
  for (const t of [out.today, out.month, out.window]) t.credits = usdToCredits(t.costUsd);
  return out;
}

// --- usage query (ai.usage / ctx.aiUsage) ------------------------------------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const GROUP_DIMS = ['day', 'model', 'meterKey'];

function badParams(msg) { const e = new Error(msg); e.code = 'E_BAD_PARAMS'; return e; }

// A 'YYYY-MM-DD' UTC calendar day → epoch ms of its midnight; throws on
// anything that is not a real date.
function parseDay(v, name) {
  if (typeof v !== 'string' || !DAY_RE.test(v)) throw badParams(`${name} must be a 'YYYY-MM-DD' UTC day`);
  const ms = Date.parse(`${v}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== v) throw badParams(`${name} "${v}" is not a calendar day`);
  return ms;
}
const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);

// { from, to, n } (inclusive UTC days). `days` (default 30) ends at `to`
// (default today) unless `from` is given, which wins.
function resolveRange(p) {
  const hasFrom = p.from != null, hasTo = p.to != null;
  const toMs = hasTo ? parseDay(p.to, 'to') : parseDay(dayKey(), 'to');
  let fromMs;
  if (hasFrom) fromMs = parseDay(p.from, 'from');
  else fromMs = toMs - (Math.max(1, Math.floor(Number(p.days) || 30)) - 1) * 86400e3;
  if (fromMs > toMs) throw badParams(`from ${dayStr(fromMs)} is after to ${dayStr(toMs)}`);
  return { from: dayStr(fromMs), to: dayStr(toMs), n: Math.round((toMs - fromMs) / 86400e3) + 1 };
}

function parseGroupBy(v) {
  if (v == null) return [];
  const list = Array.isArray(v) ? v : [v];
  const out = [];
  for (const g of list) {
    if (typeof g !== 'string' || !GROUP_DIMS.includes(g)) throw badParams(`groupBy must be ${GROUP_DIMS.map((x) => `'${x}'`).join(', ')} (or an array of them), got ${JSON.stringify(g)}`);
    if (!out.includes(g)) out.push(g);
  }
  return out;
}

// meterKey as an app sees it: 'meter:<key>' → '<key>', '_app' → null
// (unattributed); the other principals ('owner', 'acct:<id>', 'user:<id>',
// 'tg:<id>', ...) are their own key.
function meterKeyOf(principal) {
  if (principal === '_app') return null;
  return principal.startsWith('meter:') ? principal.slice(6) : principal;
}

// One day's (principal, model) buckets: the recorded `usage`, plus a residual
// per principal for whatever its totals hold beyond that (days recorded
// before the model dimension existed): model null, apiUsd = costUsd — the
// platform recorded those calls at list price.
function usageBuckets(d, principalFilter) {
  const out = [];
  for (const [pk, tot] of Object.entries(d.principals || {})) {
    if (principalFilter && !principalFilter(pk)) continue;
    const rec = (d.usage && d.usage[pk]) || {};
    const rest = emptyUsage();
    rest.calls = tot.calls || 0; rest.costUsd = tot.costUsd || 0; rest.inTok = tot.inTok || 0;
    rest.outTok = tot.outTok || 0; rest.cacheTok = tot.cacheTok || 0; rest.unpriced = tot.unpriced || 0;
    for (const [model, u] of Object.entries(rec)) {
      out.push({ principal: pk, model: model || null, u });
      rest.calls -= u.calls; rest.costUsd -= u.costUsd; rest.inTok -= u.inTok;
      rest.outTok -= u.outTok; rest.cacheTok -= u.cacheTok; rest.unpriced -= u.unpriced;
    }
    if (rest.calls > 0 || rest.inTok > 0 || rest.outTok > 0 || rest.cacheTok > 0 || rest.costUsd > 1e-9) {
      rest.calls = Math.max(0, rest.calls); rest.costUsd = Math.max(0, rest.costUsd);
      rest.inTok = Math.max(0, rest.inTok); rest.outTok = Math.max(0, rest.outTok);
      rest.cacheTok = Math.max(0, rest.cacheTok); rest.unpriced = Math.max(0, rest.unpriced);
      rest.apiUsd = rest.costUsd;
      out.push({ principal: pk, model: null, u: rest });
    }
  }
  return out;
}

function foldRow(r, u) {
  r.calls += u.calls; r.inTok += u.inTok; r.outTok += u.outTok; r.cacheTok += u.cacheTok;
  r.apiUsd += u.apiUsd; r.billedUsd += u.costUsd; r.unpriced += u.unpriced;
}
function emptyRow() { return { calls: 0, inTok: 0, outTok: 0, cacheTok: 0, apiUsd: 0, billedUsd: 0, unpriced: 0 }; }
const cmpNullFirst = (a, b) => (a === b ? 0 : a == null ? -1 : b == null ? 1 : a < b ? -1 : 1);

// `ai.usage` / `ctx.aiUsage`:
//   query(appDir, { meterKey?, days?, from?, to?, groupBy? })
//   → { meterKey, days, from, to, calls, inTok, outTok, cacheTok, costUsd,
//       apiUsd, billedUsd, total, rows? }
// The first seven fields are the original shape and meaning; costUsd ==
// billedUsd. meterKey buckets are stored as principal 'meter:<key>'; omitted →
// app-wide. Validation and aggregation live here, nowhere else.
function query(appDir, params) {
  const p = params || {};
  if (typeof p !== 'object' || Array.isArray(p)) throw badParams('ai.usage params must be an object');
  const app = path.basename(appDir);
  const range = resolveRange(p);
  const groupBy = parseGroupBy(p.groupBy);
  const key = p.meterKey != null && p.meterKey !== '' ? String(p.meterKey) : null;
  const led = load(app, appDir);
  const out = { meterKey: key, days: range.n, from: range.from, to: range.to, calls: 0, inTok: 0, outTok: 0, cacheTok: 0, costUsd: 0 };
  const total = emptyRow();
  const rows = new Map();
  for (const day of daysInRange(led, range.from, range.to)) {
    const d = dayOf(led, day);
    if (!d) continue;
    // The meterKey filter takes the first matching principal, as it always has.
    const principalFilter = key ? ((pk) => pk === (d.principals[`meter:${key}`] ? `meter:${key}` : key)) : null;
    const t = key ? (d.principals[`meter:${key}`] || d.principals[key]) : d.total;
    if (t) {
      out.calls += t.calls || 0; out.inTok += t.inTok || 0; out.outTok += t.outTok || 0;
      out.cacheTok += t.cacheTok || 0; out.costUsd += t.costUsd || 0;
    }
    for (const b of usageBuckets(d, principalFilter)) {
      foldRow(total, b.u);
      if (!groupBy.length) continue;
      const row = {};
      if (groupBy.includes('day')) row.day = day;
      if (groupBy.includes('model')) row.model = b.model;
      if (groupBy.includes('meterKey')) row.meterKey = meterKeyOf(b.principal);
      const rk = JSON.stringify([row.day, row.model, row.meterKey]);
      let r = rows.get(rk);
      if (!r) { r = Object.assign(row, emptyRow()); rows.set(rk, r); }
      foldRow(r, b.u);
    }
  }
  out.apiUsd = total.apiUsd;
  out.billedUsd = total.billedUsd;
  out.total = total;
  if (groupBy.length) {
    out.rows = [...rows.values()].sort((a, b) =>
      cmpNullFirst(a.day, b.day) || cmpNullFirst(a.model, b.model) || cmpNullFirst(a.meterKey, b.meterKey));
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
  const cutoff = dayKey(STORAGE_HISTORY_DAYS);
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
  const out = { inTok: 0, outTok: 0, cacheTok: 0, costUsd: 0, apiUsd: 0, turns: 0, model: null, byModel: {} };
  if (!_store || typeof _store.getAll !== 'function') return out;
  for (const it of _store.getAll()) {
    if (!it || it.instanceId !== instanceId || it.isHook || it.isMcp || !it.usage) continue;
    const inTok = it.usage.input_tokens || 0;
    const outTok = it.usage.output_tokens || 0;
    const cacheTok = (it.usage.cache_read_input_tokens || 0) + (it.usage.cache_creation_input_tokens || 0);
    const cost = computeCost(it.usage, it.pricing) || 0;
    out.turns++;
    out.inTok += inTok; out.outTok += outTok; out.cacheTok += cacheTok; out.costUsd += cost;
    const model = (it.request && it.request.model) || it.model || '';
    const m = out.byModel[model] || (out.byModel[model] = { inTok: 0, outTok: 0, cacheTok: 0, costUsd: 0, apiUsd: 0, turns: 0, unpriced: 0 });
    m.inTok += inTok; m.outTok += outTok; m.cacheTok += cacheTok; m.costUsd += cost; m.apiUsd += cost; m.turns++;
    if (!it.pricing) m.unpriced++;
  }
  out.apiUsd = out.costUsd;
  // The model that carried most of the call (by output tokens, then input).
  let best = null;
  for (const [model, m] of Object.entries(out.byModel)) {
    if (!best || m.outTok + m.inTok > out.byModel[best].outTok + out.byModel[best].inTok) best = model;
  }
  out.model = best || null;
  return out;
}

// One ledger entry per model the session used: the first carries the call
// (calls: 1, as ever), the rest are slices of it (calls: 0), so the day totals
// are unchanged and day × model stays exact.
function recordSession(appName, appDir, instanceId, { principal, origin, subscribed } = {}) {
  if (!_store || typeof _store.getAll !== 'function') return false;
  const u = usageOfInstance(instanceId);
  if (u.turns === 0) return false;
  let first = true;
  for (const [model, m] of Object.entries(u.byModel)) {
    record({
      app: appName, appDir, method: 'ai.prompt', principal, origin, subscribed, model: model || undefined,
      costUsd: m.costUsd, apiUsd: m.apiUsd, priced: true, inTok: m.inTok, outTok: m.outTok, cacheTok: m.cacheTok, units: m.turns,
      calls: first ? 1 : 0,
    });
    first = false;
  }
  return true;
}

module.exports = {
  CREDITS_PER_USD,
  init, record, recordBlocked, recordSession, usageOfInstance, spent, summary, query, flushAll, computeCost, usdToCredits, callsLastMinute, dayKey,
  recordStorage, noteStorageOver, storageStatus,
};
