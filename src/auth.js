// Dashboard owner authentication — the single definition of "is this request
// the owner?" shared by the HTTP auth middleware, the WebSocket upgrade
// handler, the host-local internal endpoints, and the addon ctx
// (ctx.isOwnerRequest), so add-ons never re-implement the decision.
//
// Signals, in order:
//   1. loopback socket + x-vistaclair-internal header == AUTH_TOKEN (MCP tools,
//      hook reporter, app-runners)
//   2. a dashboard session (sid cookie; src/login.js — login links and
//      add-on-approved login challenges)
//   3. the static token (token cookie or Bearer), from any caller, local or
//      external (proxied)
// A cookie-authenticated mutating request must also pass the Origin check
// (see decide()); an upgrade's Origin check is originAllowed().

const crypto = require('crypto');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Compares fixed-length digests of the two byte strings, so a presented value
// of any length or encoding (equal char count, different byte count) is just
// "not equal" — never a throw — and the comparison time does not leak length.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const da = crypto.createHash('sha256').update(a, 'utf8').digest();
  const db = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(da, db);
}

function cookieValue(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

function getTokenFromCookies(cookieHeader) { return cookieValue(cookieHeader, 'token'); }
function getSidFromCookies(cookieHeader) { return cookieValue(cookieHeader, 'sid'); }

// Truly-local: loopback socket AND not forwarded by a local proxy. Since nginx,
// ngrok, and cloudflared all run on this host, the socket peer is always loopback;
// the X-Forwarded-For header is what distinguishes proxied external traffic.
function isLoopbackSocket(socket, req) {
  return LOOPBACK.has(socket?.remoteAddress) && !req?.headers?.['x-forwarded-for'];
}
function isLoopback(req) {
  return isLoopbackSocket(req.socket, req);
}

// Origin vs the host the request was addressed to. A browser sends Origin on
// every WebSocket upgrade and on cross-origin posts; cookies ignore ports, so
// a page on another localhost port is "same site" to the cookie but not to
// this check. The addressed host is the Host header; when the socket peer is
// loopback (nginx, ngrok and cloudflared all run on this host) the proxy's
// X-Forwarded-Host (first entry) is accepted too. No Origin header means a
// non-browser client: allowed. "null" and unparsable values are refused.
function addressedHosts(socket, req) {
  const hosts = [req.headers.host];
  if (LOOPBACK.has(socket?.remoteAddress)) {
    const xfh = req.headers['x-forwarded-host'];
    if (typeof xfh === 'string') hosts.push(xfh.split(',')[0].trim());
  }
  return hosts.filter(h => typeof h === 'string' && h);
}
function originAllowedFor(socket, req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  let u;
  try { u = new URL(origin); } catch { return false; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.host) return false;
  // Normalise the addressed host the way URL normalises the Origin (default
  // port dropped, lower case), with the Origin's own scheme.
  return addressedHosts(socket, req).some((h) => {
    try { return new URL(`${u.protocol}//${h}`).host === u.host; } catch { return false; }
  });
}
const originAllowed = (req, socket) => originAllowedFor(socket || req.socket, req);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function createAuth({ authToken, login, sessionTokens = null }) {
  function isInternalSocket(socket, req) {
    return isLoopbackSocket(socket, req) && safeEqual(req.headers['x-vistaclair-internal'], authToken);
  }
  function isInternal(req) {
    return isInternalSocket(req.socket, req);
  }

  function sessionFromReq(req) {
    return login.getSession(getSidFromCookies(req.headers.cookie));
  }

  function bearerOk(req) {
    const authHeader = req.headers.authorization;
    return typeof authHeader === 'string' && authHeader.startsWith('Bearer ') && safeEqual(authHeader.slice(7), authToken);
  }

  // How the request proves it is the owner: 'internal' (loopback header),
  // 'bearer', 'cookie' (sid or token cookie — a browser attaches these on its
  // own, which is what makes a forged cross-origin post possible), or null.
  // `socket` may be passed explicitly for upgrade requests, where req.socket
  // is not yet the peer socket.
  function ownerVia(socket, req) {
    if (isInternalSocket(socket, req)) return 'internal';
    if (bearerOk(req)) return 'bearer';
    if (sessionFromReq(req)) return 'cookie';
    if (safeEqual(getTokenFromCookies(req.headers.cookie), authToken)) return 'cookie';
    return null;
  }

  // The owner decision for an HTTP request: { ok, via, reason }. A request
  // accepted only because of a cookie must not be a mutating one that names
  // another origin (CSRF); Bearer / internal callers are not browsers' ambient
  // credentials, and a cookie request with no Origin is a non-browser client.
  function decide(socket, req) {
    const via = ownerVia(socket, req);
    if (!via) return { ok: false, via, reason: 'unauthorized' };
    if (via === 'cookie' && !SAFE_METHODS.has(req.method) && !originAllowedFor(socket, req)) {
      return { ok: false, via, reason: 'cross-origin' };
    }
    return { ok: true, via, reason: null };
  }
  function isOwnerRequest(req) {
    return decide(req.socket, req).ok;
  }
  // An upgrade is a GET: the Origin rule for it is separate (originAllowed,
  // applied by the upgrade handler for every upgrade that relies on this).
  function isOwnerUpgrade(req, socket) {
    return ownerVia(socket, req) !== null;
  }

  // The HTTP owner gate (mounted after the public routes): add-on-declared
  // public paths (e.g. OAuth callbacks — SameSite=Lax cookies aren't sent on
  // cross-site redirects, so these must bypass auth; declarative per-add-on
  // list, no product knowledge here), PWA metadata (the browser fetches the
  // manifest and its icons without cookies), the app-tool-call endpoint (its
  // own ephemeral per-session tokens), a session token (session-tokens.js), then
  // the owner decision.
  function gateMiddleware({ isAuthExempt, log = (line) => console.warn(line) }) {
    return (req, res, next) => {
      if (isAuthExempt(req.path)) return next();
      if (req.path === '/manifest.webmanifest' || /^\/(icon-\d+|apple-touch-icon)\.png$/.test(req.path)) return next();
      if (isLoopback(req) && req.path === '/api/app-tool-call') return next();
      // A session token (src/session-tokens.js): its endpoints only, bound to
      // its session, local callers only; never falls back to the owner decision.
      const s = sessionTokens?.check(req);
      if (s) {
        if (!s.ok) return res.status(s.status).json({ error: s.error });
        req.vcSession = s;
        return next();
      }
      const d = decide(req.socket, req);
      if (d.ok) return next();
      if (d.reason === 'cross-origin') {
        log(`  [auth] refused cross-origin cookie request ${req.method} ${req.path}: Origin ${String(req.headers.origin).slice(0, 100)} (addressed host ${String(req.headers.host).slice(0, 100)})`);
        return res.status(403).json({ error: 'Cross-origin request refused' });
      }
      // API routes get 401 JSON; browser routes get redirect
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
      res.redirect('/login');
    };
  }

  return {
    gateMiddleware,
    isLoopback, isLoopbackSocket, safeEqual, getTokenFromCookies, getSidFromCookies,
    isInternal, sessionFromReq, isOwnerRequest, isOwnerUpgrade, originAllowed, decide: (req) => decide(req.socket, req),
  };
}

module.exports = { createAuth, safeEqual, originAllowed, isLoopback, isLoopbackSocket, getTokenFromCookies, getSidFromCookies };
