# The platform bus (`src/apps/agent/horst-events.js`)

One event bus, bidirectional. Apps publish (`ctx.events.emit`, kinds
namespaced `<app>:<kind>`) and subscribe (`ctx.events.subscribe` in routes.js,
`Bridge.bus` in the iframe through an `events.subscribe` lease renewed at
half-TTL and delivered as the `bus:event` bridge event). Horst is the primary
subscriber.

- **Envelope** `{ id, at, source, app?, kind, summary?, payload, truncated?,
  dedupeKey?, correlationId?, hop, host?, trust, thirdParty?, storm? }`;
  `source` ∈ timer | email | app | tools | telegram | chat | webhook | system;
  `trust` ∈ owner | platform | app | untrusted.
- **Kinds**: the bus owns only `BUILTIN_KINDS` (timers, `email:new`,
  `app:started/stopped/failed/error/crashloop`, `tools:updated`, `webhook`,
  `todo:due/closed`); every capability sense is declared in its module's
  `horst.senses` and wired by `horst.wire` (`capabilities.md`). Three-tier
  catalog: platform, declared (`ctx.events.declare` / `manifest.events.emits`),
  discovered (auto-registered, agenda-only until promoted).
- **Guardrails** before anything else: kind regex, per-`app×kind` rate limit
  (60/min, hard drop, still audited), storm fold (>8 same-kind in 30s → one
  digest event), 16KB payload cap with truncation marker, 200 discovered kinds
  per app, optional `dedupeKey` window. Constants at the top of the module.
- **Order**: envelope → JSONL log (`.horst/events-log.jsonl`, ≤8MB rotated once
  to `.1`; `history({ kinds, since, sinceId, limit ≤ 500 })`, oldest-first,
  ring of 1000 reloaded at boot) → fan-out to subscribers → policy. So an
  `ignore` policy hides an event from Horst, not from apps.
- **Subscriptions**: patterns are kind globs (`*` per colon-segment, trailing
  `*` eats the rest). In-process handlers run on `setImmediate`; a throwing
  handler is recorded against the SUBSCRIBER (`app-guard`, surface
  `events.subscribe`). Iframe leases: 5s–24h, default 15m, swept on publish,
  cleared with the app (`bus.removeApp`). Own-process apps get emit / declare /
  history but no `subscribe` (no push channel to the runner); their iframes can.
- **Chains**: a re-publish inside a handler (AsyncLocalStorage `chain`) carries
  `hop + 1`, the parent's `correlationId` (or id) and a trust no stronger than
  the parent's; `hop ≥ MAX_APP_HOP (4)` is dropped and audited `dropped: hop
  cap`. Relayed peer events keep their own `hop ≤ 8` clamp.
- **Fire-and-forget only.** Request/reply is `ctx.tools.call` on a tool
  registered `expose: 'apps'` — never a reply on the bus.
- **Independent apps** (`manifest.platformContribution: false`) publish with
  `horst: false`: delivered and logged, audited `app-only`, never routed to
  Horst, greyed in Triggers. They are also outside the tool union, the digest
  and APP.md reads, and `ctx.governance` rejects.
- **Policy** per `app×kind`: `ignore` | `agenda` | `notify` | `run-action`
  (one deterministic routine: heartbeat, briefing, email triage, digest
  refresh, todo nudge, app triage, model review — `docs/models.md`). No model in routing; the triage model
  (haiku, strict `{ decision, reason }`, no tools) runs only for rule-marked
  ambiguity. There is no path from an event to an autonomous multi-step run.
  Every event and decision is audited (`events-audit.json`, ring of 2000)
  with the subscriber count. The kind-glob matcher exists three times:
  `matchKind` in the bus and in `public/horst/horst.js` (Triggers), `_busMatch`
  in `public/app-runtime.js` (`Bridge.bus`) — change all three together. Webhooks enter at `/pro/horst/api/hook/:name` (secret).
- **REST** under `/pro/horst/api/events/`: `catalog` (+ policies, run-action
  kinds, subscribers merged with manifest `listens`), `history`.

## Not built

- `subscribe` for own-process `routes.js` (needs a dashboard → runner push
  channel); subscription edges on the Map; runtime enforcement of
  `manifest.events.emits[kind].schema`.
