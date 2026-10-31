// External sessions (src/external-session.js, ctx.registerExternalSession): an
// add-on's adapter for a session running elsewhere shows as an Agent SDK tab —
// listed, broadcast like a spawned tab, driven through the real cli-handler —
// while persistence, shutdown and restore never see it. A throwing or
// rejecting adapter answers only its requester. Also the ctx additions beside
// it: claudeAuthInfo's account fields and isOwnerConnection. A fake wss and
// browser stand in for the dashboard; nothing spawns `claude`.
//
//   node --test test/

const fs = require('fs');
const os = require('os');
const path = require('path');

// Before anything reads them: a throwaway data home and $HOME.
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-ext-')));
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
const { createAddonCtx } = require('../src/addon-host');
const claudeAuth = require('../src/claude-auth');

const SESS = '0e0e0e0e-1111-2222-3333-444444444444';
const OTHER = '0f0f0f0f-1111-2222-3333-444444444444';
const THIRD = '0d0d0d0d-1111-2222-3333-444444444444';
const DATA = path.join(HOME, 'data');
const tick = () => new Promise((r) => setImmediate(r));

const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

// An adapter that records its calls; `over` replaces any field.
function fakeAdapter(over = {}, sessId = SESS) {
  const calls = [];
  const sessionDir = path.join(HOME, 'sessions', sessId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const rec = (name, ret) => (...args) => { calls.push([name, ...args]); return ret; };
  const adapter = {
    sessId, kind: 'sdk', title: 'remote job',
    settings: { engine: 'sdk', auth: 'apikey', model: 'claude-opus-5-5', sessionDir, externalHost: 'slave-1', orchestration: { runId: 'r9', role: 'orchestrator' } },
    running: true, busy: false, state: 'idle',
    submit: rec('submit'), interrupt: rec('interrupt'), setModel: rec('setModel'), setShowThinking: rec('setShowThinking'),
    setAuth: (auth, opts) => { calls.push(['setAuth', auth, opts]); return { auth, applied: 'pending' }; },
    historyPage: (opts) => { calls.push(['historyPage', opts]); return { events: [{ sessId, ts: 1, ev: { sdk: { type: 'assistant' } } }], hasMore: true, before: 42, totals: { costUsd: 0.5, compactions: 0 } }; },
    kill: rec('kill'), close: rec('close'),
    orchestration: () => ({ runId: 'r9', orchestrator: 'orch-r9', orchestratorSessId: sessId, workers: [] }),
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
  const seen = [];
  bc.onBroadcast((m) => seen.push(JSON.parse(JSON.stringify(m))));
  return { store, wss, bc, mgr, seen, done: () => bc.sessions.close() };
}

// A connected browser: what it is sent, and a way to send as it would.
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

const ENTRY_KEYS = ['tabId', 'kind', 'instanceId', 'sessId', 'autoMemory', 'status', 'cwd', 'title', 'settings', 'busy', 'pausing', 'state', 'costUsd', 'external'];

test('a registered session is listed, found by sessId, broadcast as spawned and sent in cli:tabs', () => {
  const { wss, mgr, seen, done } = setup();
  const { adapter } = fakeAdapter();
  mgr.registerExternal('remote-a', adapter);

  const [entry] = mgr.list();
  assert.deepStrictEqual(Object.keys(entry).sort(), [...ENTRY_KEYS].sort());
  assert.strictEqual(entry.tabId, 'remote-a');
  assert.strictEqual(entry.kind, 'sdk');
  assert.strictEqual(entry.external, true);
  assert.strictEqual(entry.sessId, SESS);
  assert.strictEqual(entry.instanceId, `cli-${SESS}`);
  assert.strictEqual(entry.status, 'running');
  assert.strictEqual(entry.settings.externalHost, 'slave-1');
  assert.strictEqual(entry.settings.engine, 'sdk');
  assert.strictEqual(mgr.getBySessId(SESS).tabId, 'remote-a');
  assert.strictEqual(mgr.getBySessId(SESS).external, true);
  assert.strictEqual(mgr.sessionDirOf(SESS), adapter.settings.sessionDir);
  assert.strictEqual(mgr.get('remote-a'), null, 'not one of the manager\'s own sessions');

  // Register: the spawned SDK tab's message, then the tab list.
  const spawned = seen.find(m => m.type === 'cli:spawned');
  assert.deepStrictEqual(spawned, {
    type: 'cli:spawned', tabId: 'remote-a', instanceId: `cli-${SESS}`, cwd: null, title: 'remote job',
    settings: entry.settings, autoMemory: false, hidden: false, kind: 'sdk', external: true,
  });
  assert.ok(seen.findIndex(m => m.type === 'cli:tabs') > seen.indexOf(seen.find(m => m.type === 'cli:spawned')));

  // A browser connecting later gets it in cli:tabs.
  const browser = connect(wss);
  const tabs = browser.sent.find(m => m.type === 'cli:tabs');
  assert.deepStrictEqual(tabs.tabs.map(t => [t.tabId, t.external]), [['remote-a', true]]);

  // Read live: the adapter's state changes show in the next list.
  adapter.busy = true;
  adapter.state = 'busy';
  adapter.running = false;
  assert.deepStrictEqual([mgr.list()[0].busy, mgr.list()[0].state, mgr.list()[0].status], [true, 'busy', 'exited']);
  done();
});

test('hidden sessions are found but not listed; untrusted strings are capped', () => {
  const { mgr, done } = setup();
  const { adapter } = fakeAdapter({ hidden: true });
  mgr.registerExternal('remote-h', adapter);
  assert.deepStrictEqual(mgr.list(), []);
  assert.strictEqual(mgr.getBySessId(SESS).tabId, 'remote-h');

  const long = fakeAdapter({ title: 'T'.repeat(5000) }, OTHER).adapter;
  long.settings.externalHost = 'h'.repeat(5000);
  mgr.registerExternal('remote-l', long);
  const e = mgr.list().find(t => t.tabId === 'remote-l');
  assert.strictEqual(e.title.length, 200);
  assert.strictEqual(e.settings.externalHost, 'h'.repeat(100));
  done();
});

test('malformed adapters and taken tabIds are refused', () => {
  const { mgr, done } = setup();
  const ok = () => fakeAdapter().adapter;
  assert.throws(() => mgr.registerExternal('', ok()), /tabId/);
  assert.throws(() => mgr.registerExternal('a b', ok()), /tabId/);
  assert.throws(() => mgr.registerExternal('x'.repeat(101), ok()), /tabId/);
  assert.throws(() => mgr.registerExternal('r', null), /adapter/);
  assert.throws(() => mgr.registerExternal('r', { ...ok(), sessId: 'nope' }), /sessId/);
  assert.throws(() => mgr.registerExternal('r', { ...ok(), kind: 'cli' }), /kind/);
  assert.throws(() => mgr.registerExternal('r', { ...ok(), submit: undefined }), /submit/);
  assert.throws(() => mgr.registerExternal('r', { ...ok(), orchestration: 'x' }), /orchestration/);
  // A real tab's id, and an external's.
  mgr.getOrCreate('tab-real');
  assert.throws(() => mgr.registerExternal('tab-real', ok()), /already exists/);
  mgr.registerExternal('remote-a', ok());
  assert.throws(() => mgr.registerExternal('remote-a', fakeAdapter({}, OTHER).adapter), /already exists/);
  // And the other way round: no real session is made under an external's id.
  assert.throws(() => mgr.getOrCreate('remote-a'), /external/);
  assert.deepStrictEqual(mgr.list().filter(t => t.external).map(t => t.tabId), ['remote-a']);
  done();
});

test('the tab\'s messages reach the adapter through the cli-handler', async () => {
  const { wss, mgr, done } = setup();
  const { adapter, calls, sessionDir } = fakeAdapter();
  mgr.registerExternal('remote-a', adapter);
  const browser = connect(wss);
  browser.sent.length = 0;

  browser.send({ type: 'sdk:send', sessId: SESS, text: 'hello', images: [{ name: 'a.png' }] });
  browser.send({ type: 'sdk:interrupt', sessId: SESS });
  browser.send({ type: 'sdk:setModel', sessId: SESS, model: 'claude-sonnet-5-5' });
  browser.send({ type: 'sdk:setThinking', sessId: SESS, on: true });
  browser.send({ type: 'sdk:history', sessId: SESS, limit: 50, before: 100 });
  browser.send({ type: 'cli:sessionAuth', tabId: 'remote-a', auth: 'subscription', continue: true, reqId: 'q1' });
  browser.send({ type: 'cli:interrupt', tabId: 'remote-a', reqId: 'q2' });
  browser.send({ type: 'cli:kill', tabId: 'remote-a' });
  browser.send({ type: 'cli:closeTab', tabId: 'remote-a' });
  await tick();

  assert.deepStrictEqual(calls, [
    ['submit', 'hello', { images: [{ name: 'a.png' }] }],
    ['interrupt'],
    ['setModel', 'claude-sonnet-5-5'],
    ['setShowThinking', true],
    ['historyPage', { limit: 50, before: 100 }],
    ['setAuth', 'subscription', { continueTurn: true }],
    ['interrupt'],
    ['kill'],
    ['close'],
  ]);
  const hist = browser.sent.find(m => m.type === 'sdk:history');
  assert.deepStrictEqual(hist, {
    type: 'sdk:history', sessId: SESS, from: 100,
    events: [{ sessId: SESS, ts: 1, ev: { sdk: { type: 'assistant' } } }], hasMore: true, before: 42, totals: { costUsd: 0.5, compactions: 0 },
  });
  const auth = browser.sent.find(m => m.type === 'cli:actionResult' && m.action === 'auth');
  assert.deepStrictEqual([auth.reqId, auth.auth, auth.sessions, auth.applied, auth.error], ['q1', 'subscription', 1, { pending: 1 }, undefined]);
  const intr = browser.sent.find(m => m.type === 'cli:actionResult' && m.action === 'interrupt');
  assert.deepStrictEqual([intr.reqId, intr.ok, intr.error], ['q2', true, undefined]);
  assert.ok(!browser.sent.some(m => m.error || m.ev?.platform?.kind === 'notice'), 'no errors on the happy path');
  // close() leaves the tab to the add-on.
  assert.strictEqual(mgr.list().length, 1);

  // sdk:todo reads the adapter's sessionDir as for a local session.
  fs.writeFileSync(path.join(sessionDir, 'TODO.md'), '| id | description | depends on | status |\n|--|--|--|--|\n| 1 | remote step | – | doing |\n');
  fs.writeFileSync(path.join(sessionDir, 'NOTES.md'), 'remote notes');
  browser.send({ type: 'sdk:todo', sessId: SESS });
  const todo = browser.sent.find(m => m.type === 'sdk:todo');
  assert.deepStrictEqual(todo.rows.map(r => [r.id, r.description, r.status]), [['1', 'remote step', 'doing']]);
  assert.strictEqual(todo.notes, 'remote notes');

  // An invalid billing never reaches the adapter.
  browser.send({ type: 'cli:sessionAuth', tabId: 'remote-a', auth: 'bogus' });
  assert.match(browser.sent.at(-1).error, /auth must be/);
  assert.strictEqual(calls.filter(c => c[0] === 'setAuth').length, 1);
  done();
});

test('an async historyPage is awaited; a rejecting one answers with an error', async () => {
  const { wss, mgr, done } = setup();
  let fail = false;
  const { adapter } = fakeAdapter({
    historyPage: ({ before }) => new Promise((resolve, reject) => setTimeout(() => (fail
      ? reject(new Error('peer unreachable'))
      : resolve({ events: [{ sessId: SESS, ts: 2, ev: { user: { text: 'later' } } }], hasMore: false, before: null, totals: null })), 5)),
  });
  mgr.registerExternal('remote-a', adapter);
  const browser = connect(wss);

  browser.send({ type: 'sdk:history', sessId: SESS });
  assert.ok(!browser.sent.some(m => m.type === 'sdk:history'), 'answered only once the page resolved');
  await new Promise((r) => setTimeout(r, 30));
  const page = browser.sent.find(m => m.type === 'sdk:history');
  assert.deepStrictEqual(page, { type: 'sdk:history', sessId: SESS, from: null, events: [{ sessId: SESS, ts: 2, ev: { user: { text: 'later' } } }], hasMore: false, before: null, totals: null });

  fail = true;
  browser.sent.length = 0;
  browser.send({ type: 'sdk:history', sessId: SESS, before: 7 });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepStrictEqual(browser.sent.find(m => m.type === 'sdk:history'), {
    type: 'sdk:history', sessId: SESS, from: 7, events: [], hasMore: false, before: null, totals: null, error: 'peer unreachable',
  });
  done();
});

test('a throwing or rejecting adapter answers its requester only and crashes nothing', async () => {
  const { wss, mgr, done } = setup();
  const boom = () => { throw new Error('boom'); };
  const reject = () => Promise.reject(new Error('nope'));
  const bad = fakeAdapter({
    submit: boom, interrupt: reject, setModel: reject, setShowThinking: boom,
    setAuth: reject, historyPage: boom, kill: boom, close: reject,
  });
  // A getter that throws, too: the tab still lists, with its defaults.
  Object.defineProperty(bad.adapter, 'busy', { get() { throw new Error('getter'); } });
  Object.defineProperty(bad.adapter, 'title', { get() { throw new Error('getter'); } });
  mgr.registerExternal('remote-bad', bad.adapter);
  const good = fakeAdapter({}, OTHER);
  mgr.registerExternal('remote-good', good.adapter);

  const a = connect(wss);
  const b = connect(wss);
  assert.deepStrictEqual(a.sent.find(m => m.type === 'cli:tabs').tabs.map(t => [t.tabId, t.busy, t.title]), [['remote-bad', false, null], ['remote-good', false, 'remote job']]);
  a.sent.length = 0;
  b.sent.length = 0;

  a.send({ type: 'sdk:send', sessId: SESS, text: 'x' });
  a.send({ type: 'sdk:interrupt', sessId: SESS });
  a.send({ type: 'sdk:setModel', sessId: SESS, model: 'm' });
  a.send({ type: 'sdk:setThinking', sessId: SESS, on: true });
  a.send({ type: 'sdk:history', sessId: SESS });
  a.send({ type: 'cli:sessionAuth', tabId: 'remote-bad', auth: 'apikey', reqId: 'r1' });
  a.send({ type: 'cli:interrupt', tabId: 'remote-bad', reqId: 'r2' });
  a.send({ type: 'cli:kill', tabId: 'remote-bad' });
  a.send({ type: 'cli:closeTab', tabId: 'remote-bad' });
  await tick();

  // (A sync throw settles a microtask earlier than a rejection: any order.)
  const notices = a.sent.filter(m => m.type === 'sdk:event').map(m => [m.sessId, m.ev.platform.level, m.ev.platform.text]).sort();
  assert.deepStrictEqual(notices, [
    [SESS, 'error', 'Model not changed: nope'],
    [SESS, 'error', 'Not interrupted: nope'],
    [SESS, 'error', 'Not sent: boom'],
    [SESS, 'error', 'Thinking not switched: boom'],
  ]);
  assert.strictEqual(a.sent.find(m => m.type === 'sdk:history').error, 'boom');
  const results = a.sent.filter(m => m.type === 'cli:actionResult').map(m => [m.action, m.tabId, m.error]).sort();
  assert.deepStrictEqual(results, [['auth', 'remote-bad', 'nope'], ['close', 'remote-bad', 'nope'], ['interrupt', 'remote-bad', 'nope'], ['kill', 'remote-bad', 'boom']]);
  assert.deepStrictEqual(b.sent, [], 'the other browser hears nothing of it');

  // The other tab is unaffected.
  a.send({ type: 'sdk:send', sessId: OTHER, text: 'still here' });
  await tick();
  assert.deepStrictEqual(good.calls, [['submit', 'still here', { images: [] }]]);
  assert.deepStrictEqual(unhandled, []);
  done();
});

test('never persisted, never killed at shutdown, untouched by restore', async () => {
  const { mgr, done } = setup();
  const { adapter, calls } = fakeAdapter();
  mgr.registerExternal('remote-a', adapter);
  // One of the manager's own tabs beside it (a stand-in: nothing spawns).
  const own = { sessId: OTHER, cwd: HOME, title: 'own', kind: 'sdk', busy: false, getSettings: () => ({ engine: 'sdk' }), kill(reason) { this.killed = reason; } };
  mgr.sessions.set('tab-own', own);
  // Everything that writes the manifest or the saved sessions.
  mgr.noteSessionState();
  mgr.noteSettingsChanged(mgr.getBySessId(SESS));
  mgr.saveAllToHistory();
  const manifest = path.join(DATA, 'cli-open-tabs.json');
  const history = path.join(DATA, 'cli-history.json');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')).map(e => e.sessId), [OTHER], 'only the own tab in the open-tab manifest');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(history, 'utf8')).map(e => e.id), [OTHER], 'only the own tab in the saved sessions');
  assert.ok(!mgr.getPinnedSessionIds().has(SESS));

  // Restore at boot leaves it alone, shutdown does not kill it.
  fs.writeFileSync(path.join(DATA, 'app-prefs.json'), JSON.stringify({ cliReopenTabsAtBoot: true }));
  mgr.bootOpenTabs();
  await new Promise((r) => setTimeout(r, 20));
  mgr.sessions.set('tab-own', own);
  mgr.killAll();
  assert.strictEqual(own.killed, 'shutdown');
  assert.deepStrictEqual(calls, [], 'the adapter is never called');
  assert.deepStrictEqual(mgr.list().filter(t => t.external).map(t => t.tabId), ['remote-a']);
  assert.ok(!fs.readFileSync(manifest, 'utf8').includes(SESS));
  assert.ok(!fs.readFileSync(history, 'utf8').includes(SESS));
  fs.rmSync(path.join(DATA, 'app-prefs.json'));
  // A minted tab id never takes an external's.
  assert.notStrictEqual(mgr.nextTabId(), 'remote-a');
  done();
});

test('unregister removes the tab and broadcasts its removal, once', () => {
  const { wss, mgr, seen, done } = setup();
  const { adapter } = fakeAdapter();
  const unregister = mgr.registerExternal('remote-a', adapter);
  const browser = connect(wss);
  seen.length = 0;
  browser.sent.length = 0;

  unregister();
  assert.deepStrictEqual(mgr.list(), []);
  assert.strictEqual(mgr.getBySessId(SESS), null);
  assert.deepStrictEqual(seen.map(m => m.type), ['cli:exit', 'cli:tabs']);
  assert.strictEqual(seen[0].tabId, 'remote-a');
  assert.deepStrictEqual(seen[1].tabs, []);
  assert.deepStrictEqual(browser.sent.map(m => m.type), ['cli:exit', 'cli:tabs']);

  // Idempotent, and it never drops a later registration under the same id.
  // (Not OTHER: the test above left it a saved session.)
  mgr.registerExternal('remote-a', fakeAdapter({}, THIRD).adapter);
  seen.length = 0;
  unregister();
  assert.deepStrictEqual(seen, []);
  assert.strictEqual(mgr.list()[0].sessId, THIRD);
  done();
});

test('GET /api/orchestration/run answers an external orchestrator\'s run from its adapter', async () => {
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

  assert.strictEqual((await get('r9')).status, 404);
  const { adapter } = fakeAdapter();
  mgr.registerExternal('remote-a', adapter);
  assert.deepStrictEqual(await get('r9'), { status: 200, body: { runId: 'r9', orchestrator: 'orch-r9', orchestratorSessId: SESS, workers: [] } });
  adapter.orchestration = async () => { throw new Error('peer down'); };
  assert.deepStrictEqual(await get('r9'), { status: 502, body: { error: 'peer down' } });
  done();
});

test('an ask carrying host and remote is replayed verbatim and answered when the answer names its tab', () => {
  const { wss, bc, done } = setup();
  const message = {
    type: 'ask:question', askId: 'ask-ext-1', formData: { questions: [{ question: 'Proceed?' }] },
    host: 'slave-1', remote: { peer: 'slave-1', tabId: 'tab-x', sessionTitle: 'remote job' },
  };
  let answered = null;
  pendingQuestions.set('ask-ext-1', { message, resolve: (a) => { answered = a; }, reject() {}, ctx: { tabId: 'remote-a' } });
  try {
    const browser = connect(wss);
    assert.deepStrictEqual(browser.sent.find(m => m.type === 'ask:question'), message);
    const live = connect(wss);
    bc.broadcast(message);
    assert.deepStrictEqual(live.sent.filter(m => m.type === 'ask:question').at(-1), message);
    browser.send({ type: 'ask:answer', toolUseId: 'ask-ext-1', answer: ['no'] });
    assert.strictEqual(answered, null, 'not by its id alone');
    browser.send({ type: 'ask:answer', toolUseId: 'ask-ext-1', tabId: 'remote-a', answer: ['yes'] });
    assert.deepStrictEqual(answered, ['yes']);
    assert.ok(browser.sent.some(m => m.type === 'ask:answered' && m.askId === 'ask-ext-1'));
  } finally {
    pendingQuestions.delete('ask-ext-1');
    done();
  }
});

test('ctx: registerExternalSession, isOwnerConnection, claudeAuthInfo account fields', () => {
  const { wss, bc, store, mgr, done } = setup();
  const ctx = createAddonCtx({ dataHome: HOME, dashboard: { broadcaster: bc, store, cliSessionManager: mgr, pendingQuestions } });

  const unregister = ctx.registerExternalSession('remote-a', fakeAdapter().adapter);
  assert.strictEqual(mgr.list()[0].tabId, 'remote-a');
  assert.throws(() => ctx.registerExternalSession('remote-a', fakeAdapter({}, OTHER).adapter), /already exists/);
  unregister();
  assert.deepStrictEqual(mgr.list(), []);

  // A connected dashboard socket is the owner's; nothing else is.
  const browser = connect(wss);
  assert.strictEqual(ctx.isOwnerConnection(browser.ws), true);
  assert.strictEqual(ctx.isOwnerConnection({ readyState: WebSocket.OPEN, send() {} }), false);
  assert.strictEqual(ctx.isOwnerConnection(null), false);
  assert.strictEqual(ctx.isOwnerConnection('ws'), false);
  wss.clients.delete(browser.ws);
  assert.strictEqual(ctx.isOwnerConnection(browser.ws), false, 'a closed socket no longer counts');
  assert.strictEqual(createAddonCtx({ dataHome: HOME }).isOwnerConnection(browser.ws), false, 'headless: never');

  // The account `claude auth status` names, and nothing else of it.
  const status = (o) => ({ run: async () => JSON.stringify(o), runSync: () => JSON.stringify(o) });
  try {
    claudeAuth.authStatus.setRunner(status({ loggedIn: true, authMethod: 'claude.ai', email: 'a@example.com', orgName: 'Acme', accessToken: 'sk-secret', subscriptionType: 'max' }));
    const info = ctx.claudeAuthInfo();
    assert.deepStrictEqual(Object.keys(info).sort(), ['email', 'hasSubscription', 'orgName', 'pref']);
    assert.deepStrictEqual([info.hasSubscription, info.email, info.orgName], [true, 'a@example.com', 'Acme']);
    assert.ok(!JSON.stringify(info).includes('sk-secret'));
    claudeAuth.authStatus.setRunner(status({ loggedIn: false, email: 'stale@example.com' }));
    assert.deepStrictEqual([ctx.claudeAuthInfo().email, ctx.claudeAuthInfo().orgName, ctx.claudeAuthInfo().hasSubscription], [null, null, false]);
    claudeAuth.authStatus.setRunner(status({ loggedIn: true, authMethod: 'claude.ai', email: '', orgName: 7 }));
    assert.deepStrictEqual([ctx.claudeAuthInfo().email, ctx.claudeAuthInfo().orgName], [null, null]);
  } finally {
    claudeAuth.authStatus.setRunner({ run: async () => '', runSync: () => '' });
    done();
  }
});
