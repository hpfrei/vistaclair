// Capability: spend — `spend.status` / `ctx.spendStatus`: what this app may still spend right now (admin spend policy, deployment mode, credits left per bucket)
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.
//
// The spend policy itself is ADMIN-owned (src/apps/spend-policy.js, stored
// under core's dataHome) and enforced at the platform's chokepoints
// (src/apps/spend-gate.js) with no cooperation from app code. This module is
// the read-only window apps get, plus Horst's senses and a read-only tool.
const { textResult } = require('../horst-facet');

module.exports = {
  key: 'spend',
  title: 'Spend & Permissions',
  core: true,
  gated: false,
  cost: 'free',
  audiences: ['owner', 'user'],
  methods: ['spend.status'],
  ctx: ['spendStatus'],
  keywords: /\b(spend|budget|credits?|quota|metered|cost cap)\b/i,
  summary: '`spend.status` / `ctx.spendStatus()` — the policy in force',
  migration: 'Hand-rolled per-user budget checks against `ai.usage` totals → let the platform enforce: the admin sets caps per app / per user in App Config → Spend; read `spend.status` to show a balance and catch `err.code === "E_NO_CREDITS"` to degrade gracefully.',

  buildCtx(app) {
    const name = app.name;
    return {
      // Read-only: the policy in force and the credits left for the current
      // principal (the account of the request being handled, or the app-wide
      // bucket). Pass { principal } to inspect another bucket.
      spendStatus: (params) => require('../spend-gate').status(name, params || {}),
    };
  },

  bridge: {
    'spend.status': async (app, params) => require('../spend-gate').status(app.name, { principal: 'owner', ...(params || {}) }),
  },

  // ---- Horst facet: senses + a read-only tool ------------------------------
  horst: {
    lane: { direct: { 'spend.status': 'spend_status' } },
    brief: 'spend: metered platform calls (LLM, speech, image, search, maps) are ledgered per app and gated by the admin\'s spend policy; per-app daily storage caps are swept hourly; senses fire on exhaustion, thresholds, anomalies and storage breaches',
    senses: [
      { kind: 'spend:exhausted', description: 'A spend cap is used up (an app, a user, or the unattributed bucket) — metered calls now fail with E_NO_CREDITS', defaultPolicy: 'notify' },
      { kind: 'spend:threshold', description: 'An app crossed its daily alert threshold (default 80% of the day cap)', defaultPolicy: 'agenda' },
      { kind: 'spend:anomaly', description: "Today's spend of an app is a multiple of its 7-day average", defaultPolicy: 'agenda' },
      { kind: 'spend:unattributed', description: 'In deployed mode an app spent without any user attribution (lands in the app-wide bucket)', defaultPolicy: 'agenda' },
      { kind: 'spend:storage:breach', description: 'An app wrote more new storage today than its daily storage cap allows (two consecutive measurements) — the app was paused per the admin policy', defaultPolicy: 'notify' },
    ],
    wire({ publish }) {
      return require('../spend-gate').observe((ev) => {
        if (ev.type === 'exhausted') {
          publish('spend:exhausted', { app: ev.app, scope: ev.scope, bucket: ev.bucket, method: ev.method, mode: ev.mode },
            { dedupeKey: `spend:exhausted:${ev.app}:${ev.bucket}`, summary: `${ev.app}: spend cap reached (${ev.scope}${ev.bucket && ev.bucket !== '_app' ? ` ${ev.bucket}` : ''})`.slice(0, 120) });
        } else if (ev.type === 'threshold') {
          publish('spend:threshold', { app: ev.app, pct: ev.pct, mode: ev.mode },
            { dedupeKey: `spend:threshold:${ev.app}`, summary: `${ev.app}: ${ev.pct}% of today's spend cap used`.slice(0, 120) });
        } else if (ev.type === 'anomaly') {
          publish('spend:anomaly', { app: ev.app, todayUsd: ev.todayUsd, baselineUsd: ev.baselineUsd, factor: ev.factor },
            { dedupeKey: `spend:anomaly:${ev.app}`, summary: `${ev.app}: today's spend $${ev.todayUsd.toFixed(2)} is ${(ev.todayUsd / Math.max(ev.baselineUsd, 1e-6)).toFixed(1)}× the 7-day average`.slice(0, 120) });
        } else if (ev.type === 'unattributed') {
          publish('spend:unattributed', { app: ev.app, method: ev.method, mode: ev.mode },
            { dedupeKey: `spend:unattributed:${ev.app}`, summary: `${ev.app}: metered spend without user attribution (${ev.method})`.slice(0, 120) });
        } else if (ev.type === 'storage-breach') {
          publish('spend:storage:breach', { app: ev.app, deltaBytes: ev.deltaBytes, capMB: ev.capMB, bytes: ev.bytes, mode: ev.mode, paused: ev.paused },
            { dedupeKey: `spend:storage:${ev.app}`, summary: `${ev.app}: +${Math.round(ev.deltaBytes / 1e6)} MB new storage today (cap ${ev.capMB} MB)${ev.paused ? ' — app paused' : ''}`.slice(0, 120) });
        }
      });
    },
    tools: [
      {
        def: {
          name: 'spend_status',
          description: 'Read-only. The spend policy in force (deployment mode, preset, caps) and today / this month spend for one app, or a one-line overview of every app when no app is given.',
          inputSchema: { type: 'object', properties: { app: { type: 'string', description: 'App name (omit for the overview)' } } },
        },
        handler(args) {
          const gate = require('../spend-gate');
          const ledger = require('../spend-ledger');
          const appManager = require('../app-manager');
          if (args && args.app) {
            const s = gate.status(String(args.app), { principal: null });
            const sum = ledger.summary(String(args.app), { days: 30 }, require('path').join(appManager.APPS_DIR, String(args.app)));
            return textResult({ ...s, today: sum.today, month: sum.month, blocked: sum.blocked });
          }
          const rows = appManager.list().map((a) => {
            const s = gate.status(a.name, { principal: null });
            const sum = ledger.summary(a.name, { days: 1 }, require('path').join(appManager.APPS_DIR, a.name));
            return `${a.name}: ${s.preset}${s.paused ? ' (paused)' : ''} — today ${sum.today.credits} cr`;
          });
          return textResult(rows.join('\n') || 'No apps.');
        },
      },
    ],
  },
};
