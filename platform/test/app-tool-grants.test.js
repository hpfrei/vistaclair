// App tools for orchestration runs: broker holder sessions (strict grant
// scope, catalog mode, no TTL, release, orphan sweep), the two tool packs
// (app-tool-packs.js) and the one authorization choke point
// (app-tools.authorizeToolCall) with its typed caller.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeAppsDir } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const appTools = require('../src/apps/app-tools');
const spendContext = require('../src/apps/spend-context');
const broker = require('../src/apps/mcp-broker');
const packs = require('../src/apps/app-tool-packs');

const appsDir = makeAppsDir({ 'cam-app': {}, 'mail-app': {} });
appManager.setAppsDir(appsDir);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-grants-'));
broker.init({ dir: path.join(tmp, 'broker') });

const calls = [];
appTools.registerAppTools('cam-app', [
  { name: 'camera_snapshot', description: 'Take a webcam snapshot picture from the camera. Returns a photo path.', expose: 'platform' },
  { name: 'server_status', description: 'Camera server health', expose: 'platform' },
  { name: 'clip_export', description: 'Export a video clip as a resource', expose: 'platform' },
]);
appTools.registerAppToolHandler('cam-app', 'camera_snapshot', async (args, caller) => {
  calls.push({ tool: 'camera_snapshot', caller, spendCaller: spendContext.caller() });
  return { ok: true, photo: 'x.jpg' };
});
appTools.registerAppToolHandler('cam-app', 'server_status', async () => 'up');
appTools.registerAppToolHandler('cam-app', 'clip_export', async () => ({
  content: [
    { type: 'resource_link', uri: 'vc-artifact://a1', name: 'clip.mp4', mimeType: 'video/mp4' },
    { type: 'image', data: 'aGk=', mimeType: 'image/png' },
    { type: 'audio', data: 'aGk=', mimeType: 'audio/wav' },
    { type: 'resource', resource: { uri: 'vc-artifact://a2', text: 'x' } },
  ],
  structuredContent: { jobId: 'j-1', artifacts: ['vc-artifact://a1'] },
  _meta: { k: 1 },
}));
appTools.registerAppTools('mail-app', [
  { name: 'mail_search', description: 'Search the mailbox for messages', expose: 'apps' },
]);
appTools.registerAppToolHandler('mail-app', 'mail_search', async (args, caller) => {
  calls.push({ tool: 'mail_search', caller });
  return { hits: [] };
});

test.after(() => {
  broker.setHolderLiveness(null);
  fs.rmSync(appsDir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
// A holder session's app tools (and catalog tools), without the platform
// built-ins (tool_job_*, artifact_*, sound_generate) listed beside them.
const BUILTIN = /^(tool_job_|artifact_|sound_generate$)/;
const listed = (r) => r.result.tools.filter((t) => !BUILTIN.test(t.name));
const textOf = (r) => r.result.content.map((c) => c.text).join('\n');
const worker = (instanceId, extra = {}) => ({ type: 'worker', runId: 'r1', address: 'orch-r1-w1', instanceId, workerId: 'w1', orchestrator: 'orch-r1', ...extra });
const orchestrator = (instanceId) => ({ type: 'orchestrator', runId: 'r1', address: 'orch-r1', instanceId });

// Wrap the choke point; every call through it is recorded.
function spyAuthorize() {
  const orig = appTools.authorizeToolCall;
  const seen = [];
  appTools.authorizeToolCall = (caller, name, target) => { seen.push({ caller, name, target }); return orig(caller, name, target); };
  return { seen, restore: () => { appTools.authorizeToolCall = orig; } };
}

test('a strict holder session with an empty grant lists no tools and refuses every call', async () => {
  const s = broker.createHolderSession({ holder: worker('cli-empty'), mode: 'grant', tools: [] });
  assert.deepEqual(s.tools, []);
  const list = await broker.handleMessage(s.id, rpc('tools/list'));
  assert.deepEqual(listed(list), []);
  const r = await broker.handleMessage(s.id, rpc('tools/call', { name: 'cam-app__server_status', arguments: {} }));
  assert.equal(r.result.isError, true);
  assert.match(textOf(r), /not served by this session/);
  assert.throws(() => broker.createHolderSession({ holder: worker('cli-x'), mode: 'grant' }), /needs a tools list/);
  broker.revokeSession(s.id);
});

test('a worker grant lists and allows exactly its tools, carrying the holder identity to the handler', async () => {
  calls.length = 0;
  const s = broker.createHolderSession({ holder: worker('cli-w1'), mode: 'grant', tools: ['cam-app__camera_snapshot'] });
  const list = await broker.handleMessage(s.id, rpc('tools/list'));
  assert.deepEqual(listed(list).map((t) => t.name), ['cam-app__camera_snapshot']);

  const ok = await broker.handleMessage(s.id, rpc('tools/call', { name: 'cam-app__camera_snapshot', arguments: {} }));
  assert.ok(!ok.result.isError);
  const c = calls.find((x) => x.tool === 'camera_snapshot');
  assert.equal(c.caller.type, 'worker');
  assert.equal(c.caller.runId, 'r1');
  assert.equal(c.caller.address, 'orch-r1-w1');
  assert.equal(c.caller.workerId, 'w1');
  assert.equal(c.caller.orchestrator, 'orch-r1');
  assert.deepEqual(c.spendCaller, { type: 'worker', appName: null, runId: 'r1', address: 'orch-r1-w1', workerId: 'w1', orchestrator: 'orch-r1' });
  const audit = appTools.getToolAudit(1)[0];
  assert.equal(audit.callerType, 'worker');
  assert.equal(audit.caller.address, 'orch-r1-w1');

  const denied = await broker.handleMessage(s.id, rpc('tools/call', { name: 'cam-app__server_status', arguments: {} }));
  assert.equal(denied.result.isError, true);
  assert.match(textOf(denied), /not served by this session/);
  broker.revokeSession(s.id);
});

test('the choke point refuses a holder call outside its scope even past the broker list', () => {
  const target = { app: 'cam-app', tool: 'server_status' };
  const w = { ...worker('cli-z'), scope: ['cam-app__camera_snapshot'] };
  assert.deepEqual(appTools.authorizeToolCall(w, 'cam-app__server_status', target), { allow: false, reason: 'Tool "cam-app__server_status" is not granted to this worker' });
  assert.equal(appTools.authorizeToolCall({ ...w, scope: undefined }, 'cam-app__server_status', target).allow, false, 'a worker without a scope holds nothing');
  assert.equal(appTools.authorizeToolCall({ ...orchestrator('cli-o'), scope: null }, 'cam-app__server_status', target).allow, true);
  assert.equal(appTools.authorizeToolCall({ type: 'platform' }, 'cam-app__server_status', target).allow, true);
  assert.equal(appTools.authorizeToolCall({ type: 'app', appName: 'mail-app' }, 'cam-app__server_status', target).allow, false, 'expose levels unchanged');
});

test('holder sessions have no TTL, survive a restart and sit outside the owner cap', async () => {
  const s = broker.createHolderSession({ holder: worker('cli-keep'), mode: 'grant', tools: ['cam-app__server_status'] });
  assert.equal(broker.listSessions().find((x) => x.id === s.id).expiresAt, null);
  broker.init({ dir: path.join(tmp, 'broker') });
  broker.sweep();
  const list = await broker.handleMessage(s.id, rpc('tools/list'));
  assert.deepEqual(listed(list).map((t) => t.name), ['cam-app__server_status']);
  // 50 owner sessions still mint next to it, and the 51st is refused.
  const owned = [];
  for (let i = 0; i < 50; i++) owned.push(broker.createSession({ tools: ['cam-app__server_status'] }));
  assert.throws(() => broker.createSession({}), /cap 50/);
  const again = broker.createHolderSession({ holder: worker('cli-keep2'), mode: 'grant', tools: [] });
  for (const o of owned) broker.revokeSession(o.id);
  broker.revokeSession(again.id);
  broker.revokeSession(s.id);
});

test('the catalog session serves exactly the three catalog tools, to an orchestrator only', async () => {
  assert.throws(() => broker.createHolderSession({ holder: worker('cli-w'), mode: 'catalog' }), /only an orchestrator/);
  const s = broker.createHolderSession({ holder: orchestrator('cli-o1'), mode: 'catalog' });
  const list = await broker.handleMessage(s.id, rpc('tools/list'));
  assert.deepEqual(listed(list).map((t) => t.name), ['tools_search', 'tools_describe', 'tools_call']);
  const app = await broker.handleMessage(s.id, rpc('tools/call', { name: 'cam-app__server_status', arguments: {} }));
  assert.equal(app.result.isError, true, 'app tools are reached through tools_call only');

  const found = await broker.handleMessage(s.id, rpc('tools/call', { name: 'tools_search', arguments: { query: 'webcam snap' } }));
  const hits = found.result.structuredContent.tools;
  assert.equal(hits[0].name, 'cam-app__camera_snapshot');
  assert.deepEqual(Object.keys(hits[0]).sort(), ['app', 'contractHash', 'kind', 'name', 'sideEffects', 'summary']);
  assert.equal(hits[0].kind, 'call');
  assert.equal(hits[0].sideEffects, 'writes', 'an undeclared sideEffects reads as writes');
  assert.match(hits[0].contractHash, /^[0-9a-f]{64}$/);
  assert.equal(hits[0].summary, 'Take a webcam snapshot picture from the camera.');
  const byApp = await broker.handleMessage(s.id, rpc('tools/call', { name: 'tools_search', arguments: { app: 'mail-app' } }));
  assert.deepEqual(byApp.result.structuredContent.tools.map((t) => t.name), ['mail-app__mail_search']);

  calls.length = 0;
  const called = await broker.handleMessage(s.id, rpc('tools/call', { name: 'tools_call', arguments: { name: 'mail-app__mail_search', args: { q: 'x' } } }));
  assert.deepEqual(JSON.parse(textOf(called)), { hits: [] });
  assert.equal(calls[0].caller.type, 'orchestrator');
  assert.equal(calls[0].caller.address, 'orch-r1');
  broker.revokeSession(s.id);
});

test('tools_describe passes through every field the registry holds, unknown ones included', () => {
  const def = appTools.getToolsForApp('cam-app').find((t) => t.name === 'clip_export');
  def.contract = { kind: 'job', sideEffect: 'none', artifactsOut: ['video/mp4'] };
  try {
    const out = broker.describeTools({ names: ['cam-app__clip_export', 'nope__x'] });
    const rec = out.tools[0];
    assert.equal(rec.name, 'cam-app__clip_export');
    assert.equal(rec.app, 'cam-app');
    assert.equal(rec.tool, 'clip_export');
    assert.deepEqual(rec.inputSchema, { type: 'object', properties: {} });
    assert.deepEqual(rec.contract, def.contract);
    assert.equal(rec.expose, 'platform');
    assert.ok(!('_ownerApp' in rec));
    assert.deepEqual(out.unknown, ['nope__x']);
  } finally { delete def.contract; }
});

test('non-text content blocks, structuredContent and _meta pass through the broker unchanged', async () => {
  const s = broker.createHolderSession({ holder: worker('cli-blocks'), mode: 'grant', tools: ['cam-app__clip_export'] });
  const r = await broker.handleMessage(s.id, rpc('tools/call', { name: 'cam-app__clip_export', arguments: {} }));
  assert.deepEqual(r.result, await appTools.callAppToolHandler('cam-app', 'clip_export', {}, { type: 'platform' }));
  assert.deepEqual(r.result.content.map((c) => c.type), ['resource_link', 'image', 'audio', 'resource']);
  assert.deepEqual(r.result.structuredContent, { jobId: 'j-1', artifacts: ['vc-artifact://a1'] });
  broker.revokeSession(s.id);
});

test('ctx.tools.call and broker calls of every kind go through authorizeToolCall with the typed caller', async () => {
  const spy = spyAuthorize();
  try {
    await appTools.callCrossAppTool('cam-app', 'mail-app', 'mail_search', {});
    assert.deepEqual(spy.seen.at(-1).caller, { type: 'app', appName: 'cam-app' });
    assert.equal(spy.seen.at(-1).name, 'mail-app__mail_search');

    await broker.handleMessage(null, rpc('tools/call', { name: 'cam-app__server_status', arguments: {} }));
    assert.equal(spy.seen.at(-1).caller.type, 'platform');

    const g = broker.createHolderSession({ holder: worker('cli-spy'), mode: 'grant', tools: ['cam-app__server_status'] });
    const before = spy.seen.length;
    await broker.handleMessage(g.id, rpc('tools/call', { name: 'cam-app__server_status', arguments: {} }));
    assert.equal(spy.seen.length, before + 1, 'exactly one authorization per call');
    const c = spy.seen.at(-1).caller;
    assert.equal(c.type, 'worker');
    assert.equal(c.runId, 'r1');
    assert.equal(c.address, 'orch-r1-w1');
    assert.deepEqual(c.scope, ['cam-app__server_status']);
    broker.revokeSession(g.id);
  } finally { spy.restore(); }
});

// ---- the packs ------------------------------------------------------------

const workerSettings = (tools) => ({ name: 'orch-r1-w1', orchestration: { runId: 'r1', role: 'worker', workerId: 'w1', orchestrator: 'orch-r1' }, grants: { tools } });
const orchSettings = { name: 'orch-r1', orchestration: { runId: 'r1', role: 'orchestrator' } };

test('register feature-probes the core: catalog with registerToolPack, grant only with consumes/validate/release', () => {
  const reg = [];
  const ctx = (features) => ({ registerToolPack: (p) => { reg.push(p); return () => {}; }, toolPackFeatures: features, dashboardPort: 4000 });
  const orig = console.warn; console.warn = () => {};
  try {
    assert.deepEqual(packs.register({}), []);
    assert.deepEqual(packs.register(ctx(undefined)), [packs.CATALOG_PACK]);
    assert.deepEqual(packs.register(ctx(['consumes', 'validate'])), [packs.CATALOG_PACK]);
    assert.deepEqual(packs.register(ctx(['consumes', 'validate', 'release'])), [packs.CATALOG_PACK, packs.GRANT_PACK]);
  } finally { console.warn = orig; packs.unregister(); broker.setHolderLiveness(null); }
  const catalog = reg.find((p) => p.id === packs.CATALOG_PACK);
  const grant = reg.find((p) => p.id === packs.GRANT_PACK);
  assert.deepEqual(catalog.roles, ['orchestrator']);
  assert.equal(catalog.default, true);
  assert.deepEqual(grant.roles, ['worker']);
  assert.deepEqual(grant.consumes, ['tools']);
  assert.ok(!reg.some((p) => p.roles.includes('plain')), 'plain sessions get no pack');
});

test('the catalog pack mounts app-tools for an orchestrator and releases it', async () => {
  const { catalog } = packs.createPacks({ dashboardPort: 4000 });
  assert.equal(catalog.build({ settings: workerSettings([]), instanceId: 'cli-w', role: 'worker' }), null);
  const out = catalog.build({ settings: orchSettings, instanceId: 'cli-orch', role: 'orchestrator' });
  const srv = out.mcpServers['app-tools'];
  assert.equal(srv.type, 'http');
  assert.match(srv.url, /^http:\/\/127\.0\.0\.1:4000\/pro\/mcp\/s\/s-[a-z0-9]+$/);
  assert.match(srv.headers.Authorization, /^Bearer [a-f0-9]{48}$/);
  assert.match(out.appendSystemPrompt, /launch_cli/);
  assert.match(out.appendSystemPrompt, /resume_worker/);
  const held = broker.listSessions().filter((s) => s.holder && s.holder.instanceId === 'cli-orch');
  assert.equal(held.length, 1);
  assert.equal(held[0].mode, 'catalog');
  catalog.release({ settings: orchSettings, instanceId: 'cli-orch', role: 'orchestrator', reason: 'exit' });
  assert.ok(!broker.listSessions().some((s) => s.holder && s.holder.instanceId === 'cli-orch'));
});

test('the grant pack validates names, serves the grant, re-mints per spawn and release revokes', async () => {
  const { grant } = packs.createPacks({ dashboardPort: 4000 });
  assert.doesNotThrow(() => grant.validate({ settings: workerSettings(['cam-app__camera_snapshot']), role: 'worker' }));
  assert.doesNotThrow(() => grant.validate({ settings: {}, role: 'worker' }));
  assert.throws(
    () => grant.validate({ settings: workerSettings(['cam-app__camera_snapshot', 'cam-app__camera_snapshott', 'zzz__qqq']), role: 'worker' }),
    (e) => /Unknown app tool\(s\): cam-app__camera_snapshott \(did you mean cam-app__camera_snapshot\?\); zzz__qqq\./.test(e.message),
  );
  assert.throws(() => grant.validate({ settings: workerSettings([42]), role: 'worker' }), /must be a tool name/);

  assert.deepEqual(grant.build({ settings: workerSettings([]), instanceId: 'cli-g', role: 'worker' }), {}, 'no grant, no server');
  assert.deepEqual(grant.build({ settings: { name: 'w', orchestration: { role: 'worker', runId: 'r1' } }, instanceId: 'cli-g', role: 'worker' }), {});
  const first = grant.build({ settings: workerSettings(['cam-app__camera_snapshot']), instanceId: 'cli-g', role: 'worker' });
  const srv = first.mcpServers.apps;
  assert.equal(srv.type, 'http');
  assert.match(first.appendSystemPrompt, /`cam-app__camera_snapshot` — Take a webcam snapshot picture from the camera\./);
  assert.match(first.appendSystemPrompt, /report blocked/);
  const firstId = srv.url.split('/').pop();
  const list = await broker.handleMessage(firstId, rpc('tools/list'));
  assert.deepEqual(listed(list).map((t) => t.name), ['cam-app__camera_snapshot']);

  // A resume re-mints; the earlier session is gone.
  const second = grant.build({ settings: workerSettings(['cam-app__camera_snapshot', 'cam-app__server_status']), instanceId: 'cli-g', role: 'worker' });
  const secondId = second.mcpServers.apps.url.split('/').pop();
  assert.notEqual(secondId, firstId);
  assert.equal((await broker.handleMessage(firstId, rpc('tools/list'))).error.code, -32000);
  assert.equal(listed(await broker.handleMessage(secondId, rpc('tools/list'))).length, 2);

  grant.release({ settings: workerSettings([]), instanceId: 'cli-g', role: 'worker', reason: 'exit' });
  assert.equal((await broker.handleMessage(secondId, rpc('tools/list'))).error.code, -32000);
});

test('the orphan sweep revokes holder sessions whose session no longer runs', () => {
  const live = broker.createHolderSession({ holder: worker('cli-live'), mode: 'grant', tools: [] });
  const dead = broker.createHolderSession({ holder: worker('cli-dead'), mode: 'grant', tools: [] });
  const owner = broker.createSession({});
  // Age both past the mint grace, on disk, and reload.
  const file = path.join(tmp, 'broker', 'sessions.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.sessions = stored.sessions.map((x) => (x.holder ? { ...x, createdAt: Date.now() - 10 * 60 * 1000 } : x));
  fs.writeFileSync(file, JSON.stringify(stored));
  broker.init({ dir: path.join(tmp, 'broker') });

  const manager = { sessions: new Map([['tab-1', { instanceId: 'cli-live', running: true }]]) };
  broker.setHolderLiveness(packs.livenessFrom(manager));
  assert.equal(broker.sweepOrphans(), 1);
  const ids = broker.listSessions().map((s) => s.id);
  assert.ok(ids.includes(live.id));
  assert.ok(!ids.includes(dead.id));
  assert.ok(ids.includes(owner.id), 'owner sessions are not the sweep\'s business');

  // An unknown answer (no session manager) keeps everything.
  broker.setHolderLiveness(packs.livenessFrom(null));
  assert.equal(broker.sweepOrphans(), 0);
  broker.setHolderLiveness(null);
  broker.revokeSession(live.id);
  broker.revokeSession(owner.id);
});
