// ai.sfx (ElevenLabs sound effects): the adapter's request mapping, the
// response → container/mime/duration for every format, the WAV header, the
// format rules (call > loop → wav > platform default > mp3), the missing-key
// error, and the broker's sound_generate built-in (writes only inside cwd).
// A stubbed fetch throughout — no ElevenLabs call is ever made.
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
const mediaCatalog = require('../src/apps/media-catalog');
const ai = require('../src/apps/ai-media');
const adapter = require('../src/apps/media/adapters/sfx-elevenlabs');
const container = require('../src/apps/media/audio-container');
const art = require('../src/apps/app-artifacts');
const { builtinTools } = require('../src/apps/sound-tools');

const appsDir = makeAppsDir({ 's-app': { capabilities: { audio: true } } });
appManager.setAppsDir(appsDir);
platformSettings.init(appsDir);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-sfx-'));
spendPolicy.init({ dataHome: tmp });
spendLedger.init({ dataHome: tmp });
deploymentMode.init({ hostConfig: { isSlave: () => false }, appManager: { list: () => [] } });
spendPolicy.saveHost({ mode: 'local' });
deploymentMode.invalidate();
art.init({ dir: path.join(tmp, 'artifacts') });

const saved = { fetch: global.fetch, resolve: core.resolveProviderKey, native: core.listNativeModels };
let keys = { elevenlabs: 'xi-test-key' };
core.resolveProviderKey = (k) => keys[k] || '';
core.listNativeModels = undefined; // seeds carry the sfx models
test.after(() => {
  global.fetch = saved.fetch; core.resolveProviderKey = saved.resolve; core.listNativeModels = saved.native;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A stub reply: mp3 / ogg / pcm bodies a real clip would have.
const pcm = (seconds, rate) => Buffer.alloc(Math.round(seconds * rate) * 2, 1);
const mp3 = (seconds) => Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(Math.round(seconds * 16000), 0xff)]); // empty ID3v2 tag + 128 kbps frames
function ogg(seconds, preSkip = 312) {
  const head = Buffer.alloc(47); head.write('OggS', 0); head.write('OpusHead', 28); head.writeUInt16LE(preSkip, 38);
  const last = Buffer.alloc(27); last.write('OggS', 0); last.writeBigUInt64LE(BigInt(Math.round(seconds * 48000) + preSkip), 6);
  return Buffer.concat([head, last]);
}
let calls = [];
let reply = null; // (url, init) => response-like
const res = (body, status = 200) => ({ ok: status < 300, status, statusText: 'x', headers: new Map(), arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length), text: async () => body.toString() });
global.fetch = async (url, init) => {
  calls.push({ url, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
  if (reply) return reply(url, init);
  const fmt = new URL(url).searchParams.get('output_format');
  if (fmt.startsWith('mp3')) return res(mp3(2));
  if (fmt.startsWith('opus')) return res(ogg(2));
  return res(pcm(2, Number(fmt.split('_')[1])));
};
test.beforeEach(() => { calls = []; reply = null; keys = { elevenlabs: 'xi-test-key' }; platformSettings.set('mediaDefaults', ''); });
const fmtOf = (c) => new URL(c.url).searchParams.get('output_format');

test('buildRequest maps the generic params to the ElevenLabs request', () => {
  const g = { prompt: 'rain', durationSeconds: 4.5, promptInfluence: 0.7, loop: true, format: 'mp3' };
  const req = adapter.buildRequest(g, 'eleven_text_to_sound_v2', 'KEY');
  const url = new URL(req.url);
  assert.equal(url.origin + url.pathname, 'https://api.elevenlabs.io/v1/sound-generation');
  assert.equal(url.searchParams.get('output_format'), 'mp3_44100_128');
  assert.equal(req.init.method, 'POST');
  assert.equal(req.init.headers['xi-api-key'], 'KEY');
  assert.deepEqual(JSON.parse(req.init.body), { text: 'rain', model_id: 'eleven_text_to_sound_v2', duration_seconds: 4.5, prompt_influence: 0.7, loop: true });
  const auto = JSON.parse(adapter.buildRequest({ prompt: 'x', format: 'wav', sampleRate: 24000 }, 'eleven_text_to_sound_v3', 'K').init.body);
  assert.deepEqual(auto, { text: 'x', model_id: 'eleven_text_to_sound_v3' }, 'duration omitted = automatic; no loop on v3');
  assert.equal(adapter.outputFormat({ format: 'wav', sampleRate: 24000 }), 'pcm_24000');
  assert.equal(adapter.outputFormat({ format: 'pcm' }), 'pcm_44100');
  assert.equal(adapter.outputFormat({ format: 'ogg' }), 'opus_48000_128');
});

test('parseResponse: mime, ext, bytes, sample rate and measured duration per format', async () => {
  const mp = await adapter.parseResponse(res(mp3(2)), { format: 'mp3' });
  assert.deepEqual([mp.mime, mp.ext, mp.sampleRate], ['audio/mpeg', 'mp3', 44100]);
  assert.ok(Math.abs(mp.durationSeconds - 2) < 0.01);
  const og = await adapter.parseResponse(res(ogg(3)), { format: 'ogg' });
  assert.deepEqual([og.mime, og.ext, og.sampleRate], ['audio/ogg', 'ogg', 48000]);
  assert.ok(Math.abs(og.durationSeconds - 3) < 0.001);
  await assert.rejects(adapter.parseResponse(res(Buffer.from('rawopusframes')), { format: 'ogg' }), /not an Ogg file/);
  const raw = pcm(1.5, 24000);
  const pc = await adapter.parseResponse(res(raw), { format: 'pcm', sampleRate: 24000 });
  assert.deepEqual([pc.mime, pc.ext, pc.sampleRate, pc.buf.length, pc.durationSeconds], ['audio/L16', 'pcm', 24000, raw.length, 1.5]);
  const wv = await adapter.parseResponse(res(raw), { format: 'wav', sampleRate: 24000 });
  assert.deepEqual([wv.mime, wv.ext, wv.buf.length, wv.durationSeconds], ['audio/wav', 'wav', raw.length + 44, 1.5]);
  await assert.rejects(adapter.parseResponse(res(Buffer.alloc(0)), { format: 'mp3' }), /no audio/);
});

test('WAV wrapping writes a valid RIFF header with the right rate and length', () => {
  const data = pcm(0.5, 22050);
  const wav = container.wavFromPcm(data, 22050);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), 36 + data.length);
  assert.equal(wav.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 22050);
  assert.equal(wav.readUInt32LE(28), 44100);
  assert.equal(wav.readUInt16LE(32), 2);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), data.length);
  assert.equal(wav.length, 44 + data.length);
});

test('format rules: default mp3; loop without a format → wav; platform default applied; the call wins', async () => {
  let r = await ai.aiSfx('s-app', { prompt: 'door' });
  assert.deepEqual([r.format, r.mime, r.ext], ['mp3', 'audio/mpeg', 'mp3']);
  assert.equal(fmtOf(calls[0]), 'mp3_44100_128');

  calls = [];
  r = await ai.aiSfx('s-app', { prompt: 'rain', loop: true });
  assert.deepEqual([r.format, r.mime, r.sampleRate, r.loop], ['wav', 'audio/wav', 44100, true]);
  assert.equal(calls[0].body.loop, true);
  assert.equal(calls[0].body.model_id, 'eleven_text_to_sound_v2', 'a looping call with no model gets the loop-capable model');
  assert.equal(fmtOf(calls[0]), 'pcm_44100');
  assert.equal(Buffer.from(r.audio, 'base64').toString('ascii', 0, 4), 'RIFF');

  r = await ai.aiSfx('s-app', { prompt: 'rain', loop: true, format: 'mp3' });
  assert.equal(r.format, 'mp3', 'an explicit format beats the loop rule');

  platformSettings.set('mediaDefaults', { 'ai.sfx': { format: 'ogg', durationSeconds: 3, promptInfluence: 0.9 } });
  calls = [];
  r = await ai.aiSfx('s-app', { prompt: 'click' });
  assert.deepEqual([r.format, r.mime], ['ogg', 'audio/ogg']);
  assert.equal(fmtOf(calls[0]), 'opus_48000_128');
  assert.equal(calls[0].body.duration_seconds, 3);
  assert.equal(calls[0].body.prompt_influence, 0.9);
  calls = [];
  r = await ai.aiSfx('s-app', { prompt: 'click', format: 'wav', durationSeconds: 1, sampleRate: 16000 });
  assert.deepEqual([r.format, r.sampleRate], ['wav', 16000]);
  assert.equal(calls[0].body.duration_seconds, 1, 'per-call override wins');
  assert.equal(fmtOf(calls[0]), 'pcm_16000');
  assert.equal(r.bytes, Buffer.from(r.audio, 'base64').length);
  assert.ok(r.durationSeconds > 1.9 && r.durationSeconds < 2.1, 'duration is measured from the output');
});

test('a param the model does not honour comes back in ignored; bad values are refused', async () => {
  let r = await ai.aiSfx('s-app', { prompt: 'x', loop: true, model: 'eleven_text_to_sound_v3' });
  assert.ok(r.ignored.includes('loop'));
  assert.equal(calls[0].body.loop, undefined);
  assert.equal(r.format, 'mp3', 'no loop honoured → no loop rule');
  r = await ai.aiSfx('s-app', { prompt: 'x', format: 'mp3', sampleRate: 16000 });
  assert.ok(r.ignored.includes('sampleRate'));
  await assert.rejects(ai.aiSfx('s-app', { prompt: 'x', durationSeconds: 31 }), /durationSeconds must be a number between 0.5 and 30/);
  await assert.rejects(ai.aiSfx('s-app', { prompt: 'x', promptInfluence: 2 }), /promptInfluence/);
  await assert.rejects(ai.aiSfx('s-app', { prompt: 'x', format: 'flac' }), /format "flac" is not supported/);
  await assert.rejects(ai.aiSfx('s-app', { prompt: 'x', format: 'wav', sampleRate: 11025 }), /sampleRate must be one of/);
  await assert.rejects(ai.aiSfx('s-app', { prompt: '  ' }), /prompt is required/);
});

test('a missing key is the clear "not configured" error naming provider elevenlabs', async () => {
  keys = {};
  await assert.rejects(ai.aiSfx('s-app', { prompt: 'x' }), /ElevenLabs API key not configured.*Setup → AI Config.*provider "elevenlabs"/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await ai.elevenlabsDiagnose(), { state: 'no-key' });
});

test('44.1 kHz PCM refused for the plan → one retry at 24 kHz; an explicit rate is not retried', async () => {
  let n = 0;
  reply = (url) => (new URL(url).searchParams.get('output_format') === 'pcm_44100' && ++n
    ? res(Buffer.from('{"detail":{"status":"output_format_not_allowed","message":"requires pro tier"}}'), 403)
    : res(pcm(1, 24000)));
  const r = await ai.aiSfx('s-app', { prompt: 'x', format: 'wav' });
  assert.deepEqual([r.sampleRate, calls.map(fmtOf)], [24000, ['pcm_44100', 'pcm_24000']]);
  calls = [];
  await assert.rejects(ai.aiSfx('s-app', { prompt: 'x', format: 'wav', sampleRate: 44100 }), /failed \(403\)/);
  assert.equal(calls.length, 1);
});

test('vendor errors read clearly (401 key, model gone)', async () => {
  reply = () => res(Buffer.from('{"detail":{"status":"invalid_api_key"}}'), 401);
  await assert.rejects(ai.aiSfx('s-app', { prompt: 'x' }), /failed \(401\).*refused the API key/);
  reply = () => res(Buffer.from('nope'), 404);
  await assert.rejects(ai.aiSfx('s-app', { prompt: 'x' }), /not available at ElevenLabs/);
});

test('catalog, defaults row and pricing know ai.sfx', () => {
  const list = mediaCatalog.list({ method: 'ai.sfx' });
  assert.deepEqual(list.models.map((m) => m.modelId).sort(), ['eleven_text_to_sound_v2', 'eleven_text_to_sound_v3']);
  assert.equal(list.defaults['ai.sfx'].model, 'eleven_text_to_sound_v3');
  assert.equal(list.models[0].params.defaultFormat, 'mp3');
  assert.ok(require('../src/apps/model-defaults').TARGETS.some((t) => t.target === 'media.ai.sfx'));
  const p = spendPricing.price('ai.sfx', 'eleven_text_to_sound_v3', 10);
  assert.equal(p.priced, true);
  assert.equal(p.costUsd, 0.08);
});

test('the diagnose probe reads the account and never generates', async () => {
  reply = () => res(Buffer.from('{"tier":"creator","character_count":10,"character_limit":100}'));
  const d = await ai.elevenlabsDiagnose();
  assert.equal(d.state, 'ok');
  assert.match(d.sample, /creator.*10 \/ 100/);
  assert.match(calls[0].url, /\/v1\/user\/subscription$/);
  reply = () => res(Buffer.from('{"detail":{"status":"invalid_api_key"}}'), 401);
  assert.equal((await ai.elevenlabsDiagnose()).state, 'invalid-key');
  reply = () => res(Buffer.from('{"detail":{"status":"missing_permissions"}}'), 401);
  assert.equal((await ai.elevenlabsDiagnose()).state, 'ok');
});

// ---- the broker built-in ------------------------------------------------------
const tool = builtinTools.find((t) => t.name === 'sound_generate');
const session = (holder) => ({ id: 's1', mode: 'grant', toolNames: [], holder });
const textOf = (r) => r.content[0].text;

test('sound_generate: run holders only; writes into holder.cwd; refuses an escaping dest', async () => {
  const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
  const worker = session({ type: 'worker', runId: 'run-a', address: 'w1', instanceId: 'i1', cwd });
  assert.ok(tool.when(worker));
  assert.ok(!tool.when({ id: 'x' }) && !tool.when(session({ type: 'platform' })));

  const ok = await tool.handler({ prompt: 'door slam', dest: 'assets/door.mp3', durationSeconds: 2 }, worker);
  assert.ok(!ok.isError, textOf(ok));
  const out = JSON.parse(textOf(ok));
  assert.equal(out.path, path.join(cwd, 'assets', 'door.mp3'));
  assert.deepEqual([out.mime, out.format, out.ext], ['audio/mpeg', 'mp3', 'mp3']);
  assert.ok(out.bytes > 0 && out.durationSeconds > 1.9);
  assert.equal(fs.statSync(out.path).size, out.bytes);
  assert.equal(ok.content[1].type, 'resource_link');
  assert.equal(ok.content[1].uri, out.uri);
  assert.ok(art.canRead({ type: 'run', runId: 'run-a' }, out.uri));
  assert.ok(!art.canRead({ type: 'run', runId: 'run-b' }, out.uri));

  calls = [];
  const bad = await tool.handler({ prompt: 'x', dest: '../escape.mp3' }, worker);
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /outside the directory/);
  assert.ok(!fs.existsSync(path.join(tmp, 'escape.mp3')));
  assert.equal(calls.length, 0, 'a bad dest is refused before anything is generated or paid');
  fs.symlinkSync(os.tmpdir(), path.join(cwd, 'link'));
  assert.equal((await tool.handler({ prompt: 'x', dest: 'link/x.mp3' }, worker)).isError, true);
  assert.match(textOf(await tool.handler({ prompt: 'x', dest: 'y.mp3' }, session({ type: 'worker', runId: 'run-a', address: 'w1', instanceId: 'i1' }))), /working directory is unknown/);

  const noDest = await tool.handler({ prompt: 'rain', loop: true }, worker);
  const nd = JSON.parse(textOf(noDest));
  assert.equal(nd.path, undefined);
  assert.equal(nd.format, 'wav');
  assert.equal(nd.loop, true);
});

test('sound_generate: the platform spend policy refuses with a readable result', async () => {
  const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
  const worker = session({ type: 'worker', runId: 'run-a', address: 'w1', instanceId: 'i1', cwd });
  keys = {};
  const r = await tool.handler({ prompt: 'x' }, worker);
  assert.equal(r.isError, true);
  assert.match(textOf(r), /ElevenLabs API key not configured/);
});

test("Horst's sound_generate is the audio module's direct tool, on the same engine, stored as an audio artifact", async () => {
  const audio = require('../src/apps/capabilities/audio');
  assert.equal(audio.horst.lane.direct['ai.sfx'], 'sound_generate');
  const horstTool = audio.horst.tools.find((t) => t.def.name === 'sound_generate');
  const r = await horstTool.handler({ prompt: 'thunder', format: 'wav', durationSeconds: 2 }, { type: 'horst' });
  assert.ok(!r.isError, r.content[0].text);
  assert.equal(r.content[1].mimeType, 'audio/wav');
  assert.match(r.content[1].name, /^sound-.*\.wav$/);
  assert.equal(calls[0].body.text, 'thunder');
});
