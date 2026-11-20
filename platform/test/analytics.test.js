// Site analytics (docs/analytics.md): capture, anonymisation, spool ingest, rollup,
// retention, import, query, the component's data. Offline: a temp apps dir, real
// runner children on free ports, and a REAL throwaway MariaDB (mariadb-scratch.js)
// for everything that touches the database. If no MariaDB binaries exist the DB
// tests are reported as skipped with that reason (never silently dropped).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');

const { makeAppsDir, call } = require('./helpers');
const scratchDb = require('./mariadb-scratch');
const appManager = require('../src/apps/app-manager');
const appDb = require('../src/apps/app-db');
const sites = require('../src/apps/sites');
const analytics = require('../src/apps/analytics');
const store = require('../src/apps/analytics-store');
const geo = require('../src/apps/analytics-geo');
const lib = require('../site-analytics');
const appBridge = require('../src/apps/app-bridge');
const { validateSites } = require('../src/apps/sites-manifest');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400000;
const NOW = Date.now();
const D0 = Math.floor(NOW / DAY) * DAY;                 // today 00:00 UTC
const dayStr = (n) => new Date(D0 + n * DAY).toISOString().slice(0, 10);
const at = (n, hh = 10, mm = 0, ss = 0) => D0 + n * DAY + ((hh * 60 + mm) * 60 + ss) * 1000;
const TODAY = dayStr(0);

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const HANDLER = `
module.exports = function createSite(site) {
  return async (req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/' || p === '/about' || p.startsWith('/r/')) { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end('<html>' + p + '</html>'); }
    if (p === '/app.css') { res.setHeader('content-type', 'text/css'); return res.end('a{}'); }
    if (p === '/logo.png') { res.setHeader('content-type', 'image/png'); return res.end(Buffer.alloc(100)); }
    if (p === '/robots.txt') { res.setHeader('content-type', 'text/plain'); return res.end('x'); }
    if (p === '/goal') { site.track('signup', { plan: 'pro', note: 'x'.repeat(200) }); res.setHeader('content-type', 'text/plain'); return res.end('ok'); }
    res.statusCode = 404; res.setHeader('content-type', 'text/html'); res.end('nf');
  };
};
`;
const SITES = ['main', 'ing', 'clock', 'torn', 'imp', 'old', 'noan'];

let scratch = null, appsDir, P = {};
const sitesRoot = (s) => path.join(appsDir, 'shop', '.data', 'sites', s);
const spoolDirOf = (s) => path.join(sitesRoot(s), 'data', '.analytics');
const dbTest = (name, fn) => test(name, async (t) => { if (!scratch) return t.skip('MariaDB binaries not available here — NOT RUN'); return fn(t); });

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function req(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    r.on('error', reject);
    r.setTimeout(4000, () => r.destroy(new Error('timeout')));
    r.end();
  });
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}
function spoolLines(s) {
  const dir = spoolDirOf(s);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => lib.SPOOL_RE.test(f)).sort(); } catch { return []; }
  return files.flatMap((f) => {
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    const cut = txt.lastIndexOf('\n');
    return cut < 0 ? [] : txt.slice(0, cut).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  });
}
const rows = (sql, a) => store.q(sql, a);
const n = (v) => Number(v);

test.before(async () => {
  scratch = await scratchDb.start();
  if (!scratch) console.warn('\n!! analytics.test: no MariaDB server binaries — the database tests are SKIPPED (see reasons below)\n');
  for (const s of SITES) P[s] = await freePort();
  appsDir = makeAppsDir({ shop: {} });
  appManager.setAppsDir(appsDir);
  const d = path.join(appsDir, 'shop');
  fs.mkdirSync(path.join(d, 'site'), { recursive: true });
  fs.writeFileSync(path.join(d, 'site', 'index.js'), HANDLER);
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'shop', private: true }));
  const defs = {};
  for (const s of SITES) defs[s] = { handler: 'site/index.js', defaultPort: P[s], access: 'public', autostart: false, analytics: s !== 'noan' };
  fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ name: 'shop', sites: defs }, null, 2));
  // the platform's country table (what the monthly job builds): two test ranges
  const csv = '66.249.64.0,66.249.95.255,US\n198.51.100.0,198.51.100.255,FR\n203.0.113.0,203.0.113.255,DE\n';
  geo.install(geo.buildTable(csv).gz);
  sites.init({ broadcast() {}, dashboardPort: 3457, proxyPort: 3456 });
  analytics.init({ broadcast: (m) => { events.push(m); } });
  if (scratch) { appDb.getPool = () => scratch.pool; store.reset(); }
});
const events = [];

test.after(async () => {
  analytics.shutdown();
  await sites.stopAll();
  if (scratch) await scratch.stop();
  fs.rmSync(appsDir, { recursive: true, force: true });
});

// ── pure: anonymisation and parsing ───────────────────────────────────────
test('the client address: a proxy header only counts from a loopback peer', () => {
  assert.equal(lib.clientIp('203.0.113.7', { 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '8.8.8.8' }), '203.0.113.7');
  assert.equal(lib.clientIp('::ffff:127.0.0.1', { 'x-real-ip': '198.51.100.4' }), '198.51.100.4');
  assert.equal(lib.clientIp('127.0.0.1', { 'x-forwarded-for': '1.1.1.1, 198.51.100.9' }), '198.51.100.9', 'the LAST entry: the left ones are the client\'s to forge');
  assert.equal(lib.clientIp('127.0.0.1', { 'x-forwarded-for': 'not-an-ip' }), '127.0.0.1');
  assert.equal(lib.prefixOf('203.0.113.77'), '203.0.113.0/24');
  assert.equal(lib.prefixOf('2001:db8:abcd:12::1'), '2001:db8:abcd::/48');
});

test('a request is reduced: path without query (except utm_*/ref), referrer host, UA classes, language', () => {
  const env = { siteKey: 'shop/main', salt: 'salt', geo: null, internalHosts: ['shop.example'] };
  const f = lib.describe({
    ip: '203.0.113.77', ua: CHROME, lang: 'de-CH,de;q=0.9,en;q=0.8', referer: 'https://www.news.example/story?id=5#x', host: 'shop.example:8080',
    url: '/blog//post-1/?utm_source=nl&utm_medium=mail&utm_campaign=Spring&token=SECRET&ref=twitter&a=1',
  }, env);
  assert.equal(f.p, '/blog/post-1');
  assert.equal(f.q, 'ref=twitter&utm_campaign=Spring&utm_medium=mail&utm_source=nl');
  assert.deepEqual([f.us, f.um, f.uc], ['nl', 'mail', 'Spring']);
  assert.equal(f.r, 'news.example');
  assert.deepEqual([f.br, f.bv, f.os, f.dv, f.l, f.bot], ['Chrome', 120, 'Windows', 'desktop', 'de', 0]);
  assert.ok(!JSON.stringify(f).includes('SECRET') && !JSON.stringify(f).includes('203.0.113') && !JSON.stringify(f).includes('Mozilla'));
  // internal referrers (the site's own host, any case, www.) are dropped
  assert.equal(lib.describe({ ip: '1.2.3.4', ua: CHROME, referer: 'https://WWW.Shop.example/x', host: 'shop.example', url: '/' }, env).r, '');
  assert.equal(lib.describe({ ip: '1.2.3.4', ua: CHROME, referer: 'https://shop.example/x', host: 'other.test', url: '/' }, env).r, '', 'the configured domain counts as internal too');
  // an id-like segment is not a page
  assert.equal(lib.normalizeUrl('/reset/aB3dE5gH7jK9mN1pQ3sT5vX7zA9/confirm').path, '/reset/:id/confirm');
  assert.equal(lib.normalizeUrl('/u/12345678901').path, '/u/:id');
  assert.equal(lib.normalizeUrl('/v2/about').path, '/v2/about');
});

test('bots: a UA list, an empty UA, and the classes of a browser', () => {
  for (const ua of [GOOGLEBOT, 'curl/8.4.0', 'python-requests/2.31', '', 'Mozilla/5.0 (compatible; bingbot/2.0)', 'facebookexternalhit/1.1', 'Go-http-client/1.1']) assert.equal(lib.isBotUA(ua), true, ua || '(empty)');
  for (const ua of [CHROME, FIREFOX, IPHONE]) assert.equal(lib.isBotUA(ua), false);
  assert.deepEqual(lib.parseUA(IPHONE), { browser: 'Safari', browser_v: 17, os: 'iOS', device: 'phone' });
  assert.equal(lib.langOf('fr-CA,fr;q=0.9'), 'fr');
  assert.equal(lib.langOf('*'), null);
});

test('manifest: analytics is a boolean per site and defaults to off', () => {
  const ok = validateSites({ a: { handler: 'site/index.js', defaultPort: 8080, access: 'public', analytics: true }, b: { handler: 'site/index.js', defaultPort: 8081, access: 'public' } });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.sites.a.analytics, true);
  assert.equal(ok.sites.b.analytics, false);
  assert.match(validateSites({ a: { handler: 'site/index.js', defaultPort: 8080, access: 'public', analytics: 'yes' } }).errors.join(), /analytics: true or false/);
});

// ── the shared country table ───────────────────────────────────────────────
test('geo: GEO1 table build + offline lookup; no table = unknown; the monthly refresh installs a new one', async () => {
  const handle = lib.geoHandle(geo.tableFile());
  const t = handle.get();
  assert.equal(lib.countryOf('203.0.113.77', t), 'DE');
  assert.equal(lib.countryOf('198.51.100.1', t), 'FR');
  assert.equal(lib.countryOf('8.8.8.8', t), null, 'a gap is unknown');
  assert.equal(lib.countryOf('10.1.2.3', t), null, 'private space is unknown');
  assert.equal(lib.countryOf('203.0.113.77', lib.loadGeo(path.join(appsDir, 'nope.bin.gz'))), null, 'no table: unknown, nothing throws');
  // the refresh: an injected download (>= 1000 ranges, like the real file), gzipped CSV
  const zlib = require('zlib');
  let csv = '';
  for (let i = 0; i < 1200; i++) csv += `${11 + (i >> 8)}.${i & 255}.0.0,${11 + (i >> 8)}.${i & 255}.255.255,${i % 2 ? 'NL' : 'SE'}\n`;
  const urls = [];
  const r = await geo.refresh({ fetchFn: async (u) => { urls.push(u); return zlib.gzipSync(csv); }, now: new Date(Date.UTC(2026, 10, 3)) });
  assert.equal(r.ok, true);
  assert.match(urls[0], /dbip-country-lite-2026-11\.csv\.gz$/);
  assert.equal(lib.countryOf('11.1.5.5', lib.loadGeo(geo.tableFile())), 'NL');
  assert.equal(geo.status().available, true);
  assert.equal(geo.status().credit.text, 'IP geolocation by DB-IP');
  // a failed refresh leaves the table alone and records why
  const bad = await geo.refresh({ fetchFn: async () => { throw new Error('offline'); }, now: new Date(Date.UTC(2026, 11, 3)) });
  assert.equal(bad.ok, false);
  assert.equal(lib.countryOf('11.1.5.5', lib.loadGeo(geo.tableFile())), 'NL');
  assert.equal(geo.status().lastRefresh.ok, false);
  // restore the small test table for the runner tests
  geo.install(geo.buildTable('66.249.64.0,66.249.95.255,US\n198.51.100.0,198.51.100.255,FR\n203.0.113.0,203.0.113.255,DE\n').gz);
});

// ── 1. 1,000 requests ────────────────────────────────────────────────────
dbTest('1. 1,000 requests to a fixture site appear in query() and in the component\'s data, bots split out', async () => {
  const st = await sites.start('shop', 'main');
  assert.equal(st.state, 'running');
  const reqs = [];
  for (let i = 0; i < 150; i++) {
    const ip = i < 75 ? `203.0.113.${i + 1}` : `198.51.100.${i - 74}`;
    const h = { 'x-forwarded-for': ip, 'user-agent': `${CHROME} X${i}`, 'accept-language': i % 3 ? 'en-US,en;q=0.9' : 'de-DE,de', cookie: 'sid=SECRETCOOKIE' };
    reqs.push({ p: '/', h: { ...h, referer: i % 5 === 0 ? 'https://news.example/story' : '' } }, { p: '/app.css', h }, { p: '/logo.png', h }, { p: '/about', h });
  }
  // a script that loads pages and never an asset (not a self-declared bot)
  for (let s = 0; s < 4; s++) for (let k = 0; k < 5; k++) reqs.push({ p: k % 2 ? '/about' : '/', h: { 'x-forwarded-for': `66.249.66.${200 + s}`, 'user-agent': `${FIREFOX} S${s}` } });
  for (let b = 0; b < 95; b++) for (const p of ['/', '/about', '/missing?token=QUERYSECRET', '/robots.txt']) reqs.push({ p, h: { 'x-forwarded-for': `66.249.66.${b + 1}`, 'user-agent': GOOGLEBOT } });
  assert.equal(reqs.length, 1000);
  // humans first (they load assets), then the scripts, then the crawlers: sequential per phase
  const phases = [reqs.slice(0, 600), reqs.slice(600, 620), reqs.slice(620)];
  for (const ph of phases) await pool(ph, ph === phases[1] ? 1 : 20, (r) => req(P.main, r.p, r.h));
  // every record is on the spool before its response's last byte: no waiting needed, but allow the fs
  for (let i = 0; i < 50 && spoolLines('main').length < 1000; i++) await sleep(100);
  assert.equal(spoolLines('main').length, 1000);
  await analytics.ingest('shop', 'main');

  const q = (p) => analytics.query('shop', 'main', { from: dayStr(-1), to: TODAY, ...p });
  // humans vs bots, every request
  const split = await q({ metrics: ['hits'], groupBy: ['bot'], bots: 'include', scope: 'requests' });
  const by = Object.fromEntries(split.rows.map((r) => [r.bot, r.hits]));
  assert.deepEqual(by, { human: 600 + 12, bot: 388 }, 'before the nightly pass: the first 3 pages of each script still look human');
  assert.equal(split.totals.hits, 1000);
  // the day's rollup retro-flags visitors that never loaded an asset
  await store.rollupDay('shop', 'main', TODAY);
  const split2 = await q({ metrics: ['hits'], groupBy: ['bot'], bots: 'include', scope: 'requests' });
  assert.deepEqual(Object.fromEntries(split2.rows.map((r) => [r.bot, r.hits])), { human: 600, bot: 400 });
  const humans = await q({ metrics: ['visitors', 'pageviews', 'hits'] });
  assert.equal(humans.totals.visitors, 150);
  assert.equal(humans.totals.pageviews, 300);
  assert.equal(humans.totals.hits, 300, 'page scope: the assets are not pages');
  const bots = await q({ metrics: ['visitors', 'pageviews'], bots: 'only' });
  assert.equal(bots.totals.pageviews, 95 * 2 + 20);
  const all = await q({ metrics: ['hits', 'errors'], scope: 'requests' });
  assert.equal(all.totals.hits, 600, 'requests of humans');
  // dimensions
  const country = await q({ metrics: ['pageviews', 'visitors'], groupBy: ['country'] });
  assert.deepEqual(country.rows.map((r) => [r.country, r.visitors]).sort(), [['DE', 75], ['FR', 75]]);
  assert.equal(country.credit.text, 'IP geolocation by DB-IP');
  const ref = await q({ metrics: ['pageviews'], groupBy: ['referrer'] });
  assert.equal(ref.rows.find((r) => r.referrer === 'news.example').pageviews, 30);
  const lang = await q({ metrics: ['visitors'], groupBy: ['lang'] });
  assert.deepEqual(lang.rows.map((r) => [r.lang, r.visitors]).sort(), [['de', 50], ['en', 100]]);
  assert.equal((await q({ metrics: ['visitors'], groupBy: ['browser'] })).rows[0].browser, 'Chrome');
  const nf = await q({ metrics: ['hits'], groupBy: ['path'], filters: { status: '404' }, bots: 'include' });
  assert.deepEqual(nf.rows.map((r) => [r.path, r.hits]), [['/missing', 95]], 'the 404 list, without the query string');
  // drill-down: a filter narrows every number
  const de = await q({ metrics: ['visitors', 'pageviews'], filters: { country: 'DE' } });
  assert.equal(de.totals.visitors, 75);
  assert.equal(de.totals.pageviews, 150);
  assert.equal((await q({ metrics: ['pageviews'], groupBy: ['day'] })).rows.reduce((a, r) => a + r.pageviews, 0), 300);
  // a site that did not opt in refuses, and so does an unknown one
  await assert.rejects(analytics.query('shop', 'noan', {}), /no analytics/);
  await assert.rejects(analytics.query('shop', 'nope', {}), /declares no site/);
  await assert.rejects(q({ groupBy: ['ip'] }), /unknown dimension/);
  await assert.rejects(q({ metrics: ['drop table'] }), /unknown metric/);
  await assert.rejects(q({ filters: { path: { $ne: 1 } } }), /string or number/);

  // a goal from the handler (site.track) lands in the same table, with clamped props
  await req(P.main, '/goal', { 'x-forwarded-for': '203.0.113.5', 'user-agent': `${CHROME} X5` });
  for (let i = 0; i < 30 && !n((await rows("SELECT COUNT(*) c FROM analytics_hits WHERE site='main' AND kind='event'"))[0].c); i++) { await analytics.ingest('shop', 'main'); await sleep(100); }
  const goals = await q({ metrics: ['events', 'visitors'], groupBy: ['event'] });
  assert.deepEqual(goals.rows.map((r) => [r.event, r.events, r.visitors]), [['signup', 1, 1]]);
  const ev = (await rows("SELECT props FROM analytics_hits WHERE kind='event'"))[0];
  assert.equal(JSON.parse(ev.props).plan, 'pro');
  assert.equal(JSON.parse(ev.props).note.length, 80);

  // bridge: the iframe's analytics.query (also scoped to the calling app)
  const br = await call(appBridge, 'shop', 'analytics.query', { site: 'main', metrics: ['visitors'], from: dayStr(-1), to: TODAY });
  assert.equal(br.result.totals.visitors, 150);
  assert.equal((await call(appBridge, 'shop', 'analytics.live', { site: 'main' })).result.live >= 150, true, 'live: the 5-minute window');
  const csv = (await call(appBridge, 'shop', 'analytics.csv', { site: 'main', groupBy: ['country'], metrics: ['visitors'], from: dayStr(-1), to: TODAY })).result.csv;
  assert.equal(csv.split('\n')[0], 'country,visitors');
  assert.match(csv, /\nDE,75\n/);

  // the component's data layer: what <vc-analytics> draws, from the same engine
  const sandbox = { window: {}, document: {} };
  sandbox.Vc = sandbox.window.Vc = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'vc-analytics.js'), 'utf8'), sandbox);
  const callFn = (m, payload) => analytics.ownerCall('shop', m, { site: payload.site, params: Object.fromEntries(Object.entries(payload).filter(([k]) => k !== 'site')) });
  const model = await sandbox.window.Vc.analyticsData.load(callFn, { site: 'main', range: 7, today: TODAY });
  assert.equal(model.tiles.today.visitors, 150);
  assert.equal(model.tiles.today.pageviews, 300);
  assert.equal(model.tiles.range.visitors, 150);
  assert.equal(model.tiles.bounceRate, 0, 'every human loaded two pages');
  assert.deepEqual(JSON.parse(JSON.stringify(model.bots)), { human: 601, bot: 400 }, '600 + the /goal request');
  assert.equal(model.days.length, 7);
  assert.equal(model.days[6].day, TODAY);
  assert.equal(model.days[6].visitors, 150);
  assert.ok(model.live >= 150);
  assert.deepEqual(model.panels.countries.map((r) => [r.key, r.visitors]).sort(), [['DE', 75], ['FR', 75]]);
  assert.equal(model.panels.pages[0].label === '/' || model.panels.pages[0].label === '/about', true);
  assert.equal(model.panels.referrers.find((r) => r.label === '(direct)').pageviews, 270);
  assert.equal(model.panels.notfound.length, 0, 'the 404s here are the crawlers\': humans have none');
  assert.deepEqual(model.panels.goals.map((r) => r.key), ['signup']);
  assert.equal(model.credit.text, 'IP geolocation by DB-IP');
  const drill = await sandbox.window.Vc.analyticsData.load(callFn, { site: 'main', range: 7, today: TODAY, filters: { country: 'FR' } });
  assert.equal(drill.tiles.range.visitors, 75);
  assert.deepEqual(drill.panels.countries.map((r) => r.key), ['FR']);

  // live updates are events: ingest announces the visitors of the last 5 minutes
  assert.ok(events.some((e) => e.type === 'app:bridge:event' && e.event === 'analytics:live' && e.data.site === 'main'));
  await sites.stop('shop', 'main');
});

// ── 2. the same visitor: 1 within a day, 2 across two days ────────────────
dbTest('2. a visitor is 1 within a day and 2 across two days (injected clock); the salt is destroyed at midnight', async () => {
  let clock = at(-2, 10);
  const dataDir = path.join(sitesRoot('clock'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const cap = lib.createCapture({ siteKey: 'shop/clock', dataDir, geoFile: geo.tableFile(), now: () => clock });
  const visit = (ip, ua, p, ref) => {
    const fake = { headers: { 'user-agent': ua, 'accept-language': 'de-DE,de;q=0.9', host: 'x.test', referer: ref || '' }, url: p, socket: { remoteAddress: '127.0.0.1' } };
    const f = cap.describe(fake, ip);
    cap.record(f, { method: 'GET', status: 200, ctype: 'text/html', bytes: 10, ms: 3 });
    return f.v;
  };
  const v1 = visit('198.51.100.9', CHROME, '/');
  const v1b = visit('198.51.100.9', CHROME, '/about');
  const w = visit('203.0.113.9', FIREFOX, '/');
  assert.equal(v1, v1b, 'the same visitor, the same day: one hash');
  assert.notEqual(v1, w);
  const salt1 = JSON.parse(fs.readFileSync(path.join(spoolDirOf('clock'), 'salt.json'), 'utf8'));
  assert.equal(salt1.day, dayStr(-2));
  clock = at(-1, 10);
  const v2 = visit('198.51.100.9', CHROME, '/');
  assert.notEqual(v1, v2, 'the next day the same visitor hashes differently');
  const salt2 = JSON.parse(fs.readFileSync(path.join(spoolDirOf('clock'), 'salt.json'), 'utf8'));
  assert.equal(salt2.day, dayStr(-1));
  assert.notEqual(salt1.salt, salt2.salt);
  assert.ok(!fs.readFileSync(path.join(spoolDirOf('clock'), 'salt.json'), 'utf8').includes(salt1.salt), 'yesterday\'s salt is gone from disk');
  assert.equal(lib.destroyStaleSalt(spoolDirOf('clock'), at(1, 1)), true, 'the dashboard sweep deletes a salt that is not today\'s');
  assert.equal(fs.existsSync(path.join(spoolDirOf('clock'), 'salt.json')), false);
  cap.close();

  await analytics.ingest('shop', 'clock');
  const q = (p) => analytics.query('shop', 'clock', p);
  const perDay = await q({ from: dayStr(-2), to: dayStr(-1), metrics: ['visitors', 'pageviews'], groupBy: ['day'] });
  assert.deepEqual(perDay.rows.map((r) => [r.day, r.visitors, r.pageviews]), [[dayStr(-2), 2, 3], [dayStr(-1), 1, 1]]);
  assert.equal(perDay.totals.visitors, 3, 'two people, one of them on two days = 3 visitor-days');
  assert.equal((await q({ from: dayStr(-2), to: dayStr(-2), metrics: ['visitors'], filters: { country: 'FR' } })).totals.visitors, 1);
  // one visit a day for 2 days: a bounce each day for v1? day -2 had 2 pages (no), w 1 page (yes)
  assert.equal((await q({ from: dayStr(-2), to: dayStr(-2), metrics: ['bounceRate', 'bounces', 'visitors'] })).totals.bounceRate, 0.5);
});

// ── 3. nothing identifying anywhere ──────────────────────────────────────
dbTest('3. no full IP and no raw UA in the spool or in any DB row', async () => {
  const text = [];
  for (const s of SITES) {
    let files = [];
    try { files = fs.readdirSync(spoolDirOf(s)).filter((f) => lib.SPOOL_RE.test(f)); } catch { /* none */ }
    for (const f of files) text.push(fs.readFileSync(path.join(spoolDirOf(s), f), 'utf8'));
  }
  const spool = text.join('\n');
  assert.ok(spool.length > 100000, 'there is a spool to check');
  const dump = JSON.stringify(await rows('SELECT * FROM analytics_hits'), (k, v) => (typeof v === 'bigint' ? Number(v) : v)) + JSON.stringify(await rows('SELECT * FROM analytics_daily'), (k, v) => (typeof v === 'bigint' ? Number(v) : v));
  assert.ok(dump.length > 100000);
  const FORBIDDEN = ['203.0.113', '198.51.100', '66.249.66', '127.0.0.1', 'Mozilla', 'AppleWebKit', 'Googlebot', 'Gecko', 'SECRETCOOKIE', 'QUERYSECRET', 'token=', 'sid='];
  for (const [what, hay] of [['spool', spool], ['database', dump]]) {
    for (const bad of FORBIDDEN) assert.ok(!hay.includes(bad), `${what} must not contain "${bad}"`);
    assert.equal(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(hay), false, `${what}: no dotted-quad address: ${(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.exec(hay) || [])[0]}`);
    assert.equal(/\b[0-9a-f]{1,4}(:[0-9a-f]{1,4}){5,}\b/i.test(hay), false, `${what}: no IPv6 address: ${(/\b[0-9a-f]{1,4}(:[0-9a-f]{1,4}){5,}\b/i.exec(hay) || [])[0]}`);
  }
  // the columns the rows can carry: nothing takes an address
  const cols = (await rows("SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'analytics_hits'", [store.DB])).map((r) => r.c);
  assert.ok(!cols.some((c) => /^(ip|ua|user_agent|cookie|addr)/i.test(c)), cols.join());
  // and the ingest clamps a hostile spool: an IP smuggled in a field is dropped
  const evil = store.rowOf('shop', 'main', 's', 0, { t: NOW, k: 'page', p: '/x', v: '203.0.113.7', c: '203.0.113.7', br: 'Mozilla/5.0 (X11)', r: '203.0.113.7', l: '203.0.113.7' });
  assert.equal(evil.includes('203.0.113.7'), false);
});

// ── 4. kill the runner mid-stream ────────────────────────────────────────
dbTest('4. a SIGKILLed runner: ingest loses no completed request and duplicates none', async () => {
  const st = await sites.start('shop', 'ing');
  assert.equal(st.state, 'running');
  const paths = Array.from({ length: 600 }, (_, i) => `/r/n${i}`);
  const ok = new Set();
  let done = 0, killed = false, firstIngest = null;
  await pool(paths, 25, async (p, i) => {
    try {
      const r = await req(P.ing, p, { 'x-forwarded-for': `198.51.100.${(i % 250) + 1}`, 'user-agent': `${CHROME} K${i}` });
      if (r.status === 200) ok.add(p);
    } catch { /* the runner is gone */ }
    done++;
    if (done === 200 && !firstIngest) firstIngest = analytics.ingest('shop', 'ing');   // continuous ingest, mid-stream
    if (done === 350 && !killed) { killed = true; process.kill(sites.status('shop', 'ing').pid, 'SIGKILL'); }
  });
  await firstIngest;
  await sites.stop('shop', 'ing');           // no restart wanted from here on
  await sleep(300);
  assert.ok(ok.size >= 300 && ok.size < 600, `some requests completed before the kill (${ok.size})`);
  const written = new Set(spoolLines('ing').filter((r) => r.k === 'page').map((r) => r.p));
  const inDb = async () => new Set((await rows("SELECT path FROM analytics_hits WHERE site='ing' AND kind='page'")).map((r) => r.path));
  const before = await inDb();
  // a torn last line (the kill landed mid-write) must be ignored, not break or duplicate anything
  const dir = spoolDirOf('ing');
  const newest = fs.readdirSync(dir).filter((f) => lib.SPOOL_RE.test(f)).sort().pop();
  fs.appendFileSync(path.join(dir, newest), '{"t":' + NOW + ',"k":"pa');
  const expected = new Set([...before, ...written]);
  for (const p of ok) assert.ok(expected.has(p), `${p} completed but is neither on the spool nor in the database`);
  await analytics.ingest('shop', 'ing');
  await analytics.ingest('shop', 'ing');
  const after = await inDb();
  assert.deepEqual([...after].sort(), [...expected].sort(), 'no lost rows');
  const [cnt] = await rows("SELECT COUNT(*) c, COUNT(DISTINCT path) d, COUNT(DISTINCT src, src_off) k FROM analytics_hits WHERE site='ing' AND kind='page'");
  assert.equal(n(cnt.c), n(cnt.d), 'no duplicated rows (one row per request path)');
  assert.equal(n(cnt.c), n(cnt.k));
  // offsets forgotten (a crash between the rows and the offset): re-reading cannot duplicate
  await rows("DELETE FROM analytics_spool WHERE site='ing'");
  await analytics.ingest('shop', 'ing');
  assert.equal(n((await rows("SELECT COUNT(*) c FROM analytics_hits WHERE site='ing' AND kind='page'"))[0].c), after.size);
});

dbTest('4b. a half-written line is read once it is complete, exactly once', async () => {
  const dir = spoolDirOf('torn');
  fs.mkdirSync(dir, { recursive: true });
  const rec = (p) => JSON.stringify({ t: NOW - 1000, k: 'page', m: 'GET', p, s: 200, b: 1, d: 1, br: 'Chrome', bv: 120, os: 'Linux', dv: 'desktop', bot: 0, v: 'abcdef0123456789' });
  const f = path.join(dir, 'spool-000001-abcdef.ndjson');
  const third = rec('/third');
  fs.writeFileSync(f, rec('/one') + '\n' + rec('/two') + '\n' + third.slice(0, 30));
  await analytics.ingest('shop', 'torn');
  assert.deepEqual((await rows("SELECT path FROM analytics_hits WHERE site='torn' ORDER BY path")).map((r) => r.path), ['/one', '/two']);
  fs.appendFileSync(f, third.slice(30) + '\n');
  await analytics.ingest('shop', 'torn');
  await analytics.ingest('shop', 'torn');
  assert.deepEqual((await rows("SELECT path FROM analytics_hits WHERE site='torn' ORDER BY path")).map((r) => r.path), ['/one', '/third', '/two']);
  // a garbage line is counted bad and skipped
  fs.appendFileSync(f, 'not json\n' + rec('/four') + '\n');
  await analytics.ingest('shop', 'torn');
  assert.equal(n((await rows("SELECT COUNT(*) c FROM analytics_hits WHERE site='torn'"))[0].c), 4);
});

// ── 5. nginx-combined import ─────────────────────────────────────────────
dbTest('5. importing an nginx-combined log: day rollups match a hand count', async () => {
  const ts = (d, hh, mm, ss, tz = '+0000') => `${String(new Date(D0 + d * DAY).getUTCDate()).padStart(2, '0')}/${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][new Date(D0 + d * DAY).getUTCMonth()]}/${new Date(D0 + d * DAY).getUTCFullYear()}:${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')} ${tz}`;
  const L = (ip, t, req, status, bytes, ref, ua) => `${ip} - - [${t}] "${req}" ${status} ${bytes} "${ref}" "${ua}"`;
  const lines = [
    L('198.51.100.5', ts(-3, 10, 0, 0), 'GET / HTTP/1.1', 200, 512, 'https://news.example/story', CHROME),
    L('198.51.100.5', ts(-3, 10, 0, 1), 'GET /style.css HTTP/1.1', 200, 100, '-', CHROME),
    L('198.51.100.5', ts(-3, 10, 0, 5), 'GET /about HTTP/1.1', 200, 300, '-', CHROME),
    L('203.0.113.9', ts(-3, 11, 0, 0, '+0100'), 'GET / HTTP/1.1', 200, 512, '-', FIREFOX),
    L('66.249.66.1', ts(-3, 12, 0, 0), 'GET / HTTP/1.1', 200, 512, '-', GOOGLEBOT),
    L('198.51.100.5', ts(-2, 9, 0, 0), 'GET /about?utm_source=nl&x=1 HTTP/1.1', 200, 300, '-', CHROME),
    L('198.51.100.6', ts(-2, 9, 30, 0), 'GET /missing HTTP/1.1', 404, 50, '-', IPHONE),
    L('198.51.100.6', ts(-2, 9, 30, 5), 'GET / HTTP/1.1', 200, 512, 'https://news.example/story', IPHONE),
    L('203.0.113.9', ts(-1, 8, 0, 0), 'GET / HTTP/1.1', 200, 512, '-', FIREFOX),
    L('203.0.113.9', ts(-1, 8, 0, 10), 'GET /about HTTP/1.1', 200, 300, '-', FIREFOX),
    L('203.0.113.9', ts(-1, 8, 0, 20), 'POST /api/x HTTP/1.1', 200, 10, '-', FIREFOX),
    L('203.0.113.9', '01/Jan/2025:00:00:00 +0000', 'GET / HTTP/1.1', 200, 1, '-', FIREFOX),
    'this is not a log line',
  ];
  const file = path.join(appsDir, 'shop', 'access.log');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const res = await analytics.importAccessLog('shop', 'imp', file, { format: 'nginx-combined' });
  assert.deepEqual({ lines: res.lines, imported: res.imported, duplicates: res.duplicates, bad: res.bad, tooOld: res.tooOld, bots: res.bots },
    { lines: 13, imported: 11, duplicates: 0, bad: 1, tooOld: 1, bots: 1 });
  assert.deepEqual(res.days, [dayStr(-3), dayStr(-2), dayStr(-1)]);
  const roll = async (day, dim, bot = 0) => (await rows('SELECT k, views, hits, visitors, bounces FROM analytics_daily WHERE site=? AND day=? AND dim=? AND bot=? ORDER BY k', ['imp', day, dim, bot]))
    .map((r) => ({ k: r.k, views: n(r.views), hits: n(r.hits), visitors: n(r.visitors), bounces: n(r.bounces) }));
  // hand count: pages / visitors / one-page visitors per day (humans)
  assert.deepEqual(await roll(dayStr(-3), 'total'), [{ k: 'all', views: 3, hits: 3, visitors: 2, bounces: 1 }]);
  assert.deepEqual(await roll(dayStr(-2), 'total'), [{ k: 'all', views: 2, hits: 2, visitors: 2, bounces: 2 }]);
  assert.deepEqual(await roll(dayStr(-1), 'total'), [{ k: 'all', views: 2, hits: 2, visitors: 1, bounces: 0 }]);
  assert.deepEqual(await roll(dayStr(-3), 'total', 1), [{ k: 'all', views: 1, hits: 1, visitors: 1, bounces: 1 }], 'the crawler is counted apart');
  assert.deepEqual((await roll(dayStr(-3), 'path')).map((r) => [r.k, r.views]), [['/', 2], ['/about', 1]]);
  assert.deepEqual((await roll(dayStr(-3), 'country')).map((r) => [r.k, r.views, r.visitors]), [['DE', 1, 1], ['FR', 2, 1]]);
  assert.deepEqual((await roll(dayStr(-3), 'referrer')).map((r) => [r.k, r.views]), [['', 2], ['news.example', 1]]);
  assert.deepEqual((await roll(dayStr(-2), 'utm_source')).map((r) => [r.k, r.views]), [['', 1], ['nl', 1]]);
  assert.deepEqual((await roll(dayStr(-2), 'notfound')).map((r) => [r.k, r.hits]), [['/missing', 1]]);
  assert.equal((await roll(dayStr(-3), 'requests'))[0].hits, 4, 'requests of humans: 3 pages + 1 stylesheet + the firefox page = 4 + ... ');
  // the same numbers through query(), and a second import of the same file adds nothing
  const q = await analytics.query('shop', 'imp', { from: dayStr(-3), to: dayStr(-1), metrics: ['visitors', 'pageviews'], groupBy: ['day'] });
  assert.deepEqual(q.rows.map((r) => [r.day, r.visitors, r.pageviews]), [[dayStr(-3), 2, 3], [dayStr(-2), 2, 2], [dayStr(-1), 1, 2]]);
  const again = await analytics.importAccessLog('shop', 'imp', file, {});
  assert.equal(again.imported, 0);
  assert.equal(again.duplicates, 11);
  assert.equal(n((await rows("SELECT COUNT(*) c FROM analytics_hits WHERE site='imp'"))[0].c), 11);
  // the import anonymises like a live hit: no IP or UA reached the table
  const dump = JSON.stringify(await rows("SELECT * FROM analytics_hits WHERE site='imp'"), (k, v) => (typeof v === 'bigint' ? Number(v) : v));
  assert.ok(!/203\.0\.113|198\.51\.100|66\.249|Mozilla|Googlebot/.test(dump));
  // visitor hashes differ across days for the same person (a fresh salt per day of the import)
  const vs = (await rows("SELECT day, visitor FROM analytics_hits WHERE site='imp' AND kind='page' AND country='FR' ORDER BY day")).map((r) => r.visitor);
  assert.equal(new Set(vs).size, 3, 'A on day -3, A on day -2, P on day -2');
});

// ── 6. retention ─────────────────────────────────────────────────────────
dbTest('6. the daily job rolls up and prunes: raw rows older than the setting are dropped, totals kept for the months setting', async () => {
  await sites.hostSettings('shop', 'old', { analyticsRawDays: 7, analyticsMonths: 1 });
  assert.equal(sites.status('shop', 'old').analyticsRawDays, 7);
  await assert.rejects(sites.hostSettings('shop', 'old', { analyticsRawDays: 3 }), /7–365/);
  const dir = spoolDirOf('old');
  fs.mkdirSync(dir, { recursive: true });
  const perDay = { [-60]: 3, [-15]: 2, [-8]: 4, [-6]: 5, [-1]: 6 };
  const lines = [];
  for (const [d, k] of Object.entries(perDay)) for (let i = 0; i < k; i++) lines.push(JSON.stringify({ t: at(Number(d), 9, i), k: 'page', m: 'GET', p: '/', s: 200, b: 1, d: 1, br: 'Chrome', bv: 1, os: 'Linux', dv: 'desktop', bot: 0, v: `${String(i).padStart(16, '0')}` }));
  fs.writeFileSync(path.join(dir, 'spool-000001-aaaaaa.ndjson'), lines.join('\n') + '\n');
  const out = await analytics.daily();
  assert.equal(out.ok, true);
  const rawDays = (await rows("SELECT DATE_FORMAT(day, '%Y-%m-%d') d, COUNT(*) c FROM analytics_hits WHERE site='old' GROUP BY day ORDER BY day")).map((r) => [r.d, n(r.c)]);
  // 7 days kept: -6 and -1 stay; -8, -15 and -60 are dropped (they were rolled up first)
  assert.deepEqual(rawDays, [[dayStr(-6), 5], [dayStr(-1), 6]]);
  const daily = (await rows("SELECT DATE_FORMAT(day, '%Y-%m-%d') d, views FROM analytics_daily WHERE site='old' AND dim='total' AND bot=0 ORDER BY day")).map((r) => [r.d, n(r.views)]);
  // months=1: the -60 day's total is gone, -15 and -8 survive, -6 and -1 are rolled up too once finished
  assert.deepEqual(daily, [[dayStr(-15), 2], [dayStr(-8), 4], [dayStr(-6), 5], [dayStr(-1), 6]]);
  // a query over the whole span reads the rollup for the old days and the raw rows for the rest
  const q = await analytics.query('shop', 'old', { from: dayStr(-20), to: dayStr(0), metrics: ['pageviews'], groupBy: ['day'] });
  assert.deepEqual(q.rows.map((r) => [r.day, r.pageviews]), [[dayStr(-15), 2], [dayStr(-8), 4], [dayStr(-6), 5], [dayStr(-1), 6]]);
  assert.equal(q.totals.pageviews, 17);
  assert.ok(q.source.rollup && q.source.raw, 'both sources answered');
  // a filter the rollup cannot answer skips those days and says so
  const f = await analytics.query('shop', 'old', { from: dayStr(-20), to: dayStr(0), metrics: ['pageviews'], filters: { path: '/', country: '' } });
  assert.ok(f.source.skipped);
  // only an equality filter on one dimension is answered from the rollup
  const one = await analytics.query('shop', 'old', { from: dayStr(-20), to: dayStr(0), metrics: ['pageviews'], filters: { path: '/' } });
  assert.equal(one.totals.pageviews, 17);
  assert.equal(one.source.skipped, null);
  // running the job again changes nothing
  const again = await analytics.daily();
  assert.deepEqual(again.pruned, { raw: 0, daily: 0 });
});

// ── no database ───────────────────────────────────────────────────────────
dbTest('7. without a database: the spool is kept, reads say "no database", nothing throws on ingest', async () => {
  const keep = appDb.getPool;
  appDb.getPool = () => null;
  store.reset();
  try {
    const dir = spoolDirOf('clock');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'spool-000099-bbbbbb.ndjson');
    fs.writeFileSync(f, JSON.stringify({ t: NOW, k: 'page', p: '/', bot: 0 }) + '\n');
    const r = await analytics.ingest('shop', 'clock');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_database');
    await assert.rejects(analytics.query('shop', 'clock', {}), (e) => e.code === 'no_database' && /no database/.test(e.message));
    assert.equal((await analytics.status('shop', 'clock')).db, false);
    assert.ok(fs.existsSync(f), 'the spool is untouched');
    assert.deepEqual(await analytics.daily(), { ok: false, reason: 'no_database' });
  } finally { appDb.getPool = keep; store.reset(); }
  assert.equal((await analytics.status('shop', 'clock')).db, true);
});

test('the runner without the opt-in records nothing and site.track is a no-op', async () => {
  const st = await sites.start('shop', 'noan');
  assert.equal(st.state, 'running');
  await req(P.noan, '/goal');
  await req(P.noan, '/');
  await sleep(200);
  assert.equal(fs.existsSync(spoolDirOf('noan')) && fs.readdirSync(spoolDirOf('noan')).filter((f) => lib.SPOOL_RE.test(f)).length, false);
  await sites.stop('shop', 'noan');
});

test('the capability: ctx and bridge surface, lane, tool', () => {
  const cap = require('../src/apps/capabilities').get('analytics');
  assert.deepEqual(cap.methods.sort(), ['analytics.csv', 'analytics.live', 'analytics.query']);
  const ctx = cap.buildCtx({ name: 'shop', resolvePath: (p) => path.join(appsDir, 'shop', p) });
  assert.deepEqual(Object.keys(ctx.analytics).sort(), ['csv', 'importAccessLog', 'live', 'query', 'status', 'track']);
  assert.ok(cap.horst.tools.some((t) => t.def.name === 'analytics_query' && /Read-only/.test(t.def.description)));
});
