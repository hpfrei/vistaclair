# Desks and TabHost

**Desks** is a header view (between CLIs and Directories). Its sub-tabs are
desks, and each desk is a small window manager. Any second-level tab (a CLI
today; Inspector instances and Apps next) can go onto a desk from its
right-click menu (**Move to desk ▸**). It then lives there as a window, and
its own strip shows it dimmed with an `on desk <name>` chip. Clicking the
chip switches to Desks and brings that window to the front.

One module, **TabHost** (`public/tab-host.js`), drives every second-level
strip. Desks talks to TabHosts only through the registry and has no per-kind
code. A new kind of tab gets Desks by building its strip on a TabHost.

Files:

| File | What |
|------|------|
| `public/tab-host.js` | `createTabHost`, the `window.tabHosts` registry |
| `public/tab-context-menu.js` | the shared right-click menu (`window.tabContextMenu`) |
| `public/desk-layout.js` | pure helpers: fractions ↔ px, clamp, snap, tile, resize, restore planner |
| `public/desks.js`, `public/desks.css` | the Desks view and window manager (`window.desksView`) |
| `src/desks.js` | the server store, `data/desks.json` |
| `src/ws/desks-handler.js` | the `desks:*` socket messages |
| `public/cli.js` | the reference user: the CLIs strip on a TabHost |

## The content contract

For each tab, a kind gives its TabHost one object:

```js
{ key, title, root, setShown(visible), destroy(), focus?(), icon? }
```

- **key** is a stable string that survives a refresh and a server restart.
  It is what `data/desks.json` stores. Never use a per-boot id.
  - CLI: `settings.name || sessId`. Tab ids (`tab-<bootId>-<n>`) die on
    restart, so they are never the key.
  - Inspector: `instanceId` (`cli-<sessId>`).
  - Apps: the app name.

  Until a CLI knows its session, it uses a temporary `tab:<tabId>` key. The
  host's `canMove(key)` option returns false for such a key, so it cannot go
  onto a desk. When the real key arrives, call `host.rekey(from, to)`; the
  desk entry follows (`desks:rekey`).
- **root** is an HTMLElement built once and owned by the tab. TabHost moves it
  between the home content area and a desk window body, and never rebuilds
  it. It must keep working wherever it is in the page. A desk window body is
  a flex column, so a `flex: 1` root fills it, as `.cli-terminal-wrap` does.
  - Moves use `Element.moveBefore` where the browser has it (Chrome 133+), so
    an iframe inside does not reload. Elsewhere an iframe reloads once per
    move to or from a desk.
  - Switching desks never moves anything: other desks are only hidden with
    `display: none`.
- **setShown(bool)** is called whenever root becomes visible or hidden.
  - Shown means one of two things: it is the selected tab of its home strip,
    or it is a window on the selected desk that is not minimized.
  - It is called again with `true` after its window is moved, resized,
    maximized or snapped, or the desk area changes size. Treat that call as
    "refit now", so make `setShown(true)` idempotent.
  - Switching header views (Inspector, CLIs, Desks…) does **not** call it. A
    content that needs a size when its view comes back should use a
    ResizeObserver; `cli.js` refits xterm that way.
  - While shown, keep feeds live. Hidden content may release them (an SDK
    panel drops its feed after 60 s hidden).
- **destroy()** releases everything. The host calls it from `host.remove(key)`,
  and only a tab's own close should call that.
- **focus()** (optional) puts the keyboard in the tab. The host calls it when
  the tab is selected from the strip or its window is raised. It is not part
  of `setShown`: when a desk shows many windows, the keyboard must not jump
  to each one.
- **icon** (optional): the host's `icon` is used for desk title bars and the
  taskbar.
- **Busy** is not part of the object: the kind calls `host.setBusy(key, bool)`
  whenever its tab starts or stops working (a CLI streaming). It is how
  Desks learns of it, with no per-kind code. Where the dot shows:
  - the tab's strip button (`.instance-running`, drawn by the host, on a desk
    too: the dimmed entry keeps it);
  - on a desk: the window's title bar (`.busy-dot`), that desk's sub-tab and
    the **Desks** header tab;
  - the kind's own header tab only for tabs at home. `cli.js` counts a CLI on
    a desk toward Desks, not toward the **CLIs** header tab.
  On a phone desks are ignored, so a busy tab counts at home again.

## createTabHost

```js
const host = createTabHost({
  kind: 'cli',              // [a-z][a-z0-9_-]*, unique per kind; stored in desks.json
  label: 'CLI', icon: '⌨',  // shown in desk windows and placeholders
  homeView: 'claude',       // the header view of its strip (data-view)
  stripEl, beforeEl,        // the strip, and the element tab buttons go before (e.g. the + button)
  contentEl,                // where home roots live (a flex column)
  reopen: async (key) => bool,      // a desk placeholder's Reopen: open the tab again; true if it will come
  extraMenuItems: (key) => items,   // the kind's own right-click items (after the desk items)
  decorate: (key, btn, labelEl, { onDesk }) => {},  // the kind's badges and buttons on the strip button
  onSelect: (key | null) => {},     // the kind's "show this tab" (default: host.activate)
  canMove: (key) => bool,           // optional; false hides Move to desk for that key
  afterRender: () => {},            // optional; after every strip render
});
```

### Methods

| Method | What it does |
|--------|--------------|
| `add(content)` | Checks the contract (throws on a bad one or a duplicate key), puts root (hidden) in `contentEl`, draws the strip. If the key is on a desk, Desks mounts it there. |
| `remove(key)` | The tab is closed: calls `destroy()`, takes root out of the page. A desk window holding it becomes a placeholder, and its entry is kept. |
| `activate(key \| null)` | Shows this home tab and hides every other home tab. **A tab on a desk is never touched.** Returns false for a tab on a desk. `null` means none: the CLI's Sessions tab uses that. |
| `select(key)` | What a click on the tab does. A tab on a desk goes to its window; otherwise it calls `onSelect(key)`. |
| `focus(key)` | Calls `content.focus()`. |
| `update(key, { title })` | Sets a new title and redraws the strip and its window title. |
| `rekey(from, to)` | The tab's stable key arrived. The desk entry follows. |
| `render()` | Redraws the strip buttons. The host owns `.view-tab[data-tab-key]` in `stripEl`, and anything else in the strip is yours. |
| `setOrder(keys)` | Sets the strip order. |
| `has(key)`, `get(key)` → content, `keys()`, `activeKey()`, `isOnDesk(key)`, `isShown(key)` | Lookups. |
| `menuItems(key)` | The right-click items (used by the strip; exposed for tests). |
| `reopen(key)` | Calls `opts.reopen` and turns any error into `false`. |
| `setBusy(key, bool)`, `isBusy(key)`, `busyKeys()` | The busy flag (see Busy above). A change emits a registry `busy` event; the strip button is patched, not redrawn. |

These methods are for **Desks only**:

| Method | What it does |
|--------|--------------|
| `attachToDesk(key, bodyEl, desk)` | Moves root into a window body. If it was the shown home tab, `onSelect(next home tab or null)` runs. |
| `detachFromDesk(key)` | Moves root back home, hidden. |
| `setDeskShown(key, bool)` | Shows or hides it in its window. |
| `setDeskInfo(key, desk)` | Updates the chip after a desk rename. |
| `refit(key)` | Calls `setShown(true)` again if it is shown. |

The host never chooses on its own which home tab to show, with one
exception: when the shown tab leaves for a desk, it asks `onSelect`. If you
supply `onSelect`, it must end in `host.activate(key)`. The CLI's
`switchTab` does this, and keeps its own state alongside.

### Strip and menu

Each tab button is `button.view-tab.tab-host-tab[data-tab-key][data-tab-kind]`
with a `span.tab-host-label` (the title). A tab on a desk gets
`.tab-on-desk` and a `span.tab-desk-chip`. After that, `decorate` adds the
kind's own parts.

- **Right-click** and **long press** open `tabContextMenu`:
  - **Move to desk ▸**: every other desk, then **New desk…**, an inline name
    field that creates the desk and moves the tab.
  - While the tab is on a desk: **Show on desk "…"** and **Return here**.
  - Then the kind's `extraMenuItems`.
- A menu item is `{ label, title?, onClick?, danger?, disabled?, submenu?, input?: { placeholder, onSubmit(text) } }`
  or `{ divider: true }`. Use `tabContextMenu.open(items, { x, y })` /
  `attach(el, getItems)` for other menus, so they look the same.
- For CLIs, `extraMenuItems` gives what the × menu gives: Close, Close and
  remove interaction, and every add-on action from
  `dashboard.registerTabAction`.

### Registry: `window.tabHosts`

- `register(host)` is automatic in `createTabHost`.
- `get(kind)`, `all()`.
- `on(fn)`: events `{ type: 'register' | 'add' | 'remove' | 'rekey' | 'update' | 'busy', kind, key, from?, to?, busy? }`.
- `setDeskProvider(p)` / `desks()`: the provider while desks are available.
  It is `null` on a phone and until the server has sent `desks:state`.

Desks (`public/desks.js`) is the provider:

```js
{ enabled(), list() → [{ id, name }], deskOf(kind, key) → { id, name } | null,
  moveTo(kind, key, deskId, title), createAndMove(kind, key, name, title),
  show(kind, key), returnHome(kind, key, { activate }) }
```

## Desks view

- **Desk sub-tabs:**
  - **+** creates a desk.
  - Double-click renames.
  - Right-click offers Rename, Tile all and Delete desk.
  - The active desk is remembered per browser (localStorage).
- **Windows:**
  - Drag by the title bar. Resize from any edge or corner. A click raises.
  - Drag to the left or right edge for a half, to a corner for a quarter, or
    to the top edge to maximize.
  - Double-click the title bar to maximize or restore.
  - Title bar buttons: ⤺ Return here, – minimize, □ maximize.
- **Taskbar** lists every window, minimized ones included. A click restores
  a window and raises it.
- **Tile all** lays out every window of the desk in a grid.
- **Geometry** is stored as fractions of the desk area (`{ x, y, w, h }`)
  and drawn as percentages. When the area changes size, windows are clamped
  back into view (minimum 220×120 px).
- **Placeholders:**
  - The window's tab is not open: **Reopen** (`host.reopen(key)`) and
    **Remove from desk**.
  - Its kind has no TabHost here, for example an add-on not installed: a note
    and **Remove from desk**. The entry is kept.

## Never lose a tab

Each guarantee has a unit test.

1. **A tab is in exactly one place**: its home strip or one desk window. It
   always stays listed in its home strip.
   - Tests: `test/tab-host.test.js`, "a tab on a desk stays in its home strip…".
2. **Desk state lives on the server**, in `data/desks.json` (`src/desks.js`).
   - Writes are atomic: a temporary file, then rename.
   - A corrupt file is moved to `desks.json.corrupt-<ts>`, and the store
     starts empty without crashing.
   - Every change is broadcast as `desks:state` to every dashboard.
   - Geometry saves are debounced (400 ms).
   - Tests: `test/desks-store.test.js`.
3. **Restore**: an open tab is mounted, a missing tab gets a placeholder, an
   unknown kind gets a placeholder, and no entry is dropped silently.
   - Tests: `test/desks-layout.test.js` (planner) and
     `test/desks-controller.test.js`.
4. **Closing a window** (Return here) sends the tab home and does not close
   it.
   - Deleting a desk sends its tabs home and shows an Undo toast.
   - Only a tab's own close closes it, and its window then becomes a
     placeholder.
   - Tests: `test/desks-controller.test.js`, `test/desks-cli.test.js`.
5. **Moving a tab to desk B takes it off desk A.** The store enforces this
   in move, restore and load.
   - Tests: `test/desks-store.test.js`, `test/desks-controller.test.js`.

**Phones** (`max-width: 640px`):

- There is no Desks header entry or mobile entry, and no Move to desk item.
- Desk membership is ignored: every tab shows in its home strip.
- The desk state is not changed. Crossing back to desktop width puts the
  tabs back in their windows.

## Socket messages (`desks:*`)

The server sends `desks:state { state }` on connect and after every change.
`desks:error { op, error }` goes to the sender only.

The client sends:

| Message | Fields |
|---------|--------|
| `desks:create` | `{ id, name }` — the client mints `id` (`[A-Za-z0-9_-]{1,64}`), so create + move can go back to back |
| `desks:rename` | `{ id, name }` |
| `desks:delete` | `{ id }` |
| `desks:restore` | `{ desk, index }` — Undo of a delete. Windows whose tab is on another desk by now are skipped |
| `desks:move` | `{ deskId, kind, key, title?, geom? }` |
| `desks:return` | `{ kind, key }` |
| `desks:rekey` | `{ kind, from, to }` |
| `desks:window` | `{ deskId, kind, key, patch: { geom?, z?, minimized?, maximized?, title? } }` |
| `desks:windows` | `{ deskId, windows: [{ kind, key, patch }] }` |
| `desks:get` | `{}` |

State: `{ version: 1, desks: [{ id, name, windows: [{ kind, key, title, geom, z, minimized, maximized }] }] }`.

## Adding a kind (Inspector, Apps)

1. Build each tab's content once (`root` and the rest of the contract) and
   `host.add(content)` it. Do not create the strip buttons yourself; use
   `decorate` for extras.
2. Show a tab with `host.activate(key)` (or `host.select(key)` from a click
   handler). Never set `display` on every root in a loop: that would hide
   desk windows. `test/tab-host.test.js` checks cli.js for this pattern.
3. Close a tab with `host.remove(key)`.
4. Supply `reopen(key)`. Desks shows its result: when it returns true and the
   tab comes back with the same key, the placeholder turns back into the tab.
5. Load order: `tab-context-menu.js`, `tab-host.js` and `desk-layout.js`
   load before `core.js`'s users (right after `tab-hooks.js`), and `desks.js`
   loads after `mobile.js`. A host registered late (an add-on module) is
   picked up through the registry's `register` event.
