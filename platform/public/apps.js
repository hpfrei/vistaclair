// Delegated event actions for generated markup — the CSP-safe replacement for
// inline on*="…" attributes (the dashboard policy has no 'unsafe-inline' for
// script, so an inline handler never runs).
//
//   html += `<button ${vcAct.attrs('click', 'appsModule.restartApp', [name], { stop: true })}>…`
//
// attrs() returns data-vc-<event>="<dotted path from window>" plus
// data-vc-<event>-args="<json array>". One listener per event on the document
// finds the elements carrying the attribute (innermost first, as bubbling
// inline handlers would), resolves the path and calls it with the args. A
// path or root that does not exist is a silent no-op (the old
// `window.x && window.x.fn()` guard).
//
//   events   click, input, change, mouseenter, mouseleave
//   options  stop: true     event.stopPropagation() before the call, and no
//                           outer element's action runs (click only)
//            prevent: true  event.preventDefault() first
//   args     JSON values; {"$":"this"} is the element, {"$":"value"} its
//            .value, {"$":"checked"} its .checked, {"$":"event"} the event.
//            The tokens are replaced anywhere inside arrays and objects.
//
// Defined at the top of apps.js (the first Pro client module in every version
// of the module list), guarded so exactly one definition wins; spend-admin.js
// and the rest render through it after apps.js has run.
(function () {
  'use strict';
  if (window.vcAct) return;

  var EVENTS = ['click', 'input', 'change', 'mouseenter', 'mouseleave'];

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function attrs(event, path, args, opts) {
    if (EVENTS.indexOf(event) < 0) throw new Error('vcAct: unsupported event ' + event);
    var o = opts || {};
    var out = ' data-vc-' + event + '="' + esc(path) + '"';
    if (args && args.length) out += ' data-vc-' + event + '-args="' + esc(JSON.stringify(args)) + '"';
    if (o.stop) out += ' data-vc-' + event + '-stop';
    if (o.prevent) out += ' data-vc-' + event + '-prevent';
    return out + ' ';
  }

  function revive(v, el, ev) {
    if (Array.isArray(v)) return v.map(function (x) { return revive(x, el, ev); });
    if (v && typeof v === 'object') {
      var keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === '$') {
        if (v.$ === 'this') return el;
        if (v.$ === 'value') return el.value;
        if (v.$ === 'checked') return el.checked;
        if (v.$ === 'event') return ev;
        return undefined;
      }
      var out = {};
      keys.forEach(function (k) { out[k] = revive(v[k], el, ev); });
      return out;
    }
    return v;
  }

  function call(el, event, ev) {
    var path = el.getAttribute('data-vc-' + event);
    if (!path) return;
    if (el.hasAttribute('data-vc-' + event + '-prevent')) ev.preventDefault();
    var parts = path.split('.');
    var ctx = window;
    for (var i = 0; i < parts.length - 1 && ctx != null; i++) ctx = ctx[parts[i]];
    var fn = ctx != null ? ctx[parts[parts.length - 1]] : null;
    if (typeof fn !== 'function') return;
    var args = [];
    var raw = el.getAttribute('data-vc-' + event + '-args');
    if (raw) {
      try { args = revive(JSON.parse(raw), el, ev); } catch (e) { args = []; }
    }
    fn.apply(ctx, args);
  }

  // Capture phase on the document: runs before the page's own listeners, so
  // `stop` keeps them from seeing the event, as a bubbling inline
  // stopPropagation() did for every listener above the element.
  function onEvent(event) {
    return function (ev) {
      var path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
      for (var i = 0; i < path.length; i++) {
        var el = path[i];
        if (!el || el.nodeType !== 1 || !el.hasAttribute('data-vc-' + event)) continue;
        var stop = el.hasAttribute('data-vc-' + event + '-stop');
        if (stop) ev.stopPropagation();
        call(el, event, ev);
        if (stop) break;
      }
    };
  }

  // mouseenter / mouseleave do not bubble: use over / out and ignore moves
  // between the element's own descendants.
  function onHover(event, domEvent) {
    return function (ev) {
      var path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
      for (var i = 0; i < path.length; i++) {
        var el = path[i];
        if (!el || el.nodeType !== 1 || !el.hasAttribute('data-vc-' + event)) continue;
        if (ev.relatedTarget && el.contains(ev.relatedTarget)) continue;
        call(el, event, ev);
      }
    };
  }

  document.addEventListener('click', onEvent('click'), true);
  document.addEventListener('input', onEvent('input'), true);
  document.addEventListener('change', onEvent('change'), true);
  document.addEventListener('mouseover', onHover('mouseenter'), true);
  document.addEventListener('mouseout', onHover('mouseleave'), true);

  // Actions the markup can name by path (vcAct.<name>), for what the old
  // inline handlers did without a page function.
  var actions = {
    // Copy text to the clipboard and show "Copied!" on the button for 1.5 s.
    copyText: function (text, btn) {
      if (!navigator.clipboard) return;
      var label = btn && btn.textContent;
      navigator.clipboard.writeText(String(text)).then(function () {
        if (!btn) return;
        btn.textContent = 'Copied!';
        setTimeout(function () { btn.textContent = label; }, 1500);
      });
    },
    // Remove the n-th ancestor of el (1 = parent).
    removeAncestor: function (el, n) {
      var x = el;
      for (var i = 0; i < n && x; i++) x = x.parentElement;
      if (x) x.remove();
    },
  };

  window.vcAct = Object.assign({ attrs: attrs }, actions);
})();

// === Apps Platform Module (Pro) ===
(function() {
  'use strict';

  // Create Apps tab in header nav (before the separator)
  const headerTabs = document.getElementById('headerTabs');
  const sep = headerTabs?.querySelector('.header-tab-sep');
  const appsTab = document.createElement('button');
  appsTab.className = 'header-tab header-tab-apps';
  appsTab.dataset.view = 'apps';
  appsTab.innerHTML = '<svg class="apps-tab-star" width="20" height="20" viewBox="0 0 24 24"><defs><linearGradient id="vc-star" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#cc3344"/><stop offset="25%" stop-color="#c07020"/><stop offset="50%" stop-color="#1a8a3a"/><stop offset="75%" stop-color="#2255aa"/><stop offset="100%" stop-color="#7744bb"/></linearGradient></defs><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.27 5.82 21 7 14.14l-5-4.87 6.91-1.01z" fill="url(#vc-star)"/></svg>Apps';
  if (sep) headerTabs.insertBefore(appsTab, sep);
  else headerTabs?.appendChild(appsTab);

  // Create Apps view container
  const appsView = document.createElement('div');
  appsView.id = 'view-apps';
  appsView.className = 'hidden';
  appsView.style.display = 'none';
  // The strip: the fixed All Apps button, the TabHost's tab buttons (placed
  // before the slot), then the slot holding the Setup button.
  appsView.innerHTML = '<div class="view-nav" id="appsTabStrip">'
    + '<button class="view-tab active" data-app-tab="grid">All Apps</button>'
    + '<span id="appsSetupSlot" style="display:contents"></span>'
    + '</div><div id="apps-content"></div>';
  const lastView = document.getElementById('view-directories');
  if (lastView?.nextSibling) lastView.parentNode.insertBefore(appsView, lastView.nextSibling);
  else document.body.appendChild(appsView);

  // Console typography (Chakra Petch / IBM Plex Sans / JetBrains Mono); every
  // rule declares a system fallback stack, so offline hosts just look plainer.
  if (!document.getElementById('vcProFonts')) {
    const l = document.createElement('link');
    l.id = 'vcProFonts'; l.rel = 'stylesheet';
    // Only the pro display face. IBM Plex Sans / JetBrains Mono are loaded by
    // the core dashboard (index.html) — pro depends on core, not vice versa.
    l.href = 'https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600&display=swap';
    document.head.appendChild(l);
  }
  // "/" focuses the grid search when the Apps grid is showing.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (appsView.classList.contains('hidden')) return;
    const s = document.getElementById('appsGridSearch');
    if (s && s.offsetParent !== null) { e.preventDefault(); s.focus(); s.select(); }
  });

  const { state, sendWs, escHtml, showAlert, showConfirm } = window.dashboard;

  // The open app settings modal (openAppSettings), or null.
  // { name, tab, overlay, close, main, foot, detach, refresh }
  let settings = null;

  // Access level, derived from the manifest exactly as src/apps/surfaces.js
  // does: the auth block is the level. { level, channels }
  //   private  no login channel — owner only
  //   users    telegram / whatsapp / email — login required, `app` entry surface
  //   open     whole subtree anonymous (only without a login channel)
  function accessOf(app) {
    const auth = (app && app.auth && typeof app.auth === 'object') ? app.auth : {};
    const channels = ['telegram', 'whatsapp', 'email'].filter((k) => !!auth[k]);
    const pages = (app && app.surfaces && app.surfaces.public && Array.isArray(app.surfaces.public.pages)) ? app.surfaces.public.pages : [];
    const wantsOpen = pages.includes('**') || (app && app.public === true);
    const level = channels.length ? 'users' : wantsOpen ? 'open' : 'private';
    return { level, channels };
  }
  const CHANNEL_SHORT = { telegram: 'tg', whatsapp: 'wa', email: 'email' };
  function accessChip(app) {
    const { level, channels } = accessOf(app);
    if (level === 'open') return '<span class="vc-chip warn" title="Open: the whole app is reachable by anyone without a login. Owner services are revoked for it (Spend &amp; permissions).">open</span>';
    if (level === 'users') return `<span class="vc-chip ok" title="Users: reachable from the internet at /apps/${escHtml(app.name)}/ — visitors land on app.html and must sign in (${escHtml(channels.join(', '))}); every /api/* route needs a signed-in user except /api/app/pub/*.">users${channels.map((c) => ` · ${CHANNEL_SHORT[c]}`).join('')}</span>`;
    return '<span class="vc-chip dash" title="Private: only you, from the dashboard. Nothing is reachable without the Vistaclair login.">private</span>';
  }

  // Runtime placement (phase 4 collapse): `runtime` from the server, with a
  // fallback mapping for payloads from a not-yet-restarted server.
  function appRuntimeOf(app) {
    if (app?.runtime) return app.runtime;
    if (app?.standalone === true) return 'own-process';
    return app?.type === 'mounted' || !app?.type ? 'in-process' : 'own-process';
  }

  const apps = {
    list: [],
    env: null,
    activeTab: 'grid',
    openTabs: [],
    db: { connected: false, config: null },
    errors: [],
    tasks: { spawned: [], cron: [], cli: [] },
    tools: new Map(), // appName → [{ name, description, inputSchema, timeout, expose }]
    needRestart: new Map(), // app name → reason (tools changed, grants changed, …)
    toolsAudit: [], // recent tool calls, newest first, cap 200
    connectivity: null,
    bootStatus: null, // { phase, db, apps: { state, done, total, current }, accounts }
    meta: { sizes: {}, dbSizes: {}, dbNames: {}, git: {}, baseDir: '' }, // appName → dir size / db size (bytes) / db name / git status, plus apps base dir
    changeRequests: [], // cross-app change requests (app-change-requests.js)
    deps: null, // { mode, edges, health, agentGrants } from app:deps (app-deps.js)
  };
  let errorSeq = 0;
  let tgBoundNames = new Set(); // app names that have a bot bound (from telegramStatus)

  // Apps the build/change LLM declared as Telegram-capable (manifest
  // capabilities.telegram) that still have no bot bound. These are "awaiting a
  // bot": the app was built to use Telegram but the human hasn't created/bound
  // one in @BotFather yet.
  function tgAwaitingApps() {
    return (apps.list || []).filter(a => a.capabilities && a.capabilities.telegram && !tgBoundNames.has(a.name));
  }

  // --- Toast notifications ---
  // Delegated to the core Vistaclair header toast system (window.dashboard.showToast).
  // Kept as a thin shim so existing callers (and app:notify routing) keep working.
  function showToast({ title, body, level, appName, message, sender, duration }) {
    if (!window.dashboard?.showToast) return;
    window.dashboard.showToast({
      sender: sender || appName || 'App',
      title: title || '',
      message: message != null ? message : (body || ''),
      level: level || 'info',
      duration,
    });
  }

  // Uniform "Applied" confirmation for the Setup modal: shows a green ✓ Applied
  // pill in the status element and pulses the enclosing section card.
  function flashSetupApplied(statusElOrId, message) {
    const el = typeof statusElOrId === 'string' ? document.getElementById(statusElOrId) : statusElOrId;
    if (!el) return;
    el.className = 'setup-status success';
    el.innerHTML = `<span class="setup-applied">${message || 'Applied'}</span>`;
    const pill = el.querySelector('.setup-applied');
    const section = el.closest('.setup-section');
    if (section) {
      section.classList.remove('flash-applied');
      void section.offsetWidth;
      section.classList.add('flash-applied');
      setTimeout(() => section.classList.remove('flash-applied'), 1700);
    }
    setTimeout(() => { if (pill) pill.classList.add('fade-out'); }, 1800);
    setTimeout(() => { if (el.querySelector('.setup-applied')) el.innerHTML = ''; }, 2300);
  }

  // --- Tab strip ---

  function getTabStrip() {
    return document.getElementById('appsTabStrip');
  }

  function getContainer() {
    return document.getElementById('apps-content');
  }

  // The open tabs (apps, _help, _tools) are TabHost tabs of kind 'apps',
  // keyed by the app name, so they get the shared right-click menu and can
  // live as windows on a Desk. All Apps stays a plain fixed button and the grid
  // panel a plain child of #apps-content; _help and _tools are tabs of the
  // host that cannot move (canMove). docs/desks.md.
  const FIXED_TABS = new Set(['_help', '_tools']);
  const tabTitle = (name) => name === '_help' ? 'Apps Guide' : name === '_tools' ? 'Tools' : name;

  // A tab's own panel, wherever it sits in the page (home area or a desk
  // window). Every per-app lookup goes through it: never a query scoped to
  // #apps-content, which a moved panel has left.
  function panelOf(name) {
    return appsHost?.get(name)?.root || null;
  }

  function makeTabContent(name) {
    const root = name === '_help' ? createHelpPanel() : name === '_tools' ? createToolsPanel() : createAppPanel(name);
    root.classList.add('apps-tab-panel');
    return {
      key: name,
      title: tabTitle(name),
      root,
      setShown() {},
      destroy() {
        const ctx = codePanels.get(name);
        if (ctx?.editor) { try { ctx.editor.dispose(); } catch {} }
        codePanels.delete(name);
      },
    };
  }

  // The × on a tab button closes the tab (the app keeps running).
  function decorateTab(key, btn, labelEl) {
    labelEl.classList.add('app-tab-label');
    const x = document.createElement('span');
    x.className = 'view-tab-close';
    x.dataset.close = key;
    x.innerHTML = '&times;';
    x.addEventListener('click', (e) => { e.stopPropagation(); closeAppTab(key); });
    btn.appendChild(x);
  }

  // A desk window whose app tab is missing: open it again, starting the app
  // (createAppPanel sends app:start). Full-screen apps never have a tab.
  async function reopenAppTab(name) {
    if (FIXED_TABS.has(name)) return false;
    const app = apps.list.find(a => a.name === name);
    if (!app || app.display === 'fullscreen') return false;
    if (!appsHost.has(name)) ensureTab(name);
    return appsHost.has(name);
  }

  let appsHost = null;
  function initTabHost() {
    if (appsHost) return appsHost;
    if (typeof window.createTabHost !== 'function') throw new Error('Apps view: core public/tab-host.js (TabHost) is not loaded');
    const strip = getTabStrip();
    appsHost = window.createTabHost({
      kind: 'apps', label: 'App', icon: '✦', homeView: 'apps',
      stripEl: strip,
      beforeEl: document.getElementById('appsSetupSlot'),
      contentEl: getContainer(),
      canMove: (key) => !FIXED_TABS.has(key),
      reopen: reopenAppTab,
      onSelect: (key) => switchTab(key || 'grid'),
      decorate: decorateTab,
      extraMenuItems: (key) => [{ label: 'Close', onClick: () => closeAppTab(key) }],
    });
    strip.querySelector('[data-app-tab="grid"]').addEventListener('click', () => switchTab('grid'));
    return appsHost;
  }

  // Add the tab (a no-op when it exists) and keep apps.openTabs in step.
  function ensureTab(name) {
    initTabHost();
    if (!appsHost.has(name)) appsHost.add(makeTabContent(name));
    if (!apps.openTabs.includes(name)) apps.openTabs.push(name);
  }

  function renderTabStrip() {
    const strip = getTabStrip();
    if (!strip) return;
    initTabHost();
    strip.querySelector('[data-app-tab="grid"]')?.classList.toggle('active', apps.activeTab === 'grid');
    const slot = document.getElementById('appsSetupSlot');
    if (slot) slot.innerHTML = renderSetupBtn();
    appsHost.render();
  }

  // Show a tab. A tab that lives on a desk goes to its window instead; the
  // home area is left as it is.
  function switchTab(tab) {
    initTabHost();
    if (tab !== 'grid' && appsHost.isOnDesk(tab)) { appsHost.select(tab); return; }
    apps.activeTab = tab;
    renderContent();
    renderTabStrip();
  }

  // --- Content rendering ---

  function renderContent() {
    const container = getContainer();
    if (!container) return;
    initTabHost();

    // The grid panel is the one fixed child; tab roots are the host's, shown
    // and hidden by activate() (a tab on a desk is never touched).
    let gridPanel = container.querySelector('[data-panel="grid"]');
    if (gridPanel) gridPanel.style.display = 'none';

    if (apps.activeTab === 'grid') {
      appsHost.activate(null);
      if (!gridPanel) {
        gridPanel = document.createElement('div');
        gridPanel.dataset.panel = 'grid';
        gridPanel.style.flex = '1';
        gridPanel.style.overflow = 'hidden';
        gridPanel.style.flexDirection = 'column';
        container.appendChild(gridPanel);
      }
      gridPanel.style.display = 'flex';
      renderGrid(gridPanel);
    } else {
      ensureTab(apps.activeTab);
      appsHost.activate(apps.activeTab);
      if (apps.activeTab === '_tools') refreshToolsPanel(panelOf('_tools'));
    }
  }

  function render() {
    renderTabStrip();
    renderContent();
  }

  // --- Grid panel ---

  function formatBytes(bytes) {
    if (bytes == null || isNaN(bytes)) return '';
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = bytes / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (v >= 100 || v % 1 === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
  }

  // Compact git badge for a row; clicking it opens the git modal. A clean
  // tree is a faint glyph, changes / commits ahead carry their count.
  function renderCardGit(name) {
    const git = apps.meta.git[name];
    let label = '', cls = 'dim', tip = 'Git: clean';
    if (git && git.dirty) {
      const n = git.modified + git.untracked;
      label = `±${n}`; cls = 'warn'; tip = `Git: ${n} changed`;
    } else if (git && git.ahead > 0) {
      label = `↑${git.ahead}`; cls = 'info'; tip = `Git: ${git.ahead} commit${git.ahead === 1 ? '' : 's'} ahead`;
    }
    return `<span class="apps-ico click ${cls}" ${vcAct.attrs('click', 'appsModule.showGitModal', [name], { stop: true })} title="${escHtml(tip)} — click for options">${ROW_ICONS.git}${escHtml(label)}</span>`;
  }

  function platformBooting() {
    return apps.bootStatus && apps.bootStatus.phase !== 'ready';
  }

  function bootStageText() {
    const b = apps.bootStatus;
    if (!b) return '';
    if (b.db === 'connecting') return 'Connecting to database...';
    if (b.apps && b.apps.state === 'pending') return 'Preparing apps...';
    if (b.apps && b.apps.state === 'starting') {
      const cur = b.apps.current ? ': ' + b.apps.current : '';
      return `Starting apps (${Math.min(b.apps.done + 1, b.apps.total)}/${b.apps.total})${cur}`;
    }
    if (b.accounts === 'checking') return 'Checking accounts...';
    return 'Finishing up...';
  }

  function renderBootBanner() {
    if (!platformBooting()) return '';
    return `<div class="app-boot-banner">
      <span class="app-boot-spinner"></span>
      <div class="app-boot-text">
        <div class="app-boot-title">Platform is starting up</div>
        <div class="app-boot-stage">${escHtml(bootStageText())} &mdash; apps may be unavailable until startup completes</div>
      </div>
    </div>`;
  }

  // --- Apps table view state (client-side; survives re-renders) ---
  // Rows are grouped by local state. The filter segment narrows to one group,
  // search narrows rows; collapse and sort are a pure view preference kept in
  // localStorage. Everything else renders from server state.

  const APP_GROUPS = [
    { key: 'attention', label: 'Attention' },
    { key: 'running', label: 'Running' },
    { key: 'stopped', label: 'Stopped' },
    { key: 'standalone', label: 'Standalone' },
  ];
  const VIEW_KEY = 'vc.apps.view';
  const view = (() => {
    try {
      const v = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}');
      return { collapsed: Array.isArray(v.collapsed) ? v.collapsed : [], sort: v.sort && v.sort.key ? v.sort : null };
    } catch { return { collapsed: [], sort: null }; }
  })();
  function saveView() { try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch {} }

  // Lamp / row state: standalone · starting · failed · running · autostart-down · ''.
  function appStatusClass(app) {
    if (app.standalone === true) return 'standalone';
    if (app._starting) return 'starting';
    if (app._failed) return 'failed';
    if (app.running) return 'running';
    if (app.autostart) return 'autostart-down';
    if (app._crashed) return 'failed';
    return '';
  }

  // Attention: failed, crashed, autostart stopped, needs restart.
  function groupOf(app) {
    if (app.standalone === true) return 'standalone';
    if (app._failed || app._crashed || apps.needRestart.has(app.name)
      || (app.autostart && !app.running && !app._starting)) return 'attention';
    return app.running || app._starting ? 'running' : 'stopped';
  }

  function appMatchesQuery(app, q) {
    if (!q) return true;
    const hay = [app.name, app.description || '', app.domain || '', ...(apps.tools.get(app.name) || []).map(t => t.name)].join(' ').toLowerCase();
    return hay.includes(q);
  }

  function setGridFilter(filter) {
    apps.gridFilter = filter;
    refreshTable();
    const v = document.querySelector('#view-apps .apps-view');
    if (v) v.scrollTop = 0;
  }

  function setGridQuery(q) {
    apps.gridQuery = q;
    refreshTable();
  }

  function toggleGroup(key) {
    const i = view.collapsed.indexOf(key);
    if (i >= 0) view.collapsed.splice(i, 1); else view.collapsed.push(key);
    saveView();
    refreshTable();
  }

  // Sorting applies within each group. Name starts ascending, metrics start
  // biggest-first; a third click returns to the server's order.
  const SORT_KEYS = {
    name: (a) => a.name.toLowerCase(),
    disk: (a) => apps.meta.sizes[a.name] ?? -1,
    db: (a) => apps.meta.dbSizes[a.name] ?? -1,
    spend: (a) => Number(apps.meta.spend?.[a.name]?.today ?? -1),
    errors: (a) => a._errors || 0,
  };
  function setSort(key) {
    if (!SORT_KEYS[key]) return;
    const first = key === 'name' ? 'asc' : 'desc';
    const s = view.sort;
    if (!s || s.key !== key) view.sort = { key, dir: first };
    else if (s.dir === first) view.sort = { key, dir: first === 'asc' ? 'desc' : 'asc' };
    else view.sort = null;
    saveView();
    refreshTable();
  }
  function sortRows(list) {
    const s = view.sort;
    const f = s && SORT_KEYS[s.key];
    if (!f) return list;
    const d = s.dir === 'desc' ? -1 : 1;
    return list.slice().sort((x, y) => {
      const a = f(x), b = f(y);
      return ((a < b ? -1 : a > b ? 1 : 0) * d) || x.name.localeCompare(y.name);
    });
  }

  // --- Setup button (right end of the Apps tab strip, visible on every tab) ---

  function accountIssues() {
    const c = apps.connectivity;
    return c && c.status === 'done' ? (c.results || []).reduce((n, r) => n + ((r.issues || []).length), 0) : 0;
  }

  // `?setup=<pane>` (e.g. ?setup=extras — the master's publish warning links a
  // slave's Unity sign-in here) opens Setup on that pane once, then drops the
  // parameter from the address.
  let setupDeepLinkDone = false;
  function openSetupDeepLink() {
    if (setupDeepLinkDone) return;
    setupDeepLinkDone = true;
    try {
      const u = new URL(window.location.href);
      const pane = u.searchParams.get('setup');
      if (!pane || !/^[a-z-]{1,32}$/.test(pane)) return;
      u.searchParams.delete('setup');
      history.replaceState(history.state, '', u.pathname + u.search + u.hash);
      showSetup(pane);
    } catch {}
  }

  // The unity extra is installed but its licence is missing or lapsed: apps
  // that run Unity exit 3 until the owner signs in (Setup → Extras).
  function unityLicenceAttention() {
    const u = (apps.extras || []).find(x => x.id === 'unity');
    const st = u?.installed && u.license?.status;
    return !!(st && !st.error && !st.active);
  }

  function renderSetupBtn() {
    const issues = accountIssues();
    const unity = unityLicenceAttention();
    const count = issues + (unity ? 1 : 0);
    const checking = apps.connectivity?.status === 'checking';
    const dot = count > 0 ? 'warn' : apps.db.connected ? 'ok' : '';
    const title = count > 0
      ? [issues > 0 ? `${issues} account issue${issues === 1 ? '' : 's'}` : '', unity ? 'Unity licence missing — sign in under Extras' : ''].filter(Boolean).join(' · ') + ' — click to fix'
      : `Platform setup · db ${apps.db.connected ? 'connected' : 'not configured'}${checking ? ' · checking accounts…' : ''}`;
    const target = issues > 0 ? ['accounts'] : unity ? ['extras'] : [];
    return `<button class="vc-btn apps-setup-btn" id="appsSetupBtn" ${vcAct.attrs('click', 'appsModule.showSetup', target)} title="${escHtml(title)}"><span class="vc-dot ${dot}${checking ? ' checking' : ''}"></span>Setup${count > 0 ? `<span class="vc-badge">${count}</span>` : ''}</button>`;
  }

  function patchSetupBtn() {
    const el = document.getElementById('appsSetupBtn');
    if (el) el.outerHTML = renderSetupBtn();
  }

  function renderStrip() {
    const dbLabel = apps.db.connected ? (apps.db.config?.host || 'localhost') + ':' + (apps.db.config?.port || 3306) : 'not configured';
    const total = apps.list.length;
    const running = apps.list.filter(a => a.running || a.standalone === true).length;
    const failed = apps.list.filter(a => a._failed || a._crashed).length;
    const building = apps.list.filter(a => a._starting).length;
    const f = apps.gridFilter || 'all';
    // Every segment carries its group's population: the strip is the fleet
    // readout, so "nothing needs attention" is visible without clicking.
    const counts = { all: total, attention: 0, running: 0, stopped: 0, standalone: 0 };
    for (const a of apps.list) counts[groupOf(a)]++;
    const lamp = failed ? 'failed' : building ? 'starting' : running ? 'running' : '';
    const seg = (key, label, cls) => `<button data-filter="${key}" class="${f === key ? 'on' : ''}${cls ? ' ' + cls : ''}${counts[key] ? ' has' : ''}" ${vcAct.attrs('click', 'appsModule.setGridFilter', [key])}>${label}<i>${counts[key]}</i></button>`;
    return `<div class="vc-strip">
      <i class="vc-tick"></i>
      <div class="vc-strip-title">
        <div class="vc-strip-h"><span class="vc-lamp ${lamp}"></span><h2>Apps</h2></div>
        <div class="vc-lbl">${total} app${total === 1 ? '' : 's'} · <i>${running} running</i>${failed ? ` · <em>${failed} failed</em>` : ''}${building ? ` · <b>${building} building</b>` : ''} · db ${escHtml(dbLabel)}</div>
      </div>
      <label class="vc-search"><span>&#8981;</span><input type="search" id="appsGridSearch" placeholder="search apps, tools, domains" value="${escHtml(apps.gridQuery || '')}" ${vcAct.attrs('input', 'appsModule.setGridQuery', [{ $: 'value' }])} autocomplete="off"><kbd>/</kbd></label>
      <div class="vc-seg">${seg('all', 'All')}${seg('attention', 'Attention', 'attn')}${seg('running', 'Running')}${seg('stopped', 'Stopped')}${seg('standalone', 'Standalone')}</div>
      <i class="vc-strip-div"></i>
      <div class="vc-strip-actions">
        <button class="vc-btn" ${vcAct.attrs('click', 'appsModule.openToolsOverview', [])} title="Every tool the platform exposes, and who may call it">&#9874; Tools</button>
        <button class="vc-btn" ${vcAct.attrs('click', 'spendAdmin.showOverview', [])} title="Spend & permissions for every app: policies, caps, ledgers, unit prices">&cent; Spend</button>
        <button class="vc-btn" ${vcAct.attrs('click', 'appsModule.openHelp', [])} title="Help">?</button>
        <button class="vc-btn primary" ${vcAct.attrs('click', 'appsModule.showCreate', [])}>+ New app</button>
      </div>
    </div>`;
  }

  // The row's status line: state, then the facts that matter for that state
  // (the runtime error count has its own column).
  function renderCardTele(app, statusClass) {
    const standalone = app.standalone === true;
    const parts = [];
    if (standalone) parts.push('<span class="info">standalone</span>');
    else if (app._starting) parts.push('<span class="warn">starting…</span>');
    else if (app._failed) parts.push('<span class="bad">failed</span>');
    else if (app.running) parts.push('<span class="ok">running</span>');
    else if (app._crashed) parts.push('<span class="bad">crashed</span>');
    else if (statusClass === 'autostart-down') parts.push('<span class="bad">autostart stopped</span>');
    else parts.push('stopped');
    if (app._failed && app._failError) parts.push(`<span class="msg" title="${escHtml(app._failError)}">${escHtml(app._failError.split('\n')[0].slice(0, 90))}</span>`);
    if (tgBoundNames.has(app.name)) parts.push('telegram');
    if (app.autostart && !standalone) parts.push('autostart');
    if (app.deployed) parts.push('mirror');
    return `<div class="vc-tele">${parts.join('<span class="sep">·</span>')}</div>`;
  }

  // --- Cross-app change requests -------------------------------------------
  // A change session on one app asked the owner to open a change session on
  // another. The owner decides once, in the modal below; the chips keep both
  // cards honest about who is waiting on whom. Server state (app:changeRequests)
  // is the only source — a GUI reload re-renders from it.
  const CR_TERMINAL = new Set(['done', 'denied', 'ended', 'cancelled']);
  // A platform target names a bridge method or a ctx member instead of a tool
  // or a bus kind — the same record, a different vocabulary.
  const CR_KINDS = { tool: 'tool', event: 'event', method: 'bridge method', ctx: 'ctx member' };

  function crKindLabel(r) {
    return CR_KINDS[r.interface.kind] || r.interface.kind;
  }

  function crActive() {
    return (apps.changeRequests || []).filter((r) => !CR_TERMINAL.has(r.state));
  }

  // A `done` the platform's check could not confirm stays on both cards for a
  // day: the target reported success, the asking app did not get it. Old
  // records carry no `outcome`, only `verified: false`.
  const CR_UNVERIFIED_SHOW_MS = 24 * 3600000;
  function crUnverified(r) {
    return r.state === 'done' && (r.outcome === 'unverified' || r.verified === false);
  }
  function crRecentUnverified() {
    const since = Date.now() - CR_UNVERIFIED_SHOW_MS;
    return (apps.changeRequests || []).filter((r) => crUnverified(r) && (r.doneAt || 0) >= since);
  }

  function renderCardChangeRequests(name) {
    const out = [];
    for (const r of crActive()) {
      if (r.from === name) {
        const target = r.to === 'platform' ? 'the platform' : `"${r.to}"`;
        if (r.state === 'queued') {
          // Not invisible: it says whose session it waits for, and a click opens
          // the modal that can inject it now or cancel it.
          const tip = `This session asked for the ${crKindLabel(r)} "${r.interface.name}" from ${target}, which has a session open — click to inject it now or cancel`;
          out.push(`<span class="vc-chip click warn" title="${escHtml(tip)}" ${vcAct.attrs('click', 'appsModule.showChangeRequestModal', [r.id], { stop: true })}>${escHtml(`waiting for ${r.to === 'platform' ? 'the platform' : r.to}'s open session`)}</span>`);
          continue;
        }
        const what = r.state === 'pending' ? `asking you about ${target}` : `waiting on ${target}`;
        out.push(`<span class="vc-chip click info" title="${escHtml(`This session asked for the ${crKindLabel(r)} "${r.interface.name}" from ${target} — click to cancel`)}" ${vcAct.attrs('click', 'appsModule.cancelChangeRequest', [r.id], { stop: true })}>${escHtml(what)} &times;</span>`);
      } else if (r.to === name) {
        const label = r.state === 'queued' ? `queued for "${r.from}"` : `requested by "${r.from}"`;
        const tip = r.state === 'queued'
          ? `"${r.from}" is waiting for the ${crKindLabel(r)} "${r.interface.name}" — the change session starts when this app's tab closes, or inject it into this tab now`
          : `A change session is open here for "${r.from}": the ${crKindLabel(r)} "${r.interface.name}"`;
        out.push(r.state === 'queued'
          ? `<span class="vc-chip click warn" title="${escHtml(`${tip} — click to inject it now or cancel`)}" ${vcAct.attrs('click', 'appsModule.showChangeRequestModal', [r.id], { stop: true })}>${escHtml(label)}</span>`
          : `<span class="vc-chip info" title="${escHtml(tip)}">${escHtml(label)}</span>`);
      }
    }
    for (const r of crRecentUnverified()) {
      if (r.from !== name && r.to !== name) continue;
      const target = r.to === 'platform' ? 'the platform' : `"${r.to}"`;
      const label = r.from === name ? `unverified: ${r.to === 'platform' ? 'platform' : r.to}` : `unverified for "${r.from}"`;
      const tip = `${target} reported the ${crKindLabel(r)} "${r.interface.name}" done for "${r.from}", but the check did not find it: ${r.verifyDetail || 'not found'}`;
      out.push(`<span class="vc-chip warn" title="${escHtml(tip)}">${escHtml(label)}</span>`);
    }
    return out.join('');
  }

  // The single confirmation. Nothing opens on the target app until the owner
  // presses Open here; the prompt is editable because the owner knows the app.
  function showChangeRequestModal(id) {
    const rec = (apps.changeRequests || []).find((r) => r.id === id);
    document.querySelector('.app-change-request-modal')?.remove();
    if (!rec || (rec.state !== 'pending' && rec.state !== 'queued')) return;

    // The server says whether the target is occupied right now (rec.targetBusy,
    // live) and whether the request can be written into the open session
    // (rec.canInject, never for a platform target). A queued request is shown
    // again here so it can still be injected or cancelled.
    const queued = rec.state === 'queued';
    const busy = !!rec.targetBusy;
    const canInject = !!rec.canInject;
    // A platform target is a different decision: the session it opens runs in
    // the platform repository, on text an app session wrote. Nothing opens
    // until this click, and the modal says exactly that.
    const platform = rec.to === 'platform';
    const targetText = platform ? 'the platform' : `“${rec.to}”`;
    const target = escHtml(targetText);
    // Adding to a live interface is a different decision from adding a new
    // one: the owner is approving a change to something that already has
    // callers, so the modal says which, and what it takes today.
    const extend = rec.mode === 'extend';
    const kind = escHtml(crKindLabel(rec));
    const name = escHtml(rec.interface.name);
    const inCap = platform && rec.capability ? ` in capability <code>${escHtml(rec.capability)}</code>` : '';
    const iface = extend
      ? `It needs a change to the <b>${kind}</b> <code>${name}</code>${inCap}, which ${target} already provides. It must stay backwards compatible.`
      : `It needs a new <b>${kind}</b> <code>${name}</code>${inCap} from ${target}.`;
    const platformNote = platform
      ? `<div class="vc-fixbar warn"><span>Open starts a Claude session in <b>platform</b> with the request above as its first message. It may edit the platform source, never core and never an app; it runs the full test suite and reports back. The change takes effect only after <b>you</b> restart the control room.</span></div>`
      : '';
    const today = extend && rec.before?.params?.length
      ? ` It takes <code>${rec.before.params.map(escHtml).join('</code>, <code>')}</code> today.`
      : '';
    const adds = (rec.adds || []).length
      ? `<div class="app-cr-adds">Missing: <code>${rec.adds.map(escHtml).join('</code>, <code>')}</code>.${today}</div>`
      : (today ? `<div class="app-cr-adds">${today.trim()}</div>` : '');
    const chain = (rec.chain || []).length > 2 ? `<div class="app-cr-chain">chain: ${escHtml(rec.chain.join(' → '))}</div>` : '';
    const busyNote = !busy ? '' : platform
      ? `<div class="vc-fixbar warn"><span>${target} already has a session open — ${queued ? 'this request starts' : 'queueing it starts it'} when that session closes (a platform request is never injected).</span></div>`
      : (canInject
        ? `<div class="vc-fixbar warn"><span>${target} has a change session open${rec.targetTab ? ` (<code>${escHtml(rec.targetTab)}</code>)` : ''}. ${queued ? 'This request is waiting for it to close; you can inject it now.' : 'Inject the request into that session as a new message (it waits for the current turn), or queue it until the session closes.'}</span></div>`
        : `<div class="vc-fixbar warn"><span>${target} is being opened for another request — this one starts when that session closes.</span></div>`);
    const modal = document.createElement('div');
    modal.className = 'app-tools-modal app-change-request-modal';
    modal.innerHTML = `
      <div class="app-tools-modal-content">
        <div class="app-tools-modal-header">
          <span>&ldquo;${escHtml(rec.from)}&rdquo; asks to change ${target}</span>
          <button class="app-log-modal-close" title="Decide later">&times;</button>
        </div>
        <div class="app-tools-modal-body">
          <div class="app-cr-iface">${iface}</div>
          ${adds}
          ${rec.reason ? `<div class="app-cr-reason">${escHtml(rec.reason)}</div>` : ''}
          ${chain}
          ${platformNote}
          ${busyNote}
          ${rec.injectError ? `<div class="vc-fixbar warn"><span>Injecting failed: ${escHtml(rec.injectError)}. The request stays queued.</span></div>` : ''}
          <label class="app-cr-label">The request that will be sent to ${busy && canInject ? 'the open session on' : 'the change session on'} ${target} (editable):</label>
          <textarea class="app-cr-prompt" spellcheck="false">${escHtml(rec.prompt)}</textarea>
          ${queued ? '' : `<label class="app-cr-label">Reason to give back if you deny (optional):</label>
          <input class="app-cr-deny-reason" type="text" placeholder="${platform ? 'e.g. batched with the other gaps, not now' : 'e.g. that belongs in the platform, not in this app'}">`}
        </div>
        <div class="app-tools-footer app-cr-footer">
          ${queued
            ? `<button class="app-cr-cancel">Cancel request</button>${canInject ? '<button class="app-cr-inject primary">Inject now</button>' : ''}`
            : `<button class="app-cr-deny">Deny</button>${busy
              ? `<button class="app-cr-queue${canInject ? '' : ' primary'}">Queue until it closes</button>${canInject ? '<button class="app-cr-inject primary">Inject into the open session</button>' : ''}`
              : `<button class="app-cr-open primary">Open change on ${target}</button>`}`}
        </div>
      </div>`;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('.app-log-modal-close').onclick = close;
    modal.onclick = (e) => { if (e.target === modal) close(); };
    const promptText = () => modal.querySelector('.app-cr-prompt').value;
    const on = (sel, fn) => { const el = modal.querySelector(sel); if (el) el.onclick = () => { fn(); close(); }; };
    on('.app-cr-open', () => sendWs({ type: 'app:changeRequest:decide', id: rec.id, ok: true, prompt: promptText() }));
    on('.app-cr-queue', () => sendWs({ type: 'app:changeRequest:decide', id: rec.id, ok: true, mode: 'queue', prompt: promptText() }));
    on('.app-cr-deny', () => sendWs({ type: 'app:changeRequest:decide', id: rec.id, ok: false, reason: modal.querySelector('.app-cr-deny-reason').value }));
    on('.app-cr-cancel', () => sendWs({ type: 'app:changeRequest:cancel', id: rec.id }));
    // The click is the confirm: a pending request is decided and written in one
    // step, a queued one is written now.
    on('.app-cr-inject', () => sendWs(queued
      ? { type: 'app:changeRequest:inject', id: rec.id, prompt: promptText() }
      : { type: 'app:changeRequest:decide', id: rec.id, ok: true, mode: 'inject', prompt: promptText() }));
  }

  function cancelChangeRequest(id) {
    sendWs({ type: 'app:changeRequest:cancel', id });
  }

  // --- Toolchain chip: a heavy platform extra this app declares -------------
  // manifest.toolchains is an advertisement (like `capabilities`), never a
  // gate. The chip answers the one question that matters on a fresh box: can
  // this app do its heavy work here, or is a Setup -> Extras install missing?
  // The toolchain key → extra map is the server's (each extras row carries its
  // `toolchain` key and `badge` label — platform-extras.js TOOLCHAINS, which
  // publish uses too); until the rows arrive the chip shows the bare key.
  function renderCardToolchains(app) {
    const declared = Array.isArray(app.toolchains) ? app.toolchains : [];
    if (!declared.length) return '';
    // apps.extras is loaded lazily by the Setup pane; ask once so the chip can
    // show real state instead of guessing.
    if (!apps.extras && !apps._extrasAsked) { apps._extrasAsked = true; sendWs({ type: 'app:extras:status' }); }
    return declared.map((key) => {
      const ex = (apps.extras || []).find((x) => x.toolchain === key);
      if (apps.extras && !ex) return '';
      const meta = { label: ex?.badge || String(key) };
      const cls = !ex ? 'dash' : ex.installing ? 'info' : ex.installed ? 'ok' : 'warn';
      const tip = !ex
        ? `${meta.label} toolchain declared by this app`
        : ex.installing
          ? `${meta.label} toolchain is installing (${ex.progress}%)`
          : ex.installed
            ? `${meta.label} toolchain installed — this host can run what the app needs it for`
            : `${meta.label} toolchain NOT installed — install under Setup > Extras > ${ex.title}`;
      return `<span class="vc-chip ${cls}" title="${escHtml(tip)}">${escHtml(meta.label)}${ex && !ex.installed && !ex.installing ? ' !' : ''}</span>`;
    }).join('');
  }

  // --- Remote chip: where this app lives on the linked slaves ---------------
  // Reads the live fleet view publish.js keeps (app:fleet:state). One chip
  // aggregates every peer — worst state wins the colour — and the hover
  // tooltip lists them one by one. Master only; a slave's mirror status is
  // already in the tele line.

  function fmtAgo(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return 'on ' + new Date(ts).toLocaleDateString();
  }

  function remoteInfo(name) {
    const pm = window.publishModule;
    if (!pm || !pm.isMaster()) return null;
    const fleet = pm.state?.fleet || [];
    if (!fleet.length) return null;
    const rows = [];
    let reporting = 0;
    for (const f of fleet) {
      if (f.connected || f.lastSeen || Object.keys(f.deployed || {}).length) reporting++;
      const dep = f.deployed?.[name];
      if (!dep) continue;
      const commit = typeof dep === 'string' ? dep : dep.commit;
      const behind = (dep && typeof dep === 'object' && dep.behind != null) ? dep.behind : null;
      const disabled = !!(dep && typeof dep === 'object' && dep.disabled) || (f.disabled || []).includes(name);
      const health = disabled ? 'off' : (f.appHealth?.[name] || 'unknown');
      rows.push({ peer: f.name, connected: !!f.connected, lastSeen: f.lastSeen, commit, behind, disabled, health, job: f.lastJobs?.[name] || null, sites: f.appSites?.[name] || [] });
    }
    return { peers: fleet.length, reporting, rows };
  }

  // Read-only sites line of a remote row: `main ● running :8080 · 2 crashes`.
  function remoteSitesLine(r, cls) {
    if (!r.sites || !r.sites.length) return '';
    const parts = r.sites.map((x) => `${escHtml(x.site)} <span class="vc-site-dot ${SITE_DOT[x.state] || 'dim'}"></span>${escHtml(x.state)}${x.port ? ' :' + escHtml(String(x.port)) : ''}${x.crashCount ? ` <span class="warn">${escHtml(String(x.crashCount))} crash${x.crashCount === 1 ? '' : 'es'}</span>` : ''}${x.fence === 'unfenced' ? ' <span class="warn">unfenced</span>' : ''}`);
    return `<div class="${cls}">sites: ${parts.join(' &middot; ')}</div>`;
  }

  function remoteChipClick(name) {
    hideRemoteTip();
    window.publishModule?.showPublish(name);
  }

  let remoteTipEl = null;
  function hideRemoteTip() { remoteTipEl?.remove(); remoteTipEl = null; }

  function showRemoteTip(anchor, name) {
    hideRemoteTip();
    const info = remoteInfo(name);
    if (!info) return;
    const fleet = window.publishModule?.state?.fleet || [];
    const lines = [];
    if (!info.rows.length) {
      lines.push(`<div class="vc-remote-tip-row"><span class="vc-remote-tip-dim">${info.reporting ? `Not published to any of the ${info.peers} linked slave${info.peers === 1 ? '' : 's'}.` : 'No slave has reported yet — the peer channel is not connected.'}</span></div>`);
    }
    for (const r of info.rows) {
      const seen = r.connected ? 'live' : (r.lastSeen ? `down · seen ${fmtAgo(r.lastSeen)}` : 'never connected');
      let rev;
      if (r.behind > 0) rev = `<span class="warn">${r.behind} commit${r.behind === 1 ? '' : 's'} behind</span>`;
      else if (r.behind === 0) rev = '<span class="ok">current</span>';
      else rev = '<span class="vc-remote-tip-dim">revision not compared yet</span>';
      const health = r.disabled ? '<span class="vc-remote-tip-dim">disabled there</span>'
        : r.health === 'ok' ? '<span class="ok">healthy</span>'
        : r.health === 'unknown' ? '<span class="vc-remote-tip-dim">health unknown</span>'
        : `<span class="warn">${escHtml(r.health)}</span>`;
      const job = r.job && r.job.status !== 'done' ? `<div class="vc-remote-tip-sub">${escHtml(r.job.name)}: <span class="${r.job.status === 'failed' ? 'warn' : ''}">${escHtml(r.job.status)}</span>${r.job.error ? ' — ' + escHtml(String(r.job.error).slice(0, 120)) : ''}</div>` : '';
      lines.push(`<div class="vc-remote-tip-row">
        <div class="vc-remote-tip-head"><span class="vc-remote-tip-dot${r.connected ? ' live' : ''}"></span><b>${escHtml(r.peer)}</b><span class="vc-remote-tip-dim">${escHtml(seen)}</span></div>
        <div class="vc-remote-tip-sub"><code>${escHtml(String(r.commit || '').slice(0, 8) || '—')}</code> · ${rev} · ${health}</div>${remoteSitesLine(r, 'vc-remote-tip-sub')}${job}
      </div>`);
    }
    const others = fleet.filter((f) => !info.rows.some((r) => r.peer === f.name));
    if (info.rows.length && others.length) lines.push(`<div class="vc-remote-tip-row vc-remote-tip-dim">not on: ${others.map((f) => escHtml(f.name)).join(', ')}</div>`);
    lines.push('<div class="vc-remote-tip-foot">click to publish · history &amp; rollback in ⚙ → Remote</div>');
    const tip = document.createElement('div');
    tip.className = 'vc-remote-tip';
    tip.innerHTML = lines.join('');
    document.body.appendChild(tip);
    const r = anchor.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    let top = r.top - h - 8;
    if (top < 8) top = r.bottom + 8;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    remoteTipEl = tip;
  }

  // Slaves cell: one dot per linked peer — current (green), behind / job
  // failed / unhealthy (amber), not published (hollow), peer offline (dim).
  // Hover keeps the per-peer tooltip; click opens the publish modal.
  function slaveDotState(r) {
    if (!r.connected) return 'off';
    if (r.behind > 0 || (r.job && r.job.status === 'failed')
      || (!r.disabled && r.health !== 'ok' && r.health !== 'unknown')) return 'behind';
    return 'current';
  }

  const SLAVE_DOT_TIP = { current: 'current', behind: 'needs attention', off: 'peer offline', none: 'not published' };
  function renderSlaveCell(name) {
    const info = remoteInfo(name);
    if (!info) return '<span class="apps-nil" title="No linked slaves">–</span>';
    const n = escHtml(name);
    const fleet = window.publishModule?.state?.fleet || [];
    const dots = fleet.map((f) => {
      const r = info.rows.find((x) => x.peer === f.name);
      const st = r ? slaveDotState(r) : 'none';
      return `<i class="apps-slave ${st}${!r && !f.connected ? ' off' : ''}" aria-label="${escHtml(f.name)}: ${SLAVE_DOT_TIP[st]}"></i>`;
    }).join('');
    return `<span class="apps-slaves" data-remote="${n}" ${vcAct.attrs('click', 'appsModule.remoteChipClick', [n], { stop: true })} ${vcAct.attrs('mouseenter', 'appsModule.showRemoteTip', [{ $: 'this' }, n])} ${vcAct.attrs('mouseleave', 'appsModule.hideRemoteTip', [])}>${dots}</span>`;
  }

  // Fleet updates arrive on their own message (app:fleet:state, via
  // publish.js) — patch the slaves cells in place instead of re-rendering.
  function patchRemoteChips() {
    hideRemoteTip();
    settingsRefresh();
    document.querySelectorAll('#view-apps tr.apps-row[data-app] > td.c-slaves').forEach((td) => {
      td.innerHTML = renderSlaveCell(td.parentElement.dataset.app);
    });
  }

  // Compact row badges with tooltips: access, independent, provides tools,
  // domain, toolchains, change requests, git. Warnings stay visible here.
  const ROW_ICONS = {
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/></svg>',
    tools: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
    indep: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>',
    git: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7"/><path d="M18 10.5c0 4-6 3-11 6"/></svg>',
  };

  function renderRowBadges(app) {
    const name = app.name;
    const out = [];
    const { level, channels } = accessOf(app);
    if (level === 'open') out.push(`<span class="apps-ico warn" title="Open: the whole app is reachable by anyone without a login. Owner services are revoked for it (Spend &amp; permissions).">${ROW_ICONS.globe}open</span>`);
    else if (level === 'users') out.push(`<span class="apps-ico ok" title="${escHtml(`Users: reachable from the internet at /apps/${name}/ — visitors land on app.html and must sign in (${channels.join(', ')}); every /api/* route needs a signed-in user except /api/app/pub/*.`)}">${ROW_ICONS.users}${channels.map((c) => CHANNEL_SHORT[c]).join('·')}</span>`);
    else out.push(`<span class="apps-ico dim" title="Private: only you, from the dashboard. Nothing is reachable without the Vistaclair login.">${ROW_ICONS.lock}</span>`);
    const independent = app.platformContribution === false;
    if (independent) out.push(`<span class="apps-ico dim" title="Marked independent: invisible to Horst — no tools in the platform union, no events, no docs in his digest, no governance">${ROW_ICONS.indep}</span>`);
    const tools = apps.tools.get(name) || [];
    if (tools.length) {
      const provides = !independent && app.autostart && tools.some((t) => t.expose && t.expose !== 'self');
      const list = tools.map((t) => `${t.name}${t.expose && t.expose !== 'self' ? ` (${exposeMeta(t.expose).label})` : ''}`).join(', ');
      const tip = `${tools.length} MCP tool${tools.length === 1 ? '' : 's'}: ${list}${provides ? ' — provides tools to the platform or other apps, so it autostarts' : ''} — click for details`;
      out.push(`<span class="apps-ico click ${provides ? 'info' : 'dim'}" ${vcAct.attrs('click', 'appsModule.showTools', [name], { stop: true })} title="${escHtml(tip)}">${ROW_ICONS.tools}${tools.length}</span>`);
    }
    if (app.domain) out.push(`<span class="apps-ico dom" title="Custom domain: ${escHtml(app.domain)}">${ROW_ICONS.globe}<span class="apps-ico-txt">${escHtml(app.domain)}</span></span>`);
    out.push(renderCardToolchains(app));
    out.push(renderCardChangeRequests(name));
    out.push(renderCardGit(name));
    return `<span class="apps-badges">${out.join('')}</span>`;
  }

  function renderRowMetrics(app) {
    const name = app.name;
    const n = escHtml(name);
    const disk = apps.meta.sizes[name];
    const db = apps.meta.dbSizes[name];
    const dbName = apps.meta.dbNames[name];
    const split = (s) => { const m = /^(.+?)\s([A-Z]+)$/.exec(s || ''); return m ? `${escHtml(m[1])} <small>${m[2]}</small>` : escHtml(s || '–'); };
    const errs = app._errors || 0;
    const errClick = errs && app.hasServer ? ` ${vcAct.attrs('click', 'appsModule.showLogs', [n], { stop: true })}` : '';
    return `<td class="c-num is-link" ${vcAct.attrs('click', 'appsModule.openAppDir', [n], { stop: true })} title="Open ${n} directory">${disk != null ? split(formatBytes(disk)) : '–'}</td>
      <td class="c-num${db != null ? '' : ' is-empty'}" title="${db != null ? `Database: ${escHtml(dbName || '?')}` : 'No database provisioned'}">${db != null ? split(formatBytes(db)) : '<small>none</small>'}</td>
      <td class="c-num c-spend">${window.spendAdmin ? window.spendAdmin.tile(name) : '–'}</td>
      <td class="c-num${errs ? ' is-bad' + (errClick ? ' is-link' : '') : ' is-empty'}"${errClick} title="${errs ? `${errs} runtime error${errs === 1 ? '' : 's'} recorded${errClick ? ' — click for the server log' : ''}` : 'No runtime errors'}">${errs || '–'}</td>`;
  }

  // Fixed order, fixed slots: Start/Stop · Open · Change · Publish. An action
  // that does not apply is disabled, never removed, so nothing shifts.
  function renderRowActions(app) {
    const n = escHtml(app.name);
    const standalone = app.standalone === true;
    const btn = (label, call, { cls = '', title = '', disabled = false } = {}) =>
      `<button class="${cls}"${disabled ? ' disabled' : ''} title="${escHtml(title)}" ${disabled || !call ? '' : vcAct.attrs('click', call[0], call[1], { stop: true })}>${label}</button>`;
    let first;
    if (app._failed || app._crashed) {
      first = `<span class="apps-act-pair">${btn('Logs', ['appsModule.showLogs', [n]], { disabled: !app.hasServer, title: app.hasServer ? 'Server output' : 'No server process' })}${btn('Restart', ['appsModule.restartApp', [n]], { cls: 'warn', title: 'Restart the app' })}</span>`;
    } else if (standalone) {
      first = btn('&#9654; Start', '', { disabled: true, title: 'Standalone: started and stopped outside the platform (pm2)' });
    } else if (app._starting) {
      first = btn('Starting…', '', { disabled: true, title: 'The app is starting' });
    } else if (app.running) {
      first = btn('&#9632; Stop', ['appsModule.stopAppConfirm', [n]], { cls: 'apps-act-toggle', title: 'Stop the app' });
    } else {
      first = btn('&#9654; Start', ['appsModule.toggleApp', [n, true]], { cls: 'apps-act-toggle', title: 'Start the app without opening it' });
    }
    const live = app.running || standalone;
    const open = btn(live ? 'Open &#8599;' : 'Open &#9654;', ['appsModule.openApp', [n]], { cls: 'go', title: app.display === 'fullscreen' ? 'Open in a chrome-free tab' : live ? 'Open the app' : 'Start and open the app' });
    const change = btn('Change', ['appsModule.openCli', [n]], { disabled: standalone, title: standalone ? 'Standalone apps are changed outside the platform' : isMasterMirror(app) ? 'Change with AI — mirror, edits are temporary' : 'Change with AI' });
    const master = !!window.publishModule?.isMaster();
    const publish = btn('Publish', ['appsModule.remoteChipClick', [n]], { disabled: !master, title: master ? 'Publish to a slave (opens the publish dialog)' : 'Publishing needs this host to be a master with linked slaves' });
    return `<div class="apps-acts">${first}${open}${change}${publish}</div>`;
  }

  // Who stops working when this app stops: consumers in app-deps, and the
  // platform / other apps when it exposes tools beyond itself.
  function stopDependents(name) {
    const app = apps.list.find((a) => a.name === name);
    const consumers = [...new Set((apps.deps?.edges || [])
      .filter((e) => e.status !== 'revoked' && e.provider === name).map((e) => e.consumer))];
    const exposed = app?.platformContribution === false ? []
      : (apps.tools.get(name) || []).filter((t) => t.expose && t.expose !== 'self');
    const who = [];
    if (consumers.length) who.push(consumers.map((c) => `"${c}"`).join(', '));
    if (exposed.length) {
      const toApps = exposed.some((t) => t.expose === 'apps');
      who.push(`${toApps ? 'Horst, cron and other apps' : 'Horst and cron'} (${exposed.length} exposed tool${exposed.length === 1 ? '' : 's'}: ${exposed.map((t) => t.name).join(', ')})`);
    }
    return who;
  }

  async function stopAppConfirm(name) {
    const who = stopDependents(name);
    if (who.length && !(await showConfirm(`Stop "${name}"? ${who.join(' and ')} depend on it — their calls fail until it runs again.`, { confirmLabel: 'Stop', danger: true }))) return;
    toggleApp(name, false, { stopSites: await askStopSites(name) });
  }

  // An app with sites keeps them running when it stops; ask whether to stop them too.
  async function askStopSites(name) {
    const app = apps.list.find((a) => a.name === name);
    if (!app || !app.sites || typeof app.sites !== 'object' || !Object.keys(app.sites).length) return false;
    return showConfirm('Also stop its sites?', { confirmLabel: 'Stop sites too', cancelLabel: 'Keep sites running' });
  }

  const APPS_COLS = 11;

  function renderAppRow(app) {
    const n = escHtml(app.name);
    const sc = appStatusClass(app);
    const standalone = app.standalone === true;
    const own = standalone || appRuntimeOf(app) === 'own-process';
    const rtLabel = standalone ? 'standalone' : own ? 'own-proc' : 'in-proc';
    const nr = apps.needRestart.get(app.name);
    const fix = nr ? `<button class="apps-fix" ${vcAct.attrs('click', 'appsModule.restartApp', [n], { stop: true })} title="${escHtml(nr)}">&#8635; restart needed</button>` : '';
    return `<tr class="apps-row${sc ? ' is-' + sc : ''}${app.platformContribution === false ? ' is-independent' : ''}" data-app="${n}" ${vcAct.attrs('click', 'appsModule.openApp', [n])}>
      <td class="c-lamp"><span class="vc-lamp ${sc}"></span></td>
      <td class="c-name" title="${escHtml(app.description || 'No description')}"><div class="apps-name-cell"><span class="apps-name">${n}</span>${renderRowBadges(app)}</div></td>
      <td class="c-rt"><span class="vc-rt${own ? ' own' : ''}" title="${own ? 'Runs in its own process (crash and blocking containment)' : 'Runs inside the dashboard process'}">${rtLabel}</span></td>
      <td class="c-status"><div class="apps-status-cell">${renderCardTele(app, sc)}${fix}</div></td>
      ${renderRowMetrics(app)}
      <td class="c-slaves">${renderSlaveCell(app.name)}</td>
      <td class="c-actions">${renderRowActions(app)}</td>
      <td class="c-gear"><button class="apps-gear" ${vcAct.attrs('click', 'appsModule.openAppSettings', [n], { stop: true })} title="Settings and more actions">&#9881;</button></td>
    </tr>`;
  }

  // Horst — built-in resident agent, pinned above the groups. No app directory
  // behind it; opens the top-level Horst view (horst-tab.js). Status line
  // filled lazily by window.horstModule.fillCardStatus() into #horstCardStatus.
  function renderHorstRow() {
    const ph = '<button class="apps-act-ph" tabindex="-1" aria-hidden="true"></button>';
    return `<tr class="apps-row apps-row-horst" ${vcAct.attrs('click', 'horstModule.open', [])} title="Resident agent — chat, briefings, directives. Senses every app that contributes to the platform.">
      <td class="c-lamp"><span class="horst-card-glyph vc-avatar">H</span></td>
      <td class="c-name"><div class="apps-name-cell"><span class="apps-name">Horst</span><span class="apps-badges"><span class="vc-chip ok">resident</span></span></div></td>
      <td class="c-rt"><span class="vc-rt">built-in</span></td>
      <td class="c-status"><div class="apps-status-cell"><div class="vc-tele" id="horstCardStatus">&hellip;</div></div></td>
      <td class="c-num is-empty"></td><td class="c-num is-empty"></td><td class="c-num is-empty"></td><td class="c-num is-empty"></td>
      <td class="c-slaves"></td>
      <td class="c-actions"><div class="apps-acts">${ph}<button class="go" ${vcAct.attrs('click', 'horstModule.open', [], { stop: true })} title="Open Horst">Chat &#8599;</button>${ph}${ph}</div></td>
      <td class="c-gear"></td>
    </tr>`;
  }

  // Attention also carries the account-health banner and the Runtime errors
  // list (browser errors from app iframes, this session).
  function renderAttentionNotes() {
    let h = '';
    const c = apps.connectivity;
    if (c && c.status === 'done' && accountIssues() > 0) h += `<tr class="apps-note"><td colspan="${APPS_COLS}"><div class="apps-note-in">${renderHealthIndicator()}</div></td></tr>`;
    if (apps.errors.length) {
      const recent = apps.errors.slice().reverse().slice(0, 8);
      const items = recent.map((e) => {
        const msg = e.error.message || 'Unknown error';
        return `<button class="app-error-item" ${vcAct.attrs('click', 'appsModule.showErrorDetail', [e.id], { stop: true })} title="${escHtml(msg)}"><span class="app-error-app">${escHtml(e.appName)}</span><span class="app-error-msg">${escHtml(msg.split('\n')[0].slice(0, 80))}</span></button>`;
      }).join('');
      h += `<tr class="apps-note apps-errors-row"><td colspan="${APPS_COLS}"><div class="apps-note-in apps-errors">
        <span class="apps-errors-h"><span class="vc-lamp failed"></span>Runtime errors <b>${apps.errors.length}</b></span>
        <button class="vc-btn apps-errors-clear" ${vcAct.attrs('click', 'appsModule.clearErrors', [], { stop: true })}>Clear all</button>
        <div class="apps-errors-list">${items}${apps.errors.length > 8 ? `<span class="app-errors-more">${apps.errors.length - 8} more</span>` : ''}</div>
      </div></td></tr>`;
    }
    return h;
  }

  function renderTable() {
    const q = (apps.gridQuery || '').trim().toLowerCase();
    const f = apps.gridFilter || 'all';
    const filtering = f !== 'all' || !!q;
    const s = view.sort;
    const sortTh = (key, label, cls, title) => {
      const on = s && s.key === key;
      return `<th class="${cls} sortable${on ? ' sorted ' + s.dir : ''}" ${vcAct.attrs('click', 'appsModule.setSort', [key])} title="${escHtml(title || 'Sort by ' + label.toLowerCase())}">${label}<span class="apps-sort">${on ? (s.dir === 'asc' ? '&#9650;' : '&#9660;') : '&#8693;'}</span></th>`;
    };
    const head = `<thead><tr>
      <th class="c-lamp"></th>
      ${sortTh('name', 'App', 'c-name')}
      <th class="c-rt">Runtime</th>
      <th class="c-status">Status</th>
      ${sortTh('disk', 'Disk', 'c-num')}
      ${sortTh('db', 'DB', 'c-num')}
      ${sortTh('spend', 'Spend', 'c-num', 'Sort by spend today')}
      ${sortTh('errors', 'Errors', 'c-num', 'Sort by runtime error count')}
      <th class="c-slaves" title="One dot per linked slave: green current · amber behind or unhealthy · hollow not published · dim offline">Slaves</th>
      <th class="c-actions">Actions</th>
      <th class="c-gear"></th>
    </tr></thead>`;
    const groups = { attention: [], running: [], stopped: [], standalone: [] };
    const totals = { attention: 0, running: 0, stopped: 0, standalone: 0 };
    for (const app of apps.list) {
      const g = groupOf(app);
      totals[g]++;
      if (appMatchesQuery(app, q)) groups[g].push(app);
    }
    let body = filtering ? '' : `<tbody class="apps-pinned">${renderHorstRow()}</tbody>`;
    let shown = 0;
    for (const g of APP_GROUPS) {
      if (f !== 'all' && f !== g.key) continue;
      const rows = sortRows(groups[g.key]);
      const notes = g.key === 'attention' && !q ? renderAttentionNotes() : '';
      if (!rows.length && !notes) continue;
      shown += rows.length;
      const collapsed = view.collapsed.includes(g.key);
      const errs = g.key === 'attention' && apps.errors.length ? ` <span class="apps-grp-sub">· ${apps.errors.length} runtime error${apps.errors.length === 1 ? '' : 's'}</span>` : '';
      body += `<tbody class="apps-group g-${g.key}${collapsed ? ' collapsed' : ''}" data-group="${g.key}">
        <tr class="apps-grp" ${vcAct.attrs('click', 'appsModule.toggleGroup', [g.key])} title="${collapsed ? 'Expand' : 'Collapse'}"><th colspan="${APPS_COLS}"><span class="apps-grp-in"><span class="apps-grp-caret">&#9662;</span>${g.label}<span class="apps-grp-count">${q ? `${rows.length} / ${totals[g.key]}` : rows.length}</span>${errs}</span></th></tr>
        ${collapsed ? '' : notes + rows.map(renderAppRow).join('')}
      </tbody>`;
    }
    if (filtering && shown === 0) body += `<tbody><tr class="apps-empty"><td colspan="${APPS_COLS}">No app matches this filter.</td></tr></tbody>`;
    const blank = filtering ? '' : `<div class="vc-row-blank" ${vcAct.attrs('click', 'appsModule.showCreate', [])}><span class="plus">+</span>${apps.list.length === 0 ? 'no apps yet — describe one, Claude builds it' : 'describe an app · Claude builds it'}</div>`;
    return `<table class="apps-table">${head}${body}</table>${blank}`;
  }

  // Filter, search, sort and collapse re-render the table only; the strip
  // (and the search caret) stay put.
  function refreshTable() {
    const wrap = document.querySelector('#view-apps .apps-table-wrap');
    if (!wrap) return;
    const horst = document.getElementById('horstCardStatus')?.innerHTML;
    wrap.innerHTML = renderTable();
    const h = document.getElementById('horstCardStatus');
    if (h && horst) h.innerHTML = horst;
    const f = apps.gridFilter || 'all';
    document.querySelectorAll('#view-apps .vc-strip .vc-seg button').forEach((b) => b.classList.toggle('on', b.dataset.filter === f));
  }

  function renderGrid(panel) {
    // Stop asks before cutting off dependents; app-deps is server state.
    if (!apps.deps && !apps._depsAsked) { apps._depsAsked = true; sendWs({ type: 'app:deps:get' }); }
    let html = '<div class="apps-view">';
    html += renderStrip();
    html += renderBootBanner();
    html += `<div class="apps-table-wrap">${renderTable()}</div>`;
    html += '</div>';
    html += renderTaskPanel(panel);
    const prev = panel.querySelector('.apps-view');
    const prevTop = prev?.scrollTop || 0, prevLeft = prev?.scrollLeft || 0;
    const search = panel.querySelector('#appsGridSearch');
    const searchFocused = search && document.activeElement === search;
    const caret = searchFocused ? search.selectionStart : null;
    const horst = document.getElementById('horstCardStatus')?.innerHTML;
    panel.innerHTML = html;
    const v = panel.querySelector('.apps-view');
    if (v) { v.scrollTop = prevTop; v.scrollLeft = prevLeft; }
    if (searchFocused) {
      const s = panel.querySelector('#appsGridSearch');
      if (s) { s.focus(); try { s.setSelectionRange(caret, caret); } catch {} }
    }
    const h = document.getElementById('horstCardStatus');
    if (h && horst && horst !== '&hellip;' && horst !== '…') h.innerHTML = horst;
    startTaskPolling();
    window.horstModule?.fillCardStatus?.();
  }

  // --- Extras (shared render for Setup modal) ---

  // The tab "Sign in to Unity" opened (null when the browser blocked it: the
  // card's link is the fallback). Not persisted: after a reload the link is.
  let unitySignInTab = null;
  function openUnitySignInTab() {
    try {
      const tab = window.open('about:blank', '_blank');
      if (!tab) return;
      tab.opener = null; // the Unity page gets no handle on the dashboard
      tab.document.title = 'Unity sign-in';
      tab.document.body.innerHTML = '<p style="font:15px system-ui,sans-serif;margin:2em;">Starting the Unity sign-in&hellip; this tab opens the Unity approval page in a moment.</p>';
      unitySignInTab = { tab, url: null };
    } catch { unitySignInTab = null; }
  }
  function closeUnitySignInTab() {
    try { if (unitySignInTab && !unitySignInTab.url) unitySignInTab.tab.close(); } catch {}
    unitySignInTab = null;
  }
  // From each app:extras:status: navigate the waiting tab once the URL is there;
  // let go of it when the flow ends.
  function steerUnitySignInTab(extras) {
    if (!unitySignInTab) return;
    const si = (extras || []).find(x => x.id === 'unity')?.license?.signIn;
    if (!si) return;
    if (unitySignInTab.tab.closed) { unitySignInTab = null; return; }
    if (si.state === 'waiting' && si.url && unitySignInTab.url !== si.url) {
      try { unitySignInTab.tab.location.href = si.url; unitySignInTab.url = si.url; } catch { unitySignInTab = null; }
    } else if (['failed', 'expired', 'cancelled'].includes(si.state) && !unitySignInTab.url) {
      closeUnitySignInTab();
    } else if (!['starting', 'waiting', 'activating'].includes(si.state)) {
      unitySignInTab = null;
    }
  }

  // The Unity licence on the unity row (server: platform-extras-unity-license.js;
  // every change arrives as app:extras:status, so a reload shows the same state).
  function renderUnityLicence(l) {
    const st = l.status;
    const si = l.signIn || { state: 'idle' };
    const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const signInBtn = (label) => `<button class="setup-action-btn" style="margin:0;" data-unity-licence="signIn">${label}</button>`;
    let line;
    if (!st) {
      line = '<span class="setup-check loading">checking licence...</span>';
    } else if (st.active) {
      const lic = (st.licenses || []).find(x => !/asset store/i.test(x.product)) || (st.licenses || [])[0];
      const what = lic ? `${escHtml(lic.product)}${lic.expires ? ` until ${escHtml(lic.expires)}` : ''}` : 'active';
      line = `<span class="setup-check ok">&#10003; Licence: ${what}</span>`;
    } else if (st.signedIn) {
      line = `<span class="setup-check warn">Licence not active</span> <button class="setup-action-btn" style="margin:0 0 0 8px;" data-unity-licence="reactivate">Re-activate</button>`;
    } else if (st.error) {
      line = `<span class="setup-check warn">Licence state unknown</span> <span class="setup-hint" style="margin:0 0 0 6px;">${escHtml(st.error)}</span>`;
    } else {
      line = '<span class="setup-check warn">Not signed in to Unity</span>';
    }
    const who = st?.account ? `<span class="setup-hint" style="margin:0 0 0 8px;">signed in as ${escHtml(st.account.name || '')}${st.account.email ? ` &lt;${escHtml(st.account.email)}&gt;` : ''}</span>` : '';
    let flow = '';
    if (si.state === 'starting') {
      flow = '<span class="setup-check loading">starting the Unity sign-in...</span>';
    } else if (si.state === 'waiting' && si.url) {
      flow = `<div class="unity-signin">
        <div class="setup-hint" style="margin:0 0 6px;">${unitySignInTab?.url ? 'The Unity page is open in a new tab: sign in there and approve.' : 'Open this link in any browser (this computer or a phone), sign in to Unity and approve.'} Valid until ${time(si.expiresAt)}; this card updates by itself.</div>
        <a class="unity-signin-url" href="${escHtml(si.url)}" target="_blank" rel="noopener noreferrer">${escHtml(si.url)}</a>
        <div style="margin-top:6px;display:flex;gap:6px;">
          <button class="setup-btn" data-unity-copy="${escHtml(si.url)}">Copy link</button>
          <button class="setup-btn" data-unity-licence="cancel">Cancel</button>
        </div>
      </div>`;
    } else if (si.state === 'activating') {
      flow = '<span class="setup-check loading">approved &mdash; activating the licence...</span>';
    } else if (si.state === 'failed' || si.state === 'expired') {
      flow = `<div class="setup-status error" style="margin:0;">Sign-in ${si.state === 'expired' ? 'expired' : 'failed'}${si.error ? `: ${escHtml(si.error)}` : ''}</div>`;
    }
    const busy = ['starting', 'waiting', 'activating'].includes(si.state);
    const offerSignIn = !busy && st && !st.active && !st.signedIn;
    const alert = (l.alert && !st?.active) ? `<div class="setup-hint" style="margin:4px 0 0;">The hourly check could not keep the licence active (${l.alert.reason === 'signed-out' ? 'signed out' : 're-activation failed'}, ${time(l.alert.at)}); apps that run Unity exit 3 until it is.</div>` : '';
    const serial = `<details class="unity-serial" style="margin-top:6px;"${l.serial ? ' open' : ''}>
        <summary class="setup-hint" style="margin:0;cursor:pointer;">Unity Pro / Industry serial${l.serial ? ' (stored)' : ''}</summary>
        <div style="display:flex;gap:6px;margin-top:6px;align-items:center;">
          <input type="password" id="unitySerialInput" autocomplete="off" placeholder="${l.serial ? 'stored &mdash; type a new one to replace' : 'XX-XXXX-XXXX-XXXX-XXXX-XXXX'}" style="flex:1;min-width:0;">
          <button class="setup-btn" data-unity-licence="serial">Save</button>
          ${l.serial ? '<button class="setup-btn" data-unity-licence="serialClear">Remove</button>' : ''}
        </div>
        <div class="setup-hint" style="margin:4px 0 0;">Kept encrypted on this server; activation uses it instead of Personal. Sign in first.</div>
      </details>`;
    return `<div class="unity-licence" style="margin-top:8px;">
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px;">${line}${who}${offerSignIn ? `<span style="margin-left:8px;">${signInBtn('Sign in to Unity')}</span>` : ''}</div>
      ${flow ? `<div style="margin-top:6px;">${flow}</div>` : ''}
      ${(!busy && (si.state === 'failed' || si.state === 'expired') && st && st.signedIn) ? `<div style="margin-top:6px;">${signInBtn('Sign in again')}</div>` : ''}
      ${alert}
      ${serial}
    </div>`;
  }

  function renderSetupExtras() {
    const el = document.getElementById('setupExtrasList');
    if (!el) return;
    // A broadcast re-renders the list: keep a half-typed serial and its focus.
    const serialIn = document.getElementById('unitySerialInput');
    const serialKeep = serialIn ? { value: serialIn.value, focused: document.activeElement === serialIn } : null;
    const extras = apps.extras || [];
    if (!extras.length) { el.innerHTML = '<span class="setup-check loading">loading...</span>'; return; }
    const sudoOk = extras[0].sudoOk;
    let html = '';
    if (!sudoOk) {
      html += '<div class="setup-warning" style="margin-bottom:10px;">Installing requires passwordless sudo for the user running vistaclair. Grant it, or install components manually.</div>';
    }
    html += extras.map(x => {
      let action;
      if (x.installed) {
        action = '<span class="setup-check ok">&#10003; Installed</span>';
      } else if (x.installing) {
        action = `<div class="extras-progress"><div class="extras-progress-bar"><div class="extras-progress-fill" style="width:${x.progress}%"></div></div><span class="extras-progress-label">${escHtml(x.label || 'installing')} &mdash; ${x.progress}%</span></div>`;
      } else {
        action = `<button class="setup-action-btn" style="margin:0;" data-extra-install="${escHtml(x.id)}" ${sudoOk ? '' : 'disabled'}>Install</button>`;
      }
      const err = (!x.installing && x.error) ? `<div class="setup-status error" style="margin-top:6px;">${escHtml(x.error)}</div>` : '';
      const licence = (x.id === 'unity' && x.installed && x.license) ? renderUnityLicence(x.license) : '';
      const attention = x.id === 'unity' && unityLicenceAttention();
      return `<div class="extras-card${attention ? ' extras-card-attention' : ''}">
        <div class="extras-card-head">
          <span class="extras-card-title">${escHtml(x.title)}</span>
          <span class="extras-card-size">${escHtml(x.size)}</span>
        </div>
        <div class="setup-hint" style="margin:4px 0 8px;">${escHtml(x.description)}</div>
        <div class="extras-card-action">${action}</div>
        ${licence}
        ${err}
      </div>`;
    }).join('');
    el.innerHTML = html;
    if (serialKeep) {
      const inp = document.getElementById('unitySerialInput');
      if (inp) { inp.value = serialKeep.value; if (serialKeep.focused) inp.focus(); }
    }
    el.querySelectorAll('[data-unity-licence]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.unityLicence;
        if (act === 'serial' || act === 'serialClear') {
          const v = act === 'serial' ? (document.getElementById('unitySerialInput')?.value || '').trim() : '';
          if (act === 'serial' && !v) return;
          if (act === 'serialClear' && !confirm('Remove the stored Unity serial? Activation falls back to Unity Personal.')) return;
          sendWs({ type: 'app:extras:unity:serial', serial: v });
          const inp = document.getElementById('unitySerialInput');
          if (inp) inp.value = '';
          return;
        }
        btn.disabled = true;
        btn.textContent = act === 'cancel' ? 'Cancelling...' : (act === 'reactivate' ? 'Re-activating...' : 'Starting...');
        // One click: open the tab now, inside the click (popup blockers allow
        // that), and point it at the approval URL once the server has it.
        if (act === 'signIn') openUnitySignInTab();
        if (act === 'cancel') closeUnitySignInTab();
        sendWs({ type: 'app:extras:unity:' + act });
      });
    });
    el.querySelectorAll('[data-unity-copy]').forEach(btn => {
      btn.addEventListener('click', () => {
        const text = btn.dataset.unityCopy;
        const done = () => { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy link'; }, 1500); };
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => window.prompt('Copy the sign-in link:', text));
        else window.prompt('Copy the sign-in link:', text);
      });
    });
    el.querySelectorAll('[data-extra-install]').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.disabled = true;
        btn.textContent = 'Starting...';
        sendWs({ type: 'app:extras:install', id: btn.dataset.extraInstall });
      });
    });
    const badge = document.querySelector('.setup-nav-status[data-status-tab="extras"]');
    if (badge) {
      const state = (extras.some(x => x.installing) || unityLicenceAttention()) ? 'warn' : (extras.every(x => x.installed) ? 'ok' : 'off');
      badge.className = 'setup-nav-status setup-nav-status-' + state;
    }
  }

  // --- Account health (shared render for Setup modal) ---

  function refreshSetupAccountHealth() {
    const el = document.getElementById('setupAccountHealth');
    if (!el) return;
    const c = apps.connectivity;

    if (!c || c.status === 'checking') {
      el.innerHTML = '<span class="setup-check testing">checking...</span>';
      return;
    }

    const results = c.results || [];
    if (results.length === 0) {
      el.innerHTML = '<div class="setup-hint" style="margin:0;">No accounts configured.</div>';
      return;
    }

    let html = '';
    for (const r of results) {
      const typeBadge = r.type === 'google'
        ? '<span class="acct-type-chip google">Google</span>'
        : `<span class="acct-type-chip imap">${escHtml(r.provider || 'IMAP')}</span>`;
      const statusChip = r.ok
        ? '<span class="setup-check ok">OK</span>'
        : '<span class="setup-check warn">Issue</span>';

      html += `<div class="setup-account-item ${r.ok ? '' : 'has-issues'}">
        <div class="setup-account-row">
          <span class="setup-account-email">${escHtml(r.email)}</span>
          ${typeBadge}
          ${statusChip}
        </div>`;

      if (r.issues && r.issues.length > 0) {
        for (const issue of r.issues) {
          const svcLabel = issue.service === 'token' ? 'Auth' : issue.service === 'gmail' ? 'Gmail' : issue.service === 'calendar' ? 'Calendar' : issue.service === 'imap' ? 'IMAP' : issue.service;
          const showReauth = r.type === 'google' && issue.service === 'token';
          html += `<div class="setup-account-issue">
            <div class="setup-account-issue-header">
              <span class="setup-account-svc">${escHtml(svcLabel)}</span>
              <span class="setup-account-error">${escHtml(issue.error)}</span>
            </div>
            <div class="setup-account-fix" style="display:flex;align-items:center;gap:8px;">
              ${showReauth
                ? `<button class="setup-btn setup-btn-primary" style="font-size:11px;padding:3px 10px;white-space:nowrap;" ${vcAct.attrs('click', 'appsModule.startGoogleReauth', [r.email])}>Re-authorize</button><span>${escHtml(issue.fix)}</span>`
                : escHtml(issue.fix)}
            </div>
          </div>`;
        }
      }
      html += '</div>';
    }

    el.innerHTML = html;
  }

  function startGoogleReauth(email) {
    const redirectUri = window.location.origin + '/pro/auth/google/callback';
    sendWs({ type: 'app:setup:oauthReauth', email, redirectUri });
  }

  function startGoogleConnect() {
    const redirectUri = window.location.origin + '/pro/auth/google/callback';
    sendWs({ type: 'app:setup:oauthConnect', redirectUri });
  }

  function openGoogleReauthPopup(authUrl) {
    const w = 500, h = 600;
    const left = window.screenX + (window.outerWidth - w) / 2;
    const top = window.screenY + (window.outerHeight - h) / 2;
    const popup = window.open(authUrl, 'googleReauth', `width=${w},height=${h},left=${left},top=${top}`);
    if (!popup) return;

    const handler = (event) => {
      if (!event.data || !event.data.type) return;
      if (event.data.type === 'google-auth-success') {
        window.removeEventListener('message', handler);
        sendWs({ type: 'app:setup:oauthStatus' });
        sendWs({ type: 'app:setup:connectivityCheck' });
        sendWs({ type: 'app:setup:calendarStatus' });
      } else if (event.data.type === 'google-auth-error') {
        window.removeEventListener('message', handler);
        showAlert('Google re-authorization failed: ' + (event.data.error || 'Unknown error'));
      }
    };
    window.addEventListener('message', handler);
  }

  // --- Email engine panel (Setup > Email > Sync Engine) ---
  function renderEmailEngineStatus(msg) {
    const vecEl = document.getElementById('emailEngineVector');
    const el = document.getElementById('emailEngineList');
    if (!el) return;
    if (vecEl) {
      if (!msg.ready) {
        vecEl.innerHTML = `<span class="setup-check warn">Engine not ready</span> <span style="color:var(--text-muted);">${escHtml(msg.error || 'Database not connected — configure it in the System tab.')}</span>`;
      } else {
        vecEl.innerHTML = (msg.vector
          ? '<span class="setup-check ok">Semantic search enabled</span> <span style="color:var(--text-muted);">(MariaDB VECTOR available)</span>'
          : '<span class="setup-check warn">Keyword search only</span> <span style="color:var(--text-muted);">(MariaDB VECTOR unavailable — similarSearch falls back to FULLTEXT)</span>')
          + (msg.attachmentCache?.warning ? ` <span class="setup-check warn">${escHtml(msg.attachmentCache.warning)}</span>` : '');
      }
    }
    const accounts = msg.accounts || [];
    if (!msg.ready) { el.innerHTML = ''; return; }
    if (accounts.length === 0) {
      el.innerHTML = '<div class="setup-hint" style="margin:0;">No accounts known to the engine yet. Add accounts above (IMAP) or in the Google tab (Gmail), then enable sync here.</div>';
      return;
    }
    const badge = (a) => {
      const s = a.status || 'idle';
      if (s === 'watching') return '<span class="setup-check ok">Watching</span>';
      if (s === 'backfilling') {
        const done = Number(a.backfillDone || 0), total = Number(a.backfillTotal || 0);
        const pct = total ? Math.min(100, Math.round(done / total * 100)) : 0;
        return `<span class="setup-check testing">Backfilling ${done}/${total || '?'}</span>
          <div style="height:4px;background:var(--border);border-radius:2px;margin-top:3px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:var(--accent,#4a9eff);"></div></div>`;
      }
      if (s === 'error') return '<span class="setup-check warn">Error</span>';
      if (s === 'auth_required') return '<span class="setup-check warn">Auth required</span>';
      if (s === 'disabled') return '<span style="color:var(--text-muted);font-size:11px;">Disabled</span>';
      return `<span style="color:var(--text-muted);font-size:11px;">${escHtml(s)}</span>`;
    };
    const fmtTime = (t) => t ? new Date(t).toLocaleString() : '—';
    el.innerHTML = '<table class="setup-db-table"><thead><tr><th>Account</th><th>Type</th><th>Status</th><th>Last sync</th><th>Depth</th><th>Reply signature</th><th></th></tr></thead><tbody>'
      + accounts.map(a => {
        const esc = escHtml(a.account);
        const depth = a.settings?.backfillDepth || 'all';
        const sigText = a.settings?.signature || '';
        const sigHtml = a.settings?.signatureHtml || '';
        const enabled = !!a.enabled;
        const err = a.lastError ? `<div style="font-size:11px;color:var(--red,#e74c3c);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(a.lastError)}">${escHtml(a.lastError.slice(0, 120))}</div>` : '';
        return `<tr>
          <td>${esc}</td>
          <td style="font-size:11px;">${escHtml(a.type || '')}</td>
          <td>${badge(a)}${err}</td>
          <td style="font-size:11px;" title="Reconcile: ${escHtml(fmtTime(a.lastReconcileAt))}">${escHtml(fmtTime(a.lastSyncAt))}</td>
          <td><select data-engine-depth="${esc}" style="font-size:11px;padding:2px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:3px;">
            ${['30d', '6m', '1y', 'all'].map(d => `<option value="${d}" ${d === depth ? 'selected' : ''}>${d}</option>`).join('')}
          </select></td>
          <td><button class="setup-btn" style="font-size:11px;" data-engine-sig="${esc}">${sigText || sigHtml ? 'Edit' : 'Add'}</button></td>
          <td style="white-space:nowrap;">
            <button class="setup-btn" style="font-size:11px;" data-engine-toggle="${esc}" data-enabled="${enabled ? '1' : ''}">${enabled ? 'Disable' : 'Enable'}</button>
            <button class="setup-btn" style="font-size:11px;" data-engine-sync="${esc}" ${enabled ? '' : 'disabled'}>Sync Now</button>
          </td></tr>
        <tr data-sig-row="${esc}" style="display:none;"><td colspan="7" style="background:var(--bg);">
          <div style="display:flex;gap:12px;flex-wrap:wrap;padding:6px 0;">
            <label style="flex:1 1 260px;font-size:11px;color:var(--text-muted);">Plain text
              <textarea data-sig-text="${esc}" rows="4" style="width:100%;font-family:monospace;font-size:11px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:3px;padding:4px;">${escHtml(sigText)}</textarea>
            </label>
            <label style="flex:1 1 260px;font-size:11px;color:var(--text-muted);">HTML <span style="opacity:.7;">(optional — generated from the text when empty)</span>
              <textarea data-sig-html="${esc}" rows="4" style="width:100%;font-family:monospace;font-size:11px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:3px;padding:4px;">${escHtml(sigHtml)}</textarea>
            </label>
          </div>
          <div style="display:flex;gap:8px;align-items:center;padding-bottom:6px;">
            <button class="setup-btn" style="font-size:11px;" data-sig-save="${esc}">Save signature</button>
            <span data-sig-note="${esc}" style="font-size:11px;color:var(--text-muted);">Used on replies Horst composes for this account.</span>
          </div>
        </td></tr>`;
      }).join('')
      + '</tbody></table>';
    el.querySelectorAll('[data-engine-toggle]').forEach(btn => btn.addEventListener('click', () => {
      btn.disabled = true;
      sendWs({ type: 'app:setup:emailEngineEnable', email: btn.dataset.engineToggle, enabled: !btn.dataset.enabled });
    }));
    el.querySelectorAll('[data-engine-sync]').forEach(btn => btn.addEventListener('click', () => {
      btn.textContent = 'Syncing…';
      sendWs({ type: 'app:setup:emailEngineSyncNow', email: btn.dataset.engineSync });
    }));
    el.querySelectorAll('[data-engine-depth]').forEach(sel => sel.addEventListener('change', () => {
      sendWs({ type: 'app:setup:emailEngineDepth', email: sel.dataset.engineDepth, depth: sel.value });
    }));

    // Reply signature — an expander per account, because two textareas do not
    // fit in a table cell. Unbalanced authored HTML would corrupt the whole
    // outgoing message rather than just the signature, so it is worth flagging;
    // but never block on it, since the owner may legitimately want a fragment
    // this check does not anticipate.
    const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr', 'area', 'base', 'col', 'embed', 'param', 'track']);
    const sigHtmlWarning = (html) => {
      if (!html.trim()) return '';
      const stack = [];
      for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g)) {
        const tag = m[2].toLowerCase();
        if (VOID_TAGS.has(tag) || m[3] === '/') continue;
        if (m[1]) { if (stack.pop() !== tag) return 'Warning: unbalanced HTML — check the closing tags.'; }
        else stack.push(tag);
      }
      return stack.length ? 'Warning: unbalanced HTML — check the closing tags.' : '';
    };
    el.querySelectorAll('[data-engine-sig]').forEach(btn => btn.addEventListener('click', () => {
      const row = el.querySelector(`[data-sig-row="${btn.dataset.engineSig}"]`);
      if (row) row.style.display = row.style.display === 'none' ? '' : 'none';
    }));
    el.querySelectorAll('[data-sig-save]').forEach(btn => btn.addEventListener('click', () => {
      const email = btn.dataset.sigSave;
      const field = (attr) => el.querySelector(`[${attr}="${email}"]`);
      const signature = field('data-sig-text')?.value || '';
      const signatureHtml = field('data-sig-html')?.value || '';
      const note = field('data-sig-note');
      const warn = sigHtmlWarning(signatureHtml);
      if (note) note.textContent = warn ? `Saved. ${warn}` : 'Saved.';
      sendWs({ type: 'app:setup:emailEngineSignature', email, signature, signatureHtml });
    }));
  }

  // --- Calendar sync panel (Setup > Google > Calendar Sync) ---
  function renderCalendarSyncStatus(msg) {
    const el = document.getElementById('calendarSyncList');
    if (!el) return;
    if (msg.error && !msg.email) {
      el.innerHTML = `<span class="setup-check warn">Unavailable</span> <span style="color:var(--text-muted);font-size:12px;">${escHtml(msg.error)}</span>`
        + (msg.authUrl ? ` <button class="setup-btn" style="font-size:11px;" ${vcAct.attrs('click', 'appsModule.openGoogleReauthPopup', [msg.authUrl])}>Re-authorize</button>` : '');
      return;
    }
    const accounts = msg.accounts || [];
    if (accounts.length === 0) {
      el.innerHTML = '<div class="setup-hint" style="margin:0;">No Google accounts with calendar access connected.</div>';
      return;
    }
    // No specific account requested yet: render one expandable block per account.
    if (!msg.email) {
      el.innerHTML = accounts.map(a => {
        const esc = escHtml(a);
        const rows = (msg.status || []).filter(s => s.account === a);
        const selected = rows.filter(s => s.selected);
        const accErr = msg.errors && msg.errors[a];
        return `<div class="setup-account-item" data-cal-account="${esc}">
          <div class="setup-account-row">
            <span class="setup-account-email">${esc}</span>
            <span style="color:var(--text-muted);font-size:11px;">${selected.length} calendar${selected.length === 1 ? '' : 's'} synced</span>
            <button class="setup-btn" style="font-size:11px;margin-left:auto;" data-cal-manage="${esc}">Manage</button>
            <button class="setup-btn" style="font-size:11px;" data-cal-sync="${esc}" ${selected.length ? '' : 'disabled'}>Sync Now</button>
          </div>
          ${selected.map(s => `<div style="display:flex;align-items:center;gap:6px;font-size:12px;padding:2px 0 2px 12px;">
            <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${escHtml(s.color || '#3b82f6')};"></span>
            <span>${escHtml(s.name || s.calendarId)}</span>
            <span style="color:var(--text-muted);font-size:11px;">${s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : 'never synced'}</span>
            ${s.lastError ? `<span class="setup-check warn" title="${escHtml(s.lastError)}">Error</span>` : ''}
          </div>`).join('')}
          ${accErr ? `<div style="font-size:12px;padding:2px 0 2px 12px;"><span class="setup-check warn">Error</span> <span style="color:var(--text-muted);">${escHtml(accErr)}</span></div>` : ''}
          <div data-cal-picker="${esc}"></div>
        </div>`;
      }).join('');
      el.querySelectorAll('[data-cal-manage]').forEach(btn => btn.addEventListener('click', () => {
        btn.textContent = 'Loading…'; btn.disabled = true;
        sendWs({ type: 'app:setup:calendarStatus', email: btn.dataset.calManage });
      }));
      el.querySelectorAll('[data-cal-sync]').forEach(btn => btn.addEventListener('click', () => {
        btn.textContent = 'Syncing…';
        sendWs({ type: 'app:setup:calendarSyncNow', email: btn.dataset.calSync });
      }));
      return;
    }
    // Per-account reply (Manage clicked or selection saved): render the checklist.
    const picker = el.querySelector(`[data-cal-picker="${CSS.escape(msg.email)}"]`);
    if (!picker) { sendWs({ type: 'app:setup:calendarStatus' }); return; }
    if (msg.error) {
      picker.innerHTML = `<div style="padding:6px 0;"><span class="setup-check warn">Error</span> <span style="font-size:12px;color:var(--text-muted);">${escHtml(msg.error)}</span></div>`;
      const mbtn = el.querySelector(`[data-cal-manage="${CSS.escape(msg.email)}"]`);
      if (mbtn) { mbtn.textContent = 'Manage'; mbtn.disabled = false; }
      return;
    }
    if (!msg.calendars) { sendWs({ type: 'app:setup:calendarStatus' }); return; }
    picker.innerHTML = `<div style="padding:6px 0 2px;">
      ${msg.calendars.map(c => `<label style="display:flex;align-items:center;gap:6px;font-size:12px;padding:2px 0;cursor:pointer;">
        <input type="checkbox" data-cal-id="${escHtml(c.id)}" ${c.selected ? 'checked' : ''}>
        <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${escHtml(c.color || '#3b82f6')};"></span>
        <span>${escHtml(c.name)}</span>${c.primary ? ' <span style="color:var(--text-muted);font-size:10px;">(primary)</span>' : ''}
      </label>`).join('')}
      <div class="setup-btn-row" style="margin-top:6px;">
        <button class="setup-btn setup-btn-primary" style="font-size:11px;" data-cal-save="${escHtml(msg.email)}">Save Selection</button>
      </div>
    </div>`;
    const mbtn = el.querySelector(`[data-cal-manage="${CSS.escape(msg.email)}"]`);
    if (mbtn) { mbtn.textContent = 'Manage'; mbtn.disabled = false; }
    picker.querySelector('[data-cal-save]').addEventListener('click', (e) => {
      const ids = [...picker.querySelectorAll('[data-cal-id]:checked')].map(cb => cb.dataset.calId);
      e.target.textContent = 'Saving…'; e.target.disabled = true;
      sendWs({ type: 'app:setup:calendarSelect', email: msg.email, calendarIds: ids });
      setTimeout(() => sendWs({ type: 'app:setup:calendarStatus' }), 800);
    });
  }

  // --- Account health indicator (in the Attention group of the apps table) ---

  function renderHealthIndicator() {
    const c = apps.connectivity;
    if (!c) return '';

    if (c.status === 'checking') {
      return `<div class="app-platform-health checking">
        <span class="platform-health-icon">&#8635;</span>
        <span>Checking accounts...</span>
      </div>`;
    }

    const results = c.results || [];
    if (results.length === 0) return '';
    const issues = results.filter(r => r.issues && r.issues.length > 0);
    const totalIssues = issues.reduce((n, r) => n + r.issues.length, 0);

    if (totalIssues === 0) return '';

    return `<div class="app-platform-health has-issues" ${vcAct.attrs('click', 'appsModule.showSetup', ['accounts'])}>
      <span class="platform-health-icon">&#9888;</span>
      <span>${totalIssues} account ${totalIssues === 1 ? 'issue' : 'issues'}</span>
      <span class="platform-health-badge">${totalIssues}</span>
      <span class="platform-health-arrow">&#8250;</span>
    </div>`;
  }

  // --- Background task panel ---

  let taskPanelInterval = null;
  let taskPanelOpen = false;

  function renderTaskPanel(panel) {
    const t = apps.tasks;
    const total = t.spawned.length + t.cron.length + t.cli.length;

    let html = `<div class="app-card app-card-tasks${taskPanelOpen ? ' expanded' : ''}" style="grid-column:1/-1;">
      <div class="app-card-header" style="cursor:pointer;" ${vcAct.attrs('click', 'appsModule.toggleTaskPanel', [])}>
        <span class="app-card-name">Background Tasks</span>
        <span class="app-errors-badge" style="background:${total > 0 ? 'var(--accent)' : 'var(--border)'}">${total}</span>
        <button class="app-task-panel-close" title="Close" ${vcAct.attrs('click', 'appsModule.closeTaskPanel', [], { stop: true })}>&times;</button>
      </div>
      <div class="app-tasks-body">`;

    if (total === 0) {
      html += '<div class="setup-hint" style="margin:0;">No background tasks running.</div>';
    }

    if (t.spawned.length > 0) {
      html += '<div class="app-tasks-section"><div class="app-tasks-section-title">Processes</div>';
      for (const s of t.spawned) {
        const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
        html += `<div class="app-task-item">
          <span class="app-error-app">${escHtml(s.appName)}</span>
          <span class="app-task-cmd" title="${escHtml(s.command)}">${escHtml((s.command || '').slice(0, 60))}</span>
          <span class="app-task-meta">PID ${s.pid || '?'} | ${elapsed}s</span>
          <button class="app-error-fix-btn" ${vcAct.attrs('click', 'appsModule.killTask', ['spawn', s.spawnId], { stop: true })}>Kill</button>
          <details class="app-task-peek"><summary>Output</summary><pre class="app-task-output">${escHtml((s.recentOutput || []).join('').slice(-2000))}</pre></details>
        </div>`;
      }
      html += '</div>';
    }

    if (t.cron.length > 0) {
      html += '<div class="app-tasks-section"><div class="app-tasks-section-title">Scheduled Jobs</div>';
      for (const c of t.cron) {
        const lastRun = c.lastRunAt ? new Date(c.lastRunAt).toLocaleTimeString() : 'never';
        const exitBadge = c.lastExitCode === null ? '' : c.lastExitCode === 0 ? '<span style="color:var(--green)">ok</span>' : `<span style="color:var(--red)">exit ${c.lastExitCode}</span>`;
        html += `<div class="app-task-item">
          <span class="app-error-app">${escHtml(c.appName)}</span>
          <span class="app-task-cmd" title="${escHtml(c.command)}">${escHtml((c.command || '').slice(0, 60))}</span>
          <span class="app-task-meta">${escHtml(c.schedule)} | last: ${lastRun} ${exitBadge}</span>
          <button class="app-error-fix-btn" ${vcAct.attrs('click', 'appsModule.killTask', ['cron', c.jobId], { stop: true })}>Cancel</button>
        </div>`;
      }
      html += '</div>';
    }

    if (t.cli.length > 0) {
      html += '<div class="app-tasks-section"><div class="app-tasks-section-title">Claude Sessions</div>';
      for (const s of t.cli) {
        html += `<div class="app-task-item">
          <span class="app-error-app">${escHtml(s.title || s.tabId)}</span>
          <span class="app-task-meta">${escHtml(s.status || 'active')}</span>
          <button class="app-error-fix-btn" ${vcAct.attrs('click', 'appsModule.killTask', ['cli', s.tabId], { stop: true })}>Kill</button>
        </div>`;
      }
      html += '</div>';
    }

    html += '</div></div>';
    return html;
  }

  function startTaskPolling() {
    if (taskPanelInterval) return;
    sendWs({ type: 'app:tasks:list' });
    taskPanelInterval = setInterval(() => {
      if (apps.activeTab === 'grid') sendWs({ type: 'app:tasks:list' });
    }, 5000);
  }

  function killTask(taskType, taskId) {
    sendWs({ type: 'app:tasks:kill', taskType, taskId });
  }

  function toggleTaskPanel() {
    taskPanelOpen = !taskPanelOpen;
    refreshGrid();
  }

  function closeTaskPanel() {
    if (!taskPanelOpen) return;
    taskPanelOpen = false;
    refreshGrid();
  }

  // Close the task panel when clicking outside of it.
  document.addEventListener('click', (e) => {
    if (!taskPanelOpen) return;
    if (apps.activeTab !== 'grid') return;
    if (e.target.closest('.app-card-tasks')) return;
    closeTaskPanel();
  });

  // --- App GUI panel (persists across tab switches) ---

  function createAppPanel(name) {
    const app = apps.list.find(a => a.name === name);
    const panel = document.createElement('div');
    panel.dataset.panel = `app-${name}`;
    panel.style.flex = '1';
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.style.overflow = 'hidden';

    // Every app runs a backend (in-process by default, or its own process).
    // The iframe shows it only once running; start it first if needed.
    const src = app?.running ? `/apps/${encodeURIComponent(name)}/` : 'about:blank';

    if (!app?.running) {
      sendWs({ type: 'app:start', name });
    }

    panel.innerHTML = `
      <div class="app-workspace-header">
        <span class="app-workspace-title">${escHtml(name)}</span>
        <span class="app-card-archetype">${escHtml(app?.standalone === true ? 'standalone' : appRuntimeOf(app))}</span>
        <div class="app-status-pills" data-app-pills="${escHtml(name)}">
          <span class="app-status-pill pill-idle" data-pill="health" title="Health">
            <svg width="8" height="8"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>
            <span>...</span>
          </span>
          <span class="app-status-pill pill-idle" data-pill="db" title="Database">
            <svg width="8" height="8"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>
            <span>DB</span>
          </span>
          <span class="app-status-pill pill-idle" data-pill="git" title="Git">
            <svg width="8" height="8"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>
            <span>Git</span>
          </span>
          <span class="app-git-actions" data-git-actions="${escHtml(name)}"></span>
        </div>
        <button class="app-workspace-change" title="Modify with AI" data-app-change="${escHtml(name)}">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M11.5 1.5l3 3L5 14H2v-3z"/>
            <path d="M9.5 3.5l3 3"/>
          </svg>
        </button>
        <button class="app-workspace-restart" title="Restart app" data-app-restart="${escHtml(name)}">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M2 8a6 6 0 0 1 10.2-4.3M14 8a6 6 0 0 1-10.2 4.3"/>
            <path d="M12 1v4h-4M4 15v-4h4"/>
          </svg>
        </button>
        ${app?.standalone === true ? '' : `<button class="app-workspace-power" data-app-power="${escHtml(name)}"></button>`}
        <button class="app-workspace-reload" title="Reload page">&#x21bb;</button>
      </div>
      <div class="app-iframe-wrap" data-app-gui="${escHtml(name)}">
        <iframe src="${src}" data-app-iframe="${escHtml(name)}"${iframeAllow(app)}></iframe>
        ${app?.running ? '' : `<div class="app-panel-placeholder" data-app-placeholder="${escHtml(name)}">
          <span class="app-boot-spinner"></span>
          <span data-placeholder-text>${platformBooting() ? 'Platform is starting up&hellip;' : `Starting ${escHtml(name)}&hellip;`}</span>
        </div>`}
      </div>`;

    panel.querySelector('.app-workspace-reload').addEventListener('click', () => {
      const iframe = panel.querySelector('iframe');
      if (iframe) iframe.src = iframe.src;
    });

    panel.querySelector('.app-workspace-change').addEventListener('click', () => {
      openCli(name);
    });

    panel.querySelector('.app-workspace-restart').addEventListener('click', () => {
      sendWs({ type: 'app:restart', name });
    });

    // Stop lives here and on the app card — closing the tab never stops an app.
    panel.querySelector('.app-workspace-power')?.addEventListener('click', async () => {
      const a = apps.list.find(x => x.name === name);
      if (a?.running) { const stopSites = await askStopSites(name); sendWs(stopSites ? { type: 'app:stop', name, stopSites: true } : { type: 'app:stop', name }); }
      else startFromPanel(name);
    });
    setPanelPower(name, !!app?.running, panel);

    sendWs({ type: 'app:status', name });
    sendWs({ type: 'app:git:status', name });

    return panel;
  }

  function removeAppPanelPlaceholder(name) {
    const el = panelOf(name)?.querySelector(`[data-app-placeholder="${CSS.escape(name)}"]`);
    if (el) el.remove();
  }

  // The top bar's Start/Stop button follows the app's running state.
  function setPanelPower(name, running, root = panelOf(name)) {
    const btn = root?.querySelector(`[data-app-power="${CSS.escape(name)}"]`);
    if (!btn) return;
    btn.title = running ? 'Stop app' : 'Start app';
    btn.innerHTML = running
      ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4.5 2.5l9 5.5-9 5.5z"/></svg>';
  }

  // An open tab whose app stopped (here, in another browser, by Horst or a
  // crash) stays open and offers Start instead of showing a blank frame.
  function showStoppedPlaceholder(name, crashed) {
    const wrap = panelOf(name)?.querySelector(`[data-app-gui="${CSS.escape(name)}"]`);
    if (!wrap) return;
    wrap.querySelector('[data-app-placeholder]')?.remove();
    wrap.insertAdjacentHTML('beforeend', `<div class="app-panel-placeholder stopped" data-app-placeholder="${escHtml(name)}">
      <span class="app-boot-spinner"></span>
      <span data-placeholder-text>${escHtml(name)} ${crashed ? 'crashed' : 'is stopped'}</span>
      <button class="app-panel-start">Start</button>
    </div>`);
    wrap.querySelector('.app-panel-start').addEventListener('click', () => startFromPanel(name));
  }

  function startFromPanel(name) {
    const ph = panelOf(name)?.querySelector(`[data-app-placeholder="${CSS.escape(name)}"]`);
    if (ph) {
      ph.classList.remove('stopped', 'failed');
      ph.querySelector('.app-panel-start')?.remove();
      const text = ph.querySelector('[data-placeholder-text]');
      if (text) text.innerHTML = `Starting ${escHtml(name)}&hellip;`;
    }
    sendWs({ type: 'app:start', name });
  }

  // Keep open panel placeholders in sync with the platform boot phase.
  function updateAppPanelPlaceholders() {
    for (const name of appsHost ? appsHost.keys() : []) {
      const el = panelOf(name)?.querySelector('[data-app-placeholder]');
      if (!el || el.classList.contains('stopped')) continue;
      const text = el.querySelector('[data-placeholder-text]');
      if (text) text.innerHTML = platformBooting() ? 'Platform is starting up&hellip;' : `Starting ${escHtml(name)}&hellip;`;
    }
  }

  // Build the iframe `allow` attribute from the app manifest's `capabilities`
  // object ({ microphone: true }). This is a BROWSER permissions-policy grant,
  // not platform capability gating (which no longer exists): mic/camera reach
  // the iframe only when the manifest asks for them. Empty => attribute omitted.
  function iframeAllow(app) {
    const caps = (app && app.capabilities && typeof app.capabilities === 'object') ? app.capabilities : {};
    const directives = [];
    if (caps.microphone === true) directives.push('microphone');
    if (caps.camera === true) directives.push('camera');
    if (!directives.length) return '';
    return ` allow="${directives.join('; ')}"`;
  }

  function pillSvg(color) {
    return `<svg width="8" height="8"><circle cx="4" cy="4" r="4" fill="${color}"/></svg>`;
  }

  function updateWorkspaceStatus(appName, status) {
    const panel = panelOf(appName);
    if (!panel) return;
    const pills = panel.querySelector(`[data-app-pills="${CSS.escape(appName)}"]`);
    if (!pills) return;

    const healthPill = pills.querySelector('[data-pill="health"]');
    if (healthPill) {
      const hMap = { ok: ['#4ade80', 'Running'], starting: ['#fb923c', 'Starting'], error: ['#f87171', 'Error'], stopped: ['#9ca3af', 'Stopped'] };
      let [color, label] = hMap[status.health] || hMap.stopped;
      // Runtime failures recorded by the app guard: a running app that keeps
      // throwing shows its count (crash loop → warn colour), last error on hover.
      const errs = status.errors || null;
      if (status.health === 'ok' && errs && errs.count > 0) {
        label = `Running · ${errs.count} error${errs.count === 1 ? '' : 's'}`;
        if (errs.crashloop) color = '#fb923c';
      }
      healthPill.className = `app-status-pill pill-${status.health === 'ok' ? (errs?.crashloop ? 'warn' : 'ok') : status.health === 'error' ? 'error' : status.health === 'starting' ? 'warn' : 'idle'}`;
      healthPill.title = errs && errs.lastError ? `Last error: ${errs.lastError}` : 'Health';
      healthPill.innerHTML = `${pillSvg(color)}<span>${label}</span>`;
    }

    const dbPill = pills.querySelector('[data-pill="db"]');
    if (dbPill) {
      const dMap = {
        ok: ['#4ade80', status.dbName || 'DB OK', 'ok'],
        disconnected: ['#f87171', 'DB Down', 'error'],
        pending: ['#fb923c', 'DB Pending', 'warn'],
        na: ['#9ca3af', 'No DB', 'idle'],
      };
      const [color, label, cls] = dMap[status.db] || dMap.na;
      dbPill.className = `app-status-pill pill-${cls}`;
      dbPill.innerHTML = `${pillSvg(color)}<span>${label}</span>`;
    }
  }

  function updateWorkspaceGit(appName, git) {
    const panel = panelOf(appName);
    if (!panel) return;
    const pills = panel.querySelector(`[data-app-pills="${CSS.escape(appName)}"]`);
    if (!pills) return;

    const gitPill = pills.querySelector('[data-pill="git"]');
    const gitActions = pills.querySelector(`[data-git-actions="${CSS.escape(appName)}"]`);
    if (!git) {
      if (gitPill) {
        gitPill.className = 'app-status-pill pill-idle';
        gitPill.innerHTML = `${pillSvg('#9ca3af')}<span>No repo</span>`;
      }
      if (gitActions) gitActions.innerHTML = '';
      return;
    }

    let color, label, cls;
    if (git.dirty) {
      const n = git.modified + git.untracked;
      color = '#fb923c'; label = `${n} changed`; cls = 'warn';
    } else if (git.ahead > 0) {
      color = '#60a5fa'; label = `${git.ahead} ahead`; cls = 'info';
    } else {
      color = '#4ade80'; label = 'clean'; cls = 'ok';
    }
    if (gitPill) {
      gitPill.className = `app-status-pill pill-${cls}`;
      gitPill.innerHTML = `${pillSvg(color)}<span>${label}</span>`;
      gitPill.title = `Git: ${git.branch || '?'} | ${git.modified}M ${git.untracked}U ${git.staged}S | ${git.ahead}↑ ${git.behind}↓`;
    }

    if (gitActions) {
      let btns = '';
      if (git.dirty) {
        btns += `<button class="app-git-btn" ${vcAct.attrs('click', 'appsModule.gitCommit', [appName])}>Commit</button>`;
      }
      if (git.ahead > 0) {
        btns += `<button class="app-git-btn" ${vcAct.attrs('click', 'appsModule.gitPush', [appName])}>Push</button>`;
      }
      gitActions.innerHTML = btns;
    }
  }

  // --- Help panel ---

  function createHelpPanel() {
    const panel = document.createElement('div');
    panel.dataset.panel = 'app-_help';
    panel.style.flex = '1';
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.style.overflow = 'hidden';

    panel.innerHTML = `
      <div class="app-workspace-header">
        <span class="app-workspace-title">Apps Guide</span>
      </div>
      <div class="app-help-content">
        <div class="app-help-section">
          <h2>What are vistaclair apps?</h2>
          <p>Apps are <strong>AI-native tools with a GUI</strong> that run inside vistaclair. Describe what you want, and the AI builds a complete working application &mdash; UI, logic, system integration, and AI reasoning &mdash; all wired together. They're not static dashboards &mdash; they're intelligent workflows that think, analyse, and act.</p>
        </div>

        <div class="app-help-section">
          <h2>How it all fits together</h2>
          <svg viewBox="0 0 720 420" style="width:100%;max-width:720px;height:auto;margin:12px auto;display:block;font-family:system-ui,sans-serif;" xmlns="http://www.w3.org/2000/svg">
            <!-- Background -->
            <rect width="720" height="420" rx="12" fill="var(--bg-surface)" stroke="var(--border)" stroke-width="1.5"/>

            <!-- Vistaclair Core box -->
            <rect x="40" y="30" width="280" height="120" rx="8" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="6 3"/>
            <text x="180" y="55" text-anchor="middle" fill="var(--accent)" font-weight="700" font-size="14">vistaclair (core)</text>
            <text x="180" y="78" text-anchor="middle" fill="var(--text-dim)" font-size="11">Express server &bull; WebSocket</text>
            <text x="180" y="95" text-anchor="middle" fill="var(--text-dim)" font-size="11">Dashboard &bull; CLI sessions</text>
            <text x="180" y="112" text-anchor="middle" fill="var(--text-dim)" font-size="11">Plugin system &bull; Auth</text>

            <!-- Arrow: Core -> Pro -->
            <line x1="320" y1="90" x2="390" y2="90" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#arrowhead)"/>
            <text x="355" y="82" text-anchor="middle" fill="var(--text-dim)" font-size="9">loads</text>

            <!-- platform box -->
            <rect x="400" y="30" width="280" height="120" rx="8" fill="none" stroke="#2d7d46" stroke-width="2"/>
            <text x="540" y="55" text-anchor="middle" fill="#2d7d46" font-weight="700" font-size="14">platform (add-on module)</text>
            <text x="540" y="78" text-anchor="middle" fill="var(--text-dim)" font-size="11">App Manager &bull; App Bridge</text>
            <text x="540" y="95" text-anchor="middle" fill="var(--text-dim)" font-size="11">DB provisioning &bull; AI proxy</text>
            <text x="540" y="112" text-anchor="middle" fill="var(--text-dim)" font-size="11">Builder prompts &bull; Setup</text>

            <!-- Arrow: Pro -> Apps -->
            <line x1="540" y1="150" x2="540" y2="190" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#arrowhead)"/>
            <text x="555" y="175" fill="var(--text-dim)" font-size="9">manages</text>

            <!-- Apps row -->
            <rect x="80" y="200" width="560" height="60" rx="8" fill="none" stroke="#5577bb" stroke-width="1.5" stroke-dasharray="4 3"/>
            <text x="360" y="222" text-anchor="middle" fill="#5577bb" font-weight="600" font-size="13">vistaclair-apps/ (your apps)</text>
            <text x="360" y="242" text-anchor="middle" fill="var(--text-dim)" font-size="11">my-dashboard &bull; db-admin &bull; your-new-app &bull; ...</text>

            <!-- Bridge flows -->
            <rect x="40" y="290" width="195" height="110" rx="8" fill="none" stroke="var(--border)" stroke-width="1"/>
            <text x="137" y="312" text-anchor="middle" fill="var(--text)" font-weight="600" font-size="12">App iframe</text>
            <text x="137" y="332" text-anchor="middle" fill="var(--text-dim)" font-size="10">index.html + app.js</text>
            <text x="137" y="350" text-anchor="middle" fill="var(--text-dim)" font-size="10">Uses Bridge.call()</text>
            <text x="137" y="368" text-anchor="middle" fill="var(--text-dim)" font-size="10">for exec, AI, files, DB</text>
            <text x="137" y="386" text-anchor="middle" fill="var(--text-dim)" font-size="10">(runs in browser)</text>

            <!-- Arrow: iframe -> bridge -->
            <line x1="235" y1="345" x2="283" y2="345" stroke="#cc7730" stroke-width="1.5" marker-end="url(#arrowOrange)"/>
            <text x="259" y="337" text-anchor="middle" fill="#cc7730" font-size="9">postMessage</text>

            <!-- Bridge box -->
            <rect x="290" y="290" width="155" height="110" rx="8" fill="none" stroke="#cc7730" stroke-width="1.5"/>
            <text x="367" y="312" text-anchor="middle" fill="#cc7730" font-weight="600" font-size="12">App Bridge</text>
            <text x="367" y="332" text-anchor="middle" fill="var(--text-dim)" font-size="10">Translates calls</text>
            <text x="367" y="350" text-anchor="middle" fill="var(--text-dim)" font-size="10">into server actions:</text>
            <text x="367" y="368" text-anchor="middle" fill="var(--text-dim)" font-size="10">shell, fs, AI, db,</text>
            <text x="367" y="386" text-anchor="middle" fill="var(--text-dim)" font-size="10">secrets, cron, spawn</text>

            <!-- Arrow: bridge -> server -->
            <line x1="445" y1="345" x2="493" y2="345" stroke="#cc7730" stroke-width="1.5" marker-end="url(#arrowOrange)"/>
            <text x="469" y="337" text-anchor="middle" fill="#cc7730" font-size="9">WebSocket</text>

            <!-- Server-side box -->
            <rect x="500" y="290" width="180" height="110" rx="8" fill="none" stroke="var(--border)" stroke-width="1"/>
            <text x="590" y="312" text-anchor="middle" fill="var(--text)" font-weight="600" font-size="12">Server-side</text>
            <text x="590" y="332" text-anchor="middle" fill="var(--text-dim)" font-size="10">routes.js (Express)</text>
            <text x="590" y="350" text-anchor="middle" fill="var(--text-dim)" font-size="10">ctx.dbQuery() &bull; ctx.aiPrompt()</text>
            <text x="590" y="368" text-anchor="middle" fill="var(--text-dim)" font-size="10">ctx.dbName = vc_&lt;app&gt;</text>
            <text x="590" y="386" text-anchor="middle" fill="var(--text-dim)" font-size="10">(runs on host)</text>

            <!-- Arrowhead markers -->
            <defs>
              <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6Z" fill="var(--text-dim)"/></marker>
              <marker id="arrowOrange" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6Z" fill="#cc7730"/></marker>
            </defs>
          </svg>
        </div>

        <div class="app-help-section">
          <h2>Built-in capabilities</h2>
          <p>Every app you build gets access to powerful platform features through the bridge API:</p>
          <div class="app-help-caps">
            <div class="app-help-cap highlight">
              <strong>AI Reasoning (ai.prompt)</strong>
              <span>Classify, summarise, generate, diagnose &mdash; all routed through vistaclair's proxy. No API keys needed. Every call visible in Inspector.</span>
            </div>
            <div class="app-help-cap highlight">
              <strong>Voice, Images &amp; Translation (ai.transcribe / ai.tts / ai.image / ai.translate / ai.detect)</strong>
              <span>Speech-to-text (Whisper / GPT-4o), text-to-speech (GPT-4o-mini-tts), image generation &amp; editing (Gemini), and text translation &amp; language detection (Google Cloud Translation). Platform-managed keys &mdash; no setup needed.</span>
            </div>
            <div class="app-help-cap highlight">
              <strong>Maps &amp; Routing (ai.route / ai.routeMatrix / ai.geocode / ai.places / ai.streetview / ai.tiles3d)</strong>
              <span>Directions &amp; distance matrix (Google Routes API v2 &mdash; traffic, alternatives, tolls, transit), address &harr; coordinates, place search/details/autocomplete, Street View stills of a coordinate, and Photorealistic 3D Tiles (Map Tiles API). Platform-managed key.</span>
            </div>
            <div class="app-help-cap highlight">
              <strong>Web Search (ai.webSearch)</strong>
              <span>Live web, news &amp; video search via Brave Search API. Freshness, country, and safe-search filters. Platform-managed key.</span>
            </div>
            <div class="app-help-cap highlight">
              <strong>Embeddings (embed)</strong>
              <span>Local 384-dim multilingual vectors for semantic search. Runs in-process &mdash; no API key, no network.</span>
            </div>
            <div class="app-help-cap highlight">
              <strong>Music Generation (ai.music.*)</strong>
              <span>Text-to-music generation &amp; beat analysis via local MusicGen. Runs on CPU &mdash; no API key. Install via Setup &rsaquo; Extras.</span>
            </div>
            <div class="app-help-cap highlight">
              <strong>Platform Memory (memory.*)</strong>
              <span>Shared self-tending knowledge store. Remember, recall, forget, and query entities. Hybrid semantic vector + full-text search with AI-powered consolidation.</span>
            </div>
            <div class="app-help-cap">
              <strong>Shell Commands</strong>
              <span>Run any command on the host. 120s timeout, 5MB buffer. Full system access.</span>
            </div>
            <div class="app-help-cap">
              <strong>File System</strong>
              <span>Read, write, list, and check files. Paths relative to app directory.</span>
            </div>
            <div class="app-help-cap">
              <strong>Persistent State</strong>
              <span>Key-value storage that survives restarts. Save config, history, and findings.</span>
            </div>
            <div class="app-help-cap">
              <strong>Install Anything</strong>
              <span>Passwordless sudo access. Install any package, runtime, or tool your app needs.</span>
            </div>
            <div class="app-help-cap">
              <strong>Long-running Processes</strong>
              <span>Spawn background processes with stdout/stderr streaming for real-time output.</span>
            </div>
            <div class="app-help-cap">
              <strong>HTTP Fetch</strong>
              <span>Cross-origin HTTP requests from the frontend. Call any external API without CORS issues.</span>
            </div>
            <div class="app-help-cap">
              <strong>Encrypted Secrets</strong>
              <span>Store API keys and tokens securely. Encrypted at rest, separate from app state.</span>
            </div>
            <div class="app-help-cap">
              <strong>Scheduled Tasks</strong>
              <span>Cron-style recurring commands. Run jobs on intervals without external schedulers.</span>
            </div>
            <div class="app-help-cap">
              <strong>App Licensing (auth.license)</strong>
              <span>The platform has no licence provider: <code>auth.license</code> and <code>ctx.license</code> answer the free tier for every non-owner. Paid content needs a licence app installed on the same Vistaclair (for example <code>licencing</code>, when it is installed), asked through its tools by account.</span>
            </div>
          </div>
        </div>

        <div class="app-help-section" id="help-tool-exposure">
          <h2>App tools &amp; exposure levels</h2>
          <p>Apps can register <strong>tools</strong> &mdash; typed functions that AI sessions can call. Each tool has an exposure level: <strong>self</strong> (the app's own AI only, the default), <strong>platform</strong> (adds platform AI sessions and cron jobs), or <strong>apps</strong> (adds other apps via <code>ctx.tools.call</code>). Levels are strictly nested &mdash; each adds callers to the previous. There is no network level: tools are only reachable from this machine, never from the internet.</p>
          <svg viewBox="0 0 720 340" style="width:100%;max-width:720px;height:auto;margin:12px auto;display:block;font-family:system-ui,sans-serif;" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <marker id="exArrowBlock" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6Z" fill="#cc4444"/></marker>
            </defs>
            <rect width="720" height="340" rx="12" fill="var(--bg-surface)" stroke="var(--border)" stroke-width="1.5"/>

            <!-- Internet boundary (never crossed) -->
            <rect x="20" y="20" width="680" height="300" rx="10" fill="none" stroke="#cc4444" stroke-width="2" stroke-dasharray="8 5"/>
            <text x="360" y="42" text-anchor="middle" fill="#cc4444" font-weight="700" font-size="12">Internet &mdash; never crosses this line</text>
            <line x1="360" y1="8" x2="360" y2="24" stroke="#cc4444" stroke-width="2" marker-end="url(#exArrowBlock)"/>
            <line x1="345" y1="6" x2="375" y2="26" stroke="#cc4444" stroke-width="2"/>

            <!-- apps ring -->
            <ellipse cx="360" cy="195" rx="290" ry="105" fill="none" stroke="#2d9d5c" stroke-width="2"/>
            <text x="360" y="112" text-anchor="middle" fill="#2d9d5c" font-weight="700" font-size="12">apps &mdash; + other apps (ctx.tools.call)</text>

            <!-- platform ring -->
            <ellipse cx="360" cy="205" rx="200" ry="72" fill="none" stroke="var(--accent)" stroke-width="2"/>
            <text x="360" y="152" text-anchor="middle" fill="var(--accent)" font-weight="700" font-size="12">platform &mdash; + platform AI &amp; cron</text>

            <!-- self ring -->
            <ellipse cx="360" cy="212" rx="115" ry="42" fill="none" stroke="var(--text-dim)" stroke-width="2"/>
            <text x="360" y="188" text-anchor="middle" fill="var(--text-dim)" font-weight="700" font-size="12">self (default)</text>

            <!-- App core -->
            <rect x="290" y="198" width="140" height="34" rx="6" fill="var(--bg)" stroke="var(--border)" stroke-width="1.5"/>
            <text x="360" y="215" text-anchor="middle" fill="var(--text)" font-weight="600" font-size="11">app + its tools</text>
            <text x="360" y="227" text-anchor="middle" fill="var(--text-dim)" font-size="9">own AI sessions &amp; GUI test</text>
          </svg>
          <p style="font-size:12px;color:var(--text-dim);">Apps that expose tools beyond <strong>self</strong> are autostarted by default, so their tools are available whenever the platform needs them. Every call is recorded &mdash; see the <strong>Tools</strong> tab for the live audit log.</p>
        </div>

        <div class="app-help-section" id="help-app-compose">
          <h2>Composing apps with tools</h2>
          <p>Exposed tools turn apps into building blocks. An app can call another app's <strong>apps</strong>-level tool with <code>ctx.tools.call(app, tool, args)</code> instead of reimplementing the capability. Platform AI sessions and cron jobs can call any <strong>platform</strong>-level tool. All of this happens in-process on this machine (loopback only).</p>
          <svg viewBox="0 0 720 260" style="width:100%;max-width:720px;height:auto;margin:12px auto;display:block;font-family:system-ui,sans-serif;" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <marker id="cmpArrowG" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6Z" fill="#2d9d5c"/></marker>
              <marker id="cmpArrowB" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6Z" fill="var(--accent)"/></marker>
            </defs>
            <rect width="720" height="260" rx="12" fill="var(--bg-surface)" stroke="var(--border)" stroke-width="1.5"/>
            <rect x="20" y="20" width="680" height="220" rx="10" fill="none" stroke="var(--border)" stroke-width="1.5" stroke-dasharray="5 4"/>
            <text x="360" y="40" text-anchor="middle" fill="var(--text-dim)" font-size="11" font-weight="600">this machine only (loopback)</text>

            <!-- App A -->
            <rect x="50" y="70" width="150" height="60" rx="8" fill="var(--bg)" stroke="var(--border)" stroke-width="1.5"/>
            <text x="125" y="96" text-anchor="middle" fill="var(--text)" font-weight="600" font-size="13">App A</text>
            <text x="125" y="115" text-anchor="middle" fill="var(--text-dim)" font-size="10">needs weather data</text>

            <!-- ctx.tools.call arrow -->
            <line x1="200" y1="100" x2="288" y2="100" stroke="#2d9d5c" stroke-width="2" marker-end="url(#cmpArrowG)"/>
            <text x="244" y="90" text-anchor="middle" fill="#2d9d5c" font-size="10" font-weight="600">ctx.tools.call</text>

            <!-- App B -->
            <rect x="295" y="70" width="180" height="60" rx="8" fill="var(--bg)" stroke="#2d9d5c" stroke-width="2"/>
            <text x="385" y="92" text-anchor="middle" fill="var(--text)" font-weight="600" font-size="13">App B</text>
            <circle cx="330" cy="110" r="4" fill="#2d9d5c"/>
            <text x="340" y="114" fill="var(--text-dim)" font-size="10">get_weather &mdash; expose: apps</text>

            <!-- Platform AI + Cron -->
            <rect x="50" y="170" width="110" height="44" rx="8" fill="var(--bg)" stroke="var(--border)" stroke-width="1.5"/>
            <text x="105" y="196" text-anchor="middle" fill="var(--text)" font-weight="600" font-size="12">Platform AI</text>
            <rect x="180" y="170" width="90" height="44" rx="8" fill="var(--bg)" stroke="var(--border)" stroke-width="1.5"/>
            <text x="225" y="196" text-anchor="middle" fill="var(--text)" font-weight="600" font-size="12">Cron</text>

            <!-- arrows to App C tool -->
            <line x1="270" y1="192" x2="493" y2="192" stroke="var(--accent)" stroke-width="2" marker-end="url(#cmpArrowB)"/>
            <text x="380" y="184" text-anchor="middle" fill="var(--accent)" font-size="10" font-weight="600">calls platform tools</text>

            <!-- App C -->
            <rect x="500" y="164" width="180" height="56" rx="8" fill="var(--bg)" stroke="var(--accent)" stroke-width="2"/>
            <text x="590" y="185" text-anchor="middle" fill="var(--text)" font-weight="600" font-size="13">App C</text>
            <circle cx="535" cy="203" r="4" fill="var(--accent)"/>
            <text x="545" y="207" fill="var(--text-dim)" font-size="10">send_report &mdash; expose: platform</text>
          </svg>
          <p style="font-size:12px;color:var(--text-dim);">The app builder AI knows which tools other apps expose &mdash; when you build or extend an app, it prefers calling an existing tool over rebuilding the same capability.</p>
        </div>

        <div class="app-help-section" id="help-trust">
          <h2>Trust &amp; access</h2>
          <p>Tool calls are checked centrally: the caller's identity (own AI, platform AI, cron, another app, GUI test) is matched against the tool's exposure level, and every call is audited. AI sessions receive a short-lived session token that only unlocks the tools that session is allowed to use &mdash; never platform credentials.</p>
          <svg viewBox="0 0 720 200" style="width:100%;max-width:720px;height:auto;margin:12px auto;display:block;font-family:system-ui,sans-serif;" xmlns="http://www.w3.org/2000/svg">
            <rect width="720" height="200" rx="12" fill="var(--bg-surface)" stroke="var(--border)" stroke-width="1.5"/>
            <!-- lock on the outer edge -->
            <rect x="336" y="14" width="48" height="30" rx="6" fill="var(--bg)" stroke="#cc4444" stroke-width="2"/>
            <rect x="352" y="24" width="16" height="12" rx="2" fill="none" stroke="#cc4444" stroke-width="2"/>
            <path d="M355 24 v-4 a5 5 0 0 1 10 0 v4" fill="none" stroke="#cc4444" stroke-width="2"/>
            <text x="405" y="34" fill="#cc4444" font-size="10" font-weight="600">no network access &mdash; ever</text>

            <!-- layers -->
            <rect x="60" y="58" width="600" height="36" rx="7" fill="none" stroke="#2d9d5c" stroke-width="1.5"/>
            <text x="90" y="80" fill="#2d9d5c" font-weight="600" font-size="12">Apps</text>
            <text x="640" y="80" text-anchor="end" fill="var(--text-dim)" font-size="10">tools, expose levels, ctx.tools.call</text>

            <rect x="60" y="102" width="600" height="36" rx="7" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
            <text x="90" y="124" fill="var(--accent)" font-weight="600" font-size="12">Platform</text>
            <text x="640" y="124" text-anchor="end" fill="var(--text-dim)" font-size="10">expose checks, session tokens, audit log</text>

            <rect x="60" y="146" width="600" height="36" rx="7" fill="none" stroke="var(--text-dim)" stroke-width="1.5"/>
            <text x="90" y="168" fill="var(--text-dim)" font-weight="600" font-size="12">Host</text>
            <text x="640" y="168" text-anchor="end" fill="var(--text-dim)" font-size="10">loopback-only endpoint (127.0.0.1)</text>
          </svg>
        </div>

        <div class="app-help-section">
          <h2>The AI advantage</h2>
          <p>This is what makes vistaclair apps fundamentally different from standalone tools. AI is a <strong>first-class building block</strong>, not an afterthought:</p>
          <table class="app-help-table">
            <thead><tr><th>Data flow</th><th>Without AI</th><th>With AI</th></tr></thead>
            <tbody>
              <tr><td>Results arrive</td><td>Display raw output</td><td>Classify, summarise, flag anomalies</td></tr>
              <tr><td>User sees data</td><td>Read and interpret manually</td><td>AI explains significance, recommends actions</td></tr>
              <tr><td>Decisions needed</td><td>Static options</td><td>AI suggests best option from context</td></tr>
              <tr><td>Errors occur</td><td>Show error message</td><td>AI diagnoses root cause, suggests fixes</td></tr>
              <tr><td>Text output</td><td>Template-based</td><td>AI drafts contextual, tailored content</td></tr>
              <tr><td>Raw data</td><td>Table dump</td><td>AI transforms into human-friendly insights</td></tr>
            </tbody>
          </table>
        </div>

        <div class="app-help-section">
          <h2>App runtimes</h2>
          <div class="app-help-archetypes">
            <div class="app-help-arch">
              <span class="app-card-archetype">IN-PROCESS</span>
              <div>Default. Runs via <code>routes.js</code>, routed into vistaclair's Express server &mdash; shares auth, proxy, and context with the host. Add server-side logic (OAuth, databases, Node.js libraries) in <code>routes.js</code>, or leave it empty for a bridge-only frontend that handles commands, files, AI, and state. The loader serves <code>public/</code> as a static fallback.</div>
            </div>
            <div class="app-help-arch">
              <span class="app-card-archetype">OWN-PROCESS</span>
              <div>The same <code>routes.js</code> app, hosted in its own dashboard-managed process (<code>"runtime": "own-process"</code> in manifest.json). For apps that block the event loop or need crash containment. Reverse-proxied at the same URL. Standalone (pm2-managed) apps are own-process too, just not dashboard-managed.</div>
            </div>
          </div>
        </div>

        <div class="app-help-section">
          <h2>What you can build</h2>
          <p>Security scanners with AI-powered vulnerability analysis. Email dashboards with smart categorisation. Code review tools that explain findings. Data pipelines with intelligent transformation. Network monitors that diagnose issues. DevOps panels that predict failures. Content generators. Research assistants. Anything that benefits from combining <strong>system access + GUI + AI reasoning</strong>.</p>
        </div>
      </div>`;

    return panel;
  }

  function openHelp() {
    ensureTab('_help');
    switchTab('_help');
  }

  // Open the Apps Guide scrolled to a specific section, with a brief highlight.
  function openHelpAt(anchorId) {
    document.querySelector('.app-tools-modal')?.remove();
    const setupModal = document.querySelector('.setup-modal');
    if (setupModal) {
      window.appsRenderTgAwaiting = null;
      apps._onSetupOverview = null;
      (setupModal.closest('.alert-modal-backdrop') || setupModal).remove();
    }
    openHelp();
    requestAnimationFrame(() => {
      const panel = panelOf('_help');
      const el = panel?.querySelector('#' + anchorId) || document.getElementById(anchorId);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.add('help-flash');
      setTimeout(() => el.classList.remove('help-flash'), 1600);
    });
  }

  // --- Platform-wide Tools overview (pseudo-tab '_tools') ---

  function openToolsOverview() {
    ensureTab('_tools');
    switchTab('_tools');
    sendWs({ type: 'app:tools:auditList', limit: 50 });
  }

  function callableFrom(expose) {
    if (expose === 'apps') return 'own AI, platform AI, cron, other apps';
    if (expose === 'platform') return 'own AI, platform AI, cron';
    return 'own AI only';
  }

  function createToolsPanel() {
    const panel = document.createElement('div');
    panel.dataset.panel = 'app-_tools';
    panel.className = 'tools-overview-panel';
    refreshToolsPanel(panel);
    return panel;
  }

  function refreshToolsPanel(panel) {
    let rows = '';
    const sortedApps = Array.from(apps.tools.keys()).sort();
    for (const appName of sortedApps) {
      for (const t of apps.tools.get(appName) || []) {
        rows += `<tr class="tools-overview-row" ${vcAct.attrs('click', 'appsModule.showToolDetail', [appName, t.name])}>
          <td>${escHtml(appName)}</td>
          <td><code>${escHtml(t.name)}</code></td>
          <td>${exposeBadge(t.expose)}</td>
          <td class="tools-overview-callable">${escHtml(callableFrom(t.expose))}</td>
          <td class="tools-overview-desc">${escHtml(t.description || '')}</td>
        </tr>`;
      }
    }
    const toolsTable = rows
      ? `<div class="tools-overview-scroll"><table class="tools-overview-table">
          <thead><tr><th>App</th><th>Tool</th><th>Exposure</th><th>Callable from</th><th>Description</th></tr></thead>
          <tbody>${rows}</tbody></table></div>`
      : '<div class="app-tools-empty">No apps have registered tools yet. Tools appear here when a running app calls ctx.registerTools().</div>';

    panel.innerHTML = `<div class="tools-overview-inner">
      <div class="tools-overview-header">
        <h2>App Tools</h2>
        ${exposeLegend()}
      </div>
      <p class="tools-overview-note">Every tool an app provides, and who may call it. Tools never leave this machine &mdash; there is no network exposure level.</p>
      ${toolsTable}
      <h3 class="tools-audit-title">Recent tool calls</h3>
      <div class="tools-audit-wrap">${renderAuditTable()}</div>
    </div>`;
  }

  function renderAuditTable() {
    if (apps.toolsAudit.length === 0) {
      return '<div class="app-tools-empty">No tool calls recorded since the server started.</div>';
    }
    let rows = '';
    for (const e of apps.toolsAudit) {
      const who = e.callerApp ? `${e.callerType}:${e.callerApp}` : e.callerType;
      rows += `<tr>
        <td>${new Date(e.ts).toLocaleTimeString()}</td>
        <td><span class="tools-audit-caller">${escHtml(who)}</span></td>
        <td><code>${escHtml(e.appName)}.${escHtml(e.toolName)}</code></td>
        <td>${e.durationMs}ms</td>
        <td><span class="tools-audit-dot ${e.ok ? 'audit-ok' : 'audit-err'}" ${e.error ? `title="${escHtml(e.error)}"` : ''}></span></td>
      </tr>`;
    }
    return `<table class="tools-audit-table">
      <thead><tr><th>Time</th><th>Caller</th><th>Tool</th><th>Duration</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  function refreshAuditIfVisible() {
    const panel = panelOf('_tools');
    if (panel && appsHost.isShown('_tools')) {
      const wrap = panel.querySelector('.tools-audit-wrap');
      if (wrap) wrap.innerHTML = renderAuditTable();
    }
  }

  // --- File editor (per-panel state) ---

  const codePanels = new Map(); // appName → { panel, editorFile, editor }

  function loadFileListFor(name, panel) {
    if (!codePanels.has(name)) codePanels.set(name, { panel, editorFile: null, editor: null });
    else codePanels.get(name).panel = panel;
    sendWs({ type: 'app:files', name });
  }

  function renderFileList(files) {
    const active = apps.activeTab;
    const ctx = codePanels.get(active);
    if (!ctx?.panel) return;
    const sidebar = ctx.panel.querySelector('.app-code-sidebar');
    if (!sidebar) return;
    sidebar.innerHTML = files.map(f =>
      `<div class="app-code-file ${f === ctx.editorFile ? 'active' : ''}" data-file="${escHtml(f)}">${escHtml(f)}</div>`
    ).join('');

    sidebar.querySelectorAll('.app-code-file').forEach(el => {
      el.addEventListener('click', () => {
        ctx.editorFile = el.dataset.file;
        renderFileList(files);
        sendWs({ type: 'app:readFile', name: active, path: el.dataset.file });
      });
    });
  }

  function renderFileContent(content, filePath) {
    const active = apps.activeTab;
    const ctx = codePanels.get(active);
    if (!ctx?.panel) return;
    const editorDiv = ctx.panel.querySelector('.app-code-editor');
    if (!editorDiv) return;

    if (ctx.editor) {
      ctx.editor.dispose();
      ctx.editor = null;
    }

    if (typeof monaco === 'undefined' || !monaco.editor) {
      editorDiv.innerHTML = `<pre style="padding:14px;overflow:auto;flex:1;font-size:12px;">${escHtml(content || '')}</pre>`;
      return;
    }

    const ext = (filePath || '').split('.').pop() || '';
    const langMap = { js: 'javascript', ts: 'typescript', json: 'json', html: 'html', css: 'css', md: 'markdown', py: 'python' };
    const language = langMap[ext] || 'plaintext';
    const theme = 'vs';

    editorDiv.innerHTML = '';
    ctx.editor = monaco.editor.create(editorDiv, {
      value: content || '',
      language,
      theme,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12,
      automaticLayout: true,
    });

    ctx.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const val = ctx.editor.getValue();
      sendWs({ type: 'app:writeFile', name: active, path: filePath, content: val, confirmSlaveEdit: slaveEditConfirmed.has(active) });
    });
  }

  // --- Actions ---

  function openApp(name) {
    // Full-screen apps open in a chrome-free launcher tab instead of an in-dashboard
    // panel. The launcher (behind the owner cookie here) hosts the Bridge relay, so
    // the app keeps full capability parity with the in-dashboard surface.
    const app = apps.list.find(a => a.name === name);
    if (app && app.display === 'fullscreen') {
      openFullScreen(name);
      return;
    }
    ensureTab(name);
    switchTab(name);
  }

  function openFullScreen(name) {
    window.open('/pro/app-launcher.html?app=' + encodeURIComponent(name), '_blank', 'noopener');
  }

  function closeAppTab(name) {
    const idx = apps.openTabs.indexOf(name);
    if (idx === -1) return;
    apps.openTabs.splice(idx, 1);

    // Closing a tab only removes the view (host.remove destroys the panel,
    // wherever it sits, a desk window then shows a placeholder). The app keeps
    // running: it may be open in another browser or doing its own work. Stop
    // is explicit (app card, app top bar).
    appsHost?.remove(name);

    // Switch to grid or the next home tab
    if (apps.activeTab === name) {
      const next = apps.openTabs.slice(idx).concat(apps.openTabs.slice(0, idx).reverse()).find(k => !appsHost?.isOnDesk(k));
      switchTab(next || 'grid');
    } else {
      renderTabStrip();
    }
  }

  // Ask for a change session. The view is NOT switched here — that happens on
  // the server's `app:cliSpawned`, so a refused request (slave mirror, no
  // session manager) leaves the user where they are instead of on an empty
  // Claude view. On a slave the server may answer `app:slaveEditConfirm`
  // first and the request is replayed from there.
  function openCli(name) {
    const tabId = `app-${name}`;
    const cli = window.cliModule;
    if (cli?.tabs?.has(tabId)) {
      cli.switchTab(tabId);
      if (typeof switchView === 'function') switchView('claude');
      return;
    }
    const app = apps.list.find(a => a.name === name);
    sendWs({
      type: 'app:spawnCli',
      name,
      action: 'extend',
      description: app?.description || '',
      cols: 80,
      rows: 24,
      confirmSlaveEdit: slaveEditConfirmed.has(name),
    });
  }

  // True when this host is a slave and the app arrived here via a publish, so
  // its sources are owned by the master. Advisory only — the server re-checks.
  function isMasterMirror(app) {
    return !!app?.deployed && window.publishModule?.isMaster() === false;
  }

  // Apps the user has already accepted the mirror-edit warning for, this
  // session. Once confirmed, every edit-shaped message (spawnCli, writeFile)
  // for that app carries `confirmSlaveEdit: true` so one-shot saves (Ctrl+S)
  // don't re-prompt on each keystroke of work. Server-side the flag is only
  // ever honored on a mirror, so sending it for normal apps is a no-op.
  const slaveEditConfirmed = new Set();

  // Pre-confirm for editing an app this slave received from a master. Editing
  // is allowed; the point is that the next publish replaces the app directory,
  // so source changes are discarded while data changes survive. `request` is
  // the refused message, replayed as-is once the user accepts — a CLI spawn or
  // a file save, whichever triggered the warning. Accepting also marks the app
  // confirmed for the rest of the session (see slaveEditConfirmed).
  function confirmSlaveEdit(name, request) {
    document.querySelector('.app-slave-edit-modal')?.remove();
    const isSave = request?.type === 'app:writeFile';
    const backdrop = document.createElement('div');
    backdrop.className = 'alert-modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'alert-modal app-slave-edit-modal';
    modal.style.maxWidth = '460px';
    modal.innerHTML = `
      <div style="font-weight:600;font-size:15px;margin-bottom:10px;">Edit a published app?</div>
      <div style="margin-bottom:10px;"><strong>${escHtml(name)}</strong> was published to this server from the master. The next publish replaces the whole app directory with the master's copy.</div>
      <div style="margin-bottom:6px;"><strong>Source changes made here will be overwritten</strong> — make them on the master and publish again if they need to last.</div>
      <div style="margin-bottom:14px;">Data work survives: the database and the app's runtime files (<code>.data/</code>, settings, secrets). Migrations and one-off data fixes are safe here.</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="app-modal-cancel" style="padding:6px 16px;cursor:pointer;">Cancel</button>
        <button class="app-modal-confirm" style="padding:6px 16px;cursor:pointer;background:var(--accent);color:#fff;border:none;border-radius:4px;">${isSave ? 'Save anyway' : 'Open change CLI'}</button>
      </div>`;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    modal.querySelector('.app-modal-cancel').addEventListener('click', close);
    modal.querySelector('.app-modal-confirm').addEventListener('click', () => {
      close();
      slaveEditConfirmed.add(name);
      sendWs({ ...request, confirmSlaveEdit: true });
    });
    modal.querySelector('.app-modal-confirm').focus();
  }

  // A browser error inside an app iframe: shown on the Runtime errors card and
  // recorded server-side (app-guard logs it, counts it and raises the header
  // alert). A repeat of the same error is neither.
  function reportError(appName, error) {
    const dup = apps.errors.find(e =>
      e.appName === appName && e.error.message === error.message
      && e.error.source === error.source && e.error.lineno === error.lineno
    );
    if (dup) return;
    sendWs({ type: 'app:clientError', name: appName, error: { message: error.message, source: error.source, lineno: error.lineno, colno: error.colno } });
    apps.errors.push({ id: ++errorSeq, appName, error, timestamp: error.timestamp || Date.now() });
    if (apps.errors.length > 50) apps.errors.shift();
    refreshGrid();
  }

  function showErrorDetail(id) {
    document.querySelector('.app-error-detail-modal')?.remove();
    const entry = apps.errors.find(e => e.id === id);
    if (!entry) return;
    const err = entry.error;
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const source = err.source ? err.source.split('/').pop() : null;
    const location = source ? `${source}:${err.lineno || '?'}:${err.colno || '?'}` : null;

    const modal = document.createElement('div');
    modal.className = 'app-error-detail-modal';
    const close = () => modal.remove();

    modal.innerHTML = `<div class="app-error-detail-content">
      <div class="app-error-detail-header">
        <span>${escHtml(entry.appName)} <span style="font-weight:400;color:var(--text-dim);font-size:12px;">${time}</span></span>
        <button class="app-error-detail-close">&times;</button>
      </div>
      <div class="app-error-detail-body">
        <div class="app-error-detail-section">
          <div class="app-error-detail-label">Error</div>
          <pre class="app-error-detail-pre">${escHtml(err.message || 'Unknown error')}</pre>
        </div>
        ${location ? `<div class="app-error-detail-section">
          <div class="app-error-detail-label">Location</div>
          <div class="app-error-detail-location">${escHtml(location)}</div>
        </div>` : ''}
        ${err.stack ? `<div class="app-error-detail-section">
          <div class="app-error-detail-label">Stack Trace</div>
          <pre class="app-error-detail-pre">${escHtml(err.stack)}</pre>
        </div>` : ''}
      </div>
      <div class="app-error-detail-footer">
        <button class="app-error-detail-dismiss">Dismiss</button>
      </div>
    </div>`;

    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('.app-error-detail-close').addEventListener('click', close);
    modal.querySelector('.app-error-detail-dismiss').addEventListener('click', () => {
      apps.errors = apps.errors.filter(e => e.id !== id);
      refreshGrid();
      close();
    });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
  }

  function clearErrors() {
    apps.errors = [];
    refreshGrid();
  }

  function toggleApp(name, start, opts) {
    const row = document.querySelector(`#view-apps tr.apps-row[data-app="${CSS.escape(name)}"]`);
    const btn = row?.querySelector('.apps-act-toggle');
    if (btn) { btn.disabled = true; btn.textContent = start ? 'Starting...' : 'Stopping...'; }
    sendWs(!start && opts?.stopSites ? { type: 'app:stop', name, stopSites: true } : { type: start ? 'app:start' : 'app:stop', name });
  }

  // With `{ mount, onExit }` the confirmation renders inside `mount` (the
  // settings modal's Danger tab); returns its closer.
  function deleteApp(name, opts) {
    if (opts && opts.mount) {
      const host = opts.mount;
      const close = () => { host.innerHTML = ''; opts.onExit?.(); };
      host.innerHTML = `<div class="vc-callout bad">
        <p>Are you sure you want to delete <strong>${escHtml(name)}</strong>? This cannot be undone.</p>
        <div class="vc-acts-row"><span class="sp"></span><button class="vc-btn ghost app-modal-cancel">Cancel</button><button class="vc-btn danger app-modal-delete">Delete</button></div>
      </div>`;
      host.querySelector('.app-modal-cancel').addEventListener('click', close);
      host.querySelector('.app-modal-delete').addEventListener('click', () => {
        sendWs({ type: 'app:delete', name });
        closeAppTab(name);
        close();
        if (settings && settings.name === name) settings.close();
      });
      return close;
    }
    const backdrop = document.createElement('div');
    backdrop.className = 'alert-modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'alert-modal';
    modal.innerHTML = `
      <div style="margin-bottom:12px;">Are you sure you want to delete <strong>${escHtml(name)}</strong>? This cannot be undone.</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="app-modal-cancel" style="padding:6px 16px;cursor:pointer;">Cancel</button>
        <button class="app-modal-delete" style="padding:6px 16px;cursor:pointer;background:var(--red);color:#fff;border:none;border-radius:4px;">Delete</button>
      </div>`;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    modal.querySelector('.app-modal-cancel').addEventListener('click', close);
    modal.querySelector('.app-modal-delete').addEventListener('click', () => {
      sendWs({ type: 'app:delete', name });
      closeAppTab(name);
      close();
    });
  }

  // Guided rename: pick a name, review everything the rename touches (server
  // preflight — Telegram/WhatsApp linkage, cron jobs, database), then confirm.
  // The modal stays open until the server reports the outcome.
  // With `{ mount, onExit }` it renders inside `mount` (the settings modal's
  // Danger tab) instead of its own modal; returns its closer.
  function renameApp(name, opts) {
    const VALID = /^[a-z0-9][a-z0-9-]*$/;
    const embedded = !!(opts && opts.mount);
    let modal, backdrop = null;
    if (embedded) {
      modal = opts.mount;
    } else {
      backdrop = document.createElement('div');
      backdrop.className = 'alert-modal-backdrop';
      modal = document.createElement('div');
      modal.className = 'alert-modal';
      modal.style.maxWidth = '460px';
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);
    }

    let newName = name;
    let preflightTimer = null;

    const close = () => {
      apps._onRenamePreflight = null;
      apps._onRenamed = null;
      apps._onRenameError = null;
      if (preflightTimer) clearTimeout(preflightTimer);
      if (embedded) { modal.innerHTML = ''; opts.onExit?.(); } else backdrop.remove();
    };
    if (!embedded) {
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
      document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
    }

    function frame(bodyHtml, buttonsHtml) {
      modal.innerHTML = `<div class="${embedded ? 'vc-panel vc-rename' : ''}">
        <div style="font-weight:600;font-size:15px;margin-bottom:12px;">Rename App</div>
        ${bodyHtml}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">${buttonsHtml}</div></div>`;
      modal.querySelector('.app-modal-cancel')?.addEventListener('click', close);
    }

    function renderNameStep() {
      frame(`
        <label style="display:block;margin-bottom:4px;">New name</label>
        <input id="appRenameInput" type="text" value="${escHtml(newName)}" style="width:100%;box-sizing:border-box;padding:6px 8px;font-family:inherit;font-size:14px;">
        <div id="appRenameError" style="color:var(--red);font-size:12px;min-height:18px;margin-top:4px;"></div>`, `
        <button class="app-modal-cancel" style="padding:6px 16px;cursor:pointer;">Cancel</button>
        <button id="appRenameNext" style="padding:6px 16px;cursor:pointer;background:var(--accent);color:#fff;border:none;border-radius:4px;">Continue</button>`);

      const input = modal.querySelector('#appRenameInput');
      const errEl = modal.querySelector('#appRenameError');
      const nextBtn = modal.querySelector('#appRenameNext');

      function validate() {
        const v = input.value.trim();
        if (!v || !VALID.test(v)) {
          errEl.textContent = 'Lowercase letters, numbers, and hyphens only. Must start with a letter or number.';
          nextBtn.disabled = true;
          return false;
        }
        if (v === name) {
          errEl.textContent = '';
          nextBtn.disabled = true;
          return false;
        }
        errEl.textContent = '';
        nextBtn.disabled = false;
        return true;
      }
      input.addEventListener('input', validate);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && validate()) nextBtn.click(); });
      validate();
      nextBtn.addEventListener('click', () => {
        if (!validate()) return;
        newName = input.value.trim();
        requestPreflight();
      });
      input.focus();
      input.select();
    }

    function requestPreflight() {
      frame(`<div style="padding:12px 0;color:var(--text-dim,inherit);">Checking what this rename touches&hellip;</div>`,
        `<button class="app-modal-cancel" style="padding:6px 16px;cursor:pointer;">Cancel</button>`);
      apps._onRenamePreflight = (msg) => {
        if (msg.appName !== name) return;
        apps._onRenamePreflight = null;
        clearTimeout(preflightTimer);
        renderConfirmStep(msg.info && !msg.info.error ? msg.info : null);
      };
      // If the preflight reply is lost, still let the user proceed with
      // generic guidance rather than wedging the modal.
      preflightTimer = setTimeout(() => { apps._onRenamePreflight = null; renderConfirmStep(null); }, 5000);
      sendWs({ type: 'app:rename:preflight', name });
    }

    function renderConfirmStep(info) {
      const item = (icon, html, warn) => `
        <li style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px;${warn ? 'color:var(--red);' : ''}">
          <span style="flex:none;">${icon}</span><span>${html}</span>
        </li>`;
      const items = [];

      if (!info) {
        items.push(item('&#9888;', 'Could not inspect the app’s linkages (Telegram, WhatsApp, cron). The rename will still migrate what it can — review any warnings afterwards.', true));
      } else {
        if (info.running) items.push(item('&#9209;', `<b>${escHtml(name)}</b> is running and will be <b>stopped</b>. Start it again after the rename.`));
        if (info.telegram) {
          const bot = info.telegram.botUsername ? `@${escHtml(info.telegram.botUsername)}` : 'bot';
          if (info.telegram.mode === 'webhook') {
            items.push(item('&#128257;', `Telegram ${bot} delivers to an address containing the app name — its webhook will be <b>re-registered automatically</b>. If that fails you’ll get a warning telling you to re-save the public URL.`));
          } else {
            items.push(item('&#9989;', `Telegram ${bot} runs in polling mode — it moves over automatically, nothing to do.`));
          }
        }
        if (info.whatsapp) {
          const phone = info.whatsapp.displayPhone ? ` (${escHtml(info.whatsapp.displayPhone)})` : '';
          items.push(item('&#9888;', `WhatsApp${phone}: Meta delivers messages to a URL containing the app name. <b>After renaming, update the callback URL in the Meta developer dashboard</b> to <code>/pro/whatsapp/${escHtml(newName)}/webhook</code> — inbound messages stop until you do.`, true));
        }
        if (info.cronJobs > 0) items.push(item('&#128337;', `${info.cronJobs} scheduled job${info.cronJobs === 1 ? '' : 's'} will be moved to the new name.`));
        if (info.db) items.push(item('&#128452;', `The app keeps its database and all data (the internal database name <code>${escHtml(info.db.database)}</code> is unchanged).`));
        if (!info.dbConnected) items.push(item('&#9888;', 'The platform database is offline — app-scoped memory and email/calendar records cannot be migrated and will keep the old name.', true));
      }

      items.push(item('&#128221;', `References to “${escHtml(name)}” inside the app’s own files are rewritten to “${escHtml(newName)}”.`));
      items.push(item('&#128274;', 'Anyone signed in to this app will be signed out and must sign in again.'));
      items.push(item('&#128279;', `Bookmarks, external links, and other apps calling <code>/apps/${escHtml(name)}/</code> must be updated by hand.`));

      frame(`
        <div style="margin-bottom:10px;">Rename <b>${escHtml(name)}</b> &rarr; <b>${escHtml(newName)}</b></div>
        <ul style="list-style:none;padding:0;margin:0;font-size:13px;line-height:1.45;">${items.join('')}</ul>
        <div id="appRenameError" style="color:var(--red);font-size:12px;min-height:18px;margin-top:6px;"></div>`, `
        <button id="appRenameBack" style="padding:6px 16px;cursor:pointer;">Back</button>
        <button class="app-modal-cancel" style="padding:6px 16px;cursor:pointer;">Cancel</button>
        <button id="appRenameConfirm" style="padding:6px 16px;cursor:pointer;background:var(--accent);color:#fff;border:none;border-radius:4px;">Rename app</button>`);

      modal.querySelector('#appRenameBack').addEventListener('click', renderNameStep);
      const confirmBtn = modal.querySelector('#appRenameConfirm');
      const errEl = modal.querySelector('#appRenameError');
      confirmBtn.addEventListener('click', () => {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Renaming…';
        modal.querySelector('#appRenameBack').disabled = true;
        apps._onRenamed = (msg) => {
          if (msg.oldName !== name) return;
          showToast({ appName: msg.newName, title: 'App renamed', message: `${name} is now ${msg.newName}.`, level: 'info' });
          close();
          if (settings && settings.name === name) settings.close();
        };
        apps._onRenameError = (msg) => {
          errEl.textContent = msg.error || 'Rename failed';
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Rename app';
          modal.querySelector('#appRenameBack').disabled = false;
        };
        sendWs({ type: 'app:rename', name, newName });
      });
    }

    renderNameStep();
    return close;
  }

  const VC_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

  // Console overlay shell shared by the Pro modals: dim + blur backdrop,
  // pop animation, Escape/backdrop close. `onClose` fires once, however the
  // overlay was dismissed (caller's close(), Escape, backdrop, .vc-close) —
  // that is what lets a caller model the dialog as a promise.
  // Returns { overlay, close }.
  function openConsole(className, innerHtml, onClose) {
    const overlay = document.createElement('div');
    overlay.className = 'vc-overlay ' + className;
    overlay.innerHTML = innerHtml;
    let closed = false;
    const close = () => {
      if (closed) return; closed = true;
      overlay.classList.add('app-menu-closing');
      setTimeout(() => overlay.remove(), 130);
      document.removeEventListener('keydown', esc);
      if (typeof onClose === 'function') onClose();
    };
    function esc(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', esc);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelectorAll('.vc-close').forEach(b => b.addEventListener('click', close));
    document.body.appendChild(overlay);
    return { overlay, close };
  }

  function showCreate() {
    document.querySelector('.vc-overlay.vc-create-overlay')?.remove();
    const { overlay, close } = openConsole('vc-create-overlay', `<div class="vc-console create"><i class="vc-tick"></i>
      <div class="vc-chead">
        <div><div class="vc-eyebrow">apps &middot; new</div><h3>Create a new app</h3><div class="vc-sub">Claude asks clarifying questions, writes a spec, then builds.</div></div>
        <button class="vc-close" aria-label="Close">${VC_X}</button>
      </div>
      <div class="vc-main">
        <div class="vc-field"><label for="appCreateName">name</label><div class="vc-inp-wrap"><input id="appCreateName" class="vc-inp" type="text" placeholder="my-app" autocomplete="off" spellcheck="false"><span class="suffix" id="appCreateSlug"></span></div></div>
        <div class="vc-field"><label for="appCreateDesc">what should it do?</label><textarea id="appCreateDesc" class="vc-inp" rows="6" placeholder="Describe what you want this app to do. Be as detailed or brief as you like - Claude will ask clarifying questions, suggest improvements, and develop a complete spec with you before building anything."></textarea></div>
        <div class="vc-hint">The build runs as a background task and survives a reload. Ctrl+Enter creates.</div>
      </div>
      <div class="vc-cfoot"><span class="status"></span><span class="sp"></span><button class="vc-btn ghost app-modal-cancel">Cancel</button><button class="vc-btn signal app-modal-create" disabled>Create &amp; build &rarr;</button></div>
    </div>`);

    const nameEl = overlay.querySelector('#appCreateName');
    const descEl = overlay.querySelector('#appCreateDesc');
    const slugEl = overlay.querySelector('#appCreateSlug');
    const createBtn = overlay.querySelector('.app-modal-create');
    const sync = () => {
      const n = nameEl.value.trim();
      slugEl.textContent = n ? `/apps/${n}` : '';
      createBtn.disabled = !n;
    };
    nameEl.addEventListener('input', sync);
    nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); descEl.focus(); } });
    const submit = () => {
      const name = nameEl.value.trim();
      const description = descEl.value.trim();
      if (!name) return;
      sendWs({ type: 'app:create', name, description });
      apps._pendingBuild = { name, description };
      close();
    };
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });
    overlay.querySelector('.app-modal-cancel').addEventListener('click', close);
    createBtn.addEventListener('click', submit);
    nameEl.focus();
  }

  // --- App→app dependencies (Setup → Tools & Access) -------------------------
  // Server state (app:deps, from app-deps.js) is the only source; the pane
  // re-renders from apps.deps, so a GUI reload loses nothing.
  const DEP_STATUS_ORDER = { approved: 0, observed: 1, revoked: 2 };
  let depsRefreshTimer = null;

  function appDepsPaneOpen() {
    return !!document.getElementById('setupPane-tools-access')?.classList.contains('active');
  }

  // app:deps:changed arrives for every structural change; a burst of them
  // costs one re-request, while the pane is visible or the apps table holds
  // a copy (Stop names the dependents from it).
  function requestAppDepsSoon() {
    if (!(appDepsPaneOpen() || apps.deps) || depsRefreshTimer) return;
    depsRefreshTimer = setTimeout(() => {
      depsRefreshTimer = null;
      if (appDepsPaneOpen() || apps.deps) sendWs({ type: 'app:deps:get' });
    }, 500);
  }

  // Telegram inbound chip: the delivery monitor's view of one bot (webhook /
  // polling / polling because the public URL is down). Click → check now.
  function tgInboundChip(b, appName) {
    const fmt = (t) => (t ? new Date(t).toLocaleTimeString() : '');
    let text = b.inbound === 'webhook' ? 'webhook' : b.inbound === 'poll' ? 'polling' : (b.mode || '?');
    let cls = 'ok';
    const tip = [];
    if (b.fallback) {
      text = 'polling (tunnel down)';
      cls = 'warn';
      tip.push(`Fallback since ${fmt(b.fallback.since)}: ${b.fallback.reason}`);
    }
    if (b.lastCheck) tip.push(`Last check ${fmt(b.lastCheck.at)}: ${b.lastCheck.ok ? 'OK' : 'failed'}${b.lastCheck.reason ? ' — ' + b.lastCheck.reason : ''}`);
    else if (b.inbound === 'poll' && !b.fallback) tip.push('Long-poll: needs no public URL');
    if (b.monitored === false) tip.push("Delivery is watched by the app's own process; its state is not shown here");
    tip.push('Click to check now');
    return `<span class="setup-check ${cls}" style="cursor:pointer;" data-tg-check="${escHtml(appName)}" title="${escHtml(tip.join('\n'))}">${escHtml(text)}</span>`;
  }

  // appName → timer of a check-now waiting for its reply. The server answers
  // within ~12 s (checkNow is bounded); no reply by TG_CHECK_TIMEOUT_MS means
  // it cannot (e.g. a server older than this page) — the chip is put back.
  const TG_CHECK_TIMEOUT_MS = 15000;
  const tgCheckTimers = new Map();
  const tgChipOf = (appName) => [...document.querySelectorAll('[data-tg-check]')].find((c) => c.dataset.tgCheck === appName) || null;

  function wireTgInboundChips(root) {
    root.querySelectorAll('[data-tg-check]').forEach((chip) => {
      const appName = chip.dataset.tgCheck;
      // A re-render while a check is pending keeps the chip busy.
      if (tgCheckTimers.has(appName)) { chip.dataset.busy = '1'; chip.className = 'setup-check testing'; chip.textContent = 'checking…'; }
      chip.addEventListener('click', () => {
        if (chip.dataset.busy || tgCheckTimers.has(appName)) return;
        const prev = { className: chip.className, text: chip.textContent, title: chip.title };
        chip.dataset.busy = '1';
        chip.className = 'setup-check testing';
        chip.textContent = 'checking…';
        tgCheckTimers.set(appName, setTimeout(() => {
          tgCheckTimers.delete(appName);
          const note = 'No answer from the server — restart the control room if it was just updated';
          const c = tgChipOf(appName);
          if (c && c.dataset.busy) {
            delete c.dataset.busy;
            c.className = prev.className;
            c.textContent = prev.text;
            c.title = `${note}\n${prev.title}`;
          }
          showToast({ sender: 'Telegram', title: 'Delivery check', message: note, level: 'warning' });
        }, TG_CHECK_TIMEOUT_MS));
        sendWs({ type: 'app:setup:telegramCheckDelivery', appName });
      });
    });
  }

  // A check-now reply (on time or late): stop waiting; the status message that
  // follows re-renders the chip. Without one (a refusal), un-busy it here.
  function settleTgCheck(appName) {
    clearTimeout(tgCheckTimers.get(appName));
    tgCheckTimers.delete(appName);
    const c = tgChipOf(appName);
    if (c) delete c.dataset.busy;
  }

  function depBadge(text, cls, title) {
    const style = cls === 'bad' ? ' style="color:var(--red);background:color-mix(in srgb, var(--red) 12%, transparent);"' : '';
    return `<span class="setup-check ${cls === 'bad' ? '' : cls}"${style}${title ? ` title="${escHtml(title)}"` : ''}>${escHtml(text)}</span>`;
  }

  function depStatusBadge(status) {
    if (status === 'approved') return depBadge('approved', 'ok');
    if (status === 'observed') return depBadge('observed', 'warn', 'Called without a declaration — approve it to make it a dependency');
    return depBadge(status || 'revoked', 'loading');
  }

  function depContractBadge(e) {
    const problems = (e.contractProblems || []).join('\n');
    if (e.contractStatus === 'broken') return depBadge('broken', 'bad', problems || 'The provider changed a tool incompatibly');
    if (e.contractStatus === 'changed-compatible') return depBadge('changed', 'warn', problems || 'The provider changed a tool compatibly — re-approve to accept');
    return depBadge('ok', 'ok', 'Contract matches what was approved');
  }

  function depOrigin(e) {
    const o = e.origin || {};
    if (o.type === 'change-request' && o.ref) {
      const rec = (apps.changeRequests || []).find((r) => r.id === o.ref);
      const tip = rec
        ? `Change request ${rec.id} · ${rec.state}${rec.summary ? ' · ' + rec.summary : ''}`
        : `Change request ${o.ref}`;
      const open = rec && rec.state === 'pending';
      return `<span${open ? ` data-dep-cr="${escHtml(o.ref)}"` : ''} title="${escHtml(tip)}" style="text-decoration:underline dotted;${open ? 'cursor:pointer;' : ''}">change request</span>`;
    }
    return escHtml(o.type || 'unknown');
  }

  function renderDepEdge(e) {
    const tools = (e.tools || []).includes('*')
      ? 'all apps tools'
      : (e.tools || []).map((t) => `<code>${escHtml(t)}</code>`).join(', ') || '<span class="setup-hint" style="margin:0;">no tools</span>';
    const live = e.status === 'approved' || e.status === 'observed';
    const btn = (label, attr, extra = '') => `<button class="setup-btn${extra}" style="padding:3px 10px;font-size:11.5px;" ${attr}="${escHtml(e.id)}">${label}</button>`;
    const buttons = [];
    if (e.status === 'observed') buttons.push(btn('Approve', 'data-dep-approve', ' setup-btn-primary'));
    if (e.status === 'approved' && e.contractStatus && e.contractStatus !== 'ok') buttons.push(btn('Re-approve', 'data-dep-approve', ' setup-btn-primary'));
    if (live) buttons.push(btn('Revoke', 'data-dep-revoke', ' setup-btn-danger'));
    const meta = [
      `${e.calls || 0} call${e.calls === 1 ? '' : 's'}`,
      `last call ${e.lastCallAt ? escHtml(fmtAgo(e.lastCallAt)) : 'never'}`,
      `${e.errors || 0} error${e.errors === 1 ? '' : 's'}`,
      `origin ${depOrigin(e)}`,
    ].join(' &middot; ');
    return `<div class="setup-row" style="align-items:flex-start;gap:12px;${live ? '' : 'opacity:.5;'}">
      <div style="flex:1;min-width:0;">
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;"><span>${tools}</span>${depStatusBadge(e.status)}${live ? depContractBadge(e) : ''}</div>
        <div class="setup-hint" style="margin:3px 0 0;">${meta}</div>
        ${e.purpose ? `<div class="setup-hint" style="margin:2px 0 0;font-style:italic;">${escHtml(e.purpose)}</div>` : ''}
      </div>
      ${buttons.length ? `<div style="display:flex;gap:6px;flex:none;">${buttons.join('')}</div>` : ''}
    </div>`;
  }

  function renderAppDepsEdges(d) {
    const mode = d.mode === 'enforce' ? 'enforce' : 'warn';
    const edges = d.edges || [];
    const broken = edges.filter((e) => e.status === 'approved' && e.contractStatus === 'broken').length;
    const seg = (m, label) => `<button class="${mode === m ? 'on' : ''}" data-dep-mode="${m}">${label}</button>`;
    let html = `<div class="setup-section">
      <div class="setup-section-title">App dependencies${broken > 0 ? ` <span style="color:var(--red);">&middot; ${broken} broken</span>` : ''}</div>
      <div class="setup-row" style="justify-content:flex-start;gap:12px;"><div class="vc-seg">${seg('warn', 'Warn')}${seg('enforce', 'Enforce')}</div></div>
      <div class="setup-hint">Warn: undeclared app&rarr;app calls are allowed and flagged. Enforce: they are refused until declared (<code>app-change.js depend</code>) or approved here.</div>`;
    if (edges.length === 0) return html + '<div class="setup-hint">No app calls another app\'s tools yet.</div></div>';
    const groups = new Map();
    for (const e of edges) {
      const key = `${e.consumer}\u0000${e.provider}`;
      if (!groups.has(key)) groups.set(key, { consumer: e.consumer, provider: e.provider, edges: [] });
      groups.get(key).edges.push(e);
    }
    const ordered = [...groups.values()].sort((a, b) => a.consumer.localeCompare(b.consumer) || a.provider.localeCompare(b.provider));
    for (const g of ordered) {
      g.edges.sort((a, b) => (DEP_STATUS_ORDER[a.status] ?? 3) - (DEP_STATUS_ORDER[b.status] ?? 3) || (b.createdAt || 0) - (a.createdAt || 0));
      html += `<div style="margin-top:10px;font-size:13px;font-weight:600;"><code>${escHtml(g.consumer)}</code> &rarr; <code>${escHtml(g.provider)}</code></div>`;
      html += g.edges.map(renderDepEdge).join('');
    }
    return html + '</div>';
  }

  function renderAppDepsHealth(d) {
    const h = d.health || {};
    const unused = h.exposedUnused || [];
    const idle = h.idle || [];
    const undeclared = h.undeclared || [];
    let html = '<div class="setup-section"><div class="setup-section-title">Health</div>';
    if (!unused.length && !idle.length && !undeclared.length) return html + '<div class="setup-hint">Nothing to flag.</div></div>';
    const sub = (t) => `<div style="margin-top:8px;font-size:12.5px;font-weight:600;">${t}</div>`;
    if (unused.length) {
      html += sub('Exposed to apps, no dependents');
      html += `<div class="setup-hint" style="margin:2px 0 0;">${unused.map((u) => `<code>${escHtml(u.app)}.${escHtml(u.tool)}</code>`).join(', ')}</div>`;
    }
    if (idle.length) {
      html += sub(`Approved, not called in ${escHtml(String(h.idleDays || 30))} days`);
      for (const i of idle) {
        html += `<div class="setup-row"><span><code>${escHtml(i.consumer)}</code> &rarr; <code>${escHtml(i.provider)}</code></span><span class="setup-hint" style="margin:0;">last call ${i.lastCallAt ? escHtml(fmtAgo(i.lastCallAt)) : 'never'}</span></div>`;
      }
    }
    if (undeclared.length) {
      html += sub('Recent undeclared calls');
      for (const u of undeclared) {
        const result = u.ok ? depBadge('ok', 'ok') : depBadge('error', 'bad', u.error || 'failed');
        html += `<div class="setup-row" style="gap:10px;"><span><code>${escHtml(u.consumer)}</code> &rarr; <code>${escHtml(u.provider)}.${escHtml(u.tool)}</code></span><span style="display:flex;align-items:center;gap:8px;"><span class="setup-hint" style="margin:0;" title="${escHtml(u.ts ? new Date(u.ts).toLocaleString() : '')}">${escHtml(fmtAgo(u.ts) || '')}</span>${result}</span></div>`;
      }
    }
    return html + '</div>';
  }

  function renderAppDepsGrants(d) {
    const runs = d.agentGrants || [];
    let html = `<div class="setup-section"><div class="setup-section-title">Agent grants (read-only)</div>
      <div class="setup-hint">Orchestration runs get tools through run grants, not dependencies; shown read-only.</div>`;
    if (!runs.length) return html + '<div class="setup-hint">No orchestration run holds tools right now.</div></div>';
    for (const run of runs) {
      html += `<div style="margin-top:10px;font-size:13px;font-weight:600;">run <code>${escHtml(run.runId)}</code></div>`;
      for (const m of run.members || []) {
        const tools = m.tools == null
          ? 'full catalog (orchestrator)'
          : (m.tools.length ? m.tools.map((t) => `<code>${escHtml(t)}</code>`).join(', ') : 'no tools');
        html += `<div class="setup-row" style="align-items:flex-start;gap:12px;">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;"><code>${escHtml(m.address)}</code>${depBadge(m.type || 'worker', 'loading', m.mode ? `mode: ${m.mode}` : '')}</div>
            <div class="setup-hint" style="margin:3px 0 0;">${tools}</div>
          </div>
          <span class="setup-hint" style="margin:0;flex:none;">${m.calls || 0} call${m.calls === 1 ? '' : 's'}</span>
        </div>`;
      }
    }
    return html + '</div>';
  }

  function renderAppDeps() {
    const el = document.getElementById('appDepsPanel');
    if (!el) return;
    const d = apps.deps;
    if (!d) { el.innerHTML = '<div class="setup-section"><div class="setup-section-title">App dependencies</div><div class="setup-hint">Loading&hellip;</div></div>'; return; }
    el.innerHTML = renderAppDepsEdges(d) + renderAppDepsHealth(d) + renderAppDepsGrants(d);
    el.querySelectorAll('[data-dep-mode]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.depMode !== (d.mode === 'enforce' ? 'enforce' : 'warn')) sendWs({ type: 'app:deps:setMode', mode: b.dataset.depMode });
    }));
    el.querySelectorAll('[data-dep-approve]').forEach((b) => b.addEventListener('click', () => {
      b.disabled = true;
      sendWs({ type: 'app:deps:approve', id: b.dataset.depApprove });
    }));
    el.querySelectorAll('[data-dep-revoke]').forEach((b) => b.addEventListener('click', async () => {
      const e = (d.edges || []).find((x) => x.id === b.dataset.depRevoke);
      if (e && !(await showConfirm(`Revoke "${e.consumer}" → "${e.provider}"?${d.mode === 'enforce' ? ' Its calls will be refused.' : ''}`, { confirmLabel: 'Revoke', danger: true }))) return;
      b.disabled = true;
      sendWs({ type: 'app:deps:revoke', id: b.dataset.depRevoke });
    }));
    el.querySelectorAll('[data-dep-cr]').forEach((s) => s.addEventListener('click', () => showChangeRequestModal(s.dataset.depCr)));
  }

  // "uses N · used by M" for the actions menu, from non-revoked edges.
  function depCountsDesc(name) {
    const edges = (apps.deps?.edges || []).filter((e) => e.status !== 'revoked');
    const uses = new Set(edges.filter((e) => e.consumer === name).map((e) => e.provider)).size;
    const usedBy = new Set(edges.filter((e) => e.provider === name).map((e) => e.consumer)).size;
    return uses || usedBy ? ` · uses ${uses} · used by ${usedBy}` : '';
  }

  // --- Setup → Drucker (docs/print.md): a pure render of server state; every app:print:state carries it all ---
  const printSetup = (() => {
    const S = { state: null, error: null, notice: null, busy: false };
    let paneEl = null;

    const cap = (s, n) => { const t = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
    const e = (s, n = 120) => escHtml(cap(s, n));
    const STATE_LABEL = { idle: 'bereit', printing: 'druckt', disabled: 'deaktiviert', stopped: 'angehalten', unknown: 'unbekannt' };
    const JOB_LABEL = { active: 'in der Warteschlange', completed: 'fertig', failed: 'Fehler', sent: 'gesendet', unknown: 'unbekannt' };

    function fmtTime(iso) { try { return new Date(iso).toLocaleString(); } catch { return ''; } }

    function html() {
      const st = S.state;
      if (!st) return `<div class="setup-pane-intro"><h3>🖨️ Drucker</h3></div><div class="setup-section">${S.error ? `<div class="setup-status error">${e(S.error, 300)}</div>` : '<span class="setup-check loading">loading...</span>'}</div>`;
      const cfg = st.settings;
      const printers = st.printers.map((p) => {
        const dot = p.online ? 'ok' : 'warn';
        return `<label class="setup-row" style="gap:8px;cursor:pointer;">
          <span style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;">
            <input type="radio" name="printPrinter" value="${e(p.name)}" ${cfg.printer === p.name ? 'checked' : ''}>
            <span><strong>${e(p.name)}</strong>${p.name === st.defaultPrinter ? ' <span style="opacity:.6;">(System-Standard)</span>' : ''}
            <br><span style="opacity:.65;font-size:11px;">${e(p.device || '', 160)}</span></span>
          </span>
          <span class="setup-check ${dot}">${e(STATE_LABEL[p.state] || p.state, 20)}${p.reason ? ' — ' + e(p.reason, 80) : ''}</span>
        </label>`;
      }).join('');
      const missing = cfg.printer && !st.selectedListed
        ? `<div class="setup-status error">Der gewählte Drucker „${e(cfg.printer)}“ wird von CUPS nicht mehr gelistet — Drucken ist nicht verfügbar.</div>` : '';
      const usage = Object.entries(st.usage).map(([a, n]) => `${e(a, 40)}: ${Number(n) || 0} / ${Number(cfg.dailyPageCap) || 0}`).join(' · ');
      const jobs = st.jobs.length ? `<table class="setup-table" style="width:100%;font-size:12px;border-collapse:collapse;">
        <tr style="text-align:left;opacity:.7;"><th>Zeit</th><th>App</th><th>Titel</th><th>Seiten</th><th>Job</th><th>Status</th></tr>
        ${st.jobs.map((j) => `<tr>
          <td>${e(fmtTime(j.at), 30)}</td><td>${e(j.app, 40)}</td><td>${e(j.title, 60)}</td>
          <td>${Number(j.pages) || 0}${Number(j.copies) > 1 ? ' ×' + Number(j.copies) : ''}</td>
          <td>${e(j.jobId || '', 40)}</td>
          <td><span class="setup-check ${j.status === 'failed' ? 'warn' : 'ok'}">${e(JOB_LABEL[j.status] || j.status, 30)}</span>${j.error ? `<br><span style="opacity:.75;">${e(j.error, 160)}</span>` : ''}</td>
        </tr>`).join('')}</table>` : '<div class="setup-hint">Noch keine Druckaufträge.</div>';

      return `
        <div class="setup-pane-intro">
          <h3>🖨️ Drucker</h3>
          <p>Der Drucker an diesem Rechner (CUPS). Apps drucken mit <code>ctx.print.pdf</code> &mdash; nur wenn du hier einen Drucker gewählt, das Drucken eingeschaltet und die App erlaubt hast.</p>
          <span class="setup-intro-apps">Eine App sieht nur <code>ctx.print.status()</code> (verfügbar, online, Restseiten heute) &mdash; nie die Einstellungen.</span>
        </div>
        <div class="setup-section">
          <div class="setup-section-title" style="display:flex;align-items:center;gap:10px;">Erkannte Drucker
            <button class="setup-btn" style="font-size:11px;padding:3px 10px;margin-left:auto;" data-print="refresh">Neu suchen</button></div>
          ${st.cups ? '' : `<div class="setup-status error">${e(st.error || 'CUPS ist nicht installiert.', 300)}</div>`}
          ${st.cups && st.error ? `<div class="setup-status error">${e(st.error, 300)}</div>` : ''}
          ${st.printers.length ? printers : (st.cups ? '<div class="setup-hint">CUPS kennt keinen Drucker. Richte einen in den Systemeinstellungen oder unter http://localhost:631 ein.</div>' : '')}
          ${missing}
        </div>
        <div class="setup-section">
          <div class="setup-section-title">Einstellungen</div>
          <label class="setup-label" style="display:flex;align-items:center;gap:6px;margin:6px 0;"><input type="checkbox" id="printEnabled" ${cfg.enabled ? 'checked' : ''}> Drucken für Apps einschalten</label>
          <label class="setup-label" style="display:flex;align-items:center;gap:6px;margin:6px 0;"><input type="checkbox" id="printDuplex" ${cfg.duplex ? 'checked' : ''}> Standardmäßig beidseitig (lange Kante)</label>
          <label class="setup-label" style="display:block;margin-top:8px;">Erlaubte Apps (Namen, durch Komma getrennt)
            <input type="text" id="printApps" value="${e(cfg.allowedApps.join(', '), 400)}" style="display:block;margin-top:4px;padding:6px;width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);">
          </label>
          <label class="setup-label" style="display:block;margin-top:8px;">Seitenlimit pro App und Tag (Seiten × Kopien)
            <input type="number" id="printCap" min="0" max="1000" value="${Number(cfg.dailyPageCap) || 0}" style="display:block;margin-top:4px;padding:6px;width:120px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);">
          </label>
          <div class="setup-hint">Heute: ${usage || '—'}. Das Limit gilt ab Mitternacht neu.</div>
          <div class="setup-btn-row" style="margin-top:10px;">
            <button class="setup-btn" data-print="test" ${cfg.printer && st.selectedListed ? '' : 'disabled'}>Testseite drucken</button>
            <div style="flex:1;"></div>
            <button class="setup-btn setup-btn-primary" data-print="save">Speichern</button>
          </div>
          <div class="setup-status ${S.error ? 'error' : 'ok'}">${S.error ? e(S.error, 300) : (S.notice ? e(S.notice, 200) : '')}</div>
        </div>
        <div class="setup-section">
          <div class="setup-section-title">Letzte Druckaufträge</div>
          ${jobs}
        </div>`;
    }

    function render() {
      if (!paneEl || !paneEl.isConnected) return;
      paneEl.innerHTML = html();
      paneEl.querySelector('[data-print="refresh"]')?.addEventListener('click', () => { S.error = S.notice = null; sendWs({ type: 'app:print:get' }); });
      paneEl.querySelector('[data-print="save"]')?.addEventListener('click', () => {
        const printer = paneEl.querySelector('input[name="printPrinter"]:checked')?.value || null;
        const apps = (paneEl.querySelector('#printApps')?.value || '').split(/[\s,;]+/).filter(Boolean);
        S.error = S.notice = null;
        sendWs({ type: 'app:print:save', settings: {
          printer,
          enabled: !!paneEl.querySelector('#printEnabled')?.checked,
          duplex: !!paneEl.querySelector('#printDuplex')?.checked,
          allowedApps: apps,
          dailyPageCap: Number(paneEl.querySelector('#printCap')?.value),
        } });
      });
      paneEl.querySelector('[data-print="test"]')?.addEventListener('click', async () => {
        const name = S.state?.settings?.printer;
        if (!(await showConfirm(`Eine Testseite auf „${cap(name, 80)}“ drucken?`, { confirmLabel: 'Testseite drucken' }))) return;
        S.error = S.notice = null;
        sendWs({ type: 'app:print:test' });
      });
    }

    function onState(msg) {
      if (msg.state) S.state = msg.state;
      S.error = msg.error || null;
      S.notice = msg.notice || null;
      render();
    }
    // The Setup tab was opened: paint what we have, ask for the rest.
    function open(pane) { paneEl = pane; render(); sendWs({ type: 'app:print:get' }); }
    return { open, onState };
  })();

  // --- Platform Setup ---

  function showSetup(initialTab) {
    const cfg = apps.db.config || {};
    const backdrop = document.createElement('div');
    backdrop.className = 'alert-modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'alert-modal setup-modal';
    const origin = window.location.origin;
    const redirectUri = origin + '/pro/auth/google/callback';

    function genPassword() {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      let pw = '';
      const arr = new Uint8Array(16);
      crypto.getRandomValues(arr);
      for (let i = 0; i < 16; i++) pw += chars[arr[i] % chars.length];
      return pw;
    }

    function copyText(text, btnEl) {
      navigator.clipboard.writeText(text).then(() => {
        const orig = btnEl.textContent;
        btnEl.textContent = 'Copied!';
        setTimeout(() => { btnEl.textContent = orig; }, 1500);
      });
    }

    const accountsBadge = (() => { const c = apps.connectivity; if (c && c.status === 'done') { const issues = (c.results || []).filter(r => r.issues && r.issues.length > 0); const total = issues.reduce((n, r) => n + r.issues.length, 0); if (total > 0) return '<span class="setup-nav-badge">' + total + '</span>'; } return ''; })();
    const tgBadge = (() => { const n = tgAwaitingApps().length; return n > 0 ? '<span class="setup-nav-badge" id="tgNavBadge">' + n + '</span>' : '<span class="setup-nav-badge" id="tgNavBadge" style="display:none;"></span>'; })();
    modal.innerHTML = `
      <button class="setup-close-x" aria-label="Close" title="Close">&times;</button>
      <div class="setup-shell">
      <nav class="setup-nav">
        <div class="setup-nav-title"><span class="setup-nav-title-icon">&#9881;</span>Platform Setup</div>
        <div class="setup-nav-group-label">Core</div>
        <button class="setup-nav-item ${initialTab === 'accounts' ? '' : 'active'}" data-tab="system"><span class="setup-nav-ico">&#9881;</span><span class="setup-nav-label">System</span><span class="setup-nav-status" data-status-tab="system"></span></button>
        <button class="setup-nav-item ${initialTab === 'accounts' ? 'active' : ''}" data-tab="accounts"><span class="setup-nav-ico">&#9673;</span><span class="setup-nav-label">Health</span>${accountsBadge}</button>
        <button class="setup-nav-item" data-tab="extras"><span class="setup-nav-ico">&#10010;</span><span class="setup-nav-label">Extras</span><span class="setup-nav-status" data-status-tab="extras"></span></button>
        <button class="setup-nav-item" data-tab="remote"><span class="setup-nav-ico">&#8644;</span><span class="setup-nav-label">Remote</span><span class="setup-nav-status" data-status-tab="remote"></span></button>
        <button class="setup-nav-item" data-tab="print"><span class="setup-nav-ico">&#128424;</span><span class="setup-nav-label">Drucker</span></button>
        <div class="setup-nav-group-label">Accounts</div>
        <button class="setup-nav-item" data-tab="google"><span class="setup-nav-ico">&#71;</span><span class="setup-nav-label">Google</span><span class="setup-nav-status" data-status-tab="google"></span></button>
        <button class="setup-nav-item" data-tab="email"><span class="setup-nav-ico">&#9993;</span><span class="setup-nav-label">Email</span><span class="setup-nav-status" data-status-tab="email"></span></button>
        <button class="setup-nav-item" data-tab="telegram"><span class="setup-nav-ico">&#9992;</span><span class="setup-nav-label">Telegram</span>${tgBadge}<span class="setup-nav-status" data-status-tab="telegram"></span></button>
        <button class="setup-nav-item" data-tab="whatsapp"><span class="setup-nav-ico">&#9742;</span><span class="setup-nav-label">WhatsApp</span><span class="setup-nav-status" data-status-tab="whatsapp"></span></button>
        <div class="setup-nav-group-label">Automation</div>
        <button class="setup-nav-item" data-tab="cron"><span class="setup-nav-ico">&#9201;</span><span class="setup-nav-label">Cron</span></button>
        <button class="setup-nav-item" data-tab="tools-access"><span class="setup-nav-ico">&#9874;</span><span class="setup-nav-label">Tools &amp; Access</span></button>
        <div class="setup-nav-group-label">AI</div>
        <button class="setup-nav-item" data-tab="ai-config"><span class="setup-nav-ico">&#10022;</span><span class="setup-nav-label">AI Config</span><span class="setup-nav-status" data-status-tab="ai-config"></span></button>
        <button class="setup-nav-item" data-tab="memory"><span class="setup-nav-ico">&#9106;</span><span class="setup-nav-label">Memory</span><span class="setup-nav-status" data-status-tab="memory"></span></button>
      </nav>
      <div class="setup-main">
      <div id="setupChecklist" class="setup-checklist" style="display:none;"></div>
      <div class="setup-tab-content">

        <!-- SYSTEM TAB -->
        <div class="setup-pane ${initialTab === 'accounts' ? '' : 'active'}" id="setupPane-system">
          <div class="setup-pane-intro">
            <h3>System &amp; Database</h3>
            <p>The foundation every Vistaclair app runs on. Connect a MariaDB admin account once here and the platform handles the rest &mdash; you never touch SQL setup per app.</p>
            <span class="setup-intro-apps">Each app you build gets its <strong>own isolated database</strong>, provisioned automatically and reached through the <code>db.*</code> bridge &mdash; no connection strings, no credentials in app code.</span>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">System</div>
            <div class="setup-row"><span>Sudo access</span><span id="setupSudo" class="setup-check loading">checking...</span></div>
            <div class="setup-hint">Recommended: the user running vistaclair should have passwordless sudo.</div>
            <div class="setup-row"><span>MariaDB</span><span id="setupMariadb" class="setup-check loading">checking...</span></div>
            <div id="setupInstallWrap" style="display:none;">
              <div class="setup-hint">MariaDB is not installed. Install it now?</div>
              <button id="setupInstallBtn" class="setup-action-btn">Install MariaDB</button>
            </div>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">Database Connection</div>
            <div id="setupAutoWrap" style="display:none;">
              <div id="setupAutoHint" class="setup-hint"></div>
              <div class="app-create-form">
                <label>Username<input id="setupAutoUser" type="text" value="vistaclair"></label>
                <label>Password<div style="display:flex;gap:6px;align-items:center;"><input id="setupAutoPass" type="text" value="${escHtml(cfg.password || genPassword())}" style="flex:1;" autocomplete="off"><button id="setupAutoRegen" class="setup-btn" type="button" title="Generate new password">&#x21bb;</button></div></label>
              </div>
              <div id="setupAutoStatus" class="setup-status"></div>
              <button id="setupAutoBtn" class="setup-action-btn">Setup &amp; Connect</button>
            </div>
            <div id="setupManualWrap">
              <div id="setupManualHint" class="setup-hint">Admin account for per-app databases. Needs <code style="font-size:11px;">GRANT OPTION</code> on <code style="font-size:11px;">*.*</code>.</div>
              <div class="app-create-form">
                <label>Host<input id="dbCfgHost" type="text" value="${escHtml(cfg.host || 'localhost')}" placeholder="localhost"></label>
                <label>Port<input id="dbCfgPort" type="number" value="${cfg.port || 3306}" placeholder="3306"></label>
                <label>User<input id="dbCfgUser" type="text" value="${escHtml(cfg.user || 'vistaclair')}" placeholder="vistaclair"></label>
                <label>Password<div style="display:flex;gap:6px;align-items:center;"><input id="dbCfgPass" type="text" value="${escHtml(cfg.password || genPassword())}" placeholder="password" autocomplete="off" style="flex:1;"><button id="setupManualRegen" class="setup-btn" type="button" title="Generate new password">&#x21bb;</button></div></label>
              </div>
              <div id="setupManualSql" class="setup-sql-block" style="display:none;">
                <div class="setup-hint" style="margin-bottom:6px;">Run this SQL as root in MariaDB:</div>
                <pre id="setupManualSqlCode"></pre>
                <div class="setup-btn-row" style="margin-top:6px;"><button id="setupManualCopyBtn" class="setup-btn" type="button">Copy SQL</button><span id="setupManualCopied" style="font-size:11px;color:var(--green);display:none;">Copied!</span></div>
              </div>
              <div id="dbCfgStatus" class="setup-status">${apps.db.connected ? '<span class="setup-check ok">Connected</span>' : ''}</div>
              <div class="setup-btn-row">
                <button class="db-cfg-test setup-btn">Test</button>
                ${apps.db.connected ? '<button class="db-cfg-disconnect setup-btn setup-btn-danger">Disconnect</button>' : ''}
                <div style="flex:1;"></div>
                <button class="db-cfg-save setup-btn setup-btn-primary">Connect & Save</button>
              </div>
            </div>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">App Databases</div>
            <div class="setup-hint">Each app gets its own isolated database, provisioned automatically.</div>
            <div id="setupAppDbs" class="setup-app-dbs"><span class="setup-check loading">loading...</span></div>
          </div>
        </div>

        <!-- ACCOUNTS TAB -->
        <div class="setup-pane ${initialTab === 'accounts' ? 'active' : ''}" id="setupPane-accounts">
          <div class="setup-pane-intro">
            <h3>Account Health</h3>
            <p>A single dashboard showing whether every connected service &mdash; database, Google, email, Telegram &mdash; is actually working. Catch a broken credential here before an app does.</p>
            <span class="setup-intro-apps">When a check is green, any app that uses that capability is guaranteed a live connection. Red flags here are the first thing to fix when an app misbehaves.</span>
          </div>
          <div class="setup-section">
            <div class="setup-section-title" style="display:flex;align-items:center;gap:10px;">
              Account Health
              <button class="setup-btn" style="font-size:11px;padding:3px 10px;margin-left:auto;" ${vcAct.attrs('click', 'dashboard.sendWs', [{ type: 'app:setup:connectivityCheck' }])}>Recheck</button>
            </div>
            <div class="setup-hint">Status of all connected accounts. Issues must be resolved for apps to function correctly.</div>
            <div id="setupAccountHealth" class="setup-account-health"></div>
          </div>
        </div>

        <!-- EXTRAS TAB -->
        <!-- REMOTE TAB (master/slave publishing) — rendered by publish.js -->
        <div class="setup-pane" id="setupPane-remote"></div>
        <!-- PRINT TAB — rendered by printSetup -->
        <div class="setup-pane" id="setupPane-print"></div>

        <div class="setup-pane" id="setupPane-extras">
          <div class="setup-pane-intro">
            <h3>Extras</h3>
            <p>Optional heavyweight components that don't ship with the platform because of their size. Install what you need with one click &mdash; each runs in the background with live progress and keeps going even if you reload this page.</p>
            <span class="setup-intro-apps">Once a component shows a checkmark, every app can use the capability it provides &mdash; no per-app setup.</span>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">Installable Components</div>
            <div id="setupExtrasList"><span class="setup-check loading">loading...</span></div>
          </div>
        </div>

        <!-- GOOGLE TAB -->
        <div class="setup-pane" id="setupPane-google">
          <div class="setup-pane-intro">
            <h3>Google</h3>
            <p>Connect Google once at the platform level &mdash; OAuth credentials, signed-in accounts, and calendar sync &mdash; instead of wiring the OAuth dance into every app.</p>
            <span class="setup-intro-apps">Apps call Gmail and Calendar through <code>auth.google.getToken</code> and the <code>calendar.*</code> bridge using already-authorized accounts &mdash; no consent screens, token refresh, or secrets in app code.</span>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">Google OAuth Setup</div>
            <div class="setup-hint">Follow these steps to set up Google API access for all apps.</div>

            <div class="setup-step"><div class="setup-step-num">1</div><div class="setup-step-body"><strong>Create a Google Cloud Project</strong><br><a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener noreferrer">console.cloud.google.com/projectcreate</a> &mdash; any name will do.</div></div>

            <div class="setup-step"><div class="setup-step-num">2</div><div class="setup-step-body"><strong>Enable the Gmail and Calendar APIs</strong><br><a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener noreferrer">Gmail API</a> &middot; <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noopener noreferrer">Google Calendar API</a> &middot; <a href="https://console.cloud.google.com/apis/library" target="_blank" rel="noopener noreferrer">Library</a></div></div>

            <div class="setup-step"><div class="setup-step-num">3</div><div class="setup-step-body"><strong>Branding</strong> (Google Auth Platform)<br><a href="https://console.cloud.google.com/auth/branding" target="_blank" rel="noopener noreferrer">console.cloud.google.com/auth/branding</a><br>Set an app name and a support email.</div></div>

            <div class="setup-step"><div class="setup-step-num">4</div><div class="setup-step-body"><strong>Audience</strong><br><a href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noopener noreferrer">console.cloud.google.com/auth/audience</a><br>User type <strong>External</strong>. Under <strong>Test users</strong>, add your Gmail address. Data access (<a href="https://console.cloud.google.com/auth/scopes" target="_blank" rel="noopener noreferrer">scopes</a>): nothing to add &mdash; Vistaclair asks at sign-in.</div></div>

            <div class="setup-step"><div class="setup-step-num">5</div><div class="setup-step-body"><strong>Create the OAuth client</strong><br><a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener noreferrer">console.cloud.google.com/auth/clients</a><br><strong>Create client</strong>, type = <strong>Web application</strong>. Add the JavaScript origin and redirect URI shown below.</div></div>

            <div class="setup-uri-box">
              <div style="font-size:11px;font-weight:600;margin-bottom:8px;">URIs to add in Google Cloud Console:</div>
              <div class="setup-uri-row">
                <span class="setup-uri-label">JS Origin</span>
                <span class="setup-uri-value" id="setupGoogleOrigin">${escHtml(origin)}</span>
                <button class="setup-copy-btn" id="setupCopyOrigin">Copy</button>
              </div>
              <div class="setup-uri-row">
                <span class="setup-uri-label">Redirect URI</span>
                <span class="setup-uri-value" id="setupGoogleRedirect">${escHtml(redirectUri)}</span>
                <button class="setup-copy-btn" id="setupCopyRedirect">Copy</button>
              </div>
              <div id="setupGooglePublic"></div>
              <div style="font-size:11px;color:var(--orange,#c07020);margin-top:6px;">Without the redirect URI you will get a <strong>redirect_uri_mismatch</strong> error.</div>
            </div>

            <div class="setup-step"><div class="setup-step-num">6</div><div class="setup-step-body"><strong>Paste Your Credentials Here</strong><br>Google shows a new client secret <strong>only once</strong>, at creation &mdash; copy or download it then. If it is lost, open the client and use <strong>Add secret</strong>.</div></div>

            <div class="app-create-form">
              <label>Client ID
                <div class="setup-password-wrap">
                  <input id="oauthClientId" type="text" placeholder="xxxx.apps.googleusercontent.com">
                  <button class="setup-eye-btn" id="oauthIdToggle" type="button" title="Show/hide saved value" style="display:none;">&#x1f441;</button>
                </div>
              </label>
              <label>Client Secret
                <div class="setup-password-wrap">
                  <input id="oauthClientSecret" type="password" placeholder="GOCSPX-xxxx" autocomplete="off">
                  <button class="setup-eye-btn" id="oauthSecretToggle" type="button" title="Show/hide saved value" style="display:none;">&#x1f441;</button>
                </div>
              </label>
            </div>
            <div id="oauthSavedIndicator" style="display:none;font-size:12px;margin:-4px 0 8px;"></div>
            <div id="oauthStatus" class="setup-status"></div>
            <div class="setup-btn-row">
              <button id="oauthSaveBtn" class="setup-btn setup-btn-primary">Save Credentials</button>
              <button id="oauthTestBtn" class="setup-btn">Test Setup</button>
            </div>
            <div id="oauthTestResult"></div>

            <div class="setup-warning"><strong>Recommended:</strong> on the <a href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noopener noreferrer">Audience</a> page click <strong>Publish app</strong> (In production). This stops the 7-day sign-out of Testing mode. The &ldquo;Google hasn&rsquo;t verified this app&rdquo; screen is expected for personal use: <strong>Advanced &rarr; Go to &lt;app&gt;</strong>.</div>
            <div class="setup-section-title" style="margin-top:16px;">Other Google APIs (API keys, not sign-in)</div>
            <div class="setup-hint">Used through keys set in Apps &rarr; AI Config / the Models page, not through the sign-in above.</div>
            <ul class="setup-hint" style="margin:6px 0 6px 18px;padding:0;">
                <li><a href="https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com" target="_blank" rel="noopener noreferrer">Generative Language API</a> &mdash; Gemini, <code>google</code> key (or a key from <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Google AI Studio</a>)</li>
                <li><a href="https://console.cloud.google.com/apis/library/translate.googleapis.com" target="_blank" rel="noopener noreferrer">Cloud Translation API</a> &mdash; <code>google-translate</code> key, falls back to <code>google</code></li>
                <li><code>google-maps</code> key (falls back to <code>google-translate</code>, not <code>google</code>):
                  <ul style="margin:2px 0 0 16px;padding:0;">
                    <li><a href="https://console.cloud.google.com/apis/library/routes.googleapis.com" target="_blank" rel="noopener noreferrer">Routes API</a></li>
                    <li><a href="https://console.cloud.google.com/apis/library/geocoding-backend.googleapis.com" target="_blank" rel="noopener noreferrer">Geocoding API</a></li>
                    <li><a href="https://console.cloud.google.com/apis/library/places.googleapis.com" target="_blank" rel="noopener noreferrer">Places API (New)</a></li>
                    <li><a href="https://console.cloud.google.com/apis/library/street-view-image-backend.googleapis.com" target="_blank" rel="noopener noreferrer">Street View Static API</a></li>
                    <li><a href="https://console.cloud.google.com/apis/library/tile.googleapis.com" target="_blank" rel="noopener noreferrer">Map Tiles API</a></li>
                  </ul></li>
            </ul>
            <div class="setup-hint">Maps and Translation need a billing account.</div>
            <div class="setup-hint">If a key has API restrictions, tick each API on the key too: <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">APIs &amp; Services &rarr; Credentials</a>.</div>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">Connected Accounts</div>
            <div id="oauthAccounts" class="setup-app-dbs"></div>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">Calendar Sync</div>
            <div class="setup-hint">Select which calendars the platform calendar engine keeps synced. Apps read them via <code style="font-size:11px;">ctx.calendar</code> / the <code style="font-size:11px;">calendar.*</code> bridge.</div>
            <div id="calendarSyncList"></div>
          </div>
        </div>

        <!-- EMAIL TAB -->
        <div class="setup-pane" id="setupPane-email">
          <div class="setup-pane-intro">
            <h3>Email</h3>
            <p>Register IMAP/SMTP mailboxes centrally, with credentials stored encrypted. The platform keeps each enabled account synced (IMAP IDLE push / Gmail incremental) so apps see new mail instantly.</p>
            <span class="setup-intro-apps">Apps read and send mail through <code>ctx.email</code> / the <code>email.*</code> bridge &mdash; they get parsed, synced messages without ever handling raw passwords or running their own mail loop.</span>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">Email Accounts (IMAP/SMTP)</div>
            <div class="setup-hint">Configure email accounts centrally. Apps access them via <code style="font-size:11px;">ctx.emailAccounts.getCredentials(email)</code>. Credentials are stored encrypted.</div>
            <div class="app-create-form">
              <label>Provider
                <select id="emailProvider" style="width:100%;padding:6px;font:inherit;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);">
                  <option value="">Select a provider...</option>
                  <option value="outlook">Outlook / Hotmail / Live</option>
                  <option value="yahoo">Yahoo Mail</option>
                  <option value="icloud">iCloud Mail</option>
                  <option value="protonmail">ProtonMail (Bridge)</option>
                  <option value="fastmail">Fastmail</option>
                  <option value="gmx">GMX</option>
                  <option value="zoho">Zoho Mail</option>
                  <option value="yandex">Yandex Mail</option>
                  <option value="aol">AOL Mail</option>
                  <option value="custom">Custom / Self-Hosted</option>
                </select>
              </label>
            </div>
            <div id="emailProviderHint" class="setup-provider-hint" style="display:none;"></div>
            <div class="app-create-form">
              <label>Email Address<input id="emailAddr" type="email" placeholder="user@example.com"></label>
              <label>Username (usually same as email)<input id="emailUser" type="text" placeholder="user@example.com"></label>
              <label>Password / App Password
                <div class="setup-password-wrap">
                  <input id="emailPass" type="password" placeholder="password or app password" autocomplete="off">
                  <button class="setup-eye-btn" id="emailPassToggle" type="button">&#x1f441;</button>
                </div>
              </label>
              <div style="display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:end;">
                <label>IMAP Server<input id="emailImapHost" type="text" placeholder="imap.example.com"></label>
                <label>Port<input id="emailImapPort" type="number" value="993" style="width:70px;"></label>
                <label style="display:flex;align-items:center;gap:4px;padding-bottom:8px;"><input id="emailImapTls" type="checkbox" checked> TLS</label>
              </div>
              <div style="display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:end;">
                <label>SMTP Server<input id="emailSmtpHost" type="text" placeholder="smtp.example.com"></label>
                <label>Port<input id="emailSmtpPort" type="number" value="587" style="width:70px;"></label>
                <label style="display:flex;align-items:center;gap:4px;padding-bottom:8px;"><input id="emailSmtpTls" type="checkbox" checked> TLS</label>
              </div>
            </div>
            <div id="emailTestStatus" class="setup-status"></div>
            <div class="setup-btn-row">
              <button id="emailTestBtn" class="setup-btn">Test Connection</button>
              <div style="flex:1;"></div>
              <button id="emailSaveBtn" class="setup-btn setup-btn-primary">Save Account</button>
            </div>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">Configured Accounts</div>
            <div id="emailAccountsList"></div>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">Sync Engine</div>
            <div class="setup-hint">The platform email engine keeps enabled accounts synced (IMAP IDLE push / Gmail incremental). Apps read mail via <code style="font-size:11px;">ctx.email</code> / the <code style="font-size:11px;">email.*</code> bridge.</div>
            <div id="emailEngineVector" style="font-size:12px;margin-bottom:8px;"></div>
            <div id="emailEngineList"></div>
          </div>
        </div>

        <!-- TELEGRAM TAB -->
        <div class="setup-pane" id="setupPane-telegram">
          <div class="setup-pane-intro">
            <h3>Telegram</h3>
            <p>Give the platform a control bot, or hand any app its own bot. This is the one channel that reaches you when the dashboard tab is closed.</p>
            <span class="setup-intro-apps">Apps send and receive messages through <code>ctx.telegram.*</code> / <code>telegram.send</code> &mdash; instant push notifications, chat-based interfaces, and Telegram WebApps, with tokens stored encrypted and access restricted by default.</span>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">Vistaclair Control Bot</div>
            <div class="setup-hint">A Telegram bot for <strong>Vistaclair itself</strong> (not an app). Create a bot with <a href="https://t.me/BotFather" target="_blank">@BotFather</a> (<code style="font-size:11px;">/newbot</code>), paste its token, and save. <strong>Restricted by default</strong> and claimed with a one-time code: after saving, press <em>Claim this bot</em> below and open the link (or send <code>/start claim_&lt;code&gt;</code> in a private chat with the bot) &mdash; that Telegram user becomes the owner, and nobody else is ever served. Messages to an unclaimed bot do nothing. Every control action needs restricted mode, a claimed owner and a private chat; turn restriction off and the bot offers no buttons at all. There is no button that hands out the auth token &mdash; log in to the dashboard with the Telegram QR login instead. Token stored encrypted.</div>
            <div class="app-create-form">
              <label>Bot Token
                <div class="setup-password-wrap">
                  <input id="ctrlTgToken" type="password" placeholder="123456789:ABCdef..." autocomplete="off">
                  <button class="setup-eye-btn" id="ctrlTgTokenToggle" type="button">&#x1f441;</button>
                </div>
              </label>
            </div>
            <div id="ctrlTgSetStatus" class="setup-status"></div>
            <div class="setup-btn-row">
              <div style="flex:1;"></div>
              <button id="ctrlTgSaveBtn" class="setup-btn setup-btn-primary">Save Control Bot</button>
            </div>
            <div id="ctrlTgBotInfo" style="margin-top:8px;"></div>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">Telegram Bots (Per-App)</div>
            <div id="tgAwaitingCallout"></div>
            <div class="setup-hint">Give an app its own Telegram bot. Create a bot with <a href="https://t.me/BotFather" target="_blank">@BotFather</a> (<code style="font-size:11px;">/newbot</code>), copy the token it gives you, pick the app below, and save. Apps send/receive via <code style="font-size:11px;">ctx.telegram.*</code> or <code style="font-size:11px;">Bridge.call('telegram.send')</code>. Tokens are stored encrypted. This is the only channel that reaches you when the dashboard tab is closed.</div>
            <div class="app-create-form">
              <label>App
                <select id="tgApp" style="width:100%;padding:6px;font:inherit;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);"></select>
              </label>
              <label>Bot Token
                <div class="setup-password-wrap">
                  <input id="tgToken" type="password" placeholder="123456789:ABCdef..." autocomplete="off">
                  <button class="setup-eye-btn" id="tgTokenToggle" type="button">&#x1f441;</button>
                </div>
              </label>
            </div>
            <div id="tgSetStatus" class="setup-status"></div>
            <div class="setup-btn-row">
              <div style="flex:1;"></div>
              <button id="proTgSaveBtn" class="setup-btn setup-btn-primary">Save Bot</button>
            </div>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">Configured Bots</div>
            <div id="tgBotsList"></div>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">Public URL (optional)</div>
            <div class="setup-hint">Needed only for Telegram <strong>WebApps</strong> and webhook delivery. Leave empty to use long-polling (works with no public URL). While the URL is unreachable (tunnel down) bots fall back to long-polling on their own. If set, use the same public HTTPS URL you already expose Vistaclair on (your ngrok / cloudflare / reverse-proxy URL). Google sign-in links use it too: the same URL + <code>/pro/auth/google/callback</code> must be registered as a redirect URI in the Google OAuth client (Setup &rarr; Google shows both).</div>
            <div class="app-create-form">
              <label>Base URL<input id="tgPublicUrl" type="text" placeholder="https://your-tunnel.example.com"></label>
            </div>
            <div id="tgPublicUrlStatus" class="setup-status"></div>
            <div class="setup-btn-row">
              <div style="flex:1;"></div>
              <button id="tgPublicUrlBtn" class="setup-btn">Save Public URL</button>
            </div>
          </div>
        </div>

        <!-- WHATSAPP TAB -->
        <div class="setup-pane" id="setupPane-whatsapp">
          <div class="setup-pane-intro">
            <h3>WhatsApp</h3>
            <p>Give any app its own WhatsApp Business number via the <strong>Cloud API</strong>. Inbound is webhook-only, so a public HTTPS URL is required (you paste the callback below into Meta).</p>
            <span class="setup-intro-apps">Apps send and receive through <code>ctx.whatsapp.*</code> / <code>whatsapp.send</code> &mdash; text, reply buttons, list menus, CTA buttons, media &mdash; signature-symmetric with <code>ctx.telegram</code>. Tokens stored encrypted, access restricted by default.</span>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">WhatsApp Cloud API (Per-App)</div>
            <div class="setup-hint">
              <strong>1. Create a Meta App</strong> &mdash; go to <a href="https://developers.facebook.com/apps" target="_blank">Meta for Developers</a>, click <strong>Create App</strong>, choose <strong>Business</strong> type, and add the <strong>WhatsApp</strong> product. Note the <strong>App Secret</strong> from <strong>App Settings &rarr; Basic</strong>.
              <br><br>
              <strong>2. Get a permanent Access Token (System User)</strong> &mdash; the temporary token on the API Setup page expires in 24&nbsp;h. For a permanent token:
              <ol style="margin:4px 0 4px 18px;font-size:12px;line-height:1.5;">
                <li>Open <a href="https://business.facebook.com/settings/system-users" target="_blank">Business Settings &rarr; System Users</a>.</li>
                <li>Click <strong>Add</strong> to create a System User (name it anything, e.g. &ldquo;whatsapp-bot&rdquo;). Choose <strong>Admin</strong> role.</li>
                <li>Click <strong>Add Assets</strong>, select <strong>Apps</strong>, pick your Meta app, and enable <strong>Full Control</strong>.</li>
                <li>Click <strong>Generate New Token</strong>, select the Meta app, and grant these permissions:<br>
                  <code style="font-size:10px;">whatsapp_business_management</code>, <code style="font-size:10px;">whatsapp_business_messaging</code></li>
                <li>Copy the generated token &mdash; this is your permanent <strong>Access Token</strong>.</li>
              </ol>
              <strong>3. Get the Phone Number ID</strong> &mdash; in the Meta app, go to <strong>WhatsApp &rarr; API Setup</strong>. The <strong>Phone number ID</strong> is shown under the selected phone number (a numeric string, not the phone number itself).
              <br><br>
              <strong>4. Save here</strong> &mdash; pick the app below, paste the three values, and save. <strong>A Callback URL and Verify Token are generated and shown under &ldquo;Configured Accounts&rdquo; below.</strong>
              <br><br>
              <strong>5. Configure the webhook</strong> &mdash; in the Meta app go to <strong>WhatsApp &rarr; Configuration &rarr; Webhooks</strong> (<a href="https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks" target="_blank">docs</a>), paste the <strong>Callback URL</strong> and <strong>Verify Token</strong> from below, click <strong>Verify and save</strong>, then click <strong>Manage</strong> and subscribe to the <code style="font-size:11px;">messages</code> field.
              <br><br>
              <span style="opacity:.7;">Credentials stored encrypted.</span>
            </div>
            <div class="app-create-form">
              <label>App
                <select id="waApp" style="width:100%;padding:6px;font:inherit;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);"></select>
              </label>
              <label>Phone Number ID
                <div style="display:flex;gap:4px;align-items:center;">
                  <input id="waPhoneNumberId" type="text" placeholder="123456789012345" autocomplete="off" style="flex:1;">
                  <button class="setup-btn wa-field-copy-btn" style="font-size:10px;padding:4px 8px;white-space:nowrap;display:none;" data-copy-from="waPhoneNumberId" type="button">Copy</button>
                </div>
              </label>
              <label>Access Token
                <div class="setup-password-wrap">
                  <input id="waAccessToken" type="password" placeholder="EAAG..." autocomplete="off">
                  <button class="setup-eye-btn" id="waAccessTokenToggle" type="button">&#x1f441;</button>
                </div>
                <div id="waAccessTokenHint" style="font-size:10px;color:var(--muted,#888);margin-top:2px;display:none;"></div>
              </label>
              <label>App Secret
                <div class="setup-password-wrap">
                  <input id="waAppSecret" type="password" placeholder="32-char app secret" autocomplete="off">
                  <button class="setup-eye-btn" id="waAppSecretToggle" type="button">&#x1f441;</button>
                </div>
                <div id="waAppSecretHint" style="font-size:10px;color:var(--muted,#888);margin-top:2px;display:none;"></div>
              </label>
              <label>WABA ID <span style="font-weight:normal;opacity:.6;">(optional)</span>
                <div style="display:flex;gap:4px;align-items:center;">
                  <input id="waWabaId" type="text" placeholder="WhatsApp Business Account ID" autocomplete="off" style="flex:1;">
                  <button class="setup-btn wa-field-copy-btn" style="font-size:10px;padding:4px 8px;white-space:nowrap;display:none;" data-copy-from="waWabaId" type="button">Copy</button>
                </div>
              </label>
            </div>
            <div id="waSetStatus" class="setup-status"></div>
            <div class="setup-btn-row">
              <div style="flex:1;"></div>
              <button id="waSaveBtn" class="setup-btn setup-btn-primary">Save Account</button>
            </div>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">Configured Accounts</div>
            <div id="waAccountsList"></div>
          </div>
        </div>

        <!-- CRON TAB -->
        <div class="setup-pane" id="setupPane-cron">
          <div class="setup-pane-intro">
            <h3>Cron</h3>
            <p>Schedule recurring work that survives restarts: call an app's API, run a shell command, or fire an AI prompt on a cron or plain-English schedule.</p>
            <span class="setup-intro-apps">Apps schedule their own background jobs via the <code>cron.*</code> bridge and receive results as <code>cron:result</code> events &mdash; one persistent platform scheduler runs them all, with each app's jobs cleaned up automatically when the app is deleted.</span>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">Platform Cron Jobs</div>
            <div class="setup-hint">Persistent scheduled tasks that survive restarts. Can call app APIs, run shell commands, or trigger AI prompts.</div>
            <div id="cronJobsList"></div>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">Add Cron Job</div>
            <div class="app-create-form">
              <label>Name<input id="cronName" type="text" placeholder="Refresh email every 5 min"></label>
              <label>Schedule
                <input id="cronSchedule" type="text" placeholder="*/5 * * * *  or  every 5 minutes">
                <div class="setup-hint" style="margin:4px 0 0;font-size:11px;">Cron: <code>*/5 * * * *</code> (5min), <code>0 8 * * MON-FRI</code> (weekdays 8am), <code>0 */6 * * *</code> (6h) &mdash; or simple: <code>every 30 seconds</code></div>
              </label>
              <label>Target Type
                <select id="cronTargetType" style="width:100%;padding:6px;font:inherit;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);">
                  <option value="app-api">App API</option>
                  <option value="shell">Shell Command</option>
                  <option value="ai">AI Prompt</option>
                  <option value="tool">App Tool</option>
                </select>
              </label>
              <div id="cronTargetFields"></div>
            </div>
            <div id="cronAddStatus" class="setup-status"></div>
            <div class="setup-btn-row">
              <div style="flex:1;"></div>
              <button id="cronAddBtn" class="setup-btn setup-btn-primary">Add Job</button>
            </div>
          </div>
        </div>

        <!-- TOOLS & ACCESS TAB -->
        <div class="setup-pane" id="setupPane-tools-access">
          <div class="setup-pane-intro">
            <h3>Tools &amp; Access <button class="help-info-btn" title="How tool exposure works" ${vcAct.attrs('click', 'appsModule.openHelpAt', ['help-tool-exposure'])}>?</button></h3>
            <p>Apps register tools that AI sessions, cron jobs, and other apps can call. Each tool has an exposure level that controls who may call it &mdash; tools are never reachable from the internet.</p>
            <span class="setup-intro-apps">Apps register tools with <code>ctx.registerTools</code> and call other apps' tools with <code>ctx.tools.call(app, tool, args)</code>. Apps that expose tools beyond themselves are autostarted so their tools stay available.</span>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">Registered Tools</div>
            <div id="toolsAccessSummary"></div>
          </div>
          <div id="appDepsPanel"></div>
          <div class="setup-btn-row">
            <div style="flex:1;"></div>
            <button id="toolsAccessOpenBtn" class="setup-btn setup-btn-primary">Open Tools overview</button>
          </div>
        </div>

        <!-- AI CONFIG TAB -->
        <div class="setup-pane" id="setupPane-ai-config">
          <div class="setup-pane-intro">
            <h3>AI Config</h3>
            <p>Configure the platform's shared AI: the default model and the provider keys behind it. You can also change platform settings in plain English with the assistant below.</p>
            <span class="setup-intro-apps">Every app gets built-in AI over the bridge with no per-app keys &mdash; <code>ai.prompt</code> (text/reasoning), <code>ai.transcribe</code> (speech-to-text), <code>ai.tts</code> (speech), <code>ai.image</code> (image gen), <code>ai.translate</code> / <code>ai.detect</code> (translation &amp; language detection), <code>ai.route</code> / <code>ai.routeMatrix</code> / <code>ai.geocode</code> / <code>ai.places</code> (maps &amp; routing), <code>ai.webSearch</code> (live search), <code>ai.music.*</code> (local music gen), <code>memory.*</code> (knowledge store), and local <code>embed</code> for semantic search.</span>
          </div>
          <div class="setup-section">
            <div class="setup-section-title" style="background:linear-gradient(90deg,var(--purple,#9b59b6),var(--cyan,#1abc9c));-webkit-background-clip:text;-webkit-text-fill-color:transparent;">AI Configuration Assistant</div>
            <div class="setup-hint">Describe what you want to change in plain English. Examples:<br>&bull; "Add an IMAP account for work@company.com on mail.company.com"<br>&bull; "Create a cron job that calls my-dashboard /api/fetch-all every 10 minutes"<br>&bull; "Remove the yahoo account"<br>&bull; "Disable the email refresh cron job"</div>
            <div style="display:flex;gap:8px;">
              <textarea id="aiConfigInput" rows="2" style="flex:1;padding:8px;font:inherit;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);resize:vertical;" placeholder="Describe the change..."></textarea>
              <button id="aiConfigBtn" class="setup-btn setup-btn-primary" style="align-self:flex-end;">Apply</button>
            </div>
            <div id="aiConfigStatus" class="setup-status"></div>
            <div id="aiConfigLog" class="setup-ai-log" style="display:none;"></div>
            <div class="setup-hint" style="margin-top:10px;">
              <strong>Can do:</strong> Add/remove/update email accounts, manage cron jobs, update Google client ID.<br>
              <strong>Cannot:</strong> Reveal passwords, modify OAuth tokens, change DB settings, delete Google accounts.
            </div>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">AI default model</div>
            <div class="setup-hint">Model used by <code>ai.prompt</code> when an app omits <code>model</code> — including memory operations. Apps can override per call by passing a <code>model</code> name; Claude models honor the configured API key or subscription.</div>
            <label class="setup-label" style="display:block;margin-top:8px;">Default model
              <select id="directModelSelect" style="display:block;margin-top:4px;padding:8px;font:inherit;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);width:100%;max-width:320px;">
                <option value="">Loading models…</option>
              </select>
            </label>
            <div id="directModelClaudeAuth" class="setup-hint" style="margin-top:6px;"></div>
            <div id="directModelStatus" class="setup-status"></div>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">Media model defaults (<code>ai.tts</code>, <code>ai.transcribe</code>, <code>ai.image</code>, <code>ai.sfx</code>)</div>
            <div class="setup-hint">The model, voice and settings these calls use when an app passes none; an app's own <code>model</code> / <code>voice</code> / … always win. Horst re-reads every provider's model and voice lists daily and alerts you on Telegram when a default disappears (calls fall back to the built-in default meanwhile). The first &#9654; of a voice speaks a short sample through that model (metered); later plays are cached.</div>
            <div style="margin-top:8px;display:flex;gap:8px;align-items:center;">
              <button type="button" id="mediaRefreshBtn" class="setup-btn">Refresh model lists now</button>
              <span id="mediaRefreshInfo" class="setup-hint" style="margin:0;"></span>
            </div>
            <div id="mediaDefaultsRows" style="margin-top:10px;display:flex;flex-direction:column;gap:12px;"><div class="setup-hint">Loading media models…</div></div>
            <div id="mediaDefaultsStatus" class="setup-status"></div>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">Google Translate (<code>ai.translate</code> / <code>ai.detect</code>)</div>
            <div class="setup-hint">Text translation and language detection for apps via Google Cloud Translation. By default it reuses the shared <strong>google</strong> provider key from the Models page (the same key Gemini / <code>ai.image</code> use). Set a key below only if your Translate API lives on a different Google Cloud key. The Translation API must be enabled on that key's project, and the key must not be restricted to exclude it.</div>
            <div style="display:flex;gap:8px;margin-top:8px;max-width:480px;">
              <input type="password" id="translateKeyInput" style="flex:1;padding:8px;font:inherit;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);" placeholder="Paste Google Translate API key..." autocomplete="off">
              <button type="button" id="translateKeyToggle" class="setup-btn" title="Show/hide key">&#128065;</button>
              <button type="button" id="translateKeySave" class="setup-btn setup-btn-primary">Save</button>
            </div>
            <div id="translateKeyStatus" class="setup-status"></div>
            <div style="margin-top:10px;display:flex;gap:8px;align-items:center;">
              <button type="button" id="translateKeyTest" class="setup-btn">Test connection</button>
              <span class="setup-hint" style="margin:0;">Runs a live translation against Google and reports exactly what (if anything) needs fixing.</span>
            </div>
            <div id="translateKeyDiag" class="setup-translate-diag" style="display:none;margin-top:10px;padding:10px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg);font-size:13px;line-height:1.5;"></div>
            <details class="setup-translate-help" style="margin-top:10px;">
              <summary style="cursor:pointer;font-size:13px;opacity:.85;">Setup steps &amp; Google Cloud links</summary>
              <div style="margin-top:8px;font-size:13px;line-height:1.6;">
                <strong>One-time setup in Google Cloud:</strong>
                <ol style="margin:6px 0 6px 18px;padding:0;">
                  <li>Open the <a href="https://console.cloud.google.com/projectselector2/home/dashboard" target="_blank" rel="noopener">Google Cloud Console</a> and select (or create) a project.</li>
                  <li>Enable the <a href="https://console.cloud.google.com/apis/library/translate.googleapis.com" target="_blank" rel="noopener">Cloud Translation API</a> for that project. (Billing must be enabled on the project — Translation has a free monthly tier, then per-character pricing.)</li>
                  <li>Create an API key under <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">APIs &amp; Services → Credentials</a> (or reuse your existing Google key).</li>
                  <li>If the key has <em>API restrictions</em>, make sure <strong>Cloud Translation API</strong> is in the allowed list (otherwise leave it unrestricted).</li>
                  <li>Paste the key above and click <strong>Save</strong>, or — if it's the same key already on the Models page — just leave this blank. Then click <strong>Test connection</strong>.</li>
                </ol>
                <span class="setup-hint" style="margin:0;">Tip: the <strong>Test connection</strong> button reads the exact project from Google's response and links you straight to it when something needs enabling.</span>
              </div>
            </details>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">Google Maps Platform (<code>ai.route</code>, <code>ai.geocode</code>, <code>ai.places</code>, <code>ai.streetview</code>, <code>ai.tiles3d</code>)</div>
            <div class="setup-hint">Routing/directions (Google Routes API v2 — traffic-aware routes, alternatives, tolls, transit, distance matrix), geocoding, and place search for apps. By default it reuses the <strong>Google Translate</strong> key above (same GCP key — just enable the Maps APIs on it). Set a dedicated key below only if your Maps APIs live on a different Google Cloud key.</div>
            <div style="display:flex;gap:8px;margin-top:8px;max-width:480px;">
              <input type="password" id="mapsKeyInput" style="flex:1;padding:8px;font:inherit;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);" placeholder="Paste Google Maps Platform API key..." autocomplete="off">
              <button type="button" id="mapsKeyToggle" class="setup-btn" title="Show/hide key">&#128065;</button>
              <button type="button" id="mapsKeySave" class="setup-btn setup-btn-primary">Save</button>
            </div>
            <div id="mapsKeyStatus" class="setup-status"></div>
            <div style="margin-top:10px;display:flex;gap:8px;align-items:center;">
              <button type="button" id="mapsKeyTest" class="setup-btn">Test connection</button>
              <span class="setup-hint" style="margin:0;">Probes the Routes, Geocoding, and Places APIs and reports per-API what (if anything) needs fixing.</span>
            </div>
            <div id="mapsKeyDiag" class="setup-translate-diag" style="display:none;margin-top:10px;padding:10px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg);font-size:13px;line-height:1.5;"></div>
            <details class="setup-translate-help" style="margin-top:10px;">
              <summary style="cursor:pointer;font-size:13px;opacity:.85;">Setup steps &amp; Google Cloud links</summary>
              <div style="margin-top:8px;font-size:13px;line-height:1.6;">
                <strong>One-time setup in Google Cloud:</strong>
                <ol style="margin:6px 0 6px 18px;padding:0;">
                  <li>Open the <a href="https://console.cloud.google.com/projectselector2/home/dashboard" target="_blank" rel="noopener">Google Cloud Console</a> and select (or create) a project. Billing must be enabled — all three APIs have a free monthly tier, then pay-as-you-go.</li>
                  <li>Enable each of these APIs for that project:
                    <ul style="margin:4px 0 4px 18px;padding:0;">
                      <li><a href="https://console.cloud.google.com/apis/library/routes.googleapis.com" target="_blank" rel="noopener">Routes API</a> — directions &amp; distance matrix (<code>ai.route</code>, <code>ai.routeMatrix</code>)</li>
                      <li><a href="https://console.cloud.google.com/apis/library/geocoding-backend.googleapis.com" target="_blank" rel="noopener">Geocoding API</a> — address &harr; coordinates (<code>ai.geocode</code>)</li>
                      <li><a href="https://console.cloud.google.com/apis/library/places-backend.googleapis.com" target="_blank" rel="noopener">Places API (New)</a> — place search, details, autocomplete (<code>ai.places</code>)</li>
                      <li><a href="https://console.cloud.google.com/apis/library/street-view-image-backend.googleapis.com" target="_blank" rel="noopener">Street View Static API</a> &mdash; street-level stills of a coordinate (<code>ai.streetview</code>; the metadata probe is free, images are billed per request)</li>
                      <li><a href="https://console.cloud.google.com/apis/library/tile.googleapis.com" target="_blank" rel="noopener">Map Tiles API</a> &mdash; Photorealistic 3D Tiles (<code>ai.tiles3d</code>; optional, Enterprise SKU billed per root tileset request)</li>
                    </ul>
                  </li>
                  <li>Create an API key under <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">APIs &amp; Services → Credentials</a> (or reuse your existing Google key).</li>
                  <li>If the key has <em>API restrictions</em>, make sure <strong>Routes API</strong>, <strong>Geocoding API</strong>, and <strong>Places API (New)</strong> are all in the allowed list (otherwise leave it unrestricted).</li>
                  <li>Paste the key above and click <strong>Save</strong>, or — if it's the same key you already set as the Google Translate key above — just leave this blank (it falls back to that key automatically). Then click <strong>Test connection</strong>.</li>
                </ol>
                <span class="setup-hint" style="margin:0;">Tip: the <strong>Test connection</strong> button checks each API separately and links you straight to the exact project when something needs enabling.</span>
              </div>
            </details>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">Brave Web Search (<code>ai.webSearch</code>)</div>
            <div class="setup-hint">Live web search for apps via the <a href="https://brave.com/search/api/" target="_blank" rel="noopener">Brave Search API</a> — web results, news, and videos with titles, URLs, and snippets. Requires its own Brave Search API key (independent of the Google keys above; the free tier includes 2,000 queries/month).</div>
            <div style="display:flex;gap:8px;margin-top:8px;max-width:480px;">
              <input type="password" id="braveKeyInput" style="flex:1;padding:8px;font:inherit;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);" placeholder="Paste Brave Search API key..." autocomplete="off">
              <button type="button" id="braveKeyToggle" class="setup-btn" title="Show/hide key">&#128065;</button>
              <button type="button" id="braveKeySave" class="setup-btn setup-btn-primary">Save</button>
            </div>
            <div id="braveKeyStatus" class="setup-status"></div>
            <div style="margin-top:10px;display:flex;gap:8px;align-items:center;">
              <button type="button" id="braveKeyTest" class="setup-btn">Test connection</button>
              <span class="setup-hint" style="margin:0;">Runs a live search against Brave and reports exactly what (if anything) needs fixing.</span>
            </div>
            <div id="braveKeyDiag" class="setup-translate-diag" style="display:none;margin-top:10px;padding:10px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg);font-size:13px;line-height:1.5;"></div>
            <details class="setup-translate-help" style="margin-top:10px;">
              <summary style="cursor:pointer;font-size:13px;opacity:.85;">Setup steps &amp; Brave links</summary>
              <div style="margin-top:8px;font-size:13px;line-height:1.6;">
                <strong>One-time setup at Brave:</strong>
                <ol style="margin:6px 0 6px 18px;padding:0;">
                  <li>Open the <a href="https://api-dashboard.search.brave.com/" target="_blank" rel="noopener">Brave Search API dashboard</a> and sign up (or log in).</li>
                  <li>Choose a plan — the <strong>Free</strong> plan gives 1 query/second and 2,000 queries/month; paid plans raise both. A credit card is required even for the free plan.</li>
                  <li>Create an API key under <a href="https://api-dashboard.search.brave.com/app/keys" target="_blank" rel="noopener">API Keys</a> (subscription type "Data for Search").</li>
                  <li>Paste the key above and click <strong>Save</strong>, then click <strong>Test connection</strong>.</li>
                </ol>
              </div>
            </details>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">ElevenLabs Sound Effects (<code>ai.sfx</code>)</div>
            <div class="setup-hint">Generates sound effects from a text prompt via <a href="https://elevenlabs.io/" target="_blank" rel="noopener">ElevenLabs</a>. Requires its own ElevenLabs API key; the same key will serve any future ElevenLabs feature. The connection test only reads your account — it never generates audio and costs nothing.</div>
            <div style="display:flex;gap:8px;margin-top:8px;max-width:480px;">
              <input type="password" id="elevenlabsKeyInput" style="flex:1;padding:8px;font:inherit;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);" placeholder="Paste ElevenLabs API key..." autocomplete="off">
              <button type="button" id="elevenlabsKeyToggle" class="setup-btn" title="Show/hide key">&#128065;</button>
              <button type="button" id="elevenlabsKeySave" class="setup-btn setup-btn-primary">Save</button>
            </div>
            <div id="elevenlabsKeyStatus" class="setup-status"></div>
            <div style="margin-top:10px;display:flex;gap:8px;align-items:center;">
              <button type="button" id="elevenlabsKeyTest" class="setup-btn">Test connection</button>
              <span class="setup-hint" style="margin:0;">Reads your ElevenLabs account (plan and character usage) and reports exactly what (if anything) needs fixing.</span>
            </div>
            <div id="elevenlabsKeyDiag" class="setup-translate-diag" style="display:none;margin-top:10px;padding:10px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg);font-size:13px;line-height:1.5;"></div>
            <details class="setup-translate-help" style="margin-top:10px;">
              <summary style="cursor:pointer;font-size:13px;opacity:.85;">Setup steps &amp; ElevenLabs links</summary>
              <div style="margin-top:8px;font-size:13px;line-height:1.6;">
                <strong>One-time setup at ElevenLabs:</strong>
                <ol style="margin:6px 0 6px 18px;padding:0;">
                  <li>Sign in (or sign up) at <a href="https://elevenlabs.io/" target="_blank" rel="noopener">elevenlabs.io</a>.</li>
                  <li>Open the profile menu (or <strong>Developers</strong>) and go to <a href="https://elevenlabs.io/app/developers/api-keys" target="_blank" rel="noopener">API Keys</a>.</li>
                  <li>Click <strong>Create key</strong>. If you restrict its scopes, enable <strong>Sound Effects</strong> access and <strong>User: read</strong> (the connection test needs it).</li>
                  <li>Copy the key and paste it above, click <strong>Save</strong>, then click <strong>Test connection</strong>.</li>
                </ol>
              </div>
            </details>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">AI Capabilities for Apps</div>
            <div class="setup-hint">Built-in AI methods every app can call over the bridge — no per-app API keys. They use the platform's provider keys (set on the Models page).</div>
            <div class="setup-ai-caps">
              <div class="setup-ai-cap">
                <div class="setup-ai-cap-head"><span class="setup-ai-cap-icon">&#128172;</span><code>ai.prompt</code></div>
                <div class="setup-ai-cap-desc">Text generation / reasoning. Defaults to the model above; pass <code>model</code> to override (any registry model — Claude, GPT, Gemini, DeepSeek, …).</div>
              </div>
              <div class="setup-ai-cap">
                <div class="setup-ai-cap-head"><span class="setup-ai-cap-icon">&#127908;</span><code>ai.transcribe</code><span class="setup-ai-cap-tag">new</span></div>
                <div class="setup-ai-cap-desc">Speech-to-text (OpenAI or xAI — default set above). Auto-preprocesses for accuracy: EBU R128 loudness normalization &rarr; Silero VAD speech-trim &rarr; 16&nbsp;kHz mono FLAC. Accepts any format; <code>accuracy:'high'</code> for best quality, optional <code>language</code> hint.</div>
              </div>
              <div class="setup-ai-cap">
                <div class="setup-ai-cap-head"><span class="setup-ai-cap-icon">&#128264;</span><code>ai.tts</code><span class="setup-ai-cap-tag">new</span></div>
                <div class="setup-ai-cap-desc">Text-to-speech (OpenAI, xAI or Google Gemini — default model and voice set above). Returns base64 + a ready-to-play data URI; <code>instructions</code> steers tone/style where the model supports it.</div>
              </div>
              <div class="setup-ai-cap">
                <div class="setup-ai-cap-head"><span class="setup-ai-cap-icon">&#127912;</span><code>ai.image</code><span class="setup-ai-cap-tag">new</span></div>
                <div class="setup-ai-cap-desc">Image generation &amp; editing (Google Gemini, OpenAI gpt-image or xAI Grok Imagine — default set above). Returns base64 image data + data URI.</div>
              </div>
              <div class="setup-ai-cap">
                <div class="setup-ai-cap-head"><span class="setup-ai-cap-icon">&#127760;</span><code>ai.translate</code><span class="setup-ai-cap-tag">new</span></div>
                <div class="setup-ai-cap-desc">Text translation (Google Cloud Translation). Pass a string or array + a target language; source is auto-detected. Uses the Translate key above (or the shared google key).</div>
              </div>
              <div class="setup-ai-cap">
                <div class="setup-ai-cap-head"><span class="setup-ai-cap-icon">&#128288;</span><code>ai.detect</code><span class="setup-ai-cap-tag">new</span></div>
                <div class="setup-ai-cap-desc">Language detection (Google Cloud Translation). Pass a string or array; returns ISO-639 language code, confidence score, and reliability flag. Uses the Translate key (or the shared google key).</div>
              </div>
              <div class="setup-ai-cap">
                <div class="setup-ai-cap-head"><span class="setup-ai-cap-icon">&#128663;</span><code>ai.route</code><span class="setup-ai-cap-tag">new</span></div>
                <div class="setup-ai-cap-desc">Directions (Google Routes API v2). Traffic-aware routes, alternatives, tolls, transit, waypoints; addresses, coordinates, or place IDs. Uses the Maps key above (or the Google Translate key).</div>
              </div>
              <div class="setup-ai-cap">
                <div class="setup-ai-cap-head"><span class="setup-ai-cap-icon">&#128202;</span><code>ai.routeMatrix</code><span class="setup-ai-cap-tag">new</span></div>
                <div class="setup-ai-cap-desc">N&times;M distance matrix (Google Routes API v2). Travel times and distances for every origin&rarr;destination pair; same travel modes, traffic awareness, and key as <code>ai.route</code>.</div>
              </div>
              <div class="setup-ai-cap">
                <div class="setup-ai-cap-head"><span class="setup-ai-cap-icon">&#128205;</span><code>ai.geocode</code><span class="setup-ai-cap-tag">new</span></div>
                <div class="setup-ai-cap-desc">Address &harr; coordinates (Google Geocoding). Forward and reverse lookup with language/region options.</div>
              </div>
              <div class="setup-ai-cap">
                <div class="setup-ai-cap-head"><span class="setup-ai-cap-icon">&#127970;</span><code>ai.places</code><span class="setup-ai-cap-tag">new</span></div>
                <div class="setup-ai-cap-desc">Place search, nearby, details, autocomplete &amp; photos (Google Places API New). Ratings, opening hours, contact info, place photos as base64.</div>
              </div>
              <div class="setup-ai-cap">
                <div class="setup-ai-cap-head"><span class="setup-ai-cap-icon">&#128506;</span><code>ai.streetview</code><span class="setup-ai-cap-tag">new</span></div>
                <div class="setup-ai-cap-desc">Street View stills of a known coordinate (Google Street View Static API). Free coverage/date probe, then a framed image by heading, pitch &amp; field of view; <code>source: 'outdoor'</code> excludes indoor panoramas. Returns base64 + the copyright string Google requires on display. Uses the Maps key above.</div>
              </div>
              <div class="setup-ai-cap">
                <div class="setup-ai-cap-head"><span class="setup-ai-cap-icon">&#127961;</span><code>ai.tiles3d</code><span class="setup-ai-cap-tag">new</span></div>
                <div class="setup-ai-cap-desc">Photorealistic 3D Tiles (Google Map Tiles API). Root tileset + child tileset/.glb fetches with the session token handled by the platform; the root (the only billed request) is cached for the 3 h session window and shared across apps. Uses the Maps key above (or the Google Translate key).</div>
              </div>
              <div class="setup-ai-cap">
                <div class="setup-ai-cap-head"><span class="setup-ai-cap-icon">&#128269;</span><code>ai.webSearch</code><span class="setup-ai-cap-tag">new</span></div>
                <div class="setup-ai-cap-desc">Live web search (Brave Search API). Web, news &amp; video results with titles, URLs, snippets; freshness, country and safesearch filters. Uses the Brave key above.</div>
              </div>
              <div class="setup-ai-cap">
                <div class="setup-ai-cap-head"><span class="setup-ai-cap-icon">&#128279;</span><code>embed</code></div>
                <div class="setup-ai-cap-desc">Local embeddings for semantic search (384-dim multilingual vectors, shared in-process model — no API key, no network).</div>
              </div>
              <div class="setup-ai-cap">
                <div class="setup-ai-cap-head"><span class="setup-ai-cap-icon">&#127925;</span><code>ai.music.*</code></div>
                <div class="setup-ai-cap-desc">Local music generation &amp; beat analysis (MusicGen). <code>ai.music.generate</code> (text-to-music, 1&ndash;30&nbsp;s, queued), <code>ai.music.analyze</code> (BPM/beatgrid), <code>ai.music.status</code>. Runs on CPU — no API key. Install via Setup&nbsp;&#x203A;&nbsp;Extras.</div>
              </div>
              <div class="setup-ai-cap">
                <div class="setup-ai-cap-head"><span class="setup-ai-cap-icon">&#129504;</span><code>memory.*</code></div>
                <div class="setup-ai-cap-desc">Platform memory — shared self-tending knowledge store. <code>memory.remember</code> / <code>memory.recall</code> / <code>memory.forget</code> / <code>memory.entities</code>; hybrid semantic vector + full-text search with AI-powered consolidation.</div>
              </div>
            </div>
          </div>
        </div>

        <!-- MEMORY TAB -->
        <div class="setup-pane" id="setupPane-memory">
          <div class="setup-pane-intro">
            <h3>Memory</h3>
            <p>A shared, self-tending knowledge store for the whole platform. It consolidates raw observations into durable facts and entities on its own &mdash; an idle store does nothing, so it only works when there's new data.</p>
            <span class="setup-intro-apps">Apps read and write long-term memory through <code>ctx.memory.*</code> / the <code>memory.*</code> bridge &mdash; persistent context and semantic recall across sessions and across every app, without building their own store.</span>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">Platform Memory</div>
            <div class="setup-hint">A shared, self-tending knowledge store every app can read and write (<code>ctx.memory.*</code> / the <code>memory.*</code> bridge). Maintenance runs only when there is new data — an idle store does nothing.</div>
            <div id="memStatus" class="setup-mem-status" style="margin-top:10px;font-size:13px;">Loading…</div>
            <div style="margin-top:10px;display:flex;gap:8px;align-items:center;">
              <label class="setup-label" style="display:flex;align-items:center;gap:6px;margin:0;">
                <input type="checkbox" id="memEnabled"> Maintenance enabled
              </label>
              <button id="memRunNow" class="setup-btn setup-btn-primary" style="margin-left:auto;">Run maintenance now</button>
            </div>
            <div id="memRunStatus" class="setup-status"></div>
          </div>
          <div class="setup-section">
            <div class="setup-section-title">Tuning</div>
            <div class="setup-hint">Defaults suit most setups. All changes apply on the next maintenance tick.</div>
            <label class="setup-label" style="display:block;margin-top:8px;">Consolidate batch size
              <input type="number" id="memConsolidateBatch" min="1" max="2000" style="display:block;margin-top:4px;padding:6px;width:120px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);">
            </label>
            <label class="setup-label" style="display:block;margin-top:8px;">Short-term TTL (days)
              <input type="number" id="memShortTtlDays" min="1" max="3650" style="display:block;margin-top:4px;padding:6px;width:120px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);">
            </label>
            <label class="setup-label" style="display:block;margin-top:8px;">Promote after N reinforcements
              <input type="number" id="memPromoteHitCount" min="1" max="100" style="display:block;margin-top:4px;padding:6px;width:120px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);">
            </label>
            <label class="setup-label" style="display:block;margin-top:8px;">Ledger retention (days)
              <input type="number" id="memLedgerRetentionDays" min="30" max="36500" style="display:block;margin-top:4px;padding:6px;width:120px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);">
            </label>
            <div id="memTuneStatus" class="setup-status"></div>
          </div>
        </div>

      </div>
      </div>
      </div>`;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    // --- Tab switching ---
    modal.querySelectorAll('.setup-nav-item').forEach(tab => {
      tab.addEventListener('click', () => {
        modal.querySelectorAll('.setup-nav-item').forEach(t => t.classList.remove('active'));
        modal.querySelectorAll('.setup-pane').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        const pane = document.getElementById('setupPane-' + tab.dataset.tab);
        if (pane) pane.classList.add('active');
        if (tab.dataset.tab === 'accounts') refreshSetupAccountHealth();
        if (tab.dataset.tab === 'remote') {
          const pane = document.getElementById('setupPane-remote');
          if (pane && window.publishModule) window.publishModule.renderRemotePane(pane);
          sendWs({ type: 'app:peer:slaveStatus' });
          sendWs({ type: 'app:peer:list' });
        }
        if (tab.dataset.tab === 'print') printSetup.open(document.getElementById('setupPane-print'));
        if (tab.dataset.tab === 'extras') sendWs({ type: 'app:extras:status' });
        if (tab.dataset.tab === 'email') { sendWs({ type: 'app:setup:emailList' }); sendWs({ type: 'app:setup:emailEngineStatus' }); }
        if (tab.dataset.tab === 'google') sendWs({ type: 'app:setup:calendarStatus' });
        if (tab.dataset.tab === 'telegram') { populateTgAppSelect(); sendWs({ type: 'app:setup:telegramStatus' }); sendWs({ type: 'app:setup:platformTelegramStatus' }); }
        if (tab.dataset.tab === 'whatsapp') { populateWaAppSelect(); sendWs({ type: 'app:setup:whatsappStatus' }); }
        if (tab.dataset.tab === 'cron') { sendWs({ type: 'app:setup:cronList' }); renderCronTargetFields(); }
        if (tab.dataset.tab === 'tools-access') { renderToolsAccessSummary(); renderAppDeps(); sendWs({ type: 'app:deps:get' }); }
        if (tab.dataset.tab === 'ai-config') { sendWs({ type: 'app:settings:get' }); sendWs({ type: 'app:media:catalog:get' }); sendWs({ type: 'app:translateKey:get' }); sendWs({ type: 'app:mapsKey:get' }); sendWs({ type: 'app:braveKey:get' }); sendWs({ type: 'app:elevenlabsKey:get' }); }
        if (tab.dataset.tab === 'memory') { sendWs({ type: 'app:settings:get' }); sendWs({ type: 'app:memory:status' }); }
      });
    });

    // --- Status badges + first-run checklist (fed by app:setup:overviewResult) ---
    function switchSetupTab(tabName) {
      modal.querySelector(`.setup-nav-item[data-tab="${tabName}"]`)?.click();
    }

    function applySetupStatusBadges(ov) {
      const set = (tab, state) => {
        const el = modal.querySelector(`.setup-nav-status[data-status-tab="${tab}"]`);
        if (el) el.className = 'setup-nav-status setup-nav-status-' + state;
      };
      set('system', ov.db?.ok ? 'ok' : 'missing');
      set('google', ov.accounts?.google > 0 ? 'ok' : 'off');
      set('email', ov.email?.count > 0 ? 'ok' : 'off');
      set('telegram', ov.telegram?.configured ? 'ok' : 'off');
      set('whatsapp', ov.whatsapp?.configured ? 'ok' : 'off');
      set('ai-config', ov.ai?.configured ? 'ok' : 'missing');
      set('memory', ov.memory?.ok ? 'ok' : 'off');
    }

    function renderSetupChecklist(ov) {
      const strip = document.getElementById('setupChecklist');
      if (!strip) return;
      const items = [
        { ok: !!ov.db?.ok, label: 'Database connected', tab: 'system' },
        { ok: (ov.accounts?.count || 0) > 0, label: 'Account connected', tab: 'google' },
        { ok: !!ov.ai?.configured, label: 'AI configured', tab: 'ai-config' },
      ];
      if (items.every(i => i.ok)) { strip.style.display = 'none'; return; }
      strip.style.display = '';
      strip.innerHTML = '<span class="setup-checklist-title">Getting started:</span>' + items.map(i =>
        `<button class="setup-checklist-item ${i.ok ? 'done' : ''}" data-goto-tab="${i.tab}">
          <span class="setup-checklist-mark">${i.ok ? '&#10003;' : '&#9675;'}</span>${i.label}
        </button>`).join('');
      strip.querySelectorAll('[data-goto-tab]').forEach(btn =>
        btn.addEventListener('click', () => switchSetupTab(btn.dataset.gotoTab)));
    }

    apps._onSetupOverview = (ov) => {
      if (!document.body.contains(modal)) { apps._onSetupOverview = null; return; }
      applySetupStatusBadges(ov);
      renderSetupChecklist(ov);
    };
    sendWs({ type: 'app:setup:overview' });

    // --- Tools & Access pane ---
    function renderToolsAccessSummary() {
      const el = document.getElementById('toolsAccessSummary');
      if (!el) return;
      const counts = { self: 0, platform: 0, apps: 0 };
      const exposedApps = [];
      for (const [appName, list] of apps.tools.entries()) {
        let exposed = 0;
        for (const t of list) {
          counts[t.expose === 'platform' || t.expose === 'apps' ? t.expose : 'self']++;
          if (t.expose === 'platform' || t.expose === 'apps') exposed++;
        }
        if (exposed > 0) {
          const info = apps.list.find(a => a.name === appName);
          exposedApps.push({ name: appName, exposed, autostart: !!info?.autostart });
        }
      }
      const total = counts.self + counts.platform + counts.apps;
      if (total === 0) {
        el.innerHTML = '<div class="setup-hint">No apps have registered tools yet. Tools are added per app (app card &rarr; Tools) or by the app builder AI.</div>';
        return;
      }
      let html = `<div class="setup-row"><span>${exposeBadge('self')} App-only tools</span><span>${counts.self}</span></div>
        <div class="setup-row"><span>${exposeBadge('platform')} Platform tools</span><span>${counts.platform}</span></div>
        <div class="setup-row"><span>${exposeBadge('apps')} App-to-app tools</span><span>${counts.apps}</span></div>`;
      if (exposedApps.length > 0) {
        html += '<div class="setup-section-title" style="margin-top:14px;">Apps providing tools</div>';
        for (const a of exposedApps.sort((x, y) => x.name.localeCompare(y.name))) {
          html += `<div class="setup-row"><span><code>${escHtml(a.name)}</code> &mdash; ${a.exposed} exposed tool${a.exposed === 1 ? '' : 's'}</span><span class="setup-hint" style="margin:0;">${a.autostart ? 'autostarts' : 'manual start'}</span></div>`;
        }
      }
      html += '<div class="tool-expose-note">Tools are only callable from this machine (loopback). There is no way to reach them from the network or internet.</div>';
      el.innerHTML = html;
    }
    document.getElementById('toolsAccessOpenBtn')?.addEventListener('click', () => {
      window.appsRenderTgAwaiting = null;
      apps._onSetupOverview = null;
      backdrop.remove();
      openToolsOverview();
    });

    wireMediaDefaults();

    const directModelSelect = document.getElementById('directModelSelect');
    if (directModelSelect) {
      directModelSelect.addEventListener('change', () => {
        flashSetupApplied('directModelStatus', 'Saved');
        directModelSelect.dataset.selected = directModelSelect.value;
        sendWs({ type: 'app:settings:set', key: 'directModel', value: directModelSelect.value });
      });
    }

    // --- Google Translate key handlers ---
    const translateKeyInput = document.getElementById('translateKeyInput');
    const translateKeyToggle = document.getElementById('translateKeyToggle');
    const translateKeySave = document.getElementById('translateKeySave');
    if (translateKeyToggle && translateKeyInput) {
      translateKeyToggle.addEventListener('click', () => {
        translateKeyInput.type = translateKeyInput.type === 'password' ? 'text' : 'password';
      });
    }
    if (translateKeySave && translateKeyInput) {
      translateKeySave.addEventListener('click', () => {
        sendWs({ type: 'app:translateKey:set', value: translateKeyInput.value });
      });
    }
    const translateKeyTest = document.getElementById('translateKeyTest');
    if (translateKeyTest) {
      translateKeyTest.addEventListener('click', () => {
        const diag = document.getElementById('translateKeyDiag');
        if (diag) { diag.style.display = 'block'; diag.innerHTML = '<span class="setup-check loading">Testing translation against Google…</span>'; }
        translateKeyTest.disabled = true;
        sendWs({ type: 'app:translateKey:test' });
      });
    }

    // --- Google Maps Platform key handlers ---
    const mapsKeyInput = document.getElementById('mapsKeyInput');
    const mapsKeyToggle = document.getElementById('mapsKeyToggle');
    const mapsKeySave = document.getElementById('mapsKeySave');
    if (mapsKeyToggle && mapsKeyInput) {
      mapsKeyToggle.addEventListener('click', () => {
        mapsKeyInput.type = mapsKeyInput.type === 'password' ? 'text' : 'password';
      });
    }
    if (mapsKeySave && mapsKeyInput) {
      mapsKeySave.addEventListener('click', () => {
        sendWs({ type: 'app:mapsKey:set', value: mapsKeyInput.value });
      });
    }
    const mapsKeyTest = document.getElementById('mapsKeyTest');
    if (mapsKeyTest) {
      mapsKeyTest.addEventListener('click', () => {
        const diag = document.getElementById('mapsKeyDiag');
        if (diag) { diag.style.display = 'block'; diag.innerHTML = '<span class="setup-check loading">Testing the Routes, Geocoding, and Places APIs against Google…</span>'; }
        mapsKeyTest.disabled = true;
        sendWs({ type: 'app:mapsKey:test' });
      });
    }

    // --- Brave Search key handlers ---
    const braveKeyInput = document.getElementById('braveKeyInput');
    const braveKeyToggle = document.getElementById('braveKeyToggle');
    const braveKeySave = document.getElementById('braveKeySave');
    if (braveKeyToggle && braveKeyInput) {
      braveKeyToggle.addEventListener('click', () => {
        braveKeyInput.type = braveKeyInput.type === 'password' ? 'text' : 'password';
      });
    }
    if (braveKeySave && braveKeyInput) {
      braveKeySave.addEventListener('click', () => {
        sendWs({ type: 'app:braveKey:set', value: braveKeyInput.value });
      });
    }
    const braveKeyTest = document.getElementById('braveKeyTest');
    if (braveKeyTest) {
      braveKeyTest.addEventListener('click', () => {
        const diag = document.getElementById('braveKeyDiag');
        if (diag) { diag.style.display = 'block'; diag.innerHTML = '<span class="setup-check loading">Testing a search against Brave…</span>'; }
        braveKeyTest.disabled = true;
        sendWs({ type: 'app:braveKey:test' });
      });
    }

    // --- ElevenLabs key handlers ---
    const elevenlabsKeyInput = document.getElementById('elevenlabsKeyInput');
    const elevenlabsKeyToggle = document.getElementById('elevenlabsKeyToggle');
    const elevenlabsKeySave = document.getElementById('elevenlabsKeySave');
    if (elevenlabsKeyToggle && elevenlabsKeyInput) {
      elevenlabsKeyToggle.addEventListener('click', () => {
        elevenlabsKeyInput.type = elevenlabsKeyInput.type === 'password' ? 'text' : 'password';
      });
    }
    if (elevenlabsKeySave && elevenlabsKeyInput) {
      elevenlabsKeySave.addEventListener('click', () => {
        sendWs({ type: 'app:elevenlabsKey:set', value: elevenlabsKeyInput.value });
      });
    }
    const elevenlabsKeyTest = document.getElementById('elevenlabsKeyTest');
    if (elevenlabsKeyTest) {
      elevenlabsKeyTest.addEventListener('click', () => {
        const diag = document.getElementById('elevenlabsKeyDiag');
        if (diag) { diag.style.display = 'block'; diag.innerHTML = '<span class="setup-check loading">Checking your ElevenLabs account…</span>'; }
        elevenlabsKeyTest.disabled = true;
        sendWs({ type: 'app:elevenlabsKey:test' });
      });
    }

    // --- Memory pane handlers ---
    const memEnabled = document.getElementById('memEnabled');
    if (memEnabled) memEnabled.addEventListener('change', () => {
      flashSetupApplied('memRunStatus', memEnabled.checked ? 'Maintenance enabled' : 'Maintenance disabled');
      sendWs({ type: 'app:settings:set', key: 'memoryMaintenanceEnabled', value: memEnabled.checked });
    });
    const memTune = [
      ['memConsolidateBatch', 'memoryConsolidateBatch'],
      ['memShortTtlDays', 'memoryShortTtlDays'],
      ['memPromoteHitCount', 'memoryPromoteHitCount'],
      ['memLedgerRetentionDays', 'memoryLedgerRetentionDays'],
    ];
    memTune.forEach(([elId, key]) => {
      const el = document.getElementById(elId);
      if (el) el.addEventListener('change', () => {
        flashSetupApplied('memTuneStatus', 'Saved');
        sendWs({ type: 'app:settings:set', key, value: parseInt(el.value, 10) });
      });
    });
    const memRunNow = document.getElementById('memRunNow');
    if (memRunNow) memRunNow.addEventListener('click', () => {
      memRunNow.disabled = true;
      const s = document.getElementById('memRunStatus');
      if (s) { s.textContent = 'Running maintenance…'; s.className = 'setup-status'; }
      sendWs({ type: 'app:memory:runNow' });
    });

    if (initialTab === 'accounts') refreshSetupAccountHealth();
    // Other panes open through their nav item (it loads what the pane shows).
    if (initialTab && initialTab !== 'accounts') modal.querySelector(`.setup-nav-item[data-tab="${initialTab}"]`)?.click();

    // --- System tab handlers (same as before) ---
    function getFormCfg() {
      return {
        host: document.getElementById('dbCfgHost').value.trim() || 'localhost',
        port: parseInt(document.getElementById('dbCfgPort').value) || 3306,
        user: document.getElementById('dbCfgUser').value.trim(),
        password: document.getElementById('dbCfgPass').value,
      };
    }

    const close = () => { window.appsRenderTgAwaiting = null; apps._onSetupOverview = null; backdrop.remove(); };
    modal.querySelector('.setup-close-x').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    // Fetch bound-bot status once on open so the Telegram nav badge ("N apps
    // awaiting a bot") is correct before the tab is ever opened.
    renderTgAwaiting();
    sendWs({ type: 'app:setup:telegramStatus' });

    modal.querySelector('.db-cfg-test').addEventListener('click', () => {
      const el = document.getElementById('dbCfgStatus');
      el.textContent = 'Testing...'; el.className = 'setup-status';
      sendWs({ type: 'app:db:test', config: getFormCfg() });
    });
    const disconnectBtn = modal.querySelector('.db-cfg-disconnect');
    if (disconnectBtn) disconnectBtn.addEventListener('click', () => { sendWs({ type: 'app:db:disconnect' }); close(); });
    modal.querySelector('.db-cfg-save').addEventListener('click', () => {
      const cfg = getFormCfg();
      if (!cfg.user) { const el = document.getElementById('dbCfgStatus'); el.textContent = 'User is required'; el.className = 'setup-status error'; return; }
      const el = document.getElementById('dbCfgStatus'); el.textContent = 'Connecting...'; el.className = 'setup-status';
      apps._dbConnectPending = true;
      sendWs({ type: 'app:db:connect', config: cfg });
    });
    const installBtn = document.getElementById('setupInstallBtn');
    if (installBtn) installBtn.addEventListener('click', () => { installBtn.disabled = true; installBtn.textContent = 'Installing...'; sendWs({ type: 'app:setup:installDb' }); });
    document.getElementById('setupAutoRegen')?.addEventListener('click', () => { const el = document.getElementById('setupAutoPass'); if (el) el.value = genPassword(); });
    document.getElementById('setupAutoBtn')?.addEventListener('click', () => {
      const btn = document.getElementById('setupAutoBtn');
      const user = document.getElementById('setupAutoUser')?.value?.trim() || 'vistaclair';
      const pw = document.getElementById('setupAutoPass')?.value || '';
      if (!pw) { const el = document.getElementById('setupAutoStatus'); el.textContent = 'Password cannot be empty'; el.className = 'setup-status error'; return; }
      btn.disabled = true; btn.textContent = 'Setting up...';
      sendWs({ type: 'app:setup:setupUser', user, password: pw });
    });
    document.getElementById('setupManualRegen')?.addEventListener('click', () => { const el = document.getElementById('dbCfgPass'); if (el) { el.value = genPassword(); updateManualSql(); } });

    function updateManualSql() {
      const user = document.getElementById('dbCfgUser')?.value?.trim();
      const pass = document.getElementById('dbCfgPass')?.value;
      const sqlBlock = document.getElementById('setupManualSql');
      const sqlCode = document.getElementById('setupManualSqlCode');
      if (!sqlBlock || !sqlCode) return;
      if (!user || !pass) { sqlBlock.style.display = 'none'; return; }
      const eu = user.replace(/'/g, "''"); const ep = pass.replace(/'/g, "''");
      sqlCode.textContent = `CREATE USER IF NOT EXISTS '${eu}'@'localhost' IDENTIFIED BY '${ep}';\nALTER USER '${eu}'@'localhost' IDENTIFIED BY '${ep}';\nGRANT ALL PRIVILEGES ON *.* TO '${eu}'@'localhost' WITH GRANT OPTION;\nFLUSH PRIVILEGES;`;
      sqlBlock.style.display = '';
    }
    document.getElementById('dbCfgUser')?.addEventListener('input', updateManualSql);
    document.getElementById('dbCfgPass')?.addEventListener('input', updateManualSql);
    updateManualSql();
    document.getElementById('setupManualCopyBtn')?.addEventListener('click', () => {
      const sql = document.getElementById('setupManualSqlCode')?.textContent;
      if (sql) copyText(sql, document.getElementById('setupManualCopyBtn'));
    });

    // --- Google tab handlers ---
    document.getElementById('setupCopyOrigin')?.addEventListener('click', () => copyText(origin, document.getElementById('setupCopyOrigin')));
    document.getElementById('setupCopyRedirect')?.addEventListener('click', () => copyText(redirectUri, document.getElementById('setupCopyRedirect')));
    // The public-URL rows are filled by the oauthStatus handler (below).
    document.getElementById('setupGooglePublic')?.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-copy]');
      if (b) copyText(b.dataset.copy, b);
    });

    function oauthToggleReveal() {
      const idEl = document.getElementById('oauthClientId');
      const secretEl = document.getElementById('oauthClientSecret');
      if (!idEl || !secretEl) return;
      const isMasked = idEl.dataset.masked === 'true';
      if (isMasked && !idEl.dataset.savedId) {
        sendWs({ type: 'app:setup:oauthReveal' });
        return;
      }
      if (isMasked && idEl.dataset.savedId) {
        idEl.value = idEl.dataset.savedId; idEl.dataset.masked = 'false';
        secretEl.value = secretEl.dataset.savedSecret || ''; secretEl.type = 'text'; secretEl.dataset.masked = 'false';
        const indicator = document.getElementById('oauthSavedIndicator');
        if (indicator) indicator.innerHTML = '<span class="setup-check ok">Credentials revealed</span> — click <span style="font-size:14px;">&#x1f441;</span> again to mask';
      } else {
        const savedId = idEl.dataset.savedId || '';
        const savedSecret = secretEl.dataset.savedSecret || '';
        idEl.value = maskValue(savedId); idEl.dataset.masked = 'true';
        secretEl.value = maskValue(savedSecret); secretEl.type = 'password'; secretEl.dataset.masked = 'true';
        const indicator = document.getElementById('oauthSavedIndicator');
        if (indicator) indicator.innerHTML = '<span class="setup-check ok">Credentials saved</span> — click the <span style="font-size:14px;">&#x1f441;</span> icon to reveal';
      }
    }
    function maskValue(v) {
      if (!v) return '';
      if (v.length <= 8) return '•'.repeat(v.length);
      return v.slice(0, 4) + '•'.repeat(Math.min(v.length - 8, 20)) + v.slice(-4);
    }
    document.getElementById('oauthIdToggle')?.addEventListener('click', oauthToggleReveal);
    document.getElementById('oauthSecretToggle')?.addEventListener('click', oauthToggleReveal);
    document.getElementById('oauthClientId')?.addEventListener('input', function() { this.dataset.masked = 'false'; });
    document.getElementById('oauthClientSecret')?.addEventListener('input', function() { this.dataset.masked = 'false'; });

    document.getElementById('oauthSaveBtn')?.addEventListener('click', () => {
      const idEl = document.getElementById('oauthClientId');
      const secretEl = document.getElementById('oauthClientSecret');
      let clientId = idEl?.value?.trim();
      let clientSecret = secretEl?.value?.trim();
      if (idEl?.dataset.masked === 'true') clientId = idEl.dataset.savedId || '';
      if (secretEl?.dataset.masked === 'true') clientSecret = secretEl.dataset.savedSecret || '';
      if (!clientId || !clientSecret) { const el = document.getElementById('oauthStatus'); if (el) { el.textContent = 'Both fields required'; el.className = 'setup-status error'; } return; }
      apps._oauthSavePending = true;
      sendWs({ type: 'app:setup:oauthSave', clientId, clientSecret });
    });
    document.getElementById('oauthTestBtn')?.addEventListener('click', () => {
      const el = document.getElementById('oauthTestResult'); if (el) el.innerHTML = '<span class="setup-check loading">Testing...</span>';
      sendWs({ type: 'app:setup:oauthTest', redirectUri });
    });

    // --- Email tab handlers ---
    const PRESETS = {
      outlook: { imapHost: 'imap-mail.outlook.com', imapPort: 993, smtpHost: 'smtp-mail.outlook.com', smtpPort: 587, tls: true, hint: 'Requires an <strong>app password</strong>. <a href="https://account.live.com/proofs/AppPassword" target="_blank">Generate one here</a>.' },
      yahoo: { imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, tls: true, hint: 'Generate an <strong>app password</strong> in <a href="https://login.yahoo.com/myaccount/security/" target="_blank">Security settings</a>.' },
      icloud: { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587, tls: true, hint: 'Create an <strong>app-specific password</strong> at <a href="https://appleid.apple.com/account/manage" target="_blank">Apple ID</a>.' },
      protonmail: { imapHost: '127.0.0.1', imapPort: 1143, smtpHost: '127.0.0.1', smtpPort: 1025, tls: false, hint: 'Requires <a href="https://proton.me/mail/bridge" target="_blank">ProtonMail Bridge</a> running locally. Use the Bridge password, not your ProtonMail password.' },
      fastmail: { imapHost: 'imap.fastmail.com', imapPort: 993, smtpHost: 'smtp.fastmail.com', smtpPort: 465, tls: true, hint: 'Generate an <strong>app password</strong> in <a href="https://www.fastmail.com/settings/security/devicekeys" target="_blank">Security settings</a>.' },
      gmx: { imapHost: 'imap.gmx.com', imapPort: 993, smtpHost: 'mail.gmx.com', smtpPort: 587, tls: true, hint: 'Make sure IMAP is enabled in your GMX settings.' },
      zoho: { imapHost: 'imap.zoho.com', imapPort: 993, smtpHost: 'smtp.zoho.com', smtpPort: 465, tls: true, hint: 'If 2FA is enabled, generate an <strong>app password</strong> at <a href="https://accounts.zoho.com/home#security/security_apppassword" target="_blank">Zoho Security</a>.' },
      yandex: { imapHost: 'imap.yandex.com', imapPort: 993, smtpHost: 'smtp.yandex.com', smtpPort: 465, tls: true, hint: 'Create an <strong>app password</strong> at <a href="https://id.yandex.com/security/app-passwords" target="_blank">Yandex Security</a>.' },
      aol: { imapHost: 'imap.aol.com', imapPort: 993, smtpHost: 'smtp.aol.com', smtpPort: 465, tls: true, hint: 'Generate an <strong>app password</strong> at <a href="https://login.aol.com/myaccount/security/" target="_blank">AOL Security</a>.' },
      custom: { imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 587, tls: true, hint: 'Enter your mail server details. Common ports: IMAP 993 (TLS), SMTP 587 (STARTTLS) or 465 (SSL).' },
    };

    document.getElementById('emailProvider')?.addEventListener('change', (e) => {
      const preset = PRESETS[e.target.value];
      const hintEl = document.getElementById('emailProviderHint');
      if (!preset) { if (hintEl) hintEl.style.display = 'none'; return; }
      if (hintEl) { hintEl.innerHTML = preset.hint; hintEl.style.display = ''; }
      const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
      set('emailImapHost', preset.imapHost); set('emailImapPort', preset.imapPort);
      set('emailSmtpHost', preset.smtpHost); set('emailSmtpPort', preset.smtpPort);
      const tlsImap = document.getElementById('emailImapTls'); if (tlsImap) tlsImap.checked = preset.tls !== false;
      const tlsSmtp = document.getElementById('emailSmtpTls'); if (tlsSmtp) tlsSmtp.checked = preset.tls !== false;
    });

    document.getElementById('emailPassToggle')?.addEventListener('click', () => {
      const input = document.getElementById('emailPass');
      if (input) input.type = input.type === 'password' ? 'text' : 'password';
    });

    function getEmailFormData() {
      return {
        email: document.getElementById('emailAddr')?.value?.trim(),
        username: document.getElementById('emailUser')?.value?.trim() || document.getElementById('emailAddr')?.value?.trim(),
        password: document.getElementById('emailPass')?.value,
        provider: document.getElementById('emailProvider')?.value || 'custom',
        imap: { host: document.getElementById('emailImapHost')?.value?.trim(), port: parseInt(document.getElementById('emailImapPort')?.value) || 993, tls: document.getElementById('emailImapTls')?.checked !== false },
        smtp: { host: document.getElementById('emailSmtpHost')?.value?.trim(), port: parseInt(document.getElementById('emailSmtpPort')?.value) || 587, tls: document.getElementById('emailSmtpTls')?.checked !== false },
      };
    }

    document.getElementById('emailTestBtn')?.addEventListener('click', () => {
      const data = getEmailFormData();
      if (!data.email || !data.password || !data.imap.host) { const el = document.getElementById('emailTestStatus'); el.textContent = 'Email, password, and IMAP host required'; el.className = 'setup-status error'; return; }
      const btn = document.getElementById('emailTestBtn'); btn.disabled = true; btn.textContent = 'Testing...';
      const el = document.getElementById('emailTestStatus'); el.textContent = 'Connecting...'; el.className = 'setup-status';
      sendWs({ type: 'app:setup:emailTest', account: data });
    });

    document.getElementById('emailSaveBtn')?.addEventListener('click', () => {
      const data = getEmailFormData();
      if (!data.email || !data.password || !data.imap.host) { const el = document.getElementById('emailTestStatus'); el.textContent = 'Email, password, and IMAP host required'; el.className = 'setup-status error'; return; }
      const btn = document.getElementById('emailSaveBtn'); btn.disabled = true; btn.textContent = 'Saving...';
      const el = document.getElementById('emailTestStatus'); el.textContent = 'Testing connection...'; el.className = 'setup-status';
      sendWs({ type: 'app:setup:emailAdd', account: data });
    });

    // --- Cron tab handlers ---
    function renderCronTargetFields() {
      const type = document.getElementById('cronTargetType')?.value || 'app-api';
      const container = document.getElementById('cronTargetFields');
      if (!container) return;
      if (type === 'app-api') {
        const appNames = (apps._list || []).map(a => a.name);
        container.innerHTML = `
          <label>App<select id="cronTargetApp" style="width:100%;padding:6px;font:inherit;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);">${appNames.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('')}</select></label>
          <div style="display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:end;">
            <label>Method<select id="cronTargetMethod" style="padding:6px;font:inherit;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);"><option>POST</option><option>GET</option></select></label>
            <label>Path<input id="cronTargetPath" type="text" placeholder="/api/refresh"></label>
          </div>`;
      } else if (type === 'shell') {
        container.innerHTML = `<label>Command<input id="cronTargetCommand" type="text" placeholder="curl http://example.com/health"></label>`;
      } else if (type === 'ai') {
        container.innerHTML = `
          <label>Message<textarea id="cronTargetMessage" rows="2" style="width:100%;padding:8px;font:inherit;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);resize:vertical;" placeholder="Analyze the latest data..."></textarea></label>
          <label>System Prompt (optional)<input id="cronTargetSysPrompt" type="text" placeholder="You are a data analyst..."></label>`;
      } else if (type === 'tool') {
        const appsWithTools = Array.from(apps.tools.entries())
          .filter(([, list]) => list.some(t => t.expose === 'platform' || t.expose === 'apps'))
          .map(([n]) => n).sort();
        const selStyle = 'width:100%;padding:6px;font:inherit;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);';
        if (appsWithTools.length === 0) {
          container.innerHTML = '<div class="setup-hint">No app currently exposes tools to the platform. Set a tool\'s exposure to <code>platform</code> or <code>apps</code> first.</div>';
          return;
        }
        container.innerHTML = `
          <label>App<select id="cronToolApp" style="${selStyle}">${appsWithTools.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('')}</select></label>
          <label>Tool<select id="cronToolName" style="${selStyle}"></select></label>
          <label>Arguments (JSON, optional)<textarea id="cronToolArgs" rows="2" style="width:100%;padding:8px;font:inherit;font-size:12px;font-family:monospace;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);resize:vertical;" placeholder='{"key": "value"}'></textarea></label>`;
        const appSel = document.getElementById('cronToolApp');
        const toolSel = document.getElementById('cronToolName');
        const fillTools = () => {
          const list = (apps.tools.get(appSel.value) || []).filter(t => t.expose === 'platform' || t.expose === 'apps');
          toolSel.innerHTML = list.map(t => `<option value="${escHtml(t.name)}" title="${escHtml(t.description || '')}">${escHtml(t.name)}</option>`).join('');
        };
        appSel.addEventListener('change', fillTools);
        fillTools();
      }
    }
    renderCronTargetFields();
    document.getElementById('cronTargetType')?.addEventListener('change', renderCronTargetFields);

    document.getElementById('cronAddBtn')?.addEventListener('click', () => {
      const name = document.getElementById('cronName')?.value?.trim();
      const schedule = document.getElementById('cronSchedule')?.value?.trim();
      const type = document.getElementById('cronTargetType')?.value;
      if (!name || !schedule) { const el = document.getElementById('cronAddStatus'); el.textContent = 'Name and schedule required'; el.className = 'setup-status error'; return; }
      let target;
      if (type === 'app-api') target = { type: 'app-api', app: document.getElementById('cronTargetApp')?.value, method: document.getElementById('cronTargetMethod')?.value || 'POST', path: document.getElementById('cronTargetPath')?.value?.trim() };
      else if (type === 'shell') target = { type: 'shell', command: document.getElementById('cronTargetCommand')?.value?.trim() };
      else if (type === 'ai') target = { type: 'ai', message: document.getElementById('cronTargetMessage')?.value?.trim(), systemPrompt: document.getElementById('cronTargetSysPrompt')?.value?.trim() };
      else if (type === 'tool') {
        const argsRaw = document.getElementById('cronToolArgs')?.value?.trim();
        let args = {};
        if (argsRaw) {
          try { args = JSON.parse(argsRaw); }
          catch { const el = document.getElementById('cronAddStatus'); el.textContent = 'Arguments must be valid JSON'; el.className = 'setup-status error'; return; }
        }
        target = { type: 'tool', app: document.getElementById('cronToolApp')?.value, tool: document.getElementById('cronToolName')?.value, args };
        if (!target.app || !target.tool) { const el = document.getElementById('cronAddStatus'); el.textContent = 'App and tool required'; el.className = 'setup-status error'; return; }
      }
      if (!target) return;
      const btn = document.getElementById('cronAddBtn'); btn.disabled = true; btn.textContent = 'Adding...';
      sendWs({ type: 'app:setup:cronAdd', job: { name, schedule, target } });
    });

    // --- Telegram handlers ---
    function populateTgAppSelect() {
      const sel = document.getElementById('tgApp');
      if (!sel) return;
      const names = (apps.list || []).map(a => a.name).filter(n => !tgBoundNames.has(n));
      const awaiting = new Set(tgAwaitingApps().map(a => a.name));
      const prev = sel.value;
      sel.innerHTML = names.length
        ? names.map(n => `<option value="${escHtml(n)}">${escHtml(n)}${awaiting.has(n) ? ' — needs bot' : ''}</option>`).join('')
        : '<option value="">No apps without a bot</option>';
      if (prev && names.includes(prev)) sel.value = prev;
    }

    // Callout + nav badge for apps built to use Telegram that have no bot yet.
    function renderTgAwaiting() {
      const awaiting = tgAwaitingApps();
      const badge = document.getElementById('tgNavBadge');
      if (badge) {
        if (awaiting.length > 0) { badge.textContent = String(awaiting.length); badge.style.display = ''; }
        else { badge.textContent = ''; badge.style.display = 'none'; }
      }
      const el = document.getElementById('tgAwaitingCallout');
      if (!el) return;
      if (awaiting.length === 0) { el.innerHTML = ''; return; }
      const items = awaiting.map(a => {
        const n = escHtml(a.name);
        return `<button class="setup-btn" style="font-size:11px;margin:2px 4px 2px 0;" ${vcAct.attrs('click', 'appsModule.tgPreselect', [n])} title="Select ${n} below">${n}</button>`;
      }).join('');
      const plural = awaiting.length === 1 ? 'app was' : 'apps were';
      el.innerHTML = `<div class="setup-status" style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin:6px 0;background:var(--bg);">
        <strong>${awaiting.length} ${plural} built to use Telegram but ${awaiting.length === 1 ? 'has' : 'have'} no bot yet.</strong>
        Create a bot with <a href="https://t.me/BotFather" target="_blank">@BotFather</a> (<code style="font-size:11px;">/newbot</code>), then pick the app and paste its token below.
        <div style="margin-top:6px;">${items}</div>
      </div>`;
    }

    // Drop an app into the per-app token form (from the awaiting callout).
    function tgPreselect(name) {
      const sel = document.getElementById('tgApp');
      if (sel) { sel.value = name; sel.focus(); }
      const tok = document.getElementById('tgToken');
      if (tok) tok.focus();
    }
    window.appsModule = window.appsModule || {};
    window.appsModule.tgPreselect = tgPreselect;
    // Bridge for the module-scope telegramStatus handler to refresh the
    // awaiting callout/badge and dropdown annotations once bots arrive. Cleared
    // when the modal closes so a stale closure is never called.
    window.appsRenderTgAwaiting = () => { renderTgAwaiting(); populateTgAppSelect(); };

    document.getElementById('tgTokenToggle')?.addEventListener('click', () => {
      const inp = document.getElementById('tgToken');
      if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    document.getElementById('proTgSaveBtn')?.addEventListener('click', () => {
      const appName = document.getElementById('tgApp')?.value;
      const token = document.getElementById('tgToken')?.value?.trim();
      const status = document.getElementById('tgSetStatus');
      if (!appName) { if (status) { status.textContent = 'Pick an app first'; status.className = 'setup-status error'; } return; }
      if (!token) { if (status) { status.textContent = 'Bot token required'; status.className = 'setup-status error'; } return; }
      if (!state.ws || state.ws.readyState !== 1) {
        if (status) { status.textContent = 'Not connected — try refreshing the page'; status.className = 'setup-status error'; }
        return;
      }
      const btn = document.getElementById('proTgSaveBtn'); btn.disabled = true; btn.textContent = 'Validating...';
      if (status) status.innerHTML = '<span class="setup-check loading">Checking token with Telegram...</span>';
      sendWs({ type: 'app:setup:telegramSet', appName, token });
      clearTimeout(btn._tgTimeout);
      btn._tgTimeout = setTimeout(() => {
        if (btn.disabled) { btn.disabled = false; btn.textContent = 'Save Bot'; }
        if (status && status.querySelector('.setup-check.loading')) {
          status.innerHTML = '<span class="setup-test-fail">Timed out — check the token and try again</span>';
        }
      }, 20000);
    });

    document.getElementById('tgPublicUrlBtn')?.addEventListener('click', () => {
      const url = document.getElementById('tgPublicUrl')?.value?.trim();
      const btn = document.getElementById('tgPublicUrlBtn'); btn.disabled = true; btn.textContent = 'Saving...';
      sendWs({ type: 'app:setup:telegramSetPublicUrl', url });
    });

    // --- WhatsApp (per-app) ---
    function populateWaAppSelect() {
      const sel = document.getElementById('waApp');
      if (!sel) return;
      const names = (apps.list || []).map(a => a.name);
      const prev = sel.value;
      sel.innerHTML = names.length
        ? names.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('')
        : '<option value="">No apps yet — create one first</option>';
      if (prev && names.includes(prev)) sel.value = prev;
    }

    [['waAccessTokenToggle', 'waAccessToken'], ['waAppSecretToggle', 'waAppSecret']].forEach(([btnId, inpId]) => {
      document.getElementById(btnId)?.addEventListener('click', () => {
        const inp = document.getElementById(inpId);
        if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
      });
    });

    // Copy buttons next to Phone Number ID and WABA ID fields
    document.querySelectorAll('.wa-field-copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const inp = document.getElementById(btn.dataset.copyFrom);
        if (inp && inp.value) {
          navigator.clipboard.writeText(inp.value).then(() => {
            const orig = btn.textContent;
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = orig; }, 1500);
          });
        }
      });
    });

    // Populate the edit form from a configured account card
    function populateWaForm(account) {
      const sel = document.getElementById('waApp');
      if (sel) sel.value = account.appName;
      const pn = document.getElementById('waPhoneNumberId');
      if (pn) pn.value = account.phoneNumberId || '';
      const wb = document.getElementById('waWabaId');
      if (wb) wb.value = account.wabaId || '';
      // Secrets are never sent to the frontend — clear fields and show hint
      const at = document.getElementById('waAccessToken');
      if (at) { at.value = ''; at.type = 'password'; at.placeholder = 'Re-enter to update'; }
      const as = document.getElementById('waAppSecret');
      if (as) { as.value = ''; as.type = 'password'; as.placeholder = 'Re-enter to update'; }
      const atHint = document.getElementById('waAccessTokenHint');
      if (atHint) { atHint.style.display = ''; atHint.textContent = 'Stored — leave blank to keep current, or enter a new token to replace.'; }
      const asHint = document.getElementById('waAppSecretHint');
      if (asHint) { asHint.style.display = ''; asHint.textContent = 'Stored — leave blank to keep current, or enter a new secret to replace.'; }
      // Show copy buttons where values exist
      document.querySelectorAll('.wa-field-copy-btn').forEach(btn => {
        const inp = document.getElementById(btn.dataset.copyFrom);
        btn.style.display = inp && inp.value ? '' : 'none';
      });
      // Update save button text
      const saveBtn = document.getElementById('waSaveBtn');
      if (saveBtn) saveBtn.textContent = 'Update Account';
      // Clear any previous status
      const status = document.getElementById('waSetStatus');
      if (status) status.innerHTML = `<span style="font-size:11px;color:var(--muted,#888);">Editing <strong>${escHtml(account.appName)}</strong>${account.displayPhone ? ' (' + escHtml(account.displayPhone) + ')' : ''}</span>`;
      // Scroll the form into view
      const form = document.getElementById('waApp');
      if (form) form.closest('.setup-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    // Expose for onclick in account cards
    window._waPopulateForm = populateWaForm;

    document.getElementById('waSaveBtn')?.addEventListener('click', () => {
      const appName = document.getElementById('waApp')?.value;
      const phoneNumberId = document.getElementById('waPhoneNumberId')?.value?.trim();
      const accessToken = document.getElementById('waAccessToken')?.value?.trim();
      const appSecret = document.getElementById('waAppSecret')?.value?.trim();
      const wabaId = document.getElementById('waWabaId')?.value?.trim();
      const status = document.getElementById('waSetStatus');
      const fail = (m) => { if (status) { status.textContent = m; status.className = 'setup-status error'; } };
      if (!appName) return fail('Pick an app first');
      if (!phoneNumberId) return fail('Phone Number ID required');
      // When editing an existing account, secrets can be blank (keeps current).
      // For new accounts, require both.
      const isEdit = document.getElementById('waAccessTokenHint')?.style.display !== 'none';
      if (!isEdit && !accessToken) return fail('Access token required');
      if (!isEdit && !appSecret) return fail('App secret required');
      const btn = document.getElementById('waSaveBtn'); btn.disabled = true; btn.textContent = 'Validating...';
      if (status) status.innerHTML = '<span class="setup-check loading">Checking credentials with WhatsApp Cloud API...</span>';
      sendWs({ type: 'app:setup:whatsappSet', appName, phoneNumberId, accessToken, appSecret, wabaId });
    });

    // --- Telegram control bot (dashboard itself) ---
    document.getElementById('ctrlTgTokenToggle')?.addEventListener('click', () => {
      const inp = document.getElementById('ctrlTgToken');
      if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    document.getElementById('ctrlTgSaveBtn')?.addEventListener('click', () => {
      const token = document.getElementById('ctrlTgToken')?.value?.trim();
      const status = document.getElementById('ctrlTgSetStatus');
      if (!token) { if (status) { status.textContent = 'Bot token required'; status.className = 'setup-status error'; } return; }
      const btn = document.getElementById('ctrlTgSaveBtn'); btn.disabled = true; btn.textContent = 'Validating...';
      if (status) status.innerHTML = '<span class="setup-check loading">Checking token with Telegram...</span>';
      sendWs({ type: 'app:setup:platformTelegramSet', token });
    });

    // --- AI Config handlers ---
    document.getElementById('aiConfigBtn')?.addEventListener('click', runAiConfig);
    document.getElementById('aiConfigInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runAiConfig(); } });

    function runAiConfig() {
      const input = document.getElementById('aiConfigInput');
      const instruction = input?.value?.trim();
      if (!instruction) return;
      const log = document.getElementById('aiConfigLog');
      log.style.display = '';
      log.innerHTML += `<div class="setup-ai-entry user">${escHtml(instruction)}</div>`;
      input.value = '';
      const btn = document.getElementById('aiConfigBtn'); btn.disabled = true; btn.textContent = 'Thinking...';
      const status = document.getElementById('aiConfigStatus'); status.innerHTML = '<span class="setup-check loading">AI is processing...</span>';
      sendWs({ type: 'app:setup:aiConfig', instruction });
      log.scrollTop = log.scrollHeight;
    }

    // Request initial data
    sendWs({ type: 'app:setup:check' });
    sendWs({ type: 'app:setup:oauthStatus' });
  }

  function updateSetupStatus(msg) {
    const sudoEl = document.getElementById('setupSudo');
    if (sudoEl) { sudoEl.textContent = msg.sudo ? 'Available' : 'Not available'; sudoEl.className = 'setup-check ' + (msg.sudo ? 'ok' : 'warn'); }
    const mariaEl = document.getElementById('setupMariadb');
    if (mariaEl) { mariaEl.textContent = msg.mariadb ? 'v' + msg.mariadb : 'Not installed'; mariaEl.className = 'setup-check ' + (msg.mariadb ? 'ok' : 'warn'); }
    const installWrap = document.getElementById('setupInstallWrap');
    if (installWrap) installWrap.style.display = (!msg.mariadb && msg.sudo) ? '' : 'none';
    const canAuto = msg.sudo && msg.mariadb;
    const autoWrap = document.getElementById('setupAutoWrap');
    const manualWrap = document.getElementById('setupManualWrap');
    if (autoWrap && manualWrap) {
      if (canAuto && !msg.db?.connected) {
        autoWrap.style.display = ''; manualWrap.style.display = 'none';
        const hintEl = document.getElementById('setupAutoHint');
        const userEl = document.getElementById('setupAutoUser');
        const btn = document.getElementById('setupAutoBtn');
        if (msg.dbUser) {
          if (hintEl) hintEl.innerHTML = `The admin account <strong>${escHtml(msg.dbUser)}</strong> already exists. Update the password below and connect.`;
          if (userEl) userEl.value = msg.dbUser;
          if (btn) btn.textContent = 'Set Password & Connect';
        } else {
          if (hintEl) hintEl.innerHTML = 'Vistaclair needs a MariaDB admin account. Since sudo is available, this can be set up in one click.';
          if (userEl && !userEl.value) userEl.value = 'vistaclair';
          if (btn) btn.textContent = 'Create User & Connect';
        }
        if (msg.db?.config?.user && userEl) userEl.value = msg.db.config.user;
      } else if (canAuto && msg.db?.connected) {
        autoWrap.style.display = ''; manualWrap.style.display = 'none';
        const hintEl = document.getElementById('setupAutoHint');
        if (hintEl) hintEl.innerHTML = '<span class="setup-check ok">Connected</span> &mdash; change password below if needed.';
        const userEl = document.getElementById('setupAutoUser');
        if (userEl && msg.db.config?.user) userEl.value = msg.db.config.user;
        const passEl = document.getElementById('setupAutoPass');
        if (passEl && msg.db.config?.password) passEl.value = msg.db.config.password;
        const btn = document.getElementById('setupAutoBtn');
        if (btn) btn.textContent = 'Update Password & Reconnect';
      } else {
        autoWrap.style.display = 'none'; manualWrap.style.display = '';
        const hintEl = document.getElementById('setupManualHint');
        if (hintEl) {
          if (msg.db?.connected) hintEl.innerHTML = '<span class="setup-check ok">Connected</span> &mdash; change credentials below if needed.';
          else if (!msg.mariadb) hintEl.innerHTML = 'Admin account for per-app databases. MariaDB not detected locally. Connect to a remote server or install MariaDB first.';
        }
      }
    }
    if (msg.db) {
      apps.db = { connected: msg.db.connected, config: msg.db.config };
      patchSetupBtn();
      if (msg.db.config) {
        const h = document.getElementById('dbCfgHost'); if (h) h.value = msg.db.config.host || 'localhost';
        const p = document.getElementById('dbCfgPort'); if (p) p.value = msg.db.config.port || 3306;
        const u = document.getElementById('dbCfgUser'); if (u) u.value = msg.db.config.user || '';
        const pw = document.getElementById('dbCfgPass');
        if (pw) { pw.value = msg.db.config.password || ''; pw.dispatchEvent(new Event('input')); }
      }
    }
    const appDbsEl = document.getElementById('setupAppDbs');
    if (appDbsEl) {
      const entries = Object.entries(msg.apps || {});
      if (entries.length === 0) {
        appDbsEl.innerHTML = '<div class="setup-hint" style="margin:0;">No app databases provisioned yet.</div>';
      } else {
        appDbsEl.innerHTML = '<table class="setup-db-table"><thead><tr><th>App</th><th>Database</th><th>User</th><th>Password</th></tr></thead><tbody>'
          + entries.map(([name, info]) => `<tr><td>${escHtml(name)}</td><td><code>${escHtml(info.database)}</code></td><td><code>${escHtml(info.user)}</code></td><td><code>${escHtml(info.password || '')}</code></td></tr>`).join('')
          + '</tbody></table>';
      }
    }
  }

  // Visual language for tool exposure levels. Strictly nested; there is no
  // network/external level by design.
  function exposeMeta(level) {
    switch (level) {
      case 'platform': return { label: 'Platform', cls: 'tool-expose-platform', desc: "This app's AI, plus platform AI and cron" };
      case 'apps': return { label: 'Apps', cls: 'tool-expose-apps', desc: "This app's AI, platform AI and cron, plus other apps via ctx.tools.call" };
      default: return { label: 'App-only', cls: 'tool-expose-self', desc: "Only this app's own AI sessions" };
    }
  }

  function exposeBadge(level) {
    const m = exposeMeta(level);
    return `<span class="tool-expose-badge ${m.cls}" title="${escHtml(m.desc)}"><span class="tool-expose-dot"></span>${m.label}</span>`;
  }

  function exposeLegend() {
    return `<div class="tool-expose-legend">${['self', 'platform', 'apps'].map(exposeBadge).join('')}
      <button class="help-info-btn" title="About tool exposure" ${vcAct.attrs('click', 'appsModule.openHelpAt', ['help-tool-exposure'])}>?</button></div>`;
  }

  function showToolDetail(appName, toolName) {
    const toolList = apps.tools.get(appName);
    if (!toolList) return;
    const tool = toolList.find(t => t.name === toolName);
    if (!tool) return;

    document.querySelector('.app-tool-detail-modal')?.remove();

    const schema = tool.inputSchema || {};
    const props = schema.properties || {};
    const required = schema.required || [];
    const propNames = Object.keys(props);
    let schemaHtml = '';
    if (propNames.length > 0) {
      schemaHtml = '<table class="app-tool-schema-table"><thead><tr><th>Parameter</th><th>Type</th><th>Req</th><th>Description</th></tr></thead><tbody>';
      for (const pName of propNames) {
        const p = props[pName];
        schemaHtml += `<tr><td><code>${escHtml(pName)}</code></td><td>${escHtml(p.type || 'any')}</td><td>${required.includes(pName) ? '<span style="color:var(--orange,#e8a244)">yes</span>' : 'no'}</td><td>${escHtml(p.description || '')}</td></tr>`;
      }
      schemaHtml += '</tbody></table>';
    } else {
      schemaHtml = '<div style="color:var(--text-dim);font-size:11px;">No parameters.</div>';
    }

    const timeoutSec = Math.round((tool.timeout || 180000) / 1000);
    const modal = document.createElement('div');
    modal.className = 'app-tool-detail-modal';
    modal.innerHTML = `<div class="app-tool-detail-content">
      <div class="app-tool-detail-header"><span>${escHtml(toolName)}</span><button class="app-log-modal-close">&times;</button></div>
      <div class="app-tool-detail-body">
        <div class="app-tool-detail-row"><span class="app-tool-detail-label">Description</span><span>${escHtml(tool.description || '(none)')}</span></div>
        <div class="app-tool-detail-row"><span class="app-tool-detail-label">Exposure</span><span>${exposeBadge(tool.expose)} <span class="tool-expose-callable">${escHtml(exposeMeta(tool.expose).desc)}</span></span></div>
        <div class="app-tool-detail-row"><span class="app-tool-detail-label">Timeout</span><span>${timeoutSec}s</span></div>
        <div class="app-tool-detail-row"><span class="app-tool-detail-label">MCP name</span><code style="font-size:11px;">mcp__app-tools__${escHtml(appName)}__${escHtml(toolName)}</code></div>
        <div class="app-tool-detail-section"><span class="app-tool-detail-label">Input Schema</span>${schemaHtml}</div>
        <div class="tool-expose-note">Tools are never reachable from the internet — loopback only.</div>
      </div>
      <div class="app-tool-detail-footer"><button class="app-tool-edit-btn">Edit This Tool</button></div>
    </div>`;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('.app-log-modal-close').addEventListener('click', close);
    modal.querySelector('.app-tool-edit-btn').addEventListener('click', () => { close(); editSingleTool(appName, toolName); });
  }

  function editSingleTool(appName, toolName) {
    const toolList = apps.tools.get(appName);
    const tool = toolList?.find(t => t.name === toolName);
    sendWs({
      type: 'app:spawnCli',
      name: appName,
      action: 'build-tools',
      toolName,
      toolSchema: tool ? JSON.stringify(tool, null, 2) : null,
      cols: 80,
      rows: 24,
      confirmSlaveEdit: slaveEditConfirmed.has(appName),
    });
  }

  function restartApp(name) {
    sendWs({ type: 'app:restart', name });
  }

  function editTools(name) {
    sendWs({
      type: 'app:spawnCli',
      name,
      action: 'build-tools',
      cols: 80,
      rows: 24,
      confirmSlaveEdit: slaveEditConfirmed.has(name),
    });
  }

  function highlightJson(str) {
    return escHtml(str).replace(
      /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        let cls = 'json-num';
        if (/^"/.test(match)) cls = /:$/.test(match) ? 'json-key' : 'json-str';
        else if (/true|false/.test(match)) cls = 'json-bool';
        else if (/null/.test(match)) cls = 'json-null';
        return `<span class="${cls}">${match}</span>`;
      }
    );
  }

  function buildTestFormHtml(appName, tool) {
    const schema = tool.inputSchema || {};
    const props = schema.properties || {};
    const required = schema.required || [];
    const propNames = Object.keys(props);
    const eName = escHtml(tool.name);
    const eApp = escHtml(appName);

    let fieldsHtml = '';
    if (propNames.length === 0) {
      fieldsHtml = '<div style="color:var(--text-dim);font-size:11px;">No parameters — runs with empty input.</div>';
    } else {
      for (const pName of propNames) {
        const p = props[pName];
        const ePName = escHtml(pName);
        const isReq = required.includes(pName);
        const label = `${ePName}${isReq ? ' <span style="color:var(--orange,#e8a244)">*</span>' : ''}`;
        const placeholder = escHtml(p.description || '');
        const fieldId = `test-${eApp}-${eName}-${ePName}`;

        let inputHtml;
        if (p.type === 'boolean') {
          inputHtml = `<label class="app-tools-test-toggle"><input type="checkbox" id="${fieldId}" data-param="${ePName}" data-ptype="boolean"><span>${ePName}</span></label>`;
        } else if (p.type === 'object' || p.type === 'array') {
          inputHtml = `<textarea id="${fieldId}" data-param="${ePName}" data-ptype="${escHtml(p.type)}" placeholder="${placeholder}" rows="3"></textarea>`;
        } else if (p.type === 'number' || p.type === 'integer') {
          inputHtml = `<input type="number" id="${fieldId}" data-param="${ePName}" data-ptype="number" placeholder="${placeholder}" step="${p.type === 'integer' ? '1' : 'any'}">`;
        } else {
          inputHtml = `<input type="text" id="${fieldId}" data-param="${ePName}" data-ptype="string" placeholder="${placeholder}">`;
        }

        fieldsHtml += `<div class="app-tools-test-field"><label>${label}</label>${inputHtml}</div>`;
      }
    }

    return `<div class="app-tools-test" data-test-app="${eApp}" data-test-tool="${eName}" style="display:none;">
      <div class="app-tools-test-form">${fieldsHtml}</div>
      <div class="app-tools-test-actions">
        <button class="app-tools-test-run" data-test-app="${eApp}" data-test-tool="${eName}">Run</button>
      </div>
      <pre class="app-tools-test-output" data-test-app="${eApp}" data-test-tool="${eName}" style="display:none;"></pre>
    </div>`;
  }

  function collectTestArgs(testSection) {
    const args = {};
    testSection.querySelectorAll('[data-param]').forEach(el => {
      const name = el.dataset.param;
      const ptype = el.dataset.ptype;
      if (ptype === 'boolean') {
        args[name] = el.checked;
      } else if (ptype === 'number') {
        if (el.value !== '') args[name] = Number(el.value);
      } else if (ptype === 'object' || ptype === 'array') {
        if (el.value.trim()) {
          try { args[name] = JSON.parse(el.value); } catch { args[name] = el.value; }
        }
      } else {
        if (el.value !== '') args[name] = el.value;
      }
    });
    return args;
  }

  // The Tools view (settings modal → Tools): legend, one card per tool with
  // schema, Test and Edit, and "+ Add New Tool". `leave` runs before an
  // action that moves to a change session.
  function toolsViewHtml(appName) {
    const toolList = apps.tools.get(appName) || [];
    const isRunning = apps.list.find(a => a.name === appName)?.running;
    let bodyHtml = '';
    if (toolList.length === 0) {
      bodyHtml = '<div class="app-tools-empty">No tools registered. Add a tool to let Claude interact with this app during AI sessions.</div>';
    } else {
      for (const tool of toolList) {
        const schema = tool.inputSchema || {};
        const props = schema.properties || {};
        const required = schema.required || [];
        const propNames = Object.keys(props);

        let schemaHtml = '';
        if (propNames.length > 0) {
          schemaHtml = '<table class="app-tool-schema-table"><thead><tr><th>Parameter</th><th>Type</th><th>Req</th><th>Description</th></tr></thead><tbody>';
          for (const pName of propNames) {
            const p = props[pName];
            schemaHtml += `<tr><td><code>${escHtml(pName)}</code></td><td>${escHtml(p.type || 'any')}</td><td>${required.includes(pName) ? '<span style="color:var(--orange,#e8a244)">yes</span>' : 'no'}</td><td>${escHtml(p.description || '')}</td></tr>`;
          }
          schemaHtml += '</tbody></table>';
        } else {
          schemaHtml = '<div style="color:var(--text-dim);font-size:11px;">No parameters.</div>';
        }

        const timeoutSec = Math.round((tool.timeout || 180000) / 1000);

        bodyHtml += `<div class="app-tools-item">
          <div class="app-tools-item-header">
            <span class="app-tools-item-name">${escHtml(tool.name)} ${exposeBadge(tool.expose)}</span>
            <div class="app-tools-item-btns">
              <button class="app-tools-item-test-toggle" data-tool="${escHtml(tool.name)}" ${isRunning ? '' : 'disabled title="Start the app to test tools"'}>Test</button>
              <button class="app-tools-item-edit" data-tool="${escHtml(tool.name)}">Edit</button>
            </div>
          </div>
          <div class="app-tools-item-desc">${escHtml(tool.description || '(no description)')}</div>
          ${schemaHtml}
          <div class="app-tools-item-meta">
            <code>mcp__app-tools__${escHtml(appName)}__${escHtml(tool.name)}</code>
            <span>timeout: ${timeoutSec}s</span>
          </div>
          ${buildTestFormHtml(appName, tool)}
        </div>`;
      }
    }

    return `${toolList.length > 0 ? exposeLegend() : ''}
      <div class="app-tools-list">${bodyHtml}</div>
      <div class="vc-acts-row"><button class="vc-btn signal app-tools-add-btn">+ Add New Tool</button></div>`;
  }

  function wireToolsView(root, appName, leave) {
    root.querySelectorAll('.app-tools-item-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        leave();
        editSingleTool(appName, btn.dataset.tool);
      });
    });

    root.querySelectorAll('.app-tools-item-test-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const toolName = btn.dataset.tool;
        const testSection = root.querySelector(`.app-tools-test[data-test-tool="${CSS.escape(toolName)}"]`);
        if (!testSection) return;
        const visible = testSection.style.display !== 'none';
        testSection.style.display = visible ? 'none' : '';
        btn.classList.toggle('active', !visible);
      });
    });

    root.querySelectorAll('.app-tools-test-run').forEach(btn => {
      btn.addEventListener('click', () => {
        const toolName = btn.dataset.testTool;
        const testSection = root.querySelector(`.app-tools-test[data-test-tool="${CSS.escape(toolName)}"]`);
        if (!testSection) return;
        const args = collectTestArgs(testSection);
        btn.disabled = true;
        btn.textContent = 'Running...';
        const outputEl = testSection.querySelector('.app-tools-test-output');
        if (outputEl) { outputEl.textContent = ''; outputEl.style.display = 'none'; outputEl.className = 'app-tools-test-output'; }
        sendWs({ type: 'app:tools:test', name: appName, toolName, args });
      });
    });

    root.querySelector('.app-tools-add-btn').addEventListener('click', () => {
      leave();
      editTools(appName);
    });
  }

  function refreshGrid() {
    patchSetupBtn();
    settingsRefresh();
    if (apps.activeTab !== 'grid') return;
    const container = getContainer();
    const gridPanel = container?.querySelector('[data-panel="grid"]');
    if (gridPanel) renderGrid(gridPanel);
  }

  // Populate the direct-model <select> from the live registry catalog (app:models),
  // grouped by provider with deprecated tags, and render the Claude auth line.
  // The catalog arrives already provider-sorted and carries `providerLabel` (see
  // publicModelShape in app-bridge.js), so this renders groups in payload order
  // rather than keeping its own label map or sort.
  function renderDirectModelOptions(models, defaultModel, claudeAuth) {
    const sel = document.getElementById('directModelSelect');
    if (sel) {
      // Server-decided (publicModelShape.usable) — never re-derived here.
      const usable = (models || []).filter(m => m.usable);
      const want = sel.dataset.selected || defaultModel || '';
      const byProv = new Map();
      for (const m of usable) {
        const p = m.provider || 'custom';
        if (!byProv.has(p)) byProv.set(p, { label: m.providerLabel || p, list: [] });
        byProv.get(p).list.push(m);
      }
      let html = '';
      for (const [, { label, list }] of byProv) {
        html += `<optgroup label="${escHtml(label)}">`;
        for (const m of list) {
          const tag = m.lifecycle === 'deprecated' ? ' — deprecated' : '';
          const dflt = m.name === defaultModel ? ' — default' : '';
          html += `<option value="${escHtml(m.name)}">${escHtml(m.label || m.name)}${escHtml(dflt || tag)}</option>`;
        }
        html += '</optgroup>';
      }
      sel.innerHTML = html || '<option value="">No models available</option>';
      if (want && sel.querySelector(`option[value="${CSS.escape(want)}"]`)) sel.value = want;
    }
    const authEl = document.getElementById('directModelClaudeAuth');
    if (authEl) {
      const a = claudeAuth || {};
      let txt;
      if (a.hasSubscription && a.pref === 'subscription') {
        txt = 'Claude calls: <strong>subscription</strong> (Max/Pro).';
      } else {
        txt = 'Claude calls: <strong>API key</strong>.';
      }
      if (a.needsChoice) txt += ' A Claude subscription was detected — choose API vs subscription on the Models page.';
      authEl.innerHTML = txt;
    }
  }

  // --- Setup → AI Config: media model defaults ---------------------------
  // Renders the app:media:catalog payload (ai.mediaModels' shape) as one row per
  // method; every control saves the whole `mediaDefaults` setting through
  // app:settings:set. Which fields a row shows comes from the selected model's
  // capability descriptor (`params`), so a field the model cannot honour is
  // never offered.
  const MEDIA_METHODS = [
    { method: 'ai.tts', kind: 'speech', label: 'Speech (ai.tts)' },
    { method: 'ai.transcribe', kind: 'transcription', label: 'Transcription (ai.transcribe)' },
    { method: 'ai.image', kind: 'image', label: 'Image (ai.image)' },
    { method: 'ai.sfx', kind: 'sfx', label: 'Sound effects (ai.sfx)' },
  ];
  let mediaCat = null;

  function mediaEntry(method, modelId) {
    return (mediaCat?.models || []).find((m) => m.method === method && m.modelId === modelId) || null;
  }

  function renderMediaDefaults(cat) {
    if (cat) mediaCat = cat;
    const rowsEl = document.getElementById('mediaDefaultsRows');
    if (!rowsEl || !mediaCat) return;
    const info = document.getElementById('mediaRefreshInfo');
    const btn = document.getElementById('mediaRefreshBtn');
    if (btn) { btn.disabled = !!mediaCat.refreshing; btn.textContent = mediaCat.refreshing ? 'Refreshing…' : 'Refresh model lists now'; }
    if (info) {
      const errs = Object.entries(mediaCat.lastRefresh?.adapters || {}).filter(([, r]) => r.error).map(([k, r]) => `${k}: ${r.error}`);
      info.innerHTML = (mediaCat.refreshedAt ? `Lists checked ${escHtml(new Date(mediaCat.refreshedAt).toLocaleString())}` : 'Lists not checked yet')
        + (errs.length ? ` — <span title="${escHtml(errs.join('\n'))}" style="color:var(--orange,#e67e22);">${errs.length} listing error(s), last known kept</span>` : '');
    }
    const opt = (v, text, sel) => `<option value="${escHtml(v)}"${sel ? ' selected' : ''}>${escHtml(text)}</option>`;
    const field = (label, html) => `<label class="setup-label" style="display:inline-flex;flex-direction:column;gap:3px;font-size:12px;">${escHtml(label)}${html}</label>`;
    const ctl = 'padding:6px;font:inherit;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);';
    rowsEl.innerHTML = MEDIA_METHODS.map(({ method, label }) => {
      const conf = mediaCat.configured?.[method] || {};
      const eff = mediaCat.defaults?.[method] || {};
      const e = mediaEntry(method, eff.model);
      const d = e?.params || {};
      const honours = new Set(d.params || []);
      const badge = !e ? '<span class="app-model-picker-tag warn">unknown</span>'
        : !e.usable ? `<span class="app-model-picker-tag warn">${escHtml(e.unusableReason === 'missing' ? 'gone at provider' : 'no credential')}</span>`
        : !conf.model ? '<span class="app-model-picker-tag ok">built-in default</span>' : '';
      const facts = e ? [e.price, window.appModelPicker?.mediaFacts(e)].filter(Boolean).join(' · ') : '';
      const fields = [];
      if (method === 'ai.tts' && e) {
        const voices = e.voices || [];
        fields.push(field('Voice', `<span style="display:flex;gap:4px;"><select data-field="voice" style="${ctl}max-width:260px;">`
          + opt('', `Model default (${e.defaultVoice || '—'})`, !conf.voice)
          + voices.map((v) => opt(v.id, [v.name || v.id, [v.language, v.gender, v.description].filter(Boolean).join(', ')].filter(Boolean).join(' — '), String(conf.voice || '').toLowerCase() === String(v.id).toLowerCase())).join('')
          + `</select><button type="button" class="setup-btn" data-act="play" title="Play a sample of this voice">&#9654;</button></span>`));
      }
      if (honours.has('format') && d.formats) fields.push(field('Format', `<select data-field="format" style="${ctl}">${opt('', `Default (${d.defaultFormat})`, !conf.format)}${d.formats.map((f) => opt(f, f, conf.format === f)).join('')}</select>`));
      if (honours.has('speed') && d.speed) fields.push(field(`Speed (${d.speed[0]}–${d.speed[1]})`, `<input type="number" data-field="speed" min="${d.speed[0]}" max="${d.speed[1]}" step="0.05" value="${escHtml(conf.speed ?? '')}" placeholder="1.0" style="${ctl}width:90px;">`));
      if (honours.has('language') || method === 'ai.transcribe') {
        fields.push(Array.isArray(d.languages)
          ? field('Language', `<select data-field="language" style="${ctl}">${opt('', 'Auto', !conf.language)}${d.languages.filter((l) => l !== 'auto').map((l) => opt(l, l, conf.language === l)).join('')}</select>`)
          : field('Language', `<input type="text" data-field="language" value="${escHtml(conf.language || '')}" placeholder="auto (e.g. en, de)" style="${ctl}width:140px;">`));
      }
      if (honours.has('instructions') && d.instructions) fields.push(field('Style instructions', `<input type="text" data-field="instructions" value="${escHtml(conf.instructions || '')}" placeholder="e.g. warm, unhurried" style="${ctl}width:240px;">`));
      if (honours.has('aspectRatio') && d.aspectRatios) fields.push(field('Aspect ratio', `<select data-field="aspectRatio" style="${ctl}">${opt('', 'Default', !conf.aspectRatio)}${d.aspectRatios.map((r) => opt(r, r, conf.aspectRatio === r)).join('')}</select>`));
      if (honours.has('size') && d.sizes) fields.push(field('Size', `<select data-field="size" style="${ctl}">${opt('', 'Default', !conf.size)}${d.sizes.map((z) => opt(z, z, conf.size === z)).join('')}</select>`));
      if (honours.has('durationSeconds') && d.duration) fields.push(field(`Duration (${d.duration[0]}–${d.duration[1]} s)`, `<input type="number" data-field="durationSeconds" min="${d.duration[0]}" max="${d.duration[1]}" step="0.1" value="${escHtml(conf.durationSeconds ?? '')}" placeholder="auto" style="${ctl}width:90px;">`));
      if (honours.has('promptInfluence') && d.influence) fields.push(field(`Prompt influence (${d.influence[0]}–${d.influence[1]})`, `<input type="number" data-field="promptInfluence" min="${d.influence[0]}" max="${d.influence[1]}" step="0.05" value="${escHtml(conf.promptInfluence ?? '')}" placeholder="default" style="${ctl}width:90px;">`));
      if (honours.has('quality') && d.qualities) fields.push(field('Quality', `<select data-field="quality" style="${ctl}">${opt('', 'Default', !conf.quality)}${d.qualities.map((q) => opt(q, q, conf.quality === q)).join('')}</select>`));
      return `<div class="setup-media-row" data-method="${method}" style="padding:10px 12px;border:1px solid var(--border);border-radius:6px;">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <strong style="min-width:190px;">${escHtml(label)}</strong>
          <button type="button" class="setup-btn" data-act="pick" title="Choose the default model">${escHtml(e ? `${e.label} · ${e.providerLabel}` : eff.model || '—')} &#9662;</button>
          ${badge}
          ${conf.model ? '<button type="button" class="setup-btn" data-act="reset" title="Back to the built-in default">Use built-in</button>' : ''}
        </div>
        ${facts ? `<div class="setup-hint" style="margin:4px 0 0;">${escHtml(facts)}${e?.shutdownDate ? ` · <strong>ends ${escHtml(e.shutdownDate)}</strong>` : ''}</div>` : ''}
        ${fields.length ? `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;align-items:flex-end;">${fields.join('')}</div>` : ''}
        <audio data-role="sample" controls style="display:none;margin-top:8px;height:32px;"></audio>
        <div data-role="sample-status" class="setup-hint" style="margin:4px 0 0;"></div>
      </div>`;
    }).join('');
  }

  // Merge one method's change into mediaDefaults and save it (empty fields and
  // empty methods are dropped, so "unset" means the built-in default).
  function pruneMediaDefaults(obj) {
    const out = {};
    for (const [m, row] of Object.entries(obj || {})) {
      const r = {};
      for (const [k, v] of Object.entries(row || {})) if (v !== '' && v != null) r[k] = v;
      if (Object.keys(r).length) out[m] = r;
    }
    return out;
  }
  function saveMediaDefault(method, patch) {
    const all = pruneMediaDefaults({ ...(mediaCat?.configured || {}), [method]: { ...(mediaCat?.configured?.[method] || {}), ...patch } });
    mediaCat.configured = all;
    sendWs({ type: 'app:settings:set', key: 'mediaDefaults', value: Object.keys(all).length ? all : '' });
    flashSetupApplied('mediaDefaultsStatus', 'Saved');
    // The server recomputes effective defaults and descriptors.
    sendWs({ type: 'app:media:catalog:get' });
  }

  function wireMediaDefaults() {
    const rowsEl = document.getElementById('mediaDefaultsRows');
    if (!rowsEl || rowsEl.dataset.wired) return;
    rowsEl.dataset.wired = '1';
    document.getElementById('mediaRefreshBtn')?.addEventListener('click', () => {
      if (mediaCat) { mediaCat.refreshing = true; renderMediaDefaults(); }
      sendWs({ type: 'app:media:refresh' });
    });
    rowsEl.addEventListener('change', (ev) => {
      const el = ev.target.closest('[data-field]');
      const row = ev.target.closest('[data-method]');
      if (!el || !row || !mediaCat) return;
      let v = el.value;
      if (['speed', 'durationSeconds', 'promptInfluence'].includes(el.dataset.field)) v = v === '' ? '' : Number(v);
      saveMediaDefault(row.dataset.method, { [el.dataset.field]: v });
    });
    rowsEl.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-act]');
      const row = ev.target.closest('[data-method]');
      if (!b || !row || !mediaCat) return;
      const method = row.dataset.method;
      const kind = MEDIA_METHODS.find((x) => x.method === method).kind;
      if (b.dataset.act === 'reset') { saveMediaDefault(method, { model: '', voice: '' }); return; }
      if (b.dataset.act === 'pick') {
        if (!window.appModelPicker) return;
        // The Setup modal is fixed-position; the picker mounts in its own layer above it.
        const layer = document.createElement('div');
        layer.style.cssText = 'position:fixed;inset:0;z-index:10000;';
        document.body.appendChild(layer);
        window.appModelPicker.open(layer, {
          kind, title: `Default ${MEDIA_METHODS.find((x) => x.method === method).label} model`,
          models: mediaCat.models.filter((m) => m.method === method),
          defaultName: mediaCat.defaults?.[method]?.model, refreshedAt: mediaCat.refreshedAt,
          onPick: (m) => {
            layer.remove();
            if (!m) return;
            const conf = mediaCat.configured?.[method] || {};
            // The voice belongs to the model: keep it only if the new model offers it.
            const keepVoice = conf.voice && (m.voices || []).some((v) => String(v.id).toLowerCase() === String(conf.voice).toLowerCase());
            saveMediaDefault(method, { model: m.modelId, voice: keepVoice ? conf.voice : '' });
          },
        });
        return;
      }
      if (b.dataset.act === 'play') {
        const eff = mediaCat.defaults?.[method] || {};
        const e = mediaEntry(method, eff.model);
        const voice = row.querySelector('[data-field="voice"]')?.value || e?.defaultVoice;
        const status = row.querySelector('[data-role="sample-status"]');
        const audio = row.querySelector('[data-role="sample"]');
        if (!e || !voice) return;
        const reqId = `vs-${Date.now().toString(36)}`;
        status.textContent = 'Fetching sample…';
        const onSample = (se) => {
          if (se.detail.reqId !== reqId) return;
          window.removeEventListener('vc:mediaSample', onSample);
          if (se.detail.error) { status.textContent = se.detail.error; return; }
          status.textContent = se.detail.cached ? '' : 'Sample generated and cached.';
          audio.src = se.detail.dataUri; audio.style.display = 'block';
          audio.play().catch(() => {});
        };
        window.addEventListener('vc:mediaSample', onSample);
        sendWs({ type: 'app:media:sample', model: e.modelId, voice, reqId });
      }
    });
  }

  function handleMessage(msg) {
    // Spend & permissions admin UI lives in spend-admin.js (loads after this file).
    if (msg.type && msg.type.startsWith('app:spend:') && window.spendAdmin) { window.spendAdmin.onMessage(msg); return; }
    switch (msg.type) {
      case 'app:list':
        apps.list = msg.apps || [];
        refreshGrid();
        sendWs({ type: 'app:grid:meta' });
        break;
      case 'app:grid:meta':
        apps.meta = {
          sizes: msg.sizes || {},
          dbSizes: msg.dbSizes || {},
          dbNames: msg.dbNames || {},
          git: msg.git || {},
          spend: msg.spend || {},
          baseDir: msg.baseDir || apps.meta.baseDir || '',
        };
        if (window.spendAdmin) window.spendAdmin.onGridMeta(apps.meta.spend);
        refreshGrid();
        break;
      case 'app:env':
        apps.env = msg.env;
        break;
      case 'app:emailAccounts':
        if (apps._onEmailAccounts) { apps._onEmailAccounts(msg.accounts || []); }
        break;
      case 'app:accessInfo':
        if (apps._onAccessInfo) { apps._onAccessInfo(msg); }
        break;
      case 'app:domainCheck':
        if (apps._onDomainCheck) { apps._onDomainCheck(msg); }
        break;
      case 'app:site:result':
      case 'app:site':
      case 'app:site:log':
        if (apps._onSiteMsg) { apps._onSiteMsg(msg); }
        break;
      case 'app:analytics:result':
      case 'app:analytics':
        if (apps._onAnalyticsMsg) { apps._onAnalyticsMsg(msg); }
        break;
      case 'app:configSaved':
        if (apps._onConfigSaved) { apps._onConfigSaved(msg.appName); }
        break;
      case 'app:configError':
        if (apps._onConfigError) { apps._onConfigError(msg.appName, msg.error); }
        else showToast({ title: 'Configuration not saved', body: msg.error || '', level: 'error' });
        break;
      case 'app:created':
        if (apps._pendingBuild) {
          const { description } = apps._pendingBuild;
          apps._pendingBuild = null;
          sendWs({
            type: 'app:spawnCli',
            name: msg.appName,
            action: 'build',
            description: description || '',
            initialInput: description || '',
            cols: 80,
            rows: 24,
          });
        }
        break;
      case 'app:rename:preflight':
        if (apps._onRenamePreflight) apps._onRenamePreflight(msg);
        break;
      case 'app:renamed': {
        // The open panel's DOM (iframe src, data-* routing attributes) is keyed
        // by the old name throughout — close the stale tab instead of patching
        // it; the rename stopped the app anyway. Tools re-register on next start.
        closeAppTab(msg.oldName);
        apps.tools.delete(msg.oldName);
        if (apps._onRenamed) apps._onRenamed(msg);
        for (const w of msg.warnings || []) {
          showToast({ appName: msg.newName, title: 'Rename follow-up', message: w, level: 'warning', duration: 12000 });
        }
        break;
      }
      case 'app:starting': {
        const a = apps.list.find(x => x.name === msg.appName);
        if (a) { a._starting = true; a._failed = false; a._failError = null; }
        refreshGrid();
        updateWorkspaceStatus(msg.appName, { health: 'starting', db: 'ok', dbName: null });
        break;
      }
      case 'app:started': {
        apps.needRestart.delete(msg.appName);
        const a = apps.list.find(x => x.name === msg.appName);
        if (a) { a.running = true; a.port = msg.port; a.type = msg.appType || a.type; if (msg.runtime) a.runtime = msg.runtime; a._starting = false; a._failed = false; }
        {
          // The panel's own iframe, wherever the panel sits (home or a desk).
          const iframe = panelOf(msg.appName)?.querySelector(`iframe[data-app-iframe="${CSS.escape(msg.appName)}"]`);
          if (iframe) iframe.src = `/apps/${encodeURIComponent(msg.appName)}/`;
        }
        removeAppPanelPlaceholder(msg.appName);
        setPanelPower(msg.appName, true);
        refreshGrid();
        sendWs({ type: 'app:status', name: msg.appName });
        break;
      }
      case 'app:startFailed': {
        const a = apps.list.find(x => x.name === msg.appName);
        if (a) { a._starting = false; a._failed = true; a._failError = msg.error; a.running = false; a.port = null; }
        const phWrap = panelOf(msg.appName)?.querySelector(`[data-app-placeholder="${CSS.escape(msg.appName)}"]`);
        if (phWrap) {
          phWrap.classList.add('failed');
          const ph = phWrap.querySelector('[data-placeholder-text]');
          if (ph) ph.innerHTML = `Failed to start ${escHtml(msg.appName)}: ${escHtml((msg.error || '').split('\n')[0].slice(0, 160))}`;
        }
        setPanelPower(msg.appName, false);
        refreshGrid();
        updateWorkspaceStatus(msg.appName, { health: 'error', db: 'ok', dbName: null });
        break;
      }
      case 'app:stopped': {
        const a = apps.list.find(x => x.name === msg.appName);
        if (a) { a.running = false; a.port = null; a._starting = false; a._failed = false; }
        if (panelOf(msg.appName)) {
          const iframe = panelOf(msg.appName).querySelector(`iframe[data-app-iframe="${CSS.escape(msg.appName)}"]`);
          if (iframe) iframe.src = 'about:blank';
          showStoppedPlaceholder(msg.appName, !!msg.crashed);
        }
        setPanelPower(msg.appName, false);
        refreshGrid();
        updateWorkspaceStatus(msg.appName, { health: 'stopped', db: 'ok', dbName: null });
        break;
      }
      case 'app:runtimeError':
      case 'app:crashloop': {
        // Attributed failure from the app guard (already coalesced server-side).
        const a = apps.list.find(x => x.name === msg.appName);
        if (a && msg.count) a._errors = msg.count;
        refreshGrid();
        break;
      }
      case 'app:logs':
        renderSettingsLogs(msg.appName, msg.content);
        break;
      case 'app:appmd':
        _handleAppMdResponse(msg);
        break;
      case 'app:cliSpawned':
        if (typeof switchView === 'function') switchView('claude');
        break;
      case 'app:media:catalog': {
        // Answers carrying a reqId are a picker's own (possibly kind-filtered)
        // fetch; the unfiltered ones (Setup, refresh broadcasts) drive the card.
        window.dispatchEvent(new CustomEvent('vc:mediaModels', { detail: msg }));
        if (!msg.reqId) renderMediaDefaults(msg);
        break;
      }
      case 'app:media:sample': {
        window.dispatchEvent(new CustomEvent('vc:mediaSample', { detail: msg }));
        break;
      }
      case 'app:models': {
        const catalog = { models: msg.models || [], default: msg.default, claudeAuth: msg.claudeAuth || {} };
        window.appModelCatalog = catalog;
        renderDirectModelOptions(catalog.models, catalog.default, catalog.claudeAuth);
        window.dispatchEvent(new CustomEvent('vc:models', { detail: catalog }));
        break;
      }
      case 'app:settings': {
        const s = msg.settings || {};
        if (mediaCat && JSON.stringify(pruneMediaDefaults(s.mediaDefaults)) !== JSON.stringify(pruneMediaDefaults(mediaCat.configured))) sendWs({ type: 'app:media:catalog:get' });
        const sel = document.getElementById('directModelSelect');
        if (sel && s.directModel) {
          sel.dataset.selected = s.directModel;
          // Apply now if options are already populated; renderDirectModelOptions
          // re-applies from dataset.selected when the catalog arrives.
          if (sel.querySelector(`option[value="${CSS.escape(s.directModel)}"]`)) sel.value = s.directModel;
        }
        const setVal = (id, v) => { const el = document.getElementById(id); if (el != null && v != null) el.value = v; };
        const en = document.getElementById('memEnabled');
        if (en) en.checked = s.memoryMaintenanceEnabled !== false;
        setVal('memConsolidateBatch', s.memoryConsolidateBatch);
        setVal('memShortTtlDays', s.memoryShortTtlDays);
        setVal('memPromoteHitCount', s.memoryPromoteHitCount);
        setVal('memLedgerRetentionDays', s.memoryLedgerRetentionDays);
        break;
      }
      case 'app:translateKey': {
        const input = document.getElementById('translateKeyInput');
        const status = document.getElementById('translateKeyStatus');
        if (input) input.placeholder = msg.configured ? 'Key set — paste a new one to replace, or clear and Save to remove' : 'Paste Google Translate API key...';
        if (msg.saved) {
          flashSetupApplied('translateKeyStatus', msg.configured ? 'Translate key saved' : 'Translate key cleared');
          if (input) input.value = '';
        } else if (status) {
          status.innerHTML = msg.configured
            ? '<span class="setup-check ok">Dedicated Translate key configured.</span>'
            : (msg.fallback
              ? '<span class="setup-check ok">No dedicated key — using the shared google provider key.</span>'
              : '<span class="setup-check warn">No Translate key and no google provider key. ai.translate will fail until one is set.</span>');
        }
        break;
      }
      case 'app:translateKey:diag': {
        const box = document.getElementById('translateKeyDiag');
        const testBtn = document.getElementById('translateKeyTest');
        if (testBtn) testBtn.disabled = false;
        if (!box) break;
        const d = msg.diag || {};
        const link = (href, label) => `<a href="${escHtml(href)}" target="_blank" rel="noopener">${escHtml(label)}</a>`;
        const proj = d.project ? String(d.project) : '';
        // Project-specific deep links when Google told us the project; else generic.
        const enableLink = proj
          ? link(`https://console.cloud.google.com/apis/library/translate.googleapis.com?project=${encodeURIComponent(proj)}`, 'Enable Cloud Translation API for this project')
          : link('https://console.cloud.google.com/apis/library/translate.googleapis.com', 'Enable the Cloud Translation API');
        const credsLink = proj
          ? link(`https://console.cloud.google.com/apis/credentials?project=${encodeURIComponent(proj)}`, 'open API key restrictions')
          : link('https://console.cloud.google.com/apis/credentials', 'open API key restrictions');
        const billingLink = proj
          ? link(`https://console.cloud.google.com/billing?project=${encodeURIComponent(proj)}`, 'check billing for this project')
          : link('https://console.cloud.google.com/billing', 'check billing');
        const projNote = proj ? `<div style="opacity:.7;margin-top:6px;">Google Cloud project: <code>${escHtml(proj)}</code></div>` : '';
        const usingNote = d.source === 'google-translate'
          ? 'Using the dedicated Translate key.'
          : (d.source === 'google' ? 'Using the shared <strong>google</strong> provider key (no dedicated Translate key set).' : '');
        let html;
        switch (d.state) {
          case 'ok':
            html = `<div class="setup-check ok"><strong>Working.</strong> ${usingNote}</div>`
              + (d.sample ? `<div style="opacity:.7;margin-top:4px;">Sample: "ping" → "${escHtml(d.sample)}"</div>` : '') + projNote;
            break;
          case 'no-key':
            html = `<div class="setup-check warn"><strong>No key configured.</strong> Paste a Google Translate key above, or set the <strong>google</strong> provider key on the Models page.</div>`;
            break;
          case 'api-disabled':
            html = `<div class="setup-check warn"><strong>The Cloud Translation API is not enabled (or is blocked) on this key's project.</strong> ${usingNote}</div>`
              + `<ol style="margin:6px 0 0 18px;padding:0;"><li>${enableLink}.</li><li>Wait ~1 minute for it to propagate, then click <strong>Test connection</strong> again.</li></ol>` + projNote;
            break;
          case 'key-restricted':
            html = `<div class="setup-check warn"><strong>The request reaches Google but the API key blocks it — the key's <em>API restrictions</em> don't include Cloud Translation.</strong> ${usingNote}</div>`
              + `<div style="opacity:.8;margin-top:4px;">This is expected if it's your Gemini key restricted to the Generative Language API. That restriction is why the call shows up in Cloud Monitoring and is then rejected.</div>`
              + `<ol style="margin:6px 0 0 18px;padding:0;"><li>${credsLink}, open this key, and under <strong>API restrictions</strong> either add <strong>Cloud Translation API</strong> to the allowed list or switch to "Don't restrict key".</li><li>Save in Google Cloud, wait ~1 minute, then click <strong>Test connection</strong> again.</li></ol>`
              + `<div style="opacity:.8;margin-top:6px;">Alternatively, create a separate key that allows Cloud Translation and paste it in the field above.</div>` + projNote;
            break;
          case 'invalid-key':
            html = `<div class="setup-check warn"><strong>The API key is invalid.</strong> Double-check you pasted the full key, then Save and re-test.</div>` + projNote;
            break;
          case 'billing':
            html = `<div class="setup-check warn"><strong>Billing isn't active on this project.</strong> Cloud Translation requires billing enabled (it has a free monthly tier). ${billingLink ? 'Please ' + billingLink + '.' : ''}</div>` + projNote;
            break;
          default:
            html = `<div class="setup-check warn"><strong>Translation failed${d.status ? ' (HTTP ' + escHtml(String(d.status)) + ')' : ''}.</strong></div>`
              + (d.message ? `<div style="opacity:.8;margin-top:4px;">${escHtml(d.message)}</div>` : '') + projNote;
        }
        box.style.display = 'block';
        box.innerHTML = html;
        break;
      }
      case 'app:mapsKey': {
        const input = document.getElementById('mapsKeyInput');
        const status = document.getElementById('mapsKeyStatus');
        if (input) input.placeholder = msg.configured ? 'Key set — paste a new one to replace, or clear and Save to remove' : 'Paste Google Maps Platform API key...';
        if (msg.saved) {
          flashSetupApplied('mapsKeyStatus', msg.configured ? 'Maps key saved' : 'Maps key cleared');
          if (input) input.value = '';
        } else if (status) {
          status.innerHTML = msg.configured
            ? '<span class="setup-check ok">Dedicated Maps key configured.</span>'
            : (msg.fallback
              ? '<span class="setup-check ok">No dedicated key — using the Google Translate key.</span>'
              : '<span class="setup-check warn">No Maps key and no Google Translate key. ai.route / ai.geocode / ai.places will fail until one is set.</span>');
        }
        break;
      }
      case 'app:mapsKey:diag': {
        const box = document.getElementById('mapsKeyDiag');
        const testBtn = document.getElementById('mapsKeyTest');
        if (testBtn) testBtn.disabled = false;
        if (!box) break;
        const d = msg.diag || {};
        const link = (href, label) => `<a href="${escHtml(href)}" target="_blank" rel="noopener">${escHtml(label)}</a>`;
        const proj = d.project ? String(d.project) : '';
        const projQ = proj ? `?project=${encodeURIComponent(proj)}` : '';
        const apiMeta = {
          routes: { label: 'Routes API', lib: 'routes.googleapis.com', methods: 'ai.route / ai.routeMatrix' },
          geocoding: { label: 'Geocoding API', lib: 'geocoding-backend.googleapis.com', methods: 'ai.geocode' },
          places: { label: 'Places API (New)', lib: 'places-backend.googleapis.com', methods: 'ai.places' },
        };
        const usingNote = d.source === 'google-maps'
          ? 'Using the dedicated Maps key.'
          : (d.source === 'google-translate' ? 'Using the <strong>Google Translate</strong> key (no dedicated Maps key set).' : '');
        if (d.state === 'no-key') {
          box.style.display = 'block';
          box.innerHTML = `<div class="setup-check warn"><strong>No key configured.</strong> Paste a Google Maps Platform key above, or ensure the Google Translate key is set (same GCP key — just enable the Maps APIs on its project).</div>`;
          break;
        }
        const rows = Object.entries(d.apis || {}).map(([api, a]) => {
          const meta = apiMeta[api] || { label: api, lib: '', methods: '' };
          let detail;
          switch (a.state) {
            case 'ok':
              detail = '<span class="setup-check ok">Working.</span>';
              break;
            case 'api-disabled':
              detail = `<span class="setup-check warn">Not enabled on this key's project.</span> ${meta.lib ? link(`https://console.cloud.google.com/apis/library/${meta.lib}${projQ}`, 'Enable it') + ', wait ~1 minute, then re-test.' : ''}`;
              break;
            case 'key-restricted':
              detail = `<span class="setup-check warn">Blocked by the key's <em>API restrictions</em>.</span> ${link(`https://console.cloud.google.com/apis/credentials${projQ}`, 'Open key restrictions')} and add <strong>${escHtml(meta.label)}</strong> to the allowed list.`;
              break;
            case 'invalid-key':
              detail = '<span class="setup-check warn">The API key is invalid.</span> Double-check you pasted the full key.';
              break;
            case 'billing':
              detail = `<span class="setup-check warn">Billing isn't active on this project.</span> ${link(`https://console.cloud.google.com/billing${projQ}`, 'Check billing')}.`;
              break;
            default:
              detail = `<span class="setup-check warn">Failed.</span>${a.message ? ' ' + escHtml(a.message) : ''}`;
          }
          return `<div style="margin-top:6px;"><strong>${escHtml(meta.label)}</strong> <span style="opacity:.6;">(${escHtml(meta.methods)})</span><div style="margin-top:2px;">${detail}</div></div>`;
        }).join('');
        const head = d.state === 'ok'
          ? `<div class="setup-check ok"><strong>All Maps APIs working.</strong> ${usingNote}</div>`
          : (d.state === 'partial'
            ? `<div class="setup-check warn"><strong>Some Maps APIs need attention.</strong> ${usingNote}</div>`
            : `<div class="setup-check warn"><strong>The Maps APIs aren't reachable with this key yet.</strong> ${usingNote}</div>`);
        const projNote = proj ? `<div style="opacity:.7;margin-top:6px;">Google Cloud project: <code>${escHtml(proj)}</code></div>` : '';
        box.style.display = 'block';
        box.innerHTML = head + rows + projNote;
        break;
      }
      case 'app:braveKey': {
        const input = document.getElementById('braveKeyInput');
        const status = document.getElementById('braveKeyStatus');
        if (input) input.placeholder = msg.configured ? 'Key set — paste a new one to replace, or clear and Save to remove' : 'Paste Brave Search API key...';
        if (msg.saved) {
          flashSetupApplied('braveKeyStatus', msg.configured ? 'Brave Search key saved' : 'Brave Search key cleared');
          if (input) input.value = '';
        } else if (status) {
          status.innerHTML = msg.configured
            ? '<span class="setup-check ok">Brave Search key configured.</span>'
            : '<span class="setup-check warn">No Brave Search key. ai.webSearch will fail until one is set.</span>';
        }
        break;
      }
      case 'app:braveKey:diag': {
        const box = document.getElementById('braveKeyDiag');
        const testBtn = document.getElementById('braveKeyTest');
        if (testBtn) testBtn.disabled = false;
        if (!box) break;
        const d = msg.diag || {};
        let html;
        switch (d.state) {
          case 'ok':
            html = `<div class="setup-check ok"><strong>Working.</strong></div>`
              + (d.sample ? `<div style="opacity:.7;margin-top:4px;">Top result for "ping": "${escHtml(d.sample)}"</div>` : '');
            break;
          case 'no-key':
            html = `<div class="setup-check warn"><strong>No key configured.</strong> Paste a Brave Search API key above (get one at <a href="https://api-dashboard.search.brave.com/" target="_blank" rel="noopener">api-dashboard.search.brave.com</a>).</div>`;
            break;
          case 'invalid-key':
            html = `<div class="setup-check warn"><strong>The API key was rejected${d.status ? ' (HTTP ' + escHtml(String(d.status)) + ')' : ''}.</strong> Double-check you pasted the full key and that your <a href="https://api-dashboard.search.brave.com/app/subscriptions" target="_blank" rel="noopener">Brave subscription</a> is active (the free plan still requires signing up with a card).</div>`
              + (d.message ? `<div style="opacity:.8;margin-top:4px;">${escHtml(d.message)}</div>` : '');
            break;
          case 'rate-limited':
            html = `<div class="setup-check warn"><strong>Rate limit or monthly quota exceeded (HTTP 429).</strong> The key works, but you've hit the plan's limit — wait a moment and re-test, or upgrade the plan in the <a href="https://api-dashboard.search.brave.com/" target="_blank" rel="noopener">Brave dashboard</a>.</div>`;
            break;
          default:
            html = `<div class="setup-check warn"><strong>Search failed${d.status ? ' (HTTP ' + escHtml(String(d.status)) + ')' : ''}.</strong></div>`
              + (d.message ? `<div style="opacity:.8;margin-top:4px;">${escHtml(d.message)}</div>` : '');
        }
        box.style.display = 'block';
        box.innerHTML = html;
        break;
      }
      case 'app:elevenlabsKey': {
        const input = document.getElementById('elevenlabsKeyInput');
        const status = document.getElementById('elevenlabsKeyStatus');
        if (input) input.placeholder = msg.configured ? 'Key set — paste a new one to replace, or clear and Save to remove' : 'Paste ElevenLabs API key...';
        if (msg.saved) {
          flashSetupApplied('elevenlabsKeyStatus', msg.configured ? 'ElevenLabs key saved' : 'ElevenLabs key cleared');
          if (input) input.value = '';
        } else if (status) {
          status.innerHTML = msg.configured
            ? '<span class="setup-check ok">ElevenLabs key configured.</span>'
            : '<span class="setup-check warn">No ElevenLabs key. ai.sfx will fail until one is set.</span>';
        }
        break;
      }
      case 'app:elevenlabsKey:diag': {
        const box = document.getElementById('elevenlabsKeyDiag');
        const testBtn = document.getElementById('elevenlabsKeyTest');
        if (testBtn) testBtn.disabled = false;
        if (!box) break;
        const d = msg.diag || {};
        let html;
        switch (d.state) {
          case 'ok':
            html = `<div class="setup-check ok"><strong>Working.</strong></div>`
              + (d.sample ? `<div style="opacity:.7;margin-top:4px;">${escHtml(d.sample)}</div>` : '');
            break;
          case 'no-key':
            html = `<div class="setup-check warn"><strong>No key configured.</strong> Paste an ElevenLabs API key above (create one at <a href="https://elevenlabs.io/app/developers/api-keys" target="_blank" rel="noopener">elevenlabs.io</a>).</div>`;
            break;
          case 'invalid-key':
            html = `<div class="setup-check warn"><strong>The API key was rejected${d.status ? ' (HTTP ' + escHtml(String(d.status)) + ')' : ''}.</strong> Double-check you pasted the full key and, if it is scope-restricted, that <strong>User: read</strong> and <strong>Sound Effects</strong> access are enabled.</div>`
              + (d.message ? `<div style="opacity:.8;margin-top:4px;">${escHtml(d.message)}</div>` : '');
            break;
          case 'rate-limited':
            html = `<div class="setup-check warn"><strong>Rate limit or quota exceeded (HTTP 429).</strong> The key works, but you've hit the plan's limit — wait a moment and re-test, or check your plan at <a href="https://elevenlabs.io/app/subscription" target="_blank" rel="noopener">elevenlabs.io</a>.</div>`;
            break;
          default:
            html = `<div class="setup-check warn"><strong>Check failed${d.status ? ' (HTTP ' + escHtml(String(d.status)) + ')' : ''}.</strong></div>`
              + (d.message ? `<div style="opacity:.8;margin-top:4px;">${escHtml(d.message)}</div>` : '');
        }
        box.style.display = 'block';
        box.innerHTML = html;
        break;
      }
      case 'app:print:state':
        printSetup.onState(msg);
        break;
      case 'app:memory:status': {
        const el = document.getElementById('memStatus');
        if (el) {
          const st = msg.status || {};
          if (!st.ready) {
            el.innerHTML = '<span style="opacity:.7;">Memory store not ready' + (st.error ? ' — ' + st.error : ' (connect a database in System).') + '</span>';
          } else {
            const last = (st.lastRuns || [])[0];
            const lastTxt = last
              ? `last ${last.job}: ${new Date(last.finished_at || last.started_at).toLocaleString()}${last.affected ? ' (' + last.affected + ' changed)' : ''}`
              : 'no maintenance has run yet (store idle)';
            el.innerHTML =
              `<div>Observations: <strong>${st.observations.total}</strong> (<strong>${st.observations.pending}</strong> pending)</div>` +
              `<div>Facts: <strong>${st.facts.short}</strong> short · <strong>${st.facts.long}</strong> long</div>` +
              `<div>Entities: <strong>${st.entities}</strong> · Provenance ledger: <strong>${st.ledger}</strong> rows</div>` +
              `<div style="opacity:.7;margin-top:4px;">${lastTxt}</div>`;
          }
        }
        break;
      }
      case 'app:memory:runStarted':
        break;
      case 'app:memory:runDone': {
        const btn = document.getElementById('memRunNow');
        if (btn) btn.disabled = false;
        const s = document.getElementById('memRunStatus');
        if (s) {
          if (msg.error) { s.textContent = 'Failed: ' + msg.error; s.className = 'setup-status error'; }
          else flashSetupApplied(s, 'Maintenance complete');
        }
        if (msg.status) handleMessage({ type: 'app:memory:status', status: msg.status });
        break;
      }
      case 'app:error':
        // A failed rename reports into the open rename modal instead of (only)
        // a toast, so the user can correct the name and retry in place.
        if (apps._onRenameError) { apps._onRenameError(msg); break; }
        // Every sender of this is a refused or failed action the user just
        // triggered, so it needs to be visible — it used to be swallowed here.
        if (msg.error) showToast({ appName: msg.appName || 'Apps', title: 'Error', message: msg.error, level: 'error' });
        if (apps.deps) renderAppDeps();   // re-enable an Approve/Revoke the server refused
        refreshGrid();
        break;
      case 'app:slaveEditConfirm':
        confirmSlaveEdit(msg.appName, msg.request);
        break;
      case 'app:fileSaved': {
        // Server-confirmed write — the only place save feedback comes from.
        const mdPane = document.querySelector(`.app-appmd-pane[data-app-name="${CSS.escape(msg.appName || '')}"]`);
        if (mdPane && msg.path === 'APP.md') {
          const btn = mdPane.querySelector('.app-appmd-save');
          if (btn) { btn.textContent = 'Saved'; setTimeout(() => { btn.textContent = 'Save'; }, 1200); }
        }
        const saveCtx = codePanels.get(msg.appName);
        if (saveCtx?.panel && saveCtx.editorFile === msg.path) {
          const fileEl = saveCtx.panel.querySelector('.app-code-file.active');
          if (fileEl) { fileEl.classList.add('saved-flash'); setTimeout(() => fileEl.classList.remove('saved-flash'), 1200); }
        }
        break;
      }
      case 'app:db:status':
        apps.db = { connected: msg.connected, config: msg.config };
        if (msg.connected && apps._dbConnectPending) {
          apps._dbConnectPending = false;
          flashSetupApplied('dbCfgStatus', 'Connected & saved');
        }
        refreshGrid();
        for (const tab of apps.openTabs) {
          if (tab !== '_help' && tab !== '_tools') sendWs({ type: 'app:status', name: tab });
        }
        break;
      case 'app:db:testResult': {
        const el = document.getElementById('dbCfgStatus');
        if (el) {
          el.textContent = msg.ok ? 'Connection successful!' : 'Failed: ' + (msg.error || 'unknown error');
          el.className = 'setup-status ' + (msg.ok ? 'ok' : 'error');
        }
        break;
      }
      case 'app:db:error': {
        const el = document.getElementById('dbCfgStatus');
        if (el) {
          el.textContent = 'Error: ' + (msg.error || 'unknown');
          el.className = 'setup-status error';
        }
        break;
      }
      case 'app:setup:status':
        updateSetupStatus(msg);
        break;
      case 'app:deps':
        apps.deps = { mode: msg.mode, edges: msg.edges || [], health: msg.health || {}, agentGrants: msg.agentGrants || [] };
        renderAppDeps();
        break;
      case 'app:deps:changed':
        requestAppDepsSoon();
        break;
      case 'app:changeRequests': {
        const prev = new Map((apps.changeRequests || []).map((r) => [r.id, r.state]));
        apps.changeRequests = msg.requests || [];
        render();   // the chips on both cards read apps.changeRequests
        renderAppDeps();   // dependency origins link to change requests
        // Terminal outcomes are the owner's only feedback when the asking tab is
        // not in view, so they are said out loud once.
        for (const r of apps.changeRequests) {
          const was = prev.get(r.id);
          if (was && was !== r.state && CR_TERMINAL.has(r.state)) {
            const platformTarget = r.to === 'platform';
            const who = platformTarget ? 'The platform' : `"${r.to}"`;
            // A platform change lives in the source: the running control room
            // still serves the old surface until the owner restarts it.
            const unverified = crUnverified(r);
            const note = unverified ? '' : (platformTarget ? ' (takes effect at the next restart)' : '');
            const line = r.state === 'done'
              ? (unverified
                ? `UNVERIFIED: ${who} reported the change for "${r.from}" as done, but the check did not find it`
                : `${who} reported the change for "${r.from}" as done${note}`)
              : `Change request "${r.from}" → ${platformTarget ? 'the platform' : `"${r.to}"`} ${r.state}`;
            const level = r.state !== 'done' ? 'error' : (unverified ? 'warning' : 'info');
            showToast({ sender: 'Change request', title: line, message: unverified ? (r.verifyDetail || 'not found') : '', level });
          }
        }
        // A pending request must survive a GUI reload: re-open its modal.
        const pending = apps.changeRequests.find((r) => r.state === 'pending');
        if (pending && !document.querySelector('.app-change-request-modal')) showChangeRequestModal(pending.id);
        break;
      }
      case 'app:changeRequest:ask':
        showChangeRequestModal(msg.id);
        break;
      case 'app:extras:status':
        apps.extras = msg.extras || [];
        apps._extrasAsked = true;
        steerUnitySignInTab(apps.extras);
        renderSetupExtras();
        openSetupDeepLink();
        render();   // toolchain chips on the app cards read apps.extras
        if (msg.error) {
          const el = document.getElementById('setupExtrasList');
          if (el) el.insertAdjacentHTML('afterbegin', `<div class="setup-status error" style="margin-bottom:8px;">${escHtml(msg.error)}</div>`);
        }
        break;
      case 'app:setup:connectivityResult':
        if (msg.status === 'checking') {
          apps.connectivity = { status: 'checking', results: [] };
        } else {
          apps.connectivity = { status: 'done', results: msg.results || [] };
        }
        refreshGrid();
        refreshSetupAccountHealth();
        break;
      case 'app:boot:status': {
        const wasBooting = platformBooting();
        apps.bootStatus = { phase: msg.phase, db: msg.db, apps: msg.apps, accounts: msg.accounts };
        refreshGrid();
        if (wasBooting || platformBooting()) updateAppPanelPlaceholders();
        break;
      }
      case 'app:setup:oauthStatus': {
        const statusEl = document.getElementById('oauthStatus');
        const pubEl = document.getElementById('setupGooglePublic');
        if (pubEl) {
          // The platform public URL (Setup → Telegram) is what sign-in links
          // the server builds point back to; when it is not this page's origin
          // the Google client needs both spellings.
          const pub = String(msg.publicUrl || '').replace(/\/+$/, '');
          if (pub && pub !== window.location.origin) {
            const row = (label, val) => `<div class="setup-uri-row"><span class="setup-uri-label">${label}</span><span class="setup-uri-value">${escHtml(val)}</span><button class="setup-copy-btn" data-copy="${escHtml(val)}">Copy</button></div>`;
            pubEl.innerHTML = '<div style="font-size:11px;font-weight:600;margin:8px 0;">Public URL (Setup → Telegram) — also add:</div>'
              + row('JS Origin', pub) + row('Redirect URI', pub + '/pro/auth/google/callback')
              + '<div style="font-size:11px;margin-top:6px;">Register both sets in the Google OAuth client: sign-in links use the public URL, and this page uses its own address.</div>';
          } else pubEl.innerHTML = '';
        }
        const accountsEl = document.getElementById('oauthAccounts');
        const idEl = document.getElementById('oauthClientId');
        const secretEl = document.getElementById('oauthClientSecret');
        const indicator = document.getElementById('oauthSavedIndicator');
        const idToggle = document.getElementById('oauthIdToggle');
        const secretToggle = document.getElementById('oauthSecretToggle');
        if (statusEl) {
          if (msg.configured && apps._oauthSavePending) {
            apps._oauthSavePending = false;
            flashSetupApplied(statusEl, 'Credentials saved');
          } else if (msg.configured) {
            statusEl.innerHTML = '<span class="setup-check ok">Configured</span>';
            statusEl.className = 'setup-status ok';
          } else {
            statusEl.textContent = '';
          }
        }
        if (msg.configured) {
          if (idToggle) idToggle.style.display = '';
          if (secretToggle) secretToggle.style.display = '';
          if (indicator) { indicator.style.display = ''; indicator.innerHTML = '<span class="setup-check ok">Credentials saved</span> — click the <span style="font-size:14px;">&#x1f441;</span> icon to reveal'; }
          if (idEl && !idEl.value) { idEl.value = '••••••••••••••••••••.apps.googleusercontent.com'; idEl.dataset.masked = 'true'; }
          if (secretEl && !secretEl.value) { secretEl.value = '••••••••••••'; secretEl.dataset.masked = 'true'; }
        } else {
          if (idToggle) idToggle.style.display = 'none';
          if (secretToggle) secretToggle.style.display = 'none';
          if (indicator) { indicator.style.display = ''; indicator.innerHTML = '<span style="color:var(--text-muted);">No credentials saved — paste yours above</span>'; }
        }
        if (accountsEl) {
          const connectBtn = msg.configured
            ? `<div style="margin-top:8px;"><button class="setup-btn setup-btn-primary" ${vcAct.attrs('click', 'appsModule.startGoogleConnect', [])}>Connect Google account</button></div>`
            : '';
          if (msg.accounts && msg.accounts.length > 0) {
            accountsEl.innerHTML = '<table class="setup-db-table"><thead><tr><th>Account</th><th>Scopes</th><th></th></tr></thead><tbody>'
              + msg.accounts.map(a =>
                `<tr><td>${escHtml(a.email)}</td><td style="font-size:11px;">${escHtml((a.grantedScopes || []).map(s => s.split('/').pop()).join(', '))}</td><td style="display:flex;gap:4px;"><button class="setup-btn" style="font-size:11px;" ${vcAct.attrs('click', 'appsModule.startGoogleReauth', [a.email])}>Re-authorize</button><button class="setup-btn" style="font-size:11px;" ${vcAct.attrs('click', 'dashboard.sendWs', [{ type: 'app:setup:oauthRevoke', email: a.email }])}>Revoke</button></td></tr>`
              ).join('')
              + '</tbody></table>' + connectBtn;
          } else if (msg.configured) {
            accountsEl.innerHTML = '<div class="setup-hint" style="margin:0;">No accounts connected. Apps will also trigger authorization when they call <code style="font-size:11px;">auth.google.getToken</code>.</div>' + connectBtn;
          } else {
            accountsEl.innerHTML = '';
          }
        }
        break;
      }
      case 'app:setup:oauthReauthUrl': {
        openGoogleReauthPopup(msg.authUrl);
        break;
      }
      case 'app:setup:installProgress': {
        const btn = document.getElementById('setupInstallBtn');
        const stages = { installing: 'Installing MariaDB...', starting: 'Starting service...', configuring: 'Configuring admin user...' };
        if (btn) btn.textContent = stages[msg.stage] || msg.stage;
        break;
      }
      case 'app:setup:installResult': {
        const btn = document.getElementById('setupInstallBtn');
        if (msg.ok) {
          if (btn) { btn.textContent = msg.configured ? 'Installed & configured!' : 'Installed!'; btn.disabled = true; }
          const mariaEl = document.getElementById('setupMariadb');
          if (mariaEl) { mariaEl.textContent = 'Installed'; mariaEl.className = 'setup-check ok'; }
          const wrap = document.getElementById('setupInstallWrap');
          if (wrap) wrap.style.display = 'none';
          if (msg.configured && msg.config) {
            apps.db = { connected: true, config: msg.config };
            // Update auto-setup fields (shown when sudo available)
            const autoUser = document.getElementById('setupAutoUser');
            const autoPass = document.getElementById('setupAutoPass');
            const autoStatus = document.getElementById('setupAutoStatus');
            const autoHint = document.getElementById('setupAutoHint');
            const autoBtn = document.getElementById('setupAutoBtn');
            if (autoUser) autoUser.value = msg.config.user;
            if (autoPass) autoPass.value = msg.config.password;
            if (autoStatus) { autoStatus.innerHTML = '<span class="setup-check ok">Connected (auto-configured)</span>'; autoStatus.className = 'setup-status ok'; }
            if (autoHint) autoHint.innerHTML = '<span class="setup-check ok">Connected</span> &mdash; change password below if needed.';
            if (autoBtn) { autoBtn.textContent = 'Update Password & Reconnect'; autoBtn.disabled = false; }
            // Also update manual fields for consistency
            const hostEl = document.getElementById('dbCfgHost');
            const portEl = document.getElementById('dbCfgPort');
            const userEl = document.getElementById('dbCfgUser');
            const passEl = document.getElementById('dbCfgPass');
            const statusEl = document.getElementById('dbCfgStatus');
            if (hostEl) hostEl.value = msg.config.host;
            if (portEl) portEl.value = msg.config.port;
            if (userEl) userEl.value = msg.config.user;
            if (passEl) passEl.value = msg.config.password;
            if (statusEl) { statusEl.textContent = 'Connected (auto-configured)'; statusEl.className = 'setup-status ok'; }
            // Show auto wrap since we now have sudo + MariaDB
            const autoWrap = document.getElementById('setupAutoWrap');
            if (autoWrap) autoWrap.style.display = '';
            refreshGrid();
          }
        } else {
          if (btn) { btn.textContent = 'Install failed — retry'; btn.disabled = false; }
          const mariaEl = document.getElementById('setupMariadb');
          if (mariaEl) { mariaEl.textContent = 'Install failed: ' + (msg.error || '').slice(0, 60); mariaEl.className = 'setup-check warn'; }
        }
        break;
      }
      case 'app:setup:setupResult': {
        const btn = document.getElementById('setupAutoBtn');
        const statusEl = document.getElementById('setupAutoStatus');
        if (msg.ok && msg.config) {
          if (btn) { btn.textContent = 'Connected!'; btn.disabled = true; }
          flashSetupApplied(statusEl, 'Connected');
          apps.db = { connected: true, config: msg.config };
          const hintEl = document.getElementById('setupAutoHint');
          if (hintEl) hintEl.innerHTML = '<span class="setup-check ok">Connected</span> &mdash; change password below if needed.';
          const passEl = document.getElementById('setupAutoPass');
          if (passEl) passEl.value = msg.config.password;
          const userEl = document.getElementById('setupAutoUser');
          if (userEl) userEl.value = msg.config.user;
          refreshGrid();
        } else {
          if (btn) { btn.textContent = 'Retry'; btn.disabled = false; }
          if (statusEl) { statusEl.textContent = (msg.error || 'Unknown error').split('\n')[0].slice(0, 120); statusEl.className = 'setup-status error'; }
        }
        break;
      }

      // --- Google OAuth test / reveal ---
      case 'app:setup:oauthTestResult': {
        const el = document.getElementById('oauthTestResult');
        if (!el) break;
        if (msg.ok) {
          let checks = '<div class="setup-test-ok"><strong>Setup OK</strong>';
          if (msg.checks) {
            const c = msg.checks;
            checks += '<ul style="margin:6px 0 0;padding-left:18px;">';
            if (c.clientIdFormat) checks += '<li>Client ID format: valid</li>';
            if (c.secretPresent) checks += '<li>Client secret: present</li>';
            if (c.authUrlGenerated) checks += '<li>Auth URL: generated successfully</li>';
            checks += '</ul>';
          }
          checks += '</div>';
          el.innerHTML = checks;
        } else {
          el.innerHTML = `<div class="setup-test-fail"><strong>Setup issue</strong>: ${escHtml(msg.error || 'Unknown error')}</div>`;
        }
        break;
      }
      case 'app:setup:oauthCredentials': {
        const idEl = document.getElementById('oauthClientId');
        const secretEl = document.getElementById('oauthClientSecret');
        const indicator = document.getElementById('oauthSavedIndicator');
        if (msg.clientId && idEl) {
          idEl.dataset.savedId = msg.clientId; idEl.value = msg.clientId; idEl.dataset.masked = 'false';
        }
        if (msg.clientSecret && secretEl) {
          secretEl.dataset.savedSecret = msg.clientSecret; secretEl.value = msg.clientSecret; secretEl.type = 'text'; secretEl.dataset.masked = 'false';
        }
        if (msg.clientId || msg.clientSecret) {
          if (indicator) { indicator.innerHTML = '<span class="setup-check ok">Credentials revealed</span> — click <span style="font-size:14px;">&#x1f441;</span> again to mask'; }
        } else {
          const status = document.getElementById('oauthStatus');
          if (status) { status.textContent = 'No saved credentials found'; status.className = 'setup-status error'; }
        }
        break;
      }

      // --- Email accounts ---
      case 'app:setup:emailList': {
        const el = document.getElementById('emailAccountsList');
        if (!el) break;
        const accounts = msg.accounts || [];
        if (accounts.length === 0) {
          el.innerHTML = '<div class="setup-hint" style="margin:0;">No email accounts configured yet.</div>';
          break;
        }
        const needsTest = [];
        el.innerHTML = '<table class="setup-db-table"><thead><tr><th>Email</th><th>Provider</th><th>IMAP</th><th>Status</th><th></th></tr></thead><tbody>'
          + accounts.map(a => {
            const escaped = escHtml(a.email);
            let status;
            if (a.lastTestedAt && a.lastTestOk) {
              status = '<span class="setup-check ok">OK</span>';
            } else if (a.lastTestedAt && !a.lastTestOk) {
              status = '<span class="setup-check warn">Fail</span>';
              needsTest.push(a.email);
            } else {
              status = '<span class="setup-check testing">testing...</span>';
              needsTest.push(a.email);
            }
            return `<tr data-email-row="${escaped}">
              <td>${escaped}</td>
              <td style="font-size:11px;">${escHtml(a.provider || 'custom')}</td>
              <td style="font-size:11px;">${escHtml(a.imap?.host || '')}:${a.imap?.port || ''}</td>
              <td data-email-status="${escaped}">${status}</td>
              <td style="white-space:nowrap;">
                <button class="setup-btn" style="font-size:11px;" data-email-test="${escaped}" title="Test connection">Test</button>
                <button class="setup-btn" style="font-size:11px;" ${vcAct.attrs('click', 'dashboard.sendWs', [{ type: 'app:setup:emailReveal', email: a.email }])} title="Fill form with account">Edit</button>
                <button class="setup-btn" style="font-size:11px;color:var(--red,#e74c3c);" data-email-remove="${escaped}" title="Remove account">Remove</button>
              </td></tr>`;
          }).join('')
          + '</tbody></table>';
        el.querySelectorAll('[data-email-test]').forEach(btn => {
          btn.addEventListener('click', () => {
            const email = btn.dataset.emailTest;
            const cell = el.querySelector(`[data-email-status="${CSS.escape(email)}"]`);
            if (cell) cell.innerHTML = '<span class="setup-check testing">testing...</span>';
            sendWs({ type: 'app:setup:emailTest', email });
          });
        });
        el.querySelectorAll('[data-email-remove]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const email = btn.dataset.emailRemove;
            if (await showConfirm(`Remove ${email}?`, { confirmLabel: 'Remove', danger: true })) sendWs({ type: 'app:setup:emailRemove', email });
          });
        });
        for (const email of needsTest) {
          sendWs({ type: 'app:setup:emailTest', email });
        }
        break;
      }
      case 'app:setup:emailAddResult': {
        const btn = document.getElementById('emailSaveBtn');
        const status = document.getElementById('emailTestStatus');
        if (msg.ok) {
          if (btn) { btn.textContent = 'Saved!'; setTimeout(() => { btn.textContent = 'Save Account'; btn.disabled = false; }, 2000); }
          flashSetupApplied(status, 'Account saved');
          ['emailAddr', 'emailUser', 'emailPass', 'emailImapHost', 'emailSmtpHost'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
          const provEl = document.getElementById('emailProvider'); if (provEl) provEl.value = '';
          const hintEl = document.getElementById('emailProviderHint'); if (hintEl) hintEl.style.display = 'none';
        } else {
          if (btn) { btn.textContent = 'Save Account'; btn.disabled = false; }
          if (status) { status.innerHTML = `<span class="setup-test-fail">${escHtml(msg.error || 'Failed to save')}</span>`; }
        }
        break;
      }
      case 'app:setup:emailRemoveResult': {
        const status = document.getElementById('emailTestStatus');
        if (msg.ok) {
          if (status) { status.innerHTML = '<span class="setup-test-ok">Account removed.</span>'; }
        } else {
          if (status) { status.innerHTML = `<span class="setup-test-fail">${escHtml(msg.error || 'Failed to remove')}</span>`; }
        }
        break;
      }
      case 'app:setup:emailTestResult': {
        const btn = document.getElementById('emailTestBtn');
        const status = document.getElementById('emailTestStatus');
        if (msg.email) {
          const cell = document.querySelector(`[data-email-status="${CSS.escape(msg.email)}"]`);
          if (cell) {
            cell.innerHTML = msg.ok
              ? '<span class="setup-check ok">OK</span>'
              : `<span class="setup-check warn" title="${escHtml(msg.error || '')}">Fail</span>`;
          }
        }
        if (btn?.disabled && status) {
          btn.textContent = 'Test Connection'; btn.disabled = false;
          if (msg.ok) {
            status.innerHTML = `<span class="setup-test-ok">Connection to ${escHtml(msg.email || '')} succeeded.</span>`;
          } else {
            status.innerHTML = `<span class="setup-test-fail">Connection failed: ${escHtml(msg.error || 'Unknown error')}</span>`;
          }
        }
        break;
      }
      case 'app:setup:emailCredentials': {
        const creds = msg.credentials;
        if (!creds) break;
        const set = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
        set('emailAddr', creds.email);
        set('emailUser', creds.username);
        set('emailPass', creds.password);
        set('emailImapHost', creds.imap?.host);
        set('emailImapPort', creds.imap?.port);
        set('emailSmtpHost', creds.smtp?.host);
        set('emailSmtpPort', creds.smtp?.port);
        const imapTls = document.getElementById('emailImapTls'); if (imapTls && creds.imap) imapTls.checked = creds.imap.tls !== false;
        const smtpTls = document.getElementById('emailSmtpTls'); if (smtpTls && creds.smtp) smtpTls.checked = creds.smtp.tls !== false;
        if (creds.provider) { const provEl = document.getElementById('emailProvider'); if (provEl) provEl.value = creds.provider; }
        const passEl = document.getElementById('emailPass'); if (passEl) passEl.type = 'text';
        break;
      }

      case 'app:setup:emailEngineStatus': {
        // Two shapes arrive under this type: the full status() reply (has
        // .accounts) and per-account live updates from dispatchStatus (has
        // .account). Live updates just trigger a re-query for fresh state.
        if (msg.account && !msg.accounts) {
          if (document.getElementById('emailEngineList')) sendWs({ type: 'app:setup:emailEngineStatus' });
          break;
        }
        renderEmailEngineStatus(msg);
        break;
      }

      case 'app:setup:calendarStatus': {
        renderCalendarSyncStatus(msg);
        break;
      }

      // --- Telegram control bot (dashboard itself) ---
      case 'app:setup:platformTelegramStatus': {
        const el = document.getElementById('ctrlTgBotInfo');
        if (el) {
          if (!msg.configured) {
            el.innerHTML = '<div class="setup-hint" style="margin:0;">No control bot configured.</div>';
          } else {
            const ids = msg.allowedChatIds || [];
            const restricted = !!msg.restricted;
            const accessCell = `
              <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;">
                <input type="checkbox" ${restricted ? 'checked' : ''} ${vcAct.attrs('change', 'dashboard.sendWs', [{ type: 'app:setup:platformTelegramSetRestricted', restricted: { $: 'checked' } }])}>
                Restricted
              </label>
              ${restricted ? `<div style="font-size:10px;color:var(--muted,#888);margin-top:3px;">${
                ids.length
                  ? ids.map(id => `<span style="display:inline-block;margin:1px 3px 1px 0;">${escHtml(String(id))} <a href="#" style="color:var(--red,#e74c3c);text-decoration:none;" title="Remove chat" ${vcAct.attrs('click', 'dashboard.sendWs', [{ type: 'app:setup:platformTelegramRemoveChat', chatId: String(id) }], { prevent: true })}>&times;</a></span>`).join('')
                  : 'Not claimed yet &mdash; use <em>Claim this bot</em>.'
              }</div>
              <div style="margin-top:4px;">
                <button class="setup-btn" style="font-size:11px;" ${vcAct.attrs('click', 'dashboard.sendWs', [{ type: 'app:setup:platformTelegramClaimCode' }])} title="Show a one-time code (10 min) that makes the Telegram user who sends it the owner">${msg.claimed ? 'Claim again' : 'Claim this bot'}</button>
                <div id="ctrlTgClaim" style="font-size:11px;margin-top:4px;"></div>
              </div>` : ''}`;
            el.innerHTML = '<table class="setup-db-table"><thead><tr><th>Bot</th><th>Mode</th><th>Access</th><th></th></tr></thead><tbody>'
              + `<tr>
                  <td style="font-size:11px;">@${escHtml(msg.botUsername || '')}</td>
                  <td style="font-size:11px;">${tgInboundChip(msg, '__platform__')}</td>
                  <td style="vertical-align:top;">${accessCell}</td>
                  <td style="white-space:nowrap;vertical-align:top;">
                    <button class="setup-btn" style="font-size:11px;" ${vcAct.attrs('click', 'dashboard.sendWs', [{ type: 'app:setup:platformTelegramTest' }])} title="Send getMe to Telegram">Test</button>
                    <button class="setup-btn" style="font-size:11px;color:var(--red,#e74c3c);" data-ctrl-tg-remove title="Remove bot">Remove</button>
                  </td></tr>`
              + '</tbody></table>';
            wireTgInboundChips(el);
            el.querySelector('[data-ctrl-tg-remove]')?.addEventListener('click', async () => {
              if (await showConfirm('Remove the Vistaclair control bot?', { confirmLabel: 'Remove', danger: true })) sendWs({ type: 'app:setup:platformTelegramRemove' });
            });
          }
        }
        break;
      }
      case 'app:setup:platformTelegramSetResult': {
        const btn = document.getElementById('ctrlTgSaveBtn');
        const status = document.getElementById('ctrlTgSetStatus');
        if (btn) { btn.disabled = false; btn.textContent = 'Save Control Bot'; }
        if (msg.ok) {
          flashSetupApplied(status, `Connected @${escHtml(msg.botUsername || '')}`);
          const tok = document.getElementById('ctrlTgToken'); if (tok) { tok.value = ''; tok.type = 'password'; }
        } else {
          if (status) status.innerHTML = `<span class="setup-test-fail">${escHtml(msg.error || 'Failed to save bot')}</span>`;
        }
        break;
      }
      case 'app:setup:platformTelegramRemoveResult': {
        const status = document.getElementById('ctrlTgSetStatus');
        if (status) status.innerHTML = msg.ok
          ? '<span class="setup-test-ok">Control bot removed.</span>'
          : `<span class="setup-test-fail">${escHtml(msg.error || 'Failed to remove')}</span>`;
        break;
      }
      case 'app:setup:platformTelegramTestResult': {
        const status = document.getElementById('ctrlTgSetStatus');
        if (status) status.innerHTML = msg.ok
          ? `<span class="setup-test-ok">@${escHtml(msg.result?.username || '')} is reachable.</span>`
          : `<span class="setup-test-fail">${escHtml(msg.error || 'Test failed')}</span>`;
        break;
      }
      case 'app:setup:platformTelegramSetRestrictedResult': {
        const status = document.getElementById('ctrlTgSetStatus');
        if (status && !msg.ok) status.innerHTML = `<span class="setup-test-fail">${escHtml(msg.error || 'Failed to update access')}</span>`;
        else if (status) status.innerHTML = `<span class="setup-test-ok">Access ${msg.restricted ? 'restricted' : 'opened'}.</span>`;
        break;
      }
      case 'app:setup:platformTelegramClaimCodeResult': {
        const status = document.getElementById('ctrlTgSetStatus');
        const box = document.getElementById('ctrlTgClaim');
        if (!msg.ok) {
          if (status) status.innerHTML = `<span class="setup-test-fail">${escHtml(msg.error || 'Could not create a claim code')}</span>`;
          break;
        }
        const mins = Math.max(1, Math.round((msg.expiresAt - Date.now()) / 60000));
        const link = msg.link ? `<a href="${escHtml(msg.link)}" target="_blank" rel="noopener">${escHtml(msg.link)}</a>` : '';
        if (box) box.innerHTML = `${link ? `Open <strong>${link}</strong> on your phone, then press Start.<br>` : ''}Or send <code>/start claim_${escHtml(msg.code)}</code> to the bot in a private chat. Valid ${mins} min, single use.`;
        break;
      }
      case 'app:setup:platformTelegramRemoveChatResult': {
        const status = document.getElementById('ctrlTgSetStatus');
        if (status) status.innerHTML = msg.ok
          ? '<span class="setup-test-ok">Chat removed from allowlist.</span>'
          : `<span class="setup-test-fail">${escHtml(msg.error || 'Failed to remove chat')}</span>`;
        break;
      }

      // --- Telegram bots ---
      case 'app:setup:telegramStatus': {
        tgBoundNames = new Set((msg.bots || []).map(b => b.appName));
        if (typeof window.appsRenderTgAwaiting === 'function') window.appsRenderTgAwaiting();
        const urlEl = document.getElementById('tgPublicUrl');
        if (urlEl && document.activeElement !== urlEl) urlEl.value = msg.publicUrl || '';
        const el = document.getElementById('tgBotsList');
        if (el) {
          const bots = msg.bots || [];
          if (bots.length === 0) {
            el.innerHTML = '<div class="setup-hint" style="margin:0;">No bots configured. Pick an app above and save a token.</div>';
          } else {
            el.innerHTML = '<table class="setup-db-table"><thead><tr><th>App</th><th>Bot</th><th>Mode</th><th>Access</th><th></th></tr></thead><tbody>'
              + bots.map(b => {
                const app = escHtml(b.appName);
                const restricted = !!b.restricted;
                const ids = b.allowedChatIds || [];
                const accessCell = `
                  <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;">
                    <input type="checkbox" ${restricted ? 'checked' : ''} ${vcAct.attrs('change', 'dashboard.sendWs', [{ type: 'app:setup:telegramSetRestricted', appName: app, restricted: { $: 'checked' } }])}>
                    Restricted
                  </label>
                  ${restricted ? `<div style="font-size:10px;color:var(--muted,#888);margin-top:3px;">${
                    ids.length
                      ? ids.map(id => `<span style="display:inline-block;margin:1px 3px 1px 0;">${escHtml(String(id))} <a href="#" style="color:var(--red,#e74c3c);text-decoration:none;" title="Remove chat" ${vcAct.attrs('click', 'dashboard.sendWs', [{ type: 'app:setup:telegramRemoveChat', appName: app, chatId: String(id) }], { prevent: true })}>&times;</a></span>`).join('')
                      : 'Waiting for first message to claim&hellip;'
                  }</div>` : ''}`;
                return `<tr>
                  <td>${app}</td>
                  <td style="font-size:11px;">@${escHtml(b.botUsername || '')}</td>
                  <td style="font-size:11px;">${tgInboundChip(b, b.appName)}</td>
                  <td style="vertical-align:top;">${accessCell}</td>
                  <td style="white-space:nowrap;vertical-align:top;">
                    <button class="setup-btn" style="font-size:11px;" ${vcAct.attrs('click', 'dashboard.sendWs', [{ type: 'app:setup:telegramTest', appName: app }])} title="Send getMe to Telegram">Test</button>
                    <button class="setup-btn" style="font-size:11px;color:var(--red,#e74c3c);" data-tg-remove="${app}" title="Remove bot">Remove</button>
                  </td></tr>`;
              }).join('')
              + '</tbody></table>';
            wireTgInboundChips(el);
            el.querySelectorAll('[data-tg-remove]').forEach(btn => {
              btn.addEventListener('click', async () => {
                const appName = btn.dataset.tgRemove;
                if (await showConfirm(`Remove the bot for ${appName}?`, { confirmLabel: 'Remove', danger: true })) sendWs({ type: 'app:setup:telegramRemove', appName });
              });
            });
          }
        }
        break;
      }
      case 'app:setup:telegramCheckDeliveryResult': {
        // The fresh status re-renders the chip; only a refusal needs words.
        settleTgCheck(msg.appName);
        if (!msg.ok) {
          const status = document.getElementById(msg.appName === '__platform__' ? 'ctrlTgSetStatus' : 'tgSetStatus');
          if (status) status.innerHTML = `<span class="setup-test-fail">${escHtml(msg.error || 'Check failed')}</span>`;
        }
        break;
      }
      case 'app:setup:accountsChanged': {
        // A bot switched webhook ⇄ polling: refresh the Telegram tables if shown.
        if (msg.change === 'telegram.inbound') {
          if (document.getElementById('tgBotsList')) sendWs({ type: 'app:setup:telegramStatus' });
          if (document.getElementById('ctrlTgBotInfo')) sendWs({ type: 'app:setup:platformTelegramStatus' });
        }
        break;
      }
      case 'app:setup:telegramSetResult': {
        const btn = document.getElementById('proTgSaveBtn');
        const status = document.getElementById('tgSetStatus');
        if (btn) { clearTimeout(btn._tgTimeout); btn.disabled = false; btn.textContent = 'Save Bot'; }
        if (msg.ok) {
          flashSetupApplied(status, `Connected @${escHtml(msg.botUsername || '')} to ${escHtml(msg.appName || '')}`);
          const tok = document.getElementById('tgToken'); if (tok) { tok.value = ''; tok.type = 'password'; }
        } else {
          if (status) status.innerHTML = `<span class="setup-test-fail">${escHtml(msg.error || 'Failed to save bot')}</span>`;
        }
        break;
      }
      case 'app:setup:telegramRemoveResult': {
        const status = document.getElementById('tgSetStatus');
        if (status) status.innerHTML = msg.ok
          ? '<span class="setup-test-ok">Bot removed.</span>'
          : `<span class="setup-test-fail">${escHtml(msg.error || 'Failed to remove')}</span>`;
        break;
      }
      case 'app:setup:telegramTestResult': {
        const status = document.getElementById('tgSetStatus');
        if (status) status.innerHTML = msg.ok
          ? `<span class="setup-test-ok">@${escHtml(msg.result?.username || '')} is reachable.</span>`
          : `<span class="setup-test-fail">${escHtml(msg.error || 'Test failed')}</span>`;
        break;
      }
      case 'app:setup:telegramSetRestrictedResult': {
        const status = document.getElementById('tgSetStatus');
        if (status && !msg.ok) status.innerHTML = `<span class="setup-test-fail">${escHtml(msg.error || 'Failed to update access')}</span>`;
        else if (status) status.innerHTML = `<span class="setup-test-ok">Access ${msg.restricted ? 'restricted' : 'opened'} for ${escHtml(msg.appName || '')}.</span>`;
        break;
      }
      case 'app:setup:telegramRemoveChatResult': {
        const status = document.getElementById('tgSetStatus');
        if (status) status.innerHTML = msg.ok
          ? '<span class="setup-test-ok">Chat removed from allowlist.</span>'
          : `<span class="setup-test-fail">${escHtml(msg.error || 'Failed to remove chat')}</span>`;
        break;
      }
      case 'app:setup:telegramSetPublicUrlResult': {
        const btn = document.getElementById('tgPublicUrlBtn');
        const status = document.getElementById('tgPublicUrlStatus');
        if (btn) { btn.disabled = false; btn.textContent = 'Save Public URL'; }
        if (msg.ok) flashSetupApplied(status, msg.publicUrl ? 'Public URL saved' : 'Public URL cleared');
        else if (status) status.innerHTML = `<span class="setup-test-fail">${escHtml(msg.error || 'Failed')}</span>`;
        break;
      }

      // --- WhatsApp (per-app) ---
      case 'app:setup:whatsappStatus': {
        const el = document.getElementById('waAccountsList');
        if (el) {
          const accounts = msg.accounts || [];
          if (accounts.length === 0) {
            el.innerHTML = '<div class="setup-hint" style="margin:0;">No accounts configured. Pick an app above and save credentials.</div>';
          } else {
            const origin = window.location.origin;
            el.innerHTML = accounts.map(a => {
              const app = escHtml(a.appName);
              const restricted = !!a.restricted;
              const ids = a.allowedChatIds || [];
              const callbackUrl = `${origin}/pro/whatsapp/${a.appName}/webhook`;
              const accessChips = restricted
                ? `<div style="font-size:10px;color:var(--muted,#888);margin-top:3px;">${
                    ids.length
                      ? ids.map(id => `<span style="display:inline-block;margin:1px 3px 1px 0;">${escHtml(String(id))} <a href="#" style="color:var(--red,#e74c3c);text-decoration:none;" title="Remove chat" ${vcAct.attrs('click', 'dashboard.sendWs', [{ type: 'app:setup:whatsappRemoveChat', appName: app, chatId: String(id) }], { prevent: true })}>&times;</a></span>`).join('')
                      : 'Waiting for first message to claim&hellip;'
                  }</div>` : '';
              const acctJson = escHtml(JSON.stringify({ appName: a.appName, phoneNumberId: a.phoneNumberId || '', wabaId: a.wabaId || '', displayPhone: a.displayPhone || '' }));
              return `<div class="setup-section wa-account-card" data-wa-account="${acctJson}" title="Click to edit this account">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                  <strong>${app}</strong>
                  <div style="display:flex;align-items:center;gap:6px;">
                    <span style="font-size:11px;color:var(--muted,#888);">${escHtml(a.displayPhone || a.phoneNumberId || '')}${a.verifiedName ? ' &middot; ' + escHtml(a.verifiedName) : ''}</span>
                    <span style="font-size:10px;color:var(--accent,#3b82f6);opacity:.7;">&#9998; Edit</span>
                  </div>
                </div>
                <div style="margin-top:8px;font-size:11px;">
                  <div style="color:var(--muted,#888);margin-bottom:6px;">Paste these into your Meta app under <a href="https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks" target="_blank" style="color:inherit;">WhatsApp &rarr; Configuration &rarr; Webhooks</a>, then subscribe to the <code style="font-size:10px;">messages</code> field.</div>
                  <div style="margin-bottom:4px;"><span style="color:var(--muted,#888);">Callback URL</span><br>
                    <code style="font-size:11px;word-break:break-all;">${escHtml(callbackUrl)}</code>
                    <button class="setup-btn" style="font-size:10px;margin-left:4px;" ${vcAct.attrs('click', 'vcAct.copyText', [callbackUrl, { $: 'this' }], { stop: true })}>Copy</button>
                  </div>
                  <div style="margin-bottom:4px;"><span style="color:var(--muted,#888);">Verify Token</span><br>
                    <code style="font-size:11px;word-break:break-all;">${escHtml(a.verifyToken || '')}</code>
                    <button class="setup-btn" style="font-size:10px;margin-left:4px;" ${vcAct.attrs('click', 'vcAct.copyText', [a.verifyToken || '', { $: 'this' }], { stop: true })}>Copy</button>
                  </div>
                  <div style="margin-bottom:4px;"><span style="color:var(--muted,#888);">Phone Number ID</span><br>
                    <code style="font-size:11px;word-break:break-all;">${escHtml(a.phoneNumberId || '')}</code>
                    <button class="setup-btn" style="font-size:10px;margin-left:4px;" ${vcAct.attrs('click', 'vcAct.copyText', [a.phoneNumberId || '', { $: 'this' }], { stop: true })}>Copy</button>
                  </div>
                  ${a.wabaId ? `<div><span style="color:var(--muted,#888);">WABA ID</span><br>
                    <code style="font-size:11px;word-break:break-all;">${escHtml(a.wabaId)}</code>
                    <button class="setup-btn" style="font-size:10px;margin-left:4px;" ${vcAct.attrs('click', 'vcAct.copyText', [a.wabaId, { $: 'this' }], { stop: true })}>Copy</button>
                  </div>` : ''}
                </div>
                <div style="margin-top:8px;" data-wa-stop>
                  <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;">
                    <input type="checkbox" ${restricted ? 'checked' : ''} ${vcAct.attrs('change', 'dashboard.sendWs', [{ type: 'app:setup:whatsappSetRestricted', appName: app, restricted: { $: 'checked' } }])}>
                    Restricted
                  </label>
                  ${accessChips}
                </div>
                <div style="margin-top:8px;white-space:nowrap;" data-wa-stop>
                  <button class="setup-btn" style="font-size:11px;" ${vcAct.attrs('click', 'dashboard.sendWs', [{ type: 'app:setup:whatsappTest', appName: app }])} title="Read phone number from Cloud API">Test</button>
                  <button class="setup-btn" style="font-size:11px;color:var(--red,#e74c3c);" data-wa-remove="${app}" title="Remove account">Remove</button>
                </div>
              </div>`;
            }).join('');
            // Wire up click-to-edit on account cards
            // Controls inside a card must not open the card's edit form.
            el.querySelectorAll('[data-wa-stop]').forEach(d => d.addEventListener('click', (e) => e.stopPropagation()));
            el.querySelectorAll('.wa-account-card').forEach(card => {
              card.addEventListener('click', () => {
                try {
                  const acctData = JSON.parse(card.dataset.waAccount);
                  if (window._waPopulateForm) window._waPopulateForm(acctData);
                } catch {}
              });
            });
            el.querySelectorAll('[data-wa-remove]').forEach(btn => {
              btn.addEventListener('click', async () => {
                const appName = btn.dataset.waRemove;
                if (await showConfirm(`Remove the WhatsApp account for ${appName}?`, { confirmLabel: 'Remove', danger: true })) sendWs({ type: 'app:setup:whatsappRemove', appName });
              });
            });
          }
        }
        break;
      }
      case 'app:setup:whatsappSetResult': {
        const btn = document.getElementById('waSaveBtn');
        const status = document.getElementById('waSetStatus');
        if (btn) { btn.disabled = false; btn.textContent = 'Save Account'; }
        if (msg.ok) {
          flashSetupApplied(status, `Connected ${escHtml(msg.displayPhone || msg.phoneNumberId || '')} to ${escHtml(msg.appName || '')} — now paste the callback URL + verify token below into Meta`);
          ['waAccessToken', 'waAppSecret'].forEach(idd => { const i = document.getElementById(idd); if (i) { i.value = ''; i.type = 'password'; } });
          const pn = document.getElementById('waPhoneNumberId'); if (pn) pn.value = '';
          const wb = document.getElementById('waWabaId'); if (wb) wb.value = '';
          // Reset edit hints, placeholders, and copy buttons
          const atInp = document.getElementById('waAccessToken'); if (atInp) atInp.placeholder = 'EAAG...';
          const asInp = document.getElementById('waAppSecret'); if (asInp) asInp.placeholder = '32-char app secret';
          const atH = document.getElementById('waAccessTokenHint'); if (atH) atH.style.display = 'none';
          const asH = document.getElementById('waAppSecretHint'); if (asH) asH.style.display = 'none';
          document.querySelectorAll('.wa-field-copy-btn').forEach(b => { b.style.display = 'none'; });
        } else {
          if (status) status.innerHTML = `<span class="setup-test-fail">${escHtml(msg.error || 'Failed to save account')}</span>`;
        }
        break;
      }
      case 'app:setup:whatsappRemoveResult': {
        const status = document.getElementById('waSetStatus');
        if (status) status.innerHTML = msg.ok
          ? '<span class="setup-test-ok">Account removed.</span>'
          : `<span class="setup-test-fail">${escHtml(msg.error || 'Failed to remove')}</span>`;
        break;
      }
      case 'app:setup:whatsappTestResult': {
        const status = document.getElementById('waSetStatus');
        if (status) status.innerHTML = msg.ok
          ? `<span class="setup-test-ok">${escHtml(msg.result?.display_phone_number || 'Number')} is reachable.</span>`
          : `<span class="setup-test-fail">${escHtml(msg.error || 'Test failed')}</span>`;
        break;
      }
      case 'app:setup:whatsappSetRestrictedResult': {
        const status = document.getElementById('waSetStatus');
        if (status && !msg.ok) status.innerHTML = `<span class="setup-test-fail">${escHtml(msg.error || 'Failed to update access')}</span>`;
        else if (status) status.innerHTML = `<span class="setup-test-ok">Access ${msg.restricted ? 'restricted' : 'opened'} for ${escHtml(msg.appName || '')}.</span>`;
        break;
      }
      case 'app:setup:whatsappRemoveChatResult': {
        const status = document.getElementById('waSetStatus');
        if (status) status.innerHTML = msg.ok
          ? '<span class="setup-test-ok">Chat removed from allowlist.</span>'
          : `<span class="setup-test-fail">${escHtml(msg.error || 'Failed to remove chat')}</span>`;
        break;
      }

      // --- Cron jobs ---
      case 'app:setup:cronList': {
        const el = document.getElementById('cronJobsList');
        if (!el) break;
        const jobs = msg.jobs || [];
        if (jobs.length === 0) {
          el.innerHTML = '<div class="setup-hint" style="margin:0;">No cron jobs configured.</div>';
          break;
        }
        el.innerHTML = '<table class="setup-cron-table"><thead><tr><th>Name</th><th>Schedule</th><th>Target</th><th>Last Run</th><th></th></tr></thead><tbody>'
          + jobs.map(j => {
            const target = j.target?.type === 'app-api' ? `${j.target.method || 'POST'} ${escHtml(j.target.app)}${escHtml(j.target.path || '')}` : j.target?.type === 'shell' ? `$ ${escHtml((j.target.command || '').slice(0, 30))}` : j.target?.type === 'ai' ? 'AI prompt' : j.target?.type === 'tool' ? `tool: ${escHtml(j.target.app)}.${escHtml(j.target.tool)}` : '?';
            const lastRun = j.lastRunAt ? new Date(j.lastRunAt).toLocaleString() : 'never';
            const status = j.lastResult === 'ok' ? ' <span class="setup-check ok">ok</span>' : j.lastResult === 'error' ? ' <span class="setup-check warn">err</span>' : '';
            const enabledClass = j.enabled ? '' : ' style="opacity:0.5;"';
            return `<tr${enabledClass}>
              <td>${escHtml(j.name)}</td>
              <td style="font-size:11px;font-family:monospace;">${escHtml(j.schedule)}</td>
              <td style="font-size:11px;">${target}</td>
              <td style="font-size:11px;">${lastRun}${status}</td>
              <td style="white-space:nowrap;">
                <button class="setup-btn" style="font-size:11px;" ${vcAct.attrs('click', 'dashboard.sendWs', [{ type: 'app:setup:cronRun', jobId: j.id }])} title="Run now">Run</button>
                <button class="setup-btn" style="font-size:11px;" ${vcAct.attrs('click', 'dashboard.sendWs', [{ type: `app:setup:cron${j.enabled ? 'Update' : 'Update'}`, jobId: j.id, updates: { enabled: !j.enabled } }])} title="${j.enabled ? 'Disable' : 'Enable'}">${j.enabled ? 'Disable' : 'Enable'}</button>
                <button class="setup-btn" style="font-size:11px;" ${vcAct.attrs('click', 'dashboard.sendWs', [{ type: 'app:setup:cronHistory', jobId: j.id }])} title="History">Log</button>
                <button class="setup-btn" style="font-size:11px;color:var(--red,#e74c3c);" data-cron-remove="${escHtml(j.id)}" title="Delete">Del</button>
              </td></tr>`;
          }).join('')
          + '</tbody></table>';
        el.querySelectorAll('[data-cron-remove]').forEach(btn => {
          btn.addEventListener('click', async () => {
            if (await showConfirm('Delete job?', { confirmLabel: 'Delete', danger: true })) sendWs({ type: 'app:setup:cronRemove', jobId: btn.dataset.cronRemove });
          });
        });
        break;
      }
      case 'app:setup:cronAddResult': {
        const btn = document.getElementById('cronAddBtn');
        const status = document.getElementById('cronAddStatus');
        if (msg.ok) {
          if (btn) { btn.textContent = 'Added!'; setTimeout(() => { btn.textContent = 'Add Job'; btn.disabled = false; }, 2000); }
          flashSetupApplied(status, 'Job added');
          ['cronName', 'cronSchedule'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        } else {
          if (btn) { btn.textContent = 'Add Job'; btn.disabled = false; }
          if (status) { status.innerHTML = `<span class="setup-test-fail">${escHtml(msg.error || 'Failed')}</span>`; }
        }
        break;
      }
      case 'app:setup:cronUpdateResult': {
        const status = document.getElementById('cronAddStatus');
        if (!msg.ok && status) { status.innerHTML = `<span class="setup-test-fail">${escHtml(msg.error || 'Update failed')}</span>`; }
        break;
      }
      case 'app:setup:cronRemoveResult': {
        const status = document.getElementById('cronAddStatus');
        if (msg.ok) {
          if (status) { status.innerHTML = '<span class="setup-test-ok">Job removed.</span>'; }
        } else {
          if (status) { status.innerHTML = `<span class="setup-test-fail">${escHtml(msg.error || 'Failed')}</span>`; }
        }
        break;
      }
      case 'app:setup:cronRunning': {
        const status = document.getElementById('cronAddStatus');
        if (status) { status.innerHTML = `<span class="setup-check loading">Running job...</span>`; }
        break;
      }
      case 'app:setup:cronRunResult': {
        const status = document.getElementById('cronAddStatus');
        if (msg.ok) {
          if (status) { status.innerHTML = `<span class="setup-test-ok">Ran OK${msg.status ? ' (' + msg.status + ')' : ''}</span>`; }
        } else {
          if (status) { status.innerHTML = `<span class="setup-test-fail">Run failed: ${escHtml(msg.error || 'Unknown error')}</span>`; }
        }
        break;
      }
      case 'app:setup:cronHistory': {
        const history = msg.history || [];
        if (history.length === 0) {
          const status = document.getElementById('cronAddStatus');
          if (status) status.innerHTML = '<span style="color:var(--text-muted);">No execution history yet.</span>';
          break;
        }
        const el = document.getElementById('cronJobsList');
        if (!el) break;
        const table = el.querySelector('.setup-cron-table');
        const existing = el.querySelector('.setup-cron-history');
        if (existing) existing.remove();
        const div = document.createElement('div');
        div.className = 'setup-cron-history';
        div.style.cssText = 'margin-top:10px;padding:10px;background:var(--surface,var(--bg));border:1px solid var(--border);border-radius:6px;font-size:12px;max-height:200px;overflow-y:auto;';
        div.innerHTML = '<div style="font-weight:600;margin-bottom:6px;">Execution History (last ' + history.length + ' runs) <button class="setup-btn" style="font-size:10px;float:right;"' + vcAct.attrs('click', 'vcAct.removeAncestor', [{ $: 'this' }, 2]) + '>Close</button></div>'
          + '<table style="width:100%;border-collapse:collapse;"><thead><tr><th style="text-align:left;padding:2px 6px;">Time</th><th style="text-align:left;padding:2px 6px;">Duration</th><th style="text-align:left;padding:2px 6px;">Status</th><th style="text-align:left;padding:2px 6px;">Output</th></tr></thead><tbody>'
          + history.map(h => `<tr>
            <td style="padding:2px 6px;">${new Date(h.startedAt).toLocaleString()}</td>
            <td style="padding:2px 6px;">${h.duration ? h.duration + 'ms' : '-'}</td>
            <td style="padding:2px 6px;">${h.ok ? '<span class="setup-check ok">ok</span>' : '<span class="setup-check warn">error</span>'}</td>
            <td style="padding:2px 6px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(h.output || h.error || '')}">${escHtml((h.output || h.error || '').slice(0, 80))}</td>
          </tr>`).join('')
          + '</tbody></table>';
        el.appendChild(div);
        break;
      }

      // --- AI Config ---
      case 'app:setup:aiConfigResult': {
        const btn = document.getElementById('aiConfigBtn');
        const status = document.getElementById('aiConfigStatus');
        const log = document.getElementById('aiConfigLog');
        if (btn) { btn.textContent = 'Apply'; btn.disabled = false; }
        if (status) status.textContent = '';
        if (msg.ok) flashSetupApplied(status, 'Applied');
        if (log) {
          if (msg.ok) {
            log.innerHTML += `<div class="setup-ai-entry ai">${escHtml(msg.summary || 'Done.')}</div>`;
          } else {
            log.innerHTML += `<div class="setup-ai-entry error">${escHtml(msg.error || 'Unknown error')}${msg.raw ? '<pre style="margin:4px 0 0;font-size:11px;white-space:pre-wrap;">' + escHtml(msg.raw.slice(0, 300)) + '</pre>' : ''}</div>`;
          }
          log.scrollTop = log.scrollHeight;
        }
        break;
      }

      case 'app:status':
        updateWorkspaceStatus(msg.appName, msg);
        if (msg.git) updateWorkspaceGit(msg.appName, msg.git);
        break;
      case 'app:git:status':
        updateWorkspaceGit(msg.appName, msg.git);
        break;
      case 'app:restarting': {
        apps.needRestart.delete(msg.appName);
        const a = apps.list.find(x => x.name === msg.appName);
        if (a) { a.running = false; a._starting = true; }
        refreshGrid();
        updateWorkspaceStatus(msg.appName, { health: 'starting', db: 'ok', dbName: null });
        break;
      }
      case 'app:git:pushResult':
        if (msg.ok) {
          sendWs({ type: 'app:git:status', name: msg.appName || apps.activeTab });
        }
        if (settings) sendWs({ type: 'app:grid:meta' });   // the Git tab's ahead count
        break;
      case 'app:notify':
        showToast({ appName: msg.appName, title: msg.title, body: msg.body, level: msg.level });
        break;
      case 'app:tasks:list':
        apps.tasks = msg.tasks || { spawned: [], cron: [], cli: [] };
        refreshGrid();
        break;
      case 'app:tools:updated':
        if (msg.appName) {
          const list = (msg.tools || []).map(t => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || { type: 'object', properties: {} }, timeout: t.timeout, expose: t.expose || 'self' }));
          if (list.length > 0) apps.tools.set(msg.appName, list);
          else apps.tools.delete(msg.appName);
          refreshGrid();
          const toolsPanel = panelOf('_tools');
          if (toolsPanel && appsHost.isShown('_tools')) refreshToolsPanel(toolsPanel);
        }
        break;
      case 'app:tools:pendingRestart':
        if (msg.appName) {
          apps.needRestart.set(msg.appName, 'Restart to apply tool changes');
          refreshGrid();
        }
        break;
      case 'app:needRestart':
        // Capability revocations are structural (applied when routes.js mounts).
        if (msg.appName) {
          apps.needRestart.set(msg.appName, msg.reason || 'Restart to apply permission changes');
          refreshGrid();
        }
        break;
      case 'app:tools:audit':
        apps.toolsAudit = msg.entries || [];
        refreshAuditIfVisible();
        break;
      case 'app:setup:overviewResult':
        if (apps._onSetupOverview) apps._onSetupOverview(msg);
        break;
      case 'app:tools:auditEvent':
        if (msg.entry) {
          apps.toolsAudit.unshift(msg.entry);
          if (apps.toolsAudit.length > 200) apps.toolsAudit.length = 200;
          refreshAuditIfVisible();
        }
        break;
      case 'app:tools:testResult': {
        const sel = `.app-tools-test[data-test-app="${CSS.escape(msg.appName)}"][data-test-tool="${CSS.escape(msg.toolName)}"]`;
        const testSection = document.querySelector(sel);
        if (!testSection) break;
        const runBtn = testSection.querySelector('.app-tools-test-run');
        if (runBtn) { runBtn.disabled = false; runBtn.textContent = 'Run'; }
        const outputEl = testSection.querySelector('.app-tools-test-output');
        if (outputEl) {
          if (msg.error) {
            outputEl.textContent = 'Error: ' + msg.error;
            outputEl.className = 'app-tools-test-output error';
          } else {
            try {
              outputEl.innerHTML = highlightJson(JSON.stringify(msg.result, null, 2));
            } catch {
              outputEl.textContent = String(msg.result);
            }
            outputEl.className = 'app-tools-test-output';
          }
          outputEl.style.display = '';
        }
        break;
      }
      case 'app:files':
        renderFileList(msg.files || []);
        break;
      case 'app:fileContent':
        renderFileContent(msg.content, msg.path);
        break;
    }
  }

  function gitCommit(name) {
    sendWs({ type: 'app:git:commit', name });
  }

  function gitPush(name) {
    sendWs({ type: 'app:git:push', name });
  }

  // Open a Vistaclair directory tab at the app's folder.
  function openAppDir(name) {
    const base = apps.meta.baseDir;
    if (!base) { sendWs({ type: 'app:grid:meta' }); return; }
    const dir = base.replace(/\/+$/, '') + '/' + name;
    if (typeof switchView === 'function') switchView('directories');
    window.directoriesModule?.openPath?.(dir);
  }

  // --- App settings modal ---------------------------------------------------
  // One modal per app behind the row's ⚙. Header: lamp, status line, runtime,
  // access and the quick actions (Start/Stop, Restart, Open, full screen,
  // Change). A left rail picks the tab; the old per-app modals render INTO the
  // tab (Configure, Tools, APP.md, Logs, Spend & permissions, publish, history,
  // rename) — nothing stacks on top of it except a vc-dialog confirmation.
  // Renders from server state only (apps.list / meta / tools / needRestart,
  // publishModule.state.fleet); refreshGrid and patchRemoteChips call
  // settingsRefresh(), so it follows the app live while open.

  const SETTINGS_TAB_KEY = 'vc.appSettings.tab';   // sessionStorage: last tab
  const sIc = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  const S_ICONS = {
    overview: sIc('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
    tools: sIc('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
    md: sIc('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
    logs: sIc('<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>'),
    config: sIc('<path d="M4 6h10"/><path d="M18 6h2"/><circle cx="16" cy="6" r="2"/><path d="M4 12h4"/><path d="M12 12h8"/><circle cx="10" cy="12" r="2"/><path d="M4 18h12"/><path d="M20 18h0"/><circle cx="18" cy="18" r="2"/>'),
    spend: sIc('<circle cx="12" cy="12" r="9"/><path d="M14.5 9.5a2.5 2.5 0 0 0-5 0c0 3 5 2 5 5a2.5 2.5 0 0 1-5 0"/><path d="M12 6v1.5"/><path d="M12 16.5V18"/>'),
    git: sIc('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7"/><path d="M18 10.5c0 4-6 3-11 6"/>'),
    remote: sIc('<path d="M12 17V7"/><path d="m7 12 5-5 5 5"/><path d="M4 21h16"/>'),
    danger: sIc('<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6"/><path d="M14 11v6"/>'),
    folder: sIc('<path d="M4 20h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-7.5l-2-2H4a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1Z"/>'),
    expand: sIc('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>'),
  };
  // Rail order. Tools / APP.md / Logs are Overview's own views (indented).
  const SETTINGS_RAIL = [
    { key: 'overview', label: 'Overview' },
    { key: 'tools', label: 'Tools', sub: true },
    { key: 'appmd', label: 'APP.md', icon: 'md', sub: true },
    { key: 'logs', label: 'Logs', sub: true },
    { key: 'config', label: 'Config' },
    { key: 'sites', label: 'Sites', when: (app) => !!app.sites && typeof app.sites === 'object' && Object.keys(app.sites).length > 0 },
    { key: 'spend', label: 'Spend &amp; permissions' },
    { key: 'git', label: 'Git' },
    { key: 'remote', label: 'Remote' },
    { key: 'danger', label: 'Danger', cls: 'danger' },
  ];
  const SETTINGS_TABS = new Set(SETTINGS_RAIL.map((r) => r.key));

  function remoteNeedsAttention(name) {
    const info = remoteInfo(name);
    return !!info && info.rows.some((r) => slaveDotState(r) === 'behind');
  }

  // The tab that answers the app's most pressing issue, if any.
  function settingsIssueTab(app) {
    if (app._failed || app._crashed) return app.hasServer ? 'logs' : 'overview';
    if (apps.needRestart.has(app.name)) return 'config';
    if (remoteNeedsAttention(app.name)) return 'remote';
    if (apps.meta.spend?.[app.name]?.paused) return 'spend';
    return null;
  }

  // Per-app settings: ⚙ in the apps table, and every former entry point of
  // the per-app modals (showAppActions, showTools, showLogs, showAppMd,
  // showGitModal, editDescription, the spend cell).
  function openAppSettings(name, tab) {
    const app = apps.list.find((a) => a.name === name);
    if (!app) return;
    if (tab && !SETTINGS_TABS.has(tab)) tab = null;
    if (settings && settings.name === name) { showSettingsTab(tab || settings.tab); return; }
    if (settings) settings.close();
    hideRemoteTip();
    let stored = null;
    try { stored = sessionStorage.getItem(SETTINGS_TAB_KEY); } catch {}
    const first = tab || settingsIssueTab(app) || (SETTINGS_TABS.has(stored) ? stored : 'overview');
    const { overlay, close } = openConsole('app-settings-modal', `<div class="vc-console cfg settings"><i class="vc-tick"></i>
      <div class="vc-chead">
        <div><div class="vc-eyebrow">app &middot; settings</div><h3>${escHtml(name)}</h3><div class="vc-sub" data-s="sub"></div></div>
        <div class="vc-sacts" data-s="acts"></div>
        <button class="vc-close" aria-label="Close">${VC_X}</button>
      </div>
      <div class="vc-sbanner" data-s="banner"></div>
      <div class="vc-cbody">
        <nav class="vc-rail" data-s="rail"></nav>
        <div class="vc-main" data-s="main"></div>
      </div>
      <div class="vc-cfoot" data-s="foot" style="display:none"></div>
    </div>`, () => {
      if (!settings || settings.overlay !== overlay) return;
      try { settings.detach?.(); } catch {}
      settings = null;
    });
    settings = { name, tab: null, overlay, close, main: overlay.querySelector('[data-s="main"]'), foot: overlay.querySelector('[data-s="foot"]'), detach: null, refresh: null };
    overlay.addEventListener('click', onSettingsClick);
    renderSettingsHead(app);
    showSettingsTab(first);
  }

  function onSettingsClick(e) {
    const el = e.target.closest('[data-sact]');
    if (!el || el.disabled || !settings) return;
    const name = settings.name;
    const act = el.dataset.sact;
    const leave = (fn) => { settings.close(); fn(); };
    const busy = (text) => { el.disabled = true; el.textContent = text; };
    switch (act) {
      case 'start': busy('Starting…'); toggleApp(name, true); break;
      case 'stop': stopAppConfirm(name); break;
      case 'restart': busy('Restarting…'); restartApp(name); break;
      case 'open': leave(() => openApp(name)); break;
      case 'fullscreen': leave(() => openFullScreen(name)); break;
      case 'change': leave(() => openCli(name)); break;
      case 'dir': leave(() => openAppDir(name)); break;
      default: if (act.startsWith('tab:')) showSettingsTab(act.slice(4));
    }
  }

  function settingsRailState(app, key) {
    const name = app.name;
    switch (key) {
      case 'tools': { const n = (apps.tools.get(name) || []).length; return n ? `<span class="n">${n}</span>` : ''; }
      case 'logs': return app._failed || app._crashed || app._errors ? '<span class="st warn"></span>' : '';
      case 'config': return apps.needRestart.has(name) ? '<span class="st warn" title="Restart needed"></span>' : '';
      case 'spend': { const sp = apps.meta.spend?.[name]; return sp && (sp.paused || sp.blocked) ? '<span class="st warn"></span>' : ''; }
      case 'git': { const g = apps.meta.git[name]; return g && g.dirty ? '<span class="st warn" title="Uncommitted changes"></span>' : ''; }
      case 'remote': {
        const info = remoteInfo(name);
        if (!info || !info.rows.length) return '';
        return remoteNeedsAttention(name) ? '<span class="st warn"></span>' : '<span class="st ok"></span>';
      }
      default: return '';
    }
  }

  function renderSettingsHead(app) {
    const s = settings;
    if (!s) return;
    const q = (k) => s.overlay.querySelector(`[data-s="${k}"]`);
    const name = app.name;
    const sc = appStatusClass(app);
    const standalone = app.standalone === true;
    const rt = standalone ? 'standalone' : appRuntimeOf(app) === 'own-process' ? 'own process' : 'in-process';
    q('sub').innerHTML = `<span class="vc-lamp ${sc}"></span>${renderCardTele(app, sc)}<span class="sep">&middot;</span>${rt}<span class="sep">&middot;</span>${accessOf(app).level}${app.platformContribution === false ? '<span class="sep">&middot;</span>independent' : ''}`;

    const b = (act, label, o = {}) => `<button class="vc-btn${o.cls ? ' ' + o.cls : ''}" data-sact="${act}" title="${escHtml(o.title || '')}"${o.disabled ? ' disabled' : ''}>${label}</button>`;
    const acts = [];
    if (standalone) acts.push(b('start', '&#9654; Start', { disabled: true, title: 'Standalone: started and stopped outside the platform (pm2)' }));
    else if (app._starting) acts.push(b('start', 'Starting…', { disabled: true, title: 'The app is starting' }));
    else if (app.running) acts.push(b('stop', '&#9632; Stop', { title: 'Stop the app' }), b('restart', '&#8635; Restart', { title: 'Restart the app' }));
    else if (app._failed || app._crashed) acts.push(b('restart', '&#8635; Restart', { cls: 'danger', title: 'Restart the app' }));
    else acts.push(b('start', '&#9654; Start', { title: 'Start the app without opening it' }));
    const live = app.running || standalone;
    acts.push(b('open', live ? 'Open &#8599;' : 'Open &#9654;', { cls: 'primary', title: app.display === 'fullscreen' ? 'Open in a chrome-free tab' : live ? 'Open the app' : 'Start and open the app' }));
    acts.push(b('fullscreen', S_ICONS.expand, { cls: 'icon', title: 'Open full screen (chrome-free tab)' }));
    acts.push(b('change', 'Change', { disabled: standalone, title: standalone ? 'Standalone apps are changed outside the platform' : isMasterMirror(app) ? 'Change with AI — mirror, edits are temporary' : 'Change with AI' }));
    q('acts').innerHTML = acts.join('');

    const banner = [];
    const nr = apps.needRestart.get(name);
    if (nr) banner.push(`<div class="vc-callout warn"><span>&#8635; Restart needed &mdash; ${escHtml(nr)}</span>${app.running || app._failed || app._crashed ? '<button class="vc-btn" data-sact="restart">Restart now</button>' : ''}</div>`);
    if ((app._failed && app._failError) || app._crashed) banner.push(`<div class="vc-callout bad"><span>${app._failed ? `Failed to start: ${escHtml(String(app._failError).split('\n')[0].slice(0, 160))}` : 'The app crashed.'}</span>${app.hasServer ? '<button class="vc-btn" data-sact="tab:logs">Logs</button>' : ''}</div>`);
    q('banner').innerHTML = banner.join('');
    q('banner').style.display = banner.length ? '' : 'none';

    q('rail').innerHTML = SETTINGS_RAIL.filter((r) => !r.when || r.when(app)).map((r) => {
      const icon = S_ICONS[r.icon || r.key];
      return `<button data-sact="tab:${r.key}" class="${[r.sub ? 'sub' : '', r.cls || '', s.tab === r.key ? 'on' : ''].filter(Boolean).join(' ')}"><span class="ico">${icon}</span>${r.label}${settingsRailState(app, r.key)}</button>`;
    }).join('');
  }

  function showSettingsTab(tab) {
    const s = settings;
    if (!s) return;
    if (!SETTINGS_TABS.has(tab)) tab = 'overview';
    const rail = SETTINGS_RAIL.find((r) => r.key === tab);
    if (rail?.when && !rail.when(apps.list.find((a) => a.name === s.name) || {})) tab = 'overview';
    try { s.detach?.(); } catch {}
    s.detach = null; s.refresh = null; s.tab = tab;
    try { sessionStorage.setItem(SETTINGS_TAB_KEY, tab); } catch {}
    s.overlay.querySelectorAll('[data-s="rail"] button').forEach((b) => b.classList.toggle('on', b.dataset.sact === 'tab:' + tab));
    s.main.scrollTop = 0;
    s.main.innerHTML = `<div class="vc-pane on" data-pane="${tab}"></div>`;
    const pane = s.main.firstElementChild;
    const app = apps.list.find((a) => a.name === s.name);
    const r = SETTINGS_PANES[tab](s.name, pane, app);
    if (r) { s.detach = r.detach || null; s.refresh = r.refresh || null; }
  }

  function settingsRefresh() {
    const s = settings;
    if (!s) return;
    const app = apps.list.find((a) => a.name === s.name);
    if (!app) { s.close(); return; }   // deleted or renamed
    renderSettingsHead(app);
    if (s.refresh) s.refresh(app);
  }

  const paneHead = (title, intro, right = '') => `<div class="vc-shead"><div><h4>${title}</h4>${intro ? `<p class="vc-intro">${intro}</p>` : ''}</div>${right}</div>`;

  // Overview: metrics, description (edited in place), the tools list and the
  // shortcuts (Tools, APP.md, Logs, Open directory, Open full screen).
  function paneOverview(name, pane) {
    let editing = false;
    pane.innerHTML = `${paneHead('Overview')}
      <div class="vc-stats" data-ov="stats"></div>
      <div class="vc-panel" data-ov="desc"></div>
      <div class="vc-panel"><div class="vc-ph"><span class="vc-lbl">inspect &amp; open</span></div><div class="vc-mlist" data-ov="links"></div></div>
      <div class="vc-panel" data-ov="tools"></div>`;
    const el = (k) => pane.querySelector(`[data-ov="${k}"]`);
    const stat = (act, label, value, sub, o = {}) => `<${act ? `button data-sact="${act}"` : 'div'} class="vc-stat${o.cls ? ' ' + o.cls : ''}" title="${escHtml(o.title || '')}"><span class="vc-lbl">${label}</span><b>${value}</b><span class="s">${sub || '&nbsp;'}</span></${act ? 'button' : 'div'}>`;

    const draw = (app) => {
      const disk = apps.meta.sizes[name];
      const db = apps.meta.dbSizes[name];
      const dbName = apps.meta.dbNames[name];
      const sp = apps.meta.spend?.[name];
      const errs = app._errors || 0;
      el('stats').innerHTML = [
        stat('dir', 'disk', disk != null ? escHtml(formatBytes(disk)) : '–', 'open directory &#8599;', { title: 'Open the app directory in a tab' }),
        stat(null, 'database', db != null ? escHtml(formatBytes(db)) : 'none', db != null ? escHtml(dbName || '') : 'not provisioned', { title: db != null ? `Database: ${dbName || '?'}` : 'No database provisioned' }),
        stat('tab:spend', 'spend today', sp ? `${Math.round(Number(sp.today) || 0).toLocaleString()} cr` : '–', sp ? escHtml(`${sp.preset}${sp.paused ? ' · paused' : ''}${sp.blocked ? ` · ${sp.blocked} refused` : ''}`) : 'policy', { cls: sp && (sp.paused || sp.blocked) ? 'warn' : '', title: 'Spend & permissions' }),
        stat(app.hasServer ? 'tab:logs' : null, 'runtime errors', String(errs), errs ? (app.hasServer ? 'see logs' : 'recorded') : 'none', { cls: errs ? 'bad' : '', title: errs ? `${errs} runtime error${errs === 1 ? '' : 's'} recorded` : 'No runtime errors' }),
      ].join('');

      if (!editing) {
        el('desc').innerHTML = `<div class="vc-ph"><span class="vc-lbl">description</span><span class="right"><button class="vc-btn ghost sm" data-ov-edit>Edit</button></span></div>
          <div class="vc-row col"><div class="ov-desc">${app.description ? escHtml(app.description) : '<span class="vc-hint">No description yet.</span>'}</div></div>`;
      }

      const tools = apps.tools.get(name) || [];
      const mi = (act, icon, label, desc, disabled) => `<button class="vc-mi" data-sact="${act}"${disabled ? ' disabled' : ''}><span class="ico">${icon}</span><b>${label}</b><span>${desc}</span></button>`;
      el('links').innerHTML = [
        mi('tab:tools', S_ICONS.tools, 'Tools', escHtml(`${tools.length} mcp${depCountsDesc(name)}`)),
        mi('tab:appmd', S_ICONS.md, 'APP.md', app.hasAppMd ? 'spec' : 'create spec'),
        mi('tab:logs', S_ICONS.logs, 'Logs', app.hasServer ? 'server output' : 'no server process', !app.hasServer),
        mi('dir', S_ICONS.folder, 'Open directory', 'files in a tab'),
        mi('fullscreen', S_ICONS.expand, 'Open full screen', 'chrome-free tab'),
      ].join('');

      el('tools').innerHTML = `<div class="vc-ph"><span class="vc-lbl">tools &middot; ${tools.length}</span><span class="right"><button class="vc-btn ghost sm" data-sact="tab:tools">Manage tools &rarr;</button></span></div>
        ${tools.length ? tools.map((t) => `<div class="vc-row"><div class="t"><b>${escHtml(t.name)}</b><span>${escHtml(t.description || '(no description)')}</span></div>${exposeBadge(t.expose)}</div>`).join('')
          : '<div class="vc-row col"><div class="vc-hint">No MCP tools. Add one under Tools to let AI sessions, Horst or other apps use this app.</div></div>'}`;
    };

    pane.addEventListener('click', (e) => {
      if (e.target.closest('[data-ov-edit]')) {
        const app = apps.list.find((a) => a.name === name);
        editing = true;
        el('desc').innerHTML = `<div class="vc-ph"><span class="vc-lbl">description</span></div>
          <div class="vc-row col"><textarea class="vc-inp ov-desc-input" rows="4">${escHtml(app?.description || '')}</textarea>
          <div class="vc-acts-row"><span class="sp"></span><button class="vc-btn ghost" data-ov-cancel>Cancel</button><button class="vc-btn signal" data-ov-save>Save</button></div></div>`;
        const ta = el('desc').querySelector('textarea');
        ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length;
      } else if (e.target.closest('[data-ov-cancel]')) {
        editing = false;
        draw(apps.list.find((a) => a.name === name));
      } else if (e.target.closest('[data-ov-save]')) {
        const description = el('desc').querySelector('textarea').value.trim();
        sendWs({ type: 'app:updateDesc', name, description });
        editing = false;
        el('desc').innerHTML = `<div class="vc-ph"><span class="vc-lbl">description</span><span class="right vc-hint">saving&hellip;</span></div><div class="vc-row col"><div class="ov-desc">${escHtml(description)}</div></div>`;
      }
    });
    draw(apps.list.find((a) => a.name === name));
    return { refresh: draw };
  }

  // Tools: the former Tools modal (exposure legend, schema, test, edit, add).
  function paneTools(name, pane) {
    let sig = '';
    const sigOf = () => JSON.stringify([apps.tools.get(name) || [], !!apps.list.find((a) => a.name === name)?.running]);
    const draw = () => {
      sig = sigOf();
      pane.innerHTML = paneHead('Tools', 'MCP tools this app exposes. Exposure decides who may call them: its own AI sessions, Horst and cron, or other apps too. Test runs need the app running.')
        + toolsViewHtml(name);
      wireToolsView(pane, name, () => settings?.close());
    };
    draw();
    // Redraw on a real change only, and never under an open test form.
    return { refresh: () => { if (sigOf() !== sig && !pane.querySelector('.app-tools-item-test-toggle.active')) draw(); } };
  }

  // APP.md: the spec editor (Monaco, or a textarea when it cannot load).
  let _appMdEditor = null;
  function paneAppMd(name, pane) {
    pane.innerHTML = paneHead('APP.md', 'The app&rsquo;s spec: what it is for and how it works. Change sessions and Horst read it.')
      + `<div class="app-appmd-pane" data-app-name="${escHtml(name)}"><div class="vc-hint">Loading&hellip;</div></div>`;
    _pendingAppMdName = name;
    sendWs({ type: 'app:appmd', name });
    return { detach: () => { if (_appMdEditor) { try { _appMdEditor.dispose(); } catch {} _appMdEditor = null; } } };
  }

  // Logs: the server output; reloads on Refresh and when the run state changes.
  function paneLogs(name, pane, app) {
    if (!app.hasServer) {
      pane.innerHTML = paneHead('Logs') + '<div class="vc-callout">This app has no server process, so there is no server output. Errors from its pages show in the Overview&rsquo;s runtime errors.</div>';
      return null;
    }
    pane.innerHTML = paneHead('Logs', 'Server output, newest at the bottom.', '<button class="vc-btn" data-logs-refresh>Refresh</button>')
      + '<pre class="vc-logs">Loading&hellip;</pre>';
    const pre = pane.querySelector('.vc-logs');
    const runState = (a) => `${!!a.running}|${!!a._starting}|${!!a._failed}|${!!a._crashed}|${a._errors || 0}`;
    let last = runState(app);
    const load = () => { pre.textContent = 'Loading…'; sendWs({ type: 'app:logs', name }); };
    pane.querySelector('[data-logs-refresh]').addEventListener('click', load);
    load();
    return { refresh: (a) => { const st = runState(a); if (st !== last) { last = st; load(); } } };
  }

  function renderSettingsLogs(appName, content) {
    if (!settings || settings.name !== appName || settings.tab !== 'logs') return;
    const pre = settings.main.querySelector('.vc-logs');
    if (!pre) return;
    pre.textContent = content || '(no logs)';
    pre.scrollTop = pre.scrollHeight;
  }

  function paneConfig(name, pane) {
    return { detach: mountAppConfig(name, pane, settings.foot) };
  }

  // Sites: the app's own web servers (docs/sites.md). One section per declared
  // site, built once; status, log tail, crashes and snapshots then follow the
  // app:site / app:site:log broadcasts — no polling. Replies carry our reqId.
  const SITE_DOT = { running: 'ok', starting: 'warn', stopping: 'warn', backoff: 'warn', crashed: 'bad', error: 'bad', stopped: 'dim' };
  const SITE_LOG_MAX = 200;

  function siteFmtUp(ms) {
    const s = Math.floor((ms || 0) / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  }

  function siteFmtClock(t) {
    try { return new Date(t).toLocaleTimeString(); } catch { return ''; }
  }

  // One compact status line (state dot, port, uptime, req/s, memory, crashes, fence).
  function siteStatusLine(st) {
    const bits = [`<b>${escHtml(st.state)}</b>`];
    if (st.port) bits.push(`:${st.port}`);
    if (st.state === 'running') {
      bits.push(`up ${siteFmtUp(st.uptimeMs)}`, `${st.reqPerSec || 0} req/s`);
      if (st.mem != null) bits.push(escHtml(formatBytes(st.mem)));
    }
    if (st.state === 'backoff' && st.nextRetryAt) bits.push(`retry in ${Math.max(0, Math.round((st.nextRetryAt - Date.now()) / 1000))}s`);
    if (st.crashCount) bits.push(`<span class="warn">${st.crashCount} crash${st.crashCount === 1 ? '' : 'es'}</span>`);
    bits.push(st.fence === 'fenced' ? '<span class="ok">fenced</span>' : '<span class="warn">unfenced</span>');
    return `<span class="vc-site-dot ${SITE_DOT[st.state] || 'dim'}"></span>${bits.join(' &middot; ')}`;
  }

  // <vc-analytics> is not in the dashboard page: load its script on first use.
  let vcAnalyticsLoad = null;
  function loadVcAnalytics() {
    if (window.customElements && window.customElements.get('vc-analytics')) return Promise.resolve();
    if (!vcAnalyticsLoad) {
      vcAnalyticsLoad = new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = '/pro/vc-analytics.js';
        el.onload = () => resolve();
        el.onerror = () => { vcAnalyticsLoad = null; reject(new Error('could not load the analytics component')); };
        document.head.appendChild(el);
      });
    }
    return vcAnalyticsLoad;
  }

  function paneSites(name, pane) {
    pane.innerHTML = paneHead('Sites', 'The app&rsquo;s own web servers. Each runs on its own port as a child of the dashboard and stops with it.')
      + '<div class="vc-sites" data-sx-root><div class="vc-hint">Loading&hellip;</div></div>';
    const root = pane.querySelector('[data-sx-root]');
    const views = new Map();   // site -> { el, st, q }
    let meta = { fenceMinNode: null, node: '' };
    let gone = false;
    let seq = 0;
    const pending = new Map();
    const liveSubs = new Map();   // event -> Set<fn>: analytics:live pushes for the mounted components
    const req = (type, extra = {}) => new Promise((resolve) => {
      const reqId = 'sx' + (++seq);
      pending.set(reqId, resolve);
      sendWs({ type, name, reqId, ...extra });
    });

    const setStatus = (v, st) => {
      if (!st) return;
      v.st = st;
      v.q('status').innerHTML = siteStatusLine(st);
      const err = v.q('err');
      err.textContent = st.lastError ? `Last error: ${st.lastError}` : '';
      err.style.display = st.lastError ? '' : 'none';
      const fence = v.q('fence');
      fence.textContent = st.fence === 'unfenced' && meta.fenceMinNode ? `Node ≥ ${meta.fenceMinNode} fences the site (this host runs ${meta.node || 'an older Node'}).` : '';
      fence.style.display = fence.textContent ? '' : 'none';
      const live = st.state === 'running' || st.state === 'starting' || st.state === 'backoff' || st.state === 'crashed';
      v.q('start').disabled = st.state === 'running' || st.state === 'starting' || st.state === 'stopping';
      v.q('stop').disabled = !live && st.state !== 'error';
      v.q('restart').disabled = st.state === 'stopping';
    };

    const setForm = (v, st) => {
      const f = (k) => v.el.querySelector(`[data-sx-f="${k}"]`);
      f('port').value = st.port != null ? st.port : '';
      f('bind').value = st.bind || '127.0.0.1';
      f('autostart').checked = st.autostart !== false;
      f('keep').value = st.keep != null ? st.keep : 5;
      f('domain').value = st.domain || '';
      f('analyticsRawDays').value = st.analyticsRawDays != null ? st.analyticsRawDays : 90;
      f('analyticsMonths').value = st.analyticsMonths != null ? st.analyticsMonths : 13;
      for (const el of v.el.querySelectorAll('[data-sx="anaf"]')) el.style.display = st.analytics ? '' : 'none';
    };

    // The analytics block of one site: the component on the dashboard's own WS, no polling.
    const transport = {
      call: (method, params) => req('app:analytics:call', { method, site: params && params.site, params: params ? Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'site')) : {} })
        .then((m) => { if (m.error) { const e = new Error(m.error); e.code = m.code; throw e; } return m.result; }),
      on: (ev, fn) => {
        if (!liveSubs.has(ev)) liveSubs.set(ev, new Set());
        liveSubs.get(ev).add(fn);
        return () => { const set = liveSubs.get(ev); if (set) set.delete(fn); };
      },
    };
    const mountAnalytics = async (v) => {
      const st = v.st;
      const holder = v.q('analytics');
      const note = v.q('anastate');
      if (!st.analytics) {
        holder.textContent = '';
        v.anaMounted = false;
        note.innerHTML = `Off. Turn it on with <code>"analytics": true</code> under <code>sites.${escHtml(st.site)}</code> in the manifest. No cookies, no IP addresses stored.`;
        return;
      }
      if (v.anaMounted) return;
      v.anaMounted = true;
      let info = null;
      try { info = (await transport.call('status', { site: st.site })); } catch { /* shown by the component */ }
      if (gone) return;
      const bits = [];
      if (info) {
        if (!info.db) bits.push('<span class="warn">No database on this host: requests are kept in the spool, statistics need a configured database.</span>');
        if (info.geo && !info.geo.available) bits.push('Country table not built yet (countries show as unknown until the monthly refresh).');
        if (info.credit && info.credit.url) bits.push(`<a href="${escHtml(info.credit.url)}" target="_blank" rel="noopener">${escHtml(info.credit.text)}</a>`);
      }
      note.innerHTML = bits.join(' &middot; ');
      try { await loadVcAnalytics(); } catch (e) { holder.innerHTML = `<div class="vc-hint warn">${escHtml(e.message)}</div>`; v.anaMounted = false; return; }
      if (gone) return;
      const comp = document.createElement('vc-analytics');
      comp.setAttribute('site', st.site);
      comp.transport = transport;
      holder.textContent = '';
      holder.appendChild(comp);
    };

    const addLines = (v, lines) => {
      const box = v.q('log');
      const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
      for (const l of lines || []) {
        const line = document.createElement('div');
        line.className = 'vc-site-ll' + (l.level === 'err' || l.level === 'error' ? ' err' : '');
        line.textContent = `${siteFmtClock(l.t)}  ${l.text}`;
        box.appendChild(line);
      }
      while (box.childElementCount > SITE_LOG_MAX) box.firstElementChild.remove();
      if (stick) box.scrollTop = box.scrollHeight;
    };

    const drawCrashes = (v, crashes) => {
      const el = v.q('crashes');
      if (!crashes.length) { el.innerHTML = '<div class="vc-hint">No crashes recorded.</div>'; return; }
      el.innerHTML = crashes.map((c) => `<div class="vc-site-li"><span>${escHtml(new Date(c.at).toLocaleString())}</span><span>${escHtml(c.signal ? `signal ${c.signal}` : `exit ${c.code}`)}${c.uptimeMs != null ? ` after ${escHtml(siteFmtUp(c.uptimeMs))}` : ''}</span>${c.error ? `<code>${escHtml(String(c.error).slice(0, 200))}</code>` : ''}</div>`).join('');
    };

    const drawSnaps = (v, snaps) => {
      const el = v.q('snaps');
      if (!snaps.length) { el.innerHTML = '<div class="vc-hint">No snapshots yet. The app publishes one with <code>ctx.sites.publish</code>.</div>'; return; }
      el.innerHTML = snaps.map((s) => `<div class="vc-site-li"><span>${escHtml(new Date(s.at).toLocaleString())}${s.active ? ' <b class="ok">active</b>' : ''}</span><span>${s.files} files &middot; ${escHtml(formatBytes(s.bytes))}${s.note ? ' &middot; ' + escHtml(s.note) : ''}</span>${s.active ? '' : `<button class="vc-btn" data-sx-act="rollback" data-sx-id="${escHtml(s.id)}">Rollback</button>`}</div>`).join('');
    };

    const drawNginx = (v, text) => {
      v.q('nginx').textContent = text || '';
      v.q('copy').innerHTML = `<button class="vc-btn" type="button" ${vcAct.attrs('click', 'vcAct.copyText', [text || '', { $: 'this' }])}>Copy</button>`;
    };

    const loadDetail = async (v) => {
      const msg = await req('app:site:detail', { site: v.st.site });
      if (gone || msg.error || !msg.result) return;
      const d = msg.result;
      setStatus(v, d.status);
      drawCrashes(v, d.crashes || []);
      drawSnaps(v, d.snapshots || []);
      drawNginx(v, d.nginx);
      v.q('log').textContent = '';
      addLines(v, d.logs || []);
      v.q('log').scrollTop = v.q('log').scrollHeight;
    };

    const build = (st) => {
      const el = document.createElement('section');
      el.className = 'vc-site';
      el.dataset.site = st.site;
      const s = escHtml(st.site);
      el.innerHTML = `
        <div class="vc-shead"><div><h4>${s}</h4></div>
          <div class="vc-acts-row"><button class="vc-btn" data-sx-act="start">&#9654; Start</button><button class="vc-btn" data-sx-act="stop">&#9632; Stop</button><button class="vc-btn" data-sx-act="restart">&#8635; Restart</button></div></div>
        <div class="vc-panel">
          <div class="vc-row col">
            <div class="vc-site-status" data-sx="status"></div>
            <div class="vc-hint warn" data-sx="err" style="display:none"></div>
            <div class="vc-hint" data-sx="fence" style="display:none"></div>
          </div>
          <div class="vc-row col">
            <div class="vc-site-form">
              <div class="vc-field"><label>port</label><input type="number" min="1024" max="65535" class="vc-inp" data-sx-f="port"></div>
              <div class="vc-field"><label>bind</label><select class="vc-inp" data-sx-f="bind"><option value="127.0.0.1">127.0.0.1</option><option value="0.0.0.0">0.0.0.0</option></select></div>
              <div class="vc-field"><label>keep snapshots</label><input type="number" min="1" max="50" class="vc-inp" data-sx-f="keep"></div>
              <div class="vc-field"><label>autostart</label><label class="vc-site-check"><input type="checkbox" data-sx-f="autostart"> with the dashboard</label></div>
              <div class="vc-field vc-site-wide"><label>domain</label><input type="text" class="vc-inp" data-sx-f="domain" placeholder="optional, e.g. www.example.com" autocomplete="off" spellcheck="false"></div>
              <div class="vc-field" data-sx="anaf"><label>raw hits kept (days)</label><input type="number" min="7" max="365" class="vc-inp" data-sx-f="analyticsRawDays"></div>
              <div class="vc-field" data-sx="anaf"><label>daily totals kept (months)</label><input type="number" min="1" max="36" class="vc-inp" data-sx-f="analyticsMonths"></div>
            </div>
            <div><button class="vc-btn signal" data-sx-act="save">Save</button> <span class="vc-hint" data-sx="msg"></span></div>
          </div>
          <div class="vc-row col">
            <span class="vc-lbl">analytics</span>
            <div class="vc-hint" data-sx="anastate"></div>
            <div data-sx="analytics"></div>
          </div>
          <div class="vc-row col">
            <span class="vc-lbl">domain &amp; nginx</span>
            <div class="vc-hint">Optional &mdash; only for a host with a reverse proxy (nginx). The site already serves on its port and at <code>/s/${escHtml(name)}/${s}/</code> on this dashboard.</div>
            <pre class="vc-code" data-sx="nginx"></pre>
            <div><span data-sx="copy"></span> <button class="vc-btn" data-sx-act="check">Check</button></div>
            <div class="vc-hint" data-sx="checkout"></div>
          </div>
          <div class="vc-row col"><span class="vc-lbl">log</span><div class="vc-site-log" data-sx="log"></div></div>
          <div class="vc-row col"><span class="vc-lbl">crashes</span><div data-sx="crashes"></div></div>
          <div class="vc-row col"><span class="vc-lbl">snapshots</span><div data-sx="snaps"></div></div>
        </div>`;
      const q = (k) => (['start', 'stop', 'restart'].includes(k) ? el.querySelector(`[data-sx-act="${k}"]`) : el.querySelector(`[data-sx="${k}"]`));
      return { el, st, q };
    };

    const act = async (v, btn) => {
      const a = btn.dataset.sxAct;
      const site = v.st.site;
      const msgEl = v.q('msg');
      if (a === 'start' || a === 'stop' || a === 'restart') {
        btn.disabled = true;
        const m = await req('app:site:' + a, { site });
        if (gone) return;
        if (m.error) { msgEl.textContent = m.error; btn.disabled = false; return; }
        setStatus(v, m.result);
      } else if (a === 'save') {
        const f = (k) => v.el.querySelector(`[data-sx-f="${k}"]`);
        const next = { port: Number(f('port').value), bind: f('bind').value, autostart: f('autostart').checked, keep: Number(f('keep').value), domain: f('domain').value.trim(), analyticsRawDays: Number(f('analyticsRawDays').value), analyticsMonths: Number(f('analyticsMonths').value) };
        const patch = {};
        for (const k of Object.keys(next)) {
          const cur = k === 'domain' ? (v.st.domain || '') : v.st[k];
          if ((k === 'analyticsRawDays' || k === 'analyticsMonths') && !v.st.analytics) continue;
          if (next[k] !== cur) patch[k] = next[k];
        }
        if (!Object.keys(patch).length) { msgEl.textContent = 'No changes.'; return; }
        btn.disabled = true;
        msgEl.textContent = 'Saving…';
        const m = await req('app:site:settings', { site, patch });
        if (gone) return;
        btn.disabled = false;
        if (m.error) { msgEl.textContent = m.error; return; }
        msgEl.textContent = 'Saved.';
        setStatus(v, m.result);
        setForm(v, m.result);
        loadDetail(v);
      } else if (a === 'rollback') {
        btn.disabled = true;
        const m = await req('app:site:rollback', { site, id: btn.dataset.sxId });
        if (gone) return;
        if (m.error) { msgEl.textContent = m.error; btn.disabled = false; return; }
        loadDetail(v);
      } else if (a === 'check') {
        const out = v.q('checkout');
        btn.disabled = true;
        out.textContent = 'Checking…';
        const m = await req('app:site:checkDomain', { site, domain: v.el.querySelector('[data-sx-f="domain"]').value.trim() });
        if (gone) return;
        btn.disabled = false;
        const r = m.result;
        if (m.error || !r) { out.innerHTML = `<span class="warn">&#9888; ${escHtml(m.error || 'Check failed.')}</span>`; return; }
        out.innerHTML = `<span class="${r.ok ? 'ok' : 'warn'}">${r.ok ? '&#10003;' : '&#9888;'} ${escHtml(r.text)}</span>`;
      }
    };

    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sx-act]');
      const sec = btn && btn.closest('.vc-site');
      const v = sec && views.get(sec.dataset.site);
      if (v) act(v, btn);
    });

    apps._onAnalyticsMsg = (msg) => {
      if (gone || msg.appName !== name) return;
      if (msg.type === 'app:analytics:result') {
        const done = pending.get(msg.reqId);
        if (done) { pending.delete(msg.reqId); done(msg); }
        return;
      }
      if (msg.type === 'app:analytics') for (const fn of liveSubs.get(msg.event) || []) { try { fn(msg.data); } catch { /* a component's own error */ } }
    };

    apps._onSiteMsg = (msg) => {
      if (gone || msg.appName !== name) return;
      if (msg.type === 'app:site:result') {
        const done = pending.get(msg.reqId);
        if (done) { pending.delete(msg.reqId); done(msg); }
        return;
      }
      const v = views.get(msg.site);
      if (!v) return;
      if (msg.type === 'app:site:log') { addLines(v, msg.lines); return; }
      if (msg.type !== 'app:site') return;
      setStatus(v, msg.status);
      if (msg.event === 'site:crashed' || msg.event === 'site:published') loadDetail(v);
    };

    req('app:sites:list').then((msg) => {
      if (gone) return;
      if (msg.error || !msg.result) { root.innerHTML = `<div class="vc-callout bad">${escHtml(msg.error || 'Could not read the sites.')}</div>`; return; }
      meta = { fenceMinNode: msg.result.fenceMinNode, node: msg.result.node };
      root.textContent = '';
      for (const st of msg.result.sites || []) {
        const v = build(st);
        views.set(st.site, v);
        root.appendChild(v.el);
        setForm(v, st);
        setStatus(v, st);
        loadDetail(v);
        mountAnalytics(v);
      }
      if (!views.size) root.innerHTML = '<div class="vc-hint">This app declares no sites.</div>';
    });

    return { detach: () => { gone = true; pending.clear(); liveSubs.clear(); if (apps._onSiteMsg) apps._onSiteMsg = null; if (apps._onAnalyticsMsg) apps._onAnalyticsMsg = null; } };
  }

  function paneSpend(name, pane) {
    pane.innerHTML = paneHead('Spend &amp; permissions', 'What this app may cost you and which platform capabilities it keeps. Policies are yours, stored on this host outside the app folder.')
      + '<div class="vc-spend-host"></div>';
    const host = pane.querySelector('.vc-spend-host');
    if (!window.spendAdmin?.mountPolicy) { host.innerHTML = '<div class="vc-hint">Spend admin is not loaded.</div>'; return null; }
    return { detach: window.spendAdmin.mountPolicy(name, host) };
  }

  // Git: what the row's git badge shows, with Commit / Push / Refresh.
  function paneGit(name, pane) {
    const draw = () => {
      const git = apps.meta.git[name];
      const clean = !git || (!git.dirty && !(git.ahead > 0));
      const rows = git ? [
        ['Branch', git.branch || '?'],
        ['Modified', String(git.modified)],
        ['Untracked', String(git.untracked)],
        ['Staged', String(git.staged)],
        ['Ahead / behind', `${git.ahead} ↑  ${git.behind} ↓`],
      ] : [['Status', 'No repository / not loaded yet']];
      pane.innerHTML = paneHead('Git', 'The app&rsquo;s repository. Commit reviews the changes with AI; Publish (Remote) ships committed code.')
        + `<div class="vc-panel">${rows.map(([k, v]) => `<div class="vc-row"><div class="t"><b>${escHtml(k)}</b></div><code class="vc-val">${escHtml(v)}</code></div>`).join('')}
          ${git && clean ? '<div class="vc-row"><div class="vc-hint">Working tree clean</div></div>' : ''}</div>
        <div class="vc-acts-row">
          ${git && git.dirty ? '<button class="vc-btn signal" data-git="commit" title="Review &amp; commit the changes with AI">Commit&hellip;</button>' : ''}
          ${git && git.ahead > 0 ? `<button class="vc-btn" data-git="push">Push ${git.ahead} commit${git.ahead === 1 ? '' : 's'}</button>` : ''}
          <button class="vc-btn ghost" data-git="refresh">Refresh</button>
        </div>`;
    };
    pane.addEventListener('click', (e) => {
      const b = e.target.closest('[data-git]');
      if (!b) return;
      if (b.dataset.git === 'commit') { settings?.close(); gitCommit(name); }
      else if (b.dataset.git === 'push') { b.disabled = true; b.textContent = 'Pushing…'; gitPush(name); }
      else { b.disabled = true; sendWs({ type: 'app:grid:meta' }); }
    });
    draw();
    return { refresh: draw };
  }

  // Remote: per-slave state (what the slaves dots' tooltip shows), Publish
  // and per-slave History / rollback — both from publish.js, rendered here.
  function paneRemote(name, pane, app) {
    const pm = window.publishModule;
    pane.innerHTML = paneHead('Remote', 'This app on the linked slaves: channel, deployed commit, how far behind, health and the last job.', '<button class="vc-btn signal" data-rm="publish">Publish&hellip;</button>')
      + '<div data-rm-el="state"></div><div data-rm-el="flow"></div>';
    const stateEl = pane.querySelector('[data-rm-el="state"]');
    const flowEl = pane.querySelector('[data-rm-el="flow"]');
    const pubBtn = pane.querySelector('[data-rm="publish"]');
    let flowClose = null;
    let gone = false;
    const exitFlow = () => { flowClose = null; if (gone) return; stateEl.style.display = ''; pubBtn.style.display = ''; draw(); };
    const startFlow = (fn) => { stateEl.style.display = 'none'; pubBtn.style.display = 'none'; flowClose = fn({ mount: flowEl, onExit: exitFlow }); };

    const draw = () => {
      if (flowClose) return;
      if (!pm) { pubBtn.style.display = 'none'; stateEl.innerHTML = '<div class="vc-hint">Publishing is not loaded.</div>'; return; }
      if (!pm.isMaster()) {
        pubBtn.style.display = 'none';
        stateEl.innerHTML = `<div class="vc-callout">This host is a <strong>slave</strong>. ${app.deployed ? 'This app is a mirror published from the master: publish, history and rollback run there.' : 'Publishing runs on a master.'}</div>`;
        return;
      }
      const fleet = pm.state?.fleet || [];
      const info = remoteInfo(name);
      if (!fleet.length || !info) {
        stateEl.innerHTML = '<div class="vc-callout">No slave is linked yet. Link one in <strong>Setup &rarr; Remote</strong>; Publish shows how.</div>';
        return;
      }
      const rows = fleet.map((f) => {
        const r = info.rows.find((x) => x.peer === f.name);
        const seen = f.connected ? 'live' : (f.lastSeen ? `down · seen ${fmtAgo(f.lastSeen)}` : 'never connected');
        if (!r) {
          return `<div class="vc-row"><i class="apps-slave none${f.connected ? '' : ' off'}"></i><div class="t"><b>${escHtml(f.name)}</b><span>${escHtml(seen)} &middot; not published there</span></div></div>`;
        }
        const rev = r.behind > 0 ? `<span class="warn">${r.behind} commit${r.behind === 1 ? '' : 's'} behind</span>`
          : r.behind === 0 ? '<span class="ok">current</span>' : 'revision not compared yet';
        const health = r.disabled ? 'disabled there' : r.health === 'ok' ? '<span class="ok">healthy</span>'
          : r.health === 'unknown' ? 'health unknown' : `<span class="warn">${escHtml(r.health)}</span>`;
        const job = r.job && r.job.status !== 'done' ? `<span>${escHtml(r.job.name)}: <span class="${r.job.status === 'failed' ? 'warn' : ''}">${escHtml(r.job.status)}</span>${r.job.error ? ' — ' + escHtml(String(r.job.error).slice(0, 160)) : ''}</span>` : '';
        return `<div class="vc-row"><i class="apps-slave ${slaveDotState(r)}"></i><div class="t"><b>${escHtml(r.peer)}</b>
          <span>${escHtml(seen)} &middot; <code>${escHtml(String(r.commit || '').slice(0, 8) || '—')}</code> &middot; ${rev} &middot; ${health}</span>${remoteSitesLine(r, 'vc-remote-sites')}${job}</div>
          <button class="vc-btn" data-rm="history" data-peer="${escHtml(r.peer)}" title="Versions this slave keeps — roll back without a new publish">History &amp; rollback</button></div>`;
      });
      stateEl.innerHTML = `<div class="vc-panel vc-remote">${rows.join('')}</div>`;
    };

    pane.addEventListener('click', (e) => {
      const b = e.target.closest('[data-rm]');
      if (!b || !pm) return;
      if (b.dataset.rm === 'publish') startFlow((o) => pm.showPublish(name, o));
      else if (b.dataset.rm === 'history') startFlow((o) => pm.showHistory(b.dataset.peer, name, o));
    });
    draw();
    return {
      refresh: (a) => { app = a; draw(); },
      detach: () => { gone = true; if (flowClose) { const c = flowClose; flowClose = null; c(); } },
    };
  }

  // Danger: Rename (the guided rename, in place) and Delete (its confirmation, in place).
  function paneDanger(name, pane) {
    pane.innerHTML = paneHead('Danger zone', 'Both ask before they act.')
      + `<div class="vc-panel danger">
          <div class="vc-row"><div class="t"><b>Rename</b><span>Change the app name. You review everything it touches (Telegram, WhatsApp, cron, database) before you confirm; the app is stopped.</span></div><button class="vc-btn" data-dz="rename">Rename&hellip;</button></div>
          <div class="vc-row"><div class="t"><b>Delete</b><span>Remove the app and its directory permanently. This cannot be undone.</span></div><button class="vc-btn danger" data-dz="delete">Delete&hellip;</button></div>
        </div>
        <div data-dz-el="flow"></div>`;
    const flow = pane.querySelector('[data-dz-el="flow"]');
    let flowClose = null;
    const onExit = () => { flowClose = null; };
    pane.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dz]');
      if (!b) return;
      if (flowClose) flowClose();
      flowClose = b.dataset.dz === 'rename' ? renameApp(name, { mount: flow, onExit }) : deleteApp(name, { mount: flow, onExit });
    });
    return { detach: () => { if (flowClose) { const c = flowClose; flowClose = null; c(); } } };
  }

  const SETTINGS_PANES = {
    overview: paneOverview, tools: paneTools, appmd: paneAppMd, logs: paneLogs,
    config: paneConfig, sites: paneSites, spend: paneSpend, git: paneGit, remote: paneRemote, danger: paneDanger,
  };

  // Former per-app modals: their entry points open the matching tab.
  function showAppActions(name) { openAppSettings(name); }
  function showGitModal(name) { openAppSettings(name, 'git'); }
  function showToolsModal(name) { openAppSettings(name, 'tools'); }
  function showLogs(name) { openAppSettings(name, 'logs'); }
  function showAppMd(name) { openAppSettings(name, 'appmd'); }
  function editDescription(name) {
    openAppSettings(name, 'overview');
    if (settings?.name === name) settings.main.querySelector('[data-ov-edit]')?.click();
  }

  // --- Config tab of the app settings modal: startup & display (autostart,
  // full screen — applied at once), then ONE access level (private / users /
  // open), login channels, licence, Horst contribution and website domain,
  // saved together. Renders into `root`; returns the detach function. ---

  function mountAppConfig(name, root, foot) {
    const app = apps.list.find(a => a.name === name);
    if (!app) return;
    const auth = app.auth || {};
    const origin = location.origin;
    const access = accessOf(app);
    const srf = (app.surfaces && typeof app.surfaces === 'object') ? app.surfaces : {};
    const srfPub = (srf.public && typeof srf.public === 'object') ? srf.public : {};
    const landing = typeof srfPub.landing === 'string' ? srfPub.landing : '';
    const extraApi = Array.isArray(srfPub.api) ? srfPub.api : [];
    const contributes = app.platformContribution !== false;
    const mirror = isMasterMirror(app);

    const row = (id, label, desc, checked) => `
      <div class="vc-row"><div class="t"><b>${escHtml(label)}</b><span>${desc}</span></div>
        <label class="app-menu-switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span class="app-menu-switch-track"><span class="app-menu-switch-thumb"></span></span></label>
      </div>`;
    const url = `${origin}/apps/${name}/`;

    const toggle = (cls, label, desc, checked) => `
      <div class="vc-row"><label class="app-menu-toggle-row" style="display:flex;align-items:center;gap:12px;width:100%;cursor:pointer">
        <span class="app-menu-item-text t"><b>${escHtml(label)}</b><span>${desc}</span></span>
        <span class="app-menu-switch"><input type="checkbox" class="${cls}" ${checked ? 'checked' : ''}><span class="app-menu-switch-track"><span class="app-menu-switch-thumb"></span></span></span>
      </label></div>`;

    root.innerHTML = `<div class="cfg-embed">
          ${mirror ? `<div class="vc-callout">Published here from the master. What you set here is stored for <strong>this host</strong> only and survives the next publish; anything you leave unchanged keeps following the master.</div>` : ''}
          <div class="vc-pane on" data-pane="startup">
            <div><h4>Startup &amp; display</h4><p class="vc-intro">Applied at once, no save needed.</p></div>
            <div class="vc-panel">
              ${toggle('app-menu-autostart', 'Autostart', 'Start this app when the server boots. Turning it on starts a stopped app now.', app.autostart)}
              ${toggle('app-menu-fullscreen', 'Full screen', 'How YOU open it from the dashboard: a chrome-free tab instead of a panel. No effect on visitors.', app.display === 'fullscreen')}
            </div>
          </div>

          <div class="vc-pane on" data-pane="access">
            <div><h4>Access</h4><p class="vc-intro">Who can reach this app. One decision; everything else follows from it. Applies on save, no restart.</p></div>
            <div class="vc-seg" id="cfgLevel" role="radiogroup">
              <button type="button" data-level="private" class="${access.level === 'private' ? 'on' : ''}"><b>Private</b><span>Only you, from the dashboard.</span></button>
              <button type="button" data-level="users" class="${access.level === 'users' ? 'on' : ''}"><b>Users</b><span>Reachable from the internet; visitors must sign in.</span></button>
              <button type="button" data-level="open" class="${access.level === 'open' ? 'on' : ''}"><b>Open</b><span>Whole app reachable by anyone, no login.</span></button>
            </div>

            <div id="cfgPublic" class="cfg-stack" style="display:${access.level === 'private' ? 'none' : ''}">
              <div class="vc-panel">
                <div class="vc-ph"><span class="vc-lbl">public url</span><span class="right" id="cfgBaseSrc">&hellip;</span></div>
                <div class="vc-row col">
                  <div class="vc-url"><span id="cfgEntryUrl">${escHtml(url)}</span><button class="app-config-copy" type="button">Copy</button></div>
                  <div class="vc-hint" id="cfgBaseHint">Reading the platform&rsquo;s external address&hellip;</div>
                </div>
                <div class="vc-row col" id="cfgMiniRow" style="display:none">
                  <div class="vc-url"><span id="cfgMiniUrl"></span><button class="app-config-copy" type="button">Copy</button></div>
                  <div class="vc-hint">What the bot&rsquo;s mini-app button opens. Telegram always uses the platform address, never a custom domain.</div>
                </div>
                <div class="vc-row col">
                  <span class="vc-lbl">reachable without the vistaclair login</span>
                  <div class="vc-paths" id="cfgPaths"><span class="vc-hint">&hellip;</span></div>
                  <div class="vc-hint" id="cfgReach"></div>
                </div>
              </div>
              <div id="cfgAccessWarn"></div>
            </div>

            <div id="cfgPrivate" class="vc-panel" style="display:${access.level === 'private' ? 'block' : 'none'}">
              <div class="vc-row col"><div class="vc-hint">Nothing is reachable without the Vistaclair login. Bots, cron and Horst still work — they run inside the platform. Choose <strong>Users</strong> when people other than you should use it (from a browser, a Telegram or WhatsApp mini-app, or a custom domain).</div></div>
            </div>

            <div id="cfgUsers" class="cfg-stack" style="display:${access.level === 'users' ? '' : 'none'}">
              <div class="vc-panel">
                <div class="vc-ph"><span class="vc-lbl">login channels</span></div>
                ${row('cfgAuthTelegram', 'Telegram', 'Telegram mini-app (initData) and the bot <code>/link</code> code.', !!auth.telegram)}
                ${row('cfgAuthWhatsapp', 'WhatsApp', 'WhatsApp users sign in through the bot <code>/link</code> code (there is no WhatsApp mini-app).', !!auth.whatsapp)}
                ${row('cfgAuthEmail', 'Email', 'Email + password accounts with verification. Needs an email account in Setup.', !!auth.email)}
                <div id="cfgSenderWrap" class="vc-sub-row" style="display:${auth.email ? 'flex' : 'none'}">
                  <div class="vc-field"><label for="cfgSender">verification sender</label><select id="cfgSender" class="vc-inp app-config-select"><option value="">Loading…</option></select></div>
                  <div class="vc-hint">Email account used to send verification links.</div>
                </div>
              </div>
              <div class="vc-panel">
                <div class="vc-ph"><span class="vc-lbl">licence</span></div>
                <div class="vc-row col">
                  ${typeof auth.license === 'object' && auth.license
                    ? `<div class="vc-hint">Licence <strong>${escHtml(auth.license.product || '')}</strong> with a tier map &mdash; configured in <code>manifest.json</code> (edit it there; this console won't touch it).</div>`
                    : `<div class="vc-field"><label for="cfgLicense">product slug</label><input type="text" id="cfgLicense" class="vc-inp" placeholder="e.g. buddy — product/family slug on the licence server" value="${escHtml(typeof auth.license === 'string' ? auth.license : '')}"></div>
                  <div class="vc-hint">Users must claim a valid licence key before using the app's routes. Tier features and a free tier go in <code>manifest.json</code>'s <code>auth.license</code> object form. Empty = off. Takes effect on app restart.</div>`}
                </div>
              </div>
            </div>

            <div id="cfgOpen" class="cfg-stack" style="display:${access.level === 'open' ? '' : 'none'}">
              <div class="vc-callout warn">
                <p>&#9888; Anyone with the URL reaches every route and file of this app. There is no login and no user identity.</p>
                <p>On save the owner services &mdash; <strong>email, calendar, Google, Telegram, WhatsApp, other apps, Horst</strong> &mdash; are revoked for this app so a bug can't reach your data. Re-grant any of them in <strong>Spend &amp; permissions</strong>; changes apply on restart.</p>
                <p>An app with a bot or users must not be open: choose <strong>Users</strong> instead.</p>
              </div>
            </div>

          </div>

          <div class="vc-pane on" data-pane="horst">
            <div><h4>Horst &amp; platform</h4><p class="vc-intro">Whether the resident agent and other apps can see this app.</p></div>
            <div class="vc-panel">
              ${row('cfgContribute', 'Platform contribution', 'Horst can see and use this app: tools, events, docs, approvals. Other apps may call its exposed tools.', contributes)}
            </div>
            <div id="cfgContributeWarn" class="vc-callout bad" style="display:${contributes ? 'none' : 'block'}">
              This app is <strong>independent</strong>: invisible to Horst &mdash; no tools in the platform union, no events on the bus, no APP.md in his digest, no governance. Other apps cannot call its tools either.
            </div>
          </div>

          <div class="vc-pane on" data-pane="domain">
            <div><h4>Website domain</h4><p class="vc-intro">The address people type in a browser for this app. You run the reverse proxy (nginx); the platform records the domain and hands out its links. The Telegram mini-app is not affected.</p></div>
            <div id="cfgDomainFleet" class="vc-callout" style="display:none"></div>
            <div id="cfgDomainOff" class="vc-callout" style="display:${access.level === 'private' ? 'block' : 'none'}">A <strong>Private</strong> app is only reachable through the Vistaclair login, so a website domain cannot serve it. Choose <strong>Users</strong> or <strong>Open</strong> under Access above first.</div>
            <div class="vc-panel">
              <div class="vc-row col">
                <div class="vc-field"><label for="cfgDomain">website domain</label><input type="text" id="cfgDomain" class="vc-inp" placeholder="e.g. app.example.com — empty = none" value="${escHtml(app.domain || '')}" autocomplete="off" spellcheck="false" ${access.level === 'private' ? 'disabled' : ''}></div>
                <div class="vc-hint" id="cfgDomainHint">Hostname only. ${mirror ? 'Stored for <strong>this host</strong> — the next publish keeps it.' : 'Stored on this host.'}</div>
              </div>
              <div id="cfgDomainOut" style="display:none">
                <div class="vc-row col">
                  <span class="vc-lbl">website</span>
                  <div class="vc-url"><span id="cfgWebsiteUrl"></span><button class="app-config-copy" type="button">Copy</button></div>
                  <div class="vc-hint" id="cfgWebsiteHint"></div>
                </div>
                <div class="vc-row col">
                  <span class="vc-lbl">nginx for this host</span>
                  <code class="vc-code" id="cfgNginx"></code>
                  <div><button class="vc-btn app-config-copy-nginx" type="button">Copy nginx block</button> <button class="vc-btn" id="cfgDomainCheck" type="button">Check</button></div>
                  <div class="vc-hint" id="cfgDomainCheckOut"></div>
                </div>
              </div>
              <div class="vc-row col">
                <details><summary class="vc-hint">Details</summary>
                  <div class="vc-hint">Visitors via this domain carry no Vistaclair login cookie &mdash; that is why only Users and Open apps can be served there. <code>https://&lt;domain&gt;/</code> lands on the app&rsquo;s entry page on its own; nothing else to configure.</div>
                  <div class="vc-hint">The app is then served from <strong>two origins</strong> &mdash; this domain and the platform&rsquo;s own address under <code>/apps/${escHtml(name)}/</code>. Sessions, <code>localStorage</code> and cookies do not carry across them.</div>
                  <div class="vc-hint">An app that runs its own listener (a game server, a media port) maps that port in nginx too &mdash; the block above only covers <code>/apps/${escHtml(name)}/</code>.</div>
                </details>
              </div>
            </div>
            <div id="cfgDomainWarn" class="vc-callout warn" style="display:none"></div>
          </div>

      </div>`;
    // The save bar sits in the modal's footer (`foot`), outside the scroll.
    foot.innerHTML = '<span class="status app-config-status">Access, Horst &amp; domain are saved together</span><span class="sp"></span><button class="vc-btn ghost app-config-cancel">Discard changes</button><button class="vc-btn signal app-config-save">Save configuration</button>';
    foot.style.display = '';
    const modal = root;
    const detach = () => {
      apps._onEmailAccounts = null; apps._onAccessInfo = null; apps._onDomainCheck = null; apps._onConfigSaved = null; apps._onConfigError = null;
      foot.innerHTML = ''; foot.style.display = 'none';
    };
    // Discard: render again from the server's state (apps.list).
    foot.querySelector('.app-config-cancel').addEventListener('click', () => { detach(); mountAppConfig(name, root, foot); });

    // Sections are stacked; "showing" one scrolls it into view.
    const showPane = (key) => { modal.querySelector(`.vc-pane[data-pane="${key}"]`)?.scrollIntoView({ block: 'start' }); };

    // Startup & display apply at once (no save), with the applied badge.
    const applied = (row, text) => {
      row.classList.remove('app-menu-applied');
      void row.offsetWidth; // restart the animation
      row.classList.add('app-menu-applied');
      let badge = row.querySelector('.app-menu-applied-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'app-menu-applied-badge';
        row.querySelector('.app-menu-item-text').appendChild(badge);
      }
      badge.textContent = text;
      badge.classList.remove('show');
      void badge.offsetWidth;
      badge.classList.add('show');
    };
    modal.querySelector('.app-menu-fullscreen').addEventListener('change', (e) => {
      const on = e.target.checked;
      sendWs({ type: 'app:setConfig', name, display: on ? 'fullscreen' : 'inline' });
      applied(e.target.closest('.app-menu-toggle-row'), on ? 'Opens full screen' : 'Opens in a panel');
    });
    modal.querySelector('.app-menu-autostart').addEventListener('change', (e) => {
      const on = e.target.checked;
      sendWs({ type: 'app:setAutostart', name, autostart: on });
      applied(e.target.closest('.app-menu-toggle-row'), on ? 'Autostart on' : 'Autostart off');
    });

    const status = foot.querySelector('.app-config-status');
    let dirty = false;
    let saving = false;   // app:configSaved also answers the instant toggles above
    const markDirty = (e) => {
      if (e && e.target && e.target.closest && e.target.closest('[data-pane="startup"]')) return;
      if (dirty) return; dirty = true; status.textContent = 'unsaved changes'; status.className = 'status app-config-status dirty';
    };
    const form = modal.querySelector('.cfg-embed');
    form.addEventListener('input', markDirty);
    form.addEventListener('change', markDirty);

    // --- Access level state ---
    let level = access.level;
    const chan = {
      telegram: modal.querySelector('#cfgAuthTelegram'),
      whatsapp: modal.querySelector('#cfgAuthWhatsapp'),
      email: modal.querySelector('#cfgAuthEmail'),
    };
    const channelsOn = () => Object.keys(chan).filter((k) => chan[k].checked);
    const domainInput = modal.querySelector('#cfgDomain');
    const domainWarn = modal.querySelector('#cfgDomainWarn');

    // The server's derived public picture (app:accessInfo → app-manager
    // .accessInfo → surfaces.js). Null until it arrives; every render falls
    // back to this browser's origin and says which it is showing.
    let info = null;

    const updateReach = () => {
      const on = channelsOn();
      const lines = [];
      if (level === 'open') {
        lines.push('Every file and every route of this app is served to anyone. There is no user identity, so no route can tell callers apart.');
      } else {
        if (!app.hasEntryPage && !landing) lines.push(`<span style="color:var(--vcp-warn)">&#9888; <code>public/app.html</code> does not exist yet &mdash; app users have no entry page, so the app root stays owner-gated until it does.</span>`);
        lines.push(`Anonymous visitors at the root are sent to <code>${escHtml(landing || 'app.html')}</code>${landing ? ' (declared landing page)' : ''}.`);
        lines.push(`Every <code>/api/*</code> route needs a signed-in user (${on.length ? escHtml(on.join(', ')) : 'no channel yet'}) except <code>/api/app/pub/*</code>${extraApi.length ? ' and ' + extraApi.map((p) => `<code>${escHtml(p)}</code>`).join(', ') : ''}.`);
      }
      lines.push('Bots, cron, Horst and the dashboard keep the full platform; only what you revoke in Spend &amp; permissions is taken away.');
      modal.querySelector('#cfgReach').innerHTML = lines.join('<br>');
    };

    // --- Website domain: one field; the URL, nginx block and Check under it.
    // The snippet and the landing URL are server-built (accessInfo), for the
    // SAVED domain — an edited, unsaved value only shows its would-be URL.
    const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
    const typedDomain = () => domainInput.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    function renderDomain() {
      const off = level === 'private';
      domainInput.disabled = off;
      modal.querySelector('#cfgDomainOff').style.display = off ? 'block' : 'none';
      const d = typedDomain();
      const valid = !d || DOMAIN_RE.test(d);
      modal.querySelector('#cfgDomainHint').innerHTML = valid
        ? `Hostname only. ${mirror ? 'Stored for <strong>this host</strong> &mdash; the next publish keeps it.' : 'Stored on this host.'}`
        : `<span style="color:var(--vcp-warn)">&#9888; Not a hostname &mdash; e.g. <code>app.example.com</code>, no path or port.</span>`;
      const out = modal.querySelector('#cfgDomainOut');
      out.style.display = !off && d && valid ? '' : 'none';
      if (off || !d || !valid) return;
      const saved = info && info.domain === d;
      const entry = saved && info.websiteUrl ? info.websiteUrl : `https://${d}/`;
      modal.querySelector('#cfgWebsiteUrl').textContent = entry;
      const mini = info && info.miniAppUrl;
      modal.querySelector('#cfgWebsiteHint').innerHTML = (saved ? '' : 'Unsaved &mdash; save to record it. ')
        + `<code>https://${escHtml(d)}/</code> lands on the entry page by itself. `
        + (mini ? `The Telegram mini-app stays on <code>${escHtml(mini)}</code>.` : 'The Telegram mini-app keeps the platform address.');
      const nginx = (info && info.nginx ? info.nginx : '').replace(/server_name [^;]*;/, `server_name ${d};`);
      modal.querySelector('#cfgNginx').textContent = nginx || '…';
    }

    // Master side of a published app: each slave sets its own domain (per-host
    // config) and reports it in the fleet snapshot, so say where it lives.
    const renderDomainFleet = () => {
      const el = modal.querySelector('#cfgDomainFleet');
      const ri = remoteInfo(name);
      if (!ri || !ri.rows.length) { el.style.display = 'none'; return; }
      const fleet = window.publishModule?.state?.fleet || [];
      const lines = ri.rows.map((r) => {
        const f = fleet.find((x) => x.name === r.peer);
        const dom = f && f.domains ? (f.domains[name] || null) : undefined;
        const val = dom ? `<code>${escHtml(dom)}</code>` : dom === null ? 'none set' : 'not reported (update that slave)';
        return `<p>Runs on slave <strong>${escHtml(r.peer)}</strong> &mdash; its website domain: ${val}.</p>`;
      });
      el.innerHTML = lines.join('')
        + `<p>The field below is <strong>this host&rsquo;s</strong>. A slave&rsquo;s domain is set in that slave&rsquo;s own app settings (Config) (Setup &rarr; Remote &rarr; Access opens its dashboard) and its nginx points at the slave.</p>`;
      el.style.display = 'block';
    };

    // --- Public URL block: the one place an admin reads what to map ---------
    const BASE_LABEL = {
      domain: 'custom domain',
      'public-url': 'platform public url',
    };
    const BASE_HINT = {
      domain: () => `Recorded custom domain &mdash; your reverse proxy maps it onto <code>/apps/${escHtml(name)}/</code>. See <strong>Website domain</strong> for the nginx block.`,
      'public-url': () => 'The platform&rsquo;s external address, set once in <strong>Setup &rarr; Telegram</strong>. Everything the platform hands out &mdash; bot links, the mini-app, verification emails &mdash; is built from it.',
      none: () => 'No external address is configured, so this is the origin <em>you</em> are using right now &mdash; it may not be reachable from the internet. Set one in <strong>Setup &rarr; Telegram</strong>, or record a custom domain.',
    };
    const renderPublic = () => {
      const wrap = modal.querySelector('#cfgPublic');
      wrap.style.display = level === 'private' ? 'none' : '';
      if (level === 'private') return;

      const src = info && info.baseSource ? info.baseSource : 'none';
      modal.querySelector('#cfgBaseSrc').textContent = info ? (BASE_LABEL[src] || 'this browser’s origin') : '…';
      modal.querySelector('#cfgEntryUrl').textContent = (info && info.entryUrl) || url;
      modal.querySelector('#cfgBaseHint').innerHTML = info ? BASE_HINT[src]() : 'Reading the platform&rsquo;s external address&hellip;';

      const miniRow = modal.querySelector('#cfgMiniRow');
      const mini = info && info.miniAppUrl && chan.telegram.checked ? info.miniAppUrl : null;
      miniRow.style.display = mini ? 'flex' : 'none';
      if (mini) modal.querySelector('#cfgMiniUrl').textContent = mini;

      // Paths + guard exemptions, exactly as the request path computes them.
      const paths = modal.querySelector('#cfgPaths');
      if (!info) { paths.innerHTML = '<span class="vc-hint">&hellip;</span>'; }
      else {
        const rows = info.paths.map((p) => `<div><code>${escHtml(p)}</code></div>`);
        for (const g of info.guardExempt) {
          rows.push(`<div><code class="${g.cookieless ? '' : 'dead'}">/apps/${escHtml(name)}${escHtml(g.prefix)}/*</code><em>${g.cookieless ? 'no app login' : 'still behind the owner login'}</em></div>`);
        }
        paths.innerHTML = rows.join('');
      }

      // Warnings, plus the one the client alone knows: an unsaved level change
      // means the paths above still describe the SAVED configuration.
      const notes = info ? info.warnings.slice() : [];
      if (info && info.level !== level) {
        notes.unshift({ level: 'info', code: 'pending', text: `Showing the saved configuration (${info.level}). Save to apply “${level}”.` });
      }
      modal.querySelector('#cfgAccessWarn').innerHTML = notes.length
        ? `<div class="vc-callout ${notes.some((n) => n.level === 'warn') ? 'warn' : ''}">${notes.map((n) => `<p>${n.level === 'warn' ? '&#9888; ' : ''}${escHtml(n.text)}</p>`).join('')}</div>`
        : '';

      renderDomain();
    };
    const updateDomainWarn = () => {
      const d = domainInput.value.trim();
      const show = !!d && level === 'private';
      domainWarn.style.display = show ? 'block' : 'none';
      if (show) domainWarn.innerHTML = `&#9888; <strong>${escHtml(d)}</strong> is set but the app is <strong>Private</strong> &mdash; visitors via that domain have no Vistaclair login and will be blocked. Choose Users or Open under Access above.`;
      renderDomain();
    };
    const setLevel = async (next) => {
      if (next === 'open' && channelsOn().length) {
        if (!(await showConfirm('Open never coexists with users: switching to Open turns every login channel off and revokes the owner services for this app on save. Continue?', { confirmLabel: 'Switch to Open', danger: true }))) return;
        for (const k of Object.keys(chan)) chan[k].checked = false;
      }
      level = next;
      modal.querySelectorAll('#cfgLevel button').forEach((b) => b.classList.toggle('on', b.dataset.level === level));
      modal.querySelector('#cfgPrivate').style.display = level === 'private' ? 'block' : 'none';
      modal.querySelector('#cfgUsers').style.display = level === 'users' ? '' : 'none';
      modal.querySelector('#cfgOpen').style.display = level === 'open' ? '' : 'none';
      updateReach();
      renderPublic();
      updateDomainWarn();
      markDirty();
    };
    modal.querySelectorAll('#cfgLevel button').forEach((b) => b.addEventListener('click', () => setLevel(b.dataset.level)));
    for (const k of Object.keys(chan)) chan[k].addEventListener('change', () => {
      if (k === 'email') modal.querySelector('#cfgSenderWrap').style.display = chan.email.checked ? 'flex' : 'none';
      updateReach();
      renderPublic();
    });
    domainInput.addEventListener('input', () => { modal.querySelector('#cfgDomainCheckOut').textContent = ''; updateDomainWarn(); });
    updateReach();
    renderPublic();
    updateDomainWarn();
    renderDomainFleet();

    // Check: the server resolves the typed domain and follows `/` once.
    const checkBtn = modal.querySelector('#cfgDomainCheck');
    const checkOut = modal.querySelector('#cfgDomainCheckOut');
    apps._onDomainCheck = (msg) => {
      if (msg.appName !== name) return;
      checkBtn.disabled = false;
      const r = msg.result;
      if (msg.error || !r) { checkOut.innerHTML = `<span style="color:var(--vcp-warn)">&#9888; ${escHtml(msg.error || 'Check failed.')}</span>`; return; }
      checkOut.innerHTML = `<span style="color:var(${r.ok ? '--vc-ok' : '--vcp-warn'})">${r.ok ? '&#10003;' : '&#9888;'} ${escHtml(r.text)}</span>`
        + (r.addresses && r.addresses.length ? ` <span>(${escHtml(r.domain)} &rarr; ${escHtml(r.addresses.join(', '))})</span>` : '');
    };
    checkBtn.addEventListener('click', () => {
      checkBtn.disabled = true;
      checkOut.textContent = 'Checking…';
      sendWs({ type: 'app:checkDomain', name, domain: typedDomain() });
    });
    modal.querySelector('.app-config-copy-nginx').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      try { navigator.clipboard.writeText(modal.querySelector('#cfgNginx').textContent); btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy nginx block'; }, 1200); } catch {}
    });

    // The public picture is server-derived; it lands asynchronously and
    // re-renders the block in place (GUI-reload resilient: reopening the modal
    // asks again, nothing is cached in the client).
    apps._onAccessInfo = (msg) => {
      if (msg.appName !== name) return;
      if (msg.error) {
        info = null;
        modal.querySelector('#cfgBaseHint').innerHTML = `<span style="color:var(--vcp-warn)">Could not read the public URL: ${escHtml(msg.error)}</span>`;
        return;
      }
      info = msg.info;
      renderPublic();
    };
    sendWs({ type: 'app:getAccessInfo', name });

    const contributeToggle = modal.querySelector('#cfgContribute');
    contributeToggle.addEventListener('change', () => {
      modal.querySelector('#cfgContributeWarn').style.display = contributeToggle.checked ? 'none' : 'block';
    });
    // Copy the URL of the row the button sits in (entry, mini-app, …).
    modal.addEventListener('click', (e) => {
      const btn = e.target.closest('.app-config-copy');
      if (!btn) return;
      const text = btn.closest('.vc-url')?.querySelector('span')?.textContent || url;
      try { navigator.clipboard.writeText(text); btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1200); } catch {}
    });

    // Populate sender dropdown from the owner's registered email accounts.
    const sel = modal.querySelector('#cfgSender');
    apps._onEmailAccounts = (accounts) => {
      const cur = auth.sender || '';
      const opts = ['<option value="">— select —</option>']
        .concat(accounts.map(a => `<option value="${escHtml(a.email)}"${a.email === cur ? ' selected' : ''}>${escHtml(a.email)}</option>`));
      sel.innerHTML = opts.join('');
    };
    sendWs({ type: 'app:getEmailAccounts' });

    apps._onConfigSaved = (savedName) => {
      if (savedName !== name || !saving) return;
      saving = false;
      dirty = false;
      status.textContent = 'Saved.'; status.className = 'status app-config-status va-ok';
    };
    apps._onConfigError = (savedName, error) => {
      if (savedName !== name) return;
      saving = false;
      status.textContent = error || 'Could not save.'; status.className = 'status app-config-status va-err';
    };
    foot.querySelector('.app-config-save').addEventListener('click', () => {
      const on = channelsOn();
      if (level === 'users' && !on.length) {
        status.textContent = 'Users needs at least one login channel (Telegram, WhatsApp or Email).';
        status.className = 'status app-config-status va-err';
        showPane('access');
        return;
      }
      const d = typedDomain();
      if (d && !DOMAIN_RE.test(d)) {
        status.textContent = 'The website domain is not a hostname (e.g. app.example.com).';
        status.className = 'status app-config-status va-err';
        showPane('domain');
        return;
      }
      const senderEmail = sel.value || '';
      if (level === 'users' && chan.email.checked && !senderEmail) {
        status.textContent = 'Pick a verification sender for email login.';
        status.className = 'status app-config-status va-err';
        showPane('access');
        return;
      }
      const authPayload = { telegram: level === 'users' && chan.telegram.checked, whatsapp: level === 'users' && chan.whatsapp.checked, email: level === 'users' && chan.email.checked };
      // Only send `license` when the string input was rendered — an object-form
      // (tiers) licence lives in manifest.json and must not be clobbered here.
      const licenseInput = modal.querySelector('#cfgLicense');
      if (licenseInput) authPayload.license = licenseInput.value.trim() || null;
      sendWs({
        type: 'app:setConfig',
        name,
        access: level,
        auth: authPayload,
        senderEmail,
        platformContribution: contributeToggle.checked,
        domain: typedDomain(),
      });
      saving = true;
      status.textContent = 'Saving…'; status.className = 'status app-config-status';
    });
    return detach;
  }

  // --- APP.md viewer ---

  let _monacoPromise = null;
  function ensureMonaco() {
    if (typeof monaco !== 'undefined' && monaco.editor) return Promise.resolve();
    if (_monacoPromise) return _monacoPromise;
    _monacoPromise = new Promise((resolve) => {
      if (typeof window.require === 'undefined' || !window.require.config) { resolve(); return; }
      window.require.config({ paths: { vs: location.origin + '/vendor/monaco-editor-0.52.2/min/vs' } });
      window.require(['vs/editor/editor.main'], resolve);
    });
    return _monacoPromise;
  }

  let _pendingAppMdName = null;

  // app:appmd answers the APP.md tab of the settings modal (paneAppMd).
  async function _handleAppMdResponse(msg) {
    if (msg.appName !== _pendingAppMdName) return;
    _pendingAppMdName = null;
    const host = settings && settings.name === msg.appName && settings.tab === 'appmd'
      ? settings.main.querySelector('.app-appmd-pane') : null;
    if (!host) return;
    const appName = msg.appName;
    const hasContent = msg.content && msg.content.trim();
    host.innerHTML = `<div class="app-appmd-editor"></div>
      <div class="vc-acts-row"><button class="vc-btn app-appmd-recreate" title="A change session rewrites APP.md from the code">${hasContent ? 'Recreate with AI' : 'Create with AI'}</button><span class="sp"></span><button class="vc-btn signal app-appmd-save">Save</button></div>`;
    let getValue = null;
    // No optimistic "Saved" — the label is driven by the server's
    // app:fileSaved reply, so a refused save (slave mirror) can't claim success.
    const save = () => {
      if (!getValue) return;
      sendWs({ type: 'app:writeFile', name: appName, path: 'APP.md', content: getValue(), confirmSlaveEdit: slaveEditConfirmed.has(appName) });
    };
    host.querySelector('.app-appmd-recreate').addEventListener('click', () => { settings?.close(); recreateAppMd(appName); });
    host.querySelector('.app-appmd-save').addEventListener('click', save);

    await ensureMonaco();
    const editorDiv = host.querySelector('.app-appmd-editor');
    if (!editorDiv || !editorDiv.isConnected) return;
    if (typeof monaco !== 'undefined' && monaco.editor) {
      _appMdEditor = monaco.editor.create(editorDiv, {
        value: hasContent ? msg.content : '',
        language: 'markdown',
        theme: 'vs',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 12,
        wordWrap: 'on',
        automaticLayout: true,
      });
      _appMdEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
      const ed = _appMdEditor;
      getValue = () => ed.getValue();
    } else {
      editorDiv.innerHTML = '<textarea class="vc-inp app-appmd-text" spellcheck="false"></textarea>';
      const ta = editorDiv.firstElementChild;
      ta.value = hasContent ? msg.content : '';
      ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } });
      getValue = () => ta.value;
    }
  }

  function recreateAppMd(name) {
    sendWs({ type: 'app:spawnCli', name, action: 'recreate-appmd', confirmSlaveEdit: slaveEditConfirmed.has(name) });
  }

  // --- Exports ---

  window.appsModule = {
    handleMessage,
    showCreate,
    setGridFilter,
    setGridQuery,
    toggleGroup,
    setSort,
    openAppSettings,
    stopAppConfirm,
    showSetup,
    showToast,
    openApp,
    openHelp,
    openHelpAt,
    openToolsOverview,
    openCli,
    reportError,
    showErrorDetail,
    clearErrors,
    killTask,
    toggleTaskPanel,
    closeTaskPanel,
    gitCommit,
    gitPush,
    showGitModal,
    remoteChipClick, showRemoteTip, hideRemoteTip, patchRemoteChips,
    openAppDir,
    closeAppTab,
    toggleApp,
    deleteApp,
    showLogs,
    editTools,
    editSingleTool,
    showTools: showToolsModal,
    showToolDetail,
    restartApp,
    startGoogleReauth,
    startGoogleConnect,
    openGoogleReauthPopup,
    showAppActions,
    showChangeRequestModal,
    cancelChangeRequest,
    showAppMd,
    openConsole,
    recreateAppMd,
    editDescription,
    render,
    _currentApp: () => apps.activeTab !== 'grid' ? apps.activeTab : null,
  };

  // Register with vistaclair's generic extension API
  const { registerModule, registerView } = window.dashboard;
  registerModule('app:', handleMessage);
  registerView('apps', render);
  // The host exists from the start, so a Desks window of an app tab has its
  // Reopen even before the Apps view was opened.
  initTabHost();

  // Request app list — the server's onConnect may have fired before this script loaded
  function requestList() {
    if (state.ws?.readyState === 1) {
      sendWs({ type: 'app:list' });
    } else {
      setTimeout(requestList, 200);
    }
  }
  requestList();
})();
