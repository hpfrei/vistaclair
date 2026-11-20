// ai.tts → OpenAI POST /v1/audio/speech. gpt-4o-mini-tts honours
// `instructions` (tone/style/accent); tts-1 / tts-1-hd ignore it and offer a
// smaller voice set. A custom voice id (voice_…) is sent as { id }.
const { bearer, listOpenAICompat } = require('../http');

const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
const LEGACY_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];
const FORMATS = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'];
const legacy = (model) => /^tts-1/.test(model);
const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

module.exports = {
  method: 'ai.tts',
  provider: 'openai',
  label: 'OpenAI',
  keyProvider: 'openai',
  defaultModel: 'gpt-4o-mini-tts',
  seedModels: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
  classify: (id) => /(^|-)tts(-|$)/.test(id) && !/realtime|search/.test(id),

  describe(model) {
    return {
      params: ['voice', 'format', 'speed', ...(legacy(model) ? [] : ['instructions'])],
      maxChars: 4096,
      formats: FORMATS,
      defaultFormat: 'mp3',
      speed: [0.25, 4],
      instructions: !legacy(model),
      speechTags: false,
      languages: null, // follows the input text
      customVoices: true,
    };
  },
  voices: (model) => (legacy(model) ? LEGACY_VOICES : VOICES).map((id) => ({ id, name: titleCase(id) })),
  defaultVoice: () => 'alloy',

  buildRequest(g, model, key) {
    const body = { model, input: g.input, voice: /^voice_/.test(g.voice) ? { id: g.voice } : g.voice, response_format: g.format };
    if (g.instructions && !legacy(model)) body.instructions = g.instructions;
    if (g.speed != null) body.speed = Number(g.speed);
    return { url: 'https://api.openai.com/v1/audio/speech', init: { method: 'POST', headers: bearer(key), body: JSON.stringify(body) } };
  },
  async parseResponse(res, g) {
    return { buf: Buffer.from(await res.arrayBuffer()), format: g.format };
  },

  listModels: (key, memo) => listOpenAICompat('https://api.openai.com/v1/models', key, memo),
  listVoices: null, // OpenAI has no voice-listing endpoint; the static list above is the truth
};
