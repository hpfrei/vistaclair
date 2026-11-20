// Capability: events — `Bridge.on`, `Bridge.subscribe`, `ctx.broadcaster`, the platform bus
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and docs/capabilities.md.
//
// ctx.events is the app's end of the platform bus (agent/horst-events.js):
// emit/declare publish, subscribe/history receive. Fire-and-forget only —
// request/reply is `ctx.tools.call` on `expose:'apps'` tools. An independent
// app (platformContribution: false) reaches the bus like any other; only
// Horst never sees its events (`horst: false` → audit outcome `app-only`).
// `subscribe` exists for in-process apps only: an own-process app has no
// dashboard→runner push channel yet, so its ctx omits the member (the
// standalone fixture pins the difference).

// A declaration is also written back to manifest.events.emits, so the manifest
// is true to the code from the first mount on — the same deal app-tools.js
// makes for manifest.tools. Everything downstream of the manifest (the
// cross-app change-request check, the Triggers "listened by" view, app-lint
// rule 17) then sees the kinds without anyone remembering to run
// `infer:capabilities --write`.
//
// Lazy requires, both of them: capabilities-infer requires capabilities.js,
// which loads this module — a top-level require here refuses to boot.
// Own-process apps are skipped: the runner has no manifest writer, and their
// kinds are in the bus catalog either way.
function recordDeclaration(app, kinds) {
  if (app.profile === 'standalone') return;
  try {
    const { fullKind } = require('../agent/horst-events');
    const { mergeEvents } = require('../capabilities-infer');
    const appManager = require('../app-manager');
    const manifest = appManager.readManifest(app.name);
    if (!manifest) return;
    // A new kind is stored the way the bus names it (`<app>:<kind>`); a kind
    // the manifest already lists keeps its spelling, because the bare form is
    // what `capabilities-infer` writes and `emitsKind` accepts either — two
    // spellings of one kind would be two entries.
    const listed = (manifest.events && manifest.events.emits) || {};
    const emits = {};
    for (const k of kinds || []) {
      if (!k || typeof k.kind !== 'string' || !k.kind.trim()) continue;
      const full = fullKind(app.name, k.kind);
      const bare = full.startsWith(`${app.name}:`) ? full.slice(app.name.length + 1) : full;
      emits[listed[full] || !listed[bare] ? full : bare] = { description: String(k.description || '') };
    }
    if (!Object.keys(emits).length) return;
    const merged = mergeEvents(manifest.events, { emits, listens: [] });
    // Only when it actually differs — a mount must not churn the app's git.
    if (JSON.stringify(merged) === JSON.stringify(manifest.events || null)) return;
    appManager.updateManifest(app.name, { events: merged });
  } catch { /* the manifest is advertisement; never fail a declare over it */ }
}

module.exports = {
  key: 'events',
  title: 'Receiving Events',
  headings: ['Receiving Events', 'The platform bus (cross-app events)', 'Publishing events'],
  core: true,
  gated: false,
  methods: ['events.subscribe', 'events.unsubscribe', 'events.history'],
  prefixes: ['events.'],
  runtime: ['Bridge'],
  ctx: ['broadcaster', 'sse', 'events'],
  keywords: /\b(realtime|live update|websocket|push|sse|bus|subscribe|cross-app|other app)\b/i,
  summary: '`Bridge.on/subscribe`, `ctx.broadcaster`; bus `ctx.events`/`Bridge.bus`',
  migration: 'Hand-rolled SSE client sets (headers, ping interval, cleanup) → `ctx.sse.handler()` / `ctx.sse.emit()`. Polling another app\'s state or DB to react to it → `ctx.events.subscribe(\'<app>:*\', handler)` on the platform bus.',

  buildCtx(app) {
    const name = app.name;
    const broadcaster = app.broadcaster;
    const { contributes } = require('../app-manager');
    const bus = () => require('../agent/horst-events');
    const events = {
      // Publish an envelope (kind auto-namespaced `<app>:<kind>`). Horst
      // routes it unless the app is independent; app subscribers and the
      // log get it either way. No-op if the bus isn't up.
      emit: (kind, payload, opts) => bus().publish(kind, payload, { ...(opts || {}), app: name, source: 'app', horst: contributes(name) }),
      // Advertise kinds ([{ kind, description }]) — the Triggers view, the
      // undeclared-event lint and other apps' authors read this. The kinds
      // are recorded in manifest.events.emits too (recordDeclaration above).
      declare: (kinds) => {
        const res = bus().declare(name, kinds, { horst: contributes(name) });
        if (res && res.ok) recordDeclaration(app, kinds);
        return res;
      },
      // Envelopes from the log, oldest first: { kinds, since, sinceId, limit }.
      history: (opts) => bus().history(opts || {}),
    };
    if (app.profile !== 'standalone') {
      // subscribe(kinds, handler) → unsubscribe fn. kinds: a full kind or a
      // pattern (`other-app:*`, `*:crashloop`), or an array. The handler gets
      // the envelope; a throw is recorded against THIS app by the app guard.
      events.subscribe = (kinds, handler) => bus().subscribe(name, kinds, handler);
    }
    return {
      broadcaster: {
        broadcast: (msg) => broadcaster?.broadcast({ type: 'app:bridge:event', appName: name, event: 'broadcast', data: msg }),
      },
      // SSE for cookieless clients (Telegram webviews etc.) that can't use the
      // platform WebSocket. router.get('/api/events', ctx.sse.handler()) then
      // ctx.sse.emit('event', data). Channels scope per-resource streams:
      // handler((req) => req.params.jobId) + emit(event, data, jobId).
      sse: {
        handler: (channelFn) => require('../app-sse').handler(name, channelFn),
        emit: (event, data, channel) => require('../app-sse').emit(name, event, data, channel),
      },
      events,
    };
  },

  // The iframe's end: a LEASE (one pattern set per app, ttl-bounded, replaced
  // on every call) delivered as the `bus:event` bridge event. Bridge.bus() in
  // app-runtime.js owns the renewal; these are its three calls.
  bridge: {
    'events.subscribe': async (app, p) => require('../agent/horst-events').leaseSubscribe(app.name, p?.kinds, p?.ttlMs),
    'events.unsubscribe': async (app) => require('../agent/horst-events').unlease(app.name),
    'events.history': async (app, p) => require('../agent/horst-events').history(p || {}),
  },

  horst: {
    lane: {
      direct: { 'events.history': 'events_history' },
      never: ['events.subscribe', 'events.unsubscribe'],
      why: 'an app\'s own subscriptions; Horst\'s senses are the bus policies',
    },
    brief: 'events: the platform bus — every envelope apps and the platform publish, who listens, and the recent log (events_history)',
    tools: [
      {
        def: {
          name: 'events_history',
          description: 'Recent envelopes from the platform bus (what apps and the platform published), oldest first. Filter by kind pattern (e.g. "minecraft-server:*", "*:crashloop") and time. Read-only.',
          inputSchema: { type: 'object', properties: {
            kinds: { type: 'string', description: 'A kind or pattern; `*` matches one colon segment, a trailing `*` the rest (e.g. "gymihorst:*").' },
            since: { type: 'number', description: 'Epoch ms — only envelopes after this.' },
            limit: { type: 'number', description: 'How many (default 30, max 200).' },
          } },
        },
        handler: async (args) => {
          const { textResult, emptyResult, limitOf } = require('../horst-facet');
          const items = require('../agent/horst-events').history({
            kinds: args.kinds || undefined, since: args.since || undefined, limit: limitOf(args.limit, 30, 200),
          });
          if (!items.length) return emptyResult('No envelopes match.');
          return textResult(items.map((e) => ({
            id: e.id, at: e.at, app: e.app, kind: e.kind, summary: e.summary || undefined,
            hop: e.hop || undefined, correlationId: e.correlationId || undefined, trust: e.trust, payload: e.payload,
          })));
        },
      },
    ],
  },
};
