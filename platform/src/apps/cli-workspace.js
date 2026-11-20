// Workspace sessions (`cli.workspace`): an app opens an interactive Claude Code
// session in one of its own work folders — `<appDir>/workspaces/<name>`, a
// Blender scene, a dataset — with its own instructions as the system prompt.
// Not an app-change session: no sidecars, no APP.md check, no change requests.
//
// Identity rides on the settings stamps (SESSION_STAMPS.workspace /
// .workspaceDir), not on the tab id: core restores a visible tab under a fresh
// `tab-<boot>-N` id, so every lookup here derives from the live session map.
// A running session is reused, never respawned over — core's spawn kills the
// pty it replaces.
const fs = require('fs');
const path = require('path');
const appManager = require('./app-manager');
const { SESSION_STAMPS } = require('./app-change-requests');

const ROOT = 'workspaces';
const NAME = /^[a-z0-9-]+$/;
const INSTRUCTIONS_MAX = 32 * 1024;
const PREAMBLE_FILE = path.join(__dirname, 'prompts', '_workspace-preamble.md');
const EVENT = 'cli:workspace';

let deps = { cliSessionManager: null, broadcaster: null, addExitHook: null };
// Tabs whose exit already reports to the app: re-arming on every reuse would
// emit `exited` once per call.
const hooked = new Set();

function init(options = {}) {
  deps = {
    cliSessionManager: options.cliSessionManager || null,
    broadcaster: options.broadcaster || null,
    addExitHook: typeof options.addExitHook === 'function' ? options.addExitHook : null,
  };
  hooked.clear();
}

// `ws-<app>.<name>` — `.` never occurs in an app name, so the split is unambiguous.
function tabIdOf(appName, name) { return `ws-${appName}.${name}`; }

// The one realpath'd string used for the containment check, the cwd and the
// stamp: core resumes by exact `cwd` match, so all three must agree.
function resolveDir(appName, dir) {
  if (typeof dir !== 'string' || !NAME.test(dir)) {
    throw new Error(`dir must be one workspace name (a-z, 0-9, -) under ${ROOT}/, got ${JSON.stringify(dir)}`);
  }
  const appDir = path.join(appManager.APPS_DIR, appName);
  let real;
  try { real = fs.realpathSync(path.join(appDir, ROOT, dir)); }
  catch { throw new Error(`workspace "${dir}" does not exist — the app creates ${ROOT}/${dir} first`); }
  const base = path.join(fs.realpathSync(appDir), ROOT);
  if (path.dirname(real) !== base) throw new Error(`workspace "${dir}" resolves outside ${ROOT}/`);
  if (!fs.statSync(real).isDirectory()) throw new Error(`workspace "${dir}" is not a directory`);
  return { name: path.basename(real), real };
}

function settingsOf(session) {
  try {
    if (typeof session.getSettings === 'function') return session.getSettings() || {};
    return session.settings || {};
  } catch { return {}; }
}

// Every session (hidden included) this app opened in a workspace, by stamp.
function workspaceSessionsOf(appName) {
  const sessions = deps.cliSessionManager?.sessions;
  if (!sessions) return [];
  const out = [];
  for (const [tabId, session] of sessions) {
    const s = settingsOf(session);
    if (s[SESSION_STAMPS.workspace] !== appName) continue;
    out.push({ tabId, dir: s[SESSION_STAMPS.workspaceDir] || null, running: !!session.running, hidden: !!session.hidden });
  }
  return out;
}

// Is this tab one of the app's own CLI sessions? Its change and tools tabs by
// id, plus anything stamped for it — a change tab core restored under
// `tab-<boot>-N` keeps its `changeApp` stamp, a workspace tab its own.
function ownsTab(appName, tabId) {
  if (tabId === `app-${appName}` || tabId === `app-${appName}-tools`) return true;
  const session = deps.cliSessionManager?.sessions?.get(tabId);
  if (!session) return false;
  const s = settingsOf(session);
  return s[SESSION_STAMPS.app] === appName || s[SESSION_STAMPS.workspace] === appName;
}

// `cli.workspaces`: what the app sees of its own sessions — the same rows as
// `workspaceSessionsOf`, with `dir` as the workspace name, optionally one dir.
// This is how a GUI reconciles a saved tabId after a reload or a restart, when
// the `cli:workspace` events it missed are gone.
function list(appName, params = {}) {
  const { dir } = params;
  if (dir !== undefined && dir !== null && (typeof dir !== 'string' || !NAME.test(dir))) {
    throw new Error(`dir must be one workspace name (a-z, 0-9, -) under ${ROOT}/, got ${JSON.stringify(dir)}`);
  }
  return workspaceSessionsOf(appName)
    .map((s) => ({ tabId: s.tabId, dir: s.dir ? path.basename(s.dir) : null, running: s.running, hidden: s.hidden }))
    .filter((s) => !dir || s.dir === dir);
}

function killWorkspaceSessions(appName, { remove = false } = {}) {
  const csm = deps.cliSessionManager;
  if (!csm) return [];
  const ids = workspaceSessionsOf(appName).map((s) => s.tabId);
  for (const id of ids) {
    try { remove ? csm.remove(id) : csm.kill(id); }
    catch (e) { console.error(`[app:${appName}] could not end workspace session ${id}:`, e.message); }
  }
  return ids;
}

function emit(appName, data) {
  if (deps.broadcaster) deps.broadcaster.broadcast({ type: 'app:bridge:event', appName, event: EVENT, data });
}

function armExit(appName, tabId, name, hidden) {
  if (!deps.addExitHook || hooked.has(tabId)) return;
  hooked.add(tabId);
  deps.addExitHook(tabId, () => {
    hooked.delete(tabId);
    emit(appName, { tabId, dir: name, state: 'exited', hidden });
  });
}

function preamble(appName, real) {
  return fs.readFileSync(PREAMBLE_FILE, 'utf-8').trim()
    .replace(/\{\{APP\}\}/g, appName)
    .replace(/\{\{DIR\}\}/g, real);
}

// Keeps the apps-repo CLAUDE.md (the app-change standing rules, an ancestor of
// every workspace) out of the session; the workspace's own CLAUDE.md still loads.
function writeSettingsFile(appName, name) {
  const file = path.join(appManager.APPS_DIR, appName, '.data', ROOT, name, 'settings.json');
  const excludes = new Set([path.join(appManager.APPS_DIR, 'CLAUDE.md')]);
  try { excludes.add(path.join(fs.realpathSync(appManager.APPS_DIR), 'CLAUDE.md')); } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ claudeMdExcludes: [...excludes] }, null, 2) + '\n');
  return file;
}

// → { tabId, dir, reused, hidden }. `hidden` is for the caller (a hidden
// session opens no tab); the Bridge result is the other three.
function open(appName, params = {}) {
  const csm = deps.cliSessionManager;
  if (!csm) throw new Error('CLI session manager not available');
  const { title, instructions, prompt } = params;
  if (typeof title !== 'string' || !title.trim()) throw new Error('title is required');
  if (typeof instructions !== 'string' || !instructions.trim()) throw new Error('instructions are required');
  if (Buffer.byteLength(instructions, 'utf-8') > INSTRUCTIONS_MAX) throw new Error(`instructions exceed ${INSTRUCTIONS_MAX / 1024} KB`);
  if (prompt !== undefined && prompt !== null && typeof prompt !== 'string') throw new Error('prompt must be a string');
  const autoSubmit = !!params.autoSubmit;
  const hidden = !!params.hidden;
  if (hidden && !autoSubmit) throw new Error('hidden requires autoSubmit: true — nobody can submit a prompt in a background session');
  const { name, real } = resolveDir(appName, params.dir);

  const running = workspaceSessionsOf(appName).find((s) => s.running && s.dir === real);
  if (running) {
    armExit(appName, running.tabId, name, running.hidden);
    if (prompt) {
      // Same two chunks as core's launchSession: a chunk with an embedded
      // newline reads as a paste, so the submitting CR goes on its own.
      csm.writeWhenReady(running.tabId, prompt);
      if (autoSubmit) csm.writeWhenReady(running.tabId, '\r', 400);
    }
    emit(appName, { tabId: running.tabId, dir: name, state: 'started', hidden: running.hidden, reused: true });
    return { tabId: running.tabId, dir: name, reused: true, hidden: running.hidden };
  }

  const tabId = tabIdOf(appName, name);
  csm.launchSession(tabId, {
    cwd: real,
    title,
    settings: {
      appendSystemPrompt: preamble(appName, real) + '\n\n' + instructions,
      settingsFile: writeSettingsFile(appName, name),
      [SESSION_STAMPS.workspace]: appName,
      [SESSION_STAMPS.workspaceDir]: real,
    },
    prompt: prompt || undefined,
    autoSubmit,
    hidden,
    spawnOpts: { resume: true },
  });
  armExit(appName, tabId, name, hidden);
  emit(appName, { tabId, dir: name, state: 'started', hidden, reused: false });
  return { tabId, dir: name, reused: false, hidden };
}

module.exports = { init, open, list, workspaceSessionsOf, killWorkspaceSessions, ownsTab, tabIdOf, ROOT, INSTRUCTIONS_MAX };
