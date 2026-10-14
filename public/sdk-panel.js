// Agent SDK panel: the HTML view of an `kind:'sdk'` CLI tab. One panel per
// tab; for an orchestrator tab the orchestrator's area sits on top and one
// area per worker follows (workers are hidden sessions with no tab of their
// own). A plain SDK tab has a single area.
//
// Everything shown is server state: on mount and after a reconnect each area
// asks for `sdk:history` (the session's transcript, no stream deltas),
// replays it, then continues from the live `sdk:event` broadcasts. TODO.md
// comes from `sdk:todo`, run membership from GET /api/orchestration/run.
// cli.js owns the tab; this file owns what is inside its wrap.
(function () {
  const D = window.dashboard;
  const { sendWs, state, escHtml, renderMarkdown, renderMarkdownDebounced, cancelRenderDebounce } = D;

  const POLL_MS = 5000;
  const HISTORY_WAIT_MS = 10000;
  const FOLLOW_SLACK_PX = 48;
  const AGENT_TOOLS = new Set(['Agent', 'Task']);

  const panels = new Map();   // tabId -> Panel
  const areas = new Map();    // sessId -> Area (across panels: workers have no tab)
  let _lastWs = null;

  // ---- small helpers -------------------------------------------------------

  const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const fmtCost = (usd) => typeof usd === 'number' && isFinite(usd)
    ? `$${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)}` : '';
  const fmtSecs = (ms) => ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
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

  // The tool's one-line gist, as the Inspector shows it.
  function toolSummary(name, input) {
    if (!input || typeof input !== 'object') return '';
    if (AGENT_TOOLS.has(name)) return [input.subagent_type, input.description].filter(Boolean).join(': ');
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
  function resultText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content, null, 2);
    return content.map(b => b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : JSON.stringify(b)).join('\n');
  }
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

  // ---- Area: one agent's header, TODO, feed --------------------------------

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
      this.collapsed = false;
      this.autoCollapsed = false;
      this.todo = null;
      this.todoOpen = true;
      this.notesOpen = false;
      this.follow = true;
      this.queue = [];
      this.historyPending = false;
      this._build();
      this.reset();
      areas.set(sessId, this);
    }

    _build() {
      const root = this.el = el('section', `sdk-area sdk-area-${this.role}`);
      root.dataset.sessId = this.sessId;
      root.innerHTML = `
        <header class="sdk-area-head">
          <button type="button" class="sdk-area-fold" title="Collapse / expand">▾</button>
          <span class="sdk-area-name"></span>
          <span class="sdk-chip sdk-area-state"></span>
          <span class="sdk-chip sdk-area-report hidden"></span>
          <span class="sdk-area-cost"></span>
          <span class="sdk-spacer"></span>
          <button type="button" class="sdk-area-btn" data-a="todo" title="TODO.md">TODO</button>
          <button type="button" class="sdk-area-btn" data-a="notes" title="NOTES.md">NOTES</button>
          <button type="button" class="sdk-area-btn" data-a="msg" title="Send the next message to this agent">message</button>
        </header>
        <div class="sdk-area-awaiting hidden">Awaiting your answer: the question is open in the dialog.</div>
        <div class="sdk-area-final hidden"></div>
        <div class="sdk-area-todo hidden"></div>
        <div class="sdk-area-notes markdown-body hidden"></div>
        <div class="sdk-area-body">
          <div class="sdk-feed"></div>
          <button type="button" class="sdk-live-pill hidden">↓ jump to live</button>
        </div>`;
      const q = (s) => root.querySelector(s);
      this.nameEl = q('.sdk-area-name');
      this.stateEl = q('.sdk-area-state');
      this.reportEl = q('.sdk-area-report');
      this.costEl = q('.sdk-area-cost');
      this.awaitEl = q('.sdk-area-awaiting');
      this.finalEl = q('.sdk-area-final');
      this.todoEl = q('.sdk-area-todo');
      this.notesEl = q('.sdk-area-notes');
      this.feed = q('.sdk-feed');
      this.pill = q('.sdk-live-pill');
      this.todoBtn = q('[data-a="todo"]');
      this.notesBtn = q('[data-a="notes"]');
      this.msgBtn = q('[data-a="msg"]');

      q('.sdk-area-fold').addEventListener('click', () => this.setCollapsed(!this.collapsed, true));
      q('.sdk-area-name').addEventListener('dblclick', () => this.setCollapsed(!this.collapsed, true));
      this.todoBtn.addEventListener('click', () => { this.todoOpen = !this.todoOpen; this.renderTodo(); });
      this.notesBtn.addEventListener('click', () => { this.notesOpen = !this.notesOpen; this.renderTodo(); });
      this.msgBtn.addEventListener('click', () => this.panel.setTarget(this.sessId));

      // Follow the stream only while the reader is at the bottom; scrolling up
      // to read pauses it and offers the pill instead.
      this.feed.addEventListener('scroll', () => {
        const atBottom = this.feed.scrollHeight - this.feed.scrollTop - this.feed.clientHeight <= FOLLOW_SLACK_PX;
        this.follow = atBottom;
        if (atBottom) this.pill.classList.add('hidden');
      }, { passive: true });
      this.pill.addEventListener('click', () => { this.follow = true; this.pill.classList.add('hidden'); this._scrollNow(); });
      // Every change to the feed (new blocks, deltas, the debounced markdown
      // render that lands later) goes through one observer, so following
      // never lags a render.
      this._mo = new MutationObserver(() => {
        if (this.follow) this._scrollSoon();
        else this.pill.classList.remove('hidden');
      });
      this._mo.observe(this.feed, { childList: true, subtree: true, characterData: true });
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
      clearTimeout(this._historyTimer);
      if (areas.get(this.sessId) === this) areas.delete(this.sessId);
      this.el.remove();
    }

    addAliases(list) { for (const n of list) if (n) this.aliases.add(String(n)); }
    isMe(name) { return !!name && (this.aliases.has(name) || this.aliases.has(shortName(name, this.panel.run))); }

    // ---- header ----

    setCollapsed(v, byUser) {
      this.collapsed = !!v;
      if (byUser) this.userFolded = true;
      this.el.classList.toggle('collapsed', this.collapsed);
      this.el.querySelector('.sdk-area-fold').textContent = this.collapsed ? '▸' : '▾';
      this.renderHeader();
      if (!this.collapsed && this.follow) this._scrollSoon();
    }

    setState(s) {
      if (!s || s === this.state) return;
      this.state = s;
      // Ended workers fold to their final report, once; the owner can unfold.
      if (this.role === 'worker' && ENDED.has(s) && !this.autoCollapsed && !this.userFolded) {
        this.autoCollapsed = true;
        this.setCollapsed(true);
      }
      this.renderHeader();
      this.panel.renderToolbar();
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
      const stateText = { busy: 'busy', idle: 'idle', awaiting: 'awaiting answer', paused: 'paused', exited: 'exited', pausing: 'pausing' }[s] || s;
      this.stateEl.textContent = stateText;
      this.stateEl.className = `sdk-chip sdk-area-state sdk-state-${ENDED.has(s) ? 'exited' : s}`;
      this.awaitEl.classList.toggle('hidden', s !== 'awaiting');
      this.el.classList.toggle('sdk-area-is-awaiting', s === 'awaiting');
      this.el.classList.toggle('sdk-area-is-busy', s === 'busy');
      const r = this.lastReport;
      this.reportEl.classList.toggle('hidden', !r);
      if (r) {
        this.reportEl.textContent = r.status || 'report';
        this.reportEl.title = r.summary || '';
        this.reportEl.className = `sdk-chip sdk-area-report sdk-report-${String(r.status || '').toLowerCase().replace(/[^a-z]/g, '')}`;
      }
      this.finalEl.classList.toggle('hidden', !(this.collapsed && r?.summary));
      if (r?.summary) this.finalEl.textContent = `${r.status || 'report'}: ${r.summary}`;
      this.costEl.textContent = fmtCost(this.cost);
      const t = this.todo?.rows || [];
      const done = t.filter(x => isDone(x.status)).length;
      this.todoBtn.textContent = t.length ? `TODO ${done}/${t.length}` : 'TODO';
      this.todoBtn.classList.toggle('active', this.todoOpen && t.length > 0);
      this.notesBtn.classList.toggle('hidden', !this.todo?.notes);
      this.notesBtn.classList.toggle('active', this.notesOpen);
      this.msgBtn.classList.toggle('hidden', this.panel.areaCount() < 2);
      this.msgBtn.classList.toggle('active', this.panel.targetSess === this.sessId);
    }

    // ---- TODO.md / NOTES.md ----

    requestTodo() { sendWs({ type: 'sdk:todo', sessId: this.sessId }); }

    onTodo(msg) {
      const rows = Array.isArray(msg.rows) ? msg.rows : [];
      const notes = typeof msg.notes === 'string' ? msg.notes : '';
      const sig = JSON.stringify([rows, notes]);
      if (sig === this._todoSig) return;
      this._todoSig = sig;
      this.todo = { rows, notes };
      this.renderTodo();
    }

    renderTodo() {
      const rows = this.todo?.rows || [];
      this.todoEl.classList.toggle('hidden', !(this.todoOpen && rows.length));
      if (this.todoOpen && rows.length) {
        const body = rows.map(r => {
          const st = String(r.status || '');
          const cls = isDoing(st) ? 'doing' : isDone(st) ? 'done' : isBlocked(st) ? 'blocked' : 'open';
          return `<tr class="sdk-todo-${cls}"><td class="sdk-todo-id">${escHtml(r.id)}</td>`
            + `<td class="sdk-todo-desc" title="${escHtml(r.dependsOn ? `depends on ${r.dependsOn}` : '')}">${escHtml(r.description || '')}</td>`
            + `<td><span class="sdk-chip sdk-todo-chip sdk-todo-chip-${cls}">${escHtml(st || '—')}</span></td></tr>`;
        }).join('');
        this.todoEl.innerHTML = `<table class="sdk-todo"><tbody>${body}</tbody></table>`;
        this.todoEl.querySelector('.sdk-todo-doing')?.scrollIntoView?.({ block: 'nearest' });
      }
      const notes = this.todo?.notes || '';
      this.notesEl.classList.toggle('hidden', !(this.notesOpen && notes));
      if (this.notesOpen && notes && this._notesShown !== notes) {
        this._notesShown = notes;
        renderMarkdown(notes, this.notesEl, { file: true });
      }
      this.renderHeader();
    }

    // ---- feed: history, then live ----

    reset() {
      this.feed.innerHTML = '';
      this.msgs = new Map();      // message.id -> {id, pk, blocks}
      this.streams = new Map();   // parent_tool_use_id|'' -> {rec, byIndex}
      this.tools = new Map();     // tool_use_id -> card
      this.orphanNests = new Map();
      this.seen = new Set();
      this.model = null;
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
      for (const rec of events) {
        const ev = unwrap(rec);
        keys.add(envKey(ev));
        try { this.apply(ev, false); } catch (e) { console.warn('sdk-panel: history event', e, ev); }
      }
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
    }

    receive(ev) {
      if (this.historyPending) { this.queue.push(ev); return; }
      try { this.apply(ev, true); } catch (e) { console.warn('sdk-panel: event', e, ev); }
    }

    apply(ev, live) {
      if (!ev || typeof ev !== 'object') return;
      if (ev.sdk) return this.applySdk(ev.sdk, live);
      if (ev.user) return this.applyUser(ev.user);
      const p = ev.platform;
      if (!p) return;
      if (p.kind === 'message') return this.applyPeerMessage(p);
      if (p.kind === 'notice') return this.notice(p.text, p.level === 'warning' ? 'warn' : p.level);
      if (p.kind === 'status') {
        this.gotStatus = true;
        if (typeof p.costUsd === 'number') this.setCost(p.costUsd);
        this.setState(p.state);
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
          const card = this.tools.get(m.tool_use_id);
          if (card && !card.done) card.stateEl.textContent = `⋯ ${Math.round(m.elapsed_time_seconds || 0)}s`;
          return;
        }
      }
    }

    // Where a message's blocks go: the area's feed, or nested under the
    // Agent card that started the subagent.
    containerFor(parentId) {
      if (!parentId) return this.feed;
      const card = this.tools.get(parentId);
      if (card) { card.nest.classList.remove('hidden'); return card.nest; }
      let nest = this.orphanNests.get(parentId);
      if (!nest) {
        const wrap = el('div', 'sdk-tool sdk-tool-agent open');
        wrap.innerHTML = '<div class="sdk-tool-head"><span class="sdk-tool-caret">▾</span><span class="sdk-tool-name">subagent</span></div>';
        nest = el('div', 'sdk-tool-nest');
        wrap.appendChild(nest);
        wrap.querySelector('.sdk-tool-head').addEventListener('click', () => wrap.classList.toggle('open'));
        this.feed.appendChild(wrap);
        this.orphanNests.set(parentId, nest);
      }
      return nest;
    }

    msgRec(id, pk) {
      if (id && this.msgs.has(id)) return this.msgs.get(id);
      const rec = { id: id || null, pk, blocks: [] };
      if (id) this.msgs.set(id, rec);
      return rec;
    }

    newBlock(rec, type, opts = {}) {
      const container = this.containerFor(rec.pk);
      const blk = { type, raw: '', partial: '', final: false, toolId: opts.toolId || null };
      if (type === 'text') {
        blk.el = blk.body = el('div', 'sdk-text markdown-body');
      } else if (type === 'thinking') {
        blk.el = el('div', 'sdk-thinking open');
        const head = el('div', 'sdk-thinking-head', 'Thinking');
        blk.body = el('div', 'sdk-thinking-body');
        head.addEventListener('click', () => blk.el.classList.toggle('open'));
        blk.el.append(head, blk.body);
      } else if (type === 'tool_use') {
        blk.card = this.toolCard(opts.toolId, opts.toolName, container);
        blk.card.blk = blk;
        blk.el = blk.card.el;
        rec.blocks.push(blk);
        return blk;
      } else {
        return null;
      }
      container.appendChild(blk.el);
      rec.blocks.push(blk);
      return blk;
    }

    toolCard(id, name, container) {
      const isAgent = AGENT_TOOLS.has(name);
      const root = el('div', `sdk-tool running${isAgent ? ' sdk-tool-agent open' : ''}${/(^|__)SendMessage$/.test(name || '') ? ' sdk-tool-send' : ''}`);
      root.innerHTML = `
        <div class="sdk-tool-head"><span class="sdk-tool-caret"></span><span class="sdk-tool-name"></span><span class="sdk-tool-sum"></span><span class="sdk-tool-st">⋯</span></div>
        <div class="sdk-tool-body"><pre class="sdk-tool-input"></pre><pre class="sdk-tool-result hidden"></pre></div>
        <div class="sdk-tool-nest hidden"></div>`;
      const card = {
        id, name, el: root, isAgent, done: false,
        caret: root.querySelector('.sdk-tool-caret'),
        sumEl: root.querySelector('.sdk-tool-sum'),
        stateEl: root.querySelector('.sdk-tool-st'),
        inputEl: root.querySelector('.sdk-tool-input'),
        resultEl: root.querySelector('.sdk-tool-result'),
        nest: root.querySelector('.sdk-tool-nest'),
      };
      root.querySelector('.sdk-tool-name').textContent = prettyTool(name);
      const syncCaret = () => { card.caret.textContent = root.classList.contains('open') ? '▾' : '▸'; };
      syncCaret();
      root.querySelector('.sdk-tool-head').addEventListener('click', () => { root.classList.toggle('open'); syncCaret(); });
      card.syncCaret = syncCaret;
      container.appendChild(root);
      if (id) this.tools.set(id, card);
      return card;
    }

    setToolInput(card, input) {
      card.input = input;
      card.sumEl.textContent = clip(oneLine(toolSummary(card.name, input)), 140);
      card.inputEl.textContent = clip(JSON.stringify(input, null, 2), 6000);
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
          // the deltas) is not drawn twice.
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
            blk.card.inputEl.textContent = clip(blk.partial, 6000);
          }
          return;
        }
        case 'content_block_stop': {
          const blk = cur?.byIndex.get(ev.index);
          if (!blk || blk.final) return;
          if (blk.type === 'tool_use') {
            try { this.setToolInput(blk.card, JSON.parse(blk.partial || '{}')); } catch {}
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
          let blk = rec.blocks.find(x => x.type === 'tool_use' && x.toolId === b.id) || this.tools.get(b.id)?.blk;
          if (!blk) blk = this.newBlock(rec, 'tool_use', { toolId: b.id, toolName: b.name });
          blk.final = true;
          this.setToolInput(blk.card, b.input || {});
        } else if (b.type === 'text' || b.type === 'thinking' || b.type === 'redacted_thinking') {
          const t = b.type === 'text' ? 'text' : 'thinking';
          let blk = rec.blocks.find(x => x.type === t && !x.final);
          if (!blk) blk = this.newBlock(rec, t);
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
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === 'tool_result') this.toolResult(b.tool_use_id, b.content, b.is_error);
        }
      }
      // The prompt a subagent was started with, shown dimmed in its nest.
      // Top-level user turns arrive as {user:…} envelopes instead.
      if (m.parent_tool_use_id && !m.isSynthetic) {
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';
        if (text.trim()) this.containerFor(m.parent_tool_use_id).appendChild(el('div', 'sdk-sub-prompt', clip(text, 600)));
      }
    }

    toolResult(id, content, isError) {
      let card = this.tools.get(id);
      if (!card) {
        card = this.toolCard(id, 'tool result', this.feed);
        card.sumEl.textContent = '(its call is not in this view)';
      }
      card.done = true;
      card.el.classList.remove('running');
      card.el.classList.toggle('error', !!isError);
      card.stateEl.textContent = isError ? '✗' : '✓';
      const text = resultText(content);
      card.resultEl.textContent = clip(text, 8000);
      card.resultEl.classList.toggle('hidden', !text);
      // A finished subagent folds away to its card; its report is the result.
      if (card.isAgent) { card.el.classList.remove('open'); card.syncCaret(); }
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
      if (!this.gotStatus) this.setState('idle');
    }

    applySystem(m) {
      switch (m.subtype) {
        case 'init':
          // Emitted at the start of every turn; only a model change is news.
          if (m.model && m.model !== this.model) {
            this.notice(`${this.model ? 'Model now' : 'Session started ·'} ${m.model}`);
            this.model = m.model;
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

    applyUser(u) {
      const text = String(u.text || '');
      if (u.from) {
        // A peer's message is drawn once, from its platform `message` card;
        // the user turn it became (`[message from X] …`) is skipped. Turns the
        // platform itself typed in (from 'orchestration', 'vistaclair': pause
        // instructions, pending-event pings) have no card, so they show as a
        // notice instead of disappearing.
        if (/^\[message from /i.test(text)) return;
        // A worker's brief, submitted on its orchestrator's behalf.
        if (u.from !== 'orchestration' && u.from !== 'vistaclair') {
          return this.applyPeerMessage({ from: u.from, to: [...this.aliases][0], text });
        }
        const n = this.notice(`${u.from}: ${clip(text, 400)}`, 'injected');
        n.title = text;
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
    // session: "orch → w2: …" in the sender's area, "from orch: …" in the other.
    applyPeerMessage(p) {
      const text = String(p.text || '');
      // Sent by this agent, or (neither end recognised) shown as `a → b`.
      const outgoing = this.isMe(p.from) || !this.isMe(p.to);
      const card = el('div', `sdk-peer ${outgoing ? 'out' : 'in'}`);
      const from = shortName(p.from, this.panel.run);
      const to = shortName(p.to, this.panel.run);
      card.appendChild(el('div', 'sdk-peer-head', outgoing ? `${from} → ${to}` : `from ${from}`));
      card.appendChild(el('div', 'sdk-peer-text', text));
      this.feed.appendChild(card);
    }

    notice(text, level) {
      return this.feed.appendChild(el('div', `sdk-notice${level ? ` sdk-notice-${level}` : ''}`, String(text || '')));
    }
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
      this.targetSess = null;
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
          <div class="sdk-areas">
            <div class="sdk-main-slot"></div>
            <div class="sdk-workers"></div>
          </div>
          <vc-composer></vc-composer>
        </div>`;
      const q = (s) => wrap.querySelector(s);
      this.panelEl = q('.sdk-panel');
      this.titleEl = q('.sdk-toolbar-title');
      this.metaEl = q('.sdk-toolbar-meta');
      this.costEl = q('.sdk-toolbar-cost');
      this.mainSlot = q('.sdk-main-slot');
      this.workersEl = q('.sdk-workers');
      this.interruptBtn = q('[data-act="interrupt"]');
      this.pauseBtn = q('[data-act="pause"]');
      this.boardBtn = q('[data-act="board"]');
      this.composer = q('vc-composer');

      this.interruptBtn.addEventListener('click', () => this.interrupt());
      this.pauseBtn.addEventListener('click', () => this.pause());
      this.boardBtn.addEventListener('click', () => { if (this.runId) window.cliModule?.openRunBoard?.(this.runId); });
      this.composer.addEventListener('send', (e) => this.send(e.detail));
      this.composer.addEventListener('interrupt', () => this.interrupt());
      this.composer.addEventListener('target-clear', () => this.setTarget(null));
      // Images dropped anywhere on the panel go to the composer.
      customElements.whenDefined('vc-composer').then(() => this.composer.attachDropTarget?.(this.panelEl));
    }

    areaCount() { return (this.main ? 1 : 0) + this.workers.size; }
    allAreas() { return [this.main, ...this.workers.values()].filter(Boolean); }

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
      }
      if (this.main && info.state) this.main.setState(info.state);
      if (this.main && typeof info.costUsd === 'number') this.main.setCost(info.costUsd);
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
        a.lastReport = w.lastReport || null;
        const c = costOf(w.cost ?? w.costUsd);
        if (c != null) a.cost = c;
        const derived = w.state
          || (w.running ? (w.live?.pausing ? 'pausing' : w.live?.busy ? 'busy' : null) : w.paused ? 'paused' : 'exited');
        if (derived && (w.state || !a.gotStatus || derived === 'exited' || derived === 'paused')) a.setState(derived);
        a.workerId = w.id;
        a.renderHeader();
      }
      this.sortWorkers();
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
      this.panelEl.classList.add('has-workers');
      a.requestHistory();
      a.requestTodo();
      for (const x of this.allAreas()) x.renderHeader();
      return a;
    }

    sortWorkers() {
      const n = (a) => parseInt(String(a.workerId || '').replace(/\D/g, ''), 10) || 1e9;
      [...this.workers.values()].sort((a, b) => n(a) - n(b)).forEach(a => this.workersEl.appendChild(a.el));
    }

    target() { return (this.targetSess && areas.get(this.targetSess)) || this.main; }

    setTarget(sessId) {
      this.targetSess = sessId && this.main && sessId !== this.main.sessId ? sessId : null;
      const t = this.target();
      this.composer.setTarget?.(this.targetSess && t ? t.label : null);
      for (const a of this.allAreas()) a.renderHeader();
      this.renderToolbar();
      this.composer.focus();
    }

    send({ text, images }) {
      const t = this.target();
      if (!t) return;
      sendWs({ type: 'sdk:send', sessId: t.sessId, text, images: images || [] });
    }

    interrupt() {
      const t = this.target();
      if (t) sendWs({ type: 'sdk:interrupt', sessId: t.sessId });
    }

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
      const t = this.target();
      this.interruptBtn.title = `Interrupt ${t ? t.label : 'the session'} (Esc in the composer)`;
      this.interruptBtn.disabled = !t || ENDED.has(t.state);
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
      // An ended, folded worker's TODO no longer moves.
      for (const a of this.allAreas()) if (!(a.collapsed && ENDED.has(a.state))) a.requestTodo();
    }

    setActive(v) {
      this.active = !!v;
      clearInterval(this._poll);
      this._poll = null;
      if (this.active) {
        this._poll = setInterval(() => this.pollTodos(), POLL_MS);
        this.pollTodos();
        if (!D.isPhone?.()) setTimeout(() => this.composer.focus(), 50);
      }
    }

    destroy() {
      clearInterval(this._poll);
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
        // may come without a known session: show it where the owner typed.
        const a = areas.get(msg.sessId) || adopt(msg)
          || (!areas.has(msg.sessId) && msg.ev?.platform?.kind === 'notice' ? activePanel()?.target() : null);
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
