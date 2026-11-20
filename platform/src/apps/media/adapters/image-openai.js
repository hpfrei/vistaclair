// ai.image → OpenAI gpt-image. Generation is POST /v1/images/generations
// (JSON); with input images it is POST /v1/images/edits (multipart, image[]
// repeated). OpenAI sizes are 'WxH', so a tier + aspectRatio is converted.
const { bearer, imageInputs, listOpenAICompat } = require('../http');
const { toDimensions } = require('../image-size');

const RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '5:4', '4:5', '21:9'];
const QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];

function sizeFor(g) {
  if (g.size && g.size.includes('x')) return g.size;
  if (!g.size && !g.aspectRatio) return null; // the API default ('auto')
  return toDimensions(g.size || '1K', g.aspectRatio || '1:1');
}

module.exports = {
  method: 'ai.image',
  provider: 'openai',
  label: 'OpenAI',
  keyProvider: 'openai',
  defaultModel: 'gpt-image-2.5-flare',
  seedModels: ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'],
  classify: (id) => /^gpt-image/.test(id),

  describe(model) {
    const v25 = /^gpt-image-2\.5/.test(model);
    return {
      params: ['image', 'aspectRatio', 'size', 'quality'],
      aspectRatios: RATIOS,
      sizes: ['1K', '2K', '4K'],
      explicitSize: true, // 'WxH' is honoured as-is
      qualities: v25 ? QUALITIES : ['low', 'medium', 'high', 'auto'],
      edit: true,
    };
  },

  buildRequest(g, model, key) {
    const size = sizeFor(g);
    const inputs = imageInputs(g);
    if (!inputs.length) {
      const body = { model, prompt: g.prompt, n: 1 };
      if (size) body.size = size;
      if (g.quality) body.quality = g.quality;
      return { url: 'https://api.openai.com/v1/images/generations', init: { method: 'POST', headers: bearer(key), body: JSON.stringify(body) } };
    }
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', g.prompt);
    if (size) form.append('size', size);
    if (g.quality) form.append('quality', g.quality);
    inputs.forEach((img, i) => {
      const ext = (img.mimeType.split('/')[1] || 'png').replace('jpeg', 'jpg');
      form.append('image[]', new Blob([Buffer.from(img.data, 'base64')], { type: img.mimeType }), `image-${i}.${ext}`);
    });
    return { url: 'https://api.openai.com/v1/images/edits', init: { method: 'POST', headers: bearer(key, false), body: form } };
  },
  async parseResponse(res) {
    const body = await res.json();
    const mimeType = `image/${body.output_format || 'png'}`;
    const images = ((body && body.data) || []).filter((d) => d.b64_json).map((d) => ({ data: d.b64_json, mimeType }));
    return { images, text: ((body && body.data) || []).map((d) => d.revised_prompt).filter(Boolean).join('\n') };
  },

  listModels: (key, memo) => listOpenAICompat('https://api.openai.com/v1/models', key, memo),
};
