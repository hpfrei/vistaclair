// ai.tts → Gemini generateContent with responseModalities AUDIO and a
// prebuilt voice (speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).
// Output is 24 kHz mono 16-bit: WAV on current models, headerless PCM
// (audio/L16) on older ones — both are normalised to WAV here, then cut to
// raw PCM or transcoded (media-ffmpeg) when another format was asked for.
// `instructions` steers delivery: speech_metadata.style on 3.8+, a spoken-
// style preamble on the older preview models.
const { googleHeaders, getJson, listGemini } = require('../http');

// Prebuilt voices with Google's one-word descriptors.
const VOICES = [
  ['Zephyr', 'Bright'], ['Puck', 'Upbeat'], ['Charon', 'Informative'], ['Kore', 'Firm'], ['Fenrir', 'Excitable'],
  ['Leda', 'Youthful'], ['Orus', 'Firm'], ['Aoede', 'Breezy'], ['Callirrhoe', 'Easy-going'], ['Autonoe', 'Bright'],
  ['Enceladus', 'Breathy'], ['Iapetus', 'Clear'], ['Umbriel', 'Easy-going'], ['Algieba', 'Smooth'], ['Despina', 'Smooth'],
  ['Erinome', 'Clear'], ['Algenib', 'Gravelly'], ['Rasalgethi', 'Informative'], ['Laomedeia', 'Upbeat'], ['Achernar', 'Soft'],
  ['Alnilam', 'Firm'], ['Schedar', 'Even'], ['Gacrux', 'Mature'], ['Pulcherrima', 'Forward'], ['Achird', 'Friendly'],
  ['Zubenelgenubi', 'Casual'], ['Vindemiatrix', 'Gentle'], ['Sadachbia', 'Lively'], ['Sadaltager', 'Knowledgeable'], ['Sulafat', 'Warm'],
];
const FORMATS = ['wav', 'mp3', 'opus', 'aac', 'flac', 'pcm'];
const legacyStyle = (model) => /^gemini-(2\.|3\.1)/.test(model);

// 16-bit PCM → WAV (44-byte RIFF header).
function pcmToWav(pcm, sampleRate = 24000, channels = 1) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

module.exports = {
  method: 'ai.tts',
  provider: 'google',
  label: 'Google (Gemini)',
  keyProvider: 'google',
  defaultModel: 'gemini-3.8-flash-tts',
  seedModels: ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'],
  classify: (id) => /^gemini-.*tts/.test(id),

  describe() {
    return {
      params: ['voice', 'format', 'language', 'instructions'],
      maxChars: null, // token-limited at Google (8,192 input tokens); the API enforces it
      formats: FORMATS,
      defaultFormat: 'wav',
      speed: null,
      instructions: true,
      speechTags: false,
      languages: null, // auto-detected; `language` is passed as a hint
      customVoices: false,
    };
  },
  voices: () => VOICES.map(([id, d]) => ({ id, name: id, description: d })),
  defaultVoice: () => 'Kore',

  buildRequest(g, model, key) {
    const part = { text: g.input };
    if (g.instructions) {
      if (legacyStyle(model)) part.text = `${g.instructions}: ${g.input}`;
      else part.speech_metadata = { style: g.instructions };
    }
    const speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: g.voice } } };
    if (g.language && g.language !== 'auto') speechConfig.languageCode = g.language;
    const body = { contents: [{ parts: [part] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig } };
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      init: { method: 'POST', headers: googleHeaders(key), body: JSON.stringify(body) },
    };
  },
  async parseResponse(res, g) {
    const body = await res.json();
    const parts = body?.candidates?.[0]?.content?.parts || [];
    const inline = parts.map((p) => p.inlineData || p.inline_data).find((d) => d && d.data);
    if (!inline) {
      const reason = body?.candidates?.[0]?.finishReason || body?.promptFeedback?.blockReason;
      throw new Error(`No audio returned${reason ? ` (${reason})` : ''}`);
    }
    const raw = Buffer.from(inline.data, 'base64');
    const mime = String(inline.mimeType || inline.mime_type || '');
    const rate = Number((/rate=(\d+)/.exec(mime) || [])[1]) || 24000;
    const wav = raw.slice(0, 4).toString() === 'RIFF' ? raw : pcmToWav(raw, rate);
    if (g.format === 'wav') return { buf: wav, format: 'wav' };
    if (g.format === 'pcm') return { buf: wav.slice(44), format: 'pcm' };
    const buf = await require('../../media-ffmpeg').transcodeWav(wav, g.format);
    return { buf, format: g.format };
  },

  listModels: (key, memo) => listGemini(key, memo),
  // GET /v1beta/voices also returns the extended library; only the prebuilt
  // voices are offered (they need no voice design and work on every model).
  async listVoices(key, memo) {
    const body = await getJson('https://generativelanguage.googleapis.com/v1beta/voices?pageSize=1000', { 'x-goog-api-key': key }, memo);
    const desc = new Map(VOICES);
    return ((body && body.voices) || [])
      .filter((v) => v && !(v.type && !/prebuilt/i.test(v.type)))
      .map((v) => {
        const id = String(v.id || v.name || '').replace(/^voices\//, '');
        return {
          id,
          name: v.displayName || v.display_name || id,
          language: v.languageCode || v.language_code || null,
          gender: v.gender ? String(v.gender).toLowerCase() : null,
          description: v.description || desc.get(id) || '',
        };
      })
      .filter((v) => v.id);
  },
  pcmToWav,
};
