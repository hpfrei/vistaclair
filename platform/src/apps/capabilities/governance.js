// Capability: governance — `governance.propose/list/update/decide/decisions/registerKind` — the one platform approval plane (proposals with frozen payloads, owner-decided in any surface)
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and docs/capabilities.md.

// Identity and origin are stamped server-side — an app cannot propose or
// decide as another app, nor file a card that reads as Horst's or an
// orchestrator's (meta.origin is overwritten). Governance refuses an app that
// stages or edits a platform-owned kind (appMayStage). registerKind is
// deliberately NOT a bridge op: kind defs carry executor functions, which only
// exist server-side (ctx.governance.registerKind).
const appMeta = (name, meta) => ({ ...(meta || {}), app: name, origin: 'app' });
// The payload version the app rendered, checked by decide when the app sends one.
const decideOpts = (opts) => (opts && opts.version !== undefined ? { version: opts.version } : {});

async function governanceOp(app, params, io) {
  const governance = require('../governance/horst-governance');
  const op = io.method.split('.')[1];
  const appName = app.name;
  if (op === 'propose') return governance.requestAction(params.kind, params.payload || {}, appMeta(appName, params.meta));
  if (op === 'list') return governance.listProposals(params || {});
  if (op === 'update') return governance.updateProposal(params.id, params.payload, `app:${appName}`);
  if (op === 'decisions') return governance.decisionsFor(params || {});
  return governance.decide(params.id, params.decision, `app:${appName}`, decideOpts(params));
}

module.exports = {
  key: 'governance',
  title: 'Platform Approvals (Governance)',
  core: false,
  gated: true,
  methods: ['governance.propose', 'governance.list', 'governance.update', 'governance.decisions', 'governance.decide', 'horst.briefing', 'horst.chat'],
  prefixes: ['governance.'],
  ctx: ['governance', 'horst'],
  keywords: /\b(approval|propose|confirm before|human in the loop|governance)\b/i,
  summary: '`governance.propose/list/decide/registerKind` — owner approvals',
  migration: 'App-local approval queues/cards (pending maps, approval-log tables, client-side approve execution) → `governance.propose` + rendering `governance.list`; an app-local record of what was approved per message → `governance.decisions`. NOTE: granting this capability makes the app an approval surface — `decide` lets app code approve proposals.',
  visibility: { standalone: false },
  revocable: true,

  buildCtx(app) {
    const name = app.name;
    const { contributes, requireContribution } = require('../app-manager');
    return {
      // Platform approval plane (ctx.governance). Apps stage actions as proposals
      // instead of running their own approval stores; the owner decides in any
      // surface (app UI, Horst UI, Telegram) and the outcome is one shared ledger.
      // registerKind kinds are namespaced '<app>:<kind>' and ceiling-clamped to
      // 'propose' — executors are in-app callbacks, cleared on app stop. Identity
      // is stamped server-side; an app cannot propose or decide as another app.
      governance: {
        propose: (kind, payload, meta) => requireContribution(name, 'governance')
          .then(() => require('../governance/horst-governance').requestAction(kind, payload, appMeta(name, meta))),
        list: (params) => requireContribution(name, 'governance')
          .then(() => require('../governance/horst-governance').listProposals(params || {})),
        // An owner who edits a pending proposal in an app surface edits THE
        // proposal: re-frozen, re-validated, draft→final diff recorded. Without
        // this the app's only way to honour an edit is to dismiss the proposal
        // and send directly, which loses the decision from the ledger.
        update: (id, payload) => requireContribution(name, 'governance')
          .then(() => require('../governance/horst-governance').updateProposal(id, payload, `app:${name}`)),
        // What was decided ABOUT a message — the read that replaces an app's
        // own mirror of every approval. { account, uids } → { uid: [rows] },
        // newest first, mechanical fields only (no payload, no edit diff).
        decisions: (params) => requireContribution(name, 'governance')
          .then(() => require('../governance/horst-governance').decisionsFor(params || {})),
        // opts.version: the payload version the app rendered (each listed
        // proposal carries `version`); a stale one is refused.
        decide: (id, decision, opts) => requireContribution(name, 'governance')
          .then(() => require('../governance/horst-governance').decide(id, decision, `app:${name}`, decideOpts(opts))),
        registerKind: (kind, def) => {
          if (!contributes(name)) throw new Error(`app "${name}" is marked independent (platformContribution: false) — enable platform contribution to use governance`);
          return require('../governance/horst-governance').registerKind(kind, def, { app: name });
        },
      },
      // Horst surfaces (ONE briefing rule: apps render Horst's morning briefing
      // instead of generating their own; ONE assistant rule: apps route chat to
      // Horst instead of running a competing conversational agent).
      horst: {
        briefing: () => require('../platform-horst').latestBriefing(),
        chat: (text, opts) => require('../platform-horst').chatFromApp(name, opts?.channel, text),
      },
    };
  },

  bridge: {
    'governance.propose': governanceOp,
    'governance.list': governanceOp,
    'governance.update': governanceOp,
    'governance.decisions': governanceOp,
    'governance.decide': governanceOp,
    // Read-only: the platform's latest morning briefing, so apps render THE
    // briefing (Horst's) instead of generating a competing one.
    'horst.briefing': async () => ({ briefing: require('../platform-horst').latestBriefing() }),
    // ONE assistant: apps route conversational turns to Horst instead of
    // running a competing agent. Awaits the full turn (same pipeline as
    // the Horst tab / TG control chat); proposals stage through governance
    // exactly as they would from Horst's own chat.
    'horst.chat': (app, params) => require('../platform-horst').chatFromApp(app.name, params?.channel, params?.text),
  },

  // ---- Horst facet: one read tool. There is deliberately no kind and no tool
  // that DECIDES a proposal: the owner decides on a card, never in chat.
  horst: {
    lane: {
      direct: {
        'governance.list': 'proposals_list',
        'governance.decisions': 'decision_stats',
      },
      never: ['governance.propose', 'governance.update', 'governance.decide', 'horst.briefing', 'horst.chat'],
      why: 'this is the approval plane itself: Horst stages through his propose markers, only the owner decides, and horst.* is Horst answering apps',
    },
    brief: 'governance: proposals_list shows what waits for the owner\'s approval; the owner decides on a card (Approvals, Telegram, the Mini App), never in chat',
    tools: [
      {
        def: {
          name: 'proposals_list',
          description: 'The approval queue: proposals with id, kind, summary, status, age, origin (chat, triage, an app…) and where the owner opens them. Default: pending, newest first. Read-only — deciding a proposal is the owner\'s, on a card; nothing in chat approves or denies.',
          inputSchema: { type: 'object', properties: {
            status: { type: 'string', description: 'pending (default) | executed | denied | failed | expired | withdrawn | all' },
            kind: { type: 'string', description: 'One kind, e.g. email.send.' },
            limit: { type: 'number', description: 'Max rows (default 20, max 100).' },
          } },
        },
        handler: async (args) => {
          const { textResult, limitOf } = require('../horst-facet');
          const governance = require('../governance/horst-governance');
          const status = args.status === 'all' ? undefined : (args.status || 'pending');
          const items = governance.listProposals({ status, kind: args.kind || undefined, limit: limitOf(args.limit, 20, 100) });
          if (!items.length) return textResult(`No ${status || ''} proposals${args.kind ? ` of kind ${args.kind}` : ''}.`.replace(/\s+/g, ' '));
          let openUrl = null;
          try { openUrl = require('../platform-miniapp').miniAppUrl(); } catch { /* no public URL */ }
          const now = Date.now();
          const ageOf = (ms) => {
            const m = Math.max(0, Math.round((now - ms) / 60e3));
            return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
          };
          return textResult({
            proposals: items.map((p) => ({
              id: p.id, kind: p.kind, summary: p.summary, status: p.status,
              age: p.createdAt ? ageOf(p.createdAt) : undefined, origin: p.origin || undefined, app: p.app || undefined,
            })),
            open: openUrl ? `Approvals Mini App: ${openUrl}` : 'Approvals in the Horst tab',
          });
        },
      },
    ],
  },
};
