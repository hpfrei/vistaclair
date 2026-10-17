// Agent SDK sessions (src/sdk-session.js): the query() options a tab's settings
// map to (the same append prompt, settings file and MCP servers as its CLI
// twin, the billing it picked), the event fan-out into broadcasts and transcript.jsonl,
// submit (priorities, images), interrupt, and the exit a PTY tab would report.
// A fake query() stands in for the SDK — nothing here spawns `claude`.
//
//   node --test test/

const fs = require('fs');
const os = require('os');
const path = require('path');

// Before anything reads them: a throwaway data home, $HOME and credential.
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-sdk-')));
process.env.VISTACLAIR_HOME = HOME;
process.env.HOME = HOME;
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-should-not-pass';
process.env.VISTACLAIR_DASHBOARD_PORT = '';

const test = require('node:test');
const assert = require('node:assert');

// Capture what a CLI tab would be spawned with: cli-session.js takes
// spawnClaudePty from utils when it is first required.
const utils = require('../src/utils');
const ptySpawns = [];
utils.spawnClaudePty = (args, o) => {
  ptySpawns.push({ args, o });
  return { pid: 0, onData() {}, onExit() {}, write() {}, resize() {} };
};
// Whether a subscription is signed in is `claude auth status --json`'s answer
// (src/claude-auth.js): stubbed, signed out unless a test says otherwise.
const claudeAuth = require('../src/claude-auth');
const SIGNED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none' });
const SIGNED_IN = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' });
function setLogin(out) { claudeAuth.authStatus.setRunner({ run: async () => out, runSync: () => out }); }
setLogin(SIGNED_OUT);
const CliSession = require('../src/cli-session');
const SdkSession = require('../src/sdk-session');
const CliSessionManager = require('../src/cli-sessions');

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

// --- The fake SDK ---

// A message source the test drives: emit() yields to the session's loop,
// end() finishes the query.
function channel() {
  const items = [];
  const waiters = [];
  let done = false;
  let error = null;
  return {
    push(v) { const w = waiters.shift(); if (w) w.resolve({ value: v, done: false }); else items.push(v); },
    end() { done = true; for (const w of waiters.splice(0)) w.resolve({ value: undefined, done: true }); },
    fail(e) { error = e; for (const w of waiters.splice(0)) w.reject(e); },
    next() {
      if (items.length) return Promise.resolve({ value: items.shift(), done: false });
      if (error) return Promise.reject(error);
      if (done) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
  };
}

function fakeSdk() {
  const calls = [];
  const sdk = {
    sessionMessages: [],
    query({ prompt, options }) {
      const out = channel();
      const call = { prompt, options, inputs: [], interrupts: 0, models: [], contextAsks: [], closed: false, emit: (m) => out.push(m), end: () => out.end(), fail: (e) => out.fail(e) };
      options.abortController?.signal.addEventListener('abort', () => out.end());
      (async () => { for await (const m of prompt) call.inputs.push(m); call.inputEnded = true; })();
      calls.push(call);
      return {
        [Symbol.asyncIterator]() { return this; },
        next: () => out.next(),
        return: async () => { out.end(); return { value: undefined, done: true }; },
        interrupt: async () => { call.interrupts++; return sdk.interruptReceipt; },
        setModel: async (m) => { call.models.push(m); },
        getContextUsage: async (o) => { call.contextAsks.push(o); return sdk.contextUsage || null; },
        close: () => { call.closed = true; out.end(); },
      };
    },
    getSessionMessages: async (id, opts) => { sdk.seededFrom = { id, opts }; return sdk.sessionMessages; },
  };
  return { sdk, calls };
}

const store = { registerSession() {}, unregisterSession() {}, loadSessionIntoMemory: () => [], deleteSessionData() {} };
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

function tmp(prefix) {
  return fs.mkdtempSync(path.join(HOME, prefix));
}

function makeSession(settings = {}, extra = {}) {
  const { sdk, calls } = fakeSdk();
  const broadcasts = [];
  const s = new SdkSession(9999, { broadcast: (m) => broadcasts.push(m) }, store, { sdk, claudeBin: '/opt/claude', authToken: 'tok', dashboardPort: 4321, ...extra });
  s.tabId = 'tab-x';
  s.updateSettings({ sessionDir: tmp('folder-'), ...settings });
  return { s, sdk, calls, broadcasts, events: () => broadcasts.filter(b => b.type === 'sdk:event') };
}

const lines = (dir) => fs.readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

// --- Option mapping ---

test('options: the same append prompt, settings file, MCP servers and model as the CLI tab', () => {
  const cwd = tmp('proj-');
  const settingsFile = path.join(cwd, 'hooks.json');
  fs.writeFileSync(settingsFile, '{}');
  const settings = {
    appendSystemPrompt: 'CALLER PROMPT\nwith lines', settingsFile, model: 'opus', effort: 'high',
    agents: { coder: { description: 'd', prompt: 'p', model: 'opus' } },
    name: 'orch-abc123-w1-x', engine: 'sdk',
    orchestration: { runId: 'abc123', role: 'worker', workerId: 'w1', runDir: cwd },
    sessionDir: tmp('folder-'),
  };

  // The CLI twin, with the same settings and instance id.
  const cli = new CliSession(9999, { broadcast() {} }, store, { authToken: 'tok', dashboardPort: 4321 });
  cli.updateSettings(settings);
  cli.spawn(cwd, 80, 24, {});
  const args = ptySpawns.at(-1).args;
  const flag = (f) => args[args.indexOf(f) + 1];
  const cliMcp = JSON.parse(fs.readFileSync(flag('--mcp-config'), 'utf8')).mcpServers;
  cli.kill();

  const { s, calls } = makeSession(settings);
  s.spawn(cwd, 80, 24, {});
  const o = calls[0].options;

  // Same text for the same session id: compare against the CLI's with ids aligned.
  const align = (t) => t.split(cli.sessId).join('<id>');
  assert.strictEqual(o.systemPrompt.type, 'preset');
  assert.strictEqual(o.systemPrompt.preset, 'claude_code');
  assert.strictEqual(align(o.systemPrompt.append), align(flag('--append-system-prompt')), 'append is the CLI text, byte for byte');
  assert.ok(o.systemPrompt.append.startsWith('CALLER PROMPT\nwith lines\n\nIMPORTANT: A Vistaclair control-room server'));
  assert.strictEqual(o.settings, settingsFile);
  assert.strictEqual(o.settings, flag('--settings'));
  assert.deepStrictEqual(o.settingSources, ['user', 'project', 'local']);
  assert.strictEqual(o.model, flag('--model'));
  assert.strictEqual(o.effort, flag('--effort'));
  assert.deepStrictEqual(o.agents, JSON.parse(flag('--agents')));
  assert.strictEqual(o.title, 'orch-abc123-w1-x');

  // MCP: the CLI's --mcp-config entries, but for this session's instance and engine.
  const sdkMcp = JSON.parse(JSON.stringify(o.mcpServers).split(s.instanceId).join(cli.instanceId));
  cliMcp.orchestrator.env.VISTACLAIR_ORCH_ENGINE = 'sdk';
  assert.deepStrictEqual(sdkMcp, cliMcp);
  assert.strictEqual(o.mcpServers.orchestrator.env.VISTACLAIR_ORCH_ROLE, 'worker');
  assert.strictEqual(o.mcpServers.orchestrator.env.VISTACLAIR_INSTANCE_ID, s.instanceId);

  assert.strictEqual(o.permissionMode, 'bypassPermissions');
  assert.strictEqual(o.allowDangerouslySkipPermissions, true);
  // The engine's own denials, then the worker role's: the CLI twin's --disallowedTools.
  assert.deepStrictEqual(o.disallowedTools, ['SendMessage', 'ListAgents', ...flag('--disallowedTools').split(',')]);
  assert.deepStrictEqual(o.disallowedTools.slice(2), ['Workflow', 'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion', 'mcp__integrated__vista-AskUserQuestion']);
  assert.strictEqual(o.includePartialMessages, true);
  assert.strictEqual(o.forwardSubagentText, true, 'subagents stream their text and thinking too');
  assert.strictEqual(o.pathToClaudeCodeExecutable, '/opt/claude');
  assert.strictEqual(o.sessionId, s.sessId);
  assert.strictEqual(o.resume, undefined);
  assert.strictEqual(o.cwd, cwd);
  s.kill();
});

test('options: disallowedTools by orchestration role; a session without one keeps SendMessage / ListAgents only', () => {
  const denied = (orchestration) => {
    const { s, calls } = makeSession(orchestration ? { orchestration } : {});
    s.spawn(tmp('proj-'), 80, 24, {});
    const o = calls[0].options;
    s.kill();
    return o.disallowedTools;
  };
  assert.deepStrictEqual(denied(null), ['SendMessage', 'ListAgents']);
  const orch = denied({ runId: 'r1', role: 'orchestrator' });
  assert.deepStrictEqual(orch, ['SendMessage', 'ListAgents', 'Workflow', 'EnterPlanMode', 'ExitPlanMode', 'Monitor', 'ReportFindings']);
  assert.ok(!orch.some(t => /AskUserQuestion/.test(t)), 'the orchestrator keeps AskUserQuestion');
  const worker = denied({ runId: 'r1', role: 'worker', workerId: 'w1' });
  assert.ok(worker.includes('AskUserQuestion') && worker.includes('mcp__integrated__vista-AskUserQuestion'), 'a worker loses both forms');
  assert.ok(!worker.includes('Monitor') && !worker.includes('ReportFindings'));
});

test('options: env is the whole buildClaudeEnv, with API-key auth (no subscription) and no OAuth', () => {
  const { s, calls } = makeSession();
  s.spawn(tmp('proj-'), 80, 24, { autoMemory: false });
  const env = calls[0].options.env;
  assert.strictEqual(env.ANTHROPIC_API_KEY, 'sk-ant-test');
  assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.strictEqual(env.ANTHROPIC_BASE_URL, `http://localhost:9999/i/${encodeURIComponent(s.instanceId)}`);
  assert.strictEqual(env.VISTACLAIR_INSTANCE_ID, s.instanceId);
  assert.strictEqual(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.strictEqual(env.PATH, process.env.PATH, 'it replaces process.env, so it carries it');
  assert.ok(s.instanceId.startsWith('cli-'), 'the proxy and hooks see the usual instance id');
  s.kill();
});

test('options: settings.auth subscription runs on the OAuth login, with no API key in the env', async () => {
  setLogin(SIGNED_IN);
  try {
    const { s, calls, events } = makeSession({ auth: 'subscription' });
    s.spawn(tmp('proj-'), 80, 24, {});
    const env = calls[0].options.env;
    assert.strictEqual(env.ANTHROPIC_API_KEY, undefined, 'the server env key may not win');
    assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-should-not-pass', 'the OAuth credential stays');
    assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, undefined);
    // Claude Code confirming the subscription is quiet; the key is a warning.
    calls[0].emit({ type: 'system', subtype: 'init', apiKeySource: 'none', session_id: s.sessId });
    await tick();
    assert.ok(!events().some(e => e.ev.platform?.kind === 'notice'));
    calls[0].emit({ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY', session_id: s.sessId });
    await tick();
    assert.match(events().find(e => e.ev.platform?.kind === 'notice').ev.platform.text, /not the Claude subscription/);
    s.kill();

    // Unset follows the global default: the subscription when one is active,
    // though an API key exists too (without one, the key: the test above).
    const b = makeSession();
    b.s.spawn(tmp('proj-'), 80, 24, {});
    assert.strictEqual(b.calls[0].options.env.ANTHROPIC_API_KEY, undefined);
    b.s.kill();
    // settings.auth apikey still picks the key.
    const c = makeSession({ auth: 'apikey' });
    c.s.spawn(tmp('proj-'), 80, 24, {});
    assert.strictEqual(c.calls[0].options.env.ANTHROPIC_API_KEY, 'sk-ant-test');
    c.s.kill();
  } finally {
    setLogin(SIGNED_OUT);
  }
});

test('a refused subscription login asks the dashboard to sign in, once per spawn', async () => {
  setLogin(SIGNED_IN);
  try {
    const { s, calls, broadcasts } = makeSession({ auth: 'subscription' });
    s.spawn(tmp('proj-'), 80, 24, {});
    const refused = { type: 'assistant', error: 'authentication_failed', message: { content: [] }, parent_tool_use_id: null, session_id: s.sessId };
    calls[0].emit(refused);
    calls[0].emit(refused);
    await tick();
    const needed = broadcasts.filter(b => b.type === 'claude-auth:needed');
    assert.deepEqual(needed, [{ type: 'claude-auth:needed', reason: 'authentication_failed', sessId: s.sessId }]);
    s.kill();
    // On the API key it is not a sign-in matter.
    const k = makeSession({ auth: 'apikey' });
    k.s.spawn(tmp('proj-'), 80, 24, {});
    k.calls[0].emit({ ...refused, session_id: k.s.sessId });
    await tick();
    assert.ok(!k.broadcasts.some(b => b.type === 'claude-auth:needed'));
    k.s.kill();
  } finally {
    setLogin(SIGNED_OUT);
  }
});

test('options: a resume passes resume, not sessionId; no credential refuses the spawn', () => {
  const { s, calls } = makeSession();
  const id = '11111111-2222-3333-4444-555555555555';
  s.spawn(tmp('proj-'), 80, 24, { resumeSessionId: id });
  assert.strictEqual(calls[0].options.resume, id);
  assert.strictEqual(calls[0].options.sessionId, undefined);
  assert.strictEqual(s.sessId, id);
  s.kill();

  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const b = makeSession();
    assert.throws(() => b.s.spawn(tmp('proj-'), 80, 24, {}), /needs a Claude credential/);
    assert.strictEqual(b.calls.length, 0);
    assert.strictEqual(b.s.running, false);
  } finally {
    process.env.ANTHROPIC_API_KEY = saved;
  }
});

// --- Events ---

test('every message is broadcast; all but stream_event go to transcript.jsonl and history', async () => {
  const { s, calls, events } = makeSession({ orchestration: { runId: 'r1', role: 'orchestrator', runDir: HOME } });
  s.spawn(tmp('proj-'), 80, 24, {});
  const q = calls[0];
  q.emit({ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY', session_id: s.sessId });
  q.emit({ type: 'stream_event', event: { type: 'content_block_delta' }, parent_tool_use_id: null });
  q.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] }, parent_tool_use_id: null });
  q.emit({ type: 'result', subtype: 'success', total_cost_usd: 0.42, modelUsage: {}, queued_turn_count: 0 });
  await tick();

  const evs = events();
  assert.ok(evs.every(e => e.sessId === s.sessId && e.runId === 'r1'));
  const sdkTypes = evs.filter(e => e.ev.sdk).map(e => e.ev.sdk.type);
  assert.deepStrictEqual(sdkTypes, ['system', 'stream_event', 'assistant', 'result']);
  const states = evs.filter(e => e.ev.platform?.kind === 'status').map(e => e.ev.platform.state);
  assert.deepStrictEqual(states, ['idle', 'busy', 'idle']);
  assert.strictEqual(evs.at(-1).ev.platform.costUsd, 0.42);
  assert.strictEqual(s.costUsd, 0.42);
  assert.strictEqual(s.busy, false);

  const file = lines(s.settings.sessionDir);
  assert.ok(!file.some(e => e.ev.sdk?.type === 'stream_event'), 'no deltas in the transcript');
  assert.deepStrictEqual(file.filter(e => e.ev.sdk).map(e => e.ev.sdk.type), ['system', 'assistant', 'result']);
  assert.deepStrictEqual(s.history().map(e => e.ev), file.map(e => e.ev));
  assert.deepStrictEqual(SdkSession.readTranscript(s.settings.sessionDir, { sessId: s.sessId }).length, file.length);

  // A credential that is not the API key is called out.
  q.emit({ type: 'system', subtype: 'init', apiKeySource: 'oauth' });
  await tick();
  assert.match(events().at(-1).ev.platform.text, /"oauth", not the API key/);
  s.kill();
});

test('cost falls back to modelUsage; queued turns keep it busy; an open question is "awaiting"', async () => {
  const { s, calls } = makeSession();
  s.spawn(tmp('proj-'), 80, 24, {});
  s.submit('go');
  assert.strictEqual(s.state, 'busy');
  s.setAwaiting(true);
  assert.strictEqual(s.state, 'awaiting');
  assert.strictEqual(s.busy, true);
  s.setAwaiting(false);
  assert.strictEqual(s.state, 'busy');
  calls[0].emit({ type: 'result', modelUsage: { a: { costUSD: 0.1 }, b: { costUSD: 0.2 } }, queued_turn_count: 1 });
  await tick();
  assert.ok(Math.abs(s.costUsd - 0.3) < 1e-9);
  assert.strictEqual(s.state, 'busy', 'a queued send means another turn follows');
  calls[0].emit({ type: 'result', total_cost_usd: 0.5, queued_turn_count: 0 });
  await tick();
  assert.strictEqual(s.state, 'idle');
  s.kill();
});

test('a turn\'s proxied requests (subagents included) raise the cost live; the result settles it', async () => {
  const { s, calls, events } = makeSession();
  const pricing = { inputCostPerMTok: 1, outputCostPerMTok: 5, cacheReadCostPerMTok: 0.1, cacheCreateCostPerMTok: 1.25 };
  s.spawn(tmp('proj-'), 80, 24, {});
  s.addRequestCost({ input_tokens: 1e6 }, pricing);
  assert.strictEqual(s.costUsd, 0, 'idle before the first send: nothing is in flight');
  s.submit('go');
  s.addRequestCost({ input_tokens: 1e6, output_tokens: 1e5 }, pricing);          // main loop: 1 + 0.5
  s.addRequestCost({ cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }, pricing); // subagent: 0.1 + 1.25
  assert.ok(Math.abs(s.costUsd - 2.85) < 1e-9);
  assert.ok(Math.abs(events().filter(e => e.ev.platform?.kind === 'status').at(-1).ev.platform.costUsd - 2.85) < 1e-9, 'the panel sees it');
  calls[0].emit({ type: 'result', total_cost_usd: 2.9, queued_turn_count: 0 });
  await tick();
  assert.strictEqual(s.costUsd, 2.9, 'the SDK total replaces the estimate');
  s.addRequestCost({ output_tokens: 1e6 }, pricing);
  assert.strictEqual(s.costUsd, 2.9, 'a request reported after the result is already in it');
  s.kill();
});

test('the manager routes a proxied interaction to its SDK session by instance id', () => {
  const mgr = new CliSessionManager(9999, { broadcast() {} }, store, {});
  const seen = [];
  mgr.sessions.set('t1', { kind: 'sdk', instanceId: 'cli-a', addRequestCost: (u, p) => seen.push([u, p]) });
  mgr.sessions.set('t2', { kind: 'cli', instanceId: 'cli-b', addRequestCost: () => seen.push('cli') });
  mgr.noteInteraction({ instanceId: 'cli-a', usage: { input_tokens: 1 }, pricing: { inputCostPerMTok: 1 } });
  mgr.noteInteraction({ instanceId: 'cli-b', usage: {}, pricing: {} });
  mgr.noteInteraction({ instanceId: 'nobody' });
  assert.deepStrictEqual(seen, [[{ input_tokens: 1 }, { inputCostPerMTok: 1 }]]);
});

// --- Model, cost carry-over, folder signals ---

const statuses = (events) => events().filter(e => e.ev.platform?.kind === 'status').map(e => e.ev.platform);

test('setModel: live on a running query, settings only when not running; refused when exited or invalid', async () => {
  const { s, calls, events } = makeSession({ model: 'sonnet', modelMap: { fable: null, opus: 'gpt-x', sonnet: null, haiku: null } });
  s.spawn(tmp('proj-'), 80, 24, {});
  assert.deepStrictEqual(statuses(events)[0], { kind: 'status', state: 'idle', costUsd: 0, model: 'sonnet', actualModel: null, mappedTo: null });
  assert.deepStrictEqual(await s.setModel('claude-opus-4-5[1m]'), { ok: true, model: 'claude-opus-4-5[1m]' });
  assert.deepStrictEqual(calls[0].models, ['claude-opus-4-5[1m]']);
  assert.strictEqual(s.settings.model, 'claude-opus-4-5[1m]');
  assert.deepStrictEqual(statuses(events).at(-1), { kind: 'status', state: 'idle', costUsd: 0, model: 'claude-opus-4-5[1m]', actualModel: null, mappedTo: 'gpt-x' });
  await assert.rejects(s.setModel('bad model'), /invalid model/);
  await assert.rejects(s.setModel(''), /invalid model/);
  await assert.rejects(s.setModel(undefined), /invalid model/);
  assert.deepStrictEqual(calls[0].models, ['claude-opus-4-5[1m]'], 'a refused model reaches nothing');
  calls[0].end();
  await tick();
  await assert.rejects(s.setModel('haiku'), /exited/);
  assert.strictEqual(s.settings.model, 'claude-opus-4-5[1m]');

  // Never spawned: the settings carry it into the first spawn.
  const b = makeSession();
  await b.s.setModel('haiku');
  assert.strictEqual(b.s.settings.model, 'haiku');
  assert.strictEqual(b.calls.length, 0);
  b.s.spawn(tmp('proj-'), 80, 24, {});
  assert.strictEqual(b.calls[0].options.model, 'haiku');
  b.s.kill();
});

test('status: the init model when none is chosen, and the model of the last main-agent reply', async () => {
  const { s, calls, events } = makeSession();
  s.spawn(tmp('proj-'), 80, 24, {});
  const q = calls[0];
  q.emit({ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-4-5' });
  await tick();
  assert.strictEqual(statuses(events).at(-1).model, 'claude-sonnet-4-5');
  q.emit({ type: 'assistant', message: { model: 'claude-sonnet-4-5-20250929', content: [] }, parent_tool_use_id: null });
  await tick();
  assert.strictEqual(statuses(events).at(-1).actualModel, 'claude-sonnet-4-5-20250929');
  assert.strictEqual(statuses(events).at(-1).state, 'busy');
  // A subagent's or a synthetic reply leaves it; a change while busy is reported.
  const before = statuses(events).length;
  q.emit({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [] }, parent_tool_use_id: 'toolu_sub' });
  q.emit({ type: 'assistant', message: { model: '<synthetic>', content: [] }, parent_tool_use_id: null });
  await tick();
  assert.strictEqual(statuses(events).length, before);
  q.emit({ type: 'assistant', message: { model: 'claude-opus-4-5', content: [] }, parent_tool_use_id: null });
  await tick();
  assert.strictEqual(statuses(events).length, before + 1);
  assert.strictEqual(s.actualModel, 'claude-opus-4-5');
  // A switch clears it until the next reply.
  await s.setModel('haiku');
  assert.deepStrictEqual([statuses(events).at(-1).model, statuses(events).at(-1).actualModel], ['haiku', null]);
  s.kill();
});

test('status: the main agent\'s context from each reply\'s usage, the window from the result, corrected by getContextUsage', async () => {
  const { s, sdk, calls, events } = makeSession({ model: 'opus[1m]' });
  s.spawn(tmp('proj-'), 80, 24, {});
  const q = calls[0];
  const usage = (n) => ({ input_tokens: 2, cache_read_input_tokens: n, cache_creation_input_tokens: 1000, output_tokens: 50 });
  const reply = (n, pk = null) => q.emit({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: usage(n), content: [] }, parent_tool_use_id: pk });
  reply(141000);
  await tick();
  // Before any result: a [1m] model's window, an estimate.
  assert.deepStrictEqual(statuses(events).at(-1).context, { tokens: 142002, window: 1000000, compactAt: null, windowEstimated: true });
  // The same reply's next block, and a subagent's reply, are no news.
  const before = statuses(events).length;
  reply(141000);
  reply(5000, 'toolu_sub');
  await tick();
  assert.strictEqual(statuses(events).length, before);
  assert.strictEqual(s.context.tokens, 142002);
  // The result names the window of the model that answered (not the subagent's), then the SDK's count corrects it.
  sdk.contextUsage = { totalTokens: 150000, maxTokens: 980000, rawMaxTokens: 1000000, autoCompactThreshold: 900000, isAutoCompactEnabled: true };
  q.emit({ type: 'result', subtype: 'success', total_cost_usd: 1, modelUsage: {
    'claude-haiku-4-5': { contextWindow: 200000 }, 'claude-opus-5-5[1m]': { contextWindow: 1000000 },
  } });
  await tick();
  assert.deepStrictEqual(q.contextAsks, [{ detail: 'summary' }], 'summary only: no token-count call');
  assert.deepStrictEqual(statuses(events).at(-1).context, { tokens: 150000, window: 1000000, compactAt: 900000, windowEstimated: false });
  // A compaction drops it at once.
  q.emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000, post_tokens: 20000 } });
  await tick();
  assert.strictEqual(statuses(events).at(-1).context.tokens, 20000);
  // A switch: the catalogue's window for the new model until its first result.
  await s.setModel('haiku');
  assert.deepStrictEqual(statuses(events).at(-1).context, { tokens: 20000, window: 200000, compactAt: null, windowEstimated: true });
  // A model the catalogue does not know: no window at all.
  await s.setModel('default');
  assert.deepStrictEqual(statuses(events).at(-1).context, { tokens: 20000, window: null, compactAt: null, windowEstimated: false });
  s.kill();
});

test('status: a first turn without [1m] estimates the window from the catalogue, the answering model first', async () => {
  const { s, sdk, calls, events } = makeSession({ model: 'sonnet' });
  s.spawn(tmp('proj-'), 80, 24, {});
  const q = calls[0];
  const usage = { input_tokens: 2, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0, output_tokens: 50 };
  q.emit({ type: 'assistant', message: { model: 'claude-haiku-4-5-20251001', usage, content: [] }, parent_tool_use_id: null });
  await tick();
  assert.deepStrictEqual(statuses(events).at(-1).context, { tokens: 40002, window: 200000, compactAt: null, windowEstimated: true });
  // Another answering model re-estimates while the window is still an estimate.
  q.emit({ type: 'assistant', message: { model: 'claude-sonnet-4-6', usage, content: [] }, parent_tool_use_id: null });
  await tick();
  assert.deepStrictEqual(statuses(events).at(-1).context, { tokens: 40002, window: 1000000, compactAt: null, windowEstimated: true });
  // The result's modelUsage replaces it; without getContextUsage's answer it stands.
  sdk.contextUsage = null;
  q.emit({ type: 'result', subtype: 'success', total_cost_usd: 1, modelUsage: { 'claude-sonnet-4-6': { contextWindow: 200000 } } });
  await tick();
  assert.deepStrictEqual(statuses(events).at(-1).context, { tokens: 40002, window: 200000, compactAt: null, windowEstimated: false });
  // An exact window is not re-estimated by a later reply.
  q.emit({ type: 'assistant', message: { model: 'claude-haiku-4-5', usage: { ...usage, input_tokens: 9 }, content: [] }, parent_tool_use_id: null });
  await tick();
  assert.deepStrictEqual(statuses(events).at(-1).context, { tokens: 40009, window: 200000, compactAt: null, windowEstimated: false });
  s.kill();
});

test('status: a model the catalogue does not know has no window until a turn\'s end gives one', async () => {
  const { s, sdk, calls, events } = makeSession({ model: 'default' });
  s.spawn(tmp('proj-'), 80, 24, {});
  const q = calls[0];
  q.emit({ type: 'assistant', message: { model: 'claude-unknown-9', usage: { input_tokens: 45000 }, content: [] }, parent_tool_use_id: null });
  await tick();
  assert.deepStrictEqual(statuses(events).at(-1).context, { tokens: 45000, window: null, compactAt: null, windowEstimated: false });
  sdk.contextUsage = { totalTokens: 45000, maxTokens: 500000, autoCompactThreshold: 0, isAutoCompactEnabled: false };
  q.emit({ type: 'result', subtype: 'success', total_cost_usd: 1, modelUsage: {} });
  await tick();
  assert.deepStrictEqual(statuses(events).at(-1).context, { tokens: 45000, window: 500000, compactAt: null, windowEstimated: false });
  s.kill();
});

test('status: no context field before a main-agent reply has counted one', async () => {
  const { s, calls, events } = makeSession();
  s.spawn(tmp('proj-'), 80, 24, {});
  calls[0].emit({ type: 'system', subtype: 'init', model: 'claude-sonnet-5' });
  calls[0].emit({ type: 'assistant', message: { model: 'claude-sonnet-5', content: [] }, parent_tool_use_id: null });
  await tick();
  assert.ok(statuses(events).length > 0);
  assert.ok(statuses(events).every(st => !('context' in st)));
  s.kill();
});

test('a resume carries its cost on: seeded from the transcript, never lowered, raised by seedCost', async () => {
  const { s, calls, events } = makeSession();
  const id = '77777777-2222-3333-4444-555555555555';
  const env = (sessId, ev) => JSON.stringify({ sessId, ts: 1, ev });
  fs.writeFileSync(path.join(s.settings.sessionDir, 'transcript.jsonl'), [
    env(id, { sdk: { type: 'result', total_cost_usd: 0.9 } }),
    env(id, { platform: { kind: 'status', state: 'exited', costUsd: 1.23 } }),
    env(id, { platform: { kind: 'status', state: 'idle', costUsd: 0 } }),
    // An earlier session of the same folder does not count.
    env('88888888-2222-3333-4444-555555555555', { platform: { kind: 'status', state: 'exited', costUsd: 9.9 } }),
  ].join('\n') + '\n');
  assert.strictEqual(SdkSession.recordedCost(s.settings.sessionDir, id), 1.23);
  s.spawn(tmp('proj-'), 80, 24, { resumeSessionId: id });
  assert.strictEqual(statuses(events)[0].costUsd, 1.23, 'the first status already shows it');
  calls[0].emit({ type: 'result', total_cost_usd: 0.5, queued_turn_count: 0 });
  await tick();
  assert.strictEqual(s.costUsd, 1.23);
  calls[0].emit({ type: 'result', total_cost_usd: 2.0, queued_turn_count: 0 });
  await tick();
  assert.strictEqual(s.costUsd, 2.0);
  s.seedCost(1.5);
  assert.strictEqual(s.costUsd, 2.0);
  s.seedCost(3);
  assert.strictEqual(s.costUsd, 3);
  assert.strictEqual(statuses(events).at(-1).costUsd, 3);
  s.kill();

  // A new conversation starts at zero.
  const b = makeSession({ sessionDir: s.settings.sessionDir });
  b.s.spawn(tmp('proj-'), 80, 24, {});
  assert.strictEqual(b.s.costUsd, 0);
  b.s.kill();
});

test('files: a main-agent write to TODO.md / NOTES.md is signalled when its result arrives, never kept', async () => {
  const { s, calls, events } = makeSession();
  const dir = s.settings.sessionDir;
  s.spawn(dir, 80, 24, {});
  const q = calls[0];
  const use = (id, name, input, parent = null) => q.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: parent });
  const result = (id, parent = null) => q.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, parent_tool_use_id: parent });
  const files = () => events().filter(e => e.ev.platform?.kind === 'files').map(e => e.ev.platform);

  use('t1', 'Edit', { file_path: path.join(dir, 'TODO.md'), old_string: 'a', new_string: 'b' });
  await tick();
  assert.deepStrictEqual(files(), [], 'nothing before the result');
  result('t1');
  await tick();
  assert.deepStrictEqual(files(), [{ kind: 'files', todo: true, notes: false }]);

  use('t2', 'Edit', { file_path: path.join(dir, 'other.md') });
  result('t2');
  use('t3', 'Write', { file_path: path.join(dir, 'NOTES.md') }, 'toolu_sub');
  result('t3', 'toolu_sub');
  await tick();
  assert.strictEqual(files().length, 1, 'another file or a subagent: nothing');

  use('t4', 'Bash', { command: 'sed -i s/a/b/ NOTES.md' });   // bare: the session runs in its folder
  result('t4');
  use('t5', 'MultiEdit', { file_path: 'TODO.md' });
  result('t5');
  await tick();
  assert.deepStrictEqual(files().slice(1), [{ kind: 'files', todo: false, notes: true }, { kind: 'files', todo: true, notes: false }]);
  assert.ok(!lines(dir).some(e => e.ev.platform?.kind === 'files'), 'not in the transcript');
  s.kill();
});

// --- submit ---

test('submit: a user message per call, priority passed through, a user envelope with the sender', async () => {
  const { s, calls, events } = makeSession();
  s.spawn(tmp('proj-'), 80, 24, {});
  s.submit('plain');
  s.submit('[message from orch-x] do it', { priority: 'next', from: 'orch-x' });
  s.submit('now', { priority: 'now' });
  await tick();
  const inputs = calls[0].inputs;
  assert.strictEqual(inputs.length, 3);
  assert.match(inputs[0].uuid, /^[0-9a-f-]{36}$/);
  assert.deepStrictEqual(inputs[0], { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'plain' }] }, parent_tool_use_id: null, uuid: inputs[0].uuid });
  assert.strictEqual(new Set(inputs.map(m => m.uuid)).size, 3, 'one uuid per message');
  assert.strictEqual(inputs[1].priority, 'next');
  assert.strictEqual(inputs[2].priority, 'now');
  const users = events().filter(e => e.ev.user).map(e => e.ev.user);
  assert.deepStrictEqual(users[0], { id: inputs[0].uuid, text: 'plain', images: [], pending: true });
  assert.deepStrictEqual(users[1], { text: '[message from orch-x] do it', images: [], from: 'orch-x' });
  assert.ok(lines(s.settings.sessionDir).some(e => e.ev.user?.from === 'orch-x'));

  assert.throws(() => s.submit('x', { priority: 'soon' }), /unknown priority/);
  assert.throws(() => s.submit('   '), /nothing to send/);
  s.kill();
  assert.throws(() => s.submit('late'), /not running/);
});

test('submit: images are saved under uploads/, sent as base64 blocks, served by the upload route', async () => {
  const { s, calls, events } = makeSession();
  s.spawn(tmp('proj-'), 80, 24, {});
  const png = Buffer.from('89504e470d0a1a0a0000', 'hex');
  const r = s.submit('look', { images: [{ mediaType: 'image/png', base64: png.toString('base64'), name: '../../evil name.png' }] });
  await tick();
  const [img, text] = calls[0].inputs[0].message.content;
  assert.deepStrictEqual(img, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } });
  assert.deepStrictEqual(text, { type: 'text', text: 'look' });

  const name = r.images[0].name;
  assert.match(name, /^\d+-1-evil_name\.png$/);
  const file = path.join(s.settings.sessionDir, 'uploads', name);
  assert.deepStrictEqual(fs.readFileSync(file), png);
  const user = events().find(e => e.ev.user).ev.user;
  assert.strictEqual(user.pending, true);
  assert.deepStrictEqual(user.images, [{ name, url: `/api/sdk/upload?sessId=${s.sessId}&name=${encodeURIComponent(name)}` }]);

  // Refusals: type, size, together.
  assert.throws(() => s.submit('x', { images: [{ mediaType: 'text/html', base64: 'AAAA' }] }), /unsupported type/);
  const big = Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64');
  assert.throws(() => s.submit('x', { images: [{ mediaType: 'image/png', base64: big }] }), /over 8 MB/);
  const seven = Buffer.alloc(7 * 1024 * 1024).toString('base64');
  assert.throws(() => s.submit('x', { images: [1, 2, 3].map(() => ({ mediaType: 'image/png', base64: seven })) }), /over 18 MB/);
  assert.strictEqual(calls[0].inputs.length, 1, 'a refused submit sends nothing');

  // The route: the file, and nothing outside uploads/.
  const route = SdkSession.uploadRoute({ sessionDirOf: (id) => (id === s.sessId ? s.settings.sessionDir : null) });
  const call = (query) => new Promise((resolve) => {
    const res = { code: 200, headers: {}, status(c) { this.code = c; return this; }, set(h) { Object.assign(this.headers, h); return this; }, json(b) { resolve({ code: this.code, body: b }); }, send(b) { resolve({ code: this.code, body: b, headers: this.headers }); } };
    route({ query }, res);
  });
  const ok = await call({ sessId: s.sessId, name });
  assert.strictEqual(ok.code, 200);
  assert.deepStrictEqual(ok.body, png);
  assert.strictEqual(ok.headers['Content-Type'], 'image/png');
  fs.writeFileSync(path.join(s.settings.sessionDir, 'secret.png'), 'x');
  assert.strictEqual((await call({ sessId: s.sessId, name: '../secret.png' })).code, 400);
  assert.strictEqual((await call({ sessId: s.sessId, name: 'transcript.jsonl' })).code, 400);
  assert.strictEqual((await call({ sessId: 'not-a-uuid', name })).code, 400);
  assert.strictEqual((await call({ sessId: '00000000-0000-0000-0000-000000000000', name })).code, 404);
  s.kill();
});

// --- The owner's turns: waiting, then taken in ---

// The CLI's echo of an input message (--replay-user-messages).
const echo = (m, sessId) => ({ type: 'user', message: m.message, parent_tool_use_id: null, uuid: m.uuid, session_id: sessId, isReplay: true });

test('input: pending at submit, delivered when the CLI echoes it; the echo is not broadcast', async () => {
  const { s, calls, events } = makeSession();
  s.spawn(tmp('proj-'), 80, 24, {});
  assert.deepStrictEqual(calls[0].options.extraArgs, { 'replay-user-messages': null });
  const q = calls[0];
  const png = Buffer.from('89504e470d0a1a0a0000', 'hex').toString('base64');
  const r1 = s.submit('first', { images: [{ mediaType: 'image/png', base64: png, name: 'a.png' }] });
  s.submit('second');
  s.submit('brief', { from: 'orch-x' });
  await tick();
  const [m1, m2, m3] = q.inputs;
  assert.strictEqual(r1.id, m1.uuid);
  const users = () => events().filter(e => e.ev.user).map(e => e.ev.user);
  assert.deepStrictEqual(users().map(u => [u.id, !!u.pending]), [[m1.uuid, true], [m2.uuid, true], [undefined, false]], 'a `from` turn is drawn at once');

  q.emit(echo(m1, s.sessId));
  q.emit({ type: 'system', subtype: 'init', session_id: s.sessId });
  q.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'one' }] }, parent_tool_use_id: null });
  q.emit(echo(m3, s.sessId));
  q.emit({ type: 'result', subtype: 'success', total_cost_usd: 0.1, queued_turn_count: 1 });
  await tick();
  const delivered = users()[3];
  assert.deepStrictEqual(delivered, { id: m1.uuid, text: 'first', images: r1.images }, 'the bubble, images and all');
  assert.strictEqual(users().length, 4, 'the second waits on through a result; the `from` echo adds nothing');
  assert.ok(!events().some(e => e.ev.sdk?.isReplay), 'echoes are never broadcast');

  // Two waiting turns folded into one: a bubble each, where each is taken in.
  s.submit('third');
  await tick();
  q.emit(echo(m2, s.sessId));
  q.emit(echo(q.inputs[3], s.sessId));
  await tick();
  assert.deepStrictEqual(users().slice(-2).map(u => [u.text, !!u.pending]), [['second', false], ['third', false]]);

  // History holds the same sequence: pending, then delivered.
  const hist = lines(s.settings.sessionDir).filter(e => e.ev.user?.id === m1.uuid).map(e => !!e.ev.user.pending);
  assert.deepStrictEqual(hist, [true, false]);
  assert.ok(!lines(s.settings.sessionDir).some(e => e.ev.sdk?.isReplay));
  s.kill();
});

test('input: a CLI that never echoes delivers what waits at the next init or result', async () => {
  const { s, calls, events } = makeSession();
  s.spawn(tmp('proj-'), 80, 24, {});
  const q = calls[0];
  const users = () => events().filter(e => e.ev.user).map(e => e.ev.user);
  s.submit('a');
  await tick();
  q.emit({ type: 'system', subtype: 'init', session_id: s.sessId });
  await tick();
  assert.deepStrictEqual(users().map(u => [u.text, !!u.pending]), [['a', true], ['a', false]], 'at the turn\'s init');
  s.submit('b');
  await tick();
  q.emit({ type: 'result', subtype: 'success', queued_turn_count: 1, parent_tool_use_id: 'toolu_sub' });
  await tick();
  assert.strictEqual(users().length, 3, 'a subagent\'s result is not the turn\'s');
  q.emit({ type: 'result', subtype: 'success', queued_turn_count: 1 });
  await tick();
  assert.deepStrictEqual(users().map(u => [u.text, !!u.pending]), [['a', true], ['a', false], ['b', true], ['b', false]], 'at the turn\'s result');

  // Once the CLI has echoed one, init and result no longer stand in.
  s.submit('c');
  await tick();
  q.emit(echo(q.inputs[2], s.sessId));
  await tick();
  s.submit('d');
  await tick();
  q.emit({ type: 'result', subtype: 'success', queued_turn_count: 1 });
  q.emit({ type: 'system', subtype: 'init', session_id: s.sessId });
  await tick();
  assert.deepStrictEqual(users().slice(-3).map(u => [u.text, !!u.pending]), [['c', true], ['c', false], ['d', true]], 'd waits for its echo');
  s.kill();
});

test('input: cancelled by an interrupt that lists it, or when the session ends; stale ones on the next spawn', async () => {
  const { s, sdk, calls, events } = makeSession();
  s.spawn(tmp('proj-'), 80, 24, {});
  const users = () => events().filter(e => e.ev.user).map(e => e.ev.user);
  s.submit('keep');
  s.submit('drop');
  await tick();
  const [keep, drop] = calls[0].inputs;
  sdk.interruptReceipt = { still_queued: [keep.uuid], cancelled: [drop.uuid, 'not-ours'] };
  await s.interrupt();
  assert.deepStrictEqual(users().at(-1), { id: drop.uuid, cancelled: true, reason: 'interrupted' });
  assert.strictEqual(users().filter(u => u.cancelled).length, 1, 'unknown uuids are ignored');
  // An older CLI's interrupt resolves to nothing: the turns wait on.
  sdk.interruptReceipt = undefined;
  await s.interrupt();
  assert.strictEqual(users().filter(u => u.cancelled).length, 1);

  // The query ending: what still waits will never run.
  calls[0].end();
  await tick();
  assert.deepStrictEqual(users().at(-1), { id: keep.uuid, cancelled: true, reason: 'ended' });
  const exitAt = events().findIndex(e => e.ev.platform?.state === 'exited');
  assert.ok(events().findIndex(e => e.ev.user?.cancelled && e.ev.user.id === keep.uuid) < exitAt, 'before the exit status');

  // kill() and a respawn alike.
  const b = makeSession();
  b.s.spawn(tmp('proj-'), 80, 24, {});
  b.s.submit('x');
  b.s.spawn(tmp('proj-'), 80, 24, {});
  await tick();
  assert.deepStrictEqual(b.events().filter(e => e.ev.user).map(e => [!!e.ev.user.pending, !!e.ev.user.cancelled]), [[true, false], [false, true]]);
  b.s.kill();

  // A transcript a stopped server left with a waiting turn: the next spawn
  // in that folder cancels it.
  const c = makeSession();
  const dir = c.s.settings.sessionDir;
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), [
    { sessId: 'old', ts: 1, ev: { user: { id: 'u-left', text: 'lost', images: [], pending: true } } },
    { sessId: 'old', ts: 2, ev: { user: { id: 'u-done', text: 'ran', images: [], pending: true } } },
    { sessId: 'old', ts: 3, ev: { user: { id: 'u-done', text: 'ran', images: [] } } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  c.s.spawn(tmp('proj-'), 80, 24, {});
  assert.deepStrictEqual(c.events().filter(e => e.ev.user).map(e => e.ev.user), [{ id: 'u-left', cancelled: true, reason: 'ended' }]);
  c.s.kill();
});

test('interrupt calls query.interrupt; the PTY contract: Esc interrupts, typed text submits on CR', async () => {
  const { s, calls } = makeSession();
  s.spawn(tmp('proj-'), 80, 24, {});
  await s.interrupt();
  s.write('\x1b');
  await tick();
  assert.strictEqual(calls[0].interrupts, 2);
  s.writeWhenReady('typed prompt');
  s.writeWhenReady('\r', undefined, 0);
  await tick();
  assert.strictEqual(calls[0].inputs.at(-1).message.content[0].text, 'typed prompt');
  s.kill();
});

// --- Exit ---

test('the query ending reports cli:exit like a PTY exit; kill does too; a respawn silences the old one', async () => {
  const a = makeSession();
  a.s.spawn(tmp('proj-'), 80, 24, {});
  assert.strictEqual(a.s.running, true);
  a.calls[0].end();
  await tick();
  const exits = a.broadcasts.filter(b => b.type === 'cli:exit');
  assert.deepStrictEqual(exits, [{ type: 'cli:exit', tabId: 'tab-x', exitCode: 0 }]);
  assert.strictEqual(a.s.status, 'exited');
  assert.strictEqual(a.s.running, false);
  assert.strictEqual(a.events().at(-1).ev.platform.state, 'exited');

  const b = makeSession();
  b.s.spawn(tmp('proj-'), 80, 24, {});
  b.s.notePaused();
  b.s.kill();
  await tick();
  assert.strictEqual(b.calls[0].inputEnded, true, 'the input queue is closed');
  assert.strictEqual(b.broadcasts.filter(m => m.type === 'cli:exit').length, 1);
  assert.strictEqual(b.events().at(-1).ev.platform.state, 'paused', 'a completed pause reads paused');

  const c = makeSession();
  c.s.spawn(tmp('proj-'), 80, 24, {});
  c.s.spawn(tmp('proj-'), 80, 24, {});
  await tick();
  assert.strictEqual(c.broadcasts.filter(m => m.type === 'cli:exit').length, 0);
  assert.strictEqual(c.calls.length, 2);
  assert.strictEqual(c.s.running, true);
  c.s.kill();

  // A failing query: exit code 1 and an error notice.
  const d = makeSession();
  d.s.spawn(tmp('proj-'), 80, 24, {});
  d.calls[0].fail(new Error('claude died'));
  await tick();
  assert.deepStrictEqual(d.broadcasts.filter(m => m.type === 'cli:exit').map(m => m.exitCode), [1]);
  assert.ok(d.events().some(e => e.ev.platform?.kind === 'notice' && /claude died/.test(e.ev.platform.text)));
});

test('a resume with no transcript.jsonl is seeded from the SDK transcript, before new events', async () => {
  const { s, sdk, calls } = makeSession();
  sdk.sessionMessages = [
    { type: 'user', uuid: 'u1', session_id: 'x', message: { role: 'user', content: 'earlier prompt' }, parent_tool_use_id: null },
    { type: 'assistant', uuid: 'a1', session_id: 'x', message: { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] }, parent_tool_use_id: null },
  ];
  const cwd = tmp('proj-');
  const id = '99999999-2222-3333-4444-555555555555';
  s.spawn(cwd, 80, 24, { resumeSessionId: id });
  s.submit('next prompt');
  await tick(20);
  calls[0].emit({ type: 'assistant', message: { content: [] }, parent_tool_use_id: null });
  await tick();
  assert.deepStrictEqual(sdk.seededFrom, { id, opts: { dir: cwd } });
  const evs = lines(s.settings.sessionDir).map(e => e.ev);
  assert.match(evs[0].platform.text, /Continued from an earlier session/);
  assert.deepStrictEqual(evs[1], { user: { text: 'earlier prompt', images: [] } });
  assert.strictEqual(evs[2].sdk.message.content[0].text, 'earlier answer');
  const after = evs.slice(3);
  assert.ok(after.some(e => e.user?.text === 'next prompt'), 'held-back events follow the seed');
  assert.strictEqual(after.at(-1).sdk.type, 'assistant');
  s.kill();
});

// --- The manager ---

test('the manager: engine sdk makes an SdkSession, carried by list, manifest, history and exit callbacks', async () => {
  const { sdk, calls } = fakeSdk();
  const broadcasts = [];
  const mgr = new CliSessionManager(9999, { broadcast: (m) => broadcasts.push(m) }, store, { sdk, claudeBin: '/opt/claude' });
  const cwd = tmp('proj-');
  const tabId = mgr.nextTabId();
  mgr.getOrCreate(tabId).resizeFrom({}, 80, 24);   // cli:open sizes the tab first
  const exited = [];
  mgr.onExit(tabId, (id) => exited.push(id));
  mgr.launchSession(tabId, { cwd, settings: { engine: 'sdk', model: 'sonnet' }, prompt: 'first prompt', autoSubmit: true });

  const s = mgr.get(tabId);
  assert.ok(s instanceof SdkSession);
  assert.strictEqual(s.kind, 'sdk');
  await tick();
  assert.strictEqual(calls[0].inputs[0].message.content[0].text, 'first prompt');
  const tab = mgr.list().find(t => t.tabId === tabId);
  assert.strictEqual(tab.kind, 'sdk');
  assert.strictEqual(tab.settings.engine, 'sdk');
  assert.strictEqual(tab.state, 'busy');
  const manifest = JSON.parse(fs.readFileSync(path.join(HOME, 'data', 'cli-open-tabs.json'), 'utf8'));
  assert.strictEqual(manifest.find(e => e.sessId === s.sessId).kind, 'sdk');
  assert.strictEqual(manifest.find(e => e.sessId === s.sessId).busy, true, 'busy reaches the manifest');
  assert.strictEqual(mgr.findSaved(s.sessId).kind, 'sdk');
  assert.strictEqual(mgr.getBySessId(s.sessId), s);
  assert.strictEqual(mgr.sessionDirOf(s.sessId), s.settings.sessionDir);

  // The query ends: the same exit path as a PTY.
  calls[0].end();
  await tick();
  assert.deepStrictEqual(exited, [tabId]);
  assert.strictEqual(mgr.get(tabId), null);

  // An SDK run's worker is hidden, also when it comes back from history.
  const wTab = mgr.nextTabId();
  mgr.launchSession(wTab, { cwd, settings: { engine: 'sdk', orchestration: { runId: 'r', role: 'worker', workerId: 'w1', runDir: cwd } } });
  assert.strictEqual(mgr.get(wTab).hidden, true);
  assert.ok(!mgr.list().some(t => t.tabId === wTab));
  mgr.remove(wTab);

  // No API key: the launch throws and leaves no tab behind.
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const bad = mgr.nextTabId();
    assert.throws(() => mgr.launchSession(bad, { cwd, settings: { engine: 'sdk' } }), /API key/);
    assert.strictEqual(mgr.get(bad), null);
  } finally {
    process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('the manager: a model switch reaches the manifest and the saved entry', async () => {
  const { sdk, calls } = fakeSdk();
  const mgr = new CliSessionManager(9999, { broadcast() {} }, store, { sdk, claudeBin: '/opt/claude' });
  const tabId = mgr.nextTabId();
  mgr.launchSession(tabId, { cwd: tmp('proj-'), settings: { engine: 'sdk', model: 'sonnet' } });
  const s = mgr.get(tabId);
  await s.setModel('opus');
  assert.deepStrictEqual(calls[0].models, ['opus']);
  const manifest = JSON.parse(fs.readFileSync(path.join(HOME, 'data', 'cli-open-tabs.json'), 'utf8'));
  assert.strictEqual(manifest.find(e => e.sessId === s.sessId).settings.model, 'opus');
  assert.strictEqual(mgr.findSaved(s.sessId).settings.model, 'opus');
  mgr.remove(tabId);
});

test('an exit callback that relaunches into the same tab keeps the new session listed', async () => {
  const { sdk, calls } = fakeSdk();
  const mgr = new CliSessionManager(9999, { broadcast() {} }, store, { sdk, claudeBin: '/opt/claude' });
  const cwd = tmp('proj-');
  const tabId = mgr.nextTabId();
  mgr.launchSession(tabId, { cwd, settings: { engine: 'sdk' } });
  const first = mgr.get(tabId);
  mgr.onExit(tabId, () => mgr.launchSession(tabId, { cwd, settings: { engine: 'sdk' }, prompt: 'follow-up', autoSubmit: true, promptFrom: 'orch-r' }));

  calls[0].end();
  await tick();
  const second = mgr.get(tabId);
  assert.ok(second && second !== first, 'the relaunched session replaces the ended one');
  assert.ok(mgr.list().some(t => t.tabId === tabId));
  assert.strictEqual(calls[1].inputs[0].message.content[0].text, 'follow-up');
  mgr.remove(tabId);
});
