// Dashboard Content-Security-Policy (src/csp.js) and what it relies on: the
// header is on dashboard pages and assets but not under /apps/ or on add-on
// routes, VISTACLAIR_CSP switches it off or to report-only, and no served
// page or generated HTML needs inline script — no inline <script> body, no
// on*= attribute, every <script src> same-origin, DOMPurify and marked from
// public/vendor/.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const csp = require('../src/csp');

const PUBLIC = path.join(__dirname, '../public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

// Every HTML page core serves from public/.
const PAGES = ['index.html', 'login.html', 'landing_page/index.html', 'landing_page/oauth-callback.html'];

// The server.js wiring in miniature: the policy first, a core page, an add-on
// router behind dropForAddons, and an /apps route.
function startApp(opts) {
  const app = express();
  app.use(csp.middleware(opts));
  app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC, 'login.html')));
  app.use(express.static(PUBLIC));
  app.use(csp.dropForAddons);
  const addon = express.Router();
  addon.get('/apps/demo/', (req, res) => res.send('<p>app</p>'));
  addon.get('/pro/page.html', (req, res) => res.send('<p>add-on page</p>'));
  app.use(addon);
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function get(server, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: p }, res => {
      res.resume();
      res.on('end', () => resolve(res));
    }).on('error', reject);
  });
}

async function withApp(opts, fn) {
  const server = await startApp(opts);
  try { await fn(server); } finally { server.close(); }
}

test('policy: script-src self (+ documented lemon.js), and the required directives', () => {
  const policy = csp.buildPolicy();
  const dir = Object.fromEntries(policy.split('; ').map(d => { const [k, ...v] = d.split(' '); return [k, v]; }));
  // 'self' plus the documented checkout script only.
  assert.deepStrictEqual(dir['script-src'], ["'self'", 'https://app.lemonsqueezy.com', 'https://assets.lemonsqueezy.com']);
  assert.deepStrictEqual(dir['object-src'], ["'none'"]);
  assert.deepStrictEqual(dir['base-uri'], ["'self'"]);
  assert.deepStrictEqual(dir['frame-ancestors'], ["'self'"]);
  assert.deepStrictEqual(dir['frame-src'], ["'self'", 'https://*.lemonsqueezy.com']);
  for (const s of ["'self'", 'ws:', 'wss:']) assert.ok(dir['connect-src'].includes(s), `connect-src ${s}`);
  assert.ok(!/unsafe-eval/.test(policy), 'no unsafe-eval');
  assert.ok(!dir['script-src'].includes("'unsafe-inline'"), 'no inline script');
});

test('header on dashboard pages and assets, absent on /apps/* and add-on routes', async () => {
  await withApp({ env: {} }, async (server) => {
    for (const p of ['/', '/index.html', '/login', '/core.js', '/vendor/dompurify-3.4.17/purify.min.js', '/landing_page/']) {
      const res = await get(server, p);
      assert.strictEqual(res.statusCode, 200, p);
      assert.strictEqual(res.headers['content-security-policy'], csp.buildPolicy(), `CSP on ${p}`);
    }
    for (const p of ['/apps/demo/', '/pro/page.html']) {
      const res = await get(server, p);
      assert.strictEqual(res.statusCode, 200, p);
      assert.strictEqual(res.headers['content-security-policy'], undefined, `no core CSP on ${p}`);
      assert.strictEqual(res.headers['content-security-policy-report-only'], undefined, `no report-only on ${p}`);
    }
  });
});

test('VISTACLAIR_CSP=off sends no header; report-only sends the report-only header', async () => {
  assert.strictEqual(csp.mode({}), 'on');
  assert.strictEqual(csp.mode({ VISTACLAIR_CSP: 'off' }), 'off');
  assert.strictEqual(csp.mode({ VISTACLAIR_CSP: 'report-only' }), 'report-only');
  await withApp({ env: { VISTACLAIR_CSP: 'off' } }, async (server) => {
    const res = await get(server, '/');
    assert.strictEqual(res.headers['content-security-policy'], undefined);
    assert.strictEqual(res.headers['content-security-policy-report-only'], undefined);
  });
  await withApp({ env: { VISTACLAIR_CSP: 'report-only' } }, async (server) => {
    const res = await get(server, '/');
    assert.strictEqual(res.headers['content-security-policy'], undefined);
    assert.strictEqual(res.headers['content-security-policy-report-only'], csp.buildPolicy());
  });
});

test('an add-on that is not cspReady downgrades the policy to report-only', async () => {
  const addons = require('../src/addons');
  const base = { contractVersion: addons.CONTRACT_VERSION, clientModules: [{ scripts: ['/x/a.js'] }] };
  addons.registerAddon({ ...base, id: 'csp-test-ready', cspReady: true });
  assert.deepStrictEqual(addons.cspBlockers(), []);
  addons.registerAddon({ ...base, id: 'csp-test-legacy' });
  try {
    assert.deepStrictEqual(addons.cspBlockers(), ['csp-test-legacy']);
    await withApp({ env: {}, reportOnlyWhen: () => addons.cspBlockers().length > 0 }, async (server) => {
      const res = await get(server, '/');
      assert.strictEqual(res.headers['content-security-policy'], undefined);
      assert.strictEqual(res.headers['content-security-policy-report-only'], csp.buildPolicy());
    });
  } finally {
    addons.removeAddon('csp-test-legacy');
    addons.removeAddon('csp-test-ready');
  }
});

test('served pages: no inline <script> body, no on*= attribute', () => {
  for (const page of PAGES) {
    const html = read(page);
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.ok(/\bsrc\s*=/.test(m[1]), `${page}: <script> without src`);
      assert.strictEqual(m[2].trim(), '', `${page}: inline script body`);
    }
    const handler = html.match(/<[^>]*\son[a-z]+\s*=/i);
    assert.ok(!handler, `${page}: inline handler ${handler && handler[0]}`);
    assert.ok(!/javascript:/i.test(html), `${page}: javascript: URL`);
  }
});

test('every <script src> is same-origin or pinned with integrity', () => {
  for (const page of PAGES) {
    for (const m of read(page).matchAll(/<script\b([^>]*)>/gi)) {
      const src = (m[1].match(/\bsrc\s*=\s*["']([^"']+)["']/) || [])[1];
      if (!src) continue;
      if (!/^(https?:)?\/\//i.test(src)) continue;
      assert.ok(/\bintegrity\s*=\s*["']sha(256|384|512)-/.test(m[1]) && /\bcrossorigin\b/.test(m[1]),
        `${page}: ${src} is cross-origin without integrity`);
      assert.ok(/@\d+\.\d+\.\d+\//.test(src), `${page}: ${src} is not an exact version`);
    }
  }
});

test('DOMPurify and marked load from /vendor/, and the vendored files exist', () => {
  const html = read('index.html');
  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
  const purify = srcs.find(s => /purify/i.test(s));
  const marked = srcs.find(s => /marked/i.test(s));
  assert.match(purify || '', /^\/?vendor\/dompurify-3\.\d+\.\d+\/purify\.min\.js$/);
  assert.match(marked || '', /^\/?vendor\/marked-\d+\.\d+\.\d+\/marked\.umd\.js$/);
  for (const s of srcs.filter(s => /^\/?vendor\//.test(s))) {
    assert.ok(fs.existsSync(path.join(PUBLIC, s.replace(/^\//, ''))), `${s} exists`);
  }
  const versions = JSON.parse(read('vendor/VERSIONS.json'));
  for (const lib of versions) {
    assert.match(lib.version, /^\d+\.\d+\.\d+$/, `${lib.name} pinned`);
    assert.match(lib.integrity, /^sha512-/, `${lib.name} integrity`);
    assert.ok(fs.existsSync(path.join(PUBLIC, 'vendor', lib.dir, 'LICENSE')), `${lib.name} LICENSE`);
  }
});

test('no third-party script origin in the page code', () => {
  for (const f of fs.readdirSync(PUBLIC).filter(f => f.endsWith('.js'))) {
    assert.ok(!/cdn\.jsdelivr\.net|unpkg\.com|cdnjs\./.test(read(f)), `${f} references a script CDN`);
  }
});

// Generated HTML (template literals and string concatenation) in public/*.js
// must not carry inline handlers either: under script-src 'self' they are dead.
test('no inline on*= handler in generated HTML in public/*.js', () => {
  const files = [
    ...fs.readdirSync(PUBLIC).filter(f => f.endsWith('.js')),
    ...fs.readdirSync(path.join(PUBLIC, 'landing_page')).filter(f => f.endsWith('.js')).map(f => 'landing_page/' + f),
  ];
  for (const f of files) {
    const src = read(f);
    // An attribute inside markup: whitespace before, `=` and a quote or
    // value after (onclick="…", onerror=alert(1)); not `el.onclick = fn`.
    const hits = [...src.matchAll(/<[a-z][^<>`]*\son[a-z]+\s*=\s*["'`$\\\w]/gi)].map(m => m[0]);
    assert.deepStrictEqual(hits, [], `${f}: inline handler in generated HTML`);
    assert.ok(!/\beval\s*\(|new\s+Function\s*\(|set(Timeout|Interval)\s*\(\s*["'`]/.test(src), `${f}: string eval`);
  }
});

// The checkout overlay's Checkout.Success message (public/checkout-msg.js):
// claimed only from a checkout origin, in the expected shape, with a sane id.
test('checkout message: origin allow-list, shape and order id checks', () => {
  const { checkoutOrigins, checkoutOrderId } = require('../public/checkout-msg.js');
  const origins = checkoutOrigins(['https://shop.lemonsqueezy.com/checkout/buy/abc', 'http://plain.example/x', 'not a url']);
  assert.deepStrictEqual([...origins].sort(), ['https://app.lemonsqueezy.com', 'https://shop.lemonsqueezy.com']);
  const msg = (origin, data) => ({ origin, data });
  const ok = { event: 'Checkout.Success', data: { order: { id: 12345 } } };
  assert.strictEqual(checkoutOrderId(msg('https://shop.lemonsqueezy.com', ok), origins), '12345');
  assert.strictEqual(checkoutOrderId(msg('https://app.lemonsqueezy.com', { event: 'Checkout.Success', data: { order: { data: { id: 'ord_9-x' } } } }), origins), 'ord_9-x');
  // Wrong origin: another frame, an opener, the dashboard itself, a look-alike.
  for (const o of ['https://evil.example', 'http://127.0.0.1:3457', 'https://shop.lemonsqueezy.com.evil.example', 'null', '']) {
    assert.strictEqual(checkoutOrderId(msg(o, ok), origins), null, o);
  }
  // Wrong shape or a bad id.
  for (const data of [null, 'Checkout.Success', { event: 'Checkout.Closed', data: { order: { id: 1 } } },
    { event: 'Checkout.Success' }, { event: 'Checkout.Success', data: { order: null } },
    { event: 'Checkout.Success', data: { order: { id: '1/../../admin' } } },
    { event: 'Checkout.Success', data: { order: { id: 'x'.repeat(65) } } },
    { event: 'Checkout.Success', data: { order: { id: -3 } } },
    { event: 'Checkout.Success', data: { order: { id: 1.5 } } },
    { event: 'Checkout.Success', data: { order: { id: { toString() { return '1'; } } } } }]) {
    assert.strictEqual(checkoutOrderId(msg('https://shop.lemonsqueezy.com', data), origins), null, JSON.stringify(data));
  }
  assert.strictEqual(checkoutOrderId(msg('https://shop.lemonsqueezy.com', ok), null), null, 'no origins yet');
});
