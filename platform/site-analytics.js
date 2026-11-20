'use strict';
// Site analytics capture (docs/analytics.md). Zero dependencies, nothing from
// core or the platform: the site runner loads it (opt-in, manifest
// `sites.<site>.analytics`) and so does the dashboard's access-log import, so
// both anonymise by the same code.
//
// Prime rule: NO full IP address, raw user agent, cookie or query string (other
// than utm_* and ref) leaves `describe()`. A record holds the network prefix's
// country, parsed UA classes, a referrer HOST and a visitor hash
// sha256(dailySalt ∥ site ∥ ipPrefix ∥ UA) that nothing can reverse once the
// day's salt is gone (random per UTC day, overwritten at midnight UTC).
//
// Approach ported from vistaclair-apps/vr-moritz/game/sessinfo.js.

const fs = require('fs');
const net = require('net');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// ── the client address ───────────────────────────────────────────────────
const isLoopback = (a) => typeof a === 'string' && (a === '::1' || /^127\./.test(a) || /^::ffff:127\./i.test(a));
const unmap = (a) => (typeof a === 'string' ? a.replace(/^::ffff:/i, '') : a);

// The socket peer; X-Real-IP / the LAST X-Forwarded-For entry (the one our own
// proxy appended; the left ones are the client's to forge) only when that peer
// is loopback. Anything that is not an IP = the peer.
function clientIp(peer, headers) {
  const p = unmap(typeof peer === 'string' ? peer : '');
  const h = headers || {};
  if (!isLoopback(peer)) return net.isIP(p) ? p : '';
  const real = typeof h['x-real-ip'] === 'string' ? unmap(h['x-real-ip'].trim()) : '';
  if (net.isIP(real)) return real;
  const xff = typeof h['x-forwarded-for'] === 'string' ? h['x-forwarded-for'].split(',').map((s) => unmap(s.trim())).filter(Boolean) : [];
  const last = xff.length ? xff[xff.length - 1] : '';
  if (net.isIP(last)) return last;
  return net.isIP(p) ? p : '';
}

function expandV6(a) {
  let s = a.replace(/%.*$/, '');
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) { const o = v4[1].split('.').map(Number); s = s.replace(v4[1], ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16)); }
  const [head, tail] = s.split('::');
  const hs = head ? head.split(':') : [], ts = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - hs.length - ts.length;
  const all = [...hs, ...Array(Math.max(0, fill)).fill('0'), ...ts];
  if (all.length !== 8) return null;
  const n = all.map((x) => parseInt(x, 16));
  return n.some((x) => !(x >= 0 && x <= 0xffff)) ? null : n;
}
// IPv4 → "a.b.c.0/24"; IPv6 → its first 48 bits; '' = not an IP
function prefixOf(ip) {
  const a = unmap(ip);
  if (net.isIPv4(a)) { const o = a.split('.'); return `${o[0]}.${o[1]}.${o[2]}.0/24`; }
  if (net.isIPv6(a)) {
    const g = expandV6(a);
    return g ? `${g.slice(0, 3).map((x) => x.toString(16)).join(':')}::/48` : '';
  }
  return '';
}
const isPrivate = (ip) => {
  const a = unmap(ip);
  if (net.isIPv4(a)) { const [x, y] = a.split('.').map(Number); return x === 10 || x === 127 || (x === 192 && y === 168) || (x === 172 && y >= 16 && y < 32) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y < 128); }
  if (net.isIPv6(a)) { const g = expandV6(a); return !!g && ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || a === '::1'); }
  return false;
};

// ── country (DB-IP Country Lite, CC BY 4.0; the GEO1 table, analytics-geo.js builds it) ──
function loadGeo(file) {
  try {
    const b = zlib.gunzipSync(fs.readFileSync(file));
    if (b.toString('latin1', 0, 4) !== 'GEO1') return null;
    const n4 = b.readUInt32LE(4), n6 = b.readUInt32LE(8);
    let o = 12;
    const v4s = new Uint32Array(n4); for (let i = 0; i < n4; i++, o += 4) v4s[i] = b.readUInt32LE(o);
    const v4c = b.subarray(o, o + n4 * 2); o += n4 * 2;
    const v6s = new Float64Array(n6); for (let i = 0; i < n6; i++, o += 6) v6s[i] = b.readUIntLE(o, 6);
    const v6c = b.subarray(o, o + n6 * 2);
    return { v4s, v4c, v6s, v6c, built: b.readUInt32LE(o + n6 * 2) || null };
  } catch { return null; }
}
function lastLE(arr, key) {
  let lo = 0, hi = arr.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= key) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}
function countryOf(ip, g) {
  const a = unmap(ip);
  if (!g || !a || isPrivate(a)) return null;
  let cc = null;
  if (net.isIPv4(a)) {
    const o = a.split('.').map(Number);
    const i = lastLE(g.v4s, ((o[0] * 16777216) + (o[1] << 16) + (o[2] << 8) + o[3]));
    if (i >= 0) cc = String.fromCharCode(g.v4c[2 * i], g.v4c[2 * i + 1]);
  } else if (net.isIPv6(a)) {
    const e = expandV6(a);
    if (e) { const i = lastLE(g.v6s, e[0] * 2 ** 32 + e[1] * 65536 + e[2]); if (i >= 0) cc = String.fromCharCode(g.v6c[2 * i], g.v6c[2 * i + 1]); }
  }
  return cc && /^[A-Z]{2}$/.test(cc) && cc !== 'ZZ' ? cc : null;
}
// A reloading handle on the table file: re-stat at most once a minute, so the
// monthly refresh is picked up by a running site; no file = no country.
function geoHandle(file, nowFn = Date.now) {
  let table = null, mtime = -1, checked = 0;
  return {
    get() {
      if (!file) return null;
      const t = nowFn();
      if (t - checked < 60000 && mtime !== -1) return table;
      checked = t;
      try {
        const m = fs.statSync(file).mtimeMs;
        if (m !== mtime) { mtime = m; table = loadGeo(file); }
      } catch { mtime = 0; table = null; }
      return table;
    },
  };
}

// ── the user agent ────────────────────────────────────────────────────────
function parseUA(ua) {
  const s = typeof ua === 'string' ? ua.slice(0, 400) : '';
  if (!s) return { browser: 'unknown', browser_v: null, os: 'unknown', device: 'unknown' };
  const ver = (re) => { const m = re.exec(s); return m ? Math.min(999, parseInt(m[1], 10)) : null; };
  const quest = /OculusBrowser|\bQuest\b/.test(s);
  let browser = 'other', bv = null;
  if (/OculusBrowser/i.test(s)) { browser = 'Quest Browser'; bv = ver(/OculusBrowser\/(\d+)/i); }
  else if (/Edg(?:e|A|iOS)?\/\d/.test(s)) { browser = 'Edge'; bv = ver(/Edg(?:e|A|iOS)?\/(\d+)/); }
  else if (/OPR\/\d|Opera/.test(s)) { browser = 'Opera'; bv = ver(/(?:OPR|Opera)\/(\d+)/); }
  else if (/SamsungBrowser\/\d/.test(s)) { browser = 'Samsung Internet'; bv = ver(/SamsungBrowser\/(\d+)/); }
  else if (/Firefox\/\d|FxiOS\/\d/.test(s)) { browser = 'Firefox'; bv = ver(/(?:Firefox|FxiOS)\/(\d+)/); }
  else if (/Chrome\/\d|CriOS\/\d|Chromium\/\d/.test(s)) { browser = 'Chrome'; bv = ver(/(?:Chrome|CriOS|Chromium)\/(\d+)/); }
  else if (/Safari\/\d/.test(s) && /Version\/\d/.test(s)) { browser = 'Safari'; bv = ver(/Version\/(\d+)/); }
  let os = 'other';
  if (quest) os = 'Quest';
  else if (/iPhone|iPad|iPod|CPU (?:iPhone )?OS \d/.test(s)) os = 'iOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Windows/.test(s)) os = 'Windows';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/Linux|X11/.test(s)) os = 'Linux';
  let device = 'desktop';
  if (quest) device = 'quest-browser';
  else if (/iPad|Tablet/.test(s) || (/Android/.test(s) && !/Mobile/.test(s))) device = 'tablet';
  else if (/iPhone|iPod|Mobile|Android/.test(s)) device = 'phone';
  else if (browser === 'other') device = 'unknown';
  return { browser, browser_v: bv, os, device };
}

// Accept-Language → the first entry's primary tag (2–3 letters, lower case), else null
function langOf(h) {
  if (typeof h !== 'string') return null;
  const m = /^\s*([A-Za-z]{2,3})(?:[-_;,*\s]|$)/.exec(h.slice(0, 120));
  return m ? m[1].toLowerCase() : null;
}

// Self-declared crawlers, fetchers, link previewers and monitors. An empty UA is a bot too.
const BOT_RE = /bot\b|bots\b|crawl|spider|slurp|scrap|curl\/|wget|python|aiohttp|httpx|axios|node-fetch|undici|go-http|okhttp|java\/|libwww|apache-httpclient|headless|phantom|lighthouse|pagespeed|pingdom|uptime|monitor|facebookexternalhit|embedly|preview|whatsapp|telegram|discord|slack|yandex|baidu|duckduck|ahrefs|semrush|mj12|dotbot|petalbot|gptbot|claudebot|ccbot|bytespider|perplexity|amazonbot|bingpreview|feedfetcher|feedly|rss/i;
const isBotUA = (ua) => !ua || BOT_RE.test(String(ua).slice(0, 400));

// ── the request ───────────────────────────────────────────────────────────
const ASSET_EXT = /\.(?:css|js|mjs|map|json|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp3|mp4|webm|ogg|wav|wasm|webmanifest|txt|xml)$/i;
const ASSET_CT = /^(?:text\/css|(?:text|application)\/(?:java|ecma)script|image\/|font\/|audio\/|video\/|application\/(?:wasm|font|manifest\+json))/i;
const TOKENISH = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{24,}|\d{8,})$/;
const PATH_MAX = 255;

// "/a//b/?x=1&utm_source=z" → { path: "/a/b", qs: "utm_source=z", utm: { source, medium, campaign }, refParam }
function normalizeUrl(url) {
  const raw = String(url || '/').slice(0, 2048);
  const hash = raw.indexOf('#');
  const noHash = hash >= 0 ? raw.slice(0, hash) : raw;
  const qi = noHash.indexOf('?');
  let p = qi >= 0 ? noHash.slice(0, qi) : noHash;
  const query = qi >= 0 ? noHash.slice(qi + 1) : '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) p = p.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  p = p.split(';')[0];
  try { p = decodeURIComponent(p); } catch { /* keep the raw form */ }
  // eslint-disable-next-line no-control-regex
  p = p.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\/{2,}/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  // ids and tokens in a path are not a page: a segment that looks like one becomes ":id"
  p = p.split('/').map((seg) => (seg && TOKENISH.test(seg) ? ':id' : seg)).join('/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  if (p.length > PATH_MAX) p = p.slice(0, PATH_MAX);
  const keep = [];
  const utm = { source: null, medium: null, campaign: null };
  let refParam = null;
  if (query) {
    for (const pair of query.split('&')) {
      const eq = pair.indexOf('=');
      let k = eq >= 0 ? pair.slice(0, eq) : pair;
      let v = eq >= 0 ? pair.slice(eq + 1) : '';
      try { k = decodeURIComponent(k.replace(/\+/g, ' ')); v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch { /* raw */ }
      k = k.toLowerCase();
      if (!/^(?:utm_[a-z_]{1,20}|ref)$/.test(k)) continue;
      // eslint-disable-next-line no-control-regex
      v = v.replace(/[\u0000-\u001f\u007f&=#]/g, '').slice(0, 64);
      if (!v) continue;
      keep.push(`${k}=${v}`);
      if (k === 'utm_source') utm.source = v;
      else if (k === 'utm_medium') utm.medium = v;
      else if (k === 'utm_campaign') utm.campaign = v;
      else if (k === 'ref') refParam = v;
    }
  }
  keep.sort();
  return { path: p, qs: keep.join('&').slice(0, 200), utm, refParam };
}

// the referrer's HOST; '' for none, malformed or internal (the site's own host)
function refHost(referer, internal) {
  if (typeof referer !== 'string' || !referer) return '';
  let h = '';
  try { h = new URL(referer.slice(0, 1000)).hostname.toLowerCase(); } catch { return ''; }
  h = h.replace(/^www\./, '').replace(/\.$/, '');
  if (!h || h.length > 128) return '';
  for (const i of internal || []) if (i && (h === i || h.endsWith('.' + i))) return '';
  if (h === 'localhost' || net.isIP(h)) return '';
  return h;
}
const hostOnly = (host) => (typeof host === 'string' ? host.toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '').replace(/^\[|\]$/g, '') : '');

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function kindOf(method, status, ctype, p) {
  const m = String(method || '').toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return 'other';
  if (status >= 300 && status !== 304) return 'other';
  if (status >= 200 && status < 300 && /^text\/html|^application\/xhtml/i.test(ctype || '')) return 'page';
  if (status === 304 && !ctype && (!/\.[A-Za-z0-9]{1,8}$/.test(p) || /\.html?$/i.test(p))) return 'page';
  if (ASSET_CT.test(ctype || '') || ASSET_EXT.test(p)) return 'asset';
  return 'other';
}

// The visitor hash. The salt is the day's random value; the raw UA only ever
// passes through this function.
function visitorHash(salt, siteKey, prefix, ua) {
  return crypto.createHash('sha256').update(`${salt}\0${siteKey}\0${prefix}\0${ua || ''}`).digest('hex').slice(0, 16);
}

// What a request tells us, reduced. `in` = { ip, ua, lang, referer, host, url }; env = { siteKey, salt, geo, internalHosts }.
function describe(inp, env) {
  const ip = inp.ip || '';
  const prefix = prefixOf(ip);
  const ua = parseUA(inp.ua);
  const n = normalizeUrl(inp.url);
  const host = hostOnly(inp.host);
  const internal = [host, ...(env.internalHosts || [])].filter(Boolean);
  return {
    p: n.path, q: n.qs, us: n.utm.source, um: n.utm.medium, uc: n.utm.campaign,
    r: refHost(inp.referer, internal),
    br: ua.browser, bv: ua.browser_v, os: ua.os, dv: ua.device,
    l: langOf(inp.lang),
    c: ip ? countryOf(ip, env.geo) : null,
    bot: isBotUA(inp.ua) ? 1 : 0,
    v: visitorHash(env.salt, env.siteKey, prefix, inp.ua),
  };
}

// ── the daily salt ────────────────────────────────────────────────────────
// data/.analytics/salt.json {day, salt}. A new day writes a new random salt over
// the old file, which destroys the old one; an old file is never read as today's.
function saltStore(dir, nowFn = Date.now) {
  const file = path.join(dir, 'salt.json');
  let cache = null;
  function rotate(day) {
    const salt = crypto.randomBytes(24).toString('hex');
    cache = { day, salt };
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* memory-only salt: still random, still destroyed at midnight */ }
    return salt;
  }
  return {
    get() {
      const day = dayOf(nowFn());
      if (cache && cache.day === day) return cache.salt;
      try {
        const f = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (f && f.day === day && /^[0-9a-f]{32,}$/.test(f.salt)) { cache = f; return f.salt; }
      } catch { /* none yet */ }
      return rotate(day);
    },
    // overwrite a stale salt now (the midnight timer, the dashboard's cron)
    sweep() { if (!cache || cache.day !== dayOf(nowFn())) this.get(); },
  };
}
// The dashboard's daily sweep: delete a salt file that is not today's.
function destroyStaleSalt(dir, nowMs = Date.now()) {
  const file = path.join(dir, 'salt.json');
  try {
    const f = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!f || f.day !== dayOf(nowMs)) { fs.unlinkSync(file); return true; }
  } catch { /* none / unreadable */ }
  return false;
}

// ── props of a custom event ───────────────────────────────────────────────
function cleanEvent(name, props) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(name)) return null;
  const out = {};
  let n = 0;
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    for (const [k, v] of Object.entries(props)) {
      if (n >= 8) break;
      if (!/^[A-Za-z0-9_.-]{1,32}$/.test(k)) continue;
      if (typeof v === 'string') out[k] = v.slice(0, 80);
      else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      else if (typeof v === 'boolean') out[k] = v;
      else continue;
      n++;
    }
  }
  let json = JSON.stringify(out);
  if (json.length > 600) json = '{}';
  return { name, props: json === '{}' ? null : json };
}

// ── the live capture (the runner) ─────────────────────────────────────────
const SPOOL_ROTATE = 2 * 1024 * 1024;
const SPOOL_CAP = 64 * 1024 * 1024;
const HEUR_PAGES = 4;       // page loads with no asset at all → a script (when the site served assets to others today)
const VISITOR_CAP = 20000;
// a random id per file: a wiped directory (seq back to 1) can never collide with rows already ingested
const spoolName = (n, id) => `spool-${String(n).padStart(6, '0')}-${id}.ndjson`;
const SPOOL_RE = /^spool-(\d{6,})-([0-9a-f]{6})\.ndjson$/;

function createCapture({ siteKey, dataDir, geoFile, internalHosts = [], now = Date.now, notify = () => {}, log = () => {} }) {
  const dir = path.join(dataDir, '.analytics');
  fs.mkdirSync(dir, { recursive: true });
  const salts = saltStore(dir, now);
  const geo = geoHandle(geoFile, now);
  let fd = null, seq = 0, size = 0, dropped = 0, warned = false;
  const day = { d: '', visitors: new Map(), assetsFromOthers: 0 };

  function existing() { try { return fs.readdirSync(dir).map((f) => SPOOL_RE.exec(f)).filter(Boolean).map((m) => ({ n: Number(m[1]), f: m[0] })).sort((a, b) => a.n - b.n); } catch { return []; } }
  function open() {
    const ex = existing();
    seq = (ex.length ? ex[ex.length - 1].n : 0) + 1;
    fd = fs.openSync(path.join(dir, spoolName(seq, crypto.randomBytes(3).toString('hex'))), 'a', 0o600);
    size = 0;
  }
  function trim() {
    let files = existing().slice(0, -1);
    let total = 0;
    const sizes = new Map();
    for (const { f } of files) { try { const s = fs.statSync(path.join(dir, f)).size; sizes.set(f, s); total += s; } catch { /* gone */ } }
    for (const { f } of files) {
      if (total <= SPOOL_CAP) break;
      try { fs.unlinkSync(path.join(dir, f)); total -= sizes.get(f) || 0; dropped++; } catch { /* gone */ }
    }
  }
  function rotate() {
    try { fs.closeSync(fd); } catch { /* closed */ }
    open();
    trim();
    notify();
  }
  open();

  let pending = null;
  function ping() {
    if (pending) return;
    pending = setTimeout(() => { pending = null; try { notify(); } catch { /* channel closing */ } }, 750);
    if (pending.unref) pending.unref();
  }
  function write(rec) {
    const line = JSON.stringify(rec) + '\n';
    try {
      const buf = Buffer.from(line);
      fs.writeSync(fd, buf);
      size += buf.length;
      if (size >= SPOOL_ROTATE) rotate(); else ping();
    } catch (e) {
      dropped++;
      if (!warned) { warned = true; log(`analytics: cannot write the spool (${e.code || e.message}); hits are dropped until it recovers`); }
    }
  }

  function dayState(ts) {
    const d = dayOf(ts);
    if (day.d !== d) { day.d = d; day.visitors = new Map(); day.assetsFromOthers = 0; }
    return day;
  }
  const env = () => ({ siteKey, salt: salts.get(), geo: geo.get(), internalHosts });

  return {
    dir,
    stats: () => ({ dropped, seq }),
    // facts of a request (computed at its start; track() reuses them)
    describe(req, ip) {
      const h = req.headers || {};
      return describe({ ip, ua: h['user-agent'], lang: h['accept-language'], referer: h.referer, host: h['x-forwarded-host'] && isLoopback(req.socket && req.socket.remoteAddress) ? String(h['x-forwarded-host']).split(',')[0].trim() : h.host, url: req.url }, env());
    },
    // one record per request, written when the response ends
    record(facts, res) {
      const ts = now();
      const ds = dayState(ts);
      const kind = kindOf(res.method, res.status, res.ctype, facts.p);
      let bot = facts.bot;
      let vs = ds.visitors.get(facts.v);
      if (!vs) { if (ds.visitors.size >= VISITOR_CAP) ds.visitors.clear(); vs = { pages: 0, assets: 0 }; ds.visitors.set(facts.v, vs); }
      if (!bot) {
        if (kind === 'page') vs.pages++;
        else if (kind === 'asset') { vs.assets++; ds.assetsFromOthers++; }
        if (vs.assets === 0 && vs.pages >= HEUR_PAGES && ds.assetsFromOthers > 0) bot = 2;
      }
      write({
        t: ts, k: kind, m: String(res.method || '').toUpperCase().slice(0, 8), p: facts.p, q: facts.q || undefined,
        s: res.status, b: res.bytes, d: Math.min(res.ms, 2147483647), r: facts.r || undefined,
        us: facts.us || undefined, um: facts.um || undefined, uc: facts.uc || undefined,
        br: facts.br, bv: facts.bv == null ? undefined : facts.bv, os: facts.os, dv: facts.dv, l: facts.l || undefined, c: facts.c || undefined,
        bot, v: facts.v,
      });
    },
    // site.track: a custom event (a goal), tied to the current request's visitor if there is one
    track(name, props, facts) {
      const ev = cleanEvent(name, props);
      if (!ev) return false;
      const f = facts || {};
      write({
        t: now(), k: 'event', n: ev.name, pr: ev.props || undefined, p: f.p, s: 0, b: 0, d: 0,
        br: f.br, bv: f.bv == null ? undefined : f.bv, os: f.os, dv: f.dv, l: f.l || undefined, c: f.c || undefined,
        r: f.r || undefined, bot: f.bot || 0, v: f.v || undefined,
      });
      return true;
    },
    sweepSalt() { salts.sweep(); },
    close() { try { fs.closeSync(fd); } catch { /* closed */ } },
  };
}

// ── nginx combined log lines (the import) ────────────────────────────────
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const COMBINED = /^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d{3}) (\d+|-)(?: "([^"]*)" "([^"]*)")?/;
function parseCombined(line) {
  const m = COMBINED.exec(line);
  if (!m) return null;
  const t = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(m[2]);
  if (!t || !(t[2] in MONTHS)) return null;
  const off = (t[7] === '-' ? -1 : 1) * (Number(t[8]) * 60 + Number(t[9])) * 60000;
  const ts = Date.UTC(Number(t[3]), MONTHS[t[2]], Number(t[1]), Number(t[4]), Number(t[5]), Number(t[6])) - off;
  const rq = m[3].split(' ');
  if (rq.length < 2) return null;
  return { ip: m[1], ts, method: rq[0], url: rq[1], status: Number(m[4]), bytes: m[5] === '-' ? 0 : Number(m[5]), referer: m[6] === '-' ? '' : m[6] || '', ua: m[7] === '-' ? '' : m[7] || '' };
}
// A parsed log line → the same record the live capture writes (a log has no
// content type, so the kind comes from the path).
function recordFromLog(p, env) {
  const facts = describe({ ip: p.ip, ua: p.ua, lang: '', referer: p.referer, host: '', url: p.url }, env);
  const kind = kindOf(p.method, p.status, '', facts.p);
  return {
    t: p.ts, k: kind === 'other' && /^(?:GET|HEAD)$/i.test(p.method) && p.status < 300 && !/\.[A-Za-z0-9]{1,8}$/.test(facts.p) ? 'page' : kind,
    m: String(p.method).toUpperCase().slice(0, 8), p: facts.p, q: facts.q || undefined, s: p.status, b: p.bytes, d: 0,
    r: facts.r || undefined, us: facts.us || undefined, um: facts.um || undefined, uc: facts.uc || undefined,
    br: facts.br, bv: facts.bv == null ? undefined : facts.bv, os: facts.os, dv: facts.dv, l: undefined, c: facts.c || undefined,
    bot: facts.bot, v: facts.v,
  };
}

module.exports = {
  clientIp, prefixOf, isPrivate, loadGeo, countryOf, geoHandle, parseUA, langOf, isBotUA, normalizeUrl, refHost, kindOf,
  visitorHash, describe, saltStore, destroyStaleSalt, cleanEvent, createCapture, parseCombined, recordFromLog, dayOf,
  SPOOL_RE, spoolName, HEUR_PAGES,
};
