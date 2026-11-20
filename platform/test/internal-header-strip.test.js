// Security hardening: the OAuth callback page, the one-time OAuth state, the
// credential-header strip before app code, the per-app cron signature, and
// db.status without the admin password. Throwaway express servers only.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const { appsDispatcher, proxyToApp } = require('../index');
const appManager = require('../src/apps/app-manager');
const internalHeaders = require('../src/apps/internal-headers');
const googleAuth = require('../src/apps/google-auth');
const { createHandler } = require('../src/apps/google-callback');

const TOKEN = 'CORE_AUTH_TOKEN_xyz';
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});
const fetchRaw = (port, path, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
    let body = '';
    res.on('data', (c) => body += c);
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  }).on('error', reject);
});
// Core's isOwnerRequest in miniature: loopback + the internal header == token.
const fakeCoreIsOwner = (req) => req.headers['x-vistaclair-internal'] === TOKEN;

// ---------------------------------------------------------------- A2-H1 / M1

test('callback: error=</script><script>x</script> cannot break out, and carries a CSP', async () => {
  const app = express();
  app.get('/cb', createHandler(googleAuth));
  const s = await listen(app);
  try {
    const evil = '</script><script>x</script>';
    const r = await fetchRaw(s.port, '/cb?error=' + encodeURIComponent(evil));
    assert.equal(r.status, 200);
    const csp = r.headers['content-security-policy'];
    assert.match(csp, /default-src 'none'/);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1];
    assert.ok(r.body.includes(`<script nonce="${nonce}">`));
    // exactly one <script> element and one closing tag: nothing of ours parsed as markup
    assert.equal(r.body.match(/<script/g).length, 1);
    assert.equal(r.body.match(/<\/script/g).length, 1);
    assert.ok(!r.body.includes(evil));
    assert.ok(r.body.includes('\\u003c/script>'));
    assert.ok(!r.body.includes("'*'"));
    assert.ok(r.body.includes('location.origin'));
  } finally { s.server.close(); }
});

test('callback: line separators in the message are escaped', async () => {
  const app = express();
  app.get('/cb', createHandler(googleAuth));
  const s = await listen(app);
  try {
    const r = await fetchRaw(s.port, '/cb?error=' + encodeURIComponent('a\u2028b\u2029c'));
    assert.ok(!r.body.includes('\u2028') && !r.body.includes('\u2029'));
  } finally { s.server.close(); }
});

test('callback: the exchange-error branch is escaped and has the CSP too', async () => {
  const state = new URL(await withClient(() => googleAuth.getAuthUrl(['openid'], 'http://x/cb'))).searchParams.get('state');
  const fake = { consumeState: googleAuth.consumeState, exchangeCode: async () => { throw new Error('</script><script>y</script>'); } };
  const app = express();
  app.get('/cb', createHandler(fake));
  const s = await listen(app);
  try {
    const r = await fetchRaw(s.port, `/cb?code=c&state=${state}`);
    assert.match(r.headers['content-security-policy'], /script-src 'nonce-/);
    assert.equal(r.body.match(/<script/g).length, 1);
    assert.equal(r.body.match(/<\/script/g).length, 1);
  } finally { s.server.close(); }
});

// getAuthUrl needs a configured client id; set one without touching disk.
async function withClient(fn) {
  let held = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'secret', accounts: {} };
  googleAuth.init('/tmp/does-not-exist', { readSecretFile: () => held, writeSecretFile: (_p, d) => { held = d; } });
  return fn();
}

test('callback: missing or unknown state is rejected without an exchange; a valid one works once', async () => {
  let exchanged = 0;
  const fake = { consumeState: googleAuth.consumeState, exchangeCode: async () => { exchanged++; return { email: 'a@b.c', grantedScopes: ['s'] }; } };
  const app = express();
  app.get('/cb', createHandler(fake));
  const s = await listen(app);
  try {
    let r = await fetchRaw(s.port, '/cb?code=abc');
    assert.equal(r.status, 400);
    r = await fetchRaw(s.port, '/cb?code=abc&state=forged');
    assert.equal(r.status, 400);
    assert.equal(exchanged, 0);
    const state = new URL(await withClient(() => googleAuth.getAuthUrl(['openid'], 'http://x/cb'))).searchParams.get('state');
    assert.match(state, /^[0-9a-f]{48}$/);
    r = await fetchRaw(s.port, `/cb?code=abc&state=${state}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('google-auth-success'));
    assert.equal(exchanged, 1);
    r = await fetchRaw(s.port, `/cb?code=abc&state=${state}`); // single use
    assert.equal(r.status, 400);
    assert.equal(exchanged, 1);
  } finally { s.server.close(); }
});

// ------------------------------------------------------------------ F2 strip

test('proxyToApp: no x-vistaclair-* header reaches the app process', async () => {
  let seen;
  const up = await listen((req, res) => { seen = req.headers; res.end('ok'); });
  const app = express();
  app.use('/apps', (req, res) => proxyToApp(req, res, up.port, req.url));
  const s = await listen(app);
  try {
    await fetchRaw(s.port, '/apps/x', {
      'x-vistaclair-internal': TOKEN, 'X-Vistaclair-Peer-Token': 'p', 'x-vistaclair-cron-sig': 'c', 'x-other': 'keep',
    });
    assert.ok(!Object.keys(seen).some((k) => k.startsWith('x-vistaclair-')));
    assert.equal(seen['x-other'], 'keep');
    assert.ok(!JSON.stringify(seen).includes(TOKEN));
  } finally { s.server.close(); up.server.close(); }
});

test('in-process router: header gone for app code, guard still resolves the call as owner', async () => {
  const { buildCtx } = require('../src/apps/capabilities/identity');
  const ownerAware = internalHeaders.ownerAware(fakeCoreIsOwner);
  appManager.setOwnerCheck(ownerAware);
  const { identity } = buildCtx({ name: 'demo' });
  const router = express.Router();
  let seen;
  router.get('/api/who', (req, res) => {
    seen = { headers: { ...req.headers }, raw: [...req.rawHeaders] };
    res.json({ resolved: identity.resolve(req) });
  });
  const saved = appManager.getMountedRouter;
  appManager.getMountedRouter = (n) => (n === 'demo' ? router : null);
  const app = express();
  app.use('/apps', appsDispatcher({ isOwnerRequest: fakeCoreIsOwner }));
  const s = await listen(app);
  try {
    // internal call → owner, header absent from both headers and rawHeaders
    let r = await fetchRaw(s.port, '/apps/demo/api/who', { 'x-vistaclair-internal': TOKEN });
    assert.deepEqual(JSON.parse(r.body).resolved, { userId: null, via: 'owner' });
    assert.ok(!Object.keys(seen.headers).some((k) => k.startsWith('x-vistaclair-')));
    assert.ok(!seen.raw.some((v) => String(v).includes(TOKEN) || /^x-vistaclair-/i.test(v)));
    // no / wrong credential → not owner
    r = await fetchRaw(s.port, '/apps/demo/api/who', { 'x-vistaclair-internal': 'nope' });
    assert.equal(JSON.parse(r.body).resolved, null);
    // a client cannot assert ownership by sending anything shaped like the marker
    r = await fetchRaw(s.port, '/apps/demo/api/who', { '_vcOwner': 'true', 'x-vcowner': 'true' });
    assert.equal(JSON.parse(r.body).resolved, null);
  } finally { s.server.close(); appManager.getMountedRouter = saved; appManager.setOwnerCheck(null); }
});

// ------------------------------------------------------------------ cron

test('platform cron: an own-process app gets its cron signature and never AUTH_TOKEN', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const cron = require('../src/apps/platform-cron');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-cron-'));
  let seen;
  const up = await listen((req, res) => { seen = req.headers; res.end('{}'); });
  const fakeMgr = {
    readManifest: () => ({}),
    getMountedRouter: () => null,
    getRunningApp: () => ({ port: up.port }),
    getCronSecret: () => 'per-app-secret',
  };
  cron.init({ appsDir: dir, appManager: fakeMgr, authToken: TOKEN });
  try {
    const add = cron.addJob({ name: 'n', schedule: 'every 3600 seconds', enabled: false, target: { type: 'app-api', app: 'demo', path: '/api/cron/nudges' } });
    const id = add.jobId;
    const r = await cron.runNow(id);
    assert.equal(r.ok, true);
    assert.equal(seen['x-vistaclair-cron-sig'], 'per-app-secret');
    assert.equal(seen['x-vistaclair-cron'], 'true');
    assert.ok(!seen['x-vistaclair-internal']);
    assert.ok(!JSON.stringify(seen).includes(TOKEN));
  } finally { cron.shutdown(); up.server.close(); }
});

test('platform cron: an in-process app is reached through the dashboard, which strips the credential', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const cron = require('../src/apps/platform-cron');
  const { buildCtx } = require('../src/apps/capabilities/identity');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-cron-'));
  appManager.setOwnerCheck(internalHeaders.ownerAware(fakeCoreIsOwner));
  const { identity } = buildCtx({ name: 'demo' });
  const router = express.Router();
  let seen, via;
  router.post('/api/cron/nudges', (req, res) => { seen = { ...req.headers }; via = identity.resolve(req)?.via; res.json({ ok: 1 }); });
  const saved = appManager.getMountedRouter;
  appManager.getMountedRouter = (n) => (n === 'demo' ? router : null);
  const app = express();
  app.use('/apps', appsDispatcher({ isOwnerRequest: fakeCoreIsOwner }));
  const s = await listen(app);
  const prevPort = process.env.DASHBOARD_PORT;
  process.env.DASHBOARD_PORT = String(s.port);
  cron.init({ appsDir: dir, appManager: { readManifest: () => ({}), getMountedRouter: appManager.getMountedRouter, getRunningApp: () => null }, authToken: TOKEN });
  try {
    const add = cron.addJob({ name: 'n2', schedule: 'every 3600 seconds', enabled: false, target: { type: 'app-api', app: 'demo', path: '/api/cron/nudges' } });
    const r = await cron.runNow(add.jobId);
    assert.equal(r.ok, true, r.error);
    assert.equal(via, 'owner');
    assert.ok(!Object.keys(seen).some((k) => k.startsWith('x-vistaclair-')));
  } finally {
    cron.shutdown(); s.server.close(); appManager.getMountedRouter = saved; appManager.setOwnerCheck(null);
    if (prevPort === undefined) delete process.env.DASHBOARD_PORT; else process.env.DASHBOARD_PORT = prevPort;
  }
});

// ------------------------------------------------------------------ db.status

test('db.status: no password (Bridge / Horst); the owner-UI variant is separate', async () => {
  const appDb = require('../src/apps/app-db');
  const real = Object.getOwnPropertyDescriptor(appDb, 'status');
  assert.ok(real);
  const s = appDb.status();
  assert.ok(!('password' in (s.config || {})));
  const via = await require('../src/apps/capabilities/db').bridge['db.status']();
  assert.ok(!JSON.stringify(via).includes('password'));
});
