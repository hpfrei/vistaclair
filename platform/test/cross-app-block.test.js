// What a session learns about the OTHER apps. The prompt carries one line per
// provider; `.vistaclair/apps/<app>.md` carries the detail, and both are built
// from the freshest source there is — the live tool registry and the bus
// catalog, with the manifest as the fallback for an app that is not mounted.
//
// The third claim here is `returns`: a tool says what comes back, not only what
// goes in. It has to survive the registration that drops every unknown field
// (`registerAppTools`), reach the manifest, and be visible to a caller that
// cannot read the providing app's code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const appManager = require('../src/apps/app-manager');
const appTools = require('../src/apps/app-tools');
const horstEvents = require('../src/apps/agent/horst-events');
const promptBuilder = require('../src/apps/app-builder-prompt');
const { lint } = require('../src/apps/app-lint');

const tmp = () => fs.mkdtempSync(path.join(process.env.VISTACLAIR_FIXTURE_TMP || os.tmpdir(), 'vc-xapp-'));

function writeApp(root, name, manifest) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name, description: 'x', ...manifest }, null, 2));
  return dir;
}

const tool = (name, over = {}) => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'the query' }, limit: { type: 'number' } }, required: ['q'] },
  expose: 'apps',
  ...over,
});

// A platform with two providers whose facts come from DIFFERENT places:
// pixachat is mounted, so its tools are read off the live registry (including
// one the manifest has never seen); vidat is a stopped own-process app, so its
// kinds can only come from the catalog/manifest. Plus the two apps that must
// NOT appear: an independent one and one that offers nothing.
function platform(t) {
  const root = tmp();
  writeApp(root, 'fx-caller', {});
  writeApp(root, 'pixachat', { tools: [tool('stale_from_manifest')] });
  writeApp(root, 'vidat', {
    runtime: 'own-process',
    events: { emits: { 'client:connected': { description: 'the phone client connected' }, 'client:lost': { description: 'it stopped sending' } } },
  });
  writeApp(root, 'minecraft-server', { events: { emits: ['assistant:change'] } });
  writeApp(root, 'solo', { platformContribution: false, tools: [tool('secret')], events: { emits: ['thing:done'] } });
  writeApp(root, 'quiet', { tools: [tool('own_only', { expose: 'self' })] });

  appManager.setAppsDir(root);
  // Mounted: pixachat registered two tools this boot, one of which the manifest
  // does not know about yet. Nothing else is in the registry.
  appTools.registerAppTools('pixachat', [
    tool('send_message', { returns: '{ id, at } — the stored message id and its ISO timestamp' }),
    tool('live_only'),
  ]);
  // The bus catalog outranks the manifest: minecraft-server declared a second
  // kind since its manifest was last written.
  const realCatalog = horstEvents.catalog;
  horstEvents.catalog = () => ({
    declared: {
      'minecraft-server': {
        'minecraft-server:assistant:change': { description: 'the game was changed' },
        'minecraft-server:assistant:rollback': { description: 'a change was undone' },
      },
    },
  });
  // `running` is the one fact only a live mount carries.
  const realList = appManager.list;
  appManager.list = () => realList.call(appManager).map((a) => (a.name === 'pixachat' ? { ...a, running: true } : a));

  t.after(() => {
    horstEvents.catalog = realCatalog;
    appManager.list = realList;
    appTools.clearAppTools('pixachat');
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

const providersByName = (appName) =>
  Object.fromEntries(promptBuilder.crossAppProviders(appName).map((p) => [p.name, p]));

// ---- the sources -------------------------------------------------------------

test('a mounted app is read from the registry, a stopped one from its manifest', (t) => {
  platform(t);
  const p = providersByName('fx-caller');

  assert.deepEqual(p.pixachat.tools.map((x) => x.name), ['live_only', 'send_message'],
    'the live registry wins over the manifest — it is the fresher answer');
  assert.equal(p.pixachat.running, true);
  assert.equal(p.vidat.running, false);
  assert.deepEqual(p.vidat.events.map((e) => e.kind), ['vidat:client:connected', 'vidat:client:lost'],
    'a stopped app still shows its kinds, namespaced as the bus delivers them');
});

test('the bus catalog outranks the manifest for events', (t) => {
  platform(t);
  const p = providersByName('fx-caller');
  assert.deepEqual(p['minecraft-server'].events.map((e) => e.kind),
    ['minecraft-server:assistant:change', 'minecraft-server:assistant:rollback']);
  assert.equal(p['minecraft-server'].events[0].description, 'the game was changed');
});

test('an independent app, an app with nothing to offer, and self are not providers', (t) => {
  platform(t);
  assert.deepEqual(Object.keys(providersByName('fx-caller')).sort(),
    ['minecraft-server', 'pixachat', 'vidat']);
  assert.ok(!providersByName('pixachat').pixachat, 'an app is never its own provider');
});

// ---- the inline block --------------------------------------------------------

test('the block is one line per provider, and names what cannot be called', (t) => {
  platform(t);
  const block = promptBuilder.buildCrossAppTools('fx-caller').split('### Platform Duty Rules')[0];

  assert.match(block, /- \*\*pixachat\*\* \(in-process, running\) — 2 tools, 0 event kinds — `\.vistaclair\/apps\/pixachat\.md`\n/);
  assert.match(block, /- \*\*vidat\*\* \(own-process, stopped\) — 0 tools, 2 event kinds — `\.vistaclair\/apps\/vidat\.md` — not callable via `ctx\.tools\.call`; subscribe on the bus/);
  assert.ok(!/not callable/.test(block.split('vidat')[0]), 'an in-process provider is not marked uncallable');
  assert.ok(!block.includes('solo'), 'an independent app is invisible');

  // The detail is deferred with the one pointer wording every prompt uses.
  assert.match(block, /> Deferred to keep this prompt small — read `\.vistaclair\/apps\/<app>\.md`/);
  // And the standing guidance is untouched.
  assert.match(block, /await ctx\.tools\.call\(appName, toolName, args\)/);
  assert.match(promptBuilder.buildCrossAppTools('fx-caller'), /Platform Duty Rules/);
});

test('with no provider the block says so and defers nothing', (t) => {
  const root = tmp();
  writeApp(root, 'fx-caller', {});
  appManager.setAppsDir(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const block = promptBuilder.buildCrossAppTools('fx-caller');
  assert.match(block, /No other app currently exposes a tool or declares an event kind\./);
  assert.ok(!block.includes('.vistaclair/apps/'));
});

// ---- the sidecars ------------------------------------------------------------

test('writeSidecars writes one file per provider, and nothing for a non-provider', (t) => {
  const root = platform(t);
  const dir = path.join(root, 'fx-caller');
  promptBuilder.writeSidecars(dir, { action: 'extend', appName: 'fx-caller', userRequest: 'talk to pixachat' });
  assert.deepEqual(fs.readdirSync(path.join(dir, '.vistaclair', 'apps')).sort(),
    ['minecraft-server.md', 'pixachat.md', 'vidat.md']);

  const pixa = fs.readFileSync(path.join(dir, '.vistaclair', 'apps', 'pixachat.md'), 'utf-8');
  assert.match(pixa, /Runtime \*\*in-process\*\*, currently \*\*running\*\*/);
  assert.match(pixa, /await ctx\.tools\.call\('pixachat', '<tool>', args\)/);
  assert.match(pixa, /### `send_message`/);
  assert.match(pixa, /- `q` \(string, \*\*required\*\*\) — the query/);
  assert.match(pixa, /- `limit` \(number\)/);
  assert.ok(!/- `limit` \(number, \*\*required\*\*\)/.test(pixa), 'an optional parameter must not read as required');
  assert.match(pixa, /Returns: \{ id, at \} — the stored message id and its ISO timestamp/);
  assert.match(pixa, /Returns: not documented by that app/, 'a tool without `returns` says so rather than staying silent');
  assert.ok(!pixa.includes('stale_from_manifest'), 'the sidecar shows the live registry, not the stale manifest');

  const vidat = fs.readFileSync(path.join(dir, '.vistaclair', 'apps', 'vidat.md'), 'utf-8');
  assert.match(vidat, /`ctx\.tools\.call` is in-process and CANNOT reach this app/);
  assert.match(vidat, /vidat exposes no tool to other apps\./);
  assert.match(vidat, /ctx\.events\.subscribe\(\['vidat:client:connected'\], handler\)/);
  assert.match(vidat, /- `vidat:client:lost` — it stopped sending/);
});

test('a provider that stopped being one loses its sidecar at the next launch', (t) => {
  const root = platform(t);
  const dir = path.join(root, 'fx-caller');
  const stale = path.join(dir, '.vistaclair', 'apps', 'gone.md');
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, '# gone\n');

  promptBuilder.writeSidecars(dir, { action: 'extend', appName: 'fx-caller' });
  assert.ok(!fs.existsSync(stale), 'a sidecar app-lint would demand a read of must not outlive its provider');
});

// ---- `returns` ---------------------------------------------------------------

test('a tool registered with `returns` keeps it through the registry and the manifest', (t) => {
  const root = tmp();
  writeApp(root, 'fx-provider', {});
  appManager.setAppsDir(root);
  t.after(() => { appTools.clearAppTools('fx-provider'); fs.rmSync(root, { recursive: true, force: true }); });

  appTools.registerAppTools('fx-provider', [
    tool('lookup', { returns: '{ rows: [{ id, name }], total }' }),
    tool('plain'),
  ]);

  const live = appTools.getToolsForApp('fx-provider');
  assert.equal(live.find((x) => x.name === 'lookup').returns, '{ rows: [{ id, name }], total }');
  assert.equal(live.find((x) => x.name === 'plain').returns, '', 'an omitted `returns` is empty, never undefined');

  const manifest = appManager.readManifest('fx-provider');
  assert.equal(manifest.tools.find((x) => x.name === 'lookup').returns, '{ rows: [{ id, name }], total }');
});

test('a prose `returns` is capped, a schema is kept, anything else is dropped', (t) => {
  const root = tmp();
  writeApp(root, 'fx-provider', {});
  appManager.setAppsDir(root);
  t.after(() => { appTools.clearAppTools('fx-provider'); fs.rmSync(root, { recursive: true, force: true }); });

  appTools.registerAppTools('fx-provider', [
    tool('long', { returns: '  ' + 'x'.repeat(400) + '  ' }),
    tool('schema', { returns: { type: 'object' } }),
    tool('wrong', { returns: 42 }),
    tool('list', { returns: ['a'] }),
  ]);
  const live = appTools.getToolsForApp('fx-provider');
  assert.equal(live.find((x) => x.name === 'long').returns.length, 300);
  assert.deepEqual(live.find((x) => x.name === 'schema').returns, { type: 'object' });
  assert.equal(live.find((x) => x.name === 'wrong').returns, '');
  assert.equal(live.find((x) => x.name === 'list').returns, '');
});

// ---- app-lint rule 14 --------------------------------------------------------

const lintApp = (t, routes) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = writeApp(root, 'fx-lint', {});
  fs.writeFileSync(path.join(dir, 'routes.js'), routes);
  return lint(dir).filter((f) => f.rule === 'tool-returns');
};

const TOOL_SRC = (extra) => [
  'module.exports = (router, ctx) => {',
  '  ctx.registerTools([',
  '    {',
  "      name: 'get_data',",
  "      description: 'Retrieve records',",
  '      inputSchema: {',
  "        type: 'object',",
  "        properties: { query: { type: 'string' } },",
  "        required: ['query'],",
  '      },',
  extra,
  '    },',
  '  ]);',
  '};',
].join('\n');

test('a tool exposed beyond this app without `returns` is a warning', (t) => {
  const found = lintApp(t, TOOL_SRC("      expose: 'apps',"));
  assert.equal(found.length, 1);
  assert.equal(found[0].level, 'warn');
  assert.match(found[0].message, /get_data/);
  assert.match(found[0].message, /`returns`/);
});

test('every tool in a long registerTools block is checked, not just the first few', (t) => {
  // A real app registers a dozen tools in one array, which is far longer than
  // any fixed lookback window — the block is tracked by its call and its `]);`.
  const defs = Array.from({ length: 12 }, (_, i) => [
    '    {',
    `      name: 'tool_${i}',`,
    `      description: 'tool ${i}',`,
    "      inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } } },",
    "      expose: 'apps',",
    '    },',
  ].join('\n')).join('\n');
  const found = lintApp(t, `module.exports = (router, ctx) => {\n  ctx.registerTools([\n${defs}\n  ]);\n};\n`);
  assert.deepEqual(found.map((x) => x.message.match(/tool "(\w+)"/)[1]),
    Array.from({ length: 12 }, (_, i) => `tool_${i}`));
});

test('a tool-shaped object outside a registerTools block is not a tool', (t) => {
  assert.deepEqual(lintApp(t, [
    'module.exports = (router, ctx) => {',
    '  ctx.registerTools([',
    "    { name: 'real', description: 'd', returns: '{ ok }', expose: 'apps' },",
    '  ]);',
    "  const row = { name: 'not_a_tool', expose: 'apps' };",
    '  router.get("/x", (q, r) => r.json(row));',
    '};',
  ].join('\n')), []);
});

test('the same tool with `returns` is clean, and a self tool is never asked', (t) => {
  assert.deepEqual(lintApp(t, TOOL_SRC("      returns: '{ rows, total }',\n      expose: 'platform',")), []);
  assert.deepEqual(lintApp(t, TOOL_SRC("      returns: '{ rows, total }',\n      expose: 'apps',")), []);
  assert.deepEqual(lintApp(t, TOOL_SRC("      expose: 'self',")), []);
  assert.deepEqual(lintApp(t, TOOL_SRC('      timeout: 1000,')), [], 'the default expose is self');
});
