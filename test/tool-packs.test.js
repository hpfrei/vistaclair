// Tool packs (src/tool-packs.js): with no pack registered every session is
// configured exactly as before (MCP servers, CLI args, SDK options); a default
// pack attaches to its roles only, an opt-in pack only through
// settings.toolPacks; a throwing build is skipped; core MCP names win.
// Add-on registration through the descriptor and the ctx. consumes / validate
// / release: build per spawn, release once per ended spawn with its reason.
//
//   node --test test/

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-packs-')));
process.env.VISTACLAIR_HOME = HOME;
process.env.HOME = HOME;
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.VISTACLAIR_DASHBOARD_PORT = '';

const test = require('node:test');
const assert = require('node:assert');

// An enabled integrated tool, so the core server set is not empty.
const metaDir = path.join(HOME, 'mcp-servers', 'integrated');
fs.mkdirSync(metaDir, { recursive: true });
fs.writeFileSync(path.join(metaDir, 'meta.json'), JSON.stringify({ tools: [{ name: 'echo', enabled: true }] }));

const utils = require('../src/utils');
const ptySpawns = [];
utils.spawnClaudePty = (args, o) => {
  const pty = { pid: 0, onData() {}, onExit(cb) { pty.exit = cb; }, write() {}, resize() {} };
  ptySpawns.push({ args, o, pty });
  return pty;
};
const claudeAuth = require('../src/claude-auth');
const SIGNED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none' });
claudeAuth.authStatus.setRunner({ run: async () => SIGNED_OUT, runSync: () => SIGNED_OUT });

const toolPacks = require('../src/tool-packs');
const CliSession = require('../src/cli-session');
const SdkSession = require('../src/sdk-session');
const addons = require('../src/addons');
const { buildAppendSystemPrompt, buildMcpServers } = CliSession;
const { buildCliArgs, ROLE_DISALLOWED_TOOLS } = utils;

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const store = { registerSession() {}, unregisterSession() {}, loadSessionIntoMemory: () => [], deleteSessionData() {} };
const WORKER = { name: 'w', engine: 'cli', orchestration: { runId: 'r1', role: 'worker', workerId: 'w1' } };
const ORCH = { orchestration: { runId: 'r1', role: 'orchestrator' } };
const PLAIN = { appendSystemPrompt: 'CALLER' };

function clearPacks() {
  for (const p of toolPacks.listToolPacks()) toolPacks.unregisterToolPack(p.id);
}

// Silences and records console.error for one call.
function quietly(fn) {
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try { return { value: fn(), logged }; } finally { console.error = orig; }
}

function spawnCli(settings) {
  const cli = new CliSession(9999, { broadcast() {} }, store, { authToken: 'tok', dashboardPort: 4321 });
  cli.updateSettings(settings);
  cli.spawn(HOME, 80, 24, {});
  const args = ptySpawns.at(-1).args;
  const mcp = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers;
  cli.kill();
  return { cli, args, mcp };
}

function spawnSdk(settings) {
  const calls = [];
  const sdk = {
    query({ options }) {
      calls.push(options);
      return { [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return: async () => ({ done: true }), close() {} };
    },
  };
  const s = new SdkSession(9999, { broadcast() {} }, store, { sdk, claudeBin: '/opt/claude', authToken: 'tok', dashboardPort: 4321 });
  s.updateSettings(settings);
  s.spawn(HOME, 80, 24, {});
  s.kill();
  return { s, o: calls[0] };
}

// --- No pack: as before ---

test('no pack: buildMcpServers, CLI args and SDK options are what core alone builds', () => {
  clearPacks();
  for (const settings of [WORKER, ORCH, PLAIN]) {
    // The CLI tab: exactly the pre-pack argument formula.
    const { cli, args, mcp } = spawnCli(settings);
    const expected = ['--dangerously-skip-permissions', ...buildCliArgs({ ...cli.settings, appendSystemPrompt: buildAppendSystemPrompt(cli.settings) }), '--session-id', cli.sessId, '--mcp-config', args.at(-1)];
    assert.deepStrictEqual(args, expected);
    const denied = args.includes('--disallowedTools') ? args[args.indexOf('--disallowedTools') + 1] : null;
    assert.strictEqual(denied, settings === PLAIN ? null : ROLE_DISALLOWED_TOOLS[settings.orchestration.role].join(','), 'the role\'s list only');
    const coreOpts = { settings: cli.settings, instanceId: cli.instanceId, dashboardPort: 4321, authToken: 'tok' };
    assert.deepStrictEqual(mcp, buildMcpServers(coreOpts));
    assert.ok(mcp.integrated, 'the integrated bridge is there');
    assert.strictEqual(!!mcp.orchestrator, settings !== PLAIN);

    // The SDK session.
    const { s, o } = spawnSdk(settings);
    assert.deepStrictEqual(o.disallowedTools, utils.disallowedToolsFor(settings, ['SendMessage', 'ListAgents']));
    assert.strictEqual(o.systemPrompt.append, buildAppendSystemPrompt(s.settings));
    assert.deepStrictEqual(o.mcpServers, buildMcpServers({ settings: s.settings, instanceId: s.instanceId, dashboardPort: 4321, authToken: 'tok' }));
  }
  assert.deepStrictEqual(Object.keys(buildMcpServers({ settings: WORKER, instanceId: 'cli-x' })), ['integrated', 'orchestrator']);
});

test('a pack that does not apply changes nothing', () => {
  clearPacks();
  const before = spawnCli(WORKER);
  const sdkBefore = spawnSdk(WORKER);
  toolPacks.registerToolPack({ id: 'orch-only', roles: ['orchestrator'], default: true, build: () => ({ mcpServers: { x: { command: 'x' } }, disallowedTools: ['Bash'], appendSystemPrompt: 'X' }) });
  toolPacks.registerToolPack({ id: 'opt-in', roles: ['worker'], build: () => ({ disallowedTools: ['Edit'] }) });
  const after = spawnCli(WORKER);
  const sdkAfter = spawnSdk(WORKER);
  const norm = (r) => JSON.parse(JSON.stringify(r.args).split(r.cli.sessId).join('<id>').replace(/vistaclair-cli-mcp-[^"]+/, '<cfg>'));
  assert.deepStrictEqual(norm(after), norm(before));
  assert.deepStrictEqual(JSON.stringify(after.mcp).split(after.cli.sessId).join('<id>'), JSON.stringify(before.mcp).split(before.cli.sessId).join('<id>'));
  assert.deepStrictEqual(sdkAfter.o.disallowedTools, sdkBefore.o.disallowedTools);
  assert.deepStrictEqual(Object.keys(sdkAfter.o.mcpServers), Object.keys(sdkBefore.o.mcpServers));
  assert.strictEqual(sdkAfter.o.systemPrompt.append.split(sdkAfter.s.sessId).join('<id>'), sdkBefore.o.systemPrompt.append.split(sdkBefore.s.sessId).join('<id>'));
  clearPacks();
});

// --- Selection ---

test('a default pack attaches to every session of its roles, and only those', () => {
  clearPacks();
  const seen = [];
  toolPacks.registerToolPack({ id: 'wk', roles: ['worker', 'plain'], default: true, build: (ctx) => { seen.push(ctx); return { disallowedTools: ['WebSearch'] }; } });
  assert.deepStrictEqual(toolPacks.toolPackContributions({ settings: WORKER, instanceId: 'cli-1', cwd: '/c', sessId: 's1' }).packs, ['wk']);
  assert.deepStrictEqual(toolPacks.toolPackContributions({ settings: PLAIN }).packs, ['wk']);
  assert.deepStrictEqual(toolPacks.toolPackContributions({ settings: ORCH }).packs, []);
  assert.strictEqual(seen[0].role, 'worker');
  assert.strictEqual(seen[0].instanceId, 'cli-1');
  assert.strictEqual(seen[0].cwd, '/c');
  assert.strictEqual(seen[0].sessId, 's1');
  assert.strictEqual(seen[1].role, 'plain');
  clearPacks();
});

test('an opt-in pack attaches only when settings.toolPacks names it, within its roles', () => {
  clearPacks();
  toolPacks.registerToolPack({ id: 'extra', roles: ['plain'], build: () => ({ appendSystemPrompt: 'EXTRA' }) });
  assert.deepStrictEqual(toolPacks.toolPackContributions({ settings: PLAIN }).packs, []);
  assert.deepStrictEqual(toolPacks.toolPackContributions({ settings: { ...PLAIN, toolPacks: ['other'] } }).packs, []);
  assert.deepStrictEqual(toolPacks.toolPackContributions({ settings: { ...PLAIN, toolPacks: 'extra' } }).packs, [], 'not an array: ignored');
  assert.deepStrictEqual(toolPacks.toolPackContributions({ settings: { ...PLAIN, toolPacks: ['extra'] } }).packs, ['extra']);
  assert.deepStrictEqual(toolPacks.toolPackContributions({ settings: { ...WORKER, toolPacks: ['extra'] } }).packs, [], 'outside its roles');
  clearPacks();
});

// --- Contributions reach the session ---

test('a pack\'s servers, disallowed tools and prompt reach the CLI args and the SDK options', () => {
  clearPacks();
  toolPacks.registerToolPack({
    id: 'p1', roles: ['worker'], default: true,
    build: ({ instanceId }) => ({ mcpServers: { packsrv: { command: 'node', args: ['p.js'], env: { ID: instanceId } } }, disallowedTools: ['Bash', 'SendMessage'], appendSystemPrompt: 'PACK ONE' }),
  });
  toolPacks.registerToolPack({ id: 'p2', roles: ['worker'], default: true, build: () => ({ disallowedTools: ['Bash', 'Write'], appendSystemPrompt: 'PACK TWO' }) });

  const { cli, args, mcp } = spawnCli(WORKER);
  const flag = (f) => args[args.indexOf(f) + 1];
  assert.strictEqual(flag('--append-system-prompt'), buildAppendSystemPrompt(cli.settings) + '\n\nPACK ONE\n\nPACK TWO');
  // One --disallowedTools: the role's list, then the packs' (deduplicated).
  assert.strictEqual(args.filter(a => a === '--disallowedTools').length, 1);
  assert.strictEqual(args[args.indexOf('--disallowedTools') + 1], [...ROLE_DISALLOWED_TOOLS.worker, 'Bash', 'SendMessage', 'Write'].join(','));
  assert.deepStrictEqual(Object.keys(mcp), ['integrated', 'orchestrator', 'packsrv']);
  assert.strictEqual(mcp.packsrv.env.ID, cli.instanceId);

  const { s, o } = spawnSdk(WORKER);
  assert.deepStrictEqual(o.disallowedTools, ['SendMessage', 'ListAgents', ...ROLE_DISALLOWED_TOOLS.worker, 'Bash', 'Write']);
  assert.strictEqual(o.systemPrompt.append, buildAppendSystemPrompt(s.settings) + '\n\nPACK ONE\n\nPACK TWO');
  assert.deepStrictEqual(Object.keys(o.mcpServers), ['integrated', 'orchestrator', 'packsrv']);
  assert.strictEqual(o.mcpServers.packsrv.env.ID, s.instanceId);
  clearPacks();
});

// --- Failures ---

test('a throwing, async or malformed build is skipped and logged; the launch goes on', () => {
  clearPacks();
  toolPacks.registerToolPack({ id: 'boom', roles: ['plain'], default: true, build: () => { throw new Error('kaput'); } });
  toolPacks.registerToolPack({ id: 'async', roles: ['plain'], default: true, build: async () => ({ disallowedTools: ['Bash'] }) });
  toolPacks.registerToolPack({ id: 'bad', roles: ['plain'], default: true, build: () => ({ mcpServers: [1], disallowedTools: 'Bash', appendSystemPrompt: 3 }) });
  toolPacks.registerToolPack({ id: 'good', roles: ['plain'], default: true, build: () => ({ disallowedTools: ['Edit'] }) });
  const { value, logged } = quietly(() => toolPacks.toolPackContributions({ settings: PLAIN }));
  assert.deepStrictEqual(value.packs, ['bad', 'good']);
  assert.deepStrictEqual(value.disallowedTools, ['Edit']);
  assert.deepStrictEqual(value.mcpServers, {});
  assert.strictEqual(value.appendSystemPrompt, '');
  assert.ok(logged.some(l => l.includes('"boom"') && l.includes('kaput')));
  assert.ok(logged.some(l => l.includes('"async"') && l.includes('synchronous')));

  const { value: r } = quietly(() => spawnCli(PLAIN));
  assert.strictEqual(r.args[r.args.indexOf('--disallowedTools') + 1], 'Edit');
  clearPacks();
});

test('MCP name collisions: core wins over a pack, the first pack over a later one; both logged', () => {
  clearPacks();
  toolPacks.registerToolPack({ id: 'a', roles: ['worker'], default: true, build: () => ({ mcpServers: { orchestrator: { command: 'evil' }, integrated: { command: 'evil' }, shared: { command: 'a' } } }) });
  toolPacks.registerToolPack({ id: 'b', roles: ['worker'], default: true, build: () => ({ mcpServers: { shared: { command: 'b' } } }) });
  const { value: servers, logged } = quietly(() => buildMcpServers({ settings: WORKER, instanceId: 'cli-x' }));
  assert.strictEqual(servers.orchestrator.command, 'node');
  assert.strictEqual(servers.integrated.command, 'node');
  assert.strictEqual(servers.shared.command, 'a');
  assert.ok(logged.some(l => l.includes('"orchestrator"') && l.includes('core')));
  assert.ok(logged.some(l => l.includes('"integrated"') && l.includes('core')));
  assert.ok(logged.some(l => l.includes('"b"') && l.includes('"shared"')));
  clearPacks();
});

// --- Registry ---

test('register validates, lists, replaces for the same owner, unregisters', () => {
  clearPacks();
  const build = () => ({});
  assert.throws(() => toolPacks.registerToolPack({ id: 'bad id', build }), /invalid/);
  assert.throws(() => toolPacks.registerToolPack({ id: 'x' }), /build/);
  assert.throws(() => toolPacks.registerToolPack({ id: 'x', roles: ['admin'], build }), /roles/);
  assert.throws(() => toolPacks.registerToolPack({ id: 'x', roles: [], build }), /roles/);

  const off = toolPacks.registerToolPack({ id: 'x', description: 'X pack', build });
  assert.deepStrictEqual(toolPacks.listToolPacks(), [{ id: 'x', description: 'X pack', roles: ['orchestrator', 'worker', 'plain'], default: false }]);
  assert.throws(() => toolPacks.registerToolPack({ id: 'x', build }, { owner: 'other' }), /already registered/);
  toolPacks.registerToolPack({ id: 'x', description: 'X again', default: true, roles: ['worker'], build });
  assert.deepStrictEqual(toolPacks.listToolPacks(), [{ id: 'x', description: 'X again', roles: ['worker'], default: true }]);
  off(); // the replaced entry's unregister no longer removes the new one
  assert.strictEqual(toolPacks.listToolPacks().length, 1);
  assert.strictEqual(toolPacks.unregisterToolPack('x'), true);
  assert.deepStrictEqual(toolPacks.listToolPacks(), []);
});

test('add-ons: descriptor toolPacks register with the add-on and go with removeAddon; ctx.registerToolPack', () => {
  clearPacks();
  const build = () => ({});
  const { logged } = quietly(() => addons.registerAddon({
    contractVersion: addons.CONTRACT_VERSION, id: 'pro-test',
    toolPacks: [{ id: 'pro-a', roles: ['plain'], build }, { id: 'broken' }],
  }));
  assert.deepStrictEqual(toolPacks.listToolPacks().map(p => p.id), ['pro-a']);
  assert.ok(logged.some(l => l.includes('pro-test') && l.includes('rejected')));
  addons.removeAddon('pro-test');
  assert.deepStrictEqual(toolPacks.listToolPacks(), []);

  const { createAddonCtx } = require('../src/addon-host');
  const ctx = createAddonCtx({ dataHome: HOME, dashboard: { broadcaster: { broadcast() {} }, store, cliSessionManager: {} } });
  const off = ctx.registerToolPack({ id: 'ctx-pack', roles: ['worker'], default: true, build });
  assert.deepStrictEqual(ctx.listToolPacks().map(p => p.id), ['ctx-pack']);
  off();
  assert.deepStrictEqual(ctx.listToolPacks(), []);
  assert.strictEqual(createAddonCtx({ dataHome: HOME }).registerToolPack, undefined, 'headless profile has none');
});

// --- consumes / validate / release ---

test('registerToolPack checks consumes, validate and release; consumedGrants follows the registered packs', () => {
  clearPacks();
  const build = () => ({});
  assert.throws(() => toolPacks.registerToolPack({ id: 'x', build, consumes: 'tools' }), /consumes/);
  assert.throws(() => toolPacks.registerToolPack({ id: 'x', build, consumes: ['apps'] }), /consumes/);
  assert.throws(() => toolPacks.registerToolPack({ id: 'x', build, validate: true }), /validate must be a function/);
  assert.throws(() => toolPacks.registerToolPack({ id: 'x', build, release: 'later' }), /release must be a function/);
  assert.deepStrictEqual(toolPacks.consumedGrants(), []);
  const off = toolPacks.registerToolPack({ id: 'apps', roles: ['worker'], default: true, consumes: ['tools'], build });
  toolPacks.registerToolPack({ id: 'other', build, consumes: [] });
  assert.deepStrictEqual(toolPacks.consumedGrants(), ['tools']);
  assert.strictEqual(toolPacks.grantConsumed(WORKER, 'tools'), true);
  assert.strictEqual(toolPacks.grantConsumed(PLAIN, 'tools'), false, 'not a pack of that role');
  assert.deepStrictEqual(toolPacks.listToolPacks().map(p => Object.keys(p)), [['id', 'description', 'roles', 'default'], ['id', 'description', 'roles', 'default']], 'listing unchanged');
  off();
  assert.deepStrictEqual(toolPacks.consumedGrants(), []);
  assert.deepStrictEqual(toolPacks.TOOL_PACK_FEATURES, ['consumes', 'validate', 'release']);
  assert.ok(Object.isFrozen(toolPacks.TOOL_PACK_FEATURES));
});

test('validate: each applying pack may refuse, synchronously; others are not asked', () => {
  clearPacks();
  const seen = [];
  toolPacks.registerToolPack({ id: 'ok', roles: ['worker'], default: true, build: () => ({}), validate: (c) => { seen.push(c); } });
  toolPacks.registerToolPack({ id: 'plain-only', roles: ['plain'], default: true, build: () => ({}), validate: () => { throw new Error('never asked'); } });
  assert.doesNotThrow(() => toolPacks.validateToolPacks({ settings: { ...WORKER, grants: { tools: ['a__b'] } } }));
  assert.deepStrictEqual(seen, [{ settings: { ...WORKER, grants: { tools: ['a__b'] } }, role: 'worker' }]);
  toolPacks.registerToolPack({ id: 'no', roles: ['worker'], default: true, build: () => ({}), validate: ({ settings }) => { if (settings.grants) throw new Error('unknown tool a__b'); } });
  assert.throws(() => toolPacks.validateToolPacks({ settings: { ...WORKER, grants: { tools: ['a__b'] } } }), /^Error: unknown tool a__b$/);
  assert.doesNotThrow(() => toolPacks.validateToolPacks({ settings: WORKER }));
  toolPacks.registerToolPack({ id: 'async', roles: ['worker'], default: true, build: () => ({}), validate: async () => {} });
  assert.throws(() => toolPacks.validateToolPacks({ settings: WORKER }), /validate returned a promise/);
  clearPacks();
});

test('a CLI session: build on every spawn, release once per spawn with its reason', () => {
  clearPacks();
  const builds = [];
  const releases = [];
  toolPacks.registerToolPack({
    id: 'minted', roles: ['worker'], default: true,
    build: (c) => { builds.push(c.sessId); return { appendSystemPrompt: `TOKEN ${builds.length}` }; },
    release: (c) => releases.push(c),
  });
  toolPacks.registerToolPack({ id: 'broken', roles: ['worker'], default: true, build: () => { throw new Error('x'); }, release: () => releases.push('broken') });
  const cli = new CliSession(9999, { broadcast() {} }, store, { authToken: 'tok', dashboardPort: 4321 });
  cli.updateSettings({ ...WORKER, grants: { tools: ['a__b'] } });
  quietly(() => cli.spawn(HOME, 80, 24, {}));
  const first = cli.sessId;
  // A resume of the same session: built again, the previous spawn released.
  quietly(() => cli.spawn(HOME, 80, 24, { resumeSessionId: first }));
  assert.deepStrictEqual(builds, [first, first]);
  assert.deepStrictEqual(releases.map(r => r.reason), ['respawn']);
  assert.deepStrictEqual(releases[0], { settings: cli.getSettings(), instanceId: `cli-${first}`, role: 'worker', sessId: first, reason: 'respawn' });
  assert.match(ptySpawns.at(-1).args.join(' '), /TOKEN 2/);
  // Closed (a pause): released once; the pty's own exit afterwards adds nothing.
  const pty = ptySpawns.at(-1).pty;
  cli.kill('pause');
  pty.exit({ exitCode: 0 });
  cli.kill();
  assert.deepStrictEqual(releases.map(r => r.reason), ['respawn', 'pause']);
  // A process that ends by itself: 'exit'.
  quietly(() => cli.spawn(HOME, 80, 24, {}));
  ptySpawns.at(-1).pty.exit({ exitCode: 0 });
  cli.kill();
  assert.deepStrictEqual(releases.map(r => r.reason), ['respawn', 'pause', 'exit']);
  assert.ok(!releases.includes('broken'), 'a pack whose build failed is not released');
  clearPacks();
});

test('release errors are logged, never thrown, a rejected promise too', async () => {
  clearPacks();
  toolPacks.registerToolPack({ id: 'boom', roles: ['plain'], default: true, build: () => ({}), release: () => { throw new Error('gone'); } });
  toolPacks.registerToolPack({ id: 'async', roles: ['plain'], default: true, build: () => ({}), release: async () => { throw new Error('later'); } });
  const c = toolPacks.toolPackContributions({ settings: PLAIN, instanceId: 'cli-1', sessId: 's1' });
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    toolPacks.releaseToolPacks(c, 'tab_close');
    await new Promise(r => setTimeout(r, 5));
  } finally { console.error = orig; }
  assert.ok(logged.some(l => l.includes('"boom"') && l.includes('gone')));
  assert.ok(logged.some(l => l.includes('"async"') && l.includes('later')));
  assert.doesNotThrow(() => toolPacks.releaseToolPacks(c, 'again'));
  assert.doesNotThrow(() => toolPacks.releaseToolPacks(null, 'x'));
  clearPacks();
});

test('the manager: an SDK session is released with the reason of its end', async () => {
  clearPacks();
  const releases = [];
  toolPacks.registerToolPack({ id: 'r', default: true, build: () => ({}), release: (c) => releases.push(c.reason) });
  const CliSessionManager = require('../src/cli-sessions');
  const sdk = { query: () => ({ [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return: async () => ({ done: true }), close() {} }) };
  const mgr = new CliSessionManager(9999, { broadcast() {} }, store, { sdk, claudeBin: '/opt/claude' });
  const open = () => { const tabId = mgr.nextTabId(); mgr.launchSession(tabId, { cwd: HOME, settings: { engine: 'sdk' } }); return tabId; };
  mgr.closeQuiet(open(), 'close_worker');
  mgr.remove(open());
  mgr.kill(open());
  await new Promise(r => setTimeout(r, 20));
  assert.deepStrictEqual(releases, ['close_worker', 'tab_close', 'kill']);
  clearPacks();
});

test('the add-on ctx: toolPackFeatures and sendToSession in the dashboard profile only', () => {
  const { createAddonCtx } = require('../src/addon-host');
  const sent = [];
  const ctx = createAddonCtx({ dataHome: HOME, dashboard: { broadcaster: { broadcast() {} }, store, cliSessionManager: {}, sendToSession: (...a) => { sent.push(a); return { delivered: true, how: 'submitted' }; } } });
  assert.deepStrictEqual(ctx.toolPackFeatures, ['consumes', 'validate', 'release']);
  assert.ok(Object.isFrozen(ctx.toolPackFeatures));
  assert.deepStrictEqual(ctx.sendToSession('orch-x-w1', 'job done', { from: 'apps' }), { delivered: true, how: 'submitted' });
  assert.deepStrictEqual(sent, [['orch-x-w1', 'job done', { from: 'apps' }]]);
  const headless = createAddonCtx({ dataHome: HOME });
  assert.strictEqual(headless.toolPackFeatures, undefined);
  assert.strictEqual(headless.sendToSession, undefined);
  assert.strictEqual(ctx.contractVersion, 2);
});
