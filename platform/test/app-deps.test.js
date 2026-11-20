// App→app dependency edges (src/apps/app-deps.js): the store and its
// persistence, the three sources of an edge (a change request reaching done,
// `app-change.js depend`, an observed call), enforcement in authorizeToolCall
// for app callers only, the call stats, contract protection, the provider
// notes in the prompts, app-lint's undeclared-call warning and the Setup
// overview (edges, health, agent grants).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeAppsDir, silenceWarn } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const appTools = require('../src/apps/app-tools');
const appDeps = require('../src/apps/app-deps');
const broker = require('../src/apps/mcp-broker');
const cr = require('../src/apps/app-change-requests');
const { core } = require('../src/apps/core-services');
const { lint } = require('../src/apps/app-lint');

const appsDir = makeAppsDir({ alpha: {}, beta: {}, gamma: {} });
appManager.setAppsDir(appsDir);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-deps-'));
broker.init({ dir: path.join(tmp, 'broker') });

const settings = { appDepsEnforce: 'warn' };
const broadcasts = [];
const savedBroadcaster = core.broadcaster;
// Registrations broadcast through core; the server taps them into app-deps.
core.broadcaster = { broadcast: (m) => { broadcasts.push(m); appDeps.observeBroadcast(m); } };
let dataHome;
function fresh() {
  dataHome = fs.mkdtempSync(path.join(tmp, 'home-'));
  appDeps.init({ dataHome, settings: { get: (k) => settings[k] }, broadcaster: { broadcast: (m) => broadcasts.push(m) } });
  settings.appDepsEnforce = 'warn';
  broadcasts.length = 0;
}

const READ = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
const OUT = { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] };
const tool = (name, over = {}) => ({ name, description: `${name}.`, inputSchema: READ, returns: OUT, sideEffects: 'none', expose: 'apps', ...over });
async function registerBeta(defs) {
  await silenceWarn(() => appTools.registerAppTools('beta', defs));
  for (const d of defs) appTools.registerAppToolHandler('beta', d.name, async (args) => (args.fail ? { isError: true, content: [] } : { content: [], structuredContent: { value: 1 } }));
}
const callAs = (app, t, args = { id: 'x' }) => appTools.callAppToolHandler('beta', t, args, { type: 'app', appName: app });

test.after(() => {
  core.broadcaster = savedBroadcaster;
  for (const a of ['alpha', 'beta', 'gamma']) appTools.clearAppTools(a);
  fs.rmSync(appsDir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- the store ----------------------------------------------------------------

test('boot seeds an empty store; edges persist and reload', async () => {
  fresh();
  const file = path.join(dataHome, 'app-deps.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).edges, []);
  await registerBeta([tool('reading'), tool('history')]);

  const { edge } = appDeps.declare({ consumer: 'alpha', provider: 'beta', tools: ['reading'], purpose: 'shows it', origin: { type: 'owner' } });
  assert.equal(edge.status, 'approved');
  assert.match(edge.contract.reading, /^[0-9a-f]{64}$/);
  assert.equal(edge.contractStatus, 'ok');
  // A second declaration on the pair merges into the one approved edge.
  appDeps.declare({ consumer: 'alpha', provider: 'beta', tools: ['history'], purpose: 'charts it' });
  assert.equal(appDeps.forConsumer('alpha').length, 1);
  assert.deepEqual(appDeps.get(edge.id).tools, ['history', 'reading']);
  assert.equal(appDeps.get(edge.id).purpose, 'shows it; charts it');

  appDeps.init({ dataHome, settings: { get: (k) => settings[k] } });
  const back = appDeps.get(edge.id);
  assert.deepEqual(back.tools, ['history', 'reading']);
  assert.deepEqual(appDeps.forProvider('beta').map((e) => e.id), [edge.id]);
  assert.equal(appDeps.revoke(edge.id).edge.status, 'revoked');
  assert.equal(appDeps.approvedFor('alpha', 'beta', 'reading'), null);
  assert.equal(appDeps.approve('nope').error, 'unknown dependency');
});

// ---- sources --------------------------------------------------------------------

test('a tool change request reaching done records an approved edge with its contract', async () => {
  fresh();
  await registerBeta([tool('reading')]);
  const sessions = new Map([['cli-alpha', { tabId: 'app-alpha' }], ['cli-beta', { tabId: 'app-beta' }]]);
  const crHome = fs.mkdtempSync(path.join(tmp, 'cr-'));
  cr.init({
    dataHome: crHome,
    cliSessionManager: {
      get: () => null, list: () => [],
      getByInstanceId: (id) => (sessions.has(id) ? { ...sessions.get(id), getSettings: () => ({}) } : null),
      writeWhenReady: () => {},
    },
    appManager: { APPS_DIR: appsDir, list: () => ['alpha', 'beta'].map((name) => ({ name })), readManifest: (n) => appManager.readManifest(n) },
    launchChangeSession: () => ({ tabId: 'app-beta' }),
    settings: { get: () => undefined },
    addExitHook: () => {},
  });
  const { id } = cr.request({ instanceId: 'cli-alpha', to: 'beta', prompt: 'add a unit', interface: { kind: 'tool', name: 'reading' }, adds: ['unit'], reason: 'alpha shows units' });
  cr.decide(id, { ok: true });
  assert.equal(appDeps.list().length, 0, 'no edge before done');
  await registerBeta([tool('reading', { inputSchema: { ...READ, properties: { ...READ.properties, unit: { type: 'string' } } } })]);
  const out = cr.done({ instanceId: 'cli-beta', id, summary: 'reading takes unit' });
  assert.equal(out.state, 'done');
  const [edge] = appDeps.list();
  assert.equal(edge.consumer, 'alpha');
  assert.equal(edge.provider, 'beta');
  assert.deepEqual(edge.tools, ['reading']);
  assert.deepEqual(edge.origin, { type: 'change-request', ref: id });
  assert.equal(edge.contract.reading, appTools.getToolsForApp('beta')[0].contractHash);
  assert.equal(edge.purpose, 'alpha shows units');
});

test('depend: identified like request, refuses unknown and non-apps tools', async () => {
  fresh();
  await registerBeta([tool('reading'), tool('private', { expose: 'platform' })]);
  // The route calls appDeps.depend; the caller is the change-request module's.
  const sessions = new Map([['cli-alpha', { tabId: 'app-alpha' }], ['cli-shell', { tabId: 'tab-1' }]]);
  cr.init({
    dataHome: fs.mkdtempSync(path.join(tmp, 'cr-')),
    cliSessionManager: { getByInstanceId: (i) => (sessions.has(i) ? { ...sessions.get(i), getSettings: () => ({}) } : null), list: () => [] },
    appManager: { APPS_DIR: appsDir, list: () => ['alpha', 'beta'].map((name) => ({ name })), readManifest: (n) => appManager.readManifest(n) },
  });
  assert.match(appDeps.depend({ instanceId: 'nobody', on: 'beta', tools: ['reading'], why: 'x' }).error, /no running CLI tab/);
  assert.match(appDeps.depend({ instanceId: 'cli-shell', on: 'beta', tools: ['reading'], why: 'x' }).error, /not an app change tab/);
  assert.match(appDeps.depend({ instanceId: 'cli-alpha', on: 'nope', tools: ['reading'], why: 'x' }).error, /no app named "nope"/);
  assert.match(appDeps.depend({ instanceId: 'cli-alpha', on: 'beta', tools: ['ghost'], why: 'x' }).error, /no tool ghost — tools exposed to apps: reading/);
  assert.match(appDeps.depend({ instanceId: 'cli-alpha', on: 'beta', tools: ['private'], why: 'x' }).error, /not exposed to apps/);
  assert.match(appDeps.depend({ instanceId: 'cli-alpha', on: 'beta', tools: ['reading'] }).error, /missing --why/);
  const ok = appDeps.depend({ instanceId: 'cli-alpha', on: 'beta', tools: 'reading', why: 'alpha shows it' });
  assert.equal(ok.edge.status, 'approved');
  assert.deepEqual(ok.edge.origin, { type: 'declared' });
  assert.deepEqual(ok.edge.tools, ['reading']);
});

// ---- enforcement -----------------------------------------------------------------

test('warn: an undeclared call is allowed, observed and flagged in the audit', async () => {
  fresh();
  await registerBeta([tool('reading')]);
  await callAs('alpha', 'reading');
  const [edge] = appDeps.list();
  assert.equal(edge.status, 'observed');
  assert.deepEqual(edge.tools, ['reading']);
  assert.deepEqual(edge.origin, { type: 'observed' });
  assert.equal(edge.calls, 1);
  assert.ok(broadcasts.some((m) => m.type === 'app:deps:changed'));
  const audit = appTools.getToolAudit(1)[0];
  assert.equal(audit.undeclared, true);
  assert.equal(audit.ok, true);
  // Approving the observed edge makes the next call a declared one.
  const { edge: approved } = appDeps.approve(edge.id);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.calls, 1, 'stats carried over');
  assert.equal(appDeps.list().length, 1, 'the observed edge was absorbed');
  await callAs('alpha', 'reading');
  assert.equal('undeclared' in appTools.getToolAudit(1)[0], false);
});

test('enforce: refused with the missing edge named; * edges; non-app callers unaffected', async () => {
  fresh();
  settings.appDepsEnforce = 'enforce';
  await registerBeta([tool('reading'), tool('history'), tool('mine', { expose: 'self' })]);
  await assert.rejects(callAs('alpha', 'reading'), (err) => {
    assert.match(err.message, /App "alpha" has no approved dependency on "beta" for tool "reading"/);
    assert.match(err.message, /app-change\.js depend --on beta --tools reading/);
    return true;
  });
  assert.equal(appTools.getToolAudit(1)[0].undeclared, true);
  assert.equal(appDeps.list()[0].status, 'observed', 'a refused call can still be approved in Setup');

  appDeps.declare({ consumer: 'alpha', provider: 'beta', tools: ['*'], purpose: 'all of it' });
  await callAs('alpha', 'reading');
  await callAs('alpha', 'history');
  // '*' covers apps-exposed tools only: expose still refuses a self tool.
  await assert.rejects(callAs('alpha', 'mine'), /not exposed to app callers/);
  // Another app has no edge.
  await assert.rejects(callAs('gamma', 'reading'), /App "gamma" has no approved dependency/);
  // Self, platform, cron, gui-test and agent callers never consult the edges.
  for (const caller of [{ type: 'self' }, { type: 'platform' }, { type: 'cron', appName: 'gamma' }, { type: 'gui-test' },
    { type: 'orchestrator', runId: 'r1', address: 'o', scope: null }]) {
    await appTools.callAppToolHandler('beta', 'reading', { id: 'x' }, caller);
  }
  // An app calling its own tools is self (callCrossAppTool), never an edge.
  assert.deepEqual(appTools.authorizeToolCall({ type: 'app', appName: 'beta' }, 'beta__reading', { app: 'beta', tool: 'reading' }), { allow: true });
  assert.equal(appDeps.list().filter((e) => e.consumer === 'gamma').length, 1);
  assert.equal(appDeps.list().length, 2, 'only app callers create edges');
});

test('recordCall keeps calls, errors and lastCallAt on the covering edge, persisted', async () => {
  fresh();
  await registerBeta([tool('reading')]);
  const { edge } = appDeps.declare({ consumer: 'alpha', provider: 'beta', tools: ['reading'] });
  await callAs('alpha', 'reading');
  await callAs('alpha', 'reading', { id: 'x', fail: true });          // an isError result
  appTools.registerAppToolHandler('beta', 'reading', async () => { throw new Error('boom'); });
  await assert.rejects(callAs('alpha', 'reading'), /boom/);
  const after = appDeps.get(edge.id);
  assert.equal(after.calls, 3);
  assert.equal(after.errors, 2);
  assert.ok(after.lastCallAt > 0);
  appDeps.flush();
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataHome, 'app-deps.json'), 'utf8')).edges[0];
  assert.equal(onDisk.calls, 3);
  assert.equal(appDeps.recordCall('gamma', 'beta', 'reading'), null, 'no edge, nothing to count');
});

// ---- contract protection -----------------------------------------------------------

test('a contract change marks edges changed-compatible or broken, and re-approve clears it', async () => {
  fresh();
  await registerBeta([tool('reading')]);
  const { edge } = appDeps.declare({ consumer: 'alpha', provider: 'beta', tools: ['reading'] });
  const approvedHash = edge.contract.reading;

  // An optional parameter added: compatible.
  await registerBeta([tool('reading', { inputSchema: { ...READ, properties: { ...READ.properties, unit: { type: 'string' } } } })]);
  let e = appDeps.get(edge.id);
  assert.equal(e.contractStatus, 'changed-compatible');
  assert.deepEqual(e.contractProblems, []);
  assert.equal(broadcasts.filter((m) => m.type === 'toast:push').length, 0);

  // `id` removed: broken, judged against the APPROVED contract, with a toast.
  await registerBeta([tool('reading', { inputSchema: { type: 'object', properties: { unit: { type: 'string' } } } })]);
  e = appDeps.get(edge.id);
  assert.equal(e.contractStatus, 'broken');
  assert.ok(e.contractProblems.some((p) => /^reading: .*id/.test(p)), e.contractProblems.join('; '));
  const toast = broadcasts.find((m) => m.type === 'toast:push');
  assert.equal(toast.level, 'error');
  assert.match(toast.title, /beta broke a tool alpha depends on/);

  // Re-approve: the current contract becomes the approved one.
  const { edge: re } = appDeps.approve(edge.id);
  assert.equal(re.contractStatus, 'ok');
  assert.notEqual(re.contract.reading, approvedHash);
  assert.equal(re.contract.reading, appTools.getToolsForApp('beta')[0].contractHash);

  // No longer exposed to apps: broken.
  await registerBeta([tool('reading', { expose: 'platform', inputSchema: { type: 'object', properties: { unit: { type: 'string' } } } })]);
  assert.match(appDeps.get(edge.id).contractProblems[0], /no longer exposed to apps/);
});

// ---- provider awareness ----------------------------------------------------------------

test('the provider prompt names its dependents; the consumer sidecar says declared yes/no', async () => {
  fresh();
  await registerBeta([tool('reading')]);
  const prompt = require('../src/apps/app-builder-prompt');
  assert.equal(prompt.buildUsedBy('beta'), '');
  appDeps.declare({ consumer: 'alpha', provider: 'beta', tools: ['reading'] });
  const used = prompt.buildUsedBy('beta');
  assert.match(used, /### Used by other apps/);
  assert.match(used, /\*\*alpha\*\* \(reading\)/);
  assert.match(used, /backwards compatible/);
  assert.match(prompt.buildCrossAppTools('beta'), /Used by other apps/);

  for (const app of ['alpha', 'gamma']) {
    const dir = path.join(appsDir, app);
    fs.mkdirSync(path.join(dir, '.vistaclair'), { recursive: true });
    prompt.refreshDocCopies(dir, app, { api: false });
  }
  assert.match(fs.readFileSync(path.join(appsDir, 'alpha', '.vistaclair', 'apps', 'beta.md'), 'utf8'), /Declared dependency: \*\*yes\*\* \(reading\)/);
  assert.match(fs.readFileSync(path.join(appsDir, 'gamma', '.vistaclair', 'apps', 'beta.md'), 'utf8'), /Declared dependency: \*\*no\*\* — .*depend --on beta/);
});

// ---- lint ------------------------------------------------------------------------------

test('app-lint warns on a literal cross-app call without an approved edge', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'lint-'));
  const app = path.join(root, 'apps', 'caller');
  fs.mkdirSync(path.join(app, 'public'), { recursive: true });
  fs.writeFileSync(path.join(app, 'manifest.json'), JSON.stringify({ name: 'caller' }));
  fs.writeFileSync(path.join(app, 'routes.js'), [
    'module.exports = (router, ctx) => {',
    "  router.get('/a', async (req, res) => res.json(await ctx.tools.call('beta', 'reading', {})));",
    "  router.get('/b', async (req, res) => res.json(await ctx.tools.call('beta', 'history', {})));",
    "  router.get('/c', async (req, res) => res.json(await ctx.tools.call(req.query.app, 'x', {})));",
    '};', '',
  ].join('\n'));
  const rule = () => lint(app).filter((f) => f.rule === 'tool-dependency');
  assert.equal(rule().length, 0, 'no edges file: the rule is skipped');
  fs.writeFileSync(path.join(root, 'app-deps.json'), JSON.stringify({ edges: [
    { id: 'd1', consumer: 'caller', provider: 'beta', tools: ['reading'], status: 'approved' },
    { id: 'd2', consumer: 'caller', provider: 'beta', tools: ['history'], status: 'observed' },
  ] }));
  const found = rule();
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 3);
  assert.match(found[0].message, /ctx\.tools\.call\('beta', 'history'\) has no declared dependency/);
});

// ---- Setup → Tools & Access ---------------------------------------------------------------

test('the Setup overview carries the mode, edges, health and the live agent grants', async () => {
  fresh();
  await registerBeta([tool('reading'), tool('history'), tool('unused')]);
  appDeps.declare({ consumer: 'alpha', provider: 'beta', tools: ['reading'] });
  const { edge: old } = appDeps.declare({ consumer: 'gamma', provider: 'beta', tools: ['history'] });
  // gamma's edge was approved 40 days ago and never called.
  appDeps.init({ dataHome, settings: { get: (k) => settings[k] } });
  const file = path.join(dataHome, 'app-deps.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.edges.find((e) => e.id === old.id).approvedAt = Date.now() - 40 * 86400e3;
  fs.writeFileSync(file, JSON.stringify(data));
  appDeps.init({ dataHome, settings: { get: (k) => settings[k] } });
  await callAs('gamma', 'reading');   // undeclared

  const holder = broker.createHolderSession({ holder: { type: 'orchestrator', runId: 'run-1', address: 'orch-1', instanceId: 'i-1' }, mode: 'catalog' });
  try {
    const ov = appDeps.overview();
    assert.equal(ov.mode, 'warn');
    assert.equal(ov.edges.length, 3);
    assert.deepEqual(ov.health.exposedUnused.filter((x) => x.app === 'beta'), [{ app: 'beta', tool: 'unused' }]);
    assert.deepEqual(ov.health.idle.map((x) => x.id), [old.id]);
    assert.ok(ov.health.undeclared.some((u) => u.consumer === 'gamma' && u.provider === 'beta' && u.tool === 'reading'));
    const run = ov.agentGrants.find((r) => r.runId === 'run-1');
    assert.deepEqual(run.members.map((m) => [m.address, m.type, m.mode, m.tools]), [['orch-1', 'orchestrator', 'catalog', null]]);
    settings.appDepsEnforce = 'bogus';
    assert.equal(appDeps.overview().mode, 'warn', 'an unknown setting reads as warn');
  } finally {
    broker.revokeSession(holder.id);
  }
});
