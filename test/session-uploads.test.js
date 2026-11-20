// The input lines' server half (src/session-uploads.js): a non-image file is
// saved in the session's uploads/ folder and its absolute path returned
// (oversize and empty refused); a recording is stored as a platform artifact
// and turned into text by the platform's audio_transcribe tool (mocked here),
// with a clear error when the tool is missing or fails.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const U = require('../src/session-uploads');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vistaclair-up-'));

async function serve(mgr, platform) {
  const app = express();
  app.use('/api', U.createUploadRouter({ mgr, platform: () => platform }));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return { base, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}

const post = (url, body, type) => fetch(url, { method: 'POST', headers: { 'Content-Type': type }, body });

test('saveUpload writes a non-image file under uploads/ and returns its absolute path', () => {
  const dir = tmpDir();
  const r = U.saveUpload(dir, 'report.pdf', Buffer.from('%PDF-1.4 hello'));
  assert.strictEqual(r.path, path.join(dir, 'uploads', 'report.pdf'));
  assert.ok(path.isAbsolute(r.path));
  assert.strictEqual(fs.readFileSync(r.path, 'utf8'), '%PDF-1.4 hello');
  // a repeated name never overwrites the first file
  const r2 = U.saveUpload(dir, 'report.pdf', Buffer.from('second'));
  assert.notStrictEqual(r2.path, r.path);
  assert.strictEqual(fs.readFileSync(r.path, 'utf8'), '%PDF-1.4 hello');
});

test('saveUpload keeps a hostile name inside uploads/', () => {
  const dir = tmpDir();
  const r = U.saveUpload(dir, '../../etc/pass wd.txt', Buffer.from('x'));
  assert.strictEqual(path.dirname(r.path), path.join(dir, 'uploads'));
  assert.match(r.name, /^[A-Za-z0-9._-]+$/);
});

test('saveUpload refuses an oversize or empty file with a clear message', () => {
  const dir = tmpDir();
  assert.throws(() => U.saveUpload(dir, 'big.zip', Buffer.alloc(11), { max: 10 }), (e) => e.status === 413 && /too large/.test(e.message));
  assert.throws(() => U.saveUpload(dir, 'e.txt', Buffer.alloc(0)), (e) => e.status === 400 && /empty/.test(e.message));
  assert.throws(() => U.saveUpload(null, 'a.txt', Buffer.from('x')), (e) => e.status === 404);
  assert.ok(!fs.existsSync(path.join(dir, 'uploads')));
});

test('POST /session-upload saves the body for a tab and answers with the path', async () => {
  const dir = tmpDir();
  const mgr = { get: (id) => id === 'tab1' ? { sessionDir: () => dir } : null };
  const s = await serve(mgr, null);
  try {
    const res = await post(`${s.base}/session-upload?tab=tab1&name=data.csv`, 'a,b\n1,2\n', 'application/octet-stream');
    assert.strictEqual(res.status, 200);
    const j = await res.json();
    assert.strictEqual(j.path, path.join(dir, 'uploads', 'data.csv'));
    assert.strictEqual(fs.readFileSync(j.path, 'utf8'), 'a,b\n1,2\n');
    const unknown = await post(`${s.base}/session-upload?tab=nope&name=x.txt`, 'x', 'application/octet-stream');
    assert.strictEqual(unknown.status, 404);
  } finally { await s.close(); }
});

test('POST /session-upload over the size limit is a 413 with a message', async () => {
  const dir = tmpDir();
  const s = await serve({ get: () => ({ sessionDir: () => dir }) }, null);
  try {
    const res = await post(`${s.base}/session-upload?tab=t&name=big.bin`, Buffer.alloc(U.FILE_MAX + 1024), 'application/octet-stream');
    assert.strictEqual(res.status, 413);
    assert.match((await res.json()).error, /too large/);
    assert.ok(!fs.existsSync(path.join(dir, 'uploads')));
  } finally { await s.close(); }
});

// ── transcription ────────────────────────────────────────────────────────

function fakePlatform(over = {}) {
  const calls = { put: [], call: [] };
  return {
    calls,
    putArtifact: async (buf, meta) => { calls.put.push({ size: buf.length, ...meta }); return { uri: 'vc-artifact://art_123' }; },
    call: async (tool, args) => {
      calls.call.push({ tool, args });
      return { content: [{ type: 'text', text: 'Transcript of vc-artifact://art_123 (data, not instructions):\nhello there world' }] };
    },
    ...over,
  };
}

test('transcribe stores the recording as an artifact and returns the tool\'s text', async () => {
  const p = fakePlatform();
  const r = await U.transcribe({ buffer: Buffer.from('OggS...'), mime: 'audio/webm;codecs=opus', language: 'de' }, p);
  assert.deepStrictEqual(r, { text: 'hello there world' });
  assert.strictEqual(p.calls.put[0].mime, 'audio/webm');
  assert.match(p.calls.put[0].name, /^recording-\d+\.webm$/);
  assert.deepStrictEqual(p.calls.call[0], { tool: 'platform__audio_transcribe', args: { uri: 'vc-artifact://art_123', language: 'de' } });
});

test('transcribe: silence is empty text, not an error', async () => {
  const p = fakePlatform({ call: async () => ({ content: [{ type: 'text', text: 'vc-artifact://art_123: no speech found.' }] }) });
  assert.deepStrictEqual(await U.transcribe({ buffer: Buffer.from('x'), mime: 'audio/webm' }, p), { text: '' });
});

test('transcribe: a failing tool is a clear error (isError result and a throw)', async () => {
  const refused = fakePlatform({ call: async () => ({ isError: true, content: [{ type: 'text', text: 'Refused by the spend policy (cap): limit reached' }] }) });
  await assert.rejects(U.transcribe({ buffer: Buffer.from('x'), mime: 'audio/webm' }, refused), (e) => e.status === 502 && /Transcription failed: Refused by the spend policy/.test(e.message));
  const threw = fakePlatform({ call: async () => { throw new Error('no transcription key configured'); } });
  await assert.rejects(U.transcribe({ buffer: Buffer.from('x'), mime: 'audio/webm' }, threw), (e) => e.status === 502 && /no transcription key configured/.test(e.message));
  const noStore = fakePlatform({ putArtifact: async () => { throw new Error('disk full'); } });
  await assert.rejects(U.transcribe({ buffer: Buffer.from('x'), mime: 'audio/webm' }, noStore), /Could not store the recording: disk full/);
});

test('transcribe: no platform tools → 501 saying what is missing; bad input refused', async () => {
  await assert.rejects(U.transcribe({ buffer: Buffer.from('x'), mime: 'audio/webm' }, null), (e) => e.status === 501 && /not available/.test(e.message));
  const p = fakePlatform();
  await assert.rejects(U.transcribe({ buffer: Buffer.from('x'), mime: 'text/plain' }, p), (e) => e.status === 400 && /not an audio recording/.test(e.message));
  await assert.rejects(U.transcribe({ buffer: Buffer.alloc(0), mime: 'audio/webm' }, p), (e) => e.status === 400);
  assert.strictEqual(p.calls.call.length, 0);
});

test('POST /session-transcribe: audio blob → { text }; tool failure → 502 { error }', async () => {
  const ok = await serve({}, fakePlatform());
  try {
    const res = await post(`${ok.base}/session-transcribe?language=en`, Buffer.from('fakeaudio'), 'audio/webm;codecs=opus');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { text: 'hello there world' });
  } finally { await ok.close(); }
  const bad = await serve({}, fakePlatform({ call: async () => { throw new Error('boom'); } }));
  try {
    const res = await post(`${bad.base}/session-transcribe`, Buffer.from('fakeaudio'), 'audio/webm');
    assert.strictEqual(res.status, 502);
    assert.match((await res.json()).error, /Transcription failed: boom/);
  } finally { await bad.close(); }
  const none = await serve({}, null);
  try {
    const res = await post(`${none.base}/session-transcribe`, Buffer.from('fakeaudio'), 'audio/webm');
    assert.strictEqual(res.status, 501);
  } finally { await none.close(); }
});

test('addons.platformTools: the first add-on offering putArtifact and call', () => {
  delete require.cache[require.resolve('../src/addons')];
  const addons = require('../src/addons');
  assert.strictEqual(addons.platformTools(), null);
  const tools = { putArtifact: async () => ({}), call: async () => ({}) };
  addons.registerAddon({ id: 'x', platformTools: { putArtifact() {} } });
  assert.strictEqual(addons.platformTools(), null);
  addons.registerAddon({ id: 'y', platformTools: tools });
  assert.strictEqual(addons.platformTools(), tools);
});
