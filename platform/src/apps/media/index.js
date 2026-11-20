// Media adapters — one module per (method, vendor). An adapter turns the
// provider-neutral params of ai.tts / ai.transcribe / ai.image into that
// vendor's request and its response back into the generic result. ai-media.js
// owns the call flow (resolve → key → request → retries → result); the
// adapters own only what differs per vendor. See docs/models.md.
//
// Adapter shape:
//   method, provider, label, keyProvider    — which call, which vendor, which Models-page key
//   defaultModel, seedModels                — used when core's catalog is unavailable
//   classify(id)                            — does a live model id belong to this adapter?
//   describe(model)                         — capability descriptor: params it honours, limits, formats…
//   voices(model), defaultVoice(model)      — ai.tts only: the static voice list
//   buildRequest(generic, model, key)       — { url, init } for fetch
//   parseResponse(res, generic, model)      — the method's generic result
//   listModels(key) / listVoices(key)       — live listings for the daily refresh (null = cannot check)

const ADAPTERS = [
  require('./adapters/tts-openai'),
  require('./adapters/tts-xai'),
  require('./adapters/tts-google'),
  require('./adapters/transcribe-openai'),
  require('./adapters/transcribe-xai'),
  require('./adapters/image-google'),
  require('./adapters/image-openai'),
  require('./adapters/image-xai'),
  require('./adapters/sfx-elevenlabs'),
];

// The catalog `kind` each method serves, and the vendor whose default model is
// the platform's built-in default for it (what a call gets with nothing set).
const METHOD_KIND = { 'ai.tts': 'speech', 'ai.transcribe': 'transcription', 'ai.image': 'image', 'ai.sfx': 'sfx' };
const BUILTIN_PROVIDER = { 'ai.tts': 'openai', 'ai.transcribe': 'openai', 'ai.image': 'google', 'ai.sfx': 'elevenlabs' };
const METHOD_LABEL = { 'ai.tts': 'TTS', 'ai.transcribe': 'transcription', 'ai.image': 'image', 'ai.sfx': 'sound effect' };

// Generic params per method, beyond the payload itself (input / audio / prompt).
// A caller-supplied one the resolved model does not honour comes back in
// result.ignored — never silently dropped.
const GENERIC_PARAMS = {
  'ai.tts': ['voice', 'format', 'speed', 'language', 'instructions', 'sampleRate', 'bitRate'],
  'ai.transcribe': ['language', 'prompt', 'response_format', 'temperature', 'timestamp_granularities', 'diarize'],
  'ai.image': ['image', 'aspectRatio', 'size', 'quality'],
  'ai.sfx': ['durationSeconds', 'loop', 'promptInfluence', 'format', 'sampleRate'],
};

function adapter(method, provider) {
  return ADAPTERS.find((a) => a.method === method && a.provider === provider) || null;
}
function adaptersFor(method) {
  return ADAPTERS.filter((a) => a.method === method);
}
function builtinAdapter(method) {
  return adapter(method, BUILTIN_PROVIDER[method]);
}
function adapterKey(a) {
  return `${a.method}:${a.provider}`;
}

// The caller's generic params this model will not use.
function ignoredParams(method, a, model, params) {
  const honoured = new Set(a.describe(model).params || []);
  return (GENERIC_PARAMS[method] || []).filter((k) => {
    const v = params && params[k];
    return v !== undefined && v !== null && v !== '' && !honoured.has(k);
  });
}

module.exports = {
  ADAPTERS, METHOD_KIND, BUILTIN_PROVIDER, METHOD_LABEL, GENERIC_PARAMS,
  adapter, adaptersFor, builtinAdapter, adapterKey, ignoredParams,
};
