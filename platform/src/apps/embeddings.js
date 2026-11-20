// Shared local embedding model (transformers.js). One in-process singleton,
// used by the platform memory system AND exposed to apps (ctx.embed / the
// 'embed' bridge method) so any app can build semantic search over its own
// dataset: embed the data once into a VECTOR column, embed the query at search
// time, ANN with VEC_DISTANCE_COSINE.
//
// Lazy-loaded; never per-call. First load downloads weights (~12s) and caches
// them under appsDir/.embedding-cache so they survive `npm install`.
const path = require('path');

const DIM = 384;
// multilingual-e5-small: same 384-d output as the previous bge-small-en, but
// multilingual (100+ languages) with real cross-lingual retrieval — a German
// query lands next to an English fact. Swapped 2026-08 (the user's data is
// DE+EN and bge-small-en handled neither German recall nor cross-lingual).
const MODEL = 'Xenova/multilingual-e5-small';
// Bumped on EVERY model change. Apps that store vectors (ctx.embed) must
// compare info().version against what they embedded with and re-embed on
// mismatch — vectors from different models are not comparable.
const MODEL_VERSION = 2;
const MAX_BATCH = 256;
const MAX_INPUT_CHARS = 8000; // guard against pathologically long inputs

let _appsDir = null;
let _embedder = null;
let _loading = null;

function init(appsDir) {
  _appsDir = appsDir;
}

async function getEmbedder() {
  if (_embedder) return _embedder;
  if (_loading) return _loading;
  _loading = (async () => {
    const tf = await import('@huggingface/transformers');
    if (_appsDir) {
      tf.env.cacheDir = path.join(_appsDir, '.embedding-cache');
      tf.env.allowLocalModels = true;
    }
    _embedder = await tf.pipeline('feature-extraction', MODEL);
    return _embedder;
  })();
  // Clear on failure so a transient download error doesn't disable embeddings
  // for the process lifetime — the next call retries the load.
  _loading.catch(() => { _loading = null; });
  return _loading;
}

// Optional background warmup so the first app/memory call isn't slow.
function warm() {
  getEmbedder().catch(() => {});
}

// embed(text | string[], {kind}) -> number[] | number[][]
// Mean-pooled + L2-normalized 384-d vectors (cosine == dot product).
// e5 is ASYMMETRIC: search queries embed with kind:'query', stored/compared
// content with kind:'passage' (the default — existing callers keep working).
// Doc-vs-doc comparisons (dedupe, entity resolution) are passage:passage.
async function embed(input, opts = {}) {
  const kind = opts.kind === 'query' ? 'query' : 'passage';
  const single = !Array.isArray(input);
  const arr = (single ? [input] : input)
    .map((s) => `${kind}: ` + String(s == null ? '' : s).slice(0, MAX_INPUT_CHARS));
  if (arr.length === 0) return [];
  const vecs = await runBatches(arr);
  return single ? vecs[0] : vecs;
}

// Already-prefixed inputs → vectors, chunked so a large batch neither holds
// the event loop nor blows memory.
async function runBatches(arr) {
  const e = await getEmbedder();
  const out = [];
  for (let i = 0; i < arr.length; i += MAX_BATCH) {
    const res = await e(arr.slice(i, i + MAX_BATCH), { pooling: 'mean', normalize: true });
    out.push(...res.tolist());
  }
  return out;
}

// MariaDB VECTOR literal for VEC_FromText(?): '[0.1,0.2,...]'.
function toVectorLiteral(v) {
  if (!Array.isArray(v)) throw new Error('toVectorLiteral expects a number[]');
  return '[' + v.map((x) => (Number.isFinite(x) ? x : 0)).join(',') + ']';
}

function info() {
  return { model: MODEL, version: MODEL_VERSION, dim: DIM, maxBatch: MAX_BATCH, loaded: !!_embedder };
}

module.exports = { init, warm, embed, toVectorLiteral, info, DIM, MODEL, MODEL_VERSION };
