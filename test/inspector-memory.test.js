// What a browser holds of a session is bounded: live interaction:* messages
// reach it in summary form (no conversation), a tab opens on the newest
// turns only, and older ones come page by page (inspector:getEarlier). The
// client-side caps live in public/inspector-retention.js.
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
  return { store, wss, bc, DashboardBroadcaster, done: () => bc.sessions.close() };
}

function llmTurn(id, extra = {}) {
  return {
    id, instanceId: 'cli-m', timestamp: 1000, status: 'pending', isStreaming: true,
    request: {
      model: 'claude-x', max_tokens: 100,
      system: [{ type: 'text', text: 'S'.repeat(3000) }],
      tools: [{ name: 'Read', input_schema: {} }, { name: 'Bash', input_schema: {} }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first   question\nhere' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'R'.repeat(10000) }] },
      ],
    },
    translatedBody: { messages: ['copy'] },
    response: { status: 200, sseEvents: [] },
    timing: { startedAt: 1000 },
    ...extra,
  };
}

test('live interaction messages reach browsers in summary form, listeners in full', () => {
  const { wss, bc, done } = setup();
  const browser = connect(wss);
  browser.send({ type: 'inspector:subscribe', instanceId: 'cli-m' });
  const heard = [];
  bc.onBroadcast(m => heard.push(m));

  const turn = llmTurn('t1');
  const from = browser.sent.length;
  bc.broadcast({ type: 'interaction:start', interaction: turn });
  bc.broadcast({ type: 'interaction:update', interaction: { ...turn, status: 'streaming' } });
  bc.broadcast({ type: 'interaction:complete', interaction: {
    ...turn, status: 'complete',
    response: { status: 200, body: { content: [{ type: 'text', text: 'ok' }] }, sseEvents: [{ eventType: 'message_stop', data: {} }] },
  } });

  const sent = browser.sent.slice(from).filter(m => m.type.startsWith('interaction:'));
  assert.deepStrictEqual(sent.map(m => m.type), ['interaction:start', 'interaction:update', 'interaction:complete']);
  for (const { interaction: i } of sent) {
    assert.strictEqual(i.request.messages, undefined, 'no messages array on the wire');
    assert.strictEqual(i.request.tools, undefined);
    assert.strictEqual(i.request.system, undefined);
    assert.strictEqual(i.translatedBody, undefined);
    assert.strictEqual(i._summary, true);
    assert.strictEqual(i.request._messageCount, 3);
    assert.strictEqual(i.request._toolCount, 2);
    assert.strictEqual(i.request._messagesChars, JSON.stringify(turn.request.messages).length);
    assert.strictEqual(i.request._toolsChars, JSON.stringify(turn.request.tools).length);
    assert.strictEqual(i.request._systemChars, JSON.stringify(turn.request.system).length);
    assert.deepStrictEqual(i.request._lastMessage, { role: 'user', hasText: false });
    assert.strictEqual(i.request._firstUserText, 'first question here');
    assert.strictEqual(i.request.model, 'claude-x');
  }
  // The newest tool result stays for the tool detail, cut and flagged.
  const tr = sent[0].interaction.request._toolResults;
  assert.strictEqual(tr.length, 1);
  assert.strictEqual(tr[0].tool_use_id, 'tu1');
  assert.ok(tr[0].content.length < 10000 && tr[0]._truncated);
  assert.strictEqual(sent[2].interaction.response.sseEvents, undefined, 'a completion leaves the stream off');
  assert.deepStrictEqual(sent[2].interaction.response.body, { content: [{ type: 'text', text: 'ok' }] });

  assert.strictEqual(heard[0].interaction.request.messages.length, 3, 'listeners get the full turn');
  assert.ok(heard[0].interaction.translatedBody);
  assert.strictEqual(turn.request.messages.length, 3, 'the turn itself is untouched');
  done();
});

test('a large response body is cut in the summary; getDetail returns it whole', () => {
  const { store, wss, bc, done } = setup();
  const browser = connect(wss);
  browser.send({ type: 'inspector:subscribe', instanceId: 'cli-m' });
  const body = { content: [{ type: 'text', text: 'x'.repeat(200000) }, { type: 'tool_use', id: 'tu9', name: 'Write', input: { file_path: '/a', content: 'y'.repeat(100000) } }] };
  const turn = llmTurn('big', { status: 'complete', response: { status: 200, body } });
  store.add(turn);
  bc.broadcast({ type: 'interaction:complete', interaction: turn });
  const s = browser.sent.find(m => m.type === 'interaction:complete').interaction;
  assert.ok(s.response._bodyTruncated);
  assert.strictEqual(s.response._bodyChars, JSON.stringify(body).length);
  assert.ok(JSON.stringify(s.response.body).length < 10000);
  assert.strictEqual(s.response.body.content[1].name, 'Write', 'the shape (tool names) survives');
  assert.strictEqual(s.response.body.content[1].input.file_path, '/a');

  browser.send({ type: 'interaction:getDetail', id: 'big' });
  const d = browser.sent.find(m => m.type === 'interaction:detail').interaction;
  assert.strictEqual(d.response.body.content[0].text.length, 200000);
  assert.strictEqual(d.request.messages.length, 3);
  done();
});

test('a tab opens on the newest turns, and says whether older ones exist', () => {
  const { store, wss, bc, DashboardBroadcaster, done } = setup(2000);
  const N = DashboardBroadcaster.SNAPSHOT_LIMIT + 20;
  for (let k = 0; k < N; k++) {
    store.add({ id: `t${k}`, instanceId: 'cli-p', timestamp: 1000 + k, request: {}, response: {}, status: 'complete' });
  }
  const browser = connect(wss);
  browser.send({ type: 'inspector:subscribe', instanceId: 'cli-p' });
  const snap = browser.sent.find(m => m.type === 'inspector:snapshot');
  assert.strictEqual(snap.interactions.length, DashboardBroadcaster.SNAPSHOT_LIMIT);
  assert.strictEqual(snap.interactions[0].id, 't20');
  assert.strictEqual(snap.interactions.at(-1).id, `t${N - 1}`);
  assert.strictEqual(snap.hasMore, true);
  void bc;
  done();
});

test('inspector:getEarlier pages back oldest-first with a correct hasMore', () => {
  const { store, wss, done } = setup();
  for (let k = 0; k < 30; k++) {
    store.add({ id: `t${k}`, instanceId: 'cli-p', timestamp: 1000 + k, request: { messages: [{ role: 'user', content: 'hi' }] }, response: {}, status: 'complete' });
  }
  const browser = connect(wss);
  browser.send({ type: 'inspector:subscribe', instanceId: 'cli-p' });
  assert.strictEqual(browser.sent.find(m => m.type === 'inspector:snapshot').hasMore, false);

  browser.send({ type: 'inspector:getEarlier', instanceId: 'cli-p', beforeId: 't20', limit: 10 });
  let page = browser.sent.filter(m => m.type === 'inspector:earlier').at(-1);
  assert.strictEqual(page.instanceId, 'cli-p');
  assert.strictEqual(page.beforeId, 't20');
  assert.deepStrictEqual(page.interactions.map(i => i.id), ['t10', 't11', 't12', 't13', 't14', 't15', 't16', 't17', 't18', 't19']);
  assert.strictEqual(page.hasMore, true);
  assert.ok(page.interactions.every(i => i._summary && i.request.messages === undefined), 'pages come as summaries');

  browser.send({ type: 'inspector:getEarlier', instanceId: 'cli-p', beforeId: 't10', limit: 10 });
  page = browser.sent.filter(m => m.type === 'inspector:earlier').at(-1);
  assert.deepStrictEqual(page.interactions.map(i => i.id), ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9']);
  assert.strictEqual(page.hasMore, false, 'nothing before the first turn');

  browser.send({ type: 'inspector:getEarlier', instanceId: 'cli-p', beforeId: 't3', limit: 10 });
  page = browser.sent.filter(m => m.type === 'inspector:earlier').at(-1);
  assert.deepStrictEqual(page.interactions.map(i => i.id), ['t0', 't1', 't2']);
  assert.strictEqual(page.hasMore, false);
  done();
});

test('earlierPage falls back to the timestamp when the cursor turn is gone', () => {
  const { DashboardBroadcaster, done } = setup();
  const { earlierPage } = DashboardBroadcaster;
  const list = [1, 2, 3, 4, 5].map(n => ({ id: `t${n}`, timestamp: n * 10 }));
  assert.deepStrictEqual(earlierPage(list, { beforeId: 'gone', before: 40, limit: 2 }).items.map(i => i.id), ['t2', 't3']);
  assert.strictEqual(earlierPage(list, { beforeId: 'gone', before: 40, limit: 2 }).hasMore, true);
  assert.deepStrictEqual(earlierPage(list, { beforeId: 'gone', before: 40, limit: 5 }), { items: list.slice(0, 3), hasMore: false });
  assert.deepStrictEqual(earlierPage(list, { before: 5, limit: 5 }), { items: [], hasMore: false });
  done();
});
