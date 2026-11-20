// <vc-sysmon> — live host monitor: RAM/CPU/swap/disk/load with history charts and
// the top memory consumers on the box.
//
// Part of the vistaclair-pro `vc-*` component system. Shadow-DOM, theme-aware,
// built on vc-core (`Vc.Element`). Backed by the platform sysmon service, so the
// page does not sample anything itself — it subscribes and draws.
//
// Usage:
//   <vc-sysmon></vc-sysmon>                                   // everything
//   <vc-sysmon show="mem,top" top="5"></vc-sysmon>             // memory only
//   <vc-sysmon show="cpu"></vc-sysmon>                         // CPU + per-core strip
//   <vc-sysmon marker-mb="8192" marker-label="ceiling"></vc-sysmon>
//   <vc-sysmon compact></vc-sysmon>                            // gauge row
//   <vc-sysmon manual></vc-sysmon>  + el.data = sample         // fed by hand
//
// Attributes: show, top, compact, manual, marker-mb, marker-label,
//             hot-mem, hot-swap, hot-disk, hot-cpu.
// Properties: data (sample), processes (breakdown), history (sample[]).
// Events: sysmon-sample {sample} — re-emitted per tick for the host page.
//
// Why history is a chart and not a number: a gauge reading 71% answers "how full"
// but not "which way is this going", and on a machine that is filling up those are
// completely different situations. The chart is the point; the number is the label.
//
// Why charts are painted in a SECOND pass: an SVG stretched with
// preserveAspectRatio="none" scales x and y by different factors, which turns
// every circle into an ellipse and smears label text horizontally. So the markup
// pass emits empty chart boxes, then _paintCharts() measures each one and draws it
// in real pixel coordinates — one CSS px per SVG unit, nothing distorted. A
// ResizeObserver re-runs just that pass, so a resize never costs a full re-render.
//
// Color: one series hue (the app's --accent) plus the platform status warning/
// critical steps for hot states. A hot chart swaps --sm-series for the status step
// on the <svg> itself, so line, fill gradient and end-dot recolor together. State
// is NEVER carried by hue alone — every figure prints its own percentage and a
// state word beside it, which is also what keeps the light-mode warning step
// legible. Per-core bars are deliberately ONE color: height already encodes
// magnitude, and a value-ramp over it would double-encode and say nothing new.

(function () {
  'use strict';

  const MB = 1048576;
  const SPARK_H = 22;
  const CHART_H = 96;
  const CORES_H = 22;

  const TEMPLATE = `
    <style>
      :host {
        display: block;
        --sm-series: var(--accent, #7aa2f7);
        --sm-warn: #fab219;
        --sm-crit: #d03b3b;
        --sm-ink: var(--text, #c0caf5);
        --sm-dim: var(--text-dim, #565f89);
        --sm-grid: var(--border, #414868);
        --sm-surface: var(--bg-surface, #24283b);
      }
      .panel { display: flex; flex-direction: column; gap: 16px; }

      /* Memory and CPU are peers, so they sit side by side and fall to one column
         when there isn't room for two readable charts. */
      .figs { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 18px 24px; }
      .fig { display: flex; flex-direction: column; gap: 7px; min-width: 0; }

      /* --- figure header: label, hero value, delta --- */
      .fig-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
      .fig-label { font-size: 11px; color: var(--sm-dim); text-transform: uppercase; letter-spacing: .04em; }
      .fig-value { font-size: 22px; font-weight: 600; color: var(--sm-ink); line-height: 1.1; }
      .fig-sub, .fig-delta { font-size: 11px; color: var(--sm-dim); }
      .fig-foot { display: flex; justify-content: space-between; gap: 8px; }
      .fig-state { font-size: 11px; font-weight: 600; }
      .fig-state.warn { color: var(--sm-warn); }
      .fig-state.crit { color: var(--sm-crit); }

      /* --- charts --- */
      .chart { position: relative; width: 100%; }
      .chart svg { display: block; overflow: visible; }
      /* The plot box: a barely-there surface that gives the chart an edge to live
         inside, so the fill fading to nothing at the baseline still reads as a
         region rather than a stray smear. */
      .plot { fill: color-mix(in srgb, var(--sm-ink) 5%, transparent); stroke: var(--sm-grid); stroke-opacity: .35; stroke-width: 1; }
      /* Gridlines ride ABOVE the fill — under it they simply vanish. */
      .grid { stroke: var(--sm-grid); stroke-width: 1; opacity: .5; }
      .marker { stroke: var(--sm-ink); stroke-width: 1; opacity: .5; stroke-dasharray: 4 3; }
      /* The surface doing the separating: when usage sits AT the ceiling — the case
         this marker exists for — the label lands on the series line. A halo in the
         panel background keeps both readable without moving either. */
      .marker-text {
        font-size: 9.5px; fill: var(--sm-dim);
        paint-order: stroke; stroke: var(--sm-surface); stroke-width: 3px;
        stroke-linejoin: round;
      }
      .series-line { fill: none; stroke: var(--sm-series); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
      /* A flat slab from the baseline up buries the line in a block of color. The
         gradient hands the ink back to the line — and it is anchored to the series
         PEAK rather than the top of the box, so a chart sitting low and a chart
         sitting high get the same fade instead of one washing out and the other
         turning into a solid brick. */
      .grad-top { stop-color: var(--sm-series); stop-opacity: .18; }
      .grad-bot { stop-color: var(--sm-series); stop-opacity: 0; }
      .end-dot { fill: var(--sm-series); stroke: var(--sm-surface); stroke-width: 2; }
      .cross { stroke: var(--sm-ink); stroke-width: 1; opacity: .4; }

      .tip {
        position: absolute; pointer-events: none; z-index: 2;
        background: var(--bg, #1a1b26); color: var(--sm-ink);
        border: 1px solid var(--sm-grid); border-radius: 6px;
        padding: 4px 7px; font-size: 11px; white-space: nowrap;
        transform: translate(-50%, -125%); opacity: 0;
      }
      /* No fade-in: a live sample rebuilds this element every 2 s, so a transition
         would restart from transparent on every tick and flicker under the cursor. */
      .tip.on { opacity: 1; }
      .tip b { font-weight: 600; }
      .tip .t-time { color: var(--sm-dim); }

      /* --- per-core strip --- */
      .cores {
        display: flex; align-items: flex-end; justify-content: space-between;
        gap: 2px; height: ${CORES_H}px; overflow: hidden;
      }
      .core {
        flex: 1 1 0; min-width: 2px; max-width: 24px; height: 100%;
        display: flex; align-items: flex-end; border-radius: 3px; overflow: hidden;
        background: color-mix(in srgb, var(--sm-ink) 9%, transparent);
      }
      .core > i {
        display: block; width: 100%; border-radius: 3px 3px 0 0;
        background: var(--sm-series); transition: height .4s ease;
      }

      /* --- meters (disk, load, compact mode) --- */
      .meter-row { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      /* A sparkline and a meter must occupy the same box, or a row mixing the two
         reads as misaligned even when the items line up perfectly. */
      .meter-body { height: ${SPARK_H}px; display: flex; align-items: center; }
      .meter-body > * { width: 100%; }
      .meter-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 11px; }
      .meter-name { color: var(--sm-dim); }
      .meter-val { color: var(--sm-ink); font-weight: 600; }
      .track {
        position: relative; height: 8px; border-radius: 999px; overflow: hidden;
        background: color-mix(in srgb, var(--sm-series) 16%, transparent);
      }
      .fill { height: 100%; border-radius: 999px; background: var(--sm-series); transition: width .4s ease; }
      .fill.warn { background: var(--sm-warn); }
      .fill.crit { background: var(--sm-crit); }
      .tick { position: absolute; top: -2px; bottom: -2px; width: 1px; background: var(--sm-ink); opacity: .55; }

      /* --- top consumers --- */
      .top-list { display: flex; flex-direction: column; gap: 7px; }
      .top-item { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; align-items: baseline; }
      .top-name {
        font-size: 12px; color: var(--sm-ink);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .top-name .kind { color: var(--sm-dim); font-size: 10px; margin-left: 5px; }
      .top-val { font-size: 12px; color: var(--sm-ink); font-variant-numeric: tabular-nums; }
      .top-bar { grid-column: 1 / -1; height: 6px; border-radius: 0 3px 3px 0;
                 background: var(--sm-series); opacity: .55; min-width: 2px; }

      .empty { font-size: 11px; color: var(--sm-dim); }
      .sec-label { font-size: 11px; color: var(--sm-dim); text-transform: uppercase; letter-spacing: .04em; }
      .row { display: flex; gap: 18px; flex-wrap: wrap; }
      .row > * { flex: 1 1 140px; }
      @media (prefers-reduced-motion: reduce) {
        .fill, .core > i { transition: none; }
      }
    </style>
    <div class="panel" part="panel"></div>
  `;

  const fmt = (n) => (window.Vc ? Vc.formatBytes(n) : Math.round(n / MB) + ' MB');
  const esc = (s) => (window.Vc ? Vc.escapeHtml(s) : String(s == null ? '' : s));
  const pct = (a, b) => (b > 0 ? Math.round((100 * a) / b) : 0);
  const clamp01 = (n) => Math.max(0, Math.min(1, n));

  // Downsample by striding, keeping the newest point: a 300-point ring drawn into
  // ~300 CSS px gains nothing from sub-pixel detail, and fewer points keeps the
  // path cheap to re-render every 2 seconds.
  function thin(arr, max) {
    if (arr.length <= max) return arr;
    const step = Math.ceil(arr.length / max);
    const out = [];
    for (let i = arr.length - 1; i >= 0; i -= step) out.unshift(arr[i]);
    return out;
  }

  // Build the line path and the area path that closes to the baseline.
  function paths(vals, w, h, maxY) {
    if (!vals.length) return { line: '', area: '' };
    const top = maxY > 0 ? maxY : 1;
    const dx = vals.length > 1 ? w / (vals.length - 1) : 0;
    const y = (v) => h - clamp01(v / top) * h;
    const d = vals.map((v, i) => `${i ? 'L' : 'M'}${(i * dx).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    const lastX = (vals.length - 1) * dx;
    return { line: d, area: `${d} L${lastX.toFixed(1)} ${h} L0 ${h} Z`, dx, y };
  }

  function stateOf(p, hot) {
    if (p >= hot) return 'crit';
    if (p >= hot * 0.85) return 'warn';
    return '';
  }

  // A colored bar must never be the only thing saying "this is a problem" — the
  // warning step is sub-3:1 on a light surface and invisible to some readers
  // either way. Every hot figure therefore prints the reason next to the number.
  const WORDS = {
    Memory: { warn: 'filling up', crit: 'under pressure' },
    Disk: { warn: 'filling up', crit: 'nearly full' },
    Load: { warn: 'busy', crit: 'oversubscribed' },
    CPU: { warn: 'busy', crit: 'saturated' },
  };
  const wordFor = (name, st) => (st && WORDS[name] ? WORDS[name][st] : '');

  class VcSysmon extends Vc.Element {
    static get template() { return TEMPLATE; }
    static get observedAttributes() {
      return ['show', 'top', 'compact', 'marker-mb', 'marker-label', 'hot-mem', 'hot-swap', 'hot-disk', 'hot-cpu'];
    }

    constructor() {
      super();
      this._panel = this.$('.panel');
      this._sample = null;
      this._history = [];
      this._proc = null;
      this._unsub = null;
      this._renew = null;
      this._subscribed = false;
      this._charts = {};                 // key -> chart spec, consumed by _paintCharts
      this._hover = null;                // {key, rel} — survives a repaint mid-hover
      this._onVis = () => { if (document.visibilityState === 'visible') this._renewLease(); };
      const repaint = window.Vc?.rafThrottle
        ? Vc.rafThrottle(() => this._paintCharts())
        : () => this._paintCharts();
      this._ro = typeof ResizeObserver === 'function' ? new ResizeObserver(repaint) : null;
    }

    // ---------------------------------------------------------- lifecycle

    connectedCallback() {
      this._render();
      if (this._ro) this._ro.observe(this);
      if (!this.hasAttribute('manual') && window.Bridge) this._connect();
      document.addEventListener('visibilitychange', this._onVis);
    }

    disconnectedCallback() {
      document.removeEventListener('visibilitychange', this._onVis);
      if (this._ro) this._ro.disconnect();
      if (this._renew) { clearInterval(this._renew); this._renew = null; }
      if (this._unsub) { try { this._unsub(); } catch {} this._unsub = null; }
      if (this._subscribed) {
        this._subscribed = false;
        try { window.Bridge.call('sysmon.unsubscribe', {}); } catch {}
      }
    }

    attributeChangedCallback() { if (this._panel) this._render(); }

    // Paint from the service's own history FIRST, then go live. This is the whole
    // reason history lives server-side: a reloaded GUI comes back to a populated
    // chart instead of an empty axis that takes ten minutes to become useful.
    async _connect() {
      try {
        const r = await window.Bridge.call('sysmon.get', { history: 300, processes: true });
        if (!this.isConnected) return;
        this._history = r.history || [];
        this._sample = r.sample || null;
        this._proc = r.processes || (r.breakdowns || []).slice(-1)[0] || null;
        this._render();
      } catch { /* no capability or service down: the empty state explains itself */ }

      if (!this.isConnected) return;
      this._unsub = window.Bridge.subscribe('sysmon:sample', (d) => this._onSample(d));
      try {
        const res = await window.Bridge.call('sysmon.subscribe', {});
        this._subscribed = !!(res && res.ok);
      } catch { /* leave unsubscribed; any manual data still renders */ }
      // Renew at half the lease so a long-lived view never lapses, and only while
      // visible — a background tab should be allowed to fall off the sampler.
      if (this._renew) clearInterval(this._renew);
      this._renew = setInterval(() => this._renewLease(), 5 * 60 * 1000);
    }

    _renewLease() {
      if (!this._subscribed || document.visibilityState !== 'visible' || !window.Bridge) return;
      try { window.Bridge.call('sysmon.subscribe', {}); } catch {}
    }

    _onSample(d) {
      if (!d) return;
      if (d.processes) this._proc = d.processes;
      const last = this._history[this._history.length - 1];
      // The breakdown event repeats the tick's sample; `at` dedupes it.
      if (!last || last.at !== d.at) {
        this._sample = d;
        this._history.push(d);
        if (this._history.length > 300) this._history.shift();
      }
      this._render();
      this.emit('sysmon-sample', { sample: this._sample });
    }

    // ---------------------------------------------------------- properties

    get data() { return this._sample; }
    set data(v) {
      if (!v) return;
      this._sample = v;
      const last = this._history[this._history.length - 1];
      if (!last || last.at !== v.at) this._history.push(v);
      if (this._history.length > 300) this._history.shift();
      this._render();
    }

    get processes() { return this._proc; }
    set processes(v) { this._proc = v || null; this._render(); }

    get history() { return this._history.slice(); }
    set history(v) { this._history = Array.isArray(v) ? v.slice(-300) : []; this._render(); }

    // ------------------------------------------------------------- helpers

    _shows(key) {
      const raw = this.getAttribute('show');
      if (!raw) return true;
      return raw.split(',').map((s) => s.trim()).includes(key);
    }
    _num(attr, dflt) {
      const v = Number(this.getAttribute(attr));
      return isFinite(v) && v > 0 ? v : dflt;
    }
    _spanMin() {
      if (this._history.length < 2) return 0;
      const span = this._sample.at - this._history[0].at;
      return span > 0 ? Math.max(1, Math.round(span / 60000)) : 0;
    }

    // Everything on the box, ranked — the platform, each spawned app, and the
    // non-Vistaclair processes alike. An operator asking "what is eating my RAM"
    // is not asking "…among our apps".
    _topConsumers(n) {
      const b = this._proc;
      if (!b) return [];
      const rows = [];
      if (b.platform) rows.push({ name: b.platform.label, kind: 'platform', v: b.platform.pss ?? b.platform.rss });
      for (const a of b.apps || []) rows.push({ name: a.app, kind: a.kind, v: a.pss ?? a.rss });
      for (const o of b.other || []) rows.push({ name: o.comm, kind: '', v: o.pss ?? o.rss });
      return rows.sort((x, y) => y.v - x.v).slice(0, n);
    }

    // ------------------------------------------------------------ rendering

    _render() {
      if (!this._panel) return;
      const s = this._sample;
      if (!s) {
        this._charts = {};
        this._panel.innerHTML = `<div class="empty">Waiting for the first sample…</div>`;
        return;
      }
      const compact = this.hasAttribute('compact');
      this._charts = {};
      const parts = [];

      const figs = [];
      const small = [];
      if (this._shows('mem')) (compact ? small : figs).push(compact ? this._memMeter(s) : this._memFig(s));
      if (this._shows('cpu') && s.cpu) (compact ? small : figs).push(compact ? this._cpuMeter(s) : this._cpuFig(s));
      if (figs.length) parts.push(`<div class="figs">${figs.join('')}</div>`);
      if (this._shows('top') && !compact) parts.push(this._topPanel());
      if (this._shows('swap')) small.push(this._swapPanel(s, compact));
      if (this._shows('disk')) small.push(this._diskPanel(s));
      if (this._shows('load')) small.push(this._loadPanel(s, compact));
      if (small.length) parts.push(`<div class="row">${small.join('')}</div>`);

      this._panel.innerHTML = parts.join('');
      this._paintCharts();
    }

    // --- chart pass 2: measure, then draw at one SVG unit per CSS pixel ---

    _paintCharts() {
      for (const box of this.$$('[data-chart]')) {
        const spec = this._charts[box.dataset.chart];
        if (!spec) continue;
        const w = Math.round(box.clientWidth || 0);
        if (w < 40) continue;                       // not laid out yet, or hidden
        box.innerHTML = this._chartSvg(spec, w) + (spec.hover ? '<div class="tip"></div>' : '');
        if (spec.hover) this._wireHover(box, spec, w);
      }
    }

    _chartSvg(spec, w) {
      const h = spec.h;
      const vals = spec.pts.map((p) => p.v);
      const { line, area, y } = paths(vals, w, h, spec.maxY);
      // Anchor the fill to the highest point the series reaches in this window.
      const peakY = y ? Math.min(h - 1, y(Math.max(...vals))) : 0;
      const id = `${spec.key}-${spec.h}`;
      // One override recolors line, gradient and dot together — no per-element
      // state classes to keep in sync.
      const tone = spec.tone ? ` style="--sm-series:var(--sm-${spec.tone})"` : '';

      let body = '';
      if (spec.plot) {
        body += `<rect class="plot" x=".5" y=".5" width="${(w - 1).toFixed(1)}" height="${h - 1}" rx="8"></rect>`;
      }
      // Everything inside the plot box is clipped to it, so a spike at the ceiling
      // stops at the edge instead of bleeding into the header above.
      const clipped = [];
      if (vals.length > 1) {
        clipped.push(`<path d="${area}" fill="url(#fill-${id})"></path>`);
      }
      if (spec.plot) {
        clipped.push(`<line class="grid" x1="0" y1="${(h / 2).toFixed(1)}" x2="${w}" y2="${(h / 2).toFixed(1)}"></line>`);
      }
      const markerY = spec.marker ? h - clamp01(spec.marker.at) * h : 0;
      if (spec.marker) {
        clipped.push(`<line class="marker" x1="0" y1="${markerY.toFixed(1)}" x2="${w}" y2="${markerY.toFixed(1)}"></line>`);
      }
      if (vals.length > 1) {
        clipped.push(`<path class="series-line" d="${line}"></path>`);
      }
      body += spec.plot ? `<g clip-path="url(#clip-${id})">${clipped.join('')}</g>` : clipped.join('');

      // Text and the end-dot sit OUTSIDE the clip so their halo/ring is never
      // sliced by the plot edge.
      if (spec.marker) {
        // The label rides the RIGHT edge, where the series rarely ends up, and flips
        // below the rule when the rule is near the top. When usage sits right at the
        // ceiling — exactly when this marker matters most — a label pinned above-left
        // lands on top of the line and both become unreadable.
        const ty = markerY < 14 ? markerY + 11 : markerY - 4;
        body += `<text class="marker-text" x="${w - 4}" y="${ty.toFixed(1)}" text-anchor="end">${esc(spec.marker.label)}</text>`;
      }
      if (vals.length) {
        // The dot rides the right edge — it is the current reading, and the svg is
        // overflow:visible so the half outside the plot is not clipped.
        body += `<circle class="end-dot" cx="${w}" cy="${(y ? y(vals[vals.length - 1]) : h).toFixed(1)}" r="3.5"></circle>`;
      }
      body += `<g class="hover-layer"></g>`;

      const label = spec.aria ? ` role="img" aria-label="${esc(spec.aria)}"` : ' aria-hidden="true"';
      return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${tone}${label}>
        <defs>
          <linearGradient id="fill-${id}" gradientUnits="userSpaceOnUse"
                          x1="0" y1="${peakY.toFixed(1)}" x2="0" y2="${h}">
            <stop class="grad-top" offset="0"></stop>
            <stop class="grad-bot" offset="1"></stop>
          </linearGradient>
          ${spec.plot ? `<clipPath id="clip-${id}"><rect x="0" y="0" width="${w}" height="${h}" rx="8"></rect></clipPath>` : ''}
        </defs>
        ${body}
      </svg>`;
    }

    // Crosshair + tooltip: an area chart the user can't interrogate is a picture.
    // The handler is re-attached on every repaint, and the last pointer position is
    // replayed, so a sample landing mid-hover does not drop the crosshair.
    _wireHover(box, spec, w) {
      const svg = box.querySelector('svg');
      const layer = box.querySelector('.hover-layer');
      const tip = box.querySelector('.tip');
      if (!svg || !layer || !tip || spec.pts.length < 2) return;
      const h = spec.h;

      box._apply = (rel) => {
        const i = Math.round(clamp01(rel) * (spec.pts.length - 1));
        const p = spec.pts[i];
        if (!p) return;
        const x = (i / (spec.pts.length - 1)) * w;
        const y = h - clamp01(p.v / (spec.maxY || 1)) * h;
        layer.innerHTML = `<line class="cross" x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${h}"></line>
          <circle class="end-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4"></circle>`;
        tip.innerHTML = `<b>${spec.tip(p)}</b> <span class="t-time">${new Date(p.at).toLocaleTimeString()}</span>`;
        // Pin the tip inside the plot: at either end a centred tooltip would hang
        // off the panel, and near the ceiling it would cover the header.
        const half = (tip.offsetWidth || 90) / 2;
        tip.style.left = `${Math.max(half, Math.min(w - half, x)).toFixed(1)}px`;
        tip.style.top = `${Math.max(26, y).toFixed(1)}px`;
        tip.classList.add('on');
      };

      if (!box._hooked) {
        box._hooked = true;
        box.addEventListener('pointermove', (ev) => {
          const r = box.getBoundingClientRect();
          this._hover = { key: spec.key, rel: (ev.clientX - r.left) / (r.width || 1) };
          box._apply(this._hover.rel);
        });
        box.addEventListener('pointerleave', () => {
          this._hover = null;
          layer.innerHTML = '';
          tip.classList.remove('on');
        });
      }

      if (this._hover && this._hover.key === spec.key) box._apply(this._hover.rel);
    }

    // --- memory ---
    _memFig(s) {
      const hot = this._num('hot-mem', 85);
      const p = pct(s.mem.used, s.mem.total);
      const st = stateOf(p, hot);

      // Trend over the window: the difference between "71% and steady" and "71%
      // and climbing" is the only thing that tells you whether to act.
      // A trend needs a window to be a trend. Under ~30s of samples the difference
      // between two readings is noise, and stamping "in 1 min" on it invents a slope.
      let delta = '';
      const span = this._history.length > 3 ? s.at - this._history[0].at : 0;
      if (span >= 30000) {
        const d = s.mem.used - (this._history[0].mem?.used || 0);
        const mins = Math.max(1, Math.round(span / 60000));
        if (Math.abs(d) > 32 * MB) delta = `<span class="fig-delta">${d > 0 ? '+' : '−'}${fmt(Math.abs(d))} in ${mins} min</span>`;
      }

      const markerMb = this._num('marker-mb', 0);
      const spanMin = this._spanMin();
      this._charts.mem = {
        key: 'mem', h: CHART_H, plot: true, hover: true, tone: st,
        pts: thin(this._history, 180).map((x) => ({ v: x.mem?.used || 0, at: x.at })),
        maxY: s.mem.total,
        marker: markerMb > 0 && s.mem.total > 0
          ? { at: (markerMb * MB) / s.mem.total, label: this.getAttribute('marker-label') || `${markerMb} MB` }
          : null,
        tip: (pt) => `${fmt(pt.v)} · ${pct(pt.v, s.mem.total)}%`,
        aria: `Memory used over the last ${spanMin} minutes: ${fmt(s.mem.used)} of ${fmt(s.mem.total)}`,
      };

      return `<section class="fig">
        <div class="fig-head">
          <span class="fig-label">Memory in use</span>
          <span class="fig-value">${fmt(s.mem.used)}</span>
          <span class="fig-sub">of ${fmt(s.mem.total)} · ${p}%</span>
          ${st ? `<span class="fig-state ${st}">${wordFor('Memory', st)}</span>` : ''}
          ${delta}
        </div>
        <div class="chart" data-chart="mem" style="height:${CHART_H}px"></div>
        <div class="fig-head fig-foot">
          <span class="fig-sub">${spanMin ? `last ${spanMin} min` : 'collecting…'}</span>
          <span class="fig-sub">${fmt(s.mem.available)} available</span>
        </div>
      </section>`;
    }

    // --- CPU: the same figure shape as memory, plus the per-core strip ---
    // Load average and CPU busy answer different questions (queue depth vs. work
    // actually done), so both are on the panel and neither is derived from the other.
    _cpuFig(s) {
      const c = s.cpu;
      const hot = this._num('hot-cpu', 90);
      const cur = c.usage == null ? null : Math.round(c.usage * 100);
      const st = cur == null ? '' : stateOf(cur, hot);
      const pts = thin(this._history.filter((x) => x.cpu && x.cpu.usage != null), 180)
        .map((x) => ({ v: x.cpu.usage * 100, at: x.at }));
      const peak = pts.length ? Math.round(Math.max(...pts.map((x) => x.v))) : 0;
      const spanMin = this._spanMin();

      this._charts.cpu = {
        key: 'cpu', h: CHART_H, plot: true, hover: true, tone: st,
        pts, maxY: 100, marker: null,
        tip: (pt) => `${Math.round(pt.v)}% busy`,
        aria: `CPU busy over the last ${spanMin} minutes: ${cur == null ? 'measuring' : cur + '%'} across ${c.count} cores`,
      };

      // A core doing nothing draws nothing — a minimum stub height would report
      // activity on an idle core. Anything above zero gets a 3px floor so a 1%
      // core is still visible.
      const cores = (c.cores || []).map((v, i) => {
        const cp = v == null ? 0 : Math.round(v * 100);
        return `<div class="core" title="core ${i} · ${v == null ? '—' : cp + '%'}">`
          + `<i style="height:${cp}%${cp > 0 ? ';min-height:3px' : ''}"></i></div>`;
      }).join('');

      // iowait is the tell for a thrashing box, so it displaces the peak readout
      // the moment it is large enough to matter.
      const io = c.iowait != null && c.iowait >= 0.02
        ? `<span class="fig-sub">io wait ${Math.round(c.iowait * 100)}%</span>`
        : `<span class="fig-sub">${pts.length > 1 ? `peak ${peak}%` : ''}</span>`;

      return `<section class="fig">
        <div class="fig-head">
          <span class="fig-label">CPU busy</span>
          <span class="fig-value">${cur == null ? '—' : cur + '%'}</span>
          <span class="fig-sub"${c.model ? ` title="${esc(c.model)}"` : ''}>across ${c.count} core${c.count === 1 ? '' : 's'}</span>
          ${st ? `<span class="fig-state ${st}">${wordFor('CPU', st)}</span>` : ''}
        </div>
        <div class="chart" data-chart="cpu" style="height:${CHART_H}px"></div>
        ${cores ? `<div class="cores"${st ? ` style="--sm-series:var(--sm-${st})"` : ''} role="img"
             aria-label="${c.count} cores, each bar one core: ${(c.cores || []).map((v, i) => `${i}: ${v == null ? '—' : Math.round(v * 100) + '%'}`).join(', ')}">${cores}</div>` : ''}
        <div class="fig-head fig-foot">
          <span class="fig-sub">${spanMin ? `last ${spanMin} min` : 'collecting…'}</span>
          ${io}
        </div>
      </section>`;
    }

    // --- top consumers ---
    _topPanel() {
      const n = Math.max(1, Math.min(10, Number(this.getAttribute('top')) || 3));
      const rows = this._topConsumers(n);
      if (!rows.length) return `<section><div class="sec-label">Top memory use</div><div class="empty">No breakdown yet.</div></section>`;
      const max = rows[0].v || 1;
      const items = rows.map((r) => `
        <div class="top-item">
          <span class="top-name" title="${esc(r.name)}">${esc(r.name)}${r.kind && r.kind !== 'platform' ? `<span class="kind">${esc(r.kind)}</span>` : ''}</span>
          <span class="top-val">${fmt(r.v)}</span>
          <div class="top-bar" style="width:${Math.max(2, (100 * r.v) / max).toFixed(1)}%"></div>
        </div>`).join('');
      return `<section>
        <div class="sec-label">Top ${rows.length} by memory</div>
        <div class="top-list">${items}</div>
      </section>`;
    }

    // --- swap: the sparkline IS the point (climbing swap precedes an OOM) ---
    _swapPanel(s, compact) {
      if (!s.swap || !s.swap.total) {
        return `<div class="meter-row"><div class="meter-head"><span class="meter-name">Swap</span>
          <span class="meter-val">none</span></div></div>`;
      }
      const hot = this._num('hot-swap', 5);
      const p = pct(s.swap.used, s.swap.total);
      const st = stateOf(p, hot);
      const word = st ? 'swapping' : 'quiet';
      if (compact) return this._meter('Swap', `${fmt(s.swap.used)} · ${word}`, p, st);
      const pts = thin(this._history, 80).map((x) => ({ v: x.swap?.used || 0, at: x.at }));
      const peak = pts.length ? Math.max(...pts.map((x) => x.v)) : 0;
      // A flat line pinned at zero is not a chart, it is a stray rule. Swap earns a
      // sparkline only once there is movement worth a shape; until then the word
      // "quiet" plus an empty meter says everything there is to say.
      const live = pts.length > 1 && peak > Math.max(64 * MB, s.swap.total * 0.005);
      if (live) {
        this._charts.swap = { key: 'swap', h: SPARK_H, plot: false, hover: false, tone: st, pts, maxY: peak * 1.15, marker: null };
      }
      const body = live
        ? `<div class="chart" data-chart="swap" style="height:${SPARK_H}px"></div>`
        : `<div class="track"><div class="fill ${st}" style="width:${p > 0 ? Math.max(p, 2) : 0}%"></div></div>`;
      return `<div class="meter-row">
        <div class="meter-head"><span class="meter-name">Swap</span>
          <span class="meter-val">${fmt(s.swap.used)} <span class="fig-state ${st}">${word}</span></span></div>
        <div class="meter-body">${body}</div>
      </div>`;
    }

    // Disk moves too slowly for a chart — a meter answers it completely.
    _diskPanel(s) {
      if (!s.disk || !s.disk.total) {
        return `<div class="meter-row"><div class="meter-head"><span class="meter-name">Disk</span>
          <span class="meter-val">unknown</span></div></div>`;
      }
      const used = s.disk.total - s.disk.free;
      const p = pct(used, s.disk.total);
      return this._meter('Disk', `${fmt(s.disk.free)} free`, p, stateOf(p, this._num('hot-disk', 90)));
    }

    _loadPanel(s, compact) {
      const cpus = s.cpus || 1;
      const p = pct(s.load1, cpus);
      const st = stateOf(p, 100);
      const pts = thin(this._history, 80).map((x) => ({ v: x.load1 || 0, at: x.at }));
      const word = wordFor('Load', st);
      const avgs = [s.load1, s.load5, s.load15].filter((v) => v != null)
        .map((v) => v.toFixed(2)).join(' · ');
      // Same rule as swap: a line pinned flat near the floor is a stray rule, not a
      // chart. Load earns a sparkline once it has moved across a readable slice of
      // the core count.
      const range = pts.length ? Math.max(...pts.map((x) => x.v)) - Math.min(...pts.map((x) => x.v)) : 0;
      if (compact || pts.length < 2 || range < cpus * 0.05) {
        return this._meter('Load', `${(s.load1 || 0).toFixed(2)} of ${cpus}`, p, st);
      }
      this._charts.load = {
        key: 'load', h: SPARK_H, plot: false, hover: false, tone: st, marker: null,
        pts, maxY: Math.max(cpus, ...pts.map((x) => x.v)),
      };
      return `<div class="meter-row" title="1 / 5 / 15 min load: ${avgs}">
        <div class="meter-head"><span class="meter-name">Load</span>
          <span class="meter-val">${(s.load1 || 0).toFixed(2)} <span class="fig-sub">of ${cpus} cores</span>${
            word ? ` <span class="fig-state ${st}">${word}</span>` : ''}</span></div>
        <div class="meter-body"><div class="chart" data-chart="load" style="height:${SPARK_H}px"></div></div>
      </div>`;
    }

    _meter(name, valText, p, st) {
      const markerMb = name === 'Memory' ? this._num('marker-mb', 0) : 0;
      let tick = '';
      if (markerMb > 0 && this._sample?.mem?.total) {
        const mp = Math.min(100, (markerMb * MB * 100) / this._sample.mem.total);
        tick = `<span class="tick" style="left:${mp.toFixed(1)}%"></span>`;
      }
      const word = wordFor(name, st);
      return `<div class="meter-row">
        <div class="meter-head"><span class="meter-name">${esc(name)}</span>
          <span class="meter-val">${valText}${word ? ` <span class="fig-state ${st}">${word}</span>` : ''}</span></div>
        <div class="meter-body"><div class="track">${tick}<div class="fill ${st}" style="width:${Math.min(100, p)}%"></div></div></div>
      </div>`;
    }

    _memMeter(s) {
      const p = pct(s.mem.used, s.mem.total);
      return this._meter('Memory', `${fmt(s.mem.used)} / ${fmt(s.mem.total)} · ${p}%`, p, stateOf(p, this._num('hot-mem', 85)));
    }

    _cpuMeter(s) {
      const c = s.cpu;
      const p = c.usage == null ? 0 : Math.round(c.usage * 100);
      return this._meter('CPU', `${c.usage == null ? '—' : p + '%'} of ${c.count} cores`, p, stateOf(p, this._num('hot-cpu', 90)));
    }
  }

  Vc.define('vc-sysmon', VcSysmon);
})();
