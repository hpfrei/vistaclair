// Capability: sysmon — `sysmon.get/subscribe/processes` — live host RAM, CPU (aggregate + per core), swap, disk and load plus a per-process RAM breakdown, pushed as `sysmon:sample`; render it with `<vc-sysmon>`
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.

module.exports = {
  key: 'sysmon',
  title: 'System Monitor',
  core: false,
  gated: true,
  methods: ['sysmon.get', 'sysmon.subscribe', 'sysmon.unsubscribe', 'sysmon.processes'],
  prefixes: ['sysmon.'],
  ctx: ['sysmon'],
  keywords: /\b(system monitor|host (pressure|stats)|meminfo|free (ram|memory)|swap usage|disk (free|space)|load ?avg|top (processes|consumers))\b/i,
  summary: '`sysmon.get/subscribe/processes` — host RAM/CPU/disk/load; `<vc-sysmon>`',
  migration: 'App-private host samplers (`/proc/meminfo` and `/proc/stat` readers, `statfsSync` polls, `os.freemem`/`os.cpus` timers) and client-side `setInterval` polls of an `/api/sys` route → `sysmon.subscribe()` once and listen for `sysmon:sample`. Hand-rolled RAM/CPU/swap/disk gauges → `<vc-sysmon>`, which also charts RAM and CPU history, draws a per-core strip, and lists the top memory consumers.',

  buildCtx(app) {
    const name = app.name;
    // Host pressure, sampled once for the whole platform. `arm` is for long
    // server-side work: a job that might exhaust the box should make sure the
    // monitor is recording while it runs, whether or not anyone has the tab open.
    return {
      sysmon: {
        get: (params) => require('../platform-sysmon').get(params || {}),
        processes: (params) => require('../platform-sysmon').processes(params || {}),
        arm: (ttlMs) => require('../platform-sysmon').subscribe(name, ttlMs),
      },
    };
  },

  bridge: {
    'sysmon.get': (app, params) => require('../platform-sysmon').get(params || {}),
    'sysmon.processes': (app, params) => require('../platform-sysmon').processes(params || {}),
    // appName comes from the bridge, not the caller: an app can only ever
    // subscribe itself, and events are routed to its iframe by that same name.
    'sysmon.subscribe': async (app, params) => require('../platform-sysmon').subscribe(app.name, params?.ttlMs),
    'sysmon.unsubscribe': async (app) => require('../platform-sysmon').unsubscribe(app.name),
  },

  // ---- Horst facet: senses, read-only tools ----------------------------------
  horst: {
    lane: {
      direct: { 'sysmon.get': 'sysmon_get', 'sysmon.processes': { deferred: 'sysmon_get names the pressure; per-process detail is app_status / tasks_list' } },
      never: ['sysmon.subscribe', 'sysmon.unsubscribe'],
      why: 'an app\'s live gauge feed; pressure reaches Horst as a sense',
    },
    brief: 'sysmon: host RAM/CPU/swap/disk/load and a per-process memory breakdown',
    senses: [
      { kind: 'sysmon:pressure', description: 'The host entered pressure: low available memory, low free disk or high load', defaultPolicy: 'notify' },
      { kind: 'sysmon:recovered', description: 'Host pressure cleared', defaultPolicy: 'agenda' },
    ],
    wire({ publish }) {
      return require('../platform-sysmon').watchPressure({
        onChange: (c) => {
          const s = c.sample || {};
          const payload = {
            reasons: c.reasons, memAvailable: s.mem?.available ?? null, memTotal: s.mem?.total ?? null,
            diskFree: s.disk?.free ?? null, diskTotal: s.disk?.total ?? null, load1: s.load1 ?? null, cpus: s.cpus ?? null,
          };
          if (c.state === 'pressure') {
            publish('sysmon:pressure', payload, { dedupeKey: 'sysmon', summary: `Host under pressure: ${c.reasons.map((r) => `${r.kind} (${r.detail})`).join(', ')}`.slice(0, 120) });
          } else {
            publish('sysmon:recovered', payload, { dedupeKey: 'sysmon', summary: 'Host pressure cleared' });
          }
        },
      });
    },
    tools: [
      {
        def: {
          name: 'sysmon_get',
          description: 'Current host reading: memory (total/available/used), swap, disk (total/free), load averages, cpu count and aggregate cpu busy fraction; optionally the top memory-consuming process groups. Read-only.',
          inputSchema: { type: 'object', properties: {
            processes: { type: 'boolean', description: 'Include the per-process memory breakdown (slower).' },
            top: { type: 'number', description: 'How many process groups to include (default 10, max 30).' },
          } },
        },
        handler: async (args) => {
          const sysmon = require('../platform-sysmon');
          const { textResult, limitOf } = require('../horst-facet');
          const r = await sysmon.get({ history: 0, processes: !!args.processes });
          const s = r.sample || {};
          const out = {
            at: s.at, mem: s.mem, swap: s.swap, disk: s.disk, load: [s.load1, s.load5, s.load15], cpus: s.cpus,
            cpuBusy: s.cpu?.busy ?? s.cpu?.total ?? undefined,
            pressure: sysmon.evaluatePressure(s),
          };
          if (args.processes && r.processes) {
            const groups = r.processes.groups || r.processes.apps || r.processes;
            out.processes = Array.isArray(groups) ? groups.slice(0, limitOf(args.top, 10, 30)) : groups;
          }
          return textResult(out);
        },
      },
    ],
    kinds: {
      // Phase 6 (G8): the lockout-risk op finally has a governed path. The
      // executor is a launcher index.js registers (scheduleRestart is a
      // core-ctx function only the dashboard process holds) — same doctrine as
      // telegram.send. Owner clicks keep their direct path (a click IS the
      // approval); this kind exists so an AI request always passes a human.
      'server.restart': {
        identity: null, // a repeat run is a legitimate retry, never a duplicate
        label: 'Restart platform server',
        about: 'Restarts the whole vistaclair server — dashboard, proxy and every in-process app go down and come back.',
        pinNote: 'Lockout-risk: a restart that fails leaves the platform (and every approval surface) unreachable — always human-approved, whatever the dials say.',
        ceiling: 'propose', // hard-pinned, non-configurable (G8)
        defaultLevel: 'propose',
        validate() {}, // no payload — the frozen proposal is the whole request
        describe: () => 'Restart the vistaclair server (dashboard, proxy and all in-process apps)',
        execute(p, proposal, helpers) {
          const fn = helpers && helpers.launcher ? helpers.launcher('server.restart') : null;
          if (!fn) throw new Error('server.restart launcher not registered (no scheduleRestart in this process)');
          return fn(p);
        },
      },
    },
  },
};
