// A run-wide billing and model switch (orchestration.setRunAuth /
// setRunModel, ctx.orchestration's): run.json, the workers launched or
// resumed later, every live member (SDK, external, terminal) and the refusals
// that change nothing. A fake session manager stands in for the sessions.
//
//   node --test test/run-auth-model.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ExternalSession } = require('../src/external-session');

const CORE = path.join(__dirname, '..');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function tmpDir(prefix = 'vistaclair-runswitch-') {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

function fakeMgr() {
  const sessions = new Map();
  const external = new Map();
  let history = [];
  let seq = 0;
  const mk = (tabId) => ({
    tabId, instanceId: `cli-${tabId}`, running: false, busy: false, sessId: null, cwd: null, title: null, settings: {},
    getSettings() { return { ...this.settings }; },
    updateSettings(s) { Object.assign(this.settings, s); },
    writeWhenReady() {},
    write() {},
    submit() {},
    // SdkSession.setAuth / setModel, recorded.
    setAuth(auth, opts) { (this.authCalls ||= []).push([auth, opts]); this.settings.auth = auth; return { auth, applied: this.busy ? 'pending' : 'now' }; },
    async setModel(model) { (this.modelCalls ||= []).push(model); this.settings.model = model; return { ok: true, model }; },
  });
  const mgr = {
    sessions, external,
    nextTabId: () => `tab-t-${++seq}`,
    get: (tabId) => sessions.get(tabId) || null,
    getOrCreate(tabId) {
      if (!sessions.has(tabId)) sessions.set(tabId, mk(tabId));
      return sessions.get(tabId);
    },
    getByInstanceId(id) {
      for (const s of sessions.values()) if (s.instanceId === id) return s;
      return null;
    },
    spawn(tabId, cwd, cols, rows, { resumeSessionId } = {}) {
      const s = mgr.getOrCreate(tabId);
      s.running = true;
      s.cwd = cwd;
      s.sessId = resumeSessionId || crypto.randomUUID();
      mgr.saveToHistory({ sessId: s.sessId, cwd, title: s.title, settings: s.getSettings() });
    },
    launchSession(tabId, opts) {
      const s = mgr.getOrCreate(tabId);
      if (opts.title !== undefined) s.title = opts.title;
      s.updateSettings(opts.settings || {});
      if (s.settings.engine === 'sdk') { s.kind = 'sdk'; s.emitEvent = () => {}; }
      mgr.spawn(tabId, opts.cwd, opts.cols, opts.rows);
      return s;
    },
    saveToHistory(e) {
      history = history.filter(h => h.id !== e.sessId);
      history.unshift({ id: e.sessId, cwd: e.cwd, title: e.title, settings: e.settings || {} });
    },
    listSaved: () => history,
    findSaved: (id) => history.find(h => h.id === id) || null,
    forgetSaved(id) { history = history.filter(h => h.id !== id); },
    patchSavedSettings(id, fn) { const h = history.find(x => x.id === id); if (h) h.settings = fn(h.settings || {}); return !!h; },
    settingsNoted: [],
    noteSettingsChanged(s) { mgr.settingsNoted.push(s.tabId); },
    transcriptExists: () => true,
    closeQuiet(tabId) { const s = sessions.get(tabId); sessions.delete(tabId); if (s) s.running = false; },
    broadcastTabs() {},
    noteSessionState() {},
  };
  return mgr;
}

// An SDK run on the subscription: the orchestrator, a busy live worker, a
// closed worker (saved entry only) and an external member.
async function sdkRun() {
  const creds = { apiKey: true, subscription: true };
  const mgr = fakeMgr();
  const broadcaster = { broadcast() {} };
  const { createOrchestration } = require('../src/orchestration');
  const { createSessionControl } = require('../src/session-control');
  const control = createSessionControl({ mgr, broadcaster, finalizeDelayMs: 5, interruptSettleMs: 5 });
  const orch = createOrchestration({
    mgr, pendingQuestions: new Map(), coreRoot: CORE, dataHome: tmpDir('vistaclair-runswitch-home-'),
    broadcaster, control, credentials: () => creds, models: () => [], pushDebounceMs: 20, relayFallbackMs: 40,
  });
  const r = await orch.openCli({ cwd: tmpDir(), mode: 'orchestrator', engine: 'sdk', auth: 'subscription', isolation: 'none' });
  const orchSession = mgr.sessions.get(r.tabId);
  const stamp = orchSession.settings.orchestration;
  const w1 = orch.launchWorker(orchSession.instanceId, { title: 'live', task: 'x' });
  const w2 = orch.launchWorker(orchSession.instanceId, { title: 'closed', task: 'y' });
  const live = mgr.sessions.get(w1.tabId);
  live.busy = true;
  const closedId = mgr.sessions.get(w2.tabId).sessId;
  mgr.closeQuiet(w2.tabId);

  const calls = [];
  const adapter = {
    sessId: crypto.randomUUID(), kind: 'sdk', title: 'remote', running: true, busy: false, state: 'idle',
    settings: { engine: 'sdk', name: 'remote-member', orchestration: { runId: stamp.runId, role: 'worker', workerId: 'wx' } },
    submit() {}, interrupt() {}, setShowThinking() {}, historyPage() {}, kill() {}, close() {},
    async setAuth(auth, opts) { calls.push(['setAuth', auth, opts]); return { auth, applied: 'pending' }; },
    async setModel(model) { calls.push(['setModel', model]); return { ok: true, model }; },
  };
  mgr.external.set('remote-a', new ExternalSession('remote-a', adapter));
  const runFile = path.join(stamp.runDir, 'run.json');
  return { mgr, orch, creds, orchSession, stamp, runId: stamp.runId, w1, w2, live, closedId, adapter, calls, runFile, readRun: () => JSON.parse(fs.readFileSync(runFile, 'utf8')) };
}

test('setRunAuth: run.json, every live member (continueTurn passed), a closed member, and the workers launched and resumed later', async () => {
  const c = await sdkRun();
  const out = await c.orch.setRunAuth(c.runId, 'apikey', { continueTurn: true });
  assert.deepStrictEqual(out.failed, []);
  assert.deepStrictEqual(out.switched.sort(), [c.orchSession.settings.name, c.live.settings.name, 'remote-member'].sort());
  assert.strictEqual(out.sessions, 3);
  assert.deepStrictEqual(out.applied, { now: 1, pending: 2 }, 'the idle orchestrator now, the busy worker and the remote one after their turn');
  assert.deepStrictEqual(c.orchSession.authCalls, [['apikey', { continueTurn: true }]]);
  assert.deepStrictEqual(c.live.authCalls, [['apikey', { continueTurn: true }]]);
  assert.deepStrictEqual(c.calls, [['setAuth', 'apikey', { continueTurn: true }]], 'the external member through its adapter');
  assert.strictEqual(c.readRun().auth, 'apikey', 'run.json');
  assert.strictEqual(c.mgr.findSaved(c.closedId).settings.auth, 'apikey', 'a closed member resumes on it');

  const w3 = c.orch.launchWorker(c.orchSession.instanceId, { title: 'later', task: 'z' });
  assert.strictEqual(c.mgr.sessions.get(w3.tabId).settings.auth, 'apikey', 'launch_cli inherits it');
  const back = c.orch.resumeWorker(c.orchSession.instanceId, { worker: c.w2.worker, mode: 'continue' });
  assert.strictEqual(c.mgr.sessions.get(back.tabId).settings.auth, 'apikey', 'resume_worker continue inherits it');
  c.mgr.closeQuiet(back.tabId);
  const fresh = c.orch.resumeWorker(c.orchSession.instanceId, { worker: c.w2.worker, mode: 'fresh' });
  assert.strictEqual(c.mgr.sessions.get(fresh.tabId).settings.auth, 'apikey', 'resume_worker fresh inherits it');
});

test('setRunModel: run.json, every live member, a closed member, and the workers launched and resumed later', async () => {
  const c = await sdkRun();
  const out = await c.orch.setRunModel(c.runId, 'sonnet');
  assert.deepStrictEqual(out.failed, []);
  assert.deepStrictEqual(out.switched.sort(), [c.orchSession.settings.name, c.live.settings.name, 'remote-member'].sort());
  assert.strictEqual(out.model, 'sonnet');
  assert.deepStrictEqual(c.orchSession.modelCalls, ['sonnet']);
  assert.deepStrictEqual(c.live.modelCalls, ['sonnet']);
  assert.deepStrictEqual(c.calls, [['setModel', 'sonnet']]);
  const run = c.readRun();
  assert.strictEqual(run.model, 'sonnet');
  assert.strictEqual(run.orchestratorModel, 'sonnet', 'a fresh orchestrator starts on it');
  assert.deepStrictEqual(run.workers.map(w => w.model), ['sonnet', 'sonnet']);
  assert.strictEqual(c.mgr.findSaved(c.closedId).settings.model, 'sonnet');

  const w3 = c.orch.launchWorker(c.orchSession.instanceId, { title: 'later', task: 'z' });
  assert.strictEqual(c.mgr.sessions.get(w3.tabId).settings.model, 'sonnet', 'launch_cli inherits it');
  assert.strictEqual(w3.model, 'sonnet');
  const own = c.orch.launchWorker(c.orchSession.instanceId, { title: 'own', task: 'z', model: 'haiku' });
  assert.strictEqual(c.mgr.sessions.get(own.tabId).settings.model, 'haiku', 'a launch_cli model of its own wins');
  const back = c.orch.resumeWorker(c.orchSession.instanceId, { worker: c.w2.worker, mode: 'continue' });
  assert.strictEqual(c.mgr.sessions.get(back.tabId).settings.model, 'sonnet', 'resume_worker continue inherits it');
  c.mgr.closeQuiet(back.tabId);
  const fresh = c.orch.resumeWorker(c.orchSession.instanceId, { worker: c.w2.worker, mode: 'fresh' });
  assert.strictEqual(c.mgr.sessions.get(fresh.tabId).settings.model, 'sonnet', 'resume_worker fresh inherits it');
});

test('one member failing is named in failed; the others switch; a live terminal cannot change its model', async () => {
  const c = await sdkRun();
  c.live.setModel = async () => { throw new Error('query gone'); };
  c.live.setAuth = () => { throw new Error('respawn failed'); };
  c.adapter.setAuth = async () => { throw new Error('peer offline'); };
  const term = c.mgr.getOrCreate('tab-term');
  Object.assign(term, { running: true, sessId: crypto.randomUUID() });
  delete term.setAuth;
  term.settings = { engine: 'cli', name: 'term-member', orchestration: { runId: c.runId, role: 'worker', workerId: 'wt' } };

  const m = await c.orch.setRunModel(c.runId, 'opus');
  assert.deepStrictEqual(m.switched.sort(), [c.orchSession.settings.name, 'remote-member'].sort());
  const failed = Object.fromEntries(m.failed.map(f => [f.member, f.error]));
  assert.strictEqual(failed[c.live.settings.name], 'query gone');
  assert.match(failed['term-member'], /terminal cannot change its model mid-session/);
  assert.strictEqual(term.settings.model, 'opus', 'the terminal starts on it at its next launch');
  assert.strictEqual(c.readRun().model, 'opus');

  const a = await c.orch.setRunAuth(c.runId, 'apikey');
  assert.deepStrictEqual(a.switched.sort(), [c.orchSession.settings.name, 'term-member'].sort());
  assert.deepStrictEqual(a.failed.sort((x, y) => x.member.localeCompare(y.member)),
    [{ member: c.live.settings.name, error: 'respawn failed' }, { member: 'remote-member', error: 'peer offline' }].sort((x, y) => x.member.localeCompare(y.member)));
  assert.deepStrictEqual(a.applied, { now: 1, saved: 1, failed: 2 });
  assert.strictEqual(term.settings.auth, 'apikey');
  assert.strictEqual(c.readRun().auth, 'apikey');
});

test('refusals change nothing: an unknown run, an invalid value, a missing credential, a terminal run\'s billing', async () => {
  const c = await sdkRun();
  await assert.rejects(c.orch.setRunAuth('nope', 'apikey'), /run not found/);
  await assert.rejects(c.orch.setRunModel('nope', 'sonnet'), /run not found/);
  await assert.rejects(c.orch.setRunAuth(c.runId, 'credits'), /auth must be/);
  await assert.rejects(c.orch.setRunModel(c.runId, ''), /model must be a non-empty string/);
  await assert.rejects(c.orch.setRunModel(c.runId, 42), /model must be a non-empty string/);
  await assert.rejects(c.orch.setRunModel(c.runId, 'a model'), /invalid model/);

  c.creds.apiKey = false;
  const before = fs.readFileSync(c.runFile, 'utf8');
  await assert.rejects(c.orch.setRunAuth(c.runId, 'apikey', { continueTurn: true }), /^Error: No Anthropic API key is stored: add one on the Models page\.$/);
  c.creds.apiKey = true;
  c.creds.subscription = false;
  await assert.rejects(c.orch.setRunAuth(c.runId, 'subscription'), /No Claude subscription is signed in/);
  assert.strictEqual(fs.readFileSync(c.runFile, 'utf8'), before, 'run.json unchanged');
  assert.strictEqual(c.orchSession.authCalls, undefined);
  assert.strictEqual(c.live.authCalls, undefined);
  assert.strictEqual(c.live.modelCalls, undefined);
  assert.deepStrictEqual(c.calls, [], 'the external member untouched');
  assert.strictEqual(c.orchSession.settings.auth, 'subscription');
  assert.strictEqual(c.mgr.findSaved(c.closedId).settings.auth, 'subscription', 'the saved entry unchanged');
  assert.strictEqual(c.mgr.findSaved(c.closedId).settings.model, undefined);

  // A terminal run: its model switches, its billing is the claude CLI's own.
  const r = await c.orch.openCli({ cwd: tmpDir(), mode: 'orchestrator', engine: 'cli', isolation: 'none' });
  const cliRun = c.mgr.sessions.get(r.tabId).settings.orchestration.runId;
  await assert.rejects(c.orch.setRunAuth(cliRun, 'apikey'), /only an Agent SDK run/);
});

test('the add-on ctx: setRunAuth and setRunModel reach the run', async () => {
  const c = await sdkRun();
  const { createAddonCtx } = require('../src/addon-host');
  const ctx = createAddonCtx({ dataHome: tmpDir(), dashboard: { broadcaster: { broadcast() {} }, store: {}, cliSessionManager: {}, orchestration: c.orch } });
  const a = await ctx.orchestration.setRunAuth(c.runId, 'apikey', { continueTurn: true });
  assert.strictEqual(a.auth, 'apikey');
  assert.deepStrictEqual(c.orchSession.authCalls, [['apikey', { continueTurn: true }]]);
  const m = await ctx.orchestration.setRunModel(c.runId, 'haiku');
  assert.strictEqual(m.model, 'haiku');
  assert.deepStrictEqual(c.live.modelCalls, ['haiku']);
  await assert.rejects(ctx.orchestration.setRunAuth('nope', 'apikey'), /run not found/);
});
