// Capability: print — `ctx.print.status/pdf` — print a PDF on the printer the owner set up (CUPS), only when the owner allowed this app
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md. The engine is
// platform-print.js; the app's identity is app.name, never a parameter.
// Owner-side methods (printer list, settings, test page, job log) are the
// Setup → Drucker panel's (index.js `app:print:*`), not part of this surface.

module.exports = {
  key: 'print',
  title: 'Printing',
  core: false,
  gated: true,
  methods: ['print.status', 'print.pdf'],
  prefixes: ['print.'],
  ctx: ['print'],
  keywords: /\b(print(er|ing)?|drucken|drucker|cups|print (a |the )?(pdf|sheet|page)|worksheet|practice sheet)\b/i,
  summary: '`print.status/pdf` — print a PDF on the owner\'s printer',
  migration: 'App-private `lp` / `lpr` / `cupsd` shell-outs, `window.print()` buttons that need the browser\'s own printer, and e-mailing a PDF "to print" → `ctx.print.pdf({ pdf, title })` (gated by the owner in Setup → Drucker); show the button only when `status().available`.',
  visibility: { standalone: false },

  buildCtx(app) {
    const name = app.name;
    return {
      print: {
        status: () => require('../platform-print').status(name),
        pdf: (params) => require('../platform-print').printPdf(name, params || {}),
      },
    };
  },

  bridge: {
    'print.status': async (app) => require('../platform-print').status(app.name),
    'print.pdf': async (app, params) => require('../platform-print').printPdf(app.name, params || {}),
  },

  horst: {
    lane: {
      default: 'never',
      direct: { 'print.status': { deferred: 'the owner sees printer state in Setup → Drucker; no chat need yet' } },
      why: 'print.pdf puts paper out of the house: a physical, outward act with a per-app page cap the owner set. Horst does not print; the owner (or an app the owner allowed) does.',
    },
    brief: 'print: apps may print a PDF on the owner\'s CUPS printer when enabled in Setup → Drucker (Horst does not print)',
  },
};
