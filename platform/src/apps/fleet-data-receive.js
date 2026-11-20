// Fleet data publish — the SLAVE side (docs/fleet-data.md). The master streams
// the blobs of an app's data manifest into an app-scoped inbox here; when all
// needed blobs are verified, the app's own `receive` hook runs once as a job
// the master polls. The HTTP surface is peer-server.js (`/api/peer/fleet-data`);
// this module holds the receiver registry, the inbox on disk, the integrity
// checks, the disk margin and the expiry sweep.
//
// Disk layout, one dir per transfer (outside every app dir, see the doc):
//   <appsDir>/.fleet-inbox/<app>/<name>.<manifestSha>/
//     transfer.json   { app, name, manifestSha, dir, peer, state, need, mismatches, error, commitJobId, createdAt }
//     manifest.json   the canonical manifest (its sha256 is the dir name's tail)
//     partial/<sha>   a blob being written, chunk by chunk at an offset
//     inbox/<sha>     a blob whose sha256 checked out — what `receive` gets as `inbox`
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const M = require('./fleet-data-manifest');

const CHUNK_MAX = 8 * 1024 * 1024;
const MARGIN_MIN = 1024 * 1024 * 1024;   // margin = max(1 GiB, 2 % of the filesystem)
const MARGIN_PCT = 0.02;
const EXPIRY_MS = 7 * 24 * 3600 * 1000;  // since the last activity (plan, chunk, commit)
const SWEEP_MS = 3600 * 1000;
const PROGRESS_MS = 500;
const INBOX_DIRNAME = '.fleet-inbox';

class FleetDataError extends Error {
  constructor(message, status = 400, code = 'bad-request', extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

let opts = {};
let sweepTimer = null;
const receivers = new Map();   // app → [{ pattern, re, hooks }]
const cache = new Map();       // transfer key → { dir, t, manifest, blobs, verified:Set, partial:Map }
const busy = new Set();        // `${key}/${sha}` chunk writes in flight
const lastEmit = new Map();
const events = new EventEmitter();
events.setMaxListeners(0);

function dep(name) {
  if (opts[name]) return opts[name];
  if (name === 'appManager') return require('./app-manager');
  if (name === 'hostConfig') return require('./host-config');
  if (name === 'appJobs') return require('./app-jobs');
  return null;
}
function appsDir() { return opts.appsDir || dep('appManager').APPS_DIR; }
function rootDir() { return path.join(appsDir(), INBOX_DIRNAME); }
function now() { return opts.now ? opts.now() : Date.now(); }

function init(options = {}) {
  opts = { ...options };
  cache.clear();
  busy.clear();
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  if (options.sweep !== false) {
    try { sweep(); } catch (err) { console.warn('[fleet-data] inbox sweep failed:', err.message); }
    sweepTimer = setInterval(() => { try { sweep(); } catch {} }, SWEEP_MS);
    sweepTimer.unref?.();
  }
}

function shutdown() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

// --- Receiver registry --------------------------------------------------------

function globRe(pattern) {
  return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\-]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}

// registerReceiver(app, 'world-*', { have, receive }) → unregister(). An exact
// name wins over a glob; among globs the first registered wins. In-process
// apps only: an own-process app's code runs in another process.
function registerReceiver(app, pattern, hooks) {
  if (!require('./peer-security').isAppName(app)) throw new Error(`bad app name "${app}"`);
  if (typeof pattern !== 'string' || !/^[a-z0-9._*?-]{1,64}$/.test(pattern)) {
    throw new Error('receiver name must be a transfer name or a glob of [a-z0-9._-*?], at most 64 chars');
  }
  if (!hooks || typeof hooks.have !== 'function' || typeof hooks.receive !== 'function') {
    throw new Error('receiver needs { have(manifest), receive({ manifest, extra, inbox, peer, signal, setProgress }) }');
  }
  if (dep('appManager').appRuntime(app) === 'own-process') {
    throw new Error(`"${app}" runs in its own process — fleet data receivers are in-process only`);
  }
  const list = (receivers.get(app) || []).filter((r) => r.pattern !== pattern);
  const entry = { pattern, re: globRe(pattern), hooks };
  list.push(entry);
  receivers.set(app, list);
  return () => {
    const cur = receivers.get(app) || [];
    const next = cur.filter((r) => r !== entry);
    if (next.length) receivers.set(app, next); else receivers.delete(app);
  };
}

// The app unloads or reloads (app-manager stopMountedApp): its hooks hold the
// dying module instance. A running receive job is app-owned, so app-jobs'
// cleanupApp aborts it on the same path.
function unregisterApp(app) {
  receivers.delete(app);
}

function findReceiver(app, name) {
  const list = receivers.get(app) || [];
  return list.find((r) => r.pattern === name) || list.find((r) => r.re.test(name)) || null;
}

function receiverPatterns(app) {
  return (receivers.get(app) || []).map((r) => r.pattern);
}

// --- Events -------------------------------------------------------------------

// subscribe(fn(event, data)) → unsubscribe. Events: 'fleet:data:progress'
// { app, name, manifestSha, dir, phase, receivedBytes, needBytes, blobs: { need, done }, label? }
// (phase receiving | verifying | receive) and 'fleet:data:done' { app, name, manifestSha, dir, ok, summary }.
// `dir` is 'down' (a master's publish to this slave) or 'up' (a slave's to this master).
function subscribe(fn) {
  const a = (d) => fn('fleet:data:progress', d);
  const b = (d) => fn('fleet:data:done', d);
  events.on('fleet:data:progress', a);
  events.on('fleet:data:done', b);
  return () => { events.off('fleet:data:progress', a); events.off('fleet:data:done', b); };
}

function emitProgress(c, phase, { force = false, label } = {}) {
  const key = keyOf(c.t.app, c.t.name, c.t.manifestSha);
  const t0 = lastEmit.get(key) || 0;
  if (!force && now() - t0 < PROGRESS_MS) return;
  lastEmit.set(key, now());
  let needBytes = 0;
  let receivedBytes = 0;
  let done = 0;
  for (const sha of c.t.need) {
    const bytes = c.blobs.get(sha) || 0;
    needBytes += bytes;
    if (c.verified.has(sha)) { receivedBytes += bytes; done++; } else receivedBytes += c.partial.get(sha) || 0;
  }
  events.emit('fleet:data:progress', {
    app: c.t.app, name: c.t.name, manifestSha: c.t.manifestSha, dir: c.t.dir || 'down', phase,
    receivedBytes, needBytes, blobs: { need: c.t.need.length, done }, ...(label ? { label } : {}),
  });
}

// --- Disk ---------------------------------------------------------------------

function statfs(p) {
  const s = (opts.statfs || fs.statfsSync)(p);
  const free = Number(s.bavail) * Number(s.bsize);
  const total = Number(s.blocks) * Number(s.bsize);
  return { freeBytes: free, marginBytes: Math.max(MARGIN_MIN, Math.round(total * MARGIN_PCT)) };
}

// The inbox must sit on the data dir's filesystem so `receive` can hard-link
// or rename a blob in. Creates both dirs; throws when the devices differ.
function inboxRootFor(app) {
  const dataDir = path.join(dep('appManager').appDir(app), '.data');
  fs.mkdirSync(dataDir, { recursive: true });
  const root = path.join(rootDir(), app);
  fs.mkdirSync(root, { recursive: true });
  const a = fs.statSync(fs.realpathSync(dataDir)).dev;
  const b = fs.statSync(fs.realpathSync(root)).dev;
  if (a !== b) {
    throw new FleetDataError(`the fleet inbox (${root}) and ${app}'s data dir are on different filesystems — mount ${app}/.data on the apps dir's filesystem`, 409, 'cross-device');
  }
  return root;
}

// --- Transfers ----------------------------------------------------------------

function keyOf(app, name, sha) { return `${app}/${name}.${sha}`; }
function dirOf(app, name, sha) { return path.join(rootDir(), app, `${name}.${sha}`); }

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function checkApp(app) {
  const am = dep('appManager');
  if (!require('./peer-security').isAppName(app)) throw new FleetDataError('bad app name', 400, 'bad-app');
  if (!am.readManifest(app)) throw new FleetDataError(`app "${app}" is not installed on this slave`, 404, 'no-app');
  if (!dep('hostConfig').isEnabled(app)) throw new FleetDataError(`app "${app}" is not enabled on this slave`, 409, 'not-enabled');
  if (am.appRuntime(app) === 'own-process') {
    throw new FleetDataError(`app "${app}" runs in its own process — fleet data publish reaches in-process apps only`, 409, 'own-process');
  }
}

function checkIds(name, sha) {
  if (!M.isName(name)) throw new FleetDataError('bad transfer name', 400, 'bad-name');
  if (!M.isSha(sha)) throw new FleetDataError('bad manifest sha256', 400, 'bad-sha');
}

function listShas(dir) {
  try { return fs.readdirSync(dir).filter(M.isSha); } catch { return []; }
}

// Load a transfer from disk (or the cache). null when it does not exist.
function load(app, name, sha) {
  const key = keyOf(app, name, sha);
  const hit = cache.get(key);
  if (hit && fs.existsSync(hit.dir)) return hit;
  cache.delete(key);
  const dir = dirOf(app, name, sha);
  let t;
  let manifest;
  try {
    t = JSON.parse(fs.readFileSync(path.join(dir, 'transfer.json'), 'utf-8'));
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
  } catch { return null; }
  const blobs = new Map(manifest.blobs.map((b) => [b.sha256, b.bytes]));
  const verified = new Set(listShas(path.join(dir, 'inbox')));
  const partial = new Map();
  for (const s of listShas(path.join(dir, 'partial'))) {
    try { partial.set(s, fs.statSync(path.join(dir, 'partial', s)).size); } catch {}
  }
  const c = { key, dir, t, manifest, blobs, verified, partial, needSet: new Set(t.need) };
  // A commit whose job is gone (app reload, slave restart) is open again.
  if (t.state === 'committing' && !commitRunning(c)) { t.state = 'open'; saveT(c); }
  cache.set(key, c);
  return c;
}

function saveT(c) { writeJson(path.join(c.dir, 'transfer.json'), c.t); }
function touchActivity(c) {
  const d = new Date(now());
  try { fs.utimesSync(path.join(c.dir, 'transfer.json'), d, d); } catch {}
}

function commitRunning(c) {
  if (!c.t.commitJobId) return false;
  try { return dep('appJobs').getJob(c.t.app, c.t.commitJobId)?.status === 'running'; } catch { return false; }
}

function remaining(c) {
  const need = c.t.need.filter((s) => !c.verified.has(s));
  let needBytes = 0;
  const partial = {};
  for (const s of need) {
    const p = c.partial.get(s) || 0;
    needBytes += (c.blobs.get(s) || 0) - p;
    if (p) partial[s] = p;
  }
  return { need, needBytes, partial };
}

function info(app) {
  const am = dep('appManager');
  if (!require('./peer-security').isAppName(app)) throw new FleetDataError('bad app name', 400, 'bad-app');
  const manifest = am.readManifest(app);
  let disk = null;
  if (manifest) { try { disk = statfs(path.join(am.appDir(app))); } catch {} }
  let commit = null;
  try { commit = require('./peer-data').deployedCommit(app); } catch {}
  return {
    installed: !!manifest,
    enabled: !!manifest && dep('hostConfig').isEnabled(app),
    runtime: manifest ? am.appRuntime(app) : null,
    running: !!(manifest && (am.getMountedRouter(app) || am.getRunningApp?.(app)?.port)),
    version: manifest?.version || null,
    commit,
    freeBytes: disk?.freeBytes ?? null,
    marginBytes: disk?.marginBytes ?? null,
    receivers: receiverPatterns(app),
  };
}

// plan(app, { name, manifest, sha?, open?, dir?, peer? }): ask the app's `have`
// hook, take away what it holds and what is already verified in the inbox,
// report the delta and whether it fits. `open` creates (or reopens) the inbox;
// `dir: 'up'` marks a slave's publish to this master, `peer` its host (what
// `receive` gets as `peer`; the master's host otherwise).
async function plan(app, { name, manifest: raw, sha: claimed, open = false, dir: direction = 'down', peer = null } = {}) {
  checkApp(app);
  if (!M.isName(name)) throw new FleetDataError('bad transfer name', 400, 'bad-name');
  let v;
  try { v = M.validateManifest(raw); } catch (err) { throw new FleetDataError(err.message, 400, 'bad-manifest'); }
  if (claimed && claimed !== v.sha) throw new FleetDataError('manifest sha256 differs from the master\'s — both sides must run a vc with the same manifest format', 400, 'sha-differs');
  const rec = findReceiver(app, name);
  if (!rec) throw new FleetDataError(`app "${app}" has no data receiver for "${name}" here (is it running?)`, 409, 'no-receiver');
  const root = inboxRootFor(app);
  const existing = load(app, name, v.sha);

  let held;
  try { held = await rec.hooks.have(v.manifest); } catch (err) {
    throw new FleetDataError(`${app}'s have() hook failed: ${err.message}`, 500, 'have-failed');
  }
  const have = new Set();
  for (const s of held || []) if (v.blobs.has(s)) have.add(s);
  const verified = existing ? existing.verified : new Set();
  const need = [...v.blobs.keys()].filter((s) => !have.has(s) && !verified.has(s));
  const needSet = new Set(need);
  let needBytes = 0;
  let haveBytes = 0;
  const partial = {};
  for (const [s, bytes] of v.blobs) {
    if (!needSet.has(s)) { haveBytes += bytes; continue; }
    const p = existing?.partial.get(s) || 0;
    needBytes += bytes - p;
    if (p) partial[s] = p;
  }
  const { freeBytes, marginBytes } = statfs(root);
  const fits = needBytes + marginBytes <= freeBytes;
  const out = { name, sha: v.sha, blobs: v.blobs.size, need, needBytes, haveBytes, freeBytes, marginBytes, fits, partial, state: existing?.t.state || 'new' };
  if (!open || !fits) return out;

  if (existing && existing.t.state === 'committing') return { ...out, state: 'committing', commitJobId: existing.t.commitJobId };
  const dir = dirOf(app, name, v.sha);
  fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'partial'), { recursive: true });
  if (!existing) writeJson(path.join(dir, 'manifest.json'), v.manifest);
  const t = {
    app, name, manifestSha: v.sha, dir: direction === 'up' ? 'up' : 'down', peer: typeof peer === 'string' ? peer.slice(0, 253) : null,
    createdAt: existing?.t.createdAt || now(),
    // A new plan of a failed transfer is a fresh attempt: the mismatch count restarts.
    state: 'open', need: need.concat((existing ? [...existing.verified] : []).filter((s) => v.blobs.has(s))),
    mismatches: {}, error: null, commitJobId: existing?.t.commitJobId || null,
  };
  // Only needed + already-verified blobs matter for the commit; a stale
  // partial of a blob the app now holds is dropped.
  const keep = new Set(t.need);
  for (const s of listShas(path.join(dir, 'partial'))) if (!keep.has(s)) fs.rmSync(path.join(dir, 'partial', s), { force: true });
  const c = { key: keyOf(app, name, v.sha), dir, t, manifest: v.manifest, blobs: v.blobs, verified: new Set(verified), partial: new Map(), needSet: keep };
  for (const s of listShas(path.join(dir, 'partial'))) c.partial.set(s, fs.statSync(path.join(dir, 'partial', s)).size);
  saveT(c);
  cache.set(c.key, c);
  return { ...out, state: 'open' };
}

function status(app, name, sha) {
  checkIds(name, sha);
  if (!require('./peer-security').isAppName(app)) throw new FleetDataError('bad app name', 400, 'bad-app');
  const c = load(app, name, sha);
  if (!c) return { exists: false };
  const r = remaining(c);
  let commit = null;
  if (c.t.commitJobId) {
    try {
      const j = dep('appJobs').getJob(app, c.t.commitJobId);
      if (j) commit = { jobId: j.id, status: j.status, error: j.error || null };
    } catch {}
  }
  return {
    exists: true, state: c.t.state, error: c.t.error || null, blobs: c.blobs.size,
    verified: [...c.verified].filter((s) => c.needSet.has(s)).length,
    ...r, commit,
  };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

// One chunk of a needed blob, streamed from `body` to partial/<sha> at
// `offset`. `length` is the request's Content-Length. Never buffered: the
// body goes through a counting transform into a file stream.
async function writeChunk(app, name, sha, blob, offset, length, body) {
  checkIds(name, sha);
  if (!M.isSha(blob)) throw new FleetDataError('bad blob sha256', 400, 'bad-blob');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new FleetDataError('bad offset', 400, 'bad-offset');
  if (!Number.isSafeInteger(length) || length < 0) throw new FleetDataError('Content-Length required', 411, 'no-length');
  if (length > CHUNK_MAX) throw new FleetDataError(`chunk over ${CHUNK_MAX / 1048576} MB`, 413, 'chunk-too-big');
  checkApp(app);
  const c = load(app, name, sha);
  if (!c) throw new FleetDataError('no such transfer — plan it first', 404, 'no-transfer');
  if (c.t.state !== 'open') throw new FleetDataError(`transfer is ${c.t.state}${c.t.error ? `: ${c.t.error}` : ''}`, 409, 'not-open');
  if (!c.needSet.has(blob)) throw new FleetDataError('blob is not part of this transfer\'s delta', 400, 'not-needed');
  const bytes = c.blobs.get(blob);
  if (c.verified.has(blob)) return { offset: bytes, verified: true };
  const lock = `${c.key}/${blob}`;
  if (busy.has(lock)) throw new FleetDataError('a chunk of this blob is being written', 409, 'busy');
  busy.add(lock);
  try {
    const part = path.join(c.dir, 'partial', blob);
    let cur = 0;
    try { cur = fs.statSync(part).size; } catch {}
    if (offset > cur) throw new FleetDataError(`offset ${offset} is past the ${cur} bytes held`, 409, 'offset', { offset: cur });
    if (offset + length > bytes) throw new FleetDataError(`chunk ends past the blob's ${bytes} bytes`, 400, 'past-end');
    const { freeBytes, marginBytes } = statfs(c.dir);
    if (freeBytes - length < marginBytes) {
      throw new FleetDataError(`writing ${length} bytes would leave less than the ${marginBytes}-byte margin free on this slave`, 507, 'no-space', { freeBytes, marginBytes });
    }
    fs.closeSync(fs.openSync(part, 'a'));
    fs.truncateSync(part, offset);
    let seen = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        seen += chunk.length;
        if (seen > length) return cb(new FleetDataError('body longer than Content-Length', 400, 'long-body'));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(body, counter, fs.createWriteStream(part, { flags: 'r+', start: offset }));
    } finally {
      try { c.partial.set(blob, fs.statSync(part).size); } catch {}
      touchActivity(c);
    }
    if (seen !== length) throw new FleetDataError(`body ended after ${seen} of ${length} bytes`, 400, 'short-body', { offset: offset + seen });
    const end = offset + length;
    if (end < bytes) { emitProgress(c, 'receiving'); return { offset: end, verified: false }; }

    emitProgress(c, 'verifying', { force: true });
    const got = await sha256File(part);
    if (got !== blob) {
      fs.rmSync(part, { force: true });
      c.partial.delete(blob);
      const n = (c.t.mismatches[blob] || 0) + 1;
      c.t.mismatches[blob] = n;
      const failed = n >= 2;
      if (failed) { c.t.state = 'failed'; c.t.error = `blob ${blob} failed its sha256 check twice`; }
      saveT(c);
      throw new FleetDataError(failed ? c.t.error : `blob ${blob} failed its sha256 check — dropped, send it again`, 422, 'sha-mismatch', { failed, mismatches: n });
    }
    fs.renameSync(part, path.join(c.dir, 'inbox', blob));
    c.partial.delete(blob);
    c.verified.add(blob);
    emitProgress(c, 'receiving', { force: true });
    return { offset: bytes, verified: true };
  } finally {
    busy.delete(lock);
  }
}

// Every needed blob verified → run the app's receive() once, as an app job the
// master polls (GET /jobs/:app/:id). ok → the inbox is removed; a throw or
// ok:false keeps it for a retry and fails the job with the app's reason.
function commit(app, name, sha) {
  checkIds(name, sha);
  checkApp(app);
  const c = load(app, name, sha);
  if (!c) throw new FleetDataError('no such transfer — plan it first', 404, 'no-transfer');
  if (c.t.state === 'committing' && commitRunning(c)) return { jobId: c.t.commitJobId, attached: true };
  if (c.t.state === 'failed') throw new FleetDataError(`transfer failed: ${c.t.error}`, 409, 'failed');
  const missing = c.t.need.filter((s) => !c.verified.has(s));
  if (missing.length) throw new FleetDataError(`${missing.length} blob(s) not received yet`, 409, 'incomplete', { missing: missing.length });
  const rec = findReceiver(app, name);
  if (!rec) throw new FleetDataError(`app "${app}" has no data receiver for "${name}" here (is it running?)`, 409, 'no-receiver');
  const inbox = path.join(c.dir, 'inbox');
  let fromHost = c.t.dir === 'up' ? c.t.peer : null;
  if (c.t.dir !== 'up') { try { fromHost = new URL(dep('hostConfig').slaveInfo()?.masterUrl).hostname; } catch {} }
  const { id } = dep('appJobs').startJob(app, {
    name: 'fleet-data:receive',
    meta: { fleetData: true, name, manifestSha: sha, blobs: c.blobs.size, received: c.t.need.length },
    run: async (job) => {
      c.t.state = 'committing';
      c.t.commitJobId = job.id;
      c.t.error = null;
      saveT(c);
      touchActivity(c);
      emitProgress(c, 'receive', { force: true });
      let lastLabel = null;
      const setProgress = (pct, label) => {
        job.setProgress(pct, label);
        const l = label == null ? null : String(label);
        emitProgress(c, 'receive', { label: l || undefined, force: l !== lastLabel });
        lastLabel = l;
      };
      let out;
      try {
        out = await rec.hooks.receive({ manifest: c.manifest, extra: c.manifest.extra ?? null, inbox, peer: fromHost, signal: job.signal, setProgress });
        if (!out || out.ok !== true) throw new Error(String(out?.summary || out?.error || 'receive returned ok:false'));
      } catch (err) {
        if (fs.existsSync(c.dir)) { c.t.state = 'open'; c.t.error = err.message; saveT(c); }
        events.emit('fleet:data:done', { app, name, manifestSha: sha, dir: c.t.dir || 'down', ok: false, summary: err.message });
        throw err;
      }
      fs.rmSync(c.dir, { recursive: true, force: true });
      cache.delete(c.key);
      lastEmit.delete(c.key);
      const summary = out.summary == null ? null : out.summary;
      events.emit('fleet:data:done', { app, name, manifestSha: sha, dir: c.t.dir || 'down', ok: true, summary });
      return { ok: true, summary };
    },
  });
  return { jobId: id };
}

function cancel(app, name, sha) {
  checkIds(name, sha);
  if (!require('./peer-security').isAppName(app)) throw new FleetDataError('bad app name', 400, 'bad-app');
  const c = load(app, name, sha);
  if (!c) return { ok: true, existed: false };
  if (commitRunning(c)) { try { dep('appJobs').cancelJob(app, c.t.commitJobId); } catch {} }
  fs.rmSync(c.dir, { recursive: true, force: true });
  cache.delete(c.key);
  lastEmit.delete(c.key);
  return { ok: true, existed: true };
}

// Remove every transfer dir with no activity for EXPIRY_MS (transfer.json's
// mtime, or the dir's when it has none), unless its receive is running.
function sweep() {
  const root = rootDir();
  let apps = [];
  try { apps = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return { removed: 0 }; }
  let removed = 0;
  const cutoff = now() - EXPIRY_MS;
  for (const app of apps) {
    const appRoot = path.join(root, app);
    let dirs = [];
    try { dirs = fs.readdirSync(appRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
    for (const d of dirs) {
      const dir = path.join(appRoot, d);
      let mtime;
      try { mtime = fs.statSync(path.join(dir, 'transfer.json')).mtimeMs; } catch { try { mtime = fs.statSync(dir).mtimeMs; } catch { continue; } }
      if (mtime >= cutoff) continue;
      const hit = [...cache.values()].find((c) => c.dir === dir);
      if (hit && commitRunning(hit)) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      if (hit) cache.delete(hit.key);
      removed++;
    }
    try { if (!fs.readdirSync(appRoot).length) fs.rmdirSync(appRoot); } catch {}
  }
  if (removed) console.log(`  Fleet data: removed ${removed} expired inbox(es)`);
  return { removed };
}

module.exports = {
  init, shutdown, registerReceiver, unregisterApp, findReceiver, receiverPatterns, subscribe, events,
  info, plan, status, writeChunk, commit, cancel, sweep, rootDir, FleetDataError,
  CHUNK_MAX, EXPIRY_MS, MARGIN_MIN, MARGIN_PCT,
};
