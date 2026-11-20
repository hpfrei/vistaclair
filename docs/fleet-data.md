# Fleet data publish (master → slave app data)

The twin of the code publish (`docs/federation.md`): a master streams a
declared set of content-addressed blobs from an app's data dir to the same
app on a linked slave, and the slave app's `receive` hook imports them. Same
peer token, same https rule, same auth-failure limiter, no new port. The up
direction (slave → master, the same API and run) is `docs/fleet-data-up.md`.

| File | Side | Duty |
|---|---|---|
| `src/apps/fleet-data-manifest.js` | both | manifest shape, limits, canonical JSON + sha256 |
| `src/apps/fleet-data.js` | master | path checks, transfer records, streaming, retry, resume, events |
| `src/apps/fleet-data-receive.js` | slave | receiver registry, inbox, sha verify, disk margin, receive job, expiry |
| `src/apps/peer-server.js` | slave | the `/api/peer/fleet-data/*` routes |
| `src/apps/peer-client.js` | master | `uploadFile(…, { method: 'PUT', start, length })` streams one byte range |
| `src/apps/publish.js`, `public/publish.js` | master | the peers panel rows (list, live progress, cancel) |

## Manifest

`{ format?, blobs: [{ sha256, bytes, path }], extra? }`

- `sha256` 64 lowercase hex; `bytes` a non-negative integer; one sha may sit at
  several paths, never with two sizes.
- `path` is relative to the app's data dir (`<appDir>/.data`). The master
  refuses an absolute path, a `..` segment, a path whose realpath leaves the
  data dir (symlink), a non-regular file, and a size that differs from
  `bytes`. The master does not hash; the slave verifies.
- Limits: ≤ 100,000 blobs, `path` ≤ 1,024 chars, `extra` ≤ 256 KB of JSON,
  the whole canonical manifest ≤ 16 MB.
- Canonical JSON = object keys sorted at every level, arrays in order; its
  sha256 is the **manifest sha**. Both sides compute it; the plan refuses a
  mismatch (`sha-differs`).
- Transfer name: `[a-z0-9._-]{1,64}` (the app's label, e.g. `world-fe54…`).

## Identity, resume

- Master transfer id = `fd-` + sha256(`peerId \n app \n name \n manifestSha`)[0:24].
  `start` with the same peer, app, name and manifest re-attaches to a running
  transfer, or resumes / re-runs a finished one under the same id.
- Only one running transfer per peer + app + name; a different manifest under
  that name is refused until the running one is cancelled.
- Master records: `<appsDir>/.fleet-data/transfers.json` (≤ 200, terminal ones
  dropped after 30 days) and `manifests/<manifestSha>.json`. Progress counters
  are persisted every 2 s, phase changes at once.
- Master restart: `init` relaunches every `running` record; the run first asks
  the slave's status and continues at its verified blobs and partial offsets.
  `shutdown` aborts in-flight requests but leaves records `running`.
- Slave restart: the inbox and its partial files are on disk; the receive job
  becomes `interrupted` (app-jobs boot sweep) and the master commits again.

## Slave routes (`/api/peer/fleet-data`, peer-token authed)

Every answer carries `code` (`ok` or an error code); a bare 404 without one is
a slave that predates the routes → the master reports "update vistaclair-pro
there". App names are validated as elsewhere; transfer name and shas as above.

| Route | Does |
|---|---|
| `GET /:app` | `{ installed, enabled, runtime, running, version, commit, freeBytes, marginBytes, receivers }` |
| `POST /:app/plan` | body `{ name, manifest, sha, open }` (JSON ≤ 17 MB) → `{ need, needBytes, haveBytes, freeBytes, marginBytes, fits, partial, blobs, state }`; `open` creates the inbox |
| `GET /:app/:name/:msha` | `{ exists, state, error, need, needBytes, partial, verified, commit }` — resume point |
| `PUT /:app/:name/:msha/blobs/:sha?offset=n` | one raw chunk, `Content-Length` ≤ 8 MB → `{ offset, verified }` |
| `POST /:app/:name/:msha/commit` | all needed blobs verified → `{ jobId }` (an app job, polled via `GET /jobs/:app/:id`) |
| `DELETE /:app/:name/:msha` | cancel: aborts a running receive, removes the inbox |

Chunk rules: streamed to `partial/<sha>` through a counting transform, never
buffered; `offset` may be ≤ the bytes held (the file is truncated there
first), above it → 409 `offset` with the held size; past the blob's end →
400; a second writer on the same blob → 409 `busy`. Error codes: `bad-app`,
`bad-name`, `bad-sha`, `bad-blob`, `bad-manifest`, `sha-differs`, `no-app`,
`not-enabled`, `own-process`, `no-receiver`, `cross-device`, `have-failed`,
`no-transfer`, `not-open`, `not-needed`, `past-end`, `chunk-too-big`,
`no-space`, `sha-mismatch`, `incomplete`, `failed`.

## Inbox

`<appsDir>/.fleet-inbox/<app>/<name>.<manifestSha>/` holds `transfer.json`,
`manifest.json`, `partial/<sha>` (being written) and `inbox/<sha>` (verified;
the dir `receive` gets as `inbox`).

- Outside every app dir on purpose: a code publish (`git archive <app>/`)
  never ships it, the code swap (`deployCode`) never wipes it, and the app
  does not meet half-written blobs when it walks its own `.data`.
- It must be on the data dir's filesystem so `receive` can hard-link or
  rename a blob in: `st_dev` of `<appDir>/.data` (realpath) and of the inbox
  are compared at plan time; different → 409 `cross-device`.
- The platform never writes outside the inbox.

## Integrity

- When a blob's last byte lands, the slave hashes the file. Match → renamed to
  `inbox/<sha>`. Mismatch → dropped, 422 `sha-mismatch`; the master re-sends
  it from 0. A second mismatch of the same blob fails the transfer
  (`blob <sha> failed its sha256 check twice`). A new `start` of a failed
  transfer re-plans and resets the count.
- `commit` refuses (`incomplete`) until every needed blob is in `inbox/`.

## Disk

- `freeBytes` = `statfs(inbox).bavail × bsize`. Margin = max(1 GiB, 2 % of the
  filesystem). `fits` = `needBytes + margin ≤ freeBytes`; the master fails a
  transfer that does not fit before sending a byte.
- Every chunk is refused (507 `no-space`, fatal on the master) when writing it
  would leave less than the margin free, so the disk never fills mid-way.

## Receive

- `have(manifest)` → the shas the app holds (array or iterable). The delta =
  manifest − held − verified in the inbox. A blob the app holds is never sent.
- `receive({ manifest, extra, inbox, peer, signal, setProgress })` runs once
  per commit as app job `fleet-data:receive` (owner `app`: an app stop or
  reload aborts it via `signal`). `peer` = the master's hostname.
  `{ ok: true, summary }` → the inbox is removed, the master's result is
  `summary`. A throw or `ok` not `true` → the job fails with that reason, the
  inbox stays for a retry.
- An empty delta still commits: a second publish of the same manifest sends
  0 bytes and runs `receive` again — `receive` must be idempotent.

## Master run

`plan` (or status on a resume) → `sending` (4 blobs in flight, 8 MB chunks read
with `fs.createReadStream({ start, end })`) → `receiving` (commit, poll the job
every 2 s) → `done` / `failed` / `cancelled`.

- Transient (network, 429, ≥ 502, `busy`, `offset`, `incomplete`, `not-open`,
  `no-transfer`, a short or long body, `no-receiver` after the first plan, an
  interrupted or vanished receive job): status again, then retry with
  backoff 2 s → 60 s. No progress for 30 min fails the transfer
  ("no progress with <peer> for 30 min: …").
- Anything else (a refusal code, 403, `fits: false`, a failed receive) fails
  at once.

## Expiry

An inbox with no activity (plan, chunk, commit — `transfer.json`'s mtime) for
7 days is removed; boot sweep plus an hourly timer
(`fleet-data-receive.init`). A running receive is never swept.

## Internal API (for the capability layer)

Master — `require('./fleet-data')`:

| Call | Returns |
|---|---|
| `peers(app)` | `[{ peer, host, label, online, supported, app: { installed, enabled, running, version, commit, runtime }, disk: { freeBytes, marginBytes }, receivers, error }]` — linked slaves with the app (offline ones from the channel snapshot) |
| `plan(app, peer, { name, manifest })` | `{ peer, name, manifestSha, blobs, need, needBytes, haveBytes, freeBytes, marginBytes, fits }` — nothing is created on the slave |
| `start(app, peer, { name, manifest, meta?, origin? })` | `{ id, attached? }` — `meta` JSON ≤ 16 KB |
| `status(id)` / `list({ app, peer?, name? })` | record(s): `{ id, app, peer, name, manifestSha, status, phase, label, sentBytes, needBytes, wireBytes, blobs, blobsNeed, blobsDone, summary, error, meta, origin, … }` |
| `cancel(id)` | `{ ok, slaveCleared }` |
| `stage(app, peer, { name, manifest })` | `{ id, peer, manifestSha, blobs, totalBytes }` — start's checks, the manifest stored under its sha, nothing sent (a proposal's payload carries only the sha; a staged manifest without a record is pruned after 8 days) |
| `startStaged(app, peer, { name, manifestSha, meta?, origin? })` | `start` with the staged manifest (`stagedManifest(sha)`) |
| `subscribe(fn(event, data))` | unsubscribe; `fleet:data:progress { id, app, peer, name, dir, sentBytes, needBytes, blobs: { total, need, done }, phase, label }`, `fleet:data:done { id, app, peer, name, dir, ok, summary }` |

Slave — `require('./fleet-data-receive')`:

| Call | Does |
|---|---|
| `registerReceiver(app, pattern, { have, receive })` | → unregister fn; `pattern` an exact name or a `*`/`?` glob; exact beats glob; throws for an own-process app |
| `unregisterApp(app)` | called by `app-manager.stopMountedApp` (stop, restart, reload) |
| `subscribe(fn(event, data))` | `fleet:data:progress { app, name, manifestSha, dir, phase: receiving\|verifying\|receive, receivedBytes, needBytes, blobs, label? }`, `fleet:data:done { app, name, manifestSha, dir, ok, summary }` |

Wiring: `index.js` inits both (the master resumes, the slave sweeps) and shuts
them down.

## App API (`src/apps/capabilities/fleet.js`)

The capability module scopes the engine to the calling app; the app-facing
text is its `_api-reference.md` SECTION (`.vistaclair/api/fleet.md`).

| Member | Engine |
|---|---|
| `ctx.fleet.peers()`, Bridge `fleet.peers` | `peers(app)` (rows carry `specs`; `ctx.fleet.self()`, `fleet.self`: `docs/fleet-specs.md`) |
| `ctx.fleet.dataPublish.plan(peer, { name, manifest })`, Bridge `fleet.dataPublish.plan` | `plan(app, …)` |
| `ctx.fleet.dataPublish(peer, { name, manifest, meta })` | `start` (owner) or `stage` + `app.data_publish` (else) |
| `.status(id)` / `.cancel(id)`, Bridge `fleet.dataPublish.status` / `.cancel` | `status` / `cancel`, refused unless `rec.app` is the caller |
| `.list({ peer?, name? })`, Bridge `status` without `id` | `list({ app: caller, … })` |
| `ctx.fleet.onDataReceive(pattern, { have, receive })` | `registerReceiver(app, …)` → unregister |
| `ctx.fleet.dataPublish.on('progress' \| 'done', fn)` | both `subscribe`s filtered to the app → the Bridge payloads below; dropped on app stop (`docs/fleet-remote.md`) |

- **Who starts.** `spend-context`: `principal() === 'owner'` and no tool
  `caller()` (the owner's route, or a `ctx.jobs` job it started) → `start` at
  once plus an audit row `{ action: 'executed', kind: 'app.data_publish', via:
  'app:<name>' }`. Anything else (a tool call by Horst / an app session / a
  worker, cron, a bot, an app user) → `stage`, a best-effort `plan` for
  `needBytes`, and `requestAction('app.data_publish', …)` without `meta.app`
  (platform-staged, so the kind stays platform-owned and independent apps get
  it) → `{ id, proposed: true, proposalId }`.
- **Kind `app.data_publish`**: payload `{ app, peer, name, manifestSha, blobs,
  totalBytes, needBytes, fits, meta }`; ceiling-pinned to propose; owner-only
  `approveFrom` (`peer-security.ownerOnlyApproveFrom`); identity = app + peer +
  name + manifest sha (a repeat collapses into the pending card); card: app,
  slave, name, blobs, bytes to send, total; execute → `startStaged`.
- **Flag** `fleet.sync` (module `flags`): listed by `ctx.capabilities` and
  `capabilities.list` while the engine modules load.
- **Own-process apps**: `visibility.standalone: false` — no `ctx.fleet` (the
  runner would drive a second engine on the same records); the Bridge methods
  still serve their iframe. `registerReceiver` refuses them too.
- **Events**: `wireAppEvents(broadcaster)` (index.js, after the engine inits)
  maps both engines' events to `app:bridge:event` for the owning app — the
  `job:update` path: `fleet:data:progress { side, dir, role, id, peer, name,
  sentBytes, needBytes, blobs, phase, label }`, `fleet:data:done { side, dir,
  role, id, peer, name, ok, summary }`; `side` the host end, `dir` `down`
  here, `role` sender | receiver. Slave: `id` = `<name>.<manifestSha>`, `peer`
  = the master's host, `sentBytes` = received bytes. The master's done is also the bus sense
  `fleet:data:done` (Horst lane: `fleet_data_transfers` reads the records).

## Peers panel (dashboard, master)

Setup → Remote lists each linked slave's data publishes under its row
(`public/publish.js` `dataBoxHtml`; server half in `publish.js`).

| WS | Does |
|---|---|
| `app:fleet:data:list` → `{ transfers }` | `list({})` as slim rows (no `meta`, no `origin`); sent on connect (master), on request and broadcast after every `fleet:data:done` — a reload reattaches from it |
| `app:fleet:data:progress { transfer }` | broadcast per engine progress event (`publish.init` subscribes); the client patches that slave's box in place |
| `app:fleet:data:cancel { id }` → `app:fleet:data:cancelResult { id, ok, slaveCleared?, error? }` + the list | the owner's Cancel button → `cancel(id)`; an unknown id → `unknown transfer` |

- Per slave: the running ones, then the 5 newest finished. A row: app ·
  name, phase, `sentBytes` / `needBytes` bar, blobs done / needed, the
  label while running, then the summary (done) or the error.
- Cancel is owner-click only (`horst-completeness` allowlist); Horst's lane
  keeps `fleet.dataPublish.cancel` at `never`.

## Not built

- Receivers in own-process apps (their code runs in another process).
- Rollback: no manifest history on the slave, no rollback route, no
  `app.data_rollback` kind.
- A start button on the peers panel: a data publish starts from the app's
  own UI (its manifest is the app's); the panel only watches and cancels.
- A per-app admin quota on the slave (only the filesystem margin).
- Re-hashing on the master; a blob changed after `start` fails on the slave.
