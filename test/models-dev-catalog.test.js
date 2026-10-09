// The models.dev merge: prices, limits and lifecycle come from the catalog with
// no model in the loop, `disabled` is never touched, third-party rows are
// update-only, Anthropic rows are added through the pricing file, and the
// "still unpriced" list is what decides whether the one lookup spawns at all.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const caps = require('../src/capabilities');

const RAW = {
  anthropic: { id: 'anthropic', name: 'Anthropic', models: {
    'claude-opus-5': { id: 'claude-opus-5', name: 'Claude Opus 5 (latest)', reasoning: true,
      modalities: { input: ['text'], output: ['text'] }, limit: { context: 1000000, output: 128000 },
      cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } },
    'claude-brandnew-6': { id: 'claude-brandnew-6', name: 'Claude Brandnew 6', description: 'fresh', reasoning: true,
      modalities: { input: ['text'], output: ['text'] }, limit: { context: 200000, output: 64000 },
      cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
    'claude-opus-5-20260101': { id: 'claude-opus-5-20260101', name: 'Claude Opus 5 (dated)',
      modalities: { input: ['text'], output: ['text'] }, limit: { context: 1, output: 1 },
      cost: { input: 999, output: 999 } },
    'claude-sonnet-4-20250514': { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4',
      modalities: { input: ['text'], output: ['text'] }, limit: { context: 200000, output: 64000 },
      cost: { input: 3, output: 15 } },
  } },
  openai: { id: 'openai', name: 'OpenAI', models: {
    'gpt-5': { id: 'gpt-5', name: 'GPT-5', description: 'flagship', reasoning: true,
      modalities: { input: ['text'], output: ['text'] }, limit: { context: 400000, output: 128000 },
      cost: { input: 1.25, output: 10, cache_read: 0.125 } },
    'o1': { id: 'o1', name: 'o1', status: 'deprecated',
      modalities: { input: ['text'], output: ['text'] }, limit: { context: 200000, output: 100000 },
      cost: { input: 15, output: 60, cache_read: 7.5 } },
    'gpt-image-1': { id: 'gpt-image-1', name: 'GPT Image 1',
      modalities: { input: ['text'], output: ['image'] }, limit: { context: 1, output: 1 } },
    'gpt-unknown': { id: 'gpt-unknown', name: 'Not in registry',
      modalities: { input: ['text'], output: ['text'] }, limit: { context: 1, output: 1 },
      cost: { input: 1, output: 1 } },
  } },
  moonshotai: { id: 'moonshotai', name: 'Moonshot AI', models: {
    'kimi-k3': { id: 'kimi-k3', name: 'Kimi K3',
      modalities: { input: ['text'], output: ['text'] }, limit: { context: 256000, output: 32000 },
      cost: { input: 0.6, output: 2.5, cache_read: 0.15 } },
  } },
  mistral: { id: 'mistral', name: 'Mistral', models: {
    'mistral-large': { id: 'mistral-large', name: 'Mistral Large',
      modalities: { input: ['text'], output: ['text'] }, limit: { context: 1, output: 1 }, cost: { input: 1, output: 1 } },
  } },
};

function withRegistry(models, fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-modelsdev-'));
  fs.mkdirSync(path.join(base, 'capabilities'), { recursive: true });
  fs.writeFileSync(path.join(base, 'capabilities', 'models.json'), JSON.stringify({
    providers: {
      anthropic: { label: 'Anthropic' },
      openai: { label: 'OpenAI', apiBaseUrl: 'https://api.openai.com/v1' },
      moonshot: { label: 'Kimi / Moonshot', apiBaseUrl: 'https://api.moonshot.ai/v1' },
    },
    models,
  }));
  try { return fn(base); } finally { fs.rmSync(base, { recursive: true, force: true }); }
}

const row = (o) => ({
  name: o.modelId, label: o.modelId, description: '', provider: 'openai', modelId: o.modelId,
  systemPromptMode: 'replace', reasoning: false, disabled: false, lifecycle: 'current', ...o,
});

test('normalize: supported providers only, non-text dropped, dated Anthropic ids collapse', () => {
  const cat = caps.normalizeModelsDevCatalog(RAW);
  assert.deepStrictEqual(Object.keys(cat).sort(), ['anthropic', 'moonshot', 'openai']);
  assert.ok(!cat.openai['gpt-image-1'], 'image model dropped');
  assert.ok(!cat.anthropic['claude-opus-5-20260101'], 'dated duplicate dropped');
  assert.strictEqual(cat.anthropic['claude-opus-5'].inputCostPerMTok, 5, 'undated wins over dated');
  assert.ok(cat.anthropic['claude-sonnet-4'], 'lone dated id keyed by its family name');
  assert.strictEqual(cat.anthropic['claude-opus-5'].label, 'Claude Opus 5', '(latest) suffix stripped');
  assert.strictEqual(cat.openai['gpt-5'].cacheCreateCostPerMTok, null, 'unpublished rate is null');
  assert.strictEqual(cat.openai.o1.deprecated, true);
});

test('apply: prices and limits land, disabled stays, placeholders get labels, deprecated flagged', () => {
  withRegistry([
    row({ modelId: 'gpt-5', providerKey: 'openai', disabled: true, inputCostPerMTok: 1, outputCostPerMTok: 8 }),
    row({ modelId: 'o1', providerKey: 'openai', label: 'My o1', disabled: false }),
    row({ modelId: 'kimi-k3', providerKey: 'moonshot', disabled: false, cacheCreateCostPerMTok: 3 }),
    row({ modelId: 'gpt-5-mini', providerKey: 'openai', disabled: false }),
  ], (base) => {
    const res = caps.applyModelsDevCatalog(base, caps.normalizeModelsDevCatalog(RAW));
    const after = Object.fromEntries(caps.listModels(base).map(m => [m.modelId, m]));

    assert.strictEqual(after['gpt-5'].disabled, true, 'disabled untouched');
    assert.strictEqual(after['gpt-5'].inputCostPerMTok, 1.25);
    assert.strictEqual(after['gpt-5'].outputCostPerMTok, 10);
    assert.strictEqual(after['gpt-5'].cacheReadCostPerMTok, 0.125);
    assert.strictEqual(after['gpt-5'].contextWindow, 400000);
    assert.strictEqual(after['gpt-5'].label, 'GPT-5', 'placeholder label replaced');
    assert.strictEqual(after['gpt-5'].description, 'flagship');

    assert.strictEqual(after.o1.label, 'My o1', 'chosen label kept');
    assert.strictEqual(after.o1.lifecycle, 'deprecated');
    assert.strictEqual(after.o1.disabled, false, 'deprecation does not disable');

    assert.strictEqual(after['kimi-k3'].inputCostPerMTok, 0.6, 'moonshotai maps onto moonshot');
    assert.strictEqual(after['kimi-k3'].cacheCreateCostPerMTok, 3, 'a rate the catalog lacks does not erase a known one');
    assert.ok(!after['gpt-unknown'], 'third-party rows are never added');
    assert.strictEqual(after['gpt-5-mini'].inputCostPerMTok, null, 'unlisted row untouched');

    assert.deepStrictEqual(res.openai.deprecated, ['My o1']);
    assert.ok(res.openai.repriced.includes('GPT-5'));
    assert.ok(res.moonshot.repriced.includes('Kimi K3'));
  });
});

test('apply: Anthropic goes through the pricing file and new models are added', () => {
  withRegistry([
    row({ modelId: 'claude-opus-5', providerKey: 'anthropic', provider: 'anthropic', disabled: true, inputCostPerMTok: 1, outputCostPerMTok: 1 }),
  ], (base) => {
    const res = caps.applyModelsDevCatalog(base, caps.normalizeModelsDevCatalog(RAW));
    const after = Object.fromEntries(caps.listModels(base).map(m => [m.modelId, m]));
    assert.strictEqual(after['claude-opus-5'].inputCostPerMTok, 5);
    assert.strictEqual(after['claude-opus-5'].disabled, true, 'disabled untouched');
    assert.ok(after['claude-brandnew-6'], 'new Anthropic model added');
    assert.strictEqual(after['claude-brandnew-6'].isNew, true);
    assert.strictEqual(after['claude-brandnew-6'].reasoning, true);
    assert.strictEqual(after['claude-brandnew-6'].context1m, false);
    assert.strictEqual(after['claude-brandnew-6'].cacheCreateCostPerMTok, 3.75);
    assert.ok(res.anthropic.added.includes('Claude Brandnew 6'));

    const file = JSON.parse(fs.readFileSync(path.join(base, 'capabilities', 'anthropic-pricing.json'), 'utf-8'));
    assert.strictEqual(file['claude-opus-5'].context1m, true);
    assert.strictEqual(file['claude-brandnew-6'].lifecycle, 'current');
  });
});

test('apply: a second run is a no-op', () => {
  withRegistry([
    row({ modelId: 'gpt-5', providerKey: 'openai' }),
  ], (base) => {
    const cat = caps.normalizeModelsDevCatalog(RAW);
    caps.applyModelsDevCatalog(base, cat);
    const res = caps.applyModelsDevCatalog(base, cat);
    assert.deepStrictEqual(res.openai.updated, []);
  });
});

test('unpriced: only enabled, non-retired rows without a price count', () => {
  withRegistry([
    row({ modelId: 'a', providerKey: 'openai', disabled: false }),
    row({ modelId: 'b', providerKey: 'openai', disabled: true }),
    row({ modelId: 'c', providerKey: 'openai', disabled: false, lifecycle: 'retired' }),
    row({ modelId: 'd', providerKey: 'openai', disabled: false, inputCostPerMTok: 1, outputCostPerMTok: 2 }),
    row({ modelId: 'e', providerKey: 'openai', disabled: false, inputCostPerMTok: 1 }),
  ], (base) => {
    assert.deepStrictEqual(caps.listUnpricedModels(base).map(m => m.modelId), ['a', 'e']);
  });
});
