# agy workers (Antigravity CLI engine)

An orchestration worker, or a run's orchestrator, can run on Google's
Antigravity CLI (`agy`) instead of Claude Code: Gemini models on the owner's
Google AI subscription, no Anthropic cost. The worker has the same run features as a Claude worker (report, messages,
pause, nudges, landing). It is shown in the Agent SDK panel. Its model traffic
goes through the agy MITM proxy (`docs/agy-inspector.md`) into the Inspector.
agy runs exactly as a normal agy does: documented flags, the per-workspace
`.agents/` config and `--settings`. Nothing alters its requests, and nothing
touches its global config or its credentials (`docs/agy-auth.md`).

| Piece | File |
|---|---|
| the session (one `agy -p` process per turn, SDK-shaped transcript) | `src/agy-session.js` (`AgySession`, `resolveAgyModel`) |
| per-worker config: `.agents/*`, `--settings`, policy, `info/exclude` | `src/agy-worker-config.js` |
| the hook (local PreToolUse policy, SessionStart card, PreInvocation inbox) | `lib/agy-hook.js` |
| engine switch | `src/cli-sessions.js` (`sessionClass`, `setAgyHookHandler`, `_agyResumable`) |
| launch, nudges, blocked, the `/agy-hook` route | `src/orchestration.js` (`agyLaunchModel`, `agyWorkerNote`, `decideHook` `Stop` / `AgyBlocked`, `agyHook`) |
| landing refusal of committed `.agents` files | `src/worktree-landing.js` `precheck` |
| the orchestrator on agy (dialog, run, cap, blocked) | `src/orchestration.js` (`AGY_ORCHESTRATOR`, `agyOrchestratorOf`, `agyOrchestratorPolicy`, `agyOrchestratorNote`, `agyAutoTurn`), `public/new-cli.js` |
| tests (a fake agy) | `test/agy-model-names.test.js` (names, validation, cards), `test/agy-session.test.js`, `test/agy-hook.test.js`, `test/agy-orchestrator.test.js`, `test/fixtures/fake-agy.js` |

## Launch

`launch_cli` (`lib/orchestrator-mcp.js`):

| Arguments | Worker |
|---|---|
| `model: 'neon'` / `'argon'` / `'hydrogen'` | agy, `gemini-4-<tier>-medium` |
| `model: '<tier>-<effort>'` (`hydrogen-high`) | agy, `gemini-4-<tier>-<effort>`; efforts low / medium / high / xhigh (argon: no xhigh) |
| `model: 'flash'` / `'flash-<effort>'` | agy, `gemini-3.8-flash-<low\|medium\|high>` (default medium) |
| `model: 'gemini-…'` (any full agy id) | agy, that id |
| `engine: 'agy'` (model left out) | agy, `gemini-4-neon-medium` |
| `fable` / `opus` / `sonnet` / `haiku` / `claude-…` | Claude, unchanged |

An agy model name implies the engine (`agyWanted`, `isAgyModelName`); `engine`
is optional. The name is checked up front (`agyLaunchModel`, before anything
starts): a name that is neither a Claude model nor an agy name / id is refused
with the list of valid ones. When the cached `agy models` probe holds an id list
(`AuthStatus.peek().models`, `docs/agy-auth.md`) the resolved id must be in it;
without one only the `gemini-…` pattern is checked. The probe is never started
for a launch.

Refused: `claude-*` / `gpt-*` agy ids, an effort a tier lacks, an engine other
than `agy`, `host`, isolation `none` (also when it is the run's default), a repo
that tracks `.agents/hooks.json` or `.agents/mcp_config.json`, and a machine
without `agy`. `profile`, `connectors` and `skills` have no effect, and the
launch result's `note` says so. The worker record gets `engine: 'agy'` and the
model id. Its settings get `engine: 'agy'`. The rest of the launch path (queue,
`after`, area, worktree, cap) is the Claude path. Both orchestrator cards (rule
D; `workerModelsText`) and the `launch_cli` `model` / `engine` descriptions list
the Claude and the agy choices and how to launch each (an agy model: isolation
worktree, $0 on the Google subscription, capped by its 5 h quota); the card
adds the live ids when the cached probe has them. The run's sub/API setting
applies only to its Claude sessions: agy always runs on the subscription login.

## Orchestrator on agy (neon)

The New CLI dialog offers **Neon** (`newCli.agyOrchestrator`, value `neon`,
with the agy sign-in state from `authStatus.peek()`, never a new probe) after
the Claude orchestrator models. It is drawn for an orchestrator whenever agy
has a probed state other than not installed, also with one Claude credential.
Picked, the Open button stays disabled until agy is `signed-in`; the row shows
the state and, for signed out or unknown, "Sign in to Antigravity"
(`[data-agy-signin]`); the dashboard's live `agy-auth:state` unblocks it. agy
runs on the subscription only: the Billing row stays, labelled "Billing (Claude
workers)", and applies to the run's Claude workers and subagents. The routing
map applies to the Claude sessions. `openCli({ model: 'neon' })` does the same
without the dialog; a Simple CLI never gets neon.

| What | Mechanism |
|---|---|
| run | `run.orchestratorEngine = 'agy'`, `orchestratorModel gemini-4-neon-medium`; `run.engine` / `run.auth` stay the workers' (Claude, or neon per `launch_cli`) |
| launch, fresh, refresh, resume | `agyOrchestratorOf(run)` over `orchestratorSettings` / `prepareRun`: `engine 'agy'`, the card + `agyOrchestratorNote`, `agyPolicy`, `agyContextLimit`, `agyRoleOnResume` |
| cwd | its session folder (`orchestratorCwd`): `.agents/mcp_config.json` holds the instance id, so two runs on one repo cannot share it, and the checkout stays untouched. `excludeAgents` only touches a repo whose top is the cwd |
| role card | SessionStart `sessionStartText` (new conversation). After a `--conversation` resume (no SessionStart) `takeResumeRole()` sends it once more at the first PreInvocation; the synthetic `SessionStart(resume)` adds the recap and events to the first turn |
| MCP tools | every orchestrator tool (`ORCHESTRATOR_TOOLS`) eager: `mcp_orchestrator_launch_cli`, `list_workers`, `SendMessage`, `ListAgents`, `owner_items`, `resume_worker`, `close_worker`, `stop_worker`, `cancel_launch`, `undo_landing`, `end_run` |
| events, messages, owner text | idle → a turn (the push's notice, `deliver`, the panel's `ownerSubmit`); busy → the PreInvocation `injectSteps`; at Stop, what is pending → a continuation |
| edit fence | policy `writeRoots: []`, `writeFiles` = its TODO.md, NOTES.md, ARCHIVE.md, `writeDeny` "delegate to a worker". `run_command` is not fenced (as Bash) |
| helpers | agy's own subagents (invoke_subagent); swarm denied |
| owner questions | the integrated server's `vista-AskUserQuestion` (call_mcp_tool); `ask_question` / `ask_permission*` / `schedule` denied with that reason |
| pause / resume | session-control as for a Claude session (`[vistaclair pause]` / `[vistaclair resume]`) |
| run-wide switches | `setRunModel` / `setRunAuth` skip every agy member (`switchTargets`, saved entries with `engine 'agy'`): the orchestrator and neon workers keep neon and the subscription |
| refresh | `agyContextLimit` 200k → `context.compactAt`; agy's token count past 80 % (idle) or 90 % (a PreInvocation) runs the existing refresh: `## Resume` notes, RESTART.md, a fresh agy conversation in the same folder |

**Automatic-turn cap.** At most `AGY_AUTO_TURNS` 5 automatic turns (event
pushes, Stop continuations, messages to an idle orchestrator from outside the
run) in `AGY_AUTO_WINDOW_MS` 10 min without a worker event or an owner message
(`agyAutoTurn`, `run.agyTurns` in run.json). Past it the orchestrator holds: no
turn; pending events and messages wait (inbox); one panel notice and the owner
item `agy-turn-cap`. A wake event of a worker, a worker's SendMessage, an owner
prompt or an owner item the owner resolves resets the count and closes the item.

**Blocked.** `AgyBlocked` for the orchestrator sets `run.orchestratorBlocked
{ kind, reason }` (on `describeRun`) and a blocking owner item
`agy-orchestrator-<kind>` ("Sign in to Antigravity …" with "agy sign-in needed"
in the panel, or out of quota with its reset time). While blocked no push runs
and `deliver` queues to the inbox. A sign-in re-runs the turn by itself;
otherwise the owner's next message starts one. A turn that runs closes the item.

## A turn

`AgySession` is `kind: 'sdk'`, `engine: 'agy'`. It is `running` from `spawn()`
to `kill()`. Each turn spawns, in the worktree, `detached` (its own process
group), with stdin closed:

```
agy -p <prompt> --model <id> --output-format stream-json [--conversation <id>] --settings <file>
```

- `--conversation` is the `conversation_id` of the first `init`, kept in
  `settings.agy.conversationId`, passed to `setMainConversation` and written to
  the policy as `mainConversation`. A fresh spawn clears it. A resume keeps it.
  If agy says it does not know the conversation, the turn runs once as a fresh one.
- A prompt over 100 KB goes into `<sessionDir>/agy-prompt-<ts>.md`, and the
  prompt names that file.
- Env: `agyEnv()` over `buildClaudeEnv({ proxyPort: null })`.
  - Removed: the owner token, the Anthropic key and token, `ANTHROPIC_*`,
    `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `AGY_ADC_AUTH` and
    `GOOGLE_APPLICATION_CREDENTIALS`.
  - Added: `AGY_CLI_DISABLE_AUTO_UPDATE=true`, the session token,
    `VISTACLAIR_INSTANCE_ID=cli-<sessId>`, `VISTACLAIR_ORCH_ROLE`,
    `VISTACLAIR_ORCH_ENGINE=agy`, `VISTACLAIR_AGY_POLICY`, `NO_PROXY=localhost,…`
    and `GIT_CEILING_DIRECTORIES`.
- MITM: interception on → `ensureStarted()`, `registerTag(instanceId)` →
  `HTTPS_PROXY`, `SSL_CERT_FILE=bundlePath()`. Interception off, or a MITM
  error → no tag and no proxy env: agy goes direct. `store.registerSession` is
  called at spawn, so the decoded calls land under the worker.
- stream-json → transcript: `init` → `system/init`; `agent_response DONE` →
  an assistant text (its `usage` sets the context tokens; a blank one is
  skipped, and `result.response` not shown by any step becomes the reply); `tool ACTIVE` →
  `tool_use` (`id agy-<step>`); `tool DONE|ERROR` → `tool_result`; `result` →
  `result` with `total_cost_usd: 0`. Steps of another conversation (an agy
  subagent's) are skipped. Status lines carry `credential: 'agy-subscription'`.

## Turn boundaries

The session synthesises Claude-shaped hook events. The manager's handler
(`setAgyHookHandler`) answers them, which for a run is the orchestration's
`handleHook`. That gives one implementation of inbox, pause, report and idle for
both engines.

| When | Event | Effect |
|---|---|---|
| spawn | `SessionStart` (`startup` / `resume`) | its context goes into the first turn's prompt |
| a fresh turn (owner, orchestrator, resume text) | `UserPromptSubmit` | resets the nudges; its context (inbox) is added to the prompt |
| each model call | agy `PreInvocation` → `POST /api/orchestration/agy-hook` | text submitted during the turn, the inbox and the pause text (a synthetic `PostToolUse`) → one `injectSteps` systemMessage. It fails open. Measured: obeyed mid-turn |
| turn exit | `Stop` (`stop_hook_active` on a continuation) | `{decision:'block', reason}` → a continuation turn with that reason; otherwise idle |
| a turn that cannot go on | `AgyBlocked { kind, reason }` | `lastReport = { status:'blocked', by:'platform', agy:kind }` and a `report` event to the orchestrator |

- **Nudges.** A worker that ends a turn without a final report gets at most 3
  nudge turns (`AGY_NUDGES`), whatever its last report says. After that comes
  the `idle` event.
- **Continuation cap.** After 8 continuations in a row (`MAX_CHAIN`), the
  session is blocked with kind `loop`.
- **Text submitted during a turn.** When PreInvocation did not take it, it runs
  as the next fresh turn before Stop.
- **Pause.** It works through session-control as for a Claude session. The
  policy's `pausing` is refreshed at each turn and each PreInvocation.

## Failures (never retried in a loop)

| Turn result | Then |
|---|---|
| `agyAuthFailureReason` (stderr, JSON `error`) | `reportAgyAuthFailure(info)`, then blocked "agy sign-in needed". The same prompt re-runs once on the next `authStatus` `change` with `signedIn` |
| 429 / `RESOURCE_EXHAUSTED` / quota text in stderr or `error`, or a 429 seen by the MITM (`cloudcode-response`) | blocked "agy quota exhausted (resets <ISO time or 'at a time agy did not say'>)". No retry, no nudge, no queueing |
| any other error (not an interrupt) | blocked "agy run failed: …", no retry |
| SIGINT (`stop_worker`, `interrupt()`) | `Stop` is fed; the stop flag means no nudge |

A new message to a blocked worker starts a turn as usual.

## Config (`src/agy-worker-config.js`)

| File | Content |
|---|---|
| `<worktree>/.agents/hooks.json` | group `vistaclair`: SessionStart, PreInvocation, Stop as flat lists; Pre/PostToolUse as `{matcher:'.*', hooks}`. Each is `node lib/agy-hook.js <event>`, timeout 10 s |
| `<worktree>/.agents/mcp_config.json` | `buildMcpServers` (orchestrator with eager `report`/`SendMessage`/`ListAgents`, for the orchestrator role every tool (`eagerFor`), the integrated server, tool-pack servers), each wrapped `env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY … -u SSL_CERT_FILE`. No `*TOKEN*`/`*KEY*`/`*SECRET*` value is written: the servers inherit the token from agy's env |
| `<runDir>/sessions/<name>.agy-settings.json` | `permissions.allow [mcp(*), read_file(*), write_file(*), command(*), read_url(*)]`, `trustedWorkspaces [worktree]` |
| `<runDir>/sessions/<name>.agy-policy.json` | `writeRoots` (worktree, session folder), `mainConversation`, `pausing`, `sessionStartText` (the role card with `mcp__x__y` → `mcp_x_y`); `settings.agyPolicy` overrides |

- `excludeAgents` appends `/.agents/hooks.json` and `/.agents/mcp_config.json`
  to `git rev-parse --git-path info/exclude`.
- A landing whose diff contains either file is refused (outcome `error`).
- `kill()` removes the `.agents` files, the settings and policy files, the
  session token, the tool packs and the MITM tag.
- The role card is a parameter (`settings.appendSystemPrompt`). The
  orchestration adds `agyWorkerNote` (agy tool names, native subagents) for workers.

## Hook policy (`lib/agy-hook.js` `decide`)

| Tool | Decision |
|---|---|
| `read_file`, `view_file`, `search_web`, `read_url`, `list_resources`, `read_resource`, `manage_task`, `run_command`, browser tools | allow |
| `write_file`, `edit_file`, `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `sed_file`, `notebook_edit` | allow inside a `writeRoots` entry or on a `writeFiles` file (symlinks and `..` resolved); else, or with no path argument, deny (`writeDeny` gives the reason) |
| `mcp_*`, `call_mcp_tool` | allow |
| `invoke_subagent`, `browser_subagent` | allow, any `TypeName`; denied while `pausing` |
| `define_subagent`, `manage_subagents` | allow |
| `swarm` | deny: "swarm (uncapped parallel subagents) is off; spawn one subagent at a time with invoke_subagent" |
| `send_message` | allow outside `mainConversation` (a subagent answering); deny in it |
| `ask_question`, `ask_permission`, `ask_custom_permission`, `run_workflow`, `schedule` | deny, the reason naming the Vistaclair tool |
| unknown name | allow; reported once per spawn (`unknown-tool` → the server log) |
| no or broken policy file, hook error, 8 s self-timeout | deny |

## Subagents

agy workers use agy's own (Gemini) subagents. There is no Claude-subagent
bridge: work for another provider's model is a separate worker (`launch_cli`).

- A subagent runs inside the worker's agy process, so its model calls go through
  the same MITM tag and land under the worker's instance. The decoder gives
  each other conversation its own lane (`subagent.agentType` = the
  `invoke_subagent` `TypeName`, `docs/agy-inspector.md`).
- Its tool calls reach the hook with the subagent's `conversationId`, so the
  write fence holds inside it.
- Its steps are left out of the worker's transcript. The worker sees the result
  as the `invoke_subagent` tool result.
- There is no hard cap on subagents: `swarm` (uncapped parallel fan-out) is
  the guarded case. While pausing, no new subagent starts.

## Stop, close, restart

- `interrupt()` sends SIGINT to agy. `kill()` sends SIGTERM to the process
  group. Either way, after agy exits, the group and a `/proc` snapshot of its
  descendants get SIGTERM, then SIGKILL after 5 s. A `run_command` child that
  agy leaves behind dies with it.
- `close_worker`, `end_run` and a finished pause go through `closeQuiet` →
  `kill()`. `cli:exit` is broadcast once per spawn, and not for a respawn.
- A resume continues the conversation. `_transcriptExists` counts an agy
  session with a `conversationId` as resumable.

## Live checks (agy 1.5.15, `gemini-3.8-flash-low`, a throwaway harness)

- **One worker turn.** The worker wrote a file in its worktree, the outside
  write was denied by the hook, and the report landed. When told its worktree
  was dirty, it committed with `run_command` and reported again, and the branch
  landed. 5 model calls were stored as $0 interactions. The 4 intercepted
  connections were ALPN http/1.1, `match: true`, 0 mismatches.
- **A message sent while the worker was busy** was injected at PreInvocation
  and quoted in the worker's answer.
- **A native subagent** (`invoke_subagent`, typed `research` by agy) read
  README.md and the worker reported its line. 7 calls were stored under the
  worker's instance, 3 of them in the subagent's lane, with 0 mismatches.

- **An orchestrator turn** (`model: 'neon'`, the data home in a git checkout):
  it quoted its card's `# Role:` line and called `list_workers`; 2 $0
  interactions, 4 connections http/1.1, `match: true`, 0 mismatches.

## Not built

- Cross-provider subagents (a Claude model under an agy worker, or the other
  way round): use separate workers.
- Quota pause, auto-continue at the reset, queueing agy launches, the owner
  item.
- agy for a Simple CLI session (the dialog offers neon for an orchestrator only).
- A Gemini API key path.
- Image attachments in `submit`, and remote (federation) agy workers.
- The prompt goes in argv (it shows in `ps`); stdin is not used.
- A `--model` change applies from the next turn; whether agy honours it on a
  `--conversation` resume is not verified.
- In a Claude CLI run, the run board's last replies for an agy worker are not
  read from its transcript.jsonl.
