// Which tags sit on which message used to be a table inside my-dashboard, which
// meant the owner's own labels were invisible to Horst and to search. The
// merge is the engine's now (src/apps/email-tags.js, the `tags` annotation),
// and three behaviours the old SQL encoded had to survive the move — each one
// is load-bearing, and losing any of them re-opens the self-poisoning class of
// bug the mail side already closed:
//
//   * a user removal is a TOMBSTONE, not a delete — it outranks the classifier
//     and every later automatic assignment;
//   * an automatic source replaces only its OWN entries, so a reclassify can
//     drop a wrong tag and still never touch what the owner or a rule decided;
//   * the sender-rule miner reads user rows only, so an automatic label can
//     never mint a rule that mints more automatic labels.
//
// The first half runs against the platform module. The second half exercises
// the app-side reader (flatten, the miner, the shim over ctx.email.tags) and is
// a no-op on a box with no apps checked out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const tags = require('../src/apps/email-tags');
const { mergeTags: mergeLabels, applyUserEdit } = tags;
// The classifier's write, as the engine makes it (source 'ai').
const applyAiAssign = (data, ids, sender) => tags.applyAutoAssign(data, ids, sender, 'ai');

const APP = path.join(__dirname, '..', '..', 'vistaclair-apps', 'my-dashboard', 'labels.js');
const labels = fs.existsSync(APP) ? require(APP) : null;
const when = (name, fn) => test(name, { skip: labels ? false : 'my-dashboard not installed' }, fn);

// ── the tombstone ───────────────────────────────────────────────────────────

test('the classifier labels a message and the chips show it — with no stored row at all', () => {
  assert.deepEqual(mergeLabels(null, ['invoice']), [{ id: 'invoice', source: 'ai' }]);
});

test('a tag the owner took off does not come back when the classifier picks it again', () => {
  const data = applyUserEdit(null, { remove: ['invoice'] }, 'shop@x.test');
  assert.deepEqual(data.tags.invoice, { source: 'user', removed: 1 });
  assert.deepEqual(mergeLabels(data, ['invoice']), [], 'the tombstone outranks the classifier');
});

test('an automatic assignment never overwrites a row the owner wrote', () => {
  const tomb = applyUserEdit(null, { remove: ['invoice'] });
  const after = applyAiAssign(tomb, ['invoice', 'travel'], 'shop@x.test');
  assert.deepEqual(after.tags.invoice, { source: 'user', removed: 1 }, 'still the tombstone');
  assert.deepEqual(after.tags.travel, { source: 'ai' }, 'a tag nobody ruled on is free to add');
  assert.deepEqual(mergeLabels(after, ['invoice']), [{ id: 'travel', source: 'ai' }]);
});

test('re-adding by hand lifts the tombstone', () => {
  const data = applyUserEdit(applyUserEdit(null, { remove: ['invoice'] }), { add: ['invoice'] });
  assert.deepEqual(mergeLabels(data, []), [{ id: 'invoice', source: 'user' }]);
});

test('a label the owner added themselves is reported as theirs, not the classifier’s', () => {
  const data = applyUserEdit(null, { add: ['invoice'] });
  // Same id from both sides: the owner's source wins, and it is listed once.
  assert.deepEqual(mergeLabels(data, ['invoice']), [{ id: 'invoice', source: 'user' }]);
});

test('the classifier’s next pass drops the tag it no longer believes in — and nothing else', () => {
  const owner = applyUserEdit(null, { add: ['travel'], remove: ['spam'] }, 'shop@x.test');
  const rule = tags.applyAutoAssign(owner, ['shop'], null, 'rule');
  const first = applyAiAssign(rule, ['invoice', 'newsletter']);
  assert.deepEqual(mergeLabels(first).map((t) => t.id).sort(), ['invoice', 'newsletter', 'shop', 'travel']);

  const second = applyAiAssign(first, ['invoice']);
  assert.deepEqual(second.tags.newsletter, undefined, 'an ai tag the classifier dropped is gone');
  assert.deepEqual(second.tags.invoice, { source: 'ai' });
  assert.deepEqual(second.tags.travel, { source: 'user' }, 'the owner’s add is not the classifier’s to drop');
  assert.deepEqual(second.tags.spam, { source: 'user', removed: 1 }, 'nor is the tombstone');
  assert.deepEqual(second.tags.shop, { source: 'rule' }, 'nor an app’s rule tag');
  assert.equal(second.sender, 'shop@x.test', 'the sender learned first is kept');
});

test('an automatic source is one of the two the engine knows', () => {
  assert.throws(() => tags.applyAutoAssign(null, ['x'], null, 'user'), /automatic tag source/);
});

// ── exemplars and the miner both read `source` ───────────────────────────────

when('flattening keeps the source and the tombstone, which is what the two readers filter on', () => {
  const { flatten } = labels;
  const rows = flatten([
    { account: 'a@x.test', uid: '1', data: applyUserEdit(null, { add: ['invoice'] }, 'shop@x.test'), updatedAt: 1 },
    { account: 'a@x.test', uid: '2', data: applyAiAssign(null, ['invoice'], 'news@y.test'), updatedAt: 2 },
    { account: 'a@x.test', uid: '3', data: applyUserEdit(null, { remove: ['invoice'] }, 'shop@x.test'), updatedAt: 3 },
  ]);
  assert.deepEqual(rows.map((r) => [r.uid, r.source, r.removed]),
    [['1', 'user', 0], ['2', 'ai', 0], ['3', 'user', 1]]);

  // The exemplar filter, exactly as the candidates route applies it.
  const exemplars = rows.filter((r) => r.source === 'user' && !r.removed);
  assert.deepEqual(exemplars.map((r) => r.uid), ['1'],
    'an automatic label is not an example of what the owner means by this tag');
});

when('the sender-rule miner counts the owner’s decisions and nobody else’s', () => {
  const { mineSenderRules } = labels;
  const row = (sender, tagId, source, removed) => ({ sender, tagId, source, removed, account: 'a', uid: 'u' });

  assert.deepEqual(
    mineSenderRules([row('news@y.test', 'invoice', 'ai', 0), row('news@y.test', 'invoice', 'ai', 0)]),
    {}, 'automatic labels alone never mint a rule');

  assert.deepEqual(
    mineSenderRules([row('shop@x.test', 'invoice', 'user', 0), row('shop@x.test', 'invoice', 'ai', 0)]),
    { 'shop@x.test': ['invoice'] });

  assert.deepEqual(
    mineSenderRules([
      row('shop@x.test', 'invoice', 'user', 0),
      row('shop@x.test', 'invoice', 'user', 1),
      row('shop@x.test', 'invoice', 'user', 1),
    ]),
    {}, 'more removals than adds means the owner does not want it');

  assert.deepEqual(mineSenderRules([row(null, 'invoice', 'user', 0)]), {},
    'a row with no sender teaches nothing about senders');
});

// ── the shim over the engine ────────────────────────────────────────────────
// A fake ctx.email.tags.* that applies the platform's own merge rules, so the
// shim is tested against the semantics it delegates to.

function fakeCtx(senders = {}) {
  const store = new Map();
  const key = (a, u) => `${a}\n${u}`;
  const senderOf = (a, u) => senders[key(a, u)] || null;
  return {
    store,
    appName: 'my-dashboard',
    email: {
      tags: {
        async of(account, uid) { return mergeLabels(store.get(key(account, uid)) || null); },
        async set(account, uid, edit) {
          store.set(key(account, uid), applyUserEdit(store.get(key(account, uid)) || null, edit, senderOf(account, uid)));
          return { ok: true };
        },
        async assign(account, uid, ids) {
          store.set(key(account, uid), tags.applyAutoAssign(store.get(key(account, uid)) || null, ids, senderOf(account, uid), 'rule'));
          return { ok: true };
        },
      },
      async listAnnotations({ appName, kind }) {
        assert.equal(appName, 'platform', 'the document is the engine\'s, not the app\'s');
        assert.equal(kind, 'tags');
        return [...store.entries()].map(([k, data]) => {
          const [account, uid] = k.split('\n');
          return { account, uid, kind, data, updatedAt: new Date(1) };
        });
      },
    },
  };
}

when('the owner’s edits go through tags.set and read back through tags.of', async () => {
  const ctx = fakeCtx({ 'a@x.test\n7': 'shop@x.test' });
  const L = labels.makeLabels(ctx);
  await L.setTags('a@x.test', '7', { add: ['invoice'] });
  await L.setTags('a@x.test', '7', { add: ['travel'] });
  await L.setTags('a@x.test', '7', {});
  assert.deepEqual(await L.forMessage('a@x.test', '7'),
    [{ id: 'invoice', source: 'user' }, { id: 'travel', source: 'user' }]);
  assert.equal(ctx.store.get('a@x.test\n7').sender, 'shop@x.test', 'the engine learned the sender, the app never sent one');
});

when('a sender rule writes source rule, and a tombstone still beats it', async () => {
  const ctx = fakeCtx({ 'a@x.test\n7': 'shop@x.test' });
  const L = labels.makeLabels(ctx);
  await L.setTags('a@x.test', '7', { remove: ['invoice'] });
  await L.assignRule('a@x.test', '7', ['invoice', 'travel']);
  assert.deepEqual(await L.forMessage('a@x.test', '7'), [{ id: 'travel', source: 'rule' }]);
  assert.deepEqual(await L.senderRules(), {}, 'a removal is not an endorsement');
});

when('of() reads the document the list already attached, and rowsForTag counts the tombstoned message too', async () => {
  const ctx = fakeCtx();
  const L = labels.makeLabels(ctx);
  await L.setTags('a@x.test', '1', { add: ['invoice', 'travel'] });
  await L.setTags('b@x.test', '2', { remove: ['invoice'] });

  assert.deepEqual(L.of({ annotations: { tags: ctx.store.get('a@x.test\n1') } }).map((t) => t.id), ['invoice', 'travel']);
  assert.deepEqual(L.of({ annotations: {} }), [], 'no document, no chips');

  const rows = await L.rowsForTag('invoice');
  assert.deepEqual(rows.map((r) => [r.account, r.uid, r.removed]).sort(),
    [['a@x.test', '1', 0], ['b@x.test', '2', 1]],
    'the tombstoned message counts too — Find matches must not re-suggest it');
});
