// Host-injected services — the functions and objects core hands Pro through the
// addon ctx (see vistaclair/src/addon-host.js) and Pro's app-runner hands the
// same way. Set ONCE by app-bridge.init() (called from src/apps/index.js in the
// dashboard and from app-runner.js in a process-isolated app); every service
// module reads `core.<x>` at call time, never at load time, so load order and
// require cycles cannot capture a stale null.

const core = {
  proxyPort: 3456,
  spawnClaude: null,
  buildClaudeArgs: null,
  broadcaster: null,
  secretStore: null,
  // Headless Claude auth resolver (from core's capabilities registry).
  resolveHeadlessAuth: () => '',
  // Provider API key resolver: (providerKey) → decrypted key or ''.
  resolveProviderKey: () => '',
  // Model registry from core (capabilities/models.json + platform overrides).
  listModels: () => [],
  // The same registry with core's credential join applied: each model carries
  // { usable, unusableReason, credential }. THE definition of "callable now" —
  // never re-derive it here. Falls back to listModels under an older host.
  listModelsWithAvailability: null,
  // Core's non-text model catalog: () → [{ providerKey, modelId, kind, usedBy,
  // label, price, description }]. null under an older host — media-catalog then
  // falls back to the adapters' own defaults.
  listNativeModels: null,
  // Core's registry refresh (provider scan + models.dev catalog): () → Promise
  // of { scan, catalog, catalogError }. null under an older host — the daily
  // model review then checks the registry as it stands.
  refreshModels: null,
  // Core's credential decision: (authMode?) → { credential, key }.
  resolveAuth: () => ({ credential: null, key: '' }),
  // Inspector session lifecycle for headless spawns (core store-backed in the
  // dashboard, stubs in a runner).
  registerAiSession: () => null,
  unregisterAiSession: () => {},
  // Dashboard identity for spawned children (hook reporter env) — from core's
  // addon ctx; null under an older host.
  dashboardPort: null,
  authToken: null,
  // Proxy caller secret (core's local API proxy): getProxySecret() → string and
  // the header name it travels in. Absent under an older host — proxy-env.js then
  // adds no header.
  getProxySecret: null,
  proxySecretHeader: null,
};

function configure(options = {}) {
  if (options.proxyPort) core.proxyPort = options.proxyPort;
  if (options.spawnClaude) core.spawnClaude = options.spawnClaude;
  if (options.buildClaudeArgs) core.buildClaudeArgs = options.buildClaudeArgs;
  if (options.broadcaster) core.broadcaster = options.broadcaster;
  if (options.secretStore) core.secretStore = options.secretStore;
  if (options.resolveHeadlessAuth) core.resolveHeadlessAuth = options.resolveHeadlessAuth;
  if (options.resolveProviderKey) core.resolveProviderKey = options.resolveProviderKey;
  if (typeof options.listModels === 'function') core.listModels = options.listModels;
  if (typeof options.listModelsWithAvailability === 'function') core.listModelsWithAvailability = options.listModelsWithAvailability;
  if (typeof options.listNativeModels === 'function') core.listNativeModels = options.listNativeModels;
  if (typeof options.refreshModels === 'function') core.refreshModels = options.refreshModels;
  if (typeof options.resolveAuth === 'function') core.resolveAuth = options.resolveAuth;
  if (typeof options.registerAiSession === 'function') core.registerAiSession = options.registerAiSession;
  if (typeof options.unregisterAiSession === 'function') core.unregisterAiSession = options.unregisterAiSession;
  if (options.dashboardPort) core.dashboardPort = options.dashboardPort;
  if (options.authToken) core.authToken = options.authToken;
  if (typeof options.getProxySecret === 'function') core.getProxySecret = options.getProxySecret;
  if (typeof options.proxySecretHeader === 'string' && options.proxySecretHeader) core.proxySecretHeader = options.proxySecretHeader;
}

module.exports = { core, configure };
