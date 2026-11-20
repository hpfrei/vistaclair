// Capability: todos — `todos.list/create/complete/…` — platform-owned user todos/reminders (life data)
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.

const { req } = require('../horst-facet');

// todo.update — the four acts a todo card offers, and the fields `edit` sets.
const TODO_ACTIONS = ['complete', 'snooze', 'reopen', 'edit'];
const EDIT_FIELDS = ['title', 'notes', 'dueAt'];

const iso = (v) => (v == null ? null : new Date(v).toISOString());

// The act that puts a todo back the way `before` had it, or null when there is
// no exact one. A recurring todo is left without: completing it inserts the
// next occurrence, which a reopen would not take back (and the reverse).
function todoInverse(p, before) {
  const id = Number(p.id);
  const undo = (payload) => ({ kind: 'todo.update', payload: { id, ...payload }, summary: `Undo: ${before.title}` });
  if (p.action === 'complete') return before.status === 'open' && !before.recurrence ? undo({ action: 'reopen' }) : null;
  if (p.action === 'reopen') return before.status === 'done' && !before.recurrence ? undo({ action: 'complete' }) : null;
  if (p.action === 'snooze') {
    if (before.snoozedUntil && new Date(before.snoozedUntil) > new Date()) return undo({ action: 'snooze', until: iso(before.snoozedUntil) });
    // Setting the due date clears a snooze (tasks-engine update), so an
    // unsnoozed todo with a due date is restored exactly; without one, a
    // snooze that has already run out is the same thing.
    if (before.dueAt) return undo({ action: 'edit', dueAt: iso(before.dueAt) });
    return undo({ action: 'snooze', until: new Date().toISOString() });
  }
  const prev = {};
  for (const f of EDIT_FIELDS) {
    if (p[f] === undefined) continue;
    prev[f] = f === 'dueAt' ? iso(before.dueAt) : (before[f] ?? null);
  }
  if (prev.title === null) delete prev.title;
  return Object.keys(prev).length ? undo({ action: 'edit', ...prev }) : null;
}

// Caller stamped server-side — apps can't spoof another app's rows.
async function todosOp(app, params, io) {
  const tasks = require('../tasks-engine');
  const op = io.method.split('.')[1];
  const appName = app.name;
  if (op === 'create') return tasks.create({ ...params, source: { type: 'app', app: appName } }, appName);
  if (op === 'get') return tasks.get(params.id, appName);
  if (op === 'update') return tasks.update(params.id, params, appName);
  if (op === 'complete') return tasks.complete(params.id, appName, params.resolution);
  if (op === 'snooze') return tasks.snooze(params.id, params, appName);
  if (op === 'reopen') return tasks.reopen(params.id, appName);
  if (op === 'delete') return tasks.remove(params.id, appName);
  if (op === 'counts') return tasks.counts(appName);
  if (op === 'similar') return tasks.similar(params.title, params, appName);
  return tasks.list(params || {}, appName);
}

module.exports = {
  key: 'todos',
  title: 'Todos Engine',
  core: false,
  gated: true,
  methods: ['todos.list', 'todos.get', 'todos.create', 'todos.update', 'todos.complete', 'todos.snooze', 'todos.reopen', 'todos.delete', 'todos.counts', 'todos.similar', 'todos.subscribe'],
  prefixes: ['todos.'],
  ctx: ['todos'],
  keywords: /\b(todo|to-do|reminder|remind me|task list|checklist)\b/i,
  summary: '`todos.list/create/complete/…` — platform-owned user todos/reminders',
  migration: 'App-local todo/reminder tables → the platform store `todos.*` / `ctx.todos.*`. `ctx.jobs` (background work an app runs) is NOT this.',

  buildCtx(app) {
    const name = app.name;
    const T = () => require('../tasks-engine');
    // Platform todos engine — user todos/reminders (life data; NOT ctx.jobs).
    return {
      todos: {
        list: (params) => T().list(params || {}, name),
        get: (id) => T().get(id, name),
        create: (params) => T().create({ ...params, source: { type: 'app', app: name } }, name),
        update: (id, fields) => T().update(id, fields, name),
        complete: (id, resolution) => T().complete(id, name, resolution),
        snooze: (id, params) => T().snooze(id, params, name),
        reopen: (id) => T().reopen(id, name),
        delete: (id) => T().remove(id, name),
        counts: () => T().counts(name),
        similar: (title, params) => T().similar(title, params, name),
        // Todo events (todo:changed) share the one engine bus.
        on: (event, handler) => require('../email-engine').registerHandler(name, event, handler),
        subscribe: (events) => require('../email-engine').subscribe(name, events),
      },
    };
  },

  bridge: {
    'todos.list': todosOp,
    'todos.get': todosOp,
    'todos.create': todosOp,
    'todos.update': todosOp,
    'todos.complete': todosOp,
    'todos.snooze': todosOp,
    'todos.reopen': todosOp,
    'todos.delete': todosOp,
    'todos.counts': todosOp,
    'todos.similar': todosOp,
    // Todo events (todo:changed) ride the one engine bus, like calendar.
    'todos.subscribe': async (app, params) => require('../email-engine').subscribe(app.name, params.events),
  },

  // ---- Horst facet: one kind, no tool, no sense ------------------------------
  // Deliberately sparse, and each absence is a decision:
  //
  //   No tool. `todo_list` already exists as a brain pull tool
  //   (horst-brain.js:206, expose: 'platform'), and the todos brain pushes a
  //   due-taster into every digest. A second reader here would be the exact
  //   duplicate duty phase 8 exists to remove.
  //
  //   No sense. `todo:changed` fires on every write INCLUDING Horst's own
  //   approved `todo.create`, so publishing it would feed him his own actions
  //   as news — the failure the calendar sense filters by origin. Nothing else
  //   in the todo lifecycle is news he does not already hold: the due taster is
  //   in the digest before he thinks.
  horst: {
    lane: {
      direct: {
        'todos.list': 'todo_list', 'todos.get': 'todo_list', 'todos.counts': 'todo_list', 'todos.similar': 'todo_list',
      },
      card: {
        'todos.create': 'todo.create',
        'todos.update': 'todo.update', 'todos.complete': 'todo.update', 'todos.snooze': 'todo.update',
        'todos.reopen': 'todo.update', 'todos.delete': 'todo.update',
      },
      never: ['todos.subscribe'],
      why: 'todos.subscribe is an app\'s live feed',
    },
    brief: 'todos: the user\'s todo/reminder list — Horst reads it through the todos brain and can propose additions (todo.create) and changes (todo.update)',
    kinds: {
      'todo.create': {
        label: 'Create todo',
        about: 'Adds a todo/reminder to your list — typically a payment deadline or follow-up Horst spotted in an email.',
        ceiling: 'auto', // inward-facing and undoable; content-derived, so it defaults to a proposal (G9)
        defaultLevel: 'propose',
        notify: 'none', // reviewed in the Approvals views, not pushed
        validate(p) {
          req(p, 'title');
          if (p.dueAt != null && isNaN(new Date(p.dueAt))) throw new Error(`invalid dueAt: ${p.dueAt}`);
          if (p.discharge != null && !require('../governance/horst-identity').DISCHARGE.has(p.discharge)) {
            throw new Error(`invalid discharge: ${p.discharge}`);
          }
        },
        describe: (p) => `Add todo "${p.title}"${p.dueAt ? ` (due ${p.dueAt})` : ''}`,
        // The todo itself is the act; the mail that suggested it is not part of
        // its identity, so the same follow-up mentioned in three messages is one
        // card. The account comes from provenance (a todo payload has no mailbox).
        //
        // Except when replying IS the act. Then the todo and the reply draft that
        // would discharge it are one act with two representations, and they get
        // one identity — so approving the draft retires the todo telling you to
        // write it, and the pair can never sit in the queue together. G9:
        // `discharge` comes from untrusted mail, but it can only ever collapse
        // this inward-facing card into an existing one. It cannot create, raise a
        // dial, or reach an outward kind.
        identity: (p, meta) => {
          const ident = require('../governance/horst-identity');
          const src = meta?.source || {};
          if (p.discharge === 'reply' && (src.threadId || src.messageId)) {
            return ident.replyKey({
              account: src.account, threadId: src.threadId, inReplyTo: src.messageId, subject: src.subject,
            });
          }
          return ident.todoKey({ account: src.account, title: p.title, dueAt: p.dueAt });
        },
        execute: (p, proposal) => require('../tasks-engine').create({
          title: p.title, notes: p.notes || null, dueAt: p.dueAt || null,
          recurrence: p.recurrence || null, watch: p.watch || null,
          source: { type: 'proposal', proposalId: proposal?.id || null, app: proposal?.app || 'horst' },
        }, 'horst').then((t) => ({ ok: true, summary: `Todo #${t.id} added: ${t.title}` })),
      },

      'todo.update': {
        label: 'Update todo',
        about: 'Completes, snoozes, reopens or edits (title, notes, due) one todo on your list.',
        ceiling: 'auto', // inward-facing; the executor records the previous state for its undo
        defaultLevel: 'propose',
        undo: true,
        validate(p) {
          req(p, 'id', 'any');
          if (!Number.isInteger(Number(p.id)) || Number(p.id) <= 0) throw new Error(`invalid todo id: ${p.id}`);
          if (!TODO_ACTIONS.includes(p.action)) throw new Error(`action must be one of ${TODO_ACTIONS.join('|')} (got "${p.action}")`);
          if (p.action === 'snooze') {
            if (p.until != null) { if (isNaN(new Date(p.until))) throw new Error(`invalid until: ${p.until}`); }
            else if (!p.preset) throw new Error('snooze needs until (ISO date-time) or preset (e.g. "2h", "1d")');
          }
          if (p.action === 'edit') {
            const fields = EDIT_FIELDS.filter((f) => p[f] !== undefined);
            if (!fields.length) throw new Error(`edit needs at least one of ${EDIT_FIELDS.join(', ')}`);
            if (p.title !== undefined && !String(p.title || '').trim()) throw new Error('title cannot be empty');
            if (p.dueAt != null && isNaN(new Date(p.dueAt))) throw new Error(`invalid dueAt: ${p.dueAt}`);
          }
        },
        describe: (p) => {
          if (p.action === 'snooze') return `Snooze todo #${p.id} ${p.until ? `until ${p.until}` : `for ${p.preset}`}`;
          if (p.action === 'edit') return `Edit todo #${p.id}: ${EDIT_FIELDS.filter((f) => p[f] !== undefined).map((f) => `${f} → ${p[f] ?? 'none'}`).join(', ')}`;
          return `${p.action === 'complete' ? 'Complete' : 'Reopen'} todo #${p.id}`;
        },
        identity: (p) => require('../governance/horst-identity').objectKey('todoupd', {
          id: `${p.id}:${p.action}:${p.action === 'snooze' ? p.until || p.preset : p.action === 'edit' ? EDIT_FIELDS.map((f) => p[f] ?? '').join('|') : ''}`,
        }),
        // The act itself is platform-horst's todoAction — the same code the
        // Telegram todo buttons run — reached through a launcher (a capability
        // may not require platform-horst). What is read here is only the state
        // the act replaces, so the undo is exact.
        async execute(p, proposal, helpers) {
          const act = helpers?.launcher?.('todo.update');
          if (!act) throw new Error('todo launcher not registered');
          const before = await require('../tasks-engine').get(Number(p.id), 'horst');
          if (!before) throw new Error(`Todo ${p.id} not found`);
          const arg = p.action === 'snooze' ? (p.until ? { until: p.until } : { preset: p.preset })
            : p.action === 'edit' ? Object.fromEntries(EDIT_FIELDS.filter((f) => p[f] !== undefined).map((f) => [f, p[f]]))
              : undefined;
          const summary = await act(Number(p.id), p.action === 'complete' ? 'done' : p.action, arg);
          const inverse = todoInverse(p, before);
          return { ok: true, summary, ...(inverse ? { inverse } : {}) };
        },
      },
    },
  },
};
