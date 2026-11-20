// First-class media AI for apps — speech-to-text, text-to-speech, image
// generation/editing, sound effects, translation and language detection. Backs the `audio`
// capability (ai.transcribe/tts/image/sfx/translate/detect) and the matching ctx
// members. The model resolution chain and the per-vendor adapters
// (src/apps/media) are shared by tts/transcribe/image/sfx. Keys come from the
// platform's encrypted secrets store via core.resolveProviderKey (Models page →
// openai / xai / google; ElevenLabs → Setup → AI Config); binary in/out crosses the bridge as base64. Endpoints
// are fixed first-party hosts, so calls use the global fetch directly (not the
// SSRF-guarded http.fetch path).

const fs = require('fs');
const path = require('path');
const appManager = require('./app-manager');
const spawnManager = require('./spawn-manager');
const { core } = require('./core-services');

function _decodeBase64Audio(audio) {
  if (!audio || typeof audio !== 'string') {
    throw new Error('audio is required (base64-encoded string)');
  }
  // Accept data URIs (data:audio/mp3;base64,XXXX) and raw base64.
  const comma = audio.indexOf(',');
  const b64 = audio.startsWith('data:') && comma !== -1 ? audio.slice(comma + 1) : audio;
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new Error('audio decoded to empty buffer');
  return buf;
}

// Persist the preprocessed (loudnorm + VAD-trimmed) audio so the caller can grab
// it after transcription, then self-destruct. Lives in <root>/enhanced-audios/.
// Consumers MUST copy/read the returned path within ENHANCED_AUDIO_TTL_MS — after
// that the file is deleted. Best-effort: a write failure just omits the path.
const ENHANCED_AUDIO_TTL_MS = 60 * 1000;
function _enhancedAudioDir() {
  // APPS_DIR is <root>/vistaclair-apps; the platform root is its parent.
  return path.join(path.dirname(appManager.APPS_DIR), 'enhanced-audios');
}
function _saveEnhancedAudio(appName, buf, ext) {
  try {
    const dir = _enhancedAudioDir();
    fs.mkdirSync(dir, { recursive: true });
    const safeApp = String(appName || 'app').replace(/[^a-zA-Z0-9_-]/g, '_');
    const name = `${safeApp}-${spawnManager.currentId()}-${process.hrtime.bigint().toString(36)}.${ext || 'flac'}`;
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, buf);
    const timer = setTimeout(() => {
      try { fs.rmSync(filePath, { force: true }); } catch {}
    }, ENHANCED_AUDIO_TTL_MS);
    if (timer.unref) timer.unref();
    return filePath;
  } catch (err) {
    console.warn(`[app-bridge] failed to store enhanced audio: ${err.message}`);
    return null;
  }
}

// ---- Model resolution — one chain for every media call -----------------------
// ai.tts / ai.transcribe / ai.image all resolve their model the same way:
//   1. params.model           — a catalog modelId ('provider/model' also accepted)
//   2. params.provider alone  — that vendor's default model for the method
//   3. the platform default   — platform-settings `mediaDefaults[method].model`
//                               (Apps → Setup → AI Config); skipped with a toast
//                               when the daily refresh found it gone
//   4. the built-in default   — media.BUILTIN_PROVIDER's adapter default
// The other platform defaults (voice, format, language, aspectRatio, …) fill
// any param the call leaves out, when the resolved model honours it; a default
// voice the model does not offer yields that model's own default voice.
// An unknown model, or one the vendor answers "not found" for, fails the call
// and raises ai:model-unavailable (Telegram) — keeping a model current is the
// app's job. See docs/models.md.
const media = require('./media');
const mediaCatalog = require('./media-catalog');
const { normalizeSize } = require('./media/image-size');
const speechTags = require('./media/speech-tags');

function toast(level, title, message) {
  if (!core.broadcaster) return;
  core.broadcaster.broadcast({ type: 'toast:push', sender: 'Vistaclair', level, title, message, ts: Date.now() });
}

const _fallbackToasted = new Set();

function resolveMediaModel(appName, method, params = {}) {
  const label = media.METHOD_LABEL[method];
  const state = mediaCatalog.loadState();
  let model = params.model ? String(params.model).trim() : '';
  let provider = params.provider ? String(params.provider).trim() : '';
  const slash = model.indexOf('/');
  if (slash > 0 && media.adapter(method, model.slice(0, slash))) {
    const p = model.slice(0, slash);
    if (provider && provider !== p) throw new Error(`model "${model}" names provider "${p}", but provider "${provider}" was given`);
    provider = p;
    model = model.slice(slash + 1);
  }
  if (provider && !media.adapter(method, provider)) {
    throw new Error(`unknown ${label} provider "${provider}" (${media.adaptersFor(method).map((a) => a.provider).join(', ')})`);
  }

  if (model) {
    const row = mediaCatalog.find(model, { method }, state);
    if (!row) {
      const other = mediaCatalog.find(model, {}, state);
      const valid = mediaCatalog.rows(state).filter((r) => r.method === method).map((r) => r.modelId);
      require('./ai-service').notifyModelUnavailable(appName, method, model, other ? 'wrong-kind' : 'unknown');
      if (other) throw new Error(`model "${model}" is a ${other.kind} model (${other.method}), not usable with ${method}. Valid: ${valid.join(', ')}`);
      throw new Error(`unknown ${label} model "${model}". Valid: ${valid.join(', ')}`);
    }
    if (provider && row.provider !== provider) throw new Error(`model "${model}" belongs to provider "${row.provider}", not "${provider}"`);
    return { adapter: media.adapter(method, row.provider), model, source: 'call' };
  }
  if (provider) {
    const a = media.adapter(method, provider);
    return { adapter: a, model: a.defaultModel, source: 'provider' };
  }
  const conf = mediaCatalog.configuredDefaults(method);
  if (conf.model) {
    const row = mediaCatalog.find(conf.model, { method }, state);
    if (row && mediaCatalog.existsAt(row, state) !== false) {
      return { adapter: media.adapter(method, row.provider), model: row.modelId, source: 'platform' };
    }
    const b = media.builtinAdapter(method);
    const tk = `${method}:${conf.model}`;
    if (!_fallbackToasted.has(tk)) {
      _fallbackToasted.add(tk);
      toast('warning', `Default ${label} model unavailable`,
        `The platform default "${conf.model}" for ${method} is ${row ? 'no longer offered by the provider' : 'not in the model catalog'} — using "${b.defaultModel}" until it is changed in Apps → Setup → AI Config.`);
    }
    return { adapter: b, model: b.defaultModel, source: 'builtin', fallbackFrom: conf.model };
  }
  const b = media.builtinAdapter(method);
  return { adapter: b, model: b.defaultModel, source: 'builtin' };
}

// The call's generic params with the platform defaults filled in where the
// call left a gap and the resolved model honours the param.
function withDefaults(method, r, params) {
  const { adapter: a, model } = r;
  const honoured = new Set(a.describe(model).params || []);
  const conf = mediaCatalog.configuredDefaults(method);
  const g = {};
  for (const k of media.GENERIC_PARAMS[method]) {
    if (params[k] !== undefined && params[k] !== null && params[k] !== '') g[k] = params[k];
    else if (honoured.has(k) && k !== 'voice' && conf[k] !== undefined && conf[k] !== null && conf[k] !== '') g[k] = conf[k];
  }
  if (method === 'ai.tts' && !g.voice) {
    const offered = mediaCatalog.voicesFor({ method, provider: a.provider, modelId: model }) || [];
    const ok = conf.voice && offered.some((v) => String(v.id).toLowerCase() === String(conf.voice).toLowerCase());
    g.voice = ok ? conf.voice : a.defaultVoice(model);
  }
  return g;
}

function requireKey(a) {
  const key = core.resolveProviderKey(a.keyProvider);
  if (!key) throw new Error(`${a.label} API key not configured. Add it ${a.keyWhere || 'on the Models page'} (provider "${a.keyProvider}").`);
  return key;
}

// A vendor answer meaning "this model does not exist (any more)".
function isModelNotFound(status, text) {
  if (status === 404) return true;
  return status === 400 && /model_not_found|model[^\n]{0,60}?(does not exist|not found|is not supported|was deprecated|has been shut down)|unknown model|invalid model/i.test(text || '');
}
function failModelGone(appName, method, a, model, status, detail) {
  require('./ai-service').notifyModelUnavailable(appName, method, model, 'gone');
  return new Error(`${media.METHOD_LABEL[method]} failed (${status}): model "${model}" is not available at ${a.label}: ${detail}`);
}

// Speech-to-text. The model comes from the resolution chain above;
// `accuracy: 'high'` picks the vendor's more accurate model when none is named
// (OpenAI: gpt-4o-transcribe). Use whisper-1 for word/segment timestamps and
// srt/vtt; xAI's grok-voice-transcribe returns word timings (and speakers with
// `diarize: true`) on every call.
//
// Audio is preprocessed before upload (see media-ffmpeg.js): two-pass EBU R128
// loudness-normalize (fixes quiet recordings; level-only, no spectral change) →
// Silero VAD speech-trim (learned silence removal; cuts to actual speech, reduces
// Whisper hallucination) → 16 kHz mono FLAC (Whisper's native rate). Optional
// spectral denoise via denoise:true (off by default — it can hurt accuracy).
// Disable steps with enhance:false / trimSilence:false. Fine-tune the numeric
// behaviour with loudnessTarget (LUFS, default -16), denoiseNf (afftdn floor dB,
// default -25), vadThreshold (Silero cutoff 0..1, default 0.5), minSilenceMs
// (gap before a cut, default 100), speechPadMs (padding around speech, default
// 30) — each optional and only applied when provided. When word/segment
// timestamps are requested (or the model always returns them), internal gaps
// are preserved so timings aren't shifted.
// Preprocessing is best-effort — on any failure the original audio is sent as-is.
// A genuinely silent clip returns { text:'', silent:true } instead of erroring.
// When preprocessing changed the audio, the cleaned clip is written to
// <root>/enhanced-audios/ and its absolute path returned as `enhancedAudioPath`.
// That file is deleted ~60s later — consumers must read/copy it within that window.
async function aiTranscribe(appName, params = {}) {
  const r = resolveMediaModel(appName, 'ai.transcribe', params);
  const a = r.adapter;
  const model = !params.model && params.accuracy === 'high' && a.accurateModel ? a.accurateModel : r.model;
  const apiKey = requireKey(a);
  const desc = a.describe(model);

  const rawBuf = _decodeBase64Audio(params.audio);

  // Timestamps mean the caller cares about timing — only trim head/tail
  // silence, never collapse internal gaps, so reported offsets stay aligned.
  const wantsTimestamps = params.response_format === 'verbose_json'
    || Array.isArray(params.timestamp_granularities)
    || desc.timestamps === 'always';

  let buf = rawBuf;
  let filename = params.filename || 'audio.mp3';
  let mimeType = params.mimeType || 'audio/mpeg';
  let enhancedAudioPath = null;
  let durationSec = null; // known after preprocessing; the spend ledger bills per minute

  if (params.preprocess !== false) {
    try {
      const ffmpeg = require('./media-ffmpeg');
      const pre = await ffmpeg.preprocessAudio(rawBuf, {
        enhance: params.enhance !== false,
        trimSilence: params.trimSilence !== false,
        trimInternal: !wantsTimestamps,
        denoise: params.denoise === true,
        inputExt: params.mimeType || params.filename || 'audio',
        // Optional numeric tuning — only forwarded when the caller sets them;
        // media-ffmpeg falls back to its defaults otherwise.
        ...(params.loudnessTarget != null ? { loudnessTarget: Number(params.loudnessTarget) } : {}),
        ...(params.denoiseNf != null ? { denoiseNf: Number(params.denoiseNf) } : {}),
        ...(params.vadThreshold != null ? { vadThreshold: Number(params.vadThreshold) } : {}),
        ...(params.minSilenceMs != null ? { minSilenceMs: Number(params.minSilenceMs) } : {}),
        ...(params.speechPadMs != null ? { speechPadMs: Number(params.speechPadMs) } : {}),
      });
      // No audible audio survived (silent clip, or a MediaRecorder stream with
      // no real samples). Don't upload a zero-duration file — the vendor would
      // 400. Return a clean empty transcript so the app can show "no speech".
      if (pre.silent) {
        return { text: '', silent: true, model, provider: a.provider, instanceId: `${appName}-transcribe-${spawnManager.currentId()}` };
      }
      buf = pre.buffer;
      durationSec = pre.durationSec || null;
      filename = pre.filename;
      mimeType = pre.mimeType;
      // Persist the enhanced clip if preprocessing actually changed it, so the
      // app can fetch it (path is valid for ~60s, then auto-deleted).
      if (pre.processed) {
        const ext = (pre.filename && pre.filename.split('.').pop()) || 'flac';
        enhancedAudioPath = _saveEnhancedAudio(appName, buf, ext);
      }
    } catch {
      // media-ffmpeg never throws, but stay defensive: fall back to raw audio.
      buf = rawBuf;
    }
  }

  if (desc.maxBytes && buf.length > desc.maxBytes) {
    throw new Error(`Audio exceeds ${Math.round(desc.maxBytes / 1024 / 1024)} MB limit (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  }

  const g = { ...withDefaults('ai.transcribe', { adapter: a, model }, params), buf, filename, mimeType };
  const ignored = media.ignoredParams('ai.transcribe', a, model, params);
  const req = a.buildRequest(g, model, apiKey);

  let res;
  try {
    res = await fetch(req.url, { ...req.init, signal: AbortSignal.timeout(params.timeout || 120000) });
  } catch (err) {
    throw new Error(`Transcription request failed: ${err.message}`);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const detail = errText.slice(0, 500) || res.statusText;
    if (isModelNotFound(res.status, errText)) throw failModelGone(appName, 'ai.transcribe', a, model, res.status, detail);
    throw new Error(`Transcription failed (${res.status}): ${detail}`);
  }
  const body = await a.parseResponse(res);
  return {
    ...body, model, provider: a.provider, enhancedAudioPath, durationSec, rawBytes: rawBuf.length,
    ...(ignored.length ? { ignored } : {}),
    instanceId: `${appName}-transcribe-${spawnManager.currentId()}`,
  };
}

// Text-to-speech. Generic params — voice, format, speed, language,
// instructions, sampleRate, bitRate — are translated per vendor by the adapter
// (OpenAI /v1/audio/speech, xAI /v1/tts, Gemini generateContent). One the
// resolved model does not honour comes back in `ignored`. Returns raw audio as
// base64 plus a data URI for direct <audio src> playback.
const TTS_MIME = { mp3: 'audio/mpeg', opus: 'audio/opus', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', pcm: 'audio/pcm', mulaw: 'audio/basic', alaw: 'audio/alaw' };
const TTS_QUOTA_RETRIES = 3;

function notifyTts429(appName, level, title, message) {
  toast(level, title, `App "${appName}": ${message}`.trim());
}

async function aiTts(appName, params = {}) {
  const r = resolveMediaModel(appName, 'ai.tts', params);
  const { adapter: a, model } = r;
  const label = a.label;
  const apiKey = requireKey(a);
  const desc = a.describe(model);

  const input = params.input;
  if (!input || typeof input !== 'string') throw new Error('input text is required');
  if (!params.tags && desc.maxChars && input.length > desc.maxChars) throw new Error(`input exceeds ${desc.maxChars}-character limit (${input.length})`);
  const g = { ...withDefaults('ai.tts', r, params), input };
  // `tags: true` — input carries speech tags; render them for this model.
  let rendered = null;
  if (params.tags) {
    [rendered] = await speechTags.render(appName, [{ input, mode: speechTags.modeFor(desc), instructions: g.instructions }]);
    g.input = rendered.input;
    if (rendered.mode === 'instructions') g.instructions = rendered.instructions || undefined;
    if (desc.maxChars && g.input.length > desc.maxChars) throw new Error(`input exceeds ${desc.maxChars}-character limit (${g.input.length})`);
  }
  g.format = g.format || params.response_format || desc.defaultFormat;
  if (!desc.formats.includes(g.format)) throw new Error(`format "${g.format}" is not supported by ${label} TTS (${desc.formats.join(', ')})`);
  const ignored = media.ignoredParams('ai.tts', a, model, params);
  const req = a.buildRequest(g, model, apiKey);

  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(req.url, { ...req.init, signal: AbortSignal.timeout(params.timeout || 120000) });
    } catch (err) {
      throw new Error(`TTS request failed: ${err.message}`);
    }
    if (res.ok) break;

    const errText = await res.text().catch(() => '');
    const detail = errText.slice(0, 500) || res.statusText;

    if (isModelNotFound(res.status, errText)) throw failModelGone(appName, 'ai.tts', a, model, res.status, detail);
    if (res.status === 429) {
      // insufficient_quota = out of credits/billing — retrying can't help.
      const outOfCredits = /insufficient_quota|billing/i.test(errText);
      if (outOfCredits) {
        notifyTts429(appName, 'error', 'TTS out of credits',
          `${label} reports insufficient quota — you have likely run out of credits. Check your ${label} billing. ${detail}`);
        throw new Error(`TTS failed (429): insufficient quota (out of credits): ${detail}`);
      }
      // Transient rate limit: toast once on first hit, then back off and retry,
      // honoring Retry-After when the API provides it.
      if (attempt === 0) {
        notifyTts429(appName, 'warning', 'TTS rate limited (429)',
          `${label} returned 429 — could be rate limiting or low credits. Retrying with backoff…`);
      }
      if (attempt < TTS_QUOTA_RETRIES) {
        const retryAfterSec = Number(res.headers.get('retry-after'));
        const delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? Math.min(retryAfterSec * 1000, 15000)
          : 1000 * 2 ** attempt;
        console.warn(`[app-bridge] TTS quota error for "${appName}" (attempt ${attempt + 1}/${TTS_QUOTA_RETRIES + 1}), retrying in ${delayMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      notifyTts429(appName, 'error', 'TTS quota exceeded',
        `${label} TTS still returned 429 after ${TTS_QUOTA_RETRIES + 1} attempts — could be rate limiting or exhausted credits. ${detail}`);
      throw new Error(`TTS failed (429): quota/rate limit exceeded after ${TTS_QUOTA_RETRIES + 1} attempts: ${detail}`);
    }
    throw new Error(`TTS failed (${res.status}): ${detail}`);
  }

  const out = await a.parseResponse(res, g, model);
  const mimeType = TTS_MIME[out.format] || 'audio/mpeg';
  const audio = out.buf.toString('base64');
  return {
    audio,
    mimeType,
    format: out.format,
    dataUri: `data:${mimeType};base64,${audio}`,
    model,
    provider: a.provider,
    voice: g.voice,
    ...(ignored.length ? { ignored } : {}),
    ...(rendered ? { rendered } : {}),
    instanceId: `${appName}-tts-${spawnManager.currentId()}`,
  };
}

// Speech tags rendered for a whole script ahead of the ai.tts calls — one LLM
// pass per ~30 lines instead of one per line, with the neighbouring lines as
// context. Each line resolves its model like ai.tts; `model` / `provider` /
// `instructions` at the top level apply to every line that names none. Each
// result is what ai.tts then sends: pass its input and instructions to a plain
// ai.tts call with the same model. Free here — the LLM pass meters as ai.prompt.
const TTS_RENDER_MAX_LINES = 500;
async function aiTtsRender(appName, params = {}) {
  const lines = params.lines;
  if (!Array.isArray(lines) || !lines.length) throw new Error('lines is required (a non-empty array)');
  if (lines.length > TTS_RENDER_MAX_LINES) throw new Error(`at most ${TTS_RENDER_MAX_LINES} lines per call (${lines.length})`);
  const items = lines.map((l, i) => {
    const line = typeof l === 'string' ? { input: l } : (l || {});
    if (!line.input || typeof line.input !== 'string') throw new Error(`lines[${i}].input is required`);
    const pick = {
      model: line.model !== undefined ? line.model : (line.provider !== undefined ? undefined : params.model),
      provider: line.provider !== undefined ? line.provider : (line.model !== undefined ? undefined : params.provider),
      instructions: line.instructions !== undefined ? line.instructions : params.instructions,
    };
    const r = resolveMediaModel(appName, 'ai.tts', pick);
    const g = withDefaults('ai.tts', r, pick);
    return { input: line.input, mode: speechTags.modeFor(r.adapter.describe(r.model)), instructions: g.instructions, model: r.model, provider: r.adapter.provider };
  });
  const out = await speechTags.render(appName, items);
  return {
    lines: out.map((x, i) => ({ ...x, model: items[i].model, provider: items[i].provider })),
    instanceId: `${appName}-tts-render-${spawnManager.currentId()}`,
  };
}

// Image generation/editing. Text-to-image by default; pass params.image
// (base64 / data URI / { data, mimeType }, or an array) to edit. Generic
// `aspectRatio` and `size` (a tier '512' | '1K' | '2K' | '4K', or 'WxH';
// `imageSize` is accepted as the old name) are translated per vendor (Gemini
// imageConfig, OpenAI WxH, xAI aspect_ratio + resolution). Returns every image
// as base64 + a data URI, plus any text the model emitted.
async function aiImage(appName, params = {}) {
  const r = resolveMediaModel(appName, 'ai.image', params);
  const { adapter: a, model } = r;
  const apiKey = requireKey(a);
  const desc = a.describe(model);

  const prompt = params.prompt;
  if (!prompt || typeof prompt !== 'string') throw new Error('prompt is required');
  const p = { ...params, size: params.size != null ? params.size : params.imageSize };
  const merged = withDefaults('ai.image', r, p);
  const size = normalizeSize(merged.size);
  if (merged.size != null && !size) throw new Error(`size "${merged.size}" is not a tier (512, 1K, 2K, 4K) or WxH`);
  if (size && !size.includes('x') && desc.sizes && !desc.sizes.includes(size)) {
    throw new Error(`size "${size}" is not offered by ${model} (${desc.sizes.join(', ')})`);
  }
  if (merged.aspectRatio && desc.aspectRatios && !desc.aspectRatios.includes(merged.aspectRatio)) {
    throw new Error(`aspectRatio "${merged.aspectRatio}" is not offered by ${model} (${desc.aspectRatios.join(', ')})`);
  }
  const g = { ...merged, size, prompt };
  const ignored = media.ignoredParams('ai.image', a, model, p);
  const req = a.buildRequest(g, model, apiKey);

  let res;
  try {
    res = await fetch(req.url, { ...req.init, signal: AbortSignal.timeout(params.timeout || 120000) });
  } catch (err) {
    throw new Error(`Image request failed: ${err.message}`);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const detail = errText.slice(0, 500) || res.statusText;
    if (isModelNotFound(res.status, errText)) throw failModelGone(appName, 'ai.image', a, model, res.status, detail);
    throw new Error(`Image generation failed (${res.status}): ${detail}`);
  }

  const out = await a.parseResponse(res);
  if (!out.images.length) {
    throw new Error(`No image returned${out.reason ? ` (${out.reason})` : ''}. The prompt may have been blocked.`);
  }
  const images = out.images.map((im) => ({ data: im.data, mimeType: im.mimeType, dataUri: `data:${im.mimeType};base64,${im.data}` }));
  return {
    images, text: out.text || '', model, provider: a.provider,
    ...(ignored.length ? { ignored } : {}),
    instanceId: `${appName}-image-${spawnManager.currentId()}`,
  };
}

// Sound-effect generation (ai.sfx): a text prompt in, one audio clip out. The
// single engine behind ctx.sfx / Bridge ai.sfx, Horst's sound_generate and the
// broker's sound_generate. Format: call > (loop with no format → wav) > platform
// default > mp3. The loop rule is not a taste: an MP3 encoder pads the start and
// end with silence, which opens a gap at the loop point; PCM/WAV does not.
// Returns { audio (base64), mimeType, mime, format, ext, sampleRate,
// durationSeconds (measured from the output), bytes, dataUri, model, provider }.
const SFX_QUOTA_RETRIES = 2;
async function aiSfx(appName, params = {}) {
  const prompt = params.prompt;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt is required');
  let r = resolveMediaModel(appName, 'ai.sfx', params);
  // A looping call that named no model gets the adapter's loop-capable model
  // when the resolved one cannot loop (v3 has no `loop`).
  if (params.loop === true && r.source !== 'call' && !r.adapter.describe(r.model).loop && r.adapter.loopModel) {
    r = { ...r, model: r.adapter.loopModel, source: 'loop' };
  }
  const { adapter: a, model } = r;
  const apiKey = requireKey(a);
  const desc = a.describe(model);

  const merged = withDefaults('ai.sfx', r, params);
  const call = (k) => params[k] !== undefined && params[k] !== null && params[k] !== '';
  const num = (k, [lo, hi]) => {
    if (merged[k] == null) return undefined;
    const n = Number(merged[k]);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${k} must be a number between ${lo} and ${hi} (got ${merged[k]})`);
    return n;
  };
  const g = { prompt: prompt.trim(), loop: params.loop === true };
  g.durationSeconds = num('durationSeconds', desc.duration);
  g.promptInfluence = num('promptInfluence', desc.influence);
  g.format = String((call('format') ? params.format : (g.loop && desc.loop ? desc.loopFormat : merged.format) || desc.defaultFormat)).toLowerCase();
  if (!desc.formats.includes(g.format)) throw new Error(`format "${g.format}" is not supported for sound effects (${desc.formats.join(', ')})`);
  const rated = g.format === 'wav' || g.format === 'pcm';
  if (merged.sampleRate != null && rated) {
    g.sampleRate = Number(merged.sampleRate);
    if (!desc.sampleRates.includes(g.sampleRate)) throw new Error(`sampleRate must be one of ${desc.sampleRates.join(', ')} (got ${merged.sampleRate})`);
    g.sampleRateFromCall = true;
  }
  const ignored = media.ignoredParams('ai.sfx', a, model, params);
  if (call('sampleRate') && !rated && !ignored.includes('sampleRate')) ignored.push('sampleRate');

  let req = a.buildRequest(g, model, apiKey);
  let used = g;
  let res;
  for (let attempt = 0, tier = false; ; attempt++) {
    try {
      res = await fetch(req.url, { ...req.init, signal: AbortSignal.timeout(params.timeout || 120000) });
    } catch (err) {
      throw new Error(`Sound effect request failed: ${err.message}`);
    }
    if (res.ok) break;
    const errText = await res.text().catch(() => '');
    const detail = errText.slice(0, 500) || res.statusText;
    if (isModelNotFound(res.status, errText)) throw failModelGone(appName, 'ai.sfx', a, model, res.status, detail);
    const lower = !tier && a.fallback && a.fallback(used, res.status, errText);
    if (lower) { tier = true; used = lower; req = a.buildRequest(used, model, apiKey); continue; }
    if (res.status === 429 && !/quota|credit|billing/i.test(errText) && attempt < SFX_QUOTA_RETRIES) {
      const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
      await new Promise((resolve) => setTimeout(resolve, Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 15000) : 1000 * 2 ** attempt));
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new Error(`Sound effect generation failed (${res.status}): ${a.label} refused the API key (or it lacks sound-effects access): ${detail}`);
    if (res.status === 429 || res.status === 402) throw new Error(`Sound effect generation failed (${res.status}): ${a.label} quota or credits exhausted / rate limited: ${detail}`);
    throw new Error(`Sound effect generation failed (${res.status}): ${detail}`);
  }

  const out = await a.parseResponse(res, used, model);
  const audio = out.buf.toString('base64');
  return {
    audio,
    mimeType: out.mime,
    mime: out.mime,
    format: out.format,
    ext: out.ext,
    sampleRate: out.sampleRate,
    durationSeconds: out.durationSeconds != null ? Math.round(out.durationSeconds * 1000) / 1000 : (g.durationSeconds != null ? g.durationSeconds : null),
    bytes: out.buf.length,
    dataUri: `data:${out.mime};base64,${audio}`,
    model,
    provider: a.provider,
    ...(g.loop && desc.loop ? { loop: true } : {}),
    ...(ignored.length ? { ignored } : {}),
    instanceId: `${appName}-sfx-${spawnManager.currentId()}`,
  };
}

// The Setup card's "Test connection": reads the account (free, never generates
// audio). A key restricted to sound generation answers 401 missing_permissions
// on the account read — it authenticated, so that counts as accepted.
async function elevenlabsDiagnose() {
  const key = core.resolveProviderKey('elevenlabs');
  if (!key) return { state: 'no-key' };
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(15000) });
    const text = await res.text().catch(() => '');
    if (res.ok) {
      let j = {};
      try { j = JSON.parse(text); } catch {}
      const used = j.character_count, limit = j.character_limit;
      return { state: 'ok', sample: `Plan: ${j.tier || 'unknown'}${limit ? `, ${used} / ${limit} credits used` : ''}` };
    }
    if (res.status === 401 && /missing_permissions/i.test(text)) {
      return { state: 'ok', sample: 'Key accepted (it has no permission to read the account, which is fine for sound generation).' };
    }
    if (res.status === 401 || res.status === 403) return { state: 'invalid-key', status: res.status, message: text.slice(0, 300) };
    if (res.status === 429) return { state: 'rate-limited', status: 429 };
    return { state: 'error', status: res.status, message: text.slice(0, 300) || res.statusText };
  } catch (err) {
    return { state: 'error', message: err.message };
  }
}

// Text translation via the Google Cloud Translation v2 REST API, authenticated
// with the same provider key the image/Gemini features use. Accepts a single
// string or an array of strings in params.text and returns one result per input,
// preserving order. params.target is the destination language (BCP-47, e.g.
// 'es'); params.source is optional (auto-detected when omitted).
async function aiTranslate(appName, params) {
  // Prefer a dedicated Cloud Translation key if one is configured, otherwise
  // fall back to the shared Google provider key (the one Gemini/ai.image use) —
  // a single GCP key can have both APIs enabled.
  const apiKey = core.resolveProviderKey('google-translate') || core.resolveProviderKey('google');
  if (!apiKey) throw new Error('Google API key not configured. Add a Google Translate key in Apps → AI Config, or set the "google" provider key on the Models page.');

  const p = params || {};
  const target = p.target || p.to;
  if (!target || typeof target !== 'string') throw new Error('target language is required');

  const single = !Array.isArray(p.text);
  const texts = (single ? [p.text] : p.text).filter((t) => typeof t === 'string');
  if (!texts.length) throw new Error('text is required');

  const body = { q: texts, target, format: p.format === 'html' ? 'html' : 'text' };
  if (p.source || p.from) body.source = p.source || p.from;

  const url = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey)}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(p.timeout || 30000),
    });
  } catch (err) {
    throw new Error(`Translate request failed: ${err.message}`);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Translation failed (${res.status}): ${errText.slice(0, 500) || res.statusText}`);
  }

  const json = await res.json();
  const items = (json?.data?.translations || []).map((t) => ({
    text: t.translatedText,
    detectedSourceLanguage: t.detectedSourceLanguage || body.source || null,
  }));

  return {
    target,
    translations: items,
    text: single ? (items[0]?.text ?? '') : items.map((i) => i.text),
    detectedSourceLanguage: items[0]?.detectedSourceLanguage || null,
    instanceId: `${appName}-translate-${spawnManager.currentId()}`,
  };
}

// Language detection via the Google Cloud Translation v2 REST API (the /detect
// endpoint), using the same key resolution as aiTranslate. Accepts a single
// string or an array of strings in params.text and returns one detection per
// input, preserving order.
async function aiDetect(appName, params) {
  const apiKey = core.resolveProviderKey('google-translate') || core.resolveProviderKey('google');
  if (!apiKey) throw new Error('Google API key not configured. Add a Google Translate key in Apps → AI Config, or set the "google" provider key on the Models page.');

  const p = params || {};
  const single = !Array.isArray(p.text);
  const texts = (single ? [p.text] : p.text).filter((t) => typeof t === 'string');
  if (!texts.length) throw new Error('text is required');

  const url = `https://translation.googleapis.com/language/translate/v2/detect?key=${encodeURIComponent(apiKey)}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: texts }),
      signal: AbortSignal.timeout(p.timeout || 30000),
    });
  } catch (err) {
    throw new Error(`Detect request failed: ${err.message}`);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Language detection failed (${res.status}): ${errText.slice(0, 500) || res.statusText}`);
  }

  // v2 returns an array of candidate lists (one list per input); the first
  // candidate is the best guess. `language` is 'und' when nothing matched.
  const json = await res.json();
  const items = (json?.data?.detections || []).map((cands) => {
    const best = Array.isArray(cands) ? cands[0] : cands;
    return {
      language: best?.language || 'und',
      confidence: typeof best?.confidence === 'number' ? best.confidence : null,
      isReliable: !!best?.isReliable,
    };
  });

  return {
    detections: items,
    language: single ? (items[0]?.language ?? 'und') : items.map((i) => i.language),
    confidence: items[0]?.confidence ?? null,
    instanceId: `${appName}-detect-${spawnManager.currentId()}`,
  };
}

// Live diagnostic for the Google Translate setup. Probes the v2 API with a
// trivial request and classifies the result so the UI can show exactly what (if
// anything) needs fixing. Never throws — always resolves to a status object.
// Possible `state`: 'ok' | 'no-key' | 'api-disabled' | 'key-restricted' |
// 'invalid-key' | 'billing' | 'error'. When the API returns a project number we
// surface it as `project` so the UI can deep-link to that exact GCP project.
async function translateDiagnose() {
  const dedicated = !!core.resolveProviderKey('google-translate');
  const apiKey = core.resolveProviderKey('google-translate') || core.resolveProviderKey('google');
  const source = dedicated ? 'google-translate' : (core.resolveProviderKey('google') ? 'google' : null);
  if (!apiKey) return { state: 'no-key', source: null };

  const url = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey)}`;
  let res, text;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: ['ping'], target: 'es', format: 'text' }),
      signal: AbortSignal.timeout(15000),
    });
    text = await res.text();
  } catch (err) {
    return { state: 'error', source, message: `Could not reach Google: ${err.message}` };
  }

  if (res.ok) {
    let sample = '';
    try { sample = JSON.parse(text)?.data?.translations?.[0]?.translatedText || ''; } catch {}
    return { state: 'ok', source, sample };
  }

  let err = {};
  try { err = JSON.parse(text)?.error || {}; } catch {}
  const detail = (err.details || []).find((d) => d.reason) || {};
  const reason = detail.reason || (err.errors && err.errors[0] && err.errors[0].reason) || '';
  const project = detail.metadata?.consumer?.replace(/^projects\//, '') || null;
  const message = err.message || `HTTP ${res.status}`;

  let state = 'error';
  // API_KEY_SERVICE_BLOCKED = the API IS reachable but this key's API restrictions
  // exclude Cloud Translation (the request reaches Google, then gets rejected —
  // visible in Cloud Monitoring). SERVICE_DISABLED = the API isn't enabled at all.
  if (res.status === 403 && (reason === 'API_KEY_SERVICE_BLOCKED' || reason === 'API_KEY_HTTP_REFERRER_BLOCKED' || reason === 'API_KEY_IP_ADDRESS_BLOCKED' || reason === 'API_KEY_API_TARGET_BLOCKED')) state = 'key-restricted';
  else if (res.status === 403 && reason === 'SERVICE_DISABLED') state = 'api-disabled';
  else if (res.status === 400 && reason === 'API_KEY_INVALID') state = 'invalid-key';
  else if (res.status === 403 && /billing/i.test(message)) state = 'billing';

  return { state, source, status: res.status, reason, project, message };
}

// Every media call passes the spend gate (authorize before, settle after).
// Units: transcribe = audio minutes (decoded duration, else ~16 kbps estimate
// from the upload size), tts/translate/detect = thousands of characters,
// image = images returned, sfx = seconds of generated audio.
const spendGate = require('./spend-gate');
const _chars = (p) => {
  const t = p && (p.text !== undefined ? p.text : p.input);
  const arr = Array.isArray(t) ? t : [t];
  return arr.reduce((n, s) => n + (typeof s === 'string' ? s.length : 0), 0) / 1000;
};
module.exports = {
  aiTranscribe: spendGate.wrap('ai.transcribe', aiTranscribe, (p, r) => {
    if (r && r.silent) return 0;
    if (r && r.durationSec) return r.durationSec / 60;
    const bytes = r && r.rawBytes ? r.rawBytes : Math.floor(String((p && p.audio) || '').length * 0.75);
    return bytes / 120000; // ~16 kbps
  }),
  aiTts: spendGate.wrap('ai.tts', aiTts, (p) => _chars(p)),
  aiTtsRender,
  // sfx: billed per generated second — the measured output length.
  aiSfx: spendGate.wrap('ai.sfx', aiSfx, (p, r) => (r && r.durationSeconds) || (p && Number(p.durationSeconds)) || 1),
  elevenlabsDiagnose,
  aiImage: spendGate.wrap('ai.image', aiImage, (p, r) => (r && Array.isArray(r.images) ? r.images.length : 1)),
  aiTranslate: spendGate.wrap('ai.translate', aiTranslate, (p) => _chars(p)),
  aiDetect: spendGate.wrap('ai.detect', aiDetect, (p) => _chars(p)),
  translateDiagnose,
  resolveMediaModel,
};
