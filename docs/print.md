# Printing (`ctx.print`, Setup → Drucker)

Apps print a PDF on the printer attached to the platform host, through CUPS.
Nothing prints until the owner has picked a printer, switched printing on and
put the app on the allow list.

| File | Role |
|---|---|
| `src/apps/platform-print.js` | the engine: CUPS discovery, settings, the print path, page count, cap, job log |
| `src/apps/capabilities/print.js` | the app face: `ctx.print.status/pdf` and Bridge `print.status/pdf` (app identity = `app.name`) |
| `src/apps/index.js` | `app:print:get/save/test` WS messages (owner only) + `platform-print.init` |
| `public/apps.js` (`printSetup`) | the Setup → Drucker panel (inside the existing client module: a new script would be unreachable on a running server until restart) |
| `test/print.test.js`, `test/fixtures/print/` | offline tests; CUPS is stubbed, real `lpstat` output is the fixture |

## State

One file, `<appsDir>/.platform-print.json`, written atomically: `settings`,
`usage` (pages per app per local day, last 8 days kept), `jobs` (last 200).
A reload or restart loses nothing; the panel is a render of server state.

| Setting | Default |
|---|---|
| `enabled` | `false` — also needs a selected printer |
| `printer` | `null` (a CUPS destination name) |
| `allowedApps` | `["gymihorst"]` |
| `dailyPageCap` | `60` per app, pages × copies, resets at the host's local midnight |
| `duplex` | `false` (default when a call does not say) |

## CUPS

On demand only, no polling. `lpstat -p -d` (printers, state, default; none is
normal) and `lpstat -v` (device URIs), run with `LC_ALL=C` so the English text
the parser reads is what CUPS prints. States: idle, printing, disabled,
stopped, unknown; `online` is false for disabled / stopped. Every command is
`execFile` with an argument array; nothing a caller wrote reaches a shell.

`lp -d <printer> -n <copies> [-o sides=two-sided-long-edge] -t <title> <tmpfile>`
— the printer is always one `lpstat` lists right now; the title has control
characters stripped and is cut at 80 characters; the PDF goes to a `0600`
temp file that is removed afterwards. The job id comes from
`request id is X-42 (1 file(s))`.

## The app surface

- `status()` → `{ available, printer, online, pagesLeftToday }`. `available` =
  enabled AND the selected printer still listed AND the caller allowed;
  otherwise `printer` is `null` and `pagesLeftToday` is `null`.
- `pdf({ pdf?, pdfBase64?, title, copies?, duplex? })` → `{ ok, jobId, printer,
  pages, error? }`. `pdf` is a `vc-artifact://` uri the app may read (checked
  with `app-artifacts.canRead` as `{ type: 'app', app }`); `copies` is clamped
  to 1–5. It never throws: a rejection is `ok: false` with `error`, and a
  rejection costs no pages and runs no `lp`. Rejected: not enabled, app not
  allowed, no printer, printer not listed or disabled / stopped, no `%PDF-`
  magic, over 20 MB (checked before decode / read), unreadable artifact, page
  count unknown, daily cap exceeded.
- Pages: `pdfinfo`, else `qpdf --show-npages`, else a scan counting
  `/Type /Page` objects (not `/Pages`). The scan sees no page packed in a
  compressed object stream; it then reports 0 and the PDF is refused.
- The cap is reserved before `lp` runs and handed back if `lp` fails.

Lane (`docs/horst-lanes.md`): `print.pdf` is `never` — a physical, outward act;
`print.status` is deferred. Not revocable (the allow list is the control), not
in a standalone app (the engine lives in the dashboard process).

## Setup → Drucker

Owner only (`ownerConnection`). Detected printers with state and device, pick
one, enable, default duplex, allowed apps (comma list), daily cap, **Testseite
drucken** (a one-page A4 PDF generated in code; needs a selected printer, skips
enabled / allow list / cap, still needs the printer online) and the last 20
jobs. A job's status is read on demand from `lpstat -o` (queued) and
`lpstat -W completed -o` (done); `unknown` once CUPS has forgotten it.

## Not built

- Page ranges, paper size / tray / colour options, `fit-to-page`: the printer's
  own defaults apply.
- Several printers per app, or a per-app daily cap (one cap for every app).
- Printing from non-PDF input; Horst printing (no card kind).
- Cancelling a job, or a live job-status push to the panel.
- Network printer discovery or adding a printer to CUPS.
- Page counting inside compressed object streams without `pdfinfo` / `qpdf`.
