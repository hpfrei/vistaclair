// app-lint rule 17: an event emitted but never declared is an ERROR. The bus
// catalogs it as "discovered" with no description, which tells other apps'
// authors and the Triggers view nothing — a declaration (code or manifest)
// is the fix. Only literal emits are checked; a variable wrapper is fine.
//
// The same manifest block is kept true from three sides: `ctx.events.declare`
// writes it at mount (capabilities/events.js), `capabilities-infer --write`
// fills it from the code, and `--check` reports the difference.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { lint } = require('../src/apps/app-lint');
const { infer, pending, scanEvents, mergeEvents } = require('../src/apps/capabilities-infer');

const dirs = [];
function appDir(files) {
  const dir = fs.mkdtempSync(path.join(process.env.VISTACLAIR_FIXTURE_TMP || os.tmpdir(), 'vc-undeclared-'));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const MANIFEST = JSON.stringify({ name: 'ev-app', description: 'x' });
const undeclared = (dir) => lint(dir).filter((f) => f.rule === 'undeclared-event');

test('emit without declare → one error naming the kind', () => {
  const dir = appDir({
    'manifest.json': MANIFEST,
    'routes.js': [
      'module.exports = (router, ctx) => {',
      "  ctx.events.declare([{ kind: 'order:created', description: 'An order' }]);",
      "  ctx.events.emit('order:created', {});",
      '',
      "  ctx.events.emit('order:shipped', {});",
      '};',
    ].join('\n'),
  });
  const found = undeclared(dir);
  assert.equal(found.length, 1);
  // `error`, not `warn`: app-lint exits 1 on errors only, so a warning prints
  // and passes — which is how every installed manifest ended up eventless.
  assert.equal(found[0].level, 'error');
  assert.equal(found[0].file, 'routes.js');
  assert.equal(found[0].line, 5);
  assert.match(found[0].message, /order:shipped/);
  assert.match(found[0].message, /manifest\.events\.emits/);
});

test('a kind declared in manifest.events.emits (even app-prefixed in code) is known', () => {
  const dir = appDir({
    'manifest.json': JSON.stringify({ name: 'ev-app', events: { emits: { 'order:shipped': { description: 'Shipped' } } } }),
    'routes.js': "module.exports = (router, ctx) => { ctx.events.emit('ev-app:order:shipped', {}); };\n",
  });
  assert.deepEqual(undeclared(dir), []);
});

test('a declaration in lib/ covers an emit in routes.js; a variable emit is never flagged', () => {
  const dir = appDir({
    'manifest.json': MANIFEST,
    'lib/events.js': "module.exports = (ctx) => ctx.events.declare([{ kind: 'nudge:sent', description: 'A nudge' }]);\n",
    'routes.js': [
      "module.exports = (router, ctx) => { require('./lib/events')(ctx); ctx.events.emit('nudge:sent', {});",
      '  const k = pick(); ctx.events.emit(k, {}); };',
    ].join('\n'),
  });
  assert.deepEqual(undeclared(dir), []);
});

test('scanEvents derives the manifest events block; mergeEvents keeps what the manifest says', () => {
  const dir = appDir({
    'manifest.json': MANIFEST,
    'routes.js': [
      "module.exports = (router, ctx) => {",
      "  ctx.events.declare([{ kind: 'a:done', description: 'A finished' }]);",
      "  ctx.events.emit('b:done', {});",
      "  ctx.events.subscribe(['other-app:*', '*:crashloop'], () => {});",
      '};',
    ].join('\n'),
    'public/app.js': "Bridge.bus('third:thing', (e) => {});\n",
  });
  const ev = scanEvents(dir);
  assert.deepEqual(ev, {
    emits: { 'a:done': { description: 'A finished' }, 'b:done': { description: '' } },
    listens: ['*:crashloop', 'other-app:*', 'third:thing'],
  });
  const merged = mergeEvents({ emits: { 'b:done': { description: 'Hand-written', schema: { x: 1 } } }, listens: ['kept:*'] }, ev);
  assert.deepEqual(merged, {
    emits: { 'b:done': { description: 'Hand-written', schema: { x: 1 } }, 'a:done': { description: 'A finished' } },
    listens: ['*:crashloop', 'kept:*', 'other-app:*', 'third:thing'],
  });
  assert.equal(mergeEvents(null, { emits: {}, listens: [] }), null, 'empty → no block');
});

test('--check reports what --write would apply, and nothing once it has', () => {
  const dir = appDir({
    'manifest.json': MANIFEST,
    'routes.js': [
      'module.exports = (router, ctx) => {',
      "  ctx.events.declare([{ kind: 'a:done', description: 'A finished' }]);",
      "  ctx.dbQuery('select 1');",
      '};',
    ].join('\n'),
  });
  const before = pending(infer(dir));
  assert.equal(before.changed, true);
  assert.ok(before.lines.includes('+ capabilities.db'), before.lines.join(' | '));
  assert.ok(before.lines.includes('+ events.emits["a:done"]'), before.lines.join(' | '));

  require('../src/apps/capabilities-infer').writeManifest(infer(dir));
  const after = pending(infer(dir));
  assert.equal(after.changed, false, '--check is clean right after --write');
  assert.deepEqual(after.lines, []);
});

test('rule 18: a capability the code uses but the manifest never advertises is a warning', () => {
  const dir = appDir({
    'manifest.json': MANIFEST,
    'routes.js': "module.exports = (router, ctx) => { ctx.dbQuery('select 1'); };\n",
  });
  const stale = lint(dir).filter((f) => f.rule === 'stale-capabilities');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].level, 'warn');
  assert.match(stale[0].message, /\bdb\b/);
  assert.match(stale[0].message, /capabilities-infer\.js \. --write/);

  const declared = appDir({
    'manifest.json': JSON.stringify({ name: 'ev-app', capabilities: { db: true } }),
    'routes.js': "module.exports = (router, ctx) => { ctx.dbQuery('select 1'); };\n",
  });
  assert.deepEqual(lint(declared).filter((f) => f.rule === 'stale-capabilities'), []);
});

// `<appDir>/workspaces/` holds cli.workspace folders — model-written material,
// not the app's code. Neither lint nor infer reads it, even through a require;
// a folder of that name deeper in the tree is still code.
test('workspaces/ at the app root is never linted or inferred', () => {
  const EMIT = "module.exports = (ctx) => { ctx.events.emit('ws:rendered', {}); ctx.dbQuery('select 1'); };\n";
  const dir = appDir({
    'manifest.json': MANIFEST,
    'routes.js': "module.exports = (router, ctx) => { require('./workspaces/scene/hook')(ctx); };\n",
    'workspaces/scene/hook.js': EMIT,
    'workspaces/scene/lib/render.js': EMIT,
  });
  assert.deepEqual(undeclared(dir), []);
  assert.deepEqual(lint(dir).filter((f) => f.file && f.file.startsWith('workspaces/')), []);
  const result = infer(dir);
  assert.equal(result.used.has('db'), false);
  assert.deepEqual(scanEvents(dir).emits, {});

  const nested = appDir({ 'manifest.json': MANIFEST, 'lib/workspaces/emit.js': EMIT, 'routes.js': 'module.exports = () => {};\n' });
  assert.equal(undeclared(nested).length, 1);
  assert.equal(infer(nested).used.has('db'), true);
});

// The mount-time half of the deal: a declare writes the kinds into the
// manifest itself, so nothing downstream depends on a session having run the
// infer script. Own-process apps are skipped — no manifest writer there.
test('ctx.events.declare records the namespaced kinds in manifest.events.emits', () => {
  const bus = require('../src/apps/agent/horst-events');
  const appManager = require('../src/apps/app-manager');
  const capabilities = require('../src/apps/capabilities');
  const { makeAppsDir } = require('./helpers');

  const busDir = fs.mkdtempSync(path.join(process.env.VISTACLAIR_FIXTURE_TMP || os.tmpdir(), 'vc-bus-'));
  dirs.push(busDir);
  bus._resetForTests();
  bus.init({ dir: busDir, broadcaster: { broadcast() {} }, ruleActions: {}, onSubscriberError() {} });

  // `bare` is how capabilities-infer --write spells a kind; the merge must
  // recognise it rather than add a second entry under the namespaced form.
  const appsDir = makeAppsDir({
    'ev-app': { events: { emits: { 'ev-app:kept': { description: 'Hand-written' }, bare: { description: 'From infer' } } } },
    'own-app': {},
  });
  dirs.push(appsDir);
  appManager.setAppsDir(appsDir);
  const app = (name) => ({ name, dir: path.join(appsDir, name), manifest: appManager.readManifest(name), broadcaster: null });

  const ctx = capabilities.buildCtx(app('ev-app'), { profile: 'dashboard' });
  ctx.events.declare([
    { kind: 'order:created', description: 'An order was placed' },
    { kind: 'ev-app:order:shipped' },
    { kind: 'bare', description: 'From infer' },
  ]);
  const written = appManager.readManifest('ev-app').events;
  assert.deepEqual(written.emits, {
    'ev-app:kept': { description: 'Hand-written' },
    bare: { description: 'From infer' },
    'ev-app:order:created': { description: 'An order was placed' },
    'ev-app:order:shipped': { description: '' },
  }, 'a new kind lands app-namespaced; an existing one keeps its spelling');

  // Second identical declare: no churn in the app's git.
  const before = fs.statSync(path.join(appsDir, 'ev-app', 'manifest.json')).mtimeMs;
  ctx.events.declare([{ kind: 'order:created', description: 'An order was placed' }]);
  assert.equal(fs.statSync(path.join(appsDir, 'ev-app', 'manifest.json')).mtimeMs, before, 'an unchanged merge must not rewrite the manifest');

  const own = capabilities.buildCtx(app('own-app'), { profile: 'standalone' });
  own.events.declare([{ kind: 'nope', description: 'x' }]);
  assert.equal(appManager.readManifest('own-app').events, undefined, 'own-process apps have no manifest writer');
  assert.ok(bus.catalog().declared['own-app']['own-app:nope'], 'but the bus catalog still has the kind');
});
