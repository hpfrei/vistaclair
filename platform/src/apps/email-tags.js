// Tag membership — which tags sit on which message — as pure functions over the
// engine's `tags` annotation (writer `platform`, one document per message):
//
//   { v: 1, sender: 'a@b.test'|null,
//     tags: { '<tagId>': { source: 'ai'|'rule'|'user', removed?: 1 } } }
//
// The vocabulary (id, name, colour) is the label store next door
// (email-engine listLabels); this is the other axis. Three behaviours are
// load-bearing and each lives in one function below (test/email-labels.test.js):
//   * a user removal is a TOMBSTONE (`removed: 1`), not a delete — it outranks
//     the classifier and every later automatic assignment, so a tag the owner
//     took off never comes back on its own;
//   * an automatic assignment REPLACES its own source's entries and touches
//     nothing else: the classifier's next pass drops the `ai` tags it no longer
//     believes in (so a reclassify can correct a wrong tag), while `user` rows,
//     tombstones and an app's deterministic `rule` tags stay as they are;
//   * `sender` is learned on first write and kept, so an app's sender-rule
//     miner can read who the owner tags without a second lookup.
'use strict';

const KIND = 'tags';
const WRITER = 'platform';
const AUTO_SOURCES = new Set(['ai', 'rule']);

// The tags map as a surface wants it: [{ id, source }], tombstones dropped.
// `extraIds` are ids asserted live by the caller (an app carrying the
// classifier's names before they were written here); a tombstone beats them.
function mergeTags(data, extraIds = []) {
  const own = (data && data.tags) || {};
  const out = [];
  const seen = new Set();
  for (const id of extraIds) {
    const e = own[id];
    if (e && e.removed) continue;              // tombstone beats the classifier
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, source: (e && e.source) || 'ai' });
  }
  for (const [id, e] of Object.entries(own)) {
    if (!e || e.removed || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, source: e.source || 'ai' });
  }
  return out;
}

// `annotate` replaces the whole document, so every write is read-modify-write
// and these two return the NEW data rather than mutating in place.
function applyUserEdit(data, { add = [], remove = [] } = {}, sender = null) {
  const next = { v: 1, sender: sender || (data && data.sender) || null, tags: { ...((data && data.tags) || {}) } };
  for (const id of add) next.tags[id] = { source: 'user' };
  for (const id of remove) next.tags[id] = { source: 'user', removed: 1 };
  return next;
}

// The automatic half. Entries of `source` not in `tagIds` are dropped, entries
// of any other source are never touched, so the classifier owns exactly its
// own opinion and nothing the owner or a rule decided.
function applyAutoAssign(data, tagIds = [], sender = null, source = 'ai') {
  if (!AUTO_SOURCES.has(source)) throw new Error(`automatic tag source must be one of ${[...AUTO_SOURCES].join('|')}`);
  const next = { v: 1, sender: sender || (data && data.sender) || null, tags: {} };
  const want = new Set(tagIds);
  for (const [id, e] of Object.entries((data && data.tags) || {})) {
    if (e && e.source === source && !e.removed && !want.has(id)) continue; // the source changed its mind
    next.tags[id] = e;
  }
  for (const id of want) if (!next.tags[id]) next.tags[id] = { source };
  return next;
}

module.exports = { KIND, WRITER, AUTO_SOURCES, mergeTags, applyUserEdit, applyAutoAssign };
