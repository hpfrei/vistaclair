// What a browser receives: on connect only the session cards (the summary
// feed), and a session's interactions only once it opens that session's tab
// (inspector:subscribe). Two browsers can have different tabs open, so the
// filtering is per client.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

function freshModules(home) {
  process.env.VISTACLAIR_HOME = home;
  for (const m of ['../src/store', '../src/utils', '../src/capabilities', '../src/dashboard-ws', '../src/proxy', '../src/inspector-sessions']) {
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

// A stand-in for a connected browser: collects what it is sent and lets the
// test send messages as the browser would.
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
  return { sent, send: (msg) => onMessage(JSON.stringify(msg)) };
}

function setup(maxSize = 200) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vistaclair-test-'));
  const { InteractionStore, DashboardBroadcaster } = freshModules(home);
  const store = new InteractionStore(maxSize);
  const wss = new EventEmitter();
  wss.clients = new Set();
  const bc = new DashboardBroadcaster(wss, store, { sessions: { throttleMs: 0 } });
  return { home, store, wss, bc, done: () => bc.sessions.close() };
}

test('init carries the session summary, never interactions', () => {
  const { home, store, wss, bc, done } = setup();
  const sessId = '11111111-1111-1111-1111-111111111111';
  writeTurn(home, sessId, 1, 'old-turn', `cli-${sessId}`);
  store.add({ id: 'live', instanceId: 'app-demo-ai-abc', timestamp: 1, request: {}, response: {}, status: 'complete' });
  bc.broadcast({ type: 'interaction:start', interaction: { id: 'live', instanceId: 'app-demo-ai-abc', timestamp: 1, request: { model: 'm' }, status: 'pending' } });

  const browser = connect(wss);
  const init = browser.sent.find(m => m.type === 'init');
  assert.ok(init, 'an init message should be sent');
  assert.strictEqual(init.interactions, undefined, 'no interactions on connect');
  assert.deepStrictEqual(init.sessions.map(s => s.instanceId), ['app-demo-ai-abc']);
  assert.strictEqual(init.sessions[0].kind, 'app');
  assert.ok(!browser.sent.some(m => m.type.startsWith('interaction:') || m.type === 'sse_event'));
  done();
});

test('an unsubscribed client gets no sse_event or interaction:* for that instance', () => {
  const { store, wss, bc, done } = setup();
  const a = connect(wss);
  const b = connect(wss);
  a.send({ type: 'inspector:subscribe', instanceId: 'cli-A' });
  b.send({ type: 'inspector:subscribe', instanceId: 'cli-B' });

  const turn = { id: 'ta', instanceId: 'cli-A', timestamp: 1, request: {}, response: { sseEvents: [] }, status: 'pending' };
  store.add(turn);
  const before = { a: a.sent.length, b: b.sent.length };
  bc.broadcast({ type: 'interaction:start', interaction: turn });
  bc.broadcast({ type: 'sse_event', interactionId: 'ta', instanceId: 'cli-A', event: { eventType: 'message_start', data: {} } });
  bc.broadcast({ type: 'interaction:enriched', interactionId: 'ta', subagent: { agentId: 'x' } });
  bc.broadcast({ type: 'interaction:error', interactionId: 'ta', error: 'boom' });
  bc.broadcast({ type: 'interaction:complete', interaction: { ...turn, status: 'complete' } });

  const gotA = a.sent.slice(before.a).map(m => m.type).filter(t => t !== 'inspector:sessions');
  const gotB = b.sent.slice(before.b).map(m => m.type).filter(t => t !== 'inspector:sessions');
  assert.deepStrictEqual(gotA, ['interaction:start', 'sse_event', 'interaction:enriched', 'interaction:error', 'interaction:complete']);
  assert.deepStrictEqual(gotB, [], 'the other browser has cli-A closed');

  // Closing the tab stops the traffic.
  a.send({ type: 'inspector:unsubscribe', instanceId: 'cli-A' });
  const after = a.sent.length;
  bc.broadcast({ type: 'sse_event', interactionId: 'ta', instanceId: 'cli-A', event: { eventType: 'ping', data: {} } });
  assert.strictEqual(a.sent.slice(after).filter(m => m.type === 'sse_event').length, 0);

  // Everything not session-scoped still reaches everyone.
  bc.broadcast({ type: 'claude:count', count: 0 });
  assert.ok(b.sent.some(m => m.type === 'claude:count'));
  done();
});

test('opening a session sends its snapshot, then only live events', () => {
  const { home, store, wss, bc, done } = setup();
  const sessId = '22222222-2222-2222-2222-222222222222';
  const id = `cli-${sessId}`;
  writeTurn(home, sessId, 1, 'disk-1', id);
  writeTurn(home, sessId, 2, 'disk-2', id);
  // A turn of another instance sharing the dir stays out.
  writeTurn(home, sessId, 3, 'other', 'app-x-ai-1');
  store.registerSession(id, sessId);
  // Mid-stream: the turn is live in memory with some events already.
  const streaming = {
    id: 'live', instanceId: id, timestamp: 5000, request: {}, status: 'streaming',
    response: { sseEvents: [{ eventType: 'message_start', data: {} }] },
  };
  store.add(streaming);

  const browser = connect(wss);
  browser.send({ type: 'inspector:subscribe', instanceId: id });
  const snap = browser.sent.find(m => m.type === 'inspector:snapshot');
  assert.ok(snap);
  assert.strictEqual(snap.instanceId, id);
  assert.deepStrictEqual(snap.interactions.map(i => i.id), ['disk-1', 'disk-2', 'live']);
  assert.deepStrictEqual(snap.interactions[2].response.sseEvents, streaming.response.sseEvents,
    'a streaming turn keeps the events so far; the rest follow as sse_event');
  assert.ok(snap.interactions[0]._summary, 'finished turns come in summary shape');

  bc.broadcast({ type: 'sse_event', interactionId: 'live', instanceId: id, event: { eventType: 'content_block_start', data: {} } });
  const after = browser.sent.slice(browser.sent.indexOf(snap) + 1).filter(m => m.type !== 'inspector:sessions');
  assert.deepStrictEqual(after.map(m => m.type), ['sse_event']);
  done();
});

test('live completions leave the stream events off the wire, not off listeners', () => {
  const { wss, bc, done } = setup();
  const browser = connect(wss);
  browser.send({ type: 'inspector:subscribe', instanceId: 'cli-x' });
  const heard = [];
  bc._broadcastListeners.add(m => heard.push(m));

  const events = [{ eventType: 'message_start', data: {} }];
  const from = browser.sent.length;
  bc.broadcast({ type: 'interaction:complete', interaction: { id: 'x', instanceId: 'cli-x', response: { status: 200, body: { role: 'assistant' }, sseEvents: events } } });
  bc.broadcast({ type: 'interaction:start', interaction: { id: 'y', instanceId: 'cli-x', response: { sseEvents: events } } });

  const sent = browser.sent.slice(from).filter(m => m.type.startsWith('interaction:'));
  assert.strictEqual(sent[0].interaction.response.sseEvents, undefined);
  assert.deepStrictEqual(sent[0].interaction.response.body, { role: 'assistant' });
  assert.deepStrictEqual(sent[1].interaction.response.sseEvents, events, 'start is untouched');
  assert.strictEqual(heard[0].interaction.response.sseEvents, events, 'listeners get the full message');
  done();
});

test('an Agent hook summary keeps the agent id its result names', () => {
  const { store, wss, done } = setup();
  store.add({
    id: 'post-agent', instanceId: 'cli-h', timestamp: 1, isHook: true, hookEvent: 'PostToolUse', toolName: 'Agent', toolUseId: 'toolu_1',
    request: { tool_response: { status: 'async_launched', agentId: 'a1b2c3', prompt: 'x'.repeat(5000) } },
    response: { status: 200 }, status: 'complete',
  });
  const browser = connect(wss);
  browser.send({ type: 'inspector:subscribe', instanceId: 'cli-h' });
  const hook = browser.sent.find(m => m.type === 'inspector:snapshot').interactions.find(i => i.id === 'post-agent');
  assert.strictEqual(hook.request.tool_response, undefined, 'the payload itself stays off the summary');
  assert.strictEqual(hook.request._agentId, 'a1b2c3');
  done();
});

test('external turns without an instance go to the ext session', () => {
  const { store, wss, bc, done } = setup();
  const browser = connect(wss);
  browser.send({ type: 'inspector:subscribe', instanceId: 'ext' });
  const turn = { id: 'e1', instanceId: null, timestamp: 1, request: {}, response: {}, status: 'pending' };
  store.add(turn);
  bc.broadcast({ type: 'interaction:start', interaction: turn });
  bc.broadcast({ type: 'sse_event', interactionId: 'e1', instanceId: null, event: { eventType: 'ping', data: {} } });
  const got = browser.sent.filter(m => m.type === 'interaction:start' || m.type === 'sse_event');
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].interaction.instanceId, 'ext', 'the browser sees the routing id');
  assert.strictEqual(turn.instanceId, null, 'the stored turn is untouched');
  done();
});
