// Login page: the error flag and the Telegram device-code flow. A file, not
// an inline <script>, so the page runs under CSP script-src 'self'
// (src/csp.js). Served before auth by server.js (GET /login.js).
if (location.search.includes('error=1')) {
  document.getElementById('error').classList.add('visible');
}

(async function () {
  const tgPanel = document.getElementById('tg-panel');
  const tokenForm = document.getElementById('token-form');
  const codeEl = document.getElementById('tg-code');
  const statusEl = document.getElementById('tg-status');
  let info;
  try { info = await (await fetch('login/tg/info')).json(); } catch { return; }
  if (!info.configured) return; // token form stays as-is

  tgPanel.style.display = 'block';
  if (info.tokenLoginAllowed) {
    document.getElementById('show-token').onclick = () => {
      tgPanel.style.display = 'none';
      tokenForm.style.display = 'block';
      document.getElementById('token').focus();
    };
  } else {
    document.getElementById('show-token').style.display = 'none';
  }
  tokenForm.style.display = 'none';

  let nonce = null;
  async function newChallenge() {
    try {
      const res = await fetch('login/tg/start', { method: 'POST' });
      if (!res.ok) throw new Error();
      const ch = await res.json();
      nonce = ch.nonce;
      codeEl.textContent = ch.code;
      statusEl.className = 'tg-status';
      statusEl.innerHTML = '<span class="spinner"></span>Waiting for Telegram…';
    } catch {
      statusEl.textContent = 'Could not start login — retrying…';
      setTimeout(newChallenge, 5000);
    }
  }
  await newChallenge();

  (async function poll() {
    if (!nonce) return setTimeout(poll, 2000);
    try {
      const res = await fetch('login/tg/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce }),
      });
      const r = await res.json();
      if (r.status === 'ok') {
        statusEl.className = 'tg-status ok';
        statusEl.textContent = '✓ Logged in';
        location.href = '/';
        return;
      }
      if (r.status === 'expired') { await newChallenge(); }
    } catch {}
    setTimeout(poll, 2000);
  })();
})();

