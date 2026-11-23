// An orchestrator on agy (neon; docs/agy-workers.md "Orchestrator on agy"),
// end to end against the fake agy (test/fixtures/fake-agy.js): the real
// session manager, the real orchestration with its router on a loopback port,
// the real hook script and the real orchestrator MCP server. The run's workers
// are stubs (no Claude is started); the MITM and the sign-in state are fakes.
// Nothing here reaches Google. Also the New CLI dialog's neon helpers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');

const DATA_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-orch-home-')));
process.env.VISTACLAIR_HOME = DATA_HOME;
process.env.GEMINI_API_KEY = 'must-not-reach-agy';
const BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-orch-bin-'));
const FAKE_BIN = path.join(BIN_DIR, 'agy');
fs.writeFileSync(FAKE_BIN, `#!/bin/sh\nexec '${process.execPath}' '${path.join(__dirname, 'fixtures', 'fake-agy.js')}' "$@"\n`, { mode: 0o755 });
process.env.VISTACLAIR_AGY_BIN = FAKE_BIN;

const express = require('express');
const { waitFor } = require('./wait-for');
const InteractionStore = require('../src/store');
const CliSessionManager = require('../src/cli-sessions');
const AgySession = require('../src/agy-session');
const { createOrchestration } = require('../src/orchestration');
const { createSessionControl } = require('../src/session-control');

const CORE = path.join(__dirname, '..');
const MCP_SDK = path.join(CORE, 'mcp-servers', 'integrated', 'node_modules', '@modelcontextprotocol', 'sdk');
const SKIP = !fs.existsSync(MCP_SDK) && 'MCP SDK not installed';
const cleanup = [() => fs.rmSync(BIN_DIR, { recursive: true, force: true }), () => fs.rmSync(DATA_HOME, { recursive: true, force: true })];
test.after(() => { for (const fn of cleanup.reverse()) { try { fn(); } catch {} } });

function tmp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function repo() {
  const r = tmp('agy-orch-repo-');
  const g = (...a) => execFileSync('git', ['-C', r, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(r, 'README.md'), 'x\n');
  g('add', '.');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return r;
}

function fakeMitm() {
  const m = new EventEmitter();
  m.interceptionEnabled = () => true;
  m.ensureStarted = async () => ({ port: 9 });
  m.registerTag = (id) => ({ proxyUrl: `http://${id}:s3cret@127.0.0.1:9` });
  m.revokeTag = () => {};
  m.bundlePath = () => path.join(DATA_HOME, 'agy-mitm', 'bundle.pem');
  m.setMainConversation = () => {};
  return m;
}

// Every session that is not agy (the run's workers, a Claude orchestrator):
// a stub in the real manager (no Claude starts).
function stubWorkers(mgr) {
  const real = mgr.launchSession.bind(mgr);
  mgr.launchSession = (tabId, opts) => {
    if (opts.settings?.engine === 'agy') return real(tabId, opts);
    const sessId = require('crypto').randomUUID();
    const s = {
      tabId, sessId, instanceId: `cli-${sessId}`, kind: 'sdk', running: true, status: 'running', busy: false, hidden: true,
      cwd: opts.cwd, title: opts.title, autoMemory: false, settings: { ...opts.settings }, submits: [],
      getSettings() { return { ...this.settings }; },
      updateSettings(x) { Object.assign(this.settings, x); },
      submit(text, o) { this.submits.push({ text, o }); return { ok: true }; },
      emitEvent() {}, kill() { this.running = false; }, write() {}, writeWhenReady() {},
    };
    mgr.sessions.set(tabId, s);
    return s;
  };
}

// A run whose orchestrator was picked as neon in the New CLI dialog.
async function harness(t, { scenario = ['noreport'], agy = 'signed-in', creds = { apiKey: true, subscription: true }, answers = { auth: 'API key', model: 'neon' }, refreshTimeoutMs } = {}) {
  const fakeDir = tmp('agy-orch-fake-');
  fs.writeFileSync(path.join(fakeDir, 'scenario.json'), JSON.stringify(scenario));
  process.env.FAKE_AGY_DIR = fakeDir;
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  let route = null;
  app.use('/api/orchestration', (q, s, n) => route(q, s, n));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const broadcasts = [];
  const listeners = [];
  const broadcaster = { broadcast: (m) => { broadcasts.push(m); for (const fn of listeners) fn(m); }, onBroadcast: (fn) => listeners.push(fn) };
  const store = new InteractionStore(100);
  const auth = new EventEmitter();
  const authReports = [];
  const agyState = { state: agy };
  auth.peek = () => (agyState.state ? { state: agyState.state } : null);
  const mgr = new CliSessionManager(null, broadcaster, store, {
    dashboardPort: port, agyMitm: fakeMitm(), agyAuthStatus: auth,
    reportAgyAuthFailure: (info) => { authReports.push(info); return 'sign-in-needed'; },
  });
  stubWorkers(mgr);
  const control = createSessionControl({ mgr, broadcaster, finalizeDelayMs: 5, interruptSettleMs: 5 });
  const pendingQuestions = new Map();
  const orch = createOrchestration({
    mgr, pendingQuestions, coreRoot: CORE, dataHome: tmp('agy-orch-dh-'), broadcaster, control,
    credentials: () => creds, models: () => [], pushDebounceMs: 20, relayFallbackMs: 40, agyAuthStatus: auth,
    ...(refreshTimeoutMs ? { refreshTimeoutMs } : {}),
  });
  route = orch.router();
  const cwd = repo();
  const opening = orch.openCli({ cwd, engine: 'sdk' });
  const ask = broadcasts.filter(m => m.type === 'ask:question').at(-1);
  const formData = ask?.forms?.[0]?.formData || null;
  if (ask) [...pendingQuestions.values()][0].resolve(Object.entries(answers).map(([id, answer]) => ({ id, question: 'x', answer })));
  const opened = await opening;
  const session = mgr.sessions.get(opened.tabId);
  const runId = session.getSettings().orchestration.runId;
  const post = (p, body) => fetch(`http://127.0.0.1:${port}/api/orchestration/${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(res => res.json());
  const runs = () => {
    try { return fs.readFileSync(path.join(fakeDir, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
  };
  const h = {
    mgr, orch, control, auth, agyState, authReports, broadcasts, fakeDir, cwd, port, post, runs, formData, opened, runId,
    run: () => orch.getRun(runId),
    session: () => [...mgr.sessions.values()].find(s => s instanceof AgySession && s.running) || null,
    stubs: () => [...mgr.sessions.values()].filter(s => !(s instanceof AgySession) && s.settings?.orchestration?.role === 'worker'),
    arg: (r, flag) => { const i = r.argv.indexOf(flag); return i >= 0 ? r.argv[i + 1] : null; },
    idleAfter: (n, what) => waitFor(() => {
      const s = h.session();
      return h.runs().length >= n && s && s.state === 'idle' && !s._turn;
    }, { timeoutMs: 20000, what: what || `${n} agy run(s), then idle` }),
    transcript: () => {
      const dir = h.session()?.sessionDir() || h.run().orchestratorDir;
      try { return fs.readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).ev); } catch { return []; }
    },
  };
  t.after(async () => {
    for (const s of mgr.sessions.values()) { try { s.kill('test'); } catch {} }
    await new Promise(r2 => setTimeout(r2, 50));
    server.closeAllConnections?.();
    await new Promise(r2 => server.close(r2));
  });
  return h;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('1. neon in the dialog gives an agy orchestrator: its role card, launch_cli and list_workers over MCP, the edit fence', { skip: SKIP }, async (t) => {
  const outsideNote = { name: 'turn1' };
  const h = await harness(t, { scenario: [outsideNote, 'noreport'] });
  // The dialog: neon next to the Claude models, with the agy state.
  assert.deepStrictEqual(h.formData.newCli.orchestratorModels.map(m => m.value), ['opus[1m]', 'fable[1m]'], 'the Claude models unchanged');
  assert.strictEqual(h.formData.newCli.agyOrchestrator.value, 'neon');
  assert.strictEqual(h.formData.newCli.agyOrchestrator.state, 'signed-in');
  assert.match(h.formData.newCli.agyOrchestrator.detail, /Antigravity, Google AI subscription/);
  // The answer: model neon, the billing for the Claude parts.
  assert.strictEqual(h.opened.model, 'neon');
  assert.strictEqual(h.opened.orchestratorEngine, 'agy');
  assert.strictEqual(h.opened.auth, 'apikey');
  const s = h.session();
  assert.ok(s, 'an AgySession orchestrator');
  const run = h.run();
  assert.strictEqual(run.orchestratorEngine, 'agy');
  assert.strictEqual(run.orchestratorModel, 'gemini-4-neon-medium');
  assert.strictEqual(run.engine, 'sdk', 'its workers are Agent SDK sessions');
  assert.strictEqual(run.auth, 'apikey', 'billed as the dialog said');
  assert.strictEqual(s.settings.model, 'gemini-4-neon-medium');
  assert.strictEqual(s.cwd, run.orchestratorDir, 'it runs in its session folder');
  assert.strictEqual(s.context.compactAt, 200000, 'its context budget makes the auto-refresh countable');

  // Turn 1: writes (the fence), then list_workers and launch_cli over MCP.
  const dir = run.orchestratorDir;
  const scen = [{
    name: 'turn1',
    writes: [{ path: path.join(h.cwd, 'README.md'), content: 'hacked\n' }, { path: 'TODO.md', content: '| id |\n' }, { path: path.join(run.runDir, 'x.md') }, { path: path.join(dir, 'other.md') }],
    mcp: [
      { tool: 'list_workers' },
      { tool: 'launch_cli', args: { title: 'helper', task: 'Write x.txt, then report done.', model: 'haiku', area: ['x.txt'] } },
      { tool: 'list_workers' },
    ],
  }, 'noreport'];
  fs.writeFileSync(path.join(h.fakeDir, 'scenario.json'), JSON.stringify(scen));
  s.submit('Plan the run.');
  await h.idleAfter(1);
  const [r1] = h.runs();
  // The role card at SessionStart, in agy's tool names, with the agy note.
  const card = r1.events.find(e => e.hook === 'SessionStart').answers[0].injectSteps[0].systemMessage.systemMessage;
  assert.match(card, /# Role: orchestrator/);
  assert.match(card, /## Running on agy/);
  assert.match(card, /mcp_orchestrator_launch_cli/);
  assert.doesNotMatch(card, /mcp__orchestrator__/);
  // The edit fence: only TODO.md / NOTES.md / ARCHIVE.md of its folder.
  const [readme, todo, inRunDir, other] = r1.writes;
  assert.strictEqual(readme.denied, true);
  assert.match(readme.reason, /does not edit project files/);
  assert.strictEqual(fs.readFileSync(path.join(h.cwd, 'README.md'), 'utf8'), 'x\n');
  assert.ok(!todo.denied, todo.reason);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'TODO.md'), 'utf8'), '| id |\n');
  assert.strictEqual(inRunDir.denied, true);
  assert.strictEqual(other.denied, true, 'not even another file of its folder');
  // MCP: every call answered by the real server.
  const [lw, launch, lw2] = r1.mcp;
  assert.ok(!lw.result.isError && !lw.result.error, JSON.stringify(lw.result));
  assert.ok(!launch.result.isError, JSON.stringify(launch.result));
  assert.match(launch.result.content[0].text, /w1-helper/);
  assert.match(lw2.result.content[0].text, /w1-helper/);
  const w = h.run().workers[0];
  assert.strictEqual(w.model, 'haiku');
  assert.notStrictEqual(w.engine, 'agy', 'a Claude worker');
  const stub = h.stubs()[0];
  assert.strictEqual(stub.settings.engine, 'sdk');
  assert.strictEqual(stub.settings.auth, 'apikey', 'the Claude worker carries the dialog\'s billing');
  // agy's config: in the session folder, every orchestrator tool eager; the
  // project checkout untouched.
  const mcp = JSON.parse(fs.readFileSync(path.join(dir, '.agents', 'mcp_config.json'), 'utf8'));
  for (const tool of ['launch_cli', 'list_workers', 'owner_items', 'resume_worker', 'close_worker', 'cancel_launch', 'stop_worker', 'end_run', 'SendMessage', 'ListAgents']) {
    assert.ok(mcp.mcpServers.orchestrator.tools[tool]?.eager, `${tool} eager`);
  }
  assert.ok(!fs.existsSync(path.join(h.cwd, '.agents')), 'no .agents in the project');
  assert.strictEqual(execFileSync('git', ['-C', h.cwd, 'status', '--porcelain'], { encoding: 'utf8' }), '');
  // The process: the subscription login, the orchestrator role, documented flags.
  assert.strictEqual(h.arg(r1, '--model'), 'gemini-4-neon-medium');
  assert.strictEqual(r1.env.VISTACLAIR_ORCH_ROLE, 'orchestrator');
  assert.strictEqual(r1.env.GEMINI_API_KEY, null);
  assert.strictEqual(r1.cwd, dir);

  // A worker event arrives as a new turn, on the same conversation.
  const rep = await h.post('report', { instanceId: stub.instanceId, status: 'blocked', summary: 'need the API shape', filesChanged: [], verified: '', open: 'the API shape' });
  assert.ok(!rep.error, rep.error);
  await waitFor(() => h.runs().some(r => /need the API shape/.test(h.arg(r, '-p') || '')), { timeoutMs: 20000, what: 'a turn with the worker event' });
  await h.idleAfter(2);
  const r2 = h.runs().find(r => /need the API shape/.test(h.arg(r, '-p') || ''));
  assert.match(h.arg(r2, '-p'), /^\[orchestration\] 1 worker event\(s\) pending/);
  assert.strictEqual(h.arg(r2, '--conversation'), s.conversationId);
  assert.ok(!r2.events.some(e => e.hook === 'SessionStart'));
});

test('2. after a resume the role card comes again at the first model call, with the recap', { skip: SKIP }, async (t) => {
  const h = await harness(t, { scenario: ['noreport', 'noreport'] });
  const s = h.session();
  s.submit('Start.');
  await h.idleAfter(1);
  const conv = s.conversationId;
  const sessId = s.sessId;
  s.kill('test');
  await waitFor(() => !h.session() && h.mgr.findSaved(sessId), { timeoutMs: 5000, what: 'the orchestrator saved' });
  const out = h.orch.resumeRun(h.runId);
  assert.strictEqual(out.fresh, false, 'its own conversation continues');
  await h.idleAfter(2);
  const r2 = h.runs()[1];
  assert.strictEqual(h.arg(r2, '--conversation'), conv);
  assert.ok(!r2.events.some(e => e.hook === 'SessionStart'), 'agy fires no SessionStart on a resume');
  const pre = r2.events.find(e => e.hook === 'PreInvocation');
  const injected = pre.answers[0].injectSteps[0].systemMessage.systemMessage;
  assert.match(injected, /# Role: orchestrator/);
  assert.match(injected, /mcp_orchestrator_launch_cli/);
  assert.match(h.arg(r2, '-p'), /orchestrat/i, 'the resume text and recap');
  // Only once: a later model call of the same spawn has no card.
  const r1 = h.runs()[0];
  assert.ok(!(r1.events.filter(e => e.hook === 'PreInvocation').some(e => /# Role: orchestrator/.test(JSON.stringify(e.answers)))), 'no card injection on a fresh conversation (SessionStart has it)');
});

test('3. the automatic-turn cap holds: no more than 5 in 10 min without a worker event or owner message', { skip: SKIP }, async (t) => {
  const h = await harness(t, { scenario: ['noreport'] });
  const s = h.session();
  const launched = await h.post('launch', { instanceId: s.instanceId, title: 'w', task: 'x', model: 'haiku', area: ['x'] });
  assert.ok(!launched.error, launched.error);
  // Platform events with no worker (the owner's limit changes) push turns.
  for (let i = 1; i <= 5; i++) {
    h.orch.setRunMaxWorkers(h.runId, i % 2 ? 4 : 5);
    await h.idleAfter(i, `automatic turn ${i}`);
  }
  h.orch.setRunMaxWorkers(h.runId, 3);
  await sleep(400);
  assert.strictEqual(h.runs().length, 5, 'the sixth automatic turn does not start');
  const run = h.run();
  assert.ok(run.agyTurns.held, 'held');
  const item = run.ownerItems.find(i => i.key === 'agy-turn-cap');
  assert.strictEqual(item?.state, 'open');
  assert.ok(h.transcript().some(e => e.platform?.kind === 'notice' && /holds/.test(e.platform.text)));
  assert.ok(run.events.some(e => e.seq > run.delivered), 'the event waits');
  // A message from an add-on is automatic too: queued, no turn.
  assert.strictEqual(h.orch.sendToSession(run.orchestrator, 'job done', { from: 'apps' }).how, 'queued');
  await sleep(200);
  assert.strictEqual(h.runs().length, 5);
  // A worker event lifts the hold: the next turn carries what waited.
  const stub = h.stubs()[0];
  await h.post('report', { instanceId: stub.instanceId, status: 'failed', summary: 'it broke', filesChanged: [], verified: '', open: '' });
  await h.idleAfter(6, 'the turn after the hold');
  const r6 = h.runs()[5];
  assert.match(h.arg(r6, '-p'), /it broke/);
  assert.match(h.arg(r6, '-p'), /job done/);
  assert.strictEqual(h.run().ownerItems.find(i => i.key === 'agy-turn-cap').state, 'done');
  assert.ok(!h.run().agyTurns.held);
});

test('4. quota and sign-in: the orchestrator blocks, the owner hears it, nothing retries by itself', { skip: SKIP }, async (t) => {
  const h = await harness(t, { scenario: ['quota', 'noreport'] });
  const s = h.session();
  s.submit('Start.');
  await h.idleAfter(1);
  let run = h.run();
  assert.strictEqual(run.orchestratorBlocked?.kind, 'quota');
  assert.match(run.orchestratorBlocked.reason, /agy quota exhausted \(resets /);
  const item = run.ownerItems.find(i => i.key === 'agy-orchestrator-quota');
  assert.strictEqual(item?.state, 'open');
  assert.ok(item.blocking);
  assert.strictEqual(h.orch.describeRunById(h.runId).orchestratorBlocked.kind, 'quota');
  // Events and messages wait: no automatic turn while blocked.
  h.orch.setRunMaxWorkers(h.runId, 4);
  assert.strictEqual(h.orch.sendToSession(run.orchestrator, 'ping', { from: 'apps' }).how, 'queued');
  await sleep(300);
  assert.strictEqual(h.runs().length, 1, 'no retry');
  // The owner's message starts the next turn, with what waited.
  h.orch.ownerSubmit(s, 'Go on.');
  await h.idleAfter(2);
  assert.match(h.arg(h.runs()[1], '-p'), /ping/);
  run = h.run();
  assert.strictEqual(run.orchestratorBlocked, undefined);
  assert.strictEqual(run.ownerItems.find(i => i.key === 'agy-orchestrator-quota').state, 'done');
});

test('5. a signed-out agy: the orchestrator reports the sign-in and shows "agy sign-in needed"', { skip: SKIP }, async (t) => {
  const h = await harness(t, { scenario: ['auth'] });
  h.session().submit('Start.');
  await h.idleAfter(1);
  assert.strictEqual(h.authReports.length, 1);
  assert.strictEqual(h.run().orchestratorBlocked.kind, 'auth');
  assert.ok(h.transcript().some(e => e.platform?.kind === 'notice' && /agy sign-in needed/.test(e.platform.text)));
  assert.match(h.run().ownerItems.find(i => i.key === 'agy-orchestrator-auth').what, /Sign in to Antigravity/);
});

test('6. the dialog: shown for neon when agy is known even with one credential; not without agy; a simple CLI never gets neon', { skip: SKIP }, async (t) => {
  // One Claude credential and agy signed out: the dialog still comes (for neon).
  const h = await harness(t, { creds: { apiKey: false, subscription: true }, agy: 'signed-out', answers: { model: 'opus[1m]' } });
  assert.strictEqual(h.formData.newCli.agyOrchestrator.state, 'signed-out');
  assert.strictEqual(h.opened.model, 'opus[1m]');
  assert.strictEqual(h.session(), null, 'a Claude orchestrator (no AgySession)');
  // Nothing probed yet (no agy state): as before, nothing to ask.
  h.agyState.state = null;
  const asks = h.broadcasts.filter(m => m.type === 'ask:question').length;
  await h.orch.openCli({ cwd: h.cwd, engine: 'sdk' });
  assert.strictEqual(h.broadcasts.filter(m => m.type === 'ask:question').length, asks);
  // A simple session named neon by a caller stays a Claude session.
  const simple = await h.orch.openCli({ cwd: h.cwd, engine: 'sdk', mode: 'simple', auth: 'subscription', model: 'neon' });
  assert.strictEqual(simple.model, undefined);
  assert.notStrictEqual(h.mgr.sessions.get(simple.tabId).settings.engine, 'agy');
  assert.doesNotMatch(String(h.mgr.sessions.get(simple.tabId).settings.model), /neon|gemini/);
});

test('8. past 80% of its context budget the agy orchestrator is refreshed: notes, then a fresh agy conversation from the seed', { skip: SKIP }, async (t) => {
  const h = await harness(t, {
    // The pause protocol may ask once more (a Stop block) before the swap.
    scenario: ['noreport', { name: 'pausing', writes: [{ path: 'NOTES.md', content: '# notes\n\n## Resume\n### Workers\nnone\n### Decisions\nnone\n### Suspicions / hypotheses\nnone\n### Ruled out\nnone\n### Promises to the owner\nnone\n### Open owner questions\nnone\n### Next steps\nwait for w1\n' }], text: 'PAUSED' }, 'noreport'],
    refreshTimeoutMs: 3000,
  });
  const first = h.session();
  first.submit('Start.');
  await h.idleAfter(1);
  // agy's token count (B1 / the stream's usage) past AUTO_REFRESH_AT of 200k.
  first.context = { ...first.context, tokens: 170000 };
  first._emitStatus();
  const freshRun = () => h.runs().find(r => /^\[vistaclair resume\] You are a fresh orchestrator/.test(h.arg(r, '-p') || ''));
  await waitFor(() => { const s = h.session(); return s && s !== first && freshRun() && s.state === 'idle' && !s._turn; }, { timeoutMs: 20000, what: 'the fresh orchestrator\'s first turn' });
  const pausing = h.runs()[1];
  const fresh = freshRun();
  assert.match(h.arg(pausing, '-p'), /refreshing you/);
  assert.strictEqual(h.arg(pausing, '--conversation'), first.conversationId);
  assert.strictEqual(h.arg(fresh, '--conversation'), null, 'a new agy conversation');
  assert.ok(fresh.events.some(e => e.hook === 'SessionStart'), 'with the role card');
  assert.match(h.arg(fresh, '-p'), /RESTART\.md/);
  const next = h.session();
  assert.strictEqual(next.cwd, h.run().orchestratorDir);
  assert.strictEqual(next.settings.engine, 'agy');
  assert.strictEqual(h.run().refreshes, 1);
  assert.match(fs.readFileSync(path.join(h.run().orchestratorDir, 'RESTART.md'), 'utf8'), /wait for w1/);
});

test('9. a blank final step text (as real agy sends it): the panel gets the result text as the reply, once', { skip: SKIP }, async (t) => {
  const h = await harness(t, { scenario: [{ name: 'blank', stepText: '\n', text: '# Role: orchestrator; 0 workers.' }, { name: 'shown', text: 'shown once' }] });
  const s = h.session();
  s.submit('Check.');
  await h.idleAfter(1);
  const texts = () => h.transcript().filter(e => e.sdk?.type === 'assistant' && e.sdk.message.content[0].type === 'text').map(e => e.sdk.message.content[0].text);
  assert.deepStrictEqual(texts(), ['# Role: orchestrator; 0 workers.']);
  s.submit('Again.');
  await h.idleAfter(2);
  assert.deepStrictEqual(texts(), ['# Role: orchestrator; 0 workers.', 'shown once'], 'a shown answer is not repeated');
});

test('10. run-wide model and billing switches leave the agy orchestrator on neon and the Google subscription', { skip: SKIP }, async (t) => {
  const h = await harness(t);
  const s = h.session();
  const model = s.getSettings().model;
  assert.ok(/neon/.test(model), model);
  const m = await h.orch.setRunModel(h.runId, 'sonnet');
  assert.deepStrictEqual(m.failed, []);
  assert.ok(!m.switched.includes(s.getSettings().name), 'the agy orchestrator is no target');
  assert.strictEqual(s.getSettings().model, model);
  assert.strictEqual(h.run().orchestratorModel, model, 'a refresh still starts on neon');
  assert.strictEqual(h.run().model, 'sonnet', 'Claude workers launched later take it');
  const a = await h.orch.setRunAuth(h.runId, 'subscription');
  assert.deepStrictEqual(a.failed, []);
  assert.strictEqual(a.sessions, 0);
  assert.strictEqual(s.getSettings().auth, undefined);
  assert.strictEqual(s.getSettings().engine, 'agy');
});

// --- public/new-cli.js (no DOM: its pure helpers) ---

function dialogApi() {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(CORE, 'public', 'new-cli.js'), 'utf8'), ctx);
  return ctx.window.newCliDialog;
}

test('7. new-cli.js: neon is offered after the Claude models; only signed-in agy lets it start; the answer carries neon and the Claude billing', () => {
  const d = dialogApi();
  const nc = {
    orchestratorModels: [{ value: 'opus[1m]', label: 'Opus' }, { value: 'fable[1m]', label: 'Fable' }],
    agyOrchestrator: { value: 'neon', label: 'Neon', detail: 'Gemini 4 Neon · Antigravity, Google AI subscription', state: 'signed-out' },
  };
  const opts = JSON.parse(JSON.stringify(d.orchestratorOptions(nc)));
  assert.deepStrictEqual(opts.map(o => o.value), ['opus[1m]', 'fable[1m]', 'neon']);
  assert.strictEqual(opts[2].engine, 'agy');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(d.orchestratorOptions({ orchestratorModels: nc.orchestratorModels }).map(o => o.value))), ['opus[1m]', 'fable[1m]'], 'no agy offer, no neon');
  assert.strictEqual(d.agyBlock('signed-in'), null);
  for (const st of ['signed-out', 'unknown', null]) assert.strictEqual(d.agyBlock(st).signIn, true, `${st}: blocked, with the sign-in button`);
  for (const st of ['keyring-locked', 'not-installed']) {
    assert.ok(d.agyBlock(st), `${st} blocks`);
    assert.strictEqual(d.agyBlock(st).signIn, false);
  }
  const labels = { mode: { simple: 'Simple CLI', orchestrator: 'Orchestrator CLI' }, auth: { apikey: 'API key', subscription: 'Claude subscription' } };
  const answer = JSON.parse(JSON.stringify(d.answerOf({ mode: 'orchestrator', engine: 'sdk', auth: 'apikey', model: 'neon', map: { sonnet: 'gpt-x' } }, labels)));
  assert.deepStrictEqual(answer.map(a => [a.id, a.answer]), [
    ['mode', 'Orchestrator CLI'], ['auth', 'API key'], ['model', 'neon'], ['modelMap', { sonnet: 'gpt-x' }],
  ]);
});
