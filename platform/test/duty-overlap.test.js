// One duty, one implementation — the rule that keeps the three actors apart.
//
// Phase 8 removed the second copy of every duty my-dashboard was carrying: its
// own governance kinds for acts the platform governs, its own tools handed to
// Horst's sessions. Nothing stopped the next app from re-adding them, because
// `registerKind` namespaces an app kind to '<app>:<kind>' — the collision is
// invisible at runtime, and only the literal in the call gives it away.
//
// So there are two guards, and this file holds both to the same claim. app-lint
// rule 16 reads the source before anything runs; getPlatformToolUnion's de-dup
// protects a system where two apps are already live. `lint:app` is not part of
// `npm test` (the build prompts invoke it), which is why the overlap check runs
// here rather than only there.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { lint, dutyOverlaps } = require('../src/apps/app-lint');
const capabilities = require('../src/apps/capabilities');

const dirs = [];
function appDir(files) {
  const dir = fs.mkdtempSync(path.join(process.env.VISTACLAIR_FIXTURE_TMP || os.tmpdir(), 'vc-duty-'));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const MANIFEST = JSON.stringify({ name: 'dup-app', description: 'x' });
const overlaps = (dir) => lint(dir).filter((f) => f.rule === 'duplicate-duty');

test('an app kind for an act the platform already governs is an error', () => {
  const dir = appDir({
    'manifest.json': MANIFEST,
    'routes.js': [
      'module.exports = (router, ctx) => {',
      "  ctx.governance.registerKind('email_send', {",
      "    label: 'Send mail', validate() {}, describe: () => 'send', execute: () => ({ ok: true }),",
      '  });',
      '};',
    ].join('\n'),
  });

  const found = overlaps(dir);
  assert.equal(found.length, 1);
  // `error`, not `warn`: lint exits 1 on errors only, so a warning would print
  // and pass — which is how this drifted the first time.
  assert.equal(found[0].level, 'error');
  assert.equal(found[0].file, 'routes.js');
  assert.match(found[0].message, /email\.send/, 'the message must name the platform kind to use instead');
});

test('a platform-exposed tool the platform already provides is an error', () => {
  const [firstTool] = capabilities.horstTools();
  assert.ok(firstTool, 'the platform must provide at least one read-only tool');

  const dir = appDir({
    'manifest.json': MANIFEST,
    'routes.js': [
      'module.exports = (router, ctx) => {',
      '  ctx.registerTools([{',
      `    name: '${firstTool.def.name}',`,
      "    description: 'Mine, actually',",
      '    inputSchema: { type: \'object\', properties: {} },',
      "    expose: 'platform',",
      '  }]);',
      '};',
    ].join('\n'),
  });

  const found = overlaps(dir);
  assert.equal(found.length, 1);
  assert.equal(found[0].level, 'error');
  assert.match(found[0].message, new RegExp(firstTool.def.name));
});

test('the same tool kept to itself is the app’s own business', () => {
  const [firstTool] = capabilities.horstTools();
  const dir = appDir({
    'manifest.json': MANIFEST,
    'routes.js': [
      'module.exports = (router, ctx) => {',
      `  ctx.registerTools([{ name: '${firstTool.def.name}', description: 'd', expose: 'self' }]);`,
      "  ctx.governance.registerKind('invoice_chase', { label: 'x', validate() {}, describe: () => 'x', execute: () => ({}) });",
      '};',
    ].join('\n'),
  });
  assert.deepEqual(overlaps(dir), []);
});

// The apps that actually ship. This is the check `lint:app` would make if it
// ran in CI; here it runs on every `npm test`.
test('no installed app duplicates a platform duty', () => {
  // Resolved the way app-manager defaults it, not through app-manager itself:
  // the runtime test below repoints that at a throwaway dir.
  const appsRoot = path.join(__dirname, '..', '..', 'vistaclair-apps');
  let names = [];
  try {
    names = fs.readdirSync(appsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .filter((e) => fs.existsSync(path.join(appsRoot, e.name, 'manifest.json')))
      .map((e) => e.name);
  } catch { /* no apps dir on this box — nothing to check */ }

  for (const name of names) {
    const found = dutyOverlaps(path.join(appsRoot, name));
    assert.deepEqual(found.map((f) => `${name}/${f.file}:${f.line} ${f.message}`), [], `${name} duplicates a platform duty`);
  }
});

// --- the runtime half ---------------------------------------------------------

test('an app tool named after a platform tool is refused from the union, out loud', () => {
  const appTools = require('../src/apps/app-tools');
  const manager = require('../src/apps/app-manager');
  const { makeAppsDir } = require('./helpers');
  manager.setAppsDir(makeAppsDir({ 'app-one': {}, 'app-two': {} }));

  const def = (name) => ({ name, description: 'd', inputSchema: { type: 'object', properties: {} }, expose: 'platform' });
  const platformTool = capabilities.horstTools()[0].def.name;
  appTools.registerAppTools('__platform__', [def(platformTool)]);
  appTools.registerAppTools('app-one', [def(platformTool), def('own_tool')]);
  // Two ordinary apps may share a name: every consumer namespaces the union by
  // owner, so both route correctly. Only the platform's own duty is protected.
  appTools.registerAppTools('app-one', [def('server_status')]);
  appTools.registerAppTools('app-two', [def('server_status')]);

  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  let union;
  try { union = appTools.getPlatformToolUnion(); } finally { console.warn = orig; }

  const dup = union.filter((t) => t.name === platformTool);
  assert.equal(dup.length, 1, 'the app must not put a second implementation beside the platform tool');
  assert.equal(dup[0]._ownerApp, '__platform__', 'first registration wins, and the platform pack boots first');
  assert.ok(union.some((t) => t.name === 'own_tool' && t._ownerApp === 'app-one'),
    'the refused name must not cost the app its other tools');
  assert.deepEqual(union.filter((t) => t.name === 'server_status').map((t) => t._ownerApp).sort(),
    ['app-one', 'app-two'], 'two apps sharing a name is not a platform-duty collision');

  assert.equal(warned.length, 1, 'a refusal is logged, never silent');
  assert.match(warned[0], new RegExp(platformTool));
  assert.match(warned[0], /app-one/);

  appTools.clearAppTools('__platform__');
  appTools.clearAppTools('app-one');
  appTools.clearAppTools('app-two');
});
