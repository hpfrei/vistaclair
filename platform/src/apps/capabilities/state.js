// Capability: state — `state.get/set` — small iframe-only persisted preferences
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.

module.exports = {
  key: 'state',
  title: 'App State',
  core: true,
  gated: true,
  methods: ['state.get', 'state.set', 'state.delete', 'state.clear'],
  prefixes: ['state.'],
  keywords: /\b(remember|persist(ed)? (a )?(setting|preference))\b/i,
  summary: '`state.get/set` — small iframe-only preferences; not readable from routes.js',

  bridge: {
    'state.get': (app, params) => require('../app-state').get(app.name, app.dir, params.key),
    'state.set': (app, params) => require('../app-state').set(app.name, app.dir, params.key, params.value),
    'state.delete': (app, params) => require('../app-state').delete(app.name, app.dir, params.key),
    'state.clear': (app) => require('../app-state').clear(app.name, app.dir),
  },

  // ---- Horst facet: read-only visibility (phase 6) ---------------------------
  horst: {
    lane: {
      direct: { 'state.get': 'state_get' },
      never: ['state.set', 'state.delete', 'state.clear'],
      why: 'an app\'s own store: Horst may read a key to diagnose, never write it',
    },
    brief: 'state: small persisted per-app preferences (read-only view)',
    tools: [
      {
        def: {
          name: 'state_get',
          description: 'An app\'s persisted state (.state.json) — one key\'s value. Small UI preferences, not secrets. Values are capped at 2000 chars in the output. Read-only.',
          inputSchema: { type: 'object', properties: {
            app: { type: 'string' },
            key: { type: 'string' },
          }, required: ['app', 'key'] },
        },
        handler: async (args) => {
          const path = require('path');
          const appManager = require('../app-manager');
          const { textResult } = require('../horst-facet');
          if (!args.app || !appManager.readManifest(args.app)) return textResult(`Unknown app "${args.app}".`);
          const value = require('../app-state').get(args.app, path.join(appManager.APPS_DIR, args.app), args.key);
          let rendered = value === undefined ? null : value;
          const asText = JSON.stringify(rendered);
          if (asText && asText.length > 2000) rendered = asText.slice(0, 2000) + '…(truncated)';
          return textResult({ app: args.app, key: args.key, value: rendered });
        },
      },
    ],
  },
};
