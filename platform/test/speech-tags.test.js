// Speech tags: ai.tts `tags: true` and ai.ttsRender. xAI gets the tags as
// written, instruction models get LLM-rendered text + a cue direction (with a
// deterministic fallback that never fails the call), tts-1 gets them mapped
// away, and the result reports what was sent. Without `tags` nothing changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeAppsDir } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const spendPolicy = require('../src/apps/spend-policy');
const spendLedger = require('../src/apps/spend-ledger');
const deploymentMode = require('../src/apps/deployment-mode');
const { core } = require('../src/apps/core-services');
const aiService = require('../src/apps/ai-service');
const media = require('../src/apps/ai-media');
const tags = require('../src/apps/media/speech-tags');
const mediaCatalog = require('../src/apps/media-catalog');

const appsDir = makeAppsDir({ 'pod-app': { capabilities: { audio: true } } });
appManager.setAppsDir(appsDir);
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-tags-'));
spendPolicy.init({ dataHome });
spendLedger.init({ dataHome });
deploymentMode.init({ hostConfig: { isSlave: () => false }, appManager: { list: () => [] } });
spendPolicy.saveHost({ mode: 'local' });
deploymentMode.invalidate();

const LINE = 'Warte, warte— [gasp] <loud>das ist doch KOMPLETT fake!</loud> Ne-hein [laugh] das glaub ich dir nie.';
const GOOD = {
  text: 'Warte, warte— ah— das ist doch KOMPLETT fake! Ne-hein hah-haha das glaub ich dir nie.',
  direction: 'a sharp gasp after the opening, the middle phrase loud and rising, a breathy laugh spilling into the final phrase',
};

const keys = { openai: 'sk-openai', xai: 'xai-key' };
const realFetch = global.fetch;
const realResolve = core.resolveProviderKey;
const realPrompt = aiService.aiPrompt;
let calls = [];
let prompts = [];
let answer = null; // (lines) => json | throws
core.resolveProviderKey = (k) => keys[k] || '';
global.fetch = async (url, opts) => {
  calls.push({ url, body: JSON.parse(opts.body) });
  return { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => Buffer.from('ID3fake').buffer };
};
aiService.aiPrompt = async (appName, appDir, params) => {
  const { lines } = JSON.parse(params.message);
  prompts.push({ appName, appDir, params, lines });
  return { text: '', json: answer(lines.filter((l) => l.render)) };
};
const echoGood = (lines) => ({ lines: lines.map((l) => ({ i: l.i, ...GOOD })) });

test.beforeEach(() => { calls = []; prompts = []; answer = echoGood; tags._cache.clear(); });
test.after(() => {
  global.fetch = realFetch;
  core.resolveProviderKey = realResolve;
  aiService.aiPrompt = realPrompt;
  fs.rmSync(appsDir, { recursive: true, force: true });
  fs.rmSync(dataHome, { recursive: true, force: true });
});

test('without tags nothing changes: brackets are sent as written, no rendered field', async () => {
  const r = await media.aiTts('pod-app', { input: 'Hi [laugh]', voice: 'nova' });
  assert.deepEqual(calls[0].body, { model: 'gpt-4o-mini-tts', input: 'Hi [laugh]', voice: 'nova', response_format: 'mp3' });
  assert.equal(r.rendered, undefined);
  assert.equal(prompts.length, 0);
});

test('xAI (params.speechTags): input sent verbatim, instructions still ignored', async () => {
  const r = await media.aiTts('pod-app', { model: 'xai-tts', tags: true, input: LINE, instructions: 'persona' });
  assert.equal(calls[0].body.text, LINE);
  assert.deepEqual(r.rendered, { input: LINE, instructions: null, mode: 'native', via: 'native' });
  assert.deepEqual(r.ignored, ['instructions']);
  assert.equal(prompts.length, 0);
});

test('gpt-4o-mini-tts: LLM text sent, cues appended to the caller instructions', async () => {
  const r = await media.aiTts('pod-app', { model: 'gpt-4o-mini-tts', voice: 'marin', tags: true, input: LINE, instructions: 'You are Pamela.' });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].appName, 'pod-app');
  assert.equal(prompts[0].params.model, 'haiku');
  assert.deepEqual(prompts[0].params.allowedTools, []);
  assert.equal(calls[0].body.input, GOOD.text);
  assert.equal(calls[0].body.instructions, `You are Pamela. Performance cues: ${GOOD.direction}.`);
  assert.equal(r.rendered.via, 'llm');
  assert.equal(r.rendered.mode, 'instructions');
  assert.equal(r.rendered.input, calls[0].body.input);
  assert.equal(r.rendered.instructions, calls[0].body.instructions);
});

test('a dropped word or a quoting direction is rejected; the call still succeeds', async () => {
  answer = (lines) => ({ lines: lines.map((l) => ({ i: l.i, text: 'Warte, ah— das ist fake! hah-haha', direction: 'loud' })) });
  const r = await media.aiTts('pod-app', { model: 'gpt-4o-mini-tts', tags: true, input: LINE });
  assert.equal(r.rendered.via, 'fallback');
  assert.equal(r.rendered.fallback, 'rendering failed validation');
  assert.doesNotMatch(calls[0].body.input, /[\[\]<>]/);
  assert.match(calls[0].body.input, /das ist doch KOMPLETT fake!/);
  assert.match(calls[0].body.instructions, /^Performance cues: a sharp gasp, a loud passage, a laugh\.$/);

  tags._cache.clear();
  answer = (lines) => ({ lines: lines.map((l) => ({ i: l.i, text: GOOD.text, direction: 'shout das ist doch KOMPLETT at the top' })) });
  const q = await media.aiTts('pod-app', { model: 'gpt-4o-mini-tts', tags: true, input: LINE });
  assert.equal(q.rendered.via, 'llm');
  assert.equal(q.rendered.input, GOOD.text);
  assert.equal(q.rendered.instructions, 'Performance cues: a sharp gasp, a loud passage, a laugh.');
});

test('an LLM failure falls back to the deterministic map', async () => {
  answer = () => { throw new Error('ai down'); };
  const r = await media.aiTts('pod-app', { model: 'gpt-4o-mini-tts', tags: true, input: 'Hallo [pause] <emphasis>Welt</emphasis> [laugh]' });
  assert.equal(r.rendered.via, 'fallback');
  assert.equal(r.rendered.fallback, 'ai down');
  assert.equal(calls[0].body.input, 'Hallo … WELT hah-haha');
});

test('tts-1 (neither): tags mapped away, no instructions, no LLM', async () => {
  const r = await media.aiTts('pod-app', { model: 'tts-1', tags: true, input: 'Na [sigh] <whisper>gut</whisper>.' });
  assert.equal(calls[0].body.input, 'Na … gut.');
  assert.equal(calls[0].body.instructions, undefined);
  assert.deepEqual(r.rendered, { input: 'Na … gut.', instructions: null, mode: 'plain', via: 'plain' });
  assert.equal(prompts.length, 0);
});

test('a line without tags skips the LLM', async () => {
  const r = await media.aiTts('pod-app', { model: 'gpt-4o-mini-tts', tags: true, input: 'Ganz normal.', instructions: 'calm' });
  assert.equal(prompts.length, 0);
  assert.deepEqual(r.rendered, { input: 'Ganz normal.', instructions: 'calm', mode: 'instructions', via: 'none' });
});

test('ai.ttsRender: one prompt for a mixed script, context lines included, cache reused by ai.tts', async () => {
  const out = await media.aiTtsRender('pod-app', {
    model: 'gpt-4o-mini-tts',
    instructions: 'Comedy podcast.',
    lines: [
      { input: LINE },
      { input: 'Echt jetzt? [laugh]', model: 'xai-tts' },
      'Ohne Tags.',
      { input: LINE.replace('nie', 'niemals'), instructions: 'You are Pamela.' },
    ],
  });
  assert.equal(prompts.length, 1);
  assert.deepEqual(prompts[0].lines.map((l) => [l.i, l.render]), [[0, true], [1, false], [2, false], [3, true]]);
  const [a, b, c, d] = out.lines;
  assert.equal(a.via, 'llm');
  assert.equal(a.instructions, `Comedy podcast. Performance cues: ${GOOD.direction}.`);
  assert.deepEqual([b.mode, b.via, b.input, b.model, b.provider], ['native', 'native', 'Echt jetzt? [laugh]', 'xai-tts', 'xai']);
  assert.deepEqual([c.via, c.instructions], ['none', 'Comedy podcast.']);
  assert.equal(d.via, 'fallback'); // the echoed text lacks "niemals"
  assert.match(d.instructions, /^You are Pamela\. Performance cues:/);

  const r = await media.aiTts('pod-app', { model: 'gpt-4o-mini-tts', tags: true, input: LINE });
  assert.equal(prompts.length, 1);
  assert.equal(r.rendered.cached, true);
  assert.equal(calls[0].body.input, GOOD.text);
});

test('ai.ttsRender validates its input', async () => {
  await assert.rejects(media.aiTtsRender('pod-app', {}), /lines is required/);
  await assert.rejects(media.aiTtsRender('pod-app', { lines: [{}] }), /lines\[0\]\.input is required/);
  await assert.rejects(media.aiTtsRender('pod-app', { lines: ['x'], model: 'nope' }), /unknown TTS model/);
});

test('catalog: speech entries carry params.speechTags', () => {
  const { models } = mediaCatalog.list({ kind: 'speech' });
  const by = Object.fromEntries(models.map((m) => [m.modelId, m.params.speechTags]));
  assert.equal(by['xai-tts'], true);
  assert.equal(by['gpt-4o-mini-tts'], false);
});

test('the deterministic map keeps every word and never quotes the line', () => {
  const p = tags.plain(LINE);
  assert.ok(tags.validText(LINE, p.input));
  assert.ok(tags.validDirection(LINE, p.direction));
  assert.equal(tags.hasTags('plain text'), false);
  assert.equal(tags.hasTags('a <whisper>b</whisper>'), true);
});
