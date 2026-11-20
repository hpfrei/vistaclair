// Shared app-lifecycle operations — ONE implementation per owner mutation
// (create / delete / rename / stop / setConfig), called by BOTH the dashboard WS
// handlers in index.js (owner clicks — a click IS the approval) and the
// governed kinds in capabilities/apps.js (an AI's path — proposal-gated,
// ceiling-pinned to propose). Phase 6: every owner mutation is a governed
// kind; the WS path stays for owner clicks, the kind path adds governance.
//
// init() is called from index.js with the dashboard-process dependencies
// (the CLI session manager and the auth-exemption rebuilder live only there);
// the broadcaster comes through core-services like everywhere else. Errors
// are thrown — each caller translates them for its own surface.

let deps = { cliSessionManager: null, rebuildPublicExemptions: null };

function init(options = {}) {
  deps = {
    cliSessionManager: options.cliSessionManager || null,
    rebuildPublicExemptions: typeof options.rebuildPublicExemptions === 'function' ? options.rebuildPublicExemptions : null,
  };
}

function bc() { return require('./core-services').core.broadcaster; }

function broadcastList() {
  const b = bc();
  if (b) b.broadcast({ type: 'app:list', apps: require('./app-manager').list() });
}

function rebuildExemptions(label) {
  if (!deps.rebuildPublicExemptions) return;
  try { deps.rebuildPublicExemptions(); } catch (err) { console.warn(`  ${label}: exemption rebuild failed:`, err.message); }
}

// Create a new (empty) app. Returns { name }.
function createApp(name, description) {
  const result = require('./app-manager').create(name, description);
  if (result.error) throw new Error(result.error);
  broadcastList();
  return { name: result.name };
}

// Delete an app and everything the platform holds for it.
async function deleteApp(name) {
  // Terminate any AI sessions the app spawned at runtime (cli.edit,
  // cli.workspace) and drop their persisted data — the app is being removed.
  if (deps.cliSessionManager) {
    deps.cliSessionManager.remove(`app-${name}`);
    deps.cliSessionManager.remove(`app-${name}-tools`);
  }
  require('./cli-workspace').killWorkspaceSessions(name, { remove: true });
  const result = await require('./app-manager').remove(name);
  if (result.error) throw new Error(result.error);
  // Drop a deleted public app's dangling auth exemption immediately.
  rebuildExemptions('delete');
  broadcastList();
  return { name };
}

// Stop an app and everything it runs: spawned helpers, the AI sessions it
// launched at runtime (cli.edit, cli.workspace — kill() keeps their history
// so the work can be resumed). Closing a dashboard tab is NOT a stop.
// Its sites keep running unless `stopSites` (the owner's "Stop sites too").
async function stopApp(name, { stopSites = false } = {}) {
  require('./app-bridge').cleanupApp(name);
  if (stopSites) await require('./sites').stopApp(name);
  if (deps.cliSessionManager) {
    deps.cliSessionManager.kill(`app-${name}`);
    deps.cliSessionManager.kill(`app-${name}-tools`);
  }
  require('./cli-workspace').killWorkspaceSessions(name);
  await require('./app-manager').stopApp(name);
  const b = bc();
  if (b) b.broadcast({ type: 'app:stopped', appName: name });
  broadcastList();
  return { name };
}

// Rename an app. Returns { oldName, newName, warnings }.
async function renameApp(name, newName) {
  const result = await require('./app-manager').rename(name, newName);
  if (result.error) throw new Error(result.error);
  // Its workspace sessions sit in a folder that just moved; they are found by
  // the old name's stamp. kill() keeps their history.
  require('./cli-workspace').killWorkspaceSessions(name);
  // A renamed public app must be exempt under its NEW name at once —
  // and the old name's exemption must go.
  rebuildExemptions('rename');
  const b = bc();
  if (b) b.broadcast({ type: 'app:renamed', oldName: result.oldName, newName: result.newName, warnings: result.warnings || [] });
  broadcastList();
  return result;
}

// App Config write — persist the ACCESS LEVEL (the one exposure decision),
// login channels, sender, licence, domain, description, autostart, full-screen
// presentation and platform contribution.
//
//   access: 'private' | 'users' | 'open'
//     private  every login channel off; the auth block goes away entirely
//              unless it carries an object-form licence (kept verbatim)
//     users    at least one channel on (400 otherwise); no "**"
//     open     channels forced off, "**" prepended to surfaces.public.pages,
//              the owner-service revocations seeded into the spend policy
//   auth:   { telegram?, whatsapp?, email?, license? } — merged over the manifest's
//   senderEmail, domain, description, autostart, display, platformContribution
//
// Exposure writes the canonical `surfaces` block and absorbs the legacy fields
// (public/publicHome/entry/auth.publicRoutes — updateManifest spreads, and
// JSON.stringify drops undefined-valued keys). Nothing about the entry surface
// is written: it is `app` for every users-level app, derived from the auth
// block at read time. Rebuilds the public exemptions (an exposure change takes
// effect with no restart), then broadcasts the new list.
const LEVELS = ['private', 'users', 'open'];
const CHANNELS = ['telegram', 'whatsapp', 'email'];

function setAppConfig(name, msg = {}) {
  const appManager = require('./app-manager');
  const deploymentMode = require('./deployment-mode');
  const surfaces = require('./surfaces');
  const current = appManager.readManifest(name);
  if (!current) throw new Error(`unknown app "${name}"`);
  const updates = {};
  if (typeof msg.display === 'string') updates.display = msg.display === 'fullscreen' ? 'fullscreen' : 'inline';
  if (typeof msg.description === 'string') updates.description = msg.description;
  if (typeof msg.autostart === 'boolean') updates.autostart = msg.autostart;
  if (typeof msg.domain === 'string') updates.domain = appManager.normalizeDomain(msg.domain); // hostname or null; throws on anything else
  if (msg.access !== undefined && !LEVELS.includes(msg.access)) throw new Error(`access must be one of ${LEVELS.join(', ')}`);

  // --- auth block (channels + sender + licence) ---
  let auth = { ...(current.auth || {}) };
  let authTouched = false;
  if (msg.auth && typeof msg.auth === 'object') {
    for (const k of CHANNELS) if (typeof msg.auth[k] === 'boolean') auth[k] = msg.auth[k];
    if ('license' in msg.auth) auth.license = msg.auth.license || null;
    authTouched = true;
  }
  if (typeof msg.senderEmail === 'string') { auth.sender = msg.senderEmail || null; authTouched = true; }
  if (msg.access === 'private' || msg.access === 'open') { for (const k of CHANNELS) auth[k] = false; authTouched = true; }
  if (msg.access === 'users' && !CHANNELS.some((k) => auth[k])) {
    throw new Error('access level "users" needs at least one login channel (Telegram, WhatsApp or email)');
  }
  const exposureTouched = msg.access !== undefined || authTouched;
  if (exposureTouched) delete auth.publicRoutes; // absorbed into surfaces.public.api

  // --- surfaces block ---
  let seedOpen = false;
  if (exposureTouched) {
    const eff = surfaces.readSurfaces({ ...current, auth }); // normalized, legacy folded in
    const level = msg.access !== undefined ? msg.access : eff.level;
    let pages = eff.public.pages.filter((g) => g !== '**');
    if (level === 'open') { pages = ['**', ...pages]; seedOpen = true; }
    const pub = {};
    if (eff.public.landing) pub.landing = eff.public.landing;
    if (pages.length) pub.pages = pages;
    if (eff.public.api.length) pub.api = eff.public.api;
    const block = {};
    if (Object.keys(pub).length) block.public = pub;
    updates.surfaces = Object.keys(block).length ? block : undefined;   // no `user` key: the entry surface is derived, never declared
    updates.public = undefined; updates.publicHome = undefined; updates.entry = undefined;
  }
  if (authTouched) {
    // Tidy: drop false channels and null fields; drop the whole block when
    // nothing substantive remains (an object-form licence keeps it).
    for (const k of CHANNELS) if (!auth[k]) delete auth[k];
    for (const k of Object.keys(auth)) if (auth[k] === null || auth[k] === undefined || auth[k] === '') delete auth[k];
    updates.auth = Object.keys(auth).length ? auth : undefined;
  }

  const prevContrib = appManager.contributes(name);
  if (typeof msg.platformContribution === 'boolean') updates.platformContribution = msg.platformContribution;
  const prevMode = deploymentMode.mode();
  appManager.updateHostConfig(name, updates); // a slave mirror: this host's overlay, not the master's manifest
  let seeded = [];
  if (seedOpen) {
    try { seeded = require('./spend-policy').seedOpenGrants(name, appManager.readManifest(name) || {}); }
    catch (err) { console.warn(`[app:${name}] could not seed open-level revocations: ${err.message}`); }
  }
  deploymentMode.invalidate(); // open / domain flips change the auto-detected mode
  rebuildExemptions('setConfig');
  const b = bc();
  // Contribution flip → refresh Horst's capability digest (the tools
  // broadcast is his rebuild trigger; the union itself filters live).
  if (b && typeof msg.platformContribution === 'boolean' && msg.platformContribution !== prevContrib) {
    b.broadcast({ type: 'app:tools:updated', appName: name, tools: require('./app-bridge').getToolsForApp(name) });
  }
  // Revocations are structural (applied when routes.js mounts): tell the
  // dashboard which apps need a restart — this one when open-level grants were
  // seeded, and any app whose revoked set differs when the mode flipped.
  const spendAdmin = require('./spend-admin');
  if (seeded.length) spendAdmin.broadcastRestartHint(name, `Restart to apply the open-level revocations (${seeded.join(', ')})`);
  spendAdmin.broadcastModeChangeHints(prevMode, deploymentMode.mode());
  broadcastList();
  return { name, access: surfaces.accessLevel(appManager.readManifest(name) || {}), seeded };
}

module.exports = { init, createApp, deleteApp, renameApp, stopApp, setAppConfig };
