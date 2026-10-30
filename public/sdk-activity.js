// What an SDK session is running right now, for the activity rows under a
// box's caption: the main agent's tool calls still open (several at once when
// one reply makes them in parallel) and its background tasks (a Bash or an
// agent started with run_in_background, or moved there), which outlive the
// turn. A subagent's own calls are not in it.
// Fed from the SDK's messages: the calls from the panel (tool_use / its
// tool_result / the turn's result), the rest from tool_progress heartbeats and
// the system task_started / task_notification / task_updated /
// background_tasks_changed messages; the last is a snapshot of the live
// background tasks and wins over whatever was missed.
// Times are the caller's clock (the panel passes the server's: the envelopes'
// ts), so a replay ages its calls from when they really started. Pure: the
// clock is passed in, nothing touches the DOM. test/sdk-activity.test.js
(function (root) {
  const MAX = 200;                 // calls, and tasks, kept at most
  const HEARTBEAT = /-heartbeat-\d+$/;
  const FINAL = new Set(['completed', 'failed', 'killed', 'stopped']);
  const DRIFT_MS = 2000;           // a heartbeat moves a start known closer than this not
  const TASK_TOOL = { local_bash: 'Bash', local_agent: 'Agent' };

  // The call a tool_progress is about: a heartbeat's own id is "<id>-heartbeat-N".
  function progressOf(m) {
    const id = typeof m?.tool_use_id === 'string' ? m.tool_use_id : '';
    if (!HEARTBEAT.test(id)) return id || null;
    return m.parent_tool_use_id || id.replace(HEARTBEAT, '');
  }

  // A Map past `max`: its oldest entries go, those `droppable` lets go first.
  function cap(map, max, droppable) {
    for (const pass of [droppable, () => true]) {
      for (const [k, v] of map) {
        if (map.size <= max) return;
        if (pass(v)) map.delete(k);
      }
    }
  }

  function createActivity({ max = MAX } = {}) {
    const calls = new Map();   // tool_use_id -> {id, name, description, gist, startedAt}
    const tasks = new Map();   // task_id -> {id, toolUseId, type, subagentType, description, bg, startedAt}
    const sooner = (a, b) => a == null ? b : b == null ? a : Math.min(a, b);

    function task(id, at) {
      let t = tasks.get(id);
      if (!t) {
        t = { id, toolUseId: null, type: '', subagentType: '', description: '', bg: false, startedAt: at ?? null };
        tasks.set(id, t);
        cap(tasks, max, (x) => !x.bg);
      }
      return t;
    }

    return {
      // A main-agent call is made (`at`: when, or null when not known).
      toolStart(id, name, at) {
        if (!id) return false;
        const c = calls.get(id);
        if (c) { if (name && !c.name) c.name = name; return false; }
        calls.set(id, { id, name: name || '', description: '', gist: '', startedAt: at ?? null });
        cap(calls, max, () => true);
        return true;
      },
      toolInput(id, { description = '', gist = '' } = {}) {
        const c = calls.get(id);
        if (!c || (c.description === description && c.gist === gist)) return false;
        c.description = description;
        c.gist = gist;
        return true;
      },
      // Its tool_result came. A task it left running keeps its start.
      toolDone(id) {
        const c = calls.get(id);
        if (!c) return false;
        for (const t of tasks.values()) if (t.toolUseId === id) t.startedAt = sooner(t.startedAt, c.startedAt);
        return calls.delete(id);
      },

      // tool_progress: the call's elapsed time, which sets its start (and
      // gives one to a call whose start was not known, e.g. replayed).
      progress(m, at) {
        const c = calls.get(progressOf(m));
        const secs = Number(m?.elapsed_time_seconds);
        if (!c || at == null || !Number.isFinite(secs)) return false;
        const start = at - secs * 1000;
        if (c.startedAt != null && Math.abs(c.startedAt - start) < DRIFT_MS) return false;
        c.startedAt = start;
        return true;
      },

      // A system message; true when the rows change.
      system(m, at) {
        switch (m?.subtype) {
          case 'task_started': {
            if (!m.task_id) return false;
            const t = task(m.task_id, at);
            t.toolUseId = m.tool_use_id || t.toolUseId;
            t.type = m.task_type || t.type;
            t.subagentType = m.subagent_type || t.subagentType;
            t.description = m.description || t.description;
            t.bg = t.bg || !!m.is_backgrounded;
            t.startedAt = sooner(t.startedAt, at);
            return t.bg;
          }
          case 'task_notification': {
            const t = tasks.get(m.task_id);
            return !!t && tasks.delete(m.task_id) && t.bg;
          }
          case 'task_updated': {
            const t = tasks.get(m.task_id);
            const p = m.patch || {};
            if (!t) return false;
            if (FINAL.has(p.status)) { tasks.delete(m.task_id); return t.bg; }
            if (p.is_backgrounded && !t.bg) { t.bg = true; return true; }
            return false;
          }
          case 'background_tasks_changed': {
            if (!Array.isArray(m.tasks)) return false;
            const live = new Set();
            let changed = false;
            for (const x of m.tasks) {
              if (!x?.task_id) continue;
              live.add(x.task_id);
              const t = task(x.task_id, at);
              t.type = t.type || x.task_type || '';
              t.subagentType = t.subagentType || x.subagent_type || '';
              t.description = t.description || x.description || '';
              if (!t.bg) { t.bg = true; changed = true; }
            }
            for (const [id, t] of tasks) if (t.bg && !live.has(id)) { tasks.delete(id); changed = true; }
            return changed;
          }
        }
        return false;
      },

      // The main agent's turn ended: its calls and foreground tasks are over,
      // its background tasks go on.
      turnEnd() {
        const had = calls.size > 0;
        calls.clear();
        for (const [id, t] of tasks) if (!t.bg) tasks.delete(id);
        return had;
      },
      // The session ended: nothing of it runs any more.
      clear() {
        const had = calls.size > 0 || [...tasks.values()].some((t) => t.bg);
        calls.clear();
        tasks.clear();
        return had;
      },

      // The rows, oldest first: the calls, then the background tasks. A
      // call that runs as a background task is shown once, as the task.
      items() {
        const bg = [...tasks.values()].filter((t) => t.bg);
        const byCall = new Map(bg.filter((t) => t.toolUseId).map((t) => [t.toolUseId, t]));
        const out = [];
        for (const c of calls.values()) {
          if (byCall.has(c.id)) continue;
          out.push({ key: c.id, bg: false, name: c.name, description: c.description, gist: c.gist, startedAt: c.startedAt });
        }
        for (const t of bg) {
          const c = t.toolUseId ? calls.get(t.toolUseId) : null;
          out.push({
            key: `task:${t.id}`, bg: true,
            name: c?.name || TASK_TOOL[t.type] || t.type || 'task',
            description: t.description || c?.description || '', gist: c?.gist || '',
            subagentType: t.subagentType, startedAt: sooner(t.startedAt, c?.startedAt),
          });
        }
        return out;
      },
      bgCount() { let n = 0; for (const t of tasks.values()) if (t.bg) n++; return n; },
      size() { return { calls: calls.size, tasks: tasks.size }; },
    };
  }

  // A row's age: "45s", "3m12", "12m", "1h05", "2d".
  function fmtAge(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 10) return `${m}m${String(s % 60).padStart(2, '0')}`;
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}`;
    return `${Math.floor(h / 24)}d`;
  }

  // A row in words, as the feed names the call: the description, else the
  // gist. `pretty` names the tool (the panel's "server · tool" for MCP).
  function describe(item, now, pretty = (n) => n || 'tool') {
    const age = item.startedAt != null && now != null ? fmtAge(now - item.startedAt) : '';
    const name = pretty(item.name);
    const label = item.description || item.gist || '';
    const what = label ? `${name} · ${label}` : name;
    const tip = [
      `${item.bg ? 'Background ' : ''}${name}${item.subagentType ? ` (${item.subagentType})` : ''}${age ? `, running ${age}` : ''}`,
      item.description, item.gist && item.gist !== item.description ? item.gist : '',
    ].filter(Boolean).join('\n');
    return { age, what, text: [item.bg ? 'bg' : '', age, what].filter(Boolean).join(' '), tip };
  }

  const api = { createActivity, progressOf, fmtAge, describe, MAX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.sdkActivity = api;
})(typeof window !== 'undefined' ? window : globalThis);
