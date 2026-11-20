// Horst chat parity: the kinds chat stages for the acts a card or an app
// already offers (tags, spam rules, calendar guests, todo edits). Two things
// are pinned. A bad payload is refused at the freeze point with a message the
// model can act on. An executed act records its exact inverse, and staging
// that inverse (what the undo button does, stageUndo) puts the state back.
// Throwaway dirs and in-memory stubs: no database, no Google, no Telegram.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const capabilities = require('../src/apps/capabilities');
const governance = require('../src/apps/governance/horst-governance');
const emailEngine = require('../src/apps/email-engine');
const calendarEngine = require('../src/apps/calendar-engine');
const tasksEngine = require('../src/apps/tasks-engine');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-parity-'));
emailEngine.init(tmp, null, null); // label + rule files live here
governance.registerPlatformKinds(capabilities.horstKinds());
governance.init({ dir: path.join(tmp, '.horst'), broadcaster: { broadcast() {} } });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const kind = (name) => governance.kindDef(name);

// Approve through governance, return the stored proposal.
async function run(kindName, payload) {
  const p = await governance.createProposal(kindName, payload, { origin: 'chat' });
  assert.equal(p.status, 'pending', `${kindName} waits for approval when staged from chat`);
  await governance.decide(p.id, 'approve', 'ui');
  const done = governance.getProposal(p.id);
  assert.equal(done.status, 'executed', `${kindName} executed: ${done.error || ''}`);
  return done;
}

// What the undo button does (platform-horst stageUndo), without the host.
async function undo(executed) {
  const inv = executed.result.inverse;
  assert.ok(inv && inv.kind && inv.payload, `${executed.kind} recorded an inverse`);
  return run(inv.kind, inv.payload);
}

// --- refusals ------------------------------------------------------------------

test('email.tags.set: an unknown tag name is refused, listing the valid tags', () => {
  emailEngine.addLabel({ name: 'Bills' });
  emailEngine.addLabel({ name: 'Travel' });
  assert.throws(
    () => kind('email.tags.set').validate({ account: 'me@example.com', uid: '7', add: ['Invoices'] }),
    /unknown tag "Invoices" \(valid tags: .*Bills.*Travel/,
  );
  assert.throws(() => kind('email.tags.set').validate({ account: 'me@example.com', uid: '7' }), /add or remove/);
  assert.throws(() => kind('email.tags.set').validate({ account: 'me@example.com', uid: '7', add: ['Bills'], remove: ['bills'] }), /both added and removed/);
  assert.doesNotThrow(() => kind('email.tags.set').validate({ account: 'me@example.com', uid: '7', add: ['bills'] }), 'names match case-insensitively');
});

test('calendar.create / calendar.update refuse attendees: guests are calendar.invite', (t) => {
  t.mock.method(calendarEngine, 'calendarAccounts', () => ['me@example.com']);
  const guests = { attendees: ['guest@example.org'] };
  assert.throws(() => kind('calendar.create').validate({ title: 'Lunch', date: '2026-10-01', ...guests }), /calendar\.create does not take attendees.*calendar\.invite/);
  assert.throws(() => kind('calendar.update').validate({ eventId: 'e1', ...guests }), /calendar\.update does not take attendees/);
  assert.throws(() => kind('calendar.update').validate({ eventId: 'e1', sendUpdates: 'all' }), /does not notify guests/);
  assert.doesNotThrow(() => kind('calendar.create').validate({ title: 'Lunch', date: '2026-10-01' }));
  // The invite kind takes them, and only real addresses.
  assert.doesNotThrow(() => kind('calendar.invite').validate({ eventId: 'e1', ...guests }));
  assert.throws(() => kind('calendar.invite').validate({ eventId: 'e1', attendees: ['not an address'] }), /not an email address/);
  assert.throws(() => kind('calendar.invite').validate({ eventId: 'e1', attendees: [] }), /requires attendees/);
  assert.equal(governance.getDials()['calendar.invite'].ceiling, 'propose');
});

test('calendar.move refuses a move to the calendar it is already in', (t) => {
  t.mock.method(calendarEngine, 'calendarAccounts', () => ['me@example.com']);
  assert.throws(() => kind('calendar.move').validate({ eventId: 'e1', destinationCalendarId: 'primary' }), /already in that calendar/);
});

test('todo.update: a bad action is refused with the valid ones', () => {
  assert.throws(() => kind('todo.update').validate({ id: 3, action: 'delete' }), /action must be one of complete\|snooze\|reopen\|edit \(got "delete"\)/);
  assert.throws(() => kind('todo.update').validate({ id: 'x', action: 'complete' }), /invalid todo id/);
  assert.throws(() => kind('todo.update').validate({ id: 3, action: 'snooze' }), /until .* or preset/);
  assert.throws(() => kind('todo.update').validate({ id: 3, action: 'edit' }), /at least one of/);
  assert.throws(() => kind('todo.update').validate({ id: 3, action: 'edit', title: '  ' }), /title cannot be empty/);
});

test('email.rule.remove: an unknown id is refused', () => {
  assert.throws(() => kind('email.rule.remove').validate({ id: 'r_nope' }), /no spam rule with id "r_nope"/);
});

// --- undo round-trips ----------------------------------------------------------------

test('email.rule.remove → undo re-adds the same rule', async () => {
  const { rule } = emailEngine.addRule({ type: 'domain', value: 'spam.example' });
  const removed = await run('email.rule.remove', { id: rule.id });
  assert.equal(emailEngine.listRules().some((r) => r.value === 'spam.example'), false);
  assert.equal(removed.result.inverse.kind, 'email.rule.add');
  await undo(removed);
  const back = emailEngine.listRules().find((r) => r.value === 'spam.example');
  assert.ok(back && back.type === 'domain', 'the rule is back, same type and value');
});

test('email.tags.set → undo removes only what the edit added', async (t) => {
  const labels = emailEngine.listLabels();
  const idOf = (name) => labels.find((l) => l.name === name).id;
  const on = new Set([idOf('Travel')]); // already tagged Travel
  t.mock.method(emailEngine, 'tagsOf', async () => labels.filter((l) => on.has(l.id)));
  t.mock.method(emailEngine, 'setTags', async (account, uid, { add = [], remove = [] }) => {
    for (const id of add) on.add(id);
    for (const id of remove) on.delete(id);
  });
  const edited = await run('email.tags.set', { account: 'me@example.com', uid: '7', add: ['Bills', 'Travel'] });
  assert.deepEqual([...on].sort(), [idOf('Bills'), idOf('Travel')].sort());
  assert.deepEqual(edited.result.inverse.payload.remove, ['Bills'], 'Travel was already there, so its undo leaves it');
  await undo(edited);
  assert.deepEqual([...on], [idOf('Travel')]);
});

test('todo.update → undo restores the previous state (complete, edit, snooze)', async (t) => {
  const todos = new Map([[3, { id: 3, title: 'Pay rent', status: 'open', notes: null, dueAt: '2026-10-01T09:00:00.000Z', snoozedUntil: null, recurrence: null }]]);
  t.mock.method(tasksEngine, 'get', async (id) => ({ ...todos.get(Number(id)) }));
  // The launcher stands in for platform-horst's todoAction (the TG buttons' code).
  governance.registerLauncher('todo.update', async (id, action, arg) => {
    const td = todos.get(id);
    if (action === 'done') td.status = 'done';
    else if (action === 'reopen') td.status = 'open';
    else if (action === 'snooze') td.snoozedUntil = arg.until;
    else if (action === 'edit') { Object.assign(td, arg); if (arg.dueAt !== undefined) td.snoozedUntil = null; }
    return `todo ${id}: ${action}`;
  });

  const completed = await run('todo.update', { id: 3, action: 'complete' });
  assert.equal(todos.get(3).status, 'done');
  await undo(completed);
  assert.equal(todos.get(3).status, 'open');

  const edited = await run('todo.update', { id: 3, action: 'edit', title: 'Pay the rent', dueAt: '2026-10-02T09:00:00Z' });
  assert.equal(todos.get(3).title, 'Pay the rent');
  await undo(edited);
  assert.equal(todos.get(3).title, 'Pay rent');
  assert.equal(new Date(todos.get(3).dueAt).toISOString(), '2026-10-01T09:00:00.000Z');

  const snoozed = await run('todo.update', { id: 3, action: 'snooze', until: '2026-12-01T09:00:00Z' });
  assert.equal(todos.get(3).snoozedUntil, '2026-12-01T09:00:00Z');
  await undo(snoozed);
  assert.equal(todos.get(3).snoozedUntil, null, 'an unsnoozed todo with a due date gets its due date back, which clears the snooze');

  // A recurring todo has no exact undo for complete: none is recorded.
  todos.get(3).recurrence = { freq: 'week' };
  const recurring = await run('todo.update', { id: 3, action: 'complete' });
  assert.equal(recurring.result.inverse, undefined);
});
