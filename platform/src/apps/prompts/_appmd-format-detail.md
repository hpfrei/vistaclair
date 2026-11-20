APP.md is the **map and contract** for every future Claude Code session that modifies, debugs, or extends this app. It does **not** mirror the source — it routes you into it and tells you what you must not break. It owns the things that are *expensive to rederive and slow to change*: what the app is, how it's shaped and why, where to go for a given change, and the invariants that cause silent regressions if broken. It deliberately does **not** own the things that are cheap to read from source and fast to rot: the line-by-line internals of individual functions.

Because of that split, APP.md is **kept 100% accurate** and stays small enough that keeping it accurate is realistic: every session updates it after any change to the app's *shape* (architecture, routing, invariants, files, dependencies, state) — but a change that only touches a function body usually needs **no doc update at all**. That is what makes the trust contract real: **reading APP.md and its `APP_<TOPIC>.md` detail files is as reliable as reading the source for everything they claim** — architecture, where-to-change, invariants, rationale. For the *exact current bytes* of a function you're about to edit, you still open that function in the source.

**The workflow this enables** — the doc is for *planning*, the source is for *editing*:
1. **Read APP.md first to plan.** From its routing table, invariants, and rationale you form the whole plan: what the change touches, what it must not break, and **which file + symbol to open**. This is a first orientation, not the final detail.
2. **Then open those named symbols in the source** to read the exact current code before editing. The doc points you at the right 1–2 files in seconds; the source gives you the fine detail and the exact bytes to change. You **always** read the affected source before editing — the doc tells you *where* to look, the source tells you *what* is there.
3. **Never broad-explore to *discover* how the app works** — the doc already oriented you. Reach for grep/Read on source to read the specific code you're changing, never to reconstruct the architecture.

**The goal**: a developer (human or AI) reads APP.md and immediately has *a first idea* — why the app is shaped this way, what must not break, and which file + symbol each change surface lives in — then knows exactly where to open the source for the fine details and the edit. The doc gets you *oriented and pointed*; the source gives you *precise*.

### Format

```markdown
# <App Name>

## Purpose
<One paragraph: what the app does, who it's for, key capabilities.>

## Architecture
- **Shape**: frontend-only / with routes; runtime in-process (default) or own-process — and why
- **Entry point**: `public/index.html`
- **Backend**: `routes.js` — empty (bridge-only frontend) or with routes — and why
- **Key design decisions**: choices made and rationale (e.g. "DB instead of state because data grows unbounded"). This is high-value: rationale is invisible in source and expensive to rederive.
- **Database**: schema summary — tables, key columns, relationships. Or "none".

## Where to change what
The most valuable section. A routing table that maps a change request straight to the
file + symbol to open. One row per common change surface (not every function). Reference
functions **by name** so the reader greps to them.

| To change… | Open (function → file) | Detail doc |
| --- | --- | --- |
| <feature / change type> | `funcName` → `routes.js` | `APP_<TOPIC>.md` (if any) |
| ... | ... | ... |

**Cells are pointers, not prose.** The "Open" cell is a list of `symbol → file` pairs and
nothing else — no sentence explaining what the symbol does, no CSS class names, no parameter
lists, no behaviour notes. The symbol name + the detail-doc pointer carry the reader the rest
of the way. A cell that grows past roughly one line is a section trying to live in the table;
move that detail into the named symbol's source or an `APP_<TOPIC>.md` and leave only the
pointer. Keep the table to the **common** change surfaces (aim for ≲25 rows); a niche surface
the reader can reach by grepping a symbol named elsewhere does not need its own row.

## Conventions & Invariants
Cross-cutting rules that must hold across the whole app — break one and you introduce a
silent regression. These are invisible in any single function, so they belong here. List
only what actually applies, e.g.:
- **Identity / auth**: how a request's user is resolved and which routes are scoped to whom.
- **Untrusted input**: always `escapeHtml(...)` user/API/AI strings before `innerHTML`.
- **Time math**: compute windows/expiry **in the DB** (`NOW() + INTERVAL …`), never in JS.
- **Realtime**: which WebSocket/event names carry live data (no client-side polling).
- **State vs DB**: what lives in `state.*` vs database tables, and why.

## Gotchas
Non-obvious constraints and "it's written this weird way on purpose" facts — the things a
session would get wrong by reading the code naively and "fixing" it. Very high value: these
are the most expensive facts to rederive and the easiest to accidentally break. e.g.:
- "`body-render` is registered directly on `router`, not via `mount`, so it's deliberately
  unreachable from `/api/app/*` — don't 'normalize' it onto `mount`."
- "Peeled muscles use a baked clone Mesh, not `position` on the SkinnedMesh — moving the
  skinned original's position does nothing (bindMatrixInverse cancels it)."
Omit this section only if the app genuinely has none.

## Files
**One line per significant file** — what it is and when you'd open it. NOT a description of
its contents, and NOT a paragraph. The hard test: if an entry runs longer than a single line,
you are mirroring the file's internals — cut it back to "what it is / when to open it" and, if
that file carries deep WHY, move the detail to an `APP_<TOPIC>.md` and end the line with a
pointer to it.
- `routes.js` — <what it is / when to open it>
- `public/index.html` — <…>
- ... (every significant file)

## Routes & Functions (entry points only — not a symbol dump)
A short **locator** that gets a planner to the right file and starting symbol. List only the
**entry points and change surfaces** — the handful of functions/routes/sections someone would
actually start from for a change — **not every function in the file**. The grep is free and
names are stable, so once the planner is in the right file they find the rest themselves. Aim
for the load-bearing few per file, not an exhaustive inventory; if a file's surfaces are
already covered by the "Where to change what" table, a one-line "see routing table" pointer is
enough. Each entry: name + ≤1-line *responsibility*. Never describe internals, parameters, or
branches — that is the source's job and it rots on every edit.
### routes.js
- `funcName` — <one-line responsibility>
- `GET /thing`, `POST /thing/:id` — <one-line responsibility>
### public/app.js
- `funcName` — <one-line responsibility>

## Dependencies
- **npm packages**: <list with purpose>
- **Bridge methods used**: <list>
- **External APIs**: <list>

## State
- Keys persisted via `state.get/set` — <key>: <what it stores>
- Keys in `.data/config.json` — <key>: <what it stores>
- Database tables — <table>: <purpose, key columns>

## UI Layout
<Describe the visual structure: panels, columns, modals, navigation.>

## Detail files
<Index of outsourced detail files, if any — see "Index & detail files" below. Omit this section if APP.md fits as a single file.>
```

### Map, don't mirror — the core rule

APP.md tells you **WHERE** to go and **WHY** the app is shaped the way it is. The source — read on demand, targeted to the symbols the routing table named — tells you **WHAT** the exact current code is. The doc must never duplicate the source's job:

- **Do** capture: architecture, design rationale, the routing table, invariants, gotchas, a one-line-per-file index, and a by-name locator list of routes/functions.
- **Do NOT** capture: line-by-line function internals, parameter-by-parameter behaviour, branch logic, exhaustive prose describing what each function does step by step. That is the cheapest thing to rederive (grep the name, read 30 lines) and the fastest thing to rot (changes on every edit). Mirroring it both bloats the injected context and breaks the accuracy contract the moment anyone edits a function body without perfectly updating its prose.

Rule of thumb: if a fact would change when someone edits a function's *body* without changing its *role*, it does **not** belong in APP.md.

### Reference functions by name, never by line number

List functions by **name + file** so the reader greps the name to land precisely. Do **not**
write `L<start>–<end>` line ranges anywhere: they go stale on the very next edit and actively
mislead a session that trusts the doc. A greppable name never rots.

### Index & detail files

APP.md is **injected in full** into every future change session, so it must stay compact —
ideally a tight map you can read in one pass. Outsource a feature area to an `APP_<TOPIC>.md`
detail file **only when its WHY is genuinely deep** — non-obvious rationale, intricate
invariants, subtle gotchas that need real explanation. A long but mechanical catalog (e.g. a
list of routes) does **not** need a detail file — it collapses to a locator list + the few
invariants that govern it. Don't outsource just because a section is long; outsource because
it carries deep, durable explanation that would bloat the map.

- **Detail files** live in the app root, named `APP_<TOPIC>.md` (uppercase topic, e.g.
  `APP_BODY_MAP.md`, `APP_ASSISTANT.md`).
- **What goes in a detail file**: the deep WHY/invariants/gotchas of one feature area — same
  map-don't-mirror rule applies (rationale and constraints, not function internals).
- **When to outsource**: when a feature area carries deep rationale/gotchas that would push the
  root map past a single comfortable read. Replace it in APP.md with a 1–3 line summary + a
  pointer line in this exact format:

  `**For more details, see \`APP_BODY_MAP.md\`** — <one-line description of what's in it>.`

- **Group related features**: features that are usually changed together belong in the **same**
  detail file. One `APP_<TOPIC>.md` can document several related features — don't create a file
  per feature.
- **Index every detail file** under APP.md's `## Detail files` section, each as a pointer line.
- **Always keep inline in APP.md**: Purpose, Architecture, Where to change what, Conventions &
  Invariants, Gotchas, Files, the by-name Routes & Functions locator, Dependencies, State,
  UI Layout, and the index. Only deep per-feature *explanation* gets outsourced.

### Sizing — bias toward a small, durable root

The root APP.md is injected into every session; its job is to be the **map**, not the manual.
Keep it small enough to keep accurate.

**Concrete budget**: aim for a root of **~6,000 tokens (~24 KB)**; treat **~8,000 tokens** as a
hard ceiling. Past the ceiling the map is taxing every future session and must be compacted —
move deep detail into `APP_<TOPIC>.md` files, collapse routing-table cells to pointers, and cut
file/function entries to one line each. These are rough targets (≈4 chars/token), not a precise
count — the point is to stay a tight one-pass read, not to hit a number. A change session is told
its app's current measured size and whether it is over budget; honour that signal.

- **Small app (source < ~800 lines total)**: a single APP.md is enough, and the locator can be
  fuller — but it is still a list of **entry points**, not a dump of every helper. Capture all
  invariants and gotchas; keep the locator to the surfaces a planner starts from. No detail files
  needed.
- **Larger app**: the locator must stay an **entry-point map**, not a symbol inventory. A big file
  (e.g. a 3000-line `core.js`) gets its handful of change-surfaces listed, not its hundred
  functions — the routing table + a few entry points orient the planner; the grep does the rest.
  Outsource a feature area to `APP_<TOPIC>.md` only when it carries deep WHY/gotchas (see above),
  not merely because it's long. The goal is "know which file + symbol to open, and what not to
  break" — never "read a prose copy of the code here." **Watch the root size**: if the locator is
  pushing the root long, it is too detailed — cut it to entry points.

### Accuracy is non-negotiable

Every fact in APP.md and its detail files must be correct. Never approximate, guess, or leave
stale information. The contract is what makes the doc trustworthy: a future session reads it
**instead of** re-discovering the app and decides on it. A wrong line is worse than a missing
one — it sends a trusting session in the wrong direction. Because the doc maps rather than
mirrors, keeping it accurate is cheap: after a change, update it only if you changed the app's
*shape* (architecture, a route's existence, an invariant, a file's role, a dependency, state) —
edits confined to a function's body usually need no doc change. When the shape changed, change
the doc in the same session.
