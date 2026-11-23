# Antigravity (`agy`) sign-in

The dashboard signs the Antigravity CLI in the way it signs Claude Code in
(`src/claude-auth.js`, README "Sign in to Claude"). Vistaclair never reads,
stores, logs or copies agy's credentials: they live in the OS keyring (Secret
Service) and only the unmodified `agy` binary touches them.

| Piece | File |
|---|---|
| status probe, login pty, env, needed-detection | `src/agy-auth.js` |
| WebSocket handler, `reportAgyAuthFailure` | `src/ws/agy-auth-handler.js` (prefix `agy-auth:`, registered in `src/dashboard-ws.js`) |
| header pill + modal | `public/agy-signin.js`, `#agySignInModal` / `#agyAuthPill` in `public/index.html` (CSS shared with the Claude modal) |
| tests (a fake agy script) | `test/agy-auth.test.js` |

## Status

`agy models` (~0.4 s, cached 30 s, `AuthStatus`). agy has no status command, so
only the exit code and a few message patterns are read; the model list is
dropped. `state`:

| state | when |
|---|---|
| `signed-in` | exit 0 |
| `signed-out` | non-zero and "please sign in" / "authentication required" … |
| `keyring-locked` | non-zero and the message names the keyring / Secret Service / dbus |
| `not-installed` | no `agy` ($`VISTACLAIR_AGY_BIN`, PATH, `~/.local/bin/agy`) |
| `unknown` | non-zero with no known message (the dashboard offers sign-in) |

The status message is `{ state, installed, signedIn }` and nothing else.

## Login

`agy acp --login` in a node-pty (`LoginProcess` from `claude-auth.js`: one at a
time, 10 min timeout, SIGTERM then SIGKILL, replay for a second dashboard,
abandoned after 60 s with no viewer, cancelled at shutdown). It prints a Google
link and asks for the authorization code; the modal's paste field sends the code
plus `\r`. Exit 0 → the probe is re-run and the result sent as
`agy-auth:login:exit { ok }`. Messages mirror `claude-auth:` (`status`,
`login:start|input|resize|cancel`, `login:started|output|exit|error`).

## Environment (`agyEnv`)

- removed: `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `AGY_ADC_AUTH`,
  `GOOGLE_APPLICATION_CREDENTIALS` (only the subscription login counts);
- `AGY_CLI_DISABLE_AUTO_UPDATE=true`;
- `DBUS_SESSION_BUS_ADDRESS` kept, or derived from `/run/user/<uid>/bus` when
  that socket exists: agy needs the Secret Service, unlocked;
- login only: `BROWSER=/bin/false`, `DISPLAY` / `WAYLAND_DISPLAY` unset, so no
  browser opens on the server.

## Sign-in needed

`isAgySignInNeeded({ exitCode, stdout, stderr, json })` is true on
"authentication required", "please sign in", "not logged into antigravity",
"authentication failed or timed out" (case-insensitive, in stderr or the `-p`
JSON `error`), or `-p` JSON `status: "ERROR"` with an auth-related error. A bare
exit 1 is not enough. A locked keyring is its own reason
(`agyAuthFailureReason` → `keyring-locked`).

`reportAgyAuthFailure(info)` (handler module) classifies a failed run, re-probes,
and broadcasts `agy-auth:needed { reason }` (`sign-in-needed` | `keyring-locked`);
the dashboard opens the modal with a notice. agy workers and providers call it
with what the run printed.

## Not built

- No agy runs yet: nothing calls `reportAgyAuthFailure`.
- No account detail (email, plan): agy has no status output to read it from.
- No keyring unlock from the dashboard.
