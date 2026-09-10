// The dashboard's `init` payload must not resurrect dead sessions as inspector
// tabs. At boot the store loads whichever session dirs have the newest mtime,
// which is unrelated to the tabs that came back; shipping all of it gave every
// old session a cwd-labelled tab full of stale content.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshModules(home) {
  process.env.VISTACLAIR_HOME = home;
  for (const m of ['../src/store', '../src/utils', '../src/capabilities', '../src/dashboard-ws', '../src/proxy']) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
  return {
    InteractionStore: require('../src/store'),
    DashboardBroadcaster: require('../src/dashboard-ws'),
  };
}

function writeTurn(home, sessId, seq, id, instanceId) {
  const dir = path.join(home, 'interactions', sessId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${seq}.json`), JSON.stringify({
    id,
    instanceId,
    request: { endpoint: '/v1/messages', timestamp: 1000 + seq, body: {} },
    response: { status: 200, headers: {}, body: {}, result: 'complete' },
  }));
}

// Minimal stand-ins for `ws`/`wss`: the handler only needs `send` and `on`.
function fakeSocket(captured) {
  return {
    send: (raw) => { try { captured.push(JSON.parse(raw)); } catch {} },
    on: () => {},
  };
}

test('init drops boot-loaded history for sessions that are no longer around', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vistaclair-test-'));
  const liveSess = '11111111-1111-1111-1111-111111111111';
  const deadSess = '22222222-2222-2222-2222-222222222222';

  writeTurn(home, liveSess, 1, 'live-turn', `cli-${liveSess}`);
  writeTurn(home, deadSess, 1, 'dead-turn', `cli-${deadSess}`);

  const { InteractionStore, DashboardBroadcaster } = freshModules(home);
  const store = new InteractionStore(200);
  assert.strictEqual(store.order.length, 2, 'both sessions should load at boot');

  // Only the first session is live — as after a restart that restored one tab.
  store.registerSession(`cli-${liveSess}`, liveSess);

  const wss = new EventEmitter();
  wss.clients = new Set();
  const bc = new DashboardBroadcaster(wss, store, {
    cliSessionManager: { bootId: 'boot', list: () => [{ tabId: 'tab-1', instanceId: `cli-${liveSess}` }], droppedTabs: [] },
  });

  const sent = [];
  wss.emit('connection', fakeSocket(sent));

  const init = sent.find(m => m.type === 'init');
  assert.ok(init, 'an init message should be sent');
  const ids = init.interactions.map(i => i.id);
  assert.deepStrictEqual(ids, ['live-turn'], 'only the live session should be shipped');

  // The dead session is still reachable on demand.
  const loaded = store.loadSessionIntoMemory(deadSess);
  assert.deepStrictEqual(loaded.map(i => i.id), ['dead-turn']);
  assert.ok(bc.liveInstanceIds().has(`cli-${liveSess}`));
});

test('init keeps interactions this process produced, even once they exit', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vistaclair-test-'));
  const sessId = '33333333-3333-3333-3333-333333333333';

  const { InteractionStore, DashboardBroadcaster } = freshModules(home);
  const store = new InteractionStore(200);

  // A headless ai.prompt run: registered, produces a turn, then exits. Its
  // whole value is post-hoc inspection, so a page reload must still show it.
  store.registerSession('app-demo-ai-abc', sessId);
  store.add({
    id: 'ai-turn',
    instanceId: 'app-demo-ai-abc',
    endpoint: '/v1/messages',
    timestamp: 1,
    request: { body: {} },
    response: { status: 200, headers: {}, body: {} },
    status: 'complete',
  });
  store.unregisterSession('app-demo-ai-abc');

  const wss = new EventEmitter();
  wss.clients = new Set();
  new DashboardBroadcaster(wss, store, {});

  const sent = [];
  wss.emit('connection', fakeSocket(sent));

  const init = sent.find(m => m.type === 'init');
  assert.deepStrictEqual(init.interactions.map(i => i.id), ['ai-turn']);
});
