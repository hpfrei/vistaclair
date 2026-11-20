// Content-Security-Policy readiness of the Pro client (public/**) and the
// switch that tells core so.
//
// Core (src/csp.js) allows script only from 'self' (+ lemon.js): no inline
// <script>, no on*= attribute, no javascript: URL, no eval, no CDN script. The
// pages and modules in public/ must run under that policy; generated markup
// binds its actions through vcAct.attrs (defined at the top of public/apps.js), not on*=.
//
//   node --test test/security-csp.test.js
//   CSP_SCAN_DIR=<other public dir> node --test test/security-csp.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUBLIC = process.env.CSP_SCAN_DIR || path.join(__dirname, '..', 'public');

// Pro's own files; vendored/minified libraries are not ours to scan.
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'fonts') walk(p, out); }
    else out.push(p);
  }
  return out;
}
const FILES = walk(PUBLIC).filter((p) => !/\.min\.(js|css)$/.test(p));
const rel = (p) => path.relative(PUBLIC, p);
const JS = FILES.filter((p) => p.endsWith('.js'));
const HTML = FILES.filter((p) => p.endsWith('.html'));
const read = (p) => fs.readFileSync(p, 'utf8');

// An attribute in markup: whitespace or a quote before `on<event>`, `=` and a
// quote after. `el.onclick = fn` (a DOM property, allowed) has a dot before it.
const INLINE_HANDLER = /(?:^|[\s"'`])on[a-z]+\s*=\s*["'`]/gm;

test('the scan sees the Pro pages and modules', () => {
  assert.ok(HTML.length >= 4, 'html pages found');
  assert.ok(JS.length >= 20, 'scripts found');
  for (const f of ['apps.js', 'horst/index.html', 'app-launcher.html', 'tg-session/index.html', 'vista/index.html']) {
    assert.ok(FILES.some((p) => rel(p) === f), f);
  }
});

// A running server keeps the OLD index.js (client-module list, auth-exempt
// paths) in memory but serves public/ from disk, so a new file the old
// descriptor does not list or exempt is unreachable until the owner restarts.
// app-launcher.html therefore keeps its inline script: an external one would
// need a new auth-exempt entry (the public launcher has no owner cookie), and
// core sends no policy on /pro pages (src/csp.js dropForAddons).
const INLINE_SCRIPT_PAGES = ['app-launcher.html'];

test('no inline <script> body in any page (except the launcher, see above)', () => {
  for (const p of HTML) {
    if (INLINE_SCRIPT_PAGES.includes(rel(p))) continue;
    for (const m of read(p).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.ok(/\bsrc\s*=/.test(m[1]), `${rel(p)}: <script> without src`);
      assert.strictEqual(m[2].trim(), '', `${rel(p)}: inline script body`);
    }
  }
});

test('no inline on*= handler in a page or in generated markup', () => {
  for (const p of [...HTML, ...JS]) {
    const src = read(p);
    const hits = [...src.matchAll(INLINE_HANDLER)].map((m) => src.slice(m.index, m.index + 60).replace(/\s+/g, ' ').trim());
    assert.deepStrictEqual(hits, [], `${rel(p)}: inline handler (use vcAct.attrs or addEventListener)`);
  }
});

test('no javascript: URL, no eval / new Function / string timer', () => {
  for (const p of [...HTML, ...JS]) {
    const src = read(p);
    assert.ok(!/javascript:/i.test(src), `${rel(p)}: javascript: URL`);
  }
  for (const p of JS) {
    const src = read(p);
    assert.ok(!/(^|[^\w.$])eval\s*\(|new\s+Function\s*\(|set(Timeout|Interval)\s*\(\s*["'`]/.test(src), `${rel(p)}: string eval`);
  }
});

test('no script or worker loaded from a CDN', () => {
  for (const p of [...HTML, ...JS]) {
    assert.ok(!/cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.|cdn\.skypack|esm\.sh/.test(read(p)), `${rel(p)}: CDN reference`);
  }
});

// The one script that cannot be served from here: Telegram's WebApp SDK, which
// the Mini App pages must load from telegram.org. Those pages are answered by
// the add-on router, where core sends no policy (src/csp.js dropForAddons); if
// core ever applies it there, script-src needs https://telegram.org.
test('cross-origin <script src> is limited to the Telegram WebApp SDK', () => {
  const allowed = { 'tg-session/index.html': ['https://telegram.org/js/telegram-web-app.js'], 'vista/index.html': ['https://telegram.org/js/telegram-web-app.js'] };
  for (const p of HTML) {
    const found = [...read(p).matchAll(/<script\b[^>]*\bsrc\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi)].map((m) => m[1]);
    assert.deepStrictEqual(found, allowed[rel(p)] || [], `${rel(p)}: cross-origin script`);
  }
});

test('Monaco loads from the dashboard origin', () => {
  const src = read(path.join(PUBLIC, 'apps.js'));
  assert.match(src, /paths:\s*\{\s*vs:\s*location\.origin \+ '\/vendor\/monaco-editor-[\d.]+\/min\/vs'/);
});

test('vcAct.attrs uses only events the delegate in apps.js handles', () => {
  const act = read(path.join(PUBLIC, 'apps.js'));
  const supported = /var EVENTS = \[([^\]]*)\]/.exec(act)[1].match(/'(\w+)'/g).map((x) => x.slice(1, -1));
  for (const p of JS) {
    for (const m of read(p).matchAll(/vcAct\.attrs\(\s*'(\w+)'/g)) {
      assert.ok(supported.includes(m[1]), `${rel(p)}: vcAct.attrs event ${m[1]}`);
    }
  }
});

test('descriptor: cspReady only when VISTACLAIR_PRO_CSP_READY is on', () => {
  const { cspReadyEnabled } = require('../index');
  assert.strictEqual(cspReadyEnabled({}), false);
  assert.strictEqual(cspReadyEnabled({ VISTACLAIR_PRO_CSP_READY: '' }), false);
  for (const v of ['0', 'off', 'false', 'no', 'maybe']) assert.strictEqual(cspReadyEnabled({ VISTACLAIR_PRO_CSP_READY: v }), false, v);
  for (const v of ['1', 'true', 'YES', ' on ']) assert.strictEqual(cspReadyEnabled({ VISTACLAIR_PRO_CSP_READY: v }), true, v);
  // The descriptor exposes it as a getter on the live environment, and core
  // reads `cspReady !== true`: nothing else may make it true.
  const src = read(path.join(__dirname, '..', 'index.js'));
  assert.match(src, /get cspReady\(\)\s*\{\s*return cspReadyEnabled\(\);\s*\}/);
  assert.ok(!/cspReady:\s*true/.test(src));
});

// --- Version skew: an OLD running server -------------------------------------
// The client-module list and the auth-exempt paths of index.js before this
// work. Every file the pages load must be reachable under them.
const OLD_MODULES = ['/pro/apps.js', '/pro/app-bridge-client.js', '/pro/app-model-picker.js', '/pro/app-overlays.js', '/pro/horst-tab.js', '/pro/remote-sessions-view.js', '/pro/publish.js', '/pro/spend-admin.js', '/pro/tg-handoff.js'];
const OLD_EXEMPT = ['/pro/auth/google/callback', '/pro/telegram', '/pro/whatsapp', '/pro/calendar/webhook', '/pro/app-launcher.html', '/pro/app-auth.js', '/pro/tg-session', '/api/peer',
  '/pro/app-overlays.js', '/pro/apps.css', '/pro/app-theme.css', '/pro/proposal-cards.js', '/pro/vista', '/pro/tg-common', '/pro/marked.min.js', '/pro/purify.min.js'];
const exempt = (p, list) => list.some((e) => p === e || p.startsWith(e + '/'));

const indexSrc = read(path.join(__dirname, '..', 'index.js'));
const newModules = () => /scripts:\s*\[([^\]]*)\]/.exec(indexSrc)[1].match(/'([^']+)'/g).map((x) => x.slice(1, -1));

test('the client-module list names no file the old descriptor does not load', () => {
  for (const m of newModules()) assert.ok(OLD_MODULES.includes(m), `${m} is not in the old clientModules list`);
  assert.strictEqual(newModules()[0], '/pro/apps.js', 'apps.js defines vcAct and loads first');
});

test('the launcher page needs nothing outside the old auth-exempt list', () => {
  const html = read(path.join(PUBLIC, 'app-launcher.html'));
  const refs = [...html.matchAll(/(?:src|href)\s*=\s*["'](\/pro\/[^"']+)["']|'(\/pro\/[^']+)'/g)].map((m) => m[1] || m[2]);
  assert.ok(refs.length >= 3, 'launcher references found');
  // app-bridge-client.js is loaded only in owner mode, after the owner WS
  // connected (the owner has the cookie).
  const ownerOnly = ['/pro/app-bridge-client.js'];
  for (const r of refs) assert.ok(exempt(r, OLD_EXEMPT) || ownerOnly.includes(r), `${r} unreachable for a public visitor on an old server`);
  const ex = /authExemptPaths:\s*\[([\s\S]*?)\],\n/.exec(indexSrc)[1].match(/'(\/[^']+)'/g).map((x) => x.slice(1, -1));
  for (const e of ex) assert.ok(OLD_EXEMPT.includes(e), `new auth-exempt entry ${e} would not exist on an old server`);
});

// The modules evaluated in list order in a stubbed DOM, as the dashboard page
// loads them: vcAct must exist after apps.js, and a render path that used to
// carry an inline handler must produce markup that dispatches.
function stubNode() {
  const p = new Proxy(function () {}, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === 'then') return undefined;
      if (k === 'length') return 0;
      if (k === Symbol.iterator) return function* () {};
      if (k === 'forEach' || k === 'map' || k === 'filter') return () => [];
      return stubNode();
    },
    set() { return true; }, apply() { return stubNode(); }, construct() { return stubNode(); }, has() { return false; },
  });
  return p;
}

function loadModules(list) {
  const vm = require('vm');
  const listeners = {};
  const ctx = { console, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, Promise, JSON, Object, Array, Map, Set, Date, Math, String, Number, RegExp, Error, URL, URLSearchParams, Symbol, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent };
  ctx.window = ctx; ctx.globalThis = ctx;
  ctx.addEventListener = () => {}; ctx.removeEventListener = () => {}; ctx.matchMedia = () => stubNode(); ctx.WebSocket = function () { return stubNode(); }; ctx.fetch = () => new Promise(() => {}); ctx.getComputedStyle = () => stubNode();
  ctx.document = new Proxy({}, { get: (t, k) => (k === 'addEventListener' ? (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); } : stubNode()) });
  ctx.location = { origin: 'http://x', search: '', href: 'http://x/' };
  ctx.navigator = {}; ctx.localStorage = stubNode(); ctx.sessionStorage = stubNode(); ctx.CSS = { escape: (x) => x };
  const calls = [];
  ctx.createTabHost = () => stubNode();   // core's TabHost (public/tab-host.js); apps.js builds its strip on it
  ctx.dashboard = { state: {}, sendWs: (m) => calls.push(m), escHtml: (x) => String(x), showAlert() {}, showConfirm() {}, registerModule() {}, registerView() {}, showToast() {} };
  vm.createContext(ctx);
  for (const m of list) vm.runInContext(read(path.join(PUBLIC, m.replace(/^\/pro\//, ''))), ctx, { filename: m });
  return { ctx, listeners, calls };
}

// A fake element parsed from one markup fragment's attributes, enough for the
// delegate: getAttribute / hasAttribute / nodeType.
function fakeEl(markup) {
  const attrs = {};
  for (const m of markup.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
    attrs[m[1]] = (m[2] || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  return { nodeType: 1, getAttribute: (k) => (k in attrs ? attrs[k] : null), hasAttribute: (k) => k in attrs };
}

for (const [label, list] of [['old module list', OLD_MODULES], ['new module list', newModules()]]) {
  test(`client modules loaded in the ${label}: vcAct exists and a rendered action dispatches`, () => {
    const { ctx, listeners } = loadModules(list);
    assert.strictEqual(typeof ctx.vcAct.attrs, 'function');
    assert.ok(listeners.click && listeners.click.length >= 1, 'delegated click listener installed');
    const html = ctx.spendAdmin.tile('demo-app');
    assert.ok(!/\son[a-z]+\s*=/.test(html), 'no inline handler in the tile');
    const tag = /<div class="is-link spend-tile[^"]*"([^>]*)>/.exec(html)[1];
    const got = [];
    ctx.spendAdmin.openFor = (n) => got.push(n);
    let stopped = false;
    const ev = { composedPath: () => [fakeEl(tag)], stopPropagation: () => { stopped = true; }, preventDefault() {} };
    for (const fn of listeners.click) fn(ev);
    assert.deepStrictEqual(got, ['demo-app']);
    assert.ok(stopped, 'stop option honoured');
  });

  test(`every vcAct action path in apps.js and spend-admin.js resolves (${label})`, () => {
    const { ctx } = loadModules(list);
    const paths = new Set();
    for (const f of ['apps.js', 'spend-admin.js']) {
      for (const m of read(path.join(PUBLIC, f)).matchAll(/vcAct\.attrs\(\s*'\w+',\s*'([\w.]+)'/g)) paths.add(m[1]);
    }
    assert.ok(paths.size > 30, `found ${paths.size} action paths`);
    for (const p of paths) {
      const [root, name] = p.split('.');
      // dashboard (core) and horstModule (horst-tab.js) are provided outside these files.
      if (root === 'dashboard' || root === 'horstModule') continue;
      // Attached to appsModule by the Telegram setup pane when it renders.
      if (p === 'appsModule.tgPreselect') continue;
      assert.strictEqual(typeof ctx[root][name], 'function', `${p} is not a function`);
    }
  });
}
