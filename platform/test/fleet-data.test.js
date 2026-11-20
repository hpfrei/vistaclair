// Fleet data publish (docs/fleet-data.md): a two-host harness on loopback in a
// temp dir. The SLAVE is an express app with the real peer-server router (its
// token auth, limiter and /fleet-data routes) over a temp apps dir with a fake
// in-process app registering have/receive. The MASTER is fleet-data.js with
// its own temp apps dir and state dir; its peer URL points at a second express
// app, a pass-through proxy that counts the bytes on the wire and can cut a
// connection. Never touches the live control-room server or its ports.
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
const M = require('../src/apps/fleet-data-manifest');

const TOKEN = 'test-peer-token-' + crypto.randomBytes(8).toString('hex');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// --- Slave host -----------------------------------------------------------------
const slaveApps = makeAppsDir({ world: {}, sidecar: { runtime: 'own-process' } });
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-fd-home-'));
appManager.setAppsDir(slaveApps);
hostConfig.init(slaveApps, { dataHome });
hostConfig.setRole('slave');
hostConfig.enableApp('world');
hostConfig.enableApp('sidecar');
const secretFiles = new Map([[path.join(slaveApps, '.peer.enc'), { tokenHash: sha(TOKEN), pending: null }]]);
pairing.init({
  appsDir: slaveApps,
  broadcaster: null,
  secretStore: {
    readSecretFile: (p, _d, o) => (secretFiles.has(p) ? secretFiles.get(p) : (o?.fallback ?? {})),
    writeSecretFile: (p, data) => { secretFiles.set(p, data); },
  },
});
appJobs.init({ appsDir: slaveApps });

const GiB = 1024 ** 3;
let disk = { free: 1000 * GiB, total: 1000 * GiB };   // margin = max(1 GiB, 2 %) = 20 GiB
const statfsStub = () => ({ bsize: 1, bavail: disk.free, blocks: disk.total });
receive.init({ appsDir: slaveApps, sweep: false, statfs: statfsStub });

// The fake app: a content-addressed object store under its data dir.
const objects = path.join(slaveApps, 'world', '.data', 'objects');
fs.mkdirSync(objects, { recursive: true });
const receiveCalls = [];
let receiveImpl = null;
async function defaultReceive({ manifest, inbox }) {
  let n = 0;
  for (const f of fs.readdirSync(inbox)) {
    const dest = path.join(objects, f);
    if (!fs.existsSync(dest)) fs.linkSync(path.join(inbox, f), dest);
    n++;
  }
  return { ok: true, summary: `imported ${n} of ${manifest.blobs.length}` };
}
const unregisterWorld = receive.registerReceiver('world', 'world-*', {
  have: async (m) => m.blobs.map((b) => b.sha256).filter((s) => fs.existsSync(path.join(objects, s))),
  receive: async (args) => { receiveCalls.push(args); return (receiveImpl || defaultReceive)(args); },
});

// --- Servers --------------------------------------------------------------------
const listen = (app) => new Promise((resolve) => {
  const srv = http.createServer(app).listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
});
const close = (srv) => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); });

const wire = { putBytes: 0, puts: [], cut: 0 };
const fault = { cutPutAfter: 0, delayPutMs: 0 };   // cutPutAfter: cut the PUT that crosses this many wire bytes
let slave;
let proxy;
let legacy;

function proxyApp(slavePort) {
  const app = express();
  app.use((req, res) => {
    const forward = () => {
      const up = http.request({ host: '127.0.0.1', port: slavePort, method: req.method, path: req.originalUrl, headers: req.headers }, (ur) => {
        res.writeHead(ur.statusCode, ur.headers);
        ur.pipe(res);
      });
      up.on('error', () => res.destroy());
      if (req.method === 'PUT') {
        wire.puts.push(req.originalUrl);
        req.on('data', (c) => {
          wire.putBytes += c.length;
          // cutPutAfter counts wire bytes from when it was set (wire.putBytes is reset with it).
          if (fault.cutPutAfter && wire.putBytes >= fault.cutPutAfter) {
            fault.cutPutAfter = 0;
            wire.cut++;
            up.destroy();
            req.socket.destroy();
          }
        });
      }
      req.pipe(up);
    };
    if (req.method === 'PUT' && fault.delayPutMs) setTimeout(forward, fault.delayPutMs); else forward();
  });
  return app;
}

// --- Master host ------------------------------------------------------------------
const masterApps = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-fd-master-'));
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
fs.mkdirSync(path.join(masterApps, 'world', '.data'), { recursive: true });
fs.mkdirSync(path.join(masterApps, 'sidecar', '.data'), { recursive: true });

function blob(rel, size, app = 'world') {
  const buf = crypto.randomBytes(size);
  const file = path.join(masterApps, app, '.data', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return { sha256: sha(buf), bytes: size, path: rel };
}

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
const inboxDirs = (app = 'world') => { try { return fs.readdirSync(path.join(receive.rootDir(), app)); } catch { return []; } };
const objectOk = (b) => fs.existsSync(path.join(objects, b.sha256)) && sha(fs.readFileSync(path.join(objects, b.sha256))) === b.sha256;

test.before(async () => {
  slave = await listen(express().use('/api/peer', peerServer.createPeerRouter({})));
  proxy = await listen(proxyApp(slave.port));
  legacy = await listen(express().use((req, res) => res.status(404).json({ error: 'not found' })));
  peers.set('s1', { id: 'peer-1', name: 's1', baseUrl: `http://127.0.0.1:${proxy.port}`, token: TOKEN });
  peers.set('old', { id: 'peer-2', name: 'old', baseUrl: `http://127.0.0.1:${legacy.port}`, token: TOKEN });
  peers.set('bad', { id: 'peer-3', name: 'bad', baseUrl: `http://127.0.0.1:${slave.port}`, token: 'wrong' });
  fleetData.init(masterOpts());
});

test.after(async () => {
  await fleetData.shutdown();
  receive.shutdown();
  pairing.shutdown();
  await Promise.all([close(slave.srv), close(proxy.srv), close(legacy.srv)]);
  for (const d of [slaveApps, masterApps, dataHome]) fs.rmSync(d, { recursive: true, force: true });
});

// --- Tests --------------------------------------------------------------------------

test('manifest: canonical sha ignores key order; limits refuse bad shapes', () => {
  const a = { format: 'x', blobs: [{ sha256: 'a'.repeat(64), bytes: 1, path: 'p' }], extra: { b: 1, a: 2 } };
  const b = { extra: { a: 2, b: 1 }, blobs: [{ path: 'p', bytes: 1, sha256: 'a'.repeat(64) }], format: 'x' };
  assert.equal(M.validateManifest(a).sha, M.validateManifest(b).sha);
  assert.throws(() => M.validateManifest({ blobs: [{ sha256: 'A'.repeat(64), bytes: 1, path: 'p' }] }), /sha256/);
  assert.throws(() => M.validateManifest({ blobs: [], extra: 'x'.repeat(M.MAX_EXTRA_BYTES + 1) }), /extra/);
  assert.throws(() => M.validateManifest({ blobs: [{ sha256: 'a'.repeat(64), bytes: 1, path: 'p' }, { sha256: 'a'.repeat(64), bytes: 2, path: 'q' }] }), /two sizes/);
});

test('peers: the linked slave with the app, online, with disk free', async () => {
  const rows = await fleetData.peers('world');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].peer, 's1');
  assert.equal(rows[0].online, true);
  assert.equal(rows[0].app.installed, true);
  assert.equal(rows[0].disk.freeBytes, disk.free);
  assert.deepEqual(rows[0].receivers, ['world-*']);
});

let manifestA;
let blobsA;
test('delta: have + multi-chunk; receive failure keeps the inbox, the retry sends 0 bytes', async () => {
  blobsA = [blob('w/big.bin', 200 * 1024), blob('w/small.bin', 10 * 1024), blob('w/held.bin', 10 * 1024)];
  fs.copyFileSync(path.join(masterApps, 'world', '.data', 'w/held.bin'), path.join(objects, blobsA[2].sha256));
  manifestA = { format: 'test/1', blobs: blobsA, extra: { world: 'A' } };

  const p = await fleetData.plan('world', 's1', { name: 'world-a', manifest: manifestA });
  assert.deepEqual(p.need.sort(), [blobsA[0].sha256, blobsA[1].sha256].sort());
  assert.equal(p.needBytes, 210 * 1024);
  assert.equal(p.haveBytes, 10 * 1024);
  assert.equal(p.fits, true);
  assert.equal(inboxDirs().length, 0, 'plan alone creates no inbox');

  const events = [];
  const unsub = fleetData.subscribe((ev, d) => events.push([ev, d]));
  const slaveEvents = [];
  const unsubSlave = receive.subscribe((ev, d) => slaveEvents.push([ev, d]));
  receiveImpl = async ({ setProgress }) => { setProgress(50, 'checking gates'); throw new Error('gate failed: client_min'); };
  wire.putBytes = 0; wire.puts = [];
  const { id } = await fleetData.start('world', 's1', { name: 'world-a', manifest: manifestA, meta: { by: 'test' }, origin: 'owner' });
  const r1 = await waitDone(id);
  unsub();
  unsubSlave();
  const phases = new Set(slaveEvents.filter(([ev]) => ev === 'fleet:data:progress').map(([, d]) => d.phase));
  assert.deepEqual([...phases].sort(), ['receive', 'receiving', 'verifying']);
  assert.ok(slaveEvents.some(([ev, d]) => ev === 'fleet:data:progress' && d.label === 'checking gates'));
  assert.ok(slaveEvents.some(([ev, d]) => ev === 'fleet:data:done' && d.ok === false && /gate failed/.test(d.summary)));
  assert.equal(r1.status, 'failed');
  assert.match(r1.error, /gate failed/);
  assert.equal(wire.putBytes, 210 * 1024, 'only the delta crossed the wire');
  assert.equal(wire.puts.filter((u) => u.includes(blobsA[0].sha256)).length, 4, '200 KB in 64 KB chunks');
  assert.ok(events.some(([ev, d]) => ev === 'fleet:data:progress' && d.phase === 'sending'));
  assert.ok(events.some(([ev, d]) => ev === 'fleet:data:done' && d.ok === false));
  assert.equal(inboxDirs().length, 1, 'inbox kept after a failed receive');
  const st = receive.status('world', 'world-a', r1.manifestSha);
  assert.equal(st.exists, true);
  assert.equal(st.need.length, 0);

  // The inbox counts as held: the plan's delta is empty now.
  const p2 = await fleetData.plan('world', 's1', { name: 'world-a', manifest: manifestA });
  assert.equal(p2.need.length, 0);
  assert.equal(p2.needBytes, 0);

  receiveImpl = null;
  wire.putBytes = 0;
  const again = await fleetData.start('world', 's1', { name: 'world-a', manifest: manifestA });
  assert.equal(again.id, id, 'same peer + app + name + manifest = same transfer');
  const r2 = await waitDone(id);
  assert.equal(r2.status, 'done', r2.error);
  assert.match(r2.summary, /imported 2 of 3/);
  assert.equal(wire.putBytes, 0);
  assert.equal(inboxDirs().length, 0, 'inbox removed after ok');
  assert.ok(blobsA.every(objectOk));
  const last = receiveCalls[receiveCalls.length - 1];
  assert.deepEqual(last.extra, { world: 'A' });
  assert.ok(last.signal instanceof AbortSignal);
});

test('a second identical publish sends 0 bytes and still runs receive', async () => {
  const n = receiveCalls.length;
  wire.putBytes = 0;
  const { id } = await fleetData.start('world', 's1', { name: 'world-a', manifest: manifestA });
  const r = await waitDone(id);
  assert.equal(r.status, 'done', r.error);
  assert.equal(wire.putBytes, 0);
  assert.equal(r.needBytes, 0);
  assert.equal(receiveCalls.length, n + 1);
});

test('resume after an aborted connection', async () => {
  const b = blob('w/cut.bin', 300 * 1024);
  wire.putBytes = 0; wire.cut = 0;
  fault.cutPutAfter = 100 * 1024 - 10 * 1024;     // inside the second 64 KB chunk
  const { id } = await fleetData.start('world', 's1', { name: 'world-cut', manifest: { blobs: [b] } });
  const r = await waitDone(id);
  assert.equal(r.status, 'done', r.error);
  assert.equal(wire.cut, 1);
  assert.ok(objectOk(b));
  assert.ok(wire.putBytes < 300 * 1024 + 64 * 1024, `resumed, not restarted (${wire.putBytes} bytes on the wire)`);
});

test('resume after a master restart (re-init from persisted state)', async () => {
  const b = blob('w/restart.bin', 640 * 1024);
  fault.delayPutMs = 15;
  wire.putBytes = 0;
  const { id } = await fleetData.start('world', 's1', { name: 'world-restart', manifest: { blobs: [b] } });
  await new Promise((resolve) => {
    const unsub = fleetData.subscribe((ev, d) => {
      if (ev === 'fleet:data:progress' && d.id === id && d.sentBytes >= 192 * 1024) { unsub(); resolve(); }
    });
  });
  await fleetData.shutdown();
  const persisted = JSON.parse(fs.readFileSync(path.join(masterApps, '.fleet-data', 'transfers.json'), 'utf-8')).transfers.find((t) => t.id === id);
  assert.equal(persisted.status, 'running', 'a shutdown leaves the transfer running on disk');
  const before = wire.putBytes;
  fleetData.init(masterOpts());
  const r = await waitDone(id);
  fault.delayPutMs = 0;
  assert.equal(r.status, 'done', r.error);
  assert.ok(objectOk(b));
  assert.ok(wire.putBytes - before <= 640 * 1024 - 192 * 1024 + 64 * 1024, `resumed at the slave's offset (${wire.putBytes - before} bytes after restart)`);
});

test('sha mismatch: dropped and re-sent once, then the transfer fails naming the blob', async () => {
  const b = blob('w/liar.bin', 20 * 1024);
  const wrong = { ...b, sha256: sha(Buffer.from('something else')) };
  wire.putBytes = 0;
  const { id } = await fleetData.start('world', 's1', { name: 'world-liar', manifest: { blobs: [wrong] } });
  const r = await waitDone(id);
  assert.equal(r.status, 'failed');
  assert.match(r.error, new RegExp(wrong.sha256));
  assert.equal(wire.putBytes, 2 * 20 * 1024, 'sent twice');
  await fleetData.cancel(id).catch(() => {});
  receive.cancel('world', 'world-liar', r.manifestSha);
});

test('path escape, symlinks out, non-files and wrong sizes are refused on the master', async () => {
  const outside = path.join(masterApps, 'secret.txt');
  fs.writeFileSync(outside, 'top secret');
  fs.symlinkSync(outside, path.join(masterApps, 'world', '.data', 'link.txt'));
  fs.mkdirSync(path.join(masterApps, 'world', '.data', 'adir'), { recursive: true });
  const s = sha(Buffer.from('top secret'));
  const cases = [
    [{ sha256: s, bytes: 10, path: '../secret.txt' }, /not inside/],
    [{ sha256: s, bytes: 10, path: outside }, /not inside/],
    [{ sha256: s, bytes: 10, path: 'link.txt' }, /outside/],
    [{ sha256: s, bytes: 10, path: 'adir' }, /regular file/],
    [{ sha256: s, bytes: 11, path: 'w/small.bin' }, /bytes/],
    [{ sha256: s, bytes: 10, path: 'missing.bin' }, /does not exist/],
  ];
  for (const [b, re] of cases) {
    await assert.rejects(fleetData.start('world', 's1', { name: 'world-esc', manifest: { blobs: [b] } }), re, b.path);
  }
  assert.equal(fleetData.list({ app: 'world', name: 'world-esc' }).length, 0);
});

test('disk: a plan that does not fit is refused up front; a chunk that would break the margin is refused', async () => {
  const b = blob('w/fat.bin', 256 * 1024);
  disk = { free: GiB + 100 * 1024, total: 10 * GiB };          // margin 1 GiB, 100 KB spare
  const p = await fleetData.plan('world', 's1', { name: 'world-fat', manifest: { blobs: [b] } });
  assert.equal(p.fits, false);
  assert.equal(p.marginBytes, GiB);
  wire.putBytes = 0;
  const { id } = await fleetData.start('world', 's1', { name: 'world-fat', manifest: { blobs: [b] } });
  const r = await waitDone(id);
  assert.equal(r.status, 'failed');
  assert.match(r.error, /does not fit/);
  assert.equal(wire.putBytes, 0);
  assert.equal(inboxDirs().filter((d) => d.startsWith('world-fat.')).length, 0);

  // Fits at plan time; the disk fills from elsewhere mid-way.
  disk = { free: GiB + 10 * 1024 * 1024, total: 10 * GiB };
  const unsub = fleetData.subscribe((ev, d) => { if (ev === 'fleet:data:progress' && d.name === 'world-fat2' && d.sentBytes > 0) disk = { free: GiB + 1000, total: 10 * GiB }; });
  const b2 = blob('w/fat2.bin', 256 * 1024);
  const s2 = await fleetData.start('world', 's1', { name: 'world-fat2', manifest: { blobs: [b2] } });
  const r2 = await waitDone(s2.id);
  unsub();
  disk = { free: 1000 * GiB, total: 1000 * GiB };
  assert.equal(r2.status, 'failed');
  assert.match(r2.error, /margin/);
  receive.cancel('world', 'world-fat2', r2.manifestSha);
});

test('cancel stops the run and removes the slave inbox', async () => {
  const b = blob('w/slow.bin', 640 * 1024);
  fault.delayPutMs = 30;
  const { id } = await fleetData.start('world', 's1', { name: 'world-slow', manifest: { blobs: [b] } });
  await new Promise((resolve) => {
    const unsub = fleetData.subscribe((ev, d) => { if (ev === 'fleet:data:progress' && d.id === id && d.sentBytes > 0) { unsub(); resolve(); } });
  });
  const c = await fleetData.cancel(id);
  assert.equal(c.ok, true);
  assert.equal(c.slaveCleared, true);
  assert.equal(fleetData.status(id).status, 'cancelled');
  const n = wire.puts.length;
  await new Promise((r) => setTimeout(r, 150));
  fault.delayPutMs = 0;
  assert.ok(wire.puts.length <= n + 1, 'no further chunks after cancel');
  assert.equal(inboxDirs().filter((d) => d.startsWith('world-slow.')).length, 0);
  assert.equal((await fleetData.cancel(id)).ok, false);
});

test('expiry sweep removes an inbox idle for 7 days and keeps a fresh one', async () => {
  const b1 = blob('w/exp1.bin', 1024);
  const b2 = blob('w/exp2.bin', 1024);
  const v1 = M.validateManifest({ blobs: [b1] });
  const v2 = M.validateManifest({ blobs: [b2] });
  await receive.plan('world', { name: 'world-old', manifest: v1.manifest, open: true });
  await receive.plan('world', { name: 'world-new', manifest: v2.manifest, open: true });
  const old = path.join(receive.rootDir(), 'world', `world-old.${v1.sha}`, 'transfer.json');
  const t = new Date(Date.now() - receive.EXPIRY_MS - 60000);
  fs.utimesSync(old, t, t);
  assert.equal(receive.sweep().removed, 1);
  const left = inboxDirs();
  assert.ok(left.some((d) => d.startsWith('world-new.')));
  assert.ok(!left.some((d) => d.startsWith('world-old.')));
  receive.cancel('world', 'world-new', v2.sha);
});

test('own-process apps are refused, on both sides', async () => {
  assert.throws(() => receive.registerReceiver('sidecar', 'x', { have: async () => [], receive: async () => ({ ok: true }) }), /own process/);
  const b = blob('s.bin', 1024, 'sidecar');
  await assert.rejects(fleetData.plan('sidecar', 's1', { name: 'x', manifest: { blobs: [b] } }), /own process/);
});

test('a slave without the routes → "update vc there"; a wrong token is refused', async () => {
  await assert.rejects(fleetData.plan('world', 'old', { name: 'world-a', manifest: manifestA }), /update vc there/);
  await assert.rejects(fleetData.plan('world', 'bad', { name: 'world-a', manifest: manifestA }), /forbidden/);
});

test('slave routes validate input and bound the chunk size', async () => {
  const base = `http://127.0.0.1:${slave.port}/api/peer/fleet-data`;
  const h = { 'X-Vistaclair-Peer-Token': TOKEN };
  let r = await fetch(`${base}/world/BAD NAME/${'a'.repeat(64)}`, { headers: h });
  assert.equal(r.status, 400);
  r = await fetch(`${base}/world/world-a/${'z'.repeat(64)}`, { headers: h });
  assert.equal(r.status, 400);
  r = await fetch(`${base}/world/world-a/${'a'.repeat(64)}/blobs/${'a'.repeat(64)}?offset=0`, {
    method: 'PUT', headers: { ...h, 'Content-Length': String(receive.CHUNK_MAX + 1) }, body: Buffer.alloc(16), duplex: 'half',
  }).catch((err) => ({ status: 'error', err }));
  // undici refuses a mismatched Content-Length itself; when it gets through, the slave answers 413.
  if (r.status !== 'error') assert.equal(r.status, 413);
  r = await fetch(`${base}/world/world-zz/${'a'.repeat(64)}/blobs/${'a'.repeat(64)}?offset=0`, { method: 'PUT', headers: h, body: Buffer.alloc(16) });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).code, 'no-transfer');
});

test('unregisterApp drops the app\'s receivers (the app-unload path)', () => {
  assert.ok(receive.findReceiver('world', 'world-x'));
  receive.unregisterApp('world');
  assert.equal(receive.findReceiver('world', 'world-x'), null);
  assert.equal(typeof unregisterWorld, 'function');
});
