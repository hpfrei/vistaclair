// Reply composition — the one place an outgoing reply is assembled.
//
// The drafting model returns PROSE ONLY. Everything else about the mail — the
// quoted trail, the signature, the threading headers, the subject, and both
// MIME parts — is stitched here, deterministically, from data. Two consequences
// that are the whole point:
//
//   * Nothing the model writes reaches a header, and the trail is the parent
//     message itself rather than the model's recollection of it. A model that
//     echoes the original has its echo stripped (enforceReplyOnly) instead of
//     sent.
//   * The plain-text and HTML parts are never written separately. Both come out
//     of renderParts() in one call, over one block list, so they cannot drift.
//
// Takes data, never fetches it: no require of email-engine, governance or
// triage, so it cannot close a cycle and its tests need no DB and no model.
// email-engine calls INTO this module for stripSubjectPrefixes; never the
// reverse.
const crypto = require('node:crypto');
const { htmlToMarkdownish, htmlToPlainQuote } = require('./email-content');

// Bumped whenever rendering changes. The freeze-time assertion in email.send's
// validate is gated on it, so a rendering change leaves already-pending
// proposals frozen and sendable instead of retroactively invalid.
const COMPOSE_VERSION = 1;

// proposals.json is rewritten whole on every save and holds up to 300 items, so
// an uncapped marketing-mail trail is re-serialised 300x on every write.
const MAX_QUOTE_TEXT = 32 * 1024;
const MAX_QUOTE_HTML = 128 * 1024;

// What survives stripping has to be a reply, but LENGTH is the wrong test for
// that: "Danke." and "Will do." are complete, ordinary answers, and a character
// floor high enough to catch a stripped-to-nothing draft also throws those
// away. Require meaning instead of bulk — at least one letter or digit.
const HAS_CONTENT_RE = /[\p{L}\p{N}]/u;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Reply/forward prefixes across the languages the accounts actually see, so
// "Re: Re: AW: Rechnung" and "Rechnung" collapse onto one stem. Case and
// spacing of the REMAINDER are preserved — this is used both to build a display
// subject and (via email-engine.normalizeSubject) to build a matching key.
const SUBJECT_PREFIX_RE = /^\s*(?:re|aw|antw|antwort|fwd?|wg|tr|rv|sv|vs|res|enc)\s*(?:\[\d+\])?\s*:\s*/i;

function stripSubjectPrefixes(subject) {
  let s = String(subject == null ? '' : subject);
  let prev;
  do { prev = s; s = s.replace(SUBJECT_PREFIX_RE, ''); } while (s !== prev);
  return s;
}

// Headers arrive as [{ name, value }] from both sync paths, but mailparser
// lowercases names on the IMAP path while Gmail preserves them — so every
// lookup has to be case-insensitive or half the accounts silently miss.
function headerValues(headers, name) {
  if (!Array.isArray(headers)) return [];
  const want = String(name).toLowerCase();
  return headers
    .filter((h) => h && String(h.name).toLowerCase() === want)
    .map((h) => String(h.value == null ? '' : h.value));
}

// Message-IDs are matched and emitted in their angle-bracket form; senders are
// inconsistent about supplying it.
function normalizeMsgId(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const m = s.match(/<[^>]+>/);
  if (m) return m[0];
  return `<${s.replace(/^<|>$/g, '')}>`;
}

function msgIdTokens(values) {
  const out = [];
  for (const v of values) {
    const found = String(v).match(/<[^>]+>/g);
    if (found) out.push(...found);
    else if (String(v).trim()) out.push(normalizeMsgId(v));
  }
  return out;
}

// Deterministic on purpose: toLocaleString would make the attribution line (and
// therefore every test over it) depend on the host locale and timezone.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatQuoteDate(v) {
  const d = new Date(v);
  if (!v || isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} at ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// ---------------------------------------------------------------------------
// Requirement 1 — the model returns the reply only, ENFORCED
// ---------------------------------------------------------------------------

// Full-line matches only. A legitimate reply may open "On Tuesday we agreed…",
// and cutting there would silently truncate the user's actual message.
const TRAIL_MARKERS = [
  /^\s*>/,
  /^\s*-{2,}\s*(?:original message|ursprüngliche nachricht|message d'origine|mensaje original|messaggio originale)\s*-{2,}\s*$/i,
  /^_{10,}\s*$/,
  // The verb is not always last: English puts the name before it ("Anna
  // wrote:"), German after it ("schrieb Anna:"). Allow a short tail either way.
  /^\s*(?:on|am|le|el|il)\b.{0,200}\b(?:wrote|schrieb|schreef|a écrit|escribió|ha scritto)\b.{0,80}:\s*$/i,
];

// An Outlook-style forwarded header block: "From:" alone is too common in
// ordinary prose, so it only counts when a sibling header follows it closely.
function isForwardHeaderBlock(lines, i) {
  if (!/^\s*(?:from|von|de|da|van)\s*:/i.test(lines[i])) return false;
  return lines.slice(i + 1, i + 5)
    .some((l) => /^\s*(?:sent|gesendet|date|datum|to|an|enviado|a)\s*:/i.test(l));
}

function findTrailStart(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (TRAIL_MARKERS.some((re) => re.test(lines[i]))) return i;
    if (isForwardHeaderBlock(lines, i)) return i;
  }
  return -1;
}

function normalizeWords(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

// Containment rather than similarity: a short reply quoting a long mail should
// trip, and |draft ∩ parent| / |draft| is the direction that catches it.
function echoContainment(draftWords, parentWords, n = 8) {
  if (draftWords.length < n) return 0;
  const parentGrams = new Set();
  for (let i = 0; i + n <= parentWords.length; i++) parentGrams.add(parentWords.slice(i, i + n).join(' '));
  let hit = 0;
  let total = 0;
  for (let i = 0; i + n <= draftWords.length; i++) {
    total += 1;
    if (parentGrams.has(draftWords.slice(i, i + n).join(' '))) hit += 1;
  }
  return total ? hit / total : 0;
}

// A long verbatim run is damning even when overall containment is low (the
// model wrote two fresh sentences and then pasted a paragraph).
function hasLongSharedRun(draftWords, parentText, run = 40) {
  if (draftWords.length < run) return false;
  for (let i = 0; i + run <= draftWords.length; i++) {
    if (parentText.includes(draftWords.slice(i, i + run).join(' '))) return true;
  }
  return false;
}

function stripTrailingSignature(text, signature) {
  const sig = String(signature || '').trim();
  if (!sig) return text;
  const sigWords = normalizeWords(sig).join(' ');
  if (!sigWords) return text;
  const lines = text.split('\n');
  // Scan from the END and require the tail to BE the signature, not merely to
  // end with it. Scanning forward with endsWith matches at line 0 for any
  // message that closes with the signature — which strips the entire reply.
  const floor = Math.max(0, lines.length - 12);
  for (let i = lines.length - 1; i >= floor; i--) {
    const tail = normalizeWords(lines.slice(i).join(' ')).join(' ');
    if (tail && tail === sigWords) {
      return lines.slice(0, i).join('\n').replace(/\s*--\s*$/, '').trimEnd();
    }
  }
  return text;
}

/**
 * The prompt is advice; this is the enforcement. Returns the reply text with
 * any echoed original removed, or ok:false when what remains is not a reply.
 */
function enforceReplyOnly(raw, { parent, signature } = {}) {
  const stripped = { quoteCutAt: null, signature: false, echoRatio: 0, longestRun: false };
  let text = String(raw == null ? '' : raw).replace(/\r\n/g, '\n').trim();
  if (!text) return { ok: false, text: '', reason: 'empty', stripped };

  const lines = text.split('\n');
  const cut = findTrailStart(lines);
  if (cut === 0) {
    return { ok: false, text: '', reason: 'quote-only', stripped: { ...stripped, quoteCutAt: 0 } };
  }
  if (cut > 0) {
    stripped.quoteCutAt = cut;
    text = lines.slice(0, cut).join('\n').trimEnd();
  }

  const before = text;
  text = stripTrailingSignature(text, signature);
  stripped.signature = text !== before;

  text = text.trim();
  if (!HAS_CONTENT_RE.test(text)) {
    return { ok: false, text, reason: 'empty-after-strip', stripped };
  }

  // Echo checks run on the RESIDUE — truncating at a marker is the benign case,
  // and what matters is whether what's left is the model's own words.
  const parentWords = normalizeWords(parent?.body || parent?.snippet || '');
  if (parentWords.length) {
    const draftWords = normalizeWords(text);
    const parentText = parentWords.join(' ');
    stripped.longestRun = hasLongSharedRun(draftWords, parentText);
    if (stripped.longestRun) return { ok: false, text, reason: 'verbatim-run', stripped };

    // Below three 8-grams there is nothing to measure; a short legitimate reply
    // ("Ja, passt — Donnerstag 10 Uhr.") would otherwise be rejected at random.
    if (draftWords.length >= 8 + 2) {
      stripped.echoRatio = echoContainment(draftWords, parentWords);
      if (stripped.echoRatio > 0.5) return { ok: false, text, reason: 'echo', stripped };
    }
  }

  return { ok: true, text, reason: null, stripped };
}

// ---------------------------------------------------------------------------
// Requirement 2 — the quoted trail, verbatim
// ---------------------------------------------------------------------------

/**
 * The trail is the PARENT MESSAGE, not a reconstruction: its own body already
 * embeds the prior history, and thread reassembly is impossible outside Gmail
 * anyway (IMAP sets thread_id to the message's own uid).
 *
 * `derived` records the one case where "verbatim" would be a lie: for mail with
 * no real text/plain part, the engine backfills `body` with its own HTML
 * rendering at ingest and keeps no flag saying so. Quoting that is quoting
 * ourselves, and the card says as much.
 */
function buildQuote(parent) {
  const plain = String(parent?.body || '').trim();
  const html = String(parent?.htmlBody || '').trim();

  const renderedFromHtml = html ? htmlToMarkdownish(html) : '';
  const hasRealPlain = !!plain && plain !== renderedFromHtml;

  let source;
  let derived;
  if (hasRealPlain) {
    source = plain;
    derived = false;
  } else if (html) {
    // Fidelity-tuned conversion, not the legibility one: a quote is evidence.
    source = htmlToPlainQuote(html);
    derived = true;
  } else {
    source = plain || String(parent?.snippet || '');
    derived = false;
  }

  const sha256 = crypto.createHash('sha256').update(source, 'utf8').digest('hex');

  let trimmed = false;
  if (source.length > MAX_QUOTE_TEXT) {
    source = source.slice(0, MAX_QUOTE_TEXT);
    trimmed = true;
  }

  const who = String(parent?.from || '').trim() || 'someone';
  const when = formatQuoteDate(parent?.date);
  const attribution = when ? `On ${when}, ${who} wrote:` : `${who} wrote:`;

  const lines = source.split('\n');
  const text = lines.map((l) => (l.trim() === '' ? '>' : `> ${l}`)).join('\n')
    + (trimmed ? '\n>\n> […] trail trimmed' : '');

  let htmlQuote = lines.map((l) => escapeHtml(l)).join('<br>')
    + (trimmed ? '<br><br>[…] trail trimmed' : '');
  if (htmlQuote.length > MAX_QUOTE_HTML) {
    htmlQuote = escapeHtml(source.slice(0, 8000)) + '<br><br>[…] trail trimmed';
    trimmed = true;
  }

  return { attribution, text, html: htmlQuote, derived, sha256, trimmed };
}

// ---------------------------------------------------------------------------
// Threading
// ---------------------------------------------------------------------------

/**
 * RFC 5322 §3.6.4: References is the parent's own chain plus the parent itself.
 * Sending only the parent Message-ID (what this used to do) fragments long
 * threads in strict clients.
 */
function replyHeaders(parent, { account } = {}) {
  const parentId = normalizeMsgId(parent?.messageId);
  const priorRefs = msgIdTokens(headerValues(parent?.headers, 'references'));
  const priorReply = msgIdTokens(headerValues(parent?.headers, 'in-reply-to'));

  let chain = (priorRefs.length ? priorRefs : priorReply).slice();
  if (parentId) chain.push(parentId);
  chain = chain.filter((v, i) => v && chain.indexOf(v) === i);

  // Bounded so a 200-message thread cannot produce an oversized header; the
  // root and the recent tail are what clients actually use to stitch.
  if (chain.length > 21) chain = [chain[0], ...chain.slice(-20)];

  // The subject is DERIVED from the parent's — untrusted mail — and `to` comes
  // straight off its From. Both are header-bound, so a line break in either is
  // a header injection. The transport strips too; cleaning it here means the
  // stored payload is never the dirty thing in the first place.
  const oneLine = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();

  return {
    to: oneLine(parent?.from),
    subject: oneLine(`Re: ${stripSubjectPrefixes(parent?.subject).trim()}`),
    inReplyTo: parentId || undefined,
    references: chain.length ? chain.join(' ') : undefined,
    threadId: parent?.threadId || undefined,
    account: account || parent?.account,
  };
}

// ---------------------------------------------------------------------------
// The one-source seam
// ---------------------------------------------------------------------------

// Single quotes inside the font stack are not cosmetic: these strings are
// emitted into style="…", so a double-quoted family name would close the
// attribute and corrupt the whole message.
const HTML_ROOT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
  + 'font-size:15px;line-height:1.55;color:#1a1a1a;max-width:680px';
const HTML_QUOTE = 'margin:1.5em 0 0;padding:0 0 0 1em;border-left:2px solid #d0d7de;color:#57606a';
const HTML_ATTR = 'margin:1.5em 0 0;font-size:13px;color:#57606a';
const HTML_SIG = 'margin:1.5em 0 0;font-size:13px;color:#666';

const URL_RE = /(https?:\/\/[^\s<>()]+|[^\s<>()@]+@[^\s<>()@]+\.[a-z]{2,})/gi;

// Escape first, link second — but link over the RAW text and escape the pieces,
// so an & inside a URL survives in the href instead of becoming &amp;.
function inlineHtml(text) {
  const out = [];
  let last = 0;
  const s = String(text == null ? '' : text);
  for (const m of s.matchAll(URL_RE)) {
    out.push(escapeHtml(s.slice(last, m.index)));
    const raw = m[0];
    const href = raw.includes('@') && !/^https?:/i.test(raw) ? `mailto:${raw}` : raw;
    out.push(`<a href="${escapeHtml(href)}" style="color:#0969da">${escapeHtml(raw)}</a>`);
    last = m.index + raw.length;
  }
  out.push(escapeHtml(s.slice(last)));
  return out.join('').replace(/\n/g, '<br>');
}

function renderText(blocks) {
  const parts = [];
  for (const b of blocks) {
    if (b.type === 'para') parts.push({ sep: '\n\n', s: b.text });
    else if (b.type === 'sig-sep') parts.push({ sep: '\n\n', s: '-- ' }); // RFC 3676 §4.3; the trailing space is load-bearing
    else if (b.type === 'signature') parts.push({ sep: '\n', s: b.text });
    else if (b.type === 'attribution') parts.push({ sep: '\n\n', s: b.text });
    else if (b.type === 'quote') parts.push({ sep: '\n', s: b.text });
  }
  return parts.reduce((acc, p, i) => (i === 0 ? p.s : acc + p.sep + p.s), '').trim();
}

function renderHtml(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === 'para') out.push(`<p style="margin:0 0 1em">${inlineHtml(b.text)}</p>`);
    else if (b.type === 'sig-sep') continue; // the styled block below carries the separation visually
    else if (b.type === 'signature') out.push(`<div style="${HTML_SIG}">${b.html}</div>`);
    else if (b.type === 'attribution') out.push(`<div style="${HTML_ATTR}">${escapeHtml(b.text)}</div>`);
    else if (b.type === 'quote') out.push(`<blockquote type="cite" style="${HTML_QUOTE}">${b.html}</blockquote>`);
  }
  return `<div style="${HTML_ROOT}">${out.join('')}</div>`;
}

/**
 * THE seam. The only exported way to produce either MIME part, and it returns
 * both — so there is no code path in this module that writes body without
 * htmlBody. Blocks either supply both sides (quote, signature) or neither.
 */
function renderParts(blocks) {
  const list = (blocks || []).filter(Boolean);
  return { text: renderText(list), html: renderHtml(list) };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

function signatureBlocks({ signatureText, signatureHtml, includeSignature }) {
  const text = String(signatureText || '').trim();
  const html = String(signatureHtml || '').trim();
  if (!includeSignature || (!text && !html)) return [];
  // An empty HTML field falls back to the generated rendering, so nobody is
  // forced to hand-write HTML to get a signature.
  const htmlSide = html || inlineHtml(text);
  return [{ type: 'sig-sep' }, { type: 'signature', text: text || stripTags(html), html: htmlSide }];
}

// Only used for the text side of an HTML-only signature — a crude strip is
// right here: the authored HTML is the source of truth for the HTML part.
function stripTags(html) {
  return String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\s+\n/g, '\n').trim();
}

function blocksFor({ replyText, quote, signatureText, signatureHtml, includeSignature }) {
  const paras = String(replyText || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((text) => ({ type: 'para', text }));
  return [
    ...paras,
    ...signatureBlocks({ signatureText, signatureHtml, includeSignature }),
    ...(quote ? [{ type: 'attribution', text: quote.attribution }, { type: 'quote', text: quote.text, html: quote.html }] : []),
  ];
}

/**
 * Build the full email.send payload fragment for a reply. Everything needed to
 * re-stitch later is stored alongside the derived parts, so the signature
 * toggle costs no model call and no settings read — and editing an account's
 * signature never silently rewrites a proposal already awaiting approval.
 */
function composeReply(parent, { replyText, signatureText, signatureHtml, includeSignature, account } = {}) {
  const quote = buildQuote(parent);
  const headers = replyHeaders(parent, { account });
  const parts = renderParts(blocksFor({ replyText, quote, signatureText, signatureHtml, includeSignature }));

  return {
    account: headers.account,
    to: headers.to,
    subject: headers.subject,
    inReplyTo: headers.inReplyTo,
    references: headers.references,
    threadId: headers.threadId,

    body: parts.text,
    htmlBody: parts.html,

    replyText: String(replyText || ''),
    quotedText: quote.text,
    quotedHtml: quote.html,
    quoteAttribution: quote.attribution,
    quoteDerived: quote.derived || undefined,
    quoteSha256: quote.sha256,
    quoteTrimmed: quote.trimmed || undefined,

    includeSignature: !!includeSignature,
    signatureText: String(signatureText || ''),
    signatureHtml: String(signatureHtml || ''),
    composeVersion: COMPOSE_VERSION,
  };
}

/**
 * The governance `compose` hook: recompute the derived parts from the sources
 * already in the payload. This is what makes it impossible for any client, on
 * any surface, to freeze a payload whose body disagrees with its own sources —
 * the browser posts a flag, the server decides what that flag means.
 *
 * Payloads with no replyText (hand-composed sends, app kinds) pass through
 * untouched.
 */
function recompose(payload) {
  const p = payload || {};
  if (!p.replyText) return payload;

  const quote = p.quotedText
    ? { attribution: p.quoteAttribution || '', text: p.quotedText, html: p.quotedHtml || '' }
    : null;
  const parts = renderParts(blocksFor({
    replyText: p.replyText,
    quote,
    signatureText: p.signatureText,
    signatureHtml: p.signatureHtml,
    includeSignature: p.includeSignature,
  }));

  return { ...p, body: parts.text, htmlBody: parts.html, composeVersion: COMPOSE_VERSION };
}

module.exports = {
  COMPOSE_VERSION,
  stripSubjectPrefixes,
  headerValues,
  normalizeMsgId,
  enforceReplyOnly,
  buildQuote,
  replyHeaders,
  renderParts,
  composeReply,
  recompose,
  escapeHtml,
};
