# Fleet data publish — up (slave → master)

An app on a fleet slave sends a declared set of content-addressed blobs to the
same app on its master. The API, manifest, identity, inbox, integrity, disk
margin, expiry, limits and `receive` job are the down direction's
(`docs/fleet-data.md`); this doc covers what differs. Capability flag
`fleet.sync.up`.

| File | Side | Duty |
|---|---|---|
| `src/apps/fleet-data-up.js` | slave | `master()`, plan / publish / status / list / cancel / subscribe, the mirror records, what the routes serve |
| `src/apps/fleet-data-up.js` | master | `handleRequest` (the channel ops), `endpoint(rec, peer)` for the run, `decide` (governance), the `fr:fd` pushes |
| `src/apps/fleet-data.js` | master | the run itself: records with `dir: 'up'`, `endpointFor` picks the endpoint |
| `src/apps/fleet-data-receive.js` | master | inbox, sha verify, margin, `receive` job, expiry — the same code as on a slave |
| `src/apps/peer-channel.js` | both | `fr:req` / `fr:reply` (slave asks, master answers), `fr:fd` (master pushes) |
| `src/apps/peer-server.js` | slave | `GET /api/peer/fleet-data-up/…` (manifest, byte ranges) |
| `src/apps/peer-client.js` | master | `download(peer, path)` — a streamed GET with the peer token |

## Transport

The slave holds only the hash of the peer token; it never calls the master
over HTTP, and nothing new is opened. Two existing links carry it:

- **The channel** (the master's WebSocket to the slave): the slave asks with
  `fr:req { id, op, args }`, the master answers `fr:reply { id, ok, result |
  error: { code, message } }` (`askMaster` / `onSlaveRequest`, 30 s default,
  ≤ 128 KB a frame). The master pushes its record of each up transfer as
  `fr:fd { rec }` (`sendToSlave`). No manifest or blob byte crosses the channel.
- **The peer client** (master → slave https, the peer token): the master
  pulls the manifest and byte ranges into its own inbox.

| Op (`fr:req`) | Master does |
|---|---|
| `fd.info { app }` | `receive.info(app)`: installed / enabled / running / version / free / margin / receivers |
| `fd.plan { app, name, manifestSha }` | GETs the manifest, `receive.plan` → `{ need, needBytes, haveBytes, freeBytes, marginBytes, fits }` |
| `fd.start { app, name, manifestSha, meta, origin }` | GETs the manifest, decides (Governance) → `{ id, attached? }` or `{ id, proposed, proposalId }` |
| `fd.cancel { id }` | `fleet-data.cancel(id)` — only an up record of that slave |
| `fd.sync {}` | that slave's up records (≤ 100, slim) |

A request from a host that is no linked peer of this master is refused
(`unknown-peer`); a master without the handler answers `no-handler` ("update
vc on the master").

| Slave route (peer-token authed) | Serves |
|---|---|
| `GET /fleet-data-up/:app/:name/:msha/manifest` | `{ manifest }`, the canonical one; the master re-hashes it (`sha-differs`) |
| `GET /fleet-data-up/:app/:name/:msha/blobs/:sha?offset&length` | the file range, streamed with `Content-Length` |

A range is ≤ 8 MB (413 `chunk-too-big`). The slave serves only what it
offers: the entry must exist (410 `not-offered`) and not be cancelled here
(410 `cancelled`), the blob must be in the manifest (`not-needed`), the range
inside the blob (`past-end`), and the file must pass the same path checks as at
publish time, re-run per range (409 `source-gone`). All but `cancelled` fail
the transfer; `cancelled` ends it as cancelled.

## The run on the master

`fleet-data.js` runs an up record like a down one, through an endpoint
`{ where, status, plan, put, commit, job, cancel }`. Down: HTTP to the slave.
Up (`fleet-data-up.endpoint`): calls into this host's `fleet-data-receive.js`;
`put` downloads the range from the slave and streams it into `writeChunk`
(a short or long body is transient, as down). So the inbox lives on the
master (same filesystem as the master app's data dir), the margin is the
master's, `have` / `receive` are the master app's, and the `receive` job
`fleet-data:receive` runs on the master; its `{ ok, summary }` ends the record.
`receive({ …, peer })` gets the slave's host. Same chunk size, retries, the
twice-failed blob, the 30 min stall and the 7-day idle inbox as down.

- **Identity.** `fd-` + sha256(`up\n` + slave peer name, app, name, manifest
  sha)[0:24] — never the id of a down transfer. Same slave + name + manifest
  = the same transfer: a repeat call attaches (`attached: true`) or resumes.
- **One sender per inbox.** The inbox key is app + name + manifest sha, so an
  up transfer with the same three from another slave is refused while one runs.
- The up run skips the down run's local path checks (the files are on the
  slave; it re-checks them per range).

## The slave's records

The slave keeps one entry per app + name + manifest in
`<appsDir>/.fleet-data/up.json`, and the manifests it offers in
`up-manifests/<sha>.json`. An entry mirrors the master's record: status
`running | done | failed | cancelled` (plus internal `staged` / `proposed`,
not shown to the app — a proposal has no record yet, as down), phase, label,
`sentBytes` (bytes the master received), blobs, summary, error.

- Every master record change is pushed (`fr:fd`); a push during the
  `fd.start` answer wins over the answer.
- On every (re)connect the slave asks `fd.sync`; a running entry the master no
  longer knows fails ("the master no longer has this transfer").
- `status(id)` / `list()` read the mirror, so they work offline.

## Cancel

| From | Does |
|---|---|
| The slave (`ctx.fleet.dataPublish.cancel(id)`) | marks the entry cancelled and stops serving it at once (410 `cancelled`), then asks `fd.cancel` → `{ ok, masterCleared }`. With the link down the master's next range read ends its record as `cancelled on <slave>` and drops the inbox |
| The master (the panel, `ctx.fleet.dataPublish.cancel` in the master app) | `fleet-data.cancel(id)` → `{ ok, inboxCleared }`; the slave hears it from the push or the next sync |

A cancel on the slave stands against a later `running` push.

## Governance

The master decides, from its own records; the slave's word is only which
remote job it runs under (and what it claims for its owner's click, believed only for a trusted peer; a
claim that is not believed is stored as `user`) (`remoteJob`, from `remoteContext()`, docs/fleet-remote.md).

| Origin on the slave | Master does | Ledger `via` |
|---|---|---|
| inside a remote job (`ctx.fleet.jobs.start` on the master) whose `origin.kind === 'owner'` | starts at once | `owner via fleet.jobs <id>` |
| inside a remote job whose origin carries a `proposalId` the owner approved | starts at once | `owner (approved <proposalId>) via fleet.jobs <id>` |
| the owner's own click on the slave (its origin claims `owner`, not inside a remote job) **and** this master's record of the peer has `trustOwnerClicks` (off by default; the "Owner clicks" button on the slave's row) | starts at once | `owner on <slave> via app:<app>` |
| anything else (cron, AI, a bot, a user, a remote *call*, an untrusted job, an `owner` claim from a peer not trusted for it) | stages it and files an `app.data_publish` proposal on the master; approval starts it | the proposal's |

The remote-job rule in full: the record `<id>` must be this master's, for the
same app and the same slave, and live — `starting` / `running`, or `done` less
than 60 s ago. For the approved case the `proposalId` (the record's
`origin.proposalId`) must name an `app.remote_job` proposal whose
`payload.id` is that same record id, with status `approved` or `executed`.
Any check failing makes it a proposal, not a refusal.

The proposal: kind `app.data_publish` with `dir: 'up'` in its payload
(`{ dir, app, peer, name, manifestSha, blobs, totalBytes, needBytes, fits,
meta, origin }`), its identity prefixed `up:`, a card showing the direction,
"To receive" and "Asked by"; requested with origin `cron` for a cron, else
`peer`. Approval runs `startStaged(..., 'up')`. A proposal lives 7 days, as
down. Horst's lane stance is the kind's, the same in both directions.

## Events

`fleet:data:progress` / `fleet:data:done` carry `dir: 'up'`, on the master's
engine (`peer` = the slave, `side: 'master'`) and on the slave's mirror
(`peer` = the master's host, `side: 'slave'`). `ctx.fleet.dataPublish.on` and
the app's bridge events add `role: 'sender' | 'receiver'`; `side` stays the
host end. The master's done also goes on the bus (the fleet sense, "from
<slave>"). The master's inbox events for an up transfer are not repeated to
the app — the record's carry the same id.

## Peers panel

Setup → Remote on the master lists up transfers in the slave's box with the
down ones; each row is marked ↑ (to this master) or ↓ (to the slave)
(`data-fd-dir`). Cancel works for both; for an up row it drops the master's
inbox.

## Not built

- Own-process apps: no receive on either end, as down.
- A slave publishing to another slave, or to anything but its own master.
- Rollback of an imported publish.
- A remote *call* (`ctx.fleet.call`) vouching for a publish: only remote
  jobs do.
