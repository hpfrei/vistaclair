// `sound_generate` — a built-in tool of a broker holder session (an
// orchestrator's `app-tools` catalog or a worker's `apps` grant server), so a
// CLI session can ask for a sound effect and get the file. docs/app-tools.md
// "Built-in tools". It calls the one engine (ai-media.aiSfx), stores the clip
// as an artifact the run may read (the same store Horst's sound_generate uses,
// horst-facet.storeArtifact) and, with `dest`, also writes it into
// holder.cwd under the artifact tools' path rules (app-artifacts.copyTo).
// Spend: the `platform` profile, like Horst's direct tools, with the run's
// identity in the spend context's caller.

const artifacts = require('./app-artifacts');

const HOLDER_TYPES = new Set(['orchestrator', 'worker']);

const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });
const runOf = (session) => {
  const h = session && session.holder;
  return h && HOLDER_TYPES.has(h.type) && h.runId ? h : null;
};

const builtinTools = [
  {
    name: 'sound_generate',
    description: 'Generate a sound effect from a text description (ElevenLabs): a door slam, rain, a UI click, a looping ambience. Returns { uri, path?, mime, format, ext, sampleRate, durationSeconds, bytes, model } and the clip as a vc-artifact resource_link. Pass `dest` (a path relative to your working directory) to also get the file written there. Formats: mp3 (default), wav, ogg, pcm. `loop: true` with no format gives a wav (an mp3 has a gap at the loop point). Metered (ai.sfx, platform spend policy).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What the sound is, e.g. "heavy wooden door slamming in a stone hall"' },
        dest: { type: 'string', description: 'Destination path relative to your working directory, e.g. assets/door.mp3; parent folders are created' },
        durationSeconds: { type: 'number', description: '0.5 to 30; omit for automatic' },
        loop: { type: 'boolean', description: 'A seamlessly looping sound' },
        promptInfluence: { type: 'number', description: '0 to 1: how literally the prompt is followed' },
        format: { type: 'string', enum: ['mp3', 'wav', 'ogg', 'pcm'] },
        sampleRate: { type: 'number', description: 'wav / pcm only: 8000 … 48000 (default 44100)' },
        model: { type: 'string', description: 'An ai.sfx model id; omit for the configured default' },
      },
      required: ['prompt'],
    },
    when: (session) => !!runOf(session),
    handler: async (args, session) => {
      const holder = runOf(session);
      if (!holder) return fail('This session does not belong to an orchestration run.');
      const a = args || {};
      if (!a.prompt || typeof a.prompt !== 'string') return fail('prompt is required');
      // Refuse a bad destination before any money is spent.
      if (a.dest !== undefined && a.dest !== null && a.dest !== '') {
        if (!holder.cwd) return fail('Your working directory is unknown to the platform, so nothing can be written into it.');
        try { artifacts.resolveInside(holder.cwd, String(a.dest), { mustExist: false }); } catch (err) { return fail(err.message); }
      }
      const params = { prompt: a.prompt };
      for (const k of ['durationSeconds', 'loop', 'promptInfluence', 'format', 'sampleRate', 'model']) if (a[k] != null && a[k] !== '') params[k] = a[k];
      const f = require('./horst-facet');
      const spendContext = require('./spend-context');
      const appTools = require('./app-tools');
      try {
        return await spendContext.run(
          { app: 'platform', origin: 'mcp', principal: 'owner', subscribed: true, caller: appTools.callerRecord({ ...holder, origin: 'mcp' }) },
          () => f.spendSafe(async () => {
            const r = await require('./ai-media').aiSfx('platform', params);
            const link = await f.storeArtifact(Buffer.from(r.audio, 'base64'), {
              mime: r.mime, name: `sound-${Date.now().toString(36)}.${r.ext}`, tool: 'sound_generate', caller: holder,
            });
            const out = {
              uri: link.uri, mime: r.mime, format: r.format, ext: r.ext, sampleRate: r.sampleRate,
              durationSeconds: r.durationSeconds, bytes: r.bytes, model: r.model,
              ...(r.loop ? { loop: true } : {}), ...(r.ignored ? { ignored: r.ignored } : {}),
            };
            if (a.dest) {
              const run = { type: 'run', runId: String(holder.runId) };
              out.path = artifacts.copyTo(link.uri, holder.cwd, String(a.dest), run).path;
            }
            return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }, link] };
          }),
        );
      } catch (err) {
        return fail(err.message);
      }
    },
  },
];

module.exports = { builtinTools };
