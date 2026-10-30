// The SDK run panel's lines (public/sdk-links.js): which lines a message or
// report lights and which way it moves on each, which workers an
// [orchestration] delivery speaks for, and the guard that keeps the two
// copies of one message from lighting the lines twice.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const L = require('../public/sdk-links.js');

const orch = { role: 'orchestrator', name: 'orch-3534f0' };
const w1 = { role: 'worker', name: 'orch-3534f0-w1-lanes-media-thumbs' };
const w2 = { role: 'worker', name: 'orch-3534f0-w2-prompt-image-missing' };
const dirs = (list) => list.map(f => [f.at.name, f.dir]);

test('orchestrator → worker moves down the worker\'s line', () => {
  assert.deepStrictEqual(dirs(L.linkFlashes(orch, w1)), [[w1.name, 'down']]);
});

test('worker → orchestrator moves up the worker\'s line', () => {
  assert.deepStrictEqual(dirs(L.linkFlashes(w1, orch)), [[w1.name, 'up']]);
});

test('worker → worker: up the sender\'s line, down the receiver\'s', () => {
  assert.deepStrictEqual(dirs(L.linkFlashes(w1, w2)), [[w1.name, 'up'], [w2.name, 'down']]);
});

test('an end the panel does not show lights nothing on its side', () => {
  assert.deepStrictEqual(dirs(L.linkFlashes(null, w1)), [[w1.name, 'down']]);
  assert.deepStrictEqual(dirs(L.linkFlashes(w1, null)), [[w1.name, 'up']]);
  assert.deepStrictEqual(L.linkFlashes(null, orch), []);
  assert.deepStrictEqual(L.linkFlashes(null, null), []);
  assert.deepStrictEqual(L.linkFlashes(w1, w1), []);
});

test('a delivery names the workers whose report, idle or exit it carries', () => {
  // As the orchestrator of run 3534f0 received it (its transcript, 13:30:14).
  const text = '[orchestration] 2 worker event(s) — act on them and update TODO.md:\n'
    + '- [report] orch-3534f0-w1-lanes-media-thumbs reported done: Committed 57f1d38 on orch/3534f0/w1 — files: public/inspector.js\n'
    + '- [landed] landed 2d7091c — orch-3534f0-w1-lanes-media-thumbs\'s orch/3534f0/w1 merged into main';
  assert.deepStrictEqual(L.deliveryWorkers(text), ['orch-3534f0-w1-lanes-media-thumbs']);
  const mixed = '[orchestration] 4 worker event(s) — act on them and update TODO.md:\n'
    + '- [idle] orch-x-w2 went idle without reporting. Its last message: ok\n'
    + '- [exited] orch-x-w3 exited (last report: done)\n'
    + '- [report] orch-x-w2 reported started: again\n'
    + '- [not landed] orch-x-w3 not landed: conflict.';
  assert.deepStrictEqual(L.deliveryWorkers(mixed), ['orch-x-w2', 'orch-x-w3']);
});

test('other notices name no worker', () => {
  assert.deepStrictEqual(L.deliveryWorkers('[orchestration] 1 worker event(s) pending'), []);
  assert.deepStrictEqual(L.deliveryWorkers('Model not changed: x\n- [report] orch-x-w1 reported done'), []);
  assert.deepStrictEqual(L.deliveryWorkers(null), []);
});

test('two copies of one message light once; the same text later lights again', () => {
  const once = L.onceWithin(10000);
  assert.strictEqual(once('a>b>hi', 1000), true);
  assert.strictEqual(once('a>b>hi', 1200), false);
  assert.strictEqual(once('b>a>hi', 1200), true);
  assert.strictEqual(once('a>b>hi', 11000), true);
});
