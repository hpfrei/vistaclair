// <vc-progress> — determinate/indeterminate progress for long-running jobs.
// Part of the vistaclair-pro `vc-*` component system. Shadow-DOM, theme-aware,
// built on vc-core (`Vc.Element`).
//
// Usage:
//   <vc-progress value="40" label="Rendering 4/10"></vc-progress>   // 40%
//   <vc-progress indeterminate label="Thinking…"></vc-progress>     // marquee
//   el.value = 70;            // updates fill + transitions
//   el.label = 'Almost done'; // updates caption
//   el.indeterminate = true;  // marquee mode (value ignored)
// Attributes: value (0-100), label, indeterminate, hide-when-idle.
// With `hide-when-idle`, the element hides itself when value is 0/absent and
// not indeterminate — drop it into a layout and just drive `value`.

(function () {
  'use strict';

  const TEMPLATE = `
    <style>
      :host { display: block; }
      .vc-bar {
        position: relative;
        height: 8px;
        border-radius: 999px;
        background: var(--bg-surface, #24283b);
        border: 1px solid var(--border, #414868);
        overflow: hidden;
      }
      .vc-fill {
        height: 100%;
        border-radius: 999px;
        background: var(--accent, #7aa2f7);
        width: 0;
        transition: width .3s ease;
      }
      :host([indeterminate]) .vc-fill {
        width: 40% !important;
        transition: none;
        animation: vc-prog-march 1.1s ease-in-out infinite;
      }
      @keyframes vc-prog-march {
        0% { transform: translateX(-120%); }
        100% { transform: translateX(320%); }
      }
      .vc-label {
        font-size: 11px;
        color: var(--text-dim, #565f89);
        margin-top: 4px;
      }
      .vc-label:empty { display: none; }
      @media (prefers-reduced-motion: reduce) {
        :host([indeterminate]) .vc-fill { animation-duration: 2.4s; }
      }
    </style>
    <div class="vc-bar" part="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100">
      <div class="vc-fill" part="fill"></div>
    </div>
    <div class="vc-label" part="label"></div>
  `;

  class VcProgress extends Vc.Element {
    static get template() { return TEMPLATE; }
    static get observedAttributes() { return ['value', 'label', 'indeterminate', 'hide-when-idle']; }

    constructor() {
      super();
      this._bar = this.$('.vc-bar');
      this._fill = this.$('.vc-fill');
      this._labelEl = this.$('.vc-label');
    }

    connectedCallback() { this._render(); }
    attributeChangedCallback() { if (this._fill) this._render(); }

    _clampValue() {
      const raw = this.getAttribute('value');
      if (raw == null || raw === '') return 0;
      return Vc.clamp(raw, 0, 100);
    }

    _render() {
      const indet = this.hasAttribute('indeterminate');
      const v = this._clampValue();
      this._labelEl.textContent = this.getAttribute('label') || '';
      if (indet) {
        this._bar.removeAttribute('aria-valuenow');
        this.hidden = false;
      } else {
        this._fill.style.width = v + '%';
        this._bar.setAttribute('aria-valuenow', String(v));
        if (this.hasAttribute('hide-when-idle')) this.hidden = v <= 0;
        else this.hidden = false;
      }
    }

    get value() { return this._clampValue(); }
    set value(v) { this.setAttribute('value', String(v == null ? 0 : v)); }

    get label() { return this.getAttribute('label') || ''; }
    set label(v) { this.reflectAttr('label', v); }

    get indeterminate() { return this.hasAttribute('indeterminate'); }
    set indeterminate(v) { this.reflectBool('indeterminate', !!v); }
  }

  Vc.define('vc-progress', VcProgress);
})();
