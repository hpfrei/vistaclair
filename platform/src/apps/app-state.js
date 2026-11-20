// Per-app .state.json — the `state` capability (state.get/set/delete/clear).
// One mutex per app (shared with app-settings, which keeps the same discipline
// in its own file) and atomic writes, so concurrent bridge calls never interleave.

const fs = require('fs');
const path = require('path');
const { chainLock } = require('../utils');

const stateLocks = new Map();
const withStateLock = (appName, fn) => chainLock(stateLocks, appName, fn);

function atomicWriteJSON(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

function statePath(appDir) { return path.join(appDir, '.state.json'); }

function readState(appDir) {
  try { return JSON.parse(fs.readFileSync(statePath(appDir), 'utf-8')); } catch { return {}; }
}

// A missing or unparsable file reads as null (whole) / undefined (key) — the
// pre-module bridge semantics.
function get(appName, appDir, key) {
  return withStateLock(appName, () => {
    try {
      const data = JSON.parse(fs.readFileSync(statePath(appDir), 'utf-8'));
      return key ? data[key] : data;
    } catch {
      return null;
    }
  });
}

function set(appName, appDir, key, value) {
  return withStateLock(appName, () => {
    const data = readState(appDir);
    data[key] = value;
    atomicWriteJSON(statePath(appDir), data);
    return true;
  });
}

function del(appName, appDir, key) {
  return withStateLock(appName, () => {
    const data = readState(appDir);
    delete data[key];
    atomicWriteJSON(statePath(appDir), data);
    return true;
  });
}

function clear(appName, appDir) {
  return withStateLock(appName, () => {
    atomicWriteJSON(statePath(appDir), {});
    return true;
  });
}

module.exports = { withStateLock, atomicWriteJSON, get, set, delete: del, clear };
