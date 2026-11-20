# Federation (master ⇄ slaves, one logical platform)

- **Pairing** is slave-initiated and human-approved (`peer.pair` proposal,
  `peer-pairing.js` — master holds raw tokens, slave only the hash).
- **Control plane** is HTTP (`peer-server.js` on the slave, driven by
  `peer-client.js` on the master).
- **https only** (`peer-security.js`) — the peer token is a bearer credential
  for the whole slave, so it never travels over plain HTTP. Pairing refuses a
  non-`https://` `masterUrl` / `publicUrl` (loopback `http://` excepted);
  `peer-client.js` refuses to send the token to a non-https base (same
  exception) and never follows a redirect (`redirect: 'manual'`, a 3xx is an
  error). A peer linked over `http://` before this rule is kept but flagged
  `needsRepair` (in `listPeersPublic` and `fleetState().peers[]`): no call, no
  channel, no key sync until the owner re-pairs it over https.
- **Peer input is untrusted** — the slave's snapshot (`deployed`,
  `apps[].name`, `disabled`, `domains`) is filtered in `applySnapshot` to plain
  app names / hostnames; git runs via `execFile`, never a shell. The slave's
  `/apps/:name/status` reports the app manager's view (no HTTP self-fetch, no
  core token sent to an app).
- **Pairing never replaces silently** — a request whose name is already linked
  files a card that says `REPLACE` and names the peer on file; the payload's
  `replaces` (that peer's id) is the confirmation `approveRequest` demands. A
  name that is linked and not confirmed that way (a peer linked since the card
  was filed, a bare call) is refused; unlink first.
- **Opening a slave's dashboard** — `GET /api/peer/access?v=2` returns a
  one-time login link (`loginPath`, core's `/login/once`, minted over loopback
  with `POST /api/login/login-link` and the internal header; single use, 5 min)
  plus the slave's public URL; the permanent token never leaves the slave. No
  `?v=2` (an older master) → 426 "update the master"; core cannot mint → 502.
  Master side: `peer-access.js` (`fetchAccess`), shown by the Access button in
  Apps → Remote. A slave that still answers with `token` is shown with an
  "outdated" warning. Update the master first, then the slaves.
- **Secret files** — `.peers.enc` / `.peer.enc` and the `.secrets_key` beside
  them are chmod 0600 at init and after every write (core's secret store sets
  the mode only on creation). Format and location are unchanged.
- **Owner-only approval** — `peer.pair`, `app.publish`, `app.rollback`,
  `peer.keys.sync` and `peer.restart` carry `approveFrom:
  ownerOnlyApproveFrom` (`ui`, `ui-full`, `miniapp`, `telegram` only); an
  `app:<name>` decider is refused. A slave accepts its token only after the
  master approved (`pending.tokenHash` is promoted on `approved`).
- **Channel** — the master keeps a persistent WebSocket per slave
  (`peer-channel.js`, master-initiated to the slave's `/api/peer/channel`,
  accepted via the descriptor's `handleUpgrade`, peer-token authed; the path
  is `CHANNEL_PATH`, declared in `authExemptUpgradePaths` so core skips the
  owner gate for it). Slave →
  master flows are read-only, summary-level senses: status snapshots
  (versions, deployed commits, per-app health), app errors / crash loops,
  sysmon pressure, terminal peer-job transitions, a daily spend/storage
  summary; the snapshot also carries `claude` (below) and `specs` (hardware, `docs/fleet-specs.md`), and the
  progress of an app's remote jobs (`fr:job`, `docs/fleet-remote.md`), and
  a slave's data-publish requests to its master (`fr:req`, answered by
  `fr:reply`; `docs/fleet-data-up.md`). Master → slave is pings,
  remote-session commands and those replies plus the up transfers' record
  pushes (`fr:fd`). Ingest is guarded (frame/rate caps per
  connection, then the bus's per-kind rate/storm caps) and every relayed
  envelope is tagged `{ host, hop }`. The upgrade takes the token from the
  `X-Vistaclair-Peer-Token` header only, and its failures count into
  peer-server's per-client auth-failure window (10/minute, then 429).
- **Auth-failure limiter** (`peer-server.js`, also the channel upgrade) —
  the token is checked first: a correct one always passes, only failures are
  counted and refused with 429. The key (`clientIp`) is the TCP peer, or, when
  that is loopback (a local reverse proxy), the last `X-Forwarded-For` hop.
  `/register` checks the limiter first (it creates a request), limits
  successful calls too (5/hour per IP), caps pending requests (10), and
  validates `name` (slug) and `publicUrl` (parsed https URL, ≤ 200 chars, no
  whitespace); each call makes its own request, so a repeat never replaces the
  token or secret of a pending one. `/register/:id/status` checks its poll
  secret first.
- **Horst** reaches the fleet through `capabilities/fleet.js`: `peer:*` senses,
  the read-only `fleet_status` tool, and the ceiling-pinned kinds `app.publish`
  / `app.rollback` / `peer.keys.sync` / `peer.restart` / `peer.session.launch`
  (`docs/remote-sessions.md` "The card"). `peer.kill` deliberately
  has NO kind — owner-click only.
- **Publish** (`publish.js`) is one persistent master-side job (wizard
  reattaches after a reload): `preflight` (commit/push) → `enable` → `code`
  (git-archive bundle, swapped in on the slave) → `install` (npm, slave job) →
  `toolchains` → `restart` → `health`. It carries no app data (`.data/`, DB,
  settings stay per host); an app copies data with the data publish below.
- **`toolchains` step** (only when `manifest.toolchains` is set) — the keys map
  to platform extras through `platformExtras.extrasForToolchains` (the badge's
  map; install order from each extra's `after`). The slave's
  `GET /extras?ids=…[&actions=1]` reports `platformExtras.list()` rows and,
  with `actions`, `platformExtras.ownerActions()`; `POST /extras/:id/install`
  is `platformExtras.install()` — the Setup → Extras installer, so its
  persisted progress is the job the master polls (5 s; fails after 5 min
  unreachable or 8 h). Present → skipped; missing → installed one by one, the
  slave's phase label relayed; an install error fails the publish with that
  error; a slave without the route or the extra → "update vc
  there". An owner action on the slave (the Unity licence is per machine) ends
  the step as `warn` and lands in `result.warnings`, shown in the wizard. A
  cancelled or master-restarted publish leaves the slave's install running; the
  next publish attaches to it. The wizard's Toolchains section
  (`app:publish:toolchains`, per chosen peer) shows present / will install
  (size) / installing / the owner actions before Publish, each with a link to
  the slave's own Setup → Extras (`setupUrl` = `<baseUrl>/?setup=extras`); the `app.publish`
  card names the declared toolchains.
- **Data publish** — an app's data blobs travel separately, content-addressed
  and resumable: `docs/fleet-data.md`; from a slave up to its master (the
  master pulls, the slave holds no credential): `docs/fleet-data-up.md`.
- **Remote call / job** — an app calls its own copy on a slave or starts a
  job there, governed, progress pushed back: `docs/fleet-remote.md`.
- **Versioned publish** — the slave keeps the last 3 code bundles
  (`.peer-bundles/`, in `CODE_PRESERVE`) plus a deploy history in
  `.deployed.json`; `POST /apps/:name/rollback` re-installs a kept bundle
  through the same swap path. Data is never rolled back; `.peer-backup/` (in
  `CODE_PRESERVE`) is kept and its timestamps listed in the history only
  where an older data import left one — nothing writes it now.
- **Workspaces survive a deploy** — `workspaces/<id>/` (cli.workspace) is
  half tracked, half local: the swap carries over every workspace the bundle
  lacks and, inside a shipped one, every entry it lacks (`carryWorkspaces`);
  what the bundle ships replaces the local copy.
- **Per-host config on a mirror** — App Config works on a master-published
  app: `setAppConfig` → `app-manager.updateHostConfig` writes
  `.host-config.json` (in `CODE_PRESERVE`) instead of the master's
  `manifest.json`, and `readManifest` merges it over the manifest (`null`
  masks a key). Only keys that differ from the published manifest are kept,
  so a slave sets its own domain / access / channels while everything else
  keeps following the master. The slave's snapshot carries `domains`
  (`{ app: domain }` for its deployed apps), so the master's app settings (Config tab)
  shows where each slave's website domain is set. Source edits, rename, delete, autostart and
  description stay blocked on mirrors (`SLAVE_BLOCKED_FOR_DEPLOYED`).
- **Dashboard** — `app:fleet:state` (live per-peer view on the peers panel),
  the data publishes under each slave (`app:fleet:data:*`,
  `docs/fleet-data.md` "Peers panel"), `app:publish:history` / `rollback`
  (per-app history modal, GUI-reload-resilient rollback job).
- Everything degrades to the HTTP flows when the channel is down; no peers →
  no connections.

## Remote sessions — the slave side

The master launches and drives Agent SDK sessions on a slave over the
channel above; `src/apps/peer-remote-slave.js` executes, `peer-channel.js`
routes. The master's half is in `docs/remote-sessions.md`.

| Frame | Shape |
|---|---|
| master → slave | `{ type: 'rs:cmd', id, op, args }` |
| reply | `{ type: 'rs:reply', id, ok: true, result }` / `{ …, ok: false, error: { code, message } }` |
| pushes | `rs:event { tabId, sessId, off?, ev }` (subscribed tabs; core's `sdk:event` ev, no `stream_event` deltas, user-turn images stripped to `imagesOmitted`, an over-cap ev replaced by a warning notice) · `rs:ask { tabId, askId, forms, title }` · `rs:askDone { askId }` · `rs:state { tabId, state: 'started'\|'exited', exitCode?, costUsd?, credential? }` · `rs:auth { problem, text }` |

Ops: `launch {mode, app, prompt, auth, model?, title?, origin}` →
`{tabId, sessId, runId?}`, `list`, `subscribe {tabId, fromOff?}` (replays from
a transcript offset), `unsubscribe`, `submit`, `interrupt`, `setAuth {tabId,
auth, continueTurn?}` (a run member: every live member), `setModel`, `answer
{askId, answer}`, `history {tabId, before?, limit?}` (core's page, shrunk to
fit a frame), `todo` (`{todo, notes}` texts), `kill`. Error codes: `disabled`,
`not-https`, `bad-app`, `no-credential`, `apikey-not-allowed`, `limit`,
`unknown-tab`, `not-remote`, `bad-args`, `unavailable`. Master side:
`peerChannel.remoteCommand(peer, op, args, { timeoutMs })` (rejects with the
slave's code, or `not-https` when the peer's base URL is not `https://` — no
`rs:cmd` goes over `ws://` — `offline` / `timeout` / `disconnected`) and
`onRemoteFrame(fn)`.

Invariants:

- **No new way in** — no route, port or listener; only the token-authed
  channel.
- **Opt-in** — `host-config.remoteSessions()` `{ enabled, allowApiKey }`, both
  false by default, stored in `<dataHome>/remote-sessions/settings.json`
  (outside the apps tree a remote session works in; read at boot), changed
  only by the slave's dashboard (`app:peer:remoteSessions`, Remote pane on a
  slave); no `rs:cmd` or `/api/peer` route touches it. An older `.host.json`
  `remoteSessions` (and `<appsDir>/.remote-sessions.jsonl`) is moved there
  once, when the file does not exist yet; afterwards `.host.json`'s key is
  ignored. No dataHome, or one inside the apps dir → off and unsettable. Off
  → every op `disabled`, no pushes.
- **TLS only** (`channelSecure`) — the upgrade socket is TLS, or the TCP peer
  is loopback (a local reverse proxy) and the last `X-Forwarded-Proto` value
  (the one that proxy set) says `https`; and the slave's paired `publicUrl`
  is `https://`. Else every op `not-https`.
  A peer linked over `http://` is flagged `needsRepair` and gets no commands
  until re-paired over https.
- **Allowlist** — unknown op, non-object args (> 80 KB), bad types → `bad-args`.
  `app` matches `/^[a-z0-9][a-z0-9-]*$/`, realpaths to a direct child of the
  apps dir with a manifest, and never is or holds the Pro or core repo
  (`bad-app`). Prompt ≤ 64 KB. A launch `prompt` or `title` holding a
  character a reader cannot see (`text-safety.invisibleChars`, the same
  checker as `peer.session.launch`) is `bad-args`.
- **Remote tabs only** — a launch stamps `remoteLaunch: { origin, at }`
  (`SESSION_STAMPS.remote`; a run's workers inherit it, and count by runId).
  Every op but `launch`/`list` refuses other tabs (`not-remote`); `list` and
  the pushes never show local sessions; `answer` resolves only a pending
  question bound to a remote tab.
- **Billing is explicit** — the launch names `auth`; its credential must exist
  (`ctx.resolveAuth` per mode, never the other credential: `no-credential`);
  `apikey` needs `allowApiKey`. No `confirmApiKeyBilling` ask on the slave.
- **Caps** — 3 live remote launches (a run once), 5 live remote workers
  (below) apart from those, 10 per hour for both together (seeded from the
  audit file after a restart) → `limit`.
- **Audit** — one JSON line per launch, refused or not, in
  `<dataHome>/remote-sessions/audit.jsonl` (`{ at, origin, app, mode, auth,
  result }`, rotated at 1 MB).
- **Bookkeeping** — a tab leaves `remoteTabs` on `cli:exit`; its run leaves
  `remoteRuns` when no running session of the run is left.
- **Frames fit** `FRAME_CAP`; rs:* frames from a slave have their own rate
  window on the master (`RS_RATE_MAX`).
- A remote session gets no tool that launches remote sessions.

### Remote workers — the slave side

A master orchestrator's `launch_cli({ host })` becomes an ordinary worker
(standard worker prompt and tools) of a **mirror run** on the slave: core's
`ctx.orchestration.openMirrorRun({ key, orchestrator: { address, host },
deliver })`, key `<masterPeer>:<runId>` (`masterPeer` = the host of the
slave's `masterUrl`), one per master run, reused for its further members.

| Op / push | Shape |
|---|---|
| `member.launch` | `{ runId, address, orchestrator: { address, title? }, title?, task, app, model?, auth }` → `{ tabId, memberAddress }` |
| `member.submit` | `{ tabId, text, from }` → `mirror.submit(memberAddress, text, { from: from + '@master' })` → `{ submitted }` |
| `rs:msg` push | `{ tabId, kind: 'report', status: 'started'\|'done'\|'failed'\|'blocked', summary, dropped? }` · `{ tabId, kind: 'message', text, dropped? }` |

- **Guards** — every `launch` guard (opt-in, TLS, app containment, explicit
  billing, `invisibleChars` on task and titles); task ≤ 32 KB; run ids and
  addresses `/^[A-Za-z0-9._:-]{1,100}$/`. Live members have their own cap of
  5 (each counts once, whatever its run; the orchestrator's worker limit),
  separate from the 3 standalone launches; the hourly cap is shared. Audit
  line `{ origin: { kind: 'orchestrator', runId, address }, mode: 'member',
  … }`. Core without `openMirrorRun` → `unavailable` ("needs a core
  update").
- **A member is a remote session** — stamped `remoteLaunch { origin, at,
  member: key }`, so every op above works on it and it gets no remote-launch
  tool. `kill` goes through `mirror.kill`; when no member of a mirror run is
  live (kill or `cli:exit`), the run is `close()`d.
- **`member.submit`** only on a member tab (else `not-remote`), text ≤ 32 KB
  with control characters but `\n`/`\t` stripped.
- **`rs:msg`** comes from `deliver()`: summary / text capped at 32 KB, other
  statuses or unknown addresses dropped. At most 30 per minute per member; the
  rest, and everything while the channel is down or the opt-in off, waits in a
  per-member backlog of 50 (oldest dropped, counted in the next frame's
  `dropped`), sent when the window opens and on `attach`. A closed run's
  record stays until its backlog is sent.
- **Restart** — mirror runs (members, backlogs) persist in
  `<dataHome>/remote-sessions/mirrors.json`; `init` re-opens each by key.
  `shutdown` never closes a run.

`claude` in the snapshot: `{ loggedIn, authMethod, subscriptionType, email,
orgName, apiKey: bool, pref, remoteSessions }` — core's auth-status fields
cached from its `claude-auth:status` broadcast (null until the first one;
`loggedIn`/`authMethod` fall back to the subscription flag), never a key or
token (`claudeStatus()`; `fleetState().peers[].claude` on the master).

Not built: a hard boundary around the opt-in and the audit — a remote
session runs as the slave's OS user with permissions off, so it can still
reach `<dataHome>` (the opt-in is the owner's consent, not a sandbox);
relaying a Claude sign-in; CLI/PTY terminals; image upload into a
remote session; `setAuth`/`setModel` on the run record itself (a run's later
workers keep the run's billing and the members' model picks stay off
`run.json` — core's `setRunAuth` / `memberModelChanged` are not on the ctx); a remote
worker's backlog beyond 50 frames, and its events beyond `rs:event` for
subscribed tabs (the master's run board learns of members only through
`rs:msg` / `rs:state`).
