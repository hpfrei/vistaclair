// Capability: memory — `memory.remember/rememberBatch/recall` — shared self-tending knowledge store
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.

// Stamp the caller as app_origin / scope owner — apps can't spoof another app.
async function memoryOp(app, params, io) {
  const memory = require('../memory-service');
  const op = io.method.split('.')[1];
  const scoped = { ...params, app_origin: app.name, scope_caller: app.name };
  if (op === 'rememberBatch') return memory.rememberBatch((params.items || []).map((it) => ({ ...it, app_origin: app.name })));
  return memory[op](scoped);
}

module.exports = {
  key: 'memory',
  title: 'Platform Memory',
  core: false,
  gated: true,
  methods: ['memory.remember', 'memory.rememberBatch', 'memory.recall', 'memory.forget', 'memory.entities', 'memory.history'],
  prefixes: ['memory.'],
  ctx: ['memory'],
  keywords: /\b(memory|remember|knowledge store|recall)\b/i,
  summary: '`memory.remember/rememberBatch/recall` — shared knowledge store',

  buildCtx(app) {
    const name = app.name;
    return {
      memory: {
        remember: (params) => require('../memory-service').remember({ ...params, app_origin: name }),
        rememberBatch: (items) => require('../memory-service').rememberBatch((items || []).map((it) => ({ ...it, app_origin: name }))),
        recall: (params) => require('../memory-service').recall({ ...params, scope_caller: name }),
        // "What was remembered from THIS artifact" — recall() is text-driven and
        // can't answer it. Scope-guarded like every other read.
        bySource: (params) => require('../memory-service').bySource(params || {}, name),
        forget: (params) => require('../memory-service').forget({ ...params, scope_caller: name }),
        entities: (params) => require('../memory-service').entities({ ...(params || {}), scope_caller: name }),
        history: (params) => require('../memory-service').history({ ...(params || {}), scope_caller: name }),
      },
    };
  },

  bridge: {
    'memory.remember': memoryOp,
    'memory.rememberBatch': memoryOp,
    'memory.recall': memoryOp,
    'memory.forget': memoryOp,
    'memory.entities': memoryOp,
    'memory.history': memoryOp,
  },

  // ---- Horst facet: consolidation-event senses (phase 6) ---------------------
  // Read access needs no tool here — Horst's brain already recalls platform
  // memory; failures of the maintenance jobs surface via cron:failed.
  horst: {
    lane: {
      direct: {
        'memory.recall': 'memory_search',
        'memory.entities': { deferred: 'memory_search answers what Horst asks; the entity index has no chat use yet' },
        'memory.history': { deferred: 'memory_search answers what Horst asks; a fact\'s history has no chat use yet' },
      },
      never: ['memory.remember', 'memory.rememberBatch', 'memory.forget'],
      why: 'ctx.memory is an app\'s scoped face of the shared store; Horst writes his own through the remember / forget / supersede markers',
    },
    brief: 'memory: the shared knowledge store (self-tending; consolidation events are sensed)',
    senses: [
      { kind: 'memory:consolidated', description: 'A memory maintenance pass (consolidate/decay/compact/archive) changed the knowledge store', defaultPolicy: 'agenda' },
    ],
    wire({ publish }) {
      return require('../memory-maintenance').onRun((job, summary) => {
        if (!(summary.affected > 0)) return; // idle passes are not news
        publish('memory:consolidated',
          { job, scanned: summary.scanned || 0, affected: summary.affected, backlog: summary.backlog || 0 },
          { dedupeKey: `memory:${job}`, summary: `Memory ${job}: ${summary.affected} item(s) affected (${summary.scanned || 0} scanned)` });
      });
    },
  },
};
