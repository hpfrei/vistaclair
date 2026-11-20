// Prior-action check — "has this already been done?"
//
// Every gated action reaches the user as a proposal (horst-governance.js), and
// until now it was staged blind: triage would offer to add an event that is
// already in the calendar, or to send a reply the user had already written from
// their phone. Approving produced a duplicate, and the only way to notice was to
// remember.
//
// This module answers the question against the real world — the calendar store,
// the sent-mail log, the synced Sent folder — and returns a VERDICT. Governance
// persists that verdict on the proposal (`prior`), so it survives a GUI reload,
// and re-runs it while the proposal is pending, so something done manually after
// staging still lands on the card.
//
// Three states:
//   'done'    — the action has already been taken; approving repeats it.
//   'partial' — a matching calendar event exists, but this proposal carries MORE
//               (a location it lacks, guests, a concrete time). Carries a
//               `suggest` payload that turns the create into an update.
//   'none'    — nothing found (returned as null; callers treat both alike).
//
// Checkers are looked up by kind, so app-registered kinds can be supported later
// without touching governance. App kinds ('<app>:<kind>') are matched on their
// base name for INFORMATIONAL verdicts only — never a `suggest`, because their
// executors are app-defined callbacks that would not understand a platform
// payload.
//
// Everything here is best-effort: a checker that throws (DB down, calendar not
// connected) yields no verdict rather than blocking the proposal.

const emailEngine = require('../email-engine');
const calendarEngine = require('../calendar-engine');

const DAY_MS = 24 * 60 * 60 * 1000;

// --- Semantic similarity (ADDITIVE evidence only — thresholds unchanged) ---
//
// platform_calendar_events.embedding already exists (email-embed.js sweeps
// it), reached here through calendarEngine.listEvents({similarSearch: true}),
// which embeds the query with the same recipe the stored vectors used and
// returns each semantic hit's cosine distance as `_dist`. Per the follow-up
// note (docs/governance.md) this signal WIDENS the evidence shown on the
// card, it never loosens the deterministic matcher: a missed duplicate is
// recoverable, a wrong conversion is a silently edited event. Two uses:
//   • a deterministic match gains a corroborating "meaning match" line when
//     the stored vector agrees (sim ≥ SEMANTIC_EVIDENCE_SIM);
//   • a candidate in the 0.45 title band that failed ONLY the clock/anchor
//     test may be promoted when the vectors are near-identical (sim ≥
//     SEMANTIC_PROMOTE_SIM) — and a promoted match is flagged informational
//     ('done'), NEVER converted into an update.
// Calibration (multilingual-e5-small, docs/horst.md "Memory"): the same content across
// DE↔EN measures dist ≈ 0.08 (sim ≈ 0.92); unrelated content ≥ 0.20 (sim ≤
// 0.80). The promotion floor sits above anything unrelated ever scores.
// Rows whose embedding is still NULL (fresh sync, vectors disabled) are
// simply absent from the semantic result and change nothing — the
// deterministic matcher stands alone.
const SEMANTIC_EVIDENCE_SIM = 0.85; // corroboration shown on the card
const SEMANTIC_PROMOTE_SIM = 0.9;   // 0.45-band promotion floor — deliberately conservative

// ---------------------------------------------------------------------------
// Text + time helpers
// ---------------------------------------------------------------------------

// Comparable form of a title: lowercase, diacritics folded, punctuation gone.
// "Board Meeting (Q3) — Berlin" and "board meeting q3 berlin" collapse together.
function normText(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Token Jaccard, with a containment boost: an extraction that adds words to the
// title it took from ("Board meeting" vs "Board meeting with legal") should read
// as the same event, which raw Jaccard would score too low.
function titleSimilarity(a, b) {
  const na = normText(a);
  const nb = normText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = new Set(na.split(' ').filter(Boolean));
  const tb = new Set(nb.split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const jaccard = inter / (ta.size + tb.size - inter);
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (shorter.length >= 4 && longer.includes(shorter)) return Math.max(jaccard, 0.9);
  return jaccard;
}

// Words that carry no identity in the languages one calendar mixes. Kept
// deliberately short: this is not a stopword list for search, only a filter that
// stops "Termin"/"appointment"/"mit" from counting as a shared anchor.
const STOP_ANCHORS = new Set([
  'with', 'and', 'the', 'for', 'from', 'about',
  'bei', 'mit', 'und', 'der', 'die', 'das', 'von', 'zum', 'zur', 'beim', 'uhr',
  'avec', 'pour', 'chez',
  'termin', 'appointment', 'appt', 'meeting', 'call', 'event', 'reminder',
  'erinnerung', 'besuch',
]);

// The identifying words of a title: names, places, procedures. Short words and
// scaffolding are dropped — what remains is what survives a translation.
function anchorTokens(s) {
  return normText(s).split(' ').filter((t) => t.length >= 4 && !STOP_ANCHORS.has(t));
}

function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// How many identifying words two titles share, tolerant of the morphology a
// language switch introduces: 'physiotherapy' and 'physiotherapie' have a
// 12-character common prefix and count as ONE anchor, with no translation table.
//
// Counting is deliberately all this returns. Weighting a single long anchor as
// "strong enough on its own" was tried and is wrong: 'physiotherapy' is 13
// characters and shared by every physio appointment, so "Physiotherapy with
// Marta Keller" matched Claudia's slot. Two anchors is the floor — a category
// word plus a name, or two halves of a name.
function sharedAnchors(a, b) {
  const pool = new Set(anchorTokens(b));
  let n = 0;
  for (const t of anchorTokens(a)) {
    let hit = null;
    if (pool.has(t)) hit = t;
    else {
      for (const u of pool) {
        if (t.length >= 6 && u.length >= 6 && commonPrefixLen(t, u) >= 5) { hit = u; break; }
      }
    }
    if (!hit) continue;
    pool.delete(hit);
    n++;
  }
  return n;
}

// Wall-clock {date,time} of an instant as seen in a given timezone. Calendar
// comparison has to happen in the calendar's own local time — an event at 14:00
// Berlin and a proposal for "14:00" are the same time, and their UTC instants
// are not.
function wallClock(iso, timeZone) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || undefined,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const g = (t) => parts.find((p) => p.type === t)?.value;
    const hour = g('hour') === '24' ? '00' : g('hour');
    return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${hour}:${g('minute')}` };
  } catch {
    return null;
  }
}

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d)) return dateStr;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function bareAddress(s) {
  const m = /<([^>]+)>/.exec(String(s || ''));
  return (m ? m[1] : String(s || '')).trim().toLowerCase();
}

function addressList(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map((x) => bareAddress(typeof x === 'string' ? x : x?.email)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Calendar payload normalization
//
// Flattens a calendar payload to one comparable record. New proposals carry
// simple fields or bare start/end objects; the raw Google `event` body is no
// longer accepted on write, but is still read here because this matches against
// the DECISION LEDGER, which holds proposals staged before that changed. Drop
// the fallback and Horst stops recognising an event he already created, and
// proposes it a second time. Mirrors public/horst/horst.js calFields so card
// and check agree on what a payload says.
// ---------------------------------------------------------------------------

function normalizeProposedEvent(pl) {
  const ev = pl.event || {};
  const out = {
    title: pl.title || pl.summary || ev.summary || '',
    location: pl.location || ev.location || '',
    description: pl.description || ev.description || '',
    attendees: addressList(pl.attendees || ev.attendees),
    allDay: !!pl.allDay,
    date: pl.date || '',
    endDate: pl.endDate || '',
    startTime: pl.startTime || '',
    endTime: pl.endTime || '',
    account: pl.account || null,
    calendarId: pl.calendarId || null,
  };
  const start = pl.start || ev.start;
  const end = pl.end || ev.end;
  if (!out.date && start) {
    if (start.date) { out.allDay = true; out.date = start.date; }
    else if (start.dateTime) {
      const wc = wallClock(start.dateTime, start.timeZone);
      if (wc) { out.date = wc.date; out.startTime = wc.time; }
    }
  }
  if (!out.allDay && !out.endTime && end?.dateTime) {
    const wc = wallClock(end.dateTime, end.timeZone || start?.timeZone);
    if (wc) out.endTime = wc.time;
  }
  if (out.allDay) { out.startTime = ''; out.endTime = ''; }
  return out;
}

// Same record, from a stored event as returned by calendarEngine.listEvents.
function normalizeStoredEvent(e) {
  const allDay = !!e.start?.date;
  const tz = e.start?.timeZone || null;
  const startWc = allDay ? null : wallClock(e.start?.dateTime, tz);
  const endWc = allDay ? null : wallClock(e.end?.dateTime, e.end?.timeZone || tz);
  return {
    title: e.summary || '',
    location: e.location || '',
    description: e.description || '',
    attendees: addressList(e.attendees),
    allDay,
    date: allDay ? e.start.date : (startWc?.date || ''),
    endDate: allDay ? e.end?.date : null,
    startTime: startWc?.time || '',
    endTime: endWc?.time || '',
    recurring: !!(e.recurringEventId || (e.recurrence || []).length),
    raw: e,
  };
}

// ---------------------------------------------------------------------------
// Calendar checkers
// ---------------------------------------------------------------------------

// A triage sweep commonly stages several events for the SAME day, and the
// pending-refresh pass re-checks them together — without this they would each
// re-query the day. The window is deliberately tiny: long enough to collapse one
// burst, far too short to serve a stale calendar to a later check.
const DAY_CACHE_MS = 5000;
const dayCache = new Map(); // `${date}|${account}` → { at, promise }

function dayQuery(date, account, fresh) {
  const key = `${date}|${account}`;
  const hit = dayCache.get(key);
  // `fresh` is the event-driven path (calendar:changed just fired): reacting to a
  // change by reading a cache written before it would defeat the whole point.
  if (!fresh && hit && Date.now() - hit.at < DAY_CACHE_MS) return hit.promise;
  const timeMin = `${shiftDate(date, -1)}T00:00:00.000Z`;
  const timeMax = `${shiftDate(date, 1)}T23:59:59.000Z`;
  const promise = calendarEngine.listEvents({ account, timeMin, timeMax, limit: 250 })
    .then((r) => (r.events || []).filter((e) => !e._cancelled))
    .catch(() => []); // one unreachable account must not blind the others
  dayCache.set(key, { at: Date.now(), promise });
  if (dayCache.size > 64) {
    for (const [k, v] of dayCache) { if (Date.now() - v.at >= DAY_CACHE_MS) dayCache.delete(k); }
  }
  return promise;
}

async function dayCandidates(date, account, fresh) {
  const accounts = account ? [account] : calendarEngine.calendarAccounts();
  if (!accounts.length) return [];
  const perAccount = await Promise.all(accounts.map((acct) => dayQuery(date, acct, fresh)));
  return perAccount.flat();
}

// Drop the day cache — for callers that know the calendar just changed.
function invalidate() { dayCache.clear(); }

// Does this stored event describe the same appointment as the proposal?
//
// Two axes, and the CLOCK is a first-class one. Title similarity alone used to
// gate everything: below 0.45 the check returned false without ever comparing
// times, which made it blind to the most common real case — an AI extraction
// writing the title in English ("Physiotherapy with Claudia Unterladstätter")
// against the German original the calendar holds ("HP: Physiotherapie bei
// Claudia Unterladstätter"). Token Jaccard scores that 0.29, so four
// already-existing appointments were staged as new.
//
// So: a weak title still matches when the day and the minute agree AND the two
// titles share at least two distinctive words. That is strict enough that
// "Physiotherapy with Marta Keller" does not collapse into Claudia's 11:00 slot
// (one shared anchor, the procedure), nor "Lunch with Anna" into "Lunch with
// Peter".
function isSameEvent(p, s) {
  if (s.date !== p.date) return false;
  const sim = titleSimilarity(p.title, s.title);
  if (sim >= 0.75) return true;

  const pm = toMinutes(p.startTime);
  const sm = toMinutes(s.startTime);
  const bothTimed = pm != null && sm != null;
  const anchored = sharedAnchors(p.title, s.title) >= 2;

  if (sim >= 0.45) {
    if (p.allDay && s.allDay) return true;
    if (bothTimed) return Math.abs(pm - sm) <= 30;
    // One side never got a time (a date-only extraction, or an all-day entry
    // against a timed one): the day plus the shared names is all there is.
    return anchored;
  }

  if (!anchored) return false;
  // Same day, same minute, and the titles name the same thing twice over.
  // Without a clock on both sides the day and the anchors have to carry it.
  return bothTimed ? Math.abs(pm - sm) <= 30 : true;
}

// Same question between two PROPOSAL payloads rather than proposal-vs-stored:
// "do these two cards describe one appointment?". Used by governance to collapse
// a pending twin staged from a different email, and to recognise an event the
// user already denied — both of which arrive as payloads, never as stored events.
function sameEventPayloads(a, b) {
  const pa = normalizeProposedEvent(a || {});
  const pb = normalizeProposedEvent(b || {});
  if (!pa.date || !pb.date || !pa.title || !pb.title) return false;
  // isSameEvent reads `s` as a stored event; a normalized payload carries the
  // same fields it looks at (date/title/allDay/startTime), so it is symmetric here.
  return isSameEvent(pa, pb);
}

function bestMatch(p, stored) {
  let best = null;
  let bestSim = 0;
  for (const s of stored) {
    if (!isSameEvent(p, s)) continue;
    const sim = titleSimilarity(p.title, s.title);
    if (sim > bestSim) { bestSim = sim; best = s; }
  }
  return best;
}

// Same-day candidates whose TITLE landed in the 0.45 band but whose clock/
// anchor evidence did not carry them — the only pool semantic promotion may
// draw from. Best title first, so ties resolve the same way bestMatch does.
function bandCandidates(p, stored) {
  return stored
    .map((s) => ({ s, sim: titleSimilarity(p.title, s.title) }))
    .filter((x) => x.s.date === p.date && x.sim >= 0.45 && x.sim < 0.75 && !isSameEvent(p, x.s))
    .sort((a, b) => b.sim - a.sim)
    .map((x) => x.s);
}

// Plain-word query text for the semantic pass. Deliberately normText'd: the
// similarSearch path also runs the text through a BOOLEAN-mode FULLTEXT match,
// where raw punctuation (quotes, parens) is operator syntax.
function semanticQueryText(p) {
  return [p.title, p.location].map((s) => normText(s)).filter(Boolean).join(' ').slice(0, 500);
}

// eventId → cosine distance between the proposed event and each stored vector
// in the proposal's day window. One embed + ANN pass per account, best-effort:
// any failure (vectors disabled, embed cold, FULLTEXT hiccup) yields null and
// the check proceeds without semantic evidence.
async function semanticDistances(p) {
  const text = semanticQueryText(p);
  if (!text) return null;
  const accounts = p.account ? [p.account] : calendarEngine.calendarAccounts();
  if (!accounts.length) return null;
  const timeMin = `${shiftDate(p.date, -1)}T00:00:00.000Z`;
  const timeMax = `${shiftDate(p.date, 1)}T23:59:59.000Z`;
  const map = new Map();
  for (const account of accounts) {
    try {
      const r = await calendarEngine.listEvents({ account, q: text, similarSearch: true, timeMin, timeMax, limit: 30 });
      for (const e of r?.events || []) {
        // Keyword-fused rows carry no _dist; only true vector hits count.
        if (typeof e._dist === 'number' && !isNaN(e._dist)) map.set(`${e._account}|${e.id}`, e._dist);
      }
    } catch { /* semantic evidence is optional — never blocks the verdict */ }
  }
  return map.size ? map : null;
}

function semanticSimFor(s, dists) {
  const d = dists && dists.get(`${s.raw._account}|${s.raw.id}`);
  return typeof d === 'number' ? 1 - d : null;
}

// What the proposal knows that the stored event does not. Empty ⇒ the proposal
// adds nothing and is a pure duplicate.
function enrichments(p, s) {
  const adds = [];
  if (p.location && !s.location) adds.push('location');
  // Only a materially fuller description counts — a re-extraction that rewords
  // the same sentence is not new information.
  if (p.description && p.description.length > (s.description || '').length * 1.5 + 20) adds.push('description');
  // Guests are not counted: the converted update never carries them (below),
  // so "this adds 2 guests" would be a promise the update cannot keep.
  const newGuests = p.attendees.filter((a) => !s.attendees.includes(a));
  if (p.startTime && s.allDay) adds.push('start time');
  else if (p.endTime && !s.allDay && (!s.endTime || s.endTime === s.startTime)) adds.push('end time');
  return { adds, newGuests };
}

// The merged event the update would write. Merging makes the card honest: it
// shows the event as it will be, not just the delta.
function mergedUpdatePayload(p, s) {
  const e = s.raw;
  const out = {
    account: e._account,
    eventId: e.id,
    calendarId: e._calendarId || 'primary',
    title: s.title || p.title,
    location: s.location || p.location || undefined,
    description: p.description && p.description.length > (s.description || '').length
      ? p.description : (s.description || undefined),
    date: s.date,
  };
  // No attendees: updateEvent PATCHes, so the event's guests stay as they are
  // without being written — and a written list would make Google mail every
  // guest about an update the owner never framed as an invitation. Guests are
  // calendar.invite's, which calendar.update refuses to carry (G9).

  if (s.allDay && !p.startTime) {
    out.allDay = true;
    if (s.endDate && s.endDate !== s.date) out.endDate = s.endDate;
  } else {
    out.startTime = s.startTime || p.startTime;
    out.endTime = s.endTime && s.endTime !== s.startTime ? s.endTime : (p.endTime || out.startTime);
  }
  // Preserved explicitly: buildEventBody only forwards what it is given, so a
  // colour or reminder set on the event would be dropped by the replace.
  if (e.colorId) out.colorId = e.colorId;
  if (e.reminders && Object.keys(e.reminders).length) out.reminders = e.reminders;
  return out;
}

function whenLabel(s) {
  if (s.allDay) return `${s.date} (all day)`;
  return `${s.date}${s.startTime ? ` ${s.startTime}` : ''}${s.endTime && s.endTime !== s.startTime ? `–${s.endTime}` : ''}`;
}

function eventEvidence(s) {
  const e = s.raw;
  return {
    type: 'calendar-event',
    account: e._account,
    calendarId: e._calendarId,
    eventId: e.id,
    summary: s.title,
    when: whenLabel(s),
    allDay: s.allDay,
    date: s.date,
    htmlLink: e.htmlLink || null,
    recurring: s.recurring,
  };
}

async function checkCalendarCreate(payload, meta) {
  const p = normalizeProposedEvent(payload);
  if (!p.date || !p.title) return null; // not enough to compare on
  const stored = (await dayCandidates(p.date, p.account, meta.fresh)).map(normalizeStoredEvent);
  let match = bestMatch(p, stored);
  let semantic = null;

  // Semantic pass — see the SEMANTIC_* header comment. Only paid for when
  // there is a match to corroborate or a 0.45-band candidate to weigh.
  try {
    const band = match ? [] : bandCandidates(p, stored);
    if (match || band.length) {
      const dists = await semanticDistances(p);
      if (dists && match) {
        const sim = semanticSimFor(match, dists);
        if (sim != null && sim >= SEMANTIC_EVIDENCE_SIM) semantic = { sim: Math.round(sim * 100) / 100 };
      } else if (dists) {
        for (const s of band) {
          const sim = semanticSimFor(s, dists);
          if (sim != null && sim >= SEMANTIC_PROMOTE_SIM) {
            match = s;
            semantic = { sim: Math.round(sim * 100) / 100, promoted: true };
            break;
          }
        }
      }
    }
  } catch { /* additive evidence only — the deterministic verdict stands */ }

  if (!match) return null;

  const { adds } = enrichments(p, match);

  // A recurring occurrence is never converted: "this one or the whole series?"
  // is a question the check cannot answer, and a PUT on an instance would drop
  // the series' recurrence. Flag the duplicate and let the user decide.
  // A semantically-PROMOTED match is never converted either — promotion is
  // informational by design (a wrong conversion is a silently edited event).
  if (!adds.length || match.recurring || meta.appKind || semantic?.promoted) {
    const note = match.recurring && adds.length
      ? 'This proposal adds more, but the event is part of a recurring series — edit it in the calendar to decide the scope.'
      : semantic?.promoted
        ? 'Matched by meaning rather than wording — review before repeating it.'
        : null;
    return {
      state: 'done',
      label: 'Already in your calendar',
      detail: `"${match.title}" — ${whenLabel(match)}${match.recurring ? ' (recurring)' : ''}`,
      evidence: eventEvidence(match),
      ...(semantic ? { semantic } : {}),
      ...(adds.length ? { adds } : {}),
      ...(note ? { note } : {}),
    };
  }

  return {
    state: 'partial',
    label: 'Already in your calendar — proposing an update',
    detail: `"${match.title}" — ${whenLabel(match)}`,
    adds,
    evidence: eventEvidence(match),
    ...(semantic ? { semantic } : {}),
    suggest: { kind: 'calendar.update', payload: mergedUpdatePayload(p, match) },
  };
}

// An update whose target is gone, or that asks for values the event already
// carries, is worth saying out loud before the user approves it.
async function checkCalendarUpdate(payload) {
  const account = payload.account || calendarEngine.calendarAccounts()[0];
  if (!account || !payload.eventId) return null;
  const event = await calendarEngine.getEvent({ account, eventId: payload.eventId });
  if (!event) {
    return {
      state: 'done',
      label: 'Event no longer exists',
      detail: `Event ${payload.eventId} is not in the calendar store — it may have been deleted already.`,
      evidence: { type: 'calendar-event', account, eventId: payload.eventId, missing: true },
    };
  }
  if (event._cancelled) {
    return {
      state: 'done',
      label: 'Event already cancelled',
      detail: `"${event.summary || payload.eventId}" is cancelled.`,
      evidence: eventEvidence(normalizeStoredEvent(event)),
    };
  }
  const s = normalizeStoredEvent(event);
  const p = normalizeProposedEvent(payload);
  const differs = (p.title && normText(p.title) !== normText(s.title))
    || (p.location && normText(p.location) !== normText(s.location))
    || (p.description && p.description.trim() !== (s.description || '').trim())
    || (p.date && p.date !== s.date)
    || (p.startTime && p.startTime !== s.startTime)
    || (p.endTime && p.endTime !== s.endTime)
    || p.attendees.some((a) => !s.attendees.includes(a));
  if (differs) return null;
  return {
    state: 'done',
    label: 'Event already matches',
    detail: `"${s.title}" — ${whenLabel(s)} already has these values.`,
    evidence: eventEvidence(s),
  };
}

async function checkCalendarDelete(payload) {
  const account = payload.account || calendarEngine.calendarAccounts()[0];
  if (!account || !payload.eventId) return null;
  const event = await calendarEngine.getEvent({ account, eventId: payload.eventId });
  if (!event) {
    return {
      state: 'done',
      label: 'Event already gone',
      detail: `Event ${payload.eventId} is not in the calendar store.`,
      evidence: { type: 'calendar-event', account, eventId: payload.eventId, missing: true },
    };
  }
  if (event._cancelled) {
    return {
      state: 'done',
      label: 'Already deleted',
      detail: `"${event.summary || payload.eventId}" is already cancelled.`,
      evidence: eventEvidence(normalizeStoredEvent(event)),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Email checker
// ---------------------------------------------------------------------------

// A reply proposal is stale once ANY outbound message exists in the same
// conversation after the mail that triggered it — whether we sent it from an
// approval or the user answered from their phone. listSent covers both.
async function checkEmailSend(payload, meta) {
  if (!payload.account || !payload.to) return null;

  // Window starts at the message being replied to: earlier mail in a long
  // thread is not evidence that THIS one was answered.
  let since = null;
  const src = meta.source;
  if (src?.type === 'email' && src.account && src.uid != null) {
    try {
      const original = await emailEngine.getEmail({ account: src.account, uid: String(src.uid) });
      if (original?.date && !isNaN(Date.parse(original.date))) since = new Date(original.date).toISOString();
    } catch { /* the source mail may be gone; fall through to the default window */ }
  }
  if (!since) since = new Date((meta.createdAt || Date.now()) - 14 * DAY_MS).toISOString();

  const to = bareAddress(String(payload.to).split(',')[0]);
  const { sent } = await emailEngine.listSent({
    account: payload.account,
    threadId: payload.threadId || undefined,
    inReplyTo: payload.inReplyTo || undefined,
    subject: payload.subject || undefined,
    to: to || undefined,
    since,
    limit: 20,
  });
  if (!sent.length) return null;

  const hit = sent[0];
  const when = hit.sentAt ? new Date(hit.sentAt) : null;
  const label = payload.inReplyTo || payload.threadId ? 'Already replied' : 'Already sent';
  return {
    state: 'done',
    label,
    detail: `"${hit.subject || '(no subject)'}" to ${hit.to || to}${
      when && !isNaN(when) ? ` on ${when.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : ''
    }${hit.via === 'folder' ? ' (found in your Sent folder)' : ''}`,
    evidence: {
      type: 'sent-email',
      account: hit.account,
      uid: hit.uid,
      messageId: hit.messageId,
      threadId: hit.threadId,
      subject: hit.subject,
      to: hit.to,
      sentAt: hit.sentAt,
      snippet: hit.snippet,
      via: hit.via,
      proposalId: hit.origin?.proposalId || null,
    },
  };
}

// ---------------------------------------------------------------------------
// Todo checker
// ---------------------------------------------------------------------------

// The case identity cannot reach: you answered the mail from your phone, so no
// reply proposal ever existed to share an act with. The evidence is the same one
// checkEmailSend uses — an outbound message in this thread since the mail that
// raised the todo.
//
// Deliberately a state of its own. 'done' SUPPRESSES in preStageCheck, and a
// todo must not be: "reply to this" can mean more than the one message, and only
// the user knows whether their phone reply finished the job. 'covered' stages the
// card carrying the evidence, rendering through the existing prior banner and the
// "Approve anyway" demotion, and answers for nobody.
async function checkTodoCreate(payload, meta) {
  // Tagged-only: a todo that is not discharged by replying has nothing to do
  // with the mailbox, and must never be judged by it.
  if (payload.discharge !== 'reply') return null;
  const src = meta.source;
  if (!src || src.type !== 'email' || !src.account) return null;
  if (!src.threadId && !src.messageId) return null;

  // Window starts at the mail that raised the todo: an earlier reply in a long
  // thread is not evidence that THIS request was answered.
  let since = null;
  if (src.uid != null) {
    try {
      const original = await emailEngine.getEmail({ account: src.account, uid: String(src.uid) });
      if (original?.date && !isNaN(Date.parse(original.date))) since = new Date(original.date).toISOString();
    } catch { /* the source mail may be gone; fall through to the default window */ }
  }
  if (!since) since = new Date((meta.createdAt || Date.now()) - 14 * DAY_MS).toISOString();

  const { sent } = await emailEngine.listSent({
    account: src.account,
    threadId: src.threadId || undefined,
    inReplyTo: src.messageId || undefined,
    since,
    limit: 5,
  });
  if (!sent.length) return null;

  const hit = sent[0];
  const when = hit.sentAt ? new Date(hit.sentAt) : null;
  return {
    state: 'covered',
    label: 'You already acted on this email',
    detail: `You replied${
      when && !isNaN(when) ? ` on ${when.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : ''
    }${hit.via === 'folder' ? ' (found in your Sent folder)' : ''}`,
    evidence: {
      type: 'sent-email',
      account: hit.account,
      uid: hit.uid,
      messageId: hit.messageId,
      threadId: hit.threadId,
      subject: hit.subject,
      to: hit.to,
      sentAt: hit.sentAt,
      via: hit.via,
    },
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const CHECKERS = {
  'calendar.create': checkCalendarCreate,
  'calendar.update': checkCalendarUpdate,
  'calendar.delete': checkCalendarDelete,
  'email.send': checkEmailSend,
  'todo.create': checkTodoCreate,
};

// App kinds are free-form; these are the base names the platform's own card
// renderer already treats as calendar/email actions (public/horst/horst.js
// kindFamily). Matching them buys app proposals the duplicate warning too —
// informational only, never a conversion (meta.appKind gates that).
const APP_KIND_ALIASES = {
  calendar_create: 'calendar.create',
  calendar_edit: 'calendar.update',
  calendar_delete: 'calendar.delete',
  email: 'email.send',
  reply: 'email.send',
};

function resolveKind(kind) {
  if (CHECKERS[kind]) return { base: kind, appKind: false };
  const idx = String(kind).indexOf(':');
  if (idx < 0) return null;
  const tail = kind.slice(idx + 1);
  const base = CHECKERS[tail] ? tail : APP_KIND_ALIASES[tail];
  return base && CHECKERS[base] ? { base, appKind: true } : null;
}

function hasChecker(kind) {
  return !!resolveKind(kind);
}

// meta: { source, app, createdAt } — provenance governance holds on the proposal.
// Returns a verdict, or null for "nothing found / not checkable".
async function check(kind, payload, meta = {}) {
  const resolved = resolveKind(kind);
  if (!resolved) return null;
  if (!emailEngine.isReady()) return null; // both stores live in vc_platform_mail
  try {
    const verdict = await CHECKERS[resolved.base](payload || {}, { ...meta, appKind: resolved.appKind });
    if (!verdict || verdict.state === 'none') return null;
    return { ...verdict, at: Date.now() };
  } catch (err) {
    console.warn(`[horst-prior] check failed for ${kind}:`, err.message);
    return null;
  }
}

module.exports = {
  check,
  hasChecker,
  invalidate,
  // exported for tests and for reuse by surfaces that need the same notion of
  // "the same thing" (e.g. matching a card to a calendar day)
  normText,
  titleSimilarity,
  sharedAnchors,
  isSameEvent,
  sameEventPayloads,
  normalizeProposedEvent,
  normalizeStoredEvent,
  wallClock,
};
