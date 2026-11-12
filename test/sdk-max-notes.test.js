// The Notes view's zoom and the live header of every zoom dialog
// (public/sdk-panel.js, openMax/closeMax/renderNotes/renderMaxHead):
//  - the Notes view has a ⤢ like Live's panes, and it opens the notes in the
//    same maximize dialog ("<label> · Notes"), the per-session composer below;
//  - the notes keep updating while maximized, closing puts the pane back, the
//    box going back to Live (or leaving the stage, or going away) closes it;
//  - the dialog's header carries one live line (state, "now", model, context,
//    cost) that follows the box's own caption, with no timer of its own.
//
//   node --test test/

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert');

// Just enough DOM: elements with children, classes, attributes, listeners.
class Node {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parent = null; this.attrs = {}; this.listeners = {}; this.className = ''; this.textContent = ''; this.title = ''; this.scrollTop = 0; this.dataset = {}; }
  querySelectorAll() { return []; }
  get classList() {
    const n = this;
    const list = () => n.className.split(' ').filter(Boolean);
    return {
      contains: (c) => list().includes(c),
      remove(c) { n.className = list().filter(x => x !== c).join(' '); },
      toggle(c, on) { const l = list().filter(x => x !== c); if (on ?? !list().includes(c)) l.push(c); n.className = l.join(' '); },
    };
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
  fire(type, ev = {}) { ev.stopPropagation ||= () => {}; ev.preventDefault ||= () => {}; for (const fn of this.listeners[type] || []) fn(ev); }
  appendChild(c) { c.remove(); c.parent = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach(c => this.appendChild(c)); }
  replaceChildren(...cs) { this.children.forEach(c => { c.parent = null; }); this.children = []; this.append(...cs); }
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
    assert.match(html, /sdk-max-live/, 'the dialog has a place for the live line');
    const mk = (cls, kids = []) => { const n = new Node('div'); n.className = cls; n.append(...kids); return n; };
    this.children = [];
    this.appendChild(mk('curl-modal sdk-max', [mk('curl-modal-header', [mk('sdk-max-title'), mk('sdk-max-live'), mk('curl-modal-close')]), mk('sdk-max-body')]));
  }
}
class Composer extends Node {
  constructor() { super('vc-composer'); this.className = 'vc-composer'; this.disabled = false; }
  clear() {}
  attachDropTarget() {}
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

const dashboard = {
  sendWs() {}, state: {}, escHtml: String, registerModule() {}, _tabHooks: { onChange() {} }, isPhone: () => false,
  renderMarkdown(text, node) { node.rendered = text; }, renderMarkdownDebounced() {}, cancelRenderDebounce() {},
};
const window = { dashboard, sdkActivity: require('../public/sdk-activity.js') };
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sdk-panel.js'), 'utf8');
vm.runInContext(src, vm.createContext({ window, document: doc, console, setTimeout, clearTimeout }));
const { _max: M, _Area: Area } = window.sdkPanel;

// A box as far as these methods look at it: the real prototype, fake parts.
function makeArea(over = {}) {
  const area = Object.create(Area.prototype);
  const box = new Node('div');
  const notesPane = new Node('div');
  notesPane.className = 'sdk-view sdk-view-notes';
  const notesEl = new Node('div');
  notesEl.className = 'sdk-notes-body markdown-body';
  notesPane.appendChild(notesEl);
  box.appendChild(notesPane);
  const ctxEl = new Node('span'); ctxEl.className = 'sdk-ctx hidden';
  Object.assign(area, {
    sessId: 'sess-w1', label: 'w1', view: 'notes', state: 'idle', closed: false, model: 'claude-opus-5-5',
    notesPane, notesEl, ctxEl, ctxTxt: new Node('span'), costEl: new Node('span'), modelBtn: new Node('button'), nowEl: new Node('div'),
    act: window.sdkActivity.createActivity(), todo: { rows: [], notes: '' },
    feedFollow: { settle() {} }, todoFollow: { settle() {} },
    stop() {}, ...over,
  });
  return { area, box, notesPane, notesEl };
}
const head = () => M.current().head;
const text = (n) => (n.classList.contains('hidden') ? '' : n.textContent);

test('Notes has a ⤢ that opens its pane in the maximize dialog', () => {
  // The Notes view's markup: the scroller and the button beside it, wired to openMax.
  const tpl = src.match(/<div class="sdk-view sdk-view-notes">([\s\S]*?)<\/div>\s*<\/div>`;/)?.[1] || '';
  assert.match(tpl, /sdk-notes-body/);
  assert.match(tpl, /<button type="button" class="sdk-max-btn" title="Maximize">⤢<\/button>/);
  assert.match(src, /q\('\.sdk-view-notes > \.sdk-max-btn'\)\.addEventListener\('click', \(\) => openMax\(this, this\.notesPane, 'Notes'\)\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'sdk-panel.css'), 'utf8'), /\.sdk-view-live, \.sdk-view-notes \{ --sdk-max-size: 30px; \}/, 'also the finger-sized one');

  const { area, box, notesPane, notesEl } = makeArea();
  area.todo = { rows: [], notes: '# Notes\ntext' };
  area.renderNotes({ scroll: true });
  assert.strictEqual(notesEl.rendered, '# Notes\ntext');

  M.openMax(area, notesPane, 'Notes');
  const { overlay } = M.current();
  const dialog = overlay.querySelector('.sdk-max');
  assert.ok(overlay.isConnected);
  assert.strictEqual(overlay.querySelector('.sdk-max-title').textContent, 'w1 · Notes');
  assert.strictEqual(dialog.getAttribute('aria-label'), 'w1 · Notes');
  assert.strictEqual(dialog.querySelector('.sdk-max-body').children[0], notesPane, 'the notes are in the dialog');
  assert.ok(dialog.querySelector('.vc-composer'), 'the per-session composer is there');
  assert.ok(!box.children.includes(notesPane) && box.children[0].tagName === '#COMMENT'.toUpperCase(), 'a comment holds its place');

  M.closeMax();
  assert.strictEqual(M.current(), null);
  assert.ok(!overlay.isConnected);
  assert.strictEqual(box.children[0], notesPane, 'back in its box');
});

test('the notes keep updating while maximized, even with the box on Live; a reader\'s place is kept', () => {
  const { area, notesPane, notesEl } = makeArea();
  area.todo = { rows: [], notes: 'one' };
  area.renderNotes();
  notesEl.scrollTop = 120;
  M.openMax(area, notesPane, 'Notes');
  assert.strictEqual(notesEl.scrollTop, 120);
  area.view = 'live'; // the box's own view is not Notes now
  area.todo = { rows: [], notes: 'two' };
  area.renderNotes({ scroll: true });
  assert.strictEqual(notesEl.rendered, 'two', 'the update is drawn into the pane in the dialog');
  assert.strictEqual(notesEl.parent.parent.className, 'sdk-max-body');
  M.closeMax();
  area.todo = { rows: [], notes: 'three' };
  area.renderNotes();
  assert.strictEqual(notesEl.rendered, 'two', 'closed and not showing: nothing drawn');
});

test('the box going back to Live, leaving the stage or going away closes the maximized notes', () => {
  const live = (a) => a.setView.call(a, 'live', { store: false });
  let { area, box, notesPane } = makeArea();
  area.segBtns = { live: new Node('button'), notes: new Node('button') };
  area.el = new Node('div');
  area.renderTodo = () => {};
  M.openMax(area, notesPane, 'Notes');
  live(area);
  assert.strictEqual(M.current(), null);
  assert.strictEqual(box.children[0], notesPane);

  ({ area, box, notesPane } = makeArea());
  area.shown = true; area._releaseTimer = null;
  M.openMax(area, notesPane, 'Notes');
  area.setShown(false);
  assert.strictEqual(M.current(), null);
  assert.strictEqual(box.children[0], notesPane);
  clearTimeout(area._releaseTimer);

  // A pane of Live stays open when the view button is pressed elsewhere.
  ({ area, box, notesPane } = makeArea());
  const lite = new Node('div'); box.appendChild(lite);
  area.segBtns = { live: new Node('button'), notes: new Node('button') }; area.el = new Node('div'); area.renderTodo = () => {};
  M.openMax(area, lite, 'Live feed');
  live(area);
  assert.ok(M.current());
  M.closeMax();
});

test('the dialog header shows state and "now", and follows the box\'s own redraws', () => {
  const { area, notesPane } = makeArea();
  M.openMax(area, notesPane, 'Notes');
  const h = head();
  assert.ok(h, 'a header line exists');
  assert.strictEqual(h.state.textContent, 'idle');
  assert.match(h.root.className, /sdk-max-st-idle/);
  assert.strictEqual(text(h.now), '', 'idle: nothing running, no "now" text');

  area.state = 'busy';
  area.act.toolStart('t1', 'Bash', Date.now());
  area.act.toolInput('t1', { description: 'run the tests', gist: 'npm test' });
  area.renderNow();                       // what renderHeader does at its end
  assert.strictEqual(h.state.textContent, 'busy');
  assert.match(h.root.className, /sdk-max-st-busy/, 'busy: the dot pulses (CSS on this class)');
  assert.match(text(h.now), /Bash · run the tests/);

  area.act.toolDone('t1');
  area.renderNow();
  assert.strictEqual(text(h.now), 'thinking…');

  area.state = 'awaiting';
  area.renderNow();
  assert.strictEqual(h.state.textContent, 'awaiting');
  assert.strictEqual(text(h.now), 'waiting for your answer');

  area.state = 'exited';
  area.renderNow();
  assert.strictEqual(h.state.textContent, 'ended');
  assert.match(h.root.className, /sdk-max-st-ended/);
  assert.strictEqual(text(h.now), '');
  M.closeMax();
});

test('model, context and cost show when the box has them, and drop out when it does not', () => {
  const { area, notesPane } = makeArea();
  M.openMax(area, notesPane, 'Notes');
  const h = head();
  assert.strictEqual(text(h.model), 'opus-5-5');
  assert.strictEqual(text(h.ctx), '');
  assert.strictEqual(text(h.cost), '');
  area.ctxEl.className = 'sdk-ctx warm';
  area.ctxTxt.textContent = '42%';
  area.cost = 1.234;
  area.actualModel = 'claude-sonnet-5-5';
  area.renderNow();
  assert.strictEqual(text(h.ctx), 'ctx 42%');
  assert.ok(h.ctx.classList.contains('warm'));
  assert.strictEqual(text(h.cost), '$1.23');
  assert.strictEqual(text(h.model), 'sonnet-5-5');
  M.closeMax();
  area.renderNow(); // closed: nothing to update, nothing breaks
});

test('every dialog has it (Live panes too), and nothing polls', () => {
  const { area, box } = makeArea({ state: 'busy' });
  const lite = new Node('div'); lite.className = 'sdk-todo-lite'; box.appendChild(lite);
  M.openMax(area, lite, 'Live feed');
  assert.strictEqual(head().state.textContent, 'busy', 'drawn on open, from the box\'s state');
  M.closeMax();
  // The header is redrawn by renderNow, which the caption's redraws and the
  // existing tick call; it brings no timer of its own.
  const maxSrc = src.slice(src.indexOf('renderMaxHead() {'), src.indexOf('// ---- TODO.md / NOTES.md ----'));
  assert.doesNotMatch(maxSrc, /setInterval|setTimeout|requestAnimationFrame/);
});
