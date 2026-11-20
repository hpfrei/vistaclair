// Capability: ui — shared frontend helpers (runtime globals only)
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.

module.exports = {
  key: 'ui',
  title: 'UI Components (`vc-*`)',
  core: true,
  gated: false,
  methods: [],
  runtime: ['escapeHtml', 'apiFetch', 'timeAgo', 'formatDate', 'formatTime', 'initTabs'],
  keywords: /\b(component|widget|input bar|chat log|progress bar|empty state)\b/i,
  summary: '`<vc-input-bar>`, `<vc-chat-log>`, `<vc-progress>`, `<vc-dialog>` and more',
  migration: 'Hand-rolled reusable widgets → the platform components: input+send bar → `<vc-input-bar>`; message thread → `<vc-chat-log>`; progress-bar div → `<vc-progress>`; empty-state block → `<vc-empty-state>`; model `<select>` from `ai.models` (and its `state.*`/`settings.*` glue) → `<vc-model-picker>` + `persist-key`; in-iframe modal panel with header/×/footer → `<vc-dialog>`; canvas image zoomer or `<img>`/`<video>` lightbox → `<vc-media-viewer>`; markdown/`innerHTML` of AI output → `<vc-markdown>`; RAM/CPU/swap/disk gauges → `<vc-sysmon>`. Also delete app-local `escapeHtml`/`timeAgo`/`formatDate`/fetch wrappers and spinner/skeleton CSS — the runtime and theme provide them.',

  horst: {
    lane: { default: 'never', why: 'iframe UI' },
  },
};
