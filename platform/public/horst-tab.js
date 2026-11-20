// === Horst header tab (Pro client module) ===
// Loads after apps.js in the main dashboard page. Creates the top-level
// "Horst" header tab + #view-horst container hosting the /pro/horst/ iframe
// (lazy-loaded on first open). Core's switchView() handles any
// [id^="view-"] + .header-tab[data-view=...] pair generically.
(function () {
  'use strict';

  const headerTabs = document.getElementById('headerTabs');
  if (!headerTabs) return;

  // Tab — inserted before the separator, i.e. right after the Apps tab
  // (apps.js ran first and inserted its own tab at the same anchor).
  const sep = headerTabs.querySelector('.header-tab-sep');
  const tab = document.createElement('button');
  tab.className = 'header-tab header-tab-horst';
  tab.dataset.view = 'horst';
  tab.innerHTML = '<span class="horst-tab-glyph">H</span>Horst';
  if (sep) headerTabs.insertBefore(tab, sep);
  else headerTabs.appendChild(tab);

  // View container with a lazy iframe.
  const view = document.createElement('div');
  view.id = 'view-horst';
  view.className = 'hidden';
  view.style.display = 'none';
  view.innerHTML = '<iframe id="horstFrame" title="Horst"></iframe>';
  const anchor = document.getElementById('view-apps') || document.getElementById('view-directories');
  if (anchor?.nextSibling) anchor.parentNode.insertBefore(view, anchor.nextSibling);
  else document.body.appendChild(view);

  // Self-contained styles (amber accent to match Horst's row).
  const style = document.createElement('style');
  style.textContent = `
    #view-horst { height: calc(100vh - 50px); overflow: hidden; }
    #view-horst iframe { width: 100%; height: 100%; border: none; display: block; background: var(--bg); }
    .horst-tab-glyph {
      display: inline-flex; align-items: center; justify-content: center;
      width: 18px; height: 18px; margin-right: 6px; border-radius: 5px;
      font-weight: 700; font-size: 12px; color: #1a1b26;
      background: linear-gradient(150deg, var(--yellow, #e0af68), #b8863e);
      vertical-align: -3px;
    }
    .apps-row-horst .horst-card-glyph {
      display: inline-flex; align-items: center; justify-content: center;
      width: 20px; height: 20px; border-radius: 6px;
      font-weight: 700; font-size: 12px; color: #1a1b26;
      background: linear-gradient(150deg, var(--yellow, #e0af68), #b8863e);
    }
    #horstCardStatus b { color: var(--yellow, #e0af68); font-weight: 500; }
  `;
  document.head.appendChild(style);

  function ensureFrame() {
    const frame = document.getElementById('horstFrame');
    if (frame && !frame.src) frame.src = '/pro/horst/';
  }

  // Lazy-load when the tab is clicked (core's delegated handler does the
  // actual view switch; we only prime the iframe).
  tab.addEventListener('click', ensureFrame);

  function open() {
    ensureFrame();
    if (typeof window.switchView === 'function') window.switchView('horst');
    else tab.click();
  }

  // Fills the pinned Horst row's status line (#horstCardStatus) after the
  // apps table renders (called from apps.js renderGrid).
  async function fillCardStatus() {
    const el = document.getElementById('horstCardStatus');
    if (!el) return;
    try {
      const res = await fetch('/pro/horst/api/state', { credentials: 'same-origin' });
      if (!res.ok) return;
      const s = await res.json();
      const bits = [
        `${s.directives.active} directive${s.directives.active === 1 ? '' : 's'}`,
        `${s.conversations} chat${s.conversations === 1 ? '' : 's'}`,
      ];
      if (s.directives.pending) bits.push(`<b>${s.directives.pending} to confirm</b>`);
      if (s.lastBriefingAt) {
        const d = new Date(s.lastBriefingAt);
        bits.push(`briefing ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`);
      }
      el.innerHTML = bits.join(' &middot; ');
    } catch { /* row keeps the placeholder */ }
  }

  window.horstModule = { open, fillCardStatus };
})();
