// External sessions as untrusted input (src/external-session.js): an add-on's
// adapter relays another machine's data, so a faulty or hostile peer must not
// answer another session's question, take a real session's id, point sdk:todo
// outside DATA_HOME, smuggle settings fields, claim another run's members or
// hang a request. A fake wss and browser stand in for the dashboard; nothing
// spawns `claude`.
//
//   node --test test/

const fs = require('fs');
const os = require('os');
const path = require('path');

// Before anything reads them: a throwaway data home and $HOME.
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-extsec-')));
const OUTSIDE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-extsec-out-')));
process.env.VISTACLAIR_HOME = HOME;
process.env.HOME = HOME;
process.env.VISTACLAIR_DASHBOARD_PORT = '';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const InteractionStore = require('../src/store');
const DashboardBroadcaster = require('../src/dashboard-ws');
const CliSessionManager = require('../src/cli-sessions');
const { pendingQuestions } = require('../src/proxy');
const { createOrchestration } = require('../src/orchestration');
const { ExternalSession, CALL_TIMEOUT_MS, MAX_SETTINGS } = require('../src/external-session');

const SESS = '1e1e1e1e-1111-2222-3333-444444444444';
const OTHER = '1f1f1f1f-1111-2222-3333-444444444444';
const OWN = '1d1d1d1d-1111-2222-3333-444444444444';
const SAVED = '1c1c1c1c-1111-2222-3333-444444444444';
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));
test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
});

function fakeAdapter(over = {}, sessId = SESS) {
  const calls = [];
  const sessionDir = path.join(HOME, 'peer-remote', sessId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  const adapter = {
    sessId, kind: 'sdk', title: 'remote job',
    settings: { engine: 'sdk', auth: 'apikey', sessionDir, externalHost: 'slave-1' },
    running: true, busy: false, state: 'idle',
    submit: rec('submit'), interrupt: rec('interrupt'), setModel: rec('setModel'), setShowThinking: rec('setShowThinking'),
    setAuth: rec('setAuth'), historyPage: () => ({ events: [], hasMore: false, before: null, totals: null }),
    kill: rec('kill'), close: rec('close'),
    ...over,
  };
  return { adapter, calls, sessionDir };
}

function setup() {
  const store = new InteractionStore(50);
  const wss = new EventEmitter();
  wss.clients = new Set();
  const bc = new DashboardBroadcaster(wss, store, { sessions: { throttleMs: 0 } });
  const mgr = new CliSessionManager(1, bc, store);
  bc.cliSessionManager = mgr;
  return { wss, bc, mgr, done: () => bc.sessions.close() };
}

function connect(wss) {
  const sent = [];
  let onMessage = null;
  const ws = {
    readyState: WebSocket.OPEN,
    send: (raw) => { try { sent.push(JSON.parse(raw)); } catch {} },
    on: (ev, fn) => { if (ev === 'message') onMessage = fn; },
  };
  wss.clients.add(ws);
  wss.emit('connection', ws);
  return { ws, sent, send: (msg) => onMessage(JSON.stringify(msg)) };
}

// One of the manager's own SDK tabs (a stand-in: nothing spawns).
function ownTab(mgr, tabId, sessId, settings = {}) {
  const s = { sessId, cwd: HOME, title: 'own', kind: 'sdk', busy: false, running: true, getSettings: () => ({ engine: 'sdk', ...settings }), kill() {} };
  mgr.sessions.set(tabId, s);
  return s;
}

// A pending question; `answered` records what resolved it.
function ask(id, entry) {
  const rec = { answered: null };
  pendingQuestions.set(id, { formData: {}, questions: [], reject() {}, ...entry, resolve: (a) => { rec.answered = a; } });
  return rec;
}

test('1: an ask:answer resolves an external tab\'s question only when it names that tab', () => {
  const { wss, mgr, done } = setup();
  mgr.registerExternal('remote-a', fakeAdapter().adapter);
  mgr.registerExternal('remote-b', fakeAdapter({}, OTHER).adapter);
  ownTab(mgr, 'tab-1', OWN);
  // A relayed ask (Pro's shape: ctx.tabId, host, remote), one tagged by the
  // contract alone, and two local ones (a tab's, and one with no tab).
  const relayed = ask('ask-a', { ctx: { tabId: 'remote-a' }, host: 'slave-1', remote: { peer: 'slave-1', tabId: 'remote-a' },
    message: { type: 'ask:question', askId: 'ask-a', host: 'slave-1', remote: { peer: 'slave-1', tabId: 'remote-a' } } });
  const tagged = ask('ask-b', { external: true, tabId: 'remote-b' });
  const local = ask('ask-l', { ctx: { tabId: 'tab-1' }, message: { type: 'ask:question', askId: 'ask-l', tabId: 'tab-1' } });
  const global = ask('ask-g', { ctx: null, message: { type: 'ask:question', askId: 'ask-g' } });
  try {
    const b = connect(wss);
    // Marked on the replay: external, with its tab and session.
    const entry = pendingQuestions.get('ask-a');
    assert.deepStrictEqual([entry.external, entry.tabId, entry.sessId], [true, 'remote-a', SESS]);
    assert.strictEqual(pendingQuestions.get('ask-l').external, undefined, 'a local ask is not marked');
    const errors = () => b.sent.filter(m => m.type === 'ask:answerError');
    b.sent.length = 0;

    // Refused: by id alone, naming another tab or session, an unknown id; and
    // a remote form's answer (naming its external tab) to a local question.
    b.send({ type: 'ask:answer', toolUseId: 'ask-a', answer: ['x'] });
    b.send({ type: 'ask:answer', toolUseId: 'ask-a', tabId: 'remote-b', answer: ['x'] });
    b.send({ type: 'ask:answer', toolUseId: 'ask-a', tabId: 'tab-1', answer: ['x'] });
    b.send({ type: 'ask:answer', toolUseId: 'ask-a', tabId: 'remote-a', sessId: OTHER, answer: ['x'] });
    b.send({ type: 'ask:answer', toolUseId: 'ask-b', sessId: SESS, answer: ['x'] });
    b.send({ type: 'ask:answer', toolUseId: 'ask-l', tabId: 'remote-a', answer: ['x'] });
    b.send({ type: 'ask:answer', toolUseId: 'ask-l', sessId: SESS, answer: ['x'] });
    b.send({ type: 'ask:answer', toolUseId: 'ask-g', tabId: 'remote-a', answer: ['x'] });
    b.send({ type: 'ask:answer', toolUseId: 'ask-nope', tabId: 'remote-a', answer: ['x'] });
    b.send({ type: 'ask:answer', toolUseId: { not: 'a string' }, answer: ['x'] });
    assert.strictEqual(errors().length, 10);
    assert.deepStrictEqual(errors().slice(0, 3).map(m => m.toolUseId), ['ask-a', 'ask-a', 'ask-a']);
    assert.match(errors()[0].error, /must name its tab/);
    assert.match(errors()[1].error, /another session/);
    assert.match(errors()[8].error, /no longer waiting/);
    assert.deepStrictEqual([relayed.answered, tagged.answered, local.answered, global.answered], [null, null, null, null]);
    assert.ok(!b.sent.some(m => m.type === 'ask:answered'), 'nothing was answered');
    assert.strictEqual(pendingQuestions.size, 4);

    // A second browser hears none of the refusals.
    const other = connect(wss);
    other.sent.length = 0;
    b.send({ type: 'ask:answer', toolUseId: 'ask-a', answer: ['x'] });
    assert.deepStrictEqual(other.sent, []);

    // Accepted: naming the tab or the session; local asks as before (by id,
    // or naming their own tab).
    b.send({ type: 'ask:answer', toolUseId: 'ask-a', tabId: 'remote-a', answer: ['yes'] });
    b.send({ type: 'ask:answer', toolUseId: 'ask-b', sessId: OTHER, answer: ['ok'] });
    b.send({ type: 'ask:answer', toolUseId: 'ask-l', answer: ['local'] });
    b.send({ type: 'ask:answer', toolUseId: 'ask-g', tabId: 'tab-1', answer: ['global'] });
    assert.deepStrictEqual([relayed.answered, tagged.answered, local.answered, global.answered], [['yes'], ['ok'], ['local'], ['global']]);
    assert.deepStrictEqual(other.sent.filter(m => m.type === 'ask:answered').map(m => m.askId), ['ask-a', 'ask-b', 'ask-l', 'ask-g']);

    // A local tab's ask answered under its own tab's name also resolves.
    const named = ask('ask-l2', { ctx: { tabId: 'tab-1' }, message: { type: 'ask:question', askId: 'ask-l2', tabId: 'tab-1' } });
    b.send({ type: 'ask:answer', toolUseId: 'ask-l2', tabId: 'tab-1', sessId: OWN, answer: ['mine'] });
    assert.deepStrictEqual(named.answered, ['mine']);
  } finally {
    for (const id of ['ask-a', 'ask-b', 'ask-l', 'ask-g', 'ask-l2']) pendingQuestions.delete(id);
    done();
  }
});

test('2: a sessId any live, saved or external session has is refused', () => {
  const { mgr, done } = setup();
  ownTab(mgr, 'tab-1', OWN);
  fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'data', 'cli-history.json'), JSON.stringify([{ id: SAVED, cwd: HOME, settings: { engine: 'sdk' } }]));
  try {
    assert.throws(() => mgr.registerExternal('remote-own', fakeAdapter({}, OWN).adapter), /session .* already exists/);
    assert.throws(() => mgr.registerExternal('remote-saved', fakeAdapter({}, SAVED).adapter), /session .* already exists/);
    mgr.registerExternal('remote-a', fakeAdapter().adapter);
    assert.throws(() => mgr.registerExternal('remote-b', fakeAdapter().adapter), /session .* already exists/);
    assert.deepStrictEqual(mgr.list().filter(t => t.external).map(t => t.tabId), ['remote-a']);
    assert.strictEqual(mgr.getBySessId(OWN), mgr.get('tab-1'), 'the real session keeps its id');
  } finally {
    fs.rmSync(path.join(HOME, 'data', 'cli-history.json'), { force: true });
    done();
  }
});

test('3: settings.sessionDir is kept only inside DATA_HOME; sdk:todo reads nothing outside it', () => {
  const { wss, mgr, done } = setup();
  fs.writeFileSync(path.join(OUTSIDE, 'TODO.md'), '| id | description | depends on | status |\n|--|--|--|--|\n| 1 | secret | – | doing |\n');
  fs.writeFileSync(path.join(OUTSIDE, 'NOTES.md'), 'secret notes');
  fs.symlinkSync(OUTSIDE, path.join(HOME, 'link-out'));
  fs.mkdirSync(`${HOME}-evil`, { recursive: true });
  const dirOf = (sessionDir) => new ExternalSession('t', { ...fakeAdapter().adapter, settings: { sessionDir } }).getSettings().sessionDir;
  try {
    const inside = path.join(HOME, 'peer-remote', SESS);
    assert.strictEqual(dirOf(inside), inside);
    assert.strictEqual(dirOf(path.join(HOME, 'peer-remote', 'not-yet', 'made')), path.join(HOME, 'peer-remote', 'not-yet', 'made'), 'a folder still to be made');
    assert.strictEqual(dirOf('peer-remote/x'), path.join(HOME, 'peer-remote', 'x'), 'relative to DATA_HOME');
    for (const bad of [
      OUTSIDE, '/etc', `${HOME}/peer-remote/../../${path.basename(OUTSIDE)}`, '../outside', `${HOME}/link-out`,
      `${HOME}/link-out/sub`, `${HOME}-evil`, `${HOME}-evil/x`, HOME, `${HOME}/`, '', 42, { p: HOME }, 'x'.repeat(5000),
    ]) {
      assert.strictEqual(dirOf(bad), undefined, `dropped: ${String(bad).slice(0, 80)}`);
    }

    // Through the handler: an outside folder answers an empty todo.
    mgr.registerExternal('remote-a', fakeAdapter({ settings: { engine: 'sdk', sessionDir: `${HOME}/link-out` } }).adapter);
    assert.strictEqual(mgr.list()[0].settings.sessionDir, undefined);
    assert.strictEqual(mgr.sessionDirOf(SESS), null);
    const b = connect(wss);
    b.send({ type: 'sdk:todo', sessId: SESS });
    assert.deepStrictEqual(b.sent.find(m => m.type === 'sdk:todo'), { type: 'sdk:todo', sessId: SESS, rows: [], notes: '' });
  } finally {
    fs.unlinkSync(path.join(HOME, 'link-out'));
    fs.rmSync(`${HOME}-evil`, { recursive: true, force: true });
    done();
  }
});

test('4: settings keep only known fields, type-checked and capped; oversized settings are dropped', () => {
  const { mgr, done } = setup();
  const settings = {
    engine: 'cli', auth: 'apikey', model: 'm'.repeat(1000), showThinking: true, externalHost: 'h'.repeat(500), name: 'n'.repeat(500),
    modelMap: { opus: 'claude-opus-5-5', evil: 'x', haiku: 7 },
    orchestration: { runId: 'r1', role: 'worker', workerId: 'w1', runDir: '/etc', extra: 1 },
    title: 'dropped', cwd: '/etc', grants: { tools: ['*'] }, worktree: { cwd: '/' }, toolPacks: ['x'],
  };
  mgr.registerExternal('remote-a', fakeAdapter({ settings }).adapter);
  const s = mgr.list()[0].settings;
  assert.deepStrictEqual(Object.keys(s).sort(), ['auth', 'engine', 'externalHost', 'model', 'modelMap', 'name', 'orchestration', 'showThinking']);
  assert.strictEqual(s.engine, 'sdk');
  assert.deepStrictEqual([s.model.length, s.externalHost.length, s.name.length], [200, 100, 100]);
  assert.deepStrictEqual(s.modelMap, { fable: null, opus: 'claude-opus-5-5', sonnet: null, haiku: null });
  assert.deepStrictEqual(s.orchestration, { runId: 'r1', role: 'worker', workerId: 'w1' });

  // Wrong types are dropped, not coerced.
  const typed = new ExternalSession('t', { ...fakeAdapter().adapter, settings: { auth: 'bogus', showThinking: 'yes', model: 5, externalHost: { toString: () => 'h' }, orchestration: { role: 'god' } } });
  assert.deepStrictEqual(typed.getSettings(), { engine: 'sdk' });
  // Over MAX_SETTINGS: nothing of it but the engine.
  const big = new ExternalSession('t', { ...fakeAdapter().adapter, settings: { auth: 'apikey', pad: 'x'.repeat(MAX_SETTINGS) } });
  assert.deepStrictEqual(big.getSettings(), { engine: 'sdk' });
  // A throwing settings getter reads as none.
  const throwing = fakeAdapter().adapter;
  Object.defineProperty(throwing, 'settings', { get() { throw new Error('getter'); } });
  assert.deepStrictEqual(new ExternalSession('t', throwing).getSettings(), { engine: 'sdk' });
  done();
});

test('5: an adapter\'s run description is trusted only for its own run\'s tabs', async () => {
  const { bc, mgr, done } = setup();
  const orch = createOrchestration({ mgr, broadcaster: bc, pendingQuestions: new Map(), coreRoot: path.join(__dirname, '..'), dataHome: HOME });
  const layer = orch.router().stack.find(l => l.route?.path === '/run');
  const get = (runId) => new Promise((resolve) => {
    const res = {
      statusCode: 200, headersSent: false,
      status(c) { this.statusCode = c; return this; },
      json(body) { this.headersSent = true; resolve({ status: this.statusCode, body }); },
    };
    layer.route.stack[0].handle({ query: { runId } }, res);
  });
  const stamp = (runId, role, host = 'slave-1') => ({ engine: 'sdk', externalHost: host, orchestration: { runId, role } });
  const W1 = '2a2a2a2a-1111-2222-3333-444444444444';
  const FOREIGN = '2b2b2b2b-1111-2222-3333-444444444444';
  const REMOTE = '2c2c2c2c-1111-2222-3333-444444444444';

  ownTab(mgr, 'tab-1', OWN, { orchestration: { runId: 'real-run', role: 'orchestrator' } });
  let described = null;
  mgr.registerExternal('remote-o', fakeAdapter({ settings: stamp('r9', 'orchestrator'), orchestration: () => described }).adapter);
  mgr.registerExternal('remote-w1', fakeAdapter({ settings: stamp('r9', 'worker') }, W1).adapter);
  // Another peer's tab, and one of another run.
  mgr.registerExternal('remote-x', fakeAdapter({ settings: stamp('r9', 'worker', 'slave-2') }, FOREIGN).adapter);
  mgr.registerExternal('remote-claim', fakeAdapter({ settings: stamp('real-run', 'orchestrator'), orchestration: () => ({ runId: 'real-run', workers: [] }) }, OTHER).adapter);

  // A real run's id is never answered by an adapter that claims it.
  assert.strictEqual(mgr.externalOrchestration('real-run'), null);
  assert.strictEqual((await get('real-run')).status, 404);

  described = {
    runId: 'r9', orchestrator: 'orch-r9', orchestratorSessId: OWN, orchestratorTabId: 'tab-1',
    workers: [
      { name: 'w1', sessId: W1, tabId: 'remote-w1' },
      { name: 'remote-only', sessId: REMOTE, tabId: 'tab-on-slave' },
      { name: 'steal-own', sessId: OWN, tabId: null },
      { name: 'steal-own-tab', sessId: null, tabId: 'tab-1' },
      { name: 'steal-peer', sessId: FOREIGN, tabId: 'remote-x' },
      { name: 'steal-peer-tab', sessId: REMOTE, tabId: 'remote-x' },
      'junk',
    ],
  };
  const r = await get('r9');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.runId, 'r9');
  assert.deepStrictEqual([r.body.orchestratorSessId, r.body.orchestratorTabId], [null, null], 'not the real session');
  assert.deepStrictEqual(r.body.workers, [
    { name: 'w1', sessId: W1, tabId: 'remote-w1' },
    { name: 'remote-only', sessId: REMOTE, tabId: null },
  ]);

  // Its own tab as orchestrator is kept; another run's id is refused.
  described = { runId: 'r9', orchestratorSessId: SESS, orchestratorTabId: 'remote-o', workers: [] };
  assert.deepStrictEqual((await get('r9')).body, described);
  described = { runId: 'real-run', workers: [] };
  assert.deepStrictEqual(await get('r9'), { status: 502, body: { error: 'the external session described another run' } });
  done();
});

test('6: an adapter call that never answers times out with an error; its late result is ignored', async () => {
  const { wss, mgr, done } = setup();
  assert.strictEqual(CALL_TIMEOUT_MS, 30000);
  assert.strictEqual(ExternalSession.callTimeoutMs, CALL_TIMEOUT_MS);
  ExternalSession.callTimeoutMs = 20;
  try {
    const late = [];
    const { adapter } = fakeAdapter({
      submit: () => new Promise(() => {}),
      historyPage: () => new Promise((resolve) => setTimeout(() => { late.push('history'); resolve({ events: [{ late: true }] }); }, 60)),
      interrupt: () => new Promise((_, reject) => setTimeout(() => { late.push('interrupt'); reject(new Error('too late')); }, 60)),
      setAuth: async () => ({ applied: 'now' }),
    });
    mgr.registerExternal('remote-a', adapter);
    const b = connect(wss);
    b.sent.length = 0;

    b.send({ type: 'sdk:send', sessId: SESS, text: 'x' });
    b.send({ type: 'sdk:history', sessId: SESS });
    b.send({ type: 'cli:interrupt', tabId: 'remote-a', reqId: 'q1' });
    b.send({ type: 'cli:sessionAuth', tabId: 'remote-a', auth: 'apikey', reqId: 'q2' });
    await sleep(40);
    const notice = b.sent.find(m => m.type === 'sdk:event');
    assert.strictEqual(notice.ev.platform.text, 'Not sent: the external session did not answer submit() within 0.02 s');
    assert.match(b.sent.find(m => m.type === 'sdk:history').error, /did not answer historyPage\(\)/);
    const intr = b.sent.find(m => m.type === 'cli:actionResult' && m.action === 'interrupt');
    assert.deepStrictEqual([intr.reqId, intr.ok], ['q1', undefined]);
    assert.match(intr.error, /did not answer interrupt\(\)/);
    // A call that answers in time is unaffected.
    const auth = b.sent.find(m => m.type === 'cli:actionResult' && m.action === 'auth');
    assert.deepStrictEqual([auth.error, auth.applied], [undefined, { now: 1 }]);

    const count = b.sent.length;
    await sleep(80);
    assert.deepStrictEqual(late.sort(), ['history', 'interrupt'], 'the adapter did answer, late');
    assert.strictEqual(b.sent.length, count, 'and nothing more was sent');
    await tick();
    assert.deepStrictEqual(unhandled, []);
  } finally {
    ExternalSession.callTimeoutMs = CALL_TIMEOUT_MS;
    done();
  }
});
