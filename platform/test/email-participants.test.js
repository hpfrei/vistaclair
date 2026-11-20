// "Who is Anna?" is a question about the mail store, and until now only
// my-dashboard could answer it — from a participant table of its own. The
// engine holds the same facts in every row's address headers; these tests cover
// the parser that reads them and the tool that exposes the answer.
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseParticipants, lookupParticipants } = require('../src/apps/email-engine');
const capabilities = require('../src/apps/capabilities');

const addrs = (field) => parseParticipants(field).map((p) => p.address);

test('the three header spellings all yield the address', () => {
  assert.deepEqual(addrs('"Anna Meier" <anna@x.test>'), ['anna@x.test']);
  assert.deepEqual(addrs('Anna Meier <anna@x.test>'), ['anna@x.test']);
  assert.deepEqual(addrs('anna@x.test'), ['anna@x.test']);
});

test('the display name comes back with the address, because that is what a name search matches', () => {
  assert.deepEqual(parseParticipants('"Meier, Anna" <anna@x.test>'), [{ address: 'anna@x.test', name: 'Meier, Anna' }]);
  assert.equal(parseParticipants('anna@x.test')[0].name, '');
});

test('a comma inside a quoted name does not split the header', () => {
  assert.deepEqual(addrs('"Lastname, First" <lf@z.test>, bob@y.test'), ['lf@z.test', 'bob@y.test']);
});

test('a header lists several people, and all of them are participants', () => {
  assert.deepEqual(
    addrs('Anna <anna@x.test>, Bob <bob@y.test>; carol@z.test'),
    ['anna@x.test', 'bob@y.test', 'carol@z.test'],
  );
});

test('addresses are lowercased, so one person is one contact', () => {
  assert.deepEqual(addrs('Anna <Anna.Meier@X.TEST>'), ['anna.meier@x.test']);
});

test('a header with no address at all yields nobody', () => {
  for (const field of ['undisclosed-recipients:;', '', null, undefined, 'Anna Meier']) {
    assert.deepEqual(parseParticipants(field), [], JSON.stringify(field));
  }
});

test('an empty query is a caller mistake, not an empty result', async () => {
  await assert.rejects(() => lookupParticipants('  '), /requires a query/);
});

// --- the tool -------------------------------------------------------------

const tools = new Map(capabilities.horstTools().map((t) => [t.def.name, t]));

test('the platform now answers the three questions the app tools answered', () => {
  for (const name of ['email_contacts', 'email_attachment', 'calendar_calendars']) {
    const t = tools.get(name);
    assert.ok(t, `${name} is not registered`);
    assert.match(t.def.description, /read-only/i);
    assert.equal(t.def.expose, 'platform');
  }
});

test('a contact lookup without a query is refused by the schema, not by guesswork', () => {
  assert.deepEqual(tools.get('email_contacts').def.inputSchema.required, ['query']);
});

test('reading an attachment needs all three coordinates — there is no "latest" shortcut', () => {
  assert.deepEqual(tools.get('email_attachment').def.inputSchema.required, ['account', 'uid', 'attachmentId']);
});

test('listing calendars is not listing events — the two tools stay distinct', () => {
  assert.doesNotMatch(tools.get('calendar_calendars').def.description, /list the user's calendar events/i);
  assert.match(tools.get('calendar_list').def.description, /events/i);
});

test('the contact tool tells the model what to do when there is no match', async () => {
  const emailEngine = require('../src/apps/email-engine');
  const orig = { isReady: emailEngine.isReady, lookupParticipants: emailEngine.lookupParticipants };
  emailEngine.isReady = () => true;
  emailEngine.lookupParticipants = async () => [];
  try {
    const r = await tools.get('email_contacts').handler({ query: 'nobody' });
    assert.match(r.content[0].text, /do not guess/i);
  } finally { Object.assign(emailEngine, orig); }
});
