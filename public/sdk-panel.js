// Agent SDK panel: the HTML view of an `kind:'sdk'` CLI tab. One panel per
// tab, drawn as a diagram: the orchestrator's box spans the top, one box per
// worker sits in a row below it (workers are hidden sessions with no tab of
// their own), and an SVG behind the boxes joins them. A plain SDK tab has a
// single box. Each box shows one view at a time — Live or Notes — under a
// caption on its top border: name, model (click to switch), state (with a ■
// that stops the session's current turn while it works), cost; at
// its right end the main agent's context use, then the Inspector button. Live
// is split: the TODO table on top, below it the agent's text and the
// `description` of its tool calls, and the same of its subagents, chipped by
// type and launch order ("Explore 2"), the user's turns and, at each stop of
// the main agent, a rule with its time; thinking, notices and messages are
// only in the Inspector. A turn the agent has not taken in yet waits as a
// chip under the feed; its bubble lands where the agent took it in. A splitter between the two moves (double-click:
// back to the table's own height); the last position is kept for new boxes.
// Every box opens on Live. Each pane of Live has a ⤢ in its corner that opens
// it big in a dialog, still live; ×, Esc or the backdrop puts it back.
// A closed or ended worker leaves the row for the shelf, a column in the
// stage's top-left corner, left of the orchestrator's box: one card per
// worker, newest closed first (foldable to a tab, per run). A card opens that
// worker's box, dashed, first in the row, one at a time; its caption's ◂ (or
// the card again) puts it back. A row with no box takes no room: the
// orchestrator's box and the shelf fill the stage.
//
// Everything shown is server state: when a box is first shown and after a
// reconnect it asks for `sdk:history` (the newest page of the session's
// transcript, no stream deltas), replays it, then continues from the live
// `sdk:event` broadcasts. The caption's cost and compaction count are the
// reply's `totals`, the server's over the session folder's whole transcript
// (every session that ran in it), then moved by live status and
// compact_boundary events; what a page replays gives way to them. The feed
// is a window: it keeps its newest FEED_MAX entries while following, and
// "Load earlier" at its top puts the page before them back. A box hidden for RELEASE_MS (its tab not active, or a
// worker on the shelf) drops its feed and only keeps its caption up to
// date; shown again, it asks for the newest page. TODO.md
// and NOTES.md come from `sdk:todo`, re-asked on the session's own edits to
// them (`platform.files`), run membership from GET /api/orchestration/run.
// The composer has no remembered target: every message is sent through one
// dialog that shows the session map with the orchestrator selected; Tab moves
// the selection, a fresh Enter sends.
// The toolbar's billing toggle (Subscription | API credits) switches the
// whole run, or a plain tab's session (cli:sessionAuth): each box's status
// names its credential and a switch waiting for its turn's end; members on
// different ones show both halves part-lit. A turn the subscription's usage
// limit stopped leaves a card in its feed (platform `usage-limit`) whose
// button switches to API credits and continues it; the toggle lights up too.
// cli.js owns the tab; this file owns what is inside its wrap.
(function () {
  const D = window.dashboard;
  const { sendWs, state, escHtml, renderMarkdown, renderMarkdownDebounced, cancelRenderDebounce } = D;

  const POLL_MS = 15000;           // backstop: TODO/NOTES edits normally arrive as platform.files
  const TICK_MS = 1000;            // the "now:" line's elapsed time
  const HISTORY_WAIT_MS = 10000;
  const PAGE = 500;                // envelopes per sdk:history page
  const FEED_MAX = 500;            // feed entries a box keeps while following
  const FEED_HARD_MAX = 3000;      // ... and while the reader is scrolled back
  const SEEN_MAX = 2000;           // recent message uuids kept to skip repeats
  const MAP_MAX = 2000;            // backstop for the per-message and per-tool maps
  const RELEASE_MS = 60000;        // hidden this long, a box drops its feed
  const FOLLOW_SLACK_PX = 48;
  const USER_SCROLL_MS = 800;      // a scroll this soon after the reader's input is theirs
  const LINK_FLASH_MS = 1600;
  const VIEWS = ['live', 'notes'];
  const VIEW_STORE = 'sdkPanelViews';
  const VIEW_STORE_MAX = 200;
  const SHELF_STORE = 'sdkShelfFolded';  // per run: the shelf folded to a tab
  const SPLIT_STORE = 'sdkTodoSplit';   // the TODO table's share of the view, %
  const SPLIT_MIN = 10;
  const SPLIT_MAX = 90;
  const FALLBACK_MODELS = ['fable', 'opus', 'sonnet', 'haiku'];

  const panels = new Map();   // tabId -> Panel
  const areas = new Map();    // sessId -> Area (across panels: workers have no tab)
  let _lastWs = null;

  // ---- small helpers -------------------------------------------------------

  const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const fmtCost = (usd) => typeof usd === 'number' && isFinite(usd)
    ? `$${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)}` : '';
  const fmtSecs = (ms) => ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
  const fmtAgo = (ms) => ms < 60000 ? `${Math.max(0, Math.floor(ms / 1000))}s` : ms < 3600000 ? `${Math.floor(ms / 60000)}m`
    : ms < 86400000 ? `${Math.floor(ms / 3600000)}h` : `${Math.floor(ms / 86400000)}d`;
  const fmtAge = (ms) => ms >= 60000 ? `${Math.floor(ms / 60000)}m ${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}s` : `${Math.floor(ms / 1000)}s`;
  const costOf = (c) => typeof c === 'number' ? c
    : c && typeof c === 'object' ? (c.usd ?? c.costUsd ?? c.totalUsd ?? c.total ?? null) : null;
  const isDone = (s) => /^(done|complete|completed|finished|dropped|✓|✔)/i.test(String(s || '').trim());
  const isDoing = (s) => /^(doing|in[ _-]?progress|wip|active|started)/i.test(String(s || '').trim());
  const isBlocked = (s) => /^(blocked|failed|error)/i.test(String(s || '').trim());
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const envKey = (ev) => ev?.sdk?.uuid ? `u:${ev.sdk.uuid}` : JSON.stringify(ev);
  // History holds the broadcast envelopes ({sessId, runId?, ts, ev}); take the ev.
  const unwrap = (rec) => (rec && typeof rec === 'object' && rec.ev && typeof rec.ev === 'object') ? rec.ev : rec;
  const ENDED = new Set(['exited', 'stopped', 'abandoned', 'closed']);
  // Billing: settings.auth ids, the credential a status names, their words.
  const AUTH_IDS = ['subscription', 'apikey'];
  const authOf = (credential) => credential === 'api-key' ? 'apikey' : 'subscription';
  const BILL_TEXT = { subscription: 'the Claude subscription', apikey: 'API credits' };
  const BILL_SHORT = { subscription: 'Sub', apikey: 'API' };
  const STATE_TEXT = { busy: 'busy', idle: 'idle', awaiting: 'awaiting answer', paused: 'paused', exited: 'exited', pausing: 'pausing', closed: 'closed' };
  // `claude-sonnet-5-5` → `sonnet-5-5`; aliases and `[1m]` stay as they are.
  const fmtModel = (m) => String(m || '').replace(/^claude-/, '');
  const fmtTokens = (n) => n >= 1e6 ? `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  const CTX_WARM = 0.7;            // of the auto-compact threshold (else the window)
  const CTX_HOT = 0.9;

  // The tool's one-line gist, as the Inspector shows it.
  function toolSummary(name, input) {
    if (!input || typeof input !== 'object') return '';
    if (name === 'Agent' || name === 'Task') return [input.subagent_type, input.description].filter(Boolean).join(': ');
    if (/(^|__)SendMessage$/.test(name)) return `→ ${input.to || ''}: ${oneLine(input.message || '')}`;
    if (name === 'Skill') return input.args || input.skill || '';
    if (input.file_path) return input.file_path;
    if (input.command) return input.command;
    if (input.pattern) return input.pattern;
    if (input.query) return input.query;
    if (input.url) return input.url;
    if (input.description) return input.description;
    for (const v of Object.values(input)) if (typeof v === 'string' && v) return v;
    return '';
  }
  // A user turn in one line: its text, its images as a count.
  const userGist = (u) => {
    const n = Array.isArray(u.images) ? u.images.length : 0;
    return [oneLine(u.text), n ? `${n} image${n === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  };
  const prettyTool = (name) => {
    const m = /^mcp__(.+?)__(.+)$/.exec(name || '');
    return m ? `${m[1]} · ${m[2]}` : (name || 'tool');
  };
  function selectionInside(node) {
    const sel = window.getSelection?.();
    return !!(sel && !sel.isCollapsed && sel.anchorNode && node.contains(sel.anchorNode));
  }
  // `orch-<runId>-w2-fix-login` → `w2-fix-login`, `orch-<runId>` → `orch`.
  function shortName(name, run) {
    name = String(name || '');
    const orch = run?.orchestrator;
    if (orch && name === orch) return 'orch';
    if (orch && name.startsWith(orch + '-')) return name.slice(orch.length + 1);
    return name.replace(/^orch-[^-]+-/, '').replace(/^orch-[^-]+$/, 'orch');
  }
  // ---- the feed window (pure; test/sdk-feed-window.test.js) ----

  // How many of a feed's `count` oldest entries go: down to `max` while the
  // reader follows the live end; scrolled back, only past `hardMax`, so what
  // they are reading stays.
  function feedExcess(count, following, max = FEED_MAX, hardMax = FEED_HARD_MAX) {
    if (count > hardMax) return count - (following ? max : hardMax);
    return following && count > max ? count - max : 0;
  }
  // The page above the entries kept, from their transcript offsets (oldest
  // first; null for one drawn from no stored line, e.g. a stream delta's
  // block): everything before the oldest stored one. None known: `cur`.
  function cursorAbove(offs, cur) {
    for (const off of offs) if (typeof off === 'number') return { before: off, hasMore: off > 0 };
    return cur;
  }
  // A Map or Set past `max`: its oldest entries go (insertion order), those
  // `droppable` lets go.
  function capOldest(coll, max, droppable = () => true) {
    if (coll.size <= max) return;
    for (const [k, v] of coll.entries()) {
      if (coll.size <= max) break;
      if (droppable(v)) coll.delete(k);
    }
  }

  // Scroll `node` (inside the scroller `box`) to a third of the box's height.
  function scrollToNode(box, node) {
    const top = node.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTop = Math.max(0, top - box.clientHeight / 3);
  }

  // Navigation keys scroll whatever the reader last clicked; typing does not.
  const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
  let _navKeyAt = 0;
  document.addEventListener('keydown', (e) => {
    if (NAV_KEYS.has(e.key) && !e.target?.closest?.('input, textarea, select, [contenteditable], vc-composer')) _navKeyAt = Date.now();
  }, true);

  // Live follow for one scroller (the feed, the TODO table): pinned to the
  // bottom while following. Only the reader stops it, by scrolling up (wheel,
  // touch, the scrollbar, keys); the "Go to bottom" chip then shows until
  // they click it or scroll back down. Any other move is undone: a box put
  // back into the DOM resets its scrollers to the top, a hidden view comes
  // back at the top; it returns to the bottom, or to the reader's place.
  class Follower {
    constructor(box, chip, { skip } = {}) {
      this.box = box;
      this.chip = chip;
      this.skip = skip;          // () => true while a pin must wait (a selection inside)
      this.on = true;
      this.top = 0;              // the reader's place while not following
      this._userAt = 0;
      this._held = false;
      const user = () => { this._userAt = Date.now(); };
      const release = () => {
        this._held = false;
        user();
        document.removeEventListener('pointerup', release, true);
        document.removeEventListener('pointercancel', release, true);
      };
      box.addEventListener('wheel', user, { passive: true });
      box.addEventListener('touchmove', user, { passive: true });
      // The scrollbar, or a selection dragged past the edge.
      box.addEventListener('pointerdown', () => {
        this._held = true;
        document.addEventListener('pointerup', release, true);
        document.addEventListener('pointercancel', release, true);
      });
      box.addEventListener('scroll', () => this._onScroll(), { passive: true });
      chip.addEventListener('click', () => this.pin());
      // Every change inside (new rows, deltas, the debounced markdown render
      // that lands later, a line shown) and every resize (the splitter, the
      // box shown again) goes through here, so following never lags a render.
      this._mo = new MutationObserver(() => this.settle());
      this._mo.observe(box, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
      this._ro = new ResizeObserver(() => this.settle());
      this._ro.observe(box);
    }

    destroy() {
      this._mo.disconnect();
      this._ro.disconnect();
      cancelAnimationFrame(this._raf);
    }

    _atBottom() {
      const b = this.box;
      return b.scrollHeight - b.scrollTop - b.clientHeight <= FOLLOW_SLACK_PX;
    }
    _byUser() { return this._held || Date.now() - Math.max(this._userAt, _navKeyAt) < USER_SCROLL_MS; }
    _set(on) {
      this.on = on;
      this.chip.classList.toggle('hidden', on);
    }

    _onScroll() {
      const b = this.box;
      if (!b.clientHeight) return;   // hidden: nothing the reader did
      if (this._atBottom()) this._set(true);
      else if (this._byUser()) { this._set(false); this.top = b.scrollTop; }
      else if (this.on || (b.scrollTop === 0 && this.top > 0)) this.settle();
      else this.top = b.scrollTop;   // the browser kept the reader's rows in view
    }

    // Rows were put above the reader's: held where they now are.
    hold(top) {
      this._set(false);
      this.top = top;
    }

    // The chip: to the bottom, following again.
    pin() {
      this._set(true);
      this.box.scrollTop = this.box.scrollHeight;
    }

    settle() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = null;
        const b = this.box;
        if (!b.clientHeight) return;
        if (this.on) { if (!this.skip?.()) b.scrollTop = b.scrollHeight; }
        else if (b.scrollTop === 0 && this.top > 0) b.scrollTop = this.top;
      });
    }
  }

  // Small maps across reloads (most recent last): the view each box shows,
  // per session; the shelf folded, per run. A null value is dropped.
  function storedKey(store, key) {
    try { return JSON.parse(localStorage.getItem(store) || '{}')?.[key] || null; } catch { return null; }
  }
  function storeKey(store, key, value) {
    try {
      const m = JSON.parse(localStorage.getItem(store) || '{}') || {};
      delete m[key];
      if (value != null) m[key] = value;
      const keys = Object.keys(m);
      for (const k of keys.slice(0, Math.max(0, keys.length - VIEW_STORE_MAX))) delete m[k];
      localStorage.setItem(store, JSON.stringify(m));
    } catch {}
  }

  // ---- Area: one agent's box -----------------------------------------------

  class Area {
    constructor(panel, sessId, { role, name, label }) {
      this.panel = panel;
      this.sessId = sessId;
      this.role = role;              // 'orchestrator' | 'worker' | 'single'
      this.name = name || sessId;
      this.label = label || this.name;
      this.aliases = new Set([sessId, this.name, this.label]);
      this.state = null;
      this.gotStatus = false;
      this.cost = null;
      this.lastReport = null;
      this.closed = false;           // closed by its orchestrator (run membership)
      this.closedAt = null;          // ms
      this.model = null;             // chosen (settings.model)
      this.actualModel = null;       // what the API answered with
      this.mappedTo = null;          // the tab's modelMap target, when it rewrites
      this.initModel = null;         // system/init, before any status names one
      this.todo = null;
      this.context = null;           // { tokens, window, compactAt, windowEstimated } from the status
      this.queue = [];
      this.historyPending = false;
      this.shown = false;            // see setShown
      this.stale = true;             // no feed loaded: it loads when shown
      this.compactions = 0;
      // A stored view this panel no longer has (the old TODO) opens Live.
      this.view = storedKey(VIEW_STORE, sessId) || 'live';
      this._build();
      this.reset();
      this.setView(this.view, { store: false });
      areas.set(sessId, this);
    }

    _build() {
      const root = this.el = el('section', `sdk-area sdk-area-${this.role}`);
      root.dataset.sessId = this.sessId;
      root.innerHTML = `
        <div class="sdk-top">
          <div class="sdk-cap">
            <span class="sdk-area-name"></span>
            <button type="button" class="sdk-model" title="Change this session's model"></button>
            <span class="sdk-chip sdk-area-state"></span>
            <span class="sdk-chip sdk-area-bill hidden"></span>
            <button type="button" class="sdk-stop hidden" title="Stop what this session is doing now. It stays open and waits for your next message.">■</button>
            <span class="sdk-chip sdk-area-report hidden"></span>
            <span class="sdk-area-cost"></span>
            <button type="button" class="sdk-fresh hidden">↻ Fresh</button>
          </div>
          <div class="sdk-cap-right">
            <button type="button" class="sdk-shelve" title="Put it back on the shelf">◂ Shelf</button>
            <span class="sdk-ctx hidden"><span class="sdk-ctx-bar"><i></i></span><span class="sdk-ctx-txt"></span></span>
            <button type="button" class="sdk-insp" title="Open this session in the Inspector: every request, tool call and result"><span class="sdk-insp-l">Inspector</span></button>
          </div>
        </div>
        <div class="sdk-bar">
          <div class="sdk-seg">
            <button type="button" data-v="live">Live</button><button type="button" data-v="notes">Notes</button>
          </div>
          <div class="sdk-now"></div>
        </div>
        <div class="sdk-area-awaiting hidden">Awaiting your answer: the question is open in the dialog.</div>
        <div class="sdk-main">
          <div class="sdk-view sdk-view-live">
            <div class="sdk-todo-top">
              <div class="sdk-todo-scroll">
                <div class="sdk-area-final hidden"></div>
                <div class="sdk-todo-wrap"></div>
              </div>
              <button type="button" class="sdk-live-pill hidden">↓ Go to bottom</button>
              <button type="button" class="sdk-max-btn" title="Maximize">⤢</button>
            </div>
            <div class="sdk-todo-split" title="Drag to resize · double-click to reset"></div>
            <div class="sdk-todo-lite">
              <div class="sdk-feed-wrap">
                <div class="sdk-feed lite"><button type="button" class="sdk-feed-more hidden">Load earlier</button></div>
                <button type="button" class="sdk-live-pill hidden">↓ Go to bottom</button>
              </div>
              <div class="sdk-pending hidden"></div>
              <button type="button" class="sdk-max-btn" title="Maximize">⤢</button>
            </div>
          </div>
          <div class="sdk-view sdk-view-notes markdown-body"></div>
        </div>`;
      const q = (s) => root.querySelector(s);
      this.nameEl = q('.sdk-area-name');
      this.modelBtn = q('.sdk-model');
      this.stateEl = q('.sdk-area-state');
      this.billEl = q('.sdk-area-bill');
      this.stopBtn = q('.sdk-stop');
      this.reportEl = q('.sdk-area-report');
      this.costEl = q('.sdk-area-cost');
      this.freshBtn = q('.sdk-fresh');
      this.ctxEl = q('.sdk-ctx');
      this.ctxFill = q('.sdk-ctx-bar > i');
      this.ctxTxt = q('.sdk-ctx-txt');
      this.nowEl = q('.sdk-now');
      this.awaitEl = q('.sdk-area-awaiting');
      this.finalEl = q('.sdk-area-final');
      this.todoTop = q('.sdk-todo-top');
      this.todoView = q('.sdk-todo-scroll');
      this._initSplit(q('.sdk-view-live'), q('.sdk-todo-split'));
      this.todoEl = q('.sdk-todo-wrap');
      this.notesEl = q('.sdk-view-notes');
      this.feed = q('.sdk-feed');
      this.moreEl = q('.sdk-feed-more');
      this.moreEl.addEventListener('click', () => this.loadEarlier());
      this.pendingEl = q('.sdk-pending');
      const lite = q('.sdk-todo-lite');
      q('.sdk-todo-top > .sdk-max-btn').addEventListener('click', () => openMax(this, this.todoTop, 'TODO'));
      q('.sdk-todo-lite > .sdk-max-btn').addEventListener('click', () => openMax(this, lite, 'Live feed'));
      this.segBtns = Object.fromEntries([...root.querySelectorAll('.sdk-seg button')].map(b => [b.dataset.v, b]));

      for (const [v, b] of Object.entries(this.segBtns)) b.addEventListener('click', () => this.setView(v));
      this.modelBtn.addEventListener('click', (e) => { e.stopPropagation(); openModelMenu(this, this.modelBtn); });
      this.stopBtn.addEventListener('click', () => this.stop());
      this.freshBtn.addEventListener('click', () => this.panel.refresh());
      q('.sdk-shelve').addEventListener('click', () => this.panel.openShelved(null));
      q('.sdk-insp').addEventListener('click', () => {
        // Straight to this session's tab, opened (and loaded) if need be.
        if (typeof switchView === 'function') switchView('dashboard');
        window.inspectorModule?.openSession?.(`cli-${this.sessId}`);
      });

      // Both halves of Live follow their newest rows until the reader scrolls
      // up; a selection being made in the feed holds it where it is.
      this.feedFollow = new Follower(this.feed, q('.sdk-feed-wrap > .sdk-live-pill'), { skip: () => selectionInside(this.feed) });
      this.todoFollow = new Follower(this.todoView, q('.sdk-todo-top > .sdk-live-pill'));
      this.renderHeader();
    }

    // The TODO table's height: the stored share, or (none) its own content
    // height up to the CSS cap.
    _initSplit(view, handle) {
      const apply = (pct) => {
        this.todoTop.style.flexBasis = pct == null ? '' : `${pct}%`;
        this.todoTop.classList.toggle('sized', pct != null);
      };
      let stored = null;
      try { stored = parseFloat(localStorage.getItem(SPLIT_STORE)); } catch {}
      apply(isFinite(stored) ? stored : null);
      let dragging = false;
      let pct = null;
      handle.addEventListener('pointerdown', (e) => {
        dragging = true;
        handle.classList.add('dragging');
        handle.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const r = view.getBoundingClientRect();
        if (!r.height) return;
        pct = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ((e.clientY - r.top) / r.height) * 100));
        apply(Math.round(pct * 10) / 10);
      });
      const end = (e) => {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove('dragging');
        try { handle.releasePointerCapture(e.pointerId); } catch {}
        if (pct != null) { try { localStorage.setItem(SPLIT_STORE, String(Math.round(pct * 10) / 10)); } catch {} }
      };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
      handle.addEventListener('dblclick', () => {
        pct = null;
        apply(null);
        try { localStorage.removeItem(SPLIT_STORE); } catch {}
      });
    }

    destroy() {
      if (_max?.area === this) closeMax();
      this.feedFollow.destroy();
      this.todoFollow.destroy();
      clearTimeout(this._historyTimer);
      clearTimeout(this._olderTimer);
      clearTimeout(this._releaseTimer);
      if (areas.get(this.sessId) === this) areas.delete(this.sessId);
      this.el.remove();
    }

    addAliases(list) { for (const n of list) if (n) this.aliases.add(String(n)); }
    isMe(name) { return !!name && (this.aliases.has(name) || this.aliases.has(shortName(name, this.panel.run))); }
    ended() { return this.closed || ENDED.has(this.state); }
    // Working, waiting on a question or pausing: there is something to stop.
    stoppable() { return !this.ended() && (this.state === 'busy' || this.state === 'awaiting' || this.state === 'pausing'); }
    // The session drops its current turn and waits for the next message.
    stop() { if (this.stoppable()) sendWs({ type: 'sdk:interrupt', sessId: this.sessId }); }
    // A worker on the shelf (paused ones stay in the row).
    shelved() { return this.role === 'worker' && this.ended(); }
    shownModel() { return this.actualModel || this.model || this.initModel || ''; }

    // ---- view toggle ----

    setView(v, { store = true } = {}) {
      if (!VIEWS.includes(v)) v = 'live';
      this.view = v;
      if (store) storeKey(VIEW_STORE, this.sessId, v);
      this.el.dataset.view = v;
      for (const [k, b] of Object.entries(this.segBtns)) b.classList.toggle('on', k === v);
      if (v === 'live') {
        this.segBtns.live.classList.remove('unread');
        this.renderTodo();
      } else {
        this.renderNotes({ scroll: true });
      }
    }

    // Something new to read in Live while Notes is showing.
    markUnread() {
      if (this.view !== 'live' && !this._replaying) this.segBtns.live.classList.add('unread');
    }

    // ---- header ----

    setState(s) {
      if (!s || s === this.state) return;
      this.state = s;
      if (s !== 'busy' && s !== 'awaiting') this.nowTool = null;
      // A session that ended will take nothing more in.
      if (ENDED.has(s)) for (const id of [...this.pending.keys()]) this.cancelPending(id, 'ended');
      this.renderHeader();
      this.panel.renderToolbar();
      if (this.role === 'worker') this.panel.layoutWorkers();
      else this.panel.drawLinksSoon();
      window.cliModule?.updateStreamingState?.();
    }

    setCost(c) {
      if (typeof c !== 'number' || !isFinite(c)) return;
      this.cost = c;
      this.renderHeader();
      this.panel.renderToolbar();
    }

    renderHeader() {
      this.nameEl.textContent = this.label;
      this.nameEl.title = this.name;
      const s = this.state || 'idle';
      const ended = this.ended();
      this.stateEl.textContent = this.closed ? 'closed' : STATE_TEXT[s] || s;
      // Idle says nothing the header does not: no chip (and no gap) for it.
      this.stateEl.className = `sdk-chip sdk-area-state sdk-state-${ended ? 'exited' : s}${s === 'idle' && !ended ? ' hidden' : ''}`;
      this.stopBtn.classList.toggle('hidden', !this.stoppable());
      this.awaitEl.classList.toggle('hidden', s !== 'awaiting');
      const r = this.lastReport;
      const rs = String(r?.status || '').toLowerCase().replace(/[^a-z]/g, '');
      this.el.classList.toggle('sdk-area-is-awaiting', s === 'awaiting');
      this.el.classList.toggle('sdk-area-is-busy', s === 'busy');
      this.el.classList.toggle('sdk-area-ended', ended);
      this.el.classList.toggle('sdk-area-is-blocked', !ended && (rs === 'blocked' || rs === 'failed'));
      this.reportEl.classList.toggle('hidden', !r);
      if (r) {
        this.reportEl.textContent = r.status || 'report';
        this.reportEl.title = r.summary || '';
        this.reportEl.className = `sdk-chip sdk-area-report sdk-report-${rs}`;
      }
      // The last report heads the TODO table once ended, or when there is no TODO.
      this.finalEl.classList.toggle('hidden', !(r?.summary && (ended || !this.todo?.rows?.length)));
      if (r?.summary) this.finalEl.textContent = `${r.status || 'report'}: ${r.summary}`;
      this.costEl.textContent = fmtCost(this.cost);
      this.costEl.title = this.credential ? `Billed to ${BILL_TEXT[authOf(this.credential)]}` : '';
      this.renderBill();
      const m = this.shownModel();
      this.modelBtn.textContent = m ? `${fmtModel(m)}${this.mappedTo ? ` → ${fmtModel(this.mappedTo)}` : ''} ▾` : 'model ▾';
      this.modelBtn.title = [
        this.model ? `Chosen: ${this.model}` : null,
        this.actualModel ? `Answering: ${this.actualModel}` : null,
        this.mappedTo ? `Rewritten by this tab's model map to: ${this.mappedTo}` : null,
        ended ? 'The session has ended.' : 'Click to switch the model; the context and the cost so far are kept.',
      ].filter(Boolean).join('\n');
      this.modelBtn.disabled = ended;
      const t = this.todo?.rows || [];
      const done = t.filter(x => isDone(x.status)).length;
      this.segBtns.live.textContent = t.length ? `Live ${done}/${t.length}` : 'Live';
      this.renderContext();
      this.renderNow();
    }

    // Quiet unless it matters: a switch waiting for this session's turn to
    // end, or (members on different billing) which one this box is on.
    renderBill() {
      const pending = !this.ended() && this.authPending;
      const mixed = !this.ended() && this.credential && this.panel.billing().on.size > 1;
      this.billEl.classList.toggle('hidden', !(pending || mixed));
      this.billEl.classList.toggle('pending', !!pending);
      this.billEl.textContent = pending ? `→ ${BILL_SHORT[pending]} after this turn` : mixed ? BILL_SHORT[authOf(this.credential)] : '';
      this.billEl.title = pending ? `Switching to ${BILL_TEXT[pending]} after this turn: nothing is cut off.`
        : mixed ? `This session is billed to ${BILL_TEXT[authOf(this.credential)]}.` : '';
    }

    // A turn the subscription's usage limit stopped: what happened and, with
    // an API key stored, one click that continues it on API credits (the
    // whole run for a run's member: the limit is the account's).
    limitNotice(p) {
      const n = el('div', 'sdk-notice sdk-notice-warn sdk-limit');
      const when = p.resetsAt ? ` · resets ${new Date(p.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
      n.appendChild(el('div', 'sdk-limit-head', `Claude subscription usage limit reached${when}`));
      if (p.text) n.appendChild(el('div', 'sdk-limit-text', p.text));
      if (p.apiKey) {
        const run = !!this.panel.runId || this.role === 'worker';
        const b = el('button', 'sdk-tb-btn sdk-limit-go', 'Continue on API credits');
        b.type = 'button';
        b.title = run ? 'Every session of the run switches to API credits (the limit is the account\'s, so the others would hit it too); the ones it stopped continue.'
          : 'This session switches to API credits and continues the stopped turn.';
        b.addEventListener('click', () => {
          if (b.disabled) return;
          this._limitSent = true;
          sendWs({ type: 'cli:sessionAuth', sessId: this.sessId, auth: 'apikey', continue: true });
          this.renderLimit();
        });
        n.appendChild(b);
        if (run) n.appendChild(el('div', 'sdk-limit-hint', 'Switches the whole run'));
      } else {
        const line = el('div', 'sdk-limit-hint', 'No Anthropic API key is stored, so it cannot go on with API credits: add one on the ');
        const link = el('button', 'sdk-limit-link', 'Models page');
        link.type = 'button';
        link.addEventListener('click', () => { if (typeof switchView === 'function') switchView('models'); });
        line.append(link, document.createTextNode(', or wait for the reset.'));
        n.appendChild(line);
      }
      this.add(n);
      this.renderLimit();
      return n;
    }

    // The cards' buttons follow the session: open while it is stopped by the
    // limit, done once it went on.
    renderLimit() {
      const open = !!this.limited && !this.ended();
      if (!open) this._limitSent = false;
      for (const b of this.feed.querySelectorAll('.sdk-limit-go')) {
        b.disabled = !open || !!this._limitSent;
        b.textContent = open ? (this._limitSent ? 'Switching…' : 'Continue on API credits')
          : this.credential === 'api-key' ? '✓ Continued on API credits' : 'Continue on API credits';
        b.classList.toggle('hidden', !open && this.credential !== 'api-key');
      }
    }

    // The main agent's context: % of the window, exact or the model
    // catalogue's estimate (tokens only for a model the catalogue does not
    // know), warmer as it nears the auto-compact threshold.
    renderContext() {
      const c = this.context;
      this.ctxEl.classList.toggle('hidden', !(c?.tokens > 0));
      if (!(c?.tokens > 0)) return;
      const pct = c.window > 0 ? (c.tokens / c.window) * 100 : null;
      const limit = c.compactAt || c.window;
      const level = limit ? c.tokens / limit : 0;
      this.ctxEl.className = `sdk-ctx${level >= CTX_HOT ? ' hot' : level >= CTX_WARM ? ' warm' : ''}${pct == null ? ' no-window' : ''}`;
      this.ctxTxt.textContent = pct == null ? fmtTokens(c.tokens) : pct < 1 ? '<1%' : `${Math.round(pct)}%`;
      this.ctxFill.style.width = pct == null ? '0' : `${Math.min(100, pct)}%`;
      const n = (v) => Math.round(v).toLocaleString();
      this.ctxEl.title = [
        pct != null ? `Context: ${n(c.tokens)} of ${n(c.window)} tokens (${pct.toFixed(1)}%)` : `Context: ${n(c.tokens)} tokens`,
        pct == null ? 'Context window not known yet: this model is not in the model catalogue, the end of the turn tells.'
          : c.windowEstimated ? 'Window estimated from the model catalogue until the end of the turn gives the exact one.' : null,
        c.compactAt ? `Auto-compacts at ${n(c.compactAt)} tokens (${Math.round((c.tokens / c.compactAt) * 100)}% of the way)` : null,
        this.compactions ? `Compacted ${this.compactions}× so far` : 'Not compacted yet',
        'The main agent only: each subagent has its own context.',
      ].filter(Boolean).join('\n');
    }

    // One line under the caption: what the agent is doing right now.
    renderNow() {
      const s = this.state || 'idle';
      let text = '';
      let cls = 'idle';
      if (this.ended()) text = 'ended';
      else if (s === 'awaiting') { text = 'waiting for your answer'; cls = 'awaiting'; }
      else if (s === 'pausing') { text = 'pausing: writing its resume note'; cls = 'busy'; }
      else if (s === 'paused') text = 'paused';
      else if (s === 'busy') {
        cls = 'busy';
        const t = this.nowTool;
        if (t) {
          const age = t.startedAt ? ` · ${fmtAge(Date.now() - t.startedAt)}` : '';
          text = `now: ${prettyTool(t.name)} ${t.input?.gist || ''}`.trim() + age;
        } else {
          text = 'now: thinking…';
        }
      } else text = 'idle';
      if (text !== this._nowText) { this._nowText = text; this.nowEl.textContent = text; this.nowEl.title = text; }
      this.nowEl.className = `sdk-now sdk-now-${cls}`;
    }

    // ---- TODO.md / NOTES.md ----

    requestTodo() { sendWs({ type: 'sdk:todo', sessId: this.sessId }); }

    onTodo(msg) {
      const rows = Array.isArray(msg.rows) ? msg.rows : [];
      const notes = typeof msg.notes === 'string' ? msg.notes : '';
      const sig = JSON.stringify([rows, notes]);
      if (sig === this._todoSig) return;
      this._todoSig = sig;
      const notesChanged = notes !== this.todo?.notes;
      this.todo = { rows, notes };
      this.renderTodo();
      if (notesChanged) this.renderNotes({ scroll: true });
      this.renderHeader();
    }

    // The table fits its box: id and status stay narrow, a description wraps
    // to two lines (the whole text is its tooltip). Its follower keeps the
    // newest rows in view.
    renderTodo() {
      const rows = this.todo?.rows || [];
      const sig = this._todoSig || '';
      if (this._todoDrawn !== sig) {
        this._todoDrawn = sig;
        this.todoEl.innerHTML = rows.length
          ? `<table class="sdk-todo"><colgroup><col class="sdk-todo-c-id"><col><col class="sdk-todo-c-st"></colgroup><tbody>${rows.map(r => {
            const st = String(r.status || '');
            const cls = isDoing(st) ? 'doing' : isDone(st) ? 'done' : isBlocked(st) ? 'blocked' : 'open';
            const tip = [r.description || '', r.dependsOn ? `depends on ${r.dependsOn}` : '', st].filter(Boolean).join('\n');
            return `<tr class="sdk-todo-${cls}" title="${escHtml(tip)}"><td class="sdk-todo-id">${escHtml(r.id)}</td>`
              + `<td class="sdk-todo-desc"><div class="sdk-clamp">${escHtml(r.description || '')}</div></td>`
              + `<td class="sdk-todo-st"><span class="sdk-chip sdk-todo-chip sdk-todo-chip-${cls}">${escHtml(clip(st || '—', 40))}</span></td></tr>`;
          }).join('')}</tbody></table>`
          : '<div class="sdk-empty">No TODO.md yet.</div>';
      }
    }

    // Rendered only while showing; on a change it scrolls to `## Resume`.
    renderNotes({ scroll } = {}) {
      if (this.view !== 'notes') return;
      const notes = this.todo?.notes || '';
      if (this._notesShown === notes) return;
      this._notesShown = notes;
      if (!notes) { this.notesEl.innerHTML = '<div class="sdk-empty">No NOTES.md yet.</div>'; return; }
      renderMarkdown(notes, this.notesEl, { file: true });
      if (!scroll) return;
      const resume = [...this.notesEl.querySelectorAll('h1, h2, h3')].find(h => /^\s*resume\b/i.test(h.textContent));
      if (resume) scrollToNode(this.notesEl, resume);
    }

    // ---- feed: history, then live ----

    reset() {
      this.feed.replaceChildren(this.moreEl);
      this.msgs = new Map();      // message.id -> {id, pk, blocks}
      this.streams = new Map();   // parent_tool_use_id|'' -> {rec, byIndex}
      this.tools = new Map();     // tool_use_id -> {id, name, input, done, startedAt}
      this.subs = new Map();      // Agent tool_use_id -> {label, color, description}
      this.subCounts = new Map(); // subagent type -> runs so far
      this.subRuns = 0;
      this.nowTool = null;
      this.seen = new Set();      // the newest SEEN_MAX message uuids
      this.pending = new Map();   // user turn id -> its "waiting" chip
      this.pendingEl.innerHTML = '';
      this.pendingEl.classList.add('hidden');
      clearTimeout(this._olderTimer);
      this._olderFrom = undefined;
      this.setTop({ before: null, hasMore: false });
    }

    requestHistory() {
      this.stale = false;
      this.historyPending = true;
      this.queue = [];
      clearTimeout(this._historyTimer);
      // A server without sdk:history (or a lost reply) must not hold the live
      // feed back forever.
      this._historyTimer = setTimeout(() => {
        if (!this.historyPending) return;
        this.onHistory([], 'history did not arrive');
      }, HISTORY_WAIT_MS);
      sendWs({ type: 'sdk:history', sessId: this.sessId, limit: PAGE });
    }

    // An sdk:history reply: the newest page (`from` null) or an older one.
    onPage(page) {
      const events = Array.isArray(page.events) ? page.events : [];
      if (page.from != null) this.onOlder(page, events);
      else if (this.historyPending) this.onHistory(events, page.error, page);
    }

    onHistory(events, error, page = {}) {
      clearTimeout(this._historyTimer);
      // Without the server's totals: counted again from the page, never
      // fewer than this box has seen.
      const compactions = this.compactions;
      this.reset();
      this.compactions = 0;
      const keys = new Set();
      this._replaying = true;
      for (const rec of events) {
        const ev = unwrap(rec);
        keys.add(envKey(ev));
        this._off = ev !== rec && typeof rec.off === 'number' ? rec.off : null;
        try { this.apply(ev, false, ev !== rec ? rec.ts : null); } catch (e) { console.warn('sdk-panel: history event', e, ev); }
      }
      this._off = null;
      this._replaying = false;
      // The caption covers the whole session folder, not the page: the
      // server's totals over its transcript replace what the page counted.
      const t = page.totals;
      if (t && typeof t.costUsd === 'number') this.setCost(t.costUsd);
      if (t && typeof t.compactions === 'number') this.compactions = t.compactions;
      else this.compactions = Math.max(compactions, this.compactions);
      this.renderContext();
      this.setTop({ before: page.before ?? null, hasMore: !!page.hasMore });
      if (error) this.notice(`History: ${error}`, 'warn');
      const queued = this.queue;
      this.queue = [];
      this.historyPending = false;
      // Live events that raced the history reply; the ones history already
      // holds are skipped (deltas are never in history and always pass).
      for (const { ev, ts, off } of queued) {
        if (ev?.sdk?.type !== 'stream_event' && keys.has(envKey(ev))) continue;
        this._off = off;
        try { this.apply(ev, true, ts); } catch (e) { console.warn('sdk-panel: live event', e, ev); }
      }
      this._off = null;
      this.trim();
      this.renderNow();
    }

    // ts: the envelope's server time (ms), off: its transcript offset, when
    // it has them. A released box only keeps its caption up to date.
    receive(ev, ts, off) {
      if (this.stale) { try { this.applyCaption(ev); } catch (e) { console.warn('sdk-panel: event', e, ev); } return; }
      if (this.historyPending) { this.queue.push({ ev, ts, off }); return; }
      this._off = typeof off === 'number' ? off : null;
      try { this.apply(ev, true, ts); } catch (e) { console.warn('sdk-panel: event', e, ev); }
      this._off = null;
      this.trim();
    }

    // ---- the feed window ----

    // A new entry at the feed's end, tagged with the transcript offset of the
    // envelope being applied (null: none yet, e.g. a block drawn from stream
    // deltas, until its complete message comes).
    add(node) {
      node.vcOff = this._off ?? null;
      return this.feed.appendChild(node);
    }

    // The page above the feed, and the "Load earlier" row that asks for it.
    setTop(top) {
      this.top = top;
      this.moreEl.classList.toggle('hidden', !top.hasMore);
      this.moreEl.disabled = this._olderFrom !== undefined;
      this.moreEl.textContent = this.moreEl.disabled ? 'Loading…' : 'Load earlier';
    }

    * entryOffs() {
      for (let e = this.moreEl.nextElementSibling; e; e = e.nextElementSibling) yield e.vcOff;
    }

    // Past the cap, the oldest entries go with what the maps hold for them;
    // "Load earlier" then asks for what came before the oldest kept. The
    // reader's rows stay put when they are scrolled back.
    trim() {
      const following = this.feedFollow.on;
      const n = feedExcess(this.feed.childElementCount - 1, following);
      if (n <= 0) return;
      const h = this.feed.scrollHeight;
      for (let i = 0; i < n; i++) this.dropEntry(this.moreEl.nextElementSibling);
      if (!following) this.feed.scrollTop -= h - this.feed.scrollHeight;
      this.setTop(cursorAbove(this.entryOffs(), this.top));
    }

    dropEntry(node) {
      if (node.vcMsg) {
        this.msgs.delete(node.vcMsg);
        for (const [pk, s] of this.streams) if (s.rec.id === node.vcMsg) this.streams.delete(pk);
      }
      const t = node.vcTool ? this.tools.get(node.vcTool) : null;
      if (t && t.lineEl === node) {
        // A call still running keeps its record (the "now:" line, its result).
        t.lineEl = t.lineName = t.lineText = t.chipEl = null;
        if (t.done) this.forgetTool(t);
      }
      node.remove();
    }

    forgetTool(t) {
      this.tools.delete(t.id);
      this.subs.delete(t.id);
      this.streams.delete(t.id);
    }

    // The page before the oldest entry shown, put on top; the reader's rows
    // stay where they are.
    loadEarlier() {
      if (!this.top.hasMore || this._olderFrom !== undefined || this.stale) return;
      this._olderFrom = this.top.before;
      this.setTop(this.top);
      clearTimeout(this._olderTimer);
      this._olderTimer = setTimeout(() => { this._olderFrom = undefined; this.setTop(this.top); }, HISTORY_WAIT_MS);
      sendWs({ type: 'sdk:history', sessId: this.sessId, before: this._olderFrom, limit: PAGE });
    }

    onOlder(page, events) {
      if (this.stale || page.from !== this._olderFrom) return;
      clearTimeout(this._olderTimer);
      this._olderFrom = undefined;
      const sh = this.shadow();
      for (const rec of events) {
        const ev = unwrap(rec);
        sh._off = ev !== rec && typeof rec.off === 'number' ? rec.off : null;
        try { sh.apply(ev, false, ev !== rec ? rec.ts : null); } catch (e) { console.warn('sdk-panel: older event', e, ev); }
      }
      // A call still running at the page's end: this box's record, if it kept
      // one, takes the line over (its result updates it); else it has
      // finished since.
      for (const t of sh.tools.values()) {
        if (t.done || !t.lineEl) continue;
        const mine = this.tools.get(t.id);
        if (mine && !mine.lineEl && !mine.done) {
          Object.assign(mine, { lineEl: t.lineEl, lineName: t.lineName, lineText: t.lineText, chipEl: t.chipEl });
          this.renderToolLine(mine);
        } else {
          t.done = true;
          sh.renderToolLine(t);
        }
      }
      const box = this.feed;
      const h = box.scrollHeight;
      const top = box.scrollTop;
      this.moreEl.after(sh.feed);
      box.scrollTop = top + (box.scrollHeight - h);
      if (box.scrollHeight > box.clientHeight) this.feedFollow.hold(box.scrollTop);
      this.setTop({ before: page.before ?? null, hasMore: !!page.hasMore });
    }

    // Draws an older page: this box's methods and fields by inheritance, its
    // own maps and a detached feed, and nothing that reaches the caption, the
    // "now:" line, the pending chips or the window.
    shadow() {
      const sh = Object.create(this);
      Object.assign(sh, {
        feed: document.createDocumentFragment(),
        msgs: new Map(), streams: new Map(), tools: new Map(), subs: new Map(), subCounts: new Map(), subRuns: 0,
        seen: new Set(), pending: new Map(), pendingEl: el('div'),
        nowTool: null, gotStatus: true, initModel: null, _quietInit: true, _replaying: true,
      });
      for (const k of ['setState', 'setCost', 'renderHeader', 'renderContext', 'renderNow', 'markUnread', 'requestTodo', 'applyStatus', 'modelRefused', 'trim']) sh[k] = () => {};
      return sh;
    }

    // ---- shown, hidden, released ----

    // Shown: its panel's tab is active and the box is in the stage (not a
    // worker on the shelf). Hidden for RELEASE_MS, it drops its feed; shown
    // again sooner, everything is as it was.
    setShown(v) {
      v = !!v;
      if (v === this.shown) return;
      this.shown = v;
      // A box that leaves the stage takes its maximized pane with it.
      if (!v && _max?.area === this) closeMax();
      clearTimeout(this._releaseTimer);
      if (!v) this._releaseTimer = setTimeout(() => this.release(), RELEASE_MS);
      else if (this.stale) this.requestHistory();
    }

    // Everything the feed holds goes; the caption stays. Until it is shown
    // again its events only move the caption.
    release() {
      if (this.shown) return;
      clearTimeout(this._releaseTimer);
      clearTimeout(this._historyTimer);
      this.historyPending = false;
      this.queue = [];
      this.stale = true;
      this.reset();
    }

    // A released box's event: what the caption shows.
    applyCaption(ev) {
      const p = ev?.platform;
      if (p?.kind === 'status') return this.applyStatus(p);
      if (p?.kind === 'files') return this.requestTodo();
      if (p?.kind === 'notice' && /^Model not changed/.test(p.text || '')) return this.modelRefused();
      const m = ev?.sdk;
      if (!m || m.parent_tool_use_id) return;
      if (m.type === 'system' && m.subtype === 'compact_boundary') { this.compactions++; this.renderContext(); }
      else if (m.type === 'system' && m.subtype === 'init' && m.model && m.model !== this.initModel) { this.initModel = m.model; this.renderHeader(); }
    }

    apply(ev, live, ts) {
      if (!ev || typeof ev !== 'object') return;
      if (ev.sdk) return this.applySdk(ev.sdk, live, ts);
      if (ev.user) return this.applyUser(ev.user, live);
      const p = ev.platform;
      if (!p) return;
      if (p.kind === 'message') return this.applyPeerMessage(p, live);
      if (p.kind === 'notice') {
        if (/^Model not changed/.test(p.text || '')) this.modelRefused();
        return this.notice(p.text, p.level === 'warning' ? 'warn' : p.level);
      }
      if (p.kind === 'files') { if (live) this.requestTodo(); return; }
      if (p.kind === 'usage-limit') return this.limitNotice(p);
      if (p.kind === 'status') this.applyStatus(p);
    }

    // A refused switch: the label goes back to the model still in use.
    modelRefused() {
      if (this._modelBefore === undefined) return;
      this.model = this._modelBefore;
      this.actualModel = this._actualBefore || null;
      this._modelBefore = undefined;
      this.renderHeader();
    }

    applyStatus(p) {
      this.gotStatus = true;
      if (typeof p.costUsd === 'number') this.setCost(p.costUsd);
      if (p.model !== undefined) { this.model = p.model || null; this._modelBefore = undefined; }
      if (p.actualModel !== undefined) this.actualModel = p.actualModel || null;
      if (p.mappedTo !== undefined) this.mappedTo = p.mappedTo || null;
      if (p.context && typeof p.context === 'object') this.context = p.context;
      // Billing (absent from older transcripts' statuses).
      if (p.credential !== undefined) {
        const was = [this.credential, this.authPending, this.limited].join();
        this.credential = p.credential || null;
        this.authPending = p.authPending || null;
        this.limited = !!p.limited;
        if ([this.credential, this.authPending, this.limited].join() !== was) {
          this.renderLimit();
          this.panel.renderToolbar();
          for (const a of this.panel.allAreas()) if (a !== this) a.renderBill();
        }
      }
      this.setState(p.state);
      this.renderHeader();
    }

    applySdk(m, live, ts) {
      if (m.uuid && m.type !== 'stream_event') {
        if (this.seen.has(m.uuid)) return;
        this.seen.add(m.uuid);
        capOldest(this.seen, SEEN_MAX);
      }
      switch (m.type) {
        case 'stream_event': if (live) this.applyStream(m); return;
        case 'assistant': return this.applyAssistant(m);
        case 'user': return this.applySdkUser(m);
        case 'result': return this.applyResult(m, ts);
        case 'system': return this.applySystem(m);
        case 'tool_progress': {
          const t = this.tools.get(m.tool_use_id);
          if (t && !t.done && live) {
            t.startedAt = Date.now() - (m.elapsed_time_seconds || 0) * 1000;
            if (t === this.nowTool) this.renderNow();
          }
          return;
        }
      }
    }

    msgRec(id, pk) {
      if (id && this.msgs.has(id)) return this.msgs.get(id);
      const rec = { id: id || null, pk, blocks: [] };
      if (id) { this.msgs.set(id, rec); capOldest(this.msgs, MAP_MAX); }
      return rec;
    }

    // Live draws the thinking and text of the agent and of its subagents, and
    // each tool call as one line: the call's `description` (else its gist).
    // A subagent's blocks lead with a chip naming it.
    newBlock(rec, type, opts = {}) {
      if (type === 'tool_use') {
        const blk = { type, partial: '', final: false, toolId: opts.toolId || null, tool: this.toolStarted(opts.toolId, opts.toolName, rec.pk) };
        if (!blk.tool.lineEl) {
          const line = blk.tool.lineEl = el('div', `sdk-toolline${rec.pk ? ' sub' : ''}`);
          line.vcTool = blk.tool.id;
          line.vcMsg = rec.id;
          if (rec.pk) line.appendChild(this.subChip(rec.pk));
          blk.tool.lineName = line.appendChild(el('span', 'sdk-toolline-name'));
          blk.tool.lineText = line.appendChild(el('span', 'sdk-toolline-text'));
          this.renderToolLine(blk.tool);
          this.add(line);
        }
        rec.blocks.push(blk);
        return blk;
      }
      if (type !== 'text' && type !== 'thinking') return null;
      const blk = { type, raw: '', final: false };
      if (type === 'text') {
        blk.el = blk.body = el('div', 'sdk-text markdown-body');
        if (rec.pk) {
          blk.el = el('div', 'sdk-sub');
          blk.el.append(this.subChip(rec.pk), blk.body);
        }
        this.markUnread();
      } else {
        blk.el = el('div', 'sdk-thinking open');
        const head = el('div', 'sdk-thinking-head');
        if (rec.pk) head.appendChild(this.subChip(rec.pk));
        head.appendChild(document.createTextNode('Thinking'));
        blk.body = el('div', 'sdk-thinking-body');
        head.addEventListener('click', () => blk.el.classList.toggle('open'));
        blk.el.append(head, blk.body);
      }
      blk.el.vcMsg = rec.id;
      this.add(blk.el);
      rec.blocks.push(blk);
      return blk;
    }

    // A subagent run, named on its Agent call: its type numbered in launch
    // order ("Explore 1", "Explore 2", "Coder 1"), one colour per run. A
    // history replay names them again in the same order.
    subOf(pk) {
      let s = this.subs.get(pk);
      if (!s) {
        const input = this.tools.get(pk)?.input || {};
        const type = String(input.subagent_type || 'subagent');
        const n = (this.subCounts.get(type) || 0) + 1;
        this.subCounts.set(type, n);
        s = { label: `${type.charAt(0).toUpperCase()}${type.slice(1)} ${n}`, color: this.subRuns++ % 4, description: input.description || '' };
        this.subs.set(pk, s);
        capOldest(this.subs, MAP_MAX);
      }
      return s;
    }

    // The chip on a subagent's blocks and on the Agent call that started it;
    // the call's description on hover.
    subChip(pk) {
      const s = this.subOf(pk);
      const chip = el('span', `sdk-subchip sdk-subchip-c${s.color}`, s.label);
      chip.title = s.description;
      return chip;
    }

    toolStarted(id, name, pk) {
      let t = id ? this.tools.get(id) : null;
      if (!t) {
        t = { id, name, input: null, done: false, startedAt: this._replaying ? null : Date.now(), sub: !!pk };
        if (id) { this.tools.set(id, t); capOldest(this.tools, MAP_MAX, (x) => x.done); }
      }
      if (!t.sub && !t.done) { this.nowTool = t; this.renderNow(); }
      return t;
    }

    // A call keeps what its line and the "now:" line show, not its whole
    // input (a Write's file, an Edit's strings).
    setToolInput(t, input) {
      if (!t) return;
      input = input && typeof input === 'object' ? input : {};
      t.input = {
        description: clip(oneLine(input.description), 500),
        subagent_type: input.subagent_type ? String(input.subagent_type) : '',
        gist: clip(oneLine(toolSummary(t.name, input)), 500),
      };
      // A main-agent Agent call is numbered as it is made, and its line
      // carries the chip its subagent's output will.
      if ((t.name === 'Agent' || t.name === 'Task') && !t.sub && t.input.subagent_type && t.lineEl && !t.chipEl) {
        t.chipEl = t.lineEl.insertBefore(this.subChip(t.id), t.lineName);
      }
      this.renderToolLine(t);
      if (t === this.nowTool) this.renderNow();
    }

    renderToolLine(t) {
      const line = t.lineEl;
      if (!line) return;
      const desc = t.input?.description || '';
      const gist = desc || t.input?.gist || '';
      // The lite feed shows the description alone, without the tool's name.
      t.lineName.textContent = gist ? `${prettyTool(t.name)} · ` : prettyTool(t.name);
      t.lineText.textContent = gist;
      line.title = gist;
      line.classList.toggle('has-desc', !!desc);
      line.classList.toggle('done', !!t.done);
      line.classList.toggle('error', !!t.error);
    }

    // Lifted from the Inspector's appendSSEToDetail: block start / delta /
    // stop, keyed by the stream's block index. The complete assistant message
    // that follows each block supersedes what the deltas built.
    applyStream(m) {
      const ev = m.event;
      if (!ev) return;
      const pk = m.parent_tool_use_id || '';
      let cur = this.streams.get(pk);
      switch (ev.type) {
        case 'message_start': {
          this.streams.set(pk, { rec: this.msgRec(ev.message?.id, pk), byIndex: new Map() });
          return;
        }
        case 'content_block_start': {
          if (!cur) { cur = { rec: this.msgRec(null, pk), byIndex: new Map() }; this.streams.set(pk, cur); }
          const b = ev.content_block || {};
          const type = b.type === 'redacted_thinking' ? 'thinking' : b.type === 'server_tool_use' ? 'tool_use' : b.type;
          // A block the complete message already delivered (it can overtake
          // the deltas) is not counted twice.
          if (type === 'tool_use' && b.id && this.tools.has(b.id)) return;
          const blk = this.newBlock(cur.rec, type, { toolId: b.id, toolName: b.name });
          if (blk) cur.byIndex.set(ev.index, blk);
          return;
        }
        case 'content_block_delta': {
          const blk = cur?.byIndex.get(ev.index);
          const d = ev.delta;
          if (!blk || blk.final || !d) return;
          if (d.type === 'text_delta') {
            blk.raw += d.text || '';
            if (selectionInside(blk.body)) cancelRenderDebounce(blk.body);
            else renderMarkdownDebounced(blk.raw, blk.body);
          } else if (d.type === 'thinking_delta') {
            // One text node grows (the body's text is the thinking so far).
            if (!blk.textNode) blk.textNode = blk.body.appendChild(document.createTextNode(''));
            blk.textNode.appendData(d.thinking || '');
          } else if (d.type === 'input_json_delta') {
            blk.partial += d.partial_json || '';
          }
          return;
        }
        case 'content_block_stop': {
          const blk = cur?.byIndex.get(ev.index);
          if (!blk || blk.final) return;
          if (blk.type === 'tool_use') {
            try { this.setToolInput(blk.tool, JSON.parse(blk.partial || '{}')); } catch {}
            blk.partial = '';
          } else if (blk.type === 'text') {
            cancelRenderDebounce(blk.body);
            renderMarkdown(blk.raw, blk.body);
          }
          return;
        }
      }
    }

    applyAssistant(m) {
      const pk = m.parent_tool_use_id || '';
      const id = m.message?.id || null;
      let rec = id ? this.msgs.get(id) : null;
      if (!rec) {
        // Its message_start was missed (a reload mid-message): adopt the
        // anonymous stream record so its blocks are superseded, not doubled.
        const s = this.streams.get(pk);
        if (s && !s.rec.id) { rec = s.rec; rec.id = id; if (id) this.msgs.set(id, rec); }
      }
      if (!rec) rec = this.msgRec(id, pk);
      for (const b of m.message?.content || []) {
        if (b.type === 'tool_use' || b.type === 'server_tool_use') {
          let blk = rec.blocks.find(x => x.type === 'tool_use' && x.toolId === b.id);
          if (!blk) blk = this.newBlock(rec, 'tool_use', { toolId: b.id, toolName: b.name });
          blk.final = true;
          blk.partial = '';
          this.setToolInput(blk.tool, b.input || {});
          this.stored(blk.tool.lineEl, rec.id);
        } else if (b.type === 'text' || b.type === 'thinking' || b.type === 'redacted_thinking') {
          const t = b.type === 'text' ? 'text' : 'thinking';
          let blk = rec.blocks.find(x => x.type === t && !x.final);
          if (!blk) blk = this.newBlock(rec, t);
          if (!blk) continue;
          blk.final = true;
          this.stored(blk.el, rec.id);
          // Drawn for good: the text lives in the DOM only.
          if (t === 'text') {
            cancelRenderDebounce(blk.body);
            renderMarkdown(b.text || '', blk.body);
          } else {
            const raw = b.type === 'redacted_thinking' ? '(redacted)' : (b.thinking || blk.body.textContent || '');
            blk.textNode = null;
            blk.body.textContent = raw;
            blk.el.classList.remove('open');
            blk.el.classList.toggle('sdk-thinking-empty', !raw.trim());
          }
          blk.raw = '';
        }
      }
      if (m.error) this.notice(`API error: ${typeof m.error === 'string' ? m.error : JSON.stringify(m.error)}`, 'error');
    }

    // A block's complete message has come: its entry takes the message's
    // transcript offset (if it had none: drawn from deltas) and id.
    stored(node, msgId) {
      if (!node) return;
      if (node.vcOff == null) node.vcOff = this._off ?? null;
      if (msgId) node.vcMsg = msgId;
    }

    // Tool results. The CLI's echo of a user turn (isReplay) is not
    // broadcast; one in an older transcript draws nothing.
    applySdkUser(m) {
      if (m.isReplay) return;
      const c = m.message?.content;
      if (!Array.isArray(c)) return;
      for (const b of c) {
        if (b?.type !== 'tool_result') continue;
        const t = this.tools.get(b.tool_use_id);
        if (t) {
          t.done = true;
          t.error = !!b.is_error;
          this.renderToolLine(t);
          // A subagent's stream ends with its call.
          this.streams.delete(t.id);
        }
        if (t && t === this.nowTool) {
          // The newest main-agent call still running, if any.
          this.nowTool = [...this.tools.values()].reverse().find(x => !x.done && !x.sub) || null;
          this.renderNow();
        }
        // A line already out of the window takes its record along.
        if (t && !t.lineEl) this.forgetTool(t);
      }
    }

    // The main agent's stop: a rule across the feed, the summary and the
    // wall-clock time of the stop on it (the record's, in a replay; none for
    // a seeded one).
    applyResult(m, ts) {
      if (m.parent_tool_use_id) return;
      const bits = [];
      if (m.subtype && m.subtype !== 'success') bits.push(m.subtype.replace(/_/g, ' '));
      else bits.push(m.is_error ? 'ended with an error' : 'done');
      if (m.num_turns) bits.push(`${m.num_turns} turn${m.num_turns === 1 ? '' : 's'}`);
      if (m.duration_ms) bits.push(fmtSecs(m.duration_ms));
      if (typeof m.total_cost_usd === 'number') bits.push(`${fmtCost(m.total_cost_usd)} so far`);
      const line = el('div', `sdk-result${m.is_error ? ' error' : ''}`);
      const at = typeof ts === 'number' && ts > 0 ? new Date(ts) : null;
      if (at) {
        line.appendChild(el('span', 'sdk-result-time', at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
        line.title = at.toLocaleString();
      }
      line.appendChild(el('span', 'sdk-result-text', bits.join(' · ')));
      this.add(line);
      // The main agent stopped: every stream it had is over.
      this.streams.clear();
      // The caption's cost is not total_cost_usd (this query's own, not the
      // session folder's): the status that follows every result carries it.
      this.nowTool = null;
      if (!this.gotStatus) this.setState('idle');
      this.renderNow();
    }

    applySystem(m) {
      switch (m.subtype) {
        case 'init':
          // Emitted at the start of every turn; only a model change is news.
          // (An older page's first one is not news either.)
          if (m.model && m.model !== this.initModel) {
            if (!this._quietInit) this.notice(`${this.initModel ? 'Model now' : 'Session started ·'} ${m.model}`);
            this._quietInit = false;
            this.initModel = m.model;
            this.renderHeader();
          }
          if (!this.gotStatus) this.setState('busy');
          return;
        case 'compact_boundary': {
          const md = m.compact_metadata || {};
          if (!m.parent_tool_use_id) { this.compactions++; this.renderContext(); }
          const k = (n) => n ? `${Math.round(n / 1000)}k` : '?';
          this.notice(`Context compacted (${md.trigger || 'auto'}, ${k(md.pre_tokens)} → ${k(md.post_tokens)} tokens)`);
          return;
        }
        case 'api_retry':
          this.notice(`API retry ${m.attempt}/${m.max_retries}${m.error_status ? ` (HTTP ${m.error_status})` : ''}`, 'warn');
          return;
        case 'status':
          if (m.status === 'compacting') this.notice('Compacting the context…');
          return;
        case 'local_command_output':
          if (m.content) this.notice(m.content);
          return;
      }
    }

    applyUser(u, live) {
      // The owner's turn: a chip while it waits, then (same id) its bubble
      // where the agent took it in, or a line if it never will be.
      if (u.cancelled) return this.cancelPending(u.id, u.reason);
      if (u.pending && u.id) return this.addPending(u);
      if (u.id) this.removePending(u.id);
      const text = String(u.text || '');
      if (u.from) {
        // A peer's message is drawn once, from its platform `message` event;
        // the user turn it became (`[message from X] …`) is skipped. Turns the
        // platform itself typed in (from 'orchestration', 'vistaclair': pause
        // instructions, pending-event pings) show as a one-line notice that
        // opens on click.
        if (/^\[message from /i.test(text)) return;
        // A worker's brief, submitted on its orchestrator's behalf.
        if (u.from !== 'orchestration' && u.from !== 'vistaclair') {
          return this.applyPeerMessage({ from: u.from, to: [...this.aliases][0], text }, live);
        }
        const n = this.notice(`${u.from}: ${oneLine(text)}`, 'injected');
        n.title = text;
        n.addEventListener('click', () => n.classList.toggle('open'));
        return;
      }
      const bubble = el('div', 'sdk-user');
      bubble.appendChild(el('div', 'sdk-user-who', 'you'));
      if (text) bubble.appendChild(el('div', 'sdk-user-text', text));
      const imgs = Array.isArray(u.images) ? u.images : [];
      if (imgs.length) {
        const strip = el('div', 'sdk-user-imgs');
        for (const im of imgs) {
          const a = el('a');
          a.href = im.url; a.target = '_blank'; a.rel = 'noopener'; a.title = im.name || '';
          const img = el('img');
          img.src = im.url; img.alt = im.name || 'image'; img.loading = 'lazy';
          a.appendChild(img);
          strip.appendChild(a);
        }
        bubble.appendChild(strip);
      }
      this.add(bubble);
      if (!this.gotStatus) this.setState('busy');
    }

    addPending(u) {
      if (this.pending.has(u.id)) return;
      const chip = el('div', 'sdk-pending-chip');
      chip.append(el('span', 'sdk-pending-tag', 'waiting'), el('span', 'sdk-pending-text', userGist(u)));
      chip.title = `Queued: the agent takes it in when it is ready for it.\n\n${String(u.text || '')}`;
      this.pending.set(u.id, { u, chip });
      this.pendingEl.appendChild(chip);
      this.pendingEl.classList.remove('hidden');
      if (!this.gotStatus) this.setState('busy');
    }

    removePending(id) {
      const p = this.pending.get(id);
      if (!p) return null;
      this.pending.delete(id);
      p.chip.remove();
      this.pendingEl.classList.toggle('hidden', !this.pending.size);
      return p;
    }

    // reason: 'interrupted' (the interrupt cancelled it) | 'ended'.
    cancelPending(id, reason) {
      const p = this.removePending(id);
      if (!p) return;
      const line = el('div', 'sdk-user-dropped');
      line.append(el('span', 'sdk-user-dropped-tag', reason === 'interrupted' ? 'cancelled' : 'not sent'), el('span', 'sdk-user-dropped-text', userGist(p.u)));
      line.title = `${reason === 'interrupted' ? 'Cancelled by the interrupt' : 'The session ended before taking it in'}.\n\n${String(p.u.text || '')}`;
      this.add(line);
    }

    // One per SendMessage, emitted on both the sender's and the receiver's
    // session. The receiver's Live shows the text; the sender's side only
    // lights the line between the two boxes. A message neither end of which
    // is recognised yet (membership not fetched) is shown as `a → b`.
    applyPeerMessage(p, live) {
      if (this.isMe(p.from) && !this.isMe(p.to)) {
        if (live) this.panel.flashLink(p.from, p.to);
        return;
      }
      const from = shortName(p.from, this.panel.run);
      const card = el('div', 'sdk-peer in');
      card.appendChild(el('div', 'sdk-peer-head', this.isMe(p.to) ? `from ${from}` : `${from} → ${shortName(p.to, this.panel.run)}`));
      card.appendChild(el('div', 'sdk-peer-text', String(p.text || '')));
      this.add(card);
      this.markUnread();
    }

    notice(text, level) {
      return this.add(el('div', `sdk-notice${level ? ` sdk-notice-${level}` : ''}`, String(text || '')));
    }
  }

  // ---- a pane of Live maximized (one at a time) ----------------------------
  // The pane itself moves into the dialog, so it keeps updating (its
  // followers, "Load earlier" and the pills go with it); a comment holds its
  // place in the box, and on close it goes back there. ×, Esc or a click on
  // the backdrop closes it; so does its box leaving the stage or going away.

  let _max = null;
  function closeMax() {
    if (!_max) return;
    const { area, pane, slot, overlay, onKey } = _max;
    _max = null;
    document.removeEventListener('keydown', onKey, true);
    slot.replaceWith(pane);
    overlay.remove();
    // Moved, its scrollers start at the top: back to the bottom, or the reader's place.
    area.feedFollow.settle();
    area.todoFollow.settle();
  }

  function openMax(area, pane, what) {
    closeMax();
    closeMenu();
    const overlay = el('div', 'curl-modal-overlay sdk-max-overlay');
    overlay.innerHTML = `
      <div class="curl-modal sdk-max" role="dialog" aria-modal="true">
        <div class="curl-modal-header"><span class="sdk-max-title"></span><button type="button" class="curl-modal-close" title="Close (Esc)">×</button></div>
        <div class="sdk-max-body"></div>
      </div>`;
    const title = `${area.label} · ${what}`;
    overlay.querySelector('.sdk-max-title').textContent = title;
    overlay.querySelector('.sdk-max').setAttribute('aria-label', title);
    const slot = document.createComment('maximized');
    pane.replaceWith(slot);
    overlay.querySelector('.sdk-max-body').appendChild(pane);
    document.body.appendChild(overlay);
    const close = overlay.querySelector('.curl-modal-close');
    close.addEventListener('click', closeMax);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeMax(); });
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMax(); } };
    document.addEventListener('keydown', onKey, true);
    _max = { area, pane, slot, overlay, onKey };
    area.feedFollow.settle();
    area.todoFollow.settle();
    close.focus();
  }

  // ---- menus (one open at a time): a box's model ----------------------------

  let _menu = null;
  function closeMenu() {
    if (!_menu) return;
    _menu.el.remove();
    document.removeEventListener('mousedown', _menu.onDown, true);
    document.removeEventListener('keydown', _menu.onKey, true);
    _menu = null;
  }

  // The same options as the tab settings. A switch
  // keeps the conversation and its cost; the next turn caches the whole
  // context again at the new model's rate, so the menu says so.
  const RECACHE_TEXT = 'The context and the cost so far are kept. The next turn re-caches the whole context at the new model\'s rate.';
  function modelOptions() {
    const listed = window.cliModule?.modelPickerOptions?.() || [];
    return listed.length ? listed : FALLBACK_MODELS.map(v => ({ value: v, label: v, group: 'Aliases', price: '' }));
  }

  function openModelMenu(area, anchor) {
    const reopen = _menu?.owner === area;
    closeMenu();
    if (reopen || area.ended()) return;
    const opts = modelOptions();
    const cur = area.model || '';
    const box = el('div', 'sdk-model-menu');
    box.appendChild(el('div', 'sdk-model-warn', RECACHE_TEXT));
    let group = null;
    for (const o of opts) {
      if (o.group !== group) { group = o.group; box.appendChild(el('div', 'sdk-model-group', group || '')); }
      const b = el('button', `sdk-model-opt${o.value === cur ? ' on' : ''}`);
      b.type = 'button';
      b.appendChild(el('span', 'sdk-model-opt-label', o.label || o.value));
      if (o.price) b.appendChild(el('span', 'sdk-model-opt-price', o.price));
      b.addEventListener('click', () => {
        closeMenu();
        switchModel(area, o.value);
      });
      box.appendChild(b);
    }
    showMenu(box, anchor, area);
  }

  // Shown at once; a refused switch puts the label back (modelRefused).
  // False when there was nothing to switch.
  function switchModel(area, model) {
    if (!model || model === area.model || area.ended()) return false;
    area._modelBefore = area.model;
    area._actualBefore = area.actualModel;
    area.model = model;
    area.actualModel = null;
    area.renderHeader();
    sendWs({ type: 'sdk:setModel', sessId: area.sessId, model });
    return true;
  }

  // Below the anchor, or above it when there is no room; a click outside or
  // Esc closes it.
  function showMenu(box, anchor, owner) {
    document.body.appendChild(box);
    const r = anchor.getBoundingClientRect();
    const h = Math.min(box.scrollHeight, window.innerHeight * 0.6);
    const below = window.innerHeight - r.bottom > h + 12;
    box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - box.offsetWidth - 8))}px`;
    box.style.top = `${below ? r.bottom + 4 : Math.max(8, r.top - h - 4)}px`;
    const onDown = (e) => { if (!box.contains(e.target) && e.target !== anchor) closeMenu(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    _menu = { el: box, owner, onDown, onKey };
  }

  // ---- the toolbar's Models dialog (one at a time) --------------------------
  // For a run (its orchestrator's tab) every member, else the tab's session:
  // switch every running session to one model (sdk:setModel each, as the
  // boxes' menus do), and the model map, applied to all of them at once and
  // (a run) kept for the workers launched later (cli:sessionModelMap). The map
  // targets and their availability come with cli:settingsData, as for the
  // terminal tab's settings dialog.

  const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];
  let _models = null;
  function closeModels() {
    if (!_models) return;
    _models.overlay.remove();
    document.removeEventListener('keydown', _models.onKey, true);
    _models = null;
  }

  function openModels(panel) {
    closeModels();
    closeMenu();
    const isRun = !!panel.runId;
    const live = panel.allAreas().filter(a => !a.ended());
    const overlay = el('div', 'modal-overlay sdk-models-overlay');
    const box = el('div', 'modal-box sdk-models');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const head = el('div', 'modal-header');
    head.appendChild(el('span', null, isRun ? `Models · run ${panel.runId}` : 'Models'));
    const close = el('button', 'modal-close', '×');
    close.type = 'button';
    close.title = 'Close';
    head.appendChild(close);
    const body = el('div', 'modal-body sdk-models-body');

    // Switch: the running sessions and the model each is on now.
    const sw = el('section', 'sdk-models-sec');
    sw.appendChild(el('h4', null, isRun ? 'Switch every running session' : 'Switch the model'));
    sw.appendChild(el('div', 'sdk-model-warn', RECACHE_TEXT));
    const list = el('div', 'sdk-models-list');
    for (const a of live) {
      const row = el('div', 'sdk-models-sess');
      row.appendChild(el('span', 'sdk-models-sess-name', a.label));
      const m = a.shownModel();
      row.appendChild(el('span', 'sdk-models-sess-model', m ? `${fmtModel(m)}${a.mappedTo ? ` → ${fmtModel(a.mappedTo)}` : ''}` : '—'));
      list.appendChild(row);
    }
    if (!live.length) list.appendChild(el('div', 'sdk-models-empty', 'No session is running.'));
    sw.appendChild(list);
    const pickRow = el('div', 'sdk-models-row');
    const pick = el('select', 'sdk-models-select');
    pick.setAttribute('aria-label', 'Model');
    const cur = panel.main?.model || '';
    let group = null;
    let og = null;
    for (const o of modelOptions()) {
      if (o.group !== group) { group = o.group; og = el('optgroup'); og.label = group || ''; pick.appendChild(og); }
      const opt = el('option', null, o.price ? `${o.label}  [${o.price}]` : o.label);
      opt.value = o.value;
      if (o.value === cur) opt.selected = true;
      og.appendChild(opt);
    }
    const switchBtn = el('button', 'sdk-tb-btn sdk-models-go', live.length > 1 ? `Switch all ${live.length}` : 'Switch');
    switchBtn.type = 'button';
    switchBtn.disabled = !live.length;
    pickRow.append(pick, switchBtn);
    sw.appendChild(pickRow);
    body.appendChild(sw);

    // Map: a model family to a configured model, on its way through the proxy.
    const mp = el('section', 'sdk-models-sec');
    mp.appendChild(el('h4', null, 'Model map'));
    mp.appendChild(el('div', 'sdk-models-hint', isRun
      ? 'Rewrites a model family on its way through the proxy, for every session in this run now and for the workers it launches later. "Default" passes it through unchanged.'
      : 'Rewrites a model family on its way through the proxy, for this session. "Default" passes it through unchanged.'));
    const selects = {};
    const grid = el('div', 'sdk-models-map');
    for (const f of FAMILIES) {
      const label = el('label', 'sdk-models-map-row');
      label.appendChild(el('span', 'sdk-models-fam', f[0].toUpperCase() + f.slice(1)));
      const sel = selects[f] = el('select', 'sdk-models-select');
      sel.dataset.map = f;
      sel.disabled = true;
      sel.appendChild(el('option', null, 'Loading…'));
      label.appendChild(sel);
      grid.appendChild(label);
    }
    mp.appendChild(grid);
    const applyRow = el('div', 'sdk-models-row sdk-models-row-end');
    const applyBtn = el('button', 'sdk-tb-btn sdk-models-go', isRun ? 'Apply to the run' : 'Apply');
    applyBtn.type = 'button';
    applyBtn.disabled = true;
    applyRow.appendChild(applyBtn);
    mp.appendChild(applyRow);
    body.appendChild(mp);

    box.append(head, body);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    switchBtn.addEventListener('click', () => {
      const n = live.filter(a => switchModel(a, pick.value)).length;
      closeModels();
      D.showToast?.({ sender: 'Agent SDK', message: n ? `Switching ${n} session${n === 1 ? '' : 's'} to ${pick.value}` : `Already on ${pick.value}`, level: 'info' });
    });
    applyBtn.addEventListener('click', () => {
      const modelMap = Object.fromEntries(FAMILIES.map(f => [f, selects[f].value || null]));
      sendWs({ type: 'cli:sessionModelMap', tabId: panel.tabId, modelMap });
      closeModels();
    });
    close.addEventListener('click', closeModels);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeModels(); });
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeModels(); } };
    document.addEventListener('keydown', onKey, true);
    _models = { panel, overlay, selects, applyBtn, onKey };
    sendWs({ type: 'cli:getSettings', tabId: panel.tabId });
    pick.focus();
  }

  // cli:settingsData (cli.js passes it on): the map's targets for an open
  // dialog of that tab.
  function onSettingsData(msg) {
    if (!_models || _models.panel.tabId !== msg.tabId || !Array.isArray(msg.models)) return;
    const map = msg.settings?.modelMap || {};
    for (const f of FAMILIES) {
      const sel = _models.selects[f];
      window.cliModule?.fillModelMapSelect?.(sel, msg.models, map[f] || null);
      sel.disabled = false;
    }
    _models.applyBtn.disabled = false;
  }

  // ---- pick a session and send (one dialog at a time) ----------------------

  let _pick = null;
  function closePicker() {
    if (!_pick) return;
    _pick.backdrop.remove();
    document.removeEventListener('keydown', _pick.onKey, true);
    document.removeEventListener('keyup', _pick.onKeyUp, true);
    const p = _pick.panel;
    _pick = null;
    p.composer.focus();
  }

  // ---- Panel: one SDK tab --------------------------------------------------

  const FRESH_TEXT = 'Swap the orchestrator for a new one with a clean memory. It continues from its notes. Workers aren\'t touched.';
  // The toolbar's Models button: the tab strip's model-settings arrows.
  const MODELS_ICON = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M1 3h10m-2-2l2 2-2 2"/><path d="M1 7h10m-2-2l2 2-2 2"/><path d="M1 11h10m-2-2l2 2-2 2"/></svg>';
  const composerHint = (role) => `Message… (Enter or Ctrl+Enter, then Enter sends to the ${role === 'orchestrator' ? 'orchestrator' : 'session'}, Tab picks another · Shift+Enter new line · Esc stops the ${role === 'orchestrator' ? 'orchestrator' : 'session'})`;

  class Panel {
    constructor(tabId, wrap) {
      this.tabId = tabId;
      this.wrap = wrap;
      this.info = {};
      this.runId = null;
      this.run = null;
      this.main = null;
      this.workers = new Map();  // sessId -> Area
      this.rowList = [];         // the worker boxes in the row, in order
      this.openId = null;        // the shelved worker whose box is open
      this.cards = new Map();    // sessId -> its shelf card
      this.active = false;
      wrap.classList.add('sdk-wrap');
      wrap.innerHTML = `
        <div class="sdk-panel">
          <div class="sdk-toolbar">
            <span class="sdk-toolbar-badge">SDK</span>
            <span class="sdk-toolbar-title"></span>
            <span class="sdk-toolbar-meta"></span>
            <span class="sdk-toolbar-ext"></span>
            <span class="sdk-toolbar-cost"></span>
            <span class="sdk-spacer"></span>
            <span class="sdk-tb-right">
              <span class="sdk-bill" role="group" aria-label="Billing">
                <button type="button" data-auth="subscription"><span class="sdk-bill-long">Subscription</span><span class="sdk-bill-short">Sub</span></button><button type="button" data-auth="apikey"><span class="sdk-bill-long">API credits</span><span class="sdk-bill-short">API</span></button>
              </span>
              <button type="button" class="sdk-tb-btn sdk-tb-models" data-act="models">${MODELS_ICON}<span class="sdk-tb-lbl">Models</span></button>
              <span class="sdk-tb-actions"></span>
              <button type="button" class="sdk-tb-btn" data-act="pause">Pause &amp; save</button>
            </span>
          </div>
          <div class="sdk-stage">
            <svg class="sdk-links" aria-hidden="true"></svg>
            <div class="sdk-head">
              <div class="sdk-shelf hidden">
                <button type="button" class="sdk-shelf-tab"><span class="sdk-shelf-title"></span><span class="sdk-shelf-arrow" aria-hidden="true"></span></button>
                <div class="sdk-shelf-list"></div>
              </div>
              <div class="sdk-main-slot"></div>
            </div>
            <div class="sdk-workers"></div>
          </div>
          <vc-composer placeholder="${composerHint('orchestrator')}"></vc-composer>
        </div>`;
      const q = (s) => wrap.querySelector(s);
      this.panelEl = q('.sdk-panel');
      this.titleEl = q('.sdk-toolbar-title');
      this.metaEl = q('.sdk-toolbar-meta');
      this.extBadgeEl = q('.sdk-toolbar-ext');
      this.costEl = q('.sdk-toolbar-cost');
      this.stage = q('.sdk-stage');
      this.linksEl = q('.sdk-links');
      this.mainSlot = q('.sdk-main-slot');
      this.workersEl = q('.sdk-workers');
      this.shelfEl = q('.sdk-shelf');
      this.shelfTab = q('.sdk-shelf-tab');
      this.shelfTitle = q('.sdk-shelf-title');
      this.shelfList = q('.sdk-shelf-list');
      this.pauseBtn = q('[data-act="pause"]');
      this.modelsBtn = q('[data-act="models"]');
      this.billEl = q('.sdk-bill');
      this.billBtns = Object.fromEntries([...this.billEl.querySelectorAll('button')].map(b => [b.dataset.auth, b]));
      this.actionsEl = q('.sdk-tb-actions');
      this.composer = q('vc-composer');

      this.pauseBtn.addEventListener('click', () => this.pause());
      this.modelsBtn.addEventListener('click', () => openModels(this));
      for (const [auth, b] of Object.entries(this.billBtns)) b.addEventListener('click', () => this.setBilling(auth));
      this.shelfTab.addEventListener('click', () => this.foldShelf(!this.shelfEl.classList.contains('folded')));
      this.composer.addEventListener('send', (e) => this.openPicker(e.detail));
      // Esc stops the top box (the orchestrator, or a plain tab's session);
      // a worker is stopped from its own box.
      this.composer.addEventListener('interrupt', () => this.main?.stop());
      // Images dropped anywhere on the panel go to the composer.
      customElements.whenDefined('vc-composer').then(() => this.composer.attachDropTarget?.(this.panelEl));
      this._ro = new ResizeObserver(() => this.drawLinksSoon());
      this._ro.observe(this.stage);
    }

    areaCount() { return (this.main ? 1 : 0) + this.workers.size; }
    allAreas() { return [this.main, ...this.sortedWorkers()].filter(Boolean); }
    sortedWorkers() {
      const n = (a) => parseInt(String(a.workerId || '').replace(/\D/g, ''), 10) || 1e9;
      return [...this.workers.values()].sort((a, b) => n(a) - n(b));
    }
    areaByName(name) { return this.allAreas().find(a => a.isMe(name)) || null; }
    // Working: the session itself or (an orchestrator's tab) any of its workers,
    // which have no tab of their own.
    busy() { return this.allAreas().some(a => !a.ended() && (a.state === 'busy' || a.state === 'pausing')); }

    // The tab as cli.js knows it: {sessId, title, cwd, settings, status, pausing}.
    update(info) {
      this.info = { ...this.info, ...info };
      const orch = this.info.settings?.orchestration || null;
      const role = orch?.role === 'orchestrator' ? 'orchestrator' : 'single';
      const sessId = this.info.sessId;
      if (sessId && (!this.main || this.main.sessId !== sessId)) {
        // A refreshed orchestrator is a new session in the same tab.
        this.main?.destroy();
        const existing = areas.get(sessId);
        if (existing && existing.panel !== this) existing.destroy();
        this.main = new Area(this, sessId, { role, name: this.info.title || sessId, label: role === 'orchestrator' ? 'orchestrator' : (this.info.title || 'session') });
        if (role === 'orchestrator') this.main.addAliases(['orch', 'orchestrator']);
        this.mainSlot.appendChild(this.main.el);
        this.syncShown();
        this.main.requestTodo();
        this.drawLinksSoon();
      }
      if (this.main && info.state) this.main.setState(info.state);
      if (this.main && typeof info.costUsd === 'number') this.main.setCost(info.costUsd);
      if (this.main && !this.main.model && this.info.settings?.model) { this.main.model = this.info.settings.model; this.main.renderHeader(); }
      if (this.main && role === 'single' && this.info.title) {
        this.main.label = this.info.title;
        this.main.renderHeader();
      }
      const runId = role === 'orchestrator' ? orch?.runId || null : null;
      if (runId !== this.runId) {
        this.runId = runId;
        this.foldShelf(!!(runId && storedKey(SHELF_STORE, runId)), { store: false });
        if (runId) this.fetchRun();
      }
      this.composer.disabled = this.info.status === 'exited';
      if (this.composer.getAttribute('placeholder') !== composerHint(role)) this.composer.setAttribute('placeholder', composerHint(role));
      this.renderToolbar();
    }

    async fetchRun() {
      if (!this.runId) return;
      if (this._fetching) { this._refetch = true; return; }
      this._fetching = true;
      const runId = this.runId;
      try {
        const res = await fetch(`/api/orchestration/run?runId=${encodeURIComponent(runId)}`, { credentials: 'same-origin' });
        const run = await res.json();
        if (res.ok && runId === this.runId && panels.get(this.tabId) === this) this.applyRun(run);
      } catch {}
      this._fetching = false;
      if (this._refetch) { this._refetch = false; this.fetchRun(); }
    }

    applyRun(run) {
      this.run = run;
      if (this.main) {
        this.main.addAliases([run.orchestrator]);
        this.main.name = run.orchestrator || this.main.name;
        // Every cost is a session folder's running total (every session
        // that ran in it): replace, never add. Only the toolbar adds,
        // across folders.
        const oc = costOf(run.orchestratorCost ?? run.cost);
        if (oc != null) this.main.setCost(oc);
        if (run.orchestratorState) this.main.setState(run.orchestratorState);
        this.main.renderHeader();
      }
      for (const w of run.workers || []) {
        if (!w.sessId) continue;
        if (w.engine && w.engine !== 'sdk') continue;
        // A worker restarted fresh is a new session in the same folder: its
        // box (whose history and cost cover the old one's) replaces the old.
        for (const [id, old] of this.workers) {
          if (id !== w.sessId && w.id && old.workerId === w.id) { old.destroy(); this.workers.delete(id); }
        }
        let a = this.workers.get(w.sessId);
        if (!a) a = this.addWorker(w.sessId, w.name || w.worker);
        a.name = w.name || w.worker || a.name;
        a.label = w.id ? `${w.id}${w.title && w.title !== w.id ? ` · ${w.title}` : ''}` : shortName(a.name, run);
        a.addAliases([w.name, w.worker, w.id, shortName(w.name || w.worker, run)]);
        a.lastReport = w.lastReport || null;
        a.closed = !!w.closed || w.state === 'closed';
        a.closedAt = Date.parse(w.closedAt) || null;
        if (!a.model && w.model) a.model = w.model;
        const c = costOf(w.cost ?? w.costUsd);
        if (c != null) a.cost = c;
        const derived = w.state
          || (w.running ? (w.live?.pausing ? 'pausing' : w.live?.busy ? 'busy' : null) : w.paused ? 'paused' : 'exited');
        if (derived && (w.state || !a.gotStatus || derived === 'exited' || derived === 'paused')) a.setState(derived);
        a.workerId = w.id;
        // A new report travels up the worker's line (not on the first load;
        // a shelved worker's box not open has none).
        const rep = w.lastReport ? JSON.stringify([w.lastReport.status, w.lastReport.summary, w.lastReport.at]) : null;
        if (rep && a._repSig !== undefined && rep !== a._repSig) { this.layoutWorkers(); this.flashLink(a.name, this.main?.name); }
        a._repSig = rep;
        a.renderHeader();
      }
      this.layoutWorkers();
      this.renderToolbar();
      for (const a of this.allAreas()) a.renderHeader();
      // A worker closed without a state change.
      window.cliModule?.updateStreamingState?.();
    }

    addWorker(sessId, name) {
      const existing = areas.get(sessId);
      if (existing) existing.destroy();
      const label = name && name !== sessId ? shortName(name, this.run) : `worker ${sessId.slice(0, 8)}`;
      const a = new Area(this, sessId, { role: 'worker', name, label });
      this.workers.set(sessId, a);
      this.workersEl.appendChild(a.el);
      a.requestTodo();
      this.layoutWorkers();
      return a;
    }

    // The row: the open shelved box, then the others in id order; with none
    // it is hidden. Past three boxes, ended ones narrow so the running ones
    // keep their room.
    layoutWorkers() {
      const all = this.sortedWorkers();
      const shelved = all.filter(a => a.shelved());
      if (this.openId && !shelved.some(a => a.sessId === this.openId)) this.openId = null;
      const open = shelved.find(a => a.sessId === this.openId);
      this.rowList = [open, ...all.filter(a => !a.shelved())].filter(Boolean);
      const want = this.rowList.map(a => a.el);
      // Only a box out of place moves: putting one back into the DOM resets
      // its scrollers to the top. Shelved boxes leave first, so the others
      // never have to move around them.
      for (const c of [...this.workersEl.children]) if (!want.includes(c)) c.remove();
      want.forEach((e, i) => {
        const at = this.workersEl.children[i] || null;
        if (at !== e) this.workersEl.insertBefore(e, at);
      });
      for (const a of all) a.el.classList.toggle('sdk-area-opened', a === open);
      this.renderShelf(shelved);
      this.panelEl.classList.toggle('has-workers', this.rowList.length > 0);
      this.workersEl.classList.toggle('crowded', this.rowList.length > 3);
      this.syncShown();
      this.drawLinksSoon();
    }

    // The boxes shown: those in the stage of the active tab's panel.
    syncShown() {
      this.main?.setShown(this.active);
      for (const a of this.workers.values()) a.setShown(this.active && this.rowList.includes(a));
    }

    // ---- the shelf ----

    // Newest closed first: closedAt, else the last report's time, else the
    // higher id.
    renderShelf(shelved) {
      const n = (a) => parseInt(String(a.workerId || '').replace(/\D/g, ''), 10) || 0;
      const t = (a) => a.closedAt || Date.parse(a.lastReport?.at) || 0;
      const list = shelved.sort((a, b) => t(b) - t(a) || n(b) - n(a));
      this.shelfEl.classList.toggle('hidden', !list.length);
      this.shelfTitle.textContent = `Closed · ${list.length}`;
      const keep = new Set(list.map(a => a.sessId));
      for (const [id, c] of this.cards) if (!keep.has(id)) { c.el.remove(); this.cards.delete(id); }
      list.forEach((a, i) => {
        let c = this.cards.get(a.sessId);
        if (!c) {
          const b = el('button', 'sdk-shelf-card');
          b.type = 'button';
          c = { el: b, name: el('span', 'sdk-shelf-name'), rep: el('span'), ago: el('span', 'sdk-shelf-ago'), cost: el('span', 'sdk-shelf-cost') };
          const meta = el('span', 'sdk-shelf-meta');
          meta.append(c.rep, c.ago, c.cost);
          b.append(c.name, meta);
          b.addEventListener('click', () => this.openShelved(this.openId === a.sessId ? null : a.sessId));
          this.cards.set(a.sessId, c);
        }
        const at = this.shelfList.children[i] || null;
        if (at !== c.el) this.shelfList.insertBefore(c.el, at);
        const r = a.lastReport;
        const rs = String(r?.status || '').toLowerCase().replace(/[^a-z]/g, '');
        c.name.textContent = a.label;
        c.rep.textContent = r ? r.status || 'report' : 'none';
        c.rep.className = r ? `sdk-chip sdk-shelf-rep sdk-report-${rs}` : 'sdk-chip';
        c.cost.textContent = fmtCost(a.cost);
        c.el.title = `${a.label}\n${r ? `${r.status || 'report'}: ${r.summary || ''}` : 'No report.'}`;
        c.el.classList.toggle('open', a.sessId === this.openId);
        c.el.setAttribute('aria-pressed', String(a.sessId === this.openId));
        c.at = t(a);
      });
      this.renderShelfAges();
    }

    renderShelfAges() {
      const now = Date.now();
      for (const c of this.cards.values()) c.ago.textContent = c.at ? fmtAgo(now - c.at) : '';
    }

    // One shelved box open at a time (null: none).
    openShelved(sessId) {
      this.openId = sessId;
      this.layoutWorkers();
    }

    foldShelf(folded, { store = true } = {}) {
      this.shelfEl.classList.toggle('folded', folded);
      this.shelfTab.setAttribute('aria-expanded', String(!folded));
      this.shelfTab.title = folded ? 'Show the closed workers' : 'Fold the shelf';
      this.shelfTab.querySelector('.sdk-shelf-arrow').textContent = folded ? '›' : '‹';
      if (store && this.runId) storeKey(SHELF_STORE, this.runId, folded ? true : null);
      this.drawLinksSoon();
    }

    // ---- the lines between the boxes ----

    drawLinksSoon() {
      if (this._linkRaf) return;
      this._linkRaf = requestAnimationFrame(() => { this._linkRaf = null; this.drawLinks(); });
    }

    // One curve per box in the row, from the orchestrator's bottom edge down
    // onto the worker's name tag (the caption on its top border); the shelf,
    // beside the orchestrator, has none. Redrawn on every resize of the stage.
    // Paths are updated in place, so a redraw never cuts a flash short.
    drawLinks() {
      const svg = this.linksEl;
      const list = this.rowList;
      const keep = new Set();
      if (this.main && list.length && this.stage.offsetParent) {
        const NS = 'http://www.w3.org/2000/svg';
        const s = this.stage.getBoundingClientRect();
        const m = this.main.el.getBoundingClientRect();
        const n = list.length;
        const spread = Math.min(m.width * 0.5, 140 * (n - 1));
        const y1 = m.bottom - s.top;
        svg.setAttribute('viewBox', `0 0 ${s.width} ${s.height}`);
        list.forEach((a, i) => {
          const r = a.el.querySelector('.sdk-cap').getBoundingClientRect();
          const x1 = m.left - s.left + m.width / 2 + (n > 1 ? (i / (n - 1) - 0.5) * spread : 0);
          const x2 = r.left - s.left + r.width / 2;
          const y2 = r.top - s.top;
          const my = (y1 + y2) / 2;
          const st = a.ended() ? 'ended' : a.state === 'busy' ? 'busy' : a.state === 'awaiting' ? 'awaiting' : 'idle';
          let g = svg.querySelector(`g[data-sess="${CSS.escape(a.sessId)}"]`);
          if (!g) {
            g = document.createElementNS(NS, 'g');
            g.dataset.sess = a.sessId;
            g.append(document.createElementNS(NS, 'path'), document.createElementNS(NS, 'circle'));
            svg.appendChild(g);
          }
          g.setAttribute('class', `sdk-link sdk-link-${st}`);
          g.firstChild.setAttribute('d', `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`);
          const dot = g.lastChild;
          dot.setAttribute('cx', x1); dot.setAttribute('cy', y1); dot.setAttribute('r', 3);
          keep.add(g);
        });
      }
      for (const g of [...svg.children]) if (!keep.has(g)) g.remove();
    }

    // A message or report travelling between two boxes: the worker's line
    // lights up, moving down (from the orchestrator) or up (to it).
    flashLink(from, to) {
      const a = this.areaByName(from);
      const b = this.areaByName(to);
      const hit = [];
      if (a && a.role === 'worker') hit.push([a, 'up']);
      if (b && b.role === 'worker') hit.push([b, 'down']);
      for (const [w, dir] of hit) {
        // A shelved worker whose box is not open has no curve.
        if (!this.rowList.includes(w)) continue;
        const sel = `g[data-sess="${CSS.escape(w.sessId)}"] path`;
        // A curve not drawn yet (a box just added): draw now.
        let path = this.linksEl.querySelector(sel);
        if (!path) { this.drawLinks(); path = this.linksEl.querySelector(sel); }
        if (!path) continue;
        path.classList.remove('flash-up', 'flash-down');
        void path.getBoundingClientRect();
        path.classList.add(`flash-${dir}`);
        clearTimeout(path._flashT);
        path._flashT = setTimeout(() => path.classList.remove(`flash-${dir}`), LINK_FLASH_MS);
      }
    }

    // ---- sending ----

    // Submit → one dialog: the session map, the message, a Send button. There
    // is no remembered target: every message names its session. The
    // orchestrator (the first box) is selected; Tab / Shift+Tab moves the
    // selection, Enter or the button sends.
    openPicker(payload = {}) {
      closePicker();
      closeMenu();
      const list = this.allAreas();
      if (!list.length) return;
      const pickable = (a) => !a.ended();
      const backdrop = el('div', 'alert-modal-backdrop sdk-pick-backdrop');
      const modal = el('div', 'alert-modal sdk-pick');
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.tabIndex = -1;
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);
      backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closePicker(); });
      const sel = list.findIndex(pickable);
      const pick = _pick = { panel: this, backdrop, modal, payload, list, pickable, sel, armed: false };
      pick.onKeyUp = () => { pick.armed = true; };
      pick.onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(); return; }
        if (e.key === 'Tab') {
          // Focus stays in the dialog: Tab only walks the selection, wrapping
          // round and skipping the boxes that cannot take a message.
          e.preventDefault();
          e.stopPropagation();
          const step = e.shiftKey ? -1 : 1;
          for (let k = 1; k <= list.length; k++) {
            const j = ((pick.sel + step * k) % list.length + list.length) % list.length;
            if (pickable(list[j])) { this._picked(list[j]); break; }
          }
        } else if (e.key === 'Enter') {
          // The Enter that submitted (or one held down) never sends: it
          // takes a fresh key press.
          e.preventDefault();
          e.stopPropagation();
          if (pick.armed && !e.repeat) this._confirmSend();
        }
      };
      document.addEventListener('keydown', pick.onKey, true);
      document.addEventListener('keyup', pick.onKeyUp, true);
      this._renderPick();
    }

    _nodeMeta(a) {
      return [fmtModel(a.shownModel()), STATE_TEXT[a.state || 'idle'] || a.state].filter(Boolean).join(' · ');
    }

    // Drawn again on every change of selection.
    _renderPick() {
      const pick = _pick;
      const { modal, list, pickable, payload } = pick;
      const target = list[pick.sel];
      const node = (a) => {
        const b = el('button', `sdk-pick-node sdk-pick-${a.role}${pickable(a) ? '' : ' off'}${a === target ? ' sel' : ''}`);
        b.type = 'button';
        b.disabled = !pickable(a);
        b.setAttribute('aria-pressed', String(a === target));
        b.title = a.label;
        b.appendChild(el('span', 'sdk-pick-name', a.label));
        b.appendChild(el('span', 'sdk-pick-meta', this._nodeMeta(a)));
        b.addEventListener('click', () => this._picked(a));
        return b;
      };
      modal.innerHTML = '';
      modal.appendChild(el('div', 'sdk-pick-title', 'Send to which session?'));
      const map = el('div', 'sdk-pick-map');
      const [first, ...rest] = list;
      map.appendChild(node(first));
      if (rest.length) {
        const row = el('div', 'sdk-pick-row');
        row.style.setProperty('--n', rest.length);
        rest.forEach(a => row.appendChild(node(a)));
        map.appendChild(row);
      }
      modal.appendChild(map);
      const text = String(payload.text || '');
      const lines = text.split('\n');
      const preview = lines.slice(0, 3).join('\n') + (lines.length > 3 ? '\n…' : '');
      const nImg = (payload.images || []).length;
      if (target && (target.state === 'busy' || target.state === 'awaiting')) {
        modal.appendChild(el('div', 'sdk-pick-note', `${target.label} is busy: it reads this after its current tool calls.`));
      }
      if (text) modal.appendChild(el('pre', 'sdk-pick-preview', clip(preview, 600)));
      if (nImg) modal.appendChild(el('div', 'sdk-pick-imgs', `+ ${nImg} image${nImg === 1 ? '' : 's'}`));
      modal.appendChild(el('div', 'sdk-pick-hint', 'Tab picks the box, Enter sends. Ended sessions cannot take messages.'));
      const actions = el('div', 'sdk-pick-actions');
      const cancel = el('button', 'sdk-tb-btn', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', closePicker);
      actions.appendChild(cancel);
      const send = el('button', 'alert-modal-ok sdk-pick-send', target ? `Send to ${clip(target.label, 32)}` : 'Send');
      send.type = 'button';
      send.disabled = !target;
      send.addEventListener('click', () => this._confirmSend());
      actions.appendChild(send);
      modal.appendChild(actions);
      modal.focus();
    }

    // Sending: a box (click or Tab) is selected, not sent to.
    _picked(a) {
      const pick = _pick;
      if (!pick || !pick.pickable(a)) return;
      pick.sel = pick.list.indexOf(a);
      this._renderPick();
    }

    _confirmSend() {
      const pick = _pick;
      const target = pick?.list[pick.sel];
      if (!target || !pick.pickable(target)) return;
      sendWs({ type: 'sdk:send', sessId: target.sessId, text: pick.payload.text, images: pick.payload.images || [] });
      // The draft stays in the composer until a message is really sent.
      this.composer.clear();
      closePicker();
    }

    // The same pause flow as the tab strip: an orchestrator pauses its run,
    // a plain tab itself; while pausing it offers "Force stop".
    pause() {
      const info = this.info;
      if (info.pausing) {
        if (confirm('Force stop? It stops right away, in the middle of its step. It is still saved, but the resume note may be missing.')) {
          sendWs({ type: 'cli:interrupt', tabId: this.tabId });
        }
        return;
      }
      if (this.runId) {
        if (!confirm('Pause & save this run? Every session saves its progress and closes; the orchestrator goes last. This can take a minute. Resume later from the + menu. Nothing is lost.')) return;
        sendWs({ type: 'cli:pauseRun', runId: this.runId });
      } else {
        sendWs({ type: 'cli:pause', tabId: this.tabId });
      }
    }

    // What the running sessions are billed to: { on: Set of 'subscription' |
    // 'apikey', pending: areas switching after their turn, limited: areas
    // the subscription's usage limit stopped }. None running: the tab's
    // settings say.
    billing() {
      const live = this.allAreas().filter(a => !a.ended() && a.credential);
      const on = new Set(live.map(a => authOf(a.credential)));
      if (!on.size && AUTH_IDS.includes(this.info.settings?.auth)) on.add(this.info.settings.auth);
      return {
        on,
        live,
        pending: live.filter(a => a.authPending),
        limited: live.filter(a => a.limited && a.credential === 'subscription'),
      };
    }

    // The toggle: the billing in force lit, both halves part-lit when the
    // members differ, a pending switch outlined, an option without its
    // credential greyed with the reason (aria-disabled keeps the tooltip).
    renderBilling(isWorkerTab) {
      this.billEl.classList.toggle('hidden', isWorkerTab);
      if (isWorkerTab) return;
      const { on, live, pending, limited } = this.billing();
      const ca = state.claudeAuth || {};
      const missing = {
        apikey: ca.hasApiKey === false ? 'No Anthropic API key is stored: add one on the Models page.' : null,
        subscription: ca.hasSubscription === false ? 'No Claude subscription is signed in: Sign in to Claude, in the dashboard header.' : null,
      };
      const scope = this.runId ? 'every session of the run, and the workers it launches later' : 'this session';
      const names = (list) => list.map(a => a.label).join(', ');
      this.billEl.classList.toggle('mixed', on.size > 1);
      this.billEl.classList.toggle('alert', limited.length > 0);
      for (const auth of AUTH_IDS) {
        const b = this.billBtns[auth];
        const only = on.size === 1 && on.has(auth);
        const part = on.size > 1 && on.has(auth);
        const going = pending.filter(a => a.authPending === auth);
        b.classList.toggle('on', only);
        b.classList.toggle('part', part);
        b.classList.toggle('pending', going.length > 0);
        const off = !!missing[auth] && !only;
        b.setAttribute('aria-disabled', String(off));
        b.setAttribute('aria-pressed', String(only));
        const lines = [];
        if (only) lines.push(`Billed to ${BILL_TEXT[auth]}: ${scope}.`);
        else if (part) lines.push(`On ${BILL_TEXT[auth]}: ${names(live.filter(a => authOf(a.credential) === auth))}.`);
        if (going.length) lines.push(`Switching to ${BILL_TEXT[auth]} after this turn: ${names(going)}.`);
        if (off) lines.push(missing[auth]);
        else if (!only) {
          lines.push(`Click to bill ${scope} to ${BILL_TEXT[auth]}. An idle session switches now, a busy one after its turn; the conversation and the cost so far carry on.`);
          if (auth === 'apikey' && limited.length) lines.push(`The subscription's usage limit stopped ${names(limited)}: they continue on API credits.`);
        }
        b.title = lines.join('\n');
      }
    }

    setBilling(auth) {
      const b = this.billBtns[auth];
      if (!b || b.getAttribute('aria-disabled') === 'true') return;
      const { on, pending, limited } = this.billing();
      if (on.size === 1 && on.has(auth) && !pending.some(a => a.authPending !== auth)) return;
      // Lit by the usage limit: the click is its "Continue on API credits".
      sendWs({ type: 'cli:sessionAuth', tabId: this.tabId, sessId: this.info.sessId, auth, ...(auth === 'apikey' && limited.length ? { continue: true } : {}) });
    }

    renderToolbar() {
      const info = this.info;
      this.titleEl.textContent = info.title || (info.cwd || '').split('/').filter(Boolean).pop() || 'Agent SDK';
      this.titleEl.title = info.cwd || '';
      const meta = [];
      if (this.runId) meta.push(`run ${this.runId}`);
      if (this.workers.size) meta.push(`${this.workers.size} worker${this.workers.size === 1 ? '' : 's'}`);
      if (info.pausing) meta.push('pausing…');
      if (info.status === 'exited') meta.push('exited');
      this.metaEl.textContent = meta.join(' · ');
      const costs = this.allAreas().map(a => a.cost).filter(c => typeof c === 'number');
      this.costEl.textContent = costs.length ? `${fmtCost(costs.reduce((s, c) => s + c, 0))}${this.workers.size ? ' total' : ''}` : '';
      const running = info.status === 'running';
      const isWorkerTab = info.settings?.orchestration?.role === 'worker';
      this.pauseBtn.classList.toggle('hidden', isWorkerTab);
      this.pauseBtn.disabled = !running;
      this.pauseBtn.textContent = info.pausing ? 'Force stop' : 'Pause & save';
      this.pauseBtn.title = info.pausing
        ? 'Saving… Click to stop immediately (the resume note may be missing).'
        : this.runId ? 'Every session saves its progress and closes. Resume later from the + menu. Nothing is lost.'
          : 'The session saves its progress and closes. Resume later from the + menu. Nothing is lost.';
      this.renderBilling(isWorkerTab);
      // Models: the whole run from its orchestrator's tab, or the tab's own
      // session; a model map in force shows on the button.
      this.modelsBtn.classList.toggle('hidden', isWorkerTab);
      const map = Object.entries(info.settings?.modelMap || {}).filter(([, v]) => v);
      this.modelsBtn.classList.toggle('on', map.length > 0);
      this.modelsBtn.title = [
        this.runId ? 'Models for the whole run: switch every running session, or map model families for every session (and the workers launched later)'
          : 'Models for this session: switch it, or map model families',
        ...map.map(([f, v]) => `Map: ${f} → ${v}`),
      ].join('\n');
      // An add-on's actions for this tab (dashboard.registerTabAction): a
      // button each; a toggle's state shows pressed.
      const tabInfo = this.tabInfo();
      this.actionsEl.replaceChildren(...this.tabActions(tabInfo).map((action) => {
        const b = el('button', `sdk-tb-btn sdk-tb-action${action.active ? ' on' : ''}`);
        b.type = 'button';
        // A leading symbol ("📱 Follow…") stays when a narrow toolbar drops the words.
        const m = /^(\S{1,4})\s+(.+)$/u.exec(action.label);
        if (m && !/[A-Za-z0-9]/.test(m[1])) b.append(el('span', 'sdk-tb-ico', m[1]), el('span', 'sdk-tb-lbl', m[2]));
        else b.textContent = action.label;
        b.title = action.title || action.label;
        if (action.active) b.setAttribute('aria-pressed', 'true');
        b.addEventListener('click', () => window.dashboard._tabHooks.runAction(action, tabInfo));
        return b;
      }));
      // An add-on's badge for this session (dashboard.setTabBadge).
      const extBadge = window.dashboard._tabBadgeEl(info.settings?.name, 'sdk-toolbar-ext-badge');
      this.extBadgeEl.replaceChildren(...(extBadge ? [extBadge] : []));
      // A run's orchestrator can hand over to a fresh one, from its box's
      // caption; the control lights up once it has compacted a few times.
      const run = this.run;
      const isRun = !!this.runId && !isWorkerTab;
      this.canRefresh = isRun && !!(run?.orchestratorRunning && !run.pausing && !info.pausing);
      this.renderFresh();
    }

    renderFresh() {
      const b = this.main?.role === 'orchestrator' ? this.main.freshBtn : null;
      if (!b) return;
      const isRun = !!this.runId && this.info.settings?.orchestration?.role !== 'worker';
      b.classList.toggle('hidden', !isRun);
      const suggested = this.canRefresh && !!this.run?.refreshSuggested;
      b.classList.toggle('suggested', suggested);
      b.setAttribute('aria-disabled', String(!this.canRefresh));
      b.textContent = suggested ? `↻ Fresh · compacted ${this.run.compactions || 0}×` : '↻ Fresh';
      b.title = !this.canRefresh ? `Fresh orchestrator: ${FRESH_TEXT}\nNot now: the orchestrator is not running, or the run is pausing.`
        : suggested ? `Fresh orchestrator: ${FRESH_TEXT}\nSuggested: the orchestrator has compacted ${this.run.compactions || 0}× in this run.`
          : `Fresh orchestrator: ${FRESH_TEXT}`;
    }

    // This tab as add-on tab actions see it (public/tab-hooks.js).
    tabInfo() { return window.tabHookInfo(this.tabId, { kind: 'sdk', settings: this.info.settings }); }
    tabActions(info = this.tabInfo()) { return window.dashboard._tabHooks.actionsFor(info); }

    refresh() {
      if (!this.runId || !this.canRefresh) return;
      if (!confirm(`Fresh orchestrator?\n\n${FRESH_TEXT}`)) return;
      this.main?.freshBtn.setAttribute('aria-disabled', 'true');
      sendWs({ type: 'cli:refreshOrchestrator', runId: this.runId });
    }

    // Events were missed: a box shown reloads, a hidden one drops its feed
    // now (it reloads when shown).
    reloadHistory() {
      for (const a of this.allAreas()) {
        if (a.shown) a.requestHistory();
        else a.release();
        a.requestTodo();
      }
      if (this.runId) this.fetchRun();
    }

    pollTodos() {
      if (!this.active || document.visibilityState !== 'visible' || !this.wrap.offsetParent) return;
      // An ended worker's files no longer move.
      for (const a of this.allAreas()) if (!a.ended()) a.requestTodo();
    }

    tick() {
      for (const a of this.allAreas()) if (a.nowTool?.startedAt && a.state === 'busy') a.renderNow();
      if (this.cards.size) this.renderShelfAges();
    }

    setActive(v) {
      this.active = !!v;
      this.syncShown();
      clearInterval(this._poll);
      clearInterval(this._tick);
      this._poll = this._tick = null;
      if (this.active) {
        this._poll = setInterval(() => this.pollTodos(), POLL_MS);
        this._tick = setInterval(() => this.tick(), TICK_MS);
        this.pollTodos();
        this.drawLinksSoon();
        if (!D.isPhone?.()) setTimeout(() => this.composer.focus(), 50);
      }
    }

    destroy() {
      clearInterval(this._poll);
      clearInterval(this._tick);
      this._ro.disconnect();
      if (_pick?.panel === this) closePicker();
      if (_menu && (_menu.owner === this || this.allAreas().includes(_menu.owner))) closeMenu();
      if (_models?.panel === this) closeModels();
      for (const a of this.allAreas()) a.destroy();
      this.workers.clear();
      this.main = null;
      this.wrap.innerHTML = '';
    }
  }

  // ---- module API (called from cli.js) -------------------------------------

  function mount(tabId, wrap, info) {
    let p = panels.get(tabId);
    if (!p) { p = new Panel(tabId, wrap); panels.set(tabId, p); }
    if (info) p.update(info);
    return p;
  }
  function update(tabId, info) { panels.get(tabId)?.update(info); }
  // Tab actions and badges registered or dropped: redraw every toolbar.
  window.dashboard._tabHooks.onChange(() => { for (const p of panels.values()) p.renderToolbar(); });
  function unmount(tabId) {
    const p = panels.get(tabId);
    if (!p) return;
    p.destroy();
    panels.delete(tabId);
  }
  function isBusy(tabId) { return !!panels.get(tabId)?.busy(); }
  function setActive(tabId) {
    for (const [id, p] of panels) p.setActive(id === tabId);
  }

  // cli.js calls this on every cli:tabs. The server sends one on each
  // (re)connect, so a new socket means events were missed: replay history.
  function onTabs() {
    const ws = state.ws;
    if (_lastWs && ws && ws !== _lastWs) for (const p of panels.values()) p.reloadHistory();
    if (ws) _lastWs = ws;
  }

  function activePanel() {
    for (const p of panels.values()) if (p.active) return p;
    return null;
  }

  function onRunUpdate(msg) {
    if (!msg?.runId || msg.deleted) return;
    for (const p of panels.values()) if (p.runId === msg.runId) p.fetchRun();
  }

  // An event from a session no panel knows yet: a worker of a run we show
  // that was launched after the last membership fetch.
  function adopt(msg) {
    if (!msg.runId) return null;
    for (const p of panels.values()) {
      if (p.runId !== msg.runId) continue;
      if (p.main?.sessId === msg.sessId) return p.main;
      const a = p.addWorker(msg.sessId, msg.sessId);
      p.fetchRun();
      return a;
    }
    return null;
  }

  // A usage limit is noticed wherever the owner is looking: a toast, once a
  // minute per tab (every member of a run hits the same limit).
  const LIMIT_TOAST_MS = 60000;
  function limitToast(a, p) {
    const panel = a.panel;
    if (Date.now() - (panel._limitToastAt || 0) < LIMIT_TOAST_MS) return;
    panel._limitToastAt = Date.now();
    D.showToast?.({
      sender: 'Agent SDK', level: 'warning', title: 'Claude subscription usage limit reached',
      message: `${panel.info.title || 'An SDK tab'} · ${a.label} stopped. ${p.apiKey ? 'Continue on API credits from its feed, or with the toolbar\'s billing toggle.' : 'No API key is stored: add one on the Models page to continue on API credits.'}`,
    });
  }

  // prefs:claudeAuth: which credentials exist, for every toggle.
  function onCredentials() { for (const p of panels.values()) p.renderToolbar(); }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'sdk:event': {
        // A refusal answered only to this window (e.g. a refused sdk:send)
        // may come without a known session: show it in the main box.
        const a = areas.get(msg.sessId) || adopt(msg)
          || (!areas.has(msg.sessId) && msg.ev?.platform?.kind === 'notice' ? activePanel()?.main : null);
        // A freshly adopted area shown has just asked for history, which
        // queues this event and drops it if history already holds it; one
        // hidden only moves its caption.
        a?.receive(msg.ev, msg.ts, msg.off);
        if (a && msg.ev?.platform?.kind === 'usage-limit') limitToast(a, msg.ev.platform);
        break;
      }
      case 'sdk:history':
        // {sessId, from, events, hasMore, before} — or the run form
        // {runId, sessions:[{sessId, from, events, hasMore, before}]}.
        for (const x of Array.isArray(msg.sessions) ? msg.sessions : [msg]) areas.get(x.sessId)?.onPage(x);
        break;
      case 'sdk:todo':
        areas.get(msg.sessId)?.onTodo(msg);
        break;
      case 'cli:progress':
        areas.get(msg.sessId)?.requestTodo();
        break;
    }
  }

  D.registerModule?.('sdk:', handleMessage);
  D.registerModule?.('cli:progress', handleMessage);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') for (const p of panels.values()) p.pollTodos();
  });

  window.sdkPanel = {
    mount, update, unmount, setActive, isBusy, onTabs, onRunUpdate, handleMessage, onSettingsData, onCredentials, _panels: panels, _areas: areas,
    _feedWindow: { feedExcess, cursorAbove, capOldest, FEED_MAX, FEED_HARD_MAX, PAGE },
  };
})();
