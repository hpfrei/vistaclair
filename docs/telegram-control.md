# Telegram control bot: owner, claim, privilege, QR login

The platform control bot (`platform-telegram.js`, key `__platform__`) is
Horst's Telegram chat and the owner's remote control (`docs/horst-surfaces.md`).
This doc is who may use it and how it is claimed.

**Owner and privilege** (tests `test/tg-owner.test.js`): the bot is claimed
by CODE, never by inbound traffic. The dashboard's Telegram settings
(`app:setup:platformTelegramClaimCode`, answered to that socket only; the
owner-authed WS) show a one-time claim code — random, 10 minutes, single
use, one live per bot, dead after 5 wrong guesses, in memory only — and the
link `t.me/<bot>?start=claim_<code>`. A private-chat `/start claim_<code>`
with a valid code sets `ownerUserId = from.id` and makes that private chat
the only allowlisted one (`telegram.redeemClaim`; claiming again moves the
owner). Until claimed — or after the owner's chat is removed — the bot fails
closed: nothing is served, a stranger's private message gets at most one
"not set up" note a minute. `removeAllowedChat` never re-opens a claim. A bot
claimed before this by a private chat keeps its owner (data migrated as is);
one claimed from a group chat logs a warning at boot and counts as unclaimed
until re-claimed. Restricted per-app bots keep claim-on-first
(`telegram.dispatchUpdate`); only `CODE_CLAIM_KEYS` (the control bot) use codes.
Privilege is decided by SENDER, one rule: `telegram.isOwnerAct(key, chat,
from)` = restricted bot, claimed owner, `chat.type === 'private'`,
`from.id === ownerUserId`, `chat.id === from.id`. `platform-telegram.
isPrivileged(message | callback)` and `platform-login` both call it, and it
guards EVERY path: messages, every callback (proposal decide, launches,
restart, runs, todos…; a non-owner tap is dropped silently), the launch
prompt reply, text relayed into a bound session, media and the Horst chat, and
job-question answers (`platform-horst.answerJobQuestion(msg, …)` →
`horst-jobs.answerFromTelegram(…, actor)`, checked again there through its
`isOwnerAct` dep). A group the bot sits in gives its members — the owner
included — nothing. `platform-horst.controlChatId()` is the owner's chat.
The Mini Apps (`tg-miniapp-auth.js`) admit only the owner, take initData for
1 hour (`INITDATA_MAX_AGE_S`; app bots keep `app-identity`'s 24 h default),
and re-check every bearer (12 h at most) against the bot on each request:
an owner change, a removed chat, restricted turned off or a removed bot
revokes them at once.
**Dashboard QR login** (`platform-login.js`, only with core's `ctx.login`,
`docs/seam.md`; tests `test/tg-login.test.js`): provider `telegram`, whose
`link(code)` is `https://t.me/<bot>?start=login_<code>` once the bot is
restricted, claimed, its owner's private chat is allowlisted and its
username is known (`getMe`, cached per token), else null (no QR). A
`/start login_<code>` message never claims a bot (`telegram.isLoginStart`,
every bot) and is handled before everything else: only the owner in their
private chat gets a reply — anyone else, a group, an unrestricted or
unclaimed bot: silent drop (no "not set up" note either). Unknown / expired code → a hint; pending → a
card (short UA · IP · request time) with ✅ Log in / ✖ Not me
(`vc_login:<code>:ok|no`, re-checked: owner, private chat, privileged).
✅ → `approve(code, { via: 'telegram-qr', who })`, card "Approved"; a refusal
names core's reason. ✖ → `deny`. Core's `onLogin` for the code edits the
card to "✓ Logged in" with `🚪 Log out this browser`
(`vc_logout:<sessionId>` → `revokeSession`). The code → card map is in
memory only. **Sessions**: `/sessions` and the menu's `🖥 Dashboard
sessions` (owner's private chat) list `listSessions()` with a log-out
button each and `Log out everywhere` (confirm, then `revokeAll`).
**Alerts**: an `onLogin` with `external` and `via` `token` / `login-link`
pushes "🔑 Dashboard login with the auth token / a one-time login link from
IP …" to the owner; local and `telegram-qr` logins push nothing.

## Inbound delivery: webhook, long-poll, fallback (every bot)

`telegram.js`, tests `test/telegram-fallback.test.js`; the control bot and
every per-app bot alike.

| state | when | consumer |
|---|---|---|
| `mode: 'poll'` | no public URL | `pollLoop` (getUpdates, 50 s long-poll) |
| `mode: 'webhook'` | public URL set (`setPublicUrl`, `setBot`) | `POST /pro/telegram/:app/webhook` (secret header, compared in constant time: `telegram.webhookSecretOk`) |
| fallback | webhook bot whose public URL is broken | `pollLoop`, in memory only — `mode` stays `'webhook'` |

The public URL (`telegram.getPublicUrl()`) is the platform's one public-URL
setting; besides webhooks and Mini Apps it is the base of Google sign-in
links (`google-api.redirectUri()`, `docs/engines.md`).

- **Delivery monitor** (`checkDelivery`, at `start()` and every 60 s; also
  after `setPublicUrl` / `setBot`): per process, only the bots in its
  `start(filter)` (one getUpdates consumer per token; the filter is
  `appManager.runsInDashboardProcess`, which always owns the reserved
  `__platform__` control-bot key — it is not an app name and never reaches
  `readManifest`). One probe of the
  public URL — `POST <url>/pro/telegram/<bot>/webhook` without the secret;
  our route answers 403, anything else or no answer = unreachable. Then
  `getWebhookInfo` per webhook bot: updates pending AND a delivery error in
  the last 10 min (and after our last `setWebhook`) = failing; no webhook or
  another URL registered = re-registered.
- **→ poll**: `deleteWebhook` (pending updates kept) must succeed first, then
  the poll loop starts and fetches what queued up. Log
  `[telegram] "<app>": webhook → poll (<reason>)`.
- **→ webhook**: once the probe answers again (after 10 min when Telegram
  itself reported the errors): the poll loop is stopped, its in-flight
  getUpdates aborted, its offset confirmed (`quiescePolling`, also used by
  every `enableWebhook`), then `setWebhook`. Never two consumers, never
  getUpdates while a webhook is registered.
- `status(app)` / `listBots()` carry `inbound` (`'webhook'` | `'poll'`),
  `fallback` (`{ since, reason }` | null), `lastCheck` (`{ at, ok, reason }`
  | null) and `monitored` (false: the app's own runner consumes the bot and
  holds its fallback state — not visible to the dashboard). A switch
  broadcasts `app:setup:accountsChanged` `change: 'telegram.inbound'`.
- **Check now**: `checkNow(app)` runs the monitor for that bot (joining a
  running check) and returns `{ ok, status }` within 12 s — a slower check
  answers with the status so far and `pending: true` and finishes on its own;
  refused for a bot this process does not own; never throws. The WS reply is
  sent on every outcome. The chip gives up after 15 s without a reply
  (restored, tooltip + toast "No answer from the server — restart the control
  room if it was just updated"); a late reply just re-renders. Dashboard: the Mode cell of both Telegram tables
  (`public/apps.js` `tgInboundChip`) is a chip — `webhook` / `polling` /
  `polling (tunnel down)`, last check and reason as tooltip; a click sends
  `app:setup:telegramCheckDelivery` (owner-authed WS) → `…Result` plus a
  fresh `telegramStatus` / `platformTelegramStatus`; `telegram.inbound`
  pushes refresh the tables. Horst's `telegram_status` reports `inbound`,
  `fallback` and `lastCheck` per bot.
- Still needs the tunnel: Mini Apps, `web_app` and menu buttons
  (`entryUrl`, `syncMenuButton`) and any link built from `webAppUrl`. Chat
  messages, commands and callback-button taps do not.
