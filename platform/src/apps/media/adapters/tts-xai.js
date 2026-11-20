// ai.tts → xAI POST /v1/tts (Grok voices). The endpoint takes no model id;
// 'xai-tts' names it in the catalog and for metering. No `instructions` —
// delivery is steered with inline speech tags ([pause], <whisper>…</whisper>).
const { bearer, getJson } = require('../http');

const FORMATS = ['mp3', 'wav', 'pcm', 'mulaw', 'alaw'];
const LANGUAGES = ['auto', 'en', 'ar-EG', 'ar-SA', 'ar-AE', 'bn', 'zh', 'fr', 'de', 'hi', 'id', 'it', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'es-MX', 'es-ES', 'tr', 'vi'];
// Used until the daily refresh has read GET /v1/tts/voices.
const VOICES = ['eve', 'ara', 'leo', 'rex', 'sal'];
const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

module.exports = {
  method: 'ai.tts',
  provider: 'xai',
  label: 'xAI',
  keyProvider: 'xai',
  defaultModel: 'xai-tts',
  seedModels: ['xai-tts'],
  classify: () => false, // no TTS model ids to discover

  describe() {
    return {
      params: ['voice', 'format', 'speed', 'language', 'sampleRate', 'bitRate'],
      maxChars: 60000,
      formats: FORMATS,
      defaultFormat: 'mp3',
      speed: [0.7, 1.5],
      instructions: false,
      speechTags: true, // performs [laugh] / <whisper>…</whisper> itself
      languages: LANGUAGES,
      sampleRate: [8000, 48000],
      bitRate: [32000, 192000],
      customVoices: true,
    };
  },
  voices: () => VOICES.map((id) => ({ id, name: titleCase(id) })),
  defaultVoice: () => 'eve',

  buildRequest(g, model, key) {
    const outputFormat = { codec: g.format };
    if (g.sampleRate != null) outputFormat.sample_rate = Number(g.sampleRate);
    if (g.bitRate != null) outputFormat.bit_rate = Number(g.bitRate);
    const body = { text: g.input, voice_id: g.voice, language: g.language || 'auto', output_format: outputFormat };
    if (g.speed != null) body.speed = g.speed;
    return { url: 'https://api.x.ai/v1/tts', init: { method: 'POST', headers: bearer(key), body: JSON.stringify(body) } };
  },
  async parseResponse(res, g) {
    return { buf: Buffer.from(await res.arrayBuffer()), format: g.format };
  },

  // The voice listing doubles as the existence probe for the id-less model.
  async listModels(key, memo) {
    await getJson('https://api.x.ai/v1/tts/voices', bearer(key, false), memo);
    return { ids: ['xai-tts'], shutdown: {} };
  },
  async listVoices(key, memo) {
    const body = await getJson('https://api.x.ai/v1/tts/voices', bearer(key, false), memo);
    return ((body && body.voices) || []).filter((v) => v && v.voice_id).map((v) => ({
      id: v.voice_id,
      name: v.name || titleCase(v.voice_id),
      language: v.language || null,
      gender: v.gender || null,
      description: v.description || v.tone || '',
    }));
  },
};
