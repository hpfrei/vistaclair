// Drop-in multi-user auth widget for Vistaclair apps. Pairs with the turnkey
// server module (src/apps/app-auth.js). Self-contained — no dashboard deps — so
// it works on every surface: in-dashboard, owner full-screen, public full-screen,
// and (for the email tabs) anywhere a browser can POST.
//
//   <script src="/pro/app-auth.js"></script>
//   <div id="auth"></div>
//   <script>
//     const auth = VistaAuth.create({
//       mount: '#auth',
//       apiBase: 'api/auth',          // relative to the app's base path
//       methods: { telegram: true, email: true },
//       onAuthed: (account) => { /* token is stored; load the app */ },
//     });
//   </script>
//
// The session token is kept in localStorage under `va.<appKey>.session` and sent
// as `Authorization: Bearer`. VistaAuth.token() / .authedFetch() let app code make
// gated calls. On a Telegram mini-app surface the page should instead send the
// X-Telegram-Init-Data header (the server resolves either) — see authedFetch opts.
(function () {
  'use strict';

  function appKeyFromPath() {
    var m = location.pathname.match(/\/apps\/([a-z0-9-]+)\//);
    return m ? m[1] : 'app';
  }

  function create(opts) {
    opts = opts || {};
    var appKey = opts.appKey || appKeyFromPath();
    var storeKey = 'va.' + appKey + '.session';
    var apiBase = (opts.apiBase || 'api/auth').replace(/\/$/, '');
    var methods = opts.methods || { telegram: true, email: true };
    var onAuthed = typeof opts.onAuthed === 'function' ? opts.onAuthed : function () {};

    function token() { try { return localStorage.getItem(storeKey) || null; } catch (e) { return null; } }
    function setToken(t) { try { t ? localStorage.setItem(storeKey, t) : localStorage.removeItem(storeKey); } catch (e) {} }

    function authedFetch(url, init) {
      init = init || {};
      var headers = Object.assign({}, init.headers);
      var t = token();
      if (t) headers['Authorization'] = 'Bearer ' + t;
      if (opts.initData) headers['X-Telegram-Init-Data'] = opts.initData;
      if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
      return fetch(url, Object.assign({}, init, { headers: headers }));
    }

    function api(path, body, init) {
      init = init || {};
      var conf = Object.assign({ method: body ? 'POST' : 'GET' }, init);
      if (body) conf.body = JSON.stringify(body);
      return authedFetch(apiBase + '/' + path.replace(/^\//, ''), conf)
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); });
    }

    var root = null;
    function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

    var ERRORS = {
      invalid_email: 'That email address looks invalid.',
      weak_password: 'Password must be at least 8 characters.',
      email_taken: 'An account with that email already exists. Try logging in.',
      invalid_credentials: 'Email or password is incorrect.',
      email_unverified: 'Please verify your email first — check your inbox.',
      invalid_code: 'That code is invalid or has expired. Run /link in the bot again.',
      already_linked: 'That method is already linked to a different account.',
      rate_limited: 'Too many attempts. Please wait a minute and try again.',
    };
    function msg(b) { return (b && (ERRORS[b.error] || b.message)) || (b && b.error) || 'Something went wrong.'; }

    function render(mode) {
      mode = mode || 'login';
      if (!root) return;
      var tabs = [];
      if (methods.email) { tabs.push(tab('login', 'Log in', mode)); tabs.push(tab('signup', 'Sign up', mode)); }
      if (methods.telegram) tabs.push(tab('telegram', 'Telegram', mode));

      root.innerHTML =
        '<div class="va-card">' +
          '<div class="va-tabs">' + tabs.join('') + '</div>' +
          '<div class="va-body"></div>' +
          '<div class="va-msg" role="alert"></div>' +
        '</div>';
      bindTabs();
      var body = root.querySelector('.va-body');
      if (mode === 'signup') body.appendChild(emailForm('signup'));
      else if (mode === 'telegram') body.appendChild(telegramForm());
      else body.appendChild(emailForm('login'));
    }

    function tab(id, label, active) {
      return '<button class="va-tab' + (id === active ? ' va-active' : '') + '" data-tab="' + id + '">' + esc(label) + '</button>';
    }
    function bindTabs() {
      root.querySelectorAll('.va-tab').forEach(function (b) {
        b.addEventListener('click', function () { render(b.dataset.tab); });
      });
    }
    function showMsg(text, ok) {
      var m = root.querySelector('.va-msg');
      if (m) { m.textContent = text || ''; m.className = 'va-msg' + (ok ? ' va-ok' : text ? ' va-err' : ''); }
    }

    function emailForm(kind) {
      var f = el(
        '<form class="va-form">' +
          '<input class="va-in" type="email" name="email" placeholder="Email" autocomplete="email" required>' +
          '<input class="va-in" type="password" name="password" placeholder="Password" ' +
            'autocomplete="' + (kind === 'signup' ? 'new-password' : 'current-password') + '" required>' +
          '<button class="va-btn" type="submit">' + (kind === 'signup' ? 'Create account' : 'Log in') + '</button>' +
        '</form>');
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        showMsg('');
        var email = f.email.value.trim(), password = f.password.value;
        var btn = f.querySelector('button'); btn.disabled = true;
        api(kind, { email: email, password: password }).then(function (res) {
          btn.disabled = false;
          if (!res.ok) { showMsg(msg(res.body)); return; }
          if (kind === 'signup') { showMsg('Check your email to verify your account.', true); return; }
          if (res.body.token) { setToken(res.body.token); onAuthed(res.body.account); }
        }).catch(function () { btn.disabled = false; showMsg('Network error.'); });
      });
      return f;
    }

    function telegramForm() {
      var f = el(
        '<form class="va-form">' +
          '<p class="va-hint">Open the bot in Telegram, send <b>/link</b>, then enter the 6-digit code:</p>' +
          '<input class="va-in" type="text" name="code" inputmode="numeric" pattern="[0-9]*" ' +
            'maxlength="6" placeholder="123456" required>' +
          '<button class="va-btn" type="submit">Link Telegram</button>' +
        '</form>');
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        showMsg('');
        var code = f.code.value.trim();
        var btn = f.querySelector('button'); btn.disabled = true;
        api('link', { code: code }).then(function (res) {
          btn.disabled = false;
          if (!res.ok) { showMsg(msg(res.body)); return; }
          if (res.body.token) setToken(res.body.token);
          onAuthed(res.body.account);
        }).catch(function () { btn.disabled = false; showMsg('Network error.'); });
      });
      return f;
    }

    // Account panel: shows linked methods + actions to link the missing one.
    function renderAccount(target) {
      var host = typeof target === 'string' ? document.querySelector(target) : target;
      if (!host) return;
      api('me').then(function (res) {
        if (!res.ok) { host.innerHTML = ''; return; }
        var a = res.body.account || {};
        var rows = [];
        rows.push('<div class="va-row"><span>Email</span><span>' +
          (a.email ? esc(a.email) + (a.emailVerified ? ' ✓' : ' (unverified)') : '<i>not linked</i>') + '</span></div>');
        rows.push('<div class="va-row"><span>Telegram</span><span>' +
          (a.telegramLinked ? 'linked ✓' : '<i>not linked</i>') + '</span></div>');
        var actions = '';
        if (methods.email && !a.email) actions += '<button class="va-btn va-sm" data-act="add-email">Add email &amp; password</button>';
        if (methods.telegram && !a.telegramLinked) actions += '<button class="va-btn va-sm" data-act="add-tg">Link Telegram</button>';
        host.innerHTML = '<div class="va-card"><div class="va-account">' + rows.join('') + '</div>' +
          '<div class="va-actions">' + actions + '</div><div class="va-actform"></div><div class="va-msg2"></div></div>';
        bindAccountActions(host);
      });
    }

    function bindAccountActions(host) {
      var m2 = host.querySelector('.va-msg2');
      function note(t, ok) { if (m2) { m2.textContent = t || ''; m2.className = 'va-msg2' + (ok ? ' va-ok' : ' va-err'); } }
      var slot = host.querySelector('.va-actform');
      // Each action opens its form in the card (never a browser prompt); one at
      // a time. Cancel or Escape closes it without calling the server.
      function openForm(html, label, submit) {
        var f = el('<form class="va-form va-inline">' + html +
          '<div class="va-pair"><button class="va-btn va-sm va-ghost" type="button" data-cancel>Cancel</button>' +
          '<button class="va-btn va-sm" type="submit">' + esc(label) + '</button></div></form>');
        function close() { slot.innerHTML = ''; }
        f.querySelector('[data-cancel]').addEventListener('click', close);
        f.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); close(); } });
        f.addEventListener('submit', function (e) {
          e.preventDefault();
          note('');
          var btn = f.querySelector('[type="submit"]'); btn.disabled = true;
          submit(f).then(function (res) {
            btn.disabled = false;
            if (res.ok) close();
          }).catch(function () { btn.disabled = false; note('Network error.'); });
        });
        slot.innerHTML = '';
        slot.appendChild(f);
        f.querySelector('.va-in').focus();
      }
      host.querySelectorAll('[data-act]').forEach(function (b) {
        b.addEventListener('click', function () {
          var act = b.dataset.act;
          if (act === 'add-tg') {
            openForm(
              '<p class="va-hint">Send <b>/link</b> in the bot, then enter the code:</p>' +
              '<input class="va-in" type="text" name="code" inputmode="numeric" pattern="[0-9]*" ' +
                'maxlength="6" placeholder="123456" autocomplete="one-time-code" required>',
              'Link Telegram',
              function (f) {
                return api('link', { code: f.elements.code.value.trim() }).then(function (res) {
                  note(res.ok ? 'Telegram linked.' : msg(res.body), res.ok);
                  if (res.ok) renderAccount(host);
                  return res;
                });
              });
          } else if (act === 'add-email') {
            openForm(
              '<input class="va-in" type="email" name="email" placeholder="Email" autocomplete="email" required>' +
              '<input class="va-in" type="password" name="password" placeholder="Choose a password (min 8 chars)" ' +
                'minlength="8" autocomplete="new-password" required>',
              'Add email',
              function (f) {
                return api('attach-email', { email: f.elements.email.value.trim(), password: f.elements.password.value }).then(function (res) {
                  note(res.ok ? 'Check your email to verify.' : msg(res.body), res.ok);
                  if (res.ok) renderAccount(host);
                  return res;
                });
              });
          }
        });
      });
    }

    function logout() { setToken(null); }

    function mount(target) {
      root = typeof target === 'string' ? document.querySelector(target) : target;
      injectStyles();
      render('login');
      return widget;
    }

    var widget = {
      token: token, setToken: setToken, logout: logout,
      authedFetch: authedFetch, api: api,
      render: render, mount: mount, renderAccount: renderAccount,
      me: function () { return api('me'); },
    };

    if (opts.mount) mount(opts.mount);
    return widget;
  }

  var stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return; stylesInjected = true;
    var css =
      '.va-card{max-width:340px;margin:0 auto;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);' +
      'border-radius:12px;padding:18px;color:inherit;font:14px/1.4 system-ui,sans-serif}' +
      '.va-tabs{display:flex;gap:6px;margin-bottom:14px}' +
      '.va-tab{flex:1;padding:8px;background:transparent;border:0;border-bottom:2px solid transparent;' +
      'color:inherit;opacity:.6;cursor:pointer;font:inherit}' +
      '.va-tab.va-active{opacity:1;border-bottom-color:#6aa9ff}' +
      '.va-form{display:flex;flex-direction:column;gap:10px}' +
      '.va-in{padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.15);' +
      'background:rgba(0,0,0,.2);color:inherit;font:inherit}' +
      '.va-btn{padding:10px 12px;border-radius:8px;border:0;background:#6aa9ff;color:#06121f;' +
      'font:inherit;font-weight:600;cursor:pointer}' +
      '.va-btn:disabled{opacity:.6;cursor:default}' +
      '.va-btn.va-sm{padding:7px 10px;font-weight:500}' +
      '.va-hint{margin:0 0 4px;opacity:.7;font-size:13px}' +
      '.va-msg,.va-msg2{margin-top:10px;font-size:13px;min-height:1em}' +
      '.va-err{color:#ff8080}.va-ok{color:#7ee0a0}' +
      '.va-row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06)}' +
      '.va-actions{display:flex;flex-direction:column;gap:8px;margin-top:12px}' +
      '.va-inline{margin-top:12px}' +
      '.va-pair{display:flex;gap:8px;justify-content:flex-end}' +
      '.va-btn.va-ghost{background:transparent;color:inherit;border:1px solid rgba(255,255,255,.15)}';
    var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
  }

  window.VistaAuth = { create: create };
})();
