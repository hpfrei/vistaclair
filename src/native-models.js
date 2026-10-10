// Non-text models per provider — speech, transcription, image, video, realtime
// voice, embeddings. They are called directly against the provider's own API
// (Pro's ai.tts / ai.transcribe / ai.image), never through Claude Code and the
// proxy, so they are not routable registry entries in models.json. The Models
// page lists them under each provider tab as "native".
//
// `usedBy` names the platform call that uses the model today; an entry without
// it is offered by the provider but not wired up. `price` is the provider's
// list price, for display only — metering lives in Pro's spend-pricing.

const NATIVE_MODELS = {
  openai: [
    { modelId: 'gpt-4o-mini-tts', label: 'GPT-4o mini TTS', kind: 'speech', usedBy: 'ai.tts', price: '$0.015 / 1K chars', description: 'Default ai.tts voice model; tone and style steerable with instructions' },
    { modelId: 'tts-1', label: 'TTS-1', kind: 'speech', usedBy: 'ai.tts', price: '$0.015 / 1K chars' },
    { modelId: 'tts-1-hd', label: 'TTS-1 HD', kind: 'speech', usedBy: 'ai.tts', price: '$0.03 / 1K chars' },
    { modelId: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe', kind: 'transcription', usedBy: 'ai.transcribe', price: '$0.003 / min', description: 'Default ai.transcribe model' },
    { modelId: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe', kind: 'transcription', usedBy: 'ai.transcribe', price: '$0.006 / min', description: "ai.transcribe with accuracy: 'high'" },
    { modelId: 'whisper-1', label: 'Whisper', kind: 'transcription', usedBy: 'ai.transcribe', price: '$0.006 / min', description: 'Word/segment timestamps, SRT and VTT output' },
    { modelId: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare', kind: 'image', usedBy: 'ai.image', description: "ai.image with provider: 'openai' — fast everyday generation" },
    { modelId: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst', kind: 'image', usedBy: 'ai.image', description: 'Highest editing precision' },
    { modelId: 'gpt-image-2', label: 'GPT Image 2', kind: 'image', usedBy: 'ai.image', price: '$5 / $30 per MTok' },
    { modelId: 'gpt-image-1.5', label: 'GPT Image 1.5', kind: 'image', usedBy: 'ai.image' },
    { modelId: 'gpt-realtime-2.1', label: 'GPT Realtime 2.1', kind: 'realtime', price: 'audio $32 / $64 per MTok', description: 'Low-latency speech-to-speech over WebSocket' },
    { modelId: 'text-embedding-3-large', label: 'Text Embedding 3 Large', kind: 'embedding', price: '$0.13 / MTok' },
    { modelId: 'text-embedding-3-small', label: 'Text Embedding 3 Small', kind: 'embedding', price: '$0.02 / MTok' },
  ],
  google: [
    { modelId: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image', kind: 'image', usedBy: 'ai.image', price: '$0.04 / image', description: 'Default ai.image model — generation and editing' },
    { modelId: 'gemini-3-pro-image', label: 'Gemini 3 Pro Image', kind: 'image', usedBy: 'ai.image', price: '$2 / $120 per MTok', description: '4K output and accurate in-image text' },
    { modelId: 'gemini-3.8-flash-tts', label: 'Gemini 3.8 Flash TTS', kind: 'speech', usedBy: 'ai.tts', description: "ai.tts with provider: 'google' — 30 prebuilt voices, style steered by instructions" },
    { modelId: 'gemini-3.8-flash-lite-tts', label: 'Gemini 3.8 Flash-Lite TTS', kind: 'speech', usedBy: 'ai.tts' },
    { modelId: 'gemini-3.1-flash-tts-preview', label: 'Gemini 3.1 Flash TTS', kind: 'speech', usedBy: 'ai.tts', price: '$1 / $20 per MTok', description: 'Preview; earliest shutdown 2026-11-17' },
    { modelId: 'gemini-2.5-pro-preview-tts', label: 'Gemini 2.5 Pro TTS', kind: 'speech', usedBy: 'ai.tts', price: '$1 / $20 per MTok', description: 'Preview; earliest shutdown 2026-11-17' },
    { modelId: 'veo-3.1-generate-preview', label: 'Veo 3.1', kind: 'video' },
    { modelId: 'veo-3.1-fast-generate-preview', label: 'Veo 3.1 Fast', kind: 'video' },
    { modelId: 'veo-3.1-lite-generate-preview', label: 'Veo 3.1 Lite', kind: 'video' },
    { modelId: 'gemini-3.1-flash-live-preview', label: 'Gemini 3.1 Flash Live', kind: 'realtime', price: 'audio $3 / $12 per MTok' },
    { modelId: 'lyria-3-pro-preview', label: 'Lyria 3 Pro', kind: 'music' },
    { modelId: 'gemini-embedding-2', label: 'Gemini Embedding 2', kind: 'embedding', price: '$0.20 / MTok' },
  ],
  xai: [
    { modelId: 'xai-tts', label: 'Grok TTS', kind: 'speech', usedBy: 'ai.tts', price: '$15 / 1M chars', description: "ai.tts with provider: 'xai' — POST /v1/tts takes no model id; voices eve, ara, rex, … or a custom voice" },
    { modelId: 'grok-voice-transcribe-2.0', label: 'Grok Voice Transcribe 2.0', kind: 'transcription', usedBy: 'ai.transcribe', price: '$0.10 / hr', description: "ai.transcribe with provider: 'xai' — diarization, word timings, files up to 500 MB" },
    { modelId: 'grok-voice-think-fast-2.0', label: 'Grok Voice Think Fast 2.0', kind: 'realtime', price: '$0.08 / min', description: 'Speech-to-speech voice agent over WebSocket' },
    { modelId: 'grok-imagine-image-2.0', label: 'Grok Imagine Image 2.0', kind: 'image', usedBy: 'ai.image', price: '$0.04 / image', description: "ai.image with provider: 'xai'" },
    { modelId: 'grok-imagine-image', label: 'Grok Imagine Image', kind: 'image', usedBy: 'ai.image', price: '$0.02 / image' },
    { modelId: 'grok-imagine-image-quality', label: 'Grok Imagine Image Quality', kind: 'image', usedBy: 'ai.image', price: '$0.05 / image' },
    { modelId: 'grok-imagine-video-1.5', label: 'Grok Imagine Video 1.5', kind: 'video', price: '$0.08 / sec' },
    { modelId: 'grok-imagine-video-1.5-lite', label: 'Grok Imagine Video 1.5 Lite', kind: 'video', price: '$0.02 / sec' },
    { modelId: 'grok-imagine-video', label: 'Grok Imagine Video', kind: 'video', price: '$0.05 / sec' },
  ],
};

function nativeModelsFor(providerKey) {
  return (NATIVE_MODELS[providerKey] || []).map(m => ({ ...m }));
}

// Every provider's native models as one flat list, each entry carrying its
// providerKey. This is what Pro reads through the addon ctx (listNativeModels):
// the catalog its media calls resolve a `model` against. Copies, no secrets.
function listNativeModels() {
  return Object.entries(NATIVE_MODELS).flatMap(([providerKey, models]) =>
    models.map(m => ({ providerKey, ...m })));
}

module.exports = { NATIVE_MODELS, nativeModelsFor, listNativeModels };
