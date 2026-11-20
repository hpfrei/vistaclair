// The lean prompt of an orchestration run's workers (profile 'worker',
// prompts/extend-worker.md). The normal Extend prompt is untouched (byte for
// byte against test/fixtures/prompt-extend-*.txt); the worker prompt drops the
// file list, the API reference body and the APP.md maintenance block for
// pointers to sidecars; the launcher records what the lean workers never saw
// (inlined.json `keys: []`) so app-lint still demands the reads; and both
// prompts reach core's orchestration settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const promptBuilder = require('../src/apps/app-builder-prompt');
const appManager = require('../src/apps/app-manager');
const { lint } = require('../src/apps/app-lint');
const { extendPrompts, fixtureApp, CASES } = require('./prompt-snapshot');
const apps = require('../src/apps/index');

const FIXTURES = path.join(__dirname, 'fixtures');
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// ---- the normal prompt is untouched ---------------------------------------------

test('the normal Extend prompt is byte-identical to its snapshot', () => {
  for (const [file, text] of Object.entries(extendPrompts())) {
    assert.equal(text, fs.readFileSync(path.join(FIXTURES, file), 'utf-8'), `${file} changed`);
  }
});

test("profile 'full', an unknown profile, and the worker profile of a build/tools session are the normal prompt", () => {
  const snap = extendPrompts();
  assert.deepEqual(extendPrompts({ profile: 'full' }), snap);
  assert.deepEqual(extendPrompts({ profile: 'nonsense' }), snap);
  const fx = fixtureApp();
  try {
    for (const action of ['build', 'build-tools', 'recreate-appmd']) {
      const args = { appName: fx.name, description: 'd', userRequest: 'a map' };
      assert.equal(promptBuilder.buildPrompt(action, { ...args, profile: 'worker' }), promptBuilder.buildPrompt(action, args), action);
    }
  } finally { fx.restore(); }
});

// ---- the worker prompt ----------------------------------------------------------

test('the worker prompt omits the file list, the API body and the maintenance block, and points at the sidecars', () => {
  const full = extendPrompts();
  const worker = extendPrompts({ profile: 'worker' });
  for (const file of Object.keys(CASES)) {
    const w = worker[file];
    const f = full[file];
    // Kept: APP.md, the standing rules, how to work, the architecture rules.
    assert.ok(w.includes('SNAPSHOT-APP-MD-MARKER'), 'APP.md');
    assert.ok(w.includes('## Standing rules') && w.includes('## How to work') && w.includes('## Architecture Rules'));
    assert.ok(w.includes(require('../src/apps/standing-rules').standingRules().slice(0, 200)), 'standing rules body');
    // Dropped: the file list, the API reference body (and the inlined Maps section), the maintenance block.
    assert.ok(f.includes('**Current files**'), 'the full prompt has the file list');
    assert.ok(!w.includes('Current files') && !w.includes('routes.js, '), 'no file list');
    assert.ok(!w.includes('## Section Index') && !w.includes('## Trust Model') && !w.includes('## Bridge Methods'), 'no API body');
    assert.ok(!w.includes('### Maps & Routing (Directions'), 'no inlined section, whatever the request says');
    assert.ok(f.includes('## APP.md Maintenance — Mandatory') && !w.includes('## APP.md Maintenance — Mandatory'), 'no maintenance block');
    assert.ok(!w.includes('### Keep APP.md compact'));
    assert.ok(!w.includes('{{'), 'every placeholder resolved');
    // The pointers.
    assert.ok(w.includes('read `.vistaclair/api-reference.md`'), 'API pointer');
    assert.ok(w.includes('`.vistaclair/api/<key>.md`'), 'section file pointer');
    assert.ok(w.includes('read `.vistaclair/appmd-maintenance.md`'), 'maintenance pointer');
    assert.ok(w.length < f.length * 0.8, `${file}: worker ${w.length} vs full ${f.length}`);
  }
  // The keyword hit costs the full prompt 8K and the worker nothing.
  assert.equal(worker['prompt-extend-plain.txt'].length, worker['prompt-extend-maps.txt'].length);
});

test('every sidecar the worker prompt points at is one the launcher writes', () => {
  const fx = fixtureApp();
  try {
    const prompt = promptBuilder.buildPrompt('extend', { appName: fx.name, description: 'd', userRequest: 'x', profile: 'worker' });
    promptBuilder.writeSidecars(fx.dir, { action: 'extend', appName: fx.name, profile: 'worker' });
    const named = [...prompt.matchAll(/\.vistaclair\/([a-z-]+(?:\/[a-z]+)?\.md)/g)].map((m) => m[1]).filter((f) => !f.includes('<'));
    assert.ok(named.includes('appmd-maintenance.md') && named.includes('api-reference.md'));
    for (const f of named) assert.ok(fs.existsSync(path.join(fx.dir, '.vistaclair', f)), f);
  } finally { fx.restore(); }
});

// ---- sidecars -------------------------------------------------------------------

test('writeSidecars writes appmd-maintenance.md with its pointer resolved, for every launch', () => {
  const fx = fixtureApp();
  try {
    for (const profile of ['', 'worker']) {
      promptBuilder.writeSidecars(fx.dir, { action: 'extend', appName: fx.name, profile });
      const body = fs.readFileSync(path.join(fx.dir, '.vistaclair', 'appmd-maintenance.md'), 'utf-8');
      assert.match(body, /^## APP\.md Maintenance — Mandatory/);
      assert.ok(body.includes('### Keep APP.md compact'));
      assert.ok(body.includes('read `.vistaclair/appmd-format.md`') && !body.includes('{{'));
    }
  } finally { fx.restore(); }
});

const inlinedOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.vistaclair', 'inlined.json'), 'utf-8'));

test('inlined.json: a lean worker launch records no inlined key; a normal launch is as before', () => {
  const fx = fixtureApp();
  try {
    const req = 'show a map with a route to the place';
    promptBuilder.writeSidecars(fx.dir, { action: 'extend', appName: fx.name, userRequest: req });
    const normal = inlinedOf(fx.dir);
    assert.ok(normal.keys.includes('maps'), 'the full prompt inlines Maps');
    assert.equal(normal.profile, undefined);
    assert.deepEqual(Object.keys(normal), ['at', 'action', 'keys', 'baseline'], 'same shape as before');

    promptBuilder.writeSidecars(fx.dir, { action: 'extend', appName: fx.name, userRequest: req, profile: 'worker' });
    const lean = inlinedOf(fx.dir);
    assert.deepEqual([lean.keys, lean.profile, lean.action], [[], 'worker', 'extend']);

    // A build launch has no lean profile, whatever is asked.
    promptBuilder.writeSidecars(fx.dir, { action: 'build', appName: fx.name, userRequest: req, profile: 'worker' });
    assert.ok(inlinedOf(fx.dir).keys.includes('maps'));
  } finally { fx.restore(); }
});

test('markWorkerProfile turns a normal stamp lean once the mode is known, and only for extend', () => {
  const fx = fixtureApp();
  try {
    promptBuilder.writeSidecars(fx.dir, { action: 'extend', appName: fx.name, userRequest: 'a map route' });
    const before = inlinedOf(fx.dir);
    assert.ok(before.keys.length);
    assert.equal(promptBuilder.markWorkerProfile(fx.dir), true);
    const after = inlinedOf(fx.dir);
    assert.deepEqual([after.keys, after.profile, after.at, after.baseline], [[], 'worker', before.at, before.baseline]);

    promptBuilder.writeSidecars(fx.dir, { action: 'build', appName: fx.name, userRequest: 'a map route' });
    assert.equal(promptBuilder.markWorkerProfile(fx.dir), false);
    assert.ok(inlinedOf(fx.dir).keys.length);
    assert.equal(promptBuilder.markWorkerProfile(path.join(fx.root, 'nothing-here')), false);
  } finally { fx.restore(); }
});

// ---- app-lint still demands the reads a lean worker owes -----------------------------

function launchedApp(profile, request) {
  const fx = fixtureApp('fx-lean');
  dirs.push(fx.root);
  const keepRoot = fx.root;
  fx.restore = () => {};   // keep the dir for lint; torn down in test.after
  appManager.setAppsDir(keepRoot);
  promptBuilder.writeSidecars(fx.dir, { action: 'extend', appName: 'fx-lean', userRequest: request, profile });
  // The session then writes code that uses email, and APP.md.
  const stamp = Date.parse(inlinedOf(fx.dir).at) + 5000;
  const write = (rel, body) => {
    fs.writeFileSync(path.join(fx.dir, rel), body);
    fs.utimesSync(path.join(fx.dir, rel), new Date(stamp), new Date(stamp));
  };
  write('routes.js', "module.exports = (router, ctx) => {\n  router.get('/r', async (q, r) => r.json(await ctx.email.list({ limit: 1 })));\n};\n");
  write('APP.md', '# fx-lean\n## Purpose\nchanged\n');
  return fx.dir;
}
const unread = (dir) => lint(dir).filter((f) => f.level === 'error' && f.rule === 'unread-capability').map((f) => f.message.match(/`([\w/-]+)` section/)[1]);
const read = (dir, key) => fs.appendFileSync(path.join(dir, '.vistaclair', 'reads.jsonl'), JSON.stringify({ key }) + '\n');

test('rule 19 demands a read of a section a lean worker never saw, and of the maintenance rules', () => {
  const req = 'list my email';
  // Full prompt: the email section was inlined, so no read is owed for it; the maintenance block was inlined too.
  const full = launchedApp('', req);
  assert.deepEqual(unread(full), ['appmd-format']);
  // Lean worker, same request: the email section was NOT in its prompt.
  const lean = launchedApp('worker', req);
  const owed = unread(lean);
  assert.deepEqual(owed.sort(), ['api/email', 'appmd-format', 'appmd-maintenance'].sort());
  for (const key of owed) read(lean, key);
  assert.deepEqual(unread(lean), []);
});

test('the read hook records a read of appmd-maintenance.md', () => {
  const { execFileSync } = require('node:child_process');
  const dir = launchedApp('worker', '');
  execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'apps', 'hooks', 'read-ledger.js')], {
    input: JSON.stringify({ cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '.vistaclair/appmd-maintenance.md' } }),
  });
  assert.match(fs.readFileSync(path.join(dir, '.vistaclair', 'reads.jsonl'), 'utf-8'), /"key":"appmd-maintenance"/);
});

// ---- both prompts reach core's orchestration settings ----------------------------------

function harness({ credential = 'subscription', openCliResult } = {}) {
  const appsDir = fs.mkdtempSync(path.join(process.env.VISTACLAIR_FIXTURE_TMP || os.tmpdir(), 'vc-lean-apps-'));
  dirs.push(appsDir);
  const dir = path.join(appsDir, 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'demo', description: 'x' }));
  fs.writeFileSync(path.join(dir, 'routes.js'), 'module.exports = () => {};\n');
  fs.writeFileSync(path.join(dir, 'APP.md'), '# demo\nDEMO-APP-MD\n');
  const state = { appsDir, dir, opened: [], launches: [], sent: [] };
  const csm = { sessions: new Map(), list: () => [], get: () => null, launchSession: (tabId, o) => state.launches.push({ tabId, o }), onExit() {} };
  apps.initSessions({
    appsDir, proxyPort: 0, broadcaster: { broadcast() {} }, cliSessionManager: csm, pendingQuestions: new Map(),
    openCli: async (o) => { state.opened.push(o); return (openCliResult || ((x) => ({ tabId: x.tabId, mode: x.mode || 'orchestrator', engine: x.engine, auth: x.auth || null })))(o); },
    resolveAuth: () => ({ credential, key: '' }),
  });
  const ws = { send: (s) => state.sent.push(JSON.parse(s)) };
  state.spawn = (msg) => apps.handleMessage(ws, { type: 'app:spawnCli', name: 'demo', cols: 80, rows: 24, ...msg }, { broadcast() {} });
  return state;
}

test('launchChangeSession (an orchestrator run) passes the full and the lean prompt, and records keys []', async () => {
  const h = harness();
  await apps.launchChangeSession('demo', { prompt: 'add a map with a route', autoSubmit: true, action: 'extend' });
  const s = h.opened[0].settings;
  assert.ok(s.appendSystemPrompt.includes('Current files') && s.appendSystemPrompt.includes('## APP.md Maintenance — Mandatory'));
  assert.ok(s.workerAppendSystemPrompt.length > 0 && s.workerAppendSystemPrompt.length < s.appendSystemPrompt.length);
  assert.ok(s.workerAppendSystemPrompt.includes('DEMO-APP-MD') && !s.workerAppendSystemPrompt.includes('Current files'));
  assert.deepEqual([inlinedOf(h.dir).keys, inlinedOf(h.dir).profile], [[], 'worker']);
});

test('launchChangeSession: a change request section is on both prompts', async () => {
  const h = harness();
  const cr = { id: 'cr-9', from: 'alpha', to: 'demo', chain: ['alpha', 'demo'], interface: { kind: 'tool', name: 'zzt' }, depth: 1, maxDepth: 1 };
  await apps.launchChangeSession('demo', { prompt: 'add zzt', autoSubmit: true, action: 'extend', changeRequest: cr });
  const s = h.opened[0].settings;
  const section = require('../src/apps/app-change-requests').targetPromptSection(cr);
  assert.ok(s.appendSystemPrompt.endsWith(section) && s.workerAppendSystemPrompt.endsWith(section));
});

test('a simple launch (hidden, resume, no SDK billing) carries no lean prompt and keeps the full stamp', async () => {
  const h = harness();
  await apps.launchChangeSession('demo', { prompt: 'fix', autoSubmit: true, action: 'extend', hidden: true });
  await apps.launchChangeSession('demo', { prompt: 'fix', autoSubmit: true, action: 'extend', resumeSessionId: 'abc' });
  assert.ok(h.opened.every((o) => !('workerAppendSystemPrompt' in o.settings)));
  assert.ok(inlinedOf(h.dir).profile === undefined);

  const none = harness({ credential: null });   // no Claude credential: the CLI terminal, straight from Pro
  await apps.launchChangeSession('demo', { prompt: 'fix', autoSubmit: true, action: 'extend' });
  assert.equal(none.opened.length, 0);
  assert.equal(none.launches.length, 1);
  assert.ok(!('workerAppendSystemPrompt' in none.launches[0].o.settings));
});

test('app:spawnCli passes both prompts for a change, and only a change', async () => {
  const h = harness();
  await h.spawn({ action: 'extend' });
  const s = h.opened[0].settings;
  assert.ok(s.appendSystemPrompt.includes('Current files'));
  assert.ok(s.workerAppendSystemPrompt && !s.workerAppendSystemPrompt.includes('Current files'));
  for (const action of ['build', 'build-tools', 'recreate-appmd']) {
    await h.spawn({ action });
    assert.ok(!('workerAppendSystemPrompt' in h.opened.at(-1).settings), action);
  }
});

test('app:spawnCli: the stamp turns lean when the owner picks Orchestrator, stays when Simple', async () => {
  const orch = harness({ openCliResult: (o) => ({ tabId: o.tabId, mode: 'orchestrator', engine: 'cli' }) });
  await orch.spawn({ action: 'extend', initialInput: 'a map route' });
  assert.deepEqual([inlinedOf(orch.dir).keys, inlinedOf(orch.dir).profile], [[], 'worker']);

  const simple = harness({ openCliResult: (o) => ({ tabId: o.tabId, mode: 'simple', engine: 'cli' }) });
  await simple.spawn({ action: 'extend', initialInput: 'a map route' });
  assert.ok(inlinedOf(simple.dir).keys.includes('maps') && inlinedOf(simple.dir).profile === undefined);
});

test('an older core without openCli never sees the lean key', async () => {
  const appsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-lean-old-'));
  dirs.push(appsDir);
  fs.mkdirSync(path.join(appsDir, 'demo'));
  fs.writeFileSync(path.join(appsDir, 'demo', 'manifest.json'), '{"name":"demo"}');
  fs.writeFileSync(path.join(appsDir, 'demo', 'routes.js'), '');
  const launches = [];
  apps.initSessions({ appsDir, proxyPort: 0, broadcaster: { broadcast() {} }, pendingQuestions: new Map(),
    cliSessionManager: { sessions: new Map(), list: () => [], get: () => null, launchSession: (t, o) => launches.push(o), onExit() {} } });
  await apps.handleMessage({ send() {} }, { type: 'app:spawnCli', name: 'demo', action: 'extend' }, { broadcast() {} });
  assert.equal(launches.length, 1);
  assert.ok(!('workerAppendSystemPrompt' in launches[0].settings));
});
