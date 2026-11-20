const path = require('path');
const http = require('http');
const express = require('express');
const apps = require('./src/apps');
const appManager = require('./src/apps/app-manager');
const appBridge = require('./src/apps/app-bridge');
const googleAuth = require('./src/apps/google-auth');
const telegram = require('./src/apps/telegram');
const whatsapp = require('./src/apps/whatsapp');
const internalHeaders = require('./src/apps/internal-headers');

const VALID_APP_NAME = /^[a-z0-9][a-z0-9-]*$/;

// The descriptor's `cspReady` (core src/addons.js cspBlockers): true tells core
// the client modules run under its enforcing Content-Security-Policy, so the
// policy may be sent enforced instead of report-only. OFF unless the owner sets
// VISTACLAIR_PRO_CSP_READY=1 (1 / true / yes / on) in the server's environment
// and restarts it, after a click-through of the Pro pages with the policy in
// report-only (docs/apps.md "Content-Security-Policy").
function cspReadyEnabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.VISTACLAIR_PRO_CSP_READY || '').trim().toLowerCase());
}

function proxyToApp(req, res, port, targetPath) {
  const fwd = { ...req.headers, host: `localhost:${port}` };
  delete fwd.cookie;
  delete fwd.authorization;
  // No platform credential header (x-vistaclair-internal, peer/poll secrets, ...)
  // reaches the app process. The owner decision was made by core's gate; an
  // app that must tell platform cron apart uses its own per-app cron signature
  // (platform-cron.js), which cron sends to the app directly, not through here.
  internalHeaders.stripMap(fwd);
  const opts = {
    hostname: 'localhost',
    port,
    path: targetPath,
    method: req.method,
    headers: fwd,
  };
  const proxyReq = http.request(opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });
  proxyReq.on('error', () => {
    if (!res.headersSent) res.status(502).end();
  });
  req.pipe(proxyReq, { end: true });
}

// The /apps/<name> dispatcher: in-process router or own-process proxy. Exported
// for tests (a bare `ctx.isOwnerRequest` is all it needs from the addon ctx).
function appsDispatcher(ctx) {
  return (req, res, next) => {
    const match = req.url.match(/^\/([^/?#]+)(\/.*)?$/);
    if (!match) return next();
    const appName = decodeURIComponent(match[1]);

    if (!VALID_APP_NAME.test(appName)) return next();

    // Route-mounted app (in-process, no port). The owner decision is taken
    // while core's credential header is still on the request, then every
    // x-vistaclair-* header is removed: app code never sees AUTH_TOKEN.
    const router = appManager.getMountedRouter(appName);
    if (router) {
      internalHeaders.markOwner(req, ctx.isOwnerRequest);
      internalHeaders.strip(req);
      req.url = match[2] || '/';
      return router(req, res, next);
    }

    // Own-process app (dashboard-managed app-runner child on a loopback port)
    const running = appManager.getRunningApp(appName);
    if (running?.port) {
      return proxyToApp(req, res, running.port, match[2] || '/');
    }

    next();
  };
}

// One perimeter mechanism: every per-app auth exemption (the `app` entry
// surface derived from the auth block, landing/narrow public pages, the landing
// kit) is derived from the manifest by surfaces.js — see
// rebuildPublicExemptions below and docs/apps.md "Access levels".
const surfaces = require('./src/apps/surfaces');

// Minted MCP broker sessions (/pro/mcp/s/<id>) — external AI processes connect
// with a bearer token instead of the owner cookie. Exempting the path is safe
// ONLY because the handler enforces the per-session token itself
// (mcp-broker.js resolveSession); everything else under /pro/mcp stays
// owner-authed.
const MCP_EXEMPT_PATTERNS = [
  /^\/pro\/mcp\/s\/[a-z0-9-]+$/,
];

// The `vc-*` Web Component library. Order matters: vc-core must load first
// (components assert `Vc.Element` at definition time). The bundle /pro/vc.js is
// core + every component in this order; an individual /pro/vc-<name>.js is served
// with core prepended so a component is never delivered without its base. Core is
// idempotent (redefine-guarded), so loading it repeatedly is harmless.
const VC_COMPONENTS = [
  'vc-input-bar', 'vc-chat-log', 'vc-progress', 'vc-empty-state',
  'vc-model-picker', 'vc-media-viewer', 'vc-markdown', 'vc-dialog', 'vc-sysmon',
  'vc-gauge', 'vc-stage-graph', 'vc-site-status',
];

// Inter-component deps: a single-component request (/pro/vc-<name>.js) also gets
// these prepended (after core, before the component) so a dependency is never
// missing when a component is loaded on its own. The full bundle already includes
// everything in order. vc-markdown opens previews in the shared media viewer.
const VC_DEPS = { 'vc-markdown': ['vc-media-viewer'] };

// Concatenate vc-* source files, caching by combined mtime so edits are picked up
// without a restart but repeat requests don't re-read disk.
function makeVcBundler(publicDir) {
  const fs = require('fs');
  const cache = new Map(); // key -> { mtime, body }
  const readWithCore = (names) => {
    const files = ['vc-core', ...names].map((n) => path.join(publicDir, n + '.js'));
    let mtime = 0;
    for (const f of files) mtime = Math.max(mtime, fs.statSync(f).mtimeMs);
    const key = names.join(',');
    const hit = cache.get(key);
    if (hit && hit.mtime === mtime) return hit.body;
    const body = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n;\n');
    cache.set(key, { mtime, body });
    return body;
  };
  return (req, res, next) => {
    const m = req.path.match(/^\/pro\/(vc(?:-[a-z-]+)?)\.js$/);
    if (!m) return next();
    const name = m[1];
    let names;
    if (name === 'vc') names = VC_COMPONENTS;            // full bundle
    else if (name === 'vc-core') names = [];             // core alone
    else if (VC_COMPONENTS.includes(name)) names = [...(VC_DEPS[name] || []), name]; // component + deps + core
    else return next();
    let body;
    try { body = readWithCore(names); }
    catch (err) { return next(); } // missing file → fall through to static/404
    res.type('application/javascript');
    res.set('Cache-Control', 'no-cache');
    res.send(body);
  };
}

function init(ctx) {
  // Seam guard: the fields below are additive (see docs/seam.md).
  // Core catches this throw and logs "Pro: init failed".
  if (typeof ctx.isOwnerRequest !== 'function' || !ctx.dataHome || !ctx.coreDir) {
    throw new Error('platform init needs isOwnerRequest/dataHome/coreDir on the addon ctx (see docs/seam.md)');
  }

  // Pro owns its own router (mounted by core AFTER auth) instead of mutating
  // the host app. Route order within this router is preserved as added.
  const router = express.Router();

  // vc-* component bundle/auto-core route — must precede the static middleware so
  // /pro/vc.js and /pro/vc-<name>.js are assembled (core-prepended) rather than
  // served as bare files. /pro/vc-core.js is served alone by this route too.
  router.use(makeVcBundler(path.join(__dirname, 'public')));

  router.use('/pro', express.static(path.join(__dirname, 'public')));

  // Same location as before the merge: Pro lived in its own checkout
  // and used its sibling <DATA_HOME>/vistaclair-apps.
  const appsDir = process.env.VISTACLAIR_APPS_DIR || path.join(ctx.dataHome, 'vistaclair-apps');

  // Owner check comes from core (src/auth.js via the ctx) — the same decision
  // core's auth middleware makes, re-applied here on auth-EXEMPT paths where
  // anonymous and owner traffic both arrive. Never re-implemented on this side.
  const isOwnerRequest = ctx.isOwnerRequest;

  // Response hardening for every /apps/* response (app-headers.js): no owner
  // auth cookies, nosniff, a framing/base-uri CSP. First, so refusals get it too.
  router.use('/apps', require('./src/apps/app-headers').middleware());

  // Dot-segment refusal — BEFORE anything under /apps. Core matches the auth
  // exemptions against the raw request path, and express.static would
  // normalise `app/../index.html` to the owner SPA, so a cookieless shape like
  // /apps/<n>/app/** could otherwise be walked out of. Any empty, "." or ".."
  // segment (raw or percent-encoded) is refused here for every app.
  router.use('/apps', (req, res, next) => {
    let p = req.url.split('?')[0];
    try { p = decodeURIComponent(p); } catch { return res.status(400).end(); }
    if (/%2e/i.test(req.url) || p.split('/').slice(1).some((seg) => seg === '.' || seg === '..')) {
      return res.status(404).end();
    }
    next();
  });

  // Anonymous-surface root redirect — BEFORE the app dispatch below. The
  // derived access level decides where non-owner visitors land at the app
  // root: a landing page wins over the `app` entry surface (more specific);
  // an open app redirects nowhere (its root already serves everyone).
  // The OWNER falls through to the normal app index — the dashboard embeds
  // apps at /apps/<name>/, so the owner must never see the redirect
  // (isOwnerRequest mirrors core's cookie checks). The redirect target is
  // always exempt: rootRedirectTarget only returns paths the exemption
  // builder (rebuildPublicExemptions) also exempts.
  // From `/apps/<n>/` the Location is RELATIVE, so it resolves inside the app
  // subtree on whichever host serves it — a custom domain maps its `/` there
  // and never had /apps/<n>/. The slashless root keeps the absolute form.
  const entryMissing = (name, target) => target === `${surfaces.ENTRY}.html`
    && !require('fs').existsSync(path.join(appManager.appDir(name), 'public', target));
  router.use('/apps', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const m = req.url.match(/^\/([a-z0-9][a-z0-9-]*)(\/?)(\?.*)?$/); // app root only
    if (!m) return next();
    let manifest = null;
    try { manifest = appManager.readManifest(m[1]); } catch {}
    if (!manifest) return next();
    const target = surfaces.rootRedirectTarget(manifest);
    if (!target) return next();
    // A users-level app that has not shipped its app.html yet falls through to
    // the owner gate (a /login redirect) rather than 302-ing visitors to a 404.
    if (entryMissing(m[1], target)) return next();
    if (isOwnerRequest(req)) return next();
    res.redirect(302, `${m[2] ? '' : `/apps/${m[1]}/`}${target}${m[3] || ''}`);
  });

  // The login trap (surfaces.js): core sends every cookieless request to
  // /login, which on a custom domain is /apps/<n>/login. It is exempt so it
  // lands here, and a non-owner goes on to the root target (relative — `login`
  // sits at the app root on either host) instead of looping. The owner falls
  // through to the app unchanged. Nothing anonymous ever reaches the app on
  // this path: with no entry page shipped yet the answer is a 404.
  router.use('/apps', (req, res, next) => {
    const m = req.path.match(new RegExp(`^/([a-z0-9][a-z0-9-]*)/${surfaces.LOGIN_TRAP}$`));
    if (!m) return next();
    let manifest = null;
    try { manifest = appManager.readManifest(m[1]); } catch {}
    const target = manifest ? surfaces.loginRedirectTarget(manifest) : null;
    if (!target || isOwnerRequest(req)) return next();
    if (entryMissing(m[1], target)) return res.status(404).end();
    res.redirect(302, target);
  });

  // Landing kit (surface-kit.js): /apps/<name>/__surface/* serves the platform
  // login/landing primitives — exempt by construction for any app with a
  // declared anonymous surface. Before the app dispatch so an app route can
  // never shadow (or spoof) the kit namespace.
  router.use('/apps', require('./src/apps/surface-kit').middleware());

  // Route-mounted and proxied apps (before static serving)
  router.use('/apps', appsDispatcher(ctx));

  // Sites' byte-proxy (docs/sites.md): /s/<app>/<site>/ → the site's port,
  // pass-through only, public sites only; anonymous by EXEMPT_RE below.
  router.use(require('./src/apps/sites-proxy').middleware({ authToken: ctx.authToken }));

  router.get('/pro/manifest.json', (req, res) => {
    res.json({ version: '1.0.0', features: ['apps'] });
  });

  googleAuth.init(appsDir, ctx.secretStore);

  // Auth-exempt popup landing: escaped data, own CSP, one-time `state`
  // (src/apps/google-callback.js).
  router.get('/pro/auth/google/callback', require('./src/apps/google-callback').createHandler(googleAuth));

  // --- Cross-app change requests (src/apps/app-change-request-routes.js) ----
  // Called by scripts/app-change.js from inside an app change tab. Two callers
  // reach these routes after core's auth: the owner (cookie / owner token: no
  // req.vcSession, names the instance in the body) and a session holding its
  // per-session token (req.vcSession.instanceId). A session acts only as itself
  // and only on a request it sent or is the target of; the rule is in the
  // routes file and docs/change-requests.md.
  require('./src/apps/app-change-request-routes').mountApi(router, express);

  // Telegram webhook — Telegram POSTs bot updates here. Public route (no dashboard
  // cookie); authenticated instead by the per-bot secret token header.
  router.post('/pro/telegram/:appName/webhook', express.json({ limit: '1mb' }), (req, res) => {
    const appName = req.params.appName;
    // Reserved key __platform__ is the dashboard control bot (not a real app), so
    // it's exempt from the app-name shape check that protects the per-app webhooks.
    if (appName !== '__platform__' && !VALID_APP_NAME.test(appName)) return res.status(404).end();
    const bot = telegram.getBot(appName);
    if (!bot) return res.status(404).end();
    if (!telegram.webhookSecretOk(bot, req.headers['x-telegram-bot-api-secret-token'])) {
      return res.status(403).end();
    }
    // Always 200 — Telegram retries forever on non-200; log instead of failing.
    try { telegram.dispatchUpdate(appName, req.body); }
    catch (err) { console.warn(`  Telegram [${appName}]: webhook dispatch failed:`, err.message); }
    res.status(200).json({ ok: true });
  });

  // Google Calendar push webhook — Google POSTs empty-body channel
  // notifications here (headers only; see calendar-engine.js
  // maintainChannels). Public route (no dashboard cookie); authenticated by
  // the per-channel id+token pair checked in the engine. Unknown/forged
  // channels get 404 so Google backs off and lets them die.
  router.post('/pro/calendar/webhook', (req, res) => {
    const ok = require('./src/apps/calendar-engine').handleWebhook(req.headers);
    res.status(ok ? 200 : 404).end();
  });

  // WhatsApp webhook verification (GET) — Meta calls this once when you register
  // the callback URL. Echo hub.challenge iff hub.verify_token matches the app's
  // stored verifyToken. Public route (no dashboard cookie).
  router.get('/pro/whatsapp/:appName/webhook', (req, res) => {
    const appName = req.params.appName;
    if (!VALID_APP_NAME.test(appName)) return res.status(404).end();
    const acct = whatsapp.getAccount(appName);
    if (!acct) return res.status(404).end();
    if (req.query['hub.mode'] === 'subscribe' && require('./src/apps/secret-equal').secretEqual(req.query['hub.verify_token'], acct.verifyToken)) {
      return res.status(200).send(String(req.query['hub.challenge'] ?? ''));
    }
    return res.status(403).end();
  });

  // WhatsApp inbound (POST) — Meta POSTs message/status webhooks here. Authenticated
  // by the X-Hub-Signature-256 HMAC over the RAW body keyed by the app's appSecret,
  // so we capture the raw bytes with express.raw rather than express.json.
  router.post('/pro/whatsapp/:appName/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const appName = req.params.appName;
    if (!VALID_APP_NAME.test(appName)) return res.status(404).end();
    const acct = whatsapp.getAccount(appName);
    if (!acct) return res.status(404).end();

    // A host-level express.json() may have consumed the stream before our
    // express.raw() ran; in that case the raw bytes are on req.rawBody (stashed
    // by the host parser's verify hook).
    const raw = Buffer.isBuffer(req.body) ? req.body
      : Buffer.isBuffer(req.rawBody) ? req.rawBody
      : Buffer.from('');
    const sig = req.headers['x-hub-signature-256'] || '';
    const expected = 'sha256=' + require('crypto').createHmac('sha256', acct.appSecret).update(raw).digest('hex');
    let ok = false;
    try { ok = require('crypto').timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { ok = false; }
    if (!ok) return res.status(403).end();

    // Always 200 — Meta retries (with backoff) on non-200; log instead of failing.
    try {
      const body = JSON.parse(raw.toString('utf-8'));
      whatsapp.dispatchWebhookBody(appName, body);
    } catch (err) {
      console.warn(`  WhatsApp [${appName}]: webhook dispatch failed:`, err.message);
    }
    res.status(200).json({ ok: true });
  });

  // App tool call endpoint — receives tool calls from app-tools-server.js
  // sidecars. Loopback-only by hard invariant (app tools are never reachable
  // from the network), authenticated by a per-AI-session ephemeral token whose
  // allowlist also determines which app owns each namespaced tool — the body
  // is not trusted for routing.
  router.post('/api/app-tool-call', express.json(), async (req, res) => {
    const ra = req.socket.remoteAddress;
    if (ra !== '127.0.0.1' && ra !== '::1' && ra !== '::ffff:127.0.0.1') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const session = appBridge.resolveToolToken(req.headers['x-vistaclair-internal']);
    if (!session) return res.status(403).json({ error: 'Forbidden' });

    const { toolName, arguments: args } = req.body;
    // The token's allowlist maps each full tool name to its owning app and
    // short name — never parse the name (pseudo-app owners like '__platform__'
    // contain the '__' separator, so string-splitting misroutes them).
    const route = toolName ? session.allowedTools.get(toolName) : null;
    if (!route) {
      return res.status(403).json({ error: 'Tool not permitted for this session' });
    }

    // instanceId = the per-aiPrompt session the token was minted for. Handlers
    // that budget per session (horst-brain's brain-tool call cap) key on it;
    // sessionTag = the opaque tag the app passed to that aiPrompt call, so
    // handlers can route concurrent per-user sessions to the right resource.
    // exposeAllows/callAppToolHandler ignore the extra fields.
    const caller = session.appName === 'platform'
      ? { type: 'platform', instanceId: session.instanceId, sessionTag: session.sessionTag }
      : { type: 'self', appName: session.appName, instanceId: session.instanceId, sessionTag: session.sessionTag };

    try {
      const result = await appBridge.callAppToolHandler(route.ownerApp, route.shortName, args || {}, caller);
      res.json({ result });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // Live array core reads on every request (vistaclair/src/addons.js iterates the
  // descriptor each time). Mutating it grants/revokes per-app public access with no
  // restart. Per-app surface patterns are layered onto the static MCP patterns.
  const authExemptPatterns = [...MCP_EXEMPT_PATTERNS, require('./src/apps/sites-proxy').EXEMPT_RE];

  // Recompute every per-app exemption from current manifests. Called at startup
  // and whenever an app's config changes (src/apps/index.js app:setConfig).
  // ONE builder: surfaces.buildAppPatterns derives everything (the `app` entry
  // surface from the auth block, landing / narrow public pages, the landing
  // kit) from the manifest.
  function rebuildPublicExemptions() {
    authExemptPatterns.length = 0;
    authExemptPatterns.push(...MCP_EXEMPT_PATTERNS, require('./src/apps/sites-proxy').EXEMPT_RE);
    try {
      for (const app of appManager.list()) {
        if (!app) continue;
        authExemptPatterns.push(...surfaces.buildAppPatterns(app.name, app));
      }
    } catch (err) { console.warn('  Apps: rebuild public exemptions failed:', err.message); }
  }

  // isOwnerRequest is wrapped so a request resolved as owner at dispatch stays
  // owner after its credential header is stripped (internal-headers.js).
  apps.init({ ...ctx, isOwnerRequest: internalHeaders.ownerAware(ctx.isOwnerRequest), appsDir, rebuildPublicExemptions });
  rebuildPublicExemptions();

  // Master↔slave control plane (/api/peer/*). Auth-exempt at the core seam
  // (declared below) — every route self-authenticates: pairing intake by poll
  // secret, the slave control plane by the peer token issued at pairing.
  router.use('/api/peer', require('./src/apps/peer-server').createPeerRouter({
    authToken: ctx.authToken,
    broadcaster: ctx.broadcaster,
    scheduleRestart: ctx.scheduleRestart,
    // A code deploy replaces manifest.json — a published `public` flip must
    // take effect immediately, not at the next pro restart.
    rebuildPublicExemptions,
  }));

  // MCP broker (/pro/mcp) — the live union of app tools served as a dynamic,
  // scoped MCP server for owner-class AIs (docs/apps.md "MCP broker").
  // Owner-authed by core's middleware, EXCEPT the minted per-session endpoints
  // /pro/mcp/s/<id> (MCP_EXEMPT_PATTERNS below) which self-authenticate by
  // bearer token inside the handler — same pattern as the peer token.
  router.use('/pro/mcp', require('./src/apps/mcp-broker').createRouter());

  // Platform TG session Mini App API (/pro/tg-session/api/*). Auth-exempt
  // subtree (see authExemptPaths) — every endpoint self-authenticates via
  // Telegram initData exchange. Mounted after apps.init so the module is wired.
  require('./src/apps/platform-tg-session').mountApi(router);

  // Vista approvals Mini App API (/pro/vista/api/*). Same auth-exempt,
  // self-authenticating shape as the TG session app above, with a bearer
  // header of its own so the two apps cannot clobber each other's tokens.
  require('./src/apps/platform-miniapp').mountApi(router);

  // Horst (built-in resident agent) API — /pro/horst/api/*. Owner-authed by
  // default (deliberately NOT in authExemptPaths); the UI lives at /pro/horst/.
  require('./src/apps/platform-horst').mountApi(router);

  // Artifact downloads (/pro/artifacts/:id) — owner-authed by default like
  // /pro/horst/api; the handler re-checks isOwnerRequest (docs/tool-jobs-artifacts.md).
  require('./src/apps/app-artifacts').mountApi(router);

  return {
    id: 'platform',
    router,
    // Read by core (addons.platformTools()) for the dashboard's voice input.
    platformTools: require('./src/apps/platform-tools'),
    // Read by core per request (cspBlockers), behind the owner's switch above.
    get cspReady() { return cspReadyEnabled(); },
    clientModules: [
      // apps.js first: it defines vcAct, which the later modules render through.
      { styles: ['/pro/apps.css', '/pro/apps-console.css'], scripts: ['/pro/apps.js', '/pro/app-bridge-client.js', '/pro/app-model-picker.js', '/pro/app-overlays.js', '/pro/horst-tab.js', '/pro/remote-sessions-view.js', '/pro/publish.js', '/pro/spend-admin.js', '/pro/tg-handoff.js'] }
    ],
    // Declared public route — Google redirects here cross-site, so the SameSite
    // cookie isn't sent. Replaces the stale hardcoded regex that used to live in
    // core's auth middleware and never matched this (/pro/...) path.
    // /pro/app-launcher.html is the chrome-free full-screen shell. It must be
    // reachable by public (non-owner) visitors; in that mode it runs REST-only and
    // loads no owner assets. Owner visitors get Bridge parity (cookie present →
    // launcher opens the owner WS). Exact-path exempt — the app it embeds
    // (/apps/<name>/) is separately gated by publicAppPatterns.
    // /pro/tg-session is the platform control bot's Mini App (page + api/*) —
    // it loads in the Telegram webview (no owner cookie) and self-authenticates
    // via initData exchange in platform-tg-session.js.
    // /api/peer is the master↔slave control plane — self-authenticating
    // (peer token / poll secret), see peer-server.js.
    // /pro/calendar/webhook is the Google Calendar push endpoint — Google
    // POSTs channel notifications cross-site (no cookie); it self-authenticates
    // via the per-channel X-Goog-Channel-ID/-Token pair (calendar-engine.js).
    authExemptPaths: ['/pro/auth/google/callback', '/pro/telegram', '/pro/whatsapp', '/pro/calendar/webhook', '/pro/app-launcher.html', '/pro/app-auth.js', '/pro/tg-session', '/api/peer',
      // Static frontend assets the (already-exempt) launcher needs in public
      // mode for the Bridge.confirm/modal overlay host — no secrets, CSS/UI only.
      '/pro/app-overlays.js', '/pro/apps.css', '/pro/app-theme.css',
      // The card renderer, shared by the Horst page and the Telegram Mini App
      // (which has no owner cookie). Pure rendering of data the caller already
      // holds — no secrets, and it fetches nothing.
      '/pro/proposal-cards.js',
      // The Vista approvals Mini App (page + api/*) and the Mini App client
      // plumbing both apps share. Same shape as '/pro/tg-session': opened by
      // Telegram's webview, which carries no owner cookie, so every endpoint
      // self-authenticates via initData exchange in tg-miniapp-auth.js.
      '/pro/vista', '/pro/tg-common',
      // marked + DOMPurify, for the tg-session Mini App's markdown: read-only
      // static libraries, no secrets.
      '/pro/marked.min.js', '/pro/purify.min.js'],
    // Every per-app cookie exemption is derived from the manifest's `surfaces`
    // declaration by ONE builder (src/apps/surfaces.js, rebuildPublicExemptions
    // above): public pages/landing, the cookieless `app` entry surface derived
    // from the auth block, and the landing kit at /apps/<name>/__surface/*.
    // Cookieless routes either
    // self-gate (app-auth default-deny guard, tgAuth) or are public by intent.
    // This is the SAME live array; core reads it per request, so mutation suffices.
    authExemptPatterns,
    // WS upgrades: the peer channel. On a paired SLAVE the master connects to
    // CHANNEL_PATH, authenticated by the peer token inside the handler (same
    // self-auth pattern as the /api/peer HTTP routes). Core offers exact-match
    // upgrades on authExemptUpgradePaths to this add-on only, without the owner
    // gate (an older core ignores the field). Everything else falls through to
    // core's dashboard WS.
    authExemptUpgradePaths: [require('./src/apps/peer-channel').CHANNEL_PATH],
    // Sites' byte-proxy upgrades (/s/<app>/<site>/…): anonymous like the HTTP
    // side; sites-proxy claims every one and answers 404 unless the site is
    // public and running (an older core ignores the field: owner-only then).
    authExemptUpgradePatterns: [require('./src/apps/sites-proxy').EXEMPT_RE],
    handleUpgrade: (req, socket, head) =>
      require('./src/apps/sites-proxy').handleUpgrade(req, socket, head, { authToken: ctx.authToken })
      || require('./src/apps/peer-channel').handleUpgrade(req, socket, head),
    shutdown,
  };
}

function shutdown() {
  apps.shutdown();
}

module.exports = { init, shutdown, proxyToApp, appsDispatcher, cspReadyEnabled };
