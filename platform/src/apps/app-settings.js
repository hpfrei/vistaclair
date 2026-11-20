// Per-app .settings.json — backs ctx.settings and the settings.* bridge methods.

const fs = require('fs');
const path = require('path');
const { withStateLock, atomicWriteJSON } = require('./app-state');

// --- App settings (.settings.json) ---
// Same mutex + atomic-write discipline as state, in a separate file so apps'
// existing .state.json usage is undisturbed. Backs ctx.settings and the
// settings.* bridge methods (replaces hand-rolled readConfig/writeConfig).

function settingsPath(appDir) {
  return path.join(appDir, '.settings.json');
}

function readSettingsFile(appDir) {
  try { return JSON.parse(fs.readFileSync(settingsPath(appDir), 'utf-8')); } catch { return {}; }
}

function settingsGet(appName, appDir, key) {
  return withStateLock(appName, () => {
    const data = readSettingsFile(appDir);
    return key != null ? (data[key] ?? null) : data;
  });
}

function settingsAll(appName, appDir, defaults) {
  return withStateLock(appName, () => ({ ...(defaults || {}), ...readSettingsFile(appDir) }));
}

// set('key', value) or set({k1: v1, k2: v2}) — object form is a shallow merge.
function settingsSet(appName, appDir, keyOrObj, value) {
  return withStateLock(appName, () => {
    const data = readSettingsFile(appDir);
    if (keyOrObj && typeof keyOrObj === 'object') {
      Object.assign(data, keyOrObj);
    } else {
      if (value === null || value === undefined) delete data[keyOrObj];
      else data[keyOrObj] = value;
    }
    atomicWriteJSON(settingsPath(appDir), data);
    return true;
  });
}

module.exports = { settingsGet, settingsSet, settingsAll };
