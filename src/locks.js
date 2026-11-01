'use strict';
// Machine-wide resource locks (see bin/vistaclair-lock.js and the README
// "Resource locks" paragraph). This module is the pure side: where the lock
// directory is, what a lock name may look like, and a reader that lists the
// holders and waiters recorded there. The kernel (flock) is the source of
// truth for who holds a lock; the records only say who, for display.
//
// Layout of the lock directory:
//   <name>.lock               the flock(2) target, one per lock name
//   holders/<pid>.json        written by a running wrapper for the locks it holds
//   waiters/<pid>.json        written by a wrapper while it waits for a lock
// A record whose pid is dead is stale and ignored.

const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME_RE = /^[a-z0-9._-]{1,64}$/;
// Names that would be dot-files or path tricks.
const validName = (n) => typeof n === 'string' && NAME_RE.test(n) && !/^\.+$/.test(n) && !n.startsWith('.');

// The data home the server uses (src/utils.js DATA_HOME), reproduced without
// loading the server: VISTACLAIR_HOME, else ~/.vistaclair for a global npm
// install, else the package root. A git worktree of a dev checkout under
// <home>/data/worktrees/... resolves to <home>, so a manual shell in any
// worktree finds the same directory as the server. Sessions carry
// VISTACLAIR_DATA_HOME, which wins.
function resolveDataHome(env = process.env, packageRoot = path.dirname(__dirname)) {
  if (env.VISTACLAIR_DATA_HOME) return path.resolve(env.VISTACLAIR_DATA_HOME);
  if (env.VISTACLAIR_HOME) return path.resolve(env.VISTACLAIR_HOME);
  const sep = path.sep;
  if (packageRoot.includes(sep + 'node_modules' + sep) || packageRoot.endsWith(sep + 'node_modules')) {
    return path.join(os.homedir(), '.vistaclair');
  }
  const marker = sep + path.join('data', 'worktrees') + sep;
  const i = packageRoot.indexOf(marker);
  if (i > 0) return packageRoot.slice(0, i);
  return packageRoot;
}

function resolveLockDir(env = process.env, packageRoot) {
  if (env.VISTACLAIR_LOCK_DIR) return path.resolve(env.VISTACLAIR_LOCK_DIR);
  return path.join(resolveDataHome(env, packageRoot), 'data', 'locks');
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readRecords(dir) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (rec && pidAlive(rec.pid)) out.push(rec);
    } catch {}
  }
  return out;
}

// Atomic record write (tmp + rename) so a reader never sees half a file.
function writeRecord(dir, pid, rec) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${pid}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec));
  fs.renameSync(tmp, file);
}

function removeRecord(dir, pid) {
  try { fs.rmSync(path.join(dir, `${pid}.json`), { force: true }); } catch {}
}

// Delete records of dead pids (a wrapper killed with SIGKILL cannot clean up).
function pruneStale(dir) {
  for (const sub of ['holders', 'waiters']) {
    let files = [];
    try { files = fs.readdirSync(path.join(dir, sub)); } catch { continue; }
    for (const f of files) {
      const pid = parseInt(f, 10);
      if (/^\d+\.json$/.test(f) && !pidAlive(pid)) removeRecord(path.join(dir, sub), pid);
    }
  }
}

// Who a record belongs to, for the "held by" message.
function describe(rec) {
  const who = rec.session || (rec.instanceId ? `instance ${rec.instanceId}` : `${rec.user || 'user'}@${rec.host || 'host'}`);
  const cmd = Array.isArray(rec.command) ? rec.command.join(' ') : '';
  return `${who}, pid ${rec.pid}${cmd ? `, "${cmd.slice(0, 80)}"` : ''}`;
}

// Holders and waiters per lock name:
//   { dir, locks: [{ name, holders: [rec], waiters: [rec] }] }
// holders[i] = { pid, name, mode, since, command, cwd, session, instanceId, user, host }
// waiters[i] = { pid, name, mode, since, ...same }
// Only names with at least one live holder or waiter are listed, sorted by name.
function listLocks(dir = resolveLockDir()) {
  const byName = new Map();
  const slot = (name) => {
    if (!byName.has(name)) byName.set(name, { name, holders: [], waiters: [] });
    return byName.get(name);
  };
  const base = (rec) => ({
    pid: rec.pid, since: rec.since, command: rec.command || [], cwd: rec.cwd || null,
    session: rec.session || null, instanceId: rec.instanceId || null, user: rec.user || null, host: rec.host || null,
  });
  for (const rec of readRecords(path.join(dir, 'holders'))) {
    for (const l of rec.locks || []) {
      if (validName(l.name)) slot(l.name).holders.push({ ...base(rec), name: l.name, mode: l.mode, since: l.since || rec.since });
    }
  }
  for (const rec of readRecords(path.join(dir, 'waiters'))) {
    const w = rec.waiting;
    if (w && validName(w.name)) slot(w.name).waiters.push({ ...base(rec), name: w.name, mode: w.mode });
  }
  const locks = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const l of locks) {
    l.holders.sort((a, b) => (a.since || 0) - (b.since || 0));
    l.waiters.sort((a, b) => (a.since || 0) - (b.since || 0));
  }
  return { dir, locks };
}

// Express handler for GET /api/locks.
function locksHandler(dirOrFn) {
  return (req, res) => {
    try {
      const dir = typeof dirOrFn === 'function' ? dirOrFn() : (dirOrFn || resolveLockDir());
      res.json(listLocks(dir));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };
}

module.exports = { NAME_RE, validName, resolveDataHome, resolveLockDir, pidAlive, readRecords, writeRecord, removeRecord, pruneStale, describe, listLocks, locksHandler };
