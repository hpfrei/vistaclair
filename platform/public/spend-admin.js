// === Spend & Permissions admin UI (Pro client module) ===
// Loads after apps.js. Owns everything the platform admin sees about spend:
//   • the header mode pill (Local / Deployed) with its reason + override
//   • the per-app "Spend & permissions" panel (presets per mode, caps,
//     grants grid, ledger breakdown, cost sheet)
//   • the Spend overview (every app in one table, host policy, unit prices)
//   • the apps-table spend cell + the settings modal's Spend tab (mountPolicy)
// All data comes from the server's spend-admin views over the 'app:spend:*'
// messages; nothing here is computed from app GUIs.
(function () {
  'use strict';

  const S = { mode: null, meta: {}, alerts: [], onApp: null, onOverview: null, onSaved: null, onError: null };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const send = (m) => window.dashboard && window.dashboard.sendWs(m);
  const toast = (o) => window.dashboard && window.dashboard.showToast && window.dashboard.showToast(o);
  const isUnl = (v) => v === 'unlimited' || v === undefined || v === null;
  const fmtCap = (v) => (isUnl(v) ? '∞' : Number(v).toLocaleString());
  const fmtMB = (b) => (b == null ? '–' : `${Math.abs(b / 1e6) >= 100 ? Math.round(b / 1e6) : +(b / 1e6).toFixed(1)} MB`);
  const cr = (n) => `${Math.round(Number(n) || 0).toLocaleString()} cr`;
  const usd = (u) => `$${(Number(u) || 0).toFixed(2)}`;
  const PRESET_LABEL = { unlimited: 'Unlimited', metered: 'Metered', budgeted: 'Budgeted', locked: 'Locked', custom: 'Custom' };
  const PRESET_DESC = {
    unlimited: 'Everything passes. No identity, no meter keys, no caps. Spend is still recorded.',
    metered: 'Caps per app and per user in credits; spend without a known user is capped at zero.',
    budgeted: 'The same caps as Metered, but spend with no known user draws on the same pool instead of being refused.',
    locked: 'Paused — every metered call fails until you change this.',
    custom: 'Set every cap, rate and alert yourself.',
  };
  const COST_BADGE = { free: 'free', metered: 'metered', external: 'own keys' };

  // --- messages ---------------------------------------------------------------

  function onMessage(msg) {
    switch (msg.type) {
      case 'app:spend:mode': S.mode = msg; renderPill(); break;
      case 'app:spend:app': if (S.onApp) S.onApp(msg); break;
      case 'app:spend:overview': if (S.onOverview) S.onOverview(msg); break;
      case 'app:spend:saved': if (S.onSaved) S.onSaved(msg.appName); break;
      case 'app:spend:error': if (S.onError) S.onError(msg); else toast({ title: 'Spend policy', body: msg.error, level: 'error' }); break;
      case 'app:spend:changed': send({ type: 'app:grid:meta' }); break;
      case 'app:spend:alert': onAlert(msg); break;
    }
  }
  function onGridMeta(spend) { S.meta = spend || {}; }

  function onAlert(ev) {
    // The envelope arrives as type 'app:spend:alert' with the alert kind in
    // `kind`; normalize back to the kind-in-`type` shape this renderer uses.
    ev = { ...ev, type: ev.kind || ev.type };
    S.alerts.unshift(ev);
    if (S.alerts.length > 50) S.alerts.length = 50;
    const titles = { exhausted: 'Spend cap reached', threshold: 'Spend threshold', anomaly: 'Spend anomaly', unattributed: 'Unattributed spend', blocked: 'Call refused', 'storage-breach': 'Storage cap breached' };
    if (ev.type === 'blocked' && ev.code === 'E_RATE_LIMIT') return; // noisy; visible in the panel
    const body = ev.type === 'exhausted' ? `${ev.app}: ${ev.scope}${ev.bucket && ev.bucket !== '_app' ? ' ' + ev.bucket : ''} — metered calls now fail`
      : ev.type === 'threshold' ? `${ev.app}: ${ev.pct}% of today's cap used`
      : ev.type === 'anomaly' ? `${ev.app}: today ${usd(ev.todayUsd)} vs ${usd(ev.baselineUsd)} 7-day average`
      : ev.type === 'unattributed' ? `${ev.app}: ${ev.method} spent without a user (deployed mode)`
      : ev.type === 'storage-breach' ? `${ev.app}: +${Math.round((ev.deltaBytes || 0) / 1e6)} MB new storage today (cap ${ev.capMB} MB)${ev.paused ? ' — app paused' : ''}`
      : `${ev.app}: ${ev.method} → ${ev.code}`;
    toast({ title: titles[ev.type] || 'Spend', body, level: ev.type === 'exhausted' || ev.type === 'blocked' || ev.type === 'storage-breach' ? 'warning' : 'info', appName: ev.app });
    send({ type: 'app:grid:meta' });
  }

  // --- header pill ------------------------------------------------------------

  function renderPill() {
    let pill = document.getElementById('spendModePill');
    if (!pill) {
      const actions = document.querySelector('.header-actions');
      if (!actions) return;
      pill = document.createElement('button');
      pill.id = 'spendModePill';
      pill.className = 'spend-pill';
      pill.addEventListener('click', showMode);
      const anchor = document.getElementById('restartServerBtn');
      if (anchor) actions.insertBefore(pill, anchor); else actions.appendChild(pill);
    }
    const m = S.mode;
    if (!m) { pill.textContent = '…'; return; }
    pill.className = `spend-pill spend-pill-${m.mode}${m.enforce === false ? ' spend-pill-observe' : ''}`;
    pill.innerHTML = `<span class="spend-pill-dot"></span>${m.mode === 'deployed' ? 'Deployed' : 'Local'}${m.override ? ' <span class="spend-pill-sub">pinned</span>' : ''}${m.enforce === false ? ' <span class="spend-pill-sub">observe</span>' : ''}`;
    pill.title = `${m.reason}${m.override ? ` (pinned to ${m.override} by you)` : ''} — click to change`;
  }

  // --- modal scaffold ---------------------------------------------------------

  function openModal(title, bodyHtml, { wide = false } = {}) {
    document.querySelector('.spend-modal')?.remove();
    const overlay = document.createElement('div');
    overlay.className = `spend-modal app-menu-overlay${wide ? ' spend-modal-wide' : ''}`;
    overlay.innerHTML = `<div class="app-menu spend-menu">
      <div class="app-menu-header">
        <div class="app-menu-title"><span class="app-menu-name">${title}</span></div>
        <button class="app-menu-x" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
      </div>
      <div class="app-menu-body spend-body">${bodyHtml}</div>
    </div>`;
    const close = () => { overlay.classList.add('app-menu-closing'); setTimeout(() => overlay.remove(), 130); S.onApp = S.onOverview = S.onSaved = S.onError = null; document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.app-menu-x').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    return { el: overlay, body: overlay.querySelector('.spend-body'), close };
  }

  // --- mode modal -------------------------------------------------------------

  function showMode() {
    const m = S.mode || { mode: 'local', auto: 'local', reason: '', override: null, enforce: true };
    const { body, close } = openModal('Deployment mode');
    body.innerHTML = `
      <div class="spend-section">
        <div class="spend-effective">Now: <b>${m.mode === 'deployed' ? 'Deployed' : 'Local'}</b> · ${m.override ? `pinned by you (auto-detected: ${m.auto})` : 'auto-detected'}${m.enforce === false ? ' · <b>observe only</b>' : ''}</div>
        <div class="app-menu-item-desc" style="margin-top:6px">${esc(m.reason)}</div>
      </div>
      <div class="spend-section">
        <div class="app-menu-item-label">Which spend profile applies</div>
        <div class="app-menu-item-desc" style="margin:4px 0 8px">Every app has one profile for <b>Local</b> (this control room serves you on a trusted network) and one for <b>Deployed</b> (strangers can reach it: a slave peer, Telegram login, a public app or a custom domain). The platform picks automatically; pin it here if the detection is wrong for your setup.</div>
        <div class="spend-presets">
          ${['auto', 'local', 'deployed'].map((v) => `<button class="spend-preset${(m.override || 'auto') === v ? ' is-active' : ''}" data-override="${v}">${v === 'auto' ? 'Auto' : v === 'local' ? 'Local' : 'Deployed'}</button>`).join('')}
        </div>
      </div>
      <div class="spend-section">
        <label class="app-menu-toggle-row">
          <span class="app-menu-item-text"><span class="app-menu-item-label">Enforce spend policies</span><span class="app-menu-item-desc">Off = observe only: every decision is recorded in the ledgers (“would have blocked”) but nothing is refused. Use it to review policies before switching on.</span></span>
          <span class="app-menu-switch"><input type="checkbox" id="spendEnforce" ${m.enforce !== false ? 'checked' : ''}><span class="app-menu-switch-track"><span class="app-menu-switch-thumb"></span></span></span>
        </label>
      </div>
      <div class="spend-section"><button class="va-save spend-save">Save</button> <span class="spend-status"></span></div>`;
    let override = m.override || 'auto';
    body.querySelectorAll('[data-override]').forEach((b) => b.addEventListener('click', () => {
      override = b.dataset.override;
      body.querySelectorAll('[data-override]').forEach((x) => x.classList.toggle('is-active', x === b));
    }));
    body.querySelector('.spend-save').addEventListener('click', () => {
      send({ type: 'app:spend:mode', override, enforce: body.querySelector('#spendEnforce').checked });
      body.querySelector('.spend-status').textContent = 'Saved.';
      setTimeout(close, 500);
    });
  }

  // --- per-app panel ----------------------------------------------------------

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  function showPolicy(name) {
    const { body } = openModal(`${esc(name)} · Spend &amp; permissions`, '', { wide: true });
    mountPolicy(name, body);
  }

  // The per-app panel rendered into any container: the standalone modal above
  // and the Spend & permissions tab of the app settings modal (apps.js).
  // Returns a detach function that drops the message hooks.
  function mountPolicy(name, body) {
    body.classList.add('spend-body');
    body.innerHTML = '<div class="app-menu-item-desc">Loading…</div>';
    let P = null;                       // server payload
    let draft = { local: null, deployed: null }; // admin layer being edited (null = inherit)
    let tab = null;

    S.onApp = (payload) => {
      if (payload.app !== name) return;
      P = payload;
      draft = { local: P.admin && P.admin.local ? clone(P.admin.local) : null, deployed: P.admin && P.admin.deployed ? clone(P.admin.deployed) : null };
      if (!tab) tab = P.mode;
      render();
    };
    S.onSaved = (app) => { if (app !== name) return; const st = body.querySelector('.spend-status'); if (st) { st.textContent = 'Saved.'; st.className = 'spend-status va-ok'; } send({ type: 'app:grid:meta' }); };
    S.onError = (msg) => { const st = body.querySelector('.spend-status'); if (st) { st.textContent = msg.error; st.className = 'spend-status va-err'; } else toast({ title: 'Spend policy', body: msg.error, level: 'error' }); };
    send({ type: 'app:spend:get', name });

    // The profile shown for a tab: the draft if the admin is editing, else the effective one.
    const shown = (mode) => draft[mode] || P.effective[mode];
    const editing = (mode) => {
      if (!draft[mode]) draft[mode] = { ...clone(P.effective[mode]), grants: P.effective[mode].grants || {} };
      delete draft[mode].sources; delete draft[mode].app; delete draft[mode].mode; delete draft[mode].migrated;
      return draft[mode];
    };

    function render() {
      const eff = P.now;
      const src = { admin: 'set by you', manifest: 'requested by the app manifest', default: 'platform default', host: 'host policy' }[eff.sources.profile] || eff.sources.profile;
      const sum = P.summary;
      body.innerHTML = `
        <div class="spend-section">
          <div class="spend-effective">Effective now: <b>${PRESET_LABEL[eff.preset]}${eff.paused ? ' (paused)' : ''}</b> · ${P.mode === 'deployed' ? 'Deployed' : 'Local'} mode · ${src}${P.enforce === false ? ' · <b>observe only</b>' : ''}</div>
          ${eff.migrated && eff.sources.profile === 'admin' ? '<div class="app-config-warn" style="margin-top:8px">Kept <b>unlimited</b> in both modes when the spend policy feature arrived (previous behaviour). Review before deploying — saving any policy clears this notice.</div>' : ''}
          ${P.status.state ? `<div class="spend-kv"><span>App today</span><b>${cr(P.status.state.app.day.spent)} / ${fmtCap(P.status.state.app.day.cap)}</b><span>App this month</span><b>${cr(P.status.state.app.month.spent)} / ${fmtCap(P.status.state.app.month.cap)}</b></div>` : ''}
        </div>
        <div class="spend-tabs">
          ${['local', 'deployed'].map((m) => `<button class="spend-tab${tab === m ? ' is-active' : ''}" data-tab="${m}">${m === 'local' ? 'Local' : 'Deployed'}${P.mode === m ? ' <span class="spend-pill-sub">now</span>' : ''}${draft[m] ? ' <span class="spend-pill-sub">edited</span>' : ''}</button>`).join('')}
        </div>
        <div class="spend-tabpane"></div>
        <div class="spend-section">
          <button class="va-save spend-save">Save policy</button>
          <button class="setup-btn spend-clear" title="Remove every admin setting for this app — the manifest request or the platform default applies again">Clear admin policy</button>
          <span class="spend-status"></span>
        </div>
        <div class="spend-section">
          <div class="app-menu-item-label">Spend (last ${sum.days} days)</div>
          <div class="spend-kv"><span>Today</span><b>${cr(sum.today.credits)} · ${usd(sum.today.costUsd)} · ${sum.today.calls} calls</b><span>This month</span><b>${cr(sum.month.credits)} · ${usd(sum.month.costUsd)}</b><span>${sum.days} days</span><b>${cr(sum.window.credits)} · ${usd(sum.window.costUsd)}</b></div>
          ${breakdown('By who', sum.byPrincipal, principalLabel)}
          ${breakdown('By method', sum.byMethod)}
          ${breakdown('By origin', sum.byOrigin)}
          ${Object.keys(sum.blocked).length ? `<div class="spend-blocked">Refused: ${Object.entries(sum.blocked).map(([k, v]) => `${esc(k)} ×${v}`).join(' · ')}</div>` : ''}
        </div>
        <div class="spend-section">
          <div class="app-menu-item-label">Permissions</div>
          <div class="app-menu-item-desc" style="margin:4px 0 8px">What the app advertises using (everything is available to it at runtime), what it costs you, and who may ever trigger it. Untick to revoke a capability for this app in the selected mode: it disappears from the app's server context and is refused on the Bridge (applies on restart); metered calls are also blocked live. Core services an app needs to boot cannot be revoked.</div>
          <div class="spend-grid-wrap"><table class="spend-table spend-grants"><thead><tr><th>Capability</th><th>Cost</th><th>Advertised</th><th>Audience</th><th>Allowed</th></tr></thead><tbody></tbody></table></div>
        </div>
        <div class="spend-section">
          <div class="app-menu-item-label">Cost sheet</div>
          <div class="app-menu-item-desc" style="margin:4px 0 8px">Credits = USD × 1000. LLM turns are priced per token by the Models page; everything else per unit below (editable in the Spend overview).</div>
          <div class="spend-kv">${P.examples.map((e) => `<span>${esc(e.label)}</span><b>${cr(e.credits)}</b>`).join('')}</div>
          <div class="spend-grid-wrap"><table class="spend-table"><thead><tr><th>Method</th><th>Unit</th><th>USD / unit</th></tr></thead><tbody>
            ${P.pricing.map((r) => `<tr><td><code>${esc(r.method)}</code></td><td>${esc(r.unitLabel)}</td><td>${r.unit === 'tokens' ? 'model registry' : r.priced ? `${r.rate}${r.source === 'admin' ? ' (yours)' : ''}` : '<i>unpriced</i>'}</td></tr>`).join('')}
          </tbody></table></div>
        </div>`;
      body.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; render(); }));
      body.querySelector('.spend-save').addEventListener('click', save);
      body.querySelector('.spend-clear').addEventListener('click', () => {
        draft = { local: null, deployed: null };
        send({ type: 'app:spend:set', name, policy: null });
      });
      renderTab();
      renderGrants();
    }

    function principalLabel(k) {
      if (k === '_app') return 'unattributed (app bucket)';
      if (k === 'owner') return 'you (owner)';
      return k;
    }
    function breakdown(title, map, label) {
      const rows = Object.entries(map || {}).sort((a, b) => b[1].costUsd - a[1].costUsd).slice(0, 8);
      if (!rows.length) return '';
      return `<div class="spend-breakdown"><div class="spend-breakdown-title">${title}</div>${rows.map(([k, t]) => `<div class="spend-row"><span>${esc(label ? label(k) : k)}</span><span>${t.calls} calls</span><b>${cr(t.costUsd * 1000)}${t.unpriced ? ' <i title="some calls had no unit price">unpriced</i>' : ''}</b></div>`).join('')}</div>`;
    }

    function renderTab() {
      const pane = body.querySelector('.spend-tabpane');
      const prof = shown(tab);
      const isDraft = !!draft[tab];
      const src = isDraft ? 'your draft' : ({ admin: 'set by you', manifest: 'requested by the app manifest', default: 'platform default' }[P.effective[tab].sources.profile] || '');
      const capsOn = prof.preset === 'metered' || prof.preset === 'custom';
      const capInput = (id, v) => `<input type="text" class="spend-cap" data-cap="${id}" value="${isUnl(v) ? '' : esc(v)}" placeholder="∞" ${capsOn ? '' : 'disabled'}>`;
      const SUB_LABEL = { count: 'count toward the cap', separate: 'separate pool', exempt: 'exempt (no cap)' };
      const subSelect = (group, g) => `<select class="spend-cap spend-sub" data-sub="${group}" title="How subscribed users (active licence tier; the owner always counts as subscribed) are treated by this cap" ${capsOn ? '' : 'disabled'}>${['count', 'separate', 'exempt'].map((v) => `<option value="${v}"${(g.subscribers || 'count') === v ? ' selected' : ''}>${SUB_LABEL[v]}</option>`).join('')}</select>${(g.subscribers || 'count') === 'separate' ? ` day ${capInput(group + '.subscriberDay', g.subscriberDay)} month ${capInput(group + '.subscriberMonth', g.subscriberMonth)}` : ''}`;
      pane.innerHTML = `
        <div class="spend-section">
          <div class="app-menu-item-desc" style="margin-bottom:8px">${tab === 'local' ? 'Local: this control room on a trusted network.' : 'Deployed: strangers can reach the app.'} Showing ${src}.</div>
          <div class="spend-presets">
            ${['unlimited', 'metered', 'locked', 'custom'].map((p) => `<button class="spend-preset spend-preset-${p}${prof.preset === p ? ' is-active' : ''}" data-preset="${p}" title="${esc(PRESET_DESC[p])}">${PRESET_LABEL[p]}</button>`).join('')}
            ${isDraft ? '<button class="setup-btn spend-inherit" title="Drop your draft for this mode">Inherit</button>' : ''}
          </div>
          <div class="app-menu-item-desc" style="margin:6px 0 10px">${esc(PRESET_DESC[prof.preset])}</div>
          <div class="spend-caps${capsOn ? '' : ' is-off'}">
            <div class="spend-caps-row"><span>App cap (credits)</span> day ${capInput('app.day', prof.caps.app.day)} month ${capInput('app.month', prof.caps.app.month)}</div>
            <div class="spend-caps-row"><span>… subscribers</span> ${subSelect('app', prof.caps.app)}</div>
            <div class="spend-caps-row"><span>Per user</span> day ${capInput('principal.day', prof.caps.principal.day)} month ${capInput('principal.month', prof.caps.principal.month)}</div>
            <div class="spend-caps-row"><span>… subscribers</span> ${subSelect('principal', prof.caps.principal)}</div>
            <div class="spend-caps-row"><span>Unattributed</span> day ${capInput('unattributed.day', prof.caps.unattributed.day)} month ${capInput('unattributed.month', prof.caps.unattributed.month)}</div>
            <div class="spend-caps-row"><span>Calls / minute</span> per user ${capInput('rate.principalPerMinute', prof.rate.principalPerMinute)} app ${capInput('rate.appPerMinute', prof.rate.appPerMinute)}</div>
            <div class="spend-caps-row" title="New disk + database bytes per day (app dir without node_modules, measured hourly). Breach = alert, then pause — writes are never blocked mid-flight."><span>New storage / day (MB)</span> ${capInput('storage.dailyMB', (prof.storage || {}).dailyMB)}${P.storage && P.storage.measuredAt ? `<span class="spend-src" style="margin-left:8px">today ${fmtMB(P.storage.deltaBytes)} · total ${fmtMB(P.storage.bytes)}</span>` : ''}</div>
            <div class="spend-caps-row"><span>Alert at</span> ${capInput('alerts.appDayPct', prof.alerts.appDayPct)} % of the day cap · anomaly ×${capInput('alerts.anomalyFactor', prof.alerts.anomalyFactor)}</div>
            <div class="spend-caps-row"><span>Per-user overrides</span><textarea class="spend-overrides" placeholder="one per line: acct:42 = 500 / 5000  (day / month; blank = ∞)" ${capsOn ? '' : 'disabled'}>${esc(Object.entries(prof.overrides || {}).map(([k, v]) => `${k} = ${fmtCap(v.day)} / ${fmtCap(v.month)}`).join('\n'))}</textarea></div>
            <label class="app-menu-toggle-row" style="margin-top:6px"><span class="app-menu-item-text"><span class="app-menu-item-label">Paused</span><span class="app-menu-item-desc">Refuse every metered call in this mode</span></span><span class="app-menu-switch"><input type="checkbox" class="spend-paused" ${prof.paused ? 'checked' : ''}><span class="app-menu-switch-track"><span class="app-menu-switch-thumb"></span></span></span></label>
          </div>
        </div>`;
      pane.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
        const d = editing(tab);
        d.preset = b.dataset.preset;
        if (d.preset === 'locked') d.paused = true; else if (d.preset === 'unlimited') d.paused = false;
        render();
      }));
      pane.querySelector('.spend-inherit')?.addEventListener('click', () => { draft[tab] = null; render(); });
      pane.querySelectorAll('.spend-sub').forEach((sel) => sel.addEventListener('change', () => {
        const d = editing(tab);
        if (d.preset !== 'metered') d.preset = 'custom';
        d.caps[sel.dataset.sub].subscribers = sel.value;
        markEdited();
        render();
      }));
      pane.querySelectorAll('.spend-cap').forEach((inp) => inp.addEventListener('change', () => {
        const d = editing(tab);
        if (d.preset !== 'metered') d.preset = 'custom';
        const v = inp.value.trim();
        const val = v === '' || v === '∞' ? 'unlimited' : Number(v);
        const [a, b] = inp.dataset.cap.split('.');
        if (a === 'rate' || a === 'alerts') d[a][b] = val;
        else if (a === 'storage') { d.storage = d.storage || {}; d.storage[b] = val; }
        else d.caps[a][b] = val;
        markEdited();
      }));
      pane.querySelector('.spend-overrides').addEventListener('change', (e) => {
        const d = editing(tab);
        d.overrides = {};
        for (const line of e.target.value.split('\n')) {
          const m = /^\s*([^=\s]+)\s*=\s*([^\/]*)\/?\s*(.*)$/.exec(line);
          if (!m) continue;
          const num = (x) => { const t = String(x).trim(); return t === '' || t === '∞' ? 'unlimited' : Number(t); };
          d.overrides[m[1]] = { day: num(m[2]), month: num(m[3]) };
        }
        markEdited();
      });
      pane.querySelector('.spend-paused').addEventListener('change', (e) => { const d = editing(tab); d.paused = e.target.checked; markEdited(); });
    }
    function markEdited() {
      body.querySelectorAll('[data-tab]').forEach((b) => { if (b.dataset.tab === tab && !b.innerHTML.includes('edited')) b.innerHTML += ' <span class="spend-pill-sub">edited</span>'; });
    }

    function renderGrants() {
      const tbody = body.querySelector('.spend-grants tbody');
      const prof = shown(tab);
      const grants = (draft[tab] && draft[tab].grants) || prof.grants || {};
      const rows = P.capabilities.slice().sort((a, b) => (b.declared - a.declared) || (a.cost === 'metered' ? -1 : 1));
      tbody.innerHTML = rows.map((c) => `<tr class="${c.declared ? '' : 'is-undeclared'}">
        <td><b>${esc(c.title)}</b><div class="spend-methods">${c.methods.slice(0, 6).map((m) => `<code>${esc(m)}</code>`).join(' ')}${c.methods.length > 6 ? ' …' : ''}</div></td>
        <td><span class="spend-badge spend-badge-${c.cost}">${COST_BADGE[c.cost]}</span></td>
        <td>${c.legacy ? '<i title="no capabilities object in manifest.json — nothing advertised (everything is still available)">—</i>' : c.declared ? 'yes' : '—'}</td>
        <td>${c.audiences.join(', ')}</td>
        <td>${c.revocable ? `<input type="checkbox" data-grant="${esc(c.key)}" ${grants[c.key] === false ? '' : 'checked'} title="ctx.${esc((c.ctxMembers || []).join(', ctx.'))}">` : '<span class="spend-src" title="core service — apps need it to boot">always</span>'}</td>
      </tr>`).join('');
      tbody.querySelectorAll('[data-grant]').forEach((cb) => cb.addEventListener('change', () => {
        const d = editing(tab);
        d.grants = d.grants || {};
        d.grants[cb.dataset.grant] = cb.checked;
        markEdited();
      }));
    }

    function save() {
      const policy = {};
      for (const m of ['local', 'deployed']) policy[m] = draft[m] ? draft[m] : null;
      const st = body.querySelector('.spend-status');
      st.textContent = 'Saving…'; st.className = 'spend-status';
      send({ type: 'app:spend:set', name, policy });
    }
    return () => { S.onApp = S.onSaved = S.onError = null; };
  }

  // --- overview ---------------------------------------------------------------

  function showOverview() {
    const { body } = openModal('Spend overview', '<div class="app-menu-item-desc">Loading…</div>', { wide: true });
    S.onOverview = (o) => {
      const m = o.mode;
      const rows = o.rows.slice().sort((a, b) => b.today.costUsd - a.today.costUsd || a.app.localeCompare(b.app));
      const hostProf = (mode) => o.host[mode];
      body.innerHTML = `
        <div class="spend-section">
          <div class="spend-effective">Mode: <b>${m.mode === 'deployed' ? 'Deployed' : 'Local'}</b> · ${esc(m.reason)}${m.override ? ' · pinned' : ''}${m.enforce === false ? ' · <b>observe only</b>' : ''} <button class="setup-btn spend-mode-btn" style="margin-left:8px">Change</button></div>
          ${m.reviewNotice ? '<div class="app-config-warn" style="margin-top:8px">Existing apps were kept <b>unlimited</b> in both modes when spend policies arrived — review the rows marked “migrated” before deploying. Platform-owned spend (below) gained a daily budget on upgrade; raise or remove it there. <button class="setup-btn spend-dismiss" style="margin-left:6px">Dismiss</button></div>' : ''}
        </div>
        <div class="spend-section">
          <div class="app-menu-item-label">Apps</div>
          <div class="spend-grid-wrap"><table class="spend-table spend-overview"><thead><tr><th>App</th><th>Now (${m.mode})</th><th>${m.mode === 'local' ? 'Deployed' : 'Local'}</th><th>Today</th><th>Month</th><th>Cap / day</th><th>Refused</th><th>Spends on</th></tr></thead><tbody>
            ${rows.map((r) => `<tr data-app="${esc(r.app)}">
              <td><b>${esc(r.app)}</b>${r.access && r.access !== 'private' ? ` <span class="spend-pill-sub">${esc(r.access)}</span>` : ''}${r.migrated ? ' <span class="spend-pill-sub" title="kept unlimited on upgrade">migrated</span>' : ''}</td>
              <td><span class="spend-badge spend-badge-${r.preset}">${PRESET_LABEL[r.preset]}${r.paused ? ' · paused' : ''}</span> <span class="spend-src">${r.source}</span></td>
              <td><span class="spend-badge spend-badge-${r.otherPreset}">${PRESET_LABEL[r.otherPreset]}</span></td>
              <td>${cr(r.today.credits)}<div class="spend-src">${usd(r.today.costUsd)}</div></td>
              <td>${cr(r.month.credits)}<div class="spend-src">${usd(r.month.costUsd)}</div></td>
              <td>${fmtCap(r.appDayCap)}</td>
              <td>${Object.values(r.blocked).reduce((a, b) => a + b, 0) || ''}</td>
              <td>${r.metered.map((k) => `<code>${esc(k)}</code>`).join(' ')}${r.external ? ' <span class="spend-badge spend-badge-external" title="http.fetch with the app\'s own keys: the platform cannot price this">own keys</span>' : ''}</td>
            </tr>`).join('') || '<tr><td colspan="8">No apps.</td></tr>'}
          </tbody></table></div>
          <div class="app-menu-item-desc" style="margin-top:6px">Click a row to edit that app's policy.</div>
        </div>
        <div class="spend-section">
          <div class="app-menu-item-label">Platform-owned spend (Horst, cron with no app, platform sessions)</div>
          <div class="app-menu-item-desc" style="margin:4px 0 8px">Horst's heartbeat, briefing and triage run with no user to bill, so this profile has no “per user” cap and no zero-attribution rule — one pool, spent with or without an identity. When it runs out, the calls are refused and you are told; your own CLI tabs are not affected.</div>
          <div class="spend-kv"><span>Today</span><b>${cr((o.hostSummary.today.credits || 0) + (o.platformSummary.today.credits || 0))}</b><span>This month</span><b>${cr((o.hostSummary.month.credits || 0) + (o.platformSummary.month.credits || 0))}</b></div>
          ${['local', 'deployed'].map((mode) => `
            <div class="spend-caps-row">${mode === 'local' ? 'Local' : 'Deployed'}: ${['unlimited', 'budgeted', 'locked'].map((p) => `<button class="spend-preset spend-preset-${p}${hostProf(mode).preset === p ? ' is-active' : ''}" data-host="${mode}" data-preset="${p}" title="${esc(PRESET_DESC[p])}">${PRESET_LABEL[p]}</button>`).join('')}
              ${hostProf(mode).preset === 'budgeted' ? `<span class="spend-src" style="margin-left:8px">Credits</span>
                <input type="text" class="spend-cap host-cap" data-host-cap="${mode}" data-span="day" value="${isUnl(hostProf(mode).caps.app.day) ? '' : esc(hostProf(mode).caps.app.day)}" placeholder="∞" title="per day" style="width:6em">
                <span class="spend-src">/ day</span>
                <input type="text" class="spend-cap host-cap" data-host-cap="${mode}" data-span="month" value="${isUnl(hostProf(mode).caps.app.month) ? '' : esc(hostProf(mode).caps.app.month)}" placeholder="∞" title="per month" style="width:6em">
                <span class="spend-src">/ month</span>` : ''}
            </div>`).join('')}
        </div>
        <div class="spend-section">
          <div class="app-menu-item-label">Unit prices (USD per unit)</div>
          <div class="app-menu-item-desc" style="margin:4px 0 8px">Provider list prices by default. Override any of them here; the ledger prices future calls with your value. LLM turns come from the Models page.</div>
          <div class="spend-grid-wrap"><table class="spend-table"><thead><tr><th>Method</th><th>Unit</th><th>Default</th><th>Yours</th></tr></thead><tbody>
            ${o.pricing.filter((r) => r.unit !== 'tokens').map((r) => `<tr><td><code>${esc(r.method)}</code></td><td>${esc(r.unitLabel)}</td><td>${r.source === 'admin' ? '' : (r.rate ?? '<i>unpriced</i>')}</td><td><input type="text" class="spend-cap spend-price" data-method="${esc(r.method)}" value="${o.host.unitPrices[r.method] != null ? esc(o.host.unitPrices[r.method]) : ''}" placeholder="default"></td></tr>`).join('')}
          </tbody></table></div>
          <div class="spend-kv" style="margin-top:8px">${o.examples.map((e) => `<span>${esc(e.label)}</span><b>${cr(e.credits)}</b>`).join('')}</div>
          <button class="va-save spend-prices-save" style="margin-top:8px">Save prices</button> <span class="spend-status"></span>
        </div>
        ${S.alerts.length ? `<div class="spend-section"><div class="app-menu-item-label">Recent alerts</div>${S.alerts.slice(0, 12).map((a) => `<div class="spend-row"><span>${new Date(a.at).toLocaleTimeString()}</span><span>${esc(a.app)}</span><b>${esc(a.type)}${a.code ? ' ' + esc(a.code) : ''}${a.method ? ' · ' + esc(a.method) : ''}</b></div>`).join('')}</div>` : ''}`;
      body.querySelector('.spend-mode-btn').addEventListener('click', showMode);
      body.querySelector('.spend-dismiss')?.addEventListener('click', () => send({ type: 'app:spend:host', reviewNotice: false }));
      body.querySelectorAll('tr[data-app]').forEach((tr) => tr.addEventListener('click', () => showPolicy(tr.dataset.app)));
      body.querySelectorAll('[data-host]').forEach((b) => b.addEventListener('click', () => {
        const host = { [b.dataset.host]: { preset: b.dataset.preset } };
        send({ type: 'app:spend:host', host });
      }));
      // A cap edit keeps the preset it belongs to; sending only the changed
      // span would reset the other one to the preset default.
      body.querySelectorAll('.host-cap').forEach((inp) => inp.addEventListener('change', () => {
        const mode = inp.dataset.hostCap;
        const read = (span) => {
          const el = body.querySelector(`.host-cap[data-host-cap="${mode}"][data-span="${span}"]`);
          const v = (el.value || '').trim();
          return v === '' ? 'unlimited' : Number(v);
        };
        send({ type: 'app:spend:host', host: { [mode]: { preset: 'budgeted', caps: { app: { day: read('day'), month: read('month') } } } } });
      }));
      body.querySelector('.spend-prices-save').addEventListener('click', () => {
        const unitPrices = {};
        body.querySelectorAll('.spend-price').forEach((inp) => { const v = inp.value.trim(); if (v !== '') unitPrices[inp.dataset.method] = Number(v); });
        send({ type: 'app:spend:host', unitPrices });
        body.querySelector('.spend-status').textContent = 'Saved.';
      });
    };
    send({ type: 'app:spend:overview' });
  }

  // --- hooks used by apps.js ----------------------------------------------------

  // Spend cell of the apps table (next to Disk / DB).
  function tile(name) {
    const s = S.meta[name];
    const mode = S.mode ? S.mode.mode : null;
    const unl = s && s.preset === 'unlimited';
    const value = s ? `${cr(s.today)}${!unl && !isUnl(s.cap) ? ` <small>/ ${fmtCap(s.cap)}</small>` : ''}` : '–';
    const storeLine = s && s.storageDelta != null
      ? `<span class="spend-tile-storage" title="New storage today${!isUnl(s.storageCapMB) ? ` (cap ${s.storageCapMB} MB/day)` : ''}">${s.storageDelta >= 0 ? '+' : ''}${fmtMB(s.storageDelta)}${!isUnl(s.storageCapMB) ? ` / ${esc(s.storageCapMB)} MB` : ''}</span>`
      : '';
    const title = s ? `Spend today · ${PRESET_LABEL[s.preset]}${s.paused ? ' (paused)' : ''}${mode ? ` in ${mode} mode` : ''} · ${cr(s.window)} last 30 days${s.blocked ? ` · ${s.blocked} refused` : ''} — click to edit the policy` : 'Spend policy';
    const cls = s ? (s.paused ? ' is-paused' : s.blocked ? ' is-blocked' : '') : ' is-empty';
    const lbl = !s ? 'spend' : s.paused ? 'spend · paused' : unl ? 'spend · ∞' : 'spend · today';
    return `<div class="is-link spend-tile${cls}" ${vcAct.attrs('click', 'spendAdmin.openFor', [name], { stop: true })} title="${esc(title)}">
      <span class="vc-lbl">${lbl}</span><span class="v">${value}</span>${storeLine}
    </div>`;
  }

  // Per-app entry from the apps table: the Spend & permissions tab of the
  // app settings modal when apps.js offers it, else the standalone panel.
  function openFor(name) {
    if (window.appsModule?.openAppSettings) window.appsModule.openAppSettings(name, 'spend');
    else showPolicy(name);
  }

  window.spendAdmin = { onMessage, onGridMeta, showMode, showPolicy, mountPolicy, openFor, showOverview, tile, alerts: () => S.alerts };
  renderPill();
})();
