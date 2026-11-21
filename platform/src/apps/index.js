const appManager = require('./app-manager');
const envDetect = require('./env-detect');
const appBridge = require('./app-bridge');
const appDb = require('./app-db');
const googleAuth = require('./google-auth');
const googleApi = require('./google-api');
const emailAccounts = require('./email-accounts');
const platformCron = require('./platform-cron');
const platformSettings = require('./platform-settings');
const platformExtras = require('./platform-extras');
const embeddings = require('./embeddings');
const memoryService = require('./memory-service');
const memoryMaintenance = require('./memory-maintenance');
const telegram = require('./telegram');
const platformTelegram = require('./platform-telegram');
const platformTgSession = require('./platform-tg-session');
const platformHorst = require('./platform-horst');
const whatsapp = require('./whatsapp');
const appIdentity = require('./app-identity');
const emailEngine = require('./email-engine');
const calendarEngine = require('./calendar-engine');
const tasksEngine = require('./tasks-engine');
const promptBuilder = require('./app-builder-prompt');
const hostConfig = require('./host-config');
const peerPairing = require('./peer-pairing');
const peerChannel = require('./peer-channel');
const publish = require('./publish');
const peerData = require('./peer-data');
const peerKeys = require('./peer-keys');
const spendPolicy = require('./spend-policy');
const spendLedger = require('./spend-ledger');
const spendContext = require('./spend-context');
const spendGate = require('./spend-gate');
const spendAdmin = require('./spend-admin');
const deploymentMode = require('./deployment-mode');
const appLifecycle = require('./app-lifecycle');
const appGuard = require('./app-guard');
const appChangeRequests = require('./app-change-requests');
const { SESSION_STAMPS } = appChangeRequests;
const cliWorkspace = require('./cli-workspace');
const fs = require('fs');
const path = require('path');

let broadcaster = null;
let cliSessionManager = null;
// Core's user-facing "new CLI" entry (ctx.openCli): asks Simple / Orchestrator
// when no mode is given. Absent in an older core — the launch is then simple,
// on the CLI.
let openCli = null;
let opts = {};

// This repository. A platform change request opens a session here, and the
// Telegram control bot already does (platform-tg-session.js).
const PRO_DIR = path.resolve(__dirname, '..', '..');

// A tools edit and an APP.md recreate are always simple sessions; every other
// action is the owner's Simple / Orchestrator choice.
const askableAction = (action) => action !== 'build-tools' && action !== 'recreate-appmd';

// Where an app session keeps its TODO.md / NOTES.md folder (core's session
// folders): inside the app's gitignored .vistaclair/, so the session writes it
// without leaving its cwd. Core's `settings.sessionsRoot` launch option.
const sessionsRoot = (appDir) => path.join(appDir, '.vistaclair', 'sessions');

// Trigger prompt for a `recreate-appmd` session — regenerates APP.md (and its detail
// files) from the source. Shared by the post-exit safety net, the manual recreate action,
// and the pre-flight that runs before a change session when APP.md is missing.
const RECREATE_APPMD_TRIGGER = 'Read all source files and create APP.md — the single source of truth for this app, structured exactly as the format in your instructions: Purpose, Architecture, Where to change what (a routing table from change type to the function + file to edit), Conventions & Invariants, Files, Functions & Sections (reference functions by name, never line numbers), Dependencies, State, UI Layout, and the Detail files index when outsourcing applies. A developer reading APP.md should be able to make changes without exploring the codebase.';

// Host-injected accessors for the canonical model registry (capabilities/models.json)
// and Claude auth state. Safe defaults so pro still loads under an older host.
let listModels = () => [];
let claudeAuthInfo = () => ({ hasSubscription: false, pref: '' });

// The dashboard UI's catalog (direct-model selector + pickModel picker) is the
// unfiltered `ai.models` payload — literally the same builder the bridge serves,
// so the dashboard pickers and the in-iframe <vc-model-picker> cannot disagree
// about a model's identity, provider label, sort position or usability.
function buildModelCatalog() {
  return require('./ai-service').modelsPayload({}).models;
}

function getDbInfo(appName) {
  const cfg = appDb.getConfig();
  if (!cfg || !appDb.isConfigured()) return { configured: false };
  const app = appDb.getAppDb(appName);
  if (!app) return { configured: true };
  return { configured: true, host: cfg.host, port: cfg.port, ...app };
}

// Core holds ONE exit callback per tab and clears it when it fires, so every
// Pro-side interest in a tab's exit (the APP.md pre-flight chain, the change
// request bookkeeping) is composed here behind a single registration. The list
// is cleared before the hooks run: a hook that launches the next session in the
// same tab registers its own hooks, and those must survive.
const exitHooks = new Map();

// Hooks run inside core's exit handling, which drops the tab from its session
// map only after them: a hook that relaunches on the same tab goes through
// relaunchAfterExit, or core removes the session it just started.
function addExitHook(tabId, fn) {
  if (!cliSessionManager) return;
  const existing = exitHooks.get(tabId);
  if (existing) { existing.push(fn); return; }
  exitHooks.set(tabId, [fn]);
  cliSessionManager.onExit(tabId, (id) => {
    const hooks = exitHooks.get(tabId) || [];
    exitHooks.delete(tabId);
    for (const hook of hooks) {
      try { hook(id || tabId); } catch (e) { console.error(`[app] exit hook failed for ${tabId}:`, e.message); }
    }
  });
}

function relaunchAfterExit(tabId, label, fn) {
  setImmediate(() => {
    try { fn(); } catch (e) { console.error(`${label} on ${tabId} failed:`, e.message); }
  });
}

// The APP.md recreate follow-up runs on the engine of the session that ended
// (`engine`, from openCli's result; unset → CLI), and an SDK one on its
// billing (`auth`).
function registerAppMdCheck(tabId, appName, action, engine, auth) {
  if (!cliSessionManager || !['build', 'extend', 'build-tools'].includes(action)) return;
  addExitHook(tabId, () => relaunchAfterExit(tabId, `[app:${appName}] APP.md recreate`, () => {
    const appMdPath = path.join(appManager.APPS_DIR, appName, 'APP.md');
    if (fs.existsSync(appMdPath)) return;
    const hasFiles = appManager.listAppFiles(appName).some(f => f !== 'manifest.json');
    if (!hasFiles) return;
    console.log(`[app:${appName}] APP.md missing after ${action} — auto-creating`);
    const manifest = appManager.readManifest(appName) || {};
    const systemPrompt = promptBuilder.buildPrompt('recreate-appmd', {
      appName,
      description: manifest.description || '',
      userRequest: '',
      proxyPort: opts.proxyPort,
      dbInfo: getDbInfo(appName),
    });
    const settingsFile = promptBuilder.writeSidecars(path.join(appManager.APPS_DIR, appName), {
      action: 'recreate-appmd', appName, description: manifest.description || '',
    });
    cliSessionManager.launchSession(tabId, {
      cwd: path.join(appManager.APPS_DIR, appName),
      title: appName,
      settings: {
        appendSystemPrompt: systemPrompt, settingsFile, [SESSION_STAMPS.app]: appName, sessionsRoot: sessionsRoot(path.join(appManager.APPS_DIR, appName)),
        engine: engine === 'sdk' ? 'sdk' : 'cli',
        ...(engine === 'sdk' && auth ? { auth } : {}),
      },
      prompt: RECREATE_APPMD_TRIGGER,
      autoSubmit: true,
    });
    if (broadcaster) broadcaster.broadcast({ type: 'app:cliSpawned', appName, tabId });
  }));
}

// The sessions Pro opens on its own — launchChangeSession, a platform change
// request — run in the Agent SDK panel, and nobody stands at a New CLI form to
// pick their billing: the Claude subscription whenever one is signed in, the
// API key only after the owner confirmed its costs. Resolves { auth },
// { declined: true }, or null when there is no SDK path (a core without
// openCli or resolveAuth, or no Claude credential at all): the caller then
// opens the CLI terminal as before.
async function sdkBilling({ title, cwd, tabId, what }) {
  if (!openCli || typeof opts.resolveAuth !== 'function') return null;
  let credential = null;
  try { credential = opts.resolveAuth('subscription')?.credential || null; } catch { credential = null; }
  if (credential === 'subscription') return { auth: 'subscription' };
  if (credential !== 'api-key') return null;
  return (await confirmApiKeyBilling({ title, cwd, tabId, what })) ? { auth: 'apikey' } : { declined: true };
}

// The owner's yes to API costs, asked the way core's askUser asks: an entry in
// ctx.pendingQuestions (the dashboard replays it after a reload and resolves it
// on ask:answer) and an `ask:question` broadcast. Bound to the tab, so the
// Telegram Mini App of a chat bound to it lists and answers it too. No way to
// ask, a cancel, or a cleared tab all read as no.
const API_KEY_OK = 'Open it on the API key';
let billingAskSeq = 0;
function confirmApiKeyBilling({ title, cwd, tabId, what }) {
  const pending = opts.pendingQuestions;
  if (!pending || typeof pending.set !== 'function' || !broadcaster) return Promise.resolve(false);
  const askId = `pro-billing-${Date.now()}-${++billingAskSeq}`;
  const questions = [{
    id: 'billing', type: 'select', header: 'API costs',
    question: `${what} opens an Agent SDK session. No Claude subscription is signed in, so it is billed per token to the Anthropic API key. Open it?`,
    defaultValue: 'Do not open',
    options: [
      { label: API_KEY_OK, description: 'Incurs API costs, to the key on the Models page.' },
      { label: 'Do not open', description: 'Nothing starts.' },
    ],
  }];
  const formData = { title: 'API costs', submitLabel: 'Continue', cancelLabel: 'Cancel', questions };
  const message = {
    type: 'ask:question', askId, toolUseIds: [askId],
    forms: [{ toolUseId: askId, formData, questions }],
    title, cwd, ...(tabId ? { tabId } : {}),
  };
  return new Promise((resolve) => {
    const settle = (ok) => {
      if (!pending.has(askId)) return;
      pending.delete(askId);
      try { broadcaster.broadcast({ type: 'ask:answered', askId }); } catch {}
      resolve(ok);
    };
    pending.set(askId, {
      formData, questions, message, ctx: { tabId },
      resolve: (answer) => settle(Array.isArray(answer)
        && !answer.some(a => a?.id === '_cancelled')
        && String(answer.find(a => a?.id === 'billing')?.answer || '') === API_KEY_OK),
      reject: () => settle(false),
    });
    broadcaster.broadcast(message);
  });
}

// A platform change request's session (app-change-requests.js): openCli on the
// billing above. Resolves openCli's result, { cancelled: true } when the owner
// declined API costs, or null for the CLI fallback.
async function openSdkSession({ what, ...launch }) {
  const billing = await sdkBilling({ title: launch.title, cwd: launch.cwd, tabId: launch.tabId, what });
  if (!billing) return null;
  if (billing.declined) return { cancelled: true, declined: true };
  return openCli({ ...launch, engine: 'sdk', auth: billing.auth });
}

// Launch a change/build session for an app — shared by the GUI (cli.edit), the
// Telegram control bot and change requests. An Agent SDK orchestrator through
// core's openCli (a hidden launch or a resume: one simple SDK session, since an
// orchestrator is never hidden and always starts fresh); the CLI terminal when
// there is no SDK path (sdkBilling). Handles the APP.md pre-flight recreate.
// Resolves { tabId, hidden, engine, auth }, or { tabId, cancelled: true } when
// nothing opened (the owner declined API costs). Throws if the CLI session
// manager is unavailable.
async function launchChangeSession(appName, params = {}) {
  if (!cliSessionManager) throw new Error('CLI session manager not available');
  const appDir = path.join(appManager.APPS_DIR, appName);
  const tabId = `app-${appName}`;
  const existingFiles = appManager.listAppFiles(appName);
  const hasContent = existingFiles.some(f => f !== 'manifest.json');
  const action = params.action || (hasContent ? 'extend' : 'build');
  const manifest = appManager.readManifest(appName) || {};

  const cliPrompt = params.prompt || undefined;
  const shouldAutoSubmit = !!params.autoSubmit;

  // Billing once: the recreate and the change it chains run on the same answer.
  const billing = await sdkBilling({
    title: appName, cwd: appDir, tabId,
    what: params.changeRequest ? `A change request from "${params.changeRequest.from}" on "${appName}"` : `A change session on "${appName}"`,
  });
  if (billing?.declined) return { tabId, cancelled: true };

  // One session on the app's tab. The stamp is what identifies it to change
  // requests once core has restored it under another id (app-change-requests.js,
  // callerOf); an orchestrator's workers inherit it with the prompt and the
  // read-ledger settings file. The run lives in the app's gitignored
  // .vistaclair/ and its workers share the app directory (the read ledger and
  // change-request identity are tied to it), so no worktrees — as app:spawnCli.
  // engine 'cli' on the fallback: also when the app's tab is still a live
  // Agent SDK session (core merges settings into it).
  const open = async (launch, mode) => {
    const settings = { ...launch.settings, [SESSION_STAMPS.app]: appName, sessionsRoot: sessionsRoot(appDir) };
    if (!billing) {
      // A plain session never carries the lean worker prompt (core drops it for a simple launch too).
      const { workerAppendSystemPrompt: _w, ...plain } = settings;
      cliSessionManager.launchSession(tabId, { ...launch, settings: { ...plain, engine: 'cli' } });
      return { tabId, engine: 'cli', auth: null };
    }
    return openCli({
      tabId, ...launch, settings, mode, engine: 'sdk', auth: billing.auth,
      runsDir: path.join(appDir, '.vistaclair', 'orchestrator'), isolation: 'none',
    });
  };

  // Launch the actual change session. The system prompt is rebuilt at call time so
  // that, when this runs after a pre-flight recreate, it captures the freshly written
  // APP.md (buildPrompt reads it via appManager.readAppMd).
  const launchChange = async () => {
    const promptArgs = {
      appName,
      description: params.prompt || manifest.description || '',
      userRequest: params.prompt || '',
      proxyPort: opts.proxyPort,
      dbInfo: getDbInfo(appName),
    };
    let changePrompt = promptBuilder.buildPrompt(action, promptArgs);
    // An orchestration run (an SDK launch that is neither hidden nor a resume)
    // gives its workers the lean prompt, the orchestrator the full one. Extend only.
    const leanWorkers = !!billing && !params.hidden && !params.resumeSessionId && promptBuilder.hasWorkerProfile(action);
    let workerPrompt = leanWorkers ? promptBuilder.buildPrompt(action, { ...promptArgs, profile: 'worker' }) : '';
    // This session was opened by another app's change request: it is told who
    // asked, what interface to deliver, whether it may ask a third app in turn,
    // and how to report completion.
    if (params.changeRequest) {
      const section = appChangeRequests.targetPromptSection(params.changeRequest);
      changePrompt += section;
      if (workerPrompt) workerPrompt += section;
    }
    const settingsFile = promptBuilder.writeSidecars(appDir, {
      action, appName, userRequest: params.prompt || '', description: params.prompt || manifest.description || '',
      ...(leanWorkers ? { profile: 'worker' } : {}),
    });
    const res = await open({
      cwd: appDir,
      title: appName,
      settings: { appendSystemPrompt: changePrompt, ...(workerPrompt ? { workerAppendSystemPrompt: workerPrompt } : {}), settingsFile },
      prompt: cliPrompt,
      autoSubmit: shouldAutoSubmit,
      hidden: !!params.hidden,
      // A change request's outcome reopens the asking session on its own
      // transcript; core throws when that transcript is gone.
      ...(params.resumeSessionId ? { spawnOpts: { resumeSessionId: params.resumeSessionId } } : {}),
    }, params.hidden || params.resumeSessionId ? 'simple' : 'orchestrator');
    if (!res.cancelled) registerAppMdCheck(tabId, appName, action, res.engine, res.auth);
    return res;
  };

  // Pre-flight: a change flow must never run against missing documentation. If the app
  // has source but no APP.md, generate it first (visible, simple), then auto-run the change.
  const appMdMissing = action !== 'build'
    && hasContent
    && !fs.existsSync(path.join(appDir, 'APP.md'));

  if (appMdMissing) {
    const recreatePrompt = promptBuilder.buildPrompt('recreate-appmd', {
      appName,
      description: manifest.description || '',
      userRequest: '',
      proxyPort: opts.proxyPort,
      dbInfo: getDbInfo(appName),
    });
    const settingsFile = promptBuilder.writeSidecars(appDir, {
      action: 'recreate-appmd', appName, description: manifest.description || '',
    });
    const res = await open({
      cwd: appDir,
      title: appName,
      settings: { appendSystemPrompt: recreatePrompt, settingsFile },
      prompt: RECREATE_APPMD_TRIGGER,
      autoSubmit: true,
      hidden: false,
    }, 'simple');
    if (res.cancelled) return { tabId, cancelled: true };
    // Exit hooks fire once then clear (addExitHook), so chaining the change
    // launch here is safe — the recreate session ends, then the change runs.
    addExitHook(tabId, () => relaunchAfterExit(tabId, `[app:${appName}] change launch after recreate`, () => {
      launchChange().catch(e => console.error(`[app:${appName}] change launch after recreate failed:`, e.message));
    }));
    if (broadcaster) broadcaster.broadcast({ type: 'app:cliSpawned', appName, tabId });
    // The recreate session that precedes a change in a doc-less app is always
    // visible and already announced above.
    return { tabId, hidden: false, engine: res.engine, auth: res.auth || null };
  }

  const res = await launchChange();
  if (res.cancelled) return { tabId, cancelled: true };
  // `hidden`: no tab was opened.
  return { tabId, hidden: !!params.hidden, engine: res.engine, auth: res.auth || null };
}

// The wiring the launchers above need — the session manager, the broadcaster,
// the apps directory and the host options — set apart from the rest of boot so
// a launch can be exercised against a mock session manager without starting the
// engines, the cron jobs and the peer channel.
function initSessions(options = {}) {
  opts = options;
  broadcaster = options.broadcaster || null;
  cliSessionManager = options.cliSessionManager || null;
  openCli = typeof options.openCli === 'function' ? options.openCli : null;
  exitHooks.clear();   // registrations belong to the previous session manager
  if (options.appsDir) appManager.setAppsDir(options.appsDir);
  cliWorkspace.init({ cliSessionManager, broadcaster, addExitHook });
}

function init(options) {
  initSessions(options);
  if (typeof options.listModels === 'function') listModels = options.listModels;
  if (typeof options.claudeAuthInfo === 'function') claudeAuthInfo = options.claudeAuthInfo;
  if (options.coreDir) appManager.setCoreDir(options.coreDir);
  hostConfig.init(appManager.APPS_DIR, { dataHome: options.dataHome || path.join(appManager.APPS_DIR, '..', 'data') });
  appManager.setBridgeCleanup((name) => appBridge.cleanupApp(name));
  appBridge.init({ proxyPort: options.proxyPort, spawnClaude: options.spawnClaude, buildClaudeArgs: options.buildClaudeArgs, broadcaster, secretStore: options.secretStore, resolveHeadlessAuth: options.resolveHeadlessAuth, resolveProviderKey: options.resolveProviderKey, listModels, listModelsWithAvailability: options.listModelsWithAvailability, listNativeModels: options.listNativeModels, refreshModels: options.refreshModels, registerAiSession: options.registerAiSession, unregisterAiSession: options.unregisterAiSession, store: options.store, dashboardPort: options.dashboardPort, authToken: options.authToken, getProxySecret: options.getProxySecret, proxySecretHeader: options.proxySecretHeader });
  // The prompt advertises only callable models, so it reads the registry through
  // the same credential join the pickers do — not raw listModels.
  promptBuilder.setModelSource(() => require('./ai-service').listModelsResolved());
  // Shared app-lifecycle mutations (create/delete/rename/setConfig): one
  // implementation for the owner's WS clicks AND the governed app.* kinds.
  appLifecycle.init({
    cliSessionManager,
    rebuildPublicExemptions: options.rebuildPublicExemptions,
  });
  // Phase 6 (G8): the server.restart kind's executor. scheduleRestart is a
  // core-ctx function only this process holds, so it registers as a governance
  // launcher (same doctrine as telegram.send) — the kind itself lives in
  // capabilities/sysmon.js, ceiling-pinned to propose.
  if (typeof options.scheduleRestart === 'function') {
    require('./governance/horst-governance').registerLauncher('server.restart', () => {
      options.scheduleRestart();
      return { ok: true, summary: 'Server restart scheduled' };
    });
  }
  appDb.init(appManager.APPS_DIR);
  platformSettings.init(appManager.APPS_DIR);
  platformExtras.init({ appsDir: appManager.APPS_DIR, broadcaster, secretStore: options.secretStore });
  emailAccounts.init(appManager.APPS_DIR, options.secretStore);
  emailEngine.init(appManager.APPS_DIR, options.secretStore, broadcaster);
  calendarEngine.init(appManager.APPS_DIR, options.secretStore, broadcaster);
  tasksEngine.init(appManager.APPS_DIR, broadcaster);
  telegram.init(appManager.APPS_DIR, options.secretStore, broadcaster);
  appIdentity.init(appManager.APPS_DIR, options.secretStore);
  // Platform-owner recognition (owner auto-login): a request carrying valid
  // OWNER credentials (dashboard cookie / internal header) resolves as the app
  // admin. The check is core's ctx.isOwnerRequest (src/auth.js) — full
  // credential re-validation, so it is safe even on auth-exempt (public-app) paths.
  appManager.setOwnerCheck(options.isOwnerRequest);
  platformTelegram.init(options.authToken, { appManager, scheduleRestart: options.scheduleRestart });
  // Dashboard QR login through the control bot (core's ctx.login; absent on an
  // older core and in the runner — then inert).
  require('./platform-login').init({ login: options.login || null });
  platformTgSession.init({
    cliSessionManager,
    store: options.store,
    secretStore: options.secretStore,
    broadcaster,
    appsDir: appManager.APPS_DIR,
    proDir: PRO_DIR,
    appManager,
    launchChangeSession,
    scheduleRestart: options.scheduleRestart,
    pendingQuestions: options.pendingQuestions || new Map(),
    clearPendingQuestionsForTab: options.clearPendingQuestionsForTab || (() => {}),
    // Core's run board (dashboard profile; feature-detected in
    // platform-tg-runs.js — absent, the Telegram run features are off).
    orchestration: options.orchestration || null,
    isOwnerRequest: options.isOwnerRequest,
    controlChatId: () => platformHorst.controlChatId(),
  });
  // A standalone app's runner process is the sole consumer of its bot's
  // getUpdates — the dashboard must never poll it (Telegram 409s on two
  // consumers). Same ownership rule for the jobs boot sweep below.
  // Dashboard-managed own-process apps are hosted by an app-runner child
  // that owns their bot poll + jobs the same way (app-runner scopes both to
  // just that app), so the dashboard excludes them identically.
  const inThisProcess = appManager.runsInDashboardProcess;
  telegram.start(inThisProcess);
  whatsapp.init(appManager.APPS_DIR, options.secretStore, broadcaster);
  whatsapp.start();
  platformCron.init({
    appsDir: appManager.APPS_DIR,
    appManager,
    broadcaster,
    spawnClaude: options.spawnClaude,
    buildClaudeArgs: options.buildClaudeArgs,
    proxyPort: options.proxyPort,
    authToken: options.authToken,
  });
  // Persistent per-app jobs (ctx.jobs / jobs.* bridge): marks records left
  // 'running' by the previous process as 'interrupted'.
  require('./app-jobs').init({ appsDir: appManager.APPS_DIR, broadcaster, appFilter: inThisProcess });
  // Attributed app failures (runtime errors outside requests, crash loops) —
  // feeds app status, the dashboard and Horst's app:error / app:crashloop senses.
  appGuard.init({ broadcaster });
  // Sites: children of this process (docs/sites.md); autostarted below.
  require('./sites').init({
    broadcast: (m) => broadcaster.broadcast(m),
    dashboardPort: require('./core-services').core.dashboardPort,
    proxyPort: require('./core-services').core.proxyPort,
    isEnabled: (n) => hostConfig.isEnabled(n),
  });
  // Site analytics (docs/analytics.md): ingests the sites' spools, answers query/live/csv.
  require('./analytics').init({ broadcast: (m) => broadcaster.broadcast(m) });

  // --- Spend policy + ledger (admin-owned, under core's dataHome). Every
  // metered platform call is ledgered and gated (spend-gate) wherever it
  // entered; LLM cost is settled per request from the proxy's
  // interaction:complete broadcast. Existing apps are migrated to `unlimited`
  // once (previous behaviour) and flagged for review. ---
  try {
    const dataHome = options.dataHome || path.join(appManager.APPS_DIR, '..', 'data');
    spendPolicy.init({ dataHome });
    spendLedger.init({ dataHome, store: options.store });
    spendContext.init({ isOwnerRequest: options.isOwnerRequest });
    deploymentMode.init({ hostConfig, appManager });
    spendPolicy.migrateHost();
    const migrated = spendPolicy.migrate(appManager.list().map((a) => a.name));
    if (migrated.length) console.log(`  Spend: migrated ${migrated.length} app(s) to an unlimited policy — review in Apps → Spend`);
    if (broadcaster && typeof broadcaster.onBroadcast === 'function') {
      broadcaster.onBroadcast((msg) => {
        if (msg && msg.type === 'interaction:complete' && msg.interaction) {
          try { spendGate.settleInteraction(msg.interaction); } catch (err) { console.warn('[spend] settle failed:', err.message); }
        } else if (msg && msg.type === 'app:spend:record' && msg.entry && msg.entry.app) {
          // Relayed from a process-isolated app runner (spend-ledger relay mode).
          try { spendLedger.record({ ...msg.entry, appDir: path.join(appManager.APPS_DIR, msg.entry.app) }); } catch {}
        }
      });
      spendGate.setTapActive(true);
    }
    // Alerts to the dashboard (Spend Alerts panel + toast); Horst's senses
    // subscribe separately through the capability facet.
    spendGate.observe((ev) => {
      if (!['exhausted', 'threshold', 'anomaly', 'unattributed', 'blocked', 'storage-breach'].includes(ev.type)) return;
      if (ev.type === 'blocked' && ev.enforced === false) return;
      // Spread first: ev carries its own `type` (the alert kind), which must
      // not clobber the envelope type or no client ever dispatches the alert.
      broadcaster.broadcast({ at: Date.now(), ...ev, kind: ev.type, type: 'app:spend:alert' });
    });
  } catch (err) { console.warn('[apps] spend init failed:', err.message); }

  // --- Cross-app change requests: a change session on one app asks the owner
  // to open a change session on another, and is told the outcome. ---
  try {
    const dataHome = options.dataHome || path.join(appManager.APPS_DIR, '..', 'data');
    appChangeRequests.init({
      dataHome,
      cliSessionManager,
      launchChangeSession,
      openSdkSession,
      proDir: PRO_DIR,
      broadcaster,
      appManager,
      settings: platformSettings,
      addExitHook,
    });
  } catch (err) { console.warn('[apps] change requests init failed:', err.message); }

  // --- App→app dependency edges: which app may call which app's tools. Seeds
  // an empty <dataHome>/app-deps.json; registrations and contract changes
  // re-judge the approved edges (broken → a toast). ---
  try {
    const dataHome = options.dataHome || path.join(appManager.APPS_DIR, '..', 'data');
    const appDeps = require('./app-deps');
    appDeps.init({
      dataHome, broadcaster, appManager, settings: platformSettings,
      onChange: (edge) => { try { require('./doc-copies').scheduleCrossApp(edge ? edge.provider : null); } catch {} },
    });
    if (broadcaster && typeof broadcaster.onBroadcast === 'function') broadcaster.onBroadcast((msg) => appDeps.observeBroadcast(msg));
  } catch (err) { console.warn('[apps] app deps init failed:', err.message); }

  // --- MCP broker (phase 2): the live app-tool union served as a scoped MCP
  // server for owner-class AIs. The session index persists under dataHome so a
  // dashboard restart / GUI reload never orphans a connected consumer. ---
  try {
    const dataHome = options.dataHome || path.join(appManager.APPS_DIR, '..', 'data');
    require('./mcp-broker').init({ dir: path.join(dataHome, 'mcp-broker') });
  } catch (err) { console.warn('[apps] mcp broker init failed:', err.message); }

  // --- Artifact store: files app tools hand out as vc-artifact:// refs.
  // gc once at boot (deferred off the boot path) and daily (artifacts:gc). ---
  try {
    const dataHome = options.dataHome || path.join(appManager.APPS_DIR, '..', 'data');
    const artifacts = require('./app-artifacts');
    artifacts.init({ dir: path.join(dataHome, 'artifacts') });
    setTimeout(() => { try { artifacts.gc(); } catch (err) { console.warn('[artifacts] boot gc failed:', err.message); } }, 30e3).unref();
  } catch (err) { console.warn('[apps] artifact store init failed:', err.message); }
  platformCron.registerInternal('artifacts.gc', () => require('./app-artifacts').gc());

  // Job-kind app tools: the tool-job ledger under dataHome. Its boot sweep
  // turns jobs the previous process left running into 'interrupted' and
  // delivers them; outcomes reach agent callers through core's sendToSession.
  try {
    const dataHome = options.dataHome || path.join(appManager.APPS_DIR, '..', 'data');
    require('./app-tool-jobs').init({ dataHome, sendToSession: options.sendToSession });
  } catch (err) { console.warn('[apps] tool jobs init failed:', err.message); }

  // Platform-doc copies in each app's .vistaclair/ (api/, apps/): refreshed
  // after an app's tools or the app set change (debounced), and at boot below.
  try { require('./doc-copies').init({ broadcaster }); } catch (err) { console.warn('[apps] doc copies init failed:', err.message); }

  // App tools for orchestration runs: the catalog pack (orchestrators) and the
  // grant pack (workers) on core's tool-pack seam, feature-probed.
  try { require('./app-tool-packs').register(options); } catch (err) { console.warn('[apps] app-tool packs failed:', err.message); }

  // One host monitor for every app (sysmon.* / ctx.sysmon / <vc-sysmon>). Idle
  // until an app subscribes, so wiring it here costs nothing.
  require('./platform-sysmon').init({ appsDir: appManager.APPS_DIR, appManager, broadcaster });

  // Local printing (ctx.print, Setup → Drucker): state file beside the other platform stores; CUPS is only asked on demand.
  require('./platform-print').init({ appsDir: appManager.APPS_DIR });

  // --- Embeddings (shared local model: memory + apps via ctx.embed) ---
  embeddings.init(appManager.APPS_DIR);

  // --- Media ffmpeg (ai.transcribe preprocessing). Resolves system ffmpeg vs
  // bundled fallback at boot, and kicks off a background apt install of the full
  // ffmpeg suite (incl. ffprobe for apps) when the system binary is missing. ---
  try { require('./media-ffmpeg').init(); } catch (e) { console.warn('[apps] media-ffmpeg init failed:', e.message); }

  // --- Silero VAD (speech-activity detection for ai.transcribe silence trim).
  // Caches the ~2 MB ONNX model under appsDir/.vad-cache; warm in the background
  // so the first transcribe call doesn't pay the load/download cost. ---
  try {
    const vad = require('./silero-vad');
    vad.init(appManager.APPS_DIR);
    vad.warm();
  } catch (e) { console.warn('[apps] silero-vad init failed:', e.message); }

  // --- Memory system ---
  memoryMaintenance.init(appManager.APPS_DIR);
  // Internal cron handlers (in-process, persisted, idle-gated). Registered
  // unconditionally so persisted jobs resolve at boot; each no-ops until the DB
  // is connected and the schema is ready.
  platformCron.registerInternal('memory.consolidate', () => memoryMaintenance.runConsolidate());
  platformCron.registerInternal('memory.decay', () => memoryMaintenance.runDecay());
  platformCron.registerInternal('memory.compact', () => memoryMaintenance.runCompact());
  platformCron.registerInternal('memory.archive', () => memoryMaintenance.runArchive());
  // --- Email + calendar engines (same deferred pattern as memory) ---
  platformCron.registerInternal('email.gmail-poll', () => emailEngine.runGmailPoll());
  platformCron.registerInternal('email.imap-reconcile', () => emailEngine.runImapReconcile());
  platformCron.registerInternal('email.embed-sweep', () => emailEngine.runEmbedSweep());
  platformCron.registerInternal('email.delete-sweep', () => emailEngine.runDeleteSweep());
  platformCron.registerInternal('calendar.sync', () => calendarEngine.runSync());
  // Storage sizer (spend policy `storage.dailyMB` caps — see storage-meter.js).
  platformCron.registerInternal('spend.storage-sweep', () => require('./storage-meter').sweep());
  // --- Horst (built-in resident agent — registers horst.* internal handlers
  // and its heartbeat/briefing jobs; JSON-backed, so no DB gate needed) ---
  try { platformHorst.init({ appsDir: appManager.APPS_DIR, broadcaster, launchChangeSession }); }
  catch (e) { console.warn('[apps] Horst init failed:', e.message); }
  // --- Master/slave peering + publishing (host role, pairing, publish jobs).
  // Pairing registers its governance kind, so it inits after Horst.
  peerPairing.init({ appsDir: appManager.APPS_DIR, secretStore: options.secretStore, broadcaster });
  // Master→slave key/model sync. The host injects the core's key-bundle
  // accessors (absent on older host builds — the sync then reports 501).
  peerKeys.init({ exportKeyBundle: options.exportKeyBundle, importKeyBundle: options.importKeyBundle, broadcaster });
  publish.init({ broadcaster });
  // Fleet data publish (docs/fleet-data.md): the slave's inbox sweep (boot +
  // hourly) and the master's transfers, resumed from their persisted state.
  try { require('./fleet-data-receive').init({ appsDir: appManager.APPS_DIR }); } catch (e) { console.warn('[apps] fleet data inbox init failed:', e.message); }
  try { require('./fleet-data').init({}); } catch (e) { console.warn('[apps] fleet data init failed:', e.message); }
  // The up direction (docs/fleet-data-up.md): the master answers its slaves'
  // channel requests and pushes their records; a slave re-syncs on connect.
  try { require('./fleet-data-up').init({}); } catch (e) { console.warn('[apps] fleet data up init failed:', e.message); }
  // Their progress reaches the app's iframe as fleet:data:progress / :done
  // bridge events (the job:update path; the shape is the fleet capability's).
  // Fleet remote call / job (docs/fleet-remote.md): the slave's handler
  // registry pushes its remote jobs' progress; the master's records resume and
  // re-sync from the slave when its channel comes up.
  try { require('./fleet-remote-host').init({}); } catch (e) { console.warn('[apps] fleet remote host init failed:', e.message); }
  try { require('./fleet-remote').init({ broadcaster }); } catch (e) { console.warn('[apps] fleet remote init failed:', e.message); }
  try { require('./capabilities').get('fleet').wireAppEvents(broadcaster); } catch (e) { console.warn('[apps] fleet data app events failed:', e.message); }
  // Persistent peer channel (phase 5): on a master this opens one outbound WS
  // per linked slave (fleet senses + live fleet state); on a slave the
  // descriptor's handleUpgrade drives it. Inits after Horst so the fleet
  // facet's onEvent listeners are already registered.
  peerChannel.init({ broadcaster });
  // Remote sessions, slave side: the master's rs:cmd ops over the channel
  // above, behind this host's own opt-in (peer-remote-slave.js).
  require('./peer-remote-slave').init({
    broadcaster, cliSessionManager, openCli,
    pendingQuestions: options.pendingQuestions, clearPendingQuestionsForTab: options.clearPendingQuestionsForTab,
    resolveAuth: options.resolveAuth, claudeAuthInfo: options.claudeAuthInfo,
    appsDir: appManager.APPS_DIR, proDir: PRO_DIR, coreDir: options.coreDir,
    orchestration: options.orchestration || null,
  });
  if (hostConfig.isSlave()) console.log(`  Apps: SLAVE mode — hosting [${(hostConfig.enabledApps() || []).join(', ') || 'none'}]`);
  // Schema init is deferred — appDb.init() auto-connects asynchronously. Once
  // the connect attempt settles, build the schema and ensure the cron jobs exist.
  appDb.ready().then(async () => {
    updateBootStatus({ db: appDb.getPool() ? 'connected' : 'failed' });
    initMemory();
    initMailEngines();
    initTasksEngine();
    ensureStorageJob();
    ensureArtifactsJob();
    require('./platform-extras-unity-license').start();
    await require('./sites').autostartAll().catch(err => console.warn('[sites] autostart failed:', err.message));
    // Analytics: the platform crons (daily rollup/prune, monthly country table) and a first ingest of
    // whatever the spools collected while the dashboard was down.
    try { require('./analytics').registerCron(platformCron); } catch (err) { console.warn('[analytics] cron setup failed:', err.message); }
    require('./analytics').scanAll().catch(() => {});
    await autostartApps();
    // After autostart, so the copies carry the live tool registry.
    try { require('./doc-copies').bootRefresh(); } catch (err) { console.warn('[apps] doc copies refresh failed:', err.message); }
    // Warm the connectivity cache as the last boot stage so the first GUI
    // connect gets results instantly instead of triggering a live check.
    await runConnectivityCheck().catch(() => {});
    updateBootStatus({ phase: 'ready' });
  });

  broadcaster.registerHandler('app:', { onConnect, handleMessage });

  // Remote sessions, master half (docs/remote-sessions.md): Agent SDK sessions
  // launched on a slave and shown here. Its own handler prefixes (the longest
  // match wins), so app:peer:session:* / app:peer:remoteAlert:* never reach
  // handleMessage; core's
  // registerExternalSession / isOwnerConnection are feature-detected.
  try {
    const peerRemoteMaster = require('./peer-remote-master');
    peerRemoteMaster.init({
      broadcaster,
      pendingQuestions: options.pendingQuestions,
      registerExternalSession: options.registerExternalSession,
      isOwnerConnection: options.isOwnerConnection,
      claudeAuthInfo: options.claudeAuthInfo,
      dataHome: options.dataHome || path.join(appManager.APPS_DIR, '..', 'data'),
      isSlave: () => hostConfig.isSlave(),
    });
    // Remote workers: core's host provider for launch_cli({ host })
    // (peer-remote-host.js; registerHostProvider is feature-detected).
    const peerRemoteHost = require('./peer-remote-host');
    peerRemoteHost.init({
      orchestration: options.orchestration,
      broadcaster,
      isOwnerConnection: options.isOwnerConnection,
      dataHome: options.dataHome || path.join(appManager.APPS_DIR, '..', 'data'),
      isSlave: () => hostConfig.isSlave(),
    });
    const sender = (ws) => (m) => { try { ws.send(JSON.stringify(m)); } catch {} };
    broadcaster.registerHandler(['app:peer:session', 'app:peer:remoteAlert'], {
      onConnect: (ws) => { if (!hostConfig.isSlave()) peerRemoteMaster.onConnect(sender(ws)); },
      handleMessage: (ws, msg) => (msg?.type === 'app:peer:session:joinRuns' ? peerRemoteHost : peerRemoteMaster).handleWs(ws, msg, sender(ws)),
    });
  } catch (err) { console.warn('[apps] remote sessions init failed:', err.message); }

  const env = envDetect.detect();
  console.log(`  Apps: ${env.distro} (${env.arch})${env.hasVirtualDisplay ? ' + virtual display' : ''}`);

}

// Start every app whose manifest has autostart: true. Runs at boot (and thus
// after a server restart); failures are logged but never block init.
async function autostartApps() {
  // On a slave the enabled-apps allowlist (.host.json) decides which
  // master-published apps run here; the slave owner's own local apps follow
  // their manifest.autostart like on any host.
  const shouldRun = (app) => hostConfig.isSlave()
    ? (appManager.isMasterDeployed(app.name) ? hostConfig.isEnabled(app.name) : app.autostart)
    : app.autostart;
  const toStart = appManager.list().filter((app) =>
    app.standalone !== true // standalone apps are hosted by their own app-runner process
    && shouldRun(app) && !app.running && !app._starting);
  updateBootStatus({ apps: { state: toStart.length ? 'starting' : 'done', done: 0, total: toStart.length, current: toStart[0]?.name || null } });
  let done = 0;
  for (const app of toStart) {
    updateBootStatus({ apps: { state: 'starting', done, total: toStart.length, current: app.name } });
    try {
      await appManager.startApp(app.name, broadcaster);
      console.log(`  Apps: autostarted "${app.name}"`);
    } catch (err) {
      console.warn(`  Apps: autostart of "${app.name}" failed: ${err.message}`);
    }
    done++;
  }
  updateBootStatus({ apps: { state: 'done', done, total: toStart.length, current: null } });
  broadcaster.broadcast({ type: 'app:list', apps: appManager.list() });
}

// Build the memory schema once the DB pool is up (callers await appDb.ready()
// first), then register the maintenance cron jobs.
async function initMemory() {
  // DB not connected — memory stays dormant until a db:connect re-inits it.
  if (!appDb.getPool()) return;
  const ok = await memoryService.init(appManager.APPS_DIR);
  if (ok) ensureMemoryJobs();
}

// Build the tasks schema once the DB pool is up (same deferred pattern).
async function initTasksEngine() {
  if (!appDb.getPool()) return;
  await tasksEngine.initSchema().catch((err) => console.warn('  Tasks engine: schema init failed:', err.message));
  await require('./agent/horst-artifacts').initSchema().catch((err) => console.warn('  Artifacts: schema init failed:', err.message));
}

// Build the mail/calendar schema once the DB pool is up, then register the
// engine cron jobs and start the IMAP IDLE connections (in-process push).
async function initMailEngines() {
  // DB not connected — engines stay dormant until a db:connect re-inits.
  if (!appDb.getPool()) return;
  const ok = await emailEngine.initSchema();
  if (!ok) return;
  // The calendar owns its own DDL, in the same database. It runs second because
  // it needs that database to exist and reads the mail engine's vector probe.
  await calendarEngine.initSchema().catch((err) => console.warn('  Calendar engine: schema init failed:', err.message));
  ensureMailJobs();
  try { require('./email-sync-gmail'); } catch (e) { console.error('  Email engine: Gmail provider load failed:', e.message); }
  try { require('./email-sync-imap').start(); } catch (e) { console.error('  Email engine: IMAP start failed:', e.message); }
  try { require('./email-embed'); } catch (e) { console.error('  Email engine: embed provider load failed:', e.message); }
}

// Register engine jobs if absent (dedup-by-name, same as ensureMemoryJobs).
function ensureMailJobs() {
  const existing = new Set(platformCron.list().map((j) => j.name));
  const jobs = [
    { name: 'email:gmail-poll', schedule: emailEngine.getSetting('gmailPollSchedule'), handler: 'email.gmail-poll' },
    { name: 'email:imap-reconcile', schedule: emailEngine.getSetting('reconcileSchedule'), handler: 'email.imap-reconcile' },
    { name: 'email:embed-sweep', schedule: emailEngine.getSetting('embedSweepSchedule'), handler: 'email.embed-sweep' },
    { name: 'email:delete-sweep', schedule: emailEngine.getSetting('deleteSweepSchedule'), handler: 'email.delete-sweep' },
    { name: 'calendar:sync', schedule: calendarEngine.getSetting('syncSchedule'), handler: 'calendar.sync' },
  ];
  for (const j of jobs) {
    if (existing.has(j.name)) continue;
    const res = platformCron.addJob({ name: j.name, schedule: j.schedule, target: { type: 'internal', handler: j.handler } });
    if (!res.ok) console.error(`  Email engine: failed to register ${j.name}: ${res.error}`);
  }
}

// The storage sizer (spend-policy storage caps): hourly, dedup-by-name like
// the engine jobs. Cheap — one batched `du` plus one information_schema query.
function ensureStorageJob() {
  const existing = new Set(platformCron.list().map((j) => j.name));
  if (existing.has('spend:storage-sweep')) return;
  const res = platformCron.addJob({ name: 'spend:storage-sweep', schedule: '0 * * * *', target: { type: 'internal', handler: 'spend.storage-sweep' } });
  if (!res.ok) console.error(`  Spend: failed to register storage sweep: ${res.error}`);
}

// The artifact store's daily gc (retention + orphan blobs), dedup-by-name.
function ensureArtifactsJob() {
  const existing = new Set(platformCron.list().map((j) => j.name));
  if (existing.has('artifacts:gc')) return;
  const res = platformCron.addJob({ name: 'artifacts:gc', schedule: '30 3 * * *', target: { type: 'internal', handler: 'artifacts.gc' } });
  if (!res.ok) console.error(`  Artifacts: failed to register gc: ${res.error}`);
}

function ensureMemoryJobs() {
  const existing = new Set(platformCron.list().map((j) => j.name));
  const jobs = [
    { name: 'memory:consolidate', schedule: platformSettings.get('memoryConsolidateSchedule'), handler: 'memory.consolidate' },
    { name: 'memory:decay', schedule: platformSettings.get('memoryDecaySchedule'), handler: 'memory.decay' },
    { name: 'memory:compact', schedule: platformSettings.get('memoryCompactSchedule'), handler: 'memory.compact' },
    { name: 'memory:archive', schedule: platformSettings.get('memoryArchiveSchedule'), handler: 'memory.archive' },
  ];
  for (const j of jobs) {
    if (existing.has(j.name)) continue;
    const res = platformCron.addJob({ name: j.name, schedule: j.schedule, target: { type: 'internal', handler: j.handler } });
    if (!res.ok) console.error(`  Memory: failed to register ${j.name}: ${res.error}`);
  }
}

// The live tool list per app (the manifest's when the app is not running).
// Sent on connect and again on the GUI's own `app:list` request: Pro's
// apps.js loads after the socket opens, so the connect-time copies can arrive
// before its `app:` handler exists and be dropped.
function sendToolLists(send, appList) {
  for (const app of appList) {
    let tools = appBridge.getToolsForApp(app.name);
    if (tools.length === 0) {
      const manifest = appManager.readManifest(app.name);
      if (manifest?.tools?.length > 0) tools = manifest.tools;
    }
    if (tools.length > 0) {
      send({ type: 'app:tools:updated', appName: app.name, tools });
    }
  }
}

function onConnect(ws) {
  const send = (data) => ws.send(JSON.stringify(data));
  send({ type: 'app:boot:status', ...bootStatus });
  try { send({ type: 'app:spend:mode', ...spendAdmin.modePayload() }); } catch {}
  send({ type: 'app:peer:slaveStatus', ...peerPairing.slaveStatus() });
  if (!hostConfig.isSlave()) {
    send({ type: 'app:peer:list', ...peerPairing.listPeersPublic() });
    // A key sync started before this reload keeps running server-side — hand
    // the fresh GUI its state so the row shows "syncing…", not nothing.
    send({ type: 'app:peer:keysStatus', peers: peerKeys.syncState() });
    // Live fleet view (peer channel): connected/lastSeen/health per slave.
    try { send({ type: 'app:fleet:state', ...peerChannel.fleetState() }); } catch {}
    // Data publishes (fleet-data.js): the persisted records, so a reload or a
    // reconnect reattaches the peers panel to running transfers.
    send(publish.dataTransfersMsg());
  }
  const appList = appManager.list();
  send({ type: 'app:list', apps: appList });
  send({ type: 'app:env', env: envDetect.detect() });
  send({ type: 'app:db:status', ...appDb.statusForOwnerUi() });
  // A reloaded GUI must re-render the chips and re-open a pending confirmation.
  try { send({ type: 'app:changeRequests', requests: appChangeRequests.list() }); } catch {}
  // The extras rows: the Setup button's attention (a missing Unity licence) and
  // a Unity sign-in in flight show on arrival, not only once Extras is opened.
  try { send({ type: 'app:extras:status', extras: platformExtras.list() }); } catch {}
  sendToolLists(send, appList);
  if (connectivity.status === 'checking') {
    send({ type: 'app:setup:connectivityResult', status: 'checking' });
  } else if (Date.now() - connectivity.checkedAt < CONNECTIVITY_TTL_MS) {
    send({ type: 'app:setup:connectivityResult', status: 'done', results: connectivity.results });
  } else {
    runConnectivityCheck().catch(() => {});
  }
}

// --- Boot status (broadcast so the GUI can show a prominent "starting up"
// banner; re-sent on every WS connect so a reload mid-boot recovers it) ---

let bootStatus = {
  phase: 'starting',
  db: 'connecting',
  apps: { state: 'pending', done: 0, total: 0, current: null },
  accounts: 'idle',
};

// The boot chain in init() sets phase: 'ready' explicitly when all stages are
// done; it is latched — a post-boot account recheck must not re-show the
// startup banner.
function updateBootStatus(patch) {
  Object.assign(bootStatus, patch);
  broadcaster.broadcast({ type: 'app:boot:status', ...bootStatus });
}

// --- Account connectivity check (cached module-wide: one check serves all
// connected GUIs; a reload within the TTL gets the cached result instantly) ---

const CONNECTIVITY_TTL_MS = 5 * 60 * 1000;
const connectivity = { status: 'idle', results: [], checkedAt: 0, promise: null };

function runConnectivityCheck({ force = false } = {}) {
  if (connectivity.promise) return connectivity.promise;
  if (!force && Date.now() - connectivity.checkedAt < CONNECTIVITY_TTL_MS) return Promise.resolve();
  const googleAccounts = googleAuth.listAccounts();
  const imapAccounts = emailAccounts.list();
  if (googleAccounts.length === 0 && imapAccounts.length === 0) return Promise.resolve();

  connectivity.status = 'checking';
  broadcaster.broadcast({ type: 'app:setup:connectivityResult', status: 'checking' });
  updateBootStatus({ accounts: 'checking' });

  connectivity.promise = Promise.all([
    ...googleAccounts.map((ga) => checkGoogleAccount(ga).catch((err) => (
      { type: 'google', email: ga.email, ok: false, issues: [{ service: 'token', error: err.message, fix: 'Check network connectivity, then use Recheck in Setup → Accounts.' }] }
    ))),
    ...imapAccounts.map((ea) => checkImapAccount(ea).catch((err) => (
      { type: 'imap', email: ea.email, provider: ea.provider, ok: false, issues: [{ service: 'imap', error: err.message, fix: 'Check network connectivity, then use Recheck in Setup → Accounts.' }] }
    ))),
  ]).then((results) => {
    connectivity.status = 'done';
    connectivity.results = results;
    connectivity.checkedAt = Date.now();
    connectivity.promise = null;
    broadcaster.broadcast({ type: 'app:setup:connectivityResult', status: 'done', results });
    updateBootStatus({ accounts: 'done' });
  });
  return connectivity.promise;
}

async function checkGoogleAccount(ga) {
  const r = await googleAuth.testAccount(ga.email);
  const entry = { type: 'google', email: ga.email, ok: r.ok, services: r.services, issues: [] };
  if (!r.services.token?.ok) {
    entry.issues.push({ service: 'token', error: r.services.token?.error || 'Token refresh failed',
      fix: 'Re-authorize this account: open Setup → Google, revoke it, then re-connect.' });
  }
  if (r.services.gmail?.missing) {
    entry.issues.push({ service: 'gmail', error: 'Gmail scope not granted',
      fix: 'This account hasn\'t granted Gmail access. An app that uses email will trigger re-authorization, or revoke and re-connect with Gmail scope.' });
  } else if (!r.services.gmail?.ok) {
    entry.issues.push({ service: 'gmail', error: r.services.gmail?.error || 'Gmail API error',
      fix: 'Enable the Gmail API in Google Cloud Console → APIs & Services → Library → search "Gmail API" → Enable.' });
  }
  if (r.services.calendar?.missing) {
    entry.issues.push({ service: 'calendar', error: 'Calendar scope not granted',
      fix: 'This account hasn\'t granted Calendar access. An app that uses calendar will trigger re-authorization, or revoke and re-connect with Calendar scope.' });
  } else if (!r.services.calendar?.ok) {
    entry.issues.push({ service: 'calendar', error: r.services.calendar?.error || 'Calendar API error',
      fix: 'Enable the Google Calendar API in Google Cloud Console → APIs & Services → Library → search "Google Calendar API" → Enable.' });
  }
  return entry;
}

async function checkImapAccount(ea) {
  const creds = emailAccounts.getCredentials(ea.email);
  if (!creds) {
    return { type: 'imap', email: ea.email, ok: false, issues: [{ service: 'imap', error: 'Account not found', fix: 'Re-add this account in Setup → Email.' }] };
  }
  const r = await emailAccounts.testConnection(creds);
  const entry = { type: 'imap', email: ea.email, provider: ea.provider, ok: r.ok, issues: [] };
  if (!r.ok) {
    let fix = 'Check your IMAP credentials in Setup → Email. Click Edit on this account to review host, port, username, and password.';
    const err = (r.error || '').toLowerCase();
    if (err.includes('auth') || err.includes('login') || err.includes('credentials')) {
      fix = 'Authentication failed. Update your password or app password in Setup → Email. For Outlook/Yahoo, you may need to generate an app-specific password.';
    } else if (err.includes('timeout') || err.includes('econnrefused') || err.includes('enotfound')) {
      fix = 'Cannot reach the IMAP server. Check the server hostname and port in Setup → Email. Make sure the mail server is reachable from this network.';
    } else if (err.includes('certificate') || err.includes('tls') || err.includes('ssl')) {
      fix = 'TLS/SSL error connecting to the IMAP server. Check the TLS setting and port (993 for TLS, 143 for STARTTLS) in Setup → Email.';
    }
    entry.issues.push({ service: 'imap', error: r.error || 'Connection failed', fix });
  }
  return entry;
}

// Mutating operations refused on a slave. The invariant behind the list: a
// slave's checkout must stay clean so `git pull --ff-only` (the deploy channel)
// never breaks — so nothing that writes tracked files or commits may run here.
// Per-host state (DB setup, channels, start/stop, settings) stays available.
// Blocked on a slave regardless of app: git ops (the slave's apps dir is not
// a checkout of the master's repo — a commit there could even land in an
// enclosing unrelated repo) and publishing onward.
const SLAVE_BLOCKED = new Set([
  'app:git:commit', 'app:git:push',
  'app:publish:start',
]);

// Blocked on a slave only for apps the MASTER published here (mirrors stay
// read-only so the next publish never breaks). The slave owner's own local
// apps are fully editable — for them the slave is a normal host.
// `app:setConfig` is NOT here: App Config on a mirror writes this host's
// .host-config.json overlay (app-manager.updateHostConfig), which a publish
// keeps — so a slave sets its own domain, access level and channels.
const SLAVE_BLOCKED_FOR_DEPLOYED = new Set([
  'app:create', 'app:delete', 'app:rename',
  'app:setAutostart', 'app:updateDesc',
]);

// `app:spawnCli` and `app:writeFile` are deliberately NOT in that set. Editing
// a mirror is allowed, because the deploy channel cannot be broken by it:
// deployCode() replaces the whole app dir with the master's tree, keeping only
// the runtime files in CODE_PRESERVE. A local source edit is therefore
// discarded by the next publish, never conflicting with it — and data-only
// work (DB migrations, `.data/`) survives, which is the main reason to want a
// CLI here. The client must show that warning once and echo `confirmSlaveEdit`
// on these messages from then on.
const SLAVE_EDIT_CONFIRM = new Set(['app:spawnCli', 'app:writeFile']);
function slaveEditNeedsConfirm(msg) {
  return hostConfig.isSlave() && SLAVE_EDIT_CONFIRM.has(msg.type) && msg.name
    && !msg.confirmSlaveEdit && appManager.isMasterDeployed(msg.name);
}

// Appended to a change session's system prompt when the app is a master
// mirror, so the CLI steers toward data-side fixes and warns about the rest.
function slaveMirrorPromptContext(appName) {
  return [
    '',
    '## This host is a slave — this app is a published mirror',
    '',
    `"${appName}" was published to this host from a master instance. The next publish from the master replaces this entire app directory with the master's copy.`,
    '',
    '- **Source edits made here are lost on the next publish.** Only make them if the user explicitly wants a local stopgap, and tell them the same change has to be made on the master to survive.',
    '- **Work that survives a publish:** the app database, and these paths inside the app dir — '
      + peerData.CODE_PRESERVE.map(p => `\`${p}\``).join(', ') + '. Data migrations belong here and are safe.',
    '- Prefer a data-side fix over a source edit on this host.',
    '- **Never run git commands in this app directory.** It is not a git checkout — a commit here could land in an enclosing, unrelated repository.',
  ].join('\n');
}

// Owner-level dashboard socket: core's isOwnerConnection (an older core without
// it authenticates every dashboard WebSocket as the owner at upgrade).
function ownerConnection(ws) {
  if (typeof opts.isOwnerConnection !== 'function') return true;
  try { return opts.isOwnerConnection(ws) === true; } catch { return false; }
}

async function handleMessage(ws, msg, bc) {
  const send = (data) => ws.send(JSON.stringify(data));

  try {
    if (hostConfig.isSlave() && SLAVE_BLOCKED.has(msg.type)) {
      send({ type: 'app:error', error: 'This instance is a slave — changes are made on the master and published here.' });
      return;
    }
    if (hostConfig.isSlave() && SLAVE_BLOCKED_FOR_DEPLOYED.has(msg.type)
        && msg.name && appManager.isMasterDeployed(msg.name)) {
      send({ type: 'app:error', error: `App "${msg.name}" is published here from the master — edit it there and publish again.` });
      return;
    }
    if (slaveEditNeedsConfirm(msg)) {
      // The server is the authority on what is a mirror, so it — not a
      // possibly-stale client app list — decides when the warning is due. The
      // request is echoed back so the client can replay it verbatim on
      // confirm, whatever `action` it carried.
      send({ type: 'app:slaveEditConfirm', appName: msg.name, request: msg });
      return;
    }
    if (await publish.handleWs(msg, send, bc)) return;
    switch (msg.type) {
      case 'app:list': {
        const appList = appManager.list();
        send({ type: 'app:list', apps: appList });
        sendToolLists(send, appList);
        break;
      }

      case 'app:create': {
        // Shared implementation (app-lifecycle) — the same function the
        // governed app.create kind executes; the owner click IS the approval.
        try {
          const { name } = appLifecycle.createApp(msg.name, msg.description);
          send({ type: 'app:created', appName: name });
        } catch (err) {
          send({ type: 'app:error', error: err.message });
        }
        break;
      }

      case 'app:delete': {
        appLifecycle.deleteApp(msg.name).catch(err => {
          send({ type: 'app:error', error: err.message });
        });
        break;
      }

      case 'app:rename:preflight': {
        // Feeds the rename modal's confirmation step: what the rename will
        // touch, and which follow-ups (e.g. Meta webhook URL) are manual.
        let info;
        try { info = appManager.renamePreflight(msg.name); }
        catch (err) { info = { error: err.message }; }
        send({ type: 'app:rename:preflight', appName: msg.name, info });
        break;
      }

      case 'app:rename': {
        try {
          await appLifecycle.renameApp(msg.name, msg.newName);
        } catch (err) {
          send({ type: 'app:error', appName: msg.name, error: err.message });
        }
        break;
      }

      case 'app:start': {
        const existing = appManager.getRunningApp(msg.name) || appManager.getMountedRouter(msg.name) && { type: 'mounted', runtime: 'in-process', status: 'mounted' };
        if (existing) {
          send({ type: 'app:started', appName: msg.name, port: existing.port || null, status: existing.status, appType: existing.type, runtime: existing.runtime });
          break;
        }
        send({ type: 'app:starting', appName: msg.name });
        appManager.startApp(msg.name, bc).then(entry => {
          if (entry.runtime === 'in-process') {
            bc.broadcast({ type: 'app:started', appName: msg.name, port: null, status: 'mounted', appType: 'mounted', runtime: 'in-process' });
            bc.broadcast({ type: 'app:list', apps: appManager.list() });
          }
          // Own-process apps broadcast app:started from spawnOwnProcess's stdout listener
        }).catch(err => {
          send({ type: 'app:startFailed', appName: msg.name, error: err.stack || err.message });
        });
        break;
      }

      // A browser error inside an app iframe (app-bridge-client.js →
      // apps.js reportError): logged and counted by app-guard like any other
      // app failure, so it outlives the page and raises the header alert.
      case 'app:clientError': {
        const e = msg.error && typeof msg.error === 'object' ? msg.error : {};
        if (!msg.name || !appManager.readManifest(msg.name)) break;
        const where = e.source ? `${String(e.source).split('/').pop()}:${e.lineno || '?'}:${e.colno || '?'}` : undefined;
        appGuard.record(msg.name, 'browser', String(e.message || 'Unknown error'), where ? { where: where.slice(0, 200) } : undefined);
        break;
      }

      case 'app:logs': {
        const log = appManager.readLog(msg.name);
        send({ type: 'app:logs', appName: msg.name, content: log || '' });
        break;
      }

      // The GUI stop (app card, app top bar). Closing a tab is not a stop: the
      // app may be open in another browser or doing its own work. Shared
      // implementation (app-lifecycle) — the same one the governed app.stop runs.
      case 'app:stop': {
        appLifecycle.stopApp(msg.name, { stopSites: msg.stopSites === true }).catch(err => {
          send({ type: 'app:error', appName: msg.name, error: err.message });
        });
        break;
      }

      case 'app:manifest': {
        const manifest = appManager.readManifest(msg.name);
        send({ type: 'app:manifest', appName: msg.name, manifest });
        break;
      }

      case 'app:appmd': {
        const md = appManager.readAppMd(msg.name);
        send({ type: 'app:appmd', appName: msg.name, content: md });
        break;
      }

      case 'app:setAutostart': {
        if (msg.name) {
          appManager.updateManifest(msg.name, { autostart: !!msg.autostart });
          // Honor the flag immediately: turning it on while stopped starts the app.
          if (msg.autostart && !appManager.getRunningApp(msg.name) && !appManager.getMountedRouter(msg.name)) {
            appManager.startApp(msg.name, bc).catch(err => {
              send({ type: 'app:startFailed', appName: msg.name, error: err.message });
            });
          }
          bc.broadcast({ type: 'app:list', apps: appManager.list() });
        }
        break;
      }

      case 'app:updateDesc': {
        if (msg.name && typeof msg.description === 'string') {
          appManager.updateManifest(msg.name, { description: msg.description });
          bc.broadcast({ type: 'app:list', apps: appManager.list() });
        }
        break;
      }

      case 'app:setConfig': {
        // App Config modal → the shared setConfig implementation
        // (app-lifecycle) — the same function the governed app.setConfig
        // kind executes.
        if (msg.name) {
          try {
            appLifecycle.setAppConfig(msg.name, msg);
            send({ type: 'app:configSaved', appName: msg.name });
          } catch (err) {
            send({ type: 'app:configError', appName: msg.name, error: err.message });
          }
        }
        break;
      }

      case 'app:getAccessInfo': {
        // Public URL block in the App Config modal. Everything it renders is
        // derived server-side (app-manager.accessInfo → surfaces.js), so the
        // dashboard never re-implements the perimeter it is describing.
        try {
          send({ type: 'app:accessInfo', appName: msg.name, info: appManager.accessInfo(msg.name) });
        } catch (err) {
          send({ type: 'app:accessInfo', appName: msg.name, error: err.message });
        }
        break;
      }

      // Sites tab (docs/sites.md): one engine, one dispatcher (sites.ownerAction).
      // Reads and per-host settings answer the asking socket; state changes
      // also reach every dashboard as app:site events.
      case 'app:sites:list':
      case 'app:site:detail':
      case 'app:site:checkDomain':
      case 'app:site:start':
      case 'app:site:stop':
      case 'app:site:restart':
      case 'app:site:settings':
      case 'app:site:rollback': {
        const action = msg.type === 'app:sites:list' ? 'list' : msg.type.slice('app:site:'.length);
        try {
          const result = await require('./sites').ownerAction(action, msg.name, msg.site, msg);
          send({ type: 'app:site:result', appName: msg.name, site: msg.site || null, action, reqId: msg.reqId || null, result });
        } catch (err) {
          send({ type: 'app:site:result', appName: msg.name, site: msg.site || null, action, reqId: msg.reqId || null, error: err.message });
        }
        break;
      }

      // Analytics in the Sites tab: one engine, scoped to the named app; replies carry the caller's reqId.
      case 'app:analytics:call': {
        try {
          const result = await require('./analytics').ownerCall(msg.name, String(msg.method || ''), msg);
          send({ type: 'app:analytics:result', appName: msg.name, site: msg.site || null, reqId: msg.reqId || null, result });
        } catch (err) {
          send({ type: 'app:analytics:result', appName: msg.name, site: msg.site || null, reqId: msg.reqId || null, error: err.message, code: err.code || null });
        }
        break;
      }

      case 'app:checkDomain': {
        // Website domain → Check: resolve + follow `/` once, server-side
        // (app-manager.checkDomain). `domain` is the field's unsaved value.
        try {
          send({ type: 'app:domainCheck', appName: msg.name, result: await appManager.checkDomain(msg.name, msg.domain) });
        } catch (err) {
          send({ type: 'app:domainCheck', appName: msg.name, error: err.message });
        }
        break;
      }

      case 'app:getEmailAccounts': {
        // Sender dropdown source for the App Config modal (addresses only).
        let accounts = [];
        try { accounts = emailAccounts.list(); } catch {}
        send({ type: 'app:emailAccounts', accounts });
        break;
      }

      case 'app:files': {
        const files = appManager.listAppFiles(msg.name);
        send({ type: 'app:files', appName: msg.name, files });
        break;
      }

      case 'app:readFile': {
        const content = appManager.readAppFile(msg.name, msg.path);
        send({ type: 'app:fileContent', appName: msg.name, path: msg.path, content });
        break;
      }

      case 'app:writeFile': {
        appManager.writeAppFile(msg.name, msg.path, msg.content);
        // A hand-edited manifest can change its surfaces (or legacy public
        // fields) — the auth-exempt patterns are rebuilt from manifests, so
        // refresh them like setConfig does.
        if (msg.path === 'manifest.json' && typeof opts.rebuildPublicExemptions === 'function') {
          try { opts.rebuildPublicExemptions(); } catch (err) { console.warn('  writeFile: rebuild failed:', err.message); }
        }
        send({ type: 'app:fileSaved', appName: msg.name, path: msg.path });
        bc.broadcast({ type: 'app:list', apps: appManager.list() });
        break;
      }

      case 'app:snapshot': {
        appManager.snapshot(msg.name);
        const snapshots = appManager.listSnapshots(msg.name);
        send({ type: 'app:snapshots', appName: msg.name, snapshots });
        break;
      }

      case 'app:snapshots': {
        const snapshots = appManager.listSnapshots(msg.name);
        send({ type: 'app:snapshots', appName: msg.name, snapshots });
        break;
      }

      case 'app:env': {
        send({ type: 'app:env', env: envDetect.detect() });
        break;
      }

      case 'app:envSummary': {
        send({ type: 'app:envSummary', summary: envDetect.summary() });
        break;
      }

      case 'app:bridge': {
        // The cli.* methods are dispatched here, outside handleBridgeCall, so
        // the spend policy's revocation check is applied here too.
        if (/^cli\./.test(msg.method || '')) {
          const refused = appBridge.revocationError(msg.name, msg.method);
          if (refused) {
            send({ type: 'app:bridge:response', appName: msg.name, id: msg.id, error: refused });
            break;
          }
        }
        if (msg.method === 'cli.interrupt') {
          // Send a few ESC keys to an app's CLI session to interrupt the running
          // agent (e.g. cancel an in-progress generation). Defaults to the app's
          // own CLI tab (app-<name>) when no tabId is given; only the app's own
          // tabs — change (also when restored under tab-<boot>-N), tools, its
          // workspace sessions — are accepted.
          if (!cliSessionManager) {
            send({ type: 'app:bridge:response', appName: msg.name, id: msg.id, error: 'CLI session manager not available' });
            break;
          }
          const params = msg.params || {};
          const tabId = params.tabId || `app-${msg.name}`;
          if (!cliWorkspace.ownsTab(msg.name, tabId)) {
            send({ type: 'app:bridge:response', appName: msg.name, id: msg.id, error: `tab "${tabId}" is not one of this app's CLI sessions` });
            break;
          }
          const count = Math.min(Math.max(parseInt(params.count, 10) || 3, 1), 10);
          try {
            for (let i = 0; i < count; i++) cliSessionManager.write(tabId, '\x1b');
            send({ type: 'app:bridge:response', appName: msg.name, id: msg.id, result: { tabId, sent: count } });
          } catch (err) {
            send({ type: 'app:bridge:response', appName: msg.name, id: msg.id, error: err.message });
          }
          break;
        }
        if (msg.method === 'cli.edit') {
          if (!cliSessionManager) {
            send({ type: 'app:bridge:response', appName: msg.name, id: msg.id, error: 'CLI session manager not available' });
            break;
          }
          const appName = msg.name;
          try {
            const { tabId, hidden, cancelled } = await launchChangeSession(appName, msg.params || {});
            if (cancelled) {
              send({ type: 'app:bridge:response', appName, id: msg.id, error: 'not opened: the owner declined to bill the session to the API key' });
              break;
            }
            send({ type: 'app:bridge:response', appName, id: msg.id, result: { tabId } });
            if (!hidden) send({ type: 'app:cliSpawned', appName, tabId });
          } catch (err) {
            send({ type: 'app:bridge:response', appName, id: msg.id, error: err.message });
          }
          break;
        }
        if (msg.method === 'cli.workspaces') {
          // The app's own workspace sessions, by stamp — restored tabs included.
          try {
            send({ type: 'app:bridge:response', appName: msg.name, id: msg.id, result: cliWorkspace.list(msg.name, msg.params || {}) });
          } catch (err) {
            send({ type: 'app:bridge:response', appName: msg.name, id: msg.id, error: err.message });
          }
          break;
        }
        if (msg.method === 'cli.workspace') {
          // A Claude session in one of the app's workspaces (cli-workspace.js).
          // A hidden one opens no tab; its lifecycle reaches the iframe as the
          // `cli:workspace` event either way.
          const appName = msg.name;
          try {
            const { hidden, ...result } = cliWorkspace.open(appName, msg.params || {});
            send({ type: 'app:bridge:response', appName, id: msg.id, result });
            if (!hidden) send({ type: 'app:cliSpawned', appName, tabId: result.tabId });
          } catch (err) {
            send({ type: 'app:bridge:response', appName, id: msg.id, error: err.message });
          }
          break;
        }

        appBridge.handleBridgeCall(
          msg.name,
          msg,
          (response) => send({ type: 'app:bridge:response', appName: msg.name, ...response }),
          (event, data) => send({ type: 'app:bridge:event', appName: msg.name, event, data })
        );
        break;
      }

      case 'app:setup:check': {
        const sudo = appDb.checkSudo();
        const mariadb = appDb.checkMariadb();
        const db = appDb.statusForOwnerUi();
        const apps = appDb.getProvisionedApps();
        const configured = appDb.isConfigured();
        let dbUser = null;
        if (sudo && mariadb) {
          try {
            const { execSync } = require('child_process');
            // Probe the account this install is actually configured with before
            // the default name — hardcoding 'vistaclair' meant an install set up
            // under any other admin user never detected its own account.
            // Restricted to a shell/SQL-safe charset since this interpolates
            // into a `sudo mariadb -e "..."` command line.
            const candidates = [...new Set([db.config?.user, 'vistaclair'])]
              .filter(u => u && /^[A-Za-z0-9_.-]+$/.test(u));
            const list = candidates.map(u => `'${u}'`).join(',');
            const out = execSync(`sudo mariadb -N -e "SELECT user FROM mysql.user WHERE user IN (${list}) AND host='localhost'"`, { timeout: 3000, encoding: 'utf-8' });
            const found = new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
            dbUser = candidates.find(u => found.has(u)) || null;
          } catch {}
        }
        send({ type: 'app:setup:status', sudo, mariadb, db, apps, configured, dbUser });
        break;
      }

      case 'app:extras:status': {
        send({ type: 'app:extras:status', extras: platformExtras.list() });
        break;
      }

      case 'app:extras:install': {
        try {
          platformExtras.install(msg.id);
          bc.broadcast({ type: 'app:extras:status', extras: platformExtras.list() });
        } catch (err) {
          send({ type: 'app:extras:status', extras: platformExtras.list(), error: err.message, errorId: msg.id });
        }
        break;
      }

      // The Unity licence on the unity extra's row (platform-extras-unity-license.js).
      // Owner only; the result reaches every dashboard through app:extras:status.
      case 'app:extras:unity:signIn':
      case 'app:extras:unity:cancel':
      case 'app:extras:unity:reactivate':
      case 'app:extras:unity:serial': {
        const unityLicense = require('./platform-extras-unity-license');
        const fail = (err) => send({ type: 'app:extras:status', extras: platformExtras.list(), error: err.message, errorId: 'unity' });
        if (!ownerConnection(ws)) { fail(new Error('Only the owner can manage the Unity licence.')); break; }
        try {
          if (msg.type === 'app:extras:unity:signIn') unityLicense.startSignIn();
          else if (msg.type === 'app:extras:unity:cancel') unityLicense.cancelSignIn();
          else if (msg.type === 'app:extras:unity:serial') unityLicense.setSerial(msg.serial);
          else {
            unityLicense.reactivate().then((r) => {
              if (!r.ok) fail(new Error(`Unity licence re-activation failed: ${r.error || 'unknown error'}`));
            }, fail);
          }
        } catch (err) { fail(err); }
        break;
      }

      case 'app:setup:installDb': {
        const { exec } = require('child_process');
        send({ type: 'app:setup:installProgress', stage: 'installing' });
        exec('sudo apt-get install -y mariadb-server', { timeout: 120000 }, (err) => {
          if (err) {
            send({ type: 'app:setup:installResult', ok: false, error: err.message });
            return;
          }
          send({ type: 'app:setup:installProgress', stage: 'starting' });
          exec('sudo systemctl start mariadb', { timeout: 10000 }, (err2) => {
            if (err2) {
              send({ type: 'app:setup:installResult', ok: false, error: 'Installed but failed to start: ' + err2.message });
              return;
            }
            send({ type: 'app:setup:installProgress', stage: 'configuring' });
            const pw = require('crypto').randomBytes(12).toString('base64url').slice(0, 16);
            const escapedPw = pw.replace(/'/g, "\\'");
            exec(`sudo mariadb -e "CREATE USER IF NOT EXISTS 'vistaclair'@'localhost' IDENTIFIED BY '${escapedPw}'; ALTER USER 'vistaclair'@'localhost' IDENTIFIED BY '${escapedPw}'; GRANT ALL PRIVILEGES ON *.* TO 'vistaclair'@'localhost' WITH GRANT OPTION; FLUSH PRIVILEGES;"`, { timeout: 10000 }, (err3) => {
              if (err3) {
                send({ type: 'app:setup:installResult', ok: true, configured: false, error: 'Installed but user setup failed: ' + err3.message });
                return;
              }
              const dbConfig = { host: 'localhost', port: 3306, user: 'vistaclair', password: pw };
              appDb.connect(dbConfig).then(async () => {
                bc.broadcast({ type: 'app:db:status', ...appDb.statusForOwnerUi() });
                await appManager.provisionMounted();
                bc.broadcast({ type: 'app:list', apps: appManager.list() });
                send({ type: 'app:setup:installResult', ok: true, configured: true, config: dbConfig });
              }).catch(connErr => {
                send({ type: 'app:setup:installResult', ok: true, configured: false, error: 'Installed but connect failed: ' + connErr.message, config: dbConfig });
              });
            });
          });
        });
        break;
      }

      case 'app:setup:setupUser': {
        const { exec } = require('child_process');
        const user = (msg.user || 'vistaclair').replace(/'/g, "\\'");
        const pw = msg.password || require('crypto').randomBytes(12).toString('base64url').slice(0, 16);
        const escapedPw = pw.replace(/'/g, "\\'");
        const sql = [
          `CREATE USER IF NOT EXISTS '${user}'@'localhost' IDENTIFIED BY '${escapedPw}'`,
          `ALTER USER '${user}'@'localhost' IDENTIFIED BY '${escapedPw}'`,
          `GRANT ALL PRIVILEGES ON *.* TO '${user}'@'localhost' WITH GRANT OPTION`,
          `FLUSH PRIVILEGES`,
        ].join('; ') + ';';
        exec(`sudo mariadb -e "${sql}"`, { timeout: 10000 }, (err) => {
          if (err) {
            send({ type: 'app:setup:setupResult', ok: false, error: err.message });
            return;
          }
          const dbConfig = { host: 'localhost', port: 3306, user: msg.user || 'vistaclair', password: pw };
          appDb.connect(dbConfig).then(async () => {
            bc.broadcast({ type: 'app:db:status', ...appDb.statusForOwnerUi() });
            await appManager.provisionMounted();
            bc.broadcast({ type: 'app:list', apps: appManager.list() });
            send({ type: 'app:setup:setupResult', ok: true, config: dbConfig });
          }).catch(connErr => {
            send({ type: 'app:setup:setupResult', ok: false, error: 'User ready but connect failed: ' + connErr.message, config: dbConfig });
          });
        });
        break;
      }

      case 'app:db:connect': {
        appDb.connect(msg.config).then(async () => {
          bc.broadcast({ type: 'app:db:status', ...appDb.statusForOwnerUi() });
          await appManager.provisionMounted();
          await initMemory();
          await initMailEngines();
          await initTasksEngine();
          bc.broadcast({ type: 'app:list', apps: appManager.list() });
        }).catch(err => {
          send({ type: 'app:db:error', error: err.message });
        });
        break;
      }

      case 'app:db:test': {
        appDb.testConnection(msg.config).then(result => {
          send({ type: 'app:db:testResult', ...result });
        });
        break;
      }

      case 'app:db:status': {
        send({ type: 'app:db:status', ...appDb.statusForOwnerUi() });
        break;
      }

      case 'app:db:disconnect': {
        appDb.disconnect().then(() => {
          bc.broadcast({ type: 'app:db:status', ...appDb.statusForOwnerUi() });
        });
        break;
      }

      // --- Cross-app change requests ---------------------------------
      // The owner's single confirmation. The prompt may be edited in the modal
      // before it is sent to the target session.
      case 'app:changeRequest:decide': {
        const res = appChangeRequests.decide(msg.id, { ok: !!msg.ok, prompt: msg.prompt, reason: msg.reason, mode: msg.mode });
        if (res.error) send({ type: 'app:error', error: res.error });
        break;
      }

      // A queued request, injected into the target's open session now (the
      // click is the confirm, as on the modal's "Inject into the open session").
      case 'app:changeRequest:inject': {
        const res = appChangeRequests.inject(msg.id, { prompt: msg.prompt });
        if (res.error) send({ type: 'app:error', error: res.error });
        break;
      }

      case 'app:changeRequest:cancel': {
        const res = appChangeRequests.cancel(msg.id, 'owner');
        if (res.error) send({ type: 'app:error', error: res.error });
        break;
      }

      case 'app:changeRequests:list': {
        send({ type: 'app:changeRequests', requests: appChangeRequests.list() });
        break;
      }

      case 'app:settings:get': {
        send({ type: 'app:settings', settings: platformSettings.all() });
        send({ type: 'app:models', models: buildModelCatalog(), default: platformSettings.get('directModel'), claudeAuth: claudeAuthInfo() });
        break;
      }

      case 'app:models:get': {
        send({ type: 'app:models', models: buildModelCatalog(), default: platformSettings.get('directModel'), claudeAuth: claudeAuthInfo() });
        break;
      }

      case 'app:settings:set': {
        if (msg.key) platformSettings.set(msg.key, msg.value);
        bc.broadcast({ type: 'app:settings', settings: platformSettings.all() });
        break;
      }

      // --- Media models (Setup → AI Config, the host model picker) -------
      // The catalog payload is ai.mediaModels' ({ models, defaults, configured,
      // refreshedAt, lastRefresh, refreshing }). A refresh runs server-side and
      // is shared with the daily review; every client gets the result, so a
      // reloaded GUI sees `refreshing` and then the fresh catalog.
      case 'app:media:catalog:get': {
        send({ type: 'app:media:catalog', reqId: msg.reqId || null, ...require('./media-catalog').list({ kind: msg.kind || undefined }) });
        break;
      }

      case 'app:media:refresh': {
        const mediaCatalog = require('./media-catalog');
        const p = mediaCatalog.refresh();
        bc.broadcast({ type: 'app:media:catalog', ...mediaCatalog.list() });
        p.then(
          () => bc.broadcast({ type: 'app:media:catalog', ...mediaCatalog.list() }),
          (err) => send({ type: 'app:error', error: `Media model refresh failed: ${err.message}` }),
        );
        break;
      }

      case 'app:media:sample': {
        require('./media-samples').sample({ model: msg.model, voice: msg.voice }).then(
          (r) => send({ type: 'app:media:sample', reqId: msg.reqId || null, ...r }),
          (err) => send({ type: 'app:media:sample', reqId: msg.reqId || null, model: msg.model, voice: msg.voice, error: err.message }),
        );
        break;
      }

      case 'app:translateKey:get': {
        const dedicated = opts.resolveProviderKey ? !!opts.resolveProviderKey('google-translate') : false;
        const fallback = opts.resolveProviderKey ? !!opts.resolveProviderKey('google') : false;
        send({ type: 'app:translateKey', configured: dedicated, fallback });
        break;
      }

      case 'app:translateKey:set': {
        if (opts.setProviderKey) opts.setProviderKey('google-translate', typeof msg.value === 'string' ? msg.value.trim() : '');
        const dedicated = opts.resolveProviderKey ? !!opts.resolveProviderKey('google-translate') : false;
        const fallback = opts.resolveProviderKey ? !!opts.resolveProviderKey('google') : false;
        send({ type: 'app:translateKey', configured: dedicated, fallback, saved: true });
        break;
      }

      case 'app:translateKey:test': {
        appBridge.translateDiagnose().then(
          (diag) => send({ type: 'app:translateKey:diag', diag }),
          (err) => send({ type: 'app:translateKey:diag', diag: { state: 'error', message: err.message } }),
        );
        break;
      }

      case 'app:mapsKey:get': {
        const dedicated = opts.resolveProviderKey ? !!opts.resolveProviderKey('google-maps') : false;
        const fallback = opts.resolveProviderKey ? !!opts.resolveProviderKey('google-translate') : false;
        send({ type: 'app:mapsKey', configured: dedicated, fallback });
        break;
      }

      case 'app:mapsKey:set': {
        if (opts.setProviderKey) opts.setProviderKey('google-maps', typeof msg.value === 'string' ? msg.value.trim() : '');
        const dedicated = opts.resolveProviderKey ? !!opts.resolveProviderKey('google-maps') : false;
        const fallback = opts.resolveProviderKey ? !!opts.resolveProviderKey('google-translate') : false;
        send({ type: 'app:mapsKey', configured: dedicated, fallback, saved: true });
        break;
      }

      case 'app:mapsKey:test': {
        appBridge.mapsDiagnose().then(
          (diag) => send({ type: 'app:mapsKey:diag', diag }),
          (err) => send({ type: 'app:mapsKey:diag', diag: { state: 'error', message: err.message } }),
        );
        break;
      }

      case 'app:braveKey:get': {
        const configured = opts.resolveProviderKey ? !!opts.resolveProviderKey('brave-search') : false;
        send({ type: 'app:braveKey', configured });
        break;
      }

      case 'app:braveKey:set': {
        if (opts.setProviderKey) opts.setProviderKey('brave-search', typeof msg.value === 'string' ? msg.value.trim() : '');
        const configured = opts.resolveProviderKey ? !!opts.resolveProviderKey('brave-search') : false;
        send({ type: 'app:braveKey', configured, saved: true });
        break;
      }

      case 'app:braveKey:test': {
        appBridge.webSearchDiagnose().then(
          (diag) => send({ type: 'app:braveKey:diag', diag }),
          (err) => send({ type: 'app:braveKey:diag', diag: { state: 'error', message: err.message } }),
        );
        break;
      }

      case 'app:elevenlabsKey:get': {
        const configured = opts.resolveProviderKey ? !!opts.resolveProviderKey('elevenlabs') : false;
        send({ type: 'app:elevenlabsKey', configured });
        break;
      }

      case 'app:elevenlabsKey:set': {
        if (opts.setProviderKey) opts.setProviderKey('elevenlabs', typeof msg.value === 'string' ? msg.value.trim() : '');
        const configured = opts.resolveProviderKey ? !!opts.resolveProviderKey('elevenlabs') : false;
        send({ type: 'app:elevenlabsKey', configured, saved: true });
        break;
      }

      case 'app:elevenlabsKey:test': {
        appBridge.elevenlabsDiagnose().then(
          (diag) => send({ type: 'app:elevenlabsKey:diag', diag }),
          (err) => send({ type: 'app:elevenlabsKey:diag', diag: { state: 'error', message: err.message } }),
        );
        break;
      }

      // Setup → Drucker. Owner only; every reply is the whole panel state.
      case 'app:print:get':
      case 'app:print:save':
      case 'app:print:test': {
        const print = require('./platform-print');
        const reply = (extra) => print.adminState().then(
          (state) => send({ type: 'app:print:state', state, ...extra }),
          (err) => send({ type: 'app:print:state', state: null, error: err.message }),
        );
        if (!ownerConnection(ws)) { send({ type: 'app:print:state', state: null, error: 'Only the owner can manage printing.' }); break; }
        if (msg.type === 'app:print:get') { await reply(); break; }
        try {
          if (msg.type === 'app:print:save') {
            await print.saveSettings(msg.settings || {});
            await reply({ notice: 'Saved.' });
          } else {
            const r = await print.testPage();
            await reply(r.ok ? { notice: `Test page sent${r.jobId ? ' (' + r.jobId + ')' : ''}.` } : { error: r.error });
          }
        } catch (err) {
          await reply({ error: err.message });
        }
        break;
      }

      case 'app:memory:status': {
        memoryService.status().then(
          (s) => send({ type: 'app:memory:status', status: s }),
          (err) => send({ type: 'app:memory:status', status: { ready: false, error: err.message } }),
        );
        break;
      }

      case 'app:memory:runNow': {
        send({ type: 'app:memory:runStarted' });
        memoryMaintenance.runAll().then(
          (r) => memoryService.status().then((s) => send({ type: 'app:memory:runDone', result: r, status: s })),
          (err) => send({ type: 'app:memory:runDone', error: err.message }),
        );
        break;
      }

      case 'app:spawnCli': {
        if (!cliSessionManager) {
          send({ type: 'app:error', error: 'CLI session manager not available' });
          break;
        }
        const appName = msg.name;
        const appDir = path.join(appManager.APPS_DIR, appName);
        const existingFiles = appManager.listAppFiles(appName);
        const hasContent = existingFiles.some(f => f !== 'manifest.json');
        const action = msg.action || (hasContent ? 'extend' : 'build');
        const tabId = action === 'build-tools' ? `app-${appName}-tools` : `app-${appName}`;
        const manifest = appManager.readManifest(appName) || {};

        const promptArgs = {
          appName,
          description: msg.description || manifest.description || '',
          userRequest: msg.initialInput || '',
          proxyPort: opts.proxyPort,
          dbInfo: getDbInfo(appName),
        };
        let systemPrompt = promptBuilder.buildPrompt(action, promptArgs);
        // The lean prompt of an orchestration run's workers (extend only). Core keeps
        // it for an orchestrator run and drops it for a simple session; which one the
        // owner picks is only known once openCli returns (markWorkerProfile below).
        let workerPrompt = openCli && askableAction(action) && promptBuilder.hasWorkerProfile(action)
          ? promptBuilder.buildPrompt(action, { ...promptArgs, profile: 'worker' }) : '';

        if (hostConfig.isSlave() && appManager.isMasterDeployed(appName)) {
          const mirror = slaveMirrorPromptContext(appName);
          systemPrompt += mirror;
          if (workerPrompt) workerPrompt += mirror;
        }

        if (action === 'build-tools' && msg.toolName) {
          const toolCtx = ['\n## Specific Tool to Edit', '',
            `The user wants to edit the tool named **${msg.toolName}**.`];
          if (msg.toolSchema) toolCtx.push('', 'Current schema:', '```json', msg.toolSchema, '```');
          toolCtx.push('', 'Focus on modifying this specific tool. Read routes.js to find its handler, then make the requested changes.', 'Do not modify other tools unless the user explicitly asks.');
          systemPrompt += toolCtx.join('\n');
        }

        let trigger;
        if (action === 'build') {
          trigger = msg.initialInput
            ? `Build the app "${appName}": ${msg.initialInput}`
            : `Build the app "${appName}". Ask me what I want it to do.`;
        } else if (action === 'recreate-appmd') {
          trigger = RECREATE_APPMD_TRIGGER;
        } else if (action === 'build-tools' && msg.toolName) {
          trigger = `I want to modify the "${msg.toolName}" tool. Read its current implementation in routes.js.`;
        }

        const settingsFile = promptBuilder.writeSidecars(appDir, {
          action, appName,
          userRequest: msg.initialInput || '',
          description: msg.description || manifest.description || '',
        });
        const launch = {
          cwd: appDir,
          cols: msg.cols,
          rows: msg.rows,
          title: action === 'build-tools' ? `${appName} (tools)` : appName,
          settings: {
            appendSystemPrompt: systemPrompt, settingsFile, sessionsRoot: sessionsRoot(appDir),
            ...(workerPrompt ? { workerAppendSystemPrompt: workerPrompt } : {}),
            ...(action === 'build-tools' ? {} : { [SESSION_STAMPS.app]: appName }),
          },
          prompt: trigger,
          autoSubmit: !!trigger,
          spawnOpts: { resume: action !== 'build-tools' && action !== 'recreate-appmd' && hasContent },
        };
        let engine = 'cli';
        let auth = null;
        if (openCli) {
          // The user picks Simple or Orchestrator and the engine (CLI terminal
          // or Agent SDK panel), and an SDK session's billing; what msg leaves
          // unset, core asks in one form.
          // A tools edit and an APP.md recreate are always simple and, unless
          // msg names an engine, CLI, so they ask nothing. An orchestrator
          // run lives in the app's gitignored .vistaclair/, and its workers share
          // the app directory (the read ledger and change-request identity are
          // tied to it), so no worktrees.
          const askable = askableAction(action);
          const res = await openCli({
            tabId, ...launch,
            mode: askable ? msg.mode : 'simple',
            engine: askable ? msg.engine : (msg.engine || 'cli'),
            runsDir: path.join(appDir, '.vistaclair', 'orchestrator'),
            isolation: 'none',
          });
          if (res.cancelled) {
            send({ type: 'app:cliCancelled', appName, tabId });
            break;
          }
          engine = res.engine;
          auth = res.auth || null;
          if (workerPrompt && res.mode === 'orchestrator') promptBuilder.markWorkerProfile(appDir);
        } else {
          // An older core has one engine, the CLI: msg.engine is ignored.
          cliSessionManager.launchSession(tabId, launch);
        }

        registerAppMdCheck(tabId, appName, action, engine, auth);

        // Signal pending restart if editing tools on a running app
        if (action === 'build-tools') {
          const appInfo = appManager.list().find(a => a.name === appName);
          if (appInfo?.running) {
            bc.broadcast({ type: 'app:tools:pendingRestart', appName });
          }
        }

        send({ type: 'app:cliSpawned', appName, tabId });
        break;
      }

      case 'app:tools:test': {
        try {
          const result = await appBridge.callAppToolHandler(msg.name, msg.toolName, msg.args || {}, { type: 'gui-test' });
          send({ type: 'app:tools:testResult', appName: msg.name, toolName: msg.toolName, result });
        } catch (err) {
          send({ type: 'app:tools:testResult', appName: msg.name, toolName: msg.toolName, error: err.message });
        }
        break;
      }

      // --- App→app dependency edges (Setup → Tools & Access) ----------
      case 'app:deps:get': {
        send({ type: 'app:deps', ...require('./app-deps').overview() });
        break;
      }

      case 'app:deps:approve':
      case 'app:deps:revoke': {
        const appDeps = require('./app-deps');
        const res = msg.type === 'app:deps:approve' ? appDeps.approve(msg.id) : appDeps.revoke(msg.id);
        if (res.error) send({ type: 'app:error', error: res.error });
        bc.broadcast({ type: 'app:deps', ...appDeps.overview() });
        break;
      }

      case 'app:deps:setMode': {
        const appDeps = require('./app-deps');
        if (!appDeps.MODES.includes(msg.mode)) { send({ type: 'app:error', error: `unknown enforcement mode "${msg.mode}"` }); break; }
        platformSettings.set('appDepsEnforce', msg.mode);
        bc.broadcast({ type: 'app:settings', settings: platformSettings.all() });
        bc.broadcast({ type: 'app:deps', ...appDeps.overview() });
        break;
      }

      case 'app:tools:auditList': {
        send({ type: 'app:tools:audit', entries: appBridge.getToolAudit(msg.limit || 50) });
        break;
      }

      // Lightweight aggregate for the Setup modal's nav status badges and the
      // first-run checklist — one message instead of visiting every tab.
      case 'app:setup:overview': {
        let googleCount = 0, emailCount = 0, tgBots = 0, waAccounts = 0;
        try { googleCount = googleAuth.listAccounts().length; } catch {}
        try { emailCount = emailAccounts.list().length; } catch {}
        try { tgBots = (telegram.status().bots || []).length; } catch {}
        try { waAccounts = (whatsapp.status().accounts || []).length; } catch {}
        let memoryOk = false;
        try { memoryOk = !!(await memoryService.status())?.ready; } catch {}
        const auth = claudeAuthInfo();
        send({
          type: 'app:setup:overviewResult',
          db: { ok: appDb.status().connected },
          accounts: { count: googleCount + emailCount, google: googleCount, email: emailCount },
          ai: { configured: !!(auth.hasSubscription || auth.pref) },
          telegram: { configured: tgBots > 0 },
          whatsapp: { configured: waAccounts > 0 },
          email: { count: emailCount },
          memory: { ok: memoryOk },
        });
        break;
      }

      case 'app:status': {
        let status = appManager.getAppStatus(msg.name);
        if (status.db === 'pending' && appDb.getPool()) {
          try {
            await appDb.provisionApp(msg.name);
            status = appManager.getAppStatus(msg.name);
          } catch (err) {
            console.warn(`[app:${msg.name}] Auto-provision failed: ${appDb.friendlyDbError(err)}`);
          }
        }
        const git = await appManager.getGitStatus(msg.name);
        send({ type: 'app:status', appName: msg.name, ...status, git });
        break;
      }

      case 'app:restart': {
        send({ type: 'app:restarting', appName: msg.name });
        try {
          const entry = await appManager.restartApp(msg.name, bc);
          bc.broadcast({ type: 'app:started', appName: msg.name, port: entry.port || null, status: entry.status, appType: entry.type, runtime: entry.runtime });
          bc.broadcast({ type: 'app:list', apps: appManager.list() });
        } catch (err) {
          send({ type: 'app:startFailed', appName: msg.name, error: err.stack || err.message });
        }
        break;
      }

      case 'app:git:status': {
        const git = await appManager.getGitStatus(msg.name);
        send({ type: 'app:git:status', appName: msg.name, git });
        break;
      }

      // --- Spend policy (admin) -------------------------------------------
      case 'app:spend:mode': {
        // { override?: 'auto'|'local'|'deployed', enforce?: boolean }
        try {
          if (msg.override !== undefined || msg.enforce !== undefined) {
            const patch = {};
            if (msg.override !== undefined) patch.mode = msg.override;
            if (msg.enforce !== undefined) patch.enforce = !!msg.enforce;
            spendAdmin.setHost(patch);
          }
          bc.broadcast({ type: 'app:spend:mode', ...spendAdmin.modePayload() });
        } catch (err) { send({ type: 'app:spend:error', error: err.message }); }
        break;
      }
      case 'app:spend:get': {
        try { send({ type: 'app:spend:app', ...spendAdmin.appPayload(msg.name, { days: msg.days }) }); }
        catch (err) { send({ type: 'app:spend:error', appName: msg.name, error: err.message }); }
        break;
      }
      case 'app:spend:set': {
        // { name, policy: { local?, deployed?, note? } | null }  null = clear the admin layer
        try {
          spendAdmin.setPolicy(msg.name, msg.policy === null ? null : (msg.policy || {}));
          send({ type: 'app:spend:saved', appName: msg.name });
          send({ type: 'app:spend:app', ...spendAdmin.appPayload(msg.name) });
          bc.broadcast({ type: 'app:spend:changed', appName: msg.name });
        } catch (err) { send({ type: 'app:spend:error', appName: msg.name, error: err.message }); }
        break;
      }
      case 'app:spend:overview': {
        try { send({ type: 'app:spend:overview', ...spendAdmin.overview() }); }
        catch (err) { send({ type: 'app:spend:error', error: err.message }); }
        break;
      }
      case 'app:spend:host': {
        // { host?: { local?, deployed? }, unitPrices?: {...}, enforce?, reviewNotice? }
        try {
          const patch = {};
          for (const k of ['host', 'unitPrices', 'enforce', 'reviewNotice']) if (msg[k] !== undefined) patch[k] = msg[k];
          spendAdmin.setHost(patch);
          send({ type: 'app:spend:overview', ...spendAdmin.overview() });
          bc.broadcast({ type: 'app:spend:mode', ...spendAdmin.modePayload() });
        } catch (err) { send({ type: 'app:spend:error', error: err.message }); }
        break;
      }

      case 'app:grid:meta': {
        const names = appManager.list().map(a => a.name);
        const [git, sizes, dbSizes] = await Promise.all([
          appManager.getAllGitStatus(),
          appManager.getAllDirSizes(names),
          appDb.getAllDbSizes(),
        ]);
        const dbNames = {};
        for (const [n, info] of Object.entries(appDb.getProvisionedApps())) {
          if (info?.database) dbNames[n] = info.database;
        }
        let spend = {};
        try { spend = spendAdmin.gridMeta(names); } catch {}
        send({ type: 'app:grid:meta', git, sizes, dbSizes, dbNames, spend, baseDir: appManager.APPS_DIR });
        break;
      }

      case 'app:git:commit': {
        if (!cliSessionManager) {
          send({ type: 'app:error', error: 'CLI session manager not available' });
          break;
        }
        const commitAppName = msg.name;
        const commitTabId = `app-${commitAppName}`;
        const commitAppDir = path.join(appManager.APPS_DIR, commitAppName);

        const commitPrompt = [
          `You are committing changes for the vistaclair app "${commitAppName}".`,
          `Your CWD is the app directory. The app lives inside a git repo at "${appManager.APPS_DIR}".`,
          `Steps:`,
          `1. Run: git -C "${appManager.APPS_DIR}" diff -- ${commitAppName}/`,
          `2. Review the changes carefully`,
          `3. Run: git -C "${appManager.APPS_DIR}" add -- ${commitAppName}/`,
          `4. Write a clear, concise commit message describing what changed and why`,
          `5. Run: git -C "${appManager.APPS_DIR}" commit -m "<your message>"`,
          `6. If APP.md exists, verify it still matches the code. If something is stale or missing, fix it. If APP.md does not exist, create it (Purpose, Architecture, Files, Functions, Dependencies, State, UI Layout).`,
          `7. Report what you committed`,
        ].join('\n');

        cliSessionManager.launchSession(commitTabId, {
          cwd: commitAppDir,
          title: commitAppName,
          settings: { appendSystemPrompt: commitPrompt, engine: 'cli' },
          prompt: 'Review the uncommitted changes for this app and commit them with a good message.',
          autoSubmit: true,
        });
        send({ type: 'app:cliSpawned', appName: commitAppName, tabId: commitTabId });
        break;
      }

      case 'app:git:push': {
        try {
          const result = await appManager.gitPush();
          send({ type: 'app:git:pushResult', ok: true, output: result });
          const git = await appManager.getGitStatus(msg.name);
          send({ type: 'app:git:status', appName: msg.name, git });
        } catch (err) {
          send({ type: 'app:git:pushResult', ok: false, error: err.message });
        }
        break;
      }

      case 'app:tasks:list': {
        const tasks = appBridge.listTasks();
        tasks.cli = cliSessionManager ? cliSessionManager.list() : [];
        send({ type: 'app:tasks:list', tasks });
        break;
      }

      case 'app:tasks:kill': {
        const { taskType, taskId } = msg;
        if (taskType === 'cli' && cliSessionManager) {
          cliSessionManager.kill(taskId);
          cliSessionManager.broadcastTabs();
        } else {
          appBridge.handleBridgeCall(
            msg.appName || 'platform',
            { id: 'task-kill', method: 'tasks.kill', params: { taskType, taskId } },
            () => {},
            () => {}
          );
        }
        const tasks = appBridge.listTasks();
        tasks.cli = cliSessionManager ? cliSessionManager.list() : [];
        send({ type: 'app:tasks:list', tasks });
        break;
      }

      case 'app:setup:oauthSave': {
        try {
          googleAuth.setCredentials(msg.clientId || '', msg.clientSecret || '');
          send({ type: 'app:setup:oauthStatus', ...googleAuth.status(), publicUrl: googleApi.publicBase() });
          bc.broadcast({ type: 'app:setup:accountsChanged', change: 'google.credentials' });
        } catch (err) {
          send({ type: 'app:error', error: err.message });
        }
        break;
      }

      case 'app:setup:oauthStatus': {
        send({ type: 'app:setup:oauthStatus', ...googleAuth.status(), publicUrl: googleApi.publicBase() });
        break;
      }

      case 'app:setup:oauthRevoke': {
        // The local record is gone either way; `revokedAtGoogle` says whether
        // the grant itself died, so the owner is not told "revoked" when only
        // half of it happened.
        const revoked = await googleAuth.revokeAccount(msg.email);
        send({ type: 'app:setup:oauthStatus', ...googleAuth.status(), publicUrl: googleApi.publicBase(), revoked });
        if (!revoked.revokedAtGoogle) {
          send({ type: 'app:error', error: `Removed locally, but Google still holds the grant (${revoked.reason}). Revoke it at myaccount.google.com/permissions.` });
        }
        bc.broadcast({ type: 'app:setup:accountsChanged', change: 'google.revoke', email: msg.email });
        break;
      }

      case 'app:setup:oauthReauth': {
        try {
          const redirectUri = msg.redirectUri || googleApi.redirectUri();
          const accounts = googleAuth.listAccounts();
          const acct = accounts.find(a => a.email === msg.email);
          const scopes = acct?.grantedScopes || [];
          const authUrl = googleAuth.getAuthUrl(scopes, redirectUri, msg.email);
          send({ type: 'app:setup:oauthReauthUrl', authUrl, email: msg.email });
        } catch (err) {
          send({ type: 'app:error', error: err.message });
        }
        break;
      }

      case 'app:setup:oauthConnect': {
        try {
          const authUrl = googleApi.connectAuthUrl(msg.redirectUri);
          send({ type: 'app:setup:oauthReauthUrl', authUrl });
        } catch (err) {
          send({ type: 'app:error', error: err.message });
        }
        break;
      }

      case 'app:setup:oauthTest': {
        const redirectUri = msg.redirectUri || googleApi.redirectUri();
        const result = googleAuth.testSetup(redirectUri);
        send({ type: 'app:setup:oauthTestResult', ...result });
        break;
      }

      case 'app:setup:oauthReveal': {
        send({ type: 'app:setup:oauthCredentials', ...googleAuth.getCredentials() });
        break;
      }

      // --- Email accounts ---

      case 'app:setup:emailList': {
        send({ type: 'app:setup:emailList', accounts: emailAccounts.list() });
        break;
      }

      case 'app:setup:emailAdd': {
        const testResult = await emailAccounts.testConnection(msg.account);
        if (!testResult.ok) {
          send({ type: 'app:setup:emailAddResult', ok: false, error: `Connection failed: ${testResult.error}` });
          break;
        }
        const addResult = emailAccounts.addAccount(msg.account);
        send({ type: 'app:setup:emailAddResult', ...addResult });
        if (addResult.ok) {
          send({ type: 'app:setup:emailList', accounts: emailAccounts.list() });
          bc.broadcast({ type: 'app:setup:accountsChanged', change: 'email.add', email: msg.account.email });
        }
        break;
      }

      case 'app:setup:emailRemove': {
        const result = emailAccounts.removeAccount(msg.email);
        send({ type: 'app:setup:emailRemoveResult', ...result });
        if (result.ok) {
          send({ type: 'app:setup:emailList', accounts: emailAccounts.list() });
          bc.broadcast({ type: 'app:setup:accountsChanged', change: 'email.remove', email: msg.email });
        }
        break;
      }

      case 'app:setup:emailTest': {
        const account = msg.account || emailAccounts.getCredentials(msg.email);
        if (!account) { send({ type: 'app:setup:emailTestResult', ok: false, error: 'Account not found' }); break; }
        const result = await emailAccounts.testConnection(account);
        send({ type: 'app:setup:emailTestResult', email: msg.email || account.email, ...result });
        break;
      }

      case 'app:setup:emailUpdate': {
        const result = emailAccounts.updateAccount(msg.email, msg.updates);
        send({ type: 'app:setup:emailUpdateResult', ...result });
        if (result.ok) send({ type: 'app:setup:emailList', accounts: emailAccounts.list() });
        break;
      }

      case 'app:setup:emailReveal': {
        const creds = emailAccounts.getCredentials(msg.email);
        send({ type: 'app:setup:emailCredentials', email: msg.email, credentials: creds });
        break;
      }

      // --- Email/calendar sync engines (Setup panels) ---

      case 'app:setup:emailEngineStatus': {
        try {
          send({ type: 'app:setup:emailEngineStatus', ...(await emailEngine.status()) });
        } catch (err) {
          send({ type: 'app:setup:emailEngineStatus', ready: false, error: err.message, accounts: [] });
        }
        break;
      }

      case 'app:setup:emailEngineEnable': {
        try {
          const email = msg.email;
          const enabled = !!msg.enabled;
          emailEngine.setAccountSettings(email, { enabled });
          if (emailEngine.accountType(email) === 'imap') {
            const imap = emailEngine.provider('imap');
            if (enabled) await imap.enableAccount(email);
            else await imap.disableAccount(email);
          } else {
            await emailEngine.setSyncState(email, enabled
              ? { enabled: 1, status: 'idle', last_error: null }
              : { enabled: 0, status: 'disabled' });
            if (enabled) emailEngine.syncNow(email).catch(() => {});
          }
          send({ type: 'app:setup:emailEngineStatus', ...(await emailEngine.status()) });
        } catch (err) {
          send({ type: 'app:error', error: err.message });
        }
        break;
      }

      case 'app:setup:emailEngineSyncNow': {
        try {
          emailEngine.syncNow(msg.email).catch((err) =>
            console.error(`  Email engine [${msg.email}]: manual sync failed: ${err.message}`));
          send({ type: 'app:setup:emailEngineStatus', ...(await emailEngine.status()) });
        } catch (err) {
          send({ type: 'app:error', error: err.message });
        }
        break;
      }

      case 'app:setup:emailEngineDepth': {
        try {
          emailEngine.setAccountSettings(msg.email, { backfillDepth: msg.depth });
          send({ type: 'app:setup:emailEngineStatus', ...(await emailEngine.status()) });
        } catch (err) {
          send({ type: 'app:error', error: err.message });
        }
        break;
      }

      case 'app:setup:emailEngineFolders': {
        try {
          const updates = {};
          if (msg.folders !== undefined) updates.folders = msg.folders;
          if (msg.sentFolder !== undefined) updates.sentFolder = msg.sentFolder || null;
          emailEngine.setAccountSettings(msg.email, updates);
          send({ type: 'app:setup:emailEngineStatus', ...(await emailEngine.status()) });
        } catch (err) {
          send({ type: 'app:error', error: err.message });
        }
        break;
      }

      // Reply signature, per account and per MIME part. Stored only — it reaches
      // the wire through email-compose when a reply proposal is composed, which
      // is itself gated on the owner approving that proposal.
      case 'app:setup:emailEngineSignature': {
        try {
          const updates = {};
          if (msg.signature !== undefined) updates.signature = String(msg.signature || '');
          if (msg.signatureHtml !== undefined) updates.signatureHtml = String(msg.signatureHtml || '');
          emailEngine.setAccountSettings(msg.email, updates);
          send({ type: 'app:setup:emailEngineStatus', ...(await emailEngine.status()) });
        } catch (err) {
          send({ type: 'app:error', error: err.message });
        }
        break;
      }

      case 'app:setup:calendarStatus': {
        try {
          if (!msg.email) {
            // Overview: also reads the calendar list of an account that has none yet.
            const { accounts, status, errors } = await calendarEngine.panelStatus();
            send({ type: 'app:setup:calendarStatus', email: null, calendars: null, status, accounts, errors });
            break;
          }
          const calendars = await calendarEngine.listCalendars({ account: msg.email });
          const status = await calendarEngine.syncStatus({ account: msg.email });
          send({ type: 'app:setup:calendarStatus', email: msg.email, calendars, status, accounts: calendarEngine.calendarAccounts() });
        } catch (err) {
          send({ type: 'app:setup:calendarStatus', email: msg.email || null, error: err.message, authUrl: err.authUrl, calendars: [], status: [], accounts: calendarEngine.calendarAccounts() });
        }
        break;
      }

      case 'app:setup:calendarSelect': {
        try {
          await calendarEngine.selectCalendars({ account: msg.email, calendarIds: msg.calendarIds });
          const status = await calendarEngine.syncStatus({ account: msg.email });
          send({ type: 'app:setup:calendarStatus', email: msg.email, status, accounts: calendarEngine.calendarAccounts() });
        } catch (err) {
          send({ type: 'app:error', error: err.message });
        }
        break;
      }

      case 'app:setup:calendarSyncNow': {
        try {
          const status = await calendarEngine.syncNow({ account: msg.email });
          send({ type: 'app:setup:calendarStatus', email: msg.email || null, status, accounts: calendarEngine.calendarAccounts() });
        } catch (err) {
          send({ type: 'app:error', error: err.message });
        }
        break;
      }

      // --- Telegram bots (per-app) ---

      case 'app:setup:telegramStatus': {
        const st = telegram.status();
        st.bots = (st.bots || []).filter((b) => b.appName !== platformTelegram.KEY);
        send({ type: 'app:setup:telegramStatus', ...st });
        break;
      }

      case 'app:setup:telegramSet': {
        const result = await telegram.setBot(msg.appName, msg.token);
        send({ type: 'app:setup:telegramSetResult', appName: msg.appName, ...result });
        if (result.ok) {
          const st = telegram.status();
          st.bots = (st.bots || []).filter((b) => b.appName !== platformTelegram.KEY);
          send({ type: 'app:setup:telegramStatus', ...st });
          bc.broadcast({ type: 'app:setup:accountsChanged', change: 'telegram.set', appName: msg.appName });
        }
        break;
      }

      case 'app:setup:telegramRemove': {
        const result = await telegram.removeBot(msg.appName);
        send({ type: 'app:setup:telegramRemoveResult', appName: msg.appName, ...result });
        if (result.ok) {
          const st = telegram.status();
          st.bots = (st.bots || []).filter((b) => b.appName !== platformTelegram.KEY);
          send({ type: 'app:setup:telegramStatus', ...st });
          bc.broadcast({ type: 'app:setup:accountsChanged', change: 'telegram.remove', appName: msg.appName });
        }
        break;
      }

      case 'app:setup:telegramTest': {
        if (!telegram.hasBot(msg.appName)) { send({ type: 'app:setup:telegramTestResult', appName: msg.appName, ok: false, error: 'No bot configured' }); break; }
        try {
          const me = await telegram.call(msg.appName, 'getMe', {});
          send({ type: 'app:setup:telegramTestResult', appName: msg.appName, ok: !!me.ok, result: me.result, error: me.ok ? null : me.description });
        } catch (err) {
          send({ type: 'app:setup:telegramTestResult', appName: msg.appName, ok: false, error: err.message });
        }
        break;
      }

      case 'app:setup:telegramSetRestricted': {
        const result = telegram.setRestricted(msg.appName, !!msg.restricted);
        send({ type: 'app:setup:telegramSetRestrictedResult', appName: msg.appName, ...result });
        const st2 = telegram.status();
        st2.bots = (st2.bots || []).filter((b) => b.appName !== platformTelegram.KEY);
        send({ type: 'app:setup:telegramStatus', ...st2 });
        break;
      }

      case 'app:setup:telegramRemoveChat': {
        const result = telegram.removeAllowedChat(msg.appName, msg.chatId);
        send({ type: 'app:setup:telegramRemoveChatResult', appName: msg.appName, ...result });
        const st3 = telegram.status();
        st3.bots = (st3.bots || []).filter((b) => b.appName !== platformTelegram.KEY);
        send({ type: 'app:setup:telegramStatus', ...st3 });
        break;
      }

      case 'app:setup:telegramSetPublicUrl': {
        const result = await telegram.setPublicUrl(msg.url || '');
        send({ type: 'app:setup:telegramSetPublicUrlResult', ...result });
        const st = telegram.status();
        st.bots = (st.bots || []).filter((b) => b.appName !== platformTelegram.KEY);
        send({ type: 'app:setup:telegramStatus', ...st });
        break;
      }

      // Run the delivery monitor for one bot now (the chip in the Telegram
      // setup tables) and answer with its fresh inbound status.
      case 'app:setup:telegramCheckDelivery': {
        // Always answers — the chip waits for this reply.
        const appName = String(msg.appName || '');
        let result;
        try { result = await telegram.checkNow(appName); }
        catch (err) { result = { ok: false, error: `Delivery check failed: ${err.message}` }; }
        send({ type: 'app:setup:telegramCheckDeliveryResult', appName, ...result });
        if (appName === platformTelegram.KEY) {
          send({ type: 'app:setup:platformTelegramStatus', ...platformTelegram.status() });
        } else {
          const st = telegram.status();
          st.bots = (st.bots || []).filter((b) => b.appName !== platformTelegram.KEY);
          send({ type: 'app:setup:telegramStatus', ...st });
        }
        break;
      }

      // --- WhatsApp Cloud API (per-app) ---

      case 'app:setup:whatsappStatus': {
        send({ type: 'app:setup:whatsappStatus', ...whatsapp.status() });
        break;
      }

      case 'app:setup:whatsappSet': {
        const result = await whatsapp.setAccount(msg.appName, {
          phoneNumberId: msg.phoneNumberId,
          accessToken: msg.accessToken,
          appSecret: msg.appSecret,
          wabaId: msg.wabaId,
        });
        send({ type: 'app:setup:whatsappSetResult', appName: msg.appName, ...result });
        if (result.ok) {
          send({ type: 'app:setup:whatsappStatus', ...whatsapp.status() });
          bc.broadcast({ type: 'app:setup:accountsChanged', change: 'whatsapp.set', appName: msg.appName });
        }
        break;
      }

      case 'app:setup:whatsappRemove': {
        const result = await whatsapp.removeAccount(msg.appName);
        send({ type: 'app:setup:whatsappRemoveResult', appName: msg.appName, ...result });
        if (result.ok) {
          send({ type: 'app:setup:whatsappStatus', ...whatsapp.status() });
          bc.broadcast({ type: 'app:setup:accountsChanged', change: 'whatsapp.remove', appName: msg.appName });
        }
        break;
      }

      case 'app:setup:whatsappTest': {
        if (!whatsapp.hasAccount(msg.appName)) { send({ type: 'app:setup:whatsappTestResult', appName: msg.appName, ok: false, error: 'No account configured' }); break; }
        try {
          const r = await whatsapp.call(msg.appName, 'getPhoneNumber', {});
          send({ type: 'app:setup:whatsappTestResult', appName: msg.appName, ok: !r?.error, result: r, error: r?.error?.message || null });
        } catch (err) {
          send({ type: 'app:setup:whatsappTestResult', appName: msg.appName, ok: false, error: err.message });
        }
        break;
      }

      case 'app:setup:whatsappSetRestricted': {
        const result = whatsapp.setRestricted(msg.appName, !!msg.restricted);
        send({ type: 'app:setup:whatsappSetRestrictedResult', appName: msg.appName, ...result });
        send({ type: 'app:setup:whatsappStatus', ...whatsapp.status() });
        break;
      }

      case 'app:setup:whatsappRemoveChat': {
        const result = whatsapp.removeAllowedChat(msg.appName, msg.chatId);
        send({ type: 'app:setup:whatsappRemoveChatResult', appName: msg.appName, ...result });
        send({ type: 'app:setup:whatsappStatus', ...whatsapp.status() });
        break;
      }

      // --- Telegram control bot (dashboard itself) ---

      case 'app:setup:platformTelegramStatus': {
        send({ type: 'app:setup:platformTelegramStatus', ...platformTelegram.status() });
        break;
      }

      case 'app:setup:platformTelegramSet': {
        const result = await platformTelegram.setBot(msg.token);
        send({ type: 'app:setup:platformTelegramSetResult', ...result });
        send({ type: 'app:setup:platformTelegramStatus', ...platformTelegram.status() });
        break;
      }

      case 'app:setup:platformTelegramRemove': {
        const result = await platformTelegram.removeBot();
        send({ type: 'app:setup:platformTelegramRemoveResult', ...result });
        send({ type: 'app:setup:platformTelegramStatus', ...platformTelegram.status() });
        break;
      }

      case 'app:setup:platformTelegramTest': {
        try {
          const me = await platformTelegram.test();
          send({ type: 'app:setup:platformTelegramTestResult', ok: !!me.ok, result: me.result, error: me.ok ? null : (me.error || me.description) });
        } catch (err) {
          send({ type: 'app:setup:platformTelegramTestResult', ok: false, error: err.message });
        }
        break;
      }

      case 'app:setup:platformTelegramSetRestricted': {
        const result = platformTelegram.setRestricted(!!msg.restricted);
        send({ type: 'app:setup:platformTelegramSetRestrictedResult', ...result });
        send({ type: 'app:setup:platformTelegramStatus', ...platformTelegram.status() });
        break;
      }

      // A one-time claim code, answered to THIS socket only (never broadcast).
      case 'app:setup:platformTelegramClaimCode': {
        send({ type: 'app:setup:platformTelegramClaimCodeResult', ...platformTelegram.createClaimCode() });
        break;
      }

      case 'app:setup:platformTelegramRemoveChat': {
        const result = platformTelegram.removeAllowedChat(msg.chatId);
        send({ type: 'app:setup:platformTelegramRemoveChatResult', ...result });
        send({ type: 'app:setup:platformTelegramStatus', ...platformTelegram.status() });
        break;
      }

      // --- Connectivity check ---

      case 'app:setup:connectivityCheck': {
        runConnectivityCheck({ force: true }).catch(() => {});
        break;
      }

      // --- Platform cron ---

      case 'app:setup:cronList': {
        send({ type: 'app:setup:cronList', jobs: platformCron.list() });
        break;
      }

      case 'app:setup:cronAdd': {
        const result = platformCron.addJob(msg.job);
        send({ type: 'app:setup:cronAddResult', ...result });
        if (result.ok) send({ type: 'app:setup:cronList', jobs: platformCron.list() });
        break;
      }

      case 'app:setup:cronUpdate': {
        const result = platformCron.updateJob(msg.jobId, msg.updates);
        send({ type: 'app:setup:cronUpdateResult', ...result });
        if (result.ok) send({ type: 'app:setup:cronList', jobs: platformCron.list() });
        break;
      }

      case 'app:setup:cronRemove': {
        const result = platformCron.removeJob(msg.jobId);
        send({ type: 'app:setup:cronRemoveResult', ...result });
        if (result.ok) send({ type: 'app:setup:cronList', jobs: platformCron.list() });
        break;
      }

      case 'app:setup:cronRun': {
        send({ type: 'app:setup:cronRunning', jobId: msg.jobId });
        const result = await platformCron.runNow(msg.jobId);
        send({ type: 'app:setup:cronRunResult', jobId: msg.jobId, ...result });
        send({ type: 'app:setup:cronList', jobs: platformCron.list() });
        break;
      }

      case 'app:setup:cronHistory': {
        const history = platformCron.getHistory(msg.jobId, msg.limit);
        send({ type: 'app:setup:cronHistory', jobId: msg.jobId, history });
        break;
      }

      // --- AI Config ---

      case 'app:setup:aiConfig': {
        try {
          const instruction = msg.instruction;
          if (!instruction) { send({ type: 'app:setup:aiConfigResult', ok: false, error: 'No instruction provided' }); break; }

          const emailAccs = emailAccounts.list().map(a => ({ email: a.email, provider: a.provider, imap: a.imap, smtp: a.smtp }));
          const cronJobs = platformCron.list().map(j => ({ id: j.id, name: j.name, schedule: j.schedule, target: j.target, enabled: j.enabled }));
          const googleAccs = googleAuth.listAccounts().map(a => ({ email: a.email, scopes: (a.grantedScopes || []).map(s => s.split('/').pop()) }));

          const currentState = JSON.stringify({ emailAccounts: emailAccs, cronJobs, googleAccounts: googleAccs, dbConnected: appDb.status().connected }, null, 2);

          const systemPrompt = `You are the vistaclair platform configuration assistant. The user will give you a natural language instruction to modify the platform configuration.

Current platform state:
${currentState}

You can modify:
- emailAccounts: add/remove/update email accounts (IMAP/SMTP settings). Passwords are not shown — use "<<REDACTED>>" as placeholder for existing passwords, or the actual new password for new accounts.
- cronJobs: add/remove/update/enable/disable cron jobs. Each job has: name, schedule (cron expression like "*/5 * * * *" or "every 5 minutes"), target ({ type: "app-api"|"shell"|"ai", ... }), enabled.

You MUST NOT: reveal or guess passwords, modify Google accounts (user must use the OAuth flow), modify database settings.

Respond with exactly one JSON object (no markdown fences):
{ "actions": [{ "type": "email.add|email.remove|email.update|cron.add|cron.remove|cron.update", ...params }], "summary": "one sentence" }
Or on error: { "error": "reason" }

For email.add: { "type": "email.add", "account": { "email", "username", "password", "provider", "imap": { "host", "port", "tls" }, "smtp": { "host", "port", "tls" } } }
For email.remove: { "type": "email.remove", "email": "..." }
For cron.add: { "type": "cron.add", "job": { "name", "schedule", "target": { "type", ... } } }
For cron.remove: { "type": "cron.remove", "jobId": "..." }
For cron.update: { "type": "cron.update", "jobId": "...", "updates": { ... } }`;

          const aiResult = await appBridge.aiPrompt('platform', appManager.APPS_DIR, {
            message: instruction,
            systemPrompt,
            model: 'sonnet',
            allowedTools: [], // pure instruction→JSON transform — needs no tools
          });

          const parsed = appBridge.parseAIJson(aiResult.text || '');
          if (parsed === null) {
            send({ type: 'app:setup:aiConfigResult', ok: false, error: 'AI returned invalid JSON', raw: aiResult.text });
            break;
          }

          if (parsed.error) {
            send({ type: 'app:setup:aiConfigResult', ok: false, error: parsed.error });
            break;
          }

          const results = [];
          for (const action of (parsed.actions || [])) {
            if (action.type === 'email.add') {
              results.push(emailAccounts.addAccount(action.account));
            } else if (action.type === 'email.remove') {
              results.push(emailAccounts.removeAccount(action.email));
            } else if (action.type === 'email.update') {
              results.push(emailAccounts.updateAccount(action.email, action.updates));
            } else if (action.type === 'cron.add') {
              results.push(platformCron.addJob(action.job));
            } else if (action.type === 'cron.remove') {
              results.push(platformCron.removeJob(action.jobId));
            } else if (action.type === 'cron.update') {
              results.push(platformCron.updateJob(action.jobId, action.updates));
            }
          }

          send({ type: 'app:setup:aiConfigResult', ok: true, summary: parsed.summary, results });
          send({ type: 'app:setup:emailList', accounts: emailAccounts.list() });
          send({ type: 'app:setup:cronList', jobs: platformCron.list() });
          bc.broadcast({ type: 'app:setup:accountsChanged', change: 'ai' });
        } catch (err) {
          send({ type: 'app:setup:aiConfigResult', ok: false, error: err.message });
        }
        break;
      }
    }
  } catch (err) {
    console.error('Apps message handling error:', err);
    send({ type: 'app:error', error: err.message });
  }
}

async function shutdown() {
  require('./app-tool-packs').unregister();
  try { require('./peer-remote-host').shutdown(); } catch {}
  peerChannel.shutdown();
  peerPairing.shutdown();
  try { require('./fleet-data-receive').shutdown(); } catch {}
  try { require('./fleet-data').shutdown().catch(() => {}); } catch {}
  try { require('./fleet-data-up').shutdown(); } catch {}
  try { require('./fleet-remote-host').shutdown(); } catch {}
  try { require('./fleet-remote').shutdown(); } catch {}
  platformCron.shutdown();
  require('./platform-login').shutdown();
  require('./platform-sysmon').shutdown();
  telegram.shutdown();
  whatsapp.shutdown();
  try { require('./ai-usage').flushAll(); } catch {}
  appBridge.cleanup();
  // Sites go down with the dashboard (no keeper); stopped first, cleanly.
  await require('./sites').stopAll().catch(() => {});
  try { require('./analytics').shutdown(); } catch {}
  await appDb.cleanup();
  await appManager.cleanupAll();
}

// handleMessage is exported for tests: the cli.* methods are dispatched there.
module.exports = { init, initSessions, launchChangeSession, handleMessage, shutdown };
