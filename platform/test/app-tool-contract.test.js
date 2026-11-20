// The app-tool contract: the optional fields a tool declares beyond its
// inputSchema (sideEffects, a schema `returns`, artifacts, examples, version),
// the contractHash that tracks what a caller depends on, compareContracts (the
// change-request rule step 5's dependency registry reuses), the
// app:tools:contractChanged broadcast, the structuredContent check, the broker
// catalog fields and app-lint's contract and drift rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeAppsDir, silenceWarn } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const appTools = require('../src/apps/app-tools');
const broker = require('../src/apps/mcp-broker');
const { core } = require('../src/apps/core-services');
const { lint } = require('../src/apps/app-lint');

const appsDir = makeAppsDir({ 'ct-app': {}, 'ct-other': {} });
appManager.setAppsDir(appsDir);
const brokerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-contract-'));
broker.init({ dir: path.join(brokerDir, 'broker') });
const broadcasts = [];
const savedBroadcaster = core.broadcaster;
core.broadcaster = { broadcast: (m) => broadcasts.push(m) };
test.after(() => {
  core.broadcaster = savedBroadcaster;
  appTools.clearAppTools('ct-app');
  appTools.clearAppTools('ct-other');
  fs.rmSync(appsDir, { recursive: true, force: true });
  fs.rmSync(brokerDir, { recursive: true, force: true });
});

const SEARCH = {
  type: 'object',
  properties: { q: { type: 'string' }, limit: { type: 'integer' }, mode: { type: 'string', enum: ['fast', 'full'] } },
  required: ['q'],
};
const RESULT = { type: 'object', properties: { items: { type: 'array' }, total: { type: 'integer' } }, required: ['items'] };
const def = (over = {}) => ({ name: 'find', description: 'Find things.', inputSchema: SEARCH, expose: 'platform', ...over });
const register = (defs, app = 'ct-app') => silenceWarn(() => appTools.registerAppTools(app, defs));
const live = (name, app = 'ct-app') => appTools.getToolsForApp(app).find((t) => t.name === name);

// ---- fields and defaults ------------------------------------------------------

test('no new field is required: an old-style tool registers with sideEffects writes and a hash', async () => {
  await register([{ name: 'legacy', description: 'x', expose: 'self' }]);
  const t = live('legacy');
  assert.equal(t.sideEffects, 'writes');
  assert.equal(t.returns, '');
  assert.match(t.contractHash, /^[0-9a-f]{64}$/);
  for (const k of ['artifacts', 'examples', 'version']) assert.equal(k in t, false, `${k} absent when not declared`);
  const m = appManager.readManifest('ct-app').tools.find((x) => x.name === 'legacy');
  assert.equal(m.sideEffects, 'writes');
  assert.equal(m.contractHash, t.contractHash);
});

test('the full contract is kept; malformed optional fields are warned and dropped', async () => {
  const { warnings } = await register([def({
    name: 'full',
    sideEffects: 'none',
    returns: RESULT,
    artifacts: { accepts: ['image/*', 'Image/PNG', 'not a mime'], produces: ['model/gltf-binary'] },
    examples: [{ args: { q: 'red' }, note: 'simplest' }, { args: { q: 1 } }, { nope: true }, { args: { q: 'x' } }],
    version: ' 2.1 ',
  })]);
  const t = live('full');
  assert.equal(t.sideEffects, 'none');
  assert.deepEqual(t.returns, RESULT);
  assert.deepEqual(t.artifacts, { accepts: ['image/*', 'image/png'], produces: ['model/gltf-binary'] });
  assert.deepEqual(t.examples, [{ args: { q: 'red' }, note: 'simplest' }, { args: { q: 1 } }], 'at most 3 considered, the arg-less one dropped');
  assert.equal(t.version, '2.1');
  assert.ok(warnings.some((w) => /4 examples, only the first 3/.test(w)));
  assert.ok(warnings.some((w) => /example 2 does not fit inputSchema: "q" should be string, got integer/.test(w)));
  assert.ok(warnings.some((w) => /example 3 has no args object/.test(w)));
  assert.ok(warnings.some((w) => /artifacts\.accepts: dropped/.test(w)));

  const { warnings: w2 } = await register([def({ name: 'bad', artifacts: 'image/png', examples: 'x', version: 3 })]);
  const b = live('bad');
  for (const k of ['artifacts', 'examples', 'version']) assert.equal(k in b, false);
  assert.equal(w2.length, 3);
});

test('an invalid sideEffects is refused like an invalid expose', () => {
  assert.throws(() => appTools.registerAppTools('ct-app', [def({ name: 'x', sideEffects: 'reads' })]), /invalid sideEffects "reads"/);
});

// ---- contractHash -------------------------------------------------------------

test('contractHash is stable across key order and ignores _wait, description, expose and examples', () => {
  const a = { inputSchema: { type: 'object', properties: { q: { type: 'string' }, n: { type: 'integer' } }, required: ['q', 'n'] }, returns: RESULT, kind: 'job', sideEffects: 'none' };
  const b = {
    sideEffects: 'none', kind: 'job', description: 'other words', expose: 'apps', examples: [{ args: { q: 'a', n: 1 } }],
    returns: { required: ['items'], properties: { total: { type: 'integer' }, items: { type: 'array' } }, type: 'object' },
    inputSchema: { required: ['n', 'q', '_wait'], properties: { _wait: { type: 'integer' }, n: { type: 'integer' }, q: { type: 'string' } }, type: 'object' },
  };
  assert.equal(appTools.contractHash(a), appTools.contractHash(b));
  assert.equal(appTools.contractHash(appTools.callerView({ name: 't', ...a })), appTools.contractHash(a), 'the caller view of a job tool hashes the same');
  assert.notEqual(appTools.contractHash(a), appTools.contractHash({ ...a, sideEffects: 'writes' }));
  assert.notEqual(appTools.contractHash(a), appTools.contractHash({ ...a, kind: 'call' }));
  assert.notEqual(appTools.contractHash(a), appTools.contractHash({ ...a, returns: 'prose' }));
  assert.equal(appTools.contractHash({}), appTools.contractHash({ kind: 'call', sideEffects: 'writes', inputSchema: { type: 'object', properties: {} } }), 'defaults hash as declared defaults');
});

// ---- compareContracts ---------------------------------------------------------

test('compareContracts: added optional input or result properties are compatible', () => {
  const before = { inputSchema: SEARCH, returns: RESULT };
  const after = {
    inputSchema: { ...SEARCH, properties: { ...SEARCH.properties, cursor: { type: 'string' } } },
    returns: { ...RESULT, properties: { ...RESULT.properties, next: { type: 'string' } } },
  };
  assert.deepEqual(appTools.compareContracts(before, after), { compatible: true, problems: [] });
  assert.equal(appTools.compareContracts({ inputSchema: SEARCH, returns: 'old words' }, { inputSchema: SEARCH, returns: 'new words' }).compatible, true, 'reworded prose is not a break');
  assert.equal(appTools.compareContracts({ inputSchema: SEARCH, sideEffects: 'external' }, { inputSchema: SEARCH, sideEffects: 'none' }).compatible, true, 'fewer side effects is not a break');
  const widened = { ...SEARCH, properties: { ...SEARCH.properties, limit: { type: ['integer', 'string'] } } };
  assert.equal(appTools.compareContracts({ inputSchema: SEARCH }, { inputSchema: widened }).compatible, true, 'a widened type is not a break');
});

test('compareContracts: removed, renamed, newly required, retyped, narrowed are incompatible', () => {
  const props = SEARCH.properties;
  const cases = [
    [{ ...SEARCH, properties: { q: props.q, mode: props.mode } }, /input "limit" was removed/],
    [{ ...SEARCH, properties: { q: props.q, max: props.limit, mode: props.mode } }, /input "limit" was removed/],
    [{ ...SEARCH, required: ['q', 'limit'] }, /input "limit" became required/],
    [{ ...SEARCH, properties: { ...props, limit: { type: 'string' } } }, /input "limit" has a narrower type/],
    [{ ...SEARCH, properties: { ...props, mode: { type: 'string', enum: ['fast'] } } }, /input "mode" has a narrower enum/],
  ];
  for (const [inputSchema, re] of cases) {
    const r = appTools.compareContracts({ inputSchema: SEARCH }, { inputSchema });
    assert.equal(r.compatible, false, String(re));
    assert.match(r.problems.join('; '), re);
  }
  const res = (after) => appTools.compareContracts({ inputSchema: SEARCH, returns: RESULT }, { inputSchema: SEARCH, returns: after });
  assert.match(res({ ...RESULT, properties: { items: RESULT.properties.items } }).problems.join(), /result "total" was removed/);
  assert.match(res({ ...RESULT, properties: { ...RESULT.properties, total: { type: 'string' } } }).problems.join(), /result "total" changed type/);
  assert.match(res('now prose').problems.join(), /result schema was dropped/);
  assert.match(appTools.compareContracts({ kind: 'call' }, { kind: 'job' }).problems.join(), /kind changed/);
  assert.match(appTools.compareContracts({ sideEffects: 'none' }, { sideEffects: 'external' }).problems.join(), /sideEffects escalated/);
});

// ---- app:tools:contractChanged -----------------------------------------------

test('re-registration with a changed contract broadcasts contractChanged; an unchanged one does not', async () => {
  await register([def({ name: 'evolve', returns: RESULT })], 'ct-other');
  const first = live('evolve', 'ct-other').contractHash;
  broadcasts.length = 0;
  await register([def({ name: 'evolve', returns: RESULT, description: 'reworded' })], 'ct-other');
  assert.deepEqual(broadcasts.filter((b) => b.type === 'app:tools:contractChanged'), [], 'a description is not the contract');

  const added = { ...SEARCH, properties: { ...SEARCH.properties, cursor: { type: 'string' } } };
  await register([def({ name: 'evolve', returns: RESULT, inputSchema: added })], 'ct-other');
  const ok = broadcasts.filter((b) => b.type === 'app:tools:contractChanged');
  assert.equal(ok.length, 1);
  assert.deepEqual({ ...ok[0], problems: undefined }, { type: 'app:tools:contractChanged', appName: 'ct-other', tool: 'evolve', before: first, after: live('evolve', 'ct-other').contractHash, compatible: true, problems: undefined });

  // After a stop the registry is empty: the previous contract is the manifest's.
  appTools.clearAppTools('ct-other');
  broadcasts.length = 0;
  await register([def({ name: 'evolve', returns: RESULT, inputSchema: { ...added, required: ['q', 'cursor'] } })], 'ct-other');
  const bad = broadcasts.filter((b) => b.type === 'app:tools:contractChanged');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].compatible, false);
  assert.match(bad[0].problems.join(), /"cursor" became required/);
});

test('a manifest written before contractHash existed is compared by its recomputed hash', async () => {
  const dir = path.join(appsDir, 'ct-other');
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
  m.tools = [{ name: 'old', description: 'x', inputSchema: SEARCH, returns: '', timeout: 180000, expose: 'self', kind: 'call' }];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  appTools.clearAppTools('ct-other');
  broadcasts.length = 0;
  await register([{ name: 'old', description: 'x', inputSchema: SEARCH }], 'ct-other');
  assert.deepEqual(broadcasts.filter((b) => b.type === 'app:tools:contractChanged'), [], 'the upgrade alone is no contract change');
});

// ---- structuredContent vs a schema `returns` ---------------------------------

test('a structuredContent that does not match returns is warned about and the call still succeeds', async () => {
  await register([def({ name: 'shaped', returns: RESULT, expose: 'self' })]);
  let out = { structuredContent: { total: 'many' }, content: [{ type: 'text', text: 'x' }] };
  appTools.registerAppToolHandler('ct-app', 'shaped', async () => out);
  const bad = await silenceWarn(() => appTools.callAppToolHandler('ct-app', 'shaped', { q: 'a' }));
  assert.equal(bad.result, out);
  assert.equal(bad.warnings.length, 1);
  assert.match(bad.warnings[0], /ct-app\.shaped: structuredContent does not match returns: "items" is required; "total" should be integer, got string/);

  out = { structuredContent: { items: [], total: 0 }, content: [] };
  const good = await silenceWarn(() => appTools.callAppToolHandler('ct-app', 'shaped', { q: 'a' }));
  assert.equal(good.result, out);
  assert.deepEqual(good.warnings, []);

  out = { isError: true, structuredContent: { error: 'x' }, content: [] };
  assert.deepEqual((await silenceWarn(() => appTools.callAppToolHandler('ct-app', 'shaped', { q: 'a' }))).warnings, [], 'an error result is not held to the schema');
});

test('returnsText renders a schema as one line for the text readers', () => {
  assert.equal(appTools.returnsText('{ ok }'), '{ ok }');
  assert.equal(appTools.returnsText(''), '');
  assert.equal(appTools.returnsText({ ...RESULT, description: 'Matches' }), 'Matches — { items: [any], total?: integer }');
});

// ---- the broker catalog ------------------------------------------------------

test('tools_search entries carry sideEffects and contractHash; tools_describe shows every contract field', async () => {
  await register([def({
    name: 'catalogued', sideEffects: 'external', returns: RESULT, version: '1',
    artifacts: { produces: ['application/pdf'] }, examples: [{ args: { q: 'invoice' } }],
  })]);
  const t = live('catalogued');
  const hit = broker.searchTools({ query: 'ct-app__catalogued' }).tools[0];
  assert.equal(hit.name, 'ct-app__catalogued');
  assert.equal(hit.sideEffects, 'external');
  assert.equal(hit.contractHash, t.contractHash);
  assert.deepEqual(broker.catalogEntry('ct-app__catalogued'), hit);

  const rec = broker.describeTools({ names: ['ct-app__catalogued'] }).tools[0];
  assert.equal(rec.sideEffects, 'external');
  assert.deepEqual(rec.returns, RESULT);
  assert.deepEqual(rec.artifacts, { produces: ['application/pdf'] });
  assert.deepEqual(rec.examples, [{ args: { q: 'invoice' } }]);
  assert.equal(rec.version, '1');
  assert.equal(rec.contractHash, t.contractHash);
});

// ---- app-lint -----------------------------------------------------------------

const lintDirs = [];
test.after(() => { for (const d of lintDirs) fs.rmSync(d, { recursive: true, force: true }); });
function lintApp(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-contract-lint-'));
  lintDirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return lint(dir).filter((f) => /^tool-/.test(f.rule));
}
const rules = (found) => found.map((f) => `${f.rule}:${f.file}:${f.line}`);

test('lint: an exposed tool without sideEffects, or with a prose returns, is warned', () => {
  const found = lintApp({
    'manifest.json': { name: 'lt' },
    'routes.js': [
      'module.exports = (router, ctx) => {',
      '  ctx.registerTools([',
      "    { name: 'prose', description: 'd', inputSchema: {}, returns: '{ ok }', expose: 'apps' },",
      "    { name: 'full', description: 'd', inputSchema: {}, returns: { type: 'object' }, sideEffects: 'none', expose: 'apps' },",
      "    { name: 'mine', description: 'd', inputSchema: {}, expose: 'self' },",
      '  ]);',
      "  ctx.onToolCall('prose', async () => ({}));",
      "  ctx.onToolCall('full', async () => ({}));",
      "  ctx.onToolCall('mine', async () => ({}));",
      '};',
    ].join('\n'),
  });
  assert.deepEqual(rules(found), ['tool-returns-schema:routes.js:3', 'tool-side-effects:routes.js:3']);
  assert.ok(found.every((f) => f.level === 'warn'));
});

// Modelled on vistaclair-apps/my-podcast create_podcast: the work runs in the
// background, the tool answers at once with ids, and it is a quick call.
test('lint tool-async-not-job: an async tool registered as a quick call is warned; a job tool and a quick tool are not', () => {
  const found = lintApp({
    'manifest.json': { name: 'podcasty' },
    'routes.js': [
      'module.exports = (router, ctx) => {',
      '  ctx.registerTools([',
      '    {',
      "      name: 'create_podcast',",
      "      description: 'Generate a two-host audio podcast episode from arbitrary content. The episode is written, voiced and stitched into a single MP3 asynchronously — this tool returns immediately with an episodeId and jobId; the audio is ready shortly after.',",
      "      inputSchema: { type: 'object', properties: { topic: { type: 'string', description: 'A bare topic.' } } },",
      '      timeout: 30000,',
      '    },',
      '    {',
      "      name: 'make_episode',",
      "      description: 'Generate a podcast episode; returns the finished MP3 as a vc-artifact.',",
      "      inputSchema: { type: 'object', properties: { jobId: { type: 'string', description: 'Returns the jobId of an earlier run to continue.' } } },",
      "      kind: 'job',",
      '    },',
      '    {',
      "      name: 'list_episodes',",
      "      description: 'List the episodes in the library.',",
      "      inputSchema: { type: 'object', properties: {} },",
      '    },',
      '    {',
      "      name: 'render_video',",
      "      description: 'Render the episode video.',",
      "      inputSchema: { type: 'object', properties: {} },",
      '    },',
      '  ]);',
      "  ctx.onToolCall('create_podcast', async (args) => ({ content: [] }));",
      "  ctx.onToolCall('make_episode', async (args, caller, job) => ({ content: [] }));",
      "  ctx.onToolCall('list_episodes', async () => ({ content: [] }));",
      "  ctx.onToolCall('render_video', async (args) => {",
      "    const { id: jobId } = ctx.jobs.start({ name: 'render' }, async () => {});",
      '    return { content: [{ type: \'text\', text: JSON.stringify({ jobId }) }] };',
      '  });',
      '};',
    ].join('\n'),
  }).filter((f) => f.rule === 'tool-async-not-job');
  assert.deepEqual(rules(found), ['tool-async-not-job:routes.js:4', 'tool-async-not-job:routes.js:21']);
  assert.ok(found.every((f) => f.level === 'warn'));
  assert.match(found[0].message, /"create_podcast" says it runs asynchronously.*register it with kind: 'job' and return the finished result/);
  assert.match(found[1].message, /"render_video" starts ctx\.jobs and returns the job id/);
});

test('lint drift: handlers with no registerTools at all and a dead manifest.tools (the my-shodan case)', () => {
  const found = lintApp({
    'manifest.json': { name: 'shodanish', tools: [{ name: 'run_scan', inputSchema: {} }, { name: 'get_results', inputSchema: {} }] },
    'routes.js': [
      'module.exports = (router, ctx) => {',
      '  if (ctx.onToolCall) {',
      "    ctx.onToolCall('run_scan', async () => ({}));",
      "    ctx.onToolCall('get_results', async () => ({}));",
      '  }',
      '};',
    ].join('\n'),
  });
  assert.deepEqual(rules(found), ['tool-drift:routes.js:3', 'tool-drift:routes.js:4', 'tool-drift:manifest.json:0']);
  assert.match(found[2].message, /run_scan, get_results but the code never calls ctx\.registerTools/);
});

test('lint drift: a handler without a tool, a tool without a handler, a stale manifest entry', () => {
  const found = lintApp({
    'manifest.json': { name: 'drifty', tools: [{ name: 'kept', inputSchema: {} }, { name: 'gone', inputSchema: {} }] },
    'lib/tools.js': [
      'exports.TOOLS = [',
      "  { name: 'kept', description: 'd', inputSchema: { type: 'object' } },",
      "  { name: 'orphan', description: 'd', inputSchema: {} },",
      '];',
    ].join('\n'),
    'routes.js': [
      "const { TOOLS } = require('./lib/tools');",
      'module.exports = (router, ctx) => {',
      '  ctx.registerTools(TOOLS);',
      "  ctx.onToolCall('kept', async () => ({}));",
      "  ctx.onToolCall('ghost', async () => ({}));",
      '};',
    ].join('\n'),
  });
  assert.deepEqual(rules(found).sort(), ['tool-drift:lib/tools.js:3', 'tool-drift:manifest.json:0', 'tool-drift:routes.js:5']);
  const msg = found.map((f) => f.message).join('\n');
  assert.match(msg, /onToolCall\('ghost'\) has no registered tool/);
  assert.match(msg, /tool "orphan" is registered but has no ctx\.onToolCall/);
  assert.match(msg, /manifest\.tools lists gone, which the code does not register/);
});

test('lint drift stays quiet when names are computed, and example args are not tool names', () => {
  assert.deepEqual(lintApp({
    'manifest.json': { name: 'mirror', tools: [{ name: 'from_elsewhere', inputSchema: {} }] },
    'routes.js': [
      'module.exports = (router, ctx) => {',
      '  const defs = remote.map((t) => ({',
      '    name: t.name,',
      '    inputSchema: t.schema,',
      '  }));',
      '  ctx.registerTools(defs);',
      '  for (const d of defs) ctx.onToolCall(d.name, handle);',
      '};',
    ].join('\n'),
  }), []);
  assert.deepEqual(lintApp({
    'manifest.json': { name: 'ex' },
    'routes.js': [
      'module.exports = (router, ctx) => {',
      '  ctx.registerTools([{',
      "    name: 'greet', description: 'd', inputSchema: { type: 'object', properties: { name: { type: 'string' } } },",
      "    examples: [{ args: { name: 'Ada' } }],",
      '  }]);',
      "  ctx.onToolCall('greet', async () => ({}));",
      '};',
    ].join('\n'),
  }), []);
});

test('lint: manifest.tools examples that do not fit the inputSchema are warned', () => {
  const found = lintApp({
    'manifest.json': { name: 'exa', tools: [{ name: 'find', inputSchema: SEARCH, examples: [{ args: { q: 'ok' } }, { args: { limit: 'ten' } }] }] },
    'routes.js': [
      'module.exports = (router, ctx) => {',
      "  ctx.registerTools([{ name: 'find', description: 'd', inputSchema: {} }]);",
      "  ctx.onToolCall('find', async () => ({}));",
      '};',
    ].join('\n'),
  });
  assert.deepEqual(rules(found), ['tool-examples:manifest.json:0']);
  assert.match(found[0].message, /example 2 does not fit its inputSchema: "q" is required; "limit" should be integer, got string/);
});
