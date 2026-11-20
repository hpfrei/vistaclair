// Fleet data publish — the MASTER side (docs/fleet-data.md). Streams the blobs
// of an app's data manifest to a linked slave's inbox (fleet-data-receive.js
// behind peer-server.js's /fleet-data routes), then has the slave run the
// app's receive hook and polls it. The up direction (a slave's publish to this
// master, docs/fleet-data-up.md) runs the same loop the other way: records
// with `dir: 'up'` pull byte ranges from the slave into this master's own
// inbox (fleet-data-up.js endpoint()). Internal API for the capability layer:
//
//   peers(app)                                  slaves with this app + online/app/disk/specs
//   plan(app, peer, { name, manifest })         the slave's delta, nothing sent
//   start(app, peer, { name, manifest, meta, origin, dir? }) → { id, attached? }
//   status(id) · cancel(id) · list({ app, peer?, name?, dir? }) · subscribe(fn)
//   stage(app, peer, { name, manifest, dir? }) → { id, manifestSha, … }   for a proposal
//   startStaged(app, peer, { name, manifestSha, meta, origin, dir? })     its executor
//
// A transfer's identity is peer + app + name + sha256(canonical manifest):
// starting the same one again re-attaches to it, or resumes it from the
// slave's own record of verified blobs and partial offsets. Records persist
// in <appsDir>/.fleet-data/ and running ones resume at init (master restart).
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const M = require('./fleet-data-manifest');

const DEFAULTS = {
  chunkBytes: 8 * 1024 * 1024,     // ≤ the slave's CHUNK_MAX
  concurrency: 4,                  // blobs in flight
  backoffMinMs: 2000,
  backoffMaxMs: 60000,
  unreachableMs: 30 * 60 * 1000,   // no progress this long (link down, slave refusing) fails it
  pollMs: 2000,                    // receive-job polling
  progressMs: 500,
  persistMs: 2000,
};
const MAX_META_BYTES = 16 * 1024;
const MAX_RECORDS = 200;
const TERMINAL_TTL_MS = 30 * 24 * 3600 * 1000;
// A manifest staged for an `app.data_publish` proposal (stage()) has no record
// yet; prune keeps it this long (the proposal TTL is 7 days).
const STAGED_TTL_MS = 8 * 24 * 3600 * 1000;

let opts = { ...DEFAULTS };
let records = [];                 // newest first
const runs = new Map();           // id → { controller, promise }
const events = new EventEmitter();
events.setMaxListeners(0);
let persistTimer = null;
const lastEmit = new Map();

class FatalError extends Error {}
const fatal = (msg) => new FatalError(msg);

// --- Dependencies (injectable for the two-host tests) -------------------------

function d(name) {
  if (opts[name]) return opts[name];
  switch (name) {
    case 'client': return require('./peer-client');
    case 'getPeer': return (ref) => require('./peer-pairing').getPeer(ref);
    case 'listPeers': return () => require('./peer-pairing').listPeersRaw();
    case 'appExists': return (app) => !!require('./app-manager').readManifest(app);
    case 'dataDir': return (app) => path.join(require('./app-manager').appDir(app), '.data');
    case 'stateDir': return path.join(require('./app-manager').APPS_DIR, '.fleet-data');
    case 'fleetState': return () => { try { return require('./peer-channel').fleetState(); } catch { return { peers: [] }; } };
    case 'upEndpoint': return (rec, peer) => require('./fleet-data-up').endpoint(rec, peer);
    default: return null;
  }
}
function stateFile() { return path.join(d('stateDir'), 'transfers.json'); }
function manifestFile(sha) { return path.join(d('stateDir'), 'manifests', `${sha}.json`); }

function init(options = {}) {
  opts = { ...DEFAULTS, ...options };
  records = [];
  try { records = JSON.parse(fs.readFileSync(stateFile(), 'utf-8')).transfers || []; } catch {}
  prune();
  if (options.resume === false) return;
  for (const rec of records) {
    if (rec.status === 'running' && !runs.has(rec.id)) launch(rec, { fresh: false });
  }
}

// Stops the in-process runs WITHOUT ending them: their records stay
// 'running', so the next init resumes them. Resolves when they have settled.
async function shutdown() {
  const pending = [];
  for (const [, r] of runs) { r.stopping = true; r.controller.abort(); pending.push(r.promise.catch(() => {})); }
  await Promise.all(pending);
  flush();
}

// --- Persistence ----------------------------------------------------------------

function flush() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  try {
    fs.mkdirSync(d('stateDir'), { recursive: true });
    const tmp = stateFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ transfers: records }));
    fs.renameSync(tmp, stateFile());
  } catch (err) {
    console.warn(`[fleet-data] state save failed: ${err.message}`);
  }
}
function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(flush, opts.persistMs);
  persistTimer.unref?.();
}

function prune() {
  const cutoff = Date.now() - TERMINAL_TTL_MS;
  records = records
    .filter((r) => r.status === 'running' || (r.finishedAt || r.updatedAt || 0) >= cutoff)
    .slice(0, MAX_RECORDS);
  const keep = new Set(records.map((r) => r.manifestSha));
  const dir = path.join(d('stateDir'), 'manifests');
  const stagedCutoff = Date.now() - STAGED_TTL_MS;
  let files = [];
  try { files = fs.readdirSync(dir); } catch {}
  for (const f of files) {
    if (keep.has(f.replace(/\.json$/, ''))) continue;
    try {
      if (fs.statSync(path.join(dir, f)).mtimeMs >= stagedCutoff) continue;
      fs.rmSync(path.join(dir, f), { force: true });
    } catch {}
  }
}

// --- Events -----------------------------------------------------------------------

// subscribe(fn(event, data)) → unsubscribe.
//   'fleet:data:progress' { id, app, peer, name, dir, sentBytes, needBytes, blobs: { total, need, done }, phase, label }
//   'fleet:data:done'     { id, app, peer, name, dir, ok, summary }
function subscribe(fn) {
  const a = (x) => fn('fleet:data:progress', x);
  const b = (x) => fn('fleet:data:done', x);
  events.on('fleet:data:progress', a);
  events.on('fleet:data:done', b);
  return () => { events.off('fleet:data:progress', a); events.off('fleet:data:done', b); };
}

function progress(rec, { force = false } = {}) {
  rec.updatedAt = Date.now();
  persistSoon();
  const t0 = lastEmit.get(rec.id) || 0;
  if (!force && Date.now() - t0 < opts.progressMs) return;
  lastEmit.set(rec.id, Date.now());
  events.emit('fleet:data:progress', {
    id: rec.id, app: rec.app, peer: rec.peer, name: rec.name, dir: rec.dir || 'down',
    sentBytes: rec.sentBytes, needBytes: rec.needBytes,
    blobs: { total: rec.blobs, need: rec.blobsNeed, done: rec.blobsDone },
    phase: rec.phase, label: rec.label,
  });
}

function publicRec(rec) { return rec ? JSON.parse(JSON.stringify(rec)) : null; }

// --- Manifest checks on the master ---------------------------------------------------

// Every blob path is relative to the app's data dir and stays inside it after
// symlinks are resolved; it is a regular file of exactly `bytes`. Returns
// sha → the resolved file to read. No re-hash: the receiver verifies. The
// sending slave of the up direction runs the same checks (`dataDir` = its own).
async function dataRoot(app, dataDir) {
  try { return await fsp.realpath(dataDir || d('dataDir')(app)); } catch { throw fatal(`app "${app}" has no data dir`); }
}

// One blob → its resolved file, or throws (FatalError) with the reason.
async function checkBlob(root, b) {
  const p = b.path;
  if (path.isAbsolute(p) || /^[a-zA-Z]:/.test(p) || p.split(/[\\/]+/).includes('..')) {
    throw fatal(`blob path "${p}" is not inside the app's data dir`);
  }
  let real;
  try { real = await fsp.realpath(path.join(root, p)); } catch { throw fatal(`blob file "${p}" does not exist`); }
  if (!real.startsWith(root + path.sep)) throw fatal(`blob path "${p}" resolves outside the app's data dir`);
  const st = await fsp.stat(real);
  if (!st.isFile()) throw fatal(`blob path "${p}" is not a regular file`);
  if (st.size !== b.bytes) throw fatal(`blob file "${p}" is ${st.size} bytes, the manifest says ${b.bytes}`);
  return real;
}

async function checkPaths(app, manifest, { dataDir } = {}) {
  const root = await dataRoot(app, dataDir);
  const files = new Map();
  const blobs = manifest.blobs;
  let i = 0;
  const worker = async () => {
    while (i < blobs.length) {
      const b = blobs[i++];
      const real = await checkBlob(root, b);
      if (!files.has(b.sha256)) files.set(b.sha256, real);
    }
  };
  await Promise.all(Array.from({ length: Math.min(32, blobs.length || 1) }, worker));
  return files;
}

function prepare(app, name, manifest) {
  if (!require('./peer-security').isAppName(app)) throw new Error(`bad app name "${app}"`);
  if (!d('appExists')(app)) throw new Error(`unknown app "${app}"`);
  if (!M.isName(name)) throw new Error('name must match [a-z0-9._-]{1,64}');
  return M.validateManifest(manifest);
}

function resolvePeer(ref) {
  const peer = typeof ref === 'object' && ref ? d('getPeer')(ref.id || ref.name) : d('getPeer')(ref);
  if (!peer) throw new Error('unknown peer — link a slave first');
  return peer;
}

// --- Slave calls --------------------------------------------------------------------

function routeMissing(peer) {
  return fatal(`${peer.name} has no fleet data routes (HTTP 404) — update vistaclair-pro there`);
}
async function slave(peer, apiPath, o = {}) {
  try {
    return await d('client').call(peer, apiPath, o);
  } catch (err) {
    if (err.status === 404 && !err.body?.code) throw routeMissing(peer);
    throw err;
  }
}

const FATAL_CODES = new Set(['bad-app', 'bad-name', 'bad-sha', 'bad-blob', 'bad-manifest', 'sha-differs', 'no-app', 'not-enabled', 'own-process', 'cross-device', 'no-space', 'have-failed', 'not-needed', 'past-end', 'failed', 'chunk-too-big', 'error']);
function isTransient(err) {
  if (err instanceof FatalError) return false;
  if (err.status == null) return true;               // network, timeout
  const code = err.body?.code;
  if (code && FATAL_CODES.has(code)) return false;
  if (err.status === 429 || err.status >= 502) return true;
  return ['busy', 'no-receiver', 'incomplete', 'not-open', 'no-transfer', 'offset', 'short-body', 'long-body'].includes(code);
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function fmtBytes(n) {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return Math.round(n / 1024) + ' KB';
}

// --- Public API -----------------------------------------------------------------------

async function peers(app) {
  if (!require('./peer-security').isAppName(app)) throw new Error(`bad app name "${app}"`);
  let state = { peers: [] };
  try { state = d('fleetState')() || state; } catch {}
  const snap = new Map((state.peers || []).map((p) => [p.name, p]));
  const rows = await Promise.all(d('listPeers')().map(async (p) => {
    let host = null;
    try { host = new URL(p.baseUrl).hostname; } catch {}
    const s = snap.get(p.name);
    const row = { peer: p.name, host, label: p.label || p.name, online: false, supported: null, app: null, disk: null, receivers: [], specs: s?.specs || null, error: null };
    if (s?.deployed?.[app]) row.app = { installed: true, commit: s.deployed[app], running: null, version: null };
    if (p.needsRepair) { row.error = 'linked over plain http — re-pair over https'; return row; }
    try {
      const r = await d('client').call(p, `/fleet-data/${app}`, { timeoutMs: 8000 });
      row.online = true;
      row.supported = true;
      row.app = { installed: r.installed, enabled: r.enabled, running: r.running, version: r.version, commit: r.commit, runtime: r.runtime };
      row.disk = { freeBytes: r.freeBytes, marginBytes: r.marginBytes };
      row.receivers = r.receivers || [];
    } catch (err) {
      if (err.status) row.online = true;
      if (err.status === 404 && !err.body?.code) { row.supported = false; row.error = 'update vistaclair-pro there'; } else row.error = err.message;
    }
    return row;
  }));
  return rows.filter((r) => r.app?.installed !== false && (r.app || !r.online));
}

async function plan(app, peerRef, { name, manifest } = {}) {
  const v = prepare(app, name, manifest);
  const peer = resolvePeer(peerRef);
  await checkPaths(app, v.manifest);
  const r = await slave(peer, `/fleet-data/${app}/plan`, { method: 'POST', body: { name, manifest: v.manifest, sha: v.sha, open: false }, timeoutMs: 10 * 60 * 1000 });
  return {
    peer: peer.name, name, manifestSha: v.sha, blobs: r.blobs, need: r.need, needBytes: r.needBytes,
    haveBytes: r.haveBytes, freeBytes: r.freeBytes, marginBytes: r.marginBytes, fits: r.fits,
  };
}

// The up direction hashes a prefix in: the same manifest both ways is two transfers.
function idOf(peer, app, name, sha, dir = 'down') {
  const key = `${peer.id || peer.name}\n${app}\n${name}\n${sha}`;
  return 'fd-' + crypto.createHash('sha256').update(dir === 'up' ? `up\n${key}` : key).digest('hex').slice(0, 24);
}

async function start(app, peerRef, { name, manifest, meta, origin, dir = 'down' } = {}) {
  const v = prepare(app, name, manifest);
  const peer = resolvePeer(peerRef);
  const up = dir === 'up';
  let metaJson = null;
  if (meta !== undefined && meta !== null) {
    try { metaJson = JSON.stringify(meta); } catch { throw new Error('meta must be JSON'); }
    if (Buffer.byteLength(metaJson) > MAX_META_BYTES) throw new Error(`meta is over ${MAX_META_BYTES / 1024} KB`);
  }
  const id = idOf(peer, app, name, v.sha, dir);
  if (runs.has(id)) return { id, attached: true };
  if (!up) await checkPaths(app, v.manifest);
  if (runs.has(id)) return { id, attached: true };
  const live = records.filter((r) => r.status === 'running' && r.id !== id && r.app === app && r.name === name && (r.dir || 'down') === dir);
  const other = live.find((r) => r.peer === peer.name);
  if (other) throw new Error(`a transfer of "${name}" ${up ? 'from' : 'to'} ${peer.name} is running (${other.id}) — cancel it first`);
  // Up: the inbox here is per app + name + manifest, so one sender at a time.
  const twin = up && live.find((r) => r.manifestSha === v.sha);
  if (twin) throw new Error(`the same "${name}" is being received from ${twin.peer} (${twin.id}) — cancel it first`);

  saveManifest(v);
  let totalBytes = 0;
  for (const b of v.blobs.values()) totalBytes += b;
  const prev = records.find((r) => r.id === id);
  const now = Date.now();
  const rec = {
    id, app, peer: peer.name, peerId: peer.id || null, name, manifestSha: v.sha, dir: up ? 'up' : 'down',
    blobs: v.blobs.size, totalBytes,
    meta: metaJson ? JSON.parse(metaJson) : null,
    origin: origin == null ? null : (typeof origin === 'object' ? JSON.parse(JSON.stringify(origin)) : String(origin)),
    status: 'running', phase: 'plan', label: null,
    sentBytes: 0, needBytes: null, wireBytes: 0, blobsNeed: null, blobsDone: 0,
    summary: null, error: null, commitJobId: null,
    createdAt: prev?.createdAt || now, startedAt: now, updatedAt: now, finishedAt: null,
    runs: (prev?.runs || 0) + 1,
  };
  records = [rec, ...records.filter((r) => r.id !== id)];
  prune();
  flush();
  launch(rec, { fresh: true });
  return { id };
}

function saveManifest(v) {
  fs.mkdirSync(path.dirname(manifestFile(v.sha)), { recursive: true });
  if (!fs.existsSync(manifestFile(v.sha))) {
    const tmp = manifestFile(v.sha) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(v.manifest));
    fs.renameSync(tmp, manifestFile(v.sha));
  } else {
    const t = new Date();
    try { fs.utimesSync(manifestFile(v.sha), t, t); } catch {}
  }
}

// Stage a transfer for an `app.data_publish` proposal: the same checks as
// start (app, name, manifest, blob paths), the manifest stored under its sha
// (the proposal carries only the sha), nothing sent. → { id, manifestSha,
// blobs, totalBytes } — `id` is the transfer id start() will use.
async function stage(app, peerRef, { name, manifest, dir = 'down' } = {}) {
  const v = prepare(app, name, manifest);
  const peer = resolvePeer(peerRef);
  if (dir !== 'up') await checkPaths(app, v.manifest);
  saveManifest(v);
  let totalBytes = 0;
  for (const b of v.blobs.values()) totalBytes += b;
  return { id: idOf(peer, app, name, v.sha, dir), peer: peer.name, manifestSha: v.sha, blobs: v.blobs.size, totalBytes };
}

// The manifest stage() stored, or null once pruned.
function stagedManifest(manifestSha) {
  if (!M.isSha(manifestSha)) return null;
  try { return JSON.parse(fs.readFileSync(manifestFile(manifestSha), 'utf-8')); } catch { return null; }
}

// start() for a staged manifest (the approved proposal's executor).
async function startStaged(app, peerRef, { name, manifestSha, meta, origin, dir = 'down' } = {}) {
  const manifest = stagedManifest(manifestSha);
  if (!manifest) throw new Error(`the staged manifest ${String(manifestSha).slice(0, 12)}… is gone (staged more than 8 days ago?) — publish again`);
  return start(app, peerRef, { name, manifest, meta, origin, dir });
}

function status(id) {
  return publicRec(records.find((r) => r.id === id));
}

function list({ app, peer, name, dir } = {}) {
  return records
    .filter((r) => (!app || r.app === app) && (!peer || r.peer === peer) && (!name || r.name === name) && (!dir || (r.dir || 'down') === dir))
    .map(publicRec);
}

async function cancel(id) {
  const rec = records.find((r) => r.id === id);
  if (!rec) return { ok: false, error: 'unknown transfer' };
  if (rec.status !== 'running') return { ok: false, error: `transfer already ${rec.status}` };
  const run = runs.get(id);
  if (run) { run.cancelled = true; run.controller.abort(); }
  finish(rec, 'cancelled', { summary: 'cancelled' });
  let cleared = false;
  try {
    const peer = d('getPeer')(rec.peerId || rec.peer) || d('getPeer')(rec.peer);
    if (peer) { await endpointFor(rec, peer).cancel(); cleared = true; }
  } catch {}
  // Up: the inbox is this master's own; the slave hears it from the done push.
  return rec.dir === 'up' ? { ok: true, inboxCleared: cleared } : { ok: true, slaveCleared: cleared };
}

// --- The run ---------------------------------------------------------------------

function finish(rec, statusValue, { summary = null, error = null } = {}) {
  if (rec.status !== 'running') return;
  rec.status = statusValue;
  rec.phase = statusValue === 'done' ? 'done' : statusValue;
  rec.summary = summary;
  rec.error = error;
  rec.label = null;
  rec.finishedAt = Date.now();
  rec.updatedAt = rec.finishedAt;
  flush();
  lastEmit.delete(rec.id);
  events.emit('fleet:data:done', { id: rec.id, app: rec.app, peer: rec.peer, name: rec.name, dir: rec.dir || 'down', ok: statusValue === 'done', summary: statusValue === 'done' ? summary : (error || summary) });
}

function launch(rec, { fresh }) {
  const controller = new AbortController();
  const entry = { controller, promise: null, cancelled: false, stopping: false };
  runs.set(rec.id, entry);
  entry.promise = runTransfer(rec, controller.signal, fresh)
    .then((r) => finish(rec, 'done', { summary: r.summary }))
    .catch((err) => {
      if (entry.cancelled || entry.stopping) return;
      if (err.cancelledOn) finish(rec, 'cancelled', { summary: `cancelled on ${err.cancelledOn}` });
      else finish(rec, 'failed', { error: err.message });
    })
    .finally(() => { if (runs.get(rec.id) === entry) runs.delete(rec.id); });
  return entry;
}

// The receiving end the run talks to. Down: the slave's /fleet-data routes,
// the blobs read from this master's files. Up: this master's own inbox
// (fleet-data-up.js), the blobs pulled from the slave. Both throw errors of
// one shape — `status` and the receiver's `body: { code, … }` — so the loop
// below classifies them the same way.
function endpointFor(rec, peer, files) {
  if (rec.dir === 'up') return d('upEndpoint')(rec, peer);
  const base = `/fleet-data/${rec.app}/${rec.name}/${rec.manifestSha}`;
  return {
    where: peer.name,
    status: (signal) => slave(peer, base, { signal, timeoutMs: 60000 }),
    plan: (manifest, sha, signal) => slave(peer, `/fleet-data/${rec.app}/plan`, { method: 'POST', body: { name: rec.name, manifest, sha, open: true }, signal, timeoutMs: 10 * 60 * 1000 }),
    async put(sha, offset, length, signal) {
      try {
        return await d('client').uploadFile(peer, `${base}/blobs/${sha}?offset=${offset}`, files.get(sha), { method: 'PUT', start: offset, length, signal, timeoutMs: 10 * 60 * 1000 });
      } catch (err) {
        if (err.status === 404 && !err.body?.code) throw routeMissing(peer);
        throw err;
      }
    },
    commit: (signal) => slave(peer, `${base}/commit`, { method: 'POST', signal, timeoutMs: 60000 }),
    async job(jobId, signal) {
      try { return await d('client').call(peer, `/jobs/${rec.app}/${jobId}`, { signal, timeoutMs: 15000 }); } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    },
    cancel: () => slave(peer, base, { method: 'DELETE', timeoutMs: 15000 }),
  };
}

async function runTransfer(rec, signal, fresh) {
  const peer = d('getPeer')(rec.peerId || rec.peer) || d('getPeer')(rec.peer);
  if (!peer) throw fatal(`peer ${rec.peer} is no longer linked`);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile(rec.manifestSha), 'utf-8')); } catch { throw fatal('the transfer\'s manifest is gone from the master'); }
  const v = M.validateManifest(manifest);
  if (v.sha !== rec.manifestSha) throw fatal('the stored manifest does not match the transfer\'s sha256');
  const files = rec.dir === 'up' ? null : await checkPaths(rec.app, v.manifest);
  const ep = endpointFor(rec, peer, files);
  let lastOk = Date.now();
  let backoff = opts.backoffMinMs;
  let firstPlan = fresh;
  const ok = () => { lastOk = Date.now(); backoff = opts.backoffMinMs; };

  for (;;) {
    if (signal.aborted) throw new Error('cancelled');
    try {
      // 1. Where does the receiver stand? (status first on a resume; else plan)
      let st = null;
      if (!firstPlan) st = await ep.status(signal);
      if (st && !st.exists && rec.commitJobId) {
        // The inbox is gone: the receive we started may have finished it.
        const r = await pollCommit(ep, rec, signal, ok);
        if (r) return r;
      }
      let need;
      let partial;
      let commitJobId = null;
      if (st?.exists && st.state === 'failed') throw fatal(st.error || `the transfer failed on ${ep.where}`);
      if (st?.exists) {
        need = st.need;
        partial = st.partial || {};
        if (st.state === 'committing') commitJobId = st.commit?.jobId || null;
      } else {
        rec.phase = 'plan';
        rec.label = null;
        progress(rec, { force: true });
        let p;
        try {
          p = await ep.plan(v.manifest, v.sha, signal);
        } catch (err) {
          if (firstPlan && err.body?.code === 'no-receiver') throw fatal(err.message);
          throw err;
        }
        ok();
        if (!p.fits) throw fatal(`does not fit on ${ep.where}: needs ${fmtBytes(p.needBytes)} + a ${fmtBytes(p.marginBytes)} margin, ${fmtBytes(p.freeBytes)} free`);
        need = p.need;
        partial = p.partial || {};
        if (p.state === 'committing') commitJobId = p.commitJobId || null;
        if (rec.needBytes == null) { rec.needBytes = p.needBytes; rec.blobsNeed = need.length; }
      }
      firstPlan = false;
      let remainingBytes = 0;
      for (const s of need) remainingBytes += (v.blobs.get(s) || 0) - (partial[s] || 0);
      if (rec.needBytes == null) { rec.needBytes = remainingBytes; rec.blobsNeed = need.length; }
      rec.sentBytes = Math.max(0, rec.needBytes - remainingBytes);
      rec.blobsDone = Math.max(0, (rec.blobsNeed || 0) - need.length);

      // 2. Send what is missing.
      if (!commitJobId && need.length) {
        rec.phase = 'sending';
        rec.label = null;
        progress(rec, { force: true });
        await sendBlobs(ep, rec, need, partial, v.blobs, signal, ok);
      }

      // 3. Commit → the receiver's receive job, polled to its end.
      rec.phase = 'receiving';
      rec.label = null;
      progress(rec, { force: true });
      if (commitJobId) rec.commitJobId = commitJobId;
      else {
        const c = await ep.commit(signal);
        ok();
        rec.commitJobId = c.jobId;
      }
      flush();
      const r = await pollCommit(ep, rec, signal, ok);
      if (r) return r;
      // The job vanished or was interrupted (app reload, a restart there): loop.
      rec.commitJobId = null;
      throw Object.assign(new Error(`the receive job on ${ep.where} was interrupted`), { status: null });
    } catch (err) {
      if (signal.aborted) throw err;
      // Up: the sending slave cancelled it (its byte source answers `cancelled`).
      if (err.body?.code === 'cancelled') {
        try { await ep.cancel(); } catch {}
        throw Object.assign(new Error(err.message), { cancelledOn: peer.name });
      }
      if (!isTransient(err)) throw err;
      if (Date.now() - lastOk > opts.unreachableMs) {
        throw new Error(`no progress with ${peer.name} for ${Math.round(opts.unreachableMs / 60000)} min: ${err.message}`);
      }
      rec.label = `retrying: ${err.message}`;
      progress(rec, { force: true });
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, opts.backoffMaxMs);
    }
  }
}

// Poll the receiver's receive job. Returns { summary } on success, null when
// the job is gone or was interrupted (the caller re-commits), throws on failure.
async function pollCommit(ep, rec, signal, ok) {
  for (;;) {
    if (signal.aborted) throw new Error('cancelled');
    const job = await ep.job(rec.commitJobId, signal);
    if (!job) { rec.commitJobId = null; return null; }
    ok();
    const label = job.progress?.label || null;
    if (label !== rec.label) { rec.label = label; progress(rec); }
    if (job.status === 'done') {
      const res = job.result || {};
      if (res.ok === true) return { summary: res.summary ?? null };
      throw fatal(String(res.summary || res.error || 'receive returned ok:false'));
    }
    if (job.status === 'error') throw fatal(job.error || 'receive failed');
    if (job.status === 'cancelled' || job.status === 'interrupted') { rec.commitJobId = null; return null; }
    await sleep(opts.pollMs, signal);
  }
}

async function sendBlobs(ep, rec, need, partial, sizes, signal, ok) {
  const queue = need.slice();
  const sendOne = async (sha) => {
    const bytes = sizes.get(sha);
    let offset = Math.min(partial[sha] || 0, bytes);
    for (;;) {
      if (signal.aborted) throw new Error('cancelled');
      const len = Math.min(opts.chunkBytes, bytes - offset);
      let r;
      try {
        r = await ep.put(sha, offset, len, signal);
      } catch (err) {
        if (err.status === 409 && err.body?.code === 'offset' && Number.isSafeInteger(err.body.offset)) {
          rec.sentBytes += err.body.offset - offset;
          offset = err.body.offset;
          continue;
        }
        if (err.status === 422 && err.body?.code === 'sha-mismatch') {
          ok();
          rec.wireBytes += len;
          rec.sentBytes -= offset;
          if (err.body.failed) throw fatal(err.message);
          offset = 0;                      // dropped by the receiver: send it again, once
          continue;
        }
        throw err;
      }
      ok();
      rec.wireBytes += len;
      rec.sentBytes += r.offset - offset;
      offset = r.offset;
      if (r.verified) {
        rec.blobsDone++;
        progress(rec, { force: rec.blobsDone === rec.blobsNeed });
        return;
      }
      progress(rec);
    }
  };
  let failure = null;
  const worker = async () => {
    while (queue.length && !failure) {
      const sha = queue.shift();
      try { await sendOne(sha); } catch (err) { failure = failure || err; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, queue.length)) }, worker));
  if (failure) throw failure;
}

module.exports = {
  init, shutdown, peers, plan, start, status, list, cancel, subscribe, events,
  stage, stagedManifest, startStaged, saveManifest,
  checkPaths, checkBlob, dataRoot, idOf, isTransient, fatal, FatalError, DEFAULTS,
};
