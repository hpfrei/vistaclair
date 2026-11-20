// Request bodies through the own-process proxy (proxyToApp via the /apps
// dispatcher) and the site byte-proxy (/s/<app>/<site>/), behind core's real
// global parsers (server.js: express.json + express.urlencoded with the
// rawBody verify hook). The upstream must see the exact bytes and a matching
// Content-Length. Throwaway servers only.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const { appsDispatcher } = require('../index');
const appManager = require('../src/apps/app-manager');
const sites = require('../src/apps/sites');
const sitesProxy = require('../src/apps/sites-proxy');

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});
// upstream: records method, headers and the exact body bytes
function recorder() {
  const seen = [];
  return {
    seen,
    handler: (req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { seen.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks) }); res.end('ok'); });
    },
  };
}
const send = (port, method, path, body, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method, headers, timeout: 3000 }, (res) => {
    const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
  });
  req.on('timeout', () => { req.destroy(new Error('timeout (hang)')); });
  req.on('error', reject);
  req.end(body);
});

// core's parsers, as in server.js
function coreApp() {
  const app = express();
  app.use(express.json({ limit: '50mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use(express.urlencoded({ extended: false, verify: (req, res, buf) => { req.rawBody = buf; } }));
  return app;
}

const CASES = [
  ['json POST', 'POST', 'application/json', Buffer.from('{"a":1,  "b":[1,2,3],"u":"é"}')],
  ['json PUT', 'PUT', 'application/json', Buffer.from('{"x":"y"}')],
  ['form POST', 'POST', 'application/x-www-form-urlencoded', Buffer.from('a=1&b=%C3%A9&c=')],
  ['binary POST', 'POST', 'application/octet-stream', Buffer.from([0, 255, 1, 254, 10, 13, 0x7b])],
  ['text POST', 'POST', 'text/plain', Buffer.from('hello world')],
  ['empty json body', 'POST', 'application/json', Buffer.alloc(0)],
];

async function checkAll(port, prefix, rec) {
  for (const [name, method, type, body] of CASES) {
    rec.seen.length = 0;
    const r = await send(port, method, prefix, body, { 'content-type': type, 'content-length': String(body.length) });
    assert.equal(r.status, 200, name);
    assert.equal(rec.seen.length, 1, name);
    const got = rec.seen[0];
    assert.deepEqual(got.body, body, `${name}: bytes`);
    assert.equal(got.headers['content-length'], String(body.length), `${name}: content-length`);
    assert.ok(!got.headers['transfer-encoding'], `${name}: no transfer-encoding`);
  }
}

test('own-process app: bodies behind core parsers reach the app byte-identical', async () => {
  const rec = recorder();
  const up = await listen(rec.handler);
  const origRunning = appManager.getRunningApp;
  const origMounted = appManager.getMountedRouter;
  appManager.getRunningApp = (n) => (n === 'demo' ? { port: up.port } : null);
  appManager.getMountedRouter = () => null;
  const app = coreApp();
  app.use('/apps', appsDispatcher({ isOwnerRequest: () => true }));
  const s = await listen(app);
  try { await checkAll(s.port, '/apps/demo/api/x', rec); }
  finally { appManager.getRunningApp = origRunning; appManager.getMountedRouter = origMounted; s.server.close(); up.server.close(); }
});

test('site byte-proxy: bodies behind core parsers reach the site byte-identical', async () => {
  const rec = recorder();
  const up = await listen(rec.handler);
  const orig = sites.proxyTarget;
  sites.proxyTarget = (a, s) => (a === 'demo' && s === 'web' ? { port: up.port } : null);
  const app = coreApp();
  app.use(sitesProxy.middleware({ authToken: 't' }));
  const s = await listen(app);
  try { await checkAll(s.port, '/s/demo/web/submit', rec); }
  finally { sites.proxyTarget = orig; s.server.close(); up.server.close(); }
});
