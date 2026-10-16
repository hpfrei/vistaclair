// ============================================================
// CLAUDE SIGN-IN — header pill + "Sign in to Claude" modal
// ============================================================
// The server (src/ws/claude-auth-handler.js) runs the unmodified
// `claude auth login --claudeai` in a pty; this modal only shows its screen in
// a small xterm and types into it. What the user types (the OAuth code) is
// sent straight on and never logged or kept.
//
//   window.claudeSignIn.open({ start?, notice? })
//   any [data-claude-signin] element → open and start the login
(function claudeSignInModule() {
  const { sendWs: rawSend, registerModule, escHtml, state } = window.dashboard;
  // Opening the modal mid-reconnect must not throw on a socket still CONNECTING.
  const sendWs = (msg) => { if (state.ws?.readyState === WebSocket.OPEN) rawSend(msg); };

  const modal = document.getElementById('claudeSignInModal');
  const pill = document.getElementById('claudeAuthPill');
  if (!modal) return;
  const $ = (id) => document.getElementById(id);
  const noticeEl = $('claudeSignInNotice');
  const statusEl = $('claudeSignInStatus');
  const startBtn = $('claudeSignInStart');
  const loginEl = $('claudeSignInLogin');
  const openUrlBtn = $('claudeSignInOpenUrl');
  const termEl = $('claudeSignInTerm');
  const pasteForm = $('claudeSignInPaste');
  const codeInput = $('claudeSignInCode');
  const resultEl = $('claudeSignInResult');
  const cancelBtn = $('claudeSignInCancel');
  const retryBtn = $('claudeSignInRetry');

  // On the server machine itself the CLI opens the browser and its localhost
  // callback finishes the login; anywhere else the user pastes the code.
  const HOST_NAMES = ['localhost', '127.0.0.1', '::1', '[::1]'];
  const hostBrowser = HOST_NAMES.includes(location.hostname);
  const AUTO_OPEN_KEY = 'claude-signin-auto-opened';
  const SCAN_MAX = 16 * 1024;

  let last = null;        // last claude-auth:status message
  let term = null, fit = null;
  let phase = 'idle';     // idle | running | done | failed
  let attached = false;   // this tab watches the running login
  let restartPending = false;
  let url = null;
  let scan = '';          // output tail, only until the URL is found
  let closeTimer = null;
  let statusWs = null;    // the socket the last status came over

  const isOpen = () => !modal.classList.contains('hidden');
  const planOf = (s) => {
    const t = s?.subscriptionType;
    return t ? t[0].toUpperCase() + t.slice(1) : '';
  };
  const accountText = (s) => [s.email ? `Signed in as ${s.email}` : 'Signed in', planOf(s)].filter(Boolean).join(' · ');

  // --- Header pill ---
  function renderPill() {
    if (!pill) return;
    const s = last?.status;
    pill.classList.toggle('hidden', !s);
    if (!s) return;
    pill.classList.remove('claude-auth-ok', 'claude-auth-warn');
    if (last.subscription) {
      const plan = planOf(s);
      pill.classList.add('claude-auth-ok');
      pill.innerHTML = `<span>Claude${plan ? ` ${escHtml(plan)}` : ''}</span>` +
        (s.email ? `<span class="claude-auth-pill-email">${escHtml(s.email)}</span>` : '');
      pill.title = `Signed in to Claude${s.email ? ` as ${s.email}` : ''}${plan ? ` (${plan} plan)` : ''}`;
    } else if (s.loggedIn) {
      pill.textContent = `Claude: ${s.authMethod || 'signed in'}`;
      pill.title = `Claude Code is signed in via ${s.authMethod || 'an unknown method'}, not a Claude subscription`;
    } else {
      pill.classList.add('claude-auth-warn');
      pill.textContent = 'Signed out — Sign in';
      pill.title = 'Claude Code is signed out: sign in to use your Claude subscription';
    }
  }

  function renderStatus() {
    const s = last?.status;
    if (!s) statusEl.textContent = 'Checking Claude sign-in…';
    else if (last.subscription) statusEl.textContent = accountText(s);
    else if (s.loggedIn) statusEl.textContent = `Signed in via ${s.authMethod || 'an unknown method'} (no Claude subscription)`;
    else statusEl.textContent = 'Signed out';
    startBtn.textContent = s?.loggedIn ? 'Sign in with another account' : 'Sign in to Claude';
  }

  // --- Modal state ---
  function setPhase(p) {
    phase = p;
    const busy = p === 'running';
    startBtn.classList.toggle('hidden', p !== 'idle');
    loginEl.classList.toggle('hidden', p === 'idle');
    pasteForm.classList.toggle('hidden', !busy);
    retryBtn.classList.toggle('hidden', p !== 'failed');
    cancelBtn.textContent = busy ? 'Cancel' : 'Close';
    if (p !== 'failed' && p !== 'done') showResult('');
  }

  function showResult(text, kind) {
    resultEl.textContent = text;
    resultEl.className = `claude-signin-result${kind ? ` claude-signin-result-${kind}` : ''}`;
    resultEl.classList.toggle('hidden', !text);
  }

  function setNotice(text) {
    noticeEl.textContent = text || '';
    noticeEl.classList.toggle('hidden', !text);
    startBtn.classList.toggle('claude-signin-btn-primary', !!text);
  }

  function setUrl(u) {
    url = u;
    openUrlBtn.disabled = !u;
    scan = '';
  }

  // The CLI prints the URL as an OSC 8 hyperlink (ESC]8;;URL ESC\ text
  // ESC]8;; ESC\), plain text as a fallback. Only a complete one counts.
  function findUrl(text) {
    const osc = /\x1b\]8;[^;]*;(https:\/\/[^\x1b\x07]+)(?:\x1b\\|\x07)/.exec(text);
    if (osc) return osc[1];
    const plain = /https:\/\/[^\s\x1b\x07]+(?=[\s\x1b\x07])/.exec(text);
    return plain ? plain[0] : null;
  }

  function onOutput(data) {
    if (!data) return;
    term?.write(data);
    if (/Invalid code/i.test(data)) {
      // The CLI hangs after rejecting a code: offer a fresh run.
      showResult('That code was not accepted. Copy the whole code, or try again.', 'error');
      retryBtn.classList.remove('hidden');
    }
    if (url) return;
    scan = (scan + data).slice(-SCAN_MAX);
    const u = findUrl(scan);
    if (u) setUrl(u);
  }

  function ensureTerminal() {
    if (term) return;
    const openLink = (e, uri) => { if (/^https?:\/\//i.test(uri)) window.open(uri, '_blank', 'noopener'); };
    term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: '"Cascadia Code", Menlo, Monaco, "Courier New", monospace',
      theme: { background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#a0a0ff', selectionBackground: 'rgba(160,160,255,0.3)' },
      convertEol: true,
      scrollback: 500,
      allowProposedApi: true,
      // OSC 8 links open directly, without xterm's confirm prompt.
      linkHandler: { activate: openLink },
    });
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    try { term.loadAddon(new WebLinksAddon.WebLinksAddon(openLink)); } catch {}
    term.open(termEl);
    term.onData((data) => { if (attached) sendWs({ type: 'claude-auth:login:input', data }); });
    term.onResize(({ cols, rows }) => { if (attached) sendWs({ type: 'claude-auth:login:resize', cols, rows }); });
  }

  function fitTerminal() {
    if (!term || !isOpen() || loginEl.classList.contains('hidden')) return;
    try { fit.fit(); } catch {}
  }

  // --- Login ---
  function start() {
    clearTimeout(closeTimer);
    setPhase('running');
    // Created once its box is visible: xterm measures its cells on open.
    ensureTerminal();
    setUrl(null);
    term.reset();
    fitTerminal();
    attached = true;
    sendWs({ type: 'claude-auth:login:start', cols: term.cols, rows: term.rows, hostBrowser });
  }

  function retry() {
    // One login at a time on the server: a hung one has to exit first.
    if (attached) {
      restartPending = true;
      sendWs({ type: 'claude-auth:login:cancel' });
    } else {
      start();
    }
  }

  function onExit(msg) {
    attached = false;
    if (restartPending) {
      restartPending = false;
      if (isOpen()) start();
      else setPhase('idle');
      return;
    }
    if (msg.ok) {
      setPhase('done');
      const text = msg.status ? accountText(msg.status) : 'Signed in';
      showResult(text, 'ok');
      window.dashboard.showToast?.({ sender: 'Claude', title: 'Signed in to Claude', message: text, level: 'success' });
      closeTimer = setTimeout(() => { if (phase === 'done') close(); }, 2500);
      return;
    }
    if (msg.reason === 'cancelled') { setPhase('idle'); return; }
    let why = msg.reason;
    if (msg.reason === 'exit') {
      why = msg.exitCode === 0 ? 'no Claude subscription on that account'
        : msg.signal ? `signal ${msg.signal}` : `exit code ${msg.exitCode}`;
    }
    setPhase('failed');
    showResult(`Sign-in did not complete (${why})`, 'error');
  }

  // --- Open / close ---
  function open(opts = {}) {
    clearTimeout(closeTimer);
    const wasOpen = isOpen();
    if (!wasOpen) {
      setNotice(opts.notice || '');
      if (phase === 'done' || (phase === 'failed' && !attached)) setPhase('idle');
      modal.classList.remove('hidden');
      requestAnimationFrame(fitTerminal);
      sendWs({ type: 'claude-auth:status', refresh: true });
    }
    renderStatus();
    if (attached) return;
    // Another tab's login is joined: login:start attaches and replays it.
    if (opts.start || last?.login?.running) start();
  }

  function close() {
    clearTimeout(closeTimer);
    if (attached) sendWs({ type: 'claude-auth:login:cancel' });
    restartPending = false;
    modal.classList.add('hidden');
    codeInput.value = '';
  }

  // --- Wiring ---
  startBtn.addEventListener('click', () => { setNotice(''); start(); });
  retryBtn.addEventListener('click', retry);
  cancelBtn.addEventListener('click', close);
  $('claudeSignInClose').addEventListener('click', close);
  openUrlBtn.addEventListener('click', () => { if (url) window.open(url, '_blank', 'noopener'); });
  pasteForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = codeInput.value.trim();
    codeInput.value = '';
    if (!value || !attached) return;
    sendWs({ type: 'claude-auth:login:input', data: value + '\r' });
    term?.focus();
  });
  pill?.addEventListener('click', () => {
    const s = last?.status;
    open({ start: !!s && !s.loggedIn });
  });
  // Capture phase: hint buttons sit inside panels and dialogs with their own
  // click handling.
  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('[data-claude-signin]')) return;
    e.preventDefault();
    open({ start: true });
  }, true);
  window.addEventListener('resize', () => { if (isOpen()) fitTerminal(); });

  registerModule('claude-auth:', (msg) => {
    switch (msg.type) {
      case 'claude-auth:status': {
        last = msg;
        // The status sent on connect is the server's cached one: ask the CLI
        // afresh once per connection.
        if (statusWs !== state.ws) { statusWs = state.ws; sendWs({ type: 'claude-auth:status', refresh: true }); }
        renderPill();
        if (isOpen()) renderStatus();
        const s = msg.status;
        // Claude calls are meant to run on the subscription but the CLI is
        // signed out: offer the sign-in once per browser session.
        if (s && !s.loggedIn && msg.wantsSubscription && !msg.login?.running && !isOpen()) {
          let seen = false;
          try { seen = !!sessionStorage.getItem(AUTO_OPEN_KEY); sessionStorage.setItem(AUTO_OPEN_KEY, '1'); } catch {}
          if (!seen) open({ notice: 'Claude calls are set to run on your Claude subscription, but Claude Code is signed out.' });
        }
        break;
      }
      case 'claude-auth:needed':
        if (!isOpen()) open({ notice: 'A Claude session was refused: your Claude sign-in has expired or was signed out.' });
        break;
      case 'claude-auth:login:started':
        if (msg.replay) onOutput(msg.replay);
        break;
      case 'claude-auth:login:output':
        onOutput(msg.data);
        break;
      case 'claude-auth:login:exit':
        onExit(msg);
        break;
      case 'claude-auth:login:error':
        attached = false;
        restartPending = false;
        setPhase('failed');
        showResult(msg.error || 'Could not start the sign-in.', 'error');
        break;
    }
  });

  setPhase('idle');
  window.claudeSignIn = { open };
})();
