// Per-session credentials for the processes a session starts (its hooks, its
// MCP servers, the scripts it runs), in place of the permanent owner token.
//
// A session token is random (`vcs_` + 256 bits), bound to ONE session
// (instanceId), held in memory only, and revoked when that session's process
// ends or is replaced. It opens only the endpoints below, and only from a
// truly-local caller (loopback socket, no X-Forwarded-For). It is never an
// owner credential: src/auth.js ownerVia() does not know it, so /login, the
// token / sid cookies, WebSocket upgrades, the session-driving routes of the
// dashboard (/api/cli/*, the orchestration GUI) and every other route refuse it.
//
// Header: `x-vistaclair-session`. The legacy owner-token header
// (`x-vistaclair-internal`) is also read when its value is a LIVE session token
// (an older script that keeps sending VISTACLAIR_AUTH_TOKEN there, e.g. Pro's
// scripts/app-change.js); a value that is not one stays an owner-token check.
//
// Scopes (what a session gets from its settings, scopesFor):
//   session       /api/hook-report, /api/ask, and the change-request routes of
//                 Pro's scripts/app-change.js
//   run           + the orchestration hook (a member of an orchestration run)
//   worker        + report / send-message / list-agents
//   orchestrator  + launch, cancel-launch, workers, end, undo-landing,
//                 resume-worker, close-worker, stop-worker, owner-items,
//                 tool-params, send-message, list-agents — handlers re-check
//                 the caller's role, and the bound instanceId limits it to its
//                 own run.

const crypto = require('crypto');

const HEADER = 'x-vistaclair-session';
const LEGACY_HEADER = 'x-vistaclair-internal';
const ENV_NAME = 'VISTACLAIR_SESSION_TOKEN';
const PREFIX = 'vcs_';

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const O = (name) => ({ method: 'POST', path: `/api/orchestration/${name}` });

// [scope, method, exact path | RegExp]. Exact and case-sensitive on req.path:
// Express routes case-insensitively and with an optional trailing slash, so a
// variant simply gets no session access.
const CR = /^\/pro\/apps\/change-requests\/[^/]+(?:\/(?:done|cancel|wait))?$/;
const ENDPOINTS = [
  ['session', 'POST', '/api/hook-report'],
  ['session', 'POST', '/api/ask'],
  ['session', 'POST', '/pro/apps/change-requests'],
  ['session', 'GET', CR],
  ['session', 'POST', CR],
  ['session', 'POST', '/pro/apps/deps/depend'],
  ['run', 'POST', '/api/orchestration/hook'],
  ['run', 'POST', '/api/orchestration/agy-hook'],
  ...['report', 'send-message', 'list-agents'].map(n => ['worker', O(n).method, O(n).path]),
  ...['launch', 'cancel-launch', 'workers', 'end', 'undo-landing', 'resume-worker', 'close-worker', 'stop-worker',
    'owner-items', 'tool-params', 'send-message', 'list-agents'].map(n => ['orchestrator', O(n).method, O(n).path]),
];

function scopesFor(settings) {
  const scopes = ['session'];
  const role = settings?.orchestration?.role;
  if (role === 'worker' || role === 'orchestrator') scopes.push('run', role);
  return scopes;
}

function createSessionTokens() {
  const live = new Map(); // sha256(token) -> { instanceId, scopes:Set }

  // → the token (a second mint for the same instance replaces the first).
  function mint(instanceId, { scopes = ['session'] } = {}) {
    if (typeof instanceId !== 'string' || !instanceId) throw new TypeError('session token needs an instanceId');
    revokeInstance(instanceId);
    const token = PREFIX + crypto.randomBytes(32).toString('base64url');
    live.set(hash(token), { instanceId, scopes: new Set(scopes) });
    return token;
  }
  function revoke(token) {
    if (typeof token === 'string' && token) live.delete(hash(token));
  }
  function revokeInstance(instanceId) {
    for (const [k, v] of live) if (v.instanceId === instanceId) live.delete(k);
  }
  const lookup = (token) => (typeof token === 'string' && token.startsWith(PREFIX) ? live.get(hash(token)) || null : null);

  // The presented token of a request, when it is a live session token.
  function presented(req) {
    for (const name of [HEADER, LEGACY_HEADER]) {
      const v = req.headers[name];
      if (typeof v === 'string' && lookup(v)) return v;
    }
    // A user-edited copy of the ask tool still sends it as the body `token`.
    const b = req.body && typeof req.body === 'object' ? req.body.token : undefined;
    return typeof b === 'string' && lookup(b) ? b : null;
  }
  function allowed(entry, method, path) {
    return ENDPOINTS.some(([scope, m, p]) => entry.scopes.has(scope) && m === method
      && (typeof p === 'string' ? p === path : p.test(path)));
  }

  // Local caller only: a loopback socket not forwarded by a local proxy (the
  // public tunnel adds X-Forwarded-For, so it never carries a session token).
  const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress) && !req.headers['x-forwarded-for'];

  // → null (no session credential: the caller decides as before), or
  // { ok: false, status, error } or { ok: true, instanceId, scopes }.
  function check(req) {
    const token = presented(req);
    if (!token) return null;
    if (!isLocal(req)) return { ok: false, status: 401, error: 'Unauthorized' };
    const entry = lookup(token);
    if (!entry || !allowed(entry, req.method, req.path)) return { ok: false, status: 401, error: 'Unauthorized' };
    // Bound: the request may only name its own session.
    for (const named of [req.body && typeof req.body === 'object' ? req.body.instanceId : undefined, req.query?.instanceId]) {
      if (named !== undefined && named !== null && named !== entry.instanceId) {
        return { ok: false, status: 403, error: 'Session token is bound to another session' };
      }
    }
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) req.body.instanceId = entry.instanceId;
    return { ok: true, instanceId: entry.instanceId, scopes: [...entry.scopes] };
  }

  // Middleware for a route that sits before the owner gate: a session token
  // for this endpoint, else the ordinary owner decision (`decide`).
  function acceptOrOwner(decide) {
    return (req, res, next) => {
      const r = check(req);
      if (r) {
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        req.vcSession = r;
        return next();
      }
      const d = decide(req);
      if (d.ok) return next();
      return res.status(d.reason === 'cross-origin' ? 403 : 401).end();
    };
  }

  return { mint, revoke, revokeInstance, check, acceptOrOwner, scopesFor };
}

// The server's one registry: sessions mint into it, the gate checks it.
const shared = createSessionTokens();

module.exports = { shared, createSessionTokens, scopesFor, HEADER, LEGACY_HEADER, ENV_NAME, PREFIX, ENDPOINTS };
