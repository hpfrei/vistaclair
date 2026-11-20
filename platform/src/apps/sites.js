'use strict';
// Sites engine (docs/sites.md): each site of an app is its own web-server
// process (platform/site-runner.js), a CHILD of the dashboard. No keeper: the
// fork IPC pipe is the control channel, the runner exits when it closes, and
// boot autostarts them again. This module is the one implementation of every
// site duty — ctx.sites, the Bridge, the governance kinds, the owner's Sites
// tab, the byte-proxy and federation all call it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const net = require('net');
const { validateSites, validPort, SITE_NAME_RE, BINDS, RESERVED_PORTS } = require('./sites-manifest');
const ports = require('./sites-ports');

const RUNNER = path.join(__dirname, '..', '..', 'site-runner.js');
const HOST_FILE = '.sites.json';            // per-host: port, bind, autostart, keep, domain (CODE_PRESERVE)
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000];
const STABLE_MS = 60000;                     // up this long → the backoff resets
const READY_TIMEOUT_MS = 15000;
const STOP_GRACE_MS = 3000;
const LOG_LINES = 400;
const CRASH_KEEP = 20;
const KEEP_DEFAULT = 5;
const KEEP_MAX = 50;
const CALL_ARGS_MAX = 64 * 1024;
const CALL_RESULT_MAX = 256 * 1024;
const CALL_TIMEOUT_MAX = 30000;
const CALL_RATE = { max: 60, windowMs: 60000 };   // per site, per client /24 (IPv4) or /64 (IPv6)
const SNAPSHOT_MAX_FILES = 50000;
// The fence (Node's permission model): --permission is unflagged from 22.13 / 23.5.
const FENCE_MIN_NODE = 'v22.13.0';

let opts = { broadcast: null, dashboardPort: null, proxyPort: null };
const runtimes = new Map();     // 'app/site' → runtime record
const callHandlers = new Map(); // app → Map(name → fn)
const listeners = new Set();    // fn({ kind, app, site, data })
const callHits = new Map();     // 'app/site|prefix' → [timestamps]
let exitHooked = false;

function appManager() { return require('./app-manager'); }

function init(o = {}) {
  opts = { ...opts, ...o };
  if (!exitHooked) {
    exitHooked = true;
    // Belt and braces next to the runner's own disconnect exit: a dashboard
    // that exits takes every site with it, synchronously.
    process.on('exit', () => { for (const rt of runtimes.values()) { try { rt.child?.kill('SIGKILL'); } catch { /* gone */ } } });
  }
}

function broadcast(msg) { try { opts.broadcast?.(msg); } catch { /* no dashboard */ } }
function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// ── identity ──────────────────────────────────────────────────────────────
function appsDir() { return appManager().APPS_DIR; }
function ownerId() { return crypto.createHash('sha256').update(path.resolve(appsDir())).digest('hex').slice(0, 16); }
function hostNonce() {
  const f = path.join(appsDir(), '.sites-host-id');
  try { const v = fs.readFileSync(f, 'utf8').trim(); if (/^[0-9a-f]{32,}$/.test(v)) return v; } catch { /* first use */ }
  const v = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, v + '\n', { mode: 0o600 });
  return v;
}
// What /_vc/id answers: proves a domain reaches THIS host's site without naming it.
function idToken(app, site) { return crypto.createHmac('sha256', hostNonce()).update(`${app}/${site}`).digest('hex').slice(0, 32); }

function fenceAvailable() {
  try { return process.allowedNodeEnvironmentFlags.has('--permission'); } catch { return false; }
}

// ── definitions ───────────────────────────────────────────────────────────
function reservedPorts() {
  return [...new Set([...RESERVED_PORTS, opts.dashboardPort, opts.proxyPort].filter(p => Number.isInteger(p)))];
}
function appDirOf(app) { return appManager().appDir(app); }
function siteRoot(app, site) { return path.join(appDirOf(app), '.data', 'sites', site); }
function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }
function writeJsonAtomic(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, f);
}

// The app's declared sites (validated) → { sites, errors }.
function declared(app) {
  let manifest = null;
  try { manifest = appManager().readManifest(app); } catch { /* bad name */ }
  if (!manifest || !manifest.sites) return { sites: {}, errors: [] };
  const r = validateSites(manifest.sites, { appDir: appDirOf(app), reservedPorts: reservedPorts() });
  return { sites: r.sites, errors: r.errors };
}
function hostRecord(app) { const r = readJson(path.join(appDirOf(app), HOST_FILE), {}); return r && typeof r === 'object' ? r : {}; }

// Manifest defaults + this host's record.
function effective(app, site) {
  const d = declared(app);
  const def = d.sites[site];
  if (!def) {
    const why = d.errors.find(e => e.startsWith(`sites.${site}:`) || e.startsWith(`sites.${site}.`));
    const err = new Error(why ? `site ${app}/${site} is invalid: ${why}` : `app "${app}" declares no site "${site}"`);
    err.code = why ? 'invalid' : 'unknown_site';
    throw err;
  }
  const rec = hostRecord(app)[site] || {};
  return {
    ...def,
    port: validPort(rec.port) ? rec.port : def.defaultPort,
    bind: BINDS.includes(rec.bind) ? rec.bind : def.bind,
    autostart: typeof rec.autostart === 'boolean' ? rec.autostart : def.autostart,
    keep: Number.isInteger(rec.keep) && rec.keep >= 1 && rec.keep <= KEEP_MAX ? rec.keep : KEEP_DEFAULT,
    domain: typeof rec.domain === 'string' && rec.domain ? rec.domain : null,
  };
}

function appsWithSites() {
  let names = [];
  try { names = fs.readdirSync(appsDir()); } catch { return []; }
  return names.filter(n => !n.startsWith('.') && appManager().isValidAppName?.(n) !== false
    && fs.existsSync(path.join(appsDir(), n, 'manifest.json'))).filter(n => Object.keys(declared(n).sites).length);
}

// Who else on this host uses `port`: another site (any app) or a reserved port.
function portOwner(port, exceptKey) {
  if (reservedPorts().includes(port)) return 'the dashboard or the proxy';
  for (const app of appsWithSites()) {
    for (const site of Object.keys(declared(app).sites)) {
      const key = `${app}/${site}`;
      if (key === exceptKey) continue;
      let eff;
      try { eff = effective(app, site); } catch { continue; }
      if (eff.port === port) return `the site ${key}`;
    }
  }
  return null;
}

// ── runtime records ───────────────────────────────────────────────────────
function rtOf(app, site) {
  const key = `${app}/${site}`;
  let rt = runtimes.get(key);
  if (!rt) {
    let saved = { crashCount: 0, crashes: [] };
    try { saved = readJson(path.join(siteRoot(app, site), 'crashes.json'), saved) || saved; } catch { /* no app dir */ }
    rt = {
      key, app, site, child: null, state: 'stopped', pid: null, port: null, bind: null,
      startedAt: null, readyAt: null, fenced: null, lastError: null,
      crashCount: saved.crashCount || 0, crashes: Array.isArray(saved.crashes) ? saved.crashes : [],
      backoffIdx: 0, timer: null, stableTimer: null, nextRetryAt: null,
      stopping: false, wanted: false, startPromise: null,
      stats: { reqs: 0, errs: 0, rss: null, at: 0 }, rate: 0,
      logs: [], logBatch: [], logTimer: null, lastFatal: null, lastStderr: '', codeHash: null,
      pending: new Map(), contentWaiters: new Map(),
    };
    runtimes.set(key, rt);
  }
  return rt;
}

function status(app, site) {
  const rt = rtOf(app, site);
  let eff = null, invalid = null;
  try { eff = effective(app, site); } catch (e) { invalid = e.message; }
  const active = activeSnapshot(app, site);
  return {
    app, site,
    state: rt.state,
    pid: rt.pid,
    port: rt.child ? rt.port : (eff ? eff.port : null),
    bind: rt.child ? rt.bind : (eff ? eff.bind : null),
    autostart: eff ? eff.autostart : null,
    access: eff ? eff.access : null,
    platform: eff ? eff.platform : null,
    keep: eff ? eff.keep : null,
    domain: eff ? eff.domain : null,
    defaultPort: eff ? eff.defaultPort : null,
    startedAt: rt.readyAt,
    uptimeMs: rt.child && rt.readyAt ? Date.now() - rt.readyAt : 0,
    mem: rt.child ? rt.stats.rss : null,
    reqPerSec: rt.child ? Math.round(rt.rate * 10) / 10 : 0,
    requests: rt.child ? rt.stats.reqs : 0,
    lastError: invalid || rt.lastError,
    crashCount: rt.crashCount,
    nextRetryAt: rt.nextRetryAt,
    fenced: rt.fenced,
    fence: rt.fenced === null ? (fenceAvailable() ? 'fenced' : 'unfenced') : (rt.fenced ? 'fenced' : 'unfenced'),
    snapshot: active,
  };
}

function list(app) { return Object.keys(declared(app).sites).map(s => status(app, s)); }
function crashes(app, site) { return rtOf(app, site).crashes.slice().reverse(); }
function logs(app, site, n = 200) { return rtOf(app, site).logs.slice(-Math.max(1, Math.min(LOG_LINES, n))); }

// ── events ────────────────────────────────────────────────────────────────
function emit(rt, kind, data = {}) {
  const st = status(rt.app, rt.site);
  const payload = { app: rt.app, site: rt.site, ...data, status: st };
  // the app's iframe (Bridge.subscribe), the owner's dashboard, then the bus (capability senses)
  broadcast({ type: 'app:bridge:event', appName: rt.app, event: kind, data: payload });
  broadcast({ type: 'app:site', appName: rt.app, site: rt.site, event: kind, status: st, data });
  for (const fn of listeners) { try { fn({ kind, app: rt.app, site: rt.site, data: payload }); } catch { /* a listener */ } }
}
function setState(rt, state, extra) {
  rt.state = state;
  emit(rt, 'site:status', extra);
}

const lastToast = new Map();
function notifyOwner(rt, title, message) {
  const now = Date.now();
  if (now - (lastToast.get(rt.key) || 0) < 60000) return;
  lastToast.set(rt.key, now);
  broadcast({ type: 'toast:push', sender: rt.app, level: 'error', title, message, ts: now });
}

function pushLog(rt, level, text) {
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const entry = { t: Date.now(), level, text: line.slice(0, 1000) };
    rt.logs.push(entry);
    if (rt.logs.length > LOG_LINES) rt.logs.splice(0, rt.logs.length - LOG_LINES);
    if (rt.logBatch.length < 200) rt.logBatch.push(entry);
    if (level === 'err' || level === 'error') rt.lastStderr = entry.text;
  }
  if (!rt.logTimer && rt.logBatch.length) {
    rt.logTimer = setTimeout(() => {
      rt.logTimer = null;
      const lines = rt.logBatch.splice(0);
      if (lines.length) broadcast({ type: 'app:site:log', appName: rt.app, site: rt.site, lines });
    }, 300);
    rt.logTimer.unref?.();
  }
}

function saveCrashes(rt) {
  try { writeJsonAtomic(path.join(siteRoot(rt.app, rt.site), 'crashes.json'), { crashCount: rt.crashCount, crashes: rt.crashes.slice(-CRASH_KEEP) }); } catch { /* app gone */ }
}

// ── code hash: handler dir + package-lock + runner ─────────────────────────
function hashDir(h, dir, rel = '') {
  let entries = [];
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const r = path.join(rel, e.name);
    if (e.isDirectory()) hashDir(h, dir, r);
    else if (e.isFile()) { h.update(r + '\0'); try { h.update(fs.readFileSync(path.join(dir, r))); } catch { /* raced */ } }
  }
}
function codeHash(app, site) {
  const eff = effective(app, site);
  const h = crypto.createHash('sha256');
  const dir = appDirOf(app);
  hashDir(h, path.join(dir, path.dirname(eff.handler)));
  h.update('\0lock\0');
  try { h.update(fs.readFileSync(path.join(dir, 'package-lock.json'))); } catch { /* none */ }
  h.update('\0runner\0');
  try { h.update(fs.readFileSync(RUNNER)); } catch { /* impossible */ }
  return h.digest('hex');
}

// ── snapshots ─────────────────────────────────────────────────────────────
function snapshotsDir(app, site) { return path.join(siteRoot(app, site), 'snapshots'); }
function activeSnapshot(app, site) {
  let a;
  try { a = readJson(path.join(siteRoot(app, site), 'active.json'), null); } catch { return null; }
  if (!a || typeof a.id !== 'string') return null;
  return a.id;
}
function activeDir(app, site) {
  const id = activeSnapshot(app, site);
  if (!id) return null;
  const d = path.join(snapshotsDir(app, site), id);
  return fs.existsSync(d) ? d : null;
}
function snapshots(app, site) {
  effective(app, site);
  const dir = snapshotsDir(app, site);
  const active = activeSnapshot(app, site);
  let ids = [];
  try { ids = fs.readdirSync(dir).filter(n => /^[0-9a-z]+-[0-9a-f]{6}$/.test(n)); } catch { /* none yet */ }
  return ids.map(id => {
    const meta = readJson(path.join(dir, id, '.vc-snapshot.json'), {}) || {};
    return { id, at: meta.at || null, note: meta.note || '', files: meta.files || 0, bytes: meta.bytes || 0, active: id === active };
  }).sort((a, b) => (b.at || 0) - (a.at || 0) || (a.id < b.id ? 1 : -1));
}

function copyTree(src, dst, acc) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isSymbolicLink()) { acc.skipped++; continue; }            // never follow a link out of the tree
    if (e.isDirectory()) copyTree(s, d, acc);
    else if (e.isFile()) {
      if (++acc.files > SNAPSHOT_MAX_FILES) throw Object.assign(new Error(`a snapshot holds at most ${SNAPSHOT_MAX_FILES} files`), { code: 'too_large' });
      fs.copyFileSync(s, d, fs.constants.COPYFILE_FICLONE);           // reflink where the fs can, else a copy (never a hardlink: an in-place edit would change the snapshot)
      acc.bytes += fs.statSync(d).size;
    }
  }
}

async function tellContent(rt, dir, id) {
  if (!rt.child) return;
  await new Promise((resolve) => {
    const t = setTimeout(() => { rt.contentWaiters.delete(id); resolve(); }, 2000);
    rt.contentWaiters.set(id, () => { clearTimeout(t); resolve(); });
    try { rt.child.send({ t: 'content', dir, id }); } catch { clearTimeout(t); resolve(); }
  });
}

async function activate(app, site, id) {
  const dir = path.join(snapshotsDir(app, site), id);
  writeJsonAtomic(path.join(siteRoot(app, site), 'active.json'), { id, at: Date.now() });
  await tellContent(rtOf(app, site), dir, id);
}

function prune(app, site, keep) {
  const active = activeSnapshot(app, site);
  const all = snapshots(app, site);
  // `keep` in total: the active one always, then the newest others
  let kept = all.some(s => s.id === active) ? 1 : 0;
  for (const s of all) {
    if (s.id === active) continue;
    if (kept < keep) { kept++; continue; }
    try { fs.rmSync(path.join(snapshotsDir(app, site), s.id), { recursive: true, force: true }); } catch { /* busy */ }
  }
}

// Copy `dir` into a new snapshot and make it active (no restart).
async function publish(app, site, dir, { note = '' } = {}) {
  const eff = effective(app, site);
  const src = path.resolve(String(dir || ''));
  let st;
  try { st = fs.statSync(src); } catch { st = null; }
  if (!st || !st.isDirectory()) throw Object.assign(new Error(`publish: ${dir} is not a directory`), { code: 'bad_dir' });
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const base = snapshotsDir(app, site);
  const tmp = path.join(base, `.tmp-${id}`);
  const acc = { files: 0, bytes: 0, skipped: 0 };
  try {
    copyTree(src, tmp, acc);
    fs.writeFileSync(path.join(tmp, '.vc-snapshot.json'), JSON.stringify({ id, at: Date.now(), note: String(note).slice(0, 200), files: acc.files, bytes: acc.bytes }));
    fs.renameSync(tmp, path.join(base, id));
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    throw e;
  }
  await activate(app, site, id);
  prune(app, site, eff.keep);
  const rt = rtOf(app, site);
  pushLog(rt, 'info', `published snapshot ${id} (${acc.files} files${acc.skipped ? `, ${acc.skipped} symlinks skipped` : ''})`);
  emit(rt, 'site:published', { id, note: String(note).slice(0, 200), files: acc.files, bytes: acc.bytes, rollback: false });
  return { id, files: acc.files, bytes: acc.bytes, skipped: acc.skipped };
}

async function rollback(app, site, id) {
  effective(app, site);
  if (typeof id !== 'string' || !/^[0-9a-z]+-[0-9a-f]{6}$/.test(id) || !fs.existsSync(path.join(snapshotsDir(app, site), id))) {
    throw Object.assign(new Error(`no snapshot "${id}" for ${app}/${site}`), { code: 'unknown_snapshot' });
  }
  const t0 = Date.now();
  await activate(app, site, id);
  const rt = rtOf(app, site);
  pushLog(rt, 'info', `rolled back to snapshot ${id}`);
  emit(rt, 'site:published', { id, rollback: true });
  return { id, ms: Date.now() - t0 };
}

// ── live site.config (the app's settings for its handler) ──────────────────
function getConfig(app, site) { effective(app, site); return readJson(path.join(siteRoot(app, site), 'config.json'), {}) || {}; }
function setConfig(app, site, obj) {
  effective(app, site);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw Object.assign(new Error('config must be an object'), { code: 'bad_config' });
  const json = JSON.stringify(obj);
  if (Buffer.byteLength(json) > CALL_ARGS_MAX) throw Object.assign(new Error('config exceeds 64 KB'), { code: 'too_large' });
  writeJsonAtomic(path.join(siteRoot(app, site), 'config.json'), JSON.parse(json));
  const rt = rtOf(app, site);
  try { rt.child?.send({ t: 'config', config: JSON.parse(json) }); } catch { /* restarting */ }
  return JSON.parse(json);
}

// ── host settings (the owner's Configure on THIS host) ─────────────────────
const HOST_KEYS = ['port', 'bind', 'autostart', 'keep', 'domain'];
async function hostSettings(app, site, patch = {}) {
  const before = effective(app, site);
  const key = `${app}/${site}`;
  const next = {};
  for (const k of Object.keys(patch || {})) if (!HOST_KEYS.includes(k)) throw Object.assign(new Error(`unknown setting "${k}" (${HOST_KEYS.join(', ')})`), { code: 'bad_setting' });
  if (patch.port !== undefined) {
    const p = Number(patch.port);
    if (!validPort(p)) throw Object.assign(new Error('port: an integer 1024–65535'), { code: 'bad_port' });
    const who = portOwner(p, key);
    if (who) throw Object.assign(new Error(`port ${p} is already used by ${who} on this host`), { code: 'port_taken' });
    next.port = p;
  }
  if (patch.bind !== undefined) {
    if (!BINDS.includes(patch.bind)) throw Object.assign(new Error('bind: "127.0.0.1" or "0.0.0.0"'), { code: 'bad_bind' });
    next.bind = patch.bind;
  }
  if (patch.autostart !== undefined) next.autostart = !!patch.autostart;
  if (patch.keep !== undefined) {
    const k = Number(patch.keep);
    if (!Number.isInteger(k) || k < 1 || k > KEEP_MAX) throw Object.assign(new Error(`keep: 1–${KEEP_MAX} snapshots`), { code: 'bad_keep' });
    next.keep = k;
  }
  if (patch.domain !== undefined) {
    const d = patch.domain ? appManager().normalizeDomain(patch.domain) : null;
    if (patch.domain && !d) throw Object.assign(new Error('domain: a bare hostname like www.example.com'), { code: 'bad_domain' });
    next.domain = d;
  }
  const file = path.join(appDirOf(app), HOST_FILE);
  const rec = hostRecord(app);
  rec[site] = { ...(rec[site] || {}), ...next };
  if (rec[site].domain === null) delete rec[site].domain;
  writeJsonAtomic(file, rec);
  const after = effective(app, site);
  if (next.keep !== undefined) prune(app, site, after.keep);
  const rt = rtOf(app, site);
  // A failed restart (e.g. the new port is held) is the site's state, not a refused setting.
  if (rt.child && (after.port !== before.port || after.bind !== before.bind)) await restart(app, site).catch(() => {});
  else emit(rt, 'site:status');
  return status(app, site);
}

// ── start / stop ──────────────────────────────────────────────────────────
function childEnv(app, site, eff) {
  const env = {
    VC_SITE_APP: app,
    VC_SITE_NAME: site,
    VC_SITE_KEY: `${app}/${site}`,
    VC_SITE_OWNER: ownerId(),
    VC_SITE_PORT: String(eff.port),
    VC_SITE_BIND: eff.bind,
    VC_SITE_HANDLER: path.join(appDirOf(app), eff.handler),
    VC_SITE_DATA: path.join(siteRoot(app, site), 'data'),
    VC_SITE_ID: idToken(app, site),
    VC_SITE_PLATFORM: eff.platform,
    NODE_ENV: 'production',
  };
  for (const k of ['TZ', 'LANG', 'LC_ALL']) if (process.env[k]) env[k] = process.env[k];
  return env;
}

function fenceArgs(app, site, eff) {
  if (!fenceAvailable()) return null;
  const dir = appDirOf(app);
  const root = siteRoot(app, site);
  return [
    '--permission',
    `--allow-fs-read=${RUNNER}`,
    `--allow-fs-read=${path.join(dir, path.dirname(eff.handler))}`,
    `--allow-fs-read=${path.join(dir, 'node_modules')}`,
    `--allow-fs-read=${path.join(dir, 'package.json')}`,
    `--allow-fs-read=${root}`,
    `--allow-fs-write=${path.join(root, 'data')}`,
  ];
}

function spawnRunner(rt, eff) {
  const { app, site } = rt;
  fs.mkdirSync(path.join(siteRoot(app, site), 'data'), { recursive: true });
  fs.mkdirSync(snapshotsDir(app, site), { recursive: true });
  const fence = fenceArgs(app, site, eff);
  const child = cp.fork(RUNNER, [], {
    execPath: process.execPath,
    execArgv: fence || [],
    env: childEnv(app, site, eff),
    cwd: '/',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'json',
  });
  rt.child = child;
  rt.pid = child.pid;
  rt.port = eff.port;
  rt.bind = eff.bind;
  rt.startedAt = Date.now();
  rt.readyAt = null;
  rt.lastFatal = null;
  rt.lastStderr = '';
  rt.fenced = null;
  rt.stats = { reqs: 0, errs: 0, rss: null, at: Date.now() };
  rt.rate = 0;
  try { rt.codeHash = codeHash(app, site); } catch { rt.codeHash = null; }
  const lineSplitter = (level) => {
    let buf = '';
    return (chunk) => {
      buf += chunk.toString('utf8');
      const parts = buf.split('\n');
      buf = parts.pop();
      if (buf.length > 4000) { parts.push(buf); buf = ''; }
      for (const p of parts) pushLog(rt, level, p);
    };
  };
  child.stdout.on('data', lineSplitter('out'));
  child.stderr.on('data', lineSplitter('err'));
  child.on('message', (m) => onChildMessage(rt, child, m));
  child.on('error', (e) => { rt.lastFatal = rt.lastFatal || { code: 'spawn', message: e.message }; });
  child.send({ t: 'init', config: readJson(path.join(siteRoot(app, site), 'config.json'), {}) || {}, content: activeDir(app, site), snapshot: activeSnapshot(app, site) });
  return child;
}

function onChildMessage(rt, child, m) {
  if (!m || typeof m !== 'object' || rt.child !== child) return;
  switch (m.t) {
    case 'ready': {
      rt.readyAt = Date.now();
      rt.fenced = !!m.fenced;
      rt.lastFatal = null;
      rt.nextRetryAt = null;
      rt.lastError = null;
      clearTimeout(rt.stableTimer);
      rt.stableTimer = setTimeout(() => { rt.backoffIdx = 0; }, STABLE_MS);
      rt.stableTimer.unref?.();
      pushLog(rt, 'info', `listening on ${rt.bind}:${m.port} (${rt.fenced ? 'fenced' : 'unfenced'}, node ${m.node})`);
      rt.onReady?.();
      setState(rt, 'running');
      break;
    }
    case 'fatal': rt.lastFatal = { code: m.code, message: String(m.message || '') }; pushLog(rt, 'error', m.message); break;
    case 'log': pushLog(rt, m.level === 'error' ? 'error' : m.level === 'warn' ? 'warn' : 'info', m.text); break;
    case 'stats': {
      const now = Date.now();
      const dt = (now - rt.stats.at) / 1000;
      if (dt > 0) rt.rate = Math.max(0, (Number(m.reqs) - rt.stats.reqs) / dt);
      rt.stats = { reqs: Number(m.reqs) || 0, errs: Number(m.errs) || 0, rss: Number(m.rss) || null, at: now };
      break;
    }
    case 'contentAck': { const w = rt.contentWaiters.get(m.id); if (w) { rt.contentWaiters.delete(m.id); w(); } break; }
    case 'call': handleCall(rt, child, m); break;
    default: break;
  }
}

function onExit(rt, child, code, signal) {
  if (rt.child !== child) return;
  const wasReady = !!rt.readyAt;
  rt.child = null;
  rt.pid = null;
  clearTimeout(rt.stableTimer);
  for (const w of rt.contentWaiters.values()) w();
  rt.contentWaiters.clear();
  if (rt.stopping) {
    rt.stopping = false;
    pushLog(rt, 'info', 'stopped');
    setState(rt, 'stopped');
    return;
  }
  const reason = rt.lastFatal?.message || rt.lastStderr || `the runner exited (${signal ? `signal ${signal}` : `code ${code}`})`;
  if (!wasReady) {
    rt.lastError = reason;
    rt.onStartFailed?.(Object.assign(new Error(reason), { code: rt.lastFatal?.code || 'start_failed' }));
    if (rt.wanted && rt.inCrashCycle) return scheduleRestart(rt);
    rt.wanted = false;
    setState(rt, 'error');
    return;
  }
  rt.crashCount++;
  rt.crashes.push({ at: Date.now(), code, signal, error: reason.slice(0, 500), uptimeMs: Date.now() - rt.readyAt });
  if (rt.crashes.length > CRASH_KEEP) rt.crashes.splice(0, rt.crashes.length - CRASH_KEEP);
  rt.lastError = reason;
  saveCrashes(rt);
  pushLog(rt, 'error', `crashed: ${reason}`);
  rt.state = 'crashed';
  emit(rt, 'site:crashed', { code, signal, error: reason.slice(0, 500), crashCount: rt.crashCount });
  notifyOwner(rt, `Site ${rt.key} crashed`, `${reason.slice(0, 200)} — restarting`);
  if (rt.wanted) scheduleRestart(rt);
}

function scheduleRestart(rt) {
  clearTimeout(rt.timer);
  const delay = BACKOFF_MS[Math.min(rt.backoffIdx, BACKOFF_MS.length - 1)];
  rt.backoffIdx++;
  rt.nextRetryAt = Date.now() + delay;
  rt.inCrashCycle = true;
  setState(rt, 'backoff');
  rt.timer = setTimeout(() => {
    rt.timer = null;
    if (!rt.wanted) return;
    doStart(rt).catch(() => { /* onExit schedules the next try while inCrashCycle */ });
  }, delay);
  rt.timer.unref?.();
}

function doStart(rt) {
  if (rt.child && rt.readyAt) return Promise.resolve(status(rt.app, rt.site));
  if (rt.startPromise) return rt.startPromise;
  rt.startPromise = (async () => {
    const eff = effective(rt.app, rt.site);
    const who = portOwner(eff.port, rt.key);
    if (who) throw Object.assign(new Error(`port ${eff.port} is also assigned to ${who} — change one of them in Sites`), { code: 'port_taken' });
    setState(rt, 'starting');
    const note = await ports.ensureFree(eff.port, { bind: eff.bind, key: rt.key, owner: ownerId(), runnerPath: RUNNER });
    if (note) pushLog(rt, 'warn', note);
    const child = spawnRunner(rt, eff);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        rt.onReady = rt.onStartFailed = null;
        reject(Object.assign(new Error(`the site did not start listening within ${READY_TIMEOUT_MS / 1000} s`), { code: 'timeout' }));
        try { child.kill('SIGKILL'); } catch { /* gone */ }
      }, READY_TIMEOUT_MS);
      rt.onReady = () => { clearTimeout(t); rt.onReady = rt.onStartFailed = null; resolve(); };
      rt.onStartFailed = (e) => { clearTimeout(t); rt.onReady = rt.onStartFailed = null; reject(e); };
      child.once('exit', (code, signal) => onExit(rt, child, code, signal));
    });
    rt.inCrashCycle = false;
    return status(rt.app, rt.site);
  })().catch((e) => {
    if (!rt.child) {
      rt.lastError = e.message;
      if (!(rt.wanted && rt.inCrashCycle)) { rt.wanted = false; if (rt.state !== 'error') setState(rt, 'error'); }
      else if (rt.state !== 'backoff') scheduleRestart(rt);
    }
    throw e;
  }).finally(() => { rt.startPromise = null; });
  return rt.startPromise;
}

async function start(app, site) {
  effective(app, site);
  if (opts.isEnabled && !opts.isEnabled(app)) throw Object.assign(new Error(`app "${app}" is disabled on this host`), { code: 'disabled' });
  const rt = rtOf(app, site);
  rt.wanted = true;
  if (rt.timer) { clearTimeout(rt.timer); rt.timer = null; }
  rt.inCrashCycle = false;
  rt.backoffIdx = 0;
  return doStart(rt);
}

async function stop(app, site) {
  const rt = rtOf(app, site);
  rt.wanted = false;
  rt.inCrashCycle = false;
  if (rt.timer) { clearTimeout(rt.timer); rt.timer = null; }
  rt.nextRetryAt = null;
  if (rt.startPromise) await rt.startPromise.catch(() => {});
  const child = rt.child;
  if (!child) {
    if (rt.state !== 'stopped') setState(rt, 'stopped');
    return status(app, site);
  }
  rt.stopping = true;
  setState(rt, 'stopping');
  await new Promise((resolve) => {
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, STOP_GRACE_MS);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    try { child.send({ t: 'stop' }); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  });
  return status(app, site);
}

async function restart(app, site) {
  await stop(app, site);
  return start(app, site);
}

// Boot: every declared site whose (host) autostart is on.
async function autostartApp(app) {
  if (opts.isEnabled && !opts.isEnabled(app)) return;
  const out = [];
  for (const site of Object.keys(declared(app).sites)) {
    let eff;
    try { eff = effective(app, site); } catch { continue; }
    if (!eff.autostart) continue;
    out.push(start(app, site).catch((e) => console.warn(`[sites] autostart ${app}/${site}: ${e.message}`)));
  }
  await Promise.allSettled(out);
}
async function autostartAll() {
  await Promise.allSettled(appsWithSites().map(autostartApp));
}

async function stopApp(app) {
  const keys = [...runtimes.values()].filter(rt => rt.app === app);
  await Promise.allSettled(keys.map(rt => stop(rt.app, rt.site)));
}

// Uninstall: stop and forget.
async function removeApp(app) {
  await stopApp(app);
  for (const [k, rt] of runtimes) if (rt.app === app) runtimes.delete(k);
  callHandlers.delete(app);
}

async function stopAll() {
  await Promise.allSettled([...runtimes.values()].map(rt => stop(rt.app, rt.site)));
}

// After a code deploy / rollback swapped the app dir: restart a site only when
// hash(handler dir + package-lock + runner) changed; stop removed sites; start
// new autostart sites. Paths are strings against <appsDir>/<app>, so they
// resolve against the new dir.
async function afterCodeSwap(app) {
  const now = declared(app).sites;
  const out = { restarted: [], stopped: [], started: [], kept: [] };
  for (const rt of [...runtimes.values()].filter(r => r.app === app)) {
    if (!now[rt.site]) { if (rt.child || rt.wanted) { await stop(app, rt.site); out.stopped.push(rt.site); } }
  }
  for (const site of Object.keys(now)) {
    const rt = rtOf(app, site);
    let eff;
    try { eff = effective(app, site); } catch { continue; }
    if (rt.child) {
      let h = null;
      try { h = codeHash(app, site); } catch { /* invalid */ }
      if (h !== rt.codeHash) { await restart(app, site).catch(() => {}); out.restarted.push(site); } else out.kept.push(site);
    } else if (eff.autostart && rt.state !== 'error') {
      await start(app, site).catch(() => {});
      out.started.push(site);
    }
  }
  return out;
}

// Publish health: every autostart site of the app must be running.
function health(app) {
  const sites = list(app);
  const down = sites.filter(s => s.autostart && s.state !== 'running');
  return { ok: down.length === 0, sites: sites.map(s => ({ site: s.site, state: s.state, port: s.port, crashCount: s.crashCount, fence: s.fence, lastError: s.lastError })), down: down.map(s => s.site) };
}

// The fleet snapshot's per-app summary (compact).
function summary(app) {
  try { return list(app).map(s => ({ site: s.site, state: s.state, port: s.port, crashCount: s.crashCount, fence: s.fence })); } catch { return []; }
}

// The byte-proxy's lookup: a running public site, or null.
function proxyTarget(app, site) {
  if (!SITE_NAME_RE.test(String(site)) || !runtimes.has(`${app}/${site}`)) return null;
  const rt = runtimes.get(`${app}/${site}`);
  if (!rt.child || !rt.readyAt) return null;
  let eff;
  try { eff = effective(app, site); } catch { return null; }
  if (eff.access !== 'public') return null;
  return { port: rt.port };
}

// ── site.call (platform: "controlled") ─────────────────────────────────────
function onCall(app, name, fn) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(name)) throw new Error('onCall: a name is 1–64 of [A-Za-z0-9_.:-]');
  if (typeof fn !== 'function') throw new Error('onCall: a handler function');
  if (!callHandlers.has(app)) callHandlers.set(app, new Map());
  callHandlers.get(app).set(name, fn);
  return () => { if (callHandlers.get(app)?.get(name) === fn) callHandlers.get(app).delete(name); };
}

function expandV6(a) {
  const [head, tail] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = tail !== undefined ? Array(Math.max(0, 8 - h.length - t.length)).fill('0') : [];
  return [...h, ...fill, ...t].map(g => (parseInt(g, 16) || 0).toString(16));
}
function prefixOf(ip) {
  const a = String(ip || '').replace(/^::ffff:/i, '');
  if (net.isIPv4(a)) { const o = a.split('.'); return `${o[0]}.${o[1]}.${o[2]}.0/24`; }
  if (net.isIPv6(a)) return `${expandV6(a).slice(0, 4).join(':')}::/64`;
  return 'unknown';
}

function rateOk(rt, ip) {
  const k = `${rt.key}|${prefixOf(ip)}`;
  const now = Date.now();
  const hits = (callHits.get(k) || []).filter(t => now - t < CALL_RATE.windowMs);
  if (hits.length >= CALL_RATE.max) { callHits.set(k, hits); return false; }
  hits.push(now);
  callHits.set(k, hits);
  if (callHits.size > 5000) for (const [kk, v] of callHits) if (!v.length || now - v[v.length - 1] > CALL_RATE.windowMs) callHits.delete(kk);
  return true;
}

async function handleCall(rt, child, m) {
  const reply = (r) => { try { if (rt.child === child) child.send({ t: 'callResult', id: m.id, ...r }); } catch { /* gone */ } };
  try {
    const eff = effective(rt.app, rt.site);
    if (eff.platform !== 'controlled') return reply({ ok: false, code: 'platform_none', error: 'this site has no platform access' });
    const fn = callHandlers.get(rt.app)?.get(m.name);
    if (!fn) return reply({ ok: false, code: 'unknown_call', error: `"${String(m.name).slice(0, 64)}" is not a registered call` });
    if (typeof m.json !== 'string' || Buffer.byteLength(m.json) > CALL_ARGS_MAX) return reply({ ok: false, code: 'too_large', error: 'args exceed 64 KB' });
    if (!rateOk(rt, m.ip)) return reply({ ok: false, code: 'rate_limited', error: 'too many calls from this network — try again in a minute' });
    const am = appManager();
    if (!(am.getMountedRouter?.(rt.app) || am.getRunningApp?.(rt.app))) return reply({ ok: false, code: 'app_stopped', error: 'the app behind this site is not running' });
    const args = JSON.parse(m.json);
    const timeoutMs = Math.min(CALL_TIMEOUT_MAX, Math.max(100, Number(m.timeoutMs) || 5000));
    const result = await Promise.race([
      Promise.resolve().then(() => fn(args, { site: rt.site, ipPrefix: prefixOf(m.ip) })),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timed out'), { code: 'timeout' })), timeoutMs).unref?.()),
    ]);
    const json = JSON.stringify(result === undefined ? null : result);
    if (Buffer.byteLength(json) > CALL_RESULT_MAX) return reply({ ok: false, code: 'result_too_large', error: 'the result exceeds 256 KB' });
    reply({ ok: true, result: JSON.parse(json) });
  } catch (e) {
    reply({ ok: false, code: e.code || 'failed', error: String(e.message || e).slice(0, 300) });
  }
}

// ── domain check (/_vc/id) and nginx text ──────────────────────────────────
function nginxSnippet(app, site) {
  const eff = effective(app, site);
  const domain = eff.domain || 'example.com';
  return [
    'server {',
    `    server_name ${domain};`,
    '    # listen 443 ssl; ssl_certificate … (certbot adds these)',
    '    location / {',
    `        proxy_pass http://127.0.0.1:${eff.port};`,
    '        proxy_http_version 1.1;',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    '        proxy_set_header Upgrade $http_upgrade;',
    '        proxy_set_header Connection $connection_upgrade;',
    '        proxy_buffering off;',
    '    }',
    '}',
    '# once, in the http block:  map $http_upgrade $connection_upgrade { default upgrade; \'\' close; }',
  ].join('\n');
}

async function checkDomain(app, site, domainArg, { fetchImpl = globalThis.fetch, resolve = require('dns').promises.lookup } = {}) {
  const eff = effective(app, site);
  const domain = domainArg ? appManager().normalizeDomain(domainArg) : eff.domain;
  if (!domain) return { app, site, domain: null, ok: false, status: 'no-domain', text: 'Enter a domain first.' };
  try { await resolve(domain); } catch { return { app, site, domain, ok: false, status: 'dns', text: `${domain} does not resolve (DNS).` }; }
  let body = '';
  try {
    const r = await fetchImpl(`https://${domain}/_vc/id`, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    body = (await r.text()).trim();
  } catch (e) {
    return { app, site, domain, ok: false, status: 'unreachable', text: `https://${domain}/ did not answer (${e.message}).` };
  }
  if (body === idToken(app, site)) return { app, site, domain, ok: true, status: 'ok', text: `${domain} reaches this site.` };
  return { app, site, domain, ok: false, status: 'not-here', text: `${domain} answers, but not from ${app}/${site} on this host — check the nginx proxy_pass port (${eff.port}).` };
}

// The owner's Sites tab (dashboard WS `app:site:*`): one dispatcher, the
// engine methods above; returns what the tab renders.
async function ownerAction(action, app, site, args = {}) {
  switch (action) {
    case 'list': return { sites: list(app), fenceMinNode: FENCE_MIN_NODE, node: process.version };
    case 'detail': return {
      status: status(app, site), logs: logs(app, site, 200), crashes: crashes(app, site),
      snapshots: snapshots(app, site), nginx: nginxSnippet(app, site),
    };
    case 'start': return start(app, site);
    case 'stop': return stop(app, site);
    case 'restart': return restart(app, site);
    case 'settings': return hostSettings(app, site, args.patch || {});
    case 'rollback': return rollback(app, site, args.id);
    case 'checkDomain': return checkDomain(app, site, args.domain);
    default: throw new Error(`unknown site action "${action}"`);
  }
}

module.exports = {
  ownerAction, autostartApp,
  init, onEvent,
  list, status, crashes, logs, effective, declared,
  start, stop, restart, autostartAll, stopApp, removeApp, stopAll, afterCodeSwap,
  hostSettings, getConfig, setConfig,
  publish, rollback, snapshots, activeSnapshot,
  onCall, health, summary, proxyTarget,
  nginxSnippet, checkDomain, idToken,
  fenceAvailable, prefixOf,
  RUNNER, FENCE_MIN_NODE, HOST_FILE,
  _runtimes: runtimes, _codeHash: codeHash,
};
