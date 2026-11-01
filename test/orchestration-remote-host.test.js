// Remote workers, the master half (src/orchestration.js registerHostProvider):
// launch_cli({ host }) with a fake host provider, the member's tab as a real
// ExternalSession in a fake session manager. Nothing here spawns `claude`.
// The last test drives Pro's own provider (peer-remote-host.js) when a Pro
// checkout is present (VISTACLAIR_PRO_DIR, else <core>/vistaclair-pro);
// skipped otherwise.
//
//   node --test test/orchestration-remote-host.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { waitFor } = require('./wait-for');
const { ExternalSession } = require('../src/external-session');

const CORE = path.join(__dirname, '..');
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function tmpDir(prefix = 'vistaclair-remote-') {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

function fakeMgr() {
  const sessions = new Map();
  const external = new Map();
  const submits = [];
  let history = [];
  let seq = 0;
  const mk = (tabId) => ({
    tabId, instanceId: `cli-${tabId}`, running: false, busy: false, sessId: null, cwd: null, title: null, settings: {},
    getSettings() { return { ...this.settings }; },
    updateSettings(s) { Object.assign(this.settings, s); },
    write() {},
    submit(data, opts) { submits.push({ tabId, data, opts }); },
  });
  const mgr = {
    sessions, external, submits,
    nextTabId: () => `tab-t-${++seq}`,
    get: (tabId) => sessions.get(tabId) || null,
    getByInstanceId(id) { for (const s of sessions.values()) if (s.instanceId === id) return s; return null; },
    launchSession(tabId, opts) {
      const s = sessions.get(tabId) || mk(tabId);
      sessions.set(tabId, s);
      if (opts.title !== undefined) s.title = opts.title;
      s.updateSettings(opts.settings || {});
      s.running = true;
      s.cwd = opts.cwd;
      s.sessId = crypto.randomUUID();
      return s;
    },
    saveToHistory(e) { history.unshift({ id: e.sessId, cwd: e.cwd, settings: e.settings || {} }); },
    listSaved: () => history,
    findSaved: (id) => history.find(h => h.id === id) || null,
    closeQuiet(tabId) { const s = sessions.get(tabId); sessions.delete(tabId); if (s) s.running = false; },
    getExternal: (tabId) => (tabId && external.get(tabId)) || null,
  };
  return mgr;
}

// A broadcaster with in-process listeners, as dashboard-ws's.
function fakeBroadcaster() {
  const listeners = new Set();
  const sent = [];
  return {
    sent,
    broadcast(m) { sent.push(m); for (const fn of listeners) fn(m); },
    onBroadcast(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

function setup({ mgr = fakeMgr(), broadcaster = fakeBroadcaster(), dataHome = tmpDir('vistaclair-remote-home-') } = {}) {
  delete require.cache[require.resolve('../src/orchestration')];
  const { createOrchestration } = require('../src/orchestration');
  const orch = createOrchestration({
    mgr, broadcaster, pendingQuestions: new Map(), coreRoot: CORE, dataHome,
    credentials: () => ({ apiKey: true, subscription: false }), models: () => [], pushDebounceMs: 20,
  });
  return { mgr, broadcaster, orch, dataHome };
}

const HOSTS = [
  { name: 'hetzner-1', label: 'hetzner-1 (slave)', available: true },
  { name: 'pi', label: 'pi (slave)', available: false, reason: 'the channel to the slave is down' },
];

// launch() waits until the test settles it: p.calls[i].resolve / reject.
function fakeProvider(hosts = HOSTS) {
  const p = {
    calls: [], kills: [],
    hosts: () => hosts,
    launch(args) { return new Promise((resolve, reject) => p.calls.push({ args, resolve, reject })); },
    kill(a) { p.kills.push(a); const c = p.calls.find(x => x.args.runId === a.runId && x.args.address === a.address && !x.settled); if (c) { c.settled = true; c.reject(Object.assign(new Error('the run stopped this launch'), { code: 'cancelled' })); } },
  };
  return p;
}

async function openRun(ctx, { app = null } = {}) {
  const settings = app ? { changeApp: app } : {};
  const r = await ctx.orch.openCli({ cwd: tmpDir(), mode: 'orchestrator', engine: 'cli', settings });
  const orchSession = ctx.mgr.sessions.get(r.tabId);
  const stamp = orchSession.settings.orchestration;
  return { orchSession, stamp, iid: orchSession.instanceId, run: () => ctx.orch.getRun(stamp.runId) };
}

// The member's tab, as Pro registers it (registerExternalSession).
function addTab(mgr, tabId, { runId, name, host = 'hetzner-1', running = true }) {
  const adapter = {
    sessId: crypto.randomUUID(), kind: 'sdk', title: name, running, busy: false, state: 'idle',
    settings: { externalHost: host, orchestration: { runId, role: 'worker', name, orchestrator: `orch-${runId}` } },
    submitted: [], interrupts: 0,
    submit(text, opts) { this.submitted.push({ text, opts }); },
    interrupt() { this.interrupts++; },
    setModel() {}, setShowThinking() {}, setAuth() {}, historyPage() { return { events: [] }; }, kill() {}, close() {},
  };
  const ext = new ExternalSession(tabId, adapter);
  mgr.external.set(tabId, ext);
  return adapter;
}

const describe = (ctx, h) => ctx.orch.describeRun(h.run());
const member = (ctx, h, name) => describe(ctx, h).workers.find(w => w.name === name);

test('without a provider: launch_cli takes no host, the card and the schema name none', async () => {
  const ctx = setup();
  const h = await openRun(ctx, { app: 'notes' });
  assert.throws(() => ctx.orch.launchWorker(h.iid, { title: 't', task: 'x', host: 'hetzner-1' }), /remote workers need Pro's host provider/);
  assert.ok(!/Remote workers/.test(h.orchSession.settings.appendSystemPrompt));
  assert.strictEqual(ctx.orch.toolParams().params.launch_cli, undefined);
  assert.deepStrictEqual(ctx.orch.hostList(), []);
  // app alone is refused for a local worker.
  assert.throws(() => ctx.orch.launchWorker(h.iid, { title: 't', task: 'x', app: 'notes' }), /app is for a remote worker/);
});

test('a registered provider: its hosts in the orchestrator card and in launch_cli\'s schema; unregister removes them', async () => {
  const ctx = setup();
  const p = fakeProvider();
  const handle = ctx.orch.registerHostProvider(p);
  assert.ok(Object.isFrozen(handle));
  const h = await openRun(ctx);
  const card = h.orchSession.settings.appendSystemPrompt;
  assert.match(card, /Remote workers: launch_cli `host`/);
  assert.match(card, /`hetzner-1`/);
  assert.match(card, /`pi` \(unavailable now: the channel to the slave is down\)/);
  const params = ctx.orch.toolParams().params.launch_cli;
  assert.match(params.host.description, /hetzner-1, pi \(unavailable: the channel to the slave is down\)/);
  assert.ok(params.app);
  handle.unregister();
  handle.unregister();   // idempotent
  assert.strictEqual(ctx.orch.toolParams().params.launch_cli, undefined);
  assert.throws(() => ctx.orch.launchWorker(h.iid, { title: 't', task: 'x', host: 'hetzner-1', app: 'notes' }), /need Pro's host provider/);
  assert.throws(() => ctx.orch.registerHostProvider({ hosts() {} }), /needs \{ hosts, launch, kill \}/);
});

test('a second registration replaces the first, whose handle goes inert', async () => {
  const ctx = setup();
  const first = ctx.orch.registerHostProvider(fakeProvider([{ name: 'a', available: true }]));
  const second = ctx.orch.registerHostProvider(fakeProvider([{ name: 'b', available: true }]));
  assert.deepStrictEqual(ctx.orch.hostList().map(x => x.name), ['b']);
  first.unregister();
  assert.deepStrictEqual(ctx.orch.hostList().map(x => x.name), ['b'], 'the old handle cannot unregister the new provider');
  assert.strictEqual(first.deliver({ runId: 'x', address: 'y', kind: 'report', status: 'done', summary: '' }), false);
  second.unregister();
  assert.deepStrictEqual(ctx.orch.hostList(), []);
});

test('launch_cli host: unknown and unavailable hosts, and the parameters a remote worker cannot take', async () => {
  const ctx = setup();
  ctx.orch.registerHostProvider(fakeProvider());
  const h = await openRun(ctx, { app: 'notes' });
  const launch = (a) => ctx.orch.launchWorker(h.iid, { title: 't', task: 'do it', ...a });
  assert.throws(() => launch({ host: 'mars' }), /no host "mars"\. Hosts: hetzner-1, pi \(unavailable: the channel to the slave is down\)/);
  assert.throws(() => launch({ host: 'pi' }), /host "pi" is unavailable: the channel to the slave is down/);
  assert.throws(() => launch({ host: 'hetzner-1', cwd: 'sub' }), /^Error: cwd: .*omit it for a remote worker/);
  assert.throws(() => launch({ host: 'hetzner-1', isolation: 'worktree' }), /isolation: a remote worker has no worktree/);
  assert.throws(() => launch({ host: 'hetzner-1', area: ['src/**'] }), /area: /);
  assert.throws(() => launch({ host: 'hetzner-1', tools: ['a__b'] }), /tools: /);
  assert.throws(() => launch({ host: 'hetzner-1', app: 'Bad App' }), /app must be an app name/);
  assert.strictEqual(h.run().workers.length, 0, 'nothing recorded');
  // isolation 'none' is fine; app from the run's stamp.
  const r = launch({ host: 'hetzner-1', isolation: 'none' });
  assert.strictEqual(r.app, 'notes');
  // A run without an app of its own needs one named.
  const h2 = await openRun(ctx);
  assert.throws(() => ctx.orch.launchWorker(h2.iid, { title: 't', task: 'x', host: 'hetzner-1' }), /app: name the app on the host/);
});

test('happy path: pending-approval, the tab bound, SendMessage to its adapter, a done report wakes the orchestrator, close kills', async () => {
  const ctx = setup();
  const p = fakeProvider();
  const handle = ctx.orch.registerHostProvider(p);
  const h = await openRun(ctx);
  const r = ctx.orch.launchWorker(h.iid, { title: 'Port it', task: 'the brief', host: 'hetzner-1', app: 'notes', model: 'sonnet' });
  assert.strictEqual(r.state, 'pending-approval');
  assert.match(r.worker, new RegExp(`^orch-${h.stamp.runId}-w1-port-it$`));
  assert.strictEqual(p.calls.length, 1);
  assert.deepStrictEqual(p.calls[0].args, {
    runId: h.stamp.runId, address: r.worker, title: 'Port it', task: 'the brief', host: 'hetzner-1', app: 'notes', model: 'sonnet',
    orchestrator: { address: `orch-${h.stamp.runId}`, title: '' },
  });
  let m = member(ctx, h, r.worker);
  assert.strictEqual(m.state, 'pending-approval');
  assert.strictEqual(m.host, 'hetzner-1');
  assert.strictEqual(m.running, false);
  const listed = ctx.orch.listWorkers(h.iid).workers.find(w => w.name === r.worker);
  assert.strictEqual(listed.host, 'hetzner-1');
  assert.strictEqual(listed.state, 'pending-approval');
  assert.throws(() => ctx.orch.sendMessage(h.iid, { to: r.worker, message: 'hi' }), /pending-approval: it gets its brief when the owner approves/);
  assert.throws(() => ctx.orch.stopWorker(h.iid, { worker: r.worker }), /close_worker cancels its launch/);
  assert.throws(() => ctx.orch.resumeWorker(h.iid, { worker: r.worker }), /remote worker on hetzner-1: it cannot be resumed/);

  // The owner approves: Pro registers the tab and resolves.
  const adapter = addTab(ctx.mgr, 'rs-hetzner-1-1', { runId: h.stamp.runId, name: r.worker });
  p.calls[0].resolve({ tabId: 'rs-hetzner-1-1' });
  await waitFor(() => member(ctx, h, r.worker).running);
  m = member(ctx, h, r.worker);
  assert.strictEqual(m.tabId, 'rs-hetzner-1-1');
  assert.strictEqual(m.state, 'idle');
  const started = h.run().events.find(e => e.kind === 'remote');
  assert.match(started.text, /started on hetzner-1/);
  assert.strictEqual(started.quiet, true);

  // SendMessage → adapter.submit(text, { from }).
  const sent = ctx.orch.sendMessage(h.iid, { to: r.worker, message: 'also the docs' });
  assert.deepStrictEqual(sent, { ok: true, to: r.worker, delivery: 'submitted' });
  await waitFor(() => adapter.submitted.length === 1);
  assert.deepStrictEqual(adapter.submitted[0], { text: `[message from orch-${h.stamp.runId}] also the docs`, opts: { from: `orch-${h.stamp.runId}` } });
  assert.strictEqual(h.run().workers[0].followUps[0].text, 'also the docs');

  // deliver: unknown run / member ignored; a started report is quiet.
  assert.strictEqual(handle.deliver({ runId: 'nope', address: r.worker, kind: 'report', status: 'done', summary: 'x' }), false);
  assert.strictEqual(handle.deliver({ runId: h.stamp.runId, address: 'someone', kind: 'report', status: 'done', summary: 'x' }), false);
  assert.strictEqual(handle.deliver({ runId: h.stamp.runId, address: r.worker, kind: 'report', status: 'bogus', summary: 'x' }), false);
  assert.strictEqual(handle.deliver({ runId: h.stamp.runId, address: r.worker, kind: 'report', status: 'started', summary: 'on it' }), true);
  await wait(60);
  assert.ok(!ctx.mgr.submits.some(s => s.tabId === h.orchSession.tabId), 'started does not wake the orchestrator');

  // done: a wake event, pushed into the idle orchestrator.
  assert.strictEqual(handle.deliver({ runId: h.stamp.runId, address: r.worker, kind: 'report', status: 'done', summary: '[remote · hetzner-1 · untrusted] ported' }), true);
  const ev = h.run().events.at(-1);
  assert.strictEqual(ev.kind, 'report');
  assert.match(ev.text, /reported done: \[remote · hetzner-1 · untrusted\] ported/);
  assert.ok(!ev.quiet);
  await waitFor(() => ctx.mgr.submits.some(s => s.tabId === h.orchSession.tabId && /worker event\(s\) pending/.test(s.data)));
  assert.strictEqual(h.run().workers[0].lastReport.status, 'done');
  assert.strictEqual(h.run().workers[0].branch, null, 'nothing lands');

  // A message to the orchestrator, as a local worker's SendMessage.
  assert.strictEqual(handle.deliver({ runId: h.stamp.runId, address: r.worker, kind: 'message', text: 'a question' }), true);
  assert.ok(ctx.mgr.submits.some(s => s.tabId === h.orchSession.tabId && s.data === `[message from ${r.worker}] a question` && s.opts.from === r.worker));

  // stop_worker on a busy member: its adapter's interrupt.
  adapter.busy = true;
  assert.strictEqual(ctx.orch.stopWorker(h.iid, { worker: r.worker }).stopped, true);
  await waitFor(() => adapter.interrupts === 1);
  adapter.busy = false;

  // close_worker → provider.kill; its exit afterwards is quiet.
  const c = ctx.orch.closeWorker(h.iid, { worker: r.worker });
  assert.strictEqual(c.closed, true);
  await waitFor(() => p.kills.length === 1);
  assert.deepStrictEqual(p.kills[0], { runId: h.stamp.runId, address: r.worker });
  const n = h.run().events.length;
  ctx.broadcaster.broadcast({ type: 'cli:exit', tabId: 'rs-hetzner-1-1', exitCode: null, external: true });
  assert.strictEqual(h.run().events.length, n, 'a closed member\'s exit is no event');
  assert.strictEqual(member(ctx, h, r.worker).state, 'closed');
});

test('every reject code is a "remote" event the orchestrator receives; an unknown code reads as failed', async () => {
  const ctx = setup();
  const p = fakeProvider();
  ctx.orch.registerHostProvider(p);
  const h = await openRun(ctx, { app: 'notes' });
  const codes = ['declined', 'refused', 'unavailable', 'invalid', 'failed', 'cancelled', 'weird'];
  for (const [i, code] of codes.entries()) {
    const r = ctx.orch.launchWorker(h.iid, { title: `t${i}`, task: 'x', host: 'hetzner-1' });
    p.calls[i].reject(Object.assign(new Error(`because ${code}`), { code }));
    await waitFor(() => h.run().events.some(e => e.kind === 'remote' && e.worker === r.worker));
    const ev = h.run().events.find(e => e.kind === 'remote' && e.worker === r.worker);
    const want = code === 'weird' ? 'failed' : code;
    assert.match(ev.text, new RegExp(`came to ${want}: because ${code}`));
    assert.ok(!ev.quiet);
    assert.ok(ev.seq > h.run().delivered, 'pending for the orchestrator');
    assert.strictEqual(member(ctx, h, r.worker).state, `launch ${want}`);
  }
  // A provider whose launch throws synchronously is the same.
  const ctx2 = setup();
  ctx2.orch.registerHostProvider({ hosts: () => HOSTS, launch() { throw Object.assign(new Error('nope'), { code: 'invalid' }); }, kill() {} });
  const h2 = await openRun(ctx2, { app: 'notes' });
  const r2 = ctx2.orch.launchWorker(h2.iid, { title: 't', task: 'x', host: 'hetzner-1' });
  await waitFor(() => h2.run().events.some(e => e.worker === r2.worker && /came to invalid: nope/.test(e.text)));
  await waitFor(() => ctx2.mgr.submits.some(s => s.tabId === h2.orchSession.tabId), 'the orchestrator is woken');
});

test('remote members count toward MAX_WORKERS: a sixth launch is queued and starts when one fails', async () => {
  const ctx = setup();
  const p = fakeProvider();
  ctx.orch.registerHostProvider(p);
  const h = await openRun(ctx, { app: 'notes' });
  for (let i = 0; i < 5; i++) ctx.orch.launchWorker(h.iid, { title: `t${i}`, task: 'x', host: 'hetzner-1' });
  const q = ctx.orch.launchWorker(h.iid, { title: 'six', task: 'x', host: 'hetzner-1' });
  assert.strictEqual(q.queued, true);
  assert.strictEqual(p.calls.length, 5);
  p.calls[0].reject(Object.assign(new Error('no'), { code: 'declined' }));
  await waitFor(() => p.calls.length === 6);
  assert.strictEqual(p.calls[5].args.title, 'six');
  assert.strictEqual(h.run().queue.length, 0);
});

test('close_worker of a waiting launch cancels it; end_run stops every remote member', async () => {
  const ctx = setup();
  const p = fakeProvider();
  ctx.orch.registerHostProvider(p);
  const h = await openRun(ctx, { app: 'notes' });
  const a = ctx.orch.launchWorker(h.iid, { title: 'a', task: 'x', host: 'hetzner-1' });
  const c = ctx.orch.closeWorker(h.iid, { worker: a.worker });
  assert.match(c.note, /cancelled before the owner approved/);
  await waitFor(() => h.run().events.some(e => e.worker === a.worker && /came to cancelled/.test(e.text)));
  assert.ok(h.run().delivered >= h.run().events.at(-1).seq, 'the run cancelled it itself: not delivered back');
  assert.strictEqual(member(ctx, h, a.worker).state, 'closed');

  const b = ctx.orch.launchWorker(h.iid, { title: 'b', task: 'x', host: 'hetzner-1' });
  const d = ctx.orch.launchWorker(h.iid, { title: 'd', task: 'x', host: 'hetzner-1' });
  addTab(ctx.mgr, 'rs-b', { runId: h.stamp.runId, name: b.worker });
  p.calls[1].resolve({ tabId: 'rs-b' });
  await waitFor(() => member(ctx, h, b.worker).running);
  const end = ctx.orch.endRun(h.iid);
  assert.deepStrictEqual(end.remoteClosed.sort(), [b.worker, d.worker].sort());
  await waitFor(() => p.kills.length === 3);
  assert.deepStrictEqual(p.kills.map(k => k.address).sort(), [a.worker, b.worker, d.worker].sort());
});

test('an exited member is an event; its record survives a restart, a lost launch is an event, a re-adopted tab is bound again', async () => {
  const mgr = fakeMgr();
  const dataHome = tmpDir('vistaclair-remote-home-');
  const ctx = setup({ mgr, dataHome });
  const p = fakeProvider();
  ctx.orch.registerHostProvider(p);
  const h = await openRun(ctx, { app: 'notes' });
  const a = ctx.orch.launchWorker(h.iid, { title: 'a', task: 'x', host: 'hetzner-1' });
  const b = ctx.orch.launchWorker(h.iid, { title: 'b', task: 'x', host: 'hetzner-1' });
  const c = ctx.orch.launchWorker(h.iid, { title: 'c', task: 'x', host: 'hetzner-1' });
  addTab(mgr, 'rs-a', { runId: h.stamp.runId, name: a.worker });
  addTab(mgr, 'rs-b', { runId: h.stamp.runId, name: b.worker });
  p.calls[0].resolve({ tabId: 'rs-a' });
  p.calls[1].resolve({ tabId: 'rs-b' });
  await waitFor(() => member(ctx, h, a.worker).running && member(ctx, h, b.worker).running);

  // a exits on its host.
  mgr.external.get('rs-a').adapter.running = false;
  ctx.broadcaster.broadcast({ type: 'cli:exit', tabId: 'rs-a', exitCode: 0 });
  assert.match(h.run().events.at(-1).text, new RegExp(`${a.worker} exited on hetzner-1 without reporting`));
  assert.strictEqual(member(ctx, h, a.worker).state, 'exited');

  // The server restarts: the provider has b's tab gone until it reconnects; c's
  // card is gone with the old process.
  mgr.external.delete('rs-b');
  const ctx2 = setup({ mgr, dataHome });
  const run2 = ctx2.orch.getRun(h.stamp.runId);
  const ev = run2.events.find(e => e.worker === c.worker && e.kind === 'remote');
  assert.match(ev.text, /lost: the server restarted before the owner approved it/);
  const d2 = ctx2.orch.describeRun(run2);
  const mb = d2.workers.find(w => w.name === b.worker);
  assert.strictEqual(mb.state, 'disconnected');
  assert.strictEqual(mb.host, 'hetzner-1');
  assert.strictEqual(d2.workers.find(w => w.name === c.worker).state, 'launch cancelled');
  // b still holds its slot while it is not back.
  assert.match(JSON.stringify(ctx2.orch.describeRun(run2).queue), /^\[\]$/);
  // The provider re-adopts b under a new tab id.
  addTab(mgr, 'rs-b2', { runId: h.stamp.runId, name: b.worker });
  ctx2.broadcaster.broadcast({ type: 'cli:spawned', tabId: 'rs-b2', external: true, settings: mgr.external.get('rs-b2').getSettings() });
  const back = ctx2.orch.describeRun(ctx2.orch.getRun(h.stamp.runId)).workers.find(w => w.name === b.worker);
  assert.strictEqual(back.tabId, 'rs-b2');
  assert.strictEqual(back.running, true);
  assert.strictEqual(ctx2.orch.getRun(h.stamp.runId).workers.find(w => w.name === b.worker).remote.tabId, 'rs-b2');
});

test('a member tab found by its stamp: the run\'s, the member\'s, from its host only', async () => {
  const ctx = setup();
  const p = fakeProvider();
  ctx.orch.registerHostProvider(p);
  const h = await openRun(ctx, { app: 'notes' });
  const a = ctx.orch.launchWorker(h.iid, { title: 'a', task: 'x', host: 'hetzner-1' });
  p.calls[0].resolve({ tabId: 'rs-gone' });
  await waitFor(() => h.run().workers[0].remote.state === 'started');
  addTab(ctx.mgr, 'rs-other', { runId: h.stamp.runId, name: a.worker, host: 'pi' });
  assert.strictEqual(member(ctx, h, a.worker).running, false, 'another host\'s tab is not this member');
  addTab(ctx.mgr, 'rs-real', { runId: h.stamp.runId, name: a.worker });
  assert.strictEqual(member(ctx, h, a.worker).tabId, 'rs-real');
});

// Pro's own provider against this core (read-only use of a Pro checkout).
const PRO = process.env.VISTACLAIR_PRO_DIR || path.join(CORE, 'vistaclair-pro');
const PRO_HOST = path.join(PRO, 'src', 'apps', 'peer-remote-host.js');

test('Pro\'s peer-remote-host registers with core: hosts reach the card, a launch files a card, an approval binds the tab, a slave report reaches the orchestrator', { skip: !fs.existsSync(PRO_HOST) && 'no Pro checkout' }, async () => {
  const ctx = setup();
  const peers = [{ name: 'hetzner-1', connected: true, claude: { loggedIn: true, remoteSessions: { enabled: true } } }];
  const proposals = new Map();
  const governance = {
    kindDef: () => ({}),
    listProposals: () => [],
    requestAction: async (kind, payload) => { const id = `p${proposals.size + 1}`; proposals.set(id, { id, kind, payload, status: 'pending' }); return { mode: 'proposed', proposal: { id } }; },
    getProposal: (id) => proposals.get(id) || null,
    withdrawProposal: (id) => { const x = proposals.get(id); if (x) x.status = 'withdrawn'; },
  };
  let onMsg = null;
  const launched = [];
  const master = {
    onMemberMessage: (fn) => { onMsg = fn; return () => { onMsg = null; }; },
    setPeerExtras() {},
    scheduleState() {},
    launchMember: async (peer, spec, who) => {
      launched.push({ peer, spec, who });
      addTab(ctx.mgr, 'rs-pro-1', { runId: who.runId, name: who.address });
      return { tabId: 'rs-pro-1', memberAddress: who.address };
    },
    memberTab: () => null,
    close() {},
  };
  const host = require(PRO_HOST);
  try {
    host.init({ orchestration: { registerHostProvider: (pv) => ctx.orch.registerHostProvider(pv) }, master, governance, peerChannel: { fleetState: () => ({ peers }) }, dataHome: tmpDir('vistaclair-remote-pro-'), pollMs: 20 });
    assert.deepStrictEqual(ctx.orch.hostList(), [{ name: 'hetzner-1', label: 'hetzner-1 (slave)', available: true }]);
    const h = await openRun(ctx, { app: 'notes' });
    assert.match(h.orchSession.settings.appendSystemPrompt, /`hetzner-1`/);
    const r = ctx.orch.launchWorker(h.iid, { title: 'Port', task: 'the brief', host: 'hetzner-1' });
    await waitFor(() => proposals.size === 1);
    const card = [...proposals.values()][0];
    assert.strictEqual(card.payload.origin.ref, h.stamp.runId);
    assert.strictEqual(card.payload.origin.member, r.worker);
    assert.strictEqual(card.payload.app, 'notes');
    card.status = 'approved';
    await host.approved(card.payload, { id: card.id });
    await waitFor(() => member(ctx, h, r.worker).running);
    assert.strictEqual(launched[0].who.address, r.worker);
    onMsg({ peer: 'hetzner-1', runId: h.stamp.runId, address: r.worker, kind: 'report', status: 'done', summary: 'ported' });
    assert.match(h.run().events.at(-1).text, /reported done: \[remote · hetzner-1 · untrusted\] ported/);
  } finally {
    host.shutdown();
  }
  assert.deepStrictEqual(ctx.orch.hostList(), [], 'Pro\'s shutdown unregisters');
});
