// Publish's `toolchains` step: the manifest.toolchains → extras map and order
// (platform-extras.js), the step's skip / install / fail / warn logic against a
// faked peer client (publish.js ensureToolchains), and the slave routes
// GET /extras + POST /extras/:id/install through the real peer router.
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
const platformExtras = require('../src/apps/platform-extras');
const publish = require('../src/apps/publish');

const appsDir = makeAppsDir({ good: {} });
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-pubtc-'));
appManager.setAppsDir(appsDir);
hostConfig.init(appsDir, { dataHome });
platformExtras.init({ appsDir, broadcaster: null });
const files = new Map();
pairing.init({
  appsDir,
  secretStore: {
    readSecretFile: (p, _d, o) => (files.has(p) ? JSON.parse(files.get(p)) : (o?.fallback ?? {})),
    writeSecretFile: (p, data) => { files.set(p, JSON.stringify(data)); },
  },
  broadcaster: null,
});

test.after(() => {
  pairing.shutdown();
  fs.rmSync(appsDir, { recursive: true, force: true });
  fs.rmSync(dataHome, { recursive: true, force: true });
});

const PEER = { name: 'hetzner-1', baseUrl: 'https://h1.example', token: 't' };
const FAST = { pollMs: 1, unreachableMs: 30 };

// A fake slave: extras state by id, a scripted sequence of poll answers per
// install, optional owner actions.
function fakeSlave({ extras = {}, scripts = {}, actions = [], failInstall = null, notFound = false } = {}) {
  const calls = [];
  const state = JSON.parse(JSON.stringify(extras));
  const client = {
    async call(peer, apiPath, opts = {}) {
      calls.push({ path: apiPath, method: opts.method || 'GET' });
      if (notFound) { const e = new Error('HTTP 404'); e.status = 404; throw e; }
      const m = apiPath.match(/^\/extras\/([^/]+)\/install$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (failInstall) { const e = new Error(failInstall); e.status = 409; throw e; }
        if (state[id]?.installed) return { ok: true, alreadyInstalled: true };
        state[id] = { ...state[id], installing: true, progress: 1, label: 'starting' };
        return { ok: true, started: true };
      }
      const q = new URLSearchParams(apiPath.split('?')[1] || '');
      const ids = (q.get('ids') || '').split(',').filter(Boolean);
      for (const id of ids) {
        const script = scripts[id];
        if (state[id]?.installing && script?.length) {
          const next = script.shift();
          if (next instanceof Error) throw next;
          state[id] = { ...state[id], ...next };
        }
      }
      return {
        ok: true,
        extras: ids.filter((id) => state[id]).map((id) => ({ id, title: id, size: '~1 GB', installed: false, installing: false, progress: 0, label: '', error: null, sudoOk: true, ...state[id] })),
        actions: q.get('actions') === '1' ? actions.filter((a) => ids.includes(a.id)) : [],
      };
    },
  };
  return { client, calls, state };
}

// --- mapping and order --------------------------------------------------------

test('toolchain keys map to extras in install order; after is order only', () => {
  assert.deepEqual(platformExtras.extrasForToolchains(['unity', 'rust', 'android']), { ids: ['android-build', 'rust', 'unity'], unknown: [] });
  assert.deepEqual(platformExtras.extrasForToolchains(['godot', 'android']).ids, ['android-build', 'godot']);
  assert.deepEqual(platformExtras.extrasForToolchains(['unity']).ids, ['unity'], 'rust is not pulled in');
  assert.deepEqual(platformExtras.extrasForToolchains(['nope', 'blender', 'blender']), { ids: ['blender'], unknown: ['nope'] });
  assert.deepEqual(platformExtras.extrasForToolchains(undefined), { ids: [], unknown: [] });
});

test('the badge reads the same map: list() rows carry toolchain + badge', () => {
  const rows = platformExtras.list();
  for (const [key, { extra, label }] of Object.entries(platformExtras.TOOLCHAINS)) {
    const row = rows.find((r) => r.id === extra);
    assert.equal(row.toolchain, key);
    assert.equal(row.badge, label);
  }
  assert.equal(platformExtras.TOOLCHAINS.android.extra, 'android-build');
  assert.equal(rows.find((r) => r.id === 'ffmpeg').toolchain, null);
});

// --- the step -----------------------------------------------------------------

test('present extras are skipped: no install call', async () => {
  const s = fakeSlave({ extras: { rust: { installed: true }, unity: { installed: true } } });
  const r = await publish.ensureToolchains(PEER, ['unity', 'rust'], { client: s.client, waitOpts: FAST });
  assert.deepEqual(r.present, ['rust', 'unity']);
  assert.deepEqual(r.installed, []);
  assert.deepEqual(r.warnings, []);
  assert.ok(!s.calls.some((c) => c.method === 'POST'));
  assert.equal(r.detail, 'present rust, unity');
});

test('missing extras are installed in order, with the slave progress relayed', async () => {
  const s = fakeSlave({
    extras: { 'android-build': { installed: true }, rust: {}, unity: {} },
    scripts: {
      rust: [{ progress: 50, label: 'rustup' }, { installing: false, installed: true }],
      unity: [{ progress: 10, label: 'download' }, { progress: 70, label: 'probe' }, { installing: false, installed: true }],
    },
  });
  const seen = [];
  const r = await publish.ensureToolchains(PEER, ['unity', 'rust', 'android'], {
    client: s.client, waitOpts: FAST, onProgress: (i, n, pct, label) => seen.push([i, n, pct, label]),
  });
  assert.deepEqual(r.installed, ['rust', 'unity']);
  assert.deepEqual(r.present, ['android-build']);
  const posts = s.calls.filter((c) => c.method === 'POST').map((c) => c.path);
  assert.deepEqual(posts, ['/extras/rust/install', '/extras/unity/install']);
  assert.ok(seen.some(([i, n, pct, label]) => i === 2 && n === 3 && pct === 70 && /unity on hetzner-1: probe \(70%\)/.test(label)));
  assert.match(r.detail, /^installed rust, unity · present android-build$/);
});

test('an extra already installing on the slave is attached to, not restarted', async () => {
  const s = fakeSlave({ extras: { unity: { installing: true, progress: 40 } }, scripts: { unity: [{ progress: 41 }, { installing: false, installed: true }] } });
  const realCall = s.client.call;
  s.client.call = async (peer, p, o) => (/\/install$/.test(p) ? (s.calls.push({ path: p, method: 'POST' }), { ok: true, alreadyRunning: true }) : realCall(peer, p, o));
  const r = await publish.ensureToolchains(PEER, ['unity'], { client: s.client, waitOpts: FAST });
  assert.deepEqual(r.installed, ['unity']);
  assert.equal(s.calls.filter((c) => c.method === 'POST').length, 1);
});

test('an install failure fails the step with the extra\'s error', async () => {
  const s = fakeSlave({ extras: { unity: {} }, scripts: { unity: [{ installing: false, installed: false, error: 'md5 mismatch for Unity.tar.xz' }] } });
  await assert.rejects(publish.ensureToolchains(PEER, ['unity'], { client: s.client, waitOpts: FAST }),
    /unity install failed on hetzner-1: md5 mismatch for Unity\.tar\.xz/);
});

test('a refused install start (no sudo) fails the step with the slave\'s message', async () => {
  const s = fakeSlave({ extras: { rust: {} }, failInstall: 'Passwordless sudo is required to install this component.' });
  await assert.rejects(publish.ensureToolchains(PEER, ['rust'], { client: s.client, waitOpts: FAST }), /Passwordless sudo/);
});

test('a slave unreachable for too long fails the wait; a short blip does not', async () => {
  const blip = fakeSlave({ extras: { rust: {} }, scripts: { rust: [new Error('ECONNRESET'), { installing: false, installed: true }] } });
  assert.deepEqual((await publish.ensureToolchains(PEER, ['rust'], { client: blip.client, waitOpts: FAST })).installed, ['rust']);
  const down = fakeSlave({ extras: { rust: {} }, scripts: { rust: Array.from({ length: 5000 }, () => new Error('ECONNREFUSED')) } });
  await assert.rejects(publish.ensureToolchains(PEER, ['rust'], { client: down.client, waitOpts: { pollMs: 2, unreachableMs: 20 } }),
    /hetzner-1 unreachable while installing rust: ECONNREFUSED/);
});

test('an owner action on an installed extra is a warning naming the peer, not a failure', async () => {
  const s = fakeSlave({
    extras: { rust: { installed: true }, unity: {} },
    scripts: { unity: [{ installing: false, installed: true }] },
    actions: [{ id: 'unity', action: 'Unity licence missing: sign in once under Setup → Extras → Unity' }],
  });
  const r = await publish.ensureToolchains(PEER, ['unity', 'rust', 'vulkan'], { client: s.client, waitOpts: FAST });
  assert.deepEqual(r.installed, ['unity']);
  assert.deepEqual(r.warnings, [
    'unknown toolchain "vulkan" in manifest.toolchains — ignored',
    'hetzner-1: Unity licence missing: sign in once under Setup → Extras → Unity',
  ]);
  assert.match(r.detail, /⚠ hetzner-1: Unity licence missing/);
});

test('a slave without the extras route or without the extra fails with "update vc"', async () => {
  await assert.rejects(publish.ensureToolchains(PEER, ['unity'], { client: fakeSlave({ notFound: true }).client, waitOpts: FAST }),
    /hetzner-1 cannot report its platform extras \(HTTP 404\) — update vc there/);
  await assert.rejects(publish.ensureToolchains(PEER, ['unity'], { client: fakeSlave({ extras: {} }).client, waitOpts: FAST }),
    /hetzner-1 does not know the "unity" extra — update vc there/);
});

test('no declared toolchains: nothing is asked of the slave', async () => {
  const s = fakeSlave();
  const r = await publish.ensureToolchains(PEER, [], { client: s.client });
  assert.equal(s.calls.length, 0);
  assert.equal(r.detail, 'none');
});

test('a cancelled publish stops waiting and says the slave keeps installing', async () => {
  const ac = new AbortController();
  const s = fakeSlave({ extras: { unity: {} }, scripts: { unity: Array.from({ length: 5000 }, () => ({ progress: 5 })) } });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(publish.ensureToolchains(PEER, ['unity'], { client: s.client, signal: ac.signal, waitOpts: FAST }),
    /cancelled — the unity install keeps running on hetzner-1/);
});

// --- the slave routes, through the real peer router and peer client -----------

test('GET /extras and POST /extras/:id/install on the slave: token-gated, one installer', async () => {
  const token = 'peer-token-for-tc-tests';
  files.set(path.join(appsDir, '.peer.enc'), JSON.stringify({ tokenHash: crypto.createHash('sha256').update(token).digest('hex') }));
  hostConfig.setRole('slave');
  hostConfig.setSlave({ name: 's', publicUrl: 'https://slave.example', linkStatus: 'linked' });
  const app = express();
  app.use('/api/peer', peerServer.createPeerRouter({}));
  const srv = await new Promise((resolve) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
  const peer = { name: 's', baseUrl: `http://127.0.0.1:${srv.address().port}`, token };
  const peerClient = require('../src/apps/peer-client');
  const realInstall = platformExtras.install;
  const installs = [];
  try {
    // Without the token: refused before any extras code runs.
    await assert.rejects(peerClient.call({ ...peer, token: 'wrong' }, '/extras'), (e) => e.status === 403);
    await assert.rejects(peerClient.call({ ...peer, token: 'wrong' }, '/extras/rust/install', { method: 'POST' }), (e) => e.status === 403);

    // Real list() on this box (read-only probes), filtered by ids.
    const all = await peerClient.call(peer, '/extras');
    assert.deepEqual(all.extras.map((e) => e.id), platformExtras.list().map((e) => e.id));
    const some = await peerClient.call(peer, '/extras?ids=rust,unity');
    assert.deepEqual(some.extras.map((e) => e.id), ['rust', 'unity']);
    assert.deepEqual(some.actions, []);

    // The install route is the Setup → Extras installer (stubbed here: no real install).
    platformExtras.install = (id) => { installs.push(id); return { ok: true, started: true }; };
    assert.deepEqual(await peerClient.call(peer, '/extras/rust/install', { method: 'POST' }), { ok: true, started: true });
    assert.deepEqual(installs, ['rust']);
    await assert.rejects(peerClient.call(peer, '/extras/nope/install', { method: 'POST' }), (e) => e.status === 404 && /unknown extra/.test(e.message));
    platformExtras.install = () => { throw new Error('Passwordless sudo is required'); };
    await assert.rejects(peerClient.call(peer, '/extras/rust/install', { method: 'POST' }), (e) => e.status === 409 && /Passwordless sudo/.test(e.message));

    // The step end to end over HTTP, against a stubbed slave-side state.
    const state = { 'android-build': { installed: true }, rust: { installed: false } };
    const realList = platformExtras.list;
    platformExtras.list = () => realList().map((e) => ({ ...e, installing: false, error: null, ...(state[e.id] || { installed: true }) }));
    platformExtras.install = (id) => {
      state[id] = { installed: false, installing: true, progress: 1, label: 'starting' };
      setTimeout(() => { state[id] = { installed: true, installing: false }; }, 30);
      return { ok: true, started: true };
    };
    try {
      const r = await publish.ensureToolchains(peer, ['rust', 'android'], { waitOpts: { pollMs: 10 } });
      assert.deepEqual(r.installed, ['rust']);
      assert.deepEqual(r.present, ['android-build']);
    } finally {
      platformExtras.list = realList;
    }
  } finally {
    platformExtras.install = realInstall;
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
    hostConfig.setRole('master');
  }
});
