// One card definition, three surfaces.
//
// The same proposal is rendered by three independent code paths: the Horst
// page's rich payload cards, the thinner timeline row, and the Telegram text
// card. Only the last had a per-kind seam (`def.tgCard`), and no kind in the
// repo ever defined one — so `todo.create`, `mission.create` and every
// app-registered kind reached the user as raw JSON on every surface.
//
// A kind now authors ONE descriptor: `card(payload, proposal)` inside
// `horst.kinds[k]`. This module projects it to whatever a surface needs, and
// EVERY surface renders through it — Telegram text, the Mini App and the Horst
// tab alike. The tab used to keep private renderers for email, calendar and
// telegram; they drifted from this file (a second family table, their own
// payload normalisation) and are gone. What the tab keeps is DECORATION: the
// calendar date tile and click-to-expand, wrapped AROUND the descriptor rather
// than replacing it.
//
// Deliberately no requires but the leaf text-safety.js. Governance calls it
// while broadcasting, and `def` is passed IN rather than looked up, so this
// file can never close the capabilities → governance → capabilities cycle.
//
// Deliberately SYNCHRONOUS. `GET /proposals` already awaits refreshPending()
// over up to 25 world-checks; a card that could await would put a second
// unbounded fan-out on the same request. Anything needing the world is a
// preview route, not a card.

// A closed set. A field kind outside it is a typo that would otherwise reach a
// surface and render as nothing — the renderers switch on exactly these.
const FIELD_KINDS = new Set(['text', 'longtext', 'chips', 'when', 'code', 'address', 'bool']);
const ACCENTS = new Set(['warn', 'danger']);

const MAX_FIELDS = 12;
const MAX_TEXT = 300;
const MAX_LONGTEXT = 4000;
// A `verbatim` longtext / code field: text the owner approves word for word
// (a remote session's prompt), never cut to an excerpt on the card itself.
const MAX_VERBATIM = 64 * 1024;
const MAX_CHIPS = 20;
// How much of a longtext / code field the text projection (Telegram) shows.
const TEXT_BODY_LIMIT = 1200;

// A verbatim field shows every character a reader cannot see as ⟨U+XXXX⟩
// (text-safety.js), so what the owner approves word for word is all on the card.
const { showInvisible } = require('../text-safety');

const str = (v, n) => String(v ?? '').slice(0, n);

// A Google event body carries start/end as `dateTime` with an offset; a card
// that understood only `start.date` rendered a blank "When" for every such
// proposal. Mirrors the GUI's isoToLocalParts, with one difference worth
// naming: this runs on the SERVER, so an offset-bearing timestamp resolves in
// the server's timezone rather than the reader's. The card has always been
// built server-side, so that is consistent with the rest of it, not new.
function localParts(s) {
  const v = String(s || '');
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(v.slice(10))) {
    const d = new Date(v);
    if (!isNaN(d)) {
      const pad = (x) => String(x).padStart(2, '0');
      return {
        date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
      };
    }
  }
  const m = v.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
  return m ? { date: m[1], time: m[2] || '' } : { date: '', time: '' };
}

// Attachment chips carry their weight, as the GUI's attChips did — "which of
// these is the 8 MB one" is part of the decision.
function sizeLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function attLabel(a) {
  if (!a) return '';
  const name = a.filename || a.name;
  if (!name) return '';
  const bytes = Number.isFinite(a.size)
    ? a.size
    : (a.base64Data ? Math.round(a.base64Data.length * 3 / 4) : 0);
  const size = sizeLabel(bytes);
  return size ? `${name} (${size})` : String(name);
}

// --- descriptor hygiene -------------------------------------------------------
// A card() is authored next to a kind, far from any surface that renders it, so
// its output is validated rather than trusted: a bad field kind is dropped here,
// not discovered as a blank row on someone's phone.

function cleanField(f) {
  if (!f || typeof f !== 'object') return null;
  if (!FIELD_KINDS.has(f.kind)) return null;
  const out = { label: str(f.label, 40), kind: f.kind };
  if (f.kind === 'chips' || f.kind === 'address') {
    const list = (Array.isArray(f.value) ? f.value : [f.value])
      .filter((v) => v != null && String(v).trim())
      .slice(0, MAX_CHIPS)
      .map((v) => str(v, MAX_TEXT));
    if (!list.length) return null;
    out.value = list;
  } else if (f.kind === 'bool') {
    out.value = !!f.value;
  } else if (f.kind === 'when') {
    out.value = str(f.value, MAX_TEXT);
    if (!out.value) return null;
    // The machine-readable twin travels beside the label so a surface can offer
    // "show me that day" without re-parsing a human string.
    if (f.iso && typeof f.iso === 'object') {
      out.iso = {
        date: str(f.iso.date, 10) || null,
        startTime: str(f.iso.startTime, 5) || null,
        allDay: !!f.iso.allDay,
      };
    }
  } else {
    const long = f.kind === 'longtext' || f.kind === 'code';
    out.value = str(f.value, long ? (f.verbatim === true ? MAX_VERBATIM : MAX_LONGTEXT) : MAX_TEXT);
    if (!out.value) return null;
    if (long && f.verbatim === true) {
      out.verbatim = true;
      out.value = showInvisible(out.value);
    }
    if (long && Number.isFinite(f.chars)) out.chars = f.chars;
  }
  return out;
}

function cleanCard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = str(raw.title, 160);
  if (!title) return null;
  const fields = (Array.isArray(raw.fields) ? raw.fields : [])
    .map(cleanField).filter(Boolean).slice(0, MAX_FIELDS);
  return {
    render: str(raw.render, 24) || 'generic',
    icon: str(raw.icon, 4) || '•',
    title,
    subtitle: str(raw.subtitle, 200) || null,
    accent: ACCENTS.has(raw.accent) ? raw.accent : null,
    fields,
    warn: str(raw.warn, 300) || null,
    footer: str(raw.footer, 200) || null,
    context: raw.context && typeof raw.context === 'object' ? raw.context : null,
  };
}

// --- built-in projectors ------------------------------------------------------
// The families the platform already knows how to talk about. App kinds are
// namespaced '<app>:<kind>', so classify on the base name — an app's calendar
// proposal deserves the same card as the platform's.

function familyOf(kind) {
  const k = String(kind || '');
  const base = k.includes(':') ? k.slice(k.indexOf(':') + 1) : k;
  if (base === 'email.send' || base === 'email' || base === 'reply') return 'email';
  if (base === 'email.modify') return 'email-modify';
  if (base === 'calendar.create' || base === 'calendar_create') return 'calendar';
  if (base === 'calendar.update' || base === 'calendar_edit') return 'calendar';
  if (base === 'calendar.invite') return 'calendar';
  if (base === 'calendar.delete' || base === 'calendar_delete') return 'calendar-delete';
  if (base === 'telegram.send' || base === 'telegram_message') return 'telegram';
  if (base === 'todo.create') return 'todo';
  return null;
}

function emailCard(p, pl) {
  const reply = !!(pl.inReplyTo || pl.threadId || /^re:/i.test(String(pl.subject || '')));
  // A composed reply keeps the model's prose and the trail it answers in
  // separate payload fields, so show them separately. MAX_LONGTEXT is 4000: a
  // long quoted trail rendered as "the body" would push the actual reply out of
  // the card, which is the one thing the reader has to check.
  const composed = typeof pl.replyText === 'string' && pl.replyText.length > 0;
  const body = composed ? pl.replyText : String(pl.body || '');
  const quoted = composed ? String(pl.quotedText || '') : '';
  const addrs = (v) => (v ? String(v).split(',').map((s) => s.trim()) : []);
  // Where this draft came from. The GUI showed these as separate lines under
  // the card; they are provenance rather than payload, so they belong in the
  // footer beside the threading note.
  const origin = [];
  if (pl.forwardOf) {
    const subj = str(pl.forwardOf.subject, 80);
    origin.push(`↪ Forward of "${subj || '(no subject)'}"${pl.forwardOf.emailId != null ? ` · message ${pl.forwardOf.emailId}` : ''}`);
  }
  if (pl.sourceEmailId != null) origin.push(`↩ Reply to message ${pl.sourceEmailId}`);
  else if (pl.inReplyTo) origin.push('↩ Reply in an existing thread');
  else if (reply) origin.push('Threaded on the original message.');
  // Where the trail came from. The verbatim claim is only true when the sender
  // actually sent a plain-text part; for HTML-only mail the quote is OUR
  // rendering of their HTML, and the card has to say so rather than present a
  // re-render as the original.
  if (quoted) {
    origin.push(pl.quoteDerived
      ? 'Trail rendered from the sender’s HTML — they sent no plain-text part'
      : 'Trail quoted verbatim from the message being replied to');
    if (pl.quoteTrimmed) origin.push('trail trimmed to fit');
  }
  return {
    render: 'email',
    icon: reply ? '↩' : '✉',
    title: str(pl.subject, 160) || '(no subject)',
    subtitle: pl.account ? `from ${str(pl.account, 120)}` : null,
    // Sending cannot be undone, so the card says so rather than a surface
    // offering an undo button that would lie.
    warn: 'Sent mail cannot be recalled.',
    fields: [
      { label: 'To', kind: 'address', value: addrs(pl.to) },
      { label: 'Cc', kind: 'address', value: addrs(pl.cc) },
      { label: 'Bcc', kind: 'address', value: addrs(pl.bcc) },
      { label: composed ? 'Reply' : 'Body', kind: 'longtext', value: body, chars: body.length },
      // Only present on a composed reply, and only when there is a trail. 'bool'
      // and 'longtext' are both already in FIELD_KINDS — the signature state is
      // readable on every surface (including Telegram) even though only the GUI
      // action row can flip it.
      ...(quoted ? [{ label: 'Quoted', kind: 'longtext', value: quoted, chars: quoted.length }] : []),
      ...(composed ? [{ label: 'Signature', kind: 'bool', value: !!pl.includeSignature }] : []),
      {
        label: 'Attachments',
        kind: 'chips',
        value: (Array.isArray(pl.attachments) ? pl.attachments : []).map(attLabel).filter(Boolean),
      },
    ],
    footer: origin.join(' · ') || null,
  };
}

function calendarCard(p, pl, { del } = {}) {
  const ev = pl.event || {};
  const title = pl.title || pl.summary || ev.summary || '(untitled)';
  const start = pl.start || ev.start;
  const end = pl.end || ev.end;

  // Two payload shapes reach this card. The flat fields are the only shape
  // that can be PROPOSED now — the engine refuses a raw Google event body — but
  // the ledger still holds pre-existing proposals in the old shape, and a
  // pending card must not render a blank "When" just because it is old.
  let date = pl.date || '';
  let startTime = pl.startTime || '';
  let endTime = pl.endTime || '';
  let allDay = !!pl.allDay;
  if (!date && start) {
    if (start.date) { allDay = true; date = start.date; }
    else if (start.dateTime) {
      const s = localParts(start.dateTime);
      date = s.date;
      startTime = s.time;
    }
  }
  if (!allDay && !endTime && end && end.dateTime) endTime = localParts(end.dateTime).time;

  let when = allDay
    ? (date ? `${date} — all day` : 'All day')
    : `${date}${startTime ? ` ${startTime}${endTime && endTime !== startTime ? `–${endTime}` : ''}` : ''}`.trim();
  // Multi-day: the end date is the difference between "Tuesday" and "all week".
  const endDate = pl.endDate || '';
  if (endDate && endDate !== date) when = `${when}${when ? ' · ' : ''}until ${endDate}`;

  const fromCal = pl.calendarId || 'primary';
  const moveTo = pl.targetCalendarId && pl.targetCalendarId !== fromCal
    ? (pl.targetCalendarName || pl.targetCalendarId)
    : '';

  const foot = [
    // The subtitle already shows the calendar when it has a name, and the
    // account otherwise. Whichever it took, the footer carries the OTHER one —
    // printing the same address twice on one card reads like a bug.
    pl.calendarName
      ? pl.account
      : (pl.calendarId && pl.calendarId !== 'primary' ? pl.calendarId : null),
    pl.eventId ? `event ${pl.eventId}` : null,
    pl.scope && pl.scope !== 'single' ? `scope: ${pl.scope}` : null,
    pl.reminderMinutes != null && Number.isFinite(Number(pl.reminderMinutes))
      ? `reminder ${pl.reminderMinutes} min before` : null,
  ].filter(Boolean).join(' · ');

  return {
    render: del ? 'calendar-delete' : 'calendar',
    icon: del ? '🗑' : '📅',
    title: str(title, 160),
    subtitle: pl.calendarName ? `in ${str(pl.calendarName, 120)}` : (pl.account ? str(pl.account, 120) : null),
    accent: del ? 'danger' : null,
    warn: del ? 'This event will be permanently deleted.' : null,
    fields: [
      { label: 'When', kind: 'when', value: when, iso: { date, startTime: startTime || null, allDay } },
      { label: 'Where', kind: 'text', value: pl.location || ev.location || '' },
      { label: 'Move to', kind: 'text', value: moveTo },
      { label: 'Meet', kind: 'text', value: pl.addMeet ? 'A Google Meet link will be added' : '' },
      {
        label: 'Guests',
        kind: 'address',
        value: (pl.attendees || ev.attendees || []).map((a) => (typeof a === 'string' ? a : a && a.email)).filter(Boolean),
      },
      { label: 'Details', kind: 'longtext', value: pl.description || ev.description || '' },
    ],
    footer: foot || null,
  };
}

function emailModifyCard(p, pl) {
  const ops = [];
  for (const f of pl.addFlags || []) ops.push(`+ ${f}`);
  for (const f of pl.removeFlags || []) ops.push(`− ${f}`);
  if (pl.move) ops.push(`move → ${pl.move}`);
  if (pl.delete) ops.push('delete');
  if (pl.restore) ops.push('restore');
  return {
    render: 'email-modify',
    icon: '🗂',
    title: `Message #${pl.uid ?? '?'}`,
    subtitle: pl.account ? str(pl.account, 120) : null,
    fields: [{ label: 'Changes', kind: 'chips', value: ops }],
  };
}

function telegramCard(p, pl) {
  const text = String(pl.text || '');
  return {
    render: 'telegram',
    icon: '✈',
    title: str(pl.chatLabel || pl.chatName || `chat ${pl.chatId ?? ''}`, 160),
    fields: [
      { label: 'Message', kind: 'longtext', value: text, chars: text.length },
      {
        label: 'Media',
        kind: 'chips',
        value: [...(pl.media || []), ...(pl.files || [])].map(attLabel).filter(Boolean),
      },
      { label: 'Location', kind: 'text', value: pl.location && pl.location.lat != null ? (pl.location.label || `${pl.location.lat}, ${pl.location.lng}`) : '' },
    ],
  };
}

function todoCard(p, pl) {
  return {
    render: 'todo',
    icon: '✓',
    title: str(pl.title, 160) || '(untitled todo)',
    fields: [
      { label: 'Due', kind: 'when', value: pl.dueAt ? String(pl.dueAt).replace('T', ' ') : '', iso: { date: String(pl.dueAt || '').slice(0, 10) || null } },
      { label: 'Notes', kind: 'longtext', value: pl.notes || '' },
      // Why this card can disappear on its own: it shares an act with the reply
      // draft that would discharge it (horst-identity).
      { label: 'Completed by', kind: 'text', value: pl.discharge && pl.discharge !== 'other' ? pl.discharge : '' },
    ],
  };
}

// The floor. Never raw JSON: a payload the platform has no opinion about still
// renders as labelled rows, which is what "every kind renders a real card"
// means. Scalars become text, everything else becomes readable code.
function genericCard(p, pl) {
  const fields = [];
  for (const [k, v] of Object.entries(pl || {})) {
    if (fields.length >= MAX_FIELDS) break;
    if (v == null || v === '') continue;
    if (typeof v === 'boolean') fields.push({ label: k, kind: 'bool', value: v });
    else if (typeof v === 'number' || typeof v === 'string') {
      const s = String(v);
      fields.push({ label: k, kind: s.length > MAX_TEXT ? 'longtext' : 'text', value: s, chars: s.length });
    } else if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) {
      fields.push({ label: k, kind: 'chips', value: v.map(String) });
    } else {
      fields.push({ label: k, kind: 'code', value: JSON.stringify(v, null, 2) });
    }
  }
  return {
    render: 'generic',
    icon: '•',
    title: str(p && p.summary, 160) || str(p && p.kind, 160) || 'Proposal',
    subtitle: p && p.kind ? str(p.kind, 120) : null,
    fields,
  };
}

// --- the entry point ----------------------------------------------------------

// cardFor(def, proposal) → a validated descriptor. NEVER throws and never
// returns null: a surface always has something to render. A kind's own card()
// wins; a throwing one degrades to the family projector, which degrades to the
// generic card — a broken card must not be able to empty the approvals list.
function cardFor(def, proposal) {
  const p = proposal || {};
  const pl = p.payload || {};

  if (typeof def?.card === 'function') {
    try {
      const clean = cleanCard(def.card(pl, p));
      if (clean) return clean;
    } catch (err) {
      console.warn(`[horst-cards] card() failed for ${p.kind}:`, err.message);
    }
  }

  try {
    switch (familyOf(p.kind)) {
      case 'email': return cleanCard(emailCard(p, pl)) || cleanCard(genericCard(p, pl));
      case 'email-modify': return cleanCard(emailModifyCard(p, pl)) || cleanCard(genericCard(p, pl));
      case 'calendar': return cleanCard(calendarCard(p, pl)) || cleanCard(genericCard(p, pl));
      case 'calendar-delete': return cleanCard(calendarCard(p, pl, { del: true })) || cleanCard(genericCard(p, pl));
      case 'telegram': return cleanCard(telegramCard(p, pl)) || cleanCard(genericCard(p, pl));
      case 'todo': return cleanCard(todoCard(p, pl)) || cleanCard(genericCard(p, pl));
      default: break;
    }
  } catch (err) {
    console.warn(`[horst-cards] projector failed for ${p.kind}:`, err.message);
  }

  return cleanCard(genericCard(p, pl)) || {
    render: 'generic', icon: '•', title: str(p.kind, 160) || 'Proposal',
    subtitle: null, accent: null, fields: [], warn: null, footer: null, context: null,
  };
}

// Text projection — Telegram has no HTML, so the same descriptor becomes lines.
// Kept here rather than in platform-horst so the card is authored once and
// projected once, whichever surface asks.
function textCard(card, { bodyLimit = TEXT_BODY_LIMIT } = {}) {
  const lines = [`${card.icon} ${card.title}`];
  if (card.subtitle) lines.push(card.subtitle);
  for (const f of card.fields) {
    if (f.kind === 'longtext' || f.kind === 'code') {
      lines.push('', `${f.label}:`, str(f.value, bodyLimit));
      if (f.chars && f.chars > bodyLimit) lines.push(`… (${f.chars - bodyLimit} more characters — open to read it all)`);
    } else if (f.kind === 'chips' || f.kind === 'address') {
      lines.push(`${f.label}: ${f.value.join(', ')}`);
    } else if (f.kind === 'bool') {
      lines.push(`${f.label}: ${f.value ? 'yes' : 'no'}`);
    } else {
      lines.push(`${f.label}: ${f.value}`);
    }
  }
  if (card.warn) lines.push('', `⚠ ${card.warn}`);
  if (card.footer) lines.push(card.footer);
  return lines.join('\n');
}

module.exports = { cardFor, textCard, familyOf, FIELD_KINDS, TEXT_BODY_LIMIT };
