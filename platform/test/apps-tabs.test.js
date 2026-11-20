// The Apps view's second-level strip on the base dashboard's shared TabHost
// (public/apps.js; docs/desks.md): public/apps.js runs in a fake DOM next to
// core's real public/tab-host.js and tab-context-menu.js.
//   (a) opening an app registers a TabHost tab keyed by the app name;
//   (b) a panel root moved to another parent (a desk window) still gets its
//       iframe src reset on app:started and app:stopped;
//   (c) the fixed tabs (All Apps, Apps Guide, Tools) are not movable;
// plus: reopen of a desk window's missing tab, close, and a tab on a desk
// being left alone by the home area.
//
// Core is loaded read-only by path, as test/peer-remote-integration.test.js
// does (VISTACLAIR_CORE_DIR, the hosting core, ~/vistaclair); skipped loudly
// when it has no TabHost.
//
//   node --test test/apps-tabs.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

function findCore() {
  const has = (d) => fs.existsSync(path.join(d, 'public', 'tab-host.js')) && fs.existsSync(path.join(d, 'test', 'desks-fake-dom.js'));
  if (process.env.VISTACLAIR_CORE_DIR) return has(process.env.VISTACLAIR_CORE_DIR) ? path.resolve(process.env.VISTACLAIR_CORE_DIR) : null;
  for (let d = path.resolve(__dirname, '..', '..'); ; d = path.dirname(d)) {
    if (has(d)) return d;
    if (path.dirname(d) === d) break;
  }
  const home = path.join(os.homedir(), 'vistaclair');
  return has(home) ? home : null;
}
const CORE = findCore();
if (!CORE) console.warn('\n*** apps-tabs SKIPPED: no core with public/tab-host.js (set VISTACLAIR_CORE_DIR) ***\n');
const opts = { skip: CORE ? false : 'no core with public/tab-host.js' };

// A small HTML parser for the fake DOM: tags, attributes, text, void and
// self-closing elements. Enough for the panels apps.js builds.
const VOID = new Set(['br', 'img', 'input', 'hr', 'link', 'meta', 'circle', 'path', 'rect']);
function patchHtml(El) {
  function parse(parent, html) {
    const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:=(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>|([^<]+)/g;
    const stack = [parent];
    let m;
    while ((m = re.exec(html))) {
      const top = stack[stack.length - 1];
      if (m[5] !== undefined) { if (m[5].trim()) top._text += m[5]; continue; }
      const [, closing, tag, attrs, selfClose] = m;
      if (closing) { if (stack.length > 1) stack.pop(); continue; }
      const el = new El(tag);
      for (const a of attrs.matchAll(/([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'))?/g)) {
        const v = a[2] ?? a[3] ?? '';
        if (a[1].startsWith('data-')) el.dataset[a[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
        else if (a[1] === 'class') el.className = v;
        else if (a[1] === 'id') el.id = v;
        else { el.attrs[a[1]] = v; el[a[1]] = v; }
      }
      top.appendChild(el);
      if (!selfClose && !VOID.has(tag.toLowerCase())) stack.push(el);
    }
  }
  Object.defineProperty(El.prototype, 'innerHTML', {
    configurable: true,
    get() { return this._html || ''; },
    set(v) { this.textContent = ''; this._html = String(v); parse(this, String(v)); },
  });
  El.prototype.insertAdjacentHTML = function (pos, html) { parse(this, html); };
  Object.defineProperty(El.prototype, 'outerHTML', {
    configurable: true,
    set(v) {
      const holder = new El('div');
      parse(holder, String(v));
      const i = this.parentNode.children.indexOf(this);
      const kids = holder.children.slice();
      kids.forEach(k => { k.parentNode = this.parentNode; });
      this.parentNode.children.splice(i, 1, ...kids);
      this.parentNode = null;
    },
  });
}

function setup({ apps = [], desks = null } = {}) {
  const { makeDom } = require(path.join(CORE, 'test', 'desks-fake-dom.js'));
  const dom = makeDom();
  const d = dom.doc;
  patchHtml(dom.El);
  d.head = d.createElement('head');
  const mk = (id) => { const e = d.createElement('div'); e.id = id; d.body.appendChild(e); return e; };
  const headerTabs = mk('headerTabs');

  const sent = [];
  const handlers = {};
  const views = {};
  const window = {
    innerWidth: 1600, innerHeight: 900, addEventListener() {}, removeEventListener() {},
    localStorage: { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } },
    dashboard: {
      state: { ws: { readyState: 1 } },
      sendWs: (m) => sent.push(m),
      escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      showAlert() {}, showConfirm: async () => true, showToast() {},
      registerModule: (p, fn) => { handlers[p] = fn; },
      registerView: (v, fn) => { views[v] = fn; },
    },
  };
  const ctx = {
    window, document: d, console, CSS: { escape: (s) => String(s) },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, ResizeObserver: class { observe() {} disconnect() {} },
    location: { search: '', reload() {} }, navigator: {}, URLSearchParams,
    localStorage: window.localStorage, sessionStorage: window.localStorage,
  };
  ctx.globalThis = ctx;
  // Browser globals that are window properties.
  for (const k of ['vcAct', 'spendAdmin']) Object.defineProperty(ctx, k, { get: () => window[k], configurable: true });
  window.document = d;
  vm.createContext(ctx);
  const run = (file) => vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  run(path.join(CORE, 'public', 'tab-context-menu.js'));
  run(path.join(CORE, 'public', 'tab-host.js'));
  if (desks) window.tabHosts.setDeskProvider(desks);
  run(path.join(__dirname, '..', 'public', 'apps.js'));

  const send = (msg) => handlers['app:'](msg);
  send({ type: 'app:list', apps });
  views.apps();  // the Apps view is shown
  const strip = d.getElementById('appsTabStrip');
  const content = d.getElementById('apps-content');
  const tabButtons = () => strip.querySelectorAll('.view-tab[data-tab-key]');
  return { window, d, dom, sent, send, strip, content, host: window.tabHosts.get('apps'), mod: window.appsModule, tabButtons, mk };
}

const APPS = [
  { name: 'alpha', running: true, runtime: 'in-process' },
  { name: 'beta', running: false, runtime: 'in-process' },
  { name: 'full', running: true, display: 'fullscreen' },
];
const iframeOf = (panel, name) => panel.querySelector(`iframe[data-app-iframe="${name}"]`);

test('opening an app registers a TabHost tab keyed by the app name', opts, () => {
  const t = setup({ apps: APPS });
  assert.ok(t.host, 'an apps TabHost is registered');
  assert.strictEqual(t.host.kind, 'apps');
  assert.deepStrictEqual(Array.from(t.host.keys()), []);

  t.mod.openApp('alpha');
  assert.deepStrictEqual(Array.from(t.host.keys()), ['alpha']);
  assert.strictEqual(t.host.get('alpha').key, 'alpha');
  assert.strictEqual(t.host.activeKey(), 'alpha');
  const btn = t.tabButtons()[0];
  assert.strictEqual(btn.dataset.tabKey, 'alpha');
  assert.strictEqual(btn.dataset.tabKind, 'apps');
  assert.ok(btn.querySelector('.view-tab-close'), 'the × is still on the tab');
  // The panel is the tab's root, built once, in the content area.
  const root = t.host.get('alpha').root;
  assert.strictEqual(root.parentNode, t.content);
  assert.ok(iframeOf(root, 'alpha'));
  t.mod.openApp('alpha');
  assert.strictEqual(t.host.get('alpha').root, root, 'opening again keeps the same root');
  assert.strictEqual(t.host.keys().length, 1);

  // Switching to All Apps hides the tab, closing removes it and its panel.
  t.strip.querySelector('[data-app-tab="grid"]').click();
  assert.strictEqual(root.style.display, 'none');
  assert.strictEqual(t.host.activeKey(), null);
  t.mod.openApp('alpha');
  t.tabButtons()[0].querySelector('.view-tab-close').click();
  assert.deepStrictEqual(Array.from(t.host.keys()), []);
  assert.strictEqual(root.parentNode, null);
});

test('a panel moved elsewhere still gets its iframe reset on app:started / app:stopped', opts, () => {
  const t = setup({ apps: APPS });
  t.mod.openApp('beta');                       // not running: starts, blank frame
  assert.ok(t.sent.some(m => m.type === 'app:start' && m.name === 'beta'));
  const root = t.content.querySelector('[data-panel="app-beta"]');   // by DOM, not through the host
  assert.ok(root, 'the panel is in #apps-content');
  const frame = iframeOf(root, 'beta');
  assert.strictEqual(frame.src, 'about:blank');

  // What attachToDesk does: the root leaves #apps-content for a window body.
  const body = t.mk('deskBody');
  body.appendChild(root);
  assert.strictEqual(t.content.querySelector('iframe[data-app-iframe="beta"]'), null, 'no longer under #apps-content');

  t.send({ type: 'app:started', appName: 'beta', port: 1234 });
  assert.strictEqual(frame.src, '/apps/beta/');
  assert.strictEqual(root.querySelector('[data-app-placeholder]'), null, 'the starting placeholder is gone');

  t.send({ type: 'app:stopped', appName: 'beta' });
  assert.strictEqual(frame.src, 'about:blank');
  assert.ok(root.querySelector('[data-app-placeholder]'), 'the Start placeholder shows in the moved panel');
});

test('the fixed tabs are not movable', opts, () => {
  const desks = { enabled: () => true, list: () => [{ id: 'd1', name: 'One' }], deskOf: () => null, moveTo() {}, createAndMove() {}, show() {}, returnHome() {} };
  const t = setup({ apps: APPS, desks });
  t.mod.openApp('alpha');
  t.mod.openHelp();
  t.mod.openToolsOverview();
  assert.deepStrictEqual(Array.from(t.host.keys()), ['alpha', '_help', '_tools']);
  const labels = (key) => t.host.menuItems(key).map(i => i.label);
  assert.ok(labels('alpha').some(l => /Move to desk/.test(l || '')), 'an app tab offers Move to desk');
  assert.ok(!labels('_help').some(l => /Move to desk/.test(l || '')), 'Apps Guide has no Move to desk');
  assert.ok(!labels('_tools').some(l => /Move to desk/.test(l || '')), 'Tools has no Move to desk');
  // All Apps is not a host tab at all.
  assert.ok(!t.host.has('grid'));
  assert.ok(!t.tabButtons().some(b => b.dataset.tabKey === 'grid'));
  assert.ok(t.strip.querySelector('[data-app-tab="grid"]'));
});

test('reopen opens the missing tab (and starts the app); fixed and full-screen apps do not', opts, async () => {
  const t = setup({ apps: APPS });
  assert.strictEqual(await t.host.reopen('beta'), true);
  assert.ok(t.host.has('beta'));
  assert.ok(t.sent.some(m => m.type === 'app:start' && m.name === 'beta'));
  assert.strictEqual(t.host.activeKey(), null, 'reopening does not steal the home area');
  assert.strictEqual(await t.host.reopen('nope'), false);
  assert.strictEqual(await t.host.reopen('full'), false);
  assert.strictEqual(await t.host.reopen('_help'), false);
});

test('a tab on a desk is left alone by the home area; its click goes to the window', opts, () => {
  const shown = [];
  const desks = { enabled: () => true, list: () => [], deskOf: () => null, moveTo() {}, createAndMove() {}, show: (k, key) => shown.push([k, key]), returnHome() {} };
  const t = setup({ apps: APPS, desks });
  t.mod.openApp('alpha');
  t.mod.openApp('beta');
  const body = t.mk('deskBody');
  t.host.attachToDesk('alpha', body, { id: 'd1', name: 'One' });
  assert.strictEqual(t.host.get('alpha').root.parentNode, body);
  assert.strictEqual(t.host.activeKey(), 'beta', 'the shown home tab is unchanged');

  t.mod.openApp('alpha');                      // goes to the window
  assert.deepStrictEqual(shown, [['apps', 'alpha']]);
  assert.strictEqual(t.host.activeKey(), 'beta');
  t.strip.querySelector('[data-app-tab="grid"]').click();   // grid hides home tabs only
  assert.strictEqual(t.host.get('alpha').root.parentNode, body);
  assert.notStrictEqual(t.host.get('alpha').root.style.display, 'none');
  assert.strictEqual(t.host.get('beta').root.style.display, 'none');
});
