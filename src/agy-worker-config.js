// The per-session config of an agy (Antigravity CLI) session (docs/agy-workers.md).
// agy reads hooks and MCP servers only from the workspace (`.agents/`) or its
// global config, and the global config is never touched. So each agy session,
// which always has a worktree of its own, gets:
//
//   <cwd>/.agents/hooks.json         the lib/agy-hook.js hook for every event
//   <cwd>/.agents/mcp_config.json    its MCP servers (no secret: the session
//                                    token reaches them through the inherited env)
//   <dir>/<name>.agy-settings.json   --settings: tool permissions, trusted workspace
//   <dir>/<name>.agy-policy.json     the hook's policy ($VISTACLAIR_AGY_POLICY)
//
// The two `.agents` files are kept out of git through $GIT_COMMON_DIR/info/exclude.
// A repo that tracks either is refused. Nothing here changes agy itself: it is
// the documented per-workspace config plus the `--settings` flag.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const AGENTS_DIR = '.agents';
const HOOKS_FILE = 'hooks.json';
const MCP_FILE = 'mcp_config.json';
const AGENTS_FILES = [`${AGENTS_DIR}/${HOOKS_FILE}`, `${AGENTS_DIR}/${MCP_FILE}`];
const EXCLUDE_PATTERNS = AGENTS_FILES.map(f => `/${f}`);
const HOOK_SCRIPT = path.join(__dirname, '..', 'lib', 'agy-hook.js');
const HOOK_TIMEOUT_S = 10;
const FLAT_EVENTS = ['SessionStart', 'PreInvocation', 'Stop'];
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse'];
// What an MCP child must not inherit from agy: the MITM proxy and its CA.
const PROXY_ENV = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'SSL_CERT_FILE'];
// Never written into a file (they come from the inherited env).
const SECRET_ENV = /TOKEN|SECRET|KEY|PASSWORD|AUTH/i;
const PERMISSIONS = ['mcp(*)', 'read_file(*)', 'write_file(*)', 'command(*)', 'read_url(*)'];

function writeJson(file, obj, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
}

function hookCommand(event, node = process.execPath) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return { type: 'command', command: `${q(node)} ${q(HOOK_SCRIPT)} ${event}`, timeout: HOOK_TIMEOUT_S };
}

function hooksConfig({ node } = {}) {
  const group = {};
  for (const ev of FLAT_EVENTS) group[ev] = [hookCommand(ev, node)];
  for (const ev of TOOL_EVENTS) group[ev] = [{ matcher: '.*', hooks: [hookCommand(ev, node)] }];
  return { vistaclair: group };
}

// One MCP server ({ command, args, env }, as buildMcpServers makes them) in
// agy's shape: started through `env -u <proxy vars>`, with no secret in `env`.
function agyMcpServer(server, { eager = [], timeoutSeconds } = {}) {
  const args = [];
  for (const k of PROXY_ENV) args.push('-u', k);
  args.push(server.command, ...(server.args || []));
  const env = {};
  for (const [k, v] of Object.entries(server.env || {})) if (!SECRET_ENV.test(k)) env[k] = String(v);
  const out = { command: 'env', args };
  if (Object.keys(env).length) out.env = env;
  if (eager.length) out.tools = Object.fromEntries(eager.map(t => [t, { eager: true }]));
  if (timeoutSeconds != null) out.timeoutSeconds = timeoutSeconds;
  return out;
}

// The orchestrator server's tools are eager (mcp_orchestrator_report …); every
// other server stays lazy (call_mcp_tool).
const EAGER = { orchestrator: ['report', 'SendMessage', 'ListAgents', 'launch_cli', 'list_workers'] };

function mcpConfig(servers = {}) {
  const mcpServers = {};
  for (const [name, s] of Object.entries(servers)) mcpServers[name] = agyMcpServer(s, { eager: EAGER[name] || [] });
  return { mcpServers };
}

function settingsConfig({ cwd }) {
  return { permissions: { allow: [...PERMISSIONS] }, trustedWorkspaces: [cwd] };
}

function gitIn(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// The `.agents` files the repo itself tracks (then the session is refused:
// merging a repo's own agy config is not built).
function trackedAgentsFiles(cwd) {
  try { return gitIn(cwd, ['ls-files', '--', ...AGENTS_FILES]).split('\n').filter(Boolean); } catch { return []; }
}

// Add the `.agents` patterns to the repo's info/exclude (the common one: linked
// worktrees read it). Returns the exclude file, or null outside a repo.
function excludeAgents(cwd) {
  let file;
  try { file = path.resolve(cwd, gitIn(cwd, ['rev-parse', '--git-path', 'info/exclude'])); } catch { return null; }
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  const have = new Set(text.split('\n').map(l => l.trim()));
  const missing = EXCLUDE_PATTERNS.filter(p => !have.has(p));
  if (missing.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}# agy sessions (Vistaclair)\n${missing.join('\n')}\n`);
  }
  return file;
}

function filesFor({ cwd, dir, name }) {
  const base = String(name || 'agy').replace(/[^A-Za-z0-9._-]/g, '_');
  return {
    hooksFile: path.join(cwd, AGENTS_DIR, HOOKS_FILE),
    mcpFile: path.join(cwd, AGENTS_DIR, MCP_FILE),
    settingsFile: path.join(dir, `${base}.agy-settings.json`),
    policyFile: path.join(dir, `${base}.agy-policy.json`),
  };
}

// Write all four files. `policy` is the hook's (see lib/agy-hook.js).
function writeAgyConfig({ cwd, dir, name, servers, policy, node }) {
  const f = filesFor({ cwd, dir, name });
  writeJson(f.hooksFile, hooksConfig({ node }), 0o644);
  writeJson(f.mcpFile, mcpConfig(servers), 0o644);
  writeJson(f.settingsFile, settingsConfig({ cwd }));
  writeJson(f.policyFile, policy);
  return f;
}

function writePolicy(file, policy) { writeJson(file, policy); }

function readPolicy(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Remove the `.agents` files (and the dir when that leaves it empty), and the
// settings and policy files.
function removeAgyConfig({ cwd, dir, name }) {
  const f = filesFor({ cwd, dir: dir || cwd, name });
  for (const p of [f.hooksFile, f.mcpFile, ...(dir ? [f.settingsFile, f.policyFile] : [])]) {
    try { fs.rmSync(p, { force: true }); } catch {}
  }
  try { fs.rmdirSync(path.join(cwd, AGENTS_DIR)); } catch {}
}

module.exports = {
  AGENTS_FILES, EXCLUDE_PATTERNS, HOOK_SCRIPT, PROXY_ENV, PERMISSIONS,
  hooksConfig, mcpConfig, agyMcpServer, settingsConfig,
  trackedAgentsFiles, excludeAgents, filesFor, writeAgyConfig, writePolicy, readPolicy, removeAgyConfig,
};
