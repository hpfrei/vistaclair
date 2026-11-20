// ai.tts providers: OpenAI stays the default, `provider: 'xai'` speaks through
// xAI's /v1/tts with its own body shape and limits, and the result names the
// model so spend-pricing can price it per model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeAppsDir } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const spendPolicy = require('../src/apps/spend-policy');
const spendLedger = require('../src/apps/spend-ledger');
const spendPricing = require('../src/apps/spend-pricing');
const deploymentMode = require('../src/apps/deployment-mode');
const { core } = require('../src/apps/core-services');
const media = require('../src/apps/ai-media');

const appsDir = makeAppsDir({ 'tts-app': { capabilities: { audio: true } } });
appManager.setAppsDir(appsDir);
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-tts-'));
spendPolicy.init({ dataHome });
spendLedger.init({ dataHome });
deploymentMode.init({ hostConfig: { isSlave: () => false }, appManager: { list: () => [] } });
spendPolicy.saveHost({ mode: 'local' });
deploymentMode.invalidate();

const keys = { openai: 'sk-openai', xai: 'xai-key' };
const realFetch = global.fetch;
const realResolve = core.resolveProviderKey;
let calls = [];
core.resolveProviderKey = (k) => keys[k] || '';
global.fetch = async (url, opts) => {
  calls.push({ url, auth: opts.headers.Authorization, body: JSON.parse(opts.body) });
  return { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => Buffer.from('ID3fake').buffer };
};

test.beforeEach(() => { calls = []; });
test.after(() => {
  global.fetch = realFetch;
  core.resolveProviderKey = realResolve;
  fs.rmSync(appsDir, { recursive: true, force: true });
  fs.rmSync(dataHome, { recursive: true, force: true });
});

test('default provider is OpenAI, unchanged request shape, model returned', async () => {
  const r = await media.aiTts('tts-app', { input: 'hello', voice: 'nova' });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/audio/speech');
  assert.equal(calls[0].auth, 'Bearer sk-openai');
  assert.deepEqual(calls[0].body, { model: 'gpt-4o-mini-tts', input: 'hello', voice: 'nova', response_format: 'mp3' });
  assert.equal(r.model, 'gpt-4o-mini-tts');
  assert.equal(r.mimeType, 'audio/mpeg');
});

test('provider xai: /v1/tts with text, voice_id, language and output_format', async () => {
  const r = await media.aiTts('tts-app', {
    provider: 'xai', input: 'Hallo [pause] Welt', voice: 'rex', language: 'de',
    format: 'wav', sampleRate: 44100, speed: 1.2, instructions: 'ignored by xAI',
  });
  assert.equal(calls[0].url, 'https://api.x.ai/v1/tts');
  assert.equal(calls[0].auth, 'Bearer xai-key');
  assert.deepEqual(calls[0].body, {
    text: 'Hallo [pause] Welt', voice_id: 'rex', language: 'de',
    output_format: { codec: 'wav', sample_rate: 44100 }, speed: 1.2,
  });
  assert.equal(r.model, 'xai-tts');
  assert.equal(r.mimeType, 'audio/wav');
  assert.match(r.dataUri, /^data:audio\/wav;base64,/);
});

test('provider xai: defaults to eve / auto / mp3; model "xai-tts" also selects it', async () => {
  await media.aiTts('tts-app', { model: 'xai-tts', input: 'hi' });
  assert.deepEqual(calls[0].body, { text: 'hi', voice_id: 'eve', language: 'auto', output_format: { codec: 'mp3' } });
});

test('provider xai: limits and formats are its own, missing key is named', async () => {
  await assert.rejects(media.aiTts('tts-app', { provider: 'xai', input: 'x', format: 'opus' }), /not supported by xAI TTS/);
  await media.aiTts('tts-app', { provider: 'xai', input: 'x'.repeat(5000) }); // over OpenAI's 4096, under xAI's 60000
  await assert.rejects(media.aiTts('tts-app', { provider: 'xai', input: 'x'.repeat(60001) }), /60000-character/);
  await assert.rejects(media.aiTts('tts-app', { provider: 'polly', input: 'x' }), /unknown TTS provider/);
  delete keys.xai;
  try {
    await assert.rejects(media.aiTts('tts-app', { provider: 'xai', input: 'x' }), /xAI API key not configured/);
  } finally { keys.xai = 'xai-key'; }
});

test('pricing: xai-tts is priced per 1,000 characters ($15 / 1M)', () => {
  assert.equal(spendPricing.price('ai.tts', 'xai-tts', 2).costUsd, 0.03);
  assert.equal(spendPricing.price('ai.tts', 'tts-1-hd', 1).costUsd, 0.03);
});
