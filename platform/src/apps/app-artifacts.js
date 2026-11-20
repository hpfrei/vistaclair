// Artifact store — files an app tool hands to its caller as a reference
// (`vc-artifact://<id>`), never as an absolute path (docs/tool-jobs-artifacts.md "Artifacts").
//
//   <dataHome>/artifacts/blobs/<sha[0:2]>/<sha256>   content-addressed, deduplicated
//   <dataHome>/artifacts/meta/<id>.json              one record per artifact
//   <dataHome>/artifacts/tmp/                        in-flight copies (same filesystem)
//
// An id is `art_<first 16 hex of sha256>-<4 random hex>`: one blob can back
// several ids with different producers and names. Records carry who may read
// them (`grants`, principal keys) and who keeps them alive (`pins`).
//
// Principals: { type: 'app', app } | { type: 'run', runId } (any orchestrator
// or worker of that run) | { type: 'owner' } (reads everything). The producing
// app always reads its own artifacts. principalOf(caller) maps the typed
// tool callers of app-tools.js onto them.
//
// Blobs are immutable: the app's file is copied in (a copy-on-write clone where
// the filesystem supports one), never moved or hardlinked — a hardlink would
// let the app's next in-place write rewrite every record that shares the blob.
// The same holds for import/copyTo out of the store.
//
// gc() drops unpinned records older than `artifactRetentionDays` and blobs no
// record uses; `put` refuses above the per-owner quota `artifactAppQuotaMB`.
// Both settings live in platform-settings. Runs at boot and daily (index.js).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEME = 'vc-artifact://';
const ID_RE = /^art_[0-9a-f]{16}-[0-9a-f]{4}$/;
const REF_RE = /vc-artifact:\/\/(art_[0-9a-f]{16}-[0-9a-f]{4})/g;
const DAY_MS = 24 * 3600e3;
const TMP_STALE_MS = DAY_MS;

const MIME = {
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.obj': 'model/obj', '.stl': 'model/stl',
  '.fbx': 'application/octet-stream', '.usdz': 'model/vnd.usdz+zip', '.blend': 'application/x-blender',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus',
  '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.json': 'application/json', '.csv': 'text/csv', '.txt': 'text/plain', '.md': 'text/markdown',
  '.html': 'text/html', '.htm': 'text/html', '.xml': 'application/xml', '.yaml': 'application/yaml', '.yml': 'application/yaml',
  '.apk': 'application/vnd.android.package-archive', '.wasm': 'application/wasm',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

let root = null;
let overrides = {};
let records = null; // id → record, loaded lazily from meta/

// init({ dir, retentionDays?, quotaMB? }) — `dir` is <dataHome>/artifacts.
// The two overrides are for tests; the platform reads platform-settings.
function init(options = {}) {
  if (!options.dir) throw new Error('app-artifacts.init requires dir');
  root = options.dir;
  overrides = { retentionDays: options.retentionDays, quotaMB: options.quotaMB };
  records = null;
  return root;
}

function rootDir() {
  if (root) return root;
  const appManager = require('./app-manager');
  root = path.join(appManager.APPS_DIR, '..', 'data', 'artifacts');
  return root;
}
const metaDir = () => path.join(rootDir(), 'meta');
const blobsDir = () => path.join(rootDir(), 'blobs');
const tmpDir = () => path.join(rootDir(), 'tmp');

function setting(key, fallback) {
  try { const v = require('./platform-settings').get(key); return v == null ? fallback : v; } catch { return fallback; }
}
function retentionMs() {
  const d = Number(overrides.retentionDays != null ? overrides.retentionDays : setting('artifactRetentionDays', 30));
  return (Number.isFinite(d) && d > 0 ? d : 30) * DAY_MS;
}
function quotaBytes() {
  const mb = Number(overrides.quotaMB != null ? overrides.quotaMB : setting('artifactAppQuotaMB', 5120));
  return (Number.isFinite(mb) && mb > 0 ? mb : 5120) * 1024 * 1024;
}

// ---- records ----------------------------------------------------------------

function load() {
  if (records) return records;
  records = new Map();
  let files = [];
  try { files = fs.readdirSync(metaDir()); } catch {}
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(metaDir(), f), 'utf-8'));
      if (r && ID_RE.test(r.id)) records.set(r.id, r);
    } catch {}
  }
  return records;
}

function saveRecord(r) {
  fs.mkdirSync(metaDir(), { recursive: true });
  const file = path.join(metaDir(), `${r.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
  fs.renameSync(tmp, file);
  load().set(r.id, r);
}

function dropRecord(id) {
  try { fs.unlinkSync(path.join(metaDir(), `${id}.json`)); } catch {}
  load().delete(id);
}

function idOf(ref) {
  if (ref && typeof ref === 'object') ref = ref.id || ref.uri;
  if (typeof ref !== 'string') return null;
  const s = ref.startsWith(SCHEME) ? ref.slice(SCHEME.length) : ref;
  return ID_RE.test(s) ? s : null;
}

function linkOf(r) {
  const link = { type: 'resource_link', uri: SCHEME + r.id, name: r.name, mimeType: r.mime, size: r.size };
  if (r.description) link.description = r.description;
  return link;
}

// The record as callers see it — never the blob path.
function view(r) {
  return {
    id: r.id, uri: SCHEME + r.id, sha256: r.sha256, size: r.size, mime: r.mime, name: r.name,
    createdAt: r.createdAt, producer: { ...r.producer }, app: r.app || null,
    labels: { ...(r.labels || {}) }, pinned: (r.pins || []).length > 0,
    pins: (r.pins || []).map((p) => ({ ...p })), grants: (r.grants || []).slice(),
    link: linkOf(r),
  };
}

function get(ref) {
  const id = idOf(ref);
  const r = id && load().get(id);
  return r ? view(r) : null;
}

function blobFile(sha) { return path.join(blobsDir(), sha.slice(0, 2), sha); }

function blobPath(ref) {
  const id = idOf(ref);
  const r = id && load().get(id);
  return r ? blobFile(r.sha256) : null;
}

// ---- principals -------------------------------------------------------------

// Typed caller (app-tools.js) → principal. `app` names the app a `self`
// caller belongs to when the caller does not carry it.
function principalOf(caller, app = null) {
  if (!caller || typeof caller !== 'object') return null;
  switch (caller.type) {
    case 'orchestrator': case 'worker':
      return caller.runId ? { type: 'run', runId: String(caller.runId) } : null;
    case 'app':
      return caller.appName ? { type: 'app', app: caller.appName } : null;
    case 'self': {
      const a = caller.appName || app;
      return a ? { type: 'app', app: a } : null;
    }
    case 'platform': case 'horst': case 'cron': case 'owner': case 'gui-test':
      return { type: 'owner' };
    case 'run':
      return caller.runId ? { type: 'run', runId: String(caller.runId) } : null;
    default:
      return null;
  }
}

function principalKey(p) {
  if (typeof p === 'string') return p;
  if (!p || typeof p !== 'object') return null;
  if (p.type === 'app' && p.app) return `app:${p.app}`;
  if (p.type === 'run' && p.runId) return `run:${p.runId}`;
  if (p.type === 'owner') return 'owner';
  return null;
}

function canReadRecord(principal, r) {
  if (!principal || !r) return false;
  if (principal.type === 'owner') return true;
  if (principal.type === 'app' && r.app && principal.app === r.app) return true;
  const key = principalKey(principal);
  return !!key && (r.grants || []).includes(key);
}

function canRead(principal, ref) {
  const id = idOf(ref);
  return canReadRecord(principal, id && load().get(id));
}

function grant(ref, principal) {
  const id = idOf(ref);
  const r = id && load().get(id);
  if (!r) throw new Error(`Unknown artifact "${ref}"`);
  const key = principalKey(principal);
  if (!key) throw new Error('grant needs a principal ({ type: "app", app } or { type: "run", runId })');
  if (key === 'owner' || (r.app && key === `app:${r.app}`) || (r.grants || []).includes(key)) return view(r);
  saveRecord({ ...r, grants: [...(r.grants || []), key] });
  return get(id);
}

// ---- paths ------------------------------------------------------------------

// `rel` (relative to base, or absolute) resolved inside base, symlinks
// followed: a path whose real location leaves base is refused.
function resolveInside(base, rel, { mustExist }) {
  if (typeof rel !== 'string' || !rel) throw new Error('a path is required');
  if (rel.includes('\0')) throw new Error('invalid path');
  const realBase = fs.realpathSync(base);
  const abs = path.resolve(base, rel);
  const inside = (p, b) => p === b || p.startsWith(b + path.sep);
  if (!inside(abs, path.resolve(base)) && !inside(abs, realBase)) throw new Error(`Path "${rel}" is outside the directory`);
  if (mustExist) {
    const real = fs.realpathSync(abs);
    if (!inside(real, realBase)) throw new Error(`Path "${rel}" resolves outside the directory`);
    return real;
  }
  // A destination: its nearest existing ancestor must really be inside, and
  // the leaf itself must not be a symlink (rename replaces it, but refuse the
  // ambiguity outright).
  let probe = path.dirname(abs);
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  if (!inside(fs.realpathSync(probe), realBase)) throw new Error(`Path "${rel}" resolves outside the directory`);
  try { if (fs.lstatSync(abs).isSymbolicLink()) throw new Error(`Path "${rel}" is a symlink`); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (abs === path.resolve(base)) throw new Error('a file path is required, not the directory itself');
  return abs;
}

function guessMime(name) {
  return MIME[path.extname(String(name || '')).toLowerCase()] || 'application/octet-stream';
}

function copyClone(src, dest) {
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_FICLONE);
}

function tmpFile() {
  fs.mkdirSync(tmpDir(), { recursive: true });
  return path.join(tmpDir(), `${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

// ---- put --------------------------------------------------------------------

function ownerUsage(ownerKey) {
  const shas = new Map();
  for (const r of load().values()) if (r.owner === ownerKey) shas.set(r.sha256, r.size);
  let total = 0;
  for (const s of shas.values()) total += s;
  return { total, shas };
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

// The shared core of put / putFrom: snapshot the source into tmp/, hash the
// snapshot (never the live file), check the quota, then — synchronously, so a
// concurrent gc can never see the blob without its record — move the snapshot
// to its blob path (or drop it when the blob exists) and write the record.
async function store({ src, buffer, ownerKey, app, opts, producer, grants }) {
  const tmp = tmpFile();
  try {
    if (buffer) fs.writeFileSync(tmp, buffer);
    else copyClone(src, tmp);
    const size = fs.statSync(tmp).size;
    const sha256 = await hashFile(tmp);
    const usage = ownerUsage(ownerKey);
    const adds = usage.shas.has(sha256) ? 0 : size;
    const quota = quotaBytes();
    if (usage.total + adds > quota) {
      throw new Error(`Artifact quota exceeded for ${ownerKey}: ${mb(usage.total)} stored + ${mb(adds)} new > ${mb(quota)} ` +
        '(platform setting artifactAppQuotaMB). Unpin or let old artifacts expire, or ask the owner to raise the quota.');
    }
    const blob = blobFile(sha256);
    fs.mkdirSync(path.dirname(blob), { recursive: true });
    if (fs.existsSync(blob)) fs.unlinkSync(tmp);
    else { fs.renameSync(tmp, blob); try { fs.chmodSync(blob, 0o444); } catch {} }
    const name = String(opts.name || (src ? path.basename(src) : `${sha256.slice(0, 12)}`));
    let id;
    do id = `art_${sha256.slice(0, 16)}-${crypto.randomBytes(2).toString('hex')}`; while (load().has(id));
    const r = {
      id,
      sha256, size,
      mime: opts.mime || guessMime(name),
      name,
      createdAt: new Date().toISOString(),
      app: app || null,
      owner: ownerKey,
      producer,
      labels: opts.labels && typeof opts.labels === 'object' ? { ...opts.labels } : {},
      grants: [...new Set(grants.filter(Boolean))],
      pins: [],
    };
    if (opts.description) r.description = String(opts.description).slice(0, 500);
    saveRecord(r);
    return r;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// put(appName, pathOrBuffer, { mime?, name?, labels?, producer?, description? }, call?)
// `call` = { caller, app, tool, callId, jobId } — the tool call this put runs
// inside; its caller's principal is granted read.
async function put(appName, pathOrBuffer, opts = {}, call = null) {
  if (!appName || typeof appName !== 'string') throw new Error('put needs the app name');
  opts = opts || {};
  let src = null; let buffer = null;
  if (Buffer.isBuffer(pathOrBuffer) || pathOrBuffer instanceof Uint8Array) buffer = Buffer.from(pathOrBuffer);
  else {
    const appDir = path.join(require('./app-manager').APPS_DIR, appName);
    src = resolveInside(appDir, pathOrBuffer, { mustExist: true });
    if (!fs.statSync(src).isFile()) throw new Error(`"${pathOrBuffer}" is not a file`);
  }
  const producer = opts.producer && typeof opts.producer === 'object'
    ? { app: appName, ...opts.producer }
    : { app: appName, tool: (call && call.tool) || null, callId: (call && call.callId) || null, jobId: (call && call.jobId) || null };
  const principal = call ? principalOf(call.caller, call.app || appName) : null;
  const key = principal && principal.type !== 'owner' && principalKey(principal);
  const grants = key && key !== `app:${appName}` ? [key] : [];
  return view(await store({ src, buffer, ownerKey: `app:${appName}`, app: appName, opts, producer, grants }));
}

// Platform-internal: an artifact from a file inside an arbitrary base directory
// (an orchestration agent's cwd), owned and readable by `principal`.
async function putFrom(baseDir, rel, opts = {}, { principal, producer } = {}) {
  const ownerKey = principalKey(principal);
  if (!ownerKey || ownerKey === 'owner') throw new Error('putFrom needs an app or run principal');
  const src = resolveInside(baseDir, rel, { mustExist: true });
  if (!fs.statSync(src).isFile()) throw new Error(`"${rel}" is not a file`);
  return view(await store({
    src, ownerKey, app: principal.type === 'app' ? principal.app : null, opts: opts || {},
    producer: producer || { [principal.type === 'app' ? 'app' : 'run']: principal.app || principal.runId }, grants: [ownerKey],
  }));
}

// Platform-internal: bytes the platform itself received (a file the owner sent
// Horst on Telegram), owned by the owner principal — no app, no grants (the
// owner reads everything; a tool call naming the uri grants its app).
// Bytes only: there is no path form, so this never reads outside the store.
async function putPlatform(buffer, opts = {}, { producer } = {}) {
  if (!(Buffer.isBuffer(buffer) || buffer instanceof Uint8Array)) throw new Error('putPlatform needs a Buffer');
  if (!producer || typeof producer !== 'object' || !producer.platform) throw new Error('putPlatform needs producer.platform');
  return view(await store({
    buffer: Buffer.from(buffer), ownerKey: 'owner', app: null, opts: opts || {},
    producer: { ...producer }, grants: [],
  }));
}

// ---- copy out ---------------------------------------------------------------

// Copy an artifact into `baseDir/destRel` for `principal`. → { path, size, sha256, mime, name }
function copyTo(ref, baseDir, destRel, principal) {
  const id = idOf(ref);
  const r = id && load().get(id);
  if (!r) throw new Error(`Unknown artifact "${ref}"`);
  if (!canReadRecord(principal, r)) throw new Error(`No read access to artifact ${SCHEME}${id}`);
  const dest = resolveInside(baseDir, destRel, { mustExist: false });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.part`;
  try {
    copyClone(blobFile(r.sha256), tmp);
    fs.chmodSync(tmp, 0o644);
    fs.renameSync(tmp, dest);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
  return { path: dest, size: r.size, sha256: r.sha256, mime: r.mime, name: r.name };
}

function importArtifact(appName, ref, destRel, principal = null) {
  if (!appName) throw new Error('import needs the app name');
  const appDir = path.join(require('./app-manager').APPS_DIR, appName);
  return copyTo(ref, appDir, destRel, principal || { type: 'app', app: appName });
}

// ---- pins, list -------------------------------------------------------------

function pin(ref, holder, reason = '') {
  const id = idOf(ref);
  const r = id && load().get(id);
  if (!r) throw new Error(`Unknown artifact "${ref}"`);
  const h = principalKey(holder) || String(holder || '');
  if (!h) throw new Error('pin needs a holder');
  const pins = (r.pins || []).filter((p) => p.holder !== h);
  pins.push({ holder: h, reason: String(reason || '').slice(0, 200), at: new Date().toISOString() });
  saveRecord({ ...r, pins });
  return get(id);
}

function unpin(ref, holder) {
  const id = idOf(ref);
  const r = id && load().get(id);
  if (!r) return null;
  const h = principalKey(holder) || String(holder || '');
  saveRecord({ ...r, pins: (r.pins || []).filter((p) => p.holder !== h) });
  return get(id);
}

// list({ app?, producer?, pinned?, principal? }) — newest first. `producer`
// is a string (producer.app) or a partial producer object.
function list(filter = {}) {
  const f = filter || {};
  const out = [];
  for (const r of load().values()) {
    if (f.app && r.app !== f.app) continue;
    if (f.producer) {
      const want = typeof f.producer === 'string' ? { app: f.producer } : f.producer;
      if (!Object.entries(want).every(([k, v]) => (r.producer || {})[k] === v)) continue;
    }
    if (f.pinned != null && ((r.pins || []).length > 0) !== !!f.pinned) continue;
    if (f.principal && !canReadRecord(f.principal, r)) continue;
    out.push(view(r));
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

// Every distinct `vc-artifact://art_…` uri in any nested string of value.
function extractRefs(value) {
  const found = new Set();
  const seen = new Set();
  const walk = (v) => {
    if (typeof v === 'string') { for (const m of v.matchAll(REF_RE)) found.add(SCHEME + m[1]); return; }
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x);
  };
  walk(value);
  return [...found];
}

// ---- gc ---------------------------------------------------------------------

function gc({ now = Date.now() } = {}) {
  const cutoff = now - retentionMs();
  let removed = 0; let blobsRemoved = 0; let bytesFreed = 0;
  for (const r of [...load().values()]) {
    if ((r.pins || []).length) continue;
    if (Date.parse(r.createdAt) < cutoff) { dropRecord(r.id); removed++; }
  }
  const used = new Set([...load().values()].map((r) => r.sha256));
  let shards = [];
  try { shards = fs.readdirSync(blobsDir()); } catch {}
  for (const shard of shards) {
    const dir = path.join(blobsDir(), shard);
    let blobs = [];
    try { blobs = fs.readdirSync(dir); } catch { continue; }
    for (const sha of blobs) {
      if (used.has(sha)) continue;
      const file = path.join(dir, sha);
      try { bytesFreed += fs.statSync(file).size; fs.unlinkSync(file); blobsRemoved++; } catch {}
    }
    try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch {}
  }
  let tmps = [];
  try { tmps = fs.readdirSync(tmpDir()); } catch {}
  for (const t of tmps) {
    const file = path.join(tmpDir(), t);
    try { if (now - fs.statSync(file).mtimeMs > TMP_STALE_MS) fs.unlinkSync(file); } catch {}
  }
  return { removed, blobsRemoved, bytesFreed };
}

// ---- HTTP (owner download) ----------------------------------------------------

// Raster images may render inline (thumbnails); everything else downloads —
// an artifact's bytes are app- or sender-made, and html / svg served inline
// would run in the owner's origin.
const INLINE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);
const MIME_RE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

function contentDisposition(type, name) {
  const fallback = String(name).replace(/[^\x20-\x7e]|["\\]/g, '_').slice(0, 150) || 'file';
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(String(name).slice(0, 150))}`;
}

// One artifact's bytes on an HTTP response — the owner route below and the
// Vista Mini App's (platform-miniapp.js), which authorise the request first.
// The id is the only input: it names a record, the record names its blob.
// A single `Range: bytes=a-b` (suffix and open forms too) answers 206 with
// Content-Range, so audio and video seek; an unsatisfiable one 416.
function sendBytes(req, res, ref) {
  const id = idOf(String(ref || ''));
  const r = id && load().get(id);
  const file = r && /^[0-9a-f]{64}$/.test(r.sha256) ? blobFile(r.sha256) : null;
  let size = -1;
  try { if (file) size = fs.statSync(file).size; } catch {}
  if (size < 0) { res.status(404).json({ error: 'unknown artifact' }); return; }
  const mime = MIME_RE.test(String(r.mime || '').toLowerCase()) ? String(r.mime).toLowerCase() : 'application/octet-stream';
  const inline = INLINE_MIME.has(mime) && req.query?.download == null;
  // setHeader, not res.set: express would append a charset guess to text types.
  const headers = {
    'Content-Type': mime,
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', r.name || r.id),
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, max-age=86400',
    ETag: `"${r.sha256}"`,
  };
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  let start = 0; let end = size - 1;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers?.range || '').trim());
  if (range && (range[1] || range[2])) {
    if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), size - 1); }
    else start = Math.max(0, size - Number(range[2]));
    if (start > end || start >= size) {
      res.setHeader('Content-Range', `bytes */${size}`);
      res.status(416).end();
      return;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.setHeader('Content-Length', String(size ? end - start + 1 : 0));
  if (req.method === 'HEAD' || !size) { res.end(); return; }
  fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
}

// GET|HEAD /pro/artifacts/:id — the owner's download. Core's auth middleware
// guards /pro/*; the handler repeats core's owner decision (isOwnerRequest via
// app-manager) so an exemption added later cannot open the store.
function serve(req, res) {
  const ownerCheck = require('./app-manager').getOwnerCheck();
  if (!ownerCheck || !ownerCheck(req)) { res.status(401).json({ error: 'owner only' }); return; }
  sendBytes(req, res, req.params.id);
}

function mountApi(router) {
  router.get('/pro/artifacts/:id', serve);
}

module.exports = {
  init, put, putFrom, putPlatform, serve, sendBytes, mountApi, get, blobPath, canRead, grant, import: importArtifact, copyTo,
  pin, unpin, list, extractRefs, gc, principalOf, principalKey, guessMime, resolveInside, SCHEME,
};
