const fs = require('fs');
const net = require('net');
const path = require('path');
const express = require('express');
const { spawn, exec: execCb } = require('child_process');
const { promisify } = require('util');
const { ensureDir, readJSON, writeJSON, safeJoin, killWithTimeout } = require('../utils');
const appDb = require('./app-db');
const platformCron = require('./platform-cron');
const telegram = require('./telegram');
const whatsapp = require('./whatsapp');

const execAsync = promisify(execCb);

let APPS_DIR = path.join(path.dirname(path.dirname(__dirname)), '..', 'vistaclair-apps');
let _bridgeCleanupFn = null;

function setAppsDir(dir) {
  APPS_DIR = dir;
}

// Core's package root (ctx.coreDir) — handed to process-isolated app-runners
// so they bootstrap against the same core that spawned them.
let CORE_DIR = null;

function setCoreDir(dir) {
  CORE_DIR = dir;
}

function setBridgeCleanup(fn) {
  _bridgeCleanupFn = fn;
}

// Platform-owner request check (core's ctx.isOwnerRequest), threaded into
// ctx.identity.resolve so a request carrying valid owner credentials resolves
// as via:'owner'. Full credential re-validation — safe on auth-exempt paths.
let _ownerCheckFn = null;

function setOwnerCheck(fn) {
  _ownerCheckFn = typeof fn === 'function' ? fn : null;
}
function getOwnerCheck() { return _ownerCheckFn; }

// Per-app cron signature for own-process children: platform-cron sends it to
// the child directly (never AUTH_TOKEN), the runner resolves a request that
// carries it as the owner of THAT app only (app-runner.js). Random per spawn,
// handed to the child through its env, held here for platform-cron.
const cronSecrets = new Map(); // app -> secret
function getCronSecret(name) { return cronSecrets.get(name) || null; }

const VALID_APP_NAME = /^[a-z0-9][a-z0-9-]*$/;

function validateAppName(name) {
  if (!name || !VALID_APP_NAME.test(name)) {
    throw new Error(`Invalid app name: "${name}"`);
  }
}

const safePath = safeJoin;

function isValidAppName(name) { return !!name && VALID_APP_NAME.test(name); }

// ONE bookkeeping map for every live app (runtime collapse, phase 4):
// appName → entry.
//   in-process:  { name, runtime: 'in-process',  type: 'mounted', status: 'mounted', router, cleanup }
//   own-process: { name, runtime: 'own-process', type: 'process', status, port, proc, pid, logStream }
// `type` is the legacy field kept for one release so older clients keep
// rendering; `runtime` is the truth.
const liveApps = new Map();

// Prevents concurrent mount/start for the same app
const startingApps = new Set();

// Dynamic port allocation starting point (own-process apps only)
let nextPort = 4000;

// One app shape (routes.js + public/ + manifest), two placements:
//   'in-process'  — the default: routes.js is require()d into the dashboard.
//   'own-process' — manifest runtime: "own-process": the same routes.js is
//     hosted by a dashboard-managed app-runner child on a loopback port,
//     reverse-proxied at /apps/<name>. pm2-managed standalone apps
//     (manifest standalone: true) are also own-process — just not
//     dashboard-managed (startApp refuses them; their runner is external).
// Apps with only a public/ frontend still run in-process: a no-op setup is
// fine and the loader serves public/ as a static fallback.
function appRuntime(name) {
  const entry = liveApps.get(name);
  if (entry) return entry.runtime;
  const manifest = readManifest(name);
  if (manifest?.standalone === true || manifest?.runtime === 'own-process') return 'own-process';
  return 'in-process';
}

// Dashboard-managed own-process app: the dashboard spawns and supervises its
// app-runner child (standalone apps are own-process too, but externally
// managed — startApp refuses them before this is ever consulted).
function isOwnProcess(name) {
  try {
    const manifest = readManifest(name);
    return manifest?.runtime === 'own-process' && manifest?.standalone !== true;
  } catch { return false; }
}

// The telegram / app-jobs ownership filter: does the dashboard process handle
// this key? A reserved key that is not an app name (the control bot's
// `__platform__`) is always the dashboard's; it must never reach readManifest
// (appDir throws on it). Standalone and own-process apps are not.
function runsInDashboardProcess(name) {
  if (!isValidAppName(name)) return true;
  return readManifest(name)?.standalone !== true && !isOwnProcess(name);
}

function appsDir() {
  ensureDir(APPS_DIR);
  return APPS_DIR;
}

// True if this copy of the app was published here from a master (every code
// deploy writes .deployed.json). Distinguishes master-owned mirrors from apps
// the slave owner created locally, which slave mode must not restrict.
function isMasterDeployed(name) {
  try { return fs.existsSync(path.join(appDir(name), '.deployed.json')); } catch { return false; }
}

function appDir(name) {
  validateAppName(name);
  return path.join(appsDir(), name);
}

function guardErrorCount(name) {
  try { return require('./app-guard').status(name).count; } catch { return 0; }
}

function list() {
  ensureDir(APPS_DIR);
  const entries = [];
  try {
    for (const name of fs.readdirSync(APPS_DIR)) {
      if (name.startsWith('.')) continue;
      const dir = path.join(APPS_DIR, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const manifest = readManifest(name);
      if (manifest) {
        const entry = liveApps.get(name);
        const runtime = entry?.runtime
          || (manifest.standalone === true || manifest.runtime === 'own-process' ? 'own-process' : 'in-process');
        entries.push({
          name,
          ...manifest,
          hasRoutes: fs.existsSync(path.join(dir, 'routes.js')),
          hasAppMd: fs.existsSync(path.join(dir, 'APP.md')),
          hasEntryPage: fs.existsSync(path.join(dir, 'public', 'app.html')), // the users-level cookieless entry
          deployed: fs.existsSync(path.join(dir, '.deployed.json')),
          // Mirror settings this host overrides (.host-config.json); absent
          // when there are none, like the keys below.
          ...(hostConfigKeys(name).length ? { hostConfig: hostConfigKeys(name) } : {}),
          running: entry?.status === 'running' || entry?.status === 'mounted',
          _starting: entry?.status === 'starting',
          // Only own-process apps ever populate processCrashes, so the key is
          // absent (not false) for everything else — payloads for existing
          // apps stay byte-identical.
          ...(processCrashes.has(name) ? { _crashed: true } : {}),
          // Same rule: only present once the guard has recorded a failure.
          ...(guardErrorCount(name) > 0 ? { _errors: guardErrorCount(name) } : {}),
          port: entry?.port || null,
          runtime,
          // Legacy field, kept for one release (clients migrate to `runtime`).
          type: runtime === 'in-process' ? 'mounted' : 'process',
        });
      }
    }
  } catch {}
  return entries;
}

// Per-host config of a master-published mirror. manifest.json belongs to the
// master (every publish replaces it), so what the App Config modal changes on
// a slave lives in .host-config.json — kept across publishes (CODE_PRESERVE)
// and merged over the manifest on read. A null value masks a manifest key.
// The overlay only holds keys that differ from the published manifest, so the
// master's later changes to anything not overridden here still arrive.
const HOST_CONFIG_FILE = '.host-config.json';

function readManifest(name) {
  const manifest = readJSON(path.join(appDir(name), 'manifest.json'), null);
  if (!manifest) return null;
  const overlay = readJSON(path.join(appDir(name), HOST_CONFIG_FILE), null);
  if (!overlay || typeof overlay !== 'object') return manifest;
  for (const [k, v] of Object.entries(overlay)) {
    if (v === null) delete manifest[k]; else manifest[k] = v;
  }
  return manifest;
}

function updateManifest(name, updates) {
  const manifestPath = path.join(appDir(name), 'manifest.json');
  const current = readJSON(manifestPath, {});
  writeJSON(manifestPath, { ...current, ...updates });
}

// Key-order-independent JSON, so "same as the manifest" survives a rebuilt
// object. null and absent are the same value here.
function canonical(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// Owner-set configuration (App Config). A local app writes its manifest; a
// mirror writes the per-host overlay, leaving the master's manifest intact.
function updateHostConfig(name, updates) {
  if (!isMasterDeployed(name)) return updateManifest(name, updates);
  const dir = appDir(name);
  const published = readJSON(path.join(dir, 'manifest.json'), {});
  const overlayPath = path.join(dir, HOST_CONFIG_FILE);
  const overlay = readJSON(overlayPath, {}) || {};
  for (const [k, v] of Object.entries(updates)) overlay[k] = v === undefined ? null : v;
  for (const k of Object.keys(overlay)) {
    if (canonical(overlay[k]) === canonical(published[k])) delete overlay[k];
  }
  if (Object.keys(overlay).length) writeJSON(overlayPath, overlay);
  else fs.rmSync(overlayPath, { force: true });
}

// The keys this host overrides on a mirror ([] when none / not a mirror).
function hostConfigKeys(name) {
  const overlay = readJSON(path.join(appDir(name), HOST_CONFIG_FILE), null);
  return overlay && typeof overlay === 'object' ? Object.keys(overlay) : [];
}

function readAppMd(name) {
  const mdPath = path.join(appDir(name), 'APP.md');
  try {
    return fs.readFileSync(mdPath, 'utf-8');
  } catch {
    return null;
  }
}

function create(name, description) {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!slug) return { error: 'Invalid app name' };
  const dir = appDir(slug);
  if (fs.existsSync(dir)) return { error: `App "${slug}" already exists` };
  ensureDir(dir);
  ensureDir(path.join(dir, 'public'));
  writeJSON(path.join(dir, 'manifest.json'), {
    name: slug,
    description: description || '',
    createdAt: Date.now(),
  });
  fs.writeFileSync(path.join(dir, 'public', 'index.html'),
`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${slug}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="app"></div>
  <script src="/pro/app-runtime.js"></script>
  <script src="/pro/vc.js"></script>
  <script src="app.js"></script>
</body>
</html>
`);
  fs.writeFileSync(path.join(dir, 'public', 'style.css'), '@import url(\'/pro/app-theme.css\');\n');
  fs.writeFileSync(path.join(dir, 'public', 'app.js'), 'async function init() {\n\n}\n\ninit();\n');
  // Apps run mounted (in-process). routes.js is the backend entry point; a
  // frontend-only app keeps setup empty and works entirely through the bridge.
  fs.writeFileSync(path.join(dir, 'routes.js'),
    '// Mounted in-process at /apps/' + slug + '/. The loader pre-applies\n' +
    '// express.json({ limit: \'10mb\' }) and serves public/ as a static fallback\n' +
    '// after your routes. Add server-side routes here, or leave setup empty for\n' +
    '// a bridge-only frontend. Optionally return a (sync/async) cleanup function.\n' +
    'module.exports = function setup(router, ctx) {\n\n};\n');
  return { name: slug, dir };
}

async function remove(name) {
  if (_bridgeCleanupFn) _bridgeCleanupFn(name);
  await stopApp(name);
  const dir = appDir(name);
  if (!fs.existsSync(dir)) return { error: 'App not found' };
  fs.rmSync(dir, { recursive: true, force: true });
  // App deletion drops its database, DB user and credentials (stop preserves
  // them). Irreversible — the app's data goes with it.
  try {
    const res = await appDb.deprovisionApp(name);
    if (res && res.reason === 'db-offline') {
      console.warn(`[app:${name}] DB offline — database '${res.database}' and user '${res.user}' left in place`);
    }
  } catch (err) {
    console.warn(`[app:${name}] DB deprovision failed: ${appDb.friendlyDbError(err)}`);
  }
  // App deletion removes its persisted cron jobs (stop preserves them).
  try { platformCron.removeByApp(name); } catch {}
  try { require('./platform-sysmon').removeApp(name); } catch {}
  try { require('./agent/horst-events').removeApp(name); } catch {}
  // Remove the app's Telegram bot (clears webhook / stops its poll loop).
  try { await telegram.removeBot(name); } catch {}
  // Remove the app's WhatsApp account (stops inbound routing to it).
  try { await require('./whatsapp').removeAccount(name); } catch {}
  return { ok: true };
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.gz', '.tar', '.br', '.zst',
  '.pdf', '.doc', '.docx',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm',
  '.sqlite', '.db',
]);

function replaceInTextFiles(dir, oldStr, newStr) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.history', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      replaceInTextFiles(full, oldStr, newStr);
      continue;
    }
    if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    try {
      const buf = fs.readFileSync(full);
      if (buf.includes(0)) continue;
      const content = buf.toString('utf-8');
      if (!content.includes(oldStr)) continue;
      fs.writeFileSync(full, content.replaceAll(oldStr, newStr), 'utf-8');
    } catch {}
  }
}

// Everything a rename will touch, surfaced to the GUI so the user can review
// side effects (and required manual follow-ups) before confirming. Synchronous
// on purpose: reads only in-memory config, never the database.
function renamePreflight(name) {
  validateAppName(name);
  if (!fs.existsSync(path.join(appsDir(), name))) return { error: 'App not found' };
  const running = liveApps.has(name);
  const bot = telegram.getBot(name);
  const acct = whatsapp.getAccount(name);
  let cronJobs = 0;
  try { cronJobs = platformCron.listByApp(name).length; } catch {}
  let db = null;
  try {
    const info = appDb.getAppDb(name);
    if (info) db = { database: info.database };
  } catch {}
  return {
    ok: true,
    running,
    telegram: bot ? { botUsername: bot.botUsername || null, mode: bot.mode, publicUrl: telegram.getPublicUrl() } : null,
    whatsapp: acct ? { displayPhone: acct.displayPhone || null } : null,
    cronJobs,
    db,
    dbConnected: !!appDb.getPool(),
  };
}

// Read-only cross-app messaging-channel lookup (bridge `apps.access`, ctx.apps).
// Answers purely from the platform binding stores (telegram/whatsapp registries),
// so it works while the target app is stopped — no lazy-mount, no network probe.
// Identity fields only; token/secret material never leaves this function. The
// cached botUsername/botId (resolved via getMe at bind time, refreshed whenever
// the token is re-saved) makes the lookup free.
function appAccess(target) {
  validateAppName(target);
  if (!fs.existsSync(path.join(appsDir(), target))) throw new Error(`App "${target}" not found`);
  const bot = telegram.getBot(target);
  const acct = whatsapp.getAccount(target);
  const waDigits = acct?.displayPhone ? String(acct.displayPhone).replace(/\D/g, '') : '';
  return {
    app: target,
    telegram: bot ? {
      configured: true,
      botUsername: bot.botUsername || null,
      botId: bot.botId || null,
      webAppEnabled: !!bot.webAppEnabled,
      // restricted bots only serve their allowlist — a published deep link would
      // be dead for first-time strangers, same caveat as WhatsApp below
      restricted: !!bot.restricted,
      deepLink: bot.botUsername ? `https://t.me/${bot.botUsername}` : null,
    } : null,
    whatsapp: acct ? {
      configured: true,
      displayPhone: acct.displayPhone || null,
      restricted: !!acct.restricted,
      waLink: waDigits ? `https://wa.me/${waDigits}` : null,
    } : null,
    publicUrl: telegram.webAppUrl(target),
  };
}

// The public picture of ONE app, for the admin: the external base a sysadmin
// would map in nginx, the URLs that base yields, the exact paths an anonymous
// visitor reaches, and the mismatches worth warning about. The read companion
// of app-lifecycle.setAppConfig, and the dashboard's ONE source for all of it —
// every answer is derived here from surfaces.js (the pure perimeter module the
// request path itself uses), never re-implemented in the browser.
//
// The base is resolved, not guessed: a recorded custom domain is the origin
// visitors type, so it wins; otherwise the platform's configured public URL
// (Setup → Telegram) is the only externally-valid origin this host knows. With
// neither, `base` is null and the caller says so instead of pretending.
function accessInfo(name) {
  validateAppName(name);
  const surfaces = require('./surfaces');
  const manifest = readManifest(name);
  if (!manifest) throw new Error(`App "${name}" not found`);
  const dir = appDir(name);
  const srf = surfaces.readSurfaces(manifest);

  const domain = typeof manifest.domain === 'string' && manifest.domain ? manifest.domain : null;
  let publicUrl = '';
  try { publicUrl = telegram.getPublicUrl() || ''; } catch {}
  const base = domain ? `https://${domain}` : (publicUrl || null);
  const baseSource = domain ? 'domain' : publicUrl ? 'public-url' : null;
  // A custom domain is proxied AT the app subtree (the nginx snippet below
  // maps `location /` → `/apps/<name>/`), so its entry is the domain root; the
  // platform base serves the same app one level down, under /apps/.
  const entryUrl = !base ? null : domain ? `${base}/` : `${base}/apps/${name}/`;

  let bot = null;
  try { bot = telegram.getBot(name); } catch {}
  // What a bot's web_app button must open — always the platform base, never
  // the custom domain (telegram.js builds it from the public URL alone).
  let miniAppUrl = null;
  try { miniAppUrl = manifest.auth && manifest.auth.telegram ? telegram.webAppUrl(name) : null; } catch {}

  // Guard exemptions, each answered against the cookie exemptions the request
  // path actually installs: a prefix that is guard-exempt but still behind the
  // owner login is a dead declaration, and worth saying so.
  const patterns = surfaces.buildAppPatterns(name, manifest);
  const guardExempt = surfaces.publicApiPrefixes(manifest).map((prefix) => ({
    prefix,
    declared: srf.public.api.includes(prefix),
    cookieless: patterns.some((re) => re.test(`/apps/${name}${prefix}`)),
  }));

  const hasEntryPage = fs.existsSync(path.join(dir, 'public', `${surfaces.ENTRY}.html`));
  const warnings = [];
  const warn = (code, text) => warnings.push({ level: 'warn', code, text });
  const note = (code, text) => warnings.push({ level: 'info', code, text });

  if (srf.level !== 'private' && !base) {
    warn('no-base', 'No public URL is configured (Setup → Telegram) and no custom domain is recorded, so the platform does not know its own external address. The URL below is the origin of this browser session — check it is the one reachable from the internet before mapping it.');
  }
  if (srf.level === 'users' && !hasEntryPage) {
    warn('no-entry-page', `public/${surfaces.ENTRY}.html does not exist — app users have no cookieless entry page, so the app root stays owner-gated until it does.`);
  }
  if (srf.public.landing && !fs.existsSync(path.join(dir, 'public', srf.public.landing))) {
    warn('landing-missing', `The declared landing page public/${srf.public.landing} does not exist — anonymous visitors at the root get a 404.`);
  }
  if (domain && srf.level === 'private') {
    warn('domain-private', `${domain} is recorded but the app is private — visitors through that domain carry no Vistaclair login and are blocked.`);
  }
  if (domain && publicUrl) {
    let host = '';
    try { host = new URL(publicUrl).host; } catch {}
    if (host && host !== domain) {
      note('two-origins', `Two origins serve this app: ${domain} (your proxy) and ${host}/apps/${name}/ (the platform). Telegram's mini-app button always opens the platform one, and sessions do not carry across origins.`);
    }
  }
  for (const g of guardExempt) {
    if (!g.declared) continue;
    if (!g.cookieless) {
      warn('api-not-cookieless', `${g.prefix} is exempt from the app's login guard but nothing exempts it from the Vistaclair owner login at this access level — anonymous callers are still redirected to /login. Move the route under /api/app/ or declare a public page surface.`);
    }
    if (`/api/${surfaces.ENTRY}`.startsWith(g.prefix)) {
      warn('api-guard-off', `${g.prefix} switches the platform's default-deny guard OFF for the whole /api/${surfaces.ENTRY}/ surface — every route under it is anonymous unless routes.js checks the caller itself.`);
    }
  }

  const dashboardPort = require('./core-services').core.dashboardPort || null;
  return {
    app: name,
    level: srf.level,
    channels: surfaces.loginMethods(manifest),
    base,
    baseSource,
    domain,
    publicUrl: publicUrl || null,
    dashboardPort,
    // What the Website domain field shows under itself: where `https://<domain>/`
    // lands and the proxy block for THIS host (the owner runs nginx).
    websiteUrl: domain ? `https://${domain}/${surfaces.rootRedirectTarget(manifest) || ''}` : null,
    nginx: nginxSnippet(name, domain, dashboardPort),
    entryUrl,
    miniAppUrl,
    botUsername: bot ? (bot.botUsername || null) : null,
    paths: surfaces.describePatterns(name, manifest),
    guardExempt,
    landing: srf.public.landing,
    pages: srf.public.pages.filter((g) => g !== '**'),
    hasEntryPage,
    warnings,
  };
}

// A website domain as the owner types it → the bare lowercase hostname stored
// in manifest.domain, or null for empty. A pasted `https://host/` is forgiven;
// a path, port or anything that is not a DNS name is refused.
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
function normalizeDomain(input) {
  if (input == null) return null;
  const d = String(input).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!d) return null;
  if (!HOSTNAME_RE.test(d)) throw new Error(`"${String(input).trim()}" is not a hostname (e.g. app.example.com — no scheme, port or path)`);
  return d;
}

// The minimal reverse-proxy block for a website domain on THIS host: `/` onto
// the app subtree, the forwarded host/scheme, and no buffering so SSE and
// streamed responses arrive as they are written. TLS lines are the owner's.
function nginxSnippet(name, domain, port) {
  return [
    'server {',
    `    server_name ${domain || '<your-domain>'};`,
    '    # listen 443 ssl; + certificate lines (e.g. certbot --nginx)',
    '    location / {',
    `        proxy_pass http://127.0.0.1:${port || '<vistaclair-port>'}/apps/${name}/;`,
    '        proxy_http_version 1.1;',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Forwarded-Host $host;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '        proxy_buffering off;',
    '        proxy_read_timeout 1h;',
    '    }',
    '}',
  ].join('\n');
}

// The Website domain field's Check: resolve the domain, GET `/` over HTTPS and
// follow one redirect, then say whether it lands where this app's root lands.
// The signature of "points here" is the platform's own relative root 302
// (surfaces.rootRedirectTarget) followed by a 200; an open app has no redirect,
// so its 200 is reported as reachable, not as proven. Never throws for network
// trouble — every outcome is a { status, ok, text } the modal prints.
const CHECK_TIMEOUT_MS = 8000;
async function checkDomain(name, domainArg) {
  validateAppName(name);
  const surfaces = require('./surfaces');
  const manifest = readManifest(name);
  if (!manifest) throw new Error(`App "${name}" not found`);
  const domain = domainArg != null && String(domainArg).trim()
    ? normalizeDomain(domainArg)
    : (typeof manifest.domain === 'string' && manifest.domain ? manifest.domain : null);
  const out = (status, ok, text, extra = {}) => ({ app: name, domain, status, ok, text, ...extra });
  if (!domain) return out('no-domain', false, 'No website domain is set.');

  let addresses = [];
  try { addresses = (await require('dns').promises.lookup(domain, { all: true })).map((a) => a.address); }
  catch (err) { return out('dns', false, `${domain} does not resolve (${err.code || err.message}) — add a DNS record pointing at this host.`); }

  const get = async (url) => {
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
      const location = res.headers.get('location');
      try { await res.arrayBuffer(); } catch {}
      return { url, status: res.status, location: location ? new URL(location, url).href : null };
    } catch (err) {
      return { url, error: (err.cause && (err.cause.code || err.cause.message)) || err.message };
    }
  };
  const isRedirect = (r) => r.status >= 300 && r.status < 400 && r.location;
  const root = `https://${domain}/`;
  const target = surfaces.rootRedirectTarget(manifest);
  const hops = [];

  const first = await get(root);
  hops.push(first);
  const extra = () => ({ addresses, hops });
  if (first.error) return out('unreachable', false, `${root} did not answer over HTTPS (${first.error}) — check the nginx server block and its certificate.`, extra());
  if (!isRedirect(first)) {
    if (first.status >= 400) return out('not-here', false, `${root} answered ${first.status} — the proxy is not reaching this app (is proxy_pass pointing at /apps/${name}/ on this host?).`, extra());
    if (target) return out('not-here', false, `${root} answered ${first.status} without the platform's redirect to ${target} — it is not mapped onto /apps/${name}/ of this host.`, extra());
    return out('reachable', true, `${root} answered ${first.status}. The app is open, so there is no redirect to prove it is this host's copy.`, extra());
  }
  if (new URL(first.location).host !== domain) {
    return out('not-here', false, `${root} redirects off the domain, to ${first.location} — the proxy is not mapping / onto /apps/${name}/.`, extra());
  }
  const second = await get(first.location);
  hops.push(second);
  if (second.error) return out('unreachable', false, `${first.location} did not answer (${second.error}).`, extra());
  if (isRedirect(second)) {
    const loop = [root, first.location].includes(second.location) || /\/login\/?$/.test(new URL(second.location).pathname);
    return out(loop ? 'loop' : 'not-here', false, loop
      ? `Redirect loop: ${root} → ${first.location} → ${second.location}.`
      : `${root} → ${first.location} → ${second.location}: more redirects than this app's root makes.`, extra());
  }
  if (second.status >= 400) return out('not-here', false, `${first.location} answered ${second.status}.`, extra());
  if (target && new URL(first.location).pathname !== `/${target}`) {
    return out('not-here', false, `${root} redirects to ${first.location}, not to /${target} — it is not mapped onto /apps/${name}/ of this host.`, extra());
  }
  return out('ok', true, `${root} → ${first.location} (${second.status}). The domain lands on this app.`, extra());
}

async function rename(oldName, newName) {
  validateAppName(oldName);
  validateAppName(newName);
  if (oldName === newName) return { ok: true, oldName, newName };

  const oldDir = path.join(appsDir(), oldName);
  const newDir = path.join(appsDir(), newName);
  if (!fs.existsSync(oldDir)) return { error: 'App not found' };
  if (fs.existsSync(newDir)) return { error: `App "${newName}" already exists` };

  if (_bridgeCleanupFn) _bridgeCleanupFn(oldName);
  await stopApp(oldName);

  fs.renameSync(oldDir, newDir);

  try {
    replaceInTextFiles(newDir, oldName, newName);
    appDb.renameAppDb(oldName, newName);
    platformCron.renameApp(oldName, newName);
  } catch (err) {
    try { fs.renameSync(newDir, oldDir); } catch {}
    return { error: `Rename failed: ${err.message}` };
  }

  // Post-rename migrations. Best-effort by design: past this point the app IS
  // renamed, and a failure here (e.g. DB offline, Telegram unreachable) must
  // not roll the directory back — it is reported as a warning instead.
  const warnings = [];

  try {
    const tg = await telegram.renameApp(oldName, newName);
    if (tg.webhook && !tg.webhook.ok) {
      warnings.push(`Telegram webhook could not be re-registered under the new name: ${tg.webhook.error || 'unknown error'}. Re-save the public URL (or re-link the bot) to restore inbound messages.`);
    }
  } catch (err) {
    warnings.push(`Telegram bot config was not migrated: ${err.message}`);
  }

  try {
    whatsapp.renameApp(oldName, newName);
  } catch (err) {
    warnings.push(`WhatsApp account config was not migrated: ${err.message}`);
  }

  // App-scoped rows in the platform databases (memory, email/calendar
  // annotations, artifacts) are keyed by app name and must follow the rename,
  // or private-scope reads under the new name come back empty.
  if (!appDb.getPool()) {
    warnings.push('Database is offline — memory records and email/calendar annotations still carry the old app name. They will NOT migrate automatically later.');
  } else {
    const migrations = [
      ['memory records', require('./memory-service')],
      ['email annotations', require('./email-engine')],
      ['calendar annotations', require('./calendar-engine')],
      ['artifact records', require('./agent/horst-artifacts')],
    ];
    for (const [label, svc] of migrations) {
      if (!svc.isReady()) continue; // schema never initialized → nothing to migrate
      try { await svc.renameApp(oldName, newName); } catch (err) {
        warnings.push(`Could not migrate ${label}: ${appDb.friendlyDbError(err)}`);
      }
    }
  }

  return { ok: true, oldName, newName, warnings };
}

// Dependency/artifact directories no listing should ever descend into, regardless
// of what the app's .gitignore says. Dot-directories are skipped wholesale below
// (.git, .venv, .cache, .vistaclair, ... — the old hardcoded list only named four
// and a single unlisted one, like vr-moritz's 4,000-file .venv, dominated every
// change-session prompt via {{FILE_LIST}} and every snapshot copy).
const ALWAYS_SKIP_DIRS = new Set(['node_modules', '__pycache__', 'venv']);
// A directory holding a CACHEDIR.TAG (the cache-directory standard; cargo writes
// one into every target/) is build output, skipped too — a crate's own
// .gitignore, which says so, is never read here.
const CACHEDIR_TAG = 'CACHEDIR.TAG';
// cli.workspace folders (`<appDir>/workspaces/<name>`): model-written files and
// gigabyte sources, never listed, snapshotted or put into a prompt's file list.
const TOP_SKIP_DIRS = new Set(['workspaces']);

// Parse an app's .gitignore into a predicate over (relPath, isDir). Deliberately a
// subset of gitignore semantics — comments, dir-only `foo/`, root-anchored `/foo` or
// `a/b`, and `*`/`?` globs. Negation (`!`) and `**` are ignored: this only ever
// *adds* exclusions on top of the hardcoded skips, so an unsupported pattern means
// a file is listed, never that one is lost.
function gitignoreMatcher(dir) {
  let lines = [];
  try {
    lines = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8').split('\n');
  } catch {
    return () => false;
  }
  const rules = [];
  for (let raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!') || line.includes('**')) continue;
    const dirOnly = line.endsWith('/');
    let pat = dirOnly ? line.replace(/\/+$/, '') : line;
    const anchored = pat.startsWith('/') || pat.includes('/');
    pat = pat.replace(/^\/+/, '');
    if (!pat) continue;
    const rx = pat
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]');
    // Anchored patterns match from the app root; bare names match any path segment.
    const re = anchored ? new RegExp(`^${rx}(/|$)`) : new RegExp(`(^|/)${rx}(/|$)`);
    rules.push({ re, dirOnly });
  }
  if (!rules.length) return () => false;
  return (relPath, isDir) => rules.some((r) => (!r.dirOnly || isDir) && r.re.test(relPath + (isDir ? '/' : '')));
}

function listAppFiles(name) {
  const dir = appDir(name);
  if (!fs.existsSync(dir)) return [];
  const ignored = gitignoreMatcher(dir);
  const files = [];
  function walk(base, rel) {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const isDir = entry.isDirectory();
      if (isDir && (ALWAYS_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.') || (!rel && TOP_SKIP_DIRS.has(entry.name)))) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (ignored(relPath, isDir)) continue;
      if (isDir) {
        if (fs.existsSync(path.join(base, entry.name, CACHEDIR_TAG))) continue;
        walk(path.join(base, entry.name), relPath);
      } else {
        files.push(relPath);
      }
    }
  }
  walk(dir, '');
  return files;
}

function readAppFile(name, relPath) {
  const dir = appDir(name);
  const filePath = safePath(dir, relPath);
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function writeAppFile(name, relPath, content) {
  const dir = appDir(name);
  const filePath = safePath(dir, relPath);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf-8');
}

// --- App server lifecycle ---

function probePort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(() => resolve(true)); });
    srv.listen(port);
  });
}

async function allocatePort() {
  for (let i = 0; i < 20; i++) {
    const port = nextPort++;
    if (nextPort > 5000) nextPort = 4000;
    if (await probePort(port)) return port;
  }
  throw new Error('No available port in range 4000-5000');
}

// --- Route-mounted apps (preferred) ---

async function installDepsIfNeeded(dir, broadcaster, name) {
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath) && !fs.existsSync(path.join(dir, 'node_modules'))) {
    try {
      await execAsync('npm install', { cwd: dir, timeout: 120000 });
    } catch (err) {
      broadcaster?.broadcast({ type: 'app:error', appName: name, error: `npm install failed: ${err.message}` });
      throw err;
    }
  }
}


function wrapHandler(fn) {
  return (req, res, next) => {
    try {
      // Re-enter the request's spend context: body parsing may have dropped
      // the async store set by the router's first middleware.
      const result = require('./spend-context').bind(req, () => fn(req, res, next));
      if (result && typeof result.catch === 'function') {
        result.catch(next);
      }
    } catch (err) {
      next(err);
    }
  };
}


// --- Platform contribution (Architecture D opt-out) -------------------------
// manifest.platformContribution: false marks an app INDEPENDENT — Horst never
// sees it (no tool union, no events, no APP.md in the digest, no governance),
// and its exposed tools are invisible to platform sessions and other apps.
// Absent/true = contributes (the default; the platform's whole flywheel).
function contributes(name) {
  try { return readManifest(name)?.platformContribution !== false; } catch { return true; }
}

// Async guard for ctx surfaces that return promises (keeps the error in the
// promise chain instead of throwing synchronously into app code).
function requireContribution(name, surface) {
  return contributes(name)
    ? Promise.resolve()
    : Promise.reject(new Error(`app "${name}" is marked independent (platformContribution: false) — enable platform contribution to use ${surface}`));
}


async function mountRoutes(name, broadcaster, { mode = 'dashboard' } = {}) {
  const dir = appDir(name);
  await installDepsIfNeeded(dir, broadcaster, name);

  const appRouter = express.Router();
  // Spend attribution: every handler below runs in a route context (principal
  // resolved lazily from the request on first metered call).
  appRouter.use(require('./spend-context').middleware(name));
  appRouter.use(express.json({ limit: '10mb' }));

  // routes.js is optional: a frontend-only app (public/ + bridge) mounts with a
  // no-op setup so its assets are served by the static fallback below.
  // Purge any cached copy of the app's modules first: a FAILED mount never
  // reaches stopMountedApp's cache clearing, so without this an app whose
  // setup threw once would keep require()ing the stale broken module even
  // after the owner fixed the file.
  const cachePrefix = dir + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(cachePrefix)) delete require.cache[key];
  }
  const routesPath = path.join(dir, 'routes.js');
  const setup = fs.existsSync(routesPath) ? require(routesPath) : (() => {});
  if (appDb.getPool()) {
    if (!appDb.getAppDb(name)) {
      try { await appDb.provisionApp(name); } catch (err) {
        const friendly = appDb.friendlyDbError ? appDb.friendlyDbError(err) : err.message;
        console.warn(`[app:${name}] DB provision failed: ${friendly}`);
      }
    }
  }

  // The ctx is assembled by the capability registry from the capability modules
  // (src/apps/capabilities/<key>.js). 'host' = everything, ungated — the turnkey
  // auth module needs email.send for verification mails regardless of what the
  // app itself declared. routes.js gets the profile-specific, manifest-gated ctx below.
  const capabilities = require('./capabilities');
  const manifest = readManifest(name) || {};
  const appInfo = { name, dir, manifest, broadcaster };
  const ctx = capabilities.buildCtx(appInfo, { profile: 'host' });

  const safeRouter = new Proxy(appRouter, {
    get(target, prop) {
      if (['get', 'post', 'put', 'delete', 'patch', 'all', 'use'].includes(prop)) {
        return (...args) => {
          const wrapped = args.map(a => typeof a === 'function' && a.length < 4 ? wrapHandler(a) : a);
          return target[prop](...wrapped);
        };
      }
      return target[prop];
    }
  });

  // Security boundary (docs/apps.md "Access levels"): the perimeter
  // is the owner cookie plus, for a users-level app, app-auth's default-deny
  // guard on /api/*. routes.js always receives the FULL platform ctx for its
  // runtime — the only structural stripping is the admin's grants: a capability
  // the admin revoked for this app (spend policy, `revocable` modules only) is
  // physically absent from the object, so a coding mistake can't reach it. An
  // open app gets the owner-service revocations seeded on the flip.
  // The turnkey auth module is mounted first with the host ctx (never
  // revoked) because it legitimately needs email.send for verification.
  if (manifest.auth && (manifest.auth.email || manifest.auth.telegram || manifest.auth.whatsapp || manifest.auth.license)) {
    try { await require('./app-auth').mount(appRouter, ctx, manifest); }
    catch (err) {
      // Fail CLOSED: the manifest alone makes /api/app/* cookieless, so a guard
      // that could not mount must not leave those routes reachable.
      console.warn(`[app:${name}] auth module mount failed: ${err.message} — every /api/* route answers 401 until the app restarts cleanly`);
      appRouter.use('/api', (req, res) => res.status(401).json({ error: 'auth_unavailable', detail: err.message }));
    }
  }
  const surfaces = require('./surfaces');
  const declaredEntry = manifest.surfaces && manifest.surfaces.user && manifest.surfaces.user.entry;
  if (declaredEntry && declaredEntry !== surfaces.ENTRY) {
    console.warn(`[app:${name}] surfaces.user.entry "${declaredEntry}" is ignored — the entry surface is always "${surfaces.ENTRY}" and is derived from the auth block`);
  }
  const profile = mode === 'standalone' ? 'standalone' : 'dashboard';
  const revoked = require('./spend-policy').revokedCapabilities(name, require('./deployment-mode').mode());
  const appCtx = capabilities.buildCtx(appInfo, { profile, revoked });
  // app-auth.mount added ctx.auth to the host ctx; the app's ctx carries the same object.
  if (Object.prototype.hasOwnProperty.call(ctx, 'auth')) appCtx.auth = ctx.auth;
  // Every failure of this app's code is attributed through the guard (setup,
  // route errors here; callbacks outside requests at their invocation sites).
  const guard = require('./app-guard');
  guard.resetWindow(name);
  const cleanup = guard.attempt(name, 'routes.setup', () => setup(safeRouter, appCtx));

  appRouter.use(express.static(path.join(dir, 'public')));

  appRouter.use((err, req, res, next) => {
    guard.record(name, 'route', err, { path: req.path });
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

  const entry = { router: appRouter, cleanup: typeof cleanup === 'function' ? cleanup : null, status: 'mounted', runtime: 'in-process', type: 'mounted', name };
  liveApps.set(name, entry);
  return entry;
}

async function stopMountedApp(name, { restart = false } = {}) {
  const entry = liveApps.get(name);
  if (entry?.runtime !== 'in-process') return;
  liveApps.delete(name);
  require('./app-guard').resetWindow(name);
  telegram.clearUpdateHandlers(name);
  try { require('./whatsapp').clearUpdateHandlers(name); } catch {}
  try { require('./email-engine').clearHandlers(name); } catch {}
  try { require('./governance/horst-governance').unregisterKinds(name); } catch {}
  try { require('./fleet-data-receive').unregisterApp(name); } catch {}
  try { require('./fleet-remote-host').unregisterApp(name); } catch {}
  try { require('./fleet-remote').unregisterApp(name); } catch {}
  try { require('./app-jobs').cleanupApp(name, { reason: restart ? 'restart' : 'unmount' }); } catch {}
  try { require('./app-sse').cleanupApp(name); } catch {}
  try { require('./platform-sysmon').removeApp(name); } catch {}
  try { require('./agent/horst-events').removeApp(name); } catch {}
  if (entry.cleanup) {
    try { await entry.cleanup(); } catch (err) { console.error(`[app:${name}] Cleanup error:`, err.message); }
  }
  const prefix = appDir(name) + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(prefix)) delete require.cache[key];
  }
}

function getMountedRouter(name) {
  const entry = liveApps.get(name);
  return entry?.runtime === 'in-process' ? entry.router : null;
}

// --- Own-process apps (manifest runtime: "own-process") ---
//
// The app's routes.js is hosted by an app-runner child this dashboard spawns
// and supervises (`node app-runner.js --app <name> --port <n>` with
// VISTACLAIR_MANAGED=1), reverse-proxied at /apps/<name> (the /apps proxy
// keys off the entry's port).
//
// What this DOES protect (honestly):
//   - No in-dashboard-process code execution: routes.js is never require()d
//     here, so a throw during setup, a blocked event loop, or a crash is
//     contained to the child. The dashboard just marks the app crashed.
//   - The child cannot read the DASHBOARD's process memory/globals, and its
//     environment below is deliberately narrowed (no dashboard env leakage).
//   - routes.js receives the RESTRICTED standalone ctx (no googleAuth /
//     emailAccounts / calendar / cross-app tools / governance / horst).
//
// What it does NOT protect: the child boots core's headless addon host, and
// app-runner dotenv-loads core's .env itself — so the child process still
// holds platform credentials (AUTH_TOKEN, provider keys) in ITS process.env,
// the same trust shape as a standalone runner. The win is crash/blocking
// isolation and keeping untrusted code out of the dashboard process — it is
// NOT a secrets sandbox. Narrowing what the runner loads is future work.
//
// Poller/jobs single-owner invariant: the child polls ONLY this app's
// Telegram bot and sweeps ONLY this app's jobs (app-runner scopes both to
// appName), while the dashboard's telegram/app-jobs appFilter excludes
// own-process apps — so exactly one process ever owns them, the same
// contract standalone apps rely on.
async function spawnOwnProcess(name, broadcaster) {
  const dir = appDir(name);
  await installDepsIfNeeded(dir, broadcaster, name);

  // Provision the app's DB + per-app credentials from THIS process (same as
  // mountRoutes does inline): the child only READS .db-config.json's apps map
  // (appDb.initAppUser), it never provisions for itself.
  if (appDb.getPool() && !appDb.getAppDb(name)) {
    try { await appDb.provisionApp(name); } catch (err) {
      const friendly = appDb.friendlyDbError ? appDb.friendlyDbError(err) : err.message;
      console.warn(`[app:${name}] DB provision failed: ${friendly}`);
    }
  }

  const port = await allocatePort();
  const proDir = path.dirname(path.dirname(__dirname));
  const runnerPath = path.join(proDir, 'app-runner.js');
  const coreDir = CORE_DIR || path.resolve(process.env.VISTACLAIR_CORE_DIR || path.join(proDir, '..'));

  // If this app's bot was until now polled by the dashboard (manifest flag
  // flipped at runtime), release it before the child claims getUpdates —
  // the appFilter set in src/apps/index.js re-reads the manifest on sync.
  try { telegram.syncPolling(); } catch {}

  const logPath = path.join(dir, 'server.log');
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n--- ${new Date().toISOString()} --- Starting own-process runner on port ${port} ---\n`);

  // Deliberately NARROW child env: the dashboard's env (AUTH_TOKEN, provider
  // keys, ...) is not inherited. app-runner re-reads core's .env itself, so
  // this is hygiene against incidental dashboard-process env leakage — not a
  // security boundary (see the trust note above).
  const passThrough = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'NODE_ENV',
    'VISTACLAIR_HOME', 'DASHBOARD_PORT', 'PROXY_PORT'];
  const spawnEnv = {};
  for (const key of passThrough) {
    if (process.env[key] !== undefined) spawnEnv[key] = process.env[key];
  }
  spawnEnv.VISTACLAIR_MANAGED = '1';
  spawnEnv.VISTACLAIR_CORE_DIR = coreDir;
  spawnEnv.VISTACLAIR_APPS_DIR = appsDir();
  spawnEnv.HOST = '127.0.0.1';
  const cronSecret = require('crypto').randomBytes(32).toString('hex');
  cronSecrets.set(name, cronSecret);
  spawnEnv.VISTACLAIR_CRON_SECRET = cronSecret;

  const proc = spawn('node', [runnerPath, '--app', name, '--port', String(port)], {
    cwd: proDir,
    env: spawnEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  processCrashes.delete(name);
  let stderrBuffer = '';
  const entry = { name, proc, port, status: 'starting', runtime: 'own-process', type: 'process', pid: proc.pid, logStream };
  liveApps.set(name, entry);

  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    logStream.write(text);
    if (entry.status === 'starting' && text.includes('listening')) {
      entry.status = 'running';
      broadcaster?.broadcast({ type: 'app:started', appName: name, port, appType: 'process', runtime: 'own-process' });
      broadcaster?.broadcast({ type: 'app:list', apps: list() });
    }
    broadcaster?.broadcast({ type: 'app:server:output', appName: name, data: text });
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    logStream.write(text);
    if (entry.status === 'starting') stderrBuffer += text;
    broadcaster?.broadcast({ type: 'app:server:output', appName: name, data: text });
  });

  proc.on('exit', (code) => {
    logStream.write(`--- Exited with code ${code} ---\n`);
    logStream.end();
    if (entry.status === 'starting') {
      entry.status = 'failed';
      liveApps.delete(name);
      processCrashes.set(name, { code, at: Date.now(), phase: 'start' });
      require('./app-guard').record(name, 'process', new Error(stderrBuffer || `Process exited with code ${code}`), { code, phase: 'start' });
      broadcaster?.broadcast({ type: 'app:startFailed', appName: name, error: stderrBuffer || `Process exited with code ${code}` });
    } else {
      const crashed = !entry.stopping && code !== 0;
      entry.status = 'stopped';
      liveApps.delete(name);
      // A death the dashboard didn't order stays queryable server-side
      // (GUI-reload resilience: a reload must find this state via app:status
      // / app:list, not lose it with the old page).
      if (crashed) {
        processCrashes.set(name, { code, at: Date.now(), phase: 'run' });
        require('./app-guard').record(name, 'process', new Error(`Process exited with code ${code}`), { code, phase: 'run' });
      }
      broadcaster?.broadcast({ type: 'app:stopped', appName: name, code, ...(crashed ? { crashed: true } : {}) });
      broadcaster?.broadcast({ type: 'app:list', apps: list() });
    }
    entry.exitCode = code;
  });

  // Fallback: if nothing recognizable was printed but the process is alive
  // after 3s, consider it running.
  setTimeout(() => {
    if (entry.status === 'starting' && proc.exitCode === null) {
      entry.status = 'running';
      broadcaster?.broadcast({ type: 'app:started', appName: name, port, appType: 'process', runtime: 'own-process' });
      broadcaster?.broadcast({ type: 'app:list', apps: list() });
    }
  }, 3000);

  return entry;
}

// Own-process apps that exited without a stopApp(): name -> { code, at, phase }.
// Feeds getAppStatus health 'crashed' and the _crashed flag in list(). Cleared
// on the next start or on a deliberate stop. Never populated for in-process apps.
const processCrashes = new Map();

// --- Unified start/stop ---

// manifest.events.emits → the bus catalog. The one dashboard-only path both
// runtimes pass through, so an own-process app's kinds are declared without
// its routes.js ever calling ctx.events.declare. Best-effort: the bus may not
// be up (tests, runner) and a bad block must not stop the app.
function declareManifestEvents(name) {
  try {
    const emits = readManifest(name)?.events?.emits;
    if (!emits || typeof emits !== 'object') return;
    const kinds = Object.entries(emits).map(([kind, v]) => ({ kind, description: (v && typeof v === 'object' ? v.description : v) || '' }));
    if (!kinds.length) return;
    require('./agent/horst-events').declare(name, kinds, { horst: contributes(name), via: 'manifest' });
  } catch (err) {
    console.warn(`[app:${name}] manifest events.emits not declared: ${err.message}`);
  }
}


async function startApp(name, broadcaster) {
  if (readManifest(name)?.standalone === true) {
    throw new Error(`App "${name}" is standalone — it runs in its own app-runner process, not in the dashboard.`);
  }
  // On a slave the master's allowlist only governs apps the master published
  // here. Apps the slave owner created locally are not the master's to enable
  // or disable — they start like on any host. Lazy require avoids a cycle at
  // load time.
  const hostConfig = require('./host-config');
  if (hostConfig.isSlave() && !hostConfig.isEnabled(name) && isMasterDeployed(name)) {
    throw new Error(`App "${name}" was published from the master but is disabled on this slave — re-enable it by publishing from the master.`);
  }
  if (liveApps.has(name)) {
    return liveApps.get(name);
  }
  if (startingApps.has(name)) {
    throw new Error(`App "${name}" is already starting`);
  }
  require('./app-guard').resetWindow(name);
  startingApps.add(name);
  declareManifestEvents(name);
  try {
    // runtime: "own-process": never require() this app's routes.js in-process.
    if (isOwnProcess(name)) return await spawnOwnProcess(name, broadcaster);
    return await mountRoutes(name, broadcaster);
  } catch (err) {
    // Every caller's start failure (dashboard, autostart, cron, tools) is
    // logged and raises the header alert; an own-process child that dies while
    // starting is recorded by its exit handler instead.
    require('./app-guard').record(name, 'start', err, { phase: 'start' });
    throw err;
  } finally {
    startingApps.delete(name);
  }
}

async function stopApp(name, { restart = false } = {}) {
  const entry = liveApps.get(name);
  if (!entry) return;
  if (entry.runtime === 'in-process') {
    await stopMountedApp(name, { restart });
    return;
  }
  if (!entry.proc) return;
  // Deliberate stop: the own-process exit handler must not record a crash,
  // and any prior crash record is cleared.
  entry.stopping = true;
  processCrashes.delete(name);
  if (entry.logStream) entry.logStream.end();
  killWithTimeout(entry.proc);
  liveApps.delete(name);
  try { require('./platform-sysmon').removeApp(name); } catch {}
  try { require('./agent/horst-events').removeApp(name); } catch {}
}

function readLog(name) {
  const logPath = path.join(appDir(name), 'server.log');
  try { return fs.readFileSync(logPath, 'utf-8'); } catch { return null; }
}

// Own-process entries only (they carry a port/pid); in-process apps are
// reached via getMountedRouter.
function getRunningApp(name) {
  const entry = liveApps.get(name);
  return entry?.runtime === 'own-process' ? entry : null;
}

// --- Snapshot history ---

function snapshot(name) {
  const dir = appDir(name);
  const histDir = path.join(dir, '.history', String(Date.now()));
  ensureDir(histDir);
  const files = listAppFiles(name);
  for (const file of files) {
    const src = path.join(dir, file);
    const dst = path.join(histDir, file);
    ensureDir(path.dirname(dst));
    try { fs.copyFileSync(src, dst); } catch {}
  }
  return histDir;
}

function listSnapshots(name) {
  const histDir = path.join(appDir(name), '.history');
  if (!fs.existsSync(histDir)) return [];
  return fs.readdirSync(histDir)
    .filter(d => /^\d+$/.test(d))
    .sort((a, b) => Number(b) - Number(a))
    .map(d => ({ timestamp: Number(d), date: new Date(Number(d)).toISOString() }));
}

// --- DB re-provisioning for already-mounted apps ---

async function provisionMounted() {
  if (!appDb.getPool()) return;
  for (const [name, entry] of liveApps) {
    if (entry.runtime !== 'in-process') continue;
    if (!appDb.getAppDb(name)) {
      try {
        await appDb.provisionApp(name);
        console.log(`[app:${name}] DB provisioned (late)`);
      } catch (err) {
        const friendly = appDb.friendlyDbError ? appDb.friendlyDbError(err) : err.message;
        console.warn(`[app:${name}] Late DB provision failed: ${friendly}`);
      }
    }
  }
}

// --- App status ---

function getAppStatus(name) {
  const entry = liveApps.get(name);
  const isRunning = entry?.status === 'running' || entry?.status === 'mounted';
  const appDbInfo = appDb.getAppDb(name);
  const dir = appDir(name);
  const needsDb = fs.existsSync(path.join(dir, 'routes.js'));

  let db;
  if (!needsDb) {
    db = 'na';
  } else if (!appDb.getPool()) {
    db = 'disconnected';
  } else if (appDbInfo) {
    db = 'ok';
  } else {
    db = 'pending';
  }

  return {
    health: entry?.status === 'starting' ? 'starting' : isRunning ? 'ok' : entry?.status === 'failed' ? 'error' : processCrashes.has(name) ? 'crashed' : 'stopped',
    // Attributed runtime failures (app-guard): count, last error, recent ring,
    // crash-loop flag — the platform's own view of "running but broken".
    errors: require('./app-guard').status(name),
    db,
    dbName: appDbInfo?.database || null,
    hasDeps: fs.existsSync(path.join(dir, 'package.json')),
    depsInstalled: fs.existsSync(path.join(dir, 'node_modules')),
  };
}

// A restart is not a teardown. The app's code goes away and comes back, so
// platform work in flight — a publish mid-upload, a rollback — has to live
// across it.
async function restartApp(name, broadcaster) {
  await stopApp(name, { restart: true });
  return startApp(name, broadcaster);
}

// --- Git (single repo, per-app scoping) ---

async function getGitStatus(name) {
  try {
    await execAsync('git rev-parse --git-dir', { cwd: APPS_DIR, timeout: 3000 });
  } catch { return null; }

  const [statusOut, branchOut, aheadBehind] = await Promise.all([
    execAsync(`git status --porcelain -- ${name}/`, { cwd: APPS_DIR, timeout: 5000 }).then(r => r.stdout).catch(() => ''),
    execAsync('git branch --show-current', { cwd: APPS_DIR, timeout: 3000 }).then(r => r.stdout.trim()).catch(() => 'unknown'),
    execAsync('git rev-list --left-right --count @{upstream}...HEAD', { cwd: APPS_DIR, timeout: 3000 }).then(r => {
      const [behind, ahead] = r.stdout.trim().split(/\s+/).map(Number);
      return { ahead, behind };
    }).catch(() => ({ ahead: 0, behind: 0 })),
  ]);

  const lines = statusOut.split('\n').filter(Boolean);
  const modified = lines.filter(l => /^.M|^M/.test(l)).length;
  const untracked = lines.filter(l => l.startsWith('??')).length;
  const staged = lines.filter(l => /^[MADRC]/.test(l)).length;

  return { branch: branchOut, modified, untracked, staged, ...aheadBehind, dirty: lines.length > 0 };
}

// Batch directory sizes (bytes) for all named apps in a single `du` call.
async function getAllDirSizes(names) {
  const sizes = {};
  const valid = (names || []).filter(n => { try { validateAppName(n); return true; } catch { return false; } });
  if (valid.length === 0) return sizes;
  try {
    const args = valid.map(n => JSON.stringify(n)).join(' ');
    const { stdout } = await execAsync(`du -sb ${args}`, { cwd: APPS_DIR, timeout: 15000 });
    for (const line of stdout.split('\n')) {
      const m = line.match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const bytes = Number(m[1]);
      const dir = m[2].replace(/\/+$/, '');
      if (valid.includes(dir)) sizes[dir] = bytes;
    }
  } catch {}
  return sizes;
}

// Batch git status for every app, scoped from one repo-wide porcelain read.
async function getAllGitStatus() {
  try {
    await execAsync('git rev-parse --git-dir', { cwd: APPS_DIR, timeout: 3000 });
  } catch { return {}; }

  const [statusOut, branch, aheadBehind] = await Promise.all([
    execAsync('git status --porcelain', { cwd: APPS_DIR, timeout: 8000 }).then(r => r.stdout).catch(() => ''),
    execAsync('git branch --show-current', { cwd: APPS_DIR, timeout: 3000 }).then(r => r.stdout.trim()).catch(() => 'unknown'),
    execAsync('git rev-list --left-right --count @{upstream}...HEAD', { cwd: APPS_DIR, timeout: 3000 }).then(r => {
      const [behind, ahead] = r.stdout.trim().split(/\s+/).map(Number);
      return { ahead: ahead || 0, behind: behind || 0 };
    }).catch(() => ({ ahead: 0, behind: 0 })),
  ]);

  const byApp = {};
  for (const line of statusOut.split('\n').filter(Boolean)) {
    const x = line[0], y = line[1];
    let pathPart = line.slice(3);
    // Renames show "old -> new"; attribute to the destination path.
    const arrow = pathPart.indexOf(' -> ');
    if (arrow !== -1) pathPart = pathPart.slice(arrow + 4);
    pathPart = pathPart.replace(/^"|"$/g, '');
    const app = pathPart.split('/')[0];
    if (!app) continue;
    const g = byApp[app] || (byApp[app] = { branch, modified: 0, untracked: 0, staged: 0, ahead: aheadBehind.ahead, behind: aheadBehind.behind, dirty: false });
    g.dirty = true;
    if (x === '?' && y === '?') g.untracked++;
    else {
      if (y === 'M' || y === 'D') g.modified++;
      if (x !== ' ' && x !== '?') g.staged++;
    }
  }
  return byApp;
}

async function gitCommit(name, message) {
  await execAsync(`git add -- ${name}/`, { cwd: APPS_DIR, timeout: 10000 });
  const result = await execAsync(`git commit -m ${JSON.stringify(message)}`, { cwd: APPS_DIR, timeout: 10000 });
  return result.stdout;
}

async function gitPush() {
  const result = await execAsync('git push', { cwd: APPS_DIR, timeout: 30000 });
  return (result.stdout || '') + (result.stderr || '');
}

async function cleanupAll() {
  const promises = [];
  for (const [name] of liveApps) {
    promises.push(stopApp(name));
  }
  await Promise.allSettled(promises);
}

module.exports = {
  get APPS_DIR() { return APPS_DIR; },
  setAppsDir, setCoreDir, setBridgeCleanup, setOwnerCheck,
  list, readManifest, updateManifest, updateHostConfig, hostConfigKeys, readAppMd, create, remove, rename, renamePreflight, appAccess, accessInfo, normalizeDomain, nginxSnippet, checkDomain,
  listAppFiles, readAppFile, writeAppFile,
  startApp, stopApp, restartApp, getRunningApp, getMountedRouter, readLog,
  contributes,
  getAppStatus, getGitStatus, getAllGitStatus, getAllDirSizes, gitCommit, gitPush, provisionMounted, isMasterDeployed,
  snapshot, listSnapshots,
  cleanupAll,
  requireContribution, getOwnerCheck, getCronSecret, wrapHandler, appDir, appRuntime, isOwnProcess, isValidAppName, runsInDashboardProcess, mountRoutes,
};
