// Fleet data publish, UP direction — a slave app's blobs to the same app on
// its master (docs/fleet-data-up.md). The slave holds only the HASH of the
// peer token, so it never calls the master over HTTP: it asks over the live
// channel (`fr:req`, peer-channel.askMaster) and the MASTER drives — it pulls
// the manifest and byte ranges from the slave's /api/peer/fleet-data-up routes
// with its own peer client, into its own inbox. The run is fleet-data.js's
// (records with `dir: 'up'`, endpoint() below); inbox, sha verify, margin,
// receive job and expiry are fleet-data-receive.js's. One implementation each.
//
// Slave half:  master(app) · plan / publish / status / list / cancel / subscribe
//              offered(app, name, msha) · openRange(…)   what the routes serve
//              mirror records of its publishes, updated by the master's `fr:fd` pushes
// Master half: handleRequest(peer, op, args) (fd.info / fd.plan / fd.start /
//              fd.cancel / fd.sync) · endpoint(rec, peer) for the run · the pushes
//
// Slave state, <appsDir>/.fleet-data/:
//   up.json                { transfers: [entry] } — one per app + name + manifest
//   up-manifests/<sha>.json the manifests it offers (the master reads them)
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const M = require('./fleet-data-manifest');

const CHUNK_MAX = 8 * 1024 * 1024;
const MAX_ENTRIES = 200;
const TERMINAL_TTL_MS = 30 * 24 * 3600 * 1000;
const STAGED_TTL_MS = 8 * 24 * 3600 * 1000;      // a proposal lives 7 days
const SUMMARY_MAX = 32 * 1024;                     // a pushed record's summary (the frame is ≤ 128 KB)
const LIVE_JOB_GRACE_MS = 60 * 1000;               // a remote job that just ended still vouches for its publish
const ORIGIN_KINDS = new Set(['owner', 'ai', 'cron', 'bot', 'user']);
const STATUSES = new Set(['running', 'done', 'failed', 'cancelled']);
const ID_RE = /^fd-[0-9a-f]{24}$/;

class UpError extends Error {
  constructor(message, status = 400, code = 'bad-request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let opts = {};
let entries = [];             // slave: newest first
let persistTimer = null;
let offs = [];
const masterCache = new Map(); // slave: app → last fd.info answer
const manifestCache = new Map(); // slave: msha → { v, at }
const events = new EventEmitter();
events.setMaxListeners(0);

function d(name) {
  if (opts[name]) return opts[name];
  switch (name) {
    case 'engine': return require('./fleet-data');
    case 'receive': return require('./fleet-data-receive');
    case 'client': return require('./peer-client');
    case 'appJobs': return require('./app-jobs');
    case 'getPeer': return (ref) => require('./peer-pairing').getPeer(ref);
    case 'channel': return require('./peer-channel');
    case 'ask': return (op, args, o) => require('./peer-channel').askMaster(op, args, o);
    case 'push': return (peer, frame) => require('./peer-channel').sendToSlave(peer, frame);
    case 'masterConnected': return () => require('./peer-channel').masterConnected();
    case 'isSlave': return () => require('./host-config').isSlave();
    case 'masterHost': return () => { try { return new URL(require('./host-config').slaveInfo()?.masterUrl).hostname || null; } catch { return null; } };
    case 'appExists': return (app) => !!require('./app-manager').readManifest(app);
    case 'dataDir': return (app) => path.join(require('./app-manager').appDir(app), '.data');
    case 'stateDir': return path.join(require('./app-manager').APPS_DIR, '.fleet-data');
    case 'remote': return require('./fleet-remote');
    case 'governance': return require('./governance/horst-governance');
    default: return null;
  }
}
const stateFile = () => path.join(d('stateDir'), 'up.json');
const manifestFile = (sha) => path.join(d('stateDir'), 'up-manifests', `${sha}.json`);

// init({ ...deps }) wires both halves: the master answers its slaves'
// requests and pushes their records; the slave reads its entries and re-syncs
// them each time its master connects.
function init(options = {}) {
  for (const off of offs) { try { off(); } catch {} }
  offs = [];
  opts = { ...options };
  entries = [];
  masterCache.clear();
  manifestCache.clear();
  try { entries = JSON.parse(fs.readFileSync(stateFile(), 'utf-8')).transfers || []; } catch {}
  prune();
  if (options.wire === false) return;
  const ch = d('channel');
  try { if (ch?.onSlaveRequest) offs.push(ch.onSlaveRequest((peer, op, args) => handleRequest(peer, op, args))); } catch {}
  try { if (ch?.onMasterFrame) offs.push(ch.onMasterFrame((msg) => onMasterFrame(msg))); } catch {}
  try { if (ch?.onMasterConnect) offs.push(ch.onMasterConnect(() => { sync().catch(() => {}); })); } catch {}
  wirePushes();
}

function wirePushes() {
  try { offs.push(d('engine').subscribe((event, data) => { if (data.dir === 'up') pushRecord(data.id); })); } catch {}
}

function shutdown() {
  for (const off of offs) { try { off(); } catch {} }
  offs = [];
  flush();
}

// =============================================================================
// Slave half
// =============================================================================

function flush() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  if (!entries.length && !fs.existsSync(stateFile())) return;   // nothing to keep (a master)
  try {
    fs.mkdirSync(d('stateDir'), { recursive: true });
    const tmp = stateFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ transfers: entries }));
    fs.renameSync(tmp, stateFile());
  } catch (err) {
    console.warn(`[fleet-data-up] state save failed: ${err.message}`);
  }
}
function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(flush, 2000);
  persistTimer.unref?.();
}

function prune() {
  const now = Date.now();
  entries = entries
    .filter((e) => (e.status === 'running')
      || (STATUSES.has(e.status) ? (e.finishedAt || e.updatedAt || 0) >= now - TERMINAL_TTL_MS : (e.updatedAt || 0) >= now - STAGED_TTL_MS))
    .slice(0, MAX_ENTRIES);
  const keep = new Set(entries.map((e) => e.manifestSha));
  let files = [];
  try { files = fs.readdirSync(path.dirname(manifestFile('x'))); } catch {}
  for (const f of files) {
    if (!keep.has(f.replace(/\.json$/, ''))) { try { fs.rmSync(path.join(path.dirname(manifestFile('x')), f), { force: true }); } catch {} }
  }
}

function keyOf(app, name, sha) { return `${app}/${name}/${sha}`; }
function byKey(key) { return entries.find((e) => e.key === key) || null; }
function byId(id) { return entries.find((e) => e.id && e.id === id) || null; }

// What an app sees: started publishes only (a proposal has no record yet, as
// in the down direction), without the internal key.
function publicEntry(e) {
  if (!e || !STATUSES.has(e.status) || !e.id) return null;
  const { key, pushSeq, ...rest } = e;
  return JSON.parse(JSON.stringify(rest));
}

// prev = { status, finishedAt } before a change: a done event fires once per end.
function emitEntry(e, prev = null) {
  if (!e.id) return;
  if (e.status === 'running') {
    events.emit('fleet:data:progress', {
      id: e.id, app: e.app, peer: e.peer, name: e.name, dir: 'up', sentBytes: e.sentBytes ?? 0, needBytes: e.needBytes ?? null,
      blobs: { total: e.blobs ?? null, need: e.blobsNeed ?? null, done: e.blobsDone ?? 0 }, phase: e.phase || 'plan', label: e.label ?? null,
    });
  } else if (STATUSES.has(e.status)) {
    const prevEnded = prev && STATUSES.has(prev.status) && prev.status !== 'running';
    if (prevEnded && prev.status === e.status && (prev.status === 'cancelled' || prev.finishedAt === e.finishedAt)) return;
    events.emit('fleet:data:done', { id: e.id, app: e.app, peer: e.peer, name: e.name, dir: 'up', ok: e.status === 'done', summary: e.status === 'done' ? (e.summary ?? null) : (e.error || e.summary || e.status) });
  }
}

// subscribe(fn(event, data)) → unsubscribe; the slave's view of its up
// publishes, the same payloads as fleet-data.js's (`dir: 'up'`, `peer` the master's host).
function subscribe(fn) {
  const a = (x) => fn('fleet:data:progress', x);
  const b = (x) => fn('fleet:data:done', x);
  events.on('fleet:data:progress', a);
  events.on('fleet:data:done', b);
  return () => { events.off('fleet:data:progress', a); events.off('fleet:data:done', b); };
}

// The master as one more peer, or null when this host is no fleet slave.
async function master(app) {
  if (!d('isSlave')()) return null;
  const host = d('masterHost')();
  if (!host) return null;
  const online = !!d('masterConnected')();
  const row = { peer: host, host, label: host, online, receivers: [], app: null, disk: null, error: null };
  const cached = app ? masterCache.get(app) : null;
  if (cached) Object.assign(row, { receivers: cached.receivers, app: cached.app, disk: cached.disk });
  if (online && app) {
    try {
      const r = await d('ask')('fd.info', { app }, { timeoutMs: 8000 });
      const info = {
        receivers: Array.isArray(r?.receivers) ? r.receivers.filter((p) => typeof p === 'string').slice(0, 100) : [],
        app: { installed: !!r?.installed, enabled: !!r?.enabled, running: !!r?.running, version: r?.version ?? null },
        disk: { freeBytes: r?.freeBytes ?? null, marginBytes: r?.marginBytes ?? null },
      };
      masterCache.set(app, info);
      Object.assign(row, info);
    } catch (err) {
      row.error = err.code === 'no-handler' ? 'update vistaclair-pro on the master' : err.message;
    }
  }
  return row;
}

function resolveMaster(ref) {
  if (!d('isSlave')()) throw new Error('this host is no fleet slave');
  const host = d('masterHost')();
  if (!host) throw new Error('this slave is not linked to a master');
  const want = ref && typeof ref === 'object' ? (ref.peer || ref.host) : ref;
  if (want !== host) throw new Error(`unknown peer "${want}" — on a slave the only peer is the master ("${host}", ctx.fleet.master())`);
  return host;
}

function masterError(err) {
  if (err.code === 'offline' || err.code === 'disconnected' || err.code === 'timeout') {
    return Object.assign(new Error(`the master is not reachable (${err.code}) — try again when it is connected`), { code: 'E_OFFLINE' });
  }
  if (err.code === 'no-handler') return Object.assign(new Error('the master does not take data publishes from slaves — update vistaclair-pro there'), { code: err.code });
  return err;
}

// The sending side's checks (the same as a master's down publish) and the
// manifest offered under its sha; the entry the routes serve from.
async function offer(app, name, manifest) {
  if (!require('./peer-security').isAppName(app)) throw new Error(`bad app name "${app}"`);
  if (!d('appExists')(app)) throw new Error(`unknown app "${app}"`);
  if (!M.isName(name)) throw new Error('name must match [a-z0-9._-]{1,64}');
  const v = M.validateManifest(manifest);
  await d('engine').checkPaths(app, v.manifest, { dataDir: d('dataDir')(app) });
  const file = manifestFile(v.sha);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file + '.tmp', JSON.stringify(v.manifest));
    fs.renameSync(file + '.tmp', file);
  }
  const key = keyOf(app, name, v.sha);
  let e = byKey(key);
  let totalBytes = 0;
  for (const b of v.blobs.values()) totalBytes += b;
  if (!e) {
    e = { key, id: null, app, peer: d('masterHost')(), name, manifestSha: v.sha, dir: 'up', status: 'staged', phase: null, label: null,
      sentBytes: 0, needBytes: null, blobs: v.blobs.size, blobsNeed: null, blobsDone: 0, totalBytes, summary: null, error: null,
      meta: null, origin: null, proposalId: null, createdAt: Date.now(), updatedAt: Date.now(), finishedAt: null };
    entries.unshift(e);
    prune();
  } else if (e.status === 'cancelled' || e.status === 'staged') {
    e.status = 'staged';
    e.updatedAt = Date.now();
  }
  flush();
  return { v, e, totalBytes };
}

async function plan(app, peerRef, { name, manifest } = {}) {
  const host = resolveMaster(peerRef);
  const { v } = await offer(app, name, manifest);
  let r;
  try { r = await d('ask')('fd.plan', { app, name, manifestSha: v.sha }, { timeoutMs: 10 * 60 * 1000 }); } catch (err) { throw masterError(err); }
  return {
    peer: host, name, manifestSha: v.sha, blobs: v.blobs.size, need: r.need, needBytes: r.needBytes,
    haveBytes: r.haveBytes, freeBytes: r.freeBytes, marginBytes: r.marginBytes, fits: r.fits,
  };
}

// publish → the master decides (docs/fleet-data-up.md "Governance") and
// answers { id, attached? } or { id, proposed: true, proposalId }.
async function publish(app, peerRef, { name, manifest, meta, origin } = {}) {
  resolveMaster(peerRef);
  if (meta !== undefined && meta !== null) {
    let raw;
    try { raw = JSON.stringify(meta); } catch { throw new Error('meta must be JSON'); }
    if (Buffer.byteLength(raw) > 16 * 1024) throw new Error('meta is over 16 KB');
  }
  const { v, e } = await offer(app, name, manifest);
  const seq0 = e.pushSeq || 0;   // a master push during the ask is newer than its answer
  let r;
  try {
    r = await d('ask')('fd.start', { app, name, manifestSha: v.sha, meta: meta ?? null, origin: origin || { kind: 'user' } }, { timeoutMs: 10 * 60 * 1000 });
  } catch (err) { throw masterError(err); }
  if (!r || !ID_RE.test(String(r.id))) throw new Error('the master answered without a transfer id');
  e.id = r.id;
  e.meta = meta == null ? null : JSON.parse(JSON.stringify(meta));
  e.origin = origin || null;
  e.updatedAt = Date.now();
  const pushed = (e.pushSeq || 0) !== seq0;
  if (r.proposed) {
    if (!pushed && e.status !== 'running') { e.status = 'proposed'; e.proposalId = r.proposalId || null; }
  } else if (!pushed && e.status !== 'running') {
    Object.assign(e, { status: 'running', phase: 'plan', label: null, summary: null, error: null, finishedAt: null, sentBytes: 0, blobsDone: 0 });
    emitEntry(e);
  }
  flush();
  return r.proposed ? { id: r.id, proposed: true, proposalId: r.proposalId || null } : { id: r.id, ...(r.attached ? { attached: true } : {}) };
}

function status(id) { return publicEntry(byId(String(id || ''))); }

function list({ app, peer, name } = {}) {
  return entries
    .filter((e) => (!app || e.app === app) && (!peer || e.peer === peer) && (!name || e.name === name))
    .map(publicEntry).filter(Boolean);
}

// Cancel from the slave: it stops offering the bytes at once (the master's
// next range read gets `cancelled` and ends its record), and tells the master
// when it can (which then drops its inbox).
async function cancel(id) {
  const e = byId(String(id || ''));
  if (!e || !STATUSES.has(e.status)) return { ok: false, error: 'unknown transfer' };
  if (e.status !== 'running') return { ok: false, error: `transfer already ${e.status}` };
  Object.assign(e, { status: 'cancelled', phase: 'cancelled', label: null, summary: 'cancelled', finishedAt: Date.now(), updatedAt: Date.now() });
  flush();
  emitEntry(e);
  let masterCleared = false;
  try { const r = await d('ask')('fd.cancel', { id: e.id }, { timeoutMs: 15000 }); masterCleared = !!r?.ok || /already/.test(String(r?.error || '')); } catch {}
  return { ok: true, masterCleared };
}

// A master push: `fr:fd { rec }` — one record of this slave's up publishes.
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
function applyRecord(rec) {
  if (!rec || typeof rec !== 'object' || !ID_RE.test(String(rec.id))) return;
  if (!require('./peer-security').isAppName(rec.app) || !M.isName(rec.name) || !M.isSha(rec.manifestSha) || !STATUSES.has(rec.status)) return;
  const key = keyOf(rec.app, rec.name, rec.manifestSha);
  let e = byId(rec.id) || byKey(key);
  if (!e) {
    e = { key, id: rec.id, app: rec.app, peer: d('masterHost')(), name: rec.name, manifestSha: rec.manifestSha, dir: 'up', status: 'staged', meta: null, origin: null, proposalId: null, createdAt: Date.now() };
    entries.unshift(e);
  }
  // A cancel here stands until the master confirms an end of its own.
  if (e.status === 'cancelled' && rec.status === 'running') return;
  const prev = { status: e.status, finishedAt: e.finishedAt };
  e.pushSeq = (e.pushSeq || 0) + 1;
  let summary = rec.summary ?? null;
  try { if (summary != null && Buffer.byteLength(JSON.stringify(summary)) > SUMMARY_MAX) summary = null; } catch { summary = null; }
  Object.assign(e, {
    id: rec.id, status: rec.status, phase: typeof rec.phase === 'string' ? rec.phase.slice(0, 32) : null,
    label: typeof rec.label === 'string' ? rec.label.slice(0, 2048) : null,
    sentBytes: num(rec.sentBytes) ?? 0, needBytes: num(rec.needBytes), blobs: num(rec.blobs) ?? e.blobs ?? null,
    blobsNeed: num(rec.blobsNeed), blobsDone: num(rec.blobsDone) ?? 0, totalBytes: num(rec.totalBytes) ?? e.totalBytes ?? null,
    summary, error: typeof rec.error === 'string' ? rec.error.slice(0, 4096) : null,
    startedAt: num(rec.startedAt), finishedAt: num(rec.finishedAt), updatedAt: Date.now(),
  });
  if (e.status !== 'running') flush(); else persistSoon();
  emitEntry(e, prev);
}

function onMasterFrame(msg) {
  if (msg?.type === 'fr:fd') applyRecord(msg.rec);
}

// On (re)connect: the master's records of this slave's publishes. A running
// entry the master no longer knows ended while the link was down.
async function sync() {
  if (!d('isSlave')()) return;
  const live = entries.filter((e) => e.id && e.status === 'running');
  let r;
  try { r = await d('ask')('fd.sync', {}, { timeoutMs: 30000 }); } catch { return; }
  const recs = Array.isArray(r?.transfers) ? r.transfers : [];
  for (const rec of recs) applyRecord(rec);
  const known = new Set(recs.map((x) => x?.id));
  for (const e of live) {
    if (known.has(e.id) || e.status !== 'running') continue;
    Object.assign(e, { status: 'failed', phase: 'failed', error: 'the master no longer has this transfer', label: null, finishedAt: Date.now(), updatedAt: Date.now() });
    emitEntry(e);
  }
  flush();
}

// --- What the routes serve (peer-token authed: the master) ---------------------

function checkIds(app, name, msha, sha) {
  if (!require('./peer-security').isAppName(app)) throw new UpError('bad app name', 400, 'bad-app');
  if (!M.isName(name)) throw new UpError('bad transfer name', 400, 'bad-name');
  if (!M.isSha(msha)) throw new UpError('bad manifest sha256', 400, 'bad-sha');
  if (sha !== undefined && !M.isSha(sha)) throw new UpError('bad blob sha256', 400, 'bad-blob');
}

function offeredEntry(app, name, msha) {
  const e = byKey(keyOf(app, name, msha));
  if (!e) throw new UpError(`this slave does not offer "${name}" of ${app} (${msha.slice(0, 12)}…)`, 410, 'not-offered');
  if (e.status === 'cancelled') throw new UpError(`the publish of "${name}" was cancelled on this slave`, 410, 'cancelled');
  return e;
}

function loadOffered(msha) {
  const hit = manifestCache.get(msha);
  if (hit) return hit;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(manifestFile(msha), 'utf-8')); } catch { throw new UpError('the offered manifest is gone from this slave', 410, 'not-offered'); }
  const v = M.validateManifest(raw);
  if (v.sha !== msha) throw new UpError('the offered manifest does not match its sha256', 410, 'not-offered');
  const bySha = new Map();
  for (const b of v.manifest.blobs) if (!bySha.has(b.sha256)) bySha.set(b.sha256, b);
  const out = { v, bySha };
  if (manifestCache.size > 20) manifestCache.clear();
  manifestCache.set(msha, out);
  return out;
}

// GET …/manifest → { manifest } (the canonical one; the master re-hashes it).
function offered(app, name, msha) {
  checkIds(app, name, msha);
  offeredEntry(app, name, msha);
  return { manifest: loadOffered(msha).v.manifest };
}

// GET …/blobs/:sha?offset&length → the file range to stream, after the same
// path checks as at publish time (the file may have changed since).
async function openRange(app, name, msha, sha, offset, length) {
  checkIds(app, name, msha, sha);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new UpError('bad offset', 400, 'bad-offset');
  if (!Number.isSafeInteger(length) || length < 0) throw new UpError('bad length', 400, 'bad-length');
  if (length > CHUNK_MAX) throw new UpError(`range over ${CHUNK_MAX / 1048576} MB`, 413, 'chunk-too-big');
  const e = offeredEntry(app, name, msha);
  const b = loadOffered(msha).bySha.get(sha);
  if (!b) throw new UpError('blob is not part of this manifest', 400, 'not-needed');
  if (offset + length > b.bytes) throw new UpError(`range ends past the blob's ${b.bytes} bytes`, 400, 'past-end');
  let file;
  try {
    const engine = d('engine');
    file = await engine.checkBlob(await engine.dataRoot(app, d('dataDir')(app)), b);
  } catch (err) {
    throw new UpError(`${err.message} on this slave`, 409, 'source-gone');
  }
  e.lastServedAt = Date.now();
  persistSoon();
  return { file, start: offset, length };
}

// =============================================================================
// Master half
// =============================================================================

function hostOf(peer) { try { return new URL(peer.baseUrl).hostname; } catch { return peer.name; } }

function slim(rec) {
  let summary = rec.summary ?? null;
  try { if (summary != null && Buffer.byteLength(JSON.stringify(summary)) > SUMMARY_MAX) summary = '(summary over 32 KB — see the master)'; } catch { summary = null; }
  return {
    id: rec.id, app: rec.app, name: rec.name, manifestSha: rec.manifestSha, status: rec.status, phase: rec.phase, label: rec.label ?? null,
    sentBytes: rec.sentBytes ?? 0, needBytes: rec.needBytes ?? null, blobs: rec.blobs ?? null, blobsNeed: rec.blobsNeed ?? null,
    blobsDone: rec.blobsDone ?? 0, totalBytes: rec.totalBytes ?? null, summary, error: rec.error ?? null,
    startedAt: rec.startedAt ?? null, finishedAt: rec.finishedAt ?? null,
  };
}

function pushRecord(id) {
  const rec = d('engine').status(id);
  if (!rec || rec.dir !== 'up') return;
  try { d('push')(rec.peer, { type: 'fr:fd', rec: slim(rec) }); } catch {}
}

// The receiving endpoint of fleet-data.js's run for an up record: this
// master's own inbox, the bytes pulled from the slave. FleetDataErrors become
// the wire shape the run classifies ({ status, body: { code, … } }).
function wire(err) {
  const R = d('receive');
  if (err instanceof R.FleetDataError) return Object.assign(new Error(err.message), { status: err.status, body: { code: err.code, error: err.message, ...err.extra } });
  if (err && err.status === undefined) err.status = null;   // a stream / fs error: transient
  return err;
}
async function local(fn) { try { return await fn(); } catch (err) { throw wire(err); } }

function endpoint(rec, peer) {
  const R = d('receive');
  const base = `/fleet-data-up/${rec.app}/${rec.name}/${rec.manifestSha}`;
  const from = hostOf(peer);
  return {
    where: 'this master',
    status: () => local(() => R.status(rec.app, rec.name, rec.manifestSha)),
    plan: (manifest, sha) => local(() => R.plan(rec.app, { name: rec.name, manifest, sha, open: true, dir: 'up', peer: from })),
    async put(sha, offset, length, signal) {
      let src;
      try {
        src = await d('client').download(peer, `${base}/blobs/${sha}?offset=${offset}&length=${length}`, { signal, timeoutMs: 10 * 60 * 1000 });
      } catch (err) {
        if (err.status === 404 && !err.body?.code) throw d('engine').fatal(`${peer.name} has no fleet data up routes (HTTP 404) — update vistaclair-pro there`);
        throw err;
      }
      if (src.length !== length) {
        src.stream.destroy();
        throw Object.assign(new Error(`${peer.name} answered ${src.length} bytes for a ${length}-byte range`), { status: null });
      }
      try {
        return await local(() => R.writeChunk(rec.app, rec.name, rec.manifestSha, sha, offset, length, src.stream));
      } finally {
        if (!src.stream.readableEnded) src.stream.destroy();
      }
    },
    commit: () => local(() => R.commit(rec.app, rec.name, rec.manifestSha)),
    async job(jobId) {
      const j = d('appJobs').getJob(rec.app, jobId);
      if (!j) return null;
      return { id: j.id, status: j.status, progress: j.progress, meta: j.meta, result: j.result, error: j.error };
    },
    cancel: () => local(() => R.cancel(rec.app, rec.name, rec.manifestSha)),
  };
}

async function fetchManifest(peer, app, name, msha) {
  let r;
  try {
    r = await d('client').call(peer, `/fleet-data-up/${app}/${name}/${msha}/manifest`, { timeoutMs: 2 * 60 * 1000, maxBytes: M.MAX_MANIFEST_BYTES + 1024 * 1024 });
  } catch (err) {
    if (err.status === 404 && !err.body?.code) throw new UpError(`${peer.name} has no fleet data up routes — update vistaclair-pro there`, 409, 'no-route');
    throw new UpError(`reading the manifest from ${peer.name} failed: ${err.message}`, 409, err.body?.code || 'no-manifest');
  }
  let v;
  try { v = M.validateManifest(r?.manifest); } catch (err) { throw new UpError(err.message, 400, 'bad-manifest'); }
  if (v.sha !== msha) throw new UpError('the manifest sha256 differs between the slave and this master — both must run a vistaclair-pro with the same manifest format', 400, 'sha-differs');
  return v;
}

function cleanOrigin(o) {
  const out = { kind: o && ORIGIN_KINDS.has(o.kind) ? o.kind : 'user' };
  if (o && typeof o.route === 'string' && o.route) out.route = o.route.slice(0, 200);
  if (o && typeof o.tool === 'string' && o.tool) out.tool = o.tool.slice(0, 200);
  if (o && typeof o.jobId === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(o.jobId)) out.jobId = o.jobId;
  if (o && require('./fleet-remote-wire').isId(o.remoteJob)) out.remoteJob = o.remoteJob;
  return out;
}

// Who may start it, decided HERE from this master's own records (the slave's
// word is only the remote job id it runs under):
//   inside a remote job this master started for this app on this slave, live
//   (or ended < 60 s ago), whose origin is the owner        → `owner via fleet.jobs <id>`
//   … or whose proposal the owner approved (app.remote_job,
//   payload.id = that record, approved / executed)            → `owner (approved <pid>) via fleet.jobs <id>`
//   the owner's own click on the slave, from a peer this master's record
//   trusts for it (peer.trustOwnerClicks)                    → `owner on <peer> via app:<app>`
//   anything else                                            → null: an app.data_publish proposal here
function decide(peerName, app, origin) {
  if (origin.remoteJob) {
    const id = origin.remoteJob;
    const rec = d('remote').status(id);
    if (!rec || rec.app !== app || rec.peer !== peerName) return null;
    const live = rec.status === 'running' || rec.status === 'starting'
      || (rec.status === 'done' && Date.now() - (rec.endedAt || 0) < LIVE_JOB_GRACE_MS);
    if (!live) return null;
    if (rec.origin?.kind === 'owner') return { via: `owner via fleet.jobs ${id}`, proposalId: null };
    const pid = rec.origin?.proposalId || rec.proposalId;
    if (!pid) return null;
    let p = null;
    try { p = d('governance').getProposal(pid); } catch {}
    if (p && p.kind === 'app.remote_job' && p.payload?.id === id && (p.status === 'approved' || p.status === 'executed')) {
      return { via: `owner (approved ${pid}) via fleet.jobs ${id}`, proposalId: pid };
    }
    return null;
  }
  // The slave's word that this was its owner's click is only believed for a
  // peer this master's own record trusts for it (peer.trustOwnerClicks, set by
  // the owner here): a slave cannot vouch for itself.
  if (origin.kind === 'owner' && d('getPeer')(peerName)?.trustOwnerClicks === true) {
    return { via: `owner on ${peerName} via app:${app}`, proposalId: null };
  }
  return null;
}

function fmtBytes(n) {
  if (n == null) return 'unknown';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return Math.round(n / 1024) + ' KB';
}

async function startFromSlave(peer, { app, name, manifestSha, meta, origin: rawOrigin }) {
  const engine = d('engine');
  const R = d('receive');
  const origin = cleanOrigin(rawOrigin);
  const v = await fetchManifest(peer, app, name, manifestSha);
  const verdict = decide(peer.name, app, origin);
  // The kind recorded and shown is the master's own judgement: 'owner' only
  // when decide() accepted it, never the slave's bare claim.
  if (!verdict && origin.kind === 'owner') origin.kind = 'user';
  if (verdict) {
    const r = await engine.start(app, peer.name, { name, manifest: v.manifest, meta, origin: { ...origin, via: verdict.via, ...(verdict.proposalId ? { proposalId: verdict.proposalId } : {}) }, dir: 'up' });
    if (!r.attached) {
      const rec = engine.status(r.id);
      try {
        d('governance').audit({
          action: 'executed', kind: 'app.data_publish', ok: true, via: verdict.via, proposalId: verdict.proposalId,
          summary: `Data publish "${name}" of app "${app}" from slave "${peer.name}" to this master (${rec?.blobs ?? '?'} blobs, ${fmtBytes(rec?.totalBytes)}) — ${verdict.via}, transfer ${r.id}`,
        });
      } catch (err) { console.warn(`[fleet-data-up] ledger row for ${r.id} failed: ${err.message}`); }
    }
    return { id: r.id, ...(r.attached ? { attached: true } : {}) };
  }
  const st = await engine.stage(app, peer.name, { name, manifest: v.manifest, dir: 'up' });
  let needBytes = null;
  let fits = null;
  try { const p = await R.plan(app, { name, manifest: v.manifest, sha: v.sha }); needBytes = p.needBytes; fits = p.fits; } catch {}
  const payload = {
    dir: 'up', app, peer: st.peer, name, manifestSha: st.manifestSha, blobs: st.blobs, totalBytes: st.totalBytes,
    needBytes, fits, meta: meta == null ? null : JSON.parse(JSON.stringify(meta)), origin,
  };
  const r = await d('governance').requestAction('app.data_publish', payload, { origin: origin.kind === 'cron' ? 'cron' : 'peer' });
  return { id: st.id, proposed: true, proposalId: r?.proposal?.id || null };
}

// One slave request (peer-channel `fr:req`). Throws → `fr:reply` with err.code.
async function handleRequest(peerName, op, args = {}) {
  const peer = d('getPeer')(peerName);   // a slave has no linked peers: refused here
  if (!peer) throw new UpError('unknown peer', 403, 'unknown-peer');
  const app = args.app;
  const checkApp = () => {
    if (!require('./peer-security').isAppName(app)) throw new UpError('bad app name', 400, 'bad-app');
    if (!d('appExists')(app)) throw new UpError(`app "${app}" is not installed on the master`, 404, 'no-app');
  };
  try {
    switch (op) {
      case 'fd.info': {
        checkApp();
        const i = d('receive').info(app);
        return { installed: i.installed, enabled: i.enabled, running: i.running, version: i.version, freeBytes: i.freeBytes, marginBytes: i.marginBytes, receivers: i.receivers };
      }
      case 'fd.plan': {
        checkApp();
        if (!M.isName(args.name) || !M.isSha(args.manifestSha)) throw new UpError('bad name or manifest sha256', 400, 'bad-name');
        const v = await fetchManifest(peer, app, args.name, args.manifestSha);
        const p = await d('receive').plan(app, { name: args.name, manifest: v.manifest, sha: v.sha });
        return { need: p.need, needBytes: p.needBytes, haveBytes: p.haveBytes, freeBytes: p.freeBytes, marginBytes: p.marginBytes, fits: p.fits };
      }
      case 'fd.start': {
        checkApp();
        if (!M.isName(args.name) || !M.isSha(args.manifestSha)) throw new UpError('bad name or manifest sha256', 400, 'bad-name');
        return await startFromSlave(peer, args);
      }
      case 'fd.cancel': {
        const rec = d('engine').status(String(args.id || ''));
        if (!rec || rec.dir !== 'up' || rec.peer !== peer.name) return { ok: false, error: 'unknown transfer' };
        return await d('engine').cancel(rec.id);
      }
      case 'fd.sync':
        return { transfers: d('engine').list({ peer: peer.name, dir: 'up' }).slice(0, 100).map(slim) };
      default:
        throw new UpError(`unknown op "${op}"`, 400, 'no-handler');
    }
  } catch (err) {
    const R = d('receive');
    if (err instanceof R.FleetDataError || err instanceof UpError) throw Object.assign(new Error(err.message), { code: err.code });
    throw err;
  }
}

module.exports = {
  init, shutdown, subscribe, events,
  // slave
  master, plan, publish, status, list, cancel, offered, openRange, sync, onMasterFrame, applyRecord,
  // master
  handleRequest, endpoint, decide, slim,
  UpError, CHUNK_MAX,
};
