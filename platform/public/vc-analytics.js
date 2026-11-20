// <vc-analytics site="main"> — a site's statistics (manifest.sites.<site>.analytics).
//
// Part of the vistaclair `vc-*` component system. Shadow-DOM, theme-aware, built
// on vc-core (`Vc.Element`). Backed by the platform analytics capability
// (`analytics.query` / `analytics.live`): it reads once on connect and then
// follows the `analytics:live` event — it never polls. Charts are inline SVG.
//
// Usage:
//   <vc-analytics site="main"></vc-analytics>
//   <vc-analytics site="main" range="30"></vc-analytics>
//
// Attributes: site (required), range (7 | 30 | 90 days, default 30).
// Properties: transport ({ call('query'|'live'|'csv', { site, …params }), on(event, fn) → off })
//   for pages with no app Bridge (the dashboard's own Sites tab); default Bridge.
// Events: analytics-filter { filters } when a drill-down changes.
//
// The data layer (`Vc.analyticsData.load`) is plain functions over a `call`, so the
// numbers the component draws can be checked without a DOM.

(function () {
  'use strict';

  const CREDIT = { text: 'IP geolocation by DB-IP', url: 'https://db-ip.com' };
  const RANGES = [7, 30, 90];
  // The tables under the chart: id, title, query, whether a row click filters the view.
  const PANELS = [
    { id: 'pages', title: 'Top pages', groupBy: 'path', metrics: ['pageviews', 'visitors'], filter: 'path' },
    { id: 'referrers', title: 'Referrers', groupBy: 'referrer', metrics: ['pageviews', 'visitors'], filter: 'referrer', empty: '(direct)' },
    { id: 'campaigns', title: 'UTM campaigns', groupBy: 'utm_campaign', metrics: ['pageviews', 'visitors'], filter: 'utm_campaign', skipEmpty: true },
    { id: 'countries', title: 'Countries', groupBy: 'country', metrics: ['pageviews', 'visitors'], filter: 'country', empty: 'unknown', credit: true },
    { id: 'browsers', title: 'Browsers', groupBy: 'browser', metrics: ['pageviews', 'visitors'], filter: 'browser', empty: 'unknown' },
    { id: 'os', title: 'Operating systems', groupBy: 'os', metrics: ['pageviews', 'visitors'], filter: 'os', empty: 'unknown' },
    { id: 'devices', title: 'Devices', groupBy: 'device', metrics: ['pageviews', 'visitors'], filter: 'device', empty: 'unknown' },
    { id: 'languages', title: 'Languages', groupBy: 'lang', metrics: ['pageviews', 'visitors'], filter: 'lang', empty: 'unknown' },
    { id: 'notfound', title: '404s', groupBy: 'path', metrics: ['hits'], extraFilters: { status: '404' } },
    { id: 'goals', title: 'Goals', groupBy: 'event', metrics: ['events', 'visitors'], noFilter: true },
  ];
  const FILTER_DIMS = PANELS.filter((p) => p.filter).map((p) => p.filter);

  const dayAdd = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const todayUtc = () => new Date().toISOString().slice(0, 10);

  // → { cur: { from, to }, prev: { from, to } } for a range of `days` ending `today`
  function periodRanges(days, today) {
    const from = dayAdd(today, -(days - 1));
    return { cur: { from, to: today }, prev: { from: dayAdd(from, -days), to: dayAdd(from, -1) } };
  }
  const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

  // Everything the view draws, from `call('query' | 'live', { site, … })`.
  async function load(call, { site, range = 30, filters = {}, today = todayUtc() }) {
    const R = periodRanges(range, today);
    const q = (extra) => call('query', { site, filters, ...extra });
    const safe = (p) => p.catch((e) => ({ _error: e }));
    const [live, tToday, t7, t30, cur, prev, series, bots, ...panels] = await Promise.all([
      safe(call('live', { site })),
      safe(q({ from: today, to: today, metrics: ['visitors', 'pageviews'] })),
      safe(q({ from: dayAdd(today, -6), to: today, metrics: ['visitors', 'pageviews'] })),
      safe(q({ from: dayAdd(today, -29), to: today, metrics: ['visitors', 'pageviews'] })),
      safe(q({ ...R.cur, metrics: ['visitors', 'pageviews', 'bounceRate'] })),
      safe(q({ ...R.prev, metrics: ['visitors', 'pageviews'] })),
      safe(q({ ...R.cur, metrics: ['visitors', 'pageviews'], groupBy: ['day'] })),
      safe(call('query', { site, ...R.cur, metrics: ['hits'], groupBy: ['bot'], bots: 'include', scope: 'requests' })),
      ...PANELS.map((p) => safe(call('query', {
        site, ...R.cur, metrics: p.metrics, groupBy: [p.groupBy], limit: 10,
        filters: p.groupBy === 'event' ? {} : { ...filters, ...(p.extraFilters || {}) },
      }))),
    ]);
    const all = [tToday, t7, t30, cur, prev, series, bots, ...panels];
    const failed = all.find((r) => r && r._error);
    if (failed) throw failed._error;
    const tot = (r) => (r && r.totals) || {};
    // fill the days that had no traffic so the chart keeps its shape
    const byDay = new Map((series.rows || []).map((r) => [r.day, r]));
    const days = [];
    for (let d = R.cur.from; d <= R.cur.to; d = dayAdd(d, 1)) days.push({ day: d, visitors: (byDay.get(d) || {}).visitors || 0, pageviews: (byDay.get(d) || {}).pageviews || 0 });
    const botHits = (bots.rows || []).reduce((a, r) => { a[r.bot] = r.hits; return a; }, {});
    const model = {
      site, range, filters, today,
      live: live && typeof live.live === 'number' ? live.live : 0,
      tiles: {
        today: { visitors: tot(tToday).visitors || 0, pageviews: tot(tToday).pageviews || 0 },
        d7: { visitors: tot(t7).visitors || 0, pageviews: tot(t7).pageviews || 0 },
        d30: { visitors: tot(t30).visitors || 0, pageviews: tot(t30).pageviews || 0 },
        range: { visitors: tot(cur).visitors || 0, pageviews: tot(cur).pageviews || 0 },
        bounceRate: tot(cur).bounceRate === undefined ? null : tot(cur).bounceRate,
        trend: { visitors: pct(tot(cur).visitors || 0, tot(prev).visitors || 0), pageviews: pct(tot(cur).pageviews || 0, tot(prev).pageviews || 0) },
      },
      days,
      bots: { human: botHits.human || 0, bot: botHits.bot || 0 },
      panels: {},
      notes: [],
    };
    PANELS.forEach((p, i) => {
      let rows = panels[i].rows || [];
      if (p.skipEmpty) rows = rows.filter((r) => r[p.groupBy] !== '');
      model.panels[p.id] = rows.map((r) => ({ key: r[p.groupBy], label: r[p.groupBy] === '' ? (p.empty || '(none)') : String(r[p.groupBy]), ...r }));
    });
    for (const r of all) if (r && r.source && r.source.skipped) { model.notes.push(`Days from ${r.source.skipped[0]} to ${r.source.skipped[1]} are kept as daily totals only: a filter or breakdown there is left out.`); break; }
    model.credit = panels[PANELS.findIndex((p) => p.id === 'countries')].credit || null;
    return model;
  }

  const api = { load, periodRanges, PANELS, FILTER_DIMS, CREDIT, RANGES };
  if (typeof window !== 'undefined') { window.Vc = window.Vc || {}; window.Vc.analyticsData = api; }
  if (typeof Vc === 'undefined' || !Vc.define || !Vc.Element) return;

  const TEMPLATE = `
    <style>
      :host { display: block; --va-ink: var(--text, #c0caf5); --va-dim: var(--text-dim, #565f89);
        --va-border: var(--border, #414868); --va-surface: var(--bg-surface, #24283b);
        --va-accent: var(--accent, #7aa2f7); --va-ok: #3fb950; --va-crit: #d03b3b; color: var(--va-ink); font-size: 13px; }
      .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
      .bar .grow { flex: 1; }
      .seg { display: inline-flex; border: 1px solid var(--va-border); border-radius: 6px; overflow: hidden; }
      .seg button, .btn { background: transparent; color: var(--va-ink); border: 0; padding: 3px 10px; font: inherit; cursor: pointer; }
      .btn { border: 1px solid var(--va-border); border-radius: 6px; }
      .seg button.on { background: var(--va-accent); color: #fff; }
      .chip { display: inline-flex; gap: 6px; align-items: center; padding: 2px 8px; border-radius: 999px; background: var(--va-surface); border: 1px solid var(--va-accent); cursor: pointer; }
      .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; margin-bottom: 12px; }
      .tile { padding: 8px 10px; border: 1px solid var(--va-border); border-radius: 8px; background: var(--va-surface); }
      .tile .k { color: var(--va-dim); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
      .tile .v { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
      .tile .s { color: var(--va-dim); font-size: 11px; font-variant-numeric: tabular-nums; }
      .up { color: var(--va-ok); } .down { color: var(--va-crit); }
      .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--va-ok); margin-right: 5px; }
      .chart { border: 1px solid var(--va-border); border-radius: 8px; background: var(--va-surface); padding: 8px 10px; margin-bottom: 12px; }
      .chart svg { width: 100%; height: 130px; display: block; }
      .chart .legend { color: var(--va-dim); font-size: 11px; display: flex; gap: 12px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
      .panel { border: 1px solid var(--va-border); border-radius: 8px; background: var(--va-surface); padding: 8px 10px; min-width: 0; }
      .panel h4 { margin: 0 0 6px; font-size: 12px; display: flex; justify-content: space-between; align-items: center; }
      .panel h4 a { color: var(--va-dim); font-weight: 400; cursor: pointer; font-size: 11px; }
      .row { position: relative; display: flex; justify-content: space-between; gap: 8px; padding: 2px 4px; border-radius: 4px; font-variant-numeric: tabular-nums; }
      .row.click { cursor: pointer; } .row.click:hover { outline: 1px solid var(--va-border); }
      .row .fill { position: absolute; inset: 0 auto 0 0; background: var(--va-accent); opacity: .16; border-radius: 4px; }
      .row .l { position: relative; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .row .n { position: relative; color: var(--va-dim); white-space: nowrap; }
      .none { color: var(--va-dim); }
      .msg { padding: 14px; border: 1px dashed var(--va-border); border-radius: 8px; color: var(--va-dim); }
      .note { color: var(--va-dim); font-size: 11px; margin: 6px 0; }
      .credit { color: var(--va-dim); font-size: 11px; margin-top: 6px; } .credit a { color: inherit; }
    </style>
    <div class="root"></div>
  `;

  const esc = (s) => Vc.escapeHtml(s == null ? '' : s);
  const num = (n) => (n == null ? '–' : Number(n).toLocaleString());
  const trend = (p) => (p == null ? '' : `<span class="${p >= 0 ? 'up' : 'down'}">${p >= 0 ? '▲' : '▼'} ${Math.abs(p)}%</span> vs previous`);

  function downloadText(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // visitors (bars) and pageviews (line) per day, inline SVG
  function chartSvg(days) {
    const W = 600, H = 120, pad = 4;
    const max = Math.max(1, ...days.map((d) => Math.max(d.visitors, d.pageviews)));
    const n = days.length || 1;
    const bw = W / n;
    const y = (v) => H - pad - ((H - 2 * pad) * v) / max;
    const bars = days.map((d, i) => `<rect x="${(i * bw + bw * 0.12).toFixed(1)}" y="${y(d.visitors).toFixed(1)}" width="${(bw * 0.76).toFixed(1)}" height="${Math.max(0, H - pad - y(d.visitors)).toFixed(1)}" rx="2" fill="var(--va-accent)" opacity=".75"><title>${esc(d.day)}: ${d.visitors} visitors, ${d.pageviews} pageviews</title></rect>`).join('');
    const line = days.map((d, i) => `${i ? 'L' : 'M'}${(i * bw + bw / 2).toFixed(1)},${y(d.pageviews).toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Visitors per day">${bars}<path d="${line}" fill="none" stroke="var(--va-ok)" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
  }

  class VcAnalytics extends Vc.Element {
    static get template() { return TEMPLATE; }
    static get observedAttributes() { return ['site', 'range']; }

    constructor() {
      super();
      this._root = this.$('.root');
      this._filters = {};
      this._range = 30;
      this._model = null;
      this._error = null;
      this._unsubs = [];
      this._timer = null;
      this._transport = null;
      this._seq = 0;
    }

    connectedCallback() {
      const r = Number(this.getAttribute('range'));
      if (RANGES.includes(r)) this._range = r;
      this._root.addEventListener('click', (e) => this._click(e));
      this._start();
    }
    disconnectedCallback() {
      for (const u of this._unsubs) { try { u(); } catch { /* gone */ } }
      this._unsubs = [];
      clearTimeout(this._timer);
    }
    attributeChangedCallback(name, oldV, newV) {
      if (oldV === newV || !this.isConnected) return;
      if (name === 'range' && RANGES.includes(Number(newV))) this._range = Number(newV);
      this._filters = {};
      this._reload();
    }

    get site() { return this.getAttribute('site') || ''; }
    get transport() { return this._transport; }
    set transport(t) { this._transport = t; if (this.isConnected) this._start(); }
    get filters() { return { ...this._filters }; }
    get data() { return this._model; }

    _bridge() {
      if (this._transport) return this._transport;
      const B = window.Bridge;
      if (!B) return null;
      return { call: (m, p) => B.call('analytics.' + m, p), on: (ev, fn) => B.subscribe(ev, fn) };
    }

    _start() {
      for (const u of this._unsubs) { try { u(); } catch { /* gone */ } }
      this._unsubs = [];
      const t = this._bridge();
      if (!this.site || !t) { this._root.innerHTML = `<div class="msg">${this.site ? 'No platform connection to read analytics from.' : 'vc-analytics: set the site attribute'}</div>`; return; }
      // events instead of polling: a batch of hits arrived, or the live window moved
      const off = t.on('analytics:live', (p) => {
        const d = p && p.site === undefined && p.data ? p.data : p;
        if (!d || d.site !== this.site) return;
        if (this._model && typeof d.live === 'number') { this._model.live = d.live; this._paintLive(); }
        if (d.added) { clearTimeout(this._timer); this._timer = setTimeout(() => this._reload(), 1500); }
      });
      if (typeof off === 'function') this._unsubs.push(off);
      this._reload();
    }

    async _reload() {
      const t = this._bridge();
      if (!t || !this.site) return;
      const mine = ++this._seq;
      try {
        const model = await load(t.call, { site: this.site, range: this._range, filters: this._filters });
        if (mine !== this._seq || !this.isConnected) return;
        this._model = model; this._error = null;
      } catch (e) {
        if (mine !== this._seq) return;
        this._error = e; this._model = null;
      }
      this._render();
    }

    _paintLive() {
      const el = this._root.querySelector('[data-live]');
      if (el) el.textContent = num(this._model.live);
    }

    _csv(panelId) {
      const t = this._bridge();
      const p = PANELS.find((x) => x.id === panelId);
      const R = periodRanges(this._range, todayUtc()).cur;
      const params = p
        ? { site: this.site, ...R, metrics: p.metrics, groupBy: [p.groupBy], limit: 5000, filters: p.groupBy === 'event' ? {} : { ...this._filters, ...(p.extraFilters || {}) } }
        : { site: this.site, ...R, metrics: ['visitors', 'pageviews', 'bounceRate'], groupBy: ['day'], filters: this._filters };
      t.call('csv', params).then((r) => downloadText(`${this.site}-${panelId || 'days'}-${R.from}_${R.to}.csv`, (r && r.csv) || '')).catch(() => {});
    }

    _click(e) {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const act = el.dataset.act;
      if (act === 'range') { this._range = Number(el.dataset.v); this._reload(); }
      else if (act === 'filter') { this._filters = { ...this._filters, [el.dataset.dim]: el.dataset.v }; this._changed(); }
      else if (act === 'unfilter') { const f = { ...this._filters }; delete f[el.dataset.dim]; this._filters = f; this._changed(); }
      else if (act === 'csv') this._csv(el.dataset.v || '');
    }
    _changed() {
      this.dispatchEvent(new CustomEvent('analytics-filter', { detail: { filters: this.filters }, bubbles: true, composed: true }));
      this._reload();
    }

    _render() {
      const m = this._model;
      if (this._error) {
        const code = this._error.code || '';
        const text = code === 'no_database' ? 'No database configured on this host. Visits are kept in the site\'s spool and appear here once a database is connected.'
          : code === 'analytics_off' ? `Analytics is off for this site. Set "analytics": true in manifest.sites.${this.site}.`
          : this._error.message || 'Could not read the analytics.';
        this._root.innerHTML = `<div class="msg">${esc(text)}</div>`;
        return;
      }
      if (!m) { this._root.innerHTML = '<div class="msg">Loading…</div>'; return; }
      const T = m.tiles;
      const chips = Object.entries(m.filters).map(([k, v]) => `<span class="chip" data-act="unfilter" data-dim="${esc(k)}" title="Clear">${esc(k)}: ${esc(v)} ✕</span>`).join('');
      const seg = RANGES.map((r) => `<button data-act="range" data-v="${r}" class="${r === m.range ? 'on' : ''}">${r} d</button>`).join('');
      const tile = (k, v, s) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s || ''}</div></div>`;
      const panel = (p) => {
        const rows = m.panels[p.id] || [];
        const max = Math.max(1, ...rows.map((r) => r[p.metrics[0]] || 0));
        const body = rows.length ? rows.map((r) => {
          const main = r[p.metrics[0]] || 0;
          const click = p.filter && !p.noFilter;
          return `<div class="row${click ? ' click' : ''}" ${click ? `data-act="filter" data-dim="${esc(p.filter)}" data-v="${esc(r.key)}"` : ''} title="${esc(r.label)}"><span class="fill" style="width:${Math.round((main / max) * 100)}%"></span><span class="l">${esc(r.label)}</span><span class="n">${num(main)}${p.metrics[1] ? ` · ${num(r[p.metrics[1]])}` : ''}</span></div>`;
        }).join('') : '<div class="none">no data</div>';
        const credit = p.credit && m.credit ? `<div class="credit"><a href="${esc(m.credit.url)}" target="_blank" rel="noopener">${esc(m.credit.text)}</a></div>` : '';
        return `<div class="panel"><h4><span>${esc(p.title)}</span><a data-act="csv" data-v="${esc(p.id)}">CSV</a></h4>${body}${credit}</div>`;
      };
      this._root.innerHTML = `
        <div class="bar"><span class="seg">${seg}</span>${chips}<span class="grow"></span><button class="btn" data-act="csv" data-v="">CSV</button></div>
        <div class="tiles">
          ${tile('Live now', `<span class="dot"></span><span data-live>${num(m.live)}</span>`, 'last 5 minutes')}
          ${tile('Visitors today', num(T.today.visitors), `${num(T.today.pageviews)} pageviews`)}
          ${tile('Visitors 7 d', num(T.d7.visitors), `${num(T.d7.pageviews)} pageviews`)}
          ${tile('Visitors 30 d', num(T.d30.visitors), `${num(T.d30.pageviews)} pageviews`)}
          ${tile(`Visitors ${m.range} d`, num(T.range.visitors), trend(T.trend.visitors))}
          ${tile(`Pageviews ${m.range} d`, num(T.range.pageviews), trend(T.trend.pageviews))}
          ${tile('Bounce rate', T.bounceRate == null ? '–' : Math.round(T.bounceRate * 100) + '%', 'one-page visits')}
          ${tile('Bots', num(m.bots.bot), `${num(m.bots.human)} human requests`)}
        </div>
        <div class="chart"><div class="legend"><span>Visitors per day</span><span class="up">— pageviews</span></div>${chartSvg(m.days)}</div>
        ${m.notes.map((n) => `<div class="note">${esc(n)}</div>`).join('')}
        <div class="grid">${PANELS.map(panel).join('')}</div>`;
    }
  }

  Vc.define('vc-analytics', VcAnalytics);
})();
