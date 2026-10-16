// The inspector's session list (src/inspector-sessions.js): the light summary
// the Sessions tab draws its cards from, and removal — at most 20 inactive
// sessions per group, Clear per kind, autoclear — which deletes a session's
// interactions/<sessId> dir and nothing outside it.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshModules(home) {
  process.env.VISTACLAIR_HOME = home;
  for (const m of ['../src/store', '../src/utils', '../src/capabilities', '../src/inspector-sessions', '../src/session-totals']) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
  return {
    InteractionStore: require('../src/store'),
    ...require('../src/inspector-sessions'),
  };
}

const uuid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

// A registry over a real store in a throwaway home, with the live process list
// in the test's hands. Summaries are recorded instead of sent.
function setup(opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vistaclair-insp-'));
  const mods = freshModules(home);
  const store = new mods.InteractionStore(200);
  const listeners = new Set();
  const sent = [];
  const broadcaster = {
    broadcast(msg) { sent.push(msg); for (const fn of listeners) fn(msg); },
    onBroadcast(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const procs = new Map(); // instanceId → status
  const reg = new mods.InspectorSessions({
    store, broadcaster,
    getInstances: () => [...procs].map(([instanceId, status]) => ({ instanceId, status, spawnedAt: 1 })),
    removeInstances: (ids) => { for (const id of ids) if (procs.get(id) !== 'running') procs.delete(id); },
    throttleMs: 0, prefsFile: path.join(home, 'data', 'inspector-prefs.json'),
    ...opts,
  });
  // Ahead of the clock, so activity order is the order of the calls.
  let t = Date.now() + 1e6;
  // One finished turn for an instance, as the proxy reports it.
  const turn = (instanceId, extra = {}) => {
    t += 10;
    const i = { id: `${instanceId}-${t}`, instanceId, timestamp: t, request: { model: 'claude-x' }, response: {}, status: 'complete', usage: { input_tokens: 1000000 }, pricing: { inputCostPerMTok: 2 }, ...extra };
    store.add(i);
    broadcaster.broadcast({ type: 'interaction:start', interaction: { ...i, status: 'pending' } });
    broadcaster.broadcast({ type: 'interaction:complete', interaction: i });
    return i;
  };
  const spawn = (id) => { procs.set(id, 'running'); broadcaster.broadcast({ type: 'claude:instances', event: 'spawn', instanceId: id, instances: [...procs].map(([instanceId, status]) => ({ instanceId, status })) }); };
  const exit = (id) => { procs.set(id, 'exited'); broadcaster.broadcast({ type: 'claude:instances', event: 'exit', instanceId: id, instances: [...procs].map(([instanceId, status]) => ({ instanceId, status })) }); };
  const ids = () => reg.list().map(s => s.instanceId).sort();
  return { home, store, reg, sent, turn, spawn, exit, ids, procs, mods, done: () => reg.close() };
}

test('the summary feed carries cards, not interactions, throttled', async () => {
  const { reg, sent, turn, spawn, done } = setup({ throttleMs: 50 });
  spawn('cli-' + uuid(1));
  turn('app-qmd-ai-ab12');
  turn('app-qmd-ai-ab12', { isHook: true, hookEvent: 'UserPromptSubmit', request: { cwd: '/w' }, usage: null });
  assert.strictEqual(sent.filter(m => m.type === 'inspector:sessions').length, 0, 'nothing before the throttle window');
  await new Promise(r => setTimeout(r, 80));
  const feeds = sent.filter(m => m.type === 'inspector:sessions');
  assert.strictEqual(feeds.length, 1, 'changes in one window coalesce into one push');
  const cards = Object.fromEntries(feeds[0].sessions.map(s => [s.instanceId, s]));
  const app = cards['app-qmd-ai-ab12'];
  assert.deepStrictEqual(
    { kind: app.kind, label: app.label, model: app.model, turns: app.turns, apiCalls: app.apiCalls, cost: app.cost, status: app.status, cwd: app.cwd },
    { kind: 'app', label: 'qmd · AI', model: 'claude-x', turns: 1, apiCalls: 1, cost: 2, status: 'inactive', cwd: '/w' });
  assert.strictEqual(cards['cli-' + uuid(1)].status, 'running');
  assert.ok(!('interactions' in feeds[0]));
  assert.strictEqual(reg.summaryMessage().type, 'inspector:sessions', 'the snapshot sent on connect');
  done();
});

test('a turn in flight shows the session as streaming', () => {
  const { reg, store, done } = setup();
  const live = { id: 'l1', instanceId: 'ext-' + uuid(9), timestamp: 1, request: {}, response: {}, status: 'streaming' };
  store.add(live);
  reg.broadcaster.broadcast({ type: 'interaction:start', interaction: live });
  assert.strictEqual(reg.list()[0].status, 'streaming');
  live.status = 'complete';
  reg.broadcaster.broadcast({ type: 'interaction:complete', interaction: live });
  assert.strictEqual(reg.list()[0].status, 'running', 'an external session stays up while recently active');
  done();
});

test('pruning: the 21st inactive session of a group removes the oldest; running ones are untouched', () => {
  const { reg, turn, spawn, ids, done } = setup();
  spawn('app-run-ai-0001');             // running, oldest of all
  turn('app-run-ai-0001');
  for (let n = 1; n <= 20; n++) turn(`app-a-ai-${n.toString(16).padStart(4, '0')}`);
  for (let n = 1; n <= 3; n++) turn(`ext-${uuid(n)}`, { timestamp: 1 });
  reg.flush();
  assert.strictEqual(ids().filter(id => id.startsWith('app-a-')).length, 20, 'twenty inactive are kept');

  turn('app-a-ai-0015');                 // 21st: a fresh one, newest
  turn('app-b-ai-ffff');
  reg.flush();
  const app = ids().filter(id => id.startsWith('app-'));
  assert.ok(!app.includes('app-a-ai-0001'), 'the oldest inactive went');
  assert.ok(app.includes('app-b-ai-ffff'));
  assert.ok(app.includes('app-run-ai-0001'), 'a running session never counts or goes');
  assert.strictEqual(app.length, 21);
  assert.strictEqual(ids().filter(id => id.startsWith('ext-')).length, 3, 'other groups are counted apart');
  done();
});

test('Clear removes the inactive sessions of one kind only', () => {
  const { reg, turn, spawn, exit, ids, sent, done } = setup();
  spawn('cli-' + uuid(1)); turn('cli-' + uuid(1));
  spawn('cli-' + uuid(2)); turn('cli-' + uuid(2)); exit('cli-' + uuid(2));
  turn('app-x-ai-0001');
  reg.clearKind('cli');
  assert.deepStrictEqual(ids(), ['app-x-ai-0001', 'cli-' + uuid(1)]);
  const removed = sent.filter(m => m.type === 'inspector:sessionsRemoved');
  assert.deepStrictEqual(removed.at(-1).instanceIds, ['cli-' + uuid(2)], 'browsers are told so they close the tab');
  done();
});

test('autoclear removes every session as soon as it is inactive, and persists', () => {
  const { reg, turn, spawn, exit, ids, home, mods, done } = setup();
  spawn('cli-' + uuid(1)); turn('cli-' + uuid(1));
  turn('app-x-ai-0001');
  reg.setAutoClear(true);
  assert.deepStrictEqual(ids(), ['cli-' + uuid(1)], 'app AI follows the same rule');
  exit('cli-' + uuid(1));
  reg.flush();
  assert.deepStrictEqual(ids(), []);
  const prefs = JSON.parse(fs.readFileSync(path.join(home, 'data', 'inspector-prefs.json'), 'utf8'));
  assert.strictEqual(prefs.autoClear, true);
  done();
  const again = new mods.InspectorSessions({
    store: reg.store, broadcaster: { broadcast() {}, onBroadcast: () => () => {} },
    prefsFile: path.join(home, 'data', 'inspector-prefs.json'),
  });
  assert.strictEqual(again.autoClear, true, 'the toggle survives a restart');
  again.close();
});

test('removal deletes interactions/<sessId> and stays inside it', async () => {
  const { home, store, reg, turn, spawn, exit, done } = setup();
  const id = 'cli-' + uuid(7);
  const sessId = uuid(7);
  const dir = path.join(home, 'interactions', sessId);
  spawn(id);
  store.registerSession(id, sessId);
  const t = turn(id);
  store.save(t.id);
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'uploads', 'a.png'), 'x');
  // Kept: Claude-side and orchestration folders, the spend ledger.
  const keep = ['data/sessions/w1/NOTES.md', 'spend-ledger/x.json'].map(p => path.join(home, p));
  for (const p of keep) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'k'); }

  // A headless run whose dir is a symlink out of the interactions root.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vistaclair-outside-'));
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'k');
  const linkSess = uuid(8);
  fs.symlinkSync(outside, path.join(home, 'interactions', linkSess));
  store.registerSession('app-l-ai-0001', linkSess);
  turn('app-l-ai-0001');
  store.unregisterSession('app-l-ai-0001');

  // Wait for the store's async writes.
  await new Promise(r => setTimeout(r, 50));
  assert.ok(fs.readdirSync(dir).some(f => f.endsWith('.json')));
  store.unregisterSession(id);
  exit(id);
  reg.clearKind('cli');
  reg.clearKind('app');
  await reg.settled();

  assert.ok(!fs.existsSync(dir), 'the session dir is gone');
  assert.ok(!store.getAll().some(i => i.instanceId === id), 'and its turns are out of memory');
  for (const p of keep) assert.ok(fs.existsSync(p), `${p} kept`);
  assert.ok(!fs.existsSync(path.join(home, 'interactions', linkSess)), 'the link itself is removed');
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')), 'what it pointed at is not');
  done();
});

test('a dir another session still uses is kept', async () => {
  const { home, store, reg, turn, spawn, done } = setup();
  const sessId = uuid(5);
  fs.mkdirSync(path.join(home, 'interactions', sessId), { recursive: true });
  // An ai.prompt run that shares its Claude session with a live CLI tab.
  store.registerSession('app-s-ai-0001', sessId);
  turn('app-s-ai-0001');
  store.unregisterSession('app-s-ai-0001');
  spawn('cli-' + sessId);
  store.registerSession('cli-' + sessId, sessId);
  reg.clearKind('app');
  await reg.settled();
  assert.ok(fs.existsSync(path.join(home, 'interactions', sessId)));
  done();
});

test('external requests are grouped by the Claude Code session they name', () => {
  const { externalInstanceId, kindOf } = freshModules(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-')));
  const sid = 'd6c897b9-61d0-42fe-b9c1-d78e60417911';
  assert.strictEqual(externalInstanceId({ metadata: { user_id: JSON.stringify({ device_id: 'd', session_id: sid }) } }), `ext-${sid}`);
  assert.strictEqual(externalInstanceId({ metadata: { user_id: `user_abc_account_x_session_${sid}` } }), `ext-${sid}`);
  assert.strictEqual(externalInstanceId({}), 'ext');
  assert.strictEqual(kindOf(`ext-${sid}`), 'ext');
  assert.strictEqual(kindOf('cli-x'), 'cli');
  assert.strictEqual(kindOf('rule-gen-1'), 'app');
});

test('run members carry their run and role; the summary names each run\'s status', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-insp-run-'));
  const runDir = path.join(home, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ runId: 'r9', orchestrator: 'orch-r9', workers: [{ id: 'w1' }, { id: 'w2' }] }));
  const stamp = (role, workerId) => ({ settings: { orchestration: { runId: 'r9', role, workerId, orchestrator: 'orch-r9', runDir } } });
  // The orchestrator is live; a worker is known only from its saved entry.
  const live = { ['cli-' + uuid(21)]: stamp('orchestrator') };
  const history = [{ id: uuid(22), settings: { ...stamp('worker', 'w1').settings, name: 'orch-r9-w1-ui' } }, { id: uuid(23), settings: {} }];
  let historyReads = 0;
  const cliSessionManager = {
    getByInstanceId: (id) => (live[id] ? { getSettings: () => live[id].settings } : null),
    listSaved: () => { historyReads++; return history; },
    list: () => [],
  };
  const { reg, turn, spawn, done } = setup({ cliSessionManager });
  spawn('cli-' + uuid(21));
  turn('cli-' + uuid(22));
  turn('cli-' + uuid(23));
  const by = Object.fromEntries(reg.list().map(s => [s.instanceId, s]));
  assert.deepStrictEqual(by['cli-' + uuid(21)].orchestration, { runId: 'r9', role: 'orchestrator', workerId: null, name: 'orch-r9' });
  assert.deepStrictEqual(by['cli-' + uuid(22)].orchestration, { runId: 'r9', role: 'worker', workerId: 'w1', name: 'orch-r9-w1-ui' });
  assert.strictEqual(by['cli-' + uuid(23)].orchestration, null, 'a plain session');
  const reads = historyReads;
  reg.list();
  assert.strictEqual(historyReads, reads, 'resolved once, then cached');
  const msg = reg.summaryMessage();
  assert.deepStrictEqual(msg.runs, { r9: { status: 'running', orchestrator: 'orch-r9', workers: 2 } });
  done();
  fs.rmSync(home, { recursive: true, force: true });
});
