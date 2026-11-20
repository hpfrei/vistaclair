// Capability: identity — platform-owned identity: one resolved user across the dashboard and the Telegram mini-app
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.

module.exports = {
  key: 'identity',
  title: 'Identity & linking',
  headings: ['Identity & linking'],
  core: true,
  gated: false,
  ctx: ['identity'],
  keywords: /\b(identity|link code|initData|session token|who is the user)\b/i,
  summary: '`ctx.identity` — one user across dashboard session and Telegram mini-app',

  buildCtx(app) {
    const appIdentity = require('../app-identity');
    const { getOwnerCheck } = require('../app-manager');
    const name = app.name;
    // Platform-owned identity. One resolved user (keyed by Telegram user id)
    // across both contexts — the dashboard (signed session token) and the
    // cookieless Telegram mini-app (validated initData). Apps stop hand-rolling
    // HMAC validation, link-code stores, and session crypto. See
    // _api-reference.md "Identity & linking".
    const identity = {
      // Low-level primitives (rarely needed directly).
      validateInitData: (initData, opts) => appIdentity.validateInitData(name, initData, opts),
      issueLinkCode: (userId, opts) => appIdentity.issueLinkCode(name, userId, opts),
      redeemLinkCode: (code) => appIdentity.redeemLinkCode(name, code),
      issueSession: (userId, opts) => appIdentity.issueSession(name, userId, opts),
      verifySession: (token) => appIdentity.verifySession(name, token),
      // Email/password credential helpers (scrypt; zero new deps). The durable
      // identity stays the app's own account row — these only hash/verify the
      // secret and mint opaque tokens for verification links.
      hashPassword: (plain) => appIdentity.hashPassword(plain),
      verifyPassword: (plain, stored) => appIdentity.verifyPassword(plain, stored),
      randomToken: (bytes) => appIdentity.randomToken(bytes),
      // Resolve a request to { userId, via, user? } from EITHER context. Reads
      // the Telegram initData header (or ?initData= for EventSource) and the
      // dashboard session bearer (Authorization: Bearer <token> or
      // X-App-Session header). Returns null when neither authenticates.
      resolve: (req) => {
        if (!req) return null;
        const headers = req.headers || {};
        const auth = headers.authorization || headers.Authorization || '';
        const bearer = (/^Bearer\s+(.+)$/i.exec(auth) || [])[1]
          || headers['x-app-session']
          || (req.query && req.query.session)
          || null;
        const initData = headers['x-telegram-init-data']
          || (req.query && req.query.initData)
          || null;
        const resolved = appIdentity.resolve(name, { initData, bearer });
        if (resolved) return resolved;
        // Platform-owner fallback: a request with valid OWNER credentials
        // (dashboard cookie / internal header) resolves as via:'owner'.
        // userId stays null — the identity layer knows no account id; app-auth's
        // accountFromIdentity maps 'owner' to the app's is_owner account row.
        // Explicit app credentials above always win, so the admin can still
        // sign in as a regular test user.
        const ownerCheck = getOwnerCheck();
        if (ownerCheck) {
          try { if (ownerCheck(req)) return { userId: null, via: 'owner' }; } catch {}
        }
        return null;
      },
      // Express middleware: 401s unless the request authenticates, else sets
      // req.appUser = { id, via } and calls next(). Drop straight into a route:
      //   router.get('/api/feed', ctx.identity.require, (req, res) => { req.appUser.id ... })
      require: (req, res, next) => {
        const r = identity.resolve(req);
        // via:'owner' carries no userId — it only maps to an account through
        // app-auth (ctx.auth.require). The raw identity layer stays keyed by
        // real user ids, so owner-resolved requests 401 here unchanged.
        if (!r || r.userId == null) { res.status(401).json({ error: 'not_authenticated' }); return; }
        req.appUser = { id: r.userId, via: r.via, telegram: r.user || null };
        next();
      },
    };
    return { identity };
  },

  // ---- Horst facet: read-only account visibility (phase 6) -------------------
  horst: {
    lane: {
      direct: { identity: 'identity_accounts' },
      why: 'ctx.identity is an app\'s own user sessions; Horst sees the account counts only',
    },
    brief: 'identity: per-app user accounts (read-only counts)',
    tools: [
      {
        def: {
          name: 'identity_accounts',
          description: 'How many user accounts each app has (from its accounts table, when the app uses platform auth and its database is provisioned), split into total and linked channels (email/telegram/whatsapp). Read-only — no names, emails or ids.',
          inputSchema: { type: 'object', properties: {
            app: { type: 'string', description: 'One app (default: every app with a provisioned database).' },
          } },
        },
        handler: async (args) => {
          const appDb = require('../app-db');
          const { textResult } = require('../horst-facet');
          if (!appDb.getPool()) return textResult('Database not connected.');
          const names = args.app ? [args.app] : appDb.getProvisionedApps();
          const rows = [];
          for (const name of names) {
            const db = appDb.getAppDb(name);
            if (!db) continue;
            try {
              const [r] = await appDb.query(
                `SELECT COUNT(*) AS total,
                        SUM(email IS NOT NULL) AS email,
                        SUM(tg_user_id IS NOT NULL) AS telegram,
                        SUM(wa_id IS NOT NULL) AS whatsapp
                 FROM accounts`, [], db.database);
              rows.push({ app: name, accounts: Number(r.total), email: Number(r.email) || 0, telegram: Number(r.telegram) || 0, whatsapp: Number(r.whatsapp) || 0 });
            } catch { /* no accounts table — the app doesn't use platform auth */ }
          }
          return textResult(rows.length ? rows : 'No app has an accounts table.');
        },
      },
    ],
  },
};
