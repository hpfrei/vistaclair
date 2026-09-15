(function () {
  const { sendWs, state, escHtml, askFormBuildHTML, askFormBind } = window.dashboard;
  const tabStrip = document.getElementById('cliTabStrip');
  const tabNewBtn = document.getElementById('cliTabNew');
  const modelCog = document.getElementById('cliModelCog');
  const container = document.getElementById('cliContainer');
  const placeholder = document.getElementById('cliPlaceholder');
  const settingsModal = document.getElementById('cliSettingsModal');

  const tabs = new Map();
  let activeTabId = null;
  const pendingAskOverlays = new Map(); // askId -> { overlayEl, tabId }
  let _askCascade = 0;
  const _scrollbackLoaded = new Set();
  const _pendingRemoval = new Map();

  // Intent for a new tab, keyed by the correlation id sent with cli:newTab. The
  // server echoes reqId back, so two rapid requests can never claim each other's
  // cwd/settings the way a single shared slot or a positional queue could.
  const _pendingNewTabs = new Map();
  let _reqSeq = 0;
  function _requestNewTab(intent) {
    const reqId = `req-${++_reqSeq}`;
    if (intent) _pendingNewTabs.set(reqId, intent);
    sendWs({ type: 'cli:newTab', reqId });
  }

  function _loadBootId() {
    try { return sessionStorage.getItem('cli-server-boot-id') || null; } catch { return null; }
  }
  function _saveBootId(id) {
    try { if (id) sessionStorage.setItem('cli-server-boot-id', id); } catch {}
  }

  function getTheme() {
    return { background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#a0a0ff', selectionBackground: 'rgba(160,160,255,0.3)' };
  }

  function _blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  function _fileToDataURL(file) {
    return _blobToDataURL(file);
  }

  async function handleClipboardPaste(tabId) {
    try {
      const text = await navigator.clipboard.readText();
      if (text) sendWs({ type: 'cli:input', tabId, data: text });
    } catch {}
  }

  function _setupDropOverlay(wrap, tabId) {
    let dragCounter = 0;
    let overlay = null;

    function showOverlay() {
      if (overlay) return;
      overlay = document.createElement('div');
      overlay.className = 'cli-drop-overlay';
      overlay.textContent = 'Drop files here to upload';
      wrap.appendChild(overlay);
    }

    function hideOverlay() {
      if (overlay) { overlay.remove(); overlay = null; }
    }

    wrap.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      if (dragCounter === 1) showOverlay();
    }, true);

    wrap.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }, true);

    wrap.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) { dragCounter = 0; hideOverlay(); }
    }, true);

    wrap.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter = 0;
      hideOverlay();
      const files = [...(e.dataTransfer.files || [])];
      if (files.length === 0 && e.dataTransfer.items) {
        for (const item of e.dataTransfer.items) {
          if (item.kind === 'file') {
            const f = item.getAsFile();
            if (f) files.push(f);
          }
        }
      }
      for (const file of files) {
        const dataUrl = await _fileToDataURL(file);
        sendWs({ type: 'cli:uploadFile', tabId, data: dataUrl, filename: file.name });
      }
    }, true);
  }

  function createTab(tabId) {
    const wrap = document.createElement('div');
    wrap.className = 'cli-terminal-wrap';
    wrap.style.display = 'none';

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Cascadia Code", Menlo, Monaco, "Courier New", monospace',
      theme: getTheme(),
      convertEol: true,
      scrollback: 10000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    try { terminal.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch {}

    terminal.open(wrap);

    terminal.attachCustomKeyEventHandler(ev => {
      if (ev.type === 'keydown' && ev.key === 'v' && (ev.ctrlKey || ev.metaKey) && !ev.shiftKey) {
        handleClipboardPaste(tabId);
        return false;
      }
      return true;
    });

    wrap.addEventListener('paste', async (e) => {
      const items = e.clipboardData?.items;
      if (items) {
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            e.preventDefault();
            e.stopPropagation();
            const blob = item.getAsFile();
            if (blob) {
              const dataUrl = await _blobToDataURL(blob);
              const ext = item.type === 'image/jpeg' ? '.jpg' : '.png';
              const filename = `paste-${Date.now()}${ext}`;
              sendWs({ type: 'cli:uploadFile', tabId, data: dataUrl, filename });
            }
            return;
          }
        }
      }
    }, true);

    terminal.onData(data => {
      sendWs({ type: 'cli:input', tabId, data });
    });

    terminal.onResize(({ cols, rows }) => {
      sendWs({ type: 'cli:resize', tabId, cols, rows });
    });

    _setupDropOverlay(wrap, tabId);

    const tab = { terminal, fitAddon, wrap, cwd: null, title: null, settings: {}, status: 'idle' };
    tabs.set(tabId, tab);

    container.appendChild(wrap);

    const ro = new ResizeObserver(() => {
      if (activeTabId === tabId && wrap.offsetWidth > 0) {
        try { fitAddon.fit(); } catch {}
      }
    });
    ro.observe(wrap);
    tab._resizeObserver = ro;

    return tab;
  }

  function switchTab(tabId) {
    for (const [id, tab] of tabs) {
      tab.wrap.style.display = id === tabId ? '' : 'none';
    }
    activeTabId = tabId;
    if (placeholder) placeholder.style.display = tabs.size > 0 ? 'none' : '';
    renderTabStrip();
    const tab = tabs.get(tabId);
    if (tab) {
      if (!_scrollbackLoaded.has(tabId)) {
        _scrollbackLoaded.add(tabId);
        sendWs({ type: 'cli:requestScrollback', tabId });
      }
      setTimeout(() => {
        try { tab.fitAddon.fit(); } catch {}
        tab.terminal.focus();
      }, 50);
    }
  }

  // Display label for a tab. The server assigns every session a title at spawn
  // time (cwd basename, `-2`/`-3` suffixed against live siblings) and persists
  // it against the sessId, so the label is stable for the life of the session
  // and is reclaimed verbatim when the session is resumed after a restart. The
  // fallbacks only apply before the first spawn has reported back.
  function computeTabLabel(tabId) {
    const tab = tabs.get(tabId);
    if (tab?.title) return tab.title;
    if (!tab?.cwd) return tabId;
    const parts = tab.cwd.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || tab.cwd;
  }

  function renderTabStrip() {
    if (!tabStrip) return;
    tabStrip.querySelectorAll('.view-tab').forEach(el => el.remove());

    for (const [tabId, tab] of tabs) {
      const btn = document.createElement('button');
      const hasPendingAsk = Array.from(pendingAskOverlays.values()).some(p => p.tabId === tabId);
      btn.className = 'view-tab' + (tabId === activeTabId ? ' active' : '') + (hasPendingAsk ? ' has-pending-ask' : '');
      btn.dataset.tabId = tabId;

      const label = document.createElement('span');
      label.className = 'cli-tab-label';
      const isAppCli = tabId.startsWith('app-');
      label.textContent = (isAppCli ? '\u{1F528} ' : '') + computeTabLabel(tabId);
      let clickTimer = null;
      label.addEventListener('click', (e) => {
        e.stopPropagation();
        if (activeTabId !== tabId) {
          switchTab(tabId);
          return;
        }
        if (clickTimer) return;
        clickTimer = setTimeout(() => {
          clickTimer = null;
          switchView('dashboard');
          const clickedTab = tabs.get(tabId);
          if (clickedTab?.instanceId) window.inspectorModule?.switchInstanceTab?.(clickedTab.instanceId);
        }, 250);
      });
      btn.appendChild(label);

      // Model override / settings button
      const hasOverride = tab.settings &&
        tab.settings.modelMap && Object.values(tab.settings.modelMap).some(v => v);
      const settingsBtn = document.createElement('span');
      settingsBtn.className = 'cli-model-override-btn' + (hasOverride ? ' active' : '');
      settingsBtn.innerHTML = hasOverride
        ? '<svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M1 2l12 10M1 7h12M1 12l12-10"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M1 3h10m-2-2l2 2-2 2"/><path d="M1 7h10m-2-2l2 2-2 2"/><path d="M1 11h10m-2-2l2 2-2 2"/></svg>';
      settingsBtn.title = hasOverride ? 'Model override active — click to edit' : 'Model settings';
      settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openSettings(tabId);
      });
      btn.appendChild(settingsBtn);

      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = 'Close';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        sendWs({ type: 'cli:closeTab', tabId });
        removeTab(tabId);
      });
      btn.appendChild(close);

      btn.addEventListener('click', () => switchTab(tabId));
      tabStrip.insertBefore(btn, tabNewBtn);
    }
  }

  function removeTab(tabId) {
    dismissAskModalsForTab(tabId);
    _scrollbackLoaded.delete(tabId);
    const tab = tabs.get(tabId);
    if (tab) {
      // Clear corresponding inspector instance (interactions + tab)
      if (tab.instanceId) {
        sendWs({ type: 'inspector:clearInstances', instanceIds: [tab.instanceId] });
      }
      tab.terminal.dispose();
      tab._resizeObserver?.disconnect();
      tab.wrap.remove();
      tabs.delete(tabId);
    }
    if (activeTabId === tabId) {
      const remaining = Array.from(tabs.keys());
      if (remaining.length > 0) {
        switchTab(remaining[remaining.length - 1]);
      } else {
        activeTabId = null;
        if (placeholder) placeholder.style.display = '';
        renderTabStrip();
      }
    }
  }

  // --- "+" button: menu with New + saved sessions ---
  tabNewBtn?.addEventListener('click', () => {
    sendWs({ type: 'cli:getSavedSessions' });
    state._showNewMenu = true;
  });

  function showNewMenu(savedSessions) {
    closeNewMenu();
    const menu = document.createElement('div');
    menu.className = 'cli-new-menu';
    menu.id = 'cliNewMenu';

    const newItem = document.createElement('div');
    newItem.className = 'cli-new-menu-item cli-new-menu-new';
    newItem.textContent = 'New CLI in directory…';
    newItem.addEventListener('click', async () => {
      closeNewMenu();
      const picked = await openFsDirPicker();
      if (!picked) return;
      _requestNewTab({
        cwd: picked.dir,
        autoMemory: picked.autoMemory,
      });
    });
    menu.appendChild(newItem);

    if (savedSessions.length > 0) {
      const divider = document.createElement('div');
      divider.className = 'cli-new-menu-divider';
      menu.appendChild(divider);

      const header = document.createElement('div');
      header.className = 'cli-new-menu-header';
      header.textContent = 'Resume session';
      menu.appendChild(header);

      for (const sess of savedSessions) {
        const parts = sess.cwd.replace(/\/+$/, '').split('/');
        const dirName = parts[parts.length - 1] || sess.cwd;
        const mappings = formatModelMap(sess.settings?.modelMap);
        const lastAt = sess.lastInteractionAt || sess.savedAt;
        const age = formatAge(lastAt);
        const displayTitle = sess.title || dirName;

        const item = document.createElement('div');
        item.className = 'cli-new-menu-item cli-new-menu-session';
        if (sess.isRunning) item.classList.add('cli-new-menu-session-running');
        item.title = sess.cwd;

        const info = document.createElement('div');
        info.className = 'cli-new-menu-session-info';
        const runningTag = sess.isRunning ? '<span class="cli-new-menu-running">running</span>' : '';
        info.innerHTML = `<span class="cli-new-menu-dir">${escHtml(displayTitle)}</span>${runningTag}<span class="cli-new-menu-age">${escHtml(age)}</span>`;
        item.appendChild(info);

        const timeRow = document.createElement('div');
        timeRow.className = 'cli-new-menu-time-row';
        const startedEl = document.createElement('span');
        startedEl.className = 'cli-new-menu-time';
        startedEl.innerHTML = `<span class="cli-new-menu-time-lbl">started</span> ${escHtml(formatDateTime(sess.startedAt))}`;
        timeRow.appendChild(startedEl);
        const lastEl = document.createElement('span');
        lastEl.className = 'cli-new-menu-time';
        const lastSizeStr = sess.lastEntrySize ? ` · ${formatBytes(sess.lastEntrySize)}` : '';
        lastEl.innerHTML = `<span class="cli-new-menu-time-lbl">last</span> ${escHtml(formatDateTime(lastAt))}${escHtml(lastSizeStr)}`;
        timeRow.appendChild(lastEl);
        item.appendChild(timeRow);

        const metaRow = document.createElement('div');
        metaRow.className = 'cli-new-menu-meta-row';
        const dirLine = document.createElement('span');
        dirLine.className = 'cli-new-menu-meta cli-new-menu-path';
        dirLine.textContent = sess.cwd;
        metaRow.appendChild(dirLine);
        if (sess.autoMemory === true) {
          const memBadge = document.createElement('span');
          memBadge.className = 'cli-new-menu-badge';
          memBadge.textContent = 'memory';
          metaRow.appendChild(memBadge);
        }
        if (mappings) {
          const mapSpan = document.createElement('span');
          mapSpan.className = 'cli-new-menu-badge cli-new-menu-badge-model';
          mapSpan.textContent = mappings;
          metaRow.appendChild(mapSpan);
        }
        item.appendChild(metaRow);

        if (sess.jsonlSize) {
          const gaugeLine = document.createElement('div');
          gaugeLine.className = 'cli-new-menu-gauge-row';
          gaugeLine.innerHTML = contextGauge(sess.jsonlSize);
          item.appendChild(gaugeLine);
        }

        if (!sess.isRunning) {
          const del = document.createElement('span');
          del.className = 'cli-new-menu-del';
          del.textContent = '×';
          del.title = 'Remove';
          del.addEventListener('click', (e) => {
            e.stopPropagation();
            sendWs({ type: 'cli:deleteSavedSession', sessionId: sess.id });
            item.remove();
          });
          item.appendChild(del);
        }

        item.addEventListener('click', () => {
          closeNewMenu();
          _requestNewTab({
            cwd: sess.cwd,
            resumeSessionId: sess.id,
            settings: sess.settings,
            autoMemory: sess.autoMemory === true,
          });
        });
        menu.appendChild(item);
      }
    }

    document.body.appendChild(menu);
    const rect = tabNewBtn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = rect.bottom + 4 + 'px';
    const menuWidth = menu.offsetWidth || 260;
    let left = rect.right - menuWidth;
    if (left < 8) left = 8;
    if (left + menuWidth > window.innerWidth - 8) left = window.innerWidth - menuWidth - 8;
    menu.style.left = left + 'px';
    const onClickOutside = (e) => {
      if (!menu.contains(e.target) && e.target !== tabNewBtn) {
        closeNewMenu();
        document.removeEventListener('click', onClickOutside, true);
      }
    };
    setTimeout(() => document.addEventListener('click', onClickOutside, true), 0);
  }

  function closeNewMenu() {
    document.getElementById('cliNewMenu')?.remove();
  }

  // --- Default model for new CLI tabs ---

  // Options for a model picker: the CLI's own aliases (which `--model` accepts
  // but models.json does not list), then a `<model>[1m]` variant per catalog
  // model that supports the 1M context window, then the resolved Anthropic
  // catalog. The tab-strip cog and the per-tab settings modal both draw from
  // this, so the two can never drift apart.
  function modelPickerOptions() {
    const aliases = (state.cliModelAliases || []).map(a => ({
      value: a.value, label: a.label, group: a.group || 'Aliases', price: '',
    }));
    const catalog = (state.models || [])
      .filter(m => m.providerKey === 'anthropic' && m.usable)
      .sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name));
    // The CLI takes `<full model name>[1m]`; the API does not, so these exist
    // only here — never as routable models.json entries.
    const extended = catalog
      .filter(m => m.context1m)
      .map(m => ({
        value: `${m.name}[1m]`,
        label: `${m.label || m.name} (1M context)`,
        group: '1M context',
        price: fmtPrice(m),
      }));
    return [
      ...aliases,
      ...extended,
      ...catalog.map(m => ({
        value: m.name,
        label: (m.label || m.name) + (m.isNew ? ' (new)' : ''),
        group: 'Catalog',
        price: fmtPrice(m),
      })),
    ];
  }

  function updateModelCog() {
    if (!modelCog) return;
    const current = state.cliModel || 'opus';
    modelCog.title = `New CLI tabs use: ${current} — click to change`;
  }

  modelCog?.addEventListener('click', (e) => {
    e.stopPropagation();
    showModelMenu();
  });

  function showModelMenu() {
    closeModelMenu();
    closeNewMenu();
    const menu = document.createElement('div');
    menu.className = 'cli-new-menu';
    menu.id = 'cliModelMenu';

    const header = document.createElement('div');
    header.className = 'cli-new-menu-header';
    header.textContent = 'Model for new CLI tabs';
    menu.appendChild(header);

    const current = state.cliModel || 'opus';
    let lastGroup = null;
    for (const opt of modelPickerOptions()) {
      if (opt.group !== lastGroup) {
        lastGroup = opt.group;
        const divider = document.createElement('div');
        divider.className = 'cli-new-menu-divider';
        menu.appendChild(divider);
      }
      const item = document.createElement('div');
      item.className = 'cli-new-menu-item' + (opt.value === current ? ' is-selected' : '');
      item.textContent = (opt.value === current ? '✓ ' : '') + opt.label;
      if (opt.price) {
        const price = document.createElement('span');
        price.className = 'cli-model-menu-current';
        price.textContent = opt.price;
        item.appendChild(price);
      }
      item.addEventListener('click', () => {
        closeModelMenu();
        sendWs({ type: 'prefs:cliModel:set', value: opt.value });
      });
      menu.appendChild(item);
    }

    document.body.appendChild(menu);
    const rect = modelCog.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = rect.bottom + 4 + 'px';
    const menuWidth = menu.offsetWidth || 260;
    let left = rect.right - menuWidth;
    if (left < 8) left = 8;
    if (left + menuWidth > window.innerWidth - 8) left = window.innerWidth - menuWidth - 8;
    menu.style.left = left + 'px';
    const onClickOutside = (e) => {
      if (!menu.contains(e.target) && e.target !== modelCog) {
        closeModelMenu();
        document.removeEventListener('click', onClickOutside, true);
      }
    };
    setTimeout(() => document.addEventListener('click', onClickOutside, true), 0);
  }

  function closeModelMenu() {
    document.getElementById('cliModelMenu')?.remove();
  }

  function formatModelMap(modelMap) {
    if (!modelMap) return '';
    const parts = [];
    for (const [family, mapped] of Object.entries(modelMap)) {
      if (mapped) parts.push(`${family}→${mapped}`);
    }
    return parts.join(', ');
  }

  function formatAge(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  function formatDateTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return time;
    const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `${date} ${time}`;
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function contextGauge(bytes) {
    if (!bytes) return '';
    const MAX_BYTES = 300 * 1024;
    const pct = Math.min(bytes / MAX_BYTES, 1);
    const w = 36, h = 8, fill = Math.max(pct * w, 1);
    const hue = Math.round((1 - pct) * 120);
    const sat = pct > 0.9 ? '80%' : '70%';
    const lit = pct > 0.9 ? '30%' : '45%';
    const color = `hsl(${hue},${sat},${lit})`;
    const label = bytes < 1024 ? bytes + ' B'
      : bytes < 1024 * 1024 ? Math.round(bytes / 1024) + ' KB'
      : (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return `<span class="cli-new-menu-gauge"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="2" fill="var(--bg, #111)" stroke="var(--border, #333)" stroke-width="0.5"/><rect width="${fill}" height="${h}" rx="2" fill="${color}"/></svg><span class="cli-new-menu-gauge-label">${label}</span></span>`;
  }

  // --- Filesystem directory picker ---
  async function openFsDirPicker() {
    const modal = document.getElementById('dirPickerModal');
    const closeBtn = document.getElementById('dirPickerClose');
    const crumbsEl = document.getElementById('dirPickerBreadcrumbs');
    const listEl = document.getElementById('dirPickerList');
    const cancelBtn = document.getElementById('dirPickerCancelBtn');
    const selectBtn = document.getElementById('dirPickerSelectBtn');
    const newBtn = document.getElementById('dirPickerNewBtn');
    const newRow = document.getElementById('dirPickerNew');
    const newNameInput = document.getElementById('dirPickerNewName');
    const newOkBtn = document.getElementById('dirPickerNewOk');
    const newCancelBtn = document.getElementById('dirPickerNewCancel');
    const recentEl = document.getElementById('dirPickerRecent');
    const recentListEl = document.getElementById('dirPickerRecentList');

    let currentDir = '';
    let resolve;
    const promise = new Promise(r => { resolve = r; });

    async function loadRecent() {
      try {
        const resp = await fetch('/api/recent-dirs');
        const data = await resp.json();
        renderRecent(data.dirs || []);
      } catch {
        renderRecent([]);
      }
    }

    function renderRecent(dirs) {
      recentListEl.innerHTML = '';
      if (!dirs.length) { recentEl.classList.add('hidden'); return; }
      recentEl.classList.remove('hidden');
      dirs.forEach(d => {
        const parts = d.path.replace(/\/+$/, '').split('/');
        const name = parts[parts.length - 1] || d.path;
        const row = document.createElement('div');
        row.className = 'dir-picker-recent-item';
        row.title = d.path;

        const pick = document.createElement('div');
        pick.className = 'dir-picker-recent-pick';
        pick.innerHTML = `<span class="dir-picker-recent-icon">📁</span><span class="dir-picker-recent-name">${escHtml(name)}</span><span class="dir-picker-recent-path">${escHtml(d.path)}</span>`;
        pick.addEventListener('click', () => {
          cleanup();
          resolve({ dir: d.path, autoMemory: autoMemoryCheckbox.checked });
        });
        row.appendChild(pick);

        const del = document.createElement('span');
        del.className = 'dir-picker-recent-del';
        del.textContent = '×';
        del.title = 'Remove from recent';
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          row.remove();
          try {
            await fetch('/api/recent-dirs', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: d.path }),
            });
          } catch {}
          if (!recentListEl.children.length) recentEl.classList.add('hidden');
        });
        row.appendChild(del);

        recentListEl.appendChild(row);
      });
    }

    async function loadDir(dirPath) {
      listEl.innerHTML = '<div class="dir-picker-empty">Loading...</div>';
      try {
        const resp = await fetch('/api/browse-dirs?path=' + encodeURIComponent(dirPath));
        const data = await resp.json();
        if (data.error) {
          listEl.innerHTML = '<div class="dir-picker-empty">' + data.error + '</div>';
          return;
        }
        currentDir = data.current;
        renderCrumbs(data.current, data.parent);
        renderDirs(data.dirs, data.current, data.parent);
      } catch {
        listEl.innerHTML = '<div class="dir-picker-empty">Failed to load directories.</div>';
      }
    }

    function renderCrumbs(absPath, parent) {
      crumbsEl.innerHTML = '';
      const parts = absPath.split('/').filter(Boolean);
      parts.forEach((seg, i) => {
        if (i > 0) {
          const sep = document.createElement('span');
          sep.className = 'dir-picker-sep';
          sep.textContent = ' / ';
          crumbsEl.appendChild(sep);
        }
        const crumb = document.createElement('span');
        crumb.className = 'dir-picker-crumb' + (i === parts.length - 1 ? ' active' : '');
        crumb.textContent = seg;
        if (i < parts.length - 1) {
          const target = '/' + parts.slice(0, i + 1).join('/');
          crumb.addEventListener('click', () => loadDir(target));
        }
        crumbsEl.appendChild(crumb);
      });
    }

    function renderDirs(dirs, current, parent) {
      listEl.innerHTML = '';
      if (parent && parent !== current) {
        const up = document.createElement('div');
        up.className = 'dir-picker-item parent';
        up.innerHTML = '<span class="dir-picker-item-icon">←</span><span class="dir-picker-item-name">..</span>';
        up.addEventListener('click', () => loadDir(parent));
        listEl.appendChild(up);
      }
      if (dirs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'dir-picker-empty';
        empty.textContent = 'No subdirectories.';
        listEl.appendChild(empty);
      }
      dirs.forEach(name => {
        const item = document.createElement('div');
        item.className = 'dir-picker-item';
        item.title = name;
        const d = document.createElement('span'); d.textContent = name;
        item.innerHTML = '<span class="dir-picker-item-icon">📁</span><span class="dir-picker-item-name">' + d.innerHTML + '</span>';
        item.addEventListener('click', () => loadDir(current + '/' + name));
        listEl.appendChild(item);
      });
    }

    // New folder handlers
    function onNewBtn() {
      newRow.classList.remove('hidden');
      newNameInput.value = '';
      newNameInput.focus();
    }
    async function onNewOk() {
      const name = newNameInput.value.trim();
      if (!name) return;
      try {
        const resp = await fetch('/api/browse-dirs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parent: currentDir, name }),
        });
        const data = await resp.json();
        if (data.error) { alert(data.error); return; }
        newRow.classList.add('hidden');
        loadDir(data.created);
      } catch { alert('Failed to create folder.'); }
    }
    function onNewCancel() { newRow.classList.add('hidden'); }
    function onNewKey(e) { if (e.key === 'Enter') onNewOk(); }

    function cleanup() {
      modal.classList.add('hidden');
      newRow.classList.add('hidden');
      closeBtn.removeEventListener('click', onClose);
      cancelBtn.removeEventListener('click', onClose);
      selectBtn.removeEventListener('click', onSelect);
      newBtn.removeEventListener('click', onNewBtn);
      newOkBtn.removeEventListener('click', onNewOk);
      newCancelBtn.removeEventListener('click', onNewCancel);
      newNameInput.removeEventListener('keydown', onNewKey);
    }
    const autoMemoryCheckbox = document.getElementById('dirPickerAutoMemory');
    function onClose() { cleanup(); resolve(null); }
    function onSelect() { cleanup(); resolve({ dir: currentDir, autoMemory: autoMemoryCheckbox.checked }); }

    closeBtn.addEventListener('click', onClose);
    cancelBtn.addEventListener('click', onClose);
    selectBtn.addEventListener('click', onSelect);
    newBtn.addEventListener('click', onNewBtn);
    newOkBtn.addEventListener('click', onNewOk);
    newCancelBtn.addEventListener('click', onNewCancel);
    newNameInput.addEventListener('keydown', onNewKey);

    modal.classList.remove('hidden');
    loadRecent();
    loadDir('');

    return promise;
  }

  // --- Settings modal ---
  // On a newly spawned CLI tab with no active Claude subscription, remind the user
  // that running /login takes effect only in a NEW tab (this tab snapshotted creds
  // at spawn time). Shown at most once per page load.
  let _noSubToastShown = false;
  function maybeNotifyNoSubscription() {
    if (_noSubToastShown) return;
    const ca = state.claudeAuth || {};
    if (ca.hasSubscription) return;
    _noSubToastShown = true;
    window.dashboard.showToast?.({
      sender: 'CLI',
      title: 'No Claude subscription detected',
      message: 'Run /login in this tab to activate your Max/Pro subscription, then open a NEW CLI tab for it to take effect (this session already started without it).',
      level: 'warning',
      duration: 12000,
    });
  }

  function openSettings(tabId) {
    if (!settingsModal) return;
    const tab = tabs.get(tabId);
    sendWs({ type: 'cli:getSettings', tabId });
    settingsModal._tabId = tabId;
    settingsModal.classList.remove('hidden');
  }

  // Compact "$in/$out per 1M tokens" tag for a model option, or '' if unpriced.
  function fmtPrice(m) {
    const inC = m.inputCostPerMTok, outC = m.outputCostPerMTok;
    if (typeof inC !== 'number' && typeof outC !== 'number') return '';
    const f = (v) => typeof v === 'number' ? `$${v % 1 === 0 ? v : v.toFixed(2)}` : '$?';
    return `${f(inC)}/${f(outC)} per 1M`;
  }

  function populateSettings(tabId, settings, models, hasSubscription, interactionsDir) {
    if (!settingsModal || settingsModal._tabId !== tabId) return;
    settingsModal._interactionsDir = interactionsDir || null;
    const openDirBtn = settingsModal.querySelector('.cli-settings-open-dir');
    if (openDirBtn) openDirBtn.disabled = !interactionsDir;
    const hint = document.getElementById('cliAuthHint');
    if (hint) {
      if (hasSubscription) {
        hint.className = 'cli-auth-hint cli-auth-hint-ok';
        hint.innerHTML = 'Claude subscription active &mdash; interactive sessions use it automatically.';
      } else {
        hint.className = 'cli-auth-hint cli-auth-hint-warn';
        hint.innerHTML = 'No Claude subscription detected. Run <code>/login</code> in this CLI tab to activate your Max/Pro subscription for interactive sessions. Without a subscription, sessions fall back to the Anthropic API key.';
      }
    }
    const modelMap = settings.modelMap || { fable: null, opus: null, sonnet: null, haiku: null };
    // Server-decided (capabilities.listModelsWithAvailability). This file used
    // to carry the only correct copy of this predicate on the platform; it is
    // now the payload's, and every surface reads the same one.
    const hasAuth = (m) => !!m.usable;
    const isRetired = (m) => m.lifecycle === 'retired';
    const allModels = (models || []).sort((a, b) => {
      // Retired models sink to the bottom, then unauthenticated, then alphabetical.
      const aRet = isRetired(a), bRet = isRetired(b);
      if (aRet !== bRet) return aRet ? 1 : -1;
      const aKey = hasAuth(a), bKey = hasAuth(b);
      if (aKey !== bKey) return aKey ? -1 : 1;
      return (a.label || a.name).localeCompare(b.label || b.name);
    });

    ['fable', 'opus', 'sonnet', 'haiku'].forEach(family => {
      const sel = settingsModal.querySelector(`[data-map="${family}"]`);
      if (!sel) return;
      sel.innerHTML = '<option value="">Default (passthrough)</option>';
      allModels.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.name;
        let label = m.label || m.name;
        if (m.isNew) label += ' (new)';
        const price = fmtPrice(m);
        if (price) label += `  [${price}]`;
        if (isRetired(m)) { opt.disabled = true; label += ' — unavailable (retired)'; }
        else if (m.disabled) { opt.disabled = true; label += ' — unavailable (disabled)'; }
        else if (!hasAuth(m)) { opt.disabled = true; label += ' — unavailable (no API key)'; }
        else if (m.lifecycle === 'deprecated') label += m.retiresAt ? ` (deprecated, retiring ${m.retiresAt})` : ' (deprecated)';
        opt.textContent = label;
        if (modelMap[family] === m.name) opt.selected = true;
        sel.appendChild(opt);
      });
    });

    // Per-tab --model. Empty means "unset", which makes the server re-apply the
    // tab-strip cog default at the next spawn.
    const modelSel = settingsModal.querySelector('[data-setting="model"]');
    if (modelSel) {
      const cogDefault = state.cliModel || 'opus';
      modelSel.innerHTML = `<option value="">Default (${escHtml(cogDefault)}, from the ⚙ cog)</option>`;
      let lastGroup = null;
      let matched = false;
      for (const opt of modelPickerOptions()) {
        if (opt.group !== lastGroup) {
          lastGroup = opt.group;
          const sep = document.createElement('option');
          sep.disabled = true;
          sep.textContent = `── ${opt.group} ──`;
          modelSel.appendChild(sep);
        }
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.price ? `${opt.label}  [${opt.price}]` : opt.label;
        if (settings.model === opt.value) { o.selected = true; matched = true; }
        modelSel.appendChild(o);
      }
      // A tab pinned to a model the catalog no longer offers (retired, or an
      // alias removed from the list) must still show what it is actually running.
      if (settings.model && !matched) {
        const o = document.createElement('option');
        o.value = settings.model;
        o.textContent = `${settings.model} — not in catalog`;
        o.selected = true;
        modelSel.appendChild(o);
      }
    }

    const showThinking = settingsModal.querySelector('[data-setting="showThinking"]');
    if (showThinking) showThinking.checked = !!settings.showThinking;
  }

  function saveSettings() {
    if (!settingsModal) return;
    const tabId = settingsModal._tabId;
    const tab = tabs.get(tabId);
    const modelMap = {};
    ['fable', 'opus', 'sonnet', 'haiku'].forEach(family => {
      const sel = settingsModal.querySelector(`[data-map="${family}"]`);
      modelMap[family] = sel?.value || null;
    });
    const showThinking = settingsModal.querySelector('[data-setting="showThinking"]');
    const modelSel = settingsModal.querySelector('[data-setting="model"]');
    const settings = {
      modelMap,
      model: modelSel?.value || null,
      showThinking: !!showThinking?.checked,
    };
    if (tab) tab.settings = { ...tab.settings, ...settings };
    sendWs({ type: 'cli:settings', tabId, settings });
    settingsModal.classList.add('hidden');
    renderTabStrip();
    window.inspectorModule?.renderInspectorTabStrip?.();
  }

  settingsModal?.querySelectorAll('.cli-settings-cancel').forEach(el => {
    el.addEventListener('click', () => settingsModal.classList.add('hidden'));
  });
  settingsModal?.querySelector('.cli-settings-save')?.addEventListener('click', saveSettings);

  settingsModal?.querySelector('.cli-settings-open-dir')?.addEventListener('click', () => {
    const dir = settingsModal._interactionsDir;
    if (!dir) return;
    const dirs = window.directoriesModule;
    if (dirs?.openPath) {
      switchView('directories');
      dirs.openPath(dir);
      settingsModal.classList.add('hidden');
    }
  });

  settingsModal?.querySelector('.cli-settings-remove-turn')?.addEventListener('click', () => {
    const tabId = settingsModal._tabId;
    if (!tabId) return;
    if (!confirm('Remove the last interaction turn? It will be struck through and no longer count toward the session context going forward. You can still click it to view the response.')) return;
    sendWs({ type: 'cli:removeLastTurn', tabId });
    settingsModal.classList.add('hidden');
  });

  // --- Message handler ---
  function handleMessage(msg) {
    switch (msg.type) {
      case 'prefs:cliModel': {
        updateModelCog();
        // Keep an open picker in sync when the change came from another window.
        if (document.getElementById('cliModelMenu')) showModelMenu();
        break;
      }
      case 'cli:output': {
        const tab = tabs.get(msg.tabId);
        if (tab) tab.terminal.write(msg.data);
        break;
      }
      case 'cli:exit': {
        const tab = tabs.get(msg.tabId);
        if (tab) {
          tab.status = 'exited';
          tab.terminal.write('\r\n\x1b[90m[Process exited' + (msg.exitCode != null ? ' with code ' + msg.exitCode : '') + ']\x1b[0m\r\n');
          renderTabStrip();
          const timer = setTimeout(() => { _pendingRemoval.delete(msg.tabId); removeTab(msg.tabId); }, 1500);
          _pendingRemoval.set(msg.tabId, timer);
        }
        break;
      }
      case 'cli:spawned': {
        const pendingTimer = _pendingRemoval.get(msg.tabId);
        if (pendingTimer) { clearTimeout(pendingTimer); _pendingRemoval.delete(msg.tabId); }
        let tab = tabs.get(msg.tabId);
        if (!tab && !msg.hidden) {
          // A tab we have not seen yet: either an app action tab, or one the
          // server restored at boot (its cli:spawned lands before the cli:tabs
          // that would otherwise introduce it). Adopt it either way.
          const isAppCli = msg.tabId.startsWith('app-');
          tab = createTab(msg.tabId);
          if (isAppCli) {
            switchTab(msg.tabId);
            if (typeof switchView === 'function') switchView('claude');
          }
        }
        if (tab) {
          _scrollbackLoaded.add(msg.tabId);
          tab.status = 'running';
          tab.cwd = msg.cwd;
          if (msg.instanceId) {
            tab.instanceId = msg.instanceId;
            tab.sessId = msg.instanceId.replace(/^cli-/, '');
          }
          if (msg.autoMemory != null) tab.autoMemory = msg.autoMemory;
          if (msg.title) tab.title = msg.title;
          tab.settings = msg.settings || {};
          renderTabStrip();
        }
        break;
      }
      case 'cli:tabs': {
        handleTabList(msg.tabs || [], msg.bootId || null, msg.droppedTabs || null);
        break;
      }
      case 'cli:newTab': {
        const tabId = msg.tabId;
        if (!tabs.has(tabId)) createTab(tabId);
        switchTab(tabId);

        // Claim this reply's own intent by correlation id. An unmatched reply is
        // an empty tab (the server minted one we have no plan for), not a licence
        // to consume somebody else's pending spawn.
        const intent = msg.reqId ? _pendingNewTabs.get(msg.reqId) : null;
        if (msg.reqId) _pendingNewTabs.delete(msg.reqId);
        if (!intent || !intent.cwd) break;

        if (intent.settings) {
          sendWs({ type: 'cli:settings', tabId, settings: intent.settings });
        }
        const tab = tabs.get(tabId);
        if (tab) {
          tab.autoMemory = intent.autoMemory === true;
          if (intent.resumeSessionId) tab.sessId = intent.resumeSessionId;
        }
        const { cols, rows } = tab ? { cols: tab.terminal.cols, rows: tab.terminal.rows } : { cols: 80, rows: 24 };
        const spawnMsg = {
          type: 'cli:spawn', tabId, cwd: intent.cwd, cols, rows,
          autoMemory: intent.autoMemory === true,
        };
        if (intent.resumeSessionId) spawnMsg.resumeSessionId = intent.resumeSessionId;
        sendWs(spawnMsg);
        maybeNotifyNoSubscription();
        break;
      }
      case 'cli:settingsData': {
        populateSettings(msg.tabId, msg.settings || {}, msg.models || [], msg.hasSubscription, msg.interactionsDir);
        break;
      }
      case 'cli:savedSessions': {
        if (state._showNewMenu) {
          state._showNewMenu = false;
          showNewMenu(msg.sessions || []);
        }
        break;
      }
      case 'cli:lastTurnRemoved': {
        if (msg.ok) {
          if (msg.tabId) switchTab(msg.tabId);
          window.dashboard.showToast?.({
            sender: 'CLI',
            title: 'Last interaction turn removed',
            message: 'The last turn was rolled back and no longer counts toward context. You can continue in the CLI tab.',
            level: 'success',
          });
        } else {
          const reasons = {
            'no-session': 'No running session for this tab.',
            'no-transcript': 'No session transcript was found to roll back.',
            'no-user-turn': 'No user turn was found to remove.',
            'write-failed': 'Could not write the rolled-back transcript.',
          };
          window.dashboard.showToast?.({
            sender: 'CLI',
            title: 'Could not remove last turn',
            message: reasons[msg.reason] || ('Failed' + (msg.reason ? ': ' + msg.reason : '') + '.'),
            level: 'error',
          });
        }
        break;
      }
      case 'cli:fileUploaded': {
        break;
      }
    }
  }

  // Report tabs the server's startup restore could not bring back, so they do not
  // just silently disappear. Once per page load.
  let _droppedToastShown = false;
  function _reportDroppedTabs(dropped) {
    if (_droppedToastShown || !Array.isArray(dropped) || dropped.length === 0) return;
    _droppedToastShown = true;
    const reasons = {
      shell: 'shell tabs cannot be resumed (no transcript)',
      'no-transcript': 'transcript missing',
    };
    const lines = dropped.map(d => `${d.title || d.cwd} — ${reasons[d.reason] || d.reason}`);
    window.dashboard.showToast?.({
      sender: 'CLI',
      title: `${dropped.length} tab${dropped.length !== 1 ? 's' : ''} not restored`,
      message: lines.join('\n'),
      level: 'warning',
      duration: 12000,
    });
  }

  // Dispose all client-side terminals without telling the server (these tabIds
  // belong to a process that is gone) and without clearing inspector instances,
  // whose history must survive the restart.
  function _teardownAllTabsLocal() {
    for (const [tabId, tab] of tabs) {
      dismissAskModalsForTab(tabId);
      _scrollbackLoaded.delete(tabId);
      try { tab.terminal.dispose(); } catch {}
      tab._resizeObserver?.disconnect();
      tab.wrap?.remove();
    }
    tabs.clear();
    activeTabId = null;
    for (const timer of _pendingRemoval.values()) clearTimeout(timer);
    _pendingRemoval.clear();
  }

  // The server owns the tab list: it persists which tabs were open and respawns
  // them itself at boot. This is therefore a pure sync — adopt whatever the server
  // reports. There is no client-side recovery left to race, so two dashboard
  // windows can no longer each resume the same session.
  function handleTabList(serverTabs, bootId, droppedTabs) {
    _reportDroppedTabs(droppedTabs);

    // A changed bootId means this is a different server process than the one we
    // last synced with. Our tabIds embed the old process's bootId and can never
    // be re-bound, so drop the orphaned terminals before adopting the new list.
    const knownBootId = _loadBootId();
    const restarted = !!(knownBootId && bootId && knownBootId !== bootId);
    if (bootId) _saveBootId(bootId);
    if (restarted) _teardownAllTabsLocal();

    const serverIds = new Set(serverTabs.map(t => t.tabId));
    for (const [tabId] of tabs) {
      if (!serverIds.has(tabId)) removeTab(tabId);
    }
    for (const st of serverTabs) {
      if (!tabs.has(st.tabId)) createTab(st.tabId);
      const tab = tabs.get(st.tabId);
      tab.status = st.status;
      tab.cwd = st.cwd;
      tab.title = st.title || null;
      tab.settings = st.settings || {};
      if (st.instanceId) tab.instanceId = st.instanceId;
      if (st.sessId) tab.sessId = st.sessId;
      if (st.autoMemory != null) tab.autoMemory = st.autoMemory;
    }
    if (!activeTabId && tabs.size > 0) {
      const first = Array.from(tabs.keys())[0];
      switchTab(first);
    }
    renderTabStrip();
    window.inspectorModule?.renderInspectorTabStrip?.();
  }

  function updateStreamingState(streamingInstances) {
    if (!tabStrip) return;
    let anyStreaming = false;
    for (const [tabId, tab] of tabs) {
      const instanceId = tab.instanceId;
      const streaming = instanceId ? streamingInstances.has(instanceId) : false;
      if (streaming) anyStreaming = true;
      const tabBtn = tabStrip.querySelector(`[data-tab-id="${tabId}"]`);
      if (tabBtn) tabBtn.classList.toggle('instance-running', streaming);
    }
    const cliHeaderTab = document.querySelector('[data-view="claude"]');
    if (cliHeaderTab) cliHeaderTab.classList.toggle('instance-running', anyStreaming);
  }

  // --- AskUserQuestion overlay ---

  function getAskLayer() {
    let layer = document.getElementById('ask-modal-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'ask-modal-layer';
      document.body.appendChild(layer);
    }
    return layer;
  }

  function makeAskDraggable(modal, handle) {
    let startX = 0, startY = 0, baseLeft = 0, baseTop = 0, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input, textarea, select, a')) return;
      dragging = true;
      const rect = modal.getBoundingClientRect();
      baseLeft = rect.left;
      baseTop = rect.top;
      startX = e.clientX;
      startY = e.clientY;
      modal.style.left = baseLeft + 'px';
      modal.style.top = baseTop + 'px';
      modal.style.transform = 'none';
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const maxLeft = window.innerWidth - 60;
      const maxTop = window.innerHeight - 40;
      const left = Math.min(Math.max(0, baseLeft + (e.clientX - startX)), maxLeft);
      const top = Math.min(Math.max(0, baseTop + (e.clientY - startY)), maxTop);
      modal.style.left = left + 'px';
      modal.style.top = top + 'px';
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch {}
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function showAskModal(askId, forms, meta) {
    dismissAskModal(askId);
    meta = meta || {};

    const layer = getAskLayer();
    const modal = document.createElement('div');
    modal.className = 'cli-ask-modal';

    // Cascade each new modal so multiple are all visible.
    const offset = (_askCascade++ % 6) * 28;
    modal.style.left = `calc(50% + ${offset}px)`;
    modal.style.top = `${80 + offset}px`;

    const header = document.createElement('div');
    header.className = 'cli-ask-header';
    const folder = meta.cwd ? meta.cwd.split('/').filter(Boolean).pop() : null;
    const titleText = meta.title || folder || 'Question';
    const titleEl = document.createElement('span');
    titleEl.className = 'cli-ask-header-title';
    titleEl.textContent = titleText;
    header.appendChild(titleEl);
    if (meta.cwd) {
      const pathEl = document.createElement('span');
      pathEl.className = 'cli-ask-header-path';
      pathEl.textContent = meta.cwd;
      header.appendChild(pathEl);
    }
    modal.appendChild(header);

    const isSingle = forms.length === 1;
    const binders = [];

    if (!isSingle) {
      const tabBar = document.createElement('div');
      tabBar.className = 'cli-ask-tabs';
      forms.forEach((f, idx) => {
        const t = document.createElement('button');
        t.className = 'cli-ask-tab' + (idx === 0 ? ' active' : '');
        t.textContent = f.formData.title || `Question ${idx + 1}`;
        t.addEventListener('click', () => {
          tabBar.querySelectorAll('.cli-ask-tab').forEach(b => b.classList.remove('active'));
          t.classList.add('active');
          body.querySelectorAll('.cli-ask-form-panel').forEach(p => p.classList.remove('active'));
          body.children[idx].classList.add('active');
        });
        tabBar.appendChild(t);
      });
      modal.appendChild(tabBar);
    }

    const body = document.createElement('div');
    body.className = 'cli-ask-body';

    forms.forEach((f, idx) => {
      const panel = document.createElement('div');
      if (isSingle) {
        panel.style.display = 'block';
      } else {
        panel.className = 'cli-ask-form-panel' + (idx === 0 ? ' active' : '');
        panel.classList.add('ask-external-submit');
      }
      if (isSingle && !f.formData.cancelLabel) f.formData.cancelLabel = 'Cancel';
      panel.innerHTML = askFormBuildHTML(f.formData);

      const binder = askFormBind(panel, f.formData, isSingle ? {
        onSubmit: (answer, files) => {
          sendWs({ type: 'ask:answer', toolUseId: f.toolUseId, answer, files });
          dismissAskModal(askId);
        },
        onCancel: () => {
          sendWs({ type: 'ask:answer', toolUseId: f.toolUseId, answer: [{ id: '_cancelled', question: '', answer: 'cancelled' }] });
          dismissAskModal(askId);
        },
      } : {
        onSubmit: () => {},
        onCancel: () => {},
      });
      binders.push({ binder, form: f });
      body.appendChild(panel);
    });

    modal.appendChild(body);

    if (!isSingle) {
      const footer = document.createElement('div');
      footer.className = 'cli-ask-footer';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'ask-cancel-btn';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => {
        for (const { binder, form } of binders) {
          binder.disableForm();
          sendWs({ type: 'ask:answer', toolUseId: form.toolUseId, answer: [{ id: '_cancelled', question: '', answer: 'cancelled' }] });
        }
        dismissAskModal(askId);
      });
      footer.appendChild(cancelBtn);

      const submitBtn = document.createElement('button');
      submitBtn.className = 'ask-submit-btn';
      submitBtn.textContent = 'Submit All';
      submitBtn.disabled = true;

      const updateReady = () => {
        submitBtn.disabled = !binders.every(b => b.binder.checkReady());
      };

      const observer = new MutationObserver(updateReady);
      observer.observe(body, { subtree: true, attributes: true, childList: true, characterData: true });
      body.addEventListener('input', updateReady);
      body.addEventListener('change', updateReady);
      setTimeout(updateReady, 0);

      submitBtn.addEventListener('click', () => {
        for (const { binder, form } of binders) {
          const answer = binder.collectAnswers();
          const files = binder.getFileData();
          sendWs({ type: 'ask:answer', toolUseId: form.toolUseId, answer, files });
          binder.disableForm();
        }
        dismissAskModal(askId);
      });
      footer.appendChild(submitBtn);
      modal.appendChild(footer);
    }

    makeAskDraggable(modal, header);
    layer.appendChild(modal);
    pendingAskOverlays.set(askId, { overlayEl: modal, tabId: meta.tabId || null });
    renderTabStrip();
  }

  function dismissAskModal(askId) {
    const pending = pendingAskOverlays.get(askId);
    if (pending) {
      pending.overlayEl.remove();
      pendingAskOverlays.delete(askId);
      renderTabStrip();
    }
  }

  function dismissAskModalsForTab(tabId) {
    for (const [askId, pending] of pendingAskOverlays) {
      if (pending.tabId === tabId) {
        pending.overlayEl.remove();
        pendingAskOverlays.delete(askId);
      }
    }
    renderTabStrip();
  }

  function handleAskMessage(msg) {
    switch (msg.type) {
      case 'ask:question': {
        const askId = msg.askId || (msg.toolUseIds && msg.toolUseIds[0]);
        if (!askId) return;
        showAskModal(askId, msg.forms || [], { title: msg.title, cwd: msg.cwd, tabId: msg.tabId });
        break;
      }
      case 'ask:answered':
      case 'ask:timeout': {
        if (msg.askId) dismissAskModal(msg.askId);
        break;
      }
    }
  }


  // Expose module
  window.cliModule = { handleMessage, handleAskMessage, tabs, updateStreamingState, switchTab, computeTabLabel };
})();
