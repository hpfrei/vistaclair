'use strict';
// Vistaclair site runner — hosts ONE site of one app on its own port, as a
// child of the dashboard (platform/src/apps/sites.js forks it; docs/sites.md).
//
// Zero dependencies, nothing from core or the platform: it loads only the
// site's handler. Its env is the engine's explicit allowlist (no AUTH_TOKEN,
// no provider keys). The control channel is the fork IPC pipe: when it closes
// (the dashboard stopped, restarted, crashed or was SIGKILLed) the runner exits.
//
// Handler contract:  module.exports = function createSite(site) { return async (req, res) => {} }
// (or return { request(req, res), upgrade(req, socket, head) } to take WebSocket upgrades).

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { AsyncLocalStorage } = require('async_hooks');

const E = process.env;
const SITE = {
  app: E.VC_SITE_APP || '',
  name: E.VC_SITE_NAME || '',
  port: Number(E.VC_SITE_PORT),
  bind: E.VC_SITE_BIND || '127.0.0.1',
  handler: E.VC_SITE_HANDLER || '',
  dataDir: E.VC_SITE_DATA || '',
  idToken: E.VC_SITE_ID || '',
  platform: E.VC_SITE_PLATFORM || 'none',
  analytics: E.VC_SITE_ANALYTICS === '1',   // manifest sites.<site>.analytics (docs/analytics.md)
  geo: E.VC_SITE_GEO || '',                 // the platform's country table (read-only, may not exist)
  domains: (E.VC_SITE_DOMAIN || '').split(',').filter(Boolean),
};
const CALL_ARGS_MAX = 64 * 1024;
const CALL_TIMEOUT_MS = 5000;
const CALL_TIMEOUT_MAX = 30000;

if (typeof process.send !== 'function') {
  console.error('site-runner: started without an IPC channel (the dashboard starts sites)');
  process.exit(2);
}
// No keeper: the pipe IS the lifeline.
process.on('disconnect', () => process.exit(0));

const send = (m) => { try { if (process.connected) process.send(m); } catch { /* channel closing */ } };
const als = new AsyncLocalStorage();
const fenced = !!(process.permission && typeof process.permission.has === 'function');

// ── log ───────────────────────────────────────────────────────────────────
// One line per call, never request bodies or headers (the runner itself logs
// only method + path without the query).
function logLine(level, args) {
  const text = args.map(a => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : safeJson(a))).join(' ');
  send({ t: 'log', level, text: text.slice(0, 2000) });
}
function safeJson(v) { try { return JSON.stringify(v); } catch { return String(v); } }
const log = {
  info: (...a) => logLine('info', a),
  warn: (...a) => logLine('warn', a),
  error: (...a) => logLine('error', a),
};

// ── client IP (for site.call's rate limit) ──────────────────────────────
const isLoopback = (a) => typeof a === 'string' && (a === '::1' || /^127\./.test(a) || /^::ffff:127\./i.test(a));
const unmap = (a) => (typeof a === 'string' ? a.replace(/^::ffff:/i, '') : '');
// The socket peer; a proxy's X-Real-IP / last X-Forwarded-For only when that peer is loopback.
function clientIp(peer, h) {
  const p = unmap(peer);
  if (!isLoopback(peer)) return net.isIP(p) ? p : '';
  const real = typeof h['x-real-ip'] === 'string' ? unmap(h['x-real-ip'].trim()) : '';
  if (net.isIP(real)) return real;
  const xff = typeof h['x-forwarded-for'] === 'string' ? h['x-forwarded-for'].split(',').map(s => unmap(s.trim())).filter(Boolean) : [];
  const last = xff.length ? xff[xff.length - 1] : '';
  if (net.isIP(last)) return last;
  return net.isIP(p) ? p : '';
}

// ── analytics (opt-in): one record per request, before the handler ─────────
// docs/analytics.md. The lib is a sibling file; the record is written to the
// spool when the response ends. Nothing here ever stores the IP or the raw UA.
let capture = null;
function startCapture() {
  if (!SITE.analytics || capture) return;
  try {
    capture = require('./site-analytics').createCapture({
      siteKey: `${SITE.app}/${SITE.name}`, dataDir: SITE.dataDir, geoFile: SITE.geo, internalHosts: SITE.domains,
      notify: () => send({ t: 'spool' }), log: (m) => log.warn(m),
    });
  } catch (e) { log.warn('analytics is off: ' + (e && e.message)); return; }
  const midnight = () => {
    const n = new Date();
    const next = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1, 0, 0, 1);
    const t = setTimeout(() => { try { capture.sweepSalt(); } catch { /* keep going */ } midnight(); }, Math.max(1000, next - Date.now()));
    if (t.unref) t.unref();
  };
  midnight();
}
const chunkLen = (c, enc) => (c == null || typeof c === 'function' ? 0 : typeof c === 'string' ? Buffer.byteLength(c, typeof enc === 'string' ? enc : 'utf8') : (c.length || 0));
// The record is written inside the wrapped end(), i.e. before the client can see the last byte.
function instrument(req, res, facts) {
  const t0 = Date.now();
  let bytes = 0, done = false;
  const finish = (aborted) => {
    if (done) return;
    done = true;
    if (aborted && !res.headersSent) return;
    try {
      capture.record(facts, { method: req.method, status: res.statusCode, ctype: String(res.getHeader('content-type') || ''), bytes: req.method === 'HEAD' ? 0 : bytes, ms: Date.now() - t0 });
    } catch { /* never break a request for a statistic */ }
  };
  const write = res.write, end = res.end;
  res.write = function (chunk, enc) { bytes += chunkLen(chunk, enc); return write.apply(this, arguments); };
  res.end = function (chunk, enc) { if (!done) { bytes += chunkLen(chunk, enc); finish(false); } return end.apply(this, arguments); };
  res.on('close', () => finish(true));
}

// ── static files ──────────────────────────────────────────────────────────
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.map': 'application/json',
  '.webmanifest': 'application/manifest+json', '.csv': 'text/csv; charset=utf-8',
};

function plain(res, status, text, extra) {
  if (res.headersSent) { res.destroy(); return true; }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', ...(extra || {}) });
  res.end(text);
  return true;
}

// site.static(dir?, opts?) -> async (req, res) => boolean (true = answered).
// dir defaults to the ACTIVE snapshot (read per request, so a publish or a
// rollback switches without a restart). Refuses "..", backslashes, NUL and
// any dot-segment (dotfiles); serves only what realpath() puts inside dir.
// opts: { maxAge (s, default 0), immutable, cacheControl, index ('index.html' | false), fallthrough }
function makeStatic(dirArg, opts = {}) {
  const index = opts.index === undefined ? 'index.html' : opts.index;
  const cacheControl = opts.cacheControl
    || `public, max-age=${Math.max(0, Math.floor(Number(opts.maxAge) || 0))}${opts.immutable ? ', immutable' : ''}`;
  const miss = (res) => (opts.fallthrough ? false : plain(res, 404, 'Not found'));
  return async function serveStatic(req, res) {
    const root = dirArg ? path.resolve(String(dirArg)) : site.content;
    if (!root) return miss(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return opts.fallthrough ? false : plain(res, 405, 'Method not allowed', { allow: 'GET, HEAD' });
    const rawPath = String(req.url || '/').split('?')[0].split('#')[0];
    let rel;
    try { rel = decodeURIComponent(rawPath); } catch { return plain(res, 400, 'Bad request'); }
    if (rel.includes('\0') || rel.includes('\\')) return plain(res, 400, 'Bad request');
    const segs = rel.split('/');
    if (segs.some(s => s === '..' || s === '.')) return plain(res, 403, 'Forbidden');
    if (segs.some(s => s.startsWith('.'))) return miss(res); // dotfiles and dot-directories are never served
    let realRoot, real, st;
    try {
      realRoot = await fs.promises.realpath(root);
      real = await fs.promises.realpath(path.join(realRoot, rel));
    } catch { return miss(res); }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return plain(res, 403, 'Forbidden');
    try { st = await fs.promises.stat(real); } catch { return miss(res); }
    if (st.isDirectory()) {
      if (!index) return miss(res);
      if (!rawPath.endsWith('/')) {
        // relative Location: stays correct behind a prefix (byte-proxy, nginx)
        const last = rawPath.split('/').filter(Boolean).pop() || '';
        const q = String(req.url || '').includes('?') ? '?' + String(req.url).split('?').slice(1).join('?') : '';
        res.writeHead(301, { location: `${encodeURIComponent(last)}/${q}` || './' });
        res.end();
        return true;
      }
      real = path.join(real, index);
      try { st = await fs.promises.stat(real); } catch { return miss(res); }
      if (!st.isFile()) return miss(res);
    } else if (!st.isFile()) return miss(res);

    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const lastModified = st.mtime.toUTCString();
    const headers = {
      'content-type': TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      etag,
      'last-modified': lastModified,
      'cache-control': cacheControl,
    };
    const inm = req.headers['if-none-match'];
    const ims = req.headers['if-modified-since'];
    if ((inm && inm.split(',').map(s => s.trim()).some(t => t === etag || t === '*' || t.replace(/^W\//, '') === etag.replace(/^W\//, '')))
        || (!inm && ims && Date.parse(ims) >= Math.floor(st.mtimeMs / 1000) * 1000)) {
      res.writeHead(304, { etag, 'last-modified': lastModified, 'cache-control': cacheControl });
      res.end();
      return true;
    }
    let start = 0, end = st.size - 1, status = 200;
    const range = req.headers.range;
    const ifRange = req.headers['if-range'];
    if (range && (!ifRange || ifRange === etag || ifRange === lastModified)) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (m && (m[1] !== '' || m[2] !== '')) {
        if (m[1] === '') { const n = Number(m[2]); start = Math.max(0, st.size - n); }
        else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), st.size - 1); }
        if (start > end || start >= st.size) {
          res.writeHead(416, { 'content-range': `bytes */${st.size}`, 'x-content-type-options': 'nosniff' });
          res.end();
          return true;
        }
        status = 206;
        headers['content-range'] = `bytes ${start}-${end}/${st.size}`;
      } // several ranges / malformed: the whole file
    }
    headers['content-length'] = String(st.size ? end - start + 1 : 0);
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || st.size === 0) { res.end(); return true; }
    await new Promise((resolve) => {
      const stream = fs.createReadStream(real, { start, end });
      stream.on('error', () => { res.destroy(); resolve(); });
      res.on('close', () => { stream.destroy(); resolve(); });
      stream.pipe(res);
    });
    return true;
  };
}

// ── site.call (platform: "controlled") ──────────────────────────────────
let callSeq = 0;
const pendingCalls = new Map();
function call(name, args, opts = {}) {
  if (SITE.platform !== 'controlled') {
    return Promise.reject(Object.assign(new Error(`site.call is off: this site's platform access is "${SITE.platform}" (set "platform": "controlled" in the manifest)`), { code: 'platform_none' }));
  }
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(name)) return Promise.reject(Object.assign(new Error('site.call: a call name is 1–64 of [A-Za-z0-9_.:-]'), { code: 'bad_name' }));
  let json;
  try { json = JSON.stringify(args === undefined ? null : args); } catch { return Promise.reject(Object.assign(new Error('site.call: args must be JSON'), { code: 'bad_args' })); }
  if (Buffer.byteLength(json) > CALL_ARGS_MAX) return Promise.reject(Object.assign(new Error(`site.call: args exceed ${CALL_ARGS_MAX / 1024} KB`), { code: 'too_large' }));
  const timeoutMs = Math.min(CALL_TIMEOUT_MAX, Math.max(100, Number(opts.timeoutMs) || CALL_TIMEOUT_MS));
  const id = ++callSeq;
  const ip = (als.getStore() || {}).ip || '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      reject(Object.assign(new Error(`site.call ${name}: timed out after ${timeoutMs} ms`), { code: 'timeout' }));
    }, timeoutMs);
    pendingCalls.set(id, { resolve, reject, timer });
    send({ t: 'call', id, name, json, ip, timeoutMs });
  });
}

// ── the site object ───────────────────────────────────────────────────────
const configListeners = new Set();
const site = {
  app: SITE.app,
  name: SITE.name,
  port: SITE.port,
  dataDir: SITE.dataDir,
  fenced,
  content: null,             // the active snapshot dir (null until the first publish)
  snapshot: null,            // its id
  config: {},                // live: replaced in place when the owner/app changes it
  static: makeStatic,
  call,
  log,
  // a custom event (a goal) into the analytics table; false when analytics is off or the name is bad
  track(name, props) {
    if (!capture) return false;
    const st = als.getStore();
    return capture.track(name, props, st && st.facts);
  },
  onConfig(fn) { if (typeof fn === 'function') configListeners.add(fn); return () => configListeners.delete(fn); },
};

function setConfig(cfg) {
  const next = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  for (const k of Object.keys(site.config)) delete site.config[k];
  Object.assign(site.config, next);
  for (const fn of configListeners) { try { fn(site.config); } catch (e) { log.error('onConfig listener:', e.message); } }
}

// ── server ────────────────────────────────────────────────────────────────
let handler = null;
let upgrade = null;
let reqTotal = 0, errTotal = 0;
const server = http.createServer((req, res) => {
  reqTotal++;
  const p = String(req.url || '/').split('?')[0];
  if (p === '/_vc/id') return plain(res, 200, SITE.idToken, { 'cache-control': 'no-store' });
  const ip = clientIp(req.socket.remoteAddress, req.headers);
  let facts = null;
  if (capture) { try { facts = capture.describe(req, ip); instrument(req, res, facts); } catch { facts = null; } }
  als.run({ ip, facts }, () => {
    Promise.resolve().then(() => handler(req, res)).catch((e) => {
      errTotal++;
      log.error(`handler error on ${req.method} ${p.slice(0, 200)}: ${e && e.message}`);
      if (!res.headersSent) plain(res, 500, 'Internal Server Error'); else res.destroy();
    });
  });
});
server.on('upgrade', (req, socket, head) => {
  if (!upgrade) { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
  const ip = clientIp(req.socket.remoteAddress, req.headers);
  als.run({ ip }, () => {
    Promise.resolve().then(() => upgrade(req, socket, head)).catch((e) => {
      log.error(`upgrade error on ${String(req.url || '').split('?')[0].slice(0, 200)}: ${e && e.message}`);
      socket.destroy();
    });
  });
});
server.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* gone */ } });

function fatal(code, message) {
  send({ t: 'fatal', code, message: String(message).slice(0, 1000) });
  setTimeout(() => process.exit(3), 50);
}

async function boot(init) {
  startCapture();
  setConfig(init.config);
  site.content = init.content || null;
  site.snapshot = init.snapshot || null;
  let created;
  try {
    const mod = require(SITE.handler);
    const createSite = typeof mod === 'function' ? mod : (mod && typeof mod.default === 'function' ? mod.default : null);
    if (!createSite) throw new Error(`${path.basename(SITE.handler)} must export function createSite(site)`);
    created = await createSite(site);
  } catch (e) {
    return fatal(e && e.code === 'ERR_ACCESS_DENIED' ? 'fenced' : 'handler', `the site handler failed to load: ${e && e.message}`);
  }
  if (typeof created === 'function') handler = created;
  else if (created && typeof created.request === 'function') {
    handler = created.request.bind(created);
    if (typeof created.upgrade === 'function') upgrade = created.upgrade.bind(created);
  } else return fatal('handler', 'createSite(site) must return async (req, res) => {} or { request, upgrade }');
  server.once('error', (e) => fatal(e.code || 'listen', e.message));
  server.listen(SITE.port, SITE.bind, () => {
    send({ t: 'ready', port: server.address().port, pid: process.pid, fenced, node: process.version });
  });
  setInterval(() => send({ t: 'stats', reqs: reqTotal, errs: errTotal, rss: process.memoryUsage().rss }), 2000).unref();
}

process.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'init') boot(m);
  else if (m.t === 'config') setConfig(m.config);
  else if (m.t === 'content') {
    site.content = m.dir || null;
    site.snapshot = m.id || null;
    send({ t: 'contentAck', id: m.id || null });
  } else if (m.t === 'callResult') {
    const p = pendingCalls.get(m.id);
    if (!p) return;
    pendingCalls.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result);
    else p.reject(Object.assign(new Error(m.error || 'site.call failed'), { code: m.code || 'failed' }));
  } else if (m.t === 'stop') {
    server.close(() => process.exit(0));
    try { server.closeIdleConnections(); } catch { /* old node */ }
    setTimeout(() => process.exit(0), 1500);
  }
});

process.on('uncaughtException', (e) => {
  log.error('uncaught:', e);
  setTimeout(() => process.exit(1), 20);
});
process.on('unhandledRejection', (e) => log.error('unhandled rejection:', e));

send({ t: 'hello', pid: process.pid, fenced });
