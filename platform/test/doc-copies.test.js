// The platform-doc copies in `<appDir>/.vistaclair/` (api/, api-reference.md,
// apps/) are refreshed outside a launch: at boot and after another app's tools
// change. The refresh may touch ONLY those copies — a running session depends on
// its inlined.json, reads.jsonl and hooks.json — and leaves an unchanged file's
// mtime alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const appManager = require('../src/apps/app-manager');
const appTools = require('../src/apps/app-tools');
const { core } = require('../src/apps/core-services');
const promptBuilder = require('../src/apps/app-builder-prompt');
const docCopies = require('../src/apps/doc-copies');

const tmp = () => fs.mkdtempSync(path.join(process.env.VISTACLAIR_FIXTURE_TMP || os.tmpdir(), 'vc-doccopies-'));

function writeApp(root, name, manifest = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name, description: 'x', ...manifest }, null, 2));
  return dir;
}

const tool = (name) => ({
  name, description: `does ${name}`, expose: 'apps',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
});

// A fake broadcaster with the tap the platform's has.
function fakeBroadcaster() {
  const listeners = new Set();
  return {
    broadcast(msg) { for (const fn of listeners) fn(msg); },
    onBroadcast(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

function platform(t) {
  const root = tmp();
  writeApp(root, 'app-a', { tools: [tool('make_thing')] });
  writeApp(root, 'app-b');
  writeApp(root, 'app-c'); // no .vistaclair/
  fs.mkdirSync(path.join(root, 'app-a', '.vistaclair'));
  fs.mkdirSync(path.join(root, 'app-b', '.vistaclair'));
  const prevDir = appManager.APPS_DIR;
  const prevBroadcaster = core.broadcaster;
  appManager.setAppsDir(root);
  t.after(() => {
    docCopies.reset();
    core.broadcaster = prevBroadcaster;
    appTools.clearAppTools('app-a');
    appManager.setAppsDir(prevDir);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

const SESSION_FILES = { 'reads.jsonl': '{"key":"api/db"}\n', 'inlined.json': '{"keys":["db"]}\n', 'hooks.json': '{"hooks":{}}\n' };

function seedSessionFiles(dir) {
  const old = new Date(Date.now() - 3600e3);
  for (const [f, body] of Object.entries(SESSION_FILES)) {
    const p = path.join(dir, '.vistaclair', f);
    fs.writeFileSync(p, body);
    fs.utimesSync(p, old, old);
  }
  return Object.fromEntries(Object.keys(SESSION_FILES).map((f) => [f, fs.statSync(path.join(dir, '.vistaclair', f)).mtimeMs]));
}

test('refreshDocCopies writes the api and cross-app copies and nothing a running session owns', (t) => {
  const root = platform(t);
  const dir = path.join(root, 'app-b');
  const mtimes = seedSessionFiles(dir);

  const r = promptBuilder.refreshDocCopies(dir, 'app-b');
  const vc = path.join(dir, '.vistaclair');
  assert.ok(fs.existsSync(path.join(vc, 'api-reference.md')));
  assert.ok(fs.existsSync(path.join(vc, 'api', 'tools.md')), 'per-section copies are written');
  assert.match(fs.readFileSync(path.join(vc, 'apps', 'app-a.md'), 'utf-8'), /### `make_thing`/);
  assert.ok(r.files.includes('apps/app-a.md') && r.files.includes('api-reference.md'));
  assert.deepEqual(r.changed.slice().sort(), r.files.slice().sort(), 'a first refresh writes every copy');

  for (const [f, body] of Object.entries(SESSION_FILES)) {
    assert.equal(fs.readFileSync(path.join(vc, f), 'utf-8'), body, `${f} content untouched`);
    assert.equal(fs.statSync(path.join(vc, f)).mtimeMs, mtimes[f], `${f} mtime untouched`);
  }
  for (const f of ['scaffolds.md', 'migration.md', 'appmd-format.md', 'platform-request.md', 'app-request.md']) {
    assert.ok(!fs.existsSync(path.join(vc, f)), `${f} is a launch file, not a doc copy`);
  }
  assert.ok(!fs.existsSync(path.join(dir, '.gitignore')), 'the refresh does not edit the app');

  const stamp = JSON.parse(fs.readFileSync(path.join(vc, 'api', '.generated.json'), 'utf-8'));
  assert.ok(stamp.at && typeof stamp.version === 'string' && 'commit' in stamp);
  assert.deepEqual(stamp.files, r.files);
});

test('an unchanged copy is not rewritten, and a removed section or provider loses its file', (t) => {
  const root = platform(t);
  const dir = path.join(root, 'app-b');
  const vc = path.join(dir, '.vistaclair');
  promptBuilder.refreshDocCopies(dir, 'app-b');

  const old = new Date(Date.now() - 3600e3);
  const watched = ['api-reference.md', 'api/tools.md', 'apps/app-a.md', 'api/.generated.json'].map((f) => path.join(vc, f));
  for (const p of watched) fs.utimesSync(p, old, old);
  const before = watched.map((p) => fs.statSync(p).mtimeMs);

  const r = promptBuilder.refreshDocCopies(dir, 'app-b');
  assert.deepEqual(r.changed, []);
  assert.deepEqual(watched.map((p) => fs.statSync(p).mtimeMs), before, 'no mtime moved, the stamp included');

  fs.writeFileSync(path.join(vc, 'api', 'gone-section.md'), 'old\n');
  fs.writeFileSync(path.join(vc, 'apps', 'gone-app.md'), 'old\n');
  const r2 = promptBuilder.refreshDocCopies(dir, 'app-b');
  assert.deepEqual(r2.changed.sort(), ['api/gone-section.md', 'apps/gone-app.md']);
  assert.ok(!fs.existsSync(path.join(vc, 'api', 'gone-section.md')));
  assert.ok(!fs.existsSync(path.join(vc, 'apps', 'gone-app.md')));
  assert.ok(fs.statSync(path.join(vc, 'api', '.generated.json')).mtimeMs > before[3], 'a change moves the stamp');
});

test('the boot refresh covers apps with a .vistaclair/ and never creates one', (t) => {
  const root = platform(t);
  const log = t.mock.method(console, 'log', () => {});
  const r = docCopies.bootRefresh();
  assert.equal(r.apps, 2);
  assert.ok(r.changed > 0);
  assert.ok(!fs.existsSync(path.join(root, 'app-c', '.vistaclair')), 'an app without copies gets none');
  assert.ok(fs.existsSync(path.join(root, 'app-a', '.vistaclair', 'api-reference.md')));
  assert.ok(fs.existsSync(path.join(root, 'app-b', '.vistaclair', 'apps', 'app-a.md')));
  assert.match(log.mock.calls.at(-1).arguments[0], /doc copies refreshed — 2 app\(s\), \d+ file\(s\) changed/);
});

test('a tools change in app A refreshes B\'s apps/A.md, debounced', async (t) => {
  const root = platform(t);
  t.mock.method(console, 'log', () => {});
  docCopies.bootRefresh();
  const sidecar = path.join(root, 'app-b', '.vistaclair', 'apps', 'app-a.md');
  assert.ok(!fs.readFileSync(sidecar, 'utf-8').includes('make_model'));

  const b = fakeBroadcaster();
  core.broadcaster = b;
  docCopies.init({ broadcaster: b, debounce: 60 });
  appTools.registerAppTools('app-a', [tool('make_thing')]);
  appTools.registerAppTools('app-a', [tool('make_thing'), tool('make_model')]);
  assert.ok(!fs.readFileSync(sidecar, 'utf-8').includes('make_model'), 'the registration itself does not write');

  await new Promise((r) => setTimeout(r, 200));
  assert.match(fs.readFileSync(sidecar, 'utf-8'), /### `make_model`/);
  assert.ok(!fs.existsSync(path.join(root, 'app-c', '.vistaclair')));
});

test('an app install or removal schedules a refresh; a start/stop list broadcast does not', (t) => {
  platform(t);
  const scheduled = [];
  const b = fakeBroadcaster();
  docCopies.init({ broadcaster: b, debounce: 10_000 });
  const real = setTimeout;
  t.mock.method(global, 'setTimeout', (fn, ms) => { scheduled.push(ms); return real(() => {}, 0); });
  const names = appManager.list().map((a) => ({ name: a.name }));
  b.broadcast({ type: 'app:list', apps: names });
  assert.equal(scheduled.length, 0, 'same app set — a start or stop');
  b.broadcast({ type: 'app:list', apps: [...names, { name: 'app-new' }] });
  assert.equal(scheduled.length, 1, 'an install changes the set');
  b.broadcast({ type: 'app:renamed', oldName: 'app-new', newName: 'app-newer' });
  assert.equal(scheduled.length, 2);
});

test('writeSidecars still writes the launch files next to the copies', (t) => {
  const root = platform(t);
  const dir = path.join(root, 'app-b');
  const settings = promptBuilder.writeSidecars(dir, { action: 'extend', appName: 'app-b' });
  const vc = path.join(dir, '.vistaclair');
  assert.equal(settings, path.join(vc, 'hooks.json'));
  for (const f of ['api-reference.md', 'api/tools.md', 'api/.generated.json', 'apps/app-a.md', 'migration.md', 'scaffolds.md', 'inlined.json', 'reads.jsonl']) {
    assert.ok(fs.existsSync(path.join(vc, f)), f);
  }
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8'), /^\.vistaclair\/$/m);
});
