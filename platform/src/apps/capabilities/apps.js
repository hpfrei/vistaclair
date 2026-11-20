// Capability: apps — `apps.access` / `ctx.apps.access(app)` — read-only lookup of another app's messaging front doors (Telegram bot username + deep link, WhatsApp number + wa.me link, public URL); never exposes tokens
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.

module.exports = {
  key: 'apps',
  title: 'Cross-App Access Lookup',
  core: false,
  gated: true,
  methods: ['apps.access'],
  prefixes: ['apps.'],
  ctx: ['apps'],
  keywords: /\b(another app'?s bot|other apps?'? (bot|number|channel)|cross-app (bot|link|lookup)|showcase|deep ?link|t\.me|wa\.me|qr code)\b/i,
  summary: '`ctx.apps.access(app)` — another app\'s bot/number/URL front doors; never tokens',
  visibility: { standalone: false },
  revocable: true,

  buildCtx(app) {
    // Read-only cross-app lookup: which messaging front doors another app
    // exposes (Telegram bot, WhatsApp number, public URL). Owner tier — removed
    // from the public and standalone ctx like the other cross-app surfaces.
    return { apps: { access: (targetApp) => require('../app-manager').appAccess(targetApp) } };
  },

  bridge: {
    // Read-only cross-app messaging-channel lookup — identity fields only
    // (never tokens), answered from the binding stores so it works while the
    // target app is stopped. Owner tier: the Bridge is relayed over the
    // owner's WS, and the ctx twin is absent from public/standalone ctx.
    'apps.access': async (app, params) => {
      if (!params.app) throw new Error('app required');
      return require('../app-manager').appAccess(params.app);
    },
  },

  // ---- Horst facet: read-only tools, approval-gated kinds --------------------
  horst: {
    lane: {
      direct: { 'apps.access': { deferred: 'an app\'s front doors (bot, number, URL); apps_list / app_status cover Horst\'s view' } },
    },
    brief: 'apps: the installed apps — list, status, log tail, start/stop/restart (approval-gated) and lifecycle changes (create/delete/rename/setConfig — always human-approved)',
    tools: [
      {
        def: {
          name: 'apps_list',
          description: 'Installed apps with running state, runtime placement (in-process/own-process/standalone), health, attributed runtime error count, autostart and whether the app contributes to the platform. Read-only.',
          inputSchema: { type: 'object', properties: {
            running: { type: 'boolean', description: 'Only running apps.' },
            withErrors: { type: 'boolean', description: 'Only apps with recorded runtime errors.' },
          } },
        },
        handler: async (args) => {
          const appManager = require('../app-manager');
          const guard = require('../app-guard');
          const { textResult } = require('../horst-facet');
          let rows = appManager.list().map((a) => {
            const e = guard.status(a.name);
            return {
              name: a.name, running: !!a.running, mode: a.standalone ? 'standalone' : appManager.appRuntime(a.name),
              health: appManager.getAppStatus(a.name).health, errors: e.count, crashloop: e.crashloop || undefined,
              autostart: !!a.autostart, contributes: appManager.contributes(a.name), description: (a.description || '').slice(0, 120) || undefined,
            };
          });
          if (args.running) rows = rows.filter((r) => r.running);
          if (args.withErrors) rows = rows.filter((r) => r.errors > 0);
          return textResult(rows.length ? rows : 'No apps installed.');
        },
      },
      {
        def: {
          name: 'app_status',
          description: 'One app\'s status: health, database state, dependencies, git status, and the attributed runtime errors (count, last error, five most recent with surface and time, crash-loop flag). Read-only.',
          inputSchema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] },
        },
        handler: async (args) => {
          const appManager = require('../app-manager');
          const { textResult } = require('../horst-facet');
          if (!args.app || !appManager.readManifest(args.app)) return textResult(`Unknown app "${args.app}".`);
          const status = appManager.getAppStatus(args.app);
          let git = null;
          try { git = await appManager.getGitStatus(args.app); } catch {}
          return textResult({ app: args.app, mode: appManager.appRuntime(args.app), ...status, git: git || undefined });
        },
      },
      {
        def: {
          name: 'app_log',
          description: 'Tail of an app\'s server log (spawned/process apps) plus the platform\'s recent attributed runtime errors for it (mounted apps). Lines are capped at 200. The log is raw app output and may contain whatever the app printed, including secrets — quote it carefully. Read-only.',
          inputSchema: { type: 'object', properties: {
            app: { type: 'string' },
            lines: { type: 'number', description: 'How many trailing log lines (default 60, max 200).' },
          }, required: ['app'] },
        },
        handler: async (args) => {
          const appManager = require('../app-manager');
          const guard = require('../app-guard');
          const { textResult, limitOf } = require('../horst-facet');
          if (!args.app || !appManager.readManifest(args.app)) return textResult(`Unknown app "${args.app}".`);
          const n = limitOf(args.lines, 60, 200);
          const log = appManager.readLog(args.app);
          const tail = log ? log.split('\n').slice(-n).join('\n') : null;
          const errors = guard.recent(args.app, 20).map((e) => ({ at: new Date(e.at).toISOString(), surface: e.surface, error: e.error }));
          return textResult({ app: args.app, logTail: tail, recentErrors: errors });
        },
      },
    ],
    kinds: {
      'app.restart': {
        identity: null, // a repeat run is a legitimate retry, never a duplicate
        label: 'Restart app',
        about: 'Restarts an installed app on the platform.',
        ceiling: 'auto+notify',
        // Converges: an app restarted twice is simply running. The crash-loop
        // rail above still bounds how often this can fire, so an app that keeps
        // dying escalates to a human instead of restarting forever.
        defaultLevel: 'auto+notify',
        idempotent: true,
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'app');
          if (!require('../app-manager').readManifest(p.app)) throw new Error(`unknown app "${p.app}"`);
        },
        describe: (p) => `Restart app "${p.app}"`,
        execute: (p) => require('../app-manager').restartApp(p.app, require('../core-services').core.broadcaster),
      },

      'app.start': {
        identity: null, // a repeat run is a legitimate retry, never a duplicate
        label: 'Start app',
        about: 'Starts a stopped app.',
        ceiling: 'auto+notify',
        defaultLevel: 'propose',
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'app');
          if (!require('../app-manager').readManifest(p.app)) throw new Error(`unknown app "${p.app}"`);
        },
        describe: (p) => `Start app "${p.app}"`,
        execute: (p) => require('../app-manager').startApp(p.app, require('../core-services').core.broadcaster),
      },

      'app.stop': {
        identity: null, // a repeat run is a legitimate retry, never a duplicate
        label: 'Stop app',
        about: 'Stops a running app and ends the AI sessions and helper processes it launched.',
        ceiling: 'auto+notify',
        defaultLevel: 'propose',
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'app');
          if (!require('../app-manager').readManifest(p.app)) throw new Error(`unknown app "${p.app}"`);
        },
        describe: (p) => `Stop app "${p.app}"`,
        execute: (p) => require('../app-lifecycle').stopApp(p.app),
      },

      // ---- Lifecycle (phase 6): the same shared implementations the owner's
      // dashboard clicks run (app-lifecycle.js) — here proposal-gated, and
      // ceiling-PINNED to propose: creating, deleting, renaming or
      // reconfiguring an app changes the platform itself (setConfig includes
      // the public perimeter), so these always pass a human.
      'app.create': {
        identity: null, // each request is its own act, not a re-derivation
        label: 'Create app',
        about: 'Creates a new, empty app on the platform (code is built separately through a change session).',
        pinNote: 'App lifecycle changes the platform itself — always human-approved.',
        ceiling: 'propose',
        defaultLevel: 'propose',
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'name');
          if (require('../app-manager').readManifest(p.name)) throw new Error(`app "${p.name}" already exists`);
        },
        describe: (p) => `Create app "${p.name}"${p.description ? ` — ${String(p.description).slice(0, 80)}` : ''}`,
        execute(p) {
          const { name } = require('../app-lifecycle').createApp(p.name, p.description || '');
          return { ok: true, name, summary: `App "${name}" created` };
        },
      },

      'app.delete': {
        identity: null, // each request is its own act, not a re-derivation
        label: 'Delete app',
        about: 'Deletes an installed app: its code, data, cron jobs and CLI sessions.',
        pinNote: 'Deleting an app is destructive and irreversible — always human-approved.',
        ceiling: 'propose',
        defaultLevel: 'propose',
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'app');
          if (!require('../app-manager').readManifest(p.app)) throw new Error(`unknown app "${p.app}"`);
        },
        describe: (p) => `Delete app "${p.app}" (code, data, cron jobs and sessions)`,
        async execute(p) {
          await require('../app-lifecycle').deleteApp(p.app);
          return { ok: true, summary: `App "${p.app}" deleted` };
        },
      },

      'app.rename': {
        identity: null, // each request is its own act, not a re-derivation
        label: 'Rename app',
        about: 'Renames an installed app (directory, database user, bindings and cron ownership move with it).',
        pinNote: 'Renaming moves the app\'s identity across the platform (URLs, bindings, webhooks) — always human-approved.',
        ceiling: 'propose',
        defaultLevel: 'propose',
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'app'); req(p, 'newName');
          const appManager = require('../app-manager');
          if (!appManager.readManifest(p.app)) throw new Error(`unknown app "${p.app}"`);
          if (appManager.readManifest(p.newName)) throw new Error(`app "${p.newName}" already exists`);
        },
        describe: (p) => `Rename app "${p.app}" to "${p.newName}"`,
        async execute(p) {
          const r = await require('../app-lifecycle').renameApp(p.app, p.newName);
          return { ok: true, summary: `App "${r.oldName}" renamed to "${r.newName}"${(r.warnings || []).length ? ` — ${r.warnings.join('; ')}` : ''}` };
        },
      },

      'app.setConfig': {
        identity: null, // each request is its own act, not a re-derivation
        label: 'Change app config',
        about: 'Writes an app\'s config the way the App Config modal does: access level (private / users / open), login channels, sender address, licence, domain, description, autostart, full-screen presentation, platform contribution.',
        pinNote: 'Config includes the access level (who can reach the app without the owner login) — always human-approved.',
        ceiling: 'propose',
        defaultLevel: 'propose',
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'app');
          if (!require('../app-manager').readManifest(p.app)) throw new Error(`unknown app "${p.app}"`);
          if (!p.config || typeof p.config !== 'object' || Array.isArray(p.config)) throw new Error('payload requires config (an object)');
          const allowed = new Set(['display', 'description', 'autostart', 'domain', 'access', 'platformContribution', 'auth', 'senderEmail']);
          const keys = Object.keys(p.config);
          if (!keys.length) throw new Error('config changes nothing');
          for (const k of keys) if (!allowed.has(k)) throw new Error(`unknown config key "${k}" (allowed: ${[...allowed].join(', ')})`);
        },
        describe: (p) => `Change config of app "${p.app}": ${Object.keys(p.config || {}).join(', ')}`,
        execute(p) {
          require('../app-lifecycle').setAppConfig(p.app, p.config);
          return { ok: true, summary: `Config of "${p.app}" updated (${Object.keys(p.config || {}).join(', ')})` };
        },
      },
    },
  },
};
