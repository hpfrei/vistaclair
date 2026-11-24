// The Sessions tab's multiselect (public/cli.js renderSessions) run in a fake
// DOM with the real session-cards.js: every card that has "Delete permanently"
// carries a Select checkbox (a run card too, unless its orchestrator runs), the
// toolbar has Select all, and Remove selected (N) sends one batch message with
// the session ids and the run ids after one confirm.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { makeDom, loadPublic } = require('./desks-fake-dom');

function setup({ timers } = {}) {
  const dom = makeDom();
  const d = dom.doc;
  const el = (id, cls = '') => { const e = d.createElement('div'); e.id = id; e.className = cls; d.body.appendChild(e); return e; };
  el('cliTabStrip', 'view-nav');
  const plus = d.createElement('button'); plus.id = 'cliTabNew'; d.body.appendChild(plus);
  const container = el('cliContainer', 'cli-container');
  const sessions = d.createElement('div'); sessions.id = 'cliSessions'; container.appendChild(sessions);
  const sent = [];
  const confirms = [];
  const toasts = [];
  const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hooks = { onChange() {}, actionsFor: () => [], runAction() {} };
  const dashboard = {
    sendWs: (m) => sent.push(m), state: {}, escHtml, askFormBuildHTML() {}, askFormBind() {}, showAlert() {},
    showToast: (m) => toasts.push(m),
    showConfirm: async (text, opts) => { confirms.push({ text, opts }); return true; },
    _tabHooks: hooks, _tabBadgeEl: () => null, registerModule() {}, isPhone: () => false,
  };
  const { window } = loadPublic(['tab-context-menu.js', 'desk-layout.js', 'tab-host.js', 'session-cards.js'], {
    doc: d,
    window: { dashboard, sdkPanel: { mount() {}, unmount() {}, update() {}, setShown() {}, focus() {}, setActive() {}, isBusy: () => false, onTabs() {} }, tabHookInfo: (tabId) => ({ tabId }) },
  });
  class Terminal { constructor() { this.cols = 80; this.rows = 24; } loadAddon() {} open() {} attachCustomKeyEventHandler() {} onData() {} onResize() {} onScroll() {} focus() {} dispose() {} write() {} reset() {} clear() {} }
  const ctx = vm.createContext(Object.assign(Object.create(null), {
    window, document: d, console, setTimeout: timers ? timers.set : (fn) => { fn(); return 0; }, clearTimeout: timers ? timers.clear : () => {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: (fn) => fn(),
    ResizeObserver: class { observe() {} disconnect() {} },
    Terminal, FitAddon: { FitAddon: class { fit() {} } }, WebLinksAddon: { WebLinksAddon: class {} },
    sessionStorage: { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = v; } },
    localStorage: window.localStorage, switchView: () => {}, navigator: {},
  }));
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'cli.js'), 'utf8'), ctx, { filename: 'cli.js' });
  const cli = window.cliModule;
  const html = () => sessions.innerHTML;
  // A click on the control with this data-act (and data-id / data-sess): the
  // view's one delegated listener reads closest('[data-act]').
  const click = (dataset, checked) => sessions.dispatch('click', { target: { closest: () => ({ dataset, checked, disabled: false }) } });
  return { cli, sessions, sent, confirms, toasts, html, click };
}

const plain = (id, extra = {}) => ({ id, cwd: `/p/${id}`, title: id, savedAt: 1, settings: {}, kind: 'cli', ...extra });
const run = (runId, extra = {}) => ({
  runId, title: `run ${runId}`, status: 'paused', cwd: `/p/${runId}`, orchestratorRunning: false, runMissing: false,
  workers: { total: 0, running: 0, list: [] }, todo: null, lastActivityAt: 1, ...extra,
});
const saved = (sessions, runs) => ({ type: 'cli:savedSessions', sessions, runs });
const checkboxes = (html) => [...html.matchAll(/<input type="checkbox" data-act="(sel-sess|sel-run|sel-all)"([^>]*)>/g)].map(m => ({ act: m[1], rest: m[2] }));

test('every card with Delete permanently has a Select checkbox, runs included, and the toolbar has Select all', () => {
  const t = setup();
  t.cli.handleMessage(saved(
    [plain('s1'), plain('s2'), plain('live', { isRunning: true })],
    [run('r1'), run('r2'), run('r3', { orchestratorRunning: true })],
  ));
  const boxes = checkboxes(t.html());
  assert.strictEqual(boxes.filter(b => b.act === 'sel-sess').length, 2, 'two idle sessions; the running one has no Delete');
  assert.strictEqual(boxes.filter(b => b.act === 'sel-run').length, 2, 'two runs without a running orchestrator');
  assert.strictEqual(boxes.filter(b => b.act === 'sel-all').length, 1);
  assert.strictEqual((t.html().match(/Delete permanently/g) || []).length, 4, 'a checkbox for each Delete permanently');
});

test('a lone run card is selectable too (the owner had runs only)', () => {
  const t = setup();
  t.cli.handleMessage(saved([], [run('r1')]));
  assert.deepStrictEqual(checkboxes(t.html()).map(b => b.act).sort(), ['sel-all', 'sel-run']);
});

test('Select all, then Remove selected: one confirm, one batch with session and run ids', async () => {
  const t = setup();
  t.cli.handleMessage(saved([plain('s1'), plain('s2')], [run('r1'), run('r3', { orchestratorRunning: true })]));
  assert.ok(!t.html().includes('Remove selected'), 'no button before anything is selected');
  t.click({ act: 'sel-all' }, true);
  assert.ok(t.html().includes('Remove selected (3)'));
  await t.click({ act: 'delete-selected' });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(t.confirms.length, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(t.sent.filter(m => m.type === 'cli:deleteSavedSessions'))), [{ type: 'cli:deleteSavedSessions', ids: ['s1', 's2'], runIds: ['r1'] }]);
});

test('the selection keeps ids still listed and drops ones that vanished', () => {
  const t = setup();
  t.cli.handleMessage(saved([plain('s1'), plain('s2')], [run('r1'), run('r2')]));
  t.click({ act: 'sel-sess', id: 's1' }, true);
  t.click({ act: 'sel-sess', id: 's2' }, true);
  t.click({ act: 'sel-run', id: 'r1' }, true);
  t.click({ act: 'sel-run', id: 'r2' }, true);
  assert.ok(t.html().includes('Remove selected (4)'));
  t.cli.handleMessage(saved([plain('s2')], [run('r2')]));
  assert.ok(t.html().includes('Remove selected (2)'), 's1 and r1 dropped, s2 and r2 kept');
});

// The busy indicator of Remove selected: module state, so it survives the
// re-renders the list answers and tab changes cause; it ends on the server's
// Done (a toast on error) or on a safety timeout that asks for the list again.
function busySetup() {
  const queue = [];
  const timers = { set: (fn, ms) => { queue.push({ fn, ms }); return queue.length; }, clear: (id) => { if (queue[id - 1]) queue[id - 1].fn = null; } };
  const t = setup({ timers });
  t.queue = queue;
  t.cli.handleMessage(saved([plain('s1'), plain('s2')], [run('r1')]));
  t.click({ act: 'sel-all' }, true);
  return t;
}
const startRemove = async (t) => { await t.click({ act: 'delete-selected' }); await new Promise(r => setImmediate(r)); };

test('Remove selected goes busy after the confirm: disabled, "Removing N…" with a spinner, boxes disabled', async () => {
  const t = busySetup();
  assert.ok(t.html().includes('Remove selected (3)'));
  await startRemove(t);
  assert.ok(t.html().includes('Removing 3…'));
  assert.ok(t.html().includes('class="sc-spin"'));
  assert.ok(/<button[^>]*data-act="delete-selected" disabled/.test(t.html()), 'the button is disabled');
  assert.ok(!t.html().includes('Remove selected (3)'));
  assert.strictEqual(checkboxes(t.html()).filter(b => b.act !== 'sel-all' && /disabled/.test(b.rest)).length, 3, 'the cards being removed cannot be toggled');
});

test('the busy state survives the list pushes that re-render the tab', async () => {
  const t = busySetup();
  await startRemove(t);
  t.cli.handleMessage(saved([plain('s1'), plain('s2')], [run('r1')]));
  assert.ok(t.html().includes('Removing 3…'));
  // A second click while busy sends nothing more.
  await t.click({ act: 'delete-selected' });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(t.sent.filter(m => m.type === 'cli:deleteSavedSessions').length, 1);
  assert.strictEqual(t.confirms.length, 1);
});

test('the server Done clears the busy state', async () => {
  const t = busySetup();
  await startRemove(t);
  t.cli.handleMessage(saved([], []));
  t.cli.handleMessage({ type: 'cli:deleteSavedSessionsDone', ok: true, deleted: 3, skipped: 0 });
  assert.ok(!t.html().includes('Removing'));
  assert.ok(!t.html().includes('sc-spin'));
  assert.strictEqual(t.toasts.length, 0);
});

test('a Done with an error clears the busy state and toasts the error', async () => {
  const t = busySetup();
  await startRemove(t);
  t.cli.handleMessage({ type: 'cli:deleteSavedSessionsDone', ok: false, error: 'disk gone', deleted: 0, skipped: 3 });
  assert.ok(!t.html().includes('Removing'));
  assert.ok(t.html().includes('Remove selected (3)'), 'the selection is still there to retry');
  assert.strictEqual(t.toasts.length, 1);
  assert.strictEqual(t.toasts[0].level, 'error');
  assert.ok(t.toasts[0].message.includes('disk gone'));
});

test('with no answer, the 60 s safety timeout clears the button and asks for the list again', async () => {
  const t = busySetup();
  await startRemove(t);
  const safety = t.queue.find(q => q.ms === 60000 && q.fn);
  assert.ok(safety, 'a 60 s timer was armed');
  t.sent.length = 0;
  safety.fn();
  assert.ok(!t.html().includes('Removing'));
  for (const q of t.queue) if (q.fn && q.ms === 0) q.fn();   // requestSavedSessions(0)
  assert.ok(t.sent.some(m => m.type === 'cli:getSavedSessions'), 'the list is requested again');
});

test('Close and remove interaction: the server\'s pushed list drops the session\'s card', () => {
  const t = setup();
  t.cli.handleMessage(saved([plain('s1'), plain('s2')], []));
  assert.ok(t.html().includes('data-id="s1"') || t.html().includes('s1'), 's1 is listed');
  const before = (t.html().match(/Delete permanently/g) || []).length;
  // The server answered the close with the list without s1.
  t.cli.handleMessage(saved([plain('s2')], []));
  assert.strictEqual((t.html().match(/Delete permanently/g) || []).length, before - 1, 'one card fewer');
  assert.ok(!t.html().includes('/p/s1'), 's1\'s card is gone');
  assert.ok(t.html().includes('/p/s2'));
});
