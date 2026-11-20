// Event reminders — one Telegram message per upcoming timed event, kept TRUE
// until the event is over.
//
// A reminder that said "starts in 15 min" an hour ago is a lie by the time it
// is read. So the message is not a one-shot: every tracked reminder is
// re-rendered each tick and edited in place when its text changed —
//   starts in N min → starting now → started HH:MM · ends HH:MM → ended HH:MM
// and then it is dropped. The absolute time range is always shown, so even a
// message nobody edits any more (Telegram down, bot removed) states a fact.
// A moved event says "⚠ moved to HH:MM"; moved beyond the lead window, the
// message is closed with the new time and a fresh reminder follows when the
// event comes due again. A deleted or cancelled event says "❌ cancelled".
//
// Tracking survives a restart: `.horst/event-reminders.json`, written
// atomically (tmp + rename) after every send and every edit, so a reminder is
// never sent twice for one occurrence and never orphaned mid-countdown.
//
// Not gated by `paused`: the owner's own calendar is not Horst's initiative.
// `eventReminders: false` stops NEW reminders; the ones already sent are still
// kept true until they end.
//
// Times are the process's local zone — the zone every other Horst surface
// formats in (toLocaleString) and the calendar engine writes in.

const fs = require('fs');
const path = require('path');

const STATE_CAP = 50;
const DONE_CAP = 200; // keys of finished reminders, so one occurrence is never reminded twice
const NOW_SLACK_MS = 60e3; // "starting now" covers one tick either side of the start

let deps = {};
// { calendarEngine, sendControlMessage(chatId, text) → [{messageId,text}],
//   controlChatId(), telegram: { call(method, params) }, getSettings(), dir,
//   now?(), timeZone? }

function init(options) { deps = options || {}; chain = Promise.resolve(); }

const now = () => (deps.now ? deps.now() : Date.now());

// --- state -------------------------------------------------------------------

function statePath() { return path.join(deps.dir, 'event-reminders.json'); }

// { reminders: [tracked record], done: [key] }. A key is account:eventId:start
// (ISO), so a moved event's new start is a new key and gets its own reminder,
// while a finished one — ended, cancelled, or its message deleted by the
// owner — is never sent again.
function load() {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    return { reminders: s.reminders || [], done: s.done || [] };
  } catch { return { reminders: [], done: [] }; }
}

function save(state) {
  fs.mkdirSync(deps.dir, { recursive: true });
  const tmp = statePath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ reminders: state.reminders.slice(-STATE_CAP), done: state.done.slice(-DONE_CAP) }, null, 2));
  fs.renameSync(tmp, statePath());
}

const keyOf = (account, eventId, startMs) => `${account}:${eventId}:${new Date(startMs).toISOString()}`;

// One tick or refresh at a time: both read-modify-write the same file.
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// --- formatting --------------------------------------------------------------

function fmt(ms, opts) {
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: deps.timeZone || undefined }).format(new Date(ms));
}
const hhmm = (ms) => fmt(ms, { hour: '2-digit', minute: '2-digit', hour12: false });
// "Thu 24 Sep", assembled from parts: locales disagree on the rest ("Sept", commas).
function dayLabel(ms) {
  const parts = new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: deps.timeZone || undefined })
    .formatToParts(new Date(ms));
  const part = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${part('weekday')} ${part('day')} ${part('month')}`;
}
const dayKey = (ms) => fmt(ms, { year: 'numeric', month: '2-digit', day: '2-digit' });

// "HH:MM" today, "Fri 25 Sep HH:MM" any other day.
function moment(ms) {
  return dayKey(ms) === dayKey(now()) ? hhmm(ms) : `${dayLabel(ms)} ${hhmm(ms)}`;
}

function range(start, end) {
  if (!end || end <= start) return `${dayLabel(start)} · ${hhmm(start)}`;
  if (dayKey(start) === dayKey(end)) return `${dayLabel(start)} · ${hhmm(start)}–${hhmm(end)}`;
  return `${dayLabel(start)} ${hhmm(start)} – ${dayLabel(end)} ${hhmm(end)}`;
}

// The relative line, or null once the event is over.
function relative(start, end, t = now()) {
  if (start - t > NOW_SLACK_MS) return `⏳ starts in ${Math.ceil((start - t) / 60e3)} min`;
  if (t < start + NOW_SLACK_MS) return '▶ starting now';
  if (end && t < end) return `▶ started ${hhmm(start)} · ends ${hhmm(end)}`;
  return null;
}

// The whole message for a record. `closing` is the final line when the
// reminder is being closed for a reason other than the event ending.
function render(rec, closing) {
  const lines = [`🔔 ${rec.title || '(untitled event)'}`, `🕑 ${range(rec.start, rec.end)}`];
  if (rec.location) lines.push(`📍 ${rec.location}`);
  if (closing) { lines.push(closing); return lines.join('\n'); }
  if (rec.movedFrom != null) lines.push(`⚠ moved to ${moment(rec.start)}`);
  const rel = relative(rec.start, rec.end);
  lines.push(rel || `✔ ended ${hhmm(rec.end || rec.start)}`);
  return lines.join('\n');
}

// --- telegram ------------------------------------------------------------------

// Edit in place, the closeCard pattern. Returns 'ok' | 'gone' | 'retry'.
// Telegram answers an identical text with "message is not modified" — that is
// success, not an error.
async function edit(rec, text) {
  let res;
  try {
    res = await deps.telegram.call('editMessageText', { chat_id: rec.chatId, message_id: rec.messageId, text });
  } catch (err) {
    console.warn('[horst-reminders] edit failed:', err.message);
    return 'retry';
  }
  if (!res || res.ok !== false) return 'ok';
  const why = String(res.description || '');
  if (/not modified/i.test(why)) return 'ok';
  if (/message to edit not found|message can't be edited|chat not found|bot was blocked/i.test(why)) return 'gone';
  console.warn('[horst-reminders] edit refused:', why);
  return 'retry';
}

// --- the event side -------------------------------------------------------------

function timedStart(ev) {
  const iso = ev?.start?.dateTime;
  if (!iso) return null; // all-day: no reminder
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function endOf(ev) {
  const ms = Date.parse(ev?.end?.dateTime || '');
  return Number.isFinite(ms) ? ms : null;
}

function leadMs() {
  const n = Number(deps.getSettings?.().eventLeadMinutes);
  return Math.min(Math.max(Number.isFinite(n) ? n : 15, 1), 240) * 60e3;
}

// Re-read one tracked event and bring its message up to date. Returns
// { keep } — the record to keep tracking, or null when the reminder is finished
// — and `rearm` when it was closed because the event moved beyond the window
// (its key must stay sendable: the event may move back).
async function refreshOne(rec) {
  let ev;
  try { ev = await deps.calendarEngine.getEvent({ account: rec.account, eventId: rec.eventId }, 'horst'); }
  catch (err) { console.warn('[horst-reminders] event read failed:', err.message); return { keep: rec }; }

  const next = { ...rec };
  let closing = null;
  let rearm = false;
  if (!ev || ev._cancelled || ev.status === 'cancelled') {
    closing = '❌ cancelled';
  } else {
    const start = timedStart(ev);
    next.title = ev.summary || rec.title;
    next.location = ev.location || null;
    if (start == null) {
      closing = `⚠ moved — now an all-day event on ${dayLabel(Date.parse(`${ev.start?.date}T12:00:00Z`) || rec.start)}`;
    } else {
      next.end = endOf(ev);
      if (start !== rec.start) {
        next.movedFrom = rec.movedFrom ?? rec.start;
        next.start = start;
        if (next.movedFrom === start) delete next.movedFrom; // moved back where it was
        // Beyond the window: close this one with the new time; the next tick
        // after it comes due sends a fresh reminder (a new key).
        if (start - now() > leadMs()) {
          closing = `⚠ moved to ${moment(start)} — a new reminder will follow`;
          rearm = true;
        }
      }
    }
  }

  const text = render(next, closing);
  const finished = closing != null || relative(next.start, next.end) == null;
  if (text !== rec.text) {
    const r = await edit(rec, text);
    if (r === 'gone') return { keep: null };
    if (r === 'retry') return { keep: rec }; // unchanged record: the next tick tries again
    next.text = text;
  }
  return finished ? { keep: null, rearm } : { keep: next };
}

// Apply refreshOne to the records `pick` selects; the rest are kept as they are.
async function refreshAll(state, pick, out) {
  const kept = [];
  for (const rec of state.reminders) {
    if (!pick(rec)) { kept.push(rec); continue; }
    const { keep, rearm } = await refreshOne(rec);
    if (!keep) { out.closed++; if (!rearm) state.done.push(rec.key); continue; }
    if (keep.text !== rec.text) out.edited++;
    kept.push(keep);
  }
  state.reminders = kept;
  save(state);
}

async function sendOne(ev, chatId) {
  const start = timedStart(ev);
  const rec = {
    key: keyOf(ev._account, ev.id, start),
    account: ev._account, eventId: ev.id, chatId,
    start, end: endOf(ev),
    title: ev.summary || '(untitled event)', location: ev.location || null,
  };
  rec.text = render(rec);
  const sent = await deps.sendControlMessage(chatId, rec.text);
  const last = sent && sent[sent.length - 1];
  if (!last) return null;
  rec.messageId = last.messageId;
  return rec;
}

// --- entry points ------------------------------------------------------------------

// The cron tick (`horst:event-reminders`, every minute): keep every tracked
// message true, then send what newly came into the lead window.
function tick() {
  return serial(async () => {
    const state = load();
    const out = { edited: 0, sent: 0, closed: 0 };
    await refreshAll(state, () => true, out);

    const settings = deps.getSettings?.() || {};
    const chatId = deps.controlChatId?.();
    if (settings.eventReminders === false || chatId == null) return out;

    const t = now();
    let events = [];
    try {
      const r = await deps.calendarEngine.listEvents({
        timeMin: new Date(t).toISOString(), timeMax: new Date(t + leadMs()).toISOString(), limit: 50,
      }, 'horst');
      events = r?.events || r || [];
    } catch (err) { console.warn('[horst-reminders] listEvents failed:', err.message); return out; }

    for (const ev of events) {
      const start = timedStart(ev);
      if (start == null || start < t || ev._cancelled) continue;
      // One reminder per event while it is tracked, whatever its start is now.
      if (state.reminders.some((r) => r.account === ev._account && r.eventId === ev.id)) continue;
      if (state.done.includes(keyOf(ev._account, ev.id, start))) continue;
      let rec;
      try { rec = await sendOne(ev, chatId); }
      catch (err) { console.warn('[horst-reminders] send failed:', err.message); continue; }
      if (!rec) continue;
      state.reminders.push(rec);
      save(state); // after EACH send: a crash here must not send it again
      out.sent++;
    }
    return out;
  });
}

// calendar:changed → the affected reminders update now, not on the next tick.
function refresh(eventIds, account) {
  const ids = new Set((eventIds || []).map(String));
  if (!ids.size) return Promise.resolve({ edited: 0, closed: 0 });
  return serial(async () => {
    const state = load();
    const out = { edited: 0, closed: 0 };
    await refreshAll(state, (rec) => ids.has(String(rec.eventId)) && (!account || rec.account === account), out);
    return out;
  });
}

function tracked() { return load().reminders; }

module.exports = { init, tick, refresh, tracked, _render: render };
