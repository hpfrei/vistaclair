// One reply-drafting path.
//
// The value in this module is not the prompt — it is everything around it: the
// parent message is read from the store rather than accepted from the caller,
// the correspondent context is injected as data, and a draft that echoes the
// original is discarded. A second drafting path elsewhere would carry none of
// that, which is exactly the situation this module ends.
const test = require('node:test');
const assert = require('node:assert/strict');

const emailDraft = require('../src/apps/email-draft');
const emailEngine = require('../src/apps/email-engine');
const appBridge = require('../src/apps/app-bridge');
const capabilities = require('../src/apps/capabilities');

const PARENT = {
  account: 'me@x.test', id: '42', from: 'Anna <anna@y.test>', subject: 'Ferry booking',
  date: 'Mon, 01 Jun 2026 09:00:00 GMT', body: 'Could you confirm the 9am ferry on Tuesday?',
};

// Stand in for the model: returns whatever the test wants it to say, and
// records the call so the prompt's shape can be asserted.
function withModel(reply, fn) {
  const orig = appBridge.aiPrompt;
  const calls = [];
  appBridge.aiPrompt = async (appName, appDir, params) => {
    calls.push({ appName, appDir, params });
    return { json: typeof reply === 'function' ? reply() : { reply } };
  };
  return Promise.resolve(fn(calls)).finally(() => { appBridge.aiPrompt = orig; });
}

test('a clean draft comes back as text only', async () => {
  await withModel('Confirmed — Tuesday 9am works.', async () => {
    const r = await emailDraft.draftReplyText(PARENT);
    assert.equal(r.ok, true);
    assert.match(r.text, /Tuesday 9am/);
  });
});

test('the model gets no tools — it is reading untrusted mail', async () => {
  await withModel('ok', async (calls) => {
    await emailDraft.draftReplyText(PARENT);
    assert.deepEqual(calls[0].params.allowedTools, []);
  });
});

test('the system prompt forbids the parts code owns', async () => {
  await withModel('ok', async (calls) => {
    await emailDraft.draftReplyText(PARENT);
    const sys = calls[0].params.systemPrompt;
    for (const owned of [/no subject line/i, /no quoted original/i, /signature/i]) assert.match(sys, owned);
  });
});

test("the user's instruction reaches the draft, and is absent when there is none", async () => {
  await withModel('ok', async (calls) => {
    await emailDraft.draftReplyText(PARENT, { instruction: 'Decline politely.' });
    assert.match(calls[0].params.systemPrompt, /Decline politely\./);
    await emailDraft.draftReplyText(PARENT);
    assert.doesNotMatch(calls[1].params.systemPrompt, /instruction for this draft/i);
  });
});

test('a draft that echoes the original is discarded, not returned', async () => {
  await withModel(`On Mon, Anna wrote:\n> Could you confirm the 9am ferry on Tuesday?`, async () => {
    const r = await emailDraft.draftReplyText(PARENT);
    assert.equal(r.ok, false);
    assert.ok(r.reason, 'a rejection must say why');
  });
});

test('an empty answer is a rejection with a reason, never an empty send', async () => {
  await withModel(() => ({}), async () => {
    const r = await emailDraft.draftReplyText(PARENT);
    assert.deepEqual(r, { ok: false, text: '', reason: 'empty' });
  });
});

test('spend is attributed to whoever triggered the draft', async () => {
  await withModel('ok', async (calls) => {
    await emailDraft.draftReplyText(PARENT, { appName: 'my-dashboard', appDir: '/tmp/x' });
    assert.equal(calls[0].appName, 'my-dashboard');
    await emailDraft.draftReplyText(PARENT, { appName: 'platform', appDir: '/tmp/x' });
    assert.equal(calls[1].appName, 'platform');
  });
});

test('the parent is read from the store — a caller names a message, it does not supply one', async () => {
  const orig = emailEngine.getEmail;
  emailEngine.getEmail = async ({ account, uid }) => (account === PARENT.account && uid === '42' ? PARENT : null);
  try {
    await withModel('Confirmed.', async () => {
      const r = await emailDraft.draftReplyFor({ account: 'me@x.test', uid: 42 });
      assert.equal(r.text, 'Confirmed.');
      assert.equal(r.uid, '42');
    });
    await assert.rejects(() => emailDraft.draftReplyFor({ account: 'me@x.test', uid: 999 }), /not found/);
    await assert.rejects(() => emailDraft.draftReplyFor({ uid: 1 }), /account and uid/);
  } finally { emailEngine.getEmail = orig; }
});

test('a rejected draft is an error to the app, not an empty body it might send', async () => {
  const orig = emailEngine.getEmail;
  emailEngine.getEmail = async () => PARENT;
  try {
    await withModel(() => ({}), async () => {
      await assert.rejects(() => emailDraft.draftReplyFor({ account: 'a', uid: 1 }), /draft rejected \(empty\)/);
    });
  } finally { emailEngine.getEmail = orig; }
});

test('the drafter is on the app-facing surface, so an app never needs its own', () => {
  const cap = require('../src/apps/capabilities/email.js');
  assert.ok(cap.methods.includes('email.draftReply'), 'the bridge must expose it');
  assert.ok(capabilities.dispatch('email.draftReply'), 'the method must resolve');
});
