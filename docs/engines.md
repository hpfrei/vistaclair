# Platform engines: email, calendar, Google auth, tasks

The owner's mail, calendar and to-dos are platform services (`src/apps/`),
reached by apps through `ctx.email` / `ctx.calendar` / `ctx.todos` /
`ctx.googleAuth` (`capabilities.md`) and by Horst through the same engines'
tools, senses and kinds (`horst.md`, `governance.md`). Apps hold no provider code and no
credentials; every entry point (ctx, Bridge, kind executor, bot, cron) reaches
the same engine method, so a guardrail lives on the method (`capabilities.md`,
"One duty, one implementation").

## Email (`email-engine.js` + `email-*.js`)

- **Storage**: MariaDB `vc_platform_mail` — `platform_email_sync`,
  `platform_emails` (UNIQUE(account, uid), FULLTEXT, VECTOR(384)),
  `platform_email_attachments`, `platform_email_tombstones`,
  `platform_email_pending_ops`, `platform_email_sent`,
  `platform_email_annotations`. No thread, draft or folder record: `thread_id`
  is Gmail's threadId or, for IMAP, the message's own uid.
- **Accounts** (`email-accounts.js`): an account is IMAP when credentials
  exist, else Gmail (OAuth via `google-auth.js`); each account is
  `enabled: false` until switched on.
- **Google OAuth** (`google-auth.js`, `google-callback.js`): `getAuthUrl` mints
  a random single-use `state` (10 min, server-side) and stores the link's
  redirect URI with it; the auth-exempt `/pro/auth/google/callback` consumes it,
  refuses a code with a missing, unknown or reused state, and exchanges the
  code with the STORED URI (the request headers only back a state without one).
  `google-api.redirectUri()` is `<public URL>/pro/auth/google/callback` when
  Setup → Telegram "Public URL" (`telegram.getPublicUrl()`, the one platform
  public-URL setting) is set, else `http://localhost:<dashboard port>/…`. The
  Google client must list both the public and the dashboard origin / redirect
  URI; `app:setup:oauthStatus` carries `publicUrl` so Setup → Google shows both. The page embeds data as JSON with `<`, U+2028/9
  escaped in a nonce'd script, sends its own `Content-Security-Policy`
  (`default-src 'none'; script-src 'nonce-…'`) and posts to `location.origin`.
- **Sync**: Gmail (`email-sync-gmail.js`) is a historyId incremental poll
  (`gmailPollSchedule`, 2 min) with a resumable backfill (checkpoint
  `{ pageToken, anchor }`, 200ms pacing); 404/410 re-anchors and re-lists,
  401 marks the account `auth_required`. IMAP (`email-sync-imap.js`) keeps
  one ImapFlow IDLE connection per enabled account, debounces INBOX refreshes
  (1.5s), detects folders via LIST SPECIAL-USE, and reconciles all folders on
  `reconcileSchedule` (60 min); a UIDVALIDITY change merges by Message-ID.
- **Sync failures reach Horst as episodes** (`syncAlertTracker`): an account
  publishes `email:sync:failed` once after 10 min of unbroken `error`
  (`SYNC_ALERT_GRACE_MS`, error text changes don't count), and
  `email:sync:recovered` once when it is `watching`/`backfilling` again. A blip
  that heals inside the window publishes nothing; `disabled`/`auth_required`
  end an episode quietly.
- **Cron** (all on `platform-cron`, registered at boot): gmail-poll 2 min,
  imap-reconcile 60 min, embed-sweep 5 min, delete-sweep 1 min, maintenance
  sweep 6 h (`SETTINGS_DEFAULTS`, overridable in `.email-engine.json`).
- **Delete is optimistic**: flag locally, queue a pending op, ack, drain in the
  sweep (5 attempts; "already gone" counts as success); giving up dispatches
  `email:delete-failed`, which nothing consumes yet.
- **Content** (`email-content.js`, `html-sanitize.js`): `html_body` is stored
  raw and sanitised on read (`getEmail`/`render` take `html: 'sanitized'`,
  `allowImages`, `inlineImageBase`). Search (`email-query.js`,
  `fulltext-query.js`) fuses
  `VEC_DISTANCE_COSINE` ANN with FULLTEXT and falls back to FULLTEXT alone
  when VECTOR is unavailable. Operators compile to predicates on both halves;
  `tag:`/`-tag:` is the one that reads an annotation (an `EXISTS` on the
  platform `tags` document, tombstones excluded) — `operatorSql` takes the
  label vocabulary as an argument so the builder stays pure and name→id
  resolution is the caller's.
- **Inline images**: both sync parsers capture a part's Content-ID into
  `attachment_meta` — `contentId` (bare, angle brackets stripped) and `inline:
  true` (declared `Content-Disposition: inline`, or carrying a Content-ID);
  absent on a part that has neither, so ordinary attachment metadata is
  unchanged. On the read path `inlineImageBase` makes `renderEmail` build a
  `cid` → attachment-id map from THAT row's `attachments[]` and rewrite each
  matching `cid:` src to `<base><attachment id>`; the id shapes the URL, never
  the cid string, and the result goes through the same scheme check as any
  other src. `render` refuses a base that is not an absolute path or an
  http(s) URL — the one guardrail, on the method every entry point reaches. An
  unmatched cid is left exactly as it is and counted: rows carry
  `htmlInlineImages` / `htmlInlineImagesUnresolved` when non-zero. Content-IDs
  are captured **at sync**, so mail synced before the fields existed resolves
  nothing until it is re-synced and degrades to the unresolved `cid:` src.
- **Compose** (`email-compose.js`, `email-threading.js`, `email-draft.js`):
  a pure leaf. `composeReply` returns the send payload plus its sources
  (quote text/html, attribution, `quoteSha256`, `composeVersion`) so an edited
  draft can be re-derived; `enforceReplyOnly` strips a draft that echoes the
  parent (a 40-word verbatim run or heavy 8-gram containment). Threading
  follows RFC 5322 References; the signature is RFC 3676 (`-- `).
- **Send**: Gmail via `messages/send` (returns no Message-ID), IMAP via
  nodemailer SMTP plus best-effort IMAP APPEND (returns no uid) — each
  transport relies on exactly one of the two dedupe keys in
  `platform_email_sent`.
- **Sent reads** (`listSent`): the send log unioned with the synced Sent
  folder, deduped by Message-ID then provider uid. Items carry a 200-char
  `snippet`; `includeBody: true` adds `body`, the full outgoing text the log
  stored (`logSend` caps it at 60k chars) — null on a `via:'folder'` item,
  which is headers-only. Off by default, so the "has this thread been
  answered?" read stays header-sized.
- **Annotations** ride on every read — `listEmails`, `getEmail` and the hybrid
  `similarSearch` (`email-embed.js`) all take `annotationsFrom`, so a view app
  sees the same writers' kinds whichever path produced the row. They are
  versioned per kind. The engine writes two of its own under `app_name
  'platform'`: `rule-match` (why a mail was trashed) and `tags` (`email-tags.js`
  — which tags a message carries, `{ v, sender, tags:{ id:{ source, removed? } } }`;
  `assignTags`/`setTags`/`tagsOf`, a user removal is a tombstone, an automatic
  source replaces only its own entries). Horst's `email-intel` is `v: 4`
  (`horst.md`, "Email triage"). Its `calendarEvents[]` carry an optional
  `endDate` (`YYYY-MM-DD`, last day inclusive) beside `date`; it is absent for
  single-day events, which is every event before this field existed.
  `normalizeExtractedEvent` (`agent/horst-triage.js`) is the one validator —
  it drops an `endDate` that is malformed, earlier than `date`, or the same
  day — and `stageCalendarProposals` carries it into the `calendar.create`
  payload, where `buildEventBody` below already knew what to do with it.
- **Spam rules** (`.email-rules.json`, `addRule` / `removeRule` /
  `applyRules` / `matchSenderRule`): a sender or domain whose mail is trashed
  on arrival. `assertRuleAllowed` refuses a SENDER rule on one of the owner's
  own addresses (`knownAccounts()`: IMAP vault plus Google accounts) — it
  would trash their own mail as it syncs back. It runs inside `addRule`, so
  ctx, the Bridge and the `email.rule.add` kind (validate calls it too) all
  hit it; `matchSenderRule` also skips such a rule stored before the guard.
  A domain rule on the owner's domain stays allowed.
- **Events** on the bus: `email:new`, `email:sent`, `email:annotated`,
  `email:deleted`, `email:delete-failed`, `email:auth-expired` (the exact
  list is the module's `horst.senses` in `capabilities/email.js`).

## Google auth (`google-auth.js`, `google-api.js`)

- Setup → Google guide (`public/apps.js`, `setupPane-google`) follows the Google Auth
  Platform console (`/auth/branding`, `/auth/audience`, `/auth/clients`): project → Gmail +
  Calendar APIs → Branding → Audience (test user; recommends "Publish app") → Web client
  with the origin + redirect URI → paste credentials. It also lists the API-key APIs
  (Gemini, Translation, Maps; `test/google-setup-guide.test.js`). External links open in a new tab.
- Scope growth is lazy and error-driven: a call that needs a scope returns
  `{ authRequired, authUrl }` and the surface shows the link. Adding an account
  is explicit: Setup → Google → Connected Accounts has a "Connect Google
  account" button (shown whenever credentials are configured, also with
  accounts present) → WS `app:setup:oauthConnect` → `google-api.connectAuthUrl`
  (openid + email + every `SCOPES` entry, no email, same `issueState`) → the
  `app:setup:oauthReauthUrl` popup flow; the callback names the account from
  userinfo and the list refreshes on `google-auth-success`. Scopes are unioned across everything already granted; without an
  explicit `email` the first account whose scopes cover the request is chosen.
- Tokens live in core's secret store; access tokens refresh shortly before
  expiry. `revokeAccount` revokes at Google FIRST (a 400 `invalid_token` counts
  as revoked), then drops the local record.

## Calendar (`calendar-engine.js`, `rrule.js`)

- **Storage**: `platform_calendar_sync`, `platform_calendar_events`,
  `platform_calendar_annotations` — in the mail engine's schema, not their own.
- **Sync**: a 5-minute poll (`syncSchedule`) of the account's selected
  calendars is the source of truth even where push channels exist; backfill
  starts one year back; a forced full re-list every 24 h
  (`FULL_SYNC_INTERVAL_MS`) reconciles cancelled events, which `singleEvents`
  incremental listing would otherwise miss.
- **First sight of an account**: an account with the calendar scope but no
  `platform_calendar_sync` rows (just connected) gets its calendar list read
  and its primary calendar selected by `ensureCalendars`, from the poll
  (`syncAccount`) and from Setup → Google → Calendar Sync (`panelStatus`, which
  also returns per-account `errors`). Once rows exist the owner's selection
  (even none) is never changed. The panel re-requests on opening the Google tab
  and after a connect popup; an account added in-process shows on the next open.
- **Multi-day**: `buildEventBody` spans a range from `endDate || date` — for an
  all-day event it adds Google's exclusive +1 day, for a timed one it carries
  the end across midnight. A missing `endDate` therefore means "same day", so
  the field is safe to omit and never needs a default written in by a caller.
- **Writes**: `createEvent` targets the platform-level default calendar
  (`defaultCalendar(account)`, a per-account setting; only a missing setting
  falls back to Google's `primary`) and sends updates to attendees whenever
  there are any. `updateEvent` with `scope: 'single'` and no patch is a full
  replace; `scope: 'following'` caps the old RRULE with `UNTIL` and creates a
  new series; `moveEvent` uses Google's native move so conference links
  survive. All of these are governance kinds when Horst is the caller.
- **Not built**: free/busy and slot search, conferencing creation,
  RSVP / `responseStatus` writes, and a calendar-change sense (Horst sees
  calendar state through the briefing and the prior-action check only).

## Tasks and to-dos (`tasks-engine.js`, `capabilities/tasks.js`, `todos.js`)

- One table, `platform_tasks`; tasks are what Horst tracks (from mail, chat,
  missions), to-dos are the owner-facing list. `capabilities/todos.js` carries
  the `horst` facet (`todo.create` kind, nudge routine).
- `tasks-engine` and `calendar-engine` never reference each other; they meet
  only on the bus and in Horst's briefing.

## App identity (`app-identity.js`, `app-auth.js`)

Per-app user accounts (`email`, `tg_user_id`, `wa_id`, `license_key`,
`is_owner`) for the `users` access level (`apps.md`). Telegram initData is
HMAC-verified with a max age and a 300s clock-skew allowance; link codes are
6-digit `crypto.randomInt`, 10-minute TTL, one live code per (app, user,
channel), redeem-throttled. Session tokens carry their channel.
The `public/app-auth.js` account panel links a missing method through an
in-card form (link code; email + password), never a browser prompt.
