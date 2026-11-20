// Transient child processes owned by apps — the `exec` capability (exec, spawn,
// spawn.kill), the spawned-process half of tasks.list/tasks.kill, and the
// registry every headless Claude spawn (ai-service) is tracked in so app
// stop/close can tear everything down. Cron is NOT here: per-app cron jobs are
// persisted in platform-cron and survive a stop.

const { spawn: spawnProc, exec: execCb } = require('child_process');
const { killWithTimeout } = require('../utils');
const { core } = require('./core-services');
const { proxyEnv } = require('./proxy-env');

const spawned = new Map(); // spawnId → { proc, appName, command, startedAt, recentOutput }
let spawnId = 0;
const MAX_SPAWNS_PER_APP = 10;

function nextId() { return String(++spawnId); }
// The last id handed out — media/maps calls stamp it into their instanceId tag.
function currentId() { return spawnId; }

function track(sid, entry) { spawned.set(sid, entry); }
function untrack(sid) { spawned.delete(sid); }
function countForApp(appName) {
  let n = 0;
  for (const [, e] of spawned) { if (e.appName === appName) n++; }
  return n;
}

// exec: one-shot shell command in the app dir. Always resolves with
// { stdout, stderr, code } (a timeout is code 124) — the pre-module contract.
function exec(app, params = {}) {
  return new Promise((resolve, reject) => {
    const cmd = params.command;
    if (!cmd) { reject(new Error('No command provided')); return; }
    const execEnv = { ...process.env, ...proxyEnv(process.env, core.proxyPort) };
    execCb(cmd, {
      cwd: app.dir,
      encoding: 'utf-8',
      timeout: 300000,
      maxBuffer: 5 * 1024 * 1024,
      env: execEnv,
    }, (err, stdout, stderr) => {
      if (err && err.killed) {
        resolve({ stdout: stdout || '', stderr: 'Command timed out', code: 124 });
      } else if (err) {
        resolve({ stdout: stdout || err.stdout || '', stderr: stderr || err.stderr || err.message, code: err.code || 1 });
      } else {
        resolve({ stdout: stdout || '', stderr: stderr || '', code: 0 });
      }
    });
  });
}

// spawn: long-running process; stdout/stderr/exit stream back as bridge events.
function spawn(app, params = {}, emitEvent = () => {}) {
  const appName = app.name;
  if (countForApp(appName) >= MAX_SPAWNS_PER_APP) {
    throw new Error(`Spawn limit reached (max ${MAX_SPAWNS_PER_APP} per app)`);
  }
  const sid = nextId();
  const cmd = params.command;
  const args = params.args || [];
  const proc = spawnProc(cmd, args, {
    cwd: app.dir,
    env: { ...process.env, ...proxyEnv(process.env, core.proxyPort), ...params.env },
    shell: true,
  });
  spawned.set(sid, { proc, appName, command: cmd, args, startedAt: Date.now(), recentOutput: [] });

  proc.stdout.on('data', (chunk) => {
    const entry = spawned.get(sid);
    if (entry) {
      entry.recentOutput.push(chunk.toString());
      if (entry.recentOutput.length > 50) entry.recentOutput.shift();
    }
    emitEvent('spawn:stdout', { spawnId: sid, data: chunk.toString() });
  });
  proc.stderr.on('data', (chunk) => {
    emitEvent('spawn:stderr', { spawnId: sid, data: chunk.toString() });
  });
  proc.on('exit', (code, signal) => {
    const entry = spawned.get(sid);
    const killed = !!(entry && entry.killed);
    spawned.delete(sid);
    emitEvent('spawn:exit', { spawnId: sid, code });
    for (const fn of exitObservers) { try { fn(appName, sid, code, killed || !!signal, cmd); } catch (err) { console.warn('[spawn] exit observer failed:', err.message); } }
  });

  return { spawnId: sid, pid: proc.pid };
}

function kill(sid) {
  const entry = spawned.get(sid);
  if (entry) {
    entry.killed = true; // a deliberate kill is not a failure (exit observers)
    try { entry.proc.kill('SIGTERM'); } catch {}
    spawned.delete(sid);
  }
  return true;
}

// onExit(fn(appName, spawnId, code, killed, command)) — every spawn exit.
// Returns an unsubscribe function. Feeds Horst's spawn:failed sense.
const exitObservers = [];
function onExit(fn) {
  exitObservers.push(fn);
  return () => { const i = exitObservers.indexOf(fn); if (i >= 0) exitObservers.splice(i, 1); };
}

// Called on app stop/close (and via remove/rename). Tears down transient spawned
// processes but NOT cron jobs — those are persisted in platform-cron and survive
// a stop. App deletion removes them explicitly.
function cleanupApp(name) {
  for (const [sid, entry] of spawned) {
    if (entry.appName === name) {
      killWithTimeout(entry.proc);
      spawned.delete(sid);
    }
  }
}

function cleanup() {
  for (const [, entry] of spawned) {
    try { entry.proc.kill('SIGTERM'); } catch {}
  }
  spawned.clear();
}

function listTasks() {
  const spawnList = [];
  for (const [sid, entry] of spawned) {
    spawnList.push({
      spawnId: sid,
      appName: entry.appName,
      pid: entry.proc?.pid,
      command: entry.command || '(unknown)',
      startedAt: entry.startedAt,
      recentOutput: entry.recentOutput || [],
    });
  }
  // Cron jobs now live in platform-cron; surface the app-scoped ones in the task list.
  const platformCron = require('./platform-cron');
  const cronList = platformCron.list()
    .filter(j => j.appName)
    .map(j => ({
      jobId: j.id,
      appName: j.appName,
      command: j.target?.command,
      schedule: j.schedule,
      startedAt: j.createdAt,
      lastRunAt: j.lastRunAt,
      lastExitCode: j.lastError ? 1 : 0,
    }));
  return { spawned: spawnList, cron: cronList };
}

module.exports = {
  spawned, MAX_SPAWNS_PER_APP, nextId, currentId, track, untrack, countForApp,
  exec, spawn, kill, cleanupApp, cleanup, listTasks, onExit,
};
