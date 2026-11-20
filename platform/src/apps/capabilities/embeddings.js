// Capability: embeddings — `embed` — local 384-dim vectors
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.

module.exports = {
  key: 'embeddings',
  title: 'Embeddings & Semantic Search',
  core: false,
  gated: true,
  cost: 'free',
  audiences: ['owner', 'user'],
  methods: ['embed'],
  impliedBy: ['ai'],
  ctx: ['embed', 'vectorLiteral', 'embeddingInfo'],
  keywords: /\b(embedding|semantic search|vector|cosine similarit)\b/i,
  summary: '`embed` — local 384-dim vectors',

  buildCtx(app) {
    // Local embedding model (384-d, semantic). Lets apps build their own vector
    // search: embed(text|string[]) -> vector(s); vectorLiteral(v) -> MariaDB
    // VEC_FromText() string. The app's per-app DB supports VECTOR(384) columns.
    return {
      embed: (input) => require('../embeddings').embed(input),
      vectorLiteral: (v) => require('../embeddings').toVectorLiteral(v),
      get embeddingInfo() { return require('../embeddings').info(); },
    };
  },

  bridge: {
    'embed': async (app, params) => {
      const embeddings = require('../embeddings');
      if (params.info) return embeddings.info();
      const input = params.input ?? params.text ?? params.texts;
      if (input == null) throw new Error('embed requires input (string or string[])');
      const vectors = await embeddings.embed(input, { kind: params.kind });
      return { vectors, dim: embeddings.DIM };
    },
  },

  horst: {
    lane: {
      default: 'never',
      why: 'a raw vector has no chat use; Horst\'s recall embeds through the memory store',
    },
  },
};
