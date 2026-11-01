// Token-bearing temp files (an MCP config carries VISTACLAIR_AUTH_TOKEN, a full
// owner credential). Each lives alone in its own mkdtemp directory (0700) as a
// 0600 file, so no other local user can list or read it, and it is removed with
// the session. Handed to Claude Code by path, never inline: argv is world-readable.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Writes `data` as JSON to <private dir>/<name>; returns { dir, file }.
function writePrivateJson(prefix, data, name = 'mcp-config.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
    return { dir, file };
  } catch (e) {
    removePrivateDir(dir);
    throw e;
  }
}

function removePrivateDir(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

module.exports = { writePrivateJson, removePrivateDir };
