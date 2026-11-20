// Horst lanes: every capability member is classified direct / card / never and
// the classification is backed (a tool, a kind, or a stated reason); the direct
// media tools call the same ai-media engine apps use — stubbed at fetch — store
// their output as owner artifacts and refuse what the caller may not read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeAppsDir } = require('./helpers');
const capabilities = require('../src/apps/capabilities');
const appManager = require('../src/apps/app-manager');
const art = require('../src/apps/app-artifacts');
const spendPolicy = require('../src/apps/spend-policy');
const spendLedger = require('../src/apps/spend-ledger');
const deploymentMode = require('../src/apps/deployment-mode');
const { core } = require('../src/apps/core-services');

const appsDir = makeAppsDir({});
appManager.setAppsDir(appsDir);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-lanes-'));
art.init({ dir: path.join(tmp, 'artifacts') });
spendPolicy.init({ dataHome: tmp });
spendLedger.init({ dataHome: tmp });
deploymentMode.init({ hostConfig: { isSlave: () => false }, appManager: { list: () => [] } });
spendPolicy.saveHost({ mode: 'local', enforce: true });
deploymentMode.invalidate();

const saved = { fetch: global.fetch, resolve: core.resolveProviderKey, native: core.listNativeModels };
core.resolveProviderKey = (k) => ({ openai: 'sk-openai', google: 'g-key', xai: 'xai-key' })[k] || '';
core.listNativeModels = () => require('../src/apps/media').ADAPTERS.flatMap((a) => a.seedModels.map((modelId) => ({ providerKey: a.provider, modelId, label: modelId, kind: 'x', usedBy: a.method })));

const PNG = Buffer.from('fake-png-bytes');
let calls = [];
let reply = null;
global.fetch = async (url, init) => {
  calls.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
  return reply(url);
};
const json = (body) => ({ ok: true, status: 200, headers: new Map([['content-type', 'application/json']]), json: async () => body, text: async () => JSON.stringify(body) });
const imageReply = () => json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } }] });

test.beforeEach(() => { calls = []; reply = imageReply; });
test.after(() => {
  global.fetch = saved.fetch;
  core.resolveProviderKey = saved.resolve;
  core.listNativeModels = saved.native;
  fs.rmSync(appsDir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

const tool = (name) => capabilities.horstTools().find((t) => t.def.name === name);
const HORST = { type: 'horst', conversationId: 'c1', surface: 'telegram', chatId: '42' };
const linksOf = (r) => r.content.filter((b) => b.type === 'resource_link');

// ---- the lane contract ------------------------------------------------------

const fakeCap = (lane, { methods = ['x.read', 'x.write'], tools = [] } = {}) => ({
  key: 'x', methods, ctx: [], horst: { tools: tools.map((name) => ({ def: { name } })), lane: capabilities.validateLane(lane, 'x') },
});
const opts = { kindNames: new Set(['x.write']), toolNames: new Set(['x_read']) };

test('lanes: every module of the live registry has a stance and no gap', () => {
  const toolNames = new Set([
    ...capabilities.horstTools().map((t) => t.def.name),
    ...require('../src/apps/agent/horst-brain').brainTools().map((t) => t.def.name),
  ]);
  const kindNames = new Set([...Object.keys(capabilities.horstKinds()), ...Object.keys(require('../src/apps/governance/horst-governance').KINDS)]);
  for (const cap of capabilities.all()) {
    assert.deepEqual(capabilities.laneProblems(cap, { toolNames, kindNames }), [], cap.key);
    const lanes = capabilities.laneOf(cap);
    for (const m of capabilities.laneMembers(cap)) assert.ok(capabilities.LANES.includes(lanes[m].lane), `${cap.key}.${m}`);
  }
});

test('lanes: a missing stance, an unclassified member or a stale name fails the check', () => {
  assert.match(capabilities.laneProblems(fakeCap(null), opts)[0], /declares no horst\.lane/);
  const unclassified = capabilities.laneProblems(fakeCap({ direct: { 'x.read': 'x_read' } }), opts);
  assert.equal(unclassified.length, 1);
  assert.match(unclassified[0], /leaves member "x\.write" unclassified/);
  // A default classifies the rest.
  assert.deepEqual(capabilities.laneProblems(fakeCap({ default: 'never', direct: { 'x.read': 'x_read' } }), opts), []);
  assert.match(capabilities.laneProblems(fakeCap({ default: 'never', never: ['x.gone'] }), opts)[0], /"x\.gone", which is not one of its members/);
  assert.throws(() => capabilities.validateLane({ never: ['x.read'], direct: { 'x.read': 'x_read' } }, 'x'), /classifies "x\.read" twice/);
  assert.throws(() => capabilities.validateLane({ default: 'maybe' }, 'x'), /default must be one of/);
});

test('lanes: a direct member needs a tool (or a deferral), a card member a registered kind (or a gap)', () => {
  const p1 = capabilities.laneProblems(fakeCap({ default: 'direct' }), opts);
  assert.ok(p1.some((m) => /direct member "x\.read" has no Horst tool/.test(m)));
  assert.match(capabilities.laneProblems(fakeCap({ direct: { 'x.read': 'x_nope' }, never: ['x.write'] }), opts)[0], /names tool "x_nope", which is not in Horst's tool pack/);
  assert.match(capabilities.laneProblems(fakeCap({ direct: { 'x.read': 'x_read' }, card: { 'x.write': 'x.nope' } }), opts)[0], /names kind "x\.nope", which is not registered/);
  assert.deepEqual(capabilities.laneProblems(fakeCap({
    direct: { 'x.read': { deferred: 'later' } }, card: { 'x.write': { missing: 'not built' } },
  }), opts), []);
  assert.throws(() => capabilities.validateLane({ card: { 'x.write': { deferred: 'wrong key' } } }, 'x'), /must name a kind or carry a \{ missing: reason \}/);
});

test('lanes: the expected stances hold', () => {
  const lane = (key, m) => capabilities.laneOf(capabilities.get(key))[m];
  assert.deepEqual(lane('audio', 'ai.image'), { lane: 'direct', tools: ['image_generate'] });
  assert.equal(lane('audio', 'ai.tts').tools[0], 'speech_generate');
  assert.equal(lane('audio', 'ai.transcribe').tools[0], 'audio_transcribe');
  assert.deepEqual(lane('email', 'email.send'), { lane: 'card', kinds: ['email.send'] });
  assert.deepEqual(lane('whatsapp', 'whatsapp.send'), { lane: 'card', kinds: ['whatsapp.send'] });
  assert.equal(lane('platform-cron', 'platform.cron.schedule').kinds[0], 'cron.set');
  for (const [key, m] of [['exec', 'exec'], ['cli', 'cli.edit'], ['fs', 'fs.write'], ['secrets', 'secrets.get'], ['http', 'http.fetch'], ['db', 'db.query'], ['state', 'state.set'], ['google', 'auth.google.getToken'], ['embeddings', 'embed']]) {
    assert.equal(lane(key, m).lane, 'never', `${key}.${m}`);
  }
});

// ---- direct media tools -----------------------------------------------------

test('image_generate: the engine draws, the picture becomes an owner artifact returned as a resource_link', async () => {
  const r = await tool('image_generate').handler({ prompt: 'a fox in the snow' }, HORST);
  assert.ok(!r.isError);
  assert.match(calls[0].url, /generativelanguage\.googleapis\.com/);
  assert.equal(calls[0].body.contents[0].parts.find((p) => p.text).text, 'a fox in the snow');
  const [link] = linksOf(r);
  assert.match(link.uri, /^vc-artifact:\/\/art_/);
  assert.equal(link.mimeType, 'image/png');
  const view = art.get(link.uri);
  assert.deepEqual(view.producer, { platform: 'horst', tool: 'image_generate' });
  assert.equal(view.app, null);
  assert.ok(art.canRead({ type: 'owner' }, link.uri));
  assert.deepEqual(fs.readFileSync(art.blobPath(link.uri)), PNG);
  assert.match(r.content[0].text, /base set to that uri/);
});

test('image_generate: an edit passes the base picture (then the references) to the adapter', async () => {
  const base = await art.putPlatform(Buffer.from('the-fox'), { mime: 'image/png', name: 'fox.png' }, { producer: { platform: 'horst', tool: 'image_generate' } });
  const ref = await art.putPlatform(Buffer.from('a-moon'), { mime: 'image/jpeg', name: 'moon.jpg' }, { producer: { platform: 'telegram' } });
  const r = await tool('image_generate').handler({ prompt: 'make it night time, add a moon', base: base.uri, inputs: [ref.uri] }, HORST);
  const inline = calls[0].body.contents[0].parts.filter((p) => p.inline_data).map((p) => p.inline_data);
  assert.deepEqual(inline, [
    { mime_type: 'image/png', data: Buffer.from('the-fox').toString('base64') },
    { mime_type: 'image/jpeg', data: Buffer.from('a-moon').toString('base64') },
  ]);
  assert.match(r.content[0].text, new RegExp(`Edited ${base.uri}`));
  assert.notEqual(linksOf(r)[0].uri, base.uri);
});

test('image_generate: an input the caller cannot read is refused before any provider call', async () => {
  const owned = await art.putPlatform(Buffer.from('private'), { mime: 'image/png' }, { producer: { platform: 'telegram' } });
  const worker = { type: 'worker', runId: 'run-1', address: 'w1' };
  await assert.rejects(tool('image_generate').handler({ prompt: 'x', base: owned.uri }, worker), /No read access/);
  await assert.rejects(tool('image_generate').handler({ prompt: 'x', base: 'vc-artifact://art_0000000000000000-0000' }, HORST), /Unknown artifact/);
  const doc = await art.putPlatform(Buffer.from('%PDF'), { mime: 'application/pdf' }, { producer: { platform: 'telegram' } });
  await assert.rejects(tool('image_generate').handler({ prompt: 'x', base: doc.uri }, HORST), /not an image/);
  assert.equal(calls.length, 0);
  // Granted to the run, the same uri is readable — and the output is granted back.
  art.grant(owned.uri, { type: 'run', runId: 'run-1' });
  const r = await tool('image_generate').handler({ prompt: 'x', base: owned.uri }, worker);
  assert.ok(art.canRead({ type: 'run', runId: 'run-1' }, linksOf(r)[0].uri));
});

test('speech_generate: text-to-speech lands as an audio artifact', async () => {
  reply = () => ({ ok: true, status: 200, headers: new Map(), arrayBuffer: async () => Buffer.from('ID3audio').buffer });
  const r = await tool('speech_generate').handler({ text: 'A fox in the snow, at night, under the moon.' }, HORST);
  assert.match(calls[0].url, /api\.openai\.com\/v1\/audio\/speech/);
  assert.equal(calls[0].body.input, 'A fox in the snow, at night, under the moon.');
  const [link] = linksOf(r);
  assert.equal(link.mimeType, 'audio/mpeg');
  assert.match(link.name, /\.mp3$/);
  assert.deepEqual(art.get(link.uri).producer, { platform: 'horst', tool: 'speech_generate' });
});

test('spend: a refused gate comes back as a readable error result, nothing is stored', async () => {
  const before = art.list({}).length;
  spendPolicy.saveHost({ host: { local: { preset: 'locked' } } });
  deploymentMode.invalidate();
  try {
    const r = await tool('image_generate').handler({ prompt: 'a fox' }, HORST);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /^Refused by the spend policy \(E_[A-Z_]+\)/);
    assert.equal(calls.length, 0);
    assert.equal(art.list({}).length, before);
  } finally {
    spendPolicy.saveHost({ host: { local: { preset: 'unlimited' } } });
    deploymentMode.invalidate();
  }
});
