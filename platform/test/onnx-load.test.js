// The native onnxruntime must load. @huggingface/transformers bundles/uses an
// onnxruntime-node of its own version; when the tree resolves a different
// top-level onnxruntime-node the .so versions clash at dlopen time
// ("libonnxruntime.so.1: version VERS_x not found") and the email embedding
// sweep dies. This test loads the exact paths the platform uses:
//   - import('@huggingface/transformers')         (embeddings.js)
//   - the onnxruntime-node transformers resolves   (a session on a tiny model)
//   - the top-level onnxruntime-node               (silero-vad.js)
//   - embeddings.embed() / silero getSegments()    (need the network for model
//     weights; they skip cleanly when the download fails)
// The tiny model is a hand-encoded ONNX Identity graph, no download needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

// ── minimal protobuf encoding of ModelProto { Identity: float[2] -> float[2] }
const varint = (n) => { const o = []; while (n > 127) { o.push((n & 127) | 128); n >>>= 7; } o.push(n); return o; };
const field = (no, wire, payload) => [...varint((no << 3) | wire), ...payload];
const lenField = (no, bytes) => field(no, 2, [...varint(bytes.length), ...bytes]);
const str = (s) => [...Buffer.from(s)];
const valueInfo = (name) => [
  ...lenField(1, str(name)),
  ...lenField(2, lenField(1, [...field(1, 0, varint(1)), ...lenField(2, lenField(1, field(1, 0, varint(2))))])),
];
function identityModel() {
  const node = [...lenField(1, str('x')), ...lenField(2, str('y')), ...lenField(4, str('Identity'))];
  const graph = [...lenField(1, node), ...lenField(2, str('g')), ...lenField(11, valueInfo('x')), ...lenField(12, valueInfo('y'))];
  return Buffer.from([
    ...field(1, 0, varint(8)),                         // ir_version
    ...lenField(8, [...lenField(1, []), ...field(2, 0, varint(13))]), // opset 13
    ...lenField(7, graph),
  ]);
}

async function runIdentity(ort) {
  const session = await ort.InferenceSession.create(new Uint8Array(identityModel()), { logSeverityLevel: 3 });
  const out = await session.run({ x: new ort.Tensor('float32', Float32Array.from([1.5, -2]), [2]) });
  assert.deepEqual(Array.from(out.y.data), [1.5, -2]);
}

// transformers' package.json is not in its exports map: find the package dir
// from the root node_modules lookup path instead.
const tfDir = require.resolve.paths('@huggingface/transformers')
  .map((d) => path.join(d, '@huggingface', 'transformers'))
  .find((d) => fs.existsSync(path.join(d, 'package.json')));
const tfRequire = createRequire(path.join(tfDir, 'package.json'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-onnx-load-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('@huggingface/transformers imports (native onnxruntime loads)', async () => {
  const tf = await import('@huggingface/transformers');
  assert.equal(typeof tf.pipeline, 'function');
});

test('the onnxruntime-node transformers resolves runs a session', async () => {
  await runIdentity(tfRequire('onnxruntime-node'));
});

test('the top-level onnxruntime-node (silero-vad) runs a session', async () => {
  await runIdentity(require('onnxruntime-node'));
});

test('transformers and the top-level onnxruntime-node are one install', () => {
  const a = require.resolve('onnxruntime-node');
  const b = tfRequire.resolve('onnxruntime-node');
  assert.equal(fs.realpathSync(a), fs.realpathSync(b),
    'two onnxruntime-node copies in the tree: their native libs clash');
});

// The native library is process-global: whichever onnxruntime-node loads first
// wins, so the order the server happens to hit them in decides which one
// breaks. Run both orders in fresh processes (the live failure was top-level
// first, then transformers: "version VERS_1.30.0 not found").
for (const order of [['top', 'tf'], ['tf', 'top']]) {
  test(`both onnxruntime-node entry points load in one process (${order.join(' then ')})`, () => {
    const { execFileSync } = require('child_process');
    const code = `
      const { createRequire } = require('module');
      const tfRequire = createRequire(${JSON.stringify(path.join(tfDir, 'package.json'))});
      const load = { top: () => require('onnxruntime-node'), tf: () => tfRequire('onnxruntime-node') };
      for (const k of ${JSON.stringify(order)}) load[k]();
    `;
    execFileSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..', '..'), stdio: 'pipe' });
  });
}

// The model downloads need the network; an offline run skips, a native-lib
// failure (the regression) still fails because it is not a fetch error.
const FETCH_ERR = /fetch|network|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|getaddrinfo|Unauthorized|could not locate|socket/i;

test('embeddings.embed() returns a 384-d unit vector', { timeout: 300000 }, async (t) => {
  const emb = require('../src/apps/embeddings');
  // Persistent cache so only the first run downloads the weights.
  const appsDir = path.join(os.tmpdir(), 'vc-onnx-load-cache');
  fs.mkdirSync(appsDir, { recursive: true });
  emb.init(appsDir);
  let v;
  try {
    v = await emb.embed('hello world');
  } catch (e) {
    if (/VERS_|libonnxruntime|\.so/.test(e.message) || !FETCH_ERR.test(e.message)) throw e;
    return t.skip('model not fetchable (offline): ' + e.message);
  }
  assert.equal(v.length, emb.DIM);
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-3);
});

test('silero-vad getSegments() runs the model', { timeout: 120000 }, async (t) => {
  const vad = require('../src/apps/silero-vad');
  vad.init(path.join(tmp, 'apps'));
  let r;
  try {
    r = await vad.getSegments(new Float32Array(vad.SAMPLE_RATE)); // 1 s of silence
  } catch (e) {
    if (/VERS_|libonnxruntime|\.so/.test(e.message) || !FETCH_ERR.test(e.message)) throw e;
    return t.skip('VAD model not fetchable (offline): ' + e.message);
  }
  assert.equal(r.hasSpeech, false);
});
