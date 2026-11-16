// The "Your turn" popover (public/owner-items.js view({ popover })): closes on
// Escape, on a mousedown outside and on ×, gives the focus back to its button,
// and does not fetch while closed. Fake DOM, no jsdom.
//
//   node --test test/owner-items-popover.test.js

const test = require('node:test');
const assert = require('node:assert');
const { makeDom, loadPublic } = require('./desks-fake-dom');

const RUNS = { runs: [{ runId: 'r1', name: 'orch-r1', items: [
  { id: 'o1', kind: 'action', what: 'Build', at: Date.now(), state: 'open' },
  { id: 'o2', kind: 'decision', what: 'Port?', options: ['1', '2'], at: Date.now(), state: 'open' },
] }] };

function setup() {
  const { doc } = makeDom();
  const fetched = [];
  const timers = [];
  const globals = {
    fetch: async (url) => { fetched.push(url); return { ok: true, json: async () => (url.includes('owner-items') ? RUNS : { locks: [] }) }; },
    CSS: { escape: (s) => String(s) },
    setInterval: (fn) => { const t = { fn }; timers.push(t); return t; },
    clearInterval: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  };
  const { window } = loadPublic(['owner-items.js'], { doc, globals });
  const btn = doc.createElement('button');
  const outside = doc.createElement('div');
  const host = doc.createElement('div');
  doc.body.append(btn, outside, host);
  const v = window.ownerItems.view({ runId: 'r1', emptyText: 'Nothing', popover: { anchor: btn } });
  host.appendChild(v.el);
  // What the browser does: document-level listeners get the event.
  const fire = (type, ev) => { for (const fn of (doc._listeners[type] || []).slice()) fn(ev); return ev; };
  const key = (k, extra = {}, target = outside) => fire('keydown', { key: k, target, stopPropagation() {}, preventDefault() {}, ...extra });
  const down = (target) => fire('mousedown', { target });
  const settle = () => new Promise(r => setImmediate(r));
  const hidden = () => v.el.classList.contains('hidden');
  return { doc, v, btn, outside, fetched, timers, key, down, settle, hidden, host };
}

const fakeAll = { closest: (s) => (s === 'input[data-sel-all]' ? { checked: true } : null) };
const selectAll = async (t) => { t.v.el.dispatch('click', { target: fakeAll }); await t.settle(); };

test('opens hidden-by-default, focuses itself, marks the button expanded, is a dialog', async () => {
  const t = setup();
  assert.ok(t.hidden());
  assert.strictEqual(t.btn.getAttribute('aria-expanded'), 'false');
  t.v.open();
  await t.settle();
  assert.ok(!t.hidden());
  assert.strictEqual(t.btn.getAttribute('aria-expanded'), 'true');
  assert.strictEqual(t.v.el.getAttribute('role'), 'dialog');
  assert.ok(t.v.el.getAttribute('aria-label'));
  assert.strictEqual(t.doc.activeElement, t.v.el);
  assert.ok(t.fetched.some(u => u.includes('owner-items')), 'opening fetches at once');
});

test('(a) Escape closes it from anywhere and returns the focus to the button; a selection is cleared first', async () => {
  const t = setup();
  t.v.open();
  await t.settle();
  await selectAll(t);
  assert.match(t.v.el.querySelector('.oi-body').innerHTML, /oi-selected/);
  t.key('Escape');
  assert.ok(!t.hidden(), 'the first Escape only clears the selection');
  assert.doesNotMatch(t.v.el.querySelector('.oi-body').innerHTML, /oi-selected/);
  t.key('Escape');
  assert.ok(t.hidden());
  assert.strictEqual(t.btn.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(t.doc.activeElement, t.btn);
  assert.deepStrictEqual(t.doc._listeners.keydown || [], [], 'document listeners removed');
  assert.deepStrictEqual(t.doc._listeners.mousedown || [], []);
});

test('(a) Escape in an answer field closes it, selection or not; composing Escape does nothing', async () => {
  const t = setup();
  t.v.open();
  await t.settle();
  await selectAll(t);
  const input = { matches: (s) => s === '[data-answer-for]' };
  t.key('Escape', { isComposing: true }, input);
  assert.ok(!t.hidden(), 'an IME Escape is not ours');
  t.key('Escape', {}, input);
  assert.ok(t.hidden());
});

test('(b) a mousedown outside closes it and leaves the focus; inside and on the button do not', async () => {
  const t = setup();
  t.v.open();
  await t.settle();
  const inner = t.doc.createElement('span');
  t.v.el.appendChild(inner);
  t.down(inner);
  t.down(t.v.el);
  t.down(t.btn);
  assert.ok(!t.hidden(), 'inside / the button: still open');
  t.outside.focus();
  t.down(t.outside);
  assert.ok(t.hidden());
  assert.strictEqual(t.btn.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(t.doc.activeElement, t.outside, 'focus stays where the user clicked');
});

test('(c) × closes it and the focus returns to the button', async () => {
  const t = setup();
  t.v.open();
  await t.settle();
  const x = t.v.el.querySelector('.oi-close');
  assert.ok(x, 'a × is there');
  assert.strictEqual(x.getAttribute('aria-label'), 'Close');
  x.click();
  assert.ok(t.hidden());
  assert.strictEqual(t.doc.activeElement, t.btn);
  assert.strictEqual(t.btn.getAttribute('aria-expanded'), 'false');
});

test('(d) a hidden view does not fetch on tick or on refresh; reopening fetches again', async () => {
  const t = setup();
  t.v.open();
  await t.settle();
  assert.strictEqual(t.timers.length, 1);
  t.v.close();
  assert.strictEqual(t.timers.length, 0, 'the interval is stopped');
  t.fetched.length = 0;
  t.v.refresh();
  await t.settle();
  assert.strictEqual(t.fetched.length, 0);
  t.v.open();
  await t.settle();
  assert.ok(t.fetched.length > 0);
  // Even if the element is hidden from outside and the interval fires.
  t.v.el.classList.add('hidden');
  t.fetched.length = 0;
  t.timers[0].fn();
  await t.settle();
  assert.strictEqual(t.fetched.length, 0);
  assert.strictEqual(t.timers.length, 0, 'the tick stopped itself');
});

test('the global view has no ×, is not a dialog and still polls', async () => {
  const { doc } = makeDom();
  const timers = [];
  const { window } = loadPublic(['owner-items.js'], { doc, globals: {
    fetch: async () => ({ ok: true, json: async () => RUNS }), CSS: { escape: String },
    setInterval: (fn) => { timers.push(fn); return timers.length; }, clearInterval() {},
  } });
  const g = window.ownerItems.view({ emptyText: '' });
  doc.body.appendChild(g.el);
  g.start();
  assert.strictEqual(g.el.querySelector('.oi-close'), null);
  assert.strictEqual(g.el.getAttribute('role'), null);
  assert.strictEqual(timers.length, 1);
});
