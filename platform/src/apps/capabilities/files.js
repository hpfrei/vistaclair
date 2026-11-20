// Capability: files — `ctx.files.saveBase64/serve` — uploads and range-served downloads
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.

module.exports = {
  key: 'files',
  title: 'Files & Uploads',
  core: true,
  gated: false,
  methods: [],
  ctx: ['files'],
  keywords: /\b(upload|download|serve a file|attachment)\b/i,
  summary: '`ctx.files.saveBase64/serve` — uploads and range-served downloads',
  migration: 'Base64-decode + `fs.write` upload handlers and manual Range-header streaming → `ctx.files.saveBase64()` / `ctx.files.serve()`.',

  buildCtx(app) {
    const files = require('../app-files');
    const dir = app.dir;
    // Binary uploads/downloads without hand-rolled base64 plumbing.
    return {
      files: {
        saveBase64: (data, opts) => files.saveBase64File(dir, data, opts),
        serve: (res, filePath, opts) => files.serveFile(res, filePath, opts),
      },
    };
  },

  // ---- Horst facet: read-only visibility into app files (phase 6) -----------
  horst: {
    lane: {
      direct: { files: ['file_list', 'file_stat'] },
      why: 'ctx.files saves and serves an app\'s uploads; Horst\'s view of app directories is list and stat',
    },
    brief: 'files: app directories — list files, stat one (read-only; content edits go through change sessions)',
    tools: [
      {
        def: {
          name: 'file_list',
          description: 'List files under an app\'s directory (path, size, mtime), recursively. node_modules and .git are skipped; capped at 200 entries. Read-only.',
          inputSchema: { type: 'object', properties: {
            app: { type: 'string' },
            subdir: { type: 'string', description: 'Restrict to a subdirectory (e.g. ".data" or "public").' },
          }, required: ['app'] },
        },
        handler: async (args) => {
          const fs = require('fs');
          const path = require('path');
          const appManager = require('../app-manager');
          const { safeJoin } = require('../../utils');
          const { textResult } = require('../horst-facet');
          if (!args.app || !appManager.readManifest(args.app)) return textResult(`Unknown app "${args.app}".`);
          const appDir = path.join(appManager.APPS_DIR, args.app);
          const base = args.subdir ? safeJoin(appDir, String(args.subdir)) : appDir;
          const rows = [];
          const SKIP = new Set(['node_modules', '.git']);
          const walk = (d) => {
            if (rows.length >= 200) return;
            let entries = [];
            try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
              if (rows.length >= 200) return;
              if (SKIP.has(e.name)) continue;
              const full = path.join(d, e.name);
              if (e.isDirectory()) { walk(full); continue; }
              try {
                const st = fs.statSync(full);
                rows.push({ path: path.relative(appDir, full), size: st.size, mtime: new Date(st.mtimeMs).toISOString() });
              } catch {}
            }
          };
          walk(base);
          return textResult(rows.length ? { app: args.app, files: rows, truncated: rows.length >= 200 || undefined } : 'No files.');
        },
      },
      {
        def: {
          name: 'file_stat',
          description: 'Stat one path inside an app\'s directory: whether it exists, type (file/directory), size and mtime. Read-only.',
          inputSchema: { type: 'object', properties: {
            app: { type: 'string' },
            path: { type: 'string', description: 'App-relative path, e.g. "APP.md" or ".data/jobs.json".' },
          }, required: ['app', 'path'] },
        },
        handler: async (args) => {
          const fs = require('fs');
          const path = require('path');
          const appManager = require('../app-manager');
          const { safeJoin } = require('../../utils');
          const { textResult } = require('../horst-facet');
          if (!args.app || !appManager.readManifest(args.app)) return textResult(`Unknown app "${args.app}".`);
          const full = safeJoin(path.join(appManager.APPS_DIR, args.app), String(args.path || ''));
          let st = null;
          try { st = fs.statSync(full); } catch {}
          if (!st) return textResult({ app: args.app, path: args.path, exists: false });
          return textResult({
            app: args.app, path: args.path, exists: true,
            type: st.isDirectory() ? 'directory' : 'file',
            size: st.size, mtime: new Date(st.mtimeMs).toISOString(),
          });
        },
      },
    ],
  },
};
