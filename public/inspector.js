(function() {
  'use strict';
  const { state, escHtml, highlightJSON, renderJSON, jsonBlock, formatDuration, truncate,
          renderMarkdown, renderMarkdownDebounced, cancelRenderDebounce, sendWs,
          linkifyFilePaths, openFilePreview, openTextPreview, fileCategory,
          timelineList, detailContent, emptyState, statsEl } = window.dashboard;

  // Absolute file paths anywhere in the detail pane (tool input JSON, tool
  // results, hook payloads) become links that open the file preview modal.
  function linkifyDetail(root) {
    if (!root) return;
    try { linkifyFilePaths(root, { includePre: true }); } catch {}
  }

  // --- Auto-select suppression: don't jump away from user-selected turns ---
  let _liveMode = localStorage.getItem('timelineLive') !== 'false';

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

  // --- Session tabs ---
  /* The first tab lists every session as a card (from the server's summary
     feed, inspector:sessions); each open session has a closable tab of its
     own. Opening one subscribes this browser to the session: the server sends
     its snapshot, then its live events. Closing drops the subscription and
     everything this page held for it. Nothing here survives a reload. */
  const SESSIONS_TAB = 'sessions';
  const SESSION_GROUPS = [
    { kind: 'cli', title: 'CLI sessions' },
    { kind: 'app', title: 'App AI (ai.prompt)' },
    { kind: 'ext', title: 'External' },
  ];
  const _sessions = new Map();          // instanceId → card from the summary feed
  let _runs = {};                       // runId → { status, orchestrator, workers } from the feed
  let _sessionsAutoClear = false;
  const _openTabs = new Map();          // instanceId → { loading }, in opening order
  let activeInstanceTab = SESSIONS_TAB;
  const inspectorTabStrip = document.getElementById('inspectorTabStrip');
  const _sessionsGrid = document.getElementById('inspectorSessions');
  const _inspectorBody = document.querySelector('#view-dashboard .inspector-body');
  const _sessionTotals = new Map();     // CLI instanceId → whole-session totals from the server
  const _sessionTotalsAsked = new Set();
  let _statsTab = null;                 // the tab the footer was last drawn for

  // The CLI tab that owns an instance, if it is still open.
  function _cliTabIdOf(instanceId) {
    const cliTabs = window.cliModule?.tabs;
    if (!cliTabs) return null;
    for (const [id, t] of cliTabs) {
      if (t.instanceId === instanceId) return id;
    }
    return null;
  }

  function instanceDisplayLabel(instanceId) {
    if (instanceId === SESSIONS_TAB) return 'Sessions';
    // A live CLI tab's own name, as the CLI strip shows it.
    const tabId = instanceId?.startsWith('cli-') ? _cliTabIdOf(instanceId) : null;
    if (tabId && window.cliModule?.computeTabLabel) {
      const label = window.cliModule.computeTabLabel(tabId);
      if (label && label !== tabId) return label.replace(/^>/, '');
    }
    return _sessions.get(instanceId)?.label || instanceId;
  }

  function renderInspectorTabStrip() {
    if (!inspectorTabStrip) return;
    inspectorTabStrip.innerHTML = '';
    const home = document.createElement('button');
    home.className = 'view-tab inspector-sessions-tab' + (activeInstanceTab === SESSIONS_TAB ? ' active' : '');
    home.dataset.instanceId = SESSIONS_TAB;
    home.textContent = 'Sessions';
    inspectorTabStrip.appendChild(home);

    for (const [id, tab] of _openTabs) {
      const card = _sessions.get(id);
      const btn = document.createElement('button');
      btn.className = 'view-tab' + (activeInstanceTab === id ? ' active' : '');
      if (card?.status === 'inactive') btn.classList.add('instance-exited');
      if (tab.loading) btn.classList.add('instance-loading');
      btn.dataset.instanceId = id;
      const label = document.createElement('span');
      label.textContent = instanceDisplayLabel(id);
      if (id.startsWith('cli-')) {
        label.className = 'cli-tab-label';
        // A second click on the open tab goes to its CLI tab.
        label.addEventListener('click', (e) => {
          e.stopPropagation();
          if (activeInstanceTab !== id) {
            switchInstanceTab(id);
            return;
          }
          const tabId = _cliTabIdOf(id);
          if (tabId) {
            switchView('claude');
            window.cliModule?.switchTab?.(tabId);
          }
        });
      }
      btn.appendChild(label);

      // Model override indicator (non-clickable)
      const cliTab = id.startsWith('cli-') ? window.cliModule?.tabs?.get(_cliTabIdOf(id)) : null;
      if (cliTab) {
        const hasOverride = cliTab.settings &&
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
      close.textContent = '×';
      close.title = 'Close this tab';
      btn.appendChild(close);
      inspectorTabStrip.appendChild(btn);
    }

    // Autoclear: one switch for the whole server — every session is removed
    // as soon as it is inactive, here and in every other browser.
    const pinned = document.getElementById('inspectorTabPinned');
    if (pinned) {
      const btn = document.createElement('button');
      btn.className = 'view-tab-action autoclear-switch' + (_sessionsAutoClear ? ' autoclear-on' : '');
      btn.title = _sessionsAutoClear
        ? 'Autoclear on: inactive sessions are removed as soon as they stop. Click to turn off.'
        : 'Autoclear off: each group keeps its 20 newest inactive sessions. Click to remove every inactive session as soon as it stops.';
      btn.innerHTML = `<span class="autoclear-toggle${_sessionsAutoClear ? ' active' : ''}">${_sessionsAutoClear
        ? '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><polyline points="5 8.2 7.2 10.5 11 5.5"/></svg>'
        : '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8a5.5 5.5 0 0 1 9.3-4"/><path d="M13.5 8a5.5 5.5 0 0 1-9.3 4"/><polyline points="12 1.5 12 4.5 9 4.5"/><polyline points="4 11.5 4 14.5 7 14.5"/></svg>'
      }</span><span class="autoclear-label-text">Autoclear</span>`;
      btn.addEventListener('click', () => sendWs({ type: 'inspector:setAutoClear', value: !_sessionsAutoClear }));
      pinned.innerHTML = '';
      pinned.appendChild(btn);
    }

    updateStreamingState();
  }

  function _showSessionsGrid(on) {
    if (_sessionsGrid) _sessionsGrid.classList.toggle('hidden', !on);
    if (_inspectorBody) _inspectorBody.classList.toggle('hidden', on);
  }

  const _statusOf = (s) => (s.status === 'streaming' ? 'streaming' : s.status === 'running' ? 'running' : 'inactive');

  const _KIND_ICON = { cli: '⌨️', app: '\u{1F916}', ext: '\u{1F50C}' };
  const _KIND_TAG = { app: 'ai.prompt', ext: 'external' };

  // The meta row shared by both cards: activity, usage, cost, tokens, model.
  function _metaHtml({ lastAt, turns, apiCalls, cost, tokensIn, tokensOut, model, lead = '' }) {
    const SC = window.sessionCards;
    const n = turns || apiCalls || 0;
    const unit = turns ? 'turn' : 'API call';
    const tok = tokensIn || tokensOut
      ? `<span title="${(tokensIn || 0).toLocaleString()} tokens in (cache included) · ${(tokensOut || 0).toLocaleString()} out">${SC.tokens(tokensIn)} in · ${SC.tokens(tokensOut)} out</span>`
      : '';
    return [
      SC.timeHtml(lastAt), lead,
      `<span>${n.toLocaleString()} ${unit}${n !== 1 ? 's' : ''}</span>`,
      cost != null ? `<span class="sc-cost" title="Cost so far">${formatCost(cost)}</span>` : '',
      tok,
      model ? `<span class="sc-chip">${escHtml(model)}</span>` : '',
    ].filter(Boolean).join('');
  }

  // A single session's card: the whole card opens its Inspector tab.
  function _cardHtml(s) {
    const SC = window.sessionCards;
    const status = _statusOf(s);
    const name = instanceDisplayLabel(s.instanceId);
    const dir = SC.dirName(s.cwd);
    // The directory leads the subtitle unless the name already is it.
    const sub = [s.cwd && dir !== name ? SC.dirHtml(s.cwd) : '', _KIND_TAG[s.kind] || '',
      s.cwd && dir === name ? escHtml(s.cwd) : ''].filter(Boolean).join(' · ');
    return `<button type="button" class="vc-card sc-card insp-card ${SC.accentOf(status)}${s.status === 'inactive' ? ' is-inactive' : ''}${_openTabs.has(s.instanceId) ? ' is-open' : ''}"`
      + ` data-instance-id="${escHtml(s.instanceId)}" title="Open this session's Inspector tab">`
      + SC.head({ icon: _KIND_ICON[s.kind] || _KIND_ICON.ext, name, sub, subTitle: s.cwd || null, status })
      + `<span class="sc-meta">${_metaHtml(s)}</span>`
      + '</button>';
  }

  // One card per orchestration run: the header opens the orchestrator's tab,
  // each worker row that worker's. Figures add up over the members listed.
  function _runCardHtml(runId, members) {
    const SC = window.sessionCards;
    const byNewest = (a, b) => (b.lastAt || 0) - (a.lastAt || 0);
    const orchs = members.filter(m => m.orchestration.role === 'orchestrator').sort(byNewest);
    const workers = members.filter(m => m.orchestration.role !== 'orchestrator')
      .sort((a, b) => String(a.orchestration.workerId).localeCompare(String(b.orchestration.workerId), undefined, { numeric: true }));
    const head = orchs[0] || [...members].sort(byNewest)[0];
    const info = _runs[runId] || {};
    const live = members.some(m => m.status !== 'inactive');
    const status = info.status || (live ? 'running' : 'stopped');
    const running = workers.filter(m => m.status !== 'inactive').length;
    const total = info.workers ?? workers.length;
    let turns = 0, apiCalls = 0, cost = null, tokensIn = 0, tokensOut = 0;
    for (const m of members) {
      turns += m.turns || 0;
      apiCalls += m.apiCalls || 0;
      tokensIn += m.tokensIn || 0;
      tokensOut += m.tokensOut || 0;
      if (m.cost != null) cost = (cost || 0) + m.cost;
    }
    const lastAt = Math.max(...members.map(m => m.lastAt || 0));
    const name = info.orchestrator || orchs[0]?.orchestration.name || `Run ${runId}`;
    const cwd = info.cwd || head.cwd;
    const prefix = `${name}-`;
    // Earlier orchestrators (replaced by a refresh) are listed with the workers.
    const rows = [...orchs.slice(1), ...workers].map(m => {
      const label = m.orchestration.name || instanceDisplayLabel(m.instanceId);
      const n = m.turns || m.apiCalls || 0;
      return {
        name: m.orchestration.role === 'orchestrator' ? `${label} (earlier orchestrator)` : label.startsWith(prefix) ? label.slice(prefix.length) : label,
        state: _statusOf(m),
        detail: [`${n} ${m.turns ? 'turn' : 'call'}${n !== 1 ? 's' : ''}`, SC.relTime(m.lastAt)].filter(Boolean).join(' · '),
        aside: m.cost != null ? formatCost(m.cost) : '',
        title: [label, m.cwd, m.cost != null ? `cost so far ${formatCost(m.cost)}` : '', 'Open this session\'s Inspector tab'].filter(Boolean).join('\n'),
        attrs: `data-instance-id="${escHtml(m.instanceId)}"`,
      };
    });
    const open = members.some(m => _openTabs.has(m.instanceId));
    const workersHtml = `<span>${total} worker${total !== 1 ? 's' : ''}${running ? ` · <b>${running} running</b>` : ''}</span>`;
    return `<div class="vc-card sc-card insp-run-card ${SC.accentOf(status)}${!live ? ' is-inactive' : ''}${open ? ' is-open' : ''}">`
      + `<button type="button" class="insp-run-head" data-instance-id="${escHtml(head.instanceId)}" title="Open the orchestrator's Inspector tab">`
      + SC.head({
        icon: '\u{1F9ED}', iconTitle: `Orchestration run ${runId}`, name, status, subTitle: cwd || null,
        sub: [cwd ? SC.dirHtml(cwd) : '', `run ${escHtml(runId)}`].filter(Boolean).join(' · '),
      })
      + `<span class="sc-meta">${_metaHtml({ lastAt, turns, apiCalls, cost, tokensIn, tokensOut, model: head.model, lead: workersHtml })}</span>`
      + '</button>'
      + SC.workerList(rows, rows.length ? 'Workers' : '')
      + '</div>';
  }

  // Redrawn on every summary push; skipped when nothing visible changed, so a
  // click is not lost to a rebuild under the pointer.
  let _gridHtml = '';
  function renderSessionsGrid() {
    if (!_sessionsGrid || activeInstanceTab !== SESSIONS_TAB) return;
    const byKind = { cli: [], app: [], ext: [] };
    for (const s of _sessions.values()) (byKind[s.kind] || byKind.ext).push(s);
    let html = '';
    for (const { kind, title } of SESSION_GROUPS) {
      const list = byKind[kind].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
      const inactive = list.filter(s => s.status === 'inactive').length;
      html += `<section class="insp-group" data-kind="${kind}">`
        + `<header class="insp-group-head"><h3>${escHtml(title)}</h3>`
        + `<span class="insp-group-count">${list.length - inactive} running \u00b7 ${inactive} inactive</span>`
        + `<button class="insp-group-clear" data-kind="${kind}"${inactive ? '' : ' disabled'}`
        + ` title="Remove every inactive session of this group, with its stored data">Clear</button></header>`
        + '<div class="insp-cards sc-grid">';
      if (!list.length) {
        html += kind === 'ext'
          ? '<p class="insp-empty">None. Point Claude Code at the proxy to see it here: <code>ANTHROPIC_BASE_URL=http://localhost:3456 claude</code></p>'
          : '<p class="insp-empty">None.</p>';
      }
      // A run's members make one card, placed where its newest member is.
      const runs = new Map();
      for (const s of list) {
        const runId = s.orchestration?.runId;
        if (runId) (runs.get(runId) || runs.set(runId, []).get(runId)).push(s);
      }
      const placed = new Set();
      for (const s of list) {
        const runId = s.orchestration?.runId;
        if (runId) {
          if (placed.has(runId)) continue;
          placed.add(runId);
          html += _runCardHtml(runId, runs.get(runId));
          continue;
        }
        html += _cardHtml(s);
      }
      html += '</div></section>';
    }
    if (html === _gridHtml) return;
    _gridHtml = html;
    _sessionsGrid.innerHTML = html;
  }

  if (_sessionsGrid) {
    _sessionsGrid.addEventListener('click', (e) => {
      const clear = e.target.closest('.insp-group-clear');
      if (clear) {
        if (!clear.disabled) sendWs({ type: 'inspector:clearKind', kind: clear.dataset.kind });
        return;
      }
      const target = e.target.closest('[data-instance-id]');
      if (target) openSessionTab(target.dataset.instanceId);
    });
  }

  // Open a session's tab (subscribing on first open) and focus it.
  function openSessionTab(instanceId) {
    if (!instanceId || instanceId === SESSIONS_TAB) { switchInstanceTab(SESSIONS_TAB); return; }
    if (!_openTabs.has(instanceId)) {
      _openTabs.set(instanceId, { loading: true });
      sendWs({ type: 'inspector:subscribe', instanceId });
    }
    switchInstanceTab(instanceId);
  }

  // Close a session's tab: stop its traffic and forget everything held for it.
  function closeSessionTab(instanceId) {
    if (!_openTabs.has(instanceId)) return;
    const order = [..._openTabs.keys()];
    _openTabs.delete(instanceId);
    sendWs({ type: 'inspector:unsubscribe', instanceId });
    _dropInstance(instanceId);
    if (activeInstanceTab === instanceId) {
      const at = order.indexOf(instanceId);
      const next = order[at + 1] ?? order[at - 1];
      switchInstanceTab(next && _openTabs.has(next) ? next : SESSIONS_TAB);
    } else {
      renderInspectorTabStrip();
    }
  }

  function _dropInstance(instanceId) {
    const dropped = new Set();
    state.interactions = state.interactions.filter(i => {
      if (i.instanceId !== instanceId) return true;
      dropped.add(i.id);
      return false;
    });
    for (const id of dropped) {
      stopDurationTimer(id);
      _pendingSseRequests.delete(id);
      _pendingDetailRequests.delete(id);
      _sseIndex.delete(id);
    }
    for (let k = _recentFull.length - 1; k >= 0; k--) {
      if (dropped.has(_recentFull[k])) _recentFull.splice(k, 1);
    }
    if (_lanesView?.instanceId === instanceId) _lanesTeardown();
    const sel = state.selection;
    if (sel && dropped.has(sel.type === 'tool' ? sel.interactionId : sel.id)) {
      state.selection = null;
      _detailView = null;
      detailContent.innerHTML = '';
      detailContent.classList.add('hidden');
      emptyState.classList.remove('hidden');
    }
    _sessionTotals.delete(instanceId);
    _sessionTotalsAsked.delete(instanceId);
    _interner.drop(instanceId);
  }

  /* Hold at most the cap of one session's turns: the oldest leave the page
     and the tab offers "Load earlier". Turns the user paged back in raise
     that tab's cap, so the next live turn doesn't throw them out again. */
  function _trimTimeline(instanceId) {
    const tab = _openTabs.get(instanceId);
    if (!tab) return false;
    const keep = new Set();
    const sel = state.selection;
    if (sel) keep.add(sel.type === 'tool' ? sel.interactionId : sel.id);
    const drop = new Set(RET.timelineTrim(state.interactions, instanceId,
      { cap: RET.LIMITS.TIMELINE_CAP + (tab.extraCap || 0), keep }));
    if (!drop.size) return false;
    state.interactions = state.interactions.filter(i => !drop.has(i.id));
    for (const id of drop) {
      stopDurationTimer(id);
      _pendingSseRequests.delete(id);
      _pendingDetailRequests.delete(id);
      _sseIndex.delete(id);
    }
    for (let k = _recentFull.length - 1; k >= 0; k--) {
      if (drop.has(_recentFull[k])) _recentFull.splice(k, 1);
    }
    tab.hasMore = true;
    return true;
  }

  function loadEarlier(instanceId = activeInstanceTab) {
    const tab = _openTabs.get(instanceId);
    if (!tab || !tab.hasMore || tab.loadingEarlier) return;
    const oldest = state.interactions.find(i => i.instanceId === instanceId);
    tab.loadingEarlier = true;
    _renderLoadEarlier();
    sendWs({ type: 'inspector:getEarlier', instanceId, beforeId: oldest?.id || null,
             before: oldest?.timestamp, limit: RET.LIMITS.EARLIER_PAGE });
  }

  // The "Load earlier" bar at the top of the timeline, while the server holds
  // older turns of this session than the page does.
  function _renderLoadEarlier() {
    const tab = _openTabs.get(activeInstanceTab);
    let bar = timelineList.querySelector(':scope > .tl-load-earlier');
    if (!tab?.hasMore) { bar?.remove(); return; }
    if (!bar) {
      bar = document.createElement('button');
      bar.className = 'tl-load-earlier';
      bar.style.cssText = 'display:block;width:100%;padding:4px 8px;font-size:11px;cursor:pointer;background:var(--surface, var(--bg));color:var(--text-dim);border:none;border-bottom:1px solid var(--border)';
      bar.addEventListener('click', () => loadEarlier());
      timelineList.prepend(bar);
    }
    bar.disabled = !!tab.loadingEarlier;
    bar.textContent = tab.loadingEarlier ? 'Loading earlier turns\u2026' : 'Load earlier turns';
  }

  function switchInstanceTab(instanceId) {
    // Opening a session from elsewhere (a CLI or SDK panel) lands on its tab.
    if (instanceId !== SESSIONS_TAB && !_openTabs.has(instanceId)) { openSessionTab(instanceId); return; }
    // Another tab (or a fresh snapshot of this one) starts its lanes over.
    _lanesTeardown();
    _lanesPinned = false;
    activeInstanceTab = instanceId;
    _lanesUpdateBackBtn();
    // The tab left behind keeps summaries only.
    _scheduleCompaction();
    _showSessionsGrid(instanceId === SESSIONS_TAB);
    renderInspectorTabStrip();
    updateStats();
    if (instanceId === SESSIONS_TAB) { renderSessionsGrid(); return; }
    renderTimelineActive();
    const filtered = state.interactions.filter(i => i.instanceId === activeInstanceTab);
    const last = filtered[filtered.length - 1];
    if (last) {
      select({ type: 'turn', id: last.id });
    } else {
      state.selection = null;
      document.querySelectorAll('.timeline-entry.selected').forEach(el => el.classList.remove('selected'));
      detailContent.classList.add('hidden');
      emptyState.classList.remove('hidden');
      renderEmptyState();
    }
  }

  // The summary feed: cards, the autoclear switch, and every busy indicator.
  let _stripSig = '';
  function _applySessions(msg) {
    _sessions.clear();
    for (const s of msg.sessions || []) _sessions.set(s.instanceId, s);
    _runs = msg.runs || {};
    _sessionsAutoClear = msg.autoClear === true;
    // The strip is rebuilt only when an open tab's label or state moved.
    const sig = JSON.stringify([_sessionsAutoClear, ...[..._openTabs.keys()].map(id => [id, _sessions.get(id)?.status === 'inactive', _sessions.get(id)?.label])]);
    if (sig !== _stripSig) { _stripSig = sig; renderInspectorTabStrip(); } else updateStreamingState();
    if (activeInstanceTab === SESSIONS_TAB && !document.getElementById('view-dashboard')?.classList.contains('hidden')) {
      renderSessionsGrid();
    }
  }

  // The grid is not redrawn while the Inspector is hidden; catch up on return.
  window.dashboard.registerView?.('dashboard', () => renderSessionsGrid());

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

  // Busy state comes from the summary feed, which covers every session —
  // this page holds the content of open tabs only.
  function updateStreamingState() {
    const busyInstances = new Set();
    for (const s of _sessions.values()) {
      if (s.status === 'streaming') busyInstances.add(s.instanceId);
    }
    if (inspectorTabStrip) {
      for (const tabBtn of inspectorTabStrip.querySelectorAll('.view-tab[data-instance-id]')) {
        tabBtn.classList.toggle('instance-running', busyInstances.has(tabBtn.dataset.instanceId));
      }
    }
    const inspectorTab = document.querySelector('[data-view="dashboard"]');
    if (inspectorTab) {
      inspectorTab.classList.toggle('instance-running', busyInstances.size > 0);
      inspectorTab.textContent = 'Inspector';
    }
    setFavicon(busyInstances.size > 0);
    document.title = 'vistaclair';
    window.cliModule?.updateStreamingState?.(busyInstances);
  }

  if (inspectorTabStrip) {
    inspectorTabStrip.addEventListener('click', (e) => {
      if (e.target.classList.contains('view-tab-close')) {
        const id = e.target.closest('.view-tab')?.dataset.instanceId;
        if (id && id !== SESSIONS_TAB) closeSessionTab(id);
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
    // A summary has no conversation to put in the command: fetch it first.
    if (interaction._summary) {
      _curlPending = id;
      _pendingDetailRequests.add(id);
      sendWs({ type: 'interaction:getDetail', id });
      return;
    }
    showCurlModal(buildCurlCommand(interaction));
  });
  let _curlPending = null;

  /* --- Sheet rows: build the JSON tree on expand ---
     A row's JSON is built when it opens (_fillSheetRow) and dropped when it
     closes. autoExpandSmallJsonBlocks() unfolds anything under ~50 lines,
     so what is left is the big ones, which would otherwise open onto a
     single collapsed `{ role, content }` line. Unfold their outermost
     node once so the row shows something. `toggle` does not bubble —
     hence the capture-phase listener. */
  document.addEventListener('toggle', (e) => {
    const row = e.target;
    if (!row.classList?.contains('vc-sheet-row')) return;
    if (!row.open) {
      // Closed again: its JSON goes; reopening builds it afresh.
      if (row.dataset.seeded && !_selectionInside(row)) {
        const detail = row.querySelector('.vc-sheet-detail');
        if (detail) detail.innerHTML = '';
        delete row.dataset.seeded;
      }
      return;
    }
    if (row.dataset.seeded) return;
    row.dataset.seeded = '1';
    _fillSheetRow(row);
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

  // A summary's copy of a result is cut (_truncated); `owner` is the turn whose
  // detail holds it whole.
  function findToolResult(toolUseId, out) {
    for (const interaction of state.interactions) {
      const req = interaction.request;
      const msgs = req?.messages || (req?._toolResults && [{ role: 'user', content: req._toolResults }]);
      if (!msgs) continue;
      for (const msg of msgs) {
        if (msg.role !== 'user') continue;
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id === toolUseId) {
            if (out) out.owner = interaction;
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
  // Where each streaming interaction sits in state.interactions, checked on
  // use: one lookup per token must not scan the whole list.
  const _sseIndex = new Map();
  function _findStreaming(id) {
    const at = _sseIndex.get(id);
    if (at !== undefined && state.interactions[at]?.id === id) return state.interactions[at];
    const idx = state.interactions.findIndex(i => i.id === id);
    if (idx < 0) { _sseIndex.delete(id); return null; }
    _sseIndex.set(id, idx);
    return state.interactions[idx];
  }

  function handleSSEEvent(interactionId, event) {
    const interaction = _findStreaming(interactionId);
    if (!interaction) return;
    if (event.eventType === 'message_stop') _sseIndex.delete(interactionId);

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

    // Route SSE to detail panel — not while it is off screen: the event is
    // buffered above, and the panel replays the buffer when it is shown.
    // In live mode the lanes take every turn of the session.
    const sel = state.selection;
    if (!_inspectorShown()) {
      if (sel?.type === 'turn' && sel.id === interactionId || _lanesView) _renderOnShow = true;
    } else if (_lanesView) {
      _lanesOnSSE(interaction, event);
    } else if (sel?.type === 'turn' && sel.id === interactionId) {
      appendSSEToDetail(event, interaction);
    }
  }

  function _getStreamState() {
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
    scope = scope || document;
    // Once a turn has streamed into the panel, #response-blocks and #raw-sse-pre
    // are ours — patchTurnDetail must not rebuild them from the buffer.
    if (scope === document && _detailView?.id === interaction.id) _detailView.streamed = true;
    const ss = _getStreamState();
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

    // The chip counts even while the Raw SSE section is closed (and unbuilt).
    const _sseChip = _scopeFind(scope, 'sse-chip-count');
    if (_sseChip) {
      _sseChip.textContent = interaction.response.sseEvents.length;
      const chipBtn = _sseChip.closest('.vc-chip');
      if (chipBtn) { chipBtn.classList.remove('is-empty'); chipBtn.disabled = false; }
    }
    const _sseDetails = _scopeFind(scope, 'raw-sse-details');
    if (_sseDetails) {
      _sseDetails.hidden = false;
      const _sseCount = _scopeFind(scope, 'raw-sse-count');
      if (_sseCount) _sseCount.textContent = interaction.response.sseEvents.length;
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

  // ============================================================
  // LIVE LANES — the detail panel while live mode is on
  // ============================================================
  /* One column per agent of the open session — the main thread leftmost,
     each subagent beside it \u2014 each a running feed of that agent's turns.
     Lanes are kept in step with state.interactions by _lanesSync (batched to
     a frame): turn elements are created, moved and dropped, never rebuilt;
     streamed events go straight to their turn's element. Live mode off, none
     of this runs and the detail panel is the request/response view.
     The decisions (grouping, pairing, windows) are in inspector-lanes.js. */
  const LANES = window.inspectorLanes;
  const LANE_MAIN = LANES.LANE_MAIN;
  let _lanesView = null;     // { instanceId, root, lanes, turns, calls, results, links, byId, built }
  let _lanesPinned = false;  // live, but the reader opened a turn's full detail
  let _lanesSyncQueued = 0;
  let _lanesTimer = null;
  const _reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

  function _lanesActive() {
    return _liveMode && !_lanesPinned && activeInstanceTab !== SESSIONS_TAB;
  }

  // "Lanes" beside the focus button, while a turn opened from live mode is shown.
  const _lanesBackBtn = document.createElement('button');
  _lanesBackBtn.className = 'detail-lanes-btn';
  _lanesBackBtn.title = 'Back to the live lanes';
  _lanesBackBtn.textContent = '\u21A9 lanes';
  _lanesBackBtn.hidden = true;
  document.getElementById('detail')?.appendChild(_lanesBackBtn);
  _lanesBackBtn.addEventListener('click', () => {
    _lanesPinned = false;
    _lanesUpdateBackBtn();
    _lanesShow();
  });

  function _lanesUpdateBackBtn() {
    _lanesBackBtn.hidden = !(_liveMode && _lanesPinned && activeInstanceTab !== SESSIONS_TAB);
  }

  function _lanesShow() {
    if (!_lanesActive()) return;
    if (!_inspectorShown()) { _renderOnShow = true; return; }
    if (_lanesView?.instanceId === activeInstanceTab && _lanesView.root.isConnected) {
      // Clearing the timeline may have hidden the panel.
      emptyState.classList.add('hidden');
      detailContent.classList.remove('hidden');
      _lanesQueueSync();
      return;
    }
    _lanesBuild();
  }

  function _lanesBuild() {
    _lanesTeardown();
    _detailView = null;
    _deferredRender = null;
    emptyState.classList.add('hidden');
    detailContent.classList.remove('hidden');
    detailContent.classList.add('lanes-active');
    detailContent.innerHTML = '';
    const root = document.createElement('div');
    root.className = 'ln-strip';
    detailContent.appendChild(root);
    _lanesView = {
      instanceId: activeInstanceTab, root, built: false,
      lanes: new Map(),     // lane key -> lane
      turns: new Map(),     // interaction id -> turn view
      calls: new Map(),     // tool_use_id -> call view
      results: new Map(), links: new Map(), byId: new Map(), stopped: new Set(),
    };
    root.addEventListener('click', _lanesOnClick);
    root.addEventListener('mouseover', e => {
      const t = e.target.closest?.('.ln-call-thumb');
      if (t) _thumbPopShow(t);
    });
    root.addEventListener('mouseout', e => {
      if (e.target.closest?.('.ln-call-thumb') && !e.relatedTarget?.closest?.('.ln-call-thumb')) _thumbPopHide();
    });
    root.addEventListener('scroll', _thumbPopHide, true);
    _lanesSync();
    _lanesView.built = true;
    for (const lane of _lanesView.lanes.values()) {
      // History opens folded, except the results of each lane's newest turn
      // that has any.
      const turns = [...lane.feed.querySelectorAll(':scope > .ln-turn')].reverse();
      for (const el of turns) {
        const calls = (lane.views.get(el.dataset.id)?.calls || []).filter(c => c.body);
        if (!calls.length) continue;
        for (const c of calls) _resultOpen(c, false);
        break;
      }
      lane.feed.scrollTop = lane.feed.scrollHeight;
      lane.expectTop = lane.feed.scrollTop;
    }
    _lanesTimer = setInterval(_lanesStatus, 2000);
  }

  function _lanesTeardown() {
    if (!_lanesView) return;
    clearInterval(_lanesTimer);
    _lanesTimer = null;
    for (const lane of _lanesView.lanes.values()) { cancelAnimationFrame(lane.raf); lane.io.disconnect(); }
    _lanesView.root.remove();
    _lanesView = null;
    _thumbPop?.remove();
    _thumbPop = null;
    detailContent.classList.remove('lanes-active');
  }

  function _lanesQueueSync() {
    if (!_lanesView || _lanesSyncQueued) return;
    _lanesSyncQueued = requestAnimationFrame(() => { _lanesSyncQueued = 0; _lanesSync(); });
  }

  // Bring every lane in line with the session's turns.
  function _lanesSync() {
    const v = _lanesView;
    if (!v || !v.root.isConnected) return;
    const mine = state.interactions.filter(i => i.instanceId === v.instanceId);
    v.byId = new Map(mine.map(i => [i.id, i]));
    v.results = LANES.toolResultIndex(mine);
    v.links = LANES.agentLinks(mine, extractToolCalls);
    v.stopped = new Set(mine.filter(i => i.isHook && i.hookEvent === 'SubagentStop')
      .map(i => i.subagent?.agentId || i.hookAgentId).filter(Boolean));
    // Turn labels as the timeline numbers them: #n on the main thread, #Sn
    // per subagent.
    v.numbers = new Map();
    let n = 0;
    const subCounts = new Map();
    for (const i of mine) {
      if (i.isMcp || i.isHook || !isStandardLlm(i) || !hasAssistantMessage(i)) continue;
      const aid = i.subagent?.agentId;
      if (aid) {
        const k = (subCounts.get(aid) || 0) + 1;
        subCounts.set(aid, k);
        v.numbers.set(i.id, `#S${k}`);
      } else {
        v.numbers.set(i.id, `#${++n}`);
      }
    }

    const groups = LANES.groupLanes(mine, v.instanceId);
    const keys = new Set(groups.map(g => g.key));
    let prev = null;
    for (const g of groups) {
      let lane = v.lanes.get(g.key);
      if (!lane) {
        // A lane guessed from its spawning call ('pending-<tool_use_id>') keeps
        // its column once the agent's real id is known.
        for (const [k, l] of v.lanes) {
          if (!keys.has(k) && k.startsWith('pending-') && v.links.get(k.slice(8)) === g.key) {
            v.lanes.delete(k);
            l.key = g.key;
            l.el.dataset.lane = g.key;
            lane = l;
            break;
          }
        }
        if (!lane) lane = _laneCreate(g.key);
        v.lanes.set(g.key, lane);
      }
      lane.ids = g.ids;
      lane.subagent = g.subagent;
      if (prev ? prev.el.nextElementSibling !== lane.el : v.root.firstElementChild !== lane.el) {
        if (prev) prev.el.after(lane.el); else v.root.prepend(lane.el);
      }
      prev = lane;
      _laneHeader(lane);
      _laneRender(lane);
    }
    for (const [k, lane] of v.lanes) {
      if (keys.has(k)) continue;
      cancelAnimationFrame(lane.raf);
      for (const tv of lane.views.values()) _turnDrop(tv);
      lane.io.disconnect();
      lane.el.remove();
      v.lanes.delete(k);
    }
    // Results and Agent links that arrived since a call was drawn.
    for (const call of v.calls.values()) _callRefresh(call, true);
    _lanesStatus();
  }

  function _laneCreate(key) {
    const el = document.createElement('section');
    el.className = 'ln-lane';
    el.dataset.lane = key;
    el.innerHTML = `<header class="ln-head"><span class="ln-dot"></span><span class="ln-label"></span>`
      + `<span class="ln-model"></span><span class="ln-stats"></span><span class="ln-state"></span></header>`
      + `<div class="ln-feed"><div class="ln-empty">Waiting for the first turn\u2026</div><div class="ln-older" hidden></div></div>`
      + `<button class="ln-pill" hidden>\u2193 live</button>`
      + `<button class="ln-rail" title="Show this lane"><span class="ln-rail-label"></span></button>`;
    const lane = {
      key, el, feed: el.querySelector('.ln-feed'), older: el.querySelector('.ln-older'),
      empty: el.querySelector('.ln-empty'), pill: el.querySelector('.ln-pill'),
      ids: [], views: new Map(), win: {}, follow: true, raf: 0, expectTop: 0,
      subagent: null, doneAt: null, railOpened: false, wantOlder: false,
    };
    const feed = lane.feed;
    feed.addEventListener('scroll', () => {
      // A scroll we did not make is the reader's: up pauses, back down resumes.
      if (Math.abs(feed.scrollTop - lane.expectTop) > 2) {
        const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight <= FOLLOW_SLACK_PX;
        if (atBottom && !lane.win.toId) _laneResume(lane);
        else if (!atBottom) _lanePause(lane);
        lane.expectTop = feed.scrollTop;
      }
      if (feed.scrollTop < 40) _laneOlder(lane);
    }, { passive: true });
    feed.addEventListener('wheel', e => {
      if (e.deltaY < 0 && feed.scrollHeight > feed.clientHeight) _lanePause(lane);
    }, { passive: true });
    // An open result pushed off the top by newer content folds to its line —
    // only while following: a paused reader's page must not move under them.
    lane.io = new IntersectionObserver(entries => {
      if (!lane.follow) return;
      for (const e of entries) {
        if (!e.isIntersecting && e.rootBounds && e.boundingClientRect.bottom <= e.rootBounds.top + 1) {
          _resultFoldAbove(e.target._call);
        }
      }
    }, { root: feed });
    // A lane opening after the first frame slides in.
    if (_lanesView?.built) {
      el.classList.add('is-entering');
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('is-entering')));
    }
    return lane;
  }

  const _laneColor = lane => lane.key === LANE_MAIN ? 'var(--accent)' : getSubagentColor(lane.subagent);
  const _laneLabel = lane => lane.key === LANE_MAIN ? 'main'
    : (getSubagentLabel(lane.subagent) || lane.subagent?.agentType || 'subagent');
  const _shortModel = m => (m || '').replace('claude-', '').split('-202')[0];
  const _fmtTok = LANES.fmtTok;

  function _setText(el, text) { if (el && el.textContent !== text) el.textContent = text; }

  // Label, model, live dot, and the lane's output tokens and cost so far.
  function _laneHeader(lane) {
    const v = _lanesView;
    if (lane.subagent?.agentId) registerSubagent(lane.subagent);
    lane.el.style.setProperty('--ln-color', _laneColor(lane));
    const label = _laneLabel(lane);
    _setText(lane.el.querySelector('.ln-label'), label);
    _setText(lane.el.querySelector('.ln-rail-label'), label);
    let out = 0, cost = 0, priced = false, model = '', live = false;
    for (const id of lane.ids) {
      const i = v.byId.get(id);
      if (!i) continue;
      out += i.usage?.output_tokens || 0;
      const c = computeCost(i.usage, i.pricing);
      if (c != null) { cost += c; priced = true; }
      if (i.request?.model) model = i.request.model;
      if (_isLiveInteraction(i)) live = true;
    }
    _setText(lane.el.querySelector('.ln-model'), _shortModel(model));
    _setText(lane.el.querySelector('.ln-stats'), out ? `\u2193${_fmtTok(out)}${priced ? ' \u00B7 ' + formatCost(cost) : ''}` : '');
    lane.el.classList.toggle('is-live', live);
    lane.empty.hidden = lane.ids.length > 0;
  }

  // Render the lane's window of turns: add what is new, drop what left.
  function _laneRender(lane) {
    const v = _lanesView;
    const ids = lane.ids;
    const w = LANES.laneWindow(ids, lane.win);
    lane.win = { fromId: ids[w.from] ?? null, toId: w.to >= ids.length ? null : ids[w.to - 1] };
    const want = ids.slice(w.from, w.to);
    const wantSet = new Set(want);
    const anchor = lane.follow ? null : _laneAnchor(lane);
    for (const [id, tv] of lane.views) {
      if (!wantSet.has(id)) _turnDrop(tv);
    }
    // Only turns joining at the live end fade in, not history paged in above.
    let lastHeld = -1;
    want.forEach((id, k) => { if (lane.views.has(id)) lastHeld = k; });
    let after = lane.older;
    for (const [k, id] of want.entries()) {
      let tv = lane.views.get(id);
      if (!tv) {
        const i = v.byId.get(id);
        if (!i) continue;
        tv = _turnCreate(lane, i, v.built && k > lastHeld);
        lane.views.set(id, tv);
        v.turns.set(id, tv);
      } else {
        _turnCaption(tv, v.byId.get(id));
      }
      if (after.nextElementSibling !== tv.el) after.after(tv.el);
      after = tv.el;
    }
    const tab = _openTabs.get(v.instanceId);
    lane.older.hidden = !(w.from > 0 || tab?.hasMore);
    _setText(lane.older, tab?.loadingEarlier && lane.wantOlder ? 'Loading earlier turns\u2026' : '\u2191 earlier turns');
    if (anchor) _laneRestore(lane, anchor);
    else _laneFollow(lane);
  }

  // The first turn in view and its offset, to hold the reading position while
  // turns come and go above it.
  function _laneAnchor(lane) {
    const top = lane.feed.scrollTop;
    for (const el of lane.feed.children) {
      if (el.classList.contains('ln-turn') && el.offsetTop + el.offsetHeight > top) return { el, off: el.offsetTop - top };
    }
    return null;
  }

  function _laneRestore(lane, a) {
    if (!a?.el.isConnected) return;
    lane.feed.scrollTop = a.el.offsetTop - a.off;
    lane.expectTop = lane.feed.scrollTop;
  }

  // Scroll-up reached the top: show older turns, from the page or the server.
  function _laneOlder(lane) {
    const v = _lanesView;
    if (!v) return;
    const ids = lane.ids;
    const from = lane.win.fromId ? ids.indexOf(lane.win.fromId) : 0;
    if (from > 0) {
      const to = lane.win.toId ? ids.indexOf(lane.win.toId) + 1 : ids.length;
      const w = LANES.pageOlder(ids, { from, to });
      lane.win = { fromId: ids[w.from], toId: w.to >= ids.length ? null : ids[w.to - 1] };
      if (lane.win.toId) _lanePause(lane);
      lane.wantOlder = false;
      const anchor = _laneAnchor(lane);
      const follow = lane.follow;
      lane.follow = false;
      _laneRender(lane);
      lane.follow = follow;
      _laneRestore(lane, anchor);
      return;
    }
    const tab = _openTabs.get(v.instanceId);
    if (!tab?.hasMore || tab.loadingEarlier) return;
    lane.wantOlder = true;
    loadEarlier(v.instanceId);
    _setText(lane.older, 'Loading earlier turns\u2026');
  }

  // A page of history arrived: lanes that asked for it step back into it.
  function _lanesOnEarlier() {
    const v = _lanesView;
    if (!v) return;
    _lanesSync();
    for (const lane of v.lanes.values()) {
      if (lane.wantOlder) _laneOlder(lane);
      lane.wantOlder = false;
    }
  }

  // Eased follow of the lane's bottom, one frame at a time.
  function _laneFollow(lane) {
    if (!lane.follow || lane.raf) return;
    if (_selectionInside(lane.feed)) { _lanePause(lane); return; }
    const feed = lane.feed;
    const step = () => {
      lane.raf = 0;
      if (!lane.follow || !feed.isConnected) return;
      const target = feed.scrollHeight - feed.clientHeight;
      const d = target - feed.scrollTop;
      if (d <= 1) return;
      feed.scrollTop = _reduceMotion?.matches ? target : feed.scrollTop + Math.max(2, d * 0.22);
      lane.expectTop = feed.scrollTop;
      lane.raf = requestAnimationFrame(step);
    };
    lane.raf = requestAnimationFrame(step);
  }

  function _lanePause(lane) {
    if (!lane.follow) return;
    lane.follow = false;
    cancelAnimationFrame(lane.raf);
    lane.raf = 0;
    lane.pill.hidden = false;
  }

  function _laneResume(lane) {
    lane.follow = true;
    lane.pill.hidden = true;
    if (lane.win.toId) {
      // Paged back past the cap: go back to the newest turns.
      lane.win = {};
      _laneRender(lane);
    }
    // Results that went off the top while paused fold now.
    const top = lane.feed.getBoundingClientRect().top;
    for (const tv of lane.views.values()) {
      for (const c of tv.calls) {
        if (c.open && !c.manual && c.body.getBoundingClientRect().bottom <= top) _resultFoldAbove(c);
      }
    }
    _laneFollow(lane);
  }

  // Selecting text in a lane pauses it, like scrolling up.
  document.addEventListener('selectionchange', () => {
    if (!_lanesView) return;
    for (const lane of _lanesView.lanes.values()) {
      if (lane.follow && _selectionInside(lane.feed)) _lanePause(lane);
    }
  });

  // Done subagents dim, then fold to a rail.
  function _lanesStatus() {
    const v = _lanesView;
    if (!v) return;
    const now = Date.now();
    for (const lane of v.lanes.values()) {
      if (lane.key === LANE_MAIN) continue;
      let live = false, last = null;
      for (const id of lane.ids) {
        const i = v.byId.get(id);
        if (!i) continue;
        if (_isLiveInteraction(i)) live = true;
        const end = (i.timing?.startedAt || i.timestamp || 0) + (i.timing?.duration || 0);
        if (last == null || end > last) last = end;
      }
      let resultSeen = false;
      for (const [tuid, aid] of v.links) {
        if (aid === lane.key && v.results.has(tuid)) { resultSeen = true; break; }
      }
      const done = LANES.laneDone({ live, resultSeen, stopped: v.stopped.has(lane.key), lastActivity: last }, now);
      if (!done) {
        lane.doneAt = null;
        lane.railOpened = false;
      } else if (lane.doneAt == null) {
        lane.doneAt = now;
      }
      lane.el.classList.toggle('is-done', done);
      _setText(lane.el.querySelector('.ln-state'), done ? '\u2713 done' : '');
      lane.el.classList.toggle('is-rail', done && !lane.railOpened && now - lane.doneAt >= LANES.LIMITS.RAIL_AFTER_MS);
    }
  }

  // --- Turns ---

  function _turnCreate(lane, i, animate) {
    const el = document.createElement('article');
    el.className = 'ln-turn' + (animate ? ' ln-in' : '');
    el.dataset.id = i.id;
    // The header line; on a desktop it also carries the turn's thinking (one
    // chip per block), its token usage and its busy spinner (style.css).
    el.innerHTML = `<div class="ln-sep"><span class="ln-sep-cap"></span><span class="ln-sep-think"></span>`
      + `<span class="ln-sep-use"></span><span class="ln-spin"></span></div>`;
    const tv = { id: i.id, el, lane, blocks: new Map(), body: null, live: false, streamed: false, calls: [], waitEl: null };
    const text = LANES.turnUserText(i);
    if (text) {
      const who = lane.key === LANE_MAIN ? 'You' : (lane.ids[0] === i.id ? 'Task prompt' : 'Message');
      const q = document.createElement('blockquote');
      q.className = 'ln-user';
      q.innerHTML = `<span class="ln-user-who">${escHtml(who)}</span>${escHtml(text)}`;
      el.appendChild(q);
    }
    tv.body = document.createElement('div');
    tv.body.className = 'ln-blocks';
    el.appendChild(tv.body);
    _turnCaption(tv, i);
    if (_isLiveInteraction(i)) {
      tv.live = true;
      el.classList.add('is-live');
      const events = i.response?.sseEvents || [];
      for (const e of events) _turnApply(tv, i, e, false);
      if (!tv.blocks.size) {
        tv.waitEl = document.createElement('div');
        tv.waitEl.className = 'ln-wait';
        tv.waitEl.innerHTML = '<span></span><span></span><span></span>';
        tv.body.appendChild(tv.waitEl);
      }
    } else {
      _turnFromBody(tv, i);
    }
    return tv;
  }

  function _turnDrop(tv) {
    const v = _lanesView;
    tv.el.remove();
    tv.lane.views.delete(tv.id);
    if (v?.turns.get(tv.id) === tv) v.turns.delete(tv.id);
    for (const call of tv.calls) {
      if (call.body) tv.lane.io.unobserve(call.body);
      if (v?.calls.get(call.id) === call) v.calls.delete(call.id);
    }
  }

  // "#12 · 14:02:33 · 4.2s", and the usage "↑2 ⟳72.9k ↓1.3k".
  function _turnCaption(tv, i) {
    if (!i) return;
    const parts = [];
    const n = _lanesView?.numbers?.get(i.id);
    if (n) parts.push(n);
    const at = i.timing?.startedAt || i.timestamp;
    if (at) parts.push(formatWallTime(at));
    if (_isLiveInteraction(i)) parts.push('live');
    else if (i.timing?.duration != null) parts.push(formatDuration(i.timing.duration));
    if (i.status === 'error') parts.push('error');
    _setText(tv.el.querySelector('.ln-sep-cap'), parts.join(' \u00B7 '));
    const use = tv.el.querySelector('.ln-sep-use');
    const u = LANES.usageLine(i.usage);
    const html = u ? u.parts.map(p => `<span class="ln-use-${p.kind}">${escHtml(p.text)}</span>`).join('') : '';
    if (use.innerHTML !== html) use.innerHTML = html;
    use.title = u ? u.title : '';
  }

  // A finished turn, from its response body.
  function _turnFromBody(tv, i) {
    const content = i.response?.body?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          const b = _thinkBlock(tv, false);
          b.text.textContent = block.thinking || '';
          _thinkFold(b, block.type === 'redacted_thinking' ? null : Math.round((block.thinking || '').length / 4));
        } else if (block.type === 'text' && block.text) {
          const b = _textBlock(tv, false);
          b.el._rawText = block.text;
          renderMarkdown(block.text, b.el);
        } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
          _callBlock(tv, block.id, block.name, block.input, false, block.type === 'server_tool_use');
        }
      }
    }
    _turnError(tv, i);
  }

  function _turnError(tv, i) {
    const err = i.response?.error || (i.status === 'error' ? 'error' : null);
    if (!err || tv.el.querySelector('.ln-error')) return;
    const msg = typeof err === 'string' ? err : (err.message || err.error?.message || JSON.stringify(err));
    const el = document.createElement('div');
    el.className = 'ln-error';
    el.textContent = truncate(msg, 300);
    tv.body.appendChild(el);
  }

  function _blockEl(tv, cls, animate) {
    if (tv.waitEl) { tv.waitEl.remove(); tv.waitEl = null; }
    const el = document.createElement('div');
    el.className = cls + (animate ? ' ln-in' : '');
    tv.body.appendChild(el);
    return el;
  }

  function _thinkBlock(tv, animate) {
    const el = _blockEl(tv, 'ln-think', animate);
    el.innerHTML = `<button class="ln-think-sum">\u2234 thinking</button><div class="ln-think-body"></div>`;
    // Its chip on the header line, which stands in for the summary on a desktop.
    const chip = document.createElement('button');
    chip.className = 'ln-sep-chip';
    chip.textContent = '\u2234 thinking\u2026';
    chip._box = el;
    el._chip = chip;
    tv.el.querySelector('.ln-sep-think').appendChild(chip);
    return { kind: 'thinking', el, text: el.querySelector('.ln-think-body'), tokens: 0 };
  }

  function _thinkFold(b, tokens) {
    b.el.classList.remove('is-live');
    b.el._chip?.classList.remove('is-live');
    b.el.classList.add('is-folded');
    const tok = tokens == null ? ' (redacted)' : ` \u00B7 ${_fmtTok(tokens)} tok`;
    _setText(b.el.querySelector('.ln-think-sum'), `\u2234 thinking${tok} \u25B8`);
    _setText(b.el._chip, `\u2234 thinking ${tokens == null ? '(redacted)' : _fmtTok(tokens) + ' tok'} \u25B8`);
  }

  // Open or fold a thinking block, from its summary or its header chip.
  function _thinkToggle(box) {
    if (box.classList.contains('is-live')) return;
    const open = box.classList.toggle('is-folded') === false;
    for (const el of [box.querySelector('.ln-think-sum'), box._chip]) {
      if (el) el.textContent = el.textContent.replace(/[\u25B8\u25BE]$/, open ? '\u25BE' : '\u25B8');
    }
    box._chip?.classList.toggle('is-open', open);
  }

  function _textBlock(tv, animate) {
    const el = _blockEl(tv, 'ln-text markdown-body', animate);
    return { kind: 'text', el };
  }

  function _callBlock(tv, id, name, input, animate, server = false) {
    const el = _blockEl(tv, 'ln-tool', animate);
    el.innerHTML = `<div class="ln-call"><span class="ln-call-ico"></span><span class="ln-call-name"></span>`
      + `<span class="ln-call-arg"></span><span class="ln-spin"></span></div>`;
    const call = { id, el, name, lane: tv.lane, input: null, server, result: false, body: null, open: false, manual: false };
    tv.calls.push(call);
    if (input !== undefined) _callFill(call, input);
    else {
      el.querySelector('.ln-call-ico').textContent = LANES.toolLine(name, null).icon;
      _setText(el.querySelector('.ln-call-name'), name || 'tool');
    }
    return { kind: 'tool', el, call, json: '' };
  }

  function _callFill(call, input) {
    const v = _lanesView;
    call.input = input || {};
    const line = LANES.toolLine(call.name, call.input);
    call.el.querySelector('.ln-call-ico').textContent = line.icon;
    _setText(call.el.querySelector('.ln-call-name'), line.name);
    const arg = call.el.querySelector('.ln-call-arg');
    _callArg(arg, line);
    arg.title = line.title;
    _callThumb(call);
    // What the call is for, under its line.
    let desc = call.el.querySelector('.ln-call-desc');
    if (line.desc && !desc) {
      desc = document.createElement('div');
      desc.className = 'ln-call-desc';
      call.el.querySelector('.ln-call').after(desc);
    }
    if (desc) {
      desc.textContent = line.desc;
      desc.title = typeof call.input.description === 'string' ? call.input.description : '';
      desc.hidden = !line.desc;
    }
    if (call.id && v) v.calls.set(call.id, call);
    _callRefresh(call);
  }

  /* The call's argument, its paths file links as elsewhere in the inspector:
     a file it names shortened links the whole file; in other text, what
     linkifyFilePaths finds, short of a cut argument's last word. */
  function _callArg(arg, line) {
    if (arg.textContent === line.arg && arg.dataset.filepath === (line.path || undefined)) return;
    arg.textContent = '';
    delete arg.dataset.filepath;
    if (line.path) {
      arg.dataset.filepath = line.path;
      const a = document.createElement('a');
      a.className = 'file-link';
      a.href = '#';
      a.title = 'Preview ' + line.path;
      a.dataset.filepath = line.path;
      a.textContent = line.arg;
      arg.appendChild(a);
      return;
    }
    arg.appendChild(document.createTextNode(line.linkable));
    if (line.linkable !== line.arg) {
      const tail = document.createElement('span');
      tail.className = 'no-linkify';
      tail.textContent = line.arg.slice(line.linkable.length);
      arg.appendChild(tail);
    }
    linkifyDetail(arg);
  }

  // Attach the call's result once the next turn brought it — open, when it
  // arrives live — and colour an Agent call like the lane of the subagent it ran.
  function _callRefresh(call, live = false) {
    const v = _lanesView;
    if (!v || !call.id) return;
    call.el.classList.toggle('is-pending', !call.server && !call.result);
    if (call.name === 'Agent' || call.name === 'Task') {
      const aid = v.links.get(call.id);
      const lane = aid && v.lanes.get(aid);
      if (lane) {
        // Colours follow the subagent registry, which a timeline rebuild renumbers.
        const line = call.el.querySelector('.ln-call');
        line.classList.add('is-agent');
        line.dataset.agentLane = aid;
        line.title = `Show ${_laneLabel(lane)}`;
        call.el.style.setProperty('--ln-agent', _laneColor(lane));
      }
    }
    if (call.result) return;
    const block = v.results.get(call.id);
    if (!block) return;
    const r = LANES.resultLine(block);
    call.result = true;
    call.el.classList.remove('is-pending');
    const res = document.createElement('button');
    res.className = 'ln-result' + (r.error ? ' is-error' : '') + (v.built ? ' ln-in' : '');
    res.textContent = `\u2514 ${r.text}`;
    res._call = call;
    call.el.appendChild(res);
    if (!r.preview) return;
    // The output itself, its first rows only; the rest stays a string until asked for.
    const rows = LANES.resultRows(r.preview + (block._truncated ? '\n\u2026' : ''));
    const body = document.createElement('div');
    body.className = 'ln-result-body' + (r.error ? ' is-error' : '');
    body.hidden = true;
    body._call = call;
    body.innerHTML = '<pre class="ln-result-pre"></pre>';
    body.firstChild.textContent = rows.head;
    linkifyDetail(body.firstChild);
    if (rows.more) {
      const more = document.createElement('button');
      more.className = 'ln-result-more';
      more.textContent = `\u2026 ${rows.more} more line${rows.more === 1 ? '' : 's'}`;
      body.appendChild(more);
      call.rest = rows.rest;
    }
    if (!r.error) {
      const media = LANES.mediaPaths(r.preview, _pathCategory, undefined, call.media ? [call.media] : []);
      if (media.items.length) body.appendChild(_thumbStrip(media, call));
    }
    call.el.appendChild(body);
    call.body = body;
    if (live && v.built) _resultOpen(call, true);
  }

  const _pathCategory = p => fileCategory((p.match(/\.([^./]+)$/) || [])[1]?.toLowerCase() || '');

  /* The media files a result names, as thumbnails under its output; a click
     opens the preview, as the path's link does. Their size is fixed, so
     loading never moves the lane; one whose file is gone just leaves. */
  function _thumbStrip({ items, more }, call) {
    const strip = document.createElement('div');
    strip.className = 'ln-thumbs';
    for (const { path, category } of items) {
      strip.appendChild(_thumbButton(path, category, () => _thumbsGone(strip, call)));
    }
    if (more) {
      const m = document.createElement('span');
      m.className = 'ln-thumbs-more';
      m.textContent = `+${more} more`;
      strip.appendChild(m);
    }
    return strip;
  }

  // One thumbnail: a button holding the image (a video's frame, a note for
  // audio); a file that will not load hides it, then calls gone().
  function _thumbButton(path, category, gone) {
    const t = document.createElement('button');
    t.className = 'ln-thumb is-' + category;
    t.dataset.filepath = path;
    t.title = 'Preview ' + path;
    if (category === 'audio') {
      t.textContent = '\u266A';
      return t;
    }
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = category === 'video'
      ? '/api/video-thumb?i=1&path=' + encodeURIComponent(path)
      : '/api/raw-file?path=' + encodeURIComponent(path);
    img.addEventListener('error', () => {
      // A video's first frame may still be cut when another strip asks.
      if (category === 'video' && !img.dataset.retried) {
        img.dataset.retried = '1';
        setTimeout(() => { img.src = img.src; }, 1500);
        return;
      }
      t.hidden = true;
      gone();
    });
    t.appendChild(img);
    if (category === 'video') t.insertAdjacentHTML('beforeend', '<span class="ln-thumb-play">\u25B6</span>');
    return t;
  }

  /* A media file the call names in its input gets its thumbnail on the
     call's line, beside the name, no taller than the line; the result's
     strip then leaves that file out. */
  function _callThumb(call) {
    const media = LANES.callMedia(call.input, _pathCategory);
    const line = call.el.querySelector('.ln-call');
    const old = line.querySelector('.ln-call-thumb');
    if (old?.dataset.filepath === media?.path) return;
    old?.remove();
    call.media = media?.path || null;
    if (!media) return;
    const t = _thumbButton(media.path, media.category, () => {});
    t.classList.add('ln-call-thumb');
    line.querySelector('.ln-call-arg').after(t);
  }

  // Hovering a call line's thumbnail shows it larger, beside it.
  let _thumbPop = null;
  function _thumbPopShow(t) {
    const img = t.querySelector('img');
    if (!img || t.hidden) return;
    if (!_thumbPop) {
      _thumbPop = document.createElement('img');
      _thumbPop.className = 'ln-thumb-pop';
      _thumbPop.alt = '';
      document.body.appendChild(_thumbPop);
    }
    _thumbPop.src = img.src;
    const r = t.getBoundingClientRect();
    const size = 180;
    _thumbPop.style.left = Math.max(4, Math.min(r.left, innerWidth - size - 4)) + 'px';
    _thumbPop.style.top = (r.bottom + size + 8 < innerHeight ? r.bottom + 4 : Math.max(4, r.top - size - 4)) + 'px';
    _thumbPop.hidden = false;
  }
  function _thumbPopHide() { if (_thumbPop) _thumbPop.hidden = true; }

  // Every thumbnail failed: the strip goes, and a lane it sat above the top
  // of scrolls up by its height, so what is in view stays put.
  function _thumbsGone(strip, call) {
    if (strip.querySelector('.ln-thumb:not([hidden]), .ln-thumbs-more')) return;
    if (!call) { strip.hidden = true; return; }
    const feed = call.lane.feed;
    const above = strip.getBoundingClientRect().bottom <= feed.getBoundingClientRect().top;
    const top = feed.scrollTop, height = feed.scrollHeight;
    strip.hidden = true;
    const diff = height - feed.scrollHeight;
    if (above && diff > 0) {
      feed.scrollTop = top - diff;
      call.lane.expectTop = feed.scrollTop;
    }
  }

  /* A result whole in the big modal, as a .md file opens: its thumbnails
     above, its paths links. One the summary cut is fetched in full (the
     turn that carries it) and shown again when it lands, if still open. */
  let _resultModalWait = null;   // { id, call, overlay }
  function _resultModal(call, block = _lanesView?.results.get(call.id)) {
    if (!block) return;
    const r = LANES.resultLine(block);
    const line = LANES.toolLine(call.name, call.input);
    const media = r.error ? null : LANES.mediaPaths(r.preview, _pathCategory, 100);
    let strip = null;
    if (media?.items.length) {
      strip = _thumbStrip(media, null);
      strip.classList.add('file-preview-thumbs');
      strip.addEventListener('click', e => {
        const t = e.target.closest('.ln-thumb');
        if (t) openFilePreview(t.dataset.filepath);
      });
    }
    const cut = !!block._truncated;
    const overlay = openTextPreview({
      title: `${line.name} ${r.error ? 'error' : 'result'}`,
      subtitle: line.title || line.arg,
      text: r.preview + (cut ? '\n\u2026' : ''),
      markdown: !r.error && LANES.looksLikeMarkdown(r.preview),
      note: cut ? 'loading the rest\u2026' : '',
      before: strip,
    });
    _resultModalWait = null;
    if (!cut) return;
    const id = LANES.resultHolder(state.interactions, call.id);
    if (!id) return;
    _resultModalWait = { id, call, overlay };
    _pendingDetailRequests.add(id);
    sendWs({ type: 'interaction:getDetail', id });
  }

  // The turn's detail landed: the open modal shows the whole result.
  function _resultModalDetail(i) {
    const w = _resultModalWait;
    if (!w || w.id !== i.id) return;
    _resultModalWait = null;
    if (!w.overlay.isConnected) return;
    const block = LANES.toolResultsOf(i).find(b => b.tool_use_id === w.call.id);
    if (block && !block._truncated) _resultModal(w.call, block);
  }

  // Open a result's output: an eased height and fade.
  function _resultOpen(call, animate) {
    const body = call.body;
    if (!body || call.open) return;
    call.open = true;
    call.el.classList.add('is-open');
    const token = call.anim = (call.anim || 0) + 1;
    body.hidden = false;
    if (!call.manual) call.lane.io.observe(body);
    if (!animate || _reduceMotion?.matches) {
      body.style.height = body.style.opacity = '';
      _laneFollow(call.lane);
      return;
    }
    body.style.height = '0px';
    body.style.opacity = '0';
    void body.offsetHeight;
    body.style.height = body.scrollHeight + 'px';
    body.style.opacity = '1';
    _afterTransition(body, () => {
      if (call.anim !== token) return;
      body.style.height = body.style.opacity = '';
      _laneFollow(call.lane);
    });
  }

  // Fold it back to its line: a smooth height, unless it is off screen.
  function _resultClose(call, animate) {
    const body = call.body;
    if (!body || !call.open) return;
    call.open = false;
    call.el.classList.remove('is-open');
    call.lane.io.unobserve(body);
    const token = call.anim = (call.anim || 0) + 1;
    const done = () => {
      if (call.anim !== token) return;
      body.hidden = true;
      body.style.height = body.style.opacity = '';
    };
    if (!animate || _reduceMotion?.matches) { done(); return; }
    body.style.height = body.offsetHeight + 'px';
    body.style.opacity = '1';
    void body.offsetHeight;
    body.style.height = '0px';
    body.style.opacity = '0';
    _afterTransition(body, done);
  }

  // A result that went off the top folds at once — nobody sees it — and the
  // lane scrolls up by what it gave back, so what is in view stays put.
  function _resultFoldAbove(call) {
    if (!call || call.manual || !call.open) return;
    const feed = call.lane.feed;
    const top = feed.scrollTop, height = feed.scrollHeight;
    _resultClose(call, false);
    const diff = height - feed.scrollHeight;
    if (diff > 0) {
      feed.scrollTop = top - diff;
      call.lane.expectTop = feed.scrollTop;
    }
  }

  // transitionend, or a timer in case it never fires (the element left).
  function _afterTransition(el, fn) {
    let fired = false;
    const once = () => { if (fired) return; fired = true; el.removeEventListener('transitionend', onEnd); fn(); };
    const onEnd = e => { if (e.target === el && e.propertyName === 'height') once(); };
    el.addEventListener('transitionend', onEnd);
    setTimeout(once, 260);
  }

  // One streamed event into a turn's element.
  function _turnApply(tv, i, event, animate) {
    const { eventType, data } = event;
    if (eventType === 'message_start') { tv.streamed = true; return; }
    if (eventType === 'content_block_start') {
      tv.streamed = true;
      const cb = data?.content_block;
      if (!cb) return;
      let b = null;
      if (cb.type === 'thinking' || cb.type === 'redacted_thinking') {
        b = _thinkBlock(tv, animate);
        b.el.classList.add('is-live');
        b.el._chip.classList.add('is-live');
        b.redacted = cb.type === 'redacted_thinking';
      } else if (cb.type === 'text') {
        b = _textBlock(tv, animate);
        b.el.classList.add('is-streaming');
        if (cb.text) { b.el._rawText = cb.text; renderMarkdownDebounced(cb.text, b.el); }
      } else if (cb.type === 'tool_use' || cb.type === 'server_tool_use') {
        b = _callBlock(tv, cb.id, cb.name, undefined, animate, cb.type === 'server_tool_use');
      }
      if (b) tv.blocks.set(data.index, b);
      return;
    }
    const b = tv.blocks.get(data?.index);
    if (eventType === 'content_block_delta' && b) {
      const delta = data.delta || {};
      if (delta.type === 'thinking_delta' && b.kind === 'thinking') {
        b.text.appendChild(document.createTextNode(delta.thinking || ''));
        b.chars = (b.chars || 0) + (delta.thinking || '').length;
        if (delta.estimated_tokens) b.tokens += delta.estimated_tokens;
        b.text.scrollTop = b.text.scrollHeight;
      } else if (delta.type === 'text_delta' && b.kind === 'text') {
        const el = b.el;
        el._rawText = (el._rawText || '') + (delta.text || '');
        if (_selectionInside(el)) { cancelRenderDebounce(el); _deferredMarkdown.add(el); }
        else renderMarkdownDebounced(el._rawText, el);
      } else if (delta.type === 'input_json_delta' && b.kind === 'tool') {
        b.json += delta.partial_json || '';
      }
      return;
    }
    if (eventType === 'content_block_stop' && b) _blockFinish(b);
    if (eventType === 'message_stop') {
      for (const blk of tv.blocks.values()) _blockFinish(blk);
    }
  }

  function _blockFinish(b) {
    if (b.done) return;
    b.done = true;
    if (b.kind === 'thinking') {
      _thinkFold(b, b.redacted ? null : (b.tokens || Math.round((b.chars || 0) / 4)));
    } else if (b.kind === 'text') {
      const el = b.el;
      el.classList.remove('is-streaming');
      cancelRenderDebounce(el);
      if (el._rawText) {
        if (_selectionInside(el)) _deferredMarkdown.add(el);
        else renderMarkdown(el._rawText, el);
      }
    } else if (b.kind === 'tool') {
      let input = {};
      try { input = b.json ? JSON.parse(b.json) : {}; } catch {}
      _callFill(b.call, input);
    }
  }

  // --- Live hooks from the message and SSE paths ---

  function _lanesOnSSE(interaction, event) {
    const v = _lanesView;
    if (interaction.instanceId !== v.instanceId) return;
    const tv = v.turns.get(interaction.id);
    // A turn without its element yet gets it (with the events so far) on sync.
    if (!tv) { _lanesQueueSync(); return; }
    _turnApply(tv, interaction, event, true);
    if (event.eventType === 'message_start') _turnCaption(tv, interaction);
    if (event.eventType === 'message_delta' && event.data?.usage) {
      _turnCaption(tv, interaction);
      _laneHeader(tv.lane);
    }
    _laneFollow(tv.lane);
  }

  // A turn's status moved (complete, error): finish its element.
  function _lanesOnUpdate(i) {
    const v = _lanesView;
    if (i.instanceId !== v.instanceId) return;
    const tv = v.turns.get(i.id);
    if (tv && tv.live && !_isLiveInteraction(i)) {
      tv.live = false;
      tv.el.classList.remove('is-live');
      if (tv.waitEl) { tv.waitEl.remove(); tv.waitEl = null; }
      if (tv.streamed) {
        for (const b of tv.blocks.values()) _blockFinish(b);
        _turnError(tv, i);
      } else {
        _turnFromBody(tv, i);
      }
      _laneFollow(tv.lane);
    }
    _lanesQueueSync();
  }

  function _lanesOnClick(e) {
    const v = _lanesView;
    if (!v) return;
    const laneEl = e.target.closest('.ln-lane');
    const lane = laneEl && v.lanes.get(laneEl.dataset.lane);
    if (e.target.closest('.ln-pill')) { if (lane) _laneResume(lane); return; }
    if (e.target.closest('.ln-older')) { if (lane) _laneOlder(lane); return; }
    if (e.target.closest('.ln-rail')) {
      if (lane) { lane.railOpened = true; laneEl.classList.remove('is-rail'); }
      return;
    }
    const think = e.target.closest('.ln-think-sum');
    if (think) { _thinkToggle(think.parentElement); return; }
    const chip = e.target.closest('.ln-sep-chip');
    if (chip) { _thinkToggle(chip._box); return; }
    // A result opened or folded by hand stays that way.
    const res = e.target.closest('.ln-result');
    if (res) {
      const call = res._call;
      if (!call?.body) return;
      call.manual = true;
      if (call.open) _resultClose(call, true); else _resultOpen(call, true);
      return;
    }
    const more = e.target.closest('.ln-result-more');
    if (more) {
      const call = more.parentElement._call;
      if (!call) return;
      call.manual = true;
      call.lane.io.unobserve(call.body);
      // Appended, so the links made so far stay; linkify skips them.
      call.body.firstChild.appendChild(document.createTextNode('\n' + (call.rest || '')));
      linkifyDetail(call.body.firstChild);
      call.rest = '';
      more.remove();
      return;
    }
    const link = e.target.closest('.file-link');
    if (link) { e.preventDefault(); openFilePreview(link.dataset.filepath); return; }
    const thumb = e.target.closest('.ln-thumb');
    if (thumb) { openFilePreview(thumb.dataset.filepath); return; }
    const resBody = e.target.closest('.ln-result-body');
    if (resBody) {
      if (resBody._call && LANES.bodyClickOpens(e.target, window.getSelection()?.toString())) _resultModal(resBody._call);
      return;
    }
    const quote = e.target.closest('.ln-user');
    if (quote) { quote.classList.toggle('is-open'); return; }
    const agent = e.target.closest('.ln-call.is-agent');
    if (agent) {
      const target = v.lanes.get(agent.dataset.agentLane);
      if (!target) return;
      target.railOpened = true;
      target.el.classList.remove('is-rail');
      target.el.scrollIntoView({ behavior: _reduceMotion?.matches ? 'auto' : 'smooth', block: 'nearest', inline: 'nearest' });
      target.el.classList.remove('is-flash');
      void target.el.offsetWidth;
      target.el.classList.add('is-flash');
      return;
    }
    if (e.target.closest('a')) return;
    // Anything else in a turn opens it in the full detail view — not the end
    // of a drag that selected text.
    const turnEl = e.target.closest('.ln-turn');
    if (!turnEl) return;
    const s = window.getSelection();
    if (s && !s.isCollapsed && turnEl.contains(s.anchorNode)) return;
    select({ type: 'turn', id: turnEl.dataset.id }, { userClick: true });
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
      // Keeps what the summary leaves out and this page already has: the
      // streamed events, the response gauge (a client-side running counter),
      // a subagent guess, a fetched conversation.
      state.interactions[idx] = RET.mergeLiveUpdate(state.interactions[idx], _adoptIncoming(updated));
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

    if (_lanesView && idx >= 0) _lanesOnUpdate(state.interactions[idx]);
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
    if (_lanesView && interaction) _lanesOnUpdate(interaction);
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
      if (i.instanceId !== interaction.instanceId) continue;
      if (!i.isMcp && !i.isHook && isStandardLlm(i) && hasAssistantMessage(i)) n++;
      if (i === interaction) return n;
    }
    return n;
  }

  let _lastRenderedAgentId = null;

  // --- Timeline view mode toggle (single column vs parallel columns) ---
  let _timelineMode = 'parallel';

  function initTimelineToggle() {
    const header = document.getElementById('timeline-header');
    if (!header || header.querySelector('.timeline-view-toggle')) return;
    const toggle = document.createElement('div');
    toggle.className = 'timeline-view-toggle';

    const liveOnSvg = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,6.5 5,9.5 10,3"/></svg>`;
    const liveOffSvg = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="3" y1="3" x2="9" y2="9"/><line x1="9" y1="3" x2="3" y2="9"/></svg>`;
    function liveButtonContent(on) { return (on ? liveOnSvg : liveOffSvg) + `<span class="tl-toggle-label">live</span>`; }

    toggle.innerHTML = `
      <button class="tl-toggle-btn tl-live-btn${_liveMode ? ' active' : ''}" title="${_liveMode ? 'Live mode on' : 'Live mode off'}">${liveButtonContent(_liveMode)}</button>
    `;
    const liveBtn = toggle.querySelector('.tl-live-btn');
    liveBtn.addEventListener('click', () => {
      _liveMode = !_liveMode;
      localStorage.setItem('timelineLive', _liveMode);
      liveBtn.classList.toggle('active', _liveMode);
      liveBtn.innerHTML = liveButtonContent(_liveMode);
      liveBtn.title = _liveMode ? 'Live mode on' : 'Live mode off';
      _lanesPinned = false;
      _lanesUpdateBackBtn();
      if (_liveMode) selectLastAndFollow();
      else if (_lanesView) {
        // Off: no trace of the lanes; the panel shows the selection as always.
        _lanesTeardown();
        if (state.selection) select(state.selection);
        else selectLastAndFollow();
      }
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
        ${stepChip}${subagentTag}
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
    _renderLoadEarlier();
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
    // The column pass may have moved a turn to another agent.
    _lanesQueueSync();

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

    el.innerHTML = turnHeaderHtml(interaction, turnNum, isSubagentTurn);

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

  function scrollTimelineToBottom() {
    const el = document.getElementById('timeline-list');
    el.scrollTop = el.scrollHeight;
  }

  // ============================================================
  // SELECTION + DETAIL PANEL
  // ============================================================

  function selectLastAndFollow() {
    const filtered = state.interactions.filter(i => i.instanceId === activeInstanceTab);
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

  /* The inspector is on screen when its view is shown and the browser tab is
     in front. Hidden, nothing renders; hidden for a while, the detail panel
     and every full-detail turn are dropped, summaries kept. */
  const _inspectorView = document.getElementById('view-dashboard');
  function _inspectorShown() {
    if (document.hidden) return false;
    return !_inspectorView || (_inspectorView.style.display !== 'none' && !_inspectorView.classList.contains('hidden'));
  }
  let _renderOnShow = false;           // a render held back while hidden
  let _hiddenDropTimer = null;
  let _wasShown = _inspectorShown();

  function _onInspectorVisibility() {
    const shown = _inspectorShown();
    if (shown === _wasShown) return;
    _wasShown = shown;
    if (!shown) {
      if (!_hiddenDropTimer) _hiddenDropTimer = setTimeout(_dropHiddenDetail, RET.LIMITS.HIDDEN_DROP_MS);
      return;
    }
    clearTimeout(_hiddenDropTimer);
    _hiddenDropTimer = null;
    if (!_renderOnShow) return;
    _renderOnShow = false;
    // Lanes missed what streamed meanwhile: build them again.
    _lanesTeardown();
    if (_lanesActive()) _lanesShow();
    else if (state.selection) select(state.selection);
  }

  function _dropHiddenDetail() {
    _hiddenDropTimer = null;
    if (_inspectorShown()) return;
    const hadLanes = !!_lanesView;
    _lanesTeardown();
    _detailView = null;
    _deferredRender = null;
    detailContent.innerHTML = '';
    _compactInteractions({ hidden: true });
    if (state.selection || hadLanes) _renderOnShow = true;
  }

  document.addEventListener('visibilitychange', _onInspectorVisibility);
  if (_inspectorView) {
    new MutationObserver(_onInspectorVisibility)
      .observe(_inspectorView, { attributes: true, attributeFilter: ['style', 'class'] });
  }

  /* Every turn's request carries the whole conversation so far, so holding
     each one at full size grows quadratically over a long session. Turns
     arrive as summaries (summarizeForInit in src/dashboard-ws.js); the one on
     screen fetches its detail, and past a small budget of recently used
     items a turn is trimmed back to the summary shape. Selecting it again
     refetches the detail. The decisions live in inspector-retention.js. */
  const RET = window.inspectorRetention;
  const _recentFull = [];              // ids, least recently used first
  const _interner = RET.createInterner();  // one copy of a session's first message
  let _compactTimer = null;

  function _touchFull(id) {
    const at = _recentFull.indexOf(id);
    if (at >= 0) _recentFull.splice(at, 1);
    _recentFull.push(id);
    _scheduleCompaction();
  }

  function _scheduleCompaction() {
    if (_compactTimer) return;
    _compactTimer = setTimeout(() => { _compactTimer = null; _compactInteractions(); }, 1000);
  }

  function _compactInteractions({ hidden = false } = {}) {
    _recentFull.splice(0, Math.max(0, _recentFull.length - RET.LIMITS.FULL_DETAIL_BUDGET));
    const keep = new Set();
    const sel = state.selection;
    if (sel) keep.add(sel.type === 'tool' ? sel.interactionId : sel.id);
    const plan = RET.compactionPlan(state.interactions, {
      recentFull: _recentFull, keep, activeInstance: activeInstanceTab, hidden, now: Date.now(),
    });
    if (!plan.length) return;
    const byId = new Map(state.interactions.map(i => [i.id, i]));
    for (const { id, dropStream } of plan) {
      const i = byId.get(id);
      if (i) _compactInteraction(i, { dropStream });
    }
    if (hidden) _recentFull.length = 0;
  }

  // Serialized size of a value, for the size gauges: measured once per object
  // rather than re-stringifying a whole conversation on every render.
  const _charsCache = new WeakMap();
  function _jsonChars(v) {
    if (v == null) return 0;
    if (typeof v === 'string') return v.length;
    if (typeof v !== 'object') return String(v).length;
    let n = _charsCache.get(v);
    if (n === undefined) {
      n = JSON.stringify(v)?.length || 0;
      _charsCache.set(v, n);
    }
    return n;
  }

  // A response body over this size is cut once its turn is trimmed (as the
  // server cuts it in a summary); the detail fetch brings it back whole.
  const RESP_BODY_KEEP_MAX = 64 * 1024;
  function _cutStrings(v, max, depth = 0) {
    if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
    if (!v || typeof v !== 'object' || depth > 32) return v;
    if (Array.isArray(v)) return v.map(x => _cutStrings(x, max, depth + 1));
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = _cutStrings(x, max, depth + 1);
    return out;
  }

  // Turns that arrive (live, snapshot, a page of history) share their first
  // message's text with the session's other turns: keep one copy.
  function _adoptIncoming(i) {
    if (typeof i?.request?._firstUserText === 'string') {
      i.request._firstUserText = _interner.intern(i.instanceId, i.request._firstUserText);
    }
    return i;
  }

  function _compactInteraction(i, { dropStream = false } = {}) {
    const req = i.request;
    if (req) {
      const r = { ...req };
      if (Array.isArray(r.messages)) {
        const msgs = r.messages;
        const last = msgs[msgs.length - 1];
        const lastContent = Array.isArray(last?.content) ? last.content : [];
        r._messageCount = msgs.length;
        if (!r._messagesChars) r._messagesChars = _jsonChars(msgs);
        r._lastMessage = last ? {
          role: last.role,
          hasText: typeof last.content === 'string' || lastContent[lastContent.length - 1]?.type === 'text',
        } : null;
        // Tool results only ever arrive in the newest user message — keep
        // them for findToolResult. The first user message's text is what
        // wide-layout matches an Agent call's prompt against.
        const results = last?.role === 'user' ? lastContent.filter(b => b.type === 'tool_result') : [];
        if (results.length) r._toolResults = results;
        const fresh = LANES.newUserText(msgs);
        if (fresh) r._newUserText = fresh;
        const first = msgs.find(m => m.role === 'user');
        if (first) {
          const text = typeof first.content === 'string' ? first.content
            : (Array.isArray(first.content) ? first.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n') : '');
          r._firstUserText = _interner.intern(i.instanceId, text.replace(/\s+/g, ' ').trim().slice(0, 8000));
        }
        delete r.messages;
      }
      if (Array.isArray(r.tools)) {
        r._toolCount = r.tools.length;
        if (!r._toolsChars) r._toolsChars = _jsonChars(r.tools);
        delete r.tools;
      }
      if (r.system) {
        if (!r._systemChars) r._systemChars = _jsonChars(r.system);
        delete r.system;
      }
      if (i.isHook) {
        if (r.tool_response !== undefined) {
          if (typeof r.tool_response?.agentId === 'string') r._agentId = r.tool_response.agentId;
          r._toolResponseChars = JSON.stringify(r.tool_response).length;
          delete r.tool_response;
        }
        if (Array.isArray(r.tool_calls)) {
          r.tool_calls = r.tool_calls.map(tc => tc.tool_response
            ? { ...tc, tool_response: undefined, _toolResponseChars: JSON.stringify(tc.tool_response).length }
            : tc);
        }
        if (i.response) i.response = { ...i.response, body: undefined };
      }
      i.request = r;
    }
    delete i.translatedBody;
    // The stream is a second copy of the response; drop it once the body
    // tells the same story (the select path lazy-loads it back).
    // A turn still streaming keeps its events unless it is stuck.
    const resp = i.response;
    if (resp?.sseEvents?.length && (dropStream || (resp.body && !_isLiveInteraction(i)
        && hasAssistantMessage({ response: { body: resp.body } }) === hasAssistantMessage(i)))) {
      if (!i._respChars) i._respChars = _respCharCount(i);
      i.response = { ...resp, sseEvents: undefined };
      if (dropStream) _sseIndex.delete(i.id);
    }
    // A large response body is cut like the server cuts it in a summary.
    if (resp?.body && !i._summary && !_isLiveInteraction(i)) {
      const chars = _jsonChars(resp.body);
      if (chars > RESP_BODY_KEEP_MAX) {
        if (!i._respChars) i._respChars = _respCharCount(i);
        i.response = { ...i.response, body: _cutStrings(resp.body, 2000), _bodyChars: chars, _bodyTruncated: true };
      }
    }
    i._summary = true;
  }

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
    if (!_inspectorShown()) { _renderOnShow = true; return; }
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
    // Off screen (another view, a background browser tab) a selection is only
    // recorded; its detail is fetched and rendered once the inspector shows.
    if (!_inspectorShown()) { _renderOnShow = true; return; }
    // Phones show timeline and detail one at a time; a tap drills in.
    if (userClick) window.dashboard.mobileShowDetail?.();

    document.querySelectorAll('.timeline-entry.selected').forEach(el => el.classList.remove('selected'));

    if (_timelineMode === 'parallel' && _d3State) {
      d3UpdateSelection(_d3State.nodesLayer);
    }

    // Live mode shows the lanes. A turn opened by hand shows its full detail
    // and stays until the reader goes back to the lanes.
    if (_liveMode) {
      if (userClick) _lanesPinned = true;
      _lanesUpdateBackBtn();
      if (_lanesActive()) {
        if (sel.type === 'turn') document.querySelector(`.turn-entry[data-id="${sel.id}"]`)?.classList.add('selected');
        _lanesShow();
        return;
      }
      _lanesTeardown();
    }

    if (sel.type === 'turn') {
      const el = document.querySelector(`.turn-entry[data-id="${sel.id}"]`);
      if (el) {
        el.classList.add('selected');
        if (userClick) el.scrollIntoView({ block: 'nearest' });
      }

      const interaction = state.interactions.find(i => i.id === sel.id);
      if (!interaction) return;

      if (interaction._summary && _needsDetailOnSelect(interaction)) {
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

      emptyState.classList.add('hidden');
      detailContent.classList.remove('hidden');
      _renderDetail(sel, interaction);
    }
  }

  // jsonBlock marks a small value with its line count (data-jt-lines); a
  // large one has none and stays folded.
  // An LLM turn's detail is fetched by the sections that need it, as they
  // open (_bindLazySections) — not for a turn nobody looks into. Hook and MCP
  // panels, and a response cut in the summary, show it all at once.
  function _needsDetailOnSelect(i) {
    return !!(i.isHook || i.isMcp || i.response?._bodyTruncated || !isStandardLlm(i));
  }

  function autoExpandSmallJsonBlocks(container) {
    container.querySelectorAll('.jt-root[data-jt-lines]').forEach(root => {
      if (Number(root.dataset.jtLines) <= 50)
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

    // Images pasted into the prompt: the hook payload names none, the store
    // reads them from the transcript (src/prompt-images.js).
    if (interaction.promptImages?.length) {
      html += '<div class="section-title">Attached Images</div><div class="hook-prompt-images">';
      for (const p of interaction.promptImages) {
        html += `<figure class="hook-prompt-image">
          <button data-filepath="${escHtml(p)}" title="Preview ${escHtml(p)}"><img loading="lazy" alt="" src="/api/raw-file?path=${encodeURIComponent(p)}"></button>
          <figcaption>${escHtml(p)}</figcaption>
        </figure>`;
      }
      html += '</div>';
    }

    html += '<div class="section-title">Raw Hook Data</div>';
    html += jsonBlock(req);

    detailContent.innerHTML = html;
    for (const btn of detailContent.querySelectorAll('.hook-prompt-image button')) {
      btn.addEventListener('click', () => openFilePreview(btn.dataset.filepath));
      // Claude Code's temp dir is cleared in time: the path stays, the picture goes.
      btn.querySelector('img').addEventListener('error', () => btn.closest('.hook-prompt-image').classList.add('is-gone'));
    }
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

  /* A section body given as a function (the conversation, the tools, the
     system prompt, the raw stream) is built only while its section is open,
     and dropped again when it closes. */
  const _bodyHtml = (body, open) => typeof body === 'function' ? (open ? body() : '') : body;

  /* Build one chip + its section. `size:'compact'` marks the small info
     grids, which take their natural height instead of an equal share. */
  function _secHtml(key, label, body, opts = {}) {
    const { count = '', size = 'elastic', empty = false, countId = '', placeholder = '' } = opts;
    const open = !empty && _isSecOpen(key);
    const lazyBody = typeof body === 'function';
    body = _bodyHtml(body, open);
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
      sec: `<div class="${cls.join(' ')}" data-sec="${key}" data-size="${size}"${opts.lazyId ? ` data-lazy-detail="${opts.lazyId}"` : ''}${lazyBody ? ` data-lazy-body="${open ? '' : 'pending'}"` : ''}>
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
      // _-prefixed keys are the summary's own (counts, sizes), not the request's.
      if (!_REQ_KNOWN_KEYS.has(k) && !k.startsWith('_')) other[k] = v;
    }
    return other;
  }

  /* One `id ±chars` per enabled proxy rule, in run order — a rule that never
     moves the number is dead. Zero is printed as such, not hidden. */
  function _rulesSummary(rules) {
    return rules.map(r => {
      const d = Number(r.delta) || 0;
      const n = d === 0 ? '0' : (d > 0 ? '+' : '\u2212') + Math.abs(d).toLocaleString();
      return `${escHtml(r.id)} <span style="opacity:${d === 0 ? 0.5 : 1}">${n}</span>`;
    }).join(' \u00b7 ');
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
      ${Array.isArray(interaction.rules) && interaction.rules.length ? `<span class="info-label">Rules</span><span class="info-value">${_rulesSummary(interaction.rules)}</span>` : ''}
    </div>`;

    if (interaction.subagent && (interaction.subagent.agentType || interaction.subagent.agentId || interaction.subagent.description)) {
      const sa = interaction.subagent;
      infoBody += `<div class="info-grid subagent-info">
        <span class="info-label">Agent</span><span class="info-value" style="color:var(--cyan)">${escHtml(sa.agentType || 'unknown')}</span>
        <span class="info-label">Agent ID</span><span class="info-value">${escHtml(sa.agentId || '--')}</span>
        <span class="info-label">Description</span><span class="info-value">${escHtml(sa.description || '--')}</span>
        <span class="info-label">Attributed</span><span class="info-value"${interaction._subagentInferred ? ' style="color:var(--text-dim)"' : ''}>${interaction._subagentInferred ? 'guessed from spawn prompt' : 'by server'}</span>
      </div>`;
    }
    push('req:info', 'Info', infoBody, { size: 'compact' });

    if (req.system) {
      push('req:system', 'System', () => jsonBlock(req.system), { count: charGauge(req._systemChars || _jsonChars(req.system)) });
    } else if (req._systemChars) {
      push('req:system', 'System', '<div class="json-block" style="opacity:0.5">Loading...</div>',
        { count: charGauge(req._systemChars), lazyId: interaction.id });
    } else {
      push('req:system', 'System', '', { empty: true });
    }

    if (req.messages?.length > 0) {
      const msgChars = req._messagesChars || _jsonChars(req.messages);
      push('req:messages', 'Messages', () => renderMessages(req.messages, interaction.id),
        { count: `${req.messages.length} ${charGauge(msgChars)}` });
    } else if (req._messageCount > 0) {
      push('req:messages', 'Messages', '<div class="json-block" style="opacity:0.5">Loading...</div>',
        { count: `${req._messageCount}${req._messagesChars ? ' ' + charGauge(req._messagesChars) : ''}`, lazyId: interaction.id });
    } else {
      push('req:messages', 'Messages', '', { empty: true });
    }

    if (req.tools?.length > 0) {
      const toolChars = req._toolsChars || _jsonChars(req.tools);
      push('req:tools', 'Tools', () => renderTools(req.tools, interaction.id),
        { count: `${req.tools.length} ${charGauge(toolChars)}` });
    } else if (req._toolCount > 0) {
      push('req:tools', 'Tools', '<div class="json-block" style="opacity:0.5">Loading...</div>',
        { count: `${req._toolCount}${req._toolsChars ? ' ' + charGauge(req._toolsChars) : ''}`, lazyId: interaction.id });
    } else {
      push('req:tools', 'Tools', '', { empty: true });
    }

    push('req:thinking', 'Thinking', req.thinking ? () => jsonBlock(req.thinking) : '', { empty: !req.thinking });

    const otherParams = _otherReqParams(req);
    const hasOther = Object.keys(otherParams).length > 0;
    push('req:other', 'Other', hasOther ? () => jsonBlock(otherParams) : '', { empty: !hasOther });

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
    // Kept as <details open> so the existing streaming code that unhides it
    // and appends to #raw-sse-pre keeps working unchanged. Built when opened:
    // it prints every event of the stream.
    push('resp:sse', 'Raw SSE', () => {
      const events = interaction.response?.sseEvents || [];
      const ssePre = events.map(e =>
        `<span class="json-key">event:</span> ${escHtml(e.eventType)}\n<span class="json-string">data:</span> ${escHtml(typeof e.data === 'string' ? e.data : JSON.stringify(e.data))}\n`
      ).join('\n');
      return `<details id="raw-sse-details" open>
        <summary>Raw SSE Events (<span id="raw-sse-count">${events.length}</span>)</summary>
        <pre class="json-block no-linkify" id="raw-sse-pre">${ssePre}</pre>
      </details>`;
    }, { count: sseCount ? String(sseCount) : '', countId: 'sse-chip-count', empty: !isLive && sseCount === 0 });

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
      subagent: sub ? `${sub.agentId}|${sub.agentType}|${sub.description}|${interaction._subagentInferred ? 1 : 0}` : '',
      model: req.model || '',
      promptImages: interaction.promptImages?.length || 0,
      secs: {
        'req:info': `${req.model}|${req.max_tokens}|${req.temperature}|${interaction.isStreaming}|${sub ? sub.agentId : ''}|${(interaction.rules || []).map(r => `${r.id}:${r.delta}`).join(',')}`,
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
    const open = !empty && _isSecOpen(key);

    const bodyEl = sec.querySelector('.vc-sec-body');
    if (bodyEl) {
      bodyEl.innerHTML = _bodyHtml(body, open) + (placeholder ? `<div class="vc-sec-placeholder">${escHtml(placeholder)}</div>` : '');
    }
    if (typeof body === 'function') sec.dataset.lazyBody = open ? '' : 'pending';
    else delete sec.dataset.lazyBody;

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

    sec.classList.toggle('is-open', open);
    chip.classList.toggle('is-open', open);

    _decorateSection(sec);
  }

  /* A section whose body is built on open (data-lazy-body): build it now
     from the turn on screen, or drop it again once it closes. */
  function _fillLazySection(root, sec) {
    if (sec.dataset.lazyBody !== 'pending') return;
    const interaction = _detailView?.kind === 'llm'
      ? state.interactions.find(i => i.id === _detailView.id) : null;
    if (!interaction) return;
    const key = sec.dataset.sec;
    const descs = key.startsWith('req:') ? _requestSections(interaction) : _responseSections(interaction);
    const desc = descs.find(d => d.key === key);
    if (desc) _applySection(root, desc);
  }

  function _releaseLazySection(sec) {
    if (sec.dataset.lazyBody === undefined || sec.dataset.lazyBody === 'pending') return;
    const bodyEl = sec.querySelector('.vc-sec-body');
    if (bodyEl) bodyEl.innerHTML = '';
    sec.dataset.lazyBody = 'pending';
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

    // Set before the frame binds: a section opened there builds its body from
    // the turn on screen.
    _detailView = {
      key: `turn:${interaction.id}`, kind: 'llm', id: interaction.id,
      root: detailContent.querySelector('.vc-detail'),
      sig: _detailSig(interaction), streamed: false,
    };

    const splitEl = detailContent.querySelector('.vc-split');
    _applySplitRatio(splitEl, _detailPrefs.ratio);
    _bindDetailFrame(detailContent, splitEl);

    autoExpandSmallJsonBlocks(detailContent);
    processMarkdownBlocks(detailContent);
    linkifyDetail(detailContent);
    _bindLazySections(detailContent);

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
        _fillLazySection(root, sec);
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
            _releaseLazySection(other);
            pane.querySelector(`.vc-chip[data-sec="${CSS.escape(otherKey)}"]`)?.classList.remove('is-open');
            const oi = _detailPrefs.open.indexOf(otherKey);
            if (oi >= 0) _detailPrefs.open.splice(oi, 1);
          }
          sec.classList.add('is-open');
          chip.classList.add('is-open');
          if (!_detailPrefs.open.includes(key)) _detailPrefs.open.push(key);
          _fillLazySection(root, sec);
          sec.dispatchEvent(new CustomEvent('vc-sec-open'));
        } else {
          sec.classList.remove('is-open');
          chip.classList.remove('is-open');
          const i = _detailPrefs.open.indexOf(key);
          if (i >= 0) _detailPrefs.open.splice(i, 1);
          _releaseLazySection(sec);
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
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      _saveDetailPrefs();
    };

    resizer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragging = true;
      resizer.classList.add('dragging');
      document.body.style.userSelect = 'none';
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
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

    const found = {};
    const result = findToolResult(tc.id, found);
    if (result?._truncated && found.owner?._summary && !_pendingDetailRequests.has(found.owner.id)) {
      // Shown cut until the full turn lands; the detail handler re-selects.
      _pendingDetailRequests.add(found.owner.id);
      sendWs({ type: 'interaction:getDetail', id: found.owner.id });
    }
    if (result) {
      html += `<div class="section-title">Result${result._truncated ? ' <span class="info-label">(loading the rest\u2026)</span>' : ''}</div>`;
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
  function sheet(contentLabel, rows, src) {
    const srcAttr = src ? ` data-sheet-src="${escHtml(src.id)}" data-sheet-kind="${src.kind}"` : '';
    return `<div class="vc-sheet"${srcAttr}>
      <div class="vc-sheet-head">
        <span class="vc-sheet-c vc-sheet-n">#</span>
        <span class="vc-sheet-c vc-sheet-size">chars</span>
        <span class="vc-sheet-c vc-sheet-body">${escHtml(contentLabel)}</span>
      </div>
      ${rows.join('')}
    </div>`;
  }

  function sheetRow(idx, chars, max, tag, tagCls, text, detailHtml) {
    return `<details class="vc-sheet-row" data-row="${idx}">
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

  /* Rows carry their first chars and size only; a row's JSON is built when it
     is opened (and dropped when it closes) from the turn's data — see
     _fillSheetRow. A long conversation shows its newest MESSAGE_ROWS rows
     until "show earlier" is clicked. */
  function renderMessages(messages, interactionId, { all = false } = {}) {
    const from = all ? 0 : Math.max(0, messages.length - RET.LIMITS.MESSAGE_ROWS);
    const rows = messages.slice(from).map((msg, k) => {
      const idx = from + k;
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
      return sheetRow(idx, _jsonChars(msg), MSG_GAUGE_MAX,
        role, `is-${role.replace(/[^a-z]/gi, '').toLowerCase()}`,
        truncate(preview, 200), '');
    });
    if (from > 0) {
      rows.unshift(`<button class="vc-sheet-more" data-sheet-more style="display:block;width:100%;padding:4px 8px;font-size:11px;cursor:pointer;background:none;color:var(--text-dim);border:none;border-bottom:1px solid var(--border)">Show ${from} earlier message${from === 1 ? '' : 's'}</button>`);
    }
    return sheet('role / content', rows, { id: interactionId, kind: 'messages' });
  }

  function renderTools(tools, interactionId) {
    const rows = tools.map((tool, idx) => sheetRow(
      idx, _jsonChars(tool), TOOL_GAUGE_MAX,
      tool.name || 'unnamed', 'is-tool',
      truncate(tool.description || '', 200), ''));
    return sheet('name / description', rows, { id: interactionId, kind: 'tools' });
  }

  // An opened sheet row's JSON, from the turn it belongs to. A turn trimmed
  // meanwhile is fetched again; its section rebuilds when the detail lands.
  function _fillSheetRow(row) {
    const sheetEl = row.closest('.vc-sheet');
    const detail = row.querySelector('.vc-sheet-detail');
    if (!sheetEl?.dataset.sheetSrc || !detail) return;
    const id = sheetEl.dataset.sheetSrc;
    const interaction = state.interactions.find(i => i.id === id);
    const item = interaction?.request?.[sheetEl.dataset.sheetKind]?.[Number(row.dataset.row)];
    if (item === undefined) {
      detail.innerHTML = '<div class="json-block" style="opacity:0.5">Loading...</div>';
      delete row.dataset.seeded;
      if (interaction && !_pendingDetailRequests.has(id)) {
        _pendingDetailRequests.add(id);
        sendWs({ type: 'interaction:getDetail', id });
      }
      return;
    }
    detail.innerHTML = jsonBlock(item);
    autoExpandSmallJsonBlocks(detail);
    linkifyDetail(detail);
  }

  document.addEventListener('click', (e) => {
    const more = e.target.closest('[data-sheet-more]');
    if (!more) return;
    const sheetEl = more.closest('.vc-sheet');
    const id = sheetEl?.dataset.sheetSrc;
    const msgs = state.interactions.find(i => i.id === id)?.request?.messages;
    if (msgs) sheetEl.outerHTML = renderMessages(msgs, id, { all: true });
  });

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

  /* A CLI tab's footer and \u03a3 figures cover every turn of its session, not
     just the ones held here \u2014 the server keeps only its newest few hundred
     in memory, and a long-running tab has far more on disk. The server adds
     them up (src/session-totals.js) and pushes updates as turns land. */
  function _activeSessionTotals() {
    const id = activeInstanceTab;
    if (typeof id !== 'string' || !id.startsWith('cli-')) return null;
    // Not connected yet: the `init` that follows connecting clears the set.
    if (!_sessionTotalsAsked.has(id)) {
      _sessionTotalsAsked.add(id);
      try { sendWs({ type: 'inspector:getSessionTotals', instanceId: id }); } catch {}
    }
    return _sessionTotals.get(id) || null;
  }

  function _formatLongDuration(ms) {
    if (ms < 60000) return formatDuration(ms);
    const m = Math.round(ms / 60000);
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  /* A turn is a prompt the user sent, not a timeline entry: one prompt fans
     out into many model calls (every agentic step and subagent is its own)
     and many hook events. CLI tabs report each prompt as a UserPromptSubmit
     hook; an instance without hooks (an external client on the proxy) falls
     back to main-thread requests that end in the user's text. */
  function _countTurns(list) {
    const prompts = new Map(), starts = new Map();
    let apiCalls = 0, hookEvents = 0;
    for (const i of list) {
      const key = i.instanceId || '';
      if (i.isHook) {
        if (i.hookEvent === 'UserPromptSubmit') prompts.set(key, (prompts.get(key) || 0) + 1);
        else hookEvents++;
        continue;
      }
      if (i.isMcp) continue;
      apiCalls++;
      if (!i.subagent && isNewUserTurn(i)) starts.set(key, (starts.get(key) || 0) + 1);
    }
    let turns = 0;
    for (const n of prompts.values()) turns += n;
    for (const [key, n] of starts) if (!prompts.has(key)) turns += n;
    return { turns, apiCalls, hookEvents };
  }

  function updateStats() {
    const source = state.interactions.filter(isVisibleInTimeline);
    let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheCreate = 0, toolCallCount = 0, totalCost = 0;
    let hasCost = false;
    _statsTab = activeInstanceTab;
    const sess = _activeSessionTotals();
    // Without the server's figures, the turns held here add up to the
    // session's only when they are all of them (no older page, not loading);
    // else the footer waits rather than show a capped sum.
    const tab = _openTabs.get(activeInstanceTab);
    const waiting = !sess && !!tab && (tab.loading || tab.hasMore);
    const counts = sess || (waiting ? { turns: 0, apiCalls: 0, hookEvents: 0 } : _countTurns(source));
    if (sess) {
      ({ toolCalls: toolCallCount, inputTokens, outputTokens, cacheRead, cacheCreate, hasCost } = sess);
      totalCost = sess.cost;
    } else if (!waiting) {
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
    }
    // While the server is still reading the session's files the figures only grow.
    const approx = sess && !sess.complete ? '\u2248 ' : '';
    const scanNote = sess && !sess.complete
      ? `Whole session, still counting: ${sess.scanned.toLocaleString()} of ${sess.toScan.toLocaleString()} turn files read`
      : sess ? 'Whole session, every turn on disk'
      : waiting ? 'Waiting for the whole session\'s totals' : '';

    // Footer stats section. A session that never reported a prompt (no
    // hooks reached the server) can only be counted in model calls.
    const byCalls = counts.turns === 0 && counts.apiCalls > 0;
    const n = byCalls ? counts.apiCalls : counts.turns;
    const unit = byCalls ? 'API call' : 'turn';
    statsEl.textContent = waiting ? '\u2026 turns'
      : `${approx}${n.toLocaleString()} ${unit}${n !== 1 ? 's' : ''} \u00b7 ${toolCallCount.toLocaleString()} tool call${toolCallCount !== 1 ? 's' : ''}`;
    statsEl.title = waiting ? scanNote : [
      scanNote,
      `${counts.turns.toLocaleString()} prompt${counts.turns !== 1 ? 's' : ''} sent`,
      `${counts.apiCalls.toLocaleString()} API call${counts.apiCalls !== 1 ? 's' : ''}`,
      `${counts.hookEvents.toLocaleString()} hook event${counts.hookEvents !== 1 ? 's' : ''}`,
    ].filter(Boolean).join('\n');

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
      costEl.title = scanNote;
    }

    // Timeline footer — total busy time and cost of visible turns
    const tlTimeEl = document.getElementById('timeline-total-time');
    const tlCostEl = document.getElementById('timeline-total-cost');
    let visibleCost = 0, visibleTime = 0;
    let hasVisibleCost = false, hasVisibleTime = false;
    if (sess) {
      // A CLI tab shows its whole session here too.
      visibleCost = sess.cost; hasVisibleCost = sess.hasCost;
      visibleTime = sess.duration; hasVisibleTime = sess.duration > 0;
    } else if (!waiting) {
      for (const i of source) {
        if (!isVisibleInTimeline(i)) continue;
        const c = computeCost(i.usage, i.pricing);
        if (c != null) { visibleCost += c; hasVisibleCost = true; }
        if (i.timing?.duration) { visibleTime += i.timing.duration; hasVisibleTime = true; }
      }
    }
    if (tlTimeEl) {
      tlTimeEl.textContent = hasVisibleTime ? `${approx}\u03A3 ${sess ? _formatLongDuration(visibleTime) : formatDuration(visibleTime)}` : '';
      tlTimeEl.title = sess
        ? `${scanNote}. API and hook time added up; parallel subagents overlap.`
          + (sess.firstAt ? ` First turn ${new Date(sess.firstAt).toLocaleString()}, last ${new Date(sess.lastAt).toLocaleString()}.` : '')
        : '';
    }
    if (tlCostEl) {
      tlCostEl.textContent = hasVisibleCost ? `${approx}\u03A3 ${formatCost(visibleCost)}` : '';
      tlCostEl.title = scanNote;
    }
  }

  function isVisibleInTimeline(interaction) {
    return interaction.instanceId === activeInstanceTab;
  }

  function renderEmptyState() {
    if (!emptyState) return;
    if (state.interactions.some(isVisibleInTimeline)) return;
    emptyState.innerHTML = _openTabs.get(activeInstanceTab)?.loading
      ? '<p>Loading session\u2026</p>'
      : '<p>No interactions in this session yet.</p>';
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
      case 'init': {
        // The toggle used to live in this browser only; it is the server's now.
        const legacyAutoClear = localStorage.getItem('inspectorAutoClear');
        if (legacyAutoClear !== null) {
          localStorage.removeItem('inspectorAutoClear');
          if (legacyAutoClear === '1' && !msg.autoClear) sendWs({ type: 'inspector:setAutoClear', value: true });
        }
        // A new connection may be a restarted server; ask again.
        _sessionTotals.clear();
        _sessionTotalsAsked.clear();
        // A reconnect keeps the open tabs: subscribe again for a fresh snapshot.
        for (const [id, tab] of _openTabs) {
          tab.loading = true;
          sendWs({ type: 'inspector:subscribe', instanceId: id });
        }
        initTimelineToggle();
        _applySessions(msg);
        switchInstanceTab(activeInstanceTab);
        break;
      }

      case 'inspector:sessions':
        _applySessions(msg);
        break;

      case 'inspector:sessionsRemoved':
        // Pruned, cleared or autocleared on the server: gone everywhere.
        for (const id of msg.instanceIds || []) {
          _sessions.delete(id);
          closeSessionTab(id);
        }
        renderInspectorTabStrip();
        renderSessionsGrid();
        break;

      case 'inspector:snapshot': {
        const id = msg.instanceId;
        const tab = _openTabs.get(id);
        if (!tab) break;            // closed before it arrived
        // The server subscribed this page before building the snapshot, so it
        // holds every turn up to now and every live event follows it; it
        // replaces whatever an earlier subscription left here.
        _dropInstance(id);
        state.interactions.push(...(msg.interactions || []).map(_adoptIncoming));
        state.interactions.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        tab.loading = false;
        tab.hasMore = !!msg.hasMore;
        tab.loadingEarlier = false;
        tab.extraCap = 0;
        if (activeInstanceTab === id) switchInstanceTab(id);
        else renderInspectorTabStrip();
        break;
      }

      case 'interaction:start':
        // Only sessions open here are sent; anything else is left over from a
        // tab closed a moment ago.
        if (!_openTabs.has(msg.interaction.instanceId)) break;
        if (state.interactions.some(i => i.id === msg.interaction.id)) {
          updateInteraction(msg.interaction);
          break;
        }
        // Insert in timestamp order — hooks and subagent turns arrive via
        // independent paths and may reach the client out of logical order.
        const _ts = msg.interaction.timestamp || 0;
        let _lo = 0, _hi = state.interactions.length;
        while (_lo < _hi) {
          const mid = (_lo + _hi) >>> 1;
          if ((state.interactions[mid].timestamp || 0) <= _ts) _lo = mid + 1;
          else _hi = mid;
        }
        state.interactions.splice(_lo, 0, _adoptIncoming(msg.interaction));
        if (!msg.interaction._summary) _touchFull(msg.interaction.id);
        const matchesFilter = msg.interaction.instanceId === activeInstanceTab;
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
          // Past the per-session cap the oldest turns leave the page (and the
          // timeline is rebuilt without them); "Load earlier" brings them back.
          if (_trimTimeline(msg.interaction.instanceId)) renderTimelineActive();
          // A turn opened from live mode stays put; otherwise live follows the
          // newest (and the lanes show it).
          if (_liveMode && !_lanesPinned && !_wouldInterruptStream(msg.interaction)) {
            select({ type: 'turn', id: msg.interaction.id });
            scrollTimelineToBottom();
          } else if (_liveMode) {
            scrollTimelineToBottom();
          }
          // Hooks name the agent an Agent call ran, and when it stopped.
          if (_lanesView) _lanesQueueSync();
        }
        else _trimTimeline(msg.interaction.instanceId);
        updateStats();
        break;

      case 'interaction:update':
        if (!_openTabs.has(msg.interaction.instanceId)) break;
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
        if (!_openTabs.has(msg.interaction.instanceId)) break;
        _sseIndex.delete(msg.interaction.id);
        updateInteraction(msg.interaction);
        _scheduleCompaction();
        break;

      case 'interaction:error':
        markInteractionError(msg.interactionId, msg.error);
        break;

      case 'interaction:detail': {
        _pendingDetailRequests.delete(msg.id);
        const dIdx = state.interactions.findIndex(i => i.id === msg.id);
        if (dIdx >= 0 && msg.interaction) {
          state.interactions[dIdx] = RET.mergeDetail(state.interactions[dIdx], msg.interaction);
          _touchFull(msg.id);
          _resultModalDetail(state.interactions[dIdx]);
          if (_curlPending === msg.id) {
            _curlPending = null;
            showCurlModal(buildCurlCommand(state.interactions[dIdx]));
          }
          // A tool's result lives in the turn after the one that called it.
          if (state.selection?.id === msg.id || state.selection?.interactionId === msg.id
              || state.selection?.type === 'tool') {
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

      case 'inspector:earlier': {
        const tab = _openTabs.get(msg.instanceId);
        if (!tab) break;
        tab.loadingEarlier = false;
        tab.hasMore = !!msg.hasMore;
        const have = new Set(state.interactions.map(i => i.id));
        const older = (msg.interactions || []).filter(i => !have.has(i.id)).map(_adoptIncoming);
        tab.extraCap = (tab.extraCap || 0) + older.length;
        state.interactions.unshift(...older);
        state.interactions.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        if (activeInstanceTab === msg.instanceId) {
          renderTimelineActive();
          // The reader asked for what is above: show it, not the live end.
          timelineList.scrollTop = 0;
          updateStats();
          _lanesOnEarlier();
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

      case 'inspector:sessionTotals': {
        if (!msg.instanceId) break;
        if (msg.totals) _sessionTotals.set(msg.instanceId, msg.totals);
        else _sessionTotals.delete(msg.instanceId);
        if (activeInstanceTab === msg.instanceId) updateStats();
        break;
      }

      case 'interaction:enriched': {
        const interaction = state.interactions.find(i => i.id === msg.interactionId);
        if (interaction && msg.promptImages) {
          interaction.promptImages = msg.promptImages;
          if (state.selection?.type === 'turn' && state.selection.id === msg.interactionId) {
            select({ type: 'turn', id: msg.interactionId });
          }
        } else if (interaction) {
          interaction.subagent = msg.subagent;
          delete interaction._subagentInferred;
          if (_timelineMode === 'parallel') {
            queueTimelineParallelRebuild();
          } else {
            updateTurnSubagentBadge(interaction);
          }
          _lanesQueueSync();
          if (state.selection?.type === 'turn' && state.selection.id === msg.interactionId) {
            select({ type: 'turn', id: msg.interactionId });
          }
        }
        break;
      }
    }
  }

  // Timeline Clear and the footer reset drop the focused session's finished
  // turns from this page only; the session itself stays (Sessions tab Clear
  // removes sessions).
  function clearVisibleTurns() {
    const toRemove = new Set();
    for (const i of state.interactions) {
      if (isVisibleInTimeline(i) && i.status !== 'streaming' && i.status !== 'pending') {
        toRemove.add(i.id);
      }
    }
    if (toRemove.size === 0) return;
    state.interactions = state.interactions.filter(i => !toRemove.has(i.id));
    if (state.selection && toRemove.has(state.selection.type === 'tool' ? state.selection.interactionId : state.selection.id)) {
      state.selection = null;
      detailContent.classList.add('hidden');
      emptyState.classList.remove('hidden');
    }
    renderTimelineActive();
    updateStats();
  }
  document.getElementById('footerReset')?.addEventListener('click', clearVisibleTurns);
  document.getElementById('timeline-clear-btn')?.addEventListener('click', clearVisibleTurns);

  window.inspectorModule = { handleMessage, instanceDisplayLabel, renderInspectorTabStrip, switchInstanceTab, openSession: openSessionTab, toggleFocusMode, isFocusMode: () => _focusMode };
})();
