// <vc-site-status site="main"> — live card for one of the app's own sites
// (manifest.sites): state, port, uptime, requests/s, memory, crashes, fence, last error.
//
// Part of the vistaclair `vc-*` component system. Shadow-DOM, theme-aware,
// built on vc-core (`Vc.Element`). Backed by the platform sites engine
// (`sites.status`); it reads once on connect and then follows the `site:status`,
// `site:crashed` and `site:published` events — it never polls.
//
// Usage:
//   <vc-site-status site="main"></vc-site-status>
//   <vc-site-status site="main" compact></vc-site-status>      // one line
//
// Attributes: site (required), compact.
// Properties: status (the last status object; setting it renders it).

(function () {
  'use strict';

  const TEMPLATE = `
    <style>
      :host {
        display: block;
        --ss-ok: #3fb950;
        --ss-warn: #fab219;
        --ss-crit: #d03b3b;
        --ss-ink: var(--text, #c0caf5);
        --ss-dim: var(--text-dim, #565f89);
        --ss-border: var(--border, #414868);
        --ss-surface: var(--bg-surface, #24283b);
      }
      .card { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px;
              border: 1px solid var(--ss-border); border-radius: 8px; background: var(--ss-surface);
              color: var(--ss-ink); font-size: 13px; }
      .card.compact { flex-direction: row; align-items: center; flex-wrap: wrap; gap: 4px 12px; padding: 4px 8px; }
      .head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--ss-dim); }
      .dot.ok { background: var(--ss-ok); }
      .dot.warn { background: var(--ss-warn); }
      .dot.bad { background: var(--ss-crit); }
      .name { font-weight: 600; }
      .state { font-weight: 600; }
      .meta { display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--ss-dim); font-size: 12px; font-variant-numeric: tabular-nums; }
      .meta .warn { color: var(--ss-warn); font-weight: 600; }
      .meta .bad { color: var(--ss-crit); font-weight: 600; }
      .err { font-size: 12px; color: var(--ss-crit); overflow-wrap: anywhere; }
      .empty { font-size: 12px; color: var(--ss-dim); }
    </style>
    <div class="card" part="card"></div>
  `;

  const esc = (s) => (window.Vc ? Vc.escapeHtml(s) : String(s == null ? '' : s));
  const fmt = (n) => (window.Vc ? Vc.formatBytes(n) : Math.round(n / 1048576) + ' MB');
  const DOT = { running: 'ok', starting: 'warn', stopping: 'warn', backoff: 'warn', crashed: 'bad', error: 'bad', stopped: '' };

  function fmtUp(ms) {
    const s = Math.floor((ms || 0) / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
  }

  class VcSiteStatus extends Vc.Element {
    static get template() { return TEMPLATE; }
    static get observedAttributes() { return ['site', 'compact']; }

    constructor() {
      super();
      this._card = this.$('.card');
      this._st = null;
      this._unsubs = [];
      this._tick = null;
    }

    connectedCallback() {
      this._render();
      if (window.Bridge) this._connect();
    }

    disconnectedCallback() {
      for (const u of this._unsubs) { try { u(); } catch {} }
      this._unsubs = [];
      if (this._tick) { clearInterval(this._tick); this._tick = null; }
    }

    attributeChangedCallback(name, oldV, newV) {
      if (!this._card || oldV === newV) return;
      if (name === 'site' && this.isConnected && window.Bridge) { this._st = null; this._load(); }
      this._render();
    }

    get site() { return this.getAttribute('site') || ''; }
    get status() { return this._st; }
    set status(v) { this._st = v && typeof v === 'object' ? v : null; this._render(); }

    async _load() {
      if (!this.site) return;
      try {
        const st = await window.Bridge.call('sites.status', { site: this.site });
        if (!this.isConnected || !st) return;
        this._st = st;
        this._render();
      } catch { /* no capability or unknown site: the empty state explains itself */ }
    }

    async _connect() {
      await this._load();
      if (!this.isConnected || this._unsubs.length) return;
      const on = (p) => {
        const d = p && p.site === undefined && p.data ? p.data : p;
        if (!d || d.site !== this.site) return;
        if (d.status) { this._st = d.status; this._render(); }
        else this._load();
      };
      for (const ev of ['site:status', 'site:crashed', 'site:published']) this._unsubs.push(window.Bridge.subscribe(ev, on));
      // Uptime is the only figure that moves between events; redraw it locally.
      this._tick = setInterval(() => { if (this._st && this._st.state === 'running') this._render(); }, 15000);
    }

    _render() {
      const st = this._st;
      const compact = this.hasAttribute('compact');
      this._card.className = 'card' + (compact ? ' compact' : '');
      if (!st) {
        this._card.innerHTML = `<span class="empty">${this.site ? esc(this.site) + ': no status yet' : 'vc-site-status: set the site attribute'}</span>`;
        return;
      }
      const up = st.state === 'running' ? (st.startedAt ? Date.now() - st.startedAt : st.uptimeMs) : 0;
      const bits = [];
      if (st.port) bits.push(`<span>:${esc(st.port)}</span>`);
      if (st.state === 'running') {
        bits.push(`<span>up ${esc(fmtUp(up))}</span>`, `<span>${esc(st.reqPerSec || 0)} req/s</span>`);
        if (st.mem != null) bits.push(`<span>${esc(fmt(st.mem))}</span>`);
      }
      if (st.crashCount) bits.push(`<span class="warn">${esc(st.crashCount)} crash${st.crashCount === 1 ? '' : 'es'}</span>`);
      bits.push(st.fence === 'fenced' ? '<span>fenced</span>' : '<span class="warn">unfenced</span>');
      const head = `<div class="head"><span class="dot ${DOT[st.state] || ''}"></span><span class="name">${esc(st.site || this.site)}</span><span class="state">${esc(st.state)}</span></div>`;
      const meta = `<div class="meta">${bits.join('')}</div>`;
      const err = st.lastError && !compact ? `<div class="err">${esc(st.lastError)}</div>` : '';
      this._card.innerHTML = head + meta + err;
      this._card.title = st.lastError || '';
    }
  }

  Vc.define('vc-site-status', VcSiteStatus);
})();
