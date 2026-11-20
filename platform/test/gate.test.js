// Open-world: capability declarations are ADVERTISEMENTS — every app gets the
// full platform surface for its profile on both the routes.js ctx and the
// bridge. Profile visibility (public/standalone stripping of owner sinks) is
// the only structural gate left; economic control lives in spend-gate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { makeAppsDir, call } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const capabilities = require('../src/apps/capabilities');
const appBridge = require('../src/apps/app-bridge');

const appsDir = makeAppsDir({
  'g-db': { capabilities: { db: true } },
  'g-legacy': {},
});
appManager.setAppsDir(appsDir);
test.after(() => fs.rmSync(appsDir, { recursive: true, force: true }));

function ctxFor(name, profile = 'dashboard') {
  const dir = appManager.appDir(name);
  return capabilities.buildCtx({ name, dir, manifest: appManager.readManifest(name), broadcaster: { broadcast() {} } }, { profile });
}

test('a narrow declaration no longer narrows the ctx — declarations are advertisements', () => {
  const ctx = ctxFor('g-db');
  const legacy = ctxFor('g-legacy');
  assert.deepEqual(Object.keys(ctx).sort(), Object.keys(legacy).sort(), 'declared and undeclared apps get the same surface');
  for (const k of ['dbQuery', 'ensureSchema', 'telegram', 'email', 'aiPrompt', 'route', 'memory', 'sysmon', 'googleAuth', 'jobs', 'notify', 'files', 'identity', 'capabilities', 'registerTools']) {
    assert.ok(k in ctx, `${k} should be present`);
  }
  // Feature detection reports the platform's surface for the profile.
  assert.ok(ctx.capabilities.has('telegram'));
  assert.ok(ctx.capabilities.has('db'));
  const base = (k) => capabilities.ORDER.indexOf(k.split('.')[0]);
  assert.deepEqual(ctx.capabilities.list(), ctx.capabilities.list().slice().sort((a, b) => base(a) - base(b)), 'registry order, a flag right after its module');
});

test('dashboard equals host: nothing is stripped inside the trust boundary', () => {
  const dash = ctxFor('g-db');
  const host = ctxFor('g-db', 'host');
  assert.deepEqual(Object.keys(dash).sort(), Object.keys(host).sort());
});

test('advertisement matching still resolves aliases and implied capabilities (docs/UI vocabulary)', () => {
  assert.ok(capabilities.declarationSatisfies({ ai: true }, 'maps'));
  assert.ok(capabilities.declarationSatisfies({ cron: true }, 'platform-cron'));
  assert.ok(!capabilities.declarationSatisfies({ db: true }, 'telegram'));
});

test('grants: a revoked revocable module is absent from the ctx and from feature detection; core modules never are', () => {
  const dir = appManager.appDir('g-legacy');
  const revoked = new Set(['email', 'telegram', 'google', 'db', 'settings', 'tools']);
  const ctx = capabilities.buildCtx({ name: 'g-legacy', dir, manifest: {} }, { profile: 'dashboard', revoked });
  for (const k of ['email', 'emailAccounts', 'telegram', 'googleAuth']) assert.ok(!(k in ctx), `revoked: ${k} absent`);
  for (const k of ['dbQuery', 'settings', 'identity', 'registerTools', 'tools', 'whatsapp', 'calendar']) assert.ok(k in ctx, `${k} present`);
  assert.ok(!ctx.capabilities.has('email') && !ctx.capabilities.has('telegram'));
  assert.ok(ctx.capabilities.has('db') && ctx.capabilities.has('whatsapp'));
  assert.equal(ctx.isPublic, undefined, 'the public profile is gone');
  assert.throws(() => capabilities.buildCtx({ name: 'g-legacy', dir, manifest: {} }, { profile: 'public' }), /unknown ctx profile/);
  for (const cap of capabilities.all()) {
    if (cap.revocable) assert.ok(cap.gated || cap.cost === 'metered', `${cap.key}: revocable modules are owner services or metered`);
    else assert.ok(!['email', 'telegram', 'whatsapp', 'calendar', 'google', 'apps', 'governance', 'ai', 'audio', 'maps', 'web-search'].includes(cap.key), `${cap.key} should be revocable`);
  }
});

test('profiles: standalone visibility is kept (own-process perimeter)', () => {
  const standalone = ctxFor('g-legacy', 'standalone');
  assert.ok('telegram' in standalone && 'whatsapp' in standalone);
  for (const k of ['registerTools', 'onToolCall', 'tools', 'email', 'emailAccounts', 'calendar']) assert.ok(!(k in standalone), `standalone: ${k} absent`);
  assert.equal(standalone.isStandalone, true);
  const dir = appManager.appDir('g-legacy');
  const mail = capabilities.buildCtx({ name: 'g-legacy', dir, manifest: { auth: { email: true } } }, { profile: 'standalone' });
  assert.deepEqual(Object.keys(mail.email), ['send']);
});

test('the bridge dispatches undeclared methods; unknown methods still error', async () => {
  // fs was never declared by g-db — open-world: it works anyway.
  assert.equal((await call(appBridge, 'g-db', 'fs.exists', { path: 'nope.txt' })).result, false);
  const unknown = await call(appBridge, 'g-db', 'no.such', {});
  assert.equal(unknown.error, 'Unknown bridge method: no.such');
  const listed = await call(appBridge, 'g-db', 'capabilities.list', {});
  assert.ok(listed.result.capabilities.includes('db'));
  assert.ok(listed.result.capabilities.includes('telegram'), 'the full surface is reported');
  assert.equal(listed.result.legacy, false);
  const legacy = await call(appBridge, 'g-legacy', 'capabilities.list', {});
  assert.equal(legacy.result.legacy, true, 'legacy = advertises nothing (informational only)');
  assert.ok(legacy.result.capabilities.includes('telegram'));
});
