// The CLIs strip on TabHost (public/cli.js, run in a fake DOM with stub
// xterm and SDK panel) together with Desks (public/desks.js): the tab list
// from the server builds one TabHost tab per CLI keyed by its session name
// (else sessId), the Sessions tab hides only home tabs, a tab on a desk
// keeps running in its window, its own close turns the window into a
// placeholder, and a server restart (new bootId) re-mounts it in place.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const { makeDom, loadPublic } = require('./desks-fake-dom');

function setup() {
  const dom = makeDom();
  const d = dom.doc;
  const el = (id, cls = '') => { const e = d.createElement('div'); e.id = id; e.className = cls; d.body.appendChild(e); return e; };
  const strip = el('cliTabStrip', 'view-nav');
  const plus = d.createElement('button'); plus.id = 'cliTabNew'; strip.appendChild(plus);
  const container = el('cliContainer', 'cli-container');
  const sessions = d.createElement('div'); sessions.id = 'cliSessions'; container.appendChild(sessions);
  const cliHeader = el('hdr-claude', 'header-tab'); cliHeader.dataset.view = 'claude';
  const desksHeader = el('hdr-desks', 'header-tab'); desksHeader.dataset.view = 'desks';
  const desksEls = { strip: el('desksTabStrip'), area: el('desksArea'), taskbar: el('desksTaskbar'), headerTab: desksHeader };
  const busyTabs = new Set();

  const sent = [];
  const sdkCalls = [];
  const fits = [];
  class Terminal {
    constructor() { this.cols = 80; this.rows = 24; this.disposed = false; }
    loadAddon() {} open() {} attachCustomKeyEventHandler() {} onData() {} onResize() {} onScroll() {}
    focus() {} dispose() { this.disposed = true; } write() {} reset() {} clear() {}
  }
  const hooks = { onChange() {}, actionsFor: () => [], runAction() {} };
  const dashboard = {
    sendWs: (m) => sent.push(m), state: {}, escHtml: String, askFormBuildHTML() {}, askFormBind() {}, showAlert() {}, showConfirm: async () => true,
    _tabHooks: hooks, _tabBadgeEl: () => null, registerModule() {}, isPhone: () => false, showToast() {},
  };
  const { window } = loadPublic(['tab-context-menu.js', 'desk-layout.js', 'tab-host.js', 'desks.js'], {
    doc: d,
    window: {
      dashboard,
      sessionCards: new Proxy({}, { get: () => () => '' }),
      sdkPanel: {
        mount: (id) => sdkCalls.push(['mount', id]), unmount: (id) => sdkCalls.push(['unmount', id]), update() {},
        setShown: (id, v) => sdkCalls.push(['shown', id, v]), focus() {}, setActive: (id) => sdkCalls.push(['setActive', id]),
        isBusy: (id) => busyTabs.has(id), onTabs() {},
      },
      tabHookInfo: (tabId) => ({ tabId }),
    },
  });
  // cli.js runs in the same context: give it its globals.
  const vm = require('vm');
  const fs = require('fs');
  const path = require('path');
  const ctx = vm.createContext(Object.assign(Object.create(null), {
    window, document: d, console, setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: (fn) => fn(),
    ResizeObserver: class { observe() {} disconnect() {} },
    Terminal, FitAddon: { FitAddon: class { fit() { fits.push(1); } } }, WebLinksAddon: { WebLinksAddon: class {} },
    sessionStorage: { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = v; } },
    localStorage: window.localStorage, switchView: () => {}, navigator: {},
  }));
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'cli.js'), 'utf8'), ctx, { filename: 'cli.js' });
  const cli = window.cliModule;
  const desks = window.createDesks({ send: (m) => sent.push(m), toast() {}, isPhone: () => false, switchView() {}, elements: desksEls });
  const tabList = (tabs, bootId = 'boot1') => cli.handleMessage({ type: 'cli:tabs', bootId, tabs });
  const T = (n, extra = {}) => ({ tabId: `tab-boot-${n}`, status: 'running', cwd: '/x', title: `t${n}`, sessId: `sess-${n}`, settings: {}, ...extra });
  const buttons = () => strip.querySelectorAll('.view-tab[data-tab-key]');
  return { cliHeader, desksHeader, busyTabs, dom, window, cli, desks, desksEls, strip, container, sessions, sent, sdkCalls, tabList, T, buttons, fits };
}

test('the server tab list becomes TabHost tabs keyed by name, else sessId; the Sessions tab stays first', () => {
  const t = setup();
  t.tabList([t.T(1, { settings: { name: 'orch-abc' } }), t.T(2)]);
  const host = t.cli.tabHost;
  assert.deepStrictEqual(Array.from(host.keys()), ['orch-abc', 'sess-2']);
  assert.deepStrictEqual(t.buttons().map(b => b.dataset.tabId), ['tab-boot-1', 'tab-boot-2']);
  assert.ok(t.strip.children[0].classList.contains('cli-sessions-tab'));
  assert.strictEqual(host.activeKey(), 'orch-abc', 'the first tab is shown');
  const w1 = t.cli.tabs.get('tab-boot-1').wrap;
  assert.strictEqual(w1.parentNode, t.container);
  assert.strictEqual(w1.style.display, '');
  assert.strictEqual(t.cli.tabs.get('tab-boot-2').wrap.style.display, 'none');
});

test('a tab first seen without a session gets a temporary key, then its real one', () => {
  const t = setup();
  t.cli.handleMessage({ type: 'cli:opened', tabId: 'tab-boot-9', engine: 'cli' });
  assert.deepStrictEqual(Array.from(t.cli.tabHost.keys()), ['tab:tab-boot-9']);
  assert.strictEqual(t.cli.tabHost.menuItems('tab:tab-boot-9').some(i => i.label === 'Move to desk'), false, 'not movable yet');
  t.tabList([t.T(9, { settings: { name: 'named' } })]);
  assert.deepStrictEqual(Array.from(t.cli.tabHost.keys()), ['named']);
});

test('on a desk: runs in its window, Sessions and switching tabs leave it alone, its close leaves a placeholder', () => {
  const t = setup();
  t.desks.applyState({ version: 1, desks: [] });
  t.tabList([t.T(1, { settings: { name: 'a' } }), t.T(2, { settings: { name: 'b' } })]);
  const wrapA = t.cli.tabs.get('tab-boot-1').wrap;
  // The right-click menu: desks first, then the × menu's actions.
  const items = t.cli.tabHost.menuItems('a');
  assert.deepStrictEqual(Array.from(items, i => i.label || '—'), ['Move to desk', '—', 'Close', 'Close and remove interaction']);
  t.desks.applyState({ version: 1, desks: [{ id: 'd1', name: 'Work', windows: [{ kind: 'cli', key: 'a', title: 'a', geom: { x: 0, y: 0, w: 0.5, h: 0.5 }, z: 1 }] }] });
  const body = t.desksEls.area.querySelector('.desk-win-body');
  assert.strictEqual(wrapA.parentNode, body, 'moved into the window');
  assert.strictEqual(t.cli.tabHost.activeKey(), 'b', 'the strip shows the next tab');
  assert.strictEqual(t.cli.tabs.get('tab-boot-2').wrap.style.display, '');

  t.strip.children[0].click();   // Sessions
  assert.strictEqual(t.sessions.style.display, '');
  assert.strictEqual(wrapA.style.display, '', 'the desk window keeps showing it');
  assert.strictEqual(t.cli.tabs.get('tab-boot-2').wrap.style.display, 'none');
  assert.ok(t.cli.tabHost.isShown('a'));

  // switchTab to a tab on a desk goes to its window, the strip stays as is.
  t.cli.switchTab('tab-boot-1');
  assert.strictEqual(wrapA.parentNode, body);
  assert.strictEqual(t.sessions.style.display, '');

  // Its own close: the terminal goes, the window becomes a placeholder.
  t.cli.handleMessage({ type: 'cli:tabs', bootId: 'boot1', tabs: [t.T(2, { settings: { name: 'b' } })] });
  assert.ok(!t.cli.tabs.has('tab-boot-1'));
  t.desks.render();
  const win = t.desksEls.area.querySelector('.desk-win');
  assert.ok(win.classList.contains('desk-win-placeholder'));
  assert.strictEqual(t.desks.state().desks[0].windows.length, 1, 'the entry stays');
});

test('a server restart (new bootId) re-mounts a desk tab in its window', () => {
  const t = setup();
  t.desks.applyState({ version: 1, desks: [{ id: 'd1', name: 'Work', windows: [{ kind: 'cli', key: 'a', title: 'a', geom: { x: 0, y: 0, w: 0.5, h: 0.5 }, z: 1 }] }] });
  t.tabList([t.T(1, { settings: { name: 'a' } })], 'boot1');
  const old = t.cli.tabs.get('tab-boot-1');
  assert.strictEqual(old.wrap.parentNode, t.desksEls.area.querySelector('.desk-win-body'));
  t.tabList([{ ...t.T(1, { settings: { name: 'a' } }), tabId: 'tab-boot2-1' }], 'boot2');
  assert.ok(old.terminal.disposed, 'the old terminal is released');
  const fresh = t.cli.tabs.get('tab-boot2-1');
  assert.strictEqual(fresh.wrap.parentNode, t.desksEls.area.querySelector('.desk-win-body'), 'the new one is in the same window');
  assert.ok(!t.desksEls.area.querySelector('.desk-win').classList.contains('desk-win-placeholder'));
});

test('an SDK tab is told when it is shown, at home or on a desk (never via the one-active setActive)', () => {
  const t = setup();
  t.desks.applyState({ version: 1, desks: [{ id: 'd1', name: 'Work', windows: [{ kind: 'cli', key: 's1', title: 's1', geom: { x: 0, y: 0, w: 0.5, h: 0.5 }, z: 1 }] }] });
  t.tabList([t.T(1, { settings: { name: 's1', engine: 'sdk' }, kind: 'sdk' }), t.T(2, { settings: { name: 's2', engine: 'sdk' }, kind: 'sdk' })]);
  const shown = (id) => t.sdkCalls.filter(c => c[0] === 'shown' && c[1] === id).map(c => c[2]);
  assert.deepStrictEqual(shown('tab-boot-1'), [true], 'shown on its desk');
  assert.deepStrictEqual(shown('tab-boot-2'), [true], 'shown in the strip');
  t.strip.children[0].click();   // Sessions
  assert.deepStrictEqual(shown('tab-boot-2'), [true, false]);
  assert.deepStrictEqual(shown('tab-boot-1'), [true], 'the desk one stays live');
  assert.strictEqual(t.sdkCalls.filter(c => c[0] === 'setActive').length, 0);
});

test('a busy CLI on a desk marks the Desks header tab, its desk tab and its window, not the CLIs header tab; at home only the CLIs side', () => {
  const t = setup();
  const sdk = (n, name) => t.T(n, { settings: { name, engine: 'sdk' }, kind: 'sdk' });
  const geom = { x: 0, y: 0, w: 0.5, h: 0.5 };
  const deskTab = (id) => t.desksEls.strip.querySelectorAll('.desk-tab').find(b => b.dataset.deskId === id);
  const running = (e) => e.classList.contains('instance-running');
  const stripBtn = (key) => t.buttons().find(b => b.dataset.tabKey === key);
  const winOf = (key) => t.desksEls.area.querySelectorAll('.desk-win').find(w => w.dataset.key === key);
  t.desks.applyState({ version: 1, desks: [{ id: 'd1', name: 'Work', windows: [{ kind: 'cli', key: 'a', title: 'a', geom, z: 1 }] }, { id: 'd2', name: 'Other', windows: [] }] });
  t.tabList([sdk(1, 'a'), sdk(2, 'b')]);

  // 'a' is on desk d1 and busy: the Desks side lights, the CLIs header does not.
  t.busyTabs.add('tab-boot-1');
  t.cli.updateStreamingState();
  assert.ok(running(t.desksHeader), 'Desks header tab');
  assert.ok(running(deskTab('d1')), 'the desk tab');
  assert.ok(!running(deskTab('d2')), 'another desk stays quiet');
  assert.ok(winOf('a').classList.contains('desk-win-busy'), 'the window');
  assert.ok(!running(t.cliHeader), 'not the CLIs header tab');
  assert.ok(running(stripBtn('a')), 'its dimmed strip entry keeps the dot');
  assert.ok(!running(stripBtn('b')));

  // 'b' at home is busy as well: the CLIs header tab lights for it.
  t.busyTabs.add('tab-boot-2');
  t.cli.updateStreamingState();
  assert.ok(running(t.cliHeader));
  t.busyTabs.delete('tab-boot-2');
  t.cli.updateStreamingState();
  assert.ok(!running(t.cliHeader));

  // Moving the busy tab to another desk moves the dot; home moves it back.
  t.desks.applyState({ version: 1, desks: [{ id: 'd1', name: 'Work', windows: [] }, { id: 'd2', name: 'Other', windows: [{ kind: 'cli', key: 'a', title: 'a', geom, z: 1 }] }] });
  assert.ok(!running(deskTab('d1')) && running(deskTab('d2')) && running(t.desksHeader));
  assert.ok(!running(t.cliHeader));
  t.desks.applyState({ version: 1, desks: [{ id: 'd1', name: 'Work', windows: [] }, { id: 'd2', name: 'Other', windows: [] }] });
  assert.ok(!running(t.desksHeader) && !running(deskTab('d1')) && !running(deskTab('d2')));
  assert.ok(running(t.cliHeader), 'a busy tab at home counts for the CLIs header tab again');

  // Busy ends: everything goes quiet.
  t.busyTabs.clear();
  t.cli.updateStreamingState();
  assert.ok(!running(t.cliHeader) && !running(t.desksHeader));
});
