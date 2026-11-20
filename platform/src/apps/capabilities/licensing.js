// Capability: licensing — `manifest.auth.license` + `ctx.license.entitlement/refresh/validate/release/products` — paid/freemium apps against the platform licence server: key claim + seats, tier features, revocation/grace, checkout links. No bridge methods; frontends read `/api/auth/me`
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and docs/capabilities.md.

module.exports = {
  key: 'licensing',
  title: 'App Licensing',
  core: false,
  gated: false,
  methods: [],
  aliases: ['license'],
  ctx: ['license'],
  keywords: /\b(licen[cs]e|licen[cs]ing|paid app|premium|paywall|entitlement|subscription tier|checkout|seat limit|freemium)\b/i,
  summary: '`manifest.auth.license` + `ctx.license.*` — paid/freemium apps, seats, tiers',
  migration: 'Hand-rolled licence-key validation, entitlement caching, or `http.fetch` calls to the licence server with an app-held secret → declare `manifest.auth.license` and read `ctx.license.entitlement()` / `me.license`.',

  buildCtx(app) {
    const name = app.name;
    // Licence config for ctx.license — re-parsed per call (pure), so a manifest
    // edit takes effect on app restart without rebuilding the ctx.
    const licCfg = () => {
      const cfg = require('../app-license').parseManifest(require('../app-manager').readManifest(name)?.auth?.license);
      if (!cfg) throw new Error(`app "${name}" declares no manifest auth.license — set it to use ctx.license`);
      return cfg;
    };
    // app-license reads appName/dbQuery/auth off the app's own ctx — app.ctx is
    // the object being assembled, dereferenced only at call time.
    const ctx = app.ctx;
    // App licensing (manifest auth.license — see _api-reference "App Licensing").
    // The backend is the licence provider slot (app-license.setProvider; empty
    // by default); entitlements are cached in memory (app-license.js) — the only local state
    // is accounts.license_key, owned by app-auth. ctx-only, like ctx.identity:
    // frontends read licence state from /api/auth/me, no bridge methods.
    return {
      license: {
        // Cached entitlement for an account: {licensed, status, tier, features, expiresAt}.
        entitlement: (accountId) => require('../app-license').entitlement(ctx, licCfg(), accountId),
        // Live pre-check of a raw key (no seat taken). Rejects with err.network on outage.
        validate: (key) => require('../app-license').validateKey({ key, product: licCfg().product }),
        // Drop the cached entitlement and re-validate now (e.g. after an upgrade purchase).
        refresh: (accountId) => require('../app-license').refresh(ctx, licCfg(), accountId),
        // Free the account's seat and clear its key (local clear never depends on the server).
        release: (accountId) => require('../app-license').release(ctx, licCfg(), accountId),
        // Tier variants + checkout links for pricing surfaces.
        products: () => require('../app-license').products(licCfg()),
      },
    };
  },

  horst: {
    lane: {
      default: 'never',
      why: 'an app\'s own licence checks against its users',
    },
  },
};
