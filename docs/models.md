# AI models — defaults, the media catalog, the daily review

How a text or media call gets its model, where the configured defaults live, and
how Horst keeps them alive. The app-facing contract is in
`src/apps/prompts/_api-reference.md` (Audio, Image & Translation; `<vc-model-picker>`).

## Where the lists come from

| List | Source | Live state |
|---|---|---|
| Text models | core registry (`listModels`, `listModelsWithAvailability`) | core's `refreshModels()` — the Models-page refresh (`caps.refreshModelRegistry`: provider scan + models.dev) |
| Media models | core `native-models.js` via `listNativeModels()` (entries with `usedBy`); an older host without it → each adapter's `seedModels` | `<APPS_DIR>/.media-catalog.json`: per adapter `modelIds`, `shutdown{}`, `lastError`; `voices['<provider>:*']`; `lastRefresh` |
| Voice samples | generated on first play (`media-samples.js`) | `<APPS_DIR>/.media-samples/<provider>-<model>-<voice>.<ext>`, kept forever |

`media-catalog.js` joins them: `rows()` = core's list filtered to wired adapters +
seeds + live ids an adapter's `classify(id)` recognises (`discovered: true`).
`list({ method?, kind? })` is the one payload (`ai.mediaModels`, Setup, the host
picker, Horst): per model `exists` (true / false / null = never checked or no
listing), `shutdownDate`, `usable` / `unusableReason` (`no-credential` |
`missing`), `params` (the adapter's descriptor), `voices` + `defaultVoice` (TTS),
`builtinDefault`, `providerDefault`, `isDefault`; plus `defaults` (effective per
method), `configured`, `refreshedAt`, `refreshing`. `refresh()` is shared by
concurrent callers; a failed listing keeps the last known ids.

## Media adapters (`src/apps/media/`)

One file per (method, vendor) in `adapters/`; `index.js` lists them
(`ADAPTERS`, `BUILTIN_PROVIDER`, `GENERIC_PARAMS`, `METHOD_KIND`).

| Method | Adapter | Endpoint | Listing |
|---|---|---|---|
| ai.tts | `tts-openai` | `/v1/audio/speech` | `/v1/models`; voices static (13, 9 on `tts-1*`) |
| ai.tts | `tts-xai` | `/v1/tts` | `/v1/tts/voices` (models + voices) |
| ai.tts | `tts-google` | Gemini `generateContent` (AUDIO) — WAV, other formats via `media-ffmpeg.transcodeWav` | `/v1beta/models`, `/v1beta/voices` (prebuilt only) |
| ai.transcribe | `transcribe-openai` | `/v1/audio/transcriptions` | `/v1/models` |
| ai.transcribe | `transcribe-xai` | `/v1/stt` | none — existence stays null, never flagged |
| ai.image | `image-google` | Gemini `generateContent` (IMAGE) | `/v1beta/models` |
| ai.image | `image-openai` | `/v1/images/generations` · `/edits` | `/v1/models` |
| ai.image | `image-xai` | `/v1/images/generations` · `/edits` (`b64_json`) | `/v1/image-generation-models` |
| ai.sfx | `sfx-elevenlabs` | `POST /v1/sound-generation?output_format=…` (`xi-api-key`) | none (ElevenLabs lists no sound-effect models) — existence stays null; seeds carry the two ids |

Adapter shape: `method`, `provider`, `label`, `keyProvider`, `defaultModel`,
`seedModels`, `classify(id)`, `describe(model)` → `{ params[], formats, speed,
maxChars, aspectRatios, sizes, qualities, … }`, `voices(model)`,
`defaultVoice(model)`, `buildRequest(generic, model, key)` → `{ url, init }`,
`parseResponse(res, generic, model)`, `listModels(key, memo)` | null,
`listVoices(key, memo)` | null. Generic params translate per vendor (`voice` →
`voice` / `voice_id` / `voiceName`, `format` → `response_format` /
`output_format.codec`, `aspectRatio` + `size` → `imageConfig` / `WxH` (`image-size.js`) /
`aspect_ratio` + `resolution`). A param the model does not honour is not sent
and comes back in `result.ignored`.

## Choosing the media model (`ai-media.resolveMediaModel`)

1. `params.model` (also `provider/model`); 2. `params.provider` → that
adapter's default; 3. the platform default `mediaDefaults[method].model`;
4. the built-in default (`BUILTIN_PROVIDER`: tts/transcribe → openai, image → google, sfx → elevenlabs).

- Unknown model, wrong kind, or a provider contradicting the model → throws
  (lists the valid ids) and `notifyModelUnavailable`.
- A vendor "model not found" (404, or 400 with not-found text) → throws and
  `notifyModelUnavailable(…, 'gone')`. An explicit model is not pre-blocked on
  catalog state; listings can lag.
- A platform default the catalog marks missing → the built-in default, one toast.
- Platform defaults fill only params the call left out and the model honours;
  the default voice applies only where the model offers it, else the model's own.
- No per-app defaults: an app stores its own choice and passes `model`.
- `result.model` is the resolved id, so `spend-pricing` byModel prices it;
  a byModel `null` is metered unpriced. A test fails when an adapter-served
  model has no byModel key (`test/media-resolve.test.js`).

## Sound effects (`ai.sfx`, `ai-media.aiSfx`)

One engine, four callers: `ctx.sfx` / Bridge `ai.sfx` (apps, `capabilities/audio.js`),
Horst's `sound_generate` (`docs/horst-lanes.md`) and the broker built-in
`sound_generate` (`docs/app-tools.md`, `sound-tools.js`) — the last two as appName
`platform`. Generic params: `prompt` (required), `durationSeconds` (0.5–30, omitted =
automatic), `loop`, `promptInfluence` (0–1), `format`, `sampleRate`; call > platform
default (`mediaDefaults['ai.sfx']`) > built-in. Models: `eleven_text_to_sound_v3`
(default) and `…_v2`; only v2 honours `loop` (the adapter descriptor says so), so
a looping call that names no model runs on v2, and on v3 `loop` is reported in
`ignored`. ElevenLabs deprecates v2 on 2027-03-01 (then loop needs another model).

| `format` | Asked of ElevenLabs | Result | `mime` · `ext` |
|---|---|---|---|
| `mp3` (default) | `mp3_44100_128` | as served (CBR; duration from the bytes) | audio/mpeg · mp3 |
| `wav` | `pcm_<rate>` | RIFF header added by `media/audio-container.js` (no ffmpeg) | audio/wav · wav |
| `ogg` | `opus_48000_128` | as served; refused when it is not an Ogg file | audio/ogg · ogg |
| `pcm` | `pcm_<rate>` | raw s16le mono, `sampleRate` in the result | audio/L16 · pcm |

Format order: the call's `format`; else (`loop` honoured) `wav`; else the platform
default; else `mp3`. A looping call defaults to wav because an mp3 encoder pads the
start and end with silence — a gap at the loop point; PCM/WAV has none. `sampleRate`
(8000–48000, default 44100) is for wav / pcm; 44.1 kHz PCM needs ElevenLabs' Pro tier,
so a tier refusal is repeated once at 24 kHz when the rate was not chosen (the
result's `sampleRate` says so). The result always states `{ model, provider, format,
mime, ext, sampleRate, durationSeconds (measured from the output), bytes, loop?,
ignored? }` plus `audio` (base64), `mimeType` (= `mime`, as ai.tts) and `dataUri`.

Key: provider `elevenlabs`, set in Setup → AI Config ("ElevenLabs" card; WS
`app:elevenlabsKey:get|set|test`, test = `ai-media.elevenlabsDiagnose`, a read of
`/v1/user/subscription` that never generates). Spend: unit `second` (the measured
output length), `spend-pricing` `ai.sfx` = 40 credits/s × ~$0.0002 = $0.008/s for
both models (the plan's credit price varies; the admin can override).

## Speech tags (`src/apps/media/speech-tags.js`)

`ai.tts` `tags: true` and `ai.ttsRender` take xAI-style tags in the input; the
mode follows the resolved model's descriptor (`modeFor`):

| Mode | Descriptor | Sent |
|---|---|---|
| `native` | `speechTags: true` (tts-xai) | input unchanged |
| `instructions` | `instructions: true` (gpt-4o-mini-tts, Gemini) | LLM text + `Performance cues: …` appended to the caller's instructions |
| `plain` | neither (tts-1*) | `plain()`: laughs written out, pauses `…`, emphasis CAPS, other tags dropped |

- LLM pass: `ai-service.aiPrompt(app, appDir, { model: 'haiku', allowedTools: [], expectJson })`
  — charged to the app as `ai.prompt`; ≤30 lines / 8,000 chars per prompt,
  3 in parallel, the script's other lines as context.
- `validText` (no tag left; spoken words a subsequence of the output; ≤3 added
  words per inline tag) and `validDirection` (≤400 chars, no quotes, no 3-word
  run of the line) — a failure or a failed prompt → `plain()` plus a cue list
  built from tag names only (`via: 'fallback'`, `fallback` = reason).
- Accepted renderings are cached in-process by input (LRU, 5,000).
- The result reports what was sent: `rendered` (ai.tts), `lines[]` (ai.ttsRender).

## Configured defaults (`src/apps/model-defaults.js`)

| Target | Store |
|---|---|
| `platform.directModel`, `platform.memoryModel` | `platform-settings` |
| `horst.chatModel` (`''` = platform default, skipped), `horst.briefingModel`, `horst.triageModel`, `horst.directiveModel` | `agent/horst-settings` |
| `media.ai.tts` (model, voice, format, speed, language, instructions), `media.ai.transcribe` (model, language), `media.ai.image` (model, aspectRatio, size, quality), `media.ai.sfx` (model, format, durationSeconds, promptInfluence) | `platform-settings` `mediaDefaults` |

`read(target)` / `write(target, { model, voice })` are the only writers the
review's kind uses; Setup writes `mediaDefaults` through `app:settings:set`.
Runner processes load `platform-settings` once, so they see a changed default
after their restart.

## The daily review (`agent/horst-model-review.js`)

Job `horst:model-review` (`modelReviewSchedule`, default `30 6 * * *`) →
`timer:model-review` → run-action `model-review`. Skipped while `paused`.

1. Refresh: `core.refreshModels()` (if the host has it), `mediaCatalog.refresh()`.
2. Text targets: `ai-service.textModelHealth(ref)` — the same lookup and
   same-family substitution as `resolveModelForCall`; a bare tier is fine while
   its family has a usable model; dead = unknown / retired / disabled /
   no-credential. An empty registry → not checked.
3. Media targets: dead = unknown / missing / shutdown date passed (an explicitly
   set default also on no-credential); a stored voice the model no longer
   offers → `voice-missing`.
4. Dead → `ai:default-missing` + an `ai.setDefault` proposal with a candidate
   (text: the substitute; media: the built-in default, else the provider's).
   Once per target+model: `.horst/model-review.json` `alerted`, cleared when
   the target is healthy.
5. Shutdown within 30 days, or a text default `deprecated` → agenda
   `model-shutdown`; a dead built-in fallback → `model-builtin-gone`; new text
   (scan `added`) and newly discovered media ids → one `models-new` observation.
6. Journal `model-review`: counts, dead targets, listing errors.

## Alerts and the kind (`capabilities/ai.js`)

| Sense | Fires when | Policy |
|---|---|---|
| `ai:model-substituted` | an app's `ai.prompt` named a retired model; resolution substituted | notify |
| `ai:model-unavailable` | an app's text or media call named a model that is unknown / wrong kind / gone; the call failed | notify |
| `ai:default-missing` | the review found a configured default (or voice) dead | notify |

`ai.setDefault { target, model, voice? }` — ceiling and default `propose`;
validates the target, the model (media catalog / `textModelHealth`) and the
voice; executes `model-defaults.write`.

## Surfaces

- `ai.sfx` / `ctx.sfx` / `generateSound` (sound effects); `ai.mediaModels` / `ctx.mediaModels`, `ai.voiceSample` / `ctx.voiceSample`
  (`capabilities/audio.js`, free); `ai.ttsRender` / `ctx.ttsRender` (free,
  its LLM pass metered as `ai.prompt`); runtime `getMediaModels`, `Vc.getModels({ kind })`,
  `Vc.voiceSample`.
- Setup → AI Config "Media model defaults" (`public/apps.js`
  `renderMediaDefaults`): per-method model (host picker), voice + ▶, and the
  fields the model's descriptor lists. WS: `app:media:catalog:get`,
  `app:media:refresh` (broadcasts the catalog on start and finish),
  `app:media:sample`.
- Host picker `public/app-model-picker.js` `window.appModelPicker.open(container,
  { models, kind, defaultName, onPick })` — also `pickModel({ kind })`.
- `<vc-model-picker kind show-voices show-params>` (`public/vc-model-picker.js`).

## Not built

- Model choice for `ai.translate` / `ai.detect` (Google Translate v2 has none).
- Local MusicGen (`ai.music.*`) and local embeddings in the catalog or review.
- Per-app media defaults.
- Vendor-hosted voice samples (no vendor offers them for built-in voices).
- ElevenLabs text-to-speech voices (the `elevenlabs` key is shared, no TTS adapter).
