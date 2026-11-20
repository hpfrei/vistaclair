// Capability: cron — per-app `cron.schedule/cancel/list` — persistent recurring jobs
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and docs/capabilities.md.

module.exports = {
  key: 'cron',
  title: 'Scheduling (Server-Side Cron)',
  core: true,
  gated: true,
  methods: ['cron.schedule', 'cron.cancel', 'cron.list'],
  prefixes: ['cron.'],
  keywords: /\b(cron|recurring|every \d+ (second|minute|hour)|periodic)\b/i,
  summary: 'per-app `cron.schedule/cancel/list` — persistent recurring jobs',
  migration: 'Client-side polling (`setInterval` + `exec`/`fetch`) → `cron.schedule` + `Bridge.on(\'cron:result\')`.',

  bridge: {
    // Per-app cron delegates to the persisted platform-cron scheduler so jobs
    // survive server restarts. Results are emitted as cron:result bridge events
    // (broadcast + client-routed by appName) — same contract as before.
    'cron.schedule': async (app, params) => {
      const { schedule, command } = params;
      if (!schedule || !command) throw new Error('schedule and command are required');
      const platformCron = require('../platform-cron');
      const addResult = platformCron.addJob({
        name: `${app.name}: ${command}`.slice(0, 80),
        schedule,
        target: { type: 'shell', command },
        appName: app.name,
      });
      if (!addResult.ok) throw new Error(addResult.error);
      return { jobId: addResult.jobId };
    },
    'cron.cancel': async (app, params) => require('../platform-cron').removeJob(params.jobId).ok,
    'cron.list': async (app) => require('../platform-cron').listByApp(app.name),
  },

  // ---- Horst facet: senses, read-only tools, approval-gated kinds ------------
  horst: {
    lane: {
      direct: { 'cron.list': 'cron_list' },
      card: { 'cron.cancel': 'cron.set' },
      never: ['cron.schedule'],
      why: 'an app\'s cron.schedule fires the app\'s own callback; Horst adds platform jobs through cron.set (platform-cron)',
    },
    brief: 'cron: scheduled jobs (changes are approval-gated)',
    senses: [
      { kind: 'cron:failed', description: 'A scheduled job run failed', defaultPolicy: 'agenda' },
      { kind: 'cron:failing', description: 'A scheduled job failed three times in a row', defaultPolicy: 'notify' },
    ],
    wire({ publish }) {
      return require('../platform-cron').onResult((job, result, streak) => {
        if (result.ok) return;
        const payload = { jobId: job.id, name: job.name, app: job.appName || null, target: job.target?.type || null, error: result.error || 'Unknown error', streak };
        publish('cron:failed', payload, { dedupeKey: `cron:${job.id}`, summary: `Cron job failed: ${job.name} — ${payload.error}`.slice(0, 120) });
        if (streak === 3) publish('cron:failing', payload, { dedupeKey: `cron:${job.id}`, summary: `Cron job failing repeatedly: ${job.name}`.slice(0, 120) });
      });
    },
    tools: [
      {
        def: {
          name: 'cron_list',
          description: 'List the platform\'s scheduled jobs: id, name, schedule, target type, enabled, owning app, last run time, last error, run count. Read-only — changes go through the cron.set proposal.',
          inputSchema: { type: 'object', properties: {
            app: { type: 'string', description: 'Only jobs owned by this app.' },
            failing: { type: 'boolean', description: 'Only jobs whose last run failed.' },
          } },
        },
        handler: async (args) => {
          const { textResult } = require('../horst-facet');
          let rows = require('../platform-cron').list().map((j) => ({
            id: j.id, name: j.name, schedule: j.schedule, target: j.target?.type || null, enabled: !!j.enabled,
            app: j.appName || null, lastRunAt: j.lastRunAt || null, lastError: j.lastError || null, runCount: j.runCount || 0,
          }));
          if (args.app) rows = rows.filter((r) => r.app === args.app);
          if (args.failing) rows = rows.filter((r) => r.lastError);
          return textResult(rows.length ? rows : 'No scheduled jobs.');
        },
      },
    ],
    kinds: {
      'cron.set': {
        identity: null, // each request is its own act, not a re-derivation
        label: 'Change scheduled job',
        about: 'Adds, removes, enables or disables a scheduled job on the platform.',
        pinNote: 'A platform-configuration change that alters what runs unattended from then on — always human-confirmed.',
        ceiling: 'propose', // platform-config operation — always human-confirmed
        defaultLevel: 'propose',
        validate(p) {
          const { req } = require('../horst-facet');
          const op = req(p, 'op');
          if (!['add', 'enable', 'disable', 'remove'].includes(op)) throw new Error(`bad cron op "${op}"`);
          if (op === 'add') { req(p, 'name'); req(p, 'schedule'); req(p, 'target', 'any'); }
          else req(p, 'jobId');
        },
        describe: (p) => p.op === 'add'
          ? `Add cron job "${p.name}" (${p.schedule})`
          : `${p.op[0].toUpperCase() + p.op.slice(1)} cron job ${p.jobId}`,
        execute(p) {
          const platformCron = require('../platform-cron');
          if (p.op === 'add') return platformCron.addJob({ name: p.name, schedule: p.schedule, target: p.target });
          if (p.op === 'enable') return platformCron.enableJob(p.jobId);
          if (p.op === 'disable') return platformCron.disableJob(p.jobId);
          return platformCron.removeJob(p.jobId);
        },
      },

      // Phase 6 remediation: the cron:failed sense finally has a matching
      // action — one immediate re-run, schedule untouched. Inward-facing and
      // bounded, so it may earn auto+notify.
      'cron.retry': {
        // Bucketed by the clock hour, which IS the 1-per-job-per-hour cap: a
        // second retry of the same job inside the same hour collides with the
        // first on intentKey and is suppressed (with an audit row) by the
        // executed-twin rule. Re-running a job is not naturally idempotent, so
        // the cap below is what makes the autonomous default honest — the
        // declaration is backed by this key, not assumed.
        identity: (p) => `retry:cron:${p.jobId}:${Math.floor(Date.now() / 3600e3)}`,
        label: 'Re-run failed cron job',
        about: 'Runs a scheduled job once, immediately — the remediation for a failed run. The schedule itself is untouched.',
        ceiling: 'auto+notify',
        defaultLevel: 'auto+notify',
        idempotent: true,
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'jobId');
          if (!require('../platform-cron').list().some((j) => j.id === p.jobId)) throw new Error(`unknown cron job "${p.jobId}"`);
        },
        describe(p) {
          const job = require('../platform-cron').list().find((j) => j.id === p.jobId);
          return `Re-run cron job "${job ? job.name : p.jobId}" once now`;
        },
        async execute(p) {
          const r = await require('../platform-cron').runNow(p.jobId);
          if (!r.ok) throw new Error(r.error || 'run failed');
          return { ok: true, summary: `Cron job ${p.jobId} re-ran successfully` };
        },
      },
    },
  },
};
