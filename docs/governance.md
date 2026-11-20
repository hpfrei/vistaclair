# Governance — the approval plane (`src/apps/governance/`)

- **Proposals** (`horst-governance.js`, `.horst/proposals.json`): frozen
  payloads validated at creation; approval executes exactly the stored
  payload; pending → approved (→ executed / failed) | denied | expired;
  `PROPOSAL_TTL_MS` 7d default, per-kind overrides.
- **Kinds**: registered by `registerKind(kind, def, { app })` (field contract
  in `capabilities.md`); app kinds are `<app>:<kind>` and clamped to propose.
- **What an app may stage** (`appMayStage`): its kinds, and platform kinds
  that declare `appProposable: true` — `email.send`, `email.modify`,
  `calendar.create/update/delete`, `telegram.send`. Every other kind is
  platform-owned: `requestAction` with `meta.app` (ctx / bridge `propose`, an
  app's governed tool in the broker) and `updateProposal` via `app:<name>`
  refuse it. `capabilities/governance.js` stamps `origin: 'app'` over any
  `meta.origin` an app passes.
  Platform kinds include `email.send` (propose, G9 floor), `email.modify`,
  `app.restart/start/stop`, `cron.set`, `calendar.create/update/delete`,
  `telegram.send`, `email.sync.reconnect`, `job.cancel/retry`,
  `spawn.kill/restart`, `server.restart`, `app.publish/rollback`,
  `app.data_publish` (propose, pinned, owner-only approve; staged by
  `ctx.fleet.dataPublish` when the caller is not the owner's click — the click
  runs directly with an `executed` audit row, `docs/fleet-data.md` "App API"),
  `app.remote_call` / `app.remote_job` (same rule for `ctx.fleet.call` /
  `jobs.start`; an approved call is a one-shot grant for the app's identical
  retry, `docs/fleet-remote.md` "Governance"),
  `peer.keys.sync/restart`, `peer.session.launch` (propose, pinned, one card
  per launch; card: the raw request with the prompt verbatim,
  `docs/remote-sessions.md` "The card"), `todo.create`,
  `mission.create`, `config.set`
  (payload `{ key, patch }`, `notify: 'none'`), `app.tool.job` (propose,
  pinned; staged only by owner chat, `docs/horst.md` "How Horst acts";
  payload `plan?` ≤ 500 chars, args free of `_plan` / `_wait`; card: Plan,
  then Arguments), and the chat-parity kinds:

  | Kind | Ceiling / default | Undo |
  |---|---|---|
  | `email.tags.set` | auto / propose | inverse of what changed |
  | `email.rule.remove` | auto / propose | re-adds the rule |
  | `email.folder.create` | auto / propose | idempotent |
  | `calendar.move` | auto / propose | moves back |
  | `calendar.invite` | propose / propose (pinned, outward) | — |
  | `todo.update` | auto / propose | previous state (none for a recurring complete) |
- **Undo**: an executor that knows the state it replaced returns
  `{ inverse: { kind, payload } }`; `runExecutor` stores it on
  `result.inverse` (registered kind, object payload) and `stageUndo`
  (`platform-horst.js`) stages it as a fresh proposal. `calendar.create` →
  `calendar.delete` is the one derived inverse.
- **Dials** (`.horst/dials.json`): per kind, clamped to hard ceilings, audited
  on change. **Kill switch** `paused`: heartbeat/triage/briefing/model review skip and
  nothing auto-executes; chat and manual approvals still work.
- **Ledgers**: `.horst/audit.json` ring of 500 (proposed / executed / denied /
  failed / dial / observed / suppressed / downgraded / collapsed, with `via` +
  proposalId);
  `horst-decisions.js` → `.horst/decisions.jsonl` (append-only, yearly
  rotation): every terminal decision with via, latency, payload projection
  (`compactPayload`; `app.tool.job` keeps `{ app, tool, plan, args }`) and
  the draft→final edit diff.
- **Cards** (`horst-cards.js`, requires only `text-safety.js`): one
  descriptor per kind, projected to Telegram, the Mini App and the Horst tab.
  Resolution: the kind's own
  `card()` → a family projector (email, email-modify, calendar,
  calendar-delete, telegram, todo — by base name) → a generic labelled-row
  renderer. `longtext` / `code` fields are cut at 4000 characters, a field
  marked `verbatim: true` at 64 KB (text the owner approves word for word),
  with every character `text-safety.js` counts invisible written as
  ⟨U+XXXX⟩ (Cf, tags U+E0000–E007F, controls but `\n` `\t`, U+E0100–E01EF,
  2+ consecutive U+FE00–FE0F).
- **Approval surface**: a kind's `approveFrom(proposal, via)` returns why an
  approval from that surface may not stand (it could not show the whole
  payload), or null; `decide` refuses before consuming the decision (the
  proposal stays pending; a throwing check refuses), and the Telegram card of
  such a proposal carries no Approve. Surfaces: `ui-full` (the Horst tab's
  full card), `ui` (its previews), `miniapp`, `telegram`, `app:<name>`. A
  pending proposal whose kind refuses `ui` leaves every egress marked
  `fullViewApprove`, and the Horst tab approves it only from the full card.
  Used by `peer.session.launch` (`docs/remote-sessions.md`, "The card").
- **Payload version** (`payloadVersion`: sha256 of `[kind, payload]`, 12 hex):
  on every egress (`withCard`, `withCards`, `listProposals`, `updateProposal`'s
  return). `decide(id, decision, via, { version })` refuses an approve whose
  version is not the current one (`STALE_VERSION`, still pending). Surfaces
  pass the version they rendered — Horst tab REST and Mini App `body.version`,
  Telegram the 4th callback segment, null when missing (refused); an app's
  `ctx.governance.decide(id, d, { version })` / bridge `version` is checked
  when given. An in-process caller that omits the key approves the current
  payload.
- **Prior-action check** (`horst-prior-action.js`): before a proposal reaches
  the owner, and again while pending (60s TTL, single-flighted), it is checked
  against the ledger (executed twin) and the world (calendar, sent mail):
  `done` / `partial` / `none`. `partial` converts `calendar.create` →
  `calendar.update` in place, never carrying guests (a PATCH keeps them;
  sending them would mail every guest); recurring occurrences are flagged,
  never converted. A non-`none` verdict at auto / auto+notify downgrades to pending.
- **Proposer health**: a kind whose human decisions (30-day half-life weighted,
  `horst-decisions.stats`) are approved below 40% over at least 8 decisions is
  no longer staged automatically (`HEALTH_MIN_DECISIONS` / `HEALTH_MIN_RATE`
  in `horst-governance.js`).
- **Identity / dedup** (`horst-identity.js`): a kind's `identity(payload,
  meta)` is the stable key of the act. Suppression, cheapest first: decided
  twin, denied event in the decision ledger, then the world. Automated
  proposers pass `checkFirst: true`; a pure duplicate is never staged — an
  `action: 'suppressed'` audit row is written instead. `createProposal` also
  collapses a pending twin by event identity.
- **Directory rule**: nothing in `governance/` requires `agent/`; an agent-side
  executor is taken as a launcher (`registerLauncher(kind, fn)`, registered by
  `platform-horst.init`). `agent/` may require `governance/`.

## Not built

- Kinds for token rotation and account removal — owner-click only today.
- `platform-horst.js` still hosts both the governance bootstrap and the
  proposal surface; the agent/governance seam is mapped, not fully cut.
- Deciding a proposal from chat: `proposals_list` is read-only; the owner
  decides on a card.
