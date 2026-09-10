(function() {
  'use strict';
  const { state, escHtml, highlightJSON, renderJSON, jsonBlock, formatDuration, truncate,
          renderMarkdown, renderMarkdownDebounced, cancelRenderDebounce, sendWs,
          linkifyFilePaths, openFilePreview, fileCategory,
          timelineList, detailContent, emptyState, statsEl } = window.dashboard;

  // Absolute file paths anywhere in the detail pane (tool input JSON, tool
  // results, hook payloads) become links that open the file preview modal.
  function linkifyDetail(root) {
    if (!root) return;
    try { linkifyFilePaths(root, { includePre: true }); } catch {}
  }

  // --- Auto-select suppression: don't jump away from user-selected turns ---
  let _liveMode = localStorage.getItem('timelineLive') !== 'false';
  let _autoClearInactive = localStorage.getItem('inspectorAutoClear') === '1';
  let _suppressAutoClear = false;

  // --- Subagent registry: track numbering and colors for parallel subagents ---
  const _subagentRegistry = new Map();    // agentId -> { agentType, number, colorIndex }
  const _subagentTypeCounts = new Map();  // agentType -> Map<agentId, number>
  let _subagentColorCounter = 0;
  const SUBAGENT_COLORS = [
    '#7dcfff', // cyan
    '#ff9e64', // orange
    '#bb9af7', // purple
    '#9ece6a', // green
    '#f7768e', // pink
    '#e0af68', // yellow
    '#ff7eb6', // magenta
    '#7aa2f7', // blue
  ];

  function registerSubagent(subagent) {
    if (!subagent?.agentId) return null;
    if (_subagentRegistry.has(subagent.agentId)) return _subagentRegistry.get(subagent.agentId);

    const type = subagent.agentType || 'subagent';
    if (!_subagentTypeCounts.has(type)) _subagentTypeCounts.set(type, new Map());
    const typeMap = _subagentTypeCounts.get(type);
    const number = typeMap.size + 1;
    typeMap.set(subagent.agentId, number);

    const colorIndex = _subagentColorCounter++ % SUBAGENT_COLORS.length;
    const entry = { agentType: type, number, colorIndex };
    _subagentRegistry.set(subagent.agentId, entry);

    if (number === 2) refreshSubagentLabelsForType(type);

    return entry;
  }

  function getSubagentLabel(subagent) {
    if (!subagent?.agentId) return subagent?.agentType || 'subagent';
    const entry = _subagentRegistry.get(subagent.agentId);
    if (!entry) return subagent.agentType || 'subagent';
    const typeMap = _subagentTypeCounts.get(entry.agentType);
    if (typeMap && typeMap.size > 1) return `${entry.agentType} ${entry.number}`;
    return entry.agentType;
  }

  function getSubagentColor(subagent) {
    if (!subagent?.agentId) return SUBAGENT_COLORS[0];
    const entry = _subagentRegistry.get(subagent.agentId);
    if (!entry) return SUBAGENT_COLORS[0];
    return SUBAGENT_COLORS[entry.colorIndex];
  }

  function refreshSubagentLabelsForType(type) {
    const typeMap = _subagentTypeCounts.get(type);
    if (!typeMap) return;
    for (const [agentId, num] of typeMap) {
      const label = typeMap.size > 1 ? `${type} ${num}` : type;
      document.querySelectorAll(`.turn-group[data-agent-id="${agentId}"]`).forEach(group => {
        const badge = group.querySelector('.entry-subagent');
        if (badge) badge.textContent = label;
        group.querySelectorAll('.tag-agent').forEach(tag => { tag.textContent = label; });
      });
    }
  }

  function resetSubagentRegistry() {
    _subagentRegistry.clear();
    _subagentTypeCounts.clear();
    _subagentColorCounter = 0;
  }

  // --- Streaming text block merge state ---
  let _streamBlockMap = new Map();   // index -> { bodyEl, needsSeparator }
  let _streamThinkingTokens = new Map();
  let _lastStreamTextBodyEl = null;
  let _pendingMarkdownBodyEl = null;

  // --- Focus mode: detail panel takes over full width ---
  let _focusMode = false;

  // --- Split mode: show parallel streaming interactions side by side ---
  let _splitMode = false;
  const _splitPanes = new Map();          // interactionId -> { pane, streamState }
  const _splitInteractions = new Set();

  function flushPendingMarkdown() {
    if (_pendingMarkdownBodyEl) {
      cancelRenderDebounce(_pendingMarkdownBodyEl);
      const rawText = _pendingMarkdownBodyEl._rawText || _pendingMarkdownBodyEl.textContent;
      if (rawText) {
        _pendingMarkdownBodyEl.classList.add('markdown-body');
        renderMarkdown(rawText, _pendingMarkdownBodyEl);
      }
      _pendingMarkdownBodyEl = null;
    }
  }

  // --- Instance tabs ---
  const knownInstances = new Map(); // instanceId -> { instanceId, status, spawnedAt }
  let activeInstanceTab = 'all';
  const inspectorTabStrip = document.getElementById('inspectorTabStrip');

  // --- External session tabs ---
  let extTabCounter = 0;
  let activeExtTab = null; // e.g. 'ext-1'

  function stampExtInteraction(interaction) {
    // Assign null-instanceId interactions to the active ext tab (auto-create if needed)
    if (interaction.instanceId) return;
    if (!activeExtTab) {
      extTabCounter++;
      activeExtTab = `ext-${extTabCounter}`;
      knownInstances.set(activeExtTab, {
        instanceId: activeExtTab,
        status: 'running', spawnedAt: interaction.timestamp || Date.now(), cwd: null,
      });
      renderInspectorTabStrip();
    }
    interaction.instanceId = activeExtTab;
  }

  function cliInstanceLabel(instanceId) {
    const info = knownInstances.get(instanceId);
    const cliTabs = window.cliModule?.tabs;
    // Resolve the live CLI tab that owns this instance. Prefer a current match by
    // instanceId (the stored info.tabId can go stale when tabs are added/removed),
    // then fall back to the stored tabId only if it's still a real tab.
    let tabId = null;
    if (cliTabs) {
      for (const [id, t] of cliTabs) {
        if (t.instanceId === instanceId) { tabId = id; break; }
      }
    }
    if (!tabId && info?.tabId && cliTabs?.has(info.tabId)) tabId = info.tabId;
    if (tabId && window.cliModule?.computeTabLabel) {
      const label = window.cliModule.computeTabLabel(tabId);
      // computeTabLabel returns the raw tabId only when it can't derive a name;
      // treat that as "no label" and fall through to the cwd basename below.
      if (label && label !== tabId) return label.replace(/^>/, '');
    }
    const cwd = info?.cwd || (tabId && cliTabs?.get(tabId)?.cwd);
    if (cwd) {
      const parts = cwd.replace(/\/+$/, '').split('/');
      return parts[parts.length - 1] || cwd;
    }
    // Last resort: a CLI session with no resolvable tab or cwd. Show a clean
    // generic label rather than the internal cli-<uuid> instanceId.
    return 'CLI';
  }

  // app-<appName>-ai-<rand> → { appName } (per-call ai.prompt sessions)
  function parseAppAiInstance(instanceId) {
    const m = typeof instanceId === 'string' && instanceId.match(/^app-(.+)-ai-[0-9a-f]+$/);
    return m ? { appName: m[1] } : null;
  }

  function appAiLabel(instanceId, appName) {
    // Ordinal only when several tabs of the same app coexist, numbered by
    // insertion order so concurrent calls read "qmd · AI 1", "qmd · AI 2".
    const siblings = [];
    for (const id of knownInstances.keys()) {
      if (parseAppAiInstance(id)?.appName === appName) siblings.push(id);
    }
    if (siblings.length <= 1) return `${appName} · AI`;
    return `${appName} · AI ${siblings.indexOf(instanceId) + 1}`;
  }

  function instanceDisplayLabel(instanceId) {
    if (!instanceId || instanceId === 'all') return 'Others';
    // ext-1 → "Ext 1"
    const extMatch = instanceId.match(/^ext-(\d+)$/);
    if (extMatch) return `Ext ${extMatch[1]}`;
    // chat-tab-1 → "Chat 1"
    const chatMatch = instanceId.match(/^chat-tab-(\d+)$/);
    if (chatMatch) return `Chat ${chatMatch[1]}`;
    const appAi = parseAppAiInstance(instanceId);
    if (appAi) return appAiLabel(instanceId, appAi.appName);
    // cli-tab-1 → cwd-based label
    if (instanceId.startsWith('cli-')) return cliInstanceLabel(instanceId);
    return instanceId;
  }

  function hasOrphanInteractions() {
    return state.interactions.some(i => !i.instanceId || !knownInstances.has(i.instanceId));
  }

  function renderInspectorTabStrip() {
    if (!inspectorTabStrip) return;
    inspectorTabStrip.innerHTML = '';
    // "Others" tab — only when orphan interactions exist
    const showOthers = false;
    if (showOthers) {
      const allBtn = document.createElement('button');
      allBtn.className = 'view-tab' + (activeInstanceTab === 'all' ? ' active' : '');
      allBtn.dataset.instanceId = 'all';
      allBtn.textContent = 'Others';
      inspectorTabStrip.appendChild(allBtn);
    } else if (activeInstanceTab === 'all' && knownInstances.size > 0) {
      activeInstanceTab = knownInstances.keys().next().value;
    }
    // Per-instance tabs
    for (const [id, info] of knownInstances) {
      const btn = document.createElement('button');
      btn.className = 'view-tab' + (activeInstanceTab === id ? ' active' : '');
      if (info.status === 'exited') btn.classList.add('instance-exited');
      btn.dataset.instanceId = id;
      const label = document.createElement('span');
      label.textContent = instanceDisplayLabel(id);
      if (id.startsWith('cli-')) {
        label.className = 'cli-tab-label';
        label.addEventListener('click', (e) => {
          e.stopPropagation();
          if (activeInstanceTab !== id) {
            switchInstanceTab(id);
            return;
          }
          const entry = knownInstances.get(id);
          if (entry?.tabId) {
            switchView('claude');
            window.cliModule?.switchTab?.(entry.tabId);
          }
        });
      }
      btn.appendChild(label);

      // Model override indicator (non-clickable)
      if (id.startsWith('cli-') && info.tabId && window.cliModule?.tabs) {
        const cliTab = window.cliModule.tabs.get(info.tabId);
        const hasOverride = cliTab?.settings &&
          cliTab.settings.modelMap && Object.values(cliTab.settings.modelMap).some(v => v);
        const overrideIcon = document.createElement('span');
        overrideIcon.className = 'cli-model-override-btn' + (hasOverride ? ' active' : '') + ' inspector-only';
        overrideIcon.innerHTML = hasOverride
          ? '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M1 2l12 10M1 7h12M1 12l12-10"/></svg>'
          : '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M1 3h10m-2-2l2 2-2 2"/><path d="M1 7h10m-2-2l2 2-2 2"/><path d="M1 11h10m-2-2l2 2-2 2"/></svg>';
        overrideIcon.title = hasOverride ? 'Model override active' : 'No model override';
        btn.appendChild(overrideIcon);
      }

      const close = document.createElement('span');
      close.className = 'view-tab-close';
      close.textContent = '\u00d7';
      btn.appendChild(close);
      inspectorTabStrip.appendChild(btn);
    }
    // Combined "Clear inactive" button with autoclear toggle
    const hasExited = [...knownInstances.values()].some(i => i.status === 'exited');

    // Autoclear: if enabled, clear exited instances immediately. App-AI tabs are
    // exempt — the headless `claude -p` exits after every ai.prompt call, and
    // their whole value is post-hoc timeline inspection. Manual clear still works.
    if (hasExited && _autoClearInactive && !_suppressAutoClear) {
      const exitedIds = [];
      for (const [id, info] of knownInstances) {
        if (info.status === 'exited' && !parseAppAiInstance(id)) exitedIds.push(id);
      }
      if (exitedIds.length) {
        for (const id of exitedIds) knownInstances.delete(id);
        sendWs({ type: 'inspector:clearInstances', instanceIds: exitedIds });
        if (!knownInstances.has(activeInstanceTab)) {
          const fallback = knownInstances.size > 0 ? knownInstances.keys().next().value : 'all';
          activeInstanceTab = fallback;
        }
        queueMicrotask(() => renderInspectorTabStrip());
        return;
      }
    }

    {
      const clearBtn = document.createElement('button');
      clearBtn.className = 'view-tab-action' + (_autoClearInactive ? ' autoclear-on' : '');
      clearBtn.title = _autoClearInactive
        ? (hasExited ? 'Clear remaining inactive tabs (autoclear skips app AI tabs)' : 'Autoclear active — inactive tabs are removed automatically')
        : 'Clear all inactive tabs';

      // Auto-toggle SVG — recycle arrows when off, check-circle when on
      const autoToggle = document.createElement('span');
      autoToggle.className = 'autoclear-toggle' + (_autoClearInactive ? ' active' : '');
      autoToggle.title = _autoClearInactive ? 'Disable autoclear' : 'Enable autoclear';
      autoToggle.innerHTML = _autoClearInactive
        ? '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><polyline points="5 8.2 7.2 10.5 11 5.5"/></svg>'
        : '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8a5.5 5.5 0 0 1 9.3-4"/><path d="M13.5 8a5.5 5.5 0 0 1-9.3 4"/><polyline points="12 1.5 12 4.5 9 4.5"/><polyline points="4 11.5 4 14.5 7 14.5"/></svg>';
      autoToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        _autoClearInactive = !_autoClearInactive;
        localStorage.setItem('inspectorAutoClear', _autoClearInactive ? '1' : '0');
        renderInspectorTabStrip();
      });

      const textSpan = document.createElement('span');
      textSpan.className = 'autoclear-label-text';
      textSpan.textContent = hasExited ? 'Clear inactive' : (_autoClearInactive ? 'Autoclear' : 'Clear inactive');

      clearBtn.appendChild(autoToggle);
      clearBtn.appendChild(textSpan);

      // Manual clear works even with autoclear on — app-AI tabs are exempt from
      // autoclear and would otherwise be unclearable.
      if (hasExited) {
        clearBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const exitedIds = [];
          for (const [id, info] of knownInstances) {
            if (info.status === 'exited') exitedIds.push(id);
          }
          for (const id of exitedIds) knownInstances.delete(id);
          if (exitedIds.length) sendWs({ type: 'inspector:clearInstances', instanceIds: exitedIds });
          if (!knownInstances.has(activeInstanceTab)) {
            const fallback = knownInstances.size > 0 ? knownInstances.keys().next().value : 'all';
            switchInstanceTab(fallback);
          } else renderInspectorTabStrip();
        });
      }

      const pinnedContainer = document.getElementById('inspectorTabPinned');
      if (pinnedContainer) {
        pinnedContainer.innerHTML = '';
        pinnedContainer.appendChild(clearBtn);
      } else {
        inspectorTabStrip.appendChild(clearBtn);
      }
    }

    updateStreamingState();
  }

  function switchInstanceTab(instanceId) {
    activeInstanceTab = instanceId;
    renderInspectorTabStrip();
    renderTimelineActive();
    updateStats();
    // Select last matching interaction
    const filtered = activeInstanceTab === 'all'
      ? state.interactions.filter(i => !i.instanceId || !knownInstances.has(i.instanceId) )
      : state.interactions.filter(i => i.instanceId === activeInstanceTab);
    const last = filtered[filtered.length - 1];
    if (last) {
      select({ type: 'turn', id: last.id });
    } else {
      state.selection = null;
      document.querySelectorAll('.timeline-entry.selected').forEach(el => el.classList.remove('selected'));
      detailContent.classList.add('hidden');
      emptyState.classList.remove('hidden');
    }
  }

  const _faviconLink = document.querySelector('link[rel="icon"]');
  const _faviconNormal = 'favicon.svg';
  const _busyFrames = [0, 5, 0, -5].map(dx => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#cc3344"/><stop offset="25%" stop-color="#c07020"/><stop offset="50%" stop-color="#1a8a3a"/><stop offset="75%" stop-color="#2255aa"/><stop offset="100%" stop-color="#7744bb"/></linearGradient></defs>
  <ellipse cx="32" cy="32" rx="29" ry="18" fill="#fff" stroke="#aaa" stroke-width="1.5"/>
  <circle cx="${32 + dx}" cy="32" r="13" fill="url(#g)"/>
  <circle cx="${32 + dx}" cy="32" r="5.5" fill="#1a1a2e"/>
  <circle cx="${28 + dx}" cy="28" r="2.5" fill="#fff"/>
  <circle cx="53" cy="12" r="11" fill="#22c55e" stroke="#fff" stroke-width="2.5"/>
</svg>`;
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  });
  let _faviconIsBusy = false;
  let _busyInterval = null;
  let _busyFrame = 0;

  function setFavicon(busy) {
    if (busy === _faviconIsBusy) return;
    _faviconIsBusy = busy;
    if (!_faviconLink) return;
    if (busy) {
      _busyFrame = 0;
      _faviconLink.href = _busyFrames[0];
      _busyInterval = setInterval(() => {
        _busyFrame = (_busyFrame + 1) % 4;
        _faviconLink.href = _busyFrames[_busyFrame];
      }, 250);
    } else {
      clearInterval(_busyInterval);
      _busyInterval = null;
      _faviconLink.href = _faviconNormal;
    }
  }

  function updateStreamingState() {
    const busyInstances = new Set();
    if (inspectorTabStrip) {
      for (const [instanceId] of knownInstances) {
        const tabBtn = inspectorTabStrip.querySelector(`[data-instance-id="${CSS.escape(instanceId)}"]`);
        if (!tabBtn) continue;
        const busy = state.interactions.some(
          i => i.instanceId === instanceId && (i.status === 'pending' || i.status === 'streaming')
        );
        tabBtn.classList.toggle('instance-running', busy);
        if (busy) busyInstances.add(instanceId);
      }
    }
    const inspectorTab = document.querySelector('[data-view="dashboard"]');
    if (inspectorTab) {
      const count = busyInstances.size;
      inspectorTab.classList.toggle('instance-running', count > 0);
      inspectorTab.textContent = 'Inspector';
    }
    setFavicon(busyInstances.size > 0);
    document.title = 'vistaclair';
    window.cliModule?.updateStreamingState?.(busyInstances);
  }

  if (inspectorTabStrip) {
    inspectorTabStrip.addEventListener('click', (e) => {
      // Close button on instance tab
      if (e.target.classList.contains('view-tab-close')) {
        const tabBtn = e.target.closest('.view-tab');
        const id = tabBtn?.dataset.instanceId;
        if (id && id !== 'all') {
          const info = knownInstances.get(id);
          if (info?.status === 'running') {
            // Running instance — confirm before killing
            if (!confirm(`"${instanceDisplayLabel(id)}" is still running.\n\nClosing this tab will terminate the Claude process. Continue?`)) return;
            sendWs({ type: 'claude:killInstance', instanceId: id });
          }
          knownInstances.delete(id);
          sendWs({ type: 'inspector:clearInstances', instanceIds: [id] });
          if (activeInstanceTab === id) {
            if (knownInstances.size > 0) {
              switchInstanceTab(knownInstances.keys().next().value);
            } else if (hasOrphanInteractions()) {
              switchInstanceTab('all');
            } else {
              activeInstanceTab = 'all';
              state.selection = null;
              document.querySelectorAll('.timeline-entry.selected').forEach(el => el.classList.remove('selected'));
              detailContent.classList.add('hidden');
              emptyState.classList.remove('hidden');
              renderInspectorTabStrip();
              renderTimelineActive();
              updateStats();
            }
          } else renderInspectorTabStrip();
        }
        return;
      }
      const tabBtn = e.target.closest('.view-tab');
      if (tabBtn && tabBtn.dataset.instanceId != null) {
        switchInstanceTab(tabBtn.dataset.instanceId);
      }
    });
  }

  // --- cURL export ---
  function buildCurlCommand(interaction) {
    const isTranslated = !!interaction.translatedBody;
    const endpoint = interaction.originalEndpoint || interaction.endpoint || '/v1/messages';
    const url = endpoint.startsWith('http') ? endpoint : `https://api.anthropic.com${endpoint}`;
    const body = isTranslated ? interaction.translatedBody : interaction.request;
    const headers = isTranslated
      ? interaction.translatedHeaders || { 'Content-Type': 'application/json', 'Authorization': 'Bearer $API_KEY' }
      : { 'Content-Type': 'application/json', 'x-api-key': '$ANTHROPIC_API_KEY', 'anthropic-version': '2023-06-01' };

    let cmd = `curl ${url} \\\n`;
    for (const [key, val] of Object.entries(headers)) {
      cmd += `  -H '${key}: ${val}' \\\n`;
    }
    cmd += `  -d '${JSON.stringify(body, null, 2)}'`;
    return cmd;
  }

  function showCurlModal(curlText) {
    // Remove existing modal if any
    document.getElementById('curl-modal-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'curl-modal-overlay';
    overlay.className = 'curl-modal-overlay';
    overlay.innerHTML = `
      <div class="curl-modal">
        <div class="curl-modal-header">
          <span>cURL Command</span>
          <div>
            <button class="curl-modal-copy">Copy</button>
            <button class="curl-modal-close">\u00d7</button>
          </div>
        </div>
        <pre class="curl-modal-body"></pre>
      </div>
    `;
    document.body.appendChild(overlay);

    // Set text content safely (no innerHTML for user data)
    overlay.querySelector('.curl-modal-body').textContent = curlText;

    const close = () => overlay.remove();
    overlay.querySelector('.curl-modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.curl-modal-copy').addEventListener('click', (e) => {
      navigator.clipboard.writeText(curlText).then(() => {
        e.target.textContent = 'Copied!';
        setTimeout(() => { e.target.textContent = 'Copy'; }, 1400);
      });
    });
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.curl-btn');
    if (!btn) return;
    const id = btn.dataset.interactionId;
    const interaction = state.interactions.find(i => i.id === id);
    if (!interaction) return;
    showCurlModal(buildCurlCommand(interaction));
  });

  /* --- Sheet rows: seed the JSON tree on first expand ---
     autoExpandSmallJsonBlocks() already unfolds anything under ~50 lines,
     so what is left is the big ones, which would otherwise open onto a
     single collapsed `{ role, content }` line. Unfold their outermost
     node once so the row shows something. `toggle` does not bubble —
     hence the capture-phase listener. */
  document.addEventListener('toggle', (e) => {
    const row = e.target;
    if (!row.classList?.contains('vc-sheet-row') || !row.open || row.dataset.seeded) return;
    row.dataset.seeded = '1';
    const node = row.querySelector('.jt-root > details.jt-node');
    if (node) node.open = true;
  }, true);

  // --- Collapse/expand a tool-use card by clicking its name header ---
  document.addEventListener('click', (e) => {
    const name = e.target.closest('.content-block-body.tool-use > .tool-name');
    if (!name) return;
    if (e.target.closest('.jt-copy')) return;
    name.parentElement.classList.toggle('collapsed');
  });

  // --- Tool call extraction ---
  function extractToolCalls(interaction) {
    const calls = [];
    const resp = interaction.response || {};

    if (interaction.isStreaming && resp.sseEvents?.length) {
      let current = null;
      for (const event of resp.sseEvents) {
        if (event.eventType === 'content_block_start' && event.data?.content_block?.type === 'tool_use') {
          const cb = event.data.content_block;
          current = {
            blockIndex: event.data.index,
            id: cb.id || '',
            name: cb.name || '',
            inputJson: '',
            input: null,
            status: 'streaming',
          };
          calls.push(current);
        } else if (event.eventType === 'content_block_delta' && event.data?.delta?.type === 'input_json_delta') {
          const match = calls.find(c => c.blockIndex === event.data.index);
          if (match) match.inputJson += event.data.delta.partial_json || '';
        } else if (event.eventType === 'content_block_stop') {
          const match = calls.find(c => c.blockIndex === event.data?.index);
          if (match) {
            match.status = 'complete';
            try { match.input = JSON.parse(match.inputJson); } catch {}
          }
        }
      }
      return calls;
    }

    if (resp.body?.content) {
      for (const block of resp.body.content) {
        if (block.type === 'tool_use') {
          calls.push({
            blockIndex: null,
            id: block.id || '',
            name: block.name || '',
            inputJson: JSON.stringify(block.input || {}),
            input: block.input || {},
            status: 'complete',
          });
        }
      }
    }

    return calls;
  }

  function findToolResult(toolUseId) {
    for (const interaction of state.interactions) {
      const msgs = interaction.request?.messages;
      if (!msgs) continue;
      for (const msg of msgs) {
        if (msg.role !== 'user') continue;
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id === toolUseId) {
            return block;
          }
        }
      }
    }
    return null;
  }

  function isNewUserTurn(interaction) {
    if ((interaction.endpoint || '/v1/messages') !== '/v1/messages') return false;
    const req = interaction.request;
    if (req?._lastMessage) {
      return req._lastMessage.role === 'user' && req._lastMessage.hasText;
    }
    const msgs = req?.messages;
    if (!msgs || msgs.length === 0) return false;
    const last = msgs[msgs.length - 1];
    if (last.role !== 'user') return false;
    const content = Array.isArray(last.content) ? last.content : [];
    if (content.length === 0) return typeof last.content === 'string';
    return content[content.length - 1]?.type === 'text';
  }

  function toolSummary(name, input) {
    if (!input) return '';
    if (name === 'Skill') return input.args || '';
    if (input.file_path) return input.file_path;
    if (input.command) return input.command;
    if (input.pattern) return input.pattern;
    if (input.query) return input.query;
    if (input.url) return input.url;
    if (input.content) return typeof input.content === 'string' ? input.content : '';
    for (const v of Object.values(input)) {
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return '';
  }

  // --- SSE event handling ---
  function handleSSEEvent(interactionId, event) {
    const interaction = state.interactions.find(i => i.id === interactionId);
    if (!interaction) return;

    if (!interaction.response) interaction.response = { sseEvents: [] };
    if (!interaction.response.sseEvents) interaction.response.sseEvents = [];
    interaction.response.sseEvents.push(event);

    // Maintain running response char counter for live gauge
    const _evtChars = JSON.stringify(event.data || '').length;
    interaction._respChars = (interaction._respChars || 0) + _evtChars;

    if (event.eventType === 'message_start' && event.data?.message?.usage) {
      interaction.usage = { ...event.data.message.usage };
      updateTurnTokens(interaction);
    }
    if (event.eventType === 'message_delta' && event.data?.usage) {
      interaction.usage = { ...interaction.usage, ...event.data.usage };
      updateTurnTokens(interaction);
    }
    if (event.eventType === 'message_start') {
      interaction.status = 'streaming';
      updateTurnBadge(interactionId, 'streaming');
    }
    if (event.eventType === 'message_stop') {
      interaction.status = 'complete';
      updateTurnBadge(interactionId, 'complete');
    }

    if (event.eventType === 'content_block_start' && event.data?.content_block?.type === 'tool_use') {
      const cb = event.data.content_block;
      const toolCalls = extractToolCalls(interaction);
      const toolIdx = toolCalls.length - 1;
      appendToolToTimeline(interactionId, toolIdx, cb.name, '');
    }
    if (event.eventType === 'content_block_stop') {
      const toolCalls = extractToolCalls(interaction);
      const match = toolCalls.find(c => c.blockIndex === event.data?.index);
      if (match) {
        const toolIdx = toolCalls.indexOf(match);
        const summaryEl = document.querySelector(`[data-tool-summary="${interactionId}-${toolIdx}"]`);
        if (summaryEl) summaryEl.textContent = toolSummary(match.name, match.input);
        if (match.name === 'Skill' && match.input?.skill) {
          const nameEl = document.querySelector(`[data-tool-name="${interactionId}-${toolIdx}"]`);
          if (nameEl) nameEl.textContent = `/${match.input.skill}`;
          const toolEl = document.querySelector(`[data-tool-id="${interactionId}-${toolIdx}"]`);
          if (toolEl && !toolEl.classList.contains('skill-call')) {
            toolEl.classList.add('skill-call');
            if (nameEl) {
              const tag = document.createElement('span');
              tag.className = 'tool-entry-tag tag-sk';
              tag.textContent = 'skill';
              nameEl.after(tag);
            }
          }
        }
      }
    }

    // Route SSE to detail panel
    const sel = state.selection;
    if (_splitMode && _splitInteractions.has(interactionId)) {
      appendSSEToDetail(event, interaction);
    } else if (_splitMode && _liveMode && event.eventType === 'message_start'
               && (interaction.status === 'streaming' || interaction.status === 'pending')
               && !interaction.isHook && !interaction.isMcp
               && interaction.instanceId === _splitGroupInstance()) {
      // A new parallel streamer began after split mode was already active —
      // give it its own pane so all concurrent interactions stay visible.
      addSplitPane(interaction);
      appendSSEToDetail(event, interaction);
    } else if (sel?.type === 'turn' && sel.id === interactionId) {
      if (event.eventType === 'message_start' && !_splitMode && _liveMode) {
        _trySplitMode(interactionId);
      }
      if (_splitMode && _splitInteractions.has(interactionId)) {
        appendSSEToDetail(event, interaction);
      } else {
        appendSSEToDetail(event, interaction);
      }
    } else if (_liveMode && !_splitMode && event.eventType === 'message_start'
               && (interaction.status === 'streaming' || interaction.status === 'pending')
               && (activeInstanceTab === 'all' || interaction.instanceId === activeInstanceTab)) {
      if (_trySplitMode(interactionId)) {
        appendSSEToDetail(event, interaction);
      }
    }

    if (event.eventType === 'message_stop' && _splitMode && _splitInteractions.has(interactionId)) {
      _removeSplitPane(interactionId);
    }
  }

  function _getStreamState(interactionId) {
    if (_splitMode && interactionId) {
      const pane = _splitPanes.get(interactionId);
      if (pane) return pane.streamState;
    }
    return { blockMap: _streamBlockMap, thinkingTokens: _streamThinkingTokens,
             lastTextBody: () => _lastStreamTextBodyEl, setLastTextBody: v => { _lastStreamTextBodyEl = v; },
             pendingMd: () => _pendingMarkdownBodyEl, setPendingMd: v => { _pendingMarkdownBodyEl = v; } };
  }

  function _scopeFind(scope, id) {
    if (scope && scope !== document) return scope.querySelector(`#${CSS.escape(id)}`);
    return document.getElementById(id);
  }

  // Sticky bottom: follow the stream only while the reader is already at the
  // bottom. Scrolling up to read something, or selecting text to copy it,
  // pauses the follow until they scroll back down.
  const FOLLOW_SLACK_PX = 48;

  function _stickToBottom(el) {
    if (!el) return;
    if (_selectionInside(el)) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance > FOLLOW_SLACK_PX) return;
    el.scrollTop = el.scrollHeight;
  }

  // Keep the streaming response in view. Blocks now flow at natural height
  // inside the scrollable response panel, so we follow at the panel level.
  function _followResponse(scope) {
    if (!_liveMode) return;
    const root = scope && scope !== document ? scope : document;
    // In the .vc-detail frame the pane body has overflow:hidden and each open
    // section scrolls itself, so follow the section holding #response-blocks.
    const blocks = _scopeFind(scope, 'response-blocks');
    const panel = blocks?.closest('.vc-sec-body')
      || root.querySelector('.response-panel')
      || blocks;
    _stickToBottom(panel);
  }

  function appendSSEToDetail(event, interaction, scope) {
    const { eventType, data } = event;
    scope = scope || (_splitMode && _splitPanes.has(interaction.id) ? _splitPanes.get(interaction.id).pane : null) || document;
    // Once a turn has streamed into the panel, #response-blocks and #raw-sse-pre
    // are ours — patchTurnDetail must not rebuild them from the buffer.
    if (scope === document && _detailView?.id === interaction.id) _detailView.streamed = true;
    const ss = _getStreamState(interaction.id);
    const blockMap = ss.blockMap;
    const thinkingTokens = ss.thinkingTokens;

    if (eventType === 'message_start') {
      const statusVal = _scopeFind(scope, 'resp-status');
      if (statusVal) { statusVal.textContent = '200'; statusVal.className = 'info-value status-ok'; }
      const statusChip = _scopeFind(scope, 'resp-status-chip');
      if (statusChip) { statusChip.textContent = '200'; statusChip.className = 'status-ok'; }
      if (data?.message?.usage) {
        if (scope === document) updateUsageDisplay(data.message.usage, interaction.pricing);
      }
      blockMap.clear();
      thinkingTokens.clear();
      ss.setLastTextBody(null);
      ss.setPendingMd(null);
    }

    if (eventType === 'content_block_start') {
      const block = data?.content_block;
      if (!block) return;
      const container = _scopeFind(scope, 'response-blocks');
      if (!container) return;
      _followResponse(scope);

      if (block.type !== 'text') {
        _flushPendingMarkdownFor(ss);
        ss.setLastTextBody(null);
      }

      if (block.type === 'text' && ss.lastTextBody()) {
        blockMap.set(data.index, { bodyEl: ss.lastTextBody(), needsSeparator: true });
        return;
      }

      if (block.type === 'text') {
        const body = document.createElement('div');
        body.className = 'content-block-body';
        body.id = `block-body-${data.index}`;
        ss.setLastTextBody(body);
        blockMap.set(data.index, { bodyEl: body, needsSeparator: false });
        container.appendChild(body);
      } else if (block.type === 'tool_use') {
        const body = document.createElement('div');
        body.className = 'content-block-body tool-use';
        body.id = `block-body-${data.index}`;
        body.dataset.toolName = block.name || '';
        body.innerHTML = `<div class="tool-name" data-tool-summary=""><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5L8 6L4.5 9.5"/></svg>${escHtml(block.name || '')}</div><div class="json-block jt-root" id="tool-input-${data.index}"></div>`;
        container.appendChild(body);
      } else {
        const blockEl = document.createElement('div');
        blockEl.className = 'content-block';
        blockEl.id = `block-${data.index}`;

        const header = document.createElement('div');
        header.className = 'content-block-header';
        header.id = `block-header-${data.index}`;
        header.textContent = block.type === 'thinking' ? 'Thinking' : block.type;

        const body = document.createElement('div');
        body.className = 'content-block-body';
        body.id = `block-body-${data.index}`;
        if (block.type === 'thinking') body.classList.add('thinking');

        blockEl.appendChild(header);
        blockEl.appendChild(body);
        container.appendChild(blockEl);
      }
    }

    if (eventType === 'content_block_delta') {
      const delta = data?.delta;
      if (!delta) return;

      if (delta.type === 'thinking_delta') {
        const bodyEl = _scopeFind(scope, `block-body-${data.index}`);
        if (!bodyEl) return;
        bodyEl.appendChild(document.createTextNode(delta.thinking || ''));
        if (_liveMode) { _stickToBottom(bodyEl); _followResponse(scope); }
        if (delta.estimated_tokens) {
          const total = (thinkingTokens.get(data.index) || 0) + delta.estimated_tokens;
          thinkingTokens.set(data.index, total);
          const headerEl = _scopeFind(scope, `block-header-${data.index}`);
          if (headerEl) {
            const fmt = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
            headerEl.innerHTML = `Thinking <span class="thinking-tokens">${fmt(total)} tokens</span>`;
          }
        }
      } else if (delta.type === 'text_delta') {
        const entry = blockMap.get(data.index);
        const bodyEl = entry?.bodyEl || _scopeFind(scope, `block-body-${data.index}`);
        if (!bodyEl) return;
        if (entry?.needsSeparator) {
          bodyEl._rawText = (bodyEl._rawText || '') + '\n';
          entry.needsSeparator = false;
        }
        bodyEl._rawText = (bodyEl._rawText || '') + (delta.text || '');
        bodyEl.classList.add('markdown-body');
        // Re-parsing replaces the block's innerHTML, so hold off while the user
        // is selecting inside it — _rawText keeps accumulating and the deferred
        // flush renders the lot once the selection collapses.
        if (_selectionInside(bodyEl)) {
          cancelRenderDebounce(bodyEl);
          _deferredMarkdown.add(bodyEl);
        } else {
          _deferredMarkdown.delete(bodyEl);
          renderMarkdownDebounced(bodyEl._rawText, bodyEl);
        }
        if (_liveMode) { _stickToBottom(bodyEl); _followResponse(scope); }
      } else if (delta.type === 'input_json_delta') {
        const inputEl = _scopeFind(scope, `tool-input-${data.index}`);
        if (inputEl) inputEl.appendChild(document.createTextNode(delta.partial_json || ''));
      }
    }

    if (eventType === 'content_block_stop') {
      const inputEl = _scopeFind(scope, `tool-input-${data.index}`);
      if (inputEl) {
        try {
          const parsed = JSON.parse(inputEl.textContent);
          inputEl.innerHTML = renderJSON(parsed);
          const toolBody = inputEl.closest('.content-block-body.tool-use');
          const nameEl = toolBody?.querySelector('.tool-name');
          if (nameEl) nameEl.dataset.toolSummary = truncate(toolSummary(toolBody.dataset.toolName, parsed), 120);
        } catch {}
      }
      const entry = blockMap.get(data.index);
      const bodyEl = entry?.bodyEl || _scopeFind(scope, `block-body-${data.index}`);
      if (bodyEl && !bodyEl.classList.contains('tool-use') && !bodyEl.classList.contains('thinking')) {
        cancelRenderDebounce(bodyEl);
        const rawText = bodyEl._rawText || bodyEl.textContent;
        if (rawText) {
          bodyEl.classList.add('markdown-body');
          bodyEl._rawText = rawText;
          if (_selectionInside(bodyEl)) _deferredMarkdown.add(bodyEl);
          else renderMarkdown(rawText, bodyEl);
        }
        ss.setPendingMd(bodyEl);
      }
    }

    if (eventType === 'message_delta') {
      if (data?.usage) {
        interaction.usage = { ...interaction.usage, ...data.usage };
        if (scope === document) updateUsageDisplay(interaction.usage, interaction.pricing);
        updateTurnTokens(interaction);
      }
      if (interaction.timing) {
        interaction.timing.duration = Date.now() - interaction.timing.startedAt;
        const durationEl = _scopeFind(scope, 'resp-duration');
        if (durationEl) durationEl.textContent = formatDuration(interaction.timing.duration);
      }
    }

    if (eventType === 'message_stop') {
      _flushPendingMarkdownFor(ss);
      ss.setLastTextBody(null);
      if (interaction.timing) {
        const durationEl = _scopeFind(scope, 'resp-duration');
        if (durationEl) durationEl.textContent = formatDuration(interaction.timing.duration);
      }
      updateTurnBadge(interaction.id, 'complete');
      updateStats();
    }

    const _gaugeEl = _scopeFind(scope, 'resp-char-gauge');
    if (_gaugeEl && interaction._respChars) {
      _gaugeEl.innerHTML = charGauge(interaction._respChars);
    }

    const _sseDetails = _scopeFind(scope, 'raw-sse-details');
    if (_sseDetails) {
      _sseDetails.hidden = false;
      const _sseCount = _scopeFind(scope, 'raw-sse-count');
      if (_sseCount) _sseCount.textContent = interaction.response.sseEvents.length;
      const _sseChip = _scopeFind(scope, 'sse-chip-count');
      if (_sseChip) {
        _sseChip.textContent = interaction.response.sseEvents.length;
        _sseChip.closest('.vc-chip')?.classList.remove('is-empty');
      }
      const _ssePre = _scopeFind(scope, 'raw-sse-pre');
      if (_ssePre) {
        const _evtHtml = `<span class="json-key">event:</span> ${escHtml(event.eventType)}\n<span class="json-string">data:</span> ${escHtml(typeof event.data === 'string' ? event.data : JSON.stringify(event.data))}\n`;
        _ssePre.insertAdjacentHTML('beforeend', '\n' + _evtHtml);
      }
    }
  }

  function _flushPendingMarkdownFor(ss) {
    const el = ss.pendingMd();
    if (el) {
      cancelRenderDebounce(el);
      const rawText = el._rawText || el.textContent;
      if (rawText) {
        el.classList.add('markdown-body');
        el._rawText = rawText;
        if (_selectionInside(el)) _deferredMarkdown.add(el);
        else renderMarkdown(rawText, el);
      }
      ss.setPendingMd(null);
    }
  }

  // --- Split mode: parallel streaming detail panes ---

  function _splitGroupInstance() {
    for (const id of _splitInteractions) {
      const i = state.interactions.find(x => x.id === id);
      if (i) return i.instanceId;
    }
    return undefined;
  }

  function _findParallelStreamers(interactionId) {
    const source = state.interactions.find(i => i.id === interactionId);
    const sourceInstance = source?.instanceId;
    return state.interactions.filter(i =>
      i.id !== interactionId
      && (i.status === 'streaming' || i.status === 'pending')
      && !i.isHook && !i.isMcp
      && i.instanceId === sourceInstance
    );
  }

  function _makePaneStreamState() {
    const st = {
      blockMap: new Map(),
      thinkingTokens: new Map(),
      _lastTextBody: null,
      _pendingMd: null,
      lastTextBody: () => st._lastTextBody,
      setLastTextBody: v => { st._lastTextBody = v; },
      pendingMd: () => st._pendingMd,
      setPendingMd: v => { st._pendingMd = v; },
    };
    return st;
  }

  function _renderSplitPaneContent(interaction) {
    const req = interaction.request || {};
    const resp = interaction.response || {};
    const timing = interaction.timing || {};
    const model = req.model || 'unknown';
    const shortModel = model.replace('claude-', '').split('-202')[0];
    const statusOk = resp.status >= 200 && resp.status < 300;
    const respChars = interaction._respChars || 0;

    let html = '';
    html += `<div class="detail-panel response-panel">`;
    html += `<div class="section-title">Response <span id="resp-char-gauge">${respChars ? charGauge(respChars) : ''}</span></div>`;
    html += `<div class="info-grid">
      <span class="info-label">Status</span><span class="info-value ${statusOk ? 'status-ok' : 'status-err'}" id="resp-status">${resp.status || '--'}</span>
      <span class="info-label">TTFB</span><span class="info-value" id="resp-ttfb">${timing.ttfb ? formatDuration(timing.ttfb) : '--'}</span>
      <span class="info-label">Duration</span><span class="info-value" id="resp-duration">${timing.duration ? formatDuration(timing.duration) : '--'}</span>
    </div>`;
    html += `<div id="response-blocks"></div>`;
    html += `</div>`;
    return html;
  }

  function _buildSplitPane(interaction) {
    const pane = document.createElement('div');
    pane.className = 'detail-split-pane';
    pane.dataset.splitId = interaction.id;

    const sa = interaction.subagent;
    const label = sa ? (getSubagentLabel(sa) || sa.agentType || 'Agent') : 'Main Thread';
    const color = sa?.agentId ? getSubagentColor(sa) : 'var(--accent)';
    const model = (interaction.request?.model || 'unknown').replace('claude-', '').split('-202')[0];

    const header = document.createElement('div');
    header.className = 'split-pane-header';
    header.style.borderBottomColor = color;
    header.style.color = color;
    header.innerHTML = `${escHtml(label)} <span style="color:var(--text-dim);font-weight:400">${escHtml(model)}</span>`;
    pane.appendChild(header);

    const content = document.createElement('div');
    content.innerHTML = _renderSplitPaneContent(interaction);
    pane.appendChild(content);

    return pane;
  }

  function enterSplitMode(interactions) {
    _splitMode = true;
    _splitPanes.clear();
    _splitInteractions.clear();

    emptyState.classList.add('hidden');
    detailContent.classList.remove('hidden');
    detailContent.classList.add('split-active');
    detailContent.innerHTML = '';

    for (const interaction of interactions) {
      _splitInteractions.add(interaction.id);
      const pane = _buildSplitPane(interaction);
      const streamState = _makePaneStreamState();
      _splitPanes.set(interaction.id, { pane, streamState });
      detailContent.appendChild(pane);

      if (interaction.response?.sseEvents?.length > 0) {
        for (const evt of interaction.response.sseEvents) {
          appendSSEToDetail(evt, interaction, pane);
        }
      }
    }
  }

  function addSplitPane(interaction) {
    if (_splitInteractions.has(interaction.id)) return;
    _splitInteractions.add(interaction.id);
    const pane = _buildSplitPane(interaction);
    const streamState = _makePaneStreamState();
    _splitPanes.set(interaction.id, { pane, streamState });
    detailContent.appendChild(pane);

    if (interaction.response?.sseEvents?.length > 0) {
      for (const evt of interaction.response.sseEvents) {
        appendSSEToDetail(evt, interaction, pane);
      }
    }
  }

  function exitSplitMode() {
    _splitMode = false;
    _splitPanes.clear();
    _splitInteractions.clear();
    detailContent.classList.remove('split-active');
  }

  function _removeSplitPane(interactionId) {
    if (!_splitMode || !_splitInteractions.has(interactionId)) return;
    const entry = _splitPanes.get(interactionId);
    if (!entry) return;

    entry.pane.classList.add('split-pane-collapsing');
    setTimeout(() => {
      if (entry.pane.parentNode) entry.pane.remove();
      _splitPanes.delete(interactionId);
      _splitInteractions.delete(interactionId);

      if (_splitInteractions.size <= 1) {
        const remainingId = _splitInteractions.values().next().value;
        exitSplitMode();
        if (remainingId) {
          select({ type: 'turn', id: remainingId });
        }
      }
    }, 300);
  }

  function _trySplitMode(interactionId) {
    const parallel = _findParallelStreamers(interactionId);
    if (parallel.length === 0) return false;

    const current = state.interactions.find(i => i.id === interactionId);
    if (!current) return false;

    const allStreamers = [current, ...parallel];
    if (_splitMode) {
      for (const i of allStreamers) {
        if (!_splitInteractions.has(i.id)) addSplitPane(i);
      }
    } else {
      enterSplitMode(allStreamers);
    }
    return true;
  }

  // --- Focus mode ---

  function enterFocusMode() {
    _focusMode = true;
    const body = document.querySelector('.inspector-body');
    if (body) body.classList.add('focus-active');
    const btn = document.getElementById('detail-focus-btn');
    if (btn) {
      btn.classList.add('focus-active');
      btn.title = 'Exit focus mode (Esc)';
    }
  }

  function exitFocusMode() {
    _focusMode = false;
    const body = document.querySelector('.inspector-body');
    if (body) body.classList.remove('focus-active');
    const btn = document.getElementById('detail-focus-btn');
    if (btn) {
      btn.classList.remove('focus-active');
      btn.title = 'Toggle focus mode (F)';
    }
  }

  function toggleFocusMode() {
    if (_focusMode) exitFocusMode();
    else enterFocusMode();
  }

  // --- Interaction update ---
  function updateInteraction(updated) {
    const idx = state.interactions.findIndex(i => i.id === updated.id);
    if (idx >= 0) {
      const localEvents = state.interactions[idx].response?.sseEvents || [];
      const localInstanceId = state.interactions[idx].instanceId;
      const localSubagent = state.interactions[idx].subagent;
      // Client-side running counter behind the response char gauge — the server
      // doesn't send it, so a wholesale replace would reset the gauge to zero.
      const localRespChars = state.interactions[idx]._respChars;
      state.interactions[idx] = { ...updated, response: { ...updated.response, sseEvents: localEvents } };
      if (localRespChars) state.interactions[idx]._respChars = localRespChars;
      // Preserve locally-stamped ext instanceId (server sends null for external sessions)
      if (!updated.instanceId && localInstanceId) {
        state.interactions[idx].instanceId = localInstanceId;
      }
      if (localSubagent && !state.interactions[idx].subagent) {
        state.interactions[idx].subagent = localSubagent;
      }
    }

    updateTurnBadge(updated.id, updated.status || 'complete');
    updateTurnMeta(updated);
    updateTurnTokens(state.interactions[idx] || updated);
    rebuildToolEntries(updated.id);
    updateStats();

    const sel = state.selection;
    if (sel?.type === 'turn' && sel.id === updated.id) {
      refreshDetailIfShowing(state.interactions[idx] || updated);
    }

    const uStatus = updated.status || 'complete';
    if ((uStatus === 'complete' || uStatus === 'error') && _splitMode && _splitInteractions.has(updated.id)) {
      _removeSplitPane(updated.id);
    }
  }

  function markInteractionError(id, error) {
    const interaction = state.interactions.find(i => i.id === id);
    if (interaction) {
      interaction.status = 'error';
      interaction.response = interaction.response || {};
      interaction.response.error = error;
    }
    updateTurnBadge(id, 'error');
    if (interaction) refreshDetailIfShowing(interaction);
    if (_splitMode && _splitInteractions.has(id)) {
      _removeSplitPane(id);
    }
  }

  // ============================================================
  // TIMELINE RENDERING
  // ============================================================

  function isStandardLlm(interaction) {
    if (!interaction.endpoint || interaction.endpoint === '/v1/messages') return true;
    if (interaction.translatedFrom) return true;
    return false;
  }

  // Did this request actually come back with an assistant message? A 429 or a
  // dropped connection is still recorded as an interaction, but no turn ever
  // happened, so it must not consume a turn number — otherwise the count jumps
  // and every turn after a rate-limited retry disagrees with the transcript.
  function hasAssistantMessage(interaction) {
    const resp = interaction.response || {};
    if (resp.sseEvents?.length) {
      for (const event of resp.sseEvents) {
        if (event.eventType === 'message_start') return true;
      }
    }
    const body = resp.body;
    if (!body) return false;
    return body.role === 'assistant' || Array.isArray(body.content);
  }

  // null when this interaction never produced a turn of its own, so callers
  // render no number rather than borrowing the previous turn's.
  function llmTurnNumber(interaction) {
    if (!isStandardLlm(interaction) || !hasAssistantMessage(interaction)) return null;
    let n = 0;
    for (const i of state.interactions) {
      if (!i.isMcp && !i.isHook && isStandardLlm(i) && hasAssistantMessage(i)) n++;
      if (i === interaction) return n;
    }
    return n;
  }

  let _lastRenderedAgentId = null;

  // --- Timeline view mode toggle (single column vs parallel columns) ---
  let _timelineMode = 'parallel';

  let _allHistoryLoaded = false;

  function initTimelineToggle() {
    const header = document.getElementById('timeline-header');
    if (!header || header.querySelector('.timeline-view-toggle')) return;
    const toggle = document.createElement('div');
    toggle.className = 'timeline-view-toggle';

    const allSvg = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 2h8v8H2z"/><line x1="2" y1="5" x2="10" y2="5"/><line x1="2" y1="8" x2="10" y2="8"/></svg>`;

    const liveOnSvg = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,6.5 5,9.5 10,3"/></svg>`;
    const liveOffSvg = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="3" y1="3" x2="9" y2="9"/><line x1="9" y1="3" x2="3" y2="9"/></svg>`;
    function liveButtonContent(on) { return (on ? liveOnSvg : liveOffSvg) + `<span class="tl-toggle-label">live</span>`; }

    toggle.innerHTML = `
      <button class="tl-toggle-btn tl-live-btn${_liveMode ? ' active' : ''}" title="${_liveMode ? 'Live mode on' : 'Live mode off'}">${liveButtonContent(_liveMode)}</button>
      <button class="tl-toggle-btn tl-load-all-btn${_allHistoryLoaded ? ' active' : ''}" title="Load full history from disk">${allSvg}</button>
    `;
    const liveBtn = toggle.querySelector('.tl-live-btn');
    liveBtn.addEventListener('click', () => {
      _liveMode = !_liveMode;
      localStorage.setItem('timelineLive', _liveMode);
      liveBtn.classList.toggle('active', _liveMode);
      liveBtn.innerHTML = liveButtonContent(_liveMode);
      liveBtn.title = _liveMode ? 'Live mode on' : 'Live mode off';
      if (_liveMode) selectLastAndFollow();
    });
    toggle.querySelector('.tl-load-all-btn').addEventListener('click', (e) => {
      if (_allHistoryLoaded) return;
      e.currentTarget.style.opacity = '0.5';
      sendWs({ type: 'inspector:loadAll' });
    });
    header.appendChild(toggle);
    const aside = document.getElementById('timeline');
    if (aside) aside.classList.add('parallel-mode');
  }

  function renderTimelineActive() {
    renderTimelineParallel();
  }

  // === D3 PARALLEL TIMELINE (multi-column swimlane with SVG connectors) ===

  let _d3State = null; // persisted between incremental appends; reset on full re-render
  let _flowAnimations = new Map(); // agentId -> animFrameId
  let _inflightSet = new Set(); // interaction IDs currently shown as footer badges
  let _inflightTimers = new Map(); // id -> intervalId for elapsed counter

  // --- Wide layout module (from wide-layout.js) ---
  const wl = window.wideLayout;
  wl.init({ extractToolCalls, isStandardLlm });
  const D3_CONST = wl.D3_CONST;
  // Add rendering-only constants not in the layout module
  D3_CONST.NODE_BORDER_RADIUS = 6;
  D3_CONST.TICK_INTERVAL = 10000;

  // --- Build node HTML elements (reusing existing patterns) ---

  // --- Turn node header -------------------------------------------------
  // Two lines, FIXED at 44px (see .turn-entry in style.css). This height is a
  // contract with wide-layout's MIN_ENTRY_HEIGHT: the parallel view positions
  // tool rows at y + MIN_ENTRY_HEIGHT + i * TOOL_HEIGHT, so a header that
  // renders taller than it budgets pushes tool rows out of their own node and
  // under the next one. Add data here, never a third line.
  //   line 1  #123  opus-5  [chips]        <duration gauge>  <state lamp>
  //   line 2  in/out/cache tokens                            <cost gauge>
  function turnHeaderHtml(interaction, turnNum, isSubagentTurn, opts) {
    const o = opts || {};
    const statusClass = badgeClass(interaction.status);
    const status = interaction.status || 'pending';
    const model = interaction.request?.model || 'unknown';
    const shortModel = model.replace('claude-', '').split('-202')[0];
    const durationHtml = interaction.timing?.duration ? durationGauge(interaction.timing.duration) : '--';
    const turnLabel = turnNum != null ? `${isSubagentTurn ? '#S' : '#'}${turnNum}` : '';
    const stepChip = interaction.stepId
      ? `<span class="entry-step">${escHtml(interaction.stepId)}</span>` : '';

    const subagentLabel = interaction.subagent ? getSubagentLabel(interaction.subagent) : '';
    const subagentColor = interaction.subagent?.agentId ? getSubagentColor(interaction.subagent) : '';
    const subagentTag = (interaction.subagent && (interaction.subagent.agentType || interaction.subagent.agentId || interaction.subagent.description))
      ? `<span class="entry-subagent" title="${escHtml(interaction.subagent.description || '')}"${subagentColor ? ` style="color:${subagentColor};background:color-mix(in srgb, ${subagentColor} 12%, transparent)"` : ''}>${escHtml(subagentLabel)}</span>`
      : '';

    const cost = computeCost(interaction.usage, interaction.pricing);

    return `
      <div class="entry-header entry-idrow">
        <span class="entry-num">${turnLabel}</span>
        <span class="entry-model" data-model="${interaction.id}"><span class="entry-model-label" title="${escHtml(model)}">${escHtml(shortModel)}</span></span>
        ${stepChip}${subagentTag}${o.instanceTag || ''}
        <span class="entry-duration" data-duration="${interaction.id}">${durationHtml}</span>
        <span class="entry-badge ${statusClass}" data-badge="${interaction.id}">${status}</span>
      </div>
      <div class="entry-meta" data-tokens="${interaction.id}">
        <span class="entry-tokens" data-tokenlabel="${interaction.id}">${compactTokens(interaction.usage)}</span>
        <span class="entry-cost" data-costgauge="${interaction.id}">${turnCostGauge(cost)}</span>
      </div>
    `;
  }

  function buildD3TurnEl(interaction, turnNum, isSubagentTurn) {
    const stdLlm = isStandardLlm(interaction);

    if (!stdLlm) {
      const group = document.createElement('div');
      group.className = `turn-group endpoint-call-group status-${interaction.status || 'pending'}`;
      group.dataset.turnId = interaction.id;

      const el = document.createElement('div');
      el.className = 'timeline-entry turn-entry endpoint-call-entry';
      el.dataset.id = interaction.id;

      const ep = interaction.endpoint.replace('/v1/messages/', '');
      const statusClass = badgeClass(interaction.status);
      el.innerHTML = `
        <span class="endpoint-label" title="${escHtml(ep)}">${escHtml(ep)}</span>
        <span class="entry-badge ${statusClass}" data-badge="${interaction.id}">${interaction.status || 'pending'}</span>
        <span class="entry-tokens" data-tokenlabel="${interaction.id}">${compactTokens(interaction.usage)}</span>
      `;

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        select({ type: 'turn', id: interaction.id }, { userClick: true });
      });
      group.appendChild(el);
      return group;
    }

    const group = document.createElement('div');
    let cls = 'turn-group';
    if (isNewUserTurn(interaction)) cls += ' new-user-turn';
    if (interaction.subagent?.isSidechain) cls += ' sidechain-group';
    else if (interaction.subagent?.agentType) cls += ' subagent-group';
    cls += ` status-${interaction.status || 'pending'}`;
    group.className = cls;
    group.dataset.turnId = interaction.id;

    if (interaction.subagent?.agentId) {
      registerSubagent(interaction.subagent);
      group.dataset.agentId = interaction.subagent.agentId;
      group.style.setProperty('--subagent-color', getSubagentColor(interaction.subagent));
    }

    const el = document.createElement('div');
    el.className = 'timeline-entry turn-entry';
    el.dataset.id = interaction.id;

    el.innerHTML = turnHeaderHtml(interaction, turnNum, isSubagentTurn);

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      select({ type: 'turn', id: interaction.id }, { userClick: true });
    });

    group.addEventListener('click', () => {
      select({ type: 'turn', id: interaction.id }, { userClick: true });
    });

    group.appendChild(el);

    const toolsContainer = document.createElement('div');
    toolsContainer.className = 'tool-entries';
    toolsContainer.dataset.toolsFor = interaction.id;
    group.appendChild(toolsContainer);

    const toolCalls = extractToolCalls(interaction);
    toolCalls.forEach((tc, tIdx) => {
      const toolEl = createToolEntryEl(interaction.id, tIdx, tc.name, toolSummary(tc.name, tc.input), tc.input, interaction.subagent);
      toolsContainer.appendChild(toolEl);
    });

    if (interaction._foldedPreHooks) {
      for (const hookInt of interaction._foldedPreHooks) {
        const hookEl = document.createElement('div');
        hookEl.className = 'timeline-entry tool-entry hook-tool-entry';
        hookEl.dataset.id = hookInt.id;
        const subagent = findHookSubagent(hookInt);
        const agentLabel = subagent ? getSubagentLabel(subagent) : '';
        const agentColor = subagent?.agentId ? getSubagentColor(subagent) : '';
        const agentTag = subagent?.agentType
          ? `<span class="tool-entry-tag tag-agent"${agentColor ? ` style="color:${agentColor};background:color-mix(in srgb, ${agentColor} 10%, transparent);border-color:color-mix(in srgb, ${agentColor} 20%, transparent)"` : ''}>${escHtml(agentLabel)}</span>` : '';
        hookEl.innerHTML = `
          <span class="tool-connector hook-connector"></span>
          <span class="hook-arrow">&rarr;</span>
          <span class="tool-entry-name hook-entry-name">${escHtml(hookInt.hookEvent || 'PreToolUse')}</span>
          <span class="tool-entry-tag tag-hook">hook</span>
          ${agentTag}
          <span class="tool-entry-summary" title="${escHtml(hookInt.toolName || '')}">${escHtml(hookInt.toolName || '')}</span>
        `;
        hookEl.addEventListener('click', (e) => {
          e.stopPropagation();
          select({ type: 'turn', id: hookInt.id }, { userClick: true });
        });
        toolsContainer.appendChild(hookEl);
      }
    }

    if (interaction._clampedHooks) {
      const clamped = interaction._clampedHooks;
      const hookCount = clamped.filter(c => c.isHook).length;
      const otherCount = clamped.length - hookCount;
      const summaryLabel = otherCount === 0
        ? `${clamped.length} hooks`
        : hookCount === 0
          ? `${clamped.length} items`
          : `${hookCount} hooks + ${otherCount}`;

      function buildClampedEntryEl(entry) {
        const el = document.createElement('div');
        el.dataset.id = entry.id;
        if (entry.isHook) {
          el.className = 'timeline-entry tool-entry clamped-hook-entry';
          const arrow = /Stop|End$|Remove|Completed|PostToolBatch/i.test(entry.hookEvent) ? '◼' : '▸';
          el.innerHTML = `
            <span class="tool-connector hook-connector"></span>
            <span class="hook-arrow">${arrow}</span>
            <span class="tool-entry-name hook-entry-name">${escHtml(entry.hookEvent || 'Hook')}</span>
            <span class="tool-entry-summary" title="${escHtml(entry.toolName || '')}">${escHtml(entry.toolName || '')}</span>
          `;
        } else {
          el.className = 'timeline-entry tool-entry clamped-hook-entry clamped-endpoint-entry';
          const ep = (entry.endpoint || '').replace('/v1/messages/', '');
          el.innerHTML = `
            <span class="tool-connector hook-connector"></span>
            <span class="endpoint-label" title="${escHtml(ep)}">${escHtml(ep)}</span>
            <span class="entry-tokens" data-tokenlabel="${entry.id}">${compactTokens(entry.usage)}</span>
          `;
        }
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          select({ type: 'turn', id: entry.id }, { userClick: true });
        });
        return el;
      }

      if (clamped.length > 1) {
        const clampGroup = document.createElement('div');
        clampGroup.className = 'clamped-hooks-group collapsed';

        const summaryEl = document.createElement('div');
        summaryEl.className = 'timeline-entry tool-entry clamped-hooks-summary';
        summaryEl.innerHTML = `
          <span class="tool-connector hook-connector"></span>
          <span class="hook-arrow clamped-chevron">▸</span>
          <span class="hook-entry-name">${summaryLabel}</span>
        `;
        summaryEl.addEventListener('click', (e) => {
          e.stopPropagation();
          const wasCollapsed = clampGroup.classList.contains('collapsed');
          clampGroup.classList.toggle('collapsed');
          const groupEl = summaryEl.closest('.turn-group');
          if (groupEl) {
            // collapsed shows the summary row alone; expanded shows the
            // summary row plus one row per entry
            const delta = clamped.length * 24;
            const h = parseFloat(groupEl.style.height) || 0;
            groupEl.style.height = (wasCollapsed ? h + delta : h - delta) + 'px';
          }
        });
        clampGroup.appendChild(summaryEl);

        for (const entry of clamped) clampGroup.appendChild(buildClampedEntryEl(entry));
        toolsContainer.appendChild(clampGroup);
      } else {
        for (const entry of clamped) toolsContainer.appendChild(buildClampedEntryEl(entry));
      }
    }

    if (interaction.status === 'pending' || interaction.status === 'streaming') {
      startDurationTimer(interaction);
    }

    return group;
  }

  function buildD3HookEl(interaction) {
    const hookEvent = interaction.hookEvent || 'Hook';
    const toolName = interaction.toolName || '';
    const subType = interaction.subagent?.agentType;
    const isToolHook = /PreToolUse|PostToolUse|PermissionReq|PermissionDen|PostToolBatch|PostToolUseFailure/i.test(hookEvent);
    const isSubagentHook = /SubagentStart|SubagentStop/i.test(hookEvent);
    let nameLabel;
    if (isToolHook) {
      nameLabel = subType ? `${toolName} (${subType})` : toolName;
    } else if (isSubagentHook && subType) {
      nameLabel = subType;
    } else {
      nameLabel = toolName || interaction.subagent?.description || '';
    }
    const arrow = /Stop|End$|Remove|Completed/i.test(hookEvent) ? '◼' : '▸';

    const group = document.createElement('div');
    group.className = `turn-group hook-call-group status-${interaction.status || 'complete'}`;
    group.dataset.turnId = interaction.id;

    const el = document.createElement('div');
    el.className = 'timeline-entry turn-entry hook-call-entry';
    el.dataset.id = interaction.id;

    el.innerHTML = `
      <span class="hook-arrow">${arrow}</span>
      <span class="hook-label">${escHtml(hookEvent)}</span>
      <span class="hook-tool-name" title="${escHtml(nameLabel)}">${escHtml(nameLabel)}</span>
    `;

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      select({ type: 'turn', id: interaction.id }, { userClick: true });
    });

    group.appendChild(el);
    return group;
  }

  function buildD3McpEl(interaction) {
    const group = document.createElement('div');
    group.className = `turn-group mcp-call-group status-${interaction.status || 'complete'}`;
    group.dataset.turnId = interaction.id;

    const el = document.createElement('div');
    el.className = 'timeline-entry turn-entry mcp-call-entry';
    el.dataset.id = interaction.id;

    const toolName = interaction.request?.tool || 'unknown';
    const durationHtml = interaction.timing?.duration ? durationGauge(interaction.timing.duration) : '--';
    const isError = interaction.status === 'error';
    const source = interaction.mcpSource === 'claude-code' ? 'claude' : 'test';

    el.innerHTML = `
      <div class="entry-header">
        <span class="entry-num mcp-label">MCP</span>
        <span class="entry-badge ${isError ? 'error' : 'complete'}">${isError ? 'error' : 'ok'}</span>
      </div>
      <div class="entry-model mcp-tool-name" title="${escHtml(toolName)}">${escHtml(toolName)}</div>
      <div class="entry-meta">
        <span class="mcp-source-tag mcp-src-${source}">${source}</span>
        <span>${durationHtml}</span>
      </div>
    `;

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      select({ type: 'turn', id: interaction.id }, { userClick: true });
    });

    group.appendChild(el);
    return group;
  }

  // --- Time ruler ---

  function formatWallTime(epochMs) {
    const d = new Date(epochMs);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function renderTimeRuler(svg, layout, sessionStart, totalHeight, breaks, elapsedToY) {
    if (layout.length === 0) return;
    breaks = breaks || [];

    const rulerG = svg.select('.tl-time-ruler');
    rulerG.selectAll('*').remove();

    const svgNode = svg.node();
    const svgWidth = (svgNode?.parentElement?.clientWidth || svgNode?.clientWidth || 800);
    const lineX1 = D3_CONST.RULER_WIDTH + 2;
    const axisX = D3_CONST.RULER_WIDTH;
    const minTickGap = 36;
    const breakHalf = 7;

    // Generate tick candidates at fixed 10-second intervals using elapsedToY
    const maxElapsed = layout[layout.length - 1].elapsed;
    const interval = D3_CONST.TICK_INTERVAL;
    const candidates = [];

    // First tick aligned to 10s boundary of wall-clock time
    const startRem = sessionStart % interval;
    const firstOffset = startRem === 0 ? interval : (interval - startRem);
    for (let t = firstOffset; t <= maxElapsed; t += interval) {
      const inGap = breaks.some(br => t > br.elapsedBefore && t < br.elapsedAfter);
      if (inGap) continue;
      const y = elapsedToY ? elapsedToY(t) : (D3_CONST.HEADER_HEIGHT + 8);
      candidates.push({ y, elapsed: t });
    }

    // Add ticks at each interaction's actual start position
    for (const item of layout) {
      if (item.height === 0) continue;
      candidates.push({ y: item.y, elapsed: item.elapsed });
    }

    // Sort by elapsed (guarantees monotonic time), then by Y
    candidates.sort((a, b) => a.elapsed - b.elapsed || a.y - b.y);

    // Deduplicate and ensure monotonic elapsed
    const deduped = [];
    let lastElapsed = -Infinity;
    for (const c of candidates) {
      if (c.elapsed <= lastElapsed) continue;
      deduped.push(c);
      lastElapsed = c.elapsed;
    }

    // Filter out ticks too close in Y-space or near break indicators
    const ticks = [];
    let lastY = -Infinity;
    for (const c of deduped) {
      if (c.y - lastY < minTickGap) continue;
      const nearBreak = breaks.some(br => Math.abs(c.y - br.y) < breakHalf + 8);
      if (nearBreak) continue;
      ticks.push(c);
      lastY = c.y;
    }

    // Draw tick labels and horizontal grid lines
    for (const { y, elapsed } of ticks) {
      const wallMs = sessionStart + elapsed;
      const isMajor = new Date(wallMs).getSeconds() === 0;
      const tickG = rulerG.append('g').attr('class', 'tick' + (isMajor ? ' tick-major' : '')).attr('transform', `translate(0,${y})`);
      tickG.append('line')
        .attr('x1', lineX1)
        .attr('x2', svgWidth);
      tickG.append('text')
        .attr('x', D3_CONST.RULER_WIDTH - 4)
        .attr('y', 0)
        .attr('dy', '0.32em')
        .attr('text-anchor', 'end')
        .text(formatWallTime(wallMs));
    }

    // Draw vertical axis line with break interruptions
    const axisTop = D3_CONST.HEADER_HEIGHT;
    const axisBottom = totalHeight - 20;
    const sortedBreaks = [...breaks].sort((a, b) => a.y - b.y);

    let segStart = axisTop;
    for (const br of sortedBreaks) {
      const brTop = br.y - breakHalf;
      const brBottom = br.y + breakHalf;
      if (brTop > segStart) {
        rulerG.append('line')
          .attr('class', 'axis-line')
          .attr('x1', axisX).attr('x2', axisX)
          .attr('y1', segStart).attr('y2', brTop);
      }
      const zw = 4;
      rulerG.append('path')
        .attr('class', 'axis-break')
        .attr('d', `M${axisX},${brTop} l${zw},${breakHalf * 0.5} l${-zw * 2},${breakHalf} l${zw},${breakHalf * 0.5}`)
        .attr('fill', 'none');
      const cutMs = br.elapsedAfter - br.elapsedBefore;
      const cutSec = Math.round(cutMs / 1000);
      const cutLabel = cutSec >= 60 ? `${Math.floor(cutSec / 60)}m${cutSec % 60 ? ` ${cutSec % 60}s` : ''}` : `${cutSec}s`;
      rulerG.append('text')
        .attr('class', 'axis-break-label')
        .attr('x', axisX - 6)
        .attr('y', br.y)
        .attr('dy', '0.32em')
        .attr('text-anchor', 'end')
        .text(`-${cutLabel}`);
      segStart = brBottom;
    }
    if (segStart < axisBottom) {
      rulerG.append('line')
        .attr('class', 'axis-line')
        .attr('x1', axisX).attr('x2', axisX)
        .attr('y1', segStart).attr('y2', axisBottom);
    }
  }


  function renderConnectors(svgBg, svgFg, connectors, layout, columnAgents, totalColumns, elapsedToY, sessionStart, columnSegments) {
    const gBg = svgBg.select('.tl-connectors');
    gBg.selectAll('*').remove();
    const gFg = svgFg.select('.tl-connectors-fg');
    gFg.selectAll('*').remove();

    let defsFg = svgFg.select('defs');
    if (defsFg.empty()) defsFg = svgFg.append('defs');
    defsFg.selectAll('.connector-marker').remove();

    // Create per-color arrowhead markers so each agent's arrows match its color
    const usedColors = new Set();
    for (const c of connectors) {
      if (c.type === 'fork' || c.type === 'merge') usedColors.add(c.color);
    }
    const colorToMarkerId = new Map();
    let markerIdx = 0;
    for (const color of usedColors) {
      const forkId = `fork-arrow-${markerIdx}`;
      const mergeId = `merge-arrow-${markerIdx}`;
      colorToMarkerId.set(color, { fork: forkId, merge: mergeId });

      defsFg.append('marker')
        .attr('class', 'connector-marker')
        .attr('id', forkId)
        .attr('viewBox', '0 0 10 10')
        .attr('refX', 9).attr('refY', 5)
        .attr('markerWidth', 7).attr('markerHeight', 7)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M1,1 L9,5 L1,9')
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-width', 2)
        .attr('stroke-linejoin', 'round')
        .attr('stroke-linecap', 'round');

      defsFg.append('marker')
        .attr('class', 'connector-marker')
        .attr('id', mergeId)
        .attr('viewBox', '0 0 10 10')
        .attr('refX', 9).attr('refY', 5)
        .attr('markerWidth', 7).attr('markerHeight', 7)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M1,1 L9,5 L1,9')
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-width', 2)
        .attr('stroke-linejoin', 'round')
        .attr('stroke-linecap', 'round');

      markerIdx++;
    }

    for (const c of connectors) {
      if (c.type === 'bgRect') {
        gBg.append('rect')
          .attr('class', 'col-bg-rect' + (c.isStreaming ? ' col-bg-streaming' : ''))
          .attr('data-agent-id', c.agentId || '')
          .attr('x', c.x)
          .attr('y', c.y)
          .attr('width', c.width)
          .attr('height', c.height)
          .attr('rx', 6).attr('ry', 6)
          .attr('fill', c.color)
          .attr('fill-opacity', 0.08)
          .attr('stroke', c.color)
          .attr('stroke-width', 2.5)
          .attr('stroke-opacity', 0.35);
      } else if (c.type === 'fork') {
        const markers = colorToMarkerId.get(c.color);
        gFg.append('path')
          .attr('class', 'connector-path connector-fork')
          .attr('d', c.path)
          .attr('stroke', c.color)
          .attr('stroke-width', c.strokeWidth)
          .attr('stroke-linecap', 'round')
          .attr('stroke-dasharray', c.dashed ? '7,5' : null)
          .attr('fill', 'none')
          .attr('opacity', c.opacity)
          .attr('marker-end', markers ? `url(#${markers.fork})` : null)
          .attr('data-agent-id', c.agentId || '');
      } else if (c.type === 'merge') {
        const markers = colorToMarkerId.get(c.color);
        gFg.append('path')
          .attr('class', 'connector-path connector-merge')
          .attr('d', c.path)
          .attr('stroke', c.color)
          .attr('stroke-width', c.strokeWidth)
          .attr('stroke-linecap', 'round')
          .attr('stroke-dasharray', c.dashed ? '7,5' : null)
          .attr('fill', 'none')
          .attr('opacity', c.opacity)
          .attr('marker-end', markers ? `url(#${markers.merge})` : null)
          .attr('data-agent-id', c.agentId || '');
      } else if (c.type === 'hub-spoke' || c.type === 'merge-trib') {
        gFg.append('path')
          .attr('class', 'connector-path connector-hub-spoke')
          .attr('d', c.path)
          .attr('stroke', c.color)
          .attr('stroke-width', c.strokeWidth)
          .attr('stroke-linecap', 'round')
          .attr('stroke-dasharray', c.dashed ? '6,4' : null)
          .attr('fill', 'none')
          .attr('opacity', c.opacity);
      } else if (c.type === 'hub') {
        gFg.append('circle')
          .attr('class', 'connector-hub')
          .attr('cx', c.cx)
          .attr('cy', c.cy)
          .attr('r', c.r)
          .attr('fill', c.filled ? c.color : 'var(--bg-surface)')
          .attr('stroke', c.color)
          .attr('stroke-width', 3);
      }
    }
  }

  // --- Streaming pulse for column backgrounds ---

  function startFlowAnimation(svg, agentId) {
    if (_flowAnimations.has(agentId)) return;
    const rect = svg.select(`.col-bg-rect[data-agent-id="${agentId}"]`);
    if (rect.empty()) return;
    rect.classed('col-bg-streaming', true);
    _flowAnimations.set(agentId, true);
  }

  function stopFlowAnimation(agentId) {
    if (!_flowAnimations.has(agentId)) return;
    _flowAnimations.delete(agentId);
    if (!_d3State?.svg) return;
    _d3State.svg.select(`.col-bg-rect[data-agent-id="${agentId}"]`).classed('col-bg-streaming', false);
  }

  function stopAllFlowAnimations() {
    _flowAnimations.clear();
    if (_d3State?.svg) _d3State.svg.selectAll('.col-bg-streaming').classed('col-bg-streaming', false);
  }

  // --- D3 Selection management ---

  function d3UpdateSelection(nodesLayer) {
    const sel = state.selection;
    if (!nodesLayer) return;
    const layer = typeof nodesLayer === 'string' ? document.querySelector(nodesLayer) : nodesLayer;
    if (!layer) return;

    layer.querySelectorAll('.turn-group.selected').forEach(el => el.classList.remove('selected'));
    layer.classList.toggle('has-selection', !!sel);

    if (sel) {
      const target = sel.type === 'turn'
        ? layer.querySelector(`.turn-group[data-turn-id="${sel.id}"]`)
        : layer.querySelector(`[data-tool-id="${sel.interactionId}-${sel.toolIndex}"]`);
      if (target) {
        const group = target.closest('.turn-group') || target;
        group.classList.add('selected');
      }
    }
  }

  // --- Main render ---

  function renderTimelineParallel() {
    const savedScroll = _liveMode ? null : timelineList.scrollTop;
    timelineList.innerHTML = '';
    resetSubagentRegistry();
    stopAllFlowAnimations();

    // Rebuild footer badges filtered to the active instance tab
    rebuildFooterBadgesForTab();

    const visible = state.interactions.filter(i => isVisibleInTimeline(i) && i.timestamp > 0 && !_inflightSet.has(i.id));
    if (visible.length === 0) return;

    // Detect session boundaries (gaps > 5 min) for visual separators
    const SESSION_GAP = 5 * 60 * 1000;
    const sessionBoundaries = new Set();
    for (let i = 1; i < visible.length; i++) {
      if (visible[i].timestamp - visible[i - 1].timestamp > SESSION_GAP) {
        sessionBoundaries.add(i);
      }
    }
    const filtered = visible;

    const assignment = wl.buildColumnAssignment(filtered, registerSubagent);
    const { columnFor, totalColumns, columnAgents, columnSegments, parallelRegions, postHookClosedCol, depthAt } = assignment;
    const colWidth = wl.computeColumnWidth(totalColumns);

    wl.buildFoldedHooksMap(filtered);
    wl.buildClampGroups(filtered, columnFor);

    const aside = document.getElementById('timeline');
    if (aside) {
      const neededWidth = D3_CONST.RULER_WIDTH + totalColumns * colWidth + (totalColumns - 1) * D3_CONST.COLUMN_GAP + 24;
      aside.style.minWidth = '';
      const userW = window.__timelineUserWidth;
      if (!userW) {
        aside.style.width = neededWidth + 'px';
      }
    }

    const { layout, totalHeight, sessionStart, breaks, compressedY, cohorts } = wl.computeD3Layout(filtered, columnFor, totalColumns, parallelRegions, postHookClosedCol, depthAt, columnSegments);

    // Create wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'tl-d3-wrapper';
    wrapper.style.height = totalHeight + 'px';

    // Lane headers
    const headers = document.createElement('div');
    headers.className = 'tl-lane-headers';

    // Ruler header
    const rulerHeader = document.createElement('div');
    rulerHeader.className = 'tl-lane-header';
    rulerHeader.style.width = D3_CONST.RULER_WIDTH + 'px';
    rulerHeader.textContent = '⏱';
    headers.appendChild(rulerHeader);

    for (let col = 0; col < totalColumns; col++) {
      const h = document.createElement('div');
      h.className = 'tl-lane-header';
      h.style.width = (colWidth + (col < totalColumns - 1 ? D3_CONST.COLUMN_GAP : 0)) + 'px';
      if (col === 0) {
        h.textContent = 'Main Thread';
      } else {
        const segs = columnSegments.filter(s => s.col === col);
        if (segs.length > 0) {
          h.innerHTML = segs.map(s => {
            const label = s.subagent ? escHtml(getSubagentLabel(s.subagent)) : 'agent';
            const color = s.subagent ? getSubagentColor(s.subagent) : SUBAGENT_COLORS[0];
            return `<span style="color:${color}">${label}</span>`;
          }).join('<span class="tl-lane-sep"> · </span>');
          const firstColor = segs[0].subagent ? getSubagentColor(segs[0].subagent) : null;
          if (firstColor) h.style.borderBottomColor = firstColor;
        } else {
          const agent = columnAgents.get(col);
          if (agent) {
            h.textContent = getSubagentLabel(agent);
            const color = getSubagentColor(agent);
            if (color) { h.style.color = color; h.style.borderBottomColor = color; }
          } else {
            h.textContent = `Agent ${col}`;
          }
        }
      }
      headers.appendChild(h);
    }

    // SVG background layer (behind nodes): ruler + column backgrounds
    const svgColumnsWidth = D3_CONST.RULER_WIDTH + totalColumns * colWidth + (totalColumns - 1) * D3_CONST.COLUMN_GAP;
    const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgEl.setAttribute('class', 'tl-connector-svg');
    svgEl.setAttribute('width', '100%');
    svgEl.setAttribute('height', totalHeight);

    const svg = d3.select(svgEl);
    svg.append('defs');
    svg.append('g').attr('class', 'tl-time-ruler');
    svg.append('g').attr('class', 'tl-connectors');

    // Nodes layer
    const nodesLayer = document.createElement('div');
    nodesLayer.className = 'tl-nodes-layer';
    nodesLayer.style.height = totalHeight + 'px';

    // SVG foreground layer (above nodes): fork/merge curves
    const svgFgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgFgEl.setAttribute('class', 'tl-connector-svg tl-connector-fg');
    svgFgEl.setAttribute('width', '100%');
    svgFgEl.setAttribute('height', totalHeight);
    const svgFg = d3.select(svgFgEl);
    svgFg.append('defs');
    svgFg.append('g').attr('class', 'tl-connectors-fg');

    // Render nodes
    let turnNum = 0;
    const subagentTurnCounts = new Map();

    for (const item of layout) {
      const interaction = item.interaction;
      if (wl.isFoldedHook(interaction.id)) continue;
      if (wl.isClampedHook(interaction.id)) continue;
      let el;

      if (interaction.isMcp) {
        el = buildD3McpEl(interaction);
      } else if (interaction.isHook) {
        el = buildD3HookEl(interaction);
      } else {
        let num, isSub = false;
        if (!isStandardLlm(interaction) || !hasAssistantMessage(interaction)) {
          num = undefined;
        } else {
          const agentId = interaction.subagent?.agentId;
          if (agentId) {
            const n = (subagentTurnCounts.get(agentId) || 0) + 1;
            subagentTurnCounts.set(agentId, n);
            num = n;
            isSub = true;
          } else {
            turnNum++;
            num = turnNum;
          }
        }
        el = buildD3TurnEl(interaction, num, isSub);
      }

      if (interaction.deleted) el.classList.add('turn-deleted');
      el.style.transform = `translate(${item.x}px, ${item.y}px)`;
      el.style.width = item.width + 'px';
      if (item.height > D3_CONST.MIN_ENTRY_HEIGHT) el.style.minHeight = item.height + 'px';
      nodesLayer.appendChild(el);
    }

    wrapper.appendChild(svgEl);
    wrapper.appendChild(nodesLayer);
    wrapper.appendChild(svgFgEl);
    timelineList.appendChild(headers);
    timelineList.appendChild(wrapper);

    // Render connectors: backgrounds in svg (behind nodes), curves in svgFg (above nodes)
    const connectors = wl.computeConnectorData(layout, columnFor, columnAgents, totalColumns, compressedY, sessionStart, postHookClosedCol, columnSegments, { subagentColors: SUBAGENT_COLORS, getSubagentColor, cohorts });
    renderConnectors(svg, svgFg, connectors, layout, columnAgents, totalColumns, compressedY, sessionStart, columnSegments);

    // Render time ruler
    renderTimeRuler(svg, layout, sessionStart, totalHeight, breaks, compressedY);

    // Render session boundary separators
    if (sessionBoundaries.size > 0) {
      const gSep = svg.select('.tl-connectors');
      const totalW = D3_CONST.RULER_WIDTH + totalColumns * colWidth + (totalColumns - 1) * D3_CONST.COLUMN_GAP;
      for (const idx of sessionBoundaries) {
        const itemAbove = layout[idx - 1];
        const itemBelow = layout[idx];
        if (!itemAbove || !itemBelow) continue;
        const sepY = (itemAbove.y + itemAbove.height + itemBelow.y) / 2;
        gSep.append('line')
          .attr('class', 'session-separator')
          .attr('x1', D3_CONST.RULER_WIDTH)
          .attr('x2', totalW)
          .attr('y1', sepY)
          .attr('y2', sepY);
      }
    }

    // Apply current selection
    d3UpdateSelection(nodesLayer);

    // Start bg pulse for any streaming subagents
    for (const item of layout) {
      if (item.interaction.status === 'streaming' && item.interaction.subagent?.agentId) {
        startFlowAnimation(svg, item.interaction.subagent.agentId);
      }
    }

    if (_liveMode) scrollTimelineToBottom();
    else if (savedScroll != null) timelineList.scrollTop = savedScroll;

    // Save state for incremental appends
    _d3State = {
      wrapper, svg, svgFg, nodesLayer, headers,
      columnFor, columnAgents, columnSegments, totalColumns,
      layout, totalHeight, sessionStart, breaks, compressedY, cohorts,
      turnNum, subagentTurnCounts,
      activeColumns: assignment.activeColumns,
      historicalColumns: assignment.historicalColumns,
      freeColumns: assignment.freeColumns,
      nextColumn: assignment.nextColumn,
      parallelRegions,
      postHookClosedCol,
    };

    // Set up resize observer
    if (!_d3ResizeObserver) {
      _d3ResizeObserver = new ResizeObserver(() => {
        if (_timelineMode !== 'parallel' || !_d3State) return;
        if (window.__timelineDragging || _focusMode) return;
        _d3ResizeDebounce = _d3ResizeDebounce || requestAnimationFrame(() => {
          _d3ResizeDebounce = null;
          renderTimelineParallel();
        });
      });
    }
    _d3ResizeObserver.observe(document.getElementById('timeline'));
  }

  let _d3ResizeObserver = null;
  let _d3ResizeDebounce = null;

  // --- Incremental append ---

  /* Subagent resolution enriches a turn and each of its related hooks in one
     burst (src/store.js applyResolution), and every one of them clears
     timelineList wholesale. Coalesce a burst into a single rebuild. */
  let _tlRebuildQueued = null;

  function queueTimelineParallelRebuild() {
    if (_tlRebuildQueued) return;
    _tlRebuildQueued = requestAnimationFrame(() => {
      _tlRebuildQueued = null;
      renderTimelineParallel();
    });
  }

  function appendToParallelTimeline(interaction) {
    if (!_d3State) {
      renderTimelineParallel();
      return;
    }
    const ds = _d3State;

    // Determine column
    let agentId = null;
    if (interaction.isHook) {
      agentId = interaction.subagent?.agentId || wl.resolveHookAgentId(interaction, state.interactions);
    } else {
      agentId = interaction.subagent?.agentId || null;
    }
    // PostToolUse/Agent hooks go to column 0
    if (interaction.isHook && /PostToolUse/i.test(interaction.hookEvent) && interaction.toolName === 'Agent') {
      agentId = null;
    }
    // SubagentStop with unknown agent_id: don't allocate a new column
    if (interaction.isHook && interaction.hookEvent === 'SubagentStop'
        && agentId && !ds.activeColumns.has(agentId) && !ds.historicalColumns.has(agentId)) {
      agentId = null;
    }

    let col = 0;
    if (agentId) {
      if (!ds.activeColumns.has(agentId) && !ds.historicalColumns.has(agentId)) {
        const alloc = wl.allocateColumn(ds.freeColumns, ds.activeColumns, ds.nextColumn);
        col = alloc.col;
        ds.nextColumn = alloc.nextColumn;
        ds.activeColumns.set(agentId, col);
        ds.historicalColumns.set(agentId, col);
        if (interaction.subagent) {
          registerSubagent(interaction.subagent);
          ds.columnAgents.set(col, interaction.subagent);
        }
      }
      col = ds.activeColumns.get(agentId) || ds.historicalColumns.get(agentId) || 0;
    }

    // Full re-render when parallel activity is detected or columns change
    if (col >= ds.totalColumns || ds.activeColumns.size > 0 || col > 0) {
      renderTimelineParallel();
      return;
    }

    // A clamp candidate collapses into whichever turn OWNS it, and ownership is
    // only resolvable from the whole interaction list — which already contains
    // this entry by the time we get here. So hand off to a rebuild rather than
    // placing it as a standalone row. Gating this on "the previous item is a
    // recent LLM turn" is what used to leave hook runs expanded in live mode
    // whenever a SubagentStop, a user prompt, or a text-only turn landed in
    // between; the rebuild is rAF-coalesced, so a burst still costs one pass.
    if (wl.isClampCandidate(interaction)) {
      queueTimelineParallelRebuild();
      return;
    }

    // Sequential compact stacking for single-column appends
    const colWidth = wl.computeColumnWidth(ds.totalColumns);
    const height = wl.computeNodeHeight(interaction);
    const elapsed = interaction.timestamp - ds.sessionStart;
    const x = D3_CONST.RULER_WIDTH + col * (colWidth + D3_CONST.COLUMN_GAP);

    let globalBottom = D3_CONST.HEADER_HEIGHT + 8;
    for (const item of ds.layout) {
      const b = item.y + item.height;
      if (b > globalBottom) globalBottom = b;
    }

    const y = globalBottom + D3_CONST.MIN_GAP;

    const item = { id: interaction.id, x, y, width: colWidth, height, col, interaction, elapsed };
    ds.layout.push(item);
    ds.columnFor.set(interaction.id, col);

    // Update total height
    const newTotalHeight = Math.max(ds.totalHeight, y + height + 40);
    if (newTotalHeight > ds.totalHeight) {
      ds.totalHeight = newTotalHeight;
      ds.wrapper.style.height = newTotalHeight + 'px';
      ds.nodesLayer.style.height = newTotalHeight + 'px';
      ds.svg.attr('height', newTotalHeight);
      ds.svgFg.attr('height', newTotalHeight);
    }

    // Build and append element
    let el;
    if (interaction.isMcp) {
      el = buildD3McpEl(interaction);
    } else if (interaction.isHook) {
      el = buildD3HookEl(interaction);
    } else {
      let num, isSub = false;
      if (!isStandardLlm(interaction) || !hasAssistantMessage(interaction)) {
        num = undefined;
      } else if (agentId) {
        const n = (ds.subagentTurnCounts.get(agentId) || 0) + 1;
        ds.subagentTurnCounts.set(agentId, n);
        num = n;
        isSub = true;
      } else {
        ds.turnNum++;
        num = ds.turnNum;
      }
      el = buildD3TurnEl(interaction, num, isSub);
    }

    if (interaction.deleted) el.classList.add('turn-deleted');
    el.style.width = colWidth + 'px';
    if (height > D3_CONST.MIN_ENTRY_HEIGHT) el.style.minHeight = height + 'px';
    el.style.opacity = '0';
    el.style.transform = `translate(${x}px, ${y - 8}px)`;
    ds.nodesLayer.appendChild(el);

    requestAnimationFrame(() => {
      el.style.transition = 'opacity 0.25s cubic-bezier(0.33,1,0.68,1), transform 0.25s cubic-bezier(0.33,1,0.68,1)';
      el.style.opacity = '1';
      el.style.transform = `translate(${x}px, ${y}px)`;
    });

    const connectors = wl.computeConnectorData(ds.layout, ds.columnFor, ds.columnAgents, ds.totalColumns, ds.compressedY, ds.sessionStart, ds.postHookClosedCol, ds.columnSegments || [], { subagentColors: SUBAGENT_COLORS, getSubagentColor, cohorts: ds.cohorts });
    renderConnectors(ds.svg, ds.svgFg, connectors, ds.layout, ds.columnAgents, ds.totalColumns, ds.compressedY, ds.sessionStart, ds.columnSegments || []);
    renderTimeRuler(ds.svg, ds.layout, ds.sessionStart, ds.totalHeight, ds.breaks || [], ds.compressedY);

    // Close agent column when its last LLM turn completes (stop_reason: end_turn).
    // PostToolUse/Agent hooks fire at launch time, not completion — don't use them.
    if (!interaction.isHook && agentId && ds.activeColumns.has(agentId)) {
      const stopReason = interaction.response?.body?.stop_reason;
      if (stopReason === 'end_turn' && interaction.status === 'complete') {
        stopFlowAnimation(agentId);
        ds.freeColumns.push(ds.activeColumns.get(agentId));
        ds.activeColumns.delete(agentId);
      }
    }

    if (interaction.status === 'streaming' && interaction.subagent?.agentId) {
      startFlowAnimation(ds.svg, interaction.subagent.agentId);
    }

    d3UpdateSelection(ds.nodesLayer);
  }

  // --- D3 status update hook (called from updateTurnBadge) ---

  function d3UpdateNodeStatus(id, status) {
    if (!_d3State) return;
    const node = _d3State.nodesLayer.querySelector(`.turn-group[data-turn-id="${id}"]`);
    if (!node) return;

    node.className = node.className
      .replace(/\bstatus-\w+/g, '')
      .replace(/\s+/g, ' ')
      .trim() + ` status-${status}`;

    // Manage bg pulse for subagents
    const agentId = node.dataset.agentId;
    if (agentId) {
      if (status === 'streaming') {
        startFlowAnimation(_d3State.svg, agentId);
      } else {
        stopFlowAnimation(agentId);
      }
    }
  }

  // --- Footer streaming badges ---

  function _footerBadgeStats(interaction) {
    const req = interaction.request || {};
    const msgCount = req._messageCount ?? req.messages?.length ?? 0;
    const toolCount = req._toolCount ?? req.tools?.length ?? 0;
    return { msgCount, toolCount };
  }

  function _updateFooterBadgeStats(badge, interaction) {
    const { msgCount, toolCount } = _footerBadgeStats(interaction);
    const statsEl = badge.querySelector('.badge-stats');
    if (statsEl) {
      const parts = [];
      if (msgCount > 0) parts.push(`${msgCount} msg`);
      if (toolCount > 0) parts.push(`${toolCount} tool${toolCount > 1 ? 's' : ''}`);
      statsEl.textContent = parts.join(', ');
    }
    const statusEl = badge.querySelector('.badge-status');
    if (statusEl) {
      const status = interaction.status || 'pending';
      statusEl.textContent = status;
      statusEl.className = 'badge-status badge-status-' + status;
    }
  }

  function rebuildFooterBadgesForTab() {
    for (const iv of _inflightTimers.values()) clearInterval(iv);
    _inflightSet.clear();
    _inflightTimers.clear();
    const container = document.getElementById('timeline-footer-streaming');
    if (container) container.innerHTML = '';

    for (const interaction of state.interactions) {
      if (!isVisibleInTimeline(interaction)) continue;
      const iStatus = interaction.status || 'pending';
      const isLongLived = !interaction.isHook && !interaction.isMcp;
      if (isLongLived && (iStatus === 'pending' || iStatus === 'streaming')) {
        addFooterBadge(interaction);
      }
    }
  }

  function addFooterBadge(interaction) {
    if (_inflightSet.has(interaction.id)) return;
    _inflightSet.add(interaction.id);

    const container = document.getElementById('timeline-footer-streaming');
    if (!container) return;

    const badge = document.createElement('div');
    const statusCls = interaction.status === 'streaming' ? ' is-streaming' : ' is-pending';
    badge.className = 'footer-streaming-badge' + statusCls;
    badge.dataset.interactionId = interaction.id;

    const agentLabel = interaction.subagent
      ? getSubagentLabel(interaction.subagent)
      : 'main';
    const agentColor = interaction.subagent?.agentId
      ? getSubagentColor(interaction.subagent)
      : 'var(--accent)';

    const status = interaction.status || 'pending';
    badge.innerHTML =
      `<span class="badge-agent-dot" style="background:${agentColor}"></span>` +
      `<span class="badge-label">${escHtml(agentLabel)}</span>` +
      `<span class="badge-stats"></span>` +
      `<span class="badge-status badge-status-${status}">${status}</span>` +
      `<span class="badge-elapsed">0s</span>`;

    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      select({ type: 'turn', id: interaction.id }, { userClick: true });
    });

    container.appendChild(badge);
    _updateFooterBadgeStats(badge, interaction);
    _updateFooterBusyIndicator();

    const startedAt = interaction.timing?.startedAt || Date.now();
    const iv = setInterval(() => {
      const elapsedEl = badge.querySelector('.badge-elapsed');
      if (elapsedEl) elapsedEl.textContent = formatDuration(Date.now() - startedAt);
    }, 1000);
    _inflightTimers.set(interaction.id, iv);
  }

  function removeFooterBadge(id) {
    if (!_inflightSet.has(id)) return;
    _inflightSet.delete(id);

    const iv = _inflightTimers.get(id);
    if (iv != null) { clearInterval(iv); _inflightTimers.delete(id); }

    const container = document.getElementById('timeline-footer-streaming');
    const badge = container?.querySelector(`[data-interaction-id="${id}"]`);
    if (badge) {
      badge.classList.add('animate-out');
      setTimeout(() => badge.remove(), 300);
    }

    _updateFooterBusyIndicator();

    if (_timelineMode === 'parallel') {
      setTimeout(() => renderTimelineParallel(), 320);
    }
  }

  function _updateFooterBusyIndicator() {
    const container = document.getElementById('timeline-footer-streaming');
    if (!container) return;
    let indicator = container.querySelector('.footer-busy-indicator');
    if (_inflightSet.size > 0) {
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'footer-busy-indicator';
        indicator.innerHTML =
          '<span class="busy-dot"></span>' +
          '<span class="busy-dot"></span>' +
          '<span class="busy-dot"></span>';
        container.appendChild(indicator);
      }
    } else {
      if (indicator) indicator.remove();
    }
  }

  function clearAllFooterBadges() {
    for (const iv of _inflightTimers.values()) clearInterval(iv);
    _inflightSet.clear();
    _inflightTimers.clear();
    const container = document.getElementById('timeline-footer-streaming');
    if (container) container.innerHTML = '';
  }

  // === END D3 PARALLEL TIMELINE ===

  function appendTurnToTimeline(interaction, turnNum, isSubagentTurn) {
    if (turnNum === undefined) turnNum = llmTurnNumber(interaction);

    if (interaction.isMcp) {
      return appendMcpCallToTimeline(interaction);
    }
    if (interaction.isHook) {
      return appendHookEntryToTimeline(interaction);
    }

    if (!isStandardLlm(interaction)) {
      const group = document.createElement('div');
      group.className = 'turn-group endpoint-call-group';
      group.dataset.turnId = interaction.id;

      const el = document.createElement('div');
      el.className = 'timeline-entry turn-entry endpoint-call-entry';
      el.dataset.id = interaction.id;

      const ep = interaction.endpoint.replace('/v1/messages/', '');
      const statusClass = badgeClass(interaction.status);
      el.innerHTML = `
        <span class="endpoint-label" title="${escHtml(ep)}">${escHtml(ep)}</span>
        <span class="entry-badge ${statusClass}" data-badge="${interaction.id}">${interaction.status || 'pending'}</span>
        <span class="entry-tokens" data-tokenlabel="${interaction.id}">${compactTokens(interaction.usage)}</span>
      `;

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        select({ type: 'turn', id: interaction.id }, { userClick: true });
      });
      group.appendChild(el);
      timelineList.appendChild(group);
      return;
    }

    const group = document.createElement('div');
    let groupClass = 'turn-group' + (isNewUserTurn(interaction) ? ' new-user-turn' : '');
    if (interaction.subagent?.isSidechain) groupClass += ' sidechain-group';
    else if (interaction.subagent?.agentType) groupClass += ' subagent-group';
    group.className = groupClass;
    group.dataset.turnId = interaction.id;

    const currentAgentId = interaction.subagent?.agentId || null;
    if (interaction.subagent?.agentId) {
      registerSubagent(interaction.subagent);
      group.dataset.agentId = interaction.subagent.agentId;
      const color = getSubagentColor(interaction.subagent);
      group.style.setProperty('--subagent-color', color);
      if (currentAgentId !== _lastRenderedAgentId) {
        group.style.borderTop = `2px solid ${color}`;
      }
    } else if (_lastRenderedAgentId !== null && currentAgentId === null) {
      group.style.borderTop = '2px solid var(--border)';
    }
    _lastRenderedAgentId = currentAgentId;

    const el = document.createElement('div');
    el.className = 'timeline-entry turn-entry';
    el.dataset.id = interaction.id;

    const instanceTag = (activeInstanceTab === 'all' && interaction.instanceId)
      ? `<span class="entry-instance">${escHtml(instanceDisplayLabel(interaction.instanceId))}</span>` : '';

    el.innerHTML = turnHeaderHtml(interaction, turnNum, isSubagentTurn, { instanceTag });

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      select({ type: 'turn', id: interaction.id }, { userClick: true });
    });

    group.appendChild(el);

    const toolsContainer = document.createElement('div');
    toolsContainer.className = 'tool-entries';
    toolsContainer.dataset.toolsFor = interaction.id;
    group.appendChild(toolsContainer);

    const toolCalls = extractToolCalls(interaction);
    toolCalls.forEach((tc, tIdx) => {
      const toolEl = createToolEntryEl(interaction.id, tIdx, tc.name, toolSummary(tc.name, tc.input), tc.input, interaction.subagent);
      toolsContainer.appendChild(toolEl);
    });

    timelineList.appendChild(group);

    if (interaction.status === 'pending' || interaction.status === 'streaming') {
      startDurationTimer(interaction);
    }
  }

  function appendMcpCallToTimeline(interaction, idx) {
    const group = document.createElement('div');
    group.className = 'turn-group mcp-call-group';
    group.dataset.turnId = interaction.id;

    const el = document.createElement('div');
    el.className = 'timeline-entry turn-entry mcp-call-entry';
    el.dataset.id = interaction.id;

    const toolName = interaction.request?.tool || 'unknown';
    const durationHtml = interaction.timing?.duration ? durationGauge(interaction.timing.duration) : '--';
    const isError = interaction.status === 'error';
    const source = interaction.mcpSource === 'claude-code' ? 'claude' : 'test';

    el.innerHTML = `
      <div class="entry-header">
        <span class="entry-num mcp-label">MCP</span>
        <span class="entry-badge ${isError ? 'error' : 'complete'}">${isError ? 'error' : 'ok'}</span>
      </div>
      <div class="entry-model mcp-tool-name" title="${escHtml(toolName)}">${escHtml(toolName)}</div>
      <div class="entry-meta">
        <span class="mcp-source-tag mcp-src-${source}">${source}</span>
        <span>${durationHtml}</span>
      </div>
    `;

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      select({ type: 'turn', id: interaction.id }, { userClick: true });
    });

    group.appendChild(el);
    timelineList.appendChild(group);
  }

  function findHookSubagent(hookInteraction) {
    if (!hookInteraction.toolUseId) return null;
    for (let i = state.interactions.length - 1; i >= 0; i--) {
      const turn = state.interactions[i];
      if (turn.isHook || turn.isMcp) continue;
      if (turn.instanceId !== hookInteraction.instanceId) continue;
      const tools = extractToolCalls(turn);
      if (tools.some(tc => tc.id === hookInteraction.toolUseId)) return turn.subagent || null;
    }
    return null;
  }

  function appendHookEntryToTimeline(interaction, idx) {
    const hookEvent = interaction.hookEvent || 'Hook';
    const toolName = interaction.toolName || '';
    const arrow = /Stop|End$|Remove|Completed/i.test(hookEvent) ? '◼' : '▸';
    const subagent = findHookSubagent(interaction);

    const agentLabel = subagent ? getSubagentLabel(subagent) : '';
    const agentColor = subagent?.agentId ? getSubagentColor(subagent) : '';
    const agentTag = subagent?.agentType
      ? `<span class="tool-entry-tag tag-agent"${agentColor ? ` style="color:${agentColor};background:color-mix(in srgb, ${agentColor} 10%, transparent);border-color:color-mix(in srgb, ${agentColor} 20%, transparent)"` : ''}>${escHtml(agentLabel)}</span>` : '';

    // Try to nest under the most recent LLM turn for the same instance
    const parentContainer = findParentToolContainer(interaction);
    if (parentContainer) {
      const el = document.createElement('div');
      el.className = 'timeline-entry tool-entry hook-tool-entry';
      el.dataset.id = interaction.id;
      el.innerHTML = `
        <span class="tool-connector hook-connector"></span>
        <span class="hook-arrow">${arrow}</span>
        <span class="tool-entry-name hook-entry-name">${escHtml(hookEvent)}</span>
        <span class="tool-entry-tag tag-hook">hook</span>
        ${agentTag}
        <span class="tool-entry-summary" title="${escHtml(toolName)}">${escHtml(toolName)}</span>
      `;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        select({ type: 'turn', id: interaction.id }, { userClick: true });
      });
      parentContainer.appendChild(el);
      return;
    }

    // Fallback: standalone entry if no parent turn found
    const group = document.createElement('div');
    group.className = 'turn-group hook-call-group';
    group.dataset.turnId = interaction.id;

    const el = document.createElement('div');
    el.className = 'timeline-entry turn-entry hook-call-entry';
    el.dataset.id = interaction.id;

    const subType = interaction.subagent?.agentType;
    const isSubagentHook = /SubagentStart|SubagentStop/i.test(hookEvent);
    const hookNameLabel = isSubagentHook && subType ? subType : toolName;

    el.innerHTML = `
      <span class="hook-arrow">${arrow}</span>
      <span class="hook-label">${escHtml(hookEvent)}</span>
      <span class="hook-tool-name">${escHtml(hookNameLabel)}</span>
    `;

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      select({ type: 'turn', id: interaction.id }, { userClick: true });
    });

    group.appendChild(el);
    timelineList.appendChild(group);
  }

  function findParentToolContainer(hookInteraction) {
    // If the hook has a toolUseId, find the turn that owns that tool call
    if (hookInteraction.toolUseId) {
      const groups = timelineList.querySelectorAll('.turn-group:not(.hook-call-group):not(.mcp-call-group)');
      for (let i = groups.length - 1; i >= 0; i--) {
        const turnId = groups[i].dataset.turnId;
        const turn = state.interactions.find(t => t.id === turnId);
        if (!turn) continue;
        const tools = extractToolCalls(turn);
        if (tools.some(tc => tc.id === hookInteraction.toolUseId)) {
          return groups[i].querySelector('.tool-entries');
        }
      }
    }
    // Fallback: most recent LLM turn for the same instance
    const groups = timelineList.querySelectorAll('.turn-group:not(.hook-call-group):not(.mcp-call-group)');
    for (let i = groups.length - 1; i >= 0; i--) {
      const turnId = groups[i].dataset.turnId;
      const turn = state.interactions.find(t => t.id === turnId);
      if (turn && turn.instanceId === hookInteraction.instanceId) {
        return groups[i].querySelector('.tool-entries');
      }
    }
    return null;
  }

  function appendToolToTimeline(interactionId, toolIdx, name, summary) {
    const container = document.querySelector(`[data-tools-for="${interactionId}"]`);
    if (!container) return;
    if (container.querySelector(`[data-tool-id="${interactionId}-${toolIdx}"]`)) return;
    const interaction = state.interactions.find(i => i.id === interactionId);
    const toolEl = createToolEntryEl(interactionId, toolIdx, name, summary, null, interaction?.subagent);
    container.appendChild(toolEl);
    if (_liveMode) scrollTimelineToBottom();
  }

  function createToolEntryEl(interactionId, toolIdx, name, summary, input, subagent) {
    const toolEl = document.createElement('div');
    const isSkill = name === 'Skill' && input?.skill;
    toolEl.className = 'timeline-entry tool-entry' + (isSkill ? ' skill-call' : '');
    toolEl.dataset.toolId = `${interactionId}-${toolIdx}`;
    const displayName = isSkill ? `/${input.skill}` : name;
    const agentLabel = subagent ? getSubagentLabel(subagent) : '';
    const agentColor = subagent?.agentId ? getSubagentColor(subagent) : '';
    const agentTag = subagent?.agentType
      ? `<span class="tool-entry-tag tag-agent"${agentColor ? ` style="color:${agentColor};background:color-mix(in srgb, ${agentColor} 10%, transparent);border-color:color-mix(in srgb, ${agentColor} 20%, transparent)"` : ''}>${escHtml(agentLabel)}</span>` : '';
    toolEl.innerHTML = `
      <span class="tool-connector"></span>
      <span class="tool-entry-name" data-tool-name="${interactionId}-${toolIdx}">${escHtml(displayName)}</span>
      ${isSkill ? '<span class="tool-entry-tag tag-sk">skill</span>' : ''}
      ${agentTag}
      <span class="tool-entry-summary" title="${escHtml(summary)}" data-tool-summary="${interactionId}-${toolIdx}">${escHtml(summary)}</span>
    `;
    toolEl.addEventListener('click', (e) => {
      e.stopPropagation();
      select({ type: 'tool', interactionId, toolIndex: toolIdx }, { userClick: true });
    });
    return toolEl;
  }

  // --- Turn hover deck ----------------------------------------------------
  // The 44px header is a hard budget, so everything that doesn't fit lives
  // here: exact token counts, the cost split, wall-clock span, full model id.
  // Fixed-position (like Pro's .vc-remote-tip) so it costs the timeline no
  // vertical space and no node box can clip it.
  let _turnTipEl = null;
  let _turnTipFor = null;

  function _tipRow(label, value, cls) {
    return `<div class="tt-row${cls ? ' ' + cls : ''}"><span class="tt-k">${label}</span><span class="tt-v">${value}</span></div>`;
  }

  function turnTipHtml(interaction, turnLabel) {
    const model = interaction.request?.model || 'unknown';
    const status = interaction.status || 'pending';
    const u = interaction.usage || {};
    const t = interaction.timing || {};

    let head = `<div class="tt-head"><b>${escHtml(turnLabel || '')}</b>`
      + `<span class="tt-model">${escHtml(model)}</span>`
      + `<span class="entry-badge ${badgeClass(status)}">${escHtml(status)}</span></div>`;

    let time = '';
    if (t.duration != null || t.startedAt) {
      const start = t.startedAt || interaction.timestamp;
      const rows = [];
      if (t.duration != null) rows.push(_tipRow('elapsed', formatDuration(t.duration), 'tt-hi'));
      if (t.ttfb) rows.push(_tipRow('first byte', formatDuration(t.ttfb)));
      if (start) {
        const a = new Date(start), b = new Date(start + (t.duration || 0));
        const hhmmss = d => d.toTimeString().slice(0, 8);
        rows.push(_tipRow('span', `${hhmmss(a)} &rarr; ${hhmmss(b)}`));
      }
      time = `<div class="tt-sec">${rows.join('')}</div>`;
    }

    let tokens = '';
    const n = v => (v || 0).toLocaleString();
    if (u.input_tokens != null || u.output_tokens != null || u.cache_read_input_tokens) {
      const cached = u.cache_read_input_tokens || 0;
      const context = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + cached;
      const hit = context ? Math.round(cached / context * 100) : 0;
      tokens = '<div class="tt-sec">'
        + _tipRow('<i class="tt-d et-in"></i>input', n(u.input_tokens))
        + _tipRow('<i class="tt-d et-out"></i>output', n(u.output_tokens))
        + (u.cache_creation_input_tokens ? _tipRow('<i class="tt-d et-cw"></i>cache write', n(u.cache_creation_input_tokens)) : '')
        + (cached ? _tipRow('<i class="tt-d et-cr"></i>cache read', n(cached)) : '')
        + (u.reasoning_tokens ? _tipRow('reasoning', n(u.reasoning_tokens)) : '')
        + _tipRow('context', `${n(context)}<small> ${hit}% cached</small>`, 'tt-hi')
        + '</div>';
    }

    let cost = '';
    const pr = interaction.pricing;
    const total = computeCost(u, pr);
    if (total != null) {
      const part = (tok, rate) => (tok || 0) * (rate || 0) / 1e6;
      const cIn = part(u.input_tokens, pr.inputCostPerMTok);
      const cOut = part(u.output_tokens, pr.outputCostPerMTok);
      const cCw = part(u.cache_creation_input_tokens, pr.cacheCreateCostPerMTok || pr.inputCostPerMTok);
      const cCr = part(u.cache_read_input_tokens, pr.cacheReadCostPerMTok || pr.inputCostPerMTok);
      cost = '<div class="tt-sec">'
        + _tipRow('cost', formatCost(total), 'tt-hi')
        + _tipRow('input', formatCost(cIn))
        + _tipRow('output', formatCost(cOut))
        + (cCw ? _tipRow('cache write', formatCost(cCw)) : '')
        + (cCr ? _tipRow('cache read', formatCost(cCr)) : '')
        + '</div>';
    }

    let foot = '';
    const stop = interaction.response?.body?.stop_reason;
    const sub = interaction.subagent;
    if (sub || stop) {
      const bits = [];
      if (sub) bits.push(`<b>${escHtml(getSubagentLabel(sub))}</b>${sub.description ? ' &middot; ' + escHtml(sub.description) : ''}`);
      if (stop) bits.push(`stop: ${escHtml(stop)}`);
      foot = `<div class="tt-foot">${bits.join('<br>')}</div>`;
    }

    return head + time + tokens + cost + foot;
  }

  function showTurnTip(group) {
    const id = group.dataset.turnId;
    if (!id || _turnTipFor === id) return;
    const interaction = state.interactions.find(i => i.id === id);
    if (!interaction) return;

    if (!_turnTipEl) {
      _turnTipEl = document.createElement('div');
      _turnTipEl.className = 'turn-tip';
      document.body.appendChild(_turnTipEl);
    }
    _turnTipFor = id;
    _turnTipEl.innerHTML = turnTipHtml(interaction, group.querySelector('.entry-num')?.textContent);

    const r = group.getBoundingClientRect();
    const tr = _turnTipEl.getBoundingClientRect();
    const gap = 10;
    let left = r.right + gap;
    if (left + tr.width > window.innerWidth - 8) left = r.left - tr.width - gap;
    if (left < 8) left = 8;
    let top = r.top;
    if (top + tr.height > window.innerHeight - 8) top = window.innerHeight - tr.height - 8;
    if (top < 8) top = 8;
    _turnTipEl.style.left = left + 'px';
    _turnTipEl.style.top = top + 'px';
    _turnTipEl.classList.add('visible');
  }

  function hideTurnTip() {
    _turnTipFor = null;
    if (_turnTipEl) _turnTipEl.classList.remove('visible');
  }

  // mouseover bubbles and fires for every element under the pointer, so this
  // one listener both opens and closes the deck. A capturing mouseleave would
  // also fire moving between a node's own two rows, flickering the panel.
  document.addEventListener('mouseover', (e) => {
    const group = e.target.closest?.('.turn-group[data-turn-id]');
    if (!group || !group.querySelector('.entry-idrow')) { hideTurnTip(); return; }
    showTurnTip(group);
  });
  window.addEventListener('scroll', hideTurnTip, true);

  function rebuildToolEntries(interactionId) {
    const container = document.querySelector(`[data-tools-for="${interactionId}"]`);
    if (!container) return;
    const hookEls = [...container.querySelectorAll('.hook-tool-entry')];
    container.innerHTML = '';
    const interaction = state.interactions.find(i => i.id === interactionId);
    if (!interaction) return;
    const toolCalls = extractToolCalls(interaction);
    toolCalls.forEach((tc, tIdx) => {
      const toolEl = createToolEntryEl(interactionId, tIdx, tc.name, toolSummary(tc.name, tc.input), tc.input, interaction.subagent);
      container.appendChild(toolEl);
    });
    for (const h of hookEls) container.appendChild(h);
  }

  const _durationTimers = new Map();
  function startDurationTimer(interaction) {
    if (_durationTimers.has(interaction.id)) return;
    const startedAt = interaction.timing?.startedAt || Date.now();
    const iv = setInterval(() => {
      const el = document.querySelector(`[data-duration="${interaction.id}"]`);
      if (el) el.innerHTML = durationGauge(Date.now() - startedAt);
    }, 1000);
    _durationTimers.set(interaction.id, iv);
  }
  function stopDurationTimer(id) {
    const iv = _durationTimers.get(id);
    if (iv != null) { clearInterval(iv); _durationTimers.delete(id); }
  }

  function updateTurnBadge(id, status) {
    const badge = document.querySelector(`[data-badge="${id}"]`);
    if (badge) {
      badge.className = `entry-badge ${badgeClass(status)}`;
      badge.textContent = status;
    }
    if (status === 'streaming' || status === 'pending') {
      const interaction = state.interactions.find(i => i.id === id);
      if (interaction) startDurationTimer(interaction);
      // Update footer badge streaming state and status text
      const footerBadge = document.querySelector(`.footer-streaming-badge[data-interaction-id="${id}"]`);
      if (footerBadge) {
        footerBadge.classList.toggle('is-pending', status === 'pending');
        footerBadge.classList.toggle('is-streaming', status === 'streaming');
        const statusEl = footerBadge.querySelector('.badge-status');
        if (statusEl) {
          statusEl.textContent = status;
          statusEl.className = 'badge-status badge-status-' + status;
        }
      }
    } else {
      stopDurationTimer(id);
      removeFooterBadge(id);
    }
    if (_timelineMode === 'parallel') d3UpdateNodeStatus(id, status);
  }

  function updateTurnSubagentBadge(interaction) {
    const entry = document.querySelector(`.turn-entry[data-id="${interaction.id}"]`);
    if (!entry) return;
    const header = entry.querySelector('.entry-header');
    if (!header) return;
    const existing = header.querySelector('.entry-subagent');
    if (existing) existing.remove();

    if (interaction.subagent?.agentId) registerSubagent(interaction.subagent);

    if (interaction.subagent && (interaction.subagent.agentType || interaction.subagent.agentId || interaction.subagent.description)) {
      const label = getSubagentLabel(interaction.subagent);
      const color = interaction.subagent.agentId ? getSubagentColor(interaction.subagent) : '';
      const badge = document.createElement('span');
      badge.className = 'entry-subagent';
      badge.title = interaction.subagent.description || '';
      badge.textContent = label;
      if (color) {
        badge.style.color = color;
        badge.style.background = `color-mix(in srgb, ${color} 12%, transparent)`;
      }
      const anchor = header.querySelector('.entry-instance') || header.querySelector('.entry-duration');
      if (anchor) {
        header.insertBefore(badge, anchor);
      } else {
        header.appendChild(badge);
      }
    }
    const group = entry.closest('.turn-group');
    if (group) {
      group.classList.remove('sidechain-group', 'subagent-group');
      if (interaction.subagent?.isSidechain) group.classList.add('sidechain-group');
      else if (interaction.subagent?.agentType) {
        group.classList.add('subagent-group');
        if (interaction.subagent.agentId) {
          group.dataset.agentId = interaction.subagent.agentId;
          const color = getSubagentColor(interaction.subagent);
          group.style.setProperty('--subagent-color', color);
        }
      }
    }
  }

  function updateTurnMeta(interaction) {
    const durationEl = document.querySelector(`[data-duration="${interaction.id}"]`);
    if (durationEl && interaction.timing?.duration) {
      durationEl.innerHTML = durationGauge(interaction.timing.duration);
    }
    const modelEl = document.querySelector(`[data-model="${interaction.id}"]`);
    if (modelEl) {
      const modelSpan = modelEl.querySelector('.entry-model-label');
      if (modelSpan) {
        const model = interaction.request?.model || 'unknown';
        const shortModel = model.replace('claude-', '').split('-202')[0];
        modelSpan.innerHTML = escHtml(shortModel);
      }
    }
  }

  function updateTurnTokens(interaction) {
    const tokenEl = document.querySelector(`[data-tokenlabel="${interaction.id}"]`);
    if (tokenEl) tokenEl.innerHTML = compactTokens(interaction.usage);
    const costEl = document.querySelector(`[data-costgauge="${interaction.id}"]`);
    if (costEl) {
      const cost = computeCost(interaction.usage, interaction.pricing);
      costEl.innerHTML = turnCostGauge(cost);
    }
    updateUserTurnTotals();
  }

  function updateUserTurnTotals() {
    // Remove existing totals
    timelineList.querySelectorAll('.user-turn-total').forEach(el => el.remove());

    const children = [...timelineList.children];
    let sectionCost = 0;
    let lastGroupInSection = null;

    for (let i = 0; i < children.length; i++) {
      const el = children[i];
      if (!el.classList.contains('turn-group')) continue;

      const isNewSection = el.classList.contains('new-user-turn') && lastGroupInSection;
      if (isNewSection) {
        // Close previous section
        insertTurnTotal(lastGroupInSection, sectionCost);
        sectionCost = 0;
      }

      const turnId = el.dataset.turnId;
      const interaction = state.interactions.find(it => it.id === turnId);
      if (interaction) {
        const cost = computeCost(interaction.usage, interaction.pricing);
        if (cost != null) sectionCost += cost;
      }
      lastGroupInSection = el;
    }
    // Close final section
    if (lastGroupInSection) insertTurnTotal(lastGroupInSection, sectionCost);
  }

  function insertTurnTotal(afterEl, cost) {
    if (!cost) return;
    const el = document.createElement('div');
    el.className = 'user-turn-total';
    el.innerHTML = `\u03A3 ${formatCost(cost)}`;
    afterEl.after(el);
  }

  function badgeClass(status) {
    switch (status) {
      case 'streaming': return 'badge-streaming';
      case 'complete': return 'badge-complete';
      case 'error': return 'badge-error';
      default: return 'badge-pending';
    }
  }

  function updateInspectorBusy() {
    updateStreamingState();
  }

  function scrollTimelineToBottom() {
    const el = document.getElementById('timeline-list');
    el.scrollTop = el.scrollHeight;
  }

  // ============================================================
  // SELECTION + DETAIL PANEL
  // ============================================================

  function selectLastAndFollow() {
    const filtered = activeInstanceTab === 'all'
      ? state.interactions.filter(i => !i.instanceId || !knownInstances.has(i.instanceId) )
      : state.interactions.filter(i => i.instanceId === activeInstanceTab);
    const last = filtered[filtered.length - 1];
    if (last) {
      select({ type: 'turn', id: last.id });
    } else {
      state.selection = null;
      document.querySelectorAll('.timeline-entry.selected').forEach(el => el.classList.remove('selected'));
      detailContent.classList.add('hidden');
      emptyState.classList.remove('hidden');
    }
    scrollTimelineToBottom();
  }

  // --- Focus mode button + keyboard shortcuts ---
  const _focusBtn = document.getElementById('detail-focus-btn');
  if (_focusBtn) _focusBtn.addEventListener('click', toggleFocusMode);

  document.addEventListener('keydown', (e) => {
    const dashboardEl = document.getElementById('view-dashboard');
    if (!dashboardEl || dashboardEl.classList.contains('hidden')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

    if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      toggleFocusMode();
      return;
    }
    if (e.key === 'l' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (!detailContent.querySelector('.vc-split')) return;
      e.preventDefault();
      toggleDetailLayout();
      return;
    }
    if (e.key === 'Escape' && _focusMode) {
      e.preventDefault();
      exitFocusMode();
      return;
    }
  });

  // --- Arrow key navigation between LLM turns (when not in live mode) ---
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (_liveMode) return;
    const dashboardEl = document.getElementById('view-dashboard');
    if (!dashboardEl || dashboardEl.classList.contains('hidden')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

    e.preventDefault();
    const entries = Array.from(
      timelineList.querySelectorAll('.turn-entry:not(.hook-call-entry):not(.mcp-call-entry)')
    );
    if (entries.length === 0) return;

    const currentId = state.selection?.id;
    let currentIdx = currentId ? entries.findIndex(el => el.dataset.id === currentId) : -1;
    let nextIdx;
    if (e.key === 'ArrowUp') {
      nextIdx = currentIdx > 0 ? currentIdx - 1 : 0;
    } else {
      nextIdx = currentIdx < entries.length - 1 ? currentIdx + 1 : entries.length - 1;
    }
    if (nextIdx === currentIdx && currentIdx >= 0) return;

    const nextEl = entries[nextIdx];
    const nextId = nextEl.dataset.id;
    if (nextId) {
      select({ type: 'turn', id: nextId }, { userClick: true });
    }
  });

  const _pendingSseRequests = new Set();
  const _pendingDetailRequests = new Set();

  /* What detailContent currently shows. A re-select of the same target patches
     the parts that moved instead of rebuilding the panel — during a live
     session every hook, usage update and enrichment re-selects, and a rebuild
     drops the user's text selection, closes what they just opened, and replays
     the whole SSE buffer.
     { key, kind, id, toolIndex, root, sig, streamed } */
  let _detailView = null;

  const _detailKey = sel => sel.type === 'tool'
    ? `tool:${sel.interactionId}:${sel.toolIndex}` : `turn:${sel.id}`;

  /* True while the user has text selected inside `el` — replacing its innerHTML
     would silently drop the selection mid-copy. */
  function _selectionInside(el) {
    if (!el) return false;
    const s = window.getSelection();
    if (!s || s.isCollapsed || s.rangeCount === 0) return false;
    return el.contains(s.anchorNode) || el.contains(s.focusNode);
  }

  // A rebuild blocked by an active selection, replayed once it collapses.
  let _deferredRender = null;
  // Streaming markdown blocks whose re-parse was held back for the same reason.
  const _deferredMarkdown = new Set();

  document.addEventListener('selectionchange', () => {
    const s = window.getSelection();
    if (s && !s.isCollapsed) return;
    if (_deferredMarkdown.size) {
      for (const el of _deferredMarkdown) {
        if (el.isConnected && el._rawText) renderMarkdown(el._rawText, el);
      }
      _deferredMarkdown.clear();
    }
    if (_deferredRender) {
      const sel = _deferredRender;
      _deferredRender = null;
      if (state.selection && _detailKey(state.selection) === _detailKey(sel)) select(sel);
    }
  });

  /* Patch the panel in place if it happens to be showing this interaction.
     Used by the update/error paths, which must never rebuild — they fire while
     a turn streams. */
  function refreshDetailIfShowing(interaction) {
    if (_detailView?.kind !== 'llm') return;
    if (_detailView.id !== interaction.id || !_detailView.root?.isConnected) return;
    patchTurnDetail(interaction);
  }

  /* Choose between patching what's on screen, leaving it alone, and a full
     rebuild. Only a genuine target change — or content the patch path can't
     express — costs a rebuild. */
  function _renderDetail(sel, interaction) {
    const key = _detailKey(sel);
    const same = _detailView && _detailView.key === key && _detailView.root?.isConnected;

    if (same && _detailView.kind === 'llm') {
      patchTurnDetail(interaction);
      return;
    }
    if (same) {
      // Tool, MCP and hook panels are static once rendered — only a content
      // change (a lazily-fetched detail landing) is worth the rebuild.
      const sig = _detailSig(interaction);
      if (JSON.stringify(sig) === JSON.stringify(_detailView.sig)) return;
    }
    // Rebuilding under an active selection would drop it mid-copy. The same
    // target is still there once the selection collapses.
    if (same && _selectionInside(detailContent)) {
      _deferredRender = sel;
      return;
    }
    if (sel.type === 'tool') renderToolDetail(interaction, sel.toolIndex);
    else renderTurnDetail(interaction);
  }

  function select(sel, { userClick = false } = {}) {
    state.selection = sel;

    document.querySelectorAll('.timeline-entry.selected').forEach(el => el.classList.remove('selected'));

    if (_timelineMode === 'parallel' && _d3State) {
      d3UpdateSelection(_d3State.nodesLayer);
    }

    if (sel.type === 'turn') {
      const el = document.querySelector(`.turn-entry[data-id="${sel.id}"]`);
      if (el) {
        el.classList.add('selected');
        if (userClick) el.scrollIntoView({ block: 'nearest' });
      }

      const interaction = state.interactions.find(i => i.id === sel.id);
      if (!interaction) return;

      if (interaction._summary) {
        if (!_pendingDetailRequests.has(interaction.id)) {
          _pendingDetailRequests.add(interaction.id);
          sendWs({ type: 'interaction:getDetail', id: interaction.id });
        }
        // Retry once after 3s if still pending (handles dropped messages)
        const retryId = interaction.id;
        setTimeout(() => {
          const cur = state.interactions.find(i => i.id === retryId);
          if (cur?._summary && !_pendingDetailRequests.has(retryId)) {
            _pendingDetailRequests.add(retryId);
            sendWs({ type: 'interaction:getDetail', id: retryId });
          }
        }, 3000);
      }

      // Lazy-load sseEvents for completed streaming interactions
      if (interaction.isStreaming && !interaction.response?.sseEvents?.length && !_pendingSseRequests.has(interaction.id)) {
        _pendingSseRequests.add(interaction.id);
        sendWs({ type: 'interaction:getSseEvents', id: interaction.id });
      }

      if (_splitMode) {
        if (_splitInteractions.has(sel.id)) return;
        exitSplitMode();
      }

      emptyState.classList.add('hidden');
      detailContent.classList.remove('hidden');
      _renderDetail(sel, interaction);
    } else if (sel.type === 'tool') {
      const el = document.querySelector(`[data-tool-id="${sel.interactionId}-${sel.toolIndex}"]`);
      if (el) {
        el.classList.add('selected');
        if (userClick) el.scrollIntoView({ block: 'nearest' });
      }

      const interaction = state.interactions.find(i => i.id === sel.interactionId);
      if (!interaction) return;

      if (interaction._summary) {
        if (!_pendingDetailRequests.has(interaction.id)) {
          _pendingDetailRequests.add(interaction.id);
          sendWs({ type: 'interaction:getDetail', id: interaction.id });
        }
        const retryId2 = interaction.id;
        setTimeout(() => {
          const cur = state.interactions.find(i => i.id === retryId2);
          if (cur?._summary && !_pendingDetailRequests.has(retryId2)) {
            _pendingDetailRequests.add(retryId2);
            sendWs({ type: 'interaction:getDetail', id: retryId2 });
          }
        }, 3000);
      }

      if (interaction.isStreaming && !interaction.response?.sseEvents?.length && !_pendingSseRequests.has(interaction.id)) {
        _pendingSseRequests.add(interaction.id);
        sendWs({ type: 'interaction:getSseEvents', id: interaction.id });
      }

      if (_splitMode) exitSplitMode();

      emptyState.classList.add('hidden');
      detailContent.classList.remove('hidden');
      _renderDetail(sel, interaction);
    }
  }

  function autoExpandSmallJsonBlocks(container) {
    container.querySelectorAll('.jt-root').forEach(root => {
      const script = root.querySelector('script[type="application/json"]');
      if (script && script.textContent.split('\n').length <= 50)
        root.querySelectorAll('details.jt-node').forEach(d => d.open = true);
    });
  }

  function renderMcpCallDetail(interaction) {
    const req = interaction.request || {};
    const resp = interaction.response || {};
    const timing = interaction.timing || {};
    const isError = interaction.status === 'error';
    const source = interaction.mcpSource === 'claude-code' ? 'Claude Code' : 'Dashboard test';

    let html = '<div class="section-title" style="color:var(--green)">MCP Tool Call</div>';
    html += `<div class="info-grid">
      <span class="info-label">Tool</span><span class="info-value" style="color:var(--green);font-weight:700">${escHtml(req.tool || 'unknown')}</span>
      <span class="info-label">Source</span><span class="info-value">${source}</span>
      <span class="info-label">Status</span><span class="info-value" style="color:var(${isError ? '--red' : '--green'})">${isError ? 'Error' : 'Success'}</span>
      <span class="info-label">Duration</span><span class="info-value">${timing.duration ? formatDuration(timing.duration) : '--'}</span>
    </div>`;

    html += '<div class="section-title">Input</div>';
    if (req.params && Object.keys(req.params).length > 0) {
      html += `${jsonBlock(req.params)}`;
    } else {
      html += '<p class="info-label">No parameters</p>';
    }

    html += '<div class="section-title">Output</div>';
    if (isError && resp.body?.error) {
      html += `<div class="content-block"><div class="content-block-header" style="color:var(--red)">Error</div>`;
      html += `<div class="content-block-body"><pre style="white-space:pre-wrap">${escHtml(resp.body.error)}</pre></div></div>`;
    } else if (resp.body) {
      const content = resp.body.content || [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            html += `<pre class="json-block" style="white-space:pre-wrap">${escHtml(block.text || '')}`;
          } else {
            html += `${jsonBlock(block)}`;
          }
        }
      } else {
        html += `${jsonBlock(resp.body)}`;
      }
    } else {
      html += '<p class="info-label">No output</p>';
    }

    detailContent.innerHTML = html;
    autoExpandSmallJsonBlocks(detailContent);
    processMarkdownBlocks(detailContent);
    linkifyDetail(detailContent);
    _detailView = { key: `turn:${interaction.id}`, kind: 'mcp', id: interaction.id,
                    root: detailContent.firstElementChild, sig: _detailSig(interaction) };
  }

  function renderHookCallDetail(interaction) {
    const req = interaction.request || {};
    const hookEvent = interaction.hookEvent || 'unknown';
    const toolName = interaction.toolName || '--';
    const time = new Date(interaction.timestamp).toLocaleTimeString();

    let html = '<div class="section-title" style="color:var(--magenta, #c084fc)">Hook Call</div>';
    html += `<div class="info-grid">
      <span class="info-label">Event</span><span class="info-value" style="color:var(--magenta, #c084fc);font-weight:700">${escHtml(hookEvent)}</span>
      <span class="info-label">Tool</span><span class="info-value">${escHtml(toolName)}</span>
      <span class="info-label">Session</span><span class="info-value">${escHtml(req.session_id || '--')}</span>
      <span class="info-label">Time</span><span class="info-value">${time}</span>
    </div>`;

    if (req.tool_input) {
      html += '<div class="section-title">Tool Input</div>';
      html += jsonBlock(req.tool_input);
    }

    if (req.tool_response) {
      html += '<div class="section-title">Tool Response</div>';
      if (typeof req.tool_response === 'string') {
        html += `<pre class="json-block" style="white-space:pre-wrap">${escHtml(req.tool_response)}</pre>`;
      } else {
        html += jsonBlock(req.tool_response);
      }
    } else if (req._toolResponseChars) {
      html += '<div class="section-title">Tool Response</div>';
      html += `<div class="json-block" style="opacity:0.5">Loading... ${charGauge(req._toolResponseChars)}</div>`;
    }

    html += '<div class="section-title">Raw Hook Data</div>';
    html += jsonBlock(req);

    detailContent.innerHTML = html;
    autoExpandSmallJsonBlocks(detailContent);
    linkifyDetail(detailContent);
    _detailView = { key: `turn:${interaction.id}`, kind: 'hook', id: interaction.id,
                    root: detailContent.firstElementChild, sig: _detailSig(interaction) };
  }

  /* ============================================================
     Request / response detail frame
     ------------------------------------------------------------
     Both panes are always on screen. Each pane's chrome is a single
     sticky row of chips; the body hands its height to whichever
     sections are open, and each open section scrolls internally.
     Opening a big section therefore fills its pane rather than
     growing it and pushing the other pane off screen.
     ============================================================ */

  const VC_DETAIL_PREFS_KEY = 'inspectorDetailPrefs';

  function _loadDetailPrefs() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(VC_DETAIL_PREFS_KEY)) || {}; } catch { /* corrupt or unavailable */ }
    return {
      layout: saved.layout === 'columns' ? 'columns' : 'stacked',
      // fraction of the split taken by the request pane
      ratio: typeof saved.ratio === 'number' && saved.ratio >= 0.2 && saved.ratio <= 0.8 ? saved.ratio : 0.5,
      open: Array.isArray(saved.open) ? saved.open : ['req:info', 'req:messages', 'resp:info', 'resp:blocks'],
      pinned: Array.isArray(saved.pinned) ? saved.pinned : ['req:info', 'resp:info', 'resp:blocks'],
    };
  }

  let _detailPrefs = _loadDetailPrefs();

  function _saveDetailPrefs() {
    try { localStorage.setItem(VC_DETAIL_PREFS_KEY, JSON.stringify(_detailPrefs)); } catch { /* quota / private mode */ }
  }

  const _isSecOpen = key => _detailPrefs.open.includes(key);
  const _isSecPinned = key => _detailPrefs.pinned.includes(key);

  /* Build one chip + its section. `size:'compact'` marks the small info
     grids, which take their natural height instead of an equal share. */
  function _secHtml(key, label, body, opts = {}) {
    const { count = '', size = 'elastic', empty = false, countId = '', placeholder = '' } = opts;
    const open = !empty && _isSecOpen(key);
    // An open section with nothing in it reads as a broken panel. Append a
    // note rather than replacing the body: #response-blocks must survive so
    // streaming can still fill it, and CSS hides the note once it does.
    if (placeholder) {
      body += `<div class="vc-sec-placeholder">${escHtml(placeholder)}</div>`;
    }
    const cls = ['vc-sec'];
    if (open) cls.push('is-open');
    return {
      chip: `<button class="vc-chip${open ? ' is-open' : ''}${_isSecPinned(key) ? ' is-pinned' : ''}${empty ? ' is-empty' : ''}"
               data-sec="${key}"${empty ? ' disabled' : ''}
               title="${escHtml(label)}${empty ? ' — empty' : ' • click to toggle, alt-click to pin'}">
               <span class="vc-chip-pin"></span>${escHtml(label)}${count || countId ? `<span class="vc-chip-count"${countId ? ` id="${countId}"` : ''}>${count}</span>` : ''}
             </button>`,
      sec: `<div class="${cls.join(' ')}" data-sec="${key}" data-size="${size}"${opts.lazyId ? ` data-lazy-detail="${opts.lazyId}"` : ''}>
              <div class="vc-sec-body">${body}</div>
            </div>`,
    };
  }

  const _isLiveInteraction = i => i.status === 'pending' || i.status === 'streaming';

  const _REQ_KNOWN_KEYS = new Set(['model', 'system', 'messages', 'tools', 'tool_choice',
                                   'max_tokens', 'temperature', 'stream', 'thinking']);

  function _otherReqParams(req) {
    const other = {};
    for (const [k, v] of Object.entries(req)) {
      if (!_REQ_KNOWN_KEYS.has(k)) other[k] = v;
    }
    return other;
  }

  function _respCharCount(interaction) {
    const resp = interaction.response || {};
    if (interaction._respChars) return interaction._respChars;
    if (resp.body) return JSON.stringify(resp.body).length;
    if (resp.sseEvents) return resp.sseEvents.reduce((n, e) => n + JSON.stringify(e.data || '').length, 0);
    return 0;
  }

  /* The request pane's sections as descriptors. Kept separate from the markup
     so patchTurnDetail can rebuild a single one without a second copy of any
     of this. */
  function _requestSections(interaction) {
    const req = interaction.request || {};
    const out = [];
    const push = (key, label, body, opts) => out.push({ key, label, body, opts });

    let infoBody = `<div class="info-grid">
      <span class="info-label">Model</span><span class="info-value">${escHtml(req.model || 'unknown')}</span>
      <span class="info-label">Max tokens</span><span class="info-value">${req.max_tokens || '--'}</span>
      <span class="info-label">Temperature</span><span class="info-value">${req.temperature !== undefined ? req.temperature : '--'}</span>
      <span class="info-label">Stream</span><span class="info-value">${interaction.isStreaming ? 'yes' : 'no'}</span>
      <span class="info-label">Endpoint</span><span class="info-value">${escHtml(interaction.originalEndpoint || interaction.endpoint || '/v1/messages')}</span>
      <span class="info-label">Bare</span><span class="info-value">${interaction.bare ? 'yes' : 'no'}</span>
      <span class="info-label">Auto-memory</span><span class="info-value">${interaction.disableAutoMemory ? 'disabled' : 'enabled'}</span>
      <span class="info-label">Time</span><span class="info-value">${new Date(interaction.timestamp).toLocaleTimeString()}</span>
    </div>`;

    if (interaction.subagent && (interaction.subagent.agentType || interaction.subagent.agentId || interaction.subagent.description)) {
      const sa = interaction.subagent;
      infoBody += `<div class="info-grid subagent-info">
        <span class="info-label">Agent</span><span class="info-value" style="color:var(--cyan)">${escHtml(sa.agentType || 'unknown')}</span>
        <span class="info-label">Agent ID</span><span class="info-value">${escHtml(sa.agentId || '--')}</span>
        <span class="info-label">Description</span><span class="info-value">${escHtml(sa.description || '--')}</span>
        <span class="info-label">Sidechain</span><span class="info-value">${sa.isSidechain ? 'yes' : 'no'}</span>
      </div>`;
    }
    push('req:info', 'Info', infoBody, { size: 'compact' });

    if (req.system) {
      const charLen = typeof req.system === 'string' ? req.system.length : JSON.stringify(req.system).length;
      push('req:system', 'System', jsonBlock(req.system), { count: charGauge(charLen) });
    } else if (req._systemChars) {
      push('req:system', 'System', '<div class="json-block" style="opacity:0.5">Loading...</div>',
        { count: charGauge(req._systemChars), lazyId: interaction.id });
    } else {
      push('req:system', 'System', '', { empty: true });
    }

    if (req.messages?.length > 0) {
      const msgChars = JSON.stringify(req.messages).length;
      push('req:messages', 'Messages', renderMessages(req.messages),
        { count: `${req.messages.length} ${charGauge(msgChars)}` });
    } else if (req._messageCount > 0) {
      push('req:messages', 'Messages', '<div class="json-block" style="opacity:0.5">Loading...</div>',
        { count: String(req._messageCount), lazyId: interaction.id });
    } else {
      push('req:messages', 'Messages', '', { empty: true });
    }

    if (req.tools?.length > 0) {
      const toolChars = JSON.stringify(req.tools).length;
      push('req:tools', 'Tools', renderTools(req.tools),
        { count: `${req.tools.length} ${charGauge(toolChars)}` });
    } else if (req._toolCount > 0) {
      push('req:tools', 'Tools', '<div class="json-block" style="opacity:0.5">Loading...</div>',
        { count: String(req._toolCount), lazyId: interaction.id });
    } else {
      push('req:tools', 'Tools', '', { empty: true });
    }

    push('req:thinking', 'Thinking', req.thinking ? jsonBlock(req.thinking) : '', { empty: !req.thinking });

    const otherParams = _otherReqParams(req);
    const hasOther = Object.keys(otherParams).length > 0;
    push('req:other', 'Other', hasOther ? jsonBlock(otherParams) : '', { empty: !hasOther });

    return out;
  }

  /* The response pane's sections. `resp:blocks` comes back empty while the turn
     is live — appendSSEToDetail fills #response-blocks as deltas arrive. */
  function _responseSections(interaction) {
    const resp = interaction.response || {};
    const timing = interaction.timing || {};
    const statusOk = resp.status >= 200 && resp.status < 300;
    const isLive = _isLiveInteraction(interaction);
    const out = [];
    const push = (key, label, body, opts) => out.push({ key, label, body, opts });

    push('resp:info', 'Info', `<div class="info-grid">
      <span class="info-label">Status</span><span class="info-value ${statusOk ? 'status-ok' : 'status-err'}" id="resp-status">${resp.status || '--'}</span>
      <span class="info-label">TTFB</span><span class="info-value" id="resp-ttfb">${timing.ttfb ? formatDuration(timing.ttfb) : '--'}</span>
      <span class="info-label">Duration</span><span class="info-value" id="resp-duration">${timing.duration ? formatDuration(timing.duration) : '--'}</span>
    </div>`, { size: 'compact' });

    let blocksHtml = '';
    if (isLive) {
      // Left empty — replayed via appendSSEToDetail after DOM insertion
    } else if (interaction.isStreaming && resp.sseEvents?.length > 0) {
      blocksHtml += renderAccumulatedBlocks(resp.sseEvents);
    } else if (resp.body) {
      if (!isStandardLlm(interaction)) {
        blocksHtml += `<div class="content-block">
          <div class="content-block-header">Response Body</div>
          <pre class="content-block-body json-block">${escHtml(JSON.stringify(resp.body, null, 2))}</pre>
        </div>`;
      } else if (resp.body.content) {
        const merged = mergeConsecutiveTextBlocks(resp.body.content);
        for (const block of merged) blocksHtml += renderStaticBlock(block);
      }
      if (resp.body.type === 'error') {
        blocksHtml += `<div class="content-block">
          <div class="content-block-header" style="color:var(--red)">Error</div>
          <div class="content-block-body">${escHtml(JSON.stringify(resp.body.error, null, 2))}</div>
        </div>`;
      }
    }
    if (resp.error) {
      blocksHtml += `<div class="content-block">
        <div class="content-block-header" style="color:var(--red)">Proxy Error</div>
        <div class="content-block-body">${escHtml(resp.error)}</div>
      </div>`;
    }

    // Blocks is the response's main content: never chip-disabled, since it
    // fills in live while streaming.
    const respChars = _respCharCount(interaction);
    const blocksPlaceholder = isLive
      ? 'Waiting for the first response block…'
      : (interaction._summary ? 'Loading response…' : 'No response content.');
    push('resp:blocks', 'Blocks',
      `<div id="response-blocks">${blocksHtml}</div>`,
      { count: respChars ? charGauge(respChars) : '', countId: 'resp-char-gauge',
        placeholder: blocksHtml.trim() ? '' : blocksPlaceholder });

    const sseCount = resp.sseEvents?.length || 0;
    const ssePre = sseCount > 0 ? resp.sseEvents.map(e =>
      `<span class="json-key">event:</span> ${escHtml(e.eventType)}\n<span class="json-string">data:</span> ${escHtml(typeof e.data === 'string' ? e.data : JSON.stringify(e.data))}\n`
    ).join('\n') : '';
    // Kept as <details open> so the existing streaming code that unhides it
    // and appends to #raw-sse-pre keeps working unchanged.
    push('resp:sse', 'Raw SSE', `<details id="raw-sse-details" open>
        <summary>Raw SSE Events (<span id="raw-sse-count">${sseCount}</span>)</summary>
        <pre class="json-block no-linkify" id="raw-sse-pre">${ssePre}</pre>
      </details>`, { count: sseCount ? String(sseCount) : '', countId: 'sse-chip-count', empty: !isLive && sseCount === 0 });

    return out;
  }

  /* Fingerprint of every part the detail frame shows, so a re-select can patch
     the few that moved instead of rebuilding the panel. Deliberately shallow:
     this runs on every inbound hook, so it counts and flags rather than
     serialising the request — a turn's messages and tools are fixed once sent,
     and the only transition that matters is a trimmed summary being replaced by
     the real thing. */
  function _detailSig(interaction) {
    const req = interaction.request || {};
    const resp = interaction.response || {};
    const timing = interaction.timing || {};
    const bulk = v => v == null ? 'none'
      : (typeof v === 'string' ? `s${v.length}` : `o${Object.keys(v).length}`);
    const sub = interaction.subagent;
    return {
      status: interaction.status || '',
      respStatus: resp.status || 0,
      ttfb: timing.ttfb || 0,
      duration: timing.duration || 0,
      usage: interaction.usage ? JSON.stringify(interaction.usage) : '',
      respChars: _respCharCount(interaction),
      sseCount: resp.sseEvents?.length || 0,
      subagent: sub ? `${sub.agentId}|${sub.agentType}|${sub.description}|${sub.isSidechain}` : '',
      model: req.model || '',
      secs: {
        'req:info': `${req.model}|${req.max_tokens}|${req.temperature}|${interaction.isStreaming}|${sub ? sub.agentId : ''}`,
        'req:system': `${bulk(req.system)}|${req._systemChars || 0}`,
        'req:messages': `${req.messages?.length ?? -1}|${req._messageCount || 0}`,
        'req:tools': `${req.tools?.length ?? -1}|${req._toolCount || 0}`,
        'req:thinking': req.thinking ? '1' : '0',
        'req:other': String(Object.keys(_otherReqParams(req)).length),
        'resp:blocks': `${bulk(resp.body)}|${resp.error ? 1 : 0}|${resp.sseEvents?.length || 0}|${interaction._summary ? 1 : 0}`,
        'resp:sse': String(resp.sseEvents?.length || 0),
      },
    };
  }

  /* Run the post-insert passes over a freshly written subtree. */
  function _decorateSection(el) {
    autoExpandSmallJsonBlocks(el);
    processMarkdownBlocks(el);
    linkifyDetail(el);
    _bindLazySections(el, true);
  }

  /* Opening a section whose data was trimmed re-requests it. `self` covers the
     single-section rebuild, where the .vc-sec element *is* the root. */
  function _bindLazySections(root, self = false) {
    const els = self && root.matches?.('[data-lazy-detail]')
      ? [root] : root.querySelectorAll('[data-lazy-detail]');
    for (const el of els) {
      el.addEventListener('vc-sec-open', () => {
        const id = el.dataset.lazyDetail;
        if (!_pendingDetailRequests.has(id)) {
          _pendingDetailRequests.add(id);
          sendWs({ type: 'interaction:getDetail', id });
        }
      }, { once: true });
      // Already open on render — fetch straight away
      if (el.classList.contains('is-open')) el.dispatchEvent(new CustomEvent('vc-sec-open'));
    }
  }

  /* Rewrite one already-rendered section in place: body, chip count and the
     empty/open state. The .vc-sec element itself is kept, so an open section
     holds its scroll position instead of jumping back to the top. */
  function _applySection(root, { key, body, opts = {} }) {
    const sec = root.querySelector(`.vc-sec[data-sec="${CSS.escape(key)}"]`);
    const chip = root.querySelector(`.vc-chip[data-sec="${CSS.escape(key)}"]`);
    if (!sec || !chip) return;
    const { count = '', empty = false, countId = '', placeholder = '' } = opts;

    const bodyEl = sec.querySelector('.vc-sec-body');
    if (bodyEl) {
      bodyEl.innerHTML = body + (placeholder ? `<div class="vc-sec-placeholder">${escHtml(placeholder)}</div>` : '');
    }

    if (opts.lazyId) sec.dataset.lazyDetail = opts.lazyId;
    else delete sec.dataset.lazyDetail;

    chip.classList.toggle('is-empty', empty);
    chip.disabled = empty;
    let countEl = chip.querySelector('.vc-chip-count');
    if (count || countId) {
      if (!countEl) {
        countEl = document.createElement('span');
        countEl.className = 'vc-chip-count';
        chip.appendChild(countEl);
      }
      if (countId) countEl.id = countId;
      countEl.innerHTML = count;
    } else if (countEl) {
      countEl.remove();
    }

    const open = !empty && _isSecOpen(key);
    sec.classList.toggle('is-open', open);
    chip.classList.toggle('is-open', open);

    _decorateSection(sec);
  }

  /* Update the parts of an already-rendered turn that actually changed. Called
     instead of renderTurnDetail whenever the same turn is re-selected — an
     inbound hook, a usage update or a lazy detail arriving must not tear down
     a panel the user is reading from. */
  function patchTurnDetail(interaction) {
    const view = _detailView;
    const root = view?.root;
    if (!root) return;

    const sig = _detailSig(interaction);
    const prev = view.sig;
    const resp = interaction.response || {};
    const timing = interaction.timing || {};
    const isLive = _isLiveInteraction(interaction);
    const statusOk = resp.status >= 200 && resp.status < 300;

    if (sig.status !== prev.status || sig.respStatus !== prev.respStatus) {
      const dot = root.querySelector('.vc-dot');
      if (dot) dot.className = `vc-dot ${isLive ? 'is-live' : (statusOk ? 'is-ok' : 'is-bad')}`;
      const chipEl = root.querySelector('#resp-status-chip');
      if (chipEl) { chipEl.textContent = resp.status || '--'; chipEl.className = statusOk ? 'status-ok' : 'status-err'; }
      const statusEl = root.querySelector('#resp-status');
      if (statusEl) { statusEl.textContent = resp.status || '--'; statusEl.className = `info-value ${statusOk ? 'status-ok' : 'status-err'}`; }
    }

    if (sig.model !== prev.model) {
      const modelEl = root.querySelector('.vc-detail-model');
      if (modelEl) modelEl.textContent = interaction.request?.model
        ? interaction.request.model.replace('claude-', '').split('-202')[0] : 'unknown';
    }

    if (sig.subagent !== prev.subagent) {
      const titleEl = root.querySelector('.vc-detail-title');
      const modelEl = titleEl?.querySelector('.vc-detail-model');
      if (titleEl && modelEl) {
        const label = interaction.subagent
          ? (getSubagentLabel(interaction.subagent) || interaction.subagent.agentType || 'Agent')
          : 'Main Thread';
        // The label is the bare text node between the dot and the model chip.
        for (const node of [...titleEl.childNodes]) {
          if (node.nodeType === Node.TEXT_NODE) node.remove();
        }
        modelEl.before(document.createTextNode(` ${label} `));
      }
    }

    if (sig.ttfb !== prev.ttfb) {
      const el = root.querySelector('#resp-ttfb');
      if (el) el.textContent = timing.ttfb ? formatDuration(timing.ttfb) : '--';
    }
    if (sig.duration !== prev.duration) {
      const el = root.querySelector('#resp-duration');
      if (el) el.textContent = timing.duration ? formatDuration(timing.duration) : '--';
    }
    if (sig.usage !== prev.usage && interaction.usage) {
      updateUsageDisplay(interaction.usage, interaction.pricing);
    }
    if (sig.respChars !== prev.respChars) {
      const el = root.querySelector('#resp-char-gauge');
      if (el && sig.respChars) el.innerHTML = charGauge(sig.respChars);
    }

    /* #response-blocks and #raw-sse-pre belong to appendSSEToDetail once a turn
       has streamed into this panel — rebuilding them would drop the live content
       and the gauges it maintains. Only a view that never streamed here (a
       completed turn whose body or SSE log arrived afterwards) gets them
       replaced. resp:info is patched field-by-field above. */
    const skip = key => key === 'resp:info' || (view.streamed && key.startsWith('resp:'));
    const changed = Object.keys(sig.secs)
      .filter(key => !skip(key) && sig.secs[key] !== prev.secs[key]);

    // Section bodies are only built when one actually moved — the usual trigger
    // being a lazily-fetched detail replacing a "Loading..." body.
    if (changed.length) {
      const byKey = new Map();
      for (const desc of _requestSections(interaction)) byKey.set(desc.key, desc);
      if (!view.streamed) for (const desc of _responseSections(interaction)) byKey.set(desc.key, desc);
      for (const key of changed) {
        const desc = byKey.get(key);
        if (desc) _applySection(root, desc);
      }
    }

    view.sig = sig;
  }

  function renderTurnDetail(interaction) {
    if (interaction.isMcp) {
      return renderMcpCallDetail(interaction);
    }
    if (interaction.isHook) {
      return renderHookCallDetail(interaction);
    }

    const req = interaction.request || {};
    const resp = interaction.response || {};
    const shortModel = (req.model || 'unknown').replace('claude-', '').split('-202')[0];
    const statusOk = resp.status >= 200 && resp.status < 300;
    const _isLive = _isLiveInteraction(interaction);

    const reqChips = [], reqSecs = [], respChips = [], respSecs = [];
    for (const { key, label, body, opts } of _requestSections(interaction)) {
      const { chip, sec } = _secHtml(key, label, body, opts);
      reqChips.push(chip); reqSecs.push(sec);
    }
    for (const { key, label, body, opts } of _responseSections(interaction)) {
      const { chip, sec } = _secHtml(key, label, body, opts);
      respChips.push(chip); respSecs.push(sec);
    }

    /* ---------------- frame ---------------- */
    const layout = _detailPrefs.layout;

    const html = `
      <div class="vc-detail">
        <div class="vc-detail-toolbar">
          <span class="vc-detail-title">
            <span class="vc-dot ${_isLive ? 'is-live' : (statusOk ? 'is-ok' : 'is-bad')}"></span>
            ${escHtml(interaction.subagent ? (getSubagentLabel(interaction.subagent) || interaction.subagent.agentType || 'Agent') : 'Main Thread')}
            <span class="vc-detail-model">${escHtml(shortModel)}</span>
          </span>
          <span class="vc-detail-tools">
            <button class="vc-tool-btn" id="vc-layout-toggle"
                    title="Switch to ${layout === 'stacked' ? 'side-by-side' : 'stacked'} layout (L)">
              ${layout === 'stacked'
                ? '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1" y="1" width="12" height="12" rx="1.5"/><line x1="7" y1="1" x2="7" y2="13"/></svg>'
                : '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1" y="1" width="12" height="12" rx="1.5"/><line x1="1" y1="7" x2="13" y2="7"/></svg>'}
              ${layout === 'stacked' ? 'Columns' : 'Stacked'}
            </button>
            <button class="vc-tool-btn curl-btn" data-interaction-id="${interaction.id}">cURL</button>
          </span>
        </div>
        <div class="vc-split" data-layout="${layout}">
          <section class="vc-pane vc-pane-request">
            <header class="vc-pane-head">
              <span class="vc-pane-label">Request</span>
              <nav class="vc-chips">${reqChips.join('')}</nav>
            </header>
            <div class="vc-pane-body request-panel">
              <div class="vc-pane-empty">No request section open — pick one above.</div>
              ${reqSecs.join('')}
            </div>
          </section>
          <div class="vc-split-resizer" role="separator" tabindex="0"
               title="Drag to resize · double-click to even out"></div>
          <section class="vc-pane vc-pane-response">
            <header class="vc-pane-head">
              <span class="vc-pane-label">Response</span>
              <span class="vc-pane-meta">
                <span class="${statusOk ? 'status-ok' : 'status-err'}" id="resp-status-chip">${resp.status || '--'}</span>
              </span>
              <nav class="vc-chips">${respChips.join('')}</nav>
            </header>
            <div class="vc-pane-body response-panel">
              <div class="vc-pane-empty">No response section open — pick one above.</div>
              ${respSecs.join('')}
            </div>
          </section>
        </div>
      </div>`;

    detailContent.innerHTML = html;

    const splitEl = detailContent.querySelector('.vc-split');
    _applySplitRatio(splitEl, _detailPrefs.ratio);
    _bindDetailFrame(detailContent, splitEl);

    autoExpandSmallJsonBlocks(detailContent);
    processMarkdownBlocks(detailContent);
    linkifyDetail(detailContent);
    _bindLazySections(detailContent);

    _detailView = {
      key: `turn:${interaction.id}`, kind: 'llm', id: interaction.id,
      root: detailContent.querySelector('.vc-detail'),
      sig: _detailSig(interaction), streamed: false,
    };

    if (_isLive && interaction.response?.sseEvents?.length > 0) {
      for (const event of interaction.response.sseEvents) {
        appendSSEToDetail(event, interaction);
      }
    }
  }

  /* A pane with every section closed stays blank for every interaction
     selected afterwards — the state is persisted. If one ends up with
     nothing open, open its first section that actually has content. */
  function _ensurePanesNotBlank(root) {
    let changed = false;
    for (const pane of root.querySelectorAll('.vc-pane')) {
      if (pane.querySelector('.vc-sec.is-open')) continue;
      const open = (sec) => {
        const key = sec.dataset.sec;
        const chip = pane.querySelector(`.vc-chip[data-sec="${CSS.escape(key)}"]`);
        if (!chip || chip.classList.contains('is-empty')) return false;
        sec.classList.add('is-open');
        chip.classList.add('is-open');
        if (!_detailPrefs.open.includes(key)) _detailPrefs.open.push(key);
        changed = true;
        return true;
      };
      const secs = [...pane.querySelectorAll('.vc-sec')];
      // The compact info grid plus the first real content section — an info
      // row on its own would leave most of the pane blank.
      secs.filter(x => x.dataset.size === 'compact').some(open);
      secs.filter(x => x.dataset.size !== 'compact').some(open);
    }
    if (changed) _saveDetailPrefs();
  }

  /* Write the split ratio as flex-basis on both panes. */
  function _applySplitRatio(splitEl, ratio) {
    if (!splitEl) return;
    const panes = splitEl.querySelectorAll(':scope > .vc-pane');
    if (panes.length < 2) return;
    panes[0].style.flex = `1 1 ${(ratio * 100).toFixed(2)}%`;
    panes[1].style.flex = `1 1 ${((1 - ratio) * 100).toFixed(2)}%`;
  }

  /* Chip toggling, pinning, layout toggle and the drag resizer. */
  function _bindDetailFrame(root, splitEl) {
    _ensurePanesNotBlank(root);

    for (const chip of root.querySelectorAll('.vc-chip')) {
      chip.addEventListener('click', (e) => {
        const key = chip.dataset.sec;
        if (!key || chip.classList.contains('is-empty')) return;

        // Alt-click (or clicking the pin dot) toggles pinning instead.
        if (e.altKey || e.target.classList.contains('vc-chip-pin')) {
          const i = _detailPrefs.pinned.indexOf(key);
          if (i >= 0) _detailPrefs.pinned.splice(i, 1);
          else _detailPrefs.pinned.push(key);
          chip.classList.toggle('is-pinned');
          _saveDetailPrefs();
          return;
        }

        const pane = chip.closest('.vc-pane');
        const sec = pane?.querySelector(`.vc-sec[data-sec="${CSS.escape(key)}"]`);
        if (!sec) return;
        const opening = !sec.classList.contains('is-open');

        if (opening) {
          // Solo: close every other unpinned section in this pane, so the
          // one being opened gets the pane's height instead of a sliver.
          for (const other of pane.querySelectorAll('.vc-sec.is-open')) {
            const otherKey = other.dataset.sec;
            if (otherKey === key || _isSecPinned(otherKey)) continue;
            other.classList.remove('is-open');
            pane.querySelector(`.vc-chip[data-sec="${CSS.escape(otherKey)}"]`)?.classList.remove('is-open');
            const oi = _detailPrefs.open.indexOf(otherKey);
            if (oi >= 0) _detailPrefs.open.splice(oi, 1);
          }
          sec.classList.add('is-open');
          chip.classList.add('is-open');
          if (!_detailPrefs.open.includes(key)) _detailPrefs.open.push(key);
          sec.dispatchEvent(new CustomEvent('vc-sec-open'));
        } else {
          sec.classList.remove('is-open');
          chip.classList.remove('is-open');
          const i = _detailPrefs.open.indexOf(key);
          if (i >= 0) _detailPrefs.open.splice(i, 1);
        }
        _saveDetailPrefs();
      });
    }

    const layoutBtn = root.querySelector('#vc-layout-toggle');
    if (layoutBtn) layoutBtn.addEventListener('click', toggleDetailLayout);

    const resizer = root.querySelector('.vc-split-resizer');
    if (resizer && splitEl) _bindSplitResizer(resizer, splitEl);
  }

  function toggleDetailLayout() {
    _detailPrefs.layout = _detailPrefs.layout === 'stacked' ? 'columns' : 'stacked';
    _saveDetailPrefs();
    if (state.selection) select(state.selection);
  }

  function _bindSplitResizer(resizer, splitEl) {
    let dragging = false;

    const ratioFromEvent = (e) => {
      const rect = splitEl.getBoundingClientRect();
      const vertical = getComputedStyle(splitEl).flexDirection === 'column';
      const raw = vertical
        ? (e.clientY - rect.top) / rect.height
        : (e.clientX - rect.left) / rect.width;
      return Math.min(0.88, Math.max(0.12, raw));
    };

    const onMove = (e) => {
      if (!dragging) return;
      e.preventDefault();
      _detailPrefs.ratio = ratioFromEvent(e);
      _applySplitRatio(splitEl, _detailPrefs.ratio);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      _saveDetailPrefs();
    };

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      resizer.classList.add('dragging');
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    resizer.addEventListener('dblclick', () => {
      _detailPrefs.ratio = 0.5;
      _applySplitRatio(splitEl, 0.5);
      _saveDetailPrefs();
    });

    // Keyboard: the separator is focusable, arrows nudge it 4% at a time.
    resizer.addEventListener('keydown', (e) => {
      const vertical = getComputedStyle(splitEl).flexDirection === 'column';
      const dec = vertical ? 'ArrowUp' : 'ArrowLeft';
      const inc = vertical ? 'ArrowDown' : 'ArrowRight';
      if (e.key !== dec && e.key !== inc) return;
      e.preventDefault();
      _detailPrefs.ratio = Math.min(0.88, Math.max(0.12, _detailPrefs.ratio + (e.key === inc ? 0.04 : -0.04)));
      _applySplitRatio(splitEl, _detailPrefs.ratio);
      _saveDetailPrefs();
    });
  }

  function renderToolDetail(interaction, toolIndex) {
    const toolCalls = extractToolCalls(interaction);
    const tc = toolCalls[toolIndex];
    if (!tc) { detailContent.innerHTML = '<p>Tool call not found.</p>'; return; }

    let html = '';
    const isSkill = tc.name === 'Skill' && tc.input?.skill;

    html += `<div class="section-title">${isSkill ? 'Skill Invocation' : 'Tool Call'}</div>`;
    html += `<div class="info-grid">
      <span class="info-label">${isSkill ? 'Skill' : 'Tool'}</span><span class="info-value" style="color:var(${isSkill ? '--cyan' : '--purple'});font-weight:700">${isSkill ? '/' + escHtml(tc.input.skill) : escHtml(tc.name)}</span>`;
    if (isSkill && tc.input.args) {
      html += `<span class="info-label">Arguments</span><span class="info-value">${escHtml(tc.input.args)}</span>`;
    }
    const turnNo = llmTurnNumber(interaction);
    html += `<span class="info-label">Status</span><span class="info-value">${tc.status}</span>
      <span class="info-label">Turn</span><span class="info-value"><a href="#" class="turn-link" data-turn-id="${interaction.id}">${turnNo != null ? 'Turn ' + turnNo : 'this turn'}</a></span>
    </div>`;

    const media = toolMediaPaths(tc.input);
    if (media.length > 0) {
      html += `<div class="section-title">Preview</div>`;
      html += `<div class="tool-media-row">${media.map(mediaPreviewHtml).join('')}</div>`;
    }

    html += `<div class="section-title">Input</div>`;
    if (tc.input) {
      html += `${jsonBlock(tc.input)}`;
    } else if (tc.inputJson) {
      html += `<pre class="json-block">${escHtml(tc.inputJson)}`;
    } else {
      html += `<p class="info-label">No input data</p>`;
    }

    const result = findToolResult(tc.id);
    if (result) {
      html += `<div class="section-title">Result</div>`;
      if (result.is_error) {
        html += `<div class="content-block"><div class="content-block-header" style="color:var(--red)">Error Result</div>`;
      } else {
        html += `<div class="content-block"><div class="content-block-header">Tool Result</div>`;
      }
      html += `<div class="content-block-body">`;

      const content = result.content;
      if (typeof content === 'string') {
        html += `<pre style="white-space:pre-wrap">${escHtml(content)}`;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            html += `<pre style="white-space:pre-wrap">${escHtml(block.text || '')}`;
          } else if (block.type === 'image') {
            // Base64 payloads are truncated on capture — when the call names a
            // file on disk we show it from there instead (see Preview above).
            const note = media.length > 0 ? ' — see Preview above' : '';
            html += `<p class="info-label">[image: ${escHtml(block.source?.media_type || 'unknown')}${note}]</p>`;
          } else {
            html += `${jsonBlock(block)}`;
          }
        }
      } else if (content) {
        html += `${jsonBlock(content)}`;
      }

      html += `</div></div>`;
    } else {
      html += `<div class="section-title">Result</div>`;
      html += `<p class="info-label">No result found (tool may still be executing or result not yet sent)</p>`;
    }

    detailContent.innerHTML = html;
    autoExpandSmallJsonBlocks(detailContent);
    processMarkdownBlocks(detailContent);
    linkifyDetail(detailContent);
    bindMediaPreviews(detailContent);
    _detailView = { key: `tool:${interaction.id}:${toolIndex}`, kind: 'tool', id: interaction.id,
                    toolIndex, root: detailContent.firstElementChild, sig: _detailSig(interaction) };

    const link = detailContent.querySelector('.turn-link');
    if (link) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        select({ type: 'turn', id: link.dataset.turnId }, { userClick: true });
      });
    }
  }

  // --- Inline media previews for tool calls that name a file on disk ---

  const _TOOL_PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path',
                           'image_path', 'video_path', 'audio_path', 'output_path'];

  function toolMediaPaths(input) {
    if (!input || typeof input !== 'object') return [];
    const out = [];
    for (const key of _TOOL_PATH_KEYS) {
      const v = input[key];
      if (typeof v !== 'string' || !v.startsWith('/')) continue;
      const ext = (v.match(/\.([^./]+)$/) || [])[1]?.toLowerCase() || '';
      const category = fileCategory(ext);
      if (category !== 'image' && category !== 'video' && category !== 'audio') continue;
      if (!out.some(e => e.path === v)) out.push({ path: v, category });
    }
    return out;
  }

  function mediaPreviewHtml(entry) {
    const rawUrl = '/api/raw-file?path=' + encodeURIComponent(entry.path);
    const name = entry.path.split('/').pop();
    let inner;
    if (entry.category === 'image') {
      inner = `<img src="${escHtml(rawUrl)}" alt="${escHtml(name)}" loading="lazy">`;
    } else if (entry.category === 'video') {
      inner = `<video src="${escHtml('/api/video-stream?path=' + encodeURIComponent(entry.path))}" controls preload="metadata"></video>`;
    } else {
      inner = `<audio src="${escHtml(rawUrl)}" controls preload="metadata"></audio>`;
    }
    return `<figure class="tool-media-preview" data-preview-path="${escHtml(entry.path)}">
      ${inner}
      <figcaption title="Open preview">${escHtml(name)}</figcaption>
    </figure>`;
  }

  function bindMediaPreviews(root) {
    for (const el of root.querySelectorAll('.tool-media-preview')) {
      el.addEventListener('click', (e) => {
        // Let the native transport controls work; the caption opens the modal.
        if (e.target.closest('video, audio')) return;
        e.preventDefault();
        openFilePreview(el.dataset.previewPath);
      });
      const img = el.querySelector('img');
      if (img) img.addEventListener('error', () => el.classList.add('tool-media-missing'));
    }
  }

  // ============================================================
  // RENDERING HELPERS
  // ============================================================

  function mergeConsecutiveTextBlocks(blocks) {
    const merged = [];
    for (const block of blocks) {
      if (block.type === 'text') {
        const prev = merged[merged.length - 1];
        if (prev && prev.type === 'text') {
          prev.text = (prev.text || '') + '\n' + (block.text || '');
          continue;
        }
      }
      merged.push({ ...block });
    }
    return merged;
  }

  function renderAccumulatedBlocks(events) {
    const blocks = [];
    let currentBlock = null;

    for (const event of events) {
      if (event.eventType === 'content_block_start') {
        const cb = event.data?.content_block;
        currentBlock = { type: cb?.type || 'unknown', name: cb?.name || '', text: '', index: event.data?.index };
        blocks.push(currentBlock);
      } else if (event.eventType === 'content_block_delta' && currentBlock) {
        const delta = event.data?.delta;
        if (delta?.type === 'text_delta') currentBlock.text += delta.text || '';
        else if (delta?.type === 'thinking_delta') {
          currentBlock.text += delta.thinking || '';
          if (delta.estimated_tokens) currentBlock.estimatedTokens = (currentBlock.estimatedTokens || 0) + delta.estimated_tokens;
        }
        else if (delta?.type === 'input_json_delta') currentBlock.text += delta.partial_json || '';
      } else if (event.eventType === 'content_block_stop') {
        currentBlock = null;
      }
    }

    const mergedBlocks = mergeConsecutiveTextBlocks(blocks);
    return mergedBlocks.map(b => {
      if (b.type === 'thinking') {
        const fmt = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
        const tkn = b.estimatedTokens ? ` <span class="thinking-tokens">${fmt(b.estimatedTokens)} tokens</span>` : '';
        return `<div class="content-block">
          <div class="content-block-header">Thinking${tkn}</div>
          <div class="content-block-body thinking">${escHtml(b.text)}</div>
        </div>`;
      } else if (b.type === 'text') {
        return `<div class="content-block-body markdown-body" data-md-pending="${escHtml(b.text)}">${escHtml(b.text)}</div>`;
      } else if (b.type === 'tool_use') {
        let inputHtml, parsedInput = null;
        try { parsedInput = JSON.parse(b.text); inputHtml = jsonBlock(parsedInput); } catch { inputHtml = `<pre class="json-block">${escHtml(b.text)}</pre>`; }
        const summary = truncate(toolSummary(b.name, parsedInput), 120);
        return `<div class="content-block-body tool-use">
          <div class="tool-name" data-tool-summary="${escHtml(summary)}"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5L8 6L4.5 9.5"/></svg>${escHtml(b.name)}</div>
          ${inputHtml}
        </div>`;
      }
      return `<div class="content-block">
        <div class="content-block-header">${escHtml(b.type)}</div>
        <div class="content-block-body">${escHtml(b.text)}</div>
      </div>`;
    }).join('');
  }

  // Post-process: render markdown in elements with data-md-pending attribute
  function processMarkdownBlocks(root) {
    const els = (root || document).querySelectorAll('[data-md-pending]');
    for (const el of els) {
      const text = el.getAttribute('data-md-pending');
      el.removeAttribute('data-md-pending');
      if (text) renderMarkdown(text, el);
    }
  }

  function renderStaticBlock(block) {
    if (block.type === 'text') {
      return `<div class="content-block-body markdown-body" data-md-pending="${escHtml(block.text || '')}">${escHtml(block.text || '')}</div>`;
    }
    if (block.type === 'thinking') {
      const fmt = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
      const tkn = block.estimated_tokens ? ` <span class="thinking-tokens">${fmt(block.estimated_tokens)} tokens</span>` : '';
      return `<div class="content-block">
        <div class="content-block-header">Thinking${tkn}</div>
        <div class="content-block-body thinking">${escHtml(block.thinking || '')}</div>
      </div>`;
    }
    if (block.type === 'tool_use') {
      const summary = truncate(toolSummary(block.name, block.input), 120);
      return `<div class="content-block-body tool-use">
        <div class="tool-name" data-tool-summary="${escHtml(summary)}"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5L8 6L4.5 9.5"/></svg>${escHtml(block.name || '')}</div>
        ${jsonBlock(block.input || {})}
      </div>`;
    }
    return `<div class="content-block">
      <div class="content-block-header">${escHtml(block.type)}</div>
      ${jsonBlock(block)}
    </div>`;
  }

  /* Inline size bar for a sheet row. `max` is the chars value the bar is
     full at — messages and tool schemas live on very different scales, so
     each caller picks the one that makes its bars readable. */
  function msgSizeGauge(chars, max = 80000) {
    const pct = Math.min(chars / max, 1);
    const w = 30, h = 8, fill = Math.max(pct * w, 1);
    const hue = Math.round((1 - pct) * 120);
    const sat = pct > 0.9 ? '80%' : '70%';
    const lit = pct > 0.9 ? '30%' : '45%';
    const color = `hsl(${hue},${sat},${lit})`;
    const label = chars >= 1000 ? (chars / 1000).toFixed(1) + 'k' : String(chars);
    return `<span class="msg-size-gauge" title="${chars.toLocaleString()} chars"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="vertical-align:middle;margin:0 4px"><rect width="${w}" height="${h}" rx="2" fill="var(--bg)" stroke="var(--border)" stroke-width="0.5"/><rect width="${fill}" height="${h}" rx="2" fill="${color}"/></svg><span style="font-size:10px;color:${color}">${label}</span></span>`;
  }

  /* ---- sheet: messages and tools share one spreadsheet render ----
     Three columns — row number, size gauge, first chars of the content —
     and a row expands in place into the same JSON tree used elsewhere in
     the frame, capped and scrollable so one big row can't take the pane. */
  function sheet(contentLabel, rows) {
    return `<div class="vc-sheet">
      <div class="vc-sheet-head">
        <span class="vc-sheet-c vc-sheet-n">#</span>
        <span class="vc-sheet-c vc-sheet-size">chars</span>
        <span class="vc-sheet-c vc-sheet-body">${escHtml(contentLabel)}</span>
      </div>
      ${rows.join('')}
    </div>`;
  }

  function sheetRow(idx, chars, max, tag, tagCls, text, detailHtml) {
    return `<details class="vc-sheet-row">
      <summary>
        <span class="vc-sheet-c vc-sheet-n">${idx}</span>
        <span class="vc-sheet-c vc-sheet-size">${msgSizeGauge(chars, max)}</span>
        <span class="vc-sheet-c vc-sheet-body">${tag ? `<span class="vc-sheet-tag ${tagCls}">${escHtml(tag)}</span>` : ''}<span class="vc-sheet-text">${escHtml(text)}</span></span>
      </summary>
      <div class="vc-sheet-detail">${detailHtml}</div>
    </details>`;
  }

  const MSG_GAUGE_MAX = 80000;
  const TOOL_GAUGE_MAX = 8000;

  function renderMessages(messages) {
    const rows = messages.map((msg, idx) => {
      const role = msg.role || 'unknown';
      let preview = '';
      if (typeof msg.content === 'string') {
        preview = msg.content.slice(0, 200);
      } else if (Array.isArray(msg.content)) {
        preview = msg.content.map(b => {
          if (b.type === 'text') return (b.text || '').slice(0, 80);
          if (b.type === 'tool_use') return `[tool_use: ${b.name}]`;
          if (b.type === 'tool_result') return `[tool_result: ${b.tool_use_id}]`;
          if (b.type === 'image') return '[image]';
          return `[${b.type}]`;
        }).join(' | ');
      }
      return sheetRow(idx, JSON.stringify(msg).length, MSG_GAUGE_MAX,
        role, `is-${role.replace(/[^a-z]/gi, '').toLowerCase()}`,
        truncate(preview, 200), jsonBlock(msg));
    });
    return sheet('role / content', rows);
  }

  function renderTools(tools) {
    const rows = tools.map((tool, idx) => sheetRow(
      idx, JSON.stringify(tool).length, TOOL_GAUGE_MAX,
      tool.name || 'unnamed', 'is-tool',
      truncate(tool.description || '', 200), jsonBlock(tool)));
    return sheet('name / description', rows);
  }

  function compactTokens(usage) {
    if (!usage) return '';
    const fmt = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
    const arrowUp = '<svg width="7" height="7" viewBox="0 0 8 8"><path d="M4 1L7 5H1Z" fill="currentColor"/></svg>';
    const arrowDn = '<svg width="7" height="7" viewBox="0 0 8 8"><path d="M4 7L1 3H7Z" fill="currentColor"/></svg>';
    const cacheIcon = '<svg width="8" height="8" viewBox="0 0 10 10"><ellipse cx="5" cy="2.5" rx="4" ry="1.8" fill="none" stroke="currentColor" stroke-width="0.9"/><path d="M1 2.5v2.2c0 1 1.8 1.8 4 1.8s4-.8 4-1.8V2.5" fill="none" stroke="currentColor" stroke-width="0.9"/><path d="M1 4.7v2.2c0 1 1.8 1.8 4 1.8s4-.8 4-1.8V4.7" fill="none" stroke="currentColor" stroke-width="0.9"/></svg>';
    const exact = (n, what) => ` title="${n.toLocaleString()} ${what}"`;
    let html = '';
    if (usage.input_tokens != null) html += `<span class="et-in"${exact(usage.input_tokens, 'input')}>${arrowUp} ${fmt(usage.input_tokens)}</span>`;
    if (usage.output_tokens != null) html += `<span class="et-out"${exact(usage.output_tokens, 'output')}>${arrowDn} ${fmt(usage.output_tokens)}</span>`;
    if (usage.cache_creation_input_tokens) html += `<span class="et-cw"${exact(usage.cache_creation_input_tokens, 'cache write')}>${cacheIcon} ${fmt(usage.cache_creation_input_tokens)}w</span>`;
    if (usage.cache_read_input_tokens) html += `<span class="et-cr"${exact(usage.cache_read_input_tokens, 'cache read')}>${cacheIcon} ${fmt(usage.cache_read_input_tokens)}r</span>`;
    return html;
  }

  function durationGauge(ms) {
    if (ms == null) return '--';
    const secs = ms / 1000;
    const pct = Math.max(0, Math.min(secs / 500, 1));
    const w = 24, h = 7, fill = pct * w;
    const hue = Math.round((1 - pct) * 120);
    const sat = pct > 0.9 ? '80%' : '70%';
    const lit = pct > 0.9 ? '30%' : '45%';
    const color = `hsl(${hue},${sat},${lit})`;
    return `<span class="entry-duration-gauge"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="2" fill="var(--bg)" stroke="var(--border)" stroke-width="0.5"/><rect width="${fill}" height="${h}" rx="2" fill="${color}"/></svg><span class="entry-duration-label" style="color:${color}">${formatDuration(ms)}</span></span>`;
  }

  function turnCostGauge(cost) {
    if (cost == null) return '';
    const pct = Math.min(cost / 1, 1);
    const w = 24, h = 7, fill = pct * w;
    const hue = Math.round((1 - pct) * 120);
    const sat = pct > 0.9 ? '80%' : '70%';
    const lit = pct > 0.9 ? '30%' : '45%';
    const color = `hsl(${hue},${sat},${lit})`;
    return `<span class="entry-cost-gauge"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="2" fill="var(--bg)" stroke="var(--border)" stroke-width="0.5"/><rect width="${fill}" height="${h}" rx="2" fill="${color}"/></svg><span class="entry-cost-label" style="color:${color}">${formatCost(cost)}</span></span>`;
  }

  function charGauge(chars, suffix) {
    // chars in thousands; gauge 0-200k, green->yellow->red->darkred
    const k = chars / 1000;
    const pct = Math.min(k / 200, 1);
    const w = 40, h = 10, fill = pct * w;
    // green(120) -> yellow(60) -> red(0) -> darkred
    const hue = Math.round((1 - pct) * 120);
    const sat = pct > 0.9 ? '80%' : '70%';
    const lit = pct > 0.9 ? '30%' : '45%';
    const color = `hsl(${hue},${sat},${lit})`;
    const trail = suffix ? `<span class="char-gauge-suffix">${suffix}</span>` : '';
    return `<span class="char-gauge"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="2" fill="var(--bg)" stroke="var(--border)" stroke-width="0.5"/><rect width="${fill}" height="${h}" rx="2" fill="${color}"/></svg><span class="char-count">${chars.toLocaleString()}</span>${trail}</span>`;
  }

  function computeCost(usage, pricing) {
    if (!pricing || !usage) return null;
    let cost = 0;
    cost += (usage.input_tokens || 0) * (pricing.inputCostPerMTok || 0) / 1e6;
    cost += (usage.output_tokens || 0) * (pricing.outputCostPerMTok || 0) / 1e6;
    cost += (usage.cache_read_input_tokens || 0) * (pricing.cacheReadCostPerMTok || pricing.inputCostPerMTok || 0) / 1e6;
    cost += (usage.cache_creation_input_tokens || 0) * (pricing.cacheCreateCostPerMTok || pricing.inputCostPerMTok || 0) / 1e6;
    return cost;
  }

  function formatCost(cost) {
    if (cost == null) return '';
    if (cost < 0.001) return '$' + cost.toFixed(6);
    if (cost < 0.01) return '$' + cost.toFixed(4);
    if (cost < 1) return '$' + cost.toFixed(3);
    return '$' + cost.toFixed(2);
  }

  function renderUsage(usage, pricing) {
    let html = '';
    if (usage.input_tokens !== undefined)
      html += `<div class="usage-item"><span class="usage-dot input"></span>${usage.input_tokens.toLocaleString()} input</div>`;
    if (usage.cache_creation_input_tokens)
      html += `<div class="usage-item"><span class="usage-dot cache-create"></span>${usage.cache_creation_input_tokens.toLocaleString()} cache create</div>`;
    if (usage.cache_read_input_tokens)
      html += `<div class="usage-item"><span class="usage-dot cache-read"></span>${usage.cache_read_input_tokens.toLocaleString()} cache read</div>`;
    if (usage.output_tokens !== undefined)
      html += `<div class="usage-item"><span class="usage-dot output"></span>${usage.output_tokens.toLocaleString()} output</div>`;
    if (usage.reasoning_tokens)
      html += `<div class="usage-item"><span class="usage-dot reasoning"></span>${usage.reasoning_tokens.toLocaleString()} reasoning</div>`;
    const cost = computeCost(usage, pricing);
    if (cost != null)
      html += `<div class="usage-item usage-cost">${formatCost(cost)}</div>`;
    return html;
  }

  function updateUsageDisplay(usage, pricing) {
    const bar = document.getElementById('usage-bar');
    if (bar) bar.innerHTML = renderUsage(usage, pricing);
  }

  function costGauge(cost) {
    const pct = Math.min(cost / 100, 1);
    const w = 40, h = 10, fill = pct * w;
    const hue = Math.round((1 - pct) * 120);
    const sat = pct > 0.9 ? '80%' : '70%';
    const lit = pct > 0.9 ? '30%' : '45%';
    const color = `hsl(${hue},${sat},${lit})`;
    return `<span class="footer-cost-gauge"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="2" fill="var(--bg)" stroke="var(--border)" stroke-width="0.5"/><rect width="${fill}" height="${h}" rx="2" fill="${color}"/></svg><span class="footer-cost-label" style="color:${color}">${formatCost(cost)}</span></span>`;
  }

  function updateStats() {
    const source = state.interactions;
    const total = source.length;
    let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheCreate = 0, toolCallCount = 0, totalCost = 0;
    let hasCost = false;
    for (const i of source) {
      if (i.usage) {
        inputTokens += i.usage.input_tokens || 0;
        outputTokens += i.usage.output_tokens || 0;
        cacheRead += i.usage.cache_read_input_tokens || 0;
        cacheCreate += i.usage.cache_creation_input_tokens || 0;
        const cost = computeCost(i.usage, i.pricing);
        if (cost != null) { totalCost += cost; hasCost = true; }
      }
      toolCallCount += extractToolCalls(i).length;
    }

    // Footer stats section
    statsEl.textContent = `${total} turn${total !== 1 ? 's' : ''} \u00b7 ${toolCallCount} tool call${toolCallCount !== 1 ? 's' : ''}`;

    // Footer tokens section — arrows for in/out
    const tokensEl = document.getElementById('footerTokens');
    if (tokensEl) {
      if (inputTokens || outputTokens) {
        tokensEl.innerHTML =
          `<span class="ft-in"><svg width="8" height="8" viewBox="0 0 8 8"><path d="M4 1L7 5H1Z" fill="currentColor"/></svg> ${inputTokens.toLocaleString()}</span>` +
          `<span class="ft-out"><svg width="8" height="8" viewBox="0 0 8 8"><path d="M4 7L1 3H7Z" fill="currentColor"/></svg> ${outputTokens.toLocaleString()}</span>`;
      } else {
        tokensEl.innerHTML = '<span class="footer-placeholder">tokens</span>';
      }
    }

    // Footer cache section — cache icon with create/read
    const cacheEl = document.getElementById('footerCache');
    if (cacheEl) {
      if (cacheRead || cacheCreate) {
        const icon = '<svg class="ft-cache-icon" width="10" height="10" viewBox="0 0 10 10"><ellipse cx="5" cy="2.5" rx="4" ry="1.8" fill="none" stroke="currentColor" stroke-width="0.9"/><path d="M1 2.5v2.2c0 1 1.8 1.8 4 1.8s4-.8 4-1.8V2.5" fill="none" stroke="currentColor" stroke-width="0.9"/><path d="M1 4.7v2.2c0 1 1.8 1.8 4 1.8s4-.8 4-1.8V4.7" fill="none" stroke="currentColor" stroke-width="0.9"/></svg>';
        let parts = '';
        if (cacheCreate) parts += `<span class="ft-cache-w">${icon} ${cacheCreate.toLocaleString()} w</span>`;
        if (cacheRead) parts += `<span class="ft-cache-r">${icon} ${cacheRead.toLocaleString()} r</span>`;
        cacheEl.innerHTML = parts;
      } else {
        cacheEl.innerHTML = '<span class="footer-placeholder">cache</span>';
      }
    }

    // Footer cost section with gauge
    const costEl = document.getElementById('footerCost');
    if (costEl) {
      costEl.innerHTML = hasCost ? costGauge(totalCost) : '<span class="footer-placeholder">price</span>';
    }

    // Timeline footer — total busy time and cost of visible turns
    const tlTimeEl = document.getElementById('timeline-total-time');
    const tlCostEl = document.getElementById('timeline-total-cost');
    let visibleCost = 0, visibleTime = 0;
    let hasVisibleCost = false, hasVisibleTime = false;
    for (const i of source) {
      if (!isVisibleInTimeline(i)) continue;
      const c = computeCost(i.usage, i.pricing);
      if (c != null) { visibleCost += c; hasVisibleCost = true; }
      if (i.timing?.duration) { visibleTime += i.timing.duration; hasVisibleTime = true; }
    }
    if (tlTimeEl) {
      tlTimeEl.textContent = hasVisibleTime ? `\u03A3 ${formatDuration(visibleTime)}` : '';
    }
    if (tlCostEl) {
      tlCostEl.textContent = hasVisibleCost ? `\u03A3 ${formatCost(visibleCost)}` : '';
    }
  }

  function isVisibleInTimeline(interaction) {
    if (activeInstanceTab === 'all') {
      return !(interaction.instanceId && knownInstances.has(interaction.instanceId));
    }
    return interaction.instanceId === activeInstanceTab;
  }

  function renderEmptyState() {
    if (!emptyState) return;
    if (state.interactions.length > 0) return;
    emptyState.innerHTML = '<p>No interaction selected.</p>'
      + '<p class="empty-state-sub">Start capturing Claude Code API streams:</p>'
      + '<ul class="empty-state-list">'
      + '<li><b>External Claude</b> &mdash; run with the proxy env var:<br><code>ANTHROPIC_BASE_URL=http://localhost:3456 claude -p "prompt"</code></li>'
      + '<li><b>Chat</b> &mdash; use the <span class="empty-state-link" data-view="claude">Chat</span> tab to talk to Claude directly through the proxy</li>'
      + '</ul>';
    emptyState.querySelectorAll('.empty-state-link').forEach(el => {
      el.addEventListener('click', () => {
        const view = el.dataset.view;
        if (view) document.querySelector(`.header-tab[data-view="${view}"]`)?.click();
      });
    });
  }

  function handleCliSpawned(msg) {
    if (!msg.instanceId) return;
    const existing = knownInstances.get(msg.instanceId);
    if (existing) {
      existing.tabId = msg.tabId;
      existing.cwd = msg.cwd || existing.cwd;
      existing.status = 'running';
    } else {
      knownInstances.set(msg.instanceId, {
        instanceId: msg.instanceId,
        status: 'running', spawnedAt: Date.now(),
        cwd: msg.cwd || null, tabId: msg.tabId || null,
      });
    }
    renderInspectorTabStrip();
  }

  // --- Message handler ---
  /* Every Claude Code hook and MCP call arrives as its own interaction, so in
     live mode they used to yank the detail panel away from the turn that is
     still streaming — several times per turn. They stay in the timeline and
     stay clickable; they just don't steal the panel mid-stream. */
  function _wouldInterruptStream(incoming) {
    if (!incoming.isHook && !incoming.isMcp) return false;
    const current = state.selection?.type === 'turn'
      ? state.interactions.find(i => i.id === state.selection.id) : null;
    return !!current && _isLiveInteraction(current);
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'init':
        extTabCounter = 0;
        activeExtTab = null;
        knownInstances.clear();
        state.interactions = msg.interactions || [];
        // Stamp null-instanceId interactions as ext tabs, rebuild instance map
        for (const i of state.interactions) {
          stampExtInteraction(i);
          if (i.instanceId && !knownInstances.has(i.instanceId)) {
            knownInstances.set(i.instanceId, {
              instanceId: i.instanceId, status: 'exited', spawnedAt: i.timestamp, cwd: null,
            });
          }
        }
        // Mark ext tabs as exited on init (they're historical)
        for (let n = 1; n <= extTabCounter; n++) {
          const ext = knownInstances.get(`ext-${n}`);
          if (ext) ext.status = 'exited';
        }
        // Suppress autoclear during init — all instances appear exited until
        // claude:instances arrives with actual running statuses
        _suppressAutoClear = true;
        renderInspectorTabStrip();
        _suppressAutoClear = false;
        initTimelineToggle();
        renderTimelineActive();
        updateStats();
        updateInspectorBusy();
        if (state.interactions.length > 0) {
          select({ type: 'turn', id: state.interactions[state.interactions.length - 1].id });
        } else {
          renderEmptyState();
        }
        break;

      case 'interaction:start':
        stampExtInteraction(msg.interaction);
        // Insert in timestamp order — hooks and subagent turns arrive via
        // independent paths and may reach the client out of logical order.
        const _ts = msg.interaction.timestamp || 0;
        let _lo = 0, _hi = state.interactions.length;
        while (_lo < _hi) {
          const mid = (_lo + _hi) >>> 1;
          if ((state.interactions[mid].timestamp || 0) <= _ts) _lo = mid + 1;
          else _hi = mid;
        }
        state.interactions.splice(_lo, 0, msg.interaction);
        // Auto-discover instance from interaction
        if (msg.interaction.instanceId && !knownInstances.has(msg.interaction.instanceId)) {
          knownInstances.set(msg.interaction.instanceId, {
            instanceId: msg.interaction.instanceId,
            status: 'running', spawnedAt: msg.interaction.timestamp, cwd: null,
          });
          renderInspectorTabStrip();
        }
        // Only append to visible timeline if it matches current filter
        const matchesFilter = activeInstanceTab === 'all'
          ? (!msg.interaction.instanceId || !knownInstances.has(msg.interaction.instanceId))
          : msg.interaction.instanceId === activeInstanceTab;
        if (matchesFilter) {
          if (_timelineMode === 'parallel') {
            const iStatus = msg.interaction.status || 'pending';
            const isLongLived = !msg.interaction.isHook && !msg.interaction.isMcp;
            if (isLongLived && (iStatus === 'pending' || iStatus === 'streaming')) {
              addFooterBadge(msg.interaction);
            } else {
              appendToParallelTimeline(msg.interaction);
            }
          } else {
            appendTurnToTimeline(msg.interaction);
          }
          if (_liveMode && !_splitMode && !_wouldInterruptStream(msg.interaction)) {
            // While split mode is active, the panes ARE the live view — auto-selecting
            // each new interaction (incl. hooks) would tear the split down. New parallel
            // streamers get their own pane via the message_start SSE routing instead.
            select({ type: 'turn', id: msg.interaction.id });
            scrollTimelineToBottom();
          } else if (_liveMode) {
            scrollTimelineToBottom();
          }
        }
        updateStats();
        updateInspectorBusy();
        break;

      case 'interaction:update':
        updateInteraction(msg.interaction);
        // Re-render detail if this interaction is selected
        if (state.selection?.type === 'turn' && state.selection.id === msg.interaction.id) {
          select({ type: 'turn', id: msg.interaction.id });
        }
        break;

      case 'sse_event':
        handleSSEEvent(msg.interactionId, msg.event);
        break;

      case 'interaction:complete':
        updateInteraction(msg.interaction);
        updateInspectorBusy();
        break;

      case 'interaction:error':
        markInteractionError(msg.interactionId, msg.error);
        updateInspectorBusy();
        break;

      case 'interaction:detail': {
        _pendingDetailRequests.delete(msg.id);
        const dIdx = state.interactions.findIndex(i => i.id === msg.id);
        if (dIdx >= 0 && msg.interaction) {
          const localEvents = state.interactions[dIdx].response?.sseEvents;
          const localSubagent = state.interactions[dIdx].subagent;
          const localRespChars = state.interactions[dIdx]._respChars;
          state.interactions[dIdx] = { ...msg.interaction };
          if (localEvents?.length) state.interactions[dIdx].response.sseEvents = localEvents;
          if (localRespChars) state.interactions[dIdx]._respChars = localRespChars;
          if (localSubagent && !state.interactions[dIdx].subagent) state.interactions[dIdx].subagent = localSubagent;
          if (state.selection?.id === msg.id || state.selection?.interactionId === msg.id) {
            select(state.selection);
          }
        } else if (dIdx >= 0 && !msg.interaction) {
          // Server couldn't find full data — clear _summary so we stop retrying
          delete state.interactions[dIdx]._summary;
          for (const el of detailContent.querySelectorAll(`[data-lazy-detail="${msg.id}"]`)) {
            const loader = el.querySelector('.json-block');
            if (loader) loader.textContent = '(data not available)';
          }
        }
        break;
      }

      case 'interaction:sseEvents': {
        _pendingSseRequests.delete(msg.id);
        const sseIdx = state.interactions.findIndex(i => i.id === msg.id);
        if (sseIdx >= 0) {
          if (!state.interactions[sseIdx].response) state.interactions[sseIdx].response = {};
          state.interactions[sseIdx].response.sseEvents = msg.sseEvents || [];
          if (state.selection?.id === msg.id || state.selection?.interactionId === msg.id) {
            select(state.selection);
          }
        }
        break;
      }

      case 'cleared':
        state.interactions = [];
        state.selection = null;
        knownInstances.clear();
        activeInstanceTab = 'all';
        extTabCounter = 0;
        activeExtTab = null;
        stopAllFlowAnimations();
        clearAllFooterBadges();
        _d3State = null;
        renderInspectorTabStrip();
        timelineList.innerHTML = '';
        detailContent.innerHTML = '';
        detailContent.classList.add('hidden');
        emptyState.classList.remove('hidden');
        updateStats();
        updateInspectorBusy();
        renderEmptyState();
        break;

      case 'claude:instances':
        if (msg.instances) {
          const activeIds = new Set(msg.instances.map(i => i.instanceId));
          for (const inst of msg.instances) {
            const existing = knownInstances.get(inst.instanceId);
            knownInstances.set(inst.instanceId, {
              instanceId: inst.instanceId,
              status: inst.status, spawnedAt: inst.spawnedAt,
              cwd: inst.cwd || existing?.cwd || null,
              tabId: inst.tabId || existing?.tabId || null,
            });
          }
          for (const [id, info] of knownInstances) {
            if (id.startsWith('cli-') && info.status === 'exited' && !activeIds.has(id)) {
              knownInstances.delete(id);
            }
          }
          if (!knownInstances.has(activeInstanceTab)) {
            const fallback = knownInstances.size > 0 ? knownInstances.keys().next().value : 'all';
            switchInstanceTab(fallback);
            break;
          }
        }
        renderInspectorTabStrip();
        break;

      case 'inspector:instancesCleared': {
        const cleared = new Set(msg.instanceIds || []);
        state.interactions = state.interactions.filter(i => !cleared.has(i.instanceId));
        for (const id of cleared) knownInstances.delete(id);
        if (cleared.has(activeInstanceTab)) activeInstanceTab = 'all';
        renderInspectorTabStrip();
        renderTimelineActive();
        updateStats();
        if (state.selection && !state.interactions.some(i => i.id === state.selection.id)) {
          state.selection = null;
          document.querySelectorAll('.timeline-entry.selected').forEach(el => el.classList.remove('selected'));
          detailContent.classList.add('hidden');
          emptyState.classList.remove('hidden');
        }
        break;
      }

      case 'inspector:sessionLoaded': {
        const instanceId = msg.instanceId || `cli-${msg.sessId}`;
        const newInteractions = msg.interactions || [];
        const existingIds = new Set(state.interactions.map(i => i.id));
        const toAdd = newInteractions.filter(i => !existingIds.has(i.id));
        state.interactions.push(...toAdd);
        state.interactions.sort((a, b) => a.timestamp - b.timestamp);
        if (!knownInstances.has(instanceId)) {
          knownInstances.set(instanceId, {
            instanceId, status: 'running',
            spawnedAt: toAdd[0]?.timestamp || Date.now(), cwd: null,
          });
        }
        renderInspectorTabStrip();
        if (activeInstanceTab === instanceId) renderTimelineActive();
        updateStats();
        break;
      }

      case 'inspector:allLoaded': {
        const allInteractions = msg.interactions || [];
        const existingIds = new Set(state.interactions.map(i => i.id));
        const toAdd = allInteractions.filter(i => !existingIds.has(i.id));
        if (toAdd.length > 0) {
          for (const i of toAdd) stampExtInteraction(i);
          state.interactions.push(...toAdd);
          state.interactions.sort((a, b) => a.timestamp - b.timestamp);
          for (const i of toAdd) {
            if (i.instanceId && !knownInstances.has(i.instanceId)) {
              knownInstances.set(i.instanceId, {
                instanceId: i.instanceId,
                status: 'exited', spawnedAt: i.timestamp, cwd: null,
              });
            }
          }
          renderInspectorTabStrip();
          renderTimelineActive();
          updateStats();
        }
        _allHistoryLoaded = true;
        const loadAllBtn = document.querySelector('.tl-load-all-btn');
        if (loadAllBtn) { loadAllBtn.classList.add('active'); loadAllBtn.style.opacity = ''; }
        break;
      }

      case 'inspector:turnsDeleted': {
        const ids = new Set(msg.ids || []);
        if (ids.size) {
          for (const i of state.interactions) {
            if (ids.has(i.id)) i.deleted = true;
          }
          for (const id of ids) {
            document.querySelectorAll(`.turn-group[data-turn-id="${CSS.escape(id)}"]`).forEach(g => g.classList.add('turn-deleted'));
          }
        }
        break;
      }

      case 'interaction:enriched': {
        const interaction = state.interactions.find(i => i.id === msg.interactionId);
        if (interaction) {
          interaction.subagent = msg.subagent;
          if (_timelineMode === 'parallel') {
            queueTimelineParallelRebuild();
          } else {
            updateTurnSubagentBadge(interaction);
          }
          if (state.selection?.type === 'turn' && state.selection.id === msg.interactionId) {
            select({ type: 'turn', id: msg.interactionId });
          }
        }
        break;
      }
    }
  }

  // Reset button — clears all interactions and zeroes the footer
  const resetBtn = document.getElementById('footerReset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      const instanceIds = [...new Set(state.interactions.map(i => i.instanceId).filter(Boolean))];
      if (instanceIds.length) sendWs({ type: 'inspector:clearInstances', instanceIds });
      state.interactions.length = 0;
      updateStats();
      renderTimelineActive();
      state.selection = null;
      detailContent.classList.add('hidden');
      emptyState.classList.remove('hidden');
    });
  }

  // Timeline clear button — removes visible non-streaming interactions
  const tlClearBtn = document.getElementById('timeline-clear-btn');
  if (tlClearBtn) {
    tlClearBtn.addEventListener('click', () => {
      const toRemove = new Set();
      for (const i of state.interactions) {
        if (isVisibleInTimeline(i) && i.status !== 'streaming' && i.status !== 'pending') {
          toRemove.add(i.id);
        }
      }
      if (toRemove.size === 0) return;
      // Collect instance IDs of removed interactions to clear from server
      const instanceIds = [...new Set(
        state.interactions.filter(i => toRemove.has(i.id) && i.instanceId).map(i => i.instanceId)
      )];
      state.interactions = state.interactions.filter(i => !toRemove.has(i.id));
      // Only clear instances that have no remaining interactions
      const remainingInstances = new Set(state.interactions.map(i => i.instanceId).filter(Boolean));
      const toClear = instanceIds.filter(id => !remainingInstances.has(id));
      if (toClear.length) sendWs({ type: 'inspector:clearInstances', instanceIds: toClear });
      if (state.selection && toRemove.has(state.selection.id)) {
        state.selection = null;
        detailContent.classList.add('hidden');
        emptyState.classList.remove('hidden');
      }
      renderTimelineActive();
      updateStats();
    });
  }

  window.inspectorModule = { handleMessage, handleCliSpawned, instanceDisplayLabel, renderInspectorTabStrip, switchInstanceTab, toggleFocusMode, isFocusMode: () => _focusMode };
})();
