// Fleet remote call / job (fleet-remote.js, fleet-remote-host.js): a two-host
// harness on loopback in temp dirs. The SLAVE is an express app with the real
// peer-server router (token auth, /fleet-remote routes) over a temp apps dir,
// fleet-remote-host with an injected app-manager view (which apps are
// "running") and a `send` that forwards fr:job frames to the master's fake
// channel (switchable off = link down). The MASTER is fleet-remote.js with
// injected peers, online set, channel, governance and a temp state dir.
// Never touches the live control-room server or its ports.
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
const sc = require('../src/apps/spend-context');
const W = require('../src/apps/fleet-remote-wire');
const remoteHost = require('../src/apps/fleet-remote-host');
const remote = require('../src/apps/fleet-remote');
const fleetData = require('../src/apps/fleet-data');
const receive = require('../src/apps/fleet-data-receive');
const fleetCap = require('../src/apps/capabilities/fleet');

const TOKEN = 'test-peer-token-' + crypto.randomBytes(8).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what = 'condition', ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
function gate() { let open; const p = new Promise((r) => { open = r; }); return { p, open }; }

// Origins as the platform sets them.
const asOwner = (fn) => sc.run({ app: 'world', origin: 'route', principal: 'owner', route: 'POST /build' }, fn);
const asCron = (fn) => sc.run({ app: 'world', origin: 'cron', principal: null }, fn);
const asAi = (fn) => sc.run({ app: 'world', origin: 'tool', principal: null, caller: { type: 'horst' } }, fn);

// --- Slave host -----------------------------------------------------------------
const slaveApps = makeAppsDir({ world: {}, lost: {}, idle: {}, stopped: {} });
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-fr-home-'));
appManager.setAppsDir(slaveApps);
hostConfig.init(slaveApps, { dataHome });
hostConfig.setRole('slave');
for (const a of ['world', 'lost', 'stopped']) hostConfig.enableApp(a);
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

const mounted = new Set(['world', 'lost']);
const slaveAM = {
  readManifest: (n) => appManager.readManifest(n),
  appRuntime: (n) => appManager.appRuntime(n),
  getMountedRouter: (n) => (mounted.has(n) ? {} : null),
  getRunningApp: () => null,
};

// --- The channel between them (fake) ------------------------------------------------
const chan = { events: new Set(), frames: new Set(), up: true, sent: [] };
const fakeChannel = {
  onEvent(fn) { chan.events.add(fn); return () => chan.events.delete(fn); },
  onFleetFrame(fn) { chan.frames.add(fn); return () => chan.frames.delete(fn); },
};
function slaveSend(frame) {
  if (!chan.up || !chan.frames.size) return false;
  const msg = JSON.parse(JSON.stringify(frame));
  chan.sent.push(msg);
  setImmediate(() => { for (const fn of [...chan.frames]) fn('s1', msg); });
  return true;
}
const online = new Set(['s1', 'old', 'gone']);
function linkDown() { chan.up = false; online.delete('s1'); for (const fn of [...chan.events]) fn({ type: 'disconnected', peer: 's1' }); }
function linkUpQuiet() { chan.up = true; online.add('s1'); }

remoteHost.init({ appManager: slaveAM, masterHost: () => 'master.local', send: slaveSend });

// --- Master host ------------------------------------------------------------------
const masterState = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-fr-master-'));
const peers = new Map();
const gov = {
  seq: 0, proposals: new Map(), requests: [], audits: [], withdrawn: [],
  requestAction(kind, payload, meta) {
    const proposal = { id: `prop-${++this.seq}`, kind, payload: JSON.parse(JSON.stringify(payload)), status: 'pending' };
    this.proposals.set(proposal.id, proposal);
    this.requests.push({ kind, payload: proposal.payload, meta, proposal });
    return { mode: 'proposed', proposal };
  },
  audit(row) { this.audits.push(row); },
  getProposal(id) { return this.proposals.get(id) || null; },
  withdrawProposal(id, via) { this.withdrawn.push([id, via]); const p = this.proposals.get(id); if (p) p.status = 'withdrawn'; },
};
const masterOpts = () => ({
  stateDir: masterState,
  getPeer: (ref) => peers.get(ref) || [...peers.values()].find((p) => p.id === ref) || null,
  appExists: (a) => ['world', 'lost', 'idle', 'stopped', 'other'].includes(a),
  isOnline: (p) => online.has(p),
  channel: fakeChannel,
  governance: gov,
  timers: false,
});

const evs = [];
remote.subscribe((ev, d) => evs.push({ ev, d, t: Date.now() }));
const evsFor = (id, ev) => evs.filter((e) => e.d.id === id && (!ev || e.ev === ev));
const waitDoneEv = (id) => waitFor(() => evsFor(id, 'fleet:job:done')[0]?.d, `done of ${id}`);

// --- Servers --------------------------------------------------------------------
const listen = (app) => new Promise((resolve) => {
  const srv = http.createServer(app).listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
});
const close = (srv) => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); });
let slave;
let legacy;

// --- The app (both ends: same process, two module halves) ----------------------------
const world = fleetCap.buildCtx({ name: 'world' }).fleet;
const lost = fleetCap.buildCtx({ name: 'lost' }).fleet;
const seen = {};
let slowSignal = null;
const jobImpl = new Map();   // args.tag → async (job, args) => result
const jobSignals = new Map();

function registerWorld() {
  world.onCall('echo', (args, { origin }) => ({ echo: args, origin }));
  world.onCall('peek', (args) => ({ peek: args }), { readOnly: true });
  world.onCall('write', (args) => ({ wrote: args }));
  world.onCall('slow', (args, { signal }) => { slowSignal = signal; return new Promise(() => {}); });
  world.onCall('big', () => 'x'.repeat(W.RESULT_MAX + 10));
  world.onCall('boom', () => { throw new Error('kaput: ' + 'y'.repeat(9000)); });
  world.onCall('stacky', () => { throw new Error('line one\n    at evil (/srv/x.js:1:1)\n    at more (/srv/y.js:2:2)'); });
  world.onCall('ctx', async () => {
    await Promise.resolve();
    await sleep(5);
    await new Promise((r) => setTimeout(r, 5));
    return remoteHost.remoteContext();
  });
  world.onJob('build', (args) => {
    seen.factory = remoteHost.remoteContext();
    return {
      name: `build-${args.tag}`,
      meta: { tag: args.tag },
      run: (job) => { jobSignals.set(args.tag, job.signal); return jobImpl.get(args.tag)(job, args); },
    };
  });
}

test.before(async () => {
  slave = await listen(express().use('/api/peer', peerServer.createPeerRouter({})));
  legacy = await listen(express().use((req, res) => res.status(404).json({ error: 'not found' })));
  const dead = await listen(express());
  const deadPort = dead.port;
  await close(dead.srv);
  peers.set('s1', { id: 'peer-1', name: 's1', baseUrl: `http://127.0.0.1:${slave.port}`, token: TOKEN });
  peers.set('old', { id: 'peer-2', name: 'old', baseUrl: `http://127.0.0.1:${legacy.port}`, token: TOKEN });
  peers.set('down', { id: 'peer-3', name: 'down', baseUrl: `http://127.0.0.1:${slave.port}`, token: TOKEN });
  peers.set('gone', { id: 'peer-4', name: 'gone', baseUrl: `http://127.0.0.1:${deadPort}`, token: TOKEN });
  registerWorld();
  remote.init(masterOpts());
});

test.after(async () => {
  remote.shutdown();
  remoteHost.shutdown();
  pairing.shutdown();
  await Promise.all([close(slave.srv), close(legacy.srv)]);
  for (const d of [slaveApps, masterState, dataHome]) fs.rmSync(d, { recursive: true, force: true });
});

// --- 1. call happy path ----------------------------------------------------------------

test('call: owner click runs at once and leaves an audit row', async () => {
  const n = gov.audits.length;
  const args = { a: 1, list: [1, 2] };
  const r = await asOwner(() => world.call('s1', 'echo', args));
  assert.deepEqual(r.echo, args);
  assert.deepEqual(r.origin, { kind: 'owner', route: 'POST /build' }, 'the slave sees the master\'s origin');
  assert.equal(gov.audits.length, n + 1);
  const row = gov.audits.at(-1);
  assert.equal(row.action, 'executed');
  assert.equal(row.kind, 'app.remote_call');
  assert.equal(row.ok, true);
  assert.equal(row.peer, 's1');
  assert.equal(row.name, 'echo');
  assert.equal(row.argsSha, W.argsSha(args));
  assert.equal(row.argsSha, W.argsSha({ list: [1, 2], a: 1 }), 'sha is key-order free');
  assert.deepEqual(row.origin, { kind: 'owner', route: 'POST /build' });
  assert.equal(gov.requests.length, 0, 'no proposal for the owner');
});

// --- 2. error codes ----------------------------------------------------------------

const rejectsCode = (p, code, re) => assert.rejects(p, (err) => {
  assert.equal(err.code, code, `${err.code}: ${err.message}`);
  if (re) assert.match(err.message, re);
  return true;
});

test('E_OFFLINE: peer not connected, or connected but unreachable', async () => {
  await rejectsCode(asOwner(() => world.call('down', 'echo', {})), 'E_OFFLINE', /not connected/);
  await rejectsCode(asOwner(() => world.call('gone', 'echo', {})), 'E_OFFLINE', /not reachable/);
});

test('E_NOT_RUNNING: app not enabled, or enabled but not running on the slave', async () => {
  await rejectsCode(asOwner(() => remote.call('idle', 's1', 'echo', {})), 'E_NOT_RUNNING', /not enabled/);
  await rejectsCode(asOwner(() => remote.call('stopped', 's1', 'echo', {})), 'E_NOT_RUNNING', /not running/);
});

test('E_NO_HANDLER: unknown handler; a slave without the routes says update vc there', async () => {
  await rejectsCode(asOwner(() => world.call('s1', 'nope', {})), 'E_NO_HANDLER', /no onCall handler "nope"/);
  await rejectsCode(asOwner(() => world.call('old', 'echo', {})), 'E_NO_HANDLER', /update vc there/);
});

test('E_TIMEOUT: a handler slower than timeoutMs has its signal aborted', async () => {
  slowSignal = null;
  const t0 = Date.now();
  await rejectsCode(asOwner(() => world.call('s1', 'slow', {}, { timeoutMs: 150 })), 'E_TIMEOUT');
  assert.ok(Date.now() - t0 < 2000, 'answered on the slave\'s deadline, not the master\'s');
  assert.ok(slowSignal, 'the handler ran');
  assert.equal(slowSignal.aborted, true);
});

test('E_TOO_LARGE: args over 256 KB refused on the master; a result over 1 MB from the slave', async () => {
  const before = chan.sent.length;
  await rejectsCode(asOwner(() => world.call('s1', 'echo', { blob: 'x'.repeat(W.ARGS_MAX) })), 'E_TOO_LARGE', /args/);
  await rejectsCode(asOwner(() => world.jobs.start('s1', 'build', { tag: 'x', blob: 'x'.repeat(W.ARGS_MAX) })), 'E_TOO_LARGE', /args/);
  assert.equal(chan.sent.length, before);
  await rejectsCode(asOwner(() => world.call('s1', 'big', {})), 'E_TOO_LARGE');
});

test('E_REMOTE: the handler throws — message capped at 4 KB, no stack; owner failure ledgered ok:false', async () => {
  const n = gov.audits.length;
  await assert.rejects(asOwner(() => world.call('s1', 'boom', {})), (err) => {
    assert.equal(err.code, 'E_REMOTE');
    assert.match(err.message, /^kaput: y/);
    assert.ok(err.message.length <= W.ERROR_MAX, `${err.message.length} chars`);
    assert.ok(!/\bat .*:\d+:\d+/.test(err.message));
    return true;
  });
  await assert.rejects(asOwner(() => world.call('s1', 'stacky', {})), (err) => {
    assert.equal(err.code, 'E_REMOTE');
    assert.equal(err.message, 'line one');
    return true;
  });
  const rows = gov.audits.slice(n);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.ok === false && r.kind === 'app.remote_call'));
});

// --- 3. origins ------------------------------------------------------------------------

test('readOnly handler runs for cron and AI with no audit row and no proposal', async () => {
  const n = gov.audits.length;
  const q = gov.requests.length;
  assert.deepEqual(await asCron(() => world.call('s1', 'peek', { k: 1 })), { peek: { k: 1 } });
  assert.deepEqual(await asAi(() => world.call('s1', 'peek', { k: 2 })), { peek: { k: 2 } });
  assert.equal(gov.audits.length, n);
  assert.equal(gov.requests.length, q);
});

test('non-readOnly from cron/AI: staged, E_REFUSED; approval grants one identical retry', async () => {
  // AI: staged with the tool named.
  let pid;
  await assert.rejects(asAi(() => world.call('s1', 'write', { n: 1 })), (err) => {
    assert.equal(err.code, 'E_REFUSED');
    assert.ok(err.proposalId);
    pid = err.proposalId;
    return true;
  });
  let req = gov.requests.at(-1);
  assert.equal(req.kind, 'app.remote_call');
  assert.equal(req.proposal.id, pid);
  assert.equal(req.payload.origin.kind, 'ai');
  assert.equal(req.payload.origin.tool, 'horst');
  assert.equal(req.meta.origin, 'horst');

  // Cron: staged; approved; the identical retry passes once.
  const args = { n: 2, s: 'two' };
  await assert.rejects(asCron(() => world.call('s1', 'write', args)), (err) => { pid = err.proposalId; return err.code === 'E_REFUSED' && !!pid; });
  req = gov.requests.at(-1);
  assert.equal(req.payload.app, 'world');
  assert.equal(req.payload.peer, 's1');
  assert.equal(req.payload.name, 'write');
  assert.equal(req.payload.argsSha, W.argsSha(args));
  assert.equal(req.payload.origin.kind, 'cron');
  assert.equal(req.meta.origin, 'cron');

  // A retry before approval is refused again.
  await rejectsCode(asCron(() => world.call('s1', 'write', args)), 'E_REFUSED');

  // The kind's executor (approval) grants it.
  const ex = fleetCap.horst.kinds['app.remote_call'].execute(req.payload, { id: pid });
  assert.equal(ex.ok, true);
  const n = gov.audits.length;
  assert.deepEqual(await asCron(() => world.call('s1', 'write', { s: 'two', n: 2 })), { wrote: args });
  assert.equal(gov.audits.length, n + 1);
  assert.equal(gov.audits.at(-1).proposalId, pid);
  assert.equal(gov.audits.at(-1).origin.proposalId, pid);
  assert.equal(gov.audits.at(-1).origin.kind, 'cron');

  // One shot.
  await rejectsCode(asCron(() => world.call('s1', 'write', args)), 'E_REFUSED');

  // A grant binds to the args: different args are refused, the grant stays.
  remote.addGrant({ app: 'world', peer: 's1', name: 'write', argsSha: W.argsSha({ n: 3 }) }, { id: 'prop-manual' });
  await rejectsCode(asCron(() => world.call('s1', 'write', { n: 4 })), 'E_REFUSED');
  assert.ok(remote._grants().some((g) => g.argsSha === W.argsSha({ n: 3 })));
  assert.deepEqual(await asCron(() => world.call('s1', 'write', { n: 3 })), { wrote: { n: 3 } });
  assert.ok(!remote._grants().some((g) => g.argsSha === W.argsSha({ n: 3 })));
});

// --- 4. jobs lifecycle -------------------------------------------------------------------

test('jobs: owner start → progress (pct/label verbatim, meta patch) → done with result', async () => {
  const g1 = gate(); const g2 = gate();
  const label = 'Compiling shaders — 3/7 ✓';
  jobImpl.set('life', async (job) => {
    job.setProgress(42.5, label);
    await g1.p;
    job.setMeta({ artifact: 'out.apk' });
    job.setProgress(80, 'packaging');
    await g2.p;
    return { apk: 'out.apk', size: 123 };
  });
  const n = gov.audits.length;
  const { id } = await asOwner(() => world.jobs.start('s1', 'build', { tag: 'life' }, { meta: { mine: true } }));
  assert.ok(W.isId(id));
  const row = gov.audits.at(-1);
  assert.equal(gov.audits.length, n + 1);
  assert.equal(row.kind, 'app.remote_job');
  assert.equal(row.name, 'build');
  assert.equal(row.argsSha, W.argsSha({ tag: 'life' }));

  const p1 = await waitFor(() => evsFor(id, 'fleet:job:progress').find((e) => e.d.label === label)?.d, 'first progress');
  assert.equal(p1.pct, 42.5);
  assert.equal(p1.peer, 's1');
  assert.equal(p1.kind, 'build');
  assert.equal(p1.link, 'up');
  assert.ok(W.isJobId(p1.remoteJobId));
  const st = world.jobs.status(id);
  assert.equal(st.status, 'running');
  assert.deepEqual(st.meta, { mine: true });
  assert.equal(st.remoteMeta.tag, 'life');
  assert.equal(st.remoteJobId, p1.remoteJobId);

  g1.open();
  const p2 = await waitFor(() => evsFor(id, 'fleet:job:progress').find((e) => e.d.meta?.artifact)?.d, 'meta patch');
  assert.deepEqual(p2.meta, { artifact: 'out.apk' }, 'only the changed keys');
  await waitFor(() => world.jobs.status(id).progress.label === 'packaging', 'packaging');

  g2.open();
  const done = await waitDoneEv(id);
  assert.equal(done.ok, true);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.result, { apk: 'out.apk', size: 123 });
  assert.equal(done.error, null);
  const fin = world.jobs.status(id);
  assert.equal(fin.status, 'done');
  assert.deepEqual(fin.result, { apk: 'out.apk', size: 123 });
  assert.equal(fin.remoteMeta.artifact, 'out.apk');
  assert.ok(world.jobs.list().some((r) => r.id === id));
});

test('jobs: cancel aborts the slave job; record cancelled, remoteCancelled true', async () => {
  jobImpl.set('cancel', (job) => new Promise((resolve) => job.signal.addEventListener('abort', () => resolve('aborted'))));
  const { id } = await asOwner(() => world.jobs.start('s1', 'build', { tag: 'cancel' }));
  await waitFor(() => jobSignals.get('cancel'), 'job started');
  const rec = world.jobs.status(id);
  const r = await world.jobs.cancel(id);
  assert.deepEqual(r, { ok: true, remoteCancelled: true });
  assert.equal(jobSignals.get('cancel').aborted, true);
  assert.equal(world.jobs.status(id).status, 'cancelled');
  assert.equal(appJobs.getJob('world', rec.remoteJobId).status, 'cancelled');
  const done = await waitDoneEv(id);
  assert.equal(done.ok, false);
  assert.equal(done.status, 'cancelled');
  assert.equal((await world.jobs.cancel(id)).ok, false, 'a second cancel is a no-op');
});

test('jobs: link down/up — link field, an event per change, resync from the slave store, progress resumes', async () => {
  const g1 = gate(); const g2 = gate(); const g3 = gate();
  jobImpl.set('link', async (job) => {
    job.setProgress(10, 'before');
    await g1.p;
    job.setProgress(50, 'while down');
    await g2.p;
    job.setProgress(70, 'after up');
    await g3.p;
    return 'linked';
  });
  const { id } = await asOwner(() => world.jobs.start('s1', 'build', { tag: 'link' }));
  await waitFor(() => evsFor(id, 'fleet:job:progress').some((e) => e.d.label === 'before'), 'before');

  linkDown();
  const down = await waitFor(() => evsFor(id, 'fleet:job:progress').find((e) => e.d.link === 'down')?.d, 'link down event');
  assert.equal(down.label, 'before');
  assert.equal(world.jobs.status(id).link, 'down');

  g1.open();
  await sleep(50);
  assert.ok(!evsFor(id, 'fleet:job:progress').some((e) => e.d.label === 'while down'), 'no frames over a down link');
  const nBefore = evsFor(id, 'fleet:job:progress').length;

  linkUpQuiet();
  remote._linkChange('s1', 'up');
  const up = await waitFor(() => evsFor(id, 'fleet:job:progress').slice(nBefore).find((e) => e.d.label === 'while down')?.d, 'resynced progress');
  assert.equal(up.link, 'up');
  assert.equal(up.pct, 50);
  assert.ok(evsFor(id, 'fleet:job:progress').slice(nBefore).every((e) => e.d.link === 'up'));
  assert.equal(world.jobs.status(id).link, 'up');

  g2.open();
  await waitFor(() => evsFor(id, 'fleet:job:progress').some((e) => e.d.label === 'after up'), 'progress after up');
  g3.open();
  const done = await waitDoneEv(id);
  assert.equal(done.ok, true);
  assert.equal(done.result, 'linked');
});

test('jobs: master restart — the record survives on disk and resyncs (finished meanwhile → done with result)', async () => {
  const g = gate();
  jobImpl.set('restart', async (job) => { job.setProgress(5, 'working'); await g.p; job.setProgress(100, 'finished'); return { built: 'restart' }; });
  const { id } = await asOwner(() => world.jobs.start('s1', 'build', { tag: 'restart' }));
  await waitFor(() => evsFor(id, 'fleet:job:progress').some((e) => e.d.label === 'working'), 'working');

  remote.shutdown();
  const disk = JSON.parse(fs.readFileSync(path.join(masterState, 'jobs.json'), 'utf-8')).jobs.find((r) => r.id === id);
  assert.equal(disk.status, 'running');
  assert.ok(W.isJobId(disk.remoteJobId));

  g.open();
  await waitFor(() => appJobs.getJob('world', disk.remoteJobId)?.status === 'done', 'slave job done');
  assert.ok(!evsFor(id, 'fleet:job:done').length, 'no master while it finished');

  remote.init(masterOpts());
  const rec = remote.status(id);
  assert.equal(rec.status, 'running', 'survived the restart');
  assert.equal(rec.link, 'up');
  await remote.sweep();
  const done = await waitDoneEv(id);
  assert.equal(done.ok, true);
  assert.deepEqual(done.result, { built: 'restart' });
  assert.equal(remote.status(id).progress.label, 'finished');
  assert.deepEqual(remote.status(id).result, { built: 'restart' });
});

test('jobs: a job the slave lost (interrupted there) fails on the master as "interrupted on <peer>"', async () => {
  lost.onJob('work', () => ({ run: (job) => new Promise((resolve) => job.signal.addEventListener('abort', () => resolve())) }));
  const { id } = await asOwner(() => lost.jobs.start('s1', 'work', {}));
  await waitFor(() => remote.status(id).remoteJobId, 'running on slave');
  const rjid = remote.status(id).remoteJobId;
  appJobs.cleanupApp('lost');
  // cleanupApp saves through app-jobs' write lock (a microtask later) and drops
  // its cache: a read in the same tick would re-cache the old file.
  await new Promise((r) => setImmediate(r));
  assert.equal(appJobs.getJob('lost', rjid).status, 'interrupted');
  const done = await waitDoneEv(id);
  assert.equal(done.ok, false);
  assert.equal(done.status, 'failed');
  assert.equal(done.error, 'interrupted on s1');
  assert.equal(remote.status(id).status, 'failed');
});

test('jobs: a proposed start (cron) is starting until approved, then runs under that id', async () => {
  const g = gate();
  let ctxSeen = null;
  jobImpl.set('approved', async (job) => { await g.p; ctxSeen = remoteHost.remoteContext(); return 'ok'; });
  const r = await asCron(() => world.jobs.start('s1', 'build', { tag: 'approved' }));
  assert.equal(r.proposed, true);
  assert.ok(r.proposalId);
  const req = gov.requests.at(-1);
  assert.equal(req.kind, 'app.remote_job');
  assert.equal(req.payload.id, r.id);
  assert.equal(req.payload.argsSha, W.argsSha({ tag: 'approved' }));
  assert.equal(world.jobs.status(r.id).status, 'starting');
  assert.equal(world.jobs.status(r.id).remoteJobId, null);

  // A twin while pending collapses into the same record.
  const twin = await asCron(() => world.jobs.start('s1', 'build', { tag: 'approved' }));
  assert.deepEqual(twin, r);

  const ex = await fleetCap.horst.kinds['app.remote_job'].execute(req.payload, req.proposal);
  assert.equal(ex.ok, true);
  assert.equal(ex.id, r.id);
  assert.ok(W.isJobId(ex.remoteJobId));
  assert.equal(world.jobs.status(r.id).status, 'running');
  g.open();
  const done = await waitDoneEv(r.id);
  assert.equal(done.ok, true);
  assert.equal(ctxSeen.id, r.id);
  assert.deepEqual(ctxSeen.origin, { kind: 'cron', proposalId: r.proposalId });
});

test('jobs: a denied proposal ends the record on sweep', async () => {
  const r = await asCron(() => world.jobs.start('s1', 'build', { tag: 'denied' }));
  assert.equal(r.proposed, true);
  assert.equal(world.jobs.status(r.id).status, 'starting');
  await remote.sweep();
  assert.equal(world.jobs.status(r.id).status, 'starting', 'still pending');
  gov.proposals.get(r.proposalId).status = 'denied';
  await remote.sweep();
  const rec = world.jobs.status(r.id);
  assert.equal(rec.status, 'cancelled');
  assert.equal(rec.code, 'E_REFUSED');
  assert.match(rec.error, /denied/);
  const done = await waitDoneEv(r.id);
  assert.equal(done.ok, false);
  assert.equal(done.status, 'cancelled');
});

// --- 5. coalescing ------------------------------------------------------------------------

test('makeCoalescer: ≤ perSec per key, latest wins, flush delivers the pending value now', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 10000;
  const advance = (ms) => { for (let i = 0; i < ms; i += 10) { clock += 10; t.mock.timers.tick(10); } };
  const out = [];
  const c = W.makeCoalescer((key, v) => out.push({ key, v, at: clock }), { perSec: 4, now: () => clock });

  c.push('a', 1);
  assert.deepEqual(out.map((o) => o.v), [1], 'first value goes at once');
  c.push('a', 2);
  c.push('a', 3);
  assert.equal(c.pending('a'), 3);
  advance(240);
  assert.equal(out.length, 1);
  advance(10);
  assert.deepEqual(out.map((o) => o.v), [1, 3], 'latest wins; 2 is never delivered');

  c.push('b', 'b1');
  assert.equal(out.at(-1).v, 'b1', 'keys are independent');

  // A 2 s burst every 20 ms: ≤ 4 deliveries in any 1 s window.
  out.length = 0;
  for (let i = 0; i < 100; i++) { c.push('a', `x${i}`); advance(20); }
  const aOut = out.filter((o) => o.key === 'a');
  for (const o of aOut) assert.ok(aOut.filter((p) => p.at >= o.at && p.at < o.at + 1000).length <= 4);
  assert.ok(aOut.length >= 6 && aOut.length <= 9, `${aOut.length} deliveries in 2 s`);

  // flush: the pending value goes now, and nothing after it.
  c.push('a', 'last-progress');
  if (c.pending('a') !== undefined) c.flush('a');
  assert.equal(out.at(-1).v, 'last-progress');
  assert.equal(c.pending('a'), undefined);
  const n = out.length;
  advance(500);
  assert.equal(out.length, n, 'the cleared timer does not deliver again');

  // drop forgets a pending value.
  c.push('c', 1);
  c.push('c', 2);
  c.drop('c');
  advance(500);
  assert.ok(!out.some((o) => o.key === 'c' && o.v === 2));
});

test('engine: a burst of 20 setProgress → ≤ ~4 progress events/s; done preceded by the final label', async () => {
  jobImpl.set('burst', async (job) => {
    for (let i = 0; i < 20; i++) { job.setProgress(i * 5, `step ${i}`); await sleep(25); }
    job.setProgress(100, 'final');
    return 'burst-done';
  });
  const { id } = await asOwner(() => world.jobs.start('s1', 'build', { tag: 'burst' }));
  await waitDoneEv(id);
  const mine = evsFor(id);
  const progress = mine.filter((e) => e.ev === 'fleet:job:progress');
  const doneIdx = mine.findIndex((e) => e.ev === 'fleet:job:done');
  assert.ok(progress.length < 10, `${progress.length} progress events for 21 updates`);
  for (const e of progress) {
    const inWindow = progress.filter((p) => p.t >= e.t && p.t < e.t + 1000).length;
    assert.ok(inWindow <= 5, `${inWindow} progress events within 1 s`);
  }
  // Rate-limited deliveries are ≥ 250 ms apart; only the flush before done may be sooner.
  for (let i = 1; i < progress.length - 1; i++) assert.ok(progress[i].t - progress[i - 1].t >= 200, `gap ${progress[i].t - progress[i - 1].t} ms`);
  const before = mine.slice(0, doneIdx).filter((e) => e.ev === 'fleet:job:progress').at(-1);
  assert.equal(before.d.label, 'final');
  assert.equal(before.d.pct, 100);
  assert.equal(mine.slice(doneIdx + 1).filter((e) => e.ev === 'fleet:job:progress').length, 0, 'no progress after done');
});

// --- 7. remote-origin helper ----------------------------------------------------------------

test('remoteContext: inside onJob run and onCall handlers across awaits; null outside', async () => {
  assert.equal(remoteHost.remoteContext(), null);
  let inRun = null;
  jobImpl.set('ctx', async () => {
    await Promise.resolve();
    await sleep(5);
    await new Promise((r) => setTimeout(r, 5));
    inRun = remoteHost.remoteContext();
    return 'ok';
  });
  const { id } = await asOwner(() => world.jobs.start('s1', 'build', { tag: 'ctx' }));
  await waitDoneEv(id);
  const rec = remote.status(id);
  assert.equal(inRun.via, 'job');
  assert.equal(inRun.peer, 'master.local');
  assert.equal(inRun.id, id);
  assert.equal(inRun.name, 'build');
  assert.equal(inRun.jobId, rec.remoteJobId);
  assert.deepEqual(inRun.origin, rec.origin);
  assert.deepEqual(rec.origin, { kind: 'owner', route: 'POST /build' });
  assert.equal(seen.factory.id, id, 'the onJob factory sees it too');

  const c = await asOwner(() => world.call('s1', 'ctx', {}));
  assert.equal(c.via, 'call');
  assert.equal(c.peer, 'master.local');
  assert.ok(W.isId(c.id));
  assert.equal(c.name, 'ctx');
  assert.deepEqual(c.origin, { kind: 'owner', route: 'POST /build' });
  const cc = await asCron(() => world.call('s1', 'ctx', {})).catch((e) => e);
  assert.equal(cc.code, 'E_REFUSED', 'ctx is not readOnly');
  assert.equal(remoteHost.remoteContext(), null);
});

// --- 8. dataPublish.on ----------------------------------------------------------------------

test('ctx.fleet.dataPublish.on delivers the Bridge fleet:data:* payloads of this app only', async () => {
  const bridge = [];
  const offWire = fleetCap.wireAppEvents({ broadcast: (m) => bridge.push(m) });
  const got = { progress: [], done: [] };
  const offP = world.dataPublish.on('progress', (d) => got.progress.push(d));
  const offD = world.dataPublish.on('done', (d) => got.done.push(d));
  assert.throws(() => world.dataPublish.on('nope', () => {}), /progress' or 'done/);

  const mp = { id: 'fd-1', app: 'world', peer: 's1', name: 'world-a', sentBytes: 10, needBytes: 20, blobs: { total: 2, need: 2, done: 1 }, phase: 'sending', label: 'half' };
  fleetData.events.emit('fleet:data:progress', mp);
  fleetData.events.emit('fleet:data:progress', { ...mp, app: 'other', id: 'fd-2' });
  receive.events.emit('fleet:data:progress', { app: 'world', name: 'world-b', manifestSha: 'a'.repeat(64), phase: 'receiving', receivedBytes: 5, needBytes: 9, blobs: { need: 1, done: 0 } });
  receive.events.emit('fleet:data:progress', { app: 'other', name: 'other-b', manifestSha: 'b'.repeat(64), phase: 'receiving', receivedBytes: 5, needBytes: 9, blobs: { need: 1, done: 0 } });
  fleetData.events.emit('fleet:data:done', { id: 'fd-1', app: 'world', peer: 's1', name: 'world-a', ok: true, summary: 'imported' });
  fleetData.events.emit('fleet:data:done', { id: 'fd-2', app: 'other', peer: 's1', name: 'world-a', ok: false, summary: 'x' });
  receive.events.emit('fleet:data:done', { app: 'world', name: 'world-b', manifestSha: 'a'.repeat(64), ok: false, summary: 'gate failed' });

  const onBridge = (appName, event) => bridge.filter((m) => m.type === 'app:bridge:event' && m.appName === appName && m.event === event).map((m) => m.data);
  assert.equal(got.progress.length, 2);
  assert.equal(got.done.length, 2);
  assert.deepEqual(got.progress, onBridge('world', 'fleet:data:progress'));
  assert.deepEqual(got.done, onBridge('world', 'fleet:data:done'));
  assert.equal(got.progress[0].side, 'master');
  assert.equal(got.progress[0].label, 'half');
  assert.equal(got.progress[1].side, 'slave');
  assert.equal(got.progress[1].id, `world-b.${'a'.repeat(64)}`);
  assert.equal(onBridge('other', 'fleet:data:progress').length, 2, 'other app\'s events go to its own iframe only');

  // Remote job events reach the app's iframe without `app`.
  const r = await asCron(() => world.jobs.start('s1', 'build', { tag: 'bridge' }));
  await world.jobs.cancel(r.id);
  const jd = onBridge('world', 'fleet:job:done').find((d) => d.id === r.id);
  assert.ok(jd);
  assert.equal(jd.app, undefined);
  assert.equal(jd.status, 'cancelled');
  assert.equal(gov.withdrawn.at(-1)[0], r.proposalId, 'cancel before start withdraws the pending proposal');

  offP(); offD();
  fleetData.events.emit('fleet:data:done', { id: 'fd-3', app: 'world', peer: 's1', name: 'world-a', ok: true, summary: 'again' });
  assert.equal(got.done.length, 2, 'off() unsubscribes');
  offWire();
});

// --- 9. flags and Bridge scoping -------------------------------------------------------------

test('flags fleet.call / fleet.jobs; Bridge fleet.jobs.* refuse another app\'s record', async () => {
  assert.equal(fleetCap.flags['fleet.call'](), true);
  assert.equal(fleetCap.flags['fleet.jobs'](), true);
  assert.ok(fleetCap.methods.includes('fleet.jobs.status'));
  assert.ok(fleetCap.methods.includes('fleet.jobs.cancel'));
  const r = await asCron(() => world.jobs.start('s1', 'build', { tag: 'bridge-scope' }));
  const mine = await fleetCap.bridge['fleet.jobs.status']({ name: 'world' }, { id: r.id });
  assert.equal(mine.id, r.id);
  assert.equal(await fleetCap.bridge['fleet.jobs.status']({ name: 'other' }, { id: r.id }), null);
  const otherList = await fleetCap.bridge['fleet.jobs.status']({ name: 'other' }, {});
  assert.ok(!otherList.some((x) => x.id === r.id));
  assert.equal(fleetCap.buildCtx({ name: 'other' }).fleet.jobs.status(r.id), null);
  await assert.rejects(fleetCap.bridge['fleet.jobs.cancel']({ name: 'other' }, { id: r.id }), /unknown remote job/);
  assert.equal(remote.status(r.id).status, 'starting', 'untouched by the refused cancel');
  const ok = await fleetCap.bridge['fleet.jobs.cancel']({ name: 'world' }, { id: r.id });
  assert.equal(ok.ok, true);
});

// --- 6. app stop (last: it drops world's handlers) --------------------------------------------

test('app stop: host handlers and master listeners are dropped; app-manager calls both', async () => {
  // Master: .on listeners and the dataPublish.on off()s go with the app.
  const heard = [];
  remote.on('world', 'done', (d) => heard.push(['on', d.id]));
  world.jobs.on('done', (d) => heard.push(['ctx', d.id]));
  world.dataPublish.on('done', (d) => heard.push(['data', d.id]));
  const r1 = await asCron(() => world.jobs.start('s1', 'build', { tag: 'stop-1' }));
  await world.jobs.cancel(r1.id);
  assert.equal(heard.filter(([, id]) => id === r1.id).length, 2, 'listeners live before the stop');

  remote.unregisterApp('world');
  const r2 = await asCron(() => world.jobs.start('s1', 'build', { tag: 'stop-2' }));
  await world.jobs.cancel(r2.id);
  fleetData.events.emit('fleet:data:done', { id: 'fd-9', app: 'world', peer: 's1', name: 'n', ok: true, summary: '' });
  assert.ok(evsFor(r2.id, 'fleet:job:done').length, 'the event itself still happened');
  assert.equal(heard.filter(([, id]) => id === r2.id || id === 'fd-9').length, 0);

  // Slave: handlers gone → E_NO_HANDLER.
  assert.ok(remoteHost.handlers('world').calls.some((c) => c.name === 'echo' && c.readOnly === false));
  assert.ok(remoteHost.handlers('world').calls.some((c) => c.name === 'peek' && c.readOnly === true));
  await asOwner(() => world.call('s1', 'echo', {}));
  remoteHost.unregisterApp('world');
  assert.deepEqual(remoteHost.handlers('world'), { calls: [], jobs: [] });
  await rejectsCode(asOwner(() => world.call('s1', 'echo', {})), 'E_NO_HANDLER');
  await rejectsCode(asOwner(() => world.jobs.start('s1', 'build', { tag: 'gone' })), 'E_NO_HANDLER');

  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'apps', 'app-manager.js'), 'utf-8');
  const body = src.slice(src.indexOf('async function stopMountedApp'));
  assert.match(body.slice(0, 4000), /require\('\.\/fleet-remote-host'\)\.unregisterApp\(name\)/);
  assert.match(body.slice(0, 4000), /require\('\.\/fleet-remote'\)\.unregisterApp\(name\)/);
});
