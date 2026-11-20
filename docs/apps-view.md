# The Apps view (dashboard, `public/apps.js`)

The All Apps tab is one table, rendered entirely from server state
(`app:list`, `app:grid:meta`, tools, change requests, extras, fleet, deps);
a reload loses nothing. Only collapse and sort are client-side, in
`localStorage['vc.apps.view']`.

## Layout

- **Tab strip** (`#appsTabStrip`): All Apps (a fixed button), the open tabs,
  and **Setup**. The open tabs are a core `TabHost` of kind `apps` (docs/desks.md
  in core): key = the app name, root = the app panel (built once, an iframe
  inside), so a tab has the shared right-click menu with **Move to desk ▸** and
  can be a window on a Desk (the iframe reloads once per move unless the
  browser has `moveBefore`). Apps Guide (`_help`) and Tools (`_tools`) are host
  tabs with `canMove` false. `reopen(name)` opens the tab and starts the app,
  so a desk placeholder's Reopen works; a full-screen app has no tab. All
  per-app DOM updates (`app:started` / `app:stopped` iframe src, pills, power
  button, placeholder) go through `panelOf(name)`, never a query on
  `#apps-content`. Setup sits
  at the right end on every tab (`renderSetupBtn` / `patchSetupBtn`, patched
  on every `refreshGrid`): dot warn on account issues or a missing / lapsed
  Unity licence (`unityLicenceAttention`, from the extras rows sent on
  connect), ok when the db is connected, blinking while accounts are checked;
  issue badge; opens `showSetup('accounts')` on account issues, else
  `showSetup('extras')` for the licence. The Drucker pane (`printSetup` in `public/apps.js`, `docs/print.md`) sits under Remote.
  `?setup=<pane>` in the dashboard URL
  opens that Setup pane once (`openSetupDeepLink`; the publish wizard links a
  slave's `?setup=extras`).
- **Strip** (`renderStrip`): fleet readout, search (`/`), the group filter
  (All · Attention · Running · Stopped · Standalone, with counts), Tools,
  Spend, ?, + New app.
- **Table** (`renderTable`): Horst pinned on top (`#horstCardStatus`, filled
  by `horstModule.fillCardStatus`), then groups by `groupOf(app)`:

| Group | Apps |
|---|---|
| Attention | failed, crashed, autostart stopped, needs restart; also the account-health banner and the Runtime errors list |
| Running | running or starting |
| Stopped | the rest |
| Standalone | `standalone: true` (pm2) |

  Empty groups are hidden; headers show the count (`shown / total` while
  searching) and collapse on click. The bottom row is "describe an app".

## Columns

lamp · **App** (description as tooltip; badges: access, independent, tools,
domain, toolchains, change requests, git) · Runtime · Status (`renderCardTele`
plus "restart needed") · **Disk** · **DB** · **Spend** (`spendAdmin.tile`) ·
**Errors** (`_errors`) · Slaves · Actions · ⚙. Bold columns sort within each
group (name ascending first, metrics biggest first, third click resets).

- **Slaves** (`renderSlaveCell`, master only): one dot per fleet peer from
  `remoteInfo` — green current, amber behind / job failed / unhealthy, hollow
  not published, dim peer offline. Hover `showRemoteTip`, click
  `publishModule.showPublish`. `patchRemoteChips` re-renders the cells on
  `app:fleet:state`.
- **Actions** (`renderRowActions`): fixed slots Start/Stop · Open · Change ·
  Publish; a slot that does not apply is disabled, never removed. Failed or
  crashed rows show Logs + Restart in the first slot. Stop goes through
  `stopAppConfirm`, which names the app-deps consumers and exposed tools
  before `app:stop`. Publish only opens the publish modal.
- **⚙** calls `openAppSettings(name)` (below). The tools and git badges,
  the Spend cell and the Errors / Logs entries open it on their tab.

Row click opens the app (`openApp`); every control in a row stops the click.

## App settings (⚙)

`openAppSettings(name, tab?)`: one `vc-console cfg settings` overlay per app.
Header: lamp, status line (`renderCardTele`), runtime, access; quick actions
Start / Stop / Restart (Restart alone when failed), Open, ⤢ full screen,
Change. A banner shows "restart needed" (with Restart) and a start failure.
The former per-app modals render **into** the tab, never on top of it.

| Tab | Content / actions |
|---|---|
| Overview | disk (→ Open directory), database, spend today (→ Spend), runtime errors (→ Logs); description, edited in place (`app:updateDesc`); Tools · APP.md · Logs · Open directory · Open full screen; the tools list |
| ↳ Tools | the tools view (`toolsViewHtml` / `wireToolsView`): exposure, schema, Test, Edit, + Add New Tool |
| ↳ APP.md | Monaco editor (textarea fallback), Save, Create / Recreate with AI |
| ↳ Logs | server output (`app:logs`), Refresh; reloads when the run state changes |
| Config | `mountAppConfig`: autostart and full screen (applied at once), access level + login channels + licence, Horst & platform (independent), website domain; Save bar in the modal footer |
| Spend & permissions | `spendAdmin.mountPolicy` (the standalone `showPolicy` stays for the Spend overview) |
| Git | branch, changes, ahead / behind; Commit (AI), Push, Refresh |
| Remote | per slave: channel, commit, behind, health, last job; Publish… and History & rollback render inline (`publishModule.showPublish` / `showHistory` with `{ mount, onExit }`). On a slave it says publishing runs on the master |
| Danger | Rename (the guided rename, inline) and Delete (its confirmation, inline) |

- **Opening tab**: the one asked for, else the issue (failed → Logs, restart
  needed → Config, a slave behind → Remote, spend paused → Spend), else the
  last tab of this browser session (`sessionStorage['vc.appSettings.tab']`),
  else Overview.
- **Live**: `refreshGrid` and `patchRemoteChips` call `settingsRefresh()`:
  header, banner and rail dots always; Overview, Git, Remote, Logs and Tools
  re-render in place; editors (Config, Spend, APP.md, an open publish or
  rename flow) are left alone. It closes when the app disappears.
- `showAppActions`, `showTools`, `showLogs`, `showAppMd`, `showGitModal` and
  `editDescription` are aliases that open the matching tab.
