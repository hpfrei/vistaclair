// === MCP Tool Manager — inline collapsible items with Monaco editors ===
(function() {
  'use strict';
  const { state, sendWs, escHtml, showAlert } = window.dashboard;

  // --- State ---
  const mcp = {
    tools: [],
    claudeTools: [],
    status: 'stopped',
    needsRestart: false,
    meta: null,
    expandedSlug: null,
    expandedClaudeTool: null,
    liveTools: [],
    testResult: null,
    testHistory: [],
  };

  // --- Monaco infrastructure ---
  let monacoReady = false;
  let monacoReadyPromise = null;
  let currentEditor = null;
  let currentEditorSlug = null;
  let isEditorDirty = false;

  function getMonacoTheme() {
    return 'vs';
  }

  // Phones never load Monaco; createEditor mounts a plain textarea instead.
  const editorReady = () => monacoReady || window.dashboard.wantsPlainEditor();

  function ensureMonaco() {
    if (monacoReady || window.dashboard.wantsPlainEditor()) return Promise.resolve();
    if (monacoReadyPromise) return monacoReadyPromise;
    monacoReadyPromise = new Promise((resolve) => {
      if (typeof window.require === 'undefined' || !window.require.config) {
        console.warn('Monaco loader not available');
        resolve();
        return;
      }
      window.require.config({
        paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' }
      });
      window.require(['vs/editor/editor.main'], function() {
        monacoReady = true;
        resolve();
      });
    });
    return monacoReadyPromise;
  }

  function updateEditorHeight() {
    if (!currentEditor) return;
    const container = currentEditor.getDomNode()?.parentElement;
    if (!container) return;
    const lineCount = currentEditor.getModel().getLineCount();
    const lineHeight = currentEditor.getOption(monaco.editor.EditorOption.lineHeight);
    const height = Math.min(500, Math.max(120, lineCount * lineHeight + 20));
    container.style.height = height + 'px';
    currentEditor.layout();
  }

  function createEditor(container, source, slug, readOnly) {
    disposeEditor();
    currentEditorSlug = slug;
    isEditorDirty = false;

    if (window.dashboard.wantsPlainEditor()) {
      currentEditor = window.dashboard.createPlainEditor(container, source, readOnly);
      if (!readOnly) {
        currentEditor.onDidChangeModelContent(() => {
          isEditorDirty = true;
          const saveBtn = document.querySelector(`.rule-save-btn[data-slug="${slug}"]`);
          if (saveBtn) saveBtn.disabled = false;
        });
      }
      return;
    }

    currentEditor = monaco.editor.create(container, {
      value: source,
      language: 'javascript',
      theme: getMonacoTheme(),
      readOnly: !!readOnly,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbers: 'on',
      fontSize: 12,
      fontFamily: '"Cascadia Code", Menlo, Monaco, "Courier New", monospace',
      automaticLayout: true,
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
      overviewRulerLanes: 0,
      renderLineHighlight: 'none',
      folding: true,
      wordWrap: 'on',
    });

    if (!readOnly) {
      currentEditor.onDidChangeModelContent(() => {
        isEditorDirty = true;
        const saveBtn = document.querySelector(`.rule-save-btn[data-slug="${slug}"]`);
        if (saveBtn) saveBtn.disabled = false;
      });
    }

    updateEditorHeight();
    currentEditor.onDidChangeModelContent(updateEditorHeight);
  }

  function disposeEditor() {
    if (currentEditor) {
      currentEditor.dispose();
      currentEditor = null;
      currentEditorSlug = null;
      isEditorDirty = false;
    }
  }

  // --- WS Message Dispatch ---
  function handleMessage(msg) {
    switch (msg.type) {
      case 'mcp:tool:list':
        mcp.tools = msg.tools || [];
        renderPanel();
        break;
      case 'mcp:claude-tools':
        mcp.claudeTools = msg.tools || [];
        renderPanel();
        break;
      case 'mcp:tool:saved': {
        const saved = msg.tool;
        if (saved?.slug && !mcp.expandedSlug) {
          mcp.expandedSlug = saved.slug;
        }
        break;
      }
      case 'mcp:status':
        mcp.status = msg.status || 'stopped';
        mcp.needsRestart = !!msg.needsRestart;
        renderStatusBar();
        break;
      case 'mcp:meta':
        mcp.meta = msg.meta;
        break;
      case 'mcp:tools':
        mcp.liveTools = msg.tools || [];
        if (mcp.expandedSlug) renderTestSection(mcp.expandedSlug);
        break;
      case 'mcp:test:result':
        mcp.testResult = msg;
        mcp.testHistory.unshift({
          timestamp: new Date().toISOString(),
          tool: msg.tool,
          status: msg.error ? 'error' : 'success',
          latencyMs: msg.latencyMs,
          result: msg.result,
          error: msg.error,
        });
        if (mcp.expandedSlug) renderTestResult();
        break;
      case 'mcp:tool:source': {
        if (msg.slug !== mcp.expandedSlug) break;
        const container = document.querySelector(`.rule-editor-container[data-slug="${msg.slug}"]`);
        if (!container || !editorReady()) break;
        container.innerHTML = '';
        createEditor(container, msg.source, msg.slug, false);
        break;
      }
      case 'mcp:tool:source-saved':
        isEditorDirty = false;
        break;
      case 'mcp:tool:restored':
        isEditorDirty = false;
        showAlert('Tool restored to original');
        break;
      case 'mcp:tool:generating': {
        const btn = document.querySelector(`.rule-edit-submit[data-slug="${msg.slug}"]`);
        if (btn) { btn.textContent = 'Generating…'; btn.disabled = true; }
        break;
      }
      case 'mcp:error':
        showAlert(msg.error);
        // Reset AI button if it was generating
        const aiBtn = document.querySelector('.rule-edit-submit[disabled]');
        if (aiBtn && aiBtn.textContent === 'Generating…') {
          aiBtn.textContent = 'Apply with AI';
          aiBtn.disabled = false;
        }
        break;
    }
  }

  // ========== PANEL RENDERING ==========

  function renderPanel() {
    const panel = document.getElementById('ref-mcp');
    if (!panel) return;

    const countEl = document.getElementById('capMcpCount');
    if (countEl) {
      const enabled = mcp.tools.filter(t => t.enabled).length;
      const builtin = mcp.claudeTools.length;
      countEl.textContent = builtin > 0 ? `${builtin}+${enabled}` : String(enabled);
    }

    const running = mcp.status === 'running';
    const statusClass = running ? 'running' : 'stopped';
    const statusLabel = mcp.status.charAt(0).toUpperCase() + mcp.status.slice(1);

    let html = `<div class="ref-intro">
      <strong>Tools</strong> are actions Claude can request during the agentic loop.
      <em>Built-in tools</em> ship with the Claude CLI itself (catalog read live from <code>claude mcp serve</code>);
      <em>custom tools</em> are served by the integrated <code>vistaclair-tools</code> MCP server &mdash;
      add tools below and Claude can call them like built-in ones.
    </div>`;

    // Server status bar
    html += `<div class="mcp-status-bar" id="mcpStatusBar">
      <span class="mcp-status ${statusClass}"></span>
      <span>${statusLabel}</span>
      ${mcp.needsRestart ? '<span class="mcp-restart-badge">restart needed</span>' : ''}
      <div style="margin-left:auto;display:flex;gap:4px">
        <button class="cap-new-btn" id="mcpRestart" title="Restart MCP server">${mcp.needsRestart ? '↻ Restart Now' : '↻ Restart'}</button>
      </div>
    </div>`;

    // Tool list header
    html += `<div class="cap-section-header">
      <span>Custom Tools</span>
      <button class="cap-new-btn" id="mcpNewTool">+ New Tool</button>
    </div>`;

    // Tool list
    if (mcp.tools.length === 0) {
      html += '<div class="mcp-empty">No tools yet. Click <strong>+ New Tool</strong> to create one.</div>';
    } else {
      html += '<div id="mcpToolList">';
      for (const t of mcp.tools) {
        const bi = t.builtin;
        const isExpanded = mcp.expandedSlug === t.slug;
        html += renderToolItem(t, bi, isExpanded);
      }
      html += '</div>';
    }

    // Claude built-in tools (read-only, live catalog from `claude mcp serve`)
    html += `<div class="cap-section-header" style="margin-top:16px">
      <span>Claude Built-in Tools</span>
    </div>`;
    if (mcp.claudeTools.length === 0) {
      html += '<div class="mcp-empty">Loading catalog from <code>claude mcp serve</code>&hellip;</div>';
    } else {
      html += '<div id="mcpClaudeToolList">';
      for (const t of mcp.claudeTools) {
        html += renderClaudeToolItem(t, mcp.expandedClaudeTool === t.name);
      }
      html += '</div>';
    }

    panel.innerHTML = html;
    attachPanelEvents(panel);

    if (mcp.expandedSlug) {
      ensureMonaco().then(() => {
        if (mcp.expandedSlug && editorReady()) {
          sendWs({ type: 'mcp:tool:source', slug: mcp.expandedSlug });
        }
      });
      const tool = mcp.tools.find(t => t.slug === mcp.expandedSlug);
      if (tool && mcp.status === 'running') {
        sendWs({ type: 'mcp:tools' });
      }
    }
  }

  function renderToolItem(t, bi, isExpanded) {
    const paramSummary = (t.params || []).map(p =>
      `<span class="mcp-param-chip">${escHtml(p.name)}<span class="mcp-param-type">${escHtml(p.type || 'string')}</span>${p.required ? '' : '?'}</span>`
    ).join(' ');

    return `<div class="mcp-tool-item${isExpanded ? ' expanded' : ''}${t.enabled ? '' : ' disabled'}" data-slug="${escHtml(t.slug)}">
      <div class="mcp-tool-item-header">
        <label class="rule-toggle" title="${t.enabled ? 'Enabled' : 'Disabled'}">
          <input type="checkbox" ${t.enabled ? 'checked' : ''} data-slug="${escHtml(t.slug)}" class="mcp-toggle-cb">
          <span class="rule-toggle-slider"></span>
        </label>
        <div class="mcp-tool-item-info">
          <span class="mcp-tool-item-name">${escHtml(t.name)}</span>
          ${bi ? '<span class="ref-tag tag-ro" style="font-size:9px">built-in</span>' : ''}
        </div>
        <span class="cap-item-desc">${escHtml(t.description || '')}</span>
        ${bi ? '' : `<button class="rule-del-btn mcp-del-btn" data-slug="${escHtml(t.slug)}" title="Delete tool">&#10005;</button>`}
      </div>
      <div class="mcp-tool-item-detail" style="display:${isExpanded ? 'block' : 'none'}">
        ${paramSummary ? `<div class="mcp-detail-params">${paramSummary}</div>` : ''}
        <div class="rule-source-section">
          <div class="rule-source-toolbar">
            <span class="rule-source-label">Source</span>
            ${bi ? `<button class="rule-restore-btn" data-slug="${escHtml(t.slug)}" title="Restore original">Restore</button>` : ''}
            <button class="rule-save-btn" data-slug="${escHtml(t.slug)}" disabled>Save</button>
          </div>
          <div class="rule-editor-container" data-slug="${escHtml(t.slug)}">
            <div class="rule-editor-loading">Loading editor&hellip;</div>
          </div>
        </div>
        <div class="rule-edit-row">
          <textarea class="rule-edit-input" data-slug="${escHtml(t.slug)}" rows="3" placeholder="Describe a change to this tool&hellip;"></textarea>
          <button class="rule-edit-submit" data-slug="${escHtml(t.slug)}">Apply with AI</button>
        </div>
        <div class="mcp-test-section" id="mcpTest-${escHtml(t.slug)}"></div>
      </div>
    </div>`;
  }

  function renderClaudeToolItem(t, isExpanded) {
    const props = t.inputSchema?.properties || {};
    const required = new Set(t.inputSchema?.required || []);
    const paramSummary = Object.entries(props).map(([name, p]) =>
      `<span class="mcp-param-chip">${escHtml(name)}<span class="mcp-param-type">${escHtml(p.type || 'string')}</span>${required.has(name) ? '' : '?'}</span>`
    ).join(' ');

    const desc = t.description || '';
    const brief = desc.split('\n')[0].slice(0, 140);

    return `<div class="mcp-tool-item${isExpanded ? ' expanded' : ''}" data-claude-tool="${escHtml(t.name)}">
      <div class="mcp-tool-item-header">
        <div class="mcp-tool-item-info">
          <span class="mcp-tool-item-name">${escHtml(t.name)}</span>
        </div>
        <span class="cap-item-desc">${escHtml(brief)}</span>
      </div>
      <div class="mcp-tool-item-detail" style="display:${isExpanded ? 'block' : 'none'}">
        ${paramSummary ? `<div class="mcp-detail-params">${paramSummary}</div>` : ''}
        <pre class="mcp-claude-tool-desc">${escHtml(desc)}</pre>
      </div>
    </div>`;
  }

  function renderStatusBar() {
    const bar = document.getElementById('mcpStatusBar');
    if (!bar) return;
    const running = mcp.status === 'running';
    const statusClass = running ? 'running' : 'stopped';
    const statusLabel = mcp.status.charAt(0).toUpperCase() + mcp.status.slice(1);
    bar.innerHTML = `
      <span class="mcp-status ${statusClass}"></span>
      <span>${statusLabel}</span>
      ${mcp.needsRestart ? '<span class="mcp-restart-badge">restart needed</span>' : ''}
      <div style="margin-left:auto;display:flex;gap:4px">
        <button class="cap-new-btn" id="mcpRestart" title="Restart MCP server">${mcp.needsRestart ? '↻ Restart Now' : '↻ Restart'}</button>
      </div>`;
    bar.querySelector('#mcpRestart')?.addEventListener('click', () => sendWs({ type: 'mcp:restart' }));
  }

  // ========== EVENT DELEGATION ==========

  function attachPanelEvents(panel) {
    panel.querySelector('#mcpNewTool')?.addEventListener('click', createNewTool);
    panel.querySelector('#mcpRestart')?.addEventListener('click', () => sendWs({ type: 'mcp:restart' }));

    panel.querySelector('#mcpClaudeToolList')?.addEventListener('click', (e) => {
      if (e.target.closest('.mcp-tool-item-detail')) return;
      const item = e.target.closest('.mcp-tool-item');
      if (!item) return;
      const name = item.dataset.claudeTool;
      mcp.expandedClaudeTool = mcp.expandedClaudeTool === name ? null : name;
      renderPanel();
    });

    const list = panel.querySelector('#mcpToolList');
    if (!list) return;

    list.addEventListener('click', (e) => {
      // Toggle switch
      const toggle = e.target.closest('.mcp-toggle-cb');
      if (toggle) {
        e.stopPropagation();
        sendWs({ type: 'mcp:tool:toggle', slug: toggle.dataset.slug, enabled: toggle.checked });
        return;
      }
      if (e.target.closest('.rule-toggle')) return;

      // Delete button
      const delBtn = e.target.closest('.mcp-del-btn');
      if (delBtn) {
        e.stopPropagation();
        if (confirm(`Delete tool "${delBtn.dataset.slug}"? This cannot be undone.`)) {
          sendWs({ type: 'mcp:tool:delete', slug: delBtn.dataset.slug });
          if (mcp.expandedSlug === delBtn.dataset.slug) {
            mcp.expandedSlug = null;
            disposeEditor();
          }
        }
        return;
      }

      // Restore builtin
      const restoreBtn = e.target.closest('.rule-restore-btn');
      if (restoreBtn) {
        e.stopPropagation();
        if (confirm('Restore this tool to its original built-in version?')) {
          sendWs({ type: 'mcp:tool:restore', slug: restoreBtn.dataset.slug });
        }
        return;
      }

      // Save button
      const saveBtn = e.target.closest('.rule-save-btn');
      if (saveBtn) {
        e.stopPropagation();
        if (!currentEditor || !isEditorDirty) return;
        sendWs({ type: 'mcp:tool:save-source', slug: saveBtn.dataset.slug, source: currentEditor.getValue() });
        saveBtn.disabled = true;
        return;
      }

      // AI edit submit
      const submitBtn = e.target.closest('.rule-edit-submit');
      if (submitBtn) {
        e.stopPropagation();
        const input = submitBtn.parentElement.querySelector('.rule-edit-input');
        const desc = input?.value?.trim();
        if (!desc) return;
        sendWs({ type: 'mcp:tool:ai-edit', slug: submitBtn.dataset.slug, description: desc });
        input.value = '';
        return;
      }

      // Test execute
      const testBtn = e.target.closest('.mcp-test-exec');
      if (testBtn) {
        e.stopPropagation();
        executeTest(testBtn.dataset.slug);
        return;
      }

      // Don't toggle expansion when clicking inside detail area
      if (e.target.closest('.mcp-tool-item-detail')) return;

      // Click header -> expand/collapse
      const item = e.target.closest('.mcp-tool-item');
      if (item) {
        const slug = item.dataset.slug;
        const newSlug = mcp.expandedSlug === slug ? null : slug;
        if (mcp.expandedSlug !== newSlug) disposeEditor();
        mcp.expandedSlug = newSlug;
        renderPanel();
      }
    });

    // Ctrl+Enter in AI edit input
    list.addEventListener('keydown', (e) => {
      if (!(e.key === 'Enter' && (e.ctrlKey || e.metaKey))) return;
      const input = e.target.closest('.rule-edit-input');
      if (!input) return;
      const desc = input.value.trim();
      if (!desc) return;
      sendWs({ type: 'mcp:tool:ai-edit', slug: input.dataset.slug, description: desc });
      input.value = '';
    });
  }

  // ========== NEW TOOL ==========

  function createNewTool() {
    const name = prompt('Tool name (e.g. my-tool):');
    if (!name?.trim()) return;
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
    if (slug.length < 2) { showAlert('Name too short.'); return; }
    const tool = {
      slug,
      name: name.trim(),
      description: '',
      enabled: true,
      params: [{ name: 'input', type: 'string', description: '', required: true }],
      handlerBody: 'return {\n    content: [{ type: "text", text: "Result" }],\n  };',
    };
    mcp.expandedSlug = slug;
    sendWs({ type: 'mcp:tool:save', tool });
  }

  // ========== TEST SECTION ==========

  function renderTestSection(slug) {
    const el = document.getElementById('mcpTest-' + slug);
    if (!el) return;

    const tool = mcp.tools.find(t => t.slug === slug);
    const running = mcp.status === 'running';
    const liveTool = mcp.liveTools.find(t => t.name === tool?.name);

    if (!running) {
      el.innerHTML = '<h4>Test</h4><div class="mcp-form-hint" style="color:var(--yellow)">Start the server to test this tool.</div>';
      return;
    }

    if (!liveTool) {
      el.innerHTML = '<h4>Test</h4><div class="mcp-form-hint" style="color:var(--yellow)">Tool not found in running server. Save and restart to pick up changes.</div>';
      return;
    }

    const schema = liveTool.inputSchema?.properties || {};
    const required = liveTool.inputSchema?.required || [];
    let paramInputs = '';
    for (const [name, prop] of Object.entries(schema)) {
      const type = prop.type || 'string';
      const req = required.includes(name);
      paramInputs += `<div class="mcp-test-param">
        <label>${escHtml(name)}${req ? ' *' : ''}: `;
      if (type === 'boolean') {
        paramInputs += `<input type="checkbox" data-param="${name}" data-type="boolean">`;
      } else if (type === 'number') {
        paramInputs += `<input type="number" data-param="${name}" data-type="number" placeholder="0">`;
      } else {
        paramInputs += `<input type="text" data-param="${name}" data-type="${type}" placeholder="${escHtml(prop.description || '')}">`;
      }
      paramInputs += '</label></div>';
    }

    el.innerHTML = `<h4>Test</h4>
      <div class="mcp-test-inline">
        ${paramInputs}
        <button class="mcp-action-btn primary mcp-test-exec" data-slug="${escHtml(slug)}">&#9654; Execute</button>
      </div>
      <div id="mcpTestResult"></div>`;

    if (mcp.testResult) renderTestResult();
  }

  function executeTest(slug) {
    const tool = mcp.tools.find(t => t.slug === slug);
    if (!tool) return;
    const section = document.getElementById('mcpTest-' + slug);
    if (!section) return;
    const params = {};
    section.querySelectorAll('[data-param]').forEach(el => {
      const name = el.dataset.param;
      const type = el.dataset.type;
      if (type === 'boolean') params[name] = el.checked;
      else if (type === 'number') params[name] = parseFloat(el.value) || 0;
      else if (type === 'object' || type === 'array') { try { params[name] = JSON.parse(el.value); } catch { params[name] = el.value; } }
      else params[name] = el.value;
    });
    sendWs({ type: 'mcp:test', tool: tool.name, params });
  }

  function renderTestResult() {
    const el = document.getElementById('mcpTestResult');
    if (!el || !mcp.testResult) return;
    const r = mcp.testResult;
    const ok = !r.error;
    let body = '';
    if (ok && r.result) {
      const content = r.result.content || [];
      body = content.map(c => c.text || JSON.stringify(c)).join('\n');
    } else if (r.error) {
      body = r.error;
    }
    el.innerHTML = `<div class="mcp-test-result">
      <span class="${ok ? 'mcp-res-ok' : 'mcp-res-err'}">${ok ? '✓' : '✕'}</span>
      <span class="mcp-res-ms">${r.latencyMs || 0}ms</span>
      <pre class="mcp-test-output">${escHtml(body)}</pre>
    </div>`;
  }

  // ========== EXPOSE MODULE ==========
  window.mcpModule = { handleMessage };
})();
