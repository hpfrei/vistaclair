// Media model resolution and the catalog: a call's model beats its provider,
// which beats the platform default (Setup → AI Config), which beats the
// built-in default; a dead platform default falls back with one toast; an
// unknown or vanished model fails the call and raises ai:model-unavailable;
// the daily refresh persists what each vendor lists without ever wiping it on
// a failed listing; and every model an adapter can call has a price entry.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeAppsDir } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const platformSettings = require('../src/apps/platform-settings');
const spendPolicy = require('../src/apps/spend-policy');
const spendLedger = require('../src/apps/spend-ledger');
const spendPricing = require('../src/apps/spend-pricing');
const deploymentMode = require('../src/apps/deployment-mode');
const { core } = require('../src/apps/core-services');
const aiService = require('../src/apps/ai-service');
const media = require('../src/apps/ai-media');
const mediaCatalog = require('../src/apps/media-catalog');
const adapters = require('../src/apps/media');

const appsDir = makeAppsDir({ 'r-app': { capabilities: { audio: true } } });
appManager.setAppsDir(appsDir);
platformSettings.init(appsDir);
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-media-r-'));
spendPolicy.init({ dataHome });
spendLedger.init({ dataHome });
deploymentMode.init({ hostConfig: { isSlave: () => false }, appManager: { list: () => [] } });
spendPolicy.saveHost({ mode: 'local' });
deploymentMode.invalidate();

const keys = { openai: 'sk-openai', xai: 'xai-key', google: 'g-key' };
const saved = { fetch: global.fetch, resolve: core.resolveProviderKey, native: core.listNativeModels, broadcaster: core.broadcaster };
core.resolveProviderKey = (k) => keys[k] || '';
const toasts = [];
core.broadcaster = { broadcast: (m) => toasts.push(m) };
const events = [];
const unobserve = aiService.observe((ev) => events.push(ev));

let calls = [];
let reply = null;
global.fetch = async (url, init) => {
  calls.push({ url, body: init && init.body && !(init.body instanceof FormData) ? JSON.parse(init.body) : null });
  return reply ? reply(url) : { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => Buffer.from('ID3').buffer };
};
const json = (body, status = 200) => ({ ok: status < 300, status, headers: new Map(), json: async () => body, text: async () => JSON.stringify(body) });

test.beforeEach(() => {
  calls = []; reply = null; toasts.length = 0; events.length = 0;
  platformSettings.set('mediaDefaults', '');
  core.listNativeModels = saved.native;
  fs.rmSync(mediaCatalog.statePath(), { force: true });
});
test.after(() => {
  unobserve();
  global.fetch = saved.fetch;
  core.resolveProviderKey = saved.resolve;
  core.listNativeModels = saved.native;
  core.broadcaster = saved.broadcaster;
  fs.rmSync(appsDir, { recursive: true, force: true });
  fs.rmSync(dataHome, { recursive: true, force: true });
});

const resolve = (method, params) => media.resolveMediaModel('r-app', method, params);

test('chain: call model > provider > platform default > built-in', () => {
  assert.deepEqual([resolve('ai.tts', {}).model, resolve('ai.tts', {}).source], ['gpt-4o-mini-tts', 'builtin']);
  platformSettings.set('mediaDefaults', { 'ai.tts': { model: 'xai-tts', voice: 'rex' } });
  assert.deepEqual([resolve('ai.tts', {}).model, resolve('ai.tts', {}).source], ['xai-tts', 'platform']);
  assert.equal(resolve('ai.tts', { provider: 'google' }).model, 'gemini-3.8-flash-tts');
  assert.equal(resolve('ai.tts', { model: 'tts-1-hd' }).model, 'tts-1-hd');
  assert.equal(resolve('ai.tts', { model: 'openai/tts-1' }).adapter.provider, 'openai');
  assert.equal(resolve('ai.image', {}).model, 'gemini-3.1-flash-image');
  assert.equal(resolve('ai.transcribe', { provider: 'xai' }).model, 'grok-voice-transcribe-2.0');
});

test('platform defaults fill gaps the call leaves; a voice the model lacks yields the model default', async () => {
  platformSettings.set('mediaDefaults', { 'ai.tts': { model: 'gpt-4o-mini-tts', voice: 'marin', format: 'opus', speed: 1.1 } });
  const r1 = await media.aiTts('r-app', { input: 'hi' });
  assert.deepEqual(calls[0].body, { model: 'gpt-4o-mini-tts', input: 'hi', voice: 'marin', response_format: 'opus', speed: 1.1 });
  assert.equal(r1.ignored, undefined, 'defaults the caller did not pass are never "ignored"');
  // tts-1 does not offer marin → its own default voice; the call's own voice always wins.
  await media.aiTts('r-app', { input: 'hi', model: 'tts-1' });
  assert.equal(calls[1].body.voice, 'alloy');
  await media.aiTts('r-app', { input: 'hi', model: 'tts-1', voice: 'echo', format: 'mp3' });
  assert.equal(calls[2].body.voice, 'echo');
  assert.equal(calls[2].body.response_format, 'mp3');
  // xAI has no `instructions`; a platform default for it is simply not applied there.
  platformSettings.set('mediaDefaults', { 'ai.tts': { instructions: 'calm' } });
  await media.aiTts('r-app', { input: 'hi', provider: 'xai' });
  assert.equal(calls[3].body.instructions, undefined);
});

test('a platform default the refresh found gone falls back to the built-in default, toasting once', () => {
  platformSettings.set('mediaDefaults', { 'ai.image': { model: 'gemini-3-pro-image' } });
  fs.writeFileSync(mediaCatalog.statePath(), JSON.stringify({ adapters: { 'ai.image:google': { ok: true, modelIds: ['gemini-3.1-flash-image'] } } }));
  const r = resolve('ai.image', {});
  assert.equal(r.model, 'gemini-3.1-flash-image');
  assert.equal(r.fallbackFrom, 'gemini-3-pro-image');
  resolve('ai.image', {});
  assert.equal(toasts.filter((t) => /Default image model unavailable/.test(t.title)).length, 1);
});

test('unknown / wrong-kind / contradicting models throw and alert once per app and model', () => {
  assert.throws(() => resolve('ai.tts', { model: 'tts-9000' }), /unknown TTS model "tts-9000"\. Valid: .*gpt-4o-mini-tts/);
  assert.throws(() => resolve('ai.tts', { model: 'tts-9000' }), /unknown/);
  assert.throws(() => resolve('ai.tts', { model: 'whisper-1' }), /is a transcription model \(ai\.transcribe\)/);
  assert.throws(() => resolve('ai.tts', { model: 'tts-1', provider: 'xai' }), /belongs to provider "openai"/);
  assert.throws(() => resolve('ai.image', { provider: 'midjourney' }), /unknown image provider "midjourney" \(google, openai, xai\)/);
  const un = events.filter((e) => e.type === 'unavailable');
  assert.deepEqual(un.map((e) => [e.app, e.method, e.model, e.reason]), [
    ['r-app', 'ai.tts', 'tts-9000', 'unknown'],
    ['r-app', 'ai.tts', 'whisper-1', 'wrong-kind'],
  ]);
});

test('a vendor "model not found" fails the call and raises ai:model-unavailable', async () => {
  reply = () => json({ error: { code: 'model_not_found', message: 'The model `gpt-image-2` does not exist' } }, 404);
  await assert.rejects(media.aiImage('r-app', { prompt: 'x', model: 'gpt-image-2.5-sunburst' }), /model "gpt-image-2\.5-sunburst" is not available at OpenAI/);
  assert.deepEqual(events.filter((e) => e.type === 'unavailable').map((e) => [e.method, e.model, e.reason]), [['ai.image', 'gpt-image-2.5-sunburst', 'gone']]);
});

test('catalog: refresh persists listings and voices; a failed listing keeps the last known ids', async () => {
  reply = (url) => {
    if (url.startsWith('https://api.openai.com/v1/models')) return json({ data: [{ id: 'gpt-4o-mini-tts' }, { id: 'gpt-5-mini-tts' }, { id: 'tts-1', shutdown_date: '2026-12-01' }, { id: 'gpt-image-2.5-flare' }] });
    if (url === 'https://api.x.ai/v1/tts/voices') return json({ voices: [{ voice_id: 'eve', name: 'Eve', language: 'en' }, { voice_id: 'nova-x', name: 'Nova X', language: 'de' }] });
    if (url === 'https://api.x.ai/v1/image-generation-models') return json({ models: [{ id: 'grok-imagine-image-2.0', aliases: ['grok-imagine-image'] }] });
    if (url.includes('generativelanguage.googleapis.com/v1beta/models')) return json({ models: [{ name: 'models/gemini-3.1-flash-image' }, { name: 'models/gemini-3.8-flash-tts' }] });
    if (url.includes('/v1beta/voices')) return json({ voices: [{ id: 'Kore', type: 'PREBUILT', gender: 'FEMALE' }, { id: 'designed-1', type: 'DESIGNED' }] });
    return json({}, 500);
  };
  const s = await mediaCatalog.refresh();
  assert.equal(s.adapters['ai.tts:openai'].ok, true);
  assert.equal(s.adapters['ai.transcribe:xai'].unchecked, true, 'xAI lists no STT models — never checked, never flagged');
  const tts = mediaCatalog.list({ kind: 'speech' }).models;
  const by = (id) => tts.find((m) => m.modelId === id);
  assert.equal(by('gpt-4o-mini-tts').exists, true);
  assert.equal(by('tts-1-hd').exists, false);
  assert.equal(by('tts-1-hd').unusableReason, 'missing');
  assert.equal(by('tts-1').shutdownDate, '2026-12-01');
  assert.equal(by('gpt-5-mini-tts').discovered, true, 'a new live id the adapter recognises is offered');
  assert.deepEqual(by('xai-tts').voices.map((v) => v.id), ['eve', 'nova-x']);
  assert.deepEqual(by('gemini-3.8-flash-tts').voices.map((v) => [v.id, v.gender]), [['Kore', 'female']]);
  assert.equal(mediaCatalog.list({ method: 'ai.transcribe' }).models.find((m) => m.modelId === 'grok-voice-transcribe-2.0').exists, null);

  reply = () => json({ error: 'down' }, 503);
  const s2 = await mediaCatalog.refresh();
  assert.equal(s2.adapters['ai.tts:openai'].ok, false);
  assert.equal(mediaCatalog.list({ kind: 'speech' }).models.find((m) => m.modelId === 'gpt-4o-mini-tts').exists, true, 'outage ≠ gone');
});

test('catalog without core\'s list (older host) offers the adapters\' seed models', () => {
  core.listNativeModels = null;
  const ids = mediaCatalog.list({ method: 'ai.image' }).models.map((m) => m.modelId);
  for (const a of adapters.adaptersFor('ai.image')) assert.ok(ids.includes(a.defaultModel), a.defaultModel);
  assert.equal(mediaCatalog.list({ method: 'ai.image' }).defaults['ai.image'].model, 'gemini-3.1-flash-image');
});

test('pricing: every model an adapter can call has a byModel entry (number, or null = unpriced)', () => {
  let native = [];
  const corePath = path.join(__dirname, '..', '..', 'src', 'native-models.js');
  if (fs.existsSync(corePath)) native = require(corePath).listNativeModels();
  const served = new Set([
    ...adapters.ADAPTERS.flatMap((a) => a.seedModels.map((id) => `${a.method}|${id}`)),
    ...native.filter((m) => adapters.adapter(m.usedBy, m.providerKey)).map((m) => `${m.usedBy}|${m.modelId}`),
  ]);
  for (const key of served) {
    const [method, model] = key.split('|');
    assert.ok(Object.prototype.hasOwnProperty.call(spendPricing.DEFAULTS[method].byModel, model), `${method} ${model} has no byModel entry`);
  }
  assert.equal(spendPricing.price('ai.image', 'gemini-3-pro-image', 1).priced, false, 'null = metered unpriced, not the flat rate');
  assert.equal(spendPricing.price('ai.image', 'grok-imagine-image-2.0', 2).costUsd, 0.08);
});
