# Horst surfaces

- **Horst tab** (`public/horst/`): rail Map · Chat · Timeline · Approvals ·
  Directives · Settings; Triggers is reached from the Map's bus node. Timeline
  is one causal chain with filter chips, chained by `correlationId` then
  `<account>:<uid>`. The Map (`horst-map.js`) is a live SVG of the pipeline
  driven by the dashboard WebSocket (`horst-live.js`), with replay over the
  audit ring, dashed never-used paths and ✦n markers on every model call.
  Triggers shows each kind as a sentence with its policy, "listened by" apps,
  and hides `run-action` where no handler is bound. Questions and errors use
  in-page dialogs (`showAlert` / `showConfirm` / `showPrompt` in `horst.js`),
  never the browser's native ones.
  **Approve** posts `/proposals/:id/decide` from three places: the Timeline
  row and the Approvals queue card (previews, via `ui`) and the full card in
  the modal (`#propOverlay`, body `view: 'full'`, via `ui-full`). A proposal
  marked `fullViewApprove` (its kind's `approveFrom` refuses `ui`; set by
  `withCards` / `withCard` while pending) has no Approve on a preview: the row
  offers `⤢ Open the full card to approve` and the queue card `⤢ Open to
  approve`, both opening the modal; Deny stays. Every Approve sends the
  `version` its render showed (`data-version`; after a modal edit, the one
  `/payload` returned); a stale one is refused and the card re-renders.
- **Telegram** (`platform-telegram.js`, key `__platform__`): Horst's chat IS
  the control bot — session launch/bind/relay, apps and bots, restart with
  confirm, directive and clarification buttons, gate confirmations, batched
  digests, voice notes. There is NO button that hands out the dashboard auth
  token: the owner logs in with the QR login below.
  **Owner, claim code, privilege, QR login, sessions, Mini App bearers**:
  `docs/telegram-control.md`.
  **Approval cards** (`platform-horst.proposalButtons`): with a Mini App URL
  a card carries `⤢ Open Approvals` (the decision is made there); without
  one, ✅ Approve / ✖ Deny in chat; `app.tool.job` keeps ▶ Start / ✖ Cancel
  either way. A kind whose `approveFrom(p, 'telegram')` refuses (a
  `peer.session.launch` prompt longer than the 1200 characters the card
  shows, `horst-cards.TEXT_BODY_LIMIT`) gets ✖ Deny and `⤢ Open to read it
  all` (the Mini App, when there is one) — never Approve; `governance.decide`
  refuses a Telegram approve of it anyway. An Approve / Start carries the
  payload version, `horst_prop:<id>:approve:<version>`; `notifyUpdate`
  re-renders text and keyboard together, so a tap on a card that still shows
  an older payload is refused.
  **Files**: Telegram never receives a delivered file. A delivery (a chat
  turn's tool files, `chatFromTelegram().deliveries` → `sendTurnReply`; a
  job's outcome) is ONE message, `horst-deliveries.toTelegram`: the text (the
  reply without its `Files:` block, or the brief outcome) with its buttons plus
  `📁 Open in Vista` (`(n files)`), a `web_app` button on
  `<public>/pro/vista/?file=<dl_id>`, the first file. With a picture the
  message is a preview photo carrying the text as caption: the picture itself
  up to 1 MB, else a 1024 px jpeg (`sharp`, when installed), else the picture
  up to 10 MB, else link only. A text above the 1024-character caption goes
  first with its own buttons, the photo follows with `🖼 name` and the Vista
  button; a refused photo falls back to text. No public URL: no button, the
  text points at the Horst tab › Files.
  **What the chat does NOT carry**: the briefing (journalled and broadcast
  only — apps read it through `ctx.horst.briefing()`), and anything the owner
  has just done themselves — a decision taken `via` `telegram` / `miniapp` /
  `ui` sends no decision line (the surface already showed the outcome; the
  cards are still retired), and a reply-watch closed by the owner's OWN reply
  (`selfReply`) is published to the bus but not pushed. Kinds carrying
  `notify: 'none'` (`calendar.create/update`, `todo.create`,
  `email.rule.add`) never push a card at all; they are reviewed in the
  Approvals views.
  **Event reminders** (`agent/horst-reminders.js`, cron `horst:event-reminders`
  every minute, settings `eventReminders` / `eventLeadMinutes` = config
  `horst.notify`, default on / 15): one message per timed event entering the
  lead window, kept true by editing it in place — the absolute range always,
  then `starts in N min` → `starting now` → `started HH:MM · ends HH:MM` →
  `ended HH:MM`, then untracked. A move shows `⚠ moved to HH:MM`; beyond the
  window the message is closed and a fresh one follows; a deletion shows
  `❌ cancelled`. `calendar:changed` refreshes the named events at once. Edits
  only when the text changed ("not modified" is success); state in
  `.horst/event-reminders.json` (atomic), so a restart never re-sends. Local
  time zone; not gated by `paused` (the owner's own calendar); turning them
  off stops new ones, sent ones stay true.
  **Long-running tools**: one progress message per job (`⏳ <app> › <tool> —
  pct label`, the latest note), edited in place at most every 5 s with a
  trailing edit, closed with the outcome line; a job's question is a
  force-reply message, and a reply to it is the answer (`answerJobQuestion`,
  checked before the session relay and the chat). State in
  `.horst/tool-jobs-tg.json` (atomic), so a restart keeps editing the same
  message.
- **Mini App** (`platform-miniapp.js`, `/pro/vista`): five tabs inside a
  Telegram webview — Approvals (the decision surface), read-only Briefing,
  Mail and Calendar, and Files. The briefing is read HERE, never pushed to the
  chat; `test/vista-readonly.test.js` asserts all three read-only tabs stay
  GET-only, so the Mini App never becomes a second decision funnel. Approve
  (button or MainButton) sends the open detail's `data-version`; a refused
  approve re-polls, so the current card is what is shown next.
  **Files** (`test/vista-files.test.js`) — the deliveries ledger
  (`docs/tool-jobs-artifacts.md`): `GET api/files?kind=&batch=` → `{ files,
  counts }` newest first, `GET api/files/:id` → `{ file, batch }`,
  `POST api/files/:id/remove`, and `GET api/artifacts/:artifactId` — the
  bytes (`sendBytes`, Range), only for an artifact a live delivery holds.
  Media elements and `Telegram.WebApp.downloadFile` cannot send the bearer
  header, so each listed file's `src` carries a ticket `?k=<exp>.<hmac>`
  (per-process key, 6 h, expiry rounded to the hour) that opens that
  artifact only; the bearer works too. Filter chips by kind; pictures open
  full size, audio and video play inline, a 3D model shows its delivery's
  pictures, every file downloads under its name, remove asks first (Telegram's
  `showConfirm`, or an in-page sheet where that is missing). The page
  opens on `?file=<dl_id>` (the delivery link) or `?files=<kind>`.
  `tg-miniapp-auth.js` is the one initData
  verifier, mounted twice with separate token maps: `/pro/vista` here and
  `/pro/tg-session` for the CLI-session Mini App (`platform-tg-session.js`),
  because `/pro/horst/*` is owner-cookie-authed and unreachable from a webview.
- **Runs on Telegram** (`platform-tg-runs.js`, transcript
  `tg-run-transcript.js`; tests `test/tg-runs.test.js`): the control chat
  follows any number of orchestration runs. On only with
  `ctx.orchestration` (`docs/seam.md`); absent, nothing below exists and
  the legacy tg-session launch works as before. Shared: the dashboard stays
  live, no lock.
  **Binding** = a runId (`runs[runId] = { chatId, name: 'orch-<runId>', … }`
  in `.tg-sessions.enc`, next to the legacy `sessions`, written atomically).
  The orchestrator's tab is resolved from the run on every use
  (`describeRun().orchestratorTabId`, else the stamp among open sessions).
  Bound from the bot's `💻 Sessions` list (live + paused runs; a paused one
  offers Resume, which binds), the Mini App, or the dashboard handoff.
  A **mirror run** (a slave's run whose orchestrator is on the master; core's
  `listRuns` / `describeRun` carry `mirror`) is left out of every list and
  refused for bind, Pause, Resume and Refresh, as core refuses them: it is run
  from the master.
  **Messages to a run go only through the Mini App**: plain chat text never
  reaches a run (it stays Horst's, or a legacy binding's). Turns use the
  session's `submit()` / `interrupt()`; refused while the run is pausing or
  paused.
  **Card**: one message per bound run, edited in place (≤ every 5 s, trailing
  edit, "not modified" is success; a lost message is sent again): title,
  state + time in it, a line per worker (⏳ running · 💤 idle · ⏸ paused · ✅
  landed / done · ❌ not landed / failed · ⛔ blocked · ⏹ exited), the last
  event; buttons ▶ Open (`web_app` `/pro/tg-session/?run=<runId>`), ⏸ Pause
  run / ▶ Resume, ⏏ Disconnect (`vr:<b|p|r|x>:<runId>`).
  **Pushes** (a new message) only for: a question; the run truly idle
  (orchestrator idle, no pending event, no worker in a turn — held 10 s;
  `interaction:complete` is not used, the orchestration hook blocks Stop);
  a worker event `not landed`, or a `failed` / `blocked` report; the run
  paused, ended, or its orchestrator exited (held 10 s — a refresh exits
  one before the next is up). Worker events are `describeRun().events`
  diffed by `seq` when core includes them, else each worker's `lastReport`
  diffed by `at` (then `not landed` is never pushed and the card shows done
  / failed / blocked). Signals: `orchestration:run`, `ask:question` / `ask:answered` / `ask:timeout`,
  `cli:paused`, `cli:exit`, `sdk:event` status, a 60 s sweep. The last seq,
  phase and idle flag persist, so a restart re-pushes nothing.
  **Questions** of any session of the run: exactly one `select` (≤ 8
  options), `confirm` or `toggle` gets answer buttons (`vq:<askId>:<i>`,
  ≤ 64 bytes, else not inline); anything else says "answer in the Mini
  App". The pending entry decides — first answer wins; answered elsewhere,
  the message says so and loses its buttons. A slave's relayed ask
  (`docs/remote-sessions.md`, an entry with `host` / `remote`) belongs to
  the run named by its remote session's origin (`kind: 'orchestrator'`,
  `ref` = runId; `peer-remote-master.status(tabId)`); any other origin (owner,
  Horst) or a run not in `listRuns()` puts it in the Mini App's remote list
  instead, never both. Its chat message starts `Remote · <host> · <session>`
  (plain text). As core's `ask:answer`, every answer to a relayed ask must
  name its tab (`remoteTabOf`: the entry's `tabId`, `ctx.tabId`, message
  `tabId`, `remote.tabId`), else it is refused (`tabRefusal`); a chat button
  names the tab its message was posted for.
  **Mini App API** (`/pro/tg-session/api`, the initData bearer; the legacy
  `state` / `send` / `answer` / `esc` / `end` stay; every run route is 404
  without `ctx.orchestration`, `GET run/:runId` is 404 for an unknown run):

  | Route | Shape |
  |---|---|
  | `GET runs` | `{ runs: [{ runId, name, title, engine, state, busy, paused, pausing, bound, workerCount, pendingQuestions, updatedAt }], remote: [{ host, sessions: [{ tabId, session, state, costUsd, asks: [{ askId, formData, questions, remote }] }] }] }` (`remote`: the relayed asks no listed run holds, by peer → session; `state` / `costUsd` from `peer-remote-master.status`, null when absent or malformed) |
  | `GET run/:runId?since=<cursor>` | `{ runId, name, title, engine, state, busy, paused, pausing, bound, workers: [{ workerId, name, title, state, lastReport, progress }], events: [{ seq, at, worker, kind, text }], pendingQuestions: [{ askId, formData, questions, from?, remote? }], transcript, cursor, reset }` (`events`: core's, else the derived reports; `remote` = `{ host, session, tabId }` for a relayed ask, plain, control and bidi chars stripped, ≤ 100 / 120 / 200) |
  | `POST run/:runId/bind` · `unbind` · `esc` · `pause` · `resume {fresh?}` · `refresh` | `{ ok, … }` / core's result; an error is `400 { error }` |
  | `POST run/:runId/send {text}` | binds if unbound; `{ ok: true }` |
  | `POST run/:runId/answer {askId, answer, tabId?}` | `answer` = `[{ id, question, answer }]`; `tabId` = `remote.tabId`, required for a relayed ask (400 without or wrong); 404 when not pending for the run |
  | `POST remote/answer {askId, answer, tabId}` | an ask of the `remote` list only (a run's or a local one is 404); `tabId` as above; the entry's `resolve` forwards it to its own peer |

  `state` in `run/:runId` is one of `busy awaiting idle pausing paused
  exited ended`; in `runs` it is core's. `transcript` entries `{ id, role:
  'user'|'assistant'|'tools', text, ts, toolCount?, from?, open? }`: an SDK
  run reads the run folder's `transcript.jsonl` by byte offset, a CLI run
  the interaction store (cached per sessId); subagent, hook and MCP rows,
  tool results and notices are dropped; a `tools` entry sums the tool calls
  between two texts. `cursor` `<tag>.<n>`; `reset: true` → replace (last
  200), else append — an `open: true` tools entry comes again with the same
  id, grown.
  **Mini App UI** (`public/tg-session/`, `test/tg-session-assets.test.js`):
  boots on `GET runs`; a 404 there → the legacy single bound session. Picker:
  bound runs first, then runs with a waiting question, then by `updatedAt`;
  `?run=<runId>` opens one directly, the title switches runs. Above the
  runs, **Remote sessions** (`#remote-list`, from `remote`): a head per peer,
  a card per session (its title, `state · $cost`), its first question with
  the remote look below; rebuilt only when the set of questions changes (a
  half-filled answer survives the polls), the state lines updated in place;
  all of it as text. Every remote answer sends `tabId`. Run view:
  workers strip (state, last report, progress bar), transcript bubbles in
  markdown (`/pro/marked.min.js` + `/pro/purify.min.js`, exempt exact paths;
  else an escape-first renderer), tool rows collapsed, run events inline, the
  first pending question pinned above the input (all ask data as text; a
  `remote` ask gets a `.q-remote` border, a `Remote · <host> · <session>`
  line and its `mdText` escapes undone; images only as
  `data:image/(png|jpeg|gif|webp);base64`). Polls `run/:runId?since=`
  (none at first), upserting transcript entries by `id` and events by `seq`;
  opening an unbound live run binds it. The only client state is the open
  run, its cursor and the unsent draft (localStorage).
  **Handoff** (owner, for the dashboard): `POST /pro/tg-handoff/bind
  {runId}`, `POST /pro/tg-handoff/unbind {runId}`, `GET
  /pro/tg-handoff/bindings` → `{ runs: [runId…] }`. Behind core's auth and
  `isOwnerRequest`; the chat is the claimed control chat (400 when Telegram
  isn't configured). Every bind/unbind broadcasts `tg:binding { runId, name,
  bound }`.
  **Dashboard entry** (`public/tg-handoff.js`, a Pro client module): an
  orchestrator tab gets a "📱 Follow on Telegram" toggle (one tab action whose
  `active` reads the bound set: pressed as "📱 Following on Telegram" in the
  SDK toolbar; a click binds or unbinds), and a 📱
  chip (`setTabBadge`, click → confirm → unbind) sits on every followed run's
  tab. The set is seeded from `bindings` and follows `tg:binding` (binds made in
  Telegram too); re-seeded on `visibilitychange`. Inert without core's tab hooks
  or when `bindings` is 404.
- **Files view** (Horst tab rail): the same ledger over `GET
  /pro/horst/api/files?kind=&artifact=` and `POST
  /pro/horst/api/files/:id/remove` (owner-checked in the handler), bytes from
  `/pro/artifacts/:id`; each chat chip's `⧉ Files` link opens its delivery.
- **Chat from apps**: `ctx.horst.chat`.

## Not built

- Uploading a file in the Horst tab chat (text only; files come in through
  Telegram).
- A 3D viewer in Files (no viewer is vendored; a model shows its delivered
  pictures and downloads). Backfill of files delivered before the ledger.
