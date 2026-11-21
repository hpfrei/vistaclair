// TabHost: one module drives every second-level tab strip (CLIs, Inspector,
// Apps) and hands its tabs to Desks windows and back. docs/desks.md is the
// guide; the short form:
//
// Content contract — what a kind gives the host for each tab:
//   { key, title, root, setShown(visible), destroy(), focus?(), icon? }
//   key   a stable string that survives a refresh and a server restart
//         (CLI: settings.name || sessId; Inspector: instanceId; Apps: name).
//   root  an HTMLElement built once, owned by the tab, that keeps working
//         wherever it is moved in the page.
//   setShown(bool)  called when root becomes visible or hidden (it is the
//         selected tab of its strip, or a window on the selected desk that is
//         not minimized), and again with true after its window is resized.
//         Header-view switches do not call it.
//   destroy()  releases everything; the host calls it from remove().
//   focus()  optional: put the keyboard in it (strip click, window raise).
//
//   const host = createTabHost({ kind, label, icon, homeView, stripEl,
//     beforeEl?, contentEl, reopen(key) → Promise<bool>,
//     extraMenuItems?(key) → items, decorate?(key, btn, labelEl, { onDesk }),
//     onSelect?(key | null), canMove?(key) → bool, afterRender?() });
//   host.add(content) · remove(key) · activate(key | null) · select(key)
//   host.update(key, { title? }) · rekey(from, to) · render() · setOrder(keys)
//   host.has(key) · get(key) · keys() · activeKey() · isOnDesk(key) · isShown(key)
//   host.menuItems(key) · refit(key)
//   host.setBusy(key, bool) · isBusy(key) · busyKeys()  — the kind says a tab
//     is working; the strip button gets .instance-running and Desks shows the
//     same dot on its header tab, the desk's tab and the window's title bar.
//   Desks only: attachToDesk(key, bodyEl, desk) · detachFromDesk(key)
//     · setDeskShown(key, bool) · setDeskInfo(key, desk)
//
// The host never picks which home tab to show on its own except when the
// shown one leaves for a desk: then it asks onSelect(next key or null), the
// kind's own "show this tab" (default: host.activate).
//
// Registry (window.tabHosts): register(host) · get(kind) · all() · on(fn)
// (events { type: 'register'|'add'|'remove'|'rekey'|'update'|'busy', kind, key, from, to, busy })
// · setDeskProvider(p) · desks(). desks.js is the desk provider:
//   { enabled(), list() → [{id, name}], deskOf(kind, key) → {id, name} | null,
//     moveTo(kind, key, deskId, title), createAndMove(kind, key, name, title),
//     show(kind, key), returnHome(kind, key, { activate }) }
(function (root) {
  const KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/;

  function createRegistry() {
    const hosts = new Map();
    const listeners = new Set();
    let provider = null;
    function emit(ev) {
      for (const fn of listeners) {
        try { fn(ev); } catch (e) { console.error('[tab-host] listener failed:', e); }
      }
    }
    return {
      register(host) {
        hosts.set(host.kind, host);
        emit({ type: 'register', kind: host.kind });
        return () => { if (hosts.get(host.kind) === host) hosts.delete(host.kind); };
      },
      get: (kind) => hosts.get(kind) || null,
      all: () => [...hosts.values()],
      on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      emit,
      setDeskProvider(p) { provider = p || null; for (const h of hosts.values()) h.render(); },
      // The provider while desks are available here (not on a phone).
      desks: () => (provider && provider.enabled() ? provider : null),
    };
  }

  // Re-parent an element. Where the browser has Element.moveBefore (Chrome
  // 133+), the move keeps its state: an iframe inside does not reload, a
  // focused input keeps focus. Elsewhere appendChild (an iframe reloads once
  // per move — the desk switch itself never moves anything).
  function moveInto(parent, el) {
    if (el.parentNode === parent) return;
    if (typeof parent.moveBefore === 'function' && el.isConnected && parent.isConnected) {
      try { parent.moveBefore(el, null); return; } catch {}
    }
    parent.appendChild(el);
  }

  function createTabHost(opts) {
    const o = opts || {};
    if (!KIND_RE.test(o.kind || '')) throw new Error('createTabHost: kind must match ' + KIND_RE);
    if (!o.contentEl) throw new Error('createTabHost: contentEl is required');
    const registry = o.registry || root.tabHosts;
    const kind = o.kind;
    const entries = new Map();   // key -> { content, place: 'home'|'desk', desk, deskShown, shown }
    let order = [];
    let active = null;

    function check(content) {
      if (!content || typeof content.key !== 'string' || !content.key) throw new Error(`[${kind}] content.key must be a non-empty string`);
      if (!content.root || typeof content.root.appendChild !== 'function') throw new Error(`[${kind}] content.root must be an element`);
      if (typeof content.setShown !== 'function') throw new Error(`[${kind}] content.setShown must be a function`);
      if (typeof content.destroy !== 'function') throw new Error(`[${kind}] content.destroy must be a function`);
    }

    function setShown(e, v) {
      v = !!v;
      if (e.shown === v) return;
      e.shown = v;
      try { e.content.setShown(v); } catch (err) { console.error(`[${kind}] setShown failed:`, err); }
    }

    const emit = (ev) => registry?.emit({ kind, ...ev });

    function add(content) {
      check(content);
      if (entries.has(content.key)) throw new Error(`[${kind}] tab ${content.key} is already added`);
      const e = { content, place: 'home', desk: null, deskShown: false, shown: false, busy: false };
      entries.set(content.key, e);
      order.push(content.key);
      if (content.root.parentNode !== o.contentEl) moveInto(o.contentEl, content.root);
      content.root.style.display = 'none';
      render();
      emit({ type: 'add', key: content.key });
      return content;
    }

    // The tab is closed: its content is destroyed, a desk window holding it
    // turns into a placeholder (desks.js hears 'remove').
    function remove(key) {
      const e = entries.get(key);
      if (!e) return false;
      entries.delete(key);
      order = order.filter(k => k !== key);
      if (active === key) active = null;
      e.shown = false;
      try { e.content.destroy(); } catch (err) { console.error(`[${kind}] destroy failed:`, err); }
      try { e.content.root.remove(); } catch {}
      render();
      emit({ type: 'remove', key });
      return true;
    }

    // Show this home tab in the home area (null: none). Every other home
    // tab is hidden; a tab on a desk is never touched.
    function activate(key) {
      const target = key != null ? entries.get(key) : null;
      if (target && target.place === 'desk') return false;
      active = target ? key : null;
      for (const [k, e] of entries) {
        if (e.place !== 'home') continue;
        const on = k === active;
        e.content.root.style.display = on ? '' : 'none';
        setShown(e, on);
      }
      render();
      return true;
    }

    // A click on the tab: on a desk, go to its window; else the kind shows it.
    function select(key) {
      const e = entries.get(key);
      if (!e) return;
      const desks = registry?.desks();
      if (e.place === 'desk' && desks) { desks.show(kind, key); return; }
      if (o.onSelect) o.onSelect(key); else activate(key);
    }

    function focus(key) {
      const e = entries.get(key);
      if (e?.content.focus) try { e.content.focus(); } catch {}
    }

    function update(key, { title } = {}) {
      const e = entries.get(key);
      if (!e) return;
      if (typeof title === 'string' && title !== e.content.title) {
        e.content.title = title;
        emit({ type: 'update', key });
      }
      render();
    }

    function rekey(from, to) {
      if (from === to || !entries.has(from) || entries.has(to)) return false;
      const e = entries.get(from);
      entries.delete(from);
      e.content.key = to;
      entries.set(to, e);
      order = order.map(k => (k === from ? to : k));
      if (active === from) active = to;
      render();
      emit({ type: 'rekey', from, to, key: to });
      return true;
    }

    // The kind says this tab is working (a CLI streaming). Only a change is
    // announced; the strip button is patched, not redrawn.
    function setBusy(key, v) {
      const e = entries.get(key);
      v = !!v;
      if (!e || e.busy === v) return false;
      e.busy = v;
      const strip = o.stripEl;
      if (strip) for (const b of strip.querySelectorAll('.view-tab[data-tab-key]')) if (b.dataset.tabKey === key) b.classList.toggle('instance-running', v);
      emit({ type: 'busy', key, busy: v });
      return true;
    }

    function setOrder(keys) {
      const known = keys.filter(k => entries.has(k));
      order = [...new Set([...known, ...order])];
      render();
    }

    // ---- desks ----

    function nextHomeKey(after) {
      const homes = order.filter(k => k !== after && entries.get(k)?.place === 'home');
      if (!homes.length) return null;
      const i = order.indexOf(after);
      const later = homes.find(k => order.indexOf(k) > i);
      return later || homes[homes.length - 1];
    }

    // Into a desk window's body. Moved, not rebuilt; hidden until the desk
    // says it is shown. If it was the shown home tab, the kind picks the next.
    function attachToDesk(key, bodyEl, desk) {
      const e = entries.get(key);
      if (!e) return false;
      const wasActive = active === key;
      moveInto(bodyEl, e.content.root);
      e.content.root.style.display = '';
      e.place = 'desk';
      e.desk = desk ? { id: desk.id, name: desk.name } : null;
      if (wasActive) {
        active = null;
        setShown(e, e.deskShown);
        const next = nextHomeKey(key);
        if (o.onSelect) o.onSelect(next); else activate(next);
      } else {
        setShown(e, e.deskShown);
      }
      render();
      return true;
    }

    // Back into the home area, hidden (activate() shows it).
    function detachFromDesk(key) {
      const e = entries.get(key);
      if (!e) return false;
      e.place = 'home';
      e.desk = null;
      e.deskShown = false;
      moveInto(o.contentEl, e.content.root);
      e.content.root.style.display = active === key ? '' : 'none';
      setShown(e, active === key);
      render();
      return true;
    }

    function setDeskShown(key, v) {
      const e = entries.get(key);
      if (!e || e.place !== 'desk') return;
      e.deskShown = !!v;
      setShown(e, e.deskShown);
    }

    function setDeskInfo(key, desk) {
      const e = entries.get(key);
      if (!e || e.place !== 'desk') return;
      e.desk = desk ? { id: desk.id, name: desk.name } : null;
      render();
    }

    // After a resize of its window: shown content refits.
    function refit(key) {
      const e = entries.get(key);
      if (!e?.shown) return;
      try { e.content.setShown(true); } catch (err) { console.error(`[${kind}] setShown failed:`, err); }
    }

    // ---- menu and strip ----

    function menuItems(key) {
      const e = entries.get(key);
      if (!e) return [];
      let extra = [];
      try { extra = o.extraMenuItems ? o.extraMenuItems(key) || [] : []; } catch (err) { console.error(`[${kind}] extraMenuItems failed:`, err); }
      // A tab whose key is not stable yet (canMove says no) cannot go to a desk.
      const movable = !o.canMove || o.canMove(key) || e.place === 'desk';
      return root.tabContextMenu.buildTabMenuItems({ kind, key, title: e.content.title, desks: (movable && registry?.desks()) || null, extra });
    }

    function render() {
      const strip = o.stripEl;
      if (!strip) return;
      const doc = root.document;
      for (const el of [...strip.querySelectorAll('.view-tab[data-tab-key]')]) el.remove();
      const desks = registry?.desks();
      for (const key of order) {
        const e = entries.get(key);
        const onDesk = e.place === 'desk' && !!desks;
        const btn = doc.createElement('button');
        btn.className = 'view-tab tab-host-tab' + (key === active ? ' active' : '') + (onDesk ? ' tab-on-desk' : '') + (e.busy ? ' instance-running' : '');
        btn.dataset.tabKey = key;
        btn.dataset.tabKind = kind;
        const label = doc.createElement('span');
        label.className = 'tab-host-label';
        label.textContent = e.content.title || key;
        btn.appendChild(label);
        if (onDesk) {
          const chip = doc.createElement('span');
          chip.className = 'tab-desk-chip';
          chip.textContent = `on desk ${e.desk?.name || ''}`.trim();
          chip.title = 'This tab is a window on a desk. Click to go there.';
          btn.appendChild(chip);
          btn.title = `On desk "${e.desk?.name || ''}": click to show it there`;
        }
        if (o.decorate) {
          try { o.decorate(key, btn, label, { onDesk }); } catch (err) { console.error(`[${kind}] decorate failed:`, err); }
        }
        btn.addEventListener('click', () => select(key));
        root.tabContextMenu?.attach(btn, () => menuItems(key));
        if (o.beforeEl && o.beforeEl.parentNode === strip) strip.insertBefore(btn, o.beforeEl);
        else strip.appendChild(btn);
      }
      if (o.afterRender) try { o.afterRender(); } catch (err) { console.error(`[${kind}] afterRender failed:`, err); }
    }

    const host = {
      kind,
      label: o.label || kind,
      icon: o.icon || '▣',
      homeView: o.homeView || null,
      add, remove, activate, select, focus, update, rekey, setOrder, setBusy, render,
      attachToDesk, detachFromDesk, setDeskShown, setDeskInfo, refit, menuItems,
      reopen: (key) => Promise.resolve().then(() => (o.reopen ? o.reopen(key) : false)).catch((err) => { console.error(`[${kind}] reopen failed:`, err); return false; }),
      has: (key) => entries.has(key),
      get: (key) => entries.get(key)?.content || null,
      keys: () => order.slice(),
      activeKey: () => active,
      isOnDesk: (key) => entries.get(key)?.place === 'desk',
      isShown: (key) => !!entries.get(key)?.shown,
      isBusy: (key) => !!entries.get(key)?.busy,
      busyKeys: () => order.filter(k => entries.get(k)?.busy),
    };
    registry?.register(host);
    return host;
  }

  const api = { createTabHost, createRegistry };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.createTabHost = createTabHost;
    root.tabHosts = root.tabHosts || createRegistry();
  }
})(typeof window !== 'undefined' ? window : globalThis);
