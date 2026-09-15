// The addon ctx — the ONE object core hands to add-ons (Pro's init(ctx)) and
// to out-of-process add-on hosts (Pro's app-runner). One factory, two profiles:
//
//   dashboard  createAddonCtx({ dataHome, dashboard: {...} })   from server.js
//   headless   createAddonCtx({ loadEnv: true })                from app-runner
//
// The shared block (paths, ports, token, Claude spawning, key/model registry,
// secret store) is a pure function of DATA_HOME and the environment and is
// built once for both. The dashboard profile adds the in-process services
// (store, cliSessionManager, live broadcaster, pending questions, restart,
// the owner check). The headless profile reaches the dashboard's broadcaster
// best-effort over loopback and stubs what only exists in the dashboard
// process: the runner keeps serving when core is down, it just loses live
// dashboard events and inspector timelines.
//
// Every field here is contract (Pro spreads the whole object). Add fields
// additively; removing or reshaping one is a CONTRACT_VERSION bump. The table
// in vistaclair-pro/CLAUDE.md ("The core ⇄ Pro seam") mirrors this file.

const path = require('path');
const crypto = require('crypto');
const { CONTRACT_VERSION } = require('./addons');

function createAddonCtx({ dataHome, loadEnv = false, dashboard = null } = {}) {
  // The runner boots outside the dashboard and needs core's .env (AUTH_TOKEN,
  // ports, provider keys) before anything below reads process.env.
  // (.env may set VISTACLAIR_HOME, which utils.js reads at load — so load it
  // before requiring utils.)
  if (loadEnv) {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
  }
  const utils = require('./utils');
  const caps = require('./capabilities');
  const secretStore = require('./secret-store');
  const home = dataHome || utils.DATA_HOME;

  const shared = {
    contractVersion: CONTRACT_VERSION,
    headless: !dashboard,
    coreDir: utils.PACKAGE_ROOT,
    dataHome: home,
    dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3457'),
    proxyPort: parseInt(process.env.PROXY_PORT || '3456'),
    authToken: process.env.AUTH_TOKEN || null,
    // Frozen signatures — core keeps these byte-compatible.
    spawnClaude: utils.spawnClaude,
    buildClaudeArgs: utils.buildClaudeArgs,
    secretStore,
    resolveHeadlessAuth: (authMode) => caps.resolveHeadlessAuth(home, authMode),
    resolveProviderKey: (providerKey) => caps.getProviderKey(home, providerKey),
    setProviderKey: (providerKey, apiKey) => caps.setProviderKey(home, providerKey, apiKey),
    // Whole key + model registry, for Pro's master→slave sync. exportKeyBundle
    // returns real API keys; only the peer control plane may carry it.
    exportKeyBundle: () => caps.exportKeyBundle(home),
    importKeyBundle: (bundle, opts) => caps.importKeyBundle(home, bundle, opts),
    listModels: () => caps.listModels(home),
    // The same catalog with the credential join already applied — every entry
    // carries { usable, unusableReason, credential }. Pro projects these through
    // publicModelShape rather than re-deriving availability from key presence.
    listModelsWithAvailability: () => caps.listModelsWithAvailability(home),
    resolveAuth: (authMode) => caps.resolveAuth(home, { authMode }),
    claudeAuthInfo: () => ({
      hasSubscription: caps.hasClaudeSubscription(),
      pref: caps.getClaudeAuthPref(home),
    }),
  };

  if (dashboard) {
    const { broadcaster, store, cliSessionManager, scheduleRestart, pendingQuestions, clearPendingQuestionsForTab, isOwnerRequest } = dashboard;
    // server.js resolves these itself (AUTH_TOKEN may be generated at boot
    // rather than read from env) — its values win over the raw environment.
    if (dashboard.authToken) shared.authToken = dashboard.authToken;
    if (dashboard.dashboardPort) shared.dashboardPort = dashboard.dashboardPort;
    if (dashboard.proxyPort) shared.proxyPort = dashboard.proxyPort;
    return Object.freeze({
      ...shared,
      broadcaster, store, cliSessionManager, scheduleRestart, pendingQuestions, clearPendingQuestionsForTab,
      isOwnerRequest,
      // Whether external (Telegram) login is configured — one of the signals
      // Pro's deployment-mode detection reads (spend policies differ by mode).
      tgLoginConfigured: typeof dashboard.tgLoginConfigured === 'function' ? dashboard.tgLoginConfigured : () => false,
      // Inspector session lifecycle for headless ai.prompt spawns: registering an
      // instanceId gives its interactions a persistent per-session timeline on
      // disk (data/interactions/<sessId>/), exactly like CLI tabs.
      // An explicit UUID lets a headless spawn share its timeline with the
      // interactive tab that later resumes the same Claude session (cli-<uuid>).
      registerAiSession: (instanceId, sessId) => {
        const id = (typeof sessId === 'string' && /^[0-9a-f-]{36}$/i.test(sessId)) ? sessId : crypto.randomUUID();
        store.registerSession(instanceId, id);
        return id;
      },
      unregisterAiSession: (instanceId) => {
        const sessId = store.sessionMap.get(instanceId);
        store.unregisterSession(instanceId);
        // A call that failed before any request leaves an empty session dir — drop it.
        if (sessId && !store.hasSessionContent(sessId)) store.deleteSessionData(sessId);
      },
    });
  }

  // Headless: fire-and-forget loopback relay to the dashboard's broadcaster.
  // No queue, no retry — dashboard events are ephemeral UI state.
  function relayBroadcast(msg) {
    if (!shared.authToken) return;
    fetch(`http://127.0.0.1:${shared.dashboardPort}/api/internal/broadcast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vistaclair-internal': shared.authToken },
      body: JSON.stringify(msg),
    }).catch(() => {});
  }
  return Object.freeze({
    ...shared,
    broadcaster: { broadcast: relayBroadcast },
    // Nothing served by a runner is an owner request: the dashboard already
    // authenticated what it reverse-proxies, and standalone apps are public.
    isOwnerRequest: () => false,
    tgLoginConfigured: () => false,
    // Inspector session registration is dashboard-process state; headless
    // spawns still work (the proxy tags them by instanceId), they just don't
    // get a persistent per-session timeline.
    registerAiSession: (instanceId, sessId) => (typeof sessId === 'string' && sessId) ? sessId : crypto.randomUUID(),
    unregisterAiSession: () => {},
  });
}

module.exports = { createAddonCtx, CONTRACT_VERSION };
