// The shelf of closed workers (public/sdk-panel.js, Panel#layoutWorkers /
// renderShelf / openShelved): several shelved workers can be open at once;
// a card toggles only its own worker, and each box's ◂ Shelf puts back only
// that worker.
//
//   node --test test/

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sdk-panel.js'), 'utf8');
const dashboard = {
  sendWs() {}, state: {}, escHtml: String, renderMarkdown() {}, renderMarkdownDebounced() {}, cancelRenderDebounce() {},
  registerModule() {}, _tabHooks: { onChange() {} }, isPhone: () => false,
};

function classList() {
  const s = new Set();
  return { toggle(c, on) { if (on === undefined ? !s.has(c) : on) s.add(c); else s.delete(c); }, contains: (c) => s.has(c), add: (c) => s.add(c), remove: (c) => s.delete(c) };
}
function node() {
  const n = { children: [], classList: classList(), attrs: {}, parent: null, listeners: {} };
  n.setAttribute = (k, v) => { n.attrs[k] = v; };
  n.insertBefore = (e, at) => {
    if (e.parent) e.remove();
    const i = at ? n.children.indexOf(at) : n.children.length;
    n.children.splice(i < 0 ? n.children.length : i, 0, e);
    e.parent = n;
  };
  n.remove = () => { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = null; };
  return n;
}
function worker(sessId, workerId, { ended = true, shown = [] } = {}) {
  return { sessId, workerId, label: workerId, el: node(), cost: 0, ended: () => ended, shelved() { return this.ended(); },
    setShown(v) { shown.push(v); }, shown };
}
function panel(workers) {
  const p = {
    openIds: new Set(), cards: new Map(), rowList: [], active: true,
    workers: new Map(workers.map(w => [w.sessId, w])),
    workersEl: node(), shelfEl: node(), shelfTitle: {}, shelfList: node(), panelEl: node(),
    main: { setShown() {} }, drawLinksSoon() {},
  };
  return p;
}
// the shelf's card elements are made by the panel's own `el` helper, which needs a DOM
const realDoc = {
  createElement() { const n = node(); n.append = (...c) => c.forEach(x => n.insertBefore(x, null)); n.addEventListener = (t, f) => { n.listeners[t] = f; }; n.type = ''; n.title = ''; n.textContent = ''; n.className = ''; return n; },
  activeElement: null, addEventListener() {}, removeEventListener() {}, visibilityState: 'visible',
};
const ctx = vm.createContext({ window: { dashboard }, document: realDoc, console });
vm.runInContext(src, ctx);
const Q = ctx.window.sdkPanel._Panel.prototype;

function setup() {
  const a = worker('s1', 'w1'), b = worker('s2', 'w2'), run = worker('s3', 'w3', { ended: false });
  const p = panel([a, b, run]);
  for (const m of ['sortedWorkers', 'layoutWorkers', 'syncShown', 'renderShelf', 'renderShelfAges', 'openShelved']) p[m] = Q[m];
  p.layoutWorkers();
  return { p, a, b, run };
}
const card = (p, id) => p.cards.get(id);

test('two shelved workers can be open at once; each box and card shows it', () => {
  const { p, a, b, run } = setup();
  assert.deepStrictEqual(p.workersEl.children, [run.el], 'only the running box before');
  p.cards.get('s1').el.listeners.click();
  p.cards.get('s2').el.listeners.click();
  assert.deepStrictEqual(p.workersEl.children, [a.el, b.el, run.el], 'opened boxes, in opening order, then the running one');
  assert.ok(a.el.classList.contains('sdk-area-opened'));
  assert.ok(b.el.classList.contains('sdk-area-opened'));
  assert.ok(!run.el.classList.contains('sdk-area-opened'));
  assert.ok(card(p, 's1').el.classList.contains('open'));
  assert.ok(card(p, 's2').el.classList.contains('open'));
  assert.strictEqual(card(p, 's2').el.attrs['aria-pressed'], 'true');
  assert.deepStrictEqual(a.shown.at(-1), true);
  assert.deepStrictEqual(b.shown.at(-1), true);
});

test('a box\'s ◂ Shelf puts only that worker back', () => {
  const { p, a, b } = setup();
  p.openShelved('s1'); p.openShelved('s2');
  p.openShelved('s1', false);              // what the caption's ◂ Shelf calls
  assert.ok(!a.el.parent, 'its box left the row');
  assert.ok(!a.el.classList.contains('sdk-area-opened'));
  assert.ok(b.el.parent === p.workersEl && b.el.classList.contains('sdk-area-opened'), 'the other stays open');
  assert.ok(!card(p, 's1').el.classList.contains('open'));
  assert.ok(card(p, 's2').el.classList.contains('open'));
  assert.strictEqual(a.shown.at(-1), false, 'the box that left is released as before');
  assert.match(src, /\.sdk-shelve'\)\.addEventListener\('click', \(\) => this\.panel\.openShelved\(this\.sessId, false\)\)/);
});

test('a card click toggles only its worker', () => {
  const { p, a, b } = setup();
  card(p, 's1').el.listeners.click(); card(p, 's2').el.listeners.click();
  card(p, 's2').el.listeners.click();      // the card again
  assert.ok(a.el.parent === p.workersEl && a.el.classList.contains('sdk-area-opened'));
  assert.ok(!b.el.parent);
  assert.ok(!card(p, 's2').el.classList.contains('open'));
});

test('a worker that leaves the shelf drops out of the open set', () => {
  const { p, a, b } = setup();
  p.openShelved('s1'); p.openShelved('s2');
  a.ended = () => false;                   // resumed
  p.layoutWorkers();
  assert.deepStrictEqual([...p.openIds], ['s2']);
  assert.ok(b.el.classList.contains('sdk-area-opened'));
});
