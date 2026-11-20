// Capability: google — `auth.google.getToken/accounts` — non-mail Google APIs
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and docs/capabilities.md.

const { core } = require('../core-services');

module.exports = {
  key: 'google',
  title: 'Google Auth',
  core: false,
  gated: true,
  methods: ['auth.google.getToken', 'auth.google.accounts', 'auth.google.revoke'],
  prefixes: ['auth.google.'],
  ctx: ['googleAuth'],
  keywords: /\b(google api|oauth|drive|sheets|gmail api|google auth)\b/i,
  summary: '`auth.google.getToken/accounts` — non-mail Google APIs',
  migration: 'An app-implemented OAuth2 flow (token storage, refresh, redirect handling) → `auth.google.*`. Deletes hundreds of lines and shares scopes across apps.',
  visibility: { standalone: false },
  revocable: true,

  buildCtx(app) {
    const googleAuth = require('../google-auth');
    return {
      googleAuth: {
        getToken: (scopes, email) => googleAuth.getAccessToken(scopes || [], require('../google-api').redirectUri(), email),
        accounts: () => googleAuth.listAccounts(),
      },
    };
  },

  bridge: {
    'auth.google.getToken': async (app, params) => {
      const scopes = params.scopes || [];
      const redirectUri = params.redirectUri || require('../google-api').redirectUri();
      return require('../google-auth').getAccessToken(scopes, redirectUri, params.email);
    },
    'auth.google.accounts': async () => require('../google-auth').listAccounts(),
    'auth.google.revoke': async (app, params) => {
      if (!params.email) throw new Error('email required');
      // Reports whether the grant actually died at Google, not just whether we
      // forgot it here.
      return require('../google-auth').revokeAccount(params.email);
    },
  },

  // ---- Horst facet: auth-expiry sense (phase 6) ------------------------------
  // Pairs with the ai:auth-required blind spot: a Google account whose refresh
  // fails silently degrades every app using it — now it is sensed.
  horst: {
    lane: {
      default: 'never',
      why: 'OAuth tokens never enter a model context; a dead grant is retried by google.auth.reconnect from the sense, not the chat',
    },
    brief: 'google: shared Google OAuth accounts for apps (expired grants are sensed)',
    senses: [
      { kind: 'google:auth-expired', description: 'A Google account\'s token refresh failed — apps using it are bounced to re-auth', defaultPolicy: 'notify' },
    ],
    wire({ publish }) {
      // One event per distinct error per account (same pattern as the mail
      // sync sense): a broken grant fails on every call; only the first is news.
      const lastError = new Map();
      return require('../google-auth').onAuthExpired((email, error) => {
        const msg = String(error || 'refresh failed');
        if (lastError.get(email) === msg) return;
        lastError.set(email, msg);
        publish('google:auth-expired', { email, error: msg },
          { dedupeKey: `google-auth:${email}`, summary: `Google auth expired for ${email}: ${msg}`.slice(0, 120) });
      });
    },
    kinds: {
      // The sense above had no remediation: a dead Google token takes Gmail
      // sync AND the calendar dark at once, and the only output was one
      // Telegram line the owner had to act on by hand. The mail side has had
      // `email.sync.reconnect` at auto+notify since phase 6, and its reasoning
      // applies here verbatim.
      'google.auth.reconnect': {
        identity: null, // a repeat run is a legitimate retry, never a duplicate
        label: 'Retry Google account authorisation',
        about: 'Retries the token refresh for a Google account after its auth expired, and returns a re-consent link if the grant is genuinely gone.',
        ceiling: 'auto+notify',
        // Remediation, not content: it repairs a grant that broke on its own,
        // and the worst case of an unattended run is one wasted token refresh —
        // while the cost of WAITING for an approval is mail and calendar that
        // silently stop updating. It cannot grant itself anything: a refresh
        // either works with the credentials already held, or it does not, and
        // re-consent is the owner's browser and the owner's click either way.
        defaultLevel: 'auto+notify',
        idempotent: true,
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'email');
          const known = require('../google-auth').listAccounts().map((a) => a.email);
          if (!known.includes(p.email)) throw new Error(`unknown Google account "${p.email}"`);
        },
        describe: (p) => `Retry Google auth for ${p.email}`,
        async execute(p) {
          const googleAuth = require('../google-auth');
          const core = require('../core-services').core;
          try {
            await googleAuth.refreshAccessToken(p.email);
            return { ok: true, summary: `Google auth restored for ${p.email}` };
          } catch (err) {
            // A failed refresh is the expected outcome when the grant is truly
            // revoked. That is not an error to bury — it is the moment to hand
            // the owner the one link that fixes it, scoped to this account.
            const acct = googleAuth.listAccounts().find((a) => a.email === p.email);
            let authUrl = null;
            try {
              authUrl = googleAuth.getAuthUrl(
                acct?.grantedScopes || [],
                require('../google-api').redirectUri(),
                p.email,
              );
            } catch { /* OAuth not configured — the message below still stands */ }
            return {
              ok: false,
              summary: `Google auth for ${p.email} needs re-consent: ${err.message}`,
              authUrl,
            };
          }
        },
      },
    },
  },
};
