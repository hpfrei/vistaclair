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
