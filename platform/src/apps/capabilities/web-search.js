// Capability: web-search — `ai.webSearch` — live web/news/video search
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and docs/capabilities.md.

module.exports = {
  key: 'web-search',
  title: 'Web Search',
  core: false,
  gated: true,
  cost: 'metered',
  revocable: true,
  audiences: ['owner', 'user'],
  spend: { service: 'web-search', units: { 'ai.webSearch': 'request' } },
  methods: ['ai.webSearch'],
  impliedBy: ['ai'],
  runtime: ['webSearch'],
  ctx: ['webSearch'],
  keywords: /\b(web search|search the web|internet search|search online|brave search|search results|news search|look(ing)? up online)\b/i,
  summary: '`ai.webSearch` — live web/news/video search via Brave Search',
  migration: 'A search API called via `http.fetch` with an app-held key → `ai.webSearch`.',

  buildCtx(app) {
    // Brave web search. Key comes from the platform secrets store
    // ('brave-search', set in Apps > AI Config). See _api-reference.md "Web Search".
    return { webSearch: (params) => require('../web-search').aiWebSearch(app.name, params) };
  },

  bridge: {
    'ai.webSearch': (app, params) => require('../web-search').aiWebSearch(app.name, params),
  },

  horst: {
    lane: {
      direct: { 'ai.webSearch': { deferred: 'the chat runs with the model\'s own WebSearch / WebFetch' } },
    },
  },
};
