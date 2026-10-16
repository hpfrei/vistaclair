/* New CLI dialog — the "+" menu's and Pro's "Change app" session picker.
 *
 * The server's New CLI ask (orchestration.askMode) carries formData.kind
 * 'new-cli' and formData.newCli; cli.js's ask overlay hands such a form here
 * instead of building the generic one. The dialog asks the session type, an
 * SDK session's billing, an orchestrator's own model, and an optional routing
 * of model families to other models (the tab's modelMap, applied by the proxy
 * to the whole session or run). The engine is never asked: the server decides
 * it (given.engine — the Agent SDK panel, or a terminal by the fallback pref).
 * It answers with the same ids the generic form uses — mode, auth — plus
 * model and modelMap.
 *
 *   window.newCliDialog.render(newCli, { uid, onSubmit(answer), onCancel() })
 *     -> { el, focus() }
 */
(function () {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];
  const familyOf = (model) => FAMILIES.find(f => String(model || '').toLowerCase().includes(f)) || null;
  const ONE_M = 1000000;

  function fmtCtx(n) {
    if (!n) return '';
    if (n >= 950000) return `${+(n / 1048576).toFixed(1)}M`;
    return `${Math.round(n / 1000)}K`;
  }
  function fmtPrice(t) {
    const f = (v) => typeof v === 'number' ? `$${v % 1 === 0 ? v : v.toFixed(2)}` : null;
    const i = f(t.inputCostPerMTok), o = f(t.outputCostPerMTok);
    return i || o ? `${i || '$?'}/${o || '$?'}` : '';
  }
  function modelLabel(value, options) {
    const m = (options || []).find(o => o.value === value);
    if (m) return `${m.label} ${m.detail ? m.detail.replace(' context', '') : ''}`.trim();
    return value || '';
  }

  function render(nc, { uid = 'ncd', onSubmit, onCancel } = {}) {
    nc = nc || {};
    const given = nc.given || {};
    const creds = nc.credentials || {};
    const labels = nc.labels || {
      mode: { simple: 'Simple CLI', orchestrator: 'Orchestrator CLI' },
      engine: { cli: 'CLI terminal', sdk: 'Agent SDK panel' },
      auth: { apikey: 'API key', subscription: 'Claude subscription' },
    };
    const orchModels = nc.orchestratorModels || [];
    const targets = nc.remapTargets || [];
    const bothCreds = !!(creds.apiKey && creds.subscription);

    const state = {
      mode: given.mode || 'orchestrator',
      engine: given.engine || 'sdk',
      auth: given.auth || (bothCreds ? 'subscription' : nc.onlyAuth || null),
      model: nc.orchestratorModel || orchModels[0]?.value || null,
      remapOpen: false,
      map: { fable: '', opus: '', sonnet: '', haiku: '' },
    };

    const el = document.createElement('div');
    el.className = 'ncd';

    const seg = (name, items, current) => `
      <div class="ncd-seg" role="radiogroup">
        ${items.map(it => `
          <label class="ncd-seg-opt${it.disabled ? ' disabled' : ''}" title="${esc(it.title || '')}">
            <input type="radio" name="${uid}-${name}" value="${esc(it.value)}"${it.value === current ? ' checked' : ''}${it.disabled ? ' disabled' : ''}>
            <span>${esc(it.label)}${it.detail ? ` <em>${esc(it.detail)}</em>` : ''}</span>
          </label>`).join('')}
      </div>`;

    const card = (value, title, text, icon) => `
      <label class="ncd-card">
        <input type="radio" name="${uid}-mode" value="${value}"${state.mode === value ? ' checked' : ''}>
        <span class="ncd-card-icon" aria-hidden="true">${icon}</span>
        <span class="ncd-card-body">
          <span class="ncd-card-title">${esc(title)}</span>
          <span class="ncd-card-text">${esc(text)}</span>
        </span>
      </label>`;

    // Remap targets grouped by provider, Anthropic first.
    const groups = new Map();
    [...targets]
      .sort((a, b) => (a.providerKey === 'anthropic' ? 0 : 1) - (b.providerKey === 'anthropic' ? 0 : 1)
        || String(a.providerLabel || '').localeCompare(String(b.providerLabel || ''))
        || String(a.label).localeCompare(String(b.label)))
      .forEach(t => {
        const g = t.providerLabel || t.providerKey || 'Other';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(t);
      });
    const targetOptions = [...groups].map(([g, list]) => `
      <optgroup label="${esc(g)}">
        ${list.map(t => {
          const bits = [fmtCtx(t.contextWindow), fmtPrice(t)].filter(Boolean).join(' · ');
          const dep = t.lifecycle === 'deprecated' ? ' (deprecated)' : '';
          return `<option value="${esc(t.name)}">${esc(t.label)}${dep}${bits ? ` — ${esc(bits)}` : ''}</option>`;
        }).join('')}
      </optgroup>`).join('');

    el.innerHTML = `
      ${given.mode ? '' : `
      <div class="ncd-section">
        <div class="ncd-label">Session type</div>
        <div class="ncd-cards">
          ${card('orchestrator', 'Orchestrator', `Plans, delegates to up to ${nc.maxWorkers || 5} workers, tracks a TODO. Never codes itself.`, '◇')}
          ${card('simple', 'Simple', 'One Claude Code session, as usual.', '▢')}
        </div>
      </div>`}
      <div class="ncd-rows">
        <div class="ncd-row" data-row="auth">
          <div class="ncd-label">Billing</div>
          <div class="ncd-auth-slot"></div>
        </div>
        <div class="ncd-row" data-row="model">
          <div class="ncd-label">Orchestrator</div>
          ${seg('model', orchModels.map(m => ({ value: m.value, label: m.label, detail: m.detail ? m.detail.replace(' context', '') : '', disabled: m.available === false, title: m.available === false ? 'Needs a Claude credential' : m.value })), state.model)}
        </div>
        <div class="ncd-note" data-row="model-note"></div>
      </div>
      <div class="ncd-remap">
        <button type="button" class="ncd-remap-toggle" aria-expanded="false">
          <span class="ncd-chev" aria-hidden="true">▸</span>
          <span class="ncd-remap-title">Route to other models</span>
          <span class="ncd-pill" data-pill>off</span>
        </button>
        <div class="ncd-remap-body" hidden>
          <div class="ncd-note ncd-remap-intro"></div>
          ${targets.length ? FAMILIES.map(f => `
          <div class="ncd-map-row" data-family="${f}">
            <div class="ncd-map-fam">
              <span class="ncd-fam-name">${f[0].toUpperCase() + f.slice(1)}</span>
              <span class="ncd-fam-use" data-use></span>
            </div>
            <select class="ncd-select" data-map="${f}">
              <option value="">No routing</option>
              ${targetOptions}
            </select>
            <div class="ncd-map-warn" data-warn hidden></div>
          </div>`).join('') : '<div class="ncd-note">No other model is usable: add a provider key on the Models page.</div>'}
          ${targets.length ? '<button type="button" class="ncd-link" data-reset>Clear all</button>' : ''}
        </div>
      </div>
      <div class="ncd-footer">
        <div class="ncd-summary" aria-live="polite"></div>
        <div class="ncd-actions">
          <button type="button" class="ncd-btn ncd-cancel">Cancel</button>
          <button type="button" class="ncd-btn ncd-open">Open</button>
        </div>
      </div>`;

    const $ = (sel) => el.querySelector(sel);
    const $$ = (sel) => [...el.querySelectorAll(sel)];

    function authSlot() {
      const slot = $('.ncd-auth-slot');
      if (bothCreds && !given.auth) {
        slot.innerHTML = seg('auth', [
          { value: 'subscription', label: 'Subscription', title: 'Your Claude Max/Pro plan, as a CLI terminal is' },
          { value: 'apikey', label: 'API key', title: 'Per token, to the Anthropic API key on the Models page' },
        ], state.auth);
      } else {
        const a = given.auth || nc.onlyAuth;
        slot.innerHTML = a
          ? `<span class="ncd-fixed">${esc(labels.auth[a] || a)}${given.auth ? '' : ' <em>the only Claude credential</em>'}</span>`
          : '<span class="ncd-fixed ncd-warn-text">No Claude credential: an API key on the Models page, or <code>claude /login</code></span>';
      }
    }
    authSlot();

    function orchFamily() { return state.mode === 'orchestrator' ? familyOf(state.model) : null; }
    function defaultFamily() { return familyOf(nc.defaultModel); }
    // Which context a family's sessions expect: [1m] aliases expect 1M.
    function expectsCtx(f) {
      if (f === orchFamily() && /\[1m\]/i.test(state.model || '')) return ONE_M;
      if (f === defaultFamily() && /\[1m\]/i.test(nc.defaultModel || '')) return ONE_M;
      return 200000;
    }
    function usesOf(f) {
      const u = [];
      if (state.mode === 'orchestrator') {
        if (f === orchFamily()) u.push('orchestrator');
        if (f === defaultFamily()) u.push('workers (default)');
        if (f === 'opus') u.push('coder subagents');
        if (f === 'sonnet') u.push('explorer subagents');
      } else if (f === defaultFamily()) u.push('this session');
      if (f === 'haiku') u.push('background calls');
      return u.length ? u.join(', ') : 'only if asked for';
    }

    function update() {
      const isOrch = state.mode === 'orchestrator';
      $('[data-row="auth"]').hidden = state.engine !== 'sdk';
      $('[data-row="model"]').hidden = !isOrch;
      const note = $('[data-row="model-note"]');
      note.hidden = !isOrch;
      note.textContent = `Workers: as the orchestrator picks per task, else ${nc.defaultModel || 'opus'} · coder subagents Opus · explorers Sonnet`;
      $('.ncd-remap-intro') && ($('.ncd-remap-intro').textContent = isOrch
        ? 'Applies to the whole run — orchestrator, workers and their subagents. The proxy sends each family\'s requests to the model picked here; the sessions don\'t notice.'
        : 'Applies to this session and its subagents. The proxy sends each family\'s requests to the model picked here; the session doesn\'t notice.');
      let routed = 0;
      for (const f of FAMILIES) {
        const row = el.querySelector(`[data-family="${f}"]`);
        if (!row) continue;
        row.querySelector('[data-use]').textContent = usesOf(f);
        const t = targets.find(x => x.name === state.map[f]);
        row.classList.toggle('on', !!t);
        if (t) routed++;
        const warn = row.querySelector('[data-warn]');
        const w = [];
        if (t && t.providerKey !== 'anthropic') w.push(`Billed per token to ${t.providerLabel || t.providerKey}${state.engine === 'sdk' && state.auth === 'subscription' ? ', not your subscription' : ''}.`);
        if (t && t.contextWindow && t.contextWindow < expectsCtx(f) * 0.95) w.push(`Context ${fmtCtx(t.contextWindow)}, the session expects ${fmtCtx(expectsCtx(f))}.`);
        warn.hidden = !w.length;
        warn.textContent = w.join(' ');
      }
      const pill = $('[data-pill]');
      pill.textContent = routed ? `${routed} routed` : 'off';
      pill.classList.toggle('on', routed > 0);

      const parts = [isOrch ? 'Orchestrator' : 'Simple', state.engine === 'sdk' ? 'SDK panel' : 'Terminal'];
      if (state.engine === 'sdk' && state.auth) parts.push(state.auth === 'apikey' ? 'API key' : 'subscription');
      if (isOrch && state.model) parts.push(modelLabel(state.model, orchModels));
      if (routed) parts.push(`${routed} routed`);
      $('.ncd-summary').textContent = parts.join(' · ');
    }

    el.addEventListener('change', (e) => {
      const t = e.target;
      if (t.name === `${uid}-mode`) state.mode = t.value;
      else if (t.name === `${uid}-auth`) state.auth = t.value;
      else if (t.name === `${uid}-model`) state.model = t.value;
      else if (t.dataset.map) state.map[t.dataset.map] = t.value;
      update();
    });

    const toggle = $('.ncd-remap-toggle');
    toggle.addEventListener('click', () => {
      state.remapOpen = !state.remapOpen;
      toggle.setAttribute('aria-expanded', String(state.remapOpen));
      el.classList.toggle('remap-open', state.remapOpen);
      $('.ncd-remap-body').hidden = !state.remapOpen;
    });
    $('[data-reset]')?.addEventListener('click', () => {
      for (const f of FAMILIES) state.map[f] = '';
      $$('[data-map]').forEach(s => { s.value = ''; });
      update();
    });

    let done = false;
    function submit() {
      if (done) return;
      done = true;
      const modelMap = {};
      for (const f of FAMILIES) if (state.map[f]) modelMap[f] = state.map[f];
      const answer = [
        { id: 'mode', question: 'Session type', answer: labels.mode[state.mode] },
      ];
      if (state.engine === 'sdk' && state.auth) answer.push({ id: 'auth', question: 'Billing', answer: labels.auth[state.auth] });
      if (state.mode === 'orchestrator' && state.model) answer.push({ id: 'model', question: 'Orchestrator model', answer: state.model });
      if (Object.keys(modelMap).length) answer.push({ id: 'modelMap', question: 'Model routing', answer: modelMap });
      onSubmit && onSubmit(answer);
    }
    function cancel() {
      if (done) return;
      done = true;
      onCancel && onCancel();
    }
    $('.ncd-open').addEventListener('click', submit);
    $('.ncd-cancel').addEventListener('click', cancel);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      else if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'SELECT' && !e.target.closest('button')) { e.preventDefault(); submit(); }
    });

    update();
    return { el, focus: () => $('.ncd-open').focus() };
  }

  window.newCliDialog = { render };
})();
