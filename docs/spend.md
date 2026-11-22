# Spend policy & metering (admin-owned)

Every metered platform call — `ai.prompt` (LLM), `ai.transcribe`/`tts`/`image`/
`translate`/`detect`, `ai.webSearch`, the `ai.route` family — passes ONE gate
(`src/apps/spend-gate.js`) wherever it entered: routes.js ctx, the owner Bridge,
a job, a bot handler, a tool call, a cron tick.

- **Attribution** — `spend-context.js` (AsyncLocalStorage) wraps each entry
  point with `{ app, origin, principal }`, inherited with no cooperation from
  app code. `aiPrompt` sessions are registered by instanceId and their LLM cost
  is settled per request from the proxy's `interaction:complete` broadcast (the
  finally-fold remains only for headless runners).
- **Policies** are ADMIN-owned, under core's `dataHome/spend-policy/<app>.json`
  (`spend-policy.js`), one profile per deployment mode (`deployment-mode.js`:
  `local` | `deployed`, auto-detected from slave pairing / open apps /
  custom domains, admin-pinnable). Precedence: admin policy > the manifest's
  `spend` request > mode default — whole profile wins, no field merge. Presets
  `unlimited | metered | budgeted | locked | custom`; credits are USD × 1000.
  `unlimited` returns from the gate before the ledger or any identity is
  consulted. Controls: credit caps with subscriber modes (`count` | `separate`
  | `exempt`), rate limits, daily storage caps (`storage.dailyMB`, metered by
  `storage-meter.js`), pause, capability revocations via `grants` on
  `revocable` modules (`capabilities.md`). Apps with no policy get `unlimited`
  in both modes on first boot and are flagged for review. Platform-own calls
  (Horst, cron) run under the `platform` pseudo-app's host profile, which
  allows only `unlimited | budgeted | locked` — `metered` would refuse every
  unattributed heartbeat.
- **Gate order** (`authorize`): hard rules — audiences (`E_NOT_EXPOSED`), then
  free-if-not-metered, then revocations (`E_NOT_GRANTED`, refused even under
  `unlimited`) → `unlimited` returns → paused (`E_PAUSED`) → cap / rate →
  execute and settle.
- **Ledger** — `spend-ledger.js` records every call by principal / origin /
  method under `dataHome/spend-ledger/<app>.json`. Day buckets have no age
  cutoff: the main file holds the current month, and at flush every earlier
  month moves into its own shard `spend-ledger/<app>/<YYYY-MM>.json`, read
  lazily by queries. Each day also keeps `usage` (principal → model →
  `{ calls, costUsd, apiUsd, inTok, outTok, cacheTok, unpriced }`): `costUsd`
  is what the caps count, `apiUsd` is tokens × the model's list price (a
  subscription call is priced the same; `subscribed` only picks the cap
  slice). Days recorded before `usage` existed are read through a residual
  (model `null`, `apiUsd` = `costUsd`). Non-LLM unit prices live in
  `spend-pricing.js` (admin overrides in the host file); each metered module
  declares its `spend: { service, units }` (unit per method).
- **Usage query** — `query()` in the ledger is the one reader behind `ai.usage`
  and `ctx.aiUsage` (`capabilities/ai.js`, via `ai-service.aiUsageQuery`):
  `{ meterKey?, days?, from?, to?, groupBy? }`, UTC days inclusive, rows by
  `day` / `model` / `meterKey` (`_app` → `null`, `meter:<k>` → `<k>`). It
  validates and aggregates; the module only wires. Caps read `spent()` /
  `summary()`, which sum `total` / `principals` and ignore `usage`.
- **Cut-off** — a session over its cap is cut mid-run by core's `spend-guard`
  proxy rule via a tmpdir marker.
- **Audiences** — the hard rule that user-facing bridge callers only reach
  methods whose module lists `user`/`anonymous` in `audiences`.
  `capabilities-check` rules 18 (`cost-missing`) and 19 (`metered-ungated`)
  keep every metered module priced and gated.
- **Not built**: the public `vc` bundle with a token-authenticated user bridge
  (`POST /apps/<name>/api/bridge`); an app-lint rule for a missing deployed
  budget; `caps.principal.source: "tier"` reading real licence entitlements
  (accepted and stored, the gate still falls back to the fixed per-user cap).
- **Dashboard** — `spend-admin.js` (`app:spend:*` messages) and
  `public/spend-admin.js`: header mode pill, per-app panel, overview, card tile.
