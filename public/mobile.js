// ============================================================
// MOBILE SHELL — bottom tab bar, "More" sheet, soft-keyboard fitting,
// swipe-to-dismiss toasts. Pure behaviour; the look is in mobile.css.
// Everything here is a no-op on desktop widths.
// ============================================================
(function mobileModule() {
  'use strict';

  const phoneQuery = window.matchMedia('(max-width: 640px)');
  const isPhone = () => phoneQuery.matches;
  window.dashboard.isPhone = isPhone;
  window.dashboard.phoneQuery = phoneQuery;

  // Installable app: the worker only caches CDN libraries (see sw.js).
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Deep link: /?view=dashboard (also #dashboard) opens straight into a
  // view — used by the PWA start URL and by headless screenshots.
  const wanted = new URLSearchParams(location.search).get('view') || location.hash.replace(/^#(view-)?/, '');
  if (wanted && document.getElementById('view-' + wanted)) switchView(wanted);

  // --- Bottom tab bar -------------------------------------------
  const tabbar = document.getElementById('mobileTabbar');
  const moreBtn = document.getElementById('mobileMoreBtn');
  const sheet = document.getElementById('mobileMore');
  if (!tabbar || !moreBtn || !sheet) return;

  tabbar.addEventListener('click', e => {
    const tab = e.target.closest('.mobile-tab[data-view]');
    if (!tab) return;
    closeSheet();
    switchView(tab.dataset.view);
  });

  // --- "More" sheet ---------------------------------------------
  function openSheet() {
    // Mirror which sheet view is current so the list shows a selection.
    const current = document.querySelector('.header-tab.active')?.dataset.view;
    sheet.querySelectorAll('.mobile-sheet-item[data-view]').forEach(b => {
      b.classList.toggle('active', b.dataset.view === current && !b.dataset.homeSection);
    });
    sheet.classList.remove('hidden');
  }
  function closeSheet() { sheet.classList.add('hidden'); }

  moreBtn.addEventListener('click', () => {
    sheet.classList.contains('hidden') ? openSheet() : closeSheet();
  });
  sheet.addEventListener('click', e => {
    if (e.target === sheet) { closeSheet(); return; }
    const item = e.target.closest('.mobile-sheet-item');
    if (!item) return;
    closeSheet();
    if (item.dataset.proxy) {
      // Theme / restart: press the real header button so there is one code path.
      document.getElementById(item.dataset.proxy)?.click();
      return;
    }
    if (item.dataset.view) {
      switchView(item.dataset.view);
      if (item.dataset.homeSection) {
        document.querySelector(`#homeNav .view-tab[data-section="${item.dataset.homeSection}"]`)?.click();
      }
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !sheet.classList.contains('hidden')) closeSheet();
  });

  // --- Inspector: timeline only; a tap opens the detail modal --------
  // On a phone the Inspector shows its timeline alone (no lanes); a tap on
  // an item opens inspector.js's detail modal, full-screen (mobile.css).
  // Request | Response toggle for the modal's split frame. The frame is
  // re-rendered on every open, so watch for it rather than patching
  // inspector.js.
  const modalBody = document.querySelector('#turn-modal .turn-modal-body');
  if (modalBody) {
    let mobilePane = localStorage.getItem('mobilePane') || 'response';
    const decorateSplit = split => {
      if (split.querySelector(':scope > .mobile-pane-toggle')) return;
      split.dataset.mobilePane = mobilePane;
      const toggle = document.createElement('div');
      toggle.className = 'mobile-pane-toggle';
      toggle.innerHTML = '<button data-pane="request">Request</button><button data-pane="response">Response</button>';
      const paint = () => toggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.pane === mobilePane));
      toggle.addEventListener('click', e => {
        const b = e.target.closest('button[data-pane]');
        if (!b) return;
        mobilePane = b.dataset.pane;
        localStorage.setItem('mobilePane', mobilePane);
        split.dataset.mobilePane = mobilePane;
        paint();
      });
      paint();
      split.prepend(toggle);
    };
    new MutationObserver(() => {
      modalBody.querySelectorAll('.vc-split').forEach(decorateSplit);
    }).observe(modalBody, { childList: true, subtree: true });
    modalBody.querySelectorAll('.vc-split').forEach(decorateSplit);
  }

  // --- Sub-nav: keep the active pill in view -----------------------
  // The pill rows scroll sideways; a selection made elsewhere (the More
  // sheet's "Security", a restored tab) may sit off-screen.
  const revealActive = nav => {
    if (!isPhone()) return;
    nav.querySelector('.view-tab.active')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  };
  document.querySelectorAll('.view-nav').forEach(nav => {
    new MutationObserver(() => revealActive(nav))
      .observe(nav, { attributes: true, attributeFilter: ['class'], subtree: true, childList: true });
    revealActive(nav);
  });

  // --- Soft keyboard: shrink the shell to the visible viewport ----
  // body is overflow:hidden, so without this the keyboard covers the
  // bottom of whatever view is open (composer, modal buttons, ...).
  const vv = window.visualViewport;
  if (vv) {
    let raf = 0;
    const fit = () => {
      raf = 0;
      if (!isPhone()) {
        document.body.style.removeProperty('--mobile-vh');
        return;
      }
      const shrunk = vv.height < window.innerHeight - 80;
      if (shrunk) {
        document.body.style.setProperty('--mobile-vh', vv.height + 'px');
        // iOS scrolls the page to reveal the focused field; undo that.
        if (window.scrollY) window.scrollTo(0, 0);
      } else {
        document.body.style.removeProperty('--mobile-vh');
      }
      document.body.classList.toggle('keyboard-open', shrunk);
      // Terminals re-fit through their ResizeObservers; nothing to do here.
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(fit); };
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    phoneQuery.addEventListener('change', schedule);
  }

  // --- Toasts: swipe sideways to dismiss ------------------------
  const toasts = document.getElementById('toastContainer');
  if (toasts) {
    let startX = 0, item = null;
    toasts.addEventListener('pointerdown', e => {
      if (!isPhone()) return;
      item = e.target.closest('.toast-item');
      if (!item) return;
      startX = e.clientX;
      item.style.transition = 'none';
    });
    toasts.addEventListener('pointermove', e => {
      if (!item) return;
      const dx = e.clientX - startX;
      item.style.transform = `translateX(${dx}px)`;
      item.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / 200));
    });
    const end = e => {
      if (!item) return;
      const dx = e.clientX - startX;
      const el = item;
      item = null;
      el.style.transition = '';
      if (Math.abs(dx) > 70) {
        el.querySelector('.toast-item-close')?.click();
      } else {
        el.style.transform = '';
        el.style.opacity = '';
      }
    };
    toasts.addEventListener('pointerup', end);
    toasts.addEventListener('pointercancel', end);
  }
})();
