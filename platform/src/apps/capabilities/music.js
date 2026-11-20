// Capability: music — `ai.music.generate/analyze/status` — local MusicGen (optional extra)
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and docs/capabilities.md.

const path = require('path');
const { safeJoin } = require('../../utils');

module.exports = {
  key: 'music',
  title: 'Local Music Generation',
  core: false,
  gated: true,
  methods: ['ai.music.generate', 'ai.music.analyze', 'ai.music.status'],
  prefixes: ['ai.music.'],
  impliedBy: ['ai'],
  ctx: ['music'],
  keywords: /\b(music|soundtrack|song|melody|jingle|beat|bpm|tempo|musicgen|background track|audio bed)\b/i,
  summary: '`ai.music.generate/analyze/status` — local MusicGen (optional extra)',

  buildCtx(app) {
    const dir = app.dir;
    // Local music ML (MusicGen + beat analysis), installed via Setup > Extras.
    // generate() is queued platform-wide (concurrency 1) and takes minutes on
    // CPU — call it from inside a ctx.jobs run (or use the ai.music.generate
    // bridge method, which is already job-shaped). Paths are app-relative.
    return {
      music: {
        status: () => require('../music-ml').status(),
        generate: (params) => {
          if (!params || !params.out) throw new Error('music.generate requires an app-relative "out" path');
          return require('../music-ml').generate({
            ...params,
            outFile: safeJoin(dir, params.out),
            continueFrom: params.continueFrom ? safeJoin(dir, params.continueFrom) : undefined,
          });
        },
        analyze: (params) => require('../music-ml').analyze({ ...(params || {}), file: safeJoin(dir, (params || {}).file) }),
      },
    };
  },

  bridge: {
    'ai.music.status': async () => require('../music-ml').status(),
    // Generation takes minutes (CPU MusicGen), so it's job-shaped: returns
    // {jobId} immediately; progress/result flow through the jobs.* machinery
    // (GUI-reload resilient). Output lands inside the app's sandbox.
    'ai.music.generate': async (app, params) => {
      const musicMl = require('../music-ml');
      const p = params || {};
      const rel = p.out || path.join('.data', 'music', Date.now().toString(36) + '.wav');
      const outFile = app.resolvePath(rel);
      const job = require('../app-jobs').startJob(app.name, {
        name: 'ai.music.generate',
        meta: { prompt: String(p.prompt || '').slice(0, 120), out: rel },
        run: async (job) => {
          job.setProgress(1, 'queued');
          const res = await musicMl.generate({
            prompt: p.prompt,
            duration: p.duration,
            seed: p.seed,
            model: p.model,
            continueFrom: p.continueFrom ? app.resolvePath(p.continueFrom) : undefined,
            outFile,
            signal: job.signal,
            onQueue: (pos) => job.setProgress(1, `queued behind ${pos} generation${pos > 1 ? 's' : ''}`),
            onStart: () => job.setProgress(10, 'generating (minutes on CPU)'),
          });
          job.setProgress(100, 'done');
          return { out: rel, duration: res.duration, model: res.model, seed: res.seed };
        },
      });
      return { jobId: job.id };
    },
    'ai.music.analyze': async (app, params) => {
      const p = params || {};
      return require('../music-ml').analyze({ file: app.resolvePath(p.file), tightness: p.tightness });
    },
  },

  horst: {
    lane: {
      direct: {
        'ai.music.generate': { deferred: 'local MusicGen takes minutes on CPU — a direct tool would hold the chat turn; it needs a job route for facet tools' },
        'ai.music.analyze': { deferred: 'beat analysis of an app file; no chat request behind it yet' },
        'ai.music.status': { deferred: 'only meaningful once generate is reachable' },
      },
    },
  },
};
