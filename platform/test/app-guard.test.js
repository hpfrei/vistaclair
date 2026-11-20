// Attributed app failures: every callback site that runs app code outside a
// request reports to app-guard, which counts per app, coalesces dashboard
// notices, detects crash loops once per cooling window, and feeds app status.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { makeAppsDir, silenceWarn } = require('./helpers');
const guard = require('../src/apps/app-guard');
const appManager = require('../src/apps/app-manager');

const appsDir = makeAppsDir({ 'gd-app': { capabilities: { tools: true } }, 'gd-quiet': {} });
appManager.setAppsDir(appsDir);
test.after(() => { fs.rmSync(appsDir, { recursive: true, force: true }); guard._reset(); });

const sent = [];
guard.init({ broadcaster: { broadcast: (m) => sent.push(m) } });

function silenceError(fn) {
  const orig = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = orig; }
}

test('record counts per app, keeps a ring, and ignores platform pseudo-apps', () => {
  guard._reset(); sent.length = 0;
  silenceError(() => {
    guard.record('gd-app', 'telegram.onUpdate', new Error('boom'));
    guard.record('gd-app', 'jobs.run', 'plain string');
    assert.equal(guard.record('horst', 'x', new Error('no')), null);
    assert.equal(guard.record('__platform__', 'x', new Error('no')), null);
  });
  const s = guard.status('gd-app');
  assert.equal(s.count, 2);
  assert.equal(s.lastError, 'jobs.run: plain string');
  assert.equal(s.recent.length, 2);
  assert.equal(s.recent[0].surface, 'telegram.onUpdate');
  assert.equal(s.crashloop, false);
  assert.deepEqual(guard.status('horst'), { count: 0, lastAt: null, lastError: null, recent: [], crashloop: false });
});

test('dashboard notices are coalesced: one app:runtimeError per app per window', () => {
  guard._reset(); sent.length = 0;
  silenceError(() => { for (let i = 0; i < 4; i++) guard.record('gd-app', 'route', new Error(`e${i}`)); });
  const notices = sent.filter((m) => m.type === 'app:runtimeError');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].appName, 'gd-app');
  assert.equal(notices[0].count, 1);
  guard._reset(); // drops the pending coalesced timer
});

test('a failure storm raises exactly one app:crashloop per cooling window', () => {
  guard._reset(); sent.length = 0;
  silenceError(() => { for (let i = 0; i < guard.CRASHLOOP_MIN + 5; i++) guard.record('gd-app', 'telegram.onUpdate', new Error('loop')); });
  const loops = sent.filter((m) => m.type === 'app:crashloop');
  assert.equal(loops.length, 1);
  assert.equal(loops[0].appName, 'gd-app');
  assert.ok(loops[0].count >= guard.CRASHLOOP_MIN);
  assert.deepEqual(loops[0].surfaces, ['telegram.onUpdate']);
  assert.equal(guard.status('gd-app').crashloop, true);
  // A restart opens a fresh window: the flag clears and the storm may be re-announced later.
  guard.resetWindow('gd-app');
  assert.equal(guard.status('gd-app').crashloop, false);
  assert.equal(guard.status('gd-app').count, guard.CRASHLOOP_MIN + 5, 'history survives a window reset');
  guard._reset();
});

test('process crashes accumulate to a crash loop across restarts (resetWindow keeps them)', () => {
  guard._reset(); sent.length = 0;
  silenceError(() => {
    // Own-process life cycle: startApp resets the window, the crash records one
    // 'process' failure. Repeated crash→restart must still reach crashloop.
    for (let i = 0; i < guard.CRASHLOOP_MIN + 1; i++) {
      guard.resetWindow('gd-app');
      guard.record('gd-app', 'process', new Error('Process exited with code 1'), { code: 1, phase: 'run' });
    }
  });
  const loops = sent.filter((m) => m.type === 'app:crashloop');
  assert.equal(loops.length, 1, 'crash-restart cycle raises the loop');
  assert.equal(guard.status('gd-app').crashloop, true);
  // A restart after a NON-process failure still clears the window as before.
  silenceError(() => guard.record('gd-app', 'route', new Error('x')));
  guard.resetWindow('gd-app');
  assert.equal(guard.status('gd-app').crashloop, false);
  guard._reset();
});

test('run swallows sync and async throws; attempt records and rethrows', async () => {
  guard._reset(); sent.length = 0;
  await silenceError(async () => {
    guard.run('gd-app', 'sync', () => { throw new Error('s'); });
    guard.run('gd-app', 'async', async () => { throw new Error('a'); });
    await new Promise((r) => setImmediate(r));
    assert.throws(() => guard.attempt('gd-app', 'setup', () => { throw new Error('t'); }), /t/);
    await assert.rejects(guard.attempt('gd-app', 'setup-async', async () => { throw new Error('u'); }), /u/);
    assert.equal(guard.attempt('gd-app', 'ok', () => 42), 42);
  });
  const s = guard.status('gd-app');
  assert.equal(s.count, 4);
  assert.deepEqual(s.recent.map((e) => e.surface), ['sync', 'async', 'setup', 'setup-async']);
  guard._reset();
});

test('a throwing tool handler is attributed to its app under tools.<name>', async () => {
  guard._reset(); sent.length = 0;
  const appTools = require('../src/apps/app-tools');
  await silenceWarn(async () => {
    appTools.registerAppTools('gd-app', [{ name: 'explode', expose: 'self', description: 'x' }]);
    appTools.registerAppToolHandler('gd-app', 'explode', async () => { throw new Error('tool died'); });
  });
  await silenceError(() => assert.rejects(appTools.callAppToolHandler('gd-app', 'explode', {}, { type: 'self' }), /tool died/));
  const s = guard.status('gd-app');
  assert.equal(s.count, 1);
  assert.equal(s.lastError, 'tools.explode: tool died');
  appTools.clearAppTools('gd-app');
  guard._reset();
});

test('a throwing engine event handler is attributed; platform subscribers are not', () => {
  guard._reset(); sent.length = 0;
  const emailEngine = require('../src/apps/email-engine');
  const off1 = emailEngine.registerHandler('gd-app', 'email:new', () => { throw new Error('handler died'); });
  const off2 = emailEngine.registerHandler('horst', 'email:new', () => { throw new Error('platform died'); });
  silenceError(() => emailEngine.dispatch('email:new', { account: 'a', messages: [] }));
  off1(); off2();
  assert.equal(guard.status('gd-app').count, 1);
  assert.equal(guard.status('gd-app').lastError, 'email.email:new: handler died');
  assert.equal(guard.status('horst').count, 0);
  guard._reset();
});

test('app status and list expose the guard: errors always, _errors only once non-zero', () => {
  guard._reset(); sent.length = 0;
  const before = appManager.getAppStatus('gd-app');
  assert.deepEqual(before.errors, { count: 0, lastAt: null, lastError: null, recent: [], crashloop: false });
  assert.ok(!('_errors' in appManager.list().find((a) => a.name === 'gd-app')));
  silenceError(() => guard.record('gd-app', 'jobs.run', new Error('j')));
  assert.equal(appManager.getAppStatus('gd-app').errors.count, 1);
  assert.equal(appManager.list().find((a) => a.name === 'gd-app')._errors, 1);
  assert.ok(!('_errors' in appManager.list().find((a) => a.name === 'gd-quiet')));
  guard._reset();
});
