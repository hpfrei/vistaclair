// Capability: dialogs — platform overlay dialogs (runtime globals only; rendered by the dashboard parent window)
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.

module.exports = {
  key: 'dialogs',
  title: 'Dialogs & Modals',
  core: true,
  gated: false,
  methods: [],
  runtime: ['showConfirm', 'showModal'],
  keywords: /\b(modal|dialog|confirm|prompt the user)\b/i,
  summary: '`showConfirm`, `showModal` (host overlays) and `<vc-dialog>` (in-iframe)',
  migration: 'Custom modal/backdrop markup and `window.confirm`/`window.prompt` → `showConfirm()`/`showModal()`, or `<vc-dialog>` when the dialog must host `vc-*` components or voice input.',

  horst: {
    lane: { default: 'never', why: 'iframe UI' },
  },
};
