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
// the owner checks, orchestration runs, external sessions). The headless
// profile reaches the dashboard's broadcaster best-effort over loopback and
// stubs what only exists in the dashboard process: the runner keeps serving
// when core is down, it just loses live dashboard events and inspector
// timelines.
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
  const claudeAuth = require('./claude-auth');
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
    // The non-text (speech / transcription / image / …) model catalog — what
    // Pro's media calls resolve a `model` against. No secrets.
    listNativeModels: () => require('./native-models').listNativeModels(),
    // The registry refresh the Models page runs (provider scan + models.dev
    // catalog), for Pro's daily model review. Resolves { scan, catalog, catalogError }.
    refreshModels: () => caps.refreshModelRegistry(home),
    resolveAuth: (authMode) => caps.resolveAuth(home, { authMode }),
    // The `claude` CLI's login: hasSubscription, the dashboard's auth pref, and
    // the account `claude auth status` names (email, orgName: strings or null,
    // null while signed out) — for Pro to tell whether two machines share a
    // Claude account. No other field of the status, and never a credential.
    claudeAuthInfo: () => {
      const st = claudeAuth.authStatus.get();
      const account = (k) => (st?.loggedIn === true && typeof st[k] === 'string' && st[k] ? st[k] : null);
      return {
        hasSubscription: caps.hasClaudeSubscription(),
        pref: caps.getClaudeAuthPref(home),
        email: account('email'),
        orgName: account('orgName'),
      };
    },
  };

  if (dashboard) {
    const toolPacks = require('./tool-packs');
    const { broadcaster, store, cliSessionManager, openCli, sendToSession, scheduleRestart, pendingQuestions, clearPendingQuestionsForTab, isOwnerRequest, orchestration } = dashboard;
    // server.js resolves these itself (AUTH_TOKEN may be generated at boot
    // rather than read from env) — its values win over the raw environment.
    if (dashboard.authToken) shared.authToken = dashboard.authToken;
    if (dashboard.dashboardPort) shared.dashboardPort = dashboard.dashboardPort;
    if (dashboard.proxyPort) shared.proxyPort = dashboard.proxyPort;
    return Object.freeze({
      ...shared,
      broadcaster, store, cliSessionManager, scheduleRestart, pendingQuestions, clearPendingQuestionsForTab,
      isOwnerRequest,
      // isOwnerConnection(ws), for an add-on's WS message handler: true for an
      // open dashboard socket (each passed the owner check at its upgrade),
      // false for anything else (a closed or unknown socket, a non-object).
      isOwnerConnection: (ws) => (typeof broadcaster?.isOwnerConnection === 'function' ? broadcaster.isOwnerConnection(ws) : false),
      // External sessions (src/external-session.js): registerExternalSession(
      // tabId, adapter) shows a session running elsewhere (Pro's remote
      // sessions) as an Agent SDK tab — listed in cli:tabs with `external:
      // true`, announced as cli:spawned — and returns an idempotent
      // unregister() (cli:exit, then cli:tabs without it). adapter = { sessId,
      // kind: 'sdk', hidden?, title, settings, running, busy, state (read
      // live), submit(text, { images }), interrupt(), setModel(m),
      // setShowThinking(on), setAuth(auth, { continueTurn }), historyPage({
      // limit, before }) → an sdk:history page, kill(), close() (the tab's ×;
      // the add-on unregisters), orchestration?() → the run members GET
      // /api/orchestration/run answers for its settings.orchestration.runId }.
      // settings is untrusted: at most 16 KB as JSON, and only engine (always
      // 'sdk'), auth ('apikey' | 'subscription'), sessionDir (for sdk:todo;
      // kept only when it resolves, symlinks included, strictly inside
      // DATA_HOME), externalHost, model, showThinking (boolean), name,
      // modelMap ({ fable, opus, sonnet, haiku }) and orchestration ({ runId,
      // role, workerId, orchestrator, name }) survive, type-checked and capped.
      // orchestration() is consulted only for a runId none of core's own
      // sessions (live or saved) is stamped with; its answer must be that
      // run's (another runId is a 502), and members naming one of core's
      // sessions or an external tab outside the run (stamped with another
      // runId, or another externalHost) are dropped.
      // The tab's sdk:* / cli:* messages go to the adapter; any method may
      // return a promise, and its throw, rejection or silence past 30 s
      // (external-session.js CALL_TIMEOUT_MS; a late result is ignored)
      // reaches only the requesting browser. The add-on broadcasts the
      // session's sdk:event itself. Throws on a malformed adapter, a tabId
      // already in use or a sessId any live, saved or external session has.
      // A pendingQuestions entry for an external tab is tagged `external:
      // true, tabId` (sessId optional); core also counts as external an entry
      // carrying host / remote, or whose ctx.tabId is an external tab. Such an
      // ask is resolved only by an ask:answer naming its tabId (or sessId);
      // anything else gets ask:answerError, to the sender alone. Never
      // persisted, restored, paused or killed by core. Dashboard profile only.
      registerExternalSession: (tabId, adapter) => cliSessionManager.registerExternal(tabId, adapter),
      // Tool packs (src/tool-packs.js): MCP servers, disallowed tools and
      // prompt text an add-on adds to dashboard sessions — every session of a
      // pack's roles when `default`, else those whose settings.toolPacks names
      // it. registerToolPack(pack) throws on a malformed pack and returns its
      // unregister function; the add-on calls it (or unregisterToolPack(id)) in
      // shutdown()/update(). Packs listed in the descriptor's `toolPacks` are
      // dropped with the add-on instead. Dashboard profile only: headless
      // spawns are not dashboard sessions.
      // A pack may also declare `consumes` (['tools']: it handles a worker's
      // settings.grants.tools, the launch_cli / resume_worker `tools`),
      // `validate` (throws to refuse a worker launch) and `release` (once per
      // ended session it built for). toolPackFeatures names the optional pack
      // fields this core honours, for feature probing.
      registerToolPack: (pack) => toolPacks.registerToolPack(pack),
      unregisterToolPack: (id) => toolPacks.unregisterToolPack(id),
      listToolPacks: () => toolPacks.listToolPacks(),
      toolPackFeatures: toolPacks.TOOL_PACK_FEATURES,
      // sendToSession(address, text, { from }) delivers a message into a running
      // orchestration-run session by its messaging address, as SendMessage does,
      // shown as "[message from <from>] …" (e.g. from 'apps' when a long tool
      // job finished). Returns { delivered, how }: how is 'submitted' or
      // 'queued' (a busy terminal reads it at its next hook), or why not.
      // Dashboard profile only.
      sendToSession: typeof sendToSession === 'function' ? sendToSession : () => ({ delivered: false, how: 'unavailable' }),
      // The user-facing "new CLI" entry (src/orchestration.js): `mode` 'simple' |
      // 'orchestrator', or unset: an orchestrator for an Agent SDK session
      // (spawnOpts' resume dropped), asked for a terminal. Resolves { tabId, mode } or
      // { cancelled: true }. launchSession stays the never-asking primitive.
      openCli,
      // Orchestration runs (src/orchestration.js), frozen. listRuns() → every
      // run a live or saved session is stamped with: { runId, name ('orch-<runId>',
      // the orchestrator's address), title, cwd, engine ('cli' | 'sdk'), state,
      // busy, paused, pausing, orchestratorTabId (null while it has no tab),
      // orchestratorSessId, workerCount, updatedAt }, newest first.
      // describeRun(runId) → the run board's description, null for an unknown
      // run. pauseRun(runId), resumeRun(runId, { fresh }) and
      // refreshOrchestrator(runId) are the run board's own actions (WS
      // cli:pauseRun / cli:resumeRun / cli:refreshOrchestrator): same results,
      // and they throw what the board shows as an error.
      // setRunAuth(runId, auth ('apikey' | 'subscription'), { continueTurn })
      // and setRunModel(runId, model) switch a whole run: run.json (so workers
      // launched or restarted later, fresh or continued, inherit it), every
      // stopped member's saved entry, and every live member as its own tab's
      // switch would (setAuth with continueTurn, setModel; an external
      // member through its adapter; a live terminal cannot change its model
      // and is named in failed, starting on it at its next launch). Each
      // resolves { runId, auth | model, switched: [member name], failed:
      // [{ member, error }] } (setRunAuth also sessions, applied); it rejects,
      // having changed nothing, for an unknown run, an invalid auth or model,
      // a terminal run's billing and a missing credential (setAuth's message).
      // registerHostProvider({ hosts, launch, kill }) → { deliver(msg),
      // unregister() }: the machines a run's worker may run on (launch_cli
      // `host`). hosts() → [{ name, label, available, reason? }];
      // launch({ runId, address, title, task, host, app, model?, auth?,
      // orchestrator: { address, title } }) → { tabId } of a
      // registerExternalSession tab once the owner approved, or rejects with
      // .code 'declined' | 'refused' | 'unavailable' | 'invalid' | 'failed' |
      // 'cancelled' (any other: 'failed'); `auth` 'apikey' only when the run
      // bills the API key. kill({ runId, address }) stops a member, a pending
      // launch too. deliver({ runId, address, kind: 'report', status,
      // summary } | { runId, address, kind: 'message', text }) → true, or
      // false for an unknown run or member: the member's report / message to
      // its orchestrator, as a local worker's. SendMessage to the member is
      // its tab adapter's submit(text, { from }). One provider at a time: a
      // second registration replaces the first, whose handle goes inert;
      // unregister() is idempotent.
      // openMirrorRun({ key, orchestrator: { address, host }, deliver }) →
      // { runId, launchWorker, submit, interrupt, kill, close }: the slave
      // side, a run whose orchestrator is `address` on `host` (no local
      // orchestrator; the dashboard cannot start, resume, refresh or pause one).
      // The same key ([A-Za-z0-9._:-], ≤ 200) returns the same run, after a
      // restart too. launchWorker({ title, task, cwd (absolute), auth?, model?,
      // settings? (the caller's stamps and sessionsRoot) }) → { tabId, address
      // } of an SDK worker; deliver({ address, kind: 'report', status, summary
      // } | { address, kind: 'message', text }) gets its report and its
      // SendMessage to the orchestrator. submit(address, text, { from }),
      // interrupt(address), kill(address) act on a member; close() closes
      // every live member and the run (open the key again to reuse it).
      // Dashboard profile only.
      ...(orchestration ? {
        orchestration: Object.freeze({
          listRuns: () => orchestration.listRuns(),
          describeRun: (runId) => orchestration.describeRunById(runId),
          pauseRun: (runId) => orchestration.pauseRun(String(runId || '')),
          resumeRun: (runId, { fresh = false } = {}) => orchestration.resumeRun(String(runId || ''), { fresh: fresh === true }),
          refreshOrchestrator: (runId) => orchestration.refreshOrchestrator(String(runId || '')),
          setRunAuth: (runId, auth, { continueTurn = false } = {}) => orchestration.setRunAuth(String(runId || ''), auth, { continueTurn: continueTurn === true }),
          setRunModel: (runId, model) => orchestration.setRunModel(String(runId || ''), model),
          ...(typeof orchestration.registerHostProvider === 'function'
            ? { registerHostProvider: (provider) => orchestration.registerHostProvider(provider) } : {}),
          ...(typeof orchestration.openMirrorRun === 'function'
            ? { openMirrorRun: (opts) => orchestration.openMirrorRun(opts) } : {}),
        }),
      } : {}),
      // Dashboard login (src/login.js), frozen. Dashboard profile only: the
      // member is ABSENT in the headless profile.
      // registerProvider({ id, label, link(code) }) → unregister(): id matches
      // /^[a-z0-9-]{1,32}$/ (else throws); link(code) returns an https URL the
      // login page shows (as a QR code) next to the challenge code, or null
      // while the provider isn't ready (a throw counts as null).
      // describe(code) → { code, createdAt, expiresAt, ip, ua, status:
      // 'pending'|'approved'|'denied' } or null (unknown, expired or used).
      // approve(code, { via, who }) → { ok: true } | { ok: false, reason:
      // 'unknown'|'expired'|'used'|'denied' }: via matches /^[a-z0-9-]{1,32}$/,
      // who is free text (≤100 chars); both land on the session the browser
      // then redeems. deny(code) → boolean (the browser's poll gets 'denied').
      // listSessions() → [{ id, createdAt, expiresAt, ip, ua, via, who }],
      // revokeSession(id) → boolean, revokeAll().
      // onLogin(fn) → unsubscribe(): fn({ via, ip, ua, sessionId, code,
      // external }) after every successful login — via 'token' (sessionId
      // null), 'login-link', or the approver's via (code set only then);
      // external: not a truly-local caller. Listener errors are logged only.
      ...(dashboard.login ? { login: dashboard.login } : {}),
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
    isOwnerConnection: () => false,
    // Inspector session registration is dashboard-process state; headless
    // spawns still work (the proxy tags them by instanceId), they just don't
    // get a persistent per-session timeline.
    registerAiSession: (instanceId, sessId) => (typeof sessId === 'string' && sessId) ? sessId : crypto.randomUUID(),
    unregisterAiSession: () => {},
  });
}

module.exports = { createAddonCtx, CONTRACT_VERSION };
