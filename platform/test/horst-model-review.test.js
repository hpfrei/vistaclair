// The daily model review: refresh text + media lists, flag every dead default
// once (ai:default-missing + an ai.setDefault proposal), never read a failed
// listing as "gone", accept a bare tier while its family lives, record shutdowns
// and new models, stay quiet while paused — and the approved proposal writes
// the right store.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeAppsDir } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const platformSettings = require('../src/apps/platform-settings');
const horstSettings = require('../src/apps/agent/horst-settings');
const capabilities = require('../src/apps/capabilities');
const aiService = require('../src/apps/ai-service');
const modelDefaults = require('../src/apps/model-defaults');
const review = require('../src/apps/agent/horst-model-review');
const { core } = require('../src/apps/core-services');

const appsDir = makeAppsDir({});
appManager.setAppsDir(appsDir);
platformSettings.init(appsDir);
const horstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-model-review-'));
horstSettings.init({ dir: horstDir });

const REGISTRY = [
  { name: 'claude-haiku-4-5', modelId: 'claude-haiku-4-5', providerKey: 'anthropic' },
  { name: 'claude-sonnet-5', modelId: 'claude-sonnet-5', providerKey: 'anthropic' },
  { name: 'claude-opus-4-1', modelId: 'claude-opus-4-1', providerKey: 'anthropic', lifecycle: 'retired', disabled: true },
  { name: 'claude-opus-5', modelId: 'claude-opus-5', providerKey: 'anthropic' },
  { name: 'deepseek-chat', modelId: 'deepseek-chat', providerKey: 'deepseek', lifecycle: 'deprecated' },
];
let registry = REGISTRY;
let refreshCalls = 0;
const saved = { listModels: core.listModels, avail: core.listModelsWithAvailability, refresh: core.refreshModels, key: core.resolveProviderKey, native: core.listNativeModels, fetch: global.fetch };
core.listModels = () => registry;
core.listModelsWithAvailability = () => registry.map((m) => ({ ...m, usable: m.lifecycle !== 'retired' && !m.disabled, unusableReason: m.lifecycle === 'retired' ? 'retired' : null }));
core.refreshModels = async () => { refreshCalls++; return { scan: { anthropic: { status: 'ok', added: refreshCalls === 1 ? [{ name: 'claude-fable-5', label: 'Fable 5' }] : [] } } }; };
core.resolveProviderKey = (k) => (k === 'openai' ? 'sk-test' : '');
core.listNativeModels = null; // adapter seeds only

let openaiIds = ['gpt-4o-mini-tts', 'tts-1', 'gpt-4o-mini-transcribe', 'whisper-1', 'gpt-4o-transcribe', 'gpt-image-2.5-flare'];
let down = false;
global.fetch = async (url) => {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  if (down) return { ok: false, status: 503, json: async () => ({}), text: async () => 'down' };
  if (String(url).startsWith('https://api.openai.com/v1/models')) return ok({ data: openaiIds.map((id) => ({ id })) });
  return { ok: false, status: 404, json: async () => ({}), text: async () => 'nope' };
};

const proposals = [];
const observations = [];
const journal = [];
const kind = capabilities.horstKinds()['ai.setDefault'];
const governance = { requestAction: async (k, payload, meta) => { kind.validate(payload); proposals.push({ k, payload, meta }); return { ok: true }; } };
let paused = false;
review.init({
  dir: horstDir, governance,
  getSettings: () => ({ paused }),
  addObservation: (k, summary, detail) => observations.push({ k, summary, detail }),
  addJournal: (k, title, body) => journal.push({ k, title, body }),
  now: () => Date.parse('2026-10-10T07:00:00Z'),
});
const events = [];
const unobserve = aiService.observe((ev) => { if (ev.type === 'default-missing') events.push(ev); });

test.after(() => {
  unobserve();
  Object.assign(core, { listModels: saved.listModels, listModelsWithAvailability: saved.avail, refreshModels: saved.refresh, resolveProviderKey: saved.key, listNativeModels: saved.native });
  global.fetch = saved.fetch;
  fs.rmSync(appsDir, { recursive: true, force: true });
  fs.rmSync(horstDir, { recursive: true, force: true });
});

test('dead text and media defaults alert and propose once; tiers and deprecations are judged right', async () => {
  platformSettings.set('directModel', 'deepseek-chat');
  horstSettings.set({ briefingModel: 'claude-opus-4-1', triageModel: 'haiku', directiveModel: 'opus', chatModel: '' });
  platformSettings.set('mediaDefaults', { 'ai.tts': { model: 'tts-1-hd', voice: 'fable', format: 'opus' } });

  const r = await review.run();
  assert.equal(refreshCalls, 1);
  assert.deepEqual(r.dead.map((d) => [d.target, d.model, d.reason, d.candidate]).sort(), [
    ['horst.briefingModel', 'claude-opus-4-1', 'retired', 'claude-opus-5'],
    ['media.ai.tts', 'tts-1-hd', 'missing', 'gpt-4o-mini-tts'],
  ]);
  assert.deepEqual(events.map((e) => e.target).sort(), ['horst.briefingModel', 'media.ai.tts']);
  assert.deepEqual(proposals.map((p) => [p.k, p.payload.target, p.payload.model]).sort(), [
    ['ai.setDefault', 'horst.briefingModel', 'claude-opus-5'],
    ['ai.setDefault', 'media.ai.tts', 'gpt-4o-mini-tts'],
  ]);
  assert.ok(observations.some((o) => o.k === 'model-shutdown' && /deepseek-chat is deprecated/.test(o.summary)));
  assert.ok(observations.some((o) => o.k === 'models-new' && /Fable 5/.test(o.summary)));
  assert.match(journal.at(-1).body, /2 gone \(2 newly alerted\)/);

  // The next day: still dead, but nothing is re-alerted or re-proposed.
  const before = { e: events.length, p: proposals.length, o: observations.length };
  await review.run();
  assert.deepEqual({ e: events.length, p: proposals.length, o: observations.length }, before);
});

test('approving ai.setDefault writes the owning store; a healthy target is forgotten', async () => {
  for (const { payload } of proposals) { kind.validate(payload); kind.execute(payload); }
  assert.equal(horstSettings.get().briefingModel, 'claude-opus-5');
  assert.deepEqual(platformSettings.get('mediaDefaults')['ai.tts'], { model: 'gpt-4o-mini-tts', voice: 'fable', format: 'opus' }, 'a voice the new model offers is kept, other params too');
  assert.equal(kind.describe(proposals[0].payload).includes('→'), true);
  assert.throws(() => kind.validate({ target: 'media.ai.tts', model: 'tts-1', voice: 'marin' }), /not offered/);
  assert.throws(() => kind.validate({ target: 'horst.triageModel', model: 'claude-opus-4-1' }), /not callable/);
  assert.throws(() => kind.validate({ target: 'nope', model: 'x' }), /unknown model default/);

  const r = await review.run();
  assert.deepEqual(r.dead, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(review.statePath(), 'utf8')).alerted, {});
});

test('a stored voice the model no longer offers is a dead default with the model\'s own voice proposed', async () => {
  modelDefaults.write('media.ai.tts', { model: 'gpt-4o-mini-tts', voice: 'nightingale' });
  const r = await review.run();
  assert.deepEqual(r.dead.map((d) => [d.target, d.reason, d.voice]), [['media.ai.tts', 'voice-missing', 'nightingale']]);
  assert.deepEqual(proposals.at(-1).payload, { target: 'media.ai.tts', model: 'gpt-4o-mini-tts', voice: 'alloy' });
  modelDefaults.write('media.ai.tts', { model: 'tts-1' });
  assert.equal(platformSettings.get('mediaDefaults')['ai.tts'].voice, undefined, 'a model change drops a voice the new model lacks');
});

test('a failed vendor listing is reported, never read as "gone"', async () => {
  down = true;
  const before = events.length;
  const r = await review.run();
  down = false;
  assert.deepEqual(r.dead, []);
  assert.equal(events.length, before);
  assert.ok(r.errors.some((e) => /ai\.tts:openai/.test(e)));
  assert.match(journal.at(-1).body, /last known state kept/);
});

test('an empty registry leaves text defaults unchecked; paused skips the whole run', async () => {
  registry = [];
  horstSettings.set({ briefingModel: 'whatever' });
  const r = await review.run();
  assert.equal(r.dead.some((d) => d.target.startsWith('horst.') || d.target.startsWith('platform.')), false);
  assert.match(journal.at(-1).body, /Text registry unavailable/);
  registry = REGISTRY;

  paused = true;
  const calls = refreshCalls;
  assert.deepEqual(await review.run(), { skipped: 'paused' });
  assert.equal(refreshCalls, calls);
  paused = false;
});
