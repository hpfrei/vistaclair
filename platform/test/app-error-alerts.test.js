// App errors reach the owner as header alerts: app-guard turns a start
// failure, a runtime error and a crash loop into `toast:push` (core
// public/toast.js → the header bell), coalesced so a storm is not a flood.
// Start failures (app-manager.startApp) and browser errors from app iframes
// (`app:clientError`) are recorded there like every other app failure.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { makeAppsDir } = require('./helpers');
const apps = require('../src/apps/index');
const guard = require('../src/apps/app-guard');
const appManager = require('../src/apps/app-manager');

const appsDir = makeAppsDir({ 'al-app': {}, 'al-broken': {}, 'al-setup': {} });
fs.writeFileSync(path.join(appsDir, 'al-broken', 'routes.js'), 'module.exports = (router, ctx) => { this is not js };\n');
fs.writeFileSync(path.join(appsDir, 'al-setup', 'routes.js'), 'module.exports = () => { throw new Error("setup boom"); };\n');
apps.initSessions({ appsDir, broadcaster: { broadcast() {} } });
appManager.setAppsDir(appsDir);

const sent = [];
guard.init({ broadcaster: { broadcast: (m) => sent.push(m) } });
test.after(() => { guard._reset(); fs.rmSync(appsDir, { recursive: true, force: true }); });

const toasts = () => sent.filter((m) => m.type === 'toast:push');

function quiet(fn) {
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = () => {};
  const restore = () => Object.assign(console, orig);
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.finally(restore);
    restore();
    return r;
  } catch (err) { restore(); throw err; }
}

test('a start failure raises one error alert in the header bell, with the app name', () => {
  guard._reset(); sent.length = 0;
  quiet(() => guard.record('al-app', 'process', new Error('Cannot find module x'), { code: 1, phase: 'start' }));
  assert.equal(toasts().length, 1);
  const t = toasts()[0];
  assert.equal(t.level, 'error');
  assert.equal(t.sender, 'al-app');
  assert.equal(t.title, 'Start failed');
  assert.match(t.message, /Cannot find module x/);
  // A second failure in the window is coalesced: logged and counted, no new alert.
  quiet(() => guard.record('al-app', 'start', new Error('again'), { phase: 'start' }));
  assert.equal(toasts().length, 1);
  assert.equal(guard.status('al-app').count, 2);
  guard._reset();
});

test('runtime errors raise one alert per app per window, apart from start failures', () => {
  guard._reset(); sent.length = 0;
  quiet(() => {
    for (let i = 0; i < 3; i++) guard.record('al-app', 'route', new Error(`r${i}`));
    guard.record('al-app', 'start', new Error('start'), { phase: 'start' });
    guard.record('al-setup', 'jobs.run', new Error('other app'));
  });
  const byTitle = toasts().map((t) => `${t.sender}:${t.title}`);
  assert.deepEqual(byTitle, ['al-app:Runtime error', 'al-app:Start failed', 'al-setup:Runtime error']);
  assert.match(toasts()[0].message, /^route: r0/);
  guard._reset();
});

test('a failure storm is one runtime alert and one crash-loop alert, then silence', () => {
  guard._reset(); sent.length = 0;
  quiet(() => { for (let i = 0; i < guard.CRASHLOOP_MIN * 3; i++) guard.record('al-app', 'telegram.onUpdate', new Error(`s${i}`)); });
  assert.deepEqual(toasts().map((t) => t.title), ['Runtime error', 'Crash loop']);
  assert.ok(toasts().every((t) => t.level === 'error' && t.sender === 'al-app'));
  // Inside the cooling window a start failure stays quiet too: the loop said it.
  quiet(() => guard.record('al-app', 'start', new Error('restart failed'), { phase: 'start' }));
  assert.equal(toasts().length, 2);
  guard._reset();
});

test('the same error object is recorded once (attempt rethrows to startApp)', () => {
  guard._reset(); sent.length = 0;
  const err = new Error('once');
  quiet(() => assert.throws(() => guard.attempt('al-app', 'routes.setup', () => { throw err; })));
  assert.equal(quiet(() => guard.record('al-app', 'start', err, { phase: 'start' })), null);
  assert.equal(guard.status('al-app').count, 1);
  assert.deepEqual(toasts().map((t) => t.title), ['Start failed']);
  guard._reset();
});

test('startApp records an in-process start failure and raises the alert', async () => {
  guard._reset(); sent.length = 0;
  await quiet(() => assert.rejects(appManager.startApp('al-broken', null)));
  const s = guard.status('al-broken');
  assert.equal(s.count, 1);
  assert.equal(s.recent[0].surface, 'start');
  assert.deepEqual(toasts().map((t) => `${t.sender}:${t.title}`), ['al-broken:Start failed']);

  // A throwing routes.js setup: one record (routes.setup), one Start-failed alert.
  await quiet(() => assert.rejects(appManager.startApp('al-setup', null), /setup boom/));
  assert.equal(guard.status('al-setup').count, 1);
  assert.equal(guard.status('al-setup').recent[0].surface, 'routes.setup');
  assert.deepEqual(toasts().map((t) => `${t.sender}:${t.title}`), ['al-broken:Start failed', 'al-setup:Start failed']);
  guard._reset();
});

test('app:clientError records a browser error server-side; unknown apps are ignored', async () => {
  guard._reset(); sent.length = 0;
  const replies = [];
  const ws = { send: (s) => replies.push(JSON.parse(s)) };
  const error = { message: 'Uncaught TypeError: x is undefined', source: 'http://h/apps/al-app/app.js', lineno: 12, colno: 3 };
  await quiet(() => apps.handleMessage(ws, { type: 'app:clientError', name: 'al-app', error }, { broadcast() {} }));
  await quiet(() => apps.handleMessage(ws, { type: 'app:clientError', name: 'no-such-app', error }, { broadcast() {} }));
  const rec = guard.recent('al-app');
  assert.equal(rec.length, 1);
  assert.equal(rec[0].surface, 'browser');
  assert.equal(rec[0].error, error.message);
  assert.equal(rec[0].where, 'app.js:12:3');
  assert.deepEqual(guard.recent('no-such-app'), []);
  assert.deepEqual(toasts().map((t) => `${t.sender}:${t.title}`), ['al-app:Runtime error']);
  assert.deepEqual(replies, []);
  guard._reset();
});

test('app:autofix is no longer handled', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'apps', 'index.js'), 'utf-8');
  assert.ok(!src.includes('app:autofix'));
  const replies = [];
  const broadcasts = [];
  await quiet(() => apps.handleMessage({ send: (s) => replies.push(JSON.parse(s)) },
    { type: 'app:autofix', name: 'al-app', error: 'boom' }, { broadcast: (m) => broadcasts.push(m) }));
  assert.ok(!replies.some((m) => /autofix|cliSpawned/.test(m.type)));
  assert.deepEqual(broadcasts, []);
});
