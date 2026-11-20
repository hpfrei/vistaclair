// The ai.prompt tool gate (ai-service.prepareToolGate): the tmpdir marker the
// core ai-tool-gate proxy rule enforces, and the CLI --allowedTools. The CLI
// defers tool schemas behind ToolSearch, so a non-empty grant must carry it;
// an omitted (or null) list is the same as `[]`: no tools, never ungated.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { core } = require('../src/apps/core-services');
const aiService = require('../src/apps/ai-service');
const platformSettings = require('../src/apps/platform-settings');
const spendGate = require('../src/apps/spend-gate');
const spendLedger = require('../src/apps/spend-ledger');

// Markers land in os.tmpdir(): point it at a throwaway dir for this file.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tool-gate-'));
const savedTmp = process.env.TMPDIR;
process.env.TMPDIR = tmp;
test.after(() => {
  if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function gateMarker(allowedTools) {
  const instanceId = aiService.mintInstanceId('sb-demo');
  const gate = aiService.prepareToolGate('sb-demo', instanceId, allowedTools);
  try {
    return gate.gateFile ? JSON.parse(fs.readFileSync(gate.gateFile, 'utf8')) : null;
  } finally {
    if (gate.gateFile) fs.unlinkSync(gate.gateFile);
  }
}

test('a non-empty grant puts ToolSearch in the gate marker', () => {
  const spec = gateMarker(['mcp__app-tools__*', 'AskUserQuestion', 'WebSearch', 'WebFetch']);
  assert.deepEqual(spec, { tools: ['mcp__app-tools__*', 'AskUserQuestion', 'WebSearch', 'WebFetch', 'ToolSearch'] });
  assert.deepEqual(gateMarker(['Read', 'ToolSearch']), { tools: ['Read', 'ToolSearch'] }, 'never twice');
});

test('[], an omitted list and null all write {none:true}', () => {
  assert.deepEqual(gateMarker([]), { none: true });
  assert.deepEqual(gateMarker(undefined), { none: true });
  assert.deepEqual(gateMarker(null), { none: true });
  assert.throws(() => gateMarker('Read'), /allowedTools must be an array/);
});

async function withMockedSpawn(fn) {
  const seen = [];
  const saved = {
    build: core.buildClaudeArgs, spawn: core.spawnClaude, get: platformSettings.get,
    auth: spendGate.authorize, tap: spendGate.tapActive, clear: spendGate.clearMarker,
    rec: spendLedger.recordSession,
  };
  platformSettings.get = () => undefined;
  spendGate.authorize = () => ({ ok: true });
  spendGate.tapActive = () => true;
  spendGate.clearMarker = () => {};
  spendLedger.recordSession = () => {};
  core.buildClaudeArgs = (opts, flags) => { seen.push({ allowedTools: opts.allowedTools, skipTools: flags.skipTools }); return []; };
  core.spawnClaude = (args, opts) => {
    const { EventEmitter } = require('events');
    const markers = fs.readdirSync(tmp).filter((f) => f.startsWith('vistaclair-ai-allowed-'));
    seen[seen.length - 1].spawn = {
      extraEnv: opts.extraEnv,
      marker: markers.length ? JSON.parse(fs.readFileSync(path.join(tmp, markers[0]), 'utf8')) : null,
    };
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write() {}, end() {} };
    setImmediate(() => { proc.stdout.emit('data', Buffer.from('ok')); proc.emit('exit', 0); });
    return proc;
  };
  try {
    await fn(seen);
    return seen;
  } finally {
    core.buildClaudeArgs = saved.build; core.spawnClaude = saved.spawn; platformSettings.get = saved.get;
    spendGate.authorize = saved.auth; spendGate.tapActive = saved.tap; spendGate.clearMarker = saved.clear;
    spendLedger.recordSession = saved.rec;
  }
}

test('the CLI --allowedTools carries ToolSearch only for a non-empty grant; omitted = []', async () => {
  const seen = await withMockedSpawn(async () => {
    await aiService.aiPrompt('sb-demo', process.cwd(), { message: 'hi', allowedTools: ['WebFetch'] });
    await aiService.aiPrompt('sb-demo', process.cwd(), { message: 'hi', allowedTools: [] });
    await aiService.aiPrompt('sb-demo', process.cwd(), { message: 'hi' });
    await aiService.aiPrompt('sb-demo', process.cwd(), { message: 'hi', allowedTools: null });
  });
  assert.deepEqual(seen.map((s) => ({ allowedTools: s.allowedTools, skipTools: s.skipTools, marker: s.spawn.marker })), [
    { allowedTools: ['WebFetch', 'ToolSearch'], skipTools: false, marker: { tools: ['WebFetch', 'ToolSearch'] } },
    { allowedTools: undefined, skipTools: true, marker: { none: true } },
    { allowedTools: undefined, skipTools: true, marker: { none: true } },
    { allowedTools: undefined, skipTools: true, marker: { none: true } },
  ]);
});

test('the AI child env drops AUTH_TOKEN and VISTACLAIR_AUTH_TOKEN and nothing else', async () => {
  const seen = await withMockedSpawn(async () => {
    await aiService.aiPrompt('sb-demo', process.cwd(), { message: 'hi' });
  });
  const extra = seen[0].spawn.extraEnv;
  assert.deepEqual(Object.keys(extra).sort(), ['AUTH_TOKEN', 'VISTACLAIR_AUTH_TOKEN']);
  assert.ok(Object.values(extra).every((v) => v === undefined));
  // Composed the way core builds it ({ ...process.env, ...extraEnv }) and
  // handed to a real child: the tokens are gone, the rest of the env stays.
  process.env.AUTH_TOKEN = 'secret-a'; process.env.VISTACLAIR_AUTH_TOKEN = 'secret-b';
  try {
    const out = require('child_process').execFileSync(process.execPath, ['-e',
      'console.log(JSON.stringify([process.env.AUTH_TOKEN, process.env.VISTACLAIR_AUTH_TOKEN, !!process.env.PATH]))'],
    { env: { ...process.env, ...extra } }).toString();
    assert.deepEqual(JSON.parse(out), [null, null, true]);
  } finally { delete process.env.AUTH_TOKEN; delete process.env.VISTACLAIR_AUTH_TOKEN; }
});
