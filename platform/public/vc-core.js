// vc-core — shared foundation for the vistaclair `vc-*` Web Component system.
//
// Every `vc-*` component builds on this. It is idempotent and redefine-guarded:
// loading it more than once (e.g. an app loads the bundle AND an individual
// component that self-includes core) is a no-op after the first time. There is
// no build step — core is concatenated ahead of the components in /pro/vc.js,
// and the per-component routes prepend it too, so a component is never loaded
// without its base present.
//
// Surface (all under the global `Vc`, also exposed as named globals where noted):
//   Vc.Element            — base class: shadow DOM + helpers (extend this)
//   Vc.define(tag, cls)   — redefine-guarded customElements.define
//   Vc.html(strings,...)  — tagged template that escapes interpolations
//   Vc.escapeHtml(s)      — HTML-escape a string
//   Vc.clamp(n, lo, hi)
//   Vc.formatBytes(n)
//   Vc.blobToDataUri(b)   — Promise<dataURI>
//   Vc.rafThrottle(fn)    — coalesce calls to one per animation frame
//   Vc.sanitize(html)     — pluggable HTML sanitizer seam (default: identity + warn-once)
//   Vc.setSanitizer(fn)   — install a real sanitizer (e.g. DOMPurify) platform/app-wide
//   Vc.renderMath(tex,o)  — pluggable LaTeX→HTML seam (default: escaped <code> + warn-once)
//   Vc.setMathRenderer(fn)— install a real math engine (e.g. KaTeX) platform/app-wide
//   Vc.toast(msg, level)  — resolve window.showToast with a console fallback
//   Vc.transcribe(uri, o) — resolve window.transcribe (throws if runtime absent)
//   Vc.getModels(opts)    — resolve window.getModels / Bridge('ai.models'); opts.kind → ai.mediaModels
//   Vc.voiceSample(m, v)  — Bridge('ai.voiceSample'): a cached spoken sample of one voice
//   Vc.state.get/set(k,v) — per-app key/value state (persist-scope="state")
//   Vc.settings.get/set(k,v) — per-app config, ALSO readable server-side as
//                              ctx.settings (the default for `persist-key`)
//   Vc.BASE_CSS           — shared stylesheet text (focus ring, spinner, reduced-motion)

(function () {
  'use strict';
  if (window.Vc && window.Vc.Element) return; // idempotent

  const Vc = window.Vc || (window.Vc = {});

  // ---- small utils ----
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }
  function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
  }
  function blobToDataUri(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('Could not read blob'));
      fr.onload = () => resolve(fr.result);
      fr.readAsDataURL(blob);
    });
  }
  function rafThrottle(fn) {
    let scheduled = false, lastArgs = null;
    return function (...args) {
      lastArgs = args;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; fn.apply(this, lastArgs); });
    };
  }
  // Tagged template: `Vc.html`<div>${userInput}</div>`` — interpolations escaped,
  // the literal markup is trusted. Returns a string.
  function html(strings, ...values) {
    let out = strings[0];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      out += (v && v.__vcRaw ? v.html : escapeHtml(v)) + strings[i + 1];
    }
    return out;
  }
  html.raw = (s) => ({ __vcRaw: true, html: String(s == null ? '' : s) });

  // ---- sanitize seam ----
  // Components that inject caller-supplied HTML (e.g. rendered markdown) route it
  // through Vc.sanitize so one install point covers all of them. Default is a
  // pass-through that warns once — install a real sanitizer with setSanitizer.
  let _sanitizer = null;
  let _warnedNoSanitizer = false;
  function sanitize(htmlStr) {
    const s = String(htmlStr == null ? '' : htmlStr);
    if (_sanitizer) {
      try { return String(_sanitizer(s)); }
      catch (err) { console.warn('[vc] sanitizer threw; passing through:', err); return s; }
    }
    if (!_warnedNoSanitizer) {
      _warnedNoSanitizer = true;
      console.warn('[vc] no HTML sanitizer installed (Vc.setSanitizer); trusted-HTML inputs pass through unmodified.');
    }
    return s;
  }
  function setSanitizer(fn) { _sanitizer = typeof fn === 'function' ? fn : null; }

  // ---- math seam ----
  // Mirrors the sanitize seam: components that render LaTeX (e.g. vc-markdown)
  // call Vc.renderMath so one install point (Vc.setMathRenderer) covers them all.
  // The renderer takes (tex, { display }) and returns an HTML string. Default
  // degrades to an escaped <code> span (warns once) so math is legible without an
  // engine installed. A renderer that throws falls back to the same legible form.
  let _mathRenderer = null;
  let _warnedNoMath = false;
  function renderMath(tex, opts) {
    const src = String(tex == null ? '' : tex);
    const display = !!(opts && opts.display);
    if (_mathRenderer) {
      try { return String(_mathRenderer(src, { display })); }
      catch (err) { console.warn('[vc] math renderer threw; showing raw TeX:', err); }
    } else if (!_warnedNoMath) {
      _warnedNoMath = true;
      console.warn('[vc] no math renderer installed (Vc.setMathRenderer); LaTeX shown as raw text.');
    }
    return '<code class="vc-math-raw" data-display="' + (display ? '1' : '0') + '">'
      + escapeHtml(src) + '</code>';
  }
  function setMathRenderer(fn) { _mathRenderer = typeof fn === 'function' ? fn : null; }

  // ---- platform runtime accessors (single fallback point) ----
  function toast(msg, level) {
    if (typeof window.showToast === 'function') window.showToast(msg, level || 'info');
    else console.warn('[vc]', (level || 'info') + ':', msg);
  }
  function transcribe(dataUri, opts) {
    if (typeof window.transcribe !== 'function') {
      return Promise.reject(new Error('Transcription unavailable (platform runtime not loaded)'));
    }
    return window.transcribe(dataUri, opts || {});
  }
  // opts.kind routes the catalog: none / 'text' → ai.models (the text
  // registry, opts passed through unchanged); 'speech' | 'transcription' |
  // 'image' → ai.mediaModels ({ models, defaults }, needs the audio capability).
  function getModels(opts) {
    const o = Object.assign({}, opts || {});
    const kind = o.kind; delete o.kind;
    if (kind && kind !== 'text') {
      if (typeof window.getMediaModels === 'function') return window.getMediaModels({ kind });
      if (window.Bridge && typeof window.Bridge.call === 'function') return window.Bridge.call('ai.mediaModels', { kind });
      return Promise.reject(new Error('Media model catalog unavailable (platform runtime not loaded)'));
    }
    if (typeof window.getModels === 'function') return window.getModels(o);
    if (window.Bridge && typeof window.Bridge.call === 'function') return window.Bridge.call('ai.models', o);
    return Promise.reject(new Error('Model catalog unavailable (platform runtime not loaded)'));
  }
  // A short spoken sample of one TTS voice → { dataUri } (ai.voiceSample;
  // generated once, then cached platform-wide).
  function voiceSample(model, voice) {
    if (window.Bridge && typeof window.Bridge.call === 'function') return window.Bridge.call('ai.voiceSample', { model, voice });
    return Promise.reject(new Error('Voice samples unavailable (platform runtime not loaded)'));
  }
  // Per-app key/value state (the `state.*` bridge methods). This is what the
  // components' `persist-key` attribute is built on, so a remembered control
  // value costs an attribute instead of per-app get/set glue. Small preferences
  // only — `state.*` serializes the whole JSON file per access.
  const state = {
    get(key) {
      if (!window.Bridge || typeof window.Bridge.call !== 'function') {
        return Promise.reject(new Error('App state unavailable (platform runtime not loaded)'));
      }
      return window.Bridge.call('state.get', { key });
    },
    set(key, value) {
      if (!window.Bridge || typeof window.Bridge.call !== 'function') {
        return Promise.reject(new Error('App state unavailable (platform runtime not loaded)'));
      }
      return window.Bridge.call('state.set', { key, value });
    },
  };

  // Per-app user-facing configuration (the `settings.*` bridge methods). Unlike
  // `state.*`, this store is ALSO readable from the app's own backend as
  // `ctx.settings` — which is why it, not state, is where a persisted model
  // choice belongs: the backend is what makes the call. Components reach it via
  // `persist-scope="settings"`.
  const settings = {
    get(key) {
      if (!window.Bridge || typeof window.Bridge.call !== 'function') {
        return Promise.reject(new Error('App settings unavailable (platform runtime not loaded)'));
      }
      return window.Bridge.call('settings.get', { key });
    },
    set(key, value) {
      if (!window.Bridge || typeof window.Bridge.call !== 'function') {
        return Promise.reject(new Error('App settings unavailable (platform runtime not loaded)'));
      }
      return window.Bridge.call('settings.set', { key, value });
    },
  };

  // ---- redefine-guarded define ----
  function define(tag, cls) {
    if (window.customElements && !customElements.get(tag)) customElements.define(tag, cls);
  }

  // ---- shared base stylesheet (prepended into every component's shadow root) ----
  const BASE_CSS = `
    :host { box-sizing: border-box; font-family: var(--font, system-ui, sans-serif); }
    :host([hidden]) { display: none !important; }
    *, *::before, *::after { box-sizing: border-box; }
    .vc-spin {
      width: 14px; height: 14px; flex: none;
      border: 2px solid var(--border, #414868);
      border-top-color: var(--accent, #7aa2f7);
      border-radius: 50%;
      animation: vc-spin .8s linear infinite;
    }
    @keyframes vc-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .vc-spin { animation-duration: 2s; }
    }
  `;

  // ---- base element ----
  // Subclasses set `static template` to an HTML string (rendered into the shadow
  // root, with BASE_CSS prepended once via a <style>). Lifecycle helpers reduce
  // the per-component boilerplate: emit(), $(), reflectBool(), reflectAttr().
  class VcElement extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      const tmpl = this.constructor.template;
      root.innerHTML = '<style>' + BASE_CSS + '</style>' + (tmpl || '');
    }
    // shadow-root query shorthand
    $(sel) { return this.shadowRoot.querySelector(sel); }
    $$(sel) { return Array.from(this.shadowRoot.querySelectorAll(sel)); }
    // always bubbles + composed so apps can listen on the host or an ancestor
    emit(name, detail) {
      this.dispatchEvent(new CustomEvent(name, { detail: detail || {}, bubbles: true, composed: true }));
    }
    // reflect a boolean property <-> attribute presence
    reflectBool(name, on) {
      if (on) this.setAttribute(name, '');
      else this.removeAttribute(name);
    }
    // reflect a string property <-> attribute (null/'' removes)
    reflectAttr(name, val) {
      if (val == null || val === '') this.removeAttribute(name);
      else this.setAttribute(name, String(val));
    }
  }

  Object.assign(Vc, {
    Element: VcElement,
    define, html, escapeHtml, clamp, formatBytes, blobToDataUri, rafThrottle,
    sanitize, setSanitizer, renderMath, setMathRenderer, toast, transcribe, getModels, voiceSample, state, settings, BASE_CSS,
  });
})();
