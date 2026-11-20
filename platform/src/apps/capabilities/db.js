// Capability: db — `db.query`, `db.status`, `ctx.dbQuery` — per-app MariaDB
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and docs/capabilities.md.

module.exports = {
  key: 'db',
  title: 'Database (Platform MariaDB)',
  core: true,
  gated: true,
  methods: ['db.query', 'db.status', 'db.provision'],
  prefixes: ['db.'],
  ctx: ['getDb', 'dbName', 'dbQuery', 'provisionDb', 'ensureSchema'],
  keywords: /\b(database|sql|table|mariadb|mysql|schema)\b/i,
  summary: '`db.query`, `db.status`, `ctx.dbQuery` — per-app MariaDB',
  migration: 'Growing data in `state.*` (arrays/collections) → DB tables via `ctx.dbQuery`. Never install `mariadb`/`mysql2`.',

  buildCtx(app) {
    const appDb = require('../app-db');
    const name = app.name;
    const members = {
      getDb: () => appDb.getPool(),
      get dbName() { return appDb.getAppDb(name)?.database || null; },
      dbQuery: (sql, params) => appDb.query(sql, params, appDb.getAppDb(name)?.database),
      async provisionDb() {
        if (appDb.getAppDb(name)) return appDb.getAppDb(name);
        if (!appDb.getPool()) throw new Error('Database not connected. Configure in Apps > Setup.');
        return appDb.provisionApp(name);
      },
      // Provision + run DDL serially. Replaces the provisionDb/CREATE TABLE IIFE
      // boilerplate: const ready = ctx.ensureSchema([...]); await ready in routes
      // (or router.use(async (req,res,next)=>{ await ready; next(); })).
      async ensureSchema(statements) {
        await members.provisionDb();
        for (const sql of statements || []) {
          await members.dbQuery(sql);
        }
      },
    };
    return members;
  },

  bridge: {
    'db.query': async (app, params) => {
      const { sql, params: qParams, database } = params;
      if (!sql) throw new Error('No SQL provided');
      return require('../app-db').query(sql, qParams, database);
    },
    'db.status': async () => require('../app-db').status(),
    'db.provision': async (app) => {
      const appDb = require('../app-db');
      if (!appDb.getPool()) throw new Error('Database not connected. Configure in Apps > Setup.');
      const existing = appDb.getAppDb(app.name);
      if (existing) return existing;
      try { return await appDb.provisionApp(app.name); }
      catch (err) { throw new Error(appDb.friendlyDbError(err)); }
    },
  },

  // ---- Horst facet: senses, read-only tools ----------------------------------
  horst: {
    lane: {
      direct: { 'db.status': 'db_status' },
      never: ['db.query', 'db.provision'],
      why: 'an app\'s own database: Horst sees its state, never its rows or schema',
    },
    brief: 'db: the platform MariaDB (per-app databases; Horst\'s memory and the mail store live there too)',
    senses: [
      { kind: 'db:down', description: 'The platform database is not reachable (boot connect gave up, or it disconnected)', defaultPolicy: 'notify' },
      { kind: 'db:up', description: 'The platform database (re)connected', defaultPolicy: 'agenda' },
    ],
    wire({ publish }) {
      const appDb = require('../app-db');
      let last = null; // 'up' | 'down' — publish transitions only
      const emit = (ev) => {
        const state = ev.up ? 'up' : 'down';
        if (state === last) return;
        last = state;
        if (ev.up) publish('db:up', { host: ev.host, port: ev.port }, { dedupeKey: 'db', summary: `Database connected (${ev.host}:${ev.port})` });
        else publish('db:down', { host: ev.host, port: ev.port, error: ev.error || null }, { dedupeKey: 'db', summary: `Database down: ${ev.error || 'not connected'}`.slice(0, 120) });
      };
      const off = appDb.onStatus(emit);
      // The boot auto-connect may already have settled before Horst wired up:
      // report the current state once it has (ready() resolves either way).
      Promise.resolve(appDb.ready && appDb.ready()).then(() => {
        if (!appDb.isConfigured()) return;
        const cfg = appDb.getConfig() || {};
        if (appDb.getPool()) { if (last === null) last = 'up'; }
        else emit({ up: false, host: cfg.host || null, port: cfg.port || null, error: 'not connected' });
      }).catch(() => {});
      return off;
    },
    tools: [
      {
        def: {
          name: 'db_status',
          description: 'Platform database state: configured, connected, host/port, and which apps have a provisioned database. Never returns credentials. Read-only.',
          inputSchema: { type: 'object', properties: {} },
        },
        handler: async () => {
          const appDb = require('../app-db');
          const { textResult } = require('../horst-facet');
          const s = appDb.status();
          const apps = Object.entries(appDb.getProvisionedApps() || {}).map(([app, info]) => ({ app, database: info?.database || null }));
          return textResult({ configured: appDb.isConfigured(), connected: !!s.connected, host: s.config?.host || null, port: s.config?.port || null, provisionedApps: apps });
        },
      },
    ],
  },
};
