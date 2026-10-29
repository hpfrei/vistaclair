// Orchestrator CLI sessions (src/orchestration.js): the Simple/Orchestrator ask
// behind openCli, run setup, worker launch guards, the hook decisions (caps,
// guards, report enforcement, event delivery) and worktree cleanup. A fake
// session manager stands in for the PTYs — nothing here spawns `claude`.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const CORE = path.join(__dirname, '..');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function tmpDir(prefix = 'vistaclair-orch-') {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

function fakeMgr() {
  const sessions = new Map();
  const launches = [];
  const writes = [];
  const submits = [];        // { tabId, data, opts }
  const emitted = [];        // SDK panel events: { tabId, ev }
  let history = [];          // newest first, like cli-sessions
  const closed = [];
  let seq = 0;
  const mk = (tabId) => ({
    tabId, instanceId: `cli-${tabId}`, running: false, busy: false, sessId: null, cwd: null, title: null, settings: {},
    getSettings() { return { ...this.settings }; },
    updateSettings(s) { Object.assign(this.settings, s); },
    writeWhenReady(data) { writes.push({ tabId, data }); },
    write(data) { writes.push({ tabId, data }); },
    // CliSession.submit: the text, then the CR.
    submit(data, opts) { submits.push({ tabId, data, opts }); writes.push({ tabId, data }); writes.push({ tabId, data: '\r' }); },
    // SdkSession.seedCost: a resumed member's carried-over cost.
    seedCost(usd) { this.seeded = usd; },
  });
  const mgr = {
    sessions, launches, writes, closed, submits, emitted,
    get history() { return history; },
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
      if (opts.hidden != null) s.hidden = opts.hidden;
      // An SDK session (src/sdk-session.js) has a panel: events land there.
      if (s.settings.engine === 'sdk') {
        s.kind = 'sdk';
        s.emitEvent = (ev) => emitted.push({ tabId, ev });
      }
      mgr.spawn(tabId, opts.cwd, opts.cols, opts.rows);
      launches.push({ tabId, opts });
      if (opts.prompt && opts.autoSubmit) writes.push({ tabId, data: opts.prompt });
      return s;
    },
    saveToHistory(e) {
      const prev = history.find(h => h.id === e.sessId);
      history = history.filter(h => h.id !== e.sessId);
      const f = e.flags || {};
      history.unshift({ id: e.sessId, cwd: e.cwd, title: e.title, settings: e.settings || {}, startedAt: prev?.startedAt || Date.now(), ...(f.paused ? { paused: true } : {}), ...(f.interrupted ? { interrupted: true } : {}) });
    },
    listSaved: () => history,
    findSaved: (id) => history.find(h => h.id === id) || null,
    forgetSaved(id) { history = history.filter(h => h.id !== id); },
    patchSavedSettings(id, fn) { const h = history.find(x => x.id === id); if (h) h.settings = fn(h.settings || {}); return !!h; },
    settingsNoted: [],
    noteSettingsChanged(s) { mgr.settingsNoted.push(s.tabId); },
    deleteSavedSession(id) { history = history.filter(h => h.id !== id); },
    lost: new Set(),        // sessIds whose transcript was deleted
    transcriptExists: (cwd, id) => !mgr.lost.has(id),
    closeReasons: [],
    closeQuiet(tabId, reason) { const s = sessions.get(tabId); sessions.delete(tabId); if (s) { s.running = false; closed.push(tabId); mgr.closeReasons.push(reason); } },
    broadcastTabs() {},
    noteSessionState() {},
  };
  return mgr;
}

function setup(extra = {}) {
  const mgr = fakeMgr();
  const broadcasts = [];
  const pendingQuestions = new Map();
  const broadcaster = { broadcast: (m) => broadcasts.push(m) };
  const { createOrchestration } = require('../src/orchestration');
  const { createSessionControl } = require('../src/session-control');
  const control = createSessionControl({ mgr, broadcaster, finalizeDelayMs: 5, interruptSettleMs: 5 });
  const orch = createOrchestration({
    mgr, pendingQuestions, coreRoot: CORE, dataHome: tmpDir('vistaclair-orch-home-'),
    broadcaster, control,
    // An API key and no subscription: an SDK session's billing is never asked.
    credentials: () => ({ apiKey: true, subscription: false }),
    models: () => [],
    pushDebounceMs: 20,
    relayFallbackMs: 40,
    ...extra,
  });
  return { mgr, orch, control, broadcasts, pendingQuestions };
}

function answer(pendingQuestions, value) {
  const [entry] = pendingQuestions.values();
  assert.ok(entry, 'a question is pending');
  entry.resolve(value === null
    ? [{ id: '_cancelled', question: '', answer: 'cancelled' }]
    : [{ id: 'mode', question: 'x', answer: value }]);
}

async function openOrchestrator(t, opts = {}) {
  const ctx = setup();
  const cwd = opts.cwd || tmpDir();
  const r = await ctx.orch.openCli({ cwd, mode: 'orchestrator', engine: 'cli', ...opts });
  const orchSession = ctx.mgr.sessions.get(r.tabId);
  const stamp = orchSession.settings.orchestration;
  return { ...ctx, cwd, r, orchSession, stamp, run: () => ctx.orch.getRun(stamp.runId) };
}

const hook = (orch, session, input) => orch.handleHook(session.instanceId, input);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

test('openCli without a mode: a terminal asks, and the answer decides the launch', async () => {
  const { mgr, orch, pendingQuestions, broadcasts } = setup();
  const cwd = tmpDir();

  const simple = orch.openCli({ cwd, engine: 'cli' });
  const ask = broadcasts.find(m => m.type === 'ask:question');
  assert.ok(ask, 'the ask is broadcast');
  // The dashboard builds the form from formData.questions (askFormBuildHTML).
  // The engine is never a question.
  assert.deepStrictEqual(ask.forms[0].formData.questions.map(q => q.options.map(o => o.label)), [['Simple CLI', 'Orchestrator CLI']]);
  // The form defaults to an orchestrator.
  assert.deepStrictEqual(ask.forms[0].formData.questions.map(q => q.defaultValue), ['Orchestrator CLI']);
  assert.strictEqual(ask.forms[0].formData.newCli.given.engine, 'cli', 'the dialog is told the engine, not asked it');
  assert.strictEqual(ask.forms[0].formData.description, undefined, 'a terminal has no billing');
  assert.deepStrictEqual([...pendingQuestions.values()][0].message, ask, 'the entry keeps its broadcast for replay on reconnect');
  answer(pendingQuestions, 'Simple CLI');
  const s = await simple;
  assert.strictEqual(s.mode, 'simple');
  assert.strictEqual(s.engine, 'cli');
  assert.strictEqual(mgr.sessions.get(s.tabId).settings.orchestration, undefined);
  assert.strictEqual(pendingQuestions.size, 0, 'the answered question is gone');

  const cancelled = orch.openCli({ cwd, engine: 'cli' });
  answer(pendingQuestions, null);
  assert.deepStrictEqual(await cancelled, { cancelled: true });
  assert.strictEqual(mgr.launches.length, 1, 'cancel launches nothing');

  const o = orch.openCli({ cwd, engine: 'cli' });
  const dup = await orch.openCli({ cwd, engine: 'cli' });
  assert.strictEqual(dup.duplicate, true, 'a second open of the same target joins the pending ask');
  answer(pendingQuestions, 'Orchestrator CLI');
  const res = await o;
  assert.strictEqual(res.mode, 'orchestrator');
  const st = mgr.sessions.get(res.tabId).settings;
  assert.strictEqual(st.orchestration.role, 'orchestrator');
  assert.match(st.name, /^orch-[0-9a-f]{6}$/);
  assert.match(st.appendSystemPrompt, /You are the ORCHESTRATOR/);
  // Its TODO lives in its session folder, not in the run directory.
  assert.ok(st.appendSystemPrompt.includes(path.join(st.sessionDir, 'TODO.md')));
  assert.strictEqual(path.basename(st.sessionDir), st.name);
  // A worker's report is trusted: the card never asks for re-verification.
  assert.match(st.appendSystemPrompt, /"done" report is trusted/);
  assert.ok(!/have a worker \(or a separate reviewer worker\) run the tests/.test(st.appendSystemPrompt));
});

test('openCli with a mode and an engine never asks', async () => {
  const { orch, pendingQuestions, broadcasts } = setup();
  const r = await orch.openCli({ cwd: tmpDir(), mode: 'simple', engine: 'cli' });
  assert.strictEqual(r.mode, 'simple');
  assert.strictEqual(r.engine, 'cli');
  assert.strictEqual(pendingQuestions.size, 0);
  assert.ok(!broadcasts.some(m => m.type === 'ask:question'));
});

test('openCli: an Agent SDK session is an orchestrator, never asked Simple, a resume included; an explicit simple is kept', async () => {
  let creds = { apiKey: true, subscription: false };
  const { mgr, orch, pendingQuestions, broadcasts } = setup({ credentials: () => creds });
  const cwd = tmpDir();
  const reply = (answers) => [...pendingQuestions.values()][0].resolve(Object.entries(answers).map(([id, answer]) => ({ id, question: 'x', answer })));
  const asks = () => broadcasts.filter(m => m.type === 'ask:question');

  // SDK (the default, or named) and no mode: an orchestrator, nothing asked.
  for (const opts of [{}, { engine: 'sdk' }, { settings: { engine: 'sdk' } }]) {
    const r = await orch.openCli({ cwd, ...opts });
    assert.deepStrictEqual({ mode: r.mode, engine: r.engine, auth: r.auth }, { mode: 'orchestrator', engine: 'sdk', auth: 'apikey' });
    assert.strictEqual(mgr.sessions.get(r.tabId).settings.orchestration.role, 'orchestrator');
  }
  assert.strictEqual(asks().length, 0);

  // An explicit simple is honoured (Pro's tools edit, APP.md recreate).
  const rs = await orch.openCli({ cwd, mode: 'simple', engine: 'sdk' });
  assert.strictEqual(rs.mode, 'simple');
  assert.strictEqual(mgr.sessions.get(rs.tabId).settings.orchestration, undefined);

  // A terminal still asks Simple / Orchestrator.
  const t = orch.openCli({ cwd, engine: 'cli' });
  assert.deepStrictEqual(asks().at(-1).forms[0].formData.questions.map(q => q.id), ['mode']);
  reply({ mode: 'Simple CLI' });
  assert.strictEqual((await t).mode, 'simple');

  // Both credentials: billing alone; the dialog is told the mode, so it offers no Simple.
  creds = { apiKey: true, subscription: true };
  const b = orch.openCli({ cwd });
  const fd = asks().at(-1).forms[0].formData;
  assert.deepStrictEqual(fd.questions.map(q => q.id), ['auth']);
  assert.ok(!JSON.stringify(fd.questions).includes('Simple CLI'));
  assert.strictEqual(fd.newCli.given.mode, 'orchestrator');
  reply({ auth: 'API key' });
  const rb = await b;
  assert.deepStrictEqual({ mode: rb.mode, auth: rb.auth }, { mode: 'orchestrator', auth: 'apikey' });

  // A resume (Pro's app Change on an app with content) is an orchestrator too,
  // unasked: the role starts a fresh transcript, so the resume is dropped. An
  // explicit simple keeps it.
  creds = { apiKey: true, subscription: false };
  const before = asks().length;
  for (const spawnOpts of [{ resume: true }, { resumeSessionId: crypto.randomUUID() }]) {
    const rr = await orch.openCli({ cwd, engine: 'sdk', spawnOpts });
    assert.strictEqual(rr.mode, 'orchestrator');
    assert.strictEqual(mgr.sessions.get(rr.tabId).settings.orchestration.role, 'orchestrator');
    assert.deepStrictEqual(mgr.launches.at(-1).opts.spawnOpts, {}, 'the resume is dropped');
    const rk = await orch.openCli({ cwd, engine: 'sdk', mode: 'simple', spawnOpts });
    assert.strictEqual(mgr.sessions.get(rk.tabId).settings.orchestration, undefined);
    assert.deepStrictEqual(mgr.launches.at(-1).opts.spawnOpts, spawnOpts, 'an explicit simple keeps the resume');
  }
  assert.strictEqual(asks().length, before, 'nothing asked');
});

test('openCli never asks the engine: the Agent SDK panel, a terminal by the fallbackEngine pref, or the caller\'s', async () => {
  const dataHome = tmpDir('vistaclair-orch-home-');
  const { mgr, orch, pendingQuestions, broadcasts } = setup({ dataHome });
  const cwd = tmpDir();
  const reply = (answers) => [...pendingQuestions.values()][0].resolve(Object.entries(answers).map(([id, answer]) => ({ id, question: 'x', answer })));
  const lastAsk = () => broadcasts.filter(m => m.type === 'ask:question').at(-1);

  // The mode given, one credential: nothing to ask; the SDK panel on it.
  const ra = await orch.openCli({ cwd, mode: 'simple' });
  assert.deepStrictEqual({ mode: ra.mode, engine: ra.engine, auth: ra.auth }, { mode: 'simple', engine: 'sdk', auth: 'apikey' });
  assert.strictEqual(mgr.sessions.get(ra.tabId).settings.engine, 'sdk');
  assert.ok(!broadcasts.some(m => m.type === 'ask:question'));

  const rb = await orch.openCli({ cwd });
  assert.ok(!broadcasts.some(m => m.type === 'ask:question'), 'a new SDK session is an orchestrator, unasked');
  assert.deepStrictEqual({ mode: rb.mode, engine: rb.engine }, { mode: 'orchestrator', engine: 'sdk' });
  assert.strictEqual(orch.getRun(mgr.sessions.get(rb.tabId).settings.orchestration.runId).engine, 'sdk');

  // The fallback pref (app-prefs fallbackEngine) makes new sessions terminals.
  const caps = require('../src/capabilities');
  assert.strictEqual(caps.getFallbackEnginePref(dataHome), 'sdk', 'unset is the SDK');
  assert.strictEqual(caps.setFallbackEnginePref(dataHome, 'terminal'), true);
  assert.strictEqual(caps.setFallbackEnginePref(dataHome, 'pty'), false);
  const rc = await orch.openCli({ cwd, mode: 'simple' });
  assert.deepStrictEqual({ engine: rc.engine, auth: rc.auth }, { engine: 'cli', auth: null });
  assert.strictEqual(mgr.sessions.get(rc.tabId).settings.engine, 'cli');
  const d = orch.openCli({ cwd });
  assert.strictEqual(lastAsk().forms[0].formData.newCli.given.engine, 'cli');
  reply({ mode: 'Orchestrator CLI', engine: 'Agent SDK panel' });
  const rd = await d;
  assert.strictEqual(rd.engine, 'cli', 'an engine answer is ignored');
  assert.strictEqual(orch.getRun(mgr.sessions.get(rd.tabId).settings.orchestration.runId).engine, 'cli');

  // A caller (Pro, a resume) may still name either engine, whatever the pref.
  assert.strictEqual((await orch.openCli({ cwd, mode: 'simple', settings: { engine: 'sdk' } })).engine, 'sdk');
  caps.setFallbackEnginePref(dataHome, 'sdk');
  assert.deepStrictEqual(caps.readAppPrefs(dataHome), {}, 'back to the default leaves no key behind');
  assert.strictEqual((await orch.openCli({ cwd, mode: 'simple', engine: 'cli' })).engine, 'cli');
  assert.strictEqual((await orch.openCli({ cwd, mode: 'simple' })).engine, 'sdk');
});

test('openCli: an SDK session\'s billing is asked only when both credentials exist; a run\'s workers inherit it', async () => {
  let creds = { apiKey: true, subscription: true };
  const { mgr, orch, pendingQuestions, broadcasts } = setup({ credentials: () => creds });
  const cwd = tmpDir();
  const reply = (answers) => [...pendingQuestions.values()][0].resolve(Object.entries(answers).map(([id, answer]) => ({ id, question: 'x', answer })));
  const lastAsk = () => broadcasts.filter(m => m.type === 'ask:question').at(-1);

  // A new SDK session: an orchestrator, its billing asked alone.
  const a = orch.openCli({ cwd });
  const qs = lastAsk().forms[0].formData.questions;
  assert.deepStrictEqual(qs.map(q => q.id), ['auth']);
  assert.strictEqual(qs[0].showIf, undefined);
  assert.deepStrictEqual(qs[0].options.map(o => o.label), ['API key', 'Claude subscription']);
  assert.strictEqual(qs[0].defaultValue, 'Claude subscription');
  reply({ auth: 'Claude subscription' });
  const ra = await a;
  assert.deepStrictEqual({ engine: ra.engine, auth: ra.auth }, { engine: 'sdk', auth: 'subscription' });
  const orchSession = mgr.sessions.get(ra.tabId);
  assert.strictEqual(orchSession.settings.auth, 'subscription');
  assert.strictEqual(orch.getRun(orchSession.settings.orchestration.runId).auth, 'subscription');
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  assert.strictEqual(mgr.sessions.get(w.tabId).settings.auth, 'subscription', 'a worker inherits the run\'s billing');

  // A CLI terminal carries no billing, and is not asked it.
  const b = orch.openCli({ cwd, engine: 'cli' });
  assert.deepStrictEqual(lastAsk().forms[0].formData.questions.map(q => q.id), ['mode']);
  reply({ mode: 'Simple CLI', auth: 'Claude subscription' });
  const rb = await b;
  assert.strictEqual(rb.auth, null);
  assert.strictEqual(mgr.sessions.get(rb.tabId).settings.auth, undefined);

  // Mode and SDK engine given: a form with billing alone; an unanswered one is the subscription.
  const c = orch.openCli({ cwd, mode: 'simple', engine: 'sdk' });
  assert.deepStrictEqual(lastAsk().forms[0].formData.questions.map(q => q.id), ['auth']);
  assert.strictEqual(lastAsk().forms[0].formData.questions[0].showIf, undefined);
  assert.strictEqual(lastAsk().forms[0].formData.questions[0].defaultValue, 'Claude subscription');
  reply({});
  assert.strictEqual((await c).auth, 'subscription');
  const c2 = orch.openCli({ cwd, mode: 'simple', engine: 'sdk' });
  reply({ auth: 'API key' });
  assert.strictEqual((await c2).auth, 'apikey');

  // Billing given, or a CLI terminal: never asked.
  const asks = broadcasts.filter(m => m.type === 'ask:question').length;
  assert.strictEqual((await orch.openCli({ cwd, mode: 'simple', engine: 'sdk', auth: 'subscription' })).auth, 'subscription');
  assert.strictEqual((await orch.openCli({ cwd, mode: 'simple', engine: 'cli' })).auth, null);
  assert.strictEqual(broadcasts.filter(m => m.type === 'ask:question').length, asks);

  // Only the subscription: nothing left to ask; the session is pinned to it.
  creds = { apiKey: false, subscription: true };
  const asked = broadcasts.filter(m => m.type === 'ask:question').length;
  const rd = await orch.openCli({ cwd, engine: 'sdk' });
  assert.strictEqual(broadcasts.filter(m => m.type === 'ask:question').length, asked, 'nothing left to ask');
  assert.strictEqual(mgr.sessions.get(rd.tabId).settings.auth, 'subscription');
});

test('the New CLI dialog: its payload, the orchestrator model and a run-wide model routing', async () => {
  const catalog = [
    { name: 'gpt-x', label: 'GPT X', providerKey: 'openai', apiKey: 'sk-secret', contextWindow: 400000, inputCostPerMTok: 1, outputCostPerMTok: 4, usable: true },
    { name: 'old', label: 'Old', providerKey: 'openai', apiKey: 'sk-secret', usable: true, lifecycle: 'retired' },
    { name: 'nokey', label: 'No key', providerKey: 'google', usable: false, unusableReason: 'no-credential' },
  ];
  // Both credentials: a new SDK session's dialog asks the billing.
  const { mgr, orch, pendingQuestions, broadcasts } = setup({ models: () => catalog, credentials: () => ({ apiKey: true, subscription: true }) });
  const cwd = tmpDir();
  const reply = (answers) => [...pendingQuestions.values()][0].resolve(Object.entries(answers).map(([id, answer]) => ({ id, question: 'x', answer })));
  const lastAsk = () => broadcasts.filter(m => m.type === 'ask:question').at(-1);

  const a = orch.openCli({ cwd });
  const fd = lastAsk().forms[0].formData;
  assert.strictEqual(fd.kind, 'new-cli', 'the dashboard draws its own dialog');
  assert.deepStrictEqual(fd.newCli.orchestratorModels.map(m => m.value), ['opus[1m]', 'fable[1m]']);
  assert.strictEqual(fd.newCli.orchestratorModel, 'opus[1m]');
  assert.strictEqual(fd.newCli.maxWorkers, 5);
  assert.deepStrictEqual(fd.newCli.remapTargets.map(m => m.name), ['gpt-x'], 'only usable, unretired targets');
  assert.ok(!JSON.stringify(lastAsk()).includes('sk-secret'), 'no key reaches the dashboard');
  assert.deepStrictEqual(fd.questions.map(q => q.id), ['auth'], 'the generic fallback asks the billing alone');
  assert.strictEqual(fd.newCli.given.mode, 'orchestrator', 'the dialog draws no Session type');
  reply({
    auth: 'Claude subscription', model: 'fable[1m]',
    modelMap: { sonnet: 'gpt-x', haiku: 'nokey', opus: '', bogus: 'gpt-x' },
  });
  const ra = await a;
  assert.strictEqual(ra.model, 'fable[1m]');
  assert.deepStrictEqual(ra.modelMap, { fable: null, opus: null, sonnet: 'gpt-x', haiku: null }, 'unknown families and unusable targets are dropped');
  const orchSession = mgr.sessions.get(ra.tabId);
  assert.strictEqual(orchSession.settings.model, 'fable[1m]');
  assert.deepStrictEqual(orchSession.settings.modelMap, ra.modelMap);
  const run = orch.getRun(orchSession.settings.orchestration.runId);
  assert.strictEqual(run.orchestratorModel, 'fable[1m]', 'a refresh or a fresh start keeps the model');
  const w = mgr.sessions.get(orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' }).tabId);
  assert.deepStrictEqual(w.settings.modelMap, ra.modelMap, 'the routing covers the run\'s workers');
  assert.strictEqual(w.settings.model, undefined, 'a worker never inherits the orchestrator\'s model');

  // A simple CLI takes the routing, never a model; a model not offered, or
  // nothing routed, leaves both unset.
  const b = orch.openCli({ cwd, mode: 'simple' });
  reply({ model: 'fable[1m]', modelMap: JSON.stringify({ opus: 'gpt-x' }) });
  const rb = await b;
  assert.strictEqual(rb.model, undefined);
  assert.strictEqual(mgr.sessions.get(rb.tabId).settings.model, undefined);
  assert.strictEqual(mgr.sessions.get(rb.tabId).settings.modelMap.opus, 'gpt-x');
  const c = orch.openCli({ cwd });
  reply({ model: 'sonnet', modelMap: { opus: '' } });
  const rc = await c;
  const sc = mgr.sessions.get(rc.tabId).settings;
  assert.strictEqual(sc.model, undefined);
  assert.strictEqual(sc.modelMap, undefined);
  assert.strictEqual(orch.getRun(sc.orchestration.runId).orchestratorModel, null);
});

test('a run-wide model map: every live member, a closed member\'s saved entry, and the workers launched later', async (t) => {
  const catalog = [
    { name: 'gpt-x', label: 'GPT X', providerKey: 'openai', usable: true },
    { name: 'old', label: 'Old', providerKey: 'openai', usable: true, lifecycle: 'retired' },
  ];
  const { mgr, orch } = setup({ models: () => catalog });
  const r = await orch.openCli({ cwd: tmpDir(), mode: 'orchestrator', engine: 'sdk', isolation: 'none' });
  const orchSession = mgr.sessions.get(r.tabId);
  const { runId } = orchSession.settings.orchestration;
  const w1 = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  const w2 = orch.launchWorker(orchSession.instanceId, { title: 'b', task: 'y' });
  const w2Id = mgr.sessions.get(w2.tabId).sessId;
  mgr.closeQuiet(w2.tabId, 'closed');

  const out = orch.setRunModelMap(runId, { opus: 'gpt-x', sonnet: 'old', haiku: '', bogus: 'gpt-x' });
  const want = { fable: null, opus: 'gpt-x', sonnet: null, haiku: null };
  assert.deepStrictEqual(out, { runId, modelMap: want, sessions: 2 }, 'retired targets and unknown families are dropped');
  assert.deepStrictEqual(orchSession.settings.modelMap, want);
  assert.deepStrictEqual(mgr.sessions.get(w1.tabId).settings.modelMap, want);
  assert.deepStrictEqual(mgr.settingsNoted.sort(), [r.tabId, w1.tabId].sort(), 'the manifest, saved entry and tabs follow');
  assert.deepStrictEqual(mgr.findSaved(w2Id).settings.modelMap, want, 'a closed member resumes with it');
  assert.deepStrictEqual(orch.getRun(runId).base.stamps.modelMap, want);

  const w3 = orch.launchWorker(orchSession.instanceId, { title: 'c', task: 'z' });
  assert.deepStrictEqual(mgr.sessions.get(w3.tabId).settings.modelMap, want, 'a worker launched later inherits it');

  // An empty map routes nothing, run-wide.
  const cleared = orch.setRunModelMap(runId, {});
  assert.deepStrictEqual(cleared.modelMap, { fable: null, opus: null, sonnet: null, haiku: null });
  assert.deepStrictEqual(mgr.sessions.get(w3.tabId).settings.modelMap, cleared.modelMap);
  assert.throws(() => orch.setRunModelMap(runId, null), /modelMap must be an object/);
  assert.throws(() => orch.setRunModelMap('nope', {}), /run not found/);
});

test('an orchestrator run keeps the caller prompt, stamps and hooks, and adds its own', async (t) => {
  const cwd = tmpDir();
  const baseFile = path.join(cwd, 'hooks.json');
  fs.writeFileSync(baseFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read|Bash', hooks: [{ type: 'command', command: 'ledger' }] }] } }));
  const { orchSession, stamp, mgr, orch } = await openOrchestrator(t, {
    cwd, runsDir: path.join(cwd, '.vistaclair', 'orchestrator'), isolation: 'none',
    settings: { appendSystemPrompt: 'BASE PROMPT', settingsFile: baseFile, changeApp: 'demo' },
  });
  const st = orchSession.settings;
  assert.ok(st.appendSystemPrompt.startsWith('BASE PROMPT'));
  assert.strictEqual(st.changeApp, 'demo');
  assert.ok(stamp.runDir.startsWith(path.join(cwd, '.vistaclair', 'orchestrator')));
  assert.ok(fs.existsSync(path.join(st.sessionDir, 'TODO.md')));
  assert.ok(fs.existsSync(path.join(st.sessionDir, 'NOTES.md')));

  const settings = JSON.parse(fs.readFileSync(st.settingsFile, 'utf8'));
  assert.strictEqual(settings.crossSessionInbound, 'accept');
  assert.strictEqual(settings.hooks.PreToolUse[0].hooks[0].command, 'ledger', 'the base hook is kept, first');
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop']) {
    assert.ok(settings.hooks[ev].some(h => h.hooks[0].command.includes('orchestration-hook.js')), ev);
  }

  // Workers inherit the base prompt and stamps (Pro's changeApp), not the role.
  const w = orch.launchWorker(orchSession.instanceId, { title: 'Fix login', task: 'do it' });
  const ws = mgr.sessions.get(w.tabId).settings;
  assert.strictEqual(ws.changeApp, 'demo');
  assert.ok(ws.appendSystemPrompt.startsWith('BASE PROMPT'));
  assert.match(ws.appendSystemPrompt, /You are a WORKER CLI launched by the orchestrator `orch-/);
  assert.ok(!/You are the ORCHESTRATOR/.test(ws.appendSystemPrompt));
  // The card overrides the base prompt's user-facing and project-wide steps.
  assert.match(ws.appendSystemPrompt, /tell the session to ask the user, ask `orch-[0-9a-f]{6}` instead/);
  assert.match(st.appendSystemPrompt, /that is workers' work: put it in a brief/);
  assert.strictEqual(ws.orchestration.role, 'worker');
  assert.match(ws.name, new RegExp(`^${st.name}-w1-fix-login$`));
  assert.deepStrictEqual(Object.keys(ws.agents), ['coder', 'explorer']);
  assert.strictEqual(ws.agents.coder.model, 'opus');
  assert.strictEqual(ws.agents.explorer.model, 'sonnet');
  assert.strictEqual(mgr.launches.at(-1).opts.autoSubmit, true);
  assert.strictEqual(mgr.launches.at(-1).opts.prompt, 'do it');

  // launch_cli `model`: the worker runs on it (kept for a fresh relaunch); anything else is refused.
  const h = orch.launchWorker(orchSession.instanceId, { title: 'Docs', task: 'x', model: 'haiku' });
  assert.strictEqual(mgr.sessions.get(h.tabId).settings.model, 'haiku');
  assert.strictEqual(orch.listWorkers(orchSession.instanceId).workers.find(x => x.name === h.worker).model, 'haiku');
  assert.throws(() => orch.launchWorker(orchSession.instanceId, { title: 'bad', task: 'x', model: 'gpt' }), /model must be one of fable, opus, sonnet, haiku/);
});

test('launch_cli guards: orchestrator only, at most 5 running, cwd inside the root', async (t) => {
  const { orch, orchSession, mgr, cwd } = await openOrchestrator(t, { isolation: 'none' });
  const ids = [1, 2, 3, 4, 5].map(i => orch.launchWorker(orchSession.instanceId, { title: `t${i}`, task: 'x' }));
  assert.throws(() => orch.launchWorker(orchSession.instanceId, { title: 't6', task: 'x' }), /5 workers are running/);
  mgr.sessions.get(ids[0].tabId).running = false;
  assert.doesNotThrow(() => orch.launchWorker(orchSession.instanceId, { title: 't6', task: 'x' }), 'an exited worker frees its slot');

  assert.throws(() => orch.launchWorker(mgr.sessions.get(ids[1].tabId).instanceId, { title: 'w', task: 'x' }), /only an orchestrator/);
  mgr.sessions.get(ids[1].tabId).running = false;
  assert.throws(() => orch.launchWorker(orchSession.instanceId, { title: 'out', task: 'x', cwd: path.dirname(cwd) }), /inside the run root/);
});

test('subagent cap, Workflow ban and the orchestrator edit guard', async (t) => {
  const { orch, orchSession, stamp } = await openOrchestrator(t, { isolation: 'none' });
  const pre = (tool, tool_input = {}) => hook(orch, orchSession, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input, cwd: '/' });

  for (let i = 0; i < 3; i++) assert.deepStrictEqual(pre('Agent'), {});
  assert.strictEqual(pre('Agent').exitCode, 2, 'the 4th running subagent is denied');
  hook(orch, orchSession, { hook_event_name: 'SubagentStop', agent_id: 'a1' });
  assert.deepStrictEqual(pre('Agent'), {}, 'a finished subagent frees its slot');
  hook(orch, orchSession, { hook_event_name: 'SessionStart', source: 'resume' });
  assert.deepStrictEqual(pre('Agent'), {}, 'a resume resets the counter');

  assert.strictEqual(pre('Workflow').exitCode, 2);
  assert.strictEqual(pre('Write', { file_path: '/etc/project/file.js' }).exitCode, 2);
  assert.deepStrictEqual(pre('Edit', { file_path: path.join(stamp.runDir, 'TODO.md') }), {});
});

test('a worker must report before it stops; an unreported stop becomes an idle event', async (t) => {
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none' });
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  const wSession = mgr.sessions.get(w.tabId);
  const stop = (extra = {}) => hook(orch, wSession, { hook_event_name: 'Stop', last_assistant_message: 'I am finished', ...extra });

  hook(orch, wSession, { hook_event_name: 'UserPromptSubmit' });
  assert.strictEqual(stop({ background_tasks: [{ id: 'x' }] }).stdout, undefined, 'background work running: not idle');
  const nudge = JSON.parse(stop().stdout);
  assert.strictEqual(nudge.decision, 'block');
  assert.match(nudge.reason, /report to the orchestrator/);
  assert.deepStrictEqual(stop({ stop_hook_active: true }), {});
  assert.strictEqual(run().events.at(-1).kind, 'idle');

  // A message to a sibling worker is not a report; one to the orchestrator is.
  hook(orch, wSession, { hook_event_name: 'UserPromptSubmit' });
  hook(orch, wSession, { hook_event_name: 'PostToolUse', tool_name: 'SendMessage', tool_input: { to: `${orchSession.settings.name}-w2-other` } });
  assert.strictEqual(JSON.parse(stop().stdout).decision, 'block');
  hook(orch, wSession, { hook_event_name: 'UserPromptSubmit' });
  hook(orch, wSession, { hook_event_name: 'PostToolUse', tool_name: 'SendMessage', tool_input: { to: orchSession.settings.name } });
  assert.deepStrictEqual(stop(), {});
});

test('events reach a busy orchestrator through its hooks and wake an idle one', async (t) => {
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none' });
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  const wSession = mgr.sessions.get(w.tabId);

  // Busy: the report is attached to its next tool result, then not again.
  hook(orch, orchSession, { hook_event_name: 'UserPromptSubmit' });
  orch.report(wSession.instanceId, { status: 'done', summary: 'login fixed', filesChanged: ['a.js'] });
  const post = JSON.parse(hook(orch, orchSession, { hook_event_name: 'PostToolUse', tool_name: 'Read' }).stdout);
  assert.match(post.hookSpecificOutput.additionalContext, /reported done: login fixed/);
  assert.deepStrictEqual(hook(orch, orchSession, { hook_event_name: 'PostToolUse', tool_name: 'Read' }), {});
  assert.deepStrictEqual(hook(orch, orchSession, { hook_event_name: 'Stop' }), {}, 'nothing pending: it may go idle');
  assert.strictEqual(run().busy, false);

  // Idle: an exit is typed into its tab as a one-line notice, once.
  orch.onSessionExit(w.tabId, wSession);
  await wait(60);
  const typed = mgr.writes.filter(x => x.tabId === orchSession.tabId);
  assert.strictEqual(typed.length, 2);
  assert.match(typed[0].data, /\[orchestration\] 1 worker event/);
  assert.strictEqual(typed[1].data, '\r');
  const ups = JSON.parse(hook(orch, orchSession, { hook_event_name: 'UserPromptSubmit' }).stdout);
  assert.match(ups.hookSpecificOutput.additionalContext, /\[exited\]/);

  // An event during a turn that would end: Stop blocks with it.
  orch.report(wSession.instanceId, { status: 'failed', summary: 'tests red' });
  const stop = JSON.parse(hook(orch, orchSession, { hook_event_name: 'Stop' }).stdout);
  assert.strictEqual(stop.decision, 'block');
  assert.match(stop.reason, /tests red/);
});

test('compaction and resume re-inject the role and the TODO', async (t) => {
  const { orch, orchSession, mgr } = await openOrchestrator(t, { isolation: 'none' });
  fs.appendFileSync(path.join(orchSession.settings.sessionDir, 'TODO.md'), '| 1 | w1 | running | — | wait |\n');
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'THE ORIGINAL BRIEF' });

  assert.deepStrictEqual(hook(orch, orchSession, { hook_event_name: 'SessionStart', source: 'startup' }), {});
  const o = JSON.parse(hook(orch, orchSession, { hook_event_name: 'SessionStart', source: 'compact' }).stdout);
  assert.strictEqual(o.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(o.hookSpecificOutput.additionalContext, /You are the ORCHESTRATOR/);
  assert.match(o.hookSpecificOutput.additionalContext, /\| 1 \| w1 \| running/);
  assert.ok(o.hookSpecificOutput.additionalContext.length < 10000);

  const wc = JSON.parse(hook(orch, mgr.sessions.get(w.tabId), { hook_event_name: 'SessionStart', source: 'compact' }).stdout);
  assert.match(wc.hookSpecificOutput.additionalContext, /THE ORIGINAL BRIEF/);
  assert.match(wc.hookSpecificOutput.additionalContext, new RegExp(`launched by \`${orchSession.settings.name}\``));
});

test('worktree isolation: a branch per worker, end_run removes merged ones', async (t) => {
  const repo = tmpDir('vistaclair-orch-repo-');
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  g('init', '-q'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');

  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { cwd: repo });
  assert.strictEqual(run().isolation, 'worktree', 'a git root defaults to worktrees');
  assert.ok(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8').includes('/.orchestrator/'));
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  assert.match(w.branch, /^orch\/[0-9a-f]{6}\/w1$/);
  assert.ok(fs.existsSync(w.cwd));
  assert.match(mgr.sessions.get(w.tabId).settings.appendSystemPrompt, /git worktree/);

  assert.deepStrictEqual(orch.endRun(orchSession.instanceId).kept.map(k => k.reason), ['still running']);
  mgr.sessions.get(w.tabId).running = false;
  const res = orch.endRun(orchSession.instanceId);
  assert.deepStrictEqual(res.removed, [w.worker]);
  assert.strictEqual(res.closed, true);
  assert.ok(!fs.existsSync(w.cwd));
});

// --- Pause, resume, refresh, close and delete (with the real session control) ---

const writeResume = (session, text = 'next: step 2') =>
  fs.writeFileSync(path.join(session.settings.sessionDir, 'NOTES.md'), `# Notes\n\n## Resume\n\n${text}\n`);
const typedInto = (mgr, tabId) => mgr.writes.filter(x => x.tabId === tabId).map(x => x.data).join('\n');
const ctxOf = (r) => JSON.parse(r.stdout || '{}').hookSpecificOutput?.additionalContext || '';
const blockOf = (r) => { const o = JSON.parse(r.stdout || '{}'); return o.decision === 'block' ? o.reason : null; };

test('pausing a run: the orchestrator relays, workers write notes and close, the orchestrator closes last', async (t) => {
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none' });
  const w1 = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'brief A' });
  const w2 = orch.launchWorker(orchSession.instanceId, { title: 'b', task: 'brief B' });
  const s1 = mgr.sessions.get(w1.tabId);
  const s2 = mgr.sessions.get(w2.tabId);
  assert.ok(fs.existsSync(path.join(w1.folder, 'TODO.md')), 'a worker gets its own folder');

  const res = orch.pauseRun(run().runId);
  assert.deepStrictEqual(res.workers, [w1.worker, w2.worker]);
  assert.match(typedInto(mgr, orchSession.tabId), /send each running worker .*SendMessage/s, 'the idle orchestrator is told to relay');
  assert.ok(!/\[vistaclair pause\]/.test(typedInto(mgr, s1.tabId)), 'workers wait for the relay');
  assert.match(ctxOf(hook(orch, s1, { hook_event_name: 'PostToolUse', tool_name: 'Read' })), /orchestrator .* is sending you what to finish/);
  assert.match(ctxOf(hook(orch, s1, { hook_event_name: 'PostToolUse', tool_name: 'Read', agent_id: 'sub1' })), /pausing the session that launched you/, 'a subagent hears it too');
  assert.strictEqual(hook(orch, orchSession, { hook_event_name: 'PreToolUse', tool_name: 'mcp__orchestrator__launch_cli' }).exitCode, 2);
  assert.strictEqual(hook(orch, s1, { hook_event_name: 'PreToolUse', tool_name: 'Agent' }).exitCode, 2);

  // The orchestrator relays to w1 only; w2 hears it from the server.
  hook(orch, orchSession, { hook_event_name: 'UserPromptSubmit', prompt: '[vistaclair pause] …' });
  hook(orch, orchSession, { hook_event_name: 'PostToolUse', tool_name: 'SendMessage', tool_input: { to: w1.worker } });
  await wait(80);
  assert.ok(!/\[vistaclair pause\]/.test(typedInto(mgr, s1.tabId)), 'a relayed worker gets no fallback');
  assert.match(typedInto(mgr, s2.tabId), /\[vistaclair pause\].*report status "paused"/s, 'the fallback reaches an unrelayed worker');

  // The orchestrator idles while its workers pause.
  assert.deepStrictEqual(hook(orch, orchSession, { hook_event_name: 'Stop' }), {});
  await wait(20);
  assert.ok(mgr.sessions.has(orchSession.tabId), 'held open while workers pause');

  // A worker stops: no note → asked once; with a note → closed and marked paused.
  hook(orch, s1, { hook_event_name: 'UserPromptSubmit' });
  assert.match(blockOf(hook(orch, s1, { hook_event_name: 'Stop' })), /## Resume/);
  writeResume(s1);
  hook(orch, s1, { hook_event_name: 'Stop', stop_hook_active: true });
  await wait(20);
  assert.ok(!mgr.sessions.has(s1.tabId));
  assert.ok(run().workers[0].paused);
  assert.ok(mgr.findSaved(s1.sessId).paused);
  assert.deepStrictEqual(mgr.closeReasons, ['pause'], 'closed for a pause (a tool pack\'s release reason)');
  assert.ok(run().pausing, 'still pausing: w2 runs');

  hook(orch, s2, { hook_event_name: 'UserPromptSubmit' });
  writeResume(s2);
  hook(orch, s2, { hook_event_name: 'Stop' });
  await wait(20);
  assert.match(typedInto(mgr, orchSession.tabId), /Every worker of run .* is paused/, 'the last worker wakes the orchestrator');

  // Its note predates that message: asked again, then closed.
  writeResume(orchSession, 'stale');
  fs.utimesSync(path.join(orchSession.settings.sessionDir, 'NOTES.md'), new Date(0), new Date(0));
  hook(orch, orchSession, { hook_event_name: 'UserPromptSubmit', prompt: '[vistaclair pause]' });
  assert.ok(blockOf(hook(orch, orchSession, { hook_event_name: 'Stop' })));
  writeResume(orchSession, 'run note');
  hook(orch, orchSession, { hook_event_name: 'Stop', stop_hook_active: true });
  await wait(20);
  assert.ok(!mgr.sessions.has(orchSession.tabId));
  assert.strictEqual(run().pausing, null);
  assert.deepStrictEqual(run().paused.workers, [w1.worker, w2.worker]);
});

test('resuming a run: the orchestrator warms up its paused workers with resume_worker', async (t) => {
  const { orch, orchSession, mgr, run, control } = await openOrchestrator(t, { isolation: 'none' });
  const w1 = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'brief A' });
  const w2 = orch.launchWorker(orchSession.instanceId, { title: 'b', task: 'brief B' });
  const runId = run().runId;
  orch.pauseRun(runId);
  await wait(15);   // file mtimes come from a coarse clock
  for (const w of [w1, w2]) {
    const s = mgr.sessions.get(w.tabId);
    writeResume(s);
    hook(orch, s, { hook_event_name: 'Stop' });
  }
  await wait(20);
  writeResume(orchSession);
  hook(orch, orchSession, { hook_event_name: 'Stop' });
  await wait(20);
  assert.ok(run().paused);
  const oldW2 = mgr.history.find(h => h.settings.orchestration?.workerId === 'w2').id;

  const r = orch.resumeRun(runId);
  const o2 = mgr.sessions.get(r.tabId);
  assert.strictEqual(o2.sessId, orchSession.sessId, 'continue: its own transcript');
  assert.match(typedInto(mgr, r.tabId), /\[vistaclair resume\].*resume_worker/s);
  assert.throws(() => orch.resumeRun(runId), /already running/);
  assert.throws(() => orch.launchWorker(o2.instanceId, { title: 'c', task: 'x' }), /paused workers must be resumed/);

  const c = orch.resumeWorker(o2.instanceId, { worker: w1.worker, mode: 'continue', message: 'finish the parser' });
  const c1 = mgr.sessions.get(c.tabId);
  assert.strictEqual(c1.sessId, mgr.history.find(h => h.settings.orchestration?.workerId === 'w1').id);
  assert.match(typedInto(mgr, c.tabId), /\[vistaclair resume\][\s\S]*finish the parser/);
  assert.throws(() => orch.resumeWorker(o2.instanceId, { worker: w1.worker, mode: 'continue' }), /already running/);

  const f = orch.resumeWorker(o2.instanceId, { worker: 'w2', mode: 'fresh' });
  assert.strictEqual(mgr.sessions.get(f.tabId).settings.name, w2.worker, 'fresh keeps the address');
  assert.strictEqual(mgr.sessions.get(f.tabId).settings.sessionDir, w2.folder, 'and the folder');
  assert.match(typedInto(mgr, f.tabId), /brief B[\s\S]*fresh restart/);
  assert.strictEqual(mgr.findSaved(oldW2), null, 'the superseded session leaves the resume list');
  assert.ok(!run().workers.some(w => w.paused));
  assert.strictEqual(run().paused, null);
  assert.throws(() => orch.resumeWorker(mgr.sessions.get(c.tabId).instanceId, { worker: 'w2' }), /only an orchestrator/);
  assert.ok(control.liveOf(c1));
});

test('listRuns: a live run and a paused one, each once; describeRun by id, null for an unknown run', async (t) => {
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none' });
  const w1 = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'brief A' });
  const runId = run().runId;
  let [r] = orch.listRuns();
  assert.strictEqual(orch.listRuns().length, 1, 'one entry per run, not per member');
  assert.deepStrictEqual(Object.keys(r), ['runId', 'name', 'title', 'cwd', 'engine', 'state', 'busy', 'paused', 'pausing', 'orchestratorTabId', 'orchestratorSessId', 'workerCount', 'updatedAt']);
  assert.strictEqual(r.runId, runId);
  assert.strictEqual(r.name, `orch-${runId}`);
  assert.strictEqual(r.engine, 'cli');
  assert.strictEqual(r.state, 'idle');
  assert.strictEqual(r.busy, false);
  assert.strictEqual(r.paused, false);
  assert.strictEqual(r.orchestratorTabId, orchSession.tabId);
  assert.strictEqual(r.orchestratorSessId, orchSession.sessId);
  assert.strictEqual(r.cwd, orchSession.cwd);
  assert.strictEqual(r.workerCount, 1);
  assert.ok(!Number.isNaN(Date.parse(r.updatedAt)));
  assert.deepStrictEqual(orch.describeRunById(runId), orch.describeRun(run()));
  assert.strictEqual(orch.describeRunById('nope'), null);
  assert.strictEqual(orch.describeRunById(undefined), null);

  orch.pauseRun(runId);
  assert.strictEqual(orch.listRuns()[0].pausing, true);
  await wait(15);
  const s1 = mgr.sessions.get(w1.tabId);
  writeResume(s1);
  hook(orch, s1, { hook_event_name: 'Stop' });
  await wait(20);
  writeResume(orchSession);
  hook(orch, orchSession, { hook_event_name: 'Stop' });
  await wait(20);
  assert.strictEqual(mgr.sessions.size, 0, 'nothing of the run is live');
  [r] = orch.listRuns();
  assert.strictEqual(r.runId, runId, 'a paused run is known by its saved sessions');
  assert.strictEqual(r.state, 'paused');
  assert.strictEqual(r.paused, true);
  assert.strictEqual(r.pausing, false);
  assert.strictEqual(r.orchestratorTabId, null);
  assert.strictEqual(r.orchestratorSessId, orchSession.sessId);
  assert.strictEqual(orch.describeRunById(runId).paused.workers[0], w1.worker);
});

test('a lost transcript: resuming the run and its worker falls back to fresh sessions from the notes', async (t) => {
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none' });
  hook(orch, orchSession, { hook_event_name: 'UserPromptSubmit', prompt: 'Build the importer' });
  const w1 = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'brief A' });
  hook(orch, orchSession, { hook_event_name: 'Stop' });
  const runId = run().runId;
  orch.pauseRun(runId);
  await wait(15);
  const s1 = mgr.sessions.get(w1.tabId);
  writeResume(s1, 'parser half done');
  hook(orch, s1, { hook_event_name: 'Stop' });
  await wait(20);
  writeResume(orchSession, 'w1 paused mid-parser');
  hook(orch, orchSession, { hook_event_name: 'Stop' });
  await wait(20);
  mgr.lost.add(orchSession.sessId);
  mgr.lost.add(s1.sessId);

  // The run: a continue becomes a fresh orchestrator, seeded, same address.
  const r = orch.resumeRun(runId);
  assert.strictEqual(r.fresh, true);
  assert.strictEqual(r.fellBack, true);
  const o2 = mgr.sessions.get(r.tabId);
  assert.notStrictEqual(o2.sessId, orchSession.sessId);
  assert.strictEqual(o2.settings.name, orchSession.settings.name);
  const seed = fs.readFileSync(path.join(orchSession.settings.sessionDir, 'RESTART.md'), 'utf8');
  for (const x of ['could not be restored', 'Build the importer', 'w1 paused mid-parser', 'brief A', 'parser half done']) assert.ok(seed.includes(x), x);
  assert.match(typedInto(mgr, r.tabId), /resume_worker/);
  assert.strictEqual(mgr.findSaved(orchSession.sessId), null);

  // The worker: resume_worker "continue" becomes fresh, with its brief.
  const c = orch.resumeWorker(o2.instanceId, { worker: w1.worker, mode: 'continue', message: 'finish the parser' });
  assert.strictEqual(c.mode, 'fresh');
  assert.strictEqual(c.fellBack, true);
  const c1 = mgr.sessions.get(c.tabId);
  assert.notStrictEqual(c1.sessId, s1.sessId);
  assert.strictEqual(c1.settings.name, w1.worker);
  assert.strictEqual(c1.settings.sessionDir, w1.folder);
  assert.match(typedInto(mgr, c.tabId), /brief A[\s\S]*could not be restored[\s\S]*finish the parser/);
  assert.strictEqual(mgr.findSaved(s1.sessId), null);
  assert.ok(!run().workers[0].paused);
});

test('a "+" menu worker row resumes like resume_worker continue, falling back to its brief', async (t) => {
  const { orch, orchSession, mgr } = await openOrchestrator(t, { isolation: 'none' });
  const w1 = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'brief A' });
  const s1 = mgr.sessions.get(w1.tabId);
  s1.running = false;
  mgr.sessions.delete(w1.tabId);
  const kept = orch.resumeSavedWorker(s1.sessId);
  assert.strictEqual(kept.mode, 'continue');
  assert.strictEqual(mgr.sessions.get(kept.tabId).sessId, s1.sessId);
  mgr.sessions.get(kept.tabId).running = false;
  mgr.lost.add(s1.sessId);
  const fresh = orch.resumeSavedWorker(s1.sessId);
  assert.strictEqual(fresh.fellBack, true);
  assert.match(typedInto(mgr, fresh.tabId), /brief A/);
  assert.throws(() => orch.resumeSavedWorker(orchSession.sessId), /not a worker/);
});

test('refreshing the orchestrator: notes, then a fresh session seeded from the run', async (t) => {
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none' });
  hook(orch, orchSession, { hook_event_name: 'UserPromptSubmit', prompt: 'Build the importer' });
  const w1 = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'brief A' });
  orch.report(mgr.sessions.get(w1.tabId).instanceId, { status: 'started', summary: 'on it' });
  for (let i = 0; i < 3; i++) hook(orch, orchSession, { hook_event_name: 'SessionStart', source: 'compact' });
  assert.strictEqual(orch.describeRun(run()).refreshSuggested, true);
  hook(orch, orchSession, { hook_event_name: 'Stop' });

  orch.refreshOrchestrator(run().runId);
  assert.match(typedInto(mgr, orchSession.tabId), /refreshing you/);
  await wait(15);
  writeResume(orchSession, 'w1 is parsing');
  hook(orch, orchSession, { hook_event_name: 'UserPromptSubmit', prompt: '[vistaclair pause]' });
  hook(orch, orchSession, { hook_event_name: 'Stop' });
  await wait(20);

  const fresh = [...mgr.sessions.values()].find(s => s.settings.orchestration?.role === 'orchestrator');
  assert.ok(fresh && fresh !== orchSession);
  assert.notStrictEqual(fresh.sessId, orchSession.sessId);
  assert.strictEqual(fresh.settings.name, orchSession.settings.name);
  const seed = fs.readFileSync(path.join(orchSession.settings.sessionDir, 'RESTART.md'), 'utf8');
  for (const s of ['Build the importer', 'w1 is parsing', 'brief A', 'on it']) assert.ok(seed.includes(s), s);
  assert.match(typedInto(mgr, fresh.tabId), /RESTART\.md/);
  assert.strictEqual(mgr.findSaved(orchSession.sessId), null, 'the drifted session leaves the resume list');
  assert.strictEqual(run().compactions, 0);
  assert.ok(mgr.sessions.has(w1.tabId), 'workers keep running');
});

test('close guards: a worker closes when complete or forced, an orchestrator not while workers run', async (t) => {
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none' });
  const w1 = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  const s1 = mgr.sessions.get(w1.tabId);
  const refused = orch.closeCheck(w1.tabId);
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.canForce, true);
  assert.deepStrictEqual(orch.closeCheck(orchSession.tabId).ok, false);
  orch.report(s1.instanceId, { status: 'done', summary: 'ok' });
  assert.strictEqual(orch.closeCheck(w1.tabId).ok, true, 'done and idle');
  orch.report(s1.instanceId, { status: 'blocked', summary: 'hm' });
  assert.strictEqual(orch.closeCheck(w1.tabId, { force: true }).abandoned, true);
  assert.ok(run().workers[0].abandoned);
  s1.running = false;
  assert.strictEqual(orch.closeCheck(orchSession.tabId).ok, true);
  assert.deepStrictEqual(orch.closeCheck('tab-unknown'), { ok: true });
});

test('close guards: a finished, idle worker with an empty TODO no longer holds the orchestrator', async (t) => {
  const { orch, orchSession, mgr } = await openOrchestrator(t, { isolation: 'none' });
  const w1 = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  const s1 = mgr.sessions.get(w1.tabId);
  const todo = (...rows) => fs.writeFileSync(path.join(w1.folder, 'TODO.md'),
    ['| id | description | depends on | status |', '|---|---|---|---|', ...rows.map((r, i) => `| ${i + 1} | step | — | ${r} |`)].join('\n') + '\n');
  const closable = () => orch.closeCheck(orchSession.tabId);

  todo('done', 'dropped');
  orch.report(s1.instanceId, { status: 'started', summary: 'on it' });
  assert.strictEqual(closable().ok, false, 'started');
  orch.report(s1.instanceId, { status: 'update', summary: 'half way' });
  assert.strictEqual(closable().ok, false, 'update');

  orch.report(s1.instanceId, { status: 'done', summary: 'ok' });
  assert.strictEqual(closable().ok, true, 'done, idle, TODO all done');

  s1.busy = true;
  const busy = closable();
  assert.strictEqual(busy.ok, false, 'busy');
  assert.match(busy.reason, /\(.*\)/);
  s1.busy = false;

  todo('done', 'doing');
  assert.strictEqual(closable().ok, false, 'a row still doing');
  todo('done', 'todo');
  assert.strictEqual(closable().ok, false, 'a row still open');
  todo('done', 'done');
  assert.strictEqual(closable().ok, true);

  fs.unlinkSync(path.join(w1.folder, 'TODO.md'));
  assert.strictEqual(closable().ok, true, 'no TODO rows');
});

test('close_worker: refuses a busy or unfinished worker, closes a done idle one and frees its slot', async (t) => {
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none', engine: 'sdk' });
  const ws = [1, 2, 3, 4, 5].map(i => orch.launchWorker(orchSession.instanceId, { title: `t${i}`, task: `brief ${i}` }));
  const s1 = mgr.sessions.get(ws[0].tabId);
  s1.context = { tokens: 50000, window: 200000, compactAt: 160000, windowEstimated: false };
  const close = (worker) => orch.closeWorker(orchSession.instanceId, { worker });

  assert.throws(() => close('w1'), /has not finished \(last report: none\)/);
  orch.report(s1.instanceId, { status: 'started', summary: 'on it' });
  assert.throws(() => close('w1'), /last report: started/);
  orch.report(s1.instanceId, { status: 'done', summary: 'parser done' });
  s1.busy = true;
  assert.throws(() => close('w1'), /is busy/);
  s1.busy = false;
  assert.throws(() => close('w9'), /no worker w9/);
  assert.throws(() => orch.closeWorker(s1.instanceId, { worker: 'w1' }), /only an orchestrator/);

  // Full: the error names the finished worker and the two ways out.
  let d = orch.describeRun(run());
  assert.strictEqual(d.workers[0].available, true);
  assert.strictEqual(d.workers[1].available, false);
  assert.deepStrictEqual(d.workers[0].context, { tokens: 50000, window: 200000, compactAt: 160000, percent: 25 });
  assert.strictEqual(d.workers[1].context, null, 'nothing counted yet');
  assert.strictEqual(d.workers[0].brief, 'brief 1');
  assert.throws(() => orch.launchWorker(orchSession.instanceId, { title: 't6', task: 'x' }),
    new RegExp(`5 workers are running[\\s\\S]*available to close: ${ws[0].worker} \\(last report: done\\)[\\s\\S]*close_worker[\\s\\S]*SendMessage`));

  // An open TODO row does not hold it; the result says so.
  fs.writeFileSync(path.join(ws[0].folder, 'TODO.md'), '| id | description | depends on | status |\n|---|---|---|---|\n| 1 | step | — | todo |\n');
  const r = close(ws[0].worker);
  assert.strictEqual(r.closed, true);
  assert.match(r.note, /1 open TODO row/);
  assert.ok(mgr.closed.includes(ws[0].tabId), 'closed quietly');
  assert.ok(mgr.findSaved(s1.sessId), 'its saved entry survives');
  const w1 = run().workers[0];
  assert.strictEqual(w1.closed, true);
  assert.ok(w1.closedAt);
  assert.ok(!run().events.some(e => e.kind === 'exited'), 'no exit event for its own close');
  assert.throws(() => close('w1'), /not running \(already closed\)/);

  // Still listed: describeRun in full (the GUI's contract), list_workers compact.
  d = orch.describeRun(run());
  const dw = d.workers[0];
  assert.deepStrictEqual({ state: dw.state, closed: dw.closed, closedAt: dw.closedAt, sessId: dw.sessId, available: dw.available },
    { state: 'closed', closed: true, closedAt: w1.closedAt, sessId: s1.sessId, available: false });
  const lw = orch.listWorkers(orchSession.instanceId).workers;
  assert.strictEqual(lw.length, 5);
  assert.deepStrictEqual(lw[0].lastReport, { status: 'done', summary: 'parser done' });
  assert.strictEqual(lw[0].state, 'closed');
  assert.strictEqual(lw[0].progress, undefined, 'a compact entry');
  assert.ok(lw[1].progress !== undefined, 'a running worker keeps its full entry');
  assert.strictEqual(orch.listAgents(orchSession.instanceId).agents[1].state, 'closed');

  // The slot is free again.
  assert.doesNotThrow(() => orch.launchWorker(orchSession.instanceId, { title: 't6', task: 'x' }));

  // A pausing run closes nothing.
  orch.report(mgr.sessions.get(ws[1].tabId).instanceId, { status: 'done', summary: 'ok' });
  orch.pauseRun(run().runId);
  assert.throws(() => close('w2'), /being paused/);
});

test('resume_worker brings a closed worker back and clears closed', async (t) => {
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none' });
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'brief A' });
  const s1 = mgr.sessions.get(w.tabId);
  orch.report(s1.instanceId, { status: 'failed', summary: 'tests red' });
  orch.closeWorker(orchSession.instanceId, { worker: 'w1' });
  assert.throws(() => orch.sendMessage(orchSession.instanceId, { to: 'w1', message: 'x' }), /not running.*resume_worker/);

  const c = orch.resumeWorker(orchSession.instanceId, { worker: 'w1', mode: 'continue', message: 'fix the red tests' });
  assert.strictEqual(c.mode, 'continue');
  assert.strictEqual(mgr.sessions.get(c.tabId).sessId, s1.sessId, 'its own transcript');
  assert.strictEqual(run().workers[0].closed, undefined);
  assert.strictEqual(run().workers[0].closedAt, undefined);
  assert.strictEqual(orch.describeRun(run()).workers[0].closed, false);
  assert.deepStrictEqual(run().workers[0].followUps.map(f => f.text), ['fix the red tests']);
});

test('an orchestrator SendMessage to a worker is kept as a follow-up: in its recap, a fresh restart and the seed', async (t) => {
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none' });
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'THE ORIGINAL BRIEF' });
  const s1 = mgr.sessions.get(w.tabId);
  orch.sendMessage(orchSession.instanceId, { to: w.worker, message: 'now also do the exporter' });
  orch.sendMessage(s1.instanceId, { to: 'orchestrator', message: 'a question' });
  const ups = run().workers[0].followUps;
  assert.deepStrictEqual(ups.map(f => f.text), ['now also do the exporter'], 'only the orchestrator\'s messages');
  assert.ok(ups[0].at);
  for (let i = 0; i < 12; i++) orch.sendMessage(orchSession.instanceId, { to: 'w1', message: `extra ${i}` });
  assert.strictEqual(run().workers[0].followUps.length, 10, 'the last 10');
  assert.strictEqual(run().workers[0].followUps[0].text, 'extra 2');

  const ctx = JSON.parse(hook(orch, s1, { hook_event_name: 'SessionStart', source: 'compact' }).stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /THE ORIGINAL BRIEF[\s\S]*Follow-ups from your orchestrator, oldest first[\s\S]*extra 2[\s\S]*extra 11/);
  assert.ok(ctx.length <= 9001);

  // A long brief and long follow-ups still fit, the newest follow-up kept.
  const r = run();
  r.workers[0].task = 'B'.repeat(20000);
  r.workers[0].followUps = Array.from({ length: 10 }, (_, i) => ({ at: 'x', text: `${i}`.repeat(1999) + 'END' }));
  fs.writeFileSync(path.join(r.runDir, 'run.json'), JSON.stringify(r));
  const big = JSON.parse(hook(orch, s1, { hook_event_name: 'SessionStart', source: 'compact' }).stdout).hookSpecificOutput.additionalContext;
  assert.ok(big.length <= 9001);
  assert.match(big, /9{1999}END/);
  assert.match(big, /older follow-up\(s\) left out/);
  r.workers[0].task = 'THE ORIGINAL BRIEF';
  r.workers[0].followUps = [{ at: 'x', text: 'do the exporter' }];
  fs.writeFileSync(path.join(r.runDir, 'run.json'), JSON.stringify(r));

  // A fresh restart is told its brief, then the follow-ups.
  orch.report(s1.instanceId, { status: 'done', summary: 'ok' });
  orch.closeWorker(orchSession.instanceId, { worker: 'w1' });
  const f = orch.resumeWorker(orchSession.instanceId, { worker: 'w1', mode: 'fresh' });
  assert.match(typedInto(mgr, f.tabId), /THE ORIGINAL BRIEF[\s\S]*Follow-ups from your orchestrator[\s\S]*do the exporter[\s\S]*fresh restart/);

  // The seed of a fresh orchestrator lists them under the brief.
  orch.refreshOrchestrator(run().runId);
  await wait(15);
  writeResume(orchSession, 'w1 closed');
  hook(orch, orchSession, { hook_event_name: 'UserPromptSubmit', prompt: '[vistaclair pause]' });
  hook(orch, orchSession, { hook_event_name: 'Stop' });
  await wait(20);
  const seed = fs.readFileSync(path.join(orchSession.settings.sessionDir, 'RESTART.md'), 'utf8');
  assert.match(seed, /THE ORIGINAL BRIEF[\s\S]*Follow-ups you sent it[\s\S]*do the exporter/);
});

// --- end_run keeps workers resumable; a worker's worktree comes back ---

function gitRepo() {
  const repo = tmpDir('vistaclair-orch-repo-');
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' }).toString();
  g('init', '-q'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return { repo, g };
}
const commitIn = (dir, file) => {
  fs.writeFileSync(path.join(dir, file), file);
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', file]);
};

test('resume after end_run: the worktree comes back at the same path, its branch from HEAD, and the worker continues', async (t) => {
  const { repo, g } = gitRepo();
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { cwd: repo });
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'brief A' });
  const s1 = mgr.sessions.get(w.tabId);
  commitIn(w.cwd, 'a.txt');
  g('merge', '-q', '--ff-only', w.branch);
  commitIn(repo, 'b.txt');
  orch.report(s1.instanceId, { status: 'done', summary: 'ok' });
  s1.running = false;

  const res = orch.endRun(orchSession.instanceId);
  assert.deepStrictEqual(res.removed, [w.worker]);
  assert.strictEqual(res.closed, true);
  assert.ok(!fs.existsSync(w.cwd));
  assert.strictEqual(g('branch', '--list', w.branch).trim(), '', 'the merged branch is deleted');
  assert.strictEqual(run().workers.length, 1, 'its record is kept');
  assert.ok(fs.existsSync(path.join(w.folder, 'TODO.md')), 'its folder is kept');
  assert.ok(mgr.findSaved(s1.sessId), 'its saved session is kept');

  const c = orch.resumeWorker(orchSession.instanceId, { worker: 'w1', mode: 'continue', message: 'one more thing' });
  assert.strictEqual(c.mode, 'continue');
  assert.ok(!c.fellBack);
  const s2 = mgr.sessions.get(c.tabId);
  assert.strictEqual(s2.sessId, s1.sessId, 'its own transcript');
  assert.strictEqual(s2.cwd, w.cwd, 'in the same directory');
  assert.ok(fs.existsSync(path.join(w.cwd, 'b.txt')), 'a new branch from HEAD');
  assert.strictEqual(g('rev-parse', w.branch).trim(), g('rev-parse', 'HEAD').trim());
  const rw = run().workers[0];
  assert.deepStrictEqual(rw.worktree, { path: w.cwd, repo }, 'recorded again');
  assert.strictEqual(rw.closed, undefined);
  assert.strictEqual(run().closed, false, 'the run is reopened');
});

test('resume with its branch still there: the worktree is recreated on it', async (t) => {
  const { repo, g } = gitRepo();
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { cwd: repo });
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'brief A' });
  commitIn(w.cwd, 'c.txt');
  mgr.sessions.get(w.tabId).running = false;
  g('worktree', 'remove', '--force', w.cwd);
  assert.ok(g('branch', '--list', w.branch).trim());

  const f = orch.resumeWorker(orchSession.instanceId, { worker: 'w1', mode: 'fresh' });
  assert.strictEqual(f.mode, 'fresh');
  assert.strictEqual(mgr.sessions.get(f.tabId).cwd, w.cwd);
  assert.ok(fs.existsSync(path.join(w.cwd, 'c.txt')), 'its own branch, with its commit');
  assert.strictEqual(run().workers[0].worktree.path, w.cwd);
});

test('launch_cli after end_run reopens the run', async (t) => {
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none' });
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  mgr.sessions.get(w.tabId).running = false;
  assert.strictEqual(orch.endRun(orchSession.instanceId).closed, true);
  assert.strictEqual(orch.describeRun(run()).closed, true);
  const w2 = orch.launchWorker(orchSession.instanceId, { title: 'b', task: 'more' });
  assert.ok(mgr.sessions.get(w2.tabId).running);
  assert.strictEqual(run().closed, false);
});

test('a resume whose worktree cannot be recreated throws and leaves the worker as it was', async (t) => {
  const { repo, g } = gitRepo();
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { cwd: repo });
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'brief A' });
  const s1 = mgr.sessions.get(w.tabId);
  orch.report(s1.instanceId, { status: 'done', summary: 'ok' });
  assert.strictEqual(orch.closeWorker(orchSession.instanceId, { worker: 'w1' }).worktree, 'removed', 'nothing to land, clean: it goes at close');
  g('checkout', '-q', '-b', w.branch);    // checked out elsewhere: git refuses a second worktree on it
  const before = run().workers[0];
  assert.strictEqual(before.closed, true);
  const launches = mgr.launches.length;

  for (const mode of ['continue', 'fresh']) {
    assert.throws(() => orch.resumeWorker(orchSession.instanceId, { worker: 'w1', mode }), /worktree .* is gone and could not be recreated/);
  }
  assert.throws(() => orch.resumeSavedWorker(s1.sessId), /could not be recreated/);
  assert.deepStrictEqual(run().workers[0], before, 'closed, closedAt and exitedAt unchanged');
  assert.strictEqual(mgr.launches.length, launches);
  assert.ok(!fs.existsSync(w.cwd));
});

test('deleting a single worker removes its worktree, keeps an unmerged branch, refuses a dirty one unless forced', async (t) => {
  const { repo, g } = gitRepo();
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { cwd: repo });
  const [w1, w2, w3] = ['a', 'b', 'c'].map(title => orch.launchWorker(orchSession.instanceId, { title, task: 'x' }));
  commitIn(w1.cwd, 'unmerged.txt');
  fs.writeFileSync(path.join(w3.cwd, 'wip.txt'), 'x');
  const entry = (w) => { const s = mgr.sessions.get(w.tabId); s.running = false; return mgr.findSaved(s.sessId); };

  const r1 = orch.noteMemberDeleted(entry(w1));
  assert.deepStrictEqual(r1.keptBranches, [w1.branch]);
  assert.ok(!fs.existsSync(w1.cwd));
  assert.ok(g('branch', '--list', w1.branch).trim(), 'the unmerged branch is kept');
  const r2 = orch.noteMemberDeleted(entry(w2));
  assert.deepStrictEqual(r2.keptBranches, []);
  assert.ok(!fs.existsSync(w2.cwd));
  assert.strictEqual(g('branch', '--list', w2.branch).trim(), '', 'a merged branch is deleted');

  const e3 = entry(w3);
  assert.deepStrictEqual(orch.memberDirty(e3), [{ worker: w3.worker, path: w3.cwd }]);
  const refused = orch.noteMemberDeleted(e3);
  assert.strictEqual(refused.refused, true);
  assert.strictEqual(refused.dirty[0].worker, w3.worker);
  assert.ok(fs.existsSync(path.join(w3.cwd, 'wip.txt')));
  assert.ok(!run().workers[2].deleted, 'nothing changed');
  orch.noteMemberDeleted(e3, { force: true });
  assert.ok(!fs.existsSync(w3.cwd));

  const ws = run().workers;
  assert.deepStrictEqual(ws.map(w => [!!w.deleted, w.worktree]), [[true, null], [true, null], [true, null]]);
});

test('deleting a run: refused over uncommitted worktree changes, keeps unmerged branches', async (t) => {
  const repo = tmpDir('vistaclair-orch-repo-');
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' }).toString();
  g('init', '-q'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { cwd: repo });
  const w1 = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  const runId = run().runId;
  const runDir = run().runDir;

  fs.writeFileSync(path.join(w1.cwd, 'wip.txt'), 'x');
  const refused = orch.deleteRun(runId);
  assert.strictEqual(refused.refused, true);
  assert.deepStrictEqual(refused.busy, []);
  assert.strictEqual(refused.dirty[0].worker, w1.worker);
  assert.strictEqual(mgr.sessions.size, 2, 'a refusal closes nothing');
  execFileSync('git', ['-C', w1.cwd, 'add', '.']);
  execFileSync('git', ['-C', w1.cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'wip']);

  const res = orch.deleteRun(runId);
  assert.deepStrictEqual(res.keptBranches, [w1.branch]);
  assert.ok(g('branch', '--list', w1.branch).trim(), 'the unmerged branch is kept');
  assert.ok(!fs.existsSync(w1.cwd));
  assert.ok(!fs.existsSync(runDir));
  assert.ok(!fs.existsSync(w1.folder));
  assert.ok(!fs.existsSync(orchSession.settings.sessionDir));
  assert.strictEqual(mgr.history.length, 0, 'every member leaves the resume list');
});

test('deleting a run closes its idle open members; a busy one refuses it unless forced', async (t) => {
  const { repo } = gitRepo();
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { cwd: repo });
  const w1 = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  const runId = run().runId;
  const runDir = run().runDir;
  const ws = mgr.sessions.get(w1.tabId);
  let interrupts = 0;
  ws.interrupt = () => { interrupts++; };

  ws.busy = true;
  const refused = orch.deleteRun(runId);
  assert.strictEqual(refused.refused, true);
  assert.deepStrictEqual(refused.busy, [{ worker: w1.worker, title: ws.title, tabId: w1.tabId }]);
  assert.deepStrictEqual(refused.dirty, []);
  assert.strictEqual(mgr.sessions.size, 2, 'nothing closed');
  assert.ok(fs.existsSync(runDir) && fs.existsSync(w1.cwd), 'nothing deleted');
  assert.strictEqual(interrupts, 0);

  const res = orch.deleteRun(runId, { force: true });
  assert.strictEqual(interrupts, 1, 'the busy member is interrupted');
  assert.deepStrictEqual(res.busy.map(b => b.worker), [w1.worker]);
  assert.strictEqual(mgr.sessions.size, 0, 'every member tab is closed');
  assert.deepStrictEqual(mgr.closeReasons, ['delete_run', 'delete_run']);
  assert.ok(!fs.existsSync(runDir));
  assert.ok(!fs.existsSync(w1.cwd));
  assert.strictEqual(mgr.history.length, 0);
});

test('deleting a run with idle open members closes them without asking', async (t) => {
  const { repo } = gitRepo();
  const { orch, orchSession, mgr, run, broadcasts } = await openOrchestrator(t, { cwd: repo });
  const w1 = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  const runId = run().runId;
  const runDir = run().runDir;
  assert.ok([...mgr.sessions.values()].every(s => s.running && !s.busy), 'open and idle');

  const res = orch.deleteRun(runId);
  assert.ok(!res.refused);
  assert.deepStrictEqual(mgr.closed.sort(), [orchSession.tabId, w1.tabId].sort());
  assert.strictEqual(mgr.sessions.size, 0);
  assert.ok(!fs.existsSync(runDir));
  assert.ok(!fs.existsSync(w1.folder));
  assert.strictEqual(mgr.history.length, 0, 'every member leaves the resume list');
  assert.ok(broadcasts.some(m => m.type === 'orchestration:run' && m.runId === runId && m.deleted));
});

test('deleting a run: a busy member and a dirty worktree give one combined refusal', async (t) => {
  const { repo } = gitRepo();
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { cwd: repo });
  const w1 = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  const w2 = orch.launchWorker(orchSession.instanceId, { title: 'b', task: 'x' });
  mgr.sessions.get(w1.tabId).busy = true;
  fs.writeFileSync(path.join(w2.cwd, 'wip.txt'), 'x');

  const refused = orch.deleteRun(run().runId);
  assert.strictEqual(refused.refused, true);
  assert.deepStrictEqual(refused.busy.map(b => b.worker), [w1.worker]);
  assert.deepStrictEqual(refused.dirty, [{ worker: w2.worker, path: w2.cwd }]);
  assert.strictEqual(mgr.sessions.size, 3, 'nothing closed');
  assert.ok(fs.existsSync(path.join(w2.cwd, 'wip.txt')));
});

test('buildCliArgs passes the session name and subagent definitions', () => {
  const { buildCliArgs } = require('../src/utils');
  const args = buildCliArgs({ name: 'orch-abc123', agents: { coder: { model: 'opus' } }, maxBudgetUsd: 5 });
  assert.deepStrictEqual(args.slice(0, 4), ['--name', 'orch-abc123', '--agents', '{"coder":{"model":"opus"}}']);
  assert.ok(args.includes('--max-budget-usd'));
});

test('buildCliArgs denies an orchestration role its tools; a session without a role gets no --disallowedTools', () => {
  const { buildCliArgs, disallowedToolsFor } = require('../src/utils');
  const denied = (role) => {
    const args = buildCliArgs({ name: 'x', ...(role ? { orchestration: { role } } : {}) });
    const i = args.indexOf('--disallowedTools');
    return i < 0 ? null : args[i + 1].split(',');
  };
  assert.strictEqual(denied(null), null);
  assert.deepStrictEqual(buildCliArgs({ name: 'x' }), ['--name', 'x'], 'unchanged without a role');
  assert.deepStrictEqual(denied('orchestrator'), ['Workflow', 'EnterPlanMode', 'ExitPlanMode', 'Monitor', 'ReportFindings']);
  assert.deepStrictEqual(denied('worker'), ['Workflow', 'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion', 'mcp__integrated__vista-AskUserQuestion']);
  // Composable: an engine's own list first, no duplicates.
  assert.deepStrictEqual(disallowedToolsFor({ orchestration: { role: 'worker' } }, ['SendMessage', 'Workflow']).slice(0, 3), ['SendMessage', 'Workflow', 'EnterPlanMode']);
  assert.deepStrictEqual(disallowedToolsFor({}, ['SendMessage']), ['SendMessage']);
});

test('the explorer subagent names only tools Claude Code offers', () => {
  const { WORKER_AGENTS } = require('../src/orchestration');
  assert.deepStrictEqual(WORKER_AGENTS.explorer.tools, ['Read', 'Bash', 'WebFetch', 'WebSearch']);
});

test('the orchestrator card: plan confirmed before fanning out, cheap workers for trivial jobs, stop_worker', () => {
  const { orchestratorCard } = require('../src/orchestration');
  const card = orchestratorCard({ runId: 'abc123', orchestrator: 'orch-abc123', runDir: '/tmp/run', isolation: 'none' });
  assert.match(card, /non-trivial request, write the plan as TODO rows and confirm it with the user \(AskUserQuestion\) before fanning out to several workers/);
  assert.match(card, /trivial, mechanical job goes to a cheap worker: model sonnet or haiku, isolation none/);
  assert.match(card, /`stop_worker` ends its current turn and leaves it idle; then SendMessage it new instructions, or close_worker it/);
});

test('stop_worker: orchestrator only, refuses an idle worker, interrupts a busy one without a nudge or idle event', async (t) => {
  for (const engine of ['cli', 'sdk']) {
    const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none', engine });
    const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
    const ws = mgr.sessions.get(w.tabId);
    let interrupts = 0;
    if (engine === 'sdk') ws.interrupt = () => { interrupts++; };
    const stopW = (worker, extra = {}) => orch.stopWorker(orchSession.instanceId, { worker, ...extra });

    assert.throws(() => orch.stopWorker(ws.instanceId, { worker: 'w1' }), /only an orchestrator/);
    assert.throws(() => stopW('w9'), /no worker w9/);
    hook(orch, ws, { hook_event_name: 'UserPromptSubmit' });
    orch.report(ws.instanceId, { status: 'started', summary: 'on it' });
    ws.busy = false;
    assert.throws(() => stopW('w1'), /is idle: nothing to stop/);
    assert.throws(() => orch.closeWorker(orchSession.instanceId, { worker: 'w1' }), /last report: started/);

    ws.busy = true;
    hook(orch, orchSession, { hook_event_name: 'UserPromptSubmit' });   // takes the 'started' report
    const before = run().delivered;
    assert.strictEqual(before, run().events.at(-1).seq);
    const r = stopW('w1', { reason: 'wrong file' });
    assert.strictEqual(r.stopped, true, engine);
    if (engine === 'sdk') assert.strictEqual(interrupts, 1, 'the SDK session\'s interrupt');
    else assert.strictEqual(mgr.writes.at(-1).data, '\x1b', 'Esc into the terminal');
    const ev = run().events.at(-1);
    assert.deepStrictEqual([ev.kind, ev.text], ['stopped', `${w.worker} was stopped by the orchestrator: wrong file`]);
    assert.strictEqual(run().delivered, before + 1, 'recorded, not delivered back to the orchestrator');
    assert.strictEqual(run().workers[0].turnStopped.reason, 'wrong file');

    // The interrupted turn's Stop: neither nudged nor an idle event.
    ws.busy = false;
    assert.deepStrictEqual(hook(orch, ws, { hook_event_name: 'Stop', last_assistant_message: 'half done' }), {});
    assert.ok(!run().events.some(e => e.kind === 'idle'));
    assert.strictEqual(orch.describeRun(run()).workers[0].available, true, 'a stopped idle worker may be closed');
    // The next turn is enforced again.
    hook(orch, ws, { hook_event_name: 'UserPromptSubmit' });
    assert.strictEqual(blockOf(hook(orch, ws, { hook_event_name: 'Stop' })) !== null, true);

    // Closable without a done/failed report while it stays stopped.
    assert.strictEqual(orch.closeWorker(orchSession.instanceId, { worker: 'w1' }).closed, true);
    assert.strictEqual(run().workers[0].turnStopped, undefined);
    assert.throws(() => stopW('w1'), /not running \(closed\)/);
  }
});

test('stop_worker: new instructions or a report clear the stop', async (t) => {
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none', engine: 'sdk' });
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  const ws = mgr.sessions.get(w.tabId);
  ws.interrupt = () => {};
  ws.busy = true;
  orch.stopWorker(orchSession.instanceId, { worker: 'w1' });
  ws.busy = false;
  orch.sendMessage(orchSession.instanceId, { to: 'w1', message: 'do Y instead' });
  assert.strictEqual(run().workers[0].turnStopped, undefined);
  assert.throws(() => orch.closeWorker(orchSession.instanceId, { worker: 'w1' }), /has not finished/);
  ws.busy = true;
  orch.stopWorker(orchSession.instanceId, { worker: 'w1' });
  orch.report(ws.instanceId, { status: 'started', summary: 'again' });
  assert.strictEqual(run().workers[0].turnStopped, undefined);
});

test('the orchestrator MCP server is attached only to stamped sessions, by role', () => {
  const CliSession = require('../src/cli-session');
  const fn = (role) => CliSession.prototype._orchestratorMcpServer.call({
    settings: role ? { orchestration: { role } } : {}, instanceId: 'cli-x', _dashboardPort: 1, _authToken: 't',
  });
  assert.deepStrictEqual(fn(null), {});
  assert.strictEqual(fn('orchestrator').orchestrator.env.VISTACLAIR_ORCH_ROLE, 'orchestrator');
  assert.strictEqual(fn('worker').orchestrator.env.VISTACLAIR_ORCH_ROLE, 'worker');
});

test('the hook script fails open when the dashboard is unreachable', () => {
  const r = spawnSync('node', [path.join(CORE, 'lib', 'orchestration-hook.js')], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent' }),
    env: { ...process.env, VISTACLAIR_DASHBOARD_PORT: '1', VISTACLAIR_AUTH_TOKEN: 't', VISTACLAIR_INSTANCE_ID: 'cli-x' },
    timeout: 8000,
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.toString(), '');
});

// --- Agent SDK runs: engine, messaging ---

const msgEvents = (mgr, tabId) => mgr.emitted.filter(e => e.tabId === tabId && e.ev.platform?.kind === 'message').map(e => e.ev.platform);

test('an SDK run: workers inherit the engine and are hidden; describeRun names sessId, engine, state and cost', async (t) => {
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none', engine: 'sdk' });
  assert.strictEqual(run().engine, 'sdk');
  assert.strictEqual(orchSession.settings.engine, 'sdk');
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  const wSession = mgr.sessions.get(w.tabId);
  assert.strictEqual(wSession.settings.engine, 'sdk');
  assert.strictEqual(mgr.launches.at(-1).opts.hidden, true, 'an SDK worker is an area of the panel, not a tab');
  wSession.costUsd = 0.12;
  wSession.state = 'busy';
  orchSession.costUsd = 0.5;

  let d = orch.describeRun(run());
  assert.strictEqual(d.engine, 'sdk');
  assert.strictEqual(d.orchestratorSessId, orchSession.sessId);
  assert.strictEqual(d.orchestratorCost, 0.5);
  const dw = d.workers[0];
  assert.deepStrictEqual({ name: dw.name, sessId: dw.sessId, engine: dw.engine, state: dw.state, cost: dw.cost },
    { name: w.worker, sessId: wSession.sessId, engine: 'sdk', state: 'busy', cost: 0.12 });

  // Exited: the cost is kept in run.json, the sessId comes from history.
  wSession.running = false;
  orch.onSessionExit(w.tabId, wSession);
  mgr.sessions.delete(w.tabId);
  d = orch.describeRun(run());
  assert.deepStrictEqual({ sessId: d.workers[0].sessId, state: d.workers[0].state, cost: d.workers[0].cost },
    { sessId: wSession.sessId, state: 'exited', cost: 0.12 });

  // A CLI run stays CLI.
  const cli = await openOrchestrator(t, { isolation: 'none' });
  const cw = cli.orch.launchWorker(cli.orchSession.instanceId, { title: 'b', task: 'y' });
  assert.strictEqual(cli.mgr.sessions.get(cw.tabId).settings.engine, 'cli');
  assert.strictEqual(cli.mgr.launches.at(-1).opts.hidden, undefined);
});

test('a member model switch: run.json follows, fresh restarts use it; a resumed member keeps its cost', async (t) => {
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none', engine: 'sdk' });
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'brief A', model: 'sonnet' });
  const wSession = mgr.sessions.get(w.tabId);
  wSession.settings.model = 'haiku';            // what SdkSession.setModel did
  assert.strictEqual(orch.memberModelChanged(wSession, 'haiku'), true);
  assert.strictEqual(run().workers[0].model, 'haiku');
  assert.strictEqual(orch.describeRun(run()).workers[0].model, 'haiku');
  assert.match(mgr.sessions.get(w.tabId).settings.appendSystemPrompt, /rows of your TODO\.md \(short descriptions, detail in NOTES\.md\)/);
  assert.strictEqual(orch.memberModelChanged(orchSession, 'claude-opus-4-5[1m]'), true);
  assert.strictEqual(run().orchestratorModel, 'claude-opus-4-5[1m]');
  assert.strictEqual(orch.memberModelChanged({ getSettings: () => ({}) }, 'opus'), false, 'not a member');

  // It exits with a cost; a continue resume is raised to it, and describeRun
  // never shows the resumed session's live 0 over the recorded cost.
  wSession.costUsd = 0.12;
  wSession.running = false;
  orch.onSessionExit(w.tabId, wSession);
  mgr.sessions.delete(w.tabId);
  const c = orch.resumeWorker(orchSession.instanceId, { worker: 'w1', mode: 'continue' });
  const c1 = mgr.sessions.get(c.tabId);
  assert.strictEqual(c1.seeded, 0.12);
  c1.costUsd = 0;
  assert.strictEqual(orch.describeRun(run()).workers[0].cost, 0.12);
  c1.costUsd = 0.3;
  assert.strictEqual(orch.describeRun(run()).workers[0].cost, 0.3);

  // A fresh restart is launched with the switched model.
  c1.running = false;
  mgr.sessions.delete(c.tabId);
  const f = orch.resumeWorker(orchSession.instanceId, { worker: 'w1', mode: 'fresh' });
  assert.strictEqual(f.mode, 'fresh');
  assert.strictEqual(mgr.sessions.get(f.tabId).settings.model, 'haiku');

  // A fresh orchestrator with no saved entry to take settings from uses it too.
  orchSession.running = false;
  orch.onSessionExit(orchSession.tabId, orchSession);
  mgr.sessions.delete(orchSession.tabId);
  mgr.forgetSaved(orchSession.sessId);
  const r = orch.resumeRun(run().runId);
  assert.strictEqual(r.fresh, true);
  assert.strictEqual(mgr.sessions.get(r.tabId).settings.model, 'claude-opus-4-5[1m]');
});

test('SendMessage to an SDK member: a next-priority turn, idle or busy, and a message card in both areas', async (t) => {
  const { orch, orchSession, mgr } = await openOrchestrator(t, { isolation: 'none', engine: 'sdk' });
  const orchName = orchSession.settings.name;
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  const wSession = mgr.sessions.get(w.tabId);

  // Worker -> idle orchestrator.
  const r1 = orch.sendMessage(wSession.instanceId, { to: orchName, message: 'need a decision' });
  assert.deepStrictEqual(r1, { ok: true, to: orchName, delivery: 'submitted' });
  const sub = mgr.submits.filter(x => x.tabId === orchSession.tabId).at(-1);
  assert.strictEqual(sub.data, `[message from ${w.worker}] need a decision`);
  assert.deepStrictEqual(sub.opts, { priority: 'next', from: w.worker });
  const card = { kind: 'message', from: w.worker, to: orchName, text: 'need a decision' };
  assert.deepStrictEqual(msgEvents(mgr, orchSession.tabId), [card]);
  assert.deepStrictEqual(msgEvents(mgr, w.tabId), [card]);

  // Orchestrator -> busy worker, by its id: still submitted, with priority next.
  wSession.busy = true;
  const r2 = orch.sendMessage(orchSession.instanceId, { to: 'w1', message: 'also fix b' });
  assert.strictEqual(r2.delivery, 'submitted');
  assert.strictEqual(r2.to, w.worker);
  assert.deepStrictEqual(mgr.submits.filter(x => x.tabId === w.tabId).at(-1).opts, { priority: 'next', from: orchName });
  // The PostToolUse watcher sees the MCP tool by its suffix: a worker that
  // messaged its orchestrator has reported.
  hook(orch, wSession, { hook_event_name: 'UserPromptSubmit' });
  hook(orch, wSession, { hook_event_name: 'PostToolUse', tool_name: 'mcp__orchestrator__SendMessage', tool_input: { to: orchName } });
  assert.deepStrictEqual(hook(orch, wSession, { hook_event_name: 'Stop' }), {});

  // Refusals.
  assert.throws(() => orch.sendMessage(wSession.instanceId, { to: 'nobody', message: 'x' }), /no member nobody[\s\S]*Members: orch-/);
  assert.throws(() => orch.sendMessage(wSession.instanceId, { to: w.worker, message: 'x' }), /your own address/);
  assert.throws(() => orch.sendMessage(wSession.instanceId, { to: orchName, message: ' ' }), /message is required/);
  wSession.running = false;
  assert.throws(() => orch.sendMessage(orchSession.instanceId, { to: w.worker, message: 'x' }), /not running.*resume_worker/);

  // ListAgents: both members, with state.
  const list = orch.listAgents(orchSession.instanceId);
  assert.strictEqual(list.you, orchName);
  assert.deepStrictEqual(list.agents.map(a => [a.name, a.role]), [[orchName, 'orchestrator'], [w.worker, 'worker']]);
  assert.strictEqual(list.agents[1].state, 'stopped');
});

test('SendMessage to a CLI member: typed when idle, through its next hook when busy', async (t) => {
  const { orch, orchSession, mgr, broadcasts } = await openOrchestrator(t, { isolation: 'none' });
  const orchName = orchSession.settings.name;
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  const wSession = mgr.sessions.get(w.tabId);

  assert.strictEqual(orch.sendMessage(orchSession.instanceId, { to: w.worker, message: 'one' }).delivery, 'submitted');
  assert.deepStrictEqual(mgr.submits.filter(x => x.tabId === w.tabId).at(-1).opts, { from: orchName });
  // No panel: the message is still broadcast for both session ids.
  const sent = broadcasts.filter(b => b.type === 'sdk:event' && b.ev.platform?.kind === 'message');
  assert.deepStrictEqual(sent.map(b => b.sessId).sort(), [orchSession.sessId, wSession.sessId].sort());

  wSession.busy = true;
  const before = mgr.submits.length;
  assert.strictEqual(orch.sendMessage(orchSession.instanceId, { to: w.worker, message: 'two' }).delivery, 'queued');
  assert.strictEqual(mgr.submits.length, before, 'nothing typed into a busy terminal');
  const post = JSON.parse(hook(orch, wSession, { hook_event_name: 'PostToolUse', tool_name: 'Read' }).stdout);
  assert.strictEqual(post.hookSpecificOutput.additionalContext, `[message from ${orchName}] two`);
  assert.deepStrictEqual(hook(orch, wSession, { hook_event_name: 'PostToolUse', tool_name: 'Read' }), {}, 'delivered once');

  // Still queued when the turn ends: the Stop continues it with the message.
  orch.sendMessage(orchSession.instanceId, { to: w.worker, message: 'three' });
  const stop = JSON.parse(hook(orch, wSession, { hook_event_name: 'Stop' }).stdout);
  assert.strictEqual(stop.decision, 'block');
  assert.match(stop.reason, /three/);

  // To a busy CLI orchestrator: merged with its worker events.
  hook(orch, orchSession, { hook_event_name: 'UserPromptSubmit' });
  orchSession.busy = true;
  orch.sendMessage(wSession.instanceId, { to: 'orchestrator', message: 'question' });
  orch.report(wSession.instanceId, { status: 'blocked', summary: 'stuck' });
  const ctx = JSON.parse(hook(orch, orchSession, { hook_event_name: 'PostToolUse', tool_name: 'Read' }).stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /\[message from [^\]]+\] question[\s\S]*reported blocked: stuck/);
});

test('the orchestrator MCP server offers SendMessage / ListAgents to SDK sessions only', () => {
  const CliSession = require('../src/cli-session');
  const env = (engine) => CliSession.buildMcpServers({ settings: { engine, orchestration: { role: 'worker' } }, instanceId: 'cli-x' }).orchestrator.env;
  assert.strictEqual(env('sdk').VISTACLAIR_ORCH_ENGINE, 'sdk');
  assert.strictEqual(env(undefined).VISTACLAIR_ORCH_ENGINE, 'cli');
  const src = fs.readFileSync(path.join(CORE, 'lib', 'orchestrator-mcp.js'), 'utf8');
  assert.match(src, /name: "SendMessage",\s*path: "send-message"/);
  assert.match(src, /name: "ListAgents",\s*path: "list-agents"/);
  assert.match(src, /name: "close_worker",\s*path: "close-worker"/);
  assert.match(src, /name: "stop_worker",\s*path: "stop-worker"/);
  const { MAX_WORKERS } = require('../src/orchestration');
  assert.doesNotMatch(src, /At most 3|3-worker/);
  assert.match(src, new RegExp(`MAX_WORKERS run(ning)? at once \\(${MAX_WORKERS}\\)`));
});

// --- Tool grants (src/tool-packs.js consumes / validate) ---

const toolPacks = require('../src/tool-packs');
function clearPacks() { for (const p of toolPacks.listToolPacks()) toolPacks.unregisterToolPack(p.id); }

test('tool grants without a consuming pack: no tools parameter, a tools value is refused, nothing changes', async (t) => {
  clearPacks();
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none' });
  assert.deepStrictEqual(orch.toolParams(), { params: {} });
  toolPacks.registerToolPack({ id: 'plain-pack', build: () => ({}) });
  assert.deepStrictEqual(orch.toolParams(), { params: {} }, 'a pack that consumes nothing');
  assert.throws(() => orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x', tools: ['a__b'] }), /no tool pack of this worker handles tools/);
  assert.throws(() => orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x', tools: [] }), /no tool pack/);
  assert.strictEqual(run().workers.length, 0);
  assert.strictEqual(run().workerSeq, 0);
  assert.strictEqual(mgr.launches.length, 1, 'only the orchestrator');
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  assert.ok(!('grants' in mgr.sessions.get(w.tabId).settings));
  assert.ok(!('grants' in run().workers[0]));
  assert.ok(!('grants' in orch.describeRun(run()).workers[0]));
  assert.throws(() => orch.resumeWorker(orchSession.instanceId, { worker: 'w1', mode: 'continue', tools: [] }), /already running/);
  clearPacks();
});

test('tool grants: launch_cli tools persist on the worker, resume keeps, replaces or clears them', async (t) => {
  clearPacks();
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none' });
  // A worker-only pack: the parameter shows as soon as any pack consumes tools.
  toolPacks.registerToolPack({ id: 'apps', roles: ['worker'], default: true, consumes: ['tools'], build: () => ({}) });
  const params = orch.toolParams().params;
  assert.deepStrictEqual(Object.keys(params), ['launch_cli', 'resume_worker']);
  assert.strictEqual(params.launch_cli.tools.type, 'array');
  assert.deepStrictEqual(params.resume_worker.tools.items, { type: 'string' });
  assert.match(params.resume_worker.tools.description, /empty array clears/);

  assert.throws(() => orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x', tools: 'a__b' }), /tools must be an array/);
  assert.throws(() => orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x', tools: ['a__b', ''] }), /tools must be an array/);
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x', tools: ['crm__find', 'crm__add', 'crm__find'] });
  const grants = { tools: ['crm__find', 'crm__add'] };
  const s1 = mgr.sessions.get(w.tabId);
  assert.deepStrictEqual(s1.settings.grants, grants, 'on the session settings');
  assert.deepStrictEqual(run().workers[0].grants, grants, 'on the run record');
  assert.deepStrictEqual(mgr.findSaved(s1.sessId).settings.grants, grants, 'in its saved entry');
  assert.deepStrictEqual(orch.listWorkers(orchSession.instanceId).workers[0].grants, grants);

  const close = () => {
    const live = [...mgr.sessions.values()].find(x => x.settings.orchestration?.workerId === 'w1');
    orch.report(live.instanceId, { status: 'done', summary: 'ok' });
    orch.closeWorker(orchSession.instanceId, { worker: 'w1' });
    return live;
  };
  close();
  assert.strictEqual(mgr.closeReasons.at(-1), 'close_worker');
  assert.deepStrictEqual(orch.listWorkers(orchSession.instanceId).workers[0].grants, grants, 'a compact entry shows them too');

  // Continue without tools: kept.
  let r = orch.resumeWorker(orchSession.instanceId, { worker: 'w1', mode: 'continue' });
  assert.strictEqual(mgr.sessions.get(r.tabId).sessId, s1.sessId);
  assert.deepStrictEqual(mgr.sessions.get(r.tabId).settings.grants, grants);
  close();
  // Continue with tools: replaced, on the resumed session and the record.
  r = orch.resumeWorker(orchSession.instanceId, { worker: 'w1', mode: 'continue', tools: ['crm__export'] });
  assert.deepStrictEqual(mgr.sessions.get(r.tabId).settings.grants, { tools: ['crm__export'] });
  assert.deepStrictEqual(run().workers[0].grants, { tools: ['crm__export'] });
  close();
  // Fresh with an empty array: cleared everywhere.
  r = orch.resumeWorker(orchSession.instanceId, { worker: 'w1', mode: 'fresh', tools: [] });
  assert.strictEqual(r.mode, 'fresh');
  assert.ok(!('grants' in mgr.sessions.get(r.tabId).settings));
  assert.ok(!('grants' in run().workers[0]));
  assert.ok(!('grants' in orch.listWorkers(orchSession.instanceId).workers[0]));
  close();
  // Continue after a clear: the saved session had none, none come back.
  r = orch.resumeWorker(orchSession.instanceId, { worker: 'w1', mode: 'continue', tools: ['crm__find'] });
  assert.deepStrictEqual(mgr.sessions.get(r.tabId).settings.grants, { tools: ['crm__find'] });
  close();
  r = orch.resumeWorker(orchSession.instanceId, { worker: 'w1', mode: 'continue', tools: [] });
  assert.ok(!('grants' in mgr.sessions.get(r.tabId).settings), 'cleared on a continue too');
  clearPacks();
});

test('tool grants: a pack\'s validate refuses a launch or a resume with its message, launching nothing', async (t) => {
  clearPacks();
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none' });
  const asked = [];
  toolPacks.registerToolPack({
    id: 'apps', roles: ['worker'], default: true, consumes: ['tools'], build: () => ({}),
    validate: ({ settings, role }) => {
      asked.push({ role, grants: settings.grants || null, worker: settings.orchestration.workerId });
      const bad = (settings.grants?.tools || []).filter(n => !n.startsWith('crm__'));
      if (bad.length) throw new Error(`unknown tool ${bad.join(', ')}`);
    },
  });
  assert.throws(() => orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x', tools: ['crm__find', 'evil__rm'] }), /^Error: unknown tool evil__rm$/);
  assert.strictEqual(run().workers.length, 0, 'no worker recorded');
  assert.strictEqual(mgr.launches.length, 1, 'nothing launched');
  assert.deepStrictEqual(asked, [{ role: 'worker', grants: { tools: ['crm__find', 'evil__rm'] }, worker: 'w1' }]);

  // validate runs without tools too (every worker launch).
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x', tools: ['crm__find'] });
  assert.strictEqual(asked.length, 2);
  const s1 = mgr.sessions.get(w.tabId);
  orch.report(s1.instanceId, { status: 'done', summary: 'ok' });
  orch.closeWorker(orchSession.instanceId, { worker: 'w1' });
  const launches = mgr.launches.length;
  assert.throws(() => orch.resumeWorker(orchSession.instanceId, { worker: 'w1', mode: 'fresh', tools: ['evil__rm'] }), /unknown tool evil__rm/);
  assert.strictEqual(mgr.launches.length, launches);
  assert.strictEqual(run().workers[0].closed, true, 'still closed');
  assert.deepStrictEqual(run().workers[0].grants, { tools: ['crm__find'] }, 'grants unchanged');
  // The "+" menu resume is checked too.
  toolPacks.registerToolPack({ id: 'gate', roles: ['worker'], default: true, build: () => ({}), validate: () => { throw new Error('apps are offline'); } });
  assert.throws(() => orch.resumeSavedWorker(s1.sessId), /apps are offline/);
  clearPacks();
});

test('sendToSession: an add-on message reaches a run session by its address, like SendMessage', async (t) => {
  const { orch, orchSession, mgr, r } = await openOrchestrator(t, { isolation: 'none' });
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  const ws = mgr.sessions.get(w.tabId);
  const before = mgr.submits.length;
  assert.deepStrictEqual(orch.sendToSession(w.worker, 'job 7 finished', { from: 'apps' }), { delivered: true, how: 'submitted' });
  assert.deepStrictEqual(mgr.submits.slice(before), [{ tabId: w.tabId, data: '[message from apps] job 7 finished', opts: { from: 'apps' } }]);
  // A busy terminal reads it at its next hook.
  ws.busy = true;
  assert.deepStrictEqual(orch.sendToSession(w.worker, 'job 8 finished', { from: 'apps' }), { delivered: true, how: 'queued' });
  const out = hook(orch, ws, { hook_event_name: 'PostToolUse', tool_name: 'Read' });
  assert.match(out.stdout, /\[message from apps\] job 8 finished/);
  // The orchestrator by its address.
  assert.strictEqual(orch.sendToSession(orchSession.settings.name, 'hello', { from: 'apps' }).delivered, true);
  assert.deepStrictEqual(orch.sendToSession('orch-nope-w9', 'x', { from: 'apps' }), { delivered: false, how: 'no session with that address' });
  assert.throws(() => orch.sendToSession(w.worker, '  ', { from: 'apps' }), /text is required/);
  assert.ok(r.tabId);
});

// The real MCP server against a fake dashboard: launch_cli / resume_worker
// list `tools` only when the dashboard's tool-params names it. Needs the MCP
// SDK under mcp-servers/integrated (installed with the app).
const MCP_SDK = path.join(CORE, 'mcp-servers', 'integrated', 'node_modules', '@modelcontextprotocol', 'sdk');
test('the orchestrator MCP lists the tools parameter only when the dashboard offers it', { skip: !fs.existsSync(MCP_SDK) && 'MCP SDK not installed' }, async () => {
  const http = require('http');
  const { spawn } = require('child_process');
  let params = {};
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/api/orchestration/tool-params' ? { params } : { error: 'unexpected' }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const list = (port) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(CORE, 'lib', 'orchestrator-mcp.js')], {
      env: { ...process.env, VISTACLAIR_DASHBOARD_PORT: String(port), VISTACLAIR_ORCH_ROLE: 'orchestrator', VISTACLAIR_INSTANCE_ID: 'cli-x' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('no tools/list answer')); }, 10000);
    p.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 2) { clearTimeout(timer); p.kill(); resolve(m.result.tools); }
      }
    });
    const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  });
  try {
    const port = server.address().port;
    const plain = await list(port);
    const props = (tools, name) => Object.keys(tools.find(t => t.name === name).inputSchema.properties);
    assert.deepStrictEqual(props(plain, 'launch_cli'), ['title', 'task', 'cwd', 'isolation', 'model']);
    assert.deepStrictEqual(props(plain, 'resume_worker'), ['worker', 'mode', 'message']);
    // No dashboard at all: the same schemas.
    const closed = http.createServer();
    await new Promise(r => closed.listen(0, '127.0.0.1', r));
    const deadPort = closed.address().port;
    await new Promise(r => closed.close(r));
    assert.deepStrictEqual(await list(deadPort), plain);

    clearPacks();
    toolPacks.registerToolPack({ id: 'apps', roles: ['worker'], default: true, consumes: ['tools'], build: () => ({}) });
    params = setup().orch.toolParams().params;
    clearPacks();
    const granted = await list(port);
    assert.deepStrictEqual(props(granted, 'launch_cli'), ['title', 'task', 'cwd', 'isolation', 'model', 'tools']);
    assert.deepStrictEqual(props(granted, 'resume_worker'), ['worker', 'mode', 'message', 'tools']);
    assert.deepStrictEqual(granted.find(t => t.name === 'launch_cli').inputSchema.required, ['title', 'task']);
    assert.deepStrictEqual(granted.filter(t => !['launch_cli', 'resume_worker'].includes(t.name)), plain.filter(t => !['launch_cli', 'resume_worker'].includes(t.name)));
  } finally {
    server.close();
  }
});

// --- Landing by code (src/worktree-landing.js), in throwaway repos ---

// A repo on `main` with a declared dependency link (.data, gitignored, its
// content in the main checkout) and an optional check.
function landingRepo({ check = null } = {}) {
  const repo = tmpDir('vistaclair-land-repo-');
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' }).toString().trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.data/\n');
  fs.writeFileSync(path.join(repo, 'f.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(repo, '.vistaclair-worktree.json'), JSON.stringify({ links: ['.data', 'missing'], ...(check ? { check } : {}) }));
  g('add', '.'); g('commit', '-qm', 'init');
  fs.mkdirSync(path.join(repo, '.data'));
  fs.writeFileSync(path.join(repo, '.data', 'db.txt'), 'keep me');
  return { repo, g };
}
const commitAll = (dir, files, msg = 'work') => {
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', msg]);
};
async function landingRun(t, opts) {
  const { repo, g } = landingRepo(opts);
  const ctx = await openOrchestrator(t, { cwd: repo });
  const launch = (title = 'a') => {
    const w = ctx.orch.launchWorker(ctx.orchSession.instanceId, { title, task: 'x' });
    return { ...w, session: ctx.mgr.sessions.get(w.tabId) };
  };
  const done = async (w, summary = 'did it') => {
    const r = ctx.orch.report(w.session.instanceId, { status: 'done', summary });
    await ctx.orch.landingOf(w.worker);
    return r;
  };
  const events = (kind) => ctx.run().events.filter(e => e.kind === kind).map(e => e.text);
  const toWorker = (w) => ctx.mgr.submits.filter(x => x.tabId === w.tabId).map(x => x.data).join('\n');
  return { ...ctx, repo, g, launch, done, events, toWorker };
}

test('landing: links made and recorded at launch; a done report rebases, checks and merges --no-ff; repeated done lands what is new', async (t) => {
  const { orch, repo, g, launch, done, events, run } = await landingRun(t, { check: 'test -f a.txt && echo checked > .data-check-ran' });
  const w = launch();
  const link = path.join(w.cwd, '.data');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.strictEqual(fs.readlinkSync(link), path.join(repo, '.data'));
  assert.deepStrictEqual(run().workers[0].worktree.links, [{ path: link, target: path.join(repo, '.data') }], 'only what exists is linked');
  assert.strictEqual(run().workers[0].base, 'main');

  commitAll(w.cwd, { 'a.txt': 'a' });
  commitAll(repo, { 'b.txt': 'b' }, 'owner moved main');
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'owner wip');     // a dirty file the landing does not touch
  const before = g('rev-parse', 'main');
  const r = await done(w, 'added a\nmore lines');
  assert.match(r.landing, /being landed/);

  const merge = g('rev-parse', 'main');
  assert.strictEqual(g('rev-parse', 'main^1'), before, 'merged onto the base as it was');
  assert.strictEqual(g('rev-parse', 'main^2'), g('rev-parse', w.branch), 'its branch, rebased');
  assert.strictEqual(g('log', '-1', '--format=%s', 'main'), `Merge ${w.branch}: added a`);
  assert.ok(fs.existsSync(path.join(repo, 'a.txt')), 'the main checkout has it');
  assert.ok(fs.existsSync(path.join(w.cwd, '.data-check-ran')), 'the check ran in the worktree');
  assert.strictEqual(fs.readFileSync(path.join(repo, 'unrelated.txt'), 'utf8'), 'owner wip');
  const rec = run().landings[0];
  assert.deepStrictEqual([rec.worker, rec.preLandSha, rec.mergeSha, rec.base], [w.worker, before, merge, 'main']);
  assert.ok(rec.at);
  assert.deepStrictEqual(events('landed'), [`landed ${merge} — ${w.worker}'s ${w.branch} merged into main`]);
  assert.ok(!run().workers[0].landing, 'nothing in flight');

  fs.rmSync(path.join(w.cwd, '.data-check-ran'));
  assert.strictEqual((await done(w)).landing, undefined, 'nothing new: no landing');
  assert.strictEqual(run().landings.length, 1);
  commitAll(w.cwd, { 'a2.txt': 'a2' });
  await done(w, 'second');
  assert.strictEqual(run().landings.length, 2);
  assert.strictEqual(g('rev-list', '--count', `${merge}..main`), '2', 'the new commit and its merge');
  assert.strictEqual(g('ls-tree', '--name-only', 'main', '.data'), '', 'the link was never committed');
});

test('landing: a conflict is aborted, the base untouched, the same worker told; a gone worker sends the orchestrator a merge session', async (t) => {
  const { repo, g, launch, done, events, toWorker } = await landingRun(t);
  const w = launch();
  commitAll(w.cwd, { 'f.txt': 'one\nTWO-worker\nthree\n' });
  commitAll(repo, { 'f.txt': 'one\nTWO-owner\nthree\n' });
  const base = g('rev-parse', 'main');
  const head = g('rev-parse', w.branch);
  await done(w);
  assert.strictEqual(g('rev-parse', 'main'), base, 'base untouched');
  assert.strictEqual(g('rev-parse', w.branch), head, 'the rebase was aborted');
  assert.strictEqual(execFileSync('git', ['-C', w.cwd, 'status', '--porcelain']).toString(), '');
  assert.match(toWorker(w), /\[vistaclair landing\] Your branch was not landed: it conflicts with main in f\.txt/);
  assert.match(events('not landed')[0], /conflicts with main in f\.txt; main untouched\. Sent back to/);

  w.session.running = false;
  await done(w);
  assert.match(events('not landed')[1], /is not running: resume_worker it with this, or launch a worker to merge .* into its own branch/);
});

test('landing: a failing check goes back to the worker with its output; nothing merged', async (t) => {
  const { g, launch, done, events, toWorker } = await landingRun(t, { check: 'echo boom-output; exit 3' });
  const w = launch();
  commitAll(w.cwd, { 'a.txt': 'a' });
  const base = g('rev-parse', 'main');
  await done(w);
  assert.strictEqual(g('rev-parse', 'main'), base);
  assert.match(toWorker(w), /the repo's check failed[\s\S]*boom-output/);
  assert.match(events('not landed')[0], /the check failed .*boom-output/);
});

test('landing: real uncommitted changes stop it in the report\'s answer; the links do not count', async (t) => {
  const { repo, g, launch, done, events, run } = await landingRun(t);
  const w = launch();
  commitAll(w.cwd, { 'a.txt': 'a' });
  fs.writeFileSync(path.join(w.cwd, 'f.txt'), 'edited');
  fs.mkdirSync(path.join(w.cwd, 'newdir'));
  fs.writeFileSync(path.join(w.cwd, 'newdir', 'x'), 'x');
  const base = g('rev-parse', 'main');
  const r = await done(w);
  assert.match(r.landing, /uncommitted changes \(M f\.txt, \?\? newdir\/\)\. Commit them/);
  assert.strictEqual(g('rev-parse', 'main'), base);
  assert.match(events('not landed')[0], /uncommitted changes in its worktree/);
  assert.ok(!/\.data/.test(r.landing), 'the link is not a change');

  // Without its info/exclude line git lists the link; the check still skips it.
  const exclude = path.join(repo, '.git', 'info', 'exclude');
  fs.writeFileSync(exclude, fs.readFileSync(exclude, 'utf8').replace('/.data\n', ''));
  assert.match(execFileSync('git', ['-C', w.cwd, 'status', '--porcelain']).toString(), /\?\? \.data\n/);
  const { changes } = require('../src/worktree-landing');
  assert.deepStrictEqual(changes(w.cwd, run().workers[0].worktree.links).map(c => c.path), ['f.txt', 'newdir/']);
});

test('landing: the owner\'s uncommitted changes to a landed file block it, changing nothing', async (t) => {
  const { repo, g, launch, done, events } = await landingRun(t);
  const w = launch();
  commitAll(w.cwd, { 'f.txt': 'worker\n' });
  fs.writeFileSync(path.join(repo, 'f.txt'), 'owner wip\n');
  const base = g('rev-parse', 'main');
  await done(w);
  assert.strictEqual(g('rev-parse', 'main'), base);
  assert.strictEqual(fs.readFileSync(path.join(repo, 'f.txt'), 'utf8'), 'owner wip\n');
  assert.match(events('not landed')[0], /the owner has uncommitted changes in .* to files this landing changes \(f\.txt\)\. Nothing changed/);
});

test('landing: the base recorded at launch is respected when the main checkout moved to another branch', async (t) => {
  const { orch, orchSession, repo, g, launch, done, run } = await landingRun(t);
  const w = launch();
  g('checkout', '-q', '-b', 'other');
  commitAll(w.cwd, { 'a.txt': 'a' });
  const other = g('rev-parse', 'other');
  await done(w);
  assert.strictEqual(g('rev-parse', 'other'), other, 'the checked-out branch is untouched');
  assert.ok(!fs.existsSync(path.join(repo, 'a.txt')), 'so is the owner\'s working tree');
  assert.strictEqual(g('rev-parse', 'main^2'), g('rev-parse', w.branch), 'main got the merge');
  assert.strictEqual(run().landings[0].mergeSha, g('rev-parse', 'main'));
  const undo = await orch.undoLanding(orchSession.instanceId, { worker: 'w1' });
  assert.strictEqual(g('rev-parse', 'main'), undo.revertSha, 'reverted on main, not checked out anywhere');
  assert.strictEqual(g('rev-parse', 'other'), other);
  assert.strictEqual(g('worktree', 'list').split('\n').filter(l => /vistaclair-undo-/.test(l)).length, 0, 'its scratch worktree is gone');
  w.session.running = false;
  assert.deepStrictEqual(orch.endRun(orchSession.instanceId).removed, [w.worker]);
  assert.strictEqual(g('branch', '--list', w.branch), '', 'merged into main: deleted though HEAD is other');
});

test('teardown: a running worker keeps it; at close the worktree and its links go, the link target stays', async (t) => {
  const { orch, orchSession, repo, g, launch, done } = await landingRun(t);
  const w = launch();
  commitAll(w.cwd, { 'a.txt': 'a' });
  await done(w);
  const res = orch.endRun(orchSession.instanceId);
  assert.deepStrictEqual(res.kept, [{ worker: w.worker, reason: 'still running' }]);
  assert.strictEqual(res.closed, false);
  assert.ok(fs.existsSync(w.cwd));

  assert.strictEqual(orch.closeWorker(orchSession.instanceId, { worker: 'w1' }).worktree, 'removed');
  assert.ok(!fs.existsSync(w.cwd));
  assert.strictEqual(g('branch', '--list', w.branch), '');
  assert.strictEqual(fs.readFileSync(path.join(repo, '.data', 'db.txt'), 'utf8'), 'keep me', 'the link target is intact');
  assert.deepStrictEqual(orch.endRun(orchSession.instanceId), { removed: [], kept: [], closed: true });
});

test('teardown: an untracked file or directory keeps the worktree, at exit and end_run', async (t) => {
  const { orch, orchSession, mgr, launch, done, run } = await landingRun(t);
  const w = launch();
  commitAll(w.cwd, { 'a.txt': 'a' });
  await done(w);
  fs.mkdirSync(path.join(w.cwd, 'junk', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(w.cwd, 'junk', 'deep', 'x'), 'x');
  fs.writeFileSync(path.join(w.cwd, 'stray.txt'), 'x');
  mgr.sessions.delete(w.tabId);
  w.session.running = false;
  orch.onSessionExit(w.tabId, w.session);
  assert.deepStrictEqual(run().workers[0].worktreeKept.files, ['?? junk/', '?? stray.txt'], 'a directory is one entry');
  const res = orch.endRun(orchSession.instanceId);
  assert.deepStrictEqual(res.kept, [{ worker: w.worker, reason: 'uncommitted changes', files: ['?? junk/', '?? stray.txt'] }]);
  assert.ok(fs.existsSync(path.join(w.cwd, 'junk', 'deep', 'x')));
  assert.ok(fs.lstatSync(path.join(w.cwd, '.data')).isSymbolicLink(), 'the link is still there');
  fs.rmSync(path.join(w.cwd, 'junk'), { recursive: true });
  fs.rmSync(path.join(w.cwd, 'stray.txt'));
  assert.deepStrictEqual(orch.endRun(orchSession.instanceId).removed, [w.worker]);
});

test('undo_landing: a revert commit on the base, refused over the owner\'s changes to its files', async (t) => {
  const { orch, orchSession, repo, g, launch, done, run } = await landingRun(t);
  const w = launch();
  commitAll(w.cwd, { 'f.txt': 'worker\n', 'a.txt': 'a' });
  await done(w);
  const merge = run().landings[0].mergeSha;
  fs.writeFileSync(path.join(repo, 'a.txt'), 'owner edit');
  await assert.rejects(orch.undoLanding(orchSession.instanceId, { worker: 'w1' }), /uncommitted changes .* \(a\.txt\); nothing changed/);
  assert.strictEqual(g('rev-parse', 'main'), merge);
  g('checkout', '--', 'a.txt');

  const r = await orch.undoLanding(orchSession.instanceId, { landing: merge.slice(0, 10) });
  assert.strictEqual(r.undone, merge);
  assert.strictEqual(g('rev-parse', 'main'), r.revertSha);
  assert.strictEqual(g('rev-parse', 'main^'), merge, 'a new commit on top');
  assert.ok(!fs.existsSync(path.join(repo, 'a.txt')));
  assert.strictEqual(fs.readFileSync(path.join(repo, 'f.txt'), 'utf8'), 'one\ntwo\nthree\n');
  assert.strictEqual(run().landings[0].undone.revertSha, r.revertSha);
  await assert.rejects(orch.undoLanding(orchSession.instanceId, { landing: merge }), /already undone/);
});

test('landing: one cut off by a restart has its rebase aborted and is reported not landed', async (t) => {
  const { orch, repo, g, launch, events, run } = await landingRun(t);
  const w = launch();
  commitAll(w.cwd, { 'f.txt': 'worker\n' });
  commitAll(repo, { 'f.txt': 'owner\n' });
  assert.throws(() => execFileSync('git', ['-C', w.cwd, 'rebase', 'main'], { stdio: 'pipe' }));
  const file = path.join(run().runDir, 'run.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.workers[0].landing = { at: new Date().toISOString(), branch: w.branch, base: 'main' };
  fs.writeFileSync(file, JSON.stringify(saved));

  assert.ok(!orch.getRun(run().runId).workers[0].landing);
  assert.strictEqual(execFileSync('git', ['-C', w.cwd, 'status', '--porcelain']).toString(), '', 'the rebase is aborted');
  assert.strictEqual(g('rev-parse', `${w.branch}^`), g('rev-parse', 'main^'), 'the branch as it was');
  assert.match(events('not landed')[0], /cut off by a restart \(rebase aborted\); main is as before/);
});

// --- Worker areas and overlap warnings ---

test('launch_cli area: an overlap with a running worker in the same repo is named in the result; none, no mention', async (t) => {
  const { orch, orchSession, mgr, run } = await landingRun(t);
  const launch = (title, area) => orch.launchWorker(orchSession.instanceId, { title, task: 'x', area });
  const a = launch('a', ['src/**', 'README.md']);
  assert.deepStrictEqual(run().workers[0].area, ['src/**', 'README.md'], 'recorded');
  assert.strictEqual(a.overlaps, undefined);
  const b = launch('b', ['./src/lib/x.js', 'docs/']);
  assert.deepStrictEqual(b.overlaps, [{ worker: a.worker, paths: ['src/lib/x.js ~ src/**'] }]);
  assert.match(b.note, /overlaps running workers' areas .* It was launched: serialize them, or expect a conflict/);
  assert.ok(mgr.sessions.get(b.tabId).running, 'launched all the same');
  const c = launch('c', ['docs/guide.md', 'tests/*.js']);
  assert.deepStrictEqual(c.overlaps.map(o => [o.worker, o.paths]), [[b.worker, ['docs/guide.md ~ docs']]]);
  const d = launch('d', ['lib', '*.txt']);
  assert.strictEqual(d.overlaps, undefined);
  assert.strictEqual(d.note, undefined);
  mgr.sessions.get(a.tabId).running = false;
  assert.strictEqual(launch('e', ['src/main.js']).overlaps, undefined, 'a worker no longer running does not count');
  assert.throws(() => launch('f', ['../elsewhere']), /relative to the repo root/);
});

test('overlap check: a file changed in two live worktrees is one event, not repeated; isolation none and single workers ignored', async (t) => {
  const { orch, orchSession, repo, events } = await landingRun(t);
  const launch = (title, isolation) => orch.launchWorker(orchSession.instanceId, { title, task: 'x', ...(isolation ? { isolation } : {}) });
  const a = launch('a');
  const n = launch('n', 'none');
  commitAll(a.cwd, { 'shared.txt': 'a', 'only-a.txt': 'a' });
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'n');   // the isolation-none worker, in the main checkout
  orch.checkOverlaps();
  assert.deepStrictEqual(events('overlap'), [], 'one live worktree worker: nothing to compare');

  const b = launch('b');
  fs.writeFileSync(path.join(b.cwd, 'shared.txt'), 'b');   // uncommitted counts too
  fs.writeFileSync(path.join(b.cwd, 'f.txt'), 'b');
  orch.checkOverlaps();
  assert.deepStrictEqual(events('overlap'), [`files changed in more than one worktree: shared.txt (${a.worker}, ${b.worker}). Serialize those workers, or expect a conflict when the later one lands`]);
  orch.checkOverlaps();
  assert.strictEqual(events('overlap').length, 1, 'the same file and pair is not told again');

  commitAll(a.cwd, { 'f.txt': 'a' });
  orch.checkOverlaps();
  assert.match(events('overlap')[1], new RegExp(`^files changed in more than one worktree: f\\.txt \\(${a.worker}, ${b.worker}\\)`));
  assert.ok(!events('overlap').some(e => e.includes(n.worker) || e.includes('.data') || e.includes('only-a')));
});
