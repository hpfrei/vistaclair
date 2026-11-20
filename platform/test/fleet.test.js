// Phase 5 federation: envelope host-tagging, peer-channel ingest guardrails,
// versioned code bundles (store / prune / rollback swap) and the fleet
// capability's facet (senses + pinned kinds + read-only tool).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const { makeAppsDir } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const peerData = require('../src/apps/peer-data');
const peerChannel = require('../src/apps/peer-channel');
const capabilities = require('../src/apps/capabilities');

const appsDir = makeAppsDir({ 'roll-app': {} });
appManager.setAppsDir(appsDir);
test.after(() => {
  peerChannel.shutdown();
  fs.rmSync(appsDir, { recursive: true, force: true });
});

// --- bus envelope host-tagging ----------------------------------------------

test('bus: a publish with host/hop lands in the audit with the host tag', async () => {
  const bus = require('../src/apps/agent/horst-events');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-bus-'));
  bus.init({ dir, broadcaster: { broadcast() {} }, ruleActions: {} });
  const r = await bus.publish('peer:app:error', { host: 's1', app: 'x' }, { source: 'system', host: 's1', hop: 1 });
  assert.ok(r.id, 'published');
  const rows = bus.listAudit({ kind: 'peer:app:error' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].host, 's1');
  assert.equal(rows[0].hop, 1);
  // Local events stay untagged — a relayed envelope is always distinguishable.
  await bus.publish('timer:heartbeat', {}, { source: 'timer' });
  assert.equal(bus.listAudit({ kind: 'timer:heartbeat' })[0].host, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- peer-channel ingest guardrails -----------------------------------------

test('peer-channel: the per-connection rate window drops past the cap and recovers', () => {
  const win = peerChannel.makeRateWindow();
  const t0 = 1_000_000;
  for (let i = 0; i < peerChannel.RATE_MAX; i++) {
    assert.ok(peerChannel.allowMessage(win, t0 + i), `message ${i} allowed`);
  }
  assert.ok(!peerChannel.allowMessage(win, t0 + peerChannel.RATE_MAX), 'over cap drops');
  assert.ok(win.dropped >= 1);
  // A minute later the window has cleared.
  assert.ok(peerChannel.allowMessage(win, t0 + 61_000));
});

test('peer-channel: handleUpgrade ignores unrelated paths and refuses on a non-slave', () => {
  assert.equal(peerChannel.handleUpgrade({ url: '/ws', headers: {} }, {}, Buffer.alloc(0)), false);
  // Right path on a host that is not a paired slave: handled (destroyed), not passed on.
  let destroyed = false;
  const socket = { write() {}, destroy() { destroyed = true; } };
  assert.equal(peerChannel.handleUpgrade({ url: '/api/peer/channel', headers: {} }, socket, Buffer.alloc(0)), true);
  assert.ok(destroyed);
});

// --- versioned deploy + rollback (5B) ---------------------------------------

// A code bundle exactly as `git archive` would produce it: <app>/manifest.json
// plus a marker file whose content identifies the "commit".
function makeBundle(commit, content) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-bundle-'));
  const src = path.join(work, 'roll-app');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({ name: 'roll-app' }));
  fs.writeFileSync(path.join(src, 'marker.txt'), content);
  const out = path.join(work, `${commit}.tar.gz`);
  execSync(`tar -czf ${JSON.stringify(out)} -C ${JSON.stringify(work)} roll-app`, { timeout: 10000 });
  return out;
}

const C = {
  a: 'aaaaaaaaaa1111111111aaaaaaaaaa1111111111',
  b: 'bbbbbbbbbb2222222222bbbbbbbbbb2222222222',
  c: 'cccccccccc3333333333cccccccccc3333333333',
  d: 'dddddddddd4444444444dddddddddd4444444444',
};
const appDir = () => path.join(appsDir, 'roll-app');
const marker = () => fs.readFileSync(path.join(appDir(), 'marker.txt'), 'utf-8');

test('deployCode keeps the bundle, records history, preserves runtime files', async () => {
  await peerData.deployCode('roll-app', makeBundle(C.a, 'version A'), C.a, null);
  assert.equal(marker(), 'version A');

  // Runtime state written between deploys must survive the next swap.
  fs.mkdirSync(path.join(appDir(), '.data'), { recursive: true });
  fs.writeFileSync(path.join(appDir(), '.data', 'keep.txt'), 'runtime');

  await peerData.deployCode('roll-app', makeBundle(C.b, 'version B'), C.b, null);
  assert.equal(marker(), 'version B');
  assert.equal(fs.readFileSync(path.join(appDir(), '.data', 'keep.txt'), 'utf-8'), 'runtime');

  const meta = JSON.parse(fs.readFileSync(path.join(appDir(), '.deployed.json'), 'utf-8'));
  assert.equal(meta.commit, C.b);
  assert.deepEqual(meta.history.map((h) => h.commit), [C.b, C.a]);
  assert.ok(fs.existsSync(path.join(appDir(), '.peer-bundles', `${C.a}.tar.gz`)));
  assert.ok(fs.existsSync(path.join(appDir(), '.peer-bundles', `${C.b}.tar.gz`)));
});

test('rollbackCode re-installs a kept bundle through the same swap path', async () => {
  const r = await peerData.rollbackCode('roll-app', C.a, null);
  assert.equal(r.rolledBack, true);
  assert.equal(marker(), 'version A');
  assert.equal(fs.readFileSync(path.join(appDir(), '.data', 'keep.txt'), 'utf-8'), 'runtime', 'CODE_PRESERVE honored on rollback');
  // The rollback is itself a deploy event; the stored bundle survives it.
  const h = peerData.deployHistory('roll-app');
  assert.equal(h.commit, C.a);
  assert.deepEqual(h.history.map((x) => x.commit), [C.a, C.b, C.a]);
  assert.ok(h.history.every((x) => x.bundle));
  assert.ok(fs.existsSync(path.join(appDir(), '.peer-bundles', `${C.a}.tar.gz`)));
});

test('rollbackCode refuses an unknown commit and names what is kept', async () => {
  await assert.rejects(
    () => peerData.rollbackCode('roll-app', 'eeeeeeeeee5555555555eeeeeeeeee5555555555', null),
    /no stored bundle for eeeeeeeeee/,
  );
});

test('bundles prune to the newest three, never the current commit', async () => {
  await peerData.deployCode('roll-app', makeBundle(C.c, 'version C'), C.c, null);
  await peerData.deployCode('roll-app', makeBundle(C.d, 'version D'), C.d, null);
  const kept = fs.readdirSync(path.join(appDir(), '.peer-bundles')).sort();
  assert.equal(kept.length, 3);
  assert.ok(kept.includes(`${C.d}.tar.gz`), 'current commit kept');
  const h = peerData.deployHistory('roll-app');
  assert.equal(h.commit, C.d);
  assert.equal(h.bundles.length, 3);
});

// --- the fleet capability facet (5D) ----------------------------------------

test('deployCode carries over the local half of workspaces/ and lets the bundle win where it ships', async () => {
  // The bundle ships workspaces/scene/scripts (tracked); sources/ and out/ exist only here.
  const ws = path.join(appDir(), 'workspaces');
  fs.mkdirSync(path.join(ws, 'scene', 'sources'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'scene', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'local-only', 'out'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'scene', 'sources', 'big.blend'), 'local material');
  fs.writeFileSync(path.join(ws, 'scene', 'scripts', 'build.py'), 'old script');
  fs.writeFileSync(path.join(ws, 'local-only', 'out', 'model.glb'), 'local output');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-bundle-'));
  const src = path.join(work, 'roll-app');
  fs.mkdirSync(path.join(src, 'workspaces', 'scene', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({ name: 'roll-app' }));
  fs.writeFileSync(path.join(src, 'marker.txt'), 'version W');
  fs.writeFileSync(path.join(src, 'workspaces', 'scene', 'scripts', 'build.py'), 'new script');
  const out = path.join(work, 'ffff.tar.gz');
  execSync(`tar -czf ${JSON.stringify(out)} -C ${JSON.stringify(work)} roll-app`, { timeout: 10000 });
  await peerData.deployCode('roll-app', out, 'ffffffffff6666666666ffffffffff6666666666', null);

  assert.equal(marker(), 'version W');
  assert.equal(fs.readFileSync(path.join(ws, 'scene', 'scripts', 'build.py'), 'utf-8'), 'new script', 'the bundle wins where it ships');
  assert.equal(fs.readFileSync(path.join(ws, 'scene', 'sources', 'big.blend'), 'utf-8'), 'local material', 'untracked material carried over');
  assert.equal(fs.readFileSync(path.join(ws, 'local-only', 'out', 'model.glb'), 'utf-8'), 'local output', 'a workspace the bundle lacks carried over whole');
});

test('fleet capability: senses declared, kinds pinned to propose, tool read-only', () => {
  const fleet = capabilities.get('fleet');
  assert.ok(fleet, 'fleet capability registered');
  const senses = fleet.horst.senses.map((s) => s.kind);
  for (const k of ['peer:connected', 'peer:disconnected', 'peer:app:error', 'peer:app:crashloop', 'peer:pressure']) {
    assert.ok(senses.includes(k), `${k} declared`);
  }
  const kinds = fleet.horst.kinds;
  assert.deepEqual(Object.keys(kinds).sort(), ['app.data_publish', 'app.publish', 'app.remote_call', 'app.remote_job', 'app.rollback', 'peer.keys.sync', 'peer.restart', 'peer.session.launch']);
  for (const [k, d] of Object.entries(kinds)) {
    assert.equal(d.ceiling, 'propose', `${k} is ceiling-pinned to propose`);
    assert.equal(d.defaultLevel, 'propose');
  }
  // peer.kill deliberately has NO kind — the kill-switch stays owner-click-only.
  assert.ok(!kinds['peer.kill']);
  const tool = fleet.horst.tools.find((t) => t.def.name === 'fleet_status');
  assert.ok(tool && /read-only/i.test(tool.def.description));
});

test('fleet wire maps channel events to exactly the declared kinds, host-tagged', () => {
  const published = [];
  const fleet = capabilities.get('fleet');
  const dispose = fleet.horst.wire({ publish: (kind, payload, opts) => published.push({ kind, payload, opts }) });
  try {
    for (const ev of [
      { type: 'connected', peer: 's1' },
      { type: 'app:error', peer: 's1', app: 'x', surface: 'route', error: 'boom', count: 2 },
      { type: 'app:crashloop', peer: 's1', app: 'x', count: 5, lastError: 'boom' },
      { type: 'health', peer: 's1', app: 'x', from: 'ok', to: 'failed' },
      { type: 'pressure', peer: 's1', state: 'pressure', reasons: ['memory (low)'] },
      { type: 'summary', peer: 's1', apps: { x: { costUsd: 1.5, calls: 3 } } },
      { type: 'disconnected', peer: 's1' },
      { type: 'job', peer: 's1', app: 'x', name: 'peer:code-deploy', status: 'done' },
    ]) {
      peerChannel._emitTestEvent(ev);
    }
  } finally {
    dispose();
  }
  assert.deepEqual(published.map((p) => p.kind), [
    'peer:connected', 'peer:app:error', 'peer:app:crashloop', 'peer:app:health',
    'peer:pressure', 'peer:summary', 'peer:disconnected',
  ], 'every channel event maps to its declared sense; job events feed the dashboard only');
  for (const p of published) {
    assert.equal(p.opts.host, 's1', `${p.kind} is host-tagged`);
    assert.equal(p.opts.hop, 1, `${p.kind} counts one hop`);
  }
  const declared = new Set(fleet.horst.senses.map((s) => s.kind));
  for (const p of published) assert.ok(declared.has(p.kind), `${p.kind} is declared`);
  // After dispose the listener is gone.
  peerChannel._emitTestEvent({ type: 'connected', peer: 's1' });
  assert.equal(published.length, 7);
});

test('peer-channel: a slave\'s reported website domains are shape-checked; absent → null', () => {
  assert.equal(peerChannel.cleanDomains(undefined), null);
  assert.equal(peerChannel.cleanDomains(['x']), null);
  assert.deepEqual(peerChannel.cleanDomains({ a: 'a.example.com', b: 42, c: 'x'.repeat(300) }), { a: 'a.example.com' });
});
