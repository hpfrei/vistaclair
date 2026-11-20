// === App Overlays (confirm + modal) ===
// Platform-rendered dialogs positioned OVER an app's iframe, following the
// app-model-picker pattern: the app calls Bridge.confirm()/Bridge.modal()
// (app-runtime.js), which postMessages { type:'app:overlay', id, kind, params }
// to this parent window. We render the dialog over the iframe wrap and post
// { type:'app:overlay:result', id, result } back. Pure UI — no server.
//
// XSS safety: everything from the iframe is rendered through escHtml. Modal
// content is a structured schema (text/code/kv/list), never raw HTML — app
// content must not be able to script the dashboard.
(function() {
  'use strict';
  const { escHtml } = window.dashboard;
  const origin = window.location.origin;

  function findAppIframe(source) {
    const iframes = document.querySelectorAll('iframe[data-app-iframe]');
    for (const iframe of iframes) {
      if (iframe.contentWindow === source) return iframe;
    }
    return null;
  }

  function respond(iframe, id, result) {
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'app:overlay:result', id, result }, origin);
    }
  }

  // One overlay per app at a time; later requests queue.
  const queues = new Map(); // appName → [{iframe, id, kind, params}]
  const active = new Set(); // appName
  // Open overlays, keyed `appName:id` (appName prefix prevents cross-app id
  // spoofing — only the owning app's iframe can update/close its overlay).
  const liveOverlays = new Map(); // key → { iframe, update, close }

  function enqueue(appName, item) {
    if (!queues.has(appName)) queues.set(appName, []);
    queues.get(appName).push(item);
    drain(appName);
  }

  function drain(appName) {
    if (active.has(appName)) return;
    const queue = queues.get(appName);
    const item = queue && queue.shift();
    if (!item) return;
    // If the iframe vanished while queued, fail the call and move on.
    if (!item.iframe.isConnected || !item.iframe.contentWindow) { drain(appName); return; }
    const wrap = item.iframe.closest('[data-app-gui]') || item.iframe.parentElement;
    if (!wrap) { respond(item.iframe, item.id, null); drain(appName); return; }
    active.add(appName);
    render(appName, wrap, item);
  }

  function renderContent(content) {
    const blocks = Array.isArray(content) ? content : (content != null ? [content] : []);
    let html = '';
    for (let block of blocks) {
      if (typeof block === 'string') block = { type: 'text', text: block };
      if (!block || typeof block !== 'object') continue;
      switch (block.type) {
        case 'code':
          html += `<pre class="app-overlay-code">${escHtml(String(block.text ?? ''))}</pre>`;
          break;
        case 'kv': {
          const rows = (block.items || []).map((it) =>
            `<div class="app-overlay-kv-row"><span class="app-overlay-kv-key">${escHtml(String(it?.key ?? ''))}</span><span class="app-overlay-kv-value">${escHtml(String(it?.value ?? ''))}</span></div>`).join('');
          html += `<div class="app-overlay-kv">${rows}</div>`;
          break;
        }
        case 'list': {
          const items = (block.items || []).map((it) => `<li>${escHtml(String(it ?? ''))}</li>`).join('');
          html += `<ul class="app-overlay-list">${items}</ul>`;
          break;
        }
        case 'text':
        default:
          html += `<p class="app-overlay-text">${escHtml(String(block.text ?? ''))}</p>`;
      }
    }
    return html;
  }

  const FIELD_TYPES = new Set(['text', 'textarea', 'select', 'checkbox', 'number', 'file']);
  const FILE_MAX_BYTES_DEFAULT = 10 * 1024 * 1024;
  const CHANGE_DEBOUNCE_MS = 250;

  function optionsHtml(options, selectedValue) {
    return (options || []).map((o) => {
      const opt = (o && typeof o === 'object') ? o : { value: o, label: o };
      const ov = escHtml(String(opt.value ?? ''));
      const ol = escHtml(String(opt.label ?? opt.value ?? ''));
      const sel = String(opt.value) === String(selectedValue ?? '') ? ' selected' : '';
      return `<option value="${ov}"${sel}>${ol}</option>`;
    }).join('');
  }

  function renderFields(fields) {
    let html = '';
    for (const f of fields || []) {
      if (!f || !f.name) continue;
      const type = FIELD_TYPES.has(f.type) ? f.type : 'text';
      const name = escHtml(String(f.name));
      const label = f.label != null ? escHtml(String(f.label)) : name;
      const value = f.value != null ? escHtml(String(f.value)) : '';
      const placeholder = f.placeholder != null ? ` placeholder="${escHtml(String(f.placeholder))}"` : '';
      const required = f.required ? ' required' : '';
      let input;
      if (type === 'textarea') {
        const rows = Math.max(2, Math.min(20, Number(f.rows) || 4));
        input = `<textarea class="form-input" data-field="${name}" rows="${rows}"${placeholder}${required}>${value}</textarea>`;
      } else if (type === 'select') {
        input = `<select class="form-input" data-field="${name}"${required}>${optionsHtml(f.options, f.value)}</select>`;
      } else if (type === 'checkbox') {
        const checked = f.value ? ' checked' : '';
        input = `<label class="app-overlay-check"><input type="checkbox" data-field="${name}"${checked}> ${label}</label>`;
        html += `<div class="app-overlay-field">${input}<span class="app-overlay-hint" data-hint-for="${name}"></span></div>`;
        continue;
      } else if (type === 'file') {
        const accept = f.accept != null ? ` accept="${escHtml(String(f.accept))}"` : '';
        input = `<div class="app-overlay-drop" data-field="${name}" data-empty="true" tabindex="0" role="button"${required}>
          <input type="file" hidden${accept}>
          <span class="app-overlay-drop-icon">&#8682;</span>
          <span class="app-overlay-drop-label">Drop a file here, paste, or <u>browse</u></span>
          <div class="app-overlay-drop-preview" hidden></div>
          <span class="app-overlay-drop-file"></span>
        </div>`;
      } else {
        input = `<input class="form-input" type="${type}" data-field="${name}" value="${value}"${placeholder}${required}>`;
      }
      html += `<div class="app-overlay-field"><label class="form-label">${label}</label>${input}<span class="app-overlay-hint" data-hint-for="${name}"></span></div>`;
    }
    return html;
  }

  // Does a File match an accept string ('image/*', '.png', 'audio/mpeg', ...)?
  // The native picker enforces accept; drop and paste go through this instead.
  function matchesAccept(file, accept) {
    if (!accept) return true;
    const type = (file.type || '').toLowerCase();
    const name = (file.name || '').toLowerCase();
    return String(accept).split(',').some((tok) => {
      tok = tok.trim().toLowerCase();
      if (!tok) return false;
      if (tok.startsWith('.')) return name.endsWith(tok);
      if (tok.endsWith('/*')) return type.startsWith(tok.slice(0, -1));
      return type === tok;
    });
  }

  function renderPreview(preview, value) {
    const kind = String(value.mimeType || '').split('/')[0];
    if (kind === 'image') preview.innerHTML = `<img src="${escHtml(value.data)}" alt="">`;
    else if (kind === 'video') preview.innerHTML = `<video src="${escHtml(value.data)}" muted preload="metadata"></video>`;
    else if (kind === 'audio') preview.innerHTML = `<span class="app-overlay-drop-preview-icon">&#9835;</span>`;
    else { preview.hidden = true; preview.innerHTML = ''; return; }
    preview.hidden = false;
  }

  // Click a preview thumbnail → full-size media in a lightbox over everything.
  function openLightbox(value) {
    const kind = String(value.mimeType || '').split('/')[0];
    let media = '';
    if (kind === 'image') media = `<img src="${escHtml(value.data)}" alt="">`;
    else if (kind === 'video') media = `<video src="${escHtml(value.data)}" controls></video>`;
    else if (kind === 'audio') media = `<audio src="${escHtml(value.data)}" controls></audio>`;
    else return;
    const lb = document.createElement('div');
    lb.className = 'app-overlay-lightbox';
    lb.innerHTML = `
      <div class="app-overlay-lightbox-backdrop"></div>
      <button class="app-overlay-lightbox-close" aria-label="Close">&times;</button>
      <div class="app-overlay-lightbox-body">${media}<div class="app-overlay-lightbox-name">${escHtml(String(value.name || ''))}</div></div>`;
    // Capture-phase Escape so the modal's own Escape handler doesn't also fire.
    function onKey(e) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeLb();
    }
    function closeLb() {
      window.removeEventListener('keydown', onKey, true);
      lb.remove();
    }
    lb.querySelector('.app-overlay-lightbox-backdrop').addEventListener('click', closeLb);
    lb.querySelector('.app-overlay-lightbox-close').addEventListener('click', closeLb);
    window.addEventListener('keydown', onKey, true);
    document.body.appendChild(lb);
  }

  // File fields read the file eagerly on select/drop/paste and cache the result
  // on the drop element, so collectValues stays synchronous. Value shape:
  // { name, mimeType, size, data } where data is a base64 data-URL — feed it
  // straight to ctx.files.saveBase64 server-side.
  function wireFileFields(root, fields, emitChange) {
    for (const f of fields || []) {
      if (!f || f.type !== 'file' || !f.name) continue;
      const drop = root.querySelector(`.app-overlay-drop[data-field="${CSS.escape(String(f.name))}"]`);
      if (!drop) continue;
      const input = drop.querySelector('input[type="file"]');
      const fileLabel = drop.querySelector('.app-overlay-drop-file');
      const preview = drop.querySelector('.app-overlay-drop-preview');
      const maxBytes = Number(f.maxBytes) > 0 ? Number(f.maxBytes) : FILE_MAX_BYTES_DEFAULT;

      function fail(msg) {
        drop._fileValue = null;
        drop.dataset.empty = 'true';
        preview.hidden = true;
        preview.innerHTML = '';
        fileLabel.textContent = msg;
        drop.classList.add('app-overlay-drop-error');
      }

      function setFile(file) {
        if (!file) return;
        if (!matchesAccept(file, f.accept)) { fail('Not an accepted file type'); return; }
        if (file.size > maxBytes) { fail(`Too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`); return; }
        const reader = new FileReader();
        reader.onload = () => {
          drop._fileValue = { name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, data: reader.result };
          drop.dataset.empty = 'false';
          drop.classList.remove('app-overlay-drop-error');
          fileLabel.textContent = `${file.name} (${file.size < 1024 * 1024 ? Math.max(1, Math.round(file.size / 1024)) + ' KB' : (file.size / 1024 / 1024).toFixed(1) + ' MB'})`;
          renderPreview(preview, drop._fileValue);
          if (emitChange) emitChange(f.name, true);
        };
        reader.readAsDataURL(file);
      }
      drop._setFile = setFile;
      drop._accept = f.accept;

      drop.addEventListener('click', () => input.click());
      drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
      input.addEventListener('change', () => setFile(input.files && input.files[0]));
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('app-overlay-drop-over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('app-overlay-drop-over'));
      drop.addEventListener('drop', (e) => {
        e.preventDefault();
        drop.classList.remove('app-overlay-drop-over');
        setFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
      });
      preview.addEventListener('click', (e) => {
        e.stopPropagation();
        if (drop._fileValue) openLightbox(drop._fileValue);
      });
    }
  }

  // Field-change reporting: text-ish fields debounce while the user types;
  // selects/checkboxes report immediately. File fields report from wireFileFields
  // once the file is read (so the reported values include the file).
  function wireChangeEvents(root, fields, emitChange) {
    for (const f of fields || []) {
      if (!f || !f.name || f.type === 'file') continue;
      const el = root.querySelector(`[data-field="${CSS.escape(String(f.name))}"]`);
      if (!el) continue;
      if (f.type === 'select' || f.type === 'checkbox') {
        el.addEventListener('change', () => emitChange(f.name, true));
      } else {
        el.addEventListener('input', () => emitChange(f.name, false));
        el.addEventListener('change', () => emitChange(f.name, true));
      }
    }
  }

  function collectValues(root, fields) {
    const values = {};
    for (const f of fields || []) {
      if (!f || !f.name) continue;
      const el = root.querySelector(`[data-field="${CSS.escape(String(f.name))}"]`);
      if (!el) continue;
      if (f.type === 'checkbox') values[f.name] = el.checked;
      else if (f.type === 'number') values[f.name] = el.value === '' ? null : Number(el.value);
      else if (f.type === 'file') values[f.name] = el._fileValue || null;
      else values[f.name] = el.value;
    }
    return values;
  }

  // "my-blog" → "My Blog" — shown as the dialog's app badge so users always
  // know which app a platform-rendered dialog belongs to.
  function appLabel(appName) {
    return String(appName).replace(/[-_]+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function buttonsHtml(buttons) {
    return buttons.map((b) => {
      if (!b || b.id == null) return '';
      const cls = ['btn'];
      if (b.primary) cls.push('btn-primary');
      if (b.danger) cls.push('btn-danger');
      return `<button class="${cls.join(' ')}" data-button="${escHtml(String(b.id))}">${escHtml(String(b.label ?? b.id))}</button>`;
    }).join('');
  }

  function render(appName, wrap, item) {
    const { iframe, id, kind } = item;
    const p = item.params || {};
    const isConfirm = kind === 'confirm';

    let buttons = isConfirm
      ? [
          { id: 'cancel', label: p.cancelLabel || 'Cancel' },
          { id: 'confirm', label: p.confirmLabel || 'Confirm', primary: !p.danger, danger: !!p.danger },
        ]
      : (Array.isArray(p.buttons) && p.buttons.length
          ? p.buttons
          : [{ id: 'ok', label: 'OK', primary: true }]);

    const title = p.title != null ? escHtml(String(p.title)) : (isConfirm ? 'Confirm' : '');
    // Content lives in its own container so update() can re-render it
    // without touching the fields (preserving anything the user typed).
    const bodyHtml = isConfirm
      ? `<p class="app-overlay-text">${escHtml(String(p.message ?? ''))}</p>`
      : `<div class="app-overlay-content">${renderContent(p.content)}</div>` +
        (p.fields ? `<div class="app-overlay-fields">${renderFields(p.fields)}</div>` : '');

    const overlay = document.createElement('div');
    overlay.className = 'app-overlay';
    overlay.innerHTML = `
      <div class="app-overlay-backdrop"></div>
      <div class="app-overlay-modal" role="dialog" aria-modal="true"${p.width ? ` style="width:min(92%,${Math.max(280, Math.min(900, Number(p.width) || 460))}px)"` : ''}>
        <div class="app-overlay-head">
          <div class="app-overlay-titles">
            <span class="app-overlay-app">${escHtml(appLabel(appName))}</span>
            <span class="app-overlay-title">${title}</span>
          </div>
          <button class="app-overlay-close" aria-label="Close">&times;</button>
        </div>
        <div class="app-overlay-body">${bodyHtml}</div>
        <div class="app-overlay-foot">${buttonsHtml(buttons)}</div>
      </div>`;

    const liveKey = `${appName}:${id}`;
    let settled = false;
    let changeTimer = null;
    function close(result) {
      if (settled) return;
      settled = true;
      if (changeTimer) clearTimeout(changeTimer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('paste', onPaste);
      overlay.remove();
      liveOverlays.delete(liveKey);
      respond(iframe, id, result);
      active.delete(appName);
      drain(appName);
    }

    // Posts {type:'app:overlay:change', id, field, values} to the app's iframe.
    // Typing is debounced; selects/checkboxes/files fire immediately (an
    // immediate event also flushes any pending debounced one).
    function emitChange(fieldName, immediate) {
      if (changeTimer) { clearTimeout(changeTimer); changeTimer = null; }
      const send = () => {
        if (settled || !iframe.contentWindow) return;
        const modal = overlay.querySelector('.app-overlay-modal');
        iframe.contentWindow.postMessage({ type: 'app:overlay:change', id, field: fieldName, values: collectValues(modal, p.fields) }, origin);
      };
      if (immediate) send();
      else changeTimer = setTimeout(() => { changeTimer = null; send(); }, CHANGE_DEBOUNCE_MS);
    }
    const dismissResult = isConfirm ? false : null;
    function onKey(e) { if (e.key === 'Escape') close(dismissResult); }

    // Clipboard paste → file field. Routes to the focused drop zone, or the
    // first one whose accept matches. Text pastes into inputs are untouched.
    function onPaste(e) {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      let file = null;
      for (const it of items) {
        if (it.kind === 'file') { file = it.getAsFile(); if (file) break; }
      }
      if (!file) return;
      const ae = document.activeElement;
      const inTextField = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && !ae.hidden;
      if (inTextField && e.clipboardData.getData('text/plain')) return;
      const drops = [...overlay.querySelectorAll('.app-overlay-drop')];
      if (!drops.length) return;
      const target = drops.find((d) => d === ae) || drops.find((d) => matchesAccept(file, d._accept));
      if (!target || !target._setFile) return;
      e.preventDefault();
      target._setFile(file);
    }

    function onButtonClick(btn) {
      const buttonId = btn.dataset.button;
      if (isConfirm) { close(buttonId === 'confirm'); return; }
      const modal = overlay.querySelector('.app-overlay-modal');
      for (const el of modal.querySelectorAll('[data-field][required]')) {
        const empty = el.classList.contains('app-overlay-drop') ? !el._fileValue : !el.value;
        if (empty) { el.focus(); return; }
      }
      const def = buttons.find((b) => b && String(b.id) === buttonId);
      const values = collectValues(modal, p.fields);
      if (def && def.keepOpen) {
        // Report the click to the app without closing — the app reacts via
        // its handle's onButton callback (and may update() / close() later).
        if (iframe.contentWindow) {
          iframe.contentWindow.postMessage({ type: 'app:overlay:button', id, button: buttonId, values }, origin);
        }
        return;
      }
      close({ button: buttonId, values });
    }

    function bindButtons() {
      overlay.querySelectorAll('.app-overlay-foot [data-button]').forEach((btn) => {
        btn.addEventListener('click', () => onButtonClick(btn));
      });
    }

    function update(params) {
      if (settled || !params || typeof params !== 'object') return;
      if (params.title !== undefined) {
        overlay.querySelector('.app-overlay-title').textContent = String(params.title ?? '');
      }
      if (!isConfirm && params.content !== undefined) {
        const contentEl = overlay.querySelector('.app-overlay-content');
        if (contentEl) contentEl.innerHTML = renderContent(params.content);
      }
      if (!isConfirm && Array.isArray(params.buttons) && params.buttons.length) {
        buttons = params.buttons;
        overlay.querySelector('.app-overlay-foot').innerHTML = buttonsHtml(buttons);
        bindButtons();
      }
      // hints: { fieldName: null | 'message' | {text, kind:'error'|'ok'|'info'} }
      // Inline per-field feedback — the one piece of a field's row update() may touch.
      if (!isConfirm && params.hints && typeof params.hints === 'object') {
        for (const [name, hint] of Object.entries(params.hints)) {
          const hintEl = overlay.querySelector(`.app-overlay-hint[data-hint-for="${CSS.escape(String(name))}"]`);
          if (!hintEl) continue;
          const h = (hint && typeof hint === 'object') ? hint : { text: hint };
          hintEl.textContent = h.text != null ? String(h.text) : '';
          hintEl.dataset.kind = h.text != null ? (h.kind === 'ok' || h.kind === 'error' ? h.kind : 'info') : '';
          const fieldEl = overlay.querySelector(`[data-field="${CSS.escape(String(name))}"]`);
          if (fieldEl) fieldEl.classList.toggle('app-overlay-field-error', h.text != null && h.kind === 'error');
        }
      }
      // fieldOptions: { selectName: [options] } — replaces a select's option
      // list (dependent dropdowns). The one exception to "fields never update":
      // swapping options doesn't clobber typed input. Keeps the current value
      // if it's still present.
      if (!isConfirm && params.fieldOptions && typeof params.fieldOptions === 'object') {
        for (const [name, options] of Object.entries(params.fieldOptions)) {
          if (!Array.isArray(options)) continue;
          const sel = overlay.querySelector(`select[data-field="${CSS.escape(String(name))}"]`);
          if (sel) sel.innerHTML = optionsHtml(options, sel.value);
        }
      }
    }

    overlay.querySelector('.app-overlay-backdrop').addEventListener('click', () => close(dismissResult));
    overlay.querySelector('.app-overlay-close').addEventListener('click', () => close(dismissResult));
    bindButtons();
    window.addEventListener('keydown', onKey);

    liveOverlays.set(liveKey, { iframe, update, close });
    wrap.appendChild(overlay);
    if (!isConfirm) {
      const modal = overlay.querySelector('.app-overlay-modal');
      wireFileFields(modal, p.fields, emitChange);
      wireChangeEvents(modal, p.fields, emitChange);
      if ((p.fields || []).some((f) => f && f.type === 'file')) {
        window.addEventListener('paste', onPaste);
      }
    }
    const firstField = overlay.querySelector('[data-field]');
    if (firstField) firstField.focus();
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || !msg.id) return;

    if (msg.type === 'app:overlay') {
      if (msg.kind !== 'confirm' && msg.kind !== 'modal') return;
      const iframe = findAppIframe(e.source);
      if (!iframe) return;
      const appName = iframe.dataset.appIframe;
      enqueue(appName, { iframe, id: msg.id, kind: msg.kind, params: msg.params || {} });
      return;
    }

    if (msg.type === 'app:overlay:update' || msg.type === 'app:overlay:close') {
      const iframe = findAppIframe(e.source);
      if (!iframe) return;
      const appName = iframe.dataset.appIframe;
      const live = liveOverlays.get(`${appName}:${msg.id}`);
      if (live && live.iframe === iframe) {
        if (msg.type === 'app:overlay:update') live.update(msg.params || {});
        else live.close(msg.result !== undefined ? msg.result : null);
        return;
      }
      // close() on a modal still waiting in the queue: drop it and resolve.
      if (msg.type === 'app:overlay:close') {
        const queue = queues.get(appName) || [];
        const idx = queue.findIndex((q) => q.id === msg.id && q.iframe === iframe);
        if (idx !== -1) {
          queue.splice(idx, 1);
          respond(iframe, msg.id, msg.result !== undefined ? msg.result : null);
        }
      }
    }
  });
})();
