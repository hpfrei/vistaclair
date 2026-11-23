// The "Antigravity (Google AI subscription)" block of the Models tab, under the
// Gemini provider (next to the key bar, as Claude auth sits under Anthropic).
// Pure: status in ({ state } from agy-auth:status, or null before the first
// answer), HTML out. The sign-in itself is agy-signin.js; the button is a
// [data-agy-signin] element it picks up.
(function (root) {
  const INSTALL_CMD = 'curl -fsSL https://antigravity.google/cli/install.sh | bash';
  const KEYRING_TEXT = 'The server\'s keyring (Secret Service) is locked or unreachable, so Antigravity cannot store a login. Unlock it on the server machine (log in to its desktop session).';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function renderAgyAuthSection(status) {
    const st = status && status.state;
    const btn = (label) => `<button type="button" class="claude-signin-btn" data-agy-signin>${label}</button>`;
    let badge, body = '';
    if (st === 'signed-in') {
      badge = `<span class="mm-key-ok">signed in</span> ${btn('Sign in with another account')}`;
    } else if (st === 'signed-out') {
      badge = `<span class="mm-key-missing">signed out</span> ${btn('Sign in to Antigravity')}`;
    } else if (st === 'keyring-locked') {
      badge = '<span class="mm-key-missing">keyring locked</span>';
      body = `<div class="provider-hint">${esc(KEYRING_TEXT)}</div>`;
    } else if (st === 'not-installed') {
      badge = '<span class="mm-key-missing">not installed</span>';
      body = `<div class="provider-hint">Antigravity (<code>agy</code>) is not installed on this server. Install it with <code>${esc(INSTALL_CMD)}</code>, then reload this page.</div>`;
    } else if (st) {
      badge = `<span class="mm-key-missing">sign-in state unknown</span> ${btn('Sign in to Antigravity')}`;
    } else {
      badge = '<span class="mm-key-missing">checking…</span>';
    }
    return `<div class="provider-claude-auth" id="agyAuthSection">
      <div class="provider-claude-auth-head">
        <strong>Antigravity (Google AI subscription)</strong> ${badge}
      </div>
      ${body}
      <div class="provider-hint">The API key above is separate from the Antigravity subscription: Antigravity runs on its own Google login, not on that key.</div>
    </div>`;
  }

  const api = { renderAgyAuthSection, INSTALL_CMD };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.agyAuthSection = api;
})(typeof window !== 'undefined' ? window : globalThis);
