// Capability: artifacts — `ctx.artifacts.put/get/import/pin/unpin/list` — files handed out by reference
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.

// The tool call a put runs inside (app-tools' AsyncLocalStorage), feature-
// probed: without it the caller is simply not granted read automatically.
function currentCall() {
  try {
    const appTools = require('../app-tools');
    return typeof appTools.currentCall === 'function' ? appTools.currentCall() || null : null;
  } catch { return null; }
}

module.exports = {
  key: 'artifacts',
  title: 'Artifacts',
  core: true,
  gated: true,
  methods: ['artifacts.get', 'artifacts.list'],
  prefixes: ['artifacts.'],
  ctx: ['artifacts'],
  keywords: /\b(artifacts?|vc-artifact|resource_link|return (a |the )?(file|model|video|glb|pdf))\b/i,
  summary: '`vc-artifact://` file refs for tool results',
  migration: 'A tool result that returns an absolute file path (or base64 of a large file) → `ctx.artifacts.put(file)` and return its `.link`.',
  visibility: { standalone: false },

  buildCtx(app) {
    const store = () => require('../app-artifacts');
    const name = app.name;
    const self = { type: 'app', app: name };
    const readable = (ref) => (store().canRead(self, ref) ? store().get(ref) : null);
    return {
      artifacts: {
        put: (pathOrBuffer, opts) => store().put(name, pathOrBuffer, opts || {}, currentCall()),
        get: (ref) => readable(ref),
        import: (ref, destRel) => store().import(name, ref, destRel, self),
        pin: (ref, reason) => {
          if (!readable(ref)) throw new Error(`No read access to artifact ${ref}`);
          return store().pin(ref, self, reason);
        },
        unpin: (ref) => store().unpin(ref, self),
        list: (filter) => store().list({ ...(filter || {}), principal: self }),
      },
    };
  },

  bridge: {
    'artifacts.get': async (app, params) => {
      const store = require('../app-artifacts');
      if (!params.ref) throw new Error('ref required');
      const self = { type: 'app', app: app.name };
      return store.canRead(self, params.ref) ? store.get(params.ref) : null;
    },
    'artifacts.list': async (app, params) => {
      const { app: only, producer, pinned } = params || {};
      return require('../app-artifacts').list({ app: only, producer, pinned, principal: { type: 'app', app: app.name } });
    },
  },

  horst: {
    lane: {
      direct: {
        'artifacts.get': { deferred: 'uris reach Horst in messages and tool results and go straight into tools; no lookup need yet' },
        'artifacts.list': { deferred: 'uris reach Horst in messages and tool results and go straight into tools; no lookup need yet' },
      },
    },
  },
};
