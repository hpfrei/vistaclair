// Desks: the header view whose sub-tabs are desks, each a small window
// manager. Any TabHost tab (public/tab-host.js: CLIs, Inspector, Apps) can
// be put on a desk from its right-click menu; it then lives in a window here
// and its home strip shows it dimmed with an "on desk <name>" chip.
//
// The server holds the truth (src/desks.js via desks:* messages); this
// module renders it and moves each tab's content.root into its window. It
// knows nothing about any kind: it talks to TabHosts through window.tabHosts
// only. docs/desks.md describes the API.
//
// Never lose a tab:
//   - a window's root is only ever moved between its home area and its
//     window body (TabHost.attachToDesk / detachFromDesk), never dropped;
//     a window element is removed only after its root went home;
//   - a window whose tab is not open shows a placeholder (Reopen / Remove
//     from desk); one whose kind has no TabHost here (an add-on not
//     installed) shows a placeholder and its entry is kept;
//   - closing a window (Return here) sends the tab home, it does not close
//     the session; deleting a desk sends its tabs home and offers Undo;
//   - on a phone desk membership is ignored (every tab shows at home) and
//     the desk state is left as it is.
(function (root) {
  const L = root.deskLayout;
  const SAVE_MS = 400;
  const ACTIVE_KEY = 'vc.desks.active';

  const wid = (kind, key) => `${kind}\u0000${key}`;

  function createDesks(opts) {
    const o = opts || {};
    const registry = o.registry || root.tabHosts;
    const doc = o.document || root.document;
    const send = o.send;
    const toast = o.toast || (() => {});
    const isPhone = o.isPhone || (() => false);
    const storage = o.storage || null;
    const switchView = o.switchView || (() => {});
    const newId = o.newId || (() => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    const els = o.elements || {};   // { view, headerTab, strip, area, taskbar, tileBtn, newBtn, empty }

    let state = null;                // the server's, null until desks:state
    let activeDeskId = null;
    try { activeDeskId = storage?.getItem(ACTIVE_KEY) || null; } catch {}
    const pending = new Map();       // wid -> { deskId, kind, key, patch } not yet sent
    let saveTimer = null;
    const deskEls = new Map();       // deskId -> { el, wins: Map(wid -> rec) }

    const enabled = () => !!state && !isPhone();
    const desks = () => state?.desks || [];
    const deskById = (id) => desks().find(d => d.id === id) || null;
    function locate(kind, key) {
      for (const d of desks()) {
        const w = d.windows.find(x => x.kind === kind && x.key === key);
        if (w) return { desk: d, win: w };
      }
      return null;
    }

    // ---- server state in ----

    function applyState(s) {
      if (!s || !Array.isArray(s.desks)) return;
      state = JSON.parse(JSON.stringify(s));
      // Local changes not yet saved win over an older echo.
      for (const p of pending.values()) {
        const at = locate(p.kind, p.key);
        if (at && at.desk.id === p.deskId) Object.assign(at.win, p.patch);
      }
      if (!deskById(activeDeskId)) setActive(desks()[0]?.id || null, { quiet: true });
      render();
    }

    function handleMessage(msg) {
      if (msg.type === 'desks:state') applyState(msg.state);
      else if (msg.type === 'desks:error') toast({ sender: 'Desks', level: 'warning', message: `Desk change refused: ${msg.error}` });
    }

    // ---- changes out ----

    function patchWindow(deskId, kind, key, patch, { now = false } = {}) {
      const at = locate(kind, key);
      if (at && at.desk.id === deskId) Object.assign(at.win, patch);
      const id = wid(kind, key);
      const p = pending.get(id);
      if (p && p.deskId === deskId) Object.assign(p.patch, patch);
      else pending.set(id, { deskId, kind, key, patch: { ...patch } });
      clearTimeout(saveTimer);
      if (now) flush();
      else saveTimer = setTimeout(flush, SAVE_MS);
    }

    function flush() {
      clearTimeout(saveTimer);
      saveTimer = null;
      for (const p of pending.values()) send({ type: 'desks:window', deskId: p.deskId, kind: p.kind, key: p.key, patch: p.patch });
      pending.clear();
    }

    function setActive(id, { quiet } = {}) {
      activeDeskId = id;
      try { if (id) storage?.setItem(ACTIVE_KEY, id); } catch {}
      if (!quiet) render();
    }

    function createDesk(name) {
      const id = newId();
      send({ type: 'desks:create', id, name: name || `Desk ${desks().length + 1}` });
      setActive(id, { quiet: true });
      return id;
    }

    function moveTo(kind, key, deskId, title) {
      const d = deskById(deskId);
      const geom = L.cascade(d ? d.windows.length : 0);
      send({ type: 'desks:move', deskId, kind, key, title: title || '', geom });
    }

    function createAndMove(kind, key, name, title) {
      const id = createDesk(name);
      send({ type: 'desks:move', deskId: id, kind, key, title: title || '', geom: L.cascade(0) });
      return id;
    }

    // Home again. Applied here at once (so "Return here" can show it in its
    // strip right away); the server's echo agrees.
    function returnHome(kind, key, { activate } = {}) {
      if (!locate(kind, key)) return;
      pending.delete(wid(kind, key));
      for (const d of desks()) d.windows = d.windows.filter(w => !(w.kind === kind && w.key === key));
      send({ type: 'desks:return', kind, key });
      render();
      const host = registry.get(kind);
      if (activate && host?.has(key)) {
        if (host.homeView) switchView(host.homeView);
        host.select(key);
        host.focus(key);
      }
    }

    function show(kind, key) {
      const at = locate(kind, key);
      if (!at) return;
      switchView('desks');
      setActive(at.desk.id);
      if (at.win.minimized) patchWindow(at.desk.id, kind, key, { minimized: false }, { now: true });
      raise(at.desk.id, kind, key);
    }

    function raise(deskId, kind, key, { focus = true } = {}) {
      const d = deskById(deskId);
      const w = d?.windows.find(x => x.kind === kind && x.key === key);
      if (!w) return;
      const top = d.windows.reduce((m, x) => Math.max(m, x.z || 0), 0);
      if (w.z !== top || d.windows.filter(x => x.z === top).length > 1) patchWindow(deskId, kind, key, { z: top + 1 });
      render();
      if (focus) registry.get(kind)?.focus(key);
    }

    function deleteDesk(id) {
      const index = desks().findIndex(d => d.id === id);
      if (index < 0) return;
      const copy = JSON.parse(JSON.stringify(desks()[index]));
      send({ type: 'desks:delete', id });
      // Its tabs go home now; the echo agrees.
      state.desks.splice(index, 1);
      if (activeDeskId === id) setActive(desks()[Math.min(index, desks().length - 1)]?.id || null, { quiet: true });
      render();
      const n = copy.windows.length;
      toast({
        sender: 'Desks', level: 'info', duration: 12000,
        title: `Desk "${copy.name}" deleted`,
        message: n ? `${n} tab${n === 1 ? '' : 's'} went back to ${n === 1 ? 'its' : 'their'} strip${n === 1 ? '' : 's'}.` : 'It was empty.',
        actions: [{ label: 'Undo', onClick: () => { send({ type: 'desks:restore', desk: copy, index }); setActive(copy.id, { quiet: true }); } }],
      });
    }

    function renameDesk(id, name) {
      const n = String(name || '').trim();
      if (!n || !deskById(id)) return;
      send({ type: 'desks:rename', id, name: n });
    }

    function tileAll(deskId = activeDeskId) {
      const d = deskById(deskId);
      if (!d || !d.windows.length) return;
      const list = d.windows.slice().sort((a, b) => (a.z || 0) - (b.z || 0));
      const rects = L.tile(list.length);
      const windows = list.map((w, i) => ({ kind: w.kind, key: w.key, patch: { geom: rects[i], minimized: false, maximized: false } }));
      for (const x of windows) { pending.delete(wid(x.kind, x.key)); Object.assign(d.windows.find(w => w.kind === x.kind && w.key === x.key), x.patch); }
      send({ type: 'desks:windows', deskId, windows });
      render();
    }

    // ---- the provider TabHosts ask (window.tabHosts.desks()) ----

    const provider = {
      enabled,
      list: () => desks().map(d => ({ id: d.id, name: d.name })),
      deskOf(kind, key) { const at = locate(kind, key); return at ? { id: at.desk.id, name: at.desk.name } : null; },
      moveTo, createAndMove, show, returnHome,
    };

    // ---- hosts <-> windows ----

    // Every host's tab where the state says: in its window when on a desk
    // (and desks are on here), else at home. Roots go home before any window
    // element that held them is removed.
    function reconcile() {
      const on = enabled();
      for (const host of registry.all()) {
        for (const key of host.keys()) {
          const at = on ? locate(host.kind, key) : null;
          if (!at) { if (host.isOnDesk(key)) host.detachFromDesk(key); continue; }
          const rec = deskEls.get(at.desk.id)?.wins.get(wid(host.kind, key));
          if (!rec) continue;
          const content = host.get(key);
          if (!host.isOnDesk(key) || content.root.parentNode !== rec.body) host.attachToDesk(key, rec.body, at.desk);
          else host.setDeskInfo(key, at.desk);
        }
      }
    }

    function syncShown() {
      const on = enabled();
      for (const d of desks()) {
        for (const w of d.windows) {
          const host = registry.get(w.kind);
          if (!host?.has(w.key) || !host.isOnDesk(w.key)) continue;
          host.setDeskShown(w.key, on && d.id === activeDeskId && !w.minimized);
        }
      }
    }

    // ---- DOM ----

    const mk = (tag, cls, text) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    };

    function statusOf(w) {
      const host = registry.get(w.kind);
      return L.planRestore([w], { hasKind: () => !!host, hasTab: () => !!host?.has(w.key) })[0].status;
    }

    function buildWindow(d, w) {
      const el = mk('div', 'desk-win');
      el.dataset.kind = w.kind;
      el.dataset.key = w.key;
      const bar = mk('div', 'desk-win-bar');
      const icon = mk('span', 'desk-win-icon');
      const title = mk('span', 'desk-win-title');
      const busyDot = mk('span', 'busy-dot desk-win-busy-dot');
      busyDot.title = 'Working';
      busyDot.style.display = 'none';
      const btns = mk('span', 'desk-win-btns');
      const retBtn = mk('button', 'desk-win-btn desk-win-return', '⤺');
      retBtn.title = 'Return here: back to its own strip (the session keeps running)';
      const minBtn = mk('button', 'desk-win-btn desk-win-min', '–');
      minBtn.title = 'Minimize';
      const maxBtn = mk('button', 'desk-win-btn desk-win-max', '□');
      maxBtn.title = 'Maximize / restore';
      const delBtn = mk('button', 'desk-win-btn desk-win-remove', '×');
      delBtn.title = 'Remove from desk';
      btns.append(retBtn, minBtn, maxBtn, delBtn);
      bar.append(icon, title, busyDot, btns);
      const body = mk('div', 'desk-win-body');
      el.append(bar, body);
      for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
        const h = mk('div', `desk-rs desk-rs-${dir}`);
        h.dataset.dir = dir;
        el.appendChild(h);
      }
      const rec = { el, bar, icon, title, busyDot, body, retBtn, delBtn, maxBtn, deskId: d.id, kind: w.kind, key: w.key, status: null, ph: null };
      const cur = () => locate(rec.kind, rec.key);
      retBtn.addEventListener('click', (e) => { e.stopPropagation(); returnHome(rec.kind, rec.key); });
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); returnHome(rec.kind, rec.key); });
      minBtn.addEventListener('click', (e) => { e.stopPropagation(); patchWindow(rec.deskId, rec.kind, rec.key, { minimized: true }); render(); });
      maxBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMax(rec); });
      bar.addEventListener('dblclick', (e) => { if (!e.target.closest?.('.desk-win-btn')) toggleMax(rec); });
      el.addEventListener('mousedown', () => { if (cur()) raise(rec.deskId, rec.kind, rec.key, { focus: false }); }, true);
      bar.addEventListener('pointerdown', (e) => startDrag(e, rec));
      for (const h of el.querySelectorAll('.desk-rs')) h.addEventListener('pointerdown', (e) => startResize(e, rec, h.dataset.dir));
      root.tabContextMenu?.attach(bar, () => {
        const host = registry.get(rec.kind);
        const items = [];
        const others = desks().filter(x => x.id !== rec.deskId);
        if (host?.has(rec.key) && others.length) items.push({ label: 'Move to desk', submenu: others.map(x => ({ label: x.name, onClick: () => moveTo(rec.kind, rec.key, x.id, host.get(rec.key)?.title) })) });
        items.push({ label: rec.status === 'mount' ? 'Return here' : 'Remove from desk', onClick: () => returnHome(rec.kind, rec.key) });
        return items;
      });
      return rec;
    }

    function toggleMax(rec) {
      const at = locate(rec.kind, rec.key);
      if (!at) return;
      patchWindow(rec.deskId, rec.kind, rec.key, { maximized: !at.win.maximized });
      raise(rec.deskId, rec.kind, rec.key);
      render();
      registry.get(rec.kind)?.refit(rec.key);
    }

    function placeholder(rec, w, status) {
      const host = registry.get(w.kind);
      const box = mk('div', 'desk-placeholder');
      const name = w.title || w.key;
      if (status === 'unregistered') {
        box.appendChild(mk('div', 'desk-ph-title', name));
        box.appendChild(mk('div', 'desk-ph-text', `Nothing here shows "${w.kind}" tabs (its add-on is not installed or not loaded). The window is kept until you remove it.`));
      } else {
        box.appendChild(mk('div', 'desk-ph-title', name));
        box.appendChild(mk('div', 'desk-ph-text', `This ${host?.label || w.kind} tab is not open.`));
        const reopen = mk('button', 'desk-ph-btn desk-ph-reopen', 'Reopen');
        reopen.addEventListener('click', async (e) => {
          e.stopPropagation();
          reopen.disabled = true;
          const ok = await host.reopen(w.key);
          reopen.disabled = false;
          if (!ok) toast({ sender: 'Desks', level: 'warning', message: `Could not reopen "${name}".` });
        });
        box.appendChild(reopen);
      }
      const rm = mk('button', 'desk-ph-btn desk-ph-remove', 'Remove from desk');
      rm.addEventListener('click', (e) => { e.stopPropagation(); returnHome(w.kind, w.key); });
      box.appendChild(rm);
      return box;
    }

    function drawWindow(rec, d, w) {
      const host = registry.get(w.kind);
      const status = statusOf(w);
      const title = (host?.get(w.key)?.title) || w.title || w.key;
      rec.icon.textContent = host?.icon || '?';
      rec.icon.title = host?.label || w.kind;
      rec.title.textContent = title;
      rec.title.title = title;
      rec.retBtn.style.display = status === 'mount' ? '' : 'none';
      rec.delBtn.style.display = status === 'mount' ? 'none' : '';
      if (status !== rec.status) {
        rec.ph?.remove();
        rec.ph = status === 'mount' ? null : rec.body.appendChild(placeholder(rec, w, status));
        rec.status = status;
      }
      rec.el.classList.toggle('desk-win-placeholder', status !== 'mount');
      rec.el.classList.toggle('maximized', !!w.maximized);
      rec.el.classList.toggle('minimized', !!w.minimized);
      const g = w.geom;
      rec.el.style.left = (g.x * 100) + '%';
      rec.el.style.top = (g.y * 100) + '%';
      rec.el.style.width = (g.w * 100) + '%';
      rec.el.style.height = (g.h * 100) + '%';
      rec.el.style.zIndex = String(1 + (w.z || 0));
      rec.el.style.display = w.minimized ? 'none' : '';
      const top = d.windows.reduce((m, x) => (x.minimized ? m : Math.max(m, x.z || 0)), -Infinity);
      rec.el.classList.toggle('desk-win-top', !w.minimized && (w.z || 0) === top);
      if (host?.has(w.key) && title !== w.title && !pending.has(wid(w.kind, w.key))) {
        patchWindow(d.id, w.kind, w.key, { title });
      }
    }

    function render() {
      if (!els.area) { reconcile(); syncShown(); return; }
      const live = new Set(desks().map(d => d.id));
      // New desks and windows first, so reconcile can move roots into them.
      for (const d of desks()) {
        let de = deskEls.get(d.id);
        if (!de) {
          de = { el: mk('div', 'desk-area'), wins: new Map() };
          de.el.dataset.deskId = d.id;
          els.area.appendChild(de.el);
          deskEls.set(d.id, de);
        }
        de.el.style.display = d.id === activeDeskId ? '' : 'none';
        for (const w of d.windows) {
          const id = wid(w.kind, w.key);
          if (!de.wins.has(id)) {
            const rec = buildWindow(d, w);
            de.wins.set(id, rec);
            de.el.appendChild(rec.el);
          }
        }
      }
      reconcile();
      // Then what is gone: its roots went home in reconcile.
      for (const [deskId, de] of deskEls) {
        const d = deskById(deskId);
        for (const [id, rec] of de.wins) {
          if (d && d.windows.some(w => wid(w.kind, w.key) === id)) continue;
          const host = registry.get(rec.kind);
          if (host?.has(rec.key) && rec.body.contains(host.get(rec.key).root)) host.detachFromDesk(rec.key);
          rec.el.remove();
          de.wins.delete(id);
        }
        if (!live.has(deskId)) { de.el.remove(); deskEls.delete(deskId); }
      }
      for (const d of desks()) {
        const de = deskEls.get(d.id);
        for (const w of d.windows) drawWindow(de.wins.get(wid(w.kind, w.key)), d, w);
      }
      syncShown();
      renderStrip();
      renderTaskbar();
      renderBusy();
      if (els.empty) {
        els.empty.style.display = desks().length && deskById(activeDeskId)?.windows.length ? 'none' : '';
        els.empty.textContent = !state ? 'Desks need the server to be restarted once (the desks store is new).'
          : !desks().length ? 'No desks yet. Press + to make one, or right-click a CLI tab → Move to desk.'
            : 'This desk is empty. Right-click a CLI tab → Move to desk.';
      }
      if (els.tileBtn) els.tileBtn.disabled = !(deskById(activeDeskId)?.windows.length);
    }

    function renderStrip() {
      const strip = els.strip;
      if (!strip) return;
      for (const b of strip.querySelectorAll('.desk-tab')) b.remove();
      for (const d of desks()) {
        const b = mk('button', 'view-tab desk-tab' + (d.id === activeDeskId ? ' active' : ''));
        b.dataset.deskId = d.id;
        const label = mk('span', 'desk-tab-label', d.name);
        b.appendChild(label);
        if (d.windows.length) b.appendChild(mk('span', 'desk-tab-count', String(d.windows.length)));
        b.title = 'Double-click to rename; right-click for more';
        b.addEventListener('click', () => setActive(d.id));
        b.addEventListener('dblclick', () => askRename(d.id));
        root.tabContextMenu?.attach(b, () => [
          { label: 'Rename', onClick: () => askRename(d.id) },
          { label: 'Tile all', onClick: () => tileAll(d.id) },
          { divider: true },
          { label: 'Delete desk', danger: true, title: 'Its tabs go back to their strips', onClick: () => deleteDesk(d.id) },
        ]);
        strip.insertBefore(b, els.newBtn && els.newBtn.parentNode === strip ? els.newBtn : null);
      }
    }

    // A busy tab on a desk (the host's isBusy, any kind) shows the dot on its
    // window's title bar, on that desk's tab and on the Desks header tab.
    function renderBusy() {
      const on = enabled();
      let any = false;
      for (const d of desks()) {
        let deskBusy = false;
        const de = deskEls.get(d.id);
        for (const w of d.windows) {
          const host = registry.get(w.kind);
          const busy = on && !!host?.has(w.key) && host.isOnDesk(w.key) && host.isBusy?.(w.key) === true;
          if (busy) deskBusy = true;
          const rec = de?.wins.get(wid(w.kind, w.key));
          if (rec) { rec.el.classList.toggle('desk-win-busy', busy); rec.busyDot.style.display = busy ? '' : 'none'; }
        }
        if (deskBusy) any = true;
        const b = Array.from(els.strip?.querySelectorAll('.desk-tab') || []).find(x => x.dataset.deskId === d.id);
        if (b) b.classList.toggle('instance-running', deskBusy);
      }
      els.headerTab?.classList.toggle('instance-running', any);
    }

    // Rename asks in the dashboard's own dialog (core.js showPrompt), which
    // lives on document.body, outside the strip: a re-render of the strip
    // (a state broadcast, a busy dot, the click that selects the tab) cannot
    // drop it. Empty, unchanged or cancelled sends nothing.
    let renaming = null;             // desk id of the open dialog
    async function askRename(deskId) {
      const d = deskById(deskId);
      const ask = o.prompt || root.showPrompt;
      if (!d || !ask || renaming) return;
      renaming = deskId;
      try {
        const name = await ask('Rename desk', { defaultValue: d.name, confirmLabel: 'Rename' });
        const cur = deskById(deskId);
        if (name == null || !cur || String(name).trim() === cur.name) return;
        renameDesk(deskId, name);
      } finally { renaming = null; }
    }

    function renderTaskbar() {
      const bar = els.taskbar;
      if (!bar) return;
      bar.replaceChildren();
      const d = deskById(activeDeskId);
      if (!d) return;
      for (const w of d.windows) {
        const host = registry.get(w.kind);
        const t = mk('button', 'desk-task' + (w.minimized ? ' minimized' : ''));
        t.appendChild(mk('span', 'desk-task-icon', host?.icon || '?'));
        t.appendChild(mk('span', 'desk-task-title', host?.get(w.key)?.title || w.title || w.key));
        t.title = w.minimized ? 'Minimized: click to restore' : 'Click to bring to front';
        t.addEventListener('click', () => {
          if (w.minimized) patchWindow(d.id, w.kind, w.key, { minimized: false });
          raise(d.id, w.kind, w.key);
        });
        bar.appendChild(t);
      }
    }

    // ---- drag, snap, resize ----

    function areaRect() {
      const de = deskEls.get(activeDeskId);
      const r = de?.el.getBoundingClientRect();
      return r && r.width > 0 ? r : null;
    }

    let preview = null;
    function showPreview(zone) {
      const de = deskEls.get(activeDeskId);
      if (!zone) { preview?.remove(); preview = null; return; }
      if (!preview) { preview = mk('div', 'desk-snap-preview'); }
      if (preview.parentNode !== de.el) de.el.appendChild(preview);
      const g = L.snapRect(zone);
      Object.assign(preview.style, { left: g.x * 100 + '%', top: g.y * 100 + '%', width: g.w * 100 + '%', height: g.h * 100 + '%' });
    }

    function startDrag(e, rec) {
      if (e.button !== 0 || e.target.closest?.('.desk-win-btn')) return;
      const at = locate(rec.kind, rec.key);
      const area = areaRect();
      if (!at || !area) return;
      e.preventDefault();
      raise(rec.deskId, rec.kind, rec.key, { focus: false });
      let start = L.toPx(at.win.geom, area);
      if (at.win.maximized) {
        // Dragging a maximized window restores its size under the pointer.
        start = { ...start, left: Math.max(0, e.clientX - area.left - start.width / 2), top: 0 };
        patchWindow(rec.deskId, rec.kind, rec.key, { maximized: false });
        rec.el.classList.remove('maximized');
      }
      const sx = e.clientX, sy = e.clientY;
      let zone = null, last = start;
      els.area.classList.add('desks-dragging');
      try { rec.bar.setPointerCapture?.(e.pointerId); } catch {}
      const move = (ev) => {
        last = L.clampPx({ ...start, left: start.left + ev.clientX - sx, top: start.top + ev.clientY - sy }, area);
        rec.el.style.left = last.left + 'px';
        rec.el.style.top = last.top + 'px';
        zone = L.snapZone({ x: ev.clientX - area.left, y: ev.clientY - area.top }, area);
        showPreview(zone);
      };
      const up = () => {
        rec.bar.removeEventListener('pointermove', move);
        rec.bar.removeEventListener('pointerup', up);
        rec.bar.removeEventListener('pointercancel', up);
        els.area.classList.remove('desks-dragging');
        showPreview(null);
        if (zone === 'top') patchWindow(rec.deskId, rec.kind, rec.key, { maximized: true });
        else if (zone) patchWindow(rec.deskId, rec.kind, rec.key, { geom: L.snapRect(zone), maximized: false });
        else patchWindow(rec.deskId, rec.kind, rec.key, { geom: L.toFrac(last, area) });
        render();
        registry.get(rec.kind)?.refit(rec.key);
      };
      rec.bar.addEventListener('pointermove', move);
      rec.bar.addEventListener('pointerup', up);
      rec.bar.addEventListener('pointercancel', up);
    }

    function startResize(e, rec, dir) {
      if (e.button !== 0) return;
      const at = locate(rec.kind, rec.key);
      const area = areaRect();
      if (!at || !area || at.win.maximized) return;
      e.preventDefault();
      e.stopPropagation();
      raise(rec.deskId, rec.kind, rec.key, { focus: false });
      const start = L.toPx(at.win.geom, area);
      const sx = e.clientX, sy = e.clientY;
      const handle = e.target;
      let last = start;
      els.area.classList.add('desks-dragging');
      try { handle.setPointerCapture?.(e.pointerId); } catch {}
      const move = (ev) => {
        last = L.clampPx(L.resizePx(start, dir, ev.clientX - sx, ev.clientY - sy), area);
        Object.assign(rec.el.style, { left: last.left + 'px', top: last.top + 'px', width: last.width + 'px', height: last.height + 'px' });
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        els.area.classList.remove('desks-dragging');
        patchWindow(rec.deskId, rec.kind, rec.key, { geom: L.toFrac(last, area) });
        render();
        registry.get(rec.kind)?.refit(rec.key);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    }

    // The desk area changed size: windows are pulled back into view (their
    // minimum size may no longer fit where they were) and shown ones refit.
    function onAreaResize() {
      const area = areaRect();
      const d = deskById(activeDeskId);
      if (!area || !d) return;
      for (const w of d.windows) {
        if (w.maximized) continue;
        const g = L.clampFrac(w.geom, area);
        if (g.x !== w.geom.x || g.y !== w.geom.y || g.w !== w.geom.w || g.h !== w.geom.h) {
          if (Math.abs(g.x - w.geom.x) + Math.abs(g.y - w.geom.y) + Math.abs(g.w - w.geom.w) + Math.abs(g.h - w.geom.h) > 0.002) {
            patchWindow(d.id, w.kind, w.key, { geom: g });
          }
        }
      }
      render();
      for (const w of d.windows) if (!w.minimized) registry.get(w.kind)?.refit(w.key);
    }

    // ---- wiring ----

    const offHosts = registry.on((ev) => {
      if (ev.type === 'rekey') {
        const at = locate(ev.kind, ev.from);
        if (at) {
          at.win.key = ev.to;
          // The window element follows its tab under the new key.
          const de = deskEls.get(at.desk.id);
          const rec = de?.wins.get(wid(ev.kind, ev.from));
          if (rec) { de.wins.delete(wid(ev.kind, ev.from)); rec.key = ev.to; rec.el.dataset.key = ev.to; de.wins.set(wid(ev.kind, ev.to), rec); }
          send({ type: 'desks:rekey', kind: ev.kind, from: ev.from, to: ev.to });
        }
      }
      if (ev.type === 'busy') { renderBusy(); return; }
      if (state) render();
    });
    registry.setDeskProvider(provider);

    els.newBtn?.addEventListener('click', () => { createDesk(); render(); });
    els.tileBtn?.addEventListener('click', () => tileAll());

    return {
      handleMessage, applyState, render, onAreaResize, flush, provider,
      createDesk, deleteDesk, renameDesk, askRename, tileAll, moveTo, createAndMove, returnHome, show, raise,
      activeDesk: () => activeDeskId, setActive, state: () => state, enabled,
      _patchWindow: patchWindow, _deskEls: deskEls,
      destroy() { offHosts(); registry.setDeskProvider(null); },
    };
  }

  root.createDesks = createDesks;

  // ---- the dashboard's instance ----
  const D = root.dashboard;
  const view = root.document?.getElementById?.('view-desks');
  if (!D || !view) return;
  const $ = (id) => root.document.getElementById(id);
  const phone = () => !!D.isPhone?.();
  const desksView = createDesks({
    send: (m) => D.sendWs(m),
    toast: (t) => D.showToast?.(t),
    isPhone: phone,
    storage: root.localStorage,
    switchView: (v) => root.switchView?.(v),
    elements: { view, headerTab: root.document.querySelector('.header-tab[data-view="desks"]'), strip: $('desksTabStrip'), area: $('desksArea'), taskbar: $('desksTaskbar'), tileBtn: $('desksTileBtn'), newBtn: $('desksNewBtn'), empty: $('desksEmpty') },
  });
  D.registerModule?.('desks:', (msg) => desksView.handleMessage(msg));
  D.registerView?.('desks', () => {
    if (phone()) { root.switchView?.('claude'); return; }
    desksView.render();
    // Laid out now that the view has a size.
    requestAnimationFrame(() => desksView.onAreaResize());
  });
  const area = $('desksArea');
  if (area && root.ResizeObserver) {
    let t = null;
    new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => desksView.onAreaResize(), 80); }).observe(area);
  }
  // Crossing the phone width: desk membership is applied or ignored; the
  // state is never changed by it.
  D.phoneQuery?.addEventListener?.('change', () => {
    desksView.render();
    for (const h of root.tabHosts.all()) h.render();
    if (phone() && !view.classList.contains('hidden')) root.switchView?.('claude');
  });
  root.addEventListener?.('beforeunload', () => desksView.flush());
  root.desksView = desksView;
})(typeof window !== 'undefined' ? window : globalThis);
