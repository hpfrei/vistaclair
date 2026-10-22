(function () {
  const { sendWs, state, escHtml, askFormBuildHTML, askFormBind } = window.dashboard;
  const tabStrip = document.getElementById('cliTabStrip');
  const tabNewBtn = document.getElementById('cliTabNew');
  const modelCog = document.getElementById('cliModelCog');
  const container = document.getElementById('cliContainer');
  const sessionsView = document.getElementById('cliSessions');
  const settingsModal = document.getElementById('cliSettingsModal');

  const tabs = new Map();
  // null while the Sessions tab shows (cards of every saved session).
  let activeTabId = null;
  const SC = window.sessionCards;
  let _savedData = null;          // { sessions, runs } from cli:savedSessions
  let _sessionsPinned = false;    // picked by the user: a tab-list sync leaves it
  let _sessionsReqTimer = null;
  let _sessionsHtml = '';
  const pendingAskOverlays = new Map(); // askId -> { overlayEl, tabId }
  let _askCascade = 0;
  const _scrollbackLoaded = new Set();
  const _pendingRemoval = new Map();

  // Intent for a new tab, keyed by the correlation id sent with cli:newTab. The
  // server echoes reqId back, so two rapid requests can never claim each other's
  // cwd/settings the way a single shared slot or a positional queue could.
  const _pendingNewTabs = new Map();
  let _reqSeq = 0;

  // A tab is an xterm terminal ('cli') or an Agent SDK panel ('sdk').
  const kindOf = (t) => (t?.kind === 'sdk' || t?.settings?.engine === 'sdk') ? 'sdk' : 'cli';
  const isSdk = (tab) => tab?.kind === 'sdk';
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

  // ---- Phone bar: key row + composer + "new output" pill -----------------
  // Soft keyboards autocorrect and swallow control keys, so on a phone the
  // terminal is read-only-by-default and input goes through a composer that
  // sends whole lines. The key row covers what a TUI needs beyond text:
  // Esc, Tab, Shift-Tab, arrows, Ctrl-C, Enter, y/n. Built only at phone
  // width (mobile.css hides it elsewhere); all through the same cli:input.
  const _mobileBar = (() => {
    const view = document.getElementById('view-claude');
    if (!view) return null;
    const FONT_KEY = 'cliMobileFontSize';
    let fontSize = Math.min(20, Math.max(9, parseInt(localStorage.getItem(FONT_KEY), 10) || 12));

    const bar = document.createElement('div');
    bar.className = 'mobile-cli-bar';
    bar.innerHTML = `
      <button class="mobile-cli-pill hidden" type="button">↓ new output</button>
      <div class="mobile-cli-keys">
        <button type="button" data-seq="">Esc</button>
        <button type="button" data-seq="\t">Tab</button>
        <button type="button" data-seq="[Z">⇧Tab</button>
        <button type="button" data-seq="[A">↑</button>
        <button type="button" data-seq="[B">↓</button>
        <button type="button" data-seq="\r">↵</button>
        <button type="button" data-seq="" class="is-danger">^C</button>
        <button type="button" data-seq="y">y</button>
        <button type="button" data-seq="n">n</button>
        <span class="mobile-cli-keys-sep"></span>
        <button type="button" data-font="-1">A−</button>
        <button type="button" data-font="1">A+</button>
      </div>
      <div class="mobile-cli-compose">
        <textarea rows="1" placeholder="Type a message…" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
        <button type="button" class="mobile-cli-send" aria-label="Send">➤</button>
      </div>`;
    view.appendChild(bar);

    const pill = bar.querySelector('.mobile-cli-pill');
    const input = bar.querySelector('textarea');
    const sendBtn = bar.querySelector('.mobile-cli-send');
    const active = () => tabs.get(activeTabId);
    const atBottom = t => t.buffer.active.viewportY >= t.buffer.active.baseY;

    // SDK tabs have their own composer (the bar is hidden for them); every
    // terminal call here is for xterm tabs only.
    function sendSeq(seq) {
      const tab = active();
      if (!tab?.terminal) return;
      sendWs({ type: 'cli:claim', tabId: activeTabId, cols: tab.terminal.cols, rows: tab.terminal.rows });
      sendWs({ type: 'cli:input', tabId: activeTabId, data: seq });
      tab.terminal.scrollToBottom();
    }
    function submit() {
      const text = input.value.replace(/\r?\n$/, '');
      if (!text.trim() || !active()?.terminal) return;
      // Text first, Enter a beat later — the way a paste-then-Enter lands,
      // so a multi-line message is not submitted at its first newline.
      sendSeq(text.replace(/\n/g, '\r'));
      setTimeout(() => sendSeq('\r'), 60);
      input.value = '';
      input.style.height = '';
      input.focus();
    }

    bar.querySelector('.mobile-cli-keys').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.seq != null) { sendSeq(b.dataset.seq); return; }
      if (b.dataset.font) {
        fontSize = Math.min(20, Math.max(9, fontSize + Number(b.dataset.font)));
        localStorage.setItem(FONT_KEY, String(fontSize));
        for (const tab of tabs.values()) if (tab.terminal) tab.terminal.options.fontSize = fontSize;
        const tab = active();
        if (tab?.fitAddon) try { tab.fitAddon.fit(); } catch {}
      }
    });
    sendBtn.addEventListener('click', submit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    });
    // Grow with the text, up to a few lines.
    input.addEventListener('input', () => {
      input.style.height = '';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
    pill.addEventListener('click', () => {
      const tab = active();
      if (tab?.terminal) tab.terminal.scrollToBottom();
      pill.classList.add('hidden');
    });

    // The pill shows when output lands while the viewer is scrolled up
    // (reading history); scrolling back to the bottom clears it.
    function onOutput(tab) {
      if (!tab?.terminal || !window.dashboard.isPhone?.()) return;
      // write() is async; look once the buffer has the new lines.
      requestAnimationFrame(() => {
        if (tab !== active()) return;
        pill.classList.toggle('hidden', atBottom(tab.terminal));
      });
    }
    function onTabChange(tab) {
      pill.classList.add('hidden');
      view.classList.toggle('sdk-tab-active', isSdk(tab));
      view.classList.toggle('cli-sessions-active', !tab);
      if (tab?.terminal && !tab._mobileScrollHooked) {
        tab._mobileScrollHooked = true;
        tab.terminal.onScroll(() => { if (atBottom(tab.terminal)) pill.classList.add('hidden'); });
      }
    }
    return { onOutput, onTabChange, fontSize: () => (window.dashboard.isPhone?.() ? fontSize : 14) };
  })();

  function createTab(tabId, kind = 'cli') {
    if (kind === 'sdk') return createSdkTab(tabId);
    const wrap = document.createElement('div');
    wrap.className = 'cli-terminal-wrap';
    wrap.style.display = 'none';

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: _mobileBar?.fontSize() ?? 14,
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
    // The server only honours resizes from the viewer that owns the session
    // (the last one to type). Tapping into the terminal claims it, so a phone
    // that has not typed yet still gets the PTY reflowed to its width.
    wrap.addEventListener('pointerdown', () => {
      sendWs({ type: 'cli:claim', tabId, cols: terminal.cols, rows: terminal.rows });
    });

    _setupDropOverlay(wrap, tabId);

    const tab = { kind: 'cli', terminal, fitAddon, wrap, cwd: null, title: null, settings: {}, status: 'idle' };
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

  // An Agent SDK tab: no terminal, no PTY size, no scrollback. sdk-panel.js
  // renders its areas into the wrap; the tab keeps the same registry fields so
  // the strip, the menus and the Inspector treat it like any other tab.
  function createSdkTab(tabId) {
    const wrap = document.createElement('div');
    wrap.className = 'cli-terminal-wrap cli-sdk-wrap';
    wrap.style.display = 'none';
    const tab = { kind: 'sdk', terminal: null, fitAddon: null, wrap, cwd: null, title: null, settings: {}, status: 'idle' };
    tabs.set(tabId, tab);
    container.appendChild(wrap);
    window.sdkPanel?.mount(tabId, wrap);
    return tab;
  }

  function sdkInfo(tab) {
    return { sessId: tab.sessId, title: tab.title, cwd: tab.cwd, settings: tab.settings, status: tab.status, pausing: tab.pausing === true, state: tab.sdkState, costUsd: tab.costUsd };
  }

  // Drop a tab's view without telling the server or the Inspector.
  function _disposeTabView(tabId, tab) {
    if (isSdk(tab)) window.sdkPanel?.unmount(tabId);
    else try { tab.terminal?.dispose(); } catch {}
    tab._resizeObserver?.disconnect();
    tab.wrap?.remove();
  }

  // The tab with this id, of this kind. A tab first created as a terminal
  // (before the server said what it is) is rebuilt as the right view.
  function ensureTab(tabId, kind) {
    const tab = tabs.get(tabId);
    if (tab && (!kind || tab.kind === kind)) return tab;
    if (tab) {
      _disposeTabView(tabId, tab);
      tabs.delete(tabId);
      _scrollbackLoaded.delete(tabId);
      const fresh = createTab(tabId, kind);
      for (const k of ['cwd', 'title', 'settings', 'status', 'pausing', 'instanceId', 'sessId', 'autoMemory']) {
        if (tab[k] !== undefined) fresh[k] = tab[k];
      }
      if (isSdk(fresh)) window.sdkPanel?.update(tabId, sdkInfo(fresh));
      if (activeTabId === tabId) switchTab(tabId);
      return fresh;
    }
    return createTab(tabId, kind || 'cli');
  }

  function switchTab(tabId) {
    for (const [id, tab] of tabs) {
      tab.wrap.style.display = id === tabId ? '' : 'none';
    }
    activeTabId = tabId;
    _sessionsPinned = false;
    if (sessionsView) sessionsView.style.display = 'none';
    renderTabStrip();
    const tab = tabs.get(tabId);
    window.sdkPanel?.setActive(isSdk(tab) ? tabId : null);
    if (isSdk(tab)) {
      _mobileBar?.onTabChange(tab);
    } else if (tab) {
      if (!_scrollbackLoaded.has(tabId)) {
        _scrollbackLoaded.add(tabId);
        sendWs({ type: 'cli:requestScrollback', tabId });
      }
      setTimeout(() => {
        try { tab.fitAddon.fit(); } catch {}
        // Focusing xterm's hidden textarea would raise the soft keyboard on
        // every tab switch; phones type through the composer instead.
        if (!window.dashboard.isPhone?.()) tab.terminal.focus();
      }, 50);
      _mobileBar?.onTabChange(tab);
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

    // The Sessions tab: always first, no close button.
    const home = document.createElement('button');
    home.className = 'view-tab cli-sessions-tab' + (activeTabId === null ? ' active' : '');
    home.textContent = 'Sessions';
    home.title = 'Every saved session: resume, switch to or delete it';
    home.addEventListener('click', () => showSessions(true));
    tabStrip.insertBefore(home, tabStrip.firstChild);

    for (const [tabId, tab] of tabs) {
      const btn = document.createElement('button');
      const hasPendingAsk = Array.from(pendingAskOverlays.values()).some(p => p.tabId === tabId);
      btn.className = 'view-tab' + (tabId === activeTabId ? ' active' : '') + (hasPendingAsk ? ' has-pending-ask' : '');
      btn.dataset.tabId = tabId;

      const label = document.createElement('span');
      label.className = 'cli-tab-label';
      const isAppCli = tabId.startsWith('app-');
      // Orchestration role from the tab's stamp: compass for the orchestrator,
      // gear for its workers.
      const orchRole = tab.settings?.orchestration?.role;
      const roleBadge = orchRole === 'orchestrator' ? '\u{1F9ED} ' : orchRole === 'worker' ? '⚙️ ' : '';
      label.textContent = roleBadge + (isAppCli ? '\u{1F528} ' : '') + computeTabLabel(tabId);
      if (isSdk(tab)) {
        const sdkBadge = document.createElement('span');
        sdkBadge.className = 'cli-sdk-badge';
        sdkBadge.textContent = 'SDK';
        sdkBadge.title = `Agent SDK session (${tab.settings?.auth === 'subscription' ? 'Claude subscription' : 'API key'} billing)`;
        label.appendChild(sdkBadge);
      }
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
          if (clickedTab?.instanceId) window.inspectorModule?.openSession?.(clickedTab.instanceId);
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

      // Pause: a plain tab pauses itself, an orchestrator its whole run; a
      // worker only through its orchestrator. While pausing, it offers
      // "Interrupt now" — a pause has no timeout.
      if (tab.status === 'running' && orchRole !== 'worker') {
        const pauseBtn = document.createElement('span');
        pauseBtn.className = 'cli-model-override-btn cli-pause-btn' + (tab.pausing ? ' pausing' : '');
        pauseBtn.textContent = tab.pausing ? '⏹' : '⏸';
        pauseBtn.title = tab.pausing
          ? 'Pausing… (the session is writing its resume note). Click to interrupt now.'
          : orchRole === 'orchestrator'
            ? 'Pause the run: workers write their notes and close, then the orchestrator. Resume from the Sessions tab.'
            : 'Pause: the session finishes its step, writes its resume note and closes. Resume from the Sessions tab.';
        pauseBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (tab.pausing) {
            if (confirm('Interrupt now? The session stops mid-step and is saved as interrupted; its resume note may be missing.')) {
              sendWs({ type: 'cli:interrupt', tabId });
            }
            return;
          }
          sendWs({ type: 'cli:pause', tabId });
        });
        btn.appendChild(pauseBtn);
      }
      if (tab.pausing) btn.classList.add('cli-tab-pausing');

      // Land: an isolated plain session's branch into its base, by the server.
      const wt = tab.settings?.worktree;
      if (wt && !wt.removed && !orchRole) {
        const landBtn = document.createElement('span');
        landBtn.className = 'cli-model-override-btn cli-land-btn';
        landBtn.textContent = '⤵';
        landBtn.title = `Land ${wt.branch} into ${wt.base} (rebase, check, merge --no-ff)` + (wt.lastLanding ? `\nLast: ${wt.lastLanding.text}` : '');
        landBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          sendWs({ type: 'cli:land', tabId });
        });
        btn.appendChild(landBtn);
      }

      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '×';
      // Hover opens the close menu; click opens it too, for touch screens.
      close.addEventListener('mouseenter', () => showCloseMenu(tabId, close));
      close.addEventListener('mouseleave', scheduleCloseMenuClose);
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        showCloseMenu(tabId, close);
      });
      btn.appendChild(close);

      btn.addEventListener('click', () => switchTab(tabId));
      tabStrip.insertBefore(btn, tabNewBtn);
    }
    // The new buttons take the busy dots before the next paint.
    updateStreamingState();
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
      _disposeTabView(tabId, tab);
      tabs.delete(tabId);
      updateStreamingState();
    }
    if (activeTabId === tabId) {
      const remaining = Array.from(tabs.keys());
      if (remaining.length > 0) switchTab(remaining[remaining.length - 1]);
      else showSessions(false);
    } else if (sessionsShown()) {
      renderTabStrip();
      requestSavedSessions();
    }
  }

  // --- Tab × menu: close, or close and drop the session from the resume list ---
  let _closeMenuTimer = null;

  function showCloseMenu(tabId, anchor) {
    clearTimeout(_closeMenuTimer);
    const existing = document.getElementById('cliCloseMenu');
    if (existing?.dataset.tabId === tabId) return;
    closeCloseMenu();
    const menu = document.createElement('div');
    menu.className = 'cli-new-menu cli-close-menu';
    menu.id = 'cliCloseMenu';
    menu.dataset.tabId = tabId;

    const addItem = (text, forget) => {
      const item = document.createElement('div');
      item.className = 'cli-new-menu-item' + (forget ? ' cli-close-menu-forget' : '');
      item.textContent = text;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        closeCloseMenu();
        sendWs({ type: 'cli:closeTab', tabId, forget });
        // A run member may be refused (cli:closeRefused); the server's tab
        // list removes it once it is really closed.
        if (!tabs.get(tabId)?.settings?.orchestration) removeTab(tabId);
      });
      menu.appendChild(item);
    };
    addItem('Close', false);
    addItem('Close and remove interaction', true);

    menu.addEventListener('mouseenter', () => clearTimeout(_closeMenuTimer));
    menu.addEventListener('mouseleave', scheduleCloseMenuClose);
    document.body.appendChild(menu);

    const rect = anchor.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = rect.bottom + 4 + 'px';
    const menuWidth = menu.offsetWidth;
    let left = rect.left + rect.width / 2 - menuWidth / 2;
    if (left + menuWidth > window.innerWidth - 8) left = window.innerWidth - menuWidth - 8;
    if (left < 8) left = 8;
    menu.style.left = left + 'px';

    const onClickOutside = (e) => {
      if (!menu.contains(e.target) && e.target !== anchor) closeCloseMenu();
    };
    menu._onClickOutside = onClickOutside;
    setTimeout(() => document.addEventListener('click', onClickOutside, true), 0);
  }

  function scheduleCloseMenuClose() {
    clearTimeout(_closeMenuTimer);
    _closeMenuTimer = setTimeout(closeCloseMenu, 250);
  }

  function closeCloseMenu() {
    clearTimeout(_closeMenuTimer);
    const menu = document.getElementById('cliCloseMenu');
    if (!menu) return;
    document.removeEventListener('click', menu._onClickOutside, true);
    menu.remove();
  }

  // --- "+" button: a new CLI in a directory ---
  tabNewBtn?.addEventListener('click', () => openNewCli());

  async function openNewCli() {
    const picked = await openFsDirPicker();
    if (!picked) return;
    // The server decides the engine and the session type (an Agent SDK panel
    // opens an orchestrator; a terminal asks Simple / Orchestrator), asks an
    // SDK session's billing (openCli), mints the tab and launches it;
    // cli:opened switches to it. Size the PTY like the active tab.
    const { cols, rows } = terminalSize(80, 24);
    sendWs({
      type: 'cli:open',
      reqId: `open-${++_reqSeq}`,
      cwd: picked.dir,
      autoMemory: picked.autoMemory === true,
      // A simple CLI in its own git worktree (an orchestrator's run isolates its workers).
      ...(picked.worktree ? { isolation: 'worktree', landOnClose: picked.landOnClose === true } : {}),
      cols,
      rows,
    });
  }

  // The size of the active terminal, else of any open one.
  function terminalSize(cols, rows) {
    const t = tabs.get(activeTabId)?.terminal || [...tabs.values()].find(x => x.terminal)?.terminal;
    return t ? { cols: t.cols, rows: t.rows } : { cols, rows };
  }

  // --- Saved-session actions (the Sessions tab's cards) ---

  // An orchestrator resumes its whole run: its own transcript (it warms its
  // workers up), or a fresh orchestrator from the notes.
  function resumeRun(runId, fresh) {
    sendWs({ type: 'cli:resumeRun', runId, fresh: fresh === true });
  }

  function deleteRun(runId) {
    if (!confirm(`Delete run ${runId} permanently?\n\n`
      + 'This is not a rollback: your code, commits and merged work are not touched.\n\n'
      + 'Removed: the conversation history of the orchestrator and every worker, their TODO/NOTES, '
      + "the run's session folder and its git worktrees. Unmerged branches are kept.\n\n"
      + 'This cannot be undone.')) return;
    sendWs({ type: 'cli:deleteRun', runId });
  }

  // The server resumes it: a paused or interrupted one is told to pick up
  // from its folder, a run worker goes through its orchestration, and one
  // whose conversation is gone starts fresh from its folder instead of dying
  // on open.
  function resumeSaved(sessionId) {
    const { cols, rows } = terminalSize(120, 32);
    sendWs({ type: 'cli:resumeSaved', sessionId, cols, rows });
  }

  // An orchestrator is deleted with its run (the server refuses it alone); a
  // refused delete is confirmed again through cli:deleteRefused.
  function deleteSaved(sess) {
    if (!sess) return;
    if (sess.group?.role === 'orchestrator') { deleteRun(sess.group.runId); return; }
    if (!confirm(`Delete "${savedTitle(sess)}" permanently?\n\n`
      + 'This is not a rollback: your code, commits and merged work are not touched.\n\n'
      + 'Removed: its conversation history, its interaction data and its TODO/NOTES folder.\n\n'
      + 'This cannot be undone.')) return;
    sendWs({ type: 'cli:deleteSavedSession', sessionId: sess.id });
  }

  function savedTitle(sess) {
    const parts = String(sess.cwd || '').replace(/\/+$/, '').split('/');
    return sess.title || parts[parts.length - 1] || sess.cwd || sess.id;
  }

  // --- Sessions tab ---
  // The fixed first tab of the strip, never closed, shown whenever no CLI tab
  // is: every saved session as a card. A run (orchestrator and workers) is
  // one card from the server's run summary (cli:savedSessions `runs`); a
  // plain session is a card of its own. Refreshed on cli:savedSessions, on
  // tab open/close and on orchestration:run.
  const sessionsShown = () => activeTabId === null;

  function requestSavedSessions(delay = 300) {
    if (!sessionsShown()) return;
    clearTimeout(_sessionsReqTimer);
    _sessionsReqTimer = setTimeout(() => {
      if (sessionsShown()) sendWs({ type: 'cli:getSavedSessions' });
    }, delay);
  }

  function showSessions(pinned) {
    if (pinned) _sessionsPinned = true;
    for (const tab of tabs.values()) tab.wrap.style.display = 'none';
    activeTabId = null;
    if (sessionsView) sessionsView.style.display = '';
    window.sdkPanel?.setActive(null);
    _mobileBar?.onTabChange(null);
    renderTabStrip();
    renderSessions();
    requestSavedSessions(0);
  }

  // The open tab of a session, by its sessId.
  function openTabsBySess() {
    const m = new Map();
    for (const [tabId, tab] of tabs) if (tab.sessId) m.set(tab.sessId, tabId);
    return m;
  }

  function runTabId(run, bySess) {
    for (const [tabId, tab] of tabs) {
      const st = tab.settings?.orchestration;
      if (st?.runId === run.runId && st.role === 'orchestrator') return tabId;
    }
    return run.orchestratorSessId ? bySess.get(run.orchestratorSessId) || null : null;
  }

  const btn = (label, attrs, cls = '') =>
    `<button type="button" class="vc-btn vc-btn-sm ${cls}" ${attrs}>${label}</button>`;

  // A card action: its button with a line saying what it does.
  const action = (label, attrs, cls, hint) =>
    `<div class="sc-action">${btn(label, attrs, cls)}<span class="sc-action-hint">${escHtml(hint)}</span></div>`;

  const DELETE_HINT = 'Removes the conversation history and TODO/NOTES. Your code, commits and merged work are not touched.';

  function runCardHtml(r, bySess, cardName) {
    const tabId = runTabId(r, bySess);
    const oldName = r.title || r.orchestrator || `Run ${r.runId}`;
    const name = cardName || oldName;
    const w = r.workers;
    const meta = [
      SC.timeHtml(r.lastActivityAt),
      `<span>${w.total} worker${w.total !== 1 ? 's' : ''}${w.running ? ` · <b>${w.running} running</b>` : ''}</span>`,
      r.model ? `<span class="sc-chip">${escHtml(r.model)}</span>` : '',
      r.engine === 'sdk' ? '<span class="sc-chip">SDK</span>' : '',
      r.isolation ? `<span class="sc-chip">${escHtml(r.isolation)}</span>` : '',
    ].filter(Boolean).join('');
    const prefix = r.orchestrator ? `${r.orchestrator}-` : '';
    const workers = SC.workerList(w.list.map(x => {
      const wTab = x.sessId ? bySess.get(x.sessId) : null;
      const report = x.lastReport ? `${x.lastReport.status}: ${x.lastReport.summary}` : '';
      return {
        name: x.name.startsWith(prefix) ? x.name.slice(prefix.length) : x.name,
        state: x.state,
        detail: report || (x.title || ''),
        title: [x.name, x.title, report, x.lastActivityAt ? `last activity ${new Date(x.lastActivityAt).toLocaleString()}` : ''].filter(Boolean).join('\n'),
        attrs: wTab ? `data-act="switch" data-tab="${escHtml(wTab)}"` : null,
      };
    }), 'Workers');
    const actions = [];
    if (tabId) actions.push(action('Switch to tab', `data-act="switch" data-tab="${escHtml(tabId)}"`, 'vc-btn-primary', 'The orchestrator of this run is open in a tab.'));
    else if (!r.orchestratorRunning && !r.runMissing) {
      actions.push(action('Resume', `data-act="resume-run" data-run="${escHtml(r.runId)}"`, 'vc-btn-primary', 'The orchestrator continues its conversation and wakes its paused workers.'));
      actions.push(action('Resume from notes', `data-act="resume-run" data-fresh="1" data-run="${escHtml(r.runId)}"`, '', "Start a fresh orchestrator with a clean memory from the run's TODOs, notes and reports. Use it when the old conversation got too long or confused."));
    }
    if (!r.orchestratorRunning) actions.push(action('Delete permanently', `data-act="delete-run" data-run="${escHtml(r.runId)}"`, 'vc-btn-danger', DELETE_HINT));
    return `<article class="vc-card sc-card sc-run ${SC.accentOf(r.status)}">`
      + SC.head({
        icon: '\u{1F9ED}', iconTitle: `Orchestration run ${r.runId}`, name, status: r.status,
        sub: [cardName && oldName !== cardName ? escHtml(oldName) : '', `run ${escHtml(r.runId)}`, r.cwd ? escHtml(r.cwd) : ''].filter(Boolean).join(' · '),
        subTitle: r.cwd || '',
      })
      + `<div class="sc-meta">${meta}</div>`
      + SC.todoList(r.todo)
      + workers
      + (actions.length ? `<div class="sc-actions">${actions.join('')}</div>` : '')
      + '</article>';
  }

  function plainCardHtml(s, bySess, cardName) {
    const tabId = bySess.get(s.id) || null;
    const status = tabId || s.isRunning ? 'running' : s.paused ? 'paused' : s.interrupted ? 'interrupted' : 'saved';
    const lastAt = s.lastInteractionAt || s.savedAt;
    const mappings = formatModelMap(s.settings?.modelMap);
    const meta = [
      SC.timeHtml(lastAt),
      s.startedAt ? `<span title="Started">started ${escHtml(formatDateTime(s.startedAt))}</span>` : '',
      s.settings?.model ? `<span class="sc-chip">${escHtml(s.settings.model)}</span>` : '',
      s.kind === 'sdk' ? '<span class="sc-chip">SDK</span>' : '',
      s.autoMemory === true ? '<span class="sc-chip">memory</span>' : '',
      mappings ? `<span class="sc-chip" title="${escHtml(mappings)}">${escHtml(mappings)}</span>` : '',
    ].filter(Boolean).join('');
    // TODO.md progress from the session folder: 3/5 · doing 2: <item>.
    const p = s.progress;
    let progress = '';
    if (p && (p.total || p.hasResume)) {
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      const bits = [p.doing ? `doing ${p.doing.id}: ${p.doing.description || ''}` : '', p.hasResume ? 'resume note' : ''].filter(Boolean).join(' · ');
      progress = '<div class="sc-todo"><div class="sc-todo-head"><span>TODO</span>'
        + (p.total ? `<span class="sc-progress"><span style="width:${pct}%"></span></span><span>${p.done}/${p.total}</span>` : '')
        + `</div>${bits ? `<div class="sc-line" title="${escHtml(bits)}">${escHtml(bits)}</div>` : ''}</div>`;
    }
    const actions = [];
    if (tabId) actions.push(action('Switch to tab', `data-act="switch" data-tab="${escHtml(tabId)}"`, 'vc-btn-primary', 'This session is open in a tab.'));
    else if (!s.isRunning) actions.push(action('Resume', `data-act="resume-saved" data-sess="${escHtml(s.id)}"`, 'vc-btn-primary', 'Continue where it left off.'));
    if (!s.isRunning) actions.push(action('Delete permanently', `data-act="delete-saved" data-sess="${escHtml(s.id)}"`, 'vc-btn-danger', DELETE_HINT));
    return `<article class="vc-card sc-card ${SC.accentOf(status)}">`
      + SC.head({
        icon: s.kind === 'sdk' ? '✨' : '⌨️', name: cardName || savedTitle(s),
        sub: [cardName && savedTitle(s) !== SC.dirName(s.cwd) ? escHtml(savedTitle(s)) : '', escHtml(s.cwd || '')].filter(Boolean).join(' · '), subTitle: s.cwd || '',
        status, label: status === 'running' && !tabId ? 'running' : status === 'running' ? 'open' : status,
      })
      + `<div class="sc-meta">${meta}</div>`
      + progress
      + (s.jsonlSize ? `<div class="sc-line">${contextGauge(s.jsonlSize)}</div>` : '')
      + (actions.length ? `<div class="sc-actions">${actions.join('')}</div>` : '')
      + '</article>';
  }

  // Redrawn only when something visible changed, so a click is not lost to
  // a rebuild under the pointer.
  function renderSessions() {
    if (!sessionsView || !sessionsShown()) return;
    let html;
    if (!_savedData) {
      html = '<p class="sc-empty">Loading sessions…</p>';
    } else {
      const bySess = openTabsBySess();
      const { sessions, runs } = _savedData;
      const plain = sessions.filter(s => !s.group?.runId);
      // Named by project, numbered by start time across runs and sessions.
      const names = SC.projectNames([
        ...runs.map(r => ({ key: `run:${r.runId}`, cwd: r.cwd, startedAt: r.startedAt })),
        ...plain.map(s => ({ key: `sess:${s.id}`, cwd: s.cwd, startedAt: s.startedAt || s.savedAt })),
      ]);
      const cards = [
        ...runs.map(r => ({ at: r.lastActivityAt || 0, html: runCardHtml(r, bySess, names.get(`run:${r.runId}`)) })),
        ...plain.map(s => ({ at: s.lastInteractionAt || s.savedAt || 0, html: plainCardHtml(s, bySess, names.get(`sess:${s.id}`)) })),
      ].sort((a, b) => b.at - a.at);
      const count = [
        runs.length ? `${runs.length} run${runs.length !== 1 ? 's' : ''}` : '',
        `${plain.length} session${plain.length !== 1 ? 's' : ''}`,
        tabs.size ? `${tabs.size} open` : '',
      ].filter(Boolean).join(' · ');
      html = `<div class="sc-toolbar"><h3>Sessions</h3><span class="sc-count">${count}</span>`
        + btn('+ New CLI in directory…', 'data-act="new"', 'vc-btn-primary sc-push') + '</div>'
        + (cards.length
          ? `<div class="sc-grid">${cards.map(c => c.html).join('')}</div>`
          : '<p class="sc-empty">No saved sessions yet. Click <strong>+</strong> to start a Claude Code CLI in a directory.</p>');
    }
    if (html === _sessionsHtml) return;
    _sessionsHtml = html;
    sessionsView.innerHTML = html;
  }

  sessionsView?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const { act, run, sess, tab, fresh } = b.dataset;
    const saved = () => _savedData?.sessions.find(s => s.id === sess);
    if (act === 'new') openNewCli();
    else if (act === 'switch' && tabs.has(tab)) switchTab(tab);
    else if (act === 'resume-run') { b.disabled = true; resumeRun(run, fresh === '1'); }
    else if (act === 'delete-run') deleteRun(run);
    else if (act === 'resume-saved') { b.disabled = true; resumeSaved(sess); }
    else if (act === 'delete-saved') deleteSaved(saved());
  });

  // Relative times age while the tab is open.
  setInterval(() => { if (sessionsShown()) renderSessions(); }, 60000);

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
    const engine = state.cliFallbackEngine === 'terminal' ? ', terminal engine' : '';
    modelCog.title = `New CLI tabs use: ${current}${engine} — click to change`;
  }

  modelCog?.addEventListener('click', (e) => {
    e.stopPropagation();
    showModelMenu();
  });

  function showModelMenu() {
    closeModelMenu();
    const menu = document.createElement('div');
    menu.className = 'cli-new-menu';
    menu.id = 'cliModelMenu';

    // New sessions open in the Agent SDK panel; the terminal engine is a
    // fallback preference, not a per-launch question.
    const engineHeader = document.createElement('div');
    engineHeader.className = 'cli-new-menu-header';
    engineHeader.textContent = 'Engine for new CLI tabs';
    menu.appendChild(engineHeader);
    const terminal = state.cliFallbackEngine === 'terminal';
    const engineItem = document.createElement('div');
    engineItem.className = 'cli-new-menu-item' + (terminal ? ' is-selected' : '');
    engineItem.textContent = (terminal ? '✓ ' : '') + 'Use the terminal engine for new sessions';
    const engineNote = document.createElement('div');
    engineNote.className = 'cli-model-menu-note';
    engineNote.textContent = 'Fallback if Agent SDK use on subscriptions becomes restricted';
    engineItem.appendChild(engineNote);
    engineItem.addEventListener('click', () => {
      closeModelMenu();
      sendWs({ type: 'prefs:fallbackEngine:set', value: terminal ? 'sdk' : 'terminal' });
    });
    menu.appendChild(engineItem);
    const engineDivider = document.createElement('div');
    engineDivider.className = 'cli-new-menu-divider';
    menu.appendChild(engineDivider);

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
    return `<span class="sc-gauge" title="Transcript size"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="2" fill="var(--bg, #111)" stroke="var(--border, #333)" stroke-width="0.5"/><rect width="${fill}" height="${h}" rx="2" fill="${color}"/></svg><span class="sc-gauge-label">${label}</span></span>`;
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
          resolve({ dir: d.path, ...pickedOptions() });
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
    const worktreeCheckbox = document.getElementById('dirPickerWorktree');
    const landOnCloseCheckbox = document.getElementById('dirPickerLandOnClose');
    function pickedOptions() {
      return {
        autoMemory: autoMemoryCheckbox.checked,
        worktree: !!worktreeCheckbox?.checked,
        landOnClose: !!worktreeCheckbox?.checked && !!landOnCloseCheckbox?.checked,
      };
    }
    function onClose() { cleanup(); resolve(null); }
    function onSelect() { cleanup(); resolve({ dir: currentDir, ...pickedOptions() }); }

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
  // On a newly spawned CLI tab with no active Claude subscription, point at the
  // header pill's sign-in and remind the user that it takes effect only in a NEW
  // tab (this tab snapshotted creds at spawn time). Shown at most once per page load.
  let _noSubToastShown = false;
  function maybeNotifyNoSubscription() {
    if (_noSubToastShown) return;
    const ca = state.claudeAuth || {};
    if (ca.hasSubscription) return;
    _noSubToastShown = true;
    window.dashboard.showToast?.({
      sender: 'CLI',
      title: 'No Claude subscription detected',
      message: 'Sign in to Claude from the header pill, then open a NEW CLI tab for it to take effect (this session already started without it).',
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
        hint.innerHTML = 'No Claude subscription detected. <button type="button" class="claude-signin-btn" data-claude-signin>Sign in to Claude</button> to use your Max/Pro plan; until then sessions fall back to the Anthropic API key.';
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
        if (tab?.terminal) {
          tab.terminal.write(msg.data);
          if (tab === tabs.get(activeTabId)) _mobileBar?.onOutput(tab);
        }
        break;
      }
      case 'cli:exit': {
        const tab = tabs.get(msg.tabId);
        if (tab) {
          tab.status = 'exited';
          if (tab.terminal) tab.terminal.write('\r\n\x1b[90m[Process exited' + (msg.exitCode != null ? ' with code ' + msg.exitCode : '') + ']\x1b[0m\r\n');
          else if (isSdk(tab)) window.sdkPanel?.update(msg.tabId, sdkInfo(tab));
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
        // The spawn says what the tab is only when it carries kind/engine;
        // otherwise keep what we have (cli:tabs is authoritative).
        const spawnedKind = (msg.kind || msg.settings?.engine) ? kindOf(msg) : null;
        if (tab && spawnedKind && tab.kind !== spawnedKind) tab = ensureTab(msg.tabId, spawnedKind);
        if (!tab && !msg.hidden) {
          // A tab we have not seen yet: either an app action tab, or one the
          // server restored at boot (its cli:spawned lands before the cli:tabs
          // that would otherwise introduce it). Adopt it either way.
          const isAppCli = msg.tabId.startsWith('app-');
          tab = createTab(msg.tabId, spawnedKind || 'cli');
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
          if (isSdk(tab)) window.sdkPanel?.update(msg.tabId, sdkInfo(tab));
          renderTabStrip();
        }
        break;
      }
      case 'cli:tabs': {
        window.sdkPanel?.onTabs();
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
        const { cols, rows } = tab?.terminal ? { cols: tab.terminal.cols, rows: tab.terminal.rows } : { cols: 80, rows: 24 };
        const spawnMsg = {
          type: 'cli:spawn', tabId, cwd: intent.cwd, cols, rows,
          autoMemory: intent.autoMemory === true,
        };
        if (intent.resumeSessionId) spawnMsg.resumeSessionId = intent.resumeSessionId;
        sendWs(spawnMsg);
        maybeNotifyNoSubscription();
        break;
      }
      case 'cli:opened': {
        if (msg.error) { window.dashboard.showAlert?.(`Could not open the CLI: ${msg.error}`); break; }
        if (msg.cancelled || !msg.tabId) break;
        // The engine picked in the form decides the view before the server's
        // tab list confirms it.
        if (!tabs.has(msg.tabId)) createTab(msg.tabId, msg.engine === 'sdk' ? 'sdk' : 'cli');
        switchTab(msg.tabId);
        maybeNotifyNoSubscription();
        break;
      }
      case 'cli:settingsData': {
        populateSettings(msg.tabId, msg.settings || {}, msg.models || [], msg.hasSubscription, msg.interactionsDir);
        break;
      }
      case 'cli:savedSessions': {
        _savedData = { sessions: msg.sessions || [], runs: msg.runs || [] };
        renderSessions();
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
      // --- Pause / resume ---
      case 'cli:actionResult': {
        if (msg.action === 'deleteRun' && msg.refused) {
          const dirty = (msg.dirty || []).map(d => `- ${d.worker}: ${d.path}`).join('\n');
          if (confirm(`These worktrees have uncommitted changes:\n${dirty}\n\nDelete the run anyway? The changes are lost.`)) {
            sendWs({ type: 'cli:deleteRun', runId: msg.runId, force: true });
          }
          break;
        }
        if (msg.error) { window.dashboard.showAlert?.(msg.error); break; }
        if (msg.action === 'deleteRun' && msg.keptBranches?.length) {
          window.dashboard.showToast?.({ sender: 'CLI', title: 'Run deleted', message: `Unmerged branches kept: ${msg.keptBranches.join(', ')}`, level: 'info' });
        }
        if (msg.tabId && (msg.action === 'resume' || msg.action === 'resumeRun')) {
          if (!tabs.has(msg.tabId)) createTab(msg.tabId);
          switchTab(msg.tabId);
          if (msg.fellBack || (msg.action === 'resume' && msg.fresh)) {
            window.dashboard.showToast?.({ sender: 'CLI', title: 'Started fresh', message: 'Its earlier conversation could not be restored, so a fresh session continues from its TODO.md and NOTES.md.', level: 'info' });
          }
        }
        break;
      }
      case 'cli:closeRefused': {
        if (msg.canForce) {
          if (confirm(`${msg.reason}\n\nForce-close it anyway?`)) sendWs({ type: 'cli:closeTab', tabId: msg.tabId, forget: msg.forget, force: true });
        } else {
          window.dashboard.showAlert?.(msg.reason);
        }
        break;
      }
      case 'cli:deleteRefused': {
        if (confirm(`${msg.reason}\n\nDelete it anyway?`)) sendWs({ type: 'cli:deleteSavedSession', sessionId: msg.sessionId, force: true });
        break;
      }
      case 'cli:landing': {
        const where = msg.title ? `${msg.title}: ` : '';
        const files = msg.files?.length ? `\n${msg.files.slice(0, 8).join('\n')}` : '';
        const output = msg.outcome === 'check-failed' && msg.output ? `\n${String(msg.output).slice(-600)}` : '';
        window.dashboard.showToast?.({
          sender: 'CLI',
          title: msg.outcome === 'landed' ? 'Landed' : msg.outcome === 'nothing' ? 'Nothing to land' : 'Not landed',
          message: where + (msg.text || msg.outcome) + files + output,
          level: msg.outcome === 'landed' ? 'success' : msg.outcome === 'nothing' ? 'info' : 'warning',
        });
        break;
      }
      case 'cli:worktree': {
        if (!msg.removed) {
          window.dashboard.showToast?.({
            sender: 'CLI',
            title: 'Worktree kept',
            message: `${msg.title || msg.branch}: ${msg.path} kept — ${msg.kept}${msg.files?.length ? `\n${msg.files.slice(0, 8).join('\n')}` : ''}`,
            level: 'info',
          });
        }
        break;
      }
      case 'cli:paused': {
        requestSavedSessions();
        window.dashboard.showToast?.({
          sender: 'CLI',
          title: msg.interrupted ? 'Session interrupted' : 'Session paused',
          message: `${msg.title || 'A session'} is saved${msg.interrupted ? ' as interrupted' : ' with its resume note'}. Resume it from the Sessions tab.`,
          level: msg.interrupted ? 'warning' : 'success',
        });
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
      _disposeTabView(tabId, tab);
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
      const tab = ensureTab(st.tabId, kindOf(st));
      tab.status = st.status;
      tab.cwd = st.cwd;
      tab.title = st.title || null;
      tab.settings = st.settings || {};
      tab.pausing = st.pausing === true;
      if (st.instanceId) tab.instanceId = st.instanceId;
      if (st.sessId) tab.sessId = st.sessId;
      if (st.autoMemory != null) tab.autoMemory = st.autoMemory;
      if (st.state) tab.sdkState = st.state;
      if (typeof st.costUsd === 'number') tab.costUsd = st.costUsd;
      if (isSdk(tab)) window.sdkPanel?.update(st.tabId, sdkInfo(tab));
    }
    if (!activeTabId && !_sessionsPinned && tabs.size > 0) {
      const first = Array.from(tabs.keys())[0];
      switchTab(first);
    }
    renderTabStrip();
    if (sessionsShown()) {
      if (sessionsView) sessionsView.style.display = '';
      requestSavedSessions();
    }
    window.inspectorModule?.renderInspectorTabStrip?.();
  }

  // Called with the Inspector's streaming instances; with none (an SDK state
  // change, a tab strip render) it re-applies the last set.
  let _streamingInstances = new Set();
  function updateStreamingState(streamingInstances) {
    if (streamingInstances) _streamingInstances = streamingInstances;
    if (!tabStrip) return;
    let anyStreaming = false;
    for (const [tabId, tab] of tabs) {
      const instanceId = tab.instanceId;
      const streaming = (instanceId ? _streamingInstances.has(instanceId) : false)
        || (isSdk(tab) && !!window.sdkPanel?.isBusy(tabId));
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

    // The New CLI ask (orchestration.askMode) draws its own dialog (new-cli.js).
    const nc = forms.length === 1 && forms[0].formData?.kind === 'new-cli' && window.newCliDialog;
    if (nc) {
      const f = forms[0];
      if (!meta.title || meta.title === 'New CLI') titleEl.textContent = 'New session';
      modal.classList.add('ncd-modal');
      const dlg = window.newCliDialog.render(f.formData.newCli, {
        uid: askId,
        onSubmit: (answer) => {
          sendWs({ type: 'ask:answer', toolUseId: f.toolUseId, answer });
          dismissAskModal(askId);
        },
        onCancel: () => {
          sendWs({ type: 'ask:answer', toolUseId: f.toolUseId, answer: [{ id: '_cancelled', question: '', answer: 'cancelled' }] });
          dismissAskModal(askId);
        },
      });
      modal.appendChild(dlg.el);
      makeAskDraggable(modal, header);
      layer.appendChild(modal);
      pendingAskOverlays.set(askId, { overlayEl: modal, tabId: meta.tabId || null });
      renderTabStrip();
      dlg.focus();
      return;
    }

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
      panel.innerHTML = askFormBuildHTML(f.formData, { cwd: meta.cwd });

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
      }, { cwd: meta.cwd });
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


  window.dashboard.registerModule?.('orchestration:', (msg) => {
    if (msg.type === 'orchestration:run') window.sdkPanel?.onRunUpdate(msg);
    if (msg.type === 'orchestration:run') requestSavedSessions(1000);
  });

  // The Sessions tab is there before the first tab list arrives.
  renderTabStrip();
  renderSessions();
  _mobileBar?.onTabChange(null);

  // Expose module
  window.cliModule = { handleMessage, handleAskMessage, tabs, updateStreamingState, switchTab, computeTabLabel, modelPickerOptions };
})();
