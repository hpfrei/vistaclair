// The owner token (AUTH_TOKEN) stays out of argv and out of world-readable files:
// the MCP config of a CLI tab and of an Agent SDK session goes by a 0600 file in
// a private 0700 dir (removed with the session), and the MCP registrar writes no
// token into .mcp.json / ~/.claude.json (0600 there too).
//
//   node --test test/

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-tokhyg-')));
process.env.VISTACLAIR_HOME = HOME;
process.env.HOME = HOME;
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.VISTACLAIR_DASHBOARD_PORT = '';

const test = require('node:test');
const assert = require('node:assert');

const utils = require('../src/utils');
const ptySpawns = [];
utils.spawnClaudePty = (args, o) => {
  ptySpawns.push({ args, o });
  return { pid: 0, onData() {}, onExit() {}, write() {}, resize() {} };
};
const claudeAuth = require('../src/claude-auth');
const OUT = JSON.stringify({ loggedIn: false, authMethod: 'none' });
claudeAuth.authStatus.setRunner({ run: async () => OUT, runSync: () => OUT });

const CliSession = require('../src/cli-session');
const SdkSession = require('../src/sdk-session');
const { writePrivateJson, removePrivateDir } = require('../src/private-tmp');
const registrar = require('../src/mcp/registrar');

const TOKEN = 'SECRET-OWNER-TOKEN-0123456789';
const store = { registerSession() {}, unregisterSession() {}, loadSessionIntoMemory: () => [], deleteSessionData() {} };
const WORKER = { name: 'w', engine: 'sdk', orchestration: { runId: 'r1', role: 'worker', workerId: 'w1' } };
const mode = (p) => fs.statSync(p).mode & 0o777;

function fakeSdk() {
  const calls = [];
  return {
    calls,
    sdk: { query({ options }) { calls.push(options); return { [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return: async () => ({ done: true }), close() {} }; } },
  };
}

test('writePrivateJson: 0600 file in a 0700 dir, never overwrites, removed whole', () => {
  const { dir, file } = writePrivateJson('vc-priv-', { a: 1 });
  assert.strictEqual(mode(dir), 0o700);
  assert.strictEqual(mode(file), 0o600);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
  removePrivateDir(dir);
  assert.ok(!fs.existsSync(dir));
  removePrivateDir(null);
});

test('CLI tab: the MCP config is a private file, the token is in no arg, the file goes on exit', () => {
  const cli = new CliSession(9999, { broadcast() {} }, store, { authToken: TOKEN, dashboardPort: 4321 });
  cli.updateSettings(WORKER);
  cli.spawn(HOME, 80, 24, {});
  const { args, o } = ptySpawns.at(-1);
  assert.ok(!JSON.stringify(args).includes(TOKEN), 'no token in argv');
  const file = args[args.indexOf('--mcp-config') + 1];
  assert.strictEqual(mode(file), 0o600);
  assert.strictEqual(mode(path.dirname(file)), 0o700);
  assert.ok(fs.readFileSync(file, 'utf8').includes(TOKEN), 'the servers still get it (env)');
  assert.strictEqual(o.authToken, TOKEN);
  cli.kill();
  assert.ok(!fs.existsSync(path.dirname(file)), 'dir removed');
});

test('SDK session: no inline mcpServers, the token is in no arg, a private file is removed on kill and respawn', () => {
  const { sdk, calls } = fakeSdk();
  const s = new SdkSession(9999, { broadcast() {} }, store, { sdk, claudeBin: '/opt/claude', authToken: TOKEN, dashboardPort: 4321 });
  s.updateSettings(WORKER);
  s.spawn(HOME, 80, 24, {});
  const o = calls[0];
  assert.strictEqual(o.mcpServers, undefined);
  // What the SDK turns options into: --flag value pairs (extraArgs) — no JSON blob.
  const argv = Object.entries(o.extraArgs).flatMap(([k, v]) => (v === null ? [`--${k}`] : [`--${k}`, String(v)]));
  assert.ok(!argv.join('\0').includes(TOKEN), 'no token in argv');
  const file = o.extraArgs['mcp-config'];
  assert.strictEqual(mode(file), 0o600);
  assert.strictEqual(mode(path.dirname(file)), 0o700);
  const servers = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers;
  assert.strictEqual(servers.orchestrator.env.VISTACLAIR_AUTH_TOKEN, TOKEN, 'MCP servers still get the token through env');
  assert.strictEqual(servers.integrated?.env?.VISTACLAIR_AUTH_TOKEN ?? TOKEN, TOKEN);

  s.spawn(HOME, 80, 24, {});   // respawn: the old file goes, a new one comes
  assert.ok(!fs.existsSync(path.dirname(file)));
  const file2 = calls[1].extraArgs['mcp-config'];
  assert.notStrictEqual(file2, file);
  assert.ok(fs.existsSync(file2));
  s.kill();
  assert.ok(!fs.existsSync(path.dirname(file2)));
});

test('registrar: no token in .mcp.json or ~/.claude.json, files are 0600, old 0664 files and backups are tightened', () => {
  const proj = fs.mkdtempSync(path.join(HOME, 'proj-'));
  const mcpJson = path.join(proj, '.mcp.json');
  // A file an older version wrote: token inside, world-readable, with a stale backup.
  fs.writeFileSync(mcpJson, JSON.stringify({ mcpServers: { integrated: { command: 'node', env: { MCP_AUTH_TOKEN: TOKEN, VISTACLAIR_AUTH_TOKEN: TOKEN } } } }), { mode: 0o664 });
  fs.chmodSync(mcpJson, 0o664);
  fs.writeFileSync(mcpJson + '.bak', 'old');
  fs.chmodSync(mcpJson + '.bak', 0o664);

  const meta = { scope: 'project', env: { MCP_AUTH_TOKEN: TOKEN, KEEP: 'yes' } };
  const r = registrar.register('integrated', meta, '/x/mcp-bridge.js', TOKEN, 3457, proj);
  assert.strictEqual(r.configPath, mcpJson);
  assert.ok(!fs.readFileSync(mcpJson, 'utf8').includes(TOKEN), 'no token in .mcp.json');
  assert.strictEqual(JSON.parse(fs.readFileSync(mcpJson, 'utf8')).mcpServers.integrated.env.KEEP, 'yes');
  assert.strictEqual(mode(mcpJson), 0o600);
  assert.strictEqual(mode(mcpJson + '.bak'), 0o600);

  const r2 = registrar.register('integrated', { scope: 'user' }, '/x/mcp-bridge.js', TOKEN, 3457, proj);
  assert.strictEqual(r2.configPath, path.join(HOME, '.claude.json'));
  assert.ok(!fs.readFileSync(r2.configPath, 'utf8').includes(TOKEN), 'no token in ~/.claude.json');
  assert.strictEqual(mode(r2.configPath), 0o600);
  assert.ok(!fs.existsSync(r2.configPath + '.tmp'));
});
