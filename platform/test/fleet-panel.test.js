// The code publish carries no app data (the wizard's old `data` step and the
// slave's POST /apps/:name/data are gone — data travels by fleet data publish),
// and the peers panel's data-publish surface in publish.js: app:fleet:data:list
// (the engine's persisted records), app:fleet:data:cancel (the engine's cancel)
// and the live push wired in publish.init.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeAppsDir } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const fleetData = require('../src/apps/fleet-data');
const publish = require('../src/apps/publish');
const peerServer = require('../src/apps/peer-server');
const peerData = require('../src/apps/peer-data');
const pairing = require('../src/apps/peer-pairing');

const appsDir = makeAppsDir({ good: {} });
appManager.setAppsDir(appsDir);
const files = new Map();
pairing.init({
  appsDir,
  secretStore: {
    readSecretFile: (p, _d, o) => (files.has(p) ? JSON.parse(files.get(p)) : (o?.fallback ?? {})),
    writeSecretFile: (p, data) => { files.set(p, JSON.stringify(data)); },
  },
  broadcaster: null,
});
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-fdpanel-'));

const now = Date.now();
const rec = (over) => ({
  id: 'fd-x', app: 'good', peer: 'h1', peerId: null, name: 'world-1', manifestSha: 'a'.repeat(64),
  blobs: 3, totalBytes: 300, meta: { big: 'not for the panel' }, origin: null,
  status: 'running', phase: 'sending', label: 'sending 1/3', sentBytes: 100, needBytes: 200, wireBytes: 100,
  blobsNeed: 2, blobsDone: 1, summary: null, error: null, commitJobId: null,
  createdAt: now, startedAt: now, updatedAt: now, finishedAt: null, runs: 1, ...over,
});

function loadRecords(records) {
  fs.writeFileSync(path.join(stateDir, 'transfers.json'), JSON.stringify({ transfers: records }));
  fleetData.init({ stateDir, resume: false, getPeer: () => null });
}

async function ws(msg) {
  const out = [];
  const handled = await publish.handleWs(msg, (m) => out.push(m), null);
  return { handled, out };
}

test.after(() => {
  pairing.shutdown();
  publish.init({ broadcaster: null });
  fs.rmSync(appsDir, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

// --- the removed data step ----------------------------------------------------

test('the publish wizard has no data step; preflight reports no data parts', async () => {
  const keys = publish.STEP_DEFS.map((s) => s.key);
  assert.deepEqual(keys, ['preflight', 'enable', 'code', 'install', 'toolchains', 'restart', 'health']);
  const pre = await publish.preflight('good');
  assert.equal('data' in pre, false);
});

test('the slave no longer serves POST /apps/:name/data; the code routes stay', () => {
  const router = peerServer.createPeerRouter({});
  const routes = router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods).join(',')} ${l.route.path}`);
  assert.ok(routes.includes('post /apps/:name/code'), routes.join('\n'));
  assert.ok(routes.includes('post /apps/:name/rollback'));
  assert.ok(!routes.some((r) => r.endsWith(' /apps/:name/data')), 'data import route is gone');
});

test('peer-data keeps only the code-publish half', () => {
  assert.deepEqual(Object.keys(peerData).sort(), ['CODE_PRESERVE', 'deployCode', 'deployHistory', 'deployedCommit', 'incomingDir', 'rollbackCode']);
});

// --- the peers panel: list / cancel / live push --------------------------------

test('app:fleet:data:list returns the persisted records as slim rows', async () => {
  loadRecords([rec(), rec({ id: 'fd-y', status: 'done', phase: 'done', label: null, sentBytes: 200, summary: 'imported 2 tiles', finishedAt: now })]);
  const { handled, out } = await ws({ type: 'app:fleet:data:list' });
  assert.equal(handled, true);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'app:fleet:data:list');
  const [a, b] = out[0].transfers;
  assert.deepEqual(
    { id: a.id, app: a.app, peer: a.peer, name: a.name, status: a.status, phase: a.phase, sentBytes: a.sentBytes, needBytes: a.needBytes, blobsNeed: a.blobsNeed, blobsDone: a.blobsDone },
    { id: 'fd-x', app: 'good', peer: 'h1', name: 'world-1', status: 'running', phase: 'sending', sentBytes: 100, needBytes: 200, blobsNeed: 2, blobsDone: 1 },
  );
  assert.equal('meta' in a, false, 'app meta stays off the dashboard wire');
  assert.equal(b.summary, 'imported 2 tiles');
  assert.deepEqual(publish.dataTransfersMsg(), out[0]);
});

test('app:fleet:data:cancel cancels a running transfer through the engine', async () => {
  loadRecords([rec(), rec({ id: 'fd-y', status: 'done', phase: 'done', finishedAt: now })]);
  const { out } = await ws({ type: 'app:fleet:data:cancel', id: 'fd-x' });
  assert.deepEqual(out[0], { type: 'app:fleet:data:cancelResult', id: 'fd-x', ok: true, slaveCleared: false });
  assert.equal(out[1].type, 'app:fleet:data:list');
  assert.equal(out[1].transfers.find((t) => t.id === 'fd-x').status, 'cancelled');
  assert.equal(fleetData.status('fd-x').status, 'cancelled');

  const again = await ws({ type: 'app:fleet:data:cancel', id: 'fd-y' });
  assert.equal(again.out[0].ok, false);
  assert.match(again.out[0].error, /already done/);
  const unknown = await ws({ type: 'app:fleet:data:cancel', id: 'fd-nope' });
  assert.deepEqual(unknown.out[0], { type: 'app:fleet:data:cancelResult', id: 'fd-nope', ok: false, error: 'unknown transfer' });
  const bad = await ws({ type: 'app:fleet:data:cancel', id: { $ne: 1 } });
  assert.equal(bad.out[0].ok, false);
});

test('publish.init pushes engine progress as rows and the full list on done', () => {
  loadRecords([rec()]);
  const sent = [];
  publish.init({ broadcaster: { broadcast: (m) => sent.push(m) } });
  fleetData.events.emit('fleet:data:progress', {
    id: 'fd-x', app: 'good', peer: 'h1', name: 'world-1', sentBytes: 150, needBytes: 200,
    blobs: { total: 3, need: 2, done: 1 }, phase: 'sending', label: 'sending 2/3',
  });
  assert.deepEqual(sent[0], { type: 'app:fleet:data:progress', transfer: {
    id: 'fd-x', app: 'good', peer: 'h1', name: 'world-1', dir: 'down', status: 'running', phase: 'sending', label: 'sending 2/3',
    sentBytes: 150, needBytes: 200, blobs: 3, blobsNeed: 2, blobsDone: 1,
  } });
  // An up transfer (a slave's publish to this master) is marked as such.
  fleetData.events.emit('fleet:data:progress', {
    id: 'fd-u', app: 'good', peer: 'h1', name: 'world-2', dir: 'up', sentBytes: 1, needBytes: 2,
    blobs: { total: 1, need: 1, done: 0 }, phase: 'sending', label: null,
  });
  assert.equal(sent[1].transfer.dir, 'up');
  sent.splice(1, 1);
  fleetData.events.emit('fleet:data:done', { id: 'fd-x', app: 'good', peer: 'h1', name: 'world-1', ok: true, summary: 'ok' });
  assert.equal(sent[1].type, 'app:fleet:data:list');
  // A second init replaces the subscription instead of stacking it.
  publish.init({ broadcaster: { broadcast: (m) => sent.push(m) } });
  sent.length = 0;
  fleetData.events.emit('fleet:data:done', { id: 'fd-x', app: 'good', peer: 'h1', name: 'world-1', ok: true, summary: 'ok' });
  assert.equal(sent.length, 1);
});
