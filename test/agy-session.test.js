// agy workers (src/agy-session.js, docs/agy-workers.md) end to end against a
// fake agy (test/fixtures/fake-agy.js): the real session manager, the real
// orchestration with its router on a loopback port, the real hook script and
// the real orchestrator MCP server. Only the orchestrator's own session is a
// stub (no Claude is started) and the MITM / sign-in state are fakes. Nothing
// here reaches Google.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');

const DATA_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-session-home-')));
process.env.VISTACLAIR_HOME = DATA_HOME;
process.env.GEMINI_API_KEY = 'must-not-reach-agy';
process.env.GOOGLE_APPLICATION_CREDENTIALS = '/nope.json';
const BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bin-'));
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
const cleanup = [];
test.after(() => { for (const fn of cleanup.reverse()) { try { fn(); } catch {} } });

function tmp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function repo() {
  const r = tmp('agy-repo-');
  const g = (...a) => execFileSync('git', ['-C', r, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(r, 'README.md'), 'x\n');
  g('add', '.');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return r;
}

function fakeMitm() {
  const m = new EventEmitter();
  m.enabled = true;
  m.tags = new Map();
  m.interceptionEnabled = () => m.enabled;
  m.ensureStarted = async () => ({ port: 9 });
  m.registerTag = (id) => { m.tags.set(id, 's3cret'); return { proxyUrl: `http://${id}:s3cret@127.0.0.1:9` }; };
  m.revokeTag = (id) => { m.tags.delete(id); };
  m.bundlePath = () => path.join(DATA_HOME, 'agy-mitm', 'bundle.pem');
  m.setMainConversation = (id, conv) => { m.main = [id, conv]; };
  return m;
}

// The orchestrator's own session: a stub in the real manager.
function stubOrchestrator(mgr) {
  const real = mgr.launchSession.bind(mgr);
  mgr.launchSession = (tabId, opts) => {
    if (opts.settings?.orchestration?.role !== 'orchestrator') return real(tabId, opts);
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

async function harness(t, { scenario = ['report'], intercept = true } = {}) {
  const fakeDir = tmp('agy-fake-');
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
  const broadcaster = { broadcast: (m) => broadcasts.push(m) };
  const store = new InteractionStore(100);
  const mitm = fakeMitm();
  mitm.enabled = intercept;
  const auth = new EventEmitter();
  const authReports = [];
  const mgr = new CliSessionManager(null, broadcaster, store, {
    dashboardPort: port, agyMitm: mitm, agyAuthStatus: auth,
    reportAgyAuthFailure: (info) => { authReports.push(info); return 'sign-in-needed'; },
  });
  stubOrchestrator(mgr);
  const control = createSessionControl({ mgr, broadcaster, finalizeDelayMs: 5, interruptSettleMs: 5 });
  const orch = createOrchestration({
    mgr, pendingQuestions: new Map(), coreRoot: CORE, dataHome: tmp('agy-orch-home-'), broadcaster, control,
    credentials: () => ({ apiKey: true, subscription: false }), models: () => [], pushDebounceMs: 20, relayFallbackMs: 40,
  });
  route = orch.router();
  const cwd = repo();
  const r = await orch.openCli({ cwd, mode: 'orchestrator', engine: 'cli' });
  const orchSession = mgr.sessions.get(r.tabId);
  const runId = orchSession.settings.orchestration.runId;
  const post = (p, body) => fetch(`http://127.0.0.1:${port}/api/orchestration/${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(res => res.json());
  const runs = () => {
    try { return fs.readFileSync(path.join(fakeDir, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
  };
  const h = {
    mgr, orch, control, mitm, auth, authReports, broadcasts, fakeDir, cwd, orchSession, port, post, runs,
    run: () => orch.getRun(runId),
    launch: (args) => post('launch', { instanceId: orchSession.instanceId, ...args }),
    worker: () => orch.getRun(runId).workers[0],
    session: () => [...mgr.sessions.values()].find(s => s instanceof AgySession),
    arg: (run, flag) => { const i = run.argv.indexOf(flag); return i >= 0 ? run.argv[i + 1] : null; },
  };
  t.after(async () => {
    for (const s of mgr.sessions.values()) { try { s.kill('test'); } catch {} }
    await new Promise(r2 => setTimeout(r2, 50));
    server.closeAllConnections?.();
    await new Promise(r2 => server.close(r2));
  });
  return h;
}

const idleWithReport = (h, status = 'done') => waitFor(() => {
  const s = h.session();
  return s && s.state === 'idle' && h.worker()?.lastReport?.status === status && !s._turn;
}, { timeoutMs: 20000, what: `worker idle with a ${status} report` });

test('1. a report lands in the orchestration and the worker goes idle; the policy fences writes', { skip: SKIP }, async (t) => {
  const h = await harness(t, { scenario: ['report'] });
  const res = await h.launch({ title: 'agy one', task: 'Write agy-made.txt, then report done.', model: 'neon', area: ['agy-made.txt'] });
  assert.ok(!res.error, res.error);
  await idleWithReport(h);
  const [run] = h.runs();
  assert.strictEqual(h.runs().length, 1, 'one agy process, no nudge after the report');
  assert.ok(!run.report.isError);
  assert.match(run.report.content[0].text, /"ok": true/);
  assert.strictEqual(h.worker().lastReport.summary, 'fake agy did it');
  // PreToolUse: outside denied (not written), inside allowed (written).
  assert.strictEqual(run.outside.denied, true);
  assert.match(run.outside.reason, /outside your worktree/);
  assert.ok(!fs.existsSync(path.join(path.dirname(run.cwd), 'outside-agy.txt')));
  assert.strictEqual(fs.readFileSync(path.join(h.worker().worktree.path, 'agy-made.txt'), 'utf8'), 'made by fake agy\n');
  // The role card arrives at SessionStart, in agy's tool names.
  const ss = run.events.find(e => e.hook === 'SessionStart').answers[0];
  const card = ss.injectSteps[0].systemMessage.systemMessage;
  assert.match(card, /mcp_orchestrator_report/);
  assert.doesNotMatch(card, /mcp__orchestrator__report/);
  // The process: documented flags only; the env is the subscription login's.
  assert.strictEqual(h.arg(run, '--output-format'), 'stream-json');
  assert.ok(h.arg(run, '--settings').endsWith('.agy-settings.json'));
  assert.strictEqual(h.arg(run, '--conversation'), null);
  assert.strictEqual(run.env.GEMINI_API_KEY, null);
  assert.strictEqual(run.env.GOOGLE_APPLICATION_CREDENTIALS, null);
  assert.strictEqual(run.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
  assert.strictEqual(run.env.ANTHROPIC_API_KEY, null);
  assert.strictEqual(run.env.VISTACLAIR_ORCH_ENGINE, 'agy');
  assert.ok(run.env.hasSessionToken);
  // The MCP config carries no secret and strips the MITM env for its children.
  const mcp = fs.readFileSync(path.join(run.cwd, '.agents', 'mcp_config.json'), 'utf8');
  assert.doesNotMatch(mcp, /vcs_|SESSION_TOKEN|AUTH_TOKEN/);
  assert.match(mcp, /"HTTPS_PROXY"/);
  assert.match(mcp, /"SSL_CERT_FILE"/);
  // The SDK-shaped transcript the panel reads.
  const lines = fs.readFileSync(path.join(h.worker().sessionDir, 'transcript.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).ev);
  assert.ok(lines.some(e => e.sdk?.type === 'system' && e.sdk.subtype === 'init'));
  assert.ok(lines.some(e => e.sdk?.type === 'assistant' && e.sdk.message.content[0].type === 'tool_use' && e.sdk.message.content[0].name === 'write_file'));
  assert.ok(lines.some(e => e.sdk?.type === 'result' && e.sdk.total_cost_usd === 0));
});

test('2. the second turn continues the conversation with --conversation <id from init>', { skip: SKIP }, async (t) => {
  const h = await harness(t, { scenario: ['report', 'report'] });
  await h.launch({ title: 'agy two', task: 'Report done.', model: 'neon' });
  await idleWithReport(h);
  const conv = h.session().conversationId;
  assert.match(conv, /^[0-9a-f-]{36}$/);
  assert.deepStrictEqual(h.mitm.main, [h.session().instanceId, conv]);
  h.session().submit('One more thing: report again.');
  await waitFor(() => h.runs().length === 2 && h.session().state === 'idle' && !h.session()._turn, { timeoutMs: 20000, what: 'second turn' });
  const second = h.runs()[1];
  assert.strictEqual(h.arg(second, '--conversation'), conv);
  assert.ok(!second.events.some(e => e.hook === 'SessionStart'), 'no SessionStart on a resume');
  assert.match(h.arg(second, '-p'), /^One more thing/);
});

test('3. a message sent while busy reaches agy as a PreInvocation injectSteps', { skip: SKIP }, async (t) => {
  const h = await harness(t, { scenario: ['wait', 'report'] });
  await h.launch({ title: 'agy three', task: 'Wait, then report.', model: 'neon' });
  await waitFor(() => fs.existsSync(path.join(h.fakeDir, 'waiting')), { timeoutMs: 20000, what: 'fake agy waiting' });
  assert.strictEqual(h.session().busy, true);
  const sent = await h.post('send-message', { instanceId: h.orchSession.instanceId, to: h.worker().name, message: 'KIWI-7 is the word' });
  assert.ok(!sent.error, sent.error);
  fs.writeFileSync(path.join(h.fakeDir, 'release'), '1');
  await idleWithReport(h);
  const first = h.runs()[0];
  const pre = first.events.filter(e => e.hook === 'PreInvocation');
  assert.strictEqual(pre.length, 2);
  assert.deepStrictEqual(pre[0].answers[0], {}, 'nothing to inject before the message');
  const injected = pre[1].answers[0].injectSteps[0].systemMessage.systemMessage;
  assert.match(injected, /KIWI-7 is the word/);
  // Delivered once: the next turn (the nudge) does not repeat it.
  assert.doesNotMatch(h.arg(h.runs()[1], '-p'), /KIWI-7/);
});

test('4. a turn with no report gets exactly three nudges, then the idle event', { skip: SKIP }, async (t) => {
  const h = await harness(t, { scenario: ['noreport'] });
  await h.launch({ title: 'agy four', task: 'Do nothing useful.', model: 'neon' });
  await waitFor(() => h.run().events?.some(e => e.kind === 'idle'), { timeoutMs: 30000, what: 'idle event' });
  await new Promise(r => setTimeout(r, 300));
  const runs = h.runs();
  assert.strictEqual(runs.length, 4, 'the turn and three nudges');
  for (const r of runs.slice(1)) {
    assert.match(h.arg(r, '-p'), /^Before ending this turn, report to the orchestrator/);
    assert.ok(h.arg(r, '--conversation'), 'a nudge continues the conversation');
  }
  assert.strictEqual(h.session().state, 'idle');
  assert.match(h.run().events.find(e => e.kind === 'idle').text, /went idle without reporting/);
});

test('5. a signed-out agy reports the auth failure, blocks the worker, and re-runs the turn after sign-in', { skip: SKIP }, async (t) => {
  const h = await harness(t, { scenario: ['auth', 'report'] });
  await h.launch({ title: 'agy five', task: 'Report done.', model: 'neon' });
  await waitFor(() => h.worker()?.lastReport?.status === 'blocked', { timeoutMs: 20000, what: 'blocked' });
  assert.strictEqual(h.authReports.length, 1);
  assert.match(h.authReports[0].stderr, /authentication required/);
  assert.match(h.worker().lastReport.summary, /agy sign-in needed/);
  assert.strictEqual(h.session().blocked.kind, 'auth');
  assert.ok(h.run().events.some(e => e.kind === 'report' && /blocked/.test(e.text)));
  await new Promise(r => setTimeout(r, 300));
  assert.strictEqual(h.runs().length, 1, 'no retry before the sign-in');
  h.auth.emit('change', { state: 'signed-out', signedIn: false });
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(h.runs().length, 1, 'a change that is not a sign-in does nothing');
  h.auth.emit('change', { state: 'signed-in', signedIn: true });
  await idleWithReport(h);
  const [a, b] = h.runs();
  assert.strictEqual(h.arg(b, '-p'), h.arg(a, '-p'), 'the same turn re-runs');
  h.auth.emit('change', { state: 'signed-in', signedIn: true });
  await new Promise(r => setTimeout(r, 200));
  assert.strictEqual(h.runs().length, 2, 'one re-run per failure');
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('6. stop and close kill the turn\'s process group (its tool children too) and remove the .agents files', { skip: SKIP }, async (t) => {
  const h = await harness(t, { scenario: ['sleep'] });
  await h.launch({ title: 'agy six', task: 'Sleep.', model: 'neon' });
  const sleeping = path.join(h.fakeDir, 'sleeping');
  await waitFor(() => fs.existsSync(sleeping), { timeoutMs: 20000, what: 'fake agy sleeping' });
  const child1 = parseInt(fs.readFileSync(path.join(h.fakeDir, 'child.pid'), 'utf8'), 10);
  assert.ok(alive(child1));
  const wt = h.worker().worktree.path;
  assert.ok(fs.existsSync(path.join(wt, '.agents', 'hooks.json')));
  // stop_worker: SIGINT; agy exits, its `sleep` would outlive it but is killed.
  const stopped = await h.post('stop-worker', { instanceId: h.orchSession.instanceId, worker: h.worker().name });
  assert.ok(!stopped.error, stopped.error);
  await waitFor(() => !h.session()._turn && !alive(child1), { timeoutMs: 10000, what: 'turn and child gone' });
  assert.strictEqual(h.runs().length, 1, 'a stopped turn is not nudged');
  // close (closeQuiet → kill) during a turn: the group goes, the config too.
  fs.rmSync(sleeping);
  h.session().submit('Sleep again.');
  await waitFor(() => fs.existsSync(sleeping), { timeoutMs: 20000, what: 'second sleep' });
  const child2 = parseInt(fs.readFileSync(path.join(h.fakeDir, 'child.pid'), 'utf8'), 10);
  const agyPid = h.session()._turn.pid;
  const tabId = h.session().tabId;
  const policyFile = h.session()._files.policyFile;
  h.mgr.closeQuiet(tabId, 'close_worker');
  await waitFor(() => !alive(child2) && !alive(agyPid), { timeoutMs: 10000, what: 'group killed' });
  assert.ok(!fs.existsSync(path.join(wt, '.agents', 'hooks.json')));
  assert.ok(!fs.existsSync(path.join(wt, '.agents', 'mcp_config.json')));
  assert.ok(!fs.existsSync(policyFile));
  assert.strictEqual(h.mitm.tags.size, 0, 'the MITM tag is revoked');
});

test('7. the .agents files are in the repo\'s info/exclude and never show in git status', { skip: SKIP }, async (t) => {
  const h = await harness(t, { scenario: ['report'] });
  await h.launch({ title: 'agy seven', task: 'Report done.', model: 'neon' });
  await idleWithReport(h);
  const wt = h.worker().worktree.path;
  const exclude = path.resolve(wt, execFileSync('git', ['-C', wt, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim());
  const text = fs.readFileSync(exclude, 'utf8');
  assert.match(text, /^\/\.agents\/hooks\.json$/m);
  assert.match(text, /^\/\.agents\/mcp_config\.json$/m);
  const status = execFileSync('git', ['-C', wt, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
  assert.doesNotMatch(status, /\.agents/);
  assert.match(status, /agy-made\.txt/);
});

test('8. launch_cli({ model: "neon" }) gives an agy worker on gemini-4-neon-medium; bad agy launches are refused', { skip: SKIP }, async (t) => {
  const h = await harness(t, { scenario: ['report'] });
  const res = await h.launch({ title: 'agy neon', task: 'Report done.', model: 'neon' });
  assert.ok(!res.error, res.error);
  assert.strictEqual(res.model, 'gemini-4-neon-medium');
  assert.strictEqual(h.worker().engine, 'agy');
  assert.strictEqual(h.worker().model, 'gemini-4-neon-medium');
  assert.ok(h.session() instanceof AgySession);
  assert.strictEqual(h.session().getSettings().engine, 'agy');
  await idleWithReport(h);
  assert.strictEqual(h.arg(h.runs()[0], '--model'), 'gemini-4-neon-medium');
  const refused = async (args, re) => {
    const r = await h.launch({ title: 'bad', task: 'x', ...args });
    assert.match(String(r.error), re, JSON.stringify(args));
  };
  await refused({ model: 'neon', isolation: 'none' }, /isolation "worktree"/);
  await refused({ engine: 'agy', model: 'claude-sonnet-4-6' }, /only Google/);
  await refused({ engine: 'agy', model: 'gpt-5' }, /only Google/);
  await refused({ model: 'gemini-3.8-flash-low' }, /model must be one of/);
  await refused({ engine: 'codex' }, /engine must be "agy"/);
  await refused({ model: 'neon', host: 'elsewhere' }, /remote host/);
  const flash = await h.launch({ title: 'agy flash', task: 'Report done.', engine: 'agy', model: 'gemini-3.8-flash-low' });
  assert.strictEqual(flash.model, 'gemini-3.8-flash-low');
});

test('9. an exhausted quota leaves the worker blocked, with no retry and no nudge', { skip: SKIP }, async (t) => {
  const h = await harness(t, { scenario: ['quota', 'report'] });
  await h.launch({ title: 'agy quota', task: 'Report done.', model: 'neon' });
  await waitFor(() => h.worker()?.lastReport?.status === 'blocked', { timeoutMs: 20000, what: 'blocked' });
  assert.match(h.worker().lastReport.summary, /^agy quota exhausted \(resets \d{4}-\d\d-\d\dT/);
  assert.strictEqual(h.session().blocked.kind, 'quota');
  assert.ok(h.run().events.some(e => e.kind === 'report' && /quota exhausted/.test(e.text)));
  assert.strictEqual(h.authReports.length, 0);
  await new Promise(r => setTimeout(r, 500));
  assert.strictEqual(h.runs().length, 1, 'no retry, no nudge');
  assert.strictEqual(h.session().state, 'idle');
  // The MITM's view of a 429 counts as well.
  const s = h.session();
  s._turn = { quota: null };
  h.mitm.emit('cloudcode-response', { instanceId: s.instanceId, status: 429, path: '/v1internal:streamGenerateContent', json: { error: { status: 'RESOURCE_EXHAUSTED' } } });
  assert.deepStrictEqual(s._turn.quota, { resetsAt: null });
  s._turn = null;
});

test('10. with interception off the worker runs with no MITM tag and no proxy env', { skip: SKIP }, async (t) => {
  const h = await harness(t, { scenario: ['report'], intercept: false });
  await h.launch({ title: 'agy direct', task: 'Report done.', model: 'neon' });
  await idleWithReport(h);
  const [run] = h.runs();
  assert.strictEqual(run.env.HTTPS_PROXY, null);
  assert.strictEqual(run.env.SSL_CERT_FILE, null);
  assert.strictEqual(h.mitm.tags.size, 0);
  // Interception on: the tag and the bundle.
  h.mitm.enabled = true;
  h.session().submit('Again, through the proxy.');
  await waitFor(() => h.runs().length === 2 && !h.session()._turn, { timeoutMs: 20000, what: 'second turn' });
  const second = h.runs()[1];
  assert.strictEqual(second.env.HTTPS_PROXY, `http://${h.session().instanceId}:s3cret@127.0.0.1:9`);
  assert.strictEqual(second.env.SSL_CERT_FILE, h.mitm.bundlePath());
});

test('resolveAgyModel and the landing refusal of committed agy config', async () => {
  const { resolveAgyModel } = AgySession;
  assert.strictEqual(resolveAgyModel('neon'), 'gemini-4-neon-medium');
  assert.strictEqual(resolveAgyModel('gemini-3.8-flash-low'), 'gemini-3.8-flash-low');
  assert.throws(() => resolveAgyModel('claude-opus-5-5'), /only Google/);
  assert.throws(() => resolveAgyModel('opus'), /neon/);
  const landing = require('../src/worktree-landing');
  const r = repo();
  const g = (...a) => execFileSync('git', ['-C', r, ...a], { stdio: 'pipe' });
  const wt = path.join(tmp('agy-wt-'), 'w');
  g('worktree', 'add', '-q', '-b', 'feat', wt, 'HEAD');
  fs.mkdirSync(path.join(wt, '.agents'));
  fs.writeFileSync(path.join(wt, '.agents', 'hooks.json'), '{}');
  execFileSync('git', ['-C', wt, 'add', '-f', '.agents/hooks.json'], { stdio: 'pipe' });
  execFileSync('git', ['-C', wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'oops'], { stdio: 'pipe' });
  const out = await landing.land({ repo: r, worktree: wt, branch: 'feat', base: 'main' });
  assert.strictEqual(out.outcome, 'error');
  assert.match(out.message, /agy session config/);
});
