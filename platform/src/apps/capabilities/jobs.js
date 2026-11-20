// Capability: jobs — `ctx.jobs.start/get/list/cancel`, `job:update` events — reload-resilient work
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.

module.exports = {
  key: 'jobs',
  title: 'Jobs (Long-Running Operations)',
  core: true,
  gated: false,
  methods: ['jobs.list', 'jobs.get', 'jobs.cancel', 'jobs.remove'],
  prefixes: ['jobs.'],
  ctx: ['jobs'],
  keywords: /\b(long.running|background job|progress)\b/i,
  summary: '`ctx.jobs.start/get/list/cancel`, `job:update` events — reload-resilient work',
  migration: 'Hand-rolled in-memory job tracking (`activeScans`-style maps + polling status routes) → `ctx.jobs.start()` + frontend `jobs.list`/`jobs.cancel` + `Bridge.subscribe(\'job:update\')`.',

  buildCtx(app) {
    const name = app.name;
    // Persistent long-running jobs (GUI-reload resilient). start({name, meta?, run})
    // → {id}; run(job) gets {id, signal, setProgress(pct,label), setMeta(obj)}.
    // Every transition persists to .data/jobs.json and emits a 'job:update'
    // bridge event. See _api-reference.md "Jobs".
    return {
      jobs: {
        start: (params) => require('../app-jobs').startJob(name, params),
        get: (id) => require('../app-jobs').getJob(name, id),
        list: (params) => require('../app-jobs').listJobs(name, params),
        cancel: (id) => require('../app-jobs').cancelJob(name, id),
        remove: (id) => require('../app-jobs').removeJob(name, id),
        prune: (params) => require('../app-jobs').pruneJobs(name, params),
      },
    };
  },

  bridge: {
    'jobs.list': async (app, params) => require('../app-jobs').listJobs(app.name, params || {}),
    'jobs.get': async (app, params) => {
      if (!params.id) throw new Error('id required');
      return require('../app-jobs').getJob(app.name, params.id);
    },
    'jobs.cancel': async (app, params) => {
      if (!params.id) throw new Error('id required');
      return require('../app-jobs').cancelJob(app.name, params.id);
    },
    'jobs.remove': async (app, params) => {
      if (!params.id) throw new Error('id required');
      return require('../app-jobs').removeJob(app.name, params.id);
    },
  },

  // ---- Horst facet: senses, read-only tools, approval-gated kinds ------------
  horst: {
    lane: {
      direct: { 'jobs.list': 'jobs_list', 'jobs.get': 'jobs_list' },
      card: { 'jobs.cancel': 'job.cancel' },
      never: ['jobs.remove'],
      why: 'removing a finished job record is the app\'s own housekeeping',
    },
    brief: 'jobs: per-app persistent background jobs (cancelling one is approval-gated)',
    senses: [
      { kind: 'job:failed', description: 'An app\'s background job ended with an error', defaultPolicy: 'agenda' },
    ],
    wire({ publish }) {
      return require('../app-jobs').onFinished((appName, job) => {
        if (job.status !== 'error') return;
        publish('job:failed', { app: appName, jobId: job.id, name: job.name || null, error: job.error || 'Unknown error' },
          { dedupeKey: `job:${appName}:${job.id}`, summary: `Job failed in ${appName}: ${job.name || job.id} — ${job.error || ''}`.slice(0, 120) });
      });
    },
    tools: [
      {
        def: {
          name: 'jobs_list',
          description: 'List apps\' persistent background jobs (id, app, name, status, progress, started/finished, error). Read-only — cancelling goes through the job.cancel proposal.',
          inputSchema: { type: 'object', properties: {
            app: { type: 'string', description: 'One app (default: every installed app).' },
            status: { type: 'string', description: 'Filter: running, done, error, cancelled, interrupted.' },
            limit: { type: 'number', description: 'Max rows per app (default 20, max 100).' },
          } },
        },
        handler: async (args) => {
          const appJobs = require('../app-jobs');
          const { textResult, limitOf } = require('../horst-facet');
          const names = args.app ? [args.app] : require('../app-manager').list().map((a) => a.name);
          const limit = limitOf(args.limit, 20, 100);
          const rows = [];
          for (const name of names) {
            let list = [];
            try { list = appJobs.listJobs(name, { status: args.status || undefined, limit }); } catch {}
            for (const j of list) {
              rows.push({ app: name, id: j.id, name: j.name || null, status: j.status, progress: j.progress || undefined,
                startedAt: j.startedAt || j.createdAt || null, finishedAt: j.finishedAt || null, error: j.error || undefined });
            }
          }
          return textResult(rows.length ? rows : 'No jobs.');
        },
      },
    ],
    kinds: {
      'job.cancel': {
        identity: null, // a repeat run is a legitimate retry, never a duplicate
        label: 'Cancel background job',
        about: 'Cancels a running background job of an app (the app\'s job handler receives the abort signal).',
        ceiling: 'auto+notify',
        defaultLevel: 'propose',
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'app'); req(p, 'jobId', 'any');
          if (!require('../app-manager').readManifest(p.app)) throw new Error(`unknown app "${p.app}"`);
          if (!require('../app-jobs').getJob(p.app, p.jobId)) throw new Error(`unknown job "${p.jobId}" in app "${p.app}"`);
        },
        describe: (p) => `Cancel job ${p.jobId} in app "${p.app}"`,
        execute(p) {
          const r = require('../app-jobs').cancelJob(p.app, p.jobId);
          if (r && r.ok === false) throw new Error(r.error || 'cancel failed');
          return { ok: true, summary: `Job ${p.jobId} cancelled` };
        },
      },

      // Phase 6 remediation: the job:failed sense finally has a matching
      // action. Retryable only while this process holds the run closure
      // (app-jobs retains failed runs; a restart clears them).
      'job.retry': {
        // Same clock-hour cap as cron.retry, and needed more sharply here: a
        // retry mints a NEW job record rather than re-running one in place, so
        // an uncapped autonomous retry of a job that fails on every attempt
        // would fill the history. One per app+job per hour; the rest are
        // suppressed with an audit row.
        identity: (p) => `retry:job:${p.app}:${p.jobId}:${Math.floor(Date.now() / 3600e3)}`,
        label: 'Retry failed job',
        about: 'Resubmits a failed background job with the same parameters (a new job record; the failed one stays in the history). Only failures from the current server process can be resubmitted.',
        ceiling: 'auto+notify',
        defaultLevel: 'auto+notify',
        idempotent: true,
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'app'); req(p, 'jobId', 'any');
          const appJobs = require('../app-jobs');
          if (!require('../app-manager').readManifest(p.app)) throw new Error(`unknown app "${p.app}"`);
          const job = appJobs.getJob(p.app, p.jobId);
          if (!job) throw new Error(`unknown job "${p.jobId}" in app "${p.app}"`);
          if (job.status !== 'error') throw new Error(`job "${p.jobId}" is ${job.status}, not failed`);
          if (!appJobs.canRetry(p.app, p.jobId)) throw new Error(`job "${p.jobId}" is not retryable — its run function is gone (only failures from this server process can be resubmitted)`);
        },
        describe(p) {
          const job = require('../app-jobs').getJob(p.app, p.jobId);
          return `Retry failed job "${job && job.name ? job.name : p.jobId}" in app "${p.app}"`;
        },
        execute(p) {
          const { id } = require('../app-jobs').retryJob(p.app, p.jobId);
          return { ok: true, id, summary: `Job ${p.jobId} resubmitted as ${id}` };
        },
      },
    },
  },
};
