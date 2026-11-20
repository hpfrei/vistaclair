// <vc-dialog> — modal dialog rendered INSIDE the app's iframe, built on vc-core
// (`Vc.Element`). Shadow-DOM, theme-aware, styled to match the platform's
// host-rendered overlays so the two are visually one family.
//
// Why this exists: `showModal()` is rendered by the dashboard OUTSIDE the iframe,
// so it can host only its own field types — never a `<vc-model-picker>`, a
// `<vc-input-bar>` mic, a `<vc-media-viewer>`, or any app markup. Apps that needed
// those in a dialog had to hand-roll a whole panel. `<vc-dialog>` is the answer:
// anything you can put in your page, you can put in this dialog.
//
// Which one to use:
//   • simple structured form (text/select/checkbox/file) ....... showModal()
//   • needs a vc-* component, voice input, or custom markup .... <vc-dialog>
//   • must cover the dashboard, not just the app panel ......... showModal()
//   • toast / confirm / full-screen model chooser .............. showToast/showConfirm/pickModel
//
// Usage:
//   <vc-dialog id="extend" heading="➕ Extend episode" submit-label="Extend" keep-open>
//     <p>Adds conversation that picks up where the episode leaves off.</p>
//     <vc-model-picker configured-only persist-key="scriptModel"></vc-model-picker>
//     <vc-input-bar id="instr" rows="3"></vc-input-bar>
//   </vc-dialog>
//
//   const result = await dlg.show();        // null when dismissed
//   dlg.addEventListener('submit', async () => {
//     dlg.busy = true;                      // disables the footer, spins the primary
//     try { await save(); dlg.close({ ok: true }); }
//     catch (e) { showToast(e.message, 'error'); dlg.busy = false; }
//   });
//
// Attributes: heading (the title — NOT `title`, which is the native tooltip),
//   submit-label (primary button text; ABSENT = no footer at all), cancel-label
//   (default "Cancel"), danger (red primary), width (px, clamped 280–900),
//   keep-open (submit fires the event but leaves the dialog open — you call
//   close()), open (reflected; presence = visible).
// Properties: open (boolean state), busy (get/set).
// Methods: show() → Promise<result|null>, close(result?). Mirrors native <dialog>.
// Events: submit (primary pressed), cancel (dismissed via ×/Escape/backdrop/Cancel).
// Slots: default = dialog body. `footer` = replace the whole button row.
//
// Platform UI rules this enforces structurally (see the API reference): the single
// closer is the top-right ×, and a dialog with no real decision to make renders NO
// footer button row — omit `submit-label` and you get exactly that.
//
// Scope note: being in-iframe, it covers the app panel, not the dashboard chrome.
// That is the deliberate trade for being able to host components.
//
// Placement: put the element at the top level of your page, NOT inside a view or
// container you toggle with `hidden`/`display:none` — a hidden ancestor suppresses
// it even though the dialog itself renders `position: fixed`.

(function () {
  'use strict';

  // Only the most recently opened dialog reacts to Escape.
  const stack = [];

  const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
    // vc-* components aren't natively focusable but expose focus()
    'vc-input-bar', 'vc-model-picker', 'vc-markdown', 'vc-media-viewer',
  ].join(',');

  const TEMPLATE = `
    <style>
      :host {
        position: fixed; inset: 0; z-index: 60;
        display: none;
        align-items: center; justify-content: center;
      }
      :host([open]) { display: flex; }

      .backdrop {
        position: absolute; inset: 0;
        background: rgba(8, 10, 18, 0.55);
        backdrop-filter: blur(6px) saturate(0.85);
        -webkit-backdrop-filter: blur(6px) saturate(0.85);
        animation: vcDlgFade .18s ease-out;
      }
      @keyframes vcDlgFade { from { opacity: 0; } }

      .modal {
        position: relative;
        background: linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0) 56px), var(--bg-surface, #24283b);
        border: 1px solid rgba(255,255,255,0.09);
        border-radius: 16px;
        width: min(92%, var(--vc-dialog-width, 460px));
        max-height: 86%;
        display: flex; flex-direction: column;
        overflow: hidden;
        box-shadow:
          0 1px 0 rgba(255,255,255,0.06) inset,
          0 12px 28px rgba(0,0,0,0.42),
          0 32px 80px rgba(0,0,0,0.5);
        animation: vcDlgPop .22s cubic-bezier(0.2, 1.1, 0.3, 1);
      }
      @keyframes vcDlgPop { from { opacity: 0; transform: translateY(10px) scale(0.97); } }
      @media (prefers-reduced-motion: reduce) {
        .backdrop, .modal { animation: none; }
      }

      .head {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px;
        padding: 14px 18px 12px;
      }
      .title {
        font-weight: 650; font-size: 15.5px;
        letter-spacing: -0.01em;
        color: var(--text-bright, var(--text, #c0caf5));
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        min-width: 0;
      }
      .title:empty { display: none; }
      .close {
        background: rgba(255,255,255,0.05);
        border: none;
        width: 28px; height: 28px;
        border-radius: 8px;
        font-size: 17px; line-height: 1;
        color: var(--text-dim, #565f89); cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
        transition: background .15s, color .15s;
      }
      .close:hover { background: rgba(255,255,255,0.1); color: var(--text, #c0caf5); }

      .body {
        padding: 6px 18px 16px;
        overflow-y: auto; flex: 1;
        font-size: 13px;
        color: var(--text, #c0caf5);
        display: flex; flex-direction: column; gap: 12px;
      }

      .foot {
        display: flex; justify-content: flex-end; align-items: center; gap: 8px;
        padding: 13px 18px;
        background: rgba(0,0,0,0.16);
        border-top: 1px solid rgba(255,255,255,0.05);
      }
      /* No decision to make => no button row (platform UI rule). */
      .foot[hidden] { display: none; }

      button.btn {
        padding: 6px 14px;
        border: 1px solid var(--border, #414868);
        border-radius: var(--radius, 6px);
        background: var(--bg-surface, #24283b);
        color: var(--text, #c0caf5);
        font: inherit; font-size: 12px;
        cursor: pointer;
        display: inline-flex; align-items: center; gap: 7px;
        transition: background .15s, border-color .15s;
      }
      button.btn:hover:not(:disabled) { background: var(--bg-hover, #2f334d); }
      button.btn:disabled { opacity: .5; cursor: not-allowed; }
      button.primary {
        background: var(--accent, #7aa2f7);
        border-color: var(--accent, #7aa2f7);
        color: var(--bg, #1a1b26);
        font-weight: 600;
      }
      button.primary:hover:not(:disabled) { background: var(--accent, #7aa2f7); filter: brightness(1.15); }
      :host([danger]) button.primary {
        background: var(--red, #f7768e);
        border-color: var(--red, #f7768e);
      }
      .vc-spin { display: none; }
      :host([busy]) .vc-spin { display: block; }
    </style>
    <div class="backdrop" part="backdrop"></div>
    <div class="modal" part="modal" role="dialog" aria-modal="true">
      <div class="head" part="head">
        <span class="title" part="title"></span>
        <button class="close" part="close" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="body" part="body"><slot></slot></div>
      <div class="foot" part="foot">
        <slot name="footer">
          <button class="btn cancel" part="button cancel" type="button"></button>
          <button class="btn primary submit" part="button submit" type="button">
            <span class="vc-spin"></span><span class="submit-label"></span>
          </button>
        </slot>
      </div>
    </div>
  `;

  class VcDialog extends Vc.Element {
    static get template() { return TEMPLATE; }
    static get observedAttributes() {
      return ['heading', 'submit-label', 'cancel-label', 'width', 'open'];
    }

    constructor() {
      super();
      this._result = null;
      this._resolve = null;
      this._promise = null;
      this._returnFocus = null;

      this.$('.close').addEventListener('click', () => this._dismiss());
      this.$('.backdrop').addEventListener('click', () => this._dismiss());
      this.$('.cancel').addEventListener('click', () => this._dismiss());
      this.$('.submit').addEventListener('click', () => this._submit());

      this._onKeyDown = (e) => {
        if (!this.hasAttribute('open')) return;
        if (e.key === 'Escape') {
          if (stack[stack.length - 1] !== this) return;   // only the topmost
          e.preventDefault();
          this._dismiss();
        } else if (e.key === 'Tab') {
          this._trapTab(e);
        }
      };
      this._syncChrome();
    }

    connectedCallback() { this._syncChrome(); }

    disconnectedCallback() {
      // A dialog removed from the DOM while open must not leave a pending promise
      // or a stale document listener behind.
      if (this.hasAttribute('open')) this._onClosed();
    }

    attributeChangedCallback(name, oldVal, newVal) {
      if (!this.shadowRoot) return;
      if (name === 'open') {
        if (newVal !== null && oldVal === null) this._onOpened();
        else if (newVal === null && oldVal !== null) this._onClosed();
        return;
      }
      this._syncChrome();
    }

    // --- public API ---
    // Mirrors native <dialog>: `open` is the boolean state, show()/close() drive it.
    get open() { return this.hasAttribute('open'); }
    set open(on) { if (on) this.show(); else this.close(null); }

    get busy() { return this.hasAttribute('busy'); }
    set busy(on) {
      this.reflectBool('busy', !!on);
      const submit = this.$('.submit');
      const cancel = this.$('.cancel');
      if (submit) submit.disabled = !!on;
      if (cancel) cancel.disabled = !!on;
    }

    // Show the dialog. Resolves with the close() result, or null if dismissed.
    show() {
      if (this.hasAttribute('open')) return this._promise || Promise.resolve(null);
      this._result = null;
      this._promise = new Promise((resolve) => { this._resolve = resolve; });
      this.setAttribute('open', '');
      return this._promise;
    }

    close(result) {
      if (!this.hasAttribute('open')) return;
      this._result = result === undefined ? null : result;
      this.removeAttribute('open');
    }

    // --- internals ---
    _syncChrome() {
      const title = this.$('.title');
      if (title) title.textContent = this.getAttribute('heading') || '';

      const submitLabel = this.getAttribute('submit-label');
      const labelEl = this.$('.submit-label');
      if (labelEl) labelEl.textContent = submitLabel || '';
      const cancelEl = this.$('.cancel');
      if (cancelEl) cancelEl.textContent = this.getAttribute('cancel-label') || 'Cancel';

      // Platform rule: a dialog offering no real decision renders no footer.
      // A `footer` slot always counts as a decision.
      const foot = this.$('.foot');
      if (foot) {
        const hasCustomFooter = !!this.querySelector('[slot="footer"]');
        foot.hidden = !submitLabel && !hasCustomFooter;
      }

      const w = Number(this.getAttribute('width'));
      const modal = this.$('.modal');
      if (modal) {
        modal.style.setProperty('--vc-dialog-width',
          isFinite(w) && w > 0 ? Vc.clamp(w, 280, 900) + 'px' : '460px');
      }

      const heading = this.getAttribute('heading');
      const dlg = this.$('.modal');
      if (dlg) {
        if (heading) dlg.setAttribute('aria-label', heading);
        else dlg.removeAttribute('aria-label');
      }
    }

    _onOpened() {
      this._syncChrome();
      this.busy = false;
      stack.push(this);
      this._returnFocus = document.activeElement;
      document.addEventListener('keydown', this._onKeyDown, true);
      // Let slotted children upgrade before focusing.
      requestAnimationFrame(() => {
        if (!this.hasAttribute('open')) return;
        const target = this.querySelector('[autofocus]') || this._focusables()[0];
        if (target && typeof target.focus === 'function') {
          try { target.focus(); } catch (_) { /* non-focusable custom element */ }
        }
      });
    }

    _onClosed() {
      const i = stack.indexOf(this);
      if (i > -1) stack.splice(i, 1);
      document.removeEventListener('keydown', this._onKeyDown, true);
      this.busy = false;
      const resolve = this._resolve;
      const result = this._result;
      this._resolve = null;
      this._promise = null;
      if (this._returnFocus && typeof this._returnFocus.focus === 'function') {
        try { this._returnFocus.focus(); } catch (_) { /* gone from the DOM */ }
      }
      this._returnFocus = null;
      if (resolve) resolve(result);
    }

    _dismiss() {
      if (this.busy) return;   // don't abandon an in-flight submit
      this.emit('cancel', {});
      this.close(null);
    }

    _submit() {
      if (this.busy) return;
      this.emit('submit', { button: 'submit' });
      // keep-open hands control to the app: it calls close() when its work is done.
      if (!this.hasAttribute('keep-open')) this.close({ button: 'submit' });
    }

    // Tab order: close button → dialog body (light DOM) → footer buttons.
    _focusables() {
      const light = Array.from(this.querySelectorAll(FOCUSABLE)).filter((el) =>
        !el.hasAttribute('hidden') && !el.hasAttribute('disabled') &&
        typeof el.focus === 'function' && el.offsetParent !== null);
      const foot = this.$('.foot');
      const footBtns = foot && !foot.hidden
        ? Array.from(foot.querySelectorAll('button:not([disabled])')) : [];
      return [this.$('.close'), ...light, ...footBtns].filter(Boolean);
    }

    _trapTab(e) {
      const items = this._focusables();
      if (items.length < 2) return;
      const active = this.shadowRoot.activeElement || document.activeElement;
      let i = items.indexOf(active);
      if (i === -1) i = items.findIndex((el) => el.contains && el.contains(active));
      if (i === -1) { e.preventDefault(); items[0].focus(); return; }
      const next = e.shiftKey
        ? (i - 1 + items.length) % items.length
        : (i + 1) % items.length;
      e.preventDefault();
      try { items[next].focus(); } catch (_) { /* ignore */ }
    }
  }

  Vc.define('vc-dialog', VcDialog);
})();
