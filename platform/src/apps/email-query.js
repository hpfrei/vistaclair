// The mail search query language.
//
// `from:anna subject:"ferry booking" in:inbox is:unread` is how a person
// searches mail, and every surface needs the same answer to it. my-dashboard
// parsed these operators itself and then post-filtered a widened page in
// JavaScript — which meant Horst's `email_search` and Vista could not use them
// at all, and the app's own results were bounded by whatever window it had
// pulled rather than by the store.
//
// So the language lives here, next to the engine, and compiles to SQL against
// the columns `platform_emails` already indexes. Nothing is post-filtered: an
// operator either becomes a predicate or it is not an operator.
//
//   from: to: cc: participant:/with: subject: account:/acct: in:/folder:
//   is:unread|read|starred has:attachment before: after: any: tag: -tag:
//
// `tag:` is the one operator that reads an annotation rather than a column —
// the engine's `tags` document (email-tags.js). Its value is a tag id or name;
// the caller hands `operatorSql` the vocabulary to resolve names with, so this
// stays a pure builder. A name nobody has matches nothing, never everything.
//
// Values may be quoted (`subject:"ferry booking"`); bare words stay free text
// and go to FULLTEXT and the vector search as before. An unknown key is free
// text too — `re:` in a pasted subject line is not a failed operator.

// A folder means the same thing under any of its names. The engine stores the
// provider's spelling ('INBOX', '[Gmail]/Trash', 'Junk'), so a query for one
// name has to match every spelling that denotes it.
const FOLDER_ALIASES = {
  inbox: 'inbox',
  sent: 'sent',
  archive: 'archive',
  spam: 'spam', junk: 'spam',
  trash: 'trash', deleted: 'trash', bin: 'trash',
};

// canonical folder → every stored spelling that denotes it.
const FOLDER_SPELLINGS = {
  inbox: ['inbox', '[gmail]/all mail'],
  sent: ['sent', 'sent items', 'sent mail', '[gmail]/sent mail'],
  archive: ['archive', '[gmail]/all mail'],
  spam: ['spam', 'junk', 'junk e-mail', '[gmail]/spam'],
  trash: ['trash', 'deleted', 'deleted items', 'bin', '[gmail]/trash'],
};

const EMPTY = () => ({
  from: [], to: [], cc: [], participant: [], subject: [], account: [], folder: [],
  unread: undefined, starred: undefined, hasAttachment: undefined,
  before: null, after: null, tag: [], notTag: [], text: [],
});

function parseSearchQuery(raw) {
  const q = EMPTY();
  // A quoted value stays one token, key and all: `subject:"ferry booking"`.
  const tokens = String(raw || '').match(/(?:[\w-]+:)?"[^"]*"|\S+/g) || [];
  for (const tok of tokens) {
    const m = tok.match(/^([\w-]+):(.*)$/s);
    if (!m) { q.text.push(tok); continue; }
    const key = m[1].toLowerCase();
    const val = m[2].replace(/^"|"$/g, '').trim();
    switch (key) {
      case 'from': if (val) q.from.push(val.toLowerCase()); break;
      // `to:` has always matched cc as well: a person reading their mail does
      // not distinguish "addressed to me" from "copied to me".
      case 'to': if (val) q.to.push(val.toLowerCase()); break;
      case 'cc': if (val) q.cc.push(val.toLowerCase()); break;
      // participant:/with: — any header the address can appear in.
      case 'participant': case 'with': if (val) q.participant.push(val.toLowerCase()); break;
      case 'subject': if (val) q.subject.push(val.toLowerCase()); break;
      case 'account': case 'acct': if (val) q.account.push(val.toLowerCase()); break;
      case 'in': case 'folder': if (val) q.folder.push(val.toLowerCase()); break;
      case 'is':
        if (val === 'unread') q.unread = true;
        else if (val === 'read') q.unread = false;
        else if (val === 'starred') q.starred = true;
        else q.text.push(tok);
        break;
      case 'has': if (val === 'attachment' || val === 'attachments') q.hasAttachment = true; else q.text.push(tok); break;
      case 'before': { const t = Date.parse(val); if (Number.isFinite(t)) q.before = t; else q.text.push(tok); break; }
      case 'after': { const t = Date.parse(val); if (Number.isFinite(t)) q.after = t; else q.text.push(tok); break; }
      // any: forces free text — the escape hatch for a literal `from:` in a body.
      case 'any': if (val) q.text.push(val); break;
      case 'tag': if (val) q.tag.push(val); break;
      case '-tag': if (val) q.notTag.push(val); break;
      default: q.text.push(tok); // unknown key — a colon in prose, not an operator
    }
  }
  q.hasOps = !!(q.from.length || q.to.length || q.cc.length || q.participant.length
    || q.subject.length || q.account.length || q.folder.length
    || q.unread !== undefined || q.starred !== undefined || q.hasAttachment !== undefined
    || q.before || q.after || q.tag.length || q.notTag.length);
  q.freeText = q.text.join(' ').trim();
  return q;
}

// A tag id is a JSON path segment in the predicate below. Ids the engine
// mints are slugs; an app may supply its own, so anything else is refused
// here rather than quoted into a path.
const TAG_ID_RE = /^[a-z0-9_-]+$/i;

// `tag:` value → id: an exact id first, then a case-insensitive name; null
// when the vocabulary has neither. Pure: `labels` is the caller's list.
function resolveTagId(value, labels) {
  const v = String(value || '').trim();
  if (!v) return null;
  const list = Array.isArray(labels) ? labels : [];
  const byId = list.find((l) => l && l.id === v);
  if (byId) return byId.id;
  const lc = v.toLowerCase();
  const byName = list.find((l) => l && String(l.name || '').toLowerCase() === lc);
  if (byName) return byName.id;
  return TAG_ID_RE.test(v) && !list.length ? v : null; // no vocabulary handed in: trust a slug
}

// Compile the operators to `{ where, vals }` against `platform_emails`.
// `alias` is the table alias in the caller's statement ('e.' or ''), and
// `labels` the tag vocabulary (email-engine listLabels()) for `tag:` values.
function operatorSql(q, alias = 'e.', { labels = null } = {}) {
  const where = [];
  const vals = [];
  const a = alias;
  // A message carries a tag when the platform's `tags` document names the id
  // and the owner has not tombstoned it. The alias is `t`, not `a`: the
  // caller's hasAnnotation join already uses `a` on the same table.
  const tagPredicate = (id) => {
    where.push(`EXISTS (SELECT 1 FROM platform_email_annotations t WHERE t.account = ${a}account AND t.email_uid = ${a}uid AND t.app_name = 'platform' AND t.kind = 'tags' AND JSON_EXTRACT(t.data, ?) IS NOT NULL AND JSON_VALUE(t.data, ?) IS NULL)`);
    vals.push(`$.tags."${id}"`, `$.tags."${id}".removed`);
  };
  for (const v of q.tag || []) {
    const id = resolveTagId(v, labels);
    if (id && TAG_ID_RE.test(id)) tagPredicate(id);
    else where.push('1 = 0'); // an unknown tag matches nothing, never everything
  }
  for (const v of q.notTag || []) {
    const id = resolveTagId(v, labels);
    if (!id || !TAG_ID_RE.test(id)) continue;  // excluding a tag nobody has excludes nothing
    tagPredicate(id);
    where[where.length - 1] = `NOT ${where[where.length - 1]}`;
  }
  const anyLike = (cols, values) => {
    // OR within one operator (any of the named people), AND between operators.
    const parts = [];
    for (const v of values) for (const col of cols) { parts.push(`${a}${col} LIKE ?`); vals.push(`%${v}%`); }
    if (parts.length) where.push(`(${parts.join(' OR ')})`);
  };
  if (q.from.length) anyLike(['sender'], q.from);
  if (q.to.length) anyLike(['recipient', 'cc'], q.to);
  if (q.cc.length) anyLike(['cc'], q.cc);
  // No bcc column: a blind copy is not in the recipient's own copy of the
  // message, so the header simply is not there to match.
  if (q.participant.length) anyLike(['sender', 'recipient', 'cc'], q.participant);
  // Subject terms are ANDed — `subject:ferry subject:booking` narrows.
  for (const v of q.subject) { where.push(`${a}subject LIKE ?`); vals.push(`%${v}%`); }
  if (q.account.length) anyLike(['account'], q.account);
  if (q.folder.length) {
    const names = new Set();
    for (const f of q.folder) {
      const canonical = FOLDER_ALIASES[f] || f;
      for (const n of FOLDER_SPELLINGS[canonical] || [canonical]) names.add(n);
    }
    where.push(`LOWER(${a}folder) IN (${[...names].map(() => '?').join(', ')})`);
    vals.push(...names);
  }
  if (q.unread !== undefined) { where.push(`${a}is_unread = ?`); vals.push(q.unread ? 1 : 0); }
  if (q.starred !== undefined) { where.push(`${a}is_starred = ?`); vals.push(q.starred ? 1 : 0); }
  if (q.hasAttachment) where.push(`JSON_LENGTH(${a}attachment_meta) > 0`);
  if (q.after) { where.push(`${a}date >= ?`); vals.push(new Date(q.after)); }
  if (q.before) { where.push(`${a}date < ?`); vals.push(new Date(q.before)); }
  return { where, vals };
}

module.exports = { parseSearchQuery, operatorSql, resolveTagId, FOLDER_ALIASES, FOLDER_SPELLINGS };
