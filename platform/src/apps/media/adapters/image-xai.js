// ai.image → xAI grok-imagine. POST /v1/images/generations, or
// /v1/images/edits (JSON, one input image as { url: <data URI>, type:
// 'image_url' }). Always asks for b64_json so the result matches the others.
const { bearer, imageInputs, getJson } = require('../http');
const { fromDimensions } = require('../image-size');

const RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20', '21:9', '5:2', 'auto'];

module.exports = {
  method: 'ai.image',
  provider: 'xai',
  label: 'xAI',
  keyProvider: 'xai',
  defaultModel: 'grok-imagine-image-2.0',
  seedModels: ['grok-imagine-image-2.0'],
  classify: (id) => /^grok-imagine-image/.test(id),

  describe(model) {
    return {
      params: ['image', 'aspectRatio', 'size', ...(/2\.0/.test(model) ? ['quality'] : [])],
      aspectRatios: RATIOS,
      sizes: ['1K', '2K'],
      qualities: /2\.0/.test(model) ? ['low', 'medium', 'auto'] : null,
      edit: true,
      maxInputImages: 1,
    };
  },

  buildRequest(g, model, key) {
    let { aspectRatio, size } = g;
    if (size && size.includes('x')) {
      const d = fromDimensions(size, RATIOS.filter((r) => r !== 'auto'));
      size = d.tier;
      aspectRatio = aspectRatio || d.aspectRatio;
    }
    if (size === '512') size = '1K';
    if (size === '4K') throw new Error('size "4K" is not offered by xAI image models (1K, 2K)');
    const inputs = imageInputs(g);
    if (inputs.length > 1) throw new Error('xAI image editing takes one input image');
    const body = { model, prompt: g.prompt, response_format: 'b64_json' };
    if (inputs.length) {
      body.image = { url: `data:${inputs[0].mimeType};base64,${inputs[0].data}`, type: 'image_url' };
    } else {
      body.n = 1;
      if (aspectRatio) body.aspect_ratio = aspectRatio;
      if (size) body.resolution = size.toLowerCase();
    }
    if (g.quality) body.quality = g.quality;
    const url = `https://api.x.ai/v1/images/${inputs.length ? 'edits' : 'generations'}`;
    return { url, init: { method: 'POST', headers: bearer(key), body: JSON.stringify(body) } };
  },
  async parseResponse(res) {
    const body = await res.json();
    const images = ((body && body.data) || []).filter((d) => d.b64_json).map((d) => ({ data: d.b64_json, mimeType: d.mime_type || 'image/jpeg' }));
    return { images, text: ((body && body.data) || []).map((d) => d.revised_prompt).filter(Boolean).join('\n') };
  },

  async listModels(key, memo) {
    const body = await getJson('https://api.x.ai/v1/image-generation-models', bearer(key, false), memo);
    const rows = (body && (body.models || body.data)) || [];
    const ids = [];
    for (const m of rows) {
      if (!m || !m.id) continue;
      ids.push(m.id);
      for (const a of m.aliases || []) ids.push(a);
    }
    return { ids, shutdown: {} };
  },
};
