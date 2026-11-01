// vistaclair-lock: the machine-wide process-scoped resource lock
// (bin/vistaclair-lock.js) and its readers (src/locks.js).
//
//   node --test test/vistaclair-lock.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');
const locks = require('../src/locks');

const BIN = path.join(__dirname, '..', 'bin', 'vistaclair-lock.js');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-lock-'));
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const live = [];
test.afterEach(() => { for (const p of live.splice(0)) { try { p.kill('SIGKILL'); } catch {} } });

// Run the wrapper; resolves helpers to watch stderr and the exit.
function lock(args, { env = {} } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, VISTACLAIR_LOCK_DIR: DIR, VISTACLAIR_LANDING: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  live.push(child);
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const exit = new Promise(r => child.on('close', (code, sig) => r({ code, sig, out, err })));
  return { child, exit, out: () => out, err: () => err };
}
const sleeper = (sec = 30) => ['--', process.execPath, '-e', `console.log('running'); setTimeout(()=>{}, ${sec * 1000})`];
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(25); }
  throw new Error('timed out waiting');
}
// Does a lock with this name/mode get granted at once?
async function free(name, mode = '-x') {
  const r = await lock([mode, '--timeout', '0', name, '--', 'true']).exit;
  return r.code === 0;
}

test('exit code passes through', async () => {
  assert.strictEqual((await lock(['a', '--', 'sh', '-c', 'exit 7']).exit).code, 7);
  assert.strictEqual((await lock(['a', '--', 'true']).exit).code, 0);
  assert.strictEqual((await lock(['a', '--', 'definitely-not-a-command-xyz']).exit).code, 127);
});

test('usage errors and bad names exit 64', async () => {
  assert.strictEqual((await lock(['a']).exit).code, 64);
  assert.strictEqual((await lock(['Bad Name', '--', 'true']).exit).code, 64);
  assert.strictEqual((await lock(['a'.repeat(65), '--', 'true']).exit).code, 64);
});

test('exclusive blocks a second exclusive and a shared; both go once released', async () => {
  const holder = lock(['gpu', ...sleeper()]);
  await until(() => holder.out().includes('running'));
  assert.strictEqual(await free('gpu', '-x'), false);
  assert.strictEqual(await free('gpu', '-s'), false);
  const waiter = lock(['gpu', '--', 'echo', 'got-it']);
  await until(() => /waiting for gpu \(held by/.test(waiter.err()));
  holder.child.kill('SIGTERM');
  const r = await waiter.exit;
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /got-it/);
});

test('shared + shared coexist; an exclusive is blocked by them', async () => {
  const a = lock(['-s', 'heavy', ...sleeper()]);
  const b = lock(['--shared', 'heavy', ...sleeper()]);
  await until(() => a.out().includes('running') && b.out().includes('running'));
  assert.strictEqual(await free('heavy', '-s'), true);
  assert.strictEqual(await free('heavy', '-x'), false);
});

test('a holder killed with SIGKILL releases the lock', async () => {
  const holder = lock(['k', ...sleeper(5)]);
  await until(() => holder.out().includes('running'));
  assert.strictEqual(await free('k'), false);
  // The command is orphaned (it is not the wrapper's to kill), the lock is not.
  holder.child.kill('SIGKILL');
  let ok = false;
  for (let i = 0; i < 100 && !ok; i++) { ok = await free('k'); if (!ok) await sleep(50); }
  assert.ok(ok, 'lock released after kill -9');
});

test('signals reach the command; its signal death is 128+n', async () => {
  const run = lock(['sig', '--', 'sh', '-c', 'echo up; exec sleep 30']);
  await until(() => run.out().includes('up'));
  run.child.kill('SIGTERM');
  assert.strictEqual((await run.exit).code, 143);
});

test('several names in any order do not deadlock', async () => {
  const one = lock(['m2,m1,m3', '--', process.execPath, '-e', 'setTimeout(()=>{}, 300)']);
  const two = lock(['m3,m1,m2', '--', 'true']);
  const three = lock(['m1,m3', '--', 'true']);
  const rs = await Promise.race([Promise.all([one.exit, two.exit, three.exit]), sleep(10000).then(() => null)]);
  assert.ok(rs, 'all finished');
  assert.deepStrictEqual(rs.map(r => r.code), [0, 0, 0]);
});

test('VISTACLAIR_LANDING=1 fails fast with exit 75 naming the holder; --timeout waits', async () => {
  const holder = lock(['land', ...sleeper()]);
  await until(() => holder.out().includes('running'));
  const t0 = Date.now();
  const r = await lock(['land', '--', 'true'], { env: { VISTACLAIR_LANDING: '1' } }).exit;
  assert.strictEqual(r.code, 75);
  assert.match(r.err, /land is busy \(held by .*pid \d+/);
  assert.ok(Date.now() - t0 < 3000);
  // Not landing: a short explicit timeout runs out with 75 too.
  assert.strictEqual((await lock(['--timeout', '0.3', 'land', '--', 'true']).exit).code, 75);
  // Landing plus an explicit timeout waits for the holder.
  const w = lock(['--timeout', '10', 'land', '--', 'echo', 'ok'], { env: { VISTACLAIR_LANDING: '1' } });
  await until(() => /waiting for land/.test(w.err()));
  holder.child.kill('SIGTERM');
  assert.strictEqual((await w.exit).code, 0);
  // Free lock: landing proceeds.
  assert.strictEqual((await lock(['land', '--', 'true'], { env: { VISTACLAIR_LANDING: '1' } }).exit).code, 0);
});

test('a command may ask for a lock its wrapper already holds', async () => {
  const r = await lock(['nest', '--', process.execPath, BIN, '--timeout', '0', 'nest', '--', 'echo', 'inner']).exit;
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /inner/);
});

test('holder and waiter records are listed; records are removed on exit', async () => {
  const holder = lock(['rec', '-x', ...sleeper()], { env: { VISTACLAIR_INSTANCE_ID: 'inst-1' } });
  await until(() => holder.out().includes('running'));
  const waiter = lock(['-s', 'rec', '--', 'true']);
  await until(() => locks.listLocks(DIR).locks.some(l => l.name === 'rec' && l.waiters.length));
  const l = locks.listLocks(DIR).locks.find(x => x.name === 'rec');
  assert.strictEqual(l.holders.length, 1);
  assert.strictEqual(l.holders[0].pid, holder.child.pid);
  assert.strictEqual(l.holders[0].mode, 'exclusive');
  assert.strictEqual(l.holders[0].instanceId, 'inst-1');
  assert.ok(l.holders[0].command.includes('-e'));
  assert.strictEqual(l.waiters[0].pid, waiter.child.pid);
  assert.strictEqual(l.waiters[0].mode, 'shared');
  holder.child.kill('SIGTERM');
  await waiter.exit;
  await holder.exit;
  assert.ok(!locks.listLocks(DIR).locks.some(x => x.name === 'rec'));
  assert.ok(!fs.existsSync(path.join(DIR, 'holders', `${holder.child.pid}.json`)));
  assert.ok(!fs.existsSync(path.join(DIR, 'waiters', `${waiter.child.pid}.json`)));
});

test('records of dead pids are ignored', () => {
  const dir = fs.mkdtempSync(path.join(DIR, 'stale-'));
  const dead = 2 ** 22 + 12345; // beyond pid_max on any normal system
  locks.writeRecord(path.join(dir, 'holders'), dead, { pid: dead, since: 1, locks: [{ name: 'x', mode: 'exclusive', since: 1 }], command: ['c'] });
  locks.writeRecord(path.join(dir, 'waiters'), dead, { pid: dead, since: 1, waiting: { name: 'x', mode: 'shared' } });
  locks.writeRecord(path.join(dir, 'holders'), process.pid, { pid: process.pid, since: 2, locks: [{ name: 'y', mode: 'shared', since: 2 }], command: ['c'] });
  fs.writeFileSync(path.join(dir, 'holders', 'junk.json'), '{nope');
  const r = locks.listLocks(dir);
  assert.strictEqual(r.dir, dir);
  assert.deepStrictEqual(r.locks.map(l => l.name), ['y']);
  assert.strictEqual(r.locks[0].holders[0].mode, 'shared');
  assert.deepStrictEqual(locks.listLocks(path.join(dir, 'missing')).locks, []);
});

test('lock directory resolution: override, data home, worktree', () => {
  assert.strictEqual(locks.resolveLockDir({ VISTACLAIR_LOCK_DIR: '/x/l' }, '/p'), '/x/l');
  assert.strictEqual(locks.resolveLockDir({ VISTACLAIR_DATA_HOME: '/h' }, '/p'), '/h/data/locks');
  assert.strictEqual(locks.resolveLockDir({ VISTACLAIR_HOME: '/h2' }, '/p'), '/h2/data/locks');
  assert.strictEqual(locks.resolveLockDir({}, '/home/u/vc/data/worktrees/r/w1'), '/home/u/vc/data/locks');
  assert.strictEqual(locks.resolveLockDir({}, '/home/u/vc'), '/home/u/vc/data/locks');
  assert.strictEqual(locks.resolveLockDir({}, '/usr/lib/node_modules/vistaclair'), path.join(os.homedir(), '.vistaclair', 'data', 'locks'));
});

test('GET /api/locks handler returns { dir, locks }', () => {
  let body;
  locks.locksHandler(DIR)({}, { json: (b) => { body = b; }, status() { return this; } });
  assert.strictEqual(body.dir, DIR);
  assert.ok(Array.isArray(body.locks));
});

test('the api router registers GET /locks', () => {
  const router = require('../src/api')({ broadcaster: {}, store: {}, proxyPort: 0, dashboardPort: 0, authToken: 'x', cliSessionManager: {} });
  assert.ok(router.stack.some(l => l.route && l.route.path === '/locks' && l.route.methods.get));
});
