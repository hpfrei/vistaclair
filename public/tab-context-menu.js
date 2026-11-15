// The right-click menu of every second-level tab (CLIs, Inspector, Apps) and
// of the desks' own tabs: one module, one look.
//
//   tabContextMenu.buildTabMenuItems({ kind, key, title, desks, extra })
//     → items. Pure. `desks` is the desk provider (tab-host.js registry) or
//     null; with it the menu offers "Move to desk ▸" (every desk but the
//     tab's own, then "New desk…"), and while the tab is on a desk "Show on
//     desk" and "Return here". The kind's `extra` items follow.
//   tabContextMenu.open(items, { x, y }) → close(). One menu at a time.
//   tabContextMenu.attach(el, getItems) — right-click, and a long press on
//     touch, open getItems() at the pointer.
//
// An item: { label, title?, onClick?(), danger?, disabled?, submenu?: items,
// input?: { placeholder, value?, onSubmit(text) } } or { divider: true }.
// An `input` item turns into a text field in place when clicked; Enter
// submits, Esc cancels.
(function (root) {
  function buildTabMenuItems({ kind, key, title, desks, extra } = {}) {
    const items = [];
    if (desks && desks.enabled()) {
      const at = desks.deskOf(kind, key);
      const sub = desks.list()
        .filter(d => !at || d.id !== at.id)
        .map(d => ({ label: d.name, onClick: () => desks.moveTo(kind, key, d.id, title) }));
      if (sub.length) sub.push({ divider: true });
      sub.push({
        label: 'New desk…',
        input: { placeholder: 'Desk name', value: '', onSubmit: (name) => desks.createAndMove(kind, key, name, title) },
      });
      items.push({ label: 'Move to desk', submenu: sub });
      if (at) {
        items.push({ label: `Show on desk "${at.name}"`, onClick: () => desks.show(kind, key) });
        items.push({ label: 'Return here', title: 'Take it off the desk, back into this strip', onClick: () => desks.returnHome(kind, key, { activate: true }) });
      }
    }
    const more = (extra || []).filter(Boolean);
    if (more.length) {
      if (items.length) items.push({ divider: true });
      items.push(...more);
    }
    return items;
  }

  // ---- DOM ----
  let current = null;   // { els: [menu, ...submenus], cleanup }

  function close() {
    if (!current) return;
    const c = current;
    current = null;
    c.cleanup();
    for (const el of c.els) el.remove();
  }

  function place(el, x, y) {
    el.style.position = 'fixed';
    el.style.left = '0px';
    el.style.top = '0px';
    const w = el.offsetWidth || 0, h = el.offsetHeight || 0;
    const W = root.innerWidth || 1e6, H = root.innerHeight || 1e6;
    el.style.left = Math.max(8, Math.min(x, W - w - 8)) + 'px';
    el.style.top = Math.max(8, Math.min(y, H - h - 8)) + 'px';
  }

  function runSafe(fn, ...args) {
    try {
      const r = fn(...args);
      if (r && typeof r.catch === 'function') r.catch(e => console.error('[tab-menu] action failed:', e));
    } catch (e) { console.error('[tab-menu] action failed:', e); }
  }

  function renderList(items, level) {
    const doc = root.document;
    const menu = doc.createElement('div');
    menu.className = 'cli-new-menu tab-ctx-menu';
    menu.setAttribute('role', 'menu');
    for (const it of items) {
      if (it.divider) {
        const d = doc.createElement('div');
        d.className = 'cli-new-menu-divider';
        menu.appendChild(d);
        continue;
      }
      const row = doc.createElement('div');
      row.className = 'cli-new-menu-item tab-ctx-item' + (it.danger ? ' tab-ctx-danger' : '') + (it.disabled ? ' disabled' : '') + (it.submenu ? ' tab-ctx-has-sub' : '');
      row.setAttribute('role', 'menuitem');
      row.textContent = it.label + (it.submenu ? '  ▸' : '');
      if (it.title) row.title = it.title;
      if (it.disabled) { menu.appendChild(row); continue; }
      if (it.submenu) {
        const openSub = () => openSubmenu(it.submenu, row, level + 1);
        row.addEventListener('mouseenter', openSub);
        row.addEventListener('click', (e) => { e.stopPropagation(); openSub(); });
      } else if (it.input) {
        row.addEventListener('mouseenter', () => closeFrom(level + 1));
        row.addEventListener('click', (e) => { e.stopPropagation(); toInput(row, it.input); });
      } else {
        row.addEventListener('mouseenter', () => closeFrom(level + 1));
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          close();
          if (it.onClick) runSafe(it.onClick);
        });
      }
      menu.appendChild(row);
    }
    menu.addEventListener('contextmenu', (e) => e.preventDefault());
    return menu;
  }

  function toInput(row, spec) {
    const doc = root.document;
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'tab-ctx-input';
    input.placeholder = spec.placeholder || '';
    input.value = spec.value || '';
    input.maxLength = 80;
    row.textContent = '';
    row.appendChild(input);
    row.classList.add('tab-ctx-editing');
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = input.value.trim();
        close();
        runSafe(spec.onSubmit, v);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });
    input.focus();
  }

  function closeFrom(level) {
    if (!current) return;
    while (current.els.length > level) current.els.pop().remove();
  }

  function openSubmenu(items, anchor, level) {
    if (!current) return;
    if (current.els[level]?._anchor === anchor) return;
    closeFrom(level);
    const sub = renderList(items, level);
    sub._anchor = anchor;
    sub.classList.add('tab-ctx-sub');
    root.document.body.appendChild(sub);
    const r = anchor.getBoundingClientRect();
    const W = root.innerWidth || 1e6;
    const w = sub.offsetWidth || 200;
    place(sub, r.right + w + 4 > W ? r.left - w - 2 : r.right + 2, r.top - 4);
    current.els.push(sub);
  }

  function open(items, { x = 0, y = 0 } = {}) {
    close();
    if (!items || !items.length) return close;
    const doc = root.document;
    const menu = renderList(items, 0);
    doc.body.appendChild(menu);
    const onDown = (e) => {
      if (current && !current.els.some(el => el.contains(e.target))) close();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const onBlur = () => close();
    current = {
      els: [menu],
      cleanup() {
        doc.removeEventListener('mousedown', onDown, true);
        doc.removeEventListener('touchstart', onDown, true);
        doc.removeEventListener('keydown', onKey, true);
        root.removeEventListener?.('blur', onBlur);
      },
    };
    place(menu, x, y);
    setTimeout(() => {
      if (!current || current.els[0] !== menu) return;
      doc.addEventListener('mousedown', onDown, true);
      doc.addEventListener('touchstart', onDown, true);
      doc.addEventListener('keydown', onKey, true);
      root.addEventListener?.('blur', onBlur);
    }, 0);
    return close;
  }

  const LONG_PRESS_MS = 550;
  function attach(el, getItems) {
    el.addEventListener('contextmenu', (e) => {
      const items = getItems();
      if (!items || !items.length) return;
      e.preventDefault();
      e.stopPropagation();
      open(items, { x: e.clientX, y: e.clientY });
    });
    let timer = null, sx = 0, sy = 0, fired = false;
    const cancel = () => { clearTimeout(timer); timer = null; };
    el.addEventListener('touchstart', (e) => {
      const t = e.touches?.[0];
      if (!t) return;
      sx = t.clientX; sy = t.clientY; fired = false;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        const items = getItems();
        if (!items || !items.length) return;
        fired = true;
        open(items, { x: sx, y: sy });
      }, LONG_PRESS_MS);
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      const t = e.touches?.[0];
      if (t && Math.hypot(t.clientX - sx, t.clientY - sy) > 10) cancel();
    }, { passive: true });
    el.addEventListener('touchend', (e) => {
      cancel();
      // The click a long press ends in must not also select the tab.
      if (fired) { fired = false; e.preventDefault?.(); }
    });
    el.addEventListener('touchcancel', cancel);
  }

  const api = { buildTabMenuItems, open, close, attach, isOpen: () => !!current };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.tabContextMenu = api;
})(typeof window !== 'undefined' ? window : globalThis);
