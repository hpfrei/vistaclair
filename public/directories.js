(function directoriesModule() {
  'use strict';
  const { escHtml, sendWs } = window.dashboard;

  const tabStrip = document.getElementById('dirTabStrip');
  const tabNewBtn = document.getElementById('dirTabNew');
  const container = document.getElementById('dirContainer');
  const placeholder = document.getElementById('dirPlaceholder');

  const tabs = new Map();
  let activeTabId = null;
  let tabCounter = 0;
  let _pendingTerminalRestores = [];

  // At the filesystem root `cwd` is '/', so plain concatenation yields '//name'.
  // Both the builders and the comparers below must agree, or a rebuilt key stops
  // matching the stored one.
  function joinPath(cwd, name) {
    return cwd === '/' ? '/' + name : cwd + '/' + name;
  }

  // Selection is keyed by absolute path; `tab.entries` is the source of truth for
  // what each one actually is. Shared by both right-panel modes so neither has to
  // re-derive it from the DOM.
  function getSelectedEntries(tab) {
    const files = [], dirs = [];
    for (const entry of tab.entries) {
      const path = joinPath(tab.cwd, entry.name);
      if (!tab.selectedPaths.has(path)) continue;
      (entry.isDirectory ? dirs : files).push({ entry, path });
    }
    return { files, dirs, paths: [...dirs, ...files].map(x => x.path) };
  }

  function describeSelection(sel) {
    const f = sel.files.length, d = sel.dirs.length;
    if (f && d) return (f + d) + ' items';
    if (d) return d + ' folder' + (d > 1 ? 's' : '');
    return f + ' file' + (f > 1 ? 's' : '');
  }

  function _saveDirTabs() {
    const entries = [];
    let activeIndex = -1, i = 0;
    for (const [, tab] of tabs) {
      if (tab.id === activeTabId) activeIndex = i;
      entries.push({ cwd: tab.cwd, shellOpen: !!tab._shellOpen, shellTabId: tab._shellTabId || null });
      i++;
    }
    try { sessionStorage.setItem('dir-open-tabs', JSON.stringify({ tabs: entries, activeIndex })); } catch {}
  }

  function _loadDirTabs() {
    try { return JSON.parse(sessionStorage.getItem('dir-open-tabs') || 'null'); } catch { return null; }
  }

  // ── Monaco lazy loader (shared pattern with rules.js) ──────────────

  let monacoReady = false;
  let monacoReadyPromise = null;

  function ensureMonaco() {
    if (monacoReady) return Promise.resolve();
    if (monacoReadyPromise) return monacoReadyPromise;
    monacoReadyPromise = new Promise(resolve => {
      if (typeof window.require === 'undefined' || !window.require.config) {
        resolve();
        return;
      }
      window.require.config({
        paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' }
      });
      window.require(['vs/editor/editor.main'], function () {
        monacoReady = true;
        resolve();
      });
    });
    return monacoReadyPromise;
  }

  function getMonacoTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'vs' : 'vs-dark';
  }

  // ── Tab management ─────────────────────────────────────────────────

  function createTab(startPath) {
    const tabId = 'dir-' + (++tabCounter);
    const wrap = document.createElement('div');
    wrap.className = 'dir-browser-wrap';
    wrap.style.display = 'none';

    const leftPanel = buildLeftPanel(tabId);
    const resizer = buildResizer(leftPanel);
    const rightPanel = buildRightPanel();

    wrap.appendChild(leftPanel);
    wrap.appendChild(resizer);
    wrap.appendChild(rightPanel);
    container.appendChild(wrap);

    const tab = {
      id: tabId,
      cwd: startPath || null,
      sortBy: 'name',
      sortDir: 'asc',
      selectedFile: null,
      selectedPaths: new Set(),
      _lastSelectedIndex: -1,
      entries: [],
      wrap,
      leftPanel,
      rightPanel,
      editor: null,
      loadSeq: 0,
      searchMode: false,
      showPreviews: false,
    };
    tabs.set(tabId, tab);
    _saveDirTabs();
    return tab;
  }

  function buildLeftPanel(tabId) {
    const panel = document.createElement('div');
    panel.className = 'dir-file-panel';

    const header = document.createElement('div');
    header.className = 'dir-file-header';

    const crumbs = document.createElement('div');
    crumbs.className = 'dir-breadcrumbs';

    const sortBar = document.createElement('div');
    sortBar.className = 'dir-sort-bar';

    for (const s of ['name', 'date', 'size']) {
      const btn = document.createElement('button');
      btn.className = 'dir-sort-btn' + (s === 'name' ? ' active' : '');
      btn.textContent = s.charAt(0).toUpperCase() + s.slice(1);
      btn.dataset.sort = s;
      btn.addEventListener('click', () => {
        const tab = tabs.get(tabId);
        if (!tab) return;
        if (tab.sortBy === s) {
          tab.sortDir = tab.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          tab.sortBy = s;
          tab.sortDir = 'asc';
        }
        sortBar.querySelectorAll('.dir-sort-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        btn.textContent = (s.charAt(0).toUpperCase() + s.slice(1)) + (tab.sortDir === 'desc' ? ' ↓' : ' ↑');
        loadDir(tabId, tab.cwd);
      });
      sortBar.appendChild(btn);
    }

    const previewToggle = document.createElement('label');
    previewToggle.className = 'dir-preview-toggle';
    previewToggle.innerHTML = '<input type="checkbox" class="dir-preview-checkbox"> Previews';
    previewToggle.querySelector('input').addEventListener('change', (e) => {
      const tab = tabs.get(tabId);
      if (!tab) return;
      tab.showPreviews = e.target.checked;
      // Clear unconditionally: the two modes sort differently, so a selection
      // (and its shift-range anchor) carried across a mode flip refers to rows
      // that no longer line up.
      tab.selectedPaths.clear();
      tab._lastSelectedIndex = -1;
      if (!tab.selectedFile) {
        if (tab.showPreviews) renderPreviews(tab);
        else renderDirListing(tab);
      }
    });
    sortBar.appendChild(previewToggle);

    const searchBtn = document.createElement('button');
    searchBtn.className = 'dir-sort-btn dir-search-btn';
    searchBtn.textContent = '🔍';
    searchBtn.title = 'Search files';
    searchBtn.addEventListener('click', () => {
      const tab = tabs.get(tabId);
      if (tab) openSearchModal(tab);
    });
    sortBar.appendChild(searchBtn);

    const cmdBtn = document.createElement('button');
    cmdBtn.className = 'dir-sort-btn dir-cmd-btn';
    cmdBtn.textContent = '>_';
    cmdBtn.title = 'Toggle terminal';
    cmdBtn.addEventListener('click', () => {
      const tab = tabs.get(tabId);
      if (tab) openTerminal(tab);
    });
    sortBar.appendChild(cmdBtn);

    header.appendChild(crumbs);
    header.appendChild(sortBar);

    const list = document.createElement('div');
    list.className = 'dir-file-list';

    list.addEventListener('click', (e) => {
      if (e.target !== list) return;
      const tab = tabs.get(tabId);
      if (!tab) return;
      if (tab.selectedFile) {
        tab.selectedFile = null;
        list.querySelectorAll('.dir-entry.selected').forEach(el => el.classList.remove('selected'));
        resetPreviewPanel(tab);
      }
    });

    panel.appendChild(header);
    panel.appendChild(list);
    return panel;
  }

  function buildRightPanel() {
    const panel = document.createElement('div');
    panel.className = 'dir-viewer-panel';

    const hdr = document.createElement('div');
    hdr.className = 'dir-viewer-header';
    hdr.style.display = 'none';

    const content = document.createElement('div');
    content.className = 'dir-viewer-content';
    content.style.display = 'none';

    const empty = document.createElement('div');
    empty.className = 'dir-viewer-empty';
    empty.textContent = 'Select a file to preview';

    panel.appendChild(hdr);
    panel.appendChild(content);
    panel.appendChild(empty);
    return panel;
  }

  function buildResizer(leftPanel) {
    const resizer = document.createElement('div');
    resizer.className = 'dir-resizer';

    let startX, startW;
    function onMove(e) {
      const dx = e.clientX - startX;
      const newW = Math.max(180, Math.min(startW + dx, window.innerWidth * 0.6));
      leftPanel.style.width = newW + 'px';
    }
    function onUp() {
      resizer.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    resizer.addEventListener('mousedown', e => {
      e.preventDefault();
      startX = e.clientX;
      startW = leftPanel.offsetWidth;
      resizer.classList.add('dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    return resizer;
  }

  function switchTab(tabId) {
    for (const [id, tab] of tabs) {
      tab.wrap.style.display = id === tabId ? '' : 'none';
    }
    activeTabId = tabId;
    placeholder.style.display = tabs.size > 0 ? 'none' : '';
    renderTabStrip();
    _saveDirTabs();
  }

  function renderTabStrip() {
    tabStrip.querySelectorAll('.view-tab').forEach(el => el.remove());
    for (const [tabId, tab] of tabs) {
      const btn = document.createElement('button');
      btn.className = 'view-tab' + (tabId === activeTabId ? ' active' : '');
      btn.dataset.tabId = tabId;

      const label = document.createElement('span');
      label.textContent = computeTabLabel(tab);
      btn.appendChild(label);

      const close = document.createElement('span');
      close.className = 'view-tab-close';
      close.textContent = '×';
      close.addEventListener('click', e => {
        e.stopPropagation();
        removeTab(tabId);
      });
      btn.appendChild(close);

      btn.addEventListener('click', () => switchTab(tabId));
      tabStrip.insertBefore(btn, tabNewBtn);
    }
  }

  function computeTabLabel(tab) {
    if (!tab.cwd) return 'Browser';
    const parts = tab.cwd.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || '/';
  }

  function removeTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    closeTerminal(tab);
    if (tab.editor) { tab.editor.dispose(); tab.editor = null; }
    tab.wrap.remove();
    tabs.delete(tabId);
    if (activeTabId === tabId) {
      const remaining = Array.from(tabs.keys());
      if (remaining.length > 0) {
        switchTab(remaining[remaining.length - 1]);
      } else {
        activeTabId = null;
        placeholder.style.display = '';
        renderTabStrip();
      }
    } else {
      renderTabStrip();
    }
    _saveDirTabs();
  }

  // ── Directory loading ──────────────────────────────────────────────

  async function loadDir(tabId, dirPath) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    tab.searchMode = false;

    const seq = ++tab.loadSeq;
    const listEl = tab.leftPanel.querySelector('.dir-file-list');
    listEl.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:12px">Loading…</div>';

    try {
      const params = new URLSearchParams({ path: dirPath || '', sort: tab.sortBy, order: tab.sortDir });
      const resp = await fetch('/api/browse-files?' + params);
      const data = await resp.json();
      if (seq !== tab.loadSeq) return;

      if (data.error) {
        listEl.innerHTML = `<div style="padding:12px;color:#e55;font-size:12px">${escHtml(data.error)}</div>`;
        return;
      }

      tab.cwd = data.current;
      tab.entries = data.entries;
      renderBreadcrumbs(tab, data.current, data.parent);
      renderFileList(tab);
      renderTabStrip();
      resetPreviewPanel(tab);
      _saveDirTabs();
    } catch {
      if (seq !== tab.loadSeq) return;
      listEl.innerHTML = '<div style="padding:12px;color:#e55;font-size:12px">Failed to load directory</div>';
    }
  }

  function renderBreadcrumbs(tab, absPath, parent) {
    const crumbsEl = tab.leftPanel.querySelector('.dir-breadcrumbs');
    crumbsEl.innerHTML = '';

    if (parent && parent !== absPath) {
      const upBtn = document.createElement('span');
      upBtn.className = 'dir-breadcrumb';
      upBtn.textContent = '↑ up';
      upBtn.title = parent;
      upBtn.addEventListener('click', () => loadDir(tab.id, parent));
      crumbsEl.appendChild(upBtn);

      const sep = document.createElement('span');
      sep.className = 'dir-breadcrumb-sep';
      sep.textContent = '|';
      crumbsEl.appendChild(sep);
    }

    crumbsEl._absPath = absPath;
    if (!crumbsEl._copyHandler) {
      crumbsEl._copyHandler = e => {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && crumbsEl.contains(sel.anchorNode)) {
          e.preventDefault();
          e.clipboardData.setData('text/plain', crumbsEl._absPath);
        }
      };
      crumbsEl.addEventListener('copy', crumbsEl._copyHandler);
    }

    const parts = absPath.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'dir-breadcrumb-sep';
        sep.textContent = '/';
        crumbsEl.appendChild(sep);
      }
      const crumb = document.createElement('span');
      const isLast = i === parts.length - 1;
      crumb.className = 'dir-breadcrumb' + (isLast ? ' current' : '');
      crumb.textContent = parts[i];
      if (!isLast) {
        const target = '/' + parts.slice(0, i + 1).join('/');
        crumb.title = target;
        crumb.addEventListener('click', () => loadDir(tab.id, target));
      }
      crumbsEl.appendChild(crumb);
    }
  }

  function renderFileList(tab) {
    const listEl = tab.leftPanel.querySelector('.dir-file-list');
    listEl.innerHTML = '';

    if (tab.entries.length === 0) {
      listEl.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:12px">Empty directory</div>';
      return;
    }

    for (const entry of tab.entries) {
      const fullPath = joinPath(tab.cwd, entry.name);
      const row = document.createElement('div');
      row.className = 'dir-entry' + (entry.isDirectory ? ' dir-folder' : '');
      if (!entry.isDirectory && tab.selectedFile === fullPath) row.classList.add('selected');
      row.dataset.path = fullPath;
      row.dataset.isDir = entry.isDirectory ? '1' : '';

      const icon = document.createElement('span');
      icon.className = 'dir-entry-icon';
      icon.textContent = entry.isDirectory ? '📁' : getFileIcon(entry.name);

      const name = document.createElement('span');
      name.className = 'dir-entry-name';
      name.textContent = entry.name;

      const size = document.createElement('span');
      size.className = 'dir-entry-size';
      size.textContent = entry.isDirectory ? '' : formatSize(entry.size);

      const date = document.createElement('span');
      date.className = 'dir-entry-date';
      date.textContent = formatDate(entry.mtime);

      row.appendChild(icon);
      row.appendChild(name);
      row.appendChild(size);
      row.appendChild(date);

      if (entry.isDirectory) {
        row.addEventListener('click', () => loadDir(tab.id, fullPath));
      } else {
        row.addEventListener('click', () => {
          tab.leftPanel.querySelectorAll('.dir-entry.selected').forEach(el => el.classList.remove('selected'));
          row.classList.add('selected');
          openFile(tab, fullPath, entry);
        });
      }

      listEl.appendChild(row);
    }
  }

  // ── File preview overlay ────────────────────────────────────────────

  const ARROW_LEFT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
  const ARROW_RIGHT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>';

  let activeOverlay = null;

  function getFileList(tab) {
    return tab.entries.filter(e => !e.isDirectory);
  }

  function getFileIndex(tab, filePath) {
    const files = getFileList(tab);
    return files.findIndex(e => joinPath(tab.cwd, e.name) === filePath);
  }

  function openFile(tab, filePath, entry) {
    tab.selectedFile = filePath;
    showOverlay(tab, filePath, entry);
  }

  function closeOverlay() {
    if (!activeOverlay) return;
    if (activeOverlay.editor) { activeOverlay.editor.dispose(); activeOverlay.editor = null; }
    const tab = activeOverlay.tab;
    activeOverlay.el.remove();
    document.removeEventListener('keydown', activeOverlay.keyHandler);
    activeOverlay = null;
    if (tab) tab.selectedFile = null;
  }

  function showOverlay(tab, filePath, entry) {
    closeOverlay();

    const files = getFileList(tab);
    const currentIdx = files.findIndex(e => joinPath(tab.cwd, e.name) === filePath);
    const hasPrev = currentIdx > 0;
    const hasNext = currentIdx < files.length - 1;

    const overlay = document.createElement('div');
    overlay.className = 'dir-overlay';

    const downloadUrl = '/api/raw-file?path=' + encodeURIComponent(filePath);

    overlay.innerHTML = `
      <div class="dir-overlay-backdrop"></div>
      <button class="dir-overlay-nav prev${hasPrev ? '' : ' disabled'}" title="Previous file">${ARROW_LEFT_SVG}</button>
      <button class="dir-overlay-nav next${hasNext ? '' : ' disabled'}" title="Next file">${ARROW_RIGHT_SVG}</button>
      <div class="dir-overlay-panel">
        <div class="dir-overlay-header">
          <span class="dir-filename">${escHtml(entry.name)}</span>
          <span class="dir-viewer-size">${formatSize(entry.size)}</span>
          <a class="dir-download-btn" href="${downloadUrl}" download="${escHtml(entry.name)}" title="Download">⬇</a>
          <button class="dir-overlay-close" title="Close">✕</button>
        </div>
        <div class="dir-overlay-content"></div>
      </div>`;

    document.body.appendChild(overlay);

    const content = overlay.querySelector('.dir-overlay-content');

    overlay.querySelector('.dir-overlay-backdrop').addEventListener('click', closeOverlay);
    overlay.querySelector('.dir-overlay-close').addEventListener('click', closeOverlay);

    function navigate(dir) {
      const newIdx = currentIdx + dir;
      if (newIdx < 0 || newIdx >= files.length) return;
      const e = files[newIdx];
      const p = joinPath(tab.cwd, e.name);
      tab.selectedFile = p;
      showOverlay(tab, p, e);
    }

    if (hasPrev) overlay.querySelector('.dir-overlay-nav.prev').addEventListener('click', () => navigate(-1));
    if (hasNext) overlay.querySelector('.dir-overlay-nav.next').addEventListener('click', () => navigate(1));

    function keyHandler(e) {
      if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); navigate(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); navigate(1); }
    }
    document.addEventListener('keydown', keyHandler);

    activeOverlay = { el: overlay, editor: null, keyHandler, tab };

    renderOverlayContent(tab, filePath, entry, content);
  }

  async function renderOverlayContent(tab, filePath, entry, content) {
    const ext = (filePath.match(/\.([^./]+)$/) || [])[1]?.toLowerCase() || '';
    const category = getFileCategory(ext);
    const url = '/api/raw-file?path=' + encodeURIComponent(filePath);

    switch (category) {
      case 'text': {
        content.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:12px">Loading…</div>';
        try {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error();
          const text = await resp.text();
          if (!activeOverlay || tab.selectedFile !== filePath) return;
          content.innerHTML = '';
          const editorDiv = document.createElement('div');
          editorDiv.style.cssText = 'width:100%;height:100%;position:absolute;top:0;left:0;right:0;bottom:0;';
          content.appendChild(editorDiv);

          await ensureMonaco();
          if (!activeOverlay || tab.selectedFile !== filePath) return;
          activeOverlay.editor = monaco.editor.create(editorDiv, {
            value: text,
            language: getMonacoLanguage(ext),
            theme: getMonacoTheme(),
            readOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            fontSize: 12,
            fontFamily: '"Cascadia Code", Menlo, Monaco, "Courier New", monospace',
            wordWrap: 'on',
            renderLineHighlight: 'none',
            overviewRulerLanes: 0,
            scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
          });
        } catch {
          if (!activeOverlay || tab.selectedFile !== filePath) return;
          content.innerHTML = '<div style="padding:12px;color:#e55;font-size:12px">Failed to load file</div>';
        }
        break;
      }
      case 'image': {
        const img = document.createElement('img');
        img.src = url;
        img.alt = entry.name;
        content.appendChild(img);
        break;
      }
      case 'audio': {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.src = url;
        content.appendChild(audio);
        break;
      }
      case 'video': {
        const video = document.createElement('video');
        video.controls = true;
        video.preload = 'metadata';
        video.src = '/api/video-stream?path=' + encodeURIComponent(filePath);
        content.appendChild(video);
        break;
      }
      case 'pdf': {
        const iframe = document.createElement('iframe');
        iframe.src = url;
        content.appendChild(iframe);
        break;
      }
      default: {
        content.innerHTML = `<div class="dir-viewer-empty" style="height:100%">Cannot preview .${escHtml(ext)} files</div>`;
      }
    }
  }

  // ── Preview grid ───────────────────────────────────────────────────

  const BINARY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="4" width="32" height="40" rx="3"/><text x="24" y="28" text-anchor="middle" font-size="8" stroke="none" fill="currentColor" font-family="monospace">01 10</text><text x="24" y="36" text-anchor="middle" font-size="8" stroke="none" fill="currentColor" font-family="monospace">11 00</text></svg>`;
  const FOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12a2 2 0 0 1 2-2h11l4 5h19a2 2 0 0 1 2 2v20a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z"/></svg>`;

  function resetPreviewPanel(tab) {
    closeOverlay();

    const hdr = tab.rightPanel.querySelector('.dir-viewer-header');
    const content = tab.rightPanel.querySelector('.dir-viewer-content');
    const empty = tab.rightPanel.querySelector('.dir-viewer-empty');

    hdr.style.display = 'none';
    content.style.display = 'none';
    content.innerHTML = '';
    empty.style.display = 'none';
    tab.selectedFile = null;
    tab.selectedPaths.clear();
    tab._lastSelectedIndex = -1;

    tab.leftPanel.querySelectorAll('.dir-entry.selected').forEach(el => el.classList.remove('selected'));

    const checkbox = tab.leftPanel.querySelector('.dir-preview-checkbox');
    if (checkbox) checkbox.checked = tab.showPreviews;

    if (tab.showPreviews) renderPreviews(tab);
    else renderDirListing(tab);
  }

  function renderPreviews(tab) {
    const content = tab.rightPanel.querySelector('.dir-viewer-content');
    const empty = tab.rightPanel.querySelector('.dir-viewer-empty');
    content.style.display = '';
    content.innerHTML = '';
    empty.style.display = 'none';

    // Folders render here too, so they can be selected and deleted in this mode.
    const items = [...tab.entries];
    if (items.length === 0) {
      content.innerHTML = '<div style="padding:16px;color:var(--text-dim);font-size:12px">Empty directory</div>';
      return;
    }

    const sortBar = document.createElement('div');
    sortBar.className = 'dir-preview-sort-bar';
    const previewSortKey = tab.previewSortBy || tab.sortBy;
    const previewSortDir = tab.previewSortDir || tab.sortDir;
    for (const s of ['name', 'date', 'size']) {
      const btn = document.createElement('button');
      btn.className = 'dir-sort-btn' + (previewSortKey === s ? ' active' : '');
      btn.textContent = s.charAt(0).toUpperCase() + s.slice(1) + (previewSortKey === s ? (previewSortDir === 'desc' ? ' ↓' : ' ↑') : '');
      btn.addEventListener('click', () => {
        if (tab.previewSortBy === s) {
          tab.previewSortDir = tab.previewSortDir === 'asc' ? 'desc' : 'asc';
        } else {
          tab.previewSortBy = s;
          tab.previewSortDir = 'asc';
        }
        renderPreviews(tab);
      });
      sortBar.appendChild(btn);
    }
    content.appendChild(sortBar);

    const sortedItems = items.sort((a, b) => {
      // Folders first, mirroring the listing mode: size and date are meaningless
      // on a directory, and a divergent order would desync _lastSelectedIndex,
      // which both modes share.
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      const dir = previewSortDir === 'desc' ? -1 : 1;
      if (previewSortKey === 'name') return dir * a.name.localeCompare(b.name);
      if (previewSortKey === 'date') return dir * (new Date(a.mtime) - new Date(b.mtime));
      return dir * ((a.size || 0) - (b.size || 0));
    });

    const gridWrap = document.createElement('div');
    gridWrap.className = 'dir-preview-grid-wrap';

    const grid = document.createElement('div');
    grid.className = 'dir-preview-grid';

    for (let i = 0; i < sortedItems.length; i++) {
      const entry = sortedItems[i];
      const fullPath = joinPath(tab.cwd, entry.name);
      // Decide on isDirectory before any extension sniffing: a folder named
      // "assets.css" must not be categorised as text and then fetched as a file.
      const ext = entry.isDirectory ? '' : (entry.name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || '';
      const category = entry.isDirectory ? 'folder' : getFileCategory(ext);

      const card = document.createElement('div');
      card.className = 'dir-preview-card' + (entry.isDirectory ? ' dir-folder' : '')
        + (tab.selectedPaths.has(fullPath) ? ' selected' : '');
      card.dataset.index = i;
      card.dataset.path = fullPath;

      const thumb = document.createElement('div');
      thumb.className = 'dir-preview-thumb';

      if (category === 'folder') {
        thumb.innerHTML = FOLDER_SVG;
      } else if (category === 'image') {
        const img = document.createElement('img');
        img.src = '/api/raw-file?path=' + encodeURIComponent(fullPath);
        img.alt = entry.name;
        img.loading = 'lazy';
        thumb.appendChild(img);
      } else if (category === 'video') {
        thumb.classList.add('dir-preview-thumb-video');
        const mosaic = document.createElement('div');
        mosaic.className = 'dir-video-mosaic';
        for (let t = 0; t < 4; t++) {
          const ti = document.createElement('img');
          ti.loading = 'lazy';
          ti.src = '/api/video-thumb?i=' + t + '&path=' + encodeURIComponent(fullPath);
          ti.alt = '';
          mosaic.appendChild(ti);
        }
        thumb.appendChild(mosaic);
        const play = document.createElement('div');
        play.className = 'dir-video-play';
        play.textContent = '▶';
        thumb.appendChild(play);
      } else if (category === 'text') {
        const pre = document.createElement('pre');
        pre.textContent = 'Loading...';
        thumb.appendChild(pre);
        fetch('/api/raw-file?path=' + encodeURIComponent(fullPath))
          .then(r => r.ok ? r.text() : Promise.reject())
          .then(text => { pre.textContent = text.slice(0, 600); })
          .catch(() => { pre.textContent = '(failed to load)'; });
      } else {
        thumb.innerHTML = BINARY_SVG;
      }

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'dir-preview-cb';
      cb.checked = tab.selectedPaths.has(fullPath);
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        const idx = parseInt(card.dataset.index, 10);
        if (cb.checked) tab.selectedPaths.add(fullPath);
        else tab.selectedPaths.delete(fullPath);
        tab._lastSelectedIndex = idx;
        syncCardSelection(grid, tab);
        updateDeleteBar(tab, sortBar, gridBarOpts(tab, content));
      });

      const label = document.createElement('div');
      label.className = 'dir-preview-label';
      label.textContent = entry.name;
      label.title = entry.isDirectory && entry.childCount != null
        ? `${entry.name} — ${entry.childCount} item${entry.childCount !== 1 ? 's' : ''}`
        : entry.name;

      card.appendChild(cb);
      card.appendChild(thumb);
      card.appendChild(label);

      card.addEventListener('click', (e) => {
        if (tab.selectedPaths.size > 0) {
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event('change'));
          return;
        }
        if (entry.isDirectory) {
          loadDir(tab.id, fullPath);
          return;
        }
        tab.leftPanel.querySelectorAll('.dir-entry.selected').forEach(el => el.classList.remove('selected'));
        const row = tab.leftPanel.querySelector(`.dir-entry[data-path="${CSS.escape(fullPath)}"]`);
        if (row) row.classList.add('selected');
        openFile(tab, fullPath, entry);
      });

      grid.appendChild(card);
    }

    gridWrap.appendChild(grid);
    content.appendChild(gridWrap);
    if (tab.selectedPaths.size > 0) {
      grid.classList.add('selecting');
    }
    updateDeleteBar(tab, sortBar, gridBarOpts(tab, content));
  }

  function syncCardSelection(grid, tab) {
    const selecting = tab.selectedPaths.size > 0;
    grid.classList.toggle('selecting', selecting);
    grid.querySelectorAll('.dir-preview-card').forEach(c => {
      const sel = tab.selectedPaths.has(c.dataset.path);
      c.classList.toggle('selected', sel);
      const cb = c.querySelector('.dir-preview-cb');
      if (cb) cb.checked = sel;
    });
  }

  // One delete bar serves both panel modes: they differ only in where it hangs,
  // its class, and how the mode re-syncs its rows.
  function gridBarOpts(tab, content) {
    return {
      barClass: 'dir-preview-delete-bar',
      resync: () => {
        const grid = content.querySelector('.dir-preview-grid');
        if (grid) syncCardSelection(grid, tab);
      },
    };
  }

  function listingBarOpts(tab, content) {
    return {
      barClass: 'dir-listing-delete-bar',
      resync: () => {
        const wrap = content.querySelector('.dir-listing-wrap');
        if (wrap) syncListingSelection(wrap, tab);
      },
    };
  }

  function updateDeleteBar(tab, hostEl, opts) {
    let bar = hostEl.querySelector('.' + opts.barClass);
    const sel = getSelectedEntries(tab);
    if (sel.paths.length === 0) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.className = opts.barClass;
      const clearBtn = document.createElement('button');
      clearBtn.className = 'dir-preview-clear-btn';
      clearBtn.textContent = 'Cancel';
      clearBtn.addEventListener('click', () => {
        tab.selectedPaths.clear();
        tab._lastSelectedIndex = -1;
        opts.resync();
        updateDeleteBar(tab, hostEl, opts);
      });
      const delBtn = document.createElement('button');
      delBtn.className = 'dir-preview-delete-btn';
      bar.appendChild(clearBtn);
      bar.appendChild(delBtn);
      hostEl.appendChild(bar);
    }
    const delBtn = bar.querySelector('.dir-preview-delete-btn');
    // The breakdown stays off the button — it overflows the 11px pill in a
    // narrow panel. The confirm dialog carries the detail instead.
    delBtn.textContent = 'Delete ' + describeSelection(sel);
    delBtn.onclick = () => deleteSelected(tab);
  }

  // toast.js may not have attached showToast when this module evaluates, so it
  // is resolved at call time rather than destructured at the top.
  function notifyDelete(level, message) {
    window.dashboard.showToast?.({ message, level, sender: 'Directories' });
  }

  function buildDeleteMessage(sel) {
    const listed = [...sel.dirs, ...sel.files];
    const total = listed.length;
    const warn = sel.dirs.length
      ? 'Folders and all their contents will be permanently deleted.\nThis cannot be undone.'
      : 'This cannot be undone.';
    if (total === 1) return `Delete "${listed[0].entry.name}"?\n\n${warn}`;

    // .confirm-modal-message is pre-wrap, so multi-line copy needs no changes.
    const lines = listed.slice(0, 10).map(({ entry }) => {
      if (!entry.isDirectory) return `  ${entry.name}`;
      const n = entry.childCount;
      return `  ${entry.name}/` + (n != null ? `  (${n} item${n !== 1 ? 's' : ''})` : '');
    });
    if (total > 10) lines.push(`  …and ${total - 10} more`);
    return `Delete ${total} items?\n\n${lines.join('\n')}\n\n${warn}`;
  }

  function deleteSelected(tab) {
    const sel = getSelectedEntries(tab);
    if (sel.paths.length === 0) return;
    // Snapshot both: the dialog is async and the panel can navigate under it.
    const cwd = tab.cwd;
    const paths = sel.paths;

    showConfirmModal(buildDeleteMessage(sel), async () => {
      try {
        const resp = await fetch('/api/delete-files', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths, cwd }),
        });
        const result = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          // Without this an expired session returns {error} and no errors[],
          // so the reload below would look exactly like a successful delete.
          notifyDelete('error', result.error || `Delete failed (${resp.status})`);
        } else if (result.errors?.length) {
          const names = result.errors.slice(0, 3).map(e => String(e.path).split('/').pop());
          const more = result.errors.length > 3 ? `, +${result.errors.length - 3} more` : '';
          notifyDelete('error', `Could not delete ${names.join(', ')}${more}`);
        } else {
          notifyDelete('success', `Deleted ${describeSelection(sel)}`);
        }
      } catch (err) {
        notifyDelete('error', 'Delete failed: ' + err.message);
      } finally {
        // Refresh even on throw: a network error otherwise leaves the panel
        // showing entries that may already be gone.
        tab.selectedPaths.clear();
        tab._lastSelectedIndex = -1;
        loadDir(tab.id, cwd);
      }
    });
  }

  // ── Directory listing in preview panel ─────────────────────────────

  function renderDirListing(tab) {
    const content = tab.rightPanel.querySelector('.dir-viewer-content');
    const empty = tab.rightPanel.querySelector('.dir-viewer-empty');
    content.style.display = '';
    content.innerHTML = '';
    empty.style.display = 'none';

    if (!tab.entries || tab.entries.length === 0) {
      content.innerHTML = '<div style="padding:16px;color:var(--text-dim);font-size:12px">Empty directory</div>';
      return;
    }

    const sortKey = tab.listingSortBy || tab.sortBy || 'name';
    const sortDir = tab.listingSortDir || tab.sortDir || 'asc';

    // Column header row
    const header = document.createElement('div');
    header.className = 'dir-listing-header';
    const columns = [
      { key: 'name', label: 'Name', cls: 'dir-listing-col-name' },
      { key: 'size', label: 'Size', cls: 'dir-listing-col-size' },
      { key: 'date', label: 'Modified', cls: 'dir-listing-col-date' },
    ];
    for (const col of columns) {
      const hdr = document.createElement('div');
      hdr.className = 'dir-listing-col-header ' + col.cls + (sortKey === col.key ? ' active' : '');
      const label = document.createElement('span');
      label.textContent = col.label;
      hdr.appendChild(label);
      if (sortKey === col.key) {
        const arrow = document.createElement('span');
        arrow.className = 'dir-listing-sort-arrow';
        arrow.textContent = sortDir === 'desc' ? ' ▾' : ' ▴';
        hdr.appendChild(arrow);
      }
      hdr.addEventListener('click', () => {
        if (tab.listingSortBy === col.key) {
          tab.listingSortDir = tab.listingSortDir === 'asc' ? 'desc' : 'asc';
        } else {
          tab.listingSortBy = col.key;
          tab.listingSortDir = 'asc';
        }
        renderDirListing(tab);
      });
      header.appendChild(hdr);
    }
    content.appendChild(header);

    const sorted = [...tab.entries].sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      const dir = sortDir === 'desc' ? -1 : 1;
      if (sortKey === 'name') return dir * a.name.localeCompare(b.name);
      if (sortKey === 'date') return dir * ((a.mtime || 0) - (b.mtime || 0));
      return dir * ((a.size || 0) - (b.size || 0));
    });

    const wrap = document.createElement('div');
    wrap.className = 'dir-listing-wrap';

    let totalSize = 0;
    for (let i = 0; i < sorted.length; i++) {
      const entry = sorted[i];
      const fullPath = joinPath(tab.cwd, entry.name);
      if (!entry.isDirectory) totalSize += entry.size || 0;

      const row = document.createElement('div');
      row.className = 'dir-listing-entry' + (entry.isDirectory ? ' dir-folder' : '') + (tab.selectedPaths.has(fullPath) ? ' selected' : '');
      row.dataset.index = i;
      row.dataset.path = fullPath;
      row.dataset.isDir = entry.isDirectory ? '1' : '';

      const icon = document.createElement('span');
      icon.className = 'dir-entry-icon';
      icon.textContent = entry.isDirectory ? '📁' : getFileIcon(entry.name);

      const name = document.createElement('span');
      name.className = 'dir-entry-name';
      name.textContent = entry.name;
      name.title = entry.name;

      const sizeText = entry.isDirectory
        ? (entry.childCount != null ? entry.childCount + ' item' + (entry.childCount !== 1 ? 's' : '') : '')
        : formatSize(entry.size);
      const size = document.createElement('span');
      size.className = 'dir-entry-size';
      size.textContent = sizeText;
      size.title = sizeText;

      const date = document.createElement('span');
      date.className = 'dir-entry-date';
      if (entry.isDirectory && entry.oldestChild && entry.newestChild) {
        const dateText = formatDate(entry.oldestChild) + ' – ' + formatDate(entry.newestChild);
        date.textContent = dateText;
        date.title = 'Oldest: ' + new Date(entry.oldestChild).toLocaleString() + '\nNewest: ' + new Date(entry.newestChild).toLocaleString();
      } else {
        date.textContent = formatDate(entry.mtime);
        date.title = entry.mtime ? new Date(entry.mtime).toLocaleString() : '';
      }

      row.appendChild(icon);
      row.appendChild(name);
      row.appendChild(size);
      row.appendChild(date);

      row.addEventListener('click', (e) => {
        const idx = parseInt(row.dataset.index, 10);
        if (e.shiftKey && tab._lastSelectedIndex >= 0) {
          const from = Math.min(tab._lastSelectedIndex, idx);
          const to = Math.max(tab._lastSelectedIndex, idx);
          if (!e.ctrlKey && !e.metaKey) tab.selectedPaths.clear();
          for (let j = from; j <= to; j++) {
            const r = wrap.children[j];
            if (r) tab.selectedPaths.add(r.dataset.path);
          }
        } else if (e.ctrlKey || e.metaKey) {
          if (tab.selectedPaths.has(fullPath)) tab.selectedPaths.delete(fullPath);
          else tab.selectedPaths.add(fullPath);
        } else {
          tab.selectedPaths.clear();
          tab.selectedPaths.add(fullPath);
        }
        tab._lastSelectedIndex = idx;
        syncListingSelection(wrap, tab);
        updateDeleteBar(tab, header, listingBarOpts(tab, content));
      });

      row.addEventListener('dblclick', () => {
        if (entry.isDirectory) {
          loadDir(tab.id, fullPath);
        } else {
          openFile(tab, fullPath, entry);
        }
      });

      wrap.appendChild(row);
    }

    content.appendChild(wrap);

    // Status bar with totals
    const dirs = tab.entries.filter(e => e.isDirectory);
    const files = tab.entries.filter(e => !e.isDirectory);
    const statusBar = document.createElement('div');
    statusBar.className = 'dir-listing-status';
    const parts = [];
    if (dirs.length) parts.push(dirs.length + ' folder' + (dirs.length !== 1 ? 's' : ''));
    if (files.length) parts.push(files.length + ' file' + (files.length !== 1 ? 's' : ''));
    if (totalSize > 0) parts.push(formatSize(totalSize) + ' total');
    statusBar.textContent = parts.join(', ');
    content.appendChild(statusBar);

    updateDeleteBar(tab, header, listingBarOpts(tab, content));
  }

  function syncListingSelection(wrap, tab) {
    for (const row of wrap.children) {
      row.classList.toggle('selected', tab.selectedPaths.has(row.dataset.path));
    }
  }

  // ── Confirm modal ─────────────────────────────────────────────────

  function showConfirmModal(message, onConfirm) {
    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'confirm-modal';

    const msg = document.createElement('div');
    msg.className = 'confirm-modal-message';
    msg.textContent = message;

    const actions = document.createElement('div');
    actions.className = 'confirm-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'confirm-modal-cancel';
    cancelBtn.textContent = 'Cancel';

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'confirm-modal-delete';
    deleteBtn.textContent = 'Delete';

    actions.appendChild(cancelBtn);
    actions.appendChild(deleteBtn);
    modal.appendChild(msg);
    modal.appendChild(actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    deleteBtn.focus();

    const close = () => backdrop.remove();
    cancelBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    deleteBtn.addEventListener('click', () => { close(); onConfirm(); });
  }

  // ── Terminal panel ─────────────────────────────────────────────────

  const shellTabs = new Map();
  const dirShellIds = new Set();
  let dirShellSeq = 0;

  function getCliTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') !== 'bright';
    return isDark
      ? { background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#a0a0ff', selectionBackground: 'rgba(160,160,255,0.3)' }
      : { background: '#f8f8f8', foreground: '#1a1a1a', cursor: '#3355aa', selectionBackground: 'rgba(50,80,170,0.2)' };
  }

  function openTerminal(tab, reconnectShellId) {
    if (tab._shellOpen) return;
    tab._shellOpen = true;

    const wrap = tab.wrap;
    wrap.style.flexDirection = 'column';

    const browserContent = document.createElement('div');
    browserContent.className = 'dir-browser-content';
    while (wrap.firstChild) browserContent.appendChild(wrap.firstChild);
    wrap.appendChild(browserContent);
    tab._browserContent = browserContent;

    const hResizer = document.createElement('div');
    hResizer.className = 'dir-h-resizer';
    wrap.appendChild(hResizer);
    tab._hResizer = hResizer;

    const termPanel = document.createElement('div');
    termPanel.className = 'dir-terminal-panel';
    termPanel.style.height = '200px';
    wrap.appendChild(termPanel);
    tab._termPanel = termPanel;

    const termHeader = document.createElement('div');
    termHeader.className = 'dir-terminal-header';
    const termTitle = document.createElement('span');
    termTitle.className = 'dir-terminal-title';
    termTitle.textContent = 'Terminal';
    const termClose = document.createElement('button');
    termClose.className = 'dir-terminal-close';
    termClose.title = 'Close terminal';
    termClose.textContent = '×';
    termClose.addEventListener('click', () => closeTerminal(tab));
    termHeader.appendChild(termTitle);
    termHeader.appendChild(termClose);
    termPanel.appendChild(termHeader);

    let startY, startH;
    function onMove(e) {
      const dy = startY - e.clientY;
      const newH = Math.max(60, Math.min(startH + dy, wrap.offsetHeight - 120));
      termPanel.style.height = newH + 'px';
      if (tab._termFitAddon) try { tab._termFitAddon.fit(); } catch {}
    }
    function onUp() {
      hResizer.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    hResizer.addEventListener('mousedown', e => {
      e.preventDefault();
      startY = e.clientY;
      startH = termPanel.offsetHeight;
      hResizer.classList.add('dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"Cascadia Code", Menlo, Monaco, "Courier New", monospace',
      theme: getCliTheme(),
      convertEol: true,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    try { terminal.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch {}
    const termBody = document.createElement('div');
    termBody.className = 'dir-terminal-body';
    termPanel.appendChild(termBody);

    terminal.open(termBody);
    tab._terminal = terminal;
    tab._termFitAddon = fitAddon;

    const ro = new ResizeObserver(() => {
      if (termBody.offsetWidth > 0) {
        try { fitAddon.fit(); } catch {}
      }
    });
    ro.observe(termBody);
    tab._termResizeObserver = ro;

    const shellId = reconnectShellId || ('dir-shell-' + (++dirShellSeq));
    tab._shellTabId = shellId;
    shellTabs.set(shellId, tab);
    dirShellIds.add(shellId);

    tab._terminal.onData(data => {
      sendWs({ type: 'cli:input', tabId: shellId, data });
    });
    tab._terminal.onResize(({ cols, rows }) => {
      sendWs({ type: 'cli:resize', tabId: shellId, cols, rows });
    });

    if (reconnectShellId) {
      sendWs({ type: 'cli:requestScrollback', tabId: shellId });
      setTimeout(() => {
        try { tab._termFitAddon.fit(); } catch {}
        const { cols, rows } = { cols: tab._terminal.cols, rows: tab._terminal.rows };
        sendWs({ type: 'cli:resize', tabId: shellId, cols, rows });
      }, 100);
    } else {
      const { cols, rows } = { cols: tab._terminal.cols, rows: tab._terminal.rows };
      sendWs({ type: 'cli:spawn', tabId: shellId, cwd: tab.cwd || '/', cols, rows, shell: true });
      setTimeout(() => {
        try { tab._termFitAddon.fit(); } catch {}
        tab._terminal.focus();
      }, 100);
    }
    _saveDirTabs();
  }

  function closeTerminal(tab) {
    if (!tab._shellOpen) return;
    tab._shellOpen = false;

    if (tab._shellTabId) {
      sendWs({ type: 'cli:closeTab', tabId: tab._shellTabId });
      shellTabs.delete(tab._shellTabId);
      dirShellIds.delete(tab._shellTabId);
      tab._shellTabId = null;
    }

    if (tab._termResizeObserver) {
      tab._termResizeObserver.disconnect();
      tab._termResizeObserver = null;
    }
    if (tab._terminal) {
      tab._terminal.dispose();
      tab._terminal = null;
      tab._termFitAddon = null;
    }

    const wrap = tab.wrap;
    if (tab._termPanel) { tab._termPanel.remove(); tab._termPanel = null; }
    if (tab._hResizer) { tab._hResizer.remove(); tab._hResizer = null; }

    if (tab._browserContent) {
      while (tab._browserContent.firstChild) wrap.appendChild(tab._browserContent.firstChild);
      tab._browserContent.remove();
      tab._browserContent = null;
    }
    wrap.style.flexDirection = '';
    _saveDirTabs();
  }

  function handleShellMessage(msg) {
    if (msg.type === 'cli:tabs') {
      if (_pendingTerminalRestores.length > 0) {
        const serverIds = new Set((msg.tabs || []).map(t => t.tabId));
        const pending = _pendingTerminalRestores.splice(0);
        for (const entry of pending) {
          if (serverIds.has(entry.shellTabId)) {
            openTerminal(entry.tab, entry.shellTabId);
          }
        }
      }
      if (dirShellIds.size > 0) {
        msg.tabs = (msg.tabs || []).filter(t => !dirShellIds.has(t.tabId));
      }
      return false;
    }

    const tab = msg.tabId ? shellTabs.get(msg.tabId) : null;
    if (!tab) return false;

    switch (msg.type) {
      case 'cli:output':
        if (tab._terminal) tab._terminal.write(msg.data);
        return true;
      case 'cli:exit':
        closeTerminal(tab);
        return true;
    }
    return true;
  }

  // ── Search ─────────────────────────────────────────────────────────

  function openSearchModal(tab) {
    const backdrop = document.createElement('div');
    backdrop.className = 'cap-modal-backdrop';
    backdrop.innerHTML = `
      <div class="cap-modal dir-search-modal">
        <div class="cap-modal-header">
          <h3>Search Files</h3>
          <button class="cap-modal-close" title="Close">&times;</button>
        </div>
        <div class="cap-modal-body">
          <div class="dir-search-field">
            <label>Filename pattern <span style="opacity:.5">(regex)</span></label>
            <input type="text" id="dirSearchName" placeholder="e.g. \\.test\\.js$" spellcheck="false" autocomplete="off">
          </div>
          <div class="dir-search-field">
            <label>Content pattern <span style="opacity:.5">(regex, text files only)</span></label>
            <input type="text" id="dirSearchContent" placeholder="e.g. TODO|FIXME" spellcheck="false" autocomplete="off">
          </div>
          <div class="dir-search-field">
            <label>Last modified</label>
            <select id="dirSearchModified">
              <option value="">Any</option>
              <option value="5m">Last 5 minutes</option>
              <option value="15m">Last 15 minutes</option>
              <option value="1h">Last hour</option>
              <option value="today">Today</option>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
          </div>
        </div>
        <div class="cap-modal-footer">
          <button class="cap-cancel-btn dir-search-cancel">Cancel</button>
          <button class="cap-save-btn dir-search-submit">Search</button>
        </div>
      </div>`;

    document.body.appendChild(backdrop);

    const close = () => backdrop.remove();
    backdrop.querySelector('.cap-modal-close').addEventListener('click', close);
    backdrop.querySelector('.dir-search-cancel').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

    const nameInput = backdrop.querySelector('#dirSearchName');
    const contentInput = backdrop.querySelector('#dirSearchContent');
    const modifiedSelect = backdrop.querySelector('#dirSearchModified');

    backdrop.querySelector('.dir-search-submit').addEventListener('click', () => {
      const fn = nameInput.value.trim();
      const ct = contentInput.value.trim();
      const mod = modifiedSelect.value;
      if (!fn && !ct && !mod) return;
      close();
      executeSearch(tab, fn, ct, mod);
    });

    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') backdrop.querySelector('.dir-search-submit').click();
    });
    contentInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') backdrop.querySelector('.dir-search-submit').click();
    });

    setTimeout(() => nameInput.focus(), 50);
  }

  async function executeSearch(tab, filenamePattern, contentPattern, modifiedWithin) {
    const listEl = tab.leftPanel.querySelector('.dir-file-list');
    listEl.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:12px">Searching…</div>';
    tab.searchMode = true;

    try {
      const params = new URLSearchParams({ path: tab.cwd });
      if (filenamePattern) params.set('filenamePattern', filenamePattern);
      if (contentPattern) params.set('contentPattern', contentPattern);
      if (modifiedWithin) params.set('modifiedWithin', modifiedWithin);

      const resp = await fetch('/api/search-files?' + params);
      const data = await resp.json();

      if (data.error) {
        listEl.innerHTML = `<div style="padding:12px;color:#e55;font-size:12px">${escHtml(data.error)}</div>`;
        return;
      }
      renderSearchResults(tab, data.results);
    } catch {
      listEl.innerHTML = '<div style="padding:12px;color:#e55;font-size:12px">Search failed</div>';
    }
  }

  function renderSearchResults(tab, results) {
    const listEl = tab.leftPanel.querySelector('.dir-file-list');
    listEl.innerHTML = '';

    const hdr = document.createElement('div');
    hdr.className = 'dir-search-results-header';
    const countSpan = document.createElement('span');
    countSpan.textContent = results.length + ' result' + (results.length !== 1 ? 's' : '');
    hdr.appendChild(countSpan);
    const clearBtn = document.createElement('button');
    clearBtn.className = 'dir-search-clear';
    clearBtn.textContent = '✕ Clear';
    clearBtn.addEventListener('click', () => loadDir(tab.id, tab.cwd));
    hdr.appendChild(clearBtn);
    listEl.appendChild(hdr);

    if (results.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:12px;color:var(--text-dim);font-size:12px';
      empty.textContent = 'No files found';
      listEl.appendChild(empty);
      return;
    }

    for (const file of results) {
      const row = document.createElement('div');
      row.className = 'dir-entry dir-search-result';
      if (tab.selectedFile === file.path) row.classList.add('selected');

      const icon = document.createElement('span');
      icon.className = 'dir-entry-icon';
      icon.textContent = getFileIcon(file.name);

      const name = document.createElement('span');
      name.className = 'dir-entry-name';
      // Not a join: a prefix test plus a slice, so both must use the same string.
      const prefix = tab.cwd === '/' ? '/' : tab.cwd + '/';
      const relPath = file.path.startsWith(prefix)
        ? file.path.slice(prefix.length)
        : file.name;
      name.textContent = relPath;
      name.title = file.path;

      const size = document.createElement('span');
      size.className = 'dir-entry-size';
      size.textContent = formatSize(file.size);

      row.appendChild(icon);
      row.appendChild(name);
      row.appendChild(size);

      row.addEventListener('click', () => {
        listEl.querySelectorAll('.dir-entry.selected').forEach(el => el.classList.remove('selected'));
        row.classList.add('selected');
        const entry = { name: file.name, size: file.size, mtime: file.mtime, isDirectory: false };
        openFile(tab, file.path, entry);
      });

      listEl.appendChild(row);
    }
  }

  // ── Utilities ──────────────────────────────────────────────────────

  const TEXT_EXTS = new Set([
    'txt','md','mdx','json','js','mjs','cjs','jsx','ts','tsx','css','scss','less',
    'html','htm','xml','csv','yaml','yml','toml','ini','sh','bash','zsh',
    'py','rb','go','rs','java','c','cpp','h','hpp','cs','php','swift','kt','scala',
    'sql','r','lua','pl','pm','ex','exs','erl','hs','ml','clj','dart','v','zig',
    'dockerfile','makefile','cmake','gitignore','gitattributes','editorconfig',
    'env','log','cfg','conf','properties','lock','vue','svelte','astro',
    'graphql','gql','proto','tf','hcl','nix','bat','ps1','fish',
  ]);
  const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','svg','webp','bmp','ico','avif']);
  const AUDIO_EXTS = new Set(['mp3','wav','ogg','flac','aac','m4a','wma']);
  const VIDEO_EXTS = new Set(['mp4','webm','ogv','mov','avi','mkv']);

  function getFileCategory(ext) {
    if (TEXT_EXTS.has(ext)) return 'text';
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (AUDIO_EXTS.has(ext)) return 'audio';
    if (VIDEO_EXTS.has(ext)) return 'video';
    if (ext === 'pdf') return 'pdf';
    return 'unknown';
  }

  function getMonacoLanguage(ext) {
    const map = {
      js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
      ts: 'typescript', tsx: 'typescript',
      json: 'json', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
      xml: 'xml', md: 'markdown', mdx: 'markdown',
      py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
      java: 'java', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
      php: 'php', swift: 'swift', kt: 'kotlin', scala: 'scala',
      sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell',
      yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
      dockerfile: 'dockerfile', graphql: 'graphql', gql: 'graphql',
      r: 'r', lua: 'lua', pl: 'perl', dart: 'dart',
      bat: 'bat', ps1: 'powershell',
    };
    return map[ext] || 'plaintext';
  }

  function getFileIcon(name) {
    const ext = (name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || '';
    if (IMAGE_EXTS.has(ext)) return '🖼️';
    if (AUDIO_EXTS.has(ext)) return '🎵';
    if (VIDEO_EXTS.has(ext)) return '🎬';
    if (ext === 'pdf') return '📄';
    if (['zip','tar','gz','rar','7z','bz2','xz'].includes(ext)) return '📦';
    return '📋';
  }

  function formatSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' K';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' M';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' G';
  }

  function formatDate(mtimeMs) {
    if (!mtimeMs) return '';
    const d = new Date(mtimeMs);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    if (d.getFullYear() === now.getFullYear()) {
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
    return d.toLocaleDateString([], { year: '2-digit', month: 'short', day: 'numeric' });
  }

  // ── Keyboard navigation ───────────────────────────────────────────

  function highlightRow(tab, idx) {
    const listEl = tab.leftPanel.querySelector('.dir-file-list');
    const rows = listEl.querySelectorAll('.dir-entry');
    rows.forEach(r => r.classList.remove('selected'));
    if (idx >= 0 && idx < rows.length) {
      rows[idx].classList.add('selected');
      rows[idx].scrollIntoView({ block: 'nearest' });
      const path = rows[idx].dataset.path;
      const isDir = rows[idx].dataset.isDir === '1';
      if (!isDir) {
        const entry = tab.entries.find(e => joinPath(tab.cwd, e.name) === path);
        if (entry) openFile(tab, path, entry);
      }
    }
  }

  document.addEventListener('keydown', e => {
    if (activeOverlay) return;
    // The confirm dialog's Delete button is a BUTTON, so it clears none of the
    // guards below: Enter on a highlighted folder row would navigate and wipe
    // the selection while the dialog is still open.
    if (document.querySelector('.confirm-modal-backdrop')) return;
    if (activeTabId === null) return;
    const dirView = document.getElementById('view-directories');
    if (!dirView || dirView.style.display === 'none') return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    const tab = tabs.get(activeTabId);
    if (!tab) return;

    const listEl = tab.leftPanel.querySelector('.dir-file-list');
    const rows = listEl.querySelectorAll('.dir-entry');
    if (rows.length === 0) return;

    const selectedIdx = Array.from(rows).findIndex(r => r.classList.contains('selected'));

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlightRow(tab, selectedIdx < 0 ? 0 : Math.min(selectedIdx + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlightRow(tab, selectedIdx <= 0 ? 0 : selectedIdx - 1);
    } else if (e.key === 'Enter' && selectedIdx >= 0) {
      e.preventDefault();
      rows[selectedIdx].click();
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      const upBtn = tab.leftPanel.querySelector('.dir-breadcrumb');
      if (upBtn && upBtn.textContent.includes('↑')) upBtn.click();
    } else if (e.key === 'ArrowRight' && selectedIdx >= 0 && rows[selectedIdx].dataset.isDir === '1') {
      e.preventDefault();
      rows[selectedIdx].click();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const upBtn = tab.leftPanel.querySelector('.dir-breadcrumb');
      if (upBtn && upBtn.textContent.includes('↑')) upBtn.click();
    }
  });

  // ── "+" button ─────────────────────────────────────────────────────

  tabNewBtn?.addEventListener('click', () => {
    const tab = createTab(null);
    switchTab(tab.id);
    loadDir(tab.id, '');
  });

  // ── Theme sync ─────────────────────────────────────────────────────

  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      setTimeout(() => {
        if (!monacoReady) return;
        monaco.editor.setTheme(getMonacoTheme());
      }, 100);
    });
  }

  // ── Restore saved directory tabs on load ────────────────────────────

  const _savedState = _loadDirTabs();
  if (_savedState && _savedState.tabs && _savedState.tabs.length > 0) {
    for (const entry of _savedState.tabs) {
      if (!entry.cwd) continue;
      const tab = createTab(entry.cwd);
      loadDir(tab.id, entry.cwd);
      if (entry.shellOpen && entry.shellTabId) {
        dirShellIds.add(entry.shellTabId);
        const seq = parseInt(entry.shellTabId.replace('dir-shell-', ''), 10);
        if (seq >= dirShellSeq) dirShellSeq = seq;
        _pendingTerminalRestores.push({ tab, shellTabId: entry.shellTabId });
      }
    }
    const allIds = Array.from(tabs.keys());
    const idx = _savedState.activeIndex >= 0 && _savedState.activeIndex < allIds.length
      ? _savedState.activeIndex : 0;
    if (allIds.length > 0) switchTab(allIds[idx]);
  }

  function openPath(dirPath) {
    const tab = createTab(dirPath || null);
    switchTab(tab.id);
    loadDir(tab.id, dirPath || '');
    return tab.id;
  }

  window.directoriesModule = { tabs, handleShellMessage, openPath };
})();
