'use strict';
// Site analytics engine (docs/analytics.md). Privacy-friendly counting for an
// app's sites with zero app code: a site opts in with manifest
// `sites.<site>.analytics: true`; its runner appends one anonymised record per
// request to an NDJSON spool in the site's data dir; this module ingests the
// spool into MariaDB (continuously, on start, and after a crash — idempotently),
// rolls days up, prunes by retention, and answers query / live / csv.
//
//   site-analytics.js (platform/)  capture + anonymise (runner AND import)
//   analytics-store.js             schema, ingest, rollup, prune
//   analytics-query.js             query / live / csv (allowlisted)
//   analytics-geo.js               the platform-wide country table + monthly job

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const lib = require('../../site-analytics');
const store = require('./analytics-store');
const queryMod = require('./analytics-query');
const geo = require('./analytics-geo');

const CHUNK = 4 * 1024 * 1024;
const BATCH = 2000;
const SAFETY_MS = 60000;
const LIVE_RECHECK_MS = 30000;
const IMPORT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

let opts = { broadcast: null };
let clock = () => Date.now();
const chains = new Map();       // 'app/site' → promise (one ingest at a time per site)
const debounce = new Map();     // 'app/site' → timer
const liveTimers = new Map();
const last = new Map();         // 'app/site' → { at, added, error }
let timer = null;
let unsubDb = null;

const appManager = () => require('./app-manager');
const sitesEngine = () => require('./sites');
const key = (app, site) => `${app}/${site}`;
const today = () => lib.dayOf(clock());

function init(o = {}) {
  opts = { ...opts, ...o };
  if (!unsubDb) {
    try {
      unsubDb = require('./app-db').onStatus((ev) => {
        if (ev && ev.up) { store.reset(); scanAll().catch(() => {}); } else store.reset();
      });
    } catch { /* no db module in a bare harness */ }
  }
  if (!timer) {
    timer = setInterval(() => { scanAll().catch(() => {}); }, SAFETY_MS);
    if (timer.unref) timer.unref();
  }
}
function shutdown() {
  if (timer) { clearInterval(timer); timer = null; }
  if (unsubDb) { unsubDb(); unsubDb = null; }
  for (const t of debounce.values()) clearTimeout(t);
  for (const t of liveTimers.values()) clearTimeout(t);
  debounce.clear(); liveTimers.clear();
}
function setClock(fn) { clock = typeof fn === 'function' ? fn : () => Date.now(); }

function broadcast(msg) { try { opts.broadcast?.(msg); } catch { /* no dashboard */ } }

// ── sites ─────────────────────────────────────────────────────────────────
function declaredSite(app, site) {
  const d = sitesEngine().declared(app).sites[site];
  if (!d) throw Object.assign(new Error(`app "${app}" declares no site "${site}"`), { code: 'unknown_site' });
  return d;
}
function requireEnabled(app, site) {
  const d = declaredSite(app, site);
  if (!d.analytics) throw Object.assign(new Error(`site "${site}" has no analytics: set "analytics": true in manifest.sites.${site}`), { code: 'analytics_off' });
  return d;
}
function enabledSites() {
  const out = [];
  let apps = [];
  try { apps = appManager().list().map((a) => a.name); } catch { /* none */ }
  for (const app of apps) {
    let d;
    try { d = sitesEngine().declared(app).sites; } catch { continue; }
    for (const [site, def] of Object.entries(d)) if (def.analytics) out.push({ app, site });
  }
  return out;
}
function spoolDir(app, site) { return path.join(appManager().appDir(app), '.data', 'sites', site, 'data', '.analytics'); }
function retention(app, site) {
  try { const e = sitesEngine().effective(app, site); return { rawDays: e.analyticsRawDays, months: e.analyticsMonths }; } catch { return { rawDays: 90, months: 13 }; }
}

// ── ingest ────────────────────────────────────────────────────────────────
function spoolFiles(dir) {
  try { return fs.readdirSync(dir).map((f) => lib.SPOOL_RE.exec(f)).filter(Boolean).map((m) => ({ file: m[0], seq: Number(m[1]), src: m[0].replace(/\.ndjson$/, '') })).sort((a, b) => a.seq - b.seq); } catch { return []; }
}

// Read one spool file from `from`; returns { off, rows, bad } over COMPLETE lines only
// (a torn last line — the runner was killed mid-write — stays unread).
function readChunk(fd, from, size, app, site, src, nowMs) {
  const len = Math.min(CHUNK, size - from);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, from);
  const nl = buf.lastIndexOf(10);
  if (nl < 0) return { off: from, rows: [], bad: 0, more: false, torn: len >= CHUNK };
  const rows = [];
  let bad = 0, pos = 0;
  while (pos <= nl) {
    const end = buf.indexOf(10, pos);
    if (end < 0) break;
    const line = buf.toString('utf8', pos, end);
    if (line) {
      let rec = null;
      try { rec = JSON.parse(line); } catch { /* torn or foreign */ }
      const row = store.rowOf(app, site, src, from + pos, rec, nowMs);
      if (row) rows.push(row); else bad++;
    }
    pos = end + 1;
  }
  return { off: from + nl + 1, rows, bad, more: from + nl + 1 < size };
}

async function ingestNow(app, site) {
  if (!(await store.ensure())) return { ok: false, reason: 'no_database', added: 0 };
  const dir = spoolDir(app, site);
  const files = spoolFiles(dir);
  if (!files.length) return { ok: true, added: 0 };
  const done = await store.offsets(app, site);
  const newest = files[files.length - 1].seq;
  let added = 0, bad = 0, pages = 0;
  const nowMs = clock();
  for (const f of files) {
    const full = path.join(dir, f.file);
    let fd;
    try { fd = fs.openSync(full, 'r'); } catch { continue; }
    try {
      let size = fs.fstatSync(fd).size;
      let off = done.get(f.src) || 0;
      if (off > size) off = 0;   // a file rewritten under the same name: the unique key still protects the rows
      for (;;) {
        if (off >= size) break;
        const r = readChunk(fd, off, size, app, site, f.src, nowMs);
        if (r.off === off) break;   // only a torn tail left
        bad += r.bad;
        for (let i = 0; i < r.rows.length; i += BATCH) {
          const part = r.rows.slice(i, i + BATCH);
          const isLast = i + BATCH >= r.rows.length;
          added += await store.ingest(app, site, f.src, part, isLast ? r.off : off);
          pages += part.filter((x) => x[6] === 'page').length;
        }
        if (!r.rows.length) await store.ingest(app, site, f.src, [], r.off);
        off = r.off;
        size = fs.fstatSync(fd).size;
      }
      // a finished file (not the newest: its writer is gone) is deleted once fully ingested
      if (f.seq !== newest) {
        try { fs.closeSync(fd); fd = null; } catch { /* closed */ }
        try { fs.unlinkSync(full); await store.forgetSpool(app, site, f.src); } catch { /* gone */ }
      }
    } finally { if (fd !== null && fd !== undefined) { try { fs.closeSync(fd); } catch { /* closed */ } } }
  }
  last.set(key(app, site), { at: clock(), added, error: null });
  if (added) await emitLive(app, site, { added, pageviews: pages });
  return { ok: true, added, bad };
}

function ingest(app, site) {
  const k = key(app, site);
  const run = (chains.get(k) || Promise.resolve()).catch(() => {}).then(() => ingestNow(app, site)).catch((e) => {
    last.set(k, { at: clock(), added: 0, error: e.message });
    return { ok: false, reason: e.message, added: 0 };
  });
  chains.set(k, run);
  run.finally(() => { if (chains.get(k) === run) chains.delete(k); });
  return run;
}
// the runner says "new records": debounce, then ingest
function notify(app, site) {
  const k = key(app, site);
  if (debounce.has(k)) return;
  const t = setTimeout(() => { debounce.delete(k); ingest(app, site); }, 300);
  if (t.unref) t.unref();
  debounce.set(k, t);
}
async function scanAll() {
  if (!store.hasDb()) return;
  for (const { app, site } of enabledSites()) {
    if (spoolFiles(spoolDir(app, site)).length) await ingest(app, site);
  }
}

// ── live ──────────────────────────────────────────────────────────────────
async function emitLive(app, site, extra = {}) {
  let n = 0;
  try { n = await queryMod.live(app, site, clock()); } catch { return; }
  const data = { app, site, live: n, at: clock(), ...extra };
  broadcast({ type: 'app:bridge:event', appName: app, event: 'analytics:live', data });
  broadcast({ type: 'app:analytics', appName: app, site, event: 'analytics:live', data });
  // visitors age out of the 5-minute window without any new hit: re-announce while someone is live
  const k = key(app, site);
  clearTimeout(liveTimers.get(k));
  if (n > 0) {
    const t = setTimeout(() => { liveTimers.delete(k); emitLive(app, site).catch(() => {}); }, LIVE_RECHECK_MS);
    if (t.unref) t.unref();
    liveTimers.set(k, t);
  }
}

// ── daily job: ingest, roll up finished days, prune ─────────────────────────
async function daily() {
  if (!(await store.ensure())) return { ok: false, reason: 'no_database' };
  const out = { rolled: 0, pruned: { raw: 0, daily: 0 }, salts: 0 };
  const targets = new Map();
  for (const s of enabledSites()) targets.set(key(s.app, s.site), s);
  for (const s of await store.sites()) targets.set(key(s.app, s.site), s);
  for (const { app, site } of targets.values()) {
    try { await ingest(app, site); } catch { /* next */ }
    for (const day of await store.daysToRollup(app, site, today())) { await store.rollupDay(app, site, day); out.rolled++; }
    const r = retention(app, site);
    const p = await store.prune(app, site, clock(), r.rawDays, r.months);
    out.pruned.raw += p.raw; out.pruned.daily += p.daily;
  }
  for (const { app, site } of enabledSites()) if (lib.destroyStaleSalt(spoolDir(app, site), clock())) out.salts++;
  return { ok: true, ...out };
}
function registerCron(platformCron) {
  platformCron.registerInternal('analytics.daily', () => daily());
  geo.register(platformCron);
  try {
    if (!platformCron.list().some((j) => j.name === 'analytics:daily')) {
      const res = platformCron.addJob({ name: 'analytics:daily', schedule: '10 0 * * *', target: { type: 'internal', handler: 'analytics.daily' } });
      if (!res.ok) console.error(`  Analytics: failed to register the daily job: ${res.error}`);
    }
  } catch (e) { console.error('  Analytics: daily cron:', e.message); }
}

// ── reads (scoped by the caller to an app) ─────────────────────────────────
async function query(app, site, params) { requireEnabled(app, site); return queryMod.query(app, site, params, today()); }
async function live(app, site) { requireEnabled(app, site); return queryMod.live(app, site, clock()); }
async function csv(app, site, params) { requireEnabled(app, site); return queryMod.csv(app, site, params, today()); }

async function status(app, site) {
  const d = declaredSite(app, site);
  const dir = spoolDir(app, site);
  const files = spoolFiles(dir);
  let bytes = 0;
  for (const f of files) { try { bytes += fs.statSync(path.join(dir, f.file)).size; } catch { /* gone */ } }
  const r = retention(app, site);
  const l = last.get(key(app, site)) || null;
  return {
    app, site, enabled: !!d.analytics, db: store.hasDb(), spool: { files: files.length, bytes },
    rawDays: r.rawDays, months: r.months, lastIngest: l, geo: geo.status(), credit: geo.CREDIT,
  };
}

// A custom event from the app's own code (ctx.analytics.track): written straight to the table.
async function track(app, site, name, props) {
  requireEnabled(app, site);
  const ev = lib.cleanEvent(name, props);
  if (!ev) throw Object.assign(new Error('track: a name of 1–64 [A-Za-z0-9_.:-]'), { code: 'bad_event' });
  if (!(await store.ensure())) throw Object.assign(new Error('no database configured'), { code: 'no_database' });
  const rec = { t: clock(), k: 'event', n: ev.name, pr: ev.props || undefined, bot: 0 };
  const row = store.rowOf(app, site, `ctx-${crypto.randomBytes(6).toString('hex')}`, 0, rec, clock());
  await store.withConn((c) => store.insertRows(c, [row]));
  emitLive(app, site, { added: 1, event: ev.name }).catch(() => {});
  return { ok: true };
}

// ── access-log import (nginx combined) ───────────────────────────────────
// The same anonymiser as the live capture. A log has no daily salt of ours, so
// each day of the import gets a fresh random salt that lives only for the run:
// a visitor is one within a day of the file, never linkable across days.
async function importAccessLog(app, site, file, { format = 'nginx-combined' } = {}) {
  requireEnabled(app, site);
  if (format !== 'nginx-combined') throw Object.assign(new Error('format: "nginx-combined"'), { code: 'bad_format' });
  if (typeof file !== 'string' || !file) throw Object.assign(new Error('file required'), { code: 'bad_file' });
  const st = fs.statSync(file);
  if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'bad_file' });
  if (st.size > IMPORT_MAX_BYTES) throw Object.assign(new Error('the log is over 2 GB: split it'), { code: 'too_large' });
  if (!(await store.ensure())) throw Object.assign(new Error('no database configured'), { code: 'no_database' });
  const sum = await new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex').slice(0, 12))).on('error', reject);
  });
  const src = `imp-${sum}`;
  const r = retention(app, site);
  const cut = lib.dayOf(clock() - r.rawDays * 86400000);
  const eff = sitesEngine().effective(app, site);
  const salts = new Map();
  const handle = lib.geoHandle(geo.tableFile(), clock);
  const rows = [];
  const res = { format, lines: 0, imported: 0, duplicates: 0, bad: 0, tooOld: 0, bots: 0, days: [] };
  const days = new Set();
  const countSrc = async () => Number((await store.q('SELECT COUNT(*) AS n FROM analytics_hits WHERE app = ? AND site = ? AND src = ?', [app, site, src]))[0].n);
  const before = await countSrc();
  let valid = 0;
  const flush = async () => {
    if (!rows.length) return;
    const part = rows.splice(0, rows.length);
    valid += part.length;
    await store.withConn((c) => store.insertRows(c, part));
  };
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    n++;
    res.lines++;
    const p = lib.parseCombined(line);
    if (!p) { res.bad++; continue; }
    const day = lib.dayOf(p.ts);
    if (day < cut) { res.tooOld++; continue; }
    if (!salts.has(day)) salts.set(day, crypto.randomBytes(24).toString('hex'));
    const rec = lib.recordFromLog(p, { siteKey: key(app, site), salt: salts.get(day), geo: handle.get(), internalHosts: eff.domain ? [eff.domain] : [] });
    const row = store.rowOf(app, site, src, n, rec, clock());
    if (!row) { res.bad++; continue; }
    if (rec.bot) res.bots++;
    days.add(day);
    rows.push(row);
    if (rows.length >= BATCH) await flush();
  }
  await flush();
  res.imported = (await countSrc()) - before;   // INSERT IGNORE: what is new, not what was tried
  res.duplicates = valid - res.imported;
  // finished days are rolled up now (rebuilt from raw); today's is the cron's
  for (const d of [...days].sort()) if (d < today()) await store.rollupDay(app, site, d);
  res.days = [...days].sort();
  emitLive(app, site, { added: res.imported }).catch(() => {});
  return res;
}

async function removeApp(app) { if (store.hasDb() && (await store.ensure())) await store.q('DELETE FROM analytics_hits WHERE app=?', [app]).then(() => store.q('DELETE FROM analytics_daily WHERE app=?', [app])).then(() => store.q('DELETE FROM analytics_spool WHERE app=?', [app])); }
async function renameApp(from, to) { if (store.hasDb() && (await store.ensure())) await store.renameApp(from, to); }

// The dashboard's own Sites tab (WS app:analytics:call): the same engine, scoped to the named app.
async function ownerCall(app, method, p = {}) {
  const site = String(p.site || '');
  // params arrive as { params } (the WS message) or flat next to `site` (the component's call shape)
  const params = p.params || (({ site: _s, method: _m, name: _n, reqId: _r, type: _t, ...rest }) => rest)(p);
  switch (method) {
    case 'query': return query(app, site, params);
    case 'live': return { live: await live(app, site) };
    case 'csv': return { csv: await csv(app, site, params) };
    case 'status': return status(app, site);
    default: throw Object.assign(new Error(`unknown analytics call "${method}"`), { code: 'bad_method' });
  }
}

module.exports = {
  init, shutdown, setClock, notify, ingest, scanAll, daily, registerCron,
  query, live, csv, status, track, importAccessLog, ownerCall, removeApp, renameApp,
  enabledSites, spoolDir, retention, _last: last,
};
