// Add-on registry — the generic plugin surface for VistaClair.
//
// Core stays add-on-agnostic for every additive transport: HTTP routes, client
// assets, WebSocket upgrades, and auth-exempt paths all flow through here as a
// versioned descriptor returned by each add-on's init(core). The only thing the
// composition root (server.js) knows by name is the add-on it loads: ./platform.
//
// Descriptor shape:
//   {
//     id,
//     router,                 // express.Router mounted after auth
//     clientModules: [{ styles, scripts }],
//     cspReady: true,         // optional; the client modules run under the
//                             // dashboard CSP (no inline handlers, no eval).
//                             // Until then the policy is report-only (src/csp.js).
//     authExemptPaths: [...],     // public route prefixes (e.g. OAuth callbacks)
//     authExemptPatterns: [...],  // public route RegExps (e.g. per-app public assets)
//     handleUpgrade(req, socket, head) -> bool,
//     authExemptUpgradePaths: [...],  // optional; EXACT pathnames (query ignored,
//                             // no prefix match) whose WS upgrades skip the
//                             // owner gate and go to this add-on's handleUpgrade
//                             // only — it must authenticate them itself (e.g.
//                             // Pro's '/api/peer/channel' peer token). Falsy
//                             // return or throw → 401; never reaches the dashboard.
//     pinnedSessions() -> iterable of sessId,  // optional; exempt from the
//                                              // interactions TTL sweep
//     toolPacks: [pack, ...],  // optional; MCP servers / tool restrictions /
//                              // prompt text for sessions (src/tool-packs.js).
//                              // Registered with the add-on, dropped by removeAddon.
//     shutdown(),              // optional lifecycle hook
//     _module,                 // raw module handle
//   }
//
// Fields are additive: an add-on that omits one is unaffected, and one that
// wants a ctx field feature-detects it (`typeof ctx.registerToolPack === 'function'`).

const toolPacks = require('./tool-packs');
const { originAllowed: defaultOriginAllowed } = require('./auth');

const addons = [];

function registerAddon(descriptor) {
  if (!descriptor) return null;
  addons.push(descriptor);
  // A malformed pack is skipped, never the add-on.
  for (const pack of Array.isArray(descriptor.toolPacks) ? descriptor.toolPacks : []) {
    try { toolPacks.registerToolPack(pack, { owner: descriptor.id }); } catch (e) {
      console.error(`  Addon "${descriptor.id || '?'}" tool pack rejected:`, e.message);
    }
  }
  return descriptor;
}

function removeAddon(id) {
  const i = addons.findIndex(a => a.id === id);
  if (i >= 0) addons.splice(i, 1);
  toolPacks.unregisterToolPacksOf(id);
}

// Concatenated client asset modules across all add-ons (order = registration).
function getClientModules() {
  return addons.flatMap(a => a.clientModules || []);
}

// Ids of add-ons whose client modules run in the dashboard page but are not
// declared cspReady; while any is loaded the dashboard CSP is report-only.
function cspBlockers() {
  return addons.filter(a => (a.clientModules || []).length && a.cspReady !== true).map(a => a.id);
}

// True if a request path is declared public by any add-on. Matches the exact
// path or a path-segment prefix (p + '/...') — never a bare string prefix, so
// '/pro/auth/google/callback' can't be widened to '/pro/auth/google/callbackX'.
//
// A path with an empty, "." or ".." segment (raw or percent-encoded, any case)
// is never exempt: the match here is on the raw path while express.static
// normalises it, so '/pro/tg-session/../../index.html' would otherwise walk
// out of the exempt prefix. One trailing slash is allowed (an app root such
// as '/apps/<name>/' is a legitimate public path and cannot walk anywhere).
function hasDotSegment(reqPath) {
  if (typeof reqPath !== 'string') return true;
  const segs = reqPath.split('/');
  if (segs[0] === '') segs.shift();
  for (let i = 0; i < segs.length; i++) {
    let seg;
    try { seg = decodeURIComponent(segs[i]); } catch { return true; }
    if (seg === '.' || seg === '..' || /[\\/]/.test(seg)) return true;
    if (seg === '' && i !== segs.length - 1) return true;
  }
  return false;
}

function isAuthExempt(reqPath) {
  if (hasDotSegment(reqPath)) return false;
  for (const a of addons) {
    for (const p of a.authExemptPaths || []) {
      if (reqPath === p || reqPath.startsWith(p + '/')) return true;
    }
    for (const rx of a.authExemptPatterns || []) {
      try { if (rx.test(reqPath)) return true; } catch {}
    }
  }
  return false;
}

// Offer a WS upgrade to each add-on; first to claim it wins.
function handleUpgrade(req, socket, head) {
  for (const a of addons) {
    if (!a.handleUpgrade) continue;
    try {
      if (a.handleUpgrade(req, socket, head)) return true;
    } catch (e) {
      console.error(`  Addon "${a.id}" handleUpgrade error:`, e.message);
    }
  }
  return false;
}

// The add-on that declared this upgrade's exact pathname in
// authExemptUpgradePaths (first registered wins), or null. A malformed URL is
// never exempt.
function exemptUpgradeOwner(req) {
  let pathname;
  try { pathname = new URL(req.url, 'http://x').pathname; } catch { return null; }
  for (const a of addons) {
    const paths = a.authExemptUpgradePaths;
    if (Array.isArray(paths) && paths.includes(pathname)) return a;
  }
  return null;
}

function rejectUpgrade(socket, status = '401 Unauthorized') {
  try { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); } catch {}
  socket.destroy();
}

// The dashboard server's 'upgrade' listener. An auth-exempt upgrade path goes
// to the add-on that declared it and nowhere else (no owner gate; that add-on
// authenticates it). Everything else: owner gate → add-ons → dashboard wss.
//
// An upgrade that relies on the owner gate also passes the Origin check: a
// browser always sends Origin on a WebSocket, and it must name the host the
// request was addressed to (src/auth.js originAllowed). No Origin = a
// non-browser client (MCP tools, node clients): allowed. Any error → the
// socket is destroyed, never left hanging.
function createUpgradeHandler({ isOwnerUpgrade, wss, originAllowed = defaultOriginAllowed }) {
  return (req, socket, head) => {
    try {
      socket.on('error', () => { try { socket.destroy(); } catch {} });
      handle(req, socket, head);
    } catch (e) {
      console.error('  WebSocket upgrade error:', e.message);
      rejectUpgrade(socket, '500 Internal Server Error');
    }
  };

  function handle(req, socket, head) {
    const owner = exemptUpgradeOwner(req);
    if (owner) {
      let claimed = false;
      try {
        claimed = typeof owner.handleUpgrade === 'function' && !!owner.handleUpgrade(req, socket, head);
      } catch (e) {
        console.error(`  Addon "${owner.id}" handleUpgrade error:`, e.message);
      }
      if (!claimed) rejectUpgrade(socket);
      return;
    }

    // Same owner decision as the HTTP middleware, against the upgrade socket.
    if (!isOwnerUpgrade(req, socket)) return rejectUpgrade(socket);
    if (!originAllowed(req, socket)) {
      console.warn(`  [auth] refused WebSocket upgrade ${String(req.url).split('?')[0]}: foreign Origin ${String(req.headers.origin).slice(0, 100)} (addressed host ${String(req.headers.host).slice(0, 100)})`);
      return rejectUpgrade(socket, '403 Forbidden');
    }

    // Offer the upgrade to add-ons (e.g. Pro's VNC websockify proxy) first.
    if (handleUpgrade(req, socket, head)) return;

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }
}

// Mount every add-on's router on the host app (call after the auth middleware).
function mountRouters(app) {
  for (const a of addons) {
    if (a.router) app.use(a.router);
  }
}

function shutdownAll() {
  for (const a of addons) {
    try { a.shutdown?.(); } catch {}
  }
}

// Claude session ids each add-on still needs, unioned. The interactions sweep
// treats these as pinned, so an add-on can keep the inspector timeline of a
// headless run it still references. Optional hook — an add-on that doesn't
// implement it simply pins nothing.
function collectPinnedSessions() {
  const pinned = new Set();
  for (const a of addons) {
    let ids;
    try { ids = a.pinnedSessions?.(); } catch (e) {
      console.error(`  Addon "${a.id}" pinnedSessions error:`, e.message);
      continue;
    }
    if (!ids) continue;
    for (const id of ids) if (typeof id === 'string' && id) pinned.add(id);
  }
  return pinned;
}

// The platform's artifact store and tool calls, as an add-on offers them
// (descriptor.platformTools, optional): { putArtifact(buffer, {mime, name}) →
// Promise<{uri}>, call(tool, args) → Promise<MCP result> }. The first add-on
// that has both wins; null when none does (core alone, or an older Pro).
function platformTools() {
  for (const a of addons) {
    const t = a.platformTools;
    if (t && typeof t.putArtifact === 'function' && typeof t.call === 'function') return t;
  }
  return null;
}

module.exports = {
  platformTools,
  registerAddon,
  removeAddon,
  getClientModules,
  cspBlockers,
  isAuthExempt,
  handleUpgrade,
  exemptUpgradeOwner,
  createUpgradeHandler,
  mountRouters,
  collectPinnedSessions,
  shutdownAll,
};
