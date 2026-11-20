// Who may act on a cross-app change request (src/apps/app-change-request-routes.js).
//
// A session token (core's src/session-tokens.js) names ONE session. After the
// gate, a session caller is req.vcSession = { instanceId, scopes }; an owner
// caller (dashboard cookie / owner token) has none. The rule these tests hold:
//   - a session acts only as itself: the instance id is the token's, never the
//     body's (a different one in the body is refused);
//   - status / wait: the sender or the target of that request; cancel: the
//     sender; done: the target; anyone else gets 403;
//   - an owner caller keeps the old behaviour on every route.
//
// The gate is a stand-in for core's: it reads the session header, looks it up
// and (like core's `check`) refuses a body/query instanceId that differs and
// writes the token's own into the parsed body. `bindBody: false` is a gate that
// leaves the body alone — Pro must then bind the identity by itself. Core's
// global express.json (server.js:162) runs before its gate, so in the real
// server the body is bound there; Pro's own binding is the second line.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const cr = require('../src/apps/app-change-requests');
const appDeps = require('../src/apps/app-deps');
const { mountApi } = require('../src/apps/app-change-request-routes');

const APPS = ['alpha', 'beta', 'gamma'];
const TOKENS = { 'vcs_alpha': 'cli-alpha', 'vcs_beta': 'cli-beta', 'vcs_gamma': 'cli-gamma' };
const READING = { name: 'current_reading', description: 'x', expose: 'apps', inputSchema: { type: 'object', properties: {} } };

async function setup({ bindBody = true } = {}) {
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-crsec-'));
  const appsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-crsec-apps-'));
  const proDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-crsec-pro-'));
  const launches = [];
  const sessions = new Map(APPS.map((a) => [`cli-${a}`, { tabId: `app-${a}`, sessId: `sess-${a}` }]));
  const appManager = {
    APPS_DIR: appsDir,
    list: () => APPS.map((name) => ({ name })),
    readManifest: (name) => (APPS.includes(name) ? { name, tools: name === 'beta' ? [READING] : [] } : null),
  };
  cr.init({
    dataHome, proDir,
    cliSessionManager: {
      get: () => null,
      list: () => [],
      getByInstanceId: (id) => {
        const s = sessions.get(id);
        return s ? { tabId: s.tabId, sessId: s.sessId, getSettings: () => ({}) } : null;
      },
      writeWhenReady: () => {},
    },
    appManager,
    launchChangeSession: (app) => { launches.push(app); return { tabId: `app-${app}` }; },
    broadcaster: { broadcast: () => {} },
    toolUnion: () => [],
    settings: { get: (k) => (k === 'changeRequestMaxDepth' ? 1 : undefined) },
    capabilities: { get: () => null, all: () => [], capabilityKeyForMethod: () => null },
    readCapability: () => null,
    addExitHook: () => {},
  });
  appDeps.init({ dataHome, appManager, settings: { get: () => undefined }, broadcaster: { broadcast: () => {} } });

  const app = express();
  app.use(express.json({ limit: '50mb' })); // core's global parser (server.js:162), before its gate
  app.use((req, res, next) => {
    const tok = req.headers['x-vistaclair-session'];
    if (!tok) return next(); // owner caller: no req.vcSession
    const instanceId = TOKENS[tok];
    if (!instanceId) return res.status(401).json({ error: 'Unauthorized' });
    if (bindBody) {
      const named = req.body && typeof req.body === 'object' ? req.body.instanceId : undefined;
      if (named !== undefined && named !== null && named !== instanceId) {
        return res.status(403).json({ error: 'Session token is bound to another session' });
      }
      if (req.body && typeof req.body === 'object') req.body.instanceId = instanceId;
    }
    req.vcSession = { ok: true, instanceId, scopes: ['session'] };
    next();
  });
  const router = express.Router();
  mountApi(router, express);
  app.use(router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = server.address().port;

  // as: 'alpha' | 'beta' | 'gamma' (a session of that app) | null (owner).
  const call = (as, method, urlPath, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method,
      headers: {
        ...(as ? { 'x-vistaclair-session': `vcs_${as}` } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch {} resolve({ status: res.statusCode, json }); });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });

  const ctx = {
    call, launches, sessions,
    // alpha asks beta for a tool; the owner opens it -> `launched` (beta's session reports done).
    async launched() {
      const r = await call('alpha', 'POST', '/pro/apps/change-requests', {
        instanceId: 'cli-alpha', to: 'beta', prompt: 'expose current_reading please',
        interface: { kind: 'tool', name: 'current_reading' }, reason: 'r',
      });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const d = cr.decide(r.json.id, { ok: true });
      assert.ok(d.ok !== false, JSON.stringify(d));
      assert.equal(cr._internals.byId(r.json.id).state, 'launched');
      return r.json.id;
    },
    state: (id) => cr._internals.byId(id).state,
    requestsFrom: (app) => cr.list().filter((r) => r.from === app),
    async close() {
      await new Promise((r) => server.close(r));
      for (const d of [dataHome, appsDir, proDir]) fs.rmSync(d, { recursive: true, force: true });
    },
  };
  return ctx;
}

const withEnv = (opts, fn) => async (t) => {
  const h = await setup(opts);
  t.after(h.close);
  await fn(h, t);
};
const crPath = (id, tail = '') => `/pro/apps/change-requests/${id}${tail}`;

// ---- the gaps: a session that is neither sender nor target ------------------------

test('a third session cannot read the status of another session\'s request', withEnv({}, async (h) => {
  const id = await h.launched();
  const r = await h.call('gamma', 'GET', crPath(id));
  assert.equal(r.status, 403, `status leaked: ${JSON.stringify(r.json)}`);
  assert.equal(r.json.prompt, undefined);
}));

test('a third session cannot wait on another session\'s request', withEnv({}, async (h) => {
  const id = await h.launched();
  cr.cancel(id, 'owner'); // terminal: a wait answers at once
  const r = await h.call('gamma', 'GET', crPath(id, '/wait?timeoutMs=1000'));
  assert.equal(r.status, 403, `wait leaked: ${JSON.stringify(r.json)}`);
}));

test('a third session cannot cancel another session\'s request', withEnv({}, async (h) => {
  const id = await h.launched();
  const r = await h.call('gamma', 'POST', crPath(id, '/cancel'), {});
  assert.equal(r.status, 403);
  assert.equal(h.state(id), 'launched', 'the request was cancelled by a stranger');
}));

test('a third session cannot mark another session\'s request done', withEnv({}, async (h) => {
  const id = await h.launched();
  const r = await h.call('gamma', 'POST', crPath(id, '/done'), { summary: 'forged' });
  assert.equal(r.status, 403);
  assert.equal(h.state(id), 'launched');
}));

test('the sender cannot mark its own request done, the target cannot cancel it', withEnv({}, async (h) => {
  const id = await h.launched();
  assert.equal((await h.call('alpha', 'POST', crPath(id, '/done'), { summary: 'x' })).status, 403);
  assert.equal((await h.call('beta', 'POST', crPath(id, '/cancel'), {})).status, 403);
  assert.equal(h.state(id), 'launched');
}));

// ---- the gaps: the instance id in the body ---------------------------------------

test('a session cannot file a request under another session\'s instance id (gate binds the body)', withEnv({}, async (h) => {
  const r = await h.call('gamma', 'POST', '/pro/apps/change-requests', {
    instanceId: 'cli-alpha', to: 'beta', prompt: 'forged', interface: { kind: 'tool', name: 't' },
  });
  assert.equal(r.status, 403);
  assert.equal(h.requestsFrom('alpha').length, 0);
}));

test('a session cannot file a request under another session\'s instance id (gate leaves the body)', withEnv({ bindBody: false }, async (h) => {
  const r = await h.call('gamma', 'POST', '/pro/apps/change-requests', {
    instanceId: 'cli-alpha', to: 'beta', prompt: 'forged', interface: { kind: 'tool', name: 't' },
  });
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.equal(h.requestsFrom('alpha').length, 0, 'a request was filed as alpha');
}));

test('with a gate that leaves the body alone, the identity is the token\'s', withEnv({ bindBody: false }, async (h) => {
  const r = await h.call('gamma', 'POST', '/pro/apps/change-requests', {
    to: 'beta', prompt: 'mine', interface: { kind: 'tool', name: 't' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(h.requestsFrom('gamma').length, 1);
}));

test('a session cannot declare a dependency under another session\'s instance id', withEnv({ bindBody: false }, async (h) => {
  const r = await h.call('gamma', 'POST', '/pro/apps/deps/depend', {
    instanceId: 'cli-alpha', on: 'beta', tools: ['current_reading'], why: 'forged',
  });
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.equal(appDeps.list ? appDeps.list().filter((e) => e.consumer === 'alpha').length : 0, 0);
}));

test('a session declares a dependency as itself, with or without the instance id in the body', withEnv({ bindBody: false }, async (h) => {
  const own = await h.call('gamma', 'POST', '/pro/apps/deps/depend', { instanceId: 'cli-gamma', on: 'beta', tools: ['current_reading'], why: 'mine' });
  assert.equal(own.status, 200, JSON.stringify(own.json));
  assert.equal(own.json.edge.consumer, 'gamma');
  const bare = await h.call('alpha', 'POST', '/pro/apps/deps/depend', { on: 'beta', tools: ['current_reading'], why: 'mine' });
  assert.equal(bare.status, 200, JSON.stringify(bare.json));
  assert.equal(bare.json.edge.consumer, 'alpha');
}));

// ---- unchanged: the normal flow of a session ---------------------------------------

test('a session completes the normal flow: request, wait, done by the target, status', withEnv({}, async (h) => {
  const id = await h.launched();
  assert.equal((await h.call('alpha', 'GET', crPath(id))).status, 200);
  assert.equal((await h.call('beta', 'GET', crPath(id))).status, 200, 'the target may read the status');
  const parked = h.call('alpha', 'GET', crPath(id, '/wait?timeoutMs=5000'));
  const park2 = h.call('beta', 'GET', crPath(id, '/wait?timeoutMs=1000'));
  await new Promise((r) => setTimeout(r, 100));
  const done = await h.call('beta', 'POST', crPath(id, '/done'), { instanceId: 'cli-beta', summary: 'exported current_reading' });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.state, 'done');
  const w = await parked;
  assert.equal(w.status, 200);
  assert.equal(w.json.state, 'done');
  await park2;
  const s = await h.call('alpha', 'GET', crPath(id));
  assert.equal(s.status, 200);
  assert.equal(s.json.state, 'done');
}));

test('a session done with the id "latest" resolves from the caller', withEnv({}, async (h) => {
  const id = await h.launched();
  assert.equal((await h.call('gamma', 'POST', crPath('latest', '/done'), { summary: 'x' })).status, 400);
  const r = await h.call('beta', 'POST', crPath('latest', '/done'), { summary: 'x' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(h.state(id), 'done');
}));

test('the sender cancels its own request', withEnv({}, async (h) => {
  const id = await h.launched();
  const r = await h.call('alpha', 'POST', crPath(id, '/cancel'), { instanceId: 'cli-alpha' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(h.state(id), 'cancelled');
}));

test('an unknown request id is reported as unknown to a session', withEnv({}, async (h) => {
  const r = await h.call('gamma', 'GET', crPath('nope'));
  assert.equal(r.status, 200);
  assert.equal(r.json.state, 'unknown');
}));

// ---- unchanged: the owner path ---------------------------------------------------------

test('an owner caller keeps today\'s behaviour on every route', withEnv({ bindBody: false }, async (h) => {
  // request + depend name the instance in the body
  const asked = await h.call(null, 'POST', '/pro/apps/change-requests', {
    instanceId: 'cli-alpha', to: 'beta', prompt: 'owner path', interface: { kind: 'tool', name: 'current_reading' },
  });
  assert.equal(asked.status, 200, JSON.stringify(asked.json));
  const id = asked.json.id;
  assert.equal(h.requestsFrom('alpha').length, 1);
  const dep = await h.call(null, 'POST', '/pro/apps/deps/depend', { instanceId: 'cli-gamma', on: 'beta', tools: ['current_reading'], why: 'owner' });
  assert.equal(dep.status, 200, JSON.stringify(dep.json));
  assert.equal(dep.json.edge.consumer, 'gamma');
  // status, wait, done, cancel by anyone without a session
  assert.equal((await h.call(null, 'GET', crPath(id))).json.state, 'pending');
  cr.decide(id, { ok: true });
  assert.equal((await h.call(null, 'POST', crPath(id, '/done'), { instanceId: 'cli-beta', summary: 'ok' })).status, 200);
  assert.equal((await h.call(null, 'GET', crPath(id, '/wait?timeoutMs=1000'))).json.state, 'done');
  const second = await h.call(null, 'POST', '/pro/apps/change-requests', {
    instanceId: 'cli-alpha', to: 'gamma', prompt: 'again', interface: { kind: 'tool', name: 'x' },
  });
  assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.equal((await h.call(null, 'POST', crPath(second.json.id, '/cancel'), {})).status, 200);
  assert.equal(h.state(second.json.id), 'cancelled');
}));
