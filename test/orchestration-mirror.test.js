// Mirror runs, the slave half of remote workers (src/orchestration.js
// openMirrorRun): a run whose orchestrator is an address on another machine,
// its members ordinary SDK workers whose reports and messages to the
// orchestrator go to the add-on's deliver(). A fake session manager stands in
// for the sessions. The last test drives Pro's own peer-remote-slave.js when a
// Pro checkout is present (VISTACLAIR_PRO_DIR, else <core>/vistaclair-pro);
// skipped otherwise.
//
//   node --test test/orchestration-mirror.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { waitFor } = require('./wait-for');

const CORE = path.join(__dirname, '..');
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function tmpDir(prefix = 'vistaclair-mirror-') {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

function fakeMgr() {
  const sessions = new Map();
  let history = [];
  let seq = 0;
  const mk = (tabId) => ({
    tabId, instanceId: `cli-${tabId}`, running: false, busy: false, sessId: null, cwd: null, title: null, settings: {}, submitted: [], interrupts: 0,
    getSettings() { return { ...this.settings }; },
    updateSettings(s) { Object.assign(this.settings, s); },
    write() {},
    submit(data, opts) { this.submitted.push({ data, opts }); },
    async interrupt() { this.interrupts++; },
  });
  const mgr = {
    sessions, launches: [], closed: [],
    nextTabId: () => `tab-m-${++seq}`,
    get: (tabId) => sessions.get(tabId) || null,
    getBySessId: (sid) => [...sessions.values()].find(s => s.sessId === sid) || null,
    getByInstanceId(id) { for (const s of sessions.values()) if (s.instanceId === id) return s; return null; },
    launchSession(tabId, opts) {
      const s = sessions.get(tabId) || mk(tabId);
      sessions.set(tabId, s);
      s.title = opts.title;
      s.updateSettings(opts.settings || {});
      if (s.settings.engine === 'sdk') s.kind = 'sdk';
      s.hidden = !!opts.hidden;
      s.running = true;
      s.cwd = opts.cwd;
      s.sessId = crypto.randomUUID();
      mgr.launches.push({ tabId, opts });
      return s;
    },
    saveToHistory(e) { history = history.filter(h => h.id !== e.sessId); history.unshift({ id: e.sessId, cwd: e.cwd, settings: e.settings || {} }); },
    listSaved: () => history,
    findSaved: (id) => history.find(h => h.id === id) || null,
    closeQuiet(tabId) { const s = sessions.get(tabId); sessions.delete(tabId); if (s) { s.running = false; mgr.closed.push(tabId); } },
    kill(tabId) { const s = sessions.get(tabId); if (s) s.running = false; },
    sessionDirOf: () => null,
  };
  return mgr;
}

function setup({ mgr = fakeMgr(), dataHome = tmpDir('vistaclair-mirror-home-') } = {}) {
  delete require.cache[require.resolve('../src/orchestration')];
  const { createOrchestration } = require('../src/orchestration');
  const broadcasts = [];
  const orch = createOrchestration({
    mgr, broadcaster: { broadcast: (m) => broadcasts.push(m) }, pendingQuestions: new Map(), coreRoot: CORE, dataHome,
    credentials: () => ({ apiKey: true, subscription: true }), models: () => [], pushDebounceMs: 20,
  });
  return { mgr, orch, dataHome, broadcasts };
}

const KEY = 'master.example-8443:abc123';
const ORCH = { address: 'orch-abc123', host: 'master.example-8443' };

function open(ctx, delivered = []) {
  const run = ctx.orch.openMirrorRun({ key: KEY, orchestrator: ORCH, deliver: (m) => delivered.push(m) });
  return { run, delivered };
}

test('openMirrorRun: argument checks; the run has no local orchestrator, and the dashboard cannot start one', async () => {
  const ctx = setup();
  assert.throws(() => ctx.orch.openMirrorRun({ key: 'bad key', orchestrator: ORCH, deliver() {} }), /key must be/);
  assert.throws(() => ctx.orch.openMirrorRun({ key: KEY, orchestrator: { address: 'a/b' }, deliver() {} }), /orchestrator.address/);
  assert.throws(() => ctx.orch.openMirrorRun({ key: KEY, orchestrator: ORCH }), /deliver must be a function/);
  const { run } = open(ctx);
  assert.ok(Object.isFrozen(run));
  const r = ctx.orch.getRun(run.runId);
  assert.strictEqual(r.orchestrator, 'orch-abc123');
  assert.deepStrictEqual(r.mirror, { key: KEY, host: 'master.example-8443', closed: false });
  const d = ctx.orch.describeRunById(run.runId);
  assert.deepStrictEqual(d.mirror, { key: KEY, host: 'master.example-8443', orchestrator: 'orch-abc123', closed: false });
  assert.strictEqual(d.orchestratorRunning, false);
  for (const fn of [() => ctx.orch.resumeRun(run.runId), () => ctx.orch.resumeRun(run.runId, { fresh: true })]) {
    assert.throws(fn, /is a mirror of the orchestrator orch-abc123 on master.example-8443: it is run from there/);
  }
  assert.strictEqual(ctx.mgr.launches.length, 0, 'no orchestrator session was started');
});

test('launchWorker: an SDK worker whose card names the remote orchestrator; its report and SendMessage reach deliver', async () => {
  const ctx = setup();
  const { run, delivered } = open(ctx);
  const cwd = tmpDir();
  const sessionsRoot = path.join(tmpDir(), 'sessions');
  const res = await run.launchWorker({
    title: 'Fix the app', task: 'do the thing', cwd, auth: 'subscription', model: 'sonnet',
    settings: { remoteLaunch: { member: KEY }, sessionsRoot, name: 'not-mine', orchestration: { role: 'orchestrator' } },
  });
  assert.match(res.address, /^orch-abc123-w1-fix-the-app$/);
  const s = ctx.mgr.sessions.get(res.tabId);
  const st = s.settings;
  assert.strictEqual(st.engine, 'sdk');
  assert.strictEqual(st.auth, 'subscription');
  assert.strictEqual(st.model, 'sonnet');
  assert.strictEqual(st.name, res.address, 'the caller cannot rename it');
  assert.deepStrictEqual(st.remoteLaunch, { member: KEY }, 'the caller\'s stamps ride along');
  assert.strictEqual(st.orchestration.role, 'worker');
  assert.strictEqual(st.orchestration.orchestrator, 'orch-abc123');
  assert.strictEqual(st.sessionDir, path.join(sessionsRoot, res.address));
  assert.match(st.appendSystemPrompt, /launched by the orchestrator `orch-abc123`/);
  assert.match(st.appendSystemPrompt, /runs on another machine \(master.example-8443\)/);
  assert.strictEqual(s.cwd, cwd);
  assert.strictEqual(ctx.mgr.launches[0].opts.prompt, 'do the thing');

  // report → deliver, with the report's other fields in the summary.
  const out = ctx.orch.report(s.instanceId, { status: 'done', summary: 'fixed', filesChanged: ['a.js'], verified: 'npm test', open: '' });
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(delivered.at(-1), { address: res.address, kind: 'report', status: 'done', summary: 'fixed\nfiles: a.js\nverified: npm test' });
  // SendMessage to the orchestrator (address or "orchestrator") → deliver.
  const m = ctx.orch.sendMessage(s.instanceId, { to: 'orch-abc123', message: 'a question' });
  assert.deepStrictEqual(m, { ok: true, to: 'orch-abc123', delivery: 'relayed' });
  ctx.orch.sendMessage(s.instanceId, { to: 'orchestrator', message: 'another' });
  assert.deepStrictEqual(delivered.slice(-2), [
    { address: res.address, kind: 'message', text: 'a question' },
    { address: res.address, kind: 'message', text: 'another' },
  ]);
  // Nothing waits for a local orchestrator.
  assert.strictEqual(ctx.orch.describeRunById(run.runId).pendingEvents, 0);
  // The run is listed, read-only.
  const listed = ctx.orch.listRuns().find(x => x.runId === run.runId);
  assert.strictEqual(listed.state, 'mirror');
  assert.deepStrictEqual(listed.mirror, { host: 'master.example-8443', orchestrator: 'orch-abc123' });
  assert.throws(() => ctx.orch.pauseRun(run.runId), /is a mirror/);
});

test('launchWorker checks its arguments and the run\'s worker limit', async () => {
  const ctx = setup();
  const { run } = open(ctx);
  const cwd = tmpDir();
  await assert.rejects(run.launchWorker({ title: 't', task: '', cwd }), /task is required/);
  await assert.rejects(run.launchWorker({ title: 't', task: 'x', cwd: 'relative' }), /cwd must be an existing absolute directory/);
  await assert.rejects(run.launchWorker({ title: 't', task: 'x', cwd, auth: 'free' }), /auth must be/);
  await assert.rejects(run.launchWorker({ title: 't', task: 'x', cwd, model: 'no spaces' }), /model is not a model name/);
  for (let i = 0; i < 5; i++) await run.launchWorker({ title: `t${i}`, task: 'x', cwd });
  await assert.rejects(run.launchWorker({ title: 'six', task: 'x', cwd }), /5 members of this run are running/);
});

test('submit, interrupt and kill act on a member by address; close closes the run', async () => {
  const ctx = setup();
  const { run } = open(ctx);
  const cwd = tmpDir();
  const a = await run.launchWorker({ title: 'a', task: 'x', cwd });
  const b = await run.launchWorker({ title: 'b', task: 'x', cwd });
  const sa = ctx.mgr.sessions.get(a.tabId);
  const r = await run.submit(a.address, 'more work', { from: 'orch-abc123@master' });
  assert.deepStrictEqual(r, { delivered: true, how: 'submitted' });
  assert.deepStrictEqual(sa.submitted.at(-1), { data: '[message from orch-abc123@master] more work', opts: { priority: 'next', from: 'orch-abc123@master' } });
  assert.strictEqual(ctx.orch.getRun(run.runId).workers[0].followUps[0].text, 'more work');
  await assert.rejects(run.submit('nobody', 'x', {}), /no member nobody/);
  await run.interrupt(a.address);
  assert.strictEqual(sa.interrupts, 1);
  await run.kill(a.address);
  assert.strictEqual(sa.running, false);
  assert.ok(ctx.mgr.closed.includes(a.tabId));
  await assert.rejects(run.submit(a.address, 'x', {}), /is not running/);
  assert.strictEqual(ctx.orch.describeRunById(run.runId).workers.find(w => w.name === a.address).state, 'closed');
  run.close();
  assert.strictEqual(ctx.mgr.sessions.get(b.tabId), undefined, 'close closes the live members');
  const d = ctx.orch.describeRunById(run.runId);
  assert.strictEqual(d.closed, true);
  assert.strictEqual(d.mirror.closed, true);
  await assert.rejects(run.launchWorker({ title: 'c', task: 'x', cwd }), /mirror run is closed/);
  // Open again: the same run, usable.
  const again = ctx.orch.openMirrorRun({ key: KEY, orchestrator: ORCH, deliver() {} });
  assert.strictEqual(again.runId, run.runId);
  assert.strictEqual(ctx.orch.describeRunById(run.runId).closed, false);
});

test('re-open by key after a restart: the same run and members; deliver goes to the new callback', async () => {
  const mgr = fakeMgr();
  const dataHome = tmpDir('vistaclair-mirror-home-');
  const ctx = setup({ mgr, dataHome });
  const { run } = open(ctx);
  const a = await run.launchWorker({ title: 'a', task: 'x', cwd: tmpDir() });
  // Another key is another run.
  const other = ctx.orch.openMirrorRun({ key: 'master.example-8443:fff000', orchestrator: { address: 'orch-fff000', host: 'm' }, deliver() {} });
  assert.notStrictEqual(other.runId, run.runId);

  const ctx2 = setup({ mgr, dataHome });
  // Before Pro re-opens it, a report is kept as an event, not lost silently.
  const s = mgr.sessions.get(a.tabId);
  ctx2.orch.report(s.instanceId, { status: 'started', summary: 'early' });
  assert.match(ctx2.orch.getRun(run.runId).events.at(-1).text, /not relayed to orch-abc123/);
  const delivered = [];
  const reopened = ctx2.orch.openMirrorRun({ key: KEY, orchestrator: ORCH, deliver: (m) => delivered.push(m) });
  assert.strictEqual(reopened.runId, run.runId);
  const d = ctx2.orch.describeRunById(run.runId);
  assert.deepStrictEqual(d.workers.map(w => w.name), [a.address]);
  ctx2.orch.report(s.instanceId, { status: 'blocked', summary: 'need a decision' });
  assert.deepStrictEqual(delivered, [{ address: a.address, kind: 'report', status: 'blocked', summary: 'need a decision' }]);
  await reopened.submit(a.address, 'go on', { from: 'orch-abc123@master' });
  assert.strictEqual(s.submitted.at(-1).data, '[message from orch-abc123@master] go on');
  // The index survives a missing run.json: a fresh run for the key.
  fs.rmSync(path.join(ctx2.orch.getRun(run.runId).runDir, 'run.json'));
  const ctx3 = setup({ mgr: fakeMgr(), dataHome });
  const fresh = ctx3.orch.openMirrorRun({ key: KEY, orchestrator: ORCH, deliver() {} });
  assert.notStrictEqual(fresh.runId, run.runId);
});

// Pro's own slave half against this core (read-only use of a Pro checkout).
const PRO = process.env.VISTACLAIR_PRO_DIR || path.join(CORE, 'vistaclair-pro');
const PRO_SLAVE = path.join(PRO, 'src', 'apps', 'peer-remote-slave.js');

test('Pro\'s peer-remote-slave: member.launch reaches launchWorker, a report comes back as rs:msg, member.submit reaches the worker', { skip: !fs.existsSync(PRO_SLAVE) && 'no Pro checkout' }, async () => {
  const appsDir = tmpDir('vistaclair-mirror-apps-');
  fs.mkdirSync(path.join(appsDir, 'my-app'));
  fs.writeFileSync(path.join(appsDir, 'my-app', 'manifest.json'), '{}');
  const proHome = tmpDir('vistaclair-mirror-pro-');
  const appManager = require(path.join(PRO, 'src', 'apps', 'app-manager'));
  const hostConfig = require(path.join(PRO, 'src', 'apps', 'host-config'));
  const slave = require(PRO_SLAVE);
  appManager.setAppsDir(appsDir);
  hostConfig.init(appsDir, { dataHome: proHome });
  hostConfig.setRole('slave');
  hostConfig.setSlave({ name: 's1', masterUrl: 'https://master.example:8443', publicUrl: 'https://slave.example', linkStatus: 'linked' });
  hostConfig.setRemoteSessions({ enabled: true, allowApiKey: false });

  const ctx = setup();
  const listeners = new Set();
  const broadcaster = { broadcast(m) { for (const fn of listeners) fn(m); }, onBroadcast(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const frames = [];
  try {
    slave.init({
      broadcaster, cliSessionManager: ctx.mgr, openCli: async () => { throw new Error('not used'); },
      pendingQuestions: new Map(), clearPendingQuestionsForTab() {},
      resolveAuth: () => ({ credential: 'subscription', key: '' }), claudeAuthInfo: () => ({}),
      appsDir, proDir: path.join(os.tmpdir(), 'no-pro'), coreDir: CORE,
      orchestration: { listRuns: () => ctx.orch.listRuns(), openMirrorRun: (o) => ctx.orch.openMirrorRun(o) },
    });
    slave.attach({ send: (f) => { frames.push(f); return true; }, secure: true, frameCap: 128 * 1024 });
    const reply = await slave.handleFrame({ type: 'rs:cmd', id: 'c1', op: 'member.launch', args: {
      runId: 'run-1', address: 'orch-run1-w1-x', orchestrator: { address: 'orch-run1', title: 'Big job' },
      title: 'Fix the slave app', task: 'do the thing', app: 'my-app', auth: 'subscription',
    } });
    // Pro refuses member.launch with 'unavailable' unless hookAvailable() (not exported) is true.
    assert.strictEqual(reply.ok, true, JSON.stringify(reply.error || reply));
    const { tabId, memberAddress } = reply.result;
    const s = ctx.mgr.sessions.get(tabId);
    assert.ok(s, 'core started the worker');
    assert.strictEqual(s.settings.name, memberAddress);
    assert.strictEqual(s.settings.orchestration.orchestrator, 'orch-run1');
    assert.ok(s.settings.remoteLaunch, 'Pro\'s stamp rides along');
    assert.strictEqual(fs.realpathSync(s.cwd), fs.realpathSync(path.join(appsDir, 'my-app')));
    const d = ctx.orch.describeRunById(s.settings.orchestration.runId);
    assert.strictEqual(d.mirror.key, 'master.example-8443:run-1');

    ctx.orch.report(s.instanceId, { status: 'done', summary: 'fixed it' });
    await waitFor(() => frames.some(f => f.type === 'rs:msg' && f.kind === 'report'));
    const f = frames.find(x => x.type === 'rs:msg' && x.kind === 'report');
    assert.strictEqual(f.tabId, tabId);
    assert.strictEqual(f.status, 'done');
    assert.strictEqual(f.summary, 'fixed it');

    const sub = await slave.handleFrame({ type: 'rs:cmd', id: 'c2', op: 'member.submit', args: { tabId, text: 'and the docs', from: 'orch-run1' } });
    assert.strictEqual(sub.ok, true, JSON.stringify(sub.error || sub));
    assert.strictEqual(s.submitted.at(-1).data, '[message from orch-run1@master] and the docs');
  } finally {
    slave.shutdown();
  }
});
