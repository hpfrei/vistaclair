'use strict';
// Site analytics reads (docs/analytics.md): query / live / csv over the raw hits
// and the daily rollups. Dimensions, metrics and filters are ALLOWLISTS; nothing
// from the caller reaches the SQL text, only bound values.
//
// A day is read from the raw hits when raw rows still exist for it (they are a
// contiguous recent suffix; pruning removes the oldest first) and from the daily
// rollup before that. Raw answers everything; the rollup answers a total, one
// dimension, or one equality filter, per day. Visitors over a range are the sum
// of per-day distinct visitors (the hash changes daily), so the same person on
// two days counts twice.

const store = require('./analytics-store');

const METRICS = ['visitors', 'pageviews', 'hits', 'events', 'bytes', 'errors', 'avgMs', 'bounces', 'bounceRate'];
const EXTRA_GROUPS = ['day', 'hour', 'bot'];
const GROUPS = [...EXTRA_GROUPS, ...Object.keys(store.DIMS)];
const FILTERS = Object.keys(store.DIMS);
const BOTS = ['exclude', 'only', 'include'];
const SCOPES = ['pages', 'requests', 'events'];
const LIMIT_MAX = 50000;
const SPAN_MAX = 1100;
const ADDITIVE = ['visitors', 'pageviews', 'hits', 'events', 'bytes', 'errors', 'bounces'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const bad = (msg, code = 'bad_query') => Object.assign(new Error(msg), { code });
const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const ymd = (v) => String(v).slice(0, 10);

// → the validated, normalised query
function normalize(p, today) {
  p = p || {};
  const to = p.to === undefined ? today : p.to;
  const from = p.from === undefined ? addDays(to, -6) : p.from;
  if (!DAY_RE.test(String(from)) || !DAY_RE.test(String(to))) throw bad('from and to are YYYY-MM-DD days (UTC)');
  let [a, b] = from <= to ? [from, to] : [to, from];
  if ((Date.parse(b) - Date.parse(a)) / 86400000 > SPAN_MAX) throw bad(`a range is at most ${SPAN_MAX} days`);
  const metrics = p.metrics === undefined ? ['visitors', 'pageviews'] : [].concat(p.metrics);
  for (const m of metrics) if (!METRICS.includes(m)) throw bad(`unknown metric "${m}" (${METRICS.join(', ')})`);
  const groupBy = p.groupBy === undefined || p.groupBy === null ? [] : [].concat(p.groupBy);
  for (const g of groupBy) if (!GROUPS.includes(g)) throw bad(`unknown dimension "${g}" (${GROUPS.join(', ')})`);
  if (groupBy.length > 2 || new Set(groupBy).size !== groupBy.length) throw bad('groupBy: at most two different dimensions');
  const filters = {};
  for (const [k, v] of Object.entries(p.filters || {})) {
    if (!FILTERS.includes(k)) throw bad(`cannot filter by "${k}" (${FILTERS.join(', ')})`);
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string' && typeof v !== 'number') throw bad(`filter ${k}: a string or number`);
    filters[k] = String(v).slice(0, 255);
  }
  const bots = p.bots === undefined ? 'exclude' : p.bots;
  if (!BOTS.includes(bots)) throw bad(`bots: ${BOTS.join(' | ')}`);
  const limit = Math.max(1, Math.min(LIMIT_MAX, Math.floor(Number(p.limit) || 100)));
  // the base set: page loads, every request, or custom events
  const dims = [...groupBy, ...Object.keys(filters)].filter((d) => store.DIMS[d]);
  let scope = p.scope;
  if (scope !== undefined && !SCOPES.includes(scope)) throw bad(`scope: ${SCOPES.join(' | ')}`);
  if (!scope) scope = dims.some((d) => store.DIMS[d].scope === 'events') ? 'events' : dims.some((d) => store.DIMS[d].scope === 'requests') ? 'requests' : 'pages';
  return { from: a, to: b, metrics, groupBy, filters, bots, limit, scope };
}

// ── raw ───────────────────────────────────────────────────────────────────
const groupExpr = (g) => {
  if (g === 'day') return "DATE_FORMAT(day, '%Y-%m-%d')";
  if (g === 'hour') return 'FLOOR(ts / 3600000) MOD 24';
  if (g === 'bot') return "IF(is_bot = 0, 'human', 'bot')";
  return `COALESCE(${store.DIMS[g].expr}, '')`;
};
const METRIC_SQL = {
  hits: 'COUNT(*)',
  pageviews: "SUM(kind = 'page')",
  visitors: "COUNT(DISTINCT CONCAT(day, '|', visitor))",
  events: "SUM(kind = 'event')",
  bytes: 'COALESCE(SUM(bytes), 0)',
  errors: 'SUM(status >= 400)',
  avgMs: 'ROUND(AVG(ms))',
};
const botSql = (b) => (b === 'only' ? ' AND is_bot > 0' : b === 'exclude' ? ' AND is_bot = 0' : '');

function rawWhere(app, site, from, to, qn) {
  const w = [`app = ? AND site = ? AND day BETWEEN ? AND ? AND ${store.SCOPE_SQL[qn.scope]}${botSql(qn.bots)}`];
  const a = [app, site, from, to];
  for (const [k, v] of Object.entries(qn.filters)) {
    const e = store.DIMS[k].expr;
    if (v === '') w.push(`(${e} IS NULL OR ${e} = '')`);
    else { w.push(`${e} = ?`); a.push(v); }
  }
  return { where: w.join(' AND '), args: a };
}

async function rawQuery(app, site, from, to, qn) {
  const { where, args } = rawWhere(app, site, from, to, qn);
  const want = qn.metrics.filter((m) => METRIC_SQL[m]);
  const sel = (want.length ? want : ['hits']).map((m) => `${METRIC_SQL[m]} AS m_${m}`);
  const g = qn.groupBy.map(groupExpr);
  const cols = g.map((e, i) => `${e} AS g${i}`);
  const sql = `SELECT ${[...cols, ...sel].join(', ')} FROM analytics_hits WHERE ${where}${g.length ? ` GROUP BY ${g.map((_, i) => `g${i}`).join(', ')}` : ''}`;
  const rows = (await store.q(sql, args)).map((r) => {
    const o = { _g: qn.groupBy.map((_, i) => String(r[`g${i}`])) };
    for (const m of want) o[m] = num(r[`m_${m}`]);
    return o;
  });
  if (!g.length && !rows.length) rows.push({ _g: [], ...Object.fromEntries(want.map((m) => [m, 0])) });
  // bounces: visitor-days with exactly one page load (page scope only)
  if ((qn.metrics.includes('bounces') || qn.metrics.includes('bounceRate')) && qn.scope === 'pages') {
    const gm = qn.groupBy.map((x, i) => `MIN(${groupExpr(x)}) AS g${i}`);
    const sub = `SELECT day, visitor, COUNT(*) p${gm.length ? ', ' + gm.join(', ') : ''} FROM analytics_hits WHERE ${where} AND visitor IS NOT NULL GROUP BY day, visitor HAVING p = 1`;
    const br = await store.q(`SELECT ${[...qn.groupBy.map((_, i) => `g${i}`), 'COUNT(*) AS n'].join(', ')} FROM (${sub}) t${g.length ? ` GROUP BY ${g.map((_, i) => `g${i}`).join(', ')}` : ''}`, args);
    const by = new Map(br.map((r) => [qn.groupBy.map((_, i) => String(r[`g${i}`])).join('\u0001'), num(r.n)]));
    for (const r of rows) r.bounces = by.get(r._g.join('\u0001')) || 0;
  }
  return rows;
}

// ── rollup ────────────────────────────────────────────────────────────────
// → { dim, group: [col exprs] } or null when the rollup cannot answer this query
function rollupPlan(qn) {
  const dimsG = qn.groupBy.filter((g) => store.DIMS[g]);
  const dimsF = Object.keys(qn.filters);
  if (qn.groupBy.includes('hour')) return null;
  if (dimsG.length + dimsF.length > 1) {
    // path grouped by the 404 filter is the one stored pair
    if (dimsG.length === 1 && dimsG[0] === 'path' && dimsF.length === 1 && dimsF[0] === 'status' && qn.filters.status === '404') return { dim: 'notfound', kFilter: null, byK: true };
    return null;
  }
  const one = dimsG[0] || dimsF[0];
  if (one && store.DIMS[one].scope !== qn.scope) return null;
  if (dimsG.length === 1) return { dim: dimsG[0], kFilter: null, byK: true };
  if (dimsF.length === 1) return { dim: dimsF[0], kFilter: qn.filters[dimsF[0]], byK: false };
  return { dim: qn.scope === 'pages' ? 'total' : qn.scope === 'requests' ? 'requests' : 'event', kFilter: null, byK: false };
}
async function rollupQuery(app, site, from, to, qn, plan) {
  const g = qn.groupBy.map((x) => (x === 'day' ? "DATE_FORMAT(day, '%Y-%m-%d')" : x === 'bot' ? "IF(bot = 0, 'human', 'bot')" : 'k'));
  const w = ['app = ? AND site = ? AND day BETWEEN ? AND ? AND dim = ?'];
  const a = [app, site, from, to, plan.dim];
  if (plan.kFilter !== null) { w.push('k = ?'); a.push(plan.kFilter); }
  w.push(botSql(qn.bots).replace(/^ AND /, '').replace(/is_bot/g, 'bot') || '1=1');
  const cols = g.map((e, i) => `${e} AS g${i}`);
  const sql = `SELECT ${[...cols, 'SUM(views) AS pageviews', 'SUM(hits) AS hits', 'SUM(visitors) AS visitors', 'SUM(bounces) AS bounces', 'SUM(errors) AS errors', 'SUM(bytes) AS bytes'].join(', ')}
    FROM analytics_daily WHERE ${w.join(' AND ')}${g.length ? ` GROUP BY ${g.map((_, i) => `g${i}`).join(', ')}` : ''}`;
  return (await store.q(sql, a)).map((r) => ({
    _g: qn.groupBy.map((_, i) => String(r[`g${i}`])),
    pageviews: num(r.pageviews), hits: num(r.hits), visitors: num(r.visitors), bounces: plan.dim === 'total' ? num(r.bounces) : undefined,
    errors: num(r.errors), bytes: num(r.bytes), events: plan.dim === 'event' ? num(r.hits) : 0,
  }));
}

function merge(groups, parts) {
  const by = new Map();
  for (const rows of parts) {
    for (const r of rows) {
      const key = r._g.join('\u0001');
      const cur = by.get(key);
      if (!cur) { by.set(key, { ...r }); continue; }
      for (const m of ADDITIVE) if (r[m] !== undefined) cur[m] = (cur[m] || 0) + r[m];
      if (r.avgMs !== undefined && cur.avgMs === undefined) cur.avgMs = r.avgMs;
    }
  }
  return [...by.values()];
}

// the first raw day for the site (raw rows are a contiguous recent suffix); null = none
async function minRawDay(app, site) {
  const r = (await store.q("SELECT DATE_FORMAT(MIN(day), '%Y-%m-%d') AS d FROM analytics_hits WHERE app = ? AND site = ?", [app, site]))[0];
  return r && r.d ? ymd(r.d) : null;
}

async function run(app, site, qn) {
  const minRaw = await minRawDay(app, site);
  const parts = [], totals = [];
  const source = { raw: null, rollup: null, skipped: null };
  const rawFrom = minRaw && minRaw > qn.from ? minRaw : qn.from;
  if (minRaw && rawFrom <= qn.to) {
    source.raw = [rawFrom, qn.to];
    parts.push(await rawQuery(app, site, rawFrom, qn.to, qn));
    if (qn.groupBy.length) totals.push(await rawQuery(app, site, rawFrom, qn.to, { ...qn, groupBy: [] }));
  }
  const rollTo = !minRaw ? qn.to : addDays(minRaw, -1) < qn.to ? addDays(minRaw, -1) : qn.to;
  if (qn.from <= rollTo) {
    const plan = rollupPlan(qn);
    if (plan) {
      source.rollup = [qn.from, rollTo];
      parts.push(await rollupQuery(app, site, qn.from, rollTo, qn, plan));
      if (qn.groupBy.length) totals.push(await rollupQuery(app, site, qn.from, rollTo, { ...qn, groupBy: [] }, rollupPlan({ ...qn, groupBy: [] })));
    } else source.skipped = [qn.from, rollTo];
  }
  const rows = merge(qn.groupBy, parts);
  const tot = qn.groupBy.length ? merge([], totals)[0] : rows[0];
  const shape = (r) => {
    const o = {};
    qn.groupBy.forEach((g, i) => { o[g] = g === 'hour' ? Number(r._g[i]) : r._g[i]; });
    for (const m of qn.metrics) {
      if (m === 'bounceRate') o.bounceRate = r.bounces !== undefined && r.visitors ? Math.round((r.bounces / r.visitors) * 1000) / 1000 : null;
      else o[m] = r[m] === undefined ? null : r[m];
    }
    return o;
  };
  const first = qn.metrics.find((m) => ADDITIVE.includes(m)) || qn.metrics[0];
  const dayLike = qn.groupBy.find((g) => g === 'day' || g === 'hour');
  const sorted = rows.slice().sort((x, y) => (dayLike ? (x._g[qn.groupBy.indexOf(dayLike)] < y._g[qn.groupBy.indexOf(dayLike)] ? -1 : 1) : num(y[first]) - num(x[first])));
  return {
    site, from: qn.from, to: qn.to, scope: qn.scope, groupBy: qn.groupBy, metrics: qn.metrics, bots: qn.bots,
    rows: sorted.slice(0, qn.limit).map(shape),
    totals: tot ? shape({ ...tot, _g: qn.groupBy.map(() => '') }) : shape({ _g: qn.groupBy.map(() => '') }),
    truncated: sorted.length > qn.limit,
    source,
  };
}

const CREDIT = require('./analytics-geo').CREDIT;

async function query(app, site, params, today) {
  const qn = normalize(params, today);
  await ensureReady();
  const out = await run(app, site, qn);
  if (qn.groupBy.includes('country') || 'country' in qn.filters) out.credit = CREDIT;
  return out;
}
async function ensureReady() {
  if (!(await store.ensure())) throw Object.assign(new Error('no database configured: analytics hits are kept in the spool and appear once a database is connected'), { code: 'no_database' });
}

// distinct human visitors with a page load in the last 5 minutes
async function live(app, site, nowMs) {
  await ensureReady();
  const r = (await store.q("SELECT COUNT(DISTINCT visitor) AS n FROM analytics_hits WHERE app = ? AND site = ? AND ts >= ? AND kind = 'page' AND is_bot = 0", [app, site, nowMs - 300000]))[0];
  return num(r && r.n);
}

const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // a spreadsheet must not run a path or referrer as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
async function csv(app, site, params, today) {
  const r = await query(app, site, { limit: 50000, ...(params || {}) }, today);
  const cols = [...r.groupBy, ...r.metrics];
  const lines = [cols.join(',')];
  for (const row of r.rows) lines.push(cols.map((c) => csvCell(row[c])).join(','));
  return lines.join('\n') + '\n';
}

module.exports = { query, live, csv, normalize, METRICS, GROUPS, FILTERS, minRawDay, csvCell };
