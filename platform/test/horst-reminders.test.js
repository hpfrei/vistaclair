// Event reminders stay TRUE over time: the message is edited in place as the
// event approaches, starts, runs and ends; a move or a cancellation shows at
// once; tracking survives a restart; nothing is edited when nothing changed.
// Fake clock, fake calendar, fake Telegram — no network, no database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const reminders = require('../src/apps/agent/horst-reminders');

const T0 = Date.parse('2026-09-24T13:50:00Z');
const MIN = 60e3;

function harness({ lead = 15, enabled = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-reminders-'));
  const h = {
    dir,
    t: T0,
    events: new Map(), // eventId → event
    sent: [],          // { chatId, text, messageId }
    edits: [],         // { message_id, text }
    settings: { eventReminders: enabled, eventLeadMinutes: lead },
    nextId: 100,
    editReply: null,   // override the Telegram answer to editMessageText
  };
  h.event = (id, startIso, endIso, extra = {}) => {
    h.events.set(id, {
      id, _account: 'me@example.com', summary: `Event ${id}`,
      start: { dateTime: startIso }, end: { dateTime: endIso }, ...extra,
    });
  };
  h.boot = () => reminders.init({
    dir,
    now: () => h.t,
    timeZone: 'UTC',
    getSettings: () => h.settings,
    controlChatId: () => 42,
    sendControlMessage: async (chatId, text) => {
      const messageId = h.nextId++;
      h.sent.push({ chatId, text, messageId });
      return [{ messageId, text }];
    },
    telegram: {
      call: async (method, params) => {
        assert.equal(method, 'editMessageText');
        if (h.editReply) return h.editReply;
        h.edits.push({ message_id: params.message_id, text: params.text });
        return { ok: true };
      },
    },
    calendarEngine: {
      listEvents: async ({ timeMin, timeMax }) => ({
        events: [...h.events.values()].filter((e) => {
          if (e._cancelled) return false;
          const s = Date.parse(e.start.dateTime || `${e.start.date}T00:00:00Z`);
          return s >= Date.parse(timeMin) && s <= Date.parse(timeMax);
        }),
      }),
      getEvent: async ({ eventId }) => h.events.get(eventId) || null,
    },
  });
  h.at = (iso) => { h.t = Date.parse(iso); };
  h.lastEdit = () => h.edits[h.edits.length - 1]?.text;
  h.boot();
  return h;
}

const relLine = (text) => text.split('\n').pop();

test('the render sequence: countdown, starting now, started, ended — then untracked', async () => {
  const h = harness();
  h.event('a', '2026-09-24T14:00:00Z', '2026-09-24T15:00:00Z', { location: 'Room 1' });

  await reminders.tick();
  assert.equal(h.sent.length, 1);
  const first = h.sent[0].text;
  assert.match(first, /🔔 Event a/);
  assert.match(first, /🕑 Thu 24 Sep · 14:00–15:00/, 'the absolute range is always shown');
  assert.match(first, /📍 Room 1/);
  assert.equal(relLine(first), '⏳ starts in 10 min');

  h.at('2026-09-24T13:55:30Z');
  await reminders.tick();
  assert.equal(relLine(h.lastEdit()), '⏳ starts in 5 min');

  h.at('2026-09-24T14:00:10Z');
  await reminders.tick();
  assert.equal(relLine(h.lastEdit()), '▶ starting now');

  h.at('2026-09-24T14:20:00Z');
  await reminders.tick();
  assert.equal(relLine(h.lastEdit()), '▶ started 14:00 · ends 15:00');
  assert.match(h.lastEdit(), /14:00–15:00/, 'the range survives every edit');

  h.at('2026-09-24T15:01:00Z');
  await reminders.tick();
  assert.equal(relLine(h.lastEdit()), '✔ ended 15:00');
  assert.equal(reminders.tracked().length, 0, 'an ended reminder is no longer tracked');

  const edits = h.edits.length;
  h.at('2026-09-24T15:30:00Z');
  await reminders.tick();
  assert.equal(h.edits.length, edits, 'nothing more happens to it');
  assert.equal(h.sent.length, 1, 'and it is never sent again');
  assert.ok(h.edits.every((e) => e.message_id === h.sent[0].messageId), 'every edit targets the one message');
});

test('all-day events and events beyond the lead window get no reminder', async () => {
  const h = harness();
  h.events.set('day', { id: 'day', _account: 'me@example.com', summary: 'Holiday', start: { date: '2026-09-24' }, end: { date: '2026-09-25' } });
  h.event('later', '2026-09-24T16:00:00Z', '2026-09-24T17:00:00Z');
  await reminders.tick();
  assert.equal(h.sent.length, 0);
});

test('no edit when the text is unchanged', async () => {
  const h = harness();
  h.event('a', '2026-09-24T14:00:00Z', '2026-09-24T15:00:00Z');
  await reminders.tick();
  h.at('2026-09-24T13:50:20Z'); // still "starts in 10 min"
  await reminders.tick();
  await reminders.refresh(['a']);
  assert.equal(h.edits.length, 0);
});

test('"message is not modified" is success, not a retry loop', async () => {
  const h = harness();
  h.event('a', '2026-09-24T14:00:00Z', '2026-09-24T15:00:00Z');
  await reminders.tick();
  h.editReply = { ok: false, description: 'Bad Request: message is not modified' };
  h.at('2026-09-24T13:55:00Z');
  await reminders.tick();
  assert.equal(relLine(reminders.tracked()[0].text), '⏳ starts in 5 min', 'recorded as delivered');
});

test('moved inside the window: the same message says so and keeps counting', async () => {
  const h = harness();
  h.event('a', '2026-09-24T14:00:00Z', '2026-09-24T15:00:00Z');
  await reminders.tick();
  h.event('a', '2026-09-24T14:05:00Z', '2026-09-24T15:05:00Z');
  const r = await reminders.refresh(['a'], 'me@example.com');
  assert.equal(r.edited, 1, 'calendar:changed edits at once');
  const text = h.lastEdit();
  assert.match(text, /14:05–15:05/);
  assert.match(text, /⚠ moved to 14:05/);
  assert.equal(relLine(text), '⏳ starts in 15 min');
  assert.equal(h.sent.length, 1, 'no second message for the moved event');
  await reminders.tick();
  assert.equal(h.sent.length, 1);
});

test('moved beyond the window: closed with the new time, and a fresh reminder follows', async () => {
  const h = harness();
  h.event('a', '2026-09-24T14:00:00Z', '2026-09-24T15:00:00Z');
  await reminders.tick();
  h.event('a', '2026-09-24T17:00:00Z', '2026-09-24T18:00:00Z');
  await reminders.tick();
  assert.match(h.lastEdit(), /⚠ moved to 17:00 — a new reminder will follow/);
  assert.match(h.lastEdit(), /17:00–18:00/);
  assert.equal(reminders.tracked().length, 0);
  assert.equal(h.sent.length, 1);

  h.at('2026-09-24T16:50:00Z');
  await reminders.tick();
  assert.equal(h.sent.length, 2, 'the new start comes due and gets its own reminder');
  assert.equal(relLine(h.sent[1].text), '⏳ starts in 10 min');
  assert.doesNotMatch(h.sent[1].text, /moved/, 'the fresh reminder is a plain one');
});

test('moved away and back again: the promised fresh reminder still comes', async () => {
  const h = harness();
  h.event('a', '2026-09-24T14:00:00Z', '2026-09-24T15:00:00Z');
  await reminders.tick();
  h.event('a', '2026-09-24T17:00:00Z', '2026-09-24T18:00:00Z');
  await reminders.refresh(['a']);
  h.event('a', '2026-09-24T14:00:00Z', '2026-09-24T15:00:00Z');
  h.at('2026-09-24T13:52:00Z');
  await reminders.tick();
  assert.equal(h.sent.length, 2);
  assert.equal(relLine(h.sent[1].text), '⏳ starts in 8 min');
});

test('cancelled or deleted: "❌ cancelled", then untracked', async () => {
  const h = harness();
  h.event('a', '2026-09-24T14:00:00Z', '2026-09-24T15:00:00Z');
  h.event('b', '2026-09-24T14:02:00Z', '2026-09-24T15:00:00Z');
  await reminders.tick();
  assert.equal(h.sent.length, 2);
  h.events.get('a')._cancelled = true;
  h.events.delete('b');
  await reminders.refresh(['a', 'b']);
  const texts = h.edits.map((e) => e.text);
  assert.equal(texts.length, 2);
  for (const t of texts) assert.equal(relLine(t), '❌ cancelled');
  assert.equal(reminders.tracked().length, 0);
});

test('dedupe across a restart: tracking is on disk, the reminder is not sent twice', async () => {
  const h = harness();
  h.event('a', '2026-09-24T14:00:00Z', '2026-09-24T15:00:00Z');
  await reminders.tick();
  assert.ok(fs.existsSync(path.join(h.dir, 'event-reminders.json')));
  assert.ok(!fs.existsSync(path.join(h.dir, 'event-reminders.json.tmp')), 'written atomically');

  h.boot(); // a fresh process: same dir, nothing in memory
  h.at('2026-09-24T13:52:00Z');
  await reminders.tick();
  assert.equal(h.sent.length, 1, 'not re-sent after the restart');
  assert.equal(h.edits.length, 1, 'but still kept true');
  assert.equal(h.edits[0].message_id, h.sent[0].messageId);
  assert.equal(relLine(h.edits[0].text), '⏳ starts in 8 min');
});

test('reminders off: nothing new is sent, but a sent one is still kept true', async () => {
  const h = harness();
  h.event('a', '2026-09-24T14:00:00Z', '2026-09-24T15:00:00Z');
  await reminders.tick();
  h.settings.eventReminders = false;
  h.event('b', '2026-09-24T14:01:00Z', '2026-09-24T15:00:00Z');
  h.at('2026-09-24T13:55:00Z');
  await reminders.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(relLine(h.lastEdit()), '⏳ starts in 5 min');
});

test('a message Telegram no longer has is dropped instead of retried forever', async () => {
  const h = harness();
  h.event('a', '2026-09-24T14:00:00Z', '2026-09-24T15:00:00Z');
  await reminders.tick();
  h.editReply = { ok: false, description: 'Bad Request: message to edit not found' };
  h.at('2026-09-24T13:55:00Z');
  await reminders.tick();
  assert.equal(reminders.tracked().length, 0);
});
