// Horst act identity — one key per ACT.
//
// `dedupeKey` answers "is this the same DERIVATION re-run?" — it encodes the
// artifact a proposal was extracted from (cal:{account}:{uid}:{idx}). That is
// the wrong question for duplicates, and the live store proved it three ways:
//   • one appointment discussed across three emails is three dedupeKeys, so it
//     staged three times (and was executed three times);
//   • a proposal CONVERTED in place (calendar.create → calendar.update, when the
//     event turned out to exist) keeps its key but changes its kind, and the
//     twin scan was kind-locked — so the converted row was invisible and a fresh
//     duplicate staged on every pass;
//   • whole kinds (reply drafts, app kinds) carry no key at all.
//
// `identity(payload, meta)` answers the right question: WHICH ACT is this?
// Same act ⇒ same string, whichever email mentioned it and whichever kind
// currently represents it. Deliberately mechanical and synchronous — no LLM, no
// embedding, no I/O — because it runs on the createProposal hot path and must
// never be skipped. The fuzzy matcher (horst-prior-action's sameEventPayloads,
// SEMANTIC_EVIDENCE_SIM) stays a SECOND net for near-misses; this is the cheap
// exact one.
//
// Returning null means "this kind cannot be identified from this payload" and
// degrades to the pre-identity behaviour (dedupeKey only) — never an exception,
// never a wrong collapse.

// Subject noise: "Re:", "Fwd:", "AW:" (de), "WG:" (de), "Antw:" (nl), "SV:"/"VS:" (se/fi),
// optionally counted ("Re[2]:"). Stripped repeatedly — real threads accrete them.
const SUBJECT_PREFIX_RE = /^\s*(re|fwd?|aw|wg|antw|sv|vs)\s*(\[\d+\])?\s*:\s*/i;

const KEY_MAX = 160;

// Lowercase, accent-fold, strip punctuation, collapse whitespace. "Café Müller!"
// and "cafe muller" are the same appointment.
function normText(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// A title as it appears in a key: normText plus reply-prefix stripping, hyphenated
// so ':' stays the key's own separator.
function normTitle(s) {
  let t = String(s ?? '');
  let prev;
  do { prev = t; t = t.replace(SUBJECT_PREFIX_RE, ''); } while (t !== prev);
  return normText(t).replace(/ /g, '-').slice(0, 80);
}

// An account is a mailbox/calendar owner — never undefined in a key, or the same
// act staged with and without an explicit account would get two identities.
function normAccount(a) {
  return String(a ?? '').trim().toLowerCase() || 'default';
}

// 'YYYY-MM-DD' from a date, a date-time, or anything Date can parse. Dates are
// absolute in a key: an old act can never shadow a genuinely new one.
function normDate(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// 'HH:MM' wall clock. Deliberately the stored wall clock, not a UTC instant:
// an event at 14:00 Berlin and a proposal for "14:00" are the same time, and
// their UTC instants are not (same rule as horst-prior-action's wallClock).
function normTime(v) {
  if (v == null || v === '') return null;
  const m = String(v).match(/(?:^|T)(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  if (!Number.isFinite(h) || h > 23) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

function clamp(key) {
  return key == null ? null : String(key).slice(0, KEY_MAX);
}

// ---------------------------------------------------------------------------
// Key builders — one per act family. The prefix IS the namespace: two families
// must never collide, or denying one act would suppress an unrelated one.
// ---------------------------------------------------------------------------

// An appointment: whichever email mentioned it, whichever kind represents it.
// No start time ⇒ 'allday', so an all-day event and a timed one on the same day
// stay distinct acts.
function calendarKey({ account, title, date, startTime }) {
  const t = normTitle(title);
  const d = normDate(date);
  if (!t || !d) return null;
  return clamp(`cal:${normAccount(account)}:${t}:${d}:${normTime(startTime) || 'allday'}`);
}

// A reply to a thread — one thread is one reply act, not one per message in it.
// Falls back to the normalised subject when the mail carries no thread anchor.
function replyKey({ account, threadId, inReplyTo, subject }) {
  const anchor = String(threadId || inReplyTo || '').trim() || normTitle(subject);
  if (!anchor) return null;
  return clamp(`reply:${normAccount(account)}:${anchor}`);
}

// A todo. The due date is part of the identity on purpose: a recurring
// obligation ("pay rent") is a NEW act each period, and collapsing those would
// silently swallow next month's reminder.
function todoKey({ account, title, dueAt }) {
  const t = normTitle(title);
  if (!t) return null;
  return clamp(`todo:${normAccount(account)}:${t}:${normDate(dueAt) || '-'}`);
}

// A spam rule. `type` is part of the key: blocking one sender and blocking their
// whole domain are different acts on the same string.
function ruleKey({ type, value }) {
  const v = normText(value).replace(/ /g, '');
  if (!v) return null;
  return clamp(`rule:${normText(type) || 'sender'}:${v}`);
}

// An act aimed at one EXISTING object by id (update/delete). Its own namespace,
// never the create namespace — "create X" and "delete X" are opposite acts, and
// sharing a key would make a denied create suppress a later delete.
function objectKey(prefix, { account, id }) {
  const v = String(id ?? '').trim();
  if (!v) return null;
  return clamp(`${prefix}:${normAccount(account)}:${v}`);
}

// What act would complete a todo. A closed set: mail content chooses one of
// these, so an unknown value must never survive normalisation. 'reply' is the
// load-bearing member — it makes a todo share the identity of the reply draft
// that would discharge it, so the two can never sit in the queue together.
// A configuration change (capabilities/config.js). One item added, removed or
// updated is one act, keyed by the item's name (or id), so the same tag asked
// for in chat and sighted by the mail sweep stages once. A set of fields is
// keyed by its sorted k=v pairs. A batch (two ops, or two items) is its own
// act and never dedupes — null.
const CONFIG_OPS = ['add', 'remove', 'update'];
function configKey({ key, patch } = {}) {
  if (!key || !patch || typeof patch !== 'object') return null;
  const ops = CONFIG_OPS.filter((op) => Array.isArray(patch[op]) && patch[op].length);
  if (ops.length) {
    if (ops.length > 1 || patch[ops[0]].length > 1) return null;
    const item = patch[ops[0]][0];
    const ref = typeof item === 'string' ? item : item && (ops[0] === 'add' ? item.name : item.id ?? item.name);
    const n = normText(ref);
    return n ? clamp(`config:${key}:${ops[0]}:${n}`) : null;
  }
  const fields = Object.keys(patch).filter((f) => !CONFIG_OPS.includes(f)).sort();
  if (!fields.length) return null;
  return clamp(`config:${key}:${fields.map((f) => `${f}=${normText(String(patch[f]))}`).join(',')}`);
}

const DISCHARGE = new Set(['reply', 'calendar', 'pay', 'other']);

module.exports = {
  DISCHARGE,
  normText, normTitle, normAccount, normDate, normTime,
  calendarKey, replyKey, todoKey, ruleKey, objectKey, configKey,
};
