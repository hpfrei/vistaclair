// ============================================================
// SECURITY SECTION — login sessions (add-on logins, one-time links)
// ============================================================
(function securityModule() {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const { showConfirm } = window.dashboard;
  let loaded = false;

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'content-type': 'application/json' },
      ...opts,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    return res.json();
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleString();
  }

  // s.via (how it was issued: 'login-link' or an add-on provider's via) and
  // s.who (free text from the provider) are shown verbatim, as data.
  const orDash = (v) => (v == null || v === '' ? '—' : String(v));

  function el(tag, text, style) {
    const e = document.createElement(tag);
    if (text != null) e.textContent = text;
    if (style) e.style.cssText = style;
    return e;
  }

  function sessionRow(s) {
    const row = el('div', null, 'display:flex;align-items:center;gap:12px;padding:8px 12px;border:1px solid var(--border,#414868);border-radius:4px;margin-bottom:6px;font-size:12px');
    const info = el('div', null, 'flex:1;min-width:0');
    const head = el('div', null, 'overflow-wrap:anywhere');
    head.append(`via ${orDash(s.via)} · who ${orDash(s.who && String(s.who).slice(0, 100))}`);
    if (s.current) {
      head.append(' ');
      head.appendChild(el('b', '(this session)'));
    }
    info.appendChild(head);
    const dim = 'color:var(--dim,#565f89)';
    info.appendChild(el('div', `${s.ip || 'unknown ip'} · ${String(s.ua || '').slice(0, 60)}`, dim));
    info.appendChild(el('div', `created ${fmtTime(s.createdAt)} · expires ${fmtTime(s.expiresAt)}`, dim));
    row.appendChild(info);
    const btn = el('button', 'Revoke');
    btn.className = 'cap-action-btn';
    btn.addEventListener('click', async () => {
      await api(`api/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
      loadSessions();
    });
    row.appendChild(btn);
    return row;
  }

  async function loadSessions() {
    try {
      const { sessions } = await api('api/sessions');
      const list = $('sessionsList');
      if (!sessions.length) {
        list.replaceChildren(el('p', 'No active sessions. You are logged in with the auth token or from this machine.',
          'font-size:12px;color:var(--dim,#565f89)'));
        return;
      }
      list.replaceChildren(...sessions.map(sessionRow));
    } catch {}
  }

  function init() {
    if (loaded) { loadSessions(); return; }
    loaded = true;

    $('revokeAllBtn').onclick = async () => {
      if (!(await showConfirm('Log out all other sessions?', { confirmLabel: 'Log out all', danger: true }))) return;
      await api('api/sessions', { method: 'DELETE' });
      loadSessions();
    };

    loadSessions();
  }

  // Lazy-init when the Security tab is opened
  document.getElementById('homeNav')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.view-tab');
    if (btn?.dataset.section === 'security') init();
  });
})();
