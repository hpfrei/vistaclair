// The owner's "your turn" checklist and the machine-wide resource locks.
//
// The checklist: what only the owner can do (Stop→Start, Build, Make live,
// Rebuild client, an approval) or decide, collected from the workers' reports
// (src/orchestration.js, run.ownerItems). GET /api/orchestration/owner-items
// lists the open items — of one run, or of every run — and
// POST /api/orchestration/owner-resolve ticks an action, answers a decision or
// drops an item. The locks: GET /api/locks (src/locks.js), read-only.
//
// The pure functions (ordering, counts, the HTML of an item, of the locks and
// of the whole panel) have no DOM so test/owner-items.test.js runs them. The
// view is below: `ownerItems.view({ runId })` is a panel element that fetches
// when attached and again every REFRESH_MS while it is on screen;
// `ownerItems.globalView()` is the one for every run (the Sessions tab),
// `ownerItems.onRunUpdate(msg)` refreshes the views after an orchestration:run.
(function (root) {
  const REFRESH_MS = 15000;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // "just now", "5 min", "3 h", "2 d" since an ISO time or epoch ms.
  function ago(t, now = Date.now()) {
    const ms = typeof t === 'number' ? t : Date.parse(t);
    if (!ms) return '';
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min`;
    if (s < 86400) return `${Math.floor(s / 3600)} h`;
    return `${Math.floor(s / 86400)} d`;
  }

  // The open items of a run's list (the server sends them first, in order, then
  // the latest resolved ones).
  const openItems = (items) => (items || []).filter(i => i && i.state === 'open');

  // Open items across run groups ([{ runId, items }]).
  const countOpen = (runs) => (runs || []).reduce((n, r) => n + openItems(r.items).length, 0);

  // Runs with something open, most waiting first (the server's order, kept
  // stable).
  function waitingRuns(runs) {
    return (runs || []).map((r) => ({ ...r, items: openItems(r.items) })).filter(r => r.items.length);
  }

  // One item: a tick for an action, the options / an answer field for a
  // decision, a drop button. `runLabel`: shown when the list spans runs.
  function itemHtml(item, run, { now = Date.now(), showRun = false } = {}) {
    const data = `data-run="${esc(run.runId)}" data-id="${esc(item.id)}"`;
    const rec = item.recommended || '';
    const meta = [
      showRun ? `<span class="oi-run" title="run ${esc(run.runId)}">${esc(run.title || run.name || run.runId)}</span>` : '',
      item.worker ? `<span>${esc(run.name && item.worker.startsWith(`${run.name}-`) ? item.worker.slice(run.name.length + 1) : item.worker)}</span>` : '',
      `<span>${esc(ago(item.at, now))}</span>`,
    ].filter(Boolean).join(' · ');
    let control;
    if (item.kind === 'decision') {
      const opts = (item.options || []).map(o =>
        `<button type="button" class="vc-btn vc-btn-sm${o === rec ? ' vc-btn-primary' : ''}" data-act="option" ${data} data-answer="${esc(o)}"${o === rec ? ' title="Recommended"' : ''}>${esc(o)}${o === rec ? ' ★' : ''}</button>`).join('');
      control = `<div class="oi-answer">${opts}`
        + `<input type="text" class="oi-input" data-answer-for="${esc(item.id)}" placeholder="${(item.options || []).length ? 'or type an answer…' : 'type an answer…'}" aria-label="Answer">`
        + `<button type="button" class="vc-btn vc-btn-sm" data-act="answer" ${data}>Answer</button></div>`;
    } else {
      control = `<button type="button" class="vc-btn vc-btn-sm oi-tick" data-act="done" ${data} title="Tick when you have done it: the orchestrator is told">☐ Done</button>`;
    }
    return `<li class="oi-item oi-${item.kind === 'decision' ? 'decision' : 'action'}${item.blocking ? ' oi-blocking' : ''}">`
      + `<div class="oi-main"><div class="oi-what">${item.blocking ? '<span class="oi-flag" title="Something is waiting on this">blocks</span> ' : ''}${esc(item.what)}</div>`
      + (item.why ? `<div class="oi-why">${esc(item.why)}</div>` : '')
      + `<div class="oi-meta">${meta}</div></div>`
      + `<div class="oi-ctl">${control}<button type="button" class="vc-btn vc-btn-sm oi-drop" data-act="drop" ${data} title="Drop this item: it is no longer needed">Drop</button></div>`
      + '</li>';
  }

  // The checklist of runs ([{ runId, name, title, items }]), grouped by run
  // when more than one run waits.
  function checklistHtml(runs, { now = Date.now() } = {}) {
    const waiting = waitingRuns(runs);
    const showRun = waiting.length > 1;
    return waiting.map((r) => `<ul class="oi-list">${r.items.map(i => itemHtml(i, r, { now, showRun })).join('')}</ul>`).join('');
  }

  // A holder or waiter record as one line: who, mode, command, how long.
  function lockerText(rec, now = Date.now()) {
    const who = rec.session || (rec.instanceId ? `instance ${rec.instanceId}` : `${rec.user || 'user'}@${rec.host || 'host'}`);
    const cmd = Array.isArray(rec.command) ? rec.command.join(' ') : '';
    const t = ago(rec.since, now);
    return `${who}${rec.mode ? ` (${rec.mode})` : ''}${cmd ? ` · ${cmd.length > 70 ? cmd.slice(0, 69) + '…' : cmd}` : ''}${t ? ` · ${t}` : ''}`;
  }

  // The locks panel (GET /api/locks), read-only; '' when none is held or waited for.
  function locksHtml(data, { now = Date.now() } = {}) {
    const locks = (data && data.locks) || [];
    if (!locks.length) return '';
    const rows = locks.map((l) => {
      const holders = (l.holders || []).map(h => `<li class="oi-lk-holder" title="pid ${esc(h.pid)}${h.cwd ? `\n${esc(h.cwd)}` : ''}">${esc(lockerText(h, now))}</li>`).join('');
      const waiters = (l.waiters || []).map(w => `<li class="oi-lk-waiter" title="pid ${esc(w.pid)}${w.cwd ? `\n${esc(w.cwd)}` : ''}">waiting: ${esc(lockerText(w, now))}</li>`).join('');
      return `<div class="oi-lock"><span class="oi-lk-name">${esc(l.name)}</span>`
        + `<span class="oi-lk-count">${(l.holders || []).length} held${(l.waiters || []).length ? ` · ${l.waiters.length} waiting` : ''}</span>`
        + `<ul>${holders}${waiters}</ul></div>`;
    }).join('');
    return `<div class="oi-locks"><div class="oi-head"><span class="oi-title">Locks</span><span class="oi-count">${locks.length} in use</span></div>${rows}</div>`;
  }

  // The whole panel: the checklist (header with the count) and the locks.
  // '' when there is nothing to show.
  function panelHtml(runs, locks, { now = Date.now(), emptyText = '' } = {}) {
    const n = countOpen(runs);
    const lk = locksHtml(locks, { now });
    if (!n && !lk && !emptyText) return '';
    const head = `<div class="oi-head"><span class="oi-title">Your turn</span><span class="oi-count${n ? ' oi-count-on' : ''}">${n ? `${n} waiting` : 'nothing waiting'}</span></div>`;
    return head + (n ? checklistHtml(runs, { now }) : emptyText ? `<p class="oi-empty">${esc(emptyText)}</p>` : '') + lk;
  }

  // ---- View --------------------------------------------------------------

  const views = new Set();

  async function getJson(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return res.json();
  }

  // A panel element. `runId`: one run's items; none: every run's. `onCount(n)`
  // hears the number of open items after each fetch.
  function view({ runId = null, emptyText = '', onCount = null } = {}) {
    const el = document.createElement('div');
    el.className = 'oi-panel';
    let runs = [];
    let locks = null;
    let html = null;
    let busy = false;
    let timer = null;

    function render() {
      const next = panelHtml(runs, locks, { emptyText });
      if (!emptyText) el.classList.toggle('hidden', !next);   // with an empty text the owner of the element shows and hides it
      if (next === html) return;
      // Do not rebuild under someone typing an answer.
      if (el.contains(document.activeElement) && document.activeElement.matches?.('input')) return;
      const typed = new Map([...el.querySelectorAll('[data-answer-for]')].map(i => [i.dataset.answerFor, i.value]));
      html = next;
      el.innerHTML = next;
      for (const i of el.querySelectorAll('[data-answer-for]')) if (typed.has(i.dataset.answerFor)) i.value = typed.get(i.dataset.answerFor);
    }

    async function refresh() {
      if (busy) return;
      busy = true;
      try {
        const [items, lk] = await Promise.all([
          getJson(`/api/orchestration/owner-items${runId ? `?runId=${encodeURIComponent(runId)}` : ''}`).catch(() => null),
          getJson('/api/locks').catch(() => null),
        ]);
        if (items) runs = items.runs || [];
        if (lk) locks = lk;
        render();
        onCount?.(countOpen(runs));
      } finally { busy = false; }
    }

    async function act(b) {
      const { act: kind, run, id } = b.dataset;
      let answer = '';
      if (kind === 'option') answer = b.dataset.answer || '';
      if (kind === 'answer') {
        const input = el.querySelector(`[data-answer-for="${CSS.escape(id)}"]`);
        answer = (input?.value || '').trim();
        if (!answer) { input?.focus(); return; }
      }
      b.disabled = true;
      try {
        const res = await fetch('/api/orchestration/owner-resolve', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: run, id, action: kind === 'drop' ? 'drop' : 'done', answer }),
        });
        const r = await res.json().catch(() => ({}));
        if (r.error) window.dashboard?.toast?.(r.error, 'error');
      } catch (e) {
        window.dashboard?.toast?.(`Could not save: ${e.message}`, 'error');
      }
      refresh();
      for (const v of views) if (v.el !== el) v.refresh();
    }

    el.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (b && !b.disabled) act(b);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target.matches?.('[data-answer-for]')) return;
      e.preventDefault();
      el.querySelector(`button[data-act="answer"][data-id="${CSS.escape(e.target.dataset.answerFor)}"]`)?.click();
    });

    function tick() {
      if (!el.isConnected) { clearInterval(timer); timer = null; return; }
      if (!document.hidden) refresh();
    }
    // `start`: call it when the panel is put on screen. It fetches, then again at
    // a modest interval for as long as the element stays in the page.
    const start = () => { if (!timer) { timer = setInterval(tick, REFRESH_MS); } refresh(); };
    const api = { el, refresh, start };
    views.add(api);
    return api;
  }

  let globalApi = null;
  function globalView() {
    if (!globalApi) globalApi = view({ emptyText: '' });
    return globalApi;
  }

  function onRunUpdate(msg) {
    if (!msg?.runId) return;
    for (const v of views) v.refresh();
  }

  const api = { esc, ago, openItems, countOpen, waitingRuns, itemHtml, checklistHtml, lockerText, locksHtml, panelHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ownerItems = { ...api, view, globalView, onRunUpdate };
})(typeof window !== 'undefined' ? window : globalThis);
