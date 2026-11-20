// platform-sysmon — one host monitor for the whole platform.
//
// Every app that wants to know how much room is left on the box used to have to
// write its own sampler. That is one /proc reader per app, each on its own timer,
// each with its own idea of what "used memory" means. This is the single sampler:
// apps subscribe, the platform samples once, and everyone sees the same numbers.
//
// Two cadences, because they cost very different amounts:
//   - the cheap sample (mem/cpu/swap/disk/load) is three file reads, every 2s
//   - the per-process breakdown walks /proc, every 10s
// Both are demand-driven: no subscriber, no timer. A subscription is a LEASE that
// expires, so an app whose GUI was closed without unsubscribing cannot leak a
// timer forever — the worst case is one TTL of sampling nobody reads.
//
// History is kept server-side on purpose. A reloaded GUI asks for it and paints a
// full chart immediately instead of starting from an empty axis, which is the
// difference between "I can see the trend" and "wait 5 minutes".

const fs = require('fs');
const os = require('os');

const TICK_MS = 2000;
const TTL_DEFAULT = 15 * 60 * 1000;
const TTL_MAX = 60 * 60 * 1000;
const HISTORY_MAX = 300;              // ~10 min of cheap samples
const BREAKDOWN_MAX = 60;             // ~10 min of breakdowns
const BREAKDOWN_EVERY = 5;            // ticks — every 10s
const BREAKDOWN_STALE_MS = 5000;      // on-demand recompute threshold
const SMAPS_TOP_N = 20;               // PSS refinement is capped to the heaviest PIDs
const OTHER_TOP_N = 10;

let appsDir = null;
let appManager = null;
let broadcaster = null;

let subs = new Map();            // appName -> lease expiry (epoch ms)
let timer = null;
let history = [];                // ring of cheap samples
let breakdowns = [];             // ring of process breakdowns
let lastBreakdown = null;
let tickCount = 0;
let lastCpu = null;                // previous /proc/stat jiffy counters, for the delta

// ---------------------------------------------------------------- sampling

// /proc/meminfo is the only place the kernel states AVAILABLE memory (free +
// reclaimable), which is the number that decides whether a job OOMs. MemFree
// alone reads catastrophically low on any box with a warm page cache.
function readMeminfo() {
  const out = {};
  try {
    for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
      const m = /^(\w+):\s+(\d+) kB/.exec(line);
      if (m) out[m[1]] = Number(m[2]) * 1024;
    }
  } catch { /* non-Linux host: the sample degrades to nulls, never to a guess */ }
  return out;
}

// CPU is a RATE, not a level: /proc/stat only ever counts jiffies since boot, so a
// single read says nothing. Every figure below is the delta against the previous
// read — which is why this function is called exactly once per tick and its result
// stashed. Reading it twice in a tick would hand the second caller a zero window.
//
// "Busy" deliberately counts iowait as idle (the CPU really is available during it)
// and reports iowait separately — a box at 5% CPU and 40% iowait is thrashing its
// disk, and lumping the two together hides exactly the failure this panel exists
// to make visible.
function readCpuTimes() {
  try {
    const txt = fs.readFileSync('/proc/stat', 'utf8');
    const cores = [];
    let all = null;
    for (const line of txt.split('\n')) {
      const m = /^cpu(\d*) +(.*)$/.exec(line);
      if (!m) { if (all) break; continue; }        // the cpu* lines come first, together
      const f = m[2].trim().split(/ +/).map(Number);
      // user nice system idle iowait irq softirq steal guest guest_nice
      const rec = {
        total: f.reduce((a, b) => a + (isFinite(b) ? b : 0), 0),
        idle: (f[3] || 0) + (f[4] || 0),
        iowait: f[4] || 0,
      };
      if (m[1] === '') all = rec; else cores.push(rec);
    }
    return all ? { all, cores } : null;
  } catch { return null; }
}

// Non-Linux fallback. os.cpus() carries the same counters per core (minus iowait
// and steal, which libuv drops), so the aggregate is a sum rather than a read.
function readCpuTimesPortable() {
  let list;
  try { list = os.cpus() || []; } catch { return null; }
  if (!list.length) return null;
  const cores = list.map((c) => {
    const t = c.times;
    return { total: t.user + t.nice + t.sys + t.idle + t.irq, idle: t.idle, iowait: 0 };
  });
  const all = cores.reduce((a, c) => ({ total: a.total + c.total, idle: a.idle + c.idle, iowait: 0 }),
    { total: 0, idle: 0, iowait: 0 });
  return { all, cores };
}

const CPU_MODEL = (() => {
  try { return (os.cpus()[0]?.model || '').replace(/\s+/g, ' ').trim() || null; } catch { return null; }
})();

// null (not 0) when there is no window to measure across — the first sample after a
// cold start has nothing to diff, and drawing that as "0% busy" is a lie the chart
// would carry for its whole 10-minute window.
function busyFrac(prev, now) {
  if (!prev || !now) return null;
  const dt = now.total - prev.total;
  if (!(dt > 0)) return null;
  const di = now.idle - prev.idle;
  return Math.max(0, Math.min(1, (dt - di) / dt));
}

function sampleCpu() {
  const now = readCpuTimes() || readCpuTimesPortable();
  if (!now) return null;
  const prev = lastCpu;
  lastCpu = now;
  const dt = prev ? now.all.total - prev.all.total : 0;
  return {
    count: now.cores.length || 1,
    model: CPU_MODEL,
    usage: busyFrac(prev?.all, now.all),
    iowait: prev && dt > 0 ? Math.max(0, Math.min(1, (now.all.iowait - prev.all.iowait) / dt)) : null,
    // Index-matched to prev; a hotplugged core simply reports null until it has a window.
    cores: now.cores.map((c, i) => busyFrac(prev?.cores?.[i], c)),
  };
}

function sample() {
  const mi = readMeminfo();
  const cpu = sampleCpu();
  const load = os.loadavg();
  const memTotal = mi.MemTotal ?? os.totalmem();
  const memAvail = mi.MemAvailable ?? os.freemem();
  let disk = null;
  try {
    const st = fs.statfsSync(appsDir || os.homedir());
    disk = { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
  } catch { /* unknown free space is reported as unknown, never as OK */ }
  return {
    at: Date.now(),
    mem: { total: memTotal, available: memAvail, used: memTotal - memAvail },
    swap: mi.SwapTotal != null
      ? { total: mi.SwapTotal, used: mi.SwapTotal - (mi.SwapFree || 0) } : null,
    disk,
    load1: load[0],
    load5: load[1],
    load15: load[2],
    cpus: cpu?.count || os.cpus().length,
    cpu,
  };
}

// ------------------------------------------------------- process breakdown

// One read of /proc/<pid>/status per process gives name, parent and both memory
// figures — cheaper and less racy than shelling out to ps.
function scanProcesses() {
  const procs = new Map();
  let entries;
  try { entries = fs.readdirSync('/proc'); } catch { return procs; }
  for (const ent of entries) {
    if (!/^\d+$/.test(ent)) continue;
    const pid = Number(ent);
    let txt;
    // A PID that exits mid-scan is normal, not an error worth reporting.
    try { txt = fs.readFileSync(`/proc/${ent}/status`, 'utf8'); } catch { continue; }
    const name = /^Name:\s+(.*)$/m.exec(txt)?.[1] || '?';
    const ppid = Number(/^PPid:\s+(\d+)$/m.exec(txt)?.[1] ?? 0);
    const rssKb = /^VmRSS:\s+(\d+) kB$/m.exec(txt)?.[1];
    if (rssKb == null) continue;                    // kernel thread: no user memory
    const swapKb = /^VmSwap:\s+(\d+) kB$/m.exec(txt)?.[1] || '0';
    procs.set(pid, {
      pid, ppid, name,
      rss: Number(rssKb) * 1024,
      swap: Number(swapKb) * 1024,
      pss: null,
    });
  }
  return procs;
}

// PSS is the honest number — RSS counts every shared page in full for every
// process that maps it, so summing RSS across a process tree overstates badly
// (a browser with 30 renderers is the usual offender).
//
// It is also the only expensive part of this module: the whole /proc/*/status
// scan is ~5ms, while smaps_rollup costs the kernel 7-30ms PER process because it
// walks the address space. Hence two decisions: only the heaviest processes get
// refined (they are the only ones that can change the ranking), and the reads are
// async so the dashboard event loop — which is also every mounted app's event
// loop — is never held for a tenth of a second.
async function refinePss(procs) {
  const top = [...procs.values()].sort((a, b) => b.rss - a.rss).slice(0, SMAPS_TOP_N);
  for (const p of top) {
    try {
      const txt = await fs.promises.readFile(`/proc/${p.pid}/smaps_rollup`, 'utf8');
      const kb = /^Pss:\s+(\d+) kB$/m.exec(txt)?.[1];
      if (kb != null) p.pss = Number(kb) * 1024;
    } catch { /* not ours to read, or gone: RSS stands in */ }
  }
}

// Service managers are transparent: grouping by "topmost ancestor" alone puts the
// entire desktop session under `systemd --user` and reports one 8 GB blob called
// systemd, which tells an operator nothing. Stopping *below* these makes each
// service its own group — firefox, gnome-shell, Xvfb — which is the list people
// actually want. Their own (tiny) RSS still shows up as their own entry.
// Desktop shells belong here for the same reason: they LAUNCH the browser, they do
// not own its memory, and "gnome-shell: 3 GB" hides the browser that is actually
// eating the box. Note /proc names are truncated to 15 chars.
const TRANSPARENT_PARENTS = new Set([
  'systemd', 'init', 'containerd-shim', 'dumb-init', 'tini',
  'gnome-shell', 'gnome-session-b', 'plasmashell', 'xfce4-session', 'kwin_x11',
]);

// Walk up to the topmost ancestor still inside the scan. Anything whose parent is
// init/kernel, transparent, or already gone is its own root.
function treeRoot(pid, procs, stopAt) {
  let cur = pid;
  const seen = new Set();
  for (;;) {
    if (stopAt && stopAt.has(cur)) return cur;
    if (seen.has(cur)) return cur;               // cycle guard; /proc should never
    seen.add(cur);                               // produce one, but a bad read might
    const p = procs.get(cur);
    if (!p || p.ppid <= 1 || !procs.has(p.ppid)) return cur;
    if (TRANSPARENT_PARENTS.has(procs.get(p.ppid).name)) return cur;
    cur = p.ppid;
  }
}

function groupTotals(pids, procs) {
  let rss = 0, pss = 0, swap = 0, anyPss = false;
  for (const pid of pids) {
    const p = procs.get(pid);
    if (!p) continue;
    rss += p.rss;
    swap += p.swap;
    if (p.pss != null) { pss += p.pss; anyPss = true; } else { pss += p.rss; }
  }
  return { pids: pids.length, rss, pss: anyPss ? pss : null, swap };
}

async function computeBreakdown() {
  const procs = scanProcesses();
  await refinePss(procs);

  // App roots: own-process app children, plus anything an app launched through
  // the spawn bridge. In-process apps are absent by definition — they are threads
  // of this very process and get counted under the platform entry.
  const appRoots = new Map();                     // pid -> {app, kind}
  try {
    for (const a of (appManager?.list?.() || [])) {
      const running = appManager.getRunningApp?.(a.name);
      if (running?.pid) appRoots.set(running.pid, { app: a.name, kind: 'own-process' });
    }
  } catch { /* app list unavailable: attribution degrades to "other" */ }
  try {
    const tasks = require('./app-bridge').listTasks();
    for (const t of tasks.spawned || []) {
      if (t.pid) appRoots.set(t.pid, { app: t.appName, kind: 'task' });
    }
  } catch { /* same */ }

  const stops = new Set([...appRoots.keys(), process.pid]);
  const byOwner = new Map();                      // ownerPid -> pid[]
  for (const pid of procs.keys()) {
    const root = treeRoot(pid, procs, stops);
    if (!byOwner.has(root)) byOwner.set(root, []);
    byOwner.get(root).push(pid);
  }

  const apps = [];
  for (const [pid, meta] of appRoots) {
    const pids = byOwner.get(pid);
    if (!pids) continue;
    apps.push({ app: meta.app, kind: meta.kind, ...groupTotals(pids, procs) });
    byOwner.delete(pid);
  }
  apps.sort((a, b) => (b.pss ?? b.rss) - (a.pss ?? a.rss));

  // Mounted apps run inside the dashboard process; splitting them out would be a
  // fiction, so the entry says so plainly.
  const platformPids = byOwner.get(process.pid) || [process.pid];
  const platform = { label: 'dashboard (incl. mounted apps)', ...groupTotals(platformPids, procs) };
  byOwner.delete(process.pid);

  const other = [...byOwner.entries()]
    .map(([root, pids]) => ({ comm: procs.get(root)?.name || '?', ...groupTotals(pids, procs) }))
    .sort((a, b) => (b.pss ?? b.rss) - (a.pss ?? a.rss))
    .slice(0, OTHER_TOP_N);

  const attributedRss = platform.rss + apps.reduce((n, a) => n + a.rss, 0);
  return {
    at: Date.now(),
    platform,
    apps,
    other,
    totals: {
      scannedPids: procs.size,
      attributedRss,
      otherRss: other.reduce((n, o) => n + o.rss, 0),
    },
  };
}

// Single-flight: a tick and an on-demand call arriving together must not both walk
// /proc. Callers awaiting a compute already in progress get that one's result.
let inFlight = null;

async function breakdown({ maxAgeMs = BREAKDOWN_STALE_MS } = {}) {
  if (lastBreakdown && Date.now() - lastBreakdown.at < maxAgeMs) return lastBreakdown;
  if (inFlight) return inFlight;
  inFlight = computeBreakdown()
    .then((b) => { lastBreakdown = b; return b; })
    .finally(() => { inFlight = null; });
  return inFlight;
}

// ------------------------------------------------------------ tick + fanout

function pushRing(arr, item, max) {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

function fanout(data) {
  if (!broadcaster) return;
  for (const appName of subs.keys()) {
    broadcaster.broadcast({ type: 'app:bridge:event', appName, event: 'sysmon:sample', data });
  }
}

function tick() {
  const now = Date.now();
  for (const [name, until] of subs) if (until <= now) subs.delete(name);
  if (!subs.size) { stop(); return; }

  const s = sample();
  pushRing(history, s, HISTORY_MAX);
  fanout(s);

  // The breakdown is async and slower than a tick, so it rides its own schedule
  // and lands as a second event carrying the same latest sample. Clients dedupe
  // history by `at`, so the repeat costs nothing.
  if (tickCount % BREAKDOWN_EVERY === 0) {
    breakdown({ maxAgeMs: TICK_MS }).then((b) => {
      if (!b || breakdowns[breakdowns.length - 1] === b) return;
      pushRing(breakdowns, b, BREAKDOWN_MAX);
      if (subs.size) fanout({ ...s, processes: b });
    }).catch(() => { /* a failed scan skips a beat; the next tick retries */ });
  }
  tickCount++;
}

function start() {
  if (timer) return;
  tickCount = 0;
  timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  tick();                                       // first sample lands immediately
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

// -------------------------------------------------------------- public API

function subscribe(appName, ttlMs) {
  if (!appName) return { ok: false, error: 'appName required' };
  const ttl = Math.min(Math.max(Number(ttlMs) || TTL_DEFAULT, TICK_MS), TTL_MAX);
  const until = Date.now() + ttl;
  subs.set(appName, Math.max(subs.get(appName) || 0, until));
  start();
  return { ok: true, intervalMs: TICK_MS, until: subs.get(appName) };
}

function unsubscribe(appName) {
  subs.delete(appName);
  if (!subs.size) stop();
  return { ok: true };
}

async function get({ history: n = HISTORY_MAX, processes = false } = {}) {
  const count = Math.min(Math.max(Number(n) || 0, 0), HISTORY_MAX);
  // An unarmed service still answers with a live reading — a caller asking "how is
  // the box right now" should not have to subscribe first to find out.
  const latest = history.length ? history[history.length - 1] : sample();
  const out = {
    sample: latest,
    history: count ? history.slice(-count) : [],
    breakdowns: breakdowns.slice(),
    armed: !!timer,
    intervalMs: TICK_MS,
  };
  if (processes) out.processes = await breakdown();
  return out;
}

function removeApp(appName) {
  if (!subs.has(appName)) return;
  subs.delete(appName);
  if (!subs.size) stop();
}

function init(options = {}) {
  appsDir = options.appsDir || null;
  appManager = options.appManager || null;
  broadcaster = options.broadcaster || null;
}

function shutdown() {
  stop();
  subs.clear();
  history = [];
  breakdowns = [];
  lastBreakdown = null;
  lastCpu = null;
}

// ------------------------------------------------------- pressure watch
// Host pressure as a state with hysteresis (Horst's sysmon:pressure /
// sysmon:recovered senses): enter when ANY threshold trips, leave only when
// ALL are clear, one transition per change. Pure evaluate() + a tracker so
// tests feed synthetic samples; watchPressure() runs it on its own slow clock.
const PRESSURE = {
  memAvailFrac: 0.10,   // available memory below 10 % of total
  diskFreeFrac: 0.10,   // free disk below 10 %
  loadPerCpu: 2.0,      // 1-min load above 2× cpu count
};
const PRESSURE_INTERVAL_MS = 60 * 1000;

function evaluatePressure(s) {
  const reasons = [];
  if (s?.mem?.total && s.mem.available / s.mem.total < PRESSURE.memAvailFrac) {
    reasons.push({ kind: 'memory', detail: `${Math.round((s.mem.available / s.mem.total) * 100)}% available` });
  }
  if (s?.disk?.total && s.disk.free / s.disk.total < PRESSURE.diskFreeFrac) {
    reasons.push({ kind: 'disk', detail: `${Math.round((s.disk.free / s.disk.total) * 100)}% free` });
  }
  if (s?.cpus && typeof s.load1 === 'number' && s.load1 > s.cpus * PRESSURE.loadPerCpu) {
    reasons.push({ kind: 'load', detail: `load ${s.load1.toFixed(2)} on ${s.cpus} cpu(s)` });
  }
  return reasons;
}

// tracker.feed(sample) → null | { state: 'pressure'|'recovered', reasons, sample }
function pressureTracker() {
  let under = false;
  return {
    feed(s) {
      const reasons = evaluatePressure(s);
      if (!under && reasons.length) { under = true; return { state: 'pressure', reasons, sample: s }; }
      if (under && !reasons.length) { under = false; return { state: 'recovered', reasons: [], sample: s }; }
      return null;
    },
    get underPressure() { return under; },
  };
}

function watchPressure({ onChange, intervalMs = PRESSURE_INTERVAL_MS, sampler = sample } = {}) {
  const tracker = pressureTracker();
  const check = () => {
    let s;
    try { s = sampler(); } catch { return; }
    const change = tracker.feed(s);
    if (change) { try { onChange(change); } catch (err) { console.warn('[sysmon] pressure observer failed:', err.message); } }
  };
  const t = setInterval(check, intervalMs);
  t.unref?.();
  return () => clearInterval(t);
}

module.exports = {
  init, shutdown,
  subscribe, unsubscribe, get, processes: breakdown, removeApp,
  // exported for tests / direct platform use
  sample, computeBreakdown,
  evaluatePressure, pressureTracker, watchPressure, PRESSURE,
};
