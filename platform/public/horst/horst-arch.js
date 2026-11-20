// Horst architecture diagram — a static structural blueprint of every module
// that makes Horst, how they connect, what triggers them, and where state lives.
//
// Distinct from the Map (horizontal, live data-flow panorama): this is vertical,
// static, structural — "what Horst is made of" vs "what's happening right now."
//
// All content is hardcoded data arrays — no API endpoint. The architecture
// changes only when the code changes, not at runtime.
(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const W = 1100;
  const H = 1680;

  // ── helpers ──────────────────────────────────────────────────────────────

  function el(name, attrs, parent) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v != null) node.setAttribute(k, String(v));
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function fmt(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\*([^*]+)\*/g, '<i>$1</i>');
  }

  // ── layer definitions ───────────────────────────────────────────────────

  const LAYERS = [
    { id: 'instructions', label: 'INSTRUCTION STACK', sub: 'How Horst\'s mind is assembled — these merge into every prompt', y: 28, h: 240,
      tip: 'The instruction layer. Genome (constitutional law), Persona (chat identity), Directives (user standing orders), and Brain Context (live knowledge tasters) are merged by `buildSystemPrompt()` before every AI call. The genome outranks everything; directives outrank persona; brain context is the freshest layer.' },
    { id: 'inputs', label: 'INPUT SOURCES', sub: 'What triggers Horst to act', y: 298, h: 140,
      tip: 'Five input channels. Chat is synchronous (user-initiated). Email, events, and webhooks are asynchronous (arrive via handlers/bus). Cron is periodic (heartbeat every 15min, briefing daily at 7am). Every input eventually flows through the bus or directly into platform-horst.' },
    { id: 'core', label: 'PROCESSING CORE', sub: 'The central machinery that interprets input and produces action', y: 468, h: 230,
      tip: 'Three processing modules. **platform-horst** is the hub — everything passes through it. **horst-triage** handles email intelligence (5-stage AI pipeline). **horst-events** is the event bus connecting everything. There is no fourth: the autonomous work stack was deleted in phase 8F, because nothing was ever routed into it.' },
    { id: 'governance', label: 'GOVERNANCE & DECISION', sub: 'Nothing outward-facing happens without passing through here', y: 728, h: 145,
      tip: 'The approval plane. Every action Horst wants to take becomes a proposal with a frozen payload. Autonomy dials control how much Horst can do on his own — but hard ceilings ensure outward-facing actions (email, telegram, calendar delete) always need human approval. Prior-action checks prevent duplicate work. The decision ledger records everything permanently.' },
    { id: 'knowledge', label: 'KNOWLEDGE & SELF-EXTENSION', sub: 'Brains, goals, documents, and self-modification', y: 903, h: 145,
      tip: 'Three knowledge modules. **Brain registry** manages 5 brains with push tasters (capped at 1600B total) and pull tools. **Missions** track standing goals and run their own cadence reviews. **Artifacts** file documents. Self-modification is not here: Horst never writes into an app directory (G7), and the request queue that once drafted such changes was deleted unused in phase 8F.' },
    { id: 'storage', label: 'STORAGE', sub: 'All persistence — .horst/ files, database, cron config', y: 1078, h: 240,
      tip: 'Everything Horst knows and decides is persisted here. Files in `.horst/` use ring buffers (capped arrays) or append-only JSONL. The database stores artifact indexes. Cron config survives restarts. No state lives only in memory — GUI reload never loses work.' },
    { id: 'external', label: 'EXTERNAL SYSTEMS', sub: 'Engines and services Horst integrates with', y: 1348, h: 145,
      tip: 'Platform engines and services that Horst calls through well-defined interfaces. Calendar and email are read/write (writes go through governance executors). Memory and tasks are direct calls. Telegram is the notification and approval-card channel. The bridge API is how apps extend Horst.' },
  ];

  // ── nodes ───────────────────────────────────────────────────────────────

  const NODES = [
    // ── Layer 1: Instructions ──
    { id: 'genome', label: 'Genome', sub: '10 genes · immutable', x: 55, y: 70, w: 200, h: 75, layer: 'instructions',
      tip: 'The constitutional law. 10 hardcoded genes (G1-G10) that outrank all directives and persona. **G1**: understanding is mandatory. **G9**: untrusted content never drives autonomous outward action (this is why `email.send` is pinned to propose). **G8**: changing a gene is propose-only forever. No write API — code changes only.' },
    { id: 'persona', label: 'Persona', sub: 'chat personality · markers', x: 285, y: 70, w: 200, h: 75, layer: 'instructions',
      tip: 'The chat system prompt (PERSONA constant in platform-horst.js). Defines Horst as "chief of staff and platform operator." Documents all markers: `<horst-directive>`, `<horst-remember>`, `<horst-propose>`, `<horst-todo>`, `<horst-mission>`. Lists all proposal kinds with payload schemas. {{REGISTERED_KINDS}} placeholder filled at prompt time with app-registered governance kinds.' },
    { id: 'directives', label: 'Directives', sub: 'user standing orders', x: 515, y: 70, w: 200, h: 75, layer: 'instructions',
      tip: 'Versioned standing orders in `.horst/directives.json`. Sequence counter, statuses: draft → pending → active → inactive. Origins: ui, chat, workshop. **Directive workshop** (`analyzeDirective()`): uses opus to restate, question, find edge cases, SWOT, check genome compliance, identify scope (chat/triage/briefing/planner/executor), deliver verdict. Active directives injected verbatim into every prompt.' },
    { id: 'brain-ctx', label: 'Brain Context', sub: '5 push tasters · 1600B cap', x: 745, y: 70, w: 200, h: 75, layer: 'instructions',
      tip: 'Push tasters from 5 registered brains, called during prompt assembly. **Missions** (order 5): active goals. **Memory** (order 10): 6 semantic recall hits. **Todos** (order 20): 5 due/open items. **Decisions** (order 30): approval/edit patterns. **Artifacts** (order 40): no push taster (facts surface through memory). Total capped at 1600 bytes — depth is through pull tools only.' },
    { id: 'build-prompt', label: 'buildSystemPrompt()', sub: 'merges all instructions into one prompt', x: 200, y: 195, w: 700, h: 50, layer: 'instructions', special: 'funnel',
      tip: 'The prompt assembly function (platform-horst.js). Merges in order: **Genome** (top, outranks all) + **Persona** + current date + platform status + **active directives** (formatted by `fmtDirectives()`) + **brain context** (memory recall, due todos, decision patterns, active missions). Called before every chat turn, briefing composition, and AI-driven operation.' },

    // ── Layer 2: Input Sources ──
    { id: 'chat-in', label: 'Chat', sub: 'Telegram + GUI', x: 55, y: 345, w: 170, h: 70, layer: 'inputs',
      tip: 'User-initiated messages. **Telegram**: `chatFromTelegram()` via platform-telegram.js — voice auto-transcribed, photos/documents ingested via artifact pipeline. **GUI**: `chatFromApp()` via the Horst chat panel. Both trigger: `buildSystemPrompt()` → AI call → `extractMarkers()` → proposals/todos/memories created from markers.' },
    { id: 'email-in', label: 'Email', sub: 'email:new handler', x: 265, y: 345, w: 170, h: 70, layer: 'inputs',
      tip: 'Email engine fires `email:new` for every new message. Horst registers a handler (`wireBusSources()`) that publishes each as a bus event. The bus routes it via `run-action` policy to the heartbeat handler, which triggers `triage.runSweep()` — classifying, extracting events, mining facts, staging proposals.' },
    { id: 'events-in', label: 'Events / Bus', sub: 'pub/sub · 5 policies', x: 475, y: 345, w: 170, h: 70, layer: 'inputs',
      tip: 'The event bus (horst-events.js). Sources: timer, email, app, tools, telegram, chat, webhook, system. **Guardrails**: 60/min rate limit per app-kind, storm collapse (8+ in 30s → fold to one digest), 16KB payload cap. **Policies**: ignore → agenda → notify → run-action. Three-tier catalog: platform → declared → discovered.' },
    { id: 'cron-in', label: 'Cron', sub: 'heartbeat 15m · briefing 7am', x: 685, y: 345, w: 170, h: 70, layer: 'inputs',
      tip: 'Two registered cron jobs via platform-cron.js. **Heartbeat** (every 15min): triage sweep, todo sweep (`sweepDue()`), mission review sweep, app health check, unread mail count. **Briefing** (7am daily): morning summary of unread email, today\'s calendar, todos, missions, apps, pending proposals. Both fire through the bus as timer events.' },
    { id: 'webhook-in', label: 'Webhooks', sub: 'external triggers', x: 885, y: 345, w: 170, h: 70, layer: 'inputs',
      tip: 'External HTTP triggers published as bus events (kind: `webhook`). Default policy: agenda (observation logged). Can be promoted to `notify` or `run-action` via policy overrides in events-policy.json. Payload capped at 16KB.' },

    // ── Layer 3: Processing Core ──
    { id: 'platform-horst', label: 'platform-horst.js', sub: 'the hub · 2697 lines', x: 55, y: 516, w: 490, h: 85, layer: 'core',
      tip: 'The central orchestrator — requires every other Horst module. **Chat pipeline**: `buildSystemPrompt()` → AI call via `appBridge.aiPrompt` → `extractMarkers()` → `createChatProposals()`. **Rituals**: heartbeat (triage + todos + missions + health) and briefing (morning summary). **API mount**: serves `/pro/horst/api/*`. **Bus wiring**: registers handlers for email:new, todo:changed, email:sent, calendar:changed, app lifecycle. **Persona**: the PERSONA constant that defines Horst\'s chat identity.' },
    { id: 'horst-events', label: 'horst-events.js', sub: 'the senses · 366 lines', x: 605, y: 516, w: 440, h: 85, layer: 'core',
      tip: 'The event bus — no Horst module dependencies (pure infrastructure). **Publish flow**: kind validation → rate limiting (60/min per app-kind) → catalog registration (auto-discovery) → storm collapse (8+ in 30s → fold) → payload capping (16KB) → policy routing. **Routing**: `ignore` → no-op, `agenda` → observation, `notify` → Telegram, `run-action` → dispatch handler. Four policies, and every one of them is a decision the rule already made — no model is consulted here. Audit ring: 2000 entries.' },
    { id: 'horst-triage', label: 'horst-triage.js', sub: 'email intelligence · 1255 lines', x: 55, y: 640, w: 990, h: 80, layer: 'core',
      tip: '5-stage email pipeline. **(1) Classify**: haiku/deepseek AI → category, importance 1-5, spamScore, needsReply, calendarEvents[], todos[]. `safeTriageModel()` clamps to haiku/deepseek only — opus never touches classification. **(2) Attachments**: relevance gate → PDF/image read → artifact filing. **(3) Mine**: contacts (headers) + content facts (AI) → `rememberBatch()`. **(4) Propose**: calendar.create and email.send through `governance.requestAction(checkFirst:true)`. **(5) Annotate**: `email-intel` annotation written LAST (restart-safe).' },

    // ── Layer 4: Governance ──
    { id: 'horst-governance', label: 'horst-governance.js', sub: 'approval plane · 1457 lines', x: 55, y: 775, w: 310, h: 85, layer: 'governance',
      tip: 'Every action becomes a **proposal** with a frozen payload (deep-cloned via `JSON.parse(JSON.stringify(payload))`). **Autonomy dials**: observe → propose → auto+notify → auto. **Hard ceilings** (cannot be raised): email.send, telegram.send, calendar.delete → pinned at propose. **`createProposal()`**: validates, deduplicates pending twins (by dedupeKey or `sameEventPayloads()`), freezes payload, generates ID, stores, broadcasts, sends Telegram approval card, schedules prior-action + brain checks. **`decide()`**: on approve → run kind executor, on deny → record + clear. **`requestAction()`**: consults dial, runs `preStageCheck()` if `checkFirst`, routes to observe/propose/auto.' },
    { id: 'horst-prior', label: 'horst-prior-action.js', sub: '5-layer dedup · 792 lines', x: 410, y: 775, w: 280, h: 85, layer: 'governance',
      tip: '**5 dedup layers**: (1) `dedupeKey` on pending proposals — same email+event index refreshes in place. (2) `decidedTwin()` — same derivation already approved OR denied (no is an answer). (3) `deniedEventInLedger()` — durable ledger match by day/time/title anchors, survives proposals.json TTL. (4) `runPriorCheck()` → `isSameEvent()` — queries actual Google Calendar with title similarity (Jaccard ≥ 0.75), **anchor tokens** (≥ 2 required, 4+ chars, multilingual stopwords — "Physiotherapy with Marta" won\'t match "Physiotherapy with Claudia"), time proximity (30min). (5) Auto-execution downgrade — duplicate → force to propose. **Partial match** → convert `calendar.create` to `calendar.update` with merged payload.' },
    { id: 'horst-decisions', label: 'horst-decisions.js', sub: 'decision ledger · 332 lines', x: 745, y: 775, w: 300, h: 85, layer: 'governance',
      tip: 'Append-only JSONL record of every proposal decision: approve, deny, expire, auto. Records: frozen payloads, user edit diffs, approval latency. **`promptBlock()`**: mechanical aggregates of past patterns per kind — injected into reply drafting prompts so Horst\'s drafts converge on the user\'s actual editing preferences. Survives `proposals.json` cap (300) and TTL (7 days). Rotates at ~2MB. `deniedEventInLedger()` queries this for past denials.' },

    // ── Layer 5: Knowledge ──
    { id: 'horst-brain', label: 'horst-brain.js', sub: 'brain registry · 256 lines', x: 55, y: 950, w: 310, h: 80, layer: 'knowledge',
      tip: '5 registered brains, uniform substrate. Each provides: **push taster** (injected into prompts, total ≤ 1600B — never scales with store size) + **pull tools** (semantic search on demand). Registration order: missions (5) → memory (10, 6 hits) → todos (20, 5 items) → decisions (30) → artifacts (40, no push taster). The governing invariant: depth is through pull tools only — tasters are cheap summaries.' },
    { id: 'horst-missions', label: 'horst-missions.js', sub: 'standing goals · 399 lines', x: 395, y: 950, w: 310, h: 80, layer: 'knowledge',
      tip: 'Standing objectives with cadence reviews and progress tracking. Seeds: "Memory curation" and "Self-review." **`sweepReviews()`**: triggered by heartbeat — an overdue mission runs `runReview()` right here (one opus call, no tools), which logs progress, notifies you, and raises up to 2 follow-ups as `todo.create` requests through governance. Registered as a brain (order 5) with push taster (active missions list) + `mission_list` / `mission_get` pull tools. Cap: 100 missions.' },
    { id: 'horst-artifacts', label: 'horst-artifacts.js', sub: 'filing cabinet · 325 lines', x: 735, y: 950, w: 310, h: 80, layer: 'knowledge',
      tip: 'Document ingestion pipeline: classify doc_type + extract structured fields + mine durable facts → memory. **DB index**: `memory_artifacts` table with fulltext search. **File storage**: Telegram uploads in `.horst/artifacts/<year>/`. Email attachments referenced by attachment key, not copied. Registered as a brain (order 40) — no push taster (facts surface through memory recall); pull tools: `artifact_search`, `artifact_get`.' },
  ];

  // ── storage nodes ───────────────────────────────────────────────────────

  const STORE_NODES = [
    { id: 's-proposals', label: 'proposals.json', sub: 'cap 300 · 7d TTL', x: 55, y: 1130, w: 180, h: 44,
      tip: 'Up to 300 pending/decided proposals with frozen payloads, prior-action verdicts, Telegram card references. Pending items expire after 7 days. Deduplication by `dedupeKey` or `sameEventPayloads()` refreshes existing entries rather than duplicating.' },
    { id: 's-decisions', label: 'decisions.jsonl', sub: 'append-only · ~2MB rotate', x: 260, y: 1130, w: 180, h: 44,
      tip: 'Durable decision ledger. Append-only JSONL. Every approve/deny/expire/auto with frozen payloads, user edit diffs, approval latency. Survives `proposals.json` cap and TTL — this is why `deniedEventInLedger()` can catch events denied months ago. Rotates at ~2MB.' },
    { id: 's-directives', label: 'directives.json', sub: 'seq counter · versioned', x: 465, y: 1130, w: 180, h: 44,
      tip: 'Standing orders with sequence counter. Each: text, status (draft/pending/active/inactive), origin (ui/chat/workshop), analysis (genome compliance check, scope identification, SWOT), version history with timestamps.' },
    { id: 's-settings', label: 'settings.json', sub: 'all config', x: 670, y: 1130, w: 180, h: 44,
      tip: 'All Horst settings: chatModel, briefingModel, triageModel, directiveModel, heartbeat/briefing schedules, feature flags (memoryMaintenance, etc.), spam thresholds, notification preferences.' },
    { id: 's-dials', label: 'dials.json', sub: 'autonomy overrides', x: 875, y: 1130, w: 180, h: 44,
      tip: 'User-set autonomy dial overrides per action kind. Defaults from each kind\'s `defaultLevel` (all default to propose). `clampLevel()` enforces hard ceilings — the UI greys out positions above the ceiling.' },

    { id: 's-missions', label: 'missions.json', sub: 'cap 100', x: 260, y: 1188, w: 180, h: 44,
      tip: 'Standing goals with progress logs, review cadence, seeds. Cap: 100 missions. Each has: title, description, status (active/paused/completed), review cadence, last review timestamp, progress entries.' },
    { id: 's-conversations', label: 'conversations/', sub: 'chat history', x: 465, y: 1188, w: 180, h: 44,
      tip: 'Conversation index (`conversations.json`) + individual conversation files (`conversations/<id>.json`). Each conversation stores up to 24 turns for AI context window. Conversations survive GUI reloads — state is server-side.' },
    { id: 's-agenda', label: 'agenda.json', sub: 'ring buffer · cap 400', x: 670, y: 1188, w: 180, h: 44,
      tip: 'Observation ring. App health reports, mail counts, calendar event notices, memory conflicts, bus event digests. Ring buffer capped at 400 entries — oldest entries drop when full.' },
    { id: 's-journal', label: 'journal.json', sub: 'ring buffer · cap 200', x: 875, y: 1188, w: 180, h: 44,
      tip: 'Briefings and longer narrative entries. Ring buffer capped at 200. Morning briefings stored here after AI composition. Each entry has timestamp, type, and content.' },

    { id: 's-audit', label: 'audit.json', sub: 'ring buffer · cap 500', x: 55, y: 1246, w: 180, h: 44,
      tip: 'Governance audit trail. Every proposed/executed/denied/observed/suppressed action and dial change recorded with timestamps, actor, and outcome. Ring buffer capped at 500.' },
    { id: 's-events-audit', label: 'events-audit.json', sub: 'ring buffer · cap 2000', x: 260, y: 1246, w: 180, h: 44,
      tip: 'Bus event audit trail. Every event published through the bus with: policy applied, outcome, trust level, correlation ID, source app. Ring buffer capped at 2000 — the largest ring in the system.' },
    { id: 's-events-catalog', label: 'events-catalog.json', sub: 'kind registry', x: 465, y: 1246, w: 180, h: 44,
      tip: 'Event kind catalog. Three tiers: platform (static, e.g. timer:heartbeat), declared (via `ctx.events.declare`), discovered (auto on first emit, default agenda policy). Per-app cap: 200 distinct kinds.' },
    { id: 's-spam', label: 'spam-sightings.json', sub: '14d window · cap 500', x: 670, y: 1246, w: 180, h: 44,
      tip: 'Rolling 14-day window of spam-classified senders. When sender count ≥ 3 or domain count ≥ 3 from ≥ 2 senders → `email.rule.add` proposal staged. Freemail providers (gmail, outlook, etc.) excluded from domain rules.' },
    { id: 's-artifacts-dir', label: 'artifacts/<year>/', sub: 'uploaded files', x: 875, y: 1246, w: 180, h: 44,
      tip: 'Uploaded documents from Telegram (photos, PDFs). Email attachments are referenced by attachment key, not copied here. Indexed in the `memory_artifacts` database table for fulltext search.' },

    { id: 's-requests', label: 'requests.json', sub: 'cap 200', x: 55, y: 1304, w: 180, h: 44,
      tip: 'Change-request queue. Draft prompts for app modifications, with git snapshot rail for safe rollback. Statuses: draft → proposed → running → landed → verified.' },
    { id: 's-events-policy', label: 'events-policy.json', sub: 'policy overrides', x: 260, y: 1304, w: 180, h: 44,
      tip: 'Per app-kind policy overrides. User can change any event kind\'s policy between: ignore, agenda, notify, run-action. Overrides the default and discovered policies.' },
    { id: 's-db', label: 'memory_artifacts', sub: 'MySQL table', x: 465, y: 1304, w: 180, h: 44, special: 'db',
      tip: 'Database index for filed artifacts. Columns: doc_type, structured fields extracted by AI, file_ref, fulltext search index. Lives in the `vc_platform_memory` MySQL database. Queried by `artifact_search` and `artifact_get` brain tools.' },
    { id: 's-cron', label: '.platform-cron.json', sub: 'cron schedules', x: 670, y: 1304, w: 180, h: 44,
      tip: 'Persistent cron configuration. Includes `horst:heartbeat` (every 15min) and `horst:briefing` (`0 7 * * *`). Per-app jobs carry `appName` and survive server restarts. Jobs auto-removed when an app is deleted (not on stop).' },
  ];

  // ── external system nodes ───────────────────────────────────────────────

  const EXT_NODES = [
    { id: 'ext-calendar', label: 'Calendar Engine', sub: 'Google Calendar sync', x: 55, y: 1395, w: 230, h: 55,
      tip: 'calendar-engine.js — Google Calendar sync. **Read**: `listEvents`, `getEvent`, `calendarAccounts`, `defaultCalendar`. **Write** (via governance executors): `createEvent`, `updateEvent`, `deleteEvent`. Also queried by prior-action\'s `isSameEvent()` for duplicate detection against the real calendar.' },
    { id: 'ext-email', label: 'Email Engine', sub: 'IMAP / SMTP', x: 315, y: 1395, w: 230, h: 55,
      tip: 'email-engine.js — IMAP/SMTP. **Read**: `listEmails`, `getEmail`, `folderCounts`, `attachment`, `listSent`, `listLabels`. **Write** (via governance): `send`, `modify`, `addRule`, `applyRules`. **Handlers**: `email:new`, `todo:changed`, `email:sent`, `calendar:changed`. **Annotations**: `annotate` writes `email-intel` classification results. Rule matching: `matchesSenderRules`.' },
    { id: 'ext-memory', label: 'Memory Service', sub: 'semantic + fulltext search', x: 575, y: 1395, w: 230, h: 55,
      tip: 'memory-service.js — hybrid search. **Write**: `remember` / `rememberBatch` (scope: private or shared). **Read**: `recall` (semantic embedding + MySQL fulltext), `entities` (entity browsing), `history` (provenance chains), `counts`. Used by: triage (fact mining via `rememberBatch`), brain registry (push tasters via `recall`), artifacts (fact extraction).' },
    { id: 'ext-tasks', label: 'Tasks Engine', sub: 'todos & reminders', x: 835, y: 1395, w: 220, h: 55,
      tip: 'tasks-engine.js — todo management. `create` / `list` / `complete` / `snooze` / `reopen` / `remove`. **`sweepDue`**: heartbeat-triggered scanning → publishes `todo:due` bus events for overdue tasks. `similar`: find duplicate/similar todos to avoid redundancy. Used by brain registry (push tasters + `todo_list` pull tool).' },
    { id: 'ext-telegram', label: 'Telegram', sub: 'chat + approval cards + TTS', x: 55, y: 1465, w: 230, h: 55,
      tip: 'telegram.js + platform-telegram.js. **Chat**: free-text → `chatFromTelegram()`. **Media**: voice → transcribe, photo/document → artifact pipeline (`enrichTelegramMedia()`). **Approval cards**: proposals sent with Approve/Deny inline keyboard buttons (`horst_prop:<id>:approve/deny`). **Notifications**: todo nudges (Done/Snooze), briefing push, urgent emails (importance ≥ 5). **TTS**: spoken replies via `speakReply()` (ash voice, gpt-4o-mini-tts). Control bot key: `__platform__`.' },
    { id: 'ext-bridge', label: 'Bridge API', sub: 'app interface · ctx.*', x: 315, y: 1465, w: 230, h: 55,
      tip: 'app-bridge.js — how apps interact with Horst. **Ops**: `horst.briefing` (get latest briefing), `horst.chat` (route chat through Horst), `email.reclassify` (deep reclassify). **Extension**: `ctx.governance.registerKind` (apps register namespaced kinds, capped at propose), `ctx.governance.requestAction` (apps stage actions), `ctx.events.publish` / `ctx.events.declare` (apps publish/declare event kinds).' },
    { id: 'ext-appmanager', label: 'App Manager', sub: 'app lifecycle', x: 575, y: 1465, w: 230, h: 55,
      tip: 'app-manager.js — app lifecycle. Horst monitors: `app:started`, `app:stopped`, `app:failed` events (published via `broadcaster.onBroadcast`). Governance executors for `app.restart` / `app.start` / `app.stop` (ceiling: auto+notify). The capability digest is built from the installed apps (reads APP.md first paragraph for each). `appRuntime()` resolves app placement (in-process/own-process).' },
    { id: 'ext-cron', label: 'Platform Cron', sub: 'persistent scheduler', x: 835, y: 1465, w: 220, h: 55,
      tip: 'platform-cron.js — the one persistent scheduler. Horst registers: `horst:heartbeat` (15min) and `horst:briefing` (7am). Jobs fire as bus events via internal handlers. Per-app jobs carry `appName`, survive restarts, emit `cron:result` as `app:bridge:event`. Jobs removed on app **delete** (not stop). Config in `.platform-cron.json`.' },
  ];

  // ── edges ───────────────────────────────────────────────────────────────
  // Types: merge (grey dashed), chat (orange), event (blue), cron (green),
  //        governance (red), callback (purple), dep (grey thin)

  const EDGES = [
    // Instruction merging
    { from: 'genome', to: 'build-prompt', type: 'merge', label: 'genes',
      tip: 'The 10 genome genes injected at the top of every system prompt, outranking all other instructions. Hardcoded — no write API.' },
    { from: 'persona', to: 'build-prompt', type: 'merge', label: 'identity',
      tip: 'Chat personality, marker grammar, and proposal kind schemas — the identity layer that tells the model who Horst is and what markers it may emit.' },
    { from: 'directives', to: 'build-prompt', type: 'merge', label: 'active orders',
      tip: 'All directives with status=active, formatted by `fmtDirectives()` and injected verbatim. Outrank persona but are outranked by genome.' },
    { from: 'brain-ctx', to: 'build-prompt', type: 'merge', label: 'live tasters',
      tip: 'Push tasters from 5 brains (total ≤ 1600B): semantic memory recall, due/open todos, decision patterns, active missions. Gives Horst live awareness without tool calls.' },

    // Chat trigger path
    { from: 'chat-in', to: 'platform-horst', type: 'chat', label: 'user message',
      tip: '`chatFromTelegram()` or `chatFromApp()` → conversation lookup → `buildSystemPrompt()` → AI call (`appBridge.aiPrompt`) → `extractMarkers()` → proposals, todos, memories, directives created from `<horst-*>` markers in the AI response.' },
    { from: 'build-prompt', to: 'platform-horst', type: 'chat', label: 'system prompt',
      tip: 'The assembled system prompt feeds into every AI call. `runChat()` calls `buildSystemPrompt(userText)` to get the complete prompt, then passes it to the model.' },

    // Event trigger path
    { from: 'email-in', to: 'horst-events', type: 'event', label: 'email:new',
      tip: 'Email engine fires `email:new` → registered handler in `wireBusSources()` publishes to the bus → routed via `run-action` policy to heartbeat handler → triggers `triage.runSweep()` on next cycle.' },
    { from: 'events-in', to: 'horst-events', type: 'event', label: 'all sources',
      tip: 'All event sources (timer, email, app, tools, webhook, system) publish through the bus. Rate-limited, storm-collapsed, policy-routed to their destination.' },
    { from: 'horst-events', to: 'platform-horst', type: 'event', label: 'run-action dispatch',
      tip: 'Events with `run-action` policy → `busRuleActions().run()` in platform-horst — dispatches to: heartbeat handler, briefing handler, triage trigger, todo-nudge, digest-refresh.' },

    // Cron trigger path
    { from: 'cron-in', to: 'platform-horst', type: 'cron', label: 'timer events',
      tip: 'Cron fires → internal handler emits bus event (`timer:heartbeat` or `timer:briefing`) → bus routes via `run-action` → `busRuleActions().run()` dispatches the actual work.' },

    // Webhook path
    { from: 'webhook-in', to: 'horst-events', type: 'event', label: 'webhook event',
      tip: 'External HTTP triggers → bus event (kind: `webhook`). Default policy: `agenda`. Can be promoted to `notify` or `run-action` via policy overrides.' },

    // Hub distribution
    { from: 'platform-horst', to: 'horst-triage', type: 'dep', label: 'runSweep()',
      tip: 'Heartbeat triggers `triage.runSweep()`: classify new emails batch-by-account, extract events, mine facts, stage proposals. Only emails without `email-intel` annotation are processed.' },
    { from: 'platform-horst', to: 'horst-governance', type: 'chat', label: 'createChatProposals()',
      tip: 'Chat-originated proposals: `extractMarkers()` finds `<horst-propose>` markers → `governance.createProposal()` directly. These skip `checkFirst` — the user asked for them explicitly.' },

    // Triage → governance (the email→calendar/reply pipeline)
    { from: 'horst-triage', to: 'horst-governance', type: 'governance', label: 'requestAction(checkFirst)',
      tip: '`governance.requestAction("calendar.create", payload, { checkFirst: true })` — triage stages calendar and reply proposals through governance. `checkFirst:true` triggers the full 5-layer dedup gauntlet **before** any proposal is created.' },

    // Governance internal flow
    { from: 'horst-governance', to: 'horst-prior', type: 'governance', label: 'preStageCheck()',
      tip: '3 checks before staging: (1) `decidedTwin()` — same derivation already approved/denied. (2) `deniedEventInLedger()` — durable ledger match by day/time/anchors. (3) `runPriorCheck()` → actual calendar world check. If done with no enrichments → silently suppressed (`action:"suppressed"` audit row, no proposal created).' },
    { from: 'horst-governance', to: 'horst-decisions', type: 'governance', label: 'recordDecision()',
      tip: 'Every approve/deny/expire/auto → append to `decisions.jsonl` with frozen payload, user edits (if modified before approving), approval latency. Generates `promptBlock()` — mechanical aggregates injected into reply drafting.' },

    // Knowledge feedback loop (upward!)
    { from: 'horst-brain', to: 'brain-ctx', type: 'callback', label: 'push tasters ↑',
      tip: 'The feedback loop: brain registry feeds push tasters **upward** into Brain Context → `buildSystemPrompt()`. Stored knowledge (memory facts, due todos, decision patterns, active missions) surfaces automatically in every prompt without tool calls.' },
    { from: 'horst-governance', to: 'horst-brain', type: 'callback', label: 'scheduleBrainCheck()',
      tip: 'After staging a proposal, governance schedules a brain check — queries all registered brains for relevant context (related memories, similar todos, past decisions) and annotates the proposal card. Async, does not block staging.' },
    { from: 'horst-missions', to: 'horst-governance', type: 'governance', label: 'todo.create follow-ups',
      tip: 'A mission review that finds concrete next steps raises them as `todo.create` requests with `checkFirst: true`, capped at 2 per review. The kind\'s identity dedup means a review that fires twice about the same thing produces one todo, not two — the follow-up reaches your list rather than a queue nothing drained.' },

    // External system connections
    { from: 'horst-governance', to: 'ext-calendar', type: 'dep', label: 'create / update / delete',
      tip: 'Governance **executors** call calendar-engine.js: `createEvent()`, `updateEvent()`, `deleteEvent()` when a calendar proposal is approved. The frozen payload is passed directly — what you approved is exactly what runs.' },
    { from: 'horst-prior', to: 'ext-calendar', type: 'dep', label: 'listEvents (dedup)',
      tip: 'Prior-action checker queries the actual Google Calendar: `isSameEvent()` compares proposed events against existing ones using title similarity (Jaccard), anchor tokens (≥ 2), and time proximity (30min window).' },
    { from: 'horst-governance', to: 'ext-email', type: 'dep', label: 'send / modify / addRule',
      tip: 'Governance executors call email-engine.js: `send()`, `modify()`, `addRule()` when email proposals are approved.' },
    { from: 'horst-triage', to: 'ext-email', type: 'dep', label: 'annotate(email-intel)',
      tip: 'Triage writes the `email-intel` annotation LAST (stage 5) — after all pipeline stages complete. This is the restart-safety mechanism: if triage crashes mid-pipeline, the email has no annotation and will be re-processed on next sweep.' },
    { from: 'platform-horst', to: 'ext-telegram', type: 'dep', label: 'cards · notifications · TTS',
      tip: 'Approval cards with Approve/Deny inline keyboards. Todo nudges with Done/Snooze. Briefing push. Urgent email alerts (importance ≥ 5). TTS replies (`speakReply()`, ash voice). Control bot key: `__platform__`.' },
    { from: 'horst-brain', to: 'ext-memory', type: 'dep', label: 'recall()',
      tip: 'Brain push tasters query `memory-service.js` `recall()` — hybrid semantic (embedding cosine similarity) + fulltext (MySQL MATCH AGAINST) search. Pull tools also provided for on-demand deeper search.' },
    { from: 'horst-triage', to: 'ext-memory', type: 'dep', label: 'rememberBatch()',
      tip: 'Triage stage 3 (Mine): contacts extracted from email headers + content facts extracted by AI → `rememberBatch()` with `scope:shared` into platform memory.' },
    { from: 'platform-horst', to: 'ext-tasks', type: 'dep', label: 'sweepDue()',
      tip: 'Heartbeat calls `tasks-engine.sweepDue()` → finds overdue todos → publishes `todo:due` bus events, which trigger Telegram nudge notifications.' },
    { from: 'ext-bridge', to: 'horst-governance', type: 'dep', label: 'registerKind / requestAction',
      tip: 'Apps extend Horst through the bridge: `ctx.governance.registerKind()` adds namespaced action kinds (always capped at `propose`), `ctx.governance.requestAction()` stages proposals from app logic.' },
  ];

  // ── build the lookup ────────────────────────────────────────────────────

  function nodeById() {
    const map = new Map();
    for (const n of NODES) map.set(n.id, n);
    for (const n of STORE_NODES) map.set(n.id, n);
    for (const n of EXT_NODES) map.set(n.id, n);
    return map;
  }

  // ── tooltip ─────────────────────────────────────────────────────────────

  function makeTip(host) {
    const tip = document.createElement('div');
    tip.className = 'arch-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    host.appendChild(tip);
    let anchor = null;

    function place(x, y) {
      tip.style.left = '0px';
      tip.style.top = '0px';
      const r = tip.getBoundingClientRect();
      const pad = 10;
      let left = x + 16;
      let top = y + 16;
      if (left + r.width > window.innerWidth - pad) left = x - r.width - 16;
      if (top + r.height > window.innerHeight - pad) top = y - r.height - 16;
      tip.style.left = `${Math.max(pad, left)}px`;
      tip.style.top = `${Math.max(pad, top)}px`;
    }

    function show(target, spec, ev) {
      anchor = target;
      tip.innerHTML = tipContent(spec);
      tip.hidden = false;
      if (ev && typeof ev.clientX === 'number' && ev.clientX) place(ev.clientX, ev.clientY);
      else {
        const r = target.getBoundingClientRect();
        place(r.left + r.width / 2, r.bottom - 8);
      }
    }

    function hide(target) {
      if (target && anchor !== target) return;
      anchor = null;
      tip.hidden = true;
    }

    function bind(target, spec) {
      target.addEventListener('mouseenter', (ev) => show(target, spec, ev));
      target.addEventListener('mousemove', (ev) => { if (anchor === target) place(ev.clientX, ev.clientY); });
      target.addEventListener('mouseleave', () => hide(target));
      target.addEventListener('focus', () => show(target, spec));
      target.addEventListener('blur', () => hide(target));
    }

    return { bind, hide: () => hide() };
  }

  function tipContent({ kicker, title, body }) {
    return `<div class="arch-tip-kicker">${esc(kicker)}</div>`
      + `<div class="arch-tip-title">${esc(title)}</div>`
      + `<div class="arch-tip-body">${fmt(body)}</div>`;
  }

  // ── edge path routing ───────────────────────────────────────────────────

  function edgePath(a, b) {
    // Downward: leave bottom-center, enter top-center with a smooth bezier
    if (b.y > a.y + a.h) {
      const x1 = a.x + a.w / 2;
      const y1 = a.y + a.h;
      const x2 = b.x + b.w / 2;
      const y2 = b.y;
      const dy = (y2 - y1) * 0.45;
      return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
    }
    // Upward (feedback loops): leave right side, curve up, enter top
    if (b.y + b.h < a.y) {
      const x1 = a.x + a.w;
      const y1 = a.y + a.h / 2;
      const x2 = b.x + b.w / 2;
      const y2 = b.y + b.h;
      const bow = 60;
      return `M ${x1} ${y1} C ${x1 + bow} ${y1}, ${x2 + bow} ${y2 + bow}, ${x2} ${y2}`;
    }
    // Same layer: horizontal bezier
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const mid = x1 + (x2 - x1) / 2;
    return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
  }

  // ── edge label placement ────────────────────────────────────────────────

  function labelPos(a, b) {
    const x1 = a.x + a.w / 2;
    const y1 = a.y + a.h;
    const x2 = b.x + b.w / 2;
    const y2 = b.y;
    return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  }

  // ── type → CSS class + stroke color ─────────────────────────────────────

  const TYPE_CLASSES = {
    merge: 'arch-edge merge',
    chat: 'arch-edge chat',
    event: 'arch-edge event',
    cron: 'arch-edge cron',
    governance: 'arch-edge governance',
    callback: 'arch-edge callback',
    dep: 'arch-edge dep',
  };

  const TYPE_LABELS = {
    merge: 'merges into',
    chat: 'chat trigger',
    event: 'event trigger',
    cron: 'cron trigger',
    governance: 'governance flow',
    callback: 'internal callback',
    dep: 'dependency',
  };

  // ── render ──────────────────────────────────────────────────────────────

  function render(host) {
    host.innerHTML = '';

    const svg = el('svg', {
      class: 'harch', viewBox: `0 0 ${W} ${H}`, width: W, height: H,
      preserveAspectRatio: 'xMidYMid meet', role: 'group',
      'aria-label': 'Architectural blueprint of Horst\'s modules',
    }, host);

    const tip = makeTip(host);
    svg.addEventListener('mouseleave', () => tip.hide());
    host.closest('.arch-wrap')?.addEventListener('scroll', () => tip.hide(), { passive: true });

    // Defs: arrow markers per type
    const defs = el('defs', {}, svg);
    for (const type of ['merge', 'chat', 'event', 'cron', 'governance', 'callback', 'dep']) {
      const marker = el('marker', {
        id: `arch-arrow-${type}`, viewBox: '0 0 8 8', refX: 7, refY: 4,
        markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
      }, defs);
      el('path', { d: 'M 0 0 L 8 4 L 0 8 z', class: `arch-arrowhead ${type}` }, marker);
    }

    const byId = nodeById();
    const gLayers = el('g', { class: 'arch-layers' }, svg);
    const gEdges = el('g', { class: 'arch-edges' }, svg);
    const gNodes = el('g', { class: 'arch-nodes' }, svg);

    // ── layer bands ─────────────────────────────────────────────────────
    for (const layer of LAYERS) {
      const g = el('g', { class: 'arch-layer' }, gLayers);

      // Background band
      el('rect', {
        x: 30, y: layer.y, width: W - 60, height: layer.h,
        rx: 10, class: 'arch-layer-bg',
      }, g);

      // Layer header
      el('text', { x: 50, y: layer.y + 18, class: 'arch-layer-label' }, g).textContent = layer.label;
      const subEl = el('text', { x: 50, y: layer.y + 31, class: 'arch-layer-sub' }, g);
      subEl.textContent = layer.sub;

      // Tooltip on the header area — bind to an invisible rect for a bigger target
      const hitArea = el('rect', {
        x: 30, y: layer.y, width: W - 60, height: 36,
        class: 'arch-layer-hit', fill: 'transparent', cursor: 'help',
      }, g);
      tip.bind(hitArea, { kicker: 'LAYER', title: layer.label, body: layer.tip });
    }

    // ── edges (behind nodes) ────────────────────────────────────────────
    for (const edge of EDGES) {
      const a = byId.get(edge.from);
      const b = byId.get(edge.to);
      if (!a || !b) continue;

      const cls = TYPE_CLASSES[edge.type] || 'arch-edge dep';
      const d = edgePath(a, b);

      // Visible edge line
      const path = el('path', {
        d, class: cls,
        'marker-end': `url(#arch-arrow-${edge.type})`,
      }, gEdges);

      // Fat invisible hover target
      const hitPath = el('path', {
        d, class: 'arch-edge-hit',
        fill: 'none', stroke: 'transparent', 'stroke-width': 14,
        cursor: 'help',
      }, gEdges);

      tip.bind(hitPath, {
        kicker: TYPE_LABELS[edge.type] || edge.type,
        title: edge.label,
        body: edge.tip,
      });

      // Small label along the path
      if (edge.label && edge.type !== 'dep' && edge.type !== 'merge') {
        const pos = labelPos(a, b);
        const lbl = el('text', {
          x: pos.x, y: pos.y - 4,
          class: `arch-edge-label ${edge.type}`,
          'text-anchor': 'middle',
        }, gEdges);
        lbl.textContent = edge.label;
      }
    }

    // ── module nodes ────────────────────────────────────────────────────
    for (const node of NODES) {
      renderNode(gNodes, node, tip, 'module');
    }

    // ── storage nodes ───────────────────────────────────────────────────
    for (const node of STORE_NODES) {
      renderNode(gNodes, node, tip, 'storage');
    }

    // ── external system nodes ───────────────────────────────────────────
    for (const node of EXT_NODES) {
      renderNode(gNodes, node, tip, 'external');
    }

    return { svg, tip, zoom: 1.0, host };
  }

  function renderNode(parent, node, tip, kind) {
    const g = el('g', {
      class: `arch-node ${kind}${node.special === 'funnel' ? ' funnel' : ''}${node.special === 'db' ? ' db' : ''}`,
      tabindex: 0,
    }, parent);

    // Box
    el('rect', {
      x: node.x, y: node.y, width: node.w, height: node.h,
      rx: kind === 'storage' ? 5 : 8,
      class: 'arch-box',
    }, g);

    // Label
    const labelY = node.h > 55 ? node.y + 22 : node.y + 18;
    el('text', {
      x: node.x + 10, y: labelY,
      class: 'arch-label',
    }, g).textContent = node.label;

    // Subtitle
    if (node.sub) {
      const subY = node.h > 55 ? node.y + 38 : node.y + 33;
      el('text', {
        x: node.x + 10, y: subY,
        class: 'arch-sub',
      }, g).textContent = node.sub;
    }

    // Line count badge (for modules with lines)
    if (node.lines) {
      const badgeX = node.x + node.w - 12;
      const badgeY = node.y + 22;
      el('text', {
        x: badgeX, y: badgeY,
        class: 'arch-lines', 'text-anchor': 'end',
      }, g).textContent = `${node.lines} lines`;
    }

    // Layer-specific icons
    if (node.special === 'db') {
      el('text', {
        x: node.x + node.w - 14, y: node.y + node.h - 8,
        class: 'arch-icon', 'text-anchor': 'end',
      }, g).textContent = '⛁';
    }
    if (node.special === 'funnel') {
      el('text', {
        x: node.x + node.w - 14, y: node.y + 18,
        class: 'arch-icon', 'text-anchor': 'end',
      }, g).textContent = '⊳';
    }

    // Tooltip
    const kicker = kind === 'storage' ? 'STORAGE' : kind === 'external' ? 'EXTERNAL' : node.layer?.toUpperCase() || 'MODULE';
    tip.bind(g, { kicker, title: node.label, body: node.tip });
  }

  // ── zoom ────────────────────────────────────────────────────────────────

  const ZOOM_MIN = 0.35;
  const ZOOM_MAX = 2.5;

  function setZoom(ctx, z) {
    z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    ctx.zoom = z;
    ctx.svg.setAttribute('width', W * z);
    ctx.svg.setAttribute('height', H * z);
  }

  function fitZoom(ctx) {
    const wrap = ctx.host.closest('.arch-wrap');
    if (!wrap) return;
    const z = wrap.clientWidth / W;
    setZoom(ctx, z);
  }

  // ── export ──────────────────────────────────────────────────────────────

  window.HorstArch = { render, fitZoom, setZoom, W, H, ZOOM_MIN, ZOOM_MAX, LAYERS };
})();
