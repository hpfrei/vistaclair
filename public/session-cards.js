// Shared pieces of the session cards drawn by the CLI view's Sessions tab
// (cli.js) and the Inspector's Sessions tab (inspector.js): status pill,
// relative time, the card head, the directory name, the compact TODO list and
// the worker list. Each returns an HTML string; the views own the cards, their
// actions and their clicks.
(function () {
  const esc = (s) => window.dashboard.escHtml(String(s ?? ''));

  // "just now", "3 min ago", "2 h ago", "4 d ago"; a date after a month.
  function relTime(ms) {
    if (!ms) return '';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 30 * 86400) return `${Math.floor(s / 86400)} d ago`;
    return new Date(ms).toLocaleDateString();
  }

  // A <time> with the full date on hover.
  function timeHtml(ms) {
    if (!ms) return '';
    return `<time class="sc-time" datetime="${new Date(ms).toISOString()}" title="${esc(new Date(ms).toLocaleString())}">${esc(relTime(ms))}</time>`;
  }

  // A status word's tone: ok (working), live (streaming), warn, bad, done,
  // or muted (not running).
  function toneOf(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'streaming' || s === 'busy' || s === 'working') return 'live';
    if (['running', 'idle', 'awaiting', 'open', 'started', 'update'].includes(s)) return 'ok';
    if (['pausing', 'paused', 'interrupted', 'blocked'].includes(s)) return 'warn';
    if (['failed', 'missing', 'abandoned', 'error'].includes(s)) return 'bad';
    if (['done', 'completed', 'closed'].includes(s)) return 'done';
    return 'muted';
  }

  // The vc-card accent bar for a status.
  function accentOf(status) {
    return { live: 'is-ok', ok: 'is-ok', warn: 'is-warn', bad: 'is-bad', done: 'is-info' }[toneOf(status)] || '';
  }

  function pill(status, label) {
    return `<span class="sc-pill is-${toneOf(status)}">${esc(label || status)}</span>`;
  }

  function dot(status) {
    return `<span class="sc-dot is-${toneOf(status)}"></span>`;
  }

  // The card head: icon, name over a subtitle (pre-escaped HTML), the status
  // pill. All spans, so it may sit inside a <button>.
  function head({ icon, iconTitle, name, sub, subTitle, status, label }) {
    return `<span class="sc-head"><span class="sc-icon"${iconTitle ? ` title="${esc(iconTitle)}"` : ''}>${icon}</span>`
      + `<span class="sc-title"><span class="sc-name" title="${esc(name)}">${esc(name)}</span>`
      + (sub ? `<span class="sc-sub"${subTitle != null ? ` title="${esc(subTitle)}"` : ''}>${sub}</span>` : '')
      + '</span>' + pill(status, label) + '</span>';
  }

  // The app or directory a session runs in: the path's last part, the full
  // path on hover.
  function dirName(cwd) {
    return String(cwd || '').replace(/\/+$/, '').split('/').pop() || cwd || '';
  }

  // Card names: the project (the cwd's basename), numbered when several
  // cards share it, by start time: `p`, `p 2`, `p 3`. entries: [{ key, cwd,
  // startedAt }] (runs and sessions alike); returns a Map key -> name. An
  // entry without a cwd gets no entry in the map, the caller keeps its own name.
  function projectNames(entries) {
    const byProject = new Map();
    entries.forEach((e, i) => {
      const project = e.cwd ? dirName(e.cwd) : '';
      if (!project) return;
      if (!byProject.has(project)) byProject.set(project, []);
      byProject.get(project).push({ key: e.key, at: e.startedAt || 0, i });
    });
    const names = new Map();
    for (const [project, list] of byProject) {
      list.sort((a, b) => a.at - b.at || a.i - b.i);
      list.forEach((e, n) => names.set(e.key, n ? `${project} ${n + 1}` : project));
    }
    return names;
  }

  function dirHtml(cwd) {
    if (!cwd) return '';
    return `<span class="sc-dir" title="${esc(cwd)}">${esc(dirName(cwd))}</span>`;
  }

  // 950, 12.4k, 3.1M.
  function tokens(n) {
    if (!n) return '0';
    if (n < 1000) return String(n);
    if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`;
    return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
  }

  // A TODO row's icon by its status word (free text may follow the word).
  function todoKind(status) {
    const s = String(status || '').toLowerCase();
    if (/^(done|complete|finished|merged|✓|✔)/.test(s)) return { kind: 'done', icon: '✓' };
    if (/^(doing|in[ _-]?progress|wip|active|started|running)/.test(s)) return { kind: 'doing', icon: '▸' };
    if (/^(blocked|paused|waiting)/.test(s)) return { kind: 'blocked', icon: '!' };
    if (/^(failed|error)/.test(s)) return { kind: 'failed', icon: '✗' };
    if (/^(dropped|skipped|cancel)/.test(s)) return { kind: 'dropped', icon: '–' };
    return { kind: 'queued', icon: '○' };
  }

  // The last TODO rows with a progress bar: `todo` is { done, total, rows }.
  function todoList(todo) {
    if (!todo?.rows?.length) return '';
    const pct = todo.total ? Math.round((todo.done / todo.total) * 100) : 0;
    const head = todo.total
      ? `<div class="sc-todo-head"><span>TODO</span><span class="sc-progress"><span style="width:${pct}%"></span></span><span>${todo.done}/${todo.total}</span></div>`
      : '';
    const rows = todo.rows.map(r => {
      const k = todoKind(r.status);
      return `<li class="sc-todo-row is-${k.kind}" title="${esc(`${r.id}: ${r.description}\n${r.status}`)}">`
        + `<span class="sc-todo-icon">${k.icon}</span>`
        + `<span class="sc-todo-id">${esc(r.id)}</span>`
        + `<span class="sc-todo-desc">${esc(r.description || '')}</span>`
        + `<span class="sc-todo-status">${esc(String(r.status || '').split(/\s/)[0])}</span></li>`;
    }).join('');
    return `<div class="sc-todo">${head}<ul>${rows}</ul></div>`;
  }

  // The worker list: each item is { name, state, detail, aside, title, attrs }
  // — `aside` sits at the row's end (a cost), `attrs` (pre-escaped) makes a
  // row clickable.
  function workerList(items, heading) {
    if (!items.length) return '';
    const rows = items.map(w => {
      const tag = w.attrs ? 'button' : 'div';
      return `<li class="sc-worker">`
        + `<${tag} class="sc-worker-main"${w.attrs ? ` type="button" ${w.attrs}` : ''}${w.title ? ` title="${esc(w.title)}"` : ''}>`
        + dot(w.state)
        + `<span class="sc-worker-name">${esc(w.name)}</span>`
        + pill(w.state)
        + (w.detail ? `<span class="sc-worker-detail">${esc(w.detail)}</span>` : '')
        + (w.aside ? `<span class="sc-worker-aside">${esc(w.aside)}</span>` : '')
        + `</${tag}>`
        + '</li>';
    }).join('');
    return `<div class="sc-workers">${heading ? `<div class="sc-section-head">${esc(heading)}</div>` : ''}<ul>${rows}</ul></div>`;
  }

  const api = { relTime, timeHtml, toneOf, accentOf, pill, dot, head, dirName, projectNames, dirHtml, tokens, todoKind, todoList, workerList };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.sessionCards = api;
})();
