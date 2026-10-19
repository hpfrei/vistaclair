// The dashboard page queues WebSocket messages nobody handles yet and replays
// them when an add-on registers its prefix. Covers the queue, and that core.js
// wires it in without touching the types its own switch handles.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createPendingQueue, MAX, TTL_MS } = require('../public/ws-pending.js');

const m = (type, n) => ({ type, n });

test('a message before registration is replayed after it, in arrival order', () => {
  const q = createPendingQueue();
  q.push(m('app:a', 1), 0);
  q.push(m('other:x', 2), 1);
  q.push(m('app:b', 3), 2);
  assert.deepStrictEqual(q.take('app:', 10).map((x) => x.n), [1, 3]);
  assert.strictEqual(q.size(), 1);
  assert.deepStrictEqual(q.take('app:', 10), []); // never delivered twice
  assert.deepStrictEqual(q.take('other:', 10).map((x) => x.n), [2]);
});

test('matching is by prefix; a longer prefix takes only its own messages', () => {
  const q = createPendingQueue();
  q.push(m('app:spend:mode', 1), 0);
  q.push(m('app:boot:status', 2), 0);
  assert.deepStrictEqual(q.take('app:spend:', 1).map((x) => x.n), [1]);
  assert.deepStrictEqual(q.take('app:', 1).map((x) => x.n), [2]);
});

test('queue is bounded: oldest messages are dropped first', () => {
  const q = createPendingQueue({ max: 3 });
  for (let i = 1; i <= 5; i++) q.push(m('app:x', i), i);
  assert.strictEqual(q.size(), 3);
  assert.deepStrictEqual(q.take('app:', 5).map((x) => x.n), [3, 4, 5]);
  assert.strictEqual(MAX, 1000);
});

test('messages older than the TTL are dropped', () => {
  const q = createPendingQueue();
  q.push(m('app:old', 1), 0);
  q.push(m('app:new', 2), TTL_MS);
  assert.deepStrictEqual(q.take('app:', TTL_MS + 1).map((x) => x.n), [2]);
  q.push(m('app:old2', 3), 0);
  assert.deepStrictEqual(q.take('app:', TTL_MS + 1), []);
});

test('core.js queues only what its switch does not handle', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/core.js'), 'utf8');
  // Known types are `case` labels in the switch and never reach the queue.
  const sw = src.slice(src.indexOf('function handleMessage'));
  const defaultAt = sw.indexOf('    default:');
  assert.ok(defaultAt > 0);
  const caseBlock = sw.slice(0, defaultAt);
  const defaultBlock = sw.slice(defaultAt, sw.indexOf('\n}\n', defaultAt));
  assert.ok(!/pendingMessages/.test(caseBlock), 'queue must only be fed from the default branch');
  assert.match(defaultBlock, /pendingMessages\.push/);
  // mcp: messages keep going to the mcp module.
  assert.match(defaultBlock, /startsWith\('mcp:'\)[\s\S]*mcpModule[\s\S]*else[\s\S]*pendingMessages\.push/);
  // A plugin handler wins over the queue, and registration replays matches.
  assert.match(src, /registerModule = \(prefix, handler\) => \{[\s\S]*pendingMessages\.take\(prefix/);
  // The script loads before core.js.
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(html.indexOf('ws-pending.js') > 0 && html.indexOf('ws-pending.js') < html.indexOf('src="core.js"'));
});
