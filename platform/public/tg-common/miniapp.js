/* Shared Telegram Mini App client plumbing — the browser half of
   src/apps/tg-miniapp-auth.js, used by every Mini App this package serves.

   Stateless by construction: Telegram kills backgrounded webviews, so the
   server is the source of truth and the client re-derives everything from a
   poll. Auth is an initData exchange for a short-lived bearer, cached in
   sessionStorage and re-minted transparently on the first 401.

   Both the storage key and the header name are CALLER-SUPPLIED and must differ
   per app: sessionStorage and request headers are global to the origin, and
   every Mini App here lives under /pro/*, so a shared name means two apps
   overwrite each other's tokens. */
(function () {
  'use strict';

  function create(opts) {
    const base = opts.base || 'api';
    const storageKey = opts.storageKey;
    const header = opts.header;
    const onStatus = opts.onStatus;
    if (!storageKey || !header) throw new Error('VcMiniApp.create requires storageKey and header');

    const tg = window.Telegram && window.Telegram.WebApp;
    let token = null;
    try { token = sessionStorage.getItem(storageKey) || null; } catch (e) { token = null; }
    let pollTimer = null;

    function setStatus(cls, text) {
      try { onStatus && onStatus(cls, text); } catch (e) { /* a status sink must never break a fetch */ }
    }

    async function authenticate() {
      const initData = tg && tg.initData;
      // Opened outside Telegram: there is no signature to exchange, and there
      // is deliberately no other way in — this subtree has no owner cookie.
      if (!initData) { setStatus('error', 'not in Telegram'); return false; }
      try {
        const res = await fetch(base + '/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData }),
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok || !data.token) {
          setStatus('error', data.error || 'auth failed');
          return false;
        }
        token = data.token;
        try { sessionStorage.setItem(storageKey, token); } catch (e) { /* private mode: keep in memory */ }
        return true;
      } catch (e) {
        setStatus('error', 'auth failed');
        return false;
      }
    }

    async function api(path, opts2) {
      opts2 = opts2 || {};
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers[header] = token;
      const res = await fetch(base + '/' + path, {
        method: opts2.method || 'GET',
        headers: headers,
        ...(opts2.body ? { body: JSON.stringify(opts2.body) } : {}),
      });
      // One transparent re-auth: the bearer is short-lived and the webview may
      // have been suspended for longer than its TTL.
      if (res.status === 401 && !opts2._retried) {
        const ok = await authenticate();
        if (ok) return api(path, { ...opts2, _retried: true });
        throw new Error('unauthorized');
      }
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      return data;
    }

    function startPolling(fn, ms) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(fn, ms);
      fn();
    }

    // Telegram suspends the webview rather than reloading it, so a return to
    // the foreground must refetch immediately instead of waiting out the poll.
    // Per-instance, not shared state on the factory.
    let onVisible = null;
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && onVisible) onVisible();
    });

    async function boot(fn, ms) {
      if (!token) await authenticate();
      onVisible = fn;
      startPolling(fn, ms || 5000);
    }

    function haptic(kind) {
      try { tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred(kind); } catch (e) { /* optional */ }
    }

    if (tg) { tg.ready(); tg.expand(); }

    return { tg: tg, api: api, authenticate: authenticate, startPolling: startPolling, boot: boot, haptic: haptic, setStatus: setStatus };
  }

  window.VcMiniApp = { create: create };
})();
