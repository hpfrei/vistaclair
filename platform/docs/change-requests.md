# Cross-app change requests (`src/apps/app-change-requests.js`)

The sessions that send and receive these requests are in `sessions.md`.

An app session that needs something from ANOTHER app asks for it instead of
reaching into it. The only things it may ask for are a tool exposed to apps
(`expose: 'apps'`) or a bus kind in the target's `manifest.events.emits` —
never a shared DB, file or route.

**Add or extend is the platform's call, not the session's.** The session names
an interface and lists what it is missing (`--adds a,b`); `request()` looks at
what the target exposes today (live tool union first, its manifest `tools`
second, so a stopped app is still comparable) and records `mode: 'add' |
'extend'` plus a `before` snapshot of the parameters. An extension is held to
backwards compatibility, and the target's prompt spells out what that means:
new parameters optional with defaults that reproduce today's behaviour, nothing
renamed, removed or newly required, the result a superset.

`scripts/app-change.js` is the session's whole interface: `request` (blocks
until the outcome, run with `run_in_background: true`), plus `done`, `status`,
`wait`, `cancel`, and `depend --on <app> --tools a,b --why "…"`, which declares
an approved dependency edge on tools that already exist (`app-tools.md`,
"Dependencies"; `POST /pro/apps/deps/depend`, same caller identification). Exit codes: 0 done, 2 denied, 3 ended or cancelled, 4
unusable, 5 done but unverified; the last stdout line is JSON with `state`,
`outcome`, `verified` and `verifyDetail`. It talks to five Pro routes under
`/pro/apps/change-requests` and identifies its caller by the tab env
(`VISTACLAIR_INSTANCE_ID`), so it only runs inside a dashboard session (a CLI
tab or an Agent SDK panel).

**Who may act.** The routes (`app-change-request-routes.js`) have two kinds of
caller after core's auth. The owner (cookie or owner token, no `req.vcSession`)
is unrestricted and names the instance in the body, as before. A session holding
its per-session token (`req.vcSession.instanceId`, set by core's gate; the
script sends it in the legacy `x-vistaclair-internal` header, which core accepts
when the value is a live session token) acts only as itself: the instance id is
the token's, and a different `instanceId` in the body is refused with 403
(`request`, `done`, `depend`, `cancel`). On an existing request the side decides
(`partyOf`: sender = the asking app, target = the asked app, or for a platform
request the one `pro-change-<id>` tab):

| Route | Sender | Target |
|---|---|---|
| `status`, `wait` | yes | yes |
| `cancel` | yes | no |
| `done` | no | yes |

Anyone else (another app's tab, a worker, a tab the platform does not know) gets
403; an unknown id still answers `state: unknown`.

Which app (or which platform request) a tab speaks for is read from three
signals in order (`callerOf`): the tab id (`app-<name>`, `pro-change-<id>`),
the settings stamp the launch left (`changeApp` from `launchChangeSession`,
`changeRequestId` from the platform launch), and, for an app, a cwd that is
exactly the app's directory. Tab ids are not durable: core restores a tab after
a restart under a fresh `tab-<boot>-N` id, and a saved session reopened from
the tab menu gets one too. Settings survive both, which is why identity rides
there. The same signals drive the target's busy check, where the outcome is
written, and the exit hooks; a restored target tab is re-armed on the next read
of the state. The refusals are distinct: no tab has that instance id, the tab
is not an app change tab, or it is an orchestration worker
(`settings.orchestration.role === 'worker'`). A worker inherits its
orchestrator's stamps, so it is refused outright and left out of every tab
lookup (busy check, tier 2, exit hooks); the orchestrator speaks for the app or
the platform, and both target prompt sections tell it to delegate and run
`done` itself once its workers have reported.

The server owns the state: `pending` → `denied` | `queued` | `opening` →
`launched` → `done` | `ended` | `cancelled`, persisted in
`change-requests.json` and recovered after a restart (`interrupted`). The owner
answers a modal on the asking app's card: **Deny** (with a reason, remembered
for that session so the app stops re-asking) or **Open**, which launches an
`extend` session on the target — an Agent SDK orchestrator (`sessions.md`) —
with the request as its auto-submitted first message and appended to its
prompt. `opening` lasts while the launch is async (the owner may be confirming
API-key billing); the target counts as busy meanwhile. A decline puts the
request back to `pending` (Open again or Deny) and releases a request queued
behind it; a failure ends it; a restart mid-`opening` returns it to `pending`.

Every outcome — including deny — reaches the asking session through the same
three-tier ladder (`deliver`, recorded as `deliveredVia`):

| Tier | When | `deliveredVia` |
|---|---|---|
| 1 | a long-poll whose connection is still open takes it (the `/wait` route drops a poll whose connection closed) | `waiter` |
| 1, held | no poll is parked but one ran < `REPOLL_GRACE_MS` (10 s) ago: the next poll takes it; else on to tier 2 when the grace ends. A hold that a restart interrupted resumes after boot | `pending`, then `waiter` / `pty` / `relaunch*` |
| 2 | the asking tab is live: the outcome is written into it | `pty` |
| 3 | else `launchChangeSession(from, { resumeSessionId: fromSessId })` reopens the asking session on its own transcript (a simple Agent SDK session) | `relaunch` |
| 3, fresh | no session id, no transcript (`transcriptExists`), or core refused the resume, also later (the launch is async): a fresh session, whose prompt says it is new, why, and where the request file is | `relaunch-fresh` |
| — | the owner declined API-key billing for the relaunch, or nothing could open | `none` |

A waiter that polled recently but is not parked is never counted as delivered
on its own.

A tool definition also carries `returns` (optional prose, ≤300 chars, "what the
result object contains"): `registerAppTools` keeps it, it reaches
`manifest.tools` and `getToolsForApp`, app-lint warns without it on a tool
exposed beyond `self` (`tool-returns`), and the snapshot records it so the
target's prompt states the current result contract and asks for a superset.

`done` re-reads the interface and compares it with the snapshot, reporting two
independent flags. `verified` is "the thing asked for arrived": for an
extension that means every `--adds` name is now a parameter, so a tool that
never changed cannot be reported as delivered. `compatible` is "it arrived
without breaking existing callers", false when a parameter disappeared or one
became required that was not. A changed `returns` is reported as news and never
as an incompatibility — no sentence can prove a result is still a superset. The
asking session hears both, and an
incompatible change is stated loudly rather than smoothed over. An event kind's
payload cannot be checked from a manifest, and the outcome says so instead of
claiming a check that did not happen.

A tool request that reaches `done` records an approved dependency edge
asker → target for that tool, with its current contract hash
(`app-deps.fromChangeRequest`; a tool not registered yet adopts its first
contract).

A `done` whose check failed keeps `state: 'done'` (the target did report) and
carries `outcome: 'unverified'` (`'verified'` otherwise; derived from
`verified`, so older records read the same). It is never shown as a plain
success: the outcome text starts `is UNVERIFIED` and names what is missing
(`verifyDetail`), the script exits 5, both app rows carry an `unverified` chip
for a day and the toast is a warning. `status` re-runs the check for an
unverified APP request — the usual cause is a target that was not restarted —
and flips it to verified when the interface is there now; a platform request is
not re-checked.

**Platform targets** (`--to platform`). The same workflow when what is missing
is the PLATFORM: the session names one bridge method (`--method email.list`) or
one ctx member (`--ctx email.list`), resolved to the capability that owns it
(`--capability <key>` settles an ambiguous one); `before` snapshots that
capability's methods, ctx members and its `_api-reference.md` section. Open
launches ONE session in this repository — an Agent SDK orchestrator whose
workers get git worktrees, tab `pro-change-<id>`, cwd the pro repo, the request
as its first message, `platformTargetPromptSection` as its system prompt: the request is quoted as a requirement about that one
capability, core is off limits, the gates are `check:capabilities` + `npm test`
+ `test:fixtures`. One pro session at a time — a request queues behind `tg-pro`
or another `pro-change-*` tab — and a `pro-change-*` caller may ask for nothing
(platform targets are leaves). `done` re-reads the module from disk in a child
process (the running registry only changes at restart) and the section from the
file: `verified` is "the method/ctx member is there and every `--adds` token is
now documented as code". For a new interface the section must also name it
(the method, or `ctx.<member>`), and that new name is itself the change, so
`--adds` tokens a mirrored Bridge method already documented do not read as
"unchanged". `compatible` is "no method, prefix or ctx member
disappeared". It is a documentation-and-surface check, not a runtime one, and
the outcome says so — with the restart note: the change takes effect at the next
control-room restart, which only the owner performs. `PLATFORM_GAPS.md` stays
the path for a denial or a need outside the current task.

Chains are bounded by the `changeRequestMaxDepth` platform setting (default 1,
clamped 1..3): B may only ask C when the setting allows another hop, and an app
already in the chain is refused as a cycle. One outgoing request per session,
and a busy target queues rather than losing its running tab. Active and
recently settled requests show as a chip on the app's row in the Apps table.
