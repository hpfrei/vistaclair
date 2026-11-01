// Login page: the static-token form (always shown) and, when an add-on
// provides one, a challenge login: scan a QR code (or open the link), approve
// in the provider's app, and this page logs in. A file, not an inline
// <script>, so the page runs under CSP script-src 'self' (src/csp.js). Served
// before auth by server.js (GET /login.js).
//
// Backend contract (src/login.js):
//   POST login/challenge/start { replaces? } → { nonce, code, expiresInMs,
//        providers: [{ id, label, link, qrSvg }] } (only ready providers; 429
//        when rate limited: the per-IP limiter, 10/min, is shared with the
//        token form's POST /login, so starts stay well under it)
//   POST login/challenge/poll { nonce } long-polls ≤25 s → { status:
//        'pending'|'expired'|'denied'|'ok' }; on 'ok' the sid cookie is set.
//        A replaced or unknown nonce answers 'expired'.
//
// In node (test/login-page.test.js) this file exports the flow logic, which
// takes its fetch, timers and view as arguments; in the browser it boots.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.boot(window);
})(function () {
  'use strict';

  const START = 'login/challenge/start';
  const POLL = 'login/challenge/poll';
  const ROTATE_MS = 30000;        // a fresh code every 30 s
  const BACKOFF_MIN_MS = 1000;    // poll network errors: 1 s, 2 s, … 30 s
  const BACKOFF_MAX_MS = 30000;
  const START_BACKOFF_MIN_MS = 15000; // failed/429 start: 15 s, 30 s, 60 s
  const START_BACKOFF_MAX_MS = 60000;
  const RETRY_AFTER_MAX_MS = 120000;
  // At most one start per 10 s (rotation alone is 2/min), so denied/expired
  // bursts never use up the limiter the token form shares.
  const MIN_START_GAP_MS = 10000;
  const MIN_POLL_GAP_MS = 1000;   // never hot-loop if a poll answers at once

  // The challenge flow. deps: { fetch, setTimeout, clearTimeout, now, view,
  // navigate, rotateMs }. view: { show(challenge), hide(), setStatus(text,
  // kind), setCountdown(seconds) }.
  function createLoginFlow(deps) {
    const fetchFn = deps.fetch;
    const setT = deps.setTimeout;
    const clearT = deps.clearTimeout;
    const now = deps.now || Date.now;
    const view = deps.view;
    const navigate = deps.navigate;
    const rotateMs = deps.rotateMs || ROTATE_MS;

    let started = false;
    let stopped = false;     // no provider, or logged in: nothing more to do
    let hidden = false;      // document.hidden: polling and rotation paused
    let starting = false;    // a start request is in flight
    let nonce = null;
    let rotateAt = 0;
    let refused = false;     // keep "Login refused" over the next fresh code
    let pollCtl = null;      // AbortController of the in-flight poll
    let pollTimer = null;
    let tickTimer = null;
    let startTimer = null;
    let pollBackoff = 0;
    let startBackoff = 0;
    let notBefore = 0;       // no start request before this time (gap / backoff)

    const nextBackoff = (cur) => (cur ? Math.min(cur * 2, BACKOFF_MAX_MS) : BACKOFF_MIN_MS);
    const nextStartBackoff = (cur) => (cur ? Math.min(cur * 2, START_BACKOFF_MAX_MS) : START_BACKOFF_MIN_MS);

    function post(path, body, signal) {
      return fetchFn(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
        signal,
      });
    }

    function abortPoll() {
      clearT(pollTimer); pollTimer = null;
      if (pollCtl) { const c = pollCtl; pollCtl = null; c.abort(); }
    }
    function stopTick() { clearT(tickTimer); tickTimer = null; }
    function stopAll() {
      abortPoll(); stopTick();
      clearT(startTimer); startTimer = null;
    }

    async function requestChallenge() {
      if (stopped || hidden || starting) return;
      clearT(startTimer); startTimer = null;
      stopTick();
      abortPoll();
      const wait = notBefore - now();
      if (wait > 0) {
        view.setCountdown(null);
        startTimer = setT(requestChallenge, wait);
        return;
      }
      starting = true;
      notBefore = now() + MIN_START_GAP_MS;
      let ch = null;
      let retryMs = 0;
      try {
        const res = await post(START, nonce ? { replaces: nonce } : {});
        if (res.ok) ch = await res.json();
        else if (res.status !== 404) { // 429 / 5xx: try again later
          startBackoff = nextStartBackoff(startBackoff);
          retryMs = Math.max(startBackoff, retryAfterMs(res));
        }
      } catch {
        startBackoff = nextStartBackoff(startBackoff);
        retryMs = startBackoff;
      }
      starting = false;
      if (stopped) return;
      if (retryMs) {
        notBefore = now() + retryMs;
        view.setStatus('Could not get a login code, retrying…', 'error');
        view.setCountdown(null);
        requestChallenge(); // waits for notBefore (and for a visible tab)
        return;
      }
      startBackoff = 0;
      if (!ch || !Array.isArray(ch.providers) || !ch.providers.length || !ch.nonce) {
        // No ready provider: the page is just the token form.
        stopped = true;
        nonce = null;
        stopAll();
        view.hide();
        return;
      }
      nonce = ch.nonce;
      const life = Number(ch.expiresInMs) > 0 ? Math.min(rotateMs, Number(ch.expiresInMs)) : rotateMs;
      rotateAt = now() + life;
      view.show(ch);
      if (refused) refused = false;
      else view.setStatus('Waiting for approval…', 'wait');
      tick();
      schedulePoll(0);
    }

    function retryAfterMs(res) {
      const v = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
      const secs = Number(v);
      return secs > 0 ? Math.min(secs * 1000, RETRY_AFTER_MAX_MS) : 0;
    }

    function tick() {
      tickTimer = null;
      if (stopped || hidden) return;
      const left = rotateAt - now();
      if (left <= 0) { requestChallenge(); return; }
      view.setCountdown(Math.ceil(left / 1000));
      tickTimer = setT(tick, ((left - 1) % 1000) + 1);
    }

    function schedulePoll(delay) {
      clearT(pollTimer);
      pollTimer = setT(poll, delay);
    }

    async function poll() {
      pollTimer = null;
      if (stopped || hidden || !nonce || pollCtl || starting) return;
      const mine = nonce;
      const ctl = new AbortController();
      pollCtl = ctl;
      const t0 = now();
      let r;
      try {
        const res = await post(POLL, { nonce: mine }, ctl.signal);
        if (res.ok) r = await res.json();
        else if ([400, 404, 410].includes(res.status)) r = { status: 'expired' };
        else throw new Error(`HTTP ${res.status}`);
      } catch {
        if (pollCtl === ctl) pollCtl = null;
        if (ctl.signal.aborted) return; // rotation or hiding cancelled it
        pollBackoff = nextBackoff(pollBackoff);
        schedulePoll(pollBackoff);
        return;
      }
      if (pollCtl === ctl) pollCtl = null;
      pollBackoff = 0;
      const status = r && r.status;
      if (status === 'ok') {
        // The server set the sid cookie with this answer.
        stopped = true;
        stopAll();
        view.setStatus('Logged in', 'ok');
        navigate('/');
        return;
      }
      if (ctl.signal.aborted || mine !== nonce || stopped) return; // stale answer
      if (status === 'denied') {
        refused = true;
        view.setStatus('Login refused', 'error');
        requestChallenge();
        return;
      }
      if (status === 'expired') { requestChallenge(); return; }
      schedulePoll(Math.max(0, MIN_POLL_GAP_MS - (now() - t0)));
    }

    return {
      start() {
        if (started) return;
        started = true;
        requestChallenge();
      },
      setHidden(h) {
        h = !!h;
        if (h === hidden) return;
        hidden = h;
        if (hidden) { stopAll(); return; }
        if (!started || stopped) return;
        if (!nonce || now() >= rotateAt) requestChallenge();
        else { tick(); schedulePoll(0); }
      },
      // For tests.
      state() {
        return { started, stopped, hidden, starting, nonce, rotateAt, polling: !!pollCtl };
      },
    };
  }

  // ---- browser view ----

  function el(doc, tag, cls, text) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // The QR is the server's SVG markup shown through an <img> data: URL
  // (CSP img-src allows data:): an SVG loaded as an image cannot run script
  // or touch this page, so the markup is never parsed into the document.
  function qrDataUrl(svg) {
    if (typeof svg !== 'string') return null;
    const s = svg.trim();
    if (!/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(s)) return null;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
  }

  function safeLink(link) {
    return typeof link === 'string' && /^https:\/\//i.test(link) ? link : null;
  }

  function providerCard(doc, p, code) {
    const label = String(p.label || p.id || 'app');
    const card = el(doc, 'div', 'provider');
    card.dataset.provider = String(p.id || '');
    card.appendChild(el(doc, 'div', 'provider-label', label));
    card.appendChild(el(doc, 'div', 'provider-hint', `Scan the code with your phone (or open the link), then approve the login in ${label}.`));
    const src = qrDataUrl(p.qrSvg);
    if (src) {
      const img = el(doc, 'img', 'qr');
      img.alt = `QR code for ${label} login`;
      img.src = src;
      card.appendChild(img);
    }
    const codeEl = el(doc, 'div', 'challenge-code');
    codeEl.appendChild(el(doc, 'span', 'challenge-code-label', 'Code '));
    const value = el(doc, 'span', 'challenge-code-value');
    // Shown in groups of four (ABCD EFGH); the gap is CSS, so a copy is the bare code.
    for (const part of String(code || '').match(/.{1,4}/g) || []) value.appendChild(el(doc, 'span', 'challenge-code-group', part));
    codeEl.appendChild(value);
    card.appendChild(codeEl);
    const href = safeLink(p.link);
    if (href) {
      const a = el(doc, 'a', 'open-link', `Open in ${label}`);
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      card.appendChild(a);
    }
    return card;
  }

  function createView(doc) {
    const panel = doc.getElementById('challenge-panel');
    const list = doc.getElementById('challenge-providers');
    const statusEl = doc.getElementById('challenge-status');
    const countdownEl = doc.getElementById('challenge-countdown');
    const divider = doc.getElementById('login-divider');
    return {
      show(ch) {
        list.replaceChildren(...ch.providers.map(p => providerCard(doc, p, ch.code)));
        panel.hidden = false;
        divider.hidden = false;
      },
      hide() {
        panel.hidden = true;
        divider.hidden = true;
        list.replaceChildren();
      },
      setStatus(text, kind) {
        statusEl.textContent = text;
        statusEl.className = 'challenge-status' + (kind ? ' ' + kind : '');
      },
      setCountdown(seconds) {
        countdownEl.textContent = seconds == null ? '' : `New code in ${seconds}s`;
      },
    };
  }

  function boot(win) {
    const doc = win.document;
    if (/[?&]error=1(&|$)/.test(win.location.search)) {
      doc.getElementById('error').classList.add('visible');
    }
    const flow = createLoginFlow({
      fetch: win.fetch.bind(win),
      setTimeout: win.setTimeout.bind(win),
      clearTimeout: win.clearTimeout.bind(win),
      now: Date.now,
      view: createView(doc),
      navigate: (url) => { win.location.href = url; },
    });
    doc.addEventListener('visibilitychange', () => flow.setHidden(doc.hidden));
    flow.setHidden(doc.hidden);
    flow.start();
  }

  return { createLoginFlow, qrDataUrl, safeLink, boot, ROTATE_MS };
});
