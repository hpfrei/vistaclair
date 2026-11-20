// <vc-gauge> — live resource-utilisation meter: a level against a capacity.
// Part of the vistaclair `vc-*` component system. Shadow-DOM, theme-aware,
// built on vc-core (`Vc.Element`).
//
// Distinct from <vc-progress> on purpose: progress models job COMPLETION
// (0→100, then done and gone). A gauge models a LEVEL that goes up and down
// against a ceiling — RAM used vs the cgroup limit, swap, disk, quota, budget —
// and the interesting facts are "how close to the ceiling" and "past the
// warning line yet", not "how far along".
//
// Usage:
//   <vc-gauge value="3481" max="8192" label="RAM (MB)"></vc-gauge>
//   <vc-gauge value="3481" max="8192" marker="7168" warn-at="6000"
//             label="RAM vs cgroup ceiling"></vc-gauge>
//   el.value = sample.usedMb;   // reactive — fill, color and readout update
//
// Attributes (all reactive):
//   value    — current level (any unit, as long as max/marker/warn-at agree)
//   max      — capacity. Missing/0: the scale falls back to max(value, marker)
//              so the bar still draws sensibly; the readout shows the bare value.
//   marker   — threshold tick drawn on the bar (e.g. the cgroup ceiling a stage
//              dies against, a soft quota). Purely visual; does not recolor.
//   warn-at  — value at/above which the fill switches to the warning color.
//              At/above max (over the ceiling) the fill goes critical.
//   label    — caption under the bar (left side; the readout sits right).
//
// Properties mirror the attributes (numbers; label is a string).

(function () {
  'use strict';

  const TEMPLATE = `
    <style>
      :host {
        display: block;
        --vc-gauge-warn: var(--yellow, #e0af68);
        --vc-gauge-crit: var(--red, #f7768e);
      }
      .vc-bar {
        position: relative;
        height: 8px;
        border-radius: 999px;
        background: var(--bg-surface, #24283b);
        border: 1px solid var(--border, #414868);
      }
      .vc-fill {
        position: absolute;
        inset: 0 auto 0 0;
        border-radius: 999px;
        background: var(--accent, #7aa2f7);
        width: 0;
        transition: width .3s ease, background-color .3s ease;
      }
      .vc-fill.warn { background: var(--vc-gauge-warn); }
      .vc-fill.crit { background: var(--vc-gauge-crit); }
      /* the marker overhangs the track so it reads as a limit, not a data point */
      .vc-marker {
        position: absolute;
        top: -3px; bottom: -3px;
        width: 0;
        border-left: 2px dashed var(--text-dim, #565f89);
        display: none;
      }
      .vc-caption {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        font-size: 11px;
        color: var(--text-dim, #565f89);
        margin-top: 4px;
      }
      .vc-caption:empty { display: none; }
      .vc-readout { font-variant-numeric: tabular-nums; white-space: nowrap; }
      @media (prefers-reduced-motion: reduce) {
        .vc-fill { transition: none; }
      }
    </style>
    <div class="vc-bar" part="bar" role="meter" aria-valuemin="0">
      <div class="vc-fill" part="fill"></div>
      <div class="vc-marker" part="marker"></div>
    </div>
    <div class="vc-caption">
      <span class="vc-label" part="label"></span>
      <span class="vc-readout" part="readout"></span>
    </div>
  `;

  // "3481.0" → "3481", "0.4321" → "0.43" — readable at any unit scale.
  function fmtNum(n) {
    if (!isFinite(n)) return '';
    const r = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
    return String(r);
  }

  class VcGauge extends Vc.Element {
    static get template() { return TEMPLATE; }
    static get observedAttributes() { return ['value', 'max', 'marker', 'label', 'warn-at']; }

    constructor() {
      super();
      this._bar = this.$('.vc-bar');
      this._fill = this.$('.vc-fill');
      this._marker = this.$('.vc-marker');
      this._labelEl = this.$('.vc-label');
      this._readout = this.$('.vc-readout');
    }

    connectedCallback() { this._render(); }
    attributeChangedCallback() { if (this._fill) this._render(); }

    _num(name) {
      const raw = this.getAttribute(name);
      if (raw == null || raw === '') return null;
      const n = Number(raw);
      return isFinite(n) ? n : null;
    }

    _render() {
      const value = Math.max(0, this._num('value') || 0);
      const max = this._num('max');
      const marker = this._num('marker');
      const warnAt = this._num('warn-at');
      const label = this.getAttribute('label') || '';

      // The drawing scale. Real capacity when given; otherwise fall back to
      // whatever is largest among value and marker so the bar still means
      // something (a marker with no max still shows value-vs-threshold).
      const hasMax = max != null && max > 0;
      const scale = hasMax ? max : Math.max(value, marker || 0);

      const pct = scale > 0 ? Vc.clamp((value / scale) * 100, 0, 100) : 0;
      this._fill.style.width = pct + '%';

      const over = hasMax && value >= max;
      const warm = warnAt != null && value >= warnAt;
      this._fill.classList.toggle('crit', over);
      this._fill.classList.toggle('warn', !over && warm);

      if (marker != null && marker > 0 && scale > 0 && marker <= scale) {
        this._marker.style.display = 'block';
        this._marker.style.left = Vc.clamp((marker / scale) * 100, 0, 100) + '%';
      } else {
        this._marker.style.display = 'none';
      }

      this._labelEl.textContent = label;
      this._readout.textContent = hasMax
        ? fmtNum(value) + ' / ' + fmtNum(max)
        : (this.hasAttribute('value') ? fmtNum(value) : '');

      // ARIA meter semantics (readers get the numbers even without a max)
      if (hasMax) this._bar.setAttribute('aria-valuemax', String(max));
      else this._bar.removeAttribute('aria-valuemax');
      this._bar.setAttribute('aria-valuenow', String(value));
      if (label) this._bar.setAttribute('aria-label', label);
      else this._bar.removeAttribute('aria-label');
    }

    get value() { return Math.max(0, this._num('value') || 0); }
    set value(v) { this.reflectAttr('value', v == null ? null : String(v)); }

    get max() { return this._num('max'); }
    set max(v) { this.reflectAttr('max', v == null ? null : String(v)); }

    get marker() { return this._num('marker'); }
    set marker(v) { this.reflectAttr('marker', v == null ? null : String(v)); }

    get warnAt() { return this._num('warn-at'); }
    set warnAt(v) { this.reflectAttr('warn-at', v == null ? null : String(v)); }

    get label() { return this.getAttribute('label') || ''; }
    set label(v) { this.reflectAttr('label', v); }
  }

  Vc.define('vc-gauge', VcGauge);
})();
