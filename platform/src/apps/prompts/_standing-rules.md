### Scope

- Modify files only inside this app's directory. Never read or write
  platform source, other apps, or anything outside the cwd.
- The one exception: appending a line to `../PLATFORM_GAPS.md` when the
  platform lacks something you need. Append only, never rewrite.
- Never start, stop, restart or kill the app or any other process. Lifecycle
  is the user's, through the dashboard. Never touch the vistaclair server.

### Read before you edit

- `APP.md` is the authoritative index of this app and every session keeps it
  accurate. When your prompt carries it, work from that copy and do not read
  it again; otherwise read it first. Then read the `APP_<TOPIC>.md` detail
  file it points to for your area. Its **Where to change what** table names
  the exact file and function. Open source only to get the code you will edit,
  never to discover how the app works.
- Use `Read` and `Grep`. Never dump `cat`, `find` or `ls -R` output into the
  conversation. Read the function you need, not the file.
- A sweep across more than a handful of files goes to one read-only
  exploration agent (`explorer` in an orchestration worker, `Explore`
  otherwise) that returns a conclusion. A single lookup never does: the
  agent's fixed overhead costs more than the read.
- When `.vistaclair/` exists, `.vistaclair/api/<key>.md` is the reference for
  one platform capability. Read it before you use a capability whose section is
  not in your prompt; app-lint checks that you did.

### Ask before you guess

- If the request is ambiguous in scope, behaviour or edge cases, ask with
  `AskUserQuestion`: one batched form, your best assumption as the default.
  Skip only when you are 90%+ sure. Never silently guess on things that would
  be painful to redo. An orchestration worker asks its orchestrator instead.

### Before you say "done"

- Run the gate; every `ERROR` must be zero:
  ```
  node ../../platform/src/apps/capabilities-infer.js . --write
  node ../../platform/src/apps/app-lint.js .
  ```
  It needs no running app and is your only self-verification; runtime
  confirmation is the user's step.
- Verify once, proportionally: the gate plus at most the one check your change
  needs. No independent reviewer, no re-running a subagent's or another
  session's checks, no ad-hoc probe scripts — unless the owner asks. What a
  subagent or another session reports as done is trusted.
- Update `APP.md` (and the affected `APP_<TOPIC>.md`) in the same change.

### Your session folder

- Your system prompt names a session folder. Keep its `TODO.md` table and
  `NOTES.md` current as you work; they are how a pause, a resume or an
  orchestrator picks your work up. They are not app files: never list them in
  APP.md.

### In an orchestration run

When your instructions end with a `# Role:` card, you are one session of a
multi-session run and the card decides your part. On top of it:

- **Orchestrator**: editing, the gate and the APP.md update are workers' work,
  never yours. When the workers share this directory, finish with one worker
  that runs the gate and updates APP.md after the others are done.
- **Worker**: ask the orchestrator (SendMessage), never the user. Run the gate
  and update APP.md only when your brief assigns them to you; otherwise list
  the APP.md changes your work needs in your `done` report. Touch only the
  files your brief names.
