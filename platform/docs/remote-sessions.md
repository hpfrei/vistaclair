# Remote sessions (master view)

The master runs Agent SDK sessions on a linked slave and shows each in its own
dashboard as if it were local. Three entries, one gate:

| Entry | What starts | Gate |
|---|---|---|
| A run's `launch_cli({ host })` | a **remote worker**: a member of the master's run, working on the slave | one `peer.session.launch` card (mode `worker`) |
| Horst (propose markers) | a simple or orchestrator session | one `peer.session.launch` card |
| The owner's dashboard (Launch on <slave>) | a simple or orchestrator session | the owner's own click |

Master half: `src/apps/peer-remote-master.js` (tabs, frames, asks),
`src/apps/peer-remote-host.js` (core's host provider: remote workers),
`src/apps/peer-remote-agent.js` (the kind). The slave half and the command
plane are the peer channel's (`peer-channel.js` `remoteCommand` /
`onRemoteFrame`, `peer-remote-slave.js`, `docs/federation.md`).

## End to end

| Step | What happens on the master |
|---|---|
| launch | `launch(peer, spec, origin)` → `remoteCommand(peer, 'launch', …)` → the slave opens the session; the master adopts the tab and `subscribe`s from offset 0. A remote worker: `launchMember` → `member.launch` (below) |
| tab | `peer-<peer>:<slaveTabId>` within core's tab id rule (`[A-Za-z0-9][A-Za-z0-9._:-]*`, ≤ 100); a peer name (`[a-z0-9-]`) has no `:`, so no peer can name another's tab. An id that does not fit is `peer-<peer>::<prefix>.<hash of both>`. A master-chosen random `sessId`. With core's `ctx.registerExternalSession` it is a normal SDK tab (below); without it there is no tab, the session is listed and controlled through the module API and the dashboard messages |
| events | `rs:event` → validated → broadcast as `sdk:event { sessId: <master sessId>, ts, ev, off }` (only when registered with core). `runId` is dropped: a remote run is not a master run. Every string of an `sdk` event (here and in history pages) is HTML-escaped (`& < > " '`; `partial_json` keeps `"`) and a `javascript:` / `vbscript:` scheme broken, as core's panel renders text through `marked` into `innerHTML`; inside code and thinking the entities show literally |
| history | never stored on the master: `sdk:history` reaches `adapter.historyPage`, which fetches the page from the slave and rewrites it to the master `sessId` |
| TODO / NOTES | the only slave text kept: a `files` event fetches `todo` and writes `TODO.md` / `NOTES.md` (≤ 256 KB each) to `<dataHome>/peer-remote/<sessId>/`, the adapter's `sessionDir`, for core's `sdk:todo`; removed when the tab closes |
| exit | `rs:state exited` keeps the tab until closed, as a local SDK session's exit: a `cli:exit { tabId, exitCode }` broadcast, core lists it `exited` |
| close | the tab's × (core's `cli:closeTab` → the adapter's `close()`): kill if still running, `unsubscribe`, `unregister()`, mirror removed; the tab is never re-adopted (the last 200 closed per peer are remembered) |
| unlinked | a peer missing from `app:fleet:state` has its tabs closed as above, its launches and closed tabs forgotten; `shutdown()` unregisters every tab |
| reconnect | the channel's `connected` event → `list` → adopt unknown tabs, resubscribe each running tab from the last `off` seen (catch-up); a tab the slave no longer lists has exited. Adopted: only a tab this master launched or a member of a run it launched (`<dataHome>/peer-remote/launched.json` with a remote worker's `member`, ≤ 200 per peer, so a restart adopts them again), ≤ 50 tabs per peer. A `rs:state started` or an event for an unknown tab asks for a `list` at most once per 5 s (one inside the gap runs at its end). Mirror folders a previous run left are removed at start |

## Remote workers (`peer-remote-host.js`)

Core's `ctx.orchestration.registerHostProvider` (feature-detected,
`docs/seam.md`) gets `{ hosts, launch, kill }`; its `{ deliver, unregister }`
is kept (unregistered at Pro's shutdown). Absent → nothing registers, and the
Remote pane says runs need the core update.

| Step | What happens |
|---|---|
| `hosts()` | every linked slave: `{ name, label: '<name> (slave)', available, reason? }`. Unavailable, in order: "may join runs" off (below), channel down, no Claude status yet, remote sessions disabled on the slave, no credential (not signed in and no API key it allows) |
| `launch(call)` | checked: run id and member address the slave's rule (`[A-Za-z0-9._:-]`, ≤ 100), `app` `[a-z0-9-]`, `task` ≤ 32 KB, task and title free of invisible characters (`text-safety.invisibleChars`) → else `invalid`. Unknown or unavailable slave → `unavailable`; switch off or the dial at observe → `refused`. Then one card: `requestAction('peer.session.launch', { peer, mode: 'worker', app, prompt: task, auth, model?, title?, origin: { kind: 'orchestrator', ref: runId, member: address, title, address } }, { origin: 'peer-remote-host' })` — run, member and orchestrator from core's call, never from agent text (an orchestrator title's invisible characters are written out as ⟨U+XXXX⟩). A second launch of a member still waiting → `invalid` |
| waiting | the card's status, every 2 s and on its `horst:proposal` broadcast: denied, expired, withdrawn or gone → reject `declined` ("nothing was launched") |
| approved | the kind's executor → `approved(payload, proposal)`: the approved payload (an owner's edit included) launches, run and member from the waiting call; the switch is checked again (off → `refused`). `launchMember(peer, { app, task, auth, model, title }, { runId, address, orchestrator })` → `member.launch { runId, address, orchestrator: { address, title }, title, task, app, auth, model? }` → `{ tabId, memberAddress }`; the tab is adopted as any launch's, with `member { runId, address, orchestrator }`, origin `{ kind: 'orchestrator', ref: runId }` (its asks are listed with the run's on Telegram) → resolve `{ tabId }`. A slave refusal: `limit` (its live cap — each remote worker counts — or launches per hour), `disabled`, `no-credential`, `apikey-not-allowed`, `unavailable`, `offline`, `timeout`, `disconnected` → `unavailable` with the reason; anything else → `failed`; the slave's code as `.slaveCode` |
| outbound | core's SendMessage → the tab adapter's `submit(text, { from })` → `member.submit { tabId, text, from }`; without `from` (the owner typing into the tab) → `submit`. The adapter's `settings.orchestration` is `{ runId, role: 'worker', name: address, orchestrator }`, so core's run-wide auth / model switches reach it |
| inbound | `rs:msg { tabId, kind: 'report', status: started\|done\|failed\|blocked, summary, dropped? }` / `{ tabId, kind: 'message', text, dropped? }`: validated with every frame (summary / text `\r\n` → `\n`, invisible and control characters written as ⟨U+XXXX⟩, cut at 32 KB with ` …[cut]`); only for a member tab this master launched on that peer (another peer's, a non-member's or an unknown tab: dropped, counted `not-member`); ≤ 30 per minute per member (`rate`). → `deliver({ runId, address, kind, status, summary } \| { …, text })`, the text prefixed `[remote · <peer> · untrusted] ` and, after a slave backlog overflow, `(<n> earlier messages were dropped on the slave) ` |
| `kill({ runId, address })` | a launch still waiting: its card withdrawn, reject `cancelled`; a started member: its tab closed (`kill` op when running, `unsubscribe`, `unregister()`) |
| restart | a worker card left pending by a previous run of the master is withdrawn at init: nobody waits for it |

**Billing** — the slave's Claude subscription. Its API key only when the run
bills the API key (the launch call's `auth: 'apikey'`) and the slave has a
key and allows it, or when the owner edits the card's payload to `apikey`.
A slave with only an allowed API key takes only API-key runs. The owner
switches a started worker on its tab (`setAuth`).

**"Sessions on this slave may join runs"** — the master's own switch per
linked slave, on by default (a new pairing starts on); off kept in
`<dataHome>/peer-remote/join-runs.json` (`{ off: [peer] }`), forgotten when
the peer is unlinked. Off → `hosts()` unavailable with that reason, `launch`
refused, an approval of a pending card launches nothing.

## The core tab (`ctx.registerExternalSession`, feature-detected)

`registerExternalSession(tabId, adapter)` (core `src/external-session.js`) →
the tab's idempotent `unregister()`, kept on the record. Core awaits every
method and answers a throw or rejection to the requesting browser only (a
notice such as "Not sent: <slave's message>", or the reply's `error`). Core
shows the tab with a "Remote · <peer>" badge from `settings.externalHost`. The
adapter:

| Member | Remote op |
|---|---|
| `sessId`, `kind: 'sdk'`, `title` (`[<peer>] <title>`) | — |
| `settings` | `{ engine: 'sdk', auth, sessionDir, externalHost: <peer>, title }`, plus `orchestration` on a remote worker (above) |
| `running`, `busy`, `state` | getters, from the relayed status and `rs:state` |
| `submit(text, { from }?)` | `submit` (images refused); a remote worker with `from` → `member.submit` |
| `interrupt()`, `kill()`, `setModel(m)` | `interrupt`, `kill`, `setModel` |
| `setAuth(a, { continueTurn })` | `setAuth`; resolves `{ auth, applied: 'remote' }` once the slave switched |
| `historyPage({ limit, before })` | `history`; `limit` / `before` only as non-negative integers (a digit string is read as one), the slave's page `before` / `off` likewise, else null |
| `setShowThinking()` | throws: no remote op |
| `close()` | see close above |

No `orchestration()`: a remote orchestrator's run is not on the master's run
board. A remote worker is a member of the master's own run (core keys it by
the `tabId` its launch resolved).

## Dashboard messages (for the UI)

| Message | Direction | Shape |
|---|---|---|
| `app:peer:session:launch` | → server, owner only | `{ reqId?, peer, mode, app, prompt, auth, model?, title? }`; origin `{ kind: 'owner' }` |
| `app:peer:session:launchResult` | ← reply | `{ reqId, ok, tabId, remoteTabId, sessId, remoteSessId, runId }` or `{ reqId, ok: false, code, error }` |
| `app:peer:session:kill` | → server, owner only | `{ reqId?, tabId }` → `app:peer:session:killResult { reqId, ok, tabId \| code, error }` |
| `app:peer:session:list` | → server | replied with `app:peer:sessions:state` |
| `app:peer:sessions:state` | ← broadcast (coalesced), on connect | `{ peers: [{ peer, connected, claude, sameAccount, totals, alert, runs, sessions }], drops }` |
| `app:peer:remoteAlert` | ← broadcast | `{ peer, problem, text }` — from the slave's `rs:auth`, nothing else; kept as the peer's `alert` |
| `app:peer:remoteAlert:dismiss` | → server, owner only | `{ peer }` → `app:peer:remoteAlert:dismissResult { ok, peer, dismissed \| code, error }` |
| `app:peer:session:notice` | ← broadcast | `{ peer, tabId, level, text }` (a master-side failure, e.g. an answer that did not reach the slave) |
| `app:peer:session:joinRuns` | → server, owner only | `{ reqId?, peer, on }` → `app:peer:session:joinRunsResult { reqId, peer, ok, on \| code, error }` (`peer-remote-host.js`) |

- `sessions[]`: `{ tabId, peer, remoteTabId, sessId, runId, role, mode, app, title, origin, running, state, exitCode, credential, auth, costUsd, tab, member }` (`tab`: registered with core; `member`: `{ runId, address }` of a remote worker, else null).
- `runs`: `{ allowed, available, reason, provider }` — the "may join runs" switch, whether runs can use the slave now and why not, whether core took the host provider (`peer-remote-host.js`; absent while it is not loaded).
- `claude`: the slave's `{ loggedIn, authMethod, subscriptionType, email, orgName, apiKey, pref, remoteSessions: { enabled, allowApiKey } }`, or null.
- `totals`: `{ apiKeyUsd, subscriptionUsd, limitHits }` per peer, from the relayed status (the growth of a session's `costUsd` is billed to the credential that status names; `limitHits` counts `usage-limit` events). In memory: they restart with the master.
- `sameAccount`: the slave's `email` / `orgName` against the master's own (`ctx.claudeAuthInfo()`, else on an older core the cached status `peer-remote-slave.claudeStatus()`; a slave fills its own the same way): true / false, null when either side does not name its account.
- `alert`: the peer's last `rs:auth` as `{ problem, text, at }`, or null. Kept in `<dataHome>/peer-remote/alerts.json`, so a reload and a restart still show it, until the owner dismisses it, the peer is unlinked, or the slave's snapshot shows a fresh sign-in (`claude.loggedIn` false after the alert, then true; a slave that keeps reporting `loggedIn: true` keeps the alert). `problem` `[a-z0-9_-]{1,40}`, `text` plain, ≤ 500 chars.
- `drops`: `{ total, byReason }` — slave frames dropped by validation.
- Every string in these messages that came from a slave is text: render it with `textContent`, never as HTML.

The routing: index.js registers the prefixes `app:peer:session` and
`app:peer:remoteAlert` on the broadcaster (the longest prefix wins), so these
never reach `handleMessage`; `app:peer:session:joinRuns` goes to
`peer-remote-host.js`, the rest to `peer-remote-master.js`.

## Relayed questions

A slave session's AskUserQuestion (`rs:ask`) is shown on the master:

| Field | Value |
|---|---|
| `pendingQuestions` key, `askId`, `toolUseId` | `peer-<peer>:<askId>` (the tab id rule above); suffixed `-r<n>` when any pending entry already holds it — a relayed ask never overwrites nor resolves a local one or another peer's |
| `title` | `[<peer>] <title>` |
| `host` | `<peer>` (on the `ask:question` message and the entry) |
| `remote` | `{ peer, tabId: <master tab id>, sessionTitle }` |
| `tabId` | the master tab id when registered with core; no `cwd` |

- Only an ask on a tab adopted from that peer is relayed; any other is dropped. At most 5 open per tab and 20 per peer: past that the oldest is cancelled to its slave and dismissed (`ask:answered`).
- The entry's `resolve` (core's `ask:answer`) sends `answer { askId: <slave askId>, answer }` to the originating peer only; `reject` sends a cancel. `answer(askId, answer)` in the module API does the same.
- `rs:askDone` from that peer removes its entries and broadcasts `ask:answered`; an exit or a close drops the tab's asks.
- Forms are relayed whole — every question type, options, previews, images — with what core's renderer would otherwise trust neutralised: markdown text (question, descriptions, previews) has HTML, links, images and code escaped and autolinks broken (`&#58;//`, `www&#46;`); `showIf` is rebuilt as `{ questionId, equals | notEquals | includes | in }` with a boolean, a number or plain text ≤ 100 without quotes, `<>&`, `\` or `` ` `` (it sits in a single-quoted attribute), else dropped; `number` bounds and defaults must be finite numbers; images only as `data:image/(png|jpeg|gif|webp);base64` (≤ 120 KB; a path would load from the master's disk); question ids `[A-Za-z0-9_.-]`. A `file` question becomes a textarea saying uploads are not relayed.
- Core's ask modal and the tab's form label a relayed ask from `host` / `remote` ("Remote · <host> · <session>" and a distinct border, core `public/remote-ask.js`, as text; only `data:image` loads); the `[<peer>]` title prefix stays.
- Telegram: a remote session an orchestrator asked for (`origin { kind: 'orchestrator', ref: <runId> }`; the remote run's members adopted by `list` inherit it) has its asks listed with that run's questions — the Mini App card with the same label and border, its text capped and set as text, only `data:image` images — and answered as a local ask (`platform-tg-runs.js`, `docs/horst-surfaces.md`). Every other remote ask (an owner's or Horst's session, or a run no longer listed) is in the Mini App's "Remote sessions" list — by peer → session, with the session's state and cost, the same look — answered over `POST remote/answer`; never in both. Every Telegram answer names the ask's tab, as core requires of the dashboard's `ask:answer`.

## Dashboard

The master's Setup → Remote pane, per linked slave (`public/publish.js`; the
HTML builders are `public/remote-sessions-view.js`, tested in
`test/remote-sessions-view.test.js`). A slave's pane keeps only its opt-in
toggles — no launch form.

| Part | Source |
|---|---|
| "Remote sessions" box under the slave's row | `app:peer:sessions:state` (requested with `app:peer:session:list` on load); re-rendered alone, not the pane |
| Launch on <slave> | a dialog: mode, app (the slave's deployed apps from `app:fleet:state`), prompt, model (optional, the master's picker list), billing → `app:peer:session:launch`; a refusal shows `errorText(code)` |
| Billing options | from `claude`: Subscription off "not signed in"; API key off "no API key on <slave>" / "API key not allowed by <slave>"; API key notes "billed per token". The whole form is off when the channel is down, `claude` is null, or `remoteSessions.enabled` is false ("enable remote sessions on <slave>'s own dashboard") |
| Session rows | title, app, role, state, credential badge, cost; "Open tab" when `tab` is true (core's `cliModule.switchTab`), else "Tab view needs the core update"; Kill → in-app confirm → `app:peer:session:kill` |
| "Sessions on this slave may join runs" | a checkbox from `runs.allowed` → `app:peer:session:joinRuns`; when on but unavailable, "runs cannot use <slave> now: <reason>"; a refusal shows on the row (`joinRunsHtml`) |
| Totals | `totals` as one line; `sameAccount === true` → "Same Claude account as this master — shares one usage limit" (false / null: nothing) |
| Alert | the peer's `alert` in `app:peer:sessions:state` (a live `app:peer:remoteAlert` shows at once) → "Claude sign-in expired on <slave> — sign in on its dashboard, or sync the API key" + the slave's text and its time, with Sync keys / Dismiss (`app:peer:remoteAlert:dismiss`; a refusal shows on the row); no relayed login |
| Notices | the last `app:peer:session:notice` and kill refusal per slave |

Every slave string goes through `capText` (control characters flattened,
length-capped) and `esc`; nothing is parsed as HTML or markdown. App names
outside `[a-z0-9-]` are left out of the app list, model ids outside the
master's `MODEL_RE` out of the model list.

## Module API

| Function | Returns |
|---|---|
| `launch(peerName, spec, origin)` | `Promise<{ tabId, remoteTabId, sessId, remoteSessId, runId }>`; `spec` `{ mode, app, prompt, auth, model?, title? }`, `origin` `{ kind: 'owner' \| 'horst' \| 'orchestrator', ref? }`. Rejects with `.code`: the slave's (`disabled`, `not-https`, `bad-app`, `no-credential`, `apikey-not-allowed`, `limit`, `unknown-tab`, `not-remote`, `bad-args`), the channel's (`offline`, `timeout`, `disconnected`), or `unknown-peer`, `bad-args`, `unavailable`, `not-master` |
| `onState(fn)` | unsubscribe; `fn({ type: 'started' \| 'exited', tabId, peer, costUsd, exitCode, …, resultText })` — `resultText` (exited) is the slave's last result, untrusted, never for the bus or Horst |
| `status(tabId)` | the `sessions[]` row, or null |
| `answer(askId, answer)` | `Promise<boolean>` — a relayed question by its master id |
| `kill(tabId)` | `Promise<true>` |
| `sessionsState()` | the `app:peer:sessions:state` payload |
| `launchMember(peer, { app, task, auth, model?, title? }, { runId, address, orchestrator: { address, title } })` | `Promise<{ tabId, remoteTabId, sessId, remoteSessId, memberAddress }>` — a remote worker; only `peer-remote-host.js` calls it, after the owner approved its card. Rejects like `launch` |
| `memberTab(runId, address)` | the master tab id of that remote worker, or null |
| `onMemberMessage(fn)` | unsubscribe; `fn({ peer, tabId, runId, address, kind, status?, summary?, text?, dropped })` — a validated `rs:msg`, untrusted |
| `close(tabId)` | closes the tab as its × does |
| `setPeerExtras(fn)` | `fn(fleet peer)` → that peer's `runs` entry (`peer-remote-host.js`) |

## The card (`src/apps/peer-remote-agent.js`)

Every launch an agent asks for is one `peer.session.launch` proposal
(`capabilities/fleet.js`): ceiling and default `propose`, `identity: null`
(no dedupe), so a dial can never raise it, nothing is batched or pre-approved.

| Part | What it is |
|---|---|
| Payload | `{ peer, mode: simple\|orchestrator\|worker, app, prompt, auth: subscription\|apikey, model?, title?, origin? }`; unknown keys refused; `peer` a linked peer; `app` `[a-z0-9-]` (the slave's rule); `prompt` ≤ 32 KB (the master's `PROMPT_CAP`); `prompt`, `title` and the `origin` texts free of characters a reader cannot see (`text-safety.invisibleChars`: Cf, tags, controls but `\n` `\t`, U+E0100–E01EF, 2+ consecutive U+FE00–FE0F; one emoji selector stays); `origin` `{ kind: horst\|orchestrator, ref?, title?, address?, member? }`; `worker` needs `origin.ref` and `origin.member`. Platform-owned (no `appProposable`): an app can neither propose nor edit it |
| Card | `card()`: Slave, App, Mode (`worker of a run on this master` for a worker), Billing ("API key — billed per token", accent `warn`), Model, Title, Requested by, and the Prompt (a worker's: Task) as a `code` field with `verbatim: true` (horst-cards keeps it whole, ≤ 64 KB, any invisible character written as ⟨U+XXXX⟩; the Horst tab escapes it line by line in a scrolling box). A prompt over Telegram's 1200 characters adds a warning to approve it where it is shown in full. A worker's footer says its orchestrator talks to it afterwards without another card |
| Where it is approved | `approveFrom(proposal, via)` accepts only a surface that rendered the whole prompt (table below); a refused approve leaves the card pending, and Deny works everywhere. Every approve carries the payload version its surface rendered; a stale one is refused (`docs/governance.md`, "Payload version"). A truncated prompt's Telegram card has ✖ Deny and `⤢ Open to read it all`, no Approve; the Horst tab's previews open the full card instead of approving (`docs/horst-surfaces.md`) |
| Who asked | from the proposal's `origin`, never the payload alone: `peer-remote-host` (filed by the provider) and no `app` → `Orchestrator "<title>" · run <runId> · member <address>`; anything else → `Horst (<origin>)` |
| Execute | `worker` → `peer-remote-host.approved` (refused unless that module filed the card); otherwise `peer-remote-master.launch(peer, spec, { kind: 'horst', ref: <proposal id> })`. Summary: peer, app, master tab id — no slave text |
| Horst | stages the kind through his propose markers like the other fleet kinds (fleet has no members, so it is no lane entry; `docs/horst-lanes.md`) |

Every surface that can approve a proposal, and whether it rendered the full prompt:

| Surface | `via` | Full prompt |
|---|---|---|
| Horst tab, the modal's full card (`renderPayload`) | `ui-full` | yes |
| Mini App, the proposal detail (`renderDescriptorCard`; also its MainButton) | `miniapp` | yes |
| Telegram card | `telegram` | only ≤ 1200 characters |
| Horst tab, Timeline row and Approvals queue card (previews) | `ui` | no |
| An app (`ctx.governance.decide`) or any other caller of `decide` | `app:<name>`, … | no |
| Batch (`/proposals/batch`), Horst's chat (`proposals_list`, propose markers) | — | cannot approve |

## Invariants

0. **https only.** The peer token, and so every remote-session command, travels
   only to an `https://` slave (loopback excepted). A slave linked over
   `http://` is flagged `needsRepair` and must re-pair over https
   (`docs/federation.md`). `peer.session.launch` is approved only from a
   surface that showed the whole prompt, never as `app:<name>`.

1. **Slave frames are untrusted.** `validateFrame`: an allowlist of frame
   types (`rs:event`, `rs:ask`, `rs:askDone`, `rs:state`, `rs:auth`, `rs:msg`) and of
   fields per type, a 128 KB frame cap, depth / node / string caps,
   prototype keys dropped, `platform` kinds allowlisted (`status`, `notice`,
   `files`, `usage-limit`, `message`), user-turn image srcs kept only as
   inline rasters; a frame from a peer that is not linked is dropped; a
   slave's error message is one control-free line before it is logged or
   returned. Everything dropped is counted. No slave string becomes a master path
   (mirror folders are named by the master `sessId`) or HTML built here.
2. **Nothing reaches Horst or the bus.** `peer-remote-master.js` requires no
   Horst, bus or governance code and publishes nothing; `onState` carries the
   summary to its caller. A remote worker's report and messages go to core's
   run only, marked untrusted.
3. **Relayed questions** are namespaced and routed to their slave only (above).
4. **Launch** (and kill, alert dismiss, the join-runs switch) only from a connection core's
   `ctx.isOwnerConnection(ws)` accepts (an older core without it: any dashboard
   WebSocket, each authenticated as the owner at upgrade) or the module API, which an agent reaches
   only through the owner's approval of a `peer.session.launch` card (above).
   No Bridge method, app capability, app tool, agent tool or Telegram command.
   A remote worker takes further text only from its run (core's SendMessage)
   and the owner's tab.
5. **No new HTTP route or listener** on the master, but the Mini App's
   `remote/answer` (behind tg-session's initData bearer, `docs/horst-surfaces.md`).

## Not built

- File uploads and images sent with a turn to a remote session.
- `setShowThinking` on a remote tab.
- A remote orchestrator's run on the master's run board (its members are separate tabs).
- Persisted billing totals; a remote session without the peer channel.
- Follow-up prompts from an agent to a remote simple or orchestrator session
  (only the owner types into those tabs); a remote worker takes its run's
  SendMessage, approved once with its card.
- Horst being told when a session he asked for exits.
- A billing choice on the worker card other than editing its payload.
- A gate against a local agent that leaves its tools. A prompt-injected local
  orchestrator runs unsandboxed as the owner's OS user: it can read core's
  auth token and `POST /pro/horst/proposals/:id/decide { view: 'full' }`, or
  call `peer-remote-master.launch` in-process, approving its own card. The
  card gate holds only against agents that stay inside their tools.
