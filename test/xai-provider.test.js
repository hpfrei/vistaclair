// xAI (Grok) as a provider: requests go to the Responses API with no
// reasoning effort, the /models scan keeps text models only, and the
// models.dev catalog maps onto the `xai` provider key.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const caps = require('../src/capabilities');
const { getProvider } = require('../src/providers/registry');

const grok = {
  name: 'grok-4.7', providerKey: 'xai', provider: 'openai-responses', modelId: 'grok-4.7',
  apiBaseUrl: 'https://api.x.ai/v1', apiKey: 'xai-test', systemPromptMode: 'passthrough',
  reasoning: true, maxOutputTokens: 500000,
};

const anthropicBody = {
  model: 'claude-sonnet-5',
  max_tokens: 32000,
  temperature: 1,
  thinking: { type: 'enabled', budget_tokens: 31999 },
  system: [{ type: 'text', text: 'be brief' }],
  tools: [
    { name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
    { type: 'web_search_20250305', name: 'web_search' },
  ],
  messages: [{ role: 'user', content: 'hi' }],
};

test('xai routes through the Responses adapter', () => {
  assert.strictEqual(caps.PROVIDER_ADAPTER_MAP.xai, 'openai-responses');
});

test('request: /responses on api.x.ai, bearer key, no reasoning effort, native web search', () => {
  const { url, headers, body } = getProvider('openai-responses').translateRequest(structuredClone(anthropicBody), grok);
  assert.strictEqual(url, 'https://api.x.ai/v1/responses');
  assert.strictEqual(headers.Authorization, 'Bearer xai-test');
  assert.strictEqual(body.model, 'grok-4.7');
  assert.strictEqual(body.reasoning, undefined, 'Grok picks its own effort');
  assert.strictEqual(body.max_output_tokens, 32000);
  assert.deepStrictEqual(body.tools.map(t => t.type + ':' + (t.name || '')), ['function:Read', 'web_search:']);
});

test('request: OpenAI models still get a reasoning effort', () => {
  const gpt = { ...grok, providerKey: 'openai', modelId: 'gpt-5', apiBaseUrl: 'https://api.openai.com/v1' };
  const { body } = getProvider('openai-responses').translateRequest(structuredClone(anthropicBody), gpt);
  assert.deepStrictEqual(body.reasoning, { effort: 'high' });
});

test('scan: xAI /models keeps text models, drops Imagine, voice and multi-agent', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-xai-'));
  fs.mkdirSync(path.join(base, 'capabilities'), { recursive: true });
  fs.writeFileSync(path.join(base, 'capabilities', 'models.json'), JSON.stringify({
    providers: { xai: { label: 'xAI (Grok)', apiBaseUrl: 'https://api.x.ai/v1' } },
    models: [],
  }));
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push({ url, auth: opts?.headers?.Authorization });
    return { ok: true, json: async () => ({ data: [
      'grok-4.7', 'grok-build-0.1', 'grok-imagine-image', 'grok-imagine-video-1.5',
      'grok-voice-think-fast-2.0', 'grok-4.20-multi-agent-0309',
    ].map(id => ({ id })) }) };
  };
  try {
    caps.saveProvider(base, 'xai', { label: 'xAI (Grok)', apiBaseUrl: 'https://api.x.ai/v1', apiKey: 'xai-test' });
    const res = await caps.scanProviderModels(base);
    assert.strictEqual(seen[0].url, 'https://api.x.ai/v1/models');
    assert.strictEqual(seen[0].auth, 'Bearer xai-test');
    assert.deepStrictEqual(res.xai.added.map(a => a.modelId).sort(), ['grok-4.7', 'grok-build-0.1']);
    const added = caps.listModels(base).filter(m => m.providerKey === 'xai');
    assert.ok(added.every(m => m.provider === 'openai-responses' && m.disabled));
  } finally {
    global.fetch = realFetch;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('models.dev: the xai catalog maps onto the xai provider, non-text dropped', () => {
  const cat = caps.normalizeModelsDevCatalog({ xai: { id: 'xai', models: {
    'grok-4.7': { id: 'grok-4.7', name: 'Grok 4.7', reasoning: true,
      modalities: { input: ['text'], output: ['text'] }, limit: { context: 500000, output: 500000 },
      cost: { input: 2, output: 6, cache_read: 0.5 } },
    'grok-imagine-image': { id: 'grok-imagine-image', name: 'Grok Imagine',
      modalities: { input: ['text'], output: ['image'] }, limit: { context: 16000, output: 0 } },
  } } });
  assert.deepStrictEqual(Object.keys(cat.xai), ['grok-4.7']);
  assert.strictEqual(cat.xai['grok-4.7'].inputCostPerMTok, 2);
  assert.strictEqual(cat.xai['grok-4.7'].cacheReadCostPerMTok, 0.5);
});
