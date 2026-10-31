// Google OAuth popup callback. A file, not an inline <script>: CSP
// script-src 'self' (src/csp.js).
(function() {
  var params = new URLSearchParams(window.location.search);
  var code = params.get('code');
  var error = params.get('error');
  var errorDesc = params.get('error_description');
  var statusEl = document.getElementById('status');

  // msg and email come from the URL / the exchange response: text, never markup.
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function showError(msg) {
    statusEl.innerHTML =
      '<h1 style="color:#ef4444;margin:0 0 .5rem;font-size:1.2rem">Auth Failed</h1>' +
      '<p style="color:#f87171;margin:0 0 .5rem;font-size:13px">' + esc(msg) + '</p>' +
      '<p style="color:#94a3b8;margin:0;font-size:11px">You can close this window and retry from the dashboard.</p>';
    notify('google-auth-error', { error: msg });
  }

  function showSuccess(email) {
    statusEl.style.borderColor = '#10b981';
    statusEl.innerHTML =
      '<h1 style="color:#10b981;margin:0 0 .5rem;font-size:1.2rem">&#10003; Connected!</h1>' +
      '<p style="margin:0 0 .5rem">' + esc(email) + '</p>' +
      '<p style="color:#94a3b8;margin:0;font-size:13px">This window will close automatically.</p>';
    notify('google-auth-success', { email: email });
    setTimeout(function() { window.close(); }, 2000);
  }

  function notify(type, data) {
    var msg = Object.assign({ type: type }, data);
    // Try posting to opener (works when popup opened from top-level window)
    if (window.opener) {
      window.opener.postMessage(msg, '*');
      // Also try reaching iframes inside the opener
      try {
        var frames = window.opener.document.querySelectorAll('iframe');
        for (var i = 0; i < frames.length; i++) {
          try { frames[i].contentWindow.postMessage(msg, '*'); } catch(e) {}
        }
      } catch(e) {}
    }
  }

  if (error) { showError(errorDesc || error); return; }
  if (!code) { showError('No authorization code received.'); return; }

  var redirectUri = window.location.origin + window.location.pathname;

  fetch('/apps/my-dashboard/api/auth/google/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code, redirectUri: redirectUri }),
    credentials: 'include'
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.ok && data.email) {
      showSuccess(data.email);
    } else {
      showError(data.error || 'Token exchange failed');
    }
  })
  .catch(function(err) {
    showError('Exchange failed: ' + err.message);
  });
})();
