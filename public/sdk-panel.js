// Agent SDK panel: the HTML view of an `kind:'sdk'` CLI tab. One panel per
// tab, drawn as a diagram: the orchestrator's box spans the top, one box per
// worker sits in a row below it (workers are hidden sessions with no tab of
// their own), and an SVG behind the boxes joins them. A plain SDK tab has a
// single box. Each box shows one view at a time — TODO, Notes or Live
// (thinking and text; every tool call is in the Inspector) — under a caption
// on its top border: name, model (click to switch), state, cost.
//
// Everything shown is server state: on mount and after a reconnect each box
// asks for `sdk:history` (the session's transcript, no stream deltas),
// replays it, then continues from the live `sdk:event` broadcasts. TODO.md
// and NOTES.md come from `sdk:todo`, re-asked on the session's own edits to
// them (`platform.files`), run membership from GET /api/orchestration/run.
// The composer has no remembered target: every message is sent through a
// pick-the-session, then confirm dialog.
// cli.js owns the tab; this file owns what is inside its wrap.
(function () {
  const D = window.dashboard;
  const { sendWs, state, escHtml, renderMarkdown, renderMarkdownDebounced, cancelRenderDebounce } = D;

  const POLL_MS = 15000;           // backstop: TODO/NOTES edits normally arrive as platform.files
  const TICK_MS = 1000;            // the "now:" line's elapsed time
  const HISTORY_WAIT_MS = 10000;
  const FOLLOW_SLACK_PX = 48;
  const LINK_FLASH_MS = 1600;
  const VIEWS = ['todo', 'notes', 'live'];
  const VIEW_STORE = 'sdkPanelViews';
  const VIEW_STORE_MAX = 200;
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
  const ENDED = new Set(['exited', 'stopped', 'abandoned']);
  const STATE_TEXT = { busy: 'busy', idle: 'idle', awaiting: 'awaiting answer', paused: 'paused', exited: 'exited', pausing: 'pausing' };
  // `claude-sonnet-5-5` → `sonnet-5-5`; aliases and `[1m]` stay as they are.
  const fmtModel = (m) => String(m || '').replace(/^claude-/, '');

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
  // Scroll `node` (inside the scroller `box`) to a third of the box's height.
  function scrollToNode(box, node) {
    const top = node.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTop = Math.max(0, top - box.clientHeight / 3);
  }

  // The view each box shows, per session, across reloads (most recent last).
  function storedView(key) {
    try { return JSON.parse(localStorage.getItem(VIEW_STORE) || '{}')?.[key] || null; } catch { return null; }
  }
  function storeView(key, view) {
    try {
      const m = JSON.parse(localStorage.getItem(VIEW_STORE) || '{}') || {};
      delete m[key];
      m[key] = view;
      const keys = Object.keys(m);
      for (const k of keys.slice(0, Math.max(0, keys.length - VIEW_STORE_MAX))) delete m[k];
      localStorage.setItem(VIEW_STORE, JSON.stringify(m));
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
      this.model = null;             // chosen (settings.model)
      this.actualModel = null;       // what the API answered with
      this.mappedTo = null;          // the tab's modelMap target, when it rewrites
      this.initModel = null;         // system/init, before any status names one
      this.todo = null;
      this.follow = true;
      this.queue = [];
      this.historyPending = false;
      this.view = storedView(sessId) || (role === 'worker' ? 'todo' : 'live');
      this._build();
      this.reset();
      this.setView(this.view, { store: false });
      areas.set(sessId, this);
    }

    _build() {
      const root = this.el = el('section', `sdk-area sdk-area-${this.role}`);
      root.dataset.sessId = this.sessId;
      root.innerHTML = `
        <div class="sdk-cap">
          <span class="sdk-area-name"></span>
          <button type="button" class="sdk-model" title="Change this session's model"></button>
          <span class="sdk-chip sdk-area-state"></span>
          <span class="sdk-chip sdk-area-report hidden"></span>
          <span class="sdk-area-cost"></span>
        </div>
        <button type="button" class="sdk-insp" title="Open this session in the Inspector: every request, tool call and result">Inspector</button>
        <div class="sdk-bar">
          <div class="sdk-seg">
            <button type="button" data-v="todo">TODO</button><button type="button" data-v="notes">Notes</button><button type="button" data-v="live">Live</button>
          </div>
          <div class="sdk-now"></div>
        </div>
        <div class="sdk-area-awaiting hidden">Awaiting your answer: the question is open in the dialog.</div>
        <div class="sdk-main">
          <div class="sdk-view sdk-view-todo">
            <div class="sdk-area-final hidden"></div>
            <div class="sdk-todo-wrap"></div>
          </div>
          <div class="sdk-view sdk-view-notes markdown-body"></div>
          <div class="sdk-view sdk-view-live">
            <div class="sdk-feed"></div>
            <button type="button" class="sdk-live-pill hidden">↓ jump to live</button>
          </div>
        </div>`;
      const q = (s) => root.querySelector(s);
      this.nameEl = q('.sdk-area-name');
      this.modelBtn = q('.sdk-model');
      this.stateEl = q('.sdk-area-state');
      this.reportEl = q('.sdk-area-report');
      this.costEl = q('.sdk-area-cost');
      this.nowEl = q('.sdk-now');
      this.awaitEl = q('.sdk-area-awaiting');
      this.finalEl = q('.sdk-area-final');
      this.todoView = q('.sdk-view-todo');
      this.todoEl = q('.sdk-todo-wrap');
      this.notesEl = q('.sdk-view-notes');
      this.liveView = q('.sdk-view-live');
      this.feed = q('.sdk-feed');
      this.pill = q('.sdk-live-pill');
      this.segBtns = Object.fromEntries([...root.querySelectorAll('.sdk-seg button')].map(b => [b.dataset.v, b]));

      for (const [v, b] of Object.entries(this.segBtns)) b.addEventListener('click', () => this.setView(v));
      this.modelBtn.addEventListener('click', (e) => { e.stopPropagation(); openModelMenu(this, this.modelBtn); });
      q('.sdk-insp').addEventListener('click', () => {
        if (typeof switchView === 'function') switchView('dashboard');
        window.inspectorModule?.switchInstanceTab?.(`cli-${this.sessId}`);
      });

      // Follow the stream only while the reader is at the bottom; scrolling up
      // to read pauses it and offers the pill instead.
      this.feed.addEventListener('scroll', () => {
        const v = this.feed;
        const atBottom = v.scrollHeight - v.scrollTop - v.clientHeight <= FOLLOW_SLACK_PX;
        this.follow = atBottom;
        if (atBottom) this.pill.classList.add('hidden');
      }, { passive: true });
      this.pill.addEventListener('click', () => { this.follow = true; this.pill.classList.add('hidden'); this._scrollNow(); });
      // Every change to the feed (new blocks, deltas, the debounced markdown
      // render that lands later) goes through one observer, so following
      // never lags a render.
      this._mo = new MutationObserver(() => {
        if (this.view !== 'live') return;
        if (this.follow) this._scrollSoon();
        else this.pill.classList.remove('hidden');
      });
      this._mo.observe(this.feed, { childList: true, subtree: true, characterData: true });
      // A feed filled while hidden (a background tab, another view) cannot
      // scroll; it catches up when it is shown or resized.
      this._ro = new ResizeObserver(() => { if (this.view === 'live' && this.follow) this._scrollSoon(); });
      this._ro.observe(this.feed);
      this.renderHeader();
    }

    _scrollSoon() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = null; this._scrollNow(); });
    }
    _scrollNow() {
      if (selectionInside(this.feed)) return;
      this.feed.scrollTop = this.feed.scrollHeight;
    }

    destroy() {
      this._mo.disconnect();
      this._ro.disconnect();
      clearTimeout(this._historyTimer);
      if (areas.get(this.sessId) === this) areas.delete(this.sessId);
      this.el.remove();
    }

    addAliases(list) { for (const n of list) if (n) this.aliases.add(String(n)); }
    isMe(name) { return !!name && (this.aliases.has(name) || this.aliases.has(shortName(name, this.panel.run))); }
    ended() { return ENDED.has(this.state); }
    shownModel() { return this.actualModel || this.model || this.initModel || ''; }

    // ---- view toggle ----

    setView(v, { store = true } = {}) {
      if (!VIEWS.includes(v)) v = 'live';
      this.view = v;
      if (store) storeView(this.sessId, v);
      this.el.dataset.view = v;
      for (const [k, b] of Object.entries(this.segBtns)) b.classList.toggle('on', k === v);
      if (v === 'live') {
        this.segBtns.live.classList.remove('unread');
        this.follow = true;
        this.pill.classList.add('hidden');
        this._scrollSoon();
      } else if (v === 'todo') {
        this.renderTodo({ scroll: true });
      } else {
        this.renderNotes({ scroll: true });
      }
    }

    // Something new to read in Live while another view is showing.
    markUnread() {
      if (this.view !== 'live' && !this._replaying) this.segBtns.live.classList.add('unread');
    }

    // ---- header ----

    setState(s) {
      if (!s || s === this.state) return;
      this.state = s;
      if (s !== 'busy' && s !== 'awaiting') this.nowTool = null;
      this.renderHeader();
      this.panel.renderToolbar();
      this.panel.drawLinksSoon();
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
      const ended = ENDED.has(s);
      this.stateEl.textContent = STATE_TEXT[s] || s;
      this.stateEl.className = `sdk-chip sdk-area-state sdk-state-${ended ? 'exited' : s}`;
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
      // The last report heads the TODO view once ended, or when there is no TODO.
      this.finalEl.classList.toggle('hidden', !(r?.summary && (ended || !this.todo?.rows?.length)));
      if (r?.summary) this.finalEl.textContent = `${r.status || 'report'}: ${r.summary}`;
      this.costEl.textContent = fmtCost(this.cost);
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
      this.segBtns.todo.textContent = t.length ? `TODO ${done}/${t.length}` : 'TODO';
      this.renderNow();
    }

    // One line under the caption: what the agent is doing right now.
    renderNow() {
      const s = this.state || 'idle';
      let text = '';
      let cls = 'idle';
      if (ENDED.has(s)) text = 'ended';
      else if (s === 'awaiting') { text = 'waiting for your answer'; cls = 'awaiting'; }
      else if (s === 'pausing') { text = 'pausing: writing its resume note'; cls = 'busy'; }
      else if (s === 'paused') text = 'paused';
      else if (s === 'busy') {
        cls = 'busy';
        const t = this.nowTool;
        if (t) {
          const age = t.startedAt ? ` · ${fmtAge(Date.now() - t.startedAt)}` : '';
          text = `now: ${prettyTool(t.name)} ${oneLine(toolSummary(t.name, t.input))}`.trim() + age;
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
      this.renderTodo({ scroll: true });
      if (notesChanged) this.renderNotes({ scroll: true });
      this.renderHeader();
    }

    // The table fits its box: id and status stay narrow, a description wraps
    // to two lines (the whole text is its tooltip). It scrolls to the row in
    // progress, or to the newest row when none is.
    renderTodo({ scroll } = {}) {
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
      if (scroll && this.view === 'todo') {
        const doing = this.todoEl.querySelectorAll('.sdk-todo-doing');
        if (doing.length) scrollToNode(this.todoView, doing[doing.length - 1]);
        else this.todoView.scrollTop = this.todoView.scrollHeight;
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
      this.feed.innerHTML = '';
      this.msgs = new Map();      // message.id -> {id, pk, blocks}
      this.streams = new Map();   // parent_tool_use_id|'' -> {rec, byIndex}
      this.tools = new Map();     // tool_use_id -> {id, name, input, done, startedAt}
      this.nowTool = null;
      this.seen = new Set();
      this.follow = true;
      this.pill.classList.add('hidden');
    }

    requestHistory() {
      this.historyPending = true;
      this.queue = [];
      clearTimeout(this._historyTimer);
      // A server without sdk:history (or a lost reply) must not hold the live
      // feed back forever.
      this._historyTimer = setTimeout(() => {
        if (!this.historyPending) return;
        this.onHistory([], 'history did not arrive');
      }, HISTORY_WAIT_MS);
      sendWs({ type: 'sdk:history', sessId: this.sessId });
    }

    onHistory(events, error) {
      clearTimeout(this._historyTimer);
      this.reset();
      const keys = new Set();
      this._replaying = true;
      for (const rec of events) {
        const ev = unwrap(rec);
        keys.add(envKey(ev));
        try { this.apply(ev, false); } catch (e) { console.warn('sdk-panel: history event', e, ev); }
      }
      this._replaying = false;
      if (error) this.notice(`History: ${error}`, 'warn');
      const queued = this.queue;
      this.queue = [];
      this.historyPending = false;
      // Live events that raced the history reply; the ones history already
      // holds are skipped (deltas are never in history and always pass).
      for (const ev of queued) {
        if (ev?.sdk?.type !== 'stream_event' && keys.has(envKey(ev))) continue;
        try { this.apply(ev, true); } catch (e) { console.warn('sdk-panel: live event', e, ev); }
      }
      this.follow = true;
      this._scrollSoon();
      this.renderNow();
    }

    receive(ev) {
      if (this.historyPending) { this.queue.push(ev); return; }
      try { this.apply(ev, true); } catch (e) { console.warn('sdk-panel: event', e, ev); }
    }

    apply(ev, live) {
      if (!ev || typeof ev !== 'object') return;
      if (ev.sdk) return this.applySdk(ev.sdk, live);
      if (ev.user) return this.applyUser(ev.user, live);
      const p = ev.platform;
      if (!p) return;
      if (p.kind === 'message') return this.applyPeerMessage(p, live);
      if (p.kind === 'notice') {
        // A refused switch: the label goes back to the model still in use.
        if (/^Model not changed/.test(p.text || '') && this._modelBefore !== undefined) {
          this.model = this._modelBefore;
          this.actualModel = this._actualBefore || null;
          this._modelBefore = undefined;
          this.renderHeader();
        }
        return this.notice(p.text, p.level === 'warning' ? 'warn' : p.level);
      }
      if (p.kind === 'files') { if (live) this.requestTodo(); return; }
      if (p.kind === 'status') {
        this.gotStatus = true;
        if (typeof p.costUsd === 'number') this.setCost(p.costUsd);
        if (p.model !== undefined) { this.model = p.model || null; this._modelBefore = undefined; }
        if (p.actualModel !== undefined) this.actualModel = p.actualModel || null;
        if (p.mappedTo !== undefined) this.mappedTo = p.mappedTo || null;
        this.setState(p.state);
        this.renderHeader();
      }
    }

    applySdk(m, live) {
      if (m.uuid && m.type !== 'stream_event') {
        if (this.seen.has(m.uuid)) return;
        this.seen.add(m.uuid);
      }
      switch (m.type) {
        case 'stream_event': if (live) this.applyStream(m); return;
        case 'assistant': return this.applyAssistant(m);
        case 'user': return this.applySdkUser(m);
        case 'result': return this.applyResult(m);
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
      if (id) this.msgs.set(id, rec);
      return rec;
    }

    // Live draws the main agent's thinking and text. Tool calls and subagent
    // messages are tracked (for the "now:" line) but not drawn: the
    // Inspector button shows them.
    newBlock(rec, type, opts = {}) {
      if (type === 'tool_use') {
        const blk = { type, partial: '', final: false, toolId: opts.toolId || null, tool: this.toolStarted(opts.toolId, opts.toolName, rec.pk) };
        rec.blocks.push(blk);
        return blk;
      }
      if (rec.pk || (type !== 'text' && type !== 'thinking')) return null;
      const blk = { type, raw: '', final: false };
      if (type === 'text') {
        blk.el = blk.body = el('div', 'sdk-text markdown-body');
        this.markUnread();
      } else {
        blk.el = el('div', 'sdk-thinking open');
        const head = el('div', 'sdk-thinking-head', 'Thinking');
        blk.body = el('div', 'sdk-thinking-body');
        head.addEventListener('click', () => blk.el.classList.toggle('open'));
        blk.el.append(head, blk.body);
      }
      this.feed.appendChild(blk.el);
      rec.blocks.push(blk);
      return blk;
    }

    toolStarted(id, name, pk) {
      let t = id ? this.tools.get(id) : null;
      if (!t) {
        t = { id, name, input: null, done: false, startedAt: this._replaying ? null : Date.now(), sub: !!pk };
        if (id) this.tools.set(id, t);
      }
      if (!t.sub && !t.done) { this.nowTool = t; this.renderNow(); }
      return t;
    }

    setToolInput(t, input) {
      if (!t) return;
      t.input = input;
      if (t === this.nowTool) this.renderNow();
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
            blk.raw += d.thinking || '';
            blk.body.appendChild(document.createTextNode(d.thinking || ''));
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
          this.setToolInput(blk.tool, b.input || {});
        } else if (b.type === 'text' || b.type === 'thinking' || b.type === 'redacted_thinking') {
          const t = b.type === 'text' ? 'text' : 'thinking';
          let blk = rec.blocks.find(x => x.type === t && !x.final);
          if (!blk) blk = this.newBlock(rec, t);
          if (!blk) continue;
          blk.final = true;
          if (t === 'text') {
            blk.raw = b.text || '';
            cancelRenderDebounce(blk.body);
            renderMarkdown(blk.raw, blk.body);
          } else {
            blk.raw = b.type === 'redacted_thinking' ? '(redacted)' : (b.thinking || blk.raw || '');
            blk.body.textContent = blk.raw;
            blk.el.classList.remove('open');
            blk.el.classList.toggle('sdk-thinking-empty', !blk.raw.trim());
          }
        }
      }
      if (m.error) this.notice(`API error: ${typeof m.error === 'string' ? m.error : JSON.stringify(m.error)}`, 'error');
    }

    applySdkUser(m) {
      const c = m.message?.content;
      if (!Array.isArray(c)) return;
      for (const b of c) {
        if (b?.type !== 'tool_result') continue;
        const t = this.tools.get(b.tool_use_id);
        if (t) t.done = true;
        if (t && t === this.nowTool) {
          // The newest main-agent call still running, if any.
          this.nowTool = [...this.tools.values()].reverse().find(x => !x.done && !x.sub) || null;
          this.renderNow();
        }
      }
    }

    applyResult(m) {
      if (m.parent_tool_use_id) return;
      const bits = [];
      if (m.subtype && m.subtype !== 'success') bits.push(m.subtype.replace(/_/g, ' '));
      else bits.push(m.is_error ? 'ended with an error' : 'done');
      if (m.num_turns) bits.push(`${m.num_turns} turn${m.num_turns === 1 ? '' : 's'}`);
      if (m.duration_ms) bits.push(fmtSecs(m.duration_ms));
      if (typeof m.total_cost_usd === 'number') bits.push(`${fmtCost(m.total_cost_usd)} so far`);
      this.feed.appendChild(el('div', `sdk-result${m.is_error ? ' error' : ''}`, bits.join(' · ')));
      // total_cost_usd is the running total of this query(), so the latest wins.
      if (typeof m.total_cost_usd === 'number') this.setCost(m.total_cost_usd);
      this.nowTool = null;
      if (!this.gotStatus) this.setState('idle');
      this.renderNow();
    }

    applySystem(m) {
      switch (m.subtype) {
        case 'init':
          // Emitted at the start of every turn; only a model change is news.
          if (m.model && m.model !== this.initModel) {
            this.notice(`${this.initModel ? 'Model now' : 'Session started ·'} ${m.model}`);
            this.initModel = m.model;
            this.renderHeader();
          }
          if (!this.gotStatus) this.setState('busy');
          return;
        case 'compact_boundary': {
          const md = m.compact_metadata || {};
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
      this.feed.appendChild(bubble);
      if (!this.gotStatus) this.setState('busy');
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
      this.feed.appendChild(card);
      this.markUnread();
    }

    notice(text, level) {
      return this.feed.appendChild(el('div', `sdk-notice${level ? ` sdk-notice-${level}` : ''}`, String(text || '')));
    }
  }

  // ---- the model menu (one open at a time) ---------------------------------

  let _menu = null;
  function closeModelMenu() {
    if (!_menu) return;
    _menu.el.remove();
    document.removeEventListener('mousedown', _menu.onDown, true);
    document.removeEventListener('keydown', _menu.onKey, true);
    _menu = null;
  }

  // The same options as the tab settings and the tab-strip cog. A switch
  // keeps the conversation and its cost; the next turn caches the whole
  // context again at the new model's rate, so the menu says so.
  function openModelMenu(area, anchor) {
    const reopen = _menu?.area === area;
    closeModelMenu();
    if (reopen || area.ended()) return;
    const listed = window.cliModule?.modelPickerOptions?.() || [];
    const opts = listed.length ? listed : FALLBACK_MODELS.map(v => ({ value: v, label: v, group: 'Aliases', price: '' }));
    const cur = area.model || '';
    const box = el('div', 'sdk-model-menu');
    box.appendChild(el('div', 'sdk-model-warn', 'The context and the cost so far are kept. The next turn re-caches the whole context at the new model\'s rate.'));
    let group = null;
    for (const o of opts) {
      if (o.group !== group) { group = o.group; box.appendChild(el('div', 'sdk-model-group', group || '')); }
      const b = el('button', `sdk-model-opt${o.value === cur ? ' on' : ''}`);
      b.type = 'button';
      b.appendChild(el('span', 'sdk-model-opt-label', o.label || o.value));
      if (o.price) b.appendChild(el('span', 'sdk-model-opt-price', o.price));
      b.addEventListener('click', () => {
        closeModelMenu();
        if (o.value === cur) return;
        area._modelBefore = area.model;
        area._actualBefore = area.actualModel;
        area.model = o.value;
        area.actualModel = null;
        area.renderHeader();
        sendWs({ type: 'sdk:setModel', sessId: area.sessId, model: o.value });
      });
      box.appendChild(b);
    }
    document.body.appendChild(box);
    const r = anchor.getBoundingClientRect();
    const h = Math.min(box.scrollHeight, window.innerHeight * 0.6);
    const below = window.innerHeight - r.bottom > h + 12;
    box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - box.offsetWidth - 8))}px`;
    box.style.top = `${below ? r.bottom + 4 : Math.max(8, r.top - h - 4)}px`;
    const onDown = (e) => { if (!box.contains(e.target) && e.target !== anchor) closeModelMenu(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeModelMenu(); } };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    _menu = { el: box, area, onDown, onKey };
  }

  // ---- pick a session, then confirm (one dialog at a time) -----------------

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

  class Panel {
    constructor(tabId, wrap) {
      this.tabId = tabId;
      this.wrap = wrap;
      this.info = {};
      this.runId = null;
      this.run = null;
      this.main = null;
      this.workers = new Map();  // sessId -> Area
      this.active = false;
      wrap.classList.add('sdk-wrap');
      wrap.innerHTML = `
        <div class="sdk-panel">
          <div class="sdk-toolbar">
            <span class="sdk-toolbar-badge">SDK</span>
            <span class="sdk-toolbar-title"></span>
            <span class="sdk-toolbar-meta"></span>
            <span class="sdk-toolbar-cost"></span>
            <span class="sdk-spacer"></span>
            <button type="button" class="sdk-tb-btn" data-act="interrupt">Interrupt</button>
            <button type="button" class="sdk-tb-btn" data-act="pause">Pause</button>
            <button type="button" class="sdk-tb-btn hidden" data-act="board" title="Workers, reports and TODO of the run">☰ Run board</button>
          </div>
          <div class="sdk-stage">
            <svg class="sdk-links" aria-hidden="true"></svg>
            <div class="sdk-main-slot"></div>
            <div class="sdk-workers"></div>
          </div>
          <vc-composer placeholder="Message… (Enter or Ctrl+Enter, then choose the session · Shift+Enter new line · Esc interrupts)"></vc-composer>
        </div>`;
      const q = (s) => wrap.querySelector(s);
      this.panelEl = q('.sdk-panel');
      this.titleEl = q('.sdk-toolbar-title');
      this.metaEl = q('.sdk-toolbar-meta');
      this.costEl = q('.sdk-toolbar-cost');
      this.stage = q('.sdk-stage');
      this.linksEl = q('.sdk-links');
      this.mainSlot = q('.sdk-main-slot');
      this.workersEl = q('.sdk-workers');
      this.interruptBtn = q('[data-act="interrupt"]');
      this.pauseBtn = q('[data-act="pause"]');
      this.boardBtn = q('[data-act="board"]');
      this.composer = q('vc-composer');

      this.interruptBtn.addEventListener('click', () => this.interrupt());
      this.pauseBtn.addEventListener('click', () => this.pause());
      this.boardBtn.addEventListener('click', () => { if (this.runId) window.cliModule?.openRunBoard?.(this.runId); });
      this.composer.addEventListener('send', (e) => this.openPicker('send', e.detail));
      this.composer.addEventListener('interrupt', () => this.interrupt());
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
        this.main.requestHistory();
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
        if (runId) this.fetchRun();
      }
      this.composer.disabled = this.info.status === 'exited';
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
        // Every cost is a session's running total (its latest total_cost_usd):
        // replace, never add. Only the toolbar adds, across sessions.
        const oc = costOf(run.orchestratorCost ?? run.cost);
        if (oc != null) this.main.setCost(oc);
        if (run.orchestratorState) this.main.setState(run.orchestratorState);
        this.main.renderHeader();
      }
      for (const w of run.workers || []) {
        if (!w.sessId) continue;
        if (w.engine && w.engine !== 'sdk') continue;
        let a = this.workers.get(w.sessId);
        if (!a) a = this.addWorker(w.sessId, w.name || w.worker);
        a.name = w.name || w.worker || a.name;
        a.label = w.id ? `${w.id}${w.title && w.title !== w.id ? ` · ${w.title}` : ''}` : shortName(a.name, run);
        a.addAliases([w.name, w.worker, w.id, shortName(w.name || w.worker, run)]);
        // A new report travels up the worker's line (not on the first load).
        const rep = w.lastReport ? JSON.stringify([w.lastReport.status, w.lastReport.summary, w.lastReport.at]) : null;
        if (rep && a._repSig !== undefined && rep !== a._repSig) this.flashLink(a.name, this.main?.name);
        a._repSig = rep;
        a.lastReport = w.lastReport || null;
        if (!a.model && w.model) a.model = w.model;
        const c = costOf(w.cost ?? w.costUsd);
        if (c != null) a.cost = c;
        const derived = w.state
          || (w.running ? (w.live?.pausing ? 'pausing' : w.live?.busy ? 'busy' : null) : w.paused ? 'paused' : 'exited');
        if (derived && (w.state || !a.gotStatus || derived === 'exited' || derived === 'paused')) a.setState(derived);
        a.workerId = w.id;
        a.renderHeader();
      }
      this.layoutWorkers();
      this.renderToolbar();
      for (const a of this.allAreas()) a.renderHeader();
    }

    addWorker(sessId, name) {
      const existing = areas.get(sessId);
      if (existing) existing.destroy();
      const label = name && name !== sessId ? shortName(name, this.run) : `worker ${sessId.slice(0, 8)}`;
      const a = new Area(this, sessId, { role: 'worker', name, label });
      this.workers.set(sessId, a);
      this.workersEl.appendChild(a.el);
      a.requestHistory();
      a.requestTodo();
      this.layoutWorkers();
      return a;
    }

    // Workers in id order, one row. Past three boxes, ended ones narrow so
    // the running ones keep their room.
    layoutWorkers() {
      const list = this.sortedWorkers();
      list.forEach(a => this.workersEl.appendChild(a.el));
      this.panelEl.classList.toggle('has-workers', list.length > 0);
      this.workersEl.classList.toggle('crowded', list.length > 3);
      this.drawLinksSoon();
    }

    // ---- the lines between the boxes ----

    drawLinksSoon() {
      if (this._linkRaf) return;
      this._linkRaf = requestAnimationFrame(() => { this._linkRaf = null; this.drawLinks(); });
    }

    // One curve per worker, from the orchestrator's bottom edge down onto the
    // worker's name tag (the caption on its top border). Redrawn on every
    // resize of the stage.
    // Paths are updated in place, so a redraw never cuts a flash short.
    drawLinks() {
      const svg = this.linksEl;
      const list = this.sortedWorkers();
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
        const path = this.linksEl.querySelector(`g[data-sess="${CSS.escape(w.sessId)}"] path`);
        if (!path) continue;
        path.classList.remove('flash-up', 'flash-down');
        void path.getBoundingClientRect();
        path.classList.add(`flash-${dir}`);
        clearTimeout(path._flashT);
        path._flashT = setTimeout(() => path.classList.remove(`flash-${dir}`), LINK_FLASH_MS);
      }
    }

    // ---- sending ----

    // Submit → pick the session → confirm. There is no remembered target:
    // every message names its session, and the confirmation says which one.
    // `mode` 'interrupt' picks a busy session and stops it, without a
    // confirmation step.
    openPicker(mode, payload = {}) {
      closePicker();
      closeModelMenu();
      const list = this.allAreas();
      if (!list.length) return;
      const pickable = (a) => mode === 'send' ? !a.ended() : (a.state === 'busy' || a.state === 'awaiting' || a.state === 'pausing');
      if (mode === 'interrupt' && list.length === 1) {
        if (pickable(list[0])) sendWs({ type: 'sdk:interrupt', sessId: list[0].sessId });
        return;
      }
      const backdrop = el('div', 'alert-modal-backdrop sdk-pick-backdrop');
      const modal = el('div', 'alert-modal sdk-pick');
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.tabIndex = -1;
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);
      backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closePicker(); });
      const pick = _pick = { panel: this, backdrop, modal, mode, payload, list, pickable, step: 'pick', armed: false, target: null };
      pick.onKeyUp = () => { pick.armed = true; };
      pick.onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(); return; }
        if (pick.step === 'pick') {
          const i = /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : -1;
          if (i >= 0 && list[i] && pickable(list[i])) { e.preventDefault(); this._picked(list[i], { byKey: true }); }
          return;
        }
        if (e.key === 'Enter') {
          // The Enter that submitted (or one held down) never confirms: it
          // takes a fresh key press.
          e.preventDefault();
          e.stopPropagation();
          if (pick.armed && !e.repeat) this._confirmSend();
        }
      };
      document.addEventListener('keydown', pick.onKey, true);
      document.addEventListener('keyup', pick.onKeyUp, true);
      // Only one box to choose from (a plain tab): straight to the confirmation.
      if (mode === 'send' && list.length === 1 && pickable(list[0])) this._picked(list[0], { byKey: true });
      else this._renderPick();
    }

    _nodeMeta(a) {
      return [fmtModel(a.shownModel()), STATE_TEXT[a.state || 'idle'] || a.state].filter(Boolean).join(' · ');
    }

    _renderPick() {
      const pick = _pick;
      const { modal, list, pickable, mode } = pick;
      pick.step = 'pick';
      const node = (a, i) => {
        const b = el('button', `sdk-pick-node sdk-pick-${a.role}${pickable(a) ? '' : ' off'}`);
        b.type = 'button';
        b.disabled = !pickable(a);
        b.appendChild(el('span', 'sdk-pick-key', String(i + 1)));
        b.appendChild(el('span', 'sdk-pick-name', a.label));
        b.appendChild(el('span', 'sdk-pick-meta', this._nodeMeta(a)));
        b.addEventListener('click', () => this._picked(a));
        return b;
      };
      modal.innerHTML = '';
      modal.appendChild(el('div', 'sdk-pick-title', mode === 'send' ? 'Send to which session?' : 'Interrupt which session?'));
      const map = el('div', 'sdk-pick-map');
      const [first, ...rest] = list;
      map.appendChild(node(first, 0));
      if (rest.length) {
        const row = el('div', 'sdk-pick-row');
        row.style.setProperty('--n', rest.length);
        rest.forEach((a, i) => row.appendChild(node(a, i + 1)));
        map.appendChild(row);
      }
      modal.appendChild(map);
      modal.appendChild(el('div', 'sdk-pick-hint', mode === 'send'
        ? 'Click a box or press its number. Ended sessions cannot take messages.'
        : 'Click a busy box or press its number.'));
      const actions = el('div', 'sdk-pick-actions');
      const cancel = el('button', 'sdk-tb-btn', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', closePicker);
      actions.appendChild(cancel);
      modal.appendChild(actions);
      modal.focus();
    }

    // `byKey`: a key is still down (the submitting Enter, a number), so the
    // confirmation waits for its release. A click leaves no key down.
    _picked(a, { byKey = false } = {}) {
      const pick = _pick;
      if (!pick || !pick.pickable(a)) return;
      if (pick.mode === 'interrupt') {
        sendWs({ type: 'sdk:interrupt', sessId: a.sessId });
        closePicker();
        return;
      }
      pick.target = a;
      pick.step = 'confirm';
      pick.armed = !byKey;
      const { modal, payload, list } = pick;
      const text = String(payload.text || '');
      const lines = text.split('\n');
      const preview = lines.slice(0, 3).join('\n') + (lines.length > 3 ? '\n…' : '');
      const nImg = (payload.images || []).length;
      modal.innerHTML = '';
      const title = el('div', 'sdk-pick-title');
      title.append('Send to ', el('b', null, a.label), '?');
      modal.appendChild(title);
      modal.appendChild(el('div', 'sdk-pick-meta-line', this._nodeMeta(a)));
      if (a.state === 'busy' || a.state === 'awaiting') {
        modal.appendChild(el('div', 'sdk-pick-note', 'It is busy: it reads this after its current tool calls.'));
      }
      if (text) modal.appendChild(el('pre', 'sdk-pick-preview', clip(preview, 600)));
      if (nImg) modal.appendChild(el('div', 'sdk-pick-imgs', `+ ${nImg} image${nImg === 1 ? '' : 's'}`));
      const actions = el('div', 'sdk-pick-actions');
      if (list.length > 1) {
        const back = el('button', 'sdk-tb-btn', '← Back');
        back.type = 'button';
        back.addEventListener('click', () => this._renderPick());
        actions.appendChild(back);
      }
      const cancel = el('button', 'sdk-tb-btn', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', closePicker);
      const send = el('button', 'alert-modal-ok sdk-pick-send', `Send to ${clip(a.label, 32)}`);
      send.type = 'button';
      send.addEventListener('click', () => this._confirmSend());
      actions.append(cancel, send);
      modal.appendChild(actions);
      send.focus();
    }

    _confirmSend() {
      const pick = _pick;
      if (!pick || pick.step !== 'confirm' || !pick.target) return;
      const { target, payload } = pick;
      sendWs({ type: 'sdk:send', sessId: target.sessId, text: payload.text, images: payload.images || [] });
      // The draft stays in the composer until a message is really sent.
      this.composer.clear();
      closePicker();
    }

    interrupt() { this.openPicker('interrupt'); }

    // The same pause flow as the tab strip: an orchestrator pauses its run,
    // a plain tab itself; while pausing it offers "interrupt now".
    pause() {
      const info = this.info;
      if (info.pausing) {
        if (confirm('Interrupt now? The session stops mid-step and is saved as interrupted; its resume note may be missing.')) {
          sendWs({ type: 'cli:interrupt', tabId: this.tabId });
        }
        return;
      }
      if (this.runId) {
        if (!confirm('Pause this run? Each worker finishes its step, writes its resume note and closes; the orchestrator closes last. It may take a while.')) return;
        sendWs({ type: 'cli:pauseRun', runId: this.runId });
      } else {
        sendWs({ type: 'cli:pause', tabId: this.tabId });
      }
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
      const busy = this.allAreas().filter(a => a.state === 'busy' || a.state === 'awaiting' || a.state === 'pausing');
      this.interruptBtn.title = this.areaCount() > 1 ? 'Interrupt a session: you choose which (Esc in the composer)' : 'Interrupt the session (Esc in the composer)';
      this.interruptBtn.disabled = !busy.length;
      const running = info.status === 'running';
      const isWorkerTab = info.settings?.orchestration?.role === 'worker';
      this.pauseBtn.classList.toggle('hidden', isWorkerTab);
      this.pauseBtn.disabled = !running;
      this.pauseBtn.textContent = info.pausing ? 'Interrupt now' : this.runId ? 'Pause run' : 'Pause';
      this.pauseBtn.title = info.pausing
        ? 'Pausing… (writing the resume note). Click to interrupt now.'
        : this.runId ? 'Workers write their notes and close, then the orchestrator. Resume from the "+" menu.'
          : 'The session finishes its step, writes its resume note and closes. Resume from the "+" menu.';
      this.boardBtn.classList.toggle('hidden', !this.runId);
    }

    reloadHistory() {
      for (const a of this.allAreas()) { a.requestHistory(); a.requestTodo(); }
      if (this.runId) this.fetchRun();
    }

    pollTodos() {
      if (!this.active || document.visibilityState !== 'visible' || !this.wrap.offsetParent) return;
      // An ended worker's files no longer move.
      for (const a of this.allAreas()) if (!a.ended()) a.requestTodo();
    }

    tick() {
      for (const a of this.allAreas()) if (a.nowTool?.startedAt && a.state === 'busy') a.renderNow();
    }

    setActive(v) {
      this.active = !!v;
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
      if (_menu && this.allAreas().includes(_menu.area)) closeModelMenu();
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
  function unmount(tabId) {
    const p = panels.get(tabId);
    if (!p) return;
    p.destroy();
    panels.delete(tabId);
  }
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

  function handleMessage(msg) {
    switch (msg.type) {
      case 'sdk:event': {
        // A refusal answered only to this window (e.g. a refused sdk:send)
        // may come without a known session: show it in the main box.
        const a = areas.get(msg.sessId) || adopt(msg)
          || (!areas.has(msg.sessId) && msg.ev?.platform?.kind === 'notice' ? activePanel()?.main : null);
        // A freshly adopted area has just asked for history, which queues
        // this event and drops it if history already holds it.
        a?.receive(msg.ev);
        break;
      }
      case 'sdk:history':
        // {sessId, events} — or the run form {runId, sessions:[{sessId, events}]}.
        if (Array.isArray(msg.sessions)) {
          for (const x of msg.sessions) areas.get(x.sessId)?.onHistory(Array.isArray(x.events) ? x.events : [], x.error);
        } else {
          areas.get(msg.sessId)?.onHistory(Array.isArray(msg.events) ? msg.events : [], msg.error);
        }
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

  window.sdkPanel = { mount, update, unmount, setActive, onTabs, onRunUpdate, handleMessage, _panels: panels, _areas: areas };
})();
