// Horst live channel — a WebSocket onto the dashboard broadcaster.
//
// The dashboard broadcaster (src/dashboard-ws.js) fans EVERY message out to
// EVERY connected client, and the upgrade authenticates by cookie
// (server.js). /pro/horst/ is same-origin, so this iframe can hold its own
// socket and receive `horst:*` traffic the instant it happens — which is what
// lets the system map animate on real events instead of polling for them.
//
// Everything here is additive: server state stays canonical and every view
// still re-fetches on entry, so a dropped socket degrades to "no animation",
// never to "wrong data".
//
// Usage:
//   Live.on('horst:event', (msg) => …)   // returns an unsubscribe fn
//   Live.onStatus((state) => …)          // 'connecting' | 'open' | 'closed'
(function () {
  'use strict';

  const listeners = new Map();   // type → Set<fn>
  const statusFns = new Set();
  let ws = null;
  let delay = 1000;
  let status = 'closed';
  let closedByPage = false;

  function setStatus(next) {
    if (status === next) return;
    status = next;
    for (const fn of statusFns) { try { fn(next); } catch (err) { console.warn('[horst-live] status listener failed:', err); } }
  }

  function emit(type, msg) {
    const set = listeners.get(type);
    if (!set) return;
    for (const fn of set) {
      try { fn(msg); } catch (err) { console.warn('[horst-live] listener failed for', type, err); }
    }
  }

  function connect() {
    if (closedByPage) return;
    setStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try { ws = new WebSocket(`${proto}//${location.host}`); }
    catch { scheduleReconnect(); return; }

    ws.onopen = () => { delay = 1000; setStatus('open'); };

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      // The broadcaster bootstraps new clients with an interactions dump and
      // carries CLI/inspector/MCP traffic we have no business reading.
      if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('horst:')) return;
      emit(msg.type, msg);
      emit('*', msg);
    };

    ws.onclose = () => { ws = null; setStatus('closed'); scheduleReconnect(); };
    // onerror is always followed by onclose — let that path do the reconnect.
    ws.onerror = () => {};
  }

  function scheduleReconnect() {
    if (closedByPage) return;
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 15000);
  }

  window.addEventListener('pagehide', () => {
    closedByPage = true;
    try { ws?.close(); } catch {}
  });

  window.HorstLive = {
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    onStatus(fn) { statusFns.add(fn); fn(status); return () => statusFns.delete(fn); },
    get status() { return status; },
  };

  connect();
})();
