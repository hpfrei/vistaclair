// The app-facing fleet data publish (capabilities/fleet.js over the engine,
// docs/fleet-data.md "App API"): ctx.fleet scoped per app, the Bridge twins,
// the fleet.sync flag, the owner-click vs AI path (direct + ledger row vs an
// app.data_publish proposal), the receiver's register/unregister across an app
// reload, the own-process rule, and the app events. The engine runs against a
// stub slave client (its transport is fleet-data.test.js's); governance is the
// real module on a temp dir. Never touches the live control-room server.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeAppsDir, call } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const pairing = require('../src/apps/peer-pairing');
const capabilities = require('../src/apps/capabilities');
const spendContext = require('../src/apps/spend-context');
const governance = require('../src/apps/governance/horst-governance');
const cards = require('../src/apps/governance/horst-cards');
const fleetData = require('../src/apps/fleet-data');
const receive = require('../src/apps/fleet-data-receive');
const appBridge = require('../src/apps/app-bridge');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const appsDir = makeAppsDir({
  world: {}, other: {}, side: { runtime: 'own-process' }, indie: { platformContribution: false },
});
appManager.setAppsDir(appsDir);
// world's routes.js registers a receiver, as a slave app does in setup.
fs.writeFileSync(path.join(appsDir, 'world', 'routes.js'),
  "module.exports = (router, ctx) => { ctx.fleet.onDataReceive('world-*', { have: async () => [], receive: async () => ({ ok: true, summary: 'ok' }) }); };\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-fleet-surface-'));
const peers = new Map([['s1', { id: 'peer-1', name: 's1', baseUrl: 'https://s1.test' }]]);
pairing.getPeer = (ref) => peers.get(ref) || [...peers.values()].find((p) => p.id === ref) || null;

// The stub slave: every app installed, plenty of disk, nothing held; a commit's
// receive job runs until `hold` is cleared.
let hold = false;
const calls = [];
const client = {
  async call(peer, apiPath, o = {}) {
    calls.push([o.method || 'GET', apiPath]);
    const m = /^\/fleet-data\/([^/]+)(.*)$/.exec(apiPath);
    if (m && !m[2]) return { code: 'ok', installed: true, enabled: true, running: true, version: '1.2.0', commit: 'abc', runtime: 'in-process', freeBytes: 100e9, marginBytes: 1e9, receivers: ['world-*'] };
    if (m && m[2] === '/plan') {
      const bytes = o.body.manifest.blobs.reduce((n, b) => n + b.bytes, 0);
      return { code: 'ok', need: [], needBytes: 0, haveBytes: bytes, freeBytes: 100e9, marginBytes: 1e9, fits: true, partial: {}, blobs: o.body.manifest.blobs.length, state: 'open' };
    }
    if (m && /\/commit$/.test(m[2])) return { code: 'ok', jobId: 'job-1' };
    if (m && o.method === 'DELETE') return { code: 'ok', ok: true };
    if (/^\/jobs\//.test(apiPath)) return hold ? { status: 'running', progress: {} } : { status: 'done', result: { ok: true, summary: { imported: 1 } } };
    throw Object.assign(new Error(`unexpected ${apiPath}`), { status: 400, body: { code: 'bad' } });
  },
};

fleetData.init({
  stateDir: path.join(tmp, '.fleet-data'),
  getPeer: pairing.getPeer,
  listPeers: () => [...peers.values()],
  appExists: (a) => fs.existsSync(path.join(appsDir, a)),
  dataDir: (a) => path.join(appsDir, a, '.data'),
  fleetState: () => ({ peers: [] }),
  client,
  pollMs: 10, progressMs: 0, persistMs: 10, backoffMinMs: 10, backoffMaxMs: 20, resume: false,
});
receive.init({ appsDir, sweep: false });

governance.registerPlatformKinds({ 'app.data_publish': capabilities.horstKinds()['app.data_publish'] });
governance.init({ dir: path.join(tmp, 'gov'), broadcaster: { broadcast: () => {} } });

const events = [];
const unwire = capabilities.get('fleet').wireAppEvents({ broadcast: (m) => events.push(m) });

test.after(async () => {
  unwire();
  await fleetData.shutdown();
  receive.shutdown();
  for (const d of [appsDir, tmp]) fs.rmSync(d, { recursive: true, force: true });
});

function blob(app, rel, size) {
  const buf = crypto.randomBytes(size);
  const file = path.join(appsDir, app, '.data', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return { sha256: sha(buf), bytes: size, path: rel };
}
const ctxFor = (name, profile = 'dashboard') => capabilities.buildCtx(
  { name, dir: path.join(appsDir, name), manifest: appManager.readManifest(name), broadcaster: { broadcast() {} } }, { profile });
const asOwner = (app, fn) => spendContext.run({ app, origin: 'route', principal: 'owner' }, fn);
const asAgent = (app, fn) => spendContext.run({ app, origin: 'mcp', principal: 'owner', caller: { type: 'session', appName: app } }, fn);
function waitDone(id, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const r = fleetData.status(id);
      if (r && r.status !== 'running') return resolve(r);
      if (Date.now() - t0 > ms) return reject(new Error(`transfer ${id} still running`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

const manifestW = { format: 't1', blobs: [blob('world', 'a/one.bin', 2048), blob('world', 'a/two.bin', 512)], extra: { world: 'w1' } };
const manifestO = { blobs: [blob('other', 'x.bin', 100)] };

test('ctx.fleet: the members, in-process only; fleet.sync on ctx and Bridge', async () => {
  const fleet = ctxFor('world').fleet;
  assert.equal(typeof fleet.peers, 'function');
  assert.equal(typeof fleet.dataPublish, 'function');
  for (const m of ['plan', 'status', 'cancel', 'list']) assert.equal(typeof fleet.dataPublish[m], 'function', m);
  assert.equal(typeof fleet.onDataReceive, 'function');
  assert.ok(ctxFor('world').capabilities.has('fleet.sync'));
  const list = ctxFor('world').capabilities.list();
  assert.equal(list[list.indexOf('fleet') + 1], 'fleet.sync', 'the flag sits right after its module');

  const side = ctxFor('side', 'standalone');
  assert.ok(!('fleet' in side), 'an own-process app has no ctx.fleet');
  assert.equal(side.capabilities.has('fleet.sync'), false);
  assert.throws(() => receive.registerReceiver('side', 'x-*', { have() {}, receive() {} }), /own process/);

  const listed = await call(appBridge, 'world', 'capabilities.list', {});
  assert.ok(listed.result.capabilities.includes('fleet.sync'));
  // The up direction (docs/fleet-data-up.md): its own flag; master() is null
  // on a host that is no fleet slave.
  assert.ok(ctxFor('world').capabilities.has('fleet.sync.up'));
  assert.ok(listed.result.capabilities.includes('fleet.sync.up'));
  assert.equal(typeof fleet.master, 'function');
  assert.equal(await fleet.master(), null);
});

test('peers / plan: the calling app, through ctx and the Bridge', async () => {
  const rows = await ctxFor('world').fleet.peers();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].peer, 's1');
  assert.equal(rows[0].online, true);
  assert.equal(rows[0].app.running, true);
  assert.equal(rows[0].disk.freeBytes, 100e9);
  assert.ok(calls.some(([, p]) => p === '/fleet-data/world'));

  const viaBridge = await call(appBridge, 'other', 'fleet.peers', {});
  assert.equal(viaBridge.result[0].peer, 's1');
  assert.ok(calls.some(([, p]) => p === '/fleet-data/other'), 'the Bridge asks for the calling app');

  const plan = await ctxFor('world').fleet.dataPublish.plan('s1', { name: 'world-a', manifest: manifestW });
  assert.equal(plan.blobs, 2);
  assert.equal(plan.fits, true);
  const bridgePlan = await call(appBridge, 'world', 'fleet.dataPublish.plan', { peer: 's1', name: 'world-a', manifest: manifestW });
  assert.equal(bridgePlan.result.manifestSha, plan.manifestSha);
  // A manifest naming another app's file resolves inside the CALLER's .data.
  const sneaky = await call(appBridge, 'world', 'fleet.dataPublish.plan', { peer: 's1', name: 'x', manifest: { blobs: [{ ...manifestO.blobs[0], path: '../../other/.data/x.bin' }] } });
  assert.match(sneaky.error, /not inside the app's data dir/);
});

let worldId;
test('owner click: starts at once, records a ledger row; status/list/cancel are scoped to the app', async () => {
  const before = governance.listAudit().length;
  const r = await asOwner('world', () => ctxFor('world').fleet.dataPublish('s1', { name: 'world-a', manifest: manifestW, meta: { bake: 1 } }));
  assert.ok(r.id && !r.proposed);
  worldId = r.id;
  const done = await waitDone(r.id);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.summary, { imported: 1 });
  assert.deepEqual(done.origin, { via: 'owner', app: 'world' });
  const rows = governance.listAudit().slice(0, governance.listAudit().length - before);
  const row = rows.find((x) => x.kind === 'app.data_publish');
  assert.ok(row, 'the click is in the ledger');
  assert.equal(row.action, 'executed');
  assert.equal(row.via, 'app:world');
  assert.match(row.summary, /world-a.*s1.*2 blobs/);
  assert.equal(governance.listProposals({ kind: 'app.data_publish' }).length, 0, 'no card for the owner\'s own click');

  // A job the owner's route started inherits the owner: still direct.
  const again = await asOwner('world', () => spendContext.run({ app: 'world', origin: 'job' },
    () => ctxFor('world').fleet.dataPublish('s1', { name: 'world-a', manifest: manifestW })));
  assert.equal(again.id, worldId, 'same peer + name + manifest = the same transfer');
  await waitDone(again.id);

  const world = ctxFor('world').fleet.dataPublish;
  const other = ctxFor('other').fleet.dataPublish;
  assert.equal(world.status(worldId).id, worldId);
  assert.equal(other.status(worldId), null, 'another app never sees it');
  assert.deepEqual(other.list(), []);
  assert.equal(world.list({ name: 'world-a' }).length, 1);
  await assert.rejects(other.cancel(worldId), /unknown transfer/);
  assert.equal((await call(appBridge, 'other', 'fleet.dataPublish.status', { id: worldId })).result, null);
  assert.match((await call(appBridge, 'other', 'fleet.dataPublish.cancel', { id: worldId })).error, /unknown transfer/);
  assert.equal((await call(appBridge, 'world', 'fleet.dataPublish.status', { id: worldId })).result.id, worldId);
  assert.deepEqual((await call(appBridge, 'other', 'fleet.dataPublish.status', {})).result, []);

  // A running transfer: its own app cancels it, via the Bridge.
  hold = true;
  const o = await asOwner('other', () => ctxFor('other').fleet.dataPublish('s1', { name: 'other-a', manifest: manifestO }));
  const c = await call(appBridge, 'other', 'fleet.dataPublish.cancel', { id: o.id });
  hold = false;
  assert.equal(c.result.ok, true);
  assert.equal(fleetData.status(o.id).status, 'cancelled');
});

test('AI path: an agent\'s tool call stages app.data_publish; owner-only approval starts it', async () => {
  const manifest = { blobs: [blob('world', 'b/three.bin', 4096)] };
  const r = await asAgent('world', () => ctxFor('world').fleet.dataPublish('s1', { name: 'world-b', manifest, meta: { by: 'agent' } }));
  assert.equal(r.proposed, true);
  assert.ok(r.proposalId);
  assert.equal(fleetData.status(r.id), null, 'nothing runs before the owner approves');
  const p = governance.getProposal(r.proposalId);
  assert.equal(p.kind, 'app.data_publish');
  assert.equal(p.status, 'pending');
  assert.equal(p.app, null, 'platform-staged: the kind stays platform-owned');
  assert.equal(p.payload.app, 'world');
  assert.equal(p.payload.blobs, 1);
  assert.equal(p.payload.needBytes, 0);
  assert.equal(p.payload.manifest, undefined, 'the payload carries the manifest sha, not the manifest');
  const card = cards.cardFor(governance.kindDef('app.data_publish'), p);
  const labels = card.fields.map((f) => f.label);
  for (const l of ['App', 'Slave', 'Name', 'Blobs', 'To send']) assert.ok(labels.includes(l), l);

  // The same act again collapses into the pending card.
  const twin = await asAgent('world', () => ctxFor('world').fleet.dataPublish('s1', { name: 'world-b', manifest, meta: { by: 'agent' } }));
  assert.equal(governance.listProposals({ kind: 'app.data_publish', status: 'pending' }).length, 1, `twin ${twin.proposalId}`);

  await assert.rejects(governance.decide(r.proposalId, 'approve', 'app:world'), /only by the owner/);
  const decided = await governance.decide(r.proposalId, 'approve', 'ui');
  assert.equal(decided.status, 'executed');
  assert.ok(decided.result.summary.includes(r.id), 'it runs under the id the app was given');
  const done = await waitDone(r.id);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.meta, { by: 'agent' });
  assert.equal(done.origin.via, 'governance');
});

test('cron, an app user and an independent app go through the card too', async () => {
  const cron = await spendContext.run({ app: 'world', origin: 'cron', principal: null },
    () => ctxFor('world').fleet.dataPublish('s1', { name: 'world-c', manifest: manifestW }));
  assert.equal(cron.proposed, true);
  const user = await spendContext.run({ app: 'world', origin: 'route', principal: 'acct:7' },
    () => ctxFor('world').fleet.dataPublish('s1', { name: 'world-d', manifest: manifestW }));
  assert.equal(user.proposed, true);
  const indie = await asAgent('indie', () => ctxFor('indie').fleet.dataPublish('s1', { name: 'i', manifest: { blobs: [blob('indie', 'i.bin', 10)] } }));
  assert.equal(indie.proposed, true);
  assert.equal(governance.getProposal(indie.proposalId).payload.app, 'indie');
  const direct = await asOwner('indie', () => ctxFor('indie').fleet.dataPublish('s1', { name: 'i', manifest: { blobs: [blob('indie', 'i.bin', 10)] } }));
  assert.ok(direct.id && !direct.proposed, 'an independent app\'s owner click runs directly');
  await waitDone(direct.id);
  // A bad payload is refused at staging, not at approval.
  await assert.rejects(asAgent('world', () => ctxFor('world').fleet.dataPublish('nope', { name: 'w', manifest: manifestW })), /unknown peer/);
});

test('onDataReceive: registered by setup, gone on stop, back on the next mount (reload)', async () => {
  assert.deepEqual(receive.receiverPatterns('world'), []);
  await appManager.mountRoutes('world', { broadcast() {} });
  assert.deepEqual(receive.receiverPatterns('world'), ['world-*']);
  await appManager.stopApp('world', { restart: true });
  assert.deepEqual(receive.receiverPatterns('world'), [], 'unregistered with the dying module');
  await appManager.mountRoutes('world', { broadcast() {} });
  assert.deepEqual(receive.receiverPatterns('world'), ['world-*'], 'registered again by the new module');
  await appManager.stopApp('world');
});

test('app events: master and slave progress reach the app\'s iframe on the job:update path', async () => {
  const mine = events.filter((e) => e.type === 'app:bridge:event' && e.appName === 'world' && e.data.id === worldId);
  const progress = mine.filter((e) => e.event === 'fleet:data:progress');
  assert.ok(progress.length, 'progress arrived');
  for (const k of ['side', 'id', 'peer', 'name', 'sentBytes', 'needBytes', 'blobs', 'phase']) assert.ok(k in progress[0].data, k);
  assert.equal(progress[0].data.side, 'master');
  const done = mine.find((e) => e.event === 'fleet:data:done');
  assert.ok(done && done.data.ok === true);
  assert.ok(!events.some((e) => e.appName === 'other' && e.data.id === worldId), 'never to another app');

  const msha = 'c'.repeat(64);
  receive.events.emit('fleet:data:progress', { app: 'world', name: 'world-z', manifestSha: msha, phase: 'receiving', receivedBytes: 10, needBytes: 20, blobs: { need: 2, done: 1 } });
  receive.events.emit('fleet:data:done', { app: 'world', name: 'world-z', manifestSha: msha, ok: true, summary: 'live' });
  const slave = events.filter((e) => e.appName === 'world' && e.data.side === 'slave');
  assert.deepEqual(slave.map((e) => e.event), ['fleet:data:progress', 'fleet:data:done']);
  assert.equal(slave[0].data.id, `world-z.${msha}`);
  assert.equal(slave[0].data.sentBytes, 10);
  assert.equal(slave[1].data.summary, 'live');
  assert.equal(slave[0].data.dir, 'down');
  assert.equal(slave[0].data.role, 'receiver');
  assert.equal(progress[0].data.dir, 'down');
  assert.equal(progress[0].data.role, 'sender');

  // Up (docs/fleet-data-up.md): the master's record of a slave's publish is
  // side master / dir up / role receiver; its inbox events are not repeated
  // (the record carries the same id on both ends). The slave's own view of it
  // (fleet-data-up.js) is side slave / dir up / role sender.
  const n = events.length;
  fleetData.events.emit('fleet:data:progress', { id: 'fd-up1', app: 'world', peer: 's1', name: 'world-u', dir: 'up', sentBytes: 1, needBytes: 2, blobs: { total: 1, need: 1, done: 0 }, phase: 'sending', label: null });
  receive.events.emit('fleet:data:progress', { app: 'world', name: 'world-u', manifestSha: msha, dir: 'up', phase: 'receiving', receivedBytes: 1, needBytes: 2, blobs: { need: 1, done: 0 } });
  require('../src/apps/fleet-data-up').events.emit('fleet:data:done', { id: 'fd-up1', app: 'world', peer: 'master.test', name: 'world-u', dir: 'up', ok: true, summary: 'x' });
  const ups = events.slice(n).filter((e) => e.appName === 'world');
  assert.equal(ups.length, 2, 'the up inbox event is not forwarded');
  assert.deepEqual([ups[0].data.side, ups[0].data.dir, ups[0].data.role, ups[0].data.id], ['master', 'up', 'receiver', 'fd-up1']);
  assert.deepEqual([ups[1].data.side, ups[1].data.dir, ups[1].data.role, ups[1].data.id], ['slave', 'up', 'sender', 'fd-up1']);
});

test('fleet:data:done reaches the bus as the fleet sense', async () => {
  const published = [];
  const dispose = capabilities.get('fleet').horst.wire({ publish: (kind, payload, opts) => published.push({ kind, payload, opts }) });
  try {
    fleetData.events.emit('fleet:data:done', { id: 'fd-x', app: 'world', peer: 's1', name: 'world-a', ok: false, summary: 'gate failed' });
    fleetData.events.emit('fleet:data:done', { id: 'fd-u', app: 'world', peer: 's1', name: 'world-b', dir: 'up', ok: true, summary: 'imported' });
  } finally { dispose(); }
  assert.equal(published.length, 2);
  assert.equal(published[0].kind, 'fleet:data:done');
  assert.deepEqual(published[0].payload, { id: 'fd-x', app: 'world', peer: 's1', name: 'world-a', dir: 'down', ok: false, summary: 'gate failed' });
  assert.match(published[0].opts.summary, /to "s1" failed: gate failed/);
  // The up direction's end is the master's sense too, with its direction.
  assert.equal(published[1].payload.dir, 'up');
  assert.match(published[1].opts.summary, /from "s1" done/);
});
