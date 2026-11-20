// Per-host role + enabled-apps config (.host.json in APPS_DIR). Gitignored —
// this is what makes one checkout a "master" (full editing, commit/push) and
// another a "slave" (pull-only mirror hosting a selected subset of apps).
// Mirrors platform-settings' JSON-on-disk pattern.
//
//   { "role": "slave", "enabledApps": ["pixachat"],
//     "slave": { "name": "hetzner-1", "masterUrl": "https://…",
//                "publicUrl": "https://…", "linkStatus": "linked" } }
//
// Absent file ⇒ { role: "master", enabledApps: null } (null = all apps).
// VISTACLAIR_ROLE=master|slave overrides the file (break-glass).
//
// The remote-sessions opt-in is NOT in .host.json: a session the master
// launches runs in APPS_DIR/<app> and could rewrite its parent's files. It and
// the remote-launch audit live in <dataHome>/remote-sessions/ (settings.json,
// audit.jsonl), outside the apps tree. Without such a dataHome the opt-in is
// off and cannot be set.
const fs = require('fs');
const path = require('path');

let appsDir = null;
let config = {};
let rsDir = null;                                   // <dataHome>/remote-sessions, or null
let rs = { enabled: false, allowApiKey: false };    // its settings.json, read once at init

const DEFAULTS = { role: 'master', enabledApps: null, slave: null };

function configPath() {
  return path.join(appsDir, '.host.json');
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf-8')) || {};
  } catch {
    return {};
  }
}

function save() {
  const tmp = configPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, configPath());
}

function init(dir, { dataHome } = {}) {
  appsDir = dir;
  config = load();
  rsDir = null;
  rs = { enabled: false, allowApiKey: false };
  const legacy = config.remoteSessions;
  delete config.remoteSessions;
  if (!dataHome) return;
  const home = path.resolve(dataHome);
  const apps = path.resolve(dir);
  if (home === apps || home.startsWith(apps + path.sep)) {
    console.warn('[host-config] dataHome is inside the apps dir — remote sessions stay off');
    return;
  }
  rsDir = path.join(home, 'remote-sessions');
  try {
    rs = normRemote(JSON.parse(fs.readFileSync(rsFile(), 'utf-8')));
  } catch (err) {
    if (err.code === 'ENOENT') migrateRemote(legacy);
    else console.warn('[host-config] remote-sessions settings unreadable — off:', err.message);
  }
}

function rsFile() { return path.join(rsDir, 'settings.json'); }

function normRemote(r) {
  return { enabled: r?.enabled === true, allowApiKey: r?.allowApiKey === true };
}

function saveRemote() {
  fs.mkdirSync(rsDir, { recursive: true });
  const tmp = rsFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rs, null, 2));
  fs.renameSync(tmp, rsFile());
}

// Once, the first time a dataHome is known: the opt-in and the audit move out
// of the apps dir. Afterwards settings.json exists and .host.json's
// `remoteSessions` (wherever it came from) is never read again.
function migrateRemote(legacy) {
  rs = normRemote(legacy);
  try {
    const oldAudit = path.join(appsDir, '.remote-sessions.jsonl');
    const newAudit = path.join(rsDir, 'audit.jsonl');
    fs.mkdirSync(rsDir, { recursive: true });
    if (fs.existsSync(oldAudit) && !fs.existsSync(newAudit)) {
      fs.copyFileSync(oldAudit, newAudit);
      fs.rmSync(oldAudit, { force: true });
    }
    saveRemote();
    if (legacy !== undefined) save();
  } catch (err) {
    console.warn('[host-config] remote-sessions migration failed — off:', err.message);
    rs = { enabled: false, allowApiKey: false };
  }
}

function all() {
  return { ...DEFAULTS, ...config };
}

function role() {
  const env = process.env.VISTACLAIR_ROLE;
  if (env === 'master' || env === 'slave') return env;
  return all().role === 'slave' ? 'slave' : 'master';
}

function isSlave() {
  return role() === 'slave';
}

// null = no restriction (master default). On a slave an absent list means
// "host nothing" — apps only run here once the master (or the owner) enables them.
function enabledApps() {
  const list = all().enabledApps;
  return Array.isArray(list) ? list : null;
}

function isEnabled(name) {
  if (!isSlave()) return true;
  const list = enabledApps();
  return !!list && list.includes(name);
}

function enableApp(name) {
  const list = enabledApps() || [];
  if (!list.includes(name)) {
    config.enabledApps = [...list, name].sort();
    save();
  }
  return config.enabledApps;
}

function disableApp(name) {
  const list = enabledApps() || [];
  config.enabledApps = list.filter((n) => n !== name);
  save();
  return config.enabledApps;
}

function setRole(newRole) {
  if (newRole !== 'master' && newRole !== 'slave') throw new Error(`bad role "${newRole}"`);
  config.role = newRole;
  if (newRole === 'slave' && !Array.isArray(config.enabledApps)) config.enabledApps = [];
  save();
}

// Merge fields into the slave sub-config ({ name, masterUrl, publicUrl,
// linkStatus, linkedAt, registrationId }). Passing null clears it.
function setSlave(patch) {
  config.slave = patch === null ? null : { ...(config.slave || {}), ...patch };
  save();
  return config.slave;
}

function slaveInfo() {
  return all().slave;
}

// Remote sessions (peer-remote-slave.js): whether the linked master may launch
// Agent SDK sessions here, and bill them to this host's API key. Off by
// default; set only from this host's own dashboard (app:peer:remoteSessions).
// Read from disk at init only, so an edit to the file needs a restart.
function remoteSessions() {
  return rsDir ? { ...rs } : { enabled: false, allowApiKey: false };
}

function setRemoteSessions(patch = {}) {
  if (!rsDir) throw new Error('remote sessions need a data home outside the apps dir');
  const next = { ...rs };
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (typeof patch.allowApiKey === 'boolean') next.allowApiKey = patch.allowApiKey;
  rs = next;
  saveRemote();
  return { ...rs };
}

// <dataHome>/remote-sessions (the audit's folder), or null when there is none.
function remoteSessionsDir() {
  return rsDir;
}

module.exports = { init, all, role, isSlave, enabledApps, isEnabled, enableApp, disableApp, setRole, setSlave, slaveInfo, remoteSessions, setRemoteSessions, remoteSessionsDir };
