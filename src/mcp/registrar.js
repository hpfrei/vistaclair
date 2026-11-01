const fs = require('fs');
const path = require('path');
const os = require('os');
const { readJSON, DATA_HOME } = require('../utils');

function resolveConfigPath(scope, projectDir) {
  if (scope === 'project' && projectDir) {
    return path.join(projectDir, '.mcp.json');
  }
  return path.join(os.homedir(), '.claude.json');
}

function readConfig(filePath) {
  return readJSON(filePath, {});
}

// These files may still hold an owner token an older version wrote, and
// ~/.claude.json holds Claude's own credentials: owner-only (0600), the backup
// too (a copy keeps no mode of an existing .bak, so it is replaced).
function writeConfig(filePath, data) {
  // Backup before writing
  if (fs.existsSync(filePath)) {
    try {
      fs.rmSync(filePath + '.bak', { force: true });
      fs.copyFileSync(filePath, filePath + '.bak');
      fs.chmodSync(filePath + '.bak', 0o600);
    } catch {}
  }
  // Atomic write: tmp then rename
  const tmp = filePath + '.tmp';
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, filePath);
}

// The owner token is NOT written: the bridge reads VISTACLAIR_AUTH_TOKEN from
// the environment of the session that starts it (set for every dashboard
// session). `authToken` stays a parameter for callers; it is unused.
function register(slug, meta, bridgePath, authToken, dashboardPort, projectDir) {
  const scope = meta.scope || 'user';
  const filePath = resolveConfigPath(scope, projectDir);
  const config = readConfig(filePath);

  if (!config.mcpServers) config.mcpServers = {};

  const env = {
    MCP_DASHBOARD_URL: `ws://localhost:${dashboardPort}`,
    VISTACLAIR_DASHBOARD_PORT: String(dashboardPort),
    // The bridge decrypts secrets.enc itself at spawn — secrets never land in
    // this (plaintext) config file. Only the locator + slug are passed.
    VISTACLAIR_DATA_HOME: DATA_HOME,
    VISTACLAIR_SERVER_SLUG: slug,
  };
  // Merge user env vars (non-secret)
  if (meta.env) Object.assign(env, meta.env);
  delete env.MCP_AUTH_TOKEN;
  delete env.VISTACLAIR_AUTH_TOKEN;

  config.mcpServers[slug] = {
    command: 'node',
    args: [bridgePath, slug],
    env,
  };

  writeConfig(filePath, config);
  return { ok: true, configPath: filePath };
}

function unregister(slug, scope, projectDir) {
  const filePath = resolveConfigPath(scope, projectDir);
  const config = readConfig(filePath);

  if (config.mcpServers && config.mcpServers[slug]) {
    delete config.mcpServers[slug];
    // Clean up empty mcpServers object
    if (Object.keys(config.mcpServers).length === 0) {
      delete config.mcpServers;
    }
    writeConfig(filePath, config);
  }
  return { ok: true };
}

module.exports = { register, unregister };
