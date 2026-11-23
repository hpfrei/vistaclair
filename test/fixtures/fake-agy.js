#!/usr/bin/env node
// A fake `agy -p … --output-format stream-json` for test/agy-session.test.js.
// It does what the real one does at the seams Vistaclair relies on, and
// nothing against Google: reads <cwd>/.agents/hooks.json and mcp_config.json,
// runs the hooks with agy's stdin shapes, starts the MCP servers from the
// config, and prints recorded-shape stream-json.
//
// $FAKE_AGY_DIR/scenario.json: a list of turn modes, consumed one per run
// (the last one repeats):
//   report     SessionStart (new conversation), PreInvocation, a denied
//              write_file outside the worktree and an allowed one inside
//              (written), the orchestrator MCP `report` done, PreInvocation
//   noreport   one answer, no report
//   auth       "authentication required" on stderr, exit 1
//   quota      a RESOURCE_EXHAUSTED result, exit 1
//   wait       PreInvocation(0), waits for $FAKE_AGY_DIR/release, PreInvocation(1)
//   sleep      starts `sleep 60` (its pid in the log) and waits to be killed
//   subagent   a native subagent: invoke_subagent, then in the subagent's own
//              conversation a write outside and one inside the worktree, then
//              a swarm call, then `report` as in report mode
// Every run appends { argv, env, events[] } to $FAKE_AGY_DIR/runs.jsonl.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const DIR = process.env.FAKE_AGY_DIR;
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const cwd = process.cwd();
const log = { argv, cwd, env: {}, events: [] };
for (const k of ['HTTPS_PROXY', 'SSL_CERT_FILE', 'VISTACLAIR_AGY_POLICY', 'VISTACLAIR_INSTANCE_ID', 'VISTACLAIR_ORCH_ROLE', 'VISTACLAIR_ORCH_ENGINE', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AGY_ADC_AUTH', 'GOOGLE_APPLICATION_CREDENTIALS', 'AGY_CLI_DISABLE_AUTO_UPDATE', 'VISTACLAIR_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
  log.env[k] = process.env[k] ?? null;
}
log.env.hasSessionToken = !!process.env.VISTACLAIR_SESSION_TOKEN;
const runs = path.join(DIR, 'runs.jsonl');
const n = fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean).length : 0;
let scenario = ['report'];
try { scenario = JSON.parse(fs.readFileSync(path.join(DIR, 'scenario.json'), 'utf8')); } catch {}
const mode = scenario[Math.min(n, scenario.length - 1)];
log.mode = mode;
const save = () => fs.appendFileSync(runs, JSON.stringify(log) + '\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const resumed = flag('--conversation');
const conv = resumed || crypto.randomUUID();
const hooksCfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(cwd, '.agents', 'hooks.json'), 'utf8')); } catch { return {}; } })();
const mcpCfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(cwd, '.agents', 'mcp_config.json'), 'utf8')); } catch { return {}; } })();

function handlers(event, toolName) {
  const list = [];
  for (const group of Object.values(hooksCfg)) {
    for (const h of group[event] || []) {
      if (h.hooks) { if (!h.matcher || new RegExp(h.matcher).test(toolName || '')) list.push(...h.hooks); } else list.push(h);
    }
  }
  return list;
}

function runHook(event, input, toolName) {
  const answers = [];
  for (const h of handlers(event, toolName)) {
    const r = spawnSync('sh', ['-c', h.command], { input: JSON.stringify({ conversationId: conv, cwd, hookEventName: event, workspacePaths: [cwd], ...input }), encoding: 'utf8', timeout: (h.timeout || 10) * 1000 });
    let j = {};
    try { j = JSON.parse(String(r.stdout || '').trim() || '{}'); } catch {}
    answers.push(j);
  }
  log.events.push({ hook: event, input: input.toolCall ? { name: input.toolCall.name, args: input.toolCall.args } : input, answers });
  return answers[0] || {};
}

let step = 0;
const stepUpdate = (o) => out({ event: 'step_update', step_update: { conversation_id: conv, step_index: step++, ...o } });

// `inConv`: the conversation the tool runs in (a subagent's has its own id).
function tool(name, args, run, inConv = conv) {
  const extra = inConv === conv ? {} : { conversationId: inConv };
  const upd = (o) => out({ event: 'step_update', step_update: { conversation_id: inConv, step_index: step, ...o } });
  const d = runHook('PreToolUse', { stepIdx: step, toolCall: { name, args, id: `call_${step}` }, ...extra }, name);
  upd({ state: 'ACTIVE', step_type: 'tool', tool_name: name, tool_info: { name, parameters: args } });
  if (d.decision !== 'allow') {
    upd({ state: 'ERROR', step_type: 'tool', tool_name: name, tool_info: { name, error: { type: 'TOOL_ERROR', message: d.reason || 'denied' } } });
    step++;
    return { denied: true, reason: d.reason };
  }
  const output = run ? run() : '';
  upd({ state: 'DONE', step_type: 'tool', tool_name: name, tool_info: { name, parameters: args, output } });
  runHook('PostToolUse', { stepIdx: step, toolCall: { name, args, id: `call_${step}` }, ...extra }, name);
  step++;
  return { output };
}

// One MCP tools/call against a server of mcp_config.json.
function mcpCall(serverName, toolName, args) {
  const s = mcpCfg.mcpServers?.[serverName];
  if (!s) return Promise.resolve({ error: `no MCP server ${serverName}` });
  return new Promise((resolve) => {
    const p = spawn(s.command, s.args || [], { cwd, env: { ...process.env, ...(s.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let err = '';
    const timer = setTimeout(() => { p.kill(); resolve({ error: 'mcp timeout', stderr: err }); }, 15000);
    p.stderr.on('data', d => { err += d; });
    p.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n')) {
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 2) { clearTimeout(timer); p.kill(); resolve(m.result || { error: m.error }); }
      }
    });
    const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fake-agy', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: args } });
  });
}

function finish(status, response, code, extra = {}) {
  out({ event: 'result', result: { conversation_id: conv, status, response, duration_seconds: 0.1, num_turns: 1, usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 50, total_tokens: 110 }, ...extra } });
  save();
  process.exit(code);
}

process.on('SIGINT', () => {
  log.events.push({ signal: 'SIGINT' });
  finish('ERROR', '', 1, { finished_reason: 'interrupted' });
});
process.on('SIGTERM', () => { log.events.push({ signal: 'SIGTERM' }); save(); process.exit(143); });

(async () => {
  if (mode === 'auth') {
    process.stderr.write("Error: authentication required. Run 'agy' to log in, then retry.\n");
    save();
    process.exit(1);
  }
  out({ event: 'init', conversation_id: conv, init: { model: flag('--model'), cwd, tools: ['read_file', 'write_file', 'run_command'], permission_mode: 'default' } });
  if (!resumed) runHook('SessionStart', {});
  stepUpdate({ state: 'DONE', step_type: 'user_input' });
  runHook('PreInvocation', { initialNumSteps: 0, invocationNum: 0 });
  if (mode === 'quota') {
    finish('ERROR', '', 1, { error: { message: 'RESOURCE_EXHAUSTED: You have exhausted your capacity on this model. Your quota will reset after 3600s.' } });
  }
  if (mode === 'sleep') {
    const child = spawn('sleep', ['60'], { stdio: 'ignore' });
    log.events.push({ child: child.pid });
    fs.writeFileSync(path.join(DIR, 'child.pid'), String(child.pid));
    stepUpdate({ state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'sleep 60' } } });
    fs.writeFileSync(path.join(DIR, 'sleeping'), '1');
    await new Promise(() => {});
  }
  if (mode === 'wait') {
    fs.writeFileSync(path.join(DIR, 'waiting'), String(n));
    while (!fs.existsSync(path.join(DIR, 'release'))) await sleep(20);
    fs.rmSync(path.join(DIR, 'release'), { force: true });
    fs.rmSync(path.join(DIR, 'waiting'), { force: true });
    runHook('PreInvocation', { initialNumSteps: 1, invocationNum: 1 });
  }
  if (mode === 'subagent') {
    const sub = crypto.randomUUID();
    log.subConversation = sub;
    log.invoke = tool('invoke_subagent', { TypeName: 'researcher', Role: 'Reader', Prompt: 'read README' }, () => sub);
    if (!log.invoke.denied) {
      const outside = path.join(path.dirname(cwd), 'outside-sub.txt');
      log.subOutside = tool('write_file', { Path: outside, Content: 'no' }, () => { fs.writeFileSync(outside, 'no'); return 'written'; }, sub);
      const inside = path.join(cwd, 'sub-made.txt');
      log.subInside = tool('write_file', { Path: inside, Content: 'by the subagent\n' }, () => { fs.writeFileSync(inside, 'by the subagent\n'); return 'written'; }, sub);
      out({ event: 'step_update', step_update: { conversation_id: sub, step_index: 0, state: 'DONE', step_type: 'agent_response', text_delta: 'SUBAGENT-TEXT' } });
    }
    log.swarm = tool('swarm', { Tasks: ['a', 'b'] });
  }
  if (mode === 'report' || mode === 'subagent') {
    const outside = path.join(path.dirname(cwd), 'outside-agy.txt');
    log.outside = tool('write_file', { Path: outside, Content: 'no' }, () => { fs.writeFileSync(outside, 'no'); return 'written'; });
    const inside = path.join(cwd, 'agy-made.txt');
    log.inside = tool('write_file', { Path: inside, Content: 'made by fake agy\n' }, () => { fs.writeFileSync(inside, 'made by fake agy\n'); return 'written'; });
    const r = await mcpCall('orchestrator', 'report', { status: 'done', summary: 'fake agy did it', filesChanged: ['agy-made.txt'], verified: 'none', open: '' });
    log.report = r;
    stepUpdate({ state: 'DONE', step_type: 'tool', tool_name: 'mcp_orchestrator_report', tool_info: { name: 'mcp_orchestrator_report', parameters: {}, output: JSON.stringify(r).slice(0, 200) } });
    runHook('PreInvocation', { initialNumSteps: 3, invocationNum: 1 });
  }
  stepUpdate({ state: 'DONE', step_type: 'agent_response', text_delta: `fake agy turn ${n} (${mode})`, usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 50 } });
  runHook('Stop', { executionNum: 0, fullyIdle: true, terminationReason: 'done' });
  finish('SUCCESS', `fake agy turn ${n} (${mode})`, 0);
})();
