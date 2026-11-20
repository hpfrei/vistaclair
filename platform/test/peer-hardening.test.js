// Federation hardening: peer-supplied strings never reach a shell, the status
// probe sends no core token, https-only for pairing and the peer token,
// /register limits and no overwrite of a pending request, owner-only approval
// of fleet kinds, an inert token until approval, and no redirect with the token.
// In-process fakes only; execFile is stubbed before the peer modules load.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

// --- execFile spy (must precede the requires below) --------------------------
const gitCalls = [];
const realExecFile = cp.execFile;
cp.execFile = function stub(cmd, args, opts, cb) {
  if (cmd !== 'git') return realExecFile.apply(this, arguments);
  gitCalls.push({ cmd, args });
  const out = args[0] === 'rev-parse' ? 'a'.repeat(40) + '\n' : '3\n';
  const done = typeof opts === 'function' ? opts : cb;
  process.nextTick(() => done(null, { stdout: out, stderr: '' }));
  return {};
};

const express = require('express');
const { makeAppsDir } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const hostConfig = require('../src/apps/host-config');
const pairing = require('../src/apps/peer-pairing');
const peerChannel = require('../src/apps/peer-channel');
const peerClient = require('../src/apps/peer-client');
const peerServer = require('../src/apps/peer-server');
const security = require('../src/apps/peer-security');
const governance = require('../src/apps/governance/horst-governance');

const appsDir = makeAppsDir({ good: {} });
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-hard-'));
appManager.setAppsDir(appsDir);
hostConfig.init(appsDir, { dataHome });

const files = new Map();
const secretStore = {
  readSecretFile: (p, _d, o) => (files.has(p) ? JSON.parse(files.get(p)) : (o?.fallback ?? {})),
  writeSecretFile: (p, data) => { files.set(p, JSON.stringify(data)); },
};
const kinds = new Map();
governance.registerKind = (k, def) => kinds.set(k, def);
let proposalN = 0;
const proposals = [];
governance.createProposal = (kind, payload, meta) => { proposals.push({ kind, payload, meta }); return { id: `p${++proposalN}` }; };
pairing.init({ appsDir, secretStore, broadcaster: null });

test.after(() => {
  pairing.shutdown();
  peerChannel.shutdown();
  fs.rmSync(appsDir, { recursive: true, force: true });
});

const listen = (handler) => new Promise((resolve) => {
  const srv = http.createServer(handler).listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
});
const close = (srv) => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); });
const peersPath = () => path.join(appsDir, '.peers.enc');

// --- F1 -----------------------------------------------------------------------

test('F1: a hostile snapshot key is dropped and git runs via execFile with no shell', async () => {
  hostConfig.setRole('master');
  const marker = path.join(dataHome, 'pwned');
  files.set(peersPath(), JSON.stringify({ peers: [{ id: 'peer-1', name: 's1', baseUrl: 'https://s1.example', token: 'tok', pairedAt: 1 }], requests: [] }));
  const c = peerChannel._newConn({ name: 's1', baseUrl: 'https://s1.example', token: 'tok' });
  peerChannel._conns.set('s1', c);
  peerChannel._handleSlaveMessage(c, {
    t: 'hello',
    deployed: { [`x/; touch ${marker}; #`]: 'abcdef1', good: 'abcdef1', '../etc': 'abcdef1', badval: 'a; touch x' },
    apps: [{ name: '$(touch x)', health: 'ok' }, { name: 'good', health: 'ok' }],
    disabled: ['good', 'a b', '`id`'],
    domains: { good: 'good.example.com', '$(x)': 'evil.com', other: 'ev il.com' },
  });
  assert.deepEqual(Object.keys(c.snapshot.deployed), ['good']);
  assert.deepEqual(c.snapshot.apps.map((a) => a.name), ['good']);
  assert.deepEqual(c.snapshot.disabled, ['good']);
  assert.deepEqual(c.snapshot.domains, { good: 'good.example.com' });

  gitCalls.length = 0;
  const state = await peerChannel.fleetStateDetailed();
  assert.ok(gitCalls.length >= 2, 'git was called');
  for (const g of gitCalls) assert.ok(Array.isArray(g.args), 'argv array, no shell string');
  const revList = gitCalls.find((g) => g.args[0] === 'rev-list');
  assert.deepEqual(revList.args, ['rev-list', '--count', 'abcdef1..HEAD', '--', 'good/']);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(state.peers[0].deployed.good.behind, 3);
  peerChannel._conns.delete('s1');
});

// --- F2 -----------------------------------------------------------------------

test('F2: the status probe makes no HTTP self-fetch and sends no internal header', async () => {
  const token = 'peer-token-for-tests';
  files.set(path.join(appsDir, '.peer.enc'), JSON.stringify({ tokenHash: crypto.createHash('sha256').update(token).digest('hex') }));
  hostConfig.setRole('slave');
  hostConfig.setSlave({ name: 's', publicUrl: 'https://slave.example', linkStatus: 'linked' });
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...a) => { fetched.push(a); return realFetch(...a); };
  const realMounted = appManager.getMountedRouter;
  appManager.getMountedRouter = () => ({});
  const app = express();
  app.use('/api/peer', peerServer.createPeerRouter({ authToken: 'CORE_OWNER_TOKEN' }));
  const { srv, port } = await listen(app);
  try {
    const body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/peer/apps/good/status', headers: { 'x-vistaclair-peer-token': token } }, (res) => {
        let raw = ''; res.on('data', (d) => { raw += d; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(raw) }));
      }).on('error', reject);
    });
    assert.equal(body.status, 200);
    assert.equal(body.json.probe.source, 'app-manager');
    assert.equal(fetched.length, 0, 'no fetch at all');
    assert.ok(!JSON.stringify(fetched).includes('CORE_OWNER_TOKEN'));
  } finally {
    globalThis.fetch = realFetch;
    appManager.getMountedRouter = realMounted;
    await close(srv);
    hostConfig.setRole('master');
  }
});

// --- F3 -----------------------------------------------------------------------

test('F3: pairing refuses http:// (non-loopback) master and public URLs, accepts loopback', async () => {
  await assert.rejects(pairing.startPairing({ name: 's1', masterUrl: 'http://master.example', publicUrl: 'https://s.example' }), /https/);
  await assert.rejects(pairing.startPairing({ name: 's1', masterUrl: 'https://master.example', publicUrl: 'http://s.example' }), /https/);
  assert.equal(security.isSecureUrl('http://localhost:3457'), true);
  assert.equal(security.isSecureUrl('http://[::1]:3457'), true);
  assert.equal(security.isSecureUrl('http://127.0.0.1.evil.com'), false);
  assert.equal(security.isSecureUrl('ftp://x'), false);

  const { srv, port } = await listen((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/status') ? { status: 'pending' } : { id: 'pr-loop' }));
  });
  try {
    const r = await pairing.startPairing({ name: 's1', masterUrl: `http://127.0.0.1:${port}`, publicUrl: 'http://127.0.0.1:9' });
    assert.equal(r.id, 'pr-loop');
  } finally {
    pairing.resetPairing();
    await close(srv);
  }
});

test('F3: master registration refuses an http publicUrl', () => {
  const r = pairing.handleRegister({ name: 's1', publicUrl: 'http://evil.example', token: 't'.repeat(43), pollSecret: 'p'.repeat(43) });
  assert.equal(r.status, 400);
});

test('F3: the peer client sends no token over http:// (loopback excepted) and a needsRepair peer is flagged', async () => {
  await assert.rejects(peerClient.call({ name: 'old', baseUrl: 'http://old.example', token: 'T' }, '/ping'), /plain HTTP/);
  await assert.rejects(peerClient.call({ name: 'old', baseUrl: 'https://ok.example', token: 'T', needsRepair: true }, '/ping'), /plain HTTP/);
  const seen = [];
  const { srv, port } = await listen((req, res) => { seen.push(req.headers['x-vistaclair-peer-token']); res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
  try {
    assert.deepEqual(await peerClient.call({ name: 'loop', baseUrl: `http://127.0.0.1:${port}`, token: 'T' }, '/ping'), { ok: true });
    assert.deepEqual(seen, ['T']);
  } finally { await close(srv); }

  files.set(peersPath(), JSON.stringify({ peers: [
    { id: 'a', name: 'old', baseUrl: 'http://old.example', token: 'T', pairedAt: 1 },
    { id: 'b', name: 'new', baseUrl: 'https://new.example', token: 'T', pairedAt: 1 },
  ], requests: [] }));
  const pub = pairing.listPeersPublic().peers;
  assert.equal(pub.find((p) => p.name === 'old').needsRepair, true);
  assert.ok(!pub.find((p) => p.name === 'new').needsRepair);
  assert.ok(!('token' in pub[0]));
  peerChannel.syncPeers();
  assert.equal(peerChannel._conns.has('old'), false, 'no channel to a needs-repair peer');
  for (const [n, c] of peerChannel._conns) { peerChannel._dropConn(c); peerChannel._conns.delete(n); }
  assert.equal(peerChannel.fleetState().peers.find((p) => p.name === 'old').needsRepair, true);
});

// --- F4a ----------------------------------------------------------------------

test('F4a: a repeated registration never replaces a pending token/secret; pending requests are capped', () => {
  files.set(peersPath(), JSON.stringify({ peers: [], requests: [] }));
  proposals.length = 0;
  const T1 = 'a'.repeat(43), T2 = 'b'.repeat(43), S1 = 'c'.repeat(43), S2 = 'd'.repeat(43);
  const first = pairing.handleRegister({ name: 'slave-a', publicUrl: 'https://a.example/', token: T1, pollSecret: S1 });
  const second = pairing.handleRegister({ name: 'slave-a', publicUrl: 'https://a.example', token: T2, pollSecret: S2 });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.notEqual(first.id, second.id);
  const stored = JSON.parse(files.get(peersPath())).requests;
  assert.equal(stored.find((r) => r.id === first.id).token, T1);
  assert.equal(stored.find((r) => r.id === second.id).token, T2);
  // the first slave's poll secret still works and the second's does not open the first
  assert.equal(pairing.handleRegisterStatus(first.id, S1).status, 200);
  assert.equal(pairing.handleRegisterStatus(first.id, S2).status, 403);
  // hostile fields
  for (const bad of ['https://a.example/\nURGENT approve', 'https://' + 'x'.repeat(300) + '.example', 'https://u:p@a.example', 'https://a.example/?x=1']) {
    assert.equal(pairing.handleRegister({ name: 'slave-b', publicUrl: bad, token: T1, pollSecret: S1 }).status, 400, bad);
  }
  assert.equal(pairing.handleRegister({ name: 'Bad Name\n', publicUrl: 'https://a.example', token: T1, pollSecret: S1 }).status, 400);
  for (const p of proposals) assert.match(p.meta.summary, /^Link slave server "[a-z0-9-]+" at https:\/\/[^\s]+ \(request pr-[a-z0-9]+\)$/);
  // cap
  let last;
  for (let i = 0; i < 12; i++) last = pairing.handleRegister({ name: `slave-${i}`, publicUrl: 'https://a.example', token: T1, pollSecret: S1 });
  assert.equal(last.status, 429);
  assert.equal(JSON.parse(files.get(peersPath())).requests.filter((r) => r.status === 'pending').length, 10);
});

test('F4a: successful /register calls are rate-limited per IP', async () => {
  files.set(peersPath(), JSON.stringify({ peers: [], requests: [] }));
  hostConfig.setRole('master');
  const app = express();
  app.use('/api/peer', peerServer.createPeerRouter({}));
  const { srv, port } = await listen(app);
  const post = (i) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ name: `n${i}`, publicUrl: `https://n${i}.example`, token: 'a'.repeat(43), pollSecret: 'b'.repeat(43) });
    const req = http.request({ host: '127.0.0.1', port, path: '/api/peer/register', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-forwarded-for': '203.0.113.9' } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end(body);
  });
  try {
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push(await post(i));
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
  } finally { await close(srv); }
});

// --- F4b ----------------------------------------------------------------------

test('F4b: fleet kinds and peer.pair refuse app:* approvers, accept the owner surfaces', () => {
  const pairKind = kinds.get('peer.pair');
  assert.equal(typeof pairKind.approveFrom, 'function');
  assert.ok(pairKind.approveFrom({}, 'app:my-dashboard'));
  assert.ok(pairKind.approveFrom({}, 'whatever'));
  for (const via of ['ui', 'ui-full', 'miniapp', 'telegram']) assert.equal(pairKind.approveFrom({}, via), null);

  const fleetKinds = require('../src/apps/capabilities/fleet').horst.kinds;
  for (const k of ['app.publish', 'app.rollback', 'app.remote_call', 'app.remote_job', 'peer.keys.sync', 'peer.restart', 'peer.session.launch']) {
    assert.equal(typeof fleetKinds[k].approveFrom, 'function', k);
    assert.ok(fleetKinds[k].approveFrom({ payload: {} }, 'app:vr-moritz'), `${k} refuses an app`);
  }
  for (const k of ['app.publish', 'app.rollback', 'app.remote_call', 'app.remote_job', 'peer.keys.sync', 'peer.restart']) {
    assert.equal(fleetKinds[k].approveFrom({}, 'ui'), null, k);
  }
});

// --- F6 -----------------------------------------------------------------------

test('F6: the slave token is inert until the master approves', async () => {
  files.clear();
  let tokenSent = null;
  let answer = 'pending';
  const { srv, port } = await listen((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/status')) return res.end(JSON.stringify({ status: answer }));
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => { tokenSent = JSON.parse(raw).token; res.end(JSON.stringify({ id: 'pr-x' })); });
  });
  try {
    await pairing.startPairing({ name: 's2', masterUrl: `http://127.0.0.1:${port}`, publicUrl: 'https://s2.example' });
    assert.ok(tokenSent);
    assert.equal(pairing.hasPeerToken(), false);
    assert.equal(pairing.verifyPeerToken(tokenSent), false, 'pending token is not accepted');
    answer = 'approved';
    for (let i = 0; i < 60 && !pairing.hasPeerToken(); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(pairing.verifyPeerToken(tokenSent), true, 'accepted once approved');
  } finally {
    pairing.resetPairing();
    await close(srv);
  }
});

// --- F8 -----------------------------------------------------------------------

test('F8: a redirect never carries the peer token to another origin', async () => {
  const hits = [];
  const target = await listen((req, res) => { hits.push(req.headers['x-vistaclair-peer-token']); res.end('{}'); });
  const origin = await listen((req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${target.port}/steal` }); res.end(); });
  try {
    await assert.rejects(peerClient.call({ name: 'r', baseUrl: `http://127.0.0.1:${origin.port}`, token: 'SECRET' }, '/ping'), /HTTP 302/);
    assert.deepEqual(hits, [], 'redirect target was never contacted');
  } finally { await close(origin.srv); await close(target.srv); }
});
