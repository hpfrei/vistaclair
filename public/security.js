// ============================================================
// SECURITY SECTION — Telegram login config + session management
// ============================================================
(function securityModule() {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const { showConfirm, escHtml: esc } = window.dashboard;
  let loaded = false;

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'content-type': 'application/json' },
      ...opts,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    return res.json();
  }

  function setStatus(msg, ok) {
    const el = $('tgStatus');
    el.textContent = msg;
    el.style.color = ok ? 'var(--green, #9ece6a)' : 'var(--red, #f7768e)';
    if (msg) setTimeout(() => { el.textContent = ''; }, 4000);
  }

  async function loadConfig() {
    try {
      const cfg = await api('api/tg-login/config');
      $('tgOwnerId').value = cfg.ownerUserId || '';
      $('tgTtlDays').value = cfg.sessionTtlDays || 30;
      $('tgBotToken').placeholder = cfg.botTokenSet ? '(saved — enter to replace)' : '123456789:AA...';
      $('tgDisableBtn').style.display = cfg.configured ? '' : 'none';
    } catch {}
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleString();
  }

  async function loadSessions() {
    try {
      const { sessions } = await api('api/sessions');
      const list = $('sessionsList');
      if (!sessions.length) {
        list.innerHTML = '<p style="font-size:12px;color:var(--dim,#565f89)">No active sessions. You are logged in with the auth token or from this machine.</p>';
        return;
      }
      list.innerHTML = sessions.map(s => `
        <div style="display:flex;align-items:center;gap:12px;padding:8px 12px;border:1px solid var(--border,#414868);border-radius:4px;margin-bottom:6px;font-size:12px">
          <div style="flex:1">
            <div>${s.via === 'telegram' ? 'Telegram login' : 'One-time link'}${s.current ? ' <b>(this session)</b>' : ''}</div>
            <div style="color:var(--dim,#565f89)">${esc(s.ip || 'unknown ip')} · ${esc(String(s.ua || '').slice(0, 60))}</div>
            <div style="color:var(--dim,#565f89)">created ${fmtTime(s.createdAt)} · expires ${fmtTime(s.expiresAt)}</div>
          </div>
          <button class="cap-action-btn" data-revoke="${esc(s.id)}">Revoke</button>
        </div>`).join('');
      list.querySelectorAll('[data-revoke]').forEach(btn => {
        btn.onclick = async () => {
          await api(`api/sessions/${encodeURIComponent(btn.dataset.revoke)}`, { method: 'DELETE' });
          loadSessions();
        };
      });
    } catch {}
  }

  function init() {
    if (loaded) { loadConfig(); loadSessions(); return; }
    loaded = true;

    $('tgSaveBtn').onclick = async () => {
      const body = {
        ownerUserId: $('tgOwnerId').value.trim(),
        sessionTtlDays: Number($('tgTtlDays').value) || 30,
      };
      const tok = $('tgBotToken').value.trim();
      if (tok) body.botToken = tok;
      try {
        await api('api/tg-login/config', { method: 'POST', body: JSON.stringify(body) });
        $('tgBotToken').value = '';
        setStatus('Saved — send any message to your bot, then try logging in from another browser', true);
        loadConfig();
      } catch (e) { setStatus(e.message, false); }
    };

    $('tgDisableBtn').onclick = async () => {
      if (!(await showConfirm('Disable Telegram login? External access will require the auth token again (or be unavailable in server mode).',
        { confirmLabel: 'Disable', danger: true }))) return;
      try {
        await api('api/tg-login/config', { method: 'POST', body: JSON.stringify({ botToken: '', ownerUserId: '' }) });
        setStatus('Disabled', true);
        loadConfig();
      } catch (e) { setStatus(e.message, false); }
    };

    $('revokeAllBtn').onclick = async () => {
      if (!(await showConfirm('Log out all other sessions?', { confirmLabel: 'Log out all', danger: true }))) return;
      await api('api/sessions', { method: 'DELETE' });
      loadSessions();
    };

    loadConfig();
    loadSessions();
  }

  // Lazy-init when the Security tab is opened
  document.getElementById('homeNav')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.view-tab');
    if (btn?.dataset.section === 'security') init();
  });
})();
