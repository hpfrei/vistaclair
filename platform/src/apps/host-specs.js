// Hardware / software specs of THIS host (docs/fleet-specs.md): OS, CPU, RAM,
// GPUs, display + hardware GL, load, installed platform extras. A slave ships
// them in its channel status snapshot (peer-channel.js `slaveSnapshot`); the
// master sanitises what arrives (`clean`) and serves them through
// ctx.fleet.peers() / ctx.fleet.self() (capabilities/fleet.js).
//
// Every probe is best effort: a missing file or tool, a timeout or a bad parse
// gives a null field and never throws. External tools run through execFile
// (no shell) with a timeout and capped output.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const FULL_TTL_MS = 5 * 60 * 1000;    // the slow facts are re-measured at most this often
const EXEC_TIMEOUT_MS = 4000;
const EXEC_MAX_BUFFER = 256 * 1024;
const STR_MAX = 200;
const GPU_MAX = 8;
const EXTRAS_MAX = 64;
const EXTRA_VERSION_MAX = 64;
const EXTRA_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const SOFTWARE_GL_RE = /llvmpipe|softpipe|swrast|software|swiftshader/i;
const VENDORS = { '0x10de': 'NVIDIA', '0x1002': 'AMD', '0x8086': 'Intel', '0x1af4': 'Red Hat (virtio)', '0x15ad': 'VMware', '0x1414': 'Microsoft', '0x1ab8': 'Parallels' };

function realExec(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER, windowsHide: true, ...opts }, (err, stdout) => {
      if (err) reject(err); else resolve(String(stdout || ''));
    });
  });
}

// ---- Sanitiser (master side: the snapshot is peer input) ---------------------

const str = (v, max = STR_MAX) => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  return s || null;
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const int = (v) => { const n = num(v); return n == null ? null : Math.round(n); };
const dec = (v) => { const n = num(v); return n == null ? null : Math.round(n * 100) / 100; };
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// A peer's `specs` → the fixed shape, or null when it is not an object.
function clean(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const os_ = obj(raw.os), cpu = obj(raw.cpu), ram = obj(raw.ram), disp = obj(raw.display), load = obj(raw.load);
  const gpus = (Array.isArray(raw.gpus) ? raw.gpus : []).filter((g) => g && typeof g === 'object' && !Array.isArray(g)).slice(0, GPU_MAX).map((g) => ({
    vendor: str(g.vendor), model: str(g.model), driver: str(g.driver),
    renderNode: typeof g.renderNode === 'string' && /^\/dev\/dri\/renderD\d{1,4}$/.test(g.renderNode) ? g.renderNode : null,
    vramBytes: int(g.vramBytes),
  }));
  const extras = {};
  let n = 0;
  for (const [k, v] of Object.entries(obj(raw.extras))) {
    if (n >= EXTRAS_MAX) break;
    const ver = str(v, EXTRA_VERSION_MAX);
    if (EXTRA_KEY_RE.test(k) && ver) { extras[k] = ver; n++; }
  }
  return {
    os: { platform: str(os_.platform, 32), release: str(os_.release, 64), arch: str(os_.arch, 32), distro: str(os_.distro) },
    cpu: { model: str(cpu.model), cores: int(cpu.cores), threads: int(cpu.threads), mhz: int(cpu.mhz) },
    ram: { totalBytes: int(ram.totalBytes), availBytes: int(ram.availBytes) },
    gpus,
    display: {
      x11: disp.x11 === true, wayland: disp.wayland === true,
      display: str(disp.display, 32),
      hwGL: typeof disp.hwGL === 'boolean' ? disp.hwGL : null,
      glRenderer: str(disp.glRenderer),
    },
    load: { avg1: dec(load.avg1), avg5: dec(load.avg5) },
    extras,
    at: int(raw.at) || Date.now(),
  };
}

// ---- Measuring ---------------------------------------------------------------

// `deps` is injectable for tests: { os, fs, exec, env, now, extras }.
function createMeasurer(deps = {}) {
  const d = {
    os, fs, exec: realExec, env: process.env, now: Date.now,
    extras: () => require('./platform-extras').list().filter((e) => e.installed).map((e) => ({ id: e.id, version: extraVersion(e.id) })),
    ...deps,
  };
  const read = (p) => { try { return String(d.fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const readdir = (p) => { try { return d.fs.readdirSync(p).map(String); } catch { return []; } };
  const run = async (file, args, opts) => { try { return await d.exec(file, args, opts); } catch { return null; } };

  function measureOs() {
    let distro = null;
    const rel = read('/etc/os-release');
    const m = rel && /^PRETTY_NAME=(.*)$/m.exec(rel);
    if (m) distro = m[1].trim().replace(/^["']|["']$/g, '');
    return { platform: d.os.platform(), release: d.os.release(), arch: d.os.arch(), distro: distro || null };
  }

  function measureCpu() {
    const cpus = (() => { try { return d.os.cpus() || []; } catch { return []; } })();
    const threads = cpus.length || null;
    let cores = null;
    const info = read('/proc/cpuinfo');
    if (info) {
      // Physical cores = distinct (physical id, core id) pairs.
      const seen = new Set();
      for (const block of info.split(/\n\s*\n/)) {
        const pid = /^physical id\s*:\s*(\S+)/m.exec(block)?.[1];
        const cid = /^core id\s*:\s*(\S+)/m.exec(block)?.[1];
        if (cid != null) seen.add(`${pid ?? 0}:${cid}`);
      }
      if (seen.size) cores = seen.size;
    }
    return { model: cpus[0]?.model?.trim() || null, cores: cores ?? threads, threads, mhz: cpus[0]?.speed || null };
  }

  function measureRam() {
    const total = d.os.totalmem();
    let avail = null;
    const mi = read('/proc/meminfo');
    const m = mi && /^MemAvailable:\s+(\d+)\s*kB/m.exec(mi);
    if (m) avail = Number(m[1]) * 1024;
    if (avail == null) { try { avail = d.os.freemem(); } catch {} }
    return { totalBytes: total || null, availBytes: avail };
  }

  function measureLoad() {
    const l = (() => { try { return d.os.loadavg(); } catch { return [0, 0, 0]; } })();
    return { avg1: Math.round(l[0] * 100) / 100, avg5: Math.round(l[1] * 100) / 100 };
  }

  const hex = (s) => (s || '').trim().toLowerCase();

  async function measureGpus() {
    const DRM = '/sys/class/drm';
    const nodes = readdir(DRM).filter((n) => /^renderD\d+$/.test(n)).sort();
    const gpus = [];
    for (const n of nodes.slice(0, GPU_MAX)) {
      const dev = `${DRM}/${n}/device`;
      const vendorId = hex(read(`${dev}/vendor`));
      const deviceId = hex(read(`${dev}/device`));
      let driver = null;
      try { driver = path.basename(d.fs.readlinkSync(`${dev}/driver`)) || null; } catch {}
      let slot = null;
      try { slot = path.basename(d.fs.realpathSync(dev)); } catch {}
      const vram = Number(String(read(`${dev}/mem_info_vram_total`) || '').trim());
      gpus.push({
        vendorId, deviceId, slot,
        vendor: VENDORS[vendorId] || (vendorId || null),
        model: null, driver, renderNode: `/dev/dri/${n}`,
        vramBytes: Number.isFinite(vram) && vram > 0 ? vram : null,
      });
    }
    // Model names from lspci (one call), when it is installed.
    if (gpus.length) {
      const out = await run('lspci', ['-mm', '-nn']);
      if (out) {
        for (const line of out.split('\n')) {
          const f = [...line.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
          if (f.length < 3) continue;
          const slot = line.split(/\s/)[0];
          const ids = (s) => /\[([0-9a-f]{4})\]$/i.exec(s)?.[1]?.toLowerCase();
          for (const g of gpus) {
            const sameSlot = g.slot && (g.slot === slot || g.slot.endsWith(`:${slot}`));
            if (!g.model && (sameSlot || (ids(f[2]) === g.deviceId.replace(/^0x/, '') && ids(f[1]) === g.vendorId.replace(/^0x/, '')))) {
              g.model = f[2].replace(/\s*\[[0-9a-f]{4}\]$/i, '').trim() || null;
            }
          }
        }
      }
    }
    // nvidia-smi: the exact name and VRAM; also GPUs without a DRM render node.
    if (gpus.some((g) => g.vendorId === '0x10de') || !gpus.length) {
      const out = await run('nvidia-smi', ['--query-gpu=name,memory.total,pci.bus_id', '--format=csv,noheader,nounits']);
      if (out) {
        const unmatched = [];
        for (const line of out.split('\n').map((l) => l.trim()).filter(Boolean)) {
          const [name, mib, bus] = line.split(',').map((x) => x.trim());
          if (!name) continue;
          const tail = (bus || '').toLowerCase().replace(/^[0-9a-f]{4,8}:/, '');
          const vram = Number(mib) > 0 ? Math.round(Number(mib) * 1048576) : null;
          const g = gpus.find((x) => x.vendorId === '0x10de' && x.slot && tail && x.slot.toLowerCase().endsWith(tail));
          if (g) { g.model = name; if (vram) g.vramBytes = vram; } else unmatched.push({ name, vram });
        }
        // GPUs the kernel exposes no render node for (no nvidia-drm): listed
        // only when sysfs showed no NVIDIA GPU at all.
        if (!gpus.some((x) => x.vendorId === '0x10de')) {
          for (const u of unmatched) {
            if (gpus.length < GPU_MAX) gpus.push({ vendor: 'NVIDIA', model: u.name, driver: 'nvidia', renderNode: null, vramBytes: u.vram, vendorId: '0x10de' });
          }
        }
      }
    }
    return gpus.slice(0, GPU_MAX).map((g) => ({
      vendor: g.vendor || null,
      model: g.model || (g.vendor && g.deviceId ? `${g.vendor} device ${g.deviceId.replace(/^0x/, '')}` : null),
      driver: g.driver || null, renderNode: g.renderNode, vramBytes: g.vramBytes ?? null,
    }));
  }

  async function measureDisplay() {
    const env = d.env || {};
    const x11Sockets = readdir('/tmp/.X11-unix').filter((n) => /^X\d+$/.test(n)).sort();
    const x11 = x11Sockets.length > 0;
    const runtime = env.XDG_RUNTIME_DIR;
    const wayland = !!(runtime && readdir(runtime).some((n) => /^wayland-\d+$/.test(n))) || !!(env.WAYLAND_DISPLAY && runtime);
    let display = typeof env.DISPLAY === 'string' && /^[\w.:/-]{1,32}$/.test(env.DISPLAY) ? env.DISPLAY : null;
    if (!display && x11) display = `:${x11Sockets[0].slice(1)}`;
    // Hardware GL: the renderer a context on that display would get.
    let hwGL = null;
    let glRenderer = null;
    if (x11 || wayland) {
      const probes = x11 && display
        ? [['glxinfo', ['-B'], { env: { ...env, DISPLAY: display } }]]
        : [];
      probes.push(['eglinfo', ['-B'], { env: { ...env } }]);
      for (const [tool, args, opts] of probes) {
        const out = await run(tool, args, opts);
        if (!out) continue;
        const renderers = [...out.matchAll(/^\s*(?:OpenGL(?: ES)?(?: core profile)?) renderer string:\s*(.+)$/gim)].map((m) => m[1].trim()).filter(Boolean);
        if (!renderers.length) continue;
        const hw = renderers.find((r) => !SOFTWARE_GL_RE.test(r));
        hwGL = !!hw;
        glRenderer = hw || renderers[0];
        break;
      }
    }
    return { x11, wayland, display, hwGL, glRenderer };
  }

  function measureExtras() {
    const out = {};
    try {
      for (const e of d.extras() || []) if (e && e.id) out[e.id] = e.version || 'installed';
    } catch {}
    return out;
  }

  // The slow facts (everything but the live ram.availBytes and load).
  async function measureFull() {
    const [gpus, display] = await Promise.all([measureGpus().catch(() => []), measureDisplay().catch(() => ({ x11: false, wayland: false, display: null, hwGL: null, glRenderer: null }))]);
    return clean({
      os: measureOs(), cpu: measureCpu(), ram: measureRam(), gpus, display, load: measureLoad(),
      extras: measureExtras(), at: d.now(),
    });
  }

  return { measureFull, measureRam, measureLoad };
}

// Version of one installed platform extra: the pinned release the installer
// fetched, or 'installed' when the extra has no pinned release.
function extraVersion(id) {
  try {
    const x = require('./platform-extras');
    const v = { blender: x.BLENDER_VERSION, rust: x.RUST_VERSION, godot: x.GODOT_VERSION, unity: x.UNITY_VERSION }[id];
    return typeof v === 'string' && v ? v : 'installed';
  } catch { return 'installed'; }
}

// ---- The host's cached specs --------------------------------------------------

function createStore(measurer, now = Date.now) {
  let cache = null;      // last full measurement
  let inflight = null;
  async function refresh() {
    if (!inflight) {
      inflight = measurer.measureFull().then((s) => { if (s) cache = s; return cache; }).catch(() => cache).finally(() => { inflight = null; });
    }
    return inflight;
  }
  // The specs now: the slow facts from the cache (re-measured when older than
  // the TTL), the live fields (ram.availBytes, load) read afresh. Never throws;
  // null only when nothing could be measured at all.
  async function get({ ttlMs = FULL_TTL_MS } = {}) {
    if (!cache || now() - cache.at >= ttlMs) await refresh();
    if (!cache) return null;
    return { ...cache, ram: { ...cache.ram, availBytes: measurer.measureRam().availBytes }, load: measurer.measureLoad() };
  }
  return { get, refresh, _reset: () => { cache = null; inflight = null; } };
}

const store = createStore(createMeasurer());

module.exports = {
  get: (opts) => store.get(opts),
  refresh: () => store.refresh(),
  clean, createMeasurer, createStore, extraVersion,
  FULL_TTL_MS, GPU_MAX, EXTRAS_MAX,
};
