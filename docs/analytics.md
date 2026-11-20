# Site analytics

Privacy-friendly statistics for an app's sites (`docs/sites.md`) with no app code: no cookies,
no stored IP address, no stored User-Agent. Capability `analytics`
(`platform/src/apps/capabilities/analytics.js`); an app opts in per site with manifest
`sites.<site>.analytics: true`.

| File | Duty |
|---|---|
| `platform/site-analytics.js` | capture lib, zero dependencies: IP, UA, language, bots, visitor hash, salt, spool writer, nginx parser. Used by the runner and by the log import, so both anonymise by the same code |
| `platform/site-runner.js` | `startCapture`, `instrument` (before the handler), `site.track` |
| `src/apps/analytics-geo.js` | the platform-wide country table and its monthly refresh |
| `src/apps/analytics-store.js` | database `vc_platform_analytics`, ingest, rollup, prune |
| `src/apps/analytics-query.js` | `query` / `live` / `csv` over raw rows and rollups |
| `src/apps/analytics.js` | the engine: ingest loop, live events, daily cron, import, owner calls |
| `public/vc-analytics.js` | `<vc-analytics>` |

## Capture (in the runner)

One record per request, written with `fs.writeSync` on an `O_APPEND` fd inside a wrapped
`res.end`, so it is on disk before the client gets the last byte:

| Field | Value |
|---|---|
| `t`, `m`, `s`, `b`, `d` | time (ms), method, status, bytes written, duration ms |
| `p`, `q` | path (normalized, ≤ 255), query reduced to `utm_*` and `ref` (≤ 200) |
| `r` | referrer **host** only: no scheme/path/query; internal hosts, `localhost` and IP literals are dropped |
| `us`/`um`/`uc` | `utm_source` / `utm_medium` / `utm_campaign` |
| `br`,`bv`,`os`,`dv` | UA classes: browser + major, OS, device (`desktop`, `phone`, `tablet`, `quest-browser`, `unknown`) |
| `l`, `c` | first Accept-Language tag (2–3 letters), country (ISO 3166 alpha-2 or empty) |
| `k` | `page`, `asset`, `other`, `event` (from method, status, content type, path) |
| `bot` | 0 human, 1 UA list, 2 never loads assets (below) |
| `v` | visitor hash, 16 hex |

- **Client address.** The socket peer; `X-Forwarded-For` / `X-Real-IP` count only when the
  peer is loopback (a reverse proxy on the same host). The address is used for the hash and
  the country lookup and then dropped.
- **Visitor hash** = `sha256(dailySalt ∥ site ∥ ipPrefix ∥ UA)` truncated to 16 hex. `ipPrefix`
  is the /24 (IPv4) or /48 (IPv6). The salt is random per UTC day, kept in
  `<site data>/.analytics/salt.json`, replaced at the first request of a new day and swept by a
  midnight timer, the daily cron and a runner start. A visitor is one per day and two across
  two days; nothing links days.
- **Bots** are counted, never dropped, and split from humans everywhere (`bot` column).
  Class 1 is the UA list (empty UA included). Class 2 is the heuristic: a visitor with ≥ 4
  page loads and no asset while the site served assets to others; the nightly rollup sets it
  retroactively on that day's rows.
- Rows that are not page loads (assets, other requests) are `kind` ≠ `page`, so "visitors" and
  "pageviews" mean humans on pages.

## Spool and ingest

- The runner appends NDJSON to `<appDir>/.data/sites/<site>/data/.analytics/spool-<seq>-<id>.ndjson`
  (the fence's one writable dir). A new file per runner start; rotation at 2 MB; the total is
  capped at 64 MB (oldest unread dropped first, counted in `stats`).
- The runner sends IPC `{t:'spool'}`; the engine debounces 300 ms, then ingests. It also scans
  every site on start, when the database comes up and every 60 s (safety net).
- **Idempotent.** Each row's key is `(app, site, src, src_off)`, `src` the spool file and
  `src_off` the line's byte offset. Rows go in with `INSERT IGNORE` in the same transaction
  that advances `analytics_spool.off_bytes`. A crash leaves rows, offset, or both, and a repeat
  adds nothing. A torn last line (runner killed mid-write) stays unread until complete.
  Fully read files other than the newest are deleted.
- Ingest allowlists and clamps every field of a record (`rowOf`): a spool is untrusted input.
- No database: the spool stays and grows to its cap; reads fail with `no_database` and the UI
  says "no database".

## Storage

Database `vc_platform_analytics` per host, created like the email engine's
(`CREATE TABLE IF NOT EXISTS`, conditional `ALTER`), on the platform's MariaDB connection.

| Table | Content |
|---|---|
| `analytics_hits` | raw rows, 90 days by default; `ts` epoch ms, `day` DATE (UTC) |
| `analytics_daily` | per app, site, day, dimension, key, bot: `views`, `hits`, `visitors`, `bounces`, `errors`, `bytes`; 13 months by default |
| `analytics_spool` | ingest offsets |

Retention is per site, in the host record (`.sites.json`): `analyticsRawDays` 7–365,
`analyticsMonths` 1–36, edited in the Sites tab. Always read DATE columns through
`DATE_FORMAT`: the driver returns local-midnight Dates.

**Daily cron** `analytics:daily` (`10 0 * * *`): ingest, roll up every finished day that has raw
rows and no rollup (also the bot retro-flag), prune raw rows and rollups past retention,
destroy stale salts. A removed or renamed app drops or moves its rows
(`removeApp` / `renameApp`).

## GeoIP

One offline table per host, `<appsDir>/.platform-geo/country.bin.gz` (+ `meta.json`), shared by
every site. Built from DB-IP Country Lite (CC BY 4.0) into the `GEO1` binary format (sorted
IPv4/IPv6 ranges, binary search). Monthly cron `analytics:geo-refresh` (`0 4 3 * *`) downloads
`dbip-country-lite-YYYY-MM.csv.gz` (the previous month if the current one is not out), builds
it, refuses a table with fewer than 1000 IPv4 ranges and swaps it in. A running site reloads
the table by mtime. No table → country `''`, shown as "unknown"; nothing fails.

**Credit.** "IP geolocation by DB-IP" with a link to `https://db-ip.com` appears wherever
countries are shown: `<vc-analytics>` and the Sites tab (`status().credit`). Any app UI that
shows `country` must show it too.

## `ctx.analytics`

Needs `sites.<site>.analytics: true`, and the site is the app's own; every call is scoped to
the calling app.

| Member | |
|---|---|
| `query({ site, from, to, metrics, groupBy, filters, limit, scope })` | `{ rows, totals, source }` |
| `live(site)` | visitors in the last 5 minutes |
| `csv({ site, … })` | the same query as CSV (cells starting with `= + - @` are prefixed) |
| `track(site, name, props)` | a goal from app code; same table, `kind` `event` |
| `importAccessLog(site, file, { format: 'nginx-combined' })` | `{ imported, duplicates, skipped, tooOld }` |
| `status(site)` | `{ enabled, db, spool, rawDays, months, geo, credit }` |

- Metrics: `visitors pageviews hits events bytes errors avgMs bounces bounceRate`.
- `groupBy` / `filters` dimensions: `day hour bot` (group only) and `path requests referrer
  utm_source utm_medium utm_campaign country browser os device lang status notfound event`.
  Filters are equality; anything else is rejected (`unknown dimension`, `unknown metric`).
- Range ≤ 1100 days, `limit` ≤ 50000. Visitors over a range = the sum of per-day visitors
  (no cross-day identity).
- **Sources.** Raw rows where they exist (a contiguous run up to today); the daily rollup for
  older days, which supports no grouping, one dimension, or one equality filter. A query the
  rollup cannot answer returns `source.skipped` with the days it could not cover.
- **Bridge** `analytics.query` / `analytics.live` / `analytics.csv`, same params. Event
  `analytics:live` `{ app, site, live, at, added }` goes out on the bus and to the dashboard
  after every ingest batch and every 30 s while someone is live.
- **`site.track(name, props)`** in a handler: name 1–64 of `[A-Za-z0-9_.:-]`, props a flat
  object clamped to 700 bytes; it goes through the spool like a request.
- **Import.** `nginx-combined` lines get the runner's treatment: per-day random salts held in
  memory only, then dropped; IP, UA, cookies never stored. The file's hash names the source
  (`imp-<sha256>`), line numbers are the offsets, so re-importing the same file adds nothing.
  Days older than the raw retention are counted in `tooOld` and skipped; finished days are
  rolled up at once.
- Horst: lane `direct`, read-only tool `analytics_query`.

## `<vc-analytics site="main">`

Shadow-DOM component, inline SVG, no external code (`/pro/vc-analytics.js`, in the `vc.js`
bundle).

- Tiles: live now; visitors and pageviews for today / 7 d / 30 d; bounce rate; trend vs the
  previous equal period; humans vs bots.
- Charts and tables: visitors per day, top pages, referrers and UTM campaigns, countries,
  browser / OS / device, languages, 404s, goals.
- Click a row to filter by it (a chip per filter, click to clear); range 7 / 30 / 90 days;
  CSV export of the current view.
- Updates come from `analytics:live` (no polling): the live number moves at once, the data
  reloads 1.5 s after a batch.
- Transport: the Bridge in an iframe, or `el.transport = { call(method, params), on(event, fn)
  → off }`. The dashboard's Sites tab sets the latter, over WS `app:analytics:call` →
  `app:analytics:result`, and shows per site: the component, the retention fields, "no
  database", "country table not built yet" and the credit link.
- `window.Vc.analyticsData` is the data layer without DOM (what the tests read).

## What an app does

1. Declare `"analytics": true` under `sites.<site>`.
2. Optionally `site.track('signup', { plan })` in the handler or `ctx.analytics.track(...)`.
3. Put `<vc-analytics site="main"></vc-analytics>` in its own page if it wants its own view;
   the Sites tab already has one.
4. The host needs the platform database; without it the spool is kept.

## Tests

`platform/test/analytics.test.js` runs on a throwaway MariaDB (`mariadb-scratch.js`, a temp
datadir on a random port); without the binaries the database tests report "NOT RUN" with the
reason. They cover: 1 000 requests with bots split out, one visitor per day across an
injected clock, a grep for addresses and UAs in the spool and every row, a SIGKILLed runner,
an nginx import against a hand count, retention prune, and no database.

## Not built

- The beacon `/_vc/a.js` (client-side pageviews for static hosting, SPA route changes).
- Goals from the page (clicks, scroll depth); only `site.track` / `ctx.analytics.track`.
- Horst's weekly digest.
- Viewing a slave's analytics from the master (each host keeps its own database).
- Cross-day visitor identity, sessions and funnels (by design).
- Log formats other than `nginx-combined`.
