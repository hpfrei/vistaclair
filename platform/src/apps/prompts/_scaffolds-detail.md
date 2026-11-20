# App Scaffolds

Every app runs **mounted** (in-process via `routes.js`) and ships a `public/`
frontend. A frontend-only app keeps `routes.js` empty (`module.exports = function
setup(router, ctx) {}`) and does all backend work over the bridge — the loader
still serves `public/` as a static fallback. Add server-side routes to `routes.js`
only when you need them (OAuth callbacks, Node.js-only libraries, server-to-server
calls). Start from the frontend scaffold below; add the Mounted backend scaffold
when the app needs routes.

## Frontend (public/)

> `index.html` + `style.css` + `app.js` over the bridge, `routes.js` empty. The default shape: start here for every app.

```html
<!-- public/index.html — markup only, loads platform runtime + app files -->
<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{APP_NAME}}</title>
  <link rel="stylesheet" href="/pro/app-theme.css">
  <link rel="stylesheet" href="style.css">
</head><body>
  <div id="app"></div>
  <script src="/pro/app-runtime.js"></script>
  <script src="/pro/vc-input-bar.js"></script>
  <script src="/pro/vc-chat-log.js"></script>
  <script src="/pro/vc-progress.js"></script>
  <script src="/pro/vc-empty-state.js"></script>
  <script src="/pro/vc-model-picker.js"></script>
  <script src="/pro/vc-markdown.js"></script>
  <script src="app.js"></script>
</body></html>
```

```css
/* public/style.css — app-specific styles, extending platform theme */
@import url('/pro/app-theme.css');

/* App-specific styles go here. Use platform variables:
   --bg, --bg-surface, --bg-hover, --border, --text, --text-dim,
   --accent, --green, --red, --orange, --yellow, --purple, --cyan,
   --radius, --font, --font-mono
   Platform component classes: .btn, .btn-primary, .btn-danger, .btn-sm,
   .form-input, .panel, .modal, .toast-*, .badge, .data-table,
   .spinner, .spinner-sm, .skeleton, .progress-bar/.progress-fill/.progress-label,
   .empty-state — never write your own spinner/progress/skeleton CSS
   For stateful/behavioral widgets use the auto-loaded vc-* Web Components
   instead of these classes: progress -> <vc-progress>, empty placeholder ->
   <vc-empty-state>, prompt input -> <vc-input-bar>, chat thread -> <vc-chat-log>,
   model dropdown -> <vc-model-picker>, rich text/markdown/AI answers (incl. math,
   media previews, SVG) -> <vc-markdown> (`ui` section of the API reference).
*/
```

```js
// public/app.js — app logic
// Provided by /pro/app-runtime.js: Bridge, askAI, parseAIResponse, showToast,
// showConfirm/showModal, escapeHtml, apiFetch, timeAgo/formatDate/formatTime, initTabs

async function init() {
  // Your app initialization
}

init();
```

## Frontend: Realtime dashboard

> Server-pushed refresh via `cron.schedule` + `Bridge.on('cron:result')`. Use instead of `setInterval` polling.

Same HTML structure but with a grid layout and **realtime server-pushed updates**:

```js
// public/app.js

// Realtime dashboard — server pushes results over WebSocket, no polling
let cronJobId = null;

async function init() {
  // Listen for server-pushed cron results
  Bridge.on('cron:result', (data) => {
    if (data.jobId === cronJobId && data.code === 0) {
      render(JSON.parse(data.stdout));
    }
  });

  // Schedule a recurring command — results arrive via cron:result events
  const { jobId } = await Bridge.call('cron.schedule', {
    schedule: 'every 5 seconds',
    command: 'some-command --json'
  });
  cronJobId = jobId;

  // Initial load
  const data = await Bridge.call('exec', { command: 'some-command --json' });
  if (data.code === 0) render(JSON.parse(data.stdout));
}

init();
```

**Do NOT use `setInterval` + `Bridge.call('exec')` for periodic refresh.** That pattern polls from the client, wasting resources and adding latency. Use `cron.schedule` instead — the server runs the command and pushes results to the frontend over the existing WebSocket connection in realtime.

## Mounted backend: Service with routes

> A `routes.js` with the ctx member list, `ensureSchema`, DB-backed routes, broadcast and cleanup. Use when the app needs server-side logic.

Add `routes.js` routes when the app needs server-side logic (OAuth callbacks, server-to-server API calls, Node.js-only libraries, backend engine event handlers like `ctx.email.on(...)`, database access). No separate port — routes mount on vistaclair's Express app. The loader pre-applies `express.json({ limit: '10mb' })` and serves `public/` as static fallback after your routes.

**Do NOT install `mariadb` or `mysql2`** — use the platform DB service. Each app gets its own database automatically.

```js
// routes.js
const fs = require('fs');
const path = require('path');

module.exports = function setup(router, ctx) {
  // ctx.appName    — app slug
  // ctx.appDir     — absolute path to app directory
  // ctx.dataDir    — .data/ directory (persistent files)
  // ctx.basePath   — '/apps/<name>'
  // ctx.broadcaster — { broadcast(msg) } for WebSocket events
  // ctx.notify(title, body, level) — dashboard-level toast notification
  // ctx.googleAuth.getToken(scopes) — get Google OAuth access token
  // ctx.googleAuth.accounts() — list connected Google accounts
  // ctx.emailAccounts.list() — list platform email accounts (no passwords)
  // ctx.email.* — platform email engine: list/get/modify/send/attachment/annotate, on(event, handler)
  // ctx.calendar.* — platform calendar engine: events/get/create/update/delete/listCalendars/colors
  // ctx.dbName     — app's provisioned database name (e.g. 'vc_my_app')
  // ctx.dbQuery(sql, params) — query auto-scoped to app's database
  // ctx.getDb()    — raw admin MariaDB pool (advanced/cross-database use)
  // ctx.aiPrompt(params) — server-side AI prompt (retries: N retries transient failures)
  // ctx.jobs.start/get/list/cancel — persisted long-running jobs (reload-resilient)
  // ctx.settings.get/set/all — per-app user-facing settings
  // ctx.ensureSchema([ddl]) — provision DB + run CREATE TABLE statements
  // ctx.sse.handler/emit — SSE for cookieless clients (Telegram mini-apps)
  // ctx.files.saveBase64/serve — uploads + range-capable file streaming
  // ctx.transcribe({ audio, accuracy? }) — speech-to-text (OpenAI), audio base64
  // ctx.tts({ input, voice?, instructions? }) — text-to-speech (OpenAI) -> { audio, dataUri }
  // ctx.image({ prompt, image?, aspectRatio? }) — image gen/edit (Gemini) -> { images, text }
  // ctx.registerTools([...]) — register MCP tools for aiPrompt() calls
  // ctx.onToolCall(name, handler) — register handler for an MCP tool
  fs.mkdirSync(ctx.dataDir, { recursive: true });

  // Create tables on startup (provisions the DB + runs DDL serially).
  // Gate routes on the promise; do NOT .catch() it away or the gate always passes.
  const ready = ctx.ensureSchema([
    'CREATE TABLE IF NOT EXISTS items (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)',
  ]);
  router.use(async (req, res, next) => { try { await ready; next(); } catch (e) { next(e); } });

  // API routes — frontend calls with relative URLs: fetch('api/data')
  router.get('/api/data', async (req, res) => {
    const rows = await ctx.dbQuery('SELECT * FROM items', []);
    res.json(rows);
  });

  router.post('/api/action', async (req, res) => {
    const result = await ctx.dbQuery('INSERT INTO items (name) VALUES (?)', [req.body.name]);
    ctx.broadcaster.broadcast({ event: 'item:created', id: result.insertId, name: req.body.name });
    res.json({ ok: true });
  });

  // For OAuth callbacks, derive redirect URI from request headers:
  // const redirectUri = `${req.headers['x-forwarded-proto'] || req.protocol || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}${ctx.basePath}/auth/callback`;

  // Optional: return cleanup function (may be async) for teardown on Stop
  return function cleanup() {
    // close connections, cancel timers
  };
};
```

```json
// package.json — never include mariadb/mysql2, use platform DB service
{
  "name": "{{APP_NAME}}",
  "private": true,
  "dependencies": {}
}
```

## Mounted-tier: App with AI Tools

> `ctx.registerTools` / `ctx.onToolCall` plus `aiPrompt` with `allowedTools`. Use when the app exposes MCP tools.

Routes.js with MCP tools that Claude can call during `aiPrompt()` sessions:

```js
// routes.js — with MCP tool registration
module.exports = function setup(router, ctx) {
  // Register MCP tools at startup
  ctx.registerTools([
    {
      name: 'query_items',
      description: 'Search items in the database by name or category. Returns matching items with id, name, category, and created_at.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms' },
          category: { type: 'string', description: 'Filter by category' }
        },
        required: ['query']
      },
      // expose: 'self' (default, own AI only) | 'platform' (+ platform AI & cron) | 'apps' (+ other apps via ctx.tools.call)
      expose: 'self'
    }
  ]);

  // Register handler for each tool
  ctx.onToolCall('query_items', async ({ query, category }) => {
    let sql = 'SELECT * FROM items WHERE name LIKE ?';
    const params = [`%${query}%`];
    if (category) { sql += ' AND category = ?'; params.push(category); }
    const rows = await ctx.dbQuery(sql, params);
    return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
  });

  // Use tools in AI calls — every needed tool must be listed
  router.post('/api/analyze', async (req, res) => {
    const result = await ctx.aiPrompt({
      message: req.body.prompt,
      systemPrompt: 'You can query the database using the query_items tool.',
      allowedTools: [
        'mcp__app-tools__{{APP_NAME}}__query_items',
        'Read', 'Bash'
      ]
    });
    res.json({ text: result.text });
  });

  // ... other routes
};
```

Mounted-tier apps use `ctx.broadcaster.broadcast(msg)` in `routes.js` and `Bridge.on('broadcast', handler)` in `app.js` for realtime server-to-frontend communication. This replaces cron-based polling for apps that have their own routes.

```js
// public/app.js — mounted-tier frontend with realtime updates

async function init() {
  // Listen for server-pushed events via broadcaster
  Bridge.on('broadcast', (data) => {
    switch (data.event) {
      case 'item:created': appendItem(data); break;
      case 'item:updated': updateItem(data); break;
    }
  });

  // Initial data load via relative URL (resolves to /apps/<name>/api/data)
  const items = await fetch('api/data').then(r => r.json());
  render(items);
}

init();
```

## Mounted-tier: App with Email (platform engine)

> `ctx.email` list/modify/send/annotate and `ctx.email.on`. Use for any mail feature — never IMAP/SMTP.

Routes.js using the platform email engine. The platform continuously syncs every
configured account (IMAP IDLE, Gmail incremental) into a master store — never open
IMAP/SMTP connections, never install `imapflow`/`nodemailer`/`googleapis`:

```js
// routes.js — app using the platform email engine
module.exports = function setup(router, ctx) {
  // List available email accounts from platform (no credentials needed)
  router.get('/api/accounts', (req, res) => {
    res.json(ctx.emailAccounts.list());
  });

  // Read recent mail — always fresh, no connection management
  router.get('/api/inbox/:email', async (req, res) => {
    try {
      const { emails, total } = await ctx.email.list({
        account: req.params.email, folder: 'INBOX', limit: 20,
      });
      res.json({ emails, total });
    } catch (err) {
      res.status(503).json({ error: err.message });
    }
  });

  // Mutations write through to the real mailbox
  router.post('/api/archive', async (req, res) => {
    await ctx.email.modify({ account: req.body.account, uid: req.body.uid, move: 'Archive' });
    res.json({ ok: true });
  });

  // Send via the engine (Gmail API or SMTP picked by account type, Sent handled)
  router.post('/api/send', async (req, res) => {
    const { account, to, subject, body } = req.body;
    await ctx.email.send({ account, to, subject, body });
    res.json({ ok: true });
  });

  // React to new mail in real time — no cron polling needed
  const unsubscribe = ctx.email.on('email:new', async ({ account, messages }) => {
    for (const msg of messages) {
      // e.g. classify, then attach your structured data to the email
      await ctx.email.annotate({ account, uid: msg.uid, kind: 'my-data', data: { v: 1, seen: true } });
    }
    ctx.broadcaster.broadcast({ event: 'inbox:updated', account });
  });

  return function cleanup() { unsubscribe(); };
};
```

```json
// package.json — no mail libraries; the platform engine handles all protocols
{
  "name": "{{APP_NAME}}",
  "private": true,
  "dependencies": {}
}
```

Frontends subscribe to engine events via `email.subscribe` + `Bridge.on('email:new', ...)`.
Calendar works the same way: `ctx.calendar.events/create/update/delete` (synced Google
Calendar, write-through CRUD) — no `googleapis`, no direct Calendar API calls.

## Mounted-tier: App with Telegram bot (opt-in only)

> `ctx.telegram.onUpdate`/`send` and the `/link` code. Only when the user explicitly asked for Telegram.

Only use this when the user explicitly asks for Telegram. Each app has its own bot — the
user binds a token under Apps → Setup → Telegram. The platform handles inbound delivery
(long-poll or webhook); the app just sends and reacts. Add `"capabilities": { "telegram": true }`
to `manifest.json` whenever you wire Telegram — Setup → Telegram uses it to flag the app as
awaiting a bot and guide the user to bind one.

```js
// routes.js — a Telegram-connected app
module.exports = function setup(router, ctx) {
  // React to inbound Telegram messages (backend handler).
  const unsubscribe = ctx.telegram.onUpdate(async (update) => {
    const chatId = update.message?.chat?.id;
    if (!chatId) return;
    const text = update.message.text || '';
    if (text === '/start') {
      await ctx.telegram.send(chatId, 'Connected. I will notify you here.');
    } else if (text === '/link') {
      // Bridge this chat to the dashboard: issue an ephemeral code the user types
      // into the dashboard view (which redeems it via POST /api/link). Platform-
      // owned — secure RNG, 10-min TTL, rate-limited. update.message.from.id is
      // the Telegram user id (your canonical user key).
      const code = ctx.identity.issueLinkCode(update.message.from.id);
      await ctx.telegram.send(chatId, `Dashboard link code (10 min): ${code}`);
    } else {
      await ctx.telegram.send(chatId, 'Got it: ' + text);
    }
  });

  // Send a notification from anywhere in the app (e.g. a cron-driven endpoint).
  router.post('/api/notify', async (req, res) => {
    if (!ctx.telegram.configured()) {
      return res.status(400).json({ error: 'No Telegram bot — add one in Apps → Setup → Telegram' });
    }
    const { chatId, text } = req.body;
    const result = await ctx.telegram.send(chatId, text);
    res.json(result);
  });

  return function cleanup() { unsubscribe(); };
};
```

Frontend equivalent (handling it client-side over the bridge) uses `Bridge.on('telegram:update', ...)` and
`Bridge.call('telegram.send', { chatId, text })`. Store the user's chat id in `state` after
the first inbound message so the app knows where to send proactive notifications.

## Mounted-tier: app users + dashboard (two contexts, one SPA)

> The cookieless `app` entry surface, `ctx.identity` across both contexts, dual-mounted routes, SSE. Use when the app has app users.

Use this when the app must run **both** in the owner dashboard and for app users — a Telegram
Web App, a WhatsApp-linked browser user, or an email-login website. The user surface is
**cookieless**: only the `app` entry surface (`app.html`, `app.css`, `app/**`, `/api/app/*`
guarded, `/api/app/pub/*` anonymous) is reachable there. Declaring the login channel in
`manifest.json` (`"auth": { "telegram": true }`) is what opens it — see "Mini-apps and app users"
in the API Reference for the full rules. The pattern: two thin bootstraps over one shared SPA,
plus dual-mounted endpoints. **Identity is the platform `ctx.identity` capability — do NOT
hand-roll initData HMAC, link-code tables, or session tokens.** Both contexts resolve to ONE user
keyed by the Telegram user id (make `users.id` that id). Add `"capabilities": { "telegram": true }`
so Setup → Telegram flags the app as awaiting a bot.

```
public/
  index.html, app.js, style.css   # OWNER dashboard frontend (cookie-gated; loads /pro/* runtime + theme)
  app.html                        # entry page for app users (cookieless; loads telegram-web-app.js, NO /pro/*)
  app.css                         # self-contained styles (theme tokens INLINED, not @import /pro/*)
  app/boot.js                     # entry bootstrap: Telegram initData → mini-app; no identity → landing/login view
  app/core.js                     # SHARED SPA: window.AppCore.mount(config) — used by both bootstraps
```

```js
// public/app.js (owner dashboard) — session-token identity (Identity from /pro/app-runtime.js), WS realtime.
// The token comes from redeeming a /link code (see below); Identity persists it, replayed as Bearer.
AppCore.mount({
  apiBase: 'api',
  authHeaders: () => { const t = Identity.token(); return t ? { Authorization: 'Bearer ' + t } : {}; },
  hasLink: true,
  onLinked: (r) => Identity.set(r.token),   // r = { token, ... } from POST /api/link
  realtime: Bridge,
});

// public/app/boot.js (entry surface) — no Bridge, no /pro/*; identity = initData (Telegram) or a
// tagged session (browser); realtime = SSE on the entry prefix.
const initData = window.Telegram && Telegram.WebApp.initData;
const session = localStorage.getItem('app.session');
const q = initData ? 'initData=' + encodeURIComponent(initData) : session ? 'session=' + encodeURIComponent(session) : null;
if (!q) { renderLanding(); }   // anonymous browser visit: landing / login view (link code, email, kit)
else {
  const es = new EventSource('api/app/events?' + q);
  // ctx.sse.emit sends NAMED events — listen with es.addEventListener('<event>', e => JSON.parse(e.data))
  document.addEventListener('visibilitychange', () => {   // Telegram freezes backgrounded webviews
    if (document.visibilityState === 'visible' && es.readyState === 2) location.reload();
  });
  AppCore.mount({ apiBase: 'api/app', authHeaders: () => initData ? { 'X-Telegram-Init-Data': initData } : { Authorization: 'Bearer ' + session }, realtime: es });
}
```

```js
// routes.js — ctx.identity authenticates BOTH contexts; dual-mount every shared endpoint.
module.exports = function setup(router, ctx) {
  // One guard for both prefixes: ctx.identity.resolve verifies a session Bearer OR Telegram
  // initData and returns { userId, via, user?, channel? }. via:'telegram' carries the verified
  // user object — upsert your row from it. userId is the Telegram user id = users.id.
  function mount(method, sub, handler) {
    const guard = (base) => async (req, res) => {
      const r = ctx.identity.resolve(req);
      if (!r) return res.status(401).json({ error: 'unauthorized' });
      if (r.via === 'telegram' && r.user) await ctx.dbQuery(
        'INSERT INTO users (id, name, username) VALUES (?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)',
        [r.user.id, [r.user.first_name, r.user.last_name].filter(Boolean).join(' '), r.user.username || null]);
      req.base = base;
      try { await handler(req, res, r.userId); } catch (e) { res.status(500).json({ error: e.message }); }
    };
    router[method](`/api/${sub}`,     guard('api'));      // owner dashboard
    router[method](`/api/app/${sub}`, guard('api/app'));  // app users (platform default-deny guard runs first)
  }

  mount('get', 'feed', async (req, res, userId) => { res.json(await ctx.dbQuery('SELECT ...', [userId])); });

  // Link redeem — the bot issued the code with ctx.identity.issueLinkCode(user.id) (see the
  // Telegram bot scaffold). Redeem it → mint a session TAGGED with its channel so the platform
  // guard maps it to the right account. Pre-login, so it lives under /api/app/pub/.
  const redeem = async (req, res) => {
    const redeemed = ctx.identity.redeemLinkCode(String(req.body.code || '').trim());
    if (!redeemed) return res.status(404).json({ error: 'invalid_or_expired' });
    res.json({ ok: true, token: ctx.identity.issueSession(redeemed.userId, { via: redeemed.via }) });
  };
  router.post('/api/link', redeem);           // owner dashboard
  router.post('/api/app/pub/link', redeem);   // browser users, anonymous

  // BIGINT PKs (Telegram ids) come back as JS BigInt — patch res.json once so it serializes.
  router.use((req, res, next) => {
    res.json = (b) => res.type('application/json').send(JSON.stringify(b, (k, v) => typeof v === 'bigint' ? v.toString() : v));
    next();
  });

  // Realtime that survives the cookieless surface: platform SSE (ctx.sse) on the entry prefix.
  // emit() fans every event to BOTH the dashboard WebSocket and the SSE clients.
  function emit(event, data) {
    try { ctx.broadcaster.broadcast({ event, ...data }); } catch {}
    ctx.sse.emit(event, data);                                 // 3rd arg = channel for per-user scoping
  }
  router.get('/api/app/events', (req, res, next) => {          // EventSource can't set headers → ?initData= / ?session=
    if (!ctx.identity.resolve(req)) return res.status(401).end();
    next();
  }, ctx.sse.handler());                                       // headers, pings, cleanup all handled

  // Point the bot's WebApp button at the entry page, and degrade gracefully when no public
  // HTTPS URL is configured (Telegram rejects web_app on non-HTTPS): entryUrl() is null then.
  async function syncMenuButton() {
    const url = ctx.telegram.entryUrl();
    await ctx.telegram.call('setChatMenuButton',
      url ? { menu_button: { type: 'web_app', text: '📊 Open app', web_app: { url } } }
          : { menu_button: { type: 'default' } });
  }
  if (ctx.telegram.configured()) syncMenuButton().catch(() => {});
};
```

## Own-process placement (rare)

> The same file shape with `"runtime": "own-process"`. Only for an app that blocks the event loop.

No scaffold needed: an own-process app is the SAME `routes.js + public/ + manifest.json`
shape as every other app. Set `"runtime": "own-process"` in manifest.json and the
platform hosts routes.js in its own managed child process (crash/blocking containment,
restricted standalone ctx), reverse-proxied at the same `/apps/<name>/` URL. Never
write a `server.js` or call `app.listen()`.
