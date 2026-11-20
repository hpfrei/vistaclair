# Apps: shape, runtimes, access, build sessions

## One app shape, two runtimes

`routes.js + public/ + manifest.json`, resolved by `appRuntime(name)` in
`app-manager.js` (`runtime` on the live entry is the truth; `type` is legacy):

- **in-process** (default): `routes.js` is `require()`d inside the dashboard's
  trust boundary. It can read `process.env` (including `AUTH_TOKEN` and provider
  keys), block the event loop, and a throw during router setup can affect the
  host. The bridge API is the sandboxed capability surface; the `require()`
  itself is not sandboxed.
- **own-process** (`"runtime": "own-process"`): the SAME routes.js contract,
  hosted by a dashboard-managed `app-runner.js` child on an ephemeral loopback
  port, reverse-proxied at `/apps/<name>`. Crash/blocking containment, no
  in-dashboard code execution, restricted standalone ctx (no googleAuth /
  emailAccounts / calendar / cross-app tools / governance / horst / bus
  `subscribe`). NOT a secrets sandbox: the runner dotenv-loads core's `.env`.
  No auto-respawn — a crash records one `process` failure in app-guard.
  pm2-managed standalone apps (`"standalone": true`) are own-process too, just
  externally managed (`startApp` refuses them).

**Stopping.** A dashboard tab is only a view: closing it ends nothing, the app
may be open in another browser or doing its own work. An app stops through
its row in the Apps table or its top bar (`app:stop` — also ends its `cli.edit` /
`cli.workspace` sessions and spawned helpers), Horst's approval-gated
`app.stop`, a peer deploy/import/rollback, delete, rename, or server shutdown.
An open tab whose app stopped stays open and offers Start.

A virtual display or a long-lived helper process is something an app *does*
(Bridge `spawn.*`, the gui-mode extra), not something an app *is*.
`exec`/`spawn` use `shell: true` with app-provided commands; `http.fetch` is
SSRF-guarded (blocks private/loopback addresses).

**Failures** outside a request are recorded and attributed by `app-guard.js`
(`record` / `run` / `attempt`); it feeds `getAppStatus().errors`,
`list()._errors`, the dashboard (`app:runtimeError`, `app:crashloop`) and the
`app:error` / `app:crashloop` senses. A crash loop runs the `app-triage` rule
action: an agenda observation plus an `app.restart` proposal at its dial.
It also records start failures (`startApp`'s catch, surface `start`; the
own-process exit handler, `phase: 'start'`; a throwing `routes.setup`) and
browser errors from app iframes (`app:clientError` from `reportError` in
`public/apps.js`, surface `browser`). One error object is recorded once.

| Header alert (`toast:push`, level `error`, sender = app) | Coalescing |
|---|---|
| **Start failed** | one per app per `ALERT_EVERY_MS` (60 s) |
| **Runtime error** (with the running count) | one per app per `ALERT_EVERY_MS` |
| **Crash loop** | one per cooling window; silences the two above meanwhile |

The Apps table keeps the start-failed state on the app's row and the Runtime
errors list in its Attention group (detail, Dismiss, Clear all); neither
offers an AI fix. The table itself is `docs/apps-view.md`.

**Sites.** Besides its dashboard part, an app may declare `sites`: public web servers in
their own processes on their own ports, children of the dashboard (`sites.md`). Stopping the
app leaves its sites running unless the owner picks "Stop sites too".

## GUI-reload resilience (every feature)

Long-running operations persist their status server-side (`ctx.jobs`), are
re-queried on reload, show intermediate states, and deliver their result when
the GUI reconnects. A reload must never orphan an operation.

## Cron

`platform.cron.*` and the per-app `cron.*` bridge methods share the one
persistent scheduler in `platform-cron.js`. Per-app jobs carry `appName`,
survive restarts, emit `cron:result` as an `app:bridge:event` routed to the
app's iframe, and are removed when the app is deleted (not on stop).
`ctx.platform.cron` (routes.js, in-process only) is the server-side face:
`app-api` jobs against the caller's own endpoints, owned by the caller,
idempotent by `name` so `setup` registers them on every mount.

**Cron credentials.** App code never sees core's `AUTH_TOKEN`
(`x-vistaclair-internal`). An `app-api` job for an in-process app goes through
the dashboard, whose gate accepts the internal header; the `/apps` dispatcher
(`index.js` `appsDispatcher`) resolves the owner decision first
(`internal-headers.js` `markOwner` → `req._vcOwner`, read by
`ctx.identity.resolve` / app-auth `via:'owner'` / spend attribution), then
strips every `x-vistaclair-*` header, so the guard and `/api/cron/*` routes
(e.g. gymihorst `/api/cron/nudges`) keep resolving cron as owner. An
own-process child is called directly and gets only its per-app cron signature:
a random secret per spawn (`app-manager.getCronSecret`, env
`VISTACLAIR_CRON_SECRET`; a standalone runner publishes its own as `cronSecret`
in `.standalone.json`). `app-runner.js` resolves a request carrying
`x-vistaclair-cron-sig` as owner of that one app, then strips all
`x-vistaclair-*` headers. `proxyToApp` strips them from every proxied request. Core's global JSON/urlencoded
parsers drain the body first; `proxyToApp` then replays `req.rawBody` with a
matching `Content-Length` (same as the `/s/` byte-proxy) rather than piping the
spent stream.
A CLI tab calling `/apps/<name>/api/...` with the internal header resolves as
owner in-process (my-blog's save flow); an own-process app gets no owner
credential from the proxy (it never did: cookies and `authorization` are
dropped there too).

## The platform bus (app view)

`ctx.events.emit` publishes onto the one event bus (`bus.md`, "The platform
bus"); `ctx.events.subscribe` (routes.js, not in own-process) and `Bridge.bus`
(iframe, every runtime) receive; `ctx.events.history` / `events.history` read
the log. Fire-and-forget only — an answer from another app is
`ctx.tools.call` on one of its `expose: 'apps'` tools. `manifest.events`
declares `emits` (declared at `startApp`) and `listens` (documentation).
`ctx.events.declare` writes its kinds straight into `manifest.events.emits`
at mount (in-process apps only — the own-process runner has no manifest
writer, and the bus catalog holds their kinds), so the manifest is true
without anyone running a script; `infer:capabilities --write` fills both
fields from the code and `--check` reports what it would change. app-lint
rule 17 makes an emitted-but-undeclared kind an error. App-facing detail:
`_api-reference.md`, "The platform bus".

An app's `ctx.aiPrompt` / `ai.prompt` call gets no tools unless it lists them in
`allowedTools` (omitted = `[]`); see `docs/capabilities.md`.

## Access levels (the one exposure decision)

Who can reach an app without the owner login is derived from the manifest's
`auth` block by `src/apps/surfaces.js` (`accessLevel`) and never toggled on its
own:

| Level | Signal | Cookieless | routes.js ctx |
|---|---|---|---|
| **private** | no login channel | nothing | full |
| **users** | `auth.telegram` / `whatsapp` / `email` | the fixed `app` entry surface: root 302 → `app.html`; `app.html`, `app.css`, `app/**`, `/api/app/*` (behind app-auth's default-deny guard); `/api/app/pub/*` anonymous by convention | full |
| **open** | `surfaces.public.pages: ["**"]` and NO login channel | whole subtree | full minus the admin's grants (`OPEN_REVOKED` in `spend-policy.js` — email, calendar, google, telegram, whatsapp, apps, governance — seeded revoked on the flip) |

Open never coexists with users (the `**` is dropped, fail closed).
`public.landing` and narrow `public.pages` / `public.api` remain manifest-only
escape hatches. The entry surface is never declared (`surfaces.user.entry` is
neither written nor read; app-lint says so). An app with a login channel is
private until it ships `public/app.html`. Session tokens carry their channel
(`issueSession(id, { via })`). `index.js` refuses any dot-segment request under
`/apps` before dispatch. **Custom domains** (nginx maps `/` onto `/apps/<n>/`):
the anonymous root 302 from `/apps/<n>/` is a relative `Location`, so it stays
on the serving host; and wherever the root 302 runs, `/apps/<n>/login` is
cookie-exempt (the login trap, `surfaces.loginRedirectTarget`) and `index.js`
sends non-owners on to the root target — core's absolute `/login` redirect
would otherwise loop there. The owner falls through; a `public.pages` glob
matching `login` hands the path to the app. `npm run access -- <app>` prints the whole picture; the
app settings' Config tab offers exactly the three levels; `display: fullscreen` is
presentation only.

**Response headers** (`src/apps/app-headers.js`, mounted first under `/apps` in
`index.js`): an app without a custom domain shares the dashboard's origin, so
every `/apps/*` response (in-process router, `proxyToApp`, static, the landing
kit, error pages) drops any `Set-Cookie` named exactly `sid` or `token` (core's
owner auth cookies) or with an empty name (`=sid=x`; browsers send it as
`sid=x`), also on 1xx / `writeEarlyHints` responses; other cookies pass. It gains `X-Content-Type-Options:
nosniff` unless the app set it, plus a separate `Content-Security-Policy:
frame-ancestors 'self' https://web.telegram.org; base-uri 'self'` header beside
any CSP the app sends (never merged; browsers enforce both). `web.telegram.org`
is there for users-level apps in the Telegram Mini App iframe. There is no
broad CSP (it breaks apps); WebSocket upgrades are untouched, and artifact
downloads live under `/pro/artifacts`, keeping their own sandbox CSP. Platform
credential headers (`x-vistaclair-*`) are stripped before app code too (see
Cron credentials). Tests:
`test/app-headers.test.js`.

**Served user files** (`ctx.files.serve` in `src/apps/app-files.js`; Horst's
`GET /pro/horst/api/artifacts/:id/file` uses the same `contentHeaders`): the
type is normalised (lowercase, parameters dropped, valid syntax, else
`application/octet-stream`; a text charset survives) and every response gets
`X-Content-Type-Options: nosniff`. Passive types (png, jpeg, gif, webp, avif,
bmp, ico, `audio/*`, `video/*`, pdf, `text/plain`) go inline as is; every
other type (html, svg, xml, javascript, unknown) also gets `Content-Security-Policy:
sandbox` (never `allow-same-origin`, no `allow-scripts`): still viewable, but
an opaque origin that cannot reach the dashboard. `ctx.files.saveBase64`
stores the normalised type and rejects nothing a type check could reject.
Tests: `test/security-user-content.test.js`.

**Landing kit** (`src/apps/surface-kit.js`, `public/surface-kit/kit.js`): the
primitives a public-facing app needs on its anonymous surfaces, served at
`/apps/<name>/__surface/kit.js` / `kit.css` / `info` (enabled login methods,
licence product, Telegram deep link, entry/landing) — anonymous session
bootstrap, email / Telegram-QR / WhatsApp login widgets, licence/subscribe
hook. The `/__surface/*` namespace is cookie-exempt by construction for every
app that declares an anonymous surface. Tests: `test/surfaces.test.js`.

The modal's **Public URL** block is derived server-side —
`appManager.accessInfo(name)` over `surfaces.js`, fetched with
`app:getAccessInfo` → `app:accessInfo`; the browser never re-derives it. The
external base is resolved, not guessed: a recorded `manifest.domain` wins
(`https://<domain>/`), else the platform public URL from Setup → Telegram
(`https://<base>/apps/<name>/`), else none (the block then says the URL is
merely this browser's origin). It lists `describePatterns` verbatim, marks a
`surfaces.public.api` prefix that nothing lifts the owner cookie off or that
switches the default-deny guard off for all of `/api/app/`.

The **Website domain** pane is one field for `manifest.domain`:
`app-manager.normalizeDomain` (bare hostname or null; a pasted scheme or
trailing slash is dropped, anything else refused) is what `setAppConfig`
stores. Disabled with a one-line reason at level private. Under it, from
`accessInfo`: `websiteUrl` (where `https://<domain>/` lands) and `nginx`
(`nginxSnippet`: `/` → `/apps/<n>/` on this host's `dashboardPort`, forwarded
host/proto, `proxy_buffering off`). **Check** is `app:checkDomain` →
`checkDomain(name, domain?)`: DNS, then `https://<domain>/` with one redirect
followed; `ok` means the platform's relative root 302 to the root target and a
2xx after it, else `dns` / `unreachable` / `not-here` / `loop` (`reachable`
for an open app, which has no redirect to recognise). On a master the pane
lists each slave running the app with the domain it reports
(`federation.md`). The mini-app URL never follows the domain. Tests:
`test/access-info.test.js`.

## App licensing: provider

The app-facing surface is stable: manifest `auth.license`, `ctx.license.*`,
`/api/auth/license/{claim,release,products}`, `/api/auth/me.license`, the route
gate, the surface-kit "Plans" block, and the `subscribed` principal for spend.
Its backend is a **provider slot** in `src/apps/app-license.js`
(`setProvider(p)` / `getProvider()`); no code path here makes a network call.

**No provider (the default today)**: the owner is always entitled
(`ownerEntitlement`, every declared tier merged); everyone else gets the free
tier (`freeEntitlement`: `auth.license.free`, or none, so a non-freemium app
answers 402 `license_required`). `claim` returns `licensing_unavailable`
(`POST /api/auth/license/claim` answers 503), `ctx.license.validate` returns
`{ valid: false, error: 'licensing_unavailable' }`, `products` returns
`{ product, variants: [] }` (the Plans block stays hidden), `release` drops
`accounts.license_key` and returns ok, and `subscribedFromCache` is false.
Stored `accounts.license_key` values are never touched, so a later provider
can honour them.

**Provider shape** (in-process platform code; any method may be async, a throw
or timeout reads as "unreachable"):

```js
setProvider({
  validate(key, { product, machineId? }),   // -> { valid, error?, license: { expiresAt }, product: { slug }, customerPortalUrl? }
  activate(key, { product, seat }),         // -> same shape; seat = { machineId, hostname, username }
  deactivate(key, { seat }),                // best-effort
  products(product),                        // -> variants[] | { variants[] }: { slug, name, licenseType, durationDays, machineLimit, checkoutUrl }
});
```

Error codes a provider returns in `error`: `seat_not_activated` (validate with
a machineId that holds no seat; the platform activates once and retries),
`machine_limit` (no seat left; surfaced to the app as `machine_limit`), any
other string is passed through. With a provider the entitlement cache stays:
`licenseCacheTtlMinutes` (default 30) freshness, `licenseGraceHours` (default
72) of access after the provider becomes unreachable. A seat is
`vc:<app>:acct:<accountId>`. There is no setting for a URL: App licensing is
to be recoded later as a vc app that installs itself as the provider.
Tests: `test/app-license-provider.test.js`.

## Platform extras & toolchains

The Setup → Extras components and the toolchains apps shell out to are in
`extras.md`.

## Changing and creating apps

A change or new-app request opens ONE interactive Claude Code session cwd'd to
the app directory — the launcher, the generated prompt, the `.vistaclair/`
sidecars and the read ledger are in `sessions.md`; cross-app change requests
are in `change-requests.md`.

## App tools, the MCP broker and artifacts

How app tools reach AIs outside the app — the MCP broker, the
`authorizeToolCall` choke point, tool grants for orchestration runs, and the
artifact store tools hand files out through — is in `app-tools.md` and
`tool-jobs-artifacts.md`.

## Content-Security-Policy of the client modules

The `clientModules` (`apps.js` and the files listed in `index.js`) run inside
the core dashboard page, under core's policy (`src/csp.js`): script only from
`'self'`, no inline script, no `on*=` attribute, no eval.

- Generated markup binds actions with `vcAct.attrs(event, 'path.to.fn', [args],
  { stop, prevent })`, defined at the top of `public/apps.js` (first in the
  module list, guarded by `if (window.vcAct)`): `data-vc-<event>`
  attributes and one delegated capture listener per event (click, input,
  change, mouseenter, mouseleave). Args are JSON; `{ $: 'this' | 'value' |
  'checked' | 'event' }` stands for the element, its value, its checked state
  or the event. A missing path is a no-op. `vcAct.copyText` and
  `vcAct.removeAncestor` are the two stock actions.
- `app-launcher.html` keeps its inline script: the public launcher has no
  owner cookie, so an external script would need an auth-exempt entry, and
  core sends no policy on `/pro` pages. Monaco loads from core's
  `/vendor/monaco-editor-*`.
- Version skew: a running server keeps the old `index.js` (module list,
  auth-exempt paths) in memory but serves `public/` from disk. A change under
  `public/` must therefore work with the previous descriptor: no new client
  module, no new exempt path, no new WS message it cannot live without
  (`test/security-csp.test.js` loads the modules in the old and the new order).
- `test/security-csp.test.js` scans `public/` for inline handlers, inline
  script, `javascript:` URLs, eval and CDN loads.
- The descriptor's `cspReady` is `true` only with `VISTACLAIR_PRO_CSP_READY=1`
  in the server's environment (restart to change). Until then core keeps the
  policy report-only while Pro is loaded.
- `/pro/*` pages are answered by the add-on router, where core sends no policy
  (`dropForAddons`); `vista/` and `tg-session/` load Telegram's WebApp SDK from
  `https://telegram.org`, which a policy there would need in `script-src`.

## Not built

- A per-app origin for users-level apps: the Telegram Mini App URL
  (`telegram.js` `webAppUrl` / `entryUrl`) would have to follow the app origin.
