// "Close and remove interaction" on an ORCHESTRATOR tab deletes the whole run
// through the run card's own delete (orchestration.deleteRun), after one
// confirm naming the run and its workers. Client: public/cli.js closeTab in a
// fake DOM; server: the real cli-handler with a stub orchestration.
//
//   node --test test/

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-runtab-')));
process.env.VISTACLAIR_HOME = HOME;
process.env.HOME = HOME;
process.env.VISTACLAIR_DASHBOARD_PORT = '';

const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const WebSocket = require('ws');
const { makeDom, loadPublic } = require('./desks-fake-dom');
const CliSessionManager = require('../src/cli-sessions');
const { handleMessage } = require('../src/ws/cli-handler');

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

// ---- client ----
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
  let answer = true;
  const toasts = [];
  const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hooks = { onChange() {}, actionsFor: () => [], runAction() {} };
  const dashboard = {
    sendWs: (m) => sent.push(m), state: {}, escHtml, askFormBuildHTML() {}, askFormBind() {}, showAlert() {},
    showToast: (m) => toasts.push(m),
    showConfirm: async (text, opts) => { confirms.push({ text, opts }); return answer; },
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
  return { cli, sessions, sent, confirms, toasts, html, click, setConfirm: (v) => { answer = v; } };
}


const ORCH = { role: 'orchestrator', runId: 'r1' };
function openTab(t, tabId, settings) {
  t.cli.handleMessage({ type: 'cli:newTab', tabId });
  t.cli.tabs.get(tabId).settings = settings;
  t.sent.length = 0;
}
const removeItem = (t, tabId) => t.cli.cliMenuItems(tabId).find(i => i.label === 'Close and remove interaction');
const closeItem = (t, tabId) => t.cli.cliMenuItems(tabId).find(i => i.label === 'Close');
const tick = () => new Promise(r => setImmediate(r));
const json = (a) => JSON.parse(JSON.stringify(a));

test('client: orchestrator tab, Close and remove interaction asks naming the run and its workers, then deletes the run', async () => {
  const t = setup();
  t.cli.handleMessage({ type: 'cli:savedSessions', sessions: [], runs: [{ runId: 'r1', title: 'Fix login', status: 'running', workers: { total: 3, running: 0, list: [] } }] });
  openTab(t, 'tab-1', { orchestration: ORCH });
  removeItem(t, 'tab-1').onClick();
  await tick();
  assert.strictEqual(t.confirms.length, 1);
  assert.match(t.confirms[0].text, /run r1/);
  assert.match(t.confirms[0].text, /Fix login/);
  assert.match(t.confirms[0].text, /3 workers/);
  assert.strictEqual(t.confirms[0].opts.danger, true);
  assert.deepStrictEqual(json(t.sent), [{ type: 'cli:closeTab', tabId: 'tab-1', forget: true, deleteRun: true }]);
});

test('client: cancel sends nothing and keeps the tab', async () => {
  const t = setup();
  openTab(t, 'tab-1', { orchestration: ORCH });
  t.setConfirm(false);
  removeItem(t, 'tab-1').onClick();
  await tick();
  assert.strictEqual(t.confirms.length, 1);
  assert.deepStrictEqual(t.sent, []);
  assert.ok(t.cli.tabs.has('tab-1'));
});

test('client: plain Close, and a worker or plain tab, are unchanged (no run confirm)', async () => {
  const t = setup();
  openTab(t, 'tab-o', { orchestration: ORCH });
  closeItem(t, 'tab-o').onClick();
  assert.deepStrictEqual(json(t.sent), [{ type: 'cli:closeTab', tabId: 'tab-o', forget: false }]);
  openTab(t, 'tab-w', { orchestration: { role: 'worker', runId: 'r1', workerId: 'w1' } });
  removeItem(t, 'tab-w').onClick();
  assert.deepStrictEqual(json(t.sent), [{ type: 'cli:closeTab', tabId: 'tab-w', forget: true }]);
  openTab(t, 'tab-p', {});
  removeItem(t, 'tab-p').onClick();
  assert.deepStrictEqual(json(t.sent), [{ type: 'cli:closeTab', tabId: 'tab-p', forget: true }]);
  await tick();
  assert.strictEqual(t.confirms.length, 0);
});

test('client: a refused run delete (busy member, dirty worktree) is shown and asked again with force', async () => {
  const t = setup();
  t.cli.handleMessage({ type: 'cli:actionResult', action: 'deleteRun', runId: 'r1', refused: true, busy: [{ title: 'w1 builder' }], dirty: [{ worker: 'w2', path: '/wt/w2' }] });
  await tick();
  assert.strictEqual(t.confirms.length, 1);
  assert.match(t.confirms[0].text, /w1 builder/);
  assert.match(t.confirms[0].text, /\/wt\/w2/);
  assert.deepStrictEqual(json(t.sent), [{ type: 'cli:deleteRun', runId: 'r1', force: true }]);
});

// ---- server ----
function serverSetup(orchestration) {
  const broadcasts = [];
  const mgr = new CliSessionManager(1, { broadcast: (m) => broadcasts.push(m) }, { deleteSessionData() {} });
  const cwd = path.join(HOME, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  for (const h of mgr.listSaved()) mgr.forgetSaved(h.id);
  mgr.saveToHistory({ sessId: 'o', cwd, title: 't-o', settings: { orchestration: ORCH } });
  mgr.sessions.set('tab-1', { sessId: 'o', cwd, title: 't-o', running: true, getSettings: () => ({ orchestration: ORCH }), kill() {}, instanceId: 'cli-tab-1' });
  const sent = [];
  const ws = { readyState: WebSocket.OPEN, send: (d) => sent.push(JSON.parse(d)) };
  const bc = { cliSessionManager: mgr, broadcast: (m) => broadcasts.push(m), orchestration };
  return { mgr, sent, call: (msg) => handleMessage(ws, msg, bc), listed: () => mgr.listSaved().map(h => h.id) };
}

test('server: a confirmed Close and remove interaction on an orchestrator deletes the run through orchestration.deleteRun', () => {
  const calls = [];
  const t = serverSetup({ closeCheck: () => ({ ok: false, reason: 'workers running' }), deleteRun: (runId, o) => { calls.push([runId, o]); return { deleted: 4, keptBranches: [] }; } });
  t.call({ type: 'cli:closeTab', tabId: 'tab-1', forget: true, deleteRun: true });
  assert.deepStrictEqual(calls, [['r1', { force: false }]]);
  const res = t.sent.find(m => m.type === 'cli:actionResult');
  assert.strictEqual(res.action, 'deleteRun');
  assert.strictEqual(res.deleted, 4);
  assert.ok(!t.sent.some(m => m.type === 'cli:closeRefused'));
  assert.ok(t.sent.some(m => m.type === 'cli:savedSessions'), 'the requester gets the new list');
});

test('server: the run delete\'s refusal reaches the requester; force passes through', () => {
  const calls = [];
  const t = serverSetup({ deleteRun: (runId, o) => { calls.push(o); return o.force ? { deleted: 1 } : { refused: true, busy: [{ title: 'w1' }], dirty: [] }; } });
  t.call({ type: 'cli:closeTab', tabId: 'tab-1', forget: true, deleteRun: true });
  const res = t.sent.find(m => m.type === 'cli:actionResult');
  assert.strictEqual(res.refused, true);
  assert.strictEqual(res.runId, 'r1');
  t.call({ type: 'cli:closeTab', tabId: 'tab-1', forget: true, deleteRun: true, force: true });
  assert.deepStrictEqual(calls, [{ force: false }, { force: true }]);
});

test('server: without the confirmed flag an orchestrator is still refused and nothing is deleted', () => {
  const t = serverSetup({ closeCheck: () => ({ ok: true }), deleteRun() { throw new Error('must not run'); } });
  t.call({ type: 'cli:closeTab', tabId: 'tab-1', forget: true });
  assert.deepStrictEqual(t.listed(), ['o']);
  assert.match(t.sent.find(m => m.type === 'cli:actionResult')?.error || '', /Delete run/);
});
