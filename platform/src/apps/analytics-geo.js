'use strict';
// The platform-wide offline country table for site analytics (docs/analytics.md).
//
// One file for the whole host, `<appsDir>/.platform-geo/country.bin.gz`, built
// from DB-IP "IP to Country Lite" (CC BY 4.0) in the GEO1 binary format and
// refreshed monthly by a platform cron job. A site runner reads it (read-only,
// the fence grants the directory); no table = country "unknown", nothing fails.
// The format and builder are ported from vr-moritz tools/geoip-build.mjs; the
// lookup side lives in platform/site-analytics.js (the runner needs it).
//
// GEO1: u32 n4, u32 n6, n4 × u32 IPv4 range start (LE, ascending), n4 × 2 bytes
// country, n6 × 6 bytes the first 48 bits of an IPv6 range start, n6 × 2 bytes
// country, u32 build stamp (YYYYMMDD). Only starts where the country CHANGES are
// kept (gaps = 'ZZ'); a lookup = the last start ≤ the address.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');

const CREDIT = { text: 'IP geolocation by DB-IP', url: 'https://db-ip.com' };
const LICENCE = 'DB-IP IP to Country Lite, CC BY 4.0';
const GZ_MAX = 64 * 1024 * 1024;
const JOB = { name: 'analytics:geo-refresh', handler: 'analytics.geo-refresh', schedule: '0 4 3 * *' };

function appsDir() { return require('./app-manager').APPS_DIR; }
function geoDir() { return path.join(appsDir(), '.platform-geo'); }
function tableFile({ ensure = false } = {}) {
  const d = geoDir();
  if (ensure) fs.mkdirSync(d, { recursive: true });
  return path.join(d, 'country.bin.gz');
}
const metaFile = () => path.join(geoDir(), 'meta.json');
function readMeta() { try { return JSON.parse(fs.readFileSync(metaFile(), 'utf8')); } catch { return {}; } }
function writeMeta(m) {
  fs.mkdirSync(geoDir(), { recursive: true });
  fs.writeFileSync(metaFile(), JSON.stringify(m, null, 2));
}

// CSV text (ranges "start,end,CC") → the gzipped GEO1 table + counts.
function buildTable(csv, now = new Date()) {
  const v4n = (s) => s.split('.').reduce((a, o) => a * 256 + +o, 0);
  const v6n = (s) => {
    const [h, t] = s.split('::');
    const hs = h ? h.split(':') : [], ts = t ? t.split(':') : [];
    const g = [...hs, ...Array(Math.max(0, 8 - hs.length - ts.length)).fill('0'), ...ts].map((x) => BigInt('0x' + (x || '0')));
    return g.reduce((a, x) => (a << 16n) | x, 0n);
  };
  const a4 = [], a6 = [];
  let end4 = -1, end6 = -1n, c4 = '', c6 = '';
  const push4 = (k, cc) => { if (cc !== c4) { a4.push([k, cc]); c4 = cc; } };
  const push6 = (k, cc) => {
    if (cc !== c6) {
      if (a6.length && a6[a6.length - 1][0] === k) a6[a6.length - 1][1] = cc; else a6.push([k, cc]);
      c6 = cc;
    }
  };
  for (const line of String(csv).split('\n')) {
    const [s, e, rawCc] = line.trim().replace(/"/g, '').split(',');
    const cc = rawCc;
    if (!cc || !/^[A-Z]{2}$/.test(cc)) continue;
    try {
      if (s.includes(':')) {
        const a = v6n(s), b = v6n(e);
        const k = a >> 80n;
        if (end6 >= 0n && a > end6 + 1n) push6((end6 + 1n) >> 80n, 'ZZ');
        push6(k, cc);
        end6 = b;
      } else {
        const a = v4n(s), b = v4n(e);
        if (end4 >= 0 && a > end4 + 1) push4(end4 + 1, 'ZZ');
        push4(a, cc);
        end4 = b;
      }
    } catch { /* a malformed line */ }
  }
  const n4 = a4.length, n6 = a6.length;
  const buf = Buffer.alloc(12 + n4 * 6 + n6 * 8 + 4);
  buf.write('GEO1', 0, 'latin1');
  buf.writeUInt32LE(n4, 4);
  buf.writeUInt32LE(n6, 8);
  let o = 12;
  for (const [k] of a4) { buf.writeUInt32LE(k, o); o += 4; }
  for (const [, cc] of a4) { buf.write(cc, o, 'latin1'); o += 2; }
  for (const [k] of a6) { buf.writeUIntLE(Number(k), o, 6); o += 6; }
  for (const [, cc] of a6) { buf.write(cc, o, 'latin1'); o += 2; }
  buf.writeUInt32LE(now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate(), o);
  return { gz: zlib.gzipSync(buf, { level: 9 }), v4: n4, v6: n6 };
}

function install(gz) {
  const file = tableFile({ ensure: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, gz);
  fs.renameSync(tmp, file);   // atomic: a running site reloads on the next mtime check
}

function download(url, depth = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'vistaclair-analytics-geo' }, timeout: 120000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 3) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), depth + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      let n = 0;
      res.on('data', (c) => { n += c.length; if (n > GZ_MAX) req.destroy(new Error('download too large')); else chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const monthUrl = (d) => `https://download.db-ip.com/free/dbip-country-lite-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.csv.gz`;

// Fetch this month's file (last month's when DB-IP has not published yet), build, install.
// `fetchFn(url) → Buffer` is injectable (tests, a proxy). Never throws: the outcome is recorded.
async function refresh({ fetchFn = download, now = new Date() } = {}) {
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  let lastErr = null;
  for (const d of [now, prev]) {
    const url = monthUrl(d);
    try {
      const raw = await fetchFn(url);
      const csv = /^\x1f\x8b/.test(raw.subarray(0, 2).toString('latin1')) ? zlib.gunzipSync(raw) : raw;
      const { gz, v4, v6 } = buildTable(csv.toString('utf8'), now);
      if (v4 < 1000) throw new Error(`the file has only ${v4} IPv4 ranges — refusing to replace the table`);
      install(gz);
      const meta = { at: now.getTime(), ok: true, source: url, v4, v6, licence: LICENCE };
      writeMeta(meta);
      return { ok: true, ...meta };
    } catch (e) { lastErr = e; }
  }
  const meta = { ...readMeta(), at: now.getTime(), ok: false, error: String(lastErr && lastErr.message).slice(0, 200) };
  try { writeMeta(meta); } catch { /* read-only host */ }
  return { ok: false, error: meta.error };
}

function status() {
  const file = tableFile();
  const m = readMeta();
  let built = null, available = false;
  try {
    const st = fs.statSync(file);
    available = st.size > 0;
    built = require('../../site-analytics').loadGeo(file)?.built || null;
  } catch { /* none yet */ }
  return { available, built, lastRefresh: m.at ? { at: m.at, ok: !!m.ok, error: m.error || null } : null, credit: CREDIT, licence: LICENCE };
}

// The monthly platform cron job (dedup-by-name like the engine jobs).
function register(platformCron) {
  platformCron.registerInternal(JOB.handler, () => refresh());
  try {
    if (platformCron.list().some((j) => j.name === JOB.name)) return;
    const res = platformCron.addJob({ name: JOB.name, schedule: JOB.schedule, target: { type: 'internal', handler: JOB.handler } });
    if (!res.ok) console.error(`  Analytics: failed to register ${JOB.name}: ${res.error}`);
  } catch (e) { console.error('  Analytics: geo cron:', e.message); }
}

module.exports = { tableFile, buildTable, install, refresh, status, register, monthUrl, CREDIT, LICENCE, JOB };
