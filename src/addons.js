// Add-on registry — the generic plugin surface for VistaClair.
//
// Core stays add-on-agnostic for every additive transport: HTTP routes, client
// assets, WebSocket upgrades, and auth-exempt paths all flow through here as a
// versioned descriptor returned by each add-on's init(core). The only thing the
// composition root (server.js) still knows by name is which add-on to *install
// and license* — that part is inherently product-specific.
//
// Descriptor shape (contractVersion CONTRACT_VERSION):
//   {
//     contractVersion, id, productSlug,
//     router,                 // express.Router mounted after auth
//     clientModules: [{ styles, scripts }],
//     authExemptPaths: [...],     // public route prefixes (e.g. OAuth callbacks)
//     authExemptPatterns: [...],  // public route RegExps (e.g. per-app telegram mini-app assets)
//     handleUpgrade(req, socket, head) -> bool,
//     pinnedSessions() -> iterable of sessId,  // optional; exempt from the
//                                              // interactions TTL sweep
//     shutdown(), update(),    // optional lifecycle hooks
//     _module,                 // raw module handle (licensing/lifecycle)
//   }

const CONTRACT_VERSION = 1;

const addons = [];

function registerAddon(descriptor) {
  if (!descriptor) return null;
  if (descriptor.contractVersion !== CONTRACT_VERSION) {
    console.error(`  Addon "${descriptor.id || '?'}": contract v${descriptor.contractVersion} != core v${CONTRACT_VERSION} — skipped`);
    return null;
  }
  addons.push(descriptor);
  return descriptor;
}

function removeAddon(id) {
  const i = addons.findIndex(a => a.id === id);
  if (i >= 0) addons.splice(i, 1);
}

// Concatenated client asset modules across all add-ons (order = registration).
function getClientModules() {
  return addons.flatMap(a => a.clientModules || []);
}

// True if a request path is declared public by any add-on. Matches the exact
// path or a path-segment prefix (p + '/...') — never a bare string prefix, so
// '/pro/auth/google/callback' can't be widened to '/pro/auth/google/callbackX'.
function isAuthExempt(reqPath) {
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

module.exports = {
  CONTRACT_VERSION,
  registerAddon,
  removeAddon,
  getClientModules,
  isAuthExempt,
  handleUpgrade,
  mountRouters,
  collectPinnedSessions,
  shutdownAll,
};
