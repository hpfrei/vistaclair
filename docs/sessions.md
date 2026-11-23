# App build & change sessions

Everything that happens when the platform opens a Claude Code session on an app
directory: the launcher, the prompt it assembles, the sidecars the session reads,
the ledger that records those reads. The change requests one app sends another
are in `change-requests.md`. The app shape those sessions write against is `apps.md`; the capability
registry the prompt is generated from is `capabilities.md`.

## The launcher

A change or new-app request opens ONE interactive Claude Code tab, cwd'd to the
app directory, with a system prompt assembled by `app-builder-prompt.js`
(`buildPrompt(action, …)` — the action IS the prompt filename in
`src/apps/prompts/`):

| Trigger | action | tab | prompt |
|---|---|---|---|
| app row / app settings **Change** (`openCli`) | `extend` | `app-<name>` | `extend.md`, empty input; resumed onto the app's own transcript when it has one. Asks Simple / Orchestrator and the engine first (below) |
| **+ New app** (`app:create` → `app:created`) | `build` | `app-<name>` | `build.md`, auto-submits `Build the app "<name>": <description>` |
| Tools tab | `build-tools` | `app-<name>-tools` | `build-tools.md`. Simple; CLI unless `msg.engine` |
| APP.md upkeep | `recreate-appmd` | `app-<name>` | `recreate-appmd.md`. Simple; CLI unless `msg.engine` |
| `cli.edit`, Telegram control bot, change request (`launchChangeSession`) | `extend` / `params.action` | `app-<name>` | Agent SDK orchestrator, the request auto-submitted (below) |

Both entry points land in the `app:spawnCli` case of `handleMessage`; the
action defaults to `extend` when the app dir has source and `build` when it
holds only `manifest.json`. `launchChangeSession()` is the shared launcher for
`cli.edit`, the Telegram control bot and change requests and owns the APP.md
pre-flight: an app with source but no `APP.md` runs a visible `recreate-appmd`
session first (simple), chained through `cliSessionManager.onExit`; the raw `app:spawnCli` path has
`registerAppMdCheck` as a post-exit net, on the ended session's engine. Both
relaunch a tick later (`relaunchAfterExit`): core drops the tab after its hooks.

**The standing rules.** One text, `src/apps/prompts/_standing-rules.md`
(`standing-rules.js`): scope, never start/stop the app, APP.md before source,
Read/Grep over dumps, an exploration agent for a sweep only, ask before
guessing, the gate, verify once, update APP.md, the orchestrator/worker split.
Every launched prompt inlines it (`{{STANDING_RULES}}`) and runs with CLAUDE.md
discovery off (`hooks.json`: `env.CLAUDE_CODE_DISABLE_CLAUDE_MDS`; the net is
`claudeMdExcludes` `<appsDir>/**/CLAUDE.md`), so no CLAUDE.md can add to it.
`<appsDir>/CLAUDE.md` is the same text generated for sessions opened by hand
(`npm run apps:claudemd`; `test/standing-rules.test.js` fails on drift).
Headless runs (`aiPromptOnce`, `aiRepairJson`) pass `--setting-sources user`.

**What the session reads.** App sessions cannot see this repository. Their
documentation is a brief prompt plus the sidecars every launch rewrites into
`<appDir>/.vistaclair/` (`writeSidecars`; `.vistaclair/` gitignored):

| Sidecar | Holds |
|---|---|
| `api/<key>.md` | one capability section, or one `API:DETAIL` body (`routes-ctx` = the full `ctx` member list) |
| `api-reference.md` | the whole reference (large; the index names it last) |
| `migration.md` | `buildMigrationRules()`, the connected mail/Google accounts, the other apps' tools block and the Platform Duty Rules |
| `platform-request.md` · `app-request.md` | the two request procedures (`_platform-request.md`, `_app-request.md`) |
| `scaffolds.md` · `appmd-format.md` | the scaffold code (`_scaffolds-detail.md`) · the APP.md format and examples |
| `appmd-maintenance.md` | the APP.md maintenance block (`_appmd-maintenance.md`): inlined in the full change prompt, the lean worker prompt points here |
| `apps/<app>.md` | one per provider, see below |
| `api/.generated.json` | `{ at, version, commit, files }` — when and from which Pro build the doc copies were written |

`api/`, `api-reference.md` and `apps/` are the **doc copies**
(`refreshDocCopies(appDir, appName)`, which `writeSidecars` calls). They are also
refreshed outside a launch by `src/apps/doc-copies.js`, for every app that
already has a `.vistaclair/` (none is created): once at boot after autostart,
and — debounced 5 s, off the registration path — every other app's `apps/`
after an `app:tools:updated`, an `app:renamed` or an `app:list` whose set of
names moved (install, remove). So a session opened by hand, or one running
across a platform update, reads current docs. A copy is written only when its
content changed, a key or provider that is gone loses its file, and the
launch-owned files below are never touched by a refresh.

**Lean worker prompt.** An orchestration run's workers do not need the
full change prompt (the file list, the API reference body, the maintenance
block: ~25K chars). `buildPrompt('extend', { …, profile: 'worker' })` renders
`prompts/extend-worker.md` instead: APP.md, used-by, the standing rules, how to
work, the architecture rules, one API pointer line (`api-reference.md` or
`api/<key>.md`) and a pointer to `appmd-maintenance.md`; `{{FILE_LIST}}`,
`{{API_REFERENCE}}`, the budget line and the maintenance block are not
rendered. Other actions and profiles give the normal prompt, byte for byte
(`test/fixtures/prompt-extend-*.txt`). The launchers (`launchChangeSession`,
`app:spawnCli`, `extend` only) pass core both: `appendSystemPrompt` (full, for
the orchestrator and `profile: "full"` workers) and
`workerAppendSystemPrompt` (lean, for the default workers). A simple launch
(hidden, resume, no SDK billing, `open()` in index.js) drops the lean key; core
drops it for a simple mode as well. `inlined.json` is one file per app dir,
read by every session of the run, so a lean-worker launch writes `keys: []` +
`profile: "worker"` (`writeSidecars({ profile })`; `app:spawnCli` does not
know the mode before the owner picks it and rewrites the stamp with
`markWorkerProfile` when `openCli` returns `mode: 'orchestrator'`). The cost
is one spurious read request to the orchestrator or a `full` worker for a
section it was handed, never a missed one.

The prompt body (`extend.md` ~4K, `build-tools.md`, `build.md`
~24K: Design with one decision form, Build, Handoff) carries the rules every turn needs and a
`sidecarPointer` for the rest; `{{API_REFERENCE}}` is the always-inline basics
plus the capability index (`buildSectionIndex`, one line per key, marked
`**(inlined)**` when the request's wording selected the section and
`**(used here)**` when `capabilities-infer` sees the app already call it).
Only selected sections are inlined (`sectionsToInline`, keywords only; a
`build-tools` session always gets `tools`); an `API:DETAIL` block never is.
The scaffold index is GENERATED from the `##` headings of
`_scaffolds-detail.md` and the `>` purpose line under each, so index and bodies
cannot drift. `src/apps/prompts/_api-reference.md` is THE app-facing doc, kept
truthful by `capabilities-check` (one block per capability, headings inside it,
size ceilings on a block and on the always-inline part) and the prompt fixtures.

**What the other apps offer.** `buildCrossAppTools()` (in `migration.md`) is one line per provider —
an app that exposes a tool to apps or declares a bus kind, minus independent
ones and itself: `- **<app>** (<runtime>, <running|stopped>) — n tools, m event
kinds — .vistaclair/apps/<app>.md`, plus "not callable via `ctx.tools.call`;
subscribe on the bus" when it is own-process. Each fact comes from the freshest
source, manifest second: tools from the live registry (`getToolsForApp`), kinds
from the bus catalog (`horstEvents.catalog().declared`, which survives
restarts). The sidecar holds the detail — every tool with its parameters, which
are required and its `returns`, and every declared kind — and `apps/` mirrors
the provider list at each refresh, so a sidecar never outlives its provider.

**And whether it read it.** The same `writeSidecars` call writes three more
files into `.vistaclair/`, so "read that file first" is checked rather than
hoped for:

| File | Written by | Holds |
|---|---|---|
| `inlined.json` | the launcher, per launch | `{ at, action, [profile], keys, baseline }` — the sections this prompt carries (`inlinedKeys`, the set the slicer keeps) and `baseline`, `{ "<relFile>": [keys] }` from `capabilities-infer` at launch (`{}` for a build; absent when the scan failed). `profile: "worker"` + `keys: []` when the launch is an orchestration run whose workers get the lean prompt (below) |
| `reads.jsonl` | `src/apps/hooks/read-ledger.js` | one `{ at, instanceId, key }` per `.vistaclair/` file read. Truncated at every launch |
| `hooks.json` | the launcher, per launch | the `--settings` file: the ledger hook, CLAUDE.md discovery off (`launchSession`'s `settingsFile`) |

The hook is `PreToolUse` on `Read|Bash`, so a read made with `sed`/`cat` counts
like a `Read` — sessions run with `--dangerously-skip-permissions` and edit
through Bash, so reads are the observable half. Keys are `api/<key>`,
`apps/<name>`, `scaffolds`, `appmd-format`, `appmd-maintenance`, `migration`, `platform-request`,
`app-request`, and `all` for the full reference. It appends only in a directory
that has `inlined.json`, and exits 0 always.

App-lint reconciles the two at the end (rule `unread-capability`, error): a
capability the code uses whose section was neither inlined nor read names the
file to read. Only evidence that is NEW since launch counts — a file's usage of
a key that `inlined.json.baseline` already lists for that file is the app's, not
the session's, so an app that uses `db` everywhere never forces a `db` read in
a session that merely edits `routes.js`. Without a baseline, the fallback is a
file whose mtime is later than the launch stamp:

| Key | Due when |
|---|---|
| `api/<key>` | the code newly uses that capability (`capabilities-infer`) |
| `apps/<name>` | the code calls that app's tools and the launch withheld its sidecar |
| `api/telegram-miniapp` · `-identity` · `-auth` | the app uses Telegram AND ships `app.html` / `/api/app/` routes · `ctx.identity` · `/api/auth/*` |
| `scaffolds` | a **build** session wrote `routes.js` or anything under `public/` |
| `appmd-format` | any session wrote `APP.md` |
| `appmd-maintenance` | `inlined.json.profile` is `worker` and the session wrote `APP.md` |

The last two are not in the reference, so reading it whole does not cover them.
The rule runs only when all three ledger files are present, so a manual
`npm run lint:app` — or a core without `--settings` — is silent, never noisy.

## Workspace sessions (`src/apps/cli-workspace.js`)

`Bridge.call('cli.workspace', { dir, title, instructions, … })` opens a Claude
Code session in `<appDir>/workspaces/<dir>` — the app's material (a Blender
scene, a dataset), not its code. Dispatched in `handleMessage` like `cli.edit`.

| | |
|---|---|
| folder | `dir` is one name (`^[a-z0-9-]+$`) under the fixed `workspaces/` root; the app creates it. `fs.realpathSync` once: the same string is the containment check (parent must be the realpath'd app dir's `workspaces/`), the `cwd` and the stamp, since core resumes by exact `cwd` |
| prompt | `appendSystemPrompt` = `_workspace-preamble.md` (not an app change, the apps-repo rules yield, edit only here, never `AskUserQuestion` when hidden → `BLOCKED.md`) + the app's `instructions` (≤ 32 KB). No sidecars, no APP.md check |
| settings file | `<appDir>/.data/workspaces/<dir>/settings.json` = `{ claudeMdExcludes: [<appsDir>/CLAUDE.md] }`, so the app-change standing rules never load; the workspace's own `CLAUDE.md` does. `<appsDir>/CLAUDE.md` also says so in its `## Workspace sessions` clause |
| identity | tab `ws-<app>.<dir>`; stamps `workspaceApp` + `workspaceDir` (`SESSION_STAMPS`). `workspaceSessionsOf(app)` scans `cliSessionManager.sessions` by stamp, so a restored `tab-<boot>-N` counts. `cli.workspaces({ dir? })` returns those rows to the app as `{ tabId, dir, running, hidden }` (`list`), its way to reconcile a saved tab after a reload |
| launch | `spawnOpts.resume` (newest transcript for that folder). A session already `running` there is reused: no `launchSession` (core's spawn would kill it), `prompt` written into it, `reused: true` |
| events | `app:bridge:event` `cli:workspace` `{ tabId, dir, state: 'started'\|'exited', hidden, reused }` via `broadcaster.broadcast`; `exited` from `addExitHook`, armed once per tab. A visible session also sends `app:cliSpawned`; `hidden` requires `autoSubmit` |
| teardown | `killWorkspaceSessions(app)` on close (`kill`), rename (`kill`, found by the old name's stamp) and delete (`remove`) |
| guards | `cli.interrupt` accepts only the app's own tabs (`ownsTab`: `app-<name>`, `app-<name>-tools`, or stamped `changeApp` / `workspaceApp` for it — a restored `tab-<boot>-N` included). Every `cli.*` call passes `appBridge.revocationError` first (`cli` itself is never revocable, `capabilities-check`) |

`<appDir>/workspaces/` (root only) is skipped by app-lint's walk and
`listAppFiles` (snapshots, `{{FILE_LIST}}`); `capabilities-infer` refuses a
`require` into it.

**Not built:** a workspace session cannot file change requests (`callerOf`
refuses a cwd below an app root); a hidden session is not restored after a
restart.

## Orchestrator change sessions

`app:spawnCli` goes through core's `ctx.openCli` with no mode and `msg.engine`
(normally unset), so the user picks Simple or Orchestrator and the engine in one
form (`build-tools`, `recreate-appmd`: simple, CLI unless `msg.engine`). The run
lives in `<appDir>/.vistaclair/orchestrator/<runId>/`; workers inherit the
prompt, `changeApp` stamp and read-ledger hooks, share the app directory and
their `done` report is trusted; the rest (pause, resume) is core
`src/orchestration.js`. App launches (not the commit session) pass `sessionsRoot:
<appDir>/.vistaclair/sessions` for the TODO/NOTES folder.

**Agent SDK engine** (`engine: 'sdk'`, core `src/sdk-session.js`): the same
Claude Code in the dashboard's panel instead of a terminal, billed to the
Anthropic API key or the Claude subscription — core's form asks when both exist
(`settings.auth`, returned by `openCli` as `auth`); Pro's spend ledger meters
change sessions on neither engine.
The prompt with the standing rules, `hooks.json` (read ledger, CLAUDE.md off),
`sessionsRoot`, the stamp and change-request delivery carry over;
`spawnOpts.resume` reads Claude Code's own transcript store, so either engine
continues the other's. Its exit fires `addExitHook` like a PTY's; the APP.md
follow-up takes `openCli`'s `engine` and `auth`. Commit pins
`engine: 'cli'`.

**agy engine** (`engine: 'agy'`, core `src/agy-session.js`): an orchestration
worker on Google's Antigravity CLI (`launch_cli` `model: 'neon'`, or `engine:
'agy'` with a `gemini-…` id), on the owner's Google subscription only. It is an
SDK-kind session in the same panel, one `agy -p` process per turn, with the
run's hooks fed as synthetic events. Worktree isolation only. See
`docs/agy-workers.md`.

**Sessions Pro opens on its own** (`launchChangeSession`, a platform change
request) ask nobody at a form: `openCli` with the mode, `engine: 'sdk'` and
`auth` given.

| Launch | `mode` | Notes |
|---|---|---|
| a change (`cli.edit`, Telegram, change-request target) | `orchestrator` | tab `app-<name>`, `runsDir` `<appDir>/.vistaclair/orchestrator`, `isolation: 'none'` (as `app:spawnCli`); `prompt` + `autoSubmit` as the caller gives them |
| APP.md pre-flight recreate | `simple` | the change follows on its exit |
| a resume (change-request tier 3) or a hidden `cli.edit` | `simple` | an orchestrator always starts fresh and is never hidden |
| platform change request | `orchestrator` | tab `pro-change-<id>`, cwd the pro repo, core's default isolation (a worktree per worker); `openSdkSession` |

Billing (`sdkBilling` in `index.js`): `ctx.resolveAuth('subscription')` names
the credential. The subscription → `auth: 'subscription'`. An API key alone →
`confirmApiKeyBilling` asks the owner first (a `pro-billing-*` entry in
`ctx.pendingQuestions` + an `ask:question` broadcast bound to the tab: a
reloaded dashboard shows it again, the Telegram Mini App of a chat bound to the
tab answers it); no, cancel or no way to ask → nothing opens (`{ cancelled:
true }`: `cli.edit` answers an error, Telegram unbinds the chat and says so,
a change request goes back to `pending`). No `openCli`, no `resolveAuth` or no
credential → the CLI terminal, as on an older core.

**Telegram bindings** (`platform-tg-session.js`): a Telegram-launched change
records its `runId` (`settings.orchestration.runId` of the opened tab) and
resolves the run's current orchestrator tab on every use, by the stamp among
`cliSessionManager.sessions` — a resume or a refresh moves it. Turns go through
the session's own `submit()` / `interrupt()` (PTY and Agent SDK alike). Any
orchestration run can also be followed from Telegram without launching it
there (`docs/horst-surfaces.md` "Runs on Telegram").

**Not built:** Agent SDK commit sessions; the Telegram `tg-pro`
session (CLI); a Telegram chat bound to a launch a restart interrupted is not
unbound at boot.

## Platform gaps

A session that had to hand-roll something the platform should provide appends
one dated line to `<appsDir>/PLATFORM_GAPS.md` (the one file it may write
outside its own directory). Nothing else writes that file.
