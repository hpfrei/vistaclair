// Remote sessions against core's real external-session hook: Pro's
// peer-remote-master adapter registered through core's createAddonCtx
// (registerExternalSession → CliSessionManager.registerExternal →
// ExternalSession) and driven by a fake browser through core's real
// DashboardBroadcaster and cli-handler. The peer channel is a stub; nothing
// listens, nothing spawns.
//
// Core is loaded read-only, in-process, by path — a test-only exception to the
// seam (docs/seam.md): VISTACLAIR_CORE_DIR, else the nearest ancestor holding
// core's src/external-session.js (the sibling checkout, or the core that hosts
// this worktree), else ~/vistaclair (a clone anywhere else). Skipped, loudly,
// when none is found (an older core).
//
//   node --test test/peer-remote-integration.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

function findCore() {
  const has = (d) => fs.existsSync(path.join(d, 'src', 'external-session.js')) && fs.existsSync(path.join(d, 'src', 'addon-host.js'));
  if (process.env.VISTACLAIR_CORE_DIR) return has(process.env.VISTACLAIR_CORE_DIR) ? path.resolve(process.env.VISTACLAIR_CORE_DIR) : null;
  for (let d = path.resolve(__dirname, '..', '..'); ; d = path.dirname(d)) {
    if (has(d)) return d;
    if (path.dirname(d) === d) break;
  }
  const home = path.join(os.homedir(), 'vistaclair');
  return has(home) ? home : null;
}
const CORE = findCore();
const SKIP_REASON = process.env.VISTACLAIR_CORE_DIR
  ? `VISTACLAIR_CORE_DIR=${process.env.VISTACLAIR_CORE_DIR} holds no core with src/external-session.js`
  : `no core with src/external-session.js above ${path.resolve(__dirname, '..')} nor in ~/vistaclair (set VISTACLAIR_CORE_DIR)`;
if (!CORE) console.warn(`\n*** peer-remote-integration SKIPPED: ${SKIP_REASON} ***\n`);

// Before core reads them: a throwaway data home and $HOME, no live dashboard.
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-prm-int-')));
process.env.VISTACLAIR_HOME = HOME;
process.env.HOME = HOME;
process.env.VISTACLAIR_DASHBOARD_PORT = '';
delete process.env.VISTACLAIR_AUTH_TOKEN;

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const prm = require('../src/apps/peer-remote-master');

const skip = CORE ? false : SKIP_REASON;
const core = (rel) => require(path.join(CORE, rel));

const SLAVE_SESS = '11111111-2222-4333-8444-555555555555';
const UUID_RE = /^[0-9a-f-]{36}$/;
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));
test.after(() => { prm.shutdown(); fs.rmSync(HOME, { recursive: true, force: true }); });

// Core's dashboard pieces, Pro's master half on them, a scripted slave.
function setup() {
  const WebSocket = core('node_modules/ws');
  const InteractionStore = core('src/store');
  const DashboardBroadcaster = core('src/dashboard-ws');
  const CliSessionManager = core('src/cli-sessions');
  const { createAddonCtx } = core('src/addon-host');
  // The map the broadcaster replays and resolves from (server.js hands the ctx this one).
  const { pendingQuestions } = core('src/proxy');

  const store = new InteractionStore(50);
  const wss = new EventEmitter();
  wss.clients = new Set();
  const bc = new DashboardBroadcaster(wss, store, { sessions: { throttleMs: 0 } });
  const mgr = new CliSessionManager(1, bc, store);
  bc.cliSessionManager = mgr;
  const seen = [];
  bc.onBroadcast((m) => seen.push(JSON.parse(JSON.stringify(m))));
  const ctx = createAddonCtx({ dataHome: HOME, dashboard: { broadcaster: bc, store, cliSessionManager: mgr, pendingQuestions } });

  const env = { calls: [], fail: new Map(), page: null, frameFn: null, seen, mgr, bc, wss, pendingQuestions };
  let n = 0;
  const peerChannel = {
    fleetState: () => ({ peers: [{ name: 's1', connected: true, claude: { loggedIn: true, email: 'owner@x.io', orgName: 'Org' } }] }),
    onRemoteFrame(fn) { env.frameFn = fn; return () => { env.frameFn = null; }; },
    onEvent() { return () => {}; },
    async remoteCommand(peer, op, args) {
      env.calls.push({ peer, op, args });
      if (env.fail.has(op)) { const e = new Error(env.fail.get(op)); e.code = 'unknown-tab'; throw e; }
      if (op === 'launch') return { tabId: n++ ? `tab_${n}.x` : 'tab-1', sessId: SLAVE_SESS };
      if (op === 'history') return env.page;
      if (op === 'todo') return { todo: '| id | description | depends on | status |\n|--|--|--|--|\n| 1 | remote step | – | doing |\n', notes: 'remote notes' };
      if (op === 'list') return [];
      return {};
    },
  };
  prm.init({
    broadcaster: bc, pendingQuestions,
    registerExternalSession: ctx.registerExternalSession,
    isOwnerConnection: ctx.isOwnerConnection,
    // Hermetic: never this machine's Claude login.
    claudeAuthInfo: () => ({ hasSubscription: true, email: 'owner@x.io', orgName: 'Org' }),
    claudeStatus: () => null,
    dataHome: HOME, peerChannel,
  });
  // As src/apps/index.js wires it.
  const sender = (ws) => (m) => { try { ws.send(JSON.stringify(m)); } catch {} };
  bc.registerHandler(['app:peer:session', 'app:peer:remoteAlert'], {
    onConnect: (ws) => prm.onConnect(sender(ws)),
    handleMessage: (ws, msg) => prm.handleWs(ws, msg, sender(ws)),
  });

  // A connected dashboard browser: what it is sent, and a way to send as it would.
  env.connect = () => {
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
  };
  env.ops = (op) => env.calls.filter((c) => c.op === op);
  env.frame = (f) => env.frameFn('s1', f);
  env.done = () => { prm.shutdown(); bc.sessions?.close?.(); };
  return env;
}

const SPEC = { mode: 'simple', app: 'notes', prompt: 'do it', auth: 'subscription', title: 'Notes fix' };

test('a launched remote session is a core SDK tab, driven through core\'s cli-handler', { skip }, async () => {
  const env = setup();
  const browser = env.connect();
  const other = env.connect();

  // Launched from the owner's socket, through core's broadcaster routing.
  browser.send({ type: 'app:peer:session:launch', reqId: 'L1', peer: 's1', ...SPEC });
  await settle();
  const res = browser.sent.find((m) => m.type === 'app:peer:session:launchResult');
  assert.equal(res.ok, true, res.error);
  const { tabId, sessId } = res;
  assert.match(sessId, UUID_RE);
  assert.notEqual(sessId, SLAVE_SESS);

  // Listed by core as an external SDK tab; announced as spawned.
  const entry = env.mgr.list().find((t) => t.tabId === tabId);
  assert.ok(entry, 'in core\'s list()');
  assert.deepEqual([entry.kind, entry.external, entry.sessId, entry.status, entry.title, entry.settings.externalHost, entry.settings.engine],
    ['sdk', true, sessId, 'running', '[s1] Notes fix', 's1', 'sdk']);
  assert.equal(env.mgr.getBySessId(sessId).tabId, tabId);
  assert.ok(env.seen.some((m) => m.type === 'cli:spawned' && m.tabId === tabId && m.external === true));
  assert.ok(env.connect().sent.find((m) => m.type === 'cli:tabs').tabs.some((t) => t.tabId === tabId && t.external));

  // sdk:* reaches the stub channel, scoped to the slave tab.
  env.calls.length = 0;
  browser.send({ type: 'sdk:send', sessId, text: 'next step' });
  browser.send({ type: 'sdk:interrupt', sessId });
  browser.send({ type: 'sdk:setModel', sessId, model: 'claude-sonnet-5-5' });
  browser.send({ type: 'cli:sessionAuth', tabId, auth: 'apikey', reqId: 'A1' });
  await settle();
  assert.deepEqual(env.calls.map((c) => [c.peer, c.op, c.args]), [
    ['s1', 'submit', { tabId: 'tab-1', text: 'next step' }],
    ['s1', 'interrupt', { tabId: 'tab-1' }],
    ['s1', 'setModel', { tabId: 'tab-1', model: 'claude-sonnet-5-5' }],
    ['s1', 'setAuth', { tabId: 'tab-1', auth: 'apikey', continueTurn: false }],
  ]);
  const auth = browser.sent.find((m) => m.type === 'cli:actionResult' && m.action === 'auth');
  assert.deepEqual([auth.reqId, auth.error, auth.applied], ['A1', undefined, { remote: 1 }]);

  // History: a numeric cursor goes to the slave; its page comes back under the
  // master sessId, its own cursor only when it is a number.
  env.page = { events: [{ sessId: SLAVE_SESS, ts: 3, off: 7, ev: { sdk: { type: 'assistant', message: { content: [] } } } }, { ev: { bogus: 1 } }], hasMore: true, before: 42, totals: { costUsd: 0.5, compactions: 1 } };
  browser.send({ type: 'sdk:history', sessId, limit: 50, before: 100 });
  await settle();
  assert.deepEqual(env.ops('history').at(-1).args, { tabId: 'tab-1', limit: 50, before: 100 });
  const hist = browser.sent.find((m) => m.type === 'sdk:history');
  assert.deepEqual(hist, {
    type: 'sdk:history', sessId, from: 100,
    events: [{ sessId, ts: 3, ev: { sdk: { type: 'assistant', message: { content: [] } } }, off: 7 }],
    hasMore: true, before: 42, totals: { costUsd: 0.5, compactions: 1 },
  });
  env.page = { events: [], hasMore: true, before: '0; DROP', totals: null };
  browser.sent.length = 0;
  browser.send({ type: 'sdk:history', sessId, before: '12' });
  await settle();
  assert.deepEqual(env.ops('history').at(-1).args, { tabId: 'tab-1', before: 12 });
  assert.equal(browser.sent.find((m) => m.type === 'sdk:history').before, null, 'a non-numeric slave cursor is dropped');

  // A refused remote call is an error for its requester, not a crash.
  env.fail.set('submit', 'no such tab on s1');
  env.fail.set('history', 'peer unreachable');
  browser.sent.length = 0;
  other.sent.length = 0;
  browser.send({ type: 'sdk:send', sessId, text: 'again' });
  browser.send({ type: 'sdk:history', sessId });
  await settle();
  const notice = browser.sent.find((m) => m.type === 'sdk:event' && m.ev?.platform?.kind === 'notice');
  assert.deepEqual([notice.sessId, notice.ev.platform.level, notice.ev.platform.text], [sessId, 'error', 'Not sent: no such tab on s1']);
  assert.equal(browser.sent.find((m) => m.type === 'sdk:history').error, 'peer unreachable');
  assert.ok(!other.sent.some((m) => m.ev?.platform?.kind === 'notice' || m.error), 'the other browser hears nothing of it');
  env.fail.clear();

  // Relayed events and TODO.md / NOTES.md, read by core's sdk:todo.
  env.frame({ t: 'rs:event', tabId: 'tab-1', off: 20, ev: { platform: { kind: 'files', todo: true, notes: true } } });
  await settle();
  browser.send({ type: 'sdk:todo', sessId });
  const todo = browser.sent.find((m) => m.type === 'sdk:todo');
  assert.deepEqual(todo.rows.map((r) => [r.id, r.description, r.status]), [['1', 'remote step', 'doing']]);
  assert.equal(todo.notes, 'remote notes');
  assert.ok(env.seen.some((m) => m.type === 'sdk:event' && m.sessId === sessId && m.off === 20));

  // The tab's ×: core calls close(), Pro unregisters — gone from core.
  env.calls.length = 0;
  env.seen.length = 0;
  browser.send({ type: 'cli:closeTab', tabId });
  await settle();
  assert.equal(env.mgr.list().some((t) => t.tabId === tabId), false);
  assert.equal(env.mgr.getBySessId(sessId), null);
  assert.ok(env.seen.some((m) => m.type === 'cli:exit' && m.tabId === tabId && m.external === true));
  assert.deepEqual(env.calls.map((c) => c.op).sort(), ['kill', 'unsubscribe']);
  assert.equal(prm.status(tabId), null);
  assert.deepEqual(unhandled, []);
  env.done();
});

test('ids core\'s tab rule would refuse are mapped; asks relay through core; owner gate and teardown', { skip }, async () => {
  const env = setup();
  const browser = env.connect();
  await prm.launch('s1', SPEC, { kind: 'owner' });
  // The slave's second tab id has an underscore: hashed into core's rule.
  const r = await prm.launch('s1', { ...SPEC, title: 'second' }, { kind: 'owner' });
  assert.equal(r.remoteTabId, 'tab_2.x');
  assert.match(r.tabId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
  assert.ok(env.mgr.list().some((t) => t.tabId === r.tabId), 'registered with core');
  assert.equal(prm.status(r.tabId).tab, true);

  // A slave's AskUserQuestion: answered from the dashboard, sent to that slave.
  env.frame({ t: 'rs:ask', tabId: 'tab_2.x', askId: 'a1', title: 'Pick', forms: [{ toolUseId: 'a1', formData: { questions: [{ id: 'c', question: 'Which?', options: [{ label: 'A' }] }] } }] });
  const q = env.seen.find((m) => m.type === 'ask:question');
  assert.deepEqual([q.host, q.remote.peer, q.remote.tabId, q.tabId], ['s1', 's1', r.tabId, r.tabId]);
  assert.ok(env.connect().sent.some((m) => m.type === 'ask:question' && m.askId === q.askId), 'replayed to a new browser');
  // Core resolves a remote ask only for an answer that names its tab (as its
  // dashboard's remote-ask.js askAnswerMsg does); any other is refused, to the sender alone.
  const answer = [{ id: 'c', answer: 'A' }];
  browser.send({ type: 'ask:answer', toolUseId: q.askId, answer });
  browser.send({ type: 'ask:answer', toolUseId: q.askId, answer, tabId: 'tab-1' });
  await settle();
  assert.equal(browser.sent.filter((m) => m.type === 'ask:answerError' && m.toolUseId === q.askId).length, 2);
  assert.equal(env.ops('answer').length, 0);
  browser.send({ type: 'ask:answer', toolUseId: q.askId, answer, tabId: r.tabId });
  await settle();
  assert.deepEqual(env.ops('answer').at(-1), { peer: 's1', op: 'answer', args: { askId: 'a1', answer } });

  // Exit: kept (as a local exited SDK tab) until closed.
  env.frame({ t: 'rs:state', tabId: 'tab_2.x', state: 'exited', exitCode: 0 });
  assert.equal(env.mgr.list().find((t) => t.tabId === r.tabId).status, 'exited');

  // Owner-only messages: core's isOwnerConnection decides.
  const replies = [];
  await prm.handleWs({ readyState: 1, send() {} }, { type: 'app:peer:session:kill', reqId: 'K', tabId: r.tabId }, (m) => replies.push(m));
  assert.deepEqual([replies[0].ok, replies[0].code], [false, 'not-owner']);
  browser.send({ type: 'app:peer:session:kill', reqId: 'K2', tabId: r.tabId });
  await settle();
  assert.equal(browser.sent.find((m) => m.type === 'app:peer:session:killResult').ok, true);

  // Teardown leaves no external tab behind.
  assert.equal(env.mgr.list().filter((t) => t.external).length, 2);
  prm.shutdown();
  assert.deepEqual(env.mgr.list().filter((t) => t.external), []);
  assert.deepEqual(unhandled, []);
  env.done();
});

// The Mini App answers a relayed ask by resolving ctx.pendingQuestions itself
// (platform-tg-runs.js), not through core's ask:answer: it must refuse and
// accept exactly what core's answerRefusal does for the same entry and tab.
test('Telegram answers to relayed asks follow core\'s tab rule (Mini App remote list and run)', { skip }, async () => {
  const env = setup();
  const tgRuns = require('../src/apps/platform-tg-runs');
  const { answerRefusal } = core('src/external-session');
  tgRuns.init({
    orchestration: { listRuns: () => [{ runId: 'r1', name: 'orch-r1' }], describeRun: (id) => (id === 'r1' ? { runId: 'r1', workers: [] } : null) },
    cliSessionManager: env.mgr, pendingQuestions: env.pendingQuestions, broadcaster: env.bc,
    state: { get: () => ({ runs: {} }), save() {} }, sweepMs: 0,
  });
  const routes = new Map();
  tgRuns.mountApi({ get: (p, h) => routes.set(`GET ${p}`, h), post: (p, h) => routes.set(`POST ${p}`, h) }, '/api',
    (h) => async (req, res) => { try { await h(req, res, { chatId: 1 }); } catch (err) { res.status(400).json({ error: err.message }); } });
  const hit = (key, body = {}, params = {}) => new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    routes.get(key)({ body, query: {}, params, headers: {} }, res);
  });

  const owner = await prm.launch('s1', { ...SPEC, title: 'Owner session' }, { kind: 'owner' });
  const member = await prm.launch('s1', { ...SPEC, title: 'Run member' }, { kind: 'orchestrator', ref: 'r1' });
  const form = (id) => ({ toolUseId: id, formData: { questions: [{ id: 'c', question: 'Which?', options: [{ label: 'A' }] }] } });
  env.frame({ t: 'rs:ask', tabId: owner.remoteTabId, askId: 'o1', title: 'Pick', forms: [form('o1')] });
  env.frame({ t: 'rs:ask', tabId: member.remoteTabId, askId: 'm1', title: 'Pick', forms: [form('m1')] });
  const idOf = (tab) => env.seen.find((m) => m.type === 'ask:question' && m.remote?.tabId === tab).askId;
  const ownerAsk = idOf(owner.tabId);
  const memberAsk = idOf(member.tabId);

  const { body } = await hit('GET /api/runs');
  assert.deepEqual(body.remote.flatMap((g) => g.sessions.flatMap((s) => s.asks.map((a) => [a.askId, a.remote.tabId]))), [[ownerAsk, owner.tabId]]);

  const answer = [{ id: 'c', answer: 'A' }];
  const paths = [
    [ownerAsk, (tabId) => hit('POST /api/remote/answer', { askId: ownerAsk, answer, ...(tabId ? { tabId } : {}) })],
    [memberAsk, (tabId) => hit('POST /api/run/:runId/answer', { askId: memberAsk, answer, ...(tabId ? { tabId } : {}) }, { runId: 'r1' })],
  ];
  for (const [askId, send] of paths) {
    const tab = askId === ownerAsk ? owner.tabId : member.tabId;
    const other = askId === ownerAsk ? member.tabId : owner.tabId;
    for (const named of [null, other, 'tab-1']) {
      assert.notEqual(answerRefusal(env.pendingQuestions.get(askId), named ? { tabId: named } : {}, env.mgr), null);
      assert.equal((await send(named)).status, 400, `${askId} named ${named}`);
    }
    assert.equal(answerRefusal(env.pendingQuestions.get(askId), { tabId: tab }, env.mgr), null);
    assert.deepEqual((await send(tab)).body, { ok: true });
  }
  await settle();
  assert.deepEqual(env.ops('answer').map((c) => c.args.askId), ['o1', 'm1']);
  env.done();
});
