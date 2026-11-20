// Horst system map — one live SVG of everything Horst is and does.
//
// Why this exists: Horst's parts were only visible as nine separate tabs of
// logs, so nobody could see that they form a single pipeline — or that half of
// it has never carried a single event. This draws the whole thing, animates it
// with real WebSocket traffic, and is honest about the cold paths.
//
// The graph is declared as data (NODES + EDGES) and rendered to SVG, so node
// counts, cold-path marking and drill-through targets all come from
// /pro/horst/api/map rather than being baked into markup.
//
// Node states:
//   cold   — never carried anything: dashed, dimmed, "never used" badge
//   idle   — has traffic, nothing happening right now
//   active — hit within the last couple of seconds: glow ring + pulse
//
// Hovering explains: NODE_INFO says what a box is, EDGE_INFO says what it takes
// for anything to travel an arrow, and AI_CALLS marks the boxes where a model
// is actually called (✦n beside the count) with its model, tool grant and
// session behaviour. Those three blocks are the only place the copy lives.
//
// The picture is a panorama in three sections, side by side:
//   pipeline  — senses → bus → branches → work → approvals
//   memory    — remember() → consolidate → facts, and recall's two search paths
//   ctx.*     — terminal boxes for everything an app can reach
// It is far wider than any screen and scrolls rather than scaling down; ⌗ marks
// the one place text is tokenized, ⬡ the places a vector search happens.
(function () {
  'use strict';

  // Panorama: the picture is far wider than any screen and scrolls horizontally
  // rather than being scaled down to illegibility. Three sections sit side by
  // side — the event pipeline, the memory engine, and the ctx surface apps get.
  const W = 4440;
  const H = 766;

  const SECTIONS = [
    { id: 'pipeline', label: 'Pipeline', x: 0 },
    { id: 'memory', label: 'Memory', x: 1200 },
    { id: 'apps', label: 'App surface', x: 2510 },
    { id: 'brains', label: 'Brains', x: 3560 },
  ];

  // Long-haul edges run along gutters beneath everything else so they never cut
  // through a box. Five depths, assigned so no two share a gutter over the same
  // horizontal span.
  const GUTTERS = [596, 620, 644, 668, 692, 706, 718, 730];

  // --- graph ---------------------------------------------------------------
  // col/row are laid out in absolute svg units; `drill` is where a click goes.

  // The ctx surface, grouped the way an app author thinks about it. Five
  // columns of terminal boxes — nothing flows out of them; they are the edge of
  // the platform. Laid out by ctxGrid() so adding one is a one-line change.
  const CTX_COLUMNS = [
    { label: 'STORE', items: [
      ['ctx.dbQuery', 'own database'], ['ctx.settings', ''], ['ctx.files', ''],
      ['ctx.jobs', 'reload-resilient'], ['ctx.memory', '→ this map'], ['ctx.embed', '→ the embedder', { vec: true }],
    ] },
    { label: 'AI', items: [
      ['ctx.aiPrompt', ''], ['ctx.transcribe', ''], ['ctx.tts', ''],
      ['ctx.image', ''], ['ctx.translate', ''], ['ctx.webSearch', ''],
    ] },
    { label: 'WORLD', items: [
      ['ctx.route', '+ geocode · places'], ['ctx.music', ''], ['ctx.browser', ''],
      ['ctx.googleAuth', ''], ['ctx.emailAccounts', ''], ['ctx.identity', ''],
    ] },
    { label: 'COMMS', items: [
      ['ctx.email', ''], ['ctx.calendar', ''], ['ctx.telegram', ''],
      ['ctx.whatsapp', ''], ['ctx.sse', ''], ['ctx.notify', ''],
      ['ctx.todos', '→ the todo brain'],
    ] },
    { label: 'PLATFORM', items: [
      ['ctx.events', '→ the bus'], ['ctx.governance', '→ approvals'], ['ctx.horst', ''],
      ['ctx.registerTools', ''], ['ctx.tools', ''], ['ctx.broadcaster', ''],
    ] },
  ];

  const CTX_X = 2560;
  const CTX_Y = 200;
  const CTX_COL = 186;
  const CTX_ROW = 42;

  function ctxGrid() {
    const out = [];
    CTX_COLUMNS.forEach((col, ci) => {
      col.items.forEach(([id, sub, marks], ri) => {
        out.push({
          id, kind: 'ctx', label: id, sub: sub || null, marks: marks || null,
          x: CTX_X + ci * CTX_COL, y: CTX_Y + ri * CTX_ROW, w: 168, h: 32,
        });
      });
    });
    return out;
  }

  const NODES = [
    // sources
    { id: 'src:timer', x: 70, y: 90, w: 150, h: 52, label: 'Timers', icon: '⏱', kind: 'source', sub: 'heartbeat · briefing', drill: { view: 'timeline', filter: { source: 'timer' } } },
    { id: 'src:email', x: 70, y: 158, w: 150, h: 52, label: 'Mail', icon: '✉', kind: 'source', sub: 'new mail arrives', trust: 'untrusted', drill: { view: 'timeline', filter: { source: 'email' } } },
    { id: 'src:app', x: 70, y: 226, w: 150, h: 52, label: 'Apps', icon: '▣', kind: 'source', sub: 'start · stop · crash', drill: { view: 'timeline', filter: { source: 'app' } } },
    { id: 'src:tools', x: 70, y: 294, w: 150, h: 52, label: 'Tools', icon: '🔧', kind: 'source', sub: 'capabilities changed', drill: { view: 'timeline', filter: { source: 'tools' } } },
    { id: 'src:webhook', x: 70, y: 362, w: 150, h: 52, label: 'Webhooks', icon: '🌐', kind: 'source', sub: 'inbound hooks', drill: { view: 'timeline', filter: { source: 'webhook' } } },

    // the router
    { id: 'bus', x: 300, y: 158, w: 158, h: 188, label: 'The bus', icon: '◉', kind: 'router', sub: 'one policy per app × kind', drill: { view: 'triggers' } },

    // policy branches
    { id: 'pol:ignore', x: 540, y: 62, w: 178, h: 46, label: 'Ignore it', icon: '✕', kind: 'policy', policy: 'ignore', drill: { view: 'timeline', filter: { policy: 'ignore' } } },
    { id: 'pol:agenda', x: 540, y: 124, w: 178, h: 46, label: 'Just note it', icon: '▪', kind: 'policy', policy: 'agenda', drill: { view: 'timeline', filter: { policy: 'agenda' } } },
    { id: 'pol:notify', x: 540, y: 186, w: 178, h: 46, label: 'Ping me', icon: '🔔', kind: 'policy', policy: 'notify', drill: { view: 'timeline', filter: { policy: 'notify' } } },
    { id: 'pol:run', x: 540, y: 248, w: 178, h: 46, label: 'Run the routine', icon: '⚙', kind: 'policy', policy: 'run-action', drill: { view: 'timeline', filter: { policy: 'run-action' } } },

    // what the routines actually are
    { id: 'run:heartbeat', x: 762, y: 210, w: 128, h: 34, label: 'heartbeat', kind: 'routine', routine: 'heartbeat' },
    { id: 'run:briefing', x: 762, y: 250, w: 128, h: 34, label: 'briefing', kind: 'routine', routine: 'briefing', drill: { view: 'timeline', filter: { stream: 'journal' } } },
    { id: 'run:triage', x: 762, y: 170, w: 128, h: 34, label: 'email triage', kind: 'routine', routine: 'triage', accent: true },
    { id: 'run:digest', x: 762, y: 290, w: 128, h: 34, label: 'digest refresh', kind: 'routine', routine: 'digest-refresh' },

    // chat bypasses the bus entirely — an important truth to show
    { id: 'chat', x: 70, y: 500, w: 150, h: 54, label: 'You, in chat', icon: '💬', kind: 'source', sub: 'bypasses the bus', drill: { view: 'chat' } },

    // the approval plane
    { id: 'approvals', x: 960, y: 300, w: 158, h: 62, label: 'Approvals', icon: '🛡', kind: 'gate', sub: 'frozen payloads', drill: { view: 'approvals' } },
    { id: 'you', x: 960, y: 400, w: 158, h: 52, label: 'You decide', icon: '👤', kind: 'owner', drill: { view: 'approvals' } },
    { id: 'done', x: 960, y: 476, w: 158, h: 46, label: 'Executed', icon: '✅', kind: 'done' },

    // directives steer everything
    { id: 'directives', x: 300, y: 500, w: 158, h: 54, label: 'Directives', icon: '⚖', kind: 'law', sub: 'injected everywhere', drill: { view: 'directives' } },

    // --- the memory engine -------------------------------------------------
    // Column A is the write path (top-down), column B the store, then the read
    // path runs left-to-right across the top. Laid out so no edge crosses a box.
    { id: 'mem:obs', x: 1240, y: 96, w: 180, h: 56, label: 'Observations', icon: '▦', kind: 'store', sub: 'raw · append-only', drill: { view: 'brain', filter: { tab: 'memory' } } },
    { id: 'mem:consolidate', x: 1240, y: 232, w: 180, h: 64, label: 'Consolidator', icon: '⚗', kind: 'engine', sub: 'extract → reconcile', marks: { vec: true } },
    { id: 'embed', x: 1240, y: 470, w: 180, h: 64, label: 'The embedder', icon: '⌗', kind: 'engine', sub: 'tokenize → 384-d vector', marks: { tok: true } },
    { id: 'mem:facts', x: 1510, y: 170, w: 190, h: 64, label: 'Facts & entities', icon: '◈', kind: 'store', sub: 'deduped · tiered · versioned', drill: { view: 'brain', filter: { tab: 'memory' } } },
    { id: 'mem:sources', x: 1510, y: 270, w: 190, h: 46, label: 'Provenance ledger', icon: '⛓', kind: 'store' },
    { id: 'mem:recall', x: 1800, y: 92, w: 182, h: 56, label: 'recall(query)', icon: '🔎', kind: 'engine', sub: 'no model on this path' },
    { id: 'mem:maint', x: 1800, y: 340, w: 190, h: 64, label: 'Self-tending', icon: '♻', kind: 'engine', sub: 'retain · compact · archive', marks: { vec: true } },
    { id: 'mem:vec', x: 2060, y: 58, w: 182, h: 54, label: 'Vector ANN', kind: 'search', sub: 'cosine over VECTOR(384)', marks: { vec: true } },
    { id: 'mem:ft', x: 2060, y: 134, w: 182, h: 54, label: 'FULLTEXT', kind: 'search', sub: 'exact + rare tokens' },
    { id: 'mem:rrf', x: 2310, y: 88, w: 182, h: 56, label: 'Fuse by rank', kind: 'search', sub: 'RRF · K=60' },

    // --- what apps get: ctx.* ----------------------------------------------
    { id: 'ctx', x: 2560, y: 84, w: 230, h: 64, label: 'ctx', icon: '🧩', kind: 'api', sub: 'handed to every app' },

    ...ctxGrid(),

    // --- the brains -------------------------------------------------------
    // One registry, uniform anatomy per brain (intake → index → bounded push
    // taster → pull tools → maintenance). The hub spans the grid; every brain
    // feeds it vertically, and its two outputs are the ONLY ways brain content
    // reaches a model: a fixed-budget taster into every prompt, and read-only
    // pull tools inside tool-enabled sessions.
    { id: 'brain:hub', x: 3620, y: 100, w: 470, h: 58, label: 'Brain registry', icon: '🧠', kind: 'engine', sub: 'fixed-budget push · unbounded-index pull', drill: { view: 'brain' } },
    { id: 'brain:taster', x: 4160, y: 66, w: 236, h: 52, label: 'Push taster', icon: '▤', kind: 'api', sub: '≤1.6KB · every prompt' },
    { id: 'brain:tools', x: 4160, y: 148, w: 236, h: 52, label: 'Pull tools', icon: '🔧', kind: 'api', sub: 'memory_search · todo_list · …' },

    { id: 'brain:constitutional', x: 3620, y: 224, w: 220, h: 52, label: 'Constitutional', icon: '⚖', kind: 'store', sub: 'genome · directives', drill: { view: 'directives' } },
    { id: 'brain:goal', x: 3620, y: 296, w: 220, h: 52, label: 'Missions', icon: '🎯', kind: 'store', sub: 'goal brain · reviewed weekly', drill: { view: 'directives' } },
    { id: 'brain:prospective', x: 3620, y: 368, w: 220, h: 52, label: 'Todos', icon: '☑', kind: 'store', sub: 'due · recurrence · reply-watch', drill: { view: 'todos' } },
    { id: 'brain:semantic', x: 3870, y: 224, w: 220, h: 52, label: 'Semantic', icon: '◈', kind: 'store', sub: 'facts · entities → Memory section', drill: { view: 'brain', filter: { tab: 'memory' } } },
    { id: 'brain:artifacts', x: 3870, y: 296, w: 220, h: 52, label: 'Artifacts', icon: '🗄', kind: 'store', sub: 'receipts · bills · contracts', drill: { view: 'brain', filter: { tab: 'artifacts' } } },
    { id: 'brain:preference', x: 3870, y: 368, w: 220, h: 52, label: 'Decision ledger', icon: '⚖', kind: 'store', sub: 'approve · deny · edit diffs', drill: { view: 'brain', filter: { tab: 'decisions' } } },
    { id: 'brain:episodic', x: 3870, y: 440, w: 220, h: 52, label: 'Episodic', icon: '▪', kind: 'store', sub: 'agenda · journal · audit', drill: { view: 'timeline' } },
  ];

  // from → to, with an optional label and a policy/routine key for counts.
  const EDGES = [
    { from: 'src:timer', to: 'bus' },
    { from: 'src:email', to: 'bus', trust: 'untrusted' },
    { from: 'src:app', to: 'bus' },
    { from: 'src:tools', to: 'bus' },
    { from: 'src:webhook', to: 'bus' },

    { from: 'bus', to: 'pol:ignore', policy: 'ignore' },
    { from: 'bus', to: 'pol:agenda', policy: 'agenda' },
    { from: 'bus', to: 'pol:notify', policy: 'notify' },
    { from: 'bus', to: 'pol:run', policy: 'run-action' },

    { from: 'pol:run', to: 'run:triage', routine: 'triage' },
    { from: 'pol:run', to: 'run:heartbeat', routine: 'heartbeat' },
    { from: 'pol:run', to: 'run:briefing', routine: 'briefing' },
    { from: 'pol:run', to: 'run:digest', routine: 'digest-refresh' },

    { from: 'run:triage', to: 'approvals' },
    { from: 'chat', to: 'approvals', dashedFlow: true },
    { from: 'approvals', to: 'you' },
    { from: 'you', to: 'done' },

    { from: 'directives', to: 'bus', law: true },
    { from: 'directives', to: 'chat', law: true },

    // --- memory: the write path, the store, the read path ------------------
    { from: 'run:triage', to: 'mem:obs' },
    { from: 'chat', to: 'mem:obs', gutter: { y: GUTTERS[0], riseX: 1140, side: 'left', entryDy: -14 } },
    { from: 'mem:obs', to: 'mem:consolidate', vert: true },
    { from: 'embed', to: 'mem:consolidate', vert: true, feed: true },
    { from: 'mem:consolidate', to: 'mem:facts' },
    { from: 'mem:consolidate', to: 'mem:sources' },
    { from: 'mem:obs', to: 'mem:recall' },
    { from: 'mem:facts', to: 'mem:recall' },
    { from: 'mem:facts', to: 'mem:maint' },
    { from: 'embed', to: 'mem:recall', feed: true, gutter: { y: GUTTERS[0], riseX: 1770, side: 'left', entryDy: -16 } },
    { from: 'mem:recall', to: 'mem:vec' },
    { from: 'mem:recall', to: 'mem:ft' },
    { from: 'mem:vec', to: 'mem:rrf' },
    { from: 'mem:ft', to: 'mem:rrf' },

    // --- ctx surfaces that reach a plane already on this map ---------------
    // exitX takes the line clear of the grid before it drops, so it never runs
    // down through the boxes below its own row.
    { from: 'ctx.events', to: 'src:app', reach: true, gutter: { y: GUTTERS[1], exitX: 3496, riseX: 250, side: 'right' } },
    { from: 'ctx.governance', to: 'approvals', reach: true, gutter: { y: GUTTERS[2], exitX: 3514, riseX: 1170, side: 'right' } },
    { from: 'ctx.memory', to: 'mem:obs', reach: true, gutter: { y: GUTTERS[3], exitX: 2540, riseX: 1200, side: 'left', entryDy: 14 } },
    { from: 'ctx.embed', to: 'embed', reach: true, gutter: { y: GUTTERS[4], exitX: 2512, riseX: 1290, side: 'bottom' } },

    // --- brains: every brain feeds the registry; two outputs reach models ---
    { from: 'brain:constitutional', to: 'brain:hub', vert: true },
    { from: 'brain:goal', to: 'brain:hub', vert: true },
    { from: 'brain:prospective', to: 'brain:hub', vert: true },
    { from: 'brain:semantic', to: 'brain:hub', vert: true },
    { from: 'brain:artifacts', to: 'brain:hub', vert: true },
    { from: 'brain:preference', to: 'brain:hub', vert: true },
    { from: 'brain:episodic', to: 'brain:hub', vert: true },
    { from: 'brain:hub', to: 'brain:taster' },
    { from: 'brain:hub', to: 'brain:tools' },
    // The two ways brain content reaches a model — into the chat prompt
    // (push) and into the session's tool belt (pull). Same mechanism feeds
    // triage/briefing prompts; drawn once, to chat, to keep the line count honest.
    { from: 'brain:taster', to: 'chat', reach: true, gutter: { y: GUTTERS[7], exitX: 4150, riseX: 40, side: 'left', entryDy: -12 } },
    { from: 'brain:tools', to: 'chat', reach: true, gutter: { y: GUTTERS[6], exitX: 4126, riseX: 24, side: 'left', entryDy: 12 } },
    // The semantic brain IS the memory engine drawn in the Memory section.
    { from: 'brain:semantic', to: 'mem:facts', reach: true, gutter: { y: GUTTERS[5], exitX: 3585, riseX: 1730, side: 'right' } },
  ];

  // --- hover copy ----------------------------------------------------------
  // The picture shows the shape; these explain the mechanism. Kept out of the
  // graph spec above so the prose stays editable in one block and the layout
  // rows stay readable. Inline markup: `code` and **bold**.

  // What each box actually is.
  const NODE_INFO = {
    'src:timer': 'Two cron jobs live inside Horst: the heartbeat and the 07:00 briefing. Each publishes an event onto the bus — `timer:heartbeat` and `timer:briefing`. The heartbeat is also the safety net: it sweeps mail no `email:new` event covered and runs any mission review that has come due.',
    'src:email': 'Every message the email engine syncs raises `email:new`, tagged **untrusted**. Its contents are quoted to Horst as data, never as instructions. Sender rules run in the engine before the event fires, so filtered mail never reaches here at all.',
    'src:app': 'Installed apps report their own lifecycle — `app:started`, `app:stopped`, `app:failed` — plus the platform\'s attributed failure senses: `app:error` (an app\'s code threw in a Telegram/job/tool/route handler, counted per app by the app guard) and `app:crashloop` (ten failures in a minute → Horst files a restart proposal). Capability modules add their own senses to this catalog (`cron:failed`, `job:failed`, `ai:failed`, `db:down`, `sysmon:pressure`, …). Apps can publish kinds of their own with `ctx.events.emit()`. A kind nobody declared is auto-registered on first emission and is **agenda-only** until you promote it, so a new app can never surprise you.',
    'src:tools': '`tools:updated` fires whenever the installed tool set changes: an app added or removed, or a change session registering a new tool. It is what keeps Horst\'s capability digest current without a server restart.',
    'src:webhook': '`POST /pro/horst/api/hook/<name>` turns any outside call into an event. It sits behind owner auth like the rest of the API, so today it is reachable from your own session but not yet from an external service.',
    bus: 'One rule per app × kind, and every signal is routed down exactly one of the four branches to the right. Envelopes arrive structured — source, app, kind, summary, payload, trust — so routing never has to read the payload, and **no model is consulted here at all**: the rule is the decision. Guardrails run first: a 16 KB payload cap with a truncation marker, per-app rate limits, and storm collapse that folds a flood of one kind into a single digest event.',
    'pol:ignore': 'Recorded in the audit ring and nothing else. For kinds that are noisy and never actionable. There is no fifth branch that hands an event to Horst to think about on his own: everything he does starts from a routine, from the mail he triages, or from you in chat — and lands as a proposal you decide on.',
    'pol:agenda': 'One line on your Timeline. Horst does not act. This is also the default every newly discovered event kind gets until you promote it.',
    'pol:notify': 'A Telegram push to you, and nothing more. The decision stays entirely yours.',
    'pol:run': 'Runs the one built-in routine wired to that event kind. No model is consulted, nothing is judged — it is deterministic, free and immediate. Only four kinds have a routine bound; for the rest this option is hidden in Triggers rather than quietly doing nothing.',
    'run:heartbeat': 'The recurring tick. Sweeps mail that no event covered, runs any mission review that has come due, and keeps the agenda current. Skipped entirely while the kill switch is on. It calls no model of its own — the sweep it starts is where that happens, over on **email triage**.',
    'run:briefing': 'The 07:00 summary — agenda, pending approvals, what happened overnight — written to the journal and pushed to Telegram.',
    'run:triage': 'The one email classifier on the platform. Categorises new mail, scores importance and spam, reads attachments, mines contacts and facts into shared memory, and stages reply drafts and detected calendar events as approvals. It never sends anything itself.',
    'run:digest': 'Rebuilds the capability digest — every tool, engine, event kind and APP.md on the box — so Horst plans against what is actually installed right now rather than what was there at boot. No model runs: it reads files and drops the cache.',
    chat: 'Talking to Horst does not touch the bus at all — no rule, no policy, no triage. It lands in the same approval plane, though: anything he wants to actually do arrives as a proposal you decide on.',
    approvals: 'The single approval plane for the whole platform — Horst\'s proposals and every app\'s. What you see is the exact payload frozen and validated when the proposal was created, not a summary regenerated later. Sending mail and changing Horst\'s own code are pinned here permanently and cannot be dialled up to automatic.',
    you: 'Approve or deny — in this panel, or straight from the Telegram card. Denials are recorded with the same weight as approvals.',
    done: 'The stored payload is handed to the executor registered for its kind and run verbatim. The result goes back to the audit log and to whichever surface raised it.',
    directives: 'Your standing orders, pasted verbatim into every prompt Horst runs — never left to semantic recall. Above them sits the genome: ten rules Horst cannot be told to break. A directive that would violate one is refused outright, with the gene cited.',

    // --- memory ------------------------------------------------------------
    'mem:obs': 'The intake, and deliberately the dumbest part of the system: `remember()` is one INSERT and returns in microseconds. Nothing is parsed, embedded or judged at write time — all of that happens later, off the caller\'s critical path. Writing the same thing twice is free: a natural key derived from the source (message id, event id, session turn) makes re-mining an email a no-op.',
    'mem:consolidate': 'The pass that turns raw observations into knowledge, every 10 minutes by default and idle-gated — with nothing waiting it does one cheap guard query and stops. It then tries hard *not* to spend a model call: an identical observation already consolidated, or a live fact of the same app and scope within **0.05 cosine** carrying the same numbers, is marked done and the existing fact merely reinforced. That guard is what ended the 2026-08 echo loop. What survives goes to a model for extraction, then straight into reconciliation. Horst\'s kill switch pauses this pass too.',
    embed: 'The one place in the entire platform where text is actually tokenized. `multilingual-e5-small` (100+ languages) runs in-process through transformers.js and returns a **384-dimension** vector, mean-pooled and L2-normalized so cosine distance is just a dot product — swapped from English-only bge (2026-08) so a German query lands next to an English fact. Asymmetric by design: searches embed as `query:`, stored content as `passage:`. One lazily-loaded singleton for the whole process, versioned so a model change tells `ctx.embed` apps to re-embed; a boot-time migration re-embedded the whole store once. Inputs are capped at 8000 characters and batched 256 at a time.',
    'mem:facts': 'The recall surface: `memory_facts` and `memory_entities`. Each fact is subject · predicate · value with its own embedding, an importance score, a reinforcement count and a tier. **Long** is never forgotten: durable records (contracts, bills, payments, project decisions — anything from a filed document or said by the owner) start there, and short facts are promoted once re-observed or looked up enough times, or scored high enough. Time-bound facts carry an expiry and drop out of recall when it passes. Nothing is truly deleted: superseding stamps `valid_to` and links the old row to the new one, so the history stays walkable.',
    'mem:sources': '`memory_sources`, append-only and never edited — one row for every decision the consolidator made: **insert**, **reinforce**, **supersede**, **merge**. Each carries which app it came from, the source reference and a confidence. This is what lets a recalled fact answer *where did you get that*. Compaction appends here too when it folds duplicates.',
    'mem:maint': 'Three SQL-only passes on their own schedules, each behind a guard query so an idle system does nothing at all. **Retention**, nightly: expired time-bound facts are retired, often-reinforced short facts are promoted to long, and short facts that were minor from the start and never came up again are soft-pruned — the long tier is never touched. **Compaction**, weekly and only once enough new facts have landed: near-duplicates *within the same app and scope* carrying the same numbers are folded into the oldest row, counts summed, the merge recorded in the ledger. **Archival**, monthly: ledger rows whose lineage is no longer current roll off into an archive table. All three stop while Horst is paused, like the consolidator.',
    'mem:recall': 'The read path, and there is no model on it. Two independent searches run over the current, unexpired facts and are fused, long-tier facts winning ties; un-consolidated observations are unioned in so something not yet consolidated is never invisible. Reading is not using: only a deliberate lookup (Horst\'s `memory_search`) reinforces what it found. Every read is scope-filtered — shared and global for everyone, private only for the app that wrote it. Passing `distill: true` adds the one optional model call, to phrase an answer from those facts and nothing else.',
    'mem:vec': '`VEC_DISTANCE_COSINE` over a MariaDB `VECTOR(384)` column — semantic matching, so *what does the landlord charge* finds a fact about rent. If the embedder is cold or unavailable this path simply returns nothing and recall carries on with the other one.',
    'mem:ft': '`MATCH … AGAINST` in natural-language mode — the path that catches the exact, rare tokens a 384-dimension vector blurs away: an invoice number, a surname, a street. It is the reason recall is not vector-only.',
    'mem:rrf': 'Reciprocal-rank fusion: a result scores 1/(60 + its rank) in whichever list it appeared in, and anything found by **both** paths is multiplied by 1.25. Rank, never raw score — a cosine distance and a FULLTEXT relevance score are not comparable numbers, and pretending they are is how hybrid search usually goes wrong.',

    // --- the app surface ---------------------------------------------------
    ctx: 'The object handed to every mounted app: the whole platform as one API. Everything on it is already authenticated, already scoped to the calling app, and already stamped with that app\'s identity server-side — an app cannot act as another app. An app marked independent (`platformContribution: false`) keeps the local surfaces and loses the shared planes.',

    'ctx.dbQuery': 'The app\'s own MariaDB database, provisioned on first use. `ctx.ensureSchema([...])` provisions and runs the DDL in one call. `VECTOR(384)` columns work, so an app can build its own semantic search.',
    'ctx.settings': 'Persistent per-app settings in `.settings.json`, atomic and mutexed — enough that most apps need no config endpoints of their own.',
    'ctx.files': 'Binary in and out without hand-rolled base64: `saveBase64(data, opts)` and `serve(res, path, opts)`.',
    'ctx.jobs': 'Long-running work that survives a GUI reload. `start({name, run})` returns an id; every transition persists to disk and emits a bridge event, and the handler gets `setProgress` and an abort signal. This is how an app satisfies the reload-resilience rule.',
    'ctx.memory': 'The memory engine on this map: `remember`, `rememberBatch`, `recall`, `bySource`, `forget`, `entities`, `history`. `app_origin` and the scope filter are applied server-side, so an app can never read another app\'s private facts.',
    'ctx.embed': 'The same embedder the memory service uses — not a copy, the same in-process singleton. `embed(text | string[])` returns 384-d vectors; `vectorLiteral(v)` formats one for `VEC_FromText()`.',

    'ctx.aiPrompt': 'A one-shot Claude call: message, system prompt, model and `allowedTools`. The same gate everything else on this map runs behind — `[]` means no tools at all, and the proxy enforces it rather than the CLI flags.',
    'ctx.transcribe': 'Speech to text. The key comes from the platform secrets store, so an app needs no setup of its own.',
    'ctx.tts': 'Text to speech; audio comes back base64.',
    'ctx.image': 'Image generation and editing.',
    'ctx.translate': 'Text translation.',
    'ctx.webSearch': 'Brave web search, keyed from the platform secrets store.',

    'ctx.route': 'Google Maps Platform behind one shared key: `route` and `routeMatrix` (Routes API v2), `geocode`, `places`, `placePhoto`.',
    'ctx.music': 'Local MusicGen plus beat analysis, installed from Setup › Extras. Generation is queued platform-wide at concurrency 1 and takes minutes on CPU — run it inside a `ctx.jobs` job, never in a request handler.',
    'ctx.browser': 'Hermetic headless render: HTML plus the app\'s own on-disk assets to a PNG buffer, with no network egress. The root directory is pinned to the app server-side.',
    'ctx.googleAuth': 'Access tokens for Google scopes, and the list of connected accounts.',
    'ctx.emailAccounts': 'The configured mail accounts and their credentials.',
    'ctx.identity': 'One resolved user across both contexts — the dashboard\'s signed session and the cookieless Telegram mini-app\'s validated initData. `resolve(req)` says who it is; `require` is drop-in middleware. Apps stop hand-rolling HMAC validation, link-code stores and session crypto.',

    'ctx.email': 'The master mail store: list, get, send, modify, folders, attachments, annotations, engine-level sender rules and the shared label vocabulary. Annotations are per-app; the store underneath is one.',
    'ctx.calendar': 'The calendar engine: events, create/update/delete, calendars, colours, annotations and sync. Events created here are mined into shared memory automatically.',
    'ctx.telegram': 'A per-app Telegram bot: send, photos, raw API calls, update handlers, mini-app URL. Voice notes are transcribed before the handler ever sees them.',
    'ctx.whatsapp': 'Per-app WhatsApp Cloud API, signature-symmetric with `ctx.telegram` — renaming the object is a working port. Plus buttons, lists, locations and media, which Telegram has no analogue for.',
    'ctx.sse': 'Server-sent events for clients that cannot use the platform WebSocket — Telegram webviews and the like. Channels scope one stream per resource.',
    'ctx.notify': 'A toast in the dashboard: title, body, level.',

    'ctx.events': 'Publish onto the bus at the far left of this map: `emit(kind, payload, opts)`. `declare([{kind, description}])` advertises the kinds an app raises so they arrive named rather than merely discovered.',
    'ctx.governance': 'Stage an action as a proposal instead of running an approval store of its own: `propose`, `list`, `decide`, `registerKind`. Registered kinds are namespaced `<app>:<kind>` and ceiling-clamped to propose; granting the `governance` capability makes an app an approval *surface* as well.',
    'ctx.horst': 'Read-only: Horst\'s latest morning briefing. There is one briefing on the platform, and apps render it rather than generating their own.',
    'ctx.registerTools': 'Expose the app\'s own functions as tools — `registerTools(defs)` plus `onToolCall(name, handler)`. Anything exposed joins the union Horst\'s chat and executor can be granted from.',
    'ctx.tools': 'Call another app\'s tool in-process, provided that tool is published with `expose: \'apps\'`. A stopped mounted app is lazily started for the call.',
    'ctx.broadcaster': 'Push a message to the app\'s own iframe over the platform WebSocket.',
    'ctx.todos': 'The todo brain\'s app surface: `todos.list/create/complete/snooze/…` — platform-owned life data, shared by default so a todo created anywhere is completable everywhere. Not `ctx.jobs`, and not Horst\'s work stack.',

    // --- brains ------------------------------------------------------------
    'brain:hub': 'The brain registry (`horst-brain.js`). Every brain implements one interface — a bounded push **taster** and read-only **pull tools** — and the registry assembles the tasters under one hard byte budget. The governing invariant: store growth NEVER grows the prompt; depth is reached by the model calling a tool, like deliberate human recollection. Click to browse the brains.',
    'brain:taster': 'The fixed-budget push block (≤1.6KB for ALL brains together) injected into every prompt Horst runs: top recall hits with provenance, due todos, decision patterns, active missions. The caps are a rule, not a tunable — when a store outgrows its cap, the taster says so and names the pull tool.',
    'brain:tools': 'Read-only pull tools in the platform tool pack, available to chat and executor sessions: `memory_search` (with an entity scope — the scaling strategy is association, not bigger similarity), `todo_list`, `artifact_search` / `artifact_get`, `decision_stats`, `mission_list` / `mission_get`. Writes never travel this path — they stay behind markers and governance.',
    'brain:constitutional': 'What must always hold: the genome (in code, propose-pinned to change) and your directives — injected **verbatim** into every prompt, never dependent on semantic recall.',
    'brain:goal': 'Missions — durable goals Horst pursues across weeks: the layer between directives (which constrain) and anything he actually does. Assigned in chat with a one-click confirm, or proposed by Horst via `mission.create` (hard-pinned to propose — his most volitional act always needs a human). The heartbeat sweeps for reviews that have come due and runs them: one AI call that writes a progress note, tells you, and raises at most two follow-ups onto your todo list as proposals. A mission never acts on its own.',
    'brain:prospective': 'The user\'s prospective memory: todos with due times, snooze, RRULE-lite recurrence (weekly rules take BYDAY weekdays — "every Tuesday"), and reply-watches ("nudge me if no answer") that auto-close when the reply arrives. Chat-created instantly with undo; email-derived ones go through governance (`todo.create`). The sub-line is live: open · due-now · waiting-for counts and the next due date.',
    'brain:semantic': 'The memory engine drawn in the Memory section of this map: consolidated facts and entities. Vectors are multilingual (a German query finds an English fact); fact TEXT is canonical English regardless of source language — one language keeps dedupe, contradiction detection and FULLTEXT consistent.',
    'brain:artifacts': 'The filing cabinet: photographed receipts, bills, contracts, tickets — classified against a seeded, extensible vocabulary, extracted into structured fields, and mined into facts that link back to the original document. Email attachments are referenced in the mail store (no byte copies); Telegram photos are stored on disk. One bundled AI call does describe + classify + extract + conflict-check.',
    'brain:preference': 'The decision ledger: every approve / deny / expire on a proposal, with what you **edited before approving** — the strongest preference signal there is. Append-only JSONL, never expires (unlike the 7-day proposal store). Surfaces as per-kind stats beside the autonomy dials and as a mechanical DECISION PATTERNS block in drafting prompts — aggregates only, never payload text.',
    'brain:episodic': 'What happened: the agenda, journal and audit rings behind the Timeline. Access is time-shaped (filters, chains), deliberately not semantic recall.',
  };

  // What it takes for anything to travel each arrow.
  const EDGE_INFO = {
    // --- brains ------------------------------------------------------------
    'brain:constitutional>brain:hub': 'Directives are passed through verbatim — the one brain that never depends on recall. The genome never travels at all: it is compiled into the prompts in code.',
    'brain:goal>brain:hub': 'One line per active/blocked mission, always. Depth (goal, approach, progress log) only moves when a session calls `mission_list` / `mission_get`.',
    'brain:prospective>brain:hub': 'Open-todo counts and the next few due items. The full list rides `todo_list` on demand.',
    'brain:semantic>brain:hub': 'Top recall hits for the current query (≤6, provenance attached), computed by the engine in the Memory section — local vectors + FULLTEXT, zero AI cost.',
    'brain:artifacts>brain:hub': 'Artifacts contribute no taster of their own — their extracted facts already surface through semantic recall. Depth is pull-only (`artifact_search` / `artifact_get`).',
    'brain:preference>brain:hub': 'The DECISION PATTERNS block — per-kind approval/edit rates, mechanical aggregates only. Payload text never crosses this line (G9).',
    'brain:episodic>brain:hub': 'Nothing is pushed — episodic access is the Timeline\'s job, time-shaped, not semantic. Drawn so the taxonomy is complete and the split is visibly deliberate.',
    'brain:hub>brain:taster': 'The assembler: every registered brain\'s taster, composed under one hard byte budget (≤1.6KB total). Over budget → whole sections drop from the end, never mid-sentence truncation.',
    'brain:hub>brain:tools': 'Tool definitions and handlers, auto-registered into the `__platform__` tool pack at boot. Adding a brain adds its tools — no wiring.',
    'brain:taster>chat': 'Travels on EVERY prompt Horst runs — chat turns, triage classification, reply drafts, the briefing. Fixed budget: a growing store changes what is IN the taster, never how big it is.',
    'brain:tools>chat': 'Travels only when the model decides to look something up mid-session — deliberate recollection. Read-only by construction; writes go through markers and governance like everything else.',
    'brain:semantic>mem:facts': 'The same store, drawn twice: the Memory section shows the machinery (consolidate, recall, self-tending), the Brains section shows its place in the taxonomy. This line is identity, not data flow.',
    'src:timer>bus': 'A cron tick — nothing else has to happen. The heartbeat and briefing jobs run on their own schedule; turn them off in Settings and this arrow goes quiet.',
    'src:email>bus': 'One new message surviving the engine\'s sender rules. The event is stamped **untrusted** the moment it is built and carries that tag the whole way down.',
    'src:app>bus': 'An app starting, stopping or crashing — or an app calling `ctx.events.emit()` itself. Apps marked independent (`platformContribution: false`) are invisible to Horst and never emit here.',
    'src:tools>bus': 'Any change to the installed tool set: an app installed, removed, or a change session registering a new tool.',
    'src:webhook>bus': 'A POST to `/pro/horst/api/hook/<name>`. Owner auth is required today, so an outside service cannot reach it without first adding the path to the auth exemptions and verifying a per-hook secret.',
    'bus>pol:ignore': 'The rule for that app × kind set to **Ignore it**. Each event goes down exactly one branch, so choosing this silences the other four for that kind.',
    'bus>pol:agenda': 'The rule set to **Just note it** — which is also what every newly discovered kind gets automatically, until you promote it to something else.',
    'bus>pol:notify': 'The rule set to **Ping me**, plus a Telegram chat bound to the control bot. With no bot linked the branch still fires but the push has nowhere to land.',
    'bus>pol:run': 'The rule set to **Run the routine** *and* a routine actually bound to that kind. Only six have one — heartbeat, briefing, `email:new`, `tools:updated`, `todo:due` and `app:crashloop` (app-triage: an agenda note plus an `app.restart` proposal at its dial). For every other kind the option is hidden in Triggers instead of being a silent no-op.',
    'pol:run>run:triage': 'An `email:new` event with the kill switch off. While paused the sweep is skipped and the event is logged as `paused`.',
    'pol:run>run:heartbeat': 'A `timer:heartbeat` tick with the kill switch off.',
    'pol:run>run:briefing': 'A `timer:briefing` tick — 07:00 by default — with the kill switch off.',
    'pol:run>run:digest': 'A `tools:updated` event. No kill-switch check here: keeping the digest honest costs nothing and never acts on your behalf.',
    'run:triage>approvals': 'The classifier deciding a mail needs a reply, or spotting an event in it: that stages an `email.send` or `calendar.create` proposal. It never sends — outward mail is pinned to propose and cannot be dialled to automatic. Automated proposals are checked against the world *before* they become cards: an event already in your calendar is never staged (an audit row records it), one that knows more than the stored event is staged as an **update**, and one you already decided is not raised again.',
    'chat>approvals': 'Horst writing a `<horst-propose>` marker in a reply, with a payload that validates against a registered action kind. Payloads that fail validation are surfaced back in the chat instead of becoming a proposal.',
    'approvals>you': 'A proposal sitting in pending. It appears in this panel, and as a Telegram card if the bot is linked. Nothing lapses silently — untouched proposals expire after 7 days and are recorded as expired.',
    'you>done': 'Your approval. The frozen payload is executed exactly as stored. If the app that registered the kind is stopped, the proposal stays pending rather than having your decision consumed by nothing.',
    'directives>bus': 'Nothing travels this line — it is influence, not traffic. Your active directives are injected into every prompt Horst runs, so they shape the decisions this whole half of the map makes.',
    'directives>chat': 'Nothing travels this line either. Every chat turn is prompted with your active directives verbatim, and the genome above them.',

    // --- memory ------------------------------------------------------------
    'run:triage>mem:obs': 'The classifier finding something worth keeping: contacts, and durable content facts mined fifteen mails at a time. They are written `shared`, so every app benefits, each carrying the mail it came from as provenance.',
    'chat>mem:obs': 'Horst writing a `<horst-remember>` marker in a reply — normally because you told him to remember something. It is stored under `app_origin: horst`, scope `private`.',
    'mem:obs>mem:consolidate': 'Un-consolidated rows, oldest first, 200 per pass. An observation is claimed only once: the row is stamped `consolidated_at` whether it produced facts or was recognised as something already known.',
    'embed>mem:consolidate': 'Vectors, twice over: one for the near-duplicate guard that decides whether this observation is worth a model call at all, and then one for every fact and entity actually stored.',
    'mem:consolidate>mem:facts': 'Extracted facts as subject · predicate · value, plus the entities they hang off. Reconciled on arrival — identical value reinforces the existing row, a confident new value supersedes it, a doubtful one is stored alongside rather than destroying what is already there.',
    'mem:consolidate>mem:sources': 'One ledger row per decision, with the app it came from, the source reference and the confidence. Superseding rows also link back to the source row they replace, so a lineage can be walked backwards.',
    'mem:obs>mem:recall': 'Every un-consolidated observation, matched by FULLTEXT and unioned into the results marked `pending`. Without this, something written a minute ago — or during a pause, when consolidation stops — would be invisible until the next consolidation pass.',
    'mem:facts>mem:recall': 'Only the rows that are currently valid — anything superseded or pruned has a `valid_to` and never appears. Scope is applied in the same query, not filtered afterwards.',
    'mem:facts>mem:maint': 'Everything currently live, for the three self-tending passes to walk. They write back to this same table: expiries, promotions, soft prunes, and duplicate folds.',
    'embed>mem:recall': 'The query itself, as a 384-d vector. If this fails — the model still cold, or unavailable — recall does not error: the vector path just returns nothing and the FULLTEXT path carries the search alone.',
    'mem:recall>mem:vec': 'The query vector, against the embedding column. Takes twice the requested limit, so the fusion below has something to actually choose between.',
    'mem:recall>mem:ft': 'The query as words. Also twice the requested limit, ranked by relevance score.',
    'mem:vec>mem:rrf': 'A ranked list — position matters here, the cosine distance itself is discarded.',
    'mem:ft>mem:rrf': 'A second ranked list. Anything appearing in both gets a 1.25× boost when the two are fused.',

    // --- the app surface ---------------------------------------------------
    'ctx.events>src:app': 'An envelope from an app: `ctx.events.emit(kind, payload, opts)`. The kind is auto-namespaced to the app so kinds can never collide, and a first-time kind registers itself as agenda-only. An app marked independent is dropped here silently — it must work the same either way.',
    'ctx.governance>approvals': 'A proposal from an app, under a kind that app registered. The payload is frozen and validated at creation, and the app\'s identity is stamped server-side — it cannot propose, or decide, as another app. Its executor is an in-app callback, cleared when the app stops.',
    'ctx.memory>mem:obs': 'Observations from an app, tagged with its `app_origin`. Scope decides who reads them back: `private` is the app\'s alone, `shared` and `global` are everyone\'s. The app cannot lie about which app it is.',
    'ctx.embed>embed': 'Text in, vectors out — the very same in-process singleton the memory service uses, which is what makes an app\'s own vector search directly comparable with the platform\'s.',
  };

  // Where a model is actually called, and on what terms. `tools` is the literal
  // allowedTools the call is made with — the ai-tool-gate proxy rule strips
  // everything else out of the request, so this is enforcement, not intent.
  // Kept in step with the aiPrompt() call sites in horst-triage.js,
  // horst-missions.js and platform-horst.js.
  const NO_SESSION = 'No session is resumed: each call is a fresh one-shot process and nothing carries over between them. Whatever context a call needs is re-sent in its prompt.';

  const AI_CALLS = {
    'run:triage': {
      calls: [
        { name: 'Classify the batch', model: 'haiku', setting: 'triageModel', tools: null, what: 'One record per mail: category, labels, importance, spam score, needs-reply, summary, suggested reply, calendar events — plus, since the brain-check, **memory conflicts** and **todo suggestions**. Each mail arrives with up to 3 recalled memory lines (free, local) so "invoice for a cancelled subscription" is caught in this same call. Untrusted input, so it is handed nothing to act with (G9); its todos become governance proposals, never direct writes.' },
        { name: 'Read the attachments', model: 'haiku', setting: 'triageModel', tools: '`Read`', what: 'Opens the files themselves; the dates, times and amounts read off the document supersede whatever the mail body implied.' },
        { name: 'Mine the facts', model: 'haiku', tools: null, what: 'Fifteen mails at a time, keeping only durable personal facts — written to shared memory with provenance, in canonical English whatever the mail\'s language (one fact language keeps dedupe and contradiction detection honest; the vectors are multilingual, so German queries still find them). Most mail yields nothing, by design.' },
        { name: 'Draft the reply', model: 'sonnet', setting: 'briefingModel', tools: null, what: 'Writes a reply in the sender\'s language, informed by what memory knows about the correspondent and by the decision ledger\'s DECISION PATTERNS (how you actually edit and approve drafts). It becomes a pending `email.send` proposal — it has no way to send.' },
      ],
      footer: `${NO_SESSION} **Look again** on one mail repeats the classify call over the full body, attachment read forced.`,
    },
    'run:briefing': {
      calls: [
        { name: 'Compose the briefing', model: 'sonnet', setting: 'briefingModel', tools: null, what: 'Turns the already-fetched agenda, mail intel and pending approvals into the 07:00 text. It gathers nothing itself, so the only thing it can get wrong is the wording.' },
      ],
      footer: NO_SESSION,
    },
    chat: {
      calls: [
        { name: 'Answer your turn', model: 'platform default', setting: 'chatModel', modelNote: 'The setting is empty by default, which means no model flag is passed and the platform default applies.', tools: 'every app tool · `AskUserQuestion` · `WebSearch` · `WebFetch`', what: 'The one place Horst is handed the whole tool union. No Bash and no filesystem — a standing invariant enforced by the `ai-tool-gate` proxy rule, not by asking. Anything he wants to *do* he writes as a marker, which becomes an approval.' },
        { name: 'Describe a photo or PDF', model: 'haiku', setting: 'triageModel', tools: '`Read`', what: 'Telegram media up to 15 MB is written to a temp file, read, and described into the conversation as untrusted context. The temp file is deleted either way.' },
      ],
      footer: 'No session is resumed here either — what makes chat feel continuous is that the conversation so far is re-sent with every turn.',
    },
    directives: {
      calls: [
        { name: 'The directive workshop', model: 'opus', setting: 'directiveModel', tools: null, what: 'Restates your order precisely, asks only questions whose answers would change the wording, names the edge cases, weighs it up, and checks it against the genome. The genome sits in its system prompt, so a refusal citing a gene is real rather than decorative.' },
      ],
      footer: NO_SESSION,
    },
    'mem:consolidate': {
      calls: [
        { name: 'Extract structured memory', model: 'haiku', setting: 'directModel', tools: null, what: 'Turns one observation into `{facts: [subject, predicate, value, importance, confidence], entities: [...]}`, decomposing compound statements. Zero tools is not an optimisation here: with the tool sidecar attached, the extractor was calling apps\' own remember tools and re-storing what it had just extracted — every echo became another observation and another session. If the call fails the text is stored as a raw low-confidence note rather than lost.' },
      ],
      footer: `${NO_SESSION} The guards in front of this call matter more than the call: an already-known observation never reaches it.`,
    },
  };

  const KIND_KICKER = {
    source: 'A sense', router: 'The router', policy: 'A branch',
    routine: 'A built-in routine', deep: 'The thinking half',
    gate: 'The approval plane', owner: 'Your call', done: 'The outcome',
    law: 'Standing orders',
    store: 'A table', engine: 'A moving part', search: 'A search path',
    api: 'The app surface', ctx: 'Exposed to apps',
  };

  const DRILL_HINT = {
    timeline: 'Click to open the Timeline, filtered to this',
    triggers: 'Click to set what happens to each kind of event',
    approvals: 'Click to open Approvals',
    chat: 'Click to open Chat',
    directives: 'Click to open Directives',
  };

  const byId = new Map(NODES.map((n) => [n.id, n]));
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function el(name, attrs, parent) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v != null) node.setAttribute(k, String(v));
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  // Orthogonal-ish routing: leave right, enter left, with a soft S-curve. Keeps
  // the picture readable at every zoom without a layout library.
  function edgePath(a, b) {
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    // Backwards or steeply-stacked edges (directives → bus, chat → approvals)
    // get a wider bow so they don't cut through the nodes between them.
    if (x2 < x1) {
      const dip = Math.max(a.y, b.y) + Math.max(a.h, b.h) + 46;
      return `M ${x1} ${y1} C ${x1 + 60} ${y1}, ${x2 - 60} ${dip}, ${x2 + b.w / 2} ${b.y + b.h}`;
    }
    const mid = x1 + (x2 - x1) / 2;
    return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
  }

  // Same-column edges: leave one face, enter the opposite one. Used where the
  // left-to-right router would swing a box-crossing bow instead.
  function vertPath(a, b) {
    const x1 = a.x + a.w / 2;
    const x2 = b.x + b.w / 2;
    const down = b.y > a.y;
    const y1 = down ? a.y + a.h : a.y;
    const y2 = down ? b.y : b.y + b.h;
    const mid = y1 + (y2 - y1) / 2;
    return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
  }

  // Long-haul routing: sidestep clear of the source (exitX), drop to a gutter
  // beneath the whole picture, run along it, rise next to the target (riseX),
  // then step in. Rounded corners so it reads as one line, not four segments.
  function gutterPath(a, b, g) {
    const R = 12;
    const gy = g.y;
    let d;
    let x1;
    if (g.exitX != null) {
      const from = g.exitX > a.x + a.w / 2 ? a.x + a.w : a.x;
      const cy = a.y + a.h / 2;
      x1 = g.exitX;
      const s = x1 > from ? 1 : -1;
      d = `M ${from} ${cy} L ${x1 - s * R} ${cy} Q ${x1} ${cy} ${x1} ${cy + R}`;
    } else {
      x1 = a.x + a.w / 2;
      d = `M ${x1} ${a.y + a.h}`;
    }
    const rx = g.riseX;
    const s1 = rx > x1 ? 1 : -1;
    d += ` L ${x1} ${gy - R} Q ${x1} ${gy} ${x1 + s1 * R} ${gy} L ${rx - s1 * R} ${gy} Q ${rx} ${gy} ${rx} ${gy - R}`;

    if (g.side === 'bottom') return `${d} L ${rx} ${b.y + b.h}`;
    const ex = g.side === 'right' ? b.x + b.w : b.x;
    const ey = b.y + b.h / 2 + (g.entryDy || 0);
    const s2 = ex > rx ? 1 : -1;
    return `${d} L ${rx} ${ey + R} Q ${rx} ${ey} ${rx + s2 * R} ${ey} L ${ex} ${ey}`;
  }

  function pathFor(e, a, b) {
    if (e.gutter) return gutterPath(a, b, e.gutter);
    if (e.vert) return vertPath(a, b);
    return edgePath(a, b);
  }

  function count(summary, node) {
    if (!summary) return null;
    if (node.kind === 'source') {
      const key = node.id.split(':')[1];
      if (key === 'chat') return summary.chat?.conversations ?? null;
      return summary.sources?.[key] ?? 0;
    }
    if (node.policy) return summary.policies?.[node.policy] ?? 0;
    if (node.routine) return summary.routines?.[node.routine] ?? 0;
    if (node.id === 'approvals') return summary.proposals?.pending ?? 0;
    if (node.id === 'done') return summary.proposals?.executed ?? 0;
    if (node.id === 'directives') return summary.directives?.active ?? 0;
    if (node.id === 'bus') return summary.window?.events ?? 0;
    const b = summary.brains || {};
    if (node.id === 'brain:semantic') return b.memory?.facts ?? null;
    if (node.id === 'brain:prospective') return b.todos?.open ?? null;
    if (node.id === 'brain:artifacts') return b.artifacts ?? null;
    if (node.id === 'brain:preference') return b.decisions ?? null;
    if (node.id === 'brain:goal') return b.missions ? (b.missions.active + b.missions.pending) : null;
    if (node.id === 'brain:constitutional') return summary.directives?.active ?? null;
    if (node.id === 'brain:episodic') return summary.window?.events ?? null;
    return null;
  }

  // Live sub-lines: nodes whose second line shows fresh numbers instead of a
  // static caption. Falls back to the declared sub while the store is dark.
  function liveSub(summary, node) {
    if (node.id !== 'brain:prospective') return null;
    const t = summary?.brains?.todos;
    if (!t) return null;
    const parts = [`${t.open || 0} open`, `${t.dueNow || 0} due`, `${t.waiting || 0} waiting`];
    if (t.nextDue) {
      const d = new Date(t.nextDue);
      if (!isNaN(d)) parts.push(`next ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`);
    }
    return parts.join(' · ');
  }

  function isCold(summary, key) {
    if (!summary || !key) return false;
    return !!summary.cold?.[key];
  }

  // --- hover explainer -----------------------------------------------------

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // Inline markup for the copy above: `code` and **bold**. Escaping runs first,
  // so a literal `<horst-propose>` in the prose survives as text.
  function fmt(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\*([^*]+)\*/g, '<i>$1</i>');
  }

  // One block per model call: what it does, on which model, with which tools.
  function aiHtml(ai) {
    if (!ai) return '';
    const rows = ai.calls.map((c) => `<div class="hmap-ai-call">`
      + `<div class="hmap-ai-name">${esc(c.name)}</div>`
      + '<div class="hmap-ai-meta">'
      + `<span class="hmap-ai-chip model">${fmt(c.model)}</span>`
      + (c.setting ? `<span class="hmap-ai-chip set">${fmt(c.setting)}</span>` : '')
      + `<span class="hmap-ai-chip tools${c.tools ? '' : ' none'}">${c.tools ? fmt(c.tools) : 'no tools'}</span>`
      + '</div>'
      + (c.modelNote ? `<div class="hmap-ai-note">${fmt(c.modelNote)}</div>` : '')
      + `<div class="hmap-ai-what">${fmt(c.what)}</div>`
      + '</div>').join('');
    return `<div class="hmap-ai-block">`
      + `<div class="hmap-ai-head">✦ ${ai.calls.length} model call${ai.calls.length === 1 ? '' : 's'} here</div>`
      + rows
      + (ai.footer ? `<div class="hmap-ai-session">${fmt(ai.footer)}</div>` : '')
      + '</div>';
  }

  function tipHtml({ kicker, title, body, foot, cold, ai }) {
    return `<div class="hmap-tip-kicker">${esc(kicker)}</div>`
      + `<div class="hmap-tip-title">${esc(title)}</div>`
      + `<div class="hmap-tip-body">${fmt(body)}</div>`
      + (cold ? '<div class="hmap-tip-cold">Nothing has ever travelled this path.</div>' : '')
      + aiHtml(ai)
      + (foot ? `<div class="hmap-tip-foot">${esc(foot)}</div>` : '');
  }

  // A fixed-position panel parented to the host, so clearing the host on a view
  // change takes the tooltip (and its listeners) with it — no teardown call.
  function makeTip(host) {
    const tip = document.createElement('div');
    tip.className = 'hmap-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    host.appendChild(tip);

    let anchor = null;

    // Prefer down-right of the cursor; flip on whichever edge it would overrun.
    function place(x, y) {
      tip.style.left = '0px';
      tip.style.top = '0px';
      const r = tip.getBoundingClientRect();
      const pad = 10;
      let left = x + 18;
      let top = y + 18;
      if (left + r.width > window.innerWidth - pad) left = x - r.width - 18;
      if (top + r.height > window.innerHeight - pad) top = y - r.height - 18;
      tip.style.left = `${Math.max(pad, left)}px`;
      tip.style.top = `${Math.max(pad, top)}px`;
    }

    function show(target, spec, ev) {
      anchor = target;
      tip.innerHTML = tipHtml(spec);
      tip.hidden = false;
      if (ev && typeof ev.clientX === 'number' && ev.clientX) place(ev.clientX, ev.clientY);
      else {
        const r = target.getBoundingClientRect();
        place(r.left + r.width / 2, r.bottom - 8);
      }
    }

    function hide(target) {
      if (target && anchor !== target) return; // a newer anchor already took over
      anchor = null;
      tip.hidden = true;
    }

    // Keyboard focus gets the same explanation as the mouse.
    function bind(target, spec) {
      target.addEventListener('mouseenter', (ev) => show(target, spec, ev));
      target.addEventListener('mousemove', (ev) => { if (anchor === target) place(ev.clientX, ev.clientY); });
      target.addEventListener('mouseleave', () => hide(target));
      target.addEventListener('focus', () => show(target, spec));
      target.addEventListener('blur', () => hide(target));
    }

    return { bind, hide: () => hide() };
  }

  // --- render --------------------------------------------------------------

  function render(host, summary, opts) {
    const onDrill = (opts && opts.onDrill) || (() => {});
    host.innerHTML = '';

    // role=group, not img: the nodes inside are focusable buttons and the edges
    // carry their own labels — 'img' would make all of that presentational.
    // Explicit width/height (not 100%) is what makes the host scroll rather
    // than shrink the panorama to illegibility; zoom rewrites them.
    const svg = el('svg', {
      class: 'hmap', viewBox: `0 0 ${W} ${H}`, width: W, height: H,
      preserveAspectRatio: 'xMidYMid meet', role: 'group',
      'aria-label': 'Live map of Horst’s internals',
    }, host);

    const tip = makeTip(host);
    svg.addEventListener('mouseleave', () => tip.hide());
    // A fixed-position panel would otherwise hang in place while the map scrolls.
    host.closest('.map-wrap')?.addEventListener('scroll', () => tip.hide(), { passive: true });

    const defs = el('defs', {}, svg);
    const marker = el('marker', {
      id: 'hmap-arrow', viewBox: '0 0 8 8', refX: 7, refY: 4,
      markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
    }, defs);
    el('path', { d: 'M 0 0 L 8 4 L 0 8 z', class: 'hmap-arrowhead' }, marker);

    const gEdges = el('g', { class: 'hmap-edges' }, svg);
    const gFlow = el('g', { class: 'hmap-flow' }, svg);
    const gNodes = el('g', { class: 'hmap-nodes' }, svg);

    // band captions
    const bands = [
      { x: 70, label: 'SENSES' }, { x: 300, label: 'ROUTER' },
      { x: 540, label: 'WHAT HAPPENS' }, { x: 762, label: 'THE WORK' }, { x: 960, label: 'YOU' },
      { x: 1240, label: 'MEMORY' }, { x: 1800, label: 'RECALL' },
      { x: 2560, label: 'WHAT YOUR APPS CAN CALL' },
    ];
    for (const b of bands) el('text', { x: b.x, y: 36, class: 'hmap-band' }, svg).textContent = b.label;

    // A rail from the ctx hub down to each column, so the grid reads as one
    // surface fanning out rather than six unrelated panels.
    const ctxHub = byId.get('ctx');
    if (ctxHub) {
      const railY = CTX_Y - 32;
      const lastX = CTX_X + (CTX_COLUMNS.length - 1) * CTX_COL + 24;
      const drops = CTX_COLUMNS.map((_, ci) => `M ${CTX_X + ci * CTX_COL + 24} ${railY} L ${CTX_X + ci * CTX_COL + 24} ${railY + 12}`).join(' ');
      el('path', {
        class: 'hmap-rail',
        d: `M ${ctxHub.x + 24} ${ctxHub.y + ctxHub.h} L ${ctxHub.x + 24} ${railY} L ${lastX} ${railY} ${drops}`,
      }, gEdges);
    }

    // sub-captions over each ctx column
    CTX_COLUMNS.forEach((col, ci) => {
      el('text', { x: CTX_X + ci * CTX_COL, y: CTX_Y - 12, class: 'hmap-group' }, svg).textContent = col.label;
    });

    // edges first, so nodes sit on top
    const paths = new Map();
    for (const e of EDGES) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) continue;
      const cold = isCold(summary, e.cold) || (e.policy && !(summary?.policies?.[e.policy]));
      const key = `${e.from}>${e.to}`;
      const id = `hmap-e-${e.from}-${e.to}`.replace(/[^\w-]/g, '_');
      const cls = ['hmap-edge'];
      if (cold) cls.push('cold');
      if (e.law) cls.push('law');
      if (e.trust === 'untrusted') cls.push('untrusted');
      if (e.dashedFlow) cls.push('bypass');
      if (e.reach) cls.push('reach');
      if (e.feed) cls.push('feed');
      const d = pathFor(e, a, b);
      const p = el('path', {
        id, d, class: cls.join(' '),
        'marker-end': e.law ? null : 'url(#hmap-arrow)',
      }, gEdges);
      paths.set(key, p);

      // A 1.6px stroke is not a hover target. An invisible fat twin over the
      // same geometry takes the pointer and lights the real line up.
      const info = EDGE_INFO[key];
      if (info) {
        const hit = el('path', {
          d, class: 'hmap-edge-hit', role: 'img',
          'aria-label': `${a.label} to ${b.label}. ${info.replace(/[`*]/g, '')}`,
        }, gEdges);
        hit.addEventListener('mouseenter', () => p.classList.add('hover'));
        hit.addEventListener('mouseleave', () => p.classList.remove('hover'));
        tip.bind(hit, {
          kicker: e.law ? 'Influence, not traffic'
            : e.reach ? 'What an app sends over this'
              : e.feed ? 'What this feeds in'
                : 'What it takes to travel here',
          title: `${a.label} → ${b.label}`,
          body: info,
          cold: cold && !e.law && !e.reach,
        });
      }
    }

    // nodes
    for (const n of NODES) {
      const cold = isCold(summary, n.cold) || (n.policy && !(summary?.policies?.[n.policy]));
      const g = el('g', {
        class: `hmap-node k-${n.kind}${cold ? ' cold' : ''}${n.accent ? ' accent' : ''}`,
        'data-id': n.id, tabindex: n.drill ? 0 : null,
        role: n.drill ? 'button' : null,
      }, gNodes);

      el('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 11, class: 'hmap-box' }, g);
      el('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 11, class: 'hmap-glow' }, g);

      // Boxes too short for a second line (the ctx grid) put their sub inline
      // and right-aligned instead of stacking it below the label.
      const tight = n.h < 44;
      const cx = n.x + 13;
      const ty = n.y + (n.sub && !tight ? 22 : n.h / 2 + 4);
      if (n.icon) {
        el('text', { x: cx, y: ty, class: 'hmap-icon' }, g).textContent = n.icon;
      }
      el('text', { x: n.icon ? cx + 22 : cx, y: ty, class: 'hmap-label' }, g).textContent = n.label;
      if (n.sub && !tight) {
        el('text', { x: cx, y: n.y + 40, class: 'hmap-sub' }, g).textContent = liveSub(summary, n) || n.sub;
      }

      // One right-anchored run holds everything on the right of the box, so no
      // item has to be positioned against another's rendered width:
      //   ⌗ tokenizer · ⬡ vector search · ✦n model calls · then the live count
      //   (or, on a short box, the sub-label).
      const c = count(summary, n);
      const ai = AI_CALLS[n.id];
      const marks = n.marks || {};
      const trail = tight ? n.sub : (c != null ? String(c) : null);
      if (marks.tok || marks.vec || ai || trail) {
        const t = el('text', { x: n.x + n.w - 11, y: n.y + Math.min(22, n.h - 11), class: 'hmap-count' }, g);
        let gap = false;
        const add = (cls, text) => {
          el('tspan', { class: cls || null, dx: gap ? 5 : 0 }, t).textContent = text;
          gap = true;
        };
        if (marks.tok) add('hmap-mark-tok', '⌗');
        if (marks.vec) add('hmap-mark-vec', '⬡');
        if (ai) add('hmap-ai-mark', `✦${ai.calls.length}`);
        if (trail) add(tight ? 'hmap-sub-inline' : null, trail);
      }
      if (cold) {
        el('text', { x: n.x + n.w - 11, y: n.y + n.h - 9, class: 'hmap-never' }, g).textContent = 'never used';
      }

      // the timers node carries a live ECG that beats on every heartbeat
      if (n.id === 'src:timer') {
        el('path', {
          class: 'hmap-ecg',
          d: `M ${n.x + 8} ${n.y + n.h - 10} l 14 0 l 5 -9 l 6 17 l 6 -8 l 5 0`,
        }, g);
      }

      if (NODE_INFO[n.id]) {
        if (ai) g.classList.add('has-ai');
        tip.bind(g, {
          kicker: KIND_KICKER[n.kind] || 'On the map',
          title: n.label,
          body: NODE_INFO[n.id],
          cold,
          ai,
          foot: n.drill ? DRILL_HINT[n.drill.view] : null,
        });
      }

      if (n.drill) {
        g.classList.add('clickable');
        const go = () => onDrill(n.drill);
        g.addEventListener('click', go);
        g.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); }
        });
      }
    }

    const ctx = { svg, gFlow, paths, host, tip, zoom: 1 };
    setZoom(ctx, 1);
    return ctx;
  }

  // --- zoom & panning ------------------------------------------------------

  const ZOOM_MIN = 0.3;
  const ZOOM_MAX = 1.6;

  function setZoom(ctx, z) {
    const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    ctx.zoom = zoom;
    ctx.svg.setAttribute('width', Math.round(W * zoom));
    ctx.svg.setAttribute('height', Math.round(H * zoom));
    ctx.tip?.hide();
    return zoom;
  }

  function wrapOf(ctx) {
    return ctx.host.closest('.map-wrap') || ctx.host.parentElement;
  }

  // "Fit" means fit the height — the whole vertical story on screen, scroll
  // sideways for the rest. Fitting the width would make 3540px unreadable.
  function fitZoom(ctx) {
    const wrap = wrapOf(ctx);
    if (!wrap) return 1;
    return setZoom(ctx, (wrap.clientHeight - 26) / H);
  }

  function scrollToSection(ctx, id) {
    const s = SECTIONS.find((x) => x.id === id);
    const wrap = wrapOf(ctx);
    if (!s || !wrap) return;
    wrap.scrollTo({ left: Math.max(0, s.x * ctx.zoom - 20), behavior: 'smooth' });
  }

  // --- animation -----------------------------------------------------------

  // Which policy branch an audit entry took. `policy` is the clean field; fall
  // back to parsing the outcome for entries dropped before routing.
  function branchFor(entry) {
    if (entry.policy) return entry.policy;
    if (/ignored/.test(entry.outcome || '')) return 'ignore';
    return null;
  }

  function routineFor(entry) {
    const m = /→ ran ([a-z-]+)/.exec(entry.outcome || '');
    return m ? m[1] : null;
  }

  function sourceNodeId(entry) {
    const s = entry.source;
    return byId.has(`src:${s}`) ? `src:${s}` : null;
  }

  function pulse(ctx, nodeId, ms) {
    const g = ctx.host.querySelector(`.hmap-node[data-id="${CSS.escape(nodeId)}"]`);
    if (!g) return;
    g.classList.remove('hit');
    // reflow so a repeat hit restarts the animation rather than being ignored
    void g.getBoundingClientRect();
    g.classList.add('hit');
    setTimeout(() => g.classList.remove('hit'), ms || 1400);
  }

  function beatEcg(ctx) {
    const p = ctx.host.querySelector('.hmap-ecg');
    if (!p) return;
    p.classList.remove('beat');
    void p.getBoundingClientRect();
    p.classList.add('beat');
    setTimeout(() => p.classList.remove('beat'), 900);
  }

  // Send one dot along an edge. Uses animateMotion + mpath so the browser walks
  // the real path geometry; the element removes itself when the motion ends.
  function sendParticle(ctx, fromId, toId, { trust, dur = 900, delay = 0 } = {}) {
    const p = ctx.paths.get(`${fromId}>${toId}`);
    if (!p) return;
    const dot = el('circle', {
      r: 4.5, class: `hmap-dot${trust === 'untrusted' ? ' untrusted' : ''}`,
      cx: 0, cy: 0,
    }, ctx.gFlow);
    const motion = el('animateMotion', {
      dur: `${dur}ms`, begin: `${delay}ms`, fill: 'freeze', rotate: 'auto',
    }, dot);
    el('mpath', { href: `#${p.id}` }, motion);
    motion.addEventListener('endEvent', () => dot.remove());
    // Safety net: endEvent is not fired by every engine in every state.
    setTimeout(() => dot.remove(), delay + dur + 400);
  }

  // Animate one audit entry through the graph: source → bus → branch → routine.
  function flow(ctx, entry, speed = 1) {
    const src = sourceNodeId(entry);
    const branch = branchFor(entry);
    const routine = routineFor(entry);
    const trust = entry.trust;
    const step = 820 / speed;

    if (src) {
      pulse(ctx, src);
      if (entry.kind === 'timer:heartbeat') beatEcg(ctx);
      sendParticle(ctx, src, 'bus', { trust, dur: step });
    }
    const busDelay = src ? step : 0;
    setTimeout(() => pulse(ctx, 'bus'), busDelay);

    if (!branch) return;
    const polNode = { ignore: 'pol:ignore', agenda: 'pol:agenda', notify: 'pol:notify', 'run-action': 'pol:run' }[branch];
    if (!polNode) return;
    sendParticle(ctx, 'bus', polNode, { trust, dur: step, delay: busDelay });
    setTimeout(() => pulse(ctx, polNode), busDelay + step);

    if (routine) {
      const rNode = { heartbeat: 'run:heartbeat', briefing: 'run:briefing', triage: 'run:triage', 'digest-refresh': 'run:digest' }[routine];
      if (rNode) {
        sendParticle(ctx, polNode, rNode, { trust, dur: step * 0.7, delay: busDelay + step });
        setTimeout(() => pulse(ctx, rNode), busDelay + step * 1.7);
      }
    }
  }

  // Replay the audit ring so the map explains itself immediately. Horst fires
  // roughly one event every 15 minutes, so waiting for live traffic teaches
  // nothing on first open.
  function replay(ctx, entries, { speed = 20, onDone } = {}) {
    const rows = entries.slice(0, 200).slice().reverse();
    if (!rows.length) { onDone?.(); return () => {}; }
    let i = 0;
    let stopped = false;
    const gap = Math.max(90, 1400 / speed);
    const tick = () => {
      if (stopped) return;
      if (i >= rows.length) { onDone?.(); return; }
      flow(ctx, rows[i++], 2.2);
      setTimeout(tick, gap);
    };
    tick();
    return () => { stopped = true; };
  }

  window.HorstMap = {
    render, flow, replay, pulse,
    setZoom, fitZoom, scrollToSection,
    NODES, EDGES, SECTIONS, W, H, ZOOM_MIN, ZOOM_MAX,
  };
})();
