// <vc-empty-state> — placeholder shown when a list/table/grid has no items.
// Part of the vistaclair-pro `vc-*` component system. Shadow-DOM, theme-aware,
// built on vc-core (`Vc.Element`).
//
// Usage:
//   <vc-empty-state icon="🎙️" message="No recordings yet."></vc-empty-state>
//   <vc-empty-state icon="◇">No devices found.<a href="#" slot="action">Scan</a></vc-empty-state>
// Attributes: icon (text/emoji), message. Default slot = body text (overrides
// `message`). Slot "action" = an optional call-to-action row below the message.

(function () {
  'use strict';

  const TEMPLATE = `
    <style>
      :host { display: block; }
      .vc-empty {
        padding: 32px 16px;
        text-align: center;
        color: var(--text-dim, #565f89);
        font-size: 13px;
      }
      .vc-icon { font-size: 28px; line-height: 1; margin-bottom: 10px; opacity: .8; }
      .vc-icon:empty { display: none; }
      .vc-msg { margin: 0; }
      .vc-action { margin-top: 14px; }
      .vc-action:not(:has(*)) { display: none; }
      ::slotted(a) { color: var(--accent, #7aa2f7); }
    </style>
    <div class="vc-empty" part="empty">
      <div class="vc-icon" part="icon"></div>
      <p class="vc-msg" part="message"><slot>${''}</slot></p>
      <div class="vc-action"><slot name="action"></slot></div>
    </div>
  `;

  class VcEmptyState extends Vc.Element {
    static get template() { return TEMPLATE; }
    static get observedAttributes() { return ['icon', 'message']; }

    constructor() {
      super();
      this._icon = this.$('.vc-icon');
      this._slot = this.$('.vc-msg slot'); // fallback text lives here
    }

    connectedCallback() { this._render(); }
    attributeChangedCallback() { if (this._icon) this._render(); }

    _render() {
      this._icon.textContent = this.getAttribute('icon') || '';
      // Slot fallback content renders only when the app slots nothing in — so
      // `message` is a convenient attribute alternative to light-DOM text.
      this._slot.textContent = this.getAttribute('message') || '';
    }

    get message() { return this.getAttribute('message') || ''; }
    set message(v) { this.setAttribute('message', v == null ? '' : String(v)); }
  }

  Vc.define('vc-empty-state', VcEmptyState);
})();
