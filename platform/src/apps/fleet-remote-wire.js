// Fleet remote call / job — what both ends share (docs/fleet-remote.md): the
// name rule, the size caps, the origin shape, the args sha, the error type
// and the per-job event coalescer. The master half is fleet-remote.js, the
// slave half fleet-remote-host.js; everything a peer sends is checked here.
const crypto = require('crypto');
const M = require('./fleet-data-manifest');

const NAME_RE = /^[a-z0-9._:-]{1,64}$/;
const ID_RE = /^fr-[a-z0-9]{8,40}$/;
const JOB_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const ARGS_MAX = 256 * 1024;
const RESULT_MAX = 1024 * 1024;
const ERROR_MAX = 4 * 1024;
const META_MAX = 16 * 1024;
const LABEL_MAX = 2048;
const TIMEOUT_DEFAULT_MS = 60 * 1000;
const TIMEOUT_MAX_MS = 10 * 60 * 1000;
const EVENTS_PER_SEC = 4;
const ORIGIN_KINDS = new Set(['owner', 'ai', 'cron', 'bot', 'user']);
const CODES = new Set(['E_OFFLINE', 'E_NOT_RUNNING', 'E_NO_HANDLER', 'E_TIMEOUT', 'E_TOO_LARGE', 'E_REMOTE', 'E_REFUSED']);

class RemoteError extends Error {
  constructor(code, message, extra = {}) {
    super(String(message || code).slice(0, ERROR_MAX));
    this.code = CODES.has(code) ? code : 'E_REMOTE';
    Object.assign(this, extra);
  }
}

const isName = (v) => typeof v === 'string' && NAME_RE.test(v);
const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const isJobId = (v) => typeof v === 'string' && JOB_ID_RE.test(v);

function bytesOf(v) {
  if (v === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(v));
}

// JSON value → its serialised size, or a RemoteError (E_TOO_LARGE / not JSON).
function jsonSize(v, max, what) {
  let n;
  try { n = bytesOf(v); } catch { throw new RemoteError('E_REMOTE', `${what} must be JSON`); }
  if (n > max) throw new RemoteError('E_TOO_LARGE', `${what} is ${n} bytes, over ${Math.round(max / 1024)} KB`);
  return n;
}

// sha256 of the canonical JSON (keys sorted at every level).
function argsSha(args) {
  return crypto.createHash('sha256').update(M.canonicalJson(args === undefined ? null : args)).digest('hex');
}

// A short, single-line view of args for a governance card.
function argsSummary(args, max = 300) {
  let s;
  try { s = JSON.stringify(args === undefined ? null : args); } catch { s = '(not JSON)'; }
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// An error message off the wire: a string, ≤ 4 KB, first line block only (no stack).
function cleanError(v) {
  if (v == null) return null;
  const s = String(typeof v === 'object' && v.message ? v.message : v);
  return s.split(/\n\s+at\s/)[0].slice(0, ERROR_MAX);
}

// The caller's origin as the master classified it; anything else is dropped.
function cleanOrigin(o) {
  if (!o || typeof o !== 'object' || !ORIGIN_KINDS.has(o.kind)) return { kind: 'user' };
  const out = { kind: o.kind };
  if (typeof o.route === 'string' && o.route) out.route = o.route.slice(0, 200);
  if (isJobId(o.jobId)) out.jobId = o.jobId;
  if (typeof o.tool === 'string' && o.tool) out.tool = o.tool.slice(0, 200);
  if (isId(o.proposalId) || (typeof o.proposalId === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(o.proposalId))) out.proposalId = o.proposalId;
  return out;
}

// A slave job's progress off the wire: { pct?, label? } — label verbatim, capped.
function cleanProgress(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  if (typeof p.pct === 'number' && Number.isFinite(p.pct)) out.pct = Math.max(0, Math.min(100, p.pct));
  if (typeof p.label === 'string') out.label = p.label.slice(0, LABEL_MAX);
  return out;
}

// A plain-object meta patch ≤ 16 KB, or null.
function cleanMeta(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  try { if (bytesOf(m) > META_MAX) return null; } catch { return null; }
  return JSON.parse(JSON.stringify(m));
}

// Shallow diff: the keys of `next` whose JSON differs from `prev`.
function metaPatch(prev, next) {
  const patch = {};
  let n = 0;
  for (const [k, v] of Object.entries(next || {})) {
    let a; let b;
    try { a = JSON.stringify(v); b = JSON.stringify(prev ? prev[k] : undefined); } catch { continue; }
    if (a !== b) { patch[k] = v; n++; }
  }
  return n ? patch : null;
}

function clampTimeout(ms) {
  if (ms === undefined || ms === null) return TIMEOUT_DEFAULT_MS;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) throw new RemoteError('E_REMOTE', 'timeoutMs must be a positive number');
  return Math.min(Math.floor(n), TIMEOUT_MAX_MS);
}

// Per-key coalescer: at most `perSec` deliveries a second for one key; the
// latest value wins in between and is delivered when the window opens.
// `flush(key)` delivers a pending value at once (so the last progress before a
// done is never dropped); `drop(key)` forgets it.
function makeCoalescer(deliver, { perSec = EVENTS_PER_SEC, now = () => Date.now() } = {}) {
  const gap = Math.ceil(1000 / perSec);
  const state = new Map();   // key → { last, pending, timer }
  const fire = (key) => {
    const s = state.get(key);
    if (!s || s.pending === undefined) return;
    const v = s.pending;
    s.pending = undefined;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    s.last = now();
    try { deliver(key, v); } catch (err) { console.warn('[fleet-remote] event delivery failed:', err.message); }
  };
  return {
    push(key, value) {
      let s = state.get(key);
      if (!s) { s = { last: 0, pending: undefined, timer: null }; state.set(key, s); }
      s.pending = value;
      const wait = s.last + gap - now();
      if (wait <= 0) return fire(key);
      if (!s.timer) {
        s.timer = setTimeout(() => { s.timer = null; fire(key); }, wait);
        s.timer.unref?.();
      }
    },
    flush: fire,
    drop(key) {
      const s = state.get(key);
      if (s?.timer) clearTimeout(s.timer);
      state.delete(key);
    },
    pending: (key) => state.get(key)?.pending,
  };
}

module.exports = {
  NAME_RE, ARGS_MAX, RESULT_MAX, ERROR_MAX, META_MAX, LABEL_MAX, TIMEOUT_DEFAULT_MS, TIMEOUT_MAX_MS, EVENTS_PER_SEC,
  ORIGIN_KINDS, CODES, RemoteError,
  isName, isId, isJobId, bytesOf, jsonSize, argsSha, argsSummary, cleanError, cleanOrigin, cleanProgress, cleanMeta,
  metaPatch, clampTimeout, makeCoalescer,
};
