'use strict';
// The byte-proxy for hosts without nginx (docs/sites.md, "Byte-proxy"):
// /s/<app>/<site>/… on the dashboard → 127.0.0.1:<site port>, HTTP and
// WebSocket upgrades. Pass-through only: no app code runs in the dashboard.
// Only access=public sites that are running; anything else is a 404.
// The owner's cookies (sid / token) never reach the site, and a Set-Cookie for
// them from the site is dropped (as app-headers.js does under /apps).

const http = require('http');
const net = require('net');
const sites = require('./sites');
const { stripAuthCookies } = require('./app-headers');
const internalHeaders = require('./internal-headers');

const PATH_RE = /^\/s\/([a-z0-9][a-z0-9_-]{0,63})\/([a-z][a-z0-9-]{0,30})(\/.*)?$/;
// for the descriptor (core's auth-exempt lists): HTTP and upgrade
const EXEMPT_RE = /^\/s\/[a-z0-9][a-z0-9_-]{0,63}\/[a-z][a-z0-9-]{0,30}(\/|$)/;

const isLoopback = (a) => typeof a === 'string' && (a === '::1' || /^127\./.test(a) || /^::ffff:127\./i.test(a));
const unmap = (a) => (typeof a === 'string' ? a.replace(/^::ffff:/i, '') : '');
function clientIp(req) {
  const peer = req.socket?.remoteAddress;
  const p = unmap(peer);
  if (!isLoopback(peer)) return p;
  const h = req.headers;
  const real = typeof h['x-real-ip'] === 'string' ? unmap(h['x-real-ip'].trim()) : '';
  if (net.isIP(real)) return real;
  const xff = typeof h['x-forwarded-for'] === 'string' ? h['x-forwarded-for'].split(',').map(s => unmap(s.trim())).filter(Boolean) : [];
  return net.isIP(xff[xff.length - 1] || '') ? xff[xff.length - 1] : p;
}

// The owner's cookies out of a Cookie request header (string) → string | undefined.
function stripOwnerCookies(cookie) {
  if (typeof cookie !== 'string') return undefined;
  const kept = cookie.split(';').map(s => s.trim()).filter(Boolean).filter((c) => {
    const eq = c.indexOf('=');
    const name = (eq < 0 ? '' : c.slice(0, eq)).trim();
    return name !== 'sid' && name !== 'token' && name !== '';
  });
  return kept.length ? kept.join('; ') : undefined;
}

function forwardHeaders(req, prefix, authToken) {
  const h = { ...req.headers };
  internalHeaders.stripMap(h);
  const c = stripOwnerCookies(h.cookie);
  if (c === undefined) delete h.cookie; else h.cookie = c;
  if (authToken && typeof h.authorization === 'string' && h.authorization.trim() === `Bearer ${authToken}`) delete h.authorization;
  const ip = clientIp(req);
  h['x-real-ip'] = ip;
  h['x-forwarded-for'] = h['x-forwarded-for'] ? `${h['x-forwarded-for']}, ${ip}` : ip;
  h['x-forwarded-proto'] = h['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http');
  h['x-forwarded-host'] = h['x-forwarded-host'] || h.host || '';
  h['x-forwarded-prefix'] = prefix;
  return h;
}

function cleanResponseHeaders(raw) {
  const h = { ...raw };
  const k = stripAuthCookies(h['set-cookie']);
  if (k === undefined) delete h['set-cookie']; else h['set-cookie'] = k;
  return h;
}

function match(url) {
  let pathname;
  try { pathname = new URL(url, 'http://x').pathname; } catch { return null; }
  const m = PATH_RE.exec(pathname);
  if (!m) return null;
  const rest = String(url).slice(`/s/${m[1]}/${m[2]}`.length) || '';
  return { app: m[1], site: m[2], rest, prefix: `/s/${m[1]}/${m[2]}` };
}

// Express-style middleware for the add-on router (mounted at the root).
function middleware({ authToken } = {}) {
  return function sitesProxy(req, res, next) {
    const url = req.originalUrl || req.url;
    if (!String(url).startsWith('/s/')) return next();
    const m = match(url);
    if (!m) return next();
    const target = sites.proxyTarget(m.app, m.site);
    if (!target) { res.statusCode = 404; res.setHeader('content-type', 'text/plain; charset=utf-8'); return res.end('Not found'); }
    if (!m.rest) { res.statusCode = 301; res.setHeader('location', `${m.site}/`); return res.end(); }
    // Core's host-level json/urlencoded parsers may already have read the
    // body; their verify hook keeps the exact bytes on req.rawBody.
    const consumed = req._body === true || req.readableEnded;
    const headers = forwardHeaders(req, m.prefix, authToken);
    let raw = null;
    if (consumed) {
      raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0);
      delete headers['transfer-encoding'];
      headers['content-length'] = String(raw.length);
    }
    const up = http.request({
      host: '127.0.0.1', port: target.port, method: req.method, path: m.rest, headers,
    }, (pr) => {
      res.writeHead(pr.statusCode, pr.statusMessage, cleanResponseHeaders(pr.headers));
      pr.pipe(res);
    });
    up.on('information', (info) => {
      // 1xx: the same cookie rule (stripAuthCookies on early hints too)
      try { res.writeEarlyHints?.(cleanResponseHeaders(info.headers)); } catch { /* client gone */ }
    });
    up.on('error', () => {
      if (!res.headersSent) { res.statusCode = 502; res.setHeader('content-type', 'text/plain; charset=utf-8'); res.end('The site is not answering'); } else res.destroy();
    });
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    if (consumed) up.end(raw); else req.pipe(up);
  };
}

// WebSocket (any upgrade): raw bytes after a rewritten request head.
// Returns true when the request is ours (claimed), whatever the outcome.
function handleUpgrade(req, socket, head, { authToken } = {}) {
  const m = match(req.url || '');
  if (!m) return false;
  const reject = (s) => { try { socket.end(`HTTP/1.1 ${s}\r\nConnection: close\r\n\r\n`); } catch { /* gone */ } };
  const target = sites.proxyTarget(m.app, m.site);
  if (!target || !m.rest) { reject('404 Not Found'); return true; }
  const headers = forwardHeaders(req, m.prefix, authToken);
  const upstream = net.connect(target.port, '127.0.0.1', () => {
    let headText = `${req.method} ${m.rest} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      for (const one of Array.isArray(v) ? v : [v]) {
        if (one === undefined) continue;
        headText += `${k}: ${String(one).replace(/[\r\n]/g, ' ')}\r\n`;
      }
    }
    upstream.write(headText + '\r\n');
    if (head && head.length) upstream.write(head);
    // The response head passes through filtered (a Set-Cookie for sid / token
    // dropped), then raw bytes both ways.
    let buf = Buffer.alloc(0);
    const onHead = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) { if (buf.length > 32768) done(); return; }
      upstream.removeListener('data', onHead);
      const lines = buf.slice(0, end).toString('latin1').split('\r\n').filter((line, i) => {
        if (i === 0) return true;
        const mm = /^set-cookie:\s*(.*)$/i.exec(line);
        return !mm || stripAuthCookies(mm[1]) !== undefined;
      });
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      const restBuf = buf.slice(end + 4);
      if (restBuf.length) socket.write(restBuf);
      upstream.pipe(socket);
      socket.pipe(upstream);
    };
    upstream.on('data', onHead);
  });
  const done = () => { try { upstream.destroy(); } catch { /* */ } try { socket.destroy(); } catch { /* */ } };
  upstream.on('error', () => { if (!upstream.readyState || upstream.connecting) reject('502 Bad Gateway'); done(); });
  socket.on('error', done);
  upstream.on('close', done);
  socket.on('close', done);
  return true;
}

module.exports = { middleware, handleUpgrade, match, stripOwnerCookies, EXEMPT_RE };
