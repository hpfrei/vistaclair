// Message-ID threading, for providers that do not hand us a thread.
//
// Gmail gives every message a real thread id. IMAP gives nothing, and the sync
// path filled `thread_id` with the row's own uid — so every IMAP message was a
// thread of one, and "has this thread been answered?" degraded to matching
// normalised subjects. That question is load-bearing: it is what suppresses a
// duplicate reply proposal after the owner has already answered from their
// phone, and subject matching gets it wrong in both directions (two unrelated
// "Re: invoice" threads collapse into one; a renamed subject splits a thread).
//
// RFC 5322 already carries the answer. `References` is ordered oldest-first, so
// its first entry is the thread root; `In-Reply-To` names the direct parent.
// Resolution prefers a thread this store has already decided on (the parent's
// thread_id) over the root id, so a thread stays whole even when a client omits
// References, or when the root itself was never delivered here.
const crypto = require('crypto');

// The column is VARCHAR(255) and a Message-ID is not bounded by anything we
// control, so an oversized root becomes a stable digest of itself.
const MAX_THREAD_ID = 255;

// `<id@host>` → `id@host`. Angle brackets are the RFC's delimiters, not part of
// the identifier, and clients disagree about whether to include them.
function normalizeId(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  const m = s.match(/^<(.+)>$/s);
  return (m ? m[1] : s).trim();
}

function headerValue(headers, name) {
  const want = name.toLowerCase();
  for (const h of Array.isArray(headers) ? headers : []) {
    if (String(h?.name || '').toLowerCase() === want) return String(h.value || '');
  }
  return '';
}

// Every message-id this message points at, root first: References in order,
// then In-Reply-To. Duplicates are dropped, order preserved.
function referencedIds(headers) {
  const raw = `${headerValue(headers, 'references')} ${headerValue(headers, 'in-reply-to')}`;
  const ids = [];
  const seen = new Set();
  for (const tok of raw.match(/<[^<>\s]+>/g) || []) {
    const id = normalizeId(tok);
    if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return ids;
}

function fit(id) {
  const s = String(id || '');
  return s.length <= MAX_THREAD_ID ? s : crypto.createHash('sha1').update(s).digest('hex');
}

// The thread id for one message, given what the store already knows.
//
// `known` maps a message-id to the thread it is already filed under. Consulting
// it first is what merges a late-arriving root into an existing thread instead
// of starting a second one.
//
// Falls back to the message's own id, and finally to its uid — a message with
// no Message-ID at all is a thread of one, which is the honest answer.
function threadIdFor(msg, known = new Map()) {
  const refs = referencedIds(msg.headers);
  for (const id of refs) {
    const t = known.get(id);
    if (t) return fit(t);
  }
  if (refs.length) return fit(refs[0]);
  const own = normalizeId(msg.messageId);
  return fit(own || String(msg.id || ''));
}

module.exports = { normalizeId, referencedIds, threadIdFor, MAX_THREAD_ID };
