// ============================================================
// ANTIGRAVITY SIGN-IN — header pill + "Sign in to Antigravity" modal
// ============================================================
// The server (src/ws/agy-auth-handler.js) runs the unmodified `agy acp --login`
// in a pty; this modal only shows its screen in a small xterm and sends the
// pasted authorization code. What the user pastes is sent straight on and
// never logged or kept. The sign-in links and CSS are shared with the Claude
// modal (claude-signin.js).
//
//   window.agySignIn.open({ start?, notice? })
//   any [data-agy-signin] element → open and start the login
(function agySignInModule() {
  const { sendWs: rawSend, registerModule, state } = window.dashboard;
  const sendWs = (msg) => { if (state.ws?.readyState === WebSocket.OPEN) rawSend(msg); };

  const modal = document.getElementById('agySignInModal');
  const pill = document.getElementById('agyAuthPill');
  if (!modal) return;
  const $ = (id) => document.getElementById(id);
  const noticeEl = $('agySignInNotice');
  const statusEl = $('agySignInStatus');
  const startBtn = $('agySignInStart');
  const loginEl = $('agySignInLogin');
  const openUrlBtn = $('agySignInOpenUrl');
  const termEl = $('agySignInTerm');
  const pasteForm = $('agySignInPaste');
  const codeInput = $('agySignInCode');
  const resultEl = $('agySignInResult');
  const cancelBtn = $('agySignInCancel');
  const retryBtn = $('agySignInRetry');

  const SCAN_MAX = 16 * 1024;
  const KEYRING_TEXT = 'The server\'s keyring (Secret Service) is locked or unreachable, so Antigravity cannot store a login. Unlock it on the server machine (log in to its desktop session), then check again.';

  let last = null;        // last agy-auth:status message
  let term = null, fit = null;
  let phase = 'idle';     // idle | running | done | failed
  let attached = false;
  let restartPending = false;
  let url = null;
  let scan = '';
  let closeTimer = null;
  let statusWs = null;

  const isOpen = () => !modal.classList.contains('hidden');
  const stateOf = () => last?.status?.state || null;

  function renderPill() {
    if (!pill) return;
    const st = stateOf();
    // Only where agy exists: nothing to show on a machine without it.
    pill.classList.toggle('hidden', !st || st === 'not-installed');
    if (pill.classList.contains('hidden')) return;
    pill.classList.remove('claude-auth-ok', 'claude-auth-warn');
    if (st === 'signed-in') {
      pill.classList.add('claude-auth-ok');
      pill.textContent = 'Antigravity';
      pill.title = 'Signed in to Antigravity (agy)';
    } else if (st === 'keyring-locked') {
      pill.classList.add('claude-auth-warn');
      pill.textContent = 'Antigravity: keyring locked';
      pill.title = KEYRING_TEXT;
    } else {
      pill.classList.add('claude-auth-warn');
      pill.textContent = 'Antigravity: Sign in';
      pill.title = 'Antigravity (agy) is signed out: sign in with your Google AI subscription';
    }
  }

  function renderStatus() {
    const st = stateOf();
    const text = {
      'signed-in': 'Signed in',
      'signed-out': 'Signed out',
      'keyring-locked': 'Keyring locked',
      'not-installed': 'Antigravity (agy) is not installed on this server',
      unknown: 'Sign-in state unknown',
    }[st] || 'Checking Antigravity sign-in…';
    statusEl.textContent = text;
    if (st === 'keyring-locked') setNotice(KEYRING_TEXT);
    else if (noticeEl.textContent === KEYRING_TEXT) setNotice('');
    startBtn.textContent = st === 'signed-in' ? 'Sign in with another account' : 'Sign in to Antigravity';
    startBtn.disabled = st === 'not-installed' || st === 'keyring-locked';
  }

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
    startBtn.classList.toggle('claude-signin-btn-primary', !!text && stateOf() !== 'keyring-locked');
  }

  function setUrl(u) {
    url = u;
    openUrlBtn.disabled = !u;
    scan = '';
  }

  // agy prints "Open this link in a browser to log in with Google: <url>".
  function findUrl(text) {
    const plain = /https:\/\/[^\s\x1b\x07]+(?=[\s\x1b\x07])/.exec(text);
    return plain ? plain[0] : null;
  }

  function onOutput(data) {
    if (!data) return;
    term?.write(data);
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
      linkHandler: { activate: openLink },
    });
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    try { term.loadAddon(new WebLinksAddon.WebLinksAddon(openLink)); } catch {}
    term.open(termEl);
    term.onData((data) => { if (attached) sendWs({ type: 'agy-auth:login:input', data }); });
    term.onResize(({ cols, rows }) => { if (attached) sendWs({ type: 'agy-auth:login:resize', cols, rows }); });
  }

  function fitTerminal() {
    if (!term || !isOpen() || loginEl.classList.contains('hidden')) return;
    try { fit.fit(); } catch {}
  }

  function start() {
    clearTimeout(closeTimer);
    setPhase('running');
    ensureTerminal();
    setUrl(null);
    term.reset();
    fitTerminal();
    attached = true;
    sendWs({ type: 'agy-auth:login:start', cols: term.cols, rows: term.rows });
  }

  function retry() {
    if (attached) {
      restartPending = true;
      sendWs({ type: 'agy-auth:login:cancel' });
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
      showResult('Signed in', 'ok');
      window.dashboard.showToast?.({ sender: 'Antigravity', title: 'Signed in to Antigravity', message: 'Signed in', level: 'success' });
      closeTimer = setTimeout(() => { if (phase === 'done') close(); }, 2500);
      return;
    }
    if (msg.reason === 'cancelled') { setPhase('idle'); return; }
    let why = msg.reason;
    if (msg.reason === 'exit') {
      why = msg.exitCode === 0 ? 'agy still reports signed out'
        : msg.signal ? `signal ${msg.signal}` : `exit code ${msg.exitCode}`;
    }
    setPhase('failed');
    showResult(`Sign-in did not complete (${why})`, 'error');
  }

  function open(opts = {}) {
    clearTimeout(closeTimer);
    if (!isOpen()) {
      setNotice(opts.notice || '');
      if (phase === 'done' || (phase === 'failed' && !attached)) setPhase('idle');
      modal.classList.remove('hidden');
      requestAnimationFrame(fitTerminal);
      sendWs({ type: 'agy-auth:status', refresh: true });
    }
    renderStatus();
    if (attached) return;
    const st = stateOf();
    if (st === 'not-installed' || st === 'keyring-locked') return;
    if (opts.start || last?.login?.running) start();
  }

  function close() {
    clearTimeout(closeTimer);
    if (attached) sendWs({ type: 'agy-auth:login:cancel' });
    restartPending = false;
    modal.classList.add('hidden');
    codeInput.value = '';
  }

  startBtn.addEventListener('click', () => { setNotice(''); start(); });
  retryBtn.addEventListener('click', retry);
  cancelBtn.addEventListener('click', close);
  $('agySignInClose').addEventListener('click', close);
  openUrlBtn.addEventListener('click', () => { if (url) window.open(url, '_blank', 'noopener'); });
  pasteForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = codeInput.value.trim();
    codeInput.value = '';
    if (!value || !attached) return;
    sendWs({ type: 'agy-auth:login:input', data: value + '\r' });
    term?.focus();
  });
  pill?.addEventListener('click', () => open({ start: stateOf() === 'signed-out' }));
  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('[data-agy-signin]')) return;
    e.preventDefault();
    open({ start: true });
  }, true);
  window.addEventListener('resize', () => { if (isOpen()) fitTerminal(); });

  registerModule('agy-auth:', (msg) => {
    switch (msg.type) {
      case 'agy-auth:status':
        last = msg;
        // The status sent on connect is the server's cached one: ask agy
        // afresh once per connection.
        if (statusWs !== state.ws) { statusWs = state.ws; sendWs({ type: 'agy-auth:status', refresh: true }); }
        renderPill();
        if (isOpen()) renderStatus();
        break;
      case 'agy-auth:needed':
        if (!isOpen()) {
          open({ notice: msg.reason === 'keyring-locked'
            ? KEYRING_TEXT
            : 'An Antigravity run was refused: agy is signed out or its sign-in has expired.' });
        }
        break;
      case 'agy-auth:login:started':
        if (msg.replay) onOutput(msg.replay);
        break;
      case 'agy-auth:login:output':
        onOutput(msg.data);
        break;
      case 'agy-auth:login:exit':
        onExit(msg);
        break;
      case 'agy-auth:login:error':
        attached = false;
        restartPending = false;
        setPhase('failed');
        showResult(msg.error || 'Could not start the sign-in.', 'error');
        break;
    }
  });

  setPhase('idle');
  window.agySignIn = { open };
})();
