// The session-facing half: scripts/app-change.js. What matters here is the exit
// code (the session reads it to decide what to do next), that the outcome
// sentence is printed before any JSON, and that a platform restart mid-wait is
// retried rather than reported as an answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'app-change.js');
const TOKEN = 'test-token';

// A stand-in for the platform: `routes` maps "METHOD /path-prefix" to a handler.
function stubServer(routes) {
  const server = http.createServer((req, res) => {
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ');
      return req.method === m && req.url.split('?')[0].startsWith(p);
    });
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (!key) { res.writeHead(404).end('{}'); return; }
      if (req.headers['x-vistaclair-internal'] !== TOKEN) { res.writeHead(401).end('{}'); return; }
      const out = routes[key]({ url: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(out.status || 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json || {}));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function run(server, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: {
        ...process.env,
        VISTACLAIR_DASHBOARD_PORT: server ? String(server.address().port) : '1',
        VISTACLAIR_AUTH_TOKEN: TOKEN,
        VISTACLAIR_INSTANCE_ID: 'cli-alpha',
        ...env,
      },
    });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const REQ = ['request', '--to', 'beta', '--prompt', 'expose a reading tool', '--tool', 'current_reading', '--reason', 'alpha needs it'];

test('outside a change session the script refuses rather than guessing', async () => {
  const r = await run(null, REQ, { VISTACLAIR_INSTANCE_ID: '' });
  assert.equal(r.code, 4);
  assert.match(r.err, /must run inside an app change session/);
});

test('a request without a named interface is refused before the platform is touched', async () => {
  const r = await run(null, ['request', '--to', 'beta', '--prompt', 'x']);
  assert.equal(r.code, 4);
  assert.match(r.err, /--tool <name> or --event <kind>/);
});

test('a completed request exits 0 and prints the outcome before any JSON', async (t) => {
  const server = await stubServer({
    'POST /pro/apps/change-requests': () => ({ json: { id: 'cr-1', state: 'pending' } }),
    'GET /pro/apps/change-requests': () => ({ json: { id: 'cr-1', state: 'done', verified: true, text: 'Change request cr-1 is done. "beta" now provides the tool.' } }),
  });
  t.after(() => server.close());
  const r = await run(server, REQ);
  assert.equal(r.code, 0);
  const lines = r.out.trim().split('\n');
  assert.match(lines[0], /Change request cr-1 submitted/);
  assert.match(r.out, /is done\. "beta" now provides the tool\./);
  assert.match(lines[lines.length - 1], /^\{/, 'the machine-readable line comes last');
});

test('a denial is its own exit code, so the session does not read it as success', async (t) => {
  const server = await stubServer({
    'POST /pro/apps/change-requests': () => ({ json: { id: 'cr-2', state: 'pending' } }),
    'GET /pro/apps/change-requests': () => ({ json: { id: 'cr-2', state: 'denied', text: 'Change request cr-2 to "beta" was denied by the owner: not here.' } }),
  });
  t.after(() => server.close());
  const r = await run(server, REQ);
  assert.equal(r.code, 2);
  assert.match(r.out, /denied by the owner: not here/);
});

test('an ended or cancelled request exits 3', async (t) => {
  for (const state of ['ended', 'cancelled']) {
    const server = await stubServer({
      'POST /pro/apps/change-requests': () => ({ json: { id: 'cr-3', state: 'pending' } }),
      'GET /pro/apps/change-requests': () => ({ json: { id: 'cr-3', state, text: `Change request cr-3 ${state}.` } }),
    });
    const r = await run(server, REQ);
    server.close();
    assert.equal(r.code, 3, state);
  }
});

test('a refusal from the platform is reported, not retried forever', async (t) => {
  const server = await stubServer({
    'POST /pro/apps/change-requests': () => ({ status: 400, json: { error: 'the owner already denied this request: no' } }),
  });
  t.after(() => server.close());
  const r = await run(server, REQ);
  assert.equal(r.code, 4);
  assert.match(r.err, /already denied/);
});

test('a dashboard restart mid-wait is retried, not read as an answer', async (t) => {
  // The first poll dies with the connection — the platform restarting, not an
  // answer. The script must back off and come back rather than give up.
  let polls = 0;
  const server = await stubServer({
    'POST /pro/apps/change-requests': () => ({ json: { id: 'cr-4', state: 'pending' } }),
    'GET /pro/apps/change-requests': () => ({ json: { id: 'cr-4', state: 'done', verified: true, text: 'done at last' } }),
  });
  server.prependListener('request', (req) => {
    if (req.method === 'GET' && ++polls === 1) req.socket.destroy();
  });
  t.after(() => server.close());
  const r = await run(server, REQ);
  assert.equal(r.code, 0);
  assert.match(r.out, /done at last/);
  assert.equal(polls, 2, 'exactly one retry was needed');
});

test('--no-wait returns at once and leaves delivery to the platform', async (t) => {
  const server = await stubServer({
    'POST /pro/apps/change-requests': ({ body }) => {
      assert.equal(body.wait, false);
      return { json: { id: 'cr-5', state: 'pending', targetBusy: true, note: '"beta" has a change session open — the owner is being offered to inject this request into it.' } };
    },
  });
  t.after(() => server.close());
  const r = await run(server, [...REQ, '--no-wait']);
  assert.equal(r.code, 0);
  assert.match(r.out, /has a change session open.*inject/);
  assert.match(r.out, /Not waiting/);
});

test('done reports whether the platform could actually see the interface', async (t) => {
  const server = await stubServer({
    'POST /pro/apps/change-requests': () => ({ json: {} }),
    'GET /pro': () => ({ json: {} }),
  });
  t.after(() => server.close());

  const ok = await stubServer({ 'POST /pro/apps/change-requests': () => ({ json: { ok: true, verified: true } }) });
  let r = await run(ok, ['done', '--id', 'cr-6', '--summary', 'exposed current_reading']);
  ok.close();
  assert.equal(r.code, 0);
  assert.match(r.out, /verified the interface is live/);

  const notYet = await stubServer({ 'POST /pro/apps/change-requests': () => ({ json: { ok: true, verified: false } }) });
  r = await run(notYet, ['done', '--id', 'cr-6', '--summary', 'exposed current_reading']);
  notYet.close();
  assert.equal(r.code, 0);
  assert.match(r.out, /UNVERIFIED: the platform could NOT see the interface .*— restart this app/);

  r = await run(server, ['done', '--id', 'cr-6']);
  assert.equal(r.code, 4);
  assert.match(r.err, /--summary/);
});

// --- Asking the platform ---------------------------------------------------

const PLAT = ['request', '--to', 'platform', '--prompt', 'email.list cannot sort oldest-first',
  '--method', 'email.list', '--adds', 'order', '--reason', 'alpha renders a digest'];

test('a platform request without a method or a ctx member is refused locally', async () => {
  const r = await run(null, ['request', '--to', 'platform', '--prompt', 'x']);
  assert.equal(r.code, 4);
  assert.match(r.err, /--method <bridge\.method> or --ctx <member\.path>/);
  // The app vocabulary is not the platform vocabulary.
  const r2 = await run(null, ['request', '--to', 'platform', '--prompt', 'x', '--tool', 'current_reading']);
  assert.equal(r2.code, 4);
  assert.match(r2.err, /--method/);
});

test('a platform request carries the interface kind and the capability hint', async (t) => {
  let seen = null;
  const server = await stubServer({
    'POST /pro/apps/change-requests': ({ body }) => {
      seen = body;
      return { json: { id: 'cr-p1', state: 'pending', capability: 'email' } };
    },
  });
  t.after(() => server.close());
  const r = await run(server, [...PLAT, '--capability', 'email', '--no-wait']);
  assert.equal(r.code, 0);
  assert.deepEqual(seen.interface, { kind: 'method', name: 'email.list' });
  assert.equal(seen.to, 'platform');
  assert.equal(seen.capability, 'email');
  assert.deepEqual(seen.adds, ['order']);
  assert.match(r.out, /on the platform \(capability "email"\) for the method "email\.list"/);
});

test('a ctx member is the other way to name a platform surface', async (t) => {
  let seen = null;
  const server = await stubServer({
    'POST /pro/apps/change-requests': ({ body }) => { seen = body; return { json: { id: 'cr-p2', state: 'pending' } }; },
  });
  t.after(() => server.close());
  const r = await run(server, ['request', '--to', 'platform', '--prompt', 'x', '--ctx', 'email.list', '--no-wait']);
  assert.equal(r.code, 0);
  assert.deepEqual(seen.interface, { kind: 'ctx', name: 'email.list' });
});

test('done from a platform session says the restart is the owner\'s, not this session\'s', async (t) => {
  const ok = await stubServer({
    'POST /pro/apps/change-requests': () => ({ json: { ok: true, to: 'platform', capability: 'email', verified: true } }),
  });
  let r = await run(ok, ['done', '--id', 'cr-p1', '--summary', 'order added to email.list']);
  ok.close();
  assert.equal(r.code, 0);
  assert.match(r.out, /takes effect at the next control-room restart/);
  assert.doesNotMatch(r.out, /restart this app/);

  const notYet = await stubServer({
    'POST /pro/apps/change-requests': () => ({ json: { ok: true, to: 'platform', verified: false, verifyDetail: 'the API reference section for `email` does not document `order`' } }),
  });
  r = await run(notYet, ['done', '--id', 'cr-p1', '--summary', 'order added']);
  notYet.close();
  assert.equal(r.code, 0);
  assert.match(r.out, /did NOT find the change in the capability module/);
  assert.match(r.out, /does not document `order`/);
});

test('a done whose check failed is its own exit code, and the JSON says unverified', async (t) => {
  const server = await stubServer({
    'POST /pro/apps/change-requests': () => ({ json: { id: 'cr-u', state: 'pending' } }),
    'GET /pro/apps/change-requests': () => ({ json: { id: 'cr-u', state: 'done', outcome: 'unverified', verified: false, verifyDetail: 'the tool is not registered', text: 'Change request cr-u is UNVERIFIED: "beta" reported it done, but …' } }),
  });
  t.after(() => server.close());
  const r = await run(server, REQ);
  assert.equal(r.code, 5);
  assert.match(r.out, /is UNVERIFIED/);
  const json = JSON.parse(r.out.trim().split('\n').pop());
  assert.equal(json.outcome, 'unverified');
  assert.equal(json.verifyDetail, 'the tool is not registered');

  // A record with no outcome field (a server or record from before it) is read
  // off `verified`.
  const old = await stubServer({
    'GET /pro/apps/change-requests': () => ({ json: { id: 'cr-o', state: 'done', verified: false } }),
  });
  t.after(() => old.close());
  const s = await run(old, ['status', '--id', 'cr-o']);
  assert.equal(s.code, 5);
  assert.match(s.out, /done, but UNVERIFIED/);
});
