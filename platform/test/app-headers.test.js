// /apps/* response hardening (app-headers.js): the owner's auth cookies never
// leave an app response, nosniff and a separate framing CSP are added, an app's
// own policy is kept. Throwaway in-process servers, no live control room.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const appHeaders = require('../src/apps/app-headers');
const { proxyToApp } = require('../index');

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    }).on('error', reject);
  });
}

// The in-process shape: express router under /apps with the middleware first.
async function inProcess(routes) {
  const app = express();
  const router = express.Router();
  router.use('/apps', appHeaders.middleware());
  router.use('/apps', routes);
  app.use(router);
  const s = await listen(app);
  return { ...s, close: () => s.server.close() };
}

// The own-process shape: a loopback upstream behind index.js's proxyToApp.
async function proxied(upstreamHandler) {
  const up = await listen(upstreamHandler);
  const app = express();
  app.use('/apps', appHeaders.middleware());
  app.use('/apps', (req, res) => proxyToApp(req, res, up.port, req.url));
  const s = await listen(app);
  return { ...s, close: () => { s.server.close(); up.server.close(); } };
}

const names = (cookies) => (cookies || []).map((c) => c.split('=')[0]);
const EXTRA = appHeaders.EXTRA_CSP;

test('stripAuthCookies: exact, trimmed, case-sensitive names', () => {
  const s = appHeaders.stripAuthCookies;
  assert.equal(s('sid=1; Path=/'), undefined);
  assert.equal(s(' token = x'), undefined);
  assert.equal(s('sidecar=1'), 'sidecar=1');
  assert.equal(s('tokens=1'), 'tokens=1');
  assert.equal(s('SID=1'), 'SID=1');
  assert.deepEqual(s(['sid=1', 'a=2', 'token=3', 'tokens=4']), ['a=2', 'tokens=4']);
  assert.equal(s(['sid=1', 'token=2']), undefined);
  // comma-joined cookies, with a comma inside an Expires date left alone
  assert.equal(s('sid=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, a=2'), ' a=2');
  assert.equal(s('a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT'), 'a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT');
});

test('stripAuthCookies: nameless cookies and sid/token spoofs are dropped', () => {
  const s = appHeaders.stripAuthCookies;
  for (const v of ['=sid=EVIL; Path=/apps/x/', ' =token=x', '=sid=', '=token=', ' = sid=1', '="sid"=1', '=x', '"sid"=1', "'token'=1"]) {
    assert.equal(s(v), undefined, v);
  }
  assert.deepEqual(s(['=sid=EVIL', 'sidecar=1', 'tokens=2']), ['sidecar=1', 'tokens=2']);
  assert.equal(s('a=1, =sid=EVIL'), 'a=1');
  assert.equal(s('sidecar=sid=1'), 'sidecar=sid=1');
});

test('in-process: nameless Set-Cookie variants are dropped over HTTP', async () => {
  const s = await inProcess((req, res) => {
    res.setHeader('Set-Cookie', ['=sid=EVIL; Path=/apps/x/', ' =token=x', '=sid=', 'sidecar=1', 'tokens=2']);
    res.end('x');
  });
  try {
    const res = await get(s.port, '/apps/a/');
    assert.deepEqual(names(res.headers['set-cookie']), ['sidecar', 'tokens']);
  } finally { s.close(); }
});

test('in-process: writeEarlyHints strips auth and nameless Set-Cookie', async () => {
  const s = await inProcess((req, res) => {
    res.writeEarlyHints({ link: '</s.css>; rel=preload; as=style', 'set-cookie': ['sid=EVIL', '=token=x', 'pref=1'] });
    res.end('x');
  });
  try {
    const early = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: s.port, path: '/apps/a/' }, (res) => res.resume())
        .on('information', (info) => resolve(info)).on('error', reject);
    });
    assert.equal(early.statusCode, 103);
    assert.ok(early.headers.link);
    assert.deepEqual(early.headers['set-cookie'], ['pref=1']);
  } finally { s.close(); }
});

test('in-process: writeEarlyHints with only auth cookies sends none', async () => {
  const s = await inProcess((req, res) => {
    res.writeEarlyHints({ link: '</s.css>; rel=preload; as=style', 'set-cookie': '=sid=EVIL' });
    res.end('x');
  });
  try {
    const early = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: s.port, path: '/apps/a/' }, (res) => res.resume())
        .on('information', (info) => resolve(info)).on('error', reject);
    });
    assert.equal(early.headers['set-cookie'], undefined);
  } finally { s.close(); }
});

for (const [label, make] of [
  ['in-process', (fn) => inProcess((req, res) => fn(res))],
  ['own-process proxy', (fn) => proxied((req, res) => fn(res))],
]) {
  test(`${label}: sid/token Set-Cookie dropped, other cookies kept`, async () => {
    const cases = [
      ['sid=abc; Path=/; HttpOnly', []],
      ['token=abc', []],
      [['sid=1', 'token=2'], []],
      [['sid=1', 'theme=dark', 'token=2', 'lang=en; Path=/'], ['theme', 'lang']],
      ['theme=dark; Path=/', ['theme']],
      [['sidecar=1', 'tokens=2'], ['sidecar', 'tokens']],
    ];
    for (const [value, kept] of cases) {
      const s = await make((res) => { res.setHeader('Set-Cookie', value); res.end('x'); });
      try {
        const res = await get(s.port, '/apps/a/');
        assert.deepEqual(names(res.headers['set-cookie']), kept, JSON.stringify(value));
      } finally { s.close(); }
    }
  });

  test(`${label}: nosniff and an extra CSP are added`, async () => {
    const s = await make((res) => res.end('x'));
    try {
      const res = await get(s.port, '/apps/a/');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['content-security-policy'], EXTRA);
      assert.deepEqual(res.rawHeaders.filter((h) => h.toLowerCase() === 'content-security-policy').length, 1);
    } finally { s.close(); }
  });

  test(`${label}: an app's own CSP is kept and the extra one sent beside it`, async () => {
    const own = "default-src 'self'";
    const s = await make((res) => { res.setHeader('Content-Security-Policy', own); res.end('x'); });
    try {
      const res = await get(s.port, '/apps/a/');
      const lines = res.rawHeaders.map((h, i, a) => (a[i - 1] || '').toLowerCase() === 'content-security-policy' ? h : null).filter(Boolean);
      assert.deepEqual(lines, [own, EXTRA]);
    } finally { s.close(); }
  });

  test(`${label}: an app's own nosniff is not duplicated`, async () => {
    const s = await make((res) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.end('x'); });
    try {
      const res = await get(s.port, '/apps/a/');
      const n = res.rawHeaders.filter((h) => h.toLowerCase() === 'x-content-type-options').length;
      assert.equal(n, 1);
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
    } finally { s.close(); }
  });
}

test('in-process: express helpers (res.cookie, redirect, 404, JSON) are covered', async () => {
  const routes = express.Router();
  routes.get('/a/c', (req, res) => { res.cookie('sid', 'x'); res.cookie('pref', 'y'); res.json({ ok: 1 }); });
  routes.get('/a/r', (req, res) => res.redirect('/apps/a/c'));
  const s = await inProcess(routes);
  try {
    const c = await get(s.port, '/apps/a/c');
    assert.deepEqual(names(c.headers['set-cookie']), ['pref']);
    for (const p of ['/apps/a/r', '/apps/a/missing']) {
      const r = await get(s.port, p);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
      assert.ok(r.headers['content-security-policy'].includes(EXTRA), p);
    }
  } finally { s.close(); }
});

test('an artifact-style sandbox CSP and nosniff stay as set', async () => {
  const sandbox = "default-src 'none'; sandbox";
  const s = await inProcess((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', sandbox);
    res.end('x');
  });
  try {
    const res = await get(s.port, '/apps/a/');
    const lines = res.rawHeaders.map((h, i, a) => (a[i - 1] || '').toLowerCase() === 'content-security-policy' ? h : null).filter(Boolean);
    assert.equal(lines[0], sandbox);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  } finally { s.close(); }
});

test('the proxy passes upstream status and body through', async () => {
  const s = await proxied((req, res) => { res.statusCode = 418; res.setHeader('Set-Cookie', ['token=1', 'a=b']); res.end('tea'); });
  try {
    const body = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: s.port, path: '/apps/a/' }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, d, cookies: res.headers['set-cookie'] }));
    }));
    assert.equal(body.status, 418);
    assert.equal(body.d, 'tea');
    assert.deepEqual(body.cookies, ['a=b']);
  } finally { s.close(); }
});
