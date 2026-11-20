// The configured AI model defaults, as one list of named targets: where each
// is stored and how it is read and written. The daily model review
// (agent/horst-model-review.js) checks every target, and the ai.setDefault
// governance kind (capabilities/ai.js) writes one. The stores stay where they
// are — platform settings, Horst's settings, platform `mediaDefaults` — this
// module only names them, so no second writer of a setting exists.
//
//   text   platform.directModel / platform.memoryModel / horst.<role>Model
//   media  media.ai.tts / media.ai.transcribe / media.ai.image / media.ai.sfx
//          (mediaDefaults[method]; unset = the built-in default)

const TEXT_TARGETS = [
  { target: 'platform.directModel', label: 'Platform default model (ai.prompt)', store: 'platform', key: 'directModel' },
  // memoryAiModel() clamps anything else to haiku, so only these are candidates.
  { target: 'platform.memoryModel', label: 'Memory model', store: 'platform', key: 'memoryModel', accept: (m) => /haiku|deepseek/i.test(m.name) },
  { target: 'horst.chatModel', label: 'Horst chat model', store: 'horst', key: 'chatModel' },
  { target: 'horst.briefingModel', label: 'Horst briefing model', store: 'horst', key: 'briefingModel' },
  { target: 'horst.triageModel', label: 'Horst triage model', store: 'horst', key: 'triageModel' },
  { target: 'horst.directiveModel', label: 'Horst directive model', store: 'horst', key: 'directiveModel' },
];
const MEDIA_LABEL = { 'ai.tts': 'Default speech (TTS) model', 'ai.transcribe': 'Default transcription model', 'ai.image': 'Default image model', 'ai.sfx': 'Default sound-effect model' };
const MEDIA_TARGETS = Object.keys(MEDIA_LABEL).map((method) => ({ target: `media.${method}`, label: MEDIA_LABEL[method], store: 'media', method }));
const TARGETS = [...TEXT_TARGETS, ...MEDIA_TARGETS];

function targetOf(name) {
  const t = TARGETS.find((x) => x.target === name);
  if (!t) throw new Error(`unknown model default "${name}" (${TARGETS.map((x) => x.target).join(', ')})`);
  return t;
}

const platformSettings = () => require('./platform-settings');
const horstSettings = () => require('./agent/horst-settings');
const mediaDefaults = () => ({ ...(platformSettings().get('mediaDefaults') || {}) });

// { model, voice? } as configured; model '' / null = unset (the platform
// default for horst.chatModel, the built-in default for a media target).
function read(name) {
  const t = targetOf(name);
  if (t.store === 'platform') return { model: platformSettings().get(t.key) || '' };
  if (t.store === 'horst') return { model: horstSettings().get()[t.key] || '' };
  const d = mediaDefaults()[t.method] || {};
  return { model: d.model || '', ...(d.voice ? { voice: d.voice } : {}) };
}

// Sets the model (and, for TTS, the voice). A model change without a voice
// drops a stored voice the new model does not offer — the voice belongs to
// the model; the other stored media params (format, speed, …) are kept.
function write(name, { model, voice } = {}) {
  const t = targetOf(name);
  if (!model || typeof model !== 'string') throw new Error('model is required');
  if (t.store === 'platform') { platformSettings().set(t.key, model); return read(name); }
  if (t.store === 'horst') { horstSettings().set({ [t.key]: model }); return read(name); }
  const all = mediaDefaults();
  const next = { ...(all[t.method] || {}), model };
  if (voice) next.voice = voice;
  else if (next.voice) {
    const catalog = require('./media-catalog');
    const row = catalog.find(model, { method: t.method });
    const offered = (row && catalog.voicesFor(row)) || [];
    if (!offered.some((v) => String(v.id).toLowerCase() === String(next.voice).toLowerCase())) delete next.voice;
  }
  all[t.method] = next;
  platformSettings().set('mediaDefaults', all);
  return read(name);
}

module.exports = { TARGETS, TEXT_TARGETS, MEDIA_TARGETS, targetOf, read, write };
