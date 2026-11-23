# agy workers (Antigravity CLI engine)

An orchestration worker can run on Google's Antigravity CLI (`agy`) instead of
Claude Code: Gemini models on the owner's Google AI subscription, no Anthropic
cost. The worker has the same run features as a Claude worker (report, messages,
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
| tests (a fake agy) | `test/agy-session.test.js`, `test/agy-hook.test.js`, `test/fixtures/fake-agy.js` |

## Launch

`launch_cli` (`lib/orchestrator-mcp.js`):

| Arguments | Worker |
|---|---|
| `model: 'neon'` | agy, `gemini-4-neon-medium` |
| `engine: 'agy'` (model left out) | agy, `gemini-4-neon-medium` |
| `engine: 'agy', model: 'gemini-…'` | agy, that id (e.g. `gemini-3.8-flash-low`) |
| `fable` / `opus` / `sonnet` / `haiku` | Claude, unchanged |

Refused: `claude-*` / `gpt-*` agy ids, a `gemini-…` id without `engine: 'agy'`,
an engine other than `agy`, `host`, isolation `none` (also when it is the run's
default), a repo that tracks `.agents/hooks.json` or `.agents/mcp_config.json`,
and a machine without `agy`. `profile`, `connectors` and `skills` have no effect,
and the launch result's `note` says so. The worker record gets `engine: 'agy'`
and the model id. Its settings get `engine: 'agy'`. The rest of the launch path
(queue, `after`, area, worktree, cap) is the Claude path. The orchestrator card
and the schema describe neon. The run's sub/API setting applies only to its
Claude sessions: agy always runs on the subscription login.

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
  an assistant text (its `usage` sets the context tokens); `tool ACTIVE` →
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
| `<worktree>/.agents/mcp_config.json` | `buildMcpServers` (orchestrator with eager `report`/`SendMessage`/`ListAgents`, the integrated server, tool-pack servers), each wrapped `env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY … -u SSL_CERT_FILE`. No `*TOKEN*`/`*KEY*`/`*SECRET*` value is written: the servers inherit the token from agy's env |
| `<runDir>/sessions/<name>.agy-settings.json` | `permissions.allow [mcp(*), read_file(*), write_file(*), command(*), read_url(*)]`, `trustedWorkspaces [worktree]` |
| `<runDir>/sessions/<name>.agy-policy.json` | `writeRoots` (worktree, session folder), `mainConversation`, `pausing`, `sessionStartText` (the role card with `mcp__x__y` → `mcp_x_y`), `allowSubagentTypes`; `settings.agyPolicy` overrides |

- `excludeAgents` appends `/.agents/hooks.json` and `/.agents/mcp_config.json`
  to `git rev-parse --git-path info/exclude`.
- A landing whose diff contains either file is refused (outcome `error`).
- `kill()` removes the `.agents` files, the settings and policy files, the
  session token, the tool packs and the MITM tag.
- The role card is a parameter (`settings.appendSystemPrompt`). The
  orchestration adds `agyWorkerNote` (agy tool names, no subagents) for workers.

## Hook policy (`lib/agy-hook.js` `decide`)

| Tool | Decision |
|---|---|
| `read_file`, `view_file`, `search_web`, `read_url`, `list_resources`, `read_resource`, `manage_task`, `run_command`, browser tools | allow |
| `write_file`, `edit_file`, `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `sed_file`, `notebook_edit` | allow inside a `writeRoots` entry (symlinks and `..` resolved); else, or with no path argument, deny |
| `mcp_*`, `call_mcp_tool` | allow; while `pausing`, `mcp_worker-tools_Agent` and `call_mcp_tool` `Agent` are denied |
| `invoke_subagent` | allow only for `TypeName` in `allowSubagentTypes` (`image-generator`) |
| `send_message` | allow outside `mainConversation` (a subagent answering); deny in it |
| `ask_question`, `ask_permission`, `ask_custom_permission`, `define_subagent`, `manage_subagents`, `swarm`, `browser_subagent`, `run_workflow`, `schedule` | deny, the reason naming the Vistaclair tool |
| unknown name | allow; reported once per spawn (`unknown-tool` → the server log) |
| no or broken policy file, hook error, 8 s self-timeout | deny |

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

## Not built

- Claude subagents for agy workers (worker-tools MCP `Agent`).
- Quota pause, auto-continue at the reset, queueing agy launches, the owner
  item.
- An orchestrator on agy.
- agy as the engine of a non-run session or of the session-opener form.
- A Gemini API key path.
- Image attachments in `submit`, and remote (federation) agy workers.
- The prompt goes in argv (it shows in `ps`); stdin is not used.
- A `--model` change applies from the next turn; whether agy honours it on a
  `--conversation` resume is not verified.
- In a Claude CLI run, the run board's last replies for an agy worker are not
  read from its transcript.jsonl.
