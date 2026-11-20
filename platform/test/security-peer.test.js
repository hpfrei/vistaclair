// Peer-plane hardening (findings from a code read, nothing exploited):
//   1  the slave's GET /api/peer/access hands out a single-use login link, never
//      its permanent owner token; the master side degrades across versions
//   2  fleet-data-up: the master decides trust from its own record of the peer
//   3  pairing: a duplicate name is never replaced silently
//   4  MCP session endpoint: a valid token is served while the address is limited
//   5  webhook secrets are compared in constant time
//   6  the peer secret files are 0600
// In-process handlers and ephemeral loopback ports only.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { makeAppsDir } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const hostConfig = require('../src/apps/host-config');
const pairing = require('../src/apps/peer-pairing');
const peerServer = require('../src/apps/peer-server');
const governance = require('../src/apps/governance/horst-governance');

const appsDir = makeAppsDir({ good: {} });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-secpeer-'));
appManager.setAppsDir(appsDir);
hostConfig.init(appsDir, { dataHome: tmp });

// A secret store that behaves like core's: files come out 0644 here on
// purpose (an older install, a permissive umask) — core only sets the mode on
// creation, so pro has to tighten it afterwards.
const store = {
  readSecretFile: (p, _d, o) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return o?.fallback ?? {}; } },
  writeSecretFile: (p, data) => {
    fs.writeFileSync(p, JSON.stringify(data));
    if (!store.keepMode) fs.chmodSync(p, 0o644);
  },
};
const proposals = [];
governance.registerKind = () => {};
governance.createProposal = (kind, payload, meta) => { proposals.push({ kind, payload, meta }); return { id: `p${proposals.length}` }; };
pairing.init({ appsDir, secretStore: store, broadcaster: null });
const peersFile = () => path.join(appsDir, '.peers.enc');
const keyFile = () => path.join(appsDir, '.secrets_key');

test.after(() => {
  pairing.shutdown();
  fs.rmSync(appsDir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

const listen = (handler) => new Promise((resolve) => {
  const srv = http.createServer(handler).listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
});
const close = (srv) => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); });
const request = (port, p, { headers = {}, method = 'GET', body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
    let raw = '';
    res.on('data', (d) => { raw += d; });
    res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, json, raw, location: res.headers.location }); });
  });
  req.on('error', reject);
  if (body) req.write(JSON.stringify(body));
  req.end();
});

// --- 1: /access ----------------------------------------------------------------

const CORE_TOKEN = 'CORE_OWNER_TOKEN_' + 'x'.repeat(30);
const PEER_TOKEN = 'peer-token-' + crypto.randomBytes(8).toString('hex');

// A fake core: POST /api/login/login-link (loopback + x-vistaclair-internal)
// mints a single-use key, GET /login/once?k= redeems it once (core's shape).
function fakeCore() {
  const keys = new Set();
  const minted = [];
  const app = express();
  app.post('/api/login/login-link', (req, res) => {
    if (req.headers['x-vistaclair-internal'] !== CORE_TOKEN) return res.status(403).json({ error: 'Host-local only' });
    const key = crypto.randomBytes(32).toString('hex');
    keys.add(key); minted.push(key);
    res.json({ path: `/login/once?k=${key}`, expiresInMs: 300000 });
  });
  app.get('/login/once', (req, res) => res.redirect(keys.delete(req.query.k) ? '/' : '/login'));
  return { app, minted };
}

async function slaveWith(extraOpts) {
  hostConfig.setRole('slave');
  hostConfig.setSlave({ name: 's', publicUrl: 'https://slave.example/', linkStatus: 'linked' });
  store.writeSecretFile(path.join(appsDir, '.peer.enc'), { tokenHash: crypto.createHash('sha256').update(PEER_TOKEN).digest('hex') });
  const app = express();
  app.use('/api/peer', peerServer.createPeerRouter({ authToken: CORE_TOKEN, ...extraOpts }));
  return listen(app);
}
const asPeer = { headers: { 'x-vistaclair-peer-token': PEER_TOKEN } };

test('1: /access returns a login link, never the permanent token; the link works once', async () => {
  const core = fakeCore();
  const c = await listen(core.app);
  const s = await slaveWith({ dashboardPort: c.port });
  try {
    const r = await request(s.port, '/api/peer/access?v=2', asPeer);
    assert.equal(r.status, 200, r.raw);
    assert.ok(!r.raw.includes(CORE_TOKEN), 'the permanent token is nowhere in the answer');
    assert.equal(r.json.token, undefined);
    assert.match(r.json.loginPath, /^\/login\/once\?k=[0-9a-f]{64}$/);
    assert.equal(r.json.url, 'https://slave.example');
    assert.ok(r.json.expiresInMs > 0);
    assert.equal((await request(c.port, r.json.loginPath)).location, '/', 'first use logs in');
    assert.equal((await request(c.port, r.json.loginPath)).location, '/login', 'second use does not');
    const again = await request(s.port, '/api/peer/access?v=2', asPeer);
    assert.notEqual(again.json.loginPath, r.json.loginPath, 'every call mints a fresh code');
    assert.equal(core.minted.length, 2);
  } finally { await close(s.srv); await close(c.srv); hostConfig.setRole('master'); }
});

test('1: an old master (no ?v=2) gets a clear error and never the permanent token', async () => {
  const core = fakeCore();
  const c = await listen(core.app);
  const s = await slaveWith({ dashboardPort: c.port });
  try {
    const r = await request(s.port, '/api/peer/access', asPeer);
    assert.equal(r.status, 426);
    assert.match(r.json.error, /update the master/i);
    assert.ok(!r.raw.includes(CORE_TOKEN));
    assert.equal(core.minted.length, 0, 'nothing minted for it');
  } finally { await close(s.srv); await close(c.srv); hostConfig.setRole('master'); }
});

test('1: when core cannot mint, /access fails closed (no token fallback)', async () => {
  const s = await slaveWith({ mintLoginLink: async () => { throw new Error('core down'); } });
  try {
    const r = await request(s.port, '/api/peer/access?v=2', asPeer);
    assert.equal(r.status, 502);
    assert.ok(!r.raw.includes(CORE_TOKEN));
  } finally { await close(s.srv); hostConfig.setRole('master'); }
});

const CORE_LOGIN = [process.env.VISTACLAIR_CORE_DIR, '/home/hp/vistaclair']
  .filter(Boolean).map((d) => path.join(d, 'src', 'login.js')).find((f) => fs.existsSync(f));
test('1: core\'s own one-time link (src/login.js) is single-use', { skip: !CORE_LOGIN && 'no core checkout found' }, () => {
  const login = require(CORE_LOGIN).createLogin({ dataHome: fs.mkdtempSync(path.join(tmp, 'login-')), log: { error() {} } });
  const key = login.createOneTimeLink();
  assert.ok(login.redeemOneTimeLink(key));
  assert.equal(login.redeemOneTimeLink(key), null);
});

test('1: the master asks for the login link and degrades across versions', async () => {
  const { fetchAccess } = require('../src/apps/peer-access');
  const peer = { name: 's', baseUrl: 'https://s.example' };
  let asked;
  const fresh = await fetchAccess({ call: async (p, route) => { asked = route; return { ok: true, loginPath: '/login/once?k=abc', url: 'https://s.example', expiresInMs: 300000 }; } }, peer);
  assert.match(asked, /\/access\?v=2$/);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.loginUrl, 'https://s.example/login/once?k=abc');
  assert.equal(fresh.token, undefined);
  assert.ok(!fresh.warning);
  // old slave: still works, with a warning that it is outdated
  const old = await fetchAccess({ call: async () => ({ ok: true, token: 'OLD_PERMANENT', url: 'https://s.example' }) }, peer);
  assert.equal(old.ok, true);
  assert.equal(old.token, 'OLD_PERMANENT');
  assert.match(old.warning, /outdated/i);
  // a slave's error is passed on
  const err = await fetchAccess({ call: async () => { throw new Error('boom'); } }, peer);
  assert.equal(err.ok, false);
  assert.equal(err.error, 'boom');
  // the login path is only ever joined to the slave's URL, never taken as a URL
  const hostile = await fetchAccess({ call: async () => ({ ok: true, loginPath: 'https://evil.example/x', url: 'https://s.example' }) }, peer);
  assert.equal(hostile.ok, false);
});

// --- 2: fleet-data-up origin --------------------------------------------------------

test('2: a payload claiming origin.kind "owner" is judged by the master\'s own record of the peer', async () => {
  const up = require('../src/apps/fleet-data-up');
  const M = require('../src/apps/fleet-data-manifest');
  const peers = new Map([
    ['plain', { id: 'peer-1', name: 'plain', baseUrl: 'https://plain.example', token: 't' }],
    ['trusted', { id: 'peer-2', name: 'trusted', baseUrl: 'https://trusted.example', token: 't', trustOwnerClicks: true }],
  ]);
  const manifest = { format: 'x', blobs: [{ sha256: 'a'.repeat(64), bytes: 10, path: 'a.bin' }] };
  const sha = M.validateManifest(manifest).sha;
  const started = []; const requested = [];
  up.init({
    wire: false,
    stateDir: path.join(tmp, 'fdu'),
    getPeer: (n) => peers.get(n) || null,
    appExists: () => true,
    client: { call: async () => ({ manifest }) },
    engine: {
      start: async (app, peer, o) => { started.push({ peer, origin: o.origin }); return { id: 'fd-' + '1'.repeat(24), attached: true }; },
      stage: async (app, peer) => ({ id: 'fd-' + '2'.repeat(24), peer, manifestSha: sha, blobs: 1, totalBytes: 10 }),
      status: () => null,
    },
    receive: { plan: async () => ({ needBytes: 10, fits: true }) },
    governance: { audit() {}, requestAction: async (kind, payload, meta) => { requested.push({ kind, payload, meta }); return { proposal: { id: 'p1' } }; } },
  });
  const args = { app: 'good', name: 'n1', manifestSha: sha, origin: { kind: 'owner', route: '/x' } };

  const untrusted = await up.handleRequest('plain', 'fd.start', args);
  assert.equal(untrusted.proposed, true, 'an untrusted peer\'s "owner" claim files a proposal');
  assert.equal(started.length, 0, 'nothing started');
  assert.equal(requested[0].kind, 'app.data_publish');
  assert.notEqual(requested[0].payload.origin.kind, 'owner', 'the stored origin is not the peer\'s word');
  assert.equal(up.decide('plain', 'good', { kind: 'owner' }), null);

  const trusted = await up.handleRequest('trusted', 'fd.start', args);
  assert.ok(!trusted.proposed, 'the master\'s own record says this peer\'s owner clicks are trusted');
  assert.equal(started.length, 1);
  assert.equal(started[0].origin.kind, 'owner');

  // A trusted peer's other kinds are never promoted.
  const cron = await up.handleRequest('trusted', 'fd.start', { ...args, name: 'n2', origin: { kind: 'cron' } });
  assert.equal(cron.proposed, true);
});

// --- 3: pairing ------------------------------------------------------------------------

test('3: approving a request with an existing peer\'s name does not replace it silently', () => {
  const T0 = 'o'.repeat(43), T1 = 'a'.repeat(43), T2 = 'b'.repeat(43), S = 'c'.repeat(43);
  store.writeSecretFile(peersFile(), {
    peers: [{ id: 'peer-old', name: 'slave-a', baseUrl: 'https://old.example', token: T0, pairedAt: 1 }],
    requests: [],
  });
  proposals.length = 0;
  const reg = pairing.handleRegister({ name: 'slave-a', publicUrl: 'https://new.example', token: T1, pollSecret: S });
  assert.equal(reg.status, 200);
  // The card the owner sees says it replaces an existing slave, and names it.
  const prop = proposals[0];
  assert.equal(prop.payload.replaces, 'peer-old');
  assert.match(prop.meta.summary, /REPLACE/);
  assert.match(prop.meta.summary, /https:\/\/old\.example/);

  // Approval WITHOUT the confirmation (a bare call, or a payload that does not
  // name the peer on file) refuses and leaves the peer as it was.
  assert.throws(() => pairing.approveRequest(reg.id), /already linked|replace/i);
  assert.throws(() => pairing.approveRequest(reg.id, { replaces: 'peer-other' }), /already linked|replace/i);
  let peer = pairing.getPeer('slave-a');
  assert.equal(peer.id, 'peer-old');
  assert.equal(peer.token, T0);

  // With the confirmation (the payload the owner approved) it replaces.
  assert.equal(pairing.approveRequest(reg.id, { replaces: 'peer-old' }).ok, true);
  peer = pairing.getPeer('slave-a');
  assert.notEqual(peer.id, 'peer-old');
  assert.equal(peer.token, T1);

  // A fresh name needs no confirmation.
  const reg2 = pairing.handleRegister({ name: 'slave-new', publicUrl: 'https://n.example', token: T2, pollSecret: S });
  assert.equal(proposals.at(-1).payload.replaces, undefined);
  assert.equal(pairing.approveRequest(reg2.id).ok, true);
});

test('3: a peer linked after the request was filed is not replaced either', () => {
  const T1 = 'd'.repeat(43), T2 = 'e'.repeat(43), S1 = 'f'.repeat(43);
  store.writeSecretFile(peersFile(), { peers: [], requests: [] });
  proposals.length = 0;
  const reg = pairing.handleRegister({ name: 'slave-race', publicUrl: 'https://r.example', token: T1, pollSecret: S1 });
  assert.equal(proposals[0].payload.replaces, undefined, 'no peer on file when it was filed');
  // Another route links a peer of that name before this card is approved.
  const data = store.readSecretFile(peersFile(), appsDir);
  data.peers.push({ id: 'peer-late', name: 'slave-race', baseUrl: 'https://late.example', token: T2, pairedAt: 2 });
  store.writeSecretFile(peersFile(), data);
  assert.throws(() => pairing.approveRequest(reg.id), /already linked|replace/i);
  assert.equal(pairing.getPeer('slave-race').token, T2);
});

// --- 4: MCP session endpoint ----------------------------------------------------------

test('4: a valid MCP token is served while its address is rate limited; only failures count', async () => {
  const broker = require('../src/apps/mcp-broker');
  broker.init({ dir: path.join(tmp, 'broker') });
  const s = broker.createSession({});
  const app = express();
  app.use('/pro/mcp', broker.createRouter());
  const { srv, port } = await listen(app);
  const ping = (token) => request(port, `/pro/mcp/s/${s.id}`, {
    method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: { jsonrpc: '2.0', id: 1, method: 'ping' },
  });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await ping(s.token)).status, 200, 'good calls never count');
    for (let i = 0; i < 10; i++) assert.equal((await ping('wrong-' + i)).status, 401);
    assert.equal((await ping('wrong-again')).status, 429, 'the address is limited for bad tokens');
    assert.equal((await ping(null)).status, 429);
    assert.equal((await ping(s.token)).status, 200, 'a legitimate client on the same address is still served');
  } finally { await close(srv); }
});

// --- 5: webhook secrets ------------------------------------------------------------------

test('5: the Telegram webhook secret check is constant-time, accepts the right secret and refuses the rest', () => {
  const telegram = require('../src/apps/telegram');
  const bot = { webhookSecret: crypto.randomBytes(24).toString('hex') };
  const realEq = crypto.timingSafeEqual;
  let calls = 0;
  crypto.timingSafeEqual = (...a) => { calls++; return realEq(...a); };
  try {
    assert.equal(telegram.webhookSecretOk(bot, bot.webhookSecret), true);
    assert.ok(calls >= 1, 'compared with crypto.timingSafeEqual');
    const flipped = bot.webhookSecret.slice(0, -1) + (bot.webhookSecret.endsWith('0') ? '1' : '0');
    assert.equal(telegram.webhookSecretOk(bot, flipped), false);
    assert.equal(telegram.webhookSecretOk(bot, bot.webhookSecret.slice(0, 10)), false, 'shorter');
    assert.equal(telegram.webhookSecretOk(bot, bot.webhookSecret + 'x'), false, 'longer');
    assert.equal(telegram.webhookSecretOk(bot, undefined), false, 'absent header');
    assert.equal(telegram.webhookSecretOk(bot, [bot.webhookSecret]), false, 'repeated header');
    assert.equal(telegram.webhookSecretOk({}, ''), false, 'a bot without a secret refuses everything');
    assert.equal(telegram.webhookSecretOk({}, undefined), false);
  } finally { crypto.timingSafeEqual = realEq; }
  // The routes use it: no plain comparison with a webhook secret is left.
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf-8');
  assert.ok(!/secret-token'\]\s*!==/.test(src), 'index.js compares the Telegram header with !==');
  assert.ok(!/verify_token'\]\s*===/.test(src), 'index.js compares the WhatsApp verify token with ===');
  assert.match(src, /webhookSecretOk/);
});

// --- 6: file modes ----------------------------------------------------------------------

test('6: .peers.enc and the key file beside it are written 0600', () => {
  fs.writeFileSync(keyFile(), 'k'.repeat(64));
  fs.chmodSync(keyFile(), 0o644);
  store.writeSecretFile(peersFile(), { peers: [], requests: [] });
  pairing.handleRegister({ name: 'slave-mode', publicUrl: 'https://m.example', token: 'm'.repeat(43), pollSecret: 'n'.repeat(43) });
  const mode = (f) => (fs.statSync(f).mode & 0o777).toString(8);
  assert.equal(mode(peersFile()), '600');
  assert.equal(mode(keyFile()), '600');
  // The format and location are untouched: the master still reads its raw token.
  assert.equal(typeof store.readSecretFile(peersFile(), appsDir).requests[0].token, 'string');
});
