// The "Send to which session?" dialog (public/sdk-panel.js, openPicker):
// only sessions that can take a message are listed (not ended, closed,
// paused or pausing), the orchestrator pinned first and selected, the
// workers below it: awaiting an answer, busy, idle, then by name. Enter
// (a fresh key press) sends to the selection, so submit + Enter goes to the
// orchestrator; ↑ ↓ / Tab move it (wrapping), 0 picks the orchestrator and
// 1-9 the Nth worker, a double click sends, Esc cancels.
//
//   node --test test/

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert');

class Node {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parent = null; this.attrs = {}; this.listeners = {}; this.className = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.scrolled = 0; }
  get classList() {
    const n = this;
    const set = () => new Set(n.className.split(' ').filter(Boolean));
    return { toggle(c, on) { const s = set(); (on ?? !s.has(c)) ? s.add(c) : s.delete(c); n.className = [...s].join(' '); }, contains: (c) => set().has(c) };
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
  fire(type, ev = {}) { ev.stopPropagation ||= () => {}; ev.preventDefault ||= () => {}; for (const fn of this.listeners[type] || []) fn(ev); }
  appendChild(c) { c.remove(); c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; } }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  focus() { doc.activeElement = this; }
  scrollIntoView() { this.scrolled++; }
  set innerHTML(html) { assert.strictEqual(html, ''); this.children.forEach(c => { c.parent = null; }); this.children = []; }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n === doc.body; }
  all(cls, out = []) { for (const c of this.children) { if (c.className.split(' ').includes(cls)) out.push(c); c.all(cls, out); } return out; }
  one(cls) { return this.all(cls)[0] || null; }
}
const docListeners = [];
const doc = {
  body: new Node('body'),
  activeElement: null,
  createElement: (tag) => new Node(tag),
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
const { _Panel: Panel, _pick: P } = window.sdkPanel;

const ENDED = new Set(['exited', 'stopped', 'abandoned', 'closed', 'replaced']);
const area = (label, state = 'idle', over = {}) => ({
  sessId: `sess-${label}`, label, state, role: label === 'orchestrator' ? 'orchestrator' : 'worker', nowLine: '',
  ended() { return ENDED.has(this.state); }, shownModel: () => 'claude-sonnet-5-5', ...over,
});
const labels = (l) => [...l.map(a => a.label)];

test('pickEntries: inactive sessions are left out, orchestrator first, then awaiting → busy → idle → name', () => {
  const areas = [
    area('orchestrator', 'idle'),
    area('w10', 'idle'), area('w2', 'idle'), area('w3', 'busy'), area('w1', 'awaiting'),
    area('w4', 'exited'), area('w5', 'closed'), area('w6', 'paused'), area('w7', 'pausing'), area('w8', 'replaced'),
    area('a-busy', 'busy'),
  ];
  assert.deepStrictEqual(labels(P.pickEntries(areas)), ['orchestrator', 'w1', 'a-busy', 'w3', 'w2', 'w10']);
});

test('pickEntries: the orchestrator stays first even when busy; only it active still gives one entry', () => {
  assert.deepStrictEqual(labels(P.pickEntries([area('w1', 'awaiting'), area('orchestrator', 'busy')].reverse())), ['orchestrator', 'w1']);
  assert.deepStrictEqual(labels(P.pickEntries([area('orchestrator'), area('w1', 'exited')])), ['orchestrator']);
  assert.strictEqual(P.pickEntries([]).length, 0);
});

test('number keys: 0 is the orchestrator, 1-9 the Nth worker; wrap-around steps', () => {
  const e = P.pickEntries([area('orchestrator'), ...Array.from({ length: 11 }, (_, i) => area(`w${String(i + 1).padStart(2, '0')}`))]);
  assert.strictEqual(P.pickIndexForKey(e, '0'), 0);
  assert.strictEqual(P.pickIndexForKey(e, '1'), 1);
  assert.strictEqual(P.pickIndexForKey(e, '9'), 9);
  assert.strictEqual(P.pickKeyOf(e, 10), '', 'the 10th worker has no key');
  assert.strictEqual(P.pickIndexForKey(P.pickEntries([area('orchestrator'), area('w1')]), '5'), -1);
  assert.strictEqual(P.pickIndexForKey(P.pickEntries([area('w1'), area('w2')]), '0'), -1, 'no orchestrator: no 0');
  assert.strictEqual(P.pickIndexForKey(P.pickEntries([area('w1'), area('w2')]), '1'), 0);
  assert.strictEqual(P.pickStep(0, -1, 4), 3);
  assert.strictEqual(P.pickStep(3, 1, 4), 0);
});

// ---- the dialog itself ----

const BASE = docListeners.filter(l => l.capture).length; // the panel's own, from load
const keyHandlers = () => docListeners.filter(l => l.capture);
const key = (type, k, extra = {}) => {
  const ev = { key: k, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...extra };
  for (const l of keyHandlers().filter(l => l.type === type).slice()) l.fn(ev);
  return ev;
};
function open(areas, payload = { text: 'hello\nworld', images: [] }) {
  sent.length = 0;
  const composer = { cleared: 0, focused: 0, clear() { this.cleared++; }, focus() { this.focused++; } };
  const panel = Object.assign(Object.create(Panel.prototype), { allAreas: () => areas, composer });
  panel.openPicker(payload);
  return { panel, composer, modal: window.sdkPanel._pick.current().modal };
}
const selected = (modal) => modal.all('sdk-pick-item').filter(n => n.classList.contains('sel')).map(n => n.one('sdk-pick-name').textContent);
const tidy = () => { key('keydown', 'Escape'); assert.strictEqual(keyHandlers().length, BASE); };

test('submit + Enter sends to the orchestrator; the submitting Enter itself never does', () => {
  const { modal, composer } = open([area('orchestrator'), area('w1', 'busy'), area('w2', 'exited')]);
  assert.deepStrictEqual(selected(modal), ['orchestrator']);
  assert.deepStrictEqual(modal.all('sdk-pick-name').map(n => n.textContent), ['orchestrator', 'w1'], 'the ended one is not listed');
  key('keydown', 'Enter');
  assert.strictEqual(sent.length, 0, 'Enter before the first key-up is the submitting one');
  key('keyup', 'Enter');
  key('keydown', 'Enter', { repeat: true });
  assert.strictEqual(sent.length, 0, 'a held key does not send');
  const ev = key('keydown', 'Enter');
  assert.ok(ev.prevented);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sent)), [{ type: 'sdk:send', sessId: 'sess-orchestrator', text: 'hello\nworld', images: [] }]);
  assert.strictEqual(composer.cleared, 1);
  assert.strictEqual(window.sdkPanel._pick.current(), null);
  assert.strictEqual(keyHandlers().length, BASE);
  assert.strictEqual(composer.focused, 1);
});

test('ArrowDown / ArrowUp / Tab move the selection and wrap; a number key picks; Send follows', () => {
  const { modal } = open([area('orchestrator'), area('w1', 'awaiting'), area('w2', 'busy'), area('w3')]);
  key('keyup', 'Enter');
  key('keydown', 'ArrowDown');
  assert.deepStrictEqual(selected(modal), ['w1']);
  assert.match(modal.one('sdk-pick-send').textContent, /w1/);
  assert.ok(modal.one('sdk-pick-note').textContent.includes('w1 is busy'));
  key('keydown', 'Tab', { shiftKey: true });
  key('keydown', 'ArrowUp');
  assert.deepStrictEqual(selected(modal), ['w3'], 'wraps up from the orchestrator');
  key('keydown', 'Tab');
  assert.deepStrictEqual(selected(modal), ['orchestrator']);
  assert.strictEqual(modal.one('sdk-pick-note').textContent, '');
  key('keydown', '2');
  assert.deepStrictEqual(selected(modal), ['w2']);
  key('keydown', '9');
  assert.deepStrictEqual(selected(modal), ['w2'], 'no 9th worker: nothing moves');
  key('keydown', '0');
  assert.deepStrictEqual(selected(modal), ['orchestrator']);
  key('keydown', '3');
  key('keydown', 'Enter');
  assert.deepStrictEqual(sent.map(m => m.sessId), ['sess-w3']);
});

test('number key hints, click selects, double click sends, Esc cancels', () => {
  const { modal } = open([area('orchestrator'), area('w1'), area('w2')]);
  assert.deepStrictEqual(modal.all('sdk-pick-key').map(n => n.textContent), ['0', '1', '2']);
  const items = modal.all('sdk-pick-item');
  items[2].fire('click');
  assert.deepStrictEqual(selected(modal), ['w2']);
  assert.ok(items[2].scrolled > 0, 'scrolled into view');
  assert.strictEqual(sent.length, 0);
  items[1].fire('dblclick');
  assert.deepStrictEqual(sent.map(m => m.sessId), ['sess-w1']);
  open([area('orchestrator')]);
  const esc = key('keydown', 'Escape');
  assert.ok(esc.prevented);
  assert.strictEqual(window.sdkPanel._pick.current(), null);
  assert.strictEqual(sent.length, 0, 'Esc sends nothing');
});

test('entries show the one-line "now", state class, model; 1, 3 and 12 workers all list in one column', () => {
  for (const n of [0, 1, 3, 12]) {
    const ws = Array.from({ length: n }, (_, i) => area(`w${i + 1}`, i % 3 === 0 ? 'busy' : 'idle', { nowLine: i % 3 === 0 ? 'Bash: npm test' : '' }));
    const { modal } = open([area('orchestrator'), ...ws]);
    const list = modal.one('sdk-pick-list');
    assert.strictEqual(modal.all('sdk-pick-item').length, n + 1);
    assert.strictEqual(list ? list.children.length : 0, n, 'the workers sit in the scrolling list, the orchestrator above it');
    if (n) assert.ok(modal.all('sdk-pick-s-busy').length >= 1);
    if (n) assert.strictEqual(modal.all('sdk-pick-now')[0].textContent, 'Bash: npm test');
    assert.ok(modal.one('sdk-pick-meta').textContent.includes('sonnet-5-5'));
    assert.ok(modal.one('sdk-pick-title'), 'title, preview and actions are outside the scrolling list');
    assert.ok(modal.one('sdk-pick-preview') && modal.one('sdk-pick-actions'));
    tidy();
  }
});

test('no active orchestrator: the first worker is selected, no 0 key', () => {
  const { modal } = open([area('orchestrator', 'paused'), area('w1', 'busy'), area('w2')]);
  assert.deepStrictEqual(selected(modal), ['w1']);
  assert.deepStrictEqual(modal.all('sdk-pick-key').map(n => n.textContent), ['1', '2']);
  tidy();
});
