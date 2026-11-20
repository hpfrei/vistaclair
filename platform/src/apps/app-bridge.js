// App bridge facade — the ONE entry point for iframe bridge calls
// (handleBridgeCall) plus the re-exported service surface the rest of the
// platform imports as `appBridge.*`.
//
// The bridge itself is thin: dispatch to the handler the capability module
// registered (src/apps/capabilities/<key>.js — the same module that builds
// the routes.js ctx), then a fixed error mapping. Open-world: any method the
// registry dispatches is callable — capability declarations are
// advertisements, not gates; the economic gate (spend-gate) is the control
// that remains. Every
// implementation lives in a service module (ai-service, ai-media, maps-service,
// web-search, app-tools, app-state, app-settings, app-secrets, app-http,
// spawn-manager, app-files); `init()` fans the host-injected functions out
// through core-services so no service needs its own init.

const path = require('path');
const appManager = require('./app-manager');
const capabilities = require('./capabilities');
const coreServices = require('./core-services');
const spawnManager = require('./spawn-manager');
const appTools = require('./app-tools');
const aiService = require('./ai-service');
const aiMedia = require('./ai-media');
const mapsService = require('./maps-service');
const webSearch = require('./web-search');
const appSettings = require('./app-settings');
const { safeJoin } = require('../utils');

function init(options) {
  coreServices.configure(options);
  if (options.store) require('./ai-usage').init({ store: options.store });
}

// The capability a method belongs to (advertisement vocabulary — open-world:
// nothing gates at runtime). Kept for the phase-2 MCP broker's tool routing
// and for anyone classifying a method the way the registry does.
function capabilityForMethod(method) {
  return capabilities.gatingCapabilityForMethod(method);
}

// The admin's revocations apply to the APP, not the route: a capability the
// spend policy revoked is refused on the Bridge exactly as it is absent from
// routes.js. Returns the refusal, or null. Shared with the cli.* methods the
// WS handler dispatches itself (index.js).
function revocationError(appName, method, revoked = null) {
  const set = revoked || require('./spend-policy').revokedCapabilities(appName, require('./deployment-mode').mode());
  const cap = capabilities.get(capabilities.capabilityKeyForMethod(method));
  return cap && capabilities.isRevoked(cap, set) ? `E_NOT_GRANTED: ${cap.key} is revoked for this app by the spend policy` : null;
}

function handleBridgeCall(appName, msg, respond, emitEvent) {
  const { id, method, params } = msg;
  const appDir = path.join(appManager.APPS_DIR, appName);

  const handler = capabilities.dispatch(method);
  if (!handler) {
    respond({ id, error: `Unknown bridge method: ${method}` });
    return;
  }

  let manifest = null;
  try { manifest = appManager.readManifest(appName); } catch {}
  const revoked = require('./spend-policy').revokedCapabilities(appName, require('./deployment-mode').mode());
  const refused = revocationError(appName, method, revoked);
  if (refused) {
    respond({ id, error: refused });
    return;
  }
  const caps = capabilities.makeCaps(manifest, 'dashboard', revoked);
  const app = {
    name: appName,
    dir: appDir,
    manifest: manifest || {},
    profile: 'bridge',
    caps,
    legacy: caps.legacy,
    resolvePath: (rel) => safeJoin(appDir, rel),
  };

  // Exactly one response per call, whether the handler returns, rejects, or
  // throws synchronously before its promise exists (e.g. params undefined).
  let done = false;
  const reply = (r) => { if (done) return; done = true; respond({ id, ...r }); };
  try {
    // Bridge calls are relayed over the owner's WebSocket: principal 'owner'.
    Promise.resolve(require('./spend-context').run({ app: appName, origin: 'bridge', principal: 'owner' }, () => handler(app, params, { emitEvent, method })))
      .then((result) => reply({ result }), (err) => reply({ error: err.message }));
  } catch (err) {
    reply({ error: err.message });
  }
}

// Called on app stop/close (and via remove/rename). Tears down transient spawned
// processes and the tool registry but NOT cron jobs — those are persisted in
// platform-cron and survive a stop. App deletion removes them explicitly.
function cleanupApp(name) {
  spawnManager.cleanupApp(name);
  appTools.clearAppTools(name);
}

module.exports = {
  init, handleBridgeCall, capabilityForMethod, revocationError,
  cleanupApp, cleanup: spawnManager.cleanup, listTasks: spawnManager.listTasks,
  // ai-service
  aiPrompt: aiService.aiPrompt, aiUsageQuery: aiService.aiUsageQuery, parseAIJson: aiService.parseAIJson,
  publicModelShape: aiService.publicModelShape, sortModelsByProvider: aiService.sortModelsByProvider, providerLabel: aiService.providerLabel,
  // ai-media
  aiTranscribe: aiMedia.aiTranscribe, aiTts: aiMedia.aiTts, aiSfx: aiMedia.aiSfx, elevenlabsDiagnose: aiMedia.elevenlabsDiagnose, aiImage: aiMedia.aiImage, aiTranslate: aiMedia.aiTranslate,
  aiDetect: aiMedia.aiDetect, translateDiagnose: aiMedia.translateDiagnose,
  // maps-service
  aiRoute: mapsService.aiRoute, aiRouteMatrix: mapsService.aiRouteMatrix, aiGeocode: mapsService.aiGeocode,
  aiPlaces: mapsService.aiPlaces, aiPlacePhoto: mapsService.aiPlacePhoto, aiStreetview: mapsService.aiStreetview,
  aiTiles3d: mapsService.aiTiles3d, mapsDiagnose: mapsService.mapsDiagnose,
  // web-search
  aiWebSearch: webSearch.aiWebSearch, webSearchDiagnose: webSearch.webSearchDiagnose,
  // app-tools
  registerAppTools: appTools.registerAppTools, registerAppToolHandler: appTools.registerAppToolHandler,
  getToolsForApp: appTools.getToolsForApp, clearAppTools: appTools.clearAppTools, callAppToolHandler: appTools.callAppToolHandler,
  getPlatformToolUnion: appTools.getPlatformToolUnion, getToolAudit: appTools.getToolAudit,
  resolveToolToken: appTools.resolveToolToken, callCrossAppTool: appTools.callCrossAppTool,
  // app-settings
  settingsGet: appSettings.settingsGet, settingsSet: appSettings.settingsSet, settingsAll: appSettings.settingsAll,
};
