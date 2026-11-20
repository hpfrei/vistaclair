// Capability: platform-cron — `platform.cron.schedule/list` — cross-app persistent jobs
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and docs/capabilities.md.

// The caller's jobs, as ctx.platform.cron sees them: the ones it owns
// (appName) plus unowned ones that drive its own endpoints (an app-api job
// its iframe registered through the Bridge), so a name stays one job.
function ownJobs(name) {
  return require('../platform-cron').list()
    .filter((j) => j.appName === name || (!j.appName && j.target?.type === 'app-api' && j.target.app === name));
}

// The routes.js face: app-api jobs against the caller's own endpoints only,
// idempotent by name so setup can call schedule() on every mount.
function cronCtx(name) {
  const P = () => require('../platform-cron');
  const findOwn = (jobId) => {
    const job = ownJobs(name).find((j) => j.id === jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    return job;
  };
  return {
    list: async () => ownJobs(name),
    schedule: async ({ name: jobName, schedule, target = {}, enabled } = {}) => {
      if (!jobName) throw new Error('name required');
      if (!schedule) throw new Error('schedule required');
      if ((target.type || 'app-api') !== 'app-api') throw new Error('ctx.platform.cron schedules app-api targets only');
      if (target.app && target.app !== name) throw new Error(`ctx.platform.cron targets the calling app only ("${name}")`);
      if (!target.path) throw new Error('target.path required');
      const t = { type: 'app-api', app: name, method: (target.method || 'POST').toUpperCase(), path: target.path };
      const existing = ownJobs(name).find((j) => j.name === jobName);
      if (existing) {
        const same = existing.schedule === schedule && existing.target?.path === t.path
          && (existing.target?.method || 'POST').toUpperCase() === t.method;
        // An owner's disable survives re-registration unless the app asks.
        if (same && (enabled === undefined || existing.enabled === (enabled !== false))) {
          return { jobId: existing.id, created: false, updated: false };
        }
        const updates = same ? {} : { schedule, target: t };
        if (enabled !== undefined) updates.enabled = enabled !== false;
        const r = P().updateJob(existing.id, updates);
        if (!r.ok) throw new Error(r.error);
        return { jobId: existing.id, created: false, updated: true };
      }
      const r = P().addJob({ name: jobName, schedule, target: t, enabled, appName: name });
      if (!r.ok) throw new Error(r.error);
      return { jobId: r.jobId, created: !r.deduped, updated: false };
    },
    cancel: async (arg) => {
      const jobId = typeof arg === 'string' ? arg : arg?.jobId;
      const job = jobId ? findOwn(jobId) : ownJobs(name).find((j) => j.name === arg?.name);
      if (!job) throw new Error(jobId ? `Job not found: ${jobId}` : 'jobId or name required');
      return P().removeJob(job.id);
    },
  };
}

module.exports = {
  key: 'platform-cron',
  title: 'Platform Cron',
  core: false,
  gated: true,
  methods: ['platform.cron.schedule', 'platform.cron.list', 'platform.cron.cancel', 'platform.cron.enable', 'platform.cron.disable'],
  prefixes: ['platform.cron.'],
  ctx: ['platform'],
  // The scheduler lives in the dashboard process; an own-process runner has none.
  visibility: { standalone: false },
  aliases: ['cron'],
  keywords: /\b(platform cron|cross-app (job|cron)|scheduled (task|job))\b/i,
  summary: '`platform.cron.schedule/list` — cross-app persistent jobs',
  migration: 'For jobs that should drive your own HTTP endpoints, prefer `platform.cron.schedule()` with an `app-api` target over a shell command.',

  buildCtx(app) {
    return { platform: { cron: cronCtx(app.name) } };
  },

  bridge: {
    'platform.cron.list': async () => require('../platform-cron').list(),
    'platform.cron.schedule': async (app, params) => {
      const addResult = require('../platform-cron').addJob({
        name: params.name,
        schedule: params.schedule,
        target: params.target,
        enabled: params.enabled,
      });
      if (!addResult.ok) throw new Error(addResult.error);
      return { jobId: addResult.jobId };
    },
    'platform.cron.cancel': async (app, params) => {
      if (!params.jobId) throw new Error('jobId required');
      return require('../platform-cron').removeJob(params.jobId);
    },
    'platform.cron.enable': async (app, params) => {
      if (!params.jobId) throw new Error('jobId required');
      return require('../platform-cron').enableJob(params.jobId);
    },
    'platform.cron.disable': async (app, params) => {
      if (!params.jobId) throw new Error('jobId required');
      return require('../platform-cron').disableJob(params.jobId);
    },
  },

  horst: {
    lane: {
      direct: { 'platform.cron.list': 'cron_list' },
      card: {
        'platform.cron.schedule': 'cron.set', 'platform.cron.cancel': 'cron.set',
        'platform.cron.enable': 'cron.set', 'platform.cron.disable': 'cron.set',
      },
    },
  },
};
