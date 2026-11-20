// <vc-input-bar> — first element of the vistaclair `vc-*` component system.
//
// A reusable prompt input: textarea + microphone (record → ai.transcribe →
// insert at caret) + send. Shadow-DOM encapsulated so it renders identically in
// any app regardless of the app's own CSS. Theme-aware via the platform CSS
// custom properties (--accent, --border, …) which pierce the shadow boundary.
//
// Built on vc-core (`Vc.Element`). Depends on the platform runtime
// (/pro/app-runtime.js) for transcription and toasts, reached through the
// Vc.transcribe / Vc.toast seams — load this script AFTER app-runtime.js.
//
// Usage:
//   <vc-input-bar placeholder="Ask…" rows="3" send-label="Send"></vc-input-bar>
//   el.addEventListener('send', e => { const text = e.detail.text; … });
// Properties: value (get/set), busy (get/set), accuracy ('low'|'high'), focus().
// The element does NOT clear or send by itself — the app owns the call, then
// sets `el.value = ''` on success. Mic requires the host iframe to be granted
// `allow="microphone"` (gated by the app manifest `capabilities`).

(function () {
  'use strict';
  const MIC_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="6" y="1.5" width="4" height="8" rx="2"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5M5.5 14.5h5"/></svg>';
  const SPIN_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" class="vc-spin" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 1.5a6.5 6.5 0 1 0 6.5 6.5" stroke-linecap="round"/></svg>';

  const TEMPLATE = `
    <style>
      :host {
        display: block;
        --vc-gap: 8px;
      }
      .vc-wrap {
        display: flex;
        flex-direction: column;
        gap: var(--vc-gap);
        background: var(--bg-surface, #24283b);
        border: 1px solid var(--border, #414868);
        border-radius: var(--radius, 6px);
        padding: var(--vc-gap);
        transition: border-color .15s;
      }
      .vc-wrap.vc-focus { border-color: var(--accent, #7aa2f7); }
      textarea {
        width: 100%;
        resize: vertical;
        min-height: 2.4em;
        padding: 6px 8px;
        background: var(--bg, #1a1b26);
        color: var(--text, #c0caf5);
        border: 1px solid var(--border, #414868);
        border-radius: var(--radius, 6px);
        font: inherit;
        font-size: 13px;
        line-height: 1.5;
        outline: none;
      }
      textarea:focus { border-color: var(--accent, #7aa2f7); }
      textarea::placeholder { color: var(--text-dim, #565f89); }
      .vc-row {
        display: flex;
        align-items: center;
        gap: var(--vc-gap);
        justify-content: flex-end;
      }
      .vc-row ::slotted(*) { margin-right: auto; }
      button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        font: inherit;
        font-size: 12px;
        border-radius: var(--radius, 6px);
        border: 1px solid var(--border, #414868);
        cursor: pointer;
        transition: background .15s, border-color .15s, color .15s, opacity .15s;
        background: var(--bg-surface, #24283b);
        color: var(--text, #c0caf5);
      }
      button:disabled { opacity: .5; cursor: not-allowed; }
      .vc-mic {
        width: 34px; height: 34px; padding: 0; flex: none;
      }
      .vc-mic:hover:not(:disabled) { background: var(--bg-hover, #2f3348); }
      .vc-mic[data-state="recording"] {
        border-color: var(--red, #f7768e);
        color: var(--red, #f7768e);
        background: color-mix(in srgb, var(--red, #f7768e) 14%, transparent);
        animation: vc-pulse 1.3s ease-in-out infinite;
      }
      .vc-mic[data-state="busy"] { color: var(--accent, #7aa2f7); }
      .vc-mic[hidden] { display: none; }
      .vc-send {
        padding: 7px 16px;
        background: var(--accent, #7aa2f7);
        color: #fff;
        border-color: var(--accent, #7aa2f7);
        font-weight: 500;
      }
      .vc-send:hover:not(:disabled) { filter: brightness(1.12); }
      .vc-spin { animation: vc-rot .7s linear infinite; transform-origin: 8px 8px; }
      @keyframes vc-rot { to { transform: rotate(360deg); } }
      @keyframes vc-pulse { 0%,100% { opacity: 1; } 50% { opacity: .55; } }
      @media (prefers-reduced-motion: reduce) {
        .vc-spin, .vc-mic[data-state="recording"] { animation: none; }
      }
    </style>
    <div class="vc-wrap" part="wrap">
      <textarea part="textarea"></textarea>
      <div class="vc-row">
        <slot name="controls"></slot>
        <button type="button" class="vc-mic" part="mic" title="Record" aria-label="Record audio">${MIC_SVG}</button>
        <button type="button" class="vc-send" part="send"></button>
      </div>
    </div>
  `;

  class VcInputBar extends Vc.Element {
    static get template() { return TEMPLATE; }
    static get observedAttributes() { return ['placeholder', 'rows', 'send-label', 'disabled']; }

    constructor() {
      super();
      this._wrap = this.$('.vc-wrap');
      this._textarea = this.$('textarea');
      this._mic = this.$('.vc-mic');
      this._send = this.$('.vc-send');
      this._recorder = null;
      this._stream = null;
      this._chunks = [];
      this._busy = false;
      this._recording = false;
    }

    connectedCallback() {
      this._textarea.rows = Number(this.getAttribute('rows')) || 3;
      this._textarea.placeholder = this.getAttribute('placeholder') || '';
      this._send.textContent = this.getAttribute('send-label') || 'Send';
      this._reflectMicSupport();

      this._onSendClick = () => this._emitSend();
      this._onMicClick = () => this._toggleRecording();
      this._onKeydown = (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); this._emitSend(); }
      };
      this._onFocusIn = () => this._wrap.classList.add('vc-focus');
      this._onFocusOut = () => this._wrap.classList.remove('vc-focus');

      this._send.addEventListener('click', this._onSendClick);
      this._mic.addEventListener('click', this._onMicClick);
      this._textarea.addEventListener('keydown', this._onKeydown);
      this.shadowRoot.addEventListener('focusin', this._onFocusIn);
      this.shadowRoot.addEventListener('focusout', this._onFocusOut);
    }

    disconnectedCallback() {
      this._send.removeEventListener('click', this._onSendClick);
      this._mic.removeEventListener('click', this._onMicClick);
      this._textarea.removeEventListener('keydown', this._onKeydown);
      this.shadowRoot.removeEventListener('focusin', this._onFocusIn);
      this.shadowRoot.removeEventListener('focusout', this._onFocusOut);
      this._teardownStream();
    }

    attributeChangedCallback(name, _old, val) {
      if (!this._textarea) return;
      if (name === 'placeholder') this._textarea.placeholder = val || '';
      else if (name === 'rows') this._textarea.rows = Number(val) || 3;
      else if (name === 'send-label') this._send.textContent = val || 'Send';
      else if (name === 'disabled') this._syncDisabled();
    }

    // --- public API ---
    get value() { return this._textarea.value; }
    set value(v) { this._textarea.value = v == null ? '' : String(v); }

    get busy() { return this._busy; }
    set busy(v) {
      this._busy = !!v;
      this._send.innerHTML = this._busy
        ? SPIN_SVG + '<span>' + (this.getAttribute('send-label') || 'Send') + '</span>'
        : (this.getAttribute('send-label') || 'Send');
      this._syncDisabled();
    }

    get accuracy() { return this.getAttribute('accuracy') === 'high' ? 'high' : 'low'; }

    focus() { this._textarea.focus(); }

    // --- internals ---
    _syncDisabled() {
      const off = this._busy || this.hasAttribute('disabled');
      this._send.disabled = off;
      this._textarea.disabled = off;
      this._mic.disabled = off || this._micUnsupported;
    }

    _reflectMicSupport() {
      this._micUnsupported = !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
      if (this._micUnsupported) this._mic.hidden = true;
      this._syncDisabled();
    }

    _emitSend() {
      if (this._busy) return;
      const text = this._textarea.value.trim();
      if (!text) { this._textarea.focus(); return; }
      this.emit('send', { text });
    }

    _insertAtCursor(text) {
      if (!text) return;
      const ta = this._textarea;
      const start = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
      const end = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const pad = before && !/\s$/.test(before) ? ' ' : '';
      const insert = pad + text;
      ta.value = before + insert + after;
      const caret = start + insert.length;
      ta.selectionStart = ta.selectionEnd = caret;
      ta.focus();
    }

    async _toggleRecording() {
      if (this._recording) { this._stopRecording(); return; }
      if (this._busy || this._micUnsupported) return;
      try {
        this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        this._toast(err && err.name === 'NotAllowedError'
          ? 'Microphone permission denied'
          : 'Microphone unavailable: ' + (err && err.message || err), 'error');
        return;
      }
      this._chunks = [];
      let mime = '';
      if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
        if (MediaRecorder.isTypeSupported('audio/webm')) mime = 'audio/webm';
        else if (MediaRecorder.isTypeSupported('audio/mp4')) mime = 'audio/mp4';
      }
      try {
        this._recorder = mime ? new MediaRecorder(this._stream, { mimeType: mime }) : new MediaRecorder(this._stream);
      } catch (err) {
        this._teardownStream();
        this._toast('Recording failed: ' + (err && err.message || err), 'error');
        return;
      }
      this._recorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) this._chunks.push(e.data); });
      this._recorder.addEventListener('stop', () => this._onRecordingStop());
      this._recorder.start();
      this._recording = true;
      this._mic.dataset.state = 'recording';
      this._mic.title = 'Stop recording';
      this._mic.setAttribute('aria-label', 'Stop recording');
    }

    _stopRecording() {
      if (this._recorder && this._recorder.state !== 'inactive') {
        try { this._recorder.stop(); } catch (_) {}
      }
      this._recording = false;
    }

    async _onRecordingStop() {
      const type = (this._recorder && this._recorder.mimeType) || (this._chunks[0] && this._chunks[0].type) || 'audio/webm';
      const blob = new Blob(this._chunks, { type });
      this._chunks = [];
      this._teardownStream();
      this._mic.removeAttribute('data-state');
      this._mic.title = 'Record';
      this._mic.setAttribute('aria-label', 'Record audio');

      if (!blob.size) return;

      this._setMicBusy(true);
      try {
        const dataUri = await Vc.blobToDataUri(blob);
        const res = await Vc.transcribe(dataUri, { accuracy: this.accuracy });
        const text = res && typeof res.text === 'string' ? res.text.trim() : '';
        if (res && res.silent) this._toast('No speech detected', 'warning');
        else if (text) this._insertAtCursor(text);
        else this._toast('Nothing transcribed', 'warning');
      } catch (err) {
        this._toast('Transcription failed: ' + (err && err.message || err), 'error');
      } finally {
        this._setMicBusy(false);
      }
    }

    _setMicBusy(on) {
      if (on) {
        this._mic.dataset.state = 'busy';
        this._mic.innerHTML = SPIN_SVG;
        this._mic.disabled = true;
      } else {
        this._mic.removeAttribute('data-state');
        this._mic.innerHTML = MIC_SVG;
        this._syncDisabled();
      }
    }

    _teardownStream() {
      if (this._stream) {
        try { this._stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
        this._stream = null;
      }
      this._recorder = null;
    }

    _toast(msg, level) { Vc.toast(msg, level || 'info'); }
  }

  Vc.define('vc-input-bar', VcInputBar);
})();
