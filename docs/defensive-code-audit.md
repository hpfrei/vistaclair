# Defensive Code Audit — retries, recovery wrappers, race guards

Date: 2026-06-12. Scope: vistaclair core + vistaclair-pro (node_modules excluded).

Verdict legend: **keep** (guards a real external failure mode), **dedupe** (correct but duplicated),
**fix** (root-cause fix removes the need), **log** (keep the swallow but make it visible).

## vistaclair (core)

### Retries
| Where | What | Verdict |
|---|---|---|
| `src/proxy.js:49-126` | `fetchUpstreamWithRetry` — backoff retry for upstream API, SSE first-chunk buffering | keep — external network I/O |
| `src/utils.js:299-302` | SIGTERM→SIGKILL after 3s for headless Claude subprocess | dedupe → `killGracefully` |
| `src/cli-session.js:262-268` | Same SIGTERM→SIGKILL escalation for PTY sessions | dedupe → `killGracefully` |
| `server.js:33-48` | Self-restart after node-pty auto-install | keep — native addon must load in a fresh process |

### Recovery wrappers / swallows
| Where | What | Verdict |
|---|---|---|
| `src/proxy.js:89,105,110-111,210,232,636` | Cleanup/parse swallows in error paths | keep |
| `src/proxy.js:745,873` | Silent `catch {}` losing diagnostics in router + count_tokens | log |
| `src/capabilities.js:377` | Secrets migration `writeSecrets` failure swallowed | log — correctness risk |
| `src/capabilities.js` (many) | Optional-file reads return defaults on error | keep |
| `src/utils.js:415` | `hasClaudeSubscription` swallows credential read errors | keep (boolean probe) |
| `src/licensing.js:109` | Signing-key refresh failure swallowed | log |
| `src/licensing.js:132-143` | Offline-grace fallback on license validation failure | keep — by design |
| `src/licensing.js:320` | `git pull --ff-only` failure swallowed in /pro/update | log |
| `src/store.js` (many) | Observability store degrades silently | keep — by design, must never crash proxy |
| `src/cli-sessions.js:22-35` | Six `try{unlink}catch{}` cleanup blocks | dedupe → `tryRm` |
| `lib/mcp-bridge.js:53-56,87-96` | Optional ws reporting + non-JSON stdio lines | keep |
| `server.js:61-75` | Pro module self-heal via npm install on MODULE_NOT_FOUND | keep — install model |
| `server.js:204-230` | Hook-report endpoint swallows all | keep — fire-and-forget by design |
| `src/proxy-rule-handler.js:269,333,336,427` | Temp-file precleans + meta parse fallbacks | dedupe unlinks → `tryRm` |

### Race guards
| Where | What | Verdict |
|---|---|---|
| `src/cli-session.js:36,49,131-133` | `_spawnGen` stale-exit-event guard | keep |
| `src/trace-index.js:39-44,149-154,183-191` | fs.watch debounce + watched-dir dedup | keep — fs.watch semantics |
| `src/store.js:37-48` | attachTraceIndex idempotency | keep |
| `src/mcp/index.js:13-14,333` | `serverRunning` double-start guard | keep — UI-driven |
| `src/mcp/index.js:26` | `setTimeout(autoStart, 500)` ordering hack | fix — wire to explicit ready signal |
| `src/cli-session.js:234-254` | `writeWhenReady` polls scrollback for `❯` prompt | keep — no programmatic ready event from CLI |
| `src/capabilities.js:280-299` | Stale hook-reporter entry cleanup | keep for now — path embeds install location; revisit with stable marker |
| `server.js:429-434` | Double-close counter + 2s fallback in scheduleRestart | keep |
| `src/port-cleanup.js` | `killStalePortListeners` at startup (local mode) | keep — `node server.js` runs unsupervised; listeners only (never clients such as ngrok), never self/parent/ngrok |
| `server.js:253-263` | `/api/ask` close-event cleanup | keep — prevents Promise/Map leak |

## vistaclair-pro

### Retries
| Where | What | Verdict |
|---|---|---|
| `src/apps/app-bridge.js:1193-1205` | aiPrompt retry loop (opt-in, linear backoff) | keep |
| `index.js:163,174` | initMemory/initMailEngines poll DB pool 20×1.5s | fix — await `appDb.init()` directly |
| `src/apps/email-sync-gmail.js:150-154,205-210` | Stale pageToken / expired historyId resets | keep — Google API behavior |
| `src/apps/email-sync-imap.js:427-432` | UIDValidity change → re-backfill | keep — IMAP semantics |
| `src/apps/email-sync-imap.js:488-503` | Reconnect exponential backoff | keep |
| `src/apps/silero-vad.js:82-98` | Single-flight lazy load, retryable on failure | keep |
| `src/apps/embeddings.js:24-37` | Same pattern but `_loading` sticky on failure | **fix — latent bug**: transient failure permanently disables embeddings |
| `src/apps/app-manager.js:287-293` | Port-probe loop for spawned apps | keep |
| `src/apps/telegram.js:325-358` | Long-poll backoff | keep |

### Recovery wrappers / swallows
| Where | What | Verdict |
|---|---|---|
| `src/apps/app-manager.js:382-393,554-565` | wrapHandler for async Express errors | keep — Express requirement |
| `src/apps/app-bridge.js:1124-1136,1149-1183` | parseAIJson fallback chain + aiRepairJson | keep — AI output is unreliable |
| `src/apps/media-ffmpeg.js:315-438` | preprocessAudio graceful degradation chain | keep |
| `src/apps/calendar-engine.js:386,621,669,684,724,747` | `syncAccount(...).catch(() => {})` ×6 | log |
| `index.js:124` | Telegram webhook dispatch swallow (must return 200) | log (keep 200) |
| `index.js:230` | git pull swallow in update | log |
| `src/apps/email-sync-imap.js:511` | logout→close nested fallback | keep |

### Race guards
| Where | What | Verdict |
|---|---|---|
| `src/apps/app-manager.js:44-45,701-716` | startingApps double-start guard | keep |
| `src/apps/calendar-engine.js:406,460-496` | Single-flight per-account sync (`running` Map) | dedupe → `singleFlight` |
| `src/apps/email-sync-gmail.js:19,258-279` | Identical single-flight pattern | dedupe → `singleFlight` |
| `src/apps/email-sync-imap.js:375-435` | busy flag / connecting guard / refresh debounce | keep |
| `src/apps/email-embed.js:19-39` | `_running` + `_queued` + `_kickTimer` triple flag | fix — single small scheduler |
| `src/apps/app-bridge.js:84-89` | withStateLock promise-chain mutex (.state.json) | dedupe → shared mutex helper |
| `src/apps/app-jobs.js:28-33` | withWriteLock — identical mutex (jobs.json) | dedupe → shared mutex helper |
| `src/apps/memory-maintenance.js:21-31` | DB-backed cron run-lock, 15min stale reclaim | keep |
| `src/apps/app-bridge.js:1170,1300,1648` + `app-manager.js:729-733` | SIGTERM→SIGKILL ×4 copies | dedupe → `killWithTimeout` |
| `src/apps/app-manager.js:688-695` | 3s silence ⇒ "running" for spawned apps | keep for now — no IPC readiness protocol in spawned tier |

## Cross-cutting root causes

1. **External I/O (keep):** Anthropic/Google/IMAP/Telegram retries and backoffs are legitimate; do not remove.
2. **Missing ready signals (fix):** MCP autostart 500ms delay; DB-pool polling loops. Both replaced by awaitable init.
3. **Duplication (dedupe):** SIGTERM→SIGKILL ×6 across both projects; single-flight ×2; JSON-file mutex ×2; try-unlink ×~10.
4. **Silent failure (log):** ~10 swallows hide real failures (git pull, secrets migration, background syncs, webhook dispatch). Keep behavior, add a warn line.
5. **Inherent platform constraints (keep):** fs.watch burst semantics, PTY prompt polling, Express async handlers, Telegram 200-always.
