const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSON(filePath, defaultValue = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return defaultValue;
  }
}

function writeJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Resolve `rel` against `base` and guarantee the result stays inside `base`.
 * Single source of truth for path-traversal containment in the Pro package.
 * Throws 'Path traversal not allowed' if the resolved path escapes base.
 */
function safeJoin(base, rel) {
  const resolved = path.resolve(base, rel);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('Path traversal not allowed');
  }
  return resolved;
}

/**
 * Run fn at most once per key at a time; concurrent callers share the
 * in-flight promise. fn's own catch handling determines what callers see.
 */
function singleFlight(map, key, fn) {
  if (map.has(key)) return map.get(key);
  const p = Promise.resolve().then(fn).finally(() => map.delete(key));
  map.set(key, p);
  return p;
}

/**
 * Serialize fn calls per key on a promise chain (async mutex). A rejected
 * fn does not break the chain for later callers.
 */
function chainLock(map, key, fn) {
  const prev = map.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  map.set(key, next);
  return next;
}

/**
 * Coalescing runner: run() executes fn at most once at a time; calls during a
 * run collapse into a single follow-up pass. kick() is run() debounced by
 * debounceMs. fn is responsible for its own error handling.
 */
function coalesce(fn, debounceMs = 0) {
  let running = false, queued = false, timer = null;
  const run = () => {
    if (running) { queued = true; return; }
    running = true;
    Promise.resolve().then(fn).finally(() => {
      running = false;
      if (queued) { queued = false; run(); }
    });
  };
  const kick = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; run(); }, debounceMs);
  };
  return { run, kick };
}

/** SIGTERM now, SIGKILL after graceMs if the process is still alive. */
function killWithTimeout(proc, graceMs = 3000) {
  try { proc.kill('SIGTERM'); } catch {}
  const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, graceMs);
  if (t.unref) t.unref();
}

module.exports = { ensureDir, readJSON, writeJSON, safeJoin, singleFlight, chainLock, coalesce, killWithTimeout };
