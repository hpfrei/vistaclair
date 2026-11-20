# App tools: long-running jobs and artifacts

The platform side of job-kind tools and of the files tools produce. The broker,
`authorizeToolCall`, the tool contract, dependencies and run grants are in
`docs/app-tools.md`.

## Job tools (`src/apps/app-tool-jobs.js`)

A tool registered with `kind: 'job'` (default `'call'`) is long-running. The
registry and `manifest.tools` keep `kind`; its `timeout` is the maximum
runtime (default 4 h, max 24 h). The platform union (`callerView`: broker
catalog, search, describe, platform aiPrompt sidecars) appends one sentence
to its description (`JOB_NOTE`) and a `_wait` property to its schema. An owner
chat turn's sidecar (`getPlatformToolUnion({ horst })`, `ai-service` when
`isHorstTurn(sessionTag)`) gets the Horst view instead: `HORST_JOB_NOTE`
(clarify first, then call with `_plan`) and a `_plan` property (≤ 500 chars).

- **Call path** — `callAppToolHandler` after `authorizeToolCall` (governance,
  spend and the audit as for quick tools): `_wait` (s, default 30, max 120,
  0 = at once) and `_plan` (any non-Horst caller's: ignored) are stripped; `start` opens a ledger record and runs the
  handler `(args, caller, job)` inside the provider's `ctx.jobs.start`
  (`name: 'tool:<tool>'`, meta `{ toolJobId, tool, caller }`). Ended within
  the wait → the result inline, an error thrown, exactly like a quick tool;
  else `{ content: [Started tj_… (<app>__<tool>) …], structuredContent:
  { jobId, status: 'running', tool } }`.
- **`job`** — `id`; `progress(pct, label)` (the ctx.jobs progress);
  `notify(text)`; `ask(question, { timeoutMs? })` → Promise<string>,
  rejected on timeout, cancel or end; `signal`, aborted on cancel, timeout
  and app stop. Timeout ends the job `error` / "timed out"; an app stop ends
  it `interrupted`.
- **Ledger** — `<dataHome>/tool-jobs/<id>.json` `{ id, app, tool, name,
  caller, principal, status: running|done|error|cancelled|interrupted,
  startedAt, endedAt, result, error, pendingQuestion, delivered, appJobId }`,
  written on every transition. Boot (`init`): `running` → `interrupted`,
  delivered. Terminal records are kept 30 days.
- **Principal and route** — orchestrator/worker callers: `run:<runId>`,
  delivered by `ctx.sendToSession(caller.address, text, { from: 'tool-job' })`,
  else `caller.orchestrator`, else `delivered: false`, retried at boot and
  every minute for 24 h. App callers (`ctx.tools.call`): `app:<name>`,
  delivered to `ctx.tools.onJobDone` / questions to `onJobQuestion`, queued
  until the app registers them (restarts included). Horst callers: the
  `horst` route below, principal `owner`. Any other caller (the app's own
  aiPrompt, platform AI outside a Horst chat turn, cron, the GUI tester) has
  no route: it waits for the end, `ask` rejects and `notify` is dropped. The
  owner reaches every job.
- **Horst route** — `platform-horst.runChat` binds each turn's random
  `sessionTag` (`bindHorstTurn`, released when the turn ends); a platform
  caller carrying a bound tag resolves (`resolveCaller`, first thing in
  `callAppToolHandler`) to `{ type: 'horst', conversationId, chatId?,
  surface: ui|telegram|app }`. Its job-tool call never runs: `stageForHorst`
  hands it to `agent/horst-jobs.js`, which stages an `app.tool.job` proposal
  (`docs/horst.md`, "How Horst acts"; surface `app`, i.e. `ctx.horst.chat`, is refused) and
  returns a text result telling the model to wait for the owner's tap. The
  call's `_plan` (trimmed, capped at 500) leaves the args and becomes
  `payload.plan`; the card leads with it, else says "no plan given".
  Clarify-then-confirm: the persona's long-running rule and `HORST_JOB_NOTE`
  tell Horst to check the request against the tool's description, ask once
  with proposed defaults when scope, length, language/style or format is
  open (or the tool differs from what the owner expects), then pass `_plan`. The
  approved payload runs with `{ wait: 0, approved: true }`; outcome, question,
  note and progress go to the handlers registered with `onHorstRoute`
  (outcomes queued and retried like the agent route, flushed on registration).
  At most 2 run at once (`MAX_RUNNING`); a third approval fails with a message
  naming the running jobs, nothing is queued. A job's files reach the owner
  with its outcome only: one delivery in the ledger below, and on Telegram the
  outcome without its Details and uri lines (`outcomeText(rec, { brief })`) as
  one message linking to Vista (`docs/horst-surfaces.md`). Files from quick tools: each `vc-artifact://`
  `resource_link` a horst caller's quick call returns is kept for its turn,
  unique by uri (`horstTurnFiles(sessionTag)`, dropped on release; staged and
  approved job calls are not collected). `runChat` puts them on the reply as
  `msg.files` plus a `Files:` block (the outcome's line shape, `fileLines`)
  for each uri the reply does not name, so the tab shows chips and later turns
  see the uri, and records them as one delivery (surfaces `ui` / `telegram`);
  a Telegram turn links to them from the reply (`docs/horst-surfaces.md`).
- **Deliveries** (`agent/horst-deliveries.js`, `.horst/deliveries.json`,
  atomic) — `record(links, meta)`, the one write for both paths above: one
  record per file `{ id: dl_…, at, batch: db_…, artifactId, uri, name, mime,
  size, kind: picture|audio|video|model|document, source: job|chat, app,
  tool, jobId?, conversationId, title, removedAt? }` (title: the result's
  first text line, or the turn's request); an artifact already delivered keeps
  its record. Each artifact is pinned (holder `horst:deliveries`, reason
  `horst-delivery`), so it stays until the owner removes it: `remove(id)`
  unpins and sets `removedAt` (the blob goes at the next gc; removed records
  are dropped after 30 days). `list({ kind, batch, artifact })` adds `missing`
  and `previews` (the batch's pictures, for a 3D model).
- **Messages** — outcome: `tj_… <app>__<tool> <status> (<duration>)`, the
  result's text blocks capped at 4000 characters (pointing at
  `tool_job_status` for the rest), one line per `resource_link` (`uri`, mime,
  size). Question: `tj_… asks: <q> (answer with tool_job_reply)`. Note:
  `tj_… note: <text>`.
- **Built-ins** — `tool_job_status({ jobId? })` (no id: the run's jobs),
  `tool_job_cancel({ jobId })`, `tool_job_reply({ jobId, text })`, for the
  run that owns the job (any of its sessions). Listed on every catalog
  session, and on a grant session that holds at least one job tool. The
  run prompts (`app-tool-packs.js`) explain jobs; a grant marks its job tools
  `(job)`.
- **`currentCall()`** (`app-tools.js`, AsyncLocalStorage) → `{ caller, app,
  tool, callId, jobId }` inside every handler run, quick and job (the
  ctx.jobs run included); `ctx.artifacts.put` reads it.

Not built: an owner UI for the tool-job ledger; `notify` to an app caller
(dropped); a queue for Horst jobs beyond the cap.

## Artifacts (`src/apps/app-artifacts.js`)

A file a tool produces goes to its caller as `vc-artifact://<id>`, never as an
absolute path. App-facing: `ctx.artifacts` (`capabilities/artifacts.js`, the
`artifacts` section of `_api-reference.md`); a provider returns
`{ content: [{ type: 'text', text }, art.link] }`.

- **Store** — `<dataHome>/artifacts/blobs/<sha[0:2]>/<sha256>` (content-addressed,
  read-only, deduplicated) and `meta/<id>.json`; id
  `art_<16 hex of sha256>-<4 random hex>`, so one blob backs several records.
  `put` snapshots the source into `tmp/` (a copy-on-write clone where the
  filesystem has one; never a move or a hardlink, so the app's later writes
  cannot change a blob), hashes the snapshot, then moves it and writes the
  record in one synchronous step. A source path must stay inside the app
  directory after symlinks; `import` / `copyTo` refuse a destination outside it.
- **Principals** — `{ type: 'app', app }`, `{ type: 'run', runId }` (every
  member of the run), `{ type: 'owner' }` (reads all). The producing app
  always reads its own. `principalOf(caller)` maps the typed callers:
  orchestrator/worker → run, app/self → app, platform/horst/cron/owner/gui-test →
  owner. `put` inside a tool call (`call` from `app-tools.currentCall()`,
  feature-probed) grants the caller's principal and fills `producer
  { app, tool, callId, jobId }`.
- **Platform put** — `putPlatform(buffer, opts, { producer })`: bytes the
  platform received (a Telegram photo/document sent to Horst, producer
  `{ platform: 'telegram', chatId, messageId }`), owned by `owner`, no app, no
  grants; bytes only, so no path is ever read. A tool call naming the uri
  grants its app (`extractRefs`).
- **Download** — `GET|HEAD /pro/artifacts/:id` (`serve`, mounted from
  `index.js`): owner-authed by core's middleware and re-checked in the handler
  (`appManager.getOwnerCheck()` = core's `isOwnerRequest`; absent → 401). The id
  (`ID_RE`) names a record, the record's `sha256` its blob; nothing else
  reaches the filesystem. `sendBytes(req, res, id)` writes the response (also
  for the Mini App's Files route): the record's mime, `Content-Length`,
  `Content-Disposition` with an ASCII and an RFC 5987 filename (`inline` for
  raster images unless `?download`, else `attachment`), `nosniff`, CSP
  `sandbox`, `private` cache, `Accept-Ranges`; one `Range: bytes=` (`a-b`,
  `a-`, `-n`) answers 206 with `Content-Range`, an unsatisfiable one 416.
- **Agent tools** (`src/apps/artifact-tools.js`, `builtinTools`, holder
  sessions of orchestrators and workers): `artifact_info({ uri })`,
  `artifact_fetch({ uri, dest })` (copy into `holder.cwd`),
  `artifact_put({ path, mime?, name? })` (a file in `holder.cwd`, owned by and
  granted to the run). The run is the principal. A `vc-artifact://` uri in a
  tool call's arguments (`extractRefs`) grants the target app read when the
  caller can read it.
- **Lifetime** — `gc()` drops unpinned records older than
  `artifactRetentionDays` (30), then every blob no record uses and stale
  `tmp/` files; at boot (deferred 30 s) and daily (`artifacts:gc`, 03:30).
  `pin(ref, holder, reason)` keeps a record (every Horst delivery is pinned). `put` refuses above
  `artifactAppQuotaMB` (5120) of distinct blobs per owner (an app, or a run for
  `artifact_put`). Both settings are platform settings.

Not built: serving an artifact to an app's iframe or a non-owner over HTTP;
deleting a single artifact on request.
