# Capability modules (`src/apps/capabilities/`)

The app-facing platform surface — what `routes.js` gets as `ctx`, what the
iframe Bridge dispatches, what the manifest can declare, and what the build
prompts document — is defined ONCE per capability, in
`src/apps/capabilities/<key>.js`. Do not add ctx members or bridge methods
anywhere else, keep per-profile removal lists, or require `./app-bridge` from a
capability or service module (cycle).

## The module contract

- **metadata** — `key`, `title`/`headings`, `core`, `gated`, `methods`,
  `prefixes`, `ctx` (member names), `aliases`, `impliedBy`, `runtime`,
  `keywords`, `summary`, `migration`. The prompt generators read these; the
  order is `ORDER` in `capabilities.js`.
- **`visibility`** — `{ standalone }`: `true` | `false` | `'partial'`, whether
  the ctx members exist in an own-process app. `'partial'` counts whole ctx
  members (`capabilities-check` rule 5); to hide a sub-key, omit it in
  `buildCtx` when `app.profile === 'standalone'` and let the standalone fixture
  pin the difference.
- **`flags`** — `{ '<key>.<name>[.<sub>]': () => boolean }`: feature flags that
  `ctx.capabilities.has/list` and `Bridge.call('capabilities.list')` report
  right after the module's key while it is visible, not revoked and the
  predicate is true (`fleet.sync`, `fleet.sync.up`).
- **`revocable`** — `true` for a module the admin may take away per app through
  the spend policy's `grants`. A revoked module is structurally absent from the
  ctx, refused on the Bridge and, when metered, blocked live. Modules an app
  needs to boot are never revocable.
- **`cost` / `audiences` / `spend`** — `cost` is `'free'` (default) |
  `'metered'` (platform-paid: ledgered and gated by the spend policy) |
  `'external'` (the app's own keys); `audiences` ⊆ `owner` / `user` /
  `anonymous` (default `['owner']`); a metered module declares `spend: {
  service, units: { method: unit } }` with units `tokens` | `audioMinute` | `second` |
  `kChars` | `image` | `request` | `free` and a default price in
  `spend-pricing.js`. `capabilities-check` rules 18–19 keep these honest.
  Most metered methods go through `spendGate.wrap`, which authorizes then
  settles one unit. A method whose provider bills only some of its operations
  (`ai.tiles3d` — only the root tileset; `ai.streetview` — only an image, its
  metadata probe is free) is exported unwrapped and calls
  `spendGate.authorize` / `settle` itself: a revoked app is still refused on
  every op, but the ledger records only what Google actually charged.
- **`buildCtx(app)`** — returns exactly the `ctx` members. `app` = `{ name,
  dir, manifest, broadcaster, profile, caps, legacy, resolvePath, ctx }`.
- **`bridge`** — `{ '<method>': async (app, params, io) => result }`; throw for
  errors. `io = { emitEvent, method }`.
- **`horst`** — the capability's contribution to Horst (optional):
  - `brief` — one line in Horst's chat system prompt (under
    `PLATFORM CAPABILITIES`, assembled by `buildSystemPrompt` in
    `platform-horst.js`). Starts with `` `<key>:` `` (`capabilities-check`
    rule 22).
  - `senses` — `[{ kind, description, defaultPolicy }]`, the bus kinds the
    module publishes, with `wire({ publish })` subscribing the owning service's
    hooks (`platformCron.onResult`, `appJobs.onFinished`, `spawnManager.onExit`,
    `aiService.observe`, `appDb.onStatus`, `sysmon.watchPressure`, an engine
    `registerHandler`) and returning a dispose fn. `publish` is scoped to the
    declared kinds. App subscribers share that bus, so a sense is also an
    app-visible event (`bus.md`, "The platform bus").
  - `tools` — `[{ def: { name, description, inputSchema }, handler(args,
    caller) }]`, platform tools registered under `__platform__`; the
    description says "Read-only", or the tool serves a direct-lane member of
    its module (it may produce an artifact or a metered answer, never act
    outward). Outward acts are kinds.
  - `lane` — required: Horst's stance (`direct` / `card` / `never`) on every
    member, backed by a tool, a kind or a stated reason
    (`docs/horst-lanes.md`, `capabilities-check` rule 26).
  - `kinds` — governance action kinds (below). `helpers.launcher(kind)` reaches
    executors that higher-level modules registered; use it rather than
    requiring an agent-side module.

  Never require `./horst-governance` or `./app-bridge` from a module; use
  `../horst-facet` (`req`, `textResult`, `emptyResult`, `limitOf`) for the
  boilerplate.

`ui` declares no `ctx` members and no bridge methods: its surface is the
`runtime` globals plus the `vc-*` web components in `public/vc-*.js` (served
as `/pro/vc.js`), documented in its SECTION's DETAIL blocks (`ui-<name>.md`).
A change to a component — e.g. `<vc-media-viewer>`'s `start`, `timeline`,
`.seek()` and `timeupdate` — is a change to that file and that DETAIL block.

## Kinds

A kind is `{ 'kind.name': { … } }`. The registrar copies each field explicitly
(`registerPlatformKinds` / `registerKind` in `horst-governance.js`), so a field
it does not name is dropped silently — the kind keeps working and quietly
loses the behaviour.

| Field | | Meaning |
|---|---|---|
| `label` | required | ≤80 chars, the kind's name to the owner |
| `execute(payload, proposal, helpers)` | required | performs the frozen payload |
| `ceiling`, `defaultLevel` | required | max autonomy the dial may grant; where it starts. App-registered kinds are clamped to `propose` regardless |
| `about`, `pinNote` | optional | ≤300 chars of explanation; why a ceiling is pinned |
| `validate(payload)` | optional | throws on a bad payload (defaults to accepting anything) |
| `describe(payload)` | optional | one-line summary (defaults to `label`) |
| `identity(payload, meta)` | optional | stable key for the ACT, or null. Omitting it disables dedup — the same act stages twice. See `horst-identity.js` |
| `card(payload, proposal)` | optional | the ONE card descriptor, projected to Telegram, the Mini App and the Horst tab by `horst-cards.js`. Omitting it sends the payload to the owner as raw JSON |
| `approveFrom(proposal, via)` | optional | null, or why an approval from surface `via` (`ui-full`, `ui`, `miniapp`, `telegram`, `app:<name>`…) may not stand; `decide` refuses it, the Telegram card drops Approve, and refusing `ui` marks the proposal `fullViewApprove` (Horst tab: full card only) |
| `compose(payload)` | optional | recomputes derived payload fields at every freeze point. Omitting it lets an edited payload keep a stale rendered body |
| `undo`, `idempotent` | optional | reversibility claims (`=== true`); they justify an autonomous default |
| `appProposable` | optional | `true`: apps may propose and edit this platform kind; absent, it is platform-owned and governance refuses an app that stages or edits it (`docs/governance.md`) |
| `notify` | optional | `'tg'` (default) or `'none'` — `'none'` means reviewed in the Approvals views, not pushed |

`capability` and `app` are set BY the registrar; never declare them. There is
no `tgCard`.

## The registry

`src/apps/capabilities.js` is the loader/registry: it validates every module at
boot (a malformed module, a method claimed twice, or a directory that disagrees
with `ORDER` refuses to start), builds the ctx per profile (`buildCtx(appInfo,
{ profile })` — `host`/`dashboard` get everything; `standalone` is shaped by
per-module `visibility`), and resolves bridge methods (`dispatch(method)`).
`app-bridge.js` is a thin facade: dispatch → error mapping, plus re-exports of
the service modules (`ai-service`, `ai-media`, `maps-service`, `web-search`,
`app-tools`, `app-state`, `app-settings`, `app-secrets`, `app-http`,
`spawn-manager`, `app-files`). `core-services.js` holds the host-injected
functions (`appBridge.init` sets them once; services read `core.x` at call
time). `listModelsWithAvailability` is one of them and must be forwarded: it
is core's credential join behind `ai.models`' `usable`; without it
`ai-service` falls back to key presence and every subscription-only Anthropic
model reads `no-credential`. `ai.models` filters: `configuredOnly` (only
`usable`), `enabledOnly` (not `disabled`, not retired, any credential state).
Media models are not in that registry: `ai.mediaModels` (`audio.js`) serves
`media-catalog.list()` — core's `listNativeModels()` joined with the
`src/apps/media/` adapters (`docs/models.md`). Speech tags (`ai.tts` `tags:
true`, `ai.ttsRender`) have one implementation, `media/speech-tags.js`; its
LLM pass is the app's own `ai-service.aiPrompt` (metered as `ai.prompt`).

The Horst side reads the same registry: `platform-horst.init` registers
`capabilities.horstKinds()` into governance (`registerPlatformKinds`, before
`governance.init`), injects `horstSenses()` into the bus catalog
(`bus.init({ senses })`), calls `wireHorstSenses({ publish })` after the engine
sources, and builds the `__platform__` tool pack from `horstTools()` plus the
brain tools. Governance keeps only its own kind (`mission.create`, reached
through a launcher, not a require); the bus keeps only the lifecycle/timer
builtins (`BUILTIN_KINDS`, including `app:error` / `app:crashloop`).

`capabilities-check` also keeps the two one-liners and their placement honest:
a `horst.brief` must start with `` `<key>:` `` and every module must carry a
`summary` of at most `SUMMARY_MAX` (80) chars (rule 22 — a renamed module
cannot keep a line naming the old key), and every heading a module declares
must lie inside that module's own `<!-- API:SECTION -->` block (rule 23), or
`.vistaclair/api/<key>.md` would not hold it.

**The reference is an index plus deferred sections.** Every capability owns
exactly one `<!-- API:SECTION key=<key> --> … <!-- /API:SECTION -->` block in
`prompts/_api-reference.md` (rules 7/8). `buildApiReference` keeps only the
blocks `sectionsToInline({ text })` selects — a keyword hit against the
request text and description, nothing else: the manifest never buys a section
into a prompt, `core` has no prompt meaning, and a `build-tools` session adds
`tools`. Every other block is dropped; its line in `buildSectionIndex()`
(`INDEX_MAX` 4,000 chars, one line per key: summary plus `**(inlined)**` /
`**(used here)**` from `capabilities-infer`) is the stub, and the launcher
writes the body to `.vistaclair/api/<key>.md`. What is outside every block —
intro, Trust Model, Frontend Utilities, the index, Bridge basics, the
`routes-ctx` stub — is paid by every session and capped at 10,000 chars
(rule 25, together with the index cap).

**Open-world interior**: every app gets the full platform surface, on the ctx
AND the Bridge, minus only what the admin revoked. The manifest's
`capabilities` object is an advertisement — documentation and a routing hint
for docs inlining, the Spend panel and tooling — never a gate;
`npm run infer:capabilities -- <appDir> --write` refreshes it (and
`manifest.events`) from the app's code, `--check` prints what `--write` would
apply and exits 1 when there is anything, and app-lint rule 18
(`stale-capabilities`) warns when the two have drifted.
`ctx.capabilities.has()`/`list()` and
`Bridge.call('capabilities.list')` feature-detect the profile's surface. The
perimeter decisions that remain: the access level (`apps.md`), per-module
`visibility.standalone`, and `audiences`; all economic control is the spend
policy (`spend.md`). A capability may NAME a perimeter URL but never route
it: `ctx.telegram.entryUrl({ customDomain: true })` reads the recorded
`manifest.domain` (the Website domain field of the app settings' Config tab,
`websiteDomainField`), while the redirects that land visitors there are
`surfaces.js` + `index.js` alone and the field's nginx block and Check are
`app-manager` (`apps.md`, "Access levels").

**Configurations** (`capabilities/config.js`): the one registry of what Horst
may change about how he reads the owner's world — `email.tags`,
`horst.docTypes`, `horst.triage` — each with a schema (`list` or `fields`),
`read()` and `apply(patch)`. `validatePatch` is the whole write contract; the
`config.set` kind, the Horst Settings editor and the `/pro/horst/api/config`
routes all go through `set()`. A configuration is declared there and nowhere
else; the leash (dials, paused, models, spend) is not a configuration.

## Adding a capability

Create `src/apps/capabilities/<key>.js` (with `summary` and `keywords`), add
`<key>` to `ORDER`, document it in `prompts/_api-reference.md` (one
`<!-- API:SECTION key=<key> -->` block holding a heading matching `title`),
add its `horst` facet — always a `lane` (`docs/horst-lanes.md`), plus senses, tools
and kinds if Horst should sense, read or act on it — then
`npm run check:capabilities && npm test && npm run test:fixtures`. Nothing else
needs editing — the senses join the Triggers catalog, the tools join the digest,
the kinds get dials. `test/fixtures/` snapshots the ctx surface per profile, the
bridge method list and the generated prompt sections; regenerate after an
intentional change.

**Keep the section tiered.** A SECTION block is paid in full by every session
whose request names the capability, so it may cost at most 12k chars once
inlined (rule 24, `untiered-optional`): past that, wrap the deep parts in
`<!-- API:DETAIL key=<key> --> … <!-- /API:DETAIL -->` blocks — a DETAIL block
is always replaced in the prompt by its first heading plus a pointer to
`.vistaclair/api/<key>.md`, which the launcher writes. Keys are unique — the key
IS the filename — and a heading a capability declares must OPEN its DETAIL
block, since only the first one survives the slice. `routes-ctx` is a DETAIL
key without a capability: the full `ctx` member list.

## One duty, one implementation

The three actors — the engine enforces, Horst judges, the owner decides — only
hold while each duty has a single implementation.

- **An app may not register a governance kind, or expose a platform-level tool,
  for an act a platform kind or platform tool already covers.** app-lint rule
  16 (`dutyOverlaps`, error) compares the app's `registerKind` literals and its
  `expose: "platform"` tool names against the live registry, matching on
  letters alone so `email_send` and `email.send` read as one duty. It reads
  source, not the registry (`registerKind` namespaces every app kind to
  `<app>:<kind>`, so the collision is invisible at runtime), and runs over the
  installed apps on every `npm test` (`test/duty-overlap.test.js`). An app
  keeps whatever tools it likes at `expose: 'self'`. The runtime half is
  `getPlatformToolUnion()` (`app-tools.js`): an app tool whose name the
  `__platform__` pack already serves is refused and logged. Two ordinary apps
  may share a name — consumers namespace the union by owner (`<app>__<tool>`).
- **A guardrail lives on the engine method, never only on the kind.** Every
  entry point (ctx, Bridge, governance executor, bot, cron) reaches the same
  method. Enforced by the engine-guardrail walk test.
- **A second face is scoping, not a second store.** `ctx.platform.cron`
  (caller-scoped, idempotent by `name`), `platform.cron.*` and per-app `cron.*`
  all store, schedule and run through the one `platform-cron.js` scheduler;
  the capability module only narrows what the caller may see and touch.
- **Editing a staged proposal** goes through `ctx.governance.update(id,
  payload)` + `decide`, never by dismissing the proposal and performing the act
  — that leaves the decision, the edit diff and the proposer-health signal out
  of the ledger.
- **Directory rule**: `src/apps/agent/` senses and judges, `src/apps/governance/`
  decides and executes; agent may require governance, governance never requires
  agent (it takes executors as launchers). See the README in each directory.

## AI calls get no tools by default

The `ai` capability (`ctx.aiPrompt`, Bridge `ai.prompt`) runs `ai-service.aiPrompt`;
a missing or `null` `allowedTools` means `[]` — no built-in tools, no sidecar,
the proxy gate strips every tool. A call that needs tools lists them
(`docs/app-tools.md` "aiPrompt gate"). The CLI child's env has no `AUTH_TOKEN` /
`VISTACLAIR_AUTH_TOKEN`. app-lint warns on a literal `aiPrompt` / `ai.prompt`
call without `allowedTools` (`ai-no-allowed-tools`) and on a list naming `Bash`,
`Write` or `Edit` (`ai-risky-allowed-tools`).
