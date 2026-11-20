// Capability: settings — `settings.get/all` — user-facing configuration
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and docs/capabilities.md.

module.exports = {
  key: 'settings',
  title: 'App Settings',
  core: true,
  gated: true,
  methods: ['settings.get', 'settings.set', 'settings.all'],
  prefixes: ['settings.'],
  ctx: ['settings'],
  keywords: /\b(settings|user config|configuration panel)\b/i,
  summary: '`settings.get/all` — user configuration (`persist-key`)',
  migration: 'Hand-rolled GET/POST `/api/config` routes backed by a config file or state keys → `settings.get/set/all` / `ctx.settings`.',

  buildCtx(app) {
    const settings = require('../app-settings');
    const { name, dir } = app;
    // Persistent app settings (.settings.json, atomic + mutexed). Mirrors the
    // settings.* bridge methods — simple apps need no config endpoints at all.
    return {
      settings: {
        get: (key) => settings.settingsGet(name, dir, key),
        set: (keyOrObj, value) => settings.settingsSet(name, dir, keyOrObj, value),
        all: (defaults) => settings.settingsAll(name, dir, defaults),
      },
    };
  },

  bridge: {
    'settings.get': (app, params) => require('../app-settings').settingsGet(app.name, app.dir, params?.key),
    'settings.all': (app, params) => require('../app-settings').settingsAll(app.name, app.dir, params?.defaults),
    'settings.set': async (app, params) => {
      const keyOrObj = params?.values && typeof params.values === 'object' ? params.values : params?.key;
      if (keyOrObj == null) throw new Error('key or values required');
      return require('../app-settings').settingsSet(app.name, app.dir, keyOrObj, params?.value);
    },
  },

  // ---- Horst facet: read-only visibility (phase 6) ---------------------------
  horst: {
    lane: {
      direct: { 'settings.get': 'settings_get', 'settings.all': 'settings_get' },
      never: ['settings.set'],
      why: 'an app\'s own settings: read to diagnose; what Horst may change is a configuration (config.set)',
    },
    brief: 'settings: per-app user-facing settings (read-only view)',
    tools: [
      {
        def: {
          name: 'settings_get',
          description: 'An app\'s persisted settings (.settings.json) — one key or all of them. User-facing configuration, not secrets. Read-only.',
          inputSchema: { type: 'object', properties: {
            app: { type: 'string' },
            key: { type: 'string', description: 'One setting key (omit for all).' },
          }, required: ['app'] },
        },
        handler: async (args) => {
          const path = require('path');
          const appManager = require('../app-manager');
          const settings = require('../app-settings');
          const { textResult } = require('../horst-facet');
          if (!args.app || !appManager.readManifest(args.app)) return textResult(`Unknown app "${args.app}".`);
          const dir = path.join(appManager.APPS_DIR, args.app);
          const value = args.key ? settings.settingsGet(args.app, dir, args.key) : settings.settingsAll(args.app, dir);
          return textResult({ app: args.app, key: args.key || undefined, value: value === undefined ? null : value });
        },
      },
    ],
  },
};
