// Capability: cli — app CLI sessions (dispatched by the WS handler in src/apps/index.js, not the bridge)
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.

module.exports = {
  key: 'cli',
  title: 'CLI Sessions',
  core: true,
  gated: false,
  external: true,
  methods: ['cli.edit', 'cli.interrupt', 'cli.workspace', 'cli.workspaces'],
  keywords: /\b(claude code session|cli session|agentic edit|workspace session)\b/i,
  summary: '`cli.edit`, `cli.workspace` — Claude Code in the app or workspaces',

  horst: {
    lane: {
      default: 'never',
      why: 'Claude Code sessions in an app or workspace — deferred by the owner; the chat has no shell',
    },
  },
};
