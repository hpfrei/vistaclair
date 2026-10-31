// ============================================================
// PRO HEADER — PRO button, license/teaser modal, update check
// ============================================================
// Was an inline <script> in index.html; a file so the page runs under
// script-src 'self' (src/csp.js).
function applyProUpdate() {
  var btn = document.getElementById('updApplyBtn');
  var msg = document.getElementById('updMsg');
  if (btn) { btn.disabled = true; btn.textContent = 'Pulling update...'; }
  if (msg) { msg.textContent = ''; msg.className = 'pro-activate-msg'; }
  fetch('/api/pro/update', { method: 'POST' }).then(function(r) { return r.json(); }).then(function(data) {
    if (data.updated) {
      if (btn) { btn.textContent = 'Updated! Restarting...'; }
      showRestartingOverlay();
      fetch('/api/pro/restart', { method: 'POST' }).catch(function() {});
    } else if (data.ok) {
      if (msg) { msg.textContent = 'Already up to date'; msg.className = 'pro-activate-msg success'; }
      if (btn) { btn.disabled = false; btn.textContent = 'Update now'; }
      if (window.checkProStatus) window.checkProStatus(false);
    } else {
      if (msg) { msg.textContent = data.error || 'Update failed'; msg.className = 'pro-activate-msg error'; }
      if (btn) { btn.disabled = false; btn.textContent = 'Update now'; }
    }
  }).catch(function(err) {
    if (msg) { msg.textContent = 'Update failed: ' + err.message; msg.className = 'pro-activate-msg error'; }
    if (btn) { btn.disabled = false; btn.textContent = 'Update now'; }
  });
}

function activateWithKey() {
  var input = document.getElementById('proKeyInput');
  var btn = document.getElementById('proKeyBtn');
  var msg = document.getElementById('proClaimMsg');
  var key = (input.value || '').trim();
  if (!key) { if (msg) { msg.textContent = 'Enter a license key'; msg.className = 'pro-activate-msg error'; } return; }
  btn.disabled = true;
  btn.textContent = 'Activating...';
  if (msg) { msg.textContent = 'Activating license...'; msg.className = 'pro-activate-msg'; }
  fetch('/api/pro/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: key })
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (data.ok) {
      if (msg) { msg.textContent = 'Activated! Restarting...'; msg.className = 'pro-activate-msg success'; }
      showRestartingOverlay();
    } else {
      if (msg) { msg.textContent = data.error || 'Activation failed'; msg.className = 'pro-activate-msg error'; }
      btn.disabled = false;
      btn.textContent = 'Activate';
    }
  }).catch(function(err) {
    if (msg) { msg.textContent = 'Connection error: ' + err.message; msg.className = 'pro-activate-msg error'; }
    btn.disabled = false;
    btn.textContent = 'Activate';
  });
}

(function() {
  var proLoaded = false;
  var checkoutListenerAdded = false;
  var checkoutOrigins = null;
  var portalUrl = null;
  var cachedLicenseInfo = null;
  var cachedUpdateInfo = null;
  // The server's verdict; updateInfo is only detail for tooltips/the modal.
  var cachedUpdateAvailable = false;
  var cachedUpdateLock = null;

  var proHeaderBtn = document.getElementById('proHeaderBtn');
  var proUpdateBtn = document.getElementById('proUpdateBtn');
  var proCheckBtn = document.getElementById('proCheckBtn');
  var proModal = document.getElementById('proModal');
  var proModalClose = document.getElementById('proModalClose');
  var subInfoModal = document.getElementById('subInfoModal');
  var subInfoClose = document.getElementById('subInfoClose');
  var updModal = document.getElementById('proUpdateModal');
  var updClose = document.getElementById('proUpdateClose');
  var updAllowChk = document.getElementById('updAllowChk');
  var updApplyBtn = document.getElementById('updApplyBtn');

  function showProModal() { if (proModal) proModal.style.display = 'flex'; }
  function hideProModal() { if (proModal) proModal.style.display = 'none'; }
  function showSubInfoModal() { if (subInfoModal) subInfoModal.style.display = 'flex'; }
  function hideSubInfoModal() { if (subInfoModal) subInfoModal.style.display = 'none'; }

  if (proModalClose) proModalClose.addEventListener('click', hideProModal);
  if (proModal) {
    proModal.addEventListener('click', function(e) { if (e.target === proModal) hideProModal(); });
    proModal.addEventListener('keydown', function(e) { if (e.key === 'Escape') hideProModal(); });
  }
  if (subInfoClose) subInfoClose.addEventListener('click', hideSubInfoModal);
  if (subInfoModal) {
    subInfoModal.addEventListener('click', function(e) { if (e.target === subInfoModal) hideSubInfoModal(); });
    subInfoModal.addEventListener('keydown', function(e) { if (e.key === 'Escape') hideSubInfoModal(); });
  }

  function hideUpdModal() { if (updModal) updModal.style.display = 'none'; }
  if (updClose) updClose.addEventListener('click', hideUpdModal);
  if (updModal) {
    updModal.addEventListener('click', function(e) { if (e.target === updModal) hideUpdModal(); });
    updModal.addEventListener('keydown', function(e) { if (e.key === 'Escape') hideUpdModal(); });
  }

  function fmtCommit(c) {
    if (!c) return 'unknown';
    var d = c.date ? new Date(c.date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
    return c.hash + (d ? ' · ' + d : '') + (c.subject ? ' · ' + c.subject : '');
  }

  function showUpdModal() {
    var info = cachedUpdateInfo;
    var lock = cachedUpdateLock || {};
    document.getElementById('updLocalVer').textContent = info ? fmtCommit(info.local) : 'unknown';
    document.getElementById('updRemoteVer').textContent = info ? fmtCommit(info.remote) : 'unknown';
    var statusLine = 'Up to date';
    if (info) {
      var parts = [];
      if (info.sameContent && !info.dirty) {
        // Content-identical: the server republished its release commit, so
        // history differs while the files do not. Not an update.
        parts.push('Up to date');
      } else {
        if (info.behind > 0) parts.push(info.behind + ' commit' + (info.behind === 1 ? '' : 's') + ' behind');
        // Local commits are meaningful only in a dev checkout; in a licensed
        // mirror they are just the server's rewritten history.
        if (info.ahead > 0 && !info.mirror) parts.push(info.ahead + ' local commit' + (info.ahead === 1 ? '' : 's') + ' not on the server');
        if (info.ahead > 0 && info.mirror && info.behind === 0) parts.push('differs from the server version');
        if (info.dirty) parts.push('locally modified');
      }
      if (parts.length) statusLine = parts.join(', ');
    } else {
      statusLine = 'No update check has run yet';
    }
    document.getElementById('updStatusLine').textContent = statusLine;

    var warn = document.getElementById('updWarnings');
    warn.innerHTML = '';
    function addWarn(text) {
      var div = document.createElement('div');
      div.className = 'upd-warning';
      div.textContent = '⚠ ' + text;
      warn.appendChild(div);
    }
    if (lock.devInstall) addWarn('This is a development checkout (git origin is not the license server). This is where the vc-pro codebase is maintained — updating here could overwrite it.');
    if (info && info.dirty) addWarn(info.mirror
      ? 'This copy has local modifications. Updating discards them and restores the server version.'
      : 'The working tree has uncommitted changes.');
    // A licensed install is a disposable mirror of the update server: its
    // "local commits" are the server's republished history, not user work,
    // and updating simply resets to the server. Only a dev checkout, where
    // local commits are real work, warrants a warning.
    if (info && info.ahead > 0 && !info.mirror) addWarn('Local commits exist that the update server does not have. A pull may fail or create unexpected results.');

    if (updAllowChk) updAllowChk.checked = !lock.disabled;
    updateApplyState();
    var msg = document.getElementById('updMsg');
    if (msg) { msg.textContent = ''; msg.className = 'pro-activate-msg'; }
    if (updModal) updModal.style.display = 'flex';
  }

  function updateApplyState() {
    if (!updApplyBtn) return;
    var allowed = updAllowChk && updAllowChk.checked;
    var i = cachedUpdateInfo;
    // Mirrors realign to the server whenever they deviate from it (the
    // server's history rewrites make "behind" alone an unreliable signal).
    var hasUpdate = !!i && (i.mirror ? (i.dirty || !i.sameContent) : i.behind > 0);
    updApplyBtn.disabled = !allowed || !hasUpdate;
    updApplyBtn.textContent = hasUpdate ? 'Update now' : 'Nothing to update';
    updApplyBtn.title = allowed ? '' : 'Updates are disabled on this machine';
  }

  if (updAllowChk) updAllowChk.addEventListener('change', function() {
    var disabled = !updAllowChk.checked;
    updAllowChk.disabled = true;
    fetch('/api/pro/update-lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: disabled })
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.updateLock) cachedUpdateLock = data.updateLock;
      updAllowChk.checked = !(cachedUpdateLock && cachedUpdateLock.disabled);
      updateApplyState();
      renderUpdateBtn();
    }).catch(function() {
      updAllowChk.checked = !disabled;
    }).finally(function() {
      updAllowChk.disabled = false;
    });
  });

  if (updApplyBtn) updApplyBtn.addEventListener('click', applyProUpdate);
  var proKeyBtn = document.getElementById('proKeyBtn');
  if (proKeyBtn) proKeyBtn.addEventListener('click', activateWithKey);

  function populateSubInfo() {
    var productRow = document.getElementById('subInfoProductRow');
    var expiryRow = document.getElementById('subInfoExpiryRow');
    var emailRow = document.getElementById('subInfoEmailRow');
    var portalLink = document.getElementById('subInfoPortalLink');
    var fallback = document.getElementById('subInfoFallback');

    if (cachedLicenseInfo && cachedLicenseInfo.productName) {
      document.getElementById('subInfoProduct').textContent = cachedLicenseInfo.productName;
      if (productRow) productRow.style.display = '';
    } else {
      if (productRow) productRow.style.display = 'none';
    }

    if (cachedLicenseInfo && cachedLicenseInfo.expiresAt) {
      var d = new Date(cachedLicenseInfo.expiresAt);
      document.getElementById('subInfoExpiry').textContent = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
      if (expiryRow) expiryRow.style.display = '';
    } else {
      if (expiryRow) expiryRow.style.display = 'none';
    }

    if (cachedLicenseInfo && cachedLicenseInfo.email) {
      document.getElementById('subInfoEmail').textContent = cachedLicenseInfo.email;
      if (emailRow) emailRow.style.display = '';
    } else {
      if (emailRow) emailRow.style.display = 'none';
    }

    if (portalUrl) {
      if (portalLink) { portalLink.href = portalUrl; portalLink.style.display = ''; }
      if (fallback) fallback.style.display = 'none';
    } else {
      if (portalLink) portalLink.style.display = 'none';
      if (fallback) fallback.style.display = '';
    }
  }

  if (proHeaderBtn) proHeaderBtn.addEventListener('click', function() {
    if (proHeaderBtn.classList.contains('active') && portalUrl) {
      window.open(portalUrl, '_blank');
    } else if (proHeaderBtn.classList.contains('active') && !portalUrl) {
      proHeaderBtn.textContent = 'Loading...';
      proHeaderBtn.disabled = true;
      fetch('/api/pro/status?check=1')
        .then(function(r) { return r.json(); })
        .then(function(s) {
          if (s.customerPortalUrl) portalUrl = s.customerPortalUrl;
          if (s.licenseInfo) cachedLicenseInfo = s.licenseInfo;
          if (portalUrl) {
            window.open(portalUrl, '_blank');
          } else {
            populateSubInfo();
            showSubInfoModal();
          }
        })
        .catch(function() {
          populateSubInfo();
          showSubInfoModal();
        })
        .finally(function() {
          proHeaderBtn.textContent = 'Manage subscription';
          proHeaderBtn.disabled = false;
        });
    } else if (!proHeaderBtn.classList.contains('active')) {
      showProModal();
    }
  });

  if (proUpdateBtn) proUpdateBtn.addEventListener('click', showUpdModal);

  // Manual update check: the server only re-checks hourly and the page only
  // reads the cached result on load, so this forces a fresh git fetch now.
  if (proCheckBtn) proCheckBtn.addEventListener('click', function() {
    proCheckBtn.disabled = true;
    proCheckBtn.innerHTML = 'Checking&#8230;';
    fetch('/api/pro/update-check', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.updateInfo) cachedUpdateInfo = data.updateInfo;
        if (data.updateLock) cachedUpdateLock = data.updateLock;
        cachedUpdateAvailable = !!data.updateAvailable;
        renderUpdateBtn();
        if (data.updateError) {
          proCheckBtn.innerHTML = 'Check failed';
          proCheckBtn.title = data.updateError;
        } else {
          proCheckBtn.title = 'Check now whether a new pro version is available';
          proCheckBtn.innerHTML = cachedUpdateAvailable ? '&#8635; Check' : '&#10003; Up to date';
        }
      })
      .catch(function() { proCheckBtn.innerHTML = 'Check failed'; })
      .finally(function() {
        proCheckBtn.disabled = false;
        setTimeout(function() { proCheckBtn.innerHTML = '&#8635; Check'; }, 2500);
      });
  });

  function renderUpdateBtn() {
    if (!proUpdateBtn) return;
    var info = cachedUpdateInfo;
    var locked = cachedUpdateLock && cachedUpdateLock.disabled;
    var hasUpdate = cachedUpdateAvailable && !!info;
    proUpdateBtn.style.display = hasUpdate ? '' : 'none';
    if (!hasUpdate) return;
    proUpdateBtn.classList.toggle('locked', !!locked);
    proUpdateBtn.innerHTML = locked ? '&#8593; Update &#128274;' : '&#8593; Update';
    var detail = info.behind > 0
      ? info.behind + ' commit' + (info.behind === 1 ? '' : 's') + ' behind' + (info.ahead > 0 ? ', ' + info.ahead + ' ahead' : '')
      : (info.dirty ? 'locally modified' : 'differs from the server version');
    var t = 'vc-pro ' + (info.local && info.local.hash) + ' → ' + (info.remote && info.remote.hash) + ' (' + detail + ')';
    if (locked) t += ' — updates disabled on this machine';
    proUpdateBtn.title = t + '. Click for details.';
  }

  function showRegistryError(reason) {
    var container = document.getElementById('proVariantButtons');
    if (!container) return;
    container.innerHTML = '<div class="pro-registry-notice">'
      + '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="7"/><line x1="8" y1="5" x2="8" y2="9"/><circle cx="8" cy="11.5" r="0.5" fill="currentColor" stroke="none"/></svg> '
      + '<span>' + reason + '</span></div>';
  }

  function renderProStatus(s) {
    if (proHeaderBtn) {
      if (s.loaded || s.licensed) {
        proHeaderBtn.classList.add('active');
        proHeaderBtn.textContent = 'Manage subscription';
        proHeaderBtn.title = 'Manage your VistaClair Pro subscription';
      } else {
        proHeaderBtn.classList.remove('active');
        proHeaderBtn.textContent = 'PRO';
        proHeaderBtn.title = 'Get VistaClair Pro';
      }
    }

    if (proCheckBtn) proCheckBtn.style.display = (s.installed && (s.loaded || s.licensed)) ? '' : 'none';

    if (s.customerPortalUrl) portalUrl = s.customerPortalUrl;
    if (s.licenseInfo) cachedLicenseInfo = s.licenseInfo;
    if (s.updateInfo) cachedUpdateInfo = s.updateInfo;
    cachedUpdateAvailable = !!s.updateAvailable;
    if (s.updateLock) cachedUpdateLock = s.updateLock;
    renderUpdateBtn();

    if (s.loaded && s.clientModules && !proLoaded) {
      proLoaded = true;
      try { sessionStorage.removeItem('proAutoRestarted'); } catch (e) {}
      s.clientModules.forEach(function(mod) {
        (mod.styles || []).forEach(function(href) {
          var link = document.createElement('link');
          link.rel = 'stylesheet'; link.href = href;
          document.head.appendChild(link);
        });
        var scripts = mod.scripts || [];
        (function loadNext(i) {
          if (i >= scripts.length) return;
          var el = document.createElement('script');
          el.src = scripts[i];
          el.onload = function() { loadNext(i + 1); };
          document.body.appendChild(el);
        })(0);
      });
      return;
    }

    if (s.needsRestart) {
      var msg = document.getElementById('proClaimMsg');
      // One auto-restart only: if Pro still failed to load after a restart,
      // restarting again cannot help — without this guard the page restarts
      // the server in an endless loop.
      var alreadyTried = false;
      try { alreadyTried = !!sessionStorage.getItem('proAutoRestarted'); } catch (e) {}
      if (alreadyTried) {
        if (msg) { msg.textContent = 'Pro is licensed but failed to load. Check the server logs for "Pro:" errors.'; msg.className = 'pro-activate-msg error'; }
        return;
      }
      try { sessionStorage.setItem('proAutoRestarted', '1'); } catch (e) {}
      if (msg) { msg.textContent = 'Pro features licensed. Restarting to activate...'; msg.className = 'pro-activate-msg success'; }
      showRestartingOverlay();
      fetch('/api/pro/restart', { method: 'POST' }).catch(function() {});
      return;
    }

    if (s.productInfo && s.productInfo.variants && s.productInfo.variants.length) {
      var container = document.getElementById('proVariantButtons');
      if (!container) return;
      container.innerHTML = '';
      document.getElementById('proClaimMsg').textContent = '';
      document.getElementById('proClaimMsg').className = 'pro-activate-msg';
      s.productInfo.variants.forEach(function(v) {
        if (!v.checkoutUrl) return;
        var btn = document.createElement('button');
        btn.className = 'pro-buy-btn';
        btn.textContent = v.name;
        btn.dataset.checkoutUrl = v.checkoutUrl;
        btn.addEventListener('click', function() {
          if (window.LemonSqueezy) {
            LemonSqueezy.Url.Open(v.checkoutUrl);
          } else {
            window.open(v.checkoutUrl, '_blank');
          }
        });
        container.appendChild(btn);
      });
      // Where a Checkout.Success message may come from (public/checkout-msg.js).
      checkoutOrigins = checkoutMsg.checkoutOrigins(s.productInfo.variants.map(function(v) { return v.checkoutUrl; }));

      // The overlay's script: a trusted third party the CSP names (src/csp.js).
      if (!document.querySelector('script[src*="lemon.js"]')) {
        var lsScript = document.createElement('script');
        lsScript.src = checkoutMsg.LEMON_ORIGIN + '/js/lemon.js';
        lsScript.defer = true;
        // lemon.js sets up window.LemonSqueezy on the window load event, which
        // has passed by now; without this the buttons always fell back to a tab.
        lsScript.addEventListener('load', function() {
          if (typeof window.createLemonSqueezy === 'function') window.createLemonSqueezy();
        });
        document.head.appendChild(lsScript);
      }

      if (!checkoutListenerAdded) {
        checkoutListenerAdded = true;
        window.addEventListener('message', function(e) {
          var orderId = checkoutMsg.checkoutOrderId(e, checkoutOrigins);
          if (!orderId) return;
          var msg = document.getElementById('proClaimMsg');
          if (msg) { msg.textContent = 'Activating license...'; msg.className = 'pro-activate-msg'; }
          var btns = document.querySelectorAll('.pro-buy-btn');
          btns.forEach(function(b) { b.disabled = true; });

          fetch('/api/pro/claim', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: orderId })
          }).then(function(r) { return r.json(); }).then(function(data) {
            if (data.ok) {
              if (msg) { msg.textContent = 'Activated! Restarting...'; msg.className = 'pro-activate-msg success'; }
              showRestartingOverlay();
            } else {
              if (msg) { msg.textContent = data.error || 'Claim failed'; msg.className = 'pro-activate-msg error'; }
              btns.forEach(function(b) { b.disabled = false; });
            }
          }).catch(function(err) {
            if (msg) { msg.textContent = 'Connection error: ' + err.message; msg.className = 'pro-activate-msg error'; }
            btns.forEach(function(b) { b.disabled = false; });
          });
        });
      }
    } else {
      showRegistryError('This feature is still in development and will be available soon.');
    }
  }

  function checkProStatus(refresh) {
    var url = '/api/pro/status' + (refresh ? '?check=1' : '');
    fetch(url).then(function(r) { return r.json(); }).then(renderProStatus).catch(function() {});
  }

  window.checkProStatus = checkProStatus;
  checkProStatus(false);
})();
