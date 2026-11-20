// Peer hardware specs (docs/fleet-specs.md): the measurer on mocked /proc, /sys
// and exec; the sanitiser against a hostile snapshot; the channel's applySnapshot
// and fleetState; peers() / self() through ctx and the Bridge; the flag.
// Never touches the live control-room server or real peers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hostSpecs = require('../src/apps/host-specs');
const { makeAppsDir, call } = require('./helpers');

// ---- the measurer, on a fake host ------------------------------------------

function fakeFs(files, links = {}, dirs = {}) {
  return {
    readFileSync: (p) => { if (p in files) return files[p]; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    readdirSync: (p) => { if (p in dirs) return dirs[p]; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    readlinkSync: (p) => { if (p in links) return links[p]; throw new Error('ENOENT'); },
    realpathSync: (p) => { if (p in links) return links[p]; throw new Error('ENOENT'); },
  };
}
const fakeOs = {
  platform: () => 'linux', release: () => '6.8.0-test', arch: () => 'x64',
  cpus: () => Array.from({ length: 16 }, () => ({ model: 'Test CPU 9000', speed: 3600 })),
  totalmem: () => 64 * 1024 ** 3, freemem: () => 1,
  loadavg: () => [1.234, 2.5, 3],
};
const CPUINFO = Array.from({ length: 16 }, (_, i) => `processor\t: ${i}\nphysical id\t: 0\ncore id\t\t: ${i % 8}\n`).join('\n');
const BASE_FILES = {
  '/etc/os-release': 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04 LTS"\n',
  '/proc/cpuinfo': CPUINFO,
  '/proc/meminfo': 'MemTotal: 67108864 kB\nMemAvailable:   33554432 kB\n',
};
const gpuFiles = (vendor, device, extra = {}) => ({
  '/sys/class/drm/renderD128/device/vendor': `${vendor}\n`,
  '/sys/class/drm/renderD128/device/device': `${device}\n`,
  ...extra,
});
const GPU_LINKS = {
  '/sys/class/drm/renderD128/device/driver': '../../../bus/pci/drivers/nvidia',
  '/sys/class/drm/renderD128/device': '/sys/devices/pci0000:00/0000:01:00.0',
};

function measurer({ files = {}, links = {}, dirs = {}, tools = {}, env = {}, extras = [] } = {}) {
  const execLog = [];
  return {
    execLog,
    m: hostSpecs.createMeasurer({
      os: fakeOs,
      fs: fakeFs({ ...BASE_FILES, ...files }, links, dirs),
      env,
      now: () => 1700000000000,
      extras: () => extras,
      exec: async (file, args, opts) => {
        execLog.push([file, args, opts]);
        if (typeof tools[file] === 'function') return tools[file](args, opts);
        if (file in tools) return tools[file];
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      },
    }),
  };
}

test('measure: an NVIDIA host with a display and hardware GL', async () => {
  const { m, execLog } = measurer({
    files: gpuFiles('0x10de', '0x2786'),
    links: GPU_LINKS,
    dirs: { '/sys/class/drm': ['card0', 'renderD128', 'renderD129x'], '/tmp/.X11-unix': ['X0'], '/run/user/1000': ['wayland-0', 'bus'] },
    env: { XDG_RUNTIME_DIR: '/run/user/1000', DISPLAY: ':0', PATH: '/usr/bin' },
    tools: {
      lspci: '01:00.0 "VGA compatible controller [0300]" "NVIDIA Corporation [10de]" "AD104 [GeForce RTX 4070] [2786]" -ra1\n',
      'nvidia-smi': 'NVIDIA GeForce RTX 4070, 12282, 00000000:01:00.0\n',
      glxinfo: 'OpenGL vendor string: NVIDIA Corporation\nOpenGL renderer string: NVIDIA GeForce RTX 4070/PCIe/SSE2\n',
    },
    extras: [{ id: 'rust', version: '1.99.0' }, { id: 'ffmpeg', version: 'installed' }],
  });
  const s = await m.measureFull();
  assert.deepEqual(s.os, { platform: 'linux', release: '6.8.0-test', arch: 'x64', distro: 'Ubuntu 24.04 LTS' });
  assert.deepEqual(s.cpu, { model: 'Test CPU 9000', cores: 8, threads: 16, mhz: 3600 });
  assert.deepEqual(s.ram, { totalBytes: 64 * 1024 ** 3, availBytes: 32 * 1024 ** 3 });
  assert.deepEqual(s.gpus, [{ vendor: 'NVIDIA', model: 'NVIDIA GeForce RTX 4070', driver: 'nvidia', renderNode: '/dev/dri/renderD128', vramBytes: 12282 * 1048576 }]);
  assert.deepEqual(s.display, { x11: true, wayland: true, display: ':0', hwGL: true, glRenderer: 'NVIDIA GeForce RTX 4070/PCIe/SSE2' });
  assert.deepEqual(s.load, { avg1: 1.23, avg5: 2.5 });
  assert.deepEqual(s.extras, { rust: '1.99.0', ffmpeg: 'installed' });
  assert.equal(s.at, 1700000000000);
  // Every probe is execFile-style (file + args array), with no shell flag.
  for (const [file, args, opts] of execLog) {
    assert.equal(typeof file, 'string');
    assert.ok(Array.isArray(args));
    assert.ok(!opts || !opts.shell);
  }
  // glxinfo ran against that display only.
  const glx = execLog.find(([f]) => f === 'glxinfo');
  assert.equal(glx[2].env.DISPLAY, ':0');
});

test('measure: llvmpipe is software (hwGL false); a real renderer wins over it', async () => {
  const env = { DISPLAY: ':1' };
  const dirs = { '/tmp/.X11-unix': ['X1'] };
  const soft = await measurer({ env, dirs, tools: { glxinfo: 'OpenGL renderer string: llvmpipe (LLVM 17.0.6, 256 bits)\n' } }).m.measureFull();
  assert.equal(soft.display.hwGL, false);
  assert.match(soft.display.glRenderer, /llvmpipe/);
  const swift = await measurer({ env, dirs, tools: { glxinfo: 'OpenGL renderer string: Google SwiftShader\n' } }).m.measureFull();
  assert.equal(swift.display.hwGL, false);
  const hw = await measurer({ env, dirs, tools: { glxinfo: 'OpenGL renderer string: Mesa Intel(R) Graphics (MTL)\n' } }).m.measureFull();
  assert.equal(hw.display.hwGL, true);
  assert.equal(hw.display.glRenderer, 'Mesa Intel(R) Graphics (MTL)');
});

test('measure: no glxinfo / eglinfo → hwGL and glRenderer null; display from the X socket', async () => {
  const { m } = measurer({ dirs: { '/tmp/.X11-unix': ['X3'] }, env: {} });
  const s = await m.measureFull();
  assert.deepEqual(s.display, { x11: true, wayland: false, display: ':3', hwGL: null, glRenderer: null });
});

test('measure: a headless host with no GPU, no display, nothing installed', async () => {
  const { m, execLog } = measurer({ files: { '/etc/os-release': undefined } });
  const s = await m.measureFull();
  assert.deepEqual(s.gpus, []);
  assert.deepEqual(s.display, { x11: false, wayland: false, display: null, hwGL: null, glRenderer: null });
  assert.deepEqual(s.extras, {});
  assert.equal(s.os.distro, null);
  assert.ok(!execLog.some(([f]) => f === 'glxinfo' || f === 'eglinfo'), 'no display → no GL probe');
});

test('measure: amdgpu VRAM from sysfs, model by device id when lspci has the slot', async () => {
  const { m } = measurer({
    files: gpuFiles('0x1002', '0x744c', { '/sys/class/drm/renderD128/device/mem_info_vram_total': '25753026560\n' }),
    links: { '/sys/class/drm/renderD128/device/driver': '../../../bus/pci/drivers/amdgpu', '/sys/class/drm/renderD128/device': '/sys/devices/pci0000:00/0000:03:00.0' },
    dirs: { '/sys/class/drm': ['renderD128'] },
    tools: { lspci: '03:00.0 "VGA compatible controller [0300]" "Advanced Micro Devices, Inc. [AMD/ATI] [1002]" "Navi 31 [Radeon RX 7900 XTX] [744c]" -rc8\n' },
  });
  const s = await m.measureFull();
  assert.deepEqual(s.gpus, [{ vendor: 'AMD', model: 'Navi 31 [Radeon RX 7900 XTX]', driver: 'amdgpu', renderNode: '/dev/dri/renderD128', vramBytes: 25753026560 }]);
});

test('measure: no lspci → a vendor/device fallback name; nvidia-smi alone lists a GPU without a render node', async () => {
  const a = await measurer({
    files: gpuFiles('0x8086', '0x7d55'),
    dirs: { '/sys/class/drm': ['renderD128'] },
  }).m.measureFull();
  assert.equal(a.gpus[0].vendor, 'Intel');
  assert.equal(a.gpus[0].model, 'Intel device 7d55');
  assert.equal(a.gpus[0].vramBytes, null);
  assert.equal(a.gpus[0].driver, null);

  const b = await measurer({ tools: { 'nvidia-smi': 'Tesla T4, 15360, 00000000:00:1E.0\n' } }).m.measureFull();
  assert.deepEqual(b.gpus, [{ vendor: 'NVIDIA', model: 'Tesla T4', driver: 'nvidia', renderNode: null, vramBytes: 15360 * 1048576 }]);
});

test('measure: a failing probe never throws', async () => {
  const m = hostSpecs.createMeasurer({
    os: { ...fakeOs, cpus: () => { throw new Error('boom'); }, loadavg: () => { throw new Error('boom'); } },
    fs: fakeFs({}),
    env: { DISPLAY: ':0' },
    extras: () => { throw new Error('boom'); },
    exec: async () => { throw new Error('boom'); },
  });
  const s = await m.measureFull();
  assert.equal(s.cpu.threads, null);
  assert.deepEqual(s.extras, {});
});

// ---- the cache -------------------------------------------------------------

test('store: slow facts cached for the TTL; load and free RAM fresh per get; single flight', async () => {
  let n = 0;
  let avail = 100;
  let t = 1000;
  const measurer_ = {
    measureFull: async () => { n++; await new Promise((r) => setTimeout(r, 5)); return hostSpecs.clean({ os: { platform: 'linux' }, ram: { totalBytes: 1000, availBytes: 1 }, load: { avg1: 9, avg5: 9 }, at: t }); },
    measureRam: () => ({ totalBytes: 1000, availBytes: avail }),
    measureLoad: () => ({ avg1: avail / 100, avg5: 0.5 }),
  };
  const store = hostSpecs.createStore(measurer_, () => t);
  const [a, b] = await Promise.all([store.get(), store.get()]);
  assert.equal(n, 1, 'concurrent first gets share one measurement');
  assert.equal(a.ram.availBytes, 100);
  avail = 50; t += 60 * 1000;
  const c = await store.get();
  assert.equal(n, 1, 'inside the TTL no re-measure');
  assert.equal(c.ram.availBytes, 50);
  assert.equal(c.load.avg1, 0.5);
  assert.equal(c.at, 1000, 'at stays the slow measurement time');
  t += hostSpecs.FULL_TTL_MS;
  await store.get();
  assert.equal(n, 2);
  assert.ok(b);
});

test('store: a measurement that fails yields null, never a throw', async () => {
  const store = hostSpecs.createStore({ measureFull: async () => { throw new Error('x'); }, measureRam: () => ({}), measureLoad: () => ({}) });
  assert.equal(await store.get(), null);
});

// ---- the sanitiser ---------------------------------------------------------

test('clean: a hostile snapshot is clamped to the shape', () => {
  const long = 'A'.repeat(5000);
  const raw = {
    os: { platform: long, release: { x: 1 }, arch: 'x64\u0000\u001b[31m', distro: long },
    cpu: { model: long, cores: '8', threads: -4, mhz: Infinity },
    ram: { totalBytes: 'lots', availBytes: NaN },
    gpus: Array.from({ length: 50 }, (_, i) => ({ vendor: long, model: `g${i}`, driver: 7, renderNode: i === 0 ? '/dev/dri/renderD128' : '../../etc/passwd', vramBytes: i === 0 ? 1e10 : -1 })).concat([null, 'x', [1]]),
    display: { x11: 'yes', wayland: true, display: long, hwGL: 'true', glRenderer: long },
    load: { avg1: 1.23456, avg5: {} },
    extras: Object.fromEntries([['__proto__', '1'], ['../x', '1'], ['Bad Key', '1'], ['ok', long], ['a'.repeat(41), '1'], ['fine', 3], ...Array.from({ length: 200 }, (_, i) => [`e${i}`, `v${i}`])]),
    at: 'yesterday',
    evil: { injected: true },
  };
  const s = hostSpecs.clean(raw);
  assert.equal(s.os.platform.length, 32);
  assert.equal(s.os.release, null);
  assert.equal(s.os.arch, 'x64  [31m');
  assert.equal(s.os.distro.length, 200);
  assert.equal(s.cpu.model.length, 200);
  assert.deepEqual([s.cpu.cores, s.cpu.threads, s.cpu.mhz], [null, null, null]);
  assert.deepEqual(s.ram, { totalBytes: null, availBytes: null });
  assert.equal(s.gpus.length, hostSpecs.GPU_MAX);
  assert.equal(s.gpus[0].renderNode, '/dev/dri/renderD128');
  assert.equal(s.gpus[0].vramBytes, 1e10);
  assert.equal(s.gpus[1].renderNode, null);
  assert.equal(s.gpus[1].vramBytes, null);
  assert.equal(s.gpus[0].vendor.length, 200);
  assert.equal(s.gpus[0].driver, null);
  assert.deepEqual(s.display, { x11: false, wayland: true, display: 'A'.repeat(32), hwGL: null, glRenderer: 'A'.repeat(200) });
  assert.deepEqual(s.load, { avg1: 1.23, avg5: null });
  assert.equal(s.extras.ok.length, 64);
  assert.ok(!('__proto__' in s.extras) || Object.getPrototypeOf(s.extras) === Object.prototype);
  assert.ok(!('../x' in s.extras) && !('Bad Key' in s.extras) && !('fine' in s.extras));
  assert.ok(Object.keys(s.extras).length <= hostSpecs.EXTRAS_MAX);
  assert.ok(Object.keys(s.extras).length > 10);
  assert.equal(typeof s.at, 'number');
  assert.ok(!('evil' in s));
  assert.equal(Object.prototype.hasOwnProperty.call(s.extras, '__proto__'), false);
});

test('clean: not an object → null; an empty object → the full shape of nulls', () => {
  for (const bad of [null, undefined, 'x', 7, [1]]) assert.equal(hostSpecs.clean(bad), null);
  const e = hostSpecs.clean({});
  assert.deepEqual(e.gpus, []);
  assert.deepEqual(e.extras, {});
  assert.equal(e.cpu.model, null);
  assert.equal(e.display.x11, false);
});

// ---- channel: applySnapshot / fleetState -------------------------------------

test('peer-channel: applySnapshot sanitises specs, keeps the last ones, fleetState carries them', () => {
  const channel = require('../src/apps/peer-channel');
  const pairing = require('../src/apps/peer-pairing');
  const orig = pairing.listPeersPublic;
  pairing.listPeersPublic = () => ({ peers: [{ name: 's1', baseUrl: 'https://s1.test' }, { name: 's2', baseUrl: 'https://s2.test' }] });
  try {
    const c = channel._newConn({ name: 's1' });
    channel._conns.set('s1', c);
    channel._conns.set('s2', channel._newConn({ name: 's2' }));
    channel._handleSlaveMessage(c, { t: 'status', apps: [], specs: { cpu: { model: 'X'.repeat(999), cores: 4 }, gpus: new Array(20).fill({ vendor: 'v' }), extras: { rust: '1.99.0' }, at: 5 } });
    let st = channel.fleetState().peers;
    assert.equal(st[0].specs.cpu.model.length, 200);
    assert.equal(st[0].specs.gpus.length, 8);
    assert.equal(st[0].specs.at, 5);
    assert.equal(st[1].specs, null, 'a slave that never reported has null');

    // A later snapshot without specs (older slave, failed measure): last ones kept.
    channel._handleSlaveMessage(c, { t: 'status', apps: [] });
    st = channel.fleetState().peers;
    assert.equal(st[0].specs.cpu.cores, 4);
    // Garbage specs do not replace them either.
    channel._handleSlaveMessage(c, { t: 'status', apps: [], specs: 'junk' });
    assert.equal(channel.fleetState().peers[0].specs.cpu.cores, 4);
    // Offline: the conn keeps the snapshot.
    c.connected = false;
    assert.equal(channel.fleetState().peers[0].specs.extras.rust, '1.99.0');
  } finally {
    pairing.listPeersPublic = orig;
    channel._conns.clear();
  }
});

// ---- the app API: peers(), self(), Bridge, flag --------------------------------

const appManager = require('../src/apps/app-manager');
const pairing = require('../src/apps/peer-pairing');
const capabilities = require('../src/apps/capabilities');
const fleetData = require('../src/apps/fleet-data');
const appBridge = require('../src/apps/app-bridge');

const appsDir = makeAppsDir({ world: {}, side: { runtime: 'own-process' } });
appManager.setAppsDir(appsDir);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-fleet-specs-'));
const SPECS = hostSpecs.clean({ cpu: { model: 'Big', cores: 16, threads: 32 }, ram: { totalBytes: 64e9 }, extras: { rust: '1.99.0' }, at: 123 });
const peerRows = [
  { id: 'p1', name: 'new', baseUrl: 'https://new.test' },
  { id: 'p2', name: 'old', baseUrl: 'https://old.test' },
  { id: 'p3', name: 'off', baseUrl: 'https://off.test' },
];
pairing.getPeer = (ref) => peerRows.find((p) => p.name === ref || p.id === ref) || null;
fleetData.init({
  stateDir: path.join(tmp, '.fleet-data'),
  getPeer: pairing.getPeer,
  listPeers: () => peerRows,
  appExists: (a) => fs.existsSync(path.join(appsDir, a)),
  dataDir: (a) => path.join(appsDir, a, '.data'),
  // `old` reported no specs (an older slave); `off` is offline but kept its last.
  fleetState: () => ({ peers: [
    { name: 'new', deployed: { world: 'abc' }, specs: SPECS },
    { name: 'old', deployed: { world: 'abc' } },
    { name: 'off', deployed: { world: 'abc' }, specs: { ...SPECS, at: 99 } },
  ] }),
  client: {
    async call(peer) {
      if (peer.name === 'off') throw Object.assign(new Error('connect ECONNREFUSED'), {});
      return { code: 'ok', installed: true, enabled: true, running: true, version: '1', commit: 'abc', runtime: 'in-process', freeBytes: 1e9, marginBytes: 1e6, receivers: [] };
    },
  },
  pollMs: 10, progressMs: 0, persistMs: 10, resume: false,
});
test.after(async () => {
  await fleetData.shutdown();
  for (const d of [appsDir, tmp]) fs.rmSync(d, { recursive: true, force: true });
});
const ctxFor = (name, profile = 'dashboard') => capabilities.buildCtx(
  { name, dir: path.join(appsDir, name), manifest: appManager.readManifest(name), broadcaster: { broadcast() {} } }, { profile });

test('peers(): every row has specs — null for an old slave, the last ones for an offline slave', async () => {
  const rows = await ctxFor('world').fleet.peers();
  const by = Object.fromEntries(rows.map((r) => [r.peer, r]));
  assert.deepEqual(by.new.specs, SPECS);
  assert.equal(by.old.specs, null);
  assert.equal(by.off.online, false);
  assert.equal(by.off.specs.at, 99);
  const viaBridge = await call(appBridge, 'world', 'fleet.peers', {});
  assert.deepEqual(viaBridge.result.find((r) => r.peer === 'new').specs, SPECS);
  assert.equal(viaBridge.result.find((r) => r.peer === 'old').specs, null);
});

test('self(): this host in the same shape, through ctx and the Bridge', async () => {
  const s = await ctxFor('world').fleet.self();
  assert.ok(s, 'this host measures');
  assert.deepEqual(Object.keys(s).sort(), Object.keys(SPECS).sort());
  assert.equal(s.os.platform, process.platform);
  assert.equal(s.cpu.threads, os.cpus().length);
  assert.equal(typeof s.ram.availBytes, 'number');
  assert.equal(typeof s.at, 'number');
  const b = await call(appBridge, 'world', 'fleet.self', {});
  assert.equal(b.result.os.platform, process.platform);
  assert.deepEqual(Object.keys(b.result).sort(), Object.keys(SPECS).sort());
});

test('flag fleet.specs: on ctx.capabilities and capabilities.list; absent for an own-process app', async () => {
  const ctx = ctxFor('world');
  assert.ok(ctx.capabilities.has('fleet.specs'));
  assert.ok(ctx.capabilities.list().includes('fleet.specs'));
  const listed = await call(appBridge, 'world', 'capabilities.list', {});
  assert.ok(listed.result.capabilities.includes('fleet.specs'));
  const side = ctxFor('side', 'standalone');
  assert.ok(!('fleet' in side));
  assert.equal(side.capabilities.has('fleet.specs'), false);
});

test('Horst lane: fleet.self is a direct member served by fleet_status', () => {
  const lane = capabilities.get('fleet').horst.lane;
  assert.deepEqual(lane.direct['fleet.self'], { tools: ['fleet_status'] });
  assert.ok(capabilities.get('fleet').methods.includes('fleet.self'));
});
