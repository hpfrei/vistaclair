// Capability: ai — `ai.prompt` (with `sessionTag`/`meterKey`), `ai.models`, `ai.usage`, `pickModel`, `askAI`, `parseAIResponse`
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and docs/capabilities.md.

module.exports = {
  key: 'ai',
  title: 'AI',
  core: true,
  gated: true,
  cost: 'metered',
  revocable: true,
  audiences: ['owner', 'user'],
  spend: { service: 'ai-service', units: { 'ai.prompt': 'tokens', 'ai.models': 'free', 'ai.usage': 'free' } },
  methods: ['ai.prompt', 'ai.models', 'ai.usage'],
  runtime: ['askAI', 'getModels', 'pickModel', 'parseAIResponse'],
  ctx: ['aiPrompt', 'aiUsage'],
  keywords: /\b(ai|llm|prompt|claude|gpt|summari[sz]e|classify)\b/i,
  summary: '`ai.prompt`/`ai.models`/`ai.usage`, `pickModel`, `askAI`, `parseAIResponse`',
  migration: 'Custom AI retry/backoff loops → the built-in `retries: N` param. `exec` + `claude -p` → `ai.prompt`. Hand-rolled per-user op counters as spend proxies → `meterKey` on `ai.prompt` + `ai.usage` (real token/cost accounting).',

  buildCtx(app) {
    const ai = require('../ai-service');
    return {
      aiPrompt: (params) => ai.aiPrompt(app.name, app.dir, params),
      // Per-app AI spend ledger (fed automatically by every aiPrompt; pass
      // meterKey on aiPrompt to attribute spend to an end user). Read-only.
      aiUsage: (params) => ai.aiUsageQuery(app.name, app.dir, params),
    };
  },

  bridge: {
    'ai.prompt': (app, params) => require('../ai-service').aiPrompt(app.name, app.dir, params),
    'ai.usage': async (app, params) => require('../ai-usage').query(app.dir, params || {}),
    'ai.models': async (app, params) => require('../ai-service').modelsPayload(params),
  },

  // ---- Horst facet: senses ---------------------------------------------------
  horst: {
    lane: {
      direct: { 'ai.models': { deferred: 'the daily model review reads the registry; no chat question needs the list yet' } },
      never: ['ai.prompt', 'ai.usage'],
      why: 'Horst is himself a model call — a nested prompt is an app\'s tool; ai.usage is the calling app\'s own ledger (Horst reads spend_status)',
    },
    brief: 'ai: one-shot model calls for apps and for Horst himself (the proxy meters every call)',
    senses: [
      { kind: 'ai:failed', description: 'An AI call failed (the model process exited with an error)', defaultPolicy: 'agenda' },
      { kind: 'ai:auth-required', description: 'Claude is not authenticated — every AI call fails until `claude login` is run', defaultPolicy: 'notify' },
      { kind: 'ai:model-substituted', description: 'An app asked for a retired model and was mapped to its replacement — the app should be updated', defaultPolicy: 'notify' },
      { kind: 'ai:model-unavailable', description: 'An app called a text or media model that is unknown or gone at the vendor; the call failed', defaultPolicy: 'notify' },
      { kind: 'ai:default-missing', description: 'The daily model review found a configured default model (or voice) gone; calls fall back meanwhile', defaultPolicy: 'notify' },
    ],
    wire({ publish }) {
      let authAnnounced = false;
      return require('../ai-service').observe((ev) => {
        if (ev.type === 'substituted') {
          publish('ai:model-substituted', { app: ev.app, deadModel: ev.deadModel, replacement: ev.replacement },
            { dedupeKey: `ai-model:${ev.app}:${ev.deadModel}`, summary: `${ev.app} asked for retired model ${ev.deadModel} → ${ev.replacement}`.slice(0, 120) });
          return;
        }
        // Both deduped at the source: once per app+method+model per process,
        // once per target+model in the review's state file.
        if (ev.type === 'unavailable') {
          publish('ai:model-unavailable', { app: ev.app, method: ev.method, model: ev.model, reason: ev.reason },
            { dedupeKey: `ai-unavailable:${ev.app}:${ev.method}:${ev.model}`, summary: `${ev.app}: ${ev.method} model "${ev.model}" is ${ev.reason === 'gone' ? 'no longer available' : ev.reason} — the call failed`.slice(0, 160) });
          return;
        }
        if (ev.type === 'default-missing') {
          const what = ev.voice ? `voice "${ev.voice}" of ${ev.model}` : `"${ev.model}"`;
          publish('ai:default-missing', { target: ev.target, model: ev.model, voice: ev.voice || null, reason: ev.reason, candidate: ev.candidate || null },
            { dedupeKey: `ai-default:${ev.target}:${ev.model}`, summary: `${ev.label || ev.target}: ${what} is ${ev.reason}${ev.candidate ? ` — proposed ${ev.candidate}` : ' — no replacement found'}`.slice(0, 200) });
          return;
        }
        if (ev.type !== 'failed') return;
        if (ev.auth) {
          // One alert per process until a call succeeds again would need a
          // success hook; once per process is the conservative floor.
          if (authAnnounced) return;
          authAnnounced = true;
          publish('ai:auth-required', { app: ev.app, error: ev.error }, { dedupeKey: 'ai-auth', summary: 'Claude is not authenticated — AI calls are failing' });
          return;
        }
        publish('ai:failed', { app: ev.app, model: ev.model || null, code: ev.code, error: String(ev.error || '').slice(0, 300) },
          { dedupeKey: `ai:${ev.app}`, summary: `AI call failed in ${ev.app}: ${String(ev.error || '').slice(0, 80)}`.slice(0, 120) });
      });
    },
    kinds: {
      // The remedy the daily model review stages for a dead default; one kind
      // for text and media targets (model-defaults.js names them).
      'ai.setDefault': {
        identity: (p) => `ai-default:${p.target}:${p.model}:${p.voice || ''}`,
        label: 'Change an AI model default',
        about: 'Points one configured default — the platform model, a Horst role model, or the speech / transcription / image default — at another model (and voice).',
        pinNote: 'Which model runs, and what it costs, is the owner\'s choice — always human-confirmed.',
        ceiling: 'propose',
        defaultLevel: 'propose',
        validate(p) {
          const { req } = require('../horst-facet');
          const t = require('../model-defaults').targetOf(req(p, 'target'));
          const model = req(p, 'model');
          if (t.store === 'media') {
            const catalog = require('../media-catalog');
            const row = catalog.find(model, { method: t.method });
            if (!row) throw new Error(`unknown ${t.method} model "${model}"`);
            if (p.voice != null) {
              if (t.method !== 'ai.tts') throw new Error('voice applies to the speech default only');
              const offered = catalog.voicesFor(row) || [];
              if (!offered.some((v) => String(v.id).toLowerCase() === String(p.voice).toLowerCase())) throw new Error(`voice "${p.voice}" is not offered by ${model}`);
            }
          } else {
            if (p.voice != null) throw new Error('voice applies to the speech default only');
            if (require('../ai-service').textModelHealth(model).ok === false) throw new Error(`model "${model}" is not callable`);
          }
        },
        describe(p) {
          const t = require('../model-defaults').targetOf(p.target);
          return `${t.label} → ${p.model}${p.voice ? ` (voice ${p.voice})` : ''}`;
        },
        execute: (p) => require('../model-defaults').write(p.target, { model: p.model, voice: p.voice }),
      },
    },
  },
};
