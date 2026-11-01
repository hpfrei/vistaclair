#!/usr/bin/env node
'use strict';
// vistaclair-lock: a machine-wide, process-scoped resource lock.
//
//   node bin/vistaclair-lock.js [-s|--shared] [-x|--exclusive] [--timeout <sec>]
//                               <name>[,<name>...] -- <command> [args...]
//
// Takes every named lock (sorted, so no deadlock between callers), runs the
// command, forwards SIGINT/SIGTERM/SIGHUP to it, releases when it exits and
// exits with its exit code. The lock is a kernel flock(2) held by helper
// processes that die with this wrapper, so kill -9 or a server restart
// releases it. See README "Resource locks". Exit codes: the command's;
// 75 lock busy / timed out; 64 usage; 69 flock(1) unavailable.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const locks = require('../src/locks');

const EX_USAGE = 64, EX_UNAVAILABLE = 69, EX_TEMPFAIL = 75, CONFLICT = 200;

function usage(msg) {
  if (msg) process.stderr.write(`vistaclair-lock: ${msg}\n`);
  process.stderr.write('usage: vistaclair-lock [-s|--shared] [-x|--exclusive] [--timeout <sec>] <name>[,<name>...] -- <command> [args...]\n');
  process.exit(EX_USAGE);
}

function parseArgs(argv) {
  const o = { mode: 'exclusive', timeout: null, names: [], command: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { i++; break; }
    if (a === '-s' || a === '--shared') o.mode = 'shared';
    else if (a === '-x' || a === '--exclusive') o.mode = 'exclusive';
    else if (a === '--timeout' || a.startsWith('--timeout=')) {
      const v = a === '--timeout' ? argv[++i] : a.slice(10);
      const n = Number(v);
      if (v === undefined || v === '' || !Number.isFinite(n) || n < 0) usage('--timeout needs a number of seconds');
      o.timeout = n;
    } else if (a === '-h' || a === '--help') usage();
    else if (a.startsWith('-') && a.length > 1) usage(`unknown option ${a}`);
    else if (!o.names.length) o.names = a.split(',').filter(Boolean);
    else usage(`unexpected argument ${a} (put the command after --)`);
  }
  o.command = argv.slice(i);
  if (!o.names.length) usage('no lock name');
  if (!o.command.length) usage('no command (put it after --)');
  for (const n of o.names) if (!locks.validName(n)) usage(`bad lock name "${n}" (use [a-z0-9._-], up to 64 characters)`);
  o.names = [...new Set(o.names)].sort();
  return o;
}

// Locks an ancestor wrapper still holds (env VISTACLAIR_LOCKS_HELD="pid:name=mode,..."),
// so a command run under a lock may ask for the same lock again without deadlocking itself.
function inheritedHeld(env) {
  const m = /^(\d+):(.*)$/.exec(env.VISTACLAIR_LOCKS_HELD || '');
  const held = new Map();
  if (m && locks.pidAlive(Number(m[1]))) {
    for (const part of m[2].split(',')) { const [n, md] = part.split('='); if (n) held.set(n, md); }
  }
  return held;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const env = process.env;
  const landing = env.VISTACLAIR_LANDING === '1' && opts.timeout === null;
  const timeout = landing ? 0 : opts.timeout; // null = wait forever; 0 = fail at once

  if (process.platform === 'win32' || spawnSync('flock', ['--version'], { stdio: 'ignore' }).error) {
    process.stderr.write('vistaclair-lock: flock(1) (util-linux) is required and was not found on this machine\n');
    process.exit(EX_UNAVAILABLE);
  }

  const dir = locks.resolveLockDir(env);
  const holdersDir = path.join(dir, 'holders');
  const waitersDir = path.join(dir, 'waiters');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    process.stderr.write(`vistaclair-lock: cannot create ${dir}: ${e.message}\n`);
    process.exit(EX_UNAVAILABLE);
  }

  locks.pruneStale(dir);
  const me = {
    pid: process.pid, since: Date.now(), command: opts.command, cwd: process.cwd(),
    session: env.VISTACLAIR_SESSION_NAME || null, instanceId: env.VISTACLAIR_INSTANCE_ID || null,
    user: os.userInfo().username, host: os.hostname(),
  };
  const heldNames = []; // [{ name, mode, since }]
  const holders = [];   // helper flock processes
  let command = null;
  let aborted = null;   // signal name once we were told to stop

  const publishHeld = () => locks.writeRecord(holdersDir, process.pid, { ...me, locks: heldNames });

  async function releaseAll() {
    locks.removeRecord(waitersDir, process.pid);
    locks.removeRecord(holdersDir, process.pid);
    await Promise.all(holders.map(h => new Promise((resolve) => {
      if (h.exitCode !== null || h.signalCode) return resolve();
      h.once('close', resolve);
      try { h.stdin.end(); } catch {}
      setTimeout(() => { try { h.kill('SIGKILL'); } catch {} }, 2000).unref();
    })));
  }

  async function finish(code) {
    await releaseAll();
    process.exit(code);
  }

  // One flock helper: holds the lock while its stdin stays open. Resolves
  // { ok:true, child } | { ok:false, conflict:true } | { ok:false, error }.
  function takeFlock(name, mode, waitSec) {
    return new Promise((resolve) => {
      const args = [mode === 'shared' ? '-s' : '-x', '-E', String(CONFLICT)];
      if (waitSec === 0) args.push('-n'); else if (waitSec !== null) args.push('-w', String(waitSec));
      args.push(path.join(dir, `${name}.lock`), 'sh', '-c', 'echo L; exec cat >/dev/null');
      const child = spawn('flock', args, { stdio: ['pipe', 'pipe', 'inherit'] });
      let got = false;
      child.stdout.on('data', () => { if (!got) { got = true; resolve({ ok: true, child }); } });
      child.on('error', (e) => resolve({ ok: false, error: e.message }));
      child.on('close', (code) => {
        if (got) return;
        if (code === CONFLICT) resolve({ ok: false, conflict: true });
        else resolve({ ok: false, error: `flock exited ${code}` });
      });
      child.stdin.on('error', () => {});
      pendingChild = child;
    });
  }
  let pendingChild = null;

  function busyMessage(name) {
    const hs = locks.readRecords(holdersDir).filter(r => (r.locks || []).some(l => l.name === name));
    if (!hs.length) return 'held by another process';
    return 'held by ' + hs.map(r => {
      const l = r.locks.find(x => x.name === name);
      return `${locks.describe(r)} (${l.mode}) since ${new Date(l.since || r.since).toLocaleTimeString()}`;
    }).join('; ');
  }

  async function acquire(name, mode, deadline) {
    const remaining = () => (deadline === null ? null : Math.max(0, (deadline - Date.now()) / 1000));
    let r = await takeFlock(name, mode, 0);
    if (r.ok) return r;
    if (r.error) throw new Error(r.error);
    const left = remaining();
    if (left === 0) return { busy: true };
    process.stderr.write(`vistaclair-lock: waiting for ${name} (${busyMessage(name)})\n`);
    locks.writeRecord(waitersDir, process.pid, { ...me, waiting: { name, mode } });
    r = await takeFlock(name, mode, left);
    locks.removeRecord(waitersDir, process.pid);
    if (r.ok) return r;
    if (r.conflict) return { busy: true };
    throw new Error(r.error);
  }

  const forwarded = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const signo = (s) => os.constants.signals[s] || 0;
  for (const s of forwarded) {
    process.on(s, () => {
      aborted = aborted || s;
      if (command) { try { command.kill(s); } catch {} }
      else {
        try { pendingChild && pendingChild.kill('SIGKILL'); } catch {}
        finish(128 + signo(s));
      }
    });
  }

  (async () => {
    const already = inheritedHeld(env);
    const deadline = timeout === null ? null : Date.now() + timeout * 1000;
    for (const name of opts.names) {
      const have = already.get(name);
      if (have === 'exclusive' || (have === 'shared' && opts.mode === 'shared')) continue;
      let r;
      try { r = await acquire(name, opts.mode, deadline); } catch (e) {
        process.stderr.write(`vistaclair-lock: ${e.message}\n`);
        return finish(EX_UNAVAILABLE);
      }
      if (aborted) return; // the signal handler is finishing
      if (r.busy) {
        process.stderr.write(`vistaclair-lock: ${name} is busy (${busyMessage(name)}); ${landing ? 'landing checks never wait' : 'timed out'}\n`);
        return finish(EX_TEMPFAIL);
      }
      holders.push(r.child);
      heldNames.push({ name, mode: opts.mode, since: Date.now() });
      publishHeld();
    }

    const held = heldNames.map(l => `${l.name}=${l.mode}`);
    for (const [n, m] of already) if (!heldNames.some(l => l.name === n)) held.push(`${n}=${m}`);
    const childEnv = { ...env, VISTACLAIR_LOCKS_HELD: `${process.pid}:${held.join(',')}` };
    command = spawn(opts.command[0], opts.command.slice(1), { stdio: 'inherit', env: childEnv });
    if (aborted) { try { command.kill(aborted); } catch {} }
    command.on('error', (e) => {
      process.stderr.write(`vistaclair-lock: cannot run ${opts.command[0]}: ${e.message}\n`);
      finish(e.code === 'ENOENT' ? 127 : 126);
    });
    command.on('close', (code, sig) => finish(sig ? 128 + signo(sig) : (code === null ? 1 : code)));
  })();
}

main();
