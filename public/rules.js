(function rulesModule() {
  'use strict';
  const { state, escHtml, sendWs, showAlert } = window.dashboard;

  state.rules = [];
  let dragSrcId = null;
  let expandedId = null;

  let monacoReady = false;
  let monacoReadyPromise = null;
  let currentEditor = null;
  let currentEditorRuleId = null;
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
      window.require(['vs/editor/editor.main'], function () {
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

  function createEditor(container, source, ruleId, readOnly) {
    disposeEditor();
    currentEditorRuleId = ruleId;
    isEditorDirty = false;

    if (window.dashboard.wantsPlainEditor()) {
      currentEditor = window.dashboard.createPlainEditor(container, source, readOnly);
      if (!readOnly) {
        currentEditor.onDidChangeModelContent(() => {
          isEditorDirty = true;
          const saveBtn = document.querySelector(`.rule-save-btn[data-id="${ruleId}"]`);
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

    currentEditor.onDidChangeModelContent(() => {
      isEditorDirty = true;
      const saveBtn = document.querySelector(`.rule-save-btn[data-id="${ruleId}"]`);
      if (saveBtn) saveBtn.disabled = false;
    });

    updateEditorHeight();
    currentEditor.onDidChangeModelContent(updateEditorHeight);
  }

  function disposeEditor() {
    if (currentEditor) {
      currentEditor.dispose();
      currentEditor = null;
      currentEditorRuleId = null;
      isEditorDirty = false;
    }
  }

  function renderRuleList() {
    const list = document.getElementById('ruleList');
    if (!list) return;
    list.innerHTML = '';

    if (state.rules.length === 0) {
      list.innerHTML = '<div class="rule-empty">No proxy rules defined. Click "+ New Rule" to create one.</div>';
      return;
    }

    for (const rule of state.rules) {
      const isExpanded = expandedId === rule.id;
      const bi = !!rule.builtin;
      const item = document.createElement('div');
      item.className = 'rule-item' + (rule.enabled ? '' : ' disabled') + (isExpanded ? ' expanded' : '');
      item.dataset.id = rule.id;
      item.draggable = true;
      item.innerHTML = `
        <div class="rule-item-header">
          <span class="rule-drag-handle" title="Drag to reorder">&#9776;</span>
          <span class="rule-move">
            <button class="rule-move-btn" data-move="-1" data-id="${escHtml(rule.id)}" title="Move up" aria-label="Move up">&#9650;</button>
            <button class="rule-move-btn" data-move="1" data-id="${escHtml(rule.id)}" title="Move down" aria-label="Move down">&#9660;</button>
          </span>
          <label class="rule-toggle" title="${rule.enabled ? 'Enabled' : 'Disabled'}">
            <input type="checkbox" ${rule.enabled ? 'checked' : ''} data-id="${escHtml(rule.id)}">
            <span class="rule-toggle-slider"></span>
          </label>
          <div class="rule-item-info">
            <div class="rule-item-name">${escHtml(rule.name)}</div>
            ${bi ? '<span class="ref-tag tag-ro" style="font-size:9px">built-in</span>' : ''}
          </div>
          ${bi ? '' : `<button class="rule-del-btn" data-id="${escHtml(rule.id)}" title="Delete rule">&#10005;</button>`}
        </div>
        <div class="rule-item-detail" style="display:${isExpanded ? 'block' : 'none'}">
          <div class="rule-item-slug">${escHtml(rule.slug)}</div>
          <div class="rule-source-section">
            <div class="rule-source-toolbar">
              <span class="rule-source-label">Source</span>
              ${bi ? `<button class="rule-restore-btn" data-id="${escHtml(rule.id)}" title="Restore original">Restore</button>` : ''}
              <button class="rule-save-btn" data-id="${escHtml(rule.id)}" disabled>Save</button>
            </div>
            <div class="rule-editor-container" data-id="${escHtml(rule.id)}">
              <div class="rule-editor-loading">Loading editor&hellip;</div>
            </div>
          </div>
          <div class="rule-edit-row">
            <textarea class="rule-edit-input" data-id="${escHtml(rule.id)}" rows="3" placeholder="Describe a change to this rule&hellip;"></textarea>
            <button class="rule-edit-submit" data-id="${escHtml(rule.id)}">Apply with AI</button>
          </div>
        </div>`;
      list.appendChild(item);
    }

    if (expandedId) {
      ensureMonaco().then(() => {
        if (expandedId && editorReady()) {
          sendWs({ type: 'rule:source', id: expandedId });
        }
      });
    }
  }

  // Create rule
  function showNewRuleModal() {
    const backdrop = document.createElement('div');
    backdrop.className = 'alert-modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'alert-modal rule-create-modal';
    modal.innerHTML = `
      <div class="rule-create-title">New Proxy Rule</div>
      <div class="rule-create-help">
        Proxy rules are middleware functions that intercept every Anthropic API request flowing through the proxy.
        They can modify requests, transform responses, filter tools, or short-circuit calls entirely.
        <strong>Describe what your rule should do</strong> and an AI agent will generate the code.
      </div>
      <label class="rule-create-label">Name <span class="rule-create-optional">(optional)</span></label>
      <input class="rule-create-input" type="text" id="ruleCreateName" placeholder="e.g. French Response">
      <label class="rule-create-label">What should this rule do? <span class="rule-create-required">*</span></label>
      <textarea class="rule-create-textarea" id="ruleCreateDesc" rows="4" placeholder="Describe the rule behavior...">Strip the gitStatus block from system prompt messages — removes branch name, git status, and recent commit info that Claude Code injects</textarea>
      <div class="rule-create-example-hint">The example above is the description that produced the built-in "Strip Git Status" rule. Replace it with your own.</div>
      <div class="rule-create-buttons">
        <button class="rule-create-cancel">Cancel</button>
        <button class="rule-create-submit" id="ruleCreateSubmit">Create Rule</button>
      </div>`;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const descInput = modal.querySelector('#ruleCreateDesc');
    const nameInput = modal.querySelector('#ruleCreateName');
    const submitBtn = modal.querySelector('#ruleCreateSubmit');

    function validate() {
      submitBtn.disabled = !descInput.value.trim();
    }
    descInput.addEventListener('input', validate);
    validate();

    descInput.select();

    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
    modal.querySelector('.rule-create-cancel').addEventListener('click', close);
    submitBtn.addEventListener('click', () => {
      const description = descInput.value.trim();
      if (!description) return;
      const name = nameInput.value.trim();
      const msg = { type: 'rule:create', description };
      if (name) msg.name = name;
      sendWs(msg);
      close();
    });
  }

  document.getElementById('ruleNewBtn')?.addEventListener('click', showNewRuleModal);

  // Event delegation
  document.getElementById('ruleList')?.addEventListener('click', (e) => {
    // Toggle switch
    const toggle = e.target.closest('.rule-toggle input');
    if (toggle) {
      e.stopPropagation();
      sendWs({ type: 'rule:toggle', id: toggle.dataset.id, enabled: toggle.checked });
      return;
    }
    if (e.target.closest('.rule-toggle')) return;

    // Delete
    const delBtn = e.target.closest('.rule-del-btn');
    if (delBtn) {
      e.stopPropagation();
      if (confirm('Delete this rule? The server will restart.')) {
        sendWs({ type: 'rule:delete', id: delBtn.dataset.id });
      }
      return;
    }

    // Manual save
    const saveBtn = e.target.closest('.rule-save-btn');
    if (saveBtn) {
      e.stopPropagation();
      if (!currentEditor || !isEditorDirty) return;
      sendWs({ type: 'rule:save', id: saveBtn.dataset.id, source: currentEditor.getValue() });
      saveBtn.disabled = true;
      return;
    }

    // Restore builtin
    const restoreBtn = e.target.closest('.rule-restore-btn');
    if (restoreBtn) {
      e.stopPropagation();
      if (confirm('Restore this rule to its original built-in version?')) {
        sendWs({ type: 'rule:restore', id: restoreBtn.dataset.id });
      }
      return;
    }

    // AI edit submit
    const submitBtn = e.target.closest('.rule-edit-submit');
    if (submitBtn) {
      e.stopPropagation();
      const input = submitBtn.parentElement.querySelector('.rule-edit-input');
      const desc = input?.value?.trim();
      if (!desc) return;
      sendWs({ type: 'rule:edit', id: submitBtn.dataset.id, description: desc });
      input.value = '';
      return;
    }

    if (e.target.closest('.rule-item-detail')) return;
    if (e.target.closest('.rule-drag-handle')) return;

    // ▲▼ stand in for drag-and-drop where there is no mouse (mobile.css
    // shows them for coarse pointers only). Same rule:reorder as a drop.
    const moveBtn = e.target.closest('.rule-move-btn');
    if (moveBtn) {
      const ids = state.rules.map(r => r.id);
      const from = ids.indexOf(moveBtn.dataset.id);
      const to = from + Number(moveBtn.dataset.move);
      if (from < 0 || to < 0 || to >= ids.length) return;
      [ids[from], ids[to]] = [ids[to], ids[from]];
      sendWs({ type: 'rule:reorder', ids });
      return;
    }

    // Click on header row -> expand/collapse
    const item = e.target.closest('.rule-item');
    if (item) {
      const newId = expandedId === item.dataset.id ? null : item.dataset.id;
      if (expandedId !== newId) disposeEditor();
      expandedId = newId;
      renderRuleList();
    }
  });

  // Ctrl+Enter in edit input
  document.getElementById('ruleList')?.addEventListener('keydown', (e) => {
    if (!(e.key === 'Enter' && (e.ctrlKey || e.metaKey))) return;
    const input = e.target.closest('.rule-edit-input');
    if (!input) return;
    const desc = input.value.trim();
    if (!desc) return;
    sendWs({ type: 'rule:edit', id: input.dataset.id, description: desc });
    input.value = '';
  });

  // Drag-and-drop reordering
  document.getElementById('ruleList')?.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.rule-item');
    if (!item) return;
    dragSrcId = item.dataset.id;
    item.style.opacity = '0.4';
    e.dataTransfer.effectAllowed = 'move';
  });

  document.getElementById('ruleList')?.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const item = e.target.closest('.rule-item');
    if (item) item.style.borderTop = '2px solid var(--accent, #2255aa)';
  });

  document.getElementById('ruleList')?.addEventListener('dragleave', (e) => {
    const item = e.target.closest('.rule-item');
    if (item) item.style.borderTop = '';
  });

  document.getElementById('ruleList')?.addEventListener('drop', (e) => {
    e.preventDefault();
    const target = e.target.closest('.rule-item');
    if (!target || !dragSrcId) return;
    target.style.borderTop = '';

    const targetId = target.dataset.id;
    if (dragSrcId === targetId) return;

    const ids = state.rules.map(r => r.id);
    const fromIdx = ids.indexOf(dragSrcId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;

    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, dragSrcId);
    sendWs({ type: 'rule:reorder', ids });
  });

  document.getElementById('ruleList')?.addEventListener('dragend', (e) => {
    dragSrcId = null;
    document.querySelectorAll('.rule-item').forEach(el => {
      el.style.opacity = '';
      el.style.borderTop = '';
    });
  });

  function handleMessage(msg) {
    switch (msg.type) {
      case 'rule:list':
        state.rules = msg.rules || [];
        disposeEditor();
        renderRuleList();
        document.getElementById('ruleGeneratingStatus')?.classList.add('hidden');
        break;
      case 'rule:generating':
        document.getElementById('ruleGeneratingStatus')?.classList.remove('hidden');
        break;
      case 'rule:generated':
        document.getElementById('ruleGeneratingStatus')?.classList.add('hidden');
        break;
      case 'rule:error':
        document.getElementById('ruleGeneratingStatus')?.classList.add('hidden');
        showAlert(msg.error);
        break;
      case 'rule:source': {
        if (msg.id !== expandedId) break;
        const container = document.querySelector(`.rule-editor-container[data-id="${msg.id}"]`);
        if (!container || !editorReady()) break;
        container.innerHTML = '';
        createEditor(container, msg.source, msg.id, false);
        break;
      }
      case 'rule:saved':
        isEditorDirty = false;
        showAlert('Rule saved');
        break;
      case 'rule:restored':
        isEditorDirty = false;
        showAlert('Rule restored to original');
        if (msg.id === expandedId) {
          sendWs({ type: 'rule:source', id: msg.id });
        }
        break;
    }
  }

  window.rulesModule = { handleMessage };
})();
