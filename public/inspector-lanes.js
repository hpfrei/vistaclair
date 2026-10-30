// The live lanes: while the inspector is in live mode its detail panel shows
// one column per agent of the session (the main thread, each subagent), each a
// running feed of that agent's turns. These are the decisions behind it —
// which lane a turn goes to, which result answers which tool call, how a call
// or a result reads on one line, which turns a lane renders — kept free of the
// DOM so test/inspector-lanes.test.js can run them. The view is in
// public/inspector.js.
(function (root) {
  const LIMITS = {
    // Turns a lane shows when it opens, and each step further back.
    INITIAL_TURNS: 20,
    PAGE_TURNS: 20,
    // Turns a lane holds in the DOM at most; older ones come back on scroll-up.
    MAX_RENDERED: 40,
    // Rows of a tool result shown inline; the rest open on click.
    RESULT_ROWS: 50,
    // Media thumbnails under one tool result; the rest read "+N".
    RESULT_THUMBS: 8,
    // A subagent with nothing streaming this long counts as done.
    IDLE_DONE_MS: 30 * 1000,
    // A done lane folds to a thin rail after this long.
    RAIL_AFTER_MS: 20 * 1000,
  };

  const LANE_MAIN = 'main';
  const ARG_MAX = 160;

  // LLM turns only: hooks and MCP calls have no lane of their own.
  function isLaneTurn(i) {
    if (!i || i.isHook || i.isMcp) return false;
    return !i.endpoint || i.endpoint === '/v1/messages' || !!i.translatedFrom;
  }

  const laneKeyOf = i => i.subagent?.agentId || LANE_MAIN;

  /* The lanes of one session, in the order they are shown: the main thread
     first (always there, even before its first turn), then each subagent in
     the order its first turn arrived. `interactions` is in timestamp order.
     Returns [{ key, subagent, ids }]. */
  function groupLanes(interactions, instanceId) {
    const lanes = new Map([[LANE_MAIN, { key: LANE_MAIN, subagent: null, ids: [] }]]);
    for (const i of interactions) {
      if (i.instanceId !== instanceId || !isLaneTurn(i)) continue;
      const key = laneKeyOf(i);
      let lane = lanes.get(key);
      if (!lane) {
        lane = { key, subagent: i.subagent, ids: [] };
        lanes.set(key, lane);
      } else if (lane.subagent && !lane.subagent.description && i.subagent?.description) {
        lane.subagent = i.subagent;
      }
      lane.ids.push(i.id);
    }
    return [...lanes.values()];
  }

  /* What the user (or a parent agent) newly said in a turn: the text blocks of
     the newest user message, without Claude Code's <system-reminder> blocks.
     Kept in step with newUserText in src/dashboard-ws.js, which sends it as
     request._newUserText. */
  function newUserText(msgs, max = 2000) {
    const last = Array.isArray(msgs) ? msgs[msgs.length - 1] : null;
    if (last?.role !== 'user') return null;
    const parts = typeof last.content === 'string' ? [last.content]
      : (Array.isArray(last.content) ? last.content.filter(b => b?.type === 'text' && b.text).map(b => b.text) : []);
    const text = parts
      .map(t => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim())
      .filter(Boolean).join('\n\n');
    return text ? text.slice(0, max) : null;
  }

  function turnUserText(i) {
    const req = i?.request;
    if (!req) return null;
    if (Array.isArray(req.messages)) return newUserText(req.messages);
    return req._newUserText || null;
  }

  // The tool_result blocks a turn's request carries: they only ever arrive in
  // the newest user message, answering the calls of the turn before.
  function toolResultsOf(i) {
    const req = i?.request;
    if (!req) return [];
    if (Array.isArray(req.messages)) {
      const last = req.messages[req.messages.length - 1];
      if (last?.role !== 'user' || !Array.isArray(last.content)) return [];
      return last.content.filter(b => b?.type === 'tool_result');
    }
    return Array.isArray(req._toolResults) ? req._toolResults : [];
  }

  // tool_use_id -> its tool_result block, over the given turns.
  function toolResultIndex(interactions) {
    const out = new Map();
    for (const i of interactions) {
      for (const b of toolResultsOf(i)) {
        if (b.tool_use_id && !out.has(b.tool_use_id)) out.set(b.tool_use_id, b);
      }
    }
    return out;
  }

  const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  const cut = (s, max = ARG_MAX) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

  // The last three segments of a path: enough to tell files apart in a lane.
  function shortPath(p) {
    if (typeof p !== 'string' || !p) return '';
    const parts = p.split('/').filter(Boolean);
    return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : p;
  }

  const TOOL_ICONS = {
    Read: '▤', Write: '✎', Edit: '✎', MultiEdit: '✎', NotebookEdit: '✎',
    Bash: '$', BashOutput: '$', Grep: '⌕', Glob: '⁂', Agent: '⑂', Task: '⑂',
    WebFetch: '⇣', WebSearch: '⌕', TodoWrite: '☑', Skill: '/',
  };

  /* A tool call as one line: an icon, the tool's name and its key argument,
     not the JSON. { icon, name, arg, title, desc } — title is the argument
     whole; desc is what the call says it is for (its `description`), unless
     the argument already is that. */
  function toolLine(name, input) {
    const icon = TOOL_ICONS[name] || (String(name).startsWith('mcp__') ? '◇' : '•');
    let shown = name || 'tool';
    let arg = '';
    let title = '';
    const inp = input && typeof input === 'object' ? input : null;
    if (inp) {
      const path = inp.file_path || inp.notebook_path || inp.filePath;
      if (name === 'Bash') {
        const cmd = String(inp.command || '');
        const lines = cmd.split('\n');
        arg = lines[0] + (lines.length > 1 ? ' …' : '');
        title = cmd;
      } else if (name === 'Grep') {
        arg = `"${inp.pattern || ''}"` + (inp.path ? ` ${shortPath(inp.path)}` : '');
      } else if (name === 'Agent' || name === 'Task') {
        arg = inp.description || inp.subagent_type || '';
        title = inp.prompt || '';
      } else if (name === 'WebSearch') {
        arg = `"${inp.query || ''}"`;
      } else if (name === 'TodoWrite' && Array.isArray(inp.todos)) {
        arg = `${inp.todos.length} todo${inp.todos.length === 1 ? '' : 's'}`;
      } else if (name === 'Skill' && inp.skill) {
        shown = `/${inp.skill}`;
        arg = inp.args || '';
      } else if (path) {
        arg = shortPath(path);
        title = path;
      } else {
        for (const k of ['command', 'pattern', 'query', 'url', 'description', 'prompt']) {
          if (typeof inp[k] === 'string' && inp[k]) { arg = inp[k]; break; }
        }
        if (!arg) {
          for (const v of Object.values(inp)) {
            if (typeof v === 'string' && v) { arg = v; break; }
          }
        }
      }
    }
    const full = oneLine(arg);
    const about = typeof inp?.description === 'string' ? oneLine(inp.description) : '';
    const desc = about && about !== full ? cut(about) : '';
    return { icon, name: shown, arg: cut(full), title: title || full, desc };
  }

  /* A tool result as one dim line, and the text its expanded preview shows.
     { text, error, preview } */
  function resultLine(block) {
    if (!block) return null;
    const c = block.content;
    const texts = [];
    let images = 0;
    if (typeof c === 'string') texts.push(c);
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === 'text' && b.text) texts.push(b.text);
        else if (b?.type === 'image') images++;
      }
    }
    const preview = texts.join('\n').replace(/\s+$/, '');
    const more = block._truncated ? '+' : '';
    if (block.is_error) {
      const first = oneLine(preview.split('\n').find(l => l.trim()) || 'error');
      return { text: `error: ${cut(first, 120)}`, error: true, preview };
    }
    let text;
    if (!preview) text = images ? `${images} image${images === 1 ? '' : 's'}` : 'no output';
    else {
      const lines = preview.split('\n');
      text = lines.length === 1 && !more && preview.length <= 80
        ? oneLine(preview)
        : `${lines.length}${more} line${lines.length === 1 && !more ? '' : 's'}`;
      if (images) text += ` · ${images} image${images === 1 ? '' : 's'}`;
    }
    return { text, error: false, preview };
  }

  /* A result's text split for the inline view: the first `max` rows, and
     what is left behind "… N more lines". { head, rest, more } */
  function resultRows(text, max = LIMITS.RESULT_ROWS) {
    const lines = String(text ?? '').split('\n');
    if (lines.length <= max) return { head: lines.join('\n'), rest: '', more: 0 };
    return { head: lines.slice(0, max).join('\n'), rest: lines.slice(max).join('\n'), more: lines.length - max };
  }

  // Kept in step with _FILE_PATH_RE in public/core.js, so a thumbnail is
  // shown for exactly the paths linkifyFilePaths makes links of.
  const FILE_PATH_RE = /(\/(?:home|tmp|var|etc|usr|opt|mnt|root|srv|proc|nix|snap)[^\s"'<>),;:\]]*\.[a-zA-Z0-9]{1,10})/g;
  const MEDIA_SCAN_CHARS = 200000;

  /* The media files a result's text names, for its thumbnail strip: each path
     once, in order of first mention, `categoryOf(path)` deciding its kind
     ('image', 'video', 'audio'; anything else is skipped). { items: [{ path,
     category }], more } — `more` counts the media paths past `max`. */
  function mediaPaths(text, categoryOf, max = LIMITS.RESULT_THUMBS) {
    const items = [];
    const seen = new Set();
    let more = 0;
    const s = String(text ?? '').slice(0, MEDIA_SCAN_CHARS);
    for (const m of s.matchAll(FILE_PATH_RE)) {
      const path = m[1];
      if (seen.has(path)) continue;
      seen.add(path);
      const category = categoryOf(path);
      if (category !== 'image' && category !== 'video' && category !== 'audio') continue;
      if (items.length < max) items.push({ path, category });
      else more++;
    }
    return { items, more };
  }

  const _norm = s => (s || '').replace(/\s+/g, ' ').trim();

  /* Agent tool call (tool_use_id) -> the agentId of the subagent it ran, so a
     main-lane Agent call can wear its lane's colour and point at it. Sources,
     surest first: the Agent call's PostToolUse hook names the agent; a
     SubagentStart hook names the call that spawned it; a guessed lane key
     'pending-<tool_use_id>' carries the call itself; and a subagent's first
     prompt starts with what the call passed (the probe wide-layout.js also
     uses). `toolCallsOf(i)` lists a turn's tool calls ({ id, name, input }). */
  function agentLinks(interactions, toolCallsOf) {
    const out = new Map();
    const probes = [];
    for (const i of interactions) {
      if (i.isHook) {
        if (/PostToolUse/i.test(i.hookEvent || '') && i.toolName === 'Agent' && i.toolUseId) {
          const tr = i.request?.tool_response;
          const aid = i.request?._agentId || (tr && typeof tr.agentId === 'string' ? tr.agentId : null);
          if (aid) out.set(i.toolUseId, aid);
        } else if (i.hookEvent === 'SubagentStart' && i.hookAgentId && i.subagent?.toolUseId) {
          if (!out.has(i.subagent.toolUseId)) out.set(i.subagent.toolUseId, i.hookAgentId);
        }
        continue;
      }
      if (i.isMcp || i.subagent?.agentId) continue;
      for (const tc of toolCallsOf(i) || []) {
        if ((tc.name !== 'Agent' && tc.name !== 'Task') || !tc.id) continue;
        const probe = _norm(tc.input?.prompt).slice(0, 200);
        if (probe.length >= 30) probes.push({ id: tc.id, probe });
      }
    }
    const seen = new Set();
    for (const i of interactions) {
      const aid = i.subagent?.agentId;
      if (!aid || i.isHook || i.isMcp || seen.has(aid)) continue;
      seen.add(aid);
      if (aid.startsWith('pending-')) {
        const tuid = aid.slice('pending-'.length);
        if (!out.has(tuid)) out.set(tuid, aid);
        continue;
      }
      const text = _norm(i.request?._firstUserText || newUserText(i.request?.messages) || '');
      if (!text) continue;
      const hit = probes.find(p => !out.has(p.id) && text.includes(p.probe));
      if (hit) out.set(hit.id, aid);
    }
    return out;
  }

  /* Is a subagent's lane finished? Not while a turn of it streams; then once
     the Agent call that ran it has its result, a SubagentStop was seen, or
     nothing happened for a while. */
  function laneDone({ live, resultSeen, stopped, lastActivity }, now, idleMs = LIMITS.IDLE_DONE_MS) {
    if (live) return false;
    if (resultSeen || stopped) return true;
    return lastActivity != null && now - lastActivity >= idleMs;
  }

  /* Which of a lane's turns are rendered: [from, to) into its ids. `prev`
     anchors the window by the ids at its ends — toId null means it runs to
     the newest turn and follows it. A window at the newest turn holds at most
     `max`, dropping its oldest; one whose anchor left starts over at the end. */
  function laneWindow(ids, prev = {}, opts = {}) {
    const { initial = LIMITS.INITIAL_TURNS, max = LIMITS.MAX_RENDERED } = opts;
    const n = ids.length;
    let to = prev.toId == null ? n : ids.indexOf(prev.toId) + 1;
    if (to <= 0) to = n;
    let from = prev.fromId == null ? -1 : ids.indexOf(prev.fromId);
    if (from < 0 || from >= to) from = Math.max(0, to - initial);
    if (to - from > max) from = to - max;
    return { from, to };
  }

  /* One step back: `page` older turns in front; past `max` the newest are let
     go, and the window no longer follows the live end. */
  function pageOlder(ids, win, opts = {}) {
    const { page = LIMITS.PAGE_TURNS, max = LIMITS.MAX_RENDERED } = opts;
    const from = Math.max(0, win.from - page);
    const to = Math.min(win.to, from + max);
    return { from, to };
  }

  const api = {
    LIMITS, LANE_MAIN, isLaneTurn, laneKeyOf, groupLanes, newUserText, turnUserText,
    toolResultsOf, toolResultIndex, shortPath, toolLine, resultLine, resultRows, mediaPaths, agentLinks, laneDone,
    laneWindow, pageOlder,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.inspectorLanes = api;
})(typeof window !== 'undefined' ? window : globalThis);
