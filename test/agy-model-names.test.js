// The worker models an orchestrator can launch on (docs/agy-workers.md
// "Launch"): agy short names route to agy without `engine`, a name that is no
// worker model is refused up front with the valid names, the cards and the
// launch_cli schema list both families. Pure functions and the card text;
// nothing here starts agy or reaches Google.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { agyLaunchModel, orchestratorCard } = require('../src/orchestration');
const { resolveAgyModel, parseAgyModelList } = require('../src/agy-session');
const { parseProbe } = require('../src/agy-auth');

const LIVE = ['gemini-4-neon-medium', 'gemini-4-hydrogen-high', 'claude-opus-5-5'];

test('short agy names route to agy at a default effort, no engine needed', () => {
  assert.strictEqual(agyLaunchModel({ model: 'neon' }), 'gemini-4-neon-medium');
  assert.strictEqual(agyLaunchModel({ model: 'hydrogen' }), 'gemini-4-hydrogen-medium');
  assert.strictEqual(agyLaunchModel({ model: 'argon' }), 'gemini-4-argon-medium');
  assert.strictEqual(agyLaunchModel({ model: 'hydrogen-high' }), 'gemini-4-hydrogen-high');
  assert.strictEqual(agyLaunchModel({ model: 'neon-xhigh' }), 'gemini-4-neon-xhigh');
  assert.strictEqual(agyLaunchModel({ model: 'flash' }), 'gemini-3.8-flash-medium');
  assert.strictEqual(agyLaunchModel({ model: 'flash-low' }), 'gemini-3.8-flash-low');
  assert.strictEqual(agyLaunchModel({ model: 'gemini-4-argon-low' }), 'gemini-4-argon-low');
  assert.strictEqual(agyLaunchModel({ engine: 'agy' }), 'gemini-4-neon-medium');
  assert.throws(() => agyLaunchModel({ model: 'argon-xhigh' }), /argon has the efforts low, medium, high/);
  assert.throws(() => agyLaunchModel({ model: 'flash-xhigh' }), /flash has the efforts/);
});

test('the agy rules hold for a short name: worktree only, no remote host', () => {
  assert.throws(() => agyLaunchModel({ model: 'hydrogen', isolation: 'none' }), /worktree/);
  assert.throws(() => agyLaunchModel({ model: 'hydrogen', host: 'peer' }), /remote host/);
  assert.strictEqual(agyLaunchModel({ model: 'hydrogen', isolation: 'worktree' }), 'gemini-4-hydrogen-medium');
  assert.throws(() => agyLaunchModel({ model: 'claude-opus-5-5', engine: 'agy' }), /only Google/);
});

test('a Claude worker model stays a Claude worker', () => {
  for (const m of ['sonnet', 'opus', 'fable', 'haiku', 'claude-sonnet-5-5', undefined]) assert.strictEqual(agyLaunchModel({ model: m, isolation: 'none' }), null, String(m));
});

test('a name that is neither Claude nor agy is refused with the valid names', () => {
  assert.throws(() => agyLaunchModel({ model: 'bogus' }), (e) => {
    for (const w of ['fable', 'opus', 'sonnet', 'haiku', 'neon', 'argon', 'hydrogen', 'flash', 'gemini-']) assert.ok(e.message.includes(w), `${w} in: ${e.message}`);
    return true;
  });
  assert.throws(() => agyLaunchModel({ engine: 'agy', model: 'sonnet' }), /neon \| argon \| hydrogen/);
  assert.throws(() => agyLaunchModel({ engine: 'codex', model: 'neon' }), /engine must be "agy"/);
});

test('the live `agy models` id list, when the probe has one, is what a name is checked against', () => {
  assert.strictEqual(agyLaunchModel({ model: 'hydrogen-high' }, LIVE), 'gemini-4-hydrogen-high');
  assert.throws(() => agyLaunchModel({ model: 'argon' }, LIVE), (e) => /not in agy's model list/.test(e.message) && e.message.includes('gemini-4-hydrogen-high') && !e.message.includes('claude-opus'));
  assert.strictEqual(agyLaunchModel({ model: 'argon' }, []), 'gemini-4-argon-medium');   // no list: the static pattern
  assert.strictEqual(resolveAgyModel('gemini-4-neon-medium', { liveIds: LIVE }), 'gemini-4-neon-medium');
});

test('the probe keeps the ids of `agy models`', () => {
  const out = 'gemini-4-neon-medium\tGemini 4 Neon\ngemini-4-hydrogen-high\tHydrogen\nclaude-opus-5-5\tOpus\nFetching...\n';
  assert.deepStrictEqual(parseAgyModelList(out), LIVE);
  assert.deepStrictEqual(parseProbe({ exitCode: 0, stdout: out, stderr: '' }).models, LIVE);
  assert.strictEqual('models' in parseProbe({ exitCode: 0, stdout: 'Fetching...\n', stderr: '' }), false);
});

test('the orchestrator card names every worker model and how to launch each', () => {
  const run = { runId: 'abc123', orchestrator: 'orch-abc123', runDir: '/tmp/run', isolation: 'worktree' };
  const card = orchestratorCard(run);
  for (const w of ['fable', 'opus', 'sonnet', 'haiku', 'neon', 'argon', 'hydrogen', 'hydrogen-high', 'flash', 'gemini-4-', 'worktree', '$0', '5 h quota']) assert.ok(card.includes(w), w);
  assert.ok(!card.includes('Live agy ids'));
  const live = orchestratorCard(run, { agyModels: LIVE });
  assert.ok(live.includes('Live agy ids now: gemini-4-neon-medium, gemini-4-hydrogen-high.'));
});

test('the launch_cli schema describes both families', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'orchestrator-mcp.js'), 'utf8');
  const model = src.split('\n').find(l => l.trim().startsWith('model: { type: "string", description: "The worker'));
  for (const w of ['fable', 'opus', 'sonnet', 'haiku', 'neon', 'argon', 'hydrogen', 'hydrogen-high', 'flash', 'gemini-4-', 'worktree', '$0', '5 h quota']) assert.ok(model.includes(w), w);
});
