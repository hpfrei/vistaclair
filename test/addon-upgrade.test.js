// Add-on auth-exempt WebSocket upgrade paths (authExemptUpgradePaths) through
// the same upgrade handler server.js installs (addons.createUpgradeHandler):
// an exempt exact pathname goes to its add-on only, without the owner gate;
// a refused or throwing exempt upgrade is a 401 that never reaches the
// dashboard wss; everything else is owner gate → add-ons → wss as before.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { WebSocketServer } = require('ws');
const addons = require('../src/addons');

const PEER = '/api/peer/channel';

// A throwaway server on an ephemeral port with the real handler. "Owner" is
// faked as an x-owner header; every server-side upgrade socket is recorded.
async function startServer(t) {
  const wss = new WebSocketServer({ noServer: true });
  const wssPaths = [];
  const realHandle = wss.handleUpgrade.bind(wss);
  wss.handleUpgrade = (req, ...rest) => { wssPaths.push(req.url); return realHandle(req, ...rest); };
  wss.on('connection', ws => ws.close());

  const ownerChecks = [];
  const handler = addons.createUpgradeHandler({
    isOwnerUpgrade: (req) => { ownerChecks.push(req.url); return req.headers['x-owner'] === '1'; },
    wss,
  });
  const sockets = [];
  const server = http.createServer((req, res) => res.end());
  server.on('upgrade', (req, socket, head) => { sockets.push(socket); handler(req, socket, head); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { wss.close(); server.closeAllConnections?.(); server.close(() => r()); }));
  return { port: server.address().port, wssPaths, ownerChecks, sockets };
}

// One upgrade request → { status, headers }.
function upgrade(port, path, { owner = false } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    };
    if (owner) headers['x-owner'] = '1';
    const req = http.request({ host: '127.0.0.1', port, path, headers });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode, headers: res.headers }); });
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode, headers: res.headers }); });
    req.on('error', reject);
    req.end();
  });
}

// An add-on that claims upgrades with a marker 101 (or per `mode`) and records
// every path it was offered.
function addon(t, id, { exempt = [], mode = 'claim', claimPaths = null } = {}) {
  const seen = [];
  const d = {
    contractVersion: addons.CONTRACT_VERSION, id,
    authExemptUpgradePaths: exempt,
    handleUpgrade(req, socket) {
      seen.push(req.url);
      if (claimPaths && !claimPaths.includes(new URL(req.url, 'http://x').pathname)) return false;
      if (mode === 'false') return false;
      if (mode === 'throw') throw new Error('boom');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Marker: ${id}\r\n\r\n`);
      socket.destroy();
      return true;
    },
  };
  assert.ok(addons.registerAddon(d));
  t.after(() => addons.removeAddon(id));
  return { d, seen };
}

test('exempt exact path reaches its add-on without owner auth', async (t) => {
  const s = await startServer(t);
  const peer = addon(t, 't-peer', { exempt: [PEER] });
  const r = await upgrade(s.port, PEER);
  assert.strictEqual(r.status, 101);
  assert.strictEqual(r.headers['x-marker'], 't-peer');
  assert.deepStrictEqual(peer.seen, [PEER]);
  assert.deepStrictEqual(s.ownerChecks, [], 'no owner gate for an exempt upgrade');
  assert.deepStrictEqual(s.wssPaths, []);

  const q = await upgrade(s.port, PEER + '?x=1');
  assert.strictEqual(q.status, 101, 'query string is ignored');
  assert.strictEqual(addons.exemptUpgradeOwner({ url: PEER + '?x=1' }), peer.d);
});

test('non-exempt paths without auth are 401', async (t) => {
  const s = await startServer(t);
  const peer = addon(t, 't-peer', { exempt: [PEER] });
  for (const p of ['/', '/ws', PEER + '/x', PEER + 'x', '/api/peer']) {
    const r = await upgrade(s.port, p);
    assert.strictEqual(r.status, 401, p);
  }
  assert.deepStrictEqual(peer.seen, [], 'add-on not offered unauthenticated non-exempt upgrades');
  assert.deepStrictEqual(s.wssPaths, []);
  assert.strictEqual(addons.exemptUpgradeOwner({ url: PEER + '/x' }), null);
  assert.strictEqual(addons.exemptUpgradeOwner({ url: PEER + 'x' }), null);
  assert.strictEqual(addons.exemptUpgradeOwner({ url: 'http://[bad' }), null, 'malformed URL is not exempt');
});

for (const mode of ['false', 'throw']) {
  test(`exempt add-on that ${mode === 'false' ? 'returns false' : 'throws'} → 401, no fallthrough`, async (t) => {
    const s = await startServer(t);
    const other = addon(t, 't-other');               // would claim anything it is offered
    const peer = addon(t, 't-peer', { exempt: [PEER], mode });
    const origErr = console.error; console.error = () => {};
    t.after(() => { console.error = origErr; });
    for (const owner of [false, true]) {
      const r = await upgrade(s.port, PEER, { owner });
      assert.strictEqual(r.status, 401, `owner=${owner}`);
      assert.ok(s.sockets.at(-1).destroyed, 'socket destroyed');
    }
    assert.deepStrictEqual(peer.seen, [PEER, PEER]);
    assert.deepStrictEqual(other.seen, [], 'other add-ons not offered an exempt upgrade');
    assert.deepStrictEqual(s.wssPaths, [], 'dashboard wss not reached');
    assert.deepStrictEqual(s.ownerChecks, [], 'exempt upgrades never go through the owner gate');
  });
}

test('exempt path declared by an add-on without handleUpgrade → 401', async (t) => {
  const s = await startServer(t);
  addons.registerAddon({ contractVersion: addons.CONTRACT_VERSION, id: 't-nohandler', authExemptUpgradePaths: [PEER] });
  t.after(() => addons.removeAddon('t-nohandler'));
  const r = await upgrade(s.port, PEER, { owner: true });
  assert.strictEqual(r.status, 401);
  assert.deepStrictEqual(s.wssPaths, []);
});

test('owner upgrades unchanged: owner gate → add-ons → dashboard wss', async (t) => {
  const s = await startServer(t);
  const peer = addon(t, 't-peer', { exempt: [PEER], claimPaths: ['/pro/vnc'] });

  const vnc = await upgrade(s.port, '/pro/vnc', { owner: true });
  assert.strictEqual(vnc.status, 101);
  assert.strictEqual(vnc.headers['x-marker'], 't-peer', 'exempt-declaring add-on still sees owner upgrades via the normal loop');

  const dash = await upgrade(s.port, '/', { owner: true });
  assert.strictEqual(dash.status, 101);
  assert.strictEqual(dash.headers['x-marker'], undefined);
  assert.deepStrictEqual(s.wssPaths, ['/'], 'unclaimed owner upgrade reaches the dashboard wss');
  assert.deepStrictEqual(peer.seen, ['/pro/vnc', '/']);
  assert.deepStrictEqual(s.ownerChecks, ['/pro/vnc', '/']);
});

test('removeAddon drops the exemption', async (t) => {
  const s = await startServer(t);
  addon(t, 't-peer', { exempt: [PEER] });
  assert.strictEqual((await upgrade(s.port, PEER)).status, 101);
  addons.removeAddon('t-peer');
  assert.strictEqual(addons.exemptUpgradeOwner({ url: PEER }), null);
  assert.strictEqual((await upgrade(s.port, PEER)).status, 401);
  assert.deepStrictEqual(s.wssPaths, []);
});
