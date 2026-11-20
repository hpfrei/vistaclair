// ai.transcribe → OpenAI POST /v1/audio/transcriptions (multipart). whisper-1
// is the model with word/segment timestamps and srt/vtt output.
const { bearer, listOpenAICompat } = require('../http');

module.exports = {
  method: 'ai.transcribe',
  provider: 'openai',
  label: 'OpenAI',
  keyProvider: 'openai',
  defaultModel: 'gpt-4o-mini-transcribe',
  // `accuracy: 'high'` picks this one when no model is named.
  accurateModel: 'gpt-4o-transcribe',
  seedModels: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'],
  classify: (id) => /transcribe|^whisper/.test(id) && !/realtime/.test(id),

  describe(model) {
    const whisper = /^whisper/.test(model);
    return {
      params: ['language', 'prompt', 'response_format', 'temperature', ...(whisper ? ['timestamp_granularities'] : [])],
      maxBytes: 25 * 1024 * 1024,
      responseFormats: whisper ? ['json', 'text', 'srt', 'verbose_json', 'vtt'] : ['json', 'text'],
      timestamps: whisper,
      diarize: false,
    };
  },

  buildRequest(g, model, key) {
    const form = new FormData();
    form.append('file', new Blob([g.buf], { type: g.mimeType }), g.filename);
    form.append('model', model);
    if (g.language) form.append('language', g.language);
    if (g.prompt) form.append('prompt', g.prompt);
    if (g.response_format) form.append('response_format', g.response_format);
    if (g.temperature != null) form.append('temperature', String(g.temperature));
    if (Array.isArray(g.timestamp_granularities)) {
      for (const t of g.timestamp_granularities) form.append('timestamp_granularities[]', t);
    }
    return { url: 'https://api.openai.com/v1/audio/transcriptions', init: { method: 'POST', headers: bearer(key, false), body: form } };
  },
  // json/verbose_json → the body as-is; text/srt/vtt → { text }.
  async parseResponse(res) {
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) return await res.json();
    return { text: await res.text() };
  },

  listModels: (key, memo) => listOpenAICompat('https://api.openai.com/v1/models', key, memo),
};
