// Capability: fs — `fs.read/write/list/exists` — app-directory-scoped file access
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.

const fs = require('fs');
const path = require('path');

module.exports = {
  key: 'fs',
  title: 'File System',
  core: true,
  gated: true,
  methods: ['fs.read', 'fs.write', 'fs.list', 'fs.exists'],
  prefixes: ['fs.'],
  keywords: /\b(read|write) (a )?file|filesystem\b/i,
  summary: '`fs.read/write/list/exists` — app-directory-scoped file access',

  bridge: {
    'fs.read': async (app, params) => {
      const filePath = app.resolvePath(params.path);
      return fs.readFileSync(filePath, 'utf-8');
    },
    'fs.write': async (app, params) => {
      const filePath = app.resolvePath(params.path);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, params.content, 'utf-8');
      return true;
    },
    'fs.list': async (app, params) => {
      const dirPath = app.resolvePath(params.dir || '.');
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      return entries.map(e => ({
        name: e.name,
        isDir: e.isDirectory(),
      }));
    },
    'fs.exists': async (app, params) => {
      const filePath = app.resolvePath(params.path);
      return fs.existsSync(filePath);
    },
  },

  horst: {
    lane: {
      default: 'never',
      why: 'an app\'s own sandbox files; Horst reads app directories through file_list / file_stat (files)',
    },
  },
};
