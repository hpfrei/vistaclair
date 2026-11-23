// lib/agy-hook.js: the local PreToolUse policy of agy sessions (DESIGN §5),
// one row per policy line, plus the SessionStart / PreInvocation answers and
// the fail-closed edges.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { decide, run } = require('../lib/agy-hook');

const HOOK = path.join(__dirname, '..', 'lib', 'agy-hook.js');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hook-')));
const WT = path.join(tmp, 'wt');
const SF = path.join(tmp, 'session');
const OUT = path.join(tmp, 'elsewhere');
for (const d of [WT, SF, OUT]) fs.mkdirSync(d, { recursive: true });
fs.symlinkSync(OUT, path.join(WT, 'escape'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const MAIN = 'conv-main';
const policy = (extra = {}) => ({ writeRoots: [WT, SF], mainConversation: MAIN, pausing: false, ...extra });
const call = (name, args = {}, extra = {}) => ({ conversationId: MAIN, cwd: WT, toolCall: { name, args, id: 'call_1' }, ...extra });

const ROWS = [
  // [label, policy, input, expected decision, reason pattern]
  ['read_file', policy(), call('read_file', { Path: '/etc/hosts' }), 'allow'],
  ['view_file', policy(), call('view_file', { AbsolutePath: '/etc/hosts' }), 'allow'],
  ['search_web', policy(), call('search_web', { query: 'x' }), 'allow'],
  ['read_url', policy(), call('read_url', { Url: 'https://example.com' }), 'allow'],
  ['list_resources', policy(), call('list_resources', {}), 'allow'],
  ['read_resource', policy(), call('read_resource', {}), 'allow'],
  ['manage_task', policy(), call('manage_task', {}), 'allow'],
  ['write_file inside worktree', policy(), call('write_file', { Path: path.join(WT, 'a.txt'), Content: 'x' }), 'allow'],
  ['write_file relative inside', policy(), call('write_file', { Path: 'sub/a.txt', Content: 'x' }), 'allow'],
  ['write_file in session folder', policy(), call('write_file', { Path: path.join(SF, 'NOTES.md') }), 'allow'],
  ['edit_file inside', policy(), call('edit_file', { TargetFile: path.join(WT, 'a.txt') }), 'allow'],
  ['write_file outside', policy(), call('write_file', { Path: path.join(OUT, 'x.txt') }), 'deny', /outside your worktree/],
  ['write_file ../ escape', policy(), call('write_file', { Path: path.join(WT, '..', 'elsewhere', 'x') }), 'deny', /outside your worktree/],
  ['write_file via symlink escape', policy(), call('write_file', { Path: path.join(WT, 'escape', 'x') }), 'deny', /outside your worktree/],
  ['write_file prefix sibling', policy(), call('write_file', { Path: WT + '-other/x' }), 'deny', /outside your worktree/],
  ['edit_file outside', policy(), call('edit_file', { Path: '/etc/passwd' }), 'deny', /outside your worktree/],
  ['write_file with no path', policy(), call('write_file', { Content: 'x' }), 'deny', /no target path/],
  ['run_command', policy(), call('run_command', { CommandLine: 'rm -rf /tmp/x' }), 'allow'],
  ['mcp_ eager tool', policy(), call('mcp_orchestrator_report', { status: 'done' }), 'allow'],
  ['call_mcp_tool', policy(), call('call_mcp_tool', { ServerName: 'apps', ToolName: 'x' }), 'allow'],
  ['invoke_subagent while pausing', policy({ pausing: true }), call('invoke_subagent', { TypeName: 'researcher', Prompt: 'p' }), 'deny', /paused/],
  ['swarm while pausing', policy({ pausing: true }), call('swarm', {}), 'deny', /paused/],
  ['browser_subagent while pausing', policy({ pausing: true }), call('browser_subagent', {}), 'deny', /paused/],
  ['mcp report while pausing', policy({ pausing: true }), call('mcp_orchestrator_report', {}), 'allow'],
  ['read_file while pausing', policy({ pausing: true }), call('read_file', { AbsolutePath: '/etc/hosts' }), 'allow'],
  ['invoke_subagent image-generator', policy(), call('invoke_subagent', { TypeName: 'image-generator', Role: 'Image Generator', Prompt: 'p' }), 'allow'],
  ['invoke_subagent any type', policy(), call('invoke_subagent', { TypeName: 'researcher', Prompt: 'p' }), 'allow'],
  ['browser_subagent', policy(), call('browser_subagent', { Task: 't' }), 'allow'],
  ['write_file outside, in a subagent', policy(), call('write_file', { Path: '/tmp/elsewhere-x', Content: 'x' }, { conversationId: 'conv-sub' }), 'deny', /outside your worktree/],
  ['write_file inside, in a subagent', policy(), call('write_file', { Path: path.join(WT, 'sub.txt'), Content: 'x' }, { conversationId: 'conv-sub' }), 'allow'],
  ['generate_image', policy(), call('generate_image', { AspectRatio: '1:1', ImageName: 'a', Prompt: 'p' }, { conversationId: 'conv-sub' }), 'allow'],
  ['send_message from subagent', policy(), call('send_message', { Recipient: MAIN, Message: 'm' }, { conversationId: 'conv-sub' }), 'allow'],
  ['send_message in main', policy(), call('send_message', { Recipient: 'x', Message: 'm' }), 'deny', /mcp_orchestrator_SendMessage/],
  ['send_message before main known', policy({ mainConversation: null }), call('send_message', {}, { conversationId: 'conv-sub' }), 'deny', /SendMessage/],
  ['define_subagent', policy(), call('define_subagent', {}), 'allow'],
  ['manage_subagents', policy(), call('manage_subagents', {}), 'allow'],
  ['swarm', policy(), call('swarm', {}), 'deny', /^swarm \(uncapped parallel subagents\) is off; spawn one subagent at a time with invoke_subagent$/],
  ['run_workflow', policy(), call('run_workflow', {}), 'deny', /workflows/],
  ['schedule', policy(), call('schedule', {}), 'deny', /orchestrator/],
  ['ask_question', policy(), call('ask_question', {}), 'deny', /SendMessage.*blocked/],
  ['policy deny override', policy({ deny: { run_command: 'no shell for you' } }), call('run_command', {}), 'deny', /no shell/],
  ['policy may lift a default deny', policy({ deny: { schedule: null } }), call('schedule', {}), 'allow'],
  ['no policy', null, call('read_file', {}), 'deny', /policy unavailable/],
];

for (const [label, pol, input, want, reason] of ROWS) {
  test(`policy: ${label} → ${want}`, () => {
    const d = decide(pol, input);
    assert.strictEqual(d.decision, want, JSON.stringify(d));
    if (reason) assert.match(d.reason, reason);
    if (want === 'allow') assert.strictEqual(d.reason, undefined);
  });
}

test('policy: an unknown tool is allowed and named for the log', () => {
  const d = decide(policy(), call('brand_new_tool', {}));
  assert.strictEqual(d.decision, 'allow');
  assert.strictEqual(d.unknown, 'brand_new_tool');
  assert.strictEqual(decide(policy(), call('read_file', {})).unknown, undefined);
});

// The process entry point: every answer is an explicit decision (agy reads {} as deny).
function runHook(event, input, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [HOOK, event], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', c => { out += c; });
    p.on('exit', (code) => resolve({ code, json: JSON.parse(out.trim() || 'null') }));
    p.stdin.end(JSON.stringify(input));
  });
}

test('hook process: PreToolUse prints allow / deny from the policy file', async () => {
  const file = path.join(tmp, 'policy.json');
  fs.writeFileSync(file, JSON.stringify(policy()));
  const a = await runHook('PreToolUse', call('write_file', { Path: path.join(WT, 'ok') }), { VISTACLAIR_AGY_POLICY: file });
  assert.deepStrictEqual(a, { code: 0, json: { decision: 'allow' } });
  const d = await runHook('PreToolUse', call('write_file', { Path: '/etc/x' }), { VISTACLAIR_AGY_POLICY: file });
  assert.strictEqual(d.json.decision, 'deny');
  const broken = await runHook('PreToolUse', call('read_file', {}), { VISTACLAIR_AGY_POLICY: path.join(tmp, 'missing.json') });
  assert.strictEqual(broken.json.decision, 'deny');
});

test('hook: SessionStart injects the role card; none without one', async () => {
  const file = path.join(tmp, 'policy-card.json');
  fs.writeFileSync(file, JSON.stringify(policy({ sessionStartText: 'You are worker w1.' })));
  const r = await run('SessionStart', {}, { VISTACLAIR_AGY_POLICY: file });
  assert.deepStrictEqual(r, { injectSteps: [{ systemMessage: { systemMessage: 'You are worker w1.' } }] });
  fs.writeFileSync(file, JSON.stringify(policy()));
  assert.deepStrictEqual(await run('SessionStart', {}, { VISTACLAIR_AGY_POLICY: file }), {});
  assert.deepStrictEqual(await run('Stop', {}, { VISTACLAIR_AGY_POLICY: file }), {});
  assert.deepStrictEqual(await run('PostToolUse', {}, { VISTACLAIR_AGY_POLICY: file }), {});
});

test('hook: PreInvocation relays the server injectSteps and fails open', async (t) => {
  const seen = [];
  let answer = { injectSteps: [{ systemMessage: { systemMessage: 'msg from orchestrator' } }] };
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => {
      seen.push({ url: req.url, token: req.headers['x-vistaclair-session'], body: JSON.parse(b) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const env = { VISTACLAIR_DASHBOARD_PORT: String(server.address().port), VISTACLAIR_SESSION_TOKEN: 'tok', VISTACLAIR_INSTANCE_ID: 'cli-a', VISTACLAIR_AGY_POLICY: '' };
  const r = await run('PreInvocation', { conversationId: MAIN, invocationNum: 1 }, env);
  assert.deepStrictEqual(r, answer);
  assert.strictEqual(seen[0].url, '/api/orchestration/agy-hook');
  assert.strictEqual(seen[0].token, 'tok');
  assert.deepStrictEqual(seen[0].body, { instanceId: 'cli-a', event: 'PreInvocation', conversationId: MAIN, invocationNum: 1 });
  answer = {};
  assert.deepStrictEqual(await run('PreInvocation', {}, env), {});
  // No server: nothing injected, no throw.
  assert.deepStrictEqual(await run('PreInvocation', {}, { ...env, VISTACLAIR_DASHBOARD_PORT: '1' }), {});
  assert.deepStrictEqual(await run('PreInvocation', {}, {}), {});
  // An unknown tool is reported once to the server and still allowed.
  const file = path.join(tmp, 'policy-u.json');
  fs.writeFileSync(file, JSON.stringify(policy()));
  const u = await run('PreToolUse', call('brand_new_tool', {}), { ...env, VISTACLAIR_AGY_POLICY: file });
  assert.deepStrictEqual(u, { decision: 'allow' });
  assert.deepStrictEqual(seen.at(-1).body, { instanceId: 'cli-a', event: 'unknown-tool', name: 'brand_new_tool' });
});
