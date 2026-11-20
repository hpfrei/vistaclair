# AI read scope

`src/apps/ai-read-scope.js`, `ai-read-scope-hook.js`; wired in `ai-service.js`
(`aiPrompt` plans, `aiPromptOnce` adds the flags, `closeAiCall` removes the file).

Every aiPrompt child runs with `--dangerously-skip-permissions`; the proxy's
`ai-tool-gate` only filters tool NAMES. A run granted a file tool is therefore
also bound to **paths**, so text from an outsider (mail attachment, chat upload)
cannot steer it into the server log, the secrets key, other apps or `/proc`.

## Behaviour

| | |
|---|---|
| Scoped grant | any of `Read Glob Grep LS NotebookRead Write Edit NotebookEdit` (the platform caller: also a shell tool) |
| `readRoots` | `aiPrompt({ readRoots: [abs path, …] })`, files or directories, must exist; real paths are used |
| App caller | default `[appDir]` (holds `.data`); a given root outside `appDir` is dropped |
| Platform caller (`'platform'`) | **no default**: no `readRoots` = file tools removed. Never valid: `/`, HOME or a parent, the apps dir or a parent, `/proc /sys /dev`, `~/.claude` |
| Result | `result.readScope = { tier, roots, stripped, reason }` on every scoped call; a `console.warn` when tools were removed |
| Not scoped | a call with no file tool (`[]`, `WebFetch`, app tools only) is exactly as before |

Callers: Horst attachment scan `readRoots: <its temp files>`; email
`readAttachment` `[its temp file]`; platform-horst `describeTgFile` and
horst-artifacts `analyzeDocument` pass their one file.

## Mechanism

1. `planReadScope` computes the effective grant and roots. Fail closed: if the
   hook self-test fails (`hookSelfTest`: the real script must allow an inside
   Read and refuse `/proc/self/environ`), managed settings turn hooks off
   (`managedHooksBlocked`), or no valid root is left, the file tools are removed
   (and the gate marker, written from the effective grant, strips them from the
   request too). Other tools in a scoped grant (Agent, Workflow, unknown) are removed.
2. `aiPromptOnce` adds `--tools <granted built-ins,ToolSearch>` (the child
   registers nothing else) and `--settings` with a PreToolUse hook
   (`disableAllHooks:false`, matcher `*`).
3. The hook (`ai-read-scope-hook.js <scopeFile>`) reads the call's scope file
   (`os.tmpdir()/vistaclair-ai-scope-<instanceId>.json`, 0600, removed in
   `closeAiCall`) and runs `decide()`: exit 2 = deny, anything unexpected =
   deny. `decide` resolves real paths (`resolveTarget`): a raw `..` is refused,
   a missing target is judged by its deepest existing parent, a dangling link
   is refused, `/proc /sys /dev` and a `.secrets_key` file are refused even
   inside a root, Glob/Grep with no path use the cwd, absolute globs are
   checked by their literal prefix. Shell tools pass only for an app caller;
   `mcp__*` are the broker's; WebFetch only http(s).

## Residual risks / not built

- **No sandbox layer.** bubblewrap was evaluated as a second layer and left
  out: `/snap/bin/blender` (my-blender's Bash) does not run in it, a bound
  credentials file cannot be refreshed in place (a rotated OAuth token would be
  lost), and every email triage run would depend on it. Consequence: the hook is
  the only boundary; a hook that crashes or times out mid-run lets that single
  call through (the self-test makes this unlikely, the script is a few lines).
- **A shell is not scoped.** An app granted `Bash` can read anything its user
  can; do not grant it to a run that takes in outsider text (app-lint warns).
- Glob can list file names through a symlinked directory inside a root; a
  symlink swapped between the check and the open needs a concurrent writer
  (a shell).
- A future CLI tool that touches files is refused by default (`--tools` and the
  hook's default deny).
- WebFetch can still reach local http services; the owner token is not in the
  child's env.

Tests: `test/security-ai-read-scope.test.js` (decision, roots, plan, hook
script, spawn args; no AI call).
