// Job-kind app tools (app-tool-jobs.js): inline answers inside `_wait`, job
// ids beyond it, delivery into the calling session (fallback to the
// orchestrator, retry queue), ask / reply, cancel, timeout, the boot sweep,
// app callers (durable onJobDone, callAndWait), the broker's built-in tools
// and their `when`, currentCall, the holder cwd, the artifact wiring (refs in
// args grant the target app, the artifact built-ins) — and quick tools unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeAppsDir } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const appJobs = require('../src/apps/app-jobs');
const appTools = require('../src/apps/app-tools');
const jobs = require('../src/apps/app-tool-jobs');
const broker = require('../src/apps/mcp-broker');
const packs = require('../src/apps/app-tool-packs');
const toolsCap = require('../src/apps/capabilities/tools');
const art = require('../src/apps/app-artifacts');

const appsDir = makeAppsDir({ 'render-app': {}, 'caller-app': {} });
appManager.setAppsDir(appsDir);
appJobs.init({ appsDir });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-tooljobs-'));
broker.init({ dir: path.join(tmp, 'broker') });
art.init({ dir: path.join(tmp, 'artifacts') });

// The stubbed core ctx.sendToSession: every message, and who is reachable.
const sent = [];
let reachable = () => true;
const sendToSession = (address, text, opts) => {
  sent.push({ address, text, from: opts && opts.from });
  return reachable(address) ? { delivered: true, how: 'submitted' } : { delivered: false, how: 'not running' };
};
const boot = () => jobs.init({ dataHome: tmp, sendToSession });
boot();

// Handlers park on a gate per `key` so a test decides when a job ends.
const gates = new Map();
function gate(key) {
  let open;
  const p = new Promise((r) => { open = r; });
  gates.set(key, { p, open });
  return (v) => open(v);
}
const seen = []; // { tool, args, caller, job, call }

appTools.registerAppTools('render-app', [
  { name: 'render', description: 'Render a scene to a video file.', expose: 'apps', kind: 'job', returns: '{ file }' },
  { name: 'render_short', description: 'Render with a 60 ms limit.', expose: 'apps', kind: 'job', timeout: 60 },
  { name: 'status', description: 'Renderer status.', expose: 'apps' },
]);
appTools.registerAppToolHandler('render-app', 'render', async (args, caller, job) => {
  seen.push({ tool: 'render', args, caller, job, call: appTools.currentCall() });
  if (args.ask) {
    const answer = await job.ask(args.ask);
    return { content: [{ type: 'text', text: `answered ${answer}` }] };
  }
  if (args.note) job.notify(args.note);
  if (args.untilAbort) {
    await new Promise((resolve) => job.signal.addEventListener('abort', resolve));
    return 'never seen';
  }
  if (args.key) {
    const v = await gates.get(args.key).p;
    if (v instanceof Error) throw v;
    job.progress(100, 'done');
    return v;
  }
  return { content: [{ type: 'text', text: `rendered ${args.scene}` }] };
});
appTools.registerAppToolHandler('render-app', 'render_short', async (args, caller, job) => {
  seen.push({ tool: 'render_short', job });
  await new Promise((resolve) => job.signal.addEventListener('abort', resolve));
});
appTools.registerAppToolHandler('render-app', 'status', async (args, caller) => {
  seen.push({ tool: 'status', args, caller, call: appTools.currentCall() });
  return { up: true, args };
});

test.after(() => {
  jobs.shutdown();
  broker.setHolderLiveness(null);
  fs.rmSync(appsDir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const textOf = (r) => r.result.content.map((c) => c.text).join('\n');
const worker = (instanceId, runId = 'r1') => ({ type: 'worker', runId, address: `orch-${runId}-w1`, instanceId, workerId: 'w1', orchestrator: `orch-${runId}` });
const orchestrator = (instanceId, runId = 'r1') => ({ type: 'orchestrator', runId, address: `orch-${runId}`, instanceId });
const grantSession = (instanceId, tools, runId) => broker.createHolderSession({ holder: worker(instanceId, runId), mode: 'grant', tools });
const callVia = (s, name, args) => broker.handleMessage(s.id, rpc('tools/call', { name, arguments: args }));
async function until(fn, ms = 2000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const record = (id) => JSON.parse(fs.readFileSync(path.join(tmp, 'tool-jobs', `${id}.json`), 'utf8'));
const reset = () => { sent.length = 0; seen.length = 0; reachable = () => true; };

test('a job that ends inside _wait answers inline, like a quick tool; _wait never reaches the handler', async () => {
  reset();
  const s = grantSession('cli-inline', ['render-app__render']);
  const r = await callVia(s, 'render-app__render', { scene: 'a', _wait: 5 });
  assert.equal(r.result.isError, undefined);
  assert.equal(textOf(r), 'rendered a');
  assert.deepEqual(seen[0].args, { scene: 'a' });
  assert.equal(sent.length, 0, 'answered inline: no message');
  const id = seen[0].job.id;
  assert.match(id, /^tj_/);
  assert.equal(record(id).status, 'done');
  assert.equal(record(id).delivered, true);
  // It ran inside the provider's ctx.jobs.
  const appJob = appJobs.listJobs('render-app').find((j) => j.meta.toolJobId === id);
  assert.equal(appJob.name, 'tool:render');
  assert.equal(appJob.meta.caller.address, 'orch-r1-w1');
  broker.revokeSession(s.id);
});

test('a slow job returns a jobId at once, then delivers the formatted outcome into the calling session', async () => {
  reset();
  const s = grantSession('cli-slow', ['render-app__render']);
  const open = gate('slow');
  const r = await callVia(s, 'render-app__render', { key: 'slow', _wait: 0 });
  const { jobId, status, tool } = r.result.structuredContent;
  assert.equal(status, 'running');
  assert.equal(tool, 'render-app__render');
  assert.equal(textOf(r), `Started ${jobId} (render-app__render); the result will arrive as a message.`);
  assert.equal(record(jobId).status, 'running');

  open({ content: [
    { type: 'text', text: 'x'.repeat(5000) },
    { type: 'resource_link', uri: 'vc-artifact://art_1', name: 'out.mp4', mimeType: 'video/mp4', size: 1234 },
  ] });
  await until(() => sent.length === 1);
  const m = sent[0];
  assert.equal(m.address, 'orch-r1-w1');
  assert.equal(m.from, 'tool-job');
  const lines = m.text.split('\n');
  assert.match(lines[0], new RegExp(`^${jobId} render-app__render done \\(\\d+s\\)$`));
  assert.ok(m.text.includes('x'.repeat(4000)) && !m.text.includes('x'.repeat(4001)), 'text capped at 4000');
  assert.match(m.text, /truncated: tool_job_status/);
  assert.equal(lines[lines.length - 1], '- vc-artifact://art_1 (video/mp4, 1234 bytes)');
  const rec = record(jobId);
  assert.equal(rec.status, 'done');
  assert.equal(rec.delivered, true);
  assert.equal(rec.principal, 'run:r1');
  assert.equal(rec.caller.address, 'orch-r1-w1');
  broker.revokeSession(s.id);
});

test('delivery falls back to the orchestrator, then queues and retries', async () => {
  reset();
  const s = grantSession('cli-fallback', ['render-app__render']);
  reachable = (a) => a === 'orch-r1';
  let open = gate('fb1');
  let r = await callVia(s, 'render-app__render', { key: 'fb1', _wait: 0 });
  open('first');
  await until(() => sent.length === 2);
  assert.deepEqual(sent.map((m) => m.address), ['orch-r1-w1', 'orch-r1']);
  assert.equal(record(r.result.structuredContent.jobId).delivered, true);

  reset();
  reachable = () => false;
  open = gate('fb2');
  r = await callVia(s, 'render-app__render', { key: 'fb2', _wait: 0 });
  const id = r.result.structuredContent.jobId;
  open('second');
  await until(() => sent.length === 2);
  assert.equal(record(id).delivered, false);
  assert.equal(record(id).status, 'done');
  reachable = () => true;
  jobs.retryUndelivered(); // the one-minute tick
  assert.equal(sent.length, 3);
  assert.equal(sent[2].address, 'orch-r1-w1');
  assert.match(sent[2].text, new RegExp(`^${id} render-app__render done`));
  assert.equal(record(id).delivered, true);
  jobs.retryUndelivered();
  assert.equal(sent.length, 3, 'delivered once');
  broker.revokeSession(s.id);
});

test('ask reaches the caller and tool_job_reply from another session of the run answers it; notify is a note', async () => {
  reset();
  const s = grantSession('cli-ask', ['render-app__render']);
  const orch = broker.createHolderSession({ holder: orchestrator('cli-ask-orch'), mode: 'catalog' });
  const r = await callVia(s, 'render-app__render', { ask: 'Which color?', _wait: 0 });
  const id = r.result.structuredContent.jobId;
  await until(() => sent.length === 1);
  assert.equal(sent[0].text, `${id} asks: Which color? (answer with tool_job_reply)`);
  assert.equal(record(id).pendingQuestion.text, 'Which color?');

  const status = await broker.handleMessage(orch.id, rpc('tools/call', { name: 'tool_job_status', arguments: { jobId: id } }));
  assert.match(textOf(status), /Asks: Which color\?/);
  const rep = await broker.handleMessage(orch.id, rpc('tools/call', { name: 'tool_job_reply', arguments: { jobId: id, text: 'blue' } }));
  assert.equal(rep.result.isError, undefined, textOf(rep));
  await until(() => sent.length === 2);
  assert.match(sent[1].text, new RegExp(`^${id} render-app__render done`));
  assert.match(sent[1].text, /answered blue/);
  assert.equal(record(id).pendingQuestion, null);

  const again = await broker.handleMessage(orch.id, rpc('tools/call', { name: 'tool_job_reply', arguments: { jobId: id, text: 'x' } }));
  assert.equal(again.result.isError, true);
  assert.match(textOf(again), /no pending question/);

  reset();
  const open = gate('note');
  const n = await callVia(s, 'render-app__render', { key: 'note', note: 'halfway', _wait: 0 });
  await until(() => sent.length === 1);
  assert.equal(sent[0].text, `${n.result.structuredContent.jobId} note: halfway`);
  open('ok');
  await until(() => sent.length === 2);
  broker.revokeSession(s.id);
  broker.revokeSession(orch.id);
});

test('tool_job_cancel aborts the handler signal; the outcome says cancelled', async () => {
  reset();
  const s = grantSession('cli-cancel', ['render-app__render']);
  const r = await callVia(s, 'render-app__render', { untilAbort: true, _wait: 0 });
  const id = r.result.structuredContent.jobId;
  const job = seen.find((x) => x.job.id === id).job;
  assert.equal(job.signal.aborted, false);
  const c = await callVia(s, 'tool_job_cancel', { jobId: id });
  assert.deepEqual(c.result.structuredContent, { ok: true, status: 'cancelled' });
  assert.equal(job.signal.aborted, true);
  assert.equal(record(id).status, 'cancelled');
  await until(() => sent.length === 1);
  assert.match(sent[0].text, new RegExp(`^${id} render-app__render cancelled`));
  const appJob = appJobs.listJobs('render-app').find((j) => j.meta.toolJobId === id);
  assert.equal(appJob.status, 'cancelled');
  broker.revokeSession(s.id);
});

test('a job past its timeout is cancelled with status error / "timed out"', async () => {
  reset();
  const s = grantSession('cli-timeout', ['render-app__render_short']);
  const r = await callVia(s, 'render-app__render_short', { _wait: 0 });
  const id = r.result.structuredContent.jobId;
  await until(() => sent.length === 1, 3000);
  const rec = record(id);
  assert.equal(rec.status, 'error');
  assert.equal(rec.error, 'timed out');
  assert.equal(seen.find((x) => x.tool === 'render_short').job.signal.aborted, true);
  assert.match(sent[0].text, /render_short error .*\nError: timed out/);
  broker.revokeSession(s.id);
});

test('the boot sweep turns a running job into interrupted and delivers it', async () => {
  reset();
  const s = grantSession('cli-boot', ['render-app__render']);
  gate('boot'); // never opened: the closure "dies" with the restart
  const r = await callVia(s, 'render-app__render', { key: 'boot', _wait: 0 });
  const id = r.result.structuredContent.jobId;
  assert.equal(record(id).status, 'running');
  boot(); // simulated restart
  const rec = record(id);
  assert.equal(rec.status, 'interrupted');
  assert.equal(rec.delivered, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, new RegExp(`^${id} render-app__render interrupted`));
  assert.match(sent[0].text, /Calling the tool again should continue/);
  broker.revokeSession(s.id);
});

test('an app caller: the outcome waits for onJobDone, durably across a restart; questions reach onJobQuestion', async () => {
  reset();
  const open = gate('app1');
  const started = await appTools.callCrossAppTool('caller-app', 'render-app', 'render', { key: 'app1', _wait: 0 });
  const id = started.structuredContent.jobId;
  assert.equal(seen[0].caller.type, 'app');
  open({ file: 'a.mp4' });
  await until(() => record(id).status === 'done');
  assert.equal(record(id).delivered, false, 'no handler yet: queued');

  boot(); // restart: the queue survives on disk
  const ctx = toolsCap.buildCtx({ name: 'caller-app' });
  const got = [];
  ctx.tools.onJobDone((rec) => { got.push(rec); });
  await until(() => got.length === 1);
  assert.equal(got[0].id, id);
  assert.equal(got[0].status, 'done');
  assert.deepEqual(got[0].result, { file: 'a.mp4' });
  await until(() => record(id).delivered === true);
  assert.equal(ctx.tools.job(id).status, 'done');
  assert.throws(() => toolsCap.buildCtx({ name: 'other-app' }).tools.job(id), /No tool job/);

  ctx.tools.onJobQuestion((rec) => `answer to ${rec.pendingQuestion.text}`);
  const asked = await appTools.callCrossAppTool('caller-app', 'render-app', 'render', { ask: 'size?', _wait: 0 });
  await until(() => got.length === 2);
  assert.equal(got[1].id, asked.structuredContent.jobId);
  assert.deepEqual(got[1].result, { content: [{ type: 'text', text: 'answered answer to size?' }] });
  assert.equal(sent.length, 0, 'app callers are never messaged');
});

test('callAndWait resolves with the final result however long the job runs', async () => {
  reset();
  const ctx = toolsCap.buildCtx({ name: 'caller-app' });
  const open = gate('wait1');
  const p = ctx.tools.callAndWait('render-app', 'render', { key: 'wait1', _wait: 0 });
  setTimeout(() => open({ file: 'late.mp4' }), 50);
  assert.deepEqual(await p, { file: 'late.mp4' });
  const id = seen[0].job.id;
  assert.equal(record(id).delivered, true);
  const failing = gate('wait2');
  const q = ctx.tools.callAndWait('render-app', 'render', { key: 'wait2' });
  failing(new Error('render crashed'));
  await assert.rejects(q, /render crashed/);
});

test('built-in job tools: listed per `when`, and refused for another run\'s jobs', async () => {
  reset();
  const names = async (s) => (await broker.handleMessage(s.id, rpc('tools/list'))).result.tools.map((t) => t.name).filter((n) => !n.startsWith('artifact_') && n !== 'sound_generate');
  const quickOnly = grantSession('cli-q', ['render-app__status']);
  const withJob = grantSession('cli-j', ['render-app__render']);
  const cat = broker.createHolderSession({ holder: orchestrator('cli-c'), mode: 'catalog' });
  assert.deepEqual(await names(quickOnly), ['render-app__status']);
  assert.deepEqual(await names(withJob), ['render-app__render', 'tool_job_status', 'tool_job_cancel', 'tool_job_reply']);
  assert.deepEqual(await names(cat), ['tools_search', 'tools_describe', 'tools_call', 'tool_job_status', 'tool_job_cancel', 'tool_job_reply']);
  const refused = await callVia(quickOnly, 'tool_job_status', {});
  assert.equal(refused.result.isError, true);
  assert.match(textOf(refused), /not served by this session/);
  // Owner sessions (no holder) are unchanged.
  const ownerList = (await broker.handleMessage(null, rpc('tools/list'))).result.tools.map((t) => t.name);
  assert.ok(!ownerList.includes('tool_job_status'));

  const open = gate('runs');
  const r = await callVia(withJob, 'render-app__render', { key: 'runs', _wait: 0 });
  const id = r.result.structuredContent.jobId;
  const other = grantSession('cli-other', ['render-app__render'], 'r2');
  for (const [tool, args] of [['tool_job_status', { jobId: id }], ['tool_job_cancel', { jobId: id }], ['tool_job_reply', { jobId: id, text: 'x' }]]) {
    const x = await callVia(other, tool, args);
    assert.equal(x.result.isError, true, tool);
    assert.match(textOf(x), /No tool job/);
  }
  const otherList = await callVia(other, 'tool_job_status', {});
  assert.ok(!otherList.result.structuredContent.jobs.some((j) => j.id === id));
  // Any session of the owning run sees it.
  const mine = await broker.handleMessage(cat.id, rpc('tools/call', { name: 'tool_job_status', arguments: {} }));
  assert.ok(mine.result.structuredContent.jobs.some((j) => j.id === id && j.status === 'running'));
  open('ok');
  await until(() => record(id).status === 'done');
  for (const s of [quickOnly, withJob, cat, other]) broker.revokeSession(s.id);
});

test('job tools carry kind and the caller-facing sentence in search, describe and the schema', () => {
  const hit = broker.searchTools({ query: 'render-app__render' }).tools[0];
  assert.equal(hit.kind, 'job');
  assert.equal(broker.searchTools({ query: 'render-app__status' }).tools[0].kind, 'call');
  const [d] = broker.describeTools({ names: ['render-app__render'] }).tools;
  assert.equal(d.kind, 'job');
  assert.equal(d.timeout, jobs.DEFAULT_TIMEOUT_MS);
  assert.ok(d.description.endsWith(appTools.JOB_NOTE));
  assert.ok(d.description.startsWith('Render a scene to a video file.'));
  assert.equal(d.inputSchema.properties._wait.type, 'integer');
  // The registry (and so the manifest) keeps the provider's own description.
  const own = appTools.getToolsForApp('render-app');
  assert.equal(own.find((t) => t.name === 'render').description, 'Render a scene to a video file.');
  assert.equal(own.find((t) => t.name === 'render').kind, 'job');
  assert.equal(own.find((t) => t.name === 'render_short').timeout, 60);
  assert.throws(() => appTools.registerAppTools('render-app', [{ name: 'bad', kind: 'batch' }]), /invalid kind/);
  appTools.registerAppTools('render-app', [{ name: 'huge', kind: 'job', timeout: 48 * 3600 * 1000, expose: 'apps' }]);
  assert.equal(appTools.getToolsForApp('render-app').find((t) => t.name === 'huge').timeout, jobs.MAX_TIMEOUT_MS);
});

test('currentCall is visible inside quick and job handlers, and null outside', async () => {
  reset();
  assert.equal(appTools.currentCall(), null);
  await appTools.callCrossAppTool('caller-app', 'render-app', 'status', {});
  const q = seen.find((x) => x.tool === 'status').call;
  assert.equal(q.app, 'render-app');
  assert.equal(q.tool, 'status');
  assert.equal(q.jobId, null);
  assert.equal(q.caller.appName, 'caller-app');
  assert.match(q.callId, /^tc_/);
  await appTools.callCrossAppTool('caller-app', 'render-app', 'render', { scene: 'b' });
  const j = seen.find((x) => x.tool === 'render').call;
  assert.equal(j.tool, 'render');
  assert.equal(j.jobId, seen.find((x) => x.tool === 'render').job.id);
  assert.equal(j.caller.type, 'app');
});

test('the holder identity carries the session cwd', () => {
  const { grant, catalog } = packs.createPacks({ dashboardPort: 1 });
  const settings = { name: 'orch-r9-w1', orchestration: { role: 'worker', runId: 'r9', workerId: 'w1', orchestrator: 'orch-r9' }, grants: { tools: ['render-app__render'] } };
  grant.build({ settings, instanceId: 'cli-cwd', role: 'worker', cwd: '/work/w1' });
  catalog.build({ settings: { name: 'orch-r9', orchestration: { role: 'orchestrator', runId: 'r9' } }, instanceId: 'cli-cwd-o', role: 'orchestrator', cwd: '/work/o' });
  const all = broker.listSessions();
  assert.equal(all.find((s) => s.holder?.instanceId === 'cli-cwd').holder.cwd, '/work/w1');
  assert.equal(all.find((s) => s.holder?.instanceId === 'cli-cwd-o').holder.cwd, '/work/o');
  // The grant prompt marks job tools and explains them.
  const built = grant.build({ settings, instanceId: 'cli-cwd', role: 'worker', cwd: '/work/w1' });
  assert.match(built.appendSystemPrompt, /`render-app__render` \(job\)/);
  assert.match(built.appendSystemPrompt, /tool_job_reply/);
  broker.revokeHolder({ instanceId: 'cli-cwd' });
  broker.revokeHolder({ instanceId: 'cli-cwd-o' });
});

test('quick tools are unchanged: no ledger, `_wait` passes through, errors throw', async () => {
  reset();
  const before = fs.readdirSync(path.join(tmp, 'tool-jobs')).length;
  const r = await appTools.callCrossAppTool('caller-app', 'render-app', 'status', { _wait: 3 });
  assert.deepEqual(r, { up: true, args: { _wait: 3 } });
  assert.equal(fs.readdirSync(path.join(tmp, 'tool-jobs')).length, before);
  const [d] = broker.describeTools({ names: ['render-app__status'] }).tools;
  assert.equal(d.description, 'Renderer status.');
  assert.equal((d.inputSchema.properties || {})._wait, undefined);
  assert.equal(d.kind, 'call');
  assert.equal(d.timeout, 180000);
  assert.equal(sent.length, 0);
});

test('a caller with no message route waits for the end (the app\'s own self call)', async () => {
  reset();
  const open = gate('self');
  setTimeout(() => open('done late'), 30);
  const r = await appTools.callAppToolHandler('render-app', 'render', { key: 'self', _wait: 0 }, { type: 'self', appName: 'render-app' });
  assert.equal(r, 'done late');
  const id = seen[0].job.id;
  assert.equal(record(id).principal, 'owner');
  assert.equal(record(id).delivered, true);
});

test('an artifact ref in the args becomes readable by the target app when the caller may read it', async () => {
  reset();
  const mine = await art.put('caller-app', Buffer.from('scene-bytes'), { name: 'scene.blend' });
  const foreign = await art.put('caller-app', Buffer.from('other-bytes'), { name: 'other.blend' });
  art.grant(mine.uri, { type: 'run', runId: 'r1' });
  const target = { type: 'app', app: 'render-app' };
  assert.equal(art.canRead(target, mine.uri), false);
  const s = grantSession('cli-art', ['render-app__status']);
  await callVia(s, 'render-app__status', { input: { file: mine.uri }, also: `see ${foreign.uri}` });
  assert.equal(art.canRead(target, mine.uri), true, 'the run could read it: granted');
  assert.equal(art.canRead(target, foreign.uri), false, 'the run could not read it: not granted');
  // An app caller hands its own artifact on through ctx.tools.call.
  await toolsCap.buildCtx({ name: 'caller-app' }).tools.call('render-app', 'status', { file: foreign.uri });
  assert.equal(art.canRead(target, foreign.uri), true);
  broker.revokeSession(s.id);
});

test('the artifact built-ins are listed on holder sessions, never on owner sessions', async () => {
  const list = async (id) => (await broker.handleMessage(id, rpc('tools/list'))).result.tools.map((t) => t.name);
  const g = grantSession('cli-artlist', []);
  const c = broker.createHolderSession({ holder: orchestrator('cli-artlist-o'), mode: 'catalog' });
  for (const s of [g, c]) {
    const names = await list(s.id);
    for (const n of ['artifact_info', 'artifact_fetch', 'artifact_put']) assert.ok(names.includes(n), `${n} on ${s.mode}`);
  }
  assert.ok(!(await list(null)).some((n) => n.startsWith('artifact_')));
  const info = await callVia(g, 'artifact_info', { uri: 'vc-artifact://art_0000000000000000-0000' });
  assert.equal(info.result.isError, true);
  broker.revokeSession(g.id);
  broker.revokeSession(c.id);
});
