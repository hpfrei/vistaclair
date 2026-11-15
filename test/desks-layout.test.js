// Pure Desks layout helpers (public/desk-layout.js): snap zones and rects,
// clamping into view, tiling, the fraction <-> pixel round trip, resizing,
// and the restore planner that never drops a window entry.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const L = require('../public/desk-layout.js');

const AREA = { width: 1600, height: 900 };

test('fractions round-trip through pixels', () => {
  const g = { x: 0.125, y: 0.2, w: 0.5, h: 0.6 };
  const px = L.toPx(g, AREA);
  assert.deepStrictEqual(px, { left: 200, top: 180, width: 800, height: 540 });
  assert.deepStrictEqual(L.toFrac(px, AREA), g);
  // The same fractions in another area size keep their proportions.
  const small = L.toPx(g, { width: 800, height: 450 });
  assert.deepStrictEqual(small, { left: 100, top: 90, width: 400, height: 270 });
  // A pixel rect from a drag is stable after one trip.
  const f = L.toFrac({ left: 333, top: 77, width: 611, height: 401 }, AREA);
  assert.deepStrictEqual(L.toFrac(L.toPx(f, AREA), AREA), f);
});

test('clamp: a window always ends up wholly inside the area, at least the minimum size', () => {
  // Off to the bottom right: pulled back.
  assert.deepStrictEqual(L.clampPx({ left: 1500, top: 850, width: 400, height: 300 }, AREA),
    { left: 1200, top: 600, width: 400, height: 300 });
  // Off to the top left.
  assert.deepStrictEqual(L.clampPx({ left: -50, top: -20, width: 400, height: 300 }, AREA),
    { left: 0, top: 0, width: 400, height: 300 });
  // Larger than the area: shrunk to it.
  assert.deepStrictEqual(L.clampPx({ left: 10, top: 10, width: 4000, height: 3000 }, AREA),
    { left: 0, top: 0, width: 1600, height: 900 });
  // Too small: the minimum.
  const tiny = L.clampPx({ left: 10, top: 10, width: 5, height: 5 }, AREA);
  assert.strictEqual(tiny.width, L.MIN_W);
  assert.strictEqual(tiny.height, L.MIN_H);
  // The area shrank below the minimum: the area wins.
  assert.deepStrictEqual(L.clampPx({ left: 0, top: 0, width: 300, height: 200 }, { width: 150, height: 100 }),
    { left: 0, top: 0, width: 150, height: 100 });
  // Fractions after the area got small: the minimum size pushes it back in.
  const g = L.clampFrac({ x: 0.9, y: 0.9, w: 0.1, h: 0.1 }, { width: 1000, height: 600 });
  assert.ok(g.x + g.w <= 1.0001 && g.y + g.h <= 1.0001, JSON.stringify(g));
  assert.ok(g.w * 1000 >= L.MIN_W - 1);
});

test('snap zones: edges make halves, corners quarters, the top edge maximizes', () => {
  assert.strictEqual(L.snapZone({ x: 2, y: 450 }, AREA), 'left');
  assert.strictEqual(L.snapZone({ x: 1598, y: 450 }, AREA), 'right');
  assert.strictEqual(L.snapZone({ x: 800, y: 1 }, AREA), 'top');
  assert.strictEqual(L.snapZone({ x: 2, y: 10 }, AREA), 'tl');
  assert.strictEqual(L.snapZone({ x: 10, y: 2 }, AREA), 'tl');
  assert.strictEqual(L.snapZone({ x: 1599, y: 20 }, AREA), 'tr');
  assert.strictEqual(L.snapZone({ x: 0, y: 890 }, AREA), 'bl');
  assert.strictEqual(L.snapZone({ x: 1590, y: 899 }, AREA), 'br');
  assert.strictEqual(L.snapZone({ x: 800, y: 450 }, AREA), null);
  assert.strictEqual(L.snapZone({ x: 800, y: 899 }, AREA), null, 'the bottom edge mid-way does nothing');
  assert.deepStrictEqual(L.snapRect('left'), { x: 0, y: 0, w: 0.5, h: 1 });
  assert.deepStrictEqual(L.snapRect('right'), { x: 0.5, y: 0, w: 0.5, h: 1 });
  assert.deepStrictEqual(L.snapRect('top'), { x: 0, y: 0, w: 1, h: 1 });
  assert.deepStrictEqual(L.snapRect('br'), { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  assert.strictEqual(L.snapRect(null), null);
});

test('tile: n windows fill the area without overlap', () => {
  assert.deepStrictEqual(L.tile(0), []);
  assert.deepStrictEqual(L.tile(1), [{ x: 0, y: 0, w: 1, h: 1 }]);
  assert.deepStrictEqual(L.tile(2), [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }]);
  const three = L.tile(3);
  assert.deepStrictEqual(three, [
    { x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0, w: 0.5, h: 0.5 },
    { x: 0, y: 0.5, w: 1, h: 0.5 },
  ], 'the last row spans the width');
  for (const n of [4, 5, 7, 9, 10]) {
    const rects = L.tile(n);
    assert.strictEqual(rects.length, n);
    const area = rects.reduce((s, r) => s + r.w * r.h, 0);
    assert.ok(Math.abs(area - 1) < 0.01, `n=${n} covers the area (${area})`);
    for (const r of rects) assert.ok(r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001);
  }
});

test('resize: the opposite edge stays put and the minimum holds', () => {
  const r = { left: 100, top: 100, width: 400, height: 300 };
  assert.deepStrictEqual(L.resizePx(r, 'se', 50, 20), { left: 100, top: 100, width: 450, height: 320 });
  assert.deepStrictEqual(L.resizePx(r, 'nw', 50, 20), { left: 150, top: 120, width: 350, height: 280 });
  const shrunk = L.resizePx(r, 'w', 1000, 0);
  assert.strictEqual(shrunk.width, L.MIN_W);
  assert.strictEqual(shrunk.left + shrunk.width, 500, 'right edge fixed');
});

test('restore planner: open tab mounts, closed tab is a placeholder, unknown kind is kept as a placeholder', () => {
  const windows = [
    { kind: 'cli', key: 'open' },
    { kind: 'cli', key: 'closed' },
    { kind: 'apps', key: 'notes' },
  ];
  const plan = L.planRestore(windows, {
    hasKind: (k) => k === 'cli',
    hasTab: (k, key) => k === 'cli' && key === 'open',
  });
  assert.deepStrictEqual(plan, [
    { kind: 'cli', key: 'open', status: 'mount' },
    { kind: 'cli', key: 'closed', status: 'missing' },
    { kind: 'apps', key: 'notes', status: 'unregistered' },
  ]);
  assert.strictEqual(plan.length, windows.length, 'no entry is dropped');
  assert.deepStrictEqual(L.planRestore(undefined, { hasKind: () => true, hasTab: () => true }), []);
});
