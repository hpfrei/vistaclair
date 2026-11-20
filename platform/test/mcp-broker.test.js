// MCP broker (phase 2): the platform tool union served as a dynamic, scoped
// MCP server. Covers session mint/expiry, name validation, collision
// namespacing, scoping, spend attribution (origin 'mcp') and side-effect
// routing (a governed-kind tool comes back "staged" at the default dial, not
// executed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeAppsDir } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const appTools = require('../src/apps/app-tools');
const spendContext = require('../src/apps/spend-context');
const governance = require('../src/apps/governance/horst-governance');
const broker = require('../src/apps/mcp-broker');

const appsDir = makeAppsDir({ 'cam-app': {}, 'mail-app': {} });
appManager.setAppsDir(appsDir);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-mcp-'));

// Governance with a propose-pinned platform kind whose executor records runs —
// the broker's side-effect gate must stage it, never run it, at default dial.
let kindRuns = 0;
governance.registerPlatformKinds({
  'telegram.send': {
    label: 'Send Telegram',
    ceiling: 'propose',
    defaultLevel: 'propose',
    appProposable: true, // as the real kind: an app (here its governed tool) may stage it
    validate(p) { if (!p || !p.text) throw new Error('text required'); },
    describe: (p) => `Send Telegram: ${p.text}`,
    execute: () => { kindRuns++; return { ok: true, summary: 'sent' }; },
  },
});
governance.init({ dir: path.join(tmp, 'gov') });
broker.init({ dir: path.join(tmp, 'broker') });

// Two apps sharing a tool name (collision namespacing), a self-only tool
// (must never enter the catalog), and a governed-kind-named tool.
let snapshotCalls = [];
appTools.registerAppTools('cam-app', [
  { name: 'camera_snapshot', description: 'Take a webcam snapshot picture from the camera', expose: 'platform' },
  { name: 'server_status', description: 'Camera server health', expose: 'platform' },
  { name: 'secret_tool', description: 'internal only', expose: 'self' },
]);
appTools.registerAppToolHandler('cam-app', 'camera_snapshot', async (args) => {
  snapshotCalls.push({ args, origin: spendContext.origin(), principal: spendContext.principal(), subscribed: spendContext.subscribed(), app: spendContext.app() });
  return { ok: true, photo: 'x.jpg' };
});
appTools.registerAppToolHandler('cam-app', 'server_status', async () => 'up');
appTools.registerAppTools('mail-app', [
  { name: 'server_status', description: 'Mail server health', expose: 'apps' },
  { name: 'telegram.send', description: 'Send a telegram message to the owner', expose: 'platform' },
]);
appTools.registerAppToolHandler('mail-app', 'server_status', async () => 'up');
appTools.registerAppToolHandler('mail-app', 'telegram.send', async () => { throw new Error('handler must never run for a governed kind'); });

test.after(() => {
  fs.rmSync(appsDir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const textOf = (r) => r.result.content.map((c) => c.text).join('\n');

test('initialize negotiates the protocol and identifies the server', async () => {
  const r = await broker.handleMessage(null, rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't' } }));
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.equal(r.result.serverInfo.name, 'vistaclair');
  assert.ok(r.result.capabilities.tools);
  const unknown = await broker.handleMessage(null, rpc('initialize', { protocolVersion: '1900-01-01' }));
  assert.match(unknown.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(await broker.handleMessage(null, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('the owner catalog is the collision-namespaced platform union (self tools excluded)', async () => {
  const r = await broker.handleMessage(null, rpc('tools/list'));
  const names = r.result.tools.map((t) => t.name);
  assert.ok(names.includes('cam-app__camera_snapshot'));
  assert.ok(names.includes('cam-app__server_status'));
  assert.ok(names.includes('mail-app__server_status'), 'apps-exposed tools are broker-visible too');
  assert.ok(names.includes('mail-app__telegram.send'));
  assert.ok(!names.includes('cam-app__secret_tool'), 'self tools never enter the catalog');
  assert.ok(!names.some((n) => n.includes('secret_tool')));
});

test('session mint validates explicit tool names against the union', () => {
  assert.throws(() => broker.createSession({ tools: ['cam-app__camera_snapshot', 'nope__missing'] }), /unknown tool\(s\): nope__missing/);
  const s = broker.createSession({ tools: ['cam-app__camera_snapshot'] });
  assert.equal(s.url, `/pro/mcp/s/${s.id}`);
  assert.match(s.token, /^[a-f0-9]{48}$/);
  assert.deepEqual(s.tools, ['cam-app__camera_snapshot']);
  assert.equal(s.selection, 'explicit');
  assert.ok(s.expiresAt > Date.now());
  broker.revokeSession(s.id);
});

test('task-based selection proposes a relevant subset; no match falls back to the full union', () => {
  const picked = broker.selectToolsForTask('take a webcam snapshot picture');
  assert.ok(picked.includes('cam-app__camera_snapshot'));
  assert.ok(!picked.includes('mail-app__telegram.send'));

  const s = broker.createSession({ task: 'take a webcam snapshot picture' });
  assert.equal(s.selection, 'task');
  assert.ok(s.tools.includes('cam-app__camera_snapshot'));
  broker.revokeSession(s.id);

  const all = broker.createSession({ task: 'zzzz qqqq xxxx' });
  assert.equal(all.selection, 'all');
  assert.ok(all.tools.includes('mail-app__server_status'));
  broker.revokeSession(all.id);
});

test('a scoped session serves exactly its tools and rejects the rest', async () => {
  const s = broker.createSession({ tools: ['cam-app__camera_snapshot'] });
  const list = await broker.handleMessage(s.id, rpc('tools/list'));
  assert.deepEqual(list.result.tools.map((t) => t.name), ['cam-app__camera_snapshot']);
  const denied = await broker.handleMessage(s.id, rpc('tools/call', { name: 'cam-app__server_status', arguments: {} }));
  assert.equal(denied.result.isError, true);
  assert.match(textOf(denied), /not served by this session/);
  broker.revokeSession(s.id);
});

test('a read-only call routes through the bridge with full spend attribution (origin mcp, owner-class)', async () => {
  snapshotCalls = [];
  const r = await broker.handleMessage(null, rpc('tools/call', { name: 'cam-app__camera_snapshot', arguments: { zoom: 2 } }));
  assert.ok(!r.result.isError);
  assert.deepEqual(JSON.parse(textOf(r)), { ok: true, photo: 'x.jpg' });
  assert.equal(snapshotCalls.length, 1);
  assert.deepEqual(snapshotCalls[0].args, { zoom: 2 });
  assert.equal(snapshotCalls[0].origin, 'mcp');
  assert.equal(snapshotCalls[0].principal, 'owner');
  assert.equal(snapshotCalls[0].subscribed, true);
  assert.equal(snapshotCalls[0].app, 'cam-app');
});

test('a governed-kind tool is staged for approval at the default dial, never executed', async () => {
  const r = await broker.handleMessage(null, rpc('tools/call', { name: 'mail-app__telegram.send', arguments: { text: 'hello' } }));
  assert.ok(!r.result.isError, 'staging is a result, not a tool error');
  assert.match(textOf(r), /Staged for approval: p-/);
  assert.equal(kindRuns, 0, 'the kind executor must not run');
  const pending = governance.listProposals({ status: 'pending', kind: 'telegram.send' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].origin, 'mcp');
  assert.equal(pending[0].payload.text, 'hello');

  // A payload the kind's validate() rejects surfaces as a tool error.
  const bad = await broker.handleMessage(null, rpc('tools/call', { name: 'mail-app__telegram.send', arguments: {} }));
  assert.equal(bad.result.isError, true);
  assert.match(textOf(bad), /text required/);
});

test('sessions persist across a restart and expire via the sweep (closed event fires)', async () => {
  const s = broker.createSession({ tools: ['cam-app__server_status'] });
  // Simulated restart: a fresh init loads the persisted index; the session
  // still answers (GUI-reload resilience — no orphaned consumers).
  broker.init({ dir: path.join(tmp, 'broker') });
  const list = await broker.handleMessage(s.id, rpc('tools/list'));
  assert.deepEqual(list.result.tools.map((t) => t.name), ['cam-app__server_status']);

  // Force the session past its TTL on disk, reload, and sweep.
  const file = path.join(tmp, 'broker', 'sessions.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  const soon = Date.now() + 40;
  stored.sessions = stored.sessions.map((x) => (x.id === s.id ? { ...x, expiresAt: soon } : x));
  fs.writeFileSync(file, JSON.stringify(stored));
  broker.init({ dir: path.join(tmp, 'broker') });
  const events = [];
  const off = broker.onSessionEvent((ev) => events.push(ev));
  await new Promise((r) => setTimeout(r, 60));
  broker.sweep();
  off();
  assert.ok(events.some((e) => e.event === 'closed' && e.session.id === s.id));
  assert.ok(!broker.listSessions().some((x) => x.id === s.id));
  const gone = await broker.handleMessage(s.id, rpc('tools/list'));
  assert.equal(gone.error.code, -32000);
});

test('revoking a session emits closed and the list stays reload-safe', () => {
  const s = broker.createSession({});
  assert.ok(broker.listSessions().some((x) => x.id === s.id && x.tools === null));
  const events = [];
  const off = broker.onSessionEvent((ev) => events.push(ev));
  assert.equal(broker.revokeSession(s.id), true);
  off();
  assert.deepEqual(events.map((e) => e.event), ['closed']);
  assert.equal(broker.revokeSession(s.id), false);
});

test('the __platform__ sessions tool is read-only and lists live sessions', async () => {
  const s = broker.createSession({ task: 'watch the camera snapshot' });
  assert.match(broker.sessionsTool.def.description, /^Read-only/);
  const out = await broker.sessionsTool.handler({});
  assert.ok(out.sessions.some((x) => x.id === s.id && x.task === 'watch the camera snapshot'));
  broker.revokeSession(s.id);
});

test('unknown methods and malformed messages get JSON-RPC errors', async () => {
  const nf = await broker.handleMessage(null, rpc('resources/list'));
  assert.equal(nf.error.code, -32601);
  const bad = await broker.handleMessage(null, { jsonrpc: '2.0', id: 9 });
  assert.equal(bad.error.code, -32600);
  const noName = await broker.handleMessage(null, rpc('tools/call', {}));
  assert.equal(noName.error.code, -32602);
});

test('the governed-kind branch authorizes through authorizeToolCall exactly once, with the session caller', async () => {
  const orig = appTools.authorizeToolCall;
  const seen = [];
  appTools.authorizeToolCall = (caller, name, target) => { seen.push({ caller, name, target }); return orig(caller, name, target); };
  try {
    const r = await broker.handleMessage(null, rpc('tools/call', { name: 'mail-app__telegram.send', arguments: { text: 'again' } }));
    assert.match(textOf(r), /Staged for approval/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].caller.type, 'platform');
    assert.deepEqual(seen[0].target, { app: 'mail-app', tool: 'telegram.send' });
    // A refusal there is a tool error and nothing is staged.
    appTools.authorizeToolCall = () => ({ allow: false, reason: 'refused by policy' });
    const before = governance.listProposals({ kind: 'telegram.send' }).length;
    const denied = await broker.handleMessage(null, rpc('tools/call', { name: 'mail-app__telegram.send', arguments: { text: 'no' } }));
    assert.equal(denied.result.isError, true);
    assert.match(textOf(denied), /refused by policy/);
    assert.equal(governance.listProposals({ kind: 'telegram.send' }).length, before);
  } finally { appTools.authorizeToolCall = orig; }
});
