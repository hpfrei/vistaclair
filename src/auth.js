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

const crypto = require('crypto');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
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

function createAuth({ authToken, login }) {
  function isInternalSocket(socket, req) {
    return isLoopbackSocket(socket, req) && safeEqual(req.headers['x-vistaclair-internal'], authToken);
  }
  function isInternal(req) {
    return isInternalSocket(req.socket, req);
  }

  function sessionFromReq(req) {
    return login.getSession(getSidFromCookies(req.headers.cookie));
  }

  function staticTokenOk(req) {
    if (safeEqual(getTokenFromCookies(req.headers.cookie), authToken)) return true;
    const authHeader = req.headers.authorization;
    return typeof authHeader === 'string' && authHeader.startsWith('Bearer ') && safeEqual(authHeader.slice(7), authToken);
  }

  // The owner decision for an HTTP request. `socket` may be passed explicitly
  // for upgrade requests, where req.socket is not yet the peer socket.
  function isOwnerSocket(socket, req) {
    if (isInternalSocket(socket, req)) return true;
    if (sessionFromReq(req)) return true;
    return staticTokenOk(req);
  }
  function isOwnerRequest(req) {
    return isOwnerSocket(req.socket, req);
  }
  function isOwnerUpgrade(req, socket) {
    return isOwnerSocket(socket, req);
  }

  return {
    isLoopback, isLoopbackSocket, safeEqual, getTokenFromCookies, getSidFromCookies,
    isInternal, sessionFromReq, isOwnerRequest, isOwnerUpgrade,
  };
}

module.exports = { createAuth, safeEqual, isLoopback, isLoopbackSocket, getTokenFromCookies, getSidFromCookies };
