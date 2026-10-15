// Orchestrator CLI sessions (src/orchestration.js): the Simple/Orchestrator ask
// behind openCli, run setup, worker launch guards, the hook decisions (caps,
// guards, report enforcement, event delivery) and worktree cleanup. A fake
// session manager stands in for the PTYs — nothing here spawns `claude`.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const CORE = path.join(__dirname, '..');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function tmpDir(prefix = 'vistaclair-orch-') {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

function fakeMgr() {
  const sessions = new Map();
  const launches = [];
  const writes = [];
  const submits = [];        // { tabId, data, opts }
  const emitted = [];        // SDK panel events: { tabId, ev }
  let history = [];          // newest first, like cli-sessions
  const closed = [];
  let seq = 0;
  const mk = (tabId) => ({
    tabId, instanceId: `cli-${tabId}`, running: false, busy: false, sessId: null, cwd: null, title: null, settings: {},
    getSettings() { return { ...this.settings }; },
    updateSettings(s) { Object.assign(this.settings, s); },
    writeWhenReady(data) { writes.push({ tabId, data }); },
    write(data) { writes.push({ tabId, data }); },
    // CliSession.submit: the text, then the CR.
    submit(data, opts) { submits.push({ tabId, data, opts }); writes.push({ tabId, data }); writes.push({ tabId, data: '\r' }); },
    // SdkSession.seedCost: a resumed member's carried-over cost.
    seedCost(usd) { this.seeded = usd; },
  });
  const mgr = {
    sessions, launches, writes, closed, submits, emitted,
    get history() { return history; },
    nextTabId: () => `tab-t-${++seq}`,
    get: (tabId) => sessions.get(tabId) || null,
    getOrCreate(tabId) {
      if (!sessions.has(tabId)) sessions.set(tabId, mk(tabId));
      return sessions.get(tabId);
    },
    getByInstanceId(id) {
      for (const s of sessions.values()) if (s.instanceId === id) return s;
      return null;
    },
    spawn(tabId, cwd, cols, rows, { resumeSessionId } = {}) {
      const s = mgr.getOrCreate(tabId);
      s.running = true;
      s.cwd = cwd;
      s.sessId = resumeSessionId || crypto.randomUUID();
      mgr.saveToHistory({ sessId: s.sessId, cwd, title: s.title, settings: s.getSettings() });
    },
    launchSession(tabId, opts) {
      const s = mgr.getOrCreate(tabId);
      if (opts.title !== undefined) s.title = opts.title;
      s.updateSettings(opts.settings || {});
      if (opts.hidden != null) s.hidden = opts.hidden;
      // An SDK session (src/sdk-session.js) has a panel: events land there.
      if (s.settings.engine === 'sdk') {
        s.kind = 'sdk';
        s.emitEvent = (ev) => emitted.push({ tabId, ev });
      }
      mgr.spawn(tabId, opts.cwd, opts.cols, opts.rows);
      launches.push({ tabId, opts });
      if (opts.prompt && opts.autoSubmit) writes.push({ tabId, data: opts.prompt });
      return s;
    },
    saveToHistory(e) {
      const prev = history.find(h => h.id === e.sessId);
      history = history.filter(h => h.id !== e.sessId);
      const f = e.flags || {};
      history.unshift({ id: e.sessId, cwd: e.cwd, title: e.title, settings: e.settings || {}, startedAt: prev?.startedAt || Date.now(), ...(f.paused ? { paused: true } : {}), ...(f.interrupted ? { interrupted: true } : {}) });
    },
    listSaved: () => history,
    findSaved: (id) => history.find(h => h.id === id) || null,
    forgetSaved(id) { history = history.filter(h => h.id !== id); },
    deleteSavedSession(id) { history = history.filter(h => h.id !== id); },
    lost: new Set(),        // sessIds whose transcript was deleted
    transcriptExists: (cwd, id) => !mgr.lost.has(id),
    closeQuiet(tabId) { const s = sessions.get(tabId); sessions.delete(tabId); if (s) { s.running = false; closed.push(tabId); } },
    broadcastTabs() {},
    noteSessionState() {},
  };
  return mgr;
}

function setup(extra = {}) {
  const mgr = fakeMgr();
  const broadcasts = [];
  const pendingQuestions = new Map();
  const broadcaster = { broadcast: (m) => broadcasts.push(m) };
  const { createOrchestration } = require('../src/orchestration');
  const { createSessionControl } = require('../src/session-control');
  const control = createSessionControl({ mgr, broadcaster, finalizeDelayMs: 5, interruptSettleMs: 5 });
  const orch = createOrchestration({
    mgr, pendingQuestions, coreRoot: CORE, dataHome: tmpDir('vistaclair-orch-home-'),
    broadcaster, control,
    // An API key and no subscription: an SDK session's billing is never asked.
    credentials: () => ({ apiKey: true, subscription: false }),
    pushDebounceMs: 20,
    relayFallbackMs: 40,
    ...extra,
  });
  return { mgr, orch, control, broadcasts, pendingQuestions };
}

function answer(pendingQuestions, value) {
  const [entry] = pendingQuestions.values();
  assert.ok(entry, 'a question is pending');
  entry.resolve(value === null
    ? [{ id: '_cancelled', question: '', answer: 'cancelled' }]
    : [{ id: 'mode', question: 'x', answer: value }]);
}

async function openOrchestrator(t, opts = {}) {
  const ctx = setup();
  const cwd = opts.cwd || tmpDir();
  const r = await ctx.orch.openCli({ cwd, mode: 'orchestrator', engine: 'cli', ...opts });
  const orchSession = ctx.mgr.sessions.get(r.tabId);
  const stamp = orchSession.settings.orchestration;
  return { ...ctx, cwd, r, orchSession, stamp, run: () => ctx.orch.getRun(stamp.runId) };
}

const hook = (orch, session, input) => orch.handleHook(session.instanceId, input);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

test('openCli without a mode asks, and the answer decides the launch', async () => {
  const { mgr, orch, pendingQuestions, broadcasts } = setup();
  const cwd = tmpDir();

  const simple = orch.openCli({ cwd });
  const ask = broadcasts.find(m => m.type === 'ask:question');
  assert.ok(ask, 'the ask is broadcast');
  // The dashboard builds the form from formData.questions (askFormBuildHTML).
  assert.deepStrictEqual(ask.forms[0].formData.questions.map(q => q.options.map(o => o.label)), [['Simple CLI', 'Orchestrator CLI'], ['CLI terminal', 'Agent SDK panel']]);
  // One credential: the SDK option names it instead of asking.
  assert.match(ask.forms[0].formData.questions[1].options[1].description, /billed to the Anthropic API key \(the only Claude credential configured\)/);
  assert.deepStrictEqual([...pendingQuestions.values()][0].message, ask, 'the entry keeps its broadcast for replay on reconnect');
  answer(pendingQuestions, 'Simple CLI');
  const s = await simple;
  assert.strictEqual(s.mode, 'simple');
  assert.strictEqual(mgr.sessions.get(s.tabId).settings.orchestration, undefined);
  assert.strictEqual(pendingQuestions.size, 0, 'the answered question is gone');

  const cancelled = orch.openCli({ cwd });
  answer(pendingQuestions, null);
  assert.deepStrictEqual(await cancelled, { cancelled: true });
  assert.strictEqual(mgr.launches.length, 1, 'cancel launches nothing');

  const o = orch.openCli({ cwd });
  const dup = await orch.openCli({ cwd });
  assert.strictEqual(dup.duplicate, true, 'a second open of the same target joins the pending ask');
  answer(pendingQuestions, 'Orchestrator CLI');
  const res = await o;
  assert.strictEqual(res.mode, 'orchestrator');
  const st = mgr.sessions.get(res.tabId).settings;
  assert.strictEqual(st.orchestration.role, 'orchestrator');
  assert.match(st.name, /^orch-[0-9a-f]{6}$/);
  assert.match(st.appendSystemPrompt, /You are the ORCHESTRATOR/);
  // Its TODO lives in its session folder, not in the run directory.
  assert.ok(st.appendSystemPrompt.includes(path.join(st.sessionDir, 'TODO.md')));
  assert.strictEqual(path.basename(st.sessionDir), st.name);
  // A worker's report is trusted: the card never asks for re-verification.
  assert.match(st.appendSystemPrompt, /"done" report is trusted/);
  assert.ok(!/have a worker \(or a separate reviewer worker\) run the tests/.test(st.appendSystemPrompt));
});

test('openCli with a mode and an engine never asks', async () => {
  const { orch, pendingQuestions, broadcasts } = setup();
  const r = await orch.openCli({ cwd: tmpDir(), mode: 'simple', engine: 'cli' });
  assert.strictEqual(r.mode, 'simple');
  assert.strictEqual(r.engine, 'cli');
  assert.strictEqual(pendingQuestions.size, 0);
  assert.ok(!broadcasts.some(m => m.type === 'ask:question'));
});

test('openCli asks only what is open: the engine when the mode is given, the mode when the engine is', async () => {
  const { mgr, orch, pendingQuestions, broadcasts } = setup();
  const cwd = tmpDir();
  const reply = (answers) => [...pendingQuestions.values()][0].resolve(Object.entries(answers).map(([id, answer]) => ({ id, question: 'x', answer })));
  const lastAsk = () => broadcasts.filter(m => m.type === 'ask:question').at(-1);

  const a = orch.openCli({ cwd, mode: 'simple' });
  assert.deepStrictEqual(lastAsk().forms[0].formData.questions.map(q => q.id), ['engine']);
  reply({ engine: 'Agent SDK panel' });
  const ra = await a;
  assert.deepStrictEqual({ mode: ra.mode, engine: ra.engine }, { mode: 'simple', engine: 'sdk' });
  assert.strictEqual(mgr.sessions.get(ra.tabId).settings.engine, 'sdk');

  const b = orch.openCli({ cwd, engine: 'sdk' });
  assert.deepStrictEqual(lastAsk().forms[0].formData.questions.map(q => q.id), ['mode']);
  reply({ mode: 'Orchestrator CLI' });
  const rb = await b;
  assert.deepStrictEqual({ mode: rb.mode, engine: rb.engine }, { mode: 'orchestrator', engine: 'sdk' });
  assert.strictEqual(orch.getRun(mgr.sessions.get(rb.tabId).settings.orchestration.runId).engine, 'sdk');

  // Both open: one form, both answers.
  const c = orch.openCli({ cwd });
  assert.deepStrictEqual(lastAsk().forms[0].formData.questions.map(q => q.id), ['mode', 'engine']);
  reply({ mode: 'Simple CLI', engine: 'CLI terminal' });
  assert.strictEqual((await c).engine, 'cli');
  // The engine can also come in the caller's settings (Pro passes settings).
  const d = await orch.openCli({ cwd, mode: 'simple', settings: { engine: 'sdk' } });
  assert.strictEqual(d.engine, 'sdk');
  assert.strictEqual(d.auth, 'apikey', 'the one credential is pinned without a form');
});

test('openCli: an SDK session\'s billing is asked only when both credentials exist; a run\'s workers inherit it', async () => {
  let creds = { apiKey: true, subscription: true };
  const { mgr, orch, pendingQuestions, broadcasts } = setup({ credentials: () => creds });
  const cwd = tmpDir();
  const reply = (answers) => [...pendingQuestions.values()][0].resolve(Object.entries(answers).map(([id, answer]) => ({ id, question: 'x', answer })));
  const lastAsk = () => broadcasts.filter(m => m.type === 'ask:question').at(-1);

  // The engine open: billing is in the same form, shown only for the SDK panel.
  const a = orch.openCli({ cwd });
  const qs = lastAsk().forms[0].formData.questions;
  assert.deepStrictEqual(qs.map(q => q.id), ['mode', 'engine', 'auth']);
  assert.deepStrictEqual(qs[2].showIf, { questionId: 'engine', equals: 'Agent SDK panel' });
  assert.deepStrictEqual(qs[2].options.map(o => o.label), ['API key', 'Claude subscription']);
  reply({ mode: 'Orchestrator CLI', engine: 'Agent SDK panel', auth: 'Claude subscription' });
  const ra = await a;
  assert.deepStrictEqual({ engine: ra.engine, auth: ra.auth }, { engine: 'sdk', auth: 'subscription' });
  const orchSession = mgr.sessions.get(ra.tabId);
  assert.strictEqual(orchSession.settings.auth, 'subscription');
  assert.strictEqual(orch.getRun(orchSession.settings.orchestration.runId).auth, 'subscription');
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  assert.strictEqual(mgr.sessions.get(w.tabId).settings.auth, 'subscription', 'a worker inherits the run\'s billing');

  // A CLI terminal carries no billing, whatever the form held.
  const b = orch.openCli({ cwd });
  reply({ mode: 'Simple CLI', engine: 'CLI terminal', auth: 'Claude subscription' });
  const rb = await b;
  assert.strictEqual(rb.auth, null);
  assert.strictEqual(mgr.sessions.get(rb.tabId).settings.auth, undefined);

  // Mode and SDK engine given: a form with billing alone; an unanswered one is the API key.
  const c = orch.openCli({ cwd, mode: 'simple', engine: 'sdk' });
  assert.deepStrictEqual(lastAsk().forms[0].formData.questions.map(q => q.id), ['auth']);
  assert.strictEqual(lastAsk().forms[0].formData.questions[0].showIf, undefined);
  reply({});
  assert.strictEqual((await c).auth, 'apikey');

  // Billing given, or a CLI terminal: never asked.
  const asks = broadcasts.filter(m => m.type === 'ask:question').length;
  assert.strictEqual((await orch.openCli({ cwd, mode: 'simple', engine: 'sdk', auth: 'subscription' })).auth, 'subscription');
  assert.strictEqual((await orch.openCli({ cwd, mode: 'simple', engine: 'cli' })).auth, null);
  assert.strictEqual(broadcasts.filter(m => m.type === 'ask:question').length, asks);

  // Only the subscription: the form names it; the session is pinned to it.
  creds = { apiKey: false, subscription: true };
  const d = orch.openCli({ cwd, engine: 'sdk' });
  assert.deepStrictEqual(lastAsk().forms[0].formData.questions.map(q => q.id), ['mode']);
  assert.match(lastAsk().forms[0].formData.description, /Claude subscription \(the only Claude credential configured\)/);
  reply({ mode: 'Simple CLI' });
  const rd = await d;
  assert.strictEqual(mgr.sessions.get(rd.tabId).settings.auth, 'subscription');
});

test('an orchestrator run keeps the caller prompt, stamps and hooks, and adds its own', async (t) => {
  const cwd = tmpDir();
  const baseFile = path.join(cwd, 'hooks.json');
  fs.writeFileSync(baseFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read|Bash', hooks: [{ type: 'command', command: 'ledger' }] }] } }));
  const { orchSession, stamp, mgr, orch } = await openOrchestrator(t, {
    cwd, runsDir: path.join(cwd, '.vistaclair', 'orchestrator'), isolation: 'none',
    settings: { appendSystemPrompt: 'BASE PROMPT', settingsFile: baseFile, changeApp: 'demo' },
  });
  const st = orchSession.settings;
  assert.ok(st.appendSystemPrompt.startsWith('BASE PROMPT'));
  assert.strictEqual(st.changeApp, 'demo');
  assert.ok(stamp.runDir.startsWith(path.join(cwd, '.vistaclair', 'orchestrator')));
  assert.ok(fs.existsSync(path.join(st.sessionDir, 'TODO.md')));
  assert.ok(fs.existsSync(path.join(st.sessionDir, 'NOTES.md')));

  const settings = JSON.parse(fs.readFileSync(st.settingsFile, 'utf8'));
  assert.strictEqual(settings.crossSessionInbound, 'accept');
  assert.strictEqual(settings.hooks.PreToolUse[0].hooks[0].command, 'ledger', 'the base hook is kept, first');
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop']) {
    assert.ok(settings.hooks[ev].some(h => h.hooks[0].command.includes('orchestration-hook.js')), ev);
  }

  // Workers inherit the base prompt and stamps (Pro's changeApp), not the role.
  const w = orch.launchWorker(orchSession.instanceId, { title: 'Fix login', task: 'do it' });
  const ws = mgr.sessions.get(w.tabId).settings;
  assert.strictEqual(ws.changeApp, 'demo');
  assert.ok(ws.appendSystemPrompt.startsWith('BASE PROMPT'));
  assert.match(ws.appendSystemPrompt, /You are a WORKER CLI launched by the orchestrator `orch-/);
  assert.ok(!/You are the ORCHESTRATOR/.test(ws.appendSystemPrompt));
  // The card overrides the base prompt's user-facing and project-wide steps.
  assert.match(ws.appendSystemPrompt, /tell the session to ask the user, ask `orch-[0-9a-f]{6}` instead/);
  assert.match(st.appendSystemPrompt, /that is workers' work: put it in a brief/);
  assert.strictEqual(ws.orchestration.role, 'worker');
  assert.match(ws.name, new RegExp(`^${st.name}-w1-fix-login$`));
  assert.deepStrictEqual(Object.keys(ws.agents), ['coder', 'explorer']);
  assert.strictEqual(ws.agents.coder.model, 'opus');
  assert.strictEqual(ws.agents.explorer.model, 'sonnet');
  assert.strictEqual(mgr.launches.at(-1).opts.autoSubmit, true);
  assert.strictEqual(mgr.launches.at(-1).opts.prompt, 'do it');

  // launch_cli `model`: the worker runs on it (kept for a fresh relaunch); anything else is refused.
  const h = orch.launchWorker(orchSession.instanceId, { title: 'Docs', task: 'x', model: 'haiku' });
  assert.strictEqual(mgr.sessions.get(h.tabId).settings.model, 'haiku');
  assert.strictEqual(orch.listWorkers(orchSession.instanceId).workers.find(x => x.name === h.worker).model, 'haiku');
  assert.throws(() => orch.launchWorker(orchSession.instanceId, { title: 'bad', task: 'x', model: 'gpt' }), /model must be one of fable, opus, sonnet, haiku/);
});

test('launch_cli guards: orchestrator only, at most 3 running, cwd inside the root', async (t) => {
  const { orch, orchSession, mgr, cwd } = await openOrchestrator(t, { isolation: 'none' });
  const ids = [1, 2, 3].map(i => orch.launchWorker(orchSession.instanceId, { title: `t${i}`, task: 'x' }));
  assert.throws(() => orch.launchWorker(orchSession.instanceId, { title: 't4', task: 'x' }), /3 workers are running/);
  mgr.sessions.get(ids[0].tabId).running = false;
  assert.doesNotThrow(() => orch.launchWorker(orchSession.instanceId, { title: 't4', task: 'x' }), 'an exited worker frees its slot');

  assert.throws(() => orch.launchWorker(mgr.sessions.get(ids[1].tabId).instanceId, { title: 'w', task: 'x' }), /only an orchestrator/);
  mgr.sessions.get(ids[1].tabId).running = false;
  assert.throws(() => orch.launchWorker(orchSession.instanceId, { title: 'out', task: 'x', cwd: path.dirname(cwd) }), /inside the run root/);
});

test('subagent cap, Workflow ban and the orchestrator edit guard', async (t) => {
  const { orch, orchSession, stamp } = await openOrchestrator(t, { isolation: 'none' });
  const pre = (tool, tool_input = {}) => hook(orch, orchSession, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input, cwd: '/' });

  for (let i = 0; i < 3; i++) assert.deepStrictEqual(pre('Agent'), {});
  assert.strictEqual(pre('Agent').exitCode, 2, 'the 4th running subagent is denied');
  hook(orch, orchSession, { hook_event_name: 'SubagentStop', agent_id: 'a1' });
  assert.deepStrictEqual(pre('Agent'), {}, 'a finished subagent frees its slot');
  hook(orch, orchSession, { hook_event_name: 'SessionStart', source: 'resume' });
  assert.deepStrictEqual(pre('Agent'), {}, 'a resume resets the counter');

  assert.strictEqual(pre('Workflow').exitCode, 2);
  assert.strictEqual(pre('Write', { file_path: '/etc/project/file.js' }).exitCode, 2);
  assert.deepStrictEqual(pre('Edit', { file_path: path.join(stamp.runDir, 'TODO.md') }), {});
});

test('a worker must report before it stops; an unreported stop becomes an idle event', async (t) => {
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none' });
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  const wSession = mgr.sessions.get(w.tabId);
  const stop = (extra = {}) => hook(orch, wSession, { hook_event_name: 'Stop', last_assistant_message: 'I am finished', ...extra });

  hook(orch, wSession, { hook_event_name: 'UserPromptSubmit' });
  assert.strictEqual(stop({ background_tasks: [{ id: 'x' }] }).stdout, undefined, 'background work running: not idle');
  const nudge = JSON.parse(stop().stdout);
  assert.strictEqual(nudge.decision, 'block');
  assert.match(nudge.reason, /report to the orchestrator/);
  assert.deepStrictEqual(stop({ stop_hook_active: true }), {});
  assert.strictEqual(run().events.at(-1).kind, 'idle');

  // A message to a sibling worker is not a report; one to the orchestrator is.
  hook(orch, wSession, { hook_event_name: 'UserPromptSubmit' });
  hook(orch, wSession, { hook_event_name: 'PostToolUse', tool_name: 'SendMessage', tool_input: { to: `${orchSession.settings.name}-w2-other` } });
  assert.strictEqual(JSON.parse(stop().stdout).decision, 'block');
  hook(orch, wSession, { hook_event_name: 'UserPromptSubmit' });
  hook(orch, wSession, { hook_event_name: 'PostToolUse', tool_name: 'SendMessage', tool_input: { to: orchSession.settings.name } });
  assert.deepStrictEqual(stop(), {});
});

test('events reach a busy orchestrator through its hooks and wake an idle one', async (t) => {
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none' });
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  const wSession = mgr.sessions.get(w.tabId);

  // Busy: the report is attached to its next tool result, then not again.
  hook(orch, orchSession, { hook_event_name: 'UserPromptSubmit' });
  orch.report(wSession.instanceId, { status: 'done', summary: 'login fixed', filesChanged: ['a.js'] });
  const post = JSON.parse(hook(orch, orchSession, { hook_event_name: 'PostToolUse', tool_name: 'Read' }).stdout);
  assert.match(post.hookSpecificOutput.additionalContext, /reported done: login fixed/);
  assert.deepStrictEqual(hook(orch, orchSession, { hook_event_name: 'PostToolUse', tool_name: 'Read' }), {});
  assert.deepStrictEqual(hook(orch, orchSession, { hook_event_name: 'Stop' }), {}, 'nothing pending: it may go idle');
  assert.strictEqual(run().busy, false);

  // Idle: an exit is typed into its tab as a one-line notice, once.
  orch.onSessionExit(w.tabId, wSession);
  await wait(60);
  const typed = mgr.writes.filter(x => x.tabId === orchSession.tabId);
  assert.strictEqual(typed.length, 2);
  assert.match(typed[0].data, /\[orchestration\] 1 worker event/);
  assert.strictEqual(typed[1].data, '\r');
  const ups = JSON.parse(hook(orch, orchSession, { hook_event_name: 'UserPromptSubmit' }).stdout);
  assert.match(ups.hookSpecificOutput.additionalContext, /\[exited\]/);

  // An event during a turn that would end: Stop blocks with it.
  orch.report(wSession.instanceId, { status: 'failed', summary: 'tests red' });
  const stop = JSON.parse(hook(orch, orchSession, { hook_event_name: 'Stop' }).stdout);
  assert.strictEqual(stop.decision, 'block');
  assert.match(stop.reason, /tests red/);
});

test('compaction and resume re-inject the role and the TODO', async (t) => {
  const { orch, orchSession, mgr } = await openOrchestrator(t, { isolation: 'none' });
  fs.appendFileSync(path.join(orchSession.settings.sessionDir, 'TODO.md'), '| 1 | w1 | running | — | wait |\n');
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'THE ORIGINAL BRIEF' });

  assert.deepStrictEqual(hook(orch, orchSession, { hook_event_name: 'SessionStart', source: 'startup' }), {});
  const o = JSON.parse(hook(orch, orchSession, { hook_event_name: 'SessionStart', source: 'compact' }).stdout);
  assert.strictEqual(o.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(o.hookSpecificOutput.additionalContext, /You are the ORCHESTRATOR/);
  assert.match(o.hookSpecificOutput.additionalContext, /\| 1 \| w1 \| running/);
  assert.ok(o.hookSpecificOutput.additionalContext.length < 10000);

  const wc = JSON.parse(hook(orch, mgr.sessions.get(w.tabId), { hook_event_name: 'SessionStart', source: 'compact' }).stdout);
  assert.match(wc.hookSpecificOutput.additionalContext, /THE ORIGINAL BRIEF/);
  assert.match(wc.hookSpecificOutput.additionalContext, new RegExp(`launched by \`${orchSession.settings.name}\``));
});

test('worktree isolation: a branch per worker, end_run removes merged ones', async (t) => {
  const repo = tmpDir('vistaclair-orch-repo-');
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  g('init', '-q'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');

  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { cwd: repo });
  assert.strictEqual(run().isolation, 'worktree', 'a git root defaults to worktrees');
  assert.ok(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8').includes('/.orchestrator/'));
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  assert.match(w.branch, /^orch\/[0-9a-f]{6}\/w1$/);
  assert.ok(fs.existsSync(w.cwd));
  assert.match(mgr.sessions.get(w.tabId).settings.appendSystemPrompt, /git worktree/);

  assert.deepStrictEqual(orch.endRun(orchSession.instanceId).kept.map(k => k.reason), ['still running']);
  mgr.sessions.get(w.tabId).running = false;
  const res = orch.endRun(orchSession.instanceId);
  assert.deepStrictEqual(res.removed, [w.worker]);
  assert.strictEqual(res.closed, true);
  assert.ok(!fs.existsSync(w.cwd));
});

// --- Pause, resume, refresh, close and delete (with the real session control) ---

const writeResume = (session, text = 'next: step 2') =>
  fs.writeFileSync(path.join(session.settings.sessionDir, 'NOTES.md'), `# Notes\n\n## Resume\n\n${text}\n`);
const typedInto = (mgr, tabId) => mgr.writes.filter(x => x.tabId === tabId).map(x => x.data).join('\n');
const ctxOf = (r) => JSON.parse(r.stdout || '{}').hookSpecificOutput?.additionalContext || '';
const blockOf = (r) => { const o = JSON.parse(r.stdout || '{}'); return o.decision === 'block' ? o.reason : null; };

test('pausing a run: the orchestrator relays, workers write notes and close, the orchestrator closes last', async (t) => {
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none' });
  const w1 = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'brief A' });
  const w2 = orch.launchWorker(orchSession.instanceId, { title: 'b', task: 'brief B' });
  const s1 = mgr.sessions.get(w1.tabId);
  const s2 = mgr.sessions.get(w2.tabId);
  assert.ok(fs.existsSync(path.join(w1.folder, 'TODO.md')), 'a worker gets its own folder');

  const res = orch.pauseRun(run().runId);
  assert.deepStrictEqual(res.workers, [w1.worker, w2.worker]);
  assert.match(typedInto(mgr, orchSession.tabId), /send each running worker .*SendMessage/s, 'the idle orchestrator is told to relay');
  assert.ok(!/\[vistaclair pause\]/.test(typedInto(mgr, s1.tabId)), 'workers wait for the relay');
  assert.match(ctxOf(hook(orch, s1, { hook_event_name: 'PostToolUse', tool_name: 'Read' })), /orchestrator .* is sending you what to finish/);
  assert.match(ctxOf(hook(orch, s1, { hook_event_name: 'PostToolUse', tool_name: 'Read', agent_id: 'sub1' })), /pausing the session that launched you/, 'a subagent hears it too');
  assert.strictEqual(hook(orch, orchSession, { hook_event_name: 'PreToolUse', tool_name: 'mcp__orchestrator__launch_cli' }).exitCode, 2);
  assert.strictEqual(hook(orch, s1, { hook_event_name: 'PreToolUse', tool_name: 'Agent' }).exitCode, 2);

  // The orchestrator relays to w1 only; w2 hears it from the server.
  hook(orch, orchSession, { hook_event_name: 'UserPromptSubmit', prompt: '[vistaclair pause] …' });
  hook(orch, orchSession, { hook_event_name: 'PostToolUse', tool_name: 'SendMessage', tool_input: { to: w1.worker } });
  await wait(80);
  assert.ok(!/\[vistaclair pause\]/.test(typedInto(mgr, s1.tabId)), 'a relayed worker gets no fallback');
  assert.match(typedInto(mgr, s2.tabId), /\[vistaclair pause\].*report status "paused"/s, 'the fallback reaches an unrelayed worker');

  // The orchestrator idles while its workers pause.
  assert.deepStrictEqual(hook(orch, orchSession, { hook_event_name: 'Stop' }), {});
  await wait(20);
  assert.ok(mgr.sessions.has(orchSession.tabId), 'held open while workers pause');

  // A worker stops: no note → asked once; with a note → closed and marked paused.
  hook(orch, s1, { hook_event_name: 'UserPromptSubmit' });
  assert.match(blockOf(hook(orch, s1, { hook_event_name: 'Stop' })), /## Resume/);
  writeResume(s1);
  hook(orch, s1, { hook_event_name: 'Stop', stop_hook_active: true });
  await wait(20);
  assert.ok(!mgr.sessions.has(s1.tabId));
  assert.ok(run().workers[0].paused);
  assert.ok(mgr.findSaved(s1.sessId).paused);
  assert.ok(run().pausing, 'still pausing: w2 runs');

  hook(orch, s2, { hook_event_name: 'UserPromptSubmit' });
  writeResume(s2);
  hook(orch, s2, { hook_event_name: 'Stop' });
  await wait(20);
  assert.match(typedInto(mgr, orchSession.tabId), /Every worker of run .* is paused/, 'the last worker wakes the orchestrator');

  // Its note predates that message: asked again, then closed.
  writeResume(orchSession, 'stale');
  fs.utimesSync(path.join(orchSession.settings.sessionDir, 'NOTES.md'), new Date(0), new Date(0));
  hook(orch, orchSession, { hook_event_name: 'UserPromptSubmit', prompt: '[vistaclair pause]' });
  assert.ok(blockOf(hook(orch, orchSession, { hook_event_name: 'Stop' })));
  writeResume(orchSession, 'run note');
  hook(orch, orchSession, { hook_event_name: 'Stop', stop_hook_active: true });
  await wait(20);
  assert.ok(!mgr.sessions.has(orchSession.tabId));
  assert.strictEqual(run().pausing, null);
  assert.deepStrictEqual(run().paused.workers, [w1.worker, w2.worker]);
});

test('resuming a run: the orchestrator warms up its paused workers with resume_worker', async (t) => {
  const { orch, orchSession, mgr, run, control } = await openOrchestrator(t, { isolation: 'none' });
  const w1 = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'brief A' });
  const w2 = orch.launchWorker(orchSession.instanceId, { title: 'b', task: 'brief B' });
  const runId = run().runId;
  orch.pauseRun(runId);
  await wait(15);   // file mtimes come from a coarse clock
  for (const w of [w1, w2]) {
    const s = mgr.sessions.get(w.tabId);
    writeResume(s);
    hook(orch, s, { hook_event_name: 'Stop' });
  }
  await wait(20);
  writeResume(orchSession);
  hook(orch, orchSession, { hook_event_name: 'Stop' });
  await wait(20);
  assert.ok(run().paused);
  const oldW2 = mgr.history.find(h => h.settings.orchestration?.workerId === 'w2').id;

  const r = orch.resumeRun(runId);
  const o2 = mgr.sessions.get(r.tabId);
  assert.strictEqual(o2.sessId, orchSession.sessId, 'continue: its own transcript');
  assert.match(typedInto(mgr, r.tabId), /\[vistaclair resume\].*resume_worker/s);
  assert.throws(() => orch.resumeRun(runId), /already running/);
  assert.throws(() => orch.launchWorker(o2.instanceId, { title: 'c', task: 'x' }), /paused workers must be resumed/);

  const c = orch.resumeWorker(o2.instanceId, { worker: w1.worker, mode: 'continue', message: 'finish the parser' });
  const c1 = mgr.sessions.get(c.tabId);
  assert.strictEqual(c1.sessId, mgr.history.find(h => h.settings.orchestration?.workerId === 'w1').id);
  assert.match(typedInto(mgr, c.tabId), /\[vistaclair resume\][\s\S]*finish the parser/);
  assert.throws(() => orch.resumeWorker(o2.instanceId, { worker: w1.worker, mode: 'continue' }), /already running/);

  const f = orch.resumeWorker(o2.instanceId, { worker: 'w2', mode: 'fresh' });
  assert.strictEqual(mgr.sessions.get(f.tabId).settings.name, w2.worker, 'fresh keeps the address');
  assert.strictEqual(mgr.sessions.get(f.tabId).settings.sessionDir, w2.folder, 'and the folder');
  assert.match(typedInto(mgr, f.tabId), /brief B[\s\S]*fresh restart/);
  assert.strictEqual(mgr.findSaved(oldW2), null, 'the superseded session leaves the resume list');
  assert.ok(!run().workers.some(w => w.paused));
  assert.strictEqual(run().paused, null);
  assert.throws(() => orch.resumeWorker(mgr.sessions.get(c.tabId).instanceId, { worker: 'w2' }), /only an orchestrator/);
  assert.ok(control.liveOf(c1));
});

test('a lost transcript: resuming the run and its worker falls back to fresh sessions from the notes', async (t) => {
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none' });
  hook(orch, orchSession, { hook_event_name: 'UserPromptSubmit', prompt: 'Build the importer' });
  const w1 = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'brief A' });
  hook(orch, orchSession, { hook_event_name: 'Stop' });
  const runId = run().runId;
  orch.pauseRun(runId);
  await wait(15);
  const s1 = mgr.sessions.get(w1.tabId);
  writeResume(s1, 'parser half done');
  hook(orch, s1, { hook_event_name: 'Stop' });
  await wait(20);
  writeResume(orchSession, 'w1 paused mid-parser');
  hook(orch, orchSession, { hook_event_name: 'Stop' });
  await wait(20);
  mgr.lost.add(orchSession.sessId);
  mgr.lost.add(s1.sessId);

  // The run: a continue becomes a fresh orchestrator, seeded, same address.
  const r = orch.resumeRun(runId);
  assert.strictEqual(r.fresh, true);
  assert.strictEqual(r.fellBack, true);
  const o2 = mgr.sessions.get(r.tabId);
  assert.notStrictEqual(o2.sessId, orchSession.sessId);
  assert.strictEqual(o2.settings.name, orchSession.settings.name);
  const seed = fs.readFileSync(path.join(orchSession.settings.sessionDir, 'RESTART.md'), 'utf8');
  for (const x of ['could not be restored', 'Build the importer', 'w1 paused mid-parser', 'brief A', 'parser half done']) assert.ok(seed.includes(x), x);
  assert.match(typedInto(mgr, r.tabId), /resume_worker/);
  assert.strictEqual(mgr.findSaved(orchSession.sessId), null);

  // The worker: resume_worker "continue" becomes fresh, with its brief.
  const c = orch.resumeWorker(o2.instanceId, { worker: w1.worker, mode: 'continue', message: 'finish the parser' });
  assert.strictEqual(c.mode, 'fresh');
  assert.strictEqual(c.fellBack, true);
  const c1 = mgr.sessions.get(c.tabId);
  assert.notStrictEqual(c1.sessId, s1.sessId);
  assert.strictEqual(c1.settings.name, w1.worker);
  assert.strictEqual(c1.settings.sessionDir, w1.folder);
  assert.match(typedInto(mgr, c.tabId), /brief A[\s\S]*could not be restored[\s\S]*finish the parser/);
  assert.strictEqual(mgr.findSaved(s1.sessId), null);
  assert.ok(!run().workers[0].paused);
});

test('a "+" menu worker row resumes like resume_worker continue, falling back to its brief', async (t) => {
  const { orch, orchSession, mgr } = await openOrchestrator(t, { isolation: 'none' });
  const w1 = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'brief A' });
  const s1 = mgr.sessions.get(w1.tabId);
  s1.running = false;
  mgr.sessions.delete(w1.tabId);
  const kept = orch.resumeSavedWorker(s1.sessId);
  assert.strictEqual(kept.mode, 'continue');
  assert.strictEqual(mgr.sessions.get(kept.tabId).sessId, s1.sessId);
  mgr.sessions.get(kept.tabId).running = false;
  mgr.lost.add(s1.sessId);
  const fresh = orch.resumeSavedWorker(s1.sessId);
  assert.strictEqual(fresh.fellBack, true);
  assert.match(typedInto(mgr, fresh.tabId), /brief A/);
  assert.throws(() => orch.resumeSavedWorker(orchSession.sessId), /not a worker/);
});

test('refreshing the orchestrator: notes, then a fresh session seeded from the run', async (t) => {
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none' });
  hook(orch, orchSession, { hook_event_name: 'UserPromptSubmit', prompt: 'Build the importer' });
  const w1 = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'brief A' });
  orch.report(mgr.sessions.get(w1.tabId).instanceId, { status: 'started', summary: 'on it' });
  for (let i = 0; i < 3; i++) hook(orch, orchSession, { hook_event_name: 'SessionStart', source: 'compact' });
  assert.strictEqual(orch.describeRun(run()).refreshSuggested, true);
  hook(orch, orchSession, { hook_event_name: 'Stop' });

  orch.refreshOrchestrator(run().runId);
  assert.match(typedInto(mgr, orchSession.tabId), /refreshing you/);
  await wait(15);
  writeResume(orchSession, 'w1 is parsing');
  hook(orch, orchSession, { hook_event_name: 'UserPromptSubmit', prompt: '[vistaclair pause]' });
  hook(orch, orchSession, { hook_event_name: 'Stop' });
  await wait(20);

  const fresh = [...mgr.sessions.values()].find(s => s.settings.orchestration?.role === 'orchestrator');
  assert.ok(fresh && fresh !== orchSession);
  assert.notStrictEqual(fresh.sessId, orchSession.sessId);
  assert.strictEqual(fresh.settings.name, orchSession.settings.name);
  const seed = fs.readFileSync(path.join(orchSession.settings.sessionDir, 'RESTART.md'), 'utf8');
  for (const s of ['Build the importer', 'w1 is parsing', 'brief A', 'on it']) assert.ok(seed.includes(s), s);
  assert.match(typedInto(mgr, fresh.tabId), /RESTART\.md/);
  assert.strictEqual(mgr.findSaved(orchSession.sessId), null, 'the drifted session leaves the resume list');
  assert.strictEqual(run().compactions, 0);
  assert.ok(mgr.sessions.has(w1.tabId), 'workers keep running');
});

test('close guards: a worker closes when complete or forced, an orchestrator not while workers run', async (t) => {
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none' });
  const w1 = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  const s1 = mgr.sessions.get(w1.tabId);
  const refused = orch.closeCheck(w1.tabId);
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.canForce, true);
  assert.deepStrictEqual(orch.closeCheck(orchSession.tabId).ok, false);
  orch.report(s1.instanceId, { status: 'done', summary: 'ok' });
  assert.strictEqual(orch.closeCheck(w1.tabId).ok, true, 'done and idle');
  orch.report(s1.instanceId, { status: 'blocked', summary: 'hm' });
  assert.strictEqual(orch.closeCheck(w1.tabId, { force: true }).abandoned, true);
  assert.ok(run().workers[0].abandoned);
  s1.running = false;
  assert.strictEqual(orch.closeCheck(orchSession.tabId).ok, true);
  assert.deepStrictEqual(orch.closeCheck('tab-unknown'), { ok: true });
});

test('deleting a run: refused over uncommitted worktree changes, keeps unmerged branches', async (t) => {
  const repo = tmpDir('vistaclair-orch-repo-');
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' }).toString();
  g('init', '-q'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { cwd: repo });
  const w1 = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  const runId = run().runId;
  const runDir = run().runDir;
  assert.throws(() => orch.deleteRun(runId), /still running/);
  for (const s of mgr.sessions.values()) s.running = false;

  fs.writeFileSync(path.join(w1.cwd, 'wip.txt'), 'x');
  const refused = orch.deleteRun(runId);
  assert.strictEqual(refused.refused, true);
  assert.strictEqual(refused.dirty[0].worker, w1.worker);
  execFileSync('git', ['-C', w1.cwd, 'add', '.']);
  execFileSync('git', ['-C', w1.cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'wip']);

  const res = orch.deleteRun(runId);
  assert.deepStrictEqual(res.keptBranches, [w1.branch]);
  assert.ok(g('branch', '--list', w1.branch).trim(), 'the unmerged branch is kept');
  assert.ok(!fs.existsSync(w1.cwd));
  assert.ok(!fs.existsSync(runDir));
  assert.ok(!fs.existsSync(w1.folder));
  assert.ok(!fs.existsSync(orchSession.settings.sessionDir));
  assert.strictEqual(mgr.history.length, 0, 'every member leaves the resume list');
});

test('buildCliArgs passes the session name and subagent definitions', () => {
  const { buildCliArgs } = require('../src/utils');
  const args = buildCliArgs({ name: 'orch-abc123', agents: { coder: { model: 'opus' } }, maxBudgetUsd: 5 });
  assert.deepStrictEqual(args.slice(0, 4), ['--name', 'orch-abc123', '--agents', '{"coder":{"model":"opus"}}']);
  assert.ok(args.includes('--max-budget-usd'));
});

test('the orchestrator MCP server is attached only to stamped sessions, by role', () => {
  const CliSession = require('../src/cli-session');
  const fn = (role) => CliSession.prototype._orchestratorMcpServer.call({
    settings: role ? { orchestration: { role } } : {}, instanceId: 'cli-x', _dashboardPort: 1, _authToken: 't',
  });
  assert.deepStrictEqual(fn(null), {});
  assert.strictEqual(fn('orchestrator').orchestrator.env.VISTACLAIR_ORCH_ROLE, 'orchestrator');
  assert.strictEqual(fn('worker').orchestrator.env.VISTACLAIR_ORCH_ROLE, 'worker');
});

test('the hook script fails open when the dashboard is unreachable', () => {
  const r = spawnSync('node', [path.join(CORE, 'lib', 'orchestration-hook.js')], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent' }),
    env: { ...process.env, VISTACLAIR_DASHBOARD_PORT: '1', VISTACLAIR_AUTH_TOKEN: 't', VISTACLAIR_INSTANCE_ID: 'cli-x' },
    timeout: 8000,
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.toString(), '');
});

// --- Agent SDK runs: engine, messaging ---

const msgEvents = (mgr, tabId) => mgr.emitted.filter(e => e.tabId === tabId && e.ev.platform?.kind === 'message').map(e => e.ev.platform);

test('an SDK run: workers inherit the engine and are hidden; describeRun names sessId, engine, state and cost', async (t) => {
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none', engine: 'sdk' });
  assert.strictEqual(run().engine, 'sdk');
  assert.strictEqual(orchSession.settings.engine, 'sdk');
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  const wSession = mgr.sessions.get(w.tabId);
  assert.strictEqual(wSession.settings.engine, 'sdk');
  assert.strictEqual(mgr.launches.at(-1).opts.hidden, true, 'an SDK worker is an area of the panel, not a tab');
  wSession.costUsd = 0.12;
  wSession.state = 'busy';
  orchSession.costUsd = 0.5;

  let d = orch.describeRun(run());
  assert.strictEqual(d.engine, 'sdk');
  assert.strictEqual(d.orchestratorSessId, orchSession.sessId);
  assert.strictEqual(d.orchestratorCost, 0.5);
  const dw = d.workers[0];
  assert.deepStrictEqual({ name: dw.name, sessId: dw.sessId, engine: dw.engine, state: dw.state, cost: dw.cost },
    { name: w.worker, sessId: wSession.sessId, engine: 'sdk', state: 'busy', cost: 0.12 });

  // Exited: the cost is kept in run.json, the sessId comes from history.
  wSession.running = false;
  orch.onSessionExit(w.tabId, wSession);
  mgr.sessions.delete(w.tabId);
  d = orch.describeRun(run());
  assert.deepStrictEqual({ sessId: d.workers[0].sessId, state: d.workers[0].state, cost: d.workers[0].cost },
    { sessId: wSession.sessId, state: 'exited', cost: 0.12 });

  // A CLI run stays CLI.
  const cli = await openOrchestrator(t, { isolation: 'none' });
  const cw = cli.orch.launchWorker(cli.orchSession.instanceId, { title: 'b', task: 'y' });
  assert.strictEqual(cli.mgr.sessions.get(cw.tabId).settings.engine, 'cli');
  assert.strictEqual(cli.mgr.launches.at(-1).opts.hidden, undefined);
});

test('a member model switch: run.json follows, fresh restarts use it; a resumed member keeps its cost', async (t) => {
  const { orch, orchSession, mgr, run } = await openOrchestrator(t, { isolation: 'none', engine: 'sdk' });
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'brief A', model: 'sonnet' });
  const wSession = mgr.sessions.get(w.tabId);
  wSession.settings.model = 'haiku';            // what SdkSession.setModel did
  assert.strictEqual(orch.memberModelChanged(wSession, 'haiku'), true);
  assert.strictEqual(run().workers[0].model, 'haiku');
  assert.strictEqual(orch.describeRun(run()).workers[0].model, 'haiku');
  assert.match(mgr.sessions.get(w.tabId).settings.appendSystemPrompt, /rows of your TODO\.md \(short descriptions, detail in NOTES\.md\)/);
  assert.strictEqual(orch.memberModelChanged(orchSession, 'claude-opus-4-5[1m]'), true);
  assert.strictEqual(run().orchestratorModel, 'claude-opus-4-5[1m]');
  assert.strictEqual(orch.memberModelChanged({ getSettings: () => ({}) }, 'opus'), false, 'not a member');

  // It exits with a cost; a continue resume is raised to it, and describeRun
  // never shows the resumed session's live 0 over the recorded cost.
  wSession.costUsd = 0.12;
  wSession.running = false;
  orch.onSessionExit(w.tabId, wSession);
  mgr.sessions.delete(w.tabId);
  const c = orch.resumeWorker(orchSession.instanceId, { worker: 'w1', mode: 'continue' });
  const c1 = mgr.sessions.get(c.tabId);
  assert.strictEqual(c1.seeded, 0.12);
  c1.costUsd = 0;
  assert.strictEqual(orch.describeRun(run()).workers[0].cost, 0.12);
  c1.costUsd = 0.3;
  assert.strictEqual(orch.describeRun(run()).workers[0].cost, 0.3);

  // A fresh restart is launched with the switched model.
  c1.running = false;
  mgr.sessions.delete(c.tabId);
  const f = orch.resumeWorker(orchSession.instanceId, { worker: 'w1', mode: 'fresh' });
  assert.strictEqual(f.mode, 'fresh');
  assert.strictEqual(mgr.sessions.get(f.tabId).settings.model, 'haiku');

  // A fresh orchestrator with no saved entry to take settings from uses it too.
  orchSession.running = false;
  orch.onSessionExit(orchSession.tabId, orchSession);
  mgr.sessions.delete(orchSession.tabId);
  mgr.forgetSaved(orchSession.sessId);
  const r = orch.resumeRun(run().runId);
  assert.strictEqual(r.fresh, true);
  assert.strictEqual(mgr.sessions.get(r.tabId).settings.model, 'claude-opus-4-5[1m]');
});

test('SendMessage to an SDK member: a next-priority turn, idle or busy, and a message card in both areas', async (t) => {
  const { orch, orchSession, mgr } = await openOrchestrator(t, { isolation: 'none', engine: 'sdk' });
  const orchName = orchSession.settings.name;
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  const wSession = mgr.sessions.get(w.tabId);

  // Worker -> idle orchestrator.
  const r1 = orch.sendMessage(wSession.instanceId, { to: orchName, message: 'need a decision' });
  assert.deepStrictEqual(r1, { ok: true, to: orchName, delivery: 'submitted' });
  const sub = mgr.submits.filter(x => x.tabId === orchSession.tabId).at(-1);
  assert.strictEqual(sub.data, `[message from ${w.worker}] need a decision`);
  assert.deepStrictEqual(sub.opts, { priority: 'next', from: w.worker });
  const card = { kind: 'message', from: w.worker, to: orchName, text: 'need a decision' };
  assert.deepStrictEqual(msgEvents(mgr, orchSession.tabId), [card]);
  assert.deepStrictEqual(msgEvents(mgr, w.tabId), [card]);

  // Orchestrator -> busy worker, by its id: still submitted, with priority next.
  wSession.busy = true;
  const r2 = orch.sendMessage(orchSession.instanceId, { to: 'w1', message: 'also fix b' });
  assert.strictEqual(r2.delivery, 'submitted');
  assert.strictEqual(r2.to, w.worker);
  assert.deepStrictEqual(mgr.submits.filter(x => x.tabId === w.tabId).at(-1).opts, { priority: 'next', from: orchName });
  // The PostToolUse watcher sees the MCP tool by its suffix: a worker that
  // messaged its orchestrator has reported.
  hook(orch, wSession, { hook_event_name: 'UserPromptSubmit' });
  hook(orch, wSession, { hook_event_name: 'PostToolUse', tool_name: 'mcp__orchestrator__SendMessage', tool_input: { to: orchName } });
  assert.deepStrictEqual(hook(orch, wSession, { hook_event_name: 'Stop' }), {});

  // Refusals.
  assert.throws(() => orch.sendMessage(wSession.instanceId, { to: 'nobody', message: 'x' }), /no member nobody[\s\S]*Members: orch-/);
  assert.throws(() => orch.sendMessage(wSession.instanceId, { to: w.worker, message: 'x' }), /your own address/);
  assert.throws(() => orch.sendMessage(wSession.instanceId, { to: orchName, message: ' ' }), /message is required/);
  wSession.running = false;
  assert.throws(() => orch.sendMessage(orchSession.instanceId, { to: w.worker, message: 'x' }), /not running.*resume_worker/);

  // ListAgents: both members, with state.
  const list = orch.listAgents(orchSession.instanceId);
  assert.strictEqual(list.you, orchName);
  assert.deepStrictEqual(list.agents.map(a => [a.name, a.role]), [[orchName, 'orchestrator'], [w.worker, 'worker']]);
  assert.strictEqual(list.agents[1].state, 'stopped');
});

test('SendMessage to a CLI member: typed when idle, through its next hook when busy', async (t) => {
  const { orch, orchSession, mgr, broadcasts } = await openOrchestrator(t, { isolation: 'none' });
  const orchName = orchSession.settings.name;
  const w = orch.launchWorker(orchSession.instanceId, { title: 'a', task: 'x' });
  const wSession = mgr.sessions.get(w.tabId);

  assert.strictEqual(orch.sendMessage(orchSession.instanceId, { to: w.worker, message: 'one' }).delivery, 'submitted');
  assert.deepStrictEqual(mgr.submits.filter(x => x.tabId === w.tabId).at(-1).opts, { from: orchName });
  // No panel: the message is still broadcast for both session ids.
  const sent = broadcasts.filter(b => b.type === 'sdk:event' && b.ev.platform?.kind === 'message');
  assert.deepStrictEqual(sent.map(b => b.sessId).sort(), [orchSession.sessId, wSession.sessId].sort());

  wSession.busy = true;
  const before = mgr.submits.length;
  assert.strictEqual(orch.sendMessage(orchSession.instanceId, { to: w.worker, message: 'two' }).delivery, 'queued');
  assert.strictEqual(mgr.submits.length, before, 'nothing typed into a busy terminal');
  const post = JSON.parse(hook(orch, wSession, { hook_event_name: 'PostToolUse', tool_name: 'Read' }).stdout);
  assert.strictEqual(post.hookSpecificOutput.additionalContext, `[message from ${orchName}] two`);
  assert.deepStrictEqual(hook(orch, wSession, { hook_event_name: 'PostToolUse', tool_name: 'Read' }), {}, 'delivered once');

  // Still queued when the turn ends: the Stop continues it with the message.
  orch.sendMessage(orchSession.instanceId, { to: w.worker, message: 'three' });
  const stop = JSON.parse(hook(orch, wSession, { hook_event_name: 'Stop' }).stdout);
  assert.strictEqual(stop.decision, 'block');
  assert.match(stop.reason, /three/);

  // To a busy CLI orchestrator: merged with its worker events.
  hook(orch, orchSession, { hook_event_name: 'UserPromptSubmit' });
  orchSession.busy = true;
  orch.sendMessage(wSession.instanceId, { to: 'orchestrator', message: 'question' });
  orch.report(wSession.instanceId, { status: 'blocked', summary: 'stuck' });
  const ctx = JSON.parse(hook(orch, orchSession, { hook_event_name: 'PostToolUse', tool_name: 'Read' }).stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /\[message from [^\]]+\] question[\s\S]*reported blocked: stuck/);
});

test('the orchestrator MCP server offers SendMessage / ListAgents to SDK sessions only', () => {
  const CliSession = require('../src/cli-session');
  const env = (engine) => CliSession.buildMcpServers({ settings: { engine, orchestration: { role: 'worker' } }, instanceId: 'cli-x' }).orchestrator.env;
  assert.strictEqual(env('sdk').VISTACLAIR_ORCH_ENGINE, 'sdk');
  assert.strictEqual(env(undefined).VISTACLAIR_ORCH_ENGINE, 'cli');
  const src = fs.readFileSync(path.join(CORE, 'lib', 'orchestrator-mcp.js'), 'utf8');
  assert.match(src, /name: "SendMessage",\s*path: "send-message"/);
  assert.match(src, /name: "ListAgents",\s*path: "list-agents"/);
});
