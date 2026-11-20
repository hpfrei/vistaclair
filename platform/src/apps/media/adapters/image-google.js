// ai.image → Gemini :generateContent with responseModalities TEXT+IMAGE.
// Text-to-image by default; input image(s) in the same request edit them.
// Output carries an invisible SynthID watermark.
const { googleHeaders, imageInputs, listGemini } = require('../http');
const { fromDimensions } = require('../image-size');

const RATIOS = ['1:1', '1:4', '4:1', '1:8', '8:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
function sizesFor(model) {
  if (/flash-lite/.test(model)) return ['1K'];
  if (/3\.1-flash-image/.test(model)) return ['512', '1K', '2K', '4K'];
  return ['1K', '2K', '4K'];
}

module.exports = {
  method: 'ai.image',
  provider: 'google',
  label: 'Google (Gemini)',
  keyProvider: 'google',
  defaultModel: 'gemini-3.1-flash-image',
  seedModels: ['gemini-3.1-flash-image', 'gemini-3-pro-image'],
  classify: (id) => /^gemini-.*image/.test(id),

  describe(model) {
    return { params: ['image', 'aspectRatio', 'size'], aspectRatios: RATIOS, sizes: sizesFor(model), edit: true, maxInputImages: 14 };
  },

  buildRequest(g, model, key) {
    const parts = [{ text: g.prompt }];
    for (const img of imageInputs(g)) parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
    let { aspectRatio, size } = g;
    if (size && size.includes('x')) {
      const d = fromDimensions(size, RATIOS);
      size = d.tier;
      aspectRatio = aspectRatio || d.aspectRatio;
    }
    const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
    if (aspectRatio || size) {
      generationConfig.imageConfig = {};
      if (aspectRatio) generationConfig.imageConfig.aspectRatio = aspectRatio;
      if (size) generationConfig.imageConfig.imageSize = size;
    }
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      init: { method: 'POST', headers: googleHeaders(key), body: JSON.stringify({ contents: [{ parts }], generationConfig }) },
    };
  },
  async parseResponse(res) {
    const body = await res.json();
    const images = [];
    let text = '';
    for (const p of body?.candidates?.[0]?.content?.parts || []) {
      const inline = p.inlineData || p.inline_data;
      if (inline && inline.data) images.push({ data: inline.data, mimeType: inline.mimeType || inline.mime_type || 'image/png' });
      else if (typeof p.text === 'string') text += p.text;
    }
    const reason = body?.candidates?.[0]?.finishReason || body?.promptFeedback?.blockReason;
    return { images, text, reason };
  },

  listModels: (key, memo) => listGemini(key, memo),
};
