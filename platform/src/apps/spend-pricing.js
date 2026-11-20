// Unit prices for metered NON-LLM platform calls (USD per unit).
//
// LLM calls (ai.prompt) are priced by core's model registry per token — the
// proxy attaches `pricing` to every interaction. Everything else (speech,
// TTS, image generation, translation, web search, maps) is called with a
// platform-held key at a per-unit price the provider publishes. Those
// providers' models are not in core's registry (they are not chat models),
// so the defaults live here and the admin can override any of them from the
// Spend overview (spend-policy host settings `unitPrices`, keyed by method or
// `method@model`).
//
// A call whose price is unknown is still metered — units recorded, cost 0,
// `priced: false` — and the UI says "unpriced" instead of pretending zero.
const spendPolicy = require('./spend-policy');

const UNITS = {
  tokens: 'tokens (priced by the model registry)',
  audioMinute: 'per minute of audio',
  kChars: 'per 1,000 characters',
  image: 'per image',
  second: 'per second of generated audio',
  request: 'per request',
};

// Defaults: provider list prices at the time of writing. Admin overrides win.
// Every model a media adapter can call has a byModel entry (test/media-pricing
// checks it). `null` means the vendor publishes no per-unit price for it —
// token-priced at the vendor, cost per image/character varies — so the call is
// metered unpriced instead of borrowing the flat rate of a cheaper model.
const DEFAULTS = {
  'ai.prompt':      { unit: 'tokens' },
  'ai.transcribe':  { unit: 'audioMinute', byModel: { 'gpt-4o-mini-transcribe': 0.003, 'gpt-4o-transcribe': 0.006, 'whisper-1': 0.006, 'grok-voice-transcribe-2.0': 0.10 / 60 }, price: 0.006 },
  'ai.tts':         { unit: 'kChars', byModel: {
    'gpt-4o-mini-tts': 0.015, 'tts-1': 0.015, 'tts-1-hd': 0.03, 'xai-tts': 0.015,
    'gemini-3.8-flash-tts': null, 'gemini-3.8-flash-lite-tts': null, 'gemini-3.1-flash-tts-preview': null, 'gemini-2.5-pro-preview-tts': null,
  }, price: 0.015 },
  'ai.image':       { unit: 'image', byModel: {
    'gemini-3.1-flash-image': 0.04, 'gemini-3-pro-image': null,
    'gpt-image-2.5-flare': null, 'gpt-image-2.5-sunburst': null, 'gpt-image-2': null, 'gpt-image-1.5': null,
    'grok-imagine-image-2.0': 0.04, 'grok-imagine-image': 0.02, 'grok-imagine-image-quality': 0.05,
  }, price: 0.04 },
  // ElevenLabs bills sound effects in credits: 40 credits per second when a
  // duration is given (the docs state no figure for an automatic duration, so
  // the measured output seconds are used). USD per credit depends on the plan
  // (~$0.0002 on Creator/Pro, $0.000165 on Scale): 40 x 0.0002 = $0.008/s.
  // Both models are priced alike (no separate v3 price is published).
  'ai.sfx':         { unit: 'second', byModel: { 'eleven_text_to_sound_v3': 0.008, 'eleven_text_to_sound_v2': 0.008 }, price: 0.008 },
  'ai.translate':   { unit: 'kChars', price: 0.02 },
  'ai.detect':      { unit: 'kChars', price: 0.02 },
  'ai.webSearch':   { unit: 'request', price: 0.005 },
  'ai.route':       { unit: 'request', price: 0.005 },
  'ai.routeMatrix': { unit: 'request', price: 0.01 },
  'ai.geocode':     { unit: 'request', price: 0.005 },
  'ai.places':      { unit: 'request', price: 0.032 },
  'ai.placePhoto':  { unit: 'request', price: 0.007 },
  'ai.streetview':  { unit: 'request', price: 0.007 },   // billed per IMAGE; the metadata op is free at Google
  'ai.tiles3d':     { unit: 'request', price: 0.006 },   // billed per ROOT tileset request; child tiles are free
};

function overrides() {
  try { return spendPolicy.loadHost().unitPrices || {}; } catch { return {}; }
}

// { unit, rate, priced, source } for a method (+ optional model).
function rateFor(method, model) {
  const def = DEFAULTS[method];
  if (!def) return { unit: 'request', rate: null, priced: false, source: 'none' };
  if (def.unit === 'tokens') return { unit: 'tokens', rate: null, priced: true, source: 'registry' };
  const ov = overrides();
  if (model && ov[`${method}@${model}`] != null) return { unit: def.unit, rate: ov[`${method}@${model}`], priced: true, source: 'admin' };
  if (ov[method] != null) return { unit: def.unit, rate: ov[method], priced: true, source: 'admin' };
  if (model && def.byModel && Object.prototype.hasOwnProperty.call(def.byModel, model)) {
    const rate = def.byModel[model];
    return rate == null
      ? { unit: def.unit, rate: null, priced: false, source: 'none' }
      : { unit: def.unit, rate, priced: true, source: 'default' };
  }
  if (def.price != null) return { unit: def.unit, rate: def.price, priced: true, source: 'default' };
  return { unit: def.unit, rate: null, priced: false, source: 'none' };
}

// Cost of `units` of a method. Returns { costUsd, priced, unit, rate }.
function price(method, model, units) {
  const r = rateFor(method, model);
  const u = Number(units) || 0;
  if (!r.priced || r.rate == null) return { costUsd: 0, priced: false, unit: r.unit, rate: null };
  return { costUsd: u * r.rate, priced: true, unit: r.unit, rate: r.rate };
}

// The cost sheet: every metered method with its unit and effective rate.
function sheet() {
  return Object.keys(DEFAULTS).map((method) => {
    const r = rateFor(method, null);
    const byModel = {};
    for (const m of Object.keys((DEFAULTS[method].byModel) || {})) byModel[m] = rateFor(method, m).rate;
    return { method, unit: r.unit, unitLabel: UNITS[r.unit] || r.unit, rate: r.rate, priced: r.priced, source: r.source, byModel };
  });
}

module.exports = { UNITS, DEFAULTS, rateFor, price, sheet };
