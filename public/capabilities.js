// ============================================================
// CAPABILITIES MODULE — skills, agents, hooks, models
// ============================================================
(function capabilitiesModule() {
  const { state, escHtml, sendWs, showAlert } = window.dashboard;

  // --- Templates ---

  const AGENT_TEMPLATE = `---
name: my-agent
description: |
  Use this agent when [describe trigger conditions].
  Should be invoked proactively when [situation].
model: sonnet
tools: [Read, Glob, Grep, Bash]
# disallowedTools: [Write, Edit]
# permissionMode: default
# maxTurns: 20
# effort: high
# background: false
# isolation: worktree
# skills:
#   - my-skill
# hooks:
#   PreToolUse:
#     - matcher: "Bash"
#       hooks:
#         - type: command
#           command: "./validate.sh"
---

You are an expert at [role].

## Your task

When invoked, you should:

1. [First step]
2. [Second step]
3. [Third step]

## Guidelines

- Always [important behavior]
- Never [anti-pattern]
- Return a concise summary of your findings`;

  const SKILL_TEMPLATE = `---
name: my-skill
description: >
  This skill should be used when the user asks to [describe trigger phrases],
  or when the conversation involves [topic area].
argument-hint: <filename> [options]
# user-invocable: true
# disable-model-invocation: false
# model: sonnet
# effort: high
# context: fork
# allowed-tools: Read, Grep, Glob
---

You are an expert at [domain]. When triggered, you should:

1. Analyze the request: \$ARGUMENTS
2. [Second step]
3. [Third step]

## Guidelines

- Always [important behavior]
- Never [anti-pattern]

## Dynamic context

Available templates in this skill directory:
!\`ls \${CLAUDE_SKILL_DIR}/templates/ 2>/dev/null || echo "(no templates yet)"\``;

  // --- Capability stats ---

  function updateCapabilityStats() {
    const builtinSkills = state.knownSkills?.length || 0;
    const customSkills = state.skills?.length || 0;
    const skillCountEl = document.getElementById('capSkillCount');
    if (skillCountEl) skillCountEl.textContent = builtinSkills + customSkills;
    const agentCountEl = document.getElementById('capAgentCount');
    if (agentCountEl) agentCountEl.textContent = state.agents.length;
    const hookCountEl = document.getElementById('capHookCount');
    if (hookCountEl) hookCountEl.textContent = state.hooks.length;
  }

  // --- Skills Panel ---

  function renderSkillsPanel() {
    const list = document.getElementById('capSkillList');
    if (list) {
      list.innerHTML = '';
      for (const skill of state.skills) {
        const item = document.createElement('div');
        item.className = 'cap-list-item';
        item.innerHTML = `<span class="cap-item-name">${escHtml(skill.name)}</span>
          <span class="cap-item-desc">${escHtml(skill.description)}</span>
          <span class="cap-list-actions">
            <button class="cap-edit-btn" data-name="${skill.name}" data-kind="skill" title="Edit">&#9998;</button>
            <button class="cap-del-btn" data-name="${skill.name}" data-kind="skill" title="Delete">&#10005;</button>
          </span>`;
        list.appendChild(item);
      }
    }

    const grid = document.getElementById('skillsGrid');
    if (grid) {
      grid.innerHTML = '';
      for (const skill of (state.knownSkills || [])) {
        const card = document.createElement('div');
        card.className = 'ref-card';
        card.innerHTML = `<div class="ref-card-header" onclick="toggleRef(this)">
            <span><span class="ref-name">/${skill.name}</span> <span class="ref-tag tag-sk">skill</span></span>
            <span class="ref-brief">${escHtml(skill.description)}</span>
            <span class="ref-chevron">&#9654;</span>
          </div>
          <div class="ref-card-body">
            <p>${escHtml(skill.description)}</p>
            <p class="ref-intro">Built-in skill. Invoked automatically by Claude when the context matches.</p>
          </div>`;
        grid.appendChild(card);
      }
    }

    updateCapabilityStats();
  }

  // --- Skills CRUD ---

  document.getElementById('capNewSkill')?.addEventListener('click', () => {
    state.editingSkill = '__new__';
    document.getElementById('skillModalTitle').textContent = 'New Skill';
    document.getElementById('capSkillTextarea').value = SKILL_TEMPLATE;
    document.getElementById('capSkillFiles').innerHTML = '';
    document.getElementById('skillModal')?.classList.remove('hidden');
  });

  document.getElementById('capSkillSave')?.addEventListener('click', () => {
    const ta = document.getElementById('capSkillTextarea');
    if (!ta) return;
    const content = ta.value;
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const name = nameMatch ? nameMatch[1].trim() : null;
    if (!name) return showAlert('Missing "name:" in frontmatter');
    const extraFiles = [];
    document.querySelectorAll('#capSkillFiles .cap-modal-file-entry').forEach(entry => {
      const fname = entry.querySelector('.cap-modal-file-name')?.value?.trim();
      const fcontent = entry.querySelector('.cap-modal-file-content')?.value;
      if (fname && fcontent != null) extraFiles.push({ name: fname, content: fcontent });
    });
    sendWs({ type: 'skill:save', name, content, extraFiles });
    document.getElementById('skillModal')?.classList.add('hidden');
    state.editingSkill = null;
  });

  function closeSkillModal() {
    document.getElementById('skillModal')?.classList.add('hidden');
    state.editingSkill = null;
  }
  document.getElementById('capSkillCancel')?.addEventListener('click', closeSkillModal);
  document.getElementById('capSkillCancel2')?.addEventListener('click', closeSkillModal);

  document.getElementById('capSkillAddFile')?.addEventListener('click', () => {
    const container = document.getElementById('capSkillFiles');
    if (!container) return;
    const entry = document.createElement('div');
    entry.className = 'cap-modal-file-entry';
    entry.innerHTML = `<div class="cap-modal-file-header">
        <input type="text" class="cap-modal-file-name" placeholder="filename (e.g. templates/base.md or scripts/check.sh)">
        <button class="cap-modal-file-remove" title="Remove">&times;</button>
      </div>
      <textarea class="cap-modal-file-content cap-modal-code" rows="6" spellcheck="false" placeholder="File content..."></textarea>`;
    entry.querySelector('.cap-modal-file-remove').addEventListener('click', () => entry.remove());
    container.appendChild(entry);
  });

  // --- Agents Panel ---

  function renderAgentsPanel() {
    const list = document.getElementById('capAgentList');
    if (!list) return;
    list.innerHTML = '';
    for (const agent of state.agents) {
      const item = document.createElement('div');
      item.className = 'cap-list-item';
      item.innerHTML = `<span class="cap-item-name">${escHtml(agent.name)}</span>
        <span class="cap-item-desc">${escHtml(agent.description)}</span>
        <span class="cap-list-actions">
          <button class="cap-edit-btn" data-name="${agent.name}" data-kind="agent" title="Edit">&#9998;</button>
          <button class="cap-del-btn" data-name="${agent.name}" data-kind="agent" title="Delete">&#10005;</button>
        </span>`;
      list.appendChild(item);
    }
  }

  document.getElementById('capNewAgent')?.addEventListener('click', () => {
    state.editingAgent = '__new__';
    document.getElementById('agentModalTitle').textContent = 'New Agent';
    document.getElementById('capAgentTextarea').value = AGENT_TEMPLATE;
    document.getElementById('agentModal')?.classList.remove('hidden');
  });

  document.getElementById('capAgentSave')?.addEventListener('click', () => {
    const ta = document.getElementById('capAgentTextarea');
    if (!ta) return;
    const content = ta.value;
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const name = nameMatch ? nameMatch[1].trim() : null;
    if (!name) return showAlert('Missing "name:" in frontmatter');
    sendWs({ type: 'agent:save', name, content });
    document.getElementById('agentModal')?.classList.add('hidden');
    state.editingAgent = null;
  });

  function closeAgentModal() {
    document.getElementById('agentModal')?.classList.add('hidden');
    state.editingAgent = null;
  }
  document.getElementById('capAgentCancel')?.addEventListener('click', closeAgentModal);
  document.getElementById('capAgentCancel2')?.addEventListener('click', closeAgentModal);

  // --- Hooks Panel ---

  function renderHooksPanel() {
    const list = document.getElementById('capHookList');
    if (!list) return;
    list.innerHTML = '';

    const eventSel = document.getElementById('capHookEvent');
    if (eventSel && eventSel.options.length === 0 && state.hookEvents.length > 0) {
      for (const ev of state.hookEvents) {
        const opt = document.createElement('option');
        opt.value = ev;
        opt.textContent = ev;
        eventSel.appendChild(opt);
      }
    }

    for (const hook of state.hooks) {
      const item = document.createElement('div');
      item.className = 'cap-list-item';
      const matcherText = hook.matcher ? ` \u2192 ${hook.matcher}` : '';
      const cmdPreview = hook.command.length > 40 ? hook.command.slice(0, 40) + '\u2026' : hook.command;
      item.innerHTML = `<span class="cap-item-name">${escHtml(hook.event)}${escHtml(matcherText)}</span>
        <span class="cap-item-desc">${escHtml(cmdPreview)}</span>
        <span class="cap-list-actions">
          <button class="cap-edit-btn" data-event="${hook.event}" data-entry="${hook.entryIndex}" data-hook="${hook.hookIndex}" data-kind="hook" title="Edit">&#9998;</button>
          <button class="cap-del-btn" data-event="${hook.event}" data-entry="${hook.entryIndex}" data-kind="hook" title="Delete">&#10005;</button>
        </span>`;
      list.appendChild(item);
    }
  }

  document.getElementById('capNewHook')?.addEventListener('click', () => {
    state.editingHook = '__new__';
    document.getElementById('hookModalTitle').textContent = 'New Hook';
    document.getElementById('capHookEvent').value = state.hookEvents[0] || 'PreToolUse';
    document.getElementById('capHookMatcher').value = '';
    document.getElementById('capHookType').value = 'command';
    document.getElementById('capHookCommand').value = '';
    document.getElementById('capHookTimeout').value = '30';
    document.getElementById('hookModal')?.classList.remove('hidden');
    updateHookMatcherVisibility();
  });

  document.getElementById('capHookSave')?.addEventListener('click', () => {
    const hook = {
      event: document.getElementById('capHookEvent')?.value,
      matcher: document.getElementById('capHookMatcher')?.value || '',
      type: document.getElementById('capHookType')?.value || 'command',
      command: document.getElementById('capHookCommand')?.value || '',
      timeout: parseInt(document.getElementById('capHookTimeout')?.value) || 30,
    };
    if (!hook.command) return showAlert('Command/prompt is required');
    if (state.editingHook && state.editingHook !== '__new__') {
      hook.entryIndex = state.editingHook.entryIndex;
      hook.hookIndex = state.editingHook.hookIndex;
    }
    sendWs({ type: 'hook:save', hook });
    document.getElementById('hookModal')?.classList.add('hidden');
    state.editingHook = null;
  });

  function closeHookModal() {
    document.getElementById('hookModal')?.classList.add('hidden');
    state.editingHook = null;
  }
  document.getElementById('capHookCancel')?.addEventListener('click', closeHookModal);
  document.getElementById('capHookCancel2')?.addEventListener('click', closeHookModal);

  // --- Models Panel ---

  let activeProviderTab = null;

  // Claude auth preference UI (Anthropic provider only). Which credential Claude
  // calls use when both are available. Both options are fully supported; this is
  // a routing/billing choice, not a risk decision:
  //   Subscription — calls run on the `claude` CLI's login and draw on the
  //                  subscription's usage allowance (shared with interactive use).
  //   API key      — calls are billed per token to the Anthropic account.
  // With only one credential present the choice is moot and that one is used.
  function renderClaudeAuthSection() {
    const ca = state.claudeAuth || {};
    const pref = ca.pref || 'subscription'; // default shown selection
    const subBadge = ca.hasSubscription
      ? '<span class="mm-key-ok">subscription active</span>'
      : '<span class="mm-key-missing">no subscription &mdash; run <code>/login</code> in a CLI tab</span>';
    const checked = (v) => pref === v ? 'checked' : '';
    return `<div class="provider-claude-auth" id="claudeAuthSection">
      <div class="provider-claude-auth-head">
        <strong>Claude auth for app/automation calls</strong> ${subBadge}
      </div>
      <label class="claude-auth-opt">
        <input type="radio" name="claudeAuthPref" value="subscription" ${checked('subscription')}>
        <span><strong>Subscription</strong> &mdash; calls run on your Max/Pro login (OAuth) and draw on its usage allowance.</span>
      </label>
      <label class="claude-auth-opt">
        <input type="radio" name="claudeAuthPref" value="apikey" ${checked('apikey')}>
        <span><strong>API key</strong> &mdash; calls are billed per token to the API key above.</span>
      </label>
      <div class="provider-hint">Applies to interactive sessions and headless app/automation calls alike. Whichever credential you pick, the other is used automatically if the chosen one isn't configured.</div>
    </div>`;
  }

  function renderModelsPanel() {
    const nav = document.getElementById('modelsNav');
    const list = document.getElementById('capModelList');
    if (!list) return;

    // Build provider tabs (preserve non-tab children like the action button)
    if (nav) {
      nav.querySelectorAll('.view-tab').forEach(b => b.remove());
      const actionBtn = nav.querySelector('.view-nav-action');
      for (const prov of state.providers) {
        const btn = document.createElement('button');
        btn.className = 'view-tab' + (activeProviderTab === prov.key || (!activeProviderTab && prov === state.providers[0]) ? ' active' : '');
        btn.dataset.provider = prov.key;
        btn.textContent = prov.label;
        nav.insertBefore(btn, actionBtn);
      }
      if ((!activeProviderTab || !state.providers.some(p => p.key === activeProviderTab)) && state.providers.length) activeProviderTab = state.providers[0].key;
    }

    // Find active provider
    const prov = state.providers.find(p => p.key === activeProviderTab) || state.providers[0];
    if (!prov) { list.innerHTML = '<div class="models-empty">No providers configured.</div>'; return; }

    // Provider key bar
    const hasKey = !!prov.apiKey;
    const keyId = `provKey_${prov.key}`;
    let html = `<div class="provider-header">
      <span class="provider-url">${escHtml(prov.apiBaseUrl || '')}</span>
      <span class="provider-key-area">
        ${prov.key === 'anthropic' ? '<span class="provider-hint">Optional. Claude calls run on your Max/Pro login when one is active &mdash; run <code>/login</code> in a CLI tab. Add a key to bill per token to the API instead, or to use Claude without a subscription.</span>' : ''}
        <input type="password" id="${keyId}" class="provider-key-input" value="${escHtml(prov.apiKey || '')}" placeholder="Paste API key..." autocomplete="off">
        <button type="button" class="provider-key-toggle" data-target="${keyId}" title="Show/hide key">&#128065;</button>
        <button type="button" class="provider-key-save" data-provider="${escHtml(prov.key)}" title="Save key">${hasKey ? 'Update' : 'Set key'}</button>
        <span class="provider-key-status ${hasKey ? 'mm-key-ok' : 'mm-key-missing'}">${hasKey ? 'connected' : 'no key'}</span>
      </span>
    </div>`;

    if (prov.key === 'anthropic') {
      html += renderClaudeAuthSection();
    }

    // Model cards
    const provModels = state.models.filter(m => m.providerKey === prov.key);
    html += '<div class="model-card-grid">';
    for (const model of provModels) {
      const ctx = model.contextWindow ? Math.round(model.contextWindow / 1000) + 'K' : '';
      const out = model.maxOutputTokens ? Math.round(model.maxOutputTokens / 1000) + 'K' : '';
      const specs = [ctx ? ctx + ' ctx' : '', out ? out + ' out' : ''].filter(Boolean).join(', ');
      const pricing = model.inputCostPerMTok != null
        ? `$${model.inputCostPerMTok} / $${model.outputCostPerMTok} per MTok`
        : '';
      const isRetired = model.lifecycle === 'retired';
      const isDeprecated = model.lifecycle === 'deprecated';
      const lifecycleClass = isRetired ? ' model-card-retired' : '';
      const disabledClass = model.disabled ? ' model-card-disabled' : '';
      const retiresLabel = isDeprecated
        ? 'retiring' + (model.retiresAt ? ' ' + escHtml(model.retiresAt) : '')
        : '';
      html += `<div class="model-card${disabledClass}${lifecycleClass}" data-name="${escHtml(model.name)}" data-kind="model">
        <div class="model-card-top-row">
          <div class="model-card-name">${escHtml(model.label || model.name)}</div>
          <button class="model-toggle-btn" data-model="${escHtml(model.name)}" data-disabled="${model.disabled ? '1' : '0'}" title="${model.disabled ? 'Enable model' : 'Disable model'}">${model.disabled ? 'Enable' : 'Disable'}</button>
        </div>
        <div class="model-card-id"><code>${escHtml(model.modelId || '')}</code></div>
        ${model.description ? '<div class="model-card-desc">' + escHtml(model.description) + '</div>' : ''}
        <div class="model-card-meta">
          ${model.isNew ? '<span class="cap-model-new-badge">new</span>' : ''}
          ${isDeprecated ? '<span class="cap-model-deprecated-badge">' + retiresLabel + '</span>' : ''}
          ${isRetired ? '<span class="cap-model-retired-badge">retired</span>' : ''}
          ${model.disabled && !isRetired ? '<span class="cap-model-disabled-badge">disabled</span>' : ''}
          ${model.reasoning ? '<span class="cap-model-reasoning">reasoning</span>' : ''}
          ${specs ? '<span class="cap-model-specs">' + escHtml(specs) + '</span>' : ''}
          ${pricing ? '<span class="cap-model-pricing">' + escHtml(pricing) + '</span>' : ''}
        </div>
      </div>`;
    }
    if (provModels.length === 0) {
      html += '<div class="models-empty">No models for this provider.</div>';
    }
    html += '</div>';
    list.innerHTML = html;

    // Toggle button click (stop propagation to avoid opening edit modal)
    list.querySelectorAll('.model-toggle-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = btn.dataset.model;
        const disabled = btn.dataset.disabled === '0';
        sendWs({ type: 'model:toggle', name, disabled });
      });
    });

    // Card click → open edit modal
    list.querySelectorAll('.model-card').forEach(card => {
      card.addEventListener('click', () => {
        const model = state.models.find(m => m.name === card.dataset.name);
        if (model) openModelModal(model);
      });
    });
  }

  // Provider tab switching
  document.getElementById('modelsNav')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.view-tab');
    if (!btn) return;
    activeProviderTab = btn.dataset.provider;
    renderModelsPanel();
  });

  // Provider key toggle and save (delegated)
  document.addEventListener('click', (e) => {
    const toggle = e.target.closest('.provider-key-toggle');
    if (toggle) {
      const input = document.getElementById(toggle.dataset.target);
      if (input) input.type = input.type === 'password' ? 'text' : 'password';
    }

    const saveBtn = e.target.closest('.provider-key-save');
    if (saveBtn) {
      const provKey = saveBtn.dataset.provider;
      const prov = state.providers.find(p => p.key === provKey);
      if (!prov) return;
      const input = document.getElementById(`provKey_${provKey}`);
      const newKey = input ? input.value : '';
      sendWs({ type: 'provider:save', key: provKey, provider: { ...prov, apiKey: newKey } });
    }
  });

  // Claude auth preference radio (delegated change)
  document.addEventListener('change', (e) => {
    const radio = e.target.closest('input[name="claudeAuthPref"]');
    if (!radio) return;
    sendWs({ type: 'prefs:claudeAuth:set', value: radio.value });
  });

  function populateProviderKeyDropdown(selectedKey) {
    const sel = document.getElementById('mmProviderKey');
    if (!sel) return;
    sel.innerHTML = '';
    for (const p of state.providers) {
      const opt = document.createElement('option');
      opt.value = p.key;
      opt.textContent = p.label || p.key;
      sel.appendChild(opt);
    }
    sel.value = selectedKey || 'openai';
    updateCustomFieldsVisibility();
  }

  function updateCustomFieldsVisibility() {
    const pk = document.getElementById('mmProviderKey')?.value;
    const customFields = document.getElementById('mmCustomFields');
    if (customFields) {
      customFields.classList.toggle('hidden', pk !== 'custom');
    }
  }

  document.getElementById('mmProviderKey')?.addEventListener('change', updateCustomFieldsVisibility);

  // Default prompt checkbox toggle
  document.getElementById('mmUseDefaultPrompt')?.addEventListener('change', (e) => {
    const textarea = document.getElementById('mmSystemPrompt');
    if (textarea) textarea.classList.toggle('hidden', e.target.checked);
  });

  function populateModelForm(model, mode) {
    const nameInput = document.getElementById('mmName');
    nameInput.value = mode === 'duplicate' ? '' : (model.name || '');
    nameInput.readOnly = mode === 'edit';

    document.getElementById('mmLabel').value = (mode === 'duplicate' ? '' : model.label) || '';
    document.getElementById('mmDescription').value = (mode === 'duplicate' ? '' : model.description) || '';
    document.getElementById('mmProvider').value = model.provider || 'openai';
    document.getElementById('mmModelId').value = model.modelId || '';
    document.getElementById('mmSystemPromptMode').value = model.systemPromptMode || 'replace';

    // Reasoning, disabled + numeric fields
    const reasoningCb = document.getElementById('mmReasoning');
    if (reasoningCb) reasoningCb.checked = !!model.reasoning;
    const disabledCb = document.getElementById('mmDisabled');
    if (disabledCb) disabledCb.checked = !!model.disabled;
    const ctxInput = document.getElementById('mmContextWindow');
    if (ctxInput) ctxInput.value = model.contextWindow || '';
    const maxOutInput = document.getElementById('mmMaxOutputTokens');
    if (maxOutInput) maxOutInput.value = model.maxOutputTokens || '';

    // Cost fields
    const mmInputCost = document.getElementById('mmInputCost');
    if (mmInputCost) mmInputCost.value = model.inputCostPerMTok ?? '';
    const mmOutputCost = document.getElementById('mmOutputCost');
    if (mmOutputCost) mmOutputCost.value = model.outputCostPerMTok ?? '';
    const mmCacheReadCost = document.getElementById('mmCacheReadCost');
    if (mmCacheReadCost) mmCacheReadCost.value = model.cacheReadCostPerMTok ?? '';
    const mmCacheCreateCost = document.getElementById('mmCacheCreateCost');
    if (mmCacheCreateCost) mmCacheCreateCost.value = model.cacheCreateCostPerMTok ?? '';

    // Provider key dropdown
    populateProviderKeyDropdown(model.providerKey || 'openai');

    // Custom provider fields (only for custom provider)
    const apiBaseUrl = document.getElementById('mmApiBaseUrl');
    const apiKey = document.getElementById('mmApiKey');
    if (apiBaseUrl) apiBaseUrl.value = model.apiBaseUrl || '';
    if (apiKey) { apiKey.value = model.apiKey || ''; apiKey.type = 'password'; }

    // System prompt: check if model has a custom override
    const hasCustomPrompt = model.systemPrompt && !model.systemPrompt.startsWith('You are a coding assistant with direct access');
    const useDefaultCb = document.getElementById('mmUseDefaultPrompt');
    const promptTextarea = document.getElementById('mmSystemPrompt');
    if (useDefaultCb) useDefaultCb.checked = !hasCustomPrompt;
    if (promptTextarea) {
      promptTextarea.classList.toggle('hidden', !hasCustomPrompt);
      promptTextarea.value = hasCustomPrompt ? model.systemPrompt : '';
    }

    document.getElementById('mmToolOverrides').value =
      model.toolOverrides && Object.keys(model.toolOverrides).length > 0
        ? JSON.stringify(model.toolOverrides, null, 2)
        : '';
  }

  function openModelModal(model) {
    const title = document.getElementById('modelModalTitle');
    title.textContent = `Edit Model: ${model.label || model.name}`;

    // Hide catalog (not used in edit-only mode)
    const catalog = document.getElementById('mmCatalog');
    if (catalog) catalog.classList.add('hidden');

    populateModelForm(model, 'edit');
    state.editingModel = model.name;
    document.getElementById('modelModal')?.classList.remove('hidden');
  }

  function closeModelModal() {
    document.getElementById('modelModal')?.classList.add('hidden');
    state.editingModel = null;
  }

  // API key show/hide toggle (for custom provider in model modal)
  document.getElementById('mmApiKeyToggle')?.addEventListener('click', () => {
    const input = document.getElementById('mmApiKey');
    if (input) input.type = input.type === 'password' ? 'text' : 'password';
  });

  // Models are pre-populated from models.json — no create button needed

  document.getElementById('capModelSave')?.addEventListener('click', () => {
    const name = document.getElementById('mmName')?.value?.trim();
    if (!name) return showAlert('Model name is required.');
    if (!/^[a-z][a-z0-9._-]*$/.test(name)) {
      return showAlert('Invalid name. Use lowercase letters, numbers, dots, hyphens, underscores.');
    }

    let toolOverrides = {};
    const toVal = document.getElementById('mmToolOverrides')?.value?.trim();
    if (toVal) {
      try { toolOverrides = JSON.parse(toVal); }
      catch { return showAlert('Tool overrides must be valid JSON.'); }
    }

    const providerKey = document.getElementById('mmProviderKey')?.value || 'openai';
    const useDefault = document.getElementById('mmUseDefaultPrompt')?.checked;

    const ctxVal = parseInt(document.getElementById('mmContextWindow')?.value);
    const maxOutVal = parseInt(document.getElementById('mmMaxOutputTokens')?.value);

    const inCost = parseFloat(document.getElementById('mmInputCost')?.value);
    const outCost = parseFloat(document.getElementById('mmOutputCost')?.value);
    const crCost = parseFloat(document.getElementById('mmCacheReadCost')?.value);
    const ccCost = parseFloat(document.getElementById('mmCacheCreateCost')?.value);

    // Carry forward flags the form does not expose, so editing a model by hand
    // does not silently drop its 1M-context capability.
    const previous = (state.models || []).find(m => m.name === name);

    const model = {
      context1m: !!previous?.context1m,
      name,
      label: document.getElementById('mmLabel')?.value?.trim() || name,
      description: document.getElementById('mmDescription')?.value?.trim() || '',
      providerKey,
      provider: document.getElementById('mmProvider')?.value || 'openai',
      modelId: document.getElementById('mmModelId')?.value?.trim() || '',
      systemPromptMode: document.getElementById('mmSystemPromptMode')?.value || 'replace',
      toolOverrides,
      reasoning: !!document.getElementById('mmReasoning')?.checked,
      disabled: !!document.getElementById('mmDisabled')?.checked,
      contextWindow: ctxVal > 0 ? ctxVal : null,
      maxOutputTokens: maxOutVal > 0 ? maxOutVal : null,
      inputCostPerMTok: inCost >= 0 ? inCost : null,
      outputCostPerMTok: outCost >= 0 ? outCost : null,
      cacheReadCostPerMTok: crCost >= 0 ? crCost : null,
      cacheCreateCostPerMTok: ccCost >= 0 ? ccCost : null,
    };

    // Only send custom system prompt if user opted out of default
    if (!useDefault) {
      model.systemPrompt = document.getElementById('mmSystemPrompt')?.value || '';
    }

    // Custom provider models include their own apiBaseUrl/apiKey
    if (providerKey === 'custom') {
      model.apiBaseUrl = document.getElementById('mmApiBaseUrl')?.value?.trim() || '';
      model.apiKey = document.getElementById('mmApiKey')?.value || '';
    }

    sendWs({ type: 'model:save', model });
    closeModelModal();
  });

  document.getElementById('capModelCancel')?.addEventListener('click', closeModelModal);
  document.getElementById('capModelCancel2')?.addEventListener('click', closeModelModal);

  // --- Refresh: scan providers + update pricing ---
  document.getElementById('capRefreshModels')?.addEventListener('click', () => {
    const btn = document.getElementById('capRefreshModels');
    const statusEl = document.getElementById('capRefreshStatus');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="busy-dot"></span> Scanning providers\u2026';
    if (statusEl) { statusEl.classList.remove('hidden'); statusEl.textContent = 'Scanning provider APIs for new models...'; }
    sendWs({ type: 'model:refresh' });
  });

  // Scan summary, kept so the per-provider pricing lines that arrive afterwards
  // can be appended under it instead of replacing it.
  let refreshScanHtml = '';

  function renderRefreshStatus(pricingLines) {
    const statusEl = document.getElementById('capRefreshStatus');
    if (!statusEl) return;
    statusEl.classList.remove('hidden');
    const pricing = (pricingLines || []).map(l => escHtml(l)).join('<br>');
    statusEl.innerHTML = refreshScanHtml + (pricing ? `<br><small>${pricing}</small>` : '');
  }

  function showScanResults(results) {
    const btn = document.getElementById('capRefreshModels');
    const statusEl = document.getElementById('capRefreshStatus');

    const providerKeys = Object.keys(results);
    let totalAdded = 0;
    let totalScanned = 0;
    let totalDeprecated = 0;
    let totalRetired = 0;
    const lines = [];

    const nameOf = (m) => (typeof m === 'string' ? m : (m.label || m.name));
    for (const key of providerKeys) {
      const r = results[key];
      const provLabel = state.providers.find(p => p.key === key)?.label || key;
      if (r.status === 'ok') {
        totalScanned++;
        const added = r.added || [];
        const deprecated = r.deprecated || [];
        const retired = r.retired || [];
        totalAdded += added.length;
        totalDeprecated += deprecated.length;
        totalRetired += retired.length;
        const parts = [];
        if (added.length) parts.push(`added ${added.length} (${added.map(nameOf).join(', ')})`);
        if (deprecated.length) parts.push(`deprecated ${deprecated.length} (${deprecated.map(nameOf).join(', ')})`);
        if (retired.length) parts.push(`retired ${retired.length} (${retired.map(nameOf).join(', ')})`);
        lines.push(`${provLabel}: ${parts.length ? parts.join('; ') : `up to date (${r.total || 0} models)`}`);
      } else if (r.status === 'error') {
        totalScanned++;
        lines.push(`${provLabel}: error — ${r.error}`);
      } else {
        lines.push(`${provLabel}: skipped — ${r.error || 'no API key'}`);
      }
    }

    if (statusEl) {
      const changeParts = [];
      if (totalAdded) changeParts.push(`added ${totalAdded} new model${totalAdded !== 1 ? 's' : ''} (disabled by default)`);
      if (totalDeprecated) changeParts.push(`flagged ${totalDeprecated} deprecated`);
      if (totalRetired) changeParts.push(`retired ${totalRetired}`);
      const summary = changeParts.length
        ? `Scanned ${totalScanned} providers. ${changeParts.join(', ')}.`
        : `All models up to date.`;
      refreshScanHtml = escHtml(summary) + '<br><small>' + lines.map(escHtml).join('<br>') + '</small>';
      statusEl.innerHTML = refreshScanHtml;
    }
    if (btn) btn.innerHTML = '<span class="busy-dot"></span> Updating pricing…';

    sendWs({ type: 'model:list' });
    sendWs({ type: 'provider:list' });
  }


  document.getElementById('capHookEvent')?.addEventListener('change', updateHookMatcherVisibility);

  function updateHookMatcherVisibility() {
    const event = document.getElementById('capHookEvent')?.value;
    const matcherLabel = document.querySelector('.cap-hook-matcher-label');
    if (matcherLabel) {
      matcherLabel.style.display = state.matcherEvents?.includes(event) ? '' : 'none';
    }
  }

  // --- Delegated click handlers for edit/delete ---

  document.addEventListener('click', (e) => {
    const editBtn = e.target.closest('.cap-edit-btn');
    const delBtn = e.target.closest('.cap-del-btn');

    const dupBtn = e.target.closest('.cap-dup-btn');

    if (editBtn) {
      const kind = editBtn.dataset.kind;
      if (kind === 'skill') {
        const name = editBtn.dataset.name;
        const skill = state.skills.find(s => s.name === name);
        if (skill) {
          state.editingSkill = name;
          document.getElementById('skillModalTitle').textContent = `Edit Skill: ${name}`;
          document.getElementById('capSkillTextarea').value = skill.content;
          document.getElementById('capSkillFiles').innerHTML = '';
          document.getElementById('skillModal')?.classList.remove('hidden');
        }
      } else if (kind === 'agent') {
        const name = editBtn.dataset.name;
        const agent = state.agents.find(a => a.name === name);
        if (agent) {
          state.editingAgent = name;
          document.getElementById('agentModalTitle').textContent = `Edit Agent: ${name}`;
          document.getElementById('capAgentTextarea').value = agent.content;
          document.getElementById('agentModal')?.classList.remove('hidden');
        }
      } else if (kind === 'hook') {
        const event = editBtn.dataset.event;
        const entryIdx = parseInt(editBtn.dataset.entry);
        const hookData = state.hooks.find(h => h.event === event && h.entryIndex === entryIdx);
        if (hookData) {
          state.editingHook = { entryIndex: hookData.entryIndex, hookIndex: hookData.hookIndex };
          document.getElementById('hookModalTitle').textContent = `Edit Hook: ${hookData.event}`;
          document.getElementById('capHookEvent').value = hookData.event;
          document.getElementById('capHookMatcher').value = hookData.matcher;
          document.getElementById('capHookType').value = hookData.type;
          document.getElementById('capHookCommand').value = hookData.command;
          document.getElementById('capHookTimeout').value = hookData.timeout;
          document.getElementById('hookModal')?.classList.remove('hidden');
          updateHookMatcherVisibility();
        }
      } else if (kind === 'model') {
        const name = editBtn.dataset.name;
        const model = state.models.find(m => m.name === name);
        if (model) openModelModal(model);
      }
    }

    if (delBtn) {
      const kind = delBtn.dataset.kind;
      if (kind === 'skill') {
        if (confirm(`Delete skill ${delBtn.dataset.name}?`)) {
          sendWs({ type: 'skill:delete', name: delBtn.dataset.name });
        }
      } else if (kind === 'agent') {
        if (confirm(`Delete agent ${delBtn.dataset.name}?`)) {
          sendWs({ type: 'agent:delete', name: delBtn.dataset.name });
        }
      } else if (kind === 'hook') {
        if (confirm('Delete this hook?')) {
          sendWs({ type: 'hook:delete', event: delBtn.dataset.event, entryIndex: parseInt(delBtn.dataset.entry) });
        }
      } else if (kind === 'model') {
        if (confirm(`Delete model "${delBtn.dataset.name}"?`)) {
          sendWs({ type: 'model:delete', name: delBtn.dataset.name });
        }
      }
    }
  });

  // --- Message router ---

  function handleMessage(msg) {
    switch (msg.type) {
      case 'skill:list':
        state.skills = msg.skills || [];
        renderSkillsPanel();
        break;
      case 'agent:list':
        state.agents = msg.agents || [];
        renderAgentsPanel();
        break;
      case 'hook:list':
        state.hooks = msg.hooks || [];
        renderHooksPanel();
        break;
      case 'model:list':
        state.models = msg.models || [];
        renderModelsPanel();
        break;
      case 'provider:list':
        state.providers = msg.providers || [];
        renderModelsPanel();
        break;
      case 'prefs:claudeAuth':
        state.claudeAuth = {
          pref: msg.pref || null,
          hasSubscription: !!msg.hasSubscription,
        };
        renderModelsPanel();
        break;
      case 'model:refresh:scanned':
        showScanResults(msg.results);
        break;
      case 'model:refresh:status': {
        if (msg.lines) {
          renderRefreshStatus(msg.lines);
        } else {
          const statusEl = document.getElementById('capRefreshStatus');
          if (statusEl) { statusEl.classList.remove('hidden'); statusEl.textContent = msg.text || 'Updating...'; }
        }
        break;
      }
      case 'model:refresh:error': {
        const statusEl = document.getElementById('capRefreshStatus');
        const btn = document.getElementById('capRefreshModels');
        if (statusEl) { statusEl.classList.remove('hidden'); statusEl.textContent = 'Error: ' + (msg.error || 'unknown'); }
        if (btn) { btn.disabled = false; btn.textContent = 'Refresh'; }
        refreshScanHtml = '';
        break;
      }
      case 'model:refresh:done': {
        const statusEl = document.getElementById('capRefreshStatus');
        const btn = document.getElementById('capRefreshModels');
        const failures = (msg.lines || []).filter(l => /failed|could not/i.test(l));
        renderRefreshStatus([...(msg.lines || []), msg.text || 'Refresh complete.']);
        if (btn) { btn.disabled = false; btn.textContent = 'Refresh'; }
        // Leave the panel up when something failed, so the reason stays readable.
        if (!failures.length) setTimeout(() => { if (statusEl) statusEl.classList.add('hidden'); }, 8000);
        break;
      }
    }
  }

  function handleSettings(msg) {
    // State sync handled by core.js syncSettings()
  }

  // --- Export ---
  window.capabilitiesModule = { handleMessage, handleSettings };
})();
