// ai.sfx → ElevenLabs POST /v1/sound-generation (text to sound effects).
// Request: `output_format` query param; JSON body { text, model_id,
// duration_seconds?, prompt_influence?, loop? }; auth header `xi-api-key`.
//
// Generic formats and what ElevenLabs is asked for:
//   mp3  → mp3_44100_128   (CBR; served as is)
//   wav  → pcm_<rate>      (raw s16le mono; the RIFF header is added here, no ffmpeg)
//   pcm  → pcm_<rate>      (served as is, rate in the result)
//   ogg  → opus_48000_128  (an Ogg Opus file; anything else is refused)
// ElevenLabs lists no sound-effect models (its /v1/models is TTS), so no listing.
const { wavFromPcm, pcmSeconds, mp3Seconds, oggOpusSeconds, isOgg } = require('../audio-container');

const FORMATS = ['mp3', 'wav', 'ogg', 'pcm'];
const SAMPLE_RATES = [8000, 16000, 22050, 24000, 32000, 44100, 48000];
const DEFAULT_RATE = 44100;
// 44.1 kHz PCM needs ElevenLabs' Pro tier; a lower plan is answered with a tier
// error and the call is repeated once at this rate (see `fallback`).
const FALLBACK_RATE = 24000;
const MP3_BITRATE = 128000;
// `loop` is only offered by the v2 model (ElevenLabs docs); v3 ignores it, so
// the engine picks v2 for a looping call that named no model.
const V2 = 'eleven_text_to_sound_v2'; // deprecated by ElevenLabs, removal 2027-03-01
const V3 = 'eleven_text_to_sound_v3';

const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', pcm: 'audio/L16' };
const EXT = { mp3: 'mp3', wav: 'wav', ogg: 'ogg', pcm: 'pcm' };
const pcmRate = (g) => Number(g.sampleRate) || DEFAULT_RATE;

module.exports = {
  method: 'ai.sfx',
  provider: 'elevenlabs',
  label: 'ElevenLabs',
  keyProvider: 'elevenlabs',
  keyWhere: 'in Apps → Setup → AI Config',
  defaultModel: V3,
  loopModel: V2,
  seedModels: [V3, V2],
  classify: (id) => /^eleven_text_to_sound/.test(id),
  FORMATS, SAMPLE_RATES, DEFAULT_RATE,

  describe(model) {
    return {
      params: ['durationSeconds', 'promptInfluence', 'format', 'sampleRate', ...(model === V2 ? ['loop'] : [])],
      formats: FORMATS,
      defaultFormat: 'mp3',
      loopFormat: 'wav',
      duration: [0.5, 30],
      influence: [0, 1],
      loop: model === V2,
      sampleRates: SAMPLE_RATES,
      defaultSampleRate: DEFAULT_RATE,
    };
  },

  outputFormat(g) {
    if (g.format === 'mp3') return 'mp3_44100_128';
    if (g.format === 'ogg') return 'opus_48000_128';
    return `pcm_${pcmRate(g)}`; // wav, pcm
  },

  buildRequest(g, model, key) {
    const body = { text: g.prompt, model_id: model };
    if (g.durationSeconds != null) body.duration_seconds = Number(g.durationSeconds);
    if (g.promptInfluence != null) body.prompt_influence = Number(g.promptInfluence);
    if (g.loop === true && model === V2) body.loop = true;
    const url = `https://api.elevenlabs.io/v1/sound-generation?output_format=${this.outputFormat(g)}`;
    return { url, init: { method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } };
  },

  // A tier-restricted output (44.1 kHz PCM/WAV is Pro-only) → the same call at
  // a lower rate, once. Only when the caller did not pick the rate.
  fallback(g, status, text) {
    if (g.format !== 'wav' && g.format !== 'pcm') return null;
    if (g.sampleRateFromCall || pcmRate(g) <= FALLBACK_RATE) return null;
    if (![400, 401, 402, 403, 422].includes(status)) return null;
    if (!/tier|plan|subscription|upgrade|output_format|not allowed/i.test(text || '')) return null;
    return { ...g, sampleRate: FALLBACK_RATE };
  },

  // → { buf, format, mime, ext, sampleRate, durationSeconds }
  async parseResponse(res, g) {
    const raw = Buffer.from(await res.arrayBuffer());
    if (!raw.length) throw new Error('ElevenLabs returned no audio');
    const base = { format: g.format, mime: MIME[g.format], ext: EXT[g.format] };
    if (g.format === 'mp3') return { ...base, buf: raw, sampleRate: 44100, durationSeconds: mp3Seconds(raw, MP3_BITRATE) };
    if (g.format === 'ogg') {
      if (!isOgg(raw)) throw new Error('ElevenLabs returned opus that is not an Ogg file; ask for format mp3 or wav');
      return { ...base, buf: raw, sampleRate: 48000, durationSeconds: oggOpusSeconds(raw) };
    }
    const rate = pcmRate(g);
    const durationSeconds = pcmSeconds(raw.length, rate);
    if (g.format === 'wav') return { ...base, buf: wavFromPcm(raw, rate), sampleRate: rate, durationSeconds };
    return { ...base, buf: raw, sampleRate: rate, durationSeconds };
  },

  listModels: null,
};
