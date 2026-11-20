#!/usr/bin/env node
// Standalone app runner: hosts ONE app as its own process (pm2-managed) on a
// loopback port, with nginx mapping the app's domain to it. The app consumes
// the same pro ctx it gets in the dashboard (standalone trust shape), and
// reaches core's proxy/broadcaster over loopback via the headless addon host.
//
//   node app-runner.js --app <name> --port <n>
//
// Two entry shapes, one invariant — exactly one process ever owns an app
// (its TG poller, its jobs):
//   1. Standalone (manifest.standalone === true): pm2-managed, own domain via
//      nginx. The dashboard refuses to start such apps at all.
//   2. Dashboard-managed (VISTACLAIR_MANAGED=1 + manifest runtime:
//      "own-process"): the dashboard itself spawns this runner on an
//      ephemeral loopback port and reverse-proxies /apps/<name> to it,
//      instead of require()ing the app's routes.js in-process. The
//      dashboard's telegram/app-jobs appFilter excludes own-process apps, so
//      this child is still the sole owner of the app's bot poll and job sweep.
// Any other manifest is refused — accepting it would double-host the app.
//
// Trust shape (both modes): this process dotenv-loads core's .env below, so
// it holds platform credentials (AUTH_TOKEN, provider keys) in its own
// process.env even though the app's routes.js gets only the restricted
// standalone ctx. runtime:"own-process" therefore buys crash/blocking
// isolation and keeps untrusted code OUT of the dashboard process — it is
// not a secrets sandbox for the child itself.
// Env: VISTACLAIR_CORE_DIR (default ../), VISTACLAIR_APPS_DIR (default
// <core>/vistaclair-apps), HOST (default 127.0.0.1).
//
// Seam: the ONLY core file this package loads by path is src/addon-host.js —
// the bootstrap that returns the addon ctx (headless profile). Everything else
// (paths, .env, keys, Claude spawning) comes through that ctx.

const fs = require('fs');
const path = require('path');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}

const appName = arg('app');
const port = parseInt(arg('port') || '', 10);
if (!appName || !port) {
  console.error('Usage: app-runner.js --app <name> --port <n>');
  process.exit(1);
}

const coreDir = path.resolve(process.env.VISTACLAIR_CORE_DIR || path.join(__dirname, '..'));
if (!fs.existsSync(path.join(coreDir, 'src', 'addon-host.js'))) {
  console.error(`Core not found at ${coreDir} (set VISTACLAIR_CORE_DIR). Requires a vistaclair core with src/addon-host.js.`);
  process.exit(1);
}

const { createAddonCtx } = require(path.join(coreDir, 'src', 'addon-host'));
// loadEnv: the runner reads core's .env itself (standalone trust shape, above).
const host = createAddonCtx({ loadEnv: true });

// The apps dir must be an existing absolute path: app-manager creates the dir
// it is pointed at on first read, so a relative or unset value would silently
// mint an empty tree (this is how a stray <pro>/undefined/apps once appeared).
const appsDir = process.env.VISTACLAIR_APPS_DIR || path.join(host.coreDir, 'vistaclair-apps');
if (!path.isAbsolute(appsDir) || !fs.existsSync(appsDir)) {
  console.error(`Apps dir must be an existing absolute path, got: ${appsDir} (VISTACLAIR_APPS_DIR)`);
  process.exit(1);
}

const appManager = require('./src/apps/app-manager');
appManager.setAppsDir(appsDir);

// Platform cron proves itself to THIS app with a per-app random secret
// (x-vistaclair-cron-sig), never core's AUTH_TOKEN: the dashboard hands it over
// in the child's env (managed spawn) or reads it from the standalone registry
// (cronSecret, written below). A request carrying it resolves as the app's
// owner (ctx.identity / app-auth via:'owner'); every x-vistaclair-* header is
// then stripped before app code runs (src/apps/internal-headers.js).
const cronSecret = process.env.VISTACLAIR_CRON_SECRET || require('crypto').randomBytes(32).toString('hex');
delete process.env.VISTACLAIR_CRON_SECRET;
const internalHeaders = require('./src/apps/internal-headers');
const cronOwner = (req) => {
  const got = req.headers['x-vistaclair-cron-sig'];
  if (typeof got !== 'string' || !got) return false;
  const a = Buffer.from(got), b = Buffer.from(cronSecret);
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
};
appManager.setOwnerCheck((req) => req._vcOwner === true);
appManager.setCoreDir(host.coreDir);

// Spend policy + attribution in the headless profile: the admin's policy and
// the deployment mode are read from core's dataHome exactly as the dashboard
// reads them; ledger records are relayed to the dashboard (one writer).
try {
  require('./src/apps/spend-policy').init({ dataHome: host.dataHome });
  require('./src/apps/spend-ledger').init({ dataHome: host.dataHome, relay: (entry) => host.broadcaster.broadcast({ type: 'app:spend:record', entry }) });
  require('./src/apps/spend-context').init({ isOwnerRequest: (req) => req._vcOwner === true });
  require('./src/apps/deployment-mode').init({ hostConfig: require('./src/apps/host-config'), appManager });
} catch (e) { console.warn('  spend init failed:', e.message); }

const manifest = appManager.readManifest(appName);
if (!manifest) {
  console.error(`App "${appName}" not found in ${appsDir}`);
  process.exit(1);
}
// Double-hosting guard: exactly one process may own an app's TG poller and
// jobs. Standalone apps qualify because the dashboard refuses to start them;
// dashboard-managed spawns (VISTACLAIR_MANAGED=1 + runtime:"own-process")
// qualify because the dashboard never mounts such apps in-process and its
// telegram/jobs appFilter excludes them. Everything else is refused.
const managed = process.env.VISTACLAIR_MANAGED === '1' && manifest.runtime === 'own-process';
if (manifest.standalone !== true && !managed) {
  console.error(`App "${appName}" is not marked standalone. Set "standalone": true in its manifest.json (and restart the dashboard) before running it here — otherwise two processes would host it. (Dashboard-managed spawning requires VISTACLAIR_MANAGED=1 AND manifest runtime: "own-process".)`);
  process.exit(1);
}

const broadcaster = { broadcast: (msg) => host.broadcaster.broadcast(msg) };

const appBridge = require('./src/apps/app-bridge');
const appDb = require('./src/apps/app-db');
const telegram = require('./src/apps/telegram');
const whatsapp = require('./src/apps/whatsapp');
const appIdentity = require('./src/apps/app-identity');
const secretStore = host.secretStore;

appBridge.init({
  proxyPort: host.proxyPort,
  spawnClaude: host.spawnClaude,
  buildClaudeArgs: host.buildClaudeArgs,
  broadcaster,
  secretStore,
  resolveHeadlessAuth: host.resolveHeadlessAuth,
  resolveProviderKey: host.resolveProviderKey,
  listModels: host.listModels,
  listModelsWithAvailability: host.listModelsWithAvailability,
  listNativeModels: host.listNativeModels,
  refreshModels: host.refreshModels,
  resolveAuth: host.resolveAuth,
  registerAiSession: host.registerAiSession,
  unregisterAiSession: host.unregisterAiSession,
});
appDb.initAppUser(appsDir, appName);
require('./src/apps/platform-settings').init(appsDir);
telegram.init(appsDir, secretStore, broadcaster);
telegram.start((n) => n === appName); // this process polls ONLY this app's bot
whatsapp.init(appsDir, secretStore, broadcaster);
appIdentity.init(appsDir, secretStore);
require('./src/apps/app-jobs').init({ appsDir, broadcaster, appFilter: (n) => n === appName });
require('./src/apps/embeddings').init(appsDir);

// Email sending for auth flows (verification mails). IMAP/SMTP only — Gmail
// needs the owner's googleAuth, which stays in the dashboard process.
if (manifest.auth && manifest.auth.email) {
  try {
    require('./src/apps/email-accounts').init(appsDir, secretStore);
    require('./src/apps/email-engine').init(appsDir, secretStore, broadcaster);
    require('./src/apps/email-sync-imap');
  } catch (e) {
    console.warn(`  email engine unavailable: ${e.message}`);
  }
}

const registryPath = path.join(appsDir, '.standalone.json');
function updateRegistry(mutate) {
  let reg = {};
  try { reg = JSON.parse(fs.readFileSync(registryPath, 'utf-8')); } catch {}
  mutate(reg);
  try { fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2)); }
  catch (e) { console.warn(`  registry write failed: ${e.message}`); }
}

(async () => {
  await appDb.ready();
  if (appDb.getPool()) console.log(`  DB: per-app pool for '${appName}'`);

  const entry = await appManager.mountRoutes(appName, broadcaster, { mode: 'standalone' });

  const express = require('express');
  const app = express();
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    internalHeaders.markOwner(req, cronOwner);
    internalHeaders.strip(req);
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, app: appName, uptime: process.uptime() }));
  // Compatibility alias: app frontends use relative paths, but any absolute
  // /apps/<name>/... reference keeps working behind the app's own domain.
  app.use(`/apps/${appName}`, entry.router);
  app.use('/', entry.router);

  const bindHost = process.env.HOST || '127.0.0.1';
  const server = app.listen(port, bindHost, () => {
    console.log(`  ${appName} listening on http://${bindHost}:${port}`);
    // .standalone.json is the STANDALONE runner registry (platform-cron routes
    // app-api cron calls by it, keyed on manifest.standalone === true).
    // Dashboard-managed children stay out of it — the dashboard already
    // tracks their live port in its runningApps map.
    if (!managed) updateRegistry((reg) => { reg[appName] = { port, pid: process.pid, startedAt: Date.now(), cronSecret }; });
  });
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : `Server error: ${err.message}`);
    process.exit(1);
  });

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('  shutting down...');
    const deadline = setTimeout(() => process.exit(0), 8000);
    deadline.unref();
    server.close();
    telegram.shutdown();
    try { await appManager.stopApp(appName); } catch {}
    try { await appDb.cleanup(); } catch {}
    if (!managed) updateRegistry((reg) => { if (reg[appName]?.pid === process.pid) delete reg[appName]; });
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})().catch((err) => {
  console.error(`Failed to start ${appName}: ${err.message}`);
  process.exit(1);
});
