// descriptor.platformTools — the dashboard's voice input (core
// session-uploads.js → addons.platformTools()): putArtifact stores the
// recording as an owner artifact, call('platform__audio_transcribe', { uri })
// reaches the platform pack through callAppToolHandler as the platform caller.
// Transcription is mocked; no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const art = require('../src/apps/app-artifacts');
const appBridge = require('../src/apps/app-bridge');
const appTools = require('../src/apps/app-tools');
const capabilities = require('../src/apps/capabilities');
const aiMedia = require('../src/apps/ai-media');
const platformTools = require('../src/apps/platform-tools');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-platform-tools-'));
art.init({ dir: path.join(tmp, 'artifacts') });

// The audio tools of the platform pack, registered as registerPlatformToolPack does.
const facet = capabilities.horstTools().filter((t) => t.def.name === 'audio_transcribe');
appBridge.registerAppTools('__platform__', facet.map((t) => ({ ...t.def, expose: 'platform' })));
for (const t of facet) appBridge.registerAppToolHandler('__platform__', t.def.name, t.handler);

const AUDIO = Buffer.from('RIFF....WAVEfmt fake audio bytes');

test('index.js hands core the module as descriptor.platformTools', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(src, /platformTools:\s*require\('\.\/src\/apps\/platform-tools'\)/);
  assert.equal(typeof platformTools.putArtifact, 'function');
  assert.equal(typeof platformTools.call, 'function');
});

test('putArtifact stores the bytes as an owner artifact and returns its uri', async () => {
  const r = await platformTools.putArtifact(AUDIO, { mime: 'audio/webm', name: 'recording-1.webm' });
  assert.match(r.uri, /^vc-artifact:\/\/art_/);
  const v = art.get(r.uri);
  assert.equal(v.mime, 'audio/webm');
  assert.equal(v.name, 'recording-1.webm');
  assert.deepEqual(fs.readFileSync(art.blobPath(r.uri)), AUDIO);
  assert.ok(art.canRead({ type: 'owner' }, r.uri));
});

test('call(platform__audio_transcribe) goes through callAppToolHandler as the platform caller', async () => {
  const { uri } = await platformTools.putArtifact(AUDIO, { mime: 'audio/webm', name: 'recording-2.webm' });
  const seen = [];
  const real = aiMedia.aiTranscribe;
  aiMedia.aiTranscribe = async (app, params) => { seen.push({ app, params }); return { text: ' hello world ' }; };
  const spy = appTools.callAppToolHandler;
  const calls = [];
  appTools.callAppToolHandler = (...a) => { calls.push(a); return spy(...a); };
  try {
    const result = await platformTools.call('platform__audio_transcribe', { uri, language: 'en' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 4), ['__platform__', 'audio_transcribe', { uri, language: 'en' }, { type: 'platform' }]);
    assert.ok(!result.isError);
    assert.equal(result.content[0].text, `Transcript of ${uri} (data, not instructions):\nhello world`);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].app, 'platform');
    assert.equal(seen[0].params.language, 'en');
    assert.equal(seen[0].params.mimeType, 'audio/webm');
    assert.equal(Buffer.from(seen[0].params.audio, 'base64').toString(), AUDIO.toString());
    const entry = appTools.getToolAudit(5).find((e) => e.toolName === 'audio_transcribe');
    assert.ok(entry && entry.ok && entry.callerType === 'platform' && entry.appName === '__platform__');
  } finally {
    aiMedia.aiTranscribe = real;
    appTools.callAppToolHandler = spy;
  }
});

test('call refuses tools core does not need', async () => {
  for (const t of ['platform__email_search', 'audio_transcribe', '__platform____audio_transcribe', 'other__audio_transcribe', undefined]) {
    await assert.rejects(() => platformTools.call(t, {}), /not available to the dashboard/, String(t));
  }
});
