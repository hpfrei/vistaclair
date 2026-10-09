// Whole-session totals for the inspector footer: the background scan of a
// session dir (tail-only parsing of pretty-printed turn files), the cache it
// leaves behind, and live recording from store.save(). A long CLI tab holds
// far more turns than the store keeps in memory, so these figures are the
// only place its real cost shows up.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionTotals, CACHE_FILE } = require('../src/session-totals');

const SESS = '11111111-2222-3333-4444-555555555555';
const PRICING = { inputCostPerMTok: 4, outputCostPerMTok: 20, cacheReadCostPerMTok: 0.2, cacheCreateCostPerMTok: 5 };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vistaclair-totals-'));
}

// Same layout store._buildFileContent + JSON.stringify(_, null, 2) produce.
function turnFile(id, { usage, duration = 1000, startedAt = 1000, padRequest = 0, sseBlocks = 0, tools = 0 } = {}) {
  const content = [];
  for (let i = 0; i < tools; i++) content.push({ type: 'tool_use', id: `tu${i}`, name: 'Bash', input: { command: 'ls' } });
  const sseEvents = [];
  for (let i = 0; i < sseBlocks; i++) sseEvents.push({ eventType: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: 'x'.repeat(1000) } } });
  return {
    id,
    instanceId: `cli-${SESS}`,
    request: {
      model: 'claude-opus-5-5',
      // A string holding what looks like the response key must not fool the tail reader.
      messages: [{ role: 'user', content: '\n  "response": {' + 'y'.repeat(padRequest) }],
      endpoint: '/v1/messages', timestamp: startedAt, isStreaming: true,
    },
    response: {
      status: 200, headers: {}, body: { content }, sseEvents,
      timing: { startedAt, ttfb: 10, duration },
      usage, result: 'complete',
    },
    pricing: PRICING,
  };
}

function write(dir, seq, data, pretty = true) {
  fs.writeFileSync(path.join(dir, `${seq}.json`), pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
}

function scanned(totals, sessId) {
  return new Promise((resolve) => {
    const prev = totals.onChange;
    totals.onChange = (id, t) => {
      if (prev) prev(id, t);
      if (id === sessId && t.complete) resolve(t);
    };
    const now = totals.get(sessId);
    if (now?.complete) resolve(now);
  });
}

const U = (i, o, cr, cw) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });

test('scan adds up every turn file, including huge requests and responses', async () => {
  const root = tmpDir();
  const dir = path.join(root, SESS);
  fs.mkdirSync(dir);
  write(dir, 1, turnFile('a', { usage: U(1000, 2000, 1e6, 1e5), tools: 2, startedAt: 1000, duration: 500 }));
  // Request far beyond the first tail window.
  write(dir, 2, turnFile('b', { usage: U(10, 20, 0, 0), padRequest: 600 * 1024, startedAt: 5000, duration: 100 }));
  // Response beyond the first tail window: the reader has to widen it.
  write(dir, 3, turnFile('c', { usage: U(1, 1, 0, 0), sseBlocks: 400, startedAt: 9000, duration: 50 }));
  // Not pretty-printed: falls back to a whole-file parse.
  write(dir, 4, turnFile('d', { usage: U(5, 5, 0, 0), tools: 1 }), false);
  // Hooks: the prompt the user sent is the turn; others are hook events. A
  // hook body holding tool_use-shaped content is not a tool call.
  write(dir, 5, { id: 'hook-1', request: { hook_event_name: 'Stop' }, response: { status: 200, body: { content: [{ type: 'tool_use' }] }, timing: { startedAt: 2000, duration: 3 } }, isHook: true, hookEvent: 'Stop' });
  write(dir, 8, { id: 'hook-2', request: { hook_event_name: 'UserPromptSubmit', prompt: 'go' }, response: { status: 200, timing: { startedAt: 900, duration: 0 } }, isHook: true, hookEvent: 'UserPromptSubmit' });
  // Legacy duplicate of 'a' in a later file: counted once.
  write(dir, 6, turnFile('a', { usage: U(1000, 2000, 1e6, 1e5), tools: 2, startedAt: 1000, duration: 500 }));
  fs.writeFileSync(path.join(dir, '7.json'), '');
  fs.writeFileSync(path.join(dir, 'internal.json'), '[]');

  const totals = new SessionTotals(root, { debounceMs: 0 });
  const t = await scanned(totals, SESS);

  assert.strictEqual(t.turns, 1);
  assert.strictEqual(t.apiCalls, 4);
  assert.strictEqual(t.hookEvents, 1);
  assert.strictEqual(t.toolCalls, 3);
  assert.strictEqual(t.inputTokens, 1016);
  assert.strictEqual(t.outputTokens, 2026);
  assert.strictEqual(t.cacheRead, 1e6);
  assert.strictEqual(t.cacheCreate, 1e5);
  const expected = (1016 * 4 + 2026 * 20 + 1e6 * 0.2 + 1e5 * 5) / 1e6;
  assert.ok(Math.abs(t.cost - expected) < 1e-9, `cost ${t.cost} != ${expected}`);
  assert.strictEqual(t.duration, 500 + 100 + 50 + 1000 + 3);
  assert.strictEqual(t.firstAt, 900);
  assert.ok(fs.existsSync(path.join(dir, CACHE_FILE)));
});

test('a second instance answers from the cache and only reads new files', async () => {
  const root = tmpDir();
  const dir = path.join(root, SESS);
  fs.mkdirSync(dir);
  write(dir, 1, turnFile('a', { usage: U(100, 100, 0, 0) }));
  await scanned(new SessionTotals(root, { debounceMs: 0 }), SESS);

  // Corrupt the already-cached file: a re-read would drop it from the totals.
  fs.writeFileSync(path.join(dir, '1.json'), 'garbage');
  write(dir, 2, turnFile('b', { usage: U(1, 1, 0, 0) }));
  const t = await scanned(new SessionTotals(root, { debounceMs: 0 }), SESS);
  assert.strictEqual(t.apiCalls, 2);
  assert.strictEqual(t.inputTokens, 101);
});

test('record() overwrites a turn rather than adding it again, and beats a stale scan', async () => {
  const root = tmpDir();
  const dir = path.join(root, SESS);
  fs.mkdirSync(dir);
  write(dir, 1, turnFile('a', { usage: null }));
  const totals = new SessionTotals(root, { debounceMs: 0 });
  // Recorded live before the scan's batch lands: the live copy must win.
  totals.get(SESS);
  totals.record(SESS, 1, { id: 'a', usage: U(50, 50, 0, 0), pricing: PRICING, timing: { startedAt: 1, duration: 7 }, response: { body: { content: [] } } });
  let t = await scanned(totals, SESS);
  assert.strictEqual(t.apiCalls, 1);
  assert.strictEqual(t.inputTokens, 50);

  // start → complete → error saves of one turn
  const seq2 = { id: 'b', usage: null, timing: { startedAt: 2, duration: 0 }, response: {} };
  totals.record(SESS, 2, seq2);
  totals.record(SESS, 2, { ...seq2, usage: U(10, 10, 0, 0), pricing: PRICING });
  totals.record(SESS, 2, { ...seq2, usage: U(10, 10, 0, 0), pricing: PRICING });
  t = totals.get(SESS);
  assert.strictEqual(t.apiCalls, 2);
  assert.strictEqual(t.inputTokens, 60);

  totals.record(SESS, 3, { id: 'hook-p', isHook: true, hookEvent: 'UserPromptSubmit', timing: { startedAt: 3, duration: 0 }, response: {} });
  t = totals.get(SESS);
  assert.strictEqual(t.turns, 1);
  assert.strictEqual(t.apiCalls, 2);

  // And the cache replays to the same figures.
  const again = await scanned(new SessionTotals(root, { debounceMs: 0 }), SESS);
  assert.strictEqual(again.apiCalls, 2);
  assert.strictEqual(again.inputTokens, 60);
});

test('get() refuses ids that are not a plain session dir', () => {
  const root = tmpDir();
  const totals = new SessionTotals(root);
  assert.strictEqual(totals.get('../etc'), null);
  assert.strictEqual(totals.get('.hidden'), null);
  assert.strictEqual(totals.get('no-such-session'), null);
});

test('store.save() feeds a loaded session and broadcasts its totals', async () => {
  const home = tmpDir();
  process.env.VISTACLAIR_HOME = home;
  for (const m of ['../src/store', '../src/utils', '../src/capabilities']) delete require.cache[require.resolve(m)];
  const InteractionStore = require('../src/store');
  const store = new InteractionStore(10);
  const sent = [];
  store.setBroadcaster({ broadcast: (m) => sent.push(m) });
  store.totals.debounceMs = 0;
  store.registerSession(`cli-${SESS}`, SESS);
  await scanned(store.totals, SESS);

  const turn = {
    id: 'live-1', instanceId: `cli-${SESS}`, endpoint: '/v1/messages', timestamp: 1,
    request: { model: 'claude-opus-5-5' }, response: { status: 200, headers: {}, body: { content: [] } },
    usage: U(7, 3, 0, 0), pricing: PRICING, timing: { startedAt: 1, duration: 9 }, status: 'complete',
  };
  store.add(turn);
  store.save(turn.id);
  await new Promise(r => setTimeout(r, 20));
  const last = sent.filter(m => m.type === 'inspector:sessionTotals').pop();
  assert.ok(last, 'no inspector:sessionTotals broadcast');
  assert.strictEqual(last.instanceId, `cli-${SESS}`);
  assert.strictEqual(last.totals.apiCalls, 1);
  assert.strictEqual(last.totals.turns, 0);
  assert.strictEqual(last.totals.inputTokens, 7);
  store.totals.forget(SESS);
});

test('the inspector gets totals for every turn on disk, not just those in memory', async () => {
  const { EventEmitter } = require('events');
  const home = tmpDir();
  const dir = path.join(home, 'interactions', SESS);
  fs.mkdirSync(dir, { recursive: true });
  for (let seq = 1; seq <= 12; seq++) write(dir, seq, turnFile(`t${seq}`, { usage: U(seq, 1, 0, 0), tools: 1 }));

  process.env.VISTACLAIR_HOME = home;
  for (const m of ['../src/store', '../src/utils', '../src/capabilities', '../src/dashboard-ws', '../src/proxy']) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
  const InteractionStore = require('../src/store');
  const DashboardBroadcaster = require('../src/dashboard-ws');
  const store = new InteractionStore(4);
  assert.strictEqual(store.getAll().length, 4, 'memory holds only the newest maxSize turns');
  store.totals.debounceMs = 0;

  const wss = new EventEmitter();
  wss.clients = new Set();
  // As server.js wires it.
  store.setBroadcaster(new DashboardBroadcaster(wss, store, { cliSessionManager: { bootId: 'b', list: () => [], droppedTabs: [] } }));
  const sent = [];
  let onMessage = null;
  const ws = {
    readyState: 1,
    send: (raw) => { try { sent.push(JSON.parse(raw)); } catch {} },
    on: (ev, fn) => { if (ev === 'message') onMessage = fn; },
  };
  wss.clients.add(ws);
  wss.emit('connection', ws);

  onMessage(JSON.stringify({ type: 'inspector:getSessionTotals', instanceId: `cli-${SESS}` }));
  const deadline = Date.now() + 5000;
  let final;
  while (!(final = sent.find(m => m.type === 'inspector:sessionTotals' && m.totals?.complete)) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10));
  }
  assert.ok(final, 'no complete totals arrived');
  assert.strictEqual(final.instanceId, `cli-${SESS}`);
  assert.strictEqual(final.totals.apiCalls, 12);
  assert.strictEqual(final.totals.toolCalls, 12);
  assert.strictEqual(final.totals.inputTokens, 78);

  onMessage(JSON.stringify({ type: 'inspector:getSessionTotals', instanceId: 'ext-1' }));
  assert.strictEqual(sent.pop().totals, null, 'only CLI tab ids resolve to a session');
  store.totals.forget(SESS);
});
