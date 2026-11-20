// Recurrence, in one place.
//
// Three implementations of the same idea had grown up independently:
//
//   * my-dashboard built and parsed Google RRULE strings in the browser
//     (buildRRule/parseRRule) — the only place a rule was ever constructed
//     from what the user actually picked.
//   * calendar-engine could only CAP an existing rule (rruleUntilBefore /
//     capRecurrence) and never build one, so every recurring event had to
//     arrive pre-serialised from somewhere else.
//   * tasks-engine had no RRULE strings at all: a parallel "RRULE-lite" domain
//     object ({every, n, byday}) with its own date-stepping.
//
// This module owns the domain model and the arithmetic; the two engines own
// their storage. Google's wire format is one serialisation of the model, not
// the model itself — which is why the app can stop speaking it.
//
// The stepping below is DELIBERATELY plain local-time Date arithmetic. Two
// behaviours depend on it and are covered by tests:
//   * setDate() across a DST boundary keeps the local time-of-day rather than
//     drifting an hour.
//   * "every month" from the 31st clamps via setMonth() semantics (31 Jan + 1
//     month = 2 or 3 March). A documented limitation, preserved on purpose:
//     changing it would silently move every existing monthly todo.

// getDay() order. Tasks stores byday deduped and Monday-first (WKST=MO), which
// is how walkByday counts weeks.
const BYDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
// The tasks-engine API shape speaks units, not FREQ tokens.
const UNIT_TO_FREQ = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' };
const FREQ_TO_UNIT = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };
const RECUR_UNITS = Object.keys(UNIT_TO_FREQ);

const DAY_NAMES = {
  sunday: 'SU', monday: 'MO', tuesday: 'TU', wednesday: 'WE',
  thursday: 'TH', friday: 'FR', saturday: 'SA',
};

// Accepts codes or day names, in any order/case. Returns MO..SA,SU order and
// deduped, or null for "no byday".
function normalizeByday(byday) {
  if (byday == null || byday === '') return null;
  // A stored todo rule may hold "MO,WE" as one string — tasks-engine accepted
  // that shape, so splitting here is not optional.
  const list = Array.isArray(byday) ? byday : String(byday).split(',');
  if (!list.length) return null;
  const codes = list.map((v) => {
    const s = String(v).trim().toLowerCase();
    return DAY_NAMES[s] || s.slice(0, 2).toUpperCase();
  });
  const bad = codes.find((c) => !BYDAY_CODES.includes(c));
  if (bad !== undefined) {
    throw new Error(`recurrence.byday must be weekdays (${BYDAY_CODES.join('|')} or day names), got "${bad}"`);
  }
  return [...BYDAY_CODES.slice(1), 'SU'].filter((c) => codes.includes(c));
}

// The canonical rule: { freq, interval, byday?, count?, until? }.
// Errors are phrased in the TODO field names (every/n/byday) because that is
// the only spelling an owner ever types — the calendar side speaks freq/interval
// internally and its callers never see these strings raw.
// `until` is a Date when present. Throws on anything it cannot represent.
function normalize(rule) {
  if (rule == null) return null;
  const freq = String(rule.freq || UNIT_TO_FREQ[String(rule.every || '').toLowerCase()] || '').toUpperCase();
  if (!FREQS.includes(freq)) {
    throw new Error(`recurrence.every must be one of ${RECUR_UNITS.join('|')} (or freq=${FREQS.join('|')})`);
  }
  // `|| 1` rather than a null check: tasks-engine coerced a falsy n to 1, and a
  // stored rule that went through it may carry anything it let past.
  const interval = Number(rule.interval || rule.n || 1);
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) {
    throw new Error('recurrence.n must be an integer 1-365');
  }
  const byday = normalizeByday(rule.byday);
  if (byday && freq !== 'WEEKLY') throw new Error('recurrence.byday is only valid with every=week (FREQ=WEEKLY)');

  const out = { freq, interval };
  if (byday) out.byday = byday;
  // COUNT and UNTIL are mutually exclusive in RFC 5545; refusing both is
  // better than silently dropping one and producing a series nobody asked for.
  if (rule.count != null && rule.until != null) throw new Error('recurrence may set count or until, not both');
  if (rule.count != null) {
    const count = Number(rule.count);
    if (!Number.isInteger(count) || count < 1) throw new Error('recurrence.count must be a positive integer');
    out.count = count;
  }
  if (rule.until != null) {
    const until = rule.until instanceof Date ? rule.until : new Date(rule.until);
    if (isNaN(until)) throw new Error(`invalid recurrence until: ${rule.until}`);
    out.until = until;
  }
  return out;
}

// --- Google's wire format ----------------------------------------------------

// UTC stamp forms RFC 5545 accepts for UNTIL.
function untilStamp(date, allDay = false) {
  const d = date instanceof Date ? date : new Date(date);
  if (allDay) return d.toISOString().slice(0, 10).replace(/-/g, '');       // YYYYMMDD
  return d.toISOString().replace(/\.\d{3}/, '').replace(/[-:]/g, '');      // YYYYMMDDTHHMMSSZ
}

// Canonical rule → the `recurrence` array Google's API takes.
function toRRule(rule, { allDay = false } = {}) {
  const r = normalize(rule);
  if (!r) return [];
  let line = `RRULE:FREQ=${r.freq}`;
  if (r.interval > 1) line += `;INTERVAL=${r.interval}`;
  if (r.byday) line += `;BYDAY=${r.byday.join(',')}`;
  if (r.count != null) line += `;COUNT=${r.count}`;
  else if (r.until) line += `;UNTIL=${untilStamp(r.until, allDay)}`;
  return [line];
}

// The `recurrence` array → the canonical rule, or null.
//
// Null means "this is not a rule this model can hold", and callers must read it
// as "leave the series exactly as it is". That is stricter than it looks: the
// parse is used to populate an EDITOR, and whatever the editor shows is what
// gets written back. So a rule we can only half-read must not come back as a
// whole rule — dropping BYMONTHDAY here and re-writing the result would turn
// "the 1st of every month" into "every month from the start date", silently, on
// an edit that only changed the title.
//
// Anything outside MODELLED, a positional BYDAY ("2MO" = the second Monday), a
// second RRULE line, or any EXDATE/RDATE (dates carved out of or added to the
// series, which toRRule cannot re-emit) therefore refuses the whole line rather
// than returning an approximation of it.
const MODELLED = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST']);

function fromRRule(recurrence) {
  const lines = recurrence || [];
  const rules = lines.filter((l) => /^RRULE:/i.test(l));
  if (rules.length !== 1) return null;                                  // none, or more than one series
  if (lines.some((l) => /^(EXDATE|RDATE)[;:]/i.test(l))) return null;   // holes and extra dates are part of the rule
  const parts = {};
  for (const piece of rules[0].replace(/^RRULE:/i, '').split(';')) {
    if (!piece) continue;
    const [k, v] = piece.split('=');
    if (!k) continue;
    if (!MODELLED.has(k.toUpperCase())) return null;                    // BYMONTHDAY, BYSETPOS, BYMONTH, …
    parts[k.toUpperCase()] = v;
  }
  const freq = String(parts.FREQ || '').toUpperCase();
  if (!FREQS.includes(freq)) return null;
  // WKST changes which occurrences an INTERVAL>1 weekly rule lands on, and the
  // stepping in this module counts weeks Monday-first.
  if (parts.WKST && String(parts.WKST).toUpperCase() !== 'MO') return null;
  if (parts.INTERVAL != null && !(Number(parts.INTERVAL) > 0)) return null;

  const out = { freq, interval: Number(parts.INTERVAL) > 0 ? Number(parts.INTERVAL) : 1 };
  if (parts.BYDAY) {
    if (freq !== 'WEEKLY') return null;                                 // BYDAY on MONTHLY/YEARLY is a different rule
    if (/[-+]?\d/.test(parts.BYDAY)) return null;                       // positional: "the second Monday"
    let byday;
    try { byday = normalizeByday(parts.BYDAY.split(',')); } catch { return null; }
    if (!byday) return null;
    out.byday = byday;
  }
  if (parts.COUNT != null) {
    if (!(Number(parts.COUNT) > 0)) return null;
    out.count = Number(parts.COUNT);
    if (parts.UNTIL != null) return null;                               // both is not a rule RFC 5545 allows
  } else if (parts.UNTIL != null) {
    const m = String(parts.UNTIL).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
    if (!m) return null;
    out.until = new Date(Date.UTC(
      +m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 23, m[5] ? +m[5] : 59, m[6] ? +m[6] : 59,
    ));
  }
  return out;
}

// The UNTIL value that ends a series immediately BEFORE the given start —
// how "this and following" deletes/edits truncate a master. `start` is
// Google's shape: { date } for all-day, { dateTime } otherwise.
function untilBefore(start) {
  if (start.date) {
    const d = new Date(`${start.date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return untilStamp(d, true);
  }
  const d = new Date(start.dateTime);
  d.setUTCSeconds(d.getUTCSeconds() - 1);
  return untilStamp(d, false);
}

// Inject/replace UNTIL on every RRULE line, dropping COUNT (mutually
// exclusive). Non-RRULE lines (EXDATE, RDATE) pass through untouched.
function capUntil(recurrence, untilValue) {
  return (recurrence || []).map((line) => {
    if (!/^RRULE:/i.test(line)) return line;
    const rule = line.replace(/;?(UNTIL|COUNT)=[^;]*/gi, '');
    return `${rule};UNTIL=${untilValue}`;
  });
}

// --- Stepping ----------------------------------------------------------------

// Weekly BYDAY: occurrences land on the rule's weekdays in every n-th week,
// weeks counted Monday-first (WKST=MO) from the base's week. Same setDate()
// day-stepping as nextOccurrence, so a DST crossing keeps the time-of-day.
function walkByday(rule, base, now) {
  const offsets = rule.byday.map((c) => (BYDAY_CODES.indexOf(c) + 6) % 7); // Monday-first 0..6, ascending
  const week0 = new Date(base);
  week0.setDate(week0.getDate() - ((week0.getDay() + 6) % 7)); // Monday of base's week, base's time-of-day
  let guard = 0;
  for (let w = 0; guard++ < 1000; w += rule.interval) {
    for (const off of offsets) {
      const d = new Date(week0);
      d.setDate(d.getDate() + w * 7 + off);
      if (d > base && d > now) return d;
    }
  }
  const d = new Date(base); // unreachable safety net (≈19y of weekly steps)
  d.setDate(d.getDate() + 7 * rule.interval);
  return d;
}

// Next occurrence strictly after `now`, stepping from `from` (or now when
// there is none). Returns a Date.
function nextOccurrence(rule, from, now = new Date()) {
  const r = normalize(rule);
  const d = new Date(from && !isNaN(new Date(from)) ? from : now);
  if (r.freq === 'WEEKLY' && r.byday && r.byday.length) return walkByday(r, d, now);
  let guard = 0;
  do {
    if (r.freq === 'DAILY') d.setDate(d.getDate() + r.interval);
    else if (r.freq === 'WEEKLY') d.setDate(d.getDate() + 7 * r.interval);
    else if (r.freq === 'MONTHLY') d.setMonth(d.getMonth() + r.interval);
    else d.setFullYear(d.getFullYear() + r.interval);
  } while (d <= now && ++guard < 1000);
  return d;
}

// --- tasks-engine's stored shape --------------------------------------------
//
// Todos store {every, n, byday} and that is their API. It is the canonical
// model under another spelling; these two keep the mapping in one place rather
// than teaching the rest of the engine a second vocabulary.
function toTaskRule(rule) {
  const r = normalize(rule);
  if (!r) return null;
  const out = { every: FREQ_TO_UNIT[r.freq], n: r.interval };
  if (r.byday) out.byday = r.byday;
  return out;
}

module.exports = {
  BYDAY_CODES, FREQS, RECUR_UNITS,
  normalizeByday, normalize,
  toRRule, fromRRule, untilBefore, capUntil, untilStamp,
  nextOccurrence, toTaskRule,
};
