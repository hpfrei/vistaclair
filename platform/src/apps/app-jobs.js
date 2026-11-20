// Persistent per-app job tracking for long-running operations.
// Backs ctx.jobs (routes.js) and the jobs.* bridge methods. Records live in
// <appDir>/.data/jobs.json so they survive server restarts (GUI-reload
// resilience: the frontend can always re-query in-progress work). Runner
// functions do NOT survive restarts — records still 'running' at boot are
// marked 'interrupted' so apps can resume or surface them.
const fs = require('fs');
const path = require('path');
const spendContext = require('./spend-context');
const { chainLock } = require('../utils');

let appsDir = null;
let broadcaster = null;

const jobsByApp = new Map(); // appName → records array (newest first)
const runners = new Map(); // jobId → { controller }
// Failed jobs whose run closure this process still holds — the job.retry
// remediation resubmits from here. Closures don't survive a restart (same
// truth as the 'interrupted' sweep), so retryability is process-lifetime only.
const retryable = new Map(); // jobId → { appName, name, meta, run }
const MAX_RETRYABLE = 50;
const writeLocks = new Map(); // appName → promise chain
const touchTimers = new Map(); // jobId → { timer, lastFlush }

const PROGRESS_THROTTLE_MS = 1000;
const MAX_JOBS_PER_APP = 200;
const TERMINAL_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_RESULT_BYTES = 256 * 1024;
const TERMINAL = new Set(['done', 'error', 'cancelled', 'interrupted']);

function jobsPath(appName) {
  return path.join(appsDir, appName, '.data', 'jobs.json');
}

const withWriteLock = (appName, fn) => chainLock(writeLocks, appName, fn);

function loadApp(appName) {
  if (jobsByApp.has(appName)) return jobsByApp.get(appName);
  let records = [];
  try {
    records = JSON.parse(fs.readFileSync(jobsPath(appName), 'utf-8')).jobs || [];
  } catch {}
  records = pruneRecords(records);
  jobsByApp.set(appName, records);
  return records;
}

function pruneRecords(records) {
  const cutoff = Date.now() - TERMINAL_TTL_MS;
  return records
    .filter((j) => !(TERMINAL.has(j.status) && (j.finishedAt || j.updatedAt || 0) < cutoff))
    .slice(0, MAX_JOBS_PER_APP);
}

function saveApp(appName) {
  const records = pruneRecords(jobsByApp.get(appName) || []);
  jobsByApp.set(appName, records);
  withWriteLock(appName, () => {
    try {
      const filePath = jobsPath(appName);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ jobs: records }, null, 2));
      fs.renameSync(tmp, filePath);
    } catch (err) {
      console.warn(`[app-jobs] save failed for ${appName}: ${err.message}`);
    }
  });
}

function broadcastUpdate(appName, job) {
  if (!broadcaster) return;
  broadcaster.broadcast({ type: 'app:bridge:event', appName, event: 'job:update', data: job });
}

// Progress/meta-only updates are throttled to one persist+broadcast per
// second per job (with a trailing flush so the latest state always lands).
// Status transitions pass { immediate: true } and always flush right away.
function touch(appName, job, { immediate } = {}) {
  job.updatedAt = Date.now();
  if (job.remote) notifyChange(appName, job);
  const entry = touchTimers.get(job.id);

  if (immediate || TERMINAL.has(job.status)) {
    if (entry && entry.timer) clearTimeout(entry.timer);
    touchTimers.delete(job.id);
    saveApp(appName);
    broadcastUpdate(appName, job);
    if (!TERMINAL.has(job.status)) touchTimers.set(job.id, { timer: null, lastFlush: Date.now() });
    return;
  }

  const now = Date.now();
  const lastFlush = entry ? entry.lastFlush : 0;
  if (now - lastFlush >= PROGRESS_THROTTLE_MS) {
    if (entry && entry.timer) clearTimeout(entry.timer);
    touchTimers.set(job.id, { timer: null, lastFlush: now });
    saveApp(appName);
    broadcastUpdate(appName, job);
    return;
  }

  if (entry && entry.timer) return; // trailing flush already scheduled
  const timer = setTimeout(() => {
    const cur = touchTimers.get(job.id);
    if (!cur || cur.timer !== timer) return; // superseded by an immediate flush
    touchTimers.set(job.id, { timer: null, lastFlush: Date.now() });
    if (!jobsByApp.has(appName)) { touchTimers.delete(job.id); return; } // app cleaned up
    if (TERMINAL.has(job.status)) { touchTimers.delete(job.id); return; } // terminal flush already happened
    saveApp(appName);
    broadcastUpdate(appName, job);
  }, PROGRESS_THROTTLE_MS - (now - lastFlush));
  if (timer.unref) timer.unref();
  touchTimers.set(job.id, { timer, lastFlush });
}

function clearTouchTimer(jobId) {
  const entry = touchTimers.get(jobId);
  if (entry && entry.timer) clearTimeout(entry.timer);
  touchTimers.delete(jobId);
}

function capResult(result) {
  if (result === undefined) return null;
  try {
    const size = Buffer.byteLength(JSON.stringify(result));
    if (size > MAX_RESULT_BYTES) {
      return { _truncated: true, note: `Result (${size} bytes) exceeds the ${MAX_RESULT_BYTES}-byte inline cap. Store large results yourself (fs/db) and put a reference in the job instead.` };
    }
  } catch {
    return { _truncated: true, note: 'Result was not JSON-serializable.' };
  }
  return result;
}

function findJob(appName, id) {
  return loadApp(appName).find((j) => j.id === id) || null;
}

// `owner` decides one thing only: what a stop of the app does to the job.
// 'app' (the default — everything an app starts through ctx.jobs) holds the
// module instance being torn down, so it dies with it. 'platform' is work
// being done TO the app from outside — a publish, a rollback — and it
// outlives a restart. See cleanupApp.
//
// `remote` tags a job a fleet master started through the app's onJob handler
// ({ peer, id, origin }, fleet-remote-host.js); its every change reaches
// onChange observers unthrottled (they coalesce on their own).
function startJob(appName, { name, meta, run, owner, remote }) {
  if (!name) throw new Error('jobs.start requires a name');
  if (typeof run !== 'function') throw new Error('jobs.start requires a run function');

  const id = 'j-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job = {
    id,
    appName,
    name,
    owner: owner === 'platform' ? 'platform' : 'app',
    status: 'running',
    progress: {},
    meta: meta || {},
    result: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: null,
    ...(remote ? { remote } : {}),
  };
  const records = loadApp(appName);
  records.unshift(job);
  touch(appName, job, { immediate: true });

  const controller = new AbortController();
  runners.set(id, { controller });

  const handle = {
    id,
    signal: controller.signal,
    setProgress(pct, label) {
      if (TERMINAL.has(job.status)) return;
      job.progress = {};
      if (pct !== undefined && pct !== null) job.progress.pct = Math.max(0, Math.min(100, Number(pct) || 0));
      if (label !== undefined && label !== null) job.progress.label = String(label);
      touch(appName, job);
    },
    setMeta(obj) {
      if (TERMINAL.has(job.status)) return;
      Object.assign(job.meta, obj || {});
      touch(appName, job);
    },
  };

  // Invoke run() synchronously so the app's pre-await setup (state stubs etc.)
  // completes before startJob returns — callers can res.json() immediately
  // without a window where concurrent requests see uninitialized state.
  let runResult;
  try {
    // Spend attribution: origin 'job'; the principal of the context that
    // started the job (a route's account, say) is inherited.
    runResult = spendContext.run({ app: appName, origin: 'job', jobId: id }, () => run(handle));
  } catch (err) {
    runResult = Promise.reject(err);
  }
  Promise.resolve(runResult)
    .then((result) => {
      if (TERMINAL.has(job.status)) return; // cancelled while running
      job.status = 'done';
      job.result = capResult(result);
      job.finishedAt = Date.now();
      touch(appName, job);
      notifyFinished(appName, job);
    })
    .catch((err) => {
      if (TERMINAL.has(job.status)) return;
      require('./app-guard').record(appName, 'jobs.run', err, { jobId: id });
      job.status = 'error';
      job.error = err && err.message ? err.message : String(err);
      job.finishedAt = Date.now();
      // Retain the run closure so job.retry can resubmit with the same params.
      retryable.set(id, { appName, name, meta: job.meta, run, owner: job.owner });
      if (retryable.size > MAX_RETRYABLE) retryable.delete(retryable.keys().next().value);
      touch(appName, job);
      notifyFinished(appName, job);
    })
    .finally(() => {
      runners.delete(id);
    });

  return { id };
}

function getJob(appName, id) {
  return findJob(appName, id);
}

// Can job.retry resubmit this failed job? Only while this process still holds
// its run closure (failures from before a restart cannot be resubmitted).
function canRetry(appName, id) {
  const entry = retryable.get(id);
  return !!(entry && entry.appName === appName);
}

// Resubmit a failed job with its original name/meta/run. Returns the NEW
// { id }; the failed record stays in the history untouched.
function retryJob(appName, id) {
  const job = findJob(appName, id);
  if (!job) throw new Error(`unknown job "${id}" in app "${appName}"`);
  if (job.status !== 'error') throw new Error(`job "${id}" is ${job.status}, not failed`);
  const entry = retryable.get(id);
  if (!entry || entry.appName !== appName) {
    throw new Error(`job "${id}" is not retryable — its run function is gone (only failures from this server process can be resubmitted)`);
  }
  retryable.delete(id);
  return startJob(appName, { name: entry.name, meta: { ...entry.meta, retryOf: id }, run: entry.run, owner: entry.owner });
}

function listJobs(appName, { status, name, limit } = {}) {
  let records = loadApp(appName);
  if (status) records = records.filter((j) => j.status === status);
  if (name) records = records.filter((j) => j.name === name);
  return records.slice(0, limit || 50);
}

function cancelJob(appName, id) {
  const job = findJob(appName, id);
  if (!job) return { ok: false, error: 'Job not found' };
  if (TERMINAL.has(job.status)) return { ok: false, error: `Job already ${job.status}` };

  const runner = runners.get(id);
  // Running record with no in-process runner = leftover from a previous boot.
  job.status = runner ? 'cancelled' : 'interrupted';
  job.finishedAt = Date.now();
  touch(appName, job);
  if (runner) {
    try { runner.controller.abort(); } catch {}
    runners.delete(id);
  }
  return { ok: true };
}

// Remove a single job record. Running jobs are cancelled (runner aborted) first.
function removeJob(appName, id) {
  const records = loadApp(appName);
  const job = records.find((j) => j.id === id);
  if (!job) return { ok: false, error: 'Job not found' };
  if (!TERMINAL.has(job.status)) cancelJob(appName, id);
  clearTouchTimer(id);
  jobsByApp.set(appName, records.filter((j) => j.id !== id));
  saveApp(appName);
  return { ok: true };
}

function pruneJobs(appName, { olderThanMs } = {}) {
  const records = loadApp(appName);
  const cutoff = Date.now() - (olderThanMs || TERMINAL_TTL_MS);
  const kept = records.filter((j) => !(TERMINAL.has(j.status) && (j.finishedAt || j.updatedAt || 0) < cutoff));
  const removed = records.length - kept.length;
  const keptIds = new Set(kept.map((j) => j.id));
  for (const j of records) if (!keptIds.has(j.id)) clearTouchTimer(j.id);
  jobsByApp.set(appName, kept);
  if (removed > 0) saveApp(appName);
  return { removed };
}

// Mark every record still 'running' on disk as 'interrupted' — their runner
// functions died with the previous process. Called once at boot.
// options.appFilter scopes the sweep to the apps THIS process owns: a
// standalone runner sweeps only its own app, and the dashboard skips
// standalone apps (their live jobs belong to the runner process).
function init(options) {
  appsDir = options.appsDir;
  broadcaster = options.broadcaster || null;
  const appFilter = options.appFilter || null;

  let interrupted = 0;
  let dirs = [];
  // Only directories are apps — a stray file dropped into appsDir must not
  // reach appFilter/readManifest, whose name validation throws.
  try { dirs = fs.readdirSync(appsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
  for (const name of dirs) {
    if (name.startsWith('.')) continue;
    if (appFilter && !appFilter(name)) continue;
    if (!fs.existsSync(jobsPath(name))) continue;
    const records = loadApp(name);
    let changed = false;
    for (const job of records) {
      if (job.status === 'running') {
        job.status = 'interrupted';
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
        changed = true;
        interrupted++;
      }
    }
    if (changed) saveApp(name);
  }
  if (interrupted > 0) console.log(`  Jobs: ${interrupted} interrupted job(s) from previous run`);
}

// Called when an app is unmounted/deleted: abort its runners, mark them
// interrupted (terminal — blocks any late touch() from the dying runner), then
// drop in-memory state. The jobs file lives in the app dir, so app deletion
// removes it from disk automatically.
//
// `reason: 'restart'` is the narrower case, and the difference is not
// cosmetic. A restart is the app's own code going away and coming back, so an
// app-owned job — whose closure holds the instance being re-required — still
// has to die. Platform-owned work does not: a publish is done TO the app, and
// restarting the app mid-upload must not abort it — the job outlives the
// remount, keeps its runner and timer, and its record stays addressable so the
// GUI can still show and finish it.
function cleanupApp(appName, { reason = 'unmount' } = {}) {
  const restart = reason === 'restart';
  const records = jobsByApp.get(appName) || [];
  let changed = false;
  for (const job of records) {
    if (restart && job.owner === 'platform') continue;   // survives, timer and runner intact
    clearTouchTimer(job.id);
    if (job.status !== 'running') continue;
    job.status = 'interrupted';
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
    changed = true;
    const runner = runners.get(job.id);
    if (runner) {
      try { runner.controller.abort(); } catch {}
      runners.delete(job.id);
    }
    if (job.remote) notifyChange(appName, job);
  }
  if (changed) saveApp(appName);
  // Only a real teardown forgets the app: after a restart the records (and the
  // survivors still writing to them) must stay addressable.
  if (restart) return;
  jobsByApp.delete(appName);
  for (const [id, entry] of retryable) { if (entry.appName === appName) retryable.delete(id); }
}

// onFinished(fn(appName, job)) — a run reached 'done' or 'error' (not cancel).
// Returns an unsubscribe function. Feeds Horst's job:failed sense.
const finishedObservers = [];
function onFinished(fn) {
  finishedObservers.push(fn);
  return () => { const i = finishedObservers.indexOf(fn); if (i >= 0) finishedObservers.splice(i, 1); };
}
function notifyFinished(appName, job) {
  for (const fn of finishedObservers) { try { fn(appName, job); } catch (err) { console.warn('[app-jobs] finished observer failed:', err.message); } }
}

// onChange(fn(appName, job)) — every update of a job tagged `remote`
// (progress, meta, status), before the throttled persist. Returns unsubscribe.
const changeObservers = new Set();
function onChange(fn) {
  changeObservers.add(fn);
  return () => changeObservers.delete(fn);
}
function notifyChange(appName, job) {
  for (const fn of changeObservers) { try { fn(appName, job); } catch (err) { console.warn('[app-jobs] change observer failed:', err.message); } }
}

module.exports = { init, startJob, getJob, listJobs, cancelJob, removeJob, pruneJobs, cleanupApp, onFinished, onChange, canRetry, retryJob };
