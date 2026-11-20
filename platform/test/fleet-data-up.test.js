// Fleet data publish, UP direction (docs/fleet-data-up.md): a slave app's blobs
// to the same app on its master. A two-host harness on loopback in temp dirs.
// The MASTER is fleet-data.js (its records, the run) + fleet-data-receive.js
// (its inbox, a fake in-process app registering have/receive) + the master
// half of fleet-data-up.js. The SLAVE is the real peer-server router (token
// auth, the /fleet-data-up routes) over the slave half of fleet-data-up.js,
// whose data dir and state dir are their own temp dirs; the master reaches it
// through a pass-through proxy that counts the bytes it pulls and can cut a
// response. The live channel is simulated: the slave's askMaster calls the
// master's handleRequest (JSON round-trip, err.code kept) and the master's
// pushes reach the slave's frame handler, both only while `link.up`. Never
// touches the live control-room server or its ports.
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
const appJobs = require('../src/apps/app-jobs');
const peerServer = require('../src/apps/peer-server');
const receive = require('../src/apps/fleet-data-receive');
const fleetData = require('../src/apps/fleet-data');
const up = require('../src/apps/fleet-data-up');

const TOKEN = 'test-peer-token-' + crypto.randomBytes(8).toString('hex');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const GiB = 1024 ** 3;

// --- Master host (the receiving app; app-manager points here) --------------------
const masterApps = makeAppsDir({ world: {} });
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-fdu-home-'));
appManager.setAppsDir(masterApps);
hostConfig.init(masterApps, { dataHome });
// peer-server's control plane answers only on a paired slave: the role is the
// slave half's; the master half below never asks hostConfig.
hostConfig.setRole('slave');
hostConfig.enableApp('world');
const secretFiles = new Map([[path.join(masterApps, '.peer.enc'), { tokenHash: sha(TOKEN), pending: null }]]);
pairing.init({
  appsDir: masterApps,
  broadcaster: null,
  secretStore: {
    readSecretFile: (p, _d, o) => (secretFiles.has(p) ? secretFiles.get(p) : (o?.fallback ?? {})),
    writeSecretFile: (p, data) => { secretFiles.set(p, data); },
  },
});
appJobs.init({ appsDir: masterApps });

let disk = { free: 1000 * GiB, total: 1000 * GiB };   // margin = max(1 GiB, 2 %) = 20 GiB
receive.init({ appsDir: masterApps, sweep: false, statfs: () => ({ bsize: 1, bavail: disk.free, blocks: disk.total }) });

const objects = path.join(masterApps, 'world', '.data', 'objects');
fs.mkdirSync(objects, { recursive: true });
const receiveCalls = [];
let receiveImpl = null;
let haveImpl = null;
async function defaultReceive({ manifest, inbox }) {
  let n = 0;
  for (const f of fs.readdirSync(inbox)) {
    const dest = path.join(objects, f);
    if (!fs.existsSync(dest)) fs.linkSync(path.join(inbox, f), dest);
    n++;
  }
  return { ok: true, summary: `imported ${n} of ${manifest.blobs.length}` };
}
receive.registerReceiver('world', 'world-*', {
  have: async (m) => (haveImpl ? haveImpl(m) : m.blobs.map((b) => b.sha256).filter((s) => fs.existsSync(path.join(objects, s)))),
  receive: async (args) => { receiveCalls.push(args); return (receiveImpl || defaultReceive)(args); },
});

// --- Slave host (the sending app's data + the up module's state) -----------------
const slaveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-fdu-slave-'));
const slaveData = path.join(slaveRoot, 'world', '.data');
fs.mkdirSync(slaveData, { recursive: true });

function blob(rel, size) {
  const buf = crypto.randomBytes(size);
  const file = path.join(slaveData, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return { sha256: sha(buf), bytes: size, path: rel };
}

// --- Servers ------------------------------------------------------------------------
const listen = (app) => new Promise((resolve) => {
  const srv = http.createServer(app).listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
});
const close = (srv) => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); });

const wire = { getBytes: 0, gets: [], cut: 0 };
const fault = { cutGetAfter: 0, delayGetMs: 0 };
function proxyApp(slavePort) {
  const app = express();
  app.use((req, res) => {
    const isBlob = req.method === 'GET' && /\/blobs\//.test(req.originalUrl);
    const forward = () => {
      const upReq = http.request({ host: '127.0.0.1', port: slavePort, method: req.method, path: req.originalUrl, headers: req.headers }, (ur) => {
        res.writeHead(ur.statusCode, ur.headers);
        if (isBlob && ur.statusCode === 200) {
          wire.gets.push(req.originalUrl);
          ur.on('data', (c) => {
            wire.getBytes += c.length;
            if (fault.cutGetAfter && wire.getBytes >= fault.cutGetAfter) {
              fault.cutGetAfter = 0;
              wire.cut++;
              ur.destroy();
              res.socket?.destroy();
            }
          });
        }
        ur.pipe(res);
      });
      upReq.on('error', () => res.destroy());
      req.pipe(upReq);
    };
    if (isBlob && fault.delayGetMs) setTimeout(forward, fault.delayGetMs); else forward();
  });
  return app;
}

let slave;
let proxy;
const peers = new Map();
const masterOpts = () => ({
  stateDir: path.join(masterApps, '.fleet-data'),
  getPeer: (ref) => peers.get(ref) || [...peers.values()].find((p) => p.id === ref) || null,
  listPeers: () => [peers.get('s1')],
  appExists: (a) => fs.existsSync(path.join(masterApps, a)),
  dataDir: (a) => path.join(masterApps, a, '.data'),
  fleetState: () => ({ peers: [] }),
  chunkBytes: 64 * 1024,
  backoffMinMs: 20,
  backoffMaxMs: 100,
  pollMs: 20,
  progressMs: 0,
  persistMs: 10,
  unreachableMs: 4000,
});

// --- The simulated channel, governance and remote-job records -----------------------
const link = { up: true };
const asked = [];
const audits = [];
const proposals = new Map();
const remoteRecs = new Map();
const governance = {
  audit: (row) => audits.push(row),
  async requestAction(kind, payload, meta) {
    const id = `p-${proposals.size + 1}`;
    proposals.set(id, { id, kind, payload: JSON.parse(JSON.stringify(payload)), meta, status: 'pending' });
    return { mode: 'proposed', proposal: { id } };
  },
  getProposal: (id) => proposals.get(id) || null,
};
const upOpts = (extra = {}) => ({
  stateDir: path.join(slaveRoot, '.fleet-data'),
  isSlave: () => true,
  masterHost: () => 'master.test',
  masterConnected: () => link.up,
  appExists: (a) => a === 'world',
  dataDir: (a) => path.join(slaveRoot, a, '.data'),
  getPeer: (ref) => peers.get(ref) || null,
  channel: {},
  ask: async (op, args) => {
    asked.push(op);
    if (!link.up) throw Object.assign(new Error('the master is not connected'), { code: 'offline' });
    try {
      return JSON.parse(JSON.stringify(await up.handleRequest('s1', op, JSON.parse(JSON.stringify(args))) ?? null));
    } catch (err) {
      throw Object.assign(new Error(err.message), { code: err.code || 'error' });
    }
  },
  push: (peer, frame) => {
    if (!link.up || peer !== 's1') return false;
    const copy = JSON.parse(JSON.stringify(frame));
    setImmediate(() => up.onMasterFrame(copy));
    return true;
  },
  remote: { status: (id) => remoteRecs.get(id) || null },
  governance,
  ...extra,
});

function waitDone(id, ms = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const r = fleetData.status(id);
      if (r && r.status !== 'running') return resolve(r);
      if (Date.now() - t0 > ms) return reject(new Error(`transfer ${id} still running: ${JSON.stringify(r)}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}
function waitFor(fn, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error('condition not met'));
      setTimeout(tick, 10);
    };
    tick();
  });
}
const inboxDirs = () => { try { return fs.readdirSync(path.join(receive.rootDir(), 'world')); } catch { return []; } };
const objectOk = (b) => fs.existsSync(path.join(objects, b.sha256)) && sha(fs.readFileSync(path.join(objects, b.sha256))) === b.sha256;
const OWNER = { kind: 'owner', route: '/build' };

test.before(async () => {
  slave = await listen(express().use('/api/peer', peerServer.createPeerRouter({})));
  proxy = await listen(proxyApp(slave.port));
  peers.set('s1', { id: 'peer-1', name: 's1', baseUrl: `http://127.0.0.1:${proxy.port}`, token: TOKEN, trustOwnerClicks: true });
  fleetData.init(masterOpts());
  up.init(upOpts());
});

test.after(async () => {
  await fleetData.shutdown();
  up.shutdown();
  receive.shutdown();
  pairing.shutdown();
  await Promise.all([close(slave.srv), close(proxy.srv)]);
  for (const d of [slaveRoot, masterApps, dataHome]) fs.rmSync(d, { recursive: true, force: true });
});

// --- Tests --------------------------------------------------------------------------

test('master(): null on a host that is no fleet slave; on a slave the master with its receivers', async () => {
  up.init(upOpts({ isSlave: () => false }));
  assert.equal(await up.master('world'), null);
  up.init(upOpts({ masterHost: () => null }));
  assert.equal(await up.master('world'), null, 'a slave not linked to a master');
  up.init(upOpts());
  const m = await up.master('world');
  assert.equal(m.peer, 'master.test');
  assert.equal(m.host, 'master.test');
  assert.equal(m.online, true);
  assert.deepEqual(m.receivers, ['world-*']);
  assert.equal(m.app.installed, true);
  link.up = false;
  const off = await up.master('world');
  assert.equal(off.online, false);
  assert.deepEqual(off.receivers, ['world-*'], 'the last answer while offline');
  link.up = true;
  await assert.rejects(up.plan('world', 'elsewhere', { name: 'world-x', manifest: { blobs: [] } }), /only peer is the master/);
});

let manifestA;
let blobsA;
let idA;
test('happy path with a delta: the master\'s have skips a blob; streamed in chunks; dir in events', async () => {
  blobsA = [blob('w/big.bin', 200 * 1024), blob('w/small.bin', 10 * 1024), blob('w/held.bin', 10 * 1024)];
  fs.copyFileSync(path.join(slaveData, 'w/held.bin'), path.join(objects, blobsA[2].sha256));
  manifestA = { format: 'test/1', blobs: blobsA, extra: { world: 'A' } };

  const p = await up.plan('world', 'master.test', { name: 'world-a', manifest: manifestA });
  assert.equal(p.peer, 'master.test');
  assert.deepEqual(p.need.sort(), [blobsA[0].sha256, blobsA[1].sha256].sort());
  assert.equal(p.needBytes, 210 * 1024);
  assert.equal(p.haveBytes, 10 * 1024);
  assert.equal(p.fits, true);
  assert.equal(inboxDirs().length, 0, 'plan alone creates no inbox');

  const masterEvents = [];
  const slaveEvents = [];
  const inboxEvents = [];
  const u1 = fleetData.subscribe((ev, d) => masterEvents.push([ev, d]));
  const u2 = up.subscribe((ev, d) => slaveEvents.push([ev, d]));
  const u3 = receive.subscribe((ev, d) => inboxEvents.push([ev, d]));
  wire.getBytes = 0; wire.gets = [];
  const r = await up.publish('world', 'master.test', { name: 'world-a', manifest: manifestA, meta: { by: 'test' }, origin: OWNER });
  assert.ok(!r.proposed, 'the owner\'s click on the slave runs at once');
  idA = r.id;
  const done = await waitDone(idA);
  u1(); u3();
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.dir, 'up');
  assert.equal(done.peer, 's1');
  assert.match(done.summary, /imported 2 of 3/);
  assert.equal(wire.getBytes, 210 * 1024, 'only the delta crossed the wire');
  assert.equal(wire.gets.filter((u) => u.includes(blobsA[0].sha256)).length, 4, '200 KB in 64 KB ranges');
  assert.ok(blobsA.every(objectOk));
  assert.equal(inboxDirs().length, 0, 'inbox removed after ok');
  const call = receiveCalls[receiveCalls.length - 1];
  assert.equal(call.peer, '127.0.0.1', 'receive gets the slave\'s host');
  assert.deepEqual(call.extra, { world: 'A' });
  // Ledgered on the master, as the slave owner's click.
  const row = audits.find((a) => a.summary.includes(idA));
  assert.equal(row.kind, 'app.data_publish');
  assert.equal(row.via, 'owner on s1 via app:world');
  // dir on both ends; the slave's record follows the master's pushes.
  assert.ok(masterEvents.some(([ev, d]) => ev === 'fleet:data:progress' && d.dir === 'up' && d.phase === 'sending'));
  assert.ok(masterEvents.some(([ev, d]) => ev === 'fleet:data:done' && d.dir === 'up' && d.ok));
  assert.ok(inboxEvents.every(([, d]) => d.dir === 'up'));
  await waitFor(() => up.status(idA)?.status === 'done');
  await new Promise((r) => setImmediate(r));
  u2();
  assert.ok(slaveEvents.some(([ev, d]) => ev === 'fleet:data:progress' && d.dir === 'up' && d.id === idA));
  const sdone = slaveEvents.filter(([ev]) => ev === 'fleet:data:done');
  assert.equal(sdone.length, 1, 'one done on the slave');
  assert.equal(sdone[0][1].ok, true);
  assert.match(sdone[0][1].summary, /imported 2 of 3/);
  const mine = up.status(idA);
  assert.equal(mine.peer, 'master.test');
  assert.equal(mine.sentBytes, 210 * 1024);
  assert.deepEqual(up.list({ app: 'world' }).map((x) => x.id), [idA]);

  // The same publish again: the same transfer, 0 bytes, receive runs again.
  wire.getBytes = 0;
  const n = receiveCalls.length;
  const again = await up.publish('world', 'master.test', { name: 'world-a', manifest: manifestA, origin: OWNER });
  assert.equal(again.id, idA);
  assert.equal((await waitDone(idA)).status, 'done');
  assert.equal(wire.getBytes, 0);
  assert.equal(receiveCalls.length, n + 1);
});

test('resume after a broken link: a cut range and a channel outage', async () => {
  const blobs = [blob('r/one.bin', 300 * 1024), blob('r/two.bin', 40 * 1024)];
  const manifest = { blobs };
  wire.getBytes = 0; wire.cut = 0;
  fault.cutGetAfter = 100 * 1024;
  link.up = true;
  const { id } = await up.publish('world', 'master.test', { name: 'world-r', manifest, origin: OWNER });
  link.up = false;                       // the channel drops; the HTTP pulls go on
  const r = await waitDone(id);
  assert.equal(r.status, 'done', r.error);
  assert.equal(wire.cut, 1, 'a range was cut');
  assert.ok(wire.getBytes >= 340 * 1024 && wire.getBytes < 340 * 1024 + 128 * 1024, `resumed, not restarted (${wire.getBytes})`);
  assert.ok(blobs.every(objectOk));
  assert.notEqual(up.status(id)?.status, 'done', 'the slave missed the end while the link was down');
  link.up = true;
  await up.sync();
  assert.equal(up.status(id).status, 'done', 'the reconnect sync brings the end');
});

test('a master restart mid-transfer resumes from the inbox; a slave restart keeps serving', async () => {
  const blobs = [blob('m/one.bin', 256 * 1024), blob('m/two.bin', 256 * 1024)];
  wire.getBytes = 0;
  fault.delayGetMs = 30;
  const { id } = await up.publish('world', 'master.test', { name: 'world-m', manifest: { blobs }, origin: OWNER });
  await waitFor(() => (fleetData.status(id)?.sentBytes || 0) >= 128 * 1024);
  await fleetData.shutdown();
  assert.equal(fleetData.status(id).status, 'running', 'left running for the next init');
  const sentBefore = wire.getBytes;
  // The slave restarts too: its state comes back from disk.
  up.shutdown();
  up.init(upOpts());
  fleetData.init(masterOpts());
  fault.delayGetMs = 0;
  const r = await waitDone(id);
  assert.equal(r.status, 'done', r.error);
  assert.ok(blobs.every(objectOk));
  assert.ok(wire.getBytes < 512 * 1024 + sentBefore, 'resumed at the verified blobs and partial offsets');
  assert.ok(wire.getBytes - sentBefore < 512 * 1024, `the restart did not start over (${wire.getBytes - sentBefore} after it)`);
  await waitFor(() => up.status(id)?.status === 'done');
});

test('a blob failing its sha256 twice fails the transfer, on both ends', async () => {
  const b = blob('s/bad.bin', 20 * 1024);
  const manifest = { blobs: [{ ...b, sha256: sha(Buffer.from('not the content')) }] };
  const { id } = await up.publish('world', 'master.test', { name: 'world-s', manifest, origin: OWNER });
  const r = await waitDone(id);
  assert.equal(r.status, 'failed');
  assert.match(r.error, /failed its sha256 check twice/);
  await waitFor(() => up.status(id)?.status === 'failed');
  assert.match(up.status(id).error, /twice/);
});

test('no space on the master: refused before a byte is pulled', async () => {
  const blobs = [blob('n/one.bin', 50 * 1024)];
  disk = { free: 5 * GiB, total: 1000 * GiB };   // margin 20 GiB > free
  wire.getBytes = 0;
  const p = await up.plan('world', 'master.test', { name: 'world-n', manifest: { blobs } });
  assert.equal(p.fits, false);
  const { id } = await up.publish('world', 'master.test', { name: 'world-n', manifest: { blobs }, origin: OWNER });
  const r = await waitDone(id);
  disk = { free: 1000 * GiB, total: 1000 * GiB };
  assert.equal(r.status, 'failed');
  assert.match(r.error, /does not fit on this master/);
  assert.equal(wire.getBytes, 0);
});

test('the master app\'s receive throws: failed with its reason; have may refuse too', async () => {
  const blobs = [blob('t/one.bin', 8 * 1024)];
  receiveImpl = async () => { throw new Error('world not requested'); };
  const { id } = await up.publish('world', 'master.test', { name: 'world-t', manifest: { blobs }, origin: OWNER });
  const r = await waitDone(id);
  receiveImpl = null;
  assert.equal(r.status, 'failed');
  assert.match(r.error, /world not requested/);
  await waitFor(() => up.status(id)?.status === 'failed');
  assert.match(up.status(id).error, /world not requested/);

  haveImpl = () => { throw new Error('refused by the master app'); };
  await assert.rejects(up.plan('world', 'master.test', { name: 'world-h', manifest: { blobs } }), /refused by the master app/);
  haveImpl = null;
});

test('cancel from the slave (online, and with the link down) and from the master', async () => {
  fault.delayGetMs = 40;
  // Slave, online: the master drops its record and inbox at once.
  const b1 = [blob('c/one.bin', 512 * 1024)];
  const { id: id1 } = await up.publish('world', 'master.test', { name: 'world-c1', manifest: { blobs: b1 }, origin: OWNER });
  await waitFor(() => fleetData.status(id1)?.phase === 'sending');
  const c1 = await up.cancel(id1);
  assert.deepEqual(c1, { ok: true, masterCleared: true });
  assert.equal(fleetData.status(id1).status, 'cancelled');
  assert.equal(up.status(id1).status, 'cancelled');
  assert.ok(!inboxDirs().some((d) => d.startsWith('world-c1.')), 'the master\'s inbox is gone');

  // Slave, link down: the slave stops offering; the master's next pull ends it.
  const b2 = [blob('c/two.bin', 512 * 1024)];
  const { id: id2 } = await up.publish('world', 'master.test', { name: 'world-c2', manifest: { blobs: b2 }, origin: OWNER });
  await waitFor(() => fleetData.status(id2)?.phase === 'sending');
  link.up = false;
  const c2 = await up.cancel(id2);
  assert.deepEqual(c2, { ok: true, masterCleared: false });
  const r2 = await waitDone(id2);
  link.up = true;
  assert.equal(r2.status, 'cancelled');
  assert.match(r2.summary, /cancelled on s1/);
  assert.ok(!inboxDirs().some((d) => d.startsWith('world-c2.')));

  // Master (the panel's Cancel): the slave hears it from the push.
  const b3 = [blob('c/three.bin', 512 * 1024)];
  const { id: id3 } = await up.publish('world', 'master.test', { name: 'world-c3', manifest: { blobs: b3 }, origin: OWNER });
  await waitFor(() => fleetData.status(id3)?.phase === 'sending');
  const c3 = await fleetData.cancel(id3);
  assert.deepEqual(c3, { ok: true, inboxCleared: true });
  await waitFor(() => up.status(id3)?.status === 'cancelled');
  assert.ok(!inboxDirs().some((d) => d.startsWith('world-c3.')));
  fault.delayGetMs = 0;
});

test('governance: a remote job the owner started or approved runs at once; anything else is a proposal on the master', async () => {
  // Owner-started remote job: ledgered `owner via fleet.jobs <id>`.
  remoteRecs.set('fr-owner0001', { id: 'fr-owner0001', app: 'world', peer: 's1', status: 'running', origin: { kind: 'owner', route: '/build' } });
  const b1 = [blob('g/one.bin', 4096)];
  const r1 = await up.publish('world', 'master.test', { name: 'world-g1', manifest: { blobs: b1 }, origin: { kind: 'user', remoteJob: 'fr-owner0001' } });
  assert.ok(!r1.proposed);
  assert.equal((await waitDone(r1.id)).status, 'done');
  assert.equal(audits.find((a) => a.summary.includes(r1.id)).via, 'owner via fleet.jobs fr-owner0001');

  // A remote job the owner approved (its proposal checked here, on the master).
  proposals.set('p-ok', { id: 'p-ok', kind: 'app.remote_job', payload: { id: 'fr-appr00001' }, status: 'executed' });
  remoteRecs.set('fr-appr00001', { id: 'fr-appr00001', app: 'world', peer: 's1', status: 'running', origin: { kind: 'ai', tool: 'session:world', proposalId: 'p-ok' }, proposalId: 'p-ok' });
  const b2 = [blob('g/two.bin', 4096)];
  const r2 = await up.publish('world', 'master.test', { name: 'world-g2', manifest: { blobs: b2 }, origin: { kind: 'ai', remoteJob: 'fr-appr00001' } });
  assert.ok(!r2.proposed);
  assert.equal((await waitDone(r2.id)).status, 'done');
  const row2 = audits.find((a) => a.summary.includes(r2.id));
  assert.equal(row2.via, 'owner (approved p-ok) via fleet.jobs fr-appr00001');
  assert.equal(row2.proposalId, 'p-ok');

  // Not trusted: a pending proposal, another record's proposal, another
  // slave's or app's job, an ended job, an unknown id.
  proposals.set('p-pend', { id: 'p-pend', kind: 'app.remote_job', payload: { id: 'fr-pend00001' }, status: 'pending' });
  remoteRecs.set('fr-pend00001', { id: 'fr-pend00001', app: 'world', peer: 's1', status: 'running', origin: { kind: 'cron', proposalId: 'p-pend' } });
  remoteRecs.set('fr-swap00001', { id: 'fr-swap00001', app: 'world', peer: 's1', status: 'running', origin: { kind: 'cron', proposalId: 'p-ok' } });
  remoteRecs.set('fr-other0001', { id: 'fr-other0001', app: 'world', peer: 's2', status: 'running', origin: { kind: 'owner' } });
  remoteRecs.set('fr-old000001', { id: 'fr-old000001', app: 'world', peer: 's1', status: 'done', endedAt: Date.now() - 10 * 60 * 1000, origin: { kind: 'owner' } });
  for (const rj of ['fr-pend00001', 'fr-swap00001', 'fr-other0001', 'fr-old000001', 'fr-nope00001']) {
    assert.equal(up.decide('s1', 'world', { kind: 'owner', remoteJob: rj }), null, rj);
  }

  // Slave cron / AI → a proposal on the MASTER's plane; nothing runs until approved.
  const b3 = [blob('g/three.bin', 4096)];
  const before = fleetData.list({}).length;
  const r3 = await up.publish('world', 'master.test', { name: 'world-g3', manifest: { blobs: b3 }, origin: { kind: 'cron' } });
  assert.equal(r3.proposed, true);
  const prop = proposals.get(r3.proposalId);
  assert.equal(prop.kind, 'app.data_publish');
  assert.equal(prop.payload.dir, 'up');
  assert.equal(prop.payload.peer, 's1');
  assert.equal(prop.payload.needBytes, 4096);
  assert.equal(prop.payload.fits, true);
  assert.equal(prop.payload.origin.kind, 'cron');
  assert.equal(fleetData.list({}).length, before, 'no record before approval');
  assert.equal(up.status(r3.id), null, 'the slave has no record before approval either');
  const r4 = await up.publish('world', 'master.test', { name: 'world-g4', manifest: { blobs: [blob('g/four.bin', 10)] }, origin: { kind: 'ai', tool: 'horst' } });
  assert.equal(r4.proposed, true);

  // Approval on the master runs the kind's executor → the transfer starts under that id.
  const kind = require('../src/apps/capabilities').get('fleet').horst.kinds['app.data_publish'];
  assert.match(kind.describe(prop.payload), /from slave "s1" onto this master/);
  const card = kind.card(prop.payload);
  assert.ok(card.fields.some((f) => f.label === 'Direction' && /up/.test(f.value)));
  assert.notEqual(kind.identity(prop.payload), kind.identity({ ...prop.payload, dir: 'down' }));
  const ex = await kind.execute(prop.payload, { id: r3.proposalId });
  assert.equal(ex.id, r3.id);
  assert.equal((await waitDone(r3.id)).status, 'done');
  assert.equal(fleetData.status(r3.id).origin.proposalId, r3.proposalId);
  await waitFor(() => up.status(r3.id)?.status === 'done');
  assert.ok(b3.every(objectOk));
});

test('the slave serves only what it offered, inside its data dir', async () => {
  const peer = peers.get('s1');
  const client = require('../src/apps/peer-client');
  const msha = 'a'.repeat(64);
  await assert.rejects(client.call(peer, `/fleet-data-up/world/world-zz/${msha}/manifest`), (e) => e.status === 410 && e.body.code === 'not-offered');
  // An offered manifest, but a sha outside it / past its end.
  const b = blob('o/one.bin', 100);
  const p = await up.plan('world', 'master.test', { name: 'world-o', manifest: { blobs: [b] } });
  await assert.rejects(client.download(peer, `/fleet-data-up/world/world-o/${p.manifestSha}/blobs/${'b'.repeat(64)}?offset=0&length=1`), (e) => e.body?.code === 'not-needed');
  await assert.rejects(client.download(peer, `/fleet-data-up/world/world-o/${p.manifestSha}/blobs/${b.sha256}?offset=50&length=51`), (e) => e.body?.code === 'past-end');
  const ok = await client.download(peer, `/fleet-data-up/world/world-o/${p.manifestSha}/blobs/${b.sha256}?offset=10&length=20`);
  const chunks = [];
  for await (const c of ok.stream) chunks.push(c);
  assert.deepEqual(Buffer.concat(chunks), fs.readFileSync(path.join(slaveData, 'o/one.bin')).subarray(10, 30));
  // A symlink leaving the data dir is refused at publish time.
  fs.symlinkSync('/etc/hostname', path.join(slaveData, 'o/escape'));
  await assert.rejects(up.plan('world', 'master.test', { name: 'world-o2', manifest: { blobs: [{ sha256: 'c'.repeat(64), bytes: 1, path: 'o/escape' }] } }), /outside the app's data dir|does not exist/);
  // A wrong token is refused.
  await assert.rejects(client.call({ ...peer, token: 'wrong' }, `/fleet-data-up/world/world-o/${p.manifestSha}/manifest`), (e) => e.status === 403);
});

test('ctx.fleet on the slave: dataPublish inside a remote job the owner started runs at once, ledgered `owner via fleet.jobs <id>`', async () => {
  const capabilities = require('../src/apps/capabilities');
  const remoteHost = require('../src/apps/fleet-remote-host');
  // The slave app is "running" for the remote-job host; its frames go nowhere.
  remoteHost.init({ appManager: { ...appManager, getMountedRouter: () => ({}) }, masterHost: () => 'master.test', send: () => true });
  const ctx = capabilities.buildCtx({ name: 'world', dir: path.join(masterApps, 'world'), manifest: appManager.readManifest('world'), broadcaster: { broadcast() {} } }, { profile: 'dashboard' });
  assert.ok(ctx.capabilities.has('fleet.sync.up'));
  const m = await ctx.fleet.master();
  assert.equal(m.peer, 'master.test');

  const blobs = [blob('j/one.bin', 4096)];
  let out = null;
  const off = remoteHost.registerJob('world', 'rb.build', () => ({
    name: 'remote-build',
    run: async () => { out = await ctx.fleet.dataPublish(m.peer, { name: 'world-j1', manifest: { blobs } }); return { ok: true }; },
  }));
  remoteRecs.set('fr-cap000001', { id: 'fr-cap000001', app: 'world', peer: 's1', status: 'running', origin: { kind: 'owner', route: '/build' } });
  const { remoteJobId } = await remoteHost.startJob('world', { kind: 'rb.build', args: {}, id: 'fr-cap000001', origin: { kind: 'owner', route: '/build' } });
  await waitFor(() => appJobs.getJob('world', remoteJobId)?.status === 'done');
  off();
  remoteHost.shutdown();
  assert.ok(out && !out.proposed, JSON.stringify(out));
  assert.equal((await waitDone(out.id)).status, 'done');
  assert.equal(audits.find((a) => a.summary.includes(out.id)).via, 'owner via fleet.jobs fr-cap000001');
  assert.equal(fleetData.status(out.id).origin.remoteJob, 'fr-cap000001');
  // The same app outside a remote job, not the owner (a cron here): a proposal.
  const r = await require('../src/apps/spend-context').run({ app: 'world', origin: 'cron', principal: null }, () => ctx.fleet.dataPublish(m.peer, { name: 'world-j2', manifest: { blobs } }));
  assert.equal(r.proposed, true);
  await waitFor(() => ctx.fleet.dataPublish.status(out.id)?.status === 'done');
  assert.ok(ctx.fleet.dataPublish.list().some((x) => x.id === out.id));
});
