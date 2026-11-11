# Serving apps from their own origin — design

Status: design only, for the owner's decision. Nothing here is built yet.
Date: 2026-11-11.

## Why this exists

Vistaclair apps (the separate repo `vistaclair-apps`, mounted by the Pro
plugin) are served under `/apps/<name>/` on the **same web origin** as the
owner dashboard. In a browser, "same origin" means "same trust". Any script
that runs inside an app page — the owner's own app code, a library it pulls
in, or an attacker who found an injection flaw in it — can do everything the
owner can do in the dashboard:

- call every dashboard API with the owner's cookie, which the browser attaches
  on its own;
- open the dashboard WebSocket and send `cli:spawn` (a shell or Claude Code in
  any folder), `cli:input` (keystrokes into a terminal) or `sdk:send` (a prompt
  to an agent with tools) — core `src/ws/cli-handler.js:115`, `:137`, `:369`;
- reach into the dashboard window itself, since same-origin windows can read
  and script each other.

Other fixes in this run close the paths an **outsider** could use (sandbox
headers on uploaded files, an Origin check on the WebSocket and on cookie
posts, a real content security policy for `/pro` pages). None of them can
stop script that is same-origin by construction. Only moving app pages to a
different origin does that.

### Threat model in one paragraph

The adversary is **script running in an app page in the owner's browser**.
The goal is that such script can reach its own app's API and the platform
features the app was meant to use, and nothing else: no dashboard API, no
dashboard WebSocket, no other app's data. Out of scope: the app's
**server-side** code. An in-process app runs inside the dashboard's Node
process and an own-process app is spawned by it; isolating server-side app
code is a separate project (see "Related server-side gaps" at the end).

### Terms

- **Origin**: scheme + host + port, e.g. `https://dash.example.com`. Two
  pages share trust only when all three match.
- **Site**: scheme + registrable domain, e.g. `example.com`. Cookies with
  `SameSite=Lax` are sent on requests between different origins of the same
  site (`apps.example.com` → `example.com`). Cookies also ignore ports.
- **Dashboard origin**: where the owner logs in today (e.g.
  `http://localhost:3457`, the ngrok domain, or the server's domain).
- **Apps origin**: the new place app pages would be served from.

---

## 1. Inventory: how app pages depend on the dashboard origin today

File references are relative to each repo: **core** = `/home/hp/vistaclair`,
**pro** = `vistaclair-pro`, **apps** = `vistaclair-apps`. Line numbers are
from `main` on 2026-11-11.

### 1.1 Owner credentials and what guards them

| What | Where |
|---|---|
| Owner is decided once, in one place: loopback + internal header, a `sid` session cookie, the static `token` cookie, or `Authorization: Bearer <token>` | core `src/auth.js:1-14`, `:102-120` |
| Cookies are `HttpOnly; SameSite=Lax; Path=/`, `Secure` only in server mode, **no `Domain`** (host-only, but port-blind) | core `server.js:164-166` |
| Cookie-authenticated **mutating** requests must carry an Origin equal to the host they were sent to (new in this run) | core `src/auth.js:49-76`, `:114-120` |
| WebSocket upgrades must carry a matching Origin (new in this run) | core `src/addons.js:149-183` |
| `GET`/`HEAD` requests with a cookie are **not** Origin-checked (by design) | core `src/auth.js:78`, `:117` |
| The rescue server repeats the same cookie logic | core `bin/supervisor.js` (`isOwner`, `authCookie`) |
| One-time login links already exist (`/login/once?k=`, minted only from the host itself) | core `src/login-routes.js:73-79`, `:166-170` |

What this means: today an app page needs nothing special to act as the owner.
Its requests are same-origin, so the browser attaches `sid`/`token`, and the
Origin checks pass because the Origin *is* the dashboard.

### 1.2 How apps are served

| What | Where |
|---|---|
| Pro mounts one router after core's auth gate; `/pro` static, then `/apps` | pro `index.js:140-153`, core `server.js:318`, `:460-461` |
| `/apps/<name>/` is behind the owner gate unless a manifest declares a public surface; exemptions are built from manifests | pro `index.js:432-442`, `src/apps/surfaces.js:279-297`, core `src/addons.js` (`isAuthExempt`) |
| Every `/apps/*` response: drops `Set-Cookie` for `sid`/`token`, adds `nosniff` and `frame-ancestors 'self' https://web.telegram.org; base-uri 'self'` | pro `src/apps/app-headers.js:1-16`, `:51-62` |
| Core's dashboard CSP is deliberately **not** applied under `/apps/` | core `src/csp.js:10`, `:77-79`, `:90` |
| In-process apps: a router per app inside the dashboard process; static `public/` last | pro `index.js:53-58`, `src/apps/app-manager.js:831-913` |
| Own-process apps: proxied to a loopback port; the proxy strips `cookie`, `authorization` and every `x-vistaclair-*` header | pro `index.js:14-39`, `src/apps/internal-headers.js` |
| The own-process runner already mounts the app at both `/apps/<n>` and `/` | pro `app-runner.js:189-190` |
| Only `my-desktop` is own-process in the apps repo (manifest `runtime`) | apps `my-desktop` manifest; pro `src/apps/app-manager.js:79-100` |

### 1.3 Embedding: iframe, new tab, or both

**Both, and always as an iframe of `/apps/<name>/`.**

| What | Where |
|---|---|
| Apps tab: `<iframe src="/apps/<name>/" data-app-iframe="<name>">` with no `sandbox` attribute; `allow=` only for microphone/camera | pro `public/apps.js:1666-1667`, `:1752-1764` |
| Reload / re-point after start/stop sets `iframe.src = '/apps/<name>/'` | pro `public/apps.js:5101-5103`, `:5131-5132` |
| `display: fullscreen` apps open a new tab on `/pro/app-launcher.html?app=<name>`, which itself frames `/apps/<name>/` | pro `public/apps.js:2356`, `public/app-launcher.html:40`, `:63` |
| The launcher page opens the **owner WebSocket** itself and, if that works, loads the bridge relay; otherwise it runs "REST-only" for public visitors | pro `public/app-launcher.html:93-130` |
| Dashboard CSP allows framing only `'self'` (plus the payment provider) | core `src/csp.js:59-60` |
| App responses allow being framed only by `'self'` and Telegram | pro `src/apps/app-headers.js:16` |
| Custom-domain apps (`pixachat.com`) are opened by visitors directly, not framed; nginx maps `/` onto `/apps/<n>/` | pro `src/apps/app-manager.js:418-426`, `:520-537` |

### 1.4 The bridge (how apps reach platform features)

The bridge is **already a postMessage bridge**, which matters a lot for the
options below.

| What | Where |
|---|---|
| App side: `Bridge.call()` posts `{type:'bridge', id, method, params}` to `window.parent` with target `'*'` | pro `public/app-runtime.js:14-29` |
| App side listeners check neither `e.origin` nor `e.source` | pro `public/app-runtime.js:46-56` |
| Dashboard side: the relay finds the sending frame by window identity (`iframe.contentWindow === e.source`) and takes the app name from the iframe's `data-app-iframe`, never from the message | pro `public/app-bridge-client.js:12-17`, `:41-45` |
| The relay forwards over the owner WebSocket as `app:bridge` | pro `public/app-bridge-client.js:55-61` |
| Replies and events go back with `postMessage(..., window.location.origin)` — **silently dropped if the frame is on another origin** | pro `public/app-bridge-client.js:6`, `:75-79`, `:89-93` |
| Same pattern in the overlay host and model picker | pro `public/app-overlays.js:14`, `:26`, `:358`, `:401`; `public/app-model-picker.js:15`, `:54` |
| Server side runs every bridge call as the owner | pro `src/apps/index.js:1251`, `src/apps/app-bridge.js:41-82` |
| The bridge is **open-world**: declared capabilities are "advertisements, not gates" | pro `src/apps/app-bridge.js:7-10` |
| Bridge method `cli.edit` launches a Claude Code change session for the app | pro `src/apps/capabilities/cli.js:14`, `src/apps/index.js:1251-1300` |

Consequence: after any origin split, the bridge becomes the *only* way from
app script to owner power. It must then be narrowed (stage 5 below).

### 1.5 What app pages load and call

| What | Where |
|---|---|
| Scaffold: `/pro/app-runtime.js`, `/pro/vc.js` | pro `src/apps/app-manager.js:264-265` |
| Also used: `/pro/app-auth.js`, `/pro/app-theme.css`, `/pro/apps.css`, `/pro/app-overlays.js`, `/pro/marked.min.js`, `/pro/purify.min.js` | pro `index.js:512` (`authExemptPaths`) |
| `/pro/app-runtime.js` and `/pro/vc*.js` are **not** auth-exempt — a cookieless page cannot load them | pro `index.js:151`, `:512` |
| `apiFetch` uses relative `api/...` paths and adds `Authorization: Bearer <app-user token>` from localStorage | pro `public/app-runtime.js:327-358` |
| Custom-domain apps already avoid `/pro/*` and re-serve shared assets themselves | apps `pixachat/routes.js:645-700`, `pixachat/public/app/boot.js:3`, `my-gym/public/app.html:8`, `mt4/public/app.html:7`, `vidat/public/client/client.js:7` |

Per-app details: see 1.9.

### 1.6 App-user logins, public surfaces, Telegram

| What | Where |
|---|---|
| App-user sessions use **no cookie**: a signed token in localStorage, sent as a Bearer header | pro `src/apps/app-identity.js:21-28`, `:154-182`; `public/app-runtime.js:335-342`; `public/app-auth.js:37-38` |
| Telegram Mini App pages send `X-Telegram-Init-Data` | pro `src/apps/app-identity.js:65-93`, `src/apps/capabilities/identity.js:44-56` |
| If no app-user credential is present, a valid **owner cookie** maps to the app's owner account | pro `src/apps/capabilities/identity.js:57-70`, `src/apps/app-auth.js:152-157` |
| Users-level apps deny `/api/*` by default except auth and declared public API | pro `src/apps/app-auth.js:13`, `:384` |
| Telegram `web_app` button URL is built from the platform public URL (or the custom domain) | pro `src/apps/telegram.js:489-503` |
| Email verification links are built from the request's forwarded host | pro `src/apps/app-auth.js:408-410` |
| The platform already warns that one app on two origins has two separate sessions | pro `src/apps/app-manager.js:462-467` |
| Platform Mini Apps (`/pro/tg-session`, `/pro/vista`) use their own per-mount bearer headers, not the owner cookie | pro `public/tg-session/tg-session.js:59-60`, `public/vista/vista.js:32-33` |

### 1.7 Service workers and storage

| What | Where |
|---|---|
| The dashboard registers `/sw.js` with scope `/`, which covers `/apps/*`; it claims open pages immediately | core `public/mobile.js:16`, `public/sw.js:10`, `:16`; it only touches Google Fonts requests (`:20`) |
| The PWA manifest has scope `/` | core `public/manifest.webmanifest`, `public/index.html:12` |
| `vr-moritz` registers its own worker under its app path | apps `vr-moritz/client/src/swreg.js:44` |
| Nothing strips a `Service-Worker-Allowed` response header from `/apps/*`, so an app route could widen its worker's scope to `/` and sit in front of the dashboard | pro `src/apps/app-headers.js:51-62` (no such rule) |
| localStorage is one store per origin, shared by the dashboard and every app: `vista:identity:<app>`, `va.<app>.session`, `gymi.token`, and dashboard keys such as `vc.apps.view` | pro `public/app-runtime.js:335`, `public/app-auth.js:37`, `public/apps.js:316` |

### 1.8 Deployment shapes as found in code

| Shape | What the code assumes | Where |
|---|---|---|
| (a) Owner's machine: `localhost:3457` plus one ngrok domain | Dashboard on 3457 (3456 is the model proxy, loopback only); trust proxy = loopback; no ngrok or nginx config in the repo | core `server.js:111-113`, `:149`, `:585-586`; `src/port-cleanup.js` |
| (b) Deployed host behind nginx, real domain, optional per-app domains | Custom domain = an nginx block mapping `/` to `/apps/<n>/` on the dashboard port; no Host-based routing in code | pro `src/apps/app-manager.js:520-537` |
| (c) Slaves managed by a master | The master opens a slave's **own** dashboard with a one-time login link; it does not frame slave apps | pro `docs/federation.md:25-32` |
| Google OAuth callback is hard-wired to `http://localhost:<port>/pro/auth/google/callback` | — | pro `src/apps/google-api.js:15-22` |
| No setting for a separate apps host or port exists anywhere | — | searched core and pro |

### 1.9 Per-app inventory

How each app in `vistaclair-apps` depends on the dashboard origin. "Level"
comes from the manifest `auth`/`surfaces` blocks (a login method set to
`false` does not count). Every app loads `/pro/app-runtime.js`; the other
`/pro` files are listed. All API calls found go to the app's **own**
`/apps/<name>/api` — through `apiFetch` or a helper that strips the leading
slash (e.g. apps `my-dashboard/public/app.js:286-287`,
`my-shodan/public/app.js:1-5`) — so no app calls a dashboard API by design.

| App | Level, runtime | Other `/pro` assets | Origin-sensitive code | Effect of a split |
|---|---|---|---|---|
| db-admin | private, in-process | `app-theme.css`, `marked`, `purify`, `vc-chat-log`, `vc-input-bar` | — | assets must be served on the apps origin |
| gymihorst | users (Telegram, licence) | `app-theme.css`, `vc.js` | localStorage token `gymi.token` | one re-login per browser |
| minecraft-server | users (Telegram) | `app-theme.css`, `vc.js` | — | none beyond assets |
| mt4 | users (Telegram) | `app-theme.css`, `vc.js` | localStorage (3 uses) | stored values reset |
| my-blender | private | `app-theme.css`, `vc.js` | — | none beyond assets |
| my-blog | private | `vc-chat-log`, `vc-empty-state`, `vc-input-bar` | posts to its **own** preview iframe (`my-blog/public/app.js:636`, `:707`); localStorage | none |
| my-cams | private | `app-theme.css`, `vc.js` | — | none beyond assets |
| my-dashboard | private | `vc-chat-log`, `vc-empty-state`, `vc-input-bar`, `vc-progress` | — | none beyond assets |
| my-desktop | private, **own-process** | `app-theme.css` | — | none; already behind the credential-stripping proxy |
| my-gym | users (Telegram) | `app-theme.css` | localStorage (3 uses) | stored values reset |
| my-podcast | users (Telegram) + public `share.html` and public API | `app-theme.css`, `vc-dialog`, `vc-empty-state`, `vc-input-bar`, `vc-model-picker`, `vc-progress` | — | public share links must point at the apps origin |
| my-shodan | private | `app-theme.css` | **opens `wss://<host>/ws` when `Bridge` is missing** (`my-shodan/public/app.js:1087-1088`, `:1112-1115`); the dashboard accepts upgrades on any path (core `src/addons.js:188`), so on the dashboard origin this is the owner WebSocket | the fallback stops working (intended); live updates must come through `Bridge.subscribe` only |
| my-superproxy | private | — | localStorage/sessionStorage (18 uses) | stored values reset |
| my-whisperer | private | `app-theme.css`, `vc-empty-state` | localStorage (11 uses) | stored values reset |
| pixachat | users (Telegram, WhatsApp, email), fullscreen, **own domain `pixachat.com`** | `app-auth.js`, `app-theme.css`, `vc.js`, `katex`, `marked`, `purify` on the platform path; re-served by the app itself on its domain (`pixachat/routes.js:645-700`) | **reads the dashboard's DOM**: `window.parent.document.querySelectorAll(...)` to detect the overlay host (`pixachat/public/app.js:46-49`, in a `try`); localStorage (16 uses) | on its own domain: unchanged. Inside the dashboard: the DOM read throws, the `catch` takes the existing fallback (in-frame confirm). No change needed in the app |
| trip-planner | private | `vc.js` | — | none beyond assets |
| vidat | private + public `client.html` | `app-theme.css`, `vc.js` | — | public client links must point at the apps origin |
| vr-moritz | private; the VR client is served by its own game-server child at its own root (`vr-moritz/client/src/base.js:1-12`) | `app-theme.css`, `vc.js` | own service worker and WebSocket relative to that root (`client/src/swreg.js:44`, `client/src/net.js:41-43`); localStorage (38 uses) | the game client is not on the dashboard origin; only its `public/` panel moves |

Summary:

- No app needs a dashboard API. Two apps reach past their frame today:
  **my-shodan** (fallback WebSocket to the dashboard) and **pixachat** (reads
  the parent page's DOM). Both already tolerate losing that.
- The shared assets the apps origin must serve: `app-runtime.js`,
  `app-auth.js`, `app-theme.css`, `vc.js` and the `vc-*.js` components,
  `marked`, `purify`, `katex`.
- Eight apps keep values in browser storage; those reset once.

---

## 2. Options

Each option is judged against the same questions: what it stops, what
breaks, what the owner must provide, how it behaves in shapes (a), (b) and
(c), and the effort in worker-days (one worker-day = one worker session with
tests, not counting owner testing).

A fact that shapes every option: **the Origin checks landed in this run are a
precondition.** An apps origin on a sibling name (`apps.example.com` next to
`example.com`) or on a second port is *same-site*, so the browser still
attaches the dashboard's `SameSite=Lax` cookie when app script sends a
request to the dashboard. What stops that request today is the Origin check
(core `src/auth.js:114-120`, `src/addons.js:180`): a cookie post or a
WebSocket from the apps origin names the wrong Origin and is refused. A
cookie `GET` is still answered, but app script cannot *read* the answer (no
CORS), so a `GET` only matters if it changes something. Every option below
therefore also needs "dashboard `GET` routes have no side effects" to hold
(interim item I4).

### Option A — one second origin for all apps

Serve every app at `https://apps.<domain>/apps/<name>/` (deployed) or
`http://localhost:3458/apps/<name>/` (owner's machine). The dashboard frames
that URL instead of `/apps/<name>/`.

How it works:

- The same Vistaclair process answers on the apps host (by Host header) or a
  second port. On the apps origin it serves only `/apps/*`, the few shared
  app assets (`/pro/app-runtime.js`, `vc*.js`, theme CSS) and a pass
  handshake. Everything else (`/`, `/api/*`, the WebSocket) answers 404 there.
- Core refuses the owner cookie and token on the apps origin — a request
  addressed to the apps host is never "the owner" through `sid`/`token`.
- Owner-private apps still need to know "this is the owner". The dashboard
  mints a short-lived one-time code (the same mechanism as `/login/once`) and
  the app frame redeems it on the apps origin for an **apps pass**: an
  HttpOnly cookie valid only on the apps origin, only for `/apps/*`, and
  refused by every dashboard route and the WebSocket.
- The bridge keeps working: the relay already identifies frames by window
  identity; replies must target the apps origin instead of its own, and the
  relay must also check `e.origin`.

Protects against: app script reaching any dashboard API, the dashboard
WebSocket, or the dashboard window; app script reading dashboard storage;
an app installing a service worker in front of the dashboard.

Does **not** protect against: one app's script calling another app's API
with the apps pass, or reading another app's localStorage (all apps share the
apps origin). The bridge remains a channel to owner power until it is
narrowed (stage 5).

What breaks:

- Every user's stored app-user login (localStorage moves with the origin) —
  one re-login per app per browser.
- Pages that load `/pro/*` assets other than the handful re-served on the
  apps origin.
- App code that reaches past its frame: my-shodan's fallback WebSocket and
  pixachat's read of the parent page (1.9). Both already have a fallback.
- Telegram Mini App and email-verification links must use the apps origin;
  the Telegram Login Widget, if used, is bound to one domain per bot.
- Dashboard CSP `frame-src` and app `frame-ancestors` must name the other
  origin.
- The Google OAuth redirect is unaffected (it is a dashboard route).

Owner must provide:

| Shape | Needs |
|---|---|
| (a) local | Nothing for `localhost`: a second port (e.g. 3458) is a separate origin. For remote use through ngrok, a **second ngrok domain** (or another tunnel with its own name). |
| (b) nginx | A DNS name `apps.<domain>` (or wildcard), a certificate for it (certbot), and one nginx server block. Custom-domain apps such as `pixachat.com` are already on their own origin and need nothing. |
| (c) slaves | The same as (b) on each slave that serves owner-private apps. The master is unaffected: it opens a slave's own dashboard and never frames slave apps. |

Without a second name in shape (a)-remote, the remote dashboard can keep the
old same-origin mode for apps with a visible warning, or not offer apps
remotely; that is an owner decision (Q2).

**Same site or not matters for the apps pass.** The pass is a cookie set
inside a frame. If the dashboard and the apps origin are the same *site*
(`localhost:3457` and `localhost:3458`; `dash.example.com` and
`apps.example.com`), it is an ordinary first-party cookie and just works. If
they are different sites — two unrelated tunnel names, for example two names
under ngrok's shared domains, which as far as we know are listed as public
suffixes — the pass is a third-party cookie inside the frame, which Safari
blocks and other browsers increasingly restrict. Then the pass must be a
`SameSite=None; Secure; Partitioned` cookie (supported unevenly, to be tested
in stage 4) or the fullscreen launcher must open the app top-level. The
simple rule for the owner: **put both names under one domain you own.**

Effort: **8–10 worker-days** (core host gate and apps pass 3, pro serving,
framing, relay and CSP changes 3, Telegram/links/accessInfo 1, tests 1.5,
per-app fixes and browser testing 0.5–1.5).

### Option B — one origin per app

Like A, but each app gets its own host: `https://<name>.apps.<domain>/` or
`http://<name>.localhost:3457/` locally (browsers resolve `*.localhost` to
the machine itself; Chrome and Firefox do, Safari's behaviour should be
checked).

Protects against: everything A does, **plus** one app's script reaching
another app's API, pass or storage. This is the end state custom-domain apps
(`pixachat.com`) already have.

What breaks: everything in A, plus apps that read each other's pages or
assets by relative URL, plus the Host-based routing being needed for every
app (the runner already serves at `/`, pro `app-runner.js:189-190`, which
helps).

Owner must provide:

| Shape | Needs |
|---|---|
| (a) local | Nothing for `localhost`. Remotely a **wildcard** tunnel name, which ngrok offers only on paid plans as far as we know (owner to confirm). |
| (b) nginx | A wildcard DNS record `*.apps.<domain>` and a wildcard certificate (DNS-01 challenge, i.e. API access to the DNS provider). |
| (c) slaves | The same per slave. |

Effort: **12–15 worker-days** (A plus Host-based routing for every app, a pass
per app, per-app URL generation everywhere, wildcard-aware tooling and docs).

### Option C — sandboxed iframe with an opaque origin

Keep the URL `/apps/<name>/`, but send every app response with
`Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups ...`
(never `allow-same-origin`). The header, not just an iframe attribute, is
needed so a page opened directly is sandboxed too. The page then has an
opaque ("null") origin: it shares nothing with anyone.

Protects against: everything B does, with no DNS or tunnel at all.

What breaks — a lot, in every app:

- No cookies are sent on the page's own requests, so owner-private app APIs
  lose the owner; each call needs a token handed in through the bridge.
- `fetch` to the app's own API becomes a cross-origin request from `null`;
  the server has to answer CORS for origin `null`, which any other sandboxed
  page on the internet can also claim — so the token must carry all the
  weight.
- `localStorage`, `sessionStorage`, IndexedDB and service workers throw:
  app-user logins, `vr-moritz`'s worker and every stored setting break unless
  the bridge offers storage.
- Microphone/camera permission prompts, clipboard, downloads and popups
  behave differently in opaque origins and need per-browser testing.
- The Telegram Mini App SDK and OAuth popups need checking.

Owner must provide: nothing.

Shapes: identical in (a), (b) and (c) — its one real advantage.

Effort: **15–20 worker-days**, most of it per-app rewrites and browser
testing, plus a storage bridge. High risk of quiet breakage.

### Option D — keep one origin, give app pages a narrow credential

Idea: the owner cookie is never sent to `/apps`, app pages get their own
scoped credential.

This **does not work** against hostile script, and the design rejects it:

- A cookie's `Path` is matched against the URL of the *request*, not the
  page that makes it. Script on `/apps/x/` can `fetch('/api/...')` and the
  browser attaches a `Path=/api` cookie anyway.
- The server cannot tell such a request from a dashboard one: `Origin` and
  `Sec-Fetch-Site` are both "same-origin", and script can suppress `Referer`.
- Same-origin script can open or frame the dashboard and script it directly.

What it would still buy: an app no longer *accidentally* depends on the owner
cookie, which is a useful preparation step and is part of stage 2 below.

Effort: 2–3 worker-days. Protection against the stated threat: none.

### Comparison

| | A: one apps origin | B: origin per app | C: opaque sandbox | D: scoped cookie |
|---|---|---|---|---|
| Stops app → dashboard | yes | yes | yes | **no** |
| Stops app → other app | no | yes | yes | no |
| Owner provides | 1 name + cert (or a port locally) | wildcard name + wildcard cert | nothing | nothing |
| Breaks | stored app logins, a few assets | A + per-app URLs | storage, cookies, SW, CORS in every app | nothing |
| Effort (worker-days) | 8–10 | 12–15 | 15–20 | 2–3 |

---

## 3. Recommendation and staged migration

**Recommendation: Option A now, built so that Option B is a configuration
change later.** It removes owner reach from every app page for one DNS name,
reuses the postMessage bridge that already exists, and keeps app storage,
cookies and service workers working. Custom-domain apps already are Option B
and stay as they are. Option C is kept only as a fallback for shape (a)
remote when the owner has no second tunnel name (Q2).

The design is per-origin, not per-app-name, so the same code serves
`apps.<domain>` (A) and later `<name>.apps.<domain>` (B): the apps pass, the
host gate and the relay's origin check all take "the expected origin of app
X" from one function.

Every stage below lands on its own, is behind a setting until stage 6, and is
rolled back by turning the setting off (or reverting its commit). Stages 1
and 2 change nothing visible.

### Stage 1 — the apps host exists, serving nothing private (core + pro, 2 days)

- New setting `appsOrigin` (empty = today's behaviour). Locally a second
  listener on a port (default 3458); deployed, a Host name.
- On the apps origin: only `/apps/*`, the shared app assets, and
  `/__apps-pass`. Everything else is 404. `sid`, `token` and Bearer
  `AUTH_TOKEN` are never accepted there, and the internal header is not
  either.
- On the dashboard origin nothing changes yet.
- Objective check: new core tests — on the apps host `/api/sessions` with a
  valid `sid` cookie → 404; `/` → 404; WebSocket upgrade → refused; a public
  surface (`/apps/<n>/app.html`) → 200 anonymously; an owner-private app →
  403 without a pass. Existing `npm test` in core and pro passes.
- Owner test: none needed (setting off by default). Optional: set it, open
  `http://localhost:3458/` and see a 404.
- Rollback: unset `appsOrigin`.

### Stage 2 — the apps pass (core + pro, 2 days)

- `POST /api/apps-pass` (dashboard origin, owner only, Origin-checked) mints
  a one-time code, 60 seconds, single use, bound to the apps origin.
- `GET <appsOrigin>/__apps-pass?code=…&next=/apps/<n>/` redeems it, sets
  an apps-pass cookie (HttpOnly, SameSite=Lax, Path=/, 30-day expiry,
  revocable from the sessions list; on HTTPS named with the `__Host-`
  prefix and `Secure`; for a cross-site pair see Option A) and redirects to `next`
  (only paths under `/apps/`).
- Pro's owner decision for `/apps/*` (`ctx.isOwnerRequest`, and the
  identity fallback in `capabilities/identity.js:57-70`) accepts the pass on
  the apps origin and nothing else there.
- Objective check: tests — a pass works on the apps origin for `/apps/<n>/api`;
  the same cookie value sent to the dashboard origin's `/api/*` and
  WebSocket is refused; a code works once; an expired code fails; `next`
  outside `/apps/` is refused.
- Owner test: none (still off).
- Rollback: revert; nothing uses it yet.

### Stage 3 — the bridge works across origins (pro, 1.5 days)

- `app-bridge-client.js`, `app-overlays.js`, `app-model-picker.js` and the
  launcher's toast shim post to the frame's expected origin instead of
  `window.location.origin`, and drop messages whose `e.origin` is not that
  origin.
- `app-runtime.js` remembers the parent's origin from the first reply and
  ignores messages from other origins; it keeps posting with `'*'` only for
  the very first call (the parent's origin is not known before that) — or
  receives it in the URL fragment set by the dashboard.
- Objective check: a new browser-free test with two fake windows (or a
  Playwright test if the repo's e2e is used) — a bridge call from a frame on
  another origin gets its reply; a message from a foreign origin is ignored.
- Owner test: none yet (same-origin still works, since expected origin =
  dashboard origin while `appsOrigin` is off).
- Rollback: revert.

### Stage 4 — frame apps from the apps origin (pro + core CSP, 1.5 days)

- With `appsOrigin` set, the Apps tab and the launcher frame
  `<appsOrigin>/__apps-pass?code=…&next=/apps/<n>/` for owner-private apps
  and `<appsOrigin>/apps/<n>/` for public ones.
- Dashboard CSP `frame-src` adds the apps origin; app `frame-ancestors`
  becomes the dashboard origin plus Telegram.
- Telegram `web_app` URLs, email verification links and `accessInfo` use the
  apps origin when set.
- The dashboard origin answers `/apps/<n>/` with a redirect to the apps
  origin (so old links work) — except for custom-domain traffic, which is
  unchanged.
- Objective check: tests for the URL builders and CSP strings; e2e — open
  the Apps tab with the setting on and assert the frame's URL is on the apps
  origin and a bridge call (e.g. `showToast`) round-trips.
- **Owner test**: on the owner's machine, set `appsOrigin` to port 3458,
  open three apps the owner uses daily from the Apps tab and one fullscreen
  app; check they load, save, and that AI calls and toasts work; log in once
  to one users-level app. Then the same through the second tunnel name.
- Rollback: unset `appsOrigin` — the frames go back to `/apps/<n>/`.

### Stage 5 — narrow the bridge (pro, 2 days)

- The bridge stops being open-world for app frames: a method is allowed only
  if the app's manifest declares the capability it belongs to
  (`capabilities.gatingCapabilityForMethod`, pro `src/apps/app-bridge.js:36`).
  `cli.*` methods additionally need an owner confirmation in the dashboard.
- A log-only week first: record undeclared calls per app, then enforce.
- Objective check: tests — an undeclared method is refused with a clear
  error; a declared one works; `cli.edit` without confirmation is refused.
- Owner test: open each daily-use app and check the Runtime errors card shows
  no refusals; fix manifests where it does.
- Rollback: a setting returns to log-only.

### Stage 6 — make it the default (1 day, mostly docs and app fixes)

- `appsOrigin` defaults to `localhost:3458` locally; deployed hosts get the
  nginx block and setup wizard text.
- The same-origin mode remains available only behind an explicit
  "unsafe: apps share the dashboard origin" setting, shown as a warning.
- Remove my-shodan's fallback WebSocket (1.9) and add an app-lint rule that
  flags `/pro/` assets outside the shared set, `window.parent.document` and
  WebSockets to the page host's root.
- Objective check: core and pro `npm test`; `npm run lint:app` (pro) passes
  for every app.
- Owner test: a full day of normal use, then confirm no app is stuck.
- Rollback: set the default back to empty.

### Later — Option B

Turn `appsOrigin` into a pattern (`{name}.apps.<domain>`). Needs the wildcard
name and certificate (Q4). Estimated 4–5 more days.

**Total for A (stages 1–6): about 10 worker-days**, plus owner test time at
stages 4, 5 and 6.

---

## 4. Interim mitigations (cheap, independent of the move)

Each is small, lands alone and helps whether or not the move happens.

| # | Mitigation | Why | Effort |
|---|---|---|---|
| I1 | Drop the `Service-Worker-Allowed` header from every `/apps/*` response (pro `src/apps/app-headers.js`, beside the cookie rule) | Without it, an app route can register a worker with scope `/` that sits in front of the dashboard and survives the app's removal | 0.25 day |
| I2 | Make the dashboard's own `sw.js` ignore `/apps/*` explicitly and keep its scope `/` | Keeps the dashboard worker from ever caching or touching app responses (today it only touches fonts, core `public/sw.js:20`) | 0.25 day |
| I3 | Strip `cookie` and `authorization` from in-process app requests once the owner decision is taken, as the own-process proxy already does (pro `index.js:53-58` vs `:16-17`) | Today in-process `routes.js` code can read the owner's static token from the cookie header | 0.5 day |
| I4 | Audit dashboard `GET` routes for side effects and move any to `POST` | `GET` is not Origin-checked; after the split it is the one request a same-site page can still make with the owner cookie | 1 day |
| I5 | Relay hardening now: `app-bridge-client.js` drops messages whose `e.origin` is not the expected app origin; `app-runtime.js` ignores messages from anything but its parent | Costs nothing today and is stage 3's first half | 0.5 day |
| I6 | Bridge log-only mode: record undeclared method calls per app (stage 5's first half) | Gives the owner the data for Q5 before anything breaks | 0.5 day |
| I7 | Dashboard warning when an app page is opened top-level on the dashboard origin outside a frame (e.g. a shared link) | Makes the risk visible; frames are the expected path | 0.25 day |

None of these closes the main hole: same-origin script can still call
`/api/*` and open the WebSocket. Only the move does.

---

## 5. Open questions for the owner

| # | Question | Recommended answer |
|---|---|---|
| Q1 | Which option? | **A now (one apps origin), B later** as a setting. |
| Q2 | On your own machine through ngrok, apps need a second tunnel name to be used remotely on a separate origin. Will you add one, or should remote use of apps keep the old same-origin mode with a warning, or should apps not be offered remotely? | **Add a second tunnel name under a domain you own** (e.g. `dash.<you>` and `apps.<you>`), so the two are the same site; check what your ngrok plan allows. Until then, keep same-origin mode remotely with a warning; `localhost` gets the separate port at no cost. |
| Q3 | On deployed hosts, which name: `apps.<domain>` or something else? | **`apps.<domain>`**, one DNS record and one certificate per host. |
| Q4 | Do you want per-app origins (B) at all, which needs a wildcard DNS record and wildcard certificate? | **Later, not now.** Apps that face the public already have their own domain. |
| Q5 | When the bridge is narrowed, should an app's undeclared bridge call be refused (it breaks until its manifest is fixed) or only logged? | **One week log-only, then refuse.** |
| Q6 | Should `cli.edit` (Claude Code in the app folder) stay callable from app pages at all? | **Yes, but only after an owner confirmation in the dashboard.** |
| Q7 | Users of app logins will have to log in again once per app per browser when the origin changes. Acceptable? | **Yes**; announce it for users-level apps (pixachat is unaffected — it has its own domain). |
| Q8 | Keep an "unsafe same-origin" switch after stage 6? | **Yes, off by default, with a dashboard warning** — needed for shape (a) remote until Q2 is solved. |

---

## Related server-side gaps (outside this design)

Found while taking the inventory; listed so they are not lost.

- In-process apps run inside the dashboard process and can read
  `req.headers.cookie` (pro `index.js:53-58`); I3 above closes the cookie part
  only.
- The own-process runner loads core's `.env`, so the child process can read
  the owner token despite the narrow spawn environment; the code says so
  itself (pro `app-runner.js:21-26`, `src/apps/app-manager.js:1011-1020`).
- Isolating app *server* code needs its own design (separate OS user, no
  access to the core data directory).
