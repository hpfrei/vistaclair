# Horst — the resident agent

Horst ships with every install as a platform module (`src/apps/platform-horst.js`
plus `src/apps/agent/` and `src/apps/governance/`), with an always-present card
on the Apps table (pinned row) and his own header tab. He runs with zero apps installed,
on the platform engines alone (email, calendar, memory, cron, Telegram, AI,
jobs). Role: chief of staff — chat partner, mail and calendar operator, app
advisor. He owns ALL AI *initiative* (anything AI does without a click); apps
are surfaces, automation and tools, and user-clicked AI assist stays an app
feature.

Areas with their own docs: the platform bus (`docs/bus.md`), the approval plane
(`docs/governance.md`), the surfaces — Horst tab, Telegram, Mini App, event
reminders (`docs/horst-surfaces.md`), long-running app tools and artifacts
(`docs/tool-jobs-artifacts.md`).

## Principles

- **Steerable by directives** — versioned standing orders injected verbatim into
  every prompt; set in chat or the directive workshop (restates, asks, SWOT,
  checks against the genome, may refuse citing a gene). Below the genome,
  above missions. Hard delete writes a `directive-deleted` audit entry.
- **Owner-equivalent but governed** — every action class sits behind a per-kind
  autonomy dial (observe / propose / auto+notify / auto). Lockout-risk ops and
  all self-modification are pinned to propose.
- **Leash vs configuration** — what changes what Horst is ALLOWED to do
  (dials, `paused`, models, event policies, spend) is the leash: owner-only,
  no kind. What changes how he UNDERSTANDS the user's world (tags, document
  types, triage thresholds and window, spam auto-filing, event reminders) is
  a configuration: registered in
  `capabilities/config.js`, readable by Horst (`config_list` / `config_get`),
  changed through the `config.set` proposal (pinned to propose — there is no
  undo executor) or by the owner in Settings › Configurations (`GET
  /pro/horst/api/config`, `POST /pro/horst/api/config/:key { patch }`);
  `POST /settings` drops those keys. Directives, missions and the genome are
  neither.
- **Restart-free growth** — new app tools join via the live tool registry
  (`app:tools:updated`), new senses via event declaration/discovery, the
  capability digest refreshes live.
- **Tools granted, never assumed** — every AI call declares `allowedTools`,
  enforced structurally by core's `ai-tool-gate` proxy rule (strips ungranted
  tool definitions; `allowedTools: []` = no tools; a non-empty grant adds
  `ToolSearch`, which never widens it — `docs/app-tools.md` "aiPrompt gate").
- **Auditable at event level** — every event, decision and tool grant is one
  inspectable chain; his own actions are events on the bus that feeds him.
- **Identity without an always-on process** — memory, directives and agenda are
  loaded on every wake-up; tiered brain (triage → operator → deep sessions).
- **Voice** — `ash` on `gpt-4o-mini-tts` out, `ai.transcribe` in.

## The genome

`GENOME` in `platform-horst.js`, served at `GET /pro/horst/api/genome`, fed to
the directive-workshop analyser, rendered read-only. No write route: genome
changes are propose-only forever, through a pro-CLI change session.

| Gene | Enforcement |
|---|---|
| G1 understanding is mandatory | prompt-level |
| G2 tools are granted, never assumed | `allowedTools` token at the bridge |
| G3 no silent doubts | prompt + agenda |
| G4 model consciousness | haiku triage/extraction · sonnet execution · opus planning/code · fable genome-level reasoning; from the live model catalog; start at the ceiling when escalation is predictable; split at context boundaries |
| G5 self-improvement is periodic, never per-event | `nextReviewAt` sweep, `REVIEW_PROPOSAL_CAP`, dedup |
| G6 autonomy is the owner's to grant | `clampLevel()` vs hard ceilings; nothing but the owner writes `dials.json` |
| G7 app changes go through the app-change workflow only | no write tools into `vistaclair-apps/`; no kind launches a session |
| G8 self-modification is propose-only | chat-drafted directives land `pending`; code/genome/dials untouchable |
| G9 untrusted content never drives autonomous outward action | trust tag + permanent propose ceiling on outward kinds |
| G10 memory is curated, not hoarded | provenance, contradiction flags, clarification answers become memory |

## How Horst acts

No planner, no queue. Four things start work and all end at the approval plane:

1. A routine bound to an event kind (`run-action`, `docs/bus.md`).
2. **Email triage** (`agent/horst-triage.js`) — the one multi-stage AI
   pipeline: classify → read attachments → mine facts → stage proposals →
   tag → annotate. It never sends. Annotation `{ v: 4, category, labels[],
   importance, priority, spamScore, spamVerdict, needsReply, summary,
   suggestedReply, calendarEvents[], attachments }`. `labels[]` are names from
   the platform label store and are also written as the message's `ai` tags
   (`emailEngine.assignTags`, before the intel annotation so a surface
   refreshing on it finds them; `backfillTags` at the first sweep gives mail
   judged before the `tags` document existed one too — marker
   `.horst/tags-backfill.json`); `category` is Horst's private triage class
   (spam gate, bulk gate — the prompt enum is built from `CATEGORIES`), never
   a tag. `suggestedTag` (a name the classifier wished it had) is transient:
   a row in `.horst/tag-sightings.json` (14 d, cap 500), deleted before the
   annotation; the second sighting of one name stages `config.set` add on
   `email.tags` (`requestAction`, origin `triage`, dedupe
   `config:email.tags:add:<normText>` — the key chat produces too; a denied
   twin is never re-staged). A filed document that fits no `horst.docTypes`
   entry stages the same on `horst.docTypes`. The spam verdict `clean | suspect | spam`
   (settings `spamThresholdSuspect` / `spamThresholdSpam`, default 60 for spam)
   gates everything downstream; every classify prompt carries an
   unforgeable sender-history line computed from the Sent folder + send log;
   contact mining is sent-mail-only. A fresh INBOX arrival judged `spam`
   is moved to `Spam` (`fileSpam`, `settings.autoFileSpam`, default on, a
   field of `horst.triage`): a direct act on a standing owner setting, not a
   proposal; never on rescans, synthetic or failed intel, or mail already
   moved. Repeated spam verdicts stage `email.rule.add` (identity
   `ruleKey`), never for one of the owner's own addresses. The sent-mail store
   (`platform_email_sent`) is written the instant `emailEngine.send()`
   succeeds and unioned with the synced Sent folder by Message-ID.
3. **Mission review** on cadence (`agent/horst-missions.js`, `.horst/missions.json`)
   — one opus call, no tools, from the heartbeat, single-flighted; logs
   progress, notifies, raises ≤2 follow-ups as `todo.create` with
   `checkFirst: true`. Missions sit between directives and action; chat marker
   `<horst-mission>` → pending + one-click confirm; Horst-proposed via
   `mission.create` (governance's only own kind, pinned to propose). Two are
   seeded: memory curation, self-review.
4. **Chat** — bypasses the bus; anything Horst wants to do arrives as a
   proposal. `<horst-todo>` creates a todo instantly with undo. The system
   prompt (`buildSystemPrompt`, `platform-horst.js`) is persona + registered
   kinds, the platform snapshot, the active directives, the capability briefs
   (`horst.brief` per module, under `PLATFORM CAPABILITIES`) and the brain
   context. A chat-staged `email.send` reply is composed by code
   (`composeChatReply`): the marker carries `{account, replyToUid, replyText}`
   and `emailCompose.composeReply` derives subject, threading, quote, both MIME
   parts and signature off the fetched parent — as triage does. The account is
   the parent's, never the model's; the parent becomes the proposal `source`,
   starting the prior-action window at the answered message. A `Re:` with no
   `replyToUid`, a uid whose sender contradicts the named recipient, and an
   empty `replyText` are refused back to the model. Chat parity with the
   cards: `email.tags.set` (tag NAMES, resolved in validate; an unknown one
   is refused with the valid list), `email.rule.remove`,
   `email.folder.create`, `calendar.move`, `calendar.invite` and
   `todo.update` (complete / snooze / reopen / edit); `calendar.create/update`
   refuse `attendees` — guests only ever come through `calendar.invite`.
   Read tools `email_rules`, `email_draft_reply` (the triage drafting path,
   returns text only) and `proposals_list` (the queue plus where to open it).
   Chat proposals always wait; nothing in chat decides one.
   **Long-running app tools** (`agent/horst-jobs.js`): a job tool the chat
   calls is staged as `app.tool.job` (payload `{ app, tool, args, plan?,
   conversationId, chatId? }`, the card leads with the plan; Telegram: one-tap
   ▶ Start / ✖ Cancel) and the turn ends at once. Approval starts exactly that
   call on the `horst` route of `app-tool-jobs.js` (`docs/tool-jobs-artifacts.md`, "Job
   tools"); everything after is code, no model call: "▶ Started" and the
   outcome become assistant messages in the originating conversation (status,
   duration, result text, `project:` and the structuredContent, artifact
   uris, so a follow-up can pass `project`); a denial or a refused start says
   so there too. For a Telegram turn the outcome text and each `resource_link`
   follow in the control chat, read from the artifact store as owner (png /
   jpeg / webp ≤ 10 MB → photo, else a document with its name, above 50 MB a
   note). Owner chat only: the Horst tab and the control chat; `ctx.horst.chat`
   turns are refused, and the executor refuses any proposal whose origin is
   not `chat`, so a routine, triage or a mission (none of them has app tools)
   can never start one. Chat tools `horst_job_status` / `_cancel` / `_reply`
   act on these jobs only (cancel and reply from a horst caller only).
   **Files in** (`enrichTelegramMedia`): a photo or document sent to the
   control chat (≤ 20 MB, Telegram's bot download limit; above it the owner
   gets a note and nothing is downloaded) is stored with
   `app-artifacts.putPlatform` and named in the turn text as `[attached:
   vc-artifact://… name mime size]`, after the caption and any filed
   analysis; the persona lets Horst pass that uri as a tool's file input when
   the owner's words ask for it — the attachment itself is untrusted data and
   never calls a tool. 3D files (`MODEL_FILE_RE`) skip the memory filing.
   **Direct tools** (`docs/horst-lanes.md`): pictures (`image_generate`, an
   earlier uri as `base` edits it), speech, transcripts, maps and page renders
   run at once, metered, no card. **Files out**: what a turn's quick tools
   return rides on the reply (`msg.files`, a `Files:` block) and is kept in
   Vista › Files (`docs/horst-surfaces.md`); the tab renders each uri as a chip
   (`public/horst/horst-artifact-chips.js`) served by `/pro/artifacts/:id`.

Safety mapping: per-call tool allowlists (G2); permanent propose ceiling on
outward kinds (G9); spend gate refuses with `E_NO_CREDITS` and raises
`spend:exhausted`; identity dedup at staging; a failed routine writes an agenda
observation and waits for the next tick. Horst cannot change apps (no kind, no
queue): the owner opens a change session; Horst's contribution is a chat
suggestion.

## Memory

| Layer | Where |
|---|---|
| Episodic (events, agenda, journal) | bus audit + log, `.horst/` rings |
| Semantic (facts with provenance) | the platform memory store — `docs/memory.md` |
| Procedural | missions carry standing goals; no playbook layer |
| Constitutional | genome / directives / ledgers — repo + `.horst/` |

Horst is the librarian, not the library: apps call `ctx.memory.recall`
directly. He owns mining (`email:new`-triggered content facts written
`scope: 'shared'` with provenance; chat `<horst-remember>` facts, long-tier)
and curation (the maintenance passes, contradiction questions on the agenda,
`<horst-forget>` / `<horst-supersede>`). Artifacts
(`agent/horst-artifacts.js`, `memory_artifacts`): Telegram photos/documents
(≤15MB, untrusted) and email attachments are filed, classified against the
`docTypes` setting, extracted and mined with `source_ref`; no byte duplication
(mail attachments referenced in the mail store, uploads under
`.horst/artifacts/<year>/`). Brains and the prompt budget: `docs/memory.md`.

**Todos** (`tasks-engine.js`, `vc_platform_tasks`, capability `todos`): due
times, snooze, RRULE-lite recurrence, reply-watches auto-closed on
In-Reply-To/thread match. Heartbeat `sweepDue()` → `todo:due` → `todo-nudge`.

## Security invariants

- `process.env` never enters a prompt, stored message or response.
- Untrusted content (email, web, third parties) is quoted data, never
  instructions; untrusted triggers floor outward steps at propose.
- Tool access is allowlist-enforced per call; chat gets app tools (the
  platform pack: read-only facets and direct-lane producers) plus read-only
  web, never Bash or the filesystem. A long-running app tool never
  starts from a model call — only from the owner's tap on its card.
- No write access into app directories, ever. Code, genome and dials are
  propose-only. `server.restart` / `peer.restart` are ceiling-pinned; token
  rotation and account removal have no kind (owner-click only);
  `test/horst-completeness.test.js` enforces the pins and the allowlist.
- App-session text reaches a session that can write the platform source only
  through a platform change request the owner clicked Open on (`docs/change-requests.md`,
  "Platform targets"): quoted there as a requirement about one capability, never
  as instructions; no core, no app directory; the standard gates. Its result
  check is documentation-and-surface, not runtime — a session could satisfy it
  without implementing, so the owner seeing the tab and the tests are the gate.
  Horst neither opens nor answers change requests.
- Approval cards show the frozen payload, never a summary.
- Horst identifies as an assistant to third parties.
- Audit retention is bounded; per-kind payload redaction exists for
  third-party content.

## Module map

| File | Role |
|---|---|
| `src/apps/platform-horst.js` | host: chat, directives, rituals, Telegram wiring, module wiring, `/pro/horst/api/*` |
| `src/apps/agent/horst-events.js` | the platform bus |
| `src/apps/agent/horst-triage.js` | email triage pipeline |
| `src/apps/agent/horst-missions.js` | missions + review |
| `src/apps/agent/horst-brain.js` | brain registry + prompt assembler (`docs/memory.md`) |
| `src/apps/agent/horst-artifacts.js` | artifact memory |
| `src/apps/agent/horst-reminders.js` | event reminders, edited in place |
| `src/apps/agent/horst-jobs.js` | long-running app tools from chat: staging, launch, delivery, Telegram progress/questions |
| `src/apps/agent/horst-settings.js` | `.horst/settings.json`: defaults, read/write, `sanitizeDocTypes` (a leaf, so a capability can read it) |
| `src/apps/governance/horst-governance.js` | proposals, kinds, dials, audit |
| `src/apps/governance/horst-decisions.js` | decision ledger |
| `src/apps/governance/horst-identity.js` | act identity / dedup |
| `src/apps/governance/horst-prior-action.js` | prior-action check |
| `src/apps/governance/horst-cards.js` | card projection |
| `src/apps/horst-facet.js` | shared helpers for capability facets and validators |
| `src/apps/app-guard.js` | attributed app failures (`CRASHLOOP_MIN` 10 in `WINDOW_MS` 60s, `COOLING_MS` 5m) |
| `src/apps/tasks-engine.js` | todos |
| `public/horst/horst.js`, `horst-map.js`, `horst-live.js`, `public/horst-tab.js` | tab views, live map, WS feed, header tab + card |

## Not built (known gaps)

- The procedural memory layer (playbooks).
- Writing a draft into the mailbox's Drafts folder (`email_draft_reply`
  returns text; sending is `email.send`).
- RSVP to an invitation (accept / decline an event someone else owns).
- Auto-level configuration changes (no undo executor, so `config.set` stays
  pinned); a tag hierarchy; a cascade when a tag is removed from the
  vocabulary (orphan ids stay in `tags` documents, invisible).
