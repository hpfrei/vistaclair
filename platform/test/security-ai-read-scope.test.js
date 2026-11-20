// The read scope of a headless aiPrompt run (src/apps/ai-read-scope.js): a run
// granted a file tool may only touch its roots, although the CLI child runs
// with --dangerously-skip-permissions. Everything here tests the enforcement
// layer directly (the decision function, the hook script the CLI runs, the
// plan) or the spawn arguments aiPrompt builds; no AI call is made.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-read-scope-'));
const savedTmp = process.env.TMPDIR;
process.env.TMPDIR = tmp;
test.after(() => {
  if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const readScope = require('../src/apps/ai-read-scope');
const { core } = require('../src/apps/core-services');
const aiService = require('../src/apps/ai-service');
const platformSettings = require('../src/apps/platform-settings');
const spendGate = require('../src/apps/spend-gate');
const spendLedger = require('../src/apps/spend-ledger');

// Fixture: <fx>/apps/<app>/{in.txt, .data/media.jpg, link -> outside/, linkfile -> outside/secret.txt},
// <fx>/outside/secret.txt, <fx>/apps/.secrets_key
const fx = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'fx-')));
const appsDir = path.join(fx, 'apps');
const appDir = path.join(appsDir, 'demo');
const outside = path.join(fx, 'outside');
fs.mkdirSync(path.join(appDir, '.data'), { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(appDir, 'in.txt'), 'inside');
fs.writeFileSync(path.join(appDir, '.data', 'media.jpg'), 'img');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
fs.writeFileSync(path.join(appsDir, '.secrets_key'), 'k');
fs.writeFileSync(path.join(appDir, '.secrets_key'), 'k');
fs.symlinkSync(outside, path.join(appDir, 'link'));
fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(appDir, 'linkfile'));
fs.symlinkSync(path.join(outside, 'nowhere'), path.join(appDir, 'dangling'));

const scope = { roots: [appDir] };
const allowed = (tool, input, sc = scope, cwd = appDir) => readScope.decide(tool, input, sc, cwd).allow === true;

// ---- the decision ----------------------------------------------------------

test('Read: a path inside a root is allowed, one outside is denied', () => {
  assert.ok(allowed('Read', { file_path: path.join(appDir, 'in.txt') }));
  assert.ok(allowed('Read', { file_path: path.join(appDir, '.data', 'media.jpg') }));
  assert.ok(!allowed('Read', { file_path: path.join(outside, 'secret.txt') }));
  assert.ok(!allowed('Read', { file_path: '/etc/passwd' }));
  assert.ok(!allowed('Read', { file_path: path.join(os.homedir(), '.claude', '.credentials.json') }));
});

test('Read: the server log and the secrets key are not readable', () => {
  assert.ok(!allowed('Read', { file_path: '/home/hp/vistaclair/data/logs/server.log' }));
  // even inside a root, the secrets key file is refused
  assert.ok(!allowed('Read', { file_path: path.join(appDir, '.secrets_key') }));
});

test('Read: a symlink inside a root that points outside is denied', () => {
  assert.ok(!allowed('Read', { file_path: path.join(appDir, 'linkfile') }));
  assert.ok(!allowed('Read', { file_path: path.join(appDir, 'link', 'secret.txt') }));
  assert.ok(!allowed('Read', { file_path: path.join(appDir, 'dangling') }), 'a dangling link is refused');
});

test('Read: ".." cannot climb out of a root, also through a link', () => {
  assert.ok(!allowed('Read', { file_path: `${appDir}/../../outside/secret.txt` }));
  assert.ok(!allowed('Read', { file_path: `${appDir}/sub/../../outside/secret.txt` }));
  assert.ok(!allowed('Read', { file_path: `${appDir}/link/../in.txt` }));
  assert.ok(!allowed('Read', { file_path: `${appDir}/../demo/in.txt` }), 'a raw ".." is refused outright');
});

test('Read: /proc is unreachable, including /proc/self/environ and a link to it', () => {
  assert.ok(!allowed('Read', { file_path: '/proc/self/environ' }));
  assert.ok(!allowed('Read', { file_path: `/proc/${process.pid}/environ` }));
  assert.ok(!allowed('Read', { file_path: '/proc/self/cwd/in.txt' }));
  const procLink = path.join(appDir, 'procenv');
  fs.symlinkSync('/proc/self/environ', procLink);
  try { assert.ok(!allowed('Read', { file_path: procLink })); } finally { fs.unlinkSync(procLink); }
  // even when /proc is (wrongly) named as a root, the root is refused
  const c = readScope.canonicalizeRoots(['/proc/self'], { appsDir });
  assert.deepEqual(c.roots, []);
});

test('Read: a root may be one file; a missing file inside a root is allowed (Write creates it)', () => {
  const one = { roots: [path.join(appDir, 'in.txt')] };
  assert.ok(allowed('Read', { file_path: path.join(appDir, 'in.txt') }, one));
  assert.ok(!allowed('Read', { file_path: path.join(appDir, '.data', 'media.jpg') }, one));
  assert.ok(allowed('Read', { file_path: path.join(appDir, 'new', 'file.txt') }));
});

test('Read: empty, NUL, "~" and a relative path without a cwd are denied', () => {
  assert.ok(!allowed('Read', { file_path: '' }));
  assert.ok(!allowed('Read', {}));
  assert.ok(!allowed('Read', { file_path: `${appDir}/in.txt\0.png` }));
  assert.ok(!allowed('Read', { file_path: '~/.claude/.credentials.json' }));
  assert.ok(!readScope.decide('Read', { file_path: 'in.txt' }, scope, undefined).allow);
  assert.ok(allowed('Read', { file_path: 'in.txt' }), 'relative to a cwd inside the root');
  assert.ok(!allowed('Read', { file_path: 'in.txt' }, scope, outside), 'relative to a cwd outside');
});

test('Glob and Grep: the searched directory must be inside; with no path the cwd is used', () => {
  assert.ok(allowed('Glob', { pattern: '*.txt', path: appDir }));
  assert.ok(allowed('Glob', { pattern: '*.txt' }), 'cwd is the root');
  assert.ok(!allowed('Glob', { pattern: '*.txt' }, scope, outside), 'cwd outside the roots, no path');
  assert.ok(!allowed('Glob', { pattern: '*', path: outside }));
  assert.ok(!allowed('Glob', { pattern: '/etc/*.conf' }), 'an absolute pattern outside');
  assert.ok(!allowed('Glob', { pattern: '../outside/*' }));
  assert.ok(!allowed('Glob', { pattern: '{/etc,x}/*' }));
  assert.ok(allowed('Glob', { pattern: `${appDir}/*.txt` }));
  assert.ok(allowed('Grep', { pattern: 'x', path: appDir }));
  assert.ok(!allowed('Grep', { pattern: 'x', path: '/proc' }));
  assert.ok(!allowed('Grep', { pattern: 'x' }, scope, '/'));
  assert.ok(!allowed('Grep', { pattern: 'x', path: appDir, glob: '/etc/**' }));
  assert.ok(!allowed('Grep', { pattern: 'x', path: path.join(appDir, 'link') }), 'a link out of the root');
});

test('Write and Edit are held to the same roots; a shell, a sub-agent and unknown tools are not allowed by default', () => {
  assert.ok(allowed('Write', { file_path: path.join(appDir, 'out.txt') }));
  assert.ok(!allowed('Write', { file_path: path.join(outside, 'out.txt') }));
  assert.ok(!allowed('Edit', { file_path: path.join(appDir, 'linkfile') }));
  assert.ok(!allowed('NotebookEdit', { notebook_path: path.join(outside, 'n.ipynb') }));
  assert.ok(!allowed('Bash', { command: 'cat /etc/passwd' }));
  assert.ok(allowed('Bash', { command: 'ls' }, { roots: [appDir], allowShell: true }), 'only when the caller is trusted with a shell');
  assert.ok(!allowed('Agent', { prompt: 'x' }));
  assert.ok(!allowed('SomeFutureFileTool', { path: '/etc/passwd' }));
  assert.ok(allowed('mcp__app-tools__demo__ping', { a: 1 }), 'the broker authorises these');
  assert.ok(allowed('ToolSearch', { query: 'x' }));
  assert.ok(allowed('WebFetch', { url: 'https://example.com/' }));
  assert.ok(!allowed('WebFetch', { url: 'file:///etc/passwd' }));
});

// ---- roots -------------------------------------------------------------------

test('canonicalizeRoots: absolute and existing only, real paths, never / HOME or the apps dir', () => {
  const viaLink = path.join(fx, 'viaLink');
  fs.symlinkSync(appDir, viaLink);
  const c = readScope.canonicalizeRoots([appDir, viaLink, 'relative/dir', path.join(fx, 'missing'), '/', os.homedir(), appsDir, path.join(appDir, 'in.txt')], { appsDir });
  assert.deepEqual(c.roots, [appDir], 'the link resolves, duplicates and nested roots collapse');
  assert.equal(c.rejected.length, 5);
});

test('a file root under the apps dir is accepted when only that file is named', () => {
  const f = path.join(appsDir, '.horst-tmp-att.pdf');
  fs.writeFileSync(f, 'x');
  assert.deepEqual(readScope.canonicalizeRoots([f], { appsDir }).roots, [f]);
});

// ---- the plan ---------------------------------------------------------------

const okProbes = { hookSelfTest: () => ({ ok: true }), managedHooksBlocked: () => false };
const plan = (over) => readScope.planReadScope({ appName: 'demo', appDir, appsDir, allowedTools: ['Read'], probes: okProbes, ...over });

test('plan: an app caller with no readRoots gets its own directory (which holds its data dir)', () => {
  const p = plan({});
  assert.equal(p.active, true);
  assert.deepEqual(p.roots, [appDir]);
  assert.deepEqual(p.allowedTools, ['Read']);
});

test('plan: an app caller cannot widen its roots beyond its directory', () => {
  const p = plan({ readRoots: [path.join(appDir, '.data'), outside, '/etc'] });
  assert.deepEqual(p.roots, [path.join(appDir, '.data')]);
  const none = plan({ readRoots: [outside] });
  assert.deepEqual(none.allowedTools, [], 'nothing valid is left, so no file tool');
  assert.match(none.reason, /readRoots/);
});

test('plan: the platform caller without roots gets no file tools, and the plan says why', () => {
  const p = plan({ appName: 'platform', appDir: appsDir, allowedTools: ['Read', 'WebSearch', 'Glob', 'Grep'] });
  assert.deepEqual(p.allowedTools, ['WebSearch']);
  assert.deepEqual(p.stripped.sort(), ['Glob', 'Grep', 'Read']);
  assert.match(p.reason, /readRoots/);
  assert.deepEqual(plan({ appName: 'platform', appDir: appsDir, allowedTools: ['Read'], readRoots: [] }).allowedTools, []);
});

test('plan: the platform caller with explicit roots gets exactly those', () => {
  const f = path.join(appDir, 'in.txt');
  const p = plan({ appName: 'platform', appDir: appsDir, readRoots: [f] });
  assert.deepEqual(p.roots, [f]);
  assert.deepEqual(p.allowedTools, ['Read']);
  assert.equal(p.active, true);
  // the whole apps dir is not a valid root, so it cannot be named by mistake
  assert.deepEqual(plan({ appName: 'platform', appDir: appsDir, readRoots: [appsDir] }).allowedTools, []);
});

test('plan: a shell granted to the platform caller is stripped; to an app it stays but is not scoped', () => {
  const p = plan({ appName: 'platform', appDir: appsDir, allowedTools: ['Read', 'Bash'], readRoots: [path.join(appDir, 'in.txt')] });
  assert.deepEqual(p.allowedTools, ['Read']);
  const a = plan({ allowedTools: ['Read', 'Bash'] });
  assert.deepEqual(a.allowedTools, ['Read', 'Bash']);
  assert.equal(a.allowShell, true);
});

test('plan: tools that need no scope pass through untouched and add no hook', () => {
  for (const tools of [[], ['WebFetch'], ['mcp__app-tools__*', 'AskUserQuestion', 'WebSearch', 'WebFetch']]) {
    const p = plan({ appName: 'platform', appDir: appsDir, allowedTools: tools });
    assert.equal(p.active, false);
    assert.deepEqual(p.allowedTools, tools);
  }
});

test('plan: fails closed when the hook cannot be proven or managed settings disable hooks', () => {
  const broken = plan({ probes: { hookSelfTest: () => ({ ok: false, error: 'boom' }), managedHooksBlocked: () => false } });
  assert.deepEqual(broken.allowedTools, []);
  assert.match(broken.reason, /boom|hook/);
  const managed = plan({ probes: { hookSelfTest: () => ({ ok: true }), managedHooksBlocked: () => true } });
  assert.deepEqual(managed.allowedTools, []);
});

test('plan: other tools a scoped run would be granted (agents, workflows) are stripped', () => {
  const p = plan({ allowedTools: ['Read', 'Agent', 'WebSearch', 'mcp__app-tools__x__y'] });
  assert.deepEqual(p.allowedTools, ['Read', 'WebSearch', 'mcp__app-tools__x__y']);
  assert.deepEqual(p.stripped, ['Agent']);
});

// ---- the hook script the CLI runs -----------------------------------------

function runHook(scopeFile, input) {
  return spawnSync(process.execPath, [readScope.HOOK_SCRIPT, scopeFile], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
}

test('hook script: exit 0 inside, exit 2 outside, and exit 2 on any malformed input', () => {
  const scopeFile = path.join(tmp, 'scope-hook.json');
  fs.writeFileSync(scopeFile, JSON.stringify({ v: 1, roots: [appDir] }));
  const ev = (tool_name, tool_input) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input, cwd: appDir });
  assert.equal(runHook(scopeFile, ev('Read', { file_path: path.join(appDir, 'in.txt') })).status, 0);
  const denied = runHook(scopeFile, ev('Read', { file_path: '/proc/self/environ' }));
  assert.equal(denied.status, 2);
  assert.ok(denied.stderr.length > 0, 'the model is told why');
  assert.equal(runHook(scopeFile, ev('Read', { file_path: path.join(appDir, 'linkfile') })).status, 2);
  assert.equal(runHook(scopeFile, 'not json').status, 2);
  assert.equal(runHook(scopeFile, '').status, 2);
  assert.equal(runHook(path.join(tmp, 'no-such-scope.json'), ev('Read', { file_path: path.join(appDir, 'in.txt') })).status, 2);
  fs.writeFileSync(scopeFile, '{broken');
  assert.equal(runHook(scopeFile, ev('Read', { file_path: path.join(appDir, 'in.txt') })).status, 2);
  fs.writeFileSync(scopeFile, JSON.stringify({ v: 1, roots: [] }));
  assert.equal(runHook(scopeFile, ev('Read', { file_path: path.join(appDir, 'in.txt') })).status, 2, 'no roots means nothing is readable');
});

test('hookSettingsJson wires the script as a PreToolUse hook for every tool and keeps hooks on', () => {
  const s = JSON.parse(readScope.hookSettingsJson('/tmp/x scope.json'));
  assert.equal(s.disableAllHooks, false);
  const h = s.hooks.PreToolUse[0];
  assert.equal(h.matcher, '*');
  assert.match(h.hooks[0].command, new RegExp(readScope.HOOK_SCRIPT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(h.hooks[0].command.includes(process.execPath));
  assert.ok(h.hooks[0].command.includes("'/tmp/x scope.json'"), 'the scope path is quoted');
});

// ---- the spawn aiPrompt builds ---------------------------------------------

async function runCalls(fn) {
  const seen = [];
  const saved = {
    build: core.buildClaudeArgs, spawn: core.spawnClaude, get: platformSettings.get,
    auth: spendGate.authorize, tap: spendGate.tapActive, clear: spendGate.clearMarker, rec: spendLedger.recordSession,
  };
  platformSettings.get = () => undefined;
  spendGate.authorize = () => ({ ok: true });
  spendGate.tapActive = () => true;
  spendGate.clearMarker = () => {};
  spendLedger.recordSession = () => {};
  core.buildClaudeArgs = (opts) => [`--allowedTools=${(opts.allowedTools || []).join(',')}`];
  core.spawnClaude = (args, opts) => {
    const { EventEmitter } = require('events');
    const read = (prefix) => {
      const f = fs.readdirSync(tmp).find((n) => n.startsWith(prefix));
      return f ? JSON.parse(fs.readFileSync(path.join(tmp, f), 'utf8')) : null;
    };
    seen.push({ args, extraEnv: opts.extraEnv, gate: read('vistaclair-ai-allowed-'), scopeFile: read('vistaclair-ai-scope-') });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    proc.stdin = { write() {}, end() {} };
    setImmediate(() => { proc.stdout.emit('data', Buffer.from('ok')); proc.emit('exit', 0); });
    return proc;
  };
  const results = [];
  try { await fn(results); return { seen, results }; } finally {
    core.buildClaudeArgs = saved.build; core.spawnClaude = saved.spawn; platformSettings.get = saved.get;
    spendGate.authorize = saved.auth; spendGate.tapActive = saved.tap; spendGate.clearMarker = saved.clear;
    spendLedger.recordSession = saved.rec;
  }
}
const flag = (args, name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };

test('aiPrompt: an app caller granted Read gets the hook, --tools and its directory as the roots', async () => {
  const { seen, results } = await runCalls(async (r) => {
    r.push(await aiService.aiPrompt('demo', appDir, { message: 'hi', allowedTools: ['Read'] }));
  });
  const [s] = seen;
  assert.equal(flag(s.args, '--tools'), 'Read,ToolSearch');
  const settings = JSON.parse(flag(s.args, '--settings'));
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].type, 'command');
  assert.deepEqual(s.scopeFile.roots, [appDir]);
  assert.deepEqual(s.gate, { tools: ['Read', 'ToolSearch'] });
  assert.ok(s.args.includes('--dangerously-skip-permissions'), 'the child still runs headless');
  assert.equal(results[0].readScope.tier, 'hook');
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('vistaclair-ai-scope-')), [], 'the scope file is removed when the call ends');
});

test('aiPrompt: explicit readRoots reach the scope file', async () => {
  const f = path.join(appDir, '.data', 'media.jpg');
  const { seen } = await runCalls(async () => {
    await aiService.aiPrompt('demo', appDir, { message: 'hi', allowedTools: ['Read'], readRoots: [f] });
  });
  assert.deepEqual(seen[0].scopeFile.roots, [f]);
});

test('aiPrompt: the platform caller with Read and no readRoots runs with no file tool and the call says why', async () => {
  const { seen, results } = await runCalls(async (r) => {
    r.push(await aiService.aiPrompt('platform', appsDir, { message: 'hi', allowedTools: ['Read'] }));
  });
  const [s] = seen;
  assert.ok(!/Read/.test(s.args.join(' ')), `no Read anywhere in the CLI args: ${s.args.join(' ')}`);
  assert.deepEqual(s.gate, { none: true }, 'the proxy gate strips it from the request too');
  assert.match(results[0].readScope.reason, /readRoots/);
  assert.deepEqual(results[0].readScope.stripped, ['Read']);
});

test('aiPrompt: the platform caller with a temp file as its root keeps Read on that file only', async () => {
  const f = path.join(appDir, 'in.txt');
  const { seen } = await runCalls(async () => {
    await aiService.aiPrompt('platform', appsDir, { message: 'hi', allowedTools: ['Read'], readRoots: [f] });
  });
  assert.deepEqual(seen[0].scopeFile.roots, [f]);
  assert.equal(flag(seen[0].args, '--tools'), 'Read,ToolSearch');
});

test('aiPrompt: a call with no file tool is exactly as before (no hook, no --tools)', async () => {
  const { seen } = await runCalls(async () => {
    await aiService.aiPrompt('demo', appDir, { message: 'hi', allowedTools: ['WebFetch'] });
    await aiService.aiPrompt('demo', appDir, { message: 'hi' });
  });
  for (const s of seen) {
    assert.equal(flag(s.args, '--settings'), undefined);
    assert.equal(flag(s.args, '--tools'), undefined);
    assert.equal(s.scopeFile, null);
  }
});

test('aiPrompt: a bad readRoots type is refused before anything starts', async () => {
  await assert.rejects(() => aiService.aiPrompt('demo', appDir, { message: 'hi', allowedTools: ['Read'], readRoots: '/etc' }), /readRoots must be an array/);
});
