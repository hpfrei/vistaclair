// Capability: sites — `ctx.sites` / Bridge `sites.*`: the app's own sites
// (manifest `sites`), each its own web-server process on its own port, a child
// of the dashboard (docs/sites.md). Start/stop/restart, live config, the
// handler's `site.call` endpoints (onCall), and content snapshots
// (publish / snapshots / rollback). Always scoped to the calling app.
//
// One file per capability: see src/apps/capabilities.js and docs/capabilities.md.

const path = require('path');

const engine = () => require('../sites');
const SITE_KINDS = ['site:status', 'site:crashed', 'site:published'];

function siteArg(p) {
  if (!p || typeof p.site !== 'string' || !p.site) throw new Error('site required');
  return p.site;
}

function validateKind(p) {
  const { req } = require('../horst-facet');
  req(p, 'app');
  req(p, 'site');
  if (!require('../app-manager').readManifest(p.app)) throw new Error(`unknown app "${p.app}"`);
  engine().effective(p.app, p.site); // throws for an undeclared or invalid site
}

module.exports = {
  key: 'sites',
  title: 'Sites (own web servers)',
  core: false,
  gated: true,
  methods: ['sites.list', 'sites.status', 'sites.start', 'sites.stop', 'sites.restart', 'sites.config', 'sites.publish', 'sites.snapshots', 'sites.rollback'],
  prefixes: ['sites.'],
  ctx: ['sites'],
  keywords: /\b(sites?|website|homepage|landing page|public web ?server|own port|static site|snapshots?|rollback)\b/i,
  summary: '`ctx.sites` — own web servers per app',
  visibility: { standalone: false },
  revocable: true,

  buildCtx(app) {
    const e = engine();
    const name = app.name;
    const resolveDir = (dir) => (path.isAbsolute(String(dir || '')) ? String(dir) : app.resolvePath(String(dir || '')));
    return {
      sites: {
        list: () => e.list(name),
        status: (site) => e.status(name, site),
        start: (site) => e.start(name, site),
        stop: (site) => e.stop(name, site),
        restart: (site) => e.restart(name, site),
        // config(site) reads, config(site, obj) replaces the live site.config (no restart)
        config: (site, obj) => (obj === undefined ? e.getConfig(name, site) : e.setConfig(name, site, obj)),
        onCall: (callName, fn) => e.onCall(name, callName, fn),
        publish: (site, dir, opts = {}) => e.publish(name, site, resolveDir(dir), opts),
        snapshots: (site) => e.snapshots(name, site),
        rollback: (site, id) => e.rollback(name, site, id),
      },
    };
  },

  bridge: {
    'sites.list': async (app) => engine().list(app.name),
    'sites.status': async (app, p) => engine().status(app.name, siteArg(p)),
    'sites.start': async (app, p) => engine().start(app.name, siteArg(p)),
    'sites.stop': async (app, p) => engine().stop(app.name, siteArg(p)),
    'sites.restart': async (app, p) => engine().restart(app.name, siteArg(p)),
    'sites.config': async (app, p) => (p.config === undefined ? engine().getConfig(app.name, siteArg(p)) : engine().setConfig(app.name, siteArg(p), p.config)),
    // From the iframe the source dir is a path inside the app's own directory.
    'sites.publish': async (app, p) => {
      if (typeof p.dir !== 'string' || !p.dir) throw new Error('dir required (a path inside the app)');
      return engine().publish(app.name, siteArg(p), app.resolvePath(p.dir), { note: p.note });
    },
    'sites.snapshots': async (app, p) => engine().snapshots(app.name, siteArg(p)),
    'sites.rollback': async (app, p) => engine().rollback(app.name, siteArg(p), p.id),
  },

  horst: {
    lane: {
      direct: { 'sites.list': 'sites_status', 'sites.status': 'sites_status', 'sites.snapshots': 'sites_status' },
      card: { 'sites.start': 'site.start', 'sites.stop': 'site.stop', 'sites.restart': 'site.restart' },
      never: ['sites.config', 'sites.publish', 'sites.rollback'],
      why: 'a site\'s config and content are the app\'s own (its code publishes them); the owner rolls back in the Sites tab',
    },
    brief: 'sites: apps\' own web-server processes (public sites on their own ports) — state, port, crashes, snapshots (sites_status); start/stop/restart are kinds',
    senses: [
      { kind: 'site:crashed', description: 'A site process crashed and is being restarted with backoff', defaultPolicy: 'notify' },
      { kind: 'site:published', description: 'A site switched its served snapshot (publish or rollback)', defaultPolicy: 'ignore' },
      { kind: 'site:status', description: 'A site changed state (starting, running, stopped, error, backoff)', defaultPolicy: 'ignore' },
    ],
    wire({ publish }) {
      return engine().onEvent(({ kind, app, site, data }) => {
        if (!SITE_KINDS.includes(kind)) return;
        const st = data.status || {};
        const payload = { app, site, state: st.state, port: st.port, crashCount: st.crashCount, error: data.error || undefined, snapshot: data.id || undefined };
        if (kind === 'site:crashed') publish('site:crashed', payload, { dedupeKey: `${app}/${site}`, summary: `Site ${app}/${site} crashed: ${String(data.error || '').slice(0, 80)}` });
        else if (kind === 'site:published') publish('site:published', payload, { summary: `Site ${app}/${site} ${data.rollback ? 'rolled back to' : 'published'} ${data.id}` });
        else publish('site:status', payload, { summary: `Site ${app}/${site}: ${st.state}` });
      });
    },
    tools: [
      {
        def: {
          name: 'sites_status',
          description: 'Sites of one app or of every app: state, port, bind, uptime, memory, requests/s, last error, crash count and history, fenced/unfenced, and the content snapshots. Read-only.',
          inputSchema: { type: 'object', properties: {
            app: { type: 'string', description: 'One app (omit for every app that declares sites).' },
            site: { type: 'string', description: 'One site of that app: adds its crash history and snapshots.' },
          } },
        },
        handler: async (args) => {
          const { textResult } = require('../horst-facet');
          const e = engine();
          if (args.app && args.site) {
            return textResult({ status: e.status(args.app, args.site), crashes: e.crashes(args.app, args.site).slice(0, 10), snapshots: e.snapshots(args.app, args.site) });
          }
          const appManager = require('../app-manager');
          const apps = args.app ? [args.app] : appManager.list().map(a => a.name).filter(n => Object.keys(e.declared(n).sites).length);
          const rows = apps.flatMap(a => e.list(a));
          return textResult(rows.length ? rows : 'No app declares a site.');
        },
      },
    ],
    kinds: {
      'site.restart': {
        identity: null, // a repeat run is a legitimate retry, never a duplicate
        label: 'Restart site',
        about: 'Restarts one site process of an app (its web server on its own port).',
        ceiling: 'auto+notify',
        // Converges: a site restarted twice is simply running.
        defaultLevel: 'auto+notify',
        idempotent: true,
        validate: validateKind,
        describe: (p) => `Restart site "${p.app}/${p.site}"`,
        execute: (p) => engine().restart(p.app, p.site),
      },
      'site.start': {
        identity: null,
        label: 'Start site',
        about: 'Starts a stopped site process of an app.',
        ceiling: 'auto+notify',
        defaultLevel: 'propose',
        validate: validateKind,
        describe: (p) => `Start site "${p.app}/${p.site}"`,
        execute: (p) => engine().start(p.app, p.site),
      },
      'site.stop': {
        identity: null,
        label: 'Stop site',
        about: 'Stops a site process of an app; its public web server goes offline.',
        ceiling: 'auto+notify',
        defaultLevel: 'propose',
        validate: validateKind,
        describe: (p) => `Stop site "${p.app}/${p.site}"`,
        execute: (p) => engine().stop(p.app, p.site),
      },
    },
  },
};
