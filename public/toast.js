// ============================================================
// TOAST MODULE — universal notifications (header, top-middle)
// ============================================================
// Exposes window.dashboard.showToast({ message, sender, level, title, ts, duration, actions }).
// Toasts pop in the header center, auto-dismiss, and click-to-open in a detail
// modal. A header bell opens a notifications center with per-item + clear-all.
// Server/apps push toasts via the WS message { type: 'toast:push', ... }.
(function toastModule() {
  const { escHtml, registerModule } = window.dashboard;

  const LEVELS = { info: 'info', success: 'success', warning: 'warning', error: 'error' };
  const MAX_HISTORY = 200;
  const MAX_VISIBLE = 4;

  // Persistent notification history (most-recent-last). Each: {id, message, sender, level, title, ts, read}
  const history = [];
  let seq = 0;

  function container() {
    return document.getElementById('toastContainer');
  }

  function fmtTime(ts) {
    const d = new Date(ts || Date.now());
    return d.toLocaleString();
  }
  function fmtTimeShort(ts) {
    const d = new Date(ts || Date.now());
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function levelOf(v) {
    return LEVELS[v] || 'info';
  }

  // --- Public entry point ---
  function showToast(opts) {
    if (typeof opts === 'string') opts = { message: opts };
    opts = opts || {};
    const entry = {
      id: ++seq,
      message: String(opts.message != null ? opts.message : (opts.body != null ? opts.body : '')),
      sender: String(opts.sender || opts.appName || 'Vistaclair'),
      level: levelOf(opts.level),
      title: opts.title ? String(opts.title) : '',
      ts: opts.ts || Date.now(),
      duration: typeof opts.duration === 'number' ? opts.duration : null,
      // Buttons on the toast itself, e.g. Undo: [{ label, onClick() }]. One
      // click runs it and dismisses the toast.
      actions: Array.isArray(opts.actions) ? opts.actions.filter(a => a && a.label && typeof a.onClick === 'function') : [],
      read: false,
    };
    history.push(entry);
    while (history.length > MAX_HISTORY) history.shift();
    renderToast(entry);
    updateBadge();
    return entry.id;
  }

  function renderToast(entry) {
    const c = container();
    if (!c) return;
    // Cap visible toasts: oldest visible is dismissed early.
    const live = c.querySelectorAll('.toast-item');
    if (live.length >= MAX_VISIBLE) live[0].remove();

    const el = document.createElement('div');
    el.className = `toast-item toast-${entry.level}`;
    el.dataset.id = String(entry.id);
    const headline = entry.title || entry.message;
    const sub = entry.title ? entry.message : '';
    el.innerHTML =
      `<div class="toast-item-meta"><span class="toast-item-sender">${escHtml(entry.sender)}</span>` +
      `<span class="toast-item-time">${escHtml(fmtTimeShort(entry.ts))}</span></div>` +
      `<div class="toast-item-headline">${escHtml(headline)}</div>` +
      (sub ? `<div class="toast-item-sub">${escHtml(sub)}</div>` : '') +
      `<button class="toast-item-close" title="Dismiss">&times;</button>`;

    el.querySelector('.toast-item-close').addEventListener('click', (e) => {
      e.stopPropagation();
      el.remove();
    });
    if (entry.actions.length) {
      const row = document.createElement('div');
      row.className = 'toast-item-actions';
      for (const a of entry.actions) {
        const b = document.createElement('button');
        b.className = 'toast-item-action';
        b.textContent = String(a.label);
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          el.remove();
          try { a.onClick(); } catch (err) { console.error('[toast] action failed:', err); }
        });
        row.appendChild(b);
      }
      el.appendChild(row);
    }
    el.addEventListener('click', () => {
      entry.read = true;
      updateBadge();
      openDetail(entry);
    });

    c.appendChild(el);
    const dur = entry.duration != null
      ? entry.duration
      : (entry.level === 'error' || entry.level === 'warning' ? 10000 : 5000);
    if (dur > 0) {
      setTimeout(() => {
        el.classList.add('toast-out');
        setTimeout(() => el.remove(), 250);
      }, dur);
    }
  }

  // --- Detail modal (single toast) ---
  function openDetail(entry) {
    const backdrop = document.createElement('div');
    backdrop.className = 'alert-modal-backdrop';
    const modal = document.createElement('div');
    modal.className = `alert-modal toast-detail toast-detail-${entry.level}`;
    modal.innerHTML =
      `<div class="toast-detail-head">` +
        `<span class="toast-detail-sender">${escHtml(entry.sender)}</span>` +
        `<span class="toast-detail-level toast-${entry.level}">${escHtml(entry.level)}</span>` +
      `</div>` +
      `<div class="toast-detail-time">${escHtml(fmtTime(entry.ts))}</div>` +
      (entry.title ? `<div class="toast-detail-title">${escHtml(entry.title)}</div>` : '') +
      `<div class="toast-detail-body">${escHtml(entry.message)}</div>` +
      `<button class="alert-modal-ok">Close</button>`;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    modal.querySelector('.alert-modal-ok').focus();
    modal.querySelector('.alert-modal-ok').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }

  // --- Notifications center (history list) ---
  function openCenter() {
    history.forEach(h => { h.read = true; });
    updateBadge();

    const backdrop = document.createElement('div');
    backdrop.className = 'alert-modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'alert-modal toast-center';

    const renderList = () => {
      if (!history.length) {
        return '<div class="toast-center-empty">No notifications.</div>';
      }
      return [...history].reverse().map(h =>
        `<div class="toast-center-item toast-${h.level}" data-id="${h.id}">` +
          `<div class="toast-center-row">` +
            `<span class="toast-item-sender">${escHtml(h.sender)}</span>` +
            `<span class="toast-item-time">${escHtml(fmtTime(h.ts))}</span>` +
            `<button class="toast-center-del" data-del="${h.id}" title="Clear">&times;</button>` +
          `</div>` +
          (h.title ? `<div class="toast-item-headline">${escHtml(h.title)}</div>` : '') +
          `<div class="toast-item-sub">${escHtml(h.message)}</div>` +
        `</div>`
      ).join('');
    };

    const paint = () => {
      modal.innerHTML =
        `<div class="toast-center-head"><strong>Notifications</strong>` +
          `<button class="toast-center-clear">Clear all</button></div>` +
        `<div class="toast-center-list">${renderList()}</div>` +
        `<button class="alert-modal-ok">Close</button>`;
      modal.querySelector('.alert-modal-ok').addEventListener('click', () => backdrop.remove());
      modal.querySelector('.toast-center-clear').addEventListener('click', () => {
        history.length = 0;
        updateBadge();
        paint();
      });
      modal.querySelectorAll('.toast-center-del').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = Number(btn.dataset.del);
          const i = history.findIndex(h => h.id === id);
          if (i >= 0) history.splice(i, 1);
          updateBadge();
          paint();
        });
      });
      modal.querySelectorAll('.toast-center-item').forEach(item => {
        item.addEventListener('click', () => {
          const id = Number(item.dataset.id);
          const entry = history.find(h => h.id === id);
          if (entry) openDetail(entry);
        });
      });
    };

    paint();
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
    backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') backdrop.remove(); });
  }

  function updateBadge() {
    const badge = document.getElementById('toastBadge');
    if (!badge) return;
    const unread = history.filter(h => !h.read).length;
    if (unread > 0) {
      badge.textContent = unread > 99 ? '99+' : String(unread);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  // Bell button wiring (header)
  function bindBell() {
    const bell = document.getElementById('toastBellBtn');
    if (bell && !bell._bound) {
      bell._bound = true;
      bell.addEventListener('click', openCenter);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindBell);
  } else {
    bindBell();
  }

  // Inbound server/app push
  registerModule('toast:', (msg) => {
    if (msg.type === 'toast:push') {
      showToast({
        message: msg.message,
        sender: msg.sender,
        level: msg.level,
        title: msg.title,
        ts: msg.ts,
        duration: msg.duration,
      });
    } else if (msg.type === 'toast:clear') {
      history.length = 0;
      updateBadge();
    }
  });

  // --- Export ---
  window.dashboard.showToast = showToast;
  window.toastModule = { showToast, openCenter };
})();
