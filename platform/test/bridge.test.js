// End-to-end bridge calls for the pure (no host service) capabilities.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { makeAppsDir, call } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const appBridge = require('../src/apps/app-bridge');

const appsDir = makeAppsDir({ 'b-app': { capabilities: { fs: true, state: true, settings: true, exec: true } } });
appManager.setAppsDir(appsDir);
const dir = path.join(appsDir, 'b-app');
test.after(() => { appBridge.cleanup(); fs.rmSync(appsDir, { recursive: true, force: true }); });

test('fs.* inside the app dir', async () => {
  assert.equal((await call(appBridge, 'b-app', 'fs.exists', { path: 'a/b.txt' })).result, false);
  assert.equal((await call(appBridge, 'b-app', 'fs.write', { path: 'a/b.txt', content: 'hi' })).result, true);
  assert.equal((await call(appBridge, 'b-app', 'fs.exists', { path: 'a/b.txt' })).result, true);
  assert.equal((await call(appBridge, 'b-app', 'fs.read', { path: 'a/b.txt' })).result, 'hi');
  assert.deepEqual((await call(appBridge, 'b-app', 'fs.list', { dir: 'a' })).result, [{ name: 'b.txt', isDir: false }]);
  const escape = await call(appBridge, 'b-app', 'fs.read', { path: '../../etc/passwd' });
  assert.ok(escape.error, 'path escape must be refused');
});

test('state.* round-trips through the per-app lock', async () => {
  assert.equal((await call(appBridge, 'b-app', 'state.get', {})).result, null);
  assert.equal((await call(appBridge, 'b-app', 'state.set', { key: 'k', value: { n: 1 } })).result, true);
  assert.deepEqual((await call(appBridge, 'b-app', 'state.get', { key: 'k' })).result, { n: 1 });
  assert.deepEqual((await call(appBridge, 'b-app', 'state.get', {})).result, { k: { n: 1 } });
  assert.equal((await call(appBridge, 'b-app', 'state.delete', { key: 'k' })).result, true);
  assert.deepEqual((await call(appBridge, 'b-app', 'state.get', {})).result, {});
  assert.equal((await call(appBridge, 'b-app', 'state.clear', {})).result, true);
  assert.ok(fs.existsSync(path.join(dir, '.state.json')));
});

test('settings.* validate and merge', async () => {
  const bad = await call(appBridge, 'b-app', 'settings.set', {});
  assert.equal(bad.error, 'key or values required');
  assert.equal((await call(appBridge, 'b-app', 'settings.set', { key: 'a', value: 1 })).result, true);
  assert.equal((await call(appBridge, 'b-app', 'settings.set', { values: { b: 2 } })).result, true);
  assert.deepEqual((await call(appBridge, 'b-app', 'settings.all', { defaults: { c: 3 } })).result, { a: 1, b: 2, c: 3 });
  assert.equal((await call(appBridge, 'b-app', 'settings.get', { key: 'zz' })).result, null);
});

test('exec and spawn through the spawn manager', async () => {
  const r = await call(appBridge, 'b-app', 'exec', { command: 'echo hello' });
  assert.deepEqual(r.result, { stdout: 'hello\n', stderr: '', code: 0 });
  assert.equal((await call(appBridge, 'b-app', 'exec', {})).error, 'No command provided');
  const events = [];
  const exited = new Promise((resolve) => {
    call(appBridge, 'b-app', 'spawn', { command: 'echo', args: ['spawned'] }, (event, data) => {
      events.push(event);
      if (event === 'spawn:exit') resolve(data);
    }).then((res) => { assert.ok(res.result.spawnId); assert.ok(res.result.pid); });
  });
  const exit = await exited;
  assert.equal(exit.code, 0);
  assert.ok(events.includes('spawn:stdout'));
  assert.deepEqual(appBridge.listTasks().spawned, []);
});

test('a synchronous handler throw still yields exactly one error response', async () => {
  // params undefined → property access throws inside the handler
  const r = await call(appBridge, 'b-app', 'fs.read', undefined);
  assert.ok(r.error);
});
