// ai.transcribe → xAI POST /v1/stt (multipart; `file` must be the last field).
// Returns { text, language, duration, words[{ text, start, end, speaker? }] }
// — word timings always, speaker labels with `diarize: true`.
const { bearer } = require('../http');

module.exports = {
  method: 'ai.transcribe',
  provider: 'xai',
  label: 'xAI',
  keyProvider: 'xai',
  defaultModel: 'grok-voice-transcribe-2.0',
  seedModels: ['grok-voice-transcribe-2.0'],
  classify: (id) => /^grok-.*transcribe/.test(id),

  describe() {
    return {
      params: ['language', 'diarize'],
      maxBytes: 500 * 1024 * 1024,
      responseFormats: ['json'],
      timestamps: 'always', // word timings on every call — preprocessing keeps internal gaps
      diarize: true,
    };
  },

  buildRequest(g, model, key) {
    const form = new FormData();
    form.append('model', model);
    if (g.language) form.append('language', g.language);
    if (g.diarize) form.append('diarize', 'true');
    form.append('file', new Blob([g.buf], { type: g.mimeType }), g.filename);
    return { url: 'https://api.x.ai/v1/stt', init: { method: 'POST', headers: bearer(key, false), body: form } };
  },
  async parseResponse(res) {
    return await res.json();
  },

  // xAI lists no speech-to-text models, so existence cannot be checked: the
  // daily review leaves this model "unknown" rather than calling it gone.
  listModels: null,
};
