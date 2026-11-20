# Sites: an app's own web servers

An app has two kinds of parts:

- **the dashboard app**: what opens in the dashboard, always behind the owner login
  (`apps.md`);
- **0..n sites**: each one its own web-server process on its own port. Anything the outside
  world reaches goes through a site.

App-facing contract: `_api-reference.md`, section "Sites (own web servers)".

| File | Duty |
|---|---|
| `platform/site-runner.js` | the child process: loads the handler, owns `listen()`, `site.*`, `/_vc/id`; zero dependencies |
| `src/apps/sites.js` | the engine: definitions, the host record, start/stop/crash/backoff, snapshots, `site.call` broker, status, events, deploy hook, domain check |
| `src/apps/sites-manifest.js` | the one validator of `manifest.sites` (engine and app-lint) |
| `src/apps/sites-ports.js` | port free?, who holds it (`/proc`), reclaiming our own orphan |
| `src/apps/sites-proxy.js` | the byte-proxy `/s/<app>/<site>/` |
| `src/apps/capabilities/sites.js` | `ctx.sites`, Bridge `sites.*`, `sites_status`, kinds, senses |
| `public/vc-site-status.js` | `<vc-site-status site="…">` for an app's own page |
| `test/sites.test.js` | the offline harness (temp apps dir, real children) |

## No nginx dependency

A site works with no reverse proxy at all. It serves on its port, and the dashboard's
byte-proxy covers hosts that are reached only through the tunnel. The nginx text and the
domain check in the Sites tab are optional extras for hosts that have a reverse proxy.
Nothing detects, requires or calls nginx, and no test needs it.

## Manifest and host record

```jsonc
"sites": { "main": { "handler": "site/index.js", "defaultPort": 8080, "bind": "127.0.0.1",
                     "autostart": true, "access": "public", "platform": "none" } }
```

| Key | Rule |
|---|---|
| `handler` | a `.js`/`.cjs` file, relative, no `..`, no dot-dirs, in a subdirectory (the fence grants that directory) |
| `defaultPort` | 1024–65535, unique within the app, not 3456/3457 nor the live dashboard/proxy ports |
| `bind` | `127.0.0.1` (default) or `0.0.0.0` |
| `autostart` | default `true` |
| `access` | required; only `public` is built ("not built yet" for `users`, `vc`) |
| `platform` | `none` (default) or `controlled`; `loose` is "not built yet" |
| `analytics` | boolean, default `false`; `true` makes the runner record every request (`docs/analytics.md`) |

`validateSites` returns errors/warnings. app-lint (rule `sites`) reports them, and the engine
refuses a site that has any.

The **host record** `<appDir>/.sites.json` holds `{ "<site>": { port, bind, autostart, keep,
domain } }`. It is per host and in `CODE_PRESERVE` (`peer-data.js`), so a deploy never
overwrites it. Only the host's own Sites tab edits it (`sites.hostSettings`). A port is checked
against every site of every app on the host and against the dashboard/proxy ports. A changed
port or bind restarts a running site. The manifest only ever holds `defaultPort`.

Per-site state lives in `<appDir>/.data/sites/<site>/`: `snapshots/<id>/`, `active.json`,
`config.json`, `crashes.json`, `data/` (the site's writable dir). The host nonce for
`/_vc/id` is `<appsDir>/.sites-host-id`.

## The runner

`cp.fork(site-runner.js)` with `cwd: '/'`, `stdio` piped into the log ring, and an IPC channel.

- **Lifecycle (no keeper).** The runner exits on IPC `disconnect`. A dashboard that stops,
  restarts, crashes or is SIGKILLed takes its sites with it. The engine also SIGKILLs every
  child on `process.on('exit')`. That covers the slave kill-switch (`peer-server.js` `/kill`:
  `pm2 stop` + `process.exit`) too. Boot autostarts every site whose host autostart is on
  (`index.js`, before `autostartApps`). Sites of apps disabled on a slave are skipped.
- **Env** is an explicit allowlist (`childEnv`): `VC_SITE_*`, `NODE_ENV=production`, `TZ`,
  `LANG`, `LC_ALL`. It never includes `AUTH_TOKEN`, provider keys or a `process.env`
  passthrough. `VC_SITE_KEY` (`app/site`) and `VC_SITE_OWNER` (a hash of the apps dir) are
  the orphan marker.
- **Fence**: Node's permission model, when `process.allowedNodeEnvironmentFlags` has
  `--permission` (Node ≥ **22.13** / 23.5).
  - Reads: the runner, the handler dir, the app's `node_modules` and `package.json`, and
    `.data/sites/<site>/`.
  - Writes: `.data/sites/<site>/data/` only.
  - No child processes, workers, addons or WASI.
  - Without `--permission` the site runs unfenced, and status says `fence: 'unfenced'`.
- **Handler**: `module.exports = function createSite(site) { return async (req, res) => {} }`.
  It may also return `{ request, upgrade }`. A throw answers 500. The runner logs only method
  and path, never the query, bodies or headers.
- **`site.static`** decodes once and refuses NUL, backslash, `.`/`..` (403) and any dot-segment
  (404). It serves only what `realpath` places inside the root. It answers with a weak ETag,
  `Last-Modified`, 304, a single range (206/416) and `Cache-Control` (`maxAge`, `immutable`).
  A directory without a trailing slash gets a relative 301.
- **`/_vc/id`** answers `HMAC(host nonce, app/site)` (32 hex) before the handler sees the
  request.
- **Analytics** (`sites.<site>.analytics: true`): the runner records each request before the
  handler's answer ends, and `site.track(name, props)` records a goal. The fence additionally
  reads `site-analytics.js` and the platform's country table. Everything else is in
  `docs/analytics.md`.
- The runner sends `stats` every 2 s (requests, errors, rss), which gives req/s and memory.

## Supervisor

| Event | What happens |
|---|---|
| start | port check, `ensureFree`, fork, wait for `ready` (15 s) |
| crash while the dashboard is up | crash count + history (last 20, persisted), `site:crashed` and an owner toast (≤ 1/min/site), restart after 1, 2, 5, 10, 30, 60 s; 60 s of uptime resets the backoff |
| start failure (handler throws, port held) | state `error` with `lastError`; no retry unless in a crash cycle |
| stop | IPC `stop` (close the server), SIGKILL after 3 s |
| app stop | sites keep running; `app:stop` with `stopSites: true` ("Stop sites too") stops them |
| uninstall / rename | `removeApp` stops and forgets them; rename autostarts them under the new name |
| shutdown | `apps.shutdown` → `sites.stopAll()` before `cleanupAll` |

**Ports.** A busy port gets a plain-language error naming the holder: the program, its pid
and its command line, or "another program (one this user cannot inspect …)". `ensureFree`
reclaims only a holder whose cmdline names our runner and whose env carries the same
`VC_SITE_KEY` and `VC_SITE_OWNER`, using SIGTERM and then SIGKILL. Everything else is left
alone.

**Status** (`sites.status`): `state` (`stopped` | `starting` | `running` | `stopping` |
`crashed` | `backoff` | `error`), `pid`, `port`, `bind`, `autostart`, `access`, `platform`,
`keep`, `domain`, `uptimeMs`, `mem`, `reqPerSec`, `requests`, `lastError`, `crashCount`,
`nextRetryAt`, `fenced` / `fence`, `snapshot`.

**Events.** Each event is sent as `app:bridge:event` to the app's iframe, as `app:site` to the
dashboard, and on the bus as senses `site:status` (ignore), `site:crashed` (notify) and
`site:published` (ignore). Log lines are batched to the dashboard as `app:site:log`.

## site.call (platform: controlled)

The app registers names with `ctx.sites.onCall(name, fn)`. The engine re-checks every call
(`handleCall`):

- `platform` is `controlled`;
- the name is registered;
- JSON args ≤ 64 KB;
- 60 calls/min per site and client /24 (IPv4) or /64 (IPv6);
- the app is mounted or running;
- timeout ≤ 30 s;
- result ≤ 256 KB.

The client IP is the socket peer. Only when that peer is loopback does the runner use
`X-Real-IP` or the last `X-Forwarded-For` entry instead (AsyncLocalStorage per request). A
handler sees `{ site, ipPrefix }`, never the request.

## Snapshots

`publish(site, dir, { note })` copies `dir` into `snapshots/.tmp-<id>`
(`COPYFILE_FICLONE`, a reflink where the filesystem can; never a hardlink, so an in-place
edit cannot change a snapshot). Symlinks are skipped, and a snapshot holds at most 50,000
files. The copy is then renamed to `<id>` and `active.json` is written atomically. The runner
is told over IPC, which takes no restart, and it acknowledges. In-flight requests finish on
the old files.

`rollback` is the same switch. `keep` (default 5, 1–50, host record) counts the active
snapshot plus the newest others.

## Code publish (federation)

`peer-server.js` deploy and rollback jobs call `sites.afterCodeSwap(app)` after `deployCode`.

- A running site restarts only when `sha256(handler dir minus node_modules/dotfiles +
  package-lock.json + site-runner.js)` differs from the hash taken at spawn.
- Removed sites stop, and new autostart sites start.
- Paths are strings under `<appsDir>/<app>`, so they resolve against the new dir. `.data` and
  `.sites.json` move with it.

`GET /api/peer/apps/:name/status` adds `sites` (`sites.health`). Its `probe.ok` is false while
an autostart site is not `running`, and the publish health poll (`publish.js` `waitHealthy`)
names the sites that are down. The channel snapshot carries `apps[].sites` (`site`, `state`,
`port`, `crashCount`, `fence`). The master cleans it (`peer-channel.js` `cleanSites`), exposes
it as `fleetState().peers[].appSites`, and shows it in the app's remote rows. Settings are
edited only in the slave's own Sites tab.

## Byte-proxy

`/s/<app>/<site>/…` on the dashboard is pass-through only.

- **Who it serves.** Only `access: public` sites that are running. Anything else gets a 404.
  It is anonymous through `EXEMPT_RE`: in `authExemptPatterns` for HTTP, and in
  `authExemptUpgradePatterns` (core `src/addons.js`) for upgrades.
- **Request.** The `sid`/`token` cookies are dropped, and so is an `Authorization: Bearer
  <AUTH_TOKEN>`. `x-vistaclair-*` headers are stripped. The proxy adds `X-Forwarded-Prefix:
  /s/<app>/<site>`, `X-Forwarded-For`/`-Host`/`-Proto` and `X-Real-IP`.
- **Response.** A `Set-Cookie` for `sid`/`token` is dropped (`app-headers.stripAuthCookies`),
  including on 1xx and on the upgrade's 101 head.
- **WebSocket.** Raw bytes both ways after the rewritten head.
- **Paths.** The site sees the path without the prefix; `/s/<app>/<site>` gets a 301 to the
  slash form.

## Owner UI and domain

The app settings (⚙) have a **Sites** tab. The dashboard's WS `app:sites:list` and
`app:site:{detail,start,stop,restart,settings,rollback,checkDomain}` go through one
dispatcher, `sites.ownerAction`, which answers with `app:site:result`.

Per site the tab shows:

- status;
- editable port, bind, autostart, keep and domain;
- start, stop and restart;
- the live log tail;
- the crash history;
- the snapshots, each with Rollback;
- the nginx text, `/` → `127.0.0.1:<site port>` (`sites.nginxSnippet`);
- **Check** (`sites.checkDomain`): DNS, then `https://<domain>/_vc/id` must equal this host's
  token (`ok` | `no-domain` | `dns` | `unreachable` | `not-here`).

The app's Stop asks whether to "Stop sites too".

Horst's lane: reads go through `sites_status` (direct). start/stop/restart are the kinds
`site.start` / `site.stop` (default propose) and `site.restart` (default auto+notify,
idempotent). config, publish and rollback are never his: they are the app's own.

## Not built

- `access: "users"` / `"vc"` (P3).
- `platform: "loose"` (P3).
- A `{ server }` handler form, `instances`, and `command` sites (P3).
- Migrating existing apps onto sites, and retiring the private/users/open levels and
  `surfaces.public` (P3).
- `ctx.sites` in own-process / standalone apps (`visibility.standalone: false`).
- A platform-owned fleet-data receiver for `.data/sites/**`. Receivers are per app
  (`fleet-data-receive.js`) and need the app's `receive()`, so snapshots travel only through
  an app's own data publish or are re-published on each host.
- Editing a slave's site settings from the master.
