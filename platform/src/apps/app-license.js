// App licensing — the platform side of manifest `auth.license`.
//
// Licences are MASTERED on the external licence server (hpfrei-licencing,
// base URL in platform-settings `licenseServerUrl`). The
// platform persists exactly ONE thing per account: the claimed key
// (`accounts.license_key`, column owned by app-auth.js). Status, tier and
// expiry are never stored — they come from the server's public POST
// /api/validate and live in an in-memory cache (stale-while-revalidate), so a
// revocation or renewal reaches a running app within `licenseCacheTtlMinutes`
// of the user's next request, with no cron sweep and no duplicate state.
//
// Seat model: the server's machine activations double as account seats. The
// server treats machineId as an opaque string, so one seat is
// `machineId vc:<app>:acct:<id>` — deterministic, re-derivable, nothing extra
// stored. `machine_limit` on a licence therefore means "max accounts per key
// per app" (0 = unlimited, no activation rows at all). Activation is
// transactional and idempotent server-side; DEACTIVATION IS BEST-EFFORT (the
// server rate-limits /api/deactivate per IP and the whole platform shares
// one), so local key clearing never depends on it.
//
// Only PUBLIC server endpoints are used — no admin credential ever enters the
// platform. Validate responses carry an Ed25519 `signedFields`/`signature`
// pair; pinning the server's public key is a future hardening hook (the
// server is first-party over HTTPS), not done here.
//
// Nothing here runs at app mount time except pure parsing (`parseManifest`) —
// a licence-server outage must never break an app mount.

const DEFAULT_TIMEOUT_MS = 10_000; // background / claim calls
const GATE_TIMEOUT_MS = 4_000;     // blocking validate inside a request (cold cache)
const NEGATIVE_TTL_MS = 5 * 60 * 1000;  // invalid/grace entries re-check quickly
const PRODUCT_TTL_MS = 60 * 60 * 1000;  // checkout/variant info
const CACHE_MAX = 10_000;

// ---- HTTP client (public endpoints only) ------------------------------------
// Every function takes opts {baseUrl, timeoutMs} so a standalone script can
// exercise the client without initializing the platform.

function baseUrl(opts) {
  const url = (opts && opts.baseUrl) || require('./platform-settings').get('licenseServerUrl') || '';
  return String(url).replace(/\/+$/, '');
}

// The server signals licence problems in-body ({valid:false, error}) with 2xx/4xx.
// Only transport failure, timeout, 5xx or non-JSON throw — tagged err.network,
// the "unreachable ≠ invalid" boundary everything else builds on.
async function api(method, path, body, opts = {}) {
  let res;
  try {
    res = await fetch(baseUrl(opts) + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs || DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const e = new Error(`licence server unreachable: ${err.message}`);
    e.network = true;
    throw e;
  }
  if (res.status >= 500) {
    const e = new Error(`licence server error (HTTP ${res.status})`);
    e.network = true;
    throw e;
  }
  const json = await res.json().catch(() => null);
  if (!json || typeof json !== 'object') {
    const e = new Error('licence server returned non-JSON');
    e.network = true;
    throw e;
  }
  return json;
}

const validateKey = ({ key, product, machineId }, opts) =>
  api('POST', '/api/validate', { key, product, ...(machineId ? { machineId } : {}) }, opts);
const activateSeat = ({ key, product, machineId, hostname, username }, opts) =>
  api('POST', '/api/activate', { key, product, machineId, hostname, username }, opts);
const deactivateSeat = ({ key, machineId, hostname, username }, opts) =>
  api('POST', '/api/deactivate', { key, machineId, hostname, username }, opts);

// ---- product / checkout info (cached) ---------------------------------------

const productCache = new Map(); // 'info:<slug>' | 'group:<pattern>' -> {at, data}

async function productInfo(slug, opts) {
  const ck = 'info:' + slug;
  const hit = productCache.get(ck);
  if (hit && Date.now() - hit.at < PRODUCT_TTL_MS) return hit.data;
  try {
    const json = await api('GET', `/api/product/${encodeURIComponent(slug)}/info`, null, opts);
    const data = json && json.slug ? json : null;
    productCache.set(ck, { at: Date.now(), data });
    return data;
  } catch { return hit ? hit.data : null; }
}

async function productGroup(pattern, opts) {
  const ck = 'group:' + pattern;
  const hit = productCache.get(ck);
  if (hit && Date.now() - hit.at < PRODUCT_TTL_MS) return hit.data;
  try {
    const json = await api('GET', `/api/product/group/${encodeURIComponent(pattern)}`, null, opts);
    const data = Array.isArray(json && json.variants) ? json.variants : [];
    productCache.set(ck, { at: Date.now(), data });
    return data;
  } catch { return hit ? hit.data : []; }
}

// Live lookup (used from error responses where we already went to the network).
async function checkoutUrl(cfg, opts) {
  const info = await productInfo(cfg.product, opts);
  if (info && info.checkoutUrl) return info.checkoutUrl;
  const variants = await productGroup(cfg.product, opts);
  const v = (variants || []).find((x) => x.checkoutUrl);
  return v ? v.checkoutUrl : null;
}

// Cache-only lookup for the request path (a licence-server outage must not add
// latency to every 402).
function checkoutFromCache(cfg) {
  const i = productCache.get('info:' + cfg.product);
  if (i && i.data && i.data.checkoutUrl) return i.data.checkoutUrl;
  const g = productCache.get('group:' + cfg.product);
  const v = g && Array.isArray(g.data) ? g.data.find((x) => x.checkoutUrl) : null;
  return v ? v.checkoutUrl : null;
}

// ---- manifest / identity / entitlement (pure) -------------------------------

// auth.license = 'buddy'  (any valid family key = licensed, features {})
//             OR { product, tiers: {'<slug>': {..features}}, free: {..features}, graceHours }
// `free` makes the app freemium: unlicensed accounts PASS the gate with those
// features, and licence problems degrade to them instead of a 402.
function parseManifest(field) {
  if (!field) return null;
  const grace = () => {
    const h = Number(require('./platform-settings').get('licenseGraceHours'));
    return h > 0 ? h : 72;
  };
  if (typeof field === 'string') {
    const product = field.trim();
    return product ? { product, tiers: null, free: null, graceHours: grace() } : null;
  }
  if (typeof field !== 'object') return null;
  const product = String(field.product || '').trim();
  if (!product) return null;
  return {
    product,
    tiers: field.tiers && typeof field.tiers === 'object' ? field.tiers : null,
    free: field.free && typeof field.free === 'object' ? field.free : null,
    graceHours: Number(field.graceHours) > 0 ? Number(field.graceHours) : grace(),
  };
}

function seatIdentity(appName, accountId) {
  return {
    machineId: `vc:${appName}:acct:${accountId}`,
    hostname: `vc:${appName}`,
    username: `acct:${accountId}`,
  };
}

// The validate response's product.slug names the tier the key belongs to.
// Tier keys may be written short ('pro' for 'roblox-buddy-pro') — the server
// itself matches products by suffix, so mirror that here.
function resolveTier(cfg, productSlug) {
  const slug = String(productSlug || cfg.product);
  if (!cfg.tiers) return { tier: slug, features: {} };
  if (cfg.tiers[slug]) return { tier: slug, features: cfg.tiers[slug] };
  for (const k of Object.keys(cfg.tiers)) {
    if (slug.endsWith('-' + k)) return { tier: slug, features: cfg.tiers[k] };
  }
  return { tier: slug, features: {} };
}

// The platform owner's account (is_owner=1, see app-auth) is always entitled
// on their own installation — never sent to the licence server. Features =
// every declared tier merged in declaration order (later tiers win), so the
// admin sees the full app.
function ownerEntitlement(cfg) {
  const features = cfg.tiers ? Object.assign({}, ...Object.values(cfg.tiers)) : {};
  return { licensed: true, status: 'owner', tier: 'owner', features, expiresAt: null };
}

function freeEntitlement(cfg) {
  return cfg.free
    ? { licensed: false, status: 'free', tier: 'free', features: cfg.free, expiresAt: null }
    : { licensed: false, status: 'none', tier: null, features: null, expiresAt: null };
}

function invalidEntitlement(cfg, error) {
  return { ...freeEntitlement(cfg), status: cfg.free ? 'free' : 'invalid', keyError: error || 'invalid' };
}

// resp = a `valid: true` validate OR activate response (both carry license+product).
function activeEntitlement(cfg, resp) {
  const { tier, features } = resolveTier(cfg, resp.product && resp.product.slug);
  return {
    licensed: true,
    status: 'active',
    tier,
    features,
    expiresAt: (resp.license && resp.license.expiresAt) || null,
    customerPortalUrl: resp.customerPortalUrl || null,
  };
}

// ---- entitlement cache (stale-while-revalidate) -----------------------------
// The dashboard is single-process; this Map is the only licensing state beyond
// accounts.license_key. Entry: { ent, freshUntil, lastGoodAt, inflight }.

const entCache = new Map(); // '<app>:<acctId>' -> entry

function cacheTtlMs() {
  const m = Number(require('./platform-settings').get('licenseCacheTtlMinutes'));
  return (m > 0 ? m : 30) * 60 * 1000;
}

function pruneCache() {
  if (entCache.size < CACHE_MAX) return;
  const now = Date.now();
  for (const [k, v] of entCache) {
    if (now > v.freshUntil && (!v.lastGoodAt || now - v.lastGoodAt > 7 * 24 * 3600e3)) entCache.delete(k);
    if (entCache.size < CACHE_MAX / 2) break;
  }
}

// One live check: validate, self-healing a missing activation once (fresh DB
// restore, seat freed in the licensing admin — activation is idempotent).
// Network errors propagate.
async function liveValidate(cfg, key, seat, opts) {
  let resp = await validateKey({ key, product: cfg.product, machineId: seat.machineId }, opts);
  if (!resp.valid && resp.error === 'Machine not activated') {
    const act = await activateSeat({ key, product: cfg.product, ...seat }, opts);
    resp = act.valid
      ? await validateKey({ key, product: cfg.product, machineId: seat.machineId }, opts)
      : act;
  }
  return resp;
}

// Live check + cache bookkeeping. On network failure: entries with a recent
// enough successful validation ride out the outage as 'grace' (retrying every
// NEGATIVE_TTL); without that anchor the error propagates and the entry drops.
// A definitive {valid:false} is authoritative — no grace from it, but a short
// negative TTL so a re-claimed key recovers fast.
async function fetchEntitlement(appName, cfg, accountId, key, opts = {}) {
  const ck = `${appName}:${accountId}`;
  let resp;
  try {
    resp = await liveValidate(cfg, key, seatIdentity(appName, accountId), opts);
  } catch (err) {
    const prev = entCache.get(ck);
    if (prev && prev.lastGoodAt && Date.now() - prev.lastGoodAt < cfg.graceHours * 3600e3) {
      prev.ent = { ...prev.ent, status: 'grace' };
      prev.freshUntil = Date.now() + NEGATIVE_TTL_MS;
      return prev.ent;
    }
    entCache.delete(ck);
    throw err;
  }
  const now = Date.now();
  const entry = resp.valid
    ? { ent: activeEntitlement(cfg, resp), freshUntil: now + cacheTtlMs(), lastGoodAt: now, inflight: null }
    : { ent: invalidEntitlement(cfg, resp.error), freshUntil: now + NEGATIVE_TTL_MS, lastGoodAt: 0, inflight: null };
  pruneCache();
  entCache.set(ck, entry);
  return entry.ent;
}

// The one read path. acctRow needs {id, license_key} (rides along on app-auth's
// SELECT * — the request path costs no extra query). Fresh hit → return; stale
// → serve stale NOW, refresh behind (deduped); miss → one short blocking check.
async function getEntitlement(ctx, cfg, acctRow) {
  if (acctRow && acctRow.is_owner) return ownerEntitlement(cfg);
  if (!acctRow || !acctRow.license_key) return freeEntitlement(cfg);
  const ck = `${ctx.appName}:${acctRow.id}`;
  const hit = entCache.get(ck);
  if (hit && Date.now() < hit.freshUntil) return hit.ent;
  if (hit) {
    if (!hit.inflight) {
      hit.inflight = fetchEntitlement(ctx.appName, cfg, acctRow.id, acctRow.license_key)
        .catch(() => {})
        .finally(() => { const e = entCache.get(ck); if (e) e.inflight = null; });
    }
    return hit.ent;
  }
  try {
    return await fetchEntitlement(ctx.appName, cfg, acctRow.id, acctRow.license_key, { timeoutMs: GATE_TIMEOUT_MS });
  } catch {
    // Cold cache during a licence-server outage (e.g. control-room restart mid-
    // outage): no known-good anchor exists, so deny rather than fabricate grace.
    return { ...freeEntitlement(cfg), status: cfg.free ? 'free' : 'unreachable' };
  }
}

// ---- account operations (need ctx.appName + ctx.dbQuery) --------------------

async function currentKey(ctx, accountId) {
  const rows = await ctx.dbQuery('SELECT id, license_key FROM accounts WHERE id=?', [accountId]);
  return rows[0] || null;
}

// Bind a key to an account: validate (no machineId — no seat exists yet, and
// passing one would make the server demand an activation), free any previous
// seat, take the new seat, persist the key, seed the cache.
async function claim(ctx, cfg, accountId, rawKey) {
  const key = String(rawKey || '').trim();
  if (!key || key.length > 64) return { ok: false, error: 'invalid_key_format' };

  let v;
  try { v = await validateKey({ key, product: cfg.product }); }
  catch { return { ok: false, error: 'license_server_unreachable', retryable: true }; }
  if (!v.valid) {
    return { ok: false, error: v.error || 'invalid_key', checkoutUrl: await checkoutUrl(cfg).catch(() => null) };
  }

  const seat = seatIdentity(ctx.appName, accountId);
  const row = await currentKey(ctx, accountId);
  if (row && row.license_key && row.license_key !== key) {
    // Key swap: free the old seat first. Best-effort — the server rate-limits
    // deactivations per IP; an orphaned seat is reclaimable in the admin.
    try { await deactivateSeat({ key: row.license_key, ...seat }); }
    catch (err) { console.warn(`[app:${ctx.appName}] old licence seat release failed (continuing): ${err.message}`); }
  }

  let act;
  try { act = await activateSeat({ key, product: cfg.product, ...seat }); }
  catch { return { ok: false, error: 'license_server_unreachable', retryable: true }; }
  if (!act.valid) {
    const limit = /^machine limit reached/i.test(act.error || '');
    return {
      ok: false,
      error: limit ? 'machine_limit' : (act.error || 'activation_failed'),
      detail: act.error,
      checkoutUrl: await checkoutUrl(cfg).catch(() => null),
    };
  }

  await ctx.dbQuery('UPDATE accounts SET license_key=? WHERE id=?', [key, accountId]);
  const now = Date.now();
  const ent = activeEntitlement(cfg, act);
  entCache.set(`${ctx.appName}:${accountId}`, { ent, freshUntil: now + cacheTtlMs(), lastGoodAt: now, inflight: null });
  return { ok: true, license: ent };
}

// Drop the key and free the seat. The local clear NEVER depends on the remote
// deactivate succeeding (shared-IP rate limit).
async function release(ctx, cfg, accountId) {
  const row = await currentKey(ctx, accountId);
  if (row && row.license_key) {
    try { await deactivateSeat({ key: row.license_key, ...seatIdentity(ctx.appName, accountId) }); }
    catch (err) { console.warn(`[app:${ctx.appName}] licence seat release failed (cleared locally anyway): ${err.message}`); }
  }
  await ctx.dbQuery('UPDATE accounts SET license_key=NULL WHERE id=?', [accountId]);
  entCache.delete(`${ctx.appName}:${accountId}`);
  return { ok: true };
}

async function entitlement(ctx, cfg, accountId) {
  const row = await currentKey(ctx, accountId);
  if (!row) return null;
  return getEntitlement(ctx, cfg, row);
}

async function refresh(ctx, cfg, accountId) {
  entCache.delete(`${ctx.appName}:${accountId}`);
  return entitlement(ctx, cfg, accountId);
}

// Sync, cache-only: is this account on a paid/active tier right now? Used by
// spend-context to stamp `subscribed` on the spend attribution at the edge —
// it must never add a network call to the request path. The licence gate /
// /api/auth/me warm the cache for any account that is actually using the app;
// a cold miss simply reads as not-subscribed until they do. `licensed` is true
// only for status active/grace (a freemium `free` tier is licensed:false).
function subscribedFromCache(appName, accountId) {
  const hit = entCache.get(`${appName}:${accountId}`);
  return !!(hit && hit.ent && hit.ent.licensed);
}

// Tier variants + checkout links (for pricing/landing pages). The group
// endpoint lists subscription tiers matching the family; a lifetime product
// with an exact slug comes back via /info.
async function products(cfg) {
  const [info, variants] = await Promise.all([productInfo(cfg.product), productGroup(cfg.product)]);
  const list = variants && variants.length ? variants : info ? [info] : [];
  return {
    product: cfg.product,
    variants: list.map((v) => ({
      slug: v.slug, name: v.name, licenseType: v.licenseType,
      durationDays: v.durationDays, machineLimit: v.machineLimit,
      checkoutUrl: v.checkoutUrl || null,
    })),
  };
}

// ---- request gate -----------------------------------------------------------
// Runs AFTER ctx.auth.require (req.account is the full row). Freemium apps
// (cfg.free) pass unconditionally — tier limits are the app's job via
// entitlement(). Everything else needs active/grace.
function gate(ctx, cfg) {
  return async (req, res, next) => {
    try {
      if (cfg.free) return next();
      const ent = await getEntitlement(ctx, cfg, req.account);
      if (ent.licensed) return next();
      const co = checkoutFromCache(cfg);
      if (!co) checkoutUrl(cfg).catch(() => {}); // warm for the next 402, off-path
      const unreachable = ent.status === 'unreachable';
      res.status(unreachable ? 503 : 402).json({
        error: unreachable ? 'license_server_unreachable' : 'license_required',
        status: ent.status,
        product: cfg.product,
        checkoutUrl: co,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

module.exports = {
  parseManifest, seatIdentity, resolveTier,
  freeEntitlement, invalidEntitlement, activeEntitlement, ownerEntitlement,
  validateKey, activateSeat, deactivateSeat, productInfo, productGroup,
  checkoutUrl, checkoutFromCache,
  getEntitlement, claim, release, entitlement, refresh, products, gate,
  subscribedFromCache,
  // Test seam (standalone smoke script): direct cache access + the fetch path.
  _internal: { entCache, fetchEntitlement, cacheTtlMs, NEGATIVE_TTL_MS },
};
