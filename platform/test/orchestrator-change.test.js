// app:spawnCli through core's ctx.openCli: the Change asks Simple / Orchestrator
// and the engine (no mode or engine passed), keeps the app's prompt, settings
// file and changeApp stamp as the run's base, and puts the run in the app's
// .vistaclair/. A cancelled choice launches nothing; tools edits and APP.md
// recreates are always simple and CLI unless msg names an engine; an older core
// without openCli falls back to launchSession. The APP.md follow-up after the
// session ends runs on that session's engine.
//
// launchChangeSession (cli.edit, the Telegram bot, change requests) opens the
// Agent SDK panel without asking anyone at a form: an orchestrator with the
// request auto-submitted, a simple session for the APP.md pre-flight, a hidden
// launch or a resume. Billing is the Claude subscription; on an API key alone
// the owner confirms the costs first, and a no opens nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const apps = require('../src/apps/index');
const { SESSION_STAMPS } = require('../src/apps/app-change-requests');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function harness({ openCliResult = (o) => ({ tabId: o.tabId, mode: o.mode || 'orchestrator', engine: o.engine, auth: o.auth || null }), withOpenCli = true, credential = 'subscription', withResolveAuth = true } = {}) {
  const appsDir = fs.mkdtempSync(path.join(process.env.VISTACLAIR_FIXTURE_TMP || os.tmpdir(), 'vc-orch-apps-'));
  dirs.push(appsDir);
  fs.mkdirSync(path.join(appsDir, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(appsDir, 'demo', 'manifest.json'), JSON.stringify({ name: 'demo', description: 'x' }));
  fs.writeFileSync(path.join(appsDir, 'demo', 'routes.js'), 'module.exports = () => {};\n');
  fs.writeFileSync(path.join(appsDir, 'demo', 'APP.md'), '# demo\n');

  const state = { appsDir, opened: [], launches: [], sent: [], broadcasts: [], exitCbs: new Map(), pendingQuestions: new Map() };
  const csm = {
    sessions: new Map(),
    list: () => [],
    get: () => null,
    launchSession: (tabId, o) => state.launches.push({ tabId, o }),
    onExit: (tabId, cb) => state.exitCbs.set(tabId, cb),
  };
  const openCli = async (o) => { state.opened.push(o); return openCliResult(o); };
  apps.initSessions({
    appsDir, proxyPort: 0, broadcaster: { broadcast: (m) => state.broadcasts.push(m) }, cliSessionManager: csm,
    pendingQuestions: state.pendingQuestions,
    ...(withOpenCli ? { openCli } : {}),
    // core's credential decision: 'subscription' | 'api-key' | null
    ...(withResolveAuth ? { resolveAuth: () => ({ credential, key: '' }) } : {}),
  });
  const ws = { send: (s) => state.sent.push(JSON.parse(s)) };
  state.spawn = (msg) => apps.handleMessage(ws, { type: 'app:spawnCli', name: 'demo', cols: 80, rows: 24, ...msg }, { broadcast: () => {} });
  return state;
}

test('Change asks through openCli and hands the app context over as the run base', async () => {
  const h = harness();
  await h.spawn({ action: 'extend' });
  assert.equal(h.opened.length, 1);
  const o = h.opened[0];
  assert.equal(o.tabId, 'app-demo');
  assert.equal(o.mode, undefined, 'no mode: core asks the user');
  assert.equal(o.cwd, path.join(h.appsDir, 'demo'));
  assert.equal(o.runsDir, path.join(h.appsDir, 'demo', '.vistaclair', 'orchestrator'));
  assert.equal(o.isolation, 'none');
  assert.equal(o.settings[SESSION_STAMPS.app], 'demo');
  assert.ok(o.settings.appendSystemPrompt.length > 0);
  assert.equal(h.launches.length, 0, 'openCli launches, not Pro');
  assert.ok(h.sent.some(m => m.type === 'app:cliSpawned' && m.tabId === 'app-demo'));
});

test('a cancelled choice launches nothing and says so', async () => {
  const h = harness({ openCliResult: () => ({ cancelled: true }) });
  await h.spawn({ action: 'extend' });
  assert.ok(h.sent.some(m => m.type === 'app:cliCancelled' && m.appName === 'demo'));
  assert.ok(!h.sent.some(m => m.type === 'app:cliSpawned'));
});

test('a tools edit is always simple', async () => {
  const h = harness({ openCliResult: (o) => ({ tabId: o.tabId, mode: 'simple' }) });
  await h.spawn({ action: 'build-tools' });
  assert.equal(h.opened[0].mode, 'simple');
  assert.equal(h.opened[0].tabId, 'app-demo-tools');
});

test('without openCli (older core) the Change launches simple, directly', async () => {
  const h = harness({ withOpenCli: false });
  await h.spawn({ action: 'extend' });
  assert.equal(h.launches.length, 1);
  assert.equal(h.launches[0].tabId, 'app-demo');
  assert.ok(h.sent.some(m => m.type === 'app:cliSpawned'));
});

test('the engine passes through for a change or a build; unset, core asks', async () => {
  const h = harness();
  await h.spawn({ action: 'extend', engine: 'sdk' });
  await h.spawn({ action: 'build', engine: 'cli' });
  await h.spawn({ action: 'extend' });
  assert.deepEqual(h.opened.map(o => o.engine), ['sdk', 'cli', undefined]);
  assert.ok(h.opened.every(o => o.settings.engine === undefined), 'the engine is openCli\'s to put in the settings');
});

test('a tools edit and an APP.md recreate run on the CLI unless msg names an engine', async () => {
  const h = harness({ openCliResult: (o) => ({ tabId: o.tabId, mode: 'simple', engine: o.engine }) });
  await h.spawn({ action: 'build-tools' });
  await h.spawn({ action: 'recreate-appmd' });
  await h.spawn({ action: 'build-tools', engine: 'sdk' });
  assert.deepEqual(h.opened.map(o => [o.mode, o.engine]), [['simple', 'cli'], ['simple', 'cli'], ['simple', 'sdk']]);
});

test('without openCli (older core) msg.engine is ignored', async () => {
  const h = harness({ withOpenCli: false });
  await h.spawn({ action: 'extend', engine: 'sdk' });
  assert.equal(h.launches[0].o.engine, undefined);
  assert.equal(h.launches[0].o.settings.engine, undefined);
});

// The session ends without an APP.md: the recreate follow-up launches in the
// same tab, on the ended session's engine (and an SDK one's billing), after
// core's exit handling is done.
async function endWithoutAppMd(h) {
  fs.rmSync(path.join(h.appsDir, 'demo', 'APP.md'));
  h.exitCbs.get('app-demo')('app-demo');
  assert.equal(h.launches.length, 0, 'deferred past core\'s exit handling');
  await new Promise(r => setImmediate(r));
  assert.equal(h.launches.length, 1);
  assert.equal(h.launches[0].tabId, 'app-demo');
  assert.ok(/APP\.md/.test(h.launches[0].o.prompt));
  return h.launches[0].o.settings;
}

test('the APP.md follow-up relaunches on the engine and billing the ended session ran', async () => {
  const sdk = harness({ openCliResult: (o) => ({ tabId: o.tabId, mode: 'simple', engine: 'sdk', auth: 'subscription' }) });
  await sdk.spawn({ action: 'extend' });
  const st = await endWithoutAppMd(sdk);
  assert.deepEqual([st.engine, st.auth], ['sdk', 'subscription']);

  const cli = harness({ openCliResult: (o) => ({ tabId: o.tabId, mode: 'orchestrator', engine: 'cli' }) });
  await cli.spawn({ action: 'extend' });
  const cst = await endWithoutAppMd(cli);
  assert.deepEqual([cst.engine, cst.auth], ['cli', undefined]);

  const old = harness({ openCliResult: (o) => ({ tabId: o.tabId, mode: 'simple' }) });   // openCli without engines
  await old.spawn({ action: 'extend' });
  assert.equal((await endWithoutAppMd(old)).engine, 'cli');
});

// --- launchChangeSession: the sessions Pro opens on its own ------------------

const tick = () => new Promise(r => setImmediate(r));

// The owner's answer to the API-key confirm, the way the dashboard sends it.
function answerBilling(h, label) {
  const [[askId, entry]] = [...h.pendingQuestions];
  assert.match(askId, /^pro-billing-/);
  entry.resolve(label === null
    ? [{ id: '_cancelled', question: '', answer: 'cancelled' }]
    : [{ id: 'billing', answer: label }]);
}

test('a change session opens as an SDK orchestrator, auto-submitted, on the subscription', async () => {
  const h = harness();
  const cr = { id: 'cr-1', from: 'alpha', to: 'demo', chain: ['alpha', 'demo'], interface: { kind: 'tool', name: 't' }, depth: 1, maxDepth: 1 };
  const res = await apps.launchChangeSession('demo', { prompt: 'add t', autoSubmit: true, action: 'extend', changeRequest: cr });
  assert.deepEqual([res.tabId, res.engine, res.auth, res.cancelled], ['app-demo', 'sdk', 'subscription', undefined]);
  assert.equal(h.pendingQuestions.size, 0, 'nothing is asked');
  assert.equal(h.launches.length, 0, 'openCli launches, not Pro');
  const [o] = h.opened;
  assert.deepEqual([o.tabId, o.mode, o.engine, o.auth, o.autoSubmit, o.prompt], ['app-demo', 'orchestrator', 'sdk', 'subscription', true, 'add t']);
  assert.equal(o.cwd, path.join(h.appsDir, 'demo'));
  assert.equal(o.runsDir, path.join(h.appsDir, 'demo', '.vistaclair', 'orchestrator'));
  assert.equal(o.isolation, 'none');
  assert.equal(o.settings[SESSION_STAMPS.app], 'demo');
  assert.equal(o.settings.sessionsRoot, path.join(h.appsDir, 'demo', '.vistaclair', 'sessions'));
  assert.equal(o.settings.settingsFile, path.join(h.appsDir, 'demo', '.vistaclair', 'hooks.json'));
  assert.match(o.settings.appendSystemPrompt, /## Requested by another app/);
  assert.match(o.settings.appendSystemPrompt, /If this session is an orchestrator/);
  assert.equal(o.settings.engine, undefined, 'the engine is openCli\'s to put in the settings');
  assert.ok(h.exitCbs.has('app-demo'), 'the APP.md check is armed');
});

test('on an API key alone the owner confirms the costs first; yes opens on the key', async () => {
  const h = harness({ credential: 'api-key' });
  const p = apps.launchChangeSession('demo', { prompt: 'x', autoSubmit: true });
  await tick();
  assert.equal(h.opened.length, 0, 'nothing opens before the answer');
  const ask = h.broadcasts.find(m => m.type === 'ask:question');
  assert.ok(ask && /^pro-billing-/.test(ask.askId));
  assert.equal(ask.tabId, 'app-demo');
  assert.match(ask.forms[0].questions[0].question, /billed per token to the Anthropic API key/);
  assert.ok(h.pendingQuestions.get(ask.askId).message, 'replayed to a dashboard that reloads');
  answerBilling(h, 'Open it on the API key');
  const res = await p;
  assert.equal(res.auth, 'apikey');
  assert.deepEqual([h.opened[0].engine, h.opened[0].auth, h.opened[0].mode], ['sdk', 'apikey', 'orchestrator']);
  assert.equal(h.pendingQuestions.size, 0);
  assert.ok(h.broadcasts.some(m => m.type === 'ask:answered' && m.askId === ask.askId));
});

test('a no, or a cancelled confirm, opens nothing', async () => {
  for (const answer of ['Do not open', null]) {
    const h = harness({ credential: 'api-key' });
    const p = apps.launchChangeSession('demo', { prompt: 'x', autoSubmit: true });
    await tick();
    answerBilling(h, answer);
    assert.deepEqual(await p, { tabId: 'app-demo', cancelled: true });
    assert.equal(h.opened.length + h.launches.length, 0);
  }
});

test('the APP.md pre-flight is a simple SDK session, and the change follows it as an orchestrator', async () => {
  const h = harness();
  fs.rmSync(path.join(h.appsDir, 'demo', 'APP.md'));
  const res = await apps.launchChangeSession('demo', { prompt: 'x', autoSubmit: true });
  assert.equal(res.hidden, false);
  assert.equal(h.opened.length, 1);
  assert.deepEqual([h.opened[0].mode, h.opened[0].engine, h.opened[0].auth, h.opened[0].autoSubmit], ['simple', 'sdk', 'subscription', true]);
  assert.match(h.opened[0].prompt, /create APP\.md/);
  fs.writeFileSync(path.join(h.appsDir, 'demo', 'APP.md'), '# demo\n');
  h.exitCbs.get('app-demo')('app-demo');
  await tick(); await tick();
  assert.equal(h.opened.length, 2);
  assert.deepEqual([h.opened[1].mode, h.opened[1].prompt, h.opened[1].auth], ['orchestrator', 'x', 'subscription']);
});

test('a resume (the asker relaunch) is a simple SDK session on its transcript; a hidden launch is simple', async () => {
  const h = harness();
  await apps.launchChangeSession('demo', { prompt: 'outcome', autoSubmit: true, action: 'extend', resumeSessionId: 'abc' });
  assert.deepEqual([h.opened[0].mode, h.opened[0].engine], ['simple', 'sdk']);
  assert.deepEqual(h.opened[0].spawnOpts, { resumeSessionId: 'abc' });
  const res = await apps.launchChangeSession('demo', { prompt: 'fix', autoSubmit: true, hidden: true });
  assert.deepEqual([h.opened[1].mode, h.opened[1].hidden, res.hidden], ['simple', true, true]);
});

test('no SDK path (no openCli, no resolveAuth, no credential) opens the CLI terminal as before', async () => {
  for (const over of [{ withOpenCli: false }, { withResolveAuth: false }, { credential: null }]) {
    const h = harness(over);
    const res = await apps.launchChangeSession('demo', { prompt: 'x', autoSubmit: true, resumeSessionId: 'abc' });
    assert.equal(h.opened.length, 0);
    assert.equal(h.launches.length, 1);
    assert.equal(h.launches[0].tabId, 'app-demo');
    assert.equal(h.launches[0].o.settings.engine, 'cli');
    assert.equal(h.launches[0].o.settings[SESSION_STAMPS.app], 'demo');
    assert.deepEqual(h.launches[0].o.spawnOpts, { resumeSessionId: 'abc' });
    assert.equal(res.engine, 'cli');
  }
});

test('cli.edit answers with the tab, or with an error when the owner declined', async () => {
  const h = harness({ credential: 'api-key' });
  const ws = { send: (s) => h.sent.push(JSON.parse(s)) };
  const p = apps.handleMessage(ws, { type: 'app:bridge', name: 'demo', method: 'cli.edit', id: 7, params: { prompt: 'x' } }, { broadcast: () => {} });
  await tick();
  answerBilling(h, 'Do not open');
  await p;
  const r = h.sent.find(m => m.type === 'app:bridge:response' && m.id === 7);
  assert.match(r.error, /declined/);
  assert.ok(!h.sent.some(m => m.type === 'app:cliSpawned'));

  const ok = harness();
  const ws2 = { send: (s) => ok.sent.push(JSON.parse(s)) };
  await apps.handleMessage(ws2, { type: 'app:bridge', name: 'demo', method: 'cli.edit', id: 8, params: { prompt: 'x' } }, { broadcast: () => {} });
  assert.deepEqual(ok.sent.find(m => m.id === 8).result, { tabId: 'app-demo' });
  assert.equal(ok.opened[0].mode, 'orchestrator');
});
