// Capability: browser — `browser.screenshot` — headless page render
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.

module.exports = {
  key: 'browser',
  title: 'Headless Render',
  core: false,
  gated: true,
  methods: ['browser.screenshot'],
  prefixes: ['browser.'],
  ctx: ['browser'],
  keywords: /\b(screenshot|headless|render (the )?page|browser\.|puppeteer|playwright)\b/i,
  summary: '`browser.screenshot` — headless page render',

  buildCtx(app) {
    // Hermetic headless render: HTML (+ this app's own on-disk assets) → PNG
    // Buffer, no network egress. rootDir is pinned to the app dir server-side.
    // See _api-reference.md "Headless Render".
    return {
      browser: {
        screenshot: (opts) => require('../app-browser').screenshot({ ...(opts || {}), rootDir: app.dir, appName: app.name }),
      },
    };
  },

  bridge: {
    // Hermetic render: the app supplies HTML; the platform pins rootDir to
    // the app's OWN dir (any caller-supplied rootDir is ignored), so the
    // renderer can only read files inside this app's sandbox.
    'browser.screenshot': async (app, params) => {
      const buf = await require('../app-browser').screenshot({ ...(params || {}), rootDir: app.dir, appName: app.name });
      return { image: buf.toString('base64'), mimeType: 'image/png' };
    },
  },

  // ---- Horst facet: render HTML Horst writes, direct ---------------------------
  // The same hermetic renderer, rooted at an empty scratch dir: no network, no
  // files, so the page is exactly the HTML given.
  horst: {
    brief: 'browser: render HTML you write (a table, a card, a chart) to a PNG picture (page_render) — no network, no files',
    lane: { direct: { 'browser.screenshot': 'page_render' } },
    tools: [
      {
        def: {
          name: 'page_render',
          description: 'Render an HTML document you write (inline CSS/SVG/JS only — the renderer has no network and no files) to a PNG picture. Free; no outward act. Returns the picture as a vc-artifact resource_link — the owner sees it in chat and on Telegram.',
          inputSchema: {
            type: 'object',
            properties: {
              html: { type: 'string' },
              width: { type: 'number', description: 'viewport px, default 1200' },
              height: { type: 'number', description: 'viewport px, default 630' },
              fullPage: { type: 'boolean' },
            },
            required: ['html'],
          },
        },
        handler: async (args, caller) => {
          const fs = require('fs');
          const os = require('os');
          const path = require('path');
          const f = require('../horst-facet');
          const html = String(f.req(args || {}, 'html'));
          const root = fs.mkdtempSync(path.join(os.tmpdir(), 'horst-render-'));
          try {
            const buf = await require('../app-browser').screenshot({
              html, rootDir: root, appName: 'platform',
              width: Number(args.width) || undefined, height: Number(args.height) || undefined, fullPage: !!args.fullPage,
            });
            const link = await f.storeArtifact(buf, { mime: 'image/png', tool: 'page_render', caller });
            return { content: [{ type: 'text', text: `Rendered → ${link.uri}` }, link] };
          } finally { fs.rmSync(root, { recursive: true, force: true }); }
        },
      },
    ],
  },
};
