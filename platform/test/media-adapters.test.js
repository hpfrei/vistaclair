// Media adapters: the provider-neutral ai.tts / ai.transcribe / ai.image
// params are translated to each vendor's own request, a param the model does
// not honour comes back in `ignored`, and every vendor's response lands in the
// same result shape.
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
const media = require('../src/apps/ai-media');
const { toDimensions, fromDimensions, normalizeSize } = require('../src/apps/media/image-size');
const ttsGoogle = require('../src/apps/media/adapters/tts-google');

const appsDir = makeAppsDir({ 'm-app': { capabilities: { audio: true } } });
appManager.setAppsDir(appsDir);
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-media-'));
spendPolicy.init({ dataHome });
spendLedger.init({ dataHome });
deploymentMode.init({ hostConfig: { isSlave: () => false }, appManager: { list: () => [] } });
spendPolicy.saveHost({ mode: 'local' });
deploymentMode.invalidate();

const keys = { openai: 'sk-openai', xai: 'xai-key', google: 'g-key' };
const realFetch = global.fetch;
const realResolve = core.resolveProviderKey;
const realNative = core.listNativeModels;
core.resolveProviderKey = (k) => keys[k] || '';
// Core's catalog as a fixture: every adapter's seeds plus an older Gemini TTS
// preview, so the legacy style path is reachable.
core.listNativeModels = () => [
  ...require('../src/apps/media').ADAPTERS.flatMap((a) => a.seedModels.map((modelId) => ({ providerKey: a.provider, modelId, label: modelId, kind: 'x', usedBy: a.method }))),
  { providerKey: 'google', modelId: 'gemini-3.1-flash-tts-preview', label: 'Gemini 3.1 Flash TTS', kind: 'speech', usedBy: 'ai.tts' },
];

let calls = [];
let reply = null; // (url) => response-like
const json = (body, status = 200) => ({ ok: status < 300, status, headers: new Map([['content-type', 'application/json']]), json: async () => body, text: async () => JSON.stringify(body) });
global.fetch = async (url, init) => {
  const body = init.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `<blob ${v.type}>`])) : JSON.parse(init.body);
  calls.push({ url, auth: init.headers.Authorization || init.headers['x-goog-api-key'], body, form: init.body instanceof FormData ? [...init.body.keys()] : null });
  return reply ? reply(url) : { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => Buffer.from('ID3fake').buffer };
};

test.beforeEach(() => { calls = []; reply = null; });
test.after(() => {
  global.fetch = realFetch;
  core.resolveProviderKey = realResolve;
  core.listNativeModels = realNative;
  fs.rmSync(appsDir, { recursive: true, force: true });
  fs.rmSync(dataHome, { recursive: true, force: true });
});

// ---- ai.tts -----------------------------------------------------------------

test('tts: the generic voice maps to voice / voice_id / voiceName, and the result names it', async () => {
  const r1 = await media.aiTts('m-app', { input: 'hi', voice: 'coral' });
  assert.equal(calls[0].body.voice, 'coral');
  assert.equal(r1.voice, 'coral');
  await media.aiTts('m-app', { provider: 'xai', input: 'hi', voice: 'ara' });
  assert.equal(calls[1].body.voice_id, 'ara');
  reply = () => json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(480).toString('base64') } }] } }] });
  const r3 = await media.aiTts('m-app', { model: 'gemini-3.8-flash-tts', input: 'hi', voice: 'Puck' });
  assert.equal(calls[2].body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
  assert.deepEqual(calls[2].body.generationConfig.responseModalities, ['AUDIO']);
  assert.match(calls[2].url, /models\/gemini-3\.8-flash-tts:generateContent$/);
  assert.equal(r3.provider, 'google');
});

test('tts: a param the model does not honour is not sent and is reported in ignored', async () => {
  const r = await media.aiTts('m-app', { provider: 'xai', input: 'hi', instructions: 'whisper it' });
  assert.equal(calls[0].body.instructions, undefined);
  assert.deepEqual(r.ignored, ['instructions']);
  const r2 = await media.aiTts('m-app', { model: 'tts-1', input: 'hi', instructions: 'calm' });
  assert.equal(calls[1].body.instructions, undefined);
  assert.deepEqual(r2.ignored, ['instructions']);
  const r3 = await media.aiTts('m-app', { input: 'hi', instructions: 'calm' });
  assert.equal(calls[2].body.instructions, 'calm');
  assert.equal(r3.ignored, undefined);
});

test('tts: OpenAI custom voice ids are sent as { id }', async () => {
  await media.aiTts('m-app', { input: 'hi', voice: 'voice_abc123' });
  assert.deepEqual(calls[0].body.voice, { id: 'voice_abc123' });
});

test('tts google: PCM is wrapped as WAV by default, style goes to speech_metadata on 3.8, a preamble on 3.1', async () => {
  const pcm = Buffer.alloc(960, 1);
  reply = () => json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: pcm.toString('base64') } }] } }] });
  const r = await media.aiTts('m-app', { provider: 'google', input: 'hello', instructions: 'cheerful' });
  assert.equal(calls[0].body.contents[0].parts[0].speech_metadata.style, 'cheerful');
  assert.equal(r.format, 'wav');
  assert.equal(r.mimeType, 'audio/wav');
  const wav = Buffer.from(r.audio, 'base64');
  assert.equal(wav.slice(0, 4).toString(), 'RIFF');
  assert.equal(wav.length, 44 + pcm.length);
  await media.aiTts('m-app', { model: 'gemini-3.1-flash-tts-preview', input: 'hello', instructions: 'cheerful', format: 'pcm' });
  assert.equal(calls[1].body.contents[0].parts[0].text, 'cheerful: hello');
});

test('tts google: mp3 is transcoded through ffmpeg', { skip: !require('../src/apps/media-ffmpeg').isAvailable() && 'no ffmpeg' }, async () => {
  const pcm = Buffer.alloc(24000 * 2 * 0.2); // 200 ms of silence
  reply = () => json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: ttsGoogle.pcmToWav(pcm).toString('base64') } }] } }] });
  const r = await media.aiTts('m-app', { provider: 'google', input: 'hello', format: 'mp3' });
  assert.equal(r.mimeType, 'audio/mpeg');
  const buf = Buffer.from(r.audio, 'base64');
  assert.ok(buf.slice(0, 3).toString() === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0), 'mp3 frame or ID3 tag');
});

// ---- ai.transcribe ----------------------------------------------------------

const AUDIO = Buffer.from('fake audio bytes').toString('base64');

test('transcribe: OpenAI multipart unchanged; accuracy high picks gpt-4o-transcribe', async () => {
  reply = () => json({ text: 'hello' });
  const r = await media.aiTranscribe('m-app', { audio: AUDIO, preprocess: false, accuracy: 'high', language: 'en' });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(calls[0].body.model, 'gpt-4o-transcribe');
  assert.equal(calls[0].body.language, 'en');
  assert.equal(r.text, 'hello');
  assert.equal(r.provider, 'openai');
});

test('transcribe xai: /v1/stt, file last, diarize honoured, prompt reported as ignored', async () => {
  reply = () => json({ text: 'hi there', language: 'en', duration: 1.2, words: [{ text: 'hi', start: 0, end: 0.4, speaker: 0 }] });
  const r = await media.aiTranscribe('m-app', { provider: 'xai', audio: AUDIO, preprocess: false, diarize: true, prompt: 'names: Ada' });
  assert.equal(calls[0].url, 'https://api.x.ai/v1/stt');
  assert.equal(calls[0].auth, 'Bearer xai-key');
  assert.equal(calls[0].body.model, 'grok-voice-transcribe-2.0');
  assert.equal(calls[0].body.diarize, 'true');
  assert.equal(calls[0].form.at(-1), 'file');
  assert.equal(r.words[0].speaker, 0);
  assert.deepEqual(r.ignored, ['prompt']);
});

// ---- ai.image ---------------------------------------------------------------

const PNG = Buffer.from('png').toString('base64');

test('image google: request shape unchanged, imageSize still accepted as the old name of size', async () => {
  reply = () => json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG } }] } }] });
  const r = await media.aiImage('m-app', { prompt: 'a fox', aspectRatio: '16:9', imageSize: '2k' });
  assert.deepEqual(calls[0].body.generationConfig, { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9', imageSize: '2K' } });
  assert.equal(r.images[0].dataUri, `data:image/png;base64,${PNG}`);
  assert.equal(r.model, 'gemini-3.1-flash-image');
});

test('image openai: tier + ratio become WxH; input images switch to the multipart edits endpoint', async () => {
  reply = () => json({ data: [{ b64_json: PNG }] });
  const r = await media.aiImage('m-app', { provider: 'openai', prompt: 'a fox', aspectRatio: '3:2', size: '1K', quality: 'high' });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/images/generations');
  assert.equal(calls[0].body.model, 'gpt-image-2.5-flare');
  assert.equal(calls[0].body.size, toDimensions('1K', '3:2'));
  assert.equal(calls[0].body.quality, 'high');
  assert.equal(r.images[0].mimeType, 'image/png');
  await media.aiImage('m-app', { provider: 'openai', prompt: 'make it blue', image: `data:image/png;base64,${PNG}` });
  assert.equal(calls[1].url, 'https://api.openai.com/v1/images/edits');
  assert.ok(calls[1].form.includes('image[]'));
});

test('image xai: aspect_ratio + resolution, always b64_json; edits send the image as a data URI', async () => {
  reply = () => json({ data: [{ b64_json: PNG, mime_type: 'image/jpeg' }] });
  const r = await media.aiImage('m-app', { provider: 'xai', prompt: 'a fox', aspectRatio: '16:9', size: '2K' });
  assert.equal(calls[0].url, 'https://api.x.ai/v1/images/generations');
  assert.deepEqual(calls[0].body, { model: 'grok-imagine-image-2.0', prompt: 'a fox', response_format: 'b64_json', n: 1, aspect_ratio: '16:9', resolution: '2k' });
  assert.equal(r.images[0].mimeType, 'image/jpeg');
  await media.aiImage('m-app', { provider: 'xai', prompt: 'sketch it', image: PNG });
  assert.equal(calls[1].url, 'https://api.x.ai/v1/images/edits');
  assert.deepEqual(calls[1].body.image, { url: `data:image/png;base64,${PNG}`, type: 'image_url' });
});

test('image: sizes and ratios outside the model\'s range throw before any request', async () => {
  await assert.rejects(media.aiImage('m-app', { provider: 'xai', prompt: 'x', size: '4K' }), /not offered by grok-imagine-image-2\.0/);
  await assert.rejects(media.aiImage('m-app', { prompt: 'x', aspectRatio: '7:3' }), /aspectRatio "7:3" is not offered/);
  await assert.rejects(media.aiImage('m-app', { prompt: 'x', size: 'huge' }), /not a tier/);
  assert.equal(calls.length, 0);
});

test('image-size: WxH ⇄ tier + ratio stays inside OpenAI\'s limits', () => {
  assert.equal(normalizeSize('2k'), '2K');
  assert.equal(normalizeSize('1536X1024'), '1536x1024');
  for (const tier of ['512', '1K', '2K', '4K']) {
    for (const ratio of ['1:1', '3:2', '9:16', '21:9']) {
      const [w, h] = toDimensions(tier, ratio).split('x').map(Number);
      assert.ok(w % 16 === 0 && h % 16 === 0, `${tier} ${ratio}: multiples of 16`);
      assert.ok(Math.max(w, h) <= 3840 && w * h >= 655360 && w * h <= 8294400, `${tier} ${ratio}: ${w}x${h}`);
    }
  }
  assert.throws(() => toDimensions('1K', '4:1'), /1:3 … 3:1/);
  assert.deepEqual(fromDimensions('1536x1024', ['1:1', '3:2', '16:9']), { tier: '1K', aspectRatio: '3:2' });
});
