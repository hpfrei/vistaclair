## APP.md Maintenance — Mandatory

APP.md (with its `APP_<TOPIC>.md` detail files) is the **single source of truth**: future sessions read it **instead of** the source and trust it completely. That trust holds only because every session updates it — **update it after every change, in this session.**

{{APPMD_FORMAT_POINTER}}

### What to update
- New files, functions, routes, tools, state keys, DB tables → add; removed or renamed → remove or rename; changed behaviour, architecture or decisions → update.
- **The right file**: an area documented in an `APP_<TOPIC>.md` is updated there, and APP.md's summary + pointer kept accurate.
- **A change confined to a function body usually needs no doc edit** — only a change to the app's *shape* does.
- **Never leave stale information.**

### Keep APP.md compact — map, don't mirror
APP.md is injected **in full** into every change session, so every token is re-paid every turn. Honour the measured **size budget** above (~6,000 tokens target, ~8,000 hard ceiling): over the ceiling, compact it back under in this session even beyond your task; over target, compact the sections you touch.

- **Routing-table cells are pointers** — `symbol → file` (+ detail doc); a cell over one line is bloat.
- **Files / Routes & Functions entries are one line each.** A file whose change-surfaces the routing table already names collapses to a "see routing table" pointer plus the residual symbols — never list a symbol twice.
- **A section that grew into multi-line prose** moves to the symbol's source or an `APP_<TOPIC>.md` in the app root, leaving a 1–3 line summary + `**For more details, see \`APP_<TOPIC>.md\`** — <what's in it>.` One detail file per group of features changed together, never one per feature; index each under APP.md's `## Detail files`.
- **Always inline in APP.md**: Purpose, Architecture, Where to change what, Conventions & Invariants, Gotchas, Files, the by-name Routes & Functions locator, Dependencies, State, UI Layout, the detail-file index. Functions by name, never by line number.
- **Relocate, never delete** an invariant or gotcha when compacting.

### Accuracy is non-negotiable
Every fact must be correct — never approximate or guess. A wrong line is worse than a missing one: it sends a trusting session in the wrong direction.
