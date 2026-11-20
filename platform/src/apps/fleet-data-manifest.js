// Fleet data publish (docs/fleet-data.md): the manifest shape both sides
// share. Pure helpers — shape validation, the canonical JSON whose sha256 is a
// transfer's identity, and the limits. The master additionally checks every
// blob path against its data dir (fleet-data.js); the slave never touches a
// manifest path.
const crypto = require('crypto');

const NAME_RE = /^[a-z0-9._-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const MAX_BLOBS = 100000;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024; // canonical JSON, extra included
const MAX_EXTRA_BYTES = 256 * 1024;
const MAX_PATH_CHARS = 1024;
const MAX_FORMAT_CHARS = 64;

function isName(v) { return typeof v === 'string' && NAME_RE.test(v) && v !== '.' && v !== '..'; }
function isSha(v) { return typeof v === 'string' && SHA_RE.test(v); }

// JSON with object keys sorted at every level; arrays keep their order.
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// Throws on a bad manifest; returns { manifest, sha, blobs } where `blobs` is
// the deduplicated sha → bytes map (one sha may sit at several paths, never
// with two sizes). `manifest` is a clean copy holding only the known keys.
function validateManifest(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('manifest must be an object');
  const format = m.format == null ? null : m.format;
  if (format !== null && (typeof format !== 'string' || format.length > MAX_FORMAT_CHARS)) {
    throw new Error(`manifest.format must be a string of at most ${MAX_FORMAT_CHARS} chars`);
  }
  if (!Array.isArray(m.blobs)) throw new Error('manifest.blobs must be an array');
  if (m.blobs.length > MAX_BLOBS) throw new Error(`manifest has ${m.blobs.length} blobs (max ${MAX_BLOBS})`);
  const blobs = new Map();
  const clean = [];
  m.blobs.forEach((b, i) => {
    if (!b || typeof b !== 'object') throw new Error(`manifest.blobs[${i}] must be an object`);
    if (!isSha(b.sha256)) throw new Error(`manifest.blobs[${i}].sha256 must be 64 lowercase hex chars`);
    if (!Number.isSafeInteger(b.bytes) || b.bytes < 0) throw new Error(`manifest.blobs[${i}].bytes must be a non-negative integer`);
    if (typeof b.path !== 'string' || !b.path || b.path.length > MAX_PATH_CHARS || b.path.includes('\0')) {
      throw new Error(`manifest.blobs[${i}].path must be a non-empty string of at most ${MAX_PATH_CHARS} chars`);
    }
    const prev = blobs.get(b.sha256);
    if (prev !== undefined && prev !== b.bytes) throw new Error(`blob ${b.sha256} is listed with two sizes`);
    blobs.set(b.sha256, b.bytes);
    clean.push({ sha256: b.sha256, bytes: b.bytes, path: b.path });
  });
  let extra;
  if (m.extra !== undefined && m.extra !== null) {
    let raw;
    try { raw = JSON.stringify(m.extra); } catch { throw new Error('manifest.extra must be JSON'); }
    if (Buffer.byteLength(raw) > MAX_EXTRA_BYTES) throw new Error(`manifest.extra is over ${MAX_EXTRA_BYTES / 1024} KB`);
    extra = JSON.parse(raw);
  }
  const manifest = { format, blobs: clean, ...(extra !== undefined ? { extra } : {}) };
  const canon = canonicalJson(manifest);
  if (Buffer.byteLength(canon) > MAX_MANIFEST_BYTES) throw new Error(`manifest is over ${MAX_MANIFEST_BYTES / 1048576} MB`);
  return { manifest, sha: sha256(canon), blobs };
}

module.exports = {
  NAME_RE, SHA_RE, MAX_BLOBS, MAX_MANIFEST_BYTES, MAX_EXTRA_BYTES, MAX_PATH_CHARS,
  isName, isSha, canonicalJson, validateManifest,
};
