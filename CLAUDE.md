# Vistaclair

This file is the index. Start here, then open the one doc for the area you are
about to touch — before changing it, not after.

## Documentation map

One product: the core (`server.js`, `src/`, `lib/`, `public/`, `test/`) and the
Apps Platform (`platform/`, loaded unconditionally). Paths in the platform rows
below that start with `src/`, `public/` or `scripts/` are under `platform/`.

| Doc | Read it when you touch |
|---|---|
| `README.md`, `SECURITY.md` | the install, the ports, the dashboard login, the threat model |
| `src/proxy.js`, `src/proxy-rule-handler.js`, `src/providers/`, `src/sse-passthrough.js` | the proxy on `:3456`: routing to providers, proxy rules, streaming passthrough (README "Provider routing", "Proxy rules") |
| `public/inspector*.js`, `src/inspector-sessions.js`, `src/trace-index.js` | the Inspector: instance traces, lanes, retention |
| `src/cli-session*.js`, `src/sdk-session.js`, `src/session-*.js`, `public/cli.js`, `public/sdk-panel.js` | CLI and Agent SDK sessions: launch, resume, uploads, totals, tokens |
| `src/orchestration.js`, `lib/orchestrator-mcp.js`, `lib/orchestration-hook.js` | orchestrator runs: workers, queue, reports, the run board |
| `docs/desks.md` | Desks and TabHost: the window manager for second-level tabs |
| `src/login.js`, `src/login-routes.js`, `src/auth.js` | dashboard login: the token, one-time links, login challenges and providers (README "Dashboard login") |
| `src/csp.js`, `SECURITY.md` (Content-Security-Policy) | the CSP of dashboard pages; `public/vendor/README.md` for the vendored libraries |
| `docs/app-origin-design.md`, `docs/defensive-code-audit.md` | the apps-origin design (not built), the defensive code audit |
| `docs/seam.md` | anything that crosses into core: the ctx contract, the descriptor, the proxy, `app-runner.js` |
| `docs/apps.md` | app shape and runtimes, app-guard, cron, access levels and surfaces |
| `docs/extras.md` | platform extras and toolchains (`platform-extras.js`, `platform-extras-godot.js`): Setup → Extras installs, probes, `capabilities.json`, `manifest.toolchains` |
| `docs/extras-unity.md` | the `unity` extra (`platform-extras-unity.js`, `src/apps/unity/`): Unity editor + Android pins, `bin/unity*`, the licence scripts, the signing package, the Quest APK probe |
| `docs/print.md` | local printing: `platform-print.js`, `ctx.print`, the Setup → Drucker panel (`public/apps.js`, `printSetup`), CUPS, the daily page cap |
| `docs/sites.md` | an app's sites (`site-runner.js`, `sites*.js`, `capabilities/sites.js`): manifest `sites`, the runner and its fence, the supervisor, snapshots, the `/s/<app>/<site>/` byte-proxy, deploy hash restart, the Sites tab |
| `docs/apps-view.md` | the dashboard's Apps tab: the grouped apps table, its columns and actions, the Setup button in the tab strip (`public/apps.js`) |
| `docs/ai-read-scope.md` | `readRoots` of an aiPrompt run: which paths a run granted a file tool may touch, the PreToolUse hook, defaults per caller (`ai-read-scope.js`) |
| `docs/app-tools.md` | the MCP broker, `authorizeToolCall`, the tool contract, app-to-app dependencies, tool grants for orchestration runs |
| `docs/tool-jobs-artifacts.md` | long-running job tools (ledger, routes, the Horst route), the artifact store, `/pro/artifacts/:id` and the artifact agent tools |
| `docs/sessions.md` | the build/change sessions: the launcher, the generated prompt, the `.vistaclair/` sidecars, the read ledger, the CLI / Agent SDK engines |
| `docs/change-requests.md` | cross-app and platform change requests (`app-change-requests.js`): asking another app or the platform for a change, depth and cycle limits |
| `docs/capabilities.md` | `src/apps/capabilities/*` (ctx, Bridge, manifest, kinds), the registry, fixtures, app-lint, the one-duty rule |
| `docs/horst.md` | the agent core: principles, genome, how Horst acts (routines, email triage, missions, chat), memory, security invariants, module map |
| `docs/bus.md` | the platform bus: envelope, kinds, guardrails, subscriptions, policies, `src/apps/agent/horst-events.js` |
| `docs/governance.md` | the approval plane: proposals, kinds, undo, dials, ledgers, cards, prior-action check, dedup (`src/apps/governance/`) |
| `docs/horst-lanes.md` | `horst.lane` in a capability module: Horst's direct / card / never stance per member, the direct media tools (image, speech, transcribe, maps, page render) |
| `docs/horst-surfaces.md` | Horst's surfaces: the Horst tab, Telegram, event reminders, Mini App, `ctx.horst.chat` |
| `docs/telegram-control.md` | the platform Telegram control bot's owner: the claim code, `isOwnerAct` / `isPrivileged`, the dashboard QR login (`platform-login.js`), sessions and alerts, Mini App bearers; every bot's inbound delivery (webhook / long-poll / tunnel-down fallback in `telegram.js`) |
| `docs/memory.md` | the shared memory store: recall, reinforcement, the long tier, consolidation, retention, compaction, Horst's brains |
| `docs/models.md` | AI model choice: the media catalog and adapters, the default chain, configured defaults, Horst's daily model review and its alerts |
| `docs/spend.md` | metering, policies, the ledger, revocations |
| `docs/engines.md` | the email, calendar, Google-auth and tasks engines, per-app user identity |
| `docs/federation.md` | peers, the channel, publish/rollback, fleet senses |
| `docs/fleet-data.md` | the fleet data publish engine (`fleet-data.js`, `fleet-data-receive.js`, `fleet-data-manifest.js`, the `/api/peer/fleet-data` routes): manifest, inbox, resume, integrity, disk margin, expiry, its internal API, the app API (`ctx.fleet`, `fleet.sync`, the `app.data_publish` kind) |
| `docs/fleet-data-up.md` | the up direction of the data publish, slave → master (`fleet-data-up.js`, the `/api/peer/fleet-data-up` routes, `fr:req` / `fr:reply` / `fr:fd` frames): `ctx.fleet.master()`, the master pulling byte ranges into its own inbox, the slave's mirror records, who may start one (`owner via fleet.jobs <id>`), cancel from either side, the `fleet.sync.up` flag |
| `docs/fleet-remote.md` | the fleet remote call / job (`fleet-remote.js`, `fleet-remote-host.js`, `fleet-remote-wire.js`, the `/api/peer/fleet-remote` routes, `fr:job` frames): an app calling its own copy on a slave and starting jobs there, records, the grant for a retried call, `remoteContext()`, progress push (`ctx.fleet.call` / `jobs` / `onCall` / `onJob`, `dataPublish.on`) |
| `docs/fleet-specs.md` | peer hardware specs (`host-specs.js`): what is measured and when, the snapshot transport and its sanitising, `ctx.fleet.peers()[].specs` / `ctx.fleet.self()`, the `fleet.specs` flag |
| `docs/remote-sessions.md` | `peer-remote-master.js` / `peer-remote-host.js` / `peer-remote-agent.js`: Agent SDK sessions launched on a slave and shown on the master — remote workers via `launch_cli({ host })`, Horst's and the owner's launches, the `peer.session.launch` card (tabs, relayed questions, billing totals, `app:peer:session:*`, the module API) |
| `platform/src/apps/prompts/_api-reference.md` | the APP-facing API. It is what build/change sessions read (as the `.vistaclair/` sidecar); `build.md` / `extend.md` / `build-tools.md` are the session prompts. `capabilities-check` validates its headings |
| `platform/src/apps/agent/README.md`, `platform/src/apps/governance/README.md` | the one-way dependency rule between the two halves of Horst |

## Documentation rules (standing)

- **Current state only.** Docs describe what the code does today. No phase or
  wave markers, no "shipped / removed / superseded" notes, no dated
  narratives, no proposals or reviews. Git history holds the past; plans live
  outside the repo. What is deliberately NOT built goes in a short "Not built"
  list in the area's doc, nowhere else.
- **Same change, same doc.** A behaviour change updates the area doc in the
  same commit. A new area gets a new `docs/<area>.md` AND a row above. Nothing
  else lands under the repo root or `docs/`: no TODO, plan, handover or review
  files. Open work is a dated comment at the code, or a line in
  `vistaclair-apps/PLATFORM_GAPS.md` when logged from an app session.
- **Keep them short.** A doc that passes ~250 lines is split by area, not
  grown. Prefer a table or a terse bullet to a paragraph; name the file or
  function, not the story of how it got there.
- **App-facing truth is generated.** What an app session learns comes from the
  capability modules through `_api-reference.md` and the prompt fixtures; a
  platform behaviour an app can rely on is documented there, and checked by
  `npm run check:capabilities` and `npm run test:fixtures`.

## Delegation policy (sub-agents)

Spawn depth is capped at 1 and enforced by a `PreToolUse` hook: this session
delegates, agents do the work. An agent that needs a second wave returns and
says so — the decision to launch it belongs here.

- **Prefer `Explore` for anything that is reading.** It cannot recurse, and it
  returns conclusions rather than file dumps.
- **State how many agents you are launching, and why, before launching them.**
- **Never hand one agent a compound question.** Split it into named
  deliverables or answer it directly.
- **Mechanical agents (scraping, lookup, quoting) get low effort and a cheap
  model.** Reserve high effort for synthesis; effort is inherited.
- **Budget the merge.** N agent reports are worthless without a step that
  reads them.

## Hard rules

- **Never restart, stop, kill or interfere with the running control-room
  server** (`/home/hp/vistaclair`) or its ports. Verify with tests and
  throwaway harnesses in a temp dir, never against the live process.
- **The seam is contract** (`docs/seam.md`): `platform/` reaches core only
  through the ctx and `src/addon-host.js`; core loads `platform/` by one path
  and never imports its internals.
- **One duty, one implementation** (`docs/capabilities.md`): the engine
  enforces, Horst judges, the owner decides; no second copy of a duty in an
  app or a kind.
- **GUI-reload resilience** (`docs/apps.md`): every long-running operation
  persists its state server-side and is recoverable after a reload.
- **Capability modules define the surface** (`docs/capabilities.md`): ctx
  members, bridge methods, manifest keys and docs come from
  `src/apps/capabilities/<key>.js` and nowhere else.

## Verification

Run from the repo root (one `package.json`; the platform is `platform/`):

```
npm run check:capabilities        # module contract + api-reference headings
npm test                          # core test/*.test.js + platform/test/*.test.js (includes duty-overlap over installed apps)
npm run test:platform             # platform/test/*.test.js only
npm run test:fixtures             # regenerate platform/test/fixtures after an intentional surface change
node platform/test/gen-fixtures.js --check # fixtures match
npm run lint:app -- <appDir>      # app-lint (add --json); the build prompts run it
npm run infer:capabilities -- <appDir> --write   # refresh manifest capabilities + events
npm run access -- <app>           # the access-level picture for an admin
npm run apps:claudemd             # regenerate <appsDir>/CLAUDE.md from prompts/_standing-rules.md
```
