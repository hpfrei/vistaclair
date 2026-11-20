// Horst UI — built-in resident agent surface (served at /pro/horst/).
// Server state is canonical; every view re-fetches on entry, so a reload
// restores everything (GUI-reload resilience). Vanilla JS, no frameworks.
(function () {
  'use strict';

  const API = '/pro/horst/api';
  const main = document.getElementById('horstMain');

  const ui = {
    view: 'chat',
    conversations: [],
    convId: localStorage.getItem('horst-conv') || null,
    conv: null,
    pollTimer: null,
    journalPollTimer: null,
    seenDirectiveBanners: new Set(), // messageIds whose banner was resolved this session
    evExpanded: new Set(),     // event ids expanded in the log
    evPolicySet: {},           // `${app}|${kind}` → policy chosen this session
    proposals: [],             // last-loaded proposals (approvals view)
    propEdit: null,            // proposal id currently being edited
    propDraft: null,           // working copy of the edited payload fields
    propDraftSeed: null,       // that copy as it was seeded — the "is it dirty?" baseline
    propOpen: null,            // proposal id shown in the expanded (overlay) view
    propSubscribed: false,     // approvals view owns one live subscription per visit
    propLiveTimer: null,
    dayCache: {},              // `${date}|${account}` → day events for the timeline
    dayPreviewTimer: null,     // debounce for repainting the day beside a calendar edit
    // --- map ---
    map: null,                 // HorstMap render context while the view is open
    mapSummary: null,
    mapStopReplay: null,
    // --- timeline ---
    tlFilter: { stream: '', source: '', policy: '' },
    tlRows: [],
    tlOpen: new Set(),         // expanded chain keys
    // --- directives workshop ---
    wsDraft: null,             // { id, text, analysis, answers:[{q,a}] }
    wsBusy: false,
    genome: null,
    // --- files ---
    files: { kind: '', open: null, rows: [], counts: {}, all: null, note: '' },
  };

  const unsubscribers = [];  // live-channel subscriptions owned by the open view

  function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  async function api(path, opts) {
    const res = await fetch(API + path, {
      credentials: 'same-origin',
      headers: opts && opts.body ? { 'Content-Type': 'application/json' } : undefined,
      ...opts,
    });
    // An expired auth cookie 302s to the login page, which arrives as 200 HTML —
    // without this check every view would silently render its empty state.
    const ctype = res.headers.get('content-type') || '';
    if (res.redirected || (res.ok && !ctype.includes('json'))) {
      throw new Error('not signed in — reload the dashboard and log in again');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  // Failed loads must be visibly different from genuinely empty lists.
  function loadErrNote(err) {
    return `<div class="empty-note error">⚠ Couldn't load: ${escHtml(err.message)}</div>`;
  }

  // --- in-page dialogs ------------------------------------------------------
  // The page never uses the browser's alert/confirm/prompt. A dialog sits above
  // every overlay; Escape or a backdrop click cancels, Enter confirms, Tab stays
  // inside it, and focus returns to where it was. While one is open its keys
  // never reach the page — an Esc meant for the dialog must not also close the
  // proposal or workshop modal underneath. Dialogs stack; keys go to the top one.
  const dialogs = [];

  function onDialogKey(e) {
    const d = dialogs[dialogs.length - 1];
    if (!d) return;
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); d.close(false); return; }
    if (e.key === 'Enter' && !e.isComposing) {
      // A focused button answers Enter with its own click (Cancel stays Cancel).
      if (e.target.closest && e.target.closest('button') && d.el.contains(e.target)) return;
      e.preventDefault();
      d.close(true);
      return;
    }
    if (e.key === 'Tab') {
      const items = [...d.el.querySelectorAll('input, button')];
      const i = items.indexOf(document.activeElement);
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length;
      e.preventDefault();
      items[next].focus();
    }
  }

  function openDialog({ message, input, okLabel = 'OK', cancelLabel, danger }) {
    return new Promise((resolve) => {
      const prevFocus = document.activeElement;
      const el = document.createElement('div');
      el.className = 'hd-overlay';
      el.innerHTML = `<div class="hd-sheet" role="${cancelLabel ? 'dialog' : 'alertdialog'}" aria-modal="true">
        <div class="hd-msg"></div>
        ${input ? '<input type="text" class="hd-input">' : ''}
        <div class="hd-actions">
          ${cancelLabel ? '<button class="hbtn" data-hd="cancel"></button>' : ''}
          <button class="hbtn ${danger ? 'danger' : 'primary'}" data-hd="ok"></button>
        </div>
      </div>`;
      const msg = el.querySelector('.hd-msg');
      msg.textContent = message == null ? '' : String(message);
      el.querySelector('.hd-sheet').setAttribute('aria-label', msg.textContent.split('\n')[0].slice(0, 120));
      el.querySelector('[data-hd="ok"]').textContent = okLabel;
      if (cancelLabel) el.querySelector('[data-hd="cancel"]').textContent = cancelLabel;
      const field = el.querySelector('.hd-input');
      if (field) {
        field.value = input.value == null ? '' : String(input.value);
        if (input.placeholder) field.placeholder = input.placeholder;
      }
      const d = {
        el,
        close(ok) {
          const i = dialogs.indexOf(d);
          if (i < 0) return;
          dialogs.splice(i, 1);
          if (!dialogs.length) document.removeEventListener('keydown', onDialogKey, true);
          el.remove();
          if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') prevFocus.focus();
          resolve(field ? (ok ? field.value : null) : ok);
        },
      };
      el.addEventListener('click', (e) => {
        if (e.target === el) d.close(false);
        const b = e.target.closest('[data-hd]');
        if (b) d.close(b.dataset.hd === 'ok');
      });
      if (!dialogs.length) document.addEventListener('keydown', onDialogKey, true);
      dialogs.push(d);
      document.body.appendChild(el);
      if (field) { field.focus(); field.select(); } else el.querySelector('[data-hd="ok"]').focus();
    });
  }

  // Resolves when dismissed. Error reports call it without awaiting.
  function showAlert(message) {
    return openDialog({ message }).then(() => undefined);
  }

  // Resolves true on confirm, false on cancel / Esc / backdrop.
  function showConfirm(message, { confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
    return openDialog({ message, okLabel: confirmLabel, cancelLabel, danger });
  }

  // Resolves the entered text (possibly '') on confirm, null on cancel.
  function showPrompt(message, { value = '', placeholder = '', confirmLabel = 'OK', cancelLabel = 'Cancel' } = {}) {
    return openDialog({ message, input: { value, placeholder }, okLabel: confirmLabel, cancelLabel });
  }

  function stopPolls() {
    clearTimeout(ui.pollTimer); ui.pollTimer = null;
    clearTimeout(ui.journalPollTimer); ui.journalPollTimer = null;
  }

  // Views subscribe to the live channel on entry and are torn down here, so a
  // stale view never keeps animating over the top of the next one.
  function dropSubscriptions() {
    while (unsubscribers.length) {
      const off = unsubscribers.pop();
      try { off(); } catch { /* already gone */ }
    }
    if (ui.mapStopReplay) { try { ui.mapStopReplay(); } catch {} ui.mapStopReplay = null; }
    ui.map = null;
  }

  function live(type, fn) {
    if (!window.HorstLive) return;
    unsubscribers.push(window.HorstLive.on(type, fn));
  }

  // --- rail ---

  document.querySelectorAll('.rail-btn').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  // A chat chip's "⧉ Files" link (horst-artifact-chips.js) opens the Files view
  // on that artifact's delivery.
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('[data-art-files]');
    if (!a) return;
    e.preventDefault();
    setView('files', { artifact: a.dataset.artFiles });
  });

  const VIEWS = {
    map: renderMap,
    arch: renderArch,
    chat: renderChat,
    timeline: renderTimeline,
    triggers: renderTriggers,
    todos: renderTodos,
    files: renderFiles,
    brain: renderBrain,
    approvals: renderApprovals,
    directives: renderDirectives,
    settings: renderSettings,
  };

  function setView(view, opts) {
    ui.view = view;
    stopPolls();
    dropSubscriptions();
    clearTimeout(ui.propLiveTimer);
    ui.propSubscribed = false;
    closePropOverlay({ force: true });
    closeWorkshopUI();
    localStorage.setItem('horst-view', view);
    // Triggers has no rail button of its own — it is reached from the map's bus
    // node and from Timeline — so it highlights the Map entry.
    const railFor = view === 'triggers' ? 'map' : view;
    document.querySelectorAll('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === railFor));
    return (VIEWS[view] || renderChat)(opts || {});
  }

  function setPauseBanner(paused) {
    let el = document.getElementById('pauseBanner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pauseBanner';
      el.textContent = '⏸ Automation paused — Horst won\'t act on his own';
      document.body.appendChild(el);
    }
    el.style.display = paused ? '' : 'none';
  }

  async function refreshBadges() {
    try {
      const s = await api('/state');
      const badge = document.getElementById('dirBadge');
      if (badge) {
        badge.style.display = s.directives.pending ? '' : 'none';
        badge.textContent = s.directives.pending || '';
      }
      const appBadge = document.getElementById('appBadge');
      if (appBadge) {
        appBadge.style.display = s.pendingProposals ? '' : 'none';
        appBadge.textContent = s.pendingProposals || '';
      }
      const todoBadge = document.getElementById('todoBadge');
      if (todoBadge) {
        const due = s.todos && s.todos.dueNow;
        todoBadge.style.display = due ? '' : 'none';
        todoBadge.textContent = due || '';
      }
      setPauseBanner(!!s.paused);
      const rail = document.getElementById('railStatus');
      if (rail) rail.textContent = s.dbConnected ? '' : 'DB offline — memory limited';
    } catch { /* not fatal */ }
  }

  // =========================================================================
  // Map — the live picture of Horst's internals
  // =========================================================================

  const POLICY_MEANING = {
    ignore: { label: 'Ignore it', blurb: 'Logged for the record. Nothing else happens.' },
    agenda: { label: 'Just note it', blurb: 'One line on your Timeline. Horst does not act.' },
    notify: { label: 'Ping me', blurb: 'A Telegram message to you. Horst still does not act.' },
    'run-action': { label: 'Run the routine', blurb: 'Runs the specific built-in routine wired to this event — the mail classifier, the briefing, the heartbeat, or a capability refresh.' },
  };

  async function renderMap() {
    main.innerHTML = `<div class="pane map-pane">
      <div class="pane-head">
        <h2>How Horst works</h2>
        <span class="sub">What he senses, how each signal is routed, what he remembers, and what your apps can reach — live</span>
        <span class="spacer"></span>
        <span class="map-jump" id="mapJump"></span>
        <span class="map-zoom">
          <button class="hbtn icon" id="mapZoomOut" title="Zoom out">−</button>
          <button class="hbtn" id="mapZoomFit" title="Fit the height, scroll sideways">Fit</button>
          <button class="hbtn icon" id="mapZoomIn" title="Zoom in">+</button>
        </span>
        <button class="hbtn" id="mapReplay">▶ Replay recent activity</button>
      </div>
      <div class="map-wrap"><div id="mapHost" class="map-host"></div></div>
      <div class="map-legend" id="mapLegend"></div>
    </div>`;

    let summary = null;
    let loadErr = null;
    try { summary = await api('/map'); } catch (err) { loadErr = err; }
    const host = document.getElementById('mapHost');
    if (!host) return;
    if (loadErr) { host.innerHTML = loadErrNote(loadErr); return; }
    ui.mapSummary = summary;

    ui.map = window.HorstMap.render(host, summary, {
      onDrill: (target) => {
        if (target.view === 'timeline') setView('timeline', { filter: target.filter });
        else setView(target.view);
      },
    });

    renderMapLegend(summary);

    // The map is a panorama — start with the whole height visible and let the
    // user scroll (or jump) sideways through the three sections.
    window.HorstMap.fitZoom(ui.map);
    const jump = document.getElementById('mapJump');
    jump.innerHTML = window.HorstMap.SECTIONS
      .map((s) => `<button class="hbtn ghost" data-sec="${s.id}">${escHtml(s.label)}</button>`).join('');
    jump.querySelectorAll('[data-sec]').forEach((b) => {
      b.addEventListener('click', () => window.HorstMap.scrollToSection(ui.map, b.dataset.sec));
    });
    const zoomBy = (f) => window.HorstMap.setZoom(ui.map, ui.map.zoom * f);
    document.getElementById('mapZoomIn').addEventListener('click', () => zoomBy(1.25));
    document.getElementById('mapZoomOut').addEventListener('click', () => zoomBy(0.8));
    document.getElementById('mapZoomFit').addEventListener('click', () => window.HorstMap.fitZoom(ui.map));

    // Live traffic animates the map as it happens.
    live('horst:event', (msg) => {
      if (!ui.map || !msg.entry) return;
      window.HorstMap.flow(ui.map, msg.entry);
    });
    live('horst:proposal', () => { if (ui.map) window.HorstMap.pulse(ui.map, 'approvals'); });
    // Brain traffic animates the Brains section too.
    live('horst:todos', () => { if (ui.map) { window.HorstMap.pulse(ui.map, 'brain:prospective'); window.HorstMap.pulse(ui.map, 'brain:hub'); } });
    live('horst:missions', () => { if (ui.map) { window.HorstMap.pulse(ui.map, 'brain:goal'); window.HorstMap.pulse(ui.map, 'brain:hub'); } });

    document.getElementById('mapReplay').addEventListener('click', async () => {
      const btn = document.getElementById('mapReplay');
      if (ui.mapStopReplay) { ui.mapStopReplay(); ui.mapStopReplay = null; btn.textContent = '▶ Replay recent activity'; return; }
      btn.textContent = '■ Stop';
      let events = [];
      try { events = (await api('/events')).events || []; } catch { /* replay is optional */ }
      ui.mapStopReplay = window.HorstMap.replay(ui.map, events, {
        onDone: () => { ui.mapStopReplay = null; btn.textContent = '▶ Replay recent activity'; },
      });
    });
  }

  function renderMapLegend(s) {
    const el = document.getElementById('mapLegend');
    if (!el) return;
    const cold = Object.entries(s.cold || {}).filter(([, v]) => v).map(([k]) => k);
    const coldNames = { ignore: '“Ignore it”', notify: '“Ping me”' };
    el.innerHTML = `
      <div class="legend-row">
        <span class="legend-chip"><i class="lg-dot"></i>a signal travelling</span>
        <span class="legend-chip"><i class="lg-dot untrusted"></i>untrusted content (mail, third parties)</span>
        <span class="legend-chip"><i class="lg-cold"></i>built, never used</span>
        <span class="legend-chip"><i class="lg-law"></i>directives steer this</span>
        <span class="legend-chip"><i class="lg-ai">✦</i>a model is called here</span>
        <span class="legend-chip"><i class="lg-tok">⌗</i>text is tokenized here</span>
        <span class="legend-chip"><i class="lg-vec">⬡</i>vector search</span>
      </div>
      ${cold.length ? `<div class="legend-note">
        <b>${cold.length} part${cold.length === 1 ? '' : 's'} of Horst ${cold.length === 1 ? 'has' : 'have'} never run:</b>
        ${cold.map((k) => escHtml(coldNames[k] || k)).join(', ')}.
        No event is currently routed to ${cold.length === 1 ? 'it' : 'them'} — bind one in
        <a data-goto="triggers">Triggers</a> and the box comes alive.
      </div>` : ''}
      <div class="legend-note dim">Click any box to see what went through it.</div>`;
    el.querySelectorAll('[data-goto]').forEach((a) => {
      a.addEventListener('click', () => setView(a.dataset.goto));
    });
  }

  // =========================================================================
  // Architecture
  // =========================================================================

  async function renderArch() {
    main.innerHTML = `<div class="pane arch-pane">
      <div class="pane-head">
        <h2>Architecture</h2>
        <span class="sub">What Horst is made of — every module, trigger path, storage file, and integration point</span>
        <span class="spacer"></span>
        <span class="arch-zoom">
          <button class="hbtn icon" id="archZoomOut" title="Zoom out">−</button>
          <button class="hbtn" id="archZoomFit" title="Fit width">Fit</button>
          <button class="hbtn icon" id="archZoomIn" title="Zoom in">+</button>
        </span>
      </div>
      <div class="arch-wrap"><div id="archHost" class="arch-host"></div></div>
      <div class="arch-legend" id="archLegend"></div>
    </div>`;

    const host = document.getElementById('archHost');
    if (!host) return;

    ui.arch = window.HorstArch.render(host);
    window.HorstArch.fitZoom(ui.arch);

    // Zoom controls
    const zoomBy = (f) => window.HorstArch.setZoom(ui.arch, ui.arch.zoom * f);
    document.getElementById('archZoomIn').addEventListener('click', () => zoomBy(1.25));
    document.getElementById('archZoomOut').addEventListener('click', () => zoomBy(0.8));
    document.getElementById('archZoomFit').addEventListener('click', () => window.HorstArch.fitZoom(ui.arch));

    // Legend
    const legend = document.getElementById('archLegend');
    if (legend) {
      legend.innerHTML = [
        ['chat', 'Chat trigger'],
        ['event', 'Event trigger'],
        ['cron', 'Cron trigger'],
        ['governance', 'Governance flow'],
        ['callback', 'Internal callback'],
        ['dep', 'Dependency'],
      ].map(([cls, label]) =>
        `<span class="arch-legend-item"><span class="arch-legend-line ${cls}"></span>${escHtml(label)}</span>`
      ).join('');
    }
  }

  // =========================================================================
  // Chat
  // =========================================================================

  async function renderChat() {
    main.innerHTML = `<div class="chat-layout">
      <div class="thread-list" id="threadList"></div>
      <div class="chat-pane">
        <div class="chat-scroll" id="chatScroll"></div>
        <div class="chat-input">
          <textarea id="chatText" rows="1" placeholder="Talk to Horst — business, ideas, anything… (Enter to send, Shift+Enter for newline)"></textarea>
          <button class="hbtn primary" id="chatSend">Send</button>
        </div>
      </div>
    </div>`;

    const textarea = document.getElementById('chatText');
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 180) + 'px';
    });
    document.getElementById('chatSend').addEventListener('click', sendChat);

    // Another tab (or a Telegram-side wipe) deleting a thread must not leave a
    // dead row here, or the open thread pointing at a gone conversation.
    live('horst:conversationDeleted', (msg) => {
      if (ui.view !== 'chat') return;
      if (msg.conversationId === ui.convId) {
        clearTimeout(ui.pollTimer);
        ui.convId = null; ui.conv = null;
        localStorage.removeItem('horst-conv');
        renderMessages();
      }
      loadThreads();
    });

    await loadThreads();
    if (ui.convId) await openConversation(ui.convId, { silent: true });
    else renderMessages();
  }

  async function loadThreads() {
    try {
      const data = await api('/conversations');
      ui.conversations = data.conversations || [];
    } catch { ui.conversations = []; }
    const list = document.getElementById('threadList');
    if (!list) return;
    list.innerHTML = `<button class="hbtn thread-new" id="threadNew">+ New chat</button>`
      + ui.conversations.map((c) =>
        `<div class="thread-item ${c.id === ui.convId ? 'active' : ''}" data-id="${escHtml(c.id)}" title="${escHtml(c.title)}">
          <span class="thread-title">${escHtml(c.title)}</span>
          <button class="thread-del" data-act="delete" title="Delete this chat" aria-label="Delete chat">🗑</button>
        </div>`
      ).join('');
    document.getElementById('threadNew').addEventListener('click', () => {
      ui.convId = null; ui.conv = null;
      localStorage.removeItem('horst-conv');
      loadThreads(); renderMessages();
    });
    list.querySelectorAll('.thread-item').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-act="delete"]')) return deleteThread(el.dataset.id);
        openConversation(el.dataset.id);
      });
    });
  }

  // Deleting the open thread drops back to the empty state; a Telegram thread
  // just loses its history (the next message from that chat starts it fresh).
  async function deleteThread(id) {
    const conv = ui.conversations.find((c) => c.id === id);
    const isTg = /^tg-?\d+$/.test(id);
    if (!await showConfirm(`Delete "${conv ? conv.title : id}" permanently?\n\n`
      + (isTg ? 'This is your Telegram chat with Horst — its history here is erased and the next Telegram message starts a fresh thread.\n\n' : '')
      + 'This cannot be undone.', { confirmLabel: 'Delete', danger: true })) return;
    try {
      await api('/conversations/' + encodeURIComponent(id), { method: 'DELETE' });
    } catch (err) {
      showAlert('Could not delete chat: ' + err.message);
      return;
    }
    if (ui.convId === id) {
      clearTimeout(ui.pollTimer);
      ui.convId = null; ui.conv = null;
      localStorage.removeItem('horst-conv');
    }
    await loadThreads();
    renderMessages();
  }

  async function openConversation(id, { silent } = {}) {
    try {
      const data = await api('/conversations/' + encodeURIComponent(id));
      ui.conv = data.conversation;
      ui.convId = ui.conv.id;
      localStorage.setItem('horst-conv', ui.conv.id);
      renderMessages();
      loadThreads();
      if (data.busy || ui.conv.messages.some((m) => m.status === 'thinking')) schedulePoll();
    } catch (err) {
      if (!silent) showAlert('Could not open conversation: ' + err.message);
      ui.convId = null; ui.conv = null;
      localStorage.removeItem('horst-conv');
      renderMessages();
    }
  }

  function schedulePoll() {
    clearTimeout(ui.pollTimer);
    ui.pollTimer = setTimeout(async () => {
      if (ui.view !== 'chat' || !ui.convId) return;
      try {
        const data = await api('/conversations/' + encodeURIComponent(ui.convId));
        ui.conv = data.conversation;
        renderMessages();
        if (data.busy || ui.conv.messages.some((m) => m.status === 'thinking')) schedulePoll();
        else refreshBadges();
      } catch { schedulePoll(); }
    }, 1700);
  }

  // vc-artifact:// uris → download chips (public/horst/horst-artifact-chips.js).
  function appendArtifactChips(body, text) {
    const html = window.HorstArtifactChips ? HorstArtifactChips.chipsHtml(text) : '';
    if (html) body.insertAdjacentHTML('beforeend', html);
  }

  function renderMessages() {
    const scroll = document.getElementById('chatScroll');
    if (!scroll) return;
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;

    if (!ui.conv || !ui.conv.messages.length) {
      scroll.innerHTML = `<div class="empty-note">
        <div><span class="horst-glyph">H</span></div>
        <b>I'm Horst — your resident agent.</b><br>
        Brainstorm your business, ask about your mail and calendar, or tell me<br>
        how you want me to behave — say "from now on…" and it becomes a directive.
      </div>`;
      return;
    }

    scroll.innerHTML = '';
    for (const m of ui.conv.messages) {
      if (m.role === 'user') {
        const el = document.createElement('div');
        el.className = 'msg msg-user';
        el.innerHTML = `<div class="msg-body"></div>`;
        el.querySelector('.msg-body').textContent = m.text;
        appendArtifactChips(el.querySelector('.msg-body'), m.text);
        scroll.appendChild(el);
      } else {
        const el = document.createElement('div');
        el.className = 'msg msg-horst' + (m.status === 'error' ? ' msg-error' : m.status === 'thinking' ? ' msg-thinking' : '');
        el.innerHTML = `<div class="msg-avatar">H</div><div class="msg-body"></div>`;
        const body = el.querySelector('.msg-body');
        if (m.status === 'thinking') {
          body.textContent = 'Horst is thinking';
        } else if (m.status === 'error') {
          body.textContent = m.text || 'Something went wrong.';
        } else if (window.customElements && customElements.get('vc-markdown')) {
          const md = document.createElement('vc-markdown');
          md.doc = m.text || '';
          body.appendChild(md);
        } else {
          body.textContent = m.text || '';
        }
        if (m.status !== 'thinking' && m.status !== 'error') appendArtifactChips(body, m.text);
        scroll.appendChild(el);
        if (m.proposalIds && m.proposalIds.length) {
          const note = document.createElement('div');
          note.className = 'prop-note';
          note.innerHTML = `Staged ${m.proposalIds.length} action${m.proposalIds.length > 1 ? 's' : ''} — <a>review in Approvals</a>`;
          note.querySelector('a').addEventListener('click', () => setView('approvals'));
          scroll.appendChild(note);
        }
        if (m.todos && m.todos.length) {
          for (const t of m.todos) {
            const note = document.createElement('div');
            note.className = 'prop-note todo-note';
            note.dataset.todoId = t.id;
            note.innerHTML = `☑ Added todo: <b>${escHtml(t.title)}</b>`
              + (t.dueAt ? ` <span class="todo-due">(due ${escHtml(fmtTime(new Date(t.dueAt).getTime()))})</span>` : '')
              + (t.watch ? ' <span class="todo-due">⏳ waiting-for</span>' : '')
              + ` — <a data-act="undo">Undo</a>`;
            note.querySelector('a').addEventListener('click', async () => {
              try {
                await api(`/todos/${t.id}`, { method: 'DELETE' });
                note.innerHTML = `↩ Todo removed: ${escHtml(t.title)}`;
              } catch (err) { note.innerHTML += ` <span class="todo-due">(${escHtml(err.message)})</span>`; }
            });
            scroll.appendChild(note);
          }
        }
        if (m.missions && m.missions.length) {
          for (const mi of m.missions) {
            const note = document.createElement('div');
            note.className = 'prop-note mission-note';
            note.innerHTML = `🎯 Mission staged: <b>${escHtml(mi.title)}</b> — <a data-act="active">Confirm</a> · <a data-act="abandoned">Dismiss</a>`;
            note.querySelectorAll('a').forEach((a) => a.addEventListener('click', async () => {
              try {
                await api(`/missions/${mi.id}/status`, { method: 'POST', body: JSON.stringify({ status: a.dataset.act }) });
                note.innerHTML = a.dataset.act === 'active' ? `🎯 Mission active: ${escHtml(mi.title)}` : `Mission dismissed: ${escHtml(mi.title)}`;
              } catch (err) { note.innerHTML += ` (${escHtml(err.message)})`; }
            }));
            scroll.appendChild(note);
          }
        }
        if (m.directiveIds && m.directiveIds.length && !ui.seenDirectiveBanners.has(m.id)) {
          appendDirectiveBanner(scroll, m);
        }
      }
    }
    if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
  }

  async function appendDirectiveBanner(scroll, message) {
    let directives = [];
    try {
      const data = await api('/directives');
      directives = (data.directives || []).filter((d) => message.directiveIds.includes(d.id) && d.status === 'pending');
    } catch { return; }
    if (!directives.length) return;
    const banner = document.createElement('div');
    banner.className = 'directive-banner';
    banner.innerHTML = `<div><b>New directive${directives.length > 1 ? 's' : ''} to confirm</b></div>`
      + directives.map((d) => `<div class="db-row" data-id="${d.id}">
          <span class="db-text">#${d.id}: ${escHtml(d.text)}</span>
          <button class="hbtn primary" data-act="active">Confirm</button>
          <button class="hbtn" data-act="inactive">Dismiss</button>
        </div>`).join('');
    banner.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const row = btn.closest('.db-row');
      try {
        await api(`/directives/${row.dataset.id}/status`, { method: 'POST', body: JSON.stringify({ status: btn.dataset.act }) });
        row.remove();
        if (!banner.querySelector('.db-row')) { banner.remove(); ui.seenDirectiveBanners.add(message.id); }
        refreshBadges();
      } catch (err) { showAlert(err.message); }
    });
    scroll.appendChild(banner);
    scroll.scrollTop = scroll.scrollHeight;
  }

  async function sendChat() {
    const textarea = document.getElementById('chatText');
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = '';
    textarea.style.height = 'auto';
    try {
      const data = await api('/chat', { method: 'POST', body: JSON.stringify({ conversationId: ui.convId, text }) });
      ui.convId = data.conversationId;
      localStorage.setItem('horst-conv', ui.convId);
      await openConversation(ui.convId, { silent: true });
    } catch (err) {
      showAlert('Send failed: ' + err.message);
      textarea.value = text;
    }
  }

  // =========================================================================
  // Directives — your standing orders, and the workshop that writes them
  // =========================================================================
  //
  // A directive is injected VERBATIM into every prompt Horst runs, forever.
  // The old UI made that as cheap as typing a search query, which is why the
  // store held exactly one directive and it said "asd". Authoring now goes
  // through Horst: he restates it precisely, asks what he genuinely needs to
  // know, names the edge cases, weighs it up, checks it against the directives
  // already in force, and refuses outright if it would break his genome.

  const SCOPE_LABEL = {
    chat: 'Chat',
    triage: 'Email triage',
    briefing: 'Briefings',
    planner: 'Planning',
    executor: 'Doing the work',
  };

  // =========================================================================
  // Brain — browse what Horst knows (memory · artifacts · decisions)
  // =========================================================================
  // The browse half of the push/pull architecture: the map shows the shape,
  // this view lets you look INSIDE each store. Todos and missions have their
  // own surfaces (Todos view, Directives view) — this covers the three stores
  // that had none.

  const BRAIN_TABS = { memory: 'Memory', artifacts: 'Artifacts', decisions: 'Decisions' };

  async function renderBrain(opts) {
    const tab = (opts && opts.filter && opts.filter.tab) || ui.brainTab || 'memory';
    ui.brainTab = tab;
    main.innerHTML = `<div class="pane">
      <div class="pane-head"><h2>Brain</h2><span class="sub">Browse what Horst knows — facts, filed documents, decision history</span></div>
      <div class="tl-filters">
        ${Object.entries(BRAIN_TABS).map(([k, label]) => `<button class="chip ${tab === k ? 'on' : ''}" data-tab="${k}">${label}</button>`).join('')}
      </div>
      <div class="pane-scroll" id="brainBody"></div>
    </div>`;
    main.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
      ui.brainTab = b.dataset.tab;
      renderBrain();
    }));
    const body = document.getElementById('brainBody');
    if (tab === 'memory') renderBrainMemory(body);
    else if (tab === 'artifacts') renderBrainArtifacts(body);
    else renderBrainDecisions(body);
  }

  function factLine(r) {
    const content = r.content || [r.subject, r.predicate, r.value].filter(Boolean).join(' · ');
    const chips = [];
    if (r.app_origin && r.app_origin !== 'horst') chips.push(`from ${r.app_origin}`);
    if (r.tier) chips.push(r.tier);
    if (r.importance != null) chips.push(`imp ${Number(r.importance).toFixed(2)}`);
    if (r.hit_count) chips.push(`reinforced ${r.hit_count}×`);
    const src = (r.sources || [])[0];
    if (src?.source_ref?.artifactId) chips.push(`<a href="/pro/horst/api/artifacts/${src.source_ref.artifactId}/file" target="_blank">📎 document</a>`);
    else if (src?.source_ref?.type) chips.push(escHtml(src.source_ref.type));
    // Consolidated facts (numeric id) can unfold their full provenance chain.
    const expandable = typeof r.id === 'number' || /^\d+$/.test(String(r.id || ''));
    if (expandable) chips.push(`<a data-fid="${escHtml(String(r.id))}">⛓ provenance</a>`);
    return `<div class="brain-fact"><div>${escHtml(content)}</div><div class="brain-chips">${chips.map((c) => `<span class="todo-badge">${c}</span>`).join(' ')}</div><div class="brain-prov" style="display:none"></div></div>`;
  }

  // Unfold "where did you get that": every consolidator decision about this
  // fact — insert, reinforce, supersede, merge — with app, confidence, source.
  function wireProvenance(scope) {
    scope.querySelectorAll('[data-fid]').forEach((a) => a.addEventListener('click', async () => {
      const box = a.closest('.brain-fact').querySelector('.brain-prov');
      if (box.style.display !== 'none') { box.style.display = 'none'; return; }
      box.style.display = '';
      box.innerHTML = '<span class="set-hint">Loading provenance…</span>';
      try {
        const r = await api(`/memory/history/${a.dataset.fid}`);
        const rows = r.sources || [];
        box.innerHTML = rows.length
          ? rows.map((sr) => {
              const ref = sr.source_ref || {};
              const what = ref.artifactId ? `<a href="/pro/horst/api/artifacts/${ref.artifactId}/file" target="_blank">artifact #${ref.artifactId}</a>`
                : ref.type === 'email' ? `email ${escHtml(ref.account || '')}/${escHtml(String(ref.uid || ''))}`
                : escHtml(ref.type || 'unknown');
              return `<div class="brain-prov-row"><span class="todo-badge">${escHtml(sr.action || '?')}</span> via ${escHtml(sr.app_origin || '?')} · ${what}${sr.confidence != null ? ` · conf ${Number(sr.confidence).toFixed(2)}` : ''}${sr.recorded_at ? ` · ${escHtml(String(sr.recorded_at).slice(0, 10))}` : ''}</div>`;
            }).join('')
          : '<span class="set-hint">No provenance recorded (pre-ledger fact).</span>';
      } catch (err) { box.innerHTML = `<span class="set-hint">${escHtml(err.message)}</span>`; }
    }));
  }

  function renderBrainMemory(body) {
    body.innerHTML = `
      <div class="todo-compose">
        <input id="brainQ" type="text" placeholder="Search Horst's memory — any language" />
        <input id="brainSubj" type="text" placeholder="entity filter (optional)" style="max-width:180px" />
        <button class="hbtn primary" id="brainGo">Search</button>
      </div>
      <div id="brainEntities"></div>
      <div id="brainResults"><div class="set-hint">The same recall Horst uses: hybrid semantic + fulltext, provenance included. Facts are canonical English; queries work in German too. Click an entity to browse by association.</div></div>`;
    const go = async () => {
      const q = document.getElementById('brainQ').value.trim();
      const subj = document.getElementById('brainSubj').value.trim();
      if (!q && !subj) return;
      const out = document.getElementById('brainResults');
      out.innerHTML = '<div class="set-hint">Searching…</div>';
      try {
        const r = await api(`/memory/search?q=${encodeURIComponent(q || subj)}&subject=${encodeURIComponent(subj)}`);
        const hits = r.hits || [];
        const recent = r.recent || [];
        out.innerHTML = (hits.length || recent.length)
          ? hits.map(factLine).join('')
            + (recent.length ? `<h3 class="brain-h">Fresh (not yet consolidated)</h3>` + recent.map(factLine).join('') : '')
          : '<div class="empty-note">Nothing in memory for that.</div>';
        wireProvenance(out);
      } catch (err) { out.innerHTML = ''; out.appendChild(loadErrNote(err)); }
    };
    document.getElementById('brainGo').addEventListener('click', go);
    document.getElementById('brainQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    document.getElementById('brainSubj').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    // The association index: top entities by importance — entity-first
    // browsing is how the brain scales, so it is also how you browse it.
    api('/memory/entities?limit=24').then((r) => {
      const ents = r.entities || [];
      const box = document.getElementById('brainEntities');
      if (!box || !ents.length) return;
      box.innerHTML = `<div class="tl-filters brain-ents">` + ents.map((e) =>
        `<button class="chip" data-ent="${escHtml(e.name)}" title="${escHtml(e.type || '')} · importance ${Number(e.importance).toFixed(2)}">${escHtml(e.name)}</button>`).join('') + '</div>';
      box.querySelectorAll('[data-ent]').forEach((b) => b.addEventListener('click', () => {
        document.getElementById('brainSubj').value = b.dataset.ent;
        document.getElementById('brainQ').value = document.getElementById('brainQ').value || b.dataset.ent;
        go();
      }));
    }).catch(() => {});
  }

  // Doc-type glyphs for the gallery — the seeded vocabulary plus a fallback
  // for user-added types (Settings › Configurations › Document types).
  const DOC_ICON = {
    receipt: '🧾', bill: '💶', contract: '📜', warranty: '🛡', ticket: '🎫',
    tax: '🏛', medical: '🩺', id: '🪪', other: '📄',
  };

  async function renderBrainArtifacts(body) {
    body.innerHTML = '<div class="set-hint">Loading…</div>';
    // q searches server-side (title/vendor/description fulltext); the type
    // chips then filter the returned set client-side, with live counts.
    const state = { q: '', type: null };
    let rows = [];
    const fetchRows = async () => {
      rows = (await api(`/artifacts?limit=100${state.q ? `&q=${encodeURIComponent(state.q)}` : ''}`)).artifacts || [];
    };
    try { await fetchRows(); } catch (err) { body.innerHTML = ''; body.appendChild(loadErrNote(err)); return; }

    body.innerHTML = `
      <div class="todo-compose">
        <input id="artQ" type="text" placeholder="Search filed documents — title, vendor, contents" />
        <button class="hbtn primary" id="artGo">Search</button>
      </div>
      <div id="artFilters"></div>
      <div id="artList"></div>`;

    const artRow = (a) => `<div class="todo-row art-row">
        <span class="art-icon" title="${escHtml(a.doc_type)}">${DOC_ICON[a.doc_type] || DOC_ICON.other}</span>
        <div class="todo-main">
          <span class="todo-title">${escHtml(a.title || a.vendor || '(untitled)')}</span>
          <span class="todo-badges">
            <span class="todo-badge">${escHtml(a.doc_type)}</span>
            ${a.vendor && a.vendor !== a.title ? `<span class="todo-badge">${escHtml(a.vendor)}</span>` : ''}
            ${a.amount != null ? `<span class="todo-badge">${escHtml(Number(a.amount).toFixed(2))} ${escHtml(a.currency || '')}</span>` : ''}
            ${a.doc_date ? `<span class="todo-badge dim">${escHtml(String(a.doc_date).slice(0, 10))}</span>` : ''}
            ${a.due_date ? `<span class="todo-badge over">due ${escHtml(String(a.due_date).slice(0, 10))}</span>` : ''}
            ${a.reference_no ? `<span class="todo-badge dim">ref ${escHtml(String(a.reference_no).slice(0, 24))}</span>` : ''}
          </span>
        </div>
        <div class="todo-actions">
          <button class="hbtn" data-detail="${a.id}" title="Extracted fields">▸ detail</button>
          <a class="hbtn" href="/pro/horst/api/artifacts/${a.id}/file" target="_blank" title="Open the original">📎 open</a>
        </div>
      </div>
      <div class="brain-prov art-detail" data-for="${a.id}" style="display:none"></div>`;

    const draw = () => {
      const filters = document.getElementById('artFilters');
      const list = document.getElementById('artList');
      const counts = {};
      for (const r of rows) counts[r.doc_type] = (counts[r.doc_type] || 0) + 1;
      const types = Object.keys(counts).sort();
      if (state.type && !counts[state.type]) state.type = null; // a search may empty the active filter
      filters.innerHTML = rows.length
        ? `<div class="tl-filters">
            <button class="chip ${state.type == null ? 'on' : ''}" data-t="">all <span class="art-count">${rows.length}</span></button>
            ${types.map((t) => `<button class="chip ${state.type === t ? 'on' : ''}" data-t="${escHtml(t)}">${DOC_ICON[t] || DOC_ICON.other} ${escHtml(t)} <span class="art-count">${counts[t]}</span></button>`).join('')}
          </div>`
        : '';
      const vis = state.type ? rows.filter((r) => r.doc_type === state.type) : rows;
      list.innerHTML = vis.length
        ? vis.map(artRow).join('')
        : state.q
          ? `<div class="empty-note">No filed documents match “${escHtml(state.q)}”.</div>`
          : '<div class="empty-note"><div class="horst-glyph">H</div>Nothing filed yet.<br>Send Horst a photo of a receipt or bill on Telegram — he classifies it, extracts the fields, and files it here.</div>';

      filters.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => {
        state.type = b.dataset.t || null;
        draw();
      }));
      list.querySelectorAll('[data-detail]').forEach((b) => b.addEventListener('click', async () => {
        const box = list.querySelector(`.art-detail[data-for="${b.dataset.detail}"]`);
        if (!box) return;
        if (box.style.display !== 'none') { box.style.display = 'none'; b.textContent = '▸ detail'; return; }
        box.style.display = '';
        b.textContent = '▾ detail';
        box.innerHTML = '<span class="set-hint">Loading…</span>';
        try {
          const { artifact } = await api(`/artifacts/${b.dataset.detail}`);
          const f = artifact.extracted || {};
          const fieldRows = Object.entries(f).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length));
          box.innerHTML = (fieldRows.length
            ? fieldRows.map(([k, v]) => `<div class="brain-prov-row"><b>${escHtml(k)}</b>: ${escHtml(typeof v === 'object' ? JSON.stringify(v) : String(v))}</div>`).join('')
            : '<span class="set-hint">No structured fields extracted.</span>')
            + (artifact.description ? `<div class="brain-prov-row art-desc">${escHtml(artifact.description.slice(0, 1500))}</div>` : '')
            + `<div class="brain-prov-row"><span class="todo-badge">stored via ${escHtml(artifact.file_ref?.type || '?')}</span> <span class="todo-badge">${escHtml(String(artifact.created_at).slice(0, 10))}</span></div>`;
        } catch (err) { box.innerHTML = `<span class="set-hint">${escHtml(err.message)}</span>`; }
      }));
    };

    const search = async () => {
      state.q = document.getElementById('artQ').value.trim();
      try { await fetchRows(); } catch (err) { document.getElementById('artList').innerHTML = `<div class="set-hint">${escHtml(err.message)}</div>`; return; }
      draw();
    };
    document.getElementById('artGo').addEventListener('click', search);
    document.getElementById('artQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
    draw();
  }

  async function renderBrainDecisions(body) {
    body.innerHTML = '<div class="set-hint">Loading…</div>';
    let stats = {};
    let list = [];
    try {
      [stats, list] = await Promise.all([
        api('/decisions/stats').then((r) => r.stats || {}),
        api('/decisions?limit=50').then((r) => r.decisions || []),
      ]);
    } catch (err) { body.innerHTML = ''; body.appendChild(loadErrNote(err)); return; }
    const kinds = Object.entries(stats);
    body.innerHTML = (kinds.length
      ? `<h3 class="brain-h">Per kind</h3>` + kinds.map(([kind, st]) => {
          const humans = (st.approved || 0) + (st.denied || 0) + (st.expired || 0);
          return `<div class="brain-fact"><div><b>${escHtml(kind)}</b> — ${humans} decided · ${st.approved} approved${st.approvalRate != null ? ` (${Math.round(st.approvalRate * 100)}%)` : ''}${st.denied ? ` · ${st.denied} denied` : ''}${st.edited ? ` · ${st.edited} edited first` : ''}${st.auto ? ` · ${st.auto} auto` : ''}</div></div>`;
        }).join('')
      : '<div class="empty-note">No decisions recorded yet — approve or deny a proposal and it lands here.</div>')
      + (list.length ? `<h3 class="brain-h">Recent decisions</h3>` + list.map((d) => `
        <div class="brain-fact">
          <div>${d.decision === 'approve' ? '✅' : d.decision === 'deny' ? '🚫' : d.decision === 'expire' ? '⌛' : '⚙'} <b>${escHtml(d.kind)}</b> — ${escHtml(d.summary || '')}</div>
          <div class="brain-chips">
            <span class="todo-badge">${escHtml(d.decision)}</span>
            <span class="todo-badge">via ${escHtml(d.via || '?')}</span>
            ${d.edited ? `<span class="todo-badge">edited: ${escHtml((d.editedFields || []).join(', '))}</span>` : ''}
            <span class="todo-badge">${escHtml(fmtTime(d.at))}</span>
          </div>
        </div>`).join('') : '');
  }

  // =========================================================================
  // Todos — the platform tasks-engine surface (reminders + waiting-fors)
  // =========================================================================

  async function renderTodos() {
    main.innerHTML = `<div class="pane">
      <div class="pane-head"><h2>Todos</h2><span class="sub">Reminders, recurring tasks and waiting-fors — Horst nudges when they're due</span></div>
      <div class="pane-scroll">
        <div class="todo-compose">
          <input id="todoNew" type="text" placeholder="Add a todo — e.g. “Call Anna”" />
          <input id="todoDue" type="datetime-local" title="Due (optional)" />
          <select id="todoRecur" title="Repeat (optional)">
            <option value="">no repeat</option>
            <option value="day">daily</option>
            <option value="week">weekly</option>
            <option value="month">monthly</option>
            <option value="year">yearly</option>
          </select>
          <input id="todoByday" type="text" placeholder="weekdays e.g. mon,wed,fri" title="Weekly only: weekdays (RRULE codes or day names)" style="display:none;width:170px;" />
          <button class="hbtn primary" id="todoAdd">Add</button>
        </div>
        <div id="todoHint"></div>
        <div id="todoList"><div class="empty-note">Loading…</div></div>
        <div id="todoDone"></div>
      </div>
    </div>`;

    document.getElementById('todoAdd').addEventListener('click', addTodoFromBar);
    document.getElementById('todoNew').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTodoFromBar(); });
    document.getElementById('todoRecur').addEventListener('change', (e) => {
      document.getElementById('todoByday').style.display = e.target.value === 'week' ? '' : 'none';
    });
    await loadTodos();
    live('horst:todos', () => { if (ui.view === 'todos') loadTodos(); });
  }

  async function addTodoFromBar() {
    const title = document.getElementById('todoNew').value.trim();
    if (!title) return;
    const body = { title };
    const due = document.getElementById('todoDue').value;
    if (due) body.dueAt = due;
    const recur = document.getElementById('todoRecur').value;
    if (recur) {
      body.recurrence = { every: recur, n: 1 };
      const byday = document.getElementById('todoByday').value.trim();
      if (recur === 'week' && byday) body.recurrence.byday = byday;
    }
    const hint = document.getElementById('todoHint');
    try {
      const r = await api('/todos', { method: 'POST', body: JSON.stringify(body) });
      document.getElementById('todoNew').value = '';
      document.getElementById('todoDue').value = '';
      document.getElementById('todoRecur').value = '';
      document.getElementById('todoByday').value = '';
      document.getElementById('todoByday').style.display = 'none';
      if (hint) {
        hint.innerHTML = (r.similar && r.similar.length)
          ? `<div class="todo-hint">Similar open todo${r.similar.length > 1 ? 's' : ''}: ${r.similar.map((x) => escHtml(x.title)).join(' · ')}</div>`
          : '';
      }
      await loadTodos();
    } catch (err) {
      if (hint) hint.innerHTML = `<div class="todo-hint err">${escHtml(err.message)}</div>`;
    }
  }

  function todoGroupOf(t, now, endOfToday) {
    if (t.watch) return 'Waiting-for';
    const eff = t.snoozedUntil || t.dueAt;
    if (!eff) return 'Someday';
    const d = new Date(eff);
    if (d <= now) return 'Overdue';
    if (d <= endOfToday) return 'Today';
    return 'Upcoming';
  }

  function todoRowHtml(t, now) {
    const eff = t.snoozedUntil || t.dueAt;
    const badges = [];
    if (eff) badges.push(`<span class="todo-badge ${new Date(eff) <= now ? 'over' : ''}">${escHtml(fmtTime(new Date(eff).getTime()))}${t.snoozedUntil ? ' 💤' : ''}</span>`);
    if (t.recurrence) badges.push(`<span class="todo-badge">↻ every ${t.recurrence.n > 1 ? t.recurrence.n + ' ' : ''}${escHtml(t.recurrence.every)}${t.recurrence.n > 1 ? 's' : ''}${Array.isArray(t.recurrence.byday) && t.recurrence.byday.length ? ' (' + escHtml(t.recurrence.byday.join(',')) + ')' : ''}</span>`);
    if (t.watch) badges.push(`<span class="todo-badge">⏳ waiting on reply${t.watch.subject ? `: ${escHtml(String(t.watch.subject).slice(0, 40))}` : ''}</span>`);
    if (t.appOrigin && t.appOrigin !== 'horst') badges.push(`<span class="todo-badge">from ${escHtml(t.appOrigin)}</span>`);
    return `<div class="todo-row" data-id="${t.id}">
      <div class="todo-main">
        <span class="todo-title">${escHtml(t.title)}</span>
        <span class="todo-badges">${badges.join(' ')}</span>
      </div>
      <div class="todo-actions">
        <button class="hbtn" data-act="done" title="Mark done">✓</button>
        <button class="hbtn" data-act="snooze" title="Snooze 1 day">💤</button>
        <button class="hbtn" data-act="edit" title="Edit title">✎</button>
        <button class="hbtn" data-act="delete" title="Delete">🗑</button>
      </div>
    </div>`;
  }

  async function loadTodos() {
    const list = document.getElementById('todoList');
    const doneBox = document.getElementById('todoDone');
    if (!list) return;
    let open = [];
    let done = [];
    try {
      [open, done] = await Promise.all([
        api('/todos?status=open&limit=200').then((r) => r.todos || []),
        api('/todos?status=done&limit=15').then((r) => r.todos || []).catch(() => []),
      ]);
    } catch (err) {
      list.innerHTML = '';
      list.appendChild(loadErrNote(err));
      if (doneBox) doneBox.innerHTML = '';
      return;
    }
    const now = new Date();
    const endOfToday = new Date(now); endOfToday.setHours(23, 59, 59, 999);
    const groups = { 'Overdue': [], 'Today': [], 'Waiting-for': [], 'Upcoming': [], 'Someday': [] };
    for (const t of open) groups[todoGroupOf(t, now, endOfToday)].push(t);
    let html = '';
    for (const [name, items] of Object.entries(groups)) {
      if (!items.length) continue;
      html += `<div class="todo-group"><h3>${name} <span class="todo-count">${items.length}</span></h3>`
        + items.map((t) => todoRowHtml(t, now)).join('') + '</div>';
    }
    list.innerHTML = html || '<div class="empty-note">No open todos. Add one above, or tell Horst “remind me …” in chat.</div>';

    list.querySelectorAll('.todo-row [data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('.todo-row').dataset.id;
        const act = btn.dataset.act;
        try {
          if (act === 'done') await api(`/todos/${id}/done`, { method: 'POST', body: '{}' });
          else if (act === 'snooze') await api(`/todos/${id}/snooze`, { method: 'POST', body: JSON.stringify({ preset: '1d' }) });
          else if (act === 'delete') { if (!await showConfirm('Delete this todo?', { confirmLabel: 'Delete', danger: true })) return; await api(`/todos/${id}`, { method: 'DELETE' }); }
          else if (act === 'edit') {
            const t = open.find((x) => String(x.id) === String(id));
            const title = await showPrompt('Edit todo title:', { value: t ? t.title : '', confirmLabel: 'Save' });
            if (title == null || !title.trim()) return;
            await api(`/todos/${id}`, { method: 'POST', body: JSON.stringify({ title: title.trim() }) });
          }
          await loadTodos();
          refreshBadges();
        } catch (err) { showAlert(err.message); }
      });
    });

    if (doneBox) {
      doneBox.innerHTML = done.length
        ? `<details class="todo-done"><summary>Done recently (${done.length})</summary>`
          + done.map((t) => `<div class="todo-row done" data-id="${t.id}">
              <div class="todo-main"><span class="todo-title">${escHtml(t.title)}</span>
              <span class="todo-badges"><span class="todo-badge">${escHtml(t.resolution || 'done')}</span></span></div>
              <div class="todo-actions"><button class="hbtn" data-act="reopen">↩ Reopen</button></div>
            </div>`).join('') + '</details>'
        : '';
      doneBox.querySelectorAll('[data-act="reopen"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.closest('.todo-row').dataset.id;
          try { await api(`/todos/${id}/reopen`, { method: 'POST', body: '{}' }); await loadTodos(); } catch (err) { showAlert(err.message); }
        });
      });
    }
  }

  // =========================================================================
  // Files — everything Horst delivered to you (job outcomes, chat-turn files)
  // =========================================================================
  // Loaded on entry and after a remove only — never on a timer — so a playing
  // <audio>/<video> is never re-rendered under the owner.

  const FILE_KINDS = { '': 'All', picture: 'Pictures', audio: 'Audio', video: 'Video', model: '3D models', document: 'Documents' };
  const FILE_ICON = { picture: '🖼', audio: '🎵', video: '🎬', model: '🧊', document: '📄' };

  function fileSrc(r) { return r.src || '/pro/artifacts/' + encodeURIComponent(r.artifactId || ''); }

  // opts.artifact: open that artifact's delivery (a chip's "Files" link).
  async function renderFiles(opts) {
    const st = ui.files;
    st.note = '';
    main.innerHTML = `<div class="pane">
      <div class="pane-head"><h2>Files</h2><span class="sub">Everything Horst delivered to you — job outcomes and chat files</span></div>
      <div id="fileFilters"></div>
      <div class="pane-scroll"><div id="fileNote"></div><div id="fileList"><div class="empty-note">Loading…</div></div></div>
    </div>`;
    let hit = null;
    if (opts && opts.artifact) {
      st.kind = '';
      st.open = null;
      try { hit = ((await api('/files?artifact=' + encodeURIComponent(opts.artifact))).files || [])[0] || null; } catch { hit = null; }
      if (hit) st.open = hit.id;
      else st.note = 'This file was not delivered to Files — showing everything Horst delivered.';
    }
    await loadFiles(hit);
  }

  // extra: a record that must be in the list (the deep-linked delivery).
  async function loadFiles(extra) {
    const st = ui.files;
    let r;
    try {
      r = await api('/files' + (st.kind ? '?kind=' + encodeURIComponent(st.kind) : ''));
    } catch (err) {
      const list = document.getElementById('fileList');
      if (ui.view === 'files' && list) list.innerHTML = loadErrNote(err);
      return;
    }
    if (ui.view !== 'files' || !document.getElementById('fileList')) return;
    st.rows = r.files || [];
    st.counts = r.counts || {};
    if (extra && !st.rows.some((x) => x.id === extra.id)) st.rows.unshift(extra);
    st.all = st.kind ? null : st.rows;
    if (st.open && !st.rows.some((x) => x.id === st.open)) st.open = null;
    drawFiles();
  }

  function fileFiltersHtml() {
    const st = ui.files;
    const c = st.counts || {};
    const total = Object.keys(FILE_KINDS).filter(Boolean).reduce((n, k) => n + (Number(c[k]) || 0), 0);
    return `<div class="tl-filters">${Object.entries(FILE_KINDS).map(([k, label]) =>
      `<button class="chip ${st.kind === k ? 'on' : ''}" data-fkind="${k}">${k ? FILE_ICON[k] + ' ' : ''}${label} <span class="art-count">${k ? (Number(c[k]) || 0) : total}</span></button>`).join('')}</div>`;
  }

  function drawFileFilters(filters) {
    const st = ui.files;
    filters.innerHTML = fileFiltersHtml();
    filters.querySelectorAll('[data-fkind]').forEach((b) => b.addEventListener('click', () => {
      st.kind = b.dataset.fkind;
      st.open = null;
      st.note = '';
      loadFiles();
    }));
  }

  function fileRowHtml(r) {
    const title = r.title || r.name || r.id;
    const pic = r.kind === 'picture' && !r.missing;
    const where = [r.app, r.tool].filter(Boolean).join(' › ');
    return `<div class="todo-row file-row${r.missing ? ' missing' : ''}${ui.files.open === r.id ? ' open' : ''}" data-id="${escHtml(r.id)}">
      <div class="file-thumb">${pic
        ? `<img src="${escHtml(fileSrc(r))}" alt="" loading="lazy">`
        : `<span class="art-icon">${FILE_ICON[r.kind] || FILE_ICON.document}</span>`}</div>
      <div class="todo-main">
        <span class="todo-title">${escHtml(title)}</span>
        <span class="todo-badges">
          ${r.name && r.name !== title ? `<span class="todo-badge">${escHtml(r.name)}</span>` : ''}
          ${where ? `<span class="todo-badge dim">${escHtml(where)}</span>` : ''}
          ${r.at ? `<span class="todo-badge dim">${escHtml(fmtTime(r.at))}</span>` : ''}
          ${fmtSize(Number(r.size)) ? `<span class="todo-badge dim">${escHtml(fmtSize(Number(r.size)))}</span>` : ''}
          ${r.missing ? '<span class="todo-badge over">no longer available</span>' : ''}
        </span>
      </div>
      <div class="todo-actions">
        ${r.missing ? '' : `<a class="hbtn file-dl" href="${escHtml(fileSrc(r))}?download=1" download="${escHtml(r.name || r.id)}" title="Download ${escHtml(r.name || '')}">⬇</a>`}
        <button class="hbtn" data-act="remove" title="Remove from Files">🗑</button>
      </div>
    </div>`;
  }

  function fileDetailHtml(r) {
    const src = escHtml(fileSrc(r));
    const name = escHtml(r.name || r.id);
    if (r.missing) return '<span class="set-hint">This file is no longer available.</span>';
    let body = '';
    if (r.kind === 'picture') body = `<a href="${src}" target="_blank" rel="noopener" title="Open full size"><img class="file-full" src="${src}" alt="${name}"></a>`;
    else if (r.kind === 'audio') body = `<audio class="file-media" controls preload="metadata" src="${src}"></audio>`;
    else if (r.kind === 'video') body = `<video class="file-full file-media" controls preload="metadata" src="${src}"></video>`;
    else if (r.kind === 'model') body = '<div class="file-previews"><span class="set-hint">Loading previews…</span></div>';
    const meta = [r.mime, r.source === 'job' ? `job${r.jobId ? ' ' + r.jobId : ''}` : r.source === 'chat' ? 'chat reply' : ''].filter(Boolean).join(' · ');
    return body + `<div class="file-meta">
        <a class="art-dl" href="${src}?download=1" download="${name}">⬇ Download ${name}</a>
        ${meta ? `<span class="art-meta">${escHtml(meta)}</span>` : ''}
      </div>`;
  }

  // A 3D model shows the pictures delivered with it (rec.previews → dl ids of
  // the same batch); ids outside the current filter come from the unfiltered list.
  async function fillFilePreviews(box, r) {
    const st = ui.files;
    const ids = (r.previews || []).filter((id) => id !== r.id);
    const pick = (pool) => ids.map((id) => pool.find((x) => x.id === id)).filter(Boolean);
    let recs = pick(st.rows);
    if (recs.length < ids.length) {
      if (!st.all) { try { st.all = (await api('/files')).files || []; } catch { st.all = null; } }
      recs = pick(st.rows.concat(st.all || []));
    }
    if (!box.isConnected) return;
    recs = recs.filter((p) => !p.missing);
    box.innerHTML = recs.length
      ? recs.map((p) => `<a href="${escHtml(fileSrc(p))}" target="_blank" rel="noopener" title="${escHtml(p.name || '')}"><img src="${escHtml(fileSrc(p))}" alt="${escHtml(p.name || '')}" loading="lazy"></a>`).join('')
      : '<span class="set-hint">No preview pictures came with this model.</span>';
  }

  function openFileDetail(list, r) {
    const row = list.querySelector(`.file-row[data-id="${CSS.escape(r.id)}"]`);
    if (!row) return;
    row.classList.add('open');
    row.insertAdjacentHTML('afterend', `<div class="file-detail" data-for="${escHtml(r.id)}">${fileDetailHtml(r)}</div>`);
    const box = row.nextElementSibling.querySelector('.file-previews');
    if (box) fillFilePreviews(box, r);
  }

  function drawFiles() {
    const st = ui.files;
    const filters = document.getElementById('fileFilters');
    const note = document.getElementById('fileNote');
    const list = document.getElementById('fileList');
    if (!list) return;
    drawFileFilters(filters);
    note.innerHTML = st.note ? `<div class="todo-hint">${escHtml(st.note)}</div>` : '';
    list.innerHTML = st.rows.length
      ? st.rows.map(fileRowHtml).join('')
      : st.kind
        ? `<div class="empty-note">No ${escHtml(FILE_KINDS[st.kind].toLowerCase())} delivered yet.</div>`
        : '<div class="empty-note"><div class="horst-glyph">H</div>Nothing delivered yet.<br>Files from finished jobs and from Horst\'s chat replies land here.</div>';

    list.querySelectorAll('.file-row').forEach((row) => row.addEventListener('click', async (e) => {
      const id = row.dataset.id;
      const r = st.rows.find((x) => x.id === id);
      if (!r) return;
      if (e.target.closest('[data-act="remove"]')) {
        if (!await showConfirm(`Remove “${r.title || r.name || id}” from Files?`, { confirmLabel: 'Remove', danger: true })) return;
        try { await api(`/files/${encodeURIComponent(id)}/remove`, { method: 'POST', body: '{}' }); } catch (err) { showAlert(err.message); return; }
        // Drop it in place — a full redraw would restart a playing file.
        st.rows = st.rows.filter((x) => x.id !== id);
        st.all = st.kind ? (st.all && st.all.filter((x) => x.id !== id)) : st.rows;
        if (st.counts[r.kind]) st.counts[r.kind] -= 1;
        if (st.open === id) st.open = null;
        const det = list.querySelector(`.file-detail[data-for="${CSS.escape(id)}"]`);
        if (det) det.remove();
        row.remove();
        drawFileFilters(filters);
        if (!st.rows.length) drawFiles();
        return;
      }
      if (e.target.closest('a')) return; // download / open links act on their own
      const was = st.open;
      list.querySelectorAll('.file-detail').forEach((el) => el.remove());
      list.querySelectorAll('.file-row.open').forEach((el) => el.classList.remove('open'));
      st.open = was === id ? null : id;
      if (st.open) openFileDetail(list, r);
    }));

    const open = st.open && st.rows.find((x) => x.id === st.open);
    if (open) {
      openFileDetail(list, open);
      const row = list.querySelector(`.file-row[data-id="${CSS.escape(open.id)}"]`);
      if (row) row.scrollIntoView({ block: 'nearest' });
    }
  }

  // --- Missions (the goal brain) — rendered on the steering surface --------
  const MISSION_ICON = { active: '🟢', pending: '⏳', paused: '⏸', blocked: '🔴', done: '✅', abandoned: '✖', proposed: '💡' };

  async function loadMissions() {
    const box = document.getElementById('missionBox');
    if (!box) return;
    let items = [];
    try { items = (await api('/missions')).missions || []; } catch { box.innerHTML = ''; return; }
    const visible = items.filter((m) => !['done', 'abandoned'].includes(m.status));
    box.innerHTML = `<div class="mission-head"><b>Missions</b><span class="sub">Standing goals Horst pursues — directives constrain, missions pursue</span></div>`
      + (visible.length ? visible.map((m) => `
        <div class="mission-row ${m.status}" data-id="${escHtml(m.id)}">
          <span class="mission-icon">${MISSION_ICON[m.status] || '·'}</span>
          <div class="mission-main">
            <b>${escHtml(m.title)}</b><span class="mission-goal">${escHtml(m.goal || '')}</span>
            ${m.progress && m.progress[0] ? `<span class="mission-progress">latest: ${escHtml(m.progress[0].note)}</span>` : ''}
          </div>
          <div class="mission-actions">
            ${m.status === 'pending' ? `<button class="hbtn primary" data-act="active">Confirm</button><button class="hbtn" data-act="abandoned">Dismiss</button>` : ''}
            ${m.status === 'active' ? `<button class="hbtn" data-act="paused">Pause</button><button class="hbtn" data-act="done">Done</button>` : ''}
            ${m.status === 'paused' || m.status === 'blocked' ? `<button class="hbtn" data-act="active">Activate</button>` : ''}
          </div>
        </div>`).join('')
      : '<div class="set-hint">No missions yet — tell Horst in chat: “your mission: …”</div>');
    box.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('.mission-row').dataset.id;
        try { await api(`/missions/${id}/status`, { method: 'POST', body: JSON.stringify({ status: btn.dataset.act }) }); await loadMissions(); }
        catch (err) { showAlert(err.message); }
      });
    });
  }

  async function renderDirectives() {
    main.innerHTML = `<div class="pane">
      <div class="pane-head"><h2>Directives</h2><span class="sub">Standing orders you give Horst — they apply to everything he does</span></div>
      <div class="pane-scroll">
        <div class="dir-explain">
          <p><b>A directive is a standing order.</b> Its exact words are placed into every
          prompt Horst runs — every chat reply, every email he classifies, every briefing,
          and every plan he makes. It is not something he might remember: it is literally
          in front of him, every single time.</p>
          <div id="scopeViz"></div>
        </div>

        <div class="dir-compose">
          <textarea id="dirNew" rows="2" placeholder="Tell Horst how you want him to behave — e.g. “Never draft replies to newsletters”"></textarea>
          <div class="dir-compose-actions">
            <button class="hbtn primary" id="dirWork">Work it through with Horst</button>
            <button class="hbtn" id="dirRaw" title="Skip the analysis and make this a directive exactly as written">Add as written</button>
          </div>
        </div>

        <div id="missionBox"></div>
        <div id="dirList"></div>
        <div id="genomeBox"></div>
      </div>
    </div>`;

    renderScopeViz();
    document.getElementById('dirWork').addEventListener('click', () => startWorkshop());
    document.getElementById('dirRaw').addEventListener('click', addDirectiveRaw);
    document.getElementById('dirNew').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) startWorkshop();
    });

    await Promise.all([loadDirectives(), loadGenome(), loadMissions()]);
    live('horst:missions', () => { if (ui.view === 'directives') loadMissions(); });
    // A workshop left open across a view switch reopens where it was left.
    // A draft that survived a page reload does NOT auto-open: it is listed as
    // an unfinished draft you can resume or discard deliberately, so a stray
    // Esc on a modal you did not open can never destroy it.
    if (ui.wsDraft) openWorkshop();
  }

  // Small animated diagram: one directive fanning out into every surface it
  // reaches. Same visual language as the map.
  function renderScopeViz(active) {
    const host = document.getElementById('scopeViz');
    if (!host) return;
    const targets = Object.keys(SCOPE_LABEL);
    const w = 620;
    const h = 96;
    const x0 = 16;
    const spacing = (w - 190) / (targets.length - 1);
    host.innerHTML = `<svg class="scope-viz" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
      <rect x="${x0}" y="34" width="120" height="30" rx="8" class="sv-src"/>
      <text x="${x0 + 60}" y="53" class="sv-srctext">directive</text>
      ${targets.map((t, i) => {
        const tx = 176 + i * spacing;
        const on = !active || active.includes(t);
        return `<path class="sv-wire ${on ? 'on' : 'off'}" style="animation-delay:${i * 140}ms"
                  d="M ${x0 + 122} 49 C ${x0 + 160} 49, ${tx - 26} ${20 + i * 12}, ${tx} ${20 + i * 12}"/>
                <circle class="sv-node ${on ? 'on' : 'off'}" cx="${tx}" cy="${20 + i * 12}" r="4"/>
                <text class="sv-label ${on ? 'on' : 'off'}" x="${tx + 10}" y="${24 + i * 12}">${escHtml(SCOPE_LABEL[t])}</text>`;
      }).join('')}
    </svg>`;
  }

  async function loadGenome() {
    const box = document.getElementById('genomeBox');
    if (!box) return;
    if (!ui.genome) {
      try { ui.genome = (await api('/genome')).genome || []; } catch { return; }
    }
    box.innerHTML = `<div class="genome-head" id="genomeToggle"><span class="arrow">▶</span>
        Horst's genome — ${ui.genome.length} rules that outrank your directives</div>
      <div class="genome-body" id="genomeBody" style="display:none">
        <div class="set-hint">These are fixed. A directive that would require Horst to break one is refused, citing the rule. Changing them takes a code change, not a setting.</div>
        ${ui.genome.map((g) => `<div class="gene"><b>${escHtml(g.id)}</b>
          <span class="gene-name">${escHtml(g.name)}</span>
          <span class="gene-rule">${escHtml(g.rule)}</span></div>`).join('')}
      </div>`;
    document.getElementById('genomeToggle').addEventListener('click', () => {
      const body = document.getElementById('genomeBody');
      const open = body.style.display === 'none';
      body.style.display = open ? '' : 'none';
      document.getElementById('genomeToggle').classList.toggle('open', open);
    });
  }

  // --- the workshop --------------------------------------------------------

  async function startWorkshop() {
    const input = document.getElementById('dirNew');
    const text = input.value.trim();
    if (!text) return;
    // Park it as a draft first, so an analysis that takes a while (or a reload
    // mid-flight) never loses what was typed.
    let directive = null;
    try {
      directive = (await api('/directives', { method: 'POST', body: JSON.stringify({ text, status: 'draft' }) })).directive;
    } catch (err) { showAlert(err.message); return; }
    input.value = '';
    ui.wsDraft = { id: directive.id, text, analysis: null, answers: [] };
    openWorkshop();
    await runAnalysis();
  }

  async function runAnalysis() {
    const d = ui.wsDraft;
    if (!d) return;
    ui.wsBusy = true;
    renderWorkshop();
    try {
      const res = await api('/directives/analyze', {
        method: 'POST',
        body: JSON.stringify({
          text: d.text,
          directiveId: d.id,
          answers: d.answers,
        }),
      });
      if (ui.wsDraft !== d) return; // aborted while Horst was thinking
      d.analysis = res.analysis;
    } catch (err) {
      if (ui.wsDraft !== d) return;
      d.error = err.message;
    } finally {
      if (ui.wsDraft === d) {
        ui.wsBusy = false;
        renderWorkshop();
      }
    }
  }

  // The workshop lives in a full-size modal overlay. Closing it in any way
  // before acceptance (✕, Esc, backdrop click, Discard) aborts: the draft is
  // deleted server-side and forgotten. Only "Make it a directive" keeps it —
  // and that also closes the modal, returning to the plain list.

  function onWsKey(e) {
    if (e.key === 'Escape') abortWorkshop();
  }

  function openWorkshop() {
    let el = document.getElementById('wsOverlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'wsOverlay';
      el.className = 'prop-overlay';
      el.innerHTML = `<div class="po-sheet ws-sheet">
        <div class="po-bar"><b>Directive workshop</b>
          <button class="po-close" title="Abort (Esc) — the draft is forgotten">✕</button></div>
        <div class="ws-body" id="wsBody"></div>
      </div>`;
      document.body.appendChild(el);
      el.querySelector('.po-close').addEventListener('click', abortWorkshop);
      document.addEventListener('keydown', onWsKey);
    }
    renderWorkshop();
  }

  // Remove the modal without touching the draft — used on view switches; the
  // draft persists server-side and the Directives view picks it back up.
  function closeWorkshopUI() {
    document.getElementById('wsOverlay')?.remove();
    document.removeEventListener('keydown', onWsKey);
  }

  async function resumeWorkshop(item) {
    ui.wsDraft = { id: item.id, text: item.text, analysis: item.analysis || null, answers: item.answers || [] };
    ui.wsBusy = false;
    openWorkshop();
    if (!ui.wsDraft.analysis) await runAnalysis();
  }

  async function abortWorkshop() {
    const id = ui.wsDraft?.id;
    ui.wsDraft = null;
    ui.wsBusy = false;
    closeWorkshopUI();
    renderScopeViz();
    if (id != null) {
      try { await api(`/directives/${id}`, { method: 'DELETE' }); } catch { /* already gone */ }
    }
    await loadDirectives();
  }

  function swotBlock(swot) {
    const cols = [
      ['strengths', 'What it buys you', 'good'],
      ['weaknesses', 'What it costs', 'bad'],
      ['opportunities', 'What it opens up', 'good'],
      ['threats', 'What could bite', 'bad'],
    ];
    const any = cols.some(([k]) => (swot[k] || []).length);
    if (!any) return '';
    return `<div class="ws-swot">${cols.map(([k, label, tone]) => {
      const items = swot[k] || [];
      if (!items.length) return '';
      return `<div class="swot-col ${tone}">
        <div class="swot-head">${escHtml(label)}</div>
        ${items.map((s) => `<div class="swot-item">${escHtml(typeof s === 'string' ? s : JSON.stringify(s))}</div>`).join('')}
      </div>`;
    }).join('')}</div>`;
  }

  function renderWorkshop() {
    const host = document.getElementById('wsBody');
    if (!host) return;
    const d = ui.wsDraft;
    if (!d) { closeWorkshopUI(); return; }

    if (ui.wsBusy) {
      host.innerHTML = `<div class="ws-panel">
        <div class="ws-thinking"><span class="ws-orb"></span>
          <div><b>Horst is thinking this through</b>
          <div class="set-hint">Checking it against your active directives and his genome, and looking for the edges.</div></div>
        </div>
        <div class="ws-quote">${escHtml(d.text)}</div>
      </div>`;
      return;
    }

    if (d.error) {
      host.innerHTML = `<div class="ws-panel">
        <div class="empty-note error">⚠ ${escHtml(d.error)}</div>
        <div class="prop-actions">
          <button class="hbtn primary" data-ws="retry">Try again</button>
          <button class="hbtn" data-ws="raw">Add it as written anyway</button>
          <button class="hbtn" data-ws="discard">Discard</button>
        </div></div>`;
      wireWorkshop(host);
      return;
    }

    const a = d.analysis;
    if (!a) { host.innerHTML = ''; return; }
    const rejected = a.verdict === 'reject' || !a.genomeCheck.ok;
    const needs = a.questions.length > 0;

    host.innerHTML = `<div class="ws-panel ${rejected ? 'rejected' : needs ? 'asking' : 'ready'}">
      <div class="ws-head">
        <span class="ws-verdict ${rejected ? 'bad' : needs ? 'warn' : 'good'}">
          ${rejected ? '⛔ Refused' : needs ? '❓ Needs your answers' : '✓ Ready'}
        </span>
      </div>

      ${rejected ? `<div class="ws-reject">
        <b>This would break ${escHtml(a.genomeCheck.gene || 'the genome')}.</b>
        <div>${escHtml(a.genomeCheck.why || 'It conflicts with a rule Horst cannot set aside.')}</div>
      </div>` : ''}

      <div class="ws-restated">
        <div class="ws-label">How Horst would write it</div>
        <textarea id="wsText" rows="3">${escHtml(a.restated)}</textarea>
      </div>

      ${a.questions.length ? `<div class="ws-block">
        <div class="ws-label">He needs to know</div>
        ${a.questions.map((q, i) => `<div class="ws-q">
          <div class="ws-qtext">${escHtml(q.q)}</div>
          ${q.why ? `<div class="ws-why">${escHtml(q.why)}</div>` : ''}
          <input class="ws-a" data-qi="${i}" placeholder="Your answer…" value="${escHtml((d.answers[i] || {}).a || '')}">
        </div>`).join('')}
      </div>` : ''}

      ${a.edgeCases.length ? `<div class="ws-block">
        <div class="ws-label">At the edges</div>
        ${a.edgeCases.map((e) => `<div class="ws-edge">
          <span class="ws-case">${escHtml(e.case)}</span>
          <span class="ws-beh">${escHtml(e.behavior || '')}</span>
        </div>`).join('')}
      </div>` : ''}

      ${swotBlock(a.swot)}

      ${a.conflicts.length ? `<div class="ws-block ws-conflict">
        <div class="ws-label">Clashes with what you've already told him</div>
        ${a.conflicts.map((c) => `<div class="ws-edge">
          <span class="ws-case">#${escHtml(String(c.directiveId))}</span>
          <span class="ws-beh">${escHtml(c.nature)}</span></div>`).join('')}
      </div>` : ''}

      ${a.scope.affects.length ? `<div class="ws-block">
        <div class="ws-label">Where this will apply</div>
        <div class="ws-scopes">${a.scope.affects.map((s) => `<span class="chip on">${escHtml(SCOPE_LABEL[s] || s)}</span>`).join('')}</div>
      </div>` : ''}

      <div class="prop-actions">
        ${needs ? `<button class="hbtn primary" data-ws="reanalyze">Send answers back to Horst</button>` : ''}
        ${rejected ? '' : `<button class="hbtn ${needs ? '' : 'primary'}" data-ws="activate">Make it a directive</button>`}
        <button class="hbtn" data-ws="discard">Discard</button>
      </div>
    </div>`;

    // Light up only the surfaces this directive actually reaches.
    renderScopeViz(a.scope.affects.length ? a.scope.affects : null);
    wireWorkshop(host);
  }

  function wireWorkshop(host) {
    host.querySelectorAll('.ws-a').forEach((input) => {
      input.addEventListener('input', () => {
        const i = Number(input.dataset.qi);
        const q = ui.wsDraft.analysis.questions[i];
        ui.wsDraft.answers[i] = { q: q.q, a: input.value };
      });
    });
    const textEl = host.querySelector('#wsText');
    if (textEl) textEl.addEventListener('input', () => { ui.wsDraft.text = textEl.value; });

    host.querySelectorAll('[data-ws]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const act = btn.dataset.ws;
        if (act === 'discard') return abortWorkshop();
        if (act === 'retry' || act === 'reanalyze') {
          ui.wsDraft.error = null;
          await runAnalysis();
          return;
        }
        if (act === 'activate' || act === 'raw') {
          const text = (host.querySelector('#wsText')?.value || ui.wsDraft.text).trim();
          if (!text) return;
          try {
            await api(`/directives/${ui.wsDraft.id}/text`, { method: 'POST', body: JSON.stringify({ text }) });
            await api(`/directives/${ui.wsDraft.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'active' }) });
          } catch (err) { showAlert(err.message); return; }
          ui.wsDraft = null;
          closeWorkshopUI();
          renderScopeViz();
          await loadDirectives();
          refreshBadges();
        }
      });
    });
  }

  // The escape hatch: no analysis, straight to active.
  async function addDirectiveRaw() {
    const input = document.getElementById('dirNew');
    const text = input.value.trim();
    if (!text) return;
    try {
      await api('/directives', { method: 'POST', body: JSON.stringify({ text }) });
      input.value = '';
      await loadDirectives();
      refreshBadges();
    } catch (err) { showAlert(err.message); }
  }

  // --- the list ------------------------------------------------------------

  async function loadDirectives() {
    let items = [];
    let loadErr = null;
    try { items = (await api('/directives')).directives || []; } catch (err) { loadErr = err; }
    ui.dirItems = items;
    const list = document.getElementById('dirList');
    if (!list) return;
    if (loadErr) { list.innerHTML = loadErrNote(loadErr); return; }

    // Drafts are unfinished workshop sessions. They steer nothing, but they are
    // never silently dropped either — you resume or discard them by hand.
    const drafts = items.filter((d) => d.status === 'draft' && d.id !== ui.wsDraft?.id);
    const shown = items.filter((d) => d.status !== 'draft');
    const draftHtml = drafts.length ? `<div class="dir-section">Unfinished drafts</div>`
      + drafts.map((d) => `<div class="dir-item draft" data-id="${d.id}">
          <span class="dir-id">#${d.id}</span>
          <span class="dir-chip draft">draft</span>
          <div class="dir-text" data-role="text">${escHtml(d.text)}</div>
          <div class="dir-actions">
            <button class="hbtn primary" data-act="resume">Resume in workshop</button>
            <button class="hbtn danger" data-act="delete" title="Discard this draft">🗑</button>
          </div>
        </div>`).join('') : '';

    if (!shown.length) {
      list.innerHTML = draftHtml + `<div class="empty-note">
        No directives in force. Write one above and Horst will work it through with you —
        or just tell him “from now on…” in chat.
      </div>`;
      wireDirList(list, drafts);
      return;
    }
    list.innerHTML = draftHtml + `<div class="dir-section">In force</div>` + shown.map((d) => `<div class="dir-item ${d.status}" data-id="${d.id}">
      <span class="dir-id">#${d.id}</span>
      <span class="dir-chip ${d.status}">${d.status}</span>
      <div class="dir-text" data-role="text">${escHtml(d.text)}</div>
      ${d.analysis?.scope?.affects?.length ? `<div class="dir-scopes">${d.analysis.scope.affects.map((s) => `<span class="chip">${escHtml(SCOPE_LABEL[s] || s)}</span>`).join('')}</div>` : ''}
      <div class="dir-actions">
        ${d.status === 'pending' ? `<button class="hbtn primary" data-act="active">Confirm</button>` : ''}
        ${d.status === 'active' ? `<button class="hbtn" data-act="inactive">Deactivate</button>` : ''}
        ${d.status === 'inactive' ? `<button class="hbtn" data-act="active">Activate</button>` : ''}
        <button class="hbtn" data-act="edit">Edit</button>
        <button class="hbtn danger" data-act="delete" title="Delete permanently">🗑</button>
      </div>
    </div>`).join('');
    wireDirList(list, drafts);
  }

  function wireDirList(list, drafts) {
    list.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = btn.closest('.dir-item');
        const id = item.dataset.id;
        if (btn.dataset.act === 'edit') return startEdit(item, id);
        if (btn.dataset.act === 'resume') {
          const draft = (drafts || []).find((d) => String(d.id) === String(id));
          if (draft) return resumeWorkshop(draft);
          return;
        }
        if (btn.dataset.act === 'delete') {
          const text = item.querySelector('[data-role="text"]').textContent;
          const isDraft = item.classList.contains('draft');
          const msg = isDraft
            ? `Discard draft #${id}?\n\n"${text}"\n\nIt was never in force. This cannot be undone.`
            : `Delete directive #${id} permanently?\n\n"${text}"\n\nHorst will stop following it immediately. This cannot be undone.`;
          if (!await showConfirm(msg, { confirmLabel: isDraft ? 'Discard' : 'Delete', danger: true })) return;
          try { await api(`/directives/${id}`, { method: 'DELETE' }); } catch (err) { showAlert(err.message); return; }
          await loadDirectives();
          refreshBadges();
          return;
        }
        try {
          await api(`/directives/${id}/status`, { method: 'POST', body: JSON.stringify({ status: btn.dataset.act }) });
          await loadDirectives();
          refreshBadges();
        } catch (err) { showAlert(err.message); }
      });
    });
  }

  function startEdit(item, id) {
    const textEl = item.querySelector('[data-role="text"]');
    const current = textEl.textContent;
    textEl.innerHTML = `<textarea>${escHtml(current)}</textarea>`;
    const actions = item.querySelector('.dir-actions');
    actions.innerHTML = `<button class="hbtn primary" data-save>Save</button><button class="hbtn" data-cancel>Cancel</button>`;
    actions.querySelector('[data-save]').addEventListener('click', async () => {
      const text = textEl.querySelector('textarea').value.trim();
      if (!text) return;
      try {
        await api(`/directives/${id}/text`, { method: 'POST', body: JSON.stringify({ text }) });
        await loadDirectives();
      } catch (err) { showAlert(err.message); }
    });
    actions.querySelector('[data-cancel]').addEventListener('click', loadDirectives);
  }


  // =========================================================================
  // Timeline — one causal feed (replaces Agenda / Journal / Activity / Events / Work)
  // =========================================================================

  const TL_STREAMS = {
    event: { label: 'Senses', icon: '◉' },
    agenda: { label: 'Noticed', icon: '▪' },
    proposal: { label: 'Actions', icon: '🛡' },
    todo: { label: 'Todos', icon: '☑' },
    journal: { label: 'Briefings', icon: '📰' },
  };

  // Rows that describe the same real-world thing share a chain key, so the feed
  // can show "mail arrived → classified → staged an action" as one story rather
  // than three unrelated lines in three different tabs.
  function chainKeyFor(kind, row) {
    if (kind === 'event') {
      if (row.correlationId) return `corr:${row.correlationId}`;
      const m = /^([^:]+@[^:]+):(\d+)$/.exec(row.dedupeKey || '');
      return m ? `mail:${m[1]}:${m[2]}` : null;
    }
    if (kind === 'agenda' && row.detail?.account && row.detail?.uid) {
      return `mail:${row.detail.account}:${row.detail.uid}`;
    }
    if (kind === 'proposal') {
      const m = /^cal:(.+):(\d+):\d+$/.exec(row.dedupeKey || '');
      if (m) return `mail:${m[1]}:${m[2]}`;
    }
    // A reply-watch todo folds into its email's story.
    if (kind === 'todo' && row.watch && row.watch.account && row.watch.uid) {
      return `mail:${row.watch.account}:${row.watch.uid}`;
    }
    return null;
  }

  function tlRow(kind, row) {
    const base = { stream: kind, at: row.at || row.createdAt || row.updatedAt || 0, raw: row, chain: chainKeyFor(kind, row) };
    if (kind === 'event') {
      return { ...base, title: row.summary || row.kind, tag: row.kind, outcome: row.outcome, trust: row.trust };
    }
    if (kind === 'agenda') return { ...base, title: row.summary, tag: row.kind };
    if (kind === 'journal') return { ...base, title: row.title, tag: row.kind, body: row.body };
    if (kind === 'proposal') {
      return { ...base, title: row.summary, tag: row.kind, status: row.status, id: row.id, fullView: !!row.fullViewApprove, version: row.version || '' };
    }
    if (kind === 'todo') {
      return {
        ...base, at: new Date(row.createdAt).getTime() || 0,
        title: row.title, id: row.id, status: row.status,
        tag: row.watch ? 'waiting-for' : (row.recurrence ? 'recurring' : 'todo'),
      };
    }
    return base;
  }

  async function renderTimeline(opts) {
    if (opts && opts.filter) ui.tlFilter = { stream: '', source: '', policy: '', ...opts.filter };
    const f = ui.tlFilter;
    const chips = [['', 'Everything'], ...Object.entries(TL_STREAMS).map(([k, v]) => [k, v.label])];

    main.innerHTML = `<div class="pane">
      <div class="pane-head">
        <h2>Timeline</h2><span class="sub">Everything Horst sensed, noticed, decided and did</span>
        <span class="spacer"></span>
        <button class="hbtn" id="runBriefing">Run briefing now</button>
      </div>
      <div class="tl-filters">
        ${chips.map(([k, label]) => `<button class="chip ${f.stream === k ? 'on' : ''}" data-stream="${escHtml(k)}">${escHtml(label)}</button>`).join('')}
        ${f.source ? `<span class="chip filter">source: ${escHtml(f.source)} <b data-clear="source">✕</b></span>` : ''}
        ${f.policy ? `<span class="chip filter">routed to: ${escHtml(POLICY_MEANING[f.policy]?.label || f.policy)} <b data-clear="policy">✕</b></span>` : ''}
      </div>
      <div class="pane-scroll" id="tlFeed"></div>
    </div>`;

    main.querySelectorAll('[data-stream]').forEach((b) => b.addEventListener('click', () => {
      ui.tlFilter.stream = b.dataset.stream;
      renderTimeline();
    }));
    main.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => {
      ui.tlFilter[b.dataset.clear] = '';
      renderTimeline();
    }));
    document.getElementById('runBriefing').addEventListener('click', runBriefingNow);

    await loadTimeline();
    // New rows arrive over the live channel; re-render so chains re-form.
    for (const t of ['horst:event', 'horst:agenda', 'horst:journal', 'horst:proposal', 'horst:todos']) {
      live(t, () => { if (ui.view === 'timeline') loadTimeline(); });
    }
  }

  async function runBriefingNow() {
    const btn = document.getElementById('runBriefing');
    if (!btn) return;
    btn.disabled = true; btn.textContent = 'Running…';
    try { await api('/briefing/run', { method: 'POST' }); } catch (err) { showAlert(err.message); }
    // The briefing lands as a journal entry — the live channel announces it.
    const off = window.HorstLive?.on('horst:journal', () => {
      btn.disabled = false; btn.textContent = 'Run briefing now';
      loadTimeline();
      off?.();
    });
    setTimeout(() => { btn.disabled = false; btn.textContent = 'Run briefing now'; off?.(); }, 120000);
  }

  async function loadTimeline() {
    const f = ui.tlFilter;
    const want = (s) => !f.stream || f.stream === s;
    const q = new URLSearchParams();
    if (f.source) q.set('source', f.source);

    const [events, agenda, journal, proposals, audit, todos] = await Promise.all([
      want('event') ? api('/events' + (q.toString() ? '?' + q : '')).then((r) => r.events || []).catch(() => []) : [],
      want('agenda') ? api('/agenda').then((r) => r.agenda || []).catch(() => []) : [],
      want('journal') ? api('/journal').then((r) => r.journal || []).catch(() => []) : [],
      want('proposal') ? api('/proposals').then((r) => r.proposals || []).catch(() => []) : [],
      // The governance audit carries what /proposals cannot: dial changes,
      // directive deletions, denials made from Telegram — the old Activity view.
      want('proposal') ? api('/audit').then((r) => r.audit || []).catch(() => []) : [],
      want('todo') ? api('/todos?status=all&limit=100').then((r) => r.todos || []).catch(() => []) : [],
    ]);

    let rows = [
      ...events.filter((e) => !f.policy || e.policy === f.policy).map((e) => tlRow('event', e)),
      ...agenda.map((a) => tlRow('agenda', a)),
      ...journal.map((j) => tlRow('journal', j)),
      ...proposals.map((p) => tlRow('proposal', p)),
      ...todos.map((t) => tlRow('todo', t)),
      // Proposal lifecycle rows duplicate /proposals; keep only what it can't show.
      ...audit.filter((a) => !a.proposalId).map((a) => ({
        stream: 'proposal', at: a.at, raw: a, chain: null,
        title: a.summary || a.kind || a.action, tag: a.action,
      })),
    ].filter((r) => r.at).sort((a, b) => b.at - a.at);

    // Fold chained rows under their earliest member.
    const chains = new Map();
    const out = [];
    for (const r of rows) {
      if (!r.chain) { out.push({ head: r, kids: [] }); continue; }
      const existing = chains.get(r.chain);
      if (existing) { existing.kids.push(r); continue; }
      const group = { head: r, kids: [], key: r.chain };
      chains.set(r.chain, group);
      out.push(group);
    }
    ui.tlRows = out;

    const feed = document.getElementById('tlFeed');
    if (!feed) return;
    if (!out.length) {
      feed.innerHTML = '<div class="empty-note">Nothing here yet for this filter.</div>';
      return;
    }
    feed.innerHTML = out.slice(0, 250).map(renderChain).join('');

    feed.querySelectorAll('.tl-item').forEach((el) => {
      el.querySelector('.tl-head')?.addEventListener('click', () => {
        const key = el.dataset.key;
        if (!key) return;
        if (ui.tlOpen.has(key)) ui.tlOpen.delete(key); else ui.tlOpen.add(key);
        loadTimeline();
      });
    });
    feed.querySelectorAll('[data-decide]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        btn.disabled = true;
        try {
          await api(`/proposals/${encodeURIComponent(btn.dataset.pid)}/decide`, {
            method: 'POST', body: JSON.stringify({ decision: btn.dataset.decide, version: btn.dataset.version }),
          });
        } catch (err) { showAlert(err.message); }
        await loadTimeline();
        refreshBadges();
      });
    });
    // data-openprop="<id>": straight to that proposal's full card (a kind
    // approved only there, fullViewApprove); bare: the Approvals view.
    feed.querySelectorAll('[data-openprop]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const pid = b.dataset.openprop;
      await setView('approvals');
      if (pid) openPropOverlay(pid);
    }));
  }

  function renderChain(group) {
    const r = group.head;
    const meta = TL_STREAMS[r.stream] || { icon: '·' };
    const key = group.key || '';
    const open = key && ui.tlOpen.has(key);
    const kids = group.kids || [];
    const statusChip = r.status ? `<span class="tl-chip ${escHtml(r.status)}">${escHtml(r.status)}</span>` : '';
    const pending = r.stream === 'proposal' && r.status === 'pending';

    return `<div class="tl-item s-${escHtml(r.stream)}" ${key ? `data-key="${escHtml(key)}"` : ''}>
      <div class="tl-head">
        <span class="tl-icon">${meta.icon}</span>
        <span class="tl-time">${fmtTime(r.at)}</span>
        <span class="tl-title">${escHtml(r.title || '')}</span>
        ${r.tag ? `<span class="tl-chip ${escHtml(r.tag)}">${escHtml(r.tag)}</span>` : ''}
        ${r.trust === 'untrusted' ? '<span class="tl-chip untrusted">untrusted</span>' : ''}
        ${statusChip}
        ${r.outcome ? `<span class="tl-outcome">${escHtml(r.outcome)}</span>` : ''}
        ${kids.length ? `<span class="tl-chain">${kids.length} more <i>${open ? '▾' : '▸'}</i></span>` : ''}
      </div>
      ${pending && r.fullView ? `<div class="tl-actions">
        <button class="hbtn primary" data-openprop="${escHtml(r.id)}" title="Approved only where its whole payload is shown">⤢ Open the full card to approve</button>
        <button class="hbtn danger" data-decide="deny" data-pid="${escHtml(r.id)}">Deny</button>
      </div>` : pending ? `<div class="tl-actions">
        <button class="hbtn primary" data-decide="approve" data-pid="${escHtml(r.id)}" data-version="${escHtml(r.version)}">✓ Approve</button>
        <button class="hbtn danger" data-decide="deny" data-pid="${escHtml(r.id)}">Deny</button>
        <button class="hbtn" data-openprop>See the full payload</button>
      </div>` : ''}
      ${r.body ? `<div class="tl-body">${escHtml(r.body)}</div>` : ''}
      ${open && kids.length ? `<div class="tl-kids">${kids.map((k) => `
        <div class="tl-kid s-${escHtml(k.stream)}">
          <span class="tl-icon">${(TL_STREAMS[k.stream] || {}).icon || '·'}</span>
          <span class="tl-time">${fmtTime(k.at)}</span>
          <span class="tl-title">${escHtml(k.title || '')}</span>
          ${k.status ? `<span class="tl-chip ${escHtml(k.status)}">${escHtml(k.status)}</span>` : ''}
          ${k.outcome ? `<span class="tl-outcome">${escHtml(k.outcome)}</span>` : ''}
        </div>`).join('')}</div>` : ''}
    </div>`;
  }

  // =========================================================================
  // Approvals
  // =========================================================================

  // --- how long a card has been waiting ---
  //
  // A queue nobody clears is a queue nobody reads, so the age is on the card
  // and anything past two days is grouped apart with a way to clear it in one
  // gesture. Age reads from createdAt, never from expiresAt: "Keep 7 days"
  // must not make a card that has been waiting a week look fresh.

  const STALE_MS = 48 * 60 * 60 * 1000;

  function ageOf(p) { return Date.now() - (p.createdAt || Date.now()); }
  function isStale(p) { return ageOf(p) > STALE_MS; }

  function ageLabel(ms) {
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  }

  // --- payload cards (per-kind pretty rendering) ---

  function fmtSize(n) {
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function attSize(a) {
    if (Number.isFinite(a.size)) return a.size;
    return a.base64Data ? Math.round(a.base64Data.length * 3 / 4) : 0;
  }

  function attChips(atts, { editable } = {}) {
    return (atts || []).map((a, i) => `<span class="att-chip" title="${escHtml(a.contentType || a.mimeType || '')}">
      <span class="att-icon">📎</span>${escHtml(a.filename || 'attachment')}
      ${attSize(a) ? `<i>${fmtSize(attSize(a))}</i>` : ''}
      ${editable ? `<button class="att-rm" data-att-rm="${i}" title="Remove attachment">✕</button>` : ''}
    </span>`).join('');
  }

  // App-registered kinds are namespaced '<app>:<kind>' (e.g. my-dashboard:email).
  // Classify by the base name so app proposals get the same pretty cards and
  // editors as the built-in platform kinds instead of falling through to raw JSON.
  function kindFamily(kind) {
    const base = String(kind || '').includes(':') ? kind.slice(kind.indexOf(':') + 1) : kind;
    if (base === 'email.send' || base === 'email') return 'email';
    if (base === 'reply') return 'reply';
    if (base === 'email.modify') return 'email-modify';
    if (base === 'calendar.create' || base === 'calendar_create') return 'cal-create';
    if (base === 'calendar.update' || base === 'calendar_edit') return 'cal-update';
    if (base === 'calendar.delete' || base === 'calendar_delete') return 'cal-delete';
    if (base === 'telegram.send' || base === 'telegram_message') return 'telegram';
    return null;
  }

  // Normalize the two calendar payload shapes (simple fields vs raw Google
  // `event` body) into one set of editor/display fields.
  function isoToLocalParts(s) {
    const str = String(s || '');
    if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(str.slice(10))) {
      const d = new Date(str);
      if (!isNaN(d)) {
        const pad = (x) => String(x).padStart(2, '0');
        return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
      }
    }
    const m = str.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
    return m ? { date: m[1], time: m[2] || '' } : { date: '', time: '' };
  }

  // The `event` fallback reads proposals staged before the engine stopped
  // accepting a raw Google body. New ones carry flat fields only; old ones are
  // still in the ledger and must still render. See horst-prior-action.js.
  function calFields(pl) {
    const ev = pl.event || {};
    const f = {
      title: pl.title || pl.summary || ev.summary || '',
      location: pl.location || ev.location || '',
      description: pl.description || ev.description || '',
      attendees: (pl.attendees || ev.attendees || []).map((a) => (typeof a === 'string' ? a : a.email)).filter(Boolean),
      allDay: !!pl.allDay,
      date: pl.date || '',
      endDate: pl.endDate || '',
      startTime: pl.startTime || '',
      endTime: pl.endTime || '',
    };
    const start = pl.start || ev.start;
    const end = pl.end || ev.end;
    if (!f.date && start) {
      if (start.date) { f.allDay = true; f.date = start.date; }
      else if (start.dateTime) {
        const parts = isoToLocalParts(start.dateTime);
        f.date = parts.date; f.startTime = parts.time;
      }
    }
    if (!f.allDay && !f.endTime && end && end.dateTime) f.endTime = isoToLocalParts(end.dateTime).time;
    return f;
  }

  // --- prior-action banner ---------------------------------------------------
  //
  // The server checks every pending proposal against the world (calendar store,
  // sent-mail log, its own ledger) and persists the verdict as `prior`. This is
  // the part of the card that says "you already did this" — and, for a calendar
  // entry that exists but is thinner than the proposal, that the card in front
  // of you has become an UPDATE to that event rather than a second copy.

  // Draft → what you are about to approve. `originalPayload` has been on the
  // wire since payload editing was introduced and nothing has ever rendered it,
  // so an edited card gave no sign of what changed.
  function diffBlock(p) {
    if (!p.editedAt || !p.originalPayload) return '';
    const before = p.originalPayload || {};
    const after = p.payload || {};
    const show = (v) => {
      if (v == null || v === '') return '(empty)';
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return s.length > 160 ? s.slice(0, 160) + '…' : s;
    };
    const rows = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      .slice(0, 8)
      .map((k) => `<div class="pd-row">
        <span class="pd-key">${escHtml(k)}</span>
        <span class="pd-before">${escHtml(show(before[k]))}</span>
        <span class="pd-after">${escHtml(show(after[k]))}</span>
      </div>`);
    if (!rows.length) return '';
    return `<div class="prop-diff">
      <b>✎ Edited before approval — you are approving the right-hand version</b>
      ${rows.join('')}
    </div>`;
  }

  function priorBanner(p) {
    const pr = p.prior;
    if (!pr || pr.state === 'none') return '';
    const partial = pr.state === 'partial' || pr.converted;
    return `<div class="prop-prior ${partial ? 'partial' : 'done'}">
      <span class="pp-icon">${partial ? '⟳' : '✓'}</span>
      <div class="pp-text">
        <b>${escHtml(pr.label || (partial ? 'Already in your calendar' : 'Already done'))}</b>
        ${pr.detail ? `<span>${escHtml(pr.detail)}</span>` : ''}
        ${pr.semantic ? `<span class="pp-note">🧭 ${Math.round(pr.semantic.sim * 100)}% meaning match${pr.semantic.promoted ? ' — found by meaning, the titles read differently' : ' (stored event embedding agrees)'}</span>` : ''}
        ${pr.adds && pr.adds.length ? `<span class="pp-adds">Adds ${pr.adds.map((a) => `<em>${escHtml(a)}</em>`).join(', ')}</span>` : ''}
        ${pr.note ? `<span class="pp-note">${escHtml(pr.note)}</span>` : ''}
        ${pr.userChoice === 'create' ? '<span class="pp-note">You chose to create a separate event.</span>' : ''}
      </div>
    </div>`;
  }

  // Buttons offered in addition to approve/deny, from the two forms the server
  // recorded on `prior` (create ⇄ update). Only these two are reachable.
  function priorAltActions(p) {
    const pr = p.prior;
    if (!pr) return '';
    if (pr.converted && pr.original) return '<button class="hbtn" data-convert="create">＋ Create as a separate event</button>';
    if (pr.userChoice === 'create' && pr.suggested) return '<button class="hbtn" data-convert="update">⟳ Update the existing event instead</button>';
    return '';
  }

  // --- day timeline ----------------------------------------------------------

  const HOUR_PX = 46;

  function minutesOfLocal(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return null;
    return d.getHours() * 60 + d.getMinutes();
  }

  function localDateStr(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // Side-by-side columns for events that overlap in time. Blocks are clustered
  // into runs of mutual overlap, then each cluster's members are dealt into the
  // first lane whose previous block has ended.
  function layoutBlocks(items) {
    const sorted = [...items].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
    let cluster = [];
    let clusterEnd = -1;
    const finish = () => {
      if (!cluster.length) return;
      const lanes = [];
      for (const it of cluster) {
        let lane = lanes.findIndex((end) => end <= it.startMin);
        if (lane < 0) { lane = lanes.length; lanes.push(0); }
        lanes[lane] = it.endMin;
        it.lane = lane;
      }
      for (const it of cluster) it.lanes = lanes.length;
      cluster = [];
      clusterEnd = -1;
    };
    for (const it of sorted) {
      if (cluster.length && it.startMin >= clusterEnd) finish();
      cluster.push(it);
      clusterEnd = Math.max(clusterEnd, it.endMin);
    }
    finish();
    return sorted;
  }

  function timelineBlocks(dayEvents, proposed, targetEventId, date) {
    const blocks = [];
    for (const e of dayEvents) {
      if (e.allDay) continue;
      if (minutesOfLocal(e.start) == null) continue;
      // An event that spills across midnight is CLIPPED to this day, never
      // dropped and never collapsed: it still occupies these hours, and the
      // wall-clock minutes of its far end belong to a different day.
      const startsEarlier = date && localDateStr(e.start) < date;
      const endsLater = date && e.end && localDateStr(e.end) > date;
      const startMin = startsEarlier ? 0 : minutesOfLocal(e.start);
      let endMin;
      if (endsLater) endMin = 1440;
      else {
        endMin = e.end ? minutesOfLocal(e.end) : null;
        if (endMin == null || endMin <= startMin) endMin = Math.min(startMin + 30, 1440);
      }
      blocks.push({
        startMin: Math.max(0, startMin), endMin: Math.min(1440, endMin),
        title: e.summary, location: e.location, color: e.backgroundColor,
        kind: e.id && e.id === targetEventId ? 'target' : 'event',
        id: e.id,
      });
    }
    if (proposed && proposed.startMin != null) blocks.push(proposed);
    return layoutBlocks(blocks);
  }

  function blockHtml(b) {
    const top = (b.startMin / 60) * HOUR_PX;
    const height = Math.max(((b.endMin - b.startMin) / 60) * HOUR_PX, 18);
    const width = 100 / (b.lanes || 1);
    const left = (b.lane || 0) * width;
    const time = `${String(Math.floor(b.startMin / 60)).padStart(2, '0')}:${String(b.startMin % 60).padStart(2, '0')}`;
    // A short event has no room for a stacked time + title, and a title nobody
    // can read is the same as no title — so below ~35px the two share one line,
    // and the location only earns its line once there is genuinely space.
    const tiny = height < 35;
    const style = `top:${top}px;height:${height}px;left:${left}%;width:calc(${width}% - 5px)`
      + (b.kind === 'event' && b.color ? `;--blk:${b.color}` : '');
    return `<div class="tl-block ${b.kind}${tiny ? ' tiny' : ''}" style="${style}" title="${escHtml(`${time} ${b.title || ''}${b.location ? ' · ' + b.location : ''}`)}">
      <span class="tl-blk-time">${time}</span>
      <span class="tl-blk-title">${escHtml(b.title || '(untitled)')}</span>
      ${height > 58 && b.location ? `<span class="tl-blk-loc">${escHtml(b.location)}</span>` : ''}
    </div>`;
  }

  function renderDayTimeline(date, dayEvents, proposed, targetEventId) {
    const allDay = dayEvents.filter((e) => e.allDay);
    const ghostAllDay = proposed && proposed.allDay ? proposed : null;
    const blocks = timelineBlocks(dayEvents, proposed, targetEventId, date);
    const hours = [];
    for (let h = 0; h < 24; h++) {
      hours.push(`<div class="tl-hour" style="height:${HOUR_PX}px"><span>${String(h).padStart(2, '0')}:00</span></div>`);
    }
    const d = new Date(date + 'T00:00:00');
    const heading = isNaN(d) ? date : d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const now = new Date();
    const nowLine = now.toDateString() === d.toDateString()
      ? `<div class="tl-now" style="top:${((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX}px"></div>` : '';
    return `<div class="cal-timeline">
      <div class="tl-head">
        <b>${escHtml(heading)}</b>
        <span>${dayEvents.length ? `${dayEvents.length} event${dayEvents.length > 1 ? 's' : ''}` : 'Nothing else scheduled'}</span>
      </div>
      ${allDay.length || ghostAllDay ? `<div class="tl-allday">
        <span class="tl-allday-label">All day</span>
        <div class="tl-allday-items">${allDay.map((e) => `<span class="tl-chip" style="--blk:${escHtml(e.backgroundColor || '#3b82f6')}">${escHtml(e.summary)}</span>`).join('')}${
          ghostAllDay ? `<span class="tl-chip proposed">${escHtml(ghostAllDay.title)}</span>` : ''}</div>
      </div>` : ''}
      <div class="tl-scroll" id="tlScroll">
        <div class="tl-grid" style="height:${24 * HOUR_PX}px">
          <div class="tl-hours">${hours.join('')}</div>
          <div class="tl-blocks">${blocks.map(blockHtml).join('')}${nowLine}</div>
        </div>
      </div>
    </div>`;
  }

  // The proposal itself, drawn as a ghost block so it reads as "not yet real".
  // Takes normalised fields rather than the proposal, because the same ghost is
  // drawn from the frozen payload when the modal opens and from the live draft
  // on every keystroke after that.
  function proposedBlockFrom(f) {
    if (!f.date) return null;
    // An all-day proposal has no hours to occupy, but it still has to be
    // VISIBLE beside the day it lands in — it used to draw nothing at all, so
    // the pane that exists to answer "what else is on that day" showed no sign
    // of the thing being decided.
    if (f.allDay) return { allDay: true, title: f.title || '(untitled event)', kind: 'proposed' };
    const startMin = toMin(f.startTime);
    if (startMin == null) return null;
    const endMin = toMin(f.endTime);
    return {
      startMin,
      endMin: endMin != null && endMin > startMin ? endMin : startMin + 60,
      title: f.title || '(untitled event)',
      location: f.location,
      kind: 'proposed',
    };
  }

  function toMin(hhmm) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  async function loadDay(date, account) {
    const key = `${date}|${account || ''}`;
    if (ui.dayCache[key]) return ui.dayCache[key];
    const qs = new URLSearchParams({ date });
    if (account) qs.set('account', account);
    const r = await api(`/calendar/day?${qs}`);
    ui.dayCache[key] = r.events || [];
    return ui.dayCache[key];
  }

  // The date tile, lifted out of the calendar card that used to live here. It
  // is the one part the descriptor cannot carry, because it is an affordance
  // rather than content.
  function dateTile(date) {
    if (date) {
      const d = new Date(date + 'T00:00:00');
      if (!isNaN(d)) {
        return `<div class="cal-date">
          <span class="cal-weekday">${escHtml(d.toLocaleDateString([], { weekday: 'short' }))}</span>
          <span class="cal-day">${d.getDate()}</span>
          <span class="cal-month">${escHtml(d.toLocaleDateString([], { month: 'short' }))}</span>
        </div>`;
      }
    }
    return `<div class="cal-date none">📅</div>`;
  }

  // Dashboard-only affordances, wrapped AROUND the shared card rather than
  // baked into a private renderer. A calendar decision needs the rest of that
  // day in view, which only the expanded view can show, so the card is the
  // handle — buttons and the editor live outside it, so nothing is swallowed.
  // The wrapper carries .cal-card so the existing [data-expand] styling, and
  // its suppression in the expanded overlay, apply unchanged.
  function decorate(p, html) {
    const fam = kindFamily(p.kind);
    if (fam !== 'cal-create' && fam !== 'cal-update' && fam !== 'cal-delete') return html;
    const f = calFields(p.payload || {});
    return `<div class="cal-card deco ${fam === 'cal-delete' ? 'cal-del' : ''}" data-expand title="Open with the day's calendar">
      <span class="cal-expand">⤢</span>
      ${dateTile(f.date)}
      <div class="cal-info">${html}</div>
    </div>`;
  }

  // One card definition, every surface: the descriptor is built server-side by
  // src/apps/horst-cards.js and rendered by the same renderer the Mini App
  // uses, so a proposal cannot look like two different things depending on
  // where it is decided.
  function renderPayload(p) {
    let pretty = null;
    if (p.card && window.ProposalCards) {
      try { pretty = window.ProposalCards.renderDescriptorCard(p.card); } catch { pretty = null; }
    }
    // withCards() drops the card if a projector throws, so the frozen payload
    // stays the last resort rather than an empty card.
    if (!pretty) return `<div class="prop-payload"><pre>${escHtml(JSON.stringify(p.payload, null, 2))}</pre></div>`;
    return decorate(p, pretty);
  }

  // The queue's projection of that same descriptor: title, three facts, one
  // line of prose. A list of pending approvals is a list of DECISIONS, not of
  // payloads to read — the full card is one click away, in the modal.
  function renderPreview(p) {
    let pretty = null;
    if (p.card && window.ProposalCards) {
      try { pretty = window.ProposalCards.renderPreviewCard(p.card); } catch { pretty = null; }
    }
    if (!pretty) {
      pretty = `<div class="pc-preview"><div class="pc-icon">•</div><div class="pc-main">
        <div class="pc-title">${escHtml(p.summary || p.kind)}</div></div></div>`;
    }
    // The date tile earns its place in a queue: scanning ten calendar cards is
    // scanning ten dates. It REPLACES the generic icon rather than sitting
    // beside it (see .pc-cal .pc-icon in the stylesheet).
    const fam = kindFamily(p.kind);
    if (fam === 'cal-create' || fam === 'cal-update' || fam === 'cal-delete') {
      return `<div class="pc-cal${fam === 'cal-delete' ? ' cal-del' : ''}">${dateTile(calFields(p.payload || {}).date)}${pretty}</div>`;
    }
    return pretty;
  }

  // --- why ---------------------------------------------------------------
  //
  // Every card answers two questions, and the second one used to be missing:
  // WHAT is being proposed (the descriptor) and WHY Horst thinks it should
  // happen. The reason is the proposal envelope's `detail` — the classifier's
  // read of the mail for a reply draft, the observation behind a todo. When a
  // kind carries none, the provenance is the next best answer.
  function whyText(p) {
    if (p.detail) return p.detail;
    const s = p.source;
    if (s && s.type === 'email') {
      const what = s.subject ? `"${s.subject}"` : `message #${s.uid ?? '?'}`;
      return `Mined from the email ${what}${s.from ? ` — ${s.from}` : ''}`;
    }
    return '';
  }

  function whyLine(p) {
    const t = whyText(p);
    return t ? `<div class="prop-why"><span class="pw-tag">Why</span><span class="pw-text">${escHtml(t)}</span></div>` : '';
  }

  // Which editor a kind gets — NOT whether it may be edited. Every pending
  // proposal is editable (the server re-validates and re-freezes the payload in
  // governance.updateProposal); a kind with no purpose-built editor falls back
  // to the generic one rather than to no button at all.
  function editorKind(kind) {
    const fam = kindFamily(kind);
    if (fam === 'email' || fam === 'reply') return 'email';
    if (fam === 'cal-create' || fam === 'cal-update') return 'calendar';
    return 'generic';
  }

  // Which executed acts offer an undo. This only decides whether to SHOW the
  // button — the server re-derives the inverse and refuses anything else by
  // name. It deliberately never offers one for a sent email: that cannot be
  // recalled, and a button implying otherwise would be a lie.
  function undoable(p) {
    return kindFamily(p.kind) === 'cal-create' && !!(p.result && p.result.eventId);
  }

  // The signature switch, rendered only for a composed reply that actually has
  // a signature to include. It carries the FLAG, never a body: the server's
  // compose hook re-stitches both MIME parts from the payload's own sources, so
  // no surface can freeze a body that disagrees with the flag it just set.
  //
  // It lives in the composer's footer strip and edits the draft like any other
  // field — it used to sit in the list action row and POST on its own, which
  // meant flipping it while an edit was open raced that edit's Save.
  function sigToggle(p) {
    const pl = (p && p.payload) || {};
    if (typeof pl.replyText !== 'string') return '';
    if (!pl.signatureText && !pl.signatureHtml) return '';
    return `<label class="me-check" title="Include your reply signature. The quoted trail is unaffected; both the plain-text and HTML parts are rebuilt on the server.">
      <input type="checkbox" data-f="includeSignature" ${pl.includeSignature ? 'checked' : ''}> Signature
    </label>`;
  }

  // --- editors (email + calendar) ---

  // The quoted trail, below the draft, exactly where a mail client puts it —
  // and READ-ONLY, because it is frozen provenance: the server re-stitches both
  // MIME parts from these sources at freeze time, so a hand-edited quote would
  // be silently overwritten. Open by default: "the original message below" is
  // the point, not a disclosure to go hunting for.
  function quoteBlock(pl) {
    const text = String(pl.quotedText || '');
    if (!text) return '';
    return `<div class="mc-quote">
      <button class="mc-qtoggle open" data-quote type="button"><span class="arrow">▶</span> ${escHtml(pl.quoteAttribution || 'The message you are replying to')}</button>
      <div class="mc-qbody">
        ${window.ProposalCards.renderBody(text)}
        ${pl.quoteDerived ? '<div class="mail-ref">Rendered from the sender’s HTML — they sent no plain-text part, so this is our rendering rather than their words verbatim.</div>' : ''}
        ${pl.quoteTrimmed ? '<div class="mail-ref">Trail trimmed to fit.</div>' : ''}
      </div>
    </div>`;
  }

  // A composing surface rather than a form. The draft sits at the top of one
  // continuous sheet with the quoted original beneath it — the shape the
  // payload already has (replyText + quotedText), and the shape the reader
  // expects from every mail client they have ever used.
  //
  // What is editable is deliberately narrow: `replyText` for a composed reply
  // (never `body`/`htmlBody` — email.send's validate refuses a payload that
  // disagrees with its own sources), plus Cc/Bcc, attachments and the
  // signature flag. A reply's To and Subject are derived by the executor from
  // the parent message, so they are shown and not offered.
  function emailEditor(d, p, { reply } = {}) {
    const pl = (p && p.payload) || {};
    const fixed = (label, val, hint) => `<div class="mc-row"><span class="mc-label">${label}</span>
      <span class="mc-fixed">${escHtml(val || '')}${hint ? `<i>${escHtml(hint)}</i>` : ''}</span></div>`;
    const input = (label, key, val, ph) => `<div class="mc-row"><span class="mc-label">${label}</span>
      <input class="mc-input" data-f="${key}" value="${escHtml(val || '')}" placeholder="${escHtml(ph || '')}"></div>`;
    const ccOpen = !!(d.cc || d.bcc);
    return `<div class="prop-editor mail-composer">
      <div class="mc-head">
        ${d.account ? fixed('From', d.account) : ''}
        ${reply ? fixed('To', d.to, d.to ? '' : 'the original sender') : input('To', 'to', d.to, 'name@example.org')}
        <div class="mc-cc"${ccOpen ? '' : ' style="display:none"'}>
          ${input('Cc', 'cc', d.cc, '')}${input('Bcc', 'bcc', d.bcc, '')}
        </div>
        ${reply ? fixed('Subject', d.subject, d.subject ? '' : 'kept from the original') : input('Subject', 'subject', d.subject, '')}
        ${ccOpen ? '' : '<button class="mc-cctoggle" data-cc type="button">Cc / Bcc</button>'}
      </div>
      <div class="mc-sheet">
        <textarea class="mc-body" data-f="body" spellcheck="true" placeholder="Write your reply…">${escHtml(d.body || '')}</textarea>
        ${quoteBlock(pl)}
      </div>
      <div class="mc-foot">
        <div class="me-atts" data-atts>
          ${attChips(d.attachments || [], { editable: true })}
          <button class="hbtn me-attadd" data-att-add type="button">📎 Attach</button>
          <input type="file" multiple style="display:none" data-att-input>
        </div>
        ${sigToggle(p)}
      </div>
      <div class="mc-hint">Drop files anywhere in the composer, or paste an image straight into the message.</div>
      <div class="mc-drop"><span>Drop to attach</span></div>
    </div>`;
  }

  function calendarEditor(d, { multiDay } = {}) {
    return `<div class="prop-editor">
      <div class="me-grid">
        <label class="me-label">Title</label><input class="me-input" data-f="title" value="${escHtml(d.title)}">
        <label class="me-label">Date</label>
        <div class="me-inline">
          <input class="me-input" type="date" data-f="date" value="${escHtml(d.date)}">
          ${multiDay ? `<span class="me-dash">–</span>
          <input class="me-input" type="date" data-f="endDate" value="${escHtml(d.endDate || '')}" title="End date — leave empty for a single-day event">` : ''}
          <label class="me-check"><input type="checkbox" data-f="allDay" ${d.allDay ? 'checked' : ''}> All day</label>
        </div>
        <label class="me-label me-timerow" ${d.allDay ? 'style="display:none"' : ''}>Time</label>
        <div class="me-inline me-timerow" ${d.allDay ? 'style="display:none"' : ''}>
          <input class="me-input" type="time" data-f="startTime" value="${escHtml(d.startTime)}">
          <span class="me-dash">–</span>
          <input class="me-input" type="time" data-f="endTime" value="${escHtml(d.endTime)}">
        </div>
        <label class="me-label">Location</label><input class="me-input" data-f="location" value="${escHtml(d.location)}">
        <label class="me-label">Guests</label><input class="me-input" data-f="attendees" value="${escHtml((d.attendees || []).join(', '))}" placeholder="email, email, …">
      </div>
      <textarea class="me-body short" data-f="description" placeholder="Description">${escHtml(d.description || '')}</textarea>
    </div>`;
  }

  // Everything else: one row per payload key, typed by what is in it. Not
  // pretty, but a frozen payload you cannot correct is a payload you have to
  // deny and re-ask for — and the Mini App has offered this for every kind for
  // a while now.
  const LONG_KEYS = ['body', 'notes', 'text', 'description', 'prompt'];

  // Keys the platform stores as an ISO timestamp — the `…At` convention, and
  // only that. A free-text box for one of these is a trap: it looks optional,
  // and anything typed into it that is not ISO is refused by the kind long
  // after the typing. Deliberately NOT `date`, which elsewhere means a
  // date-only string that a datetime picker would silently give a time to.
  const DATE_KEY = /[a-z]At$/;

  // An `<input type="datetime-local">` speaks local wall-clock, the payload
  // speaks ISO. Both directions live here so they cannot drift.
  function isoToLocalInput(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // `dueAt` → "Due", `threadId` → "Thread id": the payload's keys are the
  // executor's, the labels above the boxes are the reader's.
  function humanKey(k) {
    const w = String(k).replace(/At$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ').trim().toLowerCase();
    return w ? w[0].toUpperCase() + w.slice(1) : k;
  }

  function genericEditor(payload) {
    const rows = Object.keys(payload || {}).map((k) => {
      const v = payload[k];
      const label = `<label class="me-label">${escHtml(humanKey(k))}${v && typeof v === 'object' ? ' (JSON)' : ''}</label>`;
      if (v && typeof v === 'object') {
        return `${label}<textarea class="me-body short" data-f="${escHtml(k)}" data-json="1">${escHtml(JSON.stringify(v, null, 2))}</textarea>`;
      }
      if (typeof v === 'boolean') {
        return `${label}<select class="me-input" data-f="${escHtml(k)}" data-bool="1">
          <option value="true"${v ? ' selected' : ''}>Yes</option>
          <option value="false"${v ? '' : ' selected'}>No</option></select>`;
      }
      // A field that arrived null must come back null. Read as a plain string it
      // comes back "", and `todo.create.validate` — which allows a missing dueAt
      // but not an unparseable one — then refuses a payload nobody edited.
      const wasNull = v == null ? ' data-null="1"' : '';
      const s = v == null ? '' : String(v);
      if (DATE_KEY.test(k) && typeof v !== 'number') {
        return `${label}<input class="me-input" type="datetime-local" data-f="${escHtml(k)}" data-dt="1"${wasNull} value="${escHtml(isoToLocalInput(s))}">`;
      }
      if (s.length > 80 || LONG_KEYS.includes(k)) {
        return `${label}<textarea class="me-body short" data-f="${escHtml(k)}"${wasNull}>${escHtml(s)}</textarea>`;
      }
      // A number edited through a text box would come back as a string and
      // quietly change the payload's shape — keep the type it arrived with.
      const num = typeof v === 'number' ? ' type="number" data-num="1"' : '';
      return `${label}<input class="me-input" data-f="${escHtml(k)}"${num}${wasNull} value="${escHtml(s)}">`;
    }).join('');
    return `<div class="prop-editor">
      <div class="me-rows">${rows || '<span class="me-note">This proposal carries no payload fields to edit.</span>'}</div>
    </div>`;
  }

  // Reads a generic editor back out. Throws on invalid JSON — the caller turns
  // that into a note beside the Save button rather than a console error.
  function collectGenericEdits(root) {
    const out = {};
    root.querySelectorAll('.me-rows [data-f]').forEach((f) => {
      const key = f.getAttribute('data-f');
      if (f.getAttribute('data-bool')) out[key] = f.value === 'true';
      else if (f.getAttribute('data-json')) out[key] = JSON.parse(f.value);
      else if (f.getAttribute('data-num')) out[key] = f.value === '' ? null : Number(f.value);
      else if (f.getAttribute('data-dt')) out[key] = f.value ? new Date(f.value).toISOString() : null;
      // Empty means "no value" for a field that had none — see data-null above.
      else out[key] = f.value === '' && f.getAttribute('data-null') ? null : f.value;
    });
    return out;
  }

  // The queue row. What + why + a way to make it go away — the decision itself
  // happens in the modal, where there is room to read the thing first.
  //
  // Head, preview and the why-line share ONE [data-expand] wrapper so the whole
  // row is the handle; the dismiss button sits outside it, or clicking "get rid
  // of this" would also open it.
  // Kinds in the reader's words. `todo.create` and `calendar.create` are the
  // machine's names; the raw kind survives as the tooltip for whoever greps.
  const KIND_WORDS = {
    'todo.create': 'New todo', 'mission.create': 'Mission',
    'app.restart': 'App restart', 'email.rule.add': 'Mail rule', 'email.sync.reconnect': 'Mail reconnect',
    'app.publish': 'Publish', 'app.rollback': 'Rollback', 'peer.pair': 'Pairing', 'server.restart': 'Server restart',
    'peer.keys.sync': 'Key sync', 'peer.restart': 'Peer restart',
  };
  const FAM_WORDS = {
    reply: 'Reply', 'cal-create': 'New event', 'cal-update': 'Event change', 'cal-delete': 'Delete event',
    telegram: 'Telegram message', 'email-modify': 'Mailbox change',
  };

  function kindWords(p) {
    const kind = String(p.kind || '');
    const app = kind.includes(':') ? kind.slice(0, kind.indexOf(':')) : '';
    const base = app ? kind.slice(app.length + 1) : kind;
    const fam = kindFamily(kind);
    const pl = p.payload || {};
    let w;
    if (fam === 'email') w = pl.inReplyTo || pl.quotedText ? 'Reply' : 'Email';
    else w = FAM_WORDS[fam] || KIND_WORDS[base] || base.replace(/[._]/g, ' ');
    return app ? `${w} · ${app}` : w;
  }

  function originWords(p) {
    if (p.source && p.source.type === 'email') return 'from an email';
    return { triage: 'from mail triage', chat: 'from chat', app: 'from an app', peer: 'from a paired machine' }[p.origin] || p.origin || '';
  }

  // A card is a DECISION, not a payload to read: one title, one line saying
  // what kind of thing it is and where it came from, the three facts that
  // matter, and the three doors — pressable right here. Everything else is
  // one click away in the modal, which is the same card with room to edit.
  function proposalCard(p) {
    const pending = p.status === 'pending';
    const c = p.card || null;
    const fam = kindFamily(p.kind);
    const cal = fam === 'cal-create' || fam === 'cal-update' || fam === 'cal-delete';
    const title = (c && c.title) || p.summary || p.kind;
    const icon = cal
      ? dateTile(calFields(p.payload || {}).date)
      : `<span class="pi-icon${c && c.accent ? ' ' + escHtml(c.accent) : ''}">${escHtml((c && c.icon) || '•')}</span>`;
    const origin = originWords(p);
    let body = '';
    if (c && window.ProposalCards) {
      // Some projectors put the kind in the subtitle; the meta line already
      // says it in words, so the raw name would be the same fact twice.
      const shown = c.subtitle === p.kind ? { ...c, subtitle: '' } : c;
      try { body = window.ProposalCards.renderPreviewCard(shown, { bare: true, chars: 320 }); } catch { body = ''; }
    }
    const stale = pending && isStale(p);
    return `<div class="prop-item ${p.status}${pending ? '' : ' hist'}${stale ? ' stale' : ''}${cal ? ' cal' : ''}" data-id="${escHtml(p.id)}" data-kind="${escHtml(p.kind)}">
      <div class="pi-open" data-expand title="Open to read everything, edit, and decide">
        <div class="pi-head">
          ${icon}
          <div class="pi-titles">
            <div class="pi-title">${escHtml(title)}</div>
            <div class="pi-meta">
              <span class="pi-kind" title="${escHtml(p.kind)}">${escHtml(kindWords(p))}</span>
              ${origin ? `<span>${escHtml(origin)}</span>` : ''}
              <span>${escHtml(fmtTime(p.decidedAt || p.createdAt))}</span>
              ${p.editedAt ? '<span class="pi-edited">edited</span>' : ''}
              ${p.convertedAt ? '<span class="pi-edited">converted</span>' : ''}
            </div>
          </div>
          ${pending
            ? `<span class="pi-age${stale ? ' stale' : ''}" title="Waiting since ${escHtml(fmtTime(p.createdAt))}">⏳ ${escHtml(ageLabel(ageOf(p)))}</span>`
            : stateFlow(p)}
          <span class="pi-more" aria-hidden="true">Open ↗</span>
        </div>
        ${priorBanner(p)}
        ${body}
        ${p.detail ? `<div class="prop-why"><span class="pw-tag">Why</span><span class="pw-text">${escHtml(p.detail)}</span></div>` : ''}
      </div>
      ${p.error ? `<div class="prop-error">${escHtml(p.error)}</div>` : ''}
      ${p.result && p.result.summary ? `<div class="prop-result">${escHtml(p.result.summary)}</div>` : ''}
      ${cardFlow(p)}
    </div>`;
  }


  // --- the modal's two halves -------------------------------------------------

  // Everything that is not the act itself: why Horst wants it, what his memory
  // knows about it, where it came from, whether the world says it is already
  // done, and what an earlier edit changed. It sits ABOVE the editor and
  // outside it — reasoning is not a payload field.
  //
  // Deliberately NOT here any more:
  //   • brainBanner — memory recall is keyword-matched, not relevance-ranked,
  //     so a permission request came with "npm_token_publish status deleted"
  //     under a heading that claimed it was the reasoning. Three unrelated
  //     facts under "why" are worse than no facts: they read as Horst's
  //     justification, and they are not.
  //   • sourceBanner — it said "From the email message #122" directly beneath
  //     a `why` line that had already fallen back to the same sentence, and
  //     its ⤢ affordance was dead inside the modal (see wirePropScope). The
  //     message it names is loaded in full further down the same sheet.
  function whyPane(p) {
    const why = p.detail ? `<div class="pow-text">${escHtml(p.detail)}</div>` : '';
    const inner = why + priorBanner(p) + diffBlock(p);
    // Say the reason is missing rather than manufacturing one out of the
    // provenance. A card whose reason is "it came from an email" has no reason.
    if (!inner) {
      return `<div class="po-why thin"><div class="pow-head">Why Horst is proposing this</div>
        <div class="pow-text dim">Horst recorded no reason for this one${p.source && p.source.type === 'email' ? ' — he mined it from the email shown below' : ''}.</div></div>`;
    }
    return `<div class="po-why"><div class="pow-head">Why Horst is proposing this</div>${inner}</div>`;
  }

  // The act, as something you can change. A pending proposal opens straight
  // into its editor — the modal exists to decide in, and "click Edit first" was
  // a step that taught nobody anything.
  function editorPane(p) {
    if (ui.propEdit !== p.id) return renderPayload(p);
    const which = editorKind(p.kind);
    if (which === 'email') return emailEditor(ui.propDraft, p, { reply: kindFamily(p.kind) === 'reply' });
    // multi-day (end date) only where the executor supports endDate: app kinds
    // (my-dashboard builder) always; the platform engine only for all-day.
    if (which === 'calendar') return calendarEditor(ui.propDraft, { multiDay: p.kind.includes(':') || ui.propDraft.allDay });
    return genericEditor(ui.propDraft);
  }

  // --- what approving actually does -----------------------------------------
  //
  // "Approve & execute" is the same four words above a mail that leaves the
  // building and a todo that appears in a list. Nobody could tell from the
  // button which one they were pressing, and for `email.send` the difference
  // is a message in someone else's inbox that cannot be recalled.
  //
  // So every kind names its own act: the button says the verb, and the flow
  // diagram beside it says where each of the three doors leads. Written per
  // kind rather than derived from the kind's `label`, because the consequence
  // ("leaves your mailbox immediately") is not something a label can carry.
  function clip(s, n) {
    const t = String(s || '');
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  }

  function shortAddr(v) {
    const m = /<([^>]+)>/.exec(String(v || ''));
    const bare = String(v || '').replace(/<[^>]*>/, '').replace(/"/g, '').trim();
    return bare || (m && m[1]) || String(v || '');
  }

  function actOf(p) {
    const pl = p.payload || {};
    const fam = kindFamily(p.kind);
    const base = String(p.kind || '').includes(':') ? p.kind.slice(p.kind.indexOf(':') + 1) : p.kind;
    if (fam === 'email' || fam === 'reply') {
      const who = shortAddr(pl.to) || 'the recipient';
      return {
        does: `Sends this email from ${pl.account || 'your account'} to ${who}.`,
        button: '✓ Send it now',
        outcome: `Delivered to ${clip(who, 26)} — cannot be recalled`,
        past: `sent to ${clip(who, 22)}`,
        irreversible: true,
      };
    }
    if (fam === 'cal-create') {
      return { does: `Creates this event in ${pl.calendarName || 'your calendar'}.`, button: '✓ Add to the calendar', outcome: `In ${pl.calendarName || 'your calendar'} — you can still delete it`, past: 'added to your calendar' };
    }
    if (fam === 'cal-update') return { does: 'Changes the existing calendar entry.', button: '✓ Update the event', outcome: 'The entry changes — guests may be notified', past: 'the event was updated' };
    if (fam === 'cal-delete') return { does: 'Removes the event from your calendar.', button: '✓ Delete the event', outcome: 'Removed from your calendar', past: 'the event was deleted', irreversible: true };
    if (fam === 'telegram') return { does: 'Sends this message on Telegram.', button: '✓ Send the message', outcome: 'Delivered — cannot be recalled', past: 'sent on Telegram', irreversible: true };
    if (fam === 'email-modify') return { does: 'Changes flags or folders on mail already in your mailbox.', button: '✓ Apply to the mailbox', outcome: 'Your mailbox changes', past: 'applied to your mailbox' };
    if (base === 'todo.create') return { does: 'Adds a task to your todo list. Nothing is sent to anyone.', button: '✓ Create the todo', outcome: 'On your todo list — nobody is contacted', past: 'on your todo list' };
    if (base === 'mission.create') return { does: 'Gives Horst a standing mission to work on.', button: '✓ Start the mission', outcome: 'Horst starts working on it', past: 'Horst is working on it' };
    if (base === 'app.restart') return { does: 'Restarts the app.', button: '✓ Restart it', outcome: 'The app goes down and comes back', past: 'the app was restarted' };
    if (base === 'email.rule.add') return { does: 'Adds a standing rule to your mail triage. No mail is sent.', button: '✓ Add the rule', outcome: 'Applies to mail from now on — you can remove it later', past: 'the rule was added' };
    if (base === 'email.sync.reconnect') return { does: 'Reconnects the mail account.', button: '✓ Reconnect', outcome: 'The account syncs again', past: 'the account reconnected' };
    if (base === 'app.publish') return { does: 'Publishes this app to the paired machine.', button: '✓ Publish it', outcome: 'Live on the slave — you can roll back', past: 'published' };
    if (base === 'app.rollback') return { does: 'Puts the previous bundle back on the paired machine.', button: '✓ Roll it back', outcome: 'The earlier version is live again', past: 'rolled back' };
    if (base === 'peer.pair') return { does: 'Pairs this machine with the one that asked.', button: '✓ Pair them', outcome: 'That machine joins your fleet', past: 'the machines are paired' };
    if (base === 'server.restart') return { does: 'Restarts the dashboard itself.', button: '✓ Restart the server', outcome: 'Everything goes down and comes back', past: 'the server was restarted', irreversible: true };
    return { does: 'Runs this action.', button: '✓ Approve &amp; run', outcome: 'The action runs', past: 'it ran' };
  }

  // --- the flow, drawn once and reused at two sizes ---------------------------
  //
  // A decision surface should not require the reader to already know the
  // vocabulary: "deny" and "withdraw" differ in whether a ledger row is
  // written, which is invisible in the words themselves. So the three doors are
  // drawn, and — the part that was missing — the BUTTONS ARE THE NODES. A
  // picture beside a button row is two objects the reader has to correlate;
  // a picture the buttons sit inside is one object.
  //
  // Only the wires are SVG. The nodes stay real <button>s on top of them, so
  // they keep their focus ring, hover, tooltip and keyboard behaviour — a
  // <foreignObject> or an SVG-drawn "button" would give up all four.
  //
  // The geometry is fixed and 1:1 with the rendered size (no CSS downscaling,
  // which is how a diagram meant to explain something becomes decoration).
  // Two sizes of the SAME picture: `full` in the modal's decision bar, `compact`
  // on every waiting card in the queue — so a card can be decided without
  // opening anything, and the modal is the card's diagram with more room.
  //
  // The metrics are the single source of truth: the SVG paths AND the inline
  // sizes of the button rows are computed from them here, so nothing in the
  // stylesheet can drift away from the wires.
  const FLOW = {
    full:    { row: 34, pitch: 40, pill: 62, pillH: 28, trunk: 13, btnW: 190, exit: 18, font: 12 },
    compact: { row: 28, pitch: 33, pill: 52, pillH: 24, trunk: 11, btnW: 166, exit: 14, font: 11.5 },
  };

  function flowMetric(size) {
    const m = FLOW[size] || FLOW.full;
    const fanX = 1 + m.pill + m.trunk;   // where the branches leave the trunk
    const btnX = fanX + 14;              // 8px of branch, then a 6px arrowhead
    const btnEnd = btnX + m.btnW;
    const textX = btnEnd + m.exit + 8;   // exit line, 7px arrowhead, 1px of air
    return { ...m, fanX, btnX, btnEnd, textX, height: (n) => n * m.pitch - (m.pitch - m.row) };
  }

  function flowWires(state, rows, m) {
    const h = m.height(rows.length);
    const mid = h / 2;
    const cy = (i) => i * m.pitch + m.row / 2;
    const arm = (r, i) => {
      const y = cy(i);
      // Straight through when the branch is level with the trunk; the vertical
      // segment would otherwise render as a zero-length kink.
      const bend = Math.abs(y - mid) < 0.5 ? `M${m.fanX} ${mid} H${m.fanX + 8}` : `M${m.fanX} ${mid} V${y} H${m.fanX + 8}`;
      return `<path class="fl-line ${r.cls}" d="${bend}"/>
        <path class="fl-head ${r.cls}" d="M${m.fanX + 8} ${y - 4} L${m.btnX} ${y} L${m.fanX + 8} ${y + 4} Z"/>
        <path class="fl-line ${r.cls}" d="M${m.btnEnd} ${y} H${m.textX - 8}"/>
        <path class="fl-head ${r.cls}" d="M${m.textX - 8} ${y - 4} L${m.textX - 1} ${y} L${m.textX - 8} ${y + 4} Z"/>`;
    };
    return `<svg class="pf-wires" width="${m.textX}" height="${h}" viewBox="0 0 ${m.textX} ${h}" aria-hidden="true" focusable="false">
      <rect class="fl-box" x="1" y="${mid - m.pillH / 2}" width="${m.pill}" height="${m.pillH}" rx="8"/>
      <text class="fl-now" x="${1 + m.pill / 2}" y="${mid + 4}" text-anchor="middle">${escHtml(state)}</text>
      <path class="fl-line off" d="M${1 + m.pill} ${mid} H${m.fanX}"/>
      ${rows.map(arm).join('')}
    </svg>`;
  }

  // rows: [{ cls, button, outcome, danger, attrs, title, primary }]
  // `extra` is the line under the diagram (Save changes, the create⇄update
  // switch, the refusal note); null means no such line at all.
  function flowBlock(state, rows, size, extra) {
    const m = flowMetric(size);
    const body = rows.map((r) => `<div class="pf-row ${r.cls}" style="height:${m.row}px">
      <button class="hbtn pf-btn${r.primary ? ' primary' : ''}${r.cls === 'no' ? ' danger' : ''}" ${r.attrs}
        style="flex-basis:${m.btnW}px;height:${m.row}px;font-size:${m.font}px" title="${escHtml(r.title)}">${r.button}</button>
      <span class="pf-out${r.danger ? ' danger' : ''}" style="margin-left:${m.textX - m.btnEnd}px" title="${escHtml(r.outcome)}">${escHtml(r.outcome)}</span>
    </div>`).join('');
    return `<div class="po-flow ${size}" role="group" aria-label="What happens next">
      ${flowWires(state, rows, m)}
      <div class="pf-rows" style="height:${m.height(rows.length)}px;margin-left:${m.btnX}px;gap:${m.pitch - m.row}px">${body}</div>
    </div>${extra == null ? '' : `<div class="pf-extra">${extra}<span class="me-note" data-edit-note></span></div>`}`;
  }

  // The doors this proposal has, as rows of the flow — the same rows on the
  // card and in the modal, so the two surfaces can never disagree about what
  // a button does. Null when there is nothing left to press.
  // preview: the compact card. A fullViewApprove proposal is approved only from
  // the full card (the server refuses a preview's plain 'ui'), so the preview's
  // first door opens it instead.
  function decisionRows(p, { preview = false } = {}) {
    if (p.status === 'executed' && undoable(p)) {
      return { state: 'done', rows: [{
        cls: 'go', attrs: 'data-undo', button: '↶ Undo it',
        outcome: 'Stages the reverse act — nothing is undone until you approve that too',
        title: 'Stages the reverse act as a new proposal. It is not undone until you approve that one too.',
      }] };
    }
    if (p.status !== 'pending') return null;
    // An action the world says is already done should not have the eye-catching
    // button: the quiet path is the safe one, and "anyway" says what approving
    // now actually means.
    const already = p.prior && p.prior.state === 'done';
    const act = actOf(p);
    return { state: 'waiting', rows: [
      preview && p.fullViewApprove ? {
        cls: 'go', primary: true, attrs: 'data-expand', button: '⤢ Open to approve',
        outcome: 'Approved only on its full card, where all of it is shown',
        title: 'Open the full card: this kind is approved only where its whole payload is on screen.',
      } : {
        // The payload version this render shows; the server refuses an
        // approve of any other (an edit landed since).
        cls: 'go', primary: !already, attrs: `data-decide="approve" data-version="${escHtml(p.version || '')}"`,
        button: already ? '✓ Do it anyway' : act.button,
        outcome: already ? `Happens a second time — ${act.outcome}` : act.outcome,
        danger: act.irreversible, title: act.does,
      },
      {
        cls: 'no', attrs: 'data-decide="deny"', button: '✗ Deny',
        outcome: 'Recorded as a no — Horst proposes fewer like it',
        title: 'Say no. The act does not happen and the decision is recorded, so Horst proposes fewer like it.',
      },
      {
        cls: 'off', attrs: 'data-withdraw', button: '↩ Withdraw',
        outcome: 'The card goes away — no record, it may come back',
        title: 'Not relevant. The card disappears with no ledger row, so it never reads as a rejection, and the same act can be proposed again.',
      },
    ] };
  }

  // The modal's decision bar: the flow at full size, plus the line for edits.
  function decisionBar(p) {
    const d = decisionRows(p);
    if (!d) return ''; // a decided card has nothing to press
    const extra = d.state === 'waiting'
      ? `${ui.propEdit === p.id ? '<button class="hbtn" data-edit-save title="Keep your edits on the proposal without deciding — it stays in the queue.">Save changes</button>' : ''}${priorAltActions(p)}`
      : '';
    return `<div class="po-foot" data-id="${escHtml(p.id)}" data-kind="${escHtml(p.kind)}">${flowBlock(d.state, d.rows, 'full', extra)}</div>`;
  }

  // The card's: the same flow, compact, no edit line — editing is what the
  // modal is for. Approving here sends the payload exactly as it was frozen.
  function cardFlow(p) {
    const d = decisionRows(p, { preview: true });
    return d ? `<div class="pi-flow">${flowBlock(d.state, d.rows, 'compact', null)}</div>` : '';
  }


  // --- the same picture, chip-sized ------------------------------------------
  //
  // The status words (`pending`, `executed`, `withdrawn`, `expired`) are the
  // machine's vocabulary, not the reader's. This is the modal's diagram with
  // the pill and the labels stripped: the arm the card took is lit, the two it
  // did not are still drawn, faint. The shape says "there were three doors",
  // the lit arm says which one — and the reader has already met the full-size
  // version inside the modal, so it needs no legend of its own.
  const MINI_Y = { go: 4, no: 13, off: 22 };

  // `arm` is the branch this card took, or null while it is still waiting.
  function miniFan(arm, cls) {
    const limb = (k) => {
      const y = MINI_Y[k];
      const lit = arm === k;
      const c = lit ? cls : 'off dim';
      const bend = k === 'no' ? 'M9 13 H24' : `M9 13 V${y} H24`;
      return `<path class="fl-line ${c}" d="${bend}"/><path class="fl-head ${c}" d="M24 ${y - 3} L30 ${y} L24 ${y + 3} Z"/>`;
    };
    return `<svg class="pf-fan" width="32" height="26" viewBox="0 0 32 26" aria-hidden="true" focusable="false">
      <path class="fl-line off${arm ? ' dim' : ''}" d="M1 13 H9"/>
      ${limb('go')}${limb('no')}${limb('off')}
    </svg>`;
  }

  const STATE_MARK = {
    pending: [null, '', 'waiting for you'],
    approved: ['go', 'go dashed', 'approved — running now'],
    executed: ['go', 'go', null],           // null → actOf(p).past, per kind
    failed: ['go', 'no', 'tried, and it failed'],
    denied: ['no', 'no', 'you said no'],
    withdrawn: ['off', 'off', 'folded away'],
    expired: ['off', 'off', 'expired unanswered'],
  };

  function stateFlow(p) {
    const [arm, cls, label] = STATE_MARK[p.status] || [null, '', p.status];
    const words = label == null ? actOf(p).past : label;
    return `<span class="pf-mini ${p.status}" title="${escHtml(`${p.status} — ${words}`)}">
      ${miniFan(arm, cls)}<i>${escHtml(words)}</i></span>`;
  }

  // Per-file/total limits keep the JSON body under the server's parser cap
  // (base64 inflates by ~4/3).
  const ATT_FILE_MAX = 8 * 1024 * 1024;
  const ATT_TOTAL_MAX = 18 * 1024 * 1024;

  function startPropEdit(p) {
    ui.propEdit = p.id;
    const pl = p.payload || {};
    const which = editorKind(p.kind);
    if (which === 'email') {
      // A composed reply's editable source is replyText — the model's words,
      // without the quoted trail or the signature. Editing the stitched `body`
      // would mean editing the quote too, and the server would overwrite it on
      // the next compose anyway.
      const composed = typeof pl.replyText === 'string';
      ui.propDraft = {
        account: pl.account || '',
        to: pl.to || '', cc: pl.cc || '', bcc: pl.bcc || '',
        subject: pl.subject || '', body: (composed ? pl.replyText : pl.body) || '',
        composed,
        includeSignature: !!pl.includeSignature,
        attachments: Array.isArray(pl.attachments) ? pl.attachments.map((a) => ({ ...a })) : [],
      };
    } else if (which === 'calendar') {
      ui.propDraft = calFields(pl);
    } else {
      // The generic editor reads itself back out of the DOM on save, so the
      // draft is only the shape it renders from.
      ui.propDraft = { ...pl };
    }
    // The baseline for "are there unsaved changes?". The generic editor re-seeds
    // it in wireEditor once its inputs exist, because the DOM — not this object
    // — is where its edits live.
    ui.propDraftSeed = JSON.stringify(ui.propDraft);
  }

  // Closing the modal now discards an editor that opened itself, so it has to
  // ask first. Deliberately compares the draft against its own seed rather than
  // against the payload: buildEditedPayload normalises keys, so an untouched
  // calendar draft would otherwise always look changed.
  function draftDirty(p, root) {
    if (!p || ui.propEdit !== p.id || !ui.propDraft) return false;
    if (editorKind(p.kind) === 'generic') {
      if (!root) return false;
      try { return JSON.stringify(collectGenericEdits(root)) !== ui.propDraftSeed; } catch { return true; }
    }
    return JSON.stringify(ui.propDraft) !== ui.propDraftSeed;
  }

  function buildEditedPayload(p) {
    const orig = p.payload || {};
    const d = ui.propDraft;
    const fam = kindFamily(p.kind);
    if (fam === 'email' || fam === 'reply') {
      const out = { ...orig, cc: d.cc.trim(), bcc: d.bcc.trim(), body: d.body };
      // Reply payloads carry no to/subject — the executor derives both from the
      // original message; don't introduce the keys.
      if (fam === 'email') { out.to = d.to.trim(); out.subject = d.subject; }
      out.attachments = d.attachments.length ? d.attachments : undefined;
      if (d.composed) {
        // The server's compose hook re-stitches body and htmlBody from these
        // sources at freeze time, so both parts stay in step with the edit —
        // the flag included, which is why the signature switch may travel in
        // the same save rather than needing a POST of its own.
        out.replyText = d.body;
        if (orig.signatureText || orig.signatureHtml) out.includeSignature = !!d.includeSignature;
      } else if (orig.htmlBody && d.body !== orig.body) {
        // Hand-composed mail has no sources to re-stitch from: a stale
        // pre-rendered HTML alternative would silently win over the edited
        // plain text in most mail clients, so drop it once the body changed.
        delete out.htmlBody;
      }
      if (!out.cc) delete out.cc;
      if (!out.bcc) delete out.bcc;
      if (!out.attachments) delete out.attachments;
      return out;
    }
    // Calendar create/update — rewrite to the simple field shape both executors
    // understand; drop shape variants they would otherwise prefer (event/start/end).
    const out = { ...orig };
    delete out.event; delete out.start; delete out.end; delete out.summary; delete out.endDate;
    out.title = d.title.trim();
    out.location = d.location.trim() || undefined;
    out.description = d.description.trim() || undefined;
    const guests = d.attendees;
    out.attendees = guests.length ? guests : undefined;
    out.date = d.date;
    // Multi-day span: app executors accept endDate for any event; the platform
    // engine only honours it for all-day events.
    if (d.endDate && d.endDate !== d.date && (p.kind.includes(':') || d.allDay)) out.endDate = d.endDate;
    if (d.allDay) {
      out.allDay = true;
      delete out.startTime; delete out.endTime;
    } else {
      delete out.allDay;
      out.startTime = d.startTime;
      out.endTime = d.endTime || d.startTime;
    }
    for (const k of Object.keys(out)) { if (out[k] === undefined) delete out[k]; }
    return out;
  }

  // Reading files into the draft, from whichever gesture produced them: the
  // Attach button, a drop anywhere on the composer, or a paste. One function,
  // so the size guards and the base64 conversion cannot drift between the three.
  function addAttachmentFiles(files, { refresh, say }) {
    for (const file of files) {
      if (file.size > ATT_FILE_MAX) { say(`"${file.name || 'that file'}" is too large (max ${fmtSize(ATT_FILE_MAX)})`, true); continue; }
      const total = ui.propDraft.attachments.reduce((s, a) => s + attSize(a), 0);
      if (total + file.size > ATT_TOTAL_MAX) { say(`Attachments exceed ${fmtSize(ATT_TOTAL_MAX)} total`, true); break; }
      // A pasted screenshot arrives as a File with an empty name; without one
      // the chip, the MIME part and the recipient's download all read
      // "attachment".
      const name = file.name || `pasted-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${(file.type.split('/')[1] || 'bin')}`;
      const reader = new FileReader();
      reader.onload = () => {
        const base64Data = String(reader.result).split(',')[1] || '';
        ui.propDraft.attachments.push({ filename: name, contentType: file.type || 'application/octet-stream', base64Data, size: file.size });
        refresh();
      };
      reader.onerror = () => say(`Could not read "${name}"`, true);
      reader.readAsDataURL(file);
    }
  }

  // Save the open editor. Extracted from the Save button because Approve has to
  // run it first: pressing "Approve & execute" on a draft you just rewrote must
  // send what is on the screen, not the payload that was frozen before you
  // touched it. Returns false with a note beside the buttons on refusal.
  async function commitEdit(root, p) {
    const note = root.querySelector('[data-edit-note]');
    const say = (msg, bad) => { if (note) { note.textContent = msg; note.classList.toggle('bad', !!bad); } };
    const which = editorKind(p.kind);
    const d = ui.propDraft;
    const fam = kindFamily(p.kind);
    let payload;
    if (which === 'generic') {
      // No field validation here: the generic editor knows nothing about the
      // kind, and governance.updateProposal re-validates and re-freezes what it
      // is handed. Only malformed JSON is ours to catch.
      try { payload = collectGenericEdits(root); }
      catch { say('One of the JSON fields is not valid JSON', true); return false; }
    } else {
      if (fam === 'email') {
        if (!d.to.trim()) { say('Recipient (To) is required', true); return false; }
        if (!d.subject.trim()) { say('Subject is required', true); return false; }
        if (!d.body.trim()) { say('Body is required', true); return false; }
      } else if (fam === 'reply') {
        if (!d.body.trim()) { say('Body is required', true); return false; }
      } else {
        if (!d.title.trim()) { say('Title is required', true); return false; }
        if (!d.date) { say('Date is required', true); return false; }
        if (!d.allDay && !d.startTime) { say('Start time is required (or mark all-day)', true); return false; }
        if (d.endDate && d.endDate < d.date) { say('End date is before the start date', true); return false; }
      }
      payload = buildEditedPayload(p);
    }
    say('Saving…');
    try {
      const r = await api(`/proposals/${encodeURIComponent(p.id)}/payload`, {
        method: 'POST', body: JSON.stringify({ payload }),
      });
      // The re-frozen proposal: its version is what an approve right after
      // the edit sends.
      return (r && r.proposal) || true;
    } catch (err) {
      say(err.message, true);
      return false;
    }
  }

  // `root` is the whole modal sheet, not the card: the fields live in the body
  // and the Save button lives in the decision bar below it.
  function wireEditor(root, p) {
    const note = root.querySelector('[data-edit-note]');
    const say = (msg, bad) => { if (note) { note.textContent = msg; note.classList.toggle('bad', !!bad); } };
    const which = editorKind(p.kind);

    // The generic editor has no live draft to keep in sync (it is read out of
    // the DOM on save) and no attachments — only the buttons below. Its
    // dirty-baseline therefore has to be taken from the rendered inputs.
    if (which === 'generic') {
      try { ui.propDraftSeed = JSON.stringify(collectGenericEdits(root)); } catch { /* keep the object seed */ }
    }
    if (which !== 'generic') root.querySelectorAll('[data-f]').forEach((input) => {
      const key = input.dataset.f;
      const ev = input.type === 'checkbox' ? 'change' : 'input';
      input.addEventListener(ev, () => {
        if (key === 'allDay') {
          ui.propDraft.allDay = input.checked;
          root.querySelectorAll('.me-timerow').forEach((el) => { el.style.display = input.checked ? 'none' : ''; });
        } else if (key === 'includeSignature') {
          ui.propDraft.includeSignature = input.checked;
        } else if (key === 'attendees') {
          ui.propDraft.attendees = input.value.split(',').map((s) => s.trim()).filter(Boolean);
        } else {
          ui.propDraft[key] = input.value;
        }
        if (which === 'calendar') scheduleDayPreview(root, p, key === 'date');
      });
    });

    // --- composer affordances ---
    const body = root.querySelector('.mc-body');
    if (body) {
      const grow = () => { body.style.height = 'auto'; body.style.height = `${Math.max(body.scrollHeight, 220)}px`; };
      grow();
      body.addEventListener('input', grow);
    }
    const ccBtn = root.querySelector('[data-cc]');
    if (ccBtn) ccBtn.addEventListener('click', () => {
      root.querySelector('.mc-cc').style.display = '';
      ccBtn.remove();
    });
    const qBtn = root.querySelector('[data-quote]');
    if (qBtn) qBtn.addEventListener('click', () => {
      const qb = root.querySelector('.mc-qbody');
      const open = qb.style.display === 'none';
      qb.style.display = open ? '' : 'none';
      qBtn.classList.toggle('open', open);
    });

    // --- attachments: button, drop, paste ---
    const attInput = root.querySelector('[data-att-input]');
    const attAdd = root.querySelector('[data-att-add]');
    const attsEl = root.querySelector('[data-atts]');
    const refreshAtts = () => {
      attsEl.querySelectorAll('.att-chip').forEach((el) => el.remove());
      attAdd.insertAdjacentHTML('beforebegin', attChips(ui.propDraft.attachments, { editable: true }));
      wireAttRemove();
    };
    const wireAttRemove = () => {
      attsEl.querySelectorAll('[data-att-rm]').forEach((btn) => {
        btn.addEventListener('click', () => {
          ui.propDraft.attachments.splice(Number(btn.dataset.attRm), 1);
          refreshAtts();
        });
      });
    };
    if (attAdd) {
      const take = (files) => addAttachmentFiles(files, { refresh: refreshAtts, say });
      wireAttRemove();
      attAdd.addEventListener('click', () => attInput.click());
      attInput.addEventListener('change', () => {
        const files = [...attInput.files];
        attInput.value = '';
        take(files);
      });
      const composer = root.querySelector('.mail-composer');
      if (composer) {
        // Counter goes up and down rather than toggling on every dragenter:
        // moving the pointer over a child fires dragleave on the parent, and a
        // boolean would flicker the drop target away underneath the cursor.
        let depth = 0;
        composer.addEventListener('dragenter', (e) => {
          if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
          e.preventDefault(); depth++; composer.classList.add('dropping');
        });
        composer.addEventListener('dragover', (e) => {
          if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
          e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
        });
        composer.addEventListener('dragleave', () => {
          if (--depth <= 0) { depth = 0; composer.classList.remove('dropping'); }
        });
        composer.addEventListener('drop', (e) => {
          const files = [...(e.dataTransfer?.files || [])];
          if (!files.length) return;
          e.preventDefault();
          depth = 0; composer.classList.remove('dropping');
          take(files);
        });
        composer.addEventListener('paste', (e) => {
          const files = [...(e.clipboardData?.files || [])];
          if (!files.length) return; // plain text paste: let the textarea have it
          e.preventDefault();
          take(files);
        });
      }
    }

    const save = root.querySelector('[data-edit-save]');
    if (save) save.addEventListener('click', async () => {
      save.disabled = true;
      const ok = await commitEdit(root, p);
      save.disabled = false;
      if (!ok) return;
      // Dropping the draft makes the re-render re-seed from the payload the
      // SERVER re-froze — for a composed reply that is the recomposed body, not
      // the text that produced it.
      ui.propEdit = null; ui.propDraft = null;
      await refreshApprovals();
      const fresh = document.querySelector('#propOverlay [data-edit-note]');
      if (fresh) fresh.textContent = 'Saved.';
    });
  }

  async function renderApprovals() {
    main.innerHTML = `<div class="pane">
      <div class="pane-head"><h2>Approvals</h2><span class="sub">Frozen payloads — what you approve is exactly what runs</span></div>
      <div class="pane-scroll" id="propScroll"></div>
    </div>`;
    let items = [];
    let loadErr = null;
    let promptBlock = '';
    try { items = (await api('/proposals')).proposals || []; } catch (err) { loadErr = err; }
    try { promptBlock = (await api('/decisions/stats')).promptBlock || ''; } catch { /* absent until enough decisions */ }
    ui.proposals = items;
    const pending = items.filter((p) => p.status === 'pending');
    const history = items.filter((p) => p.status !== 'pending');
    const scroll = document.getElementById('propScroll');
    if (!scroll) return;
    if (loadErr) { scroll.innerHTML = loadErrNote(loadErr); return; }
    if (ui.propEdit && !pending.some((p) => p.id === ui.propEdit)) { ui.propEdit = null; ui.propDraft = null; }

    // Two days is where a queue stops being a to-do list and starts being
    // wallpaper. The old cards are grouped apart and given the three ways out
    // that do not require reading each one: keep, fold away, refuse.
    const fresh = pending.filter((p) => !isStale(p));
    const stale = pending.filter(isStale);
    // Cards sit in a grid, not a column: a decision needs a title, three facts
    // and three buttons, none of which is improved by 1400px of width.
    const group = (label, list, bulk) => (list.length
      ? `<div class="prop-group-head"><span>${escHtml(label)} · ${list.length}</span>${bulk ? `<span class="prop-bulk">
          <button class="hbtn" data-bulk="extend" title="Push their expiry out by another week">Keep 7 days</button>
          <button class="hbtn" data-bulk="withdraw" title="Fold them away unanswered — nothing is recorded as a rejection">Withdraw all</button>
          <button class="hbtn danger" data-bulk="deny">Deny all</button>
        </span>` : ''}</div><div class="prop-grid">${list.map(proposalCard).join('')}</div>`
      : '');

    // A waiting card carries the whole flow with its doors labelled; a decided
    // one carries only the mini fan with the door it took lit. That glyph needs
    // meeting once, and this is where it lives.
    const legend = `<div class="pf-legend">
      <span>Where each one went:</span>
      <span class="pf-key">${miniFan('go', 'go')}<i>Horst did it</i></span>
      <span class="pf-key">${miniFan('no', 'no')}<i>you refused</i></span>
      <span class="pf-key">${miniFan('off', 'off')}<i>folded away or expired — may come back</i></span>
    </div>`;

    scroll.innerHTML = (promptBlock
      ? `<details class="decision-patterns"><summary>Decision patterns Horst has learned</summary><pre>${escHtml(promptBlock)}</pre></details>`
      : '')
      + (pending.length
      ? group(stale.length ? 'Fresh' : 'Waiting', fresh, false) + group('Waiting over 48 h', stale, true)
      : '<div class="empty-note">Nothing awaiting approval. Horst stages actions here — from chat, email triage, and automations.</div>')
      + (history.length ? `<div class="prop-section" id="propHistToggle"><span class="arrow">▶</span> History (${history.length})</div><div id="propHist" style="display:none">${legend}<div class="prop-grid">${history.map(proposalCard).join('')}</div></div>` : '');

    const toggle = document.getElementById('propHistToggle');
    if (toggle) toggle.addEventListener('click', () => {
      const hist = document.getElementById('propHist');
      const open = hist.style.display === 'none';
      hist.style.display = open ? '' : 'none';
      toggle.classList.toggle('open', open);
    });

    wirePropScope(scroll);

    // A verdict lands asynchronously (the server checks the calendar/mail store
    // after staging), and a proposal can arrive while this view is open — both
    // reach us as horst:proposal, so re-render rather than showing a stale card.
    //
    // Subscribed ONCE per visit: renderApprovals is also the refresher, so
    // subscribing here unconditionally would add a listener per render and each
    // event would then trigger a growing pile of them. Cleared in setView.
    if (!ui.propSubscribed) {
      ui.propSubscribed = true;
      live('horst:proposal', () => {
        if (ui.view !== 'approvals' || ui.propEdit) return; // never yank a half-typed edit
        clearTimeout(ui.propLiveTimer);
        ui.propLiveTimer = setTimeout(refreshApprovals, 250); // fold a sync burst into one render
      });
    }
  }

  // Both surfaces (list and expanded view) share one set of handlers, so a
  // decision, edit or conversion behaves identically wherever it is made.
  function wirePropScope(scope) {
    scope.querySelectorAll('[data-raw]').forEach((el) => {
      el.addEventListener('click', () => {
        const pre = el.nextElementSibling;
        const open = pre.style.display === 'none';
        pre.style.display = open ? '' : 'none';
        el.classList.toggle('open', open);
      });
    });

    scope.querySelectorAll('button[data-decide]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        // [data-id] rather than .prop-item: the modal's decision bar sits below
        // the editor pane, outside any card, and drives the same handlers.
        const card = btn.closest('[data-id]');
        const label = btn.textContent;
        const p = (ui.proposals || []).find((x) => x.id === card.dataset.id);
        card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        btn.textContent = btn.dataset.decide === 'approve' ? 'Executing…' : 'Denying…';
        // Approving a draft you just rewrote must send what is on the screen.
        // Denying it does not need the edit, so it never blocks on one.
        let version = btn.dataset.version;
        if (btn.dataset.decide === 'approve' && p && ui.propEdit === p.id) {
          const root = btn.closest('.po-sheet') || card;
          const saved = await commitEdit(root, p);
          if (!saved) {
            card.querySelectorAll('button').forEach((b) => { b.disabled = false; });
            btn.textContent = label;
            return;
          }
          if (saved.version) version = saved.version;
        }
        // From the modal, the full card was on screen: view 'full' (the
        // server's 'ui-full'), which a kind's approveFrom may require.
        const view = btn.closest('#propOverlay') ? 'full' : undefined;
        try {
          await api(`/proposals/${encodeURIComponent(card.dataset.id)}/decide`, { method: 'POST', body: JSON.stringify({ decision: btn.dataset.decide, view, version }) });
        } catch (err) { showAlert(err.message); }
        ui.dayCache = {};                                   // the day just changed
        if (ui.propOpen === card.dataset.id) closePropOverlay({ force: true }); // nothing left to decide
        await refreshApprovals();
        refreshBadges();
      });
    });

    // Folding a card away without answering it. Deliberately NOT a denial: no
    // ledger row is written, so clearing a stale queue never teaches Horst that
    // the kind is unwanted, and the same act may be proposed again later.
    scope.querySelectorAll('button[data-withdraw]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('[data-id]');
        card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        btn.textContent = 'Withdrawing…';
        // A single withdraw is a batch of one — same route, same audit row.
        try {
          await api('/proposals/batch', {
            method: 'POST', body: JSON.stringify({ action: 'withdraw', ids: [card.dataset.id] }),
          });
        } catch (err) { showAlert(err.message); }
        if (ui.propOpen === card.dataset.id) closePropOverlay({ force: true });
        await refreshApprovals();
        refreshBadges();
      });
    });

    // Clearing the stale group in one gesture. Bounded to the ids this page is
    // currently showing — never "everything on the server", which a stale view
    // could otherwise sweep away.
    scope.querySelectorAll('button[data-bulk]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.bulk;
        const ids = (ui.proposals || []).filter((p) => p.status === 'pending' && isStale(p)).map((p) => p.id);
        if (!ids.length) return;
        // Withdrawing and extending are recoverable; denying en masse writes a
        // ledger row per card and shapes what Horst proposes next.
        if (action === 'deny' && !await showConfirm(`Deny all ${ids.length} proposals that have been waiting over 48 hours?\n\nEach denial is recorded and teaches Horst that the kind is unwanted. To just clear them, use "Withdraw all".`, { confirmLabel: 'Deny all', danger: true })) return;
        const label = btn.textContent;
        btn.closest('.prop-bulk').querySelectorAll('button').forEach((b) => { b.disabled = true; });
        btn.textContent = 'Working…';
        try {
          const r = await api('/proposals/batch', { method: 'POST', body: JSON.stringify({ action, ids }) });
          if (r.failed) showAlert(`${r.failed} of ${ids.length} could not be done: ${r.results.filter((x) => !x.ok).map((x) => x.error).join(', ')}`);
        } catch (err) {
          showAlert(err.message);
          btn.textContent = label;
        }
        if (ui.propOpen) closePropOverlay({ force: true });
        await refreshApprovals();
        refreshBadges();
      });
    });

    // Switch between updating the existing event and creating a separate one.
    scope.querySelectorAll('button[data-convert]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('[data-id]');
        card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        try {
          await api(`/proposals/${encodeURIComponent(card.dataset.id)}/convert`, {
            method: 'POST', body: JSON.stringify({ to: btn.dataset.convert }),
          });
        } catch (err) { showAlert(err.message); }
        // Create ⇄ update rewrites the payload the editor is bound to.
        ui.propEdit = null; ui.propDraft = null;
        await refreshApprovals();
      });
    });

    // Undo is itself a PROPOSAL: the server re-derives the inverse from what
    // actually executed and stages it, so reversing an act goes through the
    // same funnel, ceiling and ledger as performing one.
    scope.querySelectorAll('button[data-undo]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('[data-id]');
        const label = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Staging the reverse…';
        try {
          await api(`/proposals/${encodeURIComponent(card.dataset.id)}/undo`, { method: 'POST', body: JSON.stringify({}) });
        } catch (err) {
          showAlert(err.message);
          btn.disabled = false;
          btn.textContent = label;
          return;
        }
        await refreshApprovals();
        refreshBadges();
      });
    });

    scope.querySelectorAll('[data-expand]').forEach((el) => {
      el.addEventListener('click', () => {
        const card = el.closest('[data-id]');
        if (card && ui.propOpen !== card.dataset.id) openPropOverlay(card.dataset.id);
      });
    });
  }

  async function refreshApprovals() {
    if (ui.view === 'approvals') await renderApprovals();
    if (ui.propOpen) await renderPropOverlay();
  }

  // =========================================================================
  // Expanded proposal view — the card at full size with that day's calendar
  // beside it. Approving an event is a judgement about a day, not about a card:
  // what else is on, what it collides with, which all-day entries are running.
  // =========================================================================

  function onOverlayKey(e) {
    if (e.key === 'Escape') closePropOverlay();
  }

  // `force` is for the paths that have already dealt with the edit: a decision
  // committed it (or deliberately abandoned it), and leaving the view is not a
  // moment to interrogate anyone. Resolves false when the user backed out.
  // Without `force` it may ask first, so it is async; a forced close (or one
  // with nothing to ask) runs to completion before it returns.
  async function closePropOverlay({ force } = {}) {
    if (!force && ui.propOpen) {
      const open = ui.propOpen;
      const p = (ui.proposals || []).find((x) => x.id === open);
      const sheet = document.querySelector('#propOverlay .po-sheet');
      if (draftDirty(p, sheet)) {
        if (!await showConfirm('Discard your unsaved changes to this proposal?', { confirmLabel: 'Discard', danger: true })) return false;
        // Closed, or switched to another proposal, while the question was up.
        if (ui.propOpen !== open) return true;
      }
    }
    ui.propOpen = null;
    ui.propEdit = null;
    ui.propDraft = null;
    ui.propDraftSeed = null;
    clearTimeout(ui.dayPreviewTimer);
    document.getElementById('propOverlay')?.remove();
    document.removeEventListener('keydown', onOverlayKey);
    return true;
  }

  function openPropOverlay(id) {
    ui.propOpen = id;
    document.addEventListener('keydown', onOverlayKey);
    return renderPropOverlay();
  }

  // That day, beside the entry you are editing. Painted from FIELDS rather than
  // from the proposal so the same function serves the first render (frozen
  // payload) and every keystroke after it (live draft) — moving an event to
  // 15:00 has to show you the 15:00 collision, which is the whole reason these
  // two panes are side by side.
  async function paintDay(root, p, f, { keepScroll } = {}) {
    const pane = root.querySelector('#poDayPane');
    if (!pane) return;
    if (!f.date) { pane.innerHTML = '<div class="tl-note">This entry carries no date yet.</div>'; return; }
    const account = (p.payload || {}).account || '';
    let events;
    try {
      events = await loadDay(f.date, account);
    } catch (err) {
      pane.innerHTML = `<div class="tl-note bad">Could not load that day — ${escHtml(err.message)}</div>`;
      return;
    }
    if (ui.propOpen !== p.id) return; // closed or switched while loading
    const prev = keepScroll ? (pane.querySelector('#tlScroll')?.scrollTop ?? null) : null;
    const target = p.prior?.evidence?.eventId || (p.payload || {}).eventId || null;
    const block = proposedBlockFrom(f);
    pane.innerHTML = renderDayTimeline(f.date, events, block, target);
    const sc = pane.querySelector('#tlScroll');
    // An all-day ghost carries no startMin; landing on 08:00 is the right
    // default for it too.
    const focusMin = block && block.startMin != null ? block.startMin : 8 * 60;
    if (sc) sc.scrollTop = prev != null ? prev : Math.max(0, (focusMin / 60) * HOUR_PX - 110);
  }

  // Repainting on every keystroke would refetch the day per character; the day
  // itself only has to be refetched when the DATE changed, and loadDay memoises
  // per `date|account` anyway.
  function scheduleDayPreview(root, p, dateChanged) {
    clearTimeout(ui.dayPreviewTimer);
    ui.dayPreviewTimer = setTimeout(() => {
      paintDay(root, p, ui.propDraft, { keepScroll: !dateChanged });
    }, 220);
  }

  async function renderPropOverlay() {
    const p = ui.proposals.find((x) => x.id === ui.propOpen);
    if (!p) return closePropOverlay({ force: true });

    let el = document.getElementById('propOverlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'propOverlay';
      el.className = 'prop-overlay';
      document.body.appendChild(el);
      el.addEventListener('click', (e) => { if (e.target === el) closePropOverlay(); });
    }

    // Seeded here rather than in openPropOverlay so a re-render after a save
    // re-reads the payload the SERVER re-froze (its compose hook rebuilds both
    // MIME parts), instead of showing the draft that produced it.
    if (p.status === 'pending' && ui.propEdit !== p.id) startPropEdit(p);
    if (p.status !== 'pending') { ui.propEdit = null; ui.propDraft = null; }

    const fam = kindFamily(p.kind);
    const split = fam === 'cal-create' || fam === 'cal-update' || fam === 'cal-delete';
    const hasSource = !!(p.source && p.source.type === 'email');
    // A composed reply already carries the original as its quoted trail, right
    // under the draft. Loading the same message a second time below it would be
    // the same words twice.
    const showSource = hasSource && !(p.payload && p.payload.quotedText);
    const f = calFields(p.payload || {});
    const srcPane = '<div id="poSrcPane" class="po-source"><div class="tl-note">Loading the email…</div></div>';

    el.innerHTML = `<div class="po-sheet${split ? ' wide' : ''}">
      <div class="po-bar">
        <span class="po-icon">${escHtml((p.card && p.card.icon) || '•')}</span>
        <div class="po-titles">
          <b>${escHtml((p.card && p.card.title) || p.summary)}</b>
          <div class="po-act">${escHtml(actOf(p).does)}</div>
        </div>
        <span class="prop-chip kind" title="${escHtml(p.kind)}">${escHtml(kindWords(p))}</span>
        ${stateFlow(p)}
        <button class="po-close" title="Close (Esc)">✕</button>
      </div>
      ${whyPane(p)}
      <div class="po-body ${split ? 'split' : 'single'}">
        <div class="po-left"><div class="po-left-inner">
          ${editorPane(p)}
          ${!split && showSource ? srcPane : ''}
        </div></div>
        ${split ? `<div class="po-right" id="poDay">
          <div id="poDayPane"><div class="tl-note">Loading the day…</div></div>
          ${showSource ? srcPane : ''}
        </div>` : ''}
      </div>
      ${decisionBar(p)}
    </div>`;

    el.querySelector('.po-close').addEventListener('click', () => closePropOverlay());
    wirePropScope(el);
    if (ui.propEdit === p.id) wireEditor(el.querySelector('.po-sheet'), p);

    // Only the calendar editor's draft is field-shaped; calendar.delete gets the
    // generic editor, so its ghost block comes from the frozen payload.
    const live = ui.propEdit === p.id && editorKind(p.kind) === 'calendar';
    if (split) await paintDay(el, p, live ? ui.propDraft : f);
    if (showSource) await loadSourceMail(el, p);
  }

  // The message a proposal was mined from. Failure NEVER blocks the decision:
  // the route always answers 200 and names what is missing, so a deleted mail
  // costs you the context, not the ability to approve.
  async function loadSourceMail(el, p, { full } = {}) {
    const pane = el.querySelector('#poSrcPane');
    if (!pane) return;
    try {
      const r = await api(`/proposals/${encodeURIComponent(p.id)}/source${full ? '?full=1' : ''}`);
      if (ui.propOpen !== p.id) return; // closed or switched while loading
      pane.innerHTML = renderSourceMail(r);
      const more = pane.querySelector('[data-src-full]');
      if (more) more.addEventListener('click', () => loadSourceMail(el, p, { full: true }));
    } catch (err) {
      pane.innerHTML = `<div class="po-source-head">✉ Original email</div>
        <div class="tl-note">Could not load it — ${escHtml(err.message)}. This does not affect the decision.</div>`;
    }
  }

  const SRC_MISSING = {
    engine: 'The mail engine is not running, so the original email cannot be shown.',
    gone: 'That email is no longer in the mailbox — it was moved or deleted.',
    proposal: 'This proposal is no longer available.',
    none: 'This proposal did not come from an email.',
    error: 'The original email could not be read.',
  };

  function renderSourceMail(r) {
    const head = '<div class="po-source-head">✉ The email this came from</div>';
    if (r.missing) return `${head}<div class="tl-note">${escHtml(SRC_MISSING[r.missing] || SRC_MISSING.error)}</div>`;
    const m = r.email || {};
    const when = m.date ? new Date(m.date) : null;
    const row = (label, val) => val
      ? `<div class="mail-row"><span class="mail-label">${label}</span><span class="mail-val">${escHtml(val)}</span></div>` : '';
    return `${head}<div class="mail-card">
      ${row('From', m.from)}${row('To', m.to)}
      ${row('Date', when && !isNaN(when) ? when.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : m.date)}
      <div class="mail-subject">${escHtml(m.subject || '(no subject)')}</div>
      <div class="mail-body">${window.ProposalCards.renderBody(m.body)}</div>
      ${m.truncated ? `<button class="hbtn" data-src-full>Show the whole email (${escHtml(String(m.chars))} characters)</button>` : ''}
      ${(m.attachments || []).length ? `<div class="mail-atts">${attChips(m.attachments)}</div>` : ''}
    </div>`;
  }

  // =========================================================================
  // Triggers — "when X happens, do Y" (replaces the Events panel)
  // =========================================================================
  //
  // The bus stores a policy per app×kind. Users were expected to understand
  // words like 'run-action'; nobody did. Here each row reads as a sentence,
  // every choice carries a plain explanation of what it actually does, and
  // 'run-action' is hidden for kinds that have no handler bound — choosing it
  // there would have silently done nothing.

  const EV_DEFAULT_POLICY = {
    'timer:heartbeat': 'run-action', 'timer:briefing': 'run-action', 'email:new': 'run-action',
    'app:failed': 'notify', 'app:started': 'agenda', 'app:stopped': 'agenda',
    'tools:updated': 'run-action',
  };

  // Human phrasing for the platform kinds. Anything else falls back to its kind.
  const KIND_PHRASE = {
    'timer:heartbeat': 'every 15 minutes, on the clock',
    'timer:briefing': 'the morning briefing is due',
    'email:new': 'new mail arrives',
    'app:started': 'an app starts',
    'app:stopped': 'an app stops',
    'app:failed': 'an app crashes',
    'tools:updated': 'an app’s capabilities change',
    webhook: 'an inbound webhook fires',
  };

  function kindPhrase(kind, app) {
    if (KIND_PHRASE[kind]) return KIND_PHRASE[kind];
    const bare = kind.includes(':') ? kind.slice(kind.indexOf(':') + 1) : kind;
    return `${app ? app + ' reports ' : ''}${bare.replace(/[:_]/g, ' ')}`;
  }

  let runActionKinds = [];

  function evCurrentPolicy(app, kind) {
    return ui.evPolicySet[`${app || 'platform'}|${kind}`] || EV_DEFAULT_POLICY[kind] || 'agenda';
  }

  function policyPicker(app, kind, policies) {
    const current = evCurrentPolicy(app, kind);
    const usable = policies.filter((p) => p !== 'run-action' || runActionKinds.includes(kind));
    return `<div class="trg-choice">
      <select class="ev-policy" data-app="${escHtml(app || '')}" data-kind="${escHtml(kind)}">
        ${usable.map((p) => `<option value="${escHtml(p)}" ${p === current ? 'selected' : ''}>${escHtml((POLICY_MEANING[p] || {}).label || p)}</option>`).join('')}
      </select>
      <span class="trg-blurb">${escHtml((POLICY_MEANING[current] || {}).blurb || '')}</span>
    </div>`;
  }

  // Same matcher as the bus (horst-events.js matchKind): a full kind, or `*`
  // per colon segment with a trailing `*` covering the rest.
  function matchKind(pattern, kind) {
    if (pattern === kind) return true;
    if (!pattern.includes('*')) return false;
    const ps = pattern.split(':'), ks = kind.split(':');
    for (let i = 0; i < ps.length; i++) {
      if (ps[i] === '*' && i === ps.length - 1) return ks.length >= ps.length;
      if (i >= ks.length || (ps[i] !== '*' && ps[i] !== ks[i])) return false;
    }
    return ks.length === ps.length;
  }
  let trgSubscribers = {}; // pattern → [apps], from /events/catalog
  function listenedBy(kind) {
    const apps = new Set();
    for (const [pattern, list] of Object.entries(trgSubscribers)) if (matchKind(pattern, kind)) list.forEach((a) => apps.add(a));
    return [...apps].sort();
  }

  // meta.horst === false: an independent app's kind — on the bus for other
  // apps, never routed to Horst, so the policy picker is moot.
  function triggerRow(app, kind, note, extraClass, meta) {
    const appOnly = !!(meta && meta.horst === false);
    const listeners = listenedBy(kind);
    const listenNote = listeners.length ? `<span class="trg-note trg-listen">listened by ${escHtml(listeners.join(', '))}</span>` : '';
    const picker = appOnly
      ? `<div class="trg-choice trg-app-only"><select class="ev-policy" disabled><option>App-only — Horst never sees this</option></select>
          <span class="trg-blurb">The app is independent (platformContribution: false). Other apps may still subscribe.</span></div>`
      : policyPicker(app, kind, ['ignore', 'agenda', 'notify', 'run-action']);
    return `<div class="trg-row ${extraClass || ''} ${appOnly ? 'app-only' : ''}">
      <div class="trg-when"><span class="trg-lead">When</span> ${escHtml(kindPhrase(kind, app))}
        <span class="trg-kind">${escHtml(kind)}</span>${meta && meta.manifest ? ' <span class="trg-note" style="display:inline">(manifest)</span>' : ''}
        ${note ? `<span class="trg-note">${escHtml(note)}</span>` : ''}
        ${listenNote}
      </div>
      <div class="trg-arrow">→</div>
      ${picker}
    </div>`;
  }

  async function renderTriggers() {
    main.innerHTML = `<div class="pane">
      <div class="pane-head">
        <h2>Triggers</h2>
        <span class="sub">When something happens, this is what Horst does about it</span>
        <span class="spacer"></span>
        <button class="hbtn" id="trgToMap">See it on the map</button>
      </div>
      <div class="pane-scroll" id="trgList"></div>
    </div>`;
    document.getElementById('trgToMap').addEventListener('click', () => setView('map'));

    let data = null;
    let loadErr = null;
    try { data = await api('/events/catalog'); } catch (err) { loadErr = err; }
    const list = document.getElementById('trgList');
    if (!list) return;
    if (loadErr) { list.innerHTML = loadErrNote(loadErr); return; }

    const { catalog, policies } = data;
    runActionKinds = data.runActionKinds ? Object.keys(data.runActionKinds) : [];
    // Effective policies from the server win over the client-side defaults.
    for (const [key, val] of Object.entries(catalog.policies || {})) ui.evPolicySet[key] = val;

    trgSubscribers = catalog.subscribers || {};
    const platform = (catalog.platform || []).map((k) => triggerRow(null, k.key, k.description));
    const declared = Object.entries(catalog.declared || {}).flatMap(([app, kinds]) =>
      Object.entries(kinds).map(([kind, meta]) => triggerRow(app, kind, meta.description, '', meta)));
    const discovered = Object.entries(catalog.discovered || {}).flatMap(([app, kinds]) =>
      Object.entries(kinds).map(([kind, meta]) => triggerRow(app, kind, `seen ${meta.count ?? 0}× since ${fmtTime(meta.firstSeen)}`, 'discovered', meta)));

    list.innerHTML = `
      <div class="trg-intro">
        Every signal Horst can receive is listed here. Pick what should happen for each one.
        Only <b>“Horst decides”</b> involves him thinking — the rest are fixed, cheap reactions.
        Apps listen on the same bus: a “listened by” line names who subscribes to a kind.
      </div>
      <div class="trg-section">Built into the platform</div>${platform.join('') || '<div class="set-hint">—</div>'}
      <div class="trg-section">Announced by your apps</div>${declared.join('') || '<div class="set-hint">No app has declared events yet.</div>'}
      <div class="trg-section">Seen but never announced
        <span class="trg-sub">held at “just note it” until you decide otherwise</span></div>
      ${discovered.join('') || '<div class="set-hint">Nothing yet.</div>'}`;

    list.querySelectorAll('select.ev-policy').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const app = sel.dataset.app || null;
        const kind = sel.dataset.kind;
        try {
          await api('/events/policy', { method: 'POST', body: JSON.stringify({ app, kind, policy: sel.value }) });
          ui.evPolicySet[`${app || 'platform'}|${kind}`] = sel.value;
          const blurb = sel.parentElement.querySelector('.trg-blurb');
          if (blurb) blurb.textContent = (POLICY_MEANING[sel.value] || {}).blurb || '';
          sel.classList.add('saved');
          setTimeout(() => sel.classList.remove('saved'), 1200);
        } catch (err) { showAlert(err.message); }
      });
    });
  }

  // =========================================================================
  // Settings
  // =========================================================================

  // One line of decision-ledger evidence under a dial: how the user has
  // actually decided this kind. This is the data a human wants when moving a
  // dial — and the same numbers a future calibration proposal would argue from.
  function dialStatsLine(st) {
    if (!st) return '';
    const humans = (st.approved || 0) + (st.denied || 0) + (st.expired || 0);
    if (!humans) return '';
    const bits = [`${humans} decided`, `${st.approved} approved${st.approvalRate != null ? ` (${Math.round(st.approvalRate * 100)}%)` : ''}`];
    if (st.denied) bits.push(`${st.denied} denied`);
    if (st.edited) bits.push(`${st.edited} edited first`);
    if (st.lastDecisionAt) bits.push(`last ${fmtTime(st.lastDecisionAt)}`);
    return `<div class="dial-stats">${escHtml(bits.join(' · '))}</div>`;
  }

  // The Configurations editor (Settings). A `list` configuration is chips with
  // a remove button (locked items have none) plus an add box; a `fields` one
  // is typed inputs with the schema's bounds and its own Save. The server
  // validates every patch (capabilities/config.js) — the inputs only hint.
  async function renderConfigs() {
    const host = document.getElementById('configList');
    if (!host) return;
    let configs = [];
    try { configs = (await api('/config')).configs || []; }
    catch (err) { host.innerHTML = `<div class="set-hint">Configurations unavailable: ${escHtml(err.message)}</div>`; return; }

    const post = async (key, patch) => {
      try { await api(`/config/${encodeURIComponent(key)}`, { method: 'POST', body: JSON.stringify({ patch }) }); }
      catch (err) { showAlert(err.message); }
      renderConfigs();
    };

    const itemName = (it) => (typeof it === 'string' ? it : it.name);
    const listHtml = (c) => {
      const locked = new Set((c.schema.locked || []).map((x) => x.toLowerCase()));
      const chips = (c.value || []).map((it) => {
        const name = itemName(it);
        const swatch = it && it.color ? `<i class="cfg-swatch" style="background:${escHtml(it.color)}"></i>` : '';
        const ref = typeof it === 'string' ? it : it.id;
        return locked.has(name.toLowerCase())
          ? `<span class="doctype-chip locked" title="Always present">${swatch}${escHtml(name)}</span>`
          : `<span class="doctype-chip">${swatch}${escHtml(name)}<button type="button" data-cfg-rm="${escHtml(ref)}" title="Remove ${escHtml(name)}">✕</button></span>`;
      }).join('');
      const withColor = !!(c.schema.item && c.schema.item.color);
      const max = (c.schema.item && (c.schema.item.max || (c.schema.item.name && c.schema.item.name.max))) || 64;
      return `<div class="doctype-list">${chips || '<span class="set-hint">Empty.</span>'}</div>
        <div class="doctype-add">
          <input type="text" data-cfg-new placeholder="add — e.g. ${escHtml(c.key === 'email.tags' ? 'Bills · IT services' : 'insurance')}" maxlength="${max}">
          ${withColor ? '<input type="color" data-cfg-color value="#64748b" title="Colour">' : ''}
          <button class="hbtn" data-cfg-add>Add</button>
        </div>`;
    };
    const fieldsHtml = (c) => Object.entries(c.schema.fields).map(([k, f]) => `
        <div class="set-row"><label>${escHtml(k)}${f.about ? ` — ${escHtml(f.about)}` : ''}</label>
          ${f.type === 'boolean'
            ? `<input type="checkbox" data-cfg-field="${escHtml(k)}"${c.value?.[k] ? ' checked' : ''}>`
            : `<input type="${f.type === 'number' ? 'number' : 'text'}" data-cfg-field="${escHtml(k)}" value="${escHtml(String(c.value?.[k] ?? ''))}"${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''}>`}</div>`).join('')
      + `<div><button class="hbtn" data-cfg-save>Save ${escHtml(c.title.toLowerCase())}</button></div>`;

    host.innerHTML = configs.map((c) => `
      <div class="cfg-block" data-cfg="${escHtml(c.key)}">
        <div class="cfg-title">${escHtml(c.title)} <span class="set-hint">(${escHtml(c.key)})</span></div>
        <div class="set-hint">${escHtml(c.about || '')}</div>
        ${c.schema.type === 'list' ? listHtml(c) : fieldsHtml(c)}
      </div>`).join('');

    host.querySelectorAll('.cfg-block').forEach((block) => {
      const key = block.dataset.cfg;
      const c = configs.find((x) => x.key === key);
      block.querySelectorAll('[data-cfg-rm]').forEach((b) => b.addEventListener('click', () => post(key, { remove: [b.dataset.cfgRm] })));
      const add = () => {
        const input = block.querySelector('[data-cfg-new]');
        const name = input.value.trim();
        if (!name) return;
        const color = block.querySelector('[data-cfg-color]');
        const item = c.schema.item && c.schema.item.type ? name : { name, ...(color ? { color: color.value } : {}) };
        post(key, { add: [item] });
      };
      block.querySelector('[data-cfg-add]')?.addEventListener('click', add);
      block.querySelector('[data-cfg-new]')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
      block.querySelector('[data-cfg-save]')?.addEventListener('click', () => {
        const patch = {};
        block.querySelectorAll('[data-cfg-field]').forEach((inp) => {
          const k = inp.dataset.cfgField;
          const f = c.schema.fields[k];
          const v = f.type === 'boolean' ? inp.checked : f.type === 'number' ? Number(inp.value) : inp.value;
          if (f.type === 'number' && !Number.isFinite(v)) return;
          if (v !== c.value?.[k]) patch[k] = v;
        });
        if (!Object.keys(patch).length) return;
        post(key, patch);
      });
    });
  }

  async function renderSettings() {
    let s = {};
    let gov = { dials: {}, levels: [] };
    let loadErr = null;
    try { s = (await api('/state')).settings || {}; } catch (err) { loadErr = err; }
    try { gov = await api('/governance'); } catch (err) { loadErr = loadErr || err; }
    let decStats = {};
    try { decStats = (await api('/decisions/stats')).stats || {}; } catch { /* ledger empty or route unavailable — stats lines just don't render */ }
    if (loadErr) {
      main.innerHTML = `<div class="pane"><div class="pane-head"><h2>Settings</h2></div>${loadErrNote(loadErr)}</div>`;
      return;
    }

    // The four dial positions, explained once above the rows. Text comes from
    // the governance module so the explanation cannot drift from the enforcement.
    const info = gov.levelInfo || {};
    const levelLegend = (gov.levels || []).map((lvl) => {
      const i = info[lvl] || {};
      return `<div class="lvl-card">
        <div class="lvl-head"><span class="lvl-name">${escHtml(i.title || lvl)}</span><code>${escHtml(lvl)}</code></div>
        <div class="lvl-short">${escHtml(i.short || '')}</div>
        <div class="lvl-detail">${escHtml(i.detail || '')}</div>
      </div>`;
    }).join('');

    const dialRules = (gov.dialRules || []).map((r) => `<li>${escHtml(r)}</li>`).join('');

    const dialRows = Object.entries(gov.dials || {}).map(([kind, d]) => {
      const ceilIdx = gov.levels.indexOf(d.ceiling);
      const segs = gov.levels.map((lvl, i) =>
        `<button class="seg-btn ${lvl === d.level ? 'on' : ''}" data-kind="${escHtml(kind)}" data-level="${escHtml(lvl)}"
          ${i > ceilIdx ? 'disabled title="hard-pinned — this kind can never exceed ' + escHtml(d.ceiling) + '"' : `title="${escHtml((info[lvl] || {}).short || lvl)}"`}>${escHtml(lvl)}</button>`).join('');
      const pinned = ceilIdx < gov.levels.length - 1;
      const meta = [
        pinned ? `<span class="dial-pin">max: ${escHtml(d.ceiling)}</span>` : '',
        d.app ? `<span class="dial-app">app: ${escHtml(d.app)}</span>` : '',
        d.notify === 'none' ? '<span class="dial-tag">reviewed in Approvals, not pushed to Telegram</span>' : '',
        d.level !== d.default ? `<span class="dial-tag">changed from default (${escHtml(d.default)})</span>` : '',
      ].filter(Boolean).join('');
      return `<div class="dial-row" data-kind="${escHtml(kind)}">
        <div class="dial-main">
          <div class="dial-label"><b>${escHtml(d.label)}</b><span>${escHtml(kind)}</span></div>
          <div class="seg">${segs}</div>
          <span class="dial-note" style="display:none"></span>
        </div>
        ${d.about ? `<div class="dial-about">${escHtml(d.about)}</div>` : ''}
        ${d.pinNote ? `<div class="dial-about pin">Pinned to ${escHtml(d.ceiling)} — ${escHtml(d.pinNote)}</div>` : ''}
        ${meta ? `<div class="dial-meta">${meta}</div>` : ''}
        ${dialStatsLine(decStats[kind])}
      </div>`;
    }).join('');

    main.innerHTML = `<div class="pane">
      <div class="pane-head"><h2>Settings</h2></div>
      <div class="pane-scroll"><div class="set-grid">
        <label class="pause-toggle">
          <input type="checkbox" id="s-paused" ${s.paused ? 'checked' : ''}>
          <b>Pause Horst</b>
          <span class="set-hint">Kill switch: no triage, briefings, or auto-actions.<br>Chat and your manual approvals keep working.</span>
        </label>

        <div class="set-section">Models &amp; schedules</div>
        <div class="set-row"><label>Chat model (empty = platform default)</label>
          <input type="text" id="s-chatModel" value="${escHtml(s.chatModel || '')}" placeholder="e.g. opus, sonnet, or a full model id"></div>
        <div class="set-row"><label>Briefing model</label>
          <input type="text" id="s-briefingModel" value="${escHtml(s.briefingModel || '')}"></div>
        <div class="set-row"><label>Triage model</label>
          <input type="text" id="s-triageModel" value="${escHtml(s.triageModel || '')}"></div>
        <div class="set-row"><label>Briefing schedule (cron)</label>
          <input type="text" id="s-briefingSchedule" value="${escHtml(s.briefingSchedule || '')}"></div>
        <div class="set-row"><label>Heartbeat schedule</label>
          <input type="text" id="s-heartbeatSchedule" value="${escHtml(s.heartbeatSchedule || '')}"></div>
        <label class="set-toggle"><input type="checkbox" id="s-briefingEnabled" ${s.briefingEnabled ? 'checked' : ''}> Morning briefing enabled</label>
        <label class="set-toggle"><input type="checkbox" id="s-memoryEnabled" ${s.memoryEnabled ? 'checked' : ''}> Long-term memory (platform memory service, private to Horst)</label>
        <label class="set-toggle"><input type="checkbox" id="s-memoryMaintenance" ${s.memoryMaintenance !== false ? 'checked' : ''}> Memory self-maintenance (consolidation, retention, compaction — never runs while Horst is paused)</label>

        <div class="set-section">Email intelligence (the platform classifier)</div>
        <label class="set-toggle"><input type="checkbox" id="s-triageEnabled" ${s.triageEnabled ? 'checked' : ''}> Triage incoming email every heartbeat</label>
        <label class="set-toggle"><input type="checkbox" id="s-autoDraftReplies" ${s.autoDraftReplies ? 'checked' : ''}> Draft replies for important mail (always staged for your approval)</label>
        <div class="set-row"><label>Max reply drafts per sweep</label>
          <input type="number" id="s-draftsPerSweep" value="${escHtml(String(s.draftsPerSweep ?? 2))}" min="0" max="5"></div>
        <label class="set-toggle"><input type="checkbox" id="s-scanAttachments" ${s.scanAttachments !== false ? 'checked' : ''}> Read attachments (PDFs/images/.ics) on schedulable-looking mail</label>
        <label class="set-toggle"><input type="checkbox" id="s-mineFacts" ${s.mineFacts !== false ? 'checked' : ''}> Mine contacts &amp; durable facts into shared memory</label>
        <label class="set-toggle"><input type="checkbox" id="s-calendarProposals" ${s.calendarProposals !== false ? 'checked' : ''}> Stage calendar proposals for detected events</label>
        <div class="set-hint">The tag vocabulary, the triage window and batch and the spam thresholds are Configurations (below) — Horst can propose changes to those; the toggles here are yours alone.</div>

        <div class="set-section">Spam policy</div>
        <div class="set-hint">The classifier scores every mail 0–100; the thresholds under Configurations › Email triage turn the score into the ONE verdict every app renders. "Spam" mail is excluded from briefings, mining and calendar proposals; anything above "suspect" never gets reply drafts or contact mining.</div>
        <label class="set-toggle"><input type="checkbox" id="s-spamRuleSuggestions" ${s.spamRuleSuggestions !== false ? 'checked' : ''}> Suggest sender/domain block rules after repeated spam (always staged for your approval)</label>

        <div class="set-section">Telegram</div>
        <label class="set-toggle"><input type="checkbox" id="s-voiceReplies" ${s.voiceReplies !== false ? 'checked' : ''}> Answer voice messages with a spoken reply (ash)</label>

        <div class="set-section">Governance</div>
        <label class="set-toggle"><input type="checkbox" id="s-proposerHealth" ${s.proposerHealth !== false ? 'checked' : ''}> Stop staging a kind you keep rejecting (weighted under 40% of the last 8+ decisions)</label>
        <div class="set-hint">Never silent: each suppression writes an audit row, and Horst tells you in the agenda and the briefing when he stops staging something. Approve one of a suppressed kind and he starts again. This suppresses a proposer, never a capability — you can still ask for the action yourself.</div>

        <div class="set-section">Configurations</div>
        <div class="set-hint">What Horst reads your world through. He can read every entry (<code>config_get</code>) and propose a change to any of them (<code>config.set</code>, always for your approval); you edit them here directly. Each entry saves on its own.</div>
        <div id="configList"><div class="set-hint">Loading…</div></div>

        <div class="set-section">Brain</div>
        <div class="set-row"><label>Brain-tool calls per AI session (cap on memory/todo/artifact/decision lookups one session may make — guards against retrieval loops, not normal use)</label>
          <input type="number" id="s-brainToolCallCap" value="${escHtml(String(s.brainToolCallCap ?? 30))}" min="5" max="200"></div>

        <div class="set-section">Autonomy dials</div>
        <div class="set-hint">One dial per kind of action, from "watch only" to "act alone". The dial decides what happens the
          moment Horst decides an action is warranted — whether it runs, waits for you, or is only noted.</div>
        <div class="lvl-grid">${levelLegend}</div>
        ${dialRules ? `<ul class="dial-rules">${dialRules}</ul>` : ''}
        <div class="dial-list">${dialRows || '<div class="set-hint">Governance not available.</div>'}</div>

        <div><button class="hbtn primary" id="saveSettings">Save</button> <span class="set-saved" id="savedNote" style="display:none">Saved.</span></div>
        <div class="set-hint">Schedule changes apply to newly created jobs; existing jobs can be adjusted under Apps &gt; Setup &gt; Cron.</div>
      </div></div>
    </div>`;

    // Configurations: one editor rendered from the registry's schema, so a new
    // configuration needs no UI work. Every change is its own POST — the form's
    // Save below never touches these (the server drops the keys anyway).
    renderConfigs();

    // Pause toggle saves immediately — it's the kill switch, not a form field.
    document.getElementById('s-paused').addEventListener('change', async (e) => {
      try {
        await api('/settings', { method: 'POST', body: JSON.stringify({ paused: e.target.checked }) });
        setPauseBanner(e.target.checked);
      } catch (err) { showAlert(err.message); e.target.checked = !e.target.checked; }
    });

    // Dials save immediately; a clamped response snaps the control back.
    main.querySelectorAll('.seg-btn:not(:disabled)').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const row = btn.closest('.dial-row');
        try {
          const res = await api('/dials', { method: 'POST', body: JSON.stringify({ kind: btn.dataset.kind, level: btn.dataset.level }) });
          row.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('on', b.dataset.level === res.level));
          const note = row.querySelector('.dial-note');
          note.textContent = res.clamped ? `pinned to ${res.level}` : 'saved';
          note.style.display = '';
          setTimeout(() => { note.style.display = 'none'; }, 2000);
        } catch (err) { showAlert(err.message); }
      });
    });

    document.getElementById('saveSettings').addEventListener('click', async () => {
      const num = (id, fb) => { const v = parseInt(document.getElementById(id).value, 10); return Number.isFinite(v) ? v : fb; };
      const body = {
        chatModel: document.getElementById('s-chatModel').value.trim(),
        briefingModel: document.getElementById('s-briefingModel').value.trim(),
        triageModel: document.getElementById('s-triageModel').value.trim(),
        briefingSchedule: document.getElementById('s-briefingSchedule').value.trim(),
        heartbeatSchedule: document.getElementById('s-heartbeatSchedule').value.trim(),
        briefingEnabled: document.getElementById('s-briefingEnabled').checked,
        memoryEnabled: document.getElementById('s-memoryEnabled').checked,
        memoryMaintenance: document.getElementById('s-memoryMaintenance').checked,
        paused: document.getElementById('s-paused').checked,
        triageEnabled: document.getElementById('s-triageEnabled').checked,
        autoDraftReplies: document.getElementById('s-autoDraftReplies').checked,
        draftsPerSweep: num('s-draftsPerSweep', 2),
        scanAttachments: document.getElementById('s-scanAttachments').checked,
        mineFacts: document.getElementById('s-mineFacts').checked,
        calendarProposals: document.getElementById('s-calendarProposals').checked,
        spamRuleSuggestions: document.getElementById('s-spamRuleSuggestions').checked,
        voiceReplies: document.getElementById('s-voiceReplies').checked,
        proposerHealth: document.getElementById('s-proposerHealth').checked,
        brainToolCallCap: num('s-brainToolCallCap', 30),
      };
      try {
        await api('/settings', { method: 'POST', body: JSON.stringify(body) });
        const note = document.getElementById('savedNote');
        note.style.display = '';
        setTimeout(() => { note.style.display = 'none'; }, 2000);
        refreshBadges();
      } catch (err) { showAlert(err.message); }
    });
  }

  // --- boot ---

  // The live channel drives the rail: a badge or a flicker whenever something
  // happens, whichever view you're on.
  if (window.HorstLive) {
    window.HorstLive.onStatus((state) => {
      const dot = document.getElementById('liveDot');
      if (dot) dot.className = `rail-live ${state}`;
    });
    window.HorstLive.on('horst:proposal', () => refreshBadges());
    window.HorstLive.on('horst:directives', () => refreshBadges());
    const flicker = (selector) => {
      const btn = document.querySelector(selector);
      if (!btn) return;
      btn.classList.remove('busy');
      void btn.getBoundingClientRect();
      btn.classList.add('busy');
      setTimeout(() => btn.classList.remove('busy'), 1200);
    };
    window.HorstLive.on('horst:event', () => flicker('.rail-btn[data-view="timeline"]'));
  }

  refreshBadges();
  setInterval(refreshBadges, 30000);

  // Map on first visit — it explains the system before you have to use it —
  // then whatever you were last looking at.
  setView(localStorage.getItem('horst-view') || 'map');
})();
