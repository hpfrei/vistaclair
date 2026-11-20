// Model resolution for headless calls (ai-service.resolveModelForCall): the
// bare Claude tier aliases the CLI accepts, and the ref a spawn is given.
// The registry is faked through core-services (what core.listModels returns).
const test = require('node:test');
const assert = require('node:assert/strict');
const { core } = require('../src/apps/core-services');
const aiService = require('../src/apps/ai-service');
const platformSettings = require('../src/apps/platform-settings');
const spendGate = require('../src/apps/spend-gate');
const spendLedger = require('../src/apps/spend-ledger');

const M = (name, extra = {}) => ({ name, modelId: name, providerKey: 'anthropic', lifecycle: 'current', ...extra });
const REGISTRY = [
  // dated snapshot ids, exactly as core's models.json carries them
  M('claude-opus-4-6', { modelId: 'claude-opus-4-6-20250515' }),
  M('claude-opus-4-7', { modelId: 'claude-opus-4-7-20250715', disabled: true }),
  M('claude-haiku-4-5', { modelId: 'claude-haiku-4-5-20251001' }),
  M('claude-fable-5'),
  M('claude-fable-5-1'),
  M('claude-opus-5'),
  M('claude-sonnet-5'),
  M('gemini-3-pro', { providerKey: 'google', modelId: 'gemini-3-pro-preview' }),
  M('claude-opus-4-1', { lifecycle: 'retired' }),
];

function withRegistry(models, fn) {
  const prev = core.listModels;
  core.listModels = () => models;
  try { return fn(); } finally { core.listModels = prev; }
}
const resolve = (requested, models = REGISTRY) =>
  withRegistry(models, () => aiService.resolveModelForCall('sb-demo', requested));

test('every Claude family the CLI aliases resolves to its newest current model', () => {
  // A bare tier is what callers actually pass; without tier matching it used
  // to fall through to "whatever the registry lists first".
  assert.equal(resolve('fable').name, 'claude-fable-5-1');
  assert.equal(resolve('opus').name, 'claude-opus-5');
  assert.equal(resolve('sonnet').name, 'claude-sonnet-5');
  assert.equal(resolve('haiku').name, 'claude-haiku-4-5');
  // a bare alias is a shorthand, not a stale model: resolved silently
  assert.equal(resolve('fable').substituted, true);
});

test('a disabled or retired model never wins its tier', () => {
  assert.equal(resolve('claude-opus-4-1').name, 'claude-opus-5');   // retired → newest opus
  assert.notEqual(resolve('opus').name, 'claude-opus-4-7');          // disabled
});

test('the spawn ref is the undated Anthropic name, the modelId elsewhere', () => {
  // The registry's dated snapshot is what the API rejected with not_found.
  const opus = resolve('claude-opus-4-6');
  assert.equal(opus.modelId, 'claude-opus-4-6-20250515');
  assert.equal(opus.ref, 'claude-opus-4-6');
  assert.equal(resolve('fable').ref, 'claude-fable-5-1');
  // non-Anthropic providers still route by their modelId
  assert.equal(resolve('gemini-3-pro').ref, 'gemini-3-pro-preview');
});

test('an unknown model still resolves to something current, an exact name is passed through', () => {
  assert.equal(resolve('claude-fable-5-1').substituted, false);
  const unknown = resolve('llama-9');
  assert.equal(unknown.substituted, true);
  assert.ok(unknown.ref);
  // nothing to resolve against → the request survives untouched
  const bare = resolve('fable', []);
  assert.equal(bare.substituted, false);
  assert.equal(bare.ref, 'fable');
});

// --- the platform default: what an OMITTED model resolves to ------------------

const cliModel = (requested, models = REGISTRY) =>
  withRegistry(models, () => aiService.cliModelFor('sb-demo', requested));

function withDefault(ref, fn) {
  const prev = platformSettings.get;
  platformSettings.get = (k) => (k === 'directModel' ? ref : prev(k));
  try { return fn(); } finally { platformSettings.get = prev; }
}

// Anthropic ids as the registry really stores them: undated (core strips the
// date suffix — a dated snapshot is answered not_found).
const UNDATED = [M('claude-haiku-4-5'), M('claude-sonnet-5'), M('claude-opus-5')];

test('an omitted model takes the platform default, never undefined', () => {
  withDefault('claude-haiku-4-5', () => {
    assert.equal(resolve(undefined).name, 'claude-haiku-4-5');
    assert.equal(cliModel(undefined), 'claude-haiku-4-5');
  });
});

test('a stale DATED default is repaired to its tier, not spawned verbatim', () => {
  // The registry holds no dated row, so a blind pass-through would hand the CLI
  // an id the API refuses. The default is resolved like any other ref.
  withDefault('claude-haiku-4-5-20251001', () => {
    assert.equal(cliModel(undefined, UNDATED), 'claude-haiku-4-5');
  });
});

test('a named model is spawned by its routable ref, never the raw request', () => {
  // Found by modelId, current, not substituted — the spawn must still get the
  // undated name, which is the whole point of routableRef.
  assert.equal(cliModel('claude-opus-4-6-20250515'), 'claude-opus-4-6');
  assert.equal(cliModel('fable'), 'claude-fable-5-1');
});

test('with nothing to resolve against, the spawn gets no --model at all', () => {
  // undefined (not null/'') so buildClaudeArgs omits the flag and the CLI keeps
  // its own default, rather than spawning a known-dead id.
  withDefault('', () => { assert.equal(cliModel(undefined, []), undefined); });
});

// --- detecting a model that stopped working ----------------------------------

test('an unavailable model is detected in BOTH shapes the CLI emits', () => {
  // Captured verbatim from the CLI: an unknown id puts a machine-readable
  // marker on stderr; a retired snapshot puts prose on stdout and no marker.
  assert.ok(aiService.isModelUnavailable('[claude-code:unrecognized_model] {"model":"x","query_source":"sdk"}'));
  assert.ok(aiService.isModelUnavailable("There's an issue with the selected model (claude-3-opus-20240229). It may not exist or you may not have access to it."));
  assert.ok(aiService.isModelUnavailable("The model 'claude-3-opus-20240229' is deprecated and will reach end-of-life on January 5th, 2026"));
  // an ordinary failure must NOT be mistaken for a dead model
  assert.ok(!aiService.isModelUnavailable('AI failed (code 1): socket hang up'));
  assert.ok(!aiService.isModelUnavailable(''));
});

function fakeProc(exitCode, { stdout = '', stderr = '' } = {}) {
  const { EventEmitter } = require('events');
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write() {}, end() {} };
  setImmediate(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('exit', exitCode);
  });
  return proc;
}

test('a model that is dead at the API falls back ONCE to the platform default', async () => {
  // The registry can lag a retirement: the model resolves fine, then the call
  // fails. Not transient — replaying the same id just fails again.
  const spawned = [];
  const saved = {
    build: core.buildClaudeArgs, spawn: core.spawnClaude, list: core.listModels,
    get: platformSettings.get, auth: spendGate.authorize, tap: spendGate.tapActive,
    clear: spendGate.clearMarker, rec: spendLedger.recordSession,
  };
  core.listModels = () => UNDATED.concat(M('claude-opus-4-6'));
  platformSettings.get = (k) => (k === 'directModel' ? 'claude-haiku-4-5' : saved.get(k));
  spendGate.authorize = () => ({ ok: true });
  spendGate.tapActive = () => true;
  spendGate.clearMarker = () => {};
  spendLedger.recordSession = () => {};
  core.buildClaudeArgs = (opts) => (opts.model ? ['--model', opts.model] : []);
  core.spawnClaude = (args) => {
    spawned.push(args[args.indexOf('--model') + 1]);
    return spawned.length === 1
      ? fakeProc(1, { stderr: '[claude-code:unrecognized_model] {"model":"claude-opus-4-6"}' })
      : fakeProc(0, { stdout: 'ok' });
  };
  try {
    const out = await aiService.aiPrompt('sb-demo', process.cwd(), {
      message: 'hi', model: 'claude-opus-4-6', allowedTools: [],
    });
    assert.equal(out.text, 'ok');
    assert.deepEqual(spawned, ['claude-opus-4-6', 'claude-haiku-4-5']);
  } finally {
    core.buildClaudeArgs = saved.build; core.spawnClaude = saved.spawn; core.listModels = saved.list;
    platformSettings.get = saved.get; spendGate.authorize = saved.auth; spendGate.tapActive = saved.tap;
    spendGate.clearMarker = saved.clear; spendLedger.recordSession = saved.rec;
  }
});

test('the fallback does not loop when the default itself is dead', async () => {
  const spawned = [];
  const saved = {
    build: core.buildClaudeArgs, spawn: core.spawnClaude, list: core.listModels,
    get: platformSettings.get, auth: spendGate.authorize, tap: spendGate.tapActive,
    clear: spendGate.clearMarker, rec: spendLedger.recordSession,
  };
  core.listModels = () => UNDATED;
  platformSettings.get = (k) => (k === 'directModel' ? 'claude-haiku-4-5' : saved.get(k));
  spendGate.authorize = () => ({ ok: true });
  spendGate.tapActive = () => true;
  spendGate.clearMarker = () => {};
  spendLedger.recordSession = () => {};
  core.buildClaudeArgs = (opts) => (opts.model ? ['--model', opts.model] : []);
  core.spawnClaude = (args) => {
    spawned.push(args[args.indexOf('--model') + 1]);
    return fakeProc(1, { stderr: '[claude-code:unrecognized_model] {}' });
  };
  try {
    await assert.rejects(
      aiService.aiPrompt('sb-demo', process.cwd(), { message: 'hi', model: 'claude-sonnet-5', allowedTools: [] }),
      /unavailable/,
    );
    // exactly one retry: the original, then the default — never a third
    assert.deepEqual(spawned, ['claude-sonnet-5', 'claude-haiku-4-5']);
  } finally {
    core.buildClaudeArgs = saved.build; core.spawnClaude = saved.spawn; core.listModels = saved.list;
    platformSettings.get = saved.get; spendGate.authorize = saved.auth; spendGate.tapActive = saved.tap;
    spendGate.clearMarker = saved.clear; spendLedger.recordSession = saved.rec;
  }
});

// --- the ai.models payload: what a picker is allowed to gate on ------------
//
// `configuredOnly` used to filter on `hasApiKey`, a fact about the secrets
// store. Anthropic models never appear in that store — they route through the
// `claude` CLI and authenticate with its login — so every one of them was
// deleted from every picker on any install that uses a subscription rather than
// a pasted key, while remaining perfectly callable. The payload now carries
// core's credential decision and `configuredOnly` reads that.

// Fakes the host seam core normally provides (listModelsWithAvailability).
function withAvailability(models, fn) {
  const prev = core.listModelsWithAvailability;
  core.listModelsWithAvailability = () => models;
  try { return fn(); } finally { core.listModelsWithAvailability = prev; }
}

const A = (name, extra = {}) => ({
  name, modelId: name, providerKey: 'anthropic', lifecycle: 'current',
  apiKey: '', usable: true, unusableReason: null, credential: 'subscription', ...extra,
});

const AVAIL = [
  // No stored key anywhere — callable on the CLI login.
  A('claude-opus-5'),
  A('claude-haiku-4-5'),
  A('claude-opus-4-7', { usable: false, unusableReason: 'disabled', credential: null, disabled: true }),
  A('claude-opus-4-1', { usable: false, unusableReason: 'retired', credential: null, lifecycle: 'retired' }),
  A('gpt-5', { providerKey: 'openai', apiKey: 'sk-openai', credential: 'api-key' }),
  A('gemini-3-pro', { providerKey: 'google', usable: false, unusableReason: 'no-credential', credential: null }),
];

test('configuredOnly keeps keyless Anthropic models that a subscription can call', () => {
  withAvailability(AVAIL, () => {
    const names = aiService.modelsPayload({ configuredOnly: true }).models.map((m) => m.name);
    // The exact regression: these carry hasApiKey:false and must still be offered.
    assert.ok(names.includes('claude-opus-5'));
    assert.ok(names.includes('claude-haiku-4-5'));
    // …while a genuinely uncallable model stays out, whatever the reason.
    assert.ok(!names.includes('claude-opus-4-7'));
    assert.ok(!names.includes('claude-opus-4-1'));
    assert.ok(!names.includes('gemini-3-pro'));
    assert.ok(names.includes('gpt-5'));
  });
});

test('the payload reports why a model is unusable instead of going quiet', () => {
  withAvailability(AVAIL, () => {
    const by = Object.fromEntries(aiService.modelsPayload({}).models.map((m) => [m.name, m]));
    assert.equal(by['claude-opus-4-7'].unusableReason, 'disabled');
    assert.equal(by['claude-opus-4-1'].unusableReason, 'retired');
    assert.equal(by['gemini-3-pro'].unusableReason, 'no-credential');
    assert.equal(by['claude-opus-5'].unusableReason, null);
  });
});

test('hasApiKey stays truthful about storage but no longer decides usability', () => {
  withAvailability(AVAIL, () => {
    const by = Object.fromEntries(aiService.modelsPayload({}).models.map((m) => [m.name, m]));
    assert.equal(by['claude-opus-5'].hasApiKey, false);
    assert.equal(by['claude-opus-5'].usable, true);
    assert.equal(by['claude-opus-5'].credential, 'subscription');
    assert.equal(by['gpt-5'].hasApiKey, true);
    assert.equal(by['gpt-5'].credential, 'api-key');
  });
});

test('every model offered by configuredOnly survives resolveModelForCall', () => {
  withAvailability(AVAIL, () => {
    const offered = aiService.modelsPayload({ configuredOnly: true }).models;
    assert.ok(offered.length > 0);
    withRegistry(AVAIL, () => {
      for (const m of offered) {
        const r = aiService.resolveModelForCall('sb-demo', m.name);
        // The invariant that broke: anything a picker offers must route to a
        // real ref without being silently substituted for something else.
        assert.ok(r.ref, `${m.name} was offered but resolves to no ref`);
        assert.equal(r.substituted, false, `${m.name} was offered but got substituted`);
        assert.equal(r.name, m.name);
      }
    });
  });
});

test('enabledOnly offers every enabled, non-retired model whatever its credential state', () => {
  withAvailability(AVAIL, () => {
    const names = aiService.modelsPayload({ enabledOnly: true }).models.map((m) => m.name);
    assert.ok(names.includes('claude-opus-5'));
    assert.ok(names.includes('gpt-5'));
    // enabled but keyless: unusable, yet the owner's Models page has it on
    assert.ok(names.includes('gemini-3-pro'));
    assert.ok(!names.includes('claude-opus-4-7'));
    assert.ok(!names.includes('claude-opus-4-1'));
    // no flag → the full catalog, exactly as before
    assert.equal(aiService.modelsPayload({}).models.length, AVAIL.length);
  });
});

// The join only reaches ai-service when the Pro entry point forwards it to
// appBridge.init; dropping it makes every subscription-only Anthropic model
// read `no-credential` (the key-presence fallback in listModelsResolved).
test('apps.init forwards core\'s credential join to the bridge services', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/apps/index.js'), 'utf8');
  const call = /appBridge\.init\(\{[^\n]*\}\);/.exec(src);
  assert.ok(call, 'appBridge.init call not found');
  assert.match(call[0], /listModelsWithAvailability: options\.listModelsWithAvailability/);
});

test('without the join, a keyless Anthropic model falls back to no-credential', () => {
  const prev = core.listModelsWithAvailability;
  core.listModelsWithAvailability = null;
  try {
    withRegistry([M('claude-opus-5')], () => {
      const [m] = aiService.modelsPayload({}).models;
      assert.equal(m.usable, false);
      assert.equal(m.unusableReason, 'no-credential');
    });
  } finally { core.listModelsWithAvailability = prev; }
});
