// VistaSurface — the platform landing kit for app anonymous surfaces
// (docs/apps.md "Landing kit"). Renders a complete landing card from the
// app's /__surface/info: hero, login widgets (email + Telegram link-code with
// the bot deep link), and the licence/subscribe hook. Builds on VistaAuth
// (/pro/app-auth.js) as the auth ENGINE — token storage, api(), authedFetch —
// and auto-loads it when absent, so a landing page needs ONE script tag:
//
//   <div id="landing"></div>
//   <script src="__surface/kit.js"></script>
//   <script>
//     VistaSurface.init({
//       mount: '#landing',
//       next: 'app.html',                    // where a signed-in user lands
//       labels: { 'Log in': 'Anmelden' },    // optional i18n overrides
//     });
//   </script>
//
// Theming: link __surface/kit.css (done automatically) and override the
// --vs-* custom properties. No framework lock-in — apps with bespoke landings
// (pixachat) keep working and can adopt pieces via VistaSurface.info() /
// VistaSurface.auth().
(function () {
  'use strict';

  function appBase() {
    var m = location.pathname.match(/^(.*\/apps\/[a-z0-9-]+)\//);
    return m ? m[1] + '/' : './';
  }

  var LABELS = {};
  function t(s) { return LABELS[s] || s; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function ensureCss() {
    if (document.querySelector('link[data-vs-kit]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = appBase() + '__surface/kit.css'; l.setAttribute('data-vs-kit', '1');
    document.head.appendChild(l);
  }

  var _info = null;
  function fetchInfo() {
    if (_info) return Promise.resolve(_info);
    return fetch(appBase() + '__surface/info').then(function (r) {
      if (!r.ok) throw new Error('surface info unavailable');
      return r.json();
    }).then(function (j) { _info = j; return j; });
  }

  var _auth = null;

  function init(opts) {
    opts = opts || {};
    if (opts.labels) LABELS = opts.labels;
    ensureCss();
    var host = typeof opts.mount === 'string' ? document.querySelector(opts.mount) : opts.mount;
    if (!host) throw new Error('VistaSurface.init: mount target not found');
    host.innerHTML = '<div class="vs-loading">…</div>';

    var ready = window.VistaAuth ? Promise.resolve() : loadScript('/pro/app-auth.js');
    return Promise.all([ready, fetchInfo()]).then(function (r) {
      var info = r[1];
      render(host, info, opts);
      return info;
    }).catch(function (err) {
      host.innerHTML = '<div class="vs-err">' + esc(t('This page is unavailable right now.')) + '</div>';
      throw err;
    });
  }

  function render(host, info, opts) {
    var onLogin = typeof opts.onLogin === 'function' ? opts.onLogin : function () {
      if (opts.next) location.href = appBase() + String(opts.next).replace(/^\//, '');
    };

    host.innerHTML =
      '<div class="vs-landing">' +
        '<header class="vs-hero">' +
          '<h1 class="vs-title">' + esc(opts.title || info.title) + '</h1>' +
          (info.description ? '<p class="vs-desc">' + esc(t(info.description)) + '</p>' : '') +
        '</header>' +
        (info.telegram ? '<div class="vs-tg-cta">' +
          '<a class="vs-btn vs-tg-btn" href="' + esc(info.telegram.link) + '" target="_blank" rel="noopener">' +
            t('Open @' + info.telegram.username + ' in Telegram') + '</a>' +
          '<p class="vs-hint">' + esc(t('Send /link in the bot to get your login code.')) + '</p>' +
        '</div>' : '') +
        '<div class="vs-auth"></div>' +
        '<div class="vs-license" hidden></div>' +
      '</div>';

    _auth = window.VistaAuth.create({
      mount: host.querySelector('.vs-auth'),
      appKey: info.app,
      methods: info.methods,
      onAuthed: function (account) { onLogin(account, _auth); },
    });

    // Already signed in (token in storage)? Skip the gate.
    if (_auth.token()) {
      _auth.me().then(function (res) { if (res.ok) onLogin(res.body.account, _auth); });
    }

    if (info.license && opts.license !== false) renderLicense(host.querySelector('.vs-license'));
  }

  // Licence/subscribe hook: tier variants + checkout links from the app's own
  // (auth-exempt) products endpoint. Purely informational pre-login; claiming
  // a key happens post-login via api/auth/license/claim.
  function renderLicense(el) {
    fetch(appBase() + 'api/auth/license/products').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (p) {
        if (!p || !p.variants || !p.variants.length) return;
        el.hidden = false;
        el.innerHTML = '<h2 class="vs-license-title">' + esc(t('Plans')) + '</h2>' +
          '<div class="vs-tiers">' + p.variants.map(function (v) {
            return '<div class="vs-tier">' +
              '<div class="vs-tier-name">' + esc(v.name || v.slug) + '</div>' +
              (v.durationDays ? '<div class="vs-tier-meta">' + esc(String(v.durationDays)) + ' ' + esc(t('days')) + '</div>' : '') +
              (v.checkoutUrl ? '<a class="vs-btn vs-tier-btn" href="' + esc(v.checkoutUrl) + '" target="_blank" rel="noopener">' + t('Subscribe') + '</a>' : '') +
            '</div>';
          }).join('') + '</div>';
      }).catch(function () {});
  }

  window.VistaSurface = {
    init: init,
    info: fetchInfo,
    auth: function () { return _auth; },
    base: appBase,
  };
})();
