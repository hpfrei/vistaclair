// The generic ai.image size: a tier ('512' | '1K' | '2K' | '4K') or an
// explicit 'WxH'. Gemini and xAI take a tier plus an aspect ratio; OpenAI takes
// 'WxH'. These convert either way so every adapter accepts both forms.

// '1k' → '1K', '512' → '512', '1536x1024' stays; anything else → null.
function normalizeSize(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d+x\d+$/i.test(s)) return s.toLowerCase();
  if (s === '512') return '512';
  const m = /^(\d)k$/i.exec(s);
  return m ? `${m[1]}K` : null;
}

function ratioOf(aspectRatio) {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(aspectRatio || ''));
  return m ? Number(m[1]) / Number(m[2]) : null;
}

// 'WxH' → { tier, aspectRatio } using the nearest allowed ratio.
function fromDimensions(size, allowedRatios) {
  const [w, h] = size.split('x').map(Number);
  const long = Math.max(w, h);
  const tier = long <= 768 ? '512' : long <= 1536 ? '1K' : long <= 3072 ? '2K' : '4K';
  const r = w / h;
  let best = null;
  for (const a of allowedRatios || []) {
    const ar = ratioOf(a);
    if (ar && (!best || Math.abs(Math.log(ar / r)) < Math.abs(Math.log(ratioOf(best) / r)))) best = a;
  }
  return { tier, aspectRatio: best };
}

// Tier + ratio → OpenAI 'WxH': the tier sets the pixel area, edges are
// multiples of 16, at most 3840 px, between 655,360 and 8,294,400 pixels,
// ratio within 1:3 … 3:1.
const TIER_AREA = { 512: 1024 * 1024, '1K': 1024 * 1024, '2K': 2048 * 2048, '4K': 8294400 };
function toDimensions(tier, aspectRatio) {
  const r = ratioOf(aspectRatio) || 1;
  if (r > 3 || r < 1 / 3) throw new Error(`aspectRatio "${aspectRatio}" is outside OpenAI's 1:3 … 3:1 range`);
  const area = Math.min(Math.max(TIER_AREA[tier] || TIER_AREA['1K'], 655360), 8294400);
  let w = Math.sqrt(area * r);
  let h = Math.sqrt(area / r);
  const scale = Math.min(1, 3840 / Math.max(w, h));
  w = Math.floor((w * scale) / 16) * 16;
  h = Math.floor((h * scale) / 16) * 16;
  return `${w}x${h}`;
}

module.exports = { normalizeSize, ratioOf, fromDimensions, toDimensions };
