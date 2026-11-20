'use strict';
// Site analytics storage (docs/analytics.md): the platform database
// `vc_platform_analytics` (per host, MariaDB), keyed by app + site.
//
//   analytics_hits   raw rows, 90 days by default (per-site setting)
//   analytics_daily  rollups per site/day/dimension, 13 months by default
//   analytics_spool  how far each spool file has been ingested
//
// Same pattern as email-engine.js: CREATE TABLE IF NOT EXISTS, conditional
// ALTER, a pooled connection that USEs the database. No database configured →
// `ready()` is false and the callers keep the spool.

const appDb = require('./app-db');

const DB = 'vc_platform_analytics';
const KINDS = ['page', 'asset', 'other', 'event'];

// every column after the keys; also the list `ensureColumns` adds when missing
const HIT_COLS = [
  ['src', 'VARCHAR(40) NOT NULL'], ['src_off', 'BIGINT NOT NULL'], ['ts', 'BIGINT NOT NULL'], ['day', 'DATE NOT NULL'],
  ['kind', "ENUM('page','asset','other','event') NOT NULL"], ['method', 'VARCHAR(8) NULL'], ['path', 'VARCHAR(255) NULL'],
  ['qs', 'VARCHAR(200) NULL'], ['status', 'SMALLINT NULL'], ['bytes', 'BIGINT NULL'], ['ms', 'INT NULL'],
  ['ref', 'VARCHAR(128) NULL'], ['utm_source', 'VARCHAR(64) NULL'], ['utm_medium', 'VARCHAR(64) NULL'], ['utm_campaign', 'VARCHAR(64) NULL'],
  ['browser', 'VARCHAR(24) NULL'], ['browser_v', 'SMALLINT NULL'], ['os', 'VARCHAR(16) NULL'], ['device', 'VARCHAR(16) NULL'],
  ['lang', 'VARCHAR(3) NULL'], ['country', 'CHAR(2) NULL'], ['is_bot', 'TINYINT NOT NULL DEFAULT 0'], ['visitor', 'CHAR(16) NULL'],
  ['name', 'VARCHAR(64) NULL'], ['props', 'VARCHAR(700) NULL'],
];
const INSERT_COLS = ['app', 'site', ...HIT_COLS.map((c) => c[0])];

let ready = false;
let initPromise = null;

function pool() { return appDb.getPool(); }
function hasDb() { return !!pool(); }

async function conn() {
  const p = pool();
  if (!p) throw Object.assign(new Error('no database configured'), { code: 'no_database' });
  const c = await p.getConnection();
  try { await c.query(`USE \`${DB}\``); } catch (e) { c.release(); throw e; }
  return c;
}
async function withConn(fn) {
  const c = await conn();
  try { return await fn(c); } finally { c.release(); }
}
async function q(sql, args = []) { return withConn((c) => c.query(sql, args)); }

async function initSchema() {
  const p = pool();
  if (!p) return false;
  const c = await p.getConnection();
  try {
    await c.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\``);
    await c.query(`USE \`${DB}\``);
    await c.query(`
      CREATE TABLE IF NOT EXISTS analytics_hits (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        app VARCHAR(64) NOT NULL,
        site VARCHAR(32) NOT NULL,
        ${HIT_COLS.map(([n, t]) => `${n} ${t}`).join(',\n        ')},
        UNIQUE KEY uq_src (app, site, src, src_off),
        KEY idx_day (app, site, day),
        KEY idx_ts (app, site, ts)
      ) ENGINE=InnoDB
    `);
    // additive columns for a table an earlier build created (conditional ALTER)
    for (const [n, t] of HIT_COLS) {
      try { await c.query(`ALTER TABLE analytics_hits ADD COLUMN IF NOT EXISTS ${n} ${t}`); } catch (e) { if (!/Duplicate column/i.test(e.message)) throw e; }
    }
    await c.query(`
      CREATE TABLE IF NOT EXISTS analytics_daily (
        app VARCHAR(64) NOT NULL,
        site VARCHAR(32) NOT NULL,
        day DATE NOT NULL,
        dim VARCHAR(16) NOT NULL,
        k VARCHAR(255) NOT NULL,
        bot TINYINT NOT NULL DEFAULT 0,
        views INT NOT NULL DEFAULT 0,
        hits INT NOT NULL DEFAULT 0,
        visitors INT NOT NULL DEFAULT 0,
        bounces INT NOT NULL DEFAULT 0,
        errors INT NOT NULL DEFAULT 0,
        bytes BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (app, site, day, dim, k, bot),
        KEY idx_dim (app, site, dim, day)
      ) ENGINE=InnoDB
    `);
    await c.query(`
      CREATE TABLE IF NOT EXISTS analytics_spool (
        app VARCHAR(64) NOT NULL,
        site VARCHAR(32) NOT NULL,
        src VARCHAR(40) NOT NULL,
        off_bytes BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (app, site, src)
      ) ENGINE=InnoDB
    `);
    ready = true;
    return true;
  } finally { c.release(); }
}
// idempotent and shared: concurrent callers wait on one attempt
function ensure() {
  if (ready && hasDb()) return Promise.resolve(true);
  if (!hasDb()) { ready = false; return Promise.resolve(false); }
  if (!initPromise) initPromise = initSchema().catch((e) => { console.warn('  Analytics: schema init failed:', e.message); return false; }).finally(() => { initPromise = null; });
  return initPromise;
}
function reset() { ready = false; }

// ── rows ──────────────────────────────────────────────────────────────────
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const str = (v, re, max) => (typeof v === 'string' && v.length <= max && re.test(v) ? v : null);
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

// A spool / import record → the row's values (allowlisted and clamped: the
// spool is written by the site's own process, so it is untrusted input, and no
// column can take an IP or a raw UA). null = unusable.
function rowOf(app, site, src, off, r, nowMs = Date.now()) {
  if (!r || typeof r !== 'object') return null;
  const ts = Number.isFinite(r.t) ? Math.floor(r.t) : null;
  if (ts === null || ts < Date.UTC(2020, 0, 1) || ts > nowMs + 86400000) return null;
  const kind = KINDS.includes(r.k) ? r.k : null;
  if (!kind) return null;
  const clean = /^[\x20-\x7e -￿]*$/;
  const text = (v, max) => (typeof v === 'string' && v.length <= max && clean.test(v) ? v : (typeof v === 'string' && clean.test(v) ? v.slice(0, max) : null));
  let props = null;
  if (typeof r.pr === 'string' && r.pr.length <= 700) { try { const o = JSON.parse(r.pr); if (o && typeof o === 'object' && !Array.isArray(o)) props = JSON.stringify(o); } catch { /* none */ } }
  return [
    app, site, src, off, ts, dayOf(ts), kind,
    str(r.m, /^[A-Z]{1,8}$/, 8), text(r.p, 255), text(r.q, 200), int(r.s, 0, 999), int(r.b, 0, 2 ** 53 - 1) ?? 0, int(r.d, 0, 2147483647) ?? 0,
    str(typeof r.r === 'string' && !/^[0-9.]+$/.test(r.r) ? r.r : null, /^[a-z0-9.-]{1,128}$/, 128), text(r.us, 64), text(r.um, 64), text(r.uc, 64),
    str(r.br, /^[A-Za-z][A-Za-z ]{0,23}$/, 24), int(r.bv, 0, 999), str(r.os, /^[A-Za-z][A-Za-z ]{0,15}$/, 16), str(r.dv, /^[a-z-]{1,16}$/, 16),
    str(r.l, /^[a-z]{2,3}$/, 3), str(r.c, /^[A-Z]{2}$/, 2), int(r.bot, 0, 2) ?? 0, str(r.v, /^[0-9a-f]{16}$/, 16),
    kind === 'event' ? str(r.n, /^[A-Za-z0-9_.:-]{1,64}$/, 64) : null, kind === 'event' ? props : null,
  ];
}

async function insertRows(c, rows) {
  if (!rows.length) return 0;
  const sql = `INSERT IGNORE INTO analytics_hits (${INSERT_COLS.join(',')}) VALUES (${INSERT_COLS.map(() => '?').join(',')})`;
  const res = await c.batch(sql, rows);
  return Number(res && res.affectedRows !== undefined ? res.affectedRows : rows.length);
}

// One ingest step, atomic: the rows and the new offset commit together, so a
// crash leaves either both or neither (and INSERT IGNORE on the (src, offset)
// key makes a repeat harmless even if the offset row was lost).
async function ingest(app, site, src, rows, offset) {
  return withConn(async (c) => {
    await c.beginTransaction();
    try {
      const added = await insertRows(c, rows);
      await c.query('INSERT INTO analytics_spool (app, site, src, off_bytes) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE off_bytes = GREATEST(off_bytes, VALUES(off_bytes))', [app, site, src, offset]);
      await c.commit();
      return added;
    } catch (e) { try { await c.rollback(); } catch { /* gone */ } throw e; }
  });
}
async function offsets(app, site) {
  const rows = await q('SELECT src, off_bytes FROM analytics_spool WHERE app = ? AND site = ?', [app, site]);
  return new Map(rows.map((r) => [r.src, Number(r.off_bytes)]));
}
async function forgetSpool(app, site, src) { await q('DELETE FROM analytics_spool WHERE app = ? AND site = ? AND src = ?', [app, site, src]); }

// ── dimensions: the ONE list (rollup, raw query and CSV all read it) ───────
// scope: pages (page loads) | requests (every non-event request) | events
const DIMS = {
  path: { expr: 'path', scope: 'pages' },
  referrer: { expr: 'ref', scope: 'pages' },
  utm_source: { expr: 'utm_source', scope: 'pages' },
  utm_medium: { expr: 'utm_medium', scope: 'pages' },
  utm_campaign: { expr: 'utm_campaign', scope: 'pages' },
  country: { expr: 'country', scope: 'pages' },
  browser: { expr: 'browser', scope: 'pages' },
  os: { expr: 'os', scope: 'pages' },
  device: { expr: 'device', scope: 'pages' },
  lang: { expr: 'lang', scope: 'pages' },
  status: { expr: 'CAST(status AS CHAR)', scope: 'requests' },
  event: { expr: 'name', scope: 'events' },
};
const SCOPE_SQL = { pages: "kind = 'page'", requests: "kind <> 'event'", events: "kind = 'event'" };

// ── rollup ────────────────────────────────────────────────────────────────
const HEUR_PAGES = 4;
// Rebuild one day's daily rows from the raw hits. Also retro-flags visitors who
// loaded pages and never an asset (is_bot 2), when the site served assets to
// anyone else that day, so a complete day is classified better than the live pass.
async function rollupDay(app, site, day) {
  return withConn(async (c) => {
    await c.beginTransaction();
    try {
      const a = [app, site, day];
      const [assets] = await c.query("SELECT COUNT(*) n FROM analytics_hits WHERE app=? AND site=? AND day=? AND kind='asset' AND is_bot=0", a);
      if (Number(assets.n) > 0) {
        await c.query(`UPDATE analytics_hits h JOIN (
            SELECT visitor FROM analytics_hits WHERE app=? AND site=? AND day=? AND is_bot IN (0,2) AND visitor IS NOT NULL
            GROUP BY visitor HAVING SUM(kind='page') >= ${HEUR_PAGES} AND SUM(kind='asset') = 0) x ON x.visitor = h.visitor
          SET h.is_bot = 2 WHERE h.app=? AND h.site=? AND h.day=? AND h.is_bot = 0`, [...a, ...a]);
      }
      await c.query('DELETE FROM analytics_daily WHERE app=? AND site=? AND day=?', a);
      const sel = (dim, kExpr, where) => c.query(
        `INSERT INTO analytics_daily (app, site, day, dim, k, bot, views, hits, visitors, bounces, errors, bytes)
         SELECT ?, ?, ?, ?, LEFT(COALESCE(${kExpr}, ''), 255), is_bot, SUM(kind='page'), COUNT(*), COUNT(DISTINCT visitor), 0, SUM(status >= 400), COALESCE(SUM(bytes), 0)
         FROM analytics_hits WHERE app=? AND site=? AND day=? AND ${where} GROUP BY 5, is_bot`, [...a.slice(0, 3), dim, ...a]);
      await sel('total', "'all'", SCOPE_SQL.pages);
      await sel('requests', "'all'", SCOPE_SQL.requests);
      for (const [dim, d] of Object.entries(DIMS)) await sel(dim, d.expr, SCOPE_SQL[d.scope]);
      await sel('notfound', 'path', "kind <> 'event' AND status = 404");
      // bounces: a visitor-day with exactly one page load, on the 'total' rows
      await c.query(`UPDATE analytics_daily d JOIN (
          SELECT is_bot, COUNT(*) n FROM (SELECT visitor, is_bot, COUNT(*) p FROM analytics_hits WHERE app=? AND site=? AND day=? AND kind='page' AND visitor IS NOT NULL GROUP BY visitor, is_bot HAVING p = 1) t GROUP BY is_bot) b
        ON b.is_bot = d.bot SET d.bounces = b.n WHERE d.app=? AND d.site=? AND d.day=? AND d.dim='total'`, [...a, ...a]);
      await c.commit();
    } catch (e) { try { await c.rollback(); } catch { /* gone */ } throw e; }
  });
}
// DATE columns are read through DATE_FORMAT everywhere: the driver turns a plain DATE into a local-midnight JS Date,
// which is the previous UTC day on a host east of Greenwich.
// finished days (before `today`) that have raw rows but no 'total' rollup yet
async function daysToRollup(app, site, today) {
  const rows = await q(`SELECT DISTINCT DATE_FORMAT(h.day, '%Y-%m-%d') AS day FROM analytics_hits h
    WHERE h.app=? AND h.site=? AND h.day < ? AND NOT EXISTS (SELECT 1 FROM analytics_daily d WHERE d.app=h.app AND d.site=h.site AND d.day=h.day AND d.dim='total')
    ORDER BY h.day`, [app, site, today]);
  return rows.map((r) => String(r.day));
}
// Drop raw rows older than `rawDays` (only days already rolled up) and daily rows older than `months`.
async function prune(app, site, todayMs, rawDays, months) {
  const rawCut = dayOf(todayMs - rawDays * 86400000);
  const d = new Date(todayMs);
  d.setUTCMonth(d.getUTCMonth() - months);
  const dailyCut = d.toISOString().slice(0, 10);
  const raw = await q(`DELETE h FROM analytics_hits h WHERE h.app=? AND h.site=? AND h.day < ?
    AND EXISTS (SELECT 1 FROM analytics_daily x WHERE x.app=h.app AND x.site=h.site AND x.day=h.day AND x.dim='total')`, [app, site, rawCut]);
  const daily = await q('DELETE FROM analytics_daily WHERE app=? AND site=? AND day < ?', [app, site, dailyCut]);
  return { raw: Number(raw.affectedRows || 0), daily: Number(daily.affectedRows || 0), rawCut, dailyCut };
}
async function sites() {
  const rows = await q('SELECT DISTINCT app, site FROM analytics_hits UNION SELECT DISTINCT app, site FROM analytics_daily');
  return rows.map((r) => ({ app: r.app, site: r.site }));
}
async function removeSite(app, site) {
  for (const t of ['analytics_hits', 'analytics_daily', 'analytics_spool']) await q(`DELETE FROM ${t} WHERE app=? AND site=?`, [app, site]);
}
async function renameApp(from, to) {
  for (const t of ['analytics_hits', 'analytics_daily', 'analytics_spool']) await q(`UPDATE ${t} SET app=? WHERE app=?`, [to, from]);
}

module.exports = {
  DB, DIMS, SCOPE_SQL, KINDS, HIT_COLS, INSERT_COLS, HEUR_PAGES,
  hasDb, ensure, initSchema, reset, withConn, q, rowOf, insertRows, ingest, offsets, forgetSpool,
  rollupDay, daysToRollup, prune, sites, removeSite, renameApp, dayOf,
};
