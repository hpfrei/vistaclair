// The native (non-text) model catalog: every entry is well formed, the models
// the platform's media calls use are flagged with that call, and each provider
// listing carries its own native models for the Models page.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { NATIVE_MODELS } = require('../src/native-models');
const caps = require('../src/capabilities');

const KINDS = new Set(['speech', 'transcription', 'image', 'video', 'realtime', 'embedding', 'music']);

test('catalog: ids unique per provider, known kinds, labels present', () => {
  for (const [provider, models] of Object.entries(NATIVE_MODELS)) {
    const ids = models.map(m => m.modelId);
    assert.strictEqual(new Set(ids).size, ids.length, `${provider}: duplicate modelId`);
    for (const m of models) {
      assert.ok(m.label, `${provider}/${m.modelId}: label`);
      assert.ok(KINDS.has(m.kind), `${provider}/${m.modelId}: kind ${m.kind}`);
    }
  }
});

test('catalog: the media calls\' default models are flagged as used', () => {
  const usedBy = (p, id) => NATIVE_MODELS[p].find(m => m.modelId === id)?.usedBy;
  assert.strictEqual(usedBy('openai', 'gpt-4o-mini-tts'), 'ai.tts');
  assert.strictEqual(usedBy('openai', 'gpt-4o-mini-transcribe'), 'ai.transcribe');
  assert.strictEqual(usedBy('google', 'gemini-3.1-flash-image'), 'ai.image');
  assert.strictEqual(usedBy('xai', 'xai-tts'), 'ai.tts');
});

test('listProviders: each provider carries its native models, none for text-only ones', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-native-'));
  fs.mkdirSync(path.join(base, 'capabilities'), { recursive: true });
  fs.writeFileSync(path.join(base, 'capabilities', 'models.json'), JSON.stringify({
    providers: { xai: { label: 'xAI (Grok)', apiBaseUrl: 'https://api.x.ai/v1' }, deepseek: { label: 'DeepSeek' } },
    models: [],
  }));
  try {
    const byKey = Object.fromEntries(caps.listProviders(base).map(p => [p.key, p]));
    assert.ok(byKey.xai.native.some(m => m.modelId === 'xai-tts'));
    assert.deepStrictEqual(byKey.deepseek.native, []);
    byKey.xai.native[0].label = 'mutated';
    assert.notStrictEqual(NATIVE_MODELS.xai[0].label, 'mutated', 'listing hands out copies');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('listNativeModels: one flat list, providerKey on every entry, model ids unique platform-wide', () => {
  const { listNativeModels } = require('../src/native-models');
  const all = listNativeModels();
  assert.strictEqual(all.length, Object.values(NATIVE_MODELS).reduce((n, l) => n + l.length, 0));
  for (const m of all) assert.ok(NATIVE_MODELS[m.providerKey].some(x => x.modelId === m.modelId));
  // Pro resolves a bare `model` to its provider by id, so an id may not repeat.
  const ids = all.map(m => m.modelId);
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate modelId across providers');
  all[0].label = 'mutated';
  assert.notStrictEqual(listNativeModels()[0].label, 'mutated', 'listing hands out copies');
});

test('the addon ctx exposes the catalog and the registry refresh to Pro', () => {
  const { createAddonCtx } = require('../src/addon-host');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-native-ctx-'));
  try {
    const ctx = createAddonCtx({ dataHome: base });
    assert.strictEqual(typeof ctx.listNativeModels, 'function');
    assert.strictEqual(typeof ctx.refreshModels, 'function');
    assert.ok(ctx.listNativeModels().some(m => m.providerKey === 'xai' && m.modelId === 'xai-tts'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('refreshModelRegistry: scan then catalog; a catalog failure is reported, not thrown', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-native-refresh-'));
  fs.mkdirSync(path.join(base, 'capabilities'), { recursive: true });
  fs.writeFileSync(path.join(base, 'capabilities', 'models.json'), JSON.stringify({ providers: {}, models: [] }));
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('offline'); };
  try {
    const r = await caps.refreshModelRegistry(base);
    assert.ok(r.scan && typeof r.scan === 'object');
    assert.strictEqual(r.catalog, null);
    assert.match(r.catalogError, /offline/);
  } finally {
    global.fetch = realFetch;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
