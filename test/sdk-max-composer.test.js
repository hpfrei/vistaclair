// A maximized pane's own composer (public/sdk-panel.js, openMax/closeMax):
// it sits in the dialog below the pane, sends straight to that box's session
// with no picker, clears itself, is disabled for an ended session, takes the
// dialog's dropped images, and leaves every key but Esc to the composer. Esc
// closes, and the composer goes with the dialog.
//
//   node --test test/

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert');

// Just enough DOM for openMax: elements with children, classes, attributes
// and listeners; the dialog's innerHTML built by hand.
class Node {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parent = null; this.attrs = {}; this.listeners = {}; this.className = ''; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
  fire(type, ev = {}) { ev.stopPropagation ||= () => {}; ev.preventDefault ||= () => {}; for (const fn of this.listeners[type] || []) fn(ev); }
  appendChild(c) { c.remove(); c.parent = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach(c => this.appendChild(c)); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; } }
  replaceWith(n) { const p = this.parent; const i = p.children.indexOf(this); n.remove(); p.children[i] = n; n.parent = p; this.parent = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  focus() { doc.activeElement = this; }
  get lastElementChild() { return this.children[this.children.length - 1]; }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n === doc.body; }
  querySelector(sel) {
    const cls = sel.replace(/^\./, '');
    for (const c of this.children) {
      if (c.className.split(' ').includes(cls)) return c;
      const d = c.querySelector(sel);
      if (d) return d;
    }
    return null;
  }
  set innerHTML(html) {
    assert.match(html, /sdk-max/);
    const mk = (cls, kids = []) => { const n = new Node('div'); n.className = cls; n.append(...kids); return n; };
    this.children = [];
    this.appendChild(mk('curl-modal sdk-max', [mk('curl-modal-header', [mk('sdk-max-title'), mk('curl-modal-close')]), mk('sdk-max-body')]));
  }
}
class Composer extends Node {
  constructor() { super('vc-composer'); this.className = 'vc-composer'; this.disabled = false; this.cleared = 0; this.drops = []; }
  clear() { this.cleared++; }
  attachDropTarget(el) { this.drops.push(el); }
}
const docListeners = [];
const doc = {
  body: new Node('body'),
  activeElement: null,
  createElement: (tag) => tag === 'vc-composer' ? new Composer() : new Node(tag),
  createComment: () => new Node('#comment'),
  addEventListener: (type, fn, capture) => docListeners.push({ type, fn, capture: !!capture }),
  removeEventListener: (type, fn) => { const i = docListeners.findIndex(l => l.type === type && l.fn === fn); if (i >= 0) docListeners.splice(i, 1); },
};

const sent = [];
const dashboard = {
  sendWs: (m) => sent.push(m), state: {}, escHtml: String, renderMarkdown() {}, renderMarkdownDebounced() {}, cancelRenderDebounce() {},
  registerModule() {}, _tabHooks: { onChange() {} }, isPhone: () => false,
};
const window = { dashboard };
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'sdk-panel.js'), 'utf8'),
  vm.createContext({ window, document: doc, console }));
const M = window.sdkPanel._max;

// The Esc handler openMax adds: capture phase, on the document.
const maxKeys = () => docListeners.filter(l => l.type === 'keydown' && l.capture);
const press = (key, extra = {}) => {
  const ev = { key, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
  for (const l of maxKeys().slice()) l.fn(ev);
  return ev;
};

function makeArea(over = {}) {
  const box = new Node('div');
  const pane = new Node('div');
  pane.className = 'sdk-todo-lite';
  box.appendChild(pane);
  const area = { sessId: 'sess-w1', label: 'w1', stops: 0, isEnded: false, ended() { return this.isEnded; }, stop() { this.stops++; },
    feedFollow: { settle() {} }, todoFollow: { settle() {} }, ...over };
  return { area, box, pane };
}

test('the dialog gets a composer below the pane that sends straight to its session', () => {
  sent.length = 0;
  const keysBefore = maxKeys().length;
  const { area, box, pane } = makeArea();
  M.openMax(area, pane, 'Live feed');
  const { overlay, composer } = M.current();
  const dialog = overlay.querySelector('.sdk-max');
  assert.ok(overlay.isConnected);
  assert.strictEqual(dialog.querySelector('.sdk-max-body').children[0], pane);
  assert.strictEqual(dialog.lastElementChild, composer, 'below the pane, inside the dialog');
  assert.strictEqual(composer.getAttribute('placeholder'), 'Message w1…');
  assert.strictEqual(doc.activeElement, composer, 'focused instead of the close button');
  assert.strictEqual(composer.disabled, false);
  assert.deepStrictEqual(composer.drops, [dialog], 'images dropped on the dialog go to it');
  assert.strictEqual(maxKeys().length, keysBefore + 1);

  composer.fire('send', { detail: { text: 'hello', images: [{ mediaType: 'image/png', base64: 'AA', name: 'a.png' }] } });
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sent[0])),
    { type: 'sdk:send', sessId: 'sess-w1', text: 'hello', images: [{ mediaType: 'image/png', base64: 'AA', name: 'a.png' }] });
  assert.strictEqual(composer.cleared, 1);

  composer.fire('interrupt');
  assert.strictEqual(area.stops, 1);

  M.closeMax();
  assert.strictEqual(M.current(), null);
  assert.ok(!overlay.isConnected, 'the composer goes with the overlay');
  assert.strictEqual(box.children[0], pane, 'the pane is back in its box');
  assert.strictEqual(maxKeys().length, keysBefore);
});

test('only Esc is taken, not while an input method composes; Esc closes', () => {
  const { area, box, pane } = makeArea();
  M.openMax(area, pane, 'TODO');
  for (const key of ['Enter', 'a', ' ', 'ArrowUp', 'Tab']) {
    const ev = press(key);
    assert.ok(!ev.prevented && !ev.stopped, `${key} reaches the composer`);
  }
  const ime = press('Escape', { isComposing: true });
  assert.ok(!ime.prevented && !ime.stopped);
  assert.ok(M.current(), 'still open');
  const esc = press('Escape');
  assert.ok(esc.prevented && esc.stopped);
  assert.strictEqual(M.current(), null);
  assert.strictEqual(box.children[0], pane);
  assert.strictEqual(area.stops, 0, 'Esc closes; it does not stop the session');
});

test('an ended session: the composer is disabled and sends nothing', () => {
  sent.length = 0;
  const { area, pane } = makeArea({ isEnded: true });
  M.openMax(area, pane, 'Live feed');
  const { overlay, composer } = M.current();
  assert.strictEqual(composer.disabled, true);
  assert.strictEqual(doc.activeElement, overlay.querySelector('.curl-modal-close'));
  composer.fire('send', { detail: { text: 'late', images: [] } });
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(composer.cleared, 0);
  M.closeMax();
});

test('on a phone the close button takes the focus, not the composer', () => {
  dashboard.isPhone = () => true;
  try {
    const { area, pane } = makeArea();
    M.openMax(area, pane, 'Live feed');
    const { overlay } = M.current();
    assert.strictEqual(doc.activeElement, overlay.querySelector('.curl-modal-close'));
    M.closeMax();
  } finally { dashboard.isPhone = () => false; }
});
