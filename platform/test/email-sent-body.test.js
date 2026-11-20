// `email.sent` holds the full outgoing text and used to throw it away.
//
// The send log stores the whole body (`logSend` caps it at 60k chars), the
// read already SELECTs it, and the DTO then exposed a 200-char `snippet` and
// nothing else — so any surface wanting to show "the reply I sent" had to make
// a second, provider-touching read via `email.get({ uid })`, which only works
// when the log row has a provider_uid at all (an SMTP APPEND returns none).
//
// `includeBody: true` returns it directly. The two things this file pins are
// the opt-in (a caller that does not ask sees the exact shape it saw before,
// `body` key included — absent) and the fact that `snippet` never changes
// meaning, because every existing caller reads it.
const test = require('node:test');
const assert = require('node:assert/strict');

const appDb = require('../src/apps/app-db');
const emailEngine = require('../src/apps/email-engine');

const LONG = `Dear Frau Meier,\n\n${'the full text of the reply '.repeat(40)}\n\nBest regards`;

const ROW = {
  account: 'me@example.com',
  message_id: '<reply-1@example.com>',
  thread_id: 't1',
  in_reply_to: '<parent@mail.gmail.com>',
  provider_uid: null, // the SMTP-append case: `email.get({ uid })` is not available
  recipient: 'her@example.com', cc: null, bcc: null,
  subject: 'Re: Quarterly numbers',
  body: LONG,
  sent_at: new Date('2026-03-02T09:00:00Z'),
  has_attachments: 0,
  origin_source: 'bridge', origin_app: 'my-dashboard', proposal_id: null,
};

// Only the send-log half is stubbed; the Sent-folder half runs against the same
// double, finds no mail store and is swallowed by listSent's own catch.
async function withLog(rows, fn) {
  const prevPool = appDb.getPool;
  appDb.getPool = () => ({
    getConnection: async () => ({
      query: async (q) => {
        if (/^USE /.test(q)) return [];
        if (/FROM platform_email_sent/.test(q)) return rows;
        throw new Error('no mail store in this test');
      },
      release() {},
    }),
  });
  try {
    return await fn();
  } finally {
    appDb.getPool = prevPool;
  }
}

test('without includeBody the item is exactly what callers read today — no body key', async () => {
  await withLog([ROW], async () => {
    const { sent } = await emailEngine.listSent({ account: ROW.account });
    assert.equal(sent.length, 1);
    assert.equal('body' in sent[0], false, 'the default response shape is unchanged');
    assert.equal(sent[0].snippet.length, 200);
    assert.equal(sent[0].via, 'log');
  });
});

test('includeBody returns the whole sent text, not the snippet', async () => {
  await withLog([ROW], async () => {
    const { sent } = await emailEngine.listSent({
      account: ROW.account, inReplyTo: ROW.in_reply_to, includeBody: true,
    });
    assert.equal(sent[0].body, LONG);
    assert.ok(sent[0].body.length > 200, 'the point: it is not truncated mid-sentence');
    // The truncated field every current caller renders keeps its own meaning.
    assert.equal(sent[0].snippet, LONG.replace(/\s+/g, ' ').trim().slice(0, 200));
    assert.equal(sent[0].uid, null, 'and it arrives with no uid to fall back on');
  });
});

test('a log row with no stored body yields body: null, never undefined or ""', async () => {
  await withLog([{ ...ROW, body: null }], async () => {
    const { sent } = await emailEngine.listSent({ account: ROW.account, includeBody: true });
    assert.equal('body' in sent[0], true);
    assert.equal(sent[0].body, null);
    assert.equal(sent[0].snippet, '');
  });
});

test('includeBody is opt-in by value: only true asks for it', async () => {
  await withLog([ROW], async () => {
    for (const v of [false, undefined, null, 0, '']) {
      const { sent } = await emailEngine.listSent({ account: ROW.account, includeBody: v });
      assert.equal('body' in sent[0], false, `includeBody: ${JSON.stringify(v)}`);
    }
    // The Bridge hands params through a query string on some paths.
    const { sent } = await emailEngine.listSent({ account: ROW.account, includeBody: 'true' });
    assert.equal(sent[0].body, LONG);
  });
});

test('the filters and the dedupe keys are untouched by the new parameter', async () => {
  const twin = { ...ROW, sent_at: new Date('2026-03-02T10:00:00Z') };
  await withLog([ROW, twin], async () => {
    const { sent, total } = await emailEngine.listSent({
      account: ROW.account, threadId: 't1', subject: 'Quarterly numbers',
      limit: 10, includeBody: true,
    });
    assert.equal(total, 2, 'both log rows are returned; dedupe is against the folder half');
    assert.ok(sent.every((s) => s.body === LONG));
    assert.ok(new Date(sent[0].sentAt) >= new Date(sent[1].sentAt), 'still newest first');
  });
});
