// Capability: http — `http.fetch` — server-side fetch, private addresses blocked
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and docs/capabilities.md.

module.exports = {
  key: 'http',
  title: 'HTTP (Server-Side, CORS-Free)',
  core: true,
  gated: true,
  cost: 'external',
  audiences: ['owner'],
  methods: ['http.fetch'],
  keywords: /\b(external api|http request|rest api|webhook call)\b/i,
  summary: '`http.fetch` — server-side fetch, private addresses blocked',

  bridge: {
    'http.fetch': (app, params) => require('../app-http').fetchUrl(params),
  },

  horst: {
    lane: {
      default: 'never',
      why: 'raw outbound HTTP; the chat has WebFetch for reading the web',
    },
  },
};
