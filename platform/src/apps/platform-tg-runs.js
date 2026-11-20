const path = require('path');
const telegram = require('./telegram');
const miniAppAuth = require('./tg-miniapp-auth');
const transcript = require('./tg-run-transcript');

// Orchestration runs continued on Telegram (docs/horst-surfaces.md "Runs on
// Telegram"). The control chat binds any number of runs, each by its runId —
// the orchestrator's tab is resolved from the run on every use, because a
// resume, a refresh or a reboot gives it another tab. The dashboard stays live
// (no lock). Owner messages to a run go only through the Mini App
// (/pro/tg-session/, ?run=<runId>); plain chat text never reaches a run.
//
// In the chat, per bound run:
//   card      ONE status message, edited in place (at most every 5 s, trailing
//             edit; "not modified" is success): title, state + how long, one
//             line per worker, the last event; ▶ Open · ⏸ Pause / ▶ Resume ·
//             ⏏ Disconnect.
//   pushes    a new message only for: a question, the run going truly idle,
//             a worker event 'not landed' or a failed / blocked report, the
//             run paused / exited / ended. Everything else only edits the card.
//   questions one question of type select (≤ 8 options) / confirm / toggle gets
//             answer buttons in the chat; anything else a pointer to the Mini
//             App. Answered anywhere else → the message says so, buttons gone.
//             First answer wins (pendingQuestions decides). A slave's relayed
//             ask belongs to the run whose orchestrator requested that remote
//             session (its origin), labelled "Remote · <host> · <session>".
//             Any other relayed ask (an owner's or Horst's remote session) is
//             in the Mini App's remote list only (GET runs `remote`).
//
// Core data comes from ctx.orchestration ({ listRuns, describeRun, pauseRun,
// resumeRun, refreshOrchestrator }); without it every run feature is off.
// Bindings and their message ids live in the tg-session state file
// (.tg-sessions.enc, `runs`), so a restart keeps editing the same card and
// never re-pushes.

const KEY = '__platform__'; // platform-telegram.js bot key
const MINIAPP_PATH = '/pro/tg-session/';
const CARD_EDIT_MS = 5000;
const SETTLE_MS = 10000;       // idle / exited must hold this long before they are pushed
const REFRESH_DEBOUNCE_MS = 1000;
const SWEEP_MS = 60000;        // CLI-engine state changes and the card's elapsed time
const MAX_INLINE_OPTIONS = 8;
const CALLBACK_MAX = 64;       // Telegram's callback_data limit, in bytes
const TEXT_CAP = 3800;
const WORKER_LINES = 8;
const STATE_LABEL = {
  busy: '⚙️ working', awaiting: '❓ waiting for an answer', idle: '💤 idle',
  pausing: '⏳ pausing', paused: '⏸ paused', exited: '⏹ orchestrator not running', ended: '🏁 ended',
};
const LIVE_STATES = new Set(['busy', 'awaiting', 'idle', 'pausing']);

let deps = {};
const timers = new Map();     // runId → pending card edit
const refreshes = new Map();  // runId → debounce timer
const chains = new Map();     // runId → Promise (one refresh / Telegram op at a time)
const cards = new Map();      // runId → { text, markup, editedAt } (last edit sent)
const candidates = new Map(); // runId → { kind: 'idle'|'exited', since }
const tabRuns = new Map();    // tabId → runId (a tab that exited keeps its run)
let sweepTimer = null;

// init({ orchestration, cliSessionManager, store, broadcaster, pendingQuestions,
//        state: { get() → { runs }, save() }, isOwnerRequest?, controlChatId?,
//        tgCall?(method, params), remoteStatus?(tabId), now?, cardEditMs?, settleMs?,
//        refreshDebounceMs?, sweepMs? })
function init(options = {}) {
  deps = options;
  for (const t of [...timers.values(), ...refreshes.values()]) clearTimeout(t);
  timers.clear(); refreshes.clear(); chains.clear(); cards.clear(); candidates.clear(); tabRuns.clear();
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  if (!enabled()) return;
  const sweepMs = deps.sweepMs ?? SWEEP_MS;
  if (sweepMs > 0) {
    sweepTimer = setInterval(() => { for (const runId of Object.keys(runs())) requestRefresh(runId); }, sweepMs);
    if (sweepTimer.unref) sweepTimer.unref();
  }
  // Restart: bring every card up to date (no re-push — lastSeq / phase / idle
  // are persisted).
  for (const runId of Object.keys(runs())) requestRefresh(runId);
}

function enabled() {
  const o = deps.orchestration;
  return !!o && typeof o.listRuns === 'function' && typeof o.describeRun === 'function';
}

const now = () => (deps.now ? deps.now() : Date.now());

function runs() {
  const st = deps.state.get();
  if (!st.runs || typeof st.runs !== 'object') st.runs = {};
  return st.runs;
}

function save() { deps.state.save(); }

function getBinding(runId) { return runs()[runId] || null; }

function boundRuns(chatId) {
  return Object.entries(runs()).filter(([, b]) => chatId == null || String(b.chatId) === String(chatId)).map(([runId]) => runId);
}

async function tg(method, params) {
  try {
    return await (deps.tgCall ? deps.tgCall(method, params) : telegram.call(KEY, method, params));
  } catch (err) {
    return { ok: false, description: err.message };
  }
}

function serial(id, fn) {
  const next = (chains.get(id) || Promise.resolve()).then(fn, fn);
  const tail = next.catch((err) => console.error(`[tg-runs] ${id}: ${err.message}`));
  chains.set(id, tail);
  tail.then(() => { if (chains.get(id) === tail) chains.delete(id); });
  return next;
}

// ---------------------------------------------------------------------------
// Core reads
// ---------------------------------------------------------------------------

async function listRuns() {
  if (!enabled()) return [];
  const list = await deps.orchestration.listRuns();
  // A mirror run's orchestrator lives on the master: core refuses pause,
  // resume and refresh for it, so no run feature here offers it.
  return Array.isArray(list) ? list.filter((r) => r && !r.mirror) : [];
}

async function describe(runId) {
  if (!enabled() || !runId) return null;
  try { return (await deps.orchestration.describeRun(runId)) || null; } catch { return null; }
}

async function mustDescribe(runId) {
  if (!enabled()) throw new Error('Orchestration runs are not available on this server');
  const d = await describe(runId);
  if (!d) throw new Error('run not found');
  if (d.mirror) throw new Error(`This run is a mirror of ${d.mirror.orchestrator || d.orchestrator} on ${d.mirror.host} — it is run from there.`);
  return d;
}

function sessionOf(tabId) {
  return tabId && deps.cliSessionManager ? deps.cliSessionManager.get(tabId) || null : null;
}

// The run a tab belongs to: its stamp while it lives, remembered after.
function runOfTab(tabId) {
  if (!tabId) return null;
  const s = sessionOf(tabId);
  let runId = null;
  try { runId = s && s.getSettings && s.getSettings().orchestration ? s.getSettings().orchestration.runId : null; } catch {}
  if (runId) tabRuns.set(tabId, runId);
  return runId || tabRuns.get(tabId) || null;
}

// The live orchestrator tab of a run, from the run itself (describeRun), else
// by its stamp among the open sessions. Never a remembered tabId.
function orchestratorTabOf(runId, d) {
  if (d && d.orchestratorRunning !== false && d.orchestratorTabId && sessionOf(d.orchestratorTabId)?.running) return d.orchestratorTabId;
  const sessions = deps.cliSessionManager && deps.cliSessionManager.sessions;
  if (!sessions) return null;
  for (const [tabId, s] of sessions) {
    let st = null;
    try { st = s.getSettings ? s.getSettings().orchestration : null; } catch {}
    if (s.running && st && st.runId === runId && st.role === 'orchestrator') return tabId;
  }
  return null;
}

// The run's state in one word: pausing · busy · awaiting · idle (its
// orchestrator open) · paused · ended (closed by end_run) · exited.
function phaseOf(d) {
  if (d.pausing) return 'pausing';
  if (d.orchestratorRunning) {
    const s = d.orchestratorState;
    return s === 'busy' || s === 'awaiting' ? s : 'idle';
  }
  if (d.paused) return 'paused';
  return d.closed ? 'ended' : 'exited';
}

// Truly idle: the orchestrator waits, no worker event waits for it, no
// worker is in a turn.
function trulyIdle(d) {
  return phaseOf(d) === 'idle' && !d.pendingEvents
    && !(d.workers || []).some((w) => w.running && (w.state === 'busy' || w.state === 'awaiting'));
}

function titleOf(d, b) {
  return (b && b.title) || d.title || d.name || d.orchestrator || d.runId;
}

// The run's worker events. describeRun carries `events` when core includes
// them; otherwise each worker's last report stands in (kind 'report', the
// text core's report event would have), ordered by time.
// 2026-10-25: core's ctx describeRun (describeRunById) has no `events` yet —
// only its HTTP GET /run adds them. Until it does, 'not landed' is never
// pushed and the card shows done / failed / blocked instead of landed.
function eventsOf(d) {
  if (Array.isArray(d.events)) return d.events;
  return (d.workers || [])
    .filter((w) => w.lastReport && w.lastReport.at)
    .sort((a, b) => String(a.lastReport.at).localeCompare(String(b.lastReport.at)))
    .map((w, i) => ({
      seq: i + 1, at: w.lastReport.at, worker: w.name, kind: 'report', derived: true,
      text: `${w.name} reported ${w.lastReport.status}: ${w.lastReport.summary || ''}`,
    }));
}

// What is new since the binding last looked: by seq for core's events, by
// time for derived reports. Moves the binding's marks.
function freshEvents(d, b) {
  const events = eventsOf(d);
  if (Array.isArray(d.events)) {
    const fresh = events.filter((e) => (e.seq || 0) > (b.lastSeq || 0));
    if (fresh.length) b.lastSeq = Math.max(...fresh.map((e) => e.seq || 0));
    return fresh;
  }
  const fresh = events.filter((e) => String(e.at) > String(b.lastReportAt || ''));
  if (fresh.length) b.lastReportAt = fresh[fresh.length - 1].at;
  return fresh;
}

// A pending question's tab: the ask's own ctx, else the broadcast's.
function askTab(p) {
  return (p && p.ctx && p.ctx.tabId) || (p && p.message && p.message.tabId) || null;
}

// A slave's ask relayed by peer-remote-master.js: it names host / remote.
function isRemoteAsk(p) { return !!(p && (p.host || p.remote)); }

function remoteStatus(tabId) {
  try {
    const fn = deps.remoteStatus || require('./peer-remote-master').status;
    return fn(tabId) || null;
  } catch { return null; }
}

// The tab a relayed ask belongs to, read as core's askOwner reads it.
function remoteTabOf(p) {
  return [p.tabId, p.ctx && p.ctx.tabId, p.message && p.message.tabId, p.remote && p.remote.tabId]
    .find((t) => typeof t === 'string' && t) || null;
}

// Core answers a remote session's question only when the answer names its tab
// (core external-session.js answerRefusal, for the dashboard's ask:answer);
// every answer from Telegram follows the same rule. A local ask: as before.
function tabRefusal(p, tabId) {
  if (!isRemoteAsk(p)) return null;
  if (typeof tabId !== 'string' || !tabId) return 'an answer to a remote session\'s question must name its tab';
  return tabId === remoteTabOf(p) ? null : 'that question belongs to another session';
}

// A remote session's run: the orchestrator run that requested it (origin).
function runOfRemote(p) {
  const tabId = (p.remote && p.remote.tabId) || askTab(p) || p.tabId;
  const st = tabId ? remoteStatus(tabId) : null;
  const o = st && st.origin;
  return o && o.kind === 'orchestrator' && typeof o.ref === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(o.ref) ? o.ref : null;
}

// The run a pending entry (or an ask:question message) belongs to.
function askRun(p) {
  if (!p) return null;
  return runOfTab(askTab(p)) || (isRemoteAsk(p) ? runOfRemote(p) : null);
}

const plain = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, '').trim().slice(0, n);

// { host, session, tabId } of a remote ask (plain text, capped), else null.
// `tabId` is what an answer must name (tabRefusal).
function remoteOf(p) {
  if (!isRemoteAsk(p)) return null;
  const r = p.remote || {};
  return { host: plain(p.host || r.peer, 100), session: plain(r.sessionTitle, 120), tabId: plain(remoteTabOf(p), 200) };
}

// A relayed ask's text is escaped for core's markdown form (peer-remote-master
// mdText); shown here as plain text, the escapes come off.
function unMd(t) {
  return String(t == null ? '' : t).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#58;/g, ':').replace(/&#46;/g, '.')
    .replace(/&amp;/g, '&').replace(/\\([\\[\]`])/g, '$1');
}

function remoteLine(r) {
  return ['Remote', r.host, r.session].filter(Boolean).join(' · ');
}

function pendingAsks(runId) {
  const out = [];
  const pq = deps.pendingQuestions;
  if (!pq) return out;
  for (const [askId, p] of pq) {
    if (askRun(p) !== runId) continue;
    const s = sessionOf(askTab(p));
    let from = null;
    try { from = s && s.getSettings ? s.getSettings().name || null : null; } catch {}
    const remote = remoteOf(p);
    out.push({ askId, formData: p.formData || {}, questions: p.questions || [], ...(from ? { from } : {}), ...(remote ? { remote } : {}) });
  }
  return out;
}

// The relayed asks no listed run holds (an owner's or Horst's remote session,
// or one whose run is gone), by peer → session, each session with its state
// and cost from peer-remote-master. `runIds`: the listed runs.
function remoteSessions(runIds) {
  const pq = deps.pendingQuestions;
  const peers = new Map();
  if (!pq) return [];
  for (const [askId, p] of pq) {
    if (!isRemoteAsk(p) || runIds.has(askRun(p))) continue;
    const remote = remoteOf(p);
    const rawTab = remoteTabOf(p);
    let peer = peers.get(remote.host);
    if (!peer) { peer = { host: remote.host, sessions: new Map() }; peers.set(remote.host, peer); }
    let s = peer.sessions.get(remote.tabId);
    if (!s) {
      const st = (rawTab && remoteStatus(rawTab)) || {};
      s = {
        tabId: remote.tabId, session: remote.session,
        state: typeof st.state === 'string' && /^[a-z-]{1,20}$/.test(st.state) ? st.state : null,
        costUsd: typeof st.costUsd === 'number' && Number.isFinite(st.costUsd) && st.costUsd >= 0 ? st.costUsd : null,
        asks: [],
      };
      peer.sessions.set(remote.tabId, s);
    }
    s.asks.push({ askId, formData: p.formData || {}, questions: p.questions || [], remote });
  }
  return [...peers.values()].map((g) => ({ host: g.host, sessions: [...g.sessions.values()] }));
}

async function listedRunIds() {
  return new Set((await listRuns()).map((r) => r.runId));
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

function miniAppUrl(runId) {
  const url = miniAppAuth.miniAppUrl(MINIAPP_PATH);
  return url ? `${url}?run=${encodeURIComponent(runId)}` : null;
}

function openRow(runId) {
  const url = miniAppUrl(runId);
  return url ? [{ text: '▶ Open', web_app: { url } }] : null;
}

function openMarkup(runId) {
  const row = openRow(runId);
  return row ? { inline_keyboard: [row] } : undefined;
}

async function bind(chatId, runId) {
  if (chatId == null) throw new Error('no chat');
  const d = await mustDescribe(runId);
  let b = getBinding(runId);
  if (b && String(b.chatId) === String(chatId)) {
    await serial(runId, () => refresh(runId, { resend: true }));
    return b;
  }
  const listed = (await listRuns()).find((r) => r.runId === runId) || {};
  b = {
    chatId: Number(chatId),
    name: listed.name || d.orchestrator || `orch-${runId}`,
    title: listed.title || d.title || null,
    boundAt: now(),
    lastSeq: 0,
    lastReportAt: null,
    phase: phaseOf(d),
    since: now(),
    // What already holds when bound is on the card, not pushed.
    idle: trulyIdle(d),
    exitedPushed: phaseOf(d) === 'exited',
    cardId: null,
    asks: {},
  };
  freshEvents(d, b); // no history replay
  runs()[runId] = b;
  save();
  broadcastBinding(runId, true);
  await serial(runId, () => refresh(runId, { resend: true }));
  // Questions already waiting reach the chat now.
  for (const a of pendingAsks(runId)) await postQuestion(runId, a.askId);
  return b;
}

async function unbind(runId, { note = '⏏ Disconnected from Telegram.' } = {}) {
  const b = getBinding(runId);
  if (!b) return false;
  await serial(runId, async () => {
    const t = timers.get(runId);
    if (t) { clearTimeout(t); timers.delete(runId); }
    if (b.cardId) {
      const last = cards.get(runId);
      const base = last ? last.text : `💻 ${b.title || b.name}`;
      await tg('editMessageText', { chat_id: b.chatId, message_id: b.cardId, text: `${base}\n\n${note}`.slice(0, 4096) });
    }
    for (const askId of Object.keys(b.asks || {})) await closeAsk(b, askId, 'Disconnected — answer in the dashboard.');
  });
  delete runs()[runId];
  save();
  cards.delete(runId);
  candidates.delete(runId);
  broadcastBinding(runId, false, b.name);
  return true;
}

function broadcastBinding(runId, bound, name) {
  const b = getBinding(runId);
  try { deps.broadcaster?.broadcast({ type: 'tg:binding', runId, name: name || b?.name || `orch-${runId}`, bound }); } catch {}
}

// ---------------------------------------------------------------------------
// Acting on a run
// ---------------------------------------------------------------------------

async function liveOrchestrator(runId) {
  const d = await mustDescribe(runId);
  const phase = phaseOf(d);
  if (phase === 'pausing') throw new Error('The run is pausing — wait until it is paused, then resume it.');
  if (phase === 'paused') throw new Error('The run is paused — resume it first.');
  if (phase === 'ended') throw new Error('The run has ended.');
  const tabId = orchestratorTabOf(runId, d);
  const s = sessionOf(tabId);
  if (!s || !s.running) throw new Error('The orchestrator is not running — resume the run first.');
  return { d, tabId, session: s };
}

async function send(chatId, runId, text) {
  const body = String(text || '').trim();
  if (!body) throw new Error('text required');
  const { session } = await liveOrchestrator(runId);
  if (!getBinding(runId) && chatId != null) await bind(chatId, runId);
  if (typeof session.submit === 'function') session.submit(body);
  else { session.writeWhenReady(body); session.writeWhenReady('\r', undefined, 400); }
  return { ok: true };
}

async function interrupt(runId) {
  const { session } = await liveOrchestrator(runId);
  if (typeof session.interrupt === 'function') await session.interrupt();
  else session.write('\x1b');
  return { ok: true };
}

// First answer wins: whoever resolves the pending entry first; a later one
// finds it gone.
// `tabId`: the tab the answer names (a remote ask's must, tabRefusal).
async function answerAsk(runId, askId, answer, { via = 'Mini App', tabId = null } = {}) {
  if (!Array.isArray(answer)) throw new Error('answer must be an array');
  const pending = deps.pendingQuestions && deps.pendingQuestions.get(askId);
  if (!pending || askRun(pending) !== runId) throw new Error('question not pending for this run');
  const refusal = tabRefusal(pending, tabId);
  if (refusal) throw new Error(refusal);
  const b = getBinding(runId);
  if (b && b.asks && b.asks[askId]) await closeAsk(b, askId, `✅ Answered in the ${via}.`);
  pending.resolve(answer);
  try { deps.broadcaster?.broadcast({ type: 'ask:answered', askId }); } catch {}
  return { ok: true };
}

// An ask of the remote list (remoteSessions): its entry's resolve forwards the
// answer to its own peer (peer-remote-master). A run's ask is answered there.
async function answerRemote(askId, answer, tabId) {
  if (!Array.isArray(answer)) throw new Error('answer must be an array');
  const pending = deps.pendingQuestions && deps.pendingQuestions.get(askId);
  if (!pending || !isRemoteAsk(pending) || (await listedRunIds()).has(askRun(pending))) {
    throw new Error('question not pending for a remote session');
  }
  const refusal = tabRefusal(pending, tabId);
  if (refusal) throw new Error(refusal);
  pending.resolve(answer);
  try { deps.broadcaster?.broadcast({ type: 'ask:answered', askId }); } catch {}
  return { ok: true };
}

async function pauseRun(runId) {
  await mustDescribe(runId);
  const r = await deps.orchestration.pauseRun(runId);
  requestRefresh(runId);
  return r || { ok: true };
}

async function resumeRun(runId, { fresh = false } = {}) {
  await mustDescribe(runId);
  const r = await deps.orchestration.resumeRun(runId, { fresh: fresh === true });
  requestRefresh(runId);
  return r || { ok: true };
}

async function refreshOrchestrator(runId) {
  await mustDescribe(runId);
  const r = await deps.orchestration.refreshOrchestrator(runId);
  requestRefresh(runId);
  return r || { ok: true };
}

// ---------------------------------------------------------------------------
// The card and the pushes
// ---------------------------------------------------------------------------

function fmtElapsed(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return '<1 min';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// One worker, one icon: live state first, then the landing, then its report.
function workerIcon(w, events) {
  if (w.running) return w.state === 'busy' ? ['⏳', 'running'] : w.state === 'awaiting' ? ['❓', 'asking'] : ['💤', 'idle'];
  if (w.paused || w.state === 'paused') return ['⏸', 'paused'];
  const landing = [...events].reverse().find((e) => e.worker === w.name && (e.kind === 'landed' || e.kind === 'not landed'));
  if (landing) return landing.kind === 'landed' ? ['✅', 'landed'] : ['❌', 'not landed'];
  const status = w.lastReport && w.lastReport.status;
  if (status === 'failed') return ['❌', 'failed'];
  if (status === 'blocked') return ['⛔', 'blocked'];
  if (status === 'done') return ['✅', 'done'];
  return ['⏹', w.state || 'stopped'];
}

function cardText(runId, d, b) {
  const events = eventsOf(d);
  const phase = phaseOf(d);
  const lines = [`💻 ${titleOf(d, b)}`, `${STATE_LABEL[phase] || phase} · ${fmtElapsed(now() - (b.since || now()))}`];
  const workers = Array.isArray(d.workers) ? d.workers : [];
  if (workers.length) {
    lines.push('');
    for (const w of workers.slice(0, WORKER_LINES)) {
      const [icon, label] = workerIcon(w, events);
      lines.push(`${icon} ${w.name}${w.title ? ` — ${clip(w.title, 40)}` : ''}: ${label}`);
    }
    if (workers.length > WORKER_LINES) lines.push(`+${workers.length - WORKER_LINES} more`);
  }
  const last = events[events.length - 1];
  if (last) lines.push('', `Last: ${last.kind} — ${clip(last.text, 200)}`);
  const asks = pendingAsks(runId).length;
  if (asks) lines.push(`❓ ${asks} question${asks === 1 ? '' : 's'} waiting`);
  return lines.join('\n').slice(0, TEXT_CAP);
}

function cardMarkup(runId, d) {
  const rows = [];
  const open = openRow(runId);
  if (open) rows.push(open);
  const phase = phaseOf(d);
  if (d.mirror) { /* read-only: the run is controlled on its master */ }
  else if (phase === 'paused' || phase === 'exited') rows.push([{ text: '▶ Resume', callback_data: `vr:r:${runId}` }]);
  else if (LIVE_STATES.has(phase) && phase !== 'pausing') rows.push([{ text: '⏸ Pause run', callback_data: `vr:p:${runId}` }]);
  rows.push([{ text: '⏏ Disconnect', callback_data: `vr:x:${runId}` }]);
  return { inline_keyboard: rows };
}

function notModified(res) {
  return /not modified/i.test(String(res && res.description || ''));
}

function gone(res) {
  return /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(String(res && res.description || ''));
}

// Send or edit the card now. Runs inside the run's serial chain.
async function flushCard(runId, { resend = false } = {}) {
  const b = getBinding(runId);
  const want = cards.get(runId);
  if (!b || !want || !want.pending) return;
  const { text, markup } = want.pending;
  want.pending = null;
  if (b.cardId && !resend) {
    const res = await tg('editMessageText', { chat_id: b.chatId, message_id: b.cardId, text, reply_markup: markup });
    if (res && (res.ok || notModified(res))) { want.text = text; want.editedAt = now(); return; }
    if (!gone(res)) { console.warn(`[tg-runs] card edit ${runId}: ${res && res.description}`); return; }
  }
  if (b.cardId && resend) {
    // A fresh card at the bottom of the chat; the old one keeps its text, without buttons.
    await tg('editMessageReplyMarkup', { chat_id: b.chatId, message_id: b.cardId, reply_markup: { inline_keyboard: [] } });
  }
  const res = await tg('sendMessage', { chat_id: b.chatId, text, reply_markup: markup });
  const id = res && res.result && res.result.message_id;
  if (id) { b.cardId = id; save(); }
  want.text = text; want.editedAt = now();
}

function scheduleCard(runId, text, markup, { resend = false } = {}) {
  let want = cards.get(runId);
  if (!want) { want = { text: null, editedAt: 0, pending: null }; cards.set(runId, want); }
  if (!resend && want.text === text && JSON.stringify(want.markup) === JSON.stringify(markup) && getBinding(runId)?.cardId) return null;
  want.pending = { text, markup };
  want.markup = markup;
  if (resend) return flushCard(runId, { resend: true });
  if (timers.has(runId)) return null; // a trailing edit is already due
  const wait = (want.editedAt || 0) + (deps.cardEditMs ?? CARD_EDIT_MS) - now();
  if (wait <= 0) return flushCard(runId);
  const t = setTimeout(() => { timers.delete(runId); serial(runId, () => flushCard(runId)); }, wait);
  if (t.unref) t.unref();
  timers.set(runId, t);
  return null;
}

async function push(runId, text) {
  const b = getBinding(runId);
  if (!b) return;
  await tg('sendMessage', { chat_id: b.chatId, text: text.slice(0, 4096), ...(openMarkup(runId) ? { reply_markup: openMarkup(runId) } : {}) });
}

function requestRefresh(runId, delay) {
  if (!getBinding(runId) || refreshes.has(runId)) return;
  const t = setTimeout(() => { refreshes.delete(runId); serial(runId, () => refresh(runId)); }, delay ?? deps.refreshDebounceMs ?? REFRESH_DEBOUNCE_MS);
  if (t.unref) t.unref();
  refreshes.set(runId, t);
}

// The run's present: pushes for what is new, then the card. Serial per run.
async function refresh(runId, { resend = false } = {}) {
  const b = getBinding(runId);
  if (!b) return;
  const d = await describe(runId);
  if (!d) {
    await push(runId, `🗑 ${b.title || b.name}: the run no longer exists — disconnected.`);
    delete runs()[runId];
    save();
    broadcastBinding(runId, false, b.name);
    return;
  }
  const title = titleOf(d, b);
  let dirty = false;

  // Worker events after the last one seen.
  const fresh = freshEvents(d, b);
  for (const e of fresh) {
    if (e.kind === 'not landed') await push(runId, `❌ ${title}: ${clip(e.text, 600)}`);
    else if (e.kind === 'report' && /reported (failed|blocked)\b/.test(String(e.text))) await push(runId, `⚠️ ${title}: ${clip(e.text, 600)}`);
  }
  if (fresh.length) dirty = true;

  // State transitions.
  const phase = phaseOf(d);
  if (phase !== b.phase) {
    if (phase === 'paused') await push(runId, `⏸ ${title} is paused. Resume it from the card or the dashboard.`);
    else if (phase === 'ended') await push(runId, `🏁 ${title} has ended.`);
    b.phase = phase; b.since = now(); dirty = true;
  }
  // Idle and exited are pushed once they held for the settle time: the
  // orchestration hook blocks an orchestrator's Stop to deliver worker events
  // (so 'interaction:complete' is no idle signal), and a refresh exits one
  // orchestrator before the next is up.
  const idle = trulyIdle(d);
  if (!idle && b.idle) { b.idle = false; dirty = true; }
  if (phase !== 'exited' && b.exitedPushed) { b.exitedPushed = false; dirty = true; }
  const kind = idle && !b.idle ? 'idle' : phase === 'exited' && !b.exitedPushed ? 'exited' : null;
  if (!kind) {
    candidates.delete(runId);
  } else {
    const settle = deps.settleMs ?? SETTLE_MS;
    let c = candidates.get(runId);
    if (!c || c.kind !== kind) {
      c = { kind, since: now() };
      candidates.set(runId, c);
    }
    const left = settle - (now() - c.since);
    if (left > 0) {
      requestRefresh(runId, left); // a refresh already due re-arms it in turn
    } else {
      candidates.delete(runId);
      if (kind === 'idle') { b.idle = true; await push(runId, `💤 ${title} is idle — waiting for you. Open it to continue.`); }
      else { b.exitedPushed = true; await push(runId, `⏹ ${title}: the orchestrator exited. Resume the run from the card or the dashboard.`); }
      dirty = true;
    }
  }

  // Asks answered or dropped without a broadcast (a cleared tab).
  for (const askId of Object.keys(b.asks || {})) {
    if (!deps.pendingQuestions || !deps.pendingQuestions.has(askId)) { await closeAsk(b, askId, 'No longer waiting.'); dirty = true; }
  }
  if (dirty) save();
  await scheduleCard(runId, cardText(runId, d, b), cardMarkup(runId, d), { resend });
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

// The buttons a simple question gets, or null: exactly one question, select
// with 1-8 labelled options, or confirm / toggle. Each button's callback_data
// must fit Telegram's 64 bytes.
function inlineOptions(askId, questions) {
  if (!Array.isArray(questions) || questions.length !== 1) return null;
  const q = questions[0] || {};
  let opts;
  if (q.type === 'select') {
    const list = Array.isArray(q.options) ? q.options : [];
    if (!list.length || list.length > MAX_INLINE_OPTIONS) return null;
    opts = list.map((o) => {
      const label = typeof o === 'string' ? o : o && o.label;
      return label ? { label: String(label), value: String(label), description: o && o.description } : null;
    });
    if (opts.some((o) => !o)) return null;
  } else if (q.type === 'confirm' || q.type === 'toggle') {
    opts = [{ label: '✅ Yes', value: true }, { label: '✖ No', value: false }];
  } else {
    return null;
  }
  const data = opts.map((_, i) => `vq:${askId}:${i}`);
  if (data.some((s) => Buffer.byteLength(s) > CALLBACK_MAX)) return null;
  return opts.map((o, i) => ({ ...o, data: data[i] }));
}

function questionsOf(askId, msg) {
  const p = deps.pendingQuestions && deps.pendingQuestions.get(askId);
  if (p) return { formData: p.formData || {}, questions: p.questions || (p.formData && p.formData.questions) || [] };
  const f = msg && Array.isArray(msg.forms) ? msg.forms[0] : null;
  return f ? { formData: f.formData || {}, questions: f.questions || (f.formData && f.formData.questions) || [] } : null;
}

async function postQuestion(runId, askId, msg) {
  const b = getBinding(runId);
  if (!b || (b.asks && b.asks[askId])) return; // a replay of one already posted
  const q = questionsOf(askId, msg);
  if (!q) return;
  b.asks = b.asks || {};
  b.asks[askId] = { messageId: null }; // claimed before the await: one message per ask
  const title = b.title || b.name;
  const options = inlineOptions(askId, q.questions);
  // Plain text (no parse_mode): the label cannot carry markup.
  const remote = remoteOf((deps.pendingQuestions && deps.pendingQuestions.get(askId)) || msg);
  const shown = remote ? unMd : (t) => t;
  let text; let rows;
  if (options) {
    const one = q.questions[0];
    const head = [one.header, q.formData.title].find((s) => s && s !== one.question);
    text = [`❓ ${title}${head ? ` — ${head}` : ''}`, '', clip(shown(one.question), 1500),
      ...options.filter((o) => o.description).map((o) => `• ${o.label} — ${clip(shown(o.description), 200)}`)].join('\n');
    rows = options.map((o) => [{ text: clip(o.label, 60), callback_data: o.data }]);
  } else {
    text = `❓ ${title}: Claude asks something — answer in the Mini App.`;
    rows = [];
  }
  if (remote) text = `${remoteLine(remote)}\n${text}`;
  const open = openRow(runId);
  if (open) rows.push(open);
  const res = await tg('sendMessage', { chat_id: b.chatId, text, ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}) });
  const messageId = res && res.result && res.result.message_id;
  if (!getBinding(runId) || !b.asks[askId]) { // answered or unbound while it was being sent
    if (messageId) await tg('editMessageText', { chat_id: b.chatId, message_id: messageId, text: `${text}\n\nNo longer waiting.` });
    return;
  }
  // A remote ask's buttons answer for the tab it was posted for (tabRefusal).
  b.asks[askId] = { messageId: messageId || null, text, inline: !!options, ...(remote ? { tabId: remote.tabId } : {}) };
  save();
  requestRefresh(runId);
}

// The question's message, closed: its text plus an outcome line, no buttons.
async function closeAsk(b, askId, outcome) {
  const a = b.asks && b.asks[askId];
  if (!a) return;
  delete b.asks[askId];
  save();
  if (!a.messageId) return;
  await tg('editMessageText', { chat_id: b.chatId, message_id: a.messageId, text: `${a.text || '❓'}\n\n${outcome}`.slice(0, 4096) });
}

function bindingOfAsk(askId) {
  for (const [runId, b] of Object.entries(runs())) if (b.asks && b.asks[askId]) return { runId, b };
  return null;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

function handleBroadcast(msg) {
  if (!enabled() || !msg || !msg.type) return;
  try {
    if (msg.type === 'orchestration:run' && msg.runId && getBinding(msg.runId)) {
      requestRefresh(msg.runId);
    } else if (msg.type === 'ask:question' && (msg.tabId || isRemoteAsk(msg))) {
      // A relayed ask: its pending entry, else the message's remote tab.
      const runId = isRemoteAsk(msg)
        ? askRun((deps.pendingQuestions && deps.pendingQuestions.get(msg.askId)) || msg)
        : runOfTab(msg.tabId);
      if (runId && getBinding(runId)) serial(`ask:${msg.askId}`, () => postQuestion(runId, msg.askId, msg));
    } else if ((msg.type === 'ask:answered' || msg.type === 'ask:timeout') && msg.askId) {
      const hit = bindingOfAsk(msg.askId);
      if (hit) {
        serial(hit.runId, () => closeAsk(hit.b, msg.askId, msg.type === 'ask:answered' ? '✅ Answered elsewhere.' : '⌛ No longer waiting (timed out).'));
        requestRefresh(hit.runId);
      }
    } else if (msg.type === 'cli:exit' && msg.tabId) {
      const runId = runOfTab(msg.tabId);
      if (runId && getBinding(runId)) requestRefresh(runId);
    } else if (msg.type === 'cli:paused') {
      for (const runId of Object.keys(runs())) requestRefresh(runId);
    } else if (msg.type === 'sdk:event' && msg.runId && msg.ev && msg.ev.platform && msg.ev.platform.kind === 'status') {
      if (getBinding(msg.runId)) requestRefresh(msg.runId);
    }
  } catch (err) {
    console.error('[tg-runs] broadcast handler error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// The control bot: the Sessions list and the card / question buttons
// ---------------------------------------------------------------------------

// Paused: the run is, and its orchestrator is not open.
function listPaused(r) {
  return !!r.paused && (r.state === 'paused' || !r.orchestratorTabId);
}

function listed(r) {
  return listPaused(r) || r.pausing || (r.state && !['exited', 'closed', 'ended', 'stopped'].includes(r.state));
}

// The "💻 Sessions" view: live and paused runs; tap = bind (+ card), a paused
// one offers Resume (which binds too).
async function sessionsView(chatId) {
  const list = (await listRuns()).filter(listed).slice(0, 8);
  if (!list.length) return { text: 'No live or paused orchestrator runs.', markup: { inline_keyboard: [[{ text: '✖ Close', callback_data: 'vc_cancel' }]] } };
  const lines = ['Orchestrator runs — tap one to follow it here:', ''];
  const rows = [];
  for (const r of list) {
    const bound = getBinding(r.runId) && String(getBinding(r.runId).chatId) === String(chatId);
    const label = clip(r.title || r.name || r.runId, 40);
    const state = listPaused(r) ? 'paused' : r.pausing ? 'pausing' : r.state;
    lines.push(`${bound ? '🔗' : '•'} ${label} — ${state}${r.workerCount ? `, ${r.workerCount} worker${r.workerCount === 1 ? '' : 's'}` : ''}`);
    if (listPaused(r)) rows.push([{ text: `▶ Resume ${label}`, callback_data: `vr:r:${r.runId}` }]);
    else rows.push([{ text: `${bound ? '🔗' : '💻'} ${label}`, callback_data: `vr:b:${r.runId}` }]);
  }
  rows.push([{ text: '✖ Close', callback_data: 'vc_cancel' }]);
  return { text: lines.join('\n'), markup: { inline_keyboard: rows } };
}

// vr:<b|p|r|x>:<runId> (bind, pause, resume, disconnect), vq:<askId>:<i>
// (answer). The caller has checked the chat is the privileged one.
async function handleCallback(chatId, data, message) {
  const say = (text) => tg('sendMessage', { chat_id: chatId, text });
  if (data === 'vr_list') {
    if (!enabled()) return say('Orchestration runs are not available on this server.');
    const v = await sessionsView(chatId);
    return tg('sendMessage', { chat_id: chatId, text: v.text, reply_markup: v.markup });
  }
  if (data.startsWith('vq:')) {
    const m = /^vq:(.+):(\d+)$/.exec(data);
    if (!m) return null;
    const [, askId, idx] = m;
    const pending = deps.pendingQuestions && deps.pendingQuestions.get(askId);
    const hit = bindingOfAsk(askId);
    const runId = pending ? askRun(pending) : hit && hit.runId;
    if (!pending || !runId) {
      if (hit) await closeAsk(hit.b, askId, 'Already answered.');
      else if (message && message.message_id) await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: message.message_id, reply_markup: { inline_keyboard: [] } });
      return null;
    }
    const q = (pending.questions || [])[0] || {};
    const opt = (inlineOptions(askId, pending.questions) || [])[Number(idx)];
    if (!opt) return say('That answer is no longer offered — open the Mini App.');
    const posted = hit && hit.b.asks[askId];
    const refusal = tabRefusal(pending, posted && posted.tabId);
    if (refusal) return say(`Not answered: ${refusal} — open the Mini App.`);
    const b = getBinding(runId);
    if (b && b.asks && b.asks[askId]) await closeAsk(b, askId, `✅ Answered: ${opt.label}`);
    pending.resolve([{ id: q.id, question: q.question, answer: opt.value }]);
    try { deps.broadcaster?.broadcast({ type: 'ask:answered', askId }); } catch {}
    return null;
  }
  const m = /^vr:([bprx]):([A-Za-z0-9_-]+)$/.exec(data);
  if (!m) return null;
  const [, op, runId] = m;
  try {
    if (op === 'b') await bind(chatId, runId);
    else if (op === 'p') { const r = await pauseRun(runId); if (r && r.error) throw new Error(r.error); }
    else if (op === 'r') {
      const r = await resumeRun(runId);
      if (r && r.error) throw new Error(r.error);
      await bind(chatId, runId);
    } else if (op === 'x') await unbind(runId);
  } catch (err) {
    await say(`Could not ${({ b: 'connect', p: 'pause', r: 'resume', x: 'disconnect' })[op]} the run: ${err.message}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function runsSummary(list, chatId) {
  const counts = new Map();
  const pq = deps.pendingQuestions;
  if (pq) for (const [, p] of pq) { const r = askRun(p); if (r) counts.set(r, (counts.get(r) || 0) + 1); }
  return list.map((r) => ({
    runId: r.runId, name: r.name || `orch-${r.runId}`, title: r.title || null, engine: r.engine || 'cli',
    state: r.state || null, busy: !!r.busy, paused: !!r.paused, pausing: !!r.pausing,
    bound: !!getBinding(r.runId) && (chatId == null || String(getBinding(r.runId).chatId) === String(chatId)),
    workerCount: r.workerCount || 0, pendingQuestions: counts.get(r.runId) || 0, updatedAt: r.updatedAt || null,
  }));
}

function transcriptSource(d) {
  if ((d.engine || 'cli') === 'sdk') {
    let dir = d.notes ? path.dirname(d.notes) : null;
    if (!dir) {
      const s = sessionOf(orchestratorTabOf(d.runId, d));
      try { dir = s && s.getSettings ? s.getSettings().sessionDir || null : null; } catch {}
    }
    return dir ? { kind: 'sdk', file: path.join(dir, 'transcript.jsonl'), orchestrator: d.orchestrator } : null;
  }
  return d.orchestratorSessId && deps.store ? { kind: 'cli', store: deps.store, sessId: d.orchestratorSessId } : null;
}

async function runDetail(runId, since, chatId) {
  const d = await mustDescribe(runId);
  const listedRun = (await listRuns()).find((r) => r.runId === runId) || {};
  const phase = phaseOf(d);
  const t = transcript.read(transcriptSource(d), since);
  const b = getBinding(runId);
  return {
    runId,
    name: listedRun.name || d.orchestrator || `orch-${runId}`,
    title: listedRun.title || d.title || null,
    engine: d.engine || 'cli',
    state: phase,
    busy: phase === 'busy' || phase === 'awaiting',
    paused: phase === 'paused',
    pausing: phase === 'pausing',
    bound: !!b && (chatId == null || String(b.chatId) === String(chatId)),
    workers: (d.workers || []).map((w) => ({
      workerId: w.id, name: w.name, title: w.title || null, state: w.state || null,
      lastReport: w.lastReport || null, progress: w.progress || null,
    })),
    events: eventsOf(d).map((e) => ({ seq: e.seq, at: e.at, worker: e.worker || null, kind: e.kind, text: e.text })),
    pendingQuestions: pendingAsks(runId),
    transcript: t.transcript,
    cursor: t.cursor,
    reset: t.reset,
  };
}

// The run routes of the Mini App, under the tg-session base and its auth.
// 404 for an unknown run, and for every route on a core without runs (the
// client then falls back to the legacy single session); other errors 400.
function mountApi(router, base, authed) {
  const guard = (handler) => authed(async (req, res, rec) => {
    if (!enabled()) return res.status(404).json({ error: 'not found: this server has no orchestration runs' });
    try {
      return await handler(req, res, rec);
    } catch (err) {
      if (err.message === 'run not found') return res.status(404).json({ error: err.message });
      throw err;
    }
  });
  const runIdOf = (req) => {
    const id = String(req.params.runId || '');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error('bad runId');
    return id;
  };

  router.get(`${base}/runs`, guard(async (req, res, rec) => {
    const list = await listRuns();
    res.json({ runs: runsSummary(list, rec.chatId), remote: remoteSessions(new Set(list.map((r) => r.runId))) });
  }));

  router.post(`${base}/remote/answer`, guard(async (req, res) => {
    const { askId, answer, tabId } = req.body || {};
    try {
      res.json(await answerRemote(askId, answer, tabId));
    } catch (err) {
      res.status(/not pending/.test(err.message) ? 404 : 400).json({ error: err.message });
    }
  }));

  router.get(`${base}/run/:runId`, guard(async (req, res, rec) => {
    res.json(await runDetail(runIdOf(req), req.query.since, rec.chatId));
  }));

  router.post(`${base}/run/:runId/bind`, guard(async (req, res, rec) => {
    await bind(rec.chatId, runIdOf(req));
    res.json({ ok: true, bound: true });
  }));

  router.post(`${base}/run/:runId/unbind`, guard(async (req, res) => {
    await unbind(runIdOf(req));
    res.json({ ok: true, bound: false });
  }));

  router.post(`${base}/run/:runId/send`, guard(async (req, res, rec) => {
    res.json(await send(rec.chatId, runIdOf(req), req.body && req.body.text));
  }));

  router.post(`${base}/run/:runId/answer`, guard(async (req, res) => {
    const { askId, answer, tabId } = req.body || {};
    try {
      res.json(await answerAsk(runIdOf(req), askId, answer, { tabId }));
    } catch (err) {
      res.status(/not pending/.test(err.message) ? 404 : 400).json({ error: err.message });
    }
  }));

  router.post(`${base}/run/:runId/esc`, guard(async (req, res) => { res.json(await interrupt(runIdOf(req))); }));
  router.post(`${base}/run/:runId/pause`, guard(async (req, res) => { res.json(await pauseRun(runIdOf(req))); }));
  router.post(`${base}/run/:runId/resume`, guard(async (req, res) => { res.json(await resumeRun(runIdOf(req), { fresh: !!(req.body && req.body.fresh) })); }));
  router.post(`${base}/run/:runId/refresh`, guard(async (req, res) => { res.json(await refreshOrchestrator(runIdOf(req))); }));
}

function ownerChat() {
  if (deps.controlChatId) return deps.controlChatId();
  return require('./platform-horst').controlChatId();
}

// The dashboard's "continue on Telegram" (owner only). Mounted on the Pro
// router outside the auth-exempt /pro/tg-session subtree, so core's auth
// middleware guards it; the handler re-checks isOwnerRequest regardless.
function mountHandoff(router) {
  const base = '/pro/tg-handoff';
  const owner = (handler) => async (req, res) => {
    if (typeof deps.isOwnerRequest !== 'function' || !deps.isOwnerRequest(req)) return res.status(403).json({ error: 'owner only' });
    if (!enabled()) return res.status(404).json({ error: 'Orchestration runs are not available on this server' });
    try { await handler(req, res); } catch (err) { res.status(400).json({ error: err.message }); }
  };
  const chat = () => {
    const id = ownerChat();
    if (id == null) throw new Error('Telegram is not configured: set up the control bot in restricted mode and claim its chat');
    return id;
  };
  const runIdOf = (req) => {
    const id = String((req.body && req.body.runId) || '');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error('runId required');
    return id;
  };

  router.post(`${base}/bind`, owner(async (req, res) => {
    const runId = runIdOf(req);
    await bind(chat(), runId);
    res.json({ ok: true, runId, bound: true });
  }));
  router.post(`${base}/unbind`, owner(async (req, res) => {
    const runId = runIdOf(req);
    await unbind(runId);
    res.json({ ok: true, runId, bound: false });
  }));
  router.get(`${base}/bindings`, owner(async (req, res) => {
    res.json({ runs: boundRuns(ownerChat()) });
  }));
}

// Tests: wait for every queued refresh / Telegram op.
async function _settled() {
  for (let i = 0; i < 5; i++) await Promise.all([...chains.values()]);
}

module.exports = {
  init, enabled, handleBroadcast, handleCallback, sessionsView, mountApi, mountHandoff,
  bind, unbind, send, interrupt, answerAsk, answerRemote, remoteSessions, pauseRun, resumeRun, refreshOrchestrator,
  getBinding, boundRuns, runOfTab, askRun, orchestratorTabOf, inlineOptions, runDetail,
  refresh: (runId) => serial(runId, () => refresh(runId)), _settled,
};
