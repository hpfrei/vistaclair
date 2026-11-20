// One card definition, three surfaces.
//
// The claim under test is a floor, not a feature: EVERY registered kind renders
// a real card on every surface. Before this, only email.send and the calendar
// create/update pair had a Telegram rendering and a GUI card — todo.create,
// mission.create and every app-registered kind reached the user as
// raw JSON. The per-kind `tgCard` seam that was supposed to fix it was fully
// plumbed and never once used by any kind in the repo.
const test = require('node:test');
const assert = require('node:assert/strict');

const cards = require('../src/apps/governance/horst-cards');
const governance = require('../src/apps/governance/horst-governance');
const capabilities = require('../src/apps/capabilities');

const platform = capabilities.horstKinds();
governance.registerPlatformKinds(platform);

// Every kind the platform knows: governance's own three plus every capability
// module's. Iterated rather than hand-listed, so a kind added later is covered
// the day it is added.
const ALL_KINDS = [...Object.keys(governance.KINDS), ...Object.keys(platform)];

// A payload with something plausible for every family, so a card has material
// to render whichever kind is asked.
const SAMPLE = {
  account: 'hp@gmx.ch',
  to: 'anna@example.org',
  subject: 'Rechnung 4711',
  body: 'Guten Tag,\n\n> quoted line\n\nvielen Dank.',
  title: 'Physiotherapy',
  date: '2026-09-12',
  startTime: '10:00',
  endTime: '11:00',
  location: 'Bahnhofstrasse 1',
  attendees: ['anna@example.org'],
  text: 'a telegram message',
  chatId: 42,
  uid: 122,
  eventId: 'ev-1',
  dueAt: '2026-09-30T09:00',
  notes: 'from an email',
  discharge: 'reply',
  value: 'spam@example.org',
  type: 'sender',
  name: 'my-dashboard',
  enabled: true,
  nested: { a: 1, b: [2, 3] },
};

const proposalFor = (kind) => ({ id: 'p-1', kind, summary: `Summary for ${kind}`, payload: { ...SAMPLE } });

function assertValidCard(card, label) {
  assert.ok(card, `${label}: no card at all`);
  assert.equal(typeof card.title, 'string');
  assert.ok(card.title.length, `${label}: a card with no title is not a card`);
  assert.ok(card.icon, `${label}: no icon`);
  assert.ok(Array.isArray(card.fields), `${label}: fields must be an array`);
  for (const f of card.fields) {
    assert.ok(cards.FIELD_KINDS.has(f.kind), `${label}: field kind "${f.kind}" is outside the closed set`);
    assert.ok(typeof f.label === 'string', `${label}: field has no label`);
    if (f.kind === 'chips' || f.kind === 'address') assert.ok(Array.isArray(f.value), `${label}: ${f.kind} value must be an array`);
    else if (f.kind === 'bool') assert.equal(typeof f.value, 'boolean');
    else assert.equal(typeof f.value, 'string', `${label}: ${f.kind} value must be a string`);
  }
}

// --- the floor ----------------------------------------------------------------

test('EVERY registered kind renders a real card — none falls through to raw JSON', () => {
  assert.ok(ALL_KINDS.length >= 20, `expected the full kind set, got ${ALL_KINDS.length}`);
  for (const kind of ALL_KINDS) {
    const card = cards.cardFor(governance.kindDef(kind), proposalFor(kind));
    assertValidCard(card, kind);
    // The regression that motivated the step: these three rendered as a JSON
    // dump on every surface.
    assert.notEqual(card.title, '{', `${kind} still renders as raw JSON`);
  }
});

test('every kind also projects to Telegram text', () => {
  for (const kind of ALL_KINDS) {
    const text = cards.textCard(cards.cardFor(governance.kindDef(kind), proposalFor(kind)));
    assert.ok(typeof text === 'string' && text.trim().length, `${kind} produced no text card`);
    assert.ok(!text.includes('"nested": {'), `${kind} leaked a raw JSON payload into Telegram`);
  }
});

test('the kinds that used to be JSON now have real cards', () => {
  const todo = cards.cardFor(governance.kindDef('todo.create'), proposalFor('todo.create'));
  assert.equal(todo.render, 'todo');
  assert.equal(todo.title, 'Physiotherapy');
  assert.ok(todo.fields.some((f) => f.label === 'Due' && f.kind === 'when'));

  const mission = cards.cardFor(governance.kindDef('mission.create'), proposalFor('mission.create'));
  assert.equal(mission.render, 'generic');
  assert.ok(mission.fields.length, 'the generic card must still carry labelled fields');
});

// --- the families -------------------------------------------------------------

test('email and calendar cards carry the fields the decision depends on', () => {
  const email = cards.cardFor(governance.kindDef('email.send'), proposalFor('email.send'));
  assert.equal(email.render, 'email');
  const to = email.fields.find((f) => f.label === 'To');
  assert.deepEqual(to.value, ['anna@example.org']);
  assert.equal(to.kind, 'address');
  // Irreversibility is stated on the card, rather than a surface offering an
  // undo button that would lie.
  assert.match(email.warn, /cannot be recalled/i);

  const cal = cards.cardFor(governance.kindDef('calendar.create'), proposalFor('calendar.create'));
  assert.equal(cal.render, 'calendar');
  const when = cal.fields.find((f) => f.kind === 'when');
  assert.ok(when.value.includes('2026-09-12'));
  // The machine-readable twin travels beside the label so a surface can offer
  // "show me that day" without re-parsing a human string.
  assert.equal(when.iso.date, '2026-09-12');
  assert.equal(when.iso.startTime, '10:00');

  const del = cards.cardFor(governance.kindDef('calendar.delete'), proposalFor('calendar.delete'));
  assert.equal(del.accent, 'danger', 'a deletion must be visually distinct from a creation');
});

// The Horst tab used to render email/calendar/telegram with its own renderers,
// which normalised the payload themselves. Those are gone — the tab renders the
// descriptor now — so everything they understood has to be understood HERE, or
// the tab silently renders less than it used to.

test('a Google event body renders a real "When", not a blank one', () => {
  // Two payload shapes reach a calendar card: the flat fields Horst writes, and
  // a raw Google event body. The card understood only `start.date`, so every
  // TIMED Google event rendered an empty When — on the Mini App and in Telegram.
  const p = {
    id: 'p-2',
    kind: 'calendar.create',
    summary: 'Zahnarzt',
    payload: {
      event: {
        summary: 'Zahnarzt',
        location: 'Bahnhofstrasse 1',
        start: { dateTime: '2026-09-12T10:00:00' },
        end: { dateTime: '2026-09-12T11:00:00' },
      },
    },
  };
  const card = cards.cardFor(governance.kindDef('calendar.create'), p);
  const when = card.fields.find((f) => f.kind === 'when');
  assert.ok(when, 'a timed Google event produced no When field at all');
  assert.equal(when.iso.date, '2026-09-12');
  assert.equal(when.iso.startTime, '10:00');
  assert.ok(
    when.value.includes('10:00') && when.value.includes('11:00'),
    `When lost its times: ${when.value}`,
  );
  assert.equal(card.title, 'Zahnarzt');
  assert.equal(card.fields.find((f) => f.label === 'Where').value, 'Bahnhofstrasse 1');
});

test('an offset-bearing Google timestamp still resolves to a date and time', () => {
  const p = {
    id: 'p-3',
    kind: 'calendar.create',
    summary: 'x',
    payload: { event: { summary: 'x', start: { dateTime: '2026-09-12T08:00:00Z' } } },
  };
  const when = cards.cardFor(governance.kindDef('calendar.create'), p).fields.find((f) => f.kind === 'when');
  // Resolved in the SERVER's timezone, so assert the shape rather than a fixed
  // wall-clock value another box would disagree with.
  assert.match(when.iso.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(when.iso.startTime, /^\d{2}:\d{2}$/);
});

test('an email card carries Bcc, attachment weight and where the draft came from', () => {
  const p = {
    id: 'p-4',
    kind: 'email.send',
    summary: 'x',
    payload: {
      account: 'hp@gmx.ch',
      to: 'anna@example.org',
      cc: 'bob@example.org',
      bcc: 'carol@example.org, dave@example.org',
      subject: 'Rechnung',
      body: 'text',
      sourceEmailId: 77,
      attachments: [{ filename: 'rechnung.pdf', size: 2048 }],
    },
  };
  const card = cards.cardFor(governance.kindDef('email.send'), p);
  const bcc = card.fields.find((f) => f.label === 'Bcc');
  assert.ok(bcc, 'Bcc is a decision input — a blind copy is not a detail');
  assert.equal(bcc.kind, 'address');
  assert.deepEqual(bcc.value, ['carol@example.org', 'dave@example.org']);
  assert.match(card.footer, /Reply to message 77/);
  const atts = card.fields.find((f) => f.label === 'Attachments');
  assert.ok(atts.value[0].includes('2 kB'), `an attachment lost its size: ${atts.value[0]}`);
});

// A composed reply carries the model's prose and the trail it answers as
// separate payload fields. The card must keep them separate: MAX_LONGTEXT is
// 4000, so a long trail rendered as "the body" would push the actual reply —
// the one thing the approver has to read — out of the card.
test('a composed reply card separates the reply from the trail it quotes', () => {
  const quoted = 'Guten Tag,\n\nanbei die Rechnung 4711.\n\nAnna';
  const p = {
    id: 'p-5',
    kind: 'email.send',
    summary: 'x',
    payload: {
      account: 'hp@gmx.ch',
      to: 'anna@example.org',
      subject: 'Re: Rechnung 4711',
      replyText: 'Danke, ist überwiesen.',
      quotedText: quoted,
      quoteAttribution: 'Am 11. September 2026 schrieb Anna:',
      body: `Danke, ist überwiesen.\n\nAm 11. September 2026 schrieb Anna:\n> ${quoted}`,
      htmlBody: '<div><p>Danke, ist überwiesen.</p></div>',
      includeSignature: true,
      composeVersion: 1,
      inReplyTo: '<abc@example.org>',
    },
  };
  const card = cards.cardFor(governance.kindDef('email.send'), p);

  const reply = card.fields.find((f) => f.label === 'Reply');
  assert.ok(reply, 'a composed reply must show its reply text under its own label');
  assert.equal(reply.value, 'Danke, ist überwiesen.');
  assert.ok(!reply.value.includes('schrieb Anna'), 'the trail must not be inside the reply field');

  const trail = card.fields.find((f) => f.label === 'Quoted');
  assert.ok(trail, 'the quoted trail is a decision input — the approver is endorsing it');
  assert.equal(trail.value, quoted);

  const sig = card.fields.find((f) => f.label === 'Signature');
  assert.ok(sig, 'the signature state must be visible on every surface, including Telegram');
  assert.equal(sig.kind, 'bool');
  assert.equal(sig.value, true);
  assert.ok(cards.FIELD_KINDS.has(sig.kind), 'no new field kind was introduced');

  // The whole point of quoting the parent rather than reconstructing a thread
  // is that the trail IS the message being replied to. The card states that.
  assert.match(card.footer, /verbatim/i);
});

// The verbatim claim is only true when the sender actually sent a plain-text
// part. For HTML-only mail the quote is OUR rendering of their HTML, and the
// card must say so — presenting a re-render as "the original" is precisely the
// false guarantee quoteDerived exists to prevent.
test('a card never claims verbatim for a trail derived from the sender’s HTML', () => {
  const p = {
    id: 'p-6',
    kind: 'email.send',
    summary: 'x',
    payload: {
      account: 'hp@gmx.ch',
      to: 'anna@example.org',
      subject: 'Re: Newsletter',
      replyText: 'Bitte austragen.',
      quotedText: 'Guten Tag, hier die Neuigkeiten.',
      quoteDerived: true,
      body: 'Bitte austragen.\n\n> Guten Tag, hier die Neuigkeiten.',
      includeSignature: false,
      composeVersion: 1,
    },
  };
  const card = cards.cardFor(governance.kindDef('email.send'), p);
  assert.doesNotMatch(card.footer, /verbatim/i, 'a derived trail must not be called verbatim');
  assert.match(card.footer, /HTML/, 'the card must say where a derived trail came from');
  assert.equal(card.fields.find((f) => f.label === 'Signature').value, false);
});

// Hand-composed and app-staged sends carry no replyText. They must keep
// rendering exactly as before — one Body field, no empty Quoted or Signature.
test('an uncomposed email card is unchanged by the reply split', () => {
  const card = cards.cardFor(governance.kindDef('email.send'), proposalFor('email.send'));
  assert.ok(card.fields.find((f) => f.label === 'Body'), 'legacy payloads still say Body');
  assert.equal(card.fields.find((f) => f.label === 'Reply'), undefined);
  assert.equal(card.fields.find((f) => f.label === 'Quoted'), undefined);
  assert.equal(card.fields.find((f) => f.label === 'Signature'), undefined);
});

test('a calendar update says where it moves, what it adds and how long it runs', () => {
  const p = {
    id: 'p-5',
    kind: 'calendar.update',
    summary: 'x',
    payload: {
      title: 'Review',
      date: '2026-09-12',
      startTime: '09:00',
      endTime: '10:00',
      endDate: '2026-09-14',
      calendarId: 'primary',
      targetCalendarId: 'team@example.org',
      targetCalendarName: 'Team',
      addMeet: true,
      account: 'hp@gmx.ch',
      eventId: 'ev-9',
      reminderMinutes: 15,
    },
  };
  const card = cards.cardFor(governance.kindDef('calendar.update'), p);
  const when = card.fields.find((f) => f.kind === 'when');
  assert.ok(when.value.includes('until 2026-09-14'), `a multi-day event hid its end: ${when.value}`);
  assert.equal(card.fields.find((f) => f.label === 'Move to').value, 'Team');
  assert.ok(card.fields.find((f) => f.label === 'Meet'), 'the Meet line went missing');
  assert.match(card.footer, /event ev-9/);
  assert.match(card.footer, /reminder 15 min before/);
  // This payload names no calendar, so the account is the SUBTITLE — and must
  // therefore not also appear in the footer.
  assert.equal(card.subtitle, 'hp@gmx.ch');
  assert.ok(!card.footer.includes('hp@gmx.ch'), `the account is printed twice: ${card.footer}`);
});

test('a named calendar takes the subtitle and pushes the account to the footer', () => {
  const card = cards.cardFor(governance.kindDef('calendar.create'), {
    id: 'p-6',
    kind: 'calendar.create',
    summary: 'x',
    payload: { title: 'Standup', date: '2026-09-12', account: 'hp@gmx.ch', calendarName: 'Team' },
  });
  assert.equal(card.subtitle, 'in Team');
  assert.match(card.footer, /hp@gmx\.ch/);
  assert.ok(!card.footer.includes('Team'), `the calendar is printed twice: ${card.footer}`);
});

test('a deletion is marked danger AND says so in words', () => {
  // The accent is a red border; someone reading the Telegram text card gets no
  // border, so the irreversibility has to survive as words too.
  const del = cards.cardFor(governance.kindDef('calendar.delete'), proposalFor('calendar.delete'));
  assert.equal(del.accent, 'danger');
  assert.match(del.warn, /permanently deleted/i);
  assert.match(cards.textCard(del), /permanently deleted/i);
});

test('app kinds are classified by their base name, not left generic', () => {
  // '<app>:<kind>' — an app's calendar proposal deserves the platform's card.
  assert.equal(cards.familyOf('my-dashboard:calendar_create'), 'calendar');
  assert.equal(cards.familyOf('my-dashboard:email'), 'email');
  assert.equal(cards.familyOf('my-dashboard:reply'), 'email');
  assert.equal(cards.familyOf('some-app:whatever'), null);
});

// --- hygiene: a bad card must never empty the queue ---------------------------

test('a throwing card() degrades to the projector instead of breaking the list', () => {
  const def = {
    card() { throw new Error('boom'); },
  };
  const card = cards.cardFor(def, proposalFor('email.send'));
  assertValidCard(card, 'throwing card()');
  assert.equal(card.render, 'email', 'it should have fallen through to the family projector');
});

test('a field kind outside the closed set is dropped, not rendered blank', () => {
  const def = {
    card: () => ({
      title: 'Custom',
      fields: [
        { label: 'Good', kind: 'text', value: 'kept' },
        { label: 'Bad', kind: 'colour-picker', value: 'dropped' },
      ],
    }),
  };
  const card = cards.cardFor(def, proposalFor('x'));
  assert.equal(card.fields.length, 1);
  assert.equal(card.fields[0].label, 'Good');
});

test('a card() with no title is not a card — it degrades', () => {
  const def = { card: () => ({ fields: [{ label: 'a', kind: 'text', value: 'b' }] }) };
  const card = cards.cardFor(def, proposalFor('todo.create'));
  assert.equal(card.render, 'todo', 'a titleless descriptor must not be accepted');
});

test('long values are clipped and the card says how much was cut', () => {
  const long = 'x'.repeat(9000);
  const def = { card: () => ({ title: 'Long', fields: [{ label: 'Body', kind: 'longtext', value: long, chars: long.length }] }) };
  const f = cards.cardFor(def, proposalFor('x')).fields[0];
  assert.ok(f.value.length < long.length, 'an unbounded value reached a surface');
  assert.equal(f.chars, 9000, 'the original length must survive so the reader knows what is missing');
});

// --- the registrars: the likeliest silent failure -----------------------------

test('BOTH registrars carry card through to the kind def', () => {
  // Both copy def fields explicitly, with no spread. Dropping `card` from
  // either would send every kind back to raw JSON with no error anywhere.
  governance.registerKind('cardtest.kind', {
    label: 'Card test',
    describe: () => 'x',
    card: () => ({ title: 'from the def' }),
    execute: () => ({ ok: true }),
  });
  assert.equal(typeof governance.kindDef('cardtest.kind').card, 'function', 'registerKind dropped card');
  assert.equal(
    cards.cardFor(governance.kindDef('cardtest.kind'), proposalFor('cardtest.kind')).title,
    'from the def',
  );

  // The platform registrar copies it too — asserted through a kind that
  // declares one, or through the field simply being present and null.
  for (const name of Object.keys(platform)) {
    const def = governance.kindDef(name);
    assert.ok('card' in def, `registerPlatformKinds dropped card for ${name}`);
  }
});

test('tgCard is gone — no kind defines one and nothing reads it', () => {
  for (const name of ALL_KINDS) {
    assert.equal(governance.kindDef(name).tgCard, undefined, `${name} still carries the retired tgCard seam`);
  }
});
