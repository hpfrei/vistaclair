// Capability: secrets — `secrets.get/set` — encrypted at rest
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and docs/capabilities.md.
//
// NO horst facet, deliberately (phase 6): Horst never reads secrets — no
// sense, no tool, no kind. Secrets writes are owner-click-only by doctrine
// (see test/horst-completeness.test.js's allowlist).

module.exports = {
  key: 'secrets',
  title: 'Encrypted Secrets',
  core: true,
  gated: true,
  methods: ['secrets.get', 'secrets.set'],
  prefixes: ['secrets.'],
  keywords: /\b(api key|token|credential|secret)\b/i,
  summary: '`secrets.get/set` — encrypted at rest',

  bridge: {
    'secrets.get': async (app, params) => require('../app-secrets').get(app.dir, params.key),
    'secrets.set': async (app, params) => require('../app-secrets').set(app.dir, params.key, params.value),
  },

  horst: {
    lane: {
      default: 'never',
      why: 'keys and tokens never enter a model context',
    },
  },
};
