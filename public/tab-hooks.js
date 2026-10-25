// Tab actions and tab badges an add-on's client module adds to session tabs,
// through window.dashboard (core.js wires one registry there):
//
//   registerTabAction({ id, label, title?, when?(info) → bool, onClick(info) })
//     → its unregister function; unregisterTabAction(id). A menu item in the
//     terminal tab's × menu and the Agent SDK toolbar's ⋯ menu of every tab
//     whose info `when` accepts (every tab without `when`).
//   setTabBadge(name, { text, title?, onClick?(name) } | null) — a chip on the
//     tab and the SDK toolbar of the session with that settings.name (a name
//     survives a resume, a refresh and a reboot; a tab id does not). null
//     removes it.
//
// info = { tabId, name, engine ('cli' | 'sdk'), role ('orchestrator' | 'worker'
// | null), runId }. The views ask at every render, so what is
// registered survives re-renders; a change re-renders them (onChange).
// Pure: nothing here touches the DOM.
(function (root) {
  function tabInfo(tabId, tab) {
    const st = tab?.settings || {};
    const role = st.orchestration?.role;
    return {
      tabId,
      name: st.name || null,
      engine: tab?.kind === 'sdk' ? 'sdk' : 'cli',
      role: role === 'orchestrator' || role === 'worker' ? role : null,
      runId: st.orchestration?.runId || null,
    };
  }

  function createTabHooks() {
    const actions = new Map();   // id -> action, in registration order
    const badges = new Map();    // session name -> badge
    const listeners = new Set();

    function changed() {
      for (const fn of listeners) {
        try { fn(); } catch (e) { console.error('[tab-hooks] listener failed:', e); }
      }
    }

    function registerTabAction(action) {
      const a = action || {};
      if (typeof a.id !== 'string' || !a.id) throw new Error('registerTabAction: id must be a non-empty string');
      if (typeof a.label !== 'string' || !a.label) throw new Error('registerTabAction: label must be a non-empty string');
      if (typeof a.onClick !== 'function') throw new Error('registerTabAction: onClick must be a function');
      if (a.when != null && typeof a.when !== 'function') throw new Error('registerTabAction: when must be a function');
      actions.delete(a.id);   // a re-registration moves to the end
      actions.set(a.id, { id: a.id, label: a.label, title: typeof a.title === 'string' ? a.title : null, when: a.when || null, onClick: a.onClick });
      changed();
      return () => { if (actions.get(a.id)?.onClick === a.onClick) unregisterTabAction(a.id); };
    }

    function unregisterTabAction(id) {
      if (actions.delete(id)) changed();
    }

    // The actions for a tab, in registration order. A `when` that throws
    // hides its action.
    function actionsFor(info) {
      const out = [];
      for (const a of actions.values()) {
        let show = true;
        if (a.when) { try { show = !!a.when(info); } catch { show = false; } }
        if (show) out.push(a);
      }
      return out;
    }

    // Runs an action's onClick; an error is logged, never thrown into the view.
    function runAction(action, info) {
      try {
        const r = action.onClick(info);
        if (r && typeof r.catch === 'function') r.catch(e => console.error(`[tab-hooks] ${action.id} failed:`, e));
      } catch (e) { console.error(`[tab-hooks] ${action.id} failed:`, e); }
    }

    function setTabBadge(name, badge) {
      if (typeof name !== 'string' || !name) throw new Error('setTabBadge: name must be a non-empty string');
      if (badge == null) {
        if (badges.delete(name)) changed();
        return;
      }
      if (typeof badge.text !== 'string' || !badge.text) throw new Error('setTabBadge: text must be a non-empty string');
      if (badge.onClick != null && typeof badge.onClick !== 'function') throw new Error('setTabBadge: onClick must be a function');
      badges.set(name, { text: badge.text, title: typeof badge.title === 'string' ? badge.title : null, onClick: badge.onClick || null });
      changed();
    }

    function badgeFor(name) {
      return (name && badges.get(name)) || null;
    }

    function onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }

    return { registerTabAction, unregisterTabAction, actionsFor, runAction, setTabBadge, badgeFor, onChange };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createTabHooks, tabInfo };
  else { root.createTabHooks = createTabHooks; root.tabHookInfo = tabInfo; }
})(typeof window !== 'undefined' ? window : globalThis);
