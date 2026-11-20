# The core ⇄ Pro seam (do not break)

The platform lives in `platform/` of the vc repo and always loads
(`server.js` requires `./platform`; a load or init error exits 1). Core imports
nothing from `platform/`. The platform loads exactly ONE core file by path —
`src/addon-host.js`, from `platform/app-runner.js`, to bootstrap the headless ctx — and
otherwise communicates only through the `ctx` object and the descriptor `init()`
returns. Never require any other core file, and never re-implement a core
decision (auth, paths, keys) on this side: if something is missing from the ctx,
add it to core's `src/addon-host.js` (additively) and consume it from the ctx.

## The ctx — one factory, two profiles

Core builds the ctx in one place, `src/addon-host.js` `createAddonCtx()`:
`server.js` calls it with the dashboard's in-process services (dashboard
profile); `platform/app-runner.js` calls it with `{ loadEnv: true }` (headless profile,
for own-process / standalone apps outside the dashboard). The object is frozen;
`apps.init({ ...ctx, … })` spreads it, so every field is contract.

| Field | dashboard | headless | Notes |
|---|---|---|---|
| `contractVersion` | 2 | 2 | checked against `descriptor.contractVersion` by core's `addons.js`; Pro's `init()` also asserts the fields it needs |
| `headless` | false | true | |
| `coreDir`, `dataHome` | ✓ | ✓ | core package root; core's `DATA_HOME` |
| `authToken`, `dashboardPort`, `proxyPort` | ✓ | ✓ | |
| `getProxySecret()`, `proxySecretHeader` | ✓ | ✓ | the per-boot secret core's local API proxy requires before it attaches stored OpenAI/Gemini keys, and its header name. Optional: an older host lacks them. `proxy-env.js` adds it (`ANTHROPIC_CUSTOM_HEADERS`, keeping existing lines) to the shells Pro starts itself — ctx `exec` / `spawn`, app-scoped cron shell jobs; absent → no header, nothing else changes |
| `spawnClaude(args, opts)`, `buildClaudeArgs(opts, extra)` | ✓ | ✓ | signatures frozen — core keeps them byte-compatible |
| `secretStore` | ✓ | ✓ | core's aes-256-gcm store (`readSecretFile`/`writeSecretFile`); every `.enc` file Pro writes goes through it — Pro has no cipher code of its own |
| `resolveHeadlessAuth`, `resolveProviderKey`, `setProviderKey`, `listModels` | ✓ | ✓ | key/model registry, bound to `dataHome` |
| `claudeAuthInfo()` | ✓ | ✓ | `{ hasSubscription, pref, email, orgName }`: the `claude` CLI's login and the account `claude auth status` names (strings, null while signed out; never a credential). Remote sessions compare `email` / `orgName` for `sameAccount`; an older core has no account fields (`docs/remote-sessions.md`) |
| `resolveAuth(authMode?)`, `listModelsWithAvailability()` | ✓ | ✓ | core's credential decision. `resolveAuth` → `{ credential: 'subscription'\|'api-key'\|null, key }`; `listModelsWithAvailability` is `listModels` with that join applied per model (`usable`, `unusableReason`, `credential`). Pro never re-derives availability from key presence — Anthropic models are callable on a CLI OAuth login with no stored key |
| `listNativeModels()`, `refreshModels()` | ✓ | ✓ | the non-text model list (`native-models.js`, no secrets) and the text-registry refresh (`caps.refreshModelRegistry`: provider scan + models.dev; the Models page runs the same). Optional: an older host lacks them — the media catalog uses adapter seeds, the model review skips the text refresh (`docs/models.md`) |
| `exportKeyBundle`, `importKeyBundle` | ✓ | ✓ | master→slave sync; the export carries real keys — peer control plane only |
| `isOwnerRequest(req)` | core's auth decision (`src/auth.js`) | `() => false` | the same decision core's middleware makes; used on auth-EXEMPT paths where owner and anonymous traffic both arrive. Pro takes the decision at the `/apps` dispatcher while core's `x-vistaclair-internal` is still on the request, keeps it as `req._vcOwner` (`internal-headers.js`), then strips every `x-vistaclair-*` header before app code or the proxy sees the request |
| `isOwnerConnection(ws)` | `broadcaster.isOwnerConnection` | `() => false` | for a WS message handler: true only for an open dashboard socket that passed the owner check at its upgrade. The remote-session owner messages refuse on false; feature-detected (an older core: every dashboard socket is the owner's) |
| `login` | ✓ | absent | core's dashboard login challenges. `registerProvider({ id, label, link(code) })` → `unregister()` (`id` `/^[a-z0-9-]{1,32}$/`; `link` is asked per challenge, returns an https URL or null = no QR, a throw = null); `describe(code)` → `{ code, createdAt, expiresAt, ip, ua, status: 'pending'\|'approved'\|'denied' }` or null; `approve(code, { via, who })` → `{ ok }` / `{ ok: false, reason: 'unknown'\|'expired'\|'used'\|'denied' }` (`via` as `id`, `who` ≤ 100); `deny(code)` → boolean; `listSessions()` → `[{ id, createdAt, expiresAt, ip, ua, via, who }]`, `revokeSession(id)` → boolean, `revokeAll()`; `onLogin(fn)` → `unsubscribe()`, `fn({ via: 'token'\|'login-link'\|<approver's via>, ip, ua, sessionId, code, external })` after every dashboard login (`sessionId` null for a token login, `code` only for a challenge). Codes are 8 characters. Feature-detected (`platform-login.js`): absent → no Telegram QR login, sessions or login alerts (`docs/telegram-control.md`) |
| `broadcaster` | live hub: `.broadcast`, `.registerHandler(prefix, handler)`, `.onBroadcast(fn)` | `{ broadcast }` loopback relay to `/api/internal/broadcast` | |
| `registerAiSession(instanceId, sessId?)`, `unregisterAiSession` | store-backed (persistent inspector timeline) | stub UUID / no-op | the optional explicit UUID pins a headless session's transcript id so it can be `--resume`d later |
| `store`, `cliSessionManager`, `scheduleRestart`, `pendingQuestions`, `clearPendingQuestionsForTab` | ✓ | absent | dashboard-process state; consumers must tolerate absence in the runner. Pro asks the owner through `pendingQuestions` the way core's `askUser` does: an entry `{ formData, questions, message, ctx: { tabId }, resolve, reject }` plus the `ask:question` `message` on the broadcaster (the dashboard replays it on reconnect and resolves it on `ask:answer`) — `confirmApiKeyBilling` in `index.js` |
| `launchSession(tabId, { spawnOpts: { resumeSessionId } })` (via `cliSessionManager`) | ✓ | absent | reopen a recorded transcript as an interactive tab; throws when no transcript exists |
| `launchSession(tabId, { settings: { settingsFile } })` | ✓ | absent | a Claude Code settings file path, passed through to the CLI as `--settings`. Pro writes one per launch (`<appDir>/.vistaclair/hooks.json`, the read-ledger hook and CLAUDE.md discovery off; `<appDir>/.data/workspaces/<name>/settings.json`, a workspace session's `claudeMdExcludes`) rather than generating a project `.claude/settings.json` that would travel with the app |
| `launchSession(tabId, { settings: { sessionsRoot } })` | ✓ | absent | the directory holding the session's folder (`<sessionsRoot>/<key>/TODO.md`, `NOTES.md`; core `src/session-folders.js`); default `<core>/data/sessions`. Inherited by an orchestration run's members. Pro passes `<appDir>/.vistaclair/sessions` |
| `openCli({ tabId?, cwd, …launchSession opts, mode?, engine?, auth?, runsDir?, isolation? })` | ✓ | absent | the user-facing "new CLI" (core `src/orchestration.js`). `mode` `'simple'` \| `'orchestrator'`, `engine` `'cli'` \| `'sdk'` (a PTY tab or an Agent SDK panel; core's `settings.engine`), `auth` `'apikey'` \| `'subscription'` (an SDK session's billing, `settings.auth`; asked only when both credentials exist, else the form names the one in use); what is unset is asked in one dashboard ask form (replayed on reconnect). Resolves `{ tabId, mode, engine, auth }` (`auth` null for a CLI terminal) or `{ cancelled: true }`; an older core ignores `engine` and runs the CLI. `'orchestrator'` makes the launch an orchestration run: fresh transcript, the caller's prompt, settings file and stamps become the base every worker inherits. `launchSession` stays the never-asking primitive |
| `cliSessionManager.sessions` | ✓ | absent | the Map of every tab, hidden ones included (`list()` skips hidden). Pro reads `session.running`, `.hidden`, `.getSettings()` to find a workspace session by its stamps (`cli-workspace.js`), and `.instanceId` + `.running` for the broker's holder-session orphan sweep |
| `sendToSession(address, text, { from })` | ✓ | absent | delivers a message into a running orchestration-run session by its messaging address, as SendMessage does (`[message from <from>] …`). Returns `{ delivered, how }`, `how` `'submitted'` \| `'queued'` or why not. Long tool jobs report their outcome through it (`app-tool-jobs.js`) |
| `orchestration` | ✓ | absent | core's run board, frozen: `{ listRuns(), describeRun(runId), pauseRun(runId), resumeRun(runId, { fresh }?), refreshOrchestrator(runId), setRunAuth(runId, auth, { continueTurn }?), setRunModel(runId, model) }`. `listRuns` → every run a live or saved session is stamped with, newest first: `[{ runId, name, title, cwd, engine, state, busy, paused, pausing, orchestratorTabId, orchestratorSessId, workerCount, updatedAt, mirror? }]`; `describeRun` → core's `describeRun` (no `events`; used when present), null for an unknown run; both carry `mirror: { host, orchestrator }` (`describeRun` also `key`, `closed`) on a mirror run, whose `state` is `'mirror'` \| `'closed'`; the actions throw what the run board shows, and for a mirror run (pause, resume, refresh) that it is run from its master (`platform-tg-runs.js` skips mirror runs). Pro does not call `setRunAuth` / `setRunModel`. Feature-detected (`platform-tg-runs.js` `enabled()`): absent → the Telegram run features are off, nothing else changes. `openMirrorRun({ key, orchestrator: { address, host }, deliver })` → `{ runId, launchWorker, submit, interrupt, kill, close }`: a run whose orchestrator lives on the federation master, re-opened by key after a restart (`docs/federation.md` "Remote workers"); `launchWorker({ title, task, cwd, auth?, model?, settings? })` → `{ tabId, address }` of an SDK worker (`cwd` absolute; `settings` the caller's stamps and `sessionsRoot`); `deliver({ address, kind: 'report', status, summary } \| { address, kind: 'message', text })` gets the member's report / SendMessage; `submit(address, text, { from }?)`, `interrupt(address)`, `kill(address)` act on a member, `close()` closes the members and the run; feature-detected by `peer-remote-slave.js` (absent → `member.launch` is `unavailable`). `registerHostProvider({ hosts, launch, kill })` → `{ deliver(msg), unregister() }`: the master's remote workers — `launch_cli({ host })` makes a run member on a linked slave (`hosts()` → `[{ name, label, available, reason? }]`; `launch({ runId, address, title, task, host, app, model?, auth?, orchestrator: { address, title } })` (`auth` `'apikey'` only when the run bills the API key; `peer-remote-host.js` then bills the slave's key) → `{ tabId }` of a `registerExternalSession` tab once the owner approved, or rejects with `.code` `declined` \| `refused` \| `unavailable` \| `invalid` \| `failed` \| `cancelled`; `kill({ runId, address })`); `deliver({ runId, address, kind: 'report', status, summary } \| { runId, address, kind: 'message', text })` hands the member's report / SendMessage to core as a local worker's. Core routes SendMessage to the member as `adapter.submit(text, { from })`. Feature-detected by `peer-remote-host.js` (absent → no provider; the Remote pane says runs need the core update; `docs/remote-sessions.md` "Remote workers") |
| `registerToolPack(pack)`, `unregisterToolPack(id)`, `listToolPacks()` | ✓ | absent | core `src/tool-packs.js`: MCP servers, disallowed tools and prompt text added to dashboard sessions by role (`orchestrator` / `worker` / `plain`). Pack fields `id, description, roles, default, build({ settings, instanceId, role, cwd, sessId })`, plus `consumes`, `validate({ settings, role })` (throw = launch refused) and `release({ settings, instanceId, role, sessId, reason })` where `toolPackFeatures` lists them |
| `registerExternalSession(tabId, adapter)` | ✓ | absent | core `src/external-session.js`: lists a session hosted elsewhere as an SDK tab (`external: true` in `cli:tabs`, announced as `cli:spawned`) and routes `sdk:send` / `interrupt` / `setModel` / `setThinking` / `history` / `todo` (from `settings.sessionDir`), `cli:sessionAuth` / `cli:interrupt` / `cli:kill` / `cli:closeTab` to the adapter, each awaited, a throw or rejection answered to the requesting browser only. Returns an idempotent `unregister()` function (`cli:exit`, then `cli:tabs` without it); `close()` leaves the unregistering to Pro. tabId `[A-Za-z0-9._:-]` ≤ 100; title capped at 200, `settings.externalHost` at 100. Never persisted, restored or killed by core. Pro broadcasts the session's `sdk:event`. Used by remote sessions (`docs/remote-sessions.md`); feature-detected — absent, a remote session has no tab |
| `toolPackFeatures` | ✓ | absent | frozen array of the optional pack fields core honours (`'consumes'`, `'validate'`, `'release'`). Absent on an older core |

Fields are added additively under the same `contractVersion`; removing or
reshaping one is a version bump in both repos.

## The descriptor

`init()` returns `{ contractVersion, id, router, clientModules,
authExemptPaths, authExemptPatterns, authExemptUpgradePaths, handleUpgrade, platformTools,
shutdown }`. Core
mounts `router` after its auth middleware (there is no `dashboardApp` on the
ctx — routes go through the descriptor), reads `authExemptPatterns` per request
(the live array — mutation suffices), and offers WS upgrades to `handleUpgrade`
first. `authExemptUpgradePaths` holds exact pathnames (today
`['/api/peer/channel']`, `peer-channel.js` `CHANNEL_PATH`): an upgrade whose
pathname matches is offered only to this add-on's `handleUpgrade`, without the
owner gate, and core answers 401 if it isn't claimed. `handleUpgrade` must
self-authenticate and claim (return true for) every request on those paths. An
older core ignores the field; the owner gate then 401s the upgrade and the
channel stays down. Additive: `contractVersion` stays 2.

`clientModules` reach the dashboard through core's owner-authed
`GET /api/addons/client-modules` (`addons.getClientModules()`), which
`public/addons-loader.js` fetches to link the styles and load the scripts in order.

`platformTools` (optional, `src/apps/platform-tools.js`) is what core's
dashboard voice input reads through `addons.platformTools()`:
`putArtifact(buffer, {mime, name}) → {uri}` stores an owner artifact (producer
`{ platform: 'dashboard', tool: 'voice-input' }`); `call(tool, args)` runs
`platform__audio_transcribe` (nothing else) through `callAppToolHandler` as
`{ type: 'platform' }`, so authorization, audit and the platform spend policy
apply. An older core ignores the field.

The broadcaster plugin registry (`registerHandler('app:', { onConnect,
handleMessage })`) and the `app:bridge:event` message shape (`{ type, appName,
event, data }`, routed to the owning app's iframe by `appName` in
`app-bridge-client.js`) are part of this contract.

## Tool packs Pro registers

`src/apps/app-tool-packs.js` registers them from `apps.init` and unregisters
them in `shutdown()` (`docs/app-tools.md` "Tool grants for orchestration runs"):

| Pack | Roles | Needs | Gives |
|---|---|---|---|
| `app-tools-catalog` | orchestrator (default) | `registerToolPack` | MCP server `app-tools` (`tools_search` / `tools_describe` / `tools_call`) + prompt |
| `app-tools-grant` | worker (default), `consumes: ['tools']` | `toolPackFeatures` ⊇ consumes, validate, release | MCP server `apps` serving exactly `settings.grants.tools` + prompt; `validate` rejects unknown names |

Pro reads `settings.orchestration.{role, runId, workerId, orchestrator}`,
`settings.name` (the session's address) and `settings.grants.tools`. Both
servers have the shape both engines take (CLI `--mcp-config`, SDK
`options.mcpServers`): `{ type: 'http', url:
'http://127.0.0.1:<dashboardPort>/pro/mcp/s/<id>', headers: { Authorization:
'Bearer <token>' } }`.

## Model-override precedence (core proxy)

When a request flows through the core proxy, model routing is applied in this
order: 1. tab-level `modelMap` (per CLI session, family-substring match
opus/sonnet/haiku); 2. global proxy rules (e.g. `model-override.js`). Tab
overrides win; proxy rules see the already-mapped model.
