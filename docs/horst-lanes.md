# Horst lanes (`horst.lane` in `src/apps/capabilities/*.js`)

What apps reach through ctx, Horst reaches by one rule: every capability
module states, per member, the **lane** Horst has to it.

| Lane | Meaning | Backed by |
|---|---|---|
| `direct` | Horst calls it at once; spend limits apply; no outward act | a tool of his pack (a facet tool, or a brain tool), or `{ deferred: reason }` |
| `card` | only through a governance proposal the owner (or the dial) decides | a registered kind, or `{ missing: reason }` |
| `never` | app-scoped, or forbidden to a model | — |

## Contract

```js
horst: {
  lane: {
    default: 'never',                       // optional: the lane of every member not listed
    direct: { 'ai.image': 'image_generate', 'ai.translate': { deferred: '…' } },
    card:   { 'email.send': 'email.send', 'email.annotate': { missing: '…' } },
    never:  ['ai.voiceSample'],
    why: '…',                               // the non-obvious stances, one line
  },
}
```

- **Members** are the module's bridge `methods`; a module with none
  classifies its `ctx` members (`files`, `identity`, `tools`, `licensing`).
  `dialogs` / `ui` have neither and carry a stance only. A target may be a
  list (`files: ['file_list', 'file_stat']`).
- `validateLane` (load time, `capabilities.js`) refuses a bad shape or a
  member classified twice. `laneProblems` (`capabilities-check` rule 26
  `horst-lane`, and `test/horst-lanes.test.js`) fails a module with no lane,
  an unclassified member (no `default`), a name that is not a member, a direct
  member with neither a tool in the pack nor `deferred`, a card member with
  neither a registered kind nor `missing`. `laneOf(cap)` is the resolved map.
- A facet tool says "Read-only" or serves a direct member of its own module
  (`laneDirectTools`, rule 16): it may produce (an artifact, an answer, a
  metered call) and never acts outward. Outward acts stay kinds.
- No second implementation: a direct tool calls the engine function the
  app's ctx member calls (`ai-media.aiImage`, `maps-service.aiRoute`,
  `app-browser.screenshot`), as appName `platform`.

## Direct tools that produce

| Tool | Module | Engine | Out |
|---|---|---|---|
| `image_generate` | audio | `ai-media.aiImage` (`base` + `inputs` → `params.image`, base first) | image artifact(s) |
| `speech_generate` | audio | `ai-media.aiTts` (mp3 unless `format`) | audio artifact |
| `sound_generate` | audio | `ai-media.aiSfx` (platform default format; `loop` → wav) | audio artifact |
| `audio_transcribe` | audio | `ai-media.aiTranscribe` | transcript text (data) |
| `media_models` | audio | `media-catalog.list` | models + defaults, read-only |
| `maps_route` / `maps_geocode` / `maps_places` | maps | `maps-service` | trimmed JSON |
| `page_render` | browser | `app-browser.screenshot`, rooted at an empty scratch dir | PNG artifact |

Shared glue in `horst-facet.js`: `readArtifact(uri, caller, { mime })` reads
an input as the caller's principal (`app-artifacts.principalOf`; a Horst turn
is the owner, a run's session its run) and refuses an unknown uri, one the
caller may not read, or the wrong media type before any provider call;
`storeArtifact` puts the output with `putPlatform` (owner, producer
`{ platform: 'horst', tool }`) and grants it to a non-owner caller;
`spendSafe` turns a `SpendError` into an `isError` result naming the code.
Model, voice and size default to the configured media defaults
(`docs/models.md`); the spend gate is the `platform` host profile
(`docs/spend.md`). Files reach the owner through the chat turn
(`docs/tool-jobs-artifacts.md`, "Horst route") and are kept in Vista › Files
(`docs/horst-surfaces.md`).

## The lanes

| Module | direct | card | never |
|---|---|---|---|
| fs | — | — | all (an app's sandbox) |
| exec | — | spawn.kill → `spawn.kill` | exec, spawn |
| cron | cron.list → `cron_list` | cron.cancel → `cron.set` | cron.schedule |
| jobs | jobs.list, jobs.get → `jobs_list` | jobs.cancel → `job.cancel` | jobs.remove |
| ai | ai.models (deferred) | — | ai.prompt, ai.usage |
| cli | — | — | all |
| db | db.status → `db_status` | — | db.query, db.provision |
| state | state.get → `state_get` | — | state.set, .delete, .clear |
| settings | settings.get, .all → `settings_get` | — | settings.set |
| secrets, http, google, embeddings, licensing | — | — | all |
| files | files → `file_list` / `file_stat` | — | — |
| notify | — | toast.show, notify (missing) | — |
| dialogs, ui, config | — | — | stance only (no app members) |
| fleet | fleet.peers, .self → `fleet_status`; dataPublish.status → `fleet_data_transfers`; jobs.status → `fleet_remote_jobs` | — | dataPublish.plan, .cancel, jobs.cancel |
| tasks | tasks.list → `tasks_list` | tasks.kill → `spawn.kill` | — |
| events | events.history → `events_history` | — | events.subscribe, .unsubscribe |
| tools | — | tools → `app.tool.job` | registerTools, onToolCall |
| artifacts | artifacts.get, .list (deferred) | — | — |
| identity | identity → `identity_accounts` | — | — |
| capabilities | capabilities.list → `capabilities_list` | — | — |
| audio | ai.image → `image_generate`, ai.tts → `speech_generate`, ai.sfx → `sound_generate`, ai.transcribe → `audio_transcribe`, ai.mediaModels → `media_models`; ai.ttsRender, ai.translate, ai.detect (deferred) | — | ai.voiceSample |
| music | generate, analyze, status (deferred) | — | — |
| maps | ai.route → `maps_route`, ai.geocode → `maps_geocode`, ai.places → `maps_places`; routeMatrix, placePhoto, streetview (deferred) | — | ai.tiles3d |
| web-search | ai.webSearch (deferred) | — | — |
| memory | memory.recall → `memory_search`; entities, history (deferred) | — | remember, rememberBatch, forget |
| email | list, sent → `email_search`; get → `email_get`; attachment → `email_attachment`; rules.list → `email_rules`; draftReply → `email_draft_reply`; 8 reads deferred | send → `email.send`; modify, markRead, star, move, delete → `email.modify`; createFolder → `email.folder.create`; rules.add/remove → `email.rule.add/remove`; tags.set/assign → `email.tags.set`; syncNow → `email.sync.reconnect`; rules.apply, reclassify, annotate, labels.add/update/remove (missing) | accounts.email.credentials, email.subscribe |
| calendar | events, get → `calendar_list`; listCalendars, defaultCalendarId → `calendar_calendars`; freeBusy, availability → `calendar_freebusy`; annotations, syncStatus (deferred) | create, update, move, delete → `calendar.*`; selectCalendars, setDefaultCalendar, annotate, syncNow (missing) | colors, subscribe |
| todos | list, get, counts, similar → `todo_list` | create → `todo.create`; update, complete, snooze, reopen, delete → `todo.update` | subscribe |
| browser | browser.screenshot → `page_render` | — | — |
| telegram | status → `telegram_status` | send, sendPhoto, sendAudio, sendDocument → `telegram.send` (text or media) | call, downloadFile |
| whatsapp | status → `whatsapp_status` | send → `whatsapp.send`; sendMedia, sendPhoto, sendLocation (missing) | sendButtons, sendList, sendCta, requestLocation, react, markRead, call |
| apps | apps.access (deferred) | — | — |
| platform-cron | platform.cron.list → `cron_list` | schedule, cancel, enable, disable → `cron.set` | — |
| sysmon | sysmon.get → `sysmon_get`; processes (deferred) | — | subscribe, unsubscribe |
| print | — | — | pdf; status (deferred) |
| governance | list → `proposals_list`; decisions → `decision_stats` | — | propose, update, decide, horst.briefing, horst.chat |
| spend | spend.status → `spend_status` | — | — |

## Why the non-obvious ones

- **state / db / settings reads are direct, their writes never**: an app's
  own store is read to diagnose (the existing read-only facets) and never
  written; what Horst may change is a configuration (`config.set`).
- **ai.prompt never**: Horst is himself a model call; a nested prompt is an
  app's tool. **ai.usage never**: the calling app's own ledger — Horst reads
  `spend_status`.
- **memory writes never**: `ctx.memory` is an app's scoped face of the store;
  Horst writes his own through the remember / forget / supersede markers.
- **governance never** (propose, decide, update): this is the approval plane
  itself — Horst stages through his propose markers and only the owner decides.
- **tools → app.tool.job**: quick app tools are already in the chat
  (`mcp__app-tools__*`); a long-running one is staged as `app.tool.job`.
- **cron.schedule never, platform.cron.schedule card**: an app's cron fires
  the app's own callback; Horst adds platform jobs through `cron.set`.
- **notify card, missing**: a dashboard toast has no kind; Horst reaches the
  owner in chat and on Telegram.
- **embeddings never**: a raw vector has no chat use; recall embeds itself.
- **telegram.call, whatsapp interactive messages never**: an app bot's own
  conversation and the raw APIs.
- **cli never**: deferred by the owner; the chat has no shell.
- **print.pdf never**: paper leaves the house — a physical, outward act under a per-app page cap the owner set in Setup. Horst does not print; the owner, or an app the owner allowed, does. A card kind can come if the owner wants Horst to print.
- **fleet: reads direct, every act a card**: its kinds (`app.publish`,
  `app.rollback`, `app.data_publish`, `app.remote_call`, `app.remote_job`,
  `peer.keys.sync`, `peer.restart`, `peer.session.launch`) are ceiling-pinned.
  A data publish, a remote call and a remote job need a manifest or args only
  the app builds (`ctx.fleet.dataPublish` / `call` / `jobs.start` are
  ctx-only): Horst asks through the app's own tool, which stages the card.
  `peer.session.launch` asks the owner to run a session on a slave
  (`docs/remote-sessions.md`).

## Not built

- Deferred direct members: music (MusicGen takes minutes on CPU — a direct
  tool would hold the chat turn; it needs a job route for facet tools),
  ai.translate / ai.detect / ai.ttsRender, ai.webSearch (the chat has
  WebSearch), maps routeMatrix / placePhoto / streetview, artifacts.get /
  list, ai.models, apps.access, sysmon.processes, memory entities / history,
  and the email / calendar reads listed above.
- Missing kinds: a dashboard notify; WhatsApp media and location sends
  (`whatsapp.send` carries text); email rules.apply / reclassify / annotate /
  labels; calendar selectCalendars / setDefaultCalendar / annotate / syncNow.
