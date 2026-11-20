# App Bridge API Reference

The platform runtime (`/pro/app-runtime.js`) provides `Bridge.call()`, `Bridge.on()`, `askAI()`, and `parseAIResponse()`. Never create your own bridge implementation.

`Bridge.call(method, params, opts?)` rejects after 5 minutes by default (so a dashboard reload mid-call can't hang a promise forever). For calls that may legitimately run longer, pass `{ timeoutMs: 0 }` (disable) or a custom value — but prefer `ctx.jobs` for anything that long-running.

<!-- API:INDEX -->
## Section Index

{{CAPABILITY_INDEX}}
<!-- /API:INDEX -->

## Trust Model — What Is and Isn't Isolated

Know this before you handle any input that didn't come from the app's own owner (webhook payloads, Telegram messages, public-app visitors, scraped or AI-generated text).

Your app runs **in-process** by default: `routes.js` is `require()`d and runs **inside the dashboard's trust boundary**. Concretely:

- **`process.env` is readable** from `routes.js` — it contains `AUTH_TOKEN` and the platform's provider API keys. Never echo `process.env` (or a subset of it) into a response, a log the user can fetch, an AI prompt, or an error message.
- **A throw during router setup can affect the host**, and blocking the event loop in `routes.js` blocks the dashboard. Keep setup cheap and never run a long synchronous loop.
- **`exec` / `spawn` use `shell: true`.** Any string you pass is interpreted by a shell. Never interpolate caller-controlled text into a command — pass fixed commands with `args`, or validate against a strict allowlist first. This is the single most likely way an app turns remote input into remote code execution.
- **The bridge API is the sandboxed capability surface** — `fs.*` paths can't escape the app directory, `http.fetch` is SSRF-guarded, `db.query` is scoped to the app's own database. Prefer these over reaching around them.

So: file paths and HTTP targets are constrained for you; **the process, the environment, and the shell are not**. Treat every value that crosses a webhook, a public route, or a Telegram handler as hostile, and validate it before it reaches `exec`/`spawn`, a SQL string, or the filesystem.

## Bridge Methods

Every `Bridge.call` method belongs to one capability; its section is inlined below or in `.vistaclair/api/<key>.md`.

<!-- API:SECTION key=fs -->
### File System
- `fs.read({ path })` — read a file (relative to app dir), returns string
- `fs.write({ path, content })` — write a file (creates dirs as needed)
- `fs.list({ dir })` — list directory entries, returns `[{ name, isDir }]`
- `fs.exists({ path })` — check if path exists, returns boolean
<!-- /API:SECTION -->

<!-- API:SECTION key=exec -->
### Execution
- `exec({ command })` — run a shell command. Returns `{ stdout, stderr, code }`. 300s timeout, 5MB buffer.
- `spawn({ command, args?, env? })` — start a long-running process. Returns `{ spawnId, pid }`. Max 10 per app. Listen for output via `Bridge.on('spawn:stdout')`.
- `spawn.kill({ spawnId })` — kill a spawned process
<!-- /API:SECTION -->

<!-- API:SECTION key=cron -->
### Scheduling (Server-Side Cron)
- `cron.schedule({ schedule, command })` — schedule a recurring shell command. Schedule format: `"every N seconds/minutes/hours"` or a 5-field cron expression (e.g. `"*/5 * * * *"`). Returns `{ jobId }`. Results pushed via `Bridge.on('cron:result')`. **Persistent** — jobs survive server restarts (removed automatically when the app is deleted). Runs in the app directory with the proxy URL injected.
- `cron.cancel({ jobId })` — cancel a scheduled job
- `cron.list()` — list active jobs for this app
<!-- /API:SECTION -->

<!-- API:SECTION key=jobs -->
### Jobs (Long-Running Operations)

**This is THE way to run anything long-running** (scans, AI batch work, processing, deployments). It satisfies the platform's GUI-reload-resilience rule for free: job records are persisted server-side, the frontend can always re-query in-progress work after a reload, and results are kept after completion. Never build your own in-memory job map + polling endpoints.

Start jobs from routes.js (the runner is a server-side function):
```js
// routes.js
router.post('/api/scan', (req, res) => {
  const { id } = ctx.jobs.start({
    name: 'scan',
    meta: { target: req.body.target },
    run: async (job) => {
      for (let i = 0; i < steps.length; i++) {
        if (job.signal.aborted) throw new Error('cancelled');   // honor cancellation
        await doStep(steps[i]);
        job.setProgress(Math.round(100 * (i + 1) / steps.length), steps[i].label);
      }
      return { findings };   // becomes job.result (≤256KB inline; store bigger results yourself and return a reference)
    },
  });
  res.json({ jobId: id });
});
```

- `ctx.jobs.start({ name, meta?, run })` → `{ id }`. `run(job)` receives `{ id, signal (AbortSignal), setProgress(pct, label), setMeta(obj) }`. Resolve → status `done` + result; throw → `error`. `run` is invoked **synchronously** — code before its first `await` (e.g. setting up in-memory state for status endpoints) completes before `start()` returns, so you can `res.json()` right after with no race.
- `ctx.jobs.get(id)` / `ctx.jobs.list({ status?, name?, limit? })` / `ctx.jobs.cancel(id)` / `ctx.jobs.remove(id)` / `ctx.jobs.prune({ olderThanMs? })`.
- `remove(id)` deletes **one** job record (cancelling it first if still running) — use it when the user deletes the resource a job produced. `prune({ olderThanMs })` bulk-deletes **all** terminal jobs older than the cutoff — never use it to remove a single record (`olderThanMs: 0` wipes the entire history). You rarely need either: the platform auto-prunes (last 200 per app, 7-day TTL).

Call `setProgress`/`setMeta` as often as you like — progress-only updates are throttled platform-side (persisted + broadcast at most once per second per job, with the latest state always flushed); status transitions always persist and broadcast immediately. Don't build your own debouncing.

Frontend (iframe) bridge methods: `jobs.list({ status?, name?, limit? })`, `jobs.get({ id })`, `jobs.cancel({ id })`, `jobs.remove({ id })`. Every status change (and throttled progress updates) is pushed as a **`job:update`** event — render progress from it instead of polling:
```js
// app.js — recover in-progress work on load, then live-update
const running = await Bridge.call('jobs.list', { status: 'running' });
running.forEach(renderJob);
Bridge.subscribe('job:update', renderJob);   // { id, name, status, progress: {pct, label}, meta, result, error, ... }
```

Job record: `{ id, name, status: 'running'|'done'|'error'|'cancelled'|'interrupted', progress: {pct?, label?}, meta, result, error, createdAt, updatedAt, finishedAt }`. Statuses are persisted across server restarts; a job whose runner died with a restart is marked **`interrupted`** at boot — on mount, check `ctx.jobs.list({ status: 'interrupted' })` and either restart the work as a new job or surface it to the user. Terminal jobs are pruned automatically (last 200 per app, 7-day TTL).
<!-- /API:SECTION -->

<!-- API:SECTION key=ai -->
### AI
- `ai.prompt({ message, systemPrompt?, model?, expectJson?, allowedTools?, readRoots?, authMode?, retries?, sessionTag?, meterKey? })` — AI text generation. Returns `{ text, instanceId }`. When `expectJson: true`, also returns `{ json }` with auto-parsed JSON (includes truncation repair and AI-powered repair fallback). If parsing fails completely, `json` is `null`. Safety constraints auto-injected. All calls visible in Inspector. This is the **only** allowed method for AI calls from apps — never use `exec` + `claude -p` yourself; this method already runs `claude -p` for you, through the proxy.
  - The default model is configurable in Setup → AI Config (Haiku by default); override per call with `model`. Omit `model` to use that default.
  - `allowedTools` (optional, array): grant the call tools (Read, Bash, app tools via MCP, etc.). **This is an enforced boundary, not advisory** — a per-session proxy gate strips every ungranted tool from the model's request. `allowedTools: []` (empty array) means the session runs with **no tools at all** — the strictest, cheapest mode for pure text/JSON generation. A wildcard suffix `*` matches by prefix (e.g. `'mcp__app-tools__*'` = all app tools). **Omitting the field (or `null`) is the same as `[]`: no tools.** A call that needs `Read`, `WebFetch`, app tools etc. must list them. Avoid `Bash`, `Write` and `Edit` unless the app truly needs the model to run commands or change files (app-lint warns).
  - `retries` (optional, 0–5, default 0): automatically retry transient failures (killed process, connection reset, socket hang up) with backoff. Set `retries: 2` for unattended/batch calls instead of writing your own retry loop. Non-transient errors (bad params, auth) are never retried.
  - `authMode` (optional, `'subscription' | 'apikey'`): which credential this call uses when both are available — the user's Max/Pro login, or the Anthropic API key from the Models page. **Leave it unset.** The owner chooses once on the Models page and that choice applies platform-wide; overriding it per call takes a billing decision away from the person paying. Whichever is picked, the other is used automatically if the chosen one isn't configured, so a call never fails just because of this field.
  - `model` accepts any current model `name` from the live registry (see **Available AI models** below), or a bare Anthropic tier name — `"haiku"`, `"sonnet"`, `"opus"` — which resolves to the latest version in that family automatically. **Prefer the bare tier name for Anthropic models** so your app never goes stale when a new version ships. If you pass a full versioned name that no longer exists, the platform transparently substitutes the current same-family model and notifies the user — your call still succeeds. For user-configurable model selection, use `getModels()` / `pickModel()` instead of hardcoding.
  - `readRoots` (optional, array of absolute paths): which files a call granted `Read`, `Glob`, `Grep`, `Write`, `Edit` or `NotebookEdit` may touch — **enforced** by a hook the AI CLI runs before every tool call, so symlinks, `..`, `/proc` and the secrets key cannot get out. Omitted = your own app directory (it holds `.data`). Every root must exist and lie inside your app directory, otherwise the file tools are removed from that call (the result's `readScope.reason` says why). `Bash` is not scoped.
  - `sessionTag` (optional, string ≤ 200 chars): an opaque tag echoed as `caller.sessionTag` on **every** `onToolCall` invocation belonging to this call. This is how an app running concurrent per-user agentic sessions routes a tool call to the right user's resource (e.g. that user's device/transport) — pair it with `allowedTools` when different users should see different tool catalogs. Do NOT hand-roll session routing via module-level singletons or global mutexes.
  - `meterKey` (optional, string ≤ 128 chars, must not start with `_`): an opaque per-end-user key (e.g. `'acct:42'`). The platform meters this call's **real token usage and USD cost** against the key in a per-app ledger — read it back with `ai.usage`. Do NOT hand-roll op-count quotas as a spend proxy.
- `ai.usage({ meterKey?, days? })` — read the app's spend ledger. Returns `{ meterKey, days, calls, inTok, outTok, cacheTok, costUsd }` summed over the last `days` days (default 30, max 93 — the retention window). Omit `meterKey` for app-wide totals. Every metered platform call (`ai.prompt`, transcribe/TTS/image/translate, web search, maps) is ledgered automatically — attributed to the account of the request being handled, the bot user, or the app-wide bucket — so `meterKey` is only needed for a finer breakdown. Budget **enforcement is the platform's**: the admin's spend policy (App Config → Spend) caps the app, each user and unattributed spend; when a cap is reached the metered call throws with `err.code === 'E_NO_CREDITS'` (see Spend & Permissions).
- `ai.models({ provider?, configuredOnly?, enabledOnly? })` — list the available models so an app can build its own model chooser. Returns `{ models: [...], default }` where `default` is the platform's direct-call model `name`. Each entry: `{ name, label, description, provider, modelId, reasoning, disabled, lifecycle, contextWindow, maxOutputTokens, inputCostPerMTok, outputCostPerMTok, hasApiKey, usable, unusableReason, credential }`. **`usable` is the one field to gate on** — it means "callable right now", i.e. not retired, not disabled, and a credential is available for its provider. `unusableReason` is `'retired' | 'disabled' | 'no-credential'` (null when usable), so a picker can grey an entry out and say why. `credential` is `'subscription' | 'api-key'` — how the call would authenticate. `hasApiKey` only reports whether a key is stored; **do not use it to decide availability** — Anthropic models run through the `claude` CLI and are callable on a subscription login with no stored key. Optional filters: `provider` (e.g. `'anthropic'`), `configuredOnly: true` (only `usable` models) and `enabledOnly: true` (every model that is not `disabled` and not retired, whatever its credential state — the owner's Models-page choice, for a chooser that must list every enabled model). Runtime helper: `getModels(opts?)`.
- **`pickModel({ title?, provider?, configuredOnly?, selected?, kind? })`** (runtime helper, frontend) — opens the standard Vistaclair model-picker modal **over your app** and resolves to the chosen model object (same shape as an `ai.models` entry — or, with `kind: 'speech' | 'transcription' | 'image'`, an `ai.mediaModels` entry; store its `modelId`) or `null` if dismissed. This is the easy way to add a "Choose model" button to your own setup UI: render the button yourself, then `const m = await pickModel();` and store `m.name`. Every app uses the identical picker — no need to build your own list UI. Use `getModels()` instead only when you want a fully custom chooser.

{{AVAILABLE_MODELS}}

Pattern for JSON responses:
```js
// Server-side (routes.js) — use expectJson for automatic parsing + repair
const result = await ctx.aiPrompt({ message, systemPrompt, expectJson: true });
if (result.json) { /* use result.json directly */ }

// Frontend — use expectJson via Bridge
const result = await Bridge.call('ai.prompt', { message, systemPrompt, expectJson: true });
if (result.json) { /* use result.json directly */ }
```

Pattern for plain text responses:
```js
const response = await askAI('Diagnose this error: ' + error);
// response is plain text
```

`parseAIResponse(text)` is still available from the platform runtime for manual JSON extraction (handles markdown fences, nested braces, and truncated JSON).

Rules:
- `ai.prompt` / `ctx.aiPrompt` is **the only allowed method for AI text generation** — never `exec` + `claude -p`. The bridge handles proxy routing, Inspector integration and safety constraints.
- Omit `model` for the platform default. For Anthropic models prefer the bare tier name (`"haiku"`, `"sonnet"`, `"opus"`) — it resolves to the latest version so the app never goes stale. For other providers pass the exact registry `name`. For user-configurable selection use `getModels()` / `pickModel()`; never hardcode a model list.
- Pass `retries: 2` for unattended/batch calls — never write your own retry loop.
- Large input goes inline in `message` — no temp files.
- **Do NOT set `authMode`.** Which Claude credential a call uses — the owner's subscription login or their API key — is chosen once on the Models page and applies platform-wide. Setting it per call takes a billing decision away from the person paying.
- `ai.transcribe` / `ai.tts` / `ai.image` / `ai.sfx` / `ai.translate` / `ai.detect` / `ai.route` … / `ai.webSearch` use platform-managed keys: never hand-roll OpenAI/Gemini/Google Maps/search calls over `http.fetch` or ask the user for keys.
<!-- /API:SECTION -->

<!-- API:SECTION key=spend -->
### Spend & Permissions

Metered platform calls — `ai.prompt`, `ai.transcribe` / `ai.tts` / `ai.image` / `ai.sfx` / `ai.translate` / `ai.detect`, `ai.webSearch`, `ai.route` & co — spend the owner's provider keys. The platform meters **every** such call into a per-app ledger (credits = USD × 1000) and gates it against the **admin's spend policy**, wherever the call came from (a route, the Bridge, a job, a bot handler, a tool call). Attribution is inherited from the request/job/bot context automatically; nothing is required of app code.

- The admin sets the policy per app and per deployment mode (`local` / `deployed`) in **App Config → Spend**: preset `unlimited` (everything passes, no identity needed), `metered` (caps per app / per user / unattributed), `locked` (paused) or custom caps. A manifest may *request* a policy — `"spend": { "local": "unlimited", "deployed": { "preset": "metered", "caps": { "app": { "day": 2000 } } } }` — the admin's setting always wins.
- When the policy refuses a call the metered method throws an `Error` with a `code`: `E_NO_CREDITS` (cap reached), `E_RATE_LIMIT`, `E_PAUSED`, `E_NOT_GRANTED` (capability revoked by the admin). Catch it and degrade gracefully (show "out of credits", queue for later); never retry in a loop.
- `spend.status({ principal? })` / `ctx.spendStatus({ principal? })` → `{ mode, preset, paused, unlimited, principal, state? }` where `state.principal.day/month` and `state.app.day/month` carry `{ cap, spent, left }` in credits (`left` is `'unlimited'` when uncapped). Use it to show a balance or grey out an expensive action before the user clicks. Inside a route handler the principal defaults to the account of that request.
- Do **not** hand-roll budget checks against `ai.usage` totals — the platform enforces; your job is the user-facing message.
<!-- /API:SECTION -->

<!-- API:SECTION key=audio -->
### Audio, Image & Translation (Speech-to-Text, Text-to-Speech, Image Generation, Text Translation, Language Detection)
First-class media AI. Keys are managed by the platform (OpenAI, xAI and Google on the Models page; ElevenLabs in Setup → AI Config) — apps do **not** need to store their own keys. Binary data crosses the bridge as **base64**.

**Choosing a model — the same for `ai.tts`, `ai.transcribe`, `ai.image` and `ai.sfx`.** Every call has a default and every default can be overridden per call:
1. `model` — a catalog model id (`ai.mediaModels` lists them; `'provider/model'` also works). The vendor follows from the model: never pick an endpoint yourself.
2. `provider` alone (`'openai'`, `'xai'`, `'google'`) — that vendor's default model for the call.
3. Neither — the **platform default** the owner set in Apps → Setup → AI Config (model plus voice / format / language / aspect ratio / size). Omit `model` unless your app lets the user choose.

The params are **provider-neutral**: `voice`, `format`, `speed`, `language`, `instructions`, `aspectRatio`, `size` are translated to each vendor's own field names. A param the chosen model cannot honour is not sent and is listed in the result's `ignored` array (e.g. `instructions` on xAI) — check it rather than assuming. A value outside the model's range (format, size, aspect ratio, length) throws. A `model` that is unknown, of the wrong kind, or gone at the vendor **throws** and alerts the owner — keeping a stored model current is your app's job, so let the user re-pick (`<vc-model-picker kind="…">`) instead of hard-coding ids.

- `ai.mediaModels({ kind?, method? })` — the media model catalog: `{ models: [...], defaults, refreshedAt }`. `kind` is `'speech'` | `'transcription'` | `'image'` | `'sfx'` (or `method`: `'ai.tts'` …). Each model: `{ name, label, description, method, kind, provider, providerLabel, price, usable, unusableReason, exists, shutdownDate, isDefault, params }`; speech models add `voices: [{ id, name, language?, gender?, description? }]` and `defaultVoice`. **Gate on `usable`** (`unusableReason` is `'no-credential'` or `'missing'`). `params` describes what the model honours — `params.params` (the generic param names), `formats`, `speed` range, `maxChars`, `instructions`, `speechTags` (speech: the model performs speech tags itself — xAI), `languages`, `aspectRatios`, `sizes`, `qualities`, `maxBytes`. `defaults[method]` is the effective platform default (`{ model, voice?, … }`). The list is refreshed daily. Runtime helper: `getMediaModels(opts?)`.
- `ai.voiceSample({ model, voice })` — `{ dataUri, mimeType, cached }`: "Hello, I am <voice>." in that voice, cached platform-wide after the first play. Use it for a ▶ button in your own voice chooser (`<vc-model-picker kind="speech" show-voices>` already has one).

- `ai.transcribe({ audio, model?, provider?, accuracy?, language?, prompt?, diarize?, mimeType?, filename?, response_format?, timestamp_granularities?, enhance?, trimSilence?, denoise?, preprocess?, loudnessTarget?, denoiseNf?, vadThreshold?, minSilenceMs?, speechPadMs? })` — speech-to-text. `audio` is base64 (or a `data:` URI), in any common format (mp3/wav/m4a/webm/ogg/flac…). Returns `{ text, model, provider, ... }`. With no model named, `accuracy: 'high'` picks the vendor's more accurate model (OpenAI `gpt-4o-transcribe`). For word/segment timestamps or SRT/VTT on OpenAI, use `model: 'whisper-1'` with `response_format: 'verbose_json'`; xAI's `grok-voice-transcribe-2.0` returns `words: [{ text, start, end, speaker? }]` on every call (`diarize: true` adds speakers). Size limit per model (`params.maxBytes`: OpenAI 25 MB, xAI 500 MB). Runtime helper: `transcribe(audioBase64, opts?)`.
  - Audio is preprocessed automatically (loudness normalization, VAD silence trimming, 16 kHz mono FLAC; on by default, tunable, never required): details under Transcription preprocessing below.
- `ai.tts({ input, model?, provider?, voice?, format?, speed?, language?, instructions?, sampleRate?, bitRate?, tags? })` — text-to-speech. Returns `{ audio, mimeType, format, dataUri, model, provider, voice, ignored?, rendered? }` where `audio` is base64 and `dataUri` is ready for `new Audio(dataUri).play()`. Runtime helper: `speak(input, opts?)`.
  - `voice` must be one the model offers (its `voices` in `ai.mediaModels`); omitted → the platform default voice if that model offers it, else the model's own default. `instructions` steers tone/style (OpenAI gpt-4o-mini-tts, Gemini TTS). On xAI steer delivery with inline speech tags in `input` (`[pause]`, `[laugh]`, `<whisper>…</whisper>`). `language` is a BCP-47 code (xAI, Gemini). Formats, speed range and the character limit are per model (`params.formats`, `params.speed`, `params.maxChars`) — e.g. OpenAI 4,096 chars, xAI 60,000.
  - `tags` (default `false`) — `input` carries xAI-style speech tags (`[laugh]`, `[pause]`, `<whisper>…</whisper>`…) and **every** speech model performs them: xAI as written, instruction models via plain text + appended `Performance cues: …`, others with the tags mapped away. `rendered: { input, instructions, mode, via }` reports what was sent. Details: Speech tags below.
- `ai.ttsRender({ lines, model?, provider?, instructions? })` — the `batch render`: speech tags rendered for a whole script in a few calls; then plain `ai.tts` per line. Details: Speech tags below.
- `ai.image({ prompt, image?, model?, provider?, aspectRatio?, size?, quality? })` — image generation/editing (Google Gemini, OpenAI gpt-image, xAI grok-imagine). Returns `{ images: [{ data, mimeType, dataUri }], text, model, provider, ignored? }`. Pass `image` (base64 or `data:` URI, or an array) to **edit** an input image. `aspectRatio` e.g. `'16:9'`; `size` a tier `'512'` | `'1K'` | `'2K'` | `'4K'` or `'WxH'` — converted per vendor; allowed values per model are `params.aspectRatios` / `params.sizes` (`imageSize` is accepted as the old name of `size`). Gemini output carries an invisible SynthID watermark. Runtime helper: `generateImage(prompt, opts?)`.
- `ai.sfx({ prompt, durationSeconds?, loop?, promptInfluence?, format?, sampleRate?, model? })` — sound effect from a text description (ElevenLabs). Returns `{ audio, mime, mimeType, format, ext, sampleRate, durationSeconds, bytes, dataUri, model, ignored? }` (`audio` base64; read `mime` / `ext`, never guess the type). `format` `mp3` (default) | `wav` | `ogg` | `pcm`; **`loop: true` with no `format` returns `wav`** (an mp3 gap breaks the loop). Details: Sound effects below. Runtime helper: `generateSound(prompt, opts?)`.
- `ai.translate({ text, target, source?, format? })` — text translation (Google Cloud Translation v2). `text` is a string **or** an array of strings; `target` is a BCP-47 language code (e.g. `'es'`, `'fr'`, `'ja'`). `source` is optional (auto-detected when omitted); `format` is `'text'` (default) or `'html'`. Returns `{ text, translations: [{ text, detectedSourceLanguage }], target, detectedSourceLanguage }` — `result.text` is a string for a string input and an array for an array input. Uses the platform-managed Google key (a dedicated Translate key if the user set one in AI Config, otherwise the shared `google` provider key — the same one `ai.image` uses); no per-app setup. Runtime helper: `translate(text, target, opts?)`.
- `ai.detect({ text })` — language detection (Google Cloud Translation v2 `/detect`). `text` is a string **or** an array of strings. Returns `{ language, confidence, detections: [{ language, confidence, isReliable }] }` — `result.language` is an ISO-639 code for a string input (`'und'` when undetermined) and an array of codes for an array input; `confidence` is 0..1. Same platform-managed Google key as `ai.translate`; no per-app setup. Use it when you need the language *without* translating (e.g. to decide whether to translate at all, or to pick a TTS voice) — if you're translating anyway, `ai.translate` already returns `detectedSourceLanguage` for free. Runtime helper: `detectLanguage(text)`.

```js
// Transcribe a recording (frontend)
const { text } = await Bridge.call('ai.transcribe', { audio: base64Audio, accuracy: 'low' });

// Speak a reply with the platform default model + voice, and play it
const { dataUri } = await Bridge.call('ai.tts', { input: 'Hello there' });
new Audio(dataUri).play();

// The user's own choice, stored by <vc-model-picker kind="speech" show-voices persist-key="ttsModel">
const res = await ctx.tts({ input, model: ctx.settings.get('ttsModel') || undefined, voice: ctx.settings.get('ttsModelVoice') || undefined });

// One script, written once with speech tags, voiced by whatever model each host uses
const { lines } = await ctx.ttsRender({ lines: script.map((l) => ({ input: l.text, model: l.ttsModel })) });
for (const [i, l] of lines.entries()) {
  const { audio } = await ctx.tts({ model: l.model, voice: script[i].voice, input: l.input, instructions: l.instructions || undefined });
}
// …or per line: ctx.tts({ model, voice, tags: true, input: 'Warte— [gasp] <loud>das ist fake!</loud> [laugh]' }) → r.rendered

// Generate an image and show it
const { images } = await Bridge.call('ai.image', { prompt: 'a watercolor fox', aspectRatio: '1:1' });
document.querySelector('img').src = images[0].dataUri;

// Translate text (string in → string out; array in → array out)
const { text: greeting } = await Bridge.call('ai.translate', { text: 'Hello', target: 'es' });

// Detect a language without translating
const { language } = await Bridge.call('ai.detect', { text: 'Bonjour tout le monde' }); // 'fr'
```

From routes.js: `ctx.transcribe(params)`, `ctx.tts(params)`, `ctx.ttsRender(params)`, `ctx.image(params)`, `ctx.sfx(params)`, `ctx.translate(params)`, `ctx.detect(params)`, `ctx.mediaModels(params)`, `ctx.voiceSample(params)` — same shapes.

<!-- API:DETAIL key=audio-speech-tags -->
#### Speech tags — `tags` on `ai.tts`, `ai.ttsRender`

Write a script's delivery **once**, as xAI-style speech tags — inline `[laugh]`, `[pause]`, `[gasp]`, `[sigh]`…, wrapping `<whisper>…</whisper>`, `<loud>…</loud>`, `<slow>…</slow>`, `<emphasis>…</emphasis>`… — and pass `tags: true`. Per model (`ai.mediaModels` → `params`):
- `params.speechTags: true` (xAI) — `input` is sent unchanged.
- `params.instructions: true` (gpt-4o-mini-tts, Gemini) — a cheap LLM pass (metered as your app's `ai.prompt`) turns the line into plain speakable text — every spoken word kept in order, laughs written out (`hah-haha`), `[pause]` → `…`, `<emphasis>` → CAPS — plus one English `Performance cues: …` sentence appended to your `instructions`. The cues never quote the line. The rendering is validated; on any failure a deterministic mapping is used instead — the call never fails because of tags.
- neither (`tts-1`) — the tags are mapped away (same deterministic mapping), no instructions.

`rendered: { input, instructions, mode, via, cached?, fallback? }` on the `ai.tts` result is exactly what was sent: `mode` `'native'` | `'instructions'` | `'plain'`; `via` `'none'` (the line had no tags) | `'native'` | `'plain'` | `'llm'` | `'fallback'` (`fallback` says why); `instructions` is `null` where the model takes none. Without `tags`, brackets are sent as written — OpenAI and Gemini read them aloud.

`ai.ttsRender({ lines: [{ input, model?, provider?, instructions? } | string], model?, provider?, instructions? })` renders a **whole script** first: one LLM pass per ~30 lines, with the neighbouring lines as context, up to 500 lines per call. Top-level `model` / `provider` / `instructions` apply to each line that names none; every line resolves its model like `ai.tts`. Returns `{ lines: [{ input, instructions, mode, via, model, provider, cached?, fallback? }] }` in order — then call plain `ai.tts({ model, voice, input: line.input, instructions: line.instructions || undefined })` without `tags`. A later `ai.tts({ tags: true })` with the same `input` in the same server process also reuses the rendering (`rendered.cached`), but the returned pairs are the path to rely on. `ai.ttsRender` itself is free; its LLM pass meters as `ai.prompt`.
<!-- /API:DETAIL -->

<!-- API:DETAIL key=audio-transcribe-preprocessing -->
#### Transcription preprocessing — `ai.transcribe`

Automatic preprocessing (on by default), tuned for transcription accuracy: (1) **two-pass EBU R128 loudness normalization** — fixes quiet/inconsistent recordings; it only rescales level, so it never colors the audio or hurts accuracy; (2) **Silero VAD speech-trimming** — a learned voice-activity detector cuts the clip down to actual speech (far better than an energy gate: it removes dead air *and* reduces Whisper's tendency to hallucinate over long silences). Only space that is *both* non-speech *and* below an audibility floor is cut — quiet speech the VAD under-scores is kept by an RMS safety-net pass, so audible content (e.g. speech resuming after a pause) is never discarded; (3) conversion to **16 kHz mono FLAC** (Whisper's native rate). So you can send raw mic recordings or any format and get clean, accurate results with no client-side conversion. Leading/trailing dead air is always trimmed; internal gaps are collapsed too, **except** when you request timestamps (then the speech span is kept contiguous so offsets stay aligned). Tune with `enhance: false` (skip loudness normalization), `trimSilence: false` (keep all silence), `denoise: true` (opt in to spectral denoise + band-limit — **off by default because it can reduce accuracy**), or `preprocess: false` (send the original bytes untouched). Fine-grained numeric knobs (all optional, defaults in parens): `loudnessTarget` (integrated-loudness LUFS for `enhance`, −16) — louder toward −12 lifts quiet clips more; `vadThreshold` (Silero speech cutoff 0..1, 0.5) — higher keeps only confident speech, lower keeps borderline audio; `minSilenceMs` (gap before a cut, 100); `speechPadMs` (padding kept around each speech segment so word edges aren't clipped, 30); `denoiseNf` (afftdn noise-floor dB when `denoise:true`, −25) — toward −10 is more aggressive. A clip with no detectable speech returns `{ text: '', silent: true }` instead of erroring. Preprocessing is best-effort — if it fails for any reason, the original audio is sent as-is. When preprocessing changed the audio, the result also includes `enhancedAudioPath` — an absolute path to the cleaned clip saved under `<root>/enhanced-audios/`. **That file is auto-deleted ~60 seconds after the call**, so read or copy it immediately if you want to keep it (it's omitted when preprocessing was skipped or fell back to the original).
<!-- /API:DETAIL -->

<!-- API:DETAIL key=audio-sfx -->
#### Sound effects — `ai.sfx`

Key: the owner's ElevenLabs key (Setup → AI Config). `durationSeconds` 0.5–30 (omit = the model decides); `promptInfluence` 0–1 (higher follows the prompt literally); `loop: true` asks for a seamless loop (model `eleven_text_to_sound_v2` only — a looping call that names no model gets it; a model that cannot loop lists `loop` in `ignored`). Formats: `mp3` (audio/mpeg, smallest, plays everywhere), `wav` (audio/wav), `ogg` (audio/ogg, Opus), `pcm` (audio/L16: raw 16-bit little-endian mono, rate in `sampleRate`). **A looping call with no `format` returns `wav`**: an mp3 encoder pads the start and end with silence, which leaves a gap at the loop point. `sampleRate` (8000–48000, default 44100) is for `wav` / `pcm` only; 44.1 kHz needs the owner's ElevenLabs Pro plan, otherwise the call is repeated once at 24 kHz and `sampleRate` says so. `durationSeconds` of the result is measured from the output. The platform default (model, format, durationSeconds, promptInfluence) is set in Apps → Setup → AI Config; a param on the call wins. Metered per generated second.

```js
const sfx = await Bridge.call('ai.sfx', { prompt: 'heavy wooden door slamming', durationSeconds: 2 });
new Audio(sfx.dataUri).play();
```
<!-- /API:DETAIL -->

<!-- /API:SECTION -->
<!-- API:SECTION key=maps -->
### Maps & Routing (Directions, Distance Matrix, Geocoding, Places, Street View)
Google Maps Platform, with the key managed by the platform (a dedicated Maps key from AI Config, or the Google Translate key — same GCP key with Maps APIs enabled) — apps do **not** need their own keys.

- `ai.route({ origin, destination, waypoints?, travelMode?, computeAlternativeRoutes?, avoidTolls?, avoidHighways?, avoidFerries?, routeModifiers?, departureTime?, arrivalTime?, languageCode?, units?, extraComputations?, fieldMask?, body? })` — directions via the Google **Routes API v2**. `origin`/`destination`/`waypoints[]` each accept an address string (`'Brandenburg Gate, Berlin'`), coordinates (`{ lat, lng }`), or a place ID (`{ placeId }`). `travelMode`: `'DRIVE'` (default), `'WALK'`, `'BICYCLE'`, `'TRANSIT'`, `'TWO_WHEELER'`. Traffic-aware ETAs via `routingPreference: 'TRAFFIC_AWARE'` (+ optional `departureTime` ISO string); `extraComputations: ['TOLLS']` adds toll info; `computeAlternativeRoutes: true` returns up to 3 routes. Returns `{ routes: [{ duration (e.g. '1234s'), staticDuration, distanceMeters, polyline: { encodedPolyline }, description, legs: [{ steps: [{ navigationInstruction, distanceMeters, ... }], ... }], localizedValues, travelAdvisory }] }`. Any native computeRoutes field passes through; `body` merges raw fields, `fieldMask` overrides the returned-field selection. Runtime helper: `getRoute(origin, destination, opts?)`.
- `ai.routeMatrix({ origins, destinations, travelMode?, routingPreference?, departureTime?, ... })` — many-to-many distance/duration matrix (Routes API v2). `origins[]`/`destinations[]` take the same waypoint shapes as `ai.route`. Returns `{ elements: [{ originIndex, destinationIndex, duration, distanceMeters, condition, status }] }` — one element per origin×destination pair. Runtime helper: `getRouteMatrix(opts)`.
- `ai.geocode({ address? | lat/lng? | placeId?, language?, region?, components? })` — forward (`address`) or reverse (`lat` + `lng`) geocoding. Returns `{ status, results: [{ formatted_address, geometry: { location: { lat, lng } }, place_id, address_components, types }] }`. Runtime helper: `geocode('Brandenburg Gate')` or `geocode({ lat: 52.5, lng: 13.4 })`.
- `ai.places({ op?, ... })` — Places API (New). `op` selects the operation:
  - `'search'` (default): `{ query, languageCode?, openNow?, minRating?, locationBias?, pageSize?, pageToken? }` → `{ places: [{ id, displayName: { text }, formattedAddress, location: { latitude, longitude }, rating, userRatingCount, currentOpeningHours, websiteUri, internationalPhoneNumber, types }], nextPageToken }`.
  - `'nearby'`: `{ lat, lng, radius? (m, default 1000), includedTypes? (e.g. ['restaurant']), maxResultCount? }` → `{ places: [...] }`.
  - `'details'`: `{ placeId }` → `{ place }` (adds `regularOpeningHours`, `editorialSummary`, `reviews`).
  - `'autocomplete'`: `{ input, locationBias?, includedPrimaryTypes? }` → `{ suggestions }`.
  - `fieldMask` overrides returned fields on any op. Runtime helper: `findPlaces(query, opts?)`.
- `ai.placePhoto({ name, maxWidthPx?, maxHeightPx? })` — fetch a place photo as base64. `name` is the photo resource name from a search/details response (include `places.photos` in your `fieldMask` to get it — e.g. `"places/ChIJ.../photos/AUac..."`). Default width 800px. Returns `{ data (base64), mimeType, dataUri }` — display with `<img src={dataUri}>` or cache to disk. Same Places API billing (no extra enablement). Runtime helper: `getPlacePhoto(name, opts?)`.
- `ai.streetview({ op?, lat?, lng?, pano_id?, heading?, pitch?, fov?, width?, height?, radius?, source? })` — a ground-level photograph of a known coordinate (**Street View Static API**; the Maps key must have it enabled). Use this, not `ai.placePhoto`, when you need the **outside** of a building: place photos are user-contributed, carry no type, and for hotels and restaurants are mostly interiors. `op` selects the operation:
  - `'metadata'` (default): `{ lat, lng | pano_id, radius? (m, default 50), source? }` → `{ status, pano_id, date, location: { lat, lng }, copyright }`. **Free** — Google does not bill it and the platform meters nothing — so probe coverage and pano age before paying for pixels.
  - `'image'`: adds `heading` (0–360, degrees clockwise from north — point it at the facade), `pitch?` (−90..90, default 0), `fov?` (10–120, default 90; smaller = more zoom), `width?`/`height?` (default and max 640) → `{ status, data (base64), mimeType, dataUri, pano_id, date, location, copyright, width, height, bytes }`.
  - `source: 'outdoor'` applies Google's own filter for **exterior** panoramas (drops indoor ones). Default `'default'`.
  - No coverage is a status, never an exception and never a grey placeholder image: `status` comes back `'ZERO_RESULTS'` with `data: null`, so you can sweep candidate camera points cheaply. `op: 'image'` resolves the panorama through the free metadata endpoint first, so an uncovered coordinate costs **nothing** and every image carries the `copyright` string — Google's terms require you to display it next to the image. Out-of-range `fov`/`pitch`/`width`/`height` are clamped rather than refused. Billed per image. Runtime helper: `getStreetView(opts)`.
- `ai.tiles3d({ op?, uri?, fresh?, timeout? })` — Google **Photorealistic 3D Tiles** (Map Tiles API; the Maps key must have it enabled). `op: 'root'` (default) returns `{ tileset, session, expiresAt, cached }` — the root tileset.json whose `root.children[].content.uri` / child tilesets carry the session token. Walk the tree yourself: a node's `boundingVolume.box` (ECEF centre + half-axes) and `geometricError` decide whether to descend; `content.uri` ending in `.json` is a child tileset, `.glb` a tile. `op: 'fetch', uri` fetches one such URI (relative, exactly as listed) → `{ kind: 'tileset', json }` or `{ kind: 'glb', data (base64), mimeType, bytes, copyright, generator }`, plus `maxAge` / `etag` from the response — honour them (no offline stores, no pre-fetching beyond what you render). Billing is **per root request only** (one per ~3 h session; child fetches are free), so the platform caches the root for the session window and shares it across apps; `fresh: true` forces a new billed root. A fetch that fails with "session expired" means call `root` again. The Map Tiles policy requires renderers to show the Google logo and every tile's `copyright` (semicolon-separated, aggregated, one line) and forbids non-visualisation uses. Runtime helper: `get3dTiles(opts?)`.

```js
// Directions with traffic + tolls (frontend)
const { routes } = await getRoute('Berlin Hbf', { lat: 48.1374, lng: 11.5755 }, {
  travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE', extraComputations: ['TOLLS'],
});
const r = routes[0]; // r.distanceMeters, r.duration ('20512s'), r.polyline.encodedPolyline

// Which of 3 warehouses is closest to the customer?
const { elements } = await getRouteMatrix({ origins: [w1, w2, w3], destinations: [customer] });

// Geocode + nearby cafés
const { results } = await geocode('Alexanderplatz, Berlin');
const { lat, lng } = results[0].geometry.location;
const { places } = await findPlaces(null, { op: 'nearby', lat, lng, radius: 500, includedTypes: ['cafe'] });

// The exterior of a building: probe coverage for free, then buy one framed image
const meta = await getStreetView({ op: 'metadata', lat: 46.4972, lng: 9.8409, radius: 60, source: 'outdoor' });
if (meta.status === 'OK') {
  const shot = await getStreetView({ op: 'image', pano_id: meta.pano_id, heading: 214, pitch: 8, fov: 80 });
  img.src = shot.dataUri;           // and show shot.copyright beside it
}
```

From routes.js: `ctx.route(params)`, `ctx.routeMatrix(params)`, `ctx.geocode(params)`, `ctx.places(params)`, `ctx.placePhoto(params)`, `ctx.streetview(params)`, `ctx.tiles3d(params)` — same shapes. Tip: encoded polylines render directly on a Leaflet map with a small polyline decoder; durations are strings like `'3600s'`.

<!-- /API:SECTION -->
<!-- API:SECTION key=web-search -->
### Web Search (Brave Search)
Live web search via the Brave Search API, with the key managed by the platform (set in Apps > AI Config) — apps do **not** need their own keys.

- `ai.webSearch({ query, count?, offset?, country?, searchLang?, freshness?, safesearch?, resultFilter?, extraSnippets? })` — searches the web. `count` 1–20 (default ~20), `offset` pages through results. `freshness`: `'pd'` (last day), `'pw'` (week), `'pm'` (month), `'py'` (year), or a `'YYYY-MM-DDtoYYYY-MM-DD'` range. `country` is a 2-letter code (e.g. `'DE'`); `safesearch`: `'off' | 'moderate' | 'strict'`; `resultFilter` limits verticals (e.g. `'web,news'`); `extraSnippets: true` adds up to 5 alternative excerpts per result. Returns `{ query, altered, results: [{ title, url, description, age, siteName, thumbnail, extraSnippets? }], news: [...], videos: [...] }` — `results` are the main web hits; `news`/`videos` are populated when Brave mixes those verticals in. `description` may contain simple HTML highlighting (`<strong>`) — escape or strip before inserting into the DOM. Runtime helper: `webSearch(query, opts?)`.

```js
// Frontend: recent news about a topic
const { results, news } = await webSearch('quantum computing breakthrough', { freshness: 'pw', count: 10 });
results.forEach(r => addRow(r.title, r.url, r.description));
```

From routes.js: `ctx.webSearch(params)` — same shape.

<!-- /API:SECTION -->
<!-- API:SECTION key=music -->
### Local Music Generation (MusicGen — optional extra)
Text→music and beat analysis running **locally** (Meta MusicGen on CPU, no API keys). Requires the "Local music generation" extra installed via Apps > Setup > Extras — check availability with `ai.music.status` before offering the feature (`installed: false` → tell the user to enable it in Setup > Extras).

- `ai.music.status()` — `{ installed, queue: { running, pending } }`.
- `ai.music.generate({ prompt, duration?, seed?, model?, continueFrom?, out? })` — **job-shaped**: returns `{ jobId }` immediately, because CPU generation takes minutes (~2–6 min per 30 s clip). Track it like any job (`jobs.get`, `job:update` bridge events); the job result is `{ out, duration, model, seed }` with `out` app-relative (default `.data/music/<ts>.wav`, WAV 32 kHz mono). `duration` max 30 s per call; for longer beds chain calls with `continueFrom: previousOut` (windowed continuation). `model`: `'small'` (default) or `'medium'`. Generations are **queued platform-wide** (one at a time) — the job label shows queue position.
- `ai.music.analyze({ file, tightness? })` — beat/tempo analysis of any audio file (app-relative path). Fast, synchronous. Returns `{ bpm, beats: [s], downbeats: [s], onsets: [s], rms_peaks: [s], duration }` — use it to cut video on beats or sync animations to music.

Note: MusicGen weights are CC-BY-NC licensed (non-commercial use).

```js
// Kick off generation, then follow the job
const { jobId } = await Bridge.call('ai.music.generate', { prompt: 'lofi hip hop, 80bpm, warm', duration: 30, out: '.data/music/bed.wav' });
// ... job:update events until status 'done', then:
const grid = await Bridge.call('ai.music.analyze', { file: '.data/music/bed.wav' });
```

From routes.js: `ctx.music.status()`, `ctx.music.generate(params)` (**direct promise**, not job-shaped — resolves when generation finishes, so call it inside a `ctx.jobs` run; requires `out`), `ctx.music.analyze(params)`.

<!-- /API:SECTION -->

<!-- API:SECTION key=cli -->
### CLI Sessions (Full Claude Code Agent)
- `cli.edit({ action, prompt, autoSubmit?, hidden? })` — launch a full Claude Code session in the app directory. Action: `extend` (modify). Returns `{ tabId }`. It runs in the dashboard's Agent SDK panel as an orchestrator that delegates to workers (a hidden one as a single session), on the owner's Claude subscription; with only an API key the owner confirms the costs first, and a decline rejects the call.

Launch modes controlled by `autoSubmit` and `hidden`:
  - **Pre-populated (default)**: `prompt` text appears in the CLI input; user must press Enter to submit. `autoSubmit` defaults to `false`.
  - **Auto-submit, visible**: Set `autoSubmit: true`. The prompt is written and submitted automatically. The session opens in the dashboard.
  - **Auto-submit, hidden**: Set `autoSubmit: true, hidden: true`. The session runs in the background with no visible tab — useful for automated repairs or silent tasks.

Note: omitting `prompt` opens an empty session (full user control).

"Scoped to the app directory" is *file* scope only: the session runs with the platform's own privileges. Expose a `cli.edit` feature to the app's owner only, never to a public or webhook-driven path (see Trust Model).

- `cli.workspace({ dir, title, instructions, prompt?, autoSubmit?, hidden? })` — a Claude Code session in one of the app's **workspaces**, not an app change. Returns `{ tabId, dir, reused }`.
  - `dir` is a name (`a-z0-9-`) under the fixed root `<appDir>/workspaces/`; the app creates the folder first (a symlink out of `workspaces/` is refused). `workspaces/` is never linted, inferred or snapshotted.
  - `instructions` (required, ≤ 32 KB) is the session's system prompt, after a platform preamble; the folder's own `CLAUDE.md` holds its standing rules. `title` (required) names the tab.
  - Tab id `ws-<app>.<name>`. A fresh launch resumes the newest transcript recorded for that folder. A session already running there is reused (`reused: true`) and `prompt` is typed into it.
  - `hidden: true` requires `autoSubmit: true`, and the app must `showConfirm` with the owner before its first hidden run. A hidden session cannot ask questions; it writes `BLOCKED.md` in the workspace instead.
  - Lifecycle: `Bridge.on('cli:workspace', ({ tabId, dir, state, hidden, reused }) => …)`, `state` `'started'` | `'exited'`.
  - `cli.workspaces({ dir? })` → `[{ tabId, dir, running, hidden }]` — the app's workspace sessions right now, restored tabs included. Call it on load to reconcile a saved `tabId`: the events a closed GUI missed are gone.
  - `cli.interrupt({ tabId })` accepts the app's own tabs only: `app-<name>`, `app-<name>-tools`, its workspace sessions.

Owner only: the `cli.*` methods are reachable from the owner's dashboard alone. The app's close, delete or rename ends its workspace sessions.
<!-- /API:SECTION -->

<!-- API:SECTION key=db -->
### Database (Platform MariaDB)
- `db.query({ sql, params? })` — execute SQL. Returns rows array for SELECT, `{ affectedRows, insertId }` for mutations.
- `db.status()` — returns `{ connected, config }`
- `db.provision()` — provision the app's database on demand. Idempotent. Returns `{ database, user, password }`.

Each app gets its own database (`vc_<appname>`) with a dedicated user. In routes.js: `ctx.provisionDb()` at startup, then `ctx.dbQuery(sql, params)`. From frontend: `Bridge.call('db.provision')` then `Bridge.call('db.query', ...)`. Never install `mariadb` or `mysql2`.

**Schema setup** — use `ctx.ensureSchema(statements)` instead of hand-rolling provision + create-table boilerplate. It provisions the DB and runs the DDL statements serially:
```js
// routes.js
const ready = ctx.ensureSchema([
  `CREATE TABLE IF NOT EXISTS items (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(255))`,
  `CREATE TABLE IF NOT EXISTS tags (id INT PRIMARY KEY AUTO_INCREMENT, label VARCHAR(64))`,
]);
// Gate routes until the schema is ready; surface init failure as a 500 instead of hanging
router.use(async (req, res, next) => { try { await ready; next(); } catch (e) { next(e); } });
```

Do **not** attach `.catch()` to the `ready` promise you gate on (e.g. `const ready = ctx.ensureSchema([...]).catch(console.warn)`) — that swallows the rejection, so the gate always passes and routes run against a broken schema. If you must log, re-throw inside the catch.

**Auto-provisioning:** the platform installs MariaDB, creates an admin user and provisions per-app databases from the Setup panel. If the DB is not connected, direct the user to Apps > Setup. Never install `mariadb` or `mysql2` in the app.

#### Time, expiry & DB-side computation

Compute time windows **in the database**, never in JS — JS `Date`/epoch math drifts against the DB clock (timezone, separate processes) and causes "instantly expired / never expires" bugs. Set expiries with `NOW() + INTERVAL n UNIT`; decide validity in the `WHERE` clause (`expires_at > NOW()`), don't fetch the row and compare in JS. When you touch or add any code/token/session-expiry flow, **test the expiry path, not just the happy path**: a fresh code redeems, an expired one is rejected, a reused/invalid one is rejected.

```sql
INSERT INTO link_codes (code, user_id, expires_at) VALUES (?, ?, NOW() + INTERVAL 10 MINUTE);
SELECT user_id FROM link_codes WHERE code = ? AND expires_at > NOW();
```

#### BIGINT → JS BigInt → `res.json` throws

MariaDB returns `BIGINT` columns as JS **`BigInt`**, which `res.json`/`JSON.stringify` can't serialize (`Do not know how to serialize a BigInt`) — the route 500s and the UI shows a misleading generic error. Large-integer keys (Telegram/Discord ids, snowflakes, BIGINT PKs) always hit this. Fix **once at the boundary**:
```js
router.use((req, res, next) => {
  res.json = (body) => res.type('application/json')
    .send(JSON.stringify(body, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  next();
});
```
**Read the actual server log before theorizing** — a generic UI message ("try again") hides the precise server error that names the real bug.
<!-- /API:SECTION -->

<!-- API:SECTION key=embeddings -->
### Embeddings & Semantic Search (Local Model)
- `embed({ input })` — turn text into a 384-dimension embedding vector using a local model (no API call, no cost, no network). `input` is a string or an array of strings. Returns `{ vectors, dim }` where `vectors` is `number[]` (single string) or `number[][]` (array). Mean-pooled + L2-normalized, so cosine similarity = dot product.
- `embed({ info: true })` — returns `{ model, dim, maxBatch, loaded }` without embedding.

Use this to give an app **real semantic search** over its own data — matches by meaning, not keywords ("I forgot my login" finds "How to reset your password"). Store vectors in the app's own database using MariaDB's native `VECTOR` type + `VECTOR INDEX`, then search with `VEC_DISTANCE_COSINE`. The platform MariaDB (11.8+) supports this directly — do not install any vector DB.

From routes.js use `ctx.embed(input)` (returns the vector(s) directly) and `ctx.vectorLiteral(vec)` (formats a vector for `VEC_FromText(?)`).

Pattern (routes.js — index a dataset once, then search):
```js
// 1. One-time: create a table with a VECTOR column + index
await ctx.dbQuery(`CREATE TABLE IF NOT EXISTS docs (
  id INT PRIMARY KEY AUTO_INCREMENT,
  text TEXT,
  embedding VECTOR(384) NOT NULL,
  VECTOR INDEX (embedding),
  FULLTEXT (text)
) ENGINE=InnoDB`);

// 2. Index the dataset: embed all rows (batch), store vectors
const texts = docs.map(d => d.text);
const vecs = await ctx.embed(texts);            // number[][]
for (let i = 0; i < docs.length; i++) {
  await ctx.dbQuery('INSERT INTO docs (text, embedding) VALUES (?, VEC_FromText(?))',
    [texts[i], ctx.vectorLiteral(vecs[i])]);
}

// 3. Search: embed the query, rank by cosine distance (lower = closer)
const qv = await ctx.embed(userQuery);          // number[]
const hits = await ctx.dbQuery(
  `SELECT text, VEC_DISTANCE_COSINE(embedding, VEC_FromText(?)) AS dist
   FROM docs ORDER BY dist ASC LIMIT 10`,
  [ctx.vectorLiteral(qv)]);
```

Frontend (iframe): `const { vectors } = await Bridge.call('embed', { input: query });` — but storage/search SQL must run server-side via `db.query`.

Notes: re-embed a row only when its text changes (embedding is deterministic). For best results combine vector search with FULLTEXT (`MATCH…AGAINST`) — vectors catch meaning, FULLTEXT catches exact/rare tokens like names, IDs, error codes. The model is English `bge-small`; great for typical app text, not multilingual. First call after a server start incurs a one-time model load (~12s), then it's instant.

<!-- /API:SECTION -->
<!-- API:SECTION key=sysmon -->
### System Monitor
Live host pressure — RAM, CPU (aggregate + per core), swap, disk, load — plus a per-process RAM breakdown, sampled **once** by the platform for every app that asks. Never write your own `/proc/meminfo` or `/proc/stat` reader, or a `setInterval` poll of your own `/api/sys`.

- `sysmon.subscribe({ ttlMs? })` — start receiving `sysmon:sample` events (one every 2 s). Returns `{ ok, intervalMs, until }`. The subscription is a **lease** (default 15 min, max 60 min): renew it while your view is open, and a GUI that goes away without unsubscribing simply expires. Sampling only runs while at least one app is subscribed.
- `sysmon.unsubscribe()` — stop.
- `sysmon.get({ history?, processes? })` — `{ sample, history, breakdowns, armed, intervalMs }`. `history` is up to 300 past samples (~10 min) kept **server-side**, so a reloaded GUI repaints a full chart instead of starting from an empty axis. Pass `processes: true` to also get a fresh breakdown.
- `sysmon.processes()` — the per-process breakdown on its own (does not start sampling).

Listen with `Bridge.subscribe('sysmon:sample', fn)`. Every tick delivers the sample; roughly every 10 s a second event also carries `data.processes`. Dedupe history by `at` — the breakdown event repeats the latest sample.

```js
Bridge.subscribe('sysmon:sample', (s) => {
  const pct = Math.round(100 * s.mem.used / s.mem.total);
  if (s.swap && s.swap.used > 0) warnAboutSwapping();
});
await Bridge.call('sysmon.subscribe', {});
```

**Sample**: `{ at, mem: { total, available, used }, cpu, swap: { total, used } | null, disk: { total, free } | null, load1, load5, load15, cpus }` — bytes throughout. `mem.available` is the kernel's MemAvailable (free + reclaimable), which is what decides whether a job OOMs; `MemFree` reads catastrophically low with a warm page cache. Fields the host cannot answer are `null`, never a guess.

**`cpu`**: `{ count, model, usage, iowait, cores[] }`. `usage`, `iowait` and each entry of `cores[]` are fractions **0–1 measured across the 2 s since the previous sample** — CPU is a rate, so they are `null` on the very first sample (and for a core that has just been hotplugged) rather than a fabricated `0`. `usage` counts iowait as idle and reports it separately: a box at 5% `usage` with 40% `iowait` is thrashing its disk, not resting. `cores[]` is index-ordered and `count` long. Load average (`load1/5/15`, tasks in the run queue) and `cpu.usage` (work actually done) answer different questions — neither is derived from the other.

**Breakdown**: `{ at, platform, apps[], other[], totals }`. `platform` is the dashboard process **including all in-process apps** (they share its process and cannot be separated). `apps[]` are own-process apps and `Bridge.spawn`ed tasks, `{ app, kind, pids, rss, pss, swap }`. `other[]` is the top 10 non-Vistaclair process trees, `{ comm, … }`. Prefer `pss ?? rss`: PSS divides shared pages fairly, RSS double-counts them (a browser's renderers are the classic case). `pss` is `null` when the platform could not read it.

From routes.js: `ctx.sysmon.get()`, `ctx.sysmon.processes()`, `ctx.sysmon.arm(ttlMs)` — `arm` is how a long server-side job makes sure host pressure is being recorded while it runs, whether or not anyone is watching the tab.

> For rendering, use `<vc-sysmon>` — it subscribes, charts RAM and CPU history, draws the per-core strip, and lists the top consumers on its own. Consume the raw events only when you need a custom visual.

<!-- /API:SECTION -->
<!-- API:SECTION key=print -->
### Printing
Print a PDF on the printer attached to the platform host (CUPS). It works **only if the owner set a printer up** in Setup → Drucker and put your app on its allow list; otherwise it reports `available: false`. Never shell out to `lp` / `lpr` yourself and never call `window.print()` for a sheet the owner wants on paper.

- `ctx.print.status()` / `Bridge.call('print.status')` — `{ available, printer, online, pagesLeftToday }`. `available` is true only when printing is enabled, the selected printer still exists and **this app** is allowed. `printer` is its CUPS name (`null` when not available), `online` is false while the printer is disabled or stopped, `pagesLeftToday` is this app's remaining pages (pages × copies) under the owner's daily cap, which resets at local midnight. Show your "Drucken" button only when `available`.
- `ctx.print.pdf({ pdf?, pdfBase64?, title, copies?, duplex? })` / `Bridge.call('print.pdf', …)` — `{ ok, jobId, printer, pages, error? }`. It **never throws** for a rejection: check `ok` and show `error`.
  - `pdf` — a `vc-artifact://` uri of a PDF this app may read (preferred; make it with `ctx.artifacts.put`). `pdfBase64` — the bytes, for small files. Max 20 MB, must start with `%PDF-`.
  - `title` — the job's name in the print queue (control characters are stripped, cut at 80 characters).
  - `copies` — whole number, clamped to 1–5 (default 1). `duplex` — two-sided, long edge; default is the owner's setting.
- Rejected with `ok: false`: not enabled, this app not allowed, daily cap exceeded, not a PDF, over 20 MB, no/unknown artifact, the printer missing or offline. Nothing is printed and nothing counts against the cap.

```js
// routes.js — print a practice sheet that the app already made as a PDF artifact
const st = await ctx.print.status();
if (!st.available) return { printed: false, reason: 'no printer set up' };
const r = await ctx.print.pdf({ pdf: sheet.uri, title: 'Übungsblatt Mathe', copies: 1 });
if (!r.ok) throw new Error(r.error);
```

The owner sees every job (app, title, pages, result) in Setup → Drucker.

<!-- /API:SECTION -->
<!-- API:SECTION key=memory -->
### Platform Memory (Shared, Self-Tending Knowledge Store)
A platform-wide memory every app can read and write — useful for cross-app facts, user preferences, and anything worth remembering across sessions. Writes are cheap (the platform extracts/dedupes/embeds in the background); recall is semantic.
- `memory.remember({ content, scope?, source? })` — store a fact in plain text (e.g. "Jane is the user's accountant, jane@firm.com"). `scope`: `'private'` (only this app can recall it), `'shared'` (default — any app), `'global'`. Returns `{ ok, observationId, deduped }`. Fire-and-forget; the platform structures it later.
- `memory.rememberBatch({ items })` — bulk store (e.g. mining a mailbox). `items` is an array of `{ content, scope?, source? }`. Idempotent per `source` natural key.
- `memory.recall({ query, limit?, distill?, withSources? })` — semantic recall. Returns `{ hits, recent }`. `hits` are structured facts; `recent` are not-yet-consolidated raw writes. Set `distill: true` to also get `{ answer }` — a one-line natural-language answer synthesized from the hits. Set `withSources: true` for provenance.
- `memory.forget({ id })` / `memory.entities()` / `memory.history({ memory_id })`.

From routes.js: `ctx.memory.remember(...)`, `ctx.memory.recall(...)`, etc. (the caller app is recorded automatically; apps cannot read another app's `private` memories).

> Use platform memory for knowledge meant to be **shared or long-lived across the system**. For an app's own private dataset/search index, prefer the app's own DB + `embed` (above).

<!-- /API:SECTION -->

<!-- API:SECTION key=state -->
### App State (Persistent Key-Value)
- `state.get({ key? })` — retrieve a key's value, or all state if no key
- `state.set({ key, value })` — persist a value (atomic writes, concurrent-safe)
- `state.delete({ key })` — remove a key
- `state.clear()` — clear all state
<!-- /API:SECTION -->

<!-- API:SECTION key=settings -->
### App Settings (User-Facing Configuration)
Persistent per-app settings, separate from `state` (use settings for user-facing config, state for internal app data). With these, a simple settings page needs **no routes.js endpoints at all** — read/write straight from the frontend:
- `settings.get({ key })` — get one setting
- `settings.all({ defaults? })` — get all settings, shallow-merged over `defaults`
- `settings.set({ values })` — shallow-merge an object of settings; or `settings.set({ key, value })` for one (value `null` deletes the key)

```js
// app.js — settings page pattern
const cfg = await Bridge.call('settings.all', { defaults: { region: 'eu', limit: 10 } });
// ... user edits form ...
await Bridge.call('settings.set', { values: { region: form.region.value, limit: Number(form.limit.value) } });
```

From routes.js: `ctx.settings.get(key?)`, `ctx.settings.all(defaults?)`, `ctx.settings.set(keyOrObj, value?)`.
<!-- /API:SECTION -->

<!-- API:SECTION key=secrets -->
### Encrypted Secrets
- `secrets.get({ key? })` — get a secret value, or list all secret names if no key
- `secrets.set({ key, value })` — store a secret (AES-256-GCM encrypted). Set value to null to delete.
<!-- /API:SECTION -->

<!-- API:SECTION key=files -->
### Files & Uploads (routes.js)
For user uploads (images, audio, documents) and media serving, use `ctx.files` instead of hand-rolling base64 decoding and streaming:
- `ctx.files.saveBase64(data, { name?, subdir?, mimeType? })` — decode and save an upload. `data` is raw base64 or a `data:` URI. The mimeType is sniffed from a `data:` prefix; for **raw base64 always pass `mimeType`** (e.g. the client-supplied blob type) or it defaults to `application/octet-stream`. The stored `mimeType` is normalised (lowercase, no parameters; malformed → `application/octet-stream`). Saved under `<appDir>/.data/uploads/[subdir/]`; the right extension is appended automatically whenever `name` lacks one (or `name` is omitted). Returns `{ path, mimeType, size }`. Path traversal is rejected.
- `ctx.files.serve(res, filePath, { mimeType?, onMissing? })` — stream a file to the response with **Range support** (required for audio/video seeking). Returns `true` if served. Missing file: calls `onMissing()` if provided (serve a placeholder there), else sends 404 JSON; returns `false`. It never throws on a missing file — don't wrap it in try/catch expecting ENOENT. Served inline with `nosniff` for images (png/jpeg/gif/webp/avif), audio, video, pdf and text/plain; any other type (html, svg, xml, js, unknown) is sent with `Content-Security-Policy: sandbox` (no scripts, no same-origin access), so don't use it to serve an app page — use `public/`.

```js
// routes.js
router.post('/api/avatar', async (req, res) => {
  const { path, mimeType } = await ctx.files.saveBase64(req.body.image, { subdir: 'avatars' });
  res.json({ path, mimeType });
});
router.get('/api/audio/:name', (req, res) => {
  ctx.files.serve(res, `${ctx.appDir}/.data/uploads/${req.params.name}`);
});
```
<!-- /API:SECTION -->

<!-- API:SECTION key=http -->
### HTTP (Server-Side, CORS-Free)
- `http.fetch({ url, options? })` — make an HTTP request from the server. Options: `{ method, headers, body, timeout }`. Returns `{ status, statusText, headers, body }`. SSRF-protected (blocks private/loopback IPs).
<!-- /API:SECTION -->

<!-- API:SECTION key=google -->
### Google Auth (Platform-Level OAuth)
- `auth.google.getToken({ scopes, email? })` — get an access token for Google APIs. Optional `email` targets a specific account (required for multi-account apps). Returns `{ accessToken, email }` if authorized, or `{ authRequired: true, authUrl }` if the user needs to authorize. Open `authUrl` in a popup. Scopes accumulate across apps.
- `auth.google.accounts()` — list connected Google accounts with their granted scopes
- `auth.google.revoke({ email })` — revoke an account's tokens

For Gmail and Google Calendar, do NOT use this — use the platform Email/Calendar Engines (`email.*` / `calendar.*`, below). Use Google Auth only for other Google APIs (Drive, Sheets, …):

```js
const auth = await Bridge.call('auth.google.getToken', { scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
if (auth.authRequired) {
  window.open(auth.authUrl, '_blank', 'popup,width=500,height=600');
  // Listen for completion, then retry
  return;
}
const data = await Bridge.call('http.fetch', {
  url: 'https://www.googleapis.com/drive/v3/files',
  options: { headers: { Authorization: 'Bearer ' + auth.accessToken } }
});
```

<!-- /API:SECTION -->

<!-- API:SECTION key=notify -->
### Notifications (Dashboard-Level)
- `toast.show({ message, sender?, level?, title?, duration? })` — show a toast in the Vistaclair header toast system (visible app-wide even when the app tab is not active; click to open, history in the header bell). `sender` defaults to the app name. Levels: `info`, `success`, `warning`, `error`. Also available as the global `showToast(message, level?, sender?)` — this is the **only** way to show notifications; never build your own toast element.
<!-- /API:SECTION -->

<!-- API:SECTION key=dialogs -->
### Dialogs & Modals (Platform Overlays)
The platform renders confirm dialogs and modals **over your app's iframe** — never build your own modal/backdrop markup, and never use `window.confirm()`/`window.prompt()`. Available as `Bridge.confirm`/`Bridge.modal` and globals `showConfirm`/`showModal`.

⚠️ **These render outside your iframe, so they cannot contain your elements** — no `<vc-model-picker>`, no `<vc-input-bar>` mic, no app markup. When a dialog needs any of those, use the in-iframe **`<vc-dialog>`** component instead (see UI Components). Those are the only two options; hand-rolled panels are not.

- `showConfirm({ title?, message, confirmLabel?, cancelLabel?, danger? })` → `Promise<boolean>`. String shorthand: `showConfirm('Delete this item?')`. Set `danger: true` for destructive actions (red confirm button).
- `showModal({ title, content?, fields?, buttons?, width? })` → a **modal handle**: a `Promise<{ button, values } | null>` (`null` = dismissed) with live-update methods (`update`/`close`/`onButton`/`onChange`), structured content blocks, form fields (text/textarea/select/checkbox/number/drag-and-drop file), inline field hints, and `keepOpen` buttons for running long operations inside the modal.

<!-- API:DETAIL key=dialogs-modal-spec -->
The full `showModal` spec — handle methods, content/field/button shapes, and the canonical patterns (long-running operation in a modal, live validation, dependent dropdowns):

- `m.update({ title?, content?, buttons?, hints?, fieldOptions? })` — re-render those parts of the open modal in place. Fields are never re-rendered (user input is preserved). `hints: { fieldName: 'msg' | { text, kind: 'error'|'ok'|'info' } | null }` shows inline feedback under a field (`null` clears it; `kind: 'error'` also outlines the field red). `fieldOptions: { selectName: [options] }` replaces a select's option list (for dependent dropdowns; current value kept if still present).
  - `m.update({ title?, content?, buttons?, hints?, fieldOptions? })` — re-render those parts of the open modal in place. Fields are never re-rendered (user input is preserved). `hints: { fieldName: 'msg' | { text, kind: 'error'|'ok'|'info' } | null }` shows inline feedback under a field (`null` clears it; `kind: 'error'` also outlines the field red). `fieldOptions: { selectName: [options] }` replaces a select's option list (for dependent dropdowns; current value kept if still present).
  - `m.close(result?)` — close programmatically; the awaited promise resolves with `result ?? null`.
  - `m.onButton(fn)` — `fn({ button, values })` fires when a button with `keepOpen: true` is clicked (modal stays open).
  - `m.onChange(fn)` — `fn({ field, values })` fires as the user edits fields (typing is debounced ~250ms; selects/checkboxes/files fire immediately). Use it for live validation or dependent fetches, then respond with `m.update({ hints })` or `m.update({ fieldOptions })`.
  - `content`: array of structured blocks (or a plain string for a single paragraph). **No HTML is accepted** — everything is rendered escaped:
    - `{ type: 'text', text }` — paragraph
    - `{ type: 'code', text }` — preformatted block
    - `{ type: 'kv', items: [{ key, value }] }` — key/value rows
    - `{ type: 'list', items: ['...'] }` — bullet list
  - `fields`: form inputs, returned in `values` keyed by `name`: `[{ name, label, type: 'text'|'textarea'|'select'|'checkbox'|'number'|'file', options?, value?, placeholder?, required?, rows?, accept?, maxBytes? }]` (`options` for select: `['a','b']` or `[{ value, label }]`; `rows` for textarea height, 2–20).
  - `type: 'file'` renders a drag-and-drop zone (drop, click to browse, or paste from clipboard — e.g. a screenshot). `accept` filters types (e.g. `'image/*'`, applied to drop and paste too), `maxBytes` caps size (default 10 MB). Images/videos/audio show an inline preview thumbnail that opens a full-size lightbox on click — all built in, don't build your own. The value is `{ name, mimeType, size, data }` with `data` a base64 data-URL — POST it to your routes and pass straight to `ctx.files.saveBase64(data, { mimeType })`. `null` if no file chosen.
  - `buttons`: `[{ id, label, primary?, danger?, keepOpen? }]` (default one OK button). The resolved `button` is the clicked button's `id`. `keepOpen: true` buttons do NOT close the modal — they report the click through `onButton` instead.

```js
// Confirm before delete
if (await showConfirm({ message: 'Delete this scan?', danger: true })) await deleteScan(id);

// Edit form in a modal
const r = await showModal({
  title: 'Edit item',
  fields: [
    { name: 'name', label: 'Name', type: 'text', value: item.name, required: true },
    { name: 'active', label: 'Active', type: 'checkbox', value: item.active },
  ],
  buttons: [{ id: 'save', label: 'Save', primary: true }],
});
if (r && r.button === 'save') await saveItem(r.values);
```

**Long-running operation inside a modal** — the canonical pattern is a `keepOpen` button + `onButton` + `update` for live status + `close` when done. This is how you run an AI generation, test, or scan from a dialog and show progress in it:

```js
const m = showModal({
  title: 'Generate post',
  content: '',
  fields: [{ name: 'topic', label: 'Topic', type: 'text', required: true }],
  buttons: [
    { id: 'generate', label: 'Generate', primary: true, keepOpen: true },
    { id: 'cancel', label: 'Cancel' },
  ],
});
m.onButton(async ({ button, values }) => {
  if (button !== 'generate') return;
  m.update({ content: ['Generating…'] });
  try {
    const post = await apiFetch('api/generate', { method: 'POST', body: { topic: values.topic } });
    m.close({ ok: true, post });          // promise below resolves with this
  } catch (err) {
    m.update({ content: [{ type: 'text', text: 'Failed: ' + err.message }] });  // stays open for retry
  }
});
const result = await m;                    // {ok, post} | {button:'cancel',...} | null (dismissed)
```

**Live validation / dependent fields** — `onChange` + `hints`/`fieldOptions`:

```js
m.onChange(async ({ field, values }) => {
  if (field === 'slug') {
    const { taken } = await apiFetch('api/check-slug?slug=' + encodeURIComponent(values.slug));
    m.update({ hints: { slug: taken ? { text: 'Already in use', kind: 'error' } : { text: 'Available', kind: 'ok' } } });
  }
  if (field === 'country') {
    const cities = await apiFetch('api/cities?country=' + encodeURIComponent(values.country));
    m.update({ fieldOptions: { city: cities } });
  }
});
```

One overlay is shown at a time per app (additional calls queue). `update`/`onButton` only act on the currently open modal; `close` also resolves a modal still waiting in the queue. Every dialog automatically shows your app's name in its header — don't repeat the app name in `title`.
<!-- /API:DETAIL -->

### Modal & persistence UI conventions (REQUIRED)

These rules apply to **every** surface you build — `showModal`/`showConfirm` overlays AND any custom modal/panel/drawer you are forced to build for truly custom widgets. They are not optional polish; they make the UI predictable and trustworthy.

- **Closers always sit in the top-right corner.** Every dismissible modal, drawer, or panel must have a single close affordance — an `×` button — in its top-right corner. Don't put the closer at the bottom, on the left, or rely only on backdrop/Escape. (Platform `showModal` already renders this; when you build a custom overlay, match it.)
- **If the top-right `×` is the only steering option, omit the footer/status button bar entirely.** A modal that is purely informational (no Save/Confirm/Cancel choice to make) must NOT carry a bottom button row with a redundant "Close"/"OK" button — the top-right `×` is the sole exit. Only render a footer button bar when it offers a real *decision* (Save vs Cancel, Confirm vs Cancel, a primary action). For `showModal`, this means: pass no `buttons` (or only meaningful ones) rather than a lone dismiss button.
- **Every persisting effect must be visually confirmed in the UI.** Whenever an action changes server-side/persisted state — a save, toggle, create, delete, connect, configure, enable/disable — the UI must show an explicit confirmation that the change was applied: a success toast, an inline `✓ Applied`/`Saved` indicator near the control, a brief highlight/flash of the affected row or section, or an updated status badge. Never let a persisting action complete silently. Drive the confirmation off the server's acknowledgement (the bridge call resolving or a broadcast event), not off the click, so the user only sees "applied" once it actually is. This is the same GUI-reload-resilience contract the platform itself follows: state lives on the server and its current status is always reflected back in the UI.
<!-- /API:SECTION -->

<!-- API:SECTION key=tasks -->
### Background Tasks
- `tasks.list()` — `{ spawned, cron }`: the active spawned processes and cron jobs. CLI sessions are not listed here; an app's own workspace sessions come from `cli.workspaces()`.
- `tasks.kill({ taskType, taskId })` — kill a task. Types: `spawn`, `cron`.
<!-- /API:SECTION -->

<!-- API:SECTION key=events -->
## Receiving Events

Use `Bridge.subscribe(eventName, handler)` to listen for server-pushed events. **Always prefer this over client-side polling.** It is the one subscription API for everything: named platform events (`job:update`, `cron:result`, `spawn:*`) **and** custom `ctx.broadcaster.broadcast({event, ...})` events (it dispatches on `data.event` or `data.type`). Returns an unsubscribe function.

```js
Bridge.subscribe('spawn:stdout', (data) => { /* { spawnId, data } */ });
Bridge.subscribe('spawn:stderr', (data) => { /* { spawnId, data } */ });
Bridge.subscribe('spawn:exit', (data) => { /* { spawnId, code } */ });
Bridge.subscribe('cron:result', (data) => { /* { jobId, stdout, stderr, code } */ });
Bridge.subscribe('job:update', (job) => { /* persisted job record (see Jobs section) */ });
const off = Bridge.subscribe('item:created', (data) => addItemToList(data.item)); // custom broadcast
```

`Bridge.on(event, handler)` / `Bridge.off(event, handler)` are the lower-level named-event primitives (`Bridge.on` also returns an unsubscribe function); `subscribe` covers both named and broadcast delivery, so use it unless you have a reason not to.

### The platform bus (cross-app events)

Every app's `ctx.events.emit` lands on ONE bus, and any app may listen to it —
in `routes.js` (`ctx.events.subscribe`) or in the iframe (`Bridge.bus`). Use it
to react to another app; **never poll another app's routes, state or DB.**
Patterns are kind globs: `*` matches one colon-segment, a trailing `*` the rest
(`minecraft-server:*`, `*:crashloop`, `app:*`). Kinds are `<app>:<kind>`; platform
kinds (`app:error`, `cron:result`, `spawn:exit`, `peer:*`, …) are on the same bus.

```js
// routes.js — fire-and-forget delivery, off the request path, after the emit
const off = ctx.events.subscribe(['shop:order:created', 'app:crashloop'], async (env) => {
  // env = { id, at, app, kind, summary, payload, trust, hop, correlationId, host? }
  if (env.trust === 'untrusted') return;           // e.g. a relayed or third-party origin
  ctx.events.emit('digest:queued', { for: env.id }); // hop = env.hop + 1, same correlationId
});
const recent = ctx.events.history({ kinds: 'shop:*', since: Date.now() - 3600e3, limit: 50 }); // oldest first
```
```js
// app.js — the iframe leases a subscription (renewed for you while the page lives)
const off = Bridge.bus('shop:*', (env) => render(env));
```
Bridge methods, if you need them raw: `events.subscribe({ kinds, ttlMs })` (lease,
5s–24h, default 15m — the events arrive as `bus:event`), `events.unsubscribe()`,
`events.history({ kinds, since, sinceId, limit })` (≤500).

**Finding another app's kinds.** Never guess one. `.vistaclair/migration.md` lists
every app that declares kinds ("Other apps' tools", with a count per app) and
`.vistaclair/apps/<app>.md` names each kind with its description — declared kinds
survive restarts, so they are listed whether that app is running or not. Kinds are
always namespaced `<app>:<kind>`, which is the spelling you subscribe to. An app
that declares nothing yet is one you ask (a change request for a kind), not one you
poll.

Semantics you can rely on:
- **Fire-and-forget only.** No reply travels on the bus. When you need an answer
  from another app, call one of its tools: `ctx.tools.call('<app>', '<tool>', args)`
  on a tool it registered with `expose: 'apps'`. Do not build request/reply on events.
- **Every subscriber gets every matching event** that passed the guardrails (rate
  limit, storm fold, 16KB payload cap) — whatever Horst's policy for that kind is,
  even `ignore`. A folded or rate-limited emit reaches nobody.
- **Chains are bounded.** An emit from inside a handler carries `hop + 1`, the
  `correlationId` of the event it reacts to, and a trust no stronger than that
  event's; the fourth hop is dropped and audited. Log `correlationId` when you
  chain, so the owner can follow a story across apps.
- **A throwing handler is your failure**, recorded against your app (app-guard,
  `events.subscribe`), never the publisher's. The handler's return value is ignored.
- **Own-process apps** (`"runtime": "own-process"`) get `emit`, `declare` and
  `history` but no `subscribe` in `routes.js` yet (`ctx.events.subscribe` is absent
  — feature-detect); the iframe's `Bridge.bus` works from every runtime.
- The log (`history`) keeps the last ~8MB of envelopes, survives restarts, and is
  the same thing Horst reads with his `events_history` tool.

Declare what you emit and what you listen to in the manifest so the Triggers view,
other apps' authors and `npm run infer:capabilities` know what the kinds mean —
`ctx.events.declare` in code is equivalent for `emits`:
```json
"events": {
  "emits":   { "order:created": { "description": "A shop order was placed" } },
  "listens": [ "inventory:stock:low", "app:crashloop" ]
}
```
`ctx.events.declare` also records the kind in your `manifest.events.emits` the
first time it runs, so the manifest stays true without a separate step.
An emit whose kind is declared nowhere is an `app-lint` **error**.

### Realtime Round-Trip Pattern (Mounted Apps)

Server pushes an event after a mutation:
```js
// routes.js
router.post('/api/items', async (req, res) => {
  const item = await createItem(req.body);
  ctx.broadcaster.broadcast({ event: 'item:created', item });
  res.json(item);
});
```

Frontend listens and updates UI:
```js
// app.js
Bridge.on('broadcast', (data) => {
  switch (data.event) {
    case 'item:created': addItemToList(data.item); break;
    case 'item:deleted': removeItemFromList(data.id); break;
  }
});
```

### Publishing events (`ctx.events`) — routes.js only
`ctx.events` belongs to the `events` capability (with `ctx.broadcaster` and `ctx.sse`).
Meaningful state changes go on the platform bus: Horst's senses (catalogued in
Horst → Events with per-kind policies) **and** the one channel other apps subscribe
to (see "The platform bus" under Receiving Events). Kinds are auto-namespaced
`<app>:<kind>`.
```js
ctx.events.declare([{ kind: 'order:created', description: 'A shop order was placed' }]); // once at mount, or manifest.events.emits
ctx.events.emit('order:created', { orderId, total }, { summary: `Order ${orderId} — ${total}` });
```
Declare every kind you emit — declared kinds get sensible default handling and a
description other apps can read; undeclared ones are quarantined as agenda-only
until the owner promotes them, and `app-lint` warns. Payloads are size-capped
(16KB) and rate-limited; emit is fire-and-forget and returns `{ id, outcome,
delivered }` (`delivered` = subscribers reached). An independent app's emit is
delivered and logged but reported `app-only` — Horst never sees it.
<!-- /API:SECTION -->

## Frontend Utilities (Platform Runtime)

`/pro/app-runtime.js` also provides these globals — use them instead of writing your own:

- `escapeHtml(str)` — HTML-escape untrusted text before inserting into `innerHTML`. **Always** use this for any user/API/AI-supplied string.
- `apiFetch(path, opts?)` — fetch wrapper for your app's own API. Resolves relative paths against the app base (`/apps/<name>/`), JSON-encodes object bodies, parses JSON/text responses by content-type, and **throws** an `Error` (with `.status` and `.data`) carrying the server's `error`/`message` on non-2xx. Use it for every call to your routes.js endpoints:
  ```js
  const items = await apiFetch('api/items');
  await apiFetch('api/items', { method: 'POST', body: { name: 'x' } });
  ```
- `timeAgo(ts)` / `formatDate(ts)` / `formatTime(ts)` — human-friendly time labels.
- `initTabs(root?)` — wires `.tab[data-tab]` buttons to `.tab-content`/`.tab-pane` panes (matched by `data-tab-content` or `id="tab-<name>"`), toggling `.active`. Call once after render; uses event delegation.

**Theme CSS components** (`/pro/app-theme.css`, already loaded): besides `.btn`/`.form-input`/`.panel`/`.modal`/`.badge`/`.data-table`, you get `.spinner` / `.spinner-sm` (loading), `.skeleton` (shimmer placeholder), `.progress-bar` > `.progress-fill` (+ `.progress-label`), and `.empty-state`. Never write your own spinner/progress CSS.

<!-- API:SECTION key=ui -->
## UI Components (`vc-*`)

Platform Web Components — shadow-DOM custom elements you drop straight into HTML. Loaded via the single bundle `/pro/vc.js` (already in the scaffold; it includes `vc-core` + every component). Every component is built on the shared `vc-core` base, so they all inherit the same theming, focus ring, spinner and reduced-motion handling — you never restyle those per component. They're theme-aware (inherit the `--accent`/`--border`/… variables) and framework-free. Prefer these over hand-rolling the same control in every app. *(An individual `/pro/vc-<name>.js` also works — it's served with `vc-core` prepended — but the bundle is the default.)*

**Where `vc-*` fits — the three-layer UI model** (use the right layer; don't reach for a component when a class or a bridge call is the answer):
- **CSS classes** (`/pro/app-theme.css`) for dumb styling primitives: `.btn`, `.form-input`, `.panel`, `.badge`, `.status-dot`, `.data-table`. Keep using these for one-off styled elements.
- **`vc-*` web components** for *stateful/behavioral* widgets you'd otherwise hand-roll in every app (input bars, chat logs, progress, empty states, model pickers, media viewers). Documented below.
- **Bridge calls** for anything that must render over the whole dashboard or persist beyond the app panel: `showToast`, `showConfirm`, `showModal`, `pickModel`. These are rendered by the dashboard **outside** your iframe. Never rebuild a *toast*, a *confirm*, or the *full-screen model chooser* as an in-iframe component.

**Choosing a dialog** — the one case where the layers overlap, so pick deliberately:

| You need | Use | Why |
|---|---|---|
| A simple structured form (text / textarea / select / checkbox / number / file) | `showModal()` | Host-rendered, covers the whole panel, fields + hints + live `update()` for free. |
| A dialog containing a `vc-*` component, voice input, or your own markup | `<vc-dialog>` | Host modals are outside your iframe and **cannot** host your elements. |
| A yes/no question | `showConfirm()` | Purpose-built. |
| A notification | `showToast()` | Must outlive the dialog and the app panel. |
| A full-screen model chooser | `pickModel()` | Host-rendered, shows cost + lifecycle tags. |

Do **not** hand-roll modal/backdrop markup for either case, and never use `window.confirm()`/`window.prompt()`. If you find yourself building a card with a header, an `×`, and a footer, you wanted one of the two dialog primitives above.

Available components — each full spec (attributes, properties, events, examples) lives in its own small file under `.vistaclair/api/` in this directory, deferred from this prompt. **Read the component's file before adding one or modifying code that uses one**; this list is only for choosing the right component:

- `<vc-input-bar>` — prompt textarea + voice transcription (mic → `ai.transcribe`) + send button → `ui-input-bar.md`
- `<vc-chat-log>` — scrolling user/AI bubble thread with busy indicator and reload-restore → `ui-chat-log.md`
- `<vc-progress>` — determinate/indeterminate progress bar for long-running work → `ui-progress.md`
- `<vc-empty-state>` — centered icon + message placeholder for empty lists → `ui-empty-state.md`
- `<vc-model-picker>` — inline model dropdown (`kind`: text default, speech/transcription/image; `show-voices`); `persist-key` remembers the choice (in `ctx.settings`) → `ui-model-picker.md`
- `<vc-dialog>` — in-iframe modal that can host `vc-*` components, voice input, or your own markup → `ui-dialog.md`
- `<vc-media-viewer>` — image/video/audio/pdf viewer + lightbox: zoom/pan, gallery, speed, frame-step, fullscreen; video items can open at a `start` time, carry a `timeline` activity strip, `.seek(sec)` and emit `timeupdate` → `ui-media-viewer.md`
- `<vc-markdown>` — safe renderer for markdown + LaTeX math + sized media/SVG embeds (AI output goes straight in) → `ui-markdown.md`

<!-- API:DETAIL key=ui-input-bar -->
### `<vc-input-bar>` — prompt input with voice

A textarea + microphone button (record → transcribe → insert at the caret) + send button, in one element. Use it anywhere you collect a text prompt and want built-in voice input. It does **not** make any API call itself — it emits a `send` event and your app owns the request (so you can attach extra fields).

```html
<vc-input-bar id="prompt" placeholder="Ask anything…" rows="3" send-label="Generate"></vc-input-bar>
```
```js
const bar = document.getElementById('prompt');
bar.addEventListener('send', async (e) => {
  const text = e.detail.text;          // trimmed textarea contents
  bar.busy = true;                     // disables + shows a spinner on Send
  try {
    await apiFetch('api/generate', { method: 'POST', body: { text, /* extra fields */ } });
    bar.value = '';                    // clear only on success (text is preserved on error)
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  } finally {
    bar.busy = false;
  }
});
```

- **Attributes**: `placeholder`, `rows` (default 3), `send-label` (default `"Send"`), `accuracy` (`'low'` default | `'high'` — passed to `ai.transcribe`), `disabled`.
- **Properties**: `value` (get/set textarea text), `busy` (get/set — disable + spinner while your async call runs), and `.focus()`.
- **Event**: `send` with `detail.text` — fired by the Send button **and** by Cmd/Ctrl+Enter in the textarea.
- **Extra controls**: use `slot="controls"` to add inline controls (e.g. a length slider) on the button row, left-aligned: `<input slot="controls" type="range" …>`.
- **CSS parts** for theming: `wrap`, `textarea`, `mic`, `send` (e.g. `vc-input-bar::part(send){…}`).
- **Microphone capability (REQUIRED for voice)**: the mic uses `getUserMedia`, which the host iframe only allows when the app **declares it** in `manifest.json`:
  ```json
  { "capabilities": { "ai": true, "microphone": true } }
  ```
  Without `microphone: true` the iframe is denied mic access and the button hides itself automatically (typed input still works). Transcription itself needs the platform `openai` provider key (Models page); on error the component surfaces a toast and keeps the typed text. Reload the dashboard after editing the manifest so the new `allow` takes effect.
<!-- /API:DETAIL -->
<!-- API:DETAIL key=ui-chat-log -->
### `<vc-chat-log>` — message thread

A scrolling user/AI bubble thread with auto-scroll and a built-in "Thinking…" busy indicator. Pairs with `<vc-input-bar>`. Provide `text` for untrusted/plain content (auto-escaped) or `html` for already-rendered markup (e.g. your markdown renderer output) — never pass unsanitized strings as `html`.

```html
<vc-chat-log id="log" busy-label="Thinking…" style="height:380px">
  <vc-empty-state slot="empty" icon="💬" message="Ask me anything"></vc-empty-state>
</vc-chat-log>
```
```js
log.append({ role: 'user', text: userText });   // escaped
log.busy = true;
const reply = await askAI(userText);
log.busy = false;
log.append({ role: 'ai', text: reply });
log.messages = savedThread;   // replace whole thread (reload-resilient restore)
```
- **Properties**: `messages` (get/set the full array — use on reload to restore), `busy` (get/set — toggles the spinner bubble), `.append(msg)`, `.clear()`, `.scrollToEnd()`.
- **Message shape**: `{ role: 'user'|'ai', text?, html? }` (`assistant` aliases `ai`).
- **Slot** `empty` — shown when the thread is empty (e.g. a `<vc-empty-state>`).
- **Parts**: `log`, `bubble`, `busy`. Auto-scrolls unless the user has scrolled up to read history.
<!-- /API:DETAIL -->
<!-- API:DETAIL key=ui-progress -->
### `<vc-progress>` — job progress

Determinate or indeterminate progress for long-running operations. Drive it by setting `value` (0–100) and `label`; the fill animates. Use `indeterminate` when you can't compute a percentage, and `hide-when-idle` to auto-collapse at 0.

```html
<vc-progress id="job" label="Rendering…" hide-when-idle></vc-progress>
```
```js
job.value = pct;                 // 0..100, fill transitions
job.label = `${done}/${total}`;
job.indeterminate = true;        // marquee when % is unknown
```
- **Attributes/properties**: `value` (0–100), `label`, `indeterminate`, plus the attribute `hide-when-idle` (hides itself when `value` ≤ 0 and not indeterminate).
- **Parts**: `bar`, `fill`, `label`. Replaces hand-rolled `.progress-bar`/`.progress-fill` markup and the `fill.style.width = …` update logic.
<!-- /API:DETAIL -->
<!-- API:DETAIL key=ui-empty-state -->
### `<vc-empty-state>` — empty placeholder

Centered icon + message for empty lists/tables/grids. Use the `message` attribute (or slot body text) and optional `action` slot.

```html
<vc-empty-state icon="🎙️" message="No episodes yet."></vc-empty-state>
```
- **Attributes/properties**: `icon` (text/emoji), `message`. Default slot overrides `message`; slot `action` adds a CTA row.
<!-- /API:DETAIL -->
<!-- API:DETAIL key=ui-model-picker -->
### `<vc-model-picker>` — inline model dropdown

A `<select>` of platform AI models, populated from `ai.models` (or `ai.mediaModels` with `kind`, below). Use this for a model chooser **embedded in your own form**. (For a full-screen modal picker, call the host-rendered `pickModel()` instead.)

Only **usable** models are offered, and that is the default — entries that are retired, disabled, or have no credential are omitted, since picking one cannot produce a working call. Add `all-models` to opt out. A leading **"Latest — auto-updating"** group offers the bare Anthropic tiers (`opus`, `sonnet`, `haiku`, …); prefer those, because they follow new releases instead of pinning a dated snapshot that eventually goes stale. The concrete models below them are grouped into `<optgroup>`s **by provider** in the platform's canonical provider order. Both the grouping and the labels come off the payload, so you never sort or label providers yourself.

```html
<vc-model-picker id="model" value="sonnet"></vc-model-picker>

<!-- remembered across reloads with no app-side code, and readable from routes.js
     as ctx.settings.get('scriptModel'): -->
<vc-model-picker persist-key="scriptModel" placeholder="Default"></vc-model-picker>
```
```js
await model.ready;                       // models loaded
model.addEventListener('change', () => run(model.value));
```
- **Attributes**: `value` (model name or bare tier), `all-models` (also offer models that cannot be called), `provider` (filter to one provider), `placeholder` (label for an empty row), `show-cost` (append `$in/$out per Mtok` to each option), `persist-key` (key under which the choice is remembered), `persist-scope` (`settings` default, or `state`). `configured-only` is accepted and ignored — it now describes the default.
- **`persist-key` is the reload-resilient way to remember a model choice.** The component loads the stored value on `ready` (it outranks the markup `value`) and writes it back on every change. Do **not** hand-roll `settings.get`/`settings.set` or `state.get`/`state.set` around a picker. An empty selection persists as `''`, meaning "use the default".
- **`persist-scope` decides which store backs it.** `settings` (default) writes the app's `.settings.json`, which your **backend** reads as `ctx.settings.get('scriptModel')` — that is what you want for a model choice, because routes.js is what makes the `ai.prompt` call. `state` writes `.state.json`, which only the iframe can read; use it for view preferences the server never needs. A value written under the old state-backed default is still read as a fallback, so an existing app keeps its choice.
- **Properties**: `value` (get/set), `models` (the offered list), `ready` (Promise), `.refresh()`. A stored `value` that is no longer offered is preserved as an extra option rather than silently rewritten — labelled `— unavailable` when it's in the catalog but disabled/retired, `(saved)` when it's gone entirely.
- **Event**: `change` with `detail.value` / `detail.model` / `detail.kind` (and `detail.voice` with `show-voices`).
- **Model types — `kind`**: `text` (the default; everything above) or `speech` / `transcription` / `image`, listed from `ai.mediaModels` (needs the `audio` capability). For a media kind an empty value means **the platform default** (set by the owner in Setup → AI Config) and the placeholder reads "Platform default (<model>)"; the tier group is text-only. `show-voices` (speech) adds a voice `<select>` for the selected model — refilled when the model changes, a voice the new model lacks falls back to its default — and a ▶ that plays `ai.voiceSample`; the `voice` property gets/sets it (`''` = default voice) and `persist-key` stores it under `<persist-key>Voice`. `show-params` adds a one-line summary of the selected model (price, formats, voices, limits, ratios/sizes; context and $/Mtok for text).
```html
<vc-model-picker kind="speech" show-voices show-params persist-key="ttsModel"></vc-model-picker>
<vc-model-picker kind="image" persist-key="imageModel"></vc-model-picker>
```
```js
// routes.js — '' falls through to the platform default
await ctx.tts({ input, model: ctx.settings.get('ttsModel') || undefined, voice: ctx.settings.get('ttsModelVoice') || undefined });
```
<!-- /API:DETAIL -->
<!-- API:DETAIL key=ui-dialog -->
### `<vc-dialog>` — in-iframe modal that can host components

A modal rendered **inside** your iframe, styled to match the platform overlays. Use it whenever a dialog must contain a `vc-*` component, voice input, or your own markup — things `showModal()` structurally cannot host, because it renders outside your iframe. This is the supported alternative to hand-rolling a panel.

```html
<vc-dialog id="extend" heading="➕ Extend episode" submit-label="Extend" keep-open>
  <p>Adds conversation that picks up where the episode leaves off.</p>
  <vc-model-picker persist-key="scriptModel"></vc-model-picker>
  <vc-input-bar id="instr" rows="3" placeholder="Optional direction…"></vc-input-bar>
</vc-dialog>
```
```js
extend.addEventListener('submit', async () => {
  extend.busy = true;                                  // footer disabled, primary spins
  try { await apiFetch('api/extend', { method: 'POST', body: { … } }); extend.close({ ok: true }); }
  catch (e) { showToast(e.message, 'error'); extend.busy = false; }
});
const result = await extend.show();                    // null if dismissed
```

- **Attributes**: `heading` (the title — **not** `title`, which is the native tooltip), `submit-label` (primary button text), `cancel-label` (default `Cancel`), `danger` (red primary), `width` (px, clamped 280–900), `keep-open` (submit fires the event but leaves the dialog open — you call `close()`), `open` (reflected state).
- **Methods / properties**: `show()` → `Promise<result|null>`, `close(result?)`, `.open` (boolean), `.busy` (disables the footer and spins the primary). Mirrors native `<dialog>`.
- **Events**: `submit` (primary pressed), `cancel` (dismissed via `×`, Escape, backdrop, or Cancel).
- **Slots**: default = body. `footer` = replace the entire button row.
- **It enforces the platform dialog rules for you**: the only closer is the top-right `×`, and **omitting `submit-label` renders no footer button row at all** — which is exactly what an informational dialog must do. `busy` also blocks dismissal, so an in-flight submit can't be abandoned. Escape closes only the topmost dialog, and focus returns to whatever opened it.
- **Scope**: being in-iframe it covers the app panel, not the dashboard chrome. That's the trade for hosting components — use `showModal()` when you need to cover everything.
- **Placement**: put the element at the **top level** of your page, not inside a view/section you toggle with `hidden` — a hidden ancestor suppresses it even though the dialog renders `position: fixed`.
<!-- /API:DETAIL -->
<!-- API:DETAIL key=ui-media-viewer -->
### `<vc-media-viewer>` — image / video / audio / file viewer

One viewer for any stored media. Images render to a `<canvas>` with **wheel/pinch zoom toward the cursor, drag-pan, double-click fit⇄2×, and 90° rotate**; **video gets the same zoom/pan plus a playback-speed menu and a position seek bar**; both images and video have a live **adjustments** panel (brightness/contrast/saturation/hue) and a **fullscreen** button for the whole viewer; audio uses native controls; PDFs embed; anything else shows a download card. Kind is auto-detected from the `mime` (including a `data:` URI's mime) then the URL extension — override per item with `kind`. Pass an array for a **gallery** (←/→ or nav arrows step through; the image view resets per item). Works **inline** (fills its host box) or as a **modal** lightbox over the whole page. Use this instead of hand-rolling a canvas zoomer, a video speed/zoom control, or a `<video>`/`<img>` lightbox.

```html
<!-- inline: fills the box -->
<vc-media-viewer src="api/recordings/cam1/file/p_0623.jpg" title="Front door" style="height:420px"></vc-media-viewer>

<!-- modal lightbox: stays hidden until open() -->
<vc-media-viewer id="lb" modal></vc-media-viewer>
```
```js
// single item
lb.open({ src: 'photo.jpg', title: 'Snapshot' });
// gallery (recordings + photos in one surface), starting at index 2
lb.open([
  { src: 'p_0623.jpg', title: 'Photo' },                       // image (canvas zoom)
  { src: 'r_0730.mp4', title: 'Clip', poster: 'thumb.jpg' },   // video
  { src: 'note.pdf' },                                         // pdf embed
  { src: 'export.zip', size: 80345 },                          // download card
], 2);
lb.addEventListener('change', (e) => console.log('now at', e.detail.index));
lb.addEventListener('load',   (e) => console.log(e.detail.kind, e.detail.naturalWidth));

// video at a position, with an activity strip under the seek bar
lb.open([{
  src: 'api/recordings/3/file/r_1020.mp4', title: '10:20',
  start: 42,                                          // opens at 0:42
  timeline: { values: motion,                         // 0..1 per bucket, spread evenly over the duration
              colors: motion.map((m) => m > 0.5 ? '#d33' : '#3a3'),   // optional
              titles: motion.map((m) => Math.round(m * 100) + '%') }, // optional hover text
}], 0);
lb.addEventListener('timeupdate', (e) => syncCursor(e.detail.currentTime, e.detail.duration));
lb.seek(120);
```
- **Item shape**: `{ src, title?, kind?, mime?, poster?, downloadName?, size?, fps?, start?, timeline? }` (or just a `src` string). `fps` (video only) is the known frame rate for accurate frame stepping; when omitted the viewer auto-detects it or falls back to 30 (stepping is then approximate). `start` (video only, seconds) opens the item positioned there once its metadata loads, clamped to the duration — per item, so each gallery entry can carry its own (no `#t=` fragment needed).
- **`timeline`** (video only, optional): `{ values: number[], colors?: string[], titles?: string[], label?: (i) => string }`. `values` are 0..1, one per bucket; bucket `i` of `n` covers `[i/n, (i+1)/n] × duration`. The viewer draws them as a bar strip directly under its seek bar (bar height = value; colour = `colors[i]`, else the theme accent with opacity scaled by the value), with the playhead across it; hover shows the time plus `titles[i]` (or `label(i)`), click/drag seeks. The strip draws before the duration is known, follows resizes and fullscreen, and is swapped per gallery item — an item without `timeline` shows no strip and the layout is exactly as without the feature. To change the data, call `.open()` again.
- **Seeking from code**: `.seek(sec)` moves the current video item to `sec` (clamped to `[0, duration]`; asked before metadata loads, it applies once loaded); a no-op for other kinds. Read-only `currentTime` / `duration` give the current video item's position and length in seconds (`null` for other kinds; `duration` is `null` until known).
- **Attributes**: `src`, `kind`, `title`, `mime` (single-item shorthand), `modal` (lightbox mode — hidden until `open()`), `no-controls` (hide toolbar), `no-download` (hide download button), `frame-step` (video: enable frame-by-frame stepping via wheel/swipe/keys + show the step buttons; also toggled by the toolbar "Frame step" checkbox).
- **Properties**: `items` (get/set array), `index` (get/set), `src` (get/set), `.current()`, `currentTime` / `duration` (read-only, video).
- **Methods**: `.open(itemsOrItem, startIndex?)`, `.close()`, `.go(i)` / `.next()` / `.prev()`, `.zoomIn()` / `.zoomOut()` / `.zoomToFit()` / `.zoomActual()` / `.rotate(deg?)`, `.setSpeed(rate)` (video playback rate), `.seek(sec)` (video position, clamped), `.stepFrame(n=1)` (step n frames, negative = back; pauses if playing; clamps to bounds), `.setFps(fps)` (override the frame rate for the current item), `.setAdjust({ brightness?, contrast?, saturate?, 'hue-rotate'? })` / `.resetAdjust()`, `.toggleFullscreen()` / `.requestFullscreen()` / `.exitFullscreen()` / `.isFullscreen()`.
- **Built-in controls**: images and video share **zoom/pan** (wheel toward cursor, drag, pinch) and an **adjustments** panel (brightness/contrast/saturation/hue — CSS filter, live). Video also gets a **playback-speed** menu (0.25×–4×), a **position seek bar** (own row under the toolbar, with current/total time), an optional **frame-step** mode (enable via the "Frame step" checkbox or the `frame-step` attribute — then a paused video steps one frame per `,`/`.` key, mousewheel notch, horizontal swipe, or the `⏮`/`⏭` buttons; a step on a playing video pauses it first), and keeps its native transport controls. A **fullscreen** button (`⛶`) takes the whole viewer frame fullscreen for any kind (great for image galleries too). Rotate is image-only. Audio/pdf/file are unchanged. With frame-step off, the video mousewheel zooms as before.
- **Events** (composed): `load` `{index,item,kind,naturalWidth?,naturalHeight?}`, `error` `{index,item,message}`, `change` `{index,item}`, `framestep` `{index,item,currentTime,frame,fps,approximate}` (`approximate:true` when fps was estimated/fallback), `timeupdate` `{index,item,currentTime,duration}` (video: a few times a second while playing and after every seek; `duration` is `null` until known — use it to sync your own UI, e.g. a chart cursor), `close`.
- **Keys** (when focused / in modal): `←`/`→` navigate, `+`/`−`/`0`/`1` zoom (image + video), `r` rotate (image), `<`/`>` playback speed (video), `,`/`.` step one frame back/forward (video, when frame-step is on), `f` fullscreen, `Esc` closes a popover then the modal.
- **Parts**: `frame`, `toolbar`, `title`, `stage`, `canvas`, `slot`, `nav-prev`, `nav-next`, `button`, `backdrop`, `speed-menu`, `adjust-menu`, `frame-toggle`, `frame-prev`, `frame-next`, `seek`, `seek-range`, `time`, `duration`, `timeline` (the activity strip; `--vc-mv-timeline-inset` on the host sets its side inset, default `8px` = half the range thumb), `timeline-playhead`, `timeline-tip`.
<!-- /API:DETAIL -->
<!-- API:DETAIL key=ui-markdown -->
### `<vc-markdown>` — rich document renderer (markdown + math + media + SVG)

One element that renders a **VistaDoc**: extended markdown that can also carry **LaTeX math**, **sized media previews**, and **SVG** — all in one safe, theme-aware surface. Use it for any AI-generated or stored rich text: chat answers, reports, notes, docs. It renders standard markdown (CommonMark/GFM) too, so a plain markdown string Just Works. Every media/SVG preview **opens the shared `<vc-media-viewer>` lightbox on click** (don't pair this with a hand-rolled overlay), and all embeds in a doc form one gallery. HTML is sanitized (DOMPurify) and math is rendered with KaTeX — both load automatically; without them the component degrades to escaped text / raw TeX rather than failing.

**A VistaDoc is either a plain markdown string or a JSON object** `{ vcdoc:1, body, assets }`:

```js
md.doc = "# Hi\n\nInline $E=mc^2$ and a list:\n\n- one\n- two";   // plain markdown + math

md.doc = {
  vcdoc: 1,
  body: [
    '# Sensor report',
    'Threshold $\\tau = 0.8$. Energy:',
    '$$E = \\int_0^T p(t)\\,dt$$',
    'Latest frame: ![door](media:cam1){width=160}',   // sized media preview
    'Pipeline: ![flow](svg:diagram){width=320}',       // inline SVG preview
  ].join('\n\n'),
  assets: {
    cam1:    { type: 'media', src: 'api/recordings/cam1/p_0623.jpg', mime: 'image/jpeg', title: 'Front door' },
    diagram: { type: 'svg',   src: '<svg viewBox="0 0 120 40">…</svg>', title: 'Flow' },
  },
};
```

```html
<vc-markdown id="md"></vc-markdown>
<vc-markdown src="api/reports/latest.json"></vc-markdown>   <!-- fetch + render a doc -->
```

- **Body grammar** = CommonMark/GFM, plus three extensions:
  - **Math**: `$…$` inline, `$$…$$` block. Escape a literal dollar as `\$`. Math inside code spans/fences is left alone.
  - **Embeds** use standard image syntax with a scheme: `![alt](media:ID)` and `![alt](svg:ID)`, resolved against `assets[ID]`. A plain `![alt](url-or-relative/path.png)` also renders as a media preview (no asset entry needed). Keep SVG/media **source in `assets`, never inline in the body** — that separation is what stops the markdown/math/SVG renderers from clashing.
  - **Sizing**: a trailing attribute block `{width=320 height=200}` (px or any CSS length). Width-only keeps aspect ratio; **omit both for a small default preview** (`thumb-size` attr, default 200px).
- **Asset shape**: `{ type:'media'|'svg', src, mime?, title?, kind?, poster?, downloadName?, fps? }`. For `media`, the fields pass straight to `<vc-media-viewer>`'s item shape (so `poster`/`fps`/etc. work in the lightbox). For `svg`, `src` is the SVG markup string.
- **Attributes**: `src` (URL to fetch a doc — JSON is parsed, anything else treated as markdown), `thumb-size` (default preview px).
- **Properties**: `doc` (get/set — string or VistaDoc object; re-renders), `assets` (get/set — merge extra assets without rebuilding `doc`).
- **Events** (composed): `embedopen` `{id,item}` (a preview was clicked open), `rendererror` `{message}`.
- **Safety**: pass AI output straight in — it's parsed as markdown and sanitized. Never inject untrusted raw HTML expecting it to run; DOMPurify strips scripts/handlers (including inside SVG assets).
<!-- /API:DETAIL -->
<!-- API:DETAIL key=ui-sysmon -->
### `<vc-sysmon>` — host monitor

Live RAM/CPU/swap/disk/load with **history charts**, a **per-core CPU strip**, and the top memory consumers on the box. Drop the tag in and it does everything: fetches server-side history so it paints a full chart on first frame (including right after a GUI reload), subscribes for live samples, renews its own lease while visible, and unsubscribes when removed. Advertise `sysmon` in the manifest when you use it.

Memory and CPU render as side-by-side figures (hero value + area chart + hover crosshair) and fall to one column under ~560 px. Charts are drawn at the measured pixel width, so they stay undistorted at any size and repaint on resize.

```html
<vc-sysmon></vc-sysmon>
<vc-sysmon show="mem,cpu" marker-mb="8192" marker-label="stage ceiling"></vc-sysmon>
<vc-sysmon show="mem,top" top="5"></vc-sysmon>
<vc-sysmon compact></vc-sysmon>                        <!-- gauge row, no charts -->
```
- **Attributes**: `show` (comma list of `mem,cpu,swap,disk,load,top`; default all), `top` (how many consumers to list, default 3), `compact` (gauges only), `marker-mb` + `marker-label` (draws a reference line on the RAM chart — e.g. the memory ceiling your jobs run under), `hot-mem` / `hot-swap` / `hot-disk` / `hot-cpu` (warn thresholds in %, default 85/5/90/90), `manual` (see below).
- **Properties**: `data` (set a sample), `processes` (set a breakdown), `history` (set an array of samples). Setting any of these implies you are driving it.
- **`manual` mode**: suppresses auto-subscribe for contexts with no app Bridge, or when you already have the data. Feed it via the properties above.
- **Events**: `sysmon-sample` `{sample}` re-emitted on each tick, so the host page can react (e.g. warn on swap) without its own subscription.
<!-- /API:DETAIL -->
<!-- /API:SECTION -->

## Platform Bus, Governance & Horst Surfaces (Architecture D)

The platform ships a resident agent (Horst) that owns all AI *initiative*; apps
are surfaces and instruments. Three ctx surfaces wire an app into that model.
Participation is owner-controlled: `manifest.platformContribution: false` marks
an app **independent** — invisible to Horst (no tool union, no digest, no
governance; `ctx.governance` rejects). Its events still travel the platform bus
to other apps and into the log, but Horst never routes them (audit outcome
`app-only`; greyed in Horst → Events). Default is contributing; never set the
flag from a build session.

<!-- API:SECTION key=governance -->
### Platform Approvals (Governance) — the ONE approval plane (`ctx.governance`)
Never build an app-local approval queue (pending maps, approval tables, client-
side approve execution). AI-initiated mutations stage a proposal with a frozen
payload; the owner decides in ANY surface (your app's UI, the Horst UI, the
platform Telegram bot) against one durable ledger.
```js
// At mount: register your kinds (auto-namespaced '<app>:<kind>', always human-approved)
ctx.governance.registerKind('publish_post', {
  label: 'Publish blog post',
  validate: (p) => { if (!p.title) throw new Error('title required'); },
  describe: (p) => `Publish "${p.title}"`,
  notify: 'none', // or 'tg' to push an approval card to the control chat
  async execute(p) { /* runs on approval */ return { ok: true, summary: `Published "${p.title}"` }; },
});
// Staging (server or via bridge 'governance.propose'):
const { proposal } = await ctx.governance.propose('publish_post', { title, body }, { summary: '…', dedupeKey: 'post:' + slug });
// Rendering + deciding (bridge from the frontend works too):
const pending = await ctx.governance.list({ status: 'pending' });
// The owner edited the draft before approving? Edit THE proposal, then decide it.
const edited = await ctx.governance.update(proposal.id, { ...pending[0].payload, title: 'Edited' });
// version: the one your card rendered (each listed proposal carries `version`)
await ctx.governance.decide(proposal.id, 'approve', { version: edited.version }); // or 'deny'
// What was already decided about these messages (the approved/replied chips):
const byUid = await ctx.governance.decisions({ account, uids: emails.map(e => e.id) });
```
`update(id, payload)` re-validates and re-freezes a **pending** proposal and
records the draft → final diff, so the ledger learns what the owner changed.
Never dismiss a proposal and then perform the act directly — that throws the
decision away. (For a composed reply — `email.send` — the editable field is
`replyText`; `body`/`htmlBody` are regenerated from it on freeze.)

`decisions({ account, uids })` answers "what was decided about THIS
message" from the ledger — `{ uid: [{ at, kind, decision, via, edited,
outcome, summary, proposalId, eventIdx? }] }`, newest first (`eventIdx` is
present only when the decision was about one extracted item of the message —
event 0 vs event 1 of the same mail). Use it for per-message chips instead of
recording approvals in a table of your own; the ledger outlives the proposal
(which is capped and expires), so your own copy would be the only one that
rots.

`decide(id, decision, { version })`: pass the `version` of the proposal your
card showed; an approve whose version is no longer current is refused (the
payload changed since — render it again). Without `version` the approve
covers whatever the payload is now.

`dedupeKey`: a pending proposal with the same kind+key is refreshed in place
instead of duplicated. Platform kinds you may propose (and `update`):
`email.send`, `email.modify`, `calendar.create`, `calendar.update`,
`calendar.delete`, `telegram.send` — any other platform kind is refused.
The proposal's `origin` is always `'app'` (a `meta.origin` you pass is
ignored). User-initiated actions (the user clicked the button) run
directly — the click is the approval; governance is for AI-initiated acts.

### Horst surfaces
`ctx.horst.briefing()` (bridge: `horst.briefing`) returns Horst's latest morning
briefing `{ at, title, text }` — render THAT instead of generating your own.

`ctx.horst.chat(text, { channel })` (bridge: `horst.chat` with `{text, channel}`)
runs one awaited chat turn with Horst — the SAME assistant as the Horst tab and
the control chat, one conversation per app+channel, visible in the Horst tab.
Returns `{ busy, conversationId, text, proposals }`. Apps must NOT run a
competing conversational agent; route chat turns here.
<!-- /API:SECTION -->

<!-- API:SECTION key=fleet -->
### Fleet (Master / Slave Federation)
A master server links slave servers and publishes apps to them. Two kinds of
publish, never mixed:

- **Code publish** (`app.publish`, the publish wizard; `app.rollback`) ships
  the app's git-tracked files only. **An app's `.data/` and every
  `.gitignore`d path are NEVER in a code publish.** To copy data to a slave,
  use the data publish below.
- **Data publish** (`ctx.fleet.dataPublish`) streams a declared set of
  content-addressed blobs from the app's `.data/` to the same app on a slave,
  which imports them in its `receive` hook. Feature-detect it:
  `ctx.capabilities.has('fleet.sync')` / `Bridge.call('capabilities.list')`
  lists `fleet.sync`; keep the action disabled while it is absent. The same
  API on a slave sends UP to its master (`fleet.sync.up`; "Data publish up"
  below).
- **Remote call / job** (`ctx.fleet.call`, `ctx.fleet.jobs`) asks the app's
  own copy on a slave something, or starts a job there (a build on a stronger
  host), with its progress pushed back. Feature-detect with `fleet.call` /
  `fleet.jobs`; details in "Remote call and remote jobs" below.
- **Peer specs** (`peers()[].specs`, `ctx.fleet.self()`) show what a host can
  do (cores, RAM, GPU, display). Feature-detect with `fleet.specs`. `specs` is
  `null` for a slave that is older or has not measured yet; an offline slave
  keeps its last specs and its `at`. `hwGL` / `glRenderer` are `null` when no
  probe tool (`glxinfo`, `eglinfo`) is installed or there is no display;
  `hwGL: false` means a software renderer (llvmpipe, SwiftShader). `extras` maps
  each installed platform extra to its pinned version (`'installed'` when it
  has none). The slow facts are re-measured every 5 minutes (`at`); `load` and
  `ram.availBytes` come fresh with each status snapshot (about every 5 minutes,
  sooner when app health changes).

**Master (`routes.js`)** — every call is scoped to the calling app: its own
transfers, its own `.data/`.

```js
await ctx.fleet.peers()
// [{ peer, host, label, online, supported, error,
//    app: { installed, enabled, running, version, commit, runtime },
//    disk: { freeBytes, marginBytes }, receivers: ['world-*'],
//    specs: { … } | null }]   // hardware specs, below
// the linked slaves where THIS app is installed (offline ones from the last snapshot)
await ctx.fleet.self()   // this host's `specs`, the same shape
// specs = { os: { platform, release, arch, distro },
//   cpu: { model, cores, threads, mhz }, ram: { totalBytes, availBytes },
//   gpus: [{ vendor, model, driver, renderNode: '/dev/dri/renderD128' | null, vramBytes | null }],
//   display: { x11, wayland, display: ':0' | null, hwGL: true|false|null, glRenderer: string|null },
//   load: { avg1, avg5 }, extras: { rust: '1.99.0', … }, at: <ms epoch measured> }
const plan = await ctx.fleet.dataPublish.plan(peer, { name, manifest })
// { peer, name, manifestSha, blobs, need: [sha…], needBytes, haveBytes, freeBytes, marginBytes, fits }
// the delta, asked of the slave app's `have` hook; nothing is sent or created
const { id } = await ctx.fleet.dataPublish(peer, { name, manifest, meta })
ctx.fleet.dataPublish.status(id)        // record or null
await ctx.fleet.dataPublish.cancel(id)  // { ok, slaveCleared } ({ ok, inboxCleared } for one from a slave)
ctx.fleet.dataPublish.list({ peer?, name? })
```

- `name` `[a-z0-9._-]{1,64}` (the app's label, e.g. `world-fe548db4`).
- `manifest` `{ format?, blobs: [{ sha256, bytes, path }], extra? }`: `sha256`
  64 lowercase hex, `bytes` an integer, `path` relative to `ctx.dataDir`. The
  platform refuses an absolute path, `..`, a symlink leaving `.data/`, a
  non-file, and a size that differs from `bytes`. One sha may sit at several
  paths. Limits: ≤ 100,000 blobs, `path` ≤ 1,024 chars, `extra` (app JSON
  handed to the receiver verbatim) ≤ 256 KB, the whole manifest ≤ 16 MB;
  `meta` (kept on the master's record) ≤ 16 KB.
- Same peer + name + manifest = the same transfer: calling `dataPublish` again
  re-attaches to it or resumes it (a broken link, a master or slave restart).
  One running transfer per peer + name; a different manifest under that name
  is refused until it is cancelled. Records: `{ id, peer, name, manifestSha,
  status: running|done|failed|cancelled, phase: plan|sending|receiving, label,
  sentBytes, needBytes, blobs, blobsNeed, blobsDone, summary, error, meta,
  origin }`; `summary` is what the slave's `receive` returned.
- **Who may start it.** Called from a route the OWNER requested (the owner's
  click, or a `ctx.jobs` job that route started), it starts at once — the
  click is the approval — and lands in the governance ledger. Called from
  anywhere else — a tool call by an AI (Horst, an app session, a worker),
  cron, a bot update, an app user — it stages an `app.data_publish` proposal
  the owner approves (dashboard or Telegram only) and returns `{ id, proposed:
  true, proposalId }`; the transfer starts on approval under that `id`.
  Independent apps (`platformContribution: false`) get it too.
- Fails without sending a byte when the delta + a margin (1 GiB or 2 % of the
  disk) does not fit on the slave. Each blob's sha256 is verified there; a
  blob that fails twice fails the transfer. No progress for 30 min fails it.
- `ctx.fleet.dataPublish.on('progress' | 'done', fn)` → unsubscribe: the same
  payloads as the iframe's `fleet:data:*` events, both sides of this app's
  publishes. Listeners are dropped on Stop / restart / reload.

**Slave (`routes.js` of the same app)** — the receiver:

```js
ctx.fleet.onDataReceive('world-*', {           // an exact name, or a * / ? glob; exact wins
  have: async (manifest) => shas,               // sha256s the app already holds (array/iterable)
  receive: async ({ manifest, extra, inbox, peer, signal, setProgress }) => ({ ok: true, summary }),
});                                             // → unregister()
```

- The platform streams every needed blob into `inbox/<sha256>` (same
  filesystem as `.data/`: hard-link or rename them in), verifies each, and
  runs `receive` once as the app job `fleet-data:receive` when all are there.
  `peer` = the master's hostname; `signal` aborts on app stop/reload;
  `setProgress(pct, label)` is the job's. `{ ok: true, summary }` → the inbox
  is removed and `summary` (JSON) is the master's result; a throw or `ok` not
  `true` fails the publish with that reason and keeps the inbox for a retry.
- A blob the app holds is never sent; a second publish of the same manifest
  sends 0 bytes and runs `receive` again — make `receive` idempotent and do
  your own atomic switch in it. The platform never writes outside the inbox;
  an inbox idle for 7 days is removed.
- Register in `setup`; a Stop, restart or reload unregisters (register again
  on the next setup). In-process apps only.
- The master app's `onDataReceive` also receives from its slaves (below):
  `peer` is then that slave's host.

<!-- API:DETAIL key=fleet-data-up -->
#### Data publish up (slave → master, `fleet.sync.up`)

On a slave the same `ctx.fleet.dataPublish` API sends this app's blobs to the
same app on the MASTER, whose `onDataReceive` hooks import them. Feature-detect
with `ctx.capabilities.has('fleet.sync.up')`.

```js
const m = await ctx.fleet.master()
// { peer, host, label, online, receivers: ['world-*'], app: { installed, enabled, running, version },
//   disk: { freeBytes, marginBytes }, error } — or null when this host is no fleet slave
const plan = await ctx.fleet.dataPublish.plan(m.peer, { name, manifest })   // the master app's `have`
const r = await ctx.fleet.dataPublish(m.peer, { name, manifest, meta })
// { id } | { id, attached: true } | { id, proposed: true, proposalId }
await ctx.fleet.dataPublish.cancel(id)  // { ok, masterCleared }
ctx.fleet.dataPublish.status(id) / .list({ name? }) / .on('progress' | 'done', fn)
```

- On a slave the only peer is `m.peer` (the master's host); any other is
  refused. `master()` asks the master (≤ 8 s); `online: false` → it answers
  from the last snapshot, and plan / publish fail with `E_OFFLINE`.
- Everything above holds with the ends swapped: the delta via the master app's
  `have`, the margin on the master's disk, sha256 per blob, resumable across a
  broken link and a restart of either host, `receive` once as the master's job
  `fleet-data:receive`, its `{ ok, summary }` the slave's `summary`, limits and
  expiry the same. Make `receive` idempotent: a repeat runs it again.
- **Who may start it** — the master decides. Inside a remote job the master's
  owner started (`ctx.fleet.jobs.start` after the owner's click, or one the
  owner approved): at once, ledgered `owner via fleet.jobs <id>`. The owner's
  click on the slave's own UI: at once. Anything else (cron, AI, a bot, a
  user, a remote call): an `app.data_publish` proposal on the master,
  `{ id, proposed: true, proposalId }`; approval starts it under that id.
- Records and events carry `dir: 'up'`; `status` / `list` work offline (the
  slave's mirror of the master's record). A cancel on either end ends it.
<!-- /API:DETAIL -->

<!-- API:DETAIL key=fleet-remote -->
#### Remote call and remote jobs (`fleet.call`, `fleet.jobs`)

The SAME app on both ends, over the platform's authenticated master ↔ slave
link (no socket, no secret, no URL in the app). Slave (`routes.js`, in `setup`; a Stop / restart / reload
unregisters):

```js
ctx.fleet.onCall('rb.hello', async (args, { peer, origin, signal }) => ({ busy: false }), { readOnly: true })  // → unregister()
ctx.fleet.onJob('rb.build', async (args, { peer, origin }) => {
  if (!args?.slug) throw new Error('slug required')        // a throw = the start fails with this message
  return { name: 'remote-build', meta: { slug: args.slug }, run: async (job) => { job.setProgress(10, 'fetch'); /* … */ return { ok: true } } }
})                                                          // → unregister()
```

- `name` / `kind` `[a-z0-9._:-]{1,64}`, exact. `peer` = the master's host.
  `origin` = who asked, as the master classified it: `{ kind: 'owner' | 'ai' |
  'cron' | 'bot' | 'user', route?, jobId?, tool?, proposalId? }` (`proposalId`
  = the owner approved it) — refuse by origin if you need to.
- `onCall`: `args` ≤ 256 KB JSON; return JSON ≤ 1 MB (the master's result); a
  throw = `E_REMOTE` there with its message (≤ 4 KB, no stack). `signal`
  aborts on the master's timeout or when it goes away.
- `readOnly: true` (declared HERE, never by the caller): runs for any origin
  without approval and is not ledgered — for status / hello / plan-only calls
  a page load or a cron makes. Everything else needs the owner (below).
- `onJob` returns a `ctx.jobs.start` spec; the platform starts it as an
  ordinary `ctx.jobs` job here (in the job list, `job:update`, interrupted by
  an app stop like any app job), tagged `remote: { peer, id, origin }`. A
  cancel from the master aborts `job.signal`. Its `setProgress(pct, label)` and
  `setMeta` reach the master verbatim.

Master (`routes.js`):

```js
const info = await ctx.fleet.call(peer, 'rb.hello', args, { timeoutMs })   // default 60 s, max 10 min
const { id, proposed, proposalId } = await ctx.fleet.jobs.start(peer, 'rb.build', args, { meta })
ctx.fleet.jobs.status(id)          // record or null
await ctx.fleet.jobs.cancel(id)    // { ok, remoteCancelled }
ctx.fleet.jobs.list({ peer?, kind?, status? })
const off = ctx.fleet.jobs.on('progress' | 'done', (ev) => {})   // the iframe events below; → unsubscribe
```

- Record: `{ id, peer, kind, remoteJobId, status: starting | running | done |
  failed | cancelled, link: 'up' | 'down', progress: { pct, label }, meta,
  remoteMeta, result, error, code, origin, proposalId, startedAt, endedAt }` —
  `meta` yours from `start` (≤ 16 KB), `remoteMeta` the slave job's `meta`.
  Kept on the master across its restarts, re-synced from the slave when the
  link comes back. The slave job outlives a broken link (`link: 'down'`); one
  its host lost (an app or server restart there) ends `failed`, `error:
  'interrupted on <host>'`. `result` is the slave job's return value (the
  `ctx.jobs` 256 KB cap applies).
- Errors (`err.code`): `E_OFFLINE` (not connected), `E_NOT_RUNNING` (the app
  is stopped / not enabled there), `E_NO_HANDLER` (no such `onCall` / `onJob`
  there — or an older vc there: update it), `E_TIMEOUT`,
  `E_TOO_LARGE` (args > 256 KB, result > 1 MB), `E_REMOTE` (the handler threw;
  `err.message` is its message), `E_REFUSED` (governance, `err.proposalId`).
- **Who may.** From a route the OWNER requested (the owner's click, or a
  `ctx.jobs` job that route started) both run at once and land in the
  governance ledger. From anywhere else (an AI tool call, cron, a bot, an app
  user): `jobs.start` stages an `app.remote_job` proposal and returns `{ id,
  proposed: true, proposalId }` — it starts under that `id` on approval, a
  denial ends the record `cancelled` (`code: 'E_REFUSED'`); `call` stages
  `app.remote_call` and throws `E_REFUSED` with `proposalId` — after the
  owner approves, the IDENTICAL call (same slave, name and args) passes ONCE
  within 10 minutes, so retry it then. A `readOnly` handler never needs
  this. Independent apps get the same.
<!-- /API:DETAIL -->

**Own-process apps** have no `ctx.fleet` at all (`ctx.capabilities.has('fleet.sync')`
is false there): the engine runs in the dashboard process. Their iframe still
has the Bridge methods below. No data rollback exists: the slave keeps no
manifest history.

**Iframe** — `Bridge.call('fleet.peers')` (rows carry `specs`), `Bridge.call('fleet.self')`,
`Bridge.call('fleet.dataPublish.plan',
{ peer, name, manifest })`, `Bridge.call('fleet.dataPublish.status', { id })`
(without `id`: the list, `{ peer?, name? }`), `Bridge.call('fleet.dataPublish.cancel',
{ id })`, `Bridge.call('fleet.jobs.status', { id })` (without `id`: the list,
`{ peer?, kind? }`), `Bridge.call('fleet.jobs.cancel', { id })`. Starts and
remote calls stay server-side: the app's route makes them after the owner's
click. Progress, through `Bridge.subscribe`:

- `fleet:data:progress` `{ side, dir, role, id, peer, name, sentBytes,
  needBytes, blobs, phase, label }` and `fleet:data:done` `{ side, dir, role,
  id, peer, name, ok, summary }`. `dir` `down` (master → slave) | `up` (slave
  → master), `role` `sender` | `receiver`.
- On the master `side: 'master'`, `id` the transfer, `peer` the slave, `blobs`
  `{ total, need, done }`. On the receiving slave `side: 'slave'`, `id` is
  `<name>.<manifestSha>`, `peer` the master's host, `sentBytes` the verified
  bytes received, `blobs` `{ need, done }`, `phase` receiving | verifying |
  receive. An up publish: the transfer id and the record's fields on both
  ends (`side` still the host end).
- `fleet:job:progress` `{ id, peer, kind, remoteJobId, pct, label, link,
  meta? }` and `fleet:job:done` `{ id, peer, kind, ok, status, result, error
  }` for remote jobs: `pct` / `label` the slave job's progress verbatim,
  `meta` the slave job's `meta` keys that changed (≤ 16 KB), a `link` change
  emits too. At most 4 events a second per job; the last progress before
  `done` is always delivered.
- `routes.js` gets the same through `ctx.fleet.dataPublish.on` /
  `ctx.fleet.jobs.on`; the ends also reach the bus as the platform kinds
  `fleet:data:done` `{ id, app, peer, name, dir, ok, summary }` and
  `fleet:job:done` `{ id, app, peer, kind, ok }` (`ctx.events.subscribe`).

Platform side (not callable): the master keeps a live channel to every slave;
what arrives reaches Horst as `peer:*` senses (connection, per-app errors and
crash loops, health, host pressure, daily summaries). `app.publish`,
`app.data_publish`, `app.remote_call`, `app.remote_job`, `app.rollback`,
`peer.keys.sync`, `peer.restart` are
governance kinds pinned to Propose (always human-approved); slaves keep the
last few code bundles for `app.rollback`.
<!-- /API:SECTION -->
<!-- API:SECTION key=config -->
### Configurations
Platform-side capability — **apps get no ctx members or bridge methods from
it**. It is the one registry of what Horst may change about how he reads the
owner's world: the tag vocabulary (`email.tags` — the same list as
`email.labels.*`), the document-filing types (`horst.docTypes`) and the mail
triage thresholds (`horst.triage`). Horst reads them with `config_list` /
`config_get` and changes them only through the `config.set` proposal
(ceiling-pinned to Propose); the owner edits the same entries in Horst
Settings › Configurations. An app that needs a new tag adds it through
`email.labels.add`; asking Horst in chat stages the same change for approval.
<!-- /API:SECTION -->

<!-- API:SECTION key=tools -->
## MCP Tools (AI-Callable Features)

Apps can register MCP tools that become available to Claude during `aiPrompt()` calls. This lets Claude call back into the app's features during AI conversations.

### Registering Tools (routes.js only)
```js
ctx.registerTools([{ name, description, inputSchema, returns?, sideEffects?, artifacts?, examples?, version?, timeout?, expose?, kind? }]);
ctx.onToolCall(name, async (args, caller) => {
  // caller = { type: 'self'|'platform'|'app'|'cron'|'gui-test', appName?, instanceId?, sessionTag? }
  // instanceId = the per-aiPrompt session id (present when the call comes from an AI session);
  // sessionTag = whatever that aiPrompt call passed — use it to route concurrent
  // per-user sessions to the right resource. Both are undefined for cron/gui-test/app callers.
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});
```

- **Names**: short snake_case in code (`get_forecast`); on the wire they become `appName__toolName` automatically.
- **Handlers** receive parsed arguments as a plain object and return an MCP result `{ content: [{ type: 'text', text }] }`. A file goes back as an artifact link (`ctx.artifacts.put`, see Artifacts), never as a path. **Errors**: throw, or return `{ content: [...], isError: true }` — Claude sees the text and reasons about it.
- **Timeout** per tool in ms, default 180000 (3 min); set hours (`7200000`) for tools that wait on a user. Work that takes minutes or hours is a job tool (`kind: 'job'`, below). **Register during setup** — tools are available immediately for `aiPrompt()` calls and re-register on restart; schema or handler changes need Stop → Start.

### The tool contract

A tool exposed beyond `self` is a contract for callers that cannot read your code (the platform agent, the MCP broker, orchestration runs, other apps through `.vistaclair/apps/<app>.md`). Every field below is optional; declare them all on an exposed tool (app-lint warns on `tool-returns`, `tool-returns-schema`, `tool-side-effects`):

| Field | Meaning |
|---|---|
| `returns` | **What the result contains.** A JSON Schema of the `structuredContent` you return (preferred), or one line of prose (≤ 300 chars, still accepted). With a schema, every quick call's `structuredContent` is checked against it (required keys and top-level types) and a mismatch is logged — the call never fails over it. A change request that extends the tool holds you to a superset of it |
| `sideEffects` | `'none'` (read-only), `'writes'` (changes this app's own state), `'external'` (sends or spends outside: mail, Telegram, paid APIs). **Absent = `'writes'`.** Shown in the catalog next to the tool's name |
| `artifacts` | `{ accepts?: ['image/*', …], produces?: ['model/gltf-binary', …] }` — mime types or globs of the artifact links the tool takes in its args and returns (see Artifacts) |
| `examples` | Up to 3 `{ args, note? }`; each `args` is checked against `inputSchema` at registration (a misfit is warned, and app-lint `tool-examples` repeats it). Agents copy examples verbatim |
| `version` | A short string you bump on a breaking change |

The platform computes a **`contractHash`** per tool from `inputSchema` (without `_wait`), `returns`, `kind` and `sideEffects` — description, examples and version are not part of it. It is stored in `manifest.tools` and shown in the catalog. When a re-registration changes it, the platform broadcasts `app:tools:contractChanged { appName, tool, before, after, compatible, problems }`. **Compatible** means: input properties only added (optional), nothing removed or renamed, nothing newly required, no type or enum narrowed, the kind unchanged, `sideEffects` not escalated, and no result property removed or retyped. Extend a tool compatibly; a breaking change is a new tool name (or a `version` bump the callers are told about).

```js
ctx.registerTools([{
  name: 'list_tasks', expose: 'apps', sideEffects: 'none', version: '1',
  description: 'List open tasks, newest first. Read-only.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } } },
  returns: {
    type: 'object', required: ['items', 'total'],
    properties: {
      items: { type: 'array', description: '[{ id, title, dueAt? }] — dueAt is an ISO string' },
      total: { type: 'integer' },
    },
  },
  examples: [{ args: { query: 'invoice', limit: 5 }, note: 'the five newest invoice tasks' }],
}]);
ctx.onToolCall('list_tasks', async (args) => {
  const out = await listTasks(args);
  return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
});
```

Every tool you register needs an `onToolCall` handler with the same name, and every handler a registered tool (app-lint `tool-drift`; it also flags `manifest.tools` entries the code never registers). `manifest.tools` is written by registration — never edit it by hand.

### Exposure levels (`expose`)

| Level | Who can call the tool |
|---|---|
| `self` (default) | This app's own `aiPrompt()` sessions + GUI test |
| `platform` | + platform AI sessions and platform cron `tool` jobs |
| `apps` | + other apps via `ctx.tools.call()` |

Levels are strictly nested; enforcement is central and every call is audited (GUI → Tools tab). There is **no network level** — tools are never reachable by app users or anonymous visitors. The one non-loopback consumer is the platform's **MCP broker**: tools with `expose: 'platform'` or `'apps'` are automatically served to owner-class platform AIs (Horst, CLI tabs, minted MCP sessions) as part of the live platform tool catalog — **write your tool names and descriptions so an AI that has never seen your app can pick and use them correctly**. Registering a tool with `expose` beyond `self` sets manifest `autostart: true` by default (explicit `autostart: false` is respected) so the tools stay available.

### Long-running tools (`kind: 'job'`)

A tool that renders, converts or waits for minutes or hours is registered with `kind: 'job'`. Callers call it like any tool: they get the result inline when it finishes within their wait (`_wait` seconds, default 30, max 120 — the platform strips it before your handler runs), otherwise a job id at once, and the result is **delivered to them later** (an agent gets it as a message, an app through `ctx.tools.onJobDone`). `_wait`/`_plan` are reserved. Work that outlives the call is a job tool returning its result (app-lint `tool-async-not-job`). You write one handler for both cases:

```js
ctx.registerTools([{
  name: 'render_scene', kind: 'job', expose: 'platform',
  description: 'Render a .blend scene to an MP4.',
  inputSchema: { type: 'object', properties: { scene: { type: 'string' } }, required: ['scene'] },
  returns: 'text summary + a resource_link to the MP4',
  timeout: 2 * 3600 * 1000,            // max runtime: default 4 h, max 24 h
}]);
ctx.onToolCall('render_scene', async (args, caller, job) => {
  job.progress(0, 'starting');           // → ctx.jobs progress (job:update events)
  const quality = await job.ask('Draft or final quality?', { timeoutMs: 600000 }); // the caller answers
  const out = await render(args.scene, { quality, signal: job.signal, onFrame: (pct) => job.progress(pct, 'rendering') });
  job.notify('Frames done, encoding');   // one-way note to the caller
  const art = await ctx.artifacts.put(out, { name: 'render.mp4' });
  return { content: [{ type: 'text', text: `Rendered ${args.scene}` }, art.link] };
});
```

- The handler runs inside **your app's `ctx.jobs`** (name `tool:<tool>`, meta `{ toolJobId, tool, caller }`), so it shows in your job list and `job:update` events.
- `job`: `id` (`tj_…`), `progress(pct, label)`, `notify(text)`, `ask(question, { timeoutMs? })` → Promise of the answer (rejects on timeout, cancel or end; also rejects when the caller has no way to answer), `signal` (an AbortSignal: aborted on cancel, on timeout and when your app stops — stop work promptly).
- Exceeding `timeout` cancels the job with status `error` / "timed out". Return or throw exactly as from a quick tool.
- **Be idempotent.** A job whose server or app stopped mid-run ends `interrupted`; the caller is told and will usually call again with the same arguments. Key the work on its inputs (an output path or a hash of the args) and continue from what already exists instead of restarting.
- A caller with no way to be told later (your own `aiPrompt()` sessions, platform cron, the GUI tester) simply waits until the job ends.

### Calling other apps' tools (routes.js only)
```js
const result = await ctx.tools.call('other-app', 'tool_name', { arg: 1 });
```
Works only for tools registered with `expose: 'apps'`, and only for an **in-process** target — an own-process app is not reachable this way; react to its events on the bus, or ask for what you need with a change request. An in-process target is lazy-mounted if stopped. Prefer composing with an existing tool over reimplementing the capability.

**Declare the dependency.** Calling another app's tools needs an approved dependency, which the owner sees in Setup → Tools & Access. A change request that delivered the tool records it; for a tool that already exists, run once from this app's change session:
```
node ../../platform/scripts/app-change.js depend --on other-app --tools tool_name,other_tool --why "<one line: what this app uses them for>"
```
`.vistaclair/apps/<app>.md` says whether this app has one ("Declared dependency: yes/no"). An undeclared call is flagged, or refused when the owner enforces dependencies; app-lint warns on a literal `ctx.tools.call` without one. Your own tools that other apps depend on are listed as "Used by other apps": keep them backwards compatible.

Calling a **job tool** (`kind: 'job'` in `.vistaclair/apps/<app>.md`): `ctx.tools.call` returns the result when the job ends within `_wait` (pass `_wait` in args; default 30 s, `0` = return at once), else `{ structuredContent: { jobId, status: 'running', tool } }`. The outcome then arrives at your handler — durable: undelivered outcomes are queued and flushed when you register it, also after a restart:

```js
ctx.tools.onJobDone(async (rec) => {      // rec: { id, app, tool, status: done|error|cancelled|interrupted, result, error, … }
  if (rec.status === 'done') await save(rec.id, rec.result);
});
ctx.tools.onJobQuestion(async (rec) => answerFor(rec.pendingQuestion.text)); // → the answer string
ctx.tools.job(id);            // the record (status, progress, pendingQuestion, result)
ctx.tools.cancel(id);         // → { ok, status }
ctx.tools.reply(id, 'final'); // answer a pending question yourself
const result = await ctx.tools.callAndWait('render-app', 'render_scene', { scene: 'a' }); // waits for the end; not durable
```
Register both handlers during setup. On `interrupted`, call the tool again — a well-built provider continues.

Which apps offer what is listed in `.vistaclair/migration.md` ("Other apps' tools"), one line per app. The detail — each tool with its parameters, which are required, and its `returns` — is in `.vistaclair/apps/<app>.md`; read that file before you call the app.

### Using Tools in AI Calls
```js
ctx.aiPrompt({
  message: '...',
  systemPrompt: '...',
  allowedTools: [
    'mcp__app-tools__myapp__tool_name',  // app tools
    'Read', 'Bash', 'WebFetch'           // standard Claude tools
  ]
});
```

Every tool the AI session needs must be listed in `allowedTools` — no defaults. Standard Claude tools: `Read`, `Write`, `Edit`, `Bash`, `Agent`, `WebFetch`, `WebSearch`, `AskUserQuestion`. Platform AI sessions (`aiPrompt` from platform code) additionally see all apps' `platform`/`apps`-exposed tools under the same `mcp__app-tools__<appName>__<tool>` naming.

### Manifest: `autostart`
`manifest.json` supports `autostart: true` — the app is started automatically at server boot. Set implicitly when a tool is exposed beyond `self`; can be set or cleared manually.
<!-- /API:SECTION -->

<!-- API:SECTION key=artifacts -->
### Artifacts

A file a tool produces (a GLB model, a video, a PDF…) goes to its caller **as a reference, never as an absolute path or a big base64 string**. `ctx.artifacts.put` copies the file into the platform's content-addressed store and returns a record whose `link` is an MCP `resource_link` block for `vc-artifact://<id>`:

```js
ctx.onToolCall('export_model', async (args) => {
  const out = path.join(ctx.dataDir, 'renders', `${args.name}.glb`);
  await render(args, out);
  const art = await ctx.artifacts.put(out, { name: `${args.name}.glb`, labels: { scene: args.name } });
  const text = `Exported ${art.name} (${art.size} bytes): ${art.uri}`;
  return { content: [{ type: 'text', text }, art.link] };
});
```

- `ctx.artifacts.put(pathOrBuffer, { mime?, name?, labels?, description? })` → `{ id, uri, sha256, size, mime, name, createdAt, producer, link }`. A path is relative to the app directory (or absolute inside it); `..` and symlinks out of the app are refused. The file is copied — keep or delete your own copy freely. `mime` is guessed from the extension. Identical bytes are stored once. Inside a tool handler (or a job it started) the caller is granted read automatically and `producer` records the tool, call and job.
- `ctx.artifacts.get(ref)` → the record, or null when unknown or unreadable. `ref` is the id or the `vc-artifact://` uri.
- `ctx.artifacts.import(ref, destRel)` → `{ path, size, sha256, mime, name }` — copies an artifact you may read into your app directory (relative path, inside the app). Use it when a caller passes you a `vc-artifact://` uri in a tool argument: passing it grants your app read access.
- `ctx.artifacts.pin(ref, reason)` / `ctx.artifacts.unpin(ref)` — unpinned artifacts are deleted after the retention period (default 30 days); pin what must outlive it.
- `ctx.artifacts.list({ app?, producer?, pinned? })` — the artifacts your app may read, newest first.
- Each producing app has a storage quota (default 5 GB); `put` throws a clear error above it.
- Bridge (iframe): `Bridge.call('artifacts.get', { ref })`, `Bridge.call('artifacts.list', { pinned? })` — records only, never file paths.
<!-- /API:SECTION -->

<!-- API:SECTION key=identity -->
### Identity & linking

`ctx.identity` is the per-app user identity, present for every app (the method list is under
"Routes.js Context" below). Two request contexts resolve to ONE user row:

- **Bot / mini-app** — the request carries a verified Telegram (or WhatsApp) user;
  `ctx.identity.resolve(req)` → `{ userId, via: 'telegram', user }`. Make `users.id` that id:
  there is no separate "dashboard account".
- **Dashboard** — the browser has a VistaClair session but no app identity. The user proves who
  they are once with a 6-digit link code (`issueLinkCode` in the chat → `redeemLinkCode` in a
  route → `issueSession` mints a signed bearer token the frontend stores), after which
  `resolve(req)` → `{ userId, via: 'session' }`.

`ctx.identity.require` is the one guard that authenticates both. A request carrying only the
platform owner cookie resolves as `{ userId: null, via: 'owner' }` and still 401s on `require`.
The full round-trip with code is in `.vistaclair/api/telegram-identity.md`. For
**email/password accounts**, or one account reachable by both Telegram and email, do not build on
`ctx.identity` — declare `manifest.auth` and use `ctx.auth`
(`.vistaclair/api/telegram-auth.md`, "Multi-user, email/password, and linking").
<!-- /API:SECTION -->

<!-- API:SECTION key=capabilities -->
### Capabilities, access levels, and full-screen mode

These are **manifest flags** the owner toggles in the app settings, Config tab (or you set at build time):

- **`capabilities`** — an **advertisement** of what the app uses, for BOTH app surfaces. It never
  gates anything: every capability in the Section Index is available at runtime regardless (the
  `routes.js` ctx and the GUI Bridge expose the full platform surface for the app;
  feature-detect with `ctx.capabilities.has('email')` / `ctx.capabilities.list()`; frontends
  call `Bridge.call('capabilities.list')`). The keys are exactly the capability names in the
  Section Index above (e.g. `"capabilities": { "db": true, "ai": true }`; `ai` also covers
  `audio`, `maps`, `web-search`, `embeddings`, `music`; `governance` includes the `horst.*`
  surfaces). The declaration drives documentation inlining, the admin's Spend & permissions
  panel and platform tooling (e.g. Setup → Telegram flags apps advertising `telegram` that have
  no bot yet), so keep it accurate — refresh it with `npm run infer:capabilities -- <appDir>
  --write` after building or changing the app. Cosmetic / app-local surfaces (`jobs`, `tasks`,
  `notify`, `dialogs`, `files`, `events`, `ui`, `tools`, `identity`, `licensing`, `cli`,
  `capabilities`) are not worth advertising; `ctx.appName/appDir/dataDir/basePath` are always
  present.
- **The access level** — who can reach the app without the VistaClair login. It is **derived**,
  never set on its own:

  | Level | Manifest | Cookieless | Server ctx |
  |---|---|---|---|
  | **Private** (default) | no login channel in `auth` | nothing | full |
  | **Users** | `auth.telegram` / `auth.whatsapp` / `auth.email` | the `app` entry surface (root 302 → `app.html`, `app.html`, `app.css`, `app/**`, `/api/app/*` guarded, `/api/app/pub/*` anonymous) | full |
  | **Open** | `surfaces.public.pages: ["**"]` and **no** login channel | the whole subtree | full minus the admin's revocations (owner services revoked by default) |

  An app with users **is never Open**: if both are present the `"**"` is ignored. An app with a
  bot is therefore never Open either — bots need users. Open is for a pure anonymous site with no
  identity at all; on the flip the platform revokes `email`, `calendar`, `google`, `telegram`,
  `whatsapp`, `apps` and `governance` for that app in the spend policy (the admin can re-grant).
  Reachable from a custom domain = Users or Open.
- **`surfaces`** — the optional narrow anonymous surfaces. Manifest-only, not in the UI:

  ```json
  "surfaces": {
    "public": {
      "landing": "landing.html",          // served at the app root for non-owners (302; wins over app.html)
      "pages": ["share.html"],            // static globs exempt from the owner cookie ("**" = Open)
      "api":   ["/api/public-feed"]       // EXTRA app-auth guard exemptions (NOT cookie exemptions)
    }
  }
  ```

  - `public.landing` — one self-contained page; anonymous visitors hitting the app root are
    302'd to it (owners always get the normal app). Build it on the **landing kit**: one script
    tag (`<script src="__surface/kit.js"></script>`) + `VistaSurface.init({ mount, next })`
    renders hero + login card (email, Telegram link-code with the bot deep link) + licence tiers,
    themable via `--vs-*` CSS custom properties. Without a landing, a Users-level app's root
    sends anonymous visitors to `app.html` (make it branch: no identity → landing view).
  - `public.api` — extra prefix exemptions from app-auth's default-deny guard, for routes that
    cannot live under `/api/app/pub/` (e.g. an app that self-gates its whole `/api/app/`
    prefix with its own identity model). They do NOT lift the owner cookie.
  - `user.entry` — **do not declare it.** The entry surface is always `app`, derived from the
    `auth` block; a value left in a manifest is ignored (app-lint flags anything but `"app"`).

  Two hard rules for anything above Private: (1) **gate every data route per-user**
  (`ctx.auth.require` / `ctx.identity.require`) — the default-deny guard does this for `/api/*`,
  and `/api/app/pub/*` routes validate their own token; never trust unauthenticated input.
  (2) The Bridge is **never** exposed to cookieless visitors (owner privilege); owner-level work
  runs in the dashboard/full-screen surfaces where the owner is present.
- **Revocations (`grants`)** — the admin may revoke a capability for an app in Spend &
  permissions: the module is then **physically absent** from `ctx` (and `ctx.capabilities.has()`
  says so), refused on the Bridge, and a metered call is blocked live. Only owner services and
  metered calls are revocable (`email`, `calendar`, `google`, `telegram`, `whatsapp`, `apps`,
  `governance`, `ai`, `audio`, `maps`, `web-search`); the modules an app needs to boot never
  are. Feature-detect before using an owner service if the app may run under a revocation.
- **`display: "fullscreen"`** — presentation only: how the OWNER opens the app from the
  dashboard (a chrome-free tab via the launcher instead of an in-dashboard panel, same Bridge).
  It has no effect on visitors, Telegram, or a custom domain. Toggled in the app's settings (⚙ → Config).

**Security principle:** owner apps are trusted; cookieless surfaces are confined by the guard and
by their own tokens. Write every `/api/app/*` route as if the request is hostile — parameterized
`ctx.dbQuery` only (never string-built SQL), never feed user input to a shell, allowlist any
recipients. The admin's revocations are the backstop so that even a coding mistake can't reach
what was taken away — but they are the LAST line, not the only one.
<!-- /API:SECTION -->

<!-- API:SECTION key=email -->
<!-- API:DETAIL key=email-accounts -->
### Email Accounts (Platform-Level)
- `accounts.email.list()` — list configured email accounts. Returns `[{ email, type, provider, imap: { host, port, tls }, smtp: { host, port, tls } }]`. No passwords.
- `accounts.email.credentials({ email })` — get full credentials for an account (including password). Returns `{ email, username, password, imap, smtp }`. **Only available via routes.js `ctx` — not exposed to iframe JavaScript.**

From routes.js: `ctx.emailAccounts.list()` and `ctx.emailAccounts.getCredentials(email)`.

Pattern (routes.js):
```js
const accounts = ctx.emailAccounts.list();
for (const acc of accounts) {
  const creds = ctx.emailAccounts.getCredentials(acc.email);
  // Use creds.password, creds.imap, creds.smtp to create IMAP/SMTP connections
}
```
<!-- /API:DETAIL -->

**Important**: Apps should almost never open their own IMAP/SMTP connections. The platform **Email Engine** (below) already syncs every configured account into a master store and exposes list/get/modify/send/search — use `email.*` instead. Raw credentials remain available for the rare case the engine doesn't cover.

### Email Engine (Platform Master Mail Store)

The platform continuously syncs all configured email accounts (IMAP IDLE push + Gmail incremental sync) into a platform-owned store. Apps read and mutate mail through the engine — never talk to a provider directly. All mutations write through to the real mailbox (Gmail labels / IMAP flags/MOVE), then emit a bus event. Per-app **annotations** let each app attach its own structured data (e.g. AI classification) to any email.

- `email.list({ account?, folder?, unread?, starred?, threadId?, search?, similarSearch?, similarTo?, nearEnough?, since?, hasAnnotation?, annotationsFrom?, includeDeleted?, limit?, offset?, inlineImageBase? })` — query emails. Returns `{ emails, total, mode? }`. Each email: `{ id, account, threadId, messageId, subject, from, to, cc, snippet, date, isUnread, isStarred, folder, hasAttachments, labelIds, annotations }`. `annotations` is the **caller's own**, keyed by kind: `{ classification: {...}, ... }`; `annotationsFrom: ['horst', 'platform']` adds the named writers' kinds on the same read (own kinds win on a collision) — on keyword, semantic and single-message reads alike.
  - `search` — keyword search (FULLTEXT over subject/body/sender/recipient/cc) plus Gmail-style operators (`from:` `to:` `subject:` `in:` `is:` `has:` `before:` `after:` `tag:` …) resolved in SQL — see "Search operators" below.
  - `similarSearch: true` — **semantic search**: with `search` text the query is embedded; with `similarTo: { account, uid }` the referenced email's stored vector is used ("more like this"). Results are hybrid (vector + keyword, rank-fused) with a `score` per row; `nearEnough` (cosine distance cutoff, default 0.6) filters unrelated neighbors. Falls back to keyword-only (`mode: 'keyword'`) when vectors are unavailable.
  - `hasAnnotation: { kind: 'classification', exists: false }` — work-queue filter: emails the calling app has **not** yet annotated with that kind. `hasAnnotation: false` = no annotation of any kind by the caller.
- `email.get({ account, uid, annotationsFrom?, inlineImageBase? })` — full email incl. `body`, `htmlBody`, `headers`, `attachments` metadata, and all the caller's annotation kinds (plus the named writers' with `annotationsFrom`, as on `email.list`).
  - **Inline images**: `attachments[]` carries `attachments[].contentId` (the part's Content-ID, angle brackets stripped) and `attachments[].inline: true` for the body's own embedded images, and the optional `inlineImageBase` rewrites matching `cid:` srcs in `htmlBody` to your own attachment route. Full spec under *Inline images (`cid:`)* below — read it before rendering mail.
- `email.modify({ account, uid, addFlags?, removeFlags?, move?, delete?, restore? })` — canonical mutation, write-through then `email:updated` event. Flags: `'UNREAD'`, `'STARRED'`. `delete: true` = trash (soft); `delete: { permanent: true }` = permanent + tombstoned (never resurrects). Sugar verbs (same write-through): `email.markRead({ account, uid, unread? })`, `email.star({ account, uid, starred? })`, `email.move({ account, uid, folder })`, `email.delete({ account, uid, permanent? })`.
- **Batch delete (optimistic)**: `email.delete({ account, uids: [...], permanent? })` accepts an **array** of uids. It returns **immediately** (`{ ok, count, queued }`) after pre-flagging those emails deleted locally — they vanish from every app at once (incl. `email.list`/`email.get`) — and the platform writes the deletion through to the real mail server **in the background** (auto-retry; deleting an already-gone message is a no-op, not an error). Prefer this over looping `email.delete` per uid. Deleted mail is hidden from **all** apps, not just the deleter.
- `email.send({ account, to, cc?, bcc?, subject, body, htmlBody?, inReplyTo?, references?, threadId?, attachments? })` — send via Gmail API or SMTP by account type (SMTP sends are auto-APPENDed to the Sent folder). Threading: pass `threadId` (Gmail) or `inReplyTo`/`references` (SMTP). Emits `email:sent`.
  `attachments[]` takes either **bytes** — `{ filename, contentType?, base64Data }` — or a **reference to an
  attachment already in the store** — `{ attachmentId, uid, account?, filename?, mimeType? }` — which the
  platform fetches at send time. Forward with the reference form: it keeps megabytes of base64 out of the
  proposal payload, and a reference that cannot be fetched refuses the send instead of quietly mailing a
  forward with nothing attached.
- `email.draftReply({ account, uid, instruction?, action?, currentDraft?, model? })` — **the platform's reply
  drafter**. Returns `{ text }`: the reply body only, with the subject, the quoted trail, the threading
  headers and the signature left for `email.send`/compose to stitch on. The parent message is read from the
  store (you name it, you do not supply it), the owner's standing directives and what the platform knows
  about the correspondent are injected, and a draft that echoes the original is rejected rather than
  returned. `action` is `reply` | `reply-all` | `forward`. **Do not write your own drafting prompt** — a
  second one would not carry any of that.
- `email.sent({ account?, threadId?, inReplyTo?, to?, subject?, since?, limit?, includeBody? })` — **outbound mail**, queryable the instant a send succeeds. Returns `{ sent, total }`; each item: `{ account, messageId, threadId, inReplyTo, uid, to, cc, bcc, subject, snippet, sentAt, hasAttachments, origin, via }`. Pass `includeBody: true` to get the **full sent text** as an extra `body` field on each item — that is what the platform actually sent (up to 60k chars), not the 200-char `snippet`, and it needs no second provider read; it is null on a `via:'folder'` item (headers only — fetch those with `email.get({ account, uid })`). `includeBody` defaults to false, so a plain "has this been answered?" call stays header-sized. Two sources, deduped by `messageId`: the platform **send log** (`via:'log'`, every send made through the platform, with `origin: { source, app, proposalId }` provenance) and the **synced Sent folder** (`via:'folder'`, catches mail sent by hand from Gmail/phone/another client). `threadId`/`inReplyTo`/`subject` are OR-matched as "which conversation", AND-ed with `account`/`to`/`since`. Use this before sending a reply to check the thread has not already been answered — `email.list({ folder: 'Sent' })` alone lags a sync cycle behind and has no provenance.
- `email.repliedTo({ account, messageIds })` — **which of these messages have been answered**: `{ messageId: sentAtISO }`, only for those that have (up to 500 ids per call). Matched on the send log's `in_reply_to`, so answering the newest mail of a thread does not mark an older one answered. This is the read behind a "you replied to this" badge — render it from here rather than recording your own sends, which misses every reply made from Horst, Telegram or another client.
- `email.attachment({ account, uid, attachmentId })` — fetch an attachment (cached). Returns `{ filename, mimeType, size, data }` (base64).
- `email.createFolder({ account, name })` — create an IMAP mailbox (no-op for Gmail).
- `email.annotate({ account, uid, kind?, data })` — upsert the calling app's annotation under `kind` (default `'default'`). Convention: `data` carries `{ v: 1, ... }`. Last-write-wins per kind; use separate kinds for independent writers (e.g. `'classification'` vs `'attachment_insights'`). Emits `email:annotated`.
- `email.annotations({ account, uid, kinds?, scope? })` — read annotations. `scope: 'mine'` (default) = own only; `scope: 'all'` = read every app's (write stays own-only).
  - The platform's own `email-intel` (appName `horst`, `kinds: ['email-intel']`, needs `scope: 'all'`) is the read behind "what did the classifier make of this mail" — shape under *Consuming platform email intelligence*. Each entry of its `calendarEvents[]` is `{ title, date, endDate, startTime, endTime, allDay, location, description, notes }`. **`endDate`** (`YYYY-MM-DD`, the last day **inclusive**) is how a multi-day event — a stay, a festival, a conference — states its range; it is `null` for single-day events and absent from every annotation written before the field existed, so read it as `endDate || date` and a one-day event keeps rendering exactly as it does today. Do not re-derive a range out of `description`/`notes` prose: if `endDate` is null the event really is one day.
- `email.syncStatus({ account? })` — engine status: `{ ready, vector, accounts: [{ account, type, status, enabled, lastSyncAt, lastError, backfillTotal, backfillDone }] }`. `vector: true` means semantic search is live.
- `email.syncNow({ account })` — trigger an immediate sync.
- `email.subscribe({ events: ['email:new', ...] })` — subscribe this app's iframe to engine events (then `Bridge.on('email:new', handler)`).

<!-- API:DETAIL key=email-search -->
#### Search operators (`email.list({ search })`)

Operators are resolved in SQL (not post-filtered): `from:` `to:` `cc:` `participant:`/`with:` `subject:`
`account:`/`acct:` `in:`/`folder:` `is:unread|read|starred` `has:attachment` `before:` `after:`
`any:` `tag:` `-tag:` (a tag id or name from `email.labels.list()`, read off the engine's `tags`
document — a tag nobody has matches nothing). Values may be quoted (`subject:"ferry booking"`); `to:` matches cc too; folder names are
aliased (`junk`=`spam`, `bin`/`deleted`=`trash`) across provider spellings; an unknown `key:` is
left as free text. Whatever is not an operator goes to FULLTEXT (and, with `similarSearch`, to
the embedding) — so `from:anna ferry booking` means "about a ferry booking, from Anna".
The response carries `query: { freeText, hasOps }` — how the string was read, so a surface that
wants the leftover free text (to search a second corpus with it, or to draw operator chips) does
not parse the query a second time.
<!-- /API:DETAIL -->

**Events** (every engine write emits; `origin: { source: 'sync'|'bridge', appName? }` lets you skip self-echo):
- `email:new { account, messages: [{ uid, subject, sender, snippet, date, folder }], origin }`
- `email:updated { account, uid, changes: { isUnread?, isStarred?, folder?, isDeleted? }, origin }`
- `email:sent { account, uid?, to, subject, origin }`
- `email:annotated { account, uid, appName, kind }` — fetch the data via `email.annotations`
- `email:backfill-progress` / `email:sync:status { account, state, lastSyncAt, error? }`

```js
// Semantic search from an iframe
const { emails } = await Bridge.call('email.list', { search: 'invoice from the accountant', similarSearch: true, limit: 20 });

// Classifier work queue + annotation write (routes.js)
const { emails } = await ctx.email.list({ hasAnnotation: { kind: 'classification', exists: false }, limit: 50 });
for (const e of emails) {
  const data = { v: 1, category: '...', priority: 3 };
  await ctx.email.annotate({ account: e.account, uid: e.id, kind: 'classification', data });
}

// React to new mail server-side (routes.js); returns an unsubscribe fn
ctx.email.on('email:new', ({ account, messages, origin }) => { /* ... */ });
```

<!-- API:DETAIL key=email-inline-images -->
#### Inline images (`cid:`)

Mail that embeds its own graphics — transactional mail from shops, most newsletters, anything composed in Outlook — writes them as `<img src="cid:logo">`, a reference to one of the message's own MIME parts. A browser cannot resolve that, so an unhandled `cid:` src renders as the image's `alt` text. The platform gives you the mapping and, optionally, does the rewrite for you.

**On every read that returns `attachments[]`** (`email.list`, `email.get`), each entry is `{ id, filename, mimeType, size }` plus, for a part that declared one:

- `attachments[].contentId` — the part's **Content-ID with the angle brackets stripped**: a header `Content-ID: <logo@shop>` is returned as `logo@shop`.
- `attachments[].inline` — `true` when the part declared `Content-Disposition: inline` or carries a Content-ID.

Both are **absent** when the part has neither, so an ordinary attachment looks exactly as it always did. Filter `inline` parts out of your attachment chip list: they are the body's own images, not files the user attached.

**`inlineImageBase`** (optional, on both reads) is the URL prefix **your** app serves attachment bytes from. Given one, every `cid:` src in the sanitized `htmlBody` whose reference matches a `contentId` on **this** message becomes `<inlineImageBase><attachment id>`, and the row reports `htmlInlineImages` (rewritten) and `htmlInlineImagesUnresolved` (left alone) — each present only when non-zero. Omit it and the read is byte-for-byte what it is today, so this is opt-in per read.

```js
const msg = await ctx.email.get({
  account, uid,
  inlineImageBase: `/apps/my-app/api/mail/${encodeURIComponent(account)}/${uid}/attachment/`,
});
// msg.htmlBody → <img src="/apps/my-app/api/mail/…/attachment/3" alt="logo">
// msg.htmlInlineImages → 5
// msg.attachments → [{ id: '3', contentId: 'logo', inline: true, filename: 'logo.png', ... }]
const files = (msg.attachments || []).filter((a) => !a.inline);   // real attachments only
```

Serve that route from `email.attachment({ account, uid, attachmentId })` — the id in the rewritten URL is exactly its `attachmentId`.

**Rules the platform keeps**, so you do not have to:

- The URL is built from the **attachment id**, never from the `cid` string — a crafted `cid:../../secret` cannot shape a path. It either matches a known Content-ID or matches nothing.
- An unmatched reference is left **untouched** (today's behaviour), never guessed at, and never throws.
- `inlineImageBase` must be an absolute path (`/apps/…/`) or an `http(s)://` URL. Anything else is refused by the engine.
- Matching tolerates the spellings real mail uses: percent-encoding, angle brackets, and a case mismatch.

**Content-IDs are captured at sync time.** Mail that was already in the store before this shipped carries no `contentId` until it is re-synced: its `cid:` srcs stay unresolved and the image still shows its alt text. `htmlInlineImagesUnresolved` is how you tell the user why — do not present it as an error.
<!-- /API:DETAIL -->

<!-- API:DETAIL key=email-senders -->
### Sender rules (engine-level junk filter)
"Mail from these senders is junk" is engine config, enforced at sync time —
rule-matched arrivals are moved to Trash (server-side) BEFORE `email:new`
fires, so no consumer ever sees them. Apps render/edit the one store; never
build your own arrival-trashing:
```js
ctx.email.rules.list();                                // [{id, type:'sender'|'domain', value, hitCount, lastMatchedAt}]
ctx.email.rules.add({ type: 'domain', value: 'spammy.com' });
ctx.email.rules.remove(ruleId);
await ctx.email.rules.apply();                         // backlog sweep (INBOX+Spam → Trash)
ctx.email.matchesSenderRules(from);                    // read-only check
ctx.email.matchSenderRule(from);                       // the matching rule (or null) — for provenance display
```
Render `hitCount`/`lastMatchedAt` in your rules editor so the user can prune
dead rules. Every rule-trashing also writes a `rule-match` annotation (writer
`platform`: `{ruleId, type, value, at}`) — show it on Trash rows so "why did
this mail vanish" always has an answer. Repeated AI spam verdicts generate
`email.rule.add` governance proposals (Horst proposes, the user decides, the
engine enforces) — render them in your approvals view like any other kind.
<!-- /API:DETAIL -->

<!-- API:DETAIL key=email-labels -->
### Labels (shared tag vocabulary) and tags (who carries which)
"These are my tags" is engine config too — ONE vocabulary the platform
classifier and every app work from. The classifier only ever assigns tags
from this list, so renaming/adding here changes what future mail is tagged
with. Apps render/edit the one store; never keep a private list:
```js
ctx.email.labels.list();                               // [{id, name, color, endDate?, createdAt}]
ctx.email.labels.add({ name: 'Travel', color: '#3b82f6' });
ctx.email.labels.update(id, { name: 'Trips' });        // renames the classifier vocabulary too
ctx.email.labels.remove(id);
```
(Bridge: `email.labels.list/add/update/remove`.)

Which tags sit on which message is engine-owned as well — one `tags`
annotation per mail (writer `platform`), the same document for the
classifier, every app and Horst's chat, so a mail has one answer everywhere:
```js
ctx.email.tags.of(account, uid);                        // [{ id, source: 'ai'|'rule'|'user' }]
ctx.email.tags.set(account, uid, { add: [id], remove: [id] });   // the owner's decision
ctx.email.tags.assign(account, uid, [id, id]);          // your deterministic tagging (source 'rule')
```
(Bridge: `email.tags.of/set/assign` with `{ account, uid, … }`.) A user
removal is a tombstone: the classifier and `assign` can never bring that tag
back, and re-adding by hand lifts it. An automatic write replaces only its own
source's entries — the classifier's next pass drops an `ai` tag it no longer
believes in and touches nothing the owner or your rules decided. The document
rides along as `annotations.tags` on any read with `annotationsFrom:
['platform']`, and `search: 'tag:<id or name>'` filters by it (see `email.list`).
Removing a label leaves its id on the mails that carried it; render against
`labels.list()` and an orphan simply has no name.
<!-- /API:DETAIL -->

<!-- API:DETAIL key=email-intel -->
### Consuming platform email intelligence
The platform classifies every INBOX arrival ONCE (Horst) and writes an
`email-intel` annotation (appName `horst`): `{ v:4, category, labels[],
importance 1-5, priority, spamScore, spamVerdict, needsReply, summary,
suggestedReply, calendarEvents[], attachments:{insights, briefingNote},
status?, error? }`. `labels[]` are the classifier's names; the same pass
writes them as the message's `ai` tags (`email.tags.of`, `tag:` search) before
this annotation lands, so read tags from there, not from `labels[]`.
`category` is Horst's private triage class — not a tag, do not render it.
Each `calendarEvents[]` entry is `{ title, date, endDate, startTime, endTime,
allDay, location, description, notes }`. `endDate` is the last day of a
multi-day event, **inclusive** (`YYYY-MM-DD`), and is `null` for a single-day
one — so span an event from `endDate || date` and nothing changes for the
single-day case. The same field rides the `calendar.create` proposal payload
these events are staged as (`ctx.governance.list`), where the calendar engine
turns it into a real multi-day event. It is absent on annotations and
proposals written before the field existed; that absence means "one day", not
"unknown", and a range mentioned only in `description`/`notes` prose is
context, never something to parse a date out of.
`spamVerdict` (`'clean'|'suspect'|'spam'`) is THE spam judgment — render it;
never re-compare `spamScore` against your own threshold (the thresholds are
user-editable Horst settings). v2 annotations lack the verdict; fall back to
`spamScore >= 60 || category === 'spam'` for those rows only. Do NOT classify
mail yourself — consume it:
```js
ctx.email.on('email:annotated', async ({ account, uid, appName, kind }) => {
  if (appName !== 'horst' || kind !== 'email-intel') return;
  const rows = await ctx.email.annotations({ account, uid, kinds: ['email-intel'], scope: 'all' });
  /* render rows[0].data */
});
// Catch-up after downtime (watermark on updatedAt):
const rows = await ctx.email.listAnnotations({ appName: 'horst', kind: 'email-intel', since });
// User-clicked deep re-run (full body + forced attachment read):
const intel = await ctx.email.reclassify({ account, uid });
```
`status` is the classification's state, and it is the reason you do not need a
table of your own beside the annotation: absent means the verdict stands,
`'pending'` means a deep re-run is in flight right now (render "looking
again…" — the previous verdict is still underneath it, and this survives a GUI
reload because it lives on the server), and `'failed'` means it was tried and
gave up, with `error` saying why. A failed row still carries a renderable
fallback verdict; show the failure rather than presenting the fallback as a
judgment the platform made.
<!-- /API:DETAIL -->
<!-- /API:SECTION -->

<!-- API:SECTION key=calendar -->
### Calendar Engine (Platform Google Calendar Store)

Synced Google Calendar events, always fresh (incremental sync every few minutes + immediately after writes). Events come back with **resolved colors** (`backgroundColor`) and human-friendly `when`/`whenEnd` labels — never resolve Google color IDs or format event times yourself.

- `calendar.events({ account?, calendarIds?, timeMin?, timeMax?, q?, similarSearch?, similarTo?, nearEnough?, includeCancelled?, limit? })` — list/search events. Returns `{ events, total, mode? }`. Same hybrid semantic search semantics as `email.list` (`similarTo: { account, eventId }`). Each event is Google-event-shaped plus `backgroundColor`, `when`, `whenEnd`, `annotations` (caller's own, by kind).
- `calendar.get({ account, eventId })` — single event + all the caller's annotation kinds.
- `calendar.create({ account, calendarId?, summary, description?, location?, date?, startTime?, endTime?, allDay?, attendees?, colorId?, reminders?, event? })` — create (write-through to Google, then `calendar:changed`). Timezone is resolved engine-side. Pass a raw Google event body via `event` for full control.
- `calendar.update({ account, eventId, calendarId?, ...fields, patch? })` / `calendar.delete({ account, eventId, calendarId? })` — write-through, then event.
- `calendar.listCalendars({ account })` — `[{ id, name, color, primary, selected }]`.
- `calendar.selectCalendars({ account, calendarIds })` — choose which calendars sync.
- `calendar.defaultCalendarId({ account })` / `calendar.setDefaultCalendar({ account, calendarId })` — the calendar a `create` lands in when `calendarId` is omitted.
- `calendar.colors({ account })` — the Google color palette (event + calendar colors).
- `calendar.annotate` / `calendar.annotations` — per-app annotations, same semantics as email.
- `calendar.syncStatus({ account? })` / `calendar.syncNow({ account })`
- `calendar.subscribe({ events: ['calendar:changed'] })` — then `Bridge.on('calendar:changed', handler)`.

**Events:** `calendar:changed { account, calendarId, eventIds, action: 'sync'|'create'|'update'|'delete', origin }`, `calendar:annotated { account, eventId, appName, kind }`.

From routes.js: `ctx.calendar.*` (same shapes), plus `ctx.calendar.formatWhen(iso, tz)` for consistent date labels and `ctx.calendar.on(event, handler)` for backend event handlers.

<!-- /API:SECTION -->
<!-- API:SECTION key=todos -->
### Todos Engine

The platform's store for **user** todos and reminders — life data, shared across apps and with Horst. Never create an app-local todo/reminder table. This is not `ctx.jobs` (your app's own background work) and not Horst's work stack; those are machine tasks, these are things a person means to do.

- `todos.list({ status?, watchOnly?, dueBy?, limit?, offset? })` — `status` defaults to `'open'`; pass `'all'` for everything. Ordered by due/snooze date ascending, undated last. `limit` 1–500 (default 100).
- `todos.get({ id })` · `todos.update({ id, ...fields })` · `todos.delete({ id })`
- `todos.create({ title, notes?, dueAt?, recurrence?, scope?, watch? })` — `title` is required (≤500 chars). `recurrence` is `{ every: 'day'|'week'|'month'|'year', n: 1-365 }`. `source` is stamped server-side, so an app cannot attribute a todo to another app.
- `todos.complete({ id, resolution? })` — returns `{ todo, rearmed }`; `rearmed` is the next occurrence when the todo recurs, otherwise `null`. Completing an already-done todo is a no-op.
- `todos.snooze({ id, until })` or `({ id, preset })` with preset `1h` | `1d` | `1w`. Open todos only.
- `todos.reopen({ id })` · `todos.counts()` → `{ open, dueNow, waiting, … }` for a badge.
- `todos.similar({ title, limit? })` — **check before you create.** Semantic match against open todos (returns each with its cosine `dist`, closest first, empty when nothing is genuinely close). This is how you avoid filing a fourth "call the dentist".
- `todos.subscribe({ events: ['todo:changed'] })` — then `Bridge.on('todo:changed', handler)`.

**Scope:** `shared` (default — any app and Horst can see it) or `private` (only the creating app). Choose `private` only when the todo is meaningless outside your app; the point of a platform store is that a reminder made in one surface shows up in the others.

**Watches:** `watch: { type: 'reply', account, uid }` ties a todo to an email and resolves it when a reply arrives — for "waiting on an answer" items. The referenced mail must exist.

**Todo shape:** `{ id, title, notes, status, dueAt, snoozedUntil, recurrence, recurOf, watch, appOrigin, scope, source, resolution, completedAt, createdAt, updatedAt }`.

**Events:** `todo:changed { id, action, todo }` where `action` is `create`/`update`/`complete`/`snooze`/`reopen`/`delete`.

From routes.js: `ctx.todos.*` — same operations, but **positional** rather than a params object: `ctx.todos.get(id)`, `ctx.todos.update(id, fields)`, `ctx.todos.complete(id, resolution)`, `ctx.todos.snooze(id, params)`, `ctx.todos.similar(title, params)`, plus `ctx.todos.on(event, handler)`.

<!-- /API:SECTION -->
<!-- API:SECTION key=browser -->
### Headless Render (`browser.screenshot`)

Render an HTML document — **plus your app's own on-disk assets** — to a PNG. Use this to turn a
rich/interactive view (charts, an SVG/Canvas composition, a WebGL/three.js scene) into a static
image you can send over Telegram, email, etc.

**It is hermetic: there is no network.** The renderer serves the inline `html` you pass, and any
**relative** asset it references (`./app/core.js`, `./assets/model.glb`, `./style.css`) straight
from your app directory (the same sandbox as `fs.*` — paths can't escape it). **Every other
request is aborted** — other origins, absolute URLs, CDNs, `../` escapes. So:

- **Bundle what you need locally.** Vendor any library into your app dir and import it by relative
  path; a `<script src="https://cdn…">` will simply fail to load. There is **no `{url}` mode** —
  you never point it at a server, and you should **not** stand up an HTTP route or token to feed
  it. Build the HTML in-process and reference local files. Data you inline into the HTML never
  leaves the process.
- **Signal when you're done drawing.** Async content (image `onload`, a `fetch`, a WebGL frame)
  isn't ready at page load, so the capture waits for a readiness signal: set
  `window.__shotReady = true` once your view has rendered (or pass a custom `waitForFunction`
  predicate). Without it the call times out.
- **WebGL / three.js / Canvas works** — out of the box, with no GPU and no display. The renderer
  runs Chromium with software WebGL (ANGLE + SwiftShader), so `canvas.getContext('webgl')`
  succeeds and three.js scenes render normally. You don't pass any flags — it's the platform
  default. Two rules for WebGL specifically: (1) load all assets (the three.js bundle, loaders,
  `.glb`/textures) by **relative path** from your app dir, never a CDN; (2) signal readiness
  **after the scene has actually painted a frame**, not just after the model finishes loading —
  set `window.__shotReady = true` inside a `requestAnimationFrame` callback (or after your first
  `renderer.render(...)`) so the capture sees the drawn frame. Software rendering is slower than a
  GPU: a heavy scene may need a higher `timeoutMs` (default 15000 ms).

Frontend (iframe): `Bridge.call('browser.screenshot', { html, width?, height?,
deviceScaleFactor?, fullPage?, waitForFunction?, timeoutMs? })` → `{ image: <base64 PNG>,
mimeType: 'image/png' }`.

routes.js: `await ctx.browser.screenshot({ html, ... })` → returns a **PNG `Buffer`** (pass it
straight to `ctx.telegram.sendPhoto({ chatId, photo: buf })`). Defaults: `width` 1200, `height`
630, `deviceScaleFactor` 2.

```js
// routes.js — render a local view and Telegram it, no temp file, no route.
const html = `<!doctype html><meta charset="utf-8">
  <link rel="stylesheet" href="./card.css">
  <div id="card">…</div>
  <script type="module">
    import { draw } from './card.js';   // served from your app dir
    await draw(${JSON.stringify(data)});
    window.__shotReady = true;          // tell the renderer we're done
  </script>`;
const png = await ctx.browser.screenshot({ html, width: 1200, height: 630 });
await ctx.telegram.sendPhoto({ chatId, photo: png, caption: 'Your report' });
```

Advertise the `browser` capability when you use it (see Capabilities). Built on a bundled headless
Chromium, so it works on a server with no display and no system Chrome.

<!-- /API:SECTION -->
<!-- API:SECTION key=telegram -->
### Telegram (Per-App Bot)

> **Opt-in only.** Wire Telegram into an app **only when the user explicitly asks for it**
> (e.g. "send me Telegram alerts", "control this from Telegram", "make this a Telegram bot").
> Never add Telegram on your own initiative. Each app has its **own** bot — the user pastes
> a bot token (from @BotFather) under **Apps → Setup → Telegram** and binds it to this app.
> If `ctx.telegram.configured()` / `Bridge.call('telegram.status')` reports `configured: false`,
> tell the user to add a bot token in Setup; do not hardcode tokens.

This is the **only channel that reaches the user when the dashboard browser tab is closed** —
prefer it over `toast.show` for real notifications (alerts, reminders, job results).

Frontend (iframe) methods:
- `telegram.status()` — `{ configured, botUsername, botId, mode, webAppEnabled }` for this app's bot.
- `telegram.send({ chatId, text, options? })` — send a message. `options` are raw Bot API
  `sendMessage` fields (`parse_mode`, `reply_markup`, etc.). Returns the Telegram API response.
- `telegram.sendPhoto({ chatId, photo, caption?, options? })` — send a photo. `photo` may be a
  base64 string / `data:` URI (uploaded to Telegram as multipart) **or** an http(s) URL / an
  existing `file_id` (sent by reference). `caption` + `options` are raw Bot API `sendPhoto`
  fields (`parse_mode`, etc.). This is how you send a **freshly-rendered image** — e.g. the PNG
  from `browser.screenshot` (see Headless Render) — with no temp files and no public route.
- `telegram.sendDocument({ chatId, document, filename?, contentType?, caption?, options? })` — send a
  file. `document` may be a base64 string (uploaded as multipart — pass `filename`, it is the only
  part of a document a recipient sees before opening it) **or** an http(s) URL / an existing
  `file_id` (sent by reference).
- `telegram.call({ method, params? })` — call any Bot API method (`editMessageText`,
  `answerCallbackQuery`, …) for this app's bot. Note: `call` sends JSON, so it can only reference
  a photo by URL/`file_id`; to **upload** image bytes use `sendPhoto`.

Inbound messages arrive via `Bridge.on('telegram:update', (update) => { ... })` — `update` is the
raw Telegram Update object (`update.message`, `update.callback_query`, etc.). The user must
message the bot first; capture `update.message.chat.id` to know where to reply.

```js
// app.js — echo bot
Bridge.on('telegram:update', async (u) => {
  const chatId = u.message?.chat?.id;
  if (chatId) await Bridge.call('telegram.send', { chatId, text: 'You said: ' + u.message.text });
});
```

From routes.js use `ctx.telegram.*` — `onUpdate` registers a backend handler
instead of the frontend event:
```js
ctx.telegram.onUpdate(async (u) => {
  const chatId = u.message?.chat?.id;
  if (chatId) await ctx.telegram.send(chatId, 'Hello from the server');
});
```

The platform handles delivery automatically: long-polling when no public URL is set, or a
webhook when the user has configured a public URL in Setup. Apps never manage this.

On a custom domain the entry surface's redirects stay on that host — `customDomainRootRedirect`,
`noLoginLoopOnCustomHost` — and `entryUrl({ customDomain: true })` names the domain's entry page
(see Mini-apps below).

<!-- API:DETAIL key=telegram-miniapp -->
#### Mini-apps and app users: the `app` entry surface — read before building one

> **A Telegram (or WhatsApp-linked, or email) user surface is a SEPARATE AUTH BOUNDARY, not a
> skin on the dashboard.** Telegram opens mini-apps in a webview that has **no VistaClair
> session cookie**, and a browser visitor arriving via a custom domain has none either. Every
> cookie-gated resource (`index.html`, `app.js`, `style.css`, the `/pro/*` runtime + theme,
> `/api/*`, and the dashboard WebSocket) is **unreachable** there — the platform redirects each
> request to `/login`. This is the single most common way an app "works in the dashboard but is
> broken in Telegram / on the website."

**The access level decides what is cookieless, and it is derived from ONE thing: the `auth`
block.** Declaring a login channel (`"auth": { "telegram": true }`, `whatsapp`, `email`) makes
the app **Users**-level and gives it the fixed `app` entry surface. Nothing else needs
declaring — no `surfaces.user.entry`, no `telegram.html` convention.

**1. The cookieless paths of a Users-level app (the ONLY app paths reachable without the owner cookie):**
- `/apps/<name>/` — the app root: anonymous visitors are 302'd to `app.html` (owners get `index.html`)
- `/apps/<name>/login` — never served to anonymous visitors: they are 302'd to `app.html` too (see *Custom domain* below)
- `app.html` — the entry page (Telegram mini-app AND browser users; branch on `Telegram.WebApp.initData`)
- `app.css` — its styles (inline the theme tokens; you cannot load `/pro/app-theme.css`)
- `app/**` — every asset of the cookieless bundle, any depth, any type (`app/boot.js`, `app/core.js`, `app/model.glb`, …)
- `/api/app/*` — its data endpoints, **behind the platform's default-deny guard** (a signed-in user is required)
- `/api/app/pub/*` — the anonymous convention: guard-exempt by design, for pre-login and token-authenticated routes (share links, invite QR, login handshakes, files Telegram's servers fetch). **Every route here self-gates by its own token or is genuinely public.**

Anything else (`index.html`, `app.js`, `style.css`, `/pro/*`, `/api/*` outside `/api/app/`, the
WebSocket) redirects to `/login` for a cookieless visitor (on a custom domain that chain ends at
`app.html`, see below). The entry bundle loads **no `/pro/*`
runtime or theme** and has **no `Bridge`** — external CDNs (Telegram SDK, D3) load normally.
Keep `public/app.js` for the OWNER dashboard — it is not part of the entry surface.

**2. The bot's WebApp button points at the entry page: `ctx.telegram.entryUrl()`** (returns
`…/apps/<name>/app.html`, or `null` until a public HTTPS URL is configured in Setup — Telegram
rejects `web_app` buttons on non-HTTPS). Never build the URL by hand and never emit a dead link:
```js
const url = ctx.telegram.entryUrl();
await ctx.telegram.call('setChatMenuButton',
  url ? { menu_button: { type: 'web_app', text: '📊 Open app', web_app: { url } } }
      : { menu_button: { type: 'default' } });
```
Inline `web_app` buttons take the same URL (with `?startapp=…` for deep links).
`ctx.telegram.entryUrl({ customDomain: true })` / `webAppUrl({ customDomain: true })` return the
owner's recorded custom domain instead (`https://<domain>/app.html` / `https://<domain>/`), and the
platform URL when none is recorded. Use it for links you show people (a report, a PDF, a share
text); keep the no-argument form for the bot's `web_app` button.

`websiteDomainField` — where that domain comes from: the owner's **Configure → Website domain**
field (one hostname, validated; empty = none; Users and Open apps only). Setting it never moves
the mini-app — no-argument `entryUrl()` / `webAppUrl()` stay on `/apps/<name>/`. Under the field:
- `slaveAware` — the value is per host: on a slave it is the slave's own, kept across publishes,
  and `{ customDomain: true }` there returns it; the master's modal lists each slave's value.
- `nginxSnippet` — the owner runs the reverse proxy; the field shows the block for its host
  (`/` → `/apps/<name>/`, `Host` / `X-Forwarded-Host` / `X-Forwarded-Proto`,
  `proxy_buffering off` for SSE).
- `domainCheck` — a server-side Check: resolves the domain, follows `/` once, reports ok / not
  pointing here / redirect loop.
An app reads the result only through `{ customDomain: true }` — never ask the owner for the
domain, never store it yourself.

**Custom domain.** When the owner maps a domain onto the app (nginx `location /` →
`/apps/<name>/`), the platform's redirects stay inside the app on that host — no app code involved:
- `customDomainRootRedirect` — the anonymous root 302 is relative (`Location: app.html`), so
  `https://<domain>/` lands on `https://<domain>/app.html` and `/apps/<name>/` on
  `/apps/<name>/app.html`. A declared `surfaces.public.landing` wins, as on the main host.
- `noLoginLoopOnCustomHost` — a cookieless request for an owner-only path is sent to `/login`,
  which on the domain is the app's own `/apps/<name>/login`; the platform answers it with a 302 to
  the entry page, so `/index.html` → `/login` → `/app.html` terminates. The dashboard `/login` on
  the main host is unchanged. A `public.pages` glob that matches `login` hands the path to the app.
Keep every URL inside the entry bundle relative (`app/main.js`, `api/app/…`) — absolute
`/apps/<name>/…` paths do not exist on the domain.

**3. Cookieless identity — use `ctx.identity`, do NOT hand-roll HMAC or session tokens.** The
platform owns this: **`ctx.identity.resolve(req)`** validates the Telegram `initData` header (or
`?initData=`) against this app's bot token and returns `{ userId, via:'telegram', user }`, or
verifies a session Bearer and returns `{ userId, via:'session', channel }`, or `null`.
**`ctx.identity.require`** is drop-in Express middleware that 401s on failure and sets
`req.appUser = { id, via, telegram }`:
```js
router.get('/api/app/me', ctx.identity.require, (req, res) => {
  res.json({ id: req.appUser.id });   // id === the Telegram user id (verified)
});
```
**Sessions carry their channel.** When you mint a browser session for a Telegram-identified user
(link code, web sign-in), tag it: `ctx.identity.issueSession(tgUserId, { via: 'telegram' })`
(`via: 'whatsapp'` for WhatsApp users). The platform's default-deny guard on `/api/*` maps a
tagged session to the right account by that channel; an **untagged** session's `userId` must be
an app-auth account id. There is no guessing between the two.

**4. Dual-mount every shared data endpoint** so one set of handlers serves both contexts. Identity
is the SAME call on both prefixes:
```js
function mount(method, sub, handler, { pub = false } = {}) {
  const guard = (base) => async (req, res) => {
    const r = ctx.identity.resolve(req);            // session (dashboard/browser) OR initData (Telegram)
    if (!r) return res.status(401).json({ error: 'unauthorized' });
    req.base = base;                                // so handlers can build api vs api/app URLs
    try { await handler(req, res, r); } catch (e) { res.status(500).json({ error: e.message }); }
  };
  router[method](`/api/${sub}`,     guard('api'));      // owner dashboard (cookie / Bearer)
  router[method](`/api/app/${sub}`, guard('api/app'));  // app users (initData / tagged session)
  if (pub) router[method](`/api/app/pub/${sub}`, (req, res) => handler(req, res, null)); // anonymous, self-gated by its token
}
mount('get', 'feed', async (req, res, r) => { /* one handler, both frontends; r.userId */ });
```
Routes fetched **without** any identity — a share link, an invite QR image, a PDF Telegram's
servers download, a `<img src>` the entry page renders, a login handshake — live under
`/api/app/pub/…` and validate their own token. Do not list them in `surfaces.public.api` (that
field is only for extra guard exemptions outside the `pub` convention).

**5. Realtime is part of the auth boundary too — the dashboard WebSocket (`ctx.broadcaster`) is
cookie-gated and unreachable in the entry surface.** Use the platform SSE helper **`ctx.sse`** on
the entry prefix — never hand-roll your own SSE client registry:
```js
// EventSource CANNOT set headers, so identity arrives as ?initData= or ?session= — ctx.identity.resolve reads both.
router.get('/api/app/events', (req, res) => {
  if (!ctx.identity.resolve(req)) return res.status(401).end();
  return ctx.sse.handler()(req, res);
});
function emit(event, data) {
  try { ctx.broadcaster.broadcast({ event, ...data }); } catch {}   // dashboard (WebSocket)
  ctx.sse.emit(event, data);                                        // entry surface (SSE); 3rd arg = channel
}
```
Client: `new EventSource('api/app/events?initData=…')` (or `?session=…`) with
`es.addEventListener('<event>', …)`, and **re-open on `visibilitychange`** — Telegram freezes
backgrounded webviews, killing the stream.

**6. Mic/camera on cookieless LAN pages needs a secure context — plan for it, don't fight it.**
`getUserMedia` (mic, camera) is blocked by browser policy on plain-HTTP LAN origins
(`http://<lan-ip>:port`); only HTTPS pages, `localhost`, and `127.0.0.1` count as secure
contexts. The platform intentionally serves plain HTTP (TLS termination is external — tunnel or
reverse proxy). If the entry surface needs the mic on the LAN: serve it through the user's
HTTPS tunnel (the public URL from Setup), or, when the page runs on a specific client machine
anyway, ship a tiny localhost reverse proxy on that machine so the page loads from
`http://localhost:<port>` (a secure context) — see roblox-buddy's buddy-link companion for the
pattern. Always feature-detect (`navigator.mediaDevices?.getUserMedia`) and degrade to typed
input with a clear message; never assume the mic exists.

**Architecture summary:** two thin bootstraps — `app.js` (owner dashboard) and `app/boot.js`
(entry surface: Telegram webview or browser user) — that both call one shared SPA (e.g.
`app/core.js` → `AppCore.mount(config)`), parameterized by `apiBase` (`api` vs `api/app`),
`authHeaders()` (`Authorization: Bearer <session>` vs `X-Telegram-Init-Data`), and `realtime`
(WebSocket in the dashboard, SSE in the entry surface). Design **pages, identity, AND realtime**
for the cookieless context up front. "Works in the dashboard" ≠ "works in Telegram" — verify the
mini-app inside Telegram, not just the dashboard view.

> **The legacy `telegram.html` shape is gone.** `telegram.html/.css/-app.js`, `tg/*.js` and
> `/api/tg/*` are no longer exempt for anyone: an app still shipping them has no cookieless
> surface at all and its mini-app opens `/login`. Migrate to the `app` entry surface above —
> rename to `app.html`, move `tg/*` to `app/*`, `/api/tg/` → `/api/app/`, anonymous routes →
> `/api/app/pub/`, and open the bot button with `ctx.telegram.entryUrl()`.
<!-- /API:DETAIL -->

<!-- API:DETAIL key=telegram-identity -->
#### Identity & linking across the two contexts — the canonical model

> **The Telegram user id IS the primary key.** One user row serves both contexts. Make your
> `users.id` column the Telegram user id (`BIGINT`), and both the dashboard and the mini-app
> resolve to that same row. There is no separate "dashboard account" — linking simply proves the
> dashboard browser belongs to a known Telegram user.

`ctx.identity` owns all three identity primitives so app code writes **zero** auth crypto:

- **Telegram context** — identity is the verified `initData` user. `ctx.identity.resolve(req)` (or
  the `ctx.identity.require` middleware) returns `{ userId, via:'telegram', user }`; `userId` is the
  Telegram id. Upsert your user row from `user` on first contact.
- **Dashboard context** — the browser has a VistaClair session but no per-user app identity. The
  user proves which Telegram user they are with a one-time **link code**, then the app hands back a
  **platform-signed session token** the frontend stores and replays as `Authorization: Bearer`.
  `ctx.identity.resolve(req)` verifies that token → `{ userId, via:'session' }`.

The full round-trip (bot issues → dashboard redeems → frontend stores → every request resolves):
```js
// 1. Bot side (lib/telegram.js) — user runs /link in the chat:
const code = ctx.identity.issueLinkCode(user.id);   // 6-digit, secure RNG, 10-min TTL, rate-limited
await ctx.telegram.send(chatId, `Your code (10 min): ${code}`);

// 2. Dashboard route (routes.js) — redeem the code, mint a session token:
router.post('/api/link', async (req, res) => {
  const redeemed = ctx.identity.redeemLinkCode(String(req.body.code || '').trim());
  if (!redeemed) return res.status(404).json({ error: 'invalid_or_expired' });
  const token = ctx.identity.issueSession(redeemed.userId);   // signed, stateless, survives restarts
  res.json({ ok: true, token });
});

// 3. Frontend (dashboard app.js) — store the token; replay it on every request:
//    onLinked: (r) => Identity.set(r.token)       // Identity is provided by /pro/app-runtime.js
//    authHeaders: () => { const t = Identity.token(); return t ? { Authorization: 'Bearer ' + t } : {}; }

// 4. Any protected route — one guard authenticates BOTH contexts:
router.get('/api/me', ctx.identity.require, (req, res) => res.json({ id: req.appUser.id }));
```
`window.Identity` (`set`/`token`/`clear`, app-scoped `localStorage`) ships in the `/pro/app-runtime.js`
runtime the dashboard page already loads; `apiFetch` auto-attaches the Bearer header when a token is
set. Link codes are in-memory + ephemeral (losing one on restart just means re-running `/link`); the
durable identity is always your own user row.

`ctx.identity` methods (all scoped to this app):
- `ctx.identity.resolve(req)` → `{ userId, via, user? }` or `null` (reads bearer + initData from `req`).
  A request carrying valid **platform-owner** credentials (the dashboard cookie — i.e. the admin
  browsing the app inside the dashboard) and no app credentials resolves as `{ userId: null,
  via:'owner' }`. Explicit app credentials always win, so the admin can still sign in as a test user.
- `ctx.identity.require` → Express middleware; 401s or sets `req.appUser = { id, via, telegram }`.
  (`via:'owner'` carries no userId, so it still 401s here — owner auto-login is account-level and
  lives in `ctx.auth`, below.)
- `ctx.identity.issueLinkCode(userId, { ttlMs? })` → 6-digit code; `redeemLinkCode(code)` → `{ userId }` or `null`.
- `ctx.identity.issueSession(userId, { ttlMs? })` → signed token; `verifySession(token)` → `{ userId }` or `null`.
- `ctx.identity.validateInitData(initData, { maxAgeS? })` → verified Telegram `user` or `null` (low-level; `resolve` calls it).
<!-- /API:DETAIL -->

<!-- API:DETAIL key=telegram-auth -->
#### Multi-user, email/password, and linking — the turnkey auth module

The Telegram-id-as-PK model above is the **single-track** default and is perfect for TG-only
apps. When an app needs **email/password accounts**, or **one account reachable by BOTH Telegram
and email**, do NOT hand-roll it. Add an `auth` block to `manifest.json` and the platform mounts a
hardened auth subsystem for you:

```json
{
  "name": "my-app",
  "auth": { "telegram": true, "email": true, "sender": "you@example.com" },
  "surfaces": { "public": { "api": ["/api/public-feed"] } }
}
```

At mount time the platform automatically:
- **provisions** an `accounts` table (one row = one human; `email` + `tg_user_id` are linkable
  credentials on the same row) and an `email_verifications` table, in the app's own DB;
- **mounts** `/api/auth/*` — `signup`, `verify`, `login`, `link` (redeem a TG `/link` code),
  `attach-email`, `me`, `logout`;
- installs a **default-deny guard**: every `/api/*` route except `/api/auth/*` and any declared
  `surfaces.public.api` prefix requires an authenticated account (so a forgotten guard fails
  CLOSED). Note a guard exemption does NOT lift the owner cookie — it only skips the account
  requirement for callers who already reached the route (see the `surfaces` manifest key under
  "Capabilities, access levels, and full-screen mode").

The session token from `/api/auth/login` (and `/api/auth/link`) carries an **opaque account id** —
NOT the Telegram id. Inside your own routes use `ctx.auth.require` (set by the module) to get
`req.account` + `req.appUser.id` (= account id). For TG-only apps that don't set `auth`, the
classic `users.id = Telegram id` model and `ctx.identity.*` stay exactly as documented above.

**Linking UX (both directions, one account):**
- *Email user adds Telegram*: signed-in via email → run `/link` in the bot → POST the code to
  `/api/auth/link` while holding the session → TG attaches to the **current** account.
- *Telegram user adds email*: authenticated by `initData` → POST `/api/auth/attach-email`
  `{email,password}` → sets email/password on the **same** account, sends a verification mail.
- Collisions return `409 already_linked`.

**Frontend**: include `/pro/app-auth.js` and call `VistaAuth.create({ mount, methods, onAuthed })`
— it renders the Telegram-code box + email login/signup tabs + an Account panel ("Link Telegram" /
"Add email & password"), stores the session token, and exposes `authedFetch`/`api`. Works on every
surface; the email tabs work even with no Bridge present.

**Sender email** (`auth.sender`) is configured by the owner in the app settings, Config tab (⚙ on
the app's row in the Apps table), chosen from registered email accounts. It is only needed when `auth.email` is on.

`ctx.auth` (present only when the `auth` flag is set):
- `ctx.auth.require` → Express middleware; 401 or set `req.account` + `req.appUser` (id = account id).
- `ctx.auth.findOrCreateTgAccount(tgUser)` → the account row for a verified Telegram user.
- `ctx.auth.accountById(id)` / `ctx.auth.publicAccount(row)` → lookups + the safe public shape.
- `ctx.auth.accountForOwner()` → the app's single **platform-owner account** (`is_owner=1`,
  auto-provisioned).

**Owner auto-login**: the dashboard admin never signs up. A request that reaches the app with the
platform owner cookie (the dashboard iframe / owner tab) passes `ctx.auth.require` as the
auto-provisioned `is_owner` account — `/api/auth/me` succeeds with no token, `publicAccount` sets
`isOwner: true`, `via` is `'owner'`, and any `auth.license` gate treats the owner as fully licensed
(`status:'owner'`, all tier features). Frontends should therefore try `/api/auth/me` BEFORE showing
a login gate, even with no stored token: the admin auto-signs-in; everyone else gets a 401 and the
gate. The owner can link Telegram or attach email to this account like any other (`/api/auth/link`,
`/api/auth/attach-email`) — after linking, the same account signs in from outside the dashboard too.
<!-- /API:DETAIL -->

<!-- /API:SECTION -->
<!-- API:SECTION key=whatsapp -->
### WhatsApp (Per-App, Cloud API)

> **Opt-in only.** Wire WhatsApp into an app **only when the user explicitly asks for it**.
> Each app has its **own** WhatsApp Business number. The user pastes a **Phone Number ID**,
> **Access Token**, and **App Secret** (from Meta for Developers) under **Apps → Setup →
> WhatsApp** and binds it to this app, then copies the generated **Callback URL** + **Verify
> Token** into Meta's webhook config. If `ctx.whatsapp.configured()` /
> `Bridge.call('whatsapp.status')` reports `configured: false`, tell the user to add credentials
> in Setup; never hardcode tokens.

**Signature-symmetric with Telegram.** `ctx.whatsapp` mirrors `ctx.telegram` method-for-method,
so an app written for one channel ports to the other by renaming the namespace. `chatId` is the
user's **wa_id** (their phone number in international format). Inbound is **webhook-only** (the
Cloud API has no polling), so a public HTTPS URL is required — the platform handles delivery once
the user configures the webhook in Meta.

> **24-hour customer-service window.** Plain `send()` (and the interactive helpers) only work
> within **24 hours** of the user's last inbound message. Outside that window WhatsApp requires a
> pre-approved *template* message — **template sending is not yet supported by this platform**, so
> design flows that reply to user-initiated conversations. A `send()` outside the window will
> return a WhatsApp API error.

Symmetric methods (same names/signatures as `ctx.telegram`):
- `whatsapp.status()` — `{ configured, phoneNumberId, displayPhone, mode, restricted, ... }`.
- `whatsapp.send(chatId, text, opts?)` — send a text message. (`opts.previewUrl` enables link previews.)
- `whatsapp.sendPhoto({ chatId, photo, caption?, options? })` — send an image. `photo` may be a
  base64 string / `data:` URI (uploaded to the Cloud API first) **or** an http(s) URL / media-id
  (sent by reference). Same shape as `telegram.sendPhoto`.
- `whatsapp.call(method, params)` — raw escape hatch onto the Graph `/messages` endpoint.

WhatsApp-only methods (no Telegram analog — these are the rich interactive surface):
- `whatsapp.sendButtons(chatId, { text, buttons:[{id,title}], header?, footer? })` — up to **3**
  reply buttons (title ≤ 20 chars). A tapped button arrives as a normalized `selection` (see below).
- `whatsapp.sendList(chatId, { text, button, sections:[{title, rows:[{id,title,description?}]}] })` —
  list menu, up to **10 rows total** (row title ≤ 24, description ≤ 72 chars).
- `whatsapp.sendCta(chatId, { text, title, url })` — single call-to-action URL button.
- `whatsapp.sendLocation(chatId, { lat, long, name?, address? })` / `whatsapp.requestLocation(chatId, { text })`.
- `whatsapp.sendMedia(chatId, { type, media, caption?, filename? })` — `type` is
  `document|video|audio|sticker|image`; `media` accepts the same shapes as `sendPhoto`.
- `whatsapp.react(chatId, messageId, emoji)` / `whatsapp.markRead(messageId)`.
- `whatsapp.media.upload({ buffer, contentType, filename })` / `whatsapp.media.download(mediaId)`.

**Inbound** — handlers receive **two** args: the raw Cloud API message and a **normalized** object
that is identical in shape to the one `ctx.telegram.onUpdate` delivers, so handler logic can be
channel-blind:
```
normalized = { channel, chatId, userId, name, text, type, selection: {id,title}|null, messageId, raw }
```
`type` is `text | button | list | image | ... | other`; `selection` is set when the user taps a
reply button or list row. Everything not normalized is in `.raw`.

```js
// routes.js — a channel-agnostic handler works on both channels
function handle(ch) {
  return async (raw, m) => {
    if (m.selection?.id === 'menu') {
      await ch.send(m.chatId, 'You picked the menu');
    } else if (m.text) {
      await ch.send(m.chatId, 'You said: ' + m.text);
    }
  };
}
ctx.whatsapp.onUpdate(handle(ctx.whatsapp));
ctx.telegram.onUpdate(handle(ctx.telegram));   // same body, both channels
```

From the iframe, inbound arrives on `Bridge.on('whatsapp:update', ({ message, normalized }) => {...})`
and delivery/read receipts on `Bridge.on('whatsapp:status', (status) => {...})`.

**Auth / linking.** Set `"auth": { "whatsapp": true }` in the manifest. A WhatsApp user is
find-or-created as an account row keyed by `wa_id` via `ctx.auth.accountForWhatsapp(waId, name?)`
(the mirror of `accountForTelegram`). To link a WhatsApp identity to the dashboard, issue a code
with `ctx.identity.issueLinkCode(userId, { via: 'whatsapp' })`, have the user send it, and redeem
it at `POST /api/auth/link {code}` — the same link endpoint Telegram uses; the code carries its
channel. One account row can hold **both** `tg_user_id` and `wa_id`, so a user who links both is
one identity. There is **no WhatsApp mini-app surface** (unlike Telegram WebApps).

<!-- /API:SECTION -->
<!-- API:SECTION key=apps -->
### Cross-App Access Lookup

Read-only lookup of **another app's** messaging front doors — for showcase/directory apps that
render "Try it" links or QR codes for sibling apps whose front door is a messaging bot. Answered
entirely from the platform's binding store (the bot identity is cached when the owner binds the
token in Apps → Setup), so it is cheap, never hits Telegram/Meta, and **works even when the
target app is stopped**. Identity fields only — token/secret material is never exposed.

- Frontend: `Bridge.call('apps.access', { app: '<appName>' })`
- routes.js: `ctx.apps.access('<appName>')`

Returns:
```js
{
  app: 'my-gym',
  telegram: {            // null when no bot is bound
    configured: true,
    botUsername: 'MyGymBot',
    botId: 1234567,
    webAppEnabled: false,
    restricted: false,           // true → bot only serves its allowlist (see below)
    deepLink: 'https://t.me/MyGymBot',
  },
  whatsapp: {            // null when no number is bound
    configured: true,
    displayPhone: '+1 555 093 4811',
    restricted: false,           // true → number only serves its allowlist (see below)
    waLink: 'https://wa.me/15550934811',
  },
  publicUrl: 'https://example.com/apps/my-gym/',   // null until a public URL is set in Setup
}
```

**Check `restricted` before publishing a link or QR code.** A restricted channel only serves
chats already on its allowlist, so a first-time stranger scanning the QR gets no reply — don't
publish a dead link. Errors (`App "<name>" not found`) are thrown/returned like any other bridge
error. This surface is strictly read-only and is available to owner dashboard sessions and
routes.js `ctx` only (absent from the standalone ctx and from an app the admin revoked it for).

<!-- /API:SECTION -->

<!-- API:SECTION key=sites -->
### Sites (own web servers)

A **site** is a public web server of your app: its own process on its own port, a child of the
dashboard (it stops when the dashboard stops or restarts and comes back when it starts — no
pm2/systemd). The dashboard part of an app always stays behind the owner login; everything the
outside world reaches goes through a site. nginx (or the dashboard's byte-proxy at
`/s/<app>/<site>/`) maps a domain onto the site's port.

Declare it in `manifest.json`:

```jsonc
"sites": {
  "main": {
    "handler": "site/index.js",   // a .js file in its OWN directory (not the app root)
    "defaultPort": 8080,          // 1024–65535, not 3456/3457; the owner may change it per host
    "bind": "127.0.0.1",          // default; "0.0.0.0" only when no proxy sits in front
    "autostart": true,            // default true
    "access": "public",           // required; the only value built today
    "platform": "none"            // default; "controlled" = may call your registered onCall handlers
  }
}
```

`access` "users" / "vc" and `platform` "loose" are refused as not built yet (`npm run lint:app`).

The handler runs in `platform/site-runner.js`, never in the dashboard, with no platform env
(no `AUTH_TOKEN`, no provider keys). On Node ≥ 22.13 it is **fenced** (Node's permission
model): it may read only its handler directory, the app's `node_modules`, `package.json` and
`.data/sites/<site>/`, write only `.data/sites/<site>/data/`, and spawn no child process or
worker. Keep everything the site needs inside its directory.

```js
// site/index.js
module.exports = function createSite(site) {
  const serve = site.static();                 // the active snapshot (see publish)
  return async (req, res) => {
    if (req.url === '/api/subscribe' && req.method === 'POST') {
      const body = await readJson(req);          // your own helper
      const r = await site.call('subscribe', { email: body.email }, { timeoutMs: 5000 });
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(r));
    }
    await serve(req, res);                        // 404 when nothing matches
  };
};
// or return { request(req, res), upgrade(req, socket, head) } to take WebSocket upgrades
```

The `site` object: `site.content` (active snapshot dir or null), `site.snapshot` (its id),
`site.static(dir?, { maxAge, immutable, cacheControl, index, fallthrough })` (ETag, ranges,
304s; refuses `..` and every dotfile; serves only inside `dir`, default the active snapshot —
switched per request, no restart), `site.config` (live object; `site.onConfig(fn)`),
`site.call(name, args, { timeoutMs })` (only with `platform: "controlled"`; JSON args ≤ 64 KB,
result ≤ 256 KB, 60 calls/min per client /24 or /64, default timeout 5 s, max 30 s; rejects
with `err.code` `platform_none` | `unknown_call` | `too_large` | `rate_limited` |
`app_stopped` | `timeout`), `site.log.info/warn/error`, `site.dataDir`, `site.port`,
`site.fenced`. `GET /_vc/id` is answered by the runner (the domain check).

routes.js (`ctx.sites`, in-process apps) and the iframe (`Bridge.call('sites.<m>', { site, … })`):

| ctx | Bridge | |
|---|---|---|
| `list()` | `sites.list` | every declared site's status |
| `status(site)` | `sites.status` | `{ state, pid, port, bind, uptimeMs, mem, reqPerSec, lastError, crashCount, fence: 'fenced'\|'unfenced', snapshot, … }` |
| `start/stop/restart(site)` | `sites.start/stop/restart` | stopping the app does NOT stop its sites |
| `config(site[, obj])` | `sites.config` `{ site, config? }` | read / replace `site.config` live |
| `onCall(name, async (args, { site, ipPrefix }) => result)` | — | the names `site.call` may reach; returns unregister. Register in `setup`. |
| `publish(site, dir, { note })` | `sites.publish` `{ site, dir, note }` | copies `dir` (iframe: a path inside the app) into a new snapshot and serves it — no restart; symlinks are skipped |
| `snapshots(site)` | `sites.snapshots` | `[{ id, at, note, files, bytes, active }]`, the owner sets how many are kept (default 5) |
| `rollback(site, id)` | `sites.rollback` | serve an older snapshot (< 1 s) |

Events (no polling): `site:status`, `site:crashed`, `site:published` — `Bridge.subscribe` in the
iframe, and on the bus. A crash restarts the site with backoff (1 s … 60 s). `<vc-site-status
site="main">` (see the UI section) shows a site's live state in your page.
<!-- /API:SECTION -->
<!-- API:SECTION key=platform-cron -->
### Platform Cron (Persistent Scheduling)
- `platform.cron.list()` — list all platform cron jobs. Returns `[{ id, name, schedule, target, enabled, lastRunAt, lastResult }]`.
- `platform.cron.schedule({ name, schedule, target })` — create a persistent cron job. Schedule: cron expression (e.g. `"*/5 * * * *"`) or simple format (`"every 5 minutes"`). Target: `{ type: "app-api", app: "<name>", method: "POST", path: "/api/..." }` or `{ type: "shell", command: "..." }` or `{ type: "ai", message: "...", systemPrompt: "..." }`. Returns `{ jobId }`.
- `platform.cron.cancel({ jobId })` — remove a cron job
- `platform.cron.enable({ jobId })` / `platform.cron.disable({ jobId })` — toggle

From routes.js — `ctx.platform.cron`, for jobs that call **your own** endpoints (in-process apps; absent from the own-process ctx). Register in `setup` so the schedule exists even if the dashboard is never opened:
- `ctx.platform.cron.list()` — `list`: this app's jobs only (those it owns, plus unowned `app-api` jobs targeting it). Same row shape as `platform.cron.list()`.
- `ctx.platform.cron.schedule({ name, schedule, target: { method?, path }, enabled? })` — `schedule`: an `app-api` job against this app (`target.app` defaults to and must equal `ctx.appName`; `method` defaults to `POST`). **Idempotent by `name`**: an existing job of that name is reused, and updated if `schedule`/`target` differ — safe to call on every mount. An owner's disable is kept unless you pass `enabled`. Returns `{ jobId, created, updated }`. The job is owned by the app: it survives restarts and is removed when the app is deleted.
- `ctx.platform.cron.cancel({ jobId } | { name })` — `cancel`: remove one of this app's jobs. Returns `{ ok }`.

```js
await ctx.platform.cron.schedule({ name: 'daily-refresh', schedule: '20 5 * * *',
  target: { method: 'POST', path: '/api/refresh' } });
```

Platform cron jobs survive server restarts. Use this for recurring automation (periodic fetches, cleanup, reports). The per-app `cron.schedule` bridge method is backed by the same persistent scheduler — its jobs also survive restarts and are removed automatically when the app is deleted. Prefer `platform.cron.schedule` with an `app-api` target when you want to drive your app's own HTTP endpoints; use per-app `cron.schedule` for simple recurring shell commands.

<!-- /API:SECTION -->
<!-- API:SECTION key=licensing -->
### App Licensing

Paid/freemium apps: declare `"auth": { "email": true, "license": "<product>" }` or the object form `{ "product", "tiers": { "<slug>": { ..features } }, "free": { ..features }, "graceHours" }` and read `ctx.license.entitlement(accountId)` (`{ licensed, status, tier, features, expiresAt }`) where you enforce tier limits; the platform adds `/api/auth/license/{claim,release,products}` and `license` on `/api/auth/me` (statuses `active`, `grace`, `free`, `invalid`, `none`, `unreachable`), and a login method is required. The backend is the platform's licence provider, a slot that is **empty by default**: the owner is always entitled, every other account gets the `free` tier (without `free`: `402 license_required`), `claim` answers `503 licensing_unavailable`, `products` is `{ product, variants: [] }`. Also available: `ctx.license.refresh`, `validate(key)`, `release`, `products()`. Do NOT hand-roll key validation, entitlement caching or `http.fetch` calls to a licence service, and do not add licence tables to the app DB; declare `auth.license` and read entitlements.

<!-- /API:SECTION -->

### App APIs
Mounted apps expose REST APIs at `/apps/<name>/api/*`. These are callable by platform cron jobs (target type `app-api`) and by other apps via `http.fetch`. When building an app that needs periodic processing, expose an API endpoint and register a platform cron job to call it.

## Routes.js Context (Mounted Apps)

Mounted apps export `function setup(router, ctx)`. The loader gives every ctx `appName`, `appDir`,
`dataDir` and `basePath`; every other member belongs to a capability and is described in that
capability's section (`ctx.dbQuery` → `db`, `ctx.events` → `events`, `ctx.registerTools` → `tools`, …).
`routes.js` is re-read from disk on Stop → Start; edits need that restart (the user does it).

<!-- API:DETAIL key=routes-ctx -->
### The routes.js contract and the full `ctx` member list

Routes are loaded into vistaclair's Express app at `/apps/<name>/` when the user clicks Start — no separate port or process. The loader pre-applies `express.json({ limit: '10mb' })` on the router and serves `public/` as static fallback after your routes. `setup` may return a cleanup function (may be async) that is called on Stop.

For OAuth redirect URIs, derive from request headers — never hardcode `localhost`:
`${req.headers['x-forwarded-proto'] || req.protocol || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}${ctx.basePath}/callback`

**Own-process apps** (`"runtime": "own-process"`, rare): same `routes.js` contract, but the platform hosts the app in its own dashboard-managed child process on a loopback port and reverse-proxies `/apps/<name>/*` to it. The browser never hits the internal port directly; the routes.js gets the restricted standalone ctx. Do NOT add a `server.js` or call `app.listen()`.

The `ctx` object provides:
- `ctx.appName` — app slug
- `ctx.appDir` — absolute path to app directory
- `ctx.dataDir` — path for app data files (create with `fs.mkdirSync`)
- `ctx.basePath` — URL base path (`/apps/<name>`)
- `ctx.broadcaster` — push WebSocket events: `ctx.broadcaster.broadcast({ type, ... })`
- `ctx.aiPrompt({ message, systemPrompt?, model?, expectJson?, allowedTools?, retries? })` — server-side AI calls. Omitting `allowedTools` means no tools (fast/cheap text/JSON); list the tools to grant any. `retries` auto-retries transient failures.
- `ctx.jobs.start({ name, meta?, run })` / `ctx.jobs.get(id)` / `ctx.jobs.list(filter?)` / `ctx.jobs.cancel(id)` / `ctx.jobs.remove(id)` / `ctx.jobs.prune(opts?)` — persisted long-running jobs (see Jobs section)
- `ctx.settings.get(key?)` / `ctx.settings.set(keyOrObj, value?)` / `ctx.settings.all(defaults?)` — per-app settings (see App Settings section)
- `ctx.ensureSchema(statements)` — provision the DB and run DDL statements serially (see Database section)
- `ctx.sse.handler(channelFn?)` / `ctx.sse.emit(event, data, channel?)` — SSE for cookieless clients (see "Mini-apps and app users")
- `ctx.files.saveBase64(data, opts?)` / `ctx.files.serve(res, filePath, opts?)` — uploads & range-capable file serving (see Files & Uploads)
- `ctx.transcribe({ audio, accuracy?, model?, ... })` — speech-to-text (OpenAI); `audio` base64. Returns `{ text, ... }`
- `ctx.tts({ input, voice?, instructions?, ... })` — text-to-speech (OpenAI). Returns `{ audio, mimeType, dataUri }` (base64)
- `ctx.image({ prompt, image?, aspectRatio?, imageSize? })` — image generation/editing (Gemini). Returns `{ images: [{ data, mimeType, dataUri }], text }`
- `ctx.translate({ text, target, source?, format? })` — text translation (Google Cloud Translation). Returns `{ text, translations, detectedSourceLanguage }`
- `ctx.route({ origin, destination, ... })` / `ctx.routeMatrix({ origins, destinations, ... })` / `ctx.geocode({ address?|lat/lng? })` / `ctx.places({ op?, ... })` / `ctx.placePhoto({ name, maxWidthPx? })` / `ctx.streetview({ op?, lat, lng, heading? })` / `ctx.tiles3d({ op?, uri? })` — Google Maps Platform: directions, distance matrix, geocoding, place search, place photos, Street View stills, Photorealistic 3D Tiles (see Maps & Routing section)
- `ctx.webSearch({ query, count?, freshness?, ... })` — live web search (Brave Search). Returns `{ results, news, videos }` (see Web Search section)
- `ctx.browser.screenshot({ html, width?, height?, deviceScaleFactor?, fullPage?, waitForFunction? })` — hermetic HTML→PNG render (inline HTML + this app's own on-disk assets only, no network). Returns a PNG `Buffer`. Set `window.__shotReady = true` when drawn. See Headless Render. (capability: `browser`)
- `ctx.notify(title, body, level)` — dashboard-level toast notification
- `ctx.googleAuth.getToken(scopes)` — get Google OAuth access token
- `ctx.googleAuth.accounts()` — list connected Google accounts
- `ctx.emailAccounts.list()` — list platform email accounts (no passwords)
- `ctx.emailAccounts.getCredentials(email)` — get full credentials for an email account
- `ctx.email.*` — platform email engine: `list`, `get`, `modify`, `send`, `attachment`, `createFolder`, `annotate`, `annotations`, `syncStatus`, `syncNow`, `on(event, handler)`, `subscribe(events)` (see Email Engine section)
- `ctx.calendar.*` — platform calendar engine: `events`, `get`, `create`, `update`, `delete`, `listCalendars`, `selectCalendars`, `colors`, `annotate`, `annotations`, `syncStatus`, `syncNow`, `formatWhen(iso, tz)`, `on`, `subscribe` (see Calendar Engine section)
- `ctx.telegram.configured()` — whether this app has a Telegram bot bound (opt-in; see Telegram section)
- `ctx.telegram.send(chatId, text, options?)` — send a Telegram message via this app's bot
- `ctx.telegram.sendPhoto({ chatId, photo, caption?, options? })` — send a photo. `photo` is a `Buffer` (e.g. from `ctx.browser.screenshot`) / base64 / `data:` URI (uploaded), or an http(s) URL / `file_id` (by reference)
- `ctx.telegram.sendDocument({ chatId, document, filename?, contentType?, caption?, options? })` — send a file. `document` is a `Buffer` / base64 (uploaded), or an http(s) URL / `file_id` (by reference)
- `ctx.telegram.call(method, params)` — call any Telegram Bot API method (JSON only — use `sendPhoto`/`sendDocument` to upload bytes)
- `ctx.telegram.onUpdate(handler)` — subscribe to inbound Telegram updates (returns an unsubscribe fn)
- `ctx.telegram.webAppUrl(opts?)` — this app's public root URL (null until a public URL is set); `ctx.telegram.entryUrl(opts?)` — the cookieless entry page (`…/app.html`) a WebApp button must open. `{ customDomain: true }` → the recorded custom domain's URL instead, when one is recorded
- `ctx.fleet.peers()` / `ctx.fleet.dataPublish(peer, { name, manifest, meta? })` (+ `.plan` / `.status` / `.cancel` / `.list`) / `ctx.fleet.onDataReceive(nameOrGlob, { have, receive })` — data publish of `.data/` blobs to this app on a linked slave; not in own-process apps (capability: `fleet`, flag `fleet.sync`, see Fleet)
- `ctx.apps.access(appName)` — read-only lookup of **another** app's messaging front doors (Telegram bot + deep link, WhatsApp number + wa.me link, public URL); identity only, never tokens (capability: `apps`, see Cross-App Access Lookup)
- `ctx.identity.resolve(req)` — authenticate a request from EITHER context → `{ userId, via, user? }` or null (see Identity & linking)
- `ctx.identity.require` — Express middleware: 401 or set `req.appUser = { id, via, telegram }`
- `ctx.identity.issueLinkCode(userId, opts?)` / `ctx.identity.redeemLinkCode(code)` — ephemeral 6-digit link codes (Telegram chat → dashboard)
- `ctx.identity.issueSession(userId, { via?: 'telegram'|'whatsapp', ttlMs? })` / `ctx.identity.verifySession(token)` — signed, stateless session tokens; `via` tags the channel so the platform guard maps the id to the right account
- `ctx.identity.validateInitData(initData, opts?)` — low-level Telegram initData HMAC check (resolve() uses this)
- `ctx.identity.hashPassword(plain)` / `ctx.identity.verifyPassword(plain, stored)` — scrypt password hashing (used by the turnkey auth module; call directly only for bespoke auth)
- `ctx.identity.randomToken(bytes?)` — random hex token (e.g. email-verification links)
- `ctx.auth.require` / `ctx.auth.findOrCreateTgAccount(tgUser)` / `ctx.auth.accountById(id)` / `ctx.auth.publicAccount(row)` — **only when `manifest.auth` is set**; account-keyed multi-user auth (see "Multi-user, email/password, and linking")
- `ctx.license.entitlement(accountId)` / `refresh` / `validate(key)` / `release` / `products()` — **only when `manifest.auth.license` is set**; licence entitlements + tier features from the platform licence server (see App Licensing)
- `ctx.getDb()` — raw MariaDB pool
- `ctx.dbName` — app's database name (`vc_<appname>`)
- `ctx.dbQuery(sql, params)` — query the app's database
- `ctx.provisionDb()` — provision the app's database on demand
- `ctx.registerTools([...])` — register MCP tools for `aiPrompt()` calls
- `ctx.onToolCall(name, handler)` — register a handler for an MCP tool
- `ctx.artifacts.put(pathOrBuffer, opts?)` / `get(ref)` / `import(ref, destRel)` / `pin(ref, reason)` / `unpin(ref)` / `list(filter?)` — files handed to tool callers as `vc-artifact://` references (see Artifacts)
- `ctx.embed(input)` — local 384-d embedding(s) for semantic search (string → `number[]`, string[] → `number[][]`)
- `ctx.vectorLiteral(vec)` — format a vector for MariaDB `VEC_FromText(?)`
- `ctx.embeddingInfo` — `{ model, dim, maxBatch, loaded }`
- `ctx.memory.remember(...)` / `ctx.memory.recall(...)` / `ctx.memory.rememberBatch(...)` / `ctx.memory.forget(...)` / `ctx.memory.entities(...)` / `ctx.memory.history(...)` — shared platform memory
<!-- /API:DETAIL -->

## Toolchains

Heavy platform extras an app shells out to (Android SDK, Blender, Rust, Godot, Unity), at fixed `/opt` paths, installed from Apps → Setup → Extras.

<!-- API:DETAIL key=toolchains -->
### Toolchains (platform extras with fixed paths)

**The rule.** A toolchain lives at a fixed path under `/opt/vistaclair-<name>/`. Reference that path — never a PATH lookup (a box may carry another `blender` or `java` on PATH: a snap, a distro package, the wrong JDK). Declare it in `manifest.json` → `"toolchains": ["android" | "blender" | "rust" | "godot" | "unity"]`; that is a badge on the app's row showing whether this host has it, **not a gate** — nothing stops the app starting without it. So the app checks for the file itself and fails loudly with `<tool> toolchain missing — install under Apps → Setup → Extras`, never a stack trace or a silent fallback.

**Android** (`"android"`, extra `android-build`) — bootstrap only: OpenJDK 17, cmdline-tools, licences, platform-tools. Source `/opt/vistaclair-android/bin/android-env` (exports `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `PATH`). The SDK platform and build-tools belong to the app (except the three Godot pins, which the `godot` extra installs — see **Godot**): pin them in an app-side shim next to the gradle files and install them with `sdkmanager` on the first build. Pattern: my-cams `bin/apk-env` (sources `android-env`, falls back to caller-exported vars, pins the frozen versions), sourced by `bin/apk-build`.

**Blender** (`"blender"`, extra `blender`) — the pinned LTS (5.2.2) from blender.org, official linux-x64 build:

| Path under `/opt/vistaclair-blender/` | What |
|---|---|
| `bin/blender` | The wrapper — always run this. Picks `versions/$VC_BLENDER_VERSION` (default: the pinned LTS), sets `BLENDER_USER_RESOURCES=…/config/<ver>` so config, scripts and add-ons never touch `~/.config/blender`, then execs the real binary (exit 127 + a message when that version is absent) |
| `bin/blender-env` | Source it: exports `VC_BLENDER_ROOT`, `VC_BLENDER` (the wrapper), `VC_BLENDER_VERSION`, `VC_BLENDER_PYTHON` (Blender's bundled Python — e.g. `pip install --target` for an add-on's deps; empty when absent) |
| `bin/blender-fetch <ver>` | Downloads, sha256-verifies and unpacks another release into `versions/<ver>/`; run it with `VC_BLENDER_VERSION=<ver>` afterwards. Idempotent |
| `versions/<ver>/` | The unpacked official builds |
| `capabilities.json` | The install-time test render: `{ version, python, engines: { workbench, eevee, cycles }, headless: true, checkedAt }` (engines are booleans). Read it to choose an engine instead of discovering a failure mid-render |

Invocation: `bin/blender -b --factory-startup -noaudio --python x.py -- <args>`; in the script, your args are `sys.argv[sys.argv.index('--') + 1:]`. What makes it robust:
- Spawn with `DISPLAY` and `WAYLAND_DISPLAY` removed from the env (or `env -u DISPLAY -u WAYLAND_DISPLAY`). All three engines render headless through EGL; an inherited display ties the render to a desktop session.
- `--factory-startup` always, so user prefs or add-ons never change the output.
- Blender's Python ignores `PYTHONPATH`. To import your own package, put `--python-expr "import sys; sys.path.insert(0, '<dir>')"` before `--python x.py`. Inside the script `sys.argv` still holds only what follows `--`.
- Speak a marker-line protocol on stdout (`print(..., flush=True)`): e.g. `PROGRESS i/n`, `RESULT <json>`, a traceback between `ERROR_BEGIN` / `ERROR_END`. Parse those, keep the rest as log. The exit code is no verdict: a Python exception under `--python` still exits 0 unless you pass `--python-exit-code 1`.
- A stall watchdog: kill the process after N seconds without output (Eevee's first shader compile can take a minute — size N for it). Make frame renders resumable (`render.use_overwrite = False`, `render.use_placeholder = True` skips frames already on disk and lets parallel shards claim frames).
- A long render runs as a job (`ctx.jobs`), so a GUI reload re-attaches to it.

**Blender 5 API gotchas** (each one hit in practice):
- `scene.node_tree` is gone — the compositor is a node group assigned to `scene.compositing_node_group`, and a `CompositorNodeRLayers` node must be created INSIDE that group (`NodeGroupInput` is not fed the render — output comes out black).
- `action.fcurves` is gone (layered actions): use `action.layers[0].strips[0].channelbag(anim_data.action_slot).fcurves`, with a legacy fallback.
- Node sockets have no `animation_data`. Keyframe with `sock.keyframe_insert('default_value', frame=f)`; to restyle that curve, find it on `sock.id_data.animation_data` by `sock.path_from_id('default_value')`.
- `CompositorNodeMixRGB` and `CompositorNodeTexture` are gone from compositor trees — use `ShaderNodeMixRGB` (`Factor` / `inputs[1]` / `inputs[2]` → `Color`) or `ShaderNodeMix`; for procedural noise, `ShaderNodeTexWhiteNoise` / `ShaderNodeTexNoise` fed by `CompositorNodeImageCoordinates` (+ `CompositorNodeSceneTime` Frame → the 4D `W` input for per-frame variation).
- Node options moved to input sockets: Glare's type is a menu socket with value `'Bloom'` (not `'BLOOM'`); `CompositorNodeEllipseMask` takes one `Size` vector (no Width/Height); `CompositorNodeBlur` has a `Size` vector **in pixels** and a `Type` menu socket (`'Fast Gaussian'`) — `filter_type` / `use_relative` / `factor_x` are gone.
- The engine enum is `'BLENDER_EEVEE'` (also `'BLENDER_WORKBENCH'`, `'CYCLES'`). Eevee has no bloom toggle — bloom is the compositor Glare node.
- Some Eevee options change type between builds (`eevee.ray_tracing_options.resolution_scale` is an enum on some, an int on others) — set such options inside their own `try`.
- An animation render prints `Saved: '<path>'` per frame, not `Fra:` lines.

**Rust** (`"rust"`, extra `rust`) — rustup with the pinned stable (1.99.0) as default, plus clippy, rustfmt, the `wasm32-unknown-unknown` and `aarch64-linux-android` targets and `cargo-ndk` 4.1.2 (for cdylibs loaded on an Android device: Godot GDExtensions, Unity plugins). The crates, maturin, `@napi-rs/cli`, wasm tooling and any other Rust version belong to the app.

| Path under `/opt/vistaclair-rust/` | What |
|---|---|
| `bin/rust-env` | Source it: exports `VC_RUST_ROOT`, `RUSTUP_HOME`, `CARGO_HOME`, `PATH` (with `cargo/bin` first), and unsets `CARGO_TARGET_DIR`. Never use `~/.cargo` / `~/.rustup` |
| `rustup/` | `RUSTUP_HOME` — every toolchain, including one your `rust-toolchain.toml` pins |
| `cargo/` | `CARGO_HOME` — the crates.io cache shared by all apps (cargo locks it; concurrent builds are safe) and `bin/` with the `cargo` / `rustc` / `rustup` proxies (plus `cargo-ndk`, installed by the `rust` extra). Do not `cargo install` into it: use `cargo install --locked --root <app>/.tools <crate>@<ver>` |
| `capabilities.json` | The install-time test build: `{ rustc, cargo, rustup, checks: { native, pyo3, napi, wasm, android_target, cargo_ndk, android_cdylib }, android: { target, cargoNdk, ndk }, checkedAt }` (checks are booleans; `android_cdylib` is a `cargo ndk -t arm64-v8a` cross-build of a cdylib, false when no NDK was under `/opt/vistaclair-android/sdk/ndk` at install; `android.ndk` is the NDK version it used). Read it before relying on a binding path |

The crate lives in the app (e.g. `native/`), with these files committed: `Cargo.toml`, `Cargo.lock` and a `rust-toolchain.toml` (`[toolchain] channel = "1.99.0"`, plus `targets = [...]` when it needs one). Build steps:
- First run `rustup toolchain install` in the crate dir. It installs what `rust-toolchain.toml` names into the shared `rustup/`, and does nothing when it is already there.
- Then `cargo build --release --locked`. Output stays in `<crate>/target/` inside the app; the platform skips it in snapshots and file lists by its `CACHEDIR.TAG`. Keep `target/` in `.gitignore`.
- **Kernels are app-owned.** The code that produces content-addressed outputs (bake ids, cache keys) must change only with an app revision. Keep it in your crate, pinned by your `Cargo.lock`. Never depend on something the platform might bump.
- **Python (PyO3).** Pin `maturin` in the app's `requirements.txt` (it is a wheel; it lands in the app's venv). Then run `maturin develop --release -m native/Cargo.toml` with the venv active, or `maturin build --release` followed by `pip install` of the wheel. Use pyo3 features `["extension-module", "abi3-py39"]` so one build serves every Python ≥ 3.9.
- **Node (napi-rs).** Add `@napi-rs/cli` as a pinned devDependency, put `napi` + `napi-derive` in the crate and `napi-build` in `[build-dependencies]`, then run `napi build --release`. A bare `cargo build` also works: copy `target/release/lib<name>.so` to `<name>.node` and `require()` it.
- **WebAssembly.** `cargo build --release --target wasm32-unknown-unknown`. Pin `wasm-pack` or `wasm-bindgen-cli` yourself (npm devDependency, or `cargo install --root <app>/.tools`). The `wasm-bindgen-cli` version must equal the crate's `wasm-bindgen`.
- Publish ships source only: a slave builds on first use and needs the extra too. Check for `/opt/vistaclair-rust/bin/rust-env` before building, fail loudly when it is missing, and make the build a `ctx.jobs` job when it is slow.
**Godot** (`"godot"`, extra `godot`) — the pinned Godot 4.7.2-stable (official linux x86_64 build, every download hash-verified), editor and headless CLI, in self-contained mode: settings, templates and caches live beside the binary, never in `~/.local/share/godot`. Do not install Godot, templates, cargo-ndk or the Android NDK in the app.

| Path under `/opt/vistaclair-godot/` | What |
|---|---|
| `bin/godot` | The wrapper — always run this. Execs `versions/$VC_GODOT_VERSION/Godot_v<ver>-stable_linux.x86_64` (default 4.7.2); exit 127 + `install under Apps → Setup → Extras` when that version is absent |
| `bin/godot-env` | Source it: exports `VC_GODOT_ROOT`, `VC_GODOT_VERSION`, `VC_GODOT` (the wrapper), `VC_GODOT_VENDORS` (`vendors/5.1.0/asset/addons/godotopenxrvendors`), and defines `vc_godot_release_signing <keystore path> <alias> <password>` (see **Release signing** below) |
| `README.md` | The same orientation in short, including the signed release export |
| `versions/4.7.2/editor_data/export_templates/4.7.2.stable/` | ALL export templates: android (debug/release APK + `android_source.zip` for gradle builds), linux, windows, macos, ios, web |
| `versions/4.7.2/editor_data/editor_settings-4.7.tres` | Preset: `export/android/java_sdk_path` (JDK 17), `android_sdk_path` (`/opt/vistaclair-android/sdk`), `debug_keystore` (`editor_data/keystores/debug.keystore`, user `androiddebugkey`, pass `android`) |
| `vendors/5.1.0/asset/addons/godotopenxrvendors/` | The godot_openxr_vendors 5.1.0 addon — copy (or symlink) it into the project's `addons/` |
| `capabilities.json` | The install-time test: `{ version, checks: { android_export, android_release, android_gradle, gdext_host, gdext_load, gdext_android, gdext_export }, templates, vendors, android: { platform, buildTools, ndk } \| null, rust: { target, cargoNdk, gdext } \| null, checkedAt }` (checks are booleans). Read it before relying on a path |

Headless export (no display needed): `. /opt/vistaclair-godot/bin/godot-env && "$VC_GODOT" --headless --path <project> --import` once, then `"$VC_GODOT" --headless --path <project> --export-debug "<preset name>" <out>.apk` (or `--export-release`). The exit code alone is no verdict: check the output file exists (and `apksigner verify` it). For a gradle build (`gradle_build/use_gradle_build=true`, needed by Android plugins such as the OpenXR vendors) add `--install-android-build-template` to the export command; it unpacks `android/build/` into the project (gitignore it). Set `rendering/textures/vram_compression/import_etc2_astc=true` in `project.godot` for Android.

Android (with the `android-build` extra): `/opt/vistaclair-android/sdk` carries Godot 4.7.2's gradle pins `platforms;android-36`, `build-tools;36.1.0`, `ndk;29.0.14206865` and platform-tools (`adb install -r <apk>` to sideload). Debug exports are signed with the preset debug keystore. **Release signing** holds no key on the platform: keep the keystore and passwords in the app's secrets. Godot reads `GODOT_ANDROID_KEYSTORE_RELEASE_PATH`, `GODOT_ANDROID_KEYSTORE_RELEASE_USER` (the key alias) and `GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD` natively when the preset's `keystore/release`, `release_user` and `release_password` are empty. Recipe: `. /opt/vistaclair-godot/bin/godot-env && vc_godot_release_signing "<keystore path>" "<alias>" "<password>" && "$VC_GODOT" --headless --path <project> --export-release "<preset>" <out>.apk` — the helper exports the three variables and returns 1 on an empty value or a missing keystore file, so a build never falls through to an unsigned release. Check the file exists and `apksigner verify --print-certs` (build-tools `36.1.0`) shows your certificate; the install proves the path with a throwaway keystore (`android_release`). Never commit a keystore or put the passwords in `export_presets.cfg`.

Rust GDExtension (with the `rust` extra, which installs the `aarch64-linux-android` target and `cargo-ndk` 4.1.2 — see **Rust**; nothing to add in the app). Use godot-rust gdext 0.5.x with `features = ["api-4-7"]` (prebuilt bindings: no libclang / bindgen; only `api-custom` needs them), `crate-type = ["cdylib"]`. Build: `. /opt/vistaclair-rust/bin/rust-env`, then `cargo build --release --locked` (host) and `ANDROID_NDK_HOME=/opt/vistaclair-android/sdk/ndk/29.0.14206865 cargo ndk -t arm64-v8a build --release --locked`. Point the `.gdextension` (`entry_symbol = "gdext_rust_init"`, `compatibility_minimum = 4.7`) at both `.so` files (`linux.*.x86_64`, `android.*.arm64` keys, paths under `res://`); the export packs the android one into `lib/arm64-v8a/`. A `rust-toolchain.toml` pinning another channel must list `targets = ["aarch64-linux-android"]`.

**Unity** (`"unity"`, extra `unity`) — the pinned Unity 6000.3.28f1 (6.3 LTS, changeset `8f082d2fe476`) Linux editor with Android Build Support and the sub-modules that release pins, every download hash-verified; one self-contained tree per version. Do not install Unity, the Hub, an Android SDK / NDK / JDK or the Unity CLI in the app.

| Path under `/opt/vistaclair-unity/` | What |
|---|---|
| `bin/unity` | The editor wrapper — always run this. Licence check first (`bin/unity-license ensure`: a lapsed Personal licence is re-activated while the account is signed in), then `versions/$VC_UNITY_VERSION/Editor/Unity` (default 6000.3.28f1). Exit 3 = no licence, 127 = that version absent. A lone `-version` needs no licence |
| `bin/unity-env` | Source it: exports `VC_UNITY_ROOT`, `VC_UNITY_VERSION`, `VC_UNITY` (the wrapper), `VC_UNITY_EDITOR`, `VC_UNITY_ANDROID` (the AndroidPlayer dir), `VC_UNITY_CLI`, `VC_UNITY_LICENSE`, `VC_UNITY_BUILD_PACKAGE`, `UNITY_CLI_HOME`, `VC_UNITY_UPM` (the `upm/` dir), `VC_UNITY_UPM_MANIFEST` (`upm/$VC_UNITY_VERSION/manifest.json`) |
| `bin/unity-license` | `status` (prints `unity license status --json`; exit 0 active, 3 not), `ensure`, `login`, `activate` |
| `versions/<ver>/Editor/Data/PlaybackEngines/AndroidPlayer/` | `OpenJDK/` (17.0.18+8), `NDK/` (r27c), `SDK/` (build-tools 36.0.0, platform-tools 37.0.1, `platforms/android-34`, `android-36`, cmake 3.22.1, cmdline-tools 16.0) — Unity's embedded tools, used as they are |
| `cli/bin/unity` | The Unity CLI |
| `upm/` | The offline UPM package set (below): `<name>-<version>.tgz`, registry-hash verified, and `upm/<ver>/manifest.json` per editor version |
| `packages/com.vistaclair.build/` | Android signing from env (below) |
| `keystores/debug.keystore` | The shared debug keystore (`android` / `androiddebugkey` / `android`) |
| `capabilities.json` | The install-time test: `{ version, default, versions, changeset, cli, license: { active, signedIn, products } \| null, checks: { license, rust_host, rust_android, project, urp, openxr, multiview, vulkan, rust_editor, apk, il2cpp_arm64, openxr_loader, quest_manifest, rust_apk, signed_debug, signed_release, upm_offline }, apkBytes, android, packages, upm: { dir, manifest, tarballs, offline, optional: { "com.meta.xr.sdk.core": "<ver>" \| null, … } }, rust, checkedAt }` (checks are booleans). Read it before relying on a path |

Headless build (no display): `. /opt/vistaclair-unity/bin/unity-env && env -u DISPLAY -u WAYLAND_DISPLAY "$VC_UNITY" -batchmode -nographics -quit -projectPath <project> -buildTarget Android -executeMethod <Class.Method> -logFile <log>`. The method configures and calls `BuildPipeline.BuildPlayer`, then `EditorApplication.Exit(0|1)`; log your own marker lines and check the APK exists — the exit code alone is no verdict. Active Input Handling, scripting defines and the build target take effect only in the NEXT editor run — set in the build run itself, the editor and the player compile with different defines and the build fails (`… has an extra field … in the player and thus can't be serialized`): commit `ProjectSettings/` with them set, or set them in a separate first run. A first run on a fresh project can end before your method runs (package import): when your start marker is missing from the log, run it once more. Packages: below. Configure by code in the method: `PlayerSettings.SetScriptingBackend(NamedBuildTarget.Android, IL2CPP)`, `Android.targetArchitectures = ARM64`, `SetGraphicsAPIs(Android, [Vulkan])`, `minSdkVersion` 32; XR Management with the `OpenXRLoader` for Android (`XRPackageMetadataStore.AssignLoader`); OpenXR `MetaQuestFeature` + a controller profile on, `renderMode = SinglePassInstanced` (multiview); fix `OpenXRProjectValidation.GetCurrentValidationIssues` errors before building. Cap native compile jobs with `PlayerSettings.SetAdditionalIl2CppArgs("--jobs=4")` and run under `nice`. Gitignore `Library/`, `Temp/`, `Logs/`, `UserSettings/`.

Packages — builds need no registry. `upm/` holds a Quest app's UPM set for the editor, every tarball verified against the registry's hash: `com.unity.xr.openxr` 1.19.0, `com.unity.xr.meta-openxr` 2.7.0, `com.unity.xr.management` 4.7.0, `com.unity.xr.compositionlayers` 2.6.1, `com.unity.inputsystem` 1.20.1 and their whole dependency closure (`com.unity.xr.arfoundation`, `com.unity.xr.core-utils`, `com.unity.burst`, …); `com.unity.render-pipelines.universal` 17.3.0 ships inside the editor. Start `Packages/manifest.json` from `$VC_UNITY_UPM_MANIFEST` (`upm/<ver>/manifest.json`): its `dependencies` name every set package as `"file:/opt/vistaclair-unity/upm/<name>-<version>.tgz"`, URP by version, and `com.vistaclair.build`. Keep all of those lines, even for packages the app does not use directly — a dependency left at a version reaches for the registry. Add your own packages beside them (a registry one needs the network). Optional, fetched when Meta's registry answered (`capabilities.json` → `upm.optional`): the Meta XR Core SDK — add `"com.meta.xr.sdk.core": "file:/opt/vistaclair-unity/upm/com.meta.xr.sdk.core-207.0.1.tgz"` and `"com.unity.xr.hands": "file:/opt/vistaclair-unity/upm/com.unity.xr.hands-1.7.2.tgz"`, plus the built-in modules it uses without declaring them (`com.unity.modules.assetbundle`, `com.unity.modules.physics2d` and the other `com.unity.modules.*` a Unity-created project lists, `"1.0.0"` each). Create a new project's first run with `-upmNoDefaultPackages` (otherwise Unity adds its default packages from the registry). Nothing in the user's Unity config changes; online use is unaffected. Commit `Packages/packages-lock.json`.

Signing: add `"com.vistaclair.build": "file:/opt/vistaclair-unity/packages/com.vistaclair.build"` to `Packages/manifest.json`. Every Android build is then signed from the environment: export `UNITY_ANDROID_KEYSTORE_PATH`, `UNITY_ANDROID_KEYSTORE_PASS`, `UNITY_ANDROID_KEYSTORE_ALIAS` (and `UNITY_ANDROID_KEYSTORE_ALIAS_PASS` when it differs) from the app's secrets before `$VC_UNITY` — write the keystore from a secret to a file outside the repo; without them the shared debug keystore signs. Never commit a keystore or put passwords in `ProjectSettings`.

Rust P/Invoke (with the `rust` extra: `aarch64-linux-android` + `cargo-ndk`): a `crate-type = ["cdylib"]` crate with `#[no_mangle] pub extern "C" fn …`; `. /opt/vistaclair-rust/bin/rust-env`, then `cargo build --release --locked` (host, for editor-time calls) and `ANDROID_NDK_HOME="$VC_UNITY_ANDROID/NDK" cargo ndk -t arm64-v8a -P 29 build --release --locked`. Copy `target/aarch64-linux-android/release/lib<name>.so` to `Assets/Plugins/Android/arm64-v8a/` (importer: Android, CPU ARM64) and the host `.so` to `Assets/Plugins/x86_64/` (importer: Editor, Linux x86_64); gitignore both. C#: `[DllImport("<name>")] static extern int f(int a);` (no `lib`, no `.so`). The APK carries `lib/arm64-v8a/lib<name>.so`.

Licence: Unity Personal (or a Pro / Industry serial the owner stored) of the user the apps run as, kept in `~/.config/unityhub/`. The app sees only `bin/unity` exit 3 with `unity: no active Unity licence for <user> — the owner signs in once: Apps → Setup → Extras → Unity` on stderr (and `bin/unity-license status`: exit 0 active, 3 not): then stop and report `Unity licence missing — sign in under Apps → Setup → Extras → Unity`; never sign in, activate or run `bin/unity-license login` / `activate` from the app. The owner does it on the dashboard of the machine that builds: Setup → Extras → Unity → **Sign in to Unity** opens Unity's approval page in a new tab (or shows the link to open on any device), and the licence activates once approved. The platform re-activates a lapsed licence itself (`bin/unity` before each run, and an hourly check), and alerts the owner when it cannot (signed out).
<!-- /API:DETAIL -->
