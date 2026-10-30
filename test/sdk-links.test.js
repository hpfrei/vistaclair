// The SDK run panel's lines (public/sdk-links.js): which lines a message or
// report lights and which way it moves on each, when it takes an arc between
// two workers and that arc's shape, which workers an
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

test('worker → worker, both boxes in the row: one arc, no line', () => {
  const r = L.messageRoute(w1, w2, () => true);
  assert.deepStrictEqual(r.arc, { from: w1, to: w2 });
  assert.deepStrictEqual(r.lines, []);
  assert.deepStrictEqual(L.messageRoute(w2, w1, () => true).arc, { from: w2, to: w1 });
});

test('worker → worker with a box not in the row lights the lines as before', () => {
  const only = (...shown) => (a) => shown.includes(a);
  for (const inRow of [only(w1), only(w2), only()]) {
    const r = L.messageRoute(w1, w2, inRow);
    assert.strictEqual(r.arc, null);
    assert.deepStrictEqual(dirs(r.lines), [[w1.name, 'up'], [w2.name, 'down']]);
  }
});

test('traffic with the orchestrator, or with an end not shown, never takes an arc', () => {
  const all = () => true;
  assert.strictEqual(L.messageRoute(orch, w1, all).arc, null);
  assert.deepStrictEqual(dirs(L.messageRoute(orch, w1, all).lines), [[w1.name, 'down']]);
  assert.strictEqual(L.messageRoute(w1, orch, all).arc, null);
  assert.deepStrictEqual(dirs(L.messageRoute(w1, orch, all).lines), [[w1.name, 'up']]);
  assert.strictEqual(L.messageRoute(w1, null, all).arc, null);
  assert.deepStrictEqual(L.messageRoute(w1, w1, all), { arc: null, lines: [] });
});

// The numbers of a path's data, in order.
const nums = (d) => d.match(/-?\d+(\.\d+)?/g).map(Number);

test('an arc runs from the sender\'s tag to the receiver\'s and bows up', () => {
  // Rightward: starts left (the sender), ends right under the arrowhead.
  const right = L.arcPath(100, 200, 400, 200, 120);
  const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = nums(right.d);
  assert.deepStrictEqual([sx, sy], [106, 200]);
  assert.deepStrictEqual([ex, ey], [406, 193]);
  assert.ok(c1y < sy && c2y === c1y && c1x === sx && c2x === ex);
  // The arrowhead's tip is on the receiver's tag, its base where the arc ends.
  const [hx1, hy1, tx, ty, hx2, hy2] = nums(right.head);
  assert.deepStrictEqual([tx, ty], [406, 200]);
  assert.deepStrictEqual([hx1, hy1, hx2, hy2], [402, 193, 410, 193]);
  // Leftward: drawn from the right, and beside the rightward one.
  const left = L.arcPath(400, 200, 100, 200, 120);
  const l = nums(left.d);
  assert.deepStrictEqual([l[0], l[1], l[6]], [394, 200, 94]);
  assert.notStrictEqual(left.d, right.d);
});

test('an arc rises with the distance but never above the ceiling', () => {
  // A cubic with level handles at c peaks at base + 3/4 (c - base).
  const peak = (a) => { const n = nums(a.d); return n[1] + 0.75 * (n[3] - n[1]); };
  const near = L.arcPath(100, 200, 200, 200, 0);
  const far = L.arcPath(100, 200, 500, 200, 0);
  assert.ok(peak(far) < peak(near));
  assert.ok(Math.abs(peak(far) - (200 - 400 * 0.35)) < 0.2);
  const capped = L.arcPath(100, 200, 900, 200, 150);
  assert.ok(Math.abs(peak(capped) - 150) < 0.2);
  // No room at all: still a small bow.
  assert.ok(peak(L.arcPath(100, 200, 900, 200, 199)) < 200);
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
