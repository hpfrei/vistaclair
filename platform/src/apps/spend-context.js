// Spend attribution context — WHO is spending and FROM WHERE, inherited by
// every platform call made underneath an entry point, with no cooperation
// from app code.
//
// Every entry into app code (a route, a job, a bot update, a tool call, a
// bridge call, a cron tick) runs inside `run({ app, origin, principal })`.
// AsyncLocalStorage carries that record through the app's own awaits, so a
// ctx.transcribe() three promises deep still knows it was a route call by
// account 42. Apps that never pass a meterKey get per-user attribution for
// free; apps that never authenticate land in the app-wide bucket ('_app'),
// which is exactly the "unattributed" bucket the admin's policy governs.
//
// Principal strings:
//   'owner'         the dashboard admin (cookie / internal header)
//   'acct:<id>'     an app-auth account row (turnkey multi-user auth)
//   'user:<id>'     an app-identity session / Telegram initData identity
//   'tg:<id>'       a Telegram chat id (bot updates)
//   'wa:<id>'       a WhatsApp id (bot updates)
//   'meter:<key>'   an explicit meterKey passed by the app (legacy attribution)
//   null            unattributed
//
// Principal resolution for routes is LAZY (memoised on first use): most
// requests never spend, and resolving may verify a session token.
//
// `subscribed` rides in the same context, resolved AT THE EDGE (never by app
// code): the owner counts as subscribed, an app-auth account is subscribed
// while its licence entitlement cache says a paid tier is active
// (app-license.subscribedFromCache — sync, cache-only), anonymous traffic
// never is. Nested runs inherit it like every other field.
//
// The instance map ties an aiPrompt session (its proxy instanceId) back to
// the context it was started in, so the LLM cost settled from the proxy's
// interaction:complete broadcast lands on the right principal.
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
const instances = new Map(); // instanceId → { app, principal, origin, meterKey, startedAt }

let ownerCheck = () => false;

function init(options = {}) {
  if (typeof options.isOwnerRequest === 'function') ownerCheck = options.isOwnerRequest;
}

// Run fn inside a (possibly nested) spend context. Nested runs inherit the
// parent's fields and override the ones given — a job started from a route
// keeps the route's principal but reports origin 'job'.
function run(fields, fn) {
  const parent = als.getStore() || {};
  const store = { ...parent, ...fields };
  return als.run(store, fn);
}

function current() {
  return als.getStore() || null;
}

// Effective principal of the current context (memoised lazy resolution).
function principal() {
  const s = als.getStore();
  if (!s) return null;
  if (s.principal !== undefined) return s.principal;
  if (typeof s.resolvePrincipal === 'function') {
    try { s.principal = s.resolvePrincipal() || null; } catch { s.principal = null; }
    return s.principal;
  }
  return null;
}

// Effective subscriber flag of the current context (memoised lazy resolution,
// same pattern as principal()). Outside any context: false.
function subscribed() {
  const s = als.getStore();
  if (!s) return false;
  if (s.subscribed !== undefined) return (s.subscribed = !!s.subscribed);
  if (typeof s.resolveSubscribed === 'function') {
    try { s.subscribed = !!s.resolveSubscribed(); } catch { s.subscribed = false; }
    return s.subscribed;
  }
  s.subscribed = subscribedFromPrincipal(s.app, principal());
  return s.subscribed;
}

// owner → true; an app-auth account or platform identity session → the licence
// entitlement cache; everything else (bots, meter keys, anonymous) → false.
function subscribedFromPrincipal(appName, p) {
  if (p === 'owner') return true;
  const m = /^(?:acct|user):(.+)$/.exec(String(p || ''));
  if (!m || !appName) return false;
  try { return require('./app-license').subscribedFromCache(appName, m[1]); } catch { return false; }
}

function origin() {
  const s = als.getStore();
  return (s && s.origin) || null;
}

function app() {
  const s = als.getStore();
  return (s && s.app) || null;
}

// The tool caller a call runs under (app-tools callerRecord: { type,
// appName, runId?, address?, … }), or null outside a tool call.
function caller() {
  const s = als.getStore();
  return (s && s.caller) || null;
}

// Is the current call being made on behalf of an app's USER rather than the
// platform owner?
//
// `acct:` is an app-auth account and `user:` a platform identity session — both
// are people the app let in. 'owner', 'platform' and null (internal work: sync,
// cron, a sweep) are not. Guardrails that are about WHO is asking rather than
// what they asked for use this, so the distinction is made once: spend-gate's
// audience rule only fires on metered methods, and most destructive platform
// acts are free.
function isUserFacing() {
  const p = principal();
  return typeof p === 'string' && /^(acct|user):/.test(p);
}

// Principal of an HTTP request into an app: app-auth account, owner, a
// platform identity session (Bearer / ?token=), or Telegram initData.
function principalFromRequest(appName, req) {
  if (!req) return null;
  if (req.account && req.account.id != null) return `acct:${req.account.id}`;
  if (req.appUser && req.appUser.id != null) return `acct:${req.appUser.id}`;
  try { if (ownerCheck(req)) return 'owner'; } catch {}
  const h = String((req.headers && req.headers.authorization) || '');
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : (req.query && req.query.token) || null;
  const initData = (req.headers && req.headers['x-telegram-init-data']) || (req.query && req.query.initData) || null;
  if (bearer || initData) {
    try {
      const r = require('./app-identity').resolve(appName, { initData, bearer });
      if (r && r.userId != null) return `user:${r.userId}`;
    } catch {}
  }
  return null;
}

// Subscriber flag of an HTTP request into an app: the owner (dashboard cookie
// or an is_owner app-auth account) is always subscribed; accounts consult the
// licence cache via their principal.
function subscribedFromRequest(appName, req) {
  if (!req) return false;
  const acct = req.account || req.appUser;
  if (acct && (acct.is_owner || acct.isOwner)) return true;
  return subscribedFromPrincipal(appName, principalFromRequest(appName, req));
}

// Express middleware: every handler of this app's router runs inside a route
// context. Principal and subscriber flag resolve lazily from the request on
// first spend.
function middleware(appName) {
  return (req, res, next) => {
    const ctx = {
      app: appName,
      origin: 'route',
      // `METHOD /path` (no query): the fleet remote origin names it.
      route: `${req.method} ${String(req.originalUrl || req.url || '').split('?')[0]}`.slice(0, 200),
      principal: undefined,
      resolvePrincipal: () => principalFromRequest(appName, req),
      resolveSubscribed: () => subscribedFromRequest(appName, req),
    };
    // Kept on the request too: body parsing (express.json) hands control back
    // from a socket read whose async context predates this run(), so the
    // store can be gone by the time the handler executes. app-manager's
    // wrapHandler re-enters it with bind() right before app code runs.
    req.__spendCtx = ctx;
    return als.run(ctx, () => next());
  };
}

// Re-enter the request's spend context (same object, memoised principal kept).
function bind(req, fn) {
  const ctx = req && req.__spendCtx;
  return ctx ? als.run(ctx, fn) : fn();
}

// --- aiPrompt instance registry ----------------------------------------------

function registerInstance(instanceId, info) {
  instances.set(instanceId, { startedAt: Date.now(), ...info });
}
function instanceInfo(instanceId) {
  return instances.get(instanceId) || null;
}
function unregisterInstance(instanceId) {
  instances.delete(instanceId);
}

// App name from an aiPrompt instanceId (`app-<name>-ai-<hex>`), for sessions
// whose registration lives in another process (own-process runners).
function appFromInstanceId(instanceId) {
  const m = /^app-(.+)-ai-[a-f0-9]+$/.exec(String(instanceId || ''));
  return m ? m[1] : null;
}

module.exports = {
  init, run, current, principal, subscribed, origin, app, caller, isUserFacing,
  principalFromRequest, subscribedFromRequest, middleware, bind,
  registerInstance, instanceInfo, unregisterInstance, appFromInstanceId,
};
