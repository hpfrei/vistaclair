// === App Model Picker ===
// Reusable platform model-chooser. An app calls pickModel() (app-runtime.js),
// which postMessages { type:'app:pickModel', id, params } to this parent window.
// We render a modal positioned OVER that app's iframe wrap, then post
// { type:'app:pickModel:result', id, model } back to the iframe. Pure UI — no
// server round-trip beyond fetching the catalog (shared with the AI Config tab).
//
// `params.kind` picks the list: 'text' (default, the ai.models registry) or a
// media kind — 'speech' | 'transcription' | 'image' — from the media catalog
// (ai.mediaModels' payload). window.appModelPicker.open() is the same modal for
// host pages: Setup → AI Config's media defaults use it.
(function() {
  'use strict';
  const { sendWs, escHtml } = window.dashboard;
  const origin = window.location.origin;

  function findAppIframe(source) {
    const iframes = document.querySelectorAll('iframe[data-app-iframe]');
    for (const iframe of iframes) {
      if (iframe.contentWindow === source) return iframe;
    }
    return null;
  }

  // Resolve the catalog (cached by apps.js on app:models). If absent, request it
  // and wait for the vc:models event once.
  function getCatalog() {
    if (window.appModelCatalog) return Promise.resolve(window.appModelCatalog);
    return new Promise((resolve) => {
      const onModels = (e) => { window.removeEventListener('vc:models', onModels); resolve(e.detail); };
      window.addEventListener('vc:models', onModels);
      sendWs({ type: 'app:models:get' });
    });
  }

  // The media catalog for one kind (app:media:catalog, answered by reqId).
  let mediaSeq = 0;
  function getMediaCatalog(kind) {
    const reqId = `mm-${Date.now().toString(36)}-${++mediaSeq}`;
    return new Promise((resolve) => {
      const onCat = (e) => {
        if (e.detail.reqId !== reqId) return;
        window.removeEventListener('vc:mediaModels', onCat);
        resolve(e.detail);
      };
      window.addEventListener('vc:mediaModels', onCat);
      sendWs({ type: 'app:media:catalog:get', kind, reqId });
    });
  }
  const METHOD_OF_KIND = { speech: 'ai.tts', transcription: 'ai.transcribe', image: 'ai.image', sfx: 'ai.sfx' };

  function respond(iframe, id, model) {
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'app:pickModel:result', id: id, model: model || null }, origin);
    }
  }

  // One tag per reason, straight from the server's `unusableReason`, so a
  // greyed-out row always says why instead of just going quiet.
  const REASON_TAG = {
    retired: '<span class="app-model-picker-tag warn">retired</span>',
    missing: '<span class="app-model-picker-tag warn">gone at provider</span>',
    disabled: '<span class="app-model-picker-tag">disabled</span>',
    'no-credential': '<span class="app-model-picker-tag">no credential</span>',
  };
  const REASON_HINT = {
    retired: 'This model has been retired by its provider',
    missing: 'The provider no longer lists this model',
    disabled: 'Enable this model on the Models page',
    'no-credential': 'Add an API key for this provider on the Models page',
  };

  // One line of what a media model can do, from its capability descriptor.
  function mediaFacts(m) {
    const d = m.params || {};
    const out = [];
    if (m.voices) out.push(`${m.voices.length} voices`);
    if (d.formats) out.push(d.formats.join('/'));
    if (d.speed) out.push(`speed ${d.speed[0]}–${d.speed[1]}`);
    if (d.maxChars) out.push(`≤${d.maxChars.toLocaleString()} chars`);
    if (d.instructions) out.push('style instructions');
    if (d.maxBytes) out.push(`≤${Math.round(d.maxBytes / 1048576)} MB`);
    if (d.diarize) out.push('speakers');
    if (d.aspectRatios) out.push(`${d.aspectRatios.length} ratios`);
    if (d.sizes) out.push(d.sizes.join('/'));
    if (d.edit) out.push('edits');
    return out.join(' · ');
  }

  // opts: { models, defaultName, selected, title, kind, provider,
  //         configuredOnly, refreshedAt, onPick(model | null) }.
  // Text entries are keyed by `name`, media entries by `modelId` (the same
  // string there). The modal is appended to `container`.
  function openPicker(container, opts) {
    const p = opts || {};
    const media = !!p.kind && p.kind !== 'text';
    const keyOf = (m) => (media ? m.modelId : m.name);
    let models = (p.models || []).slice();
    if (p.provider) models = models.filter((m) => m.provider === p.provider);
    // Read the server's decision; never re-derive it. `hasApiKey` here used to
    // hide every Anthropic model on a subscription-authenticated install.
    if (p.configuredOnly) models = models.filter((m) => m.usable);

    const selectedName = p.selected || p.defaultName || '';

    // `models` arrives provider-sorted with a `providerLabel` on each entry (see
    // publicModelShape in app-bridge.js), so grouping follows payload order and
    // this file keeps no provider label map or sort of its own.
    const byProv = new Map();
    for (const m of models) {
      const prov = m.provider || 'custom';
      if (!byProv.has(prov)) byProv.set(prov, { label: m.providerLabel || prov, list: [] });
      byProv.get(prov).list.push(m);
    }

    const overlay = document.createElement('div');
    overlay.className = 'app-model-picker-overlay';

    let listHtml = '';
    for (const [, { label: provLabel, list }] of byProv) {
      listHtml += `<div class="app-model-picker-group">${escHtml(provLabel)}</div>`;
      for (const m of list) {
        const usable = m.usable;
        const tags = [];
        if (m.lifecycle === 'deprecated') tags.push('<span class="app-model-picker-tag warn">deprecated</span>');
        if (!usable && REASON_TAG[m.unusableReason]) tags.push(REASON_TAG[m.unusableReason]);
        if (media && m.shutdownDate) tags.push(`<span class="app-model-picker-tag warn">ends ${escHtml(m.shutdownDate)}</span>`);
        if (media && m.discovered) tags.push('<span class="app-model-picker-tag">newly listed</span>');
        if (media && m.exists === true) tags.push('<span class="app-model-picker-tag ok">listed</span>');
        if (keyOf(m) === p.defaultName) tags.push('<span class="app-model-picker-tag ok">default</span>');
        const cls = ['app-model-picker-item'];
        if (!usable) cls.push('disabled');
        if (keyOf(m) === selectedName) cls.push('selected');
        let cost = '';
        if (media && m.price) cost = `<span class="app-model-picker-cost">${escHtml(m.price)}</span>`;
        else if (m.inputCostPerMTok != null && m.outputCostPerMTok != null) cost = `<span class="app-model-picker-cost">$${m.inputCostPerMTok}/$${m.outputCostPerMTok} per Mtok</span>`;
        const facts = media ? mediaFacts(m) : '';
        const desc = [m.description, facts].filter(Boolean).join(' — ');
        const hint = REASON_HINT[m.unusableReason] || 'Unavailable';
        listHtml += `<button class="${cls.join(' ')}" data-model="${escHtml(keyOf(m))}" ${usable ? '' : `disabled title="${escHtml(hint)}"`}>
          <span class="app-model-picker-name">${escHtml(m.label || keyOf(m))}</span>
          <span class="app-model-picker-meta">${tags.join('')}${cost}</span>
          ${desc ? `<span class="app-model-picker-desc">${escHtml(desc)}</span>` : ''}
        </button>`;
      }
    }
    if (!listHtml) listHtml = '<div class="app-model-picker-empty">No models available.</div>';
    const refreshed = media
      ? `<div class="app-model-picker-desc" style="padding:4px 12px;">${p.refreshedAt ? `Provider lists checked ${escHtml(new Date(p.refreshedAt).toLocaleString())}` : 'Provider lists not checked yet'}</div>`
      : '';

    overlay.innerHTML = `
      <div class="app-model-picker-backdrop"></div>
      <div class="app-model-picker-modal" role="dialog" aria-modal="true">
        <div class="app-model-picker-head">
          <span>${escHtml(p.title || 'Choose a model')}</span>
          <button class="app-model-picker-close" aria-label="Close">&times;</button>
        </div>
        ${refreshed}
        <div class="app-model-picker-list">${listHtml}</div>
      </div>`;

    let settled = false;
    function close(model) {
      if (settled) return;
      settled = true;
      window.removeEventListener('keydown', onKey);
      overlay.remove();
      if (p.onPick) p.onPick(model);
    }
    function onKey(e) { if (e.key === 'Escape') close(null); }

    overlay.querySelector('.app-model-picker-backdrop').addEventListener('click', () => close(null));
    overlay.querySelector('.app-model-picker-close').addEventListener('click', () => close(null));
    overlay.querySelectorAll('.app-model-picker-item:not(.disabled)').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.model;
        close((p.models || []).find((m) => keyOf(m) === name) || null);
      });
    });
    window.addEventListener('keydown', onKey);

    container.appendChild(overlay);
  }
  window.appModelPicker = { open: openPicker, getMediaCatalog, mediaFacts };

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || msg.type !== 'app:pickModel') return;
    const iframe = findAppIframe(e.source);
    if (!iframe) return;
    const wrap = iframe.closest('[data-app-gui]') || iframe.parentElement;
    if (!wrap) { respond(iframe, msg.id, null); return; }
    const params = msg.params || {};
    const kind = params.kind && params.kind !== 'text' ? String(params.kind) : null;
    if (kind && !METHOD_OF_KIND[kind]) { respond(iframe, msg.id, null); return; }
    const load = kind
      ? getMediaCatalog(kind).then((c) => ({ models: c.models || [], defaultName: (c.defaults || {})[METHOD_OF_KIND[kind]]?.model, refreshedAt: c.refreshedAt }))
      : getCatalog().then((c) => ({ models: (c || {}).models || [], defaultName: (c || {}).default }));
    load.then((cat) => openPicker(wrap, {
      ...params, ...cat, kind: kind || 'text',
      onPick: (model) => respond(iframe, msg.id, model),
    }));
  });
})();
