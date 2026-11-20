/* CLI-session Mini App — the phone surface for continuing orchestrator runs.

   Stateless by construction, like public/vista/: Telegram kills backgrounded
   webviews, so the server is the source of truth and the only client state is
   which run is open, its transcript cursor, and the owner's unsent draft
   (kept in localStorage so a killed webview never loses typed text).

   Two modes, picked on boot:
   - runs: GET api/runs → a picker of orchestrator runs, above it the remote
     sessions' questions no run holds (answered over api/remote/answer); a
     run view polls GET api/run/:id?since=<cursor> and appends only.
   - legacy: an older backend without api/runs (404) → the single bound
     session over api/state | send | answer | esc | end, as before.

   Auth and the bearer live in /pro/tg-common/miniapp.js. Markdown: marked +
   DOMPurify (auth-exempt exact paths) when both globals loaded, else the
   escape-first renderer below. */
(function () {
  'use strict';

  var TICK_MS = 1000;
  var RUN_POLL_MS = 2000;
  var PICKER_POLL_MS = 4000;
  var LEGACY_POLL_MS = 2500;
  var TERMINAL = { done: 1, ended: 1, finished: 1, closed: 1, failed: 1, stopped: 1, cancelled: 1, archived: 1 };

  var el = function (id) { return document.getElementById(id); };
  var titleEl = el('title');
  var titleBtn = el('title-btn');
  var caretEl = el('title-caret');
  var statusPill = el('status-pill');
  var backBtn = el('back-btn');
  var runActions = el('run-actions');
  var pauseBtn = el('pause-btn');
  var escBtn = el('esc-btn');
  var moreBtn = el('more-btn');
  var bannerEl = el('banner');
  var pickerEl = el('picker');
  var pickerRuns = el('picker-runs');
  var remoteEl = el('remote-list');
  var runEl = el('run');
  var workersEl = el('workers');
  var workersSummary = el('workers-summary');
  var workersList = el('workers-list');
  var convEl = el('conversation');
  var newPill = el('new-pill');
  var questionArea = el('question-area');
  var sendNote = el('send-note');
  var msgInput = el('msg-input');
  var sendBtn = el('send-btn');
  var sheetEl = el('sheet');
  var sheetBody = el('sheet-body');
  var overlay = el('overlay');

  var app = window.VcMiniApp.create({
    base: 'api',
    // Unchanged from the pre-tg-common client so an open webview keeps its
    // token; distinct from Vista's (headers and storage are origin-global).
    storageKey: 'vcTgToken',
    header: 'X-TG-Session',
    onStatus: function (cls, text) { if (cls === 'error') showBanner(text, 'net'); },
  });
  var tg = app.tg;
  var hasTgBack = !!(tg && tg.BackButton && tg.isVersionAtLeast && tg.isVersionAtLeast('6.1'));

  var mode = null;        // 'runs' | 'legacy', decided by the first fetch
  var view = 'picker';    // 'picker' | 'run'
  var runs = [];
  var runsLoaded = false;
  var pickerSig = '';
  var remoteGroups = [];  // GET runs `remote`: the asks no run holds, peer → session
  var remoteLayout = null;
  var remoteCards = new Map();          // peer + session tab → { el, stateEl }
  var remoteAnswered = Object.create(null);
  var remoteSeen = Object.create(null);
  var cur = null;        // the open run (or the legacy session), see newCurrent()
  var inflight = false;
  var again = false;      // a refresh was asked for while a fetch was in flight
  var lastFetch = 0;
  var failCount = 0;
  var retryAt = 0;
  var bannerKind = null;
  var toastTimer = null;
  var sheetKind = null;

  var params = new URLSearchParams(location.search);
  var deepRun = params.get('run');

  // --- small helpers -----------------------------------------------------------

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toMs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    var n = Date.parse(v);
    return isNaN(n) ? null : n;
  }

  function clock(ms) {
    return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  }

  function relTime(v) {
    var ms = toMs(v);
    if (!ms) return '';
    var d = Date.now() - ms;
    if (d < 60000) return 'just now';
    if (d < 3600000) return Math.round(d / 60000) + ' min ago';
    if (d < 86400000) return clock(ms);
    return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  function oneLine(s, max) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function store(key, val) {
    try { if (val) localStorage.setItem(key, val); else localStorage.removeItem(key); } catch (e) { /* private mode */ }
  }
  function load(key) {
    try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
  }

  function impact() {
    try { tg && tg.HapticFeedback && tg.HapticFeedback.impactOccurred('light'); } catch (e) { /* optional */ }
  }
  function tick0() {
    try { tg && tg.HapticFeedback && tg.HapticFeedback.selectionChanged(); } catch (e) { /* optional */ }
  }

  function isNotFound(e) { return /\b404\b|not found|unknown run/i.test(e && e.message || ''); }

  function pendingCount(r) {
    var p = r && r.pendingQuestions;
    return Array.isArray(p) ? p.length : (Number(p) || 0);
  }

  function runChip(r) {
    if (!r) return { cls: '', text: 'connecting…' };
    if (r.paused) return { cls: 'paused', text: '⏸ paused' };
    if (r.pausing) return { cls: 'pausing', text: 'pausing…' };
    if (pendingCount(r) > 0) return { cls: 'waiting', text: 'waiting for you' };
    if (r.busy) return { cls: 'working', text: 'working' };
    if (r.state && TERMINAL[r.state]) return { cls: 'ended', text: r.state };
    return { cls: 'idle', text: 'idle' };
  }

  function runTitle(r) { return (r && (r.title || r.name || r.runId)) || 'Run'; }
  function isEnded(r) { return !!(r && r.state && TERMINAL[r.state]); }

  function setStatus(cls, text) {
    statusPill.className = 'pill ' + (cls || '');
    statusPill.textContent = text;
  }

  // --- banner: network trouble (sticky) and action results (toast) ------------

  function showBanner(text, kind) {
    bannerKind = kind;
    bannerEl.textContent = text;
    bannerEl.hidden = false;
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  }
  function hideBanner(kind) {
    if (kind && bannerKind !== kind) return;
    bannerEl.hidden = true;
    bannerKind = null;
  }
  function toast(text) {
    if (bannerKind === 'net') return; // the connection problem is the more important line
    showBanner(text, 'toast');
    toastTimer = setTimeout(function () { hideBanner('toast'); }, 2600);
  }

  // --- markdown ------------------------------------------------------------------

  function renderMarkdown(src) {
    src = String(src == null ? '' : src);
    if (window.marked && window.DOMPurify && window.DOMPurify.sanitize) {
      try { return window.DOMPurify.sanitize(window.marked.parse(src)); } catch (e) { /* fall through */ }
    }
    return mdBlocks(src.replace(/\r\n?/g, '\n').split('\n'));
  }

  // Inline spans over ALREADY-ESCAPED text, so nothing the model wrote can
  // become markup: every tag below is ours. Code spans and links are parked in
  // placeholders first so emphasis rules never reach inside them.
  function mdInline(raw) {
    var parked = [];
    var park = function (html) { parked.push(html); return '\u0000' + (parked.length - 1) + '\u0000'; };
    var s = esc(raw);
    s = s.replace(/`([^`]+)`/g, function (_, c) { return park('<code>' + c + '</code>'); });
    s = s.replace(/\[([^\]]+)\]\(((?:https?:|mailto:|\/|#)[^)\s]*)\)/g, function (_, t, u) {
      return park('<a href="' + u + '" target="_blank" rel="noopener">' + t + '</a>');
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]*[^\s<.,;:!?)\]'"])/g, function (_, pre, u) {
      return pre + park('<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>');
    });
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
      .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>');
    return s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return parked[+i]; });
  }

  var RX_FENCE = /^\s*(```|~~~)/;
  var RX_LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  var RX_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function mdBlocks(lines) {
    var out = [];
    var para = [];
    var flush = function () { if (para.length) { out.push('<p>' + para.map(mdInline).join('<br>') + '</p>'); para = []; } };
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var m;
      if (RX_FENCE.test(line)) {
        flush();
        var fence = line.trim().slice(0, 3);
        var code = [];
        i++;
        while (i < lines.length && lines[i].trim().slice(0, 3) !== fence) code.push(lines[i++]);
        i++; // the closing fence (or the end)
        out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
        continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
        flush();
        var lv = Math.min(4, m[1].length);
        out.push('<h' + lv + '>' + mdInline(m[2]) + '</h' + lv + '>');
        i++; continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(line)) {
        flush();
        var quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push('<blockquote>' + mdBlocks(quote) + '</blockquote>');
        continue;
      }
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && RX_TABLE_SEP.test(lines[i + 1])) {
        flush();
        var cells = function (l) { return l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return mdInline(c.trim()); }); };
        var head = cells(line);
        var rows = [];
        i += 2;
        while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim()) rows.push(cells(lines[i++]));
        out.push('<table><thead><tr>' + head.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr></thead><tbody>'
          + rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('')
          + '</tbody></table>');
        continue;
      }
      if ((m = RX_LIST.exec(line))) {
        flush();
        var base = m[1].length;
        var ordered = /\d/.test(m[2]);
        var items = [];
        while (i < lines.length) {
          var l = lines[i];
          var lm = RX_LIST.exec(l);
          if (lm && lm[1].length <= base + 1) { items.push({ first: lm[3], sub: [] }); i++; continue; }
          // Deeper-indented lines (a nested list, a continuation) belong to the item.
          if (items.length && l.trim() && /^\s+/.test(l) && (l.match(/^\s*/)[0].length > base)) { items[items.length - 1].sub.push(l.slice(base + 2)); i++; continue; }
          break;
        }
        var tag = ordered ? 'ol' : 'ul';
        out.push('<' + tag + '>' + items.map(function (it) {
          var first = it.first.replace(/^\[( |x|X)\]\s+/, function (_, c) { return c === ' ' ? '☐ ' : '☑ '; });
          return '<li>' + mdInline(first) + (it.sub.length ? mdBlocks(it.sub) : '') + '</li>';
        }).join('') + '</' + tag + '>');
        continue;
      }
      para.push(line);
      i++;
    }
    flush();
    return out.join('');
  }

  // --- the open run ------------------------------------------------------------

  function newCurrent(runId) {
    return {
      runId: runId,               // null in legacy mode
      cursor: null,
      snap: null,
      first: true,
      entries: [],                // timeline, ordered by time: { key, t, sig, node }
      byKey: {},
      pending: [],                // optimistic user bubbles: { text, node }
      askSig: null,
      seenAsks: {},
      answered: {},               // askIds answered here, hidden until the server drops them
      bindTried: false,
      sending: false,
      newCount: 0,
      legacyKey: '',
      legacyUsers: 0,
      workersSig: '',
      workerNames: {},
      draftKey: 'vcTgDraft:' + (runId || 'legacy'),
    };
  }

  function resetConversation() {
    convEl.innerHTML = '<div class="empty" id="conv-empty">Loading…</div><div id="conv-tail"></div>';
    cur.entries = [];
    cur.byKey = {};
    for (var i = 0; i < cur.pending.length; i++) el('conv-tail').appendChild(cur.pending[i].node);
    newPill.hidden = true;
    cur.newCount = 0;
  }

  function atBottom() { return convEl.scrollHeight - convEl.scrollTop - convEl.clientHeight < 60; }
  function toBottom() { convEl.scrollTop = convEl.scrollHeight; newPill.hidden = true; if (cur) cur.newCount = 0; }

  // Insert or update one timeline entry; returns true when it is new. Entries
  // keep time order so an event that lands between two messages shows there.
  function upsert(key, t, sig, build) {
    var c = cur;
    var ex = c.byKey[key];
    if (ex) {
      if (ex.sig !== sig) {
        var node = build();
        if (ex.node.open) node.open = true; // a tools row the owner expanded stays expanded
        ex.node.replaceWith(node);
        ex.node = node;
        ex.sig = sig;
      }
      return false;
    }
    if (t == null) t = c.entries.length ? c.entries[c.entries.length - 1].t : 0;
    var entry = { key: key, t: t, sig: sig, node: build() };
    var at = c.entries.length;
    while (at > 0 && c.entries[at - 1].t > t) at--;
    var before = at < c.entries.length ? c.entries[at].node : el('conv-tail');
    convEl.insertBefore(entry.node, before);
    c.entries.splice(at, 0, entry);
    c.byKey[key] = entry;
    return true;
  }

  function stamp(node, ms) {
    if (!ms) return;
    var ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = clock(ms);
    node.appendChild(ts);
  }

  function buildMessage(m, ms) {
    var role = m.role;
    if (role === 'tools') {
      var n = Number(m.toolCount) || 1;
      var label = '🔧 ' + n + ' tool' + (n === 1 ? '' : 's');
      if (!m.text) {
        var plain = document.createElement('div');
        plain.className = 'tools';
        plain.textContent = label;
        return plain;
      }
      var d = document.createElement('details');
      d.className = 'tools';
      var s = document.createElement('summary');
      s.textContent = label + ' ▸';
      var pre = document.createElement('pre');
      pre.textContent = m.text;
      d.appendChild(s);
      d.appendChild(pre);
      return d;
    }
    var b = document.createElement('div');
    if (role === 'user') {
      b.className = 'bubble user';
      b.textContent = m.text || '';
    } else {
      b.className = 'bubble assistant';
      var md = document.createElement('div');
      md.className = 'md';
      md.innerHTML = renderMarkdown(m.text || '');
      b.appendChild(md);
    }
    stamp(b, ms);
    return b;
  }

  var EVENT_LOOK = {
    landed: { icon: '✅', cls: 'good' },
    report: { icon: '📝', cls: '' },
    started: { icon: '▶', cls: '' },
    paused: { icon: '⏸', cls: '' },
    resumed: { icon: '▶', cls: '' },
    failed: { icon: '❌', cls: 'bad' },
    blocked: { icon: '✋', cls: 'bad' },
  };

  function eventLook(kind) {
    var k = String(kind || '').toLowerCase().replace(/[\s_]+/g, '-');
    if (/^(not-landed|notlanded|land(ing)?-failed|landing-blocked)$/.test(k)) return { icon: '⚠️', cls: 'bad' };
    return EVENT_LOOK[k] || { icon: '•', cls: '' };
  }

  function buildEvent(ev) {
    var look = eventLook(ev.kind);
    var line = document.createElement('div');
    line.className = 'sysline ' + look.cls;
    var span = document.createElement('span');
    var who = ev.worker ? (cur.workerNames[ev.worker] || ev.worker) : '';
    var text = (who ? who + ' — ' : '') + (ev.text || ev.kind || '');
    span.textContent = look.icon + ' ' + oneLine(text, 220);
    span.title = text;
    line.appendChild(span);
    return line;
  }

  function messageKey(m) {
    return m.id != null ? 't:' + m.id : 't:' + m.role + ':' + (m.ts || '') + ':' + String(m.text || '').slice(0, 40);
  }

  function addPending(text, label) {
    var b = document.createElement('div');
    b.className = 'bubble user pending';
    b.textContent = text;
    var ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = label;
    b.appendChild(ts);
    var p = { text: text, node: b, label: ts };
    cur.pending.push(p);
    el('conv-tail').appendChild(b);
    syncEmpty();
    return p;
  }

  function dropPending(p) {
    var i = cur.pending.indexOf(p);
    if (i >= 0) cur.pending.splice(i, 1);
    p.node.remove();
    syncEmpty();
  }

  // A user message the server now holds retires its optimistic bubble: the one
  // with the same text, else the oldest (the server may have reshaped it).
  function settlePending(text) {
    if (!cur.pending.length) return;
    var t = String(text || '').trim();
    var hit = cur.pending.find(function (p) { return p.text === t; }) || cur.pending[0];
    dropPending(hit);
  }

  function syncEmpty() {
    var empty = el('conv-empty');
    if (!empty) return;
    empty.textContent = 'No conversation yet.';
    empty.hidden = cur.entries.length > 0 || cur.pending.length > 0;
  }

  // --- run view rendering ------------------------------------------------------

  var WORKER_ICON = [
    [/^(working|running|started|busy|doing|active)$/, '🔄'],
    [/^(done|landed|finished|complete|completed|merged)$/, '✅'],
    [/^(failed|error|not-landed|crashed)$/, '❌'],
    [/^(blocked|waiting|question|asking)$/, '✋'],
    [/^(paused|pausing)$/, '⏸'],
    [/^(idle|queued|pending|starting)$/, '⏳'],
  ];
  function workerIcon(state) {
    var s = String(state || '').toLowerCase();
    for (var i = 0; i < WORKER_ICON.length; i++) if (WORKER_ICON[i][0].test(s)) return WORKER_ICON[i][1];
    return '•';
  }

  function reportLine(r) {
    if (!r) return '';
    if (typeof r === 'string') return r;
    var s = r.summary || r.text || r.message || '';
    return (r.status ? r.status + (s ? ': ' : '') : '') + s;
  }

  // progress may be a fraction, a percentage, "3/5", or { done, total } / { pct }.
  function progressOf(p) {
    if (p == null || p === '') return null;
    if (typeof p === 'number') return { pct: p <= 1 ? p * 100 : p, label: Math.round(p <= 1 ? p * 100 : p) + '%' };
    if (typeof p === 'string') {
      var m = /^(\d+)\s*\/\s*(\d+)/.exec(p);
      return { pct: m && +m[2] ? (100 * m[1]) / m[2] : null, label: p };
    }
    if (typeof p === 'object') {
      var pct = p.pct != null ? p.pct : p.percent;
      if (pct == null && p.total) pct = (100 * (p.done || 0)) / p.total;
      var label = p.label || (p.total ? (p.done || 0) + '/' + p.total : pct != null ? Math.round(pct) + '%' : '');
      return { pct: pct, label: label };
    }
    return null;
  }

  function renderWorkers(list) {
    list = list || [];
    var c = cur;
    c.workerNames = {};
    list.forEach(function (w) { if (w.workerId) c.workerNames[w.workerId] = w.title || w.workerId; });
    var sig = JSON.stringify(list);
    if (sig === c.workersSig) return;
    c.workersSig = sig;
    workersEl.hidden = !list.length;
    if (!list.length) return;
    var counts = {};
    list.forEach(function (w) { var s = w.state || 'unknown'; counts[s] = (counts[s] || 0) + 1; });
    workersSummary.textContent = '👷 ' + list.length + ' worker' + (list.length === 1 ? '' : 's') + ' · '
      + Object.keys(counts).map(function (k) { return counts[k] + ' ' + k; }).join(' · ');
    workersList.innerHTML = list.map(function (w) {
      var pr = progressOf(w.progress);
      var rep = reportLine(w.lastReport);
      return '<div class="worker">'
        + '<div class="w-icon">' + workerIcon(w.state) + '</div>'
        + '<div class="w-body"><div class="w-title">' + esc(w.title || w.workerId) + '</div>'
        + (rep ? '<div class="w-report" title="' + esc(rep) + '">' + esc(oneLine(rep, 160)) + '</div>' : '')
        + (pr && pr.pct != null ? '<div class="bar"><i style="width:' + Math.max(0, Math.min(100, pr.pct)).toFixed(0) + '%"></i></div>' : '')
        + '</div>'
        + '<div class="w-state">' + esc(w.state || '') + (pr && pr.label ? '<br>' + esc(pr.label) : '') + '</div>'
        + '</div>';
    }).join('');
  }

  function renderHeader() {
    var runsMode = mode === 'runs';
    if (view === 'picker') {
      titleEl.textContent = 'Orchestrator runs';
      caretEl.hidden = true;
      backBtn.hidden = true;
      runActions.hidden = true;
      var waiting = runs.filter(function (r) { return pendingCount(r) > 0; }).length
        + remotePending().reduce(function (n, g) { return n + g.sessions.length; }, 0);
      if (!runsLoaded) setStatus('', 'connecting…');
      else if (waiting) setStatus('waiting', waiting + ' need' + (waiting === 1 ? 's' : '') + ' you');
      else setStatus('idle', runs.length + ' run' + (runs.length === 1 ? '' : 's'));
      syncChrome();
      return;
    }
    var s = cur && cur.snap;
    backBtn.hidden = !runsMode || hasTgBack;
    caretEl.hidden = !runsMode;
    runActions.hidden = false;
    if (runsMode) {
      titleEl.textContent = s ? runTitle(s) : runTitle(runs.find(function (r) { return r.runId === cur.runId; }) || { runId: cur.runId });
      var chip = runChip(s);
      setStatus(chip.cls, chip.text);
      pauseBtn.hidden = false;
      pauseBtn.disabled = !s || !!s.pausing || isEnded(s);
      pauseBtn.textContent = s && s.paused ? '▶ Resume' : s && s.pausing ? '⏳ Pausing' : '⏸ Pause';
      escBtn.disabled = !s || isEnded(s);
    } else {
      pauseBtn.hidden = true;
      escBtn.disabled = !(s && s.bound && s.cliStatus === 'running');
    }
    syncChrome();
  }

  function renderInput() {
    var c = cur;
    if (!c) return;
    var s = c.snap;
    var disabled = false;
    var note = '';
    var label = 'Send';
    if (mode === 'legacy') {
      var running = s && s.bound && s.cliStatus === 'running';
      disabled = !running;
      if (s && !running) note = s.bound ? 'The session is not running.' : '';
      else if (s && s.busy) { label = 'Queue'; note = 'Claude is working — your message is queued for its next turn.'; }
    } else if (!s) {
      disabled = true;
    } else if (s.paused) {
      disabled = true;
      note = '⏸ This run is paused — resume it to send messages.';
    } else if (s.pausing) {
      disabled = true;
      note = '⏳ Pausing — sending is off until the run has paused.';
    } else if (isEnded(s)) {
      disabled = true;
      note = 'This run has ended.';
    } else if (s.busy) {
      label = 'Queue';
      note = 'The orchestrator is working — your message is queued for its next turn.';
    }
    msgInput.disabled = disabled;
    sendBtn.disabled = disabled || c.sending || !msgInput.value.trim();
    sendBtn.textContent = c.sending ? '…' : label;
    sendNote.textContent = note;
    sendNote.hidden = !note;
  }

  // A remote session's question is answered naming its tab, as core requires
  // of the dashboard (and the server of the Mini App).
  function answerBody(p, answer) {
    var body = { askId: p.askId, answer: answer };
    if (p.remote && typeof p.remote.tabId === 'string') body.tabId = p.remote.tabId;
    return body;
  }

  function renderQuestions(pending, answerPath) {
    var c = cur;
    pending = (pending || []).filter(function (p) { return !c.answered[p.askId]; });
    var sig = pending.map(function (p) { return p.askId; }).join(',');
    var fresh = pending.some(function (p) { return !c.seenAsks[p.askId]; });
    pending.forEach(function (p) { c.seenAsks[p.askId] = true; });
    if (fresh && c.askSig !== null) app.haptic('warning');
    if (sig === c.askSig) return; // unchanged: keep whatever the owner has half-filled
    c.askSig = sig;
    questionArea.innerHTML = '';
    questionArea.hidden = pending.length === 0;
    if (!pending.length) return;
    // One question card at a time; the next appears when this one is answered.
    questionArea.appendChild(buildForm(pending[0], pending.length, function (answer) {
      return app.api(answerPath, { method: 'POST', body: answerBody(pending[0], answer) });
    }, function () {
      c.answered[pending[0].askId] = true;
      c.askSig = '';          // rebuild from the next poll
      questionArea.hidden = true;
    }));
  }

  function applyRun(d) {
    var c = cur;
    var stick = c.first || atBottom();
    var added = 0;
    if (d.reset || c.first) resetConversation();
    c.first = false;
    c.snap = d;
    if (d.cursor !== undefined) c.cursor = d.cursor;
    // Keep the picker's copy fresh so switching back shows the same state.
    var listed = runs.find(function (r) { return r.runId === c.runId; });
    if (listed) {
      ['title', 'name', 'engine', 'state', 'busy', 'paused', 'pausing', 'bound'].forEach(function (k) { if (k in d) listed[k] = d[k]; });
      listed.pendingQuestions = pendingCount(d);
      if (d.workers) listed.workerCount = d.workers.length;
    }
    renderWorkers(d.workers);
    (d.transcript || []).forEach(function (m) {
      var ms = toMs(m.ts);
      var isNew = upsert(messageKey(m), ms, m.role + '|' + (m.text || '') + '|' + (m.toolCount || ''), function () { return buildMessage(m, ms); });
      if (isNew) { added++; if (m.role === 'user') settlePending(m.text); }
    });
    (d.events || []).forEach(function (ev) {
      var key = 'e:' + (ev.seq != null ? ev.seq : (ev.at || '') + ':' + (ev.kind || '') + ':' + (ev.text || ''));
      if (upsert(key, toMs(ev.at), ev.kind + '|' + (ev.text || ''), function () { return buildEvent(ev); })) added++;
    });
    syncEmpty();
    renderHeader();
    renderQuestions(d.pendingQuestions, 'run/' + encodeURIComponent(c.runId) + '/answer');
    renderInput();
    afterAppend(stick, added);
    if (!d.bound && !c.bindTried && !isEnded(d)) {
      c.bindTried = true;
      post('bind').catch(function (e) { toast('Could not connect this chat: ' + e.message); });
    }
  }

  function afterAppend(stick, added) {
    if (stick) { toBottom(); return; }
    if (added > 0) {
      cur.newCount += added;
      newPill.textContent = cur.newCount + ' new ↓';
      newPill.hidden = false;
    }
  }

  // --- legacy single session ---------------------------------------------------

  function applyLegacy(s) {
    var c = cur;
    c.snap = s;
    if (!s.bound) {
      titleEl.textContent = 'Vistaclair Session';
      setStatus('exited', 'no session');
      convEl.innerHTML = '<div class="empty">No session is bound to this chat.<br>Start one from the bot menu.</div>';
      c.legacyKey = '';
      c.first = true;
      questionArea.hidden = true;
      c.askSig = null;
      renderHeader();
      renderInput();
      return;
    }
    titleEl.textContent = s.target && s.target.type === 'app' ? 'App: ' + s.target.name : 'vistaclair-pro CLI';
    renderHeader();
    if (s.cliStatus === 'exited') setStatus('exited', 'exited');
    else if (s.cliStatus !== 'running') setStatus('exited', 'not running');
    else if (s.busy) setStatus('busy', 'Claude is working…');
    else setStatus('ready', 'waiting for you');
    var items = s.transcript || [];
    var last = items[items.length - 1];
    var key = items.length + ':' + (last ? last.ts + ':' + (last.text || '').length : '');
    if (key !== c.legacyKey) {
      // The legacy state carries the whole transcript and no ids: re-render it.
      var stick = c.first || atBottom();
      var before = c.entries.length;
      c.legacyKey = key;
      c.first = false;
      resetConversation();
      var users = 0;
      items.forEach(function (m, i) {
        var ms = toMs(m.ts);
        if (m.role === 'user') users++;
        upsert('l:' + i, ms, '', function () { return buildMessage(m, ms); });
      });
      for (; c.legacyUsers < users; c.legacyUsers++) if (c.pending.length) dropPending(c.pending[0]);
      c.legacyUsers = users;
      syncEmpty();
      afterAppend(stick, Math.max(0, items.length - before));
    }
    renderQuestions(s.pendingQuestions, 'answer');
    renderInput();
  }

  // --- question form (the same field set as the dashboard's ask form) --------

  // Only inline images: any other src is a master path the webview can't load.
  var DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+\/]+={0,2}$/;

  function plainCap(s, n) {
    return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, n);
  }

  // A relayed ask's text was escaped for core's markdown renderer (mdText);
  // shown here with textContent, so undo it.
  function unMd(s) {
    if (s == null) return s;
    return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#58;/g, ':').replace(/&#46;/g, '.').replace(/&amp;/g, '&')
      .replace(/\\([\\[\]`])/g, '$1');
  }

  function imageNode(src, caption) {
    if (typeof src !== 'string' || !DATA_IMAGE.test(src)) return null;
    var fig = document.createElement('figure');
    fig.className = 'q-image';
    var img = document.createElement('img');
    img.alt = '';
    img.src = src;
    fig.appendChild(img);
    if (caption) {
      var cap = document.createElement('figcaption');
      cap.textContent = caption;
      fig.appendChild(cap);
    }
    return fig;
  }

  // submitAnswer(answer) → Promise; answered() after it succeeded.
  function buildForm(p, total, submitAnswer, answered) {
    var wrap = document.createElement('div');
    var fd = p.formData || {};
    var questions = p.questions || [];
    // answers[qid] = current value
    var answers = {};
    var remote = p.remote && typeof p.remote === 'object' ? p.remote : null;
    var shown = remote ? unMd : function (s) { return s; };

    if (remote) {
      wrap.className = 'q-remote';
      var rl = document.createElement('div');
      rl.className = 'q-remote-label';
      rl.textContent = ['Remote', plainCap(remote.host, 100), plainCap(remote.session, 120)].filter(Boolean).join(' · ');
      wrap.appendChild(rl);
    }

    var h = document.createElement('h3');
    h.textContent = shown(fd.title) || 'A question for you';
    if (total > 1) {
      var cnt = document.createElement('span');
      cnt.className = 'q-count';
      cnt.textContent = '1 of ' + total;
      h.appendChild(cnt);
    }
    wrap.appendChild(h);
    if (fd.description) {
      var d = document.createElement('div');
      d.className = 'q-desc';
      d.textContent = shown(fd.description);
      wrap.appendChild(d);
    }

    var blocks = [];
    // An option's face: its image (data: only), label, description; the
    // answer stays o.label as sent.
    function optionFace(b, o) {
      var img = imageNode(typeof o.image === 'string' ? o.image : o.image && o.image.src);
      if (img) b.appendChild(img);
      var t = document.createElement('span');
      t.textContent = shown(o.label);
      b.appendChild(t);
      if (o.description) {
        var od = document.createElement('small');
        od.className = 'q-opt-desc';
        od.textContent = shown(o.description);
        b.appendChild(od);
      }
    }

    function optionButtons(block, opts, pick) {
      var box = document.createElement('div');
      box.className = 'q-options';
      opts.forEach(function (o) {
        var b = document.createElement('button');
        b.type = 'button';
        optionFace(b, o);
        b.onclick = function () {
          pick(o);
          box.querySelectorAll('button').forEach(function (x) { x.classList.toggle('selected', x === b); });
          tick0();
          refreshVisibility();
        };
        box.appendChild(b);
      });
      block.appendChild(box);
    }

    questions.forEach(function (q) {
      var block = document.createElement('div');
      block.className = 'q-block';
      block.dataset.qid = q.id;
      var label = document.createElement('div');
      label.className = 'q-label';
      label.textContent = shown(q.question) || q.id;
      block.appendChild(label);
      (Array.isArray(q.images) ? q.images : []).forEach(function (im) {
        var fig = im && imageNode(im.src, im.caption ? shown(String(im.caption)) : '');
        if (fig) block.appendChild(fig);
      });
      if (q.defaultValue !== undefined) answers[q.id] = q.defaultValue;

      var type = q.type || 'text';
      var inp;
      if (type === 'select' || type === 'confirm' || (type === 'dropdown' && (q.options || []).length <= 8)) {
        var opts = type === 'confirm' ? [{ label: 'Yes' }, { label: 'No' }] : (q.options || []);
        optionButtons(block, opts, function (o) { answers[q.id] = type === 'confirm' ? (o.label === 'Yes') : o.label; });
      } else if (type === 'toggle') {
        optionButtons(block, [{ label: 'Yes', v: true }, { label: 'No', v: false }], function (o) { answers[q.id] = o.v; });
      } else if (type === 'multiselect') {
        var box = document.createElement('div');
        box.className = 'q-options';
        answers[q.id] = Array.isArray(answers[q.id]) ? answers[q.id] : [];
        (q.options || []).forEach(function (o) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'q-check';
          optionFace(b, o);
          b.onclick = function () {
            var arr = answers[q.id];
            var i = arr.indexOf(o.label);
            if (i >= 0) arr.splice(i, 1); else arr.push(o.label);
            b.classList.toggle('selected', i < 0);
            tick0();
            refreshVisibility();
          };
          box.appendChild(b);
        });
        block.appendChild(box);
      } else if (type === 'dropdown') {
        var sel = document.createElement('select');
        sel.innerHTML = '<option value="" disabled selected>Choose…</option>';
        (q.options || []).forEach(function (o) {
          var opt = document.createElement('option');
          opt.value = o.label;
          opt.textContent = shown(o.label);
          sel.appendChild(opt);
        });
        sel.onchange = function () { answers[q.id] = sel.value; refreshVisibility(); };
        block.appendChild(sel);
      } else if (type === 'number') {
        inp = document.createElement('input');
        inp.type = 'number';
        if (q.min != null) inp.min = q.min;
        if (q.max != null) inp.max = q.max;
        if (q.step != null) inp.step = q.step;
        if (q.placeholder) inp.placeholder = q.placeholder;
        inp.oninput = function () { answers[q.id] = inp.value === '' ? undefined : Number(inp.value); };
        block.appendChild(inp);
      } else if (type === 'textarea') {
        inp = document.createElement('textarea');
        inp.rows = 3;
        if (q.placeholder) inp.placeholder = q.placeholder;
        inp.oninput = function () { answers[q.id] = inp.value; };
        block.appendChild(inp);
      } else if (type === 'file') {
        var note = document.createElement('div');
        note.className = 'q-unsupported';
        note.textContent = 'File upload is not available in Telegram — answer will be sent as "not available".';
        answers[q.id] = 'file upload not available via Telegram';
        block.appendChild(note);
      } else { // text
        inp = document.createElement('input');
        inp.type = 'text';
        if (q.placeholder) inp.placeholder = q.placeholder;
        inp.oninput = function () { answers[q.id] = inp.value; };
        block.appendChild(inp);
      }
      blocks.push({ q: q, block: block });
      wrap.appendChild(block);
    });

    // Minimal showIf support: equals / notEquals / includes on earlier answers.
    function refreshVisibility() {
      blocks.forEach(function (x) {
        var c = x.q.showIf;
        if (!c) return;
        var v = answers[c.questionId];
        var show = true;
        if ('equals' in c) show = v === c.equals;
        else if ('notEquals' in c) show = v !== c.notEquals;
        else if ('includes' in c) show = Array.isArray(v) && v.includes(c.includes);
        x.block.style.display = show ? '' : 'none';
      });
    }
    refreshVisibility();

    var submitRow = document.createElement('div');
    submitRow.className = 'q-submit';
    var submit = document.createElement('button');
    submit.type = 'button';
    submit.textContent = fd.submitLabel || 'Submit';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ghost';
    cancel.textContent = fd.cancelLabel || 'Cancel';

    async function send(answer, btn, idle) {
      submit.disabled = cancel.disabled = true;
      try {
        await submitAnswer(answer);
        app.haptic('success');
        answered();
        refreshNow();
      } catch (e) {
        app.haptic('error');
        submit.disabled = cancel.disabled = false;
        btn.textContent = 'Failed: ' + e.message;
        setTimeout(function () { btn.textContent = idle; }, 2400);
      }
    }

    submit.onclick = function () {
      var payload = questions
        .filter(function (q) {
          var b = blocks.find(function (x) { return x.q === q; });
          return !b || b.block.style.display !== 'none';
        })
        .map(function (q) { return { id: q.id, question: q.question || '', answer: answers[q.id] !== undefined ? answers[q.id] : '' }; });
      var missing = payload.find(function (a) {
        var q = questions.find(function (x) { return x.id === a.id; });
        var required = !q || q.required !== false;
        return required && (a.answer === '' || a.answer === undefined || (Array.isArray(a.answer) && !a.answer.length));
      });
      if (missing) {
        app.haptic('warning');
        submit.textContent = 'Please answer all questions';
        setTimeout(function () { submit.textContent = fd.submitLabel || 'Submit'; }, 1600);
        return;
      }
      send(payload, submit, fd.submitLabel || 'Submit');
    };
    cancel.onclick = function () {
      send([{ id: '_cancelled', question: '', answer: 'cancelled' }], cancel, fd.cancelLabel || 'Cancel');
    };
    submitRow.appendChild(submit);
    submitRow.appendChild(cancel);
    wrap.appendChild(submitRow);
    return wrap;
  }

  // --- picker ------------------------------------------------------------------

  function byPriority(a, b) {
    return (b.bound ? 1 : 0) - (a.bound ? 1 : 0)
      || (pendingCount(b) > 0 ? 1 : 0) - (pendingCount(a) > 0 ? 1 : 0)
      || (toMs(b.updatedAt) || 0) - (toMs(a.updatedAt) || 0);
  }

  function runCardHtml(r, current) {
    var chip = runChip(r);
    var n = r.workerCount || 0;
    var meta = [];
    if (r.bound) meta.push('<span class="rc-bound">📌 connected</span>');
    if (r.engine) meta.push(esc(r.engine));
    meta.push(n + ' worker' + (n === 1 ? '' : 's'));
    if (r.updatedAt) meta.push(esc(relTime(r.updatedAt)));
    return '<button type="button" class="run-card' + (r.bound ? ' bound' : '') + (current ? ' current' : '') + '" data-run="' + esc(r.runId) + '">'
      + '<div class="rc-head">' + (pendingCount(r) > 0 ? '<span class="dot" title="Questions waiting"></span>' : '')
      + '<span class="rc-title">' + esc(runTitle(r)) + '</span>'
      + '<span class="pill ' + chip.cls + '">' + esc(chip.text) + '</span></div>'
      + '<div class="rc-meta">' + meta.join('<span>·</span>') + '</div></button>';
  }

  function runsHtml(currentId) {
    if (!runs.length) return '<div class="empty">No orchestrator runs right now.<br>Start one from the dashboard.</div>';
    var bound = runs.filter(function (r) { return r.bound; });
    var rest = runs.filter(function (r) { return !r.bound; });
    var card = function (r) { return runCardHtml(r, r.runId === currentId); };
    return (bound.length ? '<div class="section-head">Connected</div>' + bound.map(card).join('') : '')
      + (rest.length ? (bound.length ? '<div class="section-head">Other runs</div>' : '') + rest.map(card).join('') : '');
  }

  function renderPicker() {
    renderRemote();
    var sig = JSON.stringify(runs) + '|' + Math.floor(Date.now() / 60000); // minute tick keeps "5 min ago" honest
    if (sig === pickerSig) return;
    pickerSig = sig;
    pickerRuns.innerHTML = runsLoaded ? runsHtml(null) : '<div class="empty">Loading…</div>';
  }

  function applyRuns(list, remote) {
    runs = (list || []).slice().sort(byPriority);
    remoteGroups = Array.isArray(remote) ? remote : [];
    runsLoaded = true;
  }

  // --- remote sessions: the slaves' questions no run holds ----------------------

  // The groups with what is still unanswered here; everything in them is the
  // slave's, so it is only ever set as text.
  function remotePending() {
    return remoteGroups.map(function (g) {
      return {
        host: plainCap(g && g.host, 100),
        sessions: (Array.isArray(g && g.sessions) ? g.sessions : []).map(function (s) {
          return {
            key: plainCap(g.host, 100) + '\u0000' + plainCap(s && s.tabId, 200),
            session: plainCap(s && s.session, 120), state: plainCap(s && s.state, 20), costUsd: s && s.costUsd,
            asks: (Array.isArray(s && s.asks) ? s.asks : []).filter(function (a) { return a && !remoteAnswered[a.askId]; }),
          };
        }).filter(function (s) { return s.asks.length; }),
      };
    }).filter(function (g) { return g.sessions.length; });
  }

  function remoteStateLine(s) {
    var bits = [s.state || 'unknown'];
    if (typeof s.costUsd === 'number' && isFinite(s.costUsd)) bits.push('$' + s.costUsd.toFixed(2));
    return bits.join(' · ');
  }

  function remoteCard(s) {
    var card = document.createElement('div');
    card.className = 'remote-session';
    var t = document.createElement('div');
    t.className = 'rs-title';
    t.textContent = s.session || 'Remote session';
    var st = document.createElement('div');
    st.className = 'rs-state';
    card.appendChild(t);
    card.appendChild(st);
    var ask = s.asks[0];
    // One question at a time per session, like a run's.
    card.appendChild(buildForm(ask, s.asks.length, function (answer) {
      return app.api('remote/answer', { method: 'POST', body: answerBody(ask, answer) });
    }, function () {
      remoteAnswered[ask.askId] = true;
      renderRemote();
      renderHeader();
    }));
    return { el: card, stateEl: st };
  }

  // Rebuilt only when the set of questions changes, so a half-filled answer
  // survives the polls; the state lines are updated in place.
  function renderRemote() {
    var groups = remotePending();
    var fresh = false;
    groups.forEach(function (g) {
      g.sessions.forEach(function (s) {
        s.asks.forEach(function (a) { if (!remoteSeen[a.askId]) { remoteSeen[a.askId] = true; fresh = true; } });
      });
    });
    if (fresh && remoteLayout !== null) app.haptic('warning');
    var layout = groups.map(function (g) {
      return g.sessions.map(function (s) { return s.key + '\u0001' + s.asks.map(function (a) { return a.askId; }).join(','); }).join('\u0002');
    }).join('\u0003');
    if (layout !== remoteLayout) {
      remoteLayout = layout;
      var keep = new Map();
      remoteEl.textContent = '';
      if (groups.length) {
        var head = document.createElement('div');
        head.className = 'section-head';
        head.textContent = 'Remote sessions';
        remoteEl.appendChild(head);
      }
      groups.forEach(function (g) {
        var ph = document.createElement('div');
        ph.className = 'remote-peer';
        ph.textContent = g.host || 'Remote';
        remoteEl.appendChild(ph);
        g.sessions.forEach(function (s) {
          var sig = s.asks.map(function (a) { return a.askId; }).join(',');
          var c = remoteCards.get(s.key);
          if (!c || c.sig !== sig) { c = remoteCard(s); c.sig = sig; }
          keep.set(s.key, c);
          remoteEl.appendChild(c.el);
        });
      });
      remoteCards = keep;
    }
    groups.forEach(function (g) {
      g.sessions.forEach(function (s) { var c = remoteCards.get(s.key); if (c) c.stateEl.textContent = remoteStateLine(s); });
    });
    remoteEl.hidden = !groups.length;
  }

  // --- navigation ----------------------------------------------------------------

  function setUrlRun(runId) {
    try {
      var p = new URLSearchParams(location.search);
      if (runId) p.set('run', runId); else p.delete('run');
      var q = p.toString();
      history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
    } catch (e) { /* cosmetic */ }
  }

  function showPicker() {
    closeSheet();
    view = 'picker';
    cur = null;
    setUrlRun(null);
    runEl.hidden = true;
    pickerEl.hidden = false;
    pickerSig = '';
    renderPicker();
    renderHeader();
    refreshNow();
  }

  function openRun(runId) {
    closeSheet();
    if (cur && cur.runId === runId && view === 'run') return;
    view = 'run';
    cur = newCurrent(runId);
    setUrlRun(runId);
    pickerEl.hidden = true;
    runEl.hidden = false;
    workersEl.hidden = true;
    workersEl.open = load('vcTgWorkersOpen') === '1';
    questionArea.hidden = true;
    questionArea.innerHTML = '';
    resetConversation();
    msgInput.value = load(cur.draftKey);
    autosize();
    renderHeader();
    renderInput();
    refreshNow();
  }

  function enterLegacy() {
    view = 'run';
    cur = newCurrent(null);
    pickerEl.hidden = true;
    runEl.hidden = false;
    workersEl.hidden = true;
    msgInput.placeholder = 'Message Claude…';
    resetConversation();
    msgInput.value = load(cur.draftKey);
    autosize();
    renderHeader();
  }

  // Telegram's own chrome: BackButton returns from a run (or a sheet) to the
  // picker. Outside Telegram the header ‹ does the same.
  function syncChrome() {
    if (!hasTgBack) return;
    try {
      if (sheetKind || (mode === 'runs' && view === 'run')) tg.BackButton.show(); else tg.BackButton.hide();
    } catch (e) { /* older Telegram clients */ }
  }

  function goBack() {
    if (!overlay.hidden) { overlay.hidden = true; return; }
    if (sheetKind) { closeSheet(); return; }
    if (mode === 'runs' && view === 'run') { tick0(); showPicker(); }
  }

  // --- sheets: run switcher and the ⋯ menu --------------------------------------

  function openSheet(kind, html) {
    sheetKind = kind;
    sheetBody.innerHTML = html;
    sheetEl.hidden = false;
    syncChrome();
  }
  function closeSheet() {
    sheetKind = null;
    sheetEl.hidden = true;
    syncChrome();
  }

  function menuItem(action, label, sub, cls) {
    return '<button type="button" class="menu-item ' + (cls || '') + '" data-action="' + action + '">' + label
      + (sub ? '<span class="mi-sub">' + sub + '</span>' : '') + '</button>';
  }

  function openSwitcher() {
    if (mode !== 'runs' || view !== 'run') return;
    var render = function () {
      if (sheetKind === 'switch') sheetBody.innerHTML = '<div class="section-head">Switch run</div>' + runsHtml(cur && cur.runId) + menuItem('picker', '☰ All runs');
    };
    openSheet('switch', '');
    render();
    app.api('runs').then(function (d) { applyRuns(d.runs, d.remote); render(); }).catch(function () { /* the cached list is shown */ });
  }

  function openMenu() {
    if (mode === 'legacy') {
      openSheet('menu', menuItem('end', '⏹ End session', 'Stops the CLI session', 'danger') + menuItem('close', 'Cancel'));
      return;
    }
    var s = cur && cur.snap;
    openSheet('menu',
      menuItem('refresh', '🔄 Refresh orchestrator', 'Ask the orchestrator to refresh its view of the run')
      + menuItem('picker', '☰ All runs')
      + (s && s.bound ? menuItem('unbind', '🔌 Disconnect', 'Unbind this chat from the run', 'danger') : '')
      + menuItem('close', 'Cancel'));
  }

  sheetEl.addEventListener('click', function (e) {
    var t = e.target;
    if (t === sheetEl) { closeSheet(); return; }
    var card = t.closest && t.closest('[data-run]');
    if (card) { tick0(); openRun(card.dataset.run); return; }
    var item = t.closest && t.closest('[data-action]');
    if (!item) return;
    var a = item.dataset.action;
    closeSheet();
    if (a === 'picker') showPicker();
    else if (a === 'refresh') runAction('refresh', 'Refresh sent');
    else if (a === 'unbind') {
      runAction('unbind', 'Disconnected').then(function (ok) { if (ok) showPicker(); });
    } else if (a === 'end') endLegacy();
  });

  // --- actions -------------------------------------------------------------------

  function post(action, body) {
    return app.api('run/' + encodeURIComponent(cur.runId) + '/' + action, { method: 'POST', body: body || {} });
  }

  async function runAction(action, okText) {
    try {
      await post(action);
      app.haptic('success');
      if (okText) toast(okText);
      refreshNow();
      return true;
    } catch (e) {
      app.haptic('error');
      toast(action + ' failed: ' + e.message);
      return false;
    }
  }

  async function send() {
    var c = cur;
    var text = msgInput.value.trim();
    if (!c || !text || c.sending || msgInput.disabled) return;
    var busy = c.snap && c.snap.busy;
    c.sending = true;
    renderInput();
    var bubble = addPending(text, 'sending…');
    toBottom();
    try {
      if (mode === 'legacy') await app.api('send', { method: 'POST', body: { text: text } });
      else await post('send', { text: text });
      impact();
      // The owner may have kept typing during the request; only clear what was sent.
      if (msgInput.value.trim() === text) msgInput.value = '';
      store(c.draftKey, msgInput.value);
      autosize();
      bubble.label.textContent = busy ? 'queued' : 'sent';
      refreshNow();
    } catch (e) {
      if (cur === c) dropPending(bubble);
      app.haptic('error');
      toast('Not sent (' + e.message + ') — your text is kept.');
    } finally {
      c.sending = false;
      if (cur === c) renderInput();
    }
  }

  function confirmBox(msg, actions) {
    el('overlay-msg').textContent = msg;
    var box = el('overlay-actions');
    box.innerHTML = '';
    actions.forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      if (a.cls) b.className = a.cls;
      b.onclick = function () { overlay.hidden = true; if (a.fn) a.fn(); };
      box.appendChild(b);
    });
    overlay.hidden = false;
  }

  async function endLegacy() {
    try {
      var r = await app.api('end', { method: 'POST', body: {} });
      if (r.ended) { setStatus('exited', 'ended'); if (tg) setTimeout(function () { tg.close(); }, 1200); return; }
      var a = r.assessment || {};
      var bits = ['Claude is still working on a turn.'];
      if (a.pendingAsks) bits.push(a.pendingAsks + ' question(s) pending.');
      if (a.dirtyFiles) bits.push(a.dirtyFiles + ' uncommitted file(s).');
      confirmBox(bits.join(' ') + ' End anyway?', [
        { label: 'End anyway', cls: 'danger', fn: async function () {
          try {
            var rr = await app.api('end', { method: 'POST', body: { force: true } });
            if (rr.ended) { setStatus('exited', 'ended'); if (tg) setTimeout(function () { tg.close(); }, 1200); }
          } catch (e) { toast(e.message); }
        } },
        { label: 'Keep waiting', cls: 'ghost' },
      ]);
    } catch (e) {
      toast('End failed: ' + e.message);
    }
  }

  sendBtn.onclick = send;
  msgInput.addEventListener('keydown', function (e) {
    // Enter sends on a hardware keyboard; on a phone the return key adds a line.
    if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); send(); }
  });
  function autosize() {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(140, msgInput.scrollHeight + 2) + 'px';
  }
  msgInput.addEventListener('input', function () {
    if (cur) store(cur.draftKey, msgInput.value);
    autosize();
    renderInput();
  });
  // The keyboard shrinks the viewport: keep the latest message in view.
  msgInput.addEventListener('focus', function () {
    if (atBottom()) setTimeout(toBottom, 250);
  });

  pauseBtn.onclick = function () {
    var s = cur && cur.snap;
    if (!s) return;
    pauseBtn.disabled = true;
    runAction(s.paused ? 'resume' : 'pause', s.paused ? 'Resuming' : 'Pause requested');
  };

  escBtn.onclick = function () {
    confirmBox(mode === 'legacy' ? 'Interrupt Claude’s current turn?' : 'Interrupt the orchestrator’s current turn?', [
      { label: 'Interrupt', cls: 'danger', fn: function () {
        if (mode === 'legacy') {
          app.api('esc', { method: 'POST', body: {} }).then(function () { app.haptic('success'); refreshNow(); })
            .catch(function (e) { toast('Interrupt failed: ' + e.message); });
        } else runAction('esc', 'Interrupt sent');
      } },
      { label: 'Cancel', cls: 'ghost' },
    ]);
  };

  moreBtn.onclick = openMenu;
  titleBtn.onclick = openSwitcher;
  backBtn.onclick = goBack;
  newPill.onclick = toBottom;
  convEl.addEventListener('scroll', function () {
    if (!newPill.hidden && atBottom()) { newPill.hidden = true; if (cur) cur.newCount = 0; }
  });
  workersEl.addEventListener('toggle', function () { store('vcTgWorkersOpen', workersEl.open ? '1' : ''); });

  pickerEl.addEventListener('click', function (e) {
    var card = e.target.closest && e.target.closest('[data-run]');
    if (card) { tick0(); openRun(card.dataset.run); }
  });

  // Links leave the webview through Telegram, which would otherwise navigate
  // the Mini App itself away.
  convEl.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a || !/^https?:/i.test(a.href)) return;
    e.preventDefault();
    try { if (tg && tg.openLink) tg.openLink(a.href); else window.open(a.href, '_blank', 'noopener'); } catch (err) { /* ignore */ }
  });

  if (tg) {
    try { if (hasTgBack) tg.BackButton.onClick(goBack); } catch (e) { /* older Telegram clients */ }
    try { tg.setHeaderColor && tg.setHeaderColor('secondary_bg_color'); } catch (e) { /* optional */ }
    try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch (e) { /* optional */ }
    var scheme = function () { document.documentElement.style.colorScheme = tg.colorScheme === 'light' ? 'light' : 'dark'; };
    scheme();
    try { tg.onEvent('themeChanged', scheme); } catch (e) { /* optional */ }
    try { tg.onEvent('viewportChanged', function () { if (cur && atBottom()) toBottom(); }); } catch (e) { /* optional */ }
  }

  // --- polling -------------------------------------------------------------------

  // One fetch at a time, at the cadence of the current view; hidden = no fetch.
  async function tick() {
    if (document.hidden) return;
    if (inflight) { return; }
    var now = Date.now();
    if (now < retryAt) return;
    var every = mode === 'legacy' ? LEGACY_POLL_MS : view === 'run' ? RUN_POLL_MS : PICKER_POLL_MS;
    if (mode && now - lastFetch < every) return;
    inflight = true;
    lastFetch = now;
    try {
      if (!mode) await detect();
      else if (mode === 'legacy') await pollLegacy();
      else if (view === 'run') await pollRun();
      else await pollRuns();
      failCount = 0;
      retryAt = 0;
      hideBanner('net');
    } catch (e) {
      failCount++;
      retryAt = Date.now() + Math.min(30000, 1000 * Math.pow(2, failCount - 1));
      var why = e.message === 'unauthorized' ? 'Not authorized — reopen this from the Telegram bot.'
        : (e.name === 'TypeError' ? 'Connection lost' : e.message) + ' — retrying…';
      showBanner(why, 'net');
    } finally {
      inflight = false;
      if (again) { again = false; setTimeout(refreshNow, 0); }
    }
  }

  function refreshNow() {
    if (inflight) { again = true; return; }
    lastFetch = 0;
    retryAt = 0;
    tick();
  }

  async function detect() {
    var data;
    try {
      data = await app.api('runs');
    } catch (e) {
      if (!isNotFound(e)) throw e;
      mode = 'legacy';
      enterLegacy();
      return pollLegacy();
    }
    mode = 'runs';
    applyRuns(data.runs, data.remote);
    if (deepRun) openRun(deepRun);
    else showPicker();
  }

  async function pollRuns() {
    var data = await app.api('runs');
    applyRuns(data.runs, data.remote);
    if (view === 'picker') { renderPicker(); renderHeader(); }
  }

  async function pollRun() {
    var c = cur;
    var q = c.cursor != null ? '?since=' + encodeURIComponent(c.cursor) : '';
    var data;
    try {
      data = await app.api('run/' + encodeURIComponent(c.runId) + q);
    } catch (e) {
      if (!isNotFound(e) || cur !== c) throw e;
      toast('That run is no longer available.');
      showPicker();
      return;
    }
    if (cur === c) applyRun(data);
  }

  async function pollLegacy() {
    var s = await app.api('state');
    if (cur) applyLegacy(s);
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshNow();
  });

  pickerEl.hidden = false;
  renderPicker();
  renderHeader();
  app.boot(tick, TICK_MS);
})();
