# App tools: the MCP broker, contract, dependencies, run grants

The app-facing side of tools (`ctx.registerTools`, `expose`, `ctx.tools.call`)
is the `tools` section of `src/apps/prompts/_api-reference.md`. This doc is
the platform side: how those tools reach AIs outside the app. Long-running
job tools and the artifact store (files travelling with tools) are in
`docs/tool-jobs-artifacts.md`.

## MCP broker (`src/apps/mcp-broker.js`)

The platform's tool union as an MCP endpoint any owner-class AI can mount.
`POST /pro/mcp` is the default owner session (full union); `POST /pro/mcp/
sessions` mints a scoped session `{ task?, tools?, ttlMinutes? }` → `{ id, url,
token, tools, expiresAt }` (default 60 min, max 24 h, at most 50 at once),
listed and revoked at `GET` / `DELETE /pro/mcp/sessions[/:id]`; `POST
/pro/mcp/s/:id` is the minted session's auth-exempt, bearer-checked endpoint (the token is checked first; only bad tokens count toward the per-address limit, so a valid one is served even while the address is limited).
A call resolves the tool to its owning app via the union and runs in
spend-context `{ origin: 'mcp', principal: 'owner', subscribed }`. A tool
whose short name is a governance kind stages a proposal through
`requestAction` instead of executing; other tools run through
`callAppToolHandler`. A result that carries `content` passes through
untouched: every block type (`resource_link`, image, audio, embedded
resource), `structuredContent`, `_meta`. Anything else is wrapped as JSON
text. Holder sessions (next section) are a separate kind: no TTL, outside the
50-session cap (their own cap is 500).

**Built-in tools** — `registerBuiltinTool({ name, description, inputSchema,
when(session), handler(args, session) })`: platform tools a holder session
lists and serves beside its app tools while `when(session)` is true. They are
not in the app tool union and need no grant; owner sessions never list them.
Registered: the tool-job tools (`tool_job_status` / `_cancel` / `_reply`,
`docs/tool-jobs-artifacts.md` "Job tools") and, behind a module probe,
`artifact-tools.js`'s `builtinTools` and `sound-tools.js`'s `builtinTools`.

`sound_generate({ prompt, dest?, durationSeconds?, loop?, promptInfluence?,
format?, sampleRate?, model? })` (`sound-tools.js`) — a sound effect for a
CLI session (orchestrator and worker holders; `when` = a run holder, as the
artifact tools). It calls `ai-media.aiSfx` (`docs/models.md` "Sound effects"),
stores the clip as an artifact the run may read, and with `dest` (relative to
`holder.cwd`, the `artifact_fetch` path rules: nothing outside the cwd, no
symlink; checked before the clip is generated) also writes the file there.
Returns text JSON `{ uri, path?, mime, format, ext, sampleRate,
durationSeconds, bytes, model, loop?, ignored? }` plus the `resource_link`.
Spend: appName `platform` (Horst's profile) inside a spend context carrying
the run's identity (origin `mcp`); a spend refusal comes back as an error
result. Listed wherever a holder session exists: an orchestrator's `catalog`
server (including an orchestrator build/change session) and a worker's `grant`
server (a worker gets one only when its launch passed `tools`). Plain sessions
(`build-tools`, resumes, hidden `cli.edit`) have no broker and no tool.

### `authorizeToolCall` — the one choke point (`app-tools.js`)

`authorizeToolCall(caller, '<app>__<tool>', { app, tool })` →
`{ allow }` or `{ allow: false, reason }`. Every app-tool call passes through it
exactly once. `callAppToolHandler` covers aiPrompt sidecars, `ctx.tools.call`,
cron, the GUI tester and the broker's plain calls; the broker's governed-kind
branch calls it itself. It applies the expose levels, a holder caller's scope
(a worker's grant; `null` is an orchestrator's full union) and, for an `app`
caller on another app, the dependency edges ("Dependencies" below); a tool's
side-effect policy would plug in here too. A `horst` caller (an owner chat
turn, `docs/tool-jobs-artifacts.md` "Horst route") is platform-class for the expose levels. The caller
(`callerRecord`: `{ type, appName, runId?, address?, workerId?, orchestrator?,
conversationId?, chatId?, surface? }`) is recorded in the audit ring
(`caller`) and in the spend context (`spendContext.caller()`).

### aiPrompt gate (`ai-service.prepareToolGate`)

An `ai.prompt` call's `allowedTools` is written to a tmpdir marker
(`vistaclair-ai-allowed-<instanceId>.json`) that core's `ai-tool-gate` proxy
rule enforces on every API request: `[]` → `{ none: true }` (all tools
stripped); a non-empty list → `{ tools }`, kept by exact name or `*` prefix;
omitted or `null` → `[]` (`normalizeAllowedTools`), so a marker is always
written and no call is ungated; a non-array value throws. The CLI child's
env drops `AUTH_TOKEN` / `VISTACLAIR_AUTH_TOKEN` (`CHILD_ENV_STRIP`, passed as
`extraEnv`); the app-tools sidecar gets only its per-call token. The sidecar carries only the granted
app tools. A non-empty list always gets `ToolSearch` added (`withToolSearch`,
in the marker and in `--allowedTools`): the CLI defers tool schemas, and the
model loads one by name before calling it. That widens nothing: the gate
still strips every ungranted tool, and ToolSearch can only load a schema the
request carries.

## Tool contract (`app-tools.js`)

`registerAppTools` keeps, beyond `name`, `description`, `inputSchema`,
`timeout`, `expose` and `kind` (app-facing: the "tool contract" part of the
`tools` section of `_api-reference.md`):

| Field | Stored as |
|---|---|
| `sideEffects` | `none` / `writes` / `external`; absent → `writes`; any other value throws (as `expose` / `kind` do) |
| `returns` | a JSON Schema object (copied) or prose trimmed to 300 chars; anything else → `''` |
| `artifacts` | `{ accepts?, produces? }` of mime types / globs, lower-cased; invalid entries dropped; omitted when empty |
| `examples` | the first 3 `{ args, note? }`; arg-less ones dropped; each checked with `checkShallow(inputSchema, args)` |
| `version` | trimmed string, ≤ 40 chars |
| `contractHash` | sha256 hex of the canonical JSON of `contractOf(tool)` |

A malformed optional field is warned (`[app-tools] <app>.<tool>: …`) and
dropped, never a refused registration. All of it reaches `manifest.tools`, the
platform union and `tools_describe`.

- **`contractOf(tool)`** → `{ inputSchema (without _wait / _plan), returns, kind,
  sideEffects }`, defaults filled. **`contractHash(tool)`**: object keys
  sorted at every depth, `required` sorted, so key order never changes it.
- **`compareContracts(before, after)`** → `{ compatible, problems: [] }`.
  Incompatible: an input property removed (a rename is a removal), newly
  required, a narrowed type or enum; a kind change; `sideEffects` escalated
  (`none` < `writes` < `external`); a schema `returns` dropped, or a result
  property removed or retyped. Prose `returns` is never compared. Top level
  only.
- **`app:tools:contractChanged`** `{ appName, tool, before, after, compatible,
  problems }` (hashes) — broadcast by a registration whose hash differs from
  the previous one: the in-memory entry, else the manifest's (a manifest from
  before `contractHash` is hashed on the fly, so the upgrade alone is silent).
- **`checkResult`** — after a quick call, and after a job tool's handler, a
  `structuredContent` is checked against a schema `returns` (`checkShallow`:
  type, enum, required keys, top-level property types, `additionalProperties:
  false`). A mismatch is a warning; the result is returned untouched. Error
  results are not checked.
- **`returnsText(returns)`** — a schema as one line (`description — { a, b?:
  type }`), for the readers that print text: the cross-app sidecars
  (`app-builder-prompt.js`) and the change-request snapshot.
- **Lint** (`app-lint.js` rule 14, warn): an exposed tool without `returns`
  (`tool-returns`), with prose `returns` (`tool-returns-schema`), without
  `sideEffects` (`tool-side-effects`); `tool-drift`: a handler with no
  registered tool, a tool with no handler, a `manifest.tools` name the code
  never registers (all of them when the app never calls `registerTools`);
  `tool-examples`: a `manifest.tools` example that misfits its schema. Drift
  is skipped where names are computed (`name: d.name`, `onToolCall(t, …)`).
  `tool-async-not-job`: a tool without `kind: 'job'` whose own `description:`
  / `returns:` lines (`+` continuations included) say asynchronously, returns
  immediately / at once, returns … a jobId, ready shortly or runs in the
  background (`ASYNC_TEXT_RE`), or whose handler statement calls
  `jobs.start(` and names `jobId` (`startsJob`); checked in `routes.js` even
  when it looks vendored.

Not built: enforcing `sideEffects` in `authorizeToolCall`; deep (nested)
schema checks.

## Dependencies (`src/apps/app-deps.js`)

An app that calls another app's tools must have been built for it. The edges
live in `<dataHome>/app-deps.json` (seeded empty at boot; none is invented):
`{ id, consumer, provider, tools: [names] | ['*'], purpose, status:
approved|observed|revoked, origin: { type: change-request|declared|observed|owner,
ref? }, contract: { <tool>: contractHash }, snapshot: { <tool>: contractOf },
contractStatus: ok|changed-compatible|broken, contractProblems, createdAt,
approvedAt?, lastCallAt?, calls, errors }`. At most one approved and one
observed edge per pair; revoked edges stay. API: `list`, `get`, `declare`,
`approve` (also re-approve), `revoke`, `observe`, `recordCall`, `forProvider`,
`forConsumer`, `overview`, `readEdges` (fs only, for app-lint).

| Source | Edge |
|---|---|
| a tool change request reaches `done` (`fromChangeRequest`) | approved, `origin: change-request`, ref the request id |
| `app-change.js depend --on <app> --tools a,b --why "…"` → `POST /pro/apps/deps/depend` (`depend`) | approved, `origin: declared`; refuses an unknown tool or one not exposed `apps` |
| an app→app call with no approved edge (`observe`) | observed; the owner's Approve makes it approved |

- **Enforcement** — `authorizeToolCall` → `appDeps.authorize` for `app`
  callers only (an app on itself is `self`). Platform setting `appDepsEnforce`:
  `warn` (default) allows, records observed and sets `undeclared: true` on the
  audit entry; `enforce` refuses, naming the missing edge and the `depend`
  command (the edge is still observed, so the owner can approve it). `['*']`
  covers every `apps`-exposed tool. Every app→app call updates `calls`,
  `errors` (thrown or `isError`), `lastCallAt` (saved debounced).
- **Contract protection** — on `app:tools:updated` / `app:tools:contractChanged`
  (`observeBroadcast`) each approved edge on the provider is judged against
  its approval snapshot with `compareContracts`: same hash `ok`, compatible
  `changed-compatible`, otherwise (or removed, or no longer `apps`) `broken`,
  which fires a `toast:push` to the owner. Re-approve stores the current
  hashes. A named tool not yet registered at approval adopts its first contract.
- **Prompts** — the provider's change prompt and `migration.md` carry
  "Used by other apps" (consumer, tools, the backwards-compatibility rule);
  a consumer's `.vistaclair/apps/<provider>.md` says "Declared dependency:
  yes/no". app-lint `tool-dependency` (warn): a literal `ctx.tools.call('<app>',
  '<tool>')` without an approved edge (skipped when no edges file is found).
- **Setup → Tools & Access** — WS `app:deps:get` → `app:deps { mode, edges,
  health: { exposedUnused, idle (approved, 30 days uncalled), undeclared (audit) },
  agentGrants (broker holder sessions by run → address, read-only) }`;
  `app:deps:approve` / `:revoke { id }`, `app:deps:setMode { mode }` re-broadcast
  `app:deps`; the module broadcasts `app:deps:changed` on structural changes.

Not built: lint drift counts in the pane; edges for agents (they keep run grants).

## Tool grants for orchestration runs (`app-tool-packs.js`)

App tools reach core's orchestration runs and nothing else, through two core
tool packs (`docs/seam.md`). Each spawn of a run member mints a broker
**holder session** bound to `{ type: 'orchestrator'|'worker', runId, address
(settings.name), instanceId, workerId?, orchestrator?, cwd? }` (`cwd`: the
pack `build`'s working directory, where `artifact_fetch` writes):

| Pack | Role | Serves |
|---|---|---|
| `app-tools-catalog` (default) | orchestrator | MCP server `app-tools`, a `catalog` session: `tools_search({ query, app?, limit? })` → `{ name, app, kind, sideEffects, contractHash, summary }` entries; `tools_describe({ names })` → every field the registry holds for each tool (unknown fields pass through), `inputSchema` included; `tools_call({ name, args })` → the normal call path under the orchestrator's caller. Its prompt says: pick tools with search/describe, give each worker the smallest list via `launch_cli` `tools`, resume a blocked worker with a corrected list via `resume_worker` `tools`, and use `tools_call` for quick lookups only |
| `app-tools-grant` (default, `consumes: ['tools']`) | worker | MCP server `apps`, a strict `grant` session serving exactly `settings.grants.tools`; an empty list serves nothing (never a fallback). `validate` refuses the launch on an unknown name and suggests close matches; the prompt lists the held tools and says to report blocked when a tool is missing, never to work around it. A granted tool whose app has since stopped is named in the prompt and not served |

Plain sessions match neither role and get nothing. Each spawn (a resume
too) re-mints, revoking the holder's previous session of that mode; `release`
revokes on exit; the orphan sweep (every 60 s tick, the first after boot
included) revokes a holder session older than 2 min whose `instanceId` has no
running session in core's `cliSessionManager` (unknown liveness keeps it). The
holder identity reaches the handler's `caller`, so a handler can address the
worker (`caller.address`) or its orchestrator (`caller.orchestrator`).
Feature-probed: the catalog pack needs `ctx.registerToolPack`; the grant pack
also needs `consumes`, `validate` and `release` in `ctx.toolPackFeatures`.
With an older core, Pro registers less and logs once.
