# Fleet remote call / job (master → the app's copy on a slave)

An app on the master calls a named handler of its own copy on a linked
slave, or starts a job there, under the owner's approval; the job's progress
is pushed back. Same peer token, same https rule, same auth-failure limiter,
no new port, no secret held by the app. The slave dispatches only to the app
named by the caller: no cross-app call, no admin surface.

| File | Side | Duty |
|---|---|---|
| `src/apps/fleet-remote-wire.js` | both | name rule, size caps, origin / progress / meta checks, args sha, `RemoteError`, the coalescer |
| `src/apps/fleet-remote.js` | master | call, job records, grants, governance, events, link + resync |
| `src/apps/fleet-remote-host.js` | slave | handler registry, dispatch, remote job start, `remoteContext()`, progress frames |
| `src/apps/peer-server.js` | slave | the `/api/peer/fleet-remote/*` routes |
| `src/apps/peer-channel.js` | both | `fr:job` frames (slave → master), their own rate window |
| `src/apps/capabilities/fleet.js` | master + slave | the app API, Bridge methods, kinds, lane, flags, bus sense |

## Limits

- `name` / `kind`: `[a-z0-9._:-]{1,64}`, exact.
- `args` JSON ≤ 256 KB (refused on the master before sending), result ≤ 1 MB
  (refused on the slave, and the master never reads past it), error message
  ≤ 4 KB with no stack, `meta` ≤ 16 KB, a label ≤ 2,048 chars (else verbatim).
- `timeoutMs` default 60 s, max 10 min (a larger value is clamped).
- A remote job's result is the slave's `ctx.jobs` result, so app-jobs' 256 KB
  inline cap applies first.

## Wire

HTTP, slave side, peer-token authed (`/api/peer/fleet-remote/:app`). Every
answer carries `code`; a bare 404 is a slave that predates the routes → the
master's `E_NO_HANDLER` "update vistaclair-pro there".

| Route | Does |
|---|---|
| `GET /:app` | `{ calls: [{ name, readOnly }], jobs: [kind] }` |
| `POST /:app/call` | body `{ name, args, origin, timeoutMs, require, callId }` → `{ result, readOnly }`; `require: 'readOnly'` runs only a readOnly handler, else 409 `needs-approval` without running; a closed request aborts the handler's `signal` |
| `POST /:app/jobs` | body `{ kind, args, id, origin }` → `{ remoteJobId }`; idempotent per master `id` (a retry attaches) |
| `GET /:app/jobs/:job` | `{ job: { id, name, status, progress, meta, result, error, createdAt, finishedAt, remote } }` — remote-tagged jobs only |
| `DELETE /:app/jobs/:job` | `{ cancelled, status }` — `ctx.jobs` cancel (aborts its signal) |

Slave codes → master `err.code`: `no-app` / `not-enabled` / `not-running` →
`E_NOT_RUNNING`; `no-handler` / `own-process` → `E_NO_HANDLER`; `too-large` →
`E_TOO_LARGE`; `timeout` → `E_TIMEOUT`; `remote` (the handler threw) →
`E_REMOTE`; `needs-approval` → a proposal (below). No live channel, a network
error, 403, 429 or ≥ 502 → `E_OFFLINE`; the master's own deadline →
`E_TIMEOUT`.

Channel (slave → master): `{ type: 'fr:job', app, id, remoteJobId, status,
progress: { pct?, label? }, meta?, metaDropped? }` on every change of a
remote job, coalesced to ≤ 4 a second per job (a terminal status flushes at
once). `meta` is the patch since the last frame the master got (keys whose
JSON changed); a patch over 16 KB is not sent (`metaDropped`). The master
accepts a frame only for a record of that peer + app + remote job id, in a
window of `FR_RATE_MAX` (1,200 / min) of its own. A terminal frame makes the
master read the slave's record over HTTP for the result (a frame is ≤ 128 KB).

## Slave

- `registerCall(app, name, fn, { readOnly })` / `registerJob(app, kind, fn)` →
  unregister; refused for an own-process app. `unregisterApp(app)` from
  `app-manager.stopMountedApp` (stop, restart, reload).
- A call runs `fn(args, { peer, origin, signal })` in a spend context
  `{ origin: 'fleet', principal: null }`; `peer` = the master's hostname.
- A job: `fn(args, { peer, origin })` returns a `ctx.jobs.start` spec
  `{ name?, meta?, run }`; the platform starts it with app-jobs' `startJob(…,
  { remote: { peer, id, origin } })` — an ordinary `ctx.jobs` job (owner
  `app`: an app stop interrupts it), whose every change reaches app-jobs'
  `onChange` observers.

## Records (master)

`<appsDir>/.fleet-remote/jobs.json` (`{ jobs, grants }`, ≤ 200 records,
terminal ones dropped after 30 days) and `results/<id>.json`.

`{ id: 'fr-…', app, peer, kind, remoteJobId, status: starting | running |
done | failed | cancelled, link: 'up' | 'down', progress: { pct, label },
meta, remoteMeta, result, error, code, origin, proposalId, argsSha,
startedAt, endedAt }` — `meta` the master's own (`start`'s), `remoteMeta`
the slave job's `meta` (merged patches, ≤ 64 KB), `code` the error code.

- Link: the channel's `disconnected` sets `link: 'down'` on the peer's live
  records, `connected` sets `'up'` and re-syncs them from the slave's job
  store (`GET …/jobs/:job`); both emit a progress event. A slave job that is
  `interrupted` there, or gone, ends `failed`, `error: 'interrupted on
  <peer>'`.
- Master restart: `init` reloads the records (link from the channel) and the
  first `connected` re-syncs. A start cut by the restart before the slave
  answered (`launching`) is posted again (idempotent). A 60 s sweep re-syncs
  live records of online peers and ends proposals decided unseen.
- Cancel: `DELETE` there; unreachable → the record ends `cancelled` and the
  cancel is sent on the next resync (`cancelPending`). A job that ended there
  first keeps its real end (`{ ok: false, status }`).

## Governance

Origin, classified on the master from `spend-context`: `{ kind: 'owner' |
'ai' | 'cron' | 'bot' | 'user', route?, jobId?, tool?, proposalId? }`. `owner` =
`principal() === 'owner'` and no tool `caller()` (the owner's route, or a
`ctx.jobs` job it started: `jobId`); a tool caller → `ai` (`cron` for a cron
caller), `tool` = its type[:app]; else spend origin `cron` / `bot`, else `user`.

| Origin | `call` | `jobs.start` |
|---|---|---|
| owner | runs; audit row `{ action: 'executed', kind: 'app.remote_call', via: 'app:<app>', peer, name, argsSha, origin }` unless the handler is readOnly | runs; audit row `app.remote_job` |
| other, readOnly handler | runs, logged (console), not ledgered | — |
| other | proposal `app.remote_call`, throws `E_REFUSED` + `err.proposalId` | proposal `app.remote_job` → `{ id, proposed: true, proposalId }` |
| other, holding a grant | runs once (the grant is spent), audit row with the `proposalId` | — |

- **Kinds** (platform-staged without `meta.app`, so independent apps get
  them; ceiling-pinned `propose`; owner-only `approveFrom`): payloads `{ app,
  peer, name | kind, argsSha, argsSummary, argsBytes, origin }` (+ `id`,
  `meta` for a job). Identity: app + peer + name/kind + args sha (a repeat
  collapses into the pending card; `start` returns the pending twin's record).
  Card: app, slave, name/kind, the args summary (≤ 300 chars), the sha, the
  size, who asked.
- **Grant** (`app.remote_call` execute → `addGrant`): `{ app, peer, name,
  argsSha, proposalId, expiresAt }`, one-shot, 10 min (`GRANT_TTL_MS`),
  persisted with the records. The identical retry (same app, slave, name and
  args sha) from any origin takes it; a retry that never reached the handler
  (`E_OFFLINE`, `E_NOT_RUNNING`, `E_NO_HANDLER`) puts it back.
- **Job approval** (`app.remote_job` execute → `startApproved`): starts the
  `starting` record under its id with the args it holds (sha re-checked),
  origin + `proposalId`. Denied / withdrawn / expired (the `horst:proposal`
  broadcast, the sweep) → `cancelled`, `code: 'E_REFUSED'`. A cancel of a
  pending one withdraws its proposal.

## Events

- Engine (`subscribe`): `fleet:job:progress { id, app, peer, kind,
  remoteJobId, pct, label, link, meta? }` (`meta` = the patch since the last
  event) and `fleet:job:done { id, app, peer, kind, ok, status, result,
  error }`. Coalesced to ≤ 4 a second per job (`makeCoalescer`); `done`
  flushes the pending progress first, so the last one is never dropped.
- Bridge (`wireAppEvents`): the same, without `app`, as `app:bridge:event`
  to the owning app. routes.js: `on(app, 'progress' | 'done', fn)` → off.
- Bus: `fleet:job:done { id, app, peer, kind, ok }` (sense, agenda). Horst:
  `fleet_remote_jobs` lists the records (read-only).

## Internal API

Master — `require('./fleet-remote')`:

| Call | Returns |
|---|---|
| `call(app, peer, name, args, { timeoutMs })` | the result, or throws `RemoteError` (`err.code`, `err.proposalId` on `E_REFUSED`) |
| `start(app, peer, kind, args, { meta })` | `{ id }` / `{ id, proposed: true, proposalId }`; an owner start that fails throws with `err.id` (the record is `failed`) |
| `status(id)` / `list({ app?, peer?, kind?, status? })` / `cancel(id)` | record(s) / `{ ok, remoteCancelled }` |
| `on(app, event, fn)` · `subscribe(fn(event, data))` | unsubscribe |
| `trackAppListener(app, off)` · `unregisterApp(app)` | per-app listeners, dropped on app stop |
| `addGrant(payload, proposal)` · `startApproved(payload, proposal)` | the kinds' executors |
| `classifyOrigin()` | the origin above, for the current spend context |

Slave — `require('./fleet-remote-host')`:

| Call | Returns |
|---|---|
| `remoteContext()` | `{ via: 'call' \| 'job', peer, id, name, origin, jobId? }` or `null` — inside an onCall handler or a remote job's `run`, across awaits (AsyncLocalStorage). `peer` = the master's host, `id` = the master's record id (`fr-…`; a call's own id), `origin` as above (`proposalId` when the owner approved it), `jobId` the slave's `ctx.jobs` id |
| `registerCall` / `registerJob` / `unregisterApp` / `handlers(app)` | above |
| `call` / `startJob` / `jobStatus` / `cancelJob` | what the routes serve |

Wiring: `index.js` inits both (the host observes app-jobs, the master
reloads and listens to the channel and `horst:proposal`) and shuts them down.

## App API (`src/apps/capabilities/fleet.js`)

| Member | Engine |
|---|---|
| `ctx.fleet.call(peer, name, args, { timeoutMs })` | `call(app, …)` |
| `ctx.fleet.jobs.start(peer, kind, args, { meta })` | `start(app, …)` |
| `ctx.fleet.jobs.status(id)` / `.cancel(id)`, Bridge `fleet.jobs.status` / `.cancel` | refused unless `rec.app` is the caller |
| `ctx.fleet.jobs.list({ peer?, kind?, status? })`, Bridge `status` without `id` | `list({ app: caller, … })` |
| `ctx.fleet.jobs.on('progress' \| 'done', fn)` | `on(app, …)` |
| `ctx.fleet.dataPublish.on('progress' \| 'done', fn)` | fleet-data's two `subscribe`s filtered to the app, the Bridge `fleet:data:*` payloads |
| `ctx.fleet.onCall(name, fn, { readOnly })` / `ctx.fleet.onJob(kind, fn)` | `registerCall` / `registerJob` |

- Flags `fleet.call` and `fleet.jobs`. Own-process apps: no `ctx.fleet`
  (`visibility.standalone: false`); their iframe keeps the Bridge methods.
- Starts and calls are not on the Bridge: the app's route makes them.
- Horst lane: `fleet.jobs.status` direct (`fleet_remote_jobs`),
  `fleet.jobs.cancel` never (the app's own control); call / start are
  ctx-only and reach the owner as `app.remote_call` / `app.remote_job` cards
  through the app's own tool.

## Not built

- Own-process apps on either end.
- A cross-app call, or a call from a slave to its master.
- Streaming args or results past the caps (use the data publish).
- Pushing a call's partial output (a call is one request; use a job).
- A per-app or per-peer rate limit on calls beyond the channel's and the
  limiter's.
