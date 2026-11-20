// <vc-chat-log> — scrolling message thread (user / AI bubbles) with auto-scroll
// and a busy "Thinking…" indicator. Part of the vistaclair `vc-*` system.
// Shadow-DOM, theme-aware, built on vc-core (`Vc.Element`). Pairs naturally
// with <vc-input-bar>.
//
// Usage:
//   <vc-chat-log busy-label="Thinking…"></vc-chat-log>
//   log.append({ role: 'user', text: 'hi' });          // text is escaped
//   log.append({ role: 'ai', html: renderedMarkdown }); // html is trusted as-is
//   log.busy = true;   // shows a spinner bubble at the end
//   log.messages = [...]; // replace the whole thread (reload-resilient restore)
//
// Message shape: { role: 'user'|'ai'|'assistant', text?, html? }. Provide `text`
// for untrusted/plain content (auto-escaped) or `html` for already-sanitized
// markup (e.g. parseAIResponse + your own renderer). `assistant` aliases `ai`.
// Auto-scrolls to the newest message unless the user has scrolled up to read.

(function () {
  'use strict';
  const TEMPLATE = `
    <style>
      :host { display: block; }
      .vc-log {
        height: 100%;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 4px;
        scroll-behavior: smooth;
      }
      .vc-bubble {
        max-width: 82%;
        padding: 8px 12px;
        border-radius: 12px;
        font-size: 13px;
        line-height: 1.5;
        white-space: pre-wrap;
        word-wrap: break-word;
        overflow-wrap: anywhere;
      }
      .vc-bubble.user {
        align-self: flex-end;
        background: var(--accent, #7aa2f7);
        color: #fff;
        border-bottom-right-radius: 4px;
      }
      .vc-bubble.ai {
        align-self: flex-start;
        background: var(--bg-surface, #24283b);
        color: var(--text, #c0caf5);
        border: 1px solid var(--border, #414868);
        border-bottom-left-radius: 4px;
      }
      .vc-bubble.ai :where(p):first-child { margin-top: 0; }
      .vc-bubble.ai :where(p):last-child { margin-bottom: 0; }
      .vc-bubble.ai :where(pre) {
        background: var(--bg-deep, #0a0e17);
        padding: 8px 10px;
        border-radius: var(--radius, 6px);
        overflow-x: auto;
        font-family: var(--font-mono, monospace);
        font-size: 12px;
      }
      .vc-bubble.ai :where(code) { font-family: var(--font-mono, monospace); }
      .vc-busy {
        align-self: flex-start;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--text-dim, #565f89);
        font-size: 12px;
        padding: 4px 2px;
      }
      .vc-spin {
        width: 14px; height: 14px;
        border: 2px solid var(--border, #414868);
        border-top-color: var(--accent, #7aa2f7);
        border-radius: 50%;
        animation: vc-chat-spin .8s linear infinite;
        flex: none;
      }
      @keyframes vc-chat-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .vc-spin { animation-duration: 2s; } }
      ::slotted([slot="empty"]) { margin: auto; }
    </style>
    <div class="vc-log" part="log">
      <slot name="empty"></slot>
    </div>
  `;

  class VcChatLog extends Vc.Element {
    static get template() { return TEMPLATE; }
    static get observedAttributes() { return ['busy', 'busy-label']; }

    constructor() {
      super();
      this._log = this.$('.vc-log');
      this._emptySlot = this.$('slot[name="empty"]');
      this._messages = [];
      this._busyNode = null;
      this._onScroll = () => { this._stick = this._atBottom(); };
      this._stick = true;
    }

    connectedCallback() {
      this._log.addEventListener('scroll', this._onScroll, { passive: true });
      this._renderAll();
    }
    disconnectedCallback() {
      this._log.removeEventListener('scroll', this._onScroll);
    }
    attributeChangedCallback(name) {
      if (!this._log) return;
      if (name === 'busy' || name === 'busy-label') this._renderBusy();
    }

    // --- public API ---
    get messages() { return this._messages.slice(); }
    set messages(list) {
      this._messages = Array.isArray(list) ? list.slice() : [];
      this._stick = true;
      this._renderAll();
    }

    append(msg) {
      if (!msg) return;
      this._messages.push(msg);
      const wasBottom = this._atBottom();
      this._log.insertBefore(this._buildBubble(msg), this._busyNode || null);
      this._toggleEmpty();
      if (wasBottom || this._stick) this._scrollToEnd();
    }

    clear() {
      this._messages = [];
      this._renderAll();
    }

    get busy() { return this.hasAttribute('busy'); }
    set busy(v) {
      this.reflectBool('busy', !!v);
    }

    scrollToEnd() { this._scrollToEnd(); }

    // --- internals ---
    _roleClass(role) { return role === 'user' ? 'user' : 'ai'; }

    _buildBubble(msg) {
      const div = document.createElement('div');
      div.className = 'vc-bubble ' + this._roleClass(msg.role);
      div.setAttribute('part', 'bubble ' + this._roleClass(msg.role));
      if (typeof msg.html === 'string') {
        // Caller-supplied markup routes through the core sanitize seam so one
        // install point (Vc.setSanitizer) covers every component. Default seam is
        // pass-through (warns once) — see vc-core.js.
        div.innerHTML = Vc.sanitize(msg.html);
      }
      else div.textContent = msg.text != null ? String(msg.text) : '';
      return div;
    }

    _renderAll() {
      // Keep the slotted empty-state node; remove rendered bubbles/busy only.
      this._log.querySelectorAll('.vc-bubble, .vc-busy').forEach((n) => n.remove());
      this._busyNode = null;
      const frag = document.createDocumentFragment();
      for (const m of this._messages) frag.appendChild(this._buildBubble(m));
      this._log.appendChild(frag);
      this._renderBusy();
      this._toggleEmpty();
      this._scrollToEnd();
    }

    _renderBusy() {
      const on = this.hasAttribute('busy');
      if (on && !this._busyNode) {
        const node = document.createElement('div');
        node.className = 'vc-busy';
        node.setAttribute('part', 'busy');
        const spin = document.createElement('span');
        spin.className = 'vc-spin';
        const label = document.createElement('span');
        label.textContent = this.getAttribute('busy-label') || 'Thinking…';
        node.append(spin, label);
        this._log.appendChild(node);
        this._busyNode = node;
        this._toggleEmpty();
        if (this._stick) this._scrollToEnd();
      } else if (on && this._busyNode) {
        this._busyNode.querySelector('span:last-child').textContent =
          this.getAttribute('busy-label') || 'Thinking…';
      } else if (!on && this._busyNode) {
        this._busyNode.remove();
        this._busyNode = null;
        this._toggleEmpty();
      }
    }

    _toggleEmpty() {
      const hasContent = this._messages.length > 0 || !!this._busyNode;
      this._emptySlot.style.display = hasContent ? 'none' : '';
    }

    _atBottom() {
      const el = this._log;
      return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    }

    _scrollToEnd() {
      // rAF so layout settles after DOM insertion before we measure/scroll.
      requestAnimationFrame(() => { this._log.scrollTop = this._log.scrollHeight; });
    }
  }

  Vc.define('vc-chat-log', VcChatLog);
})();
