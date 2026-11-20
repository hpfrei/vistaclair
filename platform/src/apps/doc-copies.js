// Keeps the platform-doc copies in every app's `.vistaclair/` current between
// launches (`refreshDocCopies` in app-builder-prompt.js writes them): once at
// boot, and — debounced — after an app's tools or the set of apps change, so
// the OTHER apps' `apps/<app>.md` know about it. Only apps that already have a
// `.vistaclair/` dir are touched; none is created here. Best-effort throughout:
// nothing here may throw into a tool registration or the boot path.
const fs = require('fs');
const path = require('path');
const appManager = require('./app-manager');

const DEBOUNCE_MS = 5000;

let debounceMs = DEBOUNCE_MS;
let timer = null;
const pending = new Set();
let knownApps = null;

function appsWithCopies() {
  let apps = [];
  try { apps = appManager.list(); } catch { return []; }
  return apps
    .map((a) => ({ name: a.name, dir: path.join(appManager.APPS_DIR, a.name) }))
    .filter((a) => fs.existsSync(path.join(a.dir, '.vistaclair')));
}

// Refresh the copies of every app with a `.vistaclair/`. `skip` names an app
// whose own copies cannot be affected (its cross-app sidecars describe the
// others). Returns { apps, changed } — counts.
function refreshAll({ api = true, crossApp = true, skip = null } = {}) {
  const { refreshDocCopies } = require('./app-builder-prompt');
  let apps = 0;
  let changed = 0;
  for (const a of appsWithCopies()) {
    if (a.name === skip) continue;
    try {
      changed += refreshDocCopies(a.dir, a.name, { api, crossApp }).changed.length;
      apps++;
    } catch (err) { console.warn(`[doc-copies] ${a.name}: ${err.message}`); }
  }
  return { apps, changed };
}

function bootRefresh() {
  const r = refreshAll();
  console.log(`  Apps: doc copies refreshed — ${r.apps} app(s), ${r.changed} file(s) changed`);
  return r;
}

function flush() {
  timer = null;
  const changedApps = [...pending];
  pending.clear();
  refreshAll({ api: false, skip: changedApps.length === 1 ? changedApps[0] : null });
}

// An app's tools changed (or it appeared, vanished, was renamed): refresh the
// cross-app sidecars of the others after a quiet period.
function scheduleCrossApp(appName) {
  pending.add(appName || '');
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, debounceMs);
  if (timer.unref) timer.unref();
}

function appNames(apps) {
  return (apps || []).map((a) => a && a.name).filter(Boolean).sort().join('\n');
}

// The broadcast tap: tools updates and renames trigger directly; `app:list` only
// when the set of app names moved (install / remove) — a start or stop does not.
function observe(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'app:tools:updated') scheduleCrossApp(msg.appName);
  else if (msg.type === 'app:renamed') scheduleCrossApp(msg.newName);
  else if (msg.type === 'app:list' && Array.isArray(msg.apps)) {
    const names = appNames(msg.apps);
    if (knownApps !== null && names !== knownApps) scheduleCrossApp(null);
    knownApps = names;
  }
}

function init({ broadcaster, debounce } = {}) {
  if (typeof debounce === 'number') debounceMs = debounce;
  try { knownApps = appNames(appManager.list()); } catch {}
  if (broadcaster && typeof broadcaster.onBroadcast === 'function') return broadcaster.onBroadcast(observe);
  return null;
}

// Tests: drop pending work and the remembered app set.
function reset() {
  if (timer) clearTimeout(timer);
  timer = null;
  pending.clear();
  knownApps = null;
  debounceMs = DEBOUNCE_MS;
}

module.exports = { init, bootRefresh, refreshAll, scheduleCrossApp, observe, reset, DEBOUNCE_MS };
