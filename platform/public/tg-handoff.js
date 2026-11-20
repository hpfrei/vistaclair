// === Continue on Telegram (Pro client module) ===
// Loads after apps.js. Adds a "📱 Follow on Telegram" toggle to orchestrator
// tabs (dashboard.registerTabAction: a button in the Agent SDK toolbar, an item
// in a terminal tab's × menu), drawn pressed as "📱 Following on Telegram"
// while a Telegram chat follows the run, and a 📱 chip on the tab of every
// followed run (dashboard.setTabBadge). The bound set is the server's: seeded
// from GET /pro/tg-handoff/bindings and kept current by 'tg:binding'
// broadcasts, which include binds made from Telegram's own Sessions picker.
// The toggle's `active` reads the bound set at every render; a change to it
// sets a badge, which re-renders the views.
// Inert on a core without the tab hooks, and on a server without orchestration
// runs (bindings → 404).
(function () {
  'use strict';

  const D = window.dashboard;
  if (!D || typeof D.registerTabAction !== 'function' || typeof D.setTabBadge !== 'function') return;

  const BASE = '/pro/tg-handoff';
  const bound = new Map();   // runId -> session name its badge sits on
  let off = false;           // the server has no orchestration runs
  let registered = false;

  const toast = (message, level) => D.showToast && D.showToast({ sender: 'Telegram', message, level });
  const nameOf = (runId, name) => name || `orch-${runId}`;
  const isOrch = (info) => !!(info && info.role === 'orchestrator' && info.runId);

  async function post(path, runId) {
    const res = await fetch(`${BASE}/${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }

  async function bind(runId) {
    try {
      await post('bind', runId);
      toast('Run is on Telegram — check the chat', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function unbind(runId) {
    try {
      await post('unbind', runId);
      toast('Stopped following the run on Telegram', 'info');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function setBound(runId, name, on) {
    const prev = bound.get(runId);
    if (!on) {
      if (prev === undefined) return;
      bound.delete(runId);
      D.setTabBadge(prev, null);
      return;
    }
    const next = nameOf(runId, name);
    bound.set(runId, next);
    if (prev && prev !== next) D.setTabBadge(prev, null);
    D.setTabBadge(next, {
      text: '📱',
      title: 'Followed on Telegram — click to stop',
      onClick: async () => {
        if (await D.showConfirm('Stop following this run on Telegram?', { confirmLabel: 'Stop following' })) unbind(runId);
      },
    });
  }

  // The server's list replaces what the client knew.
  function seed(runs) {
    const ids = new Set(runs.map((r) => (r && typeof r === 'object' ? r.runId : r)).filter((r) => typeof r === 'string' && r));
    for (const runId of [...bound.keys()]) if (!ids.has(runId)) setBound(runId, null, false);
    for (const runId of ids) setBound(runId, bound.get(runId), true);
  }

  function register() {
    if (registered) return;
    registered = true;
    D.registerTabAction({
      id: 'tg-handoff:follow',
      label: '📱 Follow on Telegram',
      title: 'Follow this run in the Telegram control chat',
      activeLabel: '📱 Following on Telegram',
      activeTitle: 'The Telegram control chat follows this run — click to stop',
      when: isOrch,
      active: (info) => bound.has(info.runId),
      onClick: (info) => (bound.has(info.runId) ? unbind(info.runId) : bind(info.runId)),
    });
  }

  async function load() {
    if (off) return;
    let res;
    try {
      res = await fetch(`${BASE}/bindings`, { credentials: 'same-origin' });
    } catch { return; }   // offline: the next visibility change retries
    if (res.status === 404) { off = true; return; }
    if (res.ok) {
      const body = await res.json().catch(() => null);
      if (body && Array.isArray(body.runs)) seed(body.runs);
    }
    register();
  }

  D.registerModule?.('tg:binding', (msg) => {
    if (off || !msg || !msg.runId) return;
    setBound(msg.runId, msg.name, !!msg.bound);
  });

  // Core exposes no reconnect hook; a tab coming back to the foreground is
  // when a missed broadcast matters.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') load();
  });

  load();
})();
