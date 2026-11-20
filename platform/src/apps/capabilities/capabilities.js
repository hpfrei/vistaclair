// Capability: capabilities — feature detection — the platform surface available to this app, on both surfaces
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.
//
// Open-world: `has`/`list` report the PLATFORM's surface for the app's profile
// (everything is granted; manifest declarations are advertisements). `legacy`
// = the manifest has no `capabilities` object, i.e. advertises nothing.

module.exports = {
  key: 'capabilities',
  title: 'Capabilities, access levels, and full-screen mode',
  headings: ['Capabilities, access levels, and full-screen mode'],
  core: true,
  gated: false,
  cost: 'free',
  audiences: ['owner', 'user', 'anonymous'],
  methods: ['capabilities.list'],
  ctx: ['capabilities'],
  keywords: /\b(feature[- ]detect|which capabilities|granted capabilities|advertised capabilities)\b/i,
  summary: '`ctx.capabilities.has/list` — feature-detect this platform',

  buildCtx(app) {
    return { capabilities: { has: (key) => app.caps.has(key), list: () => app.caps.list() } };
  },

  bridge: {
    'capabilities.list': async (app) => ({ capabilities: app.caps.list(), legacy: app.legacy }),
  },

  // ---- Horst facet: read-only tools ------------------------------------------
  horst: {
    lane: { direct: { 'capabilities.list': 'capabilities_list' } },
    tools: [
      {
        def: {
          name: 'capabilities_list',
          description: 'The platform\'s capability registry: every capability key with title, one-line summary, whether it is part of the platform baseline (`core`), plus which installed apps advertise it in their manifest (an advertisement documents use — every app can call everything). Read-only.',
          inputSchema: { type: 'object', properties: {
            key: { type: 'string', description: 'One capability key for its full detail (bridge methods, ctx members, Horst senses/tools/kinds).' },
          } },
        },
        handler: async (args) => {
          const registry = require('../capabilities');
          const appManager = require('../app-manager');
          const { textResult } = require('../horst-facet');
          const apps = appManager.list().map((a) => ({ name: a.name, caps: a.capabilities && typeof a.capabilities === 'object' ? a.capabilities : null }));
          const advertisedBy = (cap) => apps.filter((a) => a.caps && registry.declarationSatisfies(a.caps, cap.key)).map((a) => a.name);
          if (args.key) {
            const cap = registry.get(args.key);
            if (!cap) return textResult(`Unknown capability "${args.key}".`);
            return textResult({
              key: cap.key, title: cap.title, summary: cap.summary, core: cap.core,
              methods: cap.methods, ctx: cap.ctx, visibility: cap.visibility,
              horst: { senses: cap.horst.senses.map((s) => s.kind), tools: cap.horst.tools.map((t) => t.def.name), kinds: Object.keys(cap.horst.kinds) },
              advertisedBy: advertisedBy(cap),
            });
          }
          const rows = registry.all().map((cap) => ({ key: cap.key, title: cap.title, core: cap.core, summary: cap.summary.slice(0, 140), advertisedBy: advertisedBy(cap) }));
          return textResult(rows);
        },
      },
    ],
  },
};
