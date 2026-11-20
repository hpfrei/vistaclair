// Horst's long-running app tools — the horst route of app-tool-jobs.js.
//
// An owner chat turn (the Horst tab, the Telegram control chat) that calls a
// job-kind app tool never starts it: app-tools resolves the turn's caller to
// `{ type: 'horst', conversationId, chatId?, surface }` and app-tool-jobs
// hands the call to stage() here, which freezes it as an `app.tool.job`
// proposal (capabilities/tools.js) and tells the model it awaits the owner's
// tap. Approval runs launch(): the exact stored payload starts on the horst
// route with no wait, so the chat is never blocked.
//
// Everything after that is deterministic — no model call:
//   outcome   an assistant message in the originating conversation (status,
//             duration, the result text, structuredContent, the artifact
//             uris); its resource_link artifacts recorded as one delivery
//             (horst-deliveries.js, Vista › Files); for a Telegram turn the
//             text as ONE message with an "Open in Vista" button (a picture's
//             preview photo when it carried one) — no file is uploaded.
//   question  a conversation message and a Telegram message the owner answers
//             by replying to it (answerFromTelegram) — or in chat, where Horst
//             passes it on with horst_job_reply.
//   progress  one Telegram message per job, edited in place (throttled), the
//             latest note included; closed with the outcome line.
//
// At most MAX_RUNNING horst-route jobs run at once; an approval beyond that
// fails with a message naming the running ones (nothing is queued).
// Telegram state (progress message ids, open question messages) persists in
// <dir>/tool-jobs-tg.json, written atomically, so a restart keeps editing the
// same message and still recognises a reply.

const fs = require('fs');
const path = require('path');

const MAX_RUNNING = 2;
const PROGRESS_EDIT_MS = 5000;
const TEXT_CAP = 3000;
const DETAILS_CAP = 1500;
const OWNER_SURFACES = new Set(['ui', 'telegram']);
const STATUS_ICON = { done: '✅', error: '❌', cancelled: '🚫', interrupted: '⚠️' };

let deps = {};
let state = null;
const timers = new Map(); // jobId → pending progress edit
const chains = new Map(); // jobId → Promise (one Telegram op at a time per job)

// init({ dir, governance, appendMessage(conversationId, text, extra) → msg,
//        sendControlMessage(chatId, text, markup) → [{ messageId }],
//        telegram: { call(method, params) },
//        controlChatId(), isOwnerAct?(chat, from), onStaged?(caller, proposal),
//        now?, progressEditMs? })
function init(options = {}) {
  deps = options;
  state = null;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  chains.clear();
  return require('../app-tool-jobs').onHorstRoute({ stage, done, question, note, progress });
}

const now = () => (deps.now ? deps.now() : Date.now());
const jobs = () => require('../app-tool-jobs');
const label = (rec) => `${rec.app} › ${rec.tool}`;

// ---------------------------------------------------------------------------
// Telegram state
// ---------------------------------------------------------------------------

function statePath() { return path.join(deps.dir, 'tool-jobs-tg.json'); }

function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { state = null; }
  if (!state || typeof state !== 'object') state = {};
  state.jobs = state.jobs || {};
  state.questions = state.questions || {};
  return state;
}

function save() {
  if (!deps.dir) return;
  try {
    const tmp = `${statePath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(load(), null, 2));
    fs.renameSync(tmp, statePath());
  } catch (err) {
    console.warn('[horst-jobs] state write failed:', err.message);
  }
}

function serial(id, fn) {
  const next = (chains.get(id) || Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {});
  chains.set(id, tail);
  tail.then(() => { if (chains.get(id) === tail) chains.delete(id); });
  return next;
}

// The control chat only: a payload naming any other chat reports to the
// conversation alone.
function tgChatOf(rec) {
  const chatId = rec && rec.caller && rec.caller.chatId;
  if (chatId == null || !deps.controlChatId) return null;
  const control = deps.controlChatId();
  return control != null && String(control) === String(chatId) ? chatId : null;
}

// ---------------------------------------------------------------------------
// Staging and launching
// ---------------------------------------------------------------------------

function runningJobs() {
  return jobs().list('owner').filter((j) => j.caller && j.caller.type === 'horst' && j.status === 'running');
}

// A horst caller's job-tool call → the tool result the model reads. `plan`
// (the reserved `_plan`, stripped from args by app-tools) leads the card.
async function stage({ app, tool, args, plan, caller }) {
  if (!OWNER_SURFACES.has(caller.surface)) {
    throw new Error('Long-running tools start only from the owner\'s own chat (the Horst tab or the Telegram control chat).');
  }
  const payload = { app, tool, args: args || {}, conversationId: caller.conversationId };
  if (plan) payload.plan = plan;
  if (caller.chatId != null) payload.chatId = String(caller.chatId);
  const p = deps.governance.createProposal('app.tool.job', payload, { origin: 'chat' });
  try { deps.onStaged?.(caller, p); } catch {}
  const busy = runningJobs();
  const lines = [
    `Staged ${p.id}: ${app}__${tool} starts only when the owner taps Start on its card.`,
    'Do not wait for it and do not call the tool again — tell the owner it is waiting for their tap.',
    'Once it runs, progress, any question and the result (with its files) arrive in this conversation by themselves.',
  ];
  if (!plan) lines.push('No _plan was given, so the card says "no plan given" — next time pass _plan: your plan in 1-3 plain sentences.');
  if (busy.length >= MAX_RUNNING) {
    lines.push(`Note: ${busy.length} long-running tools are already running (${busy.map((j) => j.id).join(', ')}); a Start beyond ${MAX_RUNNING} is refused until one ends.`);
  }
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: { proposalId: p.id, status: 'awaiting-approval', tool: `${app}__${tool}` },
  };
}

// The app.tool.job launcher: exactly the stored payload, no wait.
async function launch(p, proposal) {
  if (!proposal || proposal.origin !== 'chat') {
    throw new Error('app.tool.job runs only from the owner\'s chat request — never from a routine, triage or a mission');
  }
  const busy = runningJobs();
  if (busy.length >= MAX_RUNNING) {
    const msg = `${busy.length} long-running tools are already running (${busy.map((j) => `${j.id} ${j.name}`).join(', ')}) — wait for one to finish or cancel it, then ask again.`;
    appendSafe(p.conversationId, `⏸ Not started: ${p.app} › ${p.tool}. ${msg}`);
    throw new Error(msg);
  }
  const control = deps.controlChatId ? deps.controlChatId() : null;
  const chatId = p.chatId != null && control != null && String(control) === String(p.chatId) ? String(p.chatId) : null;
  const caller = { type: 'horst', conversationId: p.conversationId, chatId, surface: chatId ? 'telegram' : 'ui' };
  let r;
  try {
    r = await require('../app-tools').callAppToolHandler(p.app, p.tool, p.args || {}, caller, { wait: 0, approved: true });
  } catch (err) {
    appendSafe(p.conversationId, `❌ ${p.app} › ${p.tool} could not start: ${err.message}`);
    throw err;
  }
  const jobId = r && r.structuredContent && r.structuredContent.jobId;
  if (!jobId) {
    // Ended before the call returned: the result is the outcome.
    appendSafe(p.conversationId, outcomeText({ app: p.app, tool: p.tool, id: '', status: 'done', startedAt: now(), endedAt: now(), result: r }));
    return { ok: true, summary: `${p.app}__${p.tool} finished at once` };
  }
  const rec = jobs().get(jobId, 'owner');
  appendSafe(p.conversationId, `▶ Started ${label(rec)} (${jobId}). Progress, questions and the result will appear here.`, { job: { id: jobId, status: 'running' } });
  if (chatId) serial(jobId, () => ensureProgressMessage(rec));
  return { ok: true, summary: `Started ${jobId} (${p.app}__${p.tool})` };
}

// notifyDecision hook: a denial is said in the conversation (the card itself
// shows it on every surface).
function decided(p) {
  if (!p || p.kind !== 'app.tool.job' || p.status !== 'denied') return;
  appendSafe(p.payload && p.payload.conversationId, `🚫 Not started — you declined ${p.payload.app} › ${p.payload.tool}.`);
}

function appendSafe(conversationId, text, extra) {
  if (!conversationId || !deps.appendMessage) return null;
  try { return deps.appendMessage(conversationId, text, extra); } catch (err) {
    console.warn('[horst-jobs] conversation append failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// The outcome
// ---------------------------------------------------------------------------

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

function sizeLabel(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function resultOf(rec) {
  const r = rec.result;
  if (r && typeof r === 'object' && Array.isArray(r.content)) return r;
  if (r === null || r === undefined) return { content: [] };
  return { content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r) }] };
}

function linksOf(rec) {
  return resultOf(rec).content.filter((b) => b && b.type === 'resource_link' && typeof b.uri === 'string');
}

// The `Files:` block of a message, one line per resource_link — the shape the
// Horst tab renders as chips (public/horst/horst-artifact-chips.js). '' for none.
function fileLines(links) {
  if (!links || !links.length) return '';
  return ['Files:', ...links.map((b) => {
    const meta = [b.mimeType, sizeLabel(b.size)].filter(Boolean).join(', ');
    return `- ${b.name || b.uri}${meta ? ` (${meta})` : ''}: ${b.uri}`;
  })].join('\n');
}

// Header, the result text, structuredContent, one line per artifact — what
// the conversation keeps, so a later turn can name `project` or a file.
// `brief` leaves the Details JSON and the artifact lines out — the Telegram
// copy, which links to Vista › Files instead.
function outcomeText(rec, { brief = false } = {}) {
  const icon = STATUS_ICON[rec.status] || 'ℹ️';
  const lines = [`${icon} ${label(rec)} ${rec.status} (${fmtDuration((rec.endedAt || now()) - rec.startedAt)})${rec.id ? ` — ${rec.id}` : ''}`];
  if (rec.status === 'interrupted') lines.push(`Interrupted: ${rec.error || 'the provider stopped'}. Asking again should continue the work.`);
  else if (rec.error) lines.push(`Error: ${rec.error}`);
  const res = resultOf(rec);
  let text = res.content.filter((b) => b && b.type === 'text').map((b) => String(b.text)).join('\n').trim();
  if (text.length > TEXT_CAP) text = `${text.slice(0, TEXT_CAP)}\n… (truncated — horst_job_status has the full result)`;
  if (text) lines.push('', text);
  const sc = res.structuredContent;
  if (sc && typeof sc === 'object') {
    if (sc.project !== undefined) lines.push('', `project: ${typeof sc.project === 'string' ? sc.project : JSON.stringify(sc.project)}`);
    let details = JSON.stringify(sc);
    if (details.length > DETAILS_CAP) details = `${details.slice(0, DETAILS_CAP)}…`;
    if (!brief) lines.push(`Details: ${details}`);
  }
  const files = brief ? '' : fileLines(linksOf(rec));
  if (files) lines.push('', files);
  if (rec.status === 'done' && sc && sc.project !== undefined) {
    lines.push('', `To change this result, call ${rec.app}__${rec.tool} again with project ${JSON.stringify(sc.project)}.`);
  }
  return lines.join('\n');
}

// The delivery's title in Vista › Files: the result's first text line, else
// the tool.
function summaryOf(rec) {
  const first = resultOf(rec).content.filter((b) => b && b.type === 'text')
    .map((b) => String(b.text)).join('\n').split('\n').map((l) => l.trim()).find(Boolean);
  return first || label(rec);
}

// Resolved = delivered: the conversation append is what must happen; the
// delivery record and the Telegram copy are best effort (a failure is logged,
// never re-sent).
async function done(rec) {
  if (!deps.appendMessage) throw new Error('Horst chat is not ready');
  const text = outcomeText(rec);
  deps.appendMessage(rec.caller.conversationId, text, { job: { id: rec.id, status: rec.status } });
  let delivered = [];
  try {
    delivered = require('./horst-deliveries').record(linksOf(rec), {
      source: 'job', conversationId: rec.caller.conversationId, jobId: rec.id, app: rec.app, tool: rec.tool, title: summaryOf(rec),
    });
  } catch (err) { console.warn('[horst-jobs] delivery record failed:', err.message); }
  await serial(rec.id, () => closeProgress(rec));
  const chatId = tgChatOf(rec);
  if (chatId == null) return;
  try {
    await require('./horst-deliveries').toTelegram(chatId, outcomeText(rec, { brief: delivered.length > 0 }), delivered);
  } catch (err) { console.warn('[horst-jobs] outcome send failed:', err.message); }
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

async function question(rec) {
  const q = rec.pendingQuestion;
  if (!q) return;
  appendSafe(rec.caller.conversationId, `❓ ${label(rec)} (${rec.id}) asks: ${q.text}\nAnswer here and Horst passes it on, or reply to the question on Telegram.`, { job: { id: rec.id, question: true } });
  const chatId = tgChatOf(rec);
  if (chatId == null) return;
  const sent = await deps.sendControlMessage(chatId, `❓ ${label(rec)} asks:\n${q.text}\n\n↩ Reply to this message to answer.`, { force_reply: true, input_field_placeholder: 'Your answer' });
  const last = sent && sent[sent.length - 1];
  if (!last) throw new Error('the question could not be sent to Telegram');
  const st = load();
  st.questions[`${chatId}:${last.messageId}`] = rec.id;
  save();
}

function dropQuestions(jobId) {
  const st = load();
  let changed = false;
  for (const [k, id] of Object.entries(st.questions)) if (id === jobId) { delete st.questions[k]; changed = true; }
  if (changed) save();
}

// A Telegram reply to one of our question messages → the job's answer.
// → null when the replied-to message is not a question of ours, or when the
// sender is not the owner (`actor` = the inbound message, chat + from; with
// deps.isOwnerAct set an answer without a verified owner is refused).
function answerFromTelegram(chatId, replyToMessageId, text, actor) {
  if (deps.isOwnerAct && !deps.isOwnerAct(actor?.chat, actor?.from)) return null;
  const key = `${chatId}:${replyToMessageId}`;
  const jobId = load().questions[key];
  if (!jobId) return null;
  delete load().questions[key];
  save();
  let rec;
  try { rec = jobs().get(jobId, 'owner'); } catch { return { ok: false, text: 'That job no longer exists.' }; }
  try {
    jobs().reply(jobId, String(text), 'owner');
  } catch {
    return { ok: false, text: `That question is no longer open (${label(rec)} is ${rec.status}).` };
  }
  appendSafe(rec.caller.conversationId, `↩ Your answer went to ${label(rec)} (${jobId}): ${String(text).slice(0, 500)}`);
  return { ok: true, text: `→ Answer sent to ${label(rec)}.` };
}

// ---------------------------------------------------------------------------
// Progress — one message per job, edited in place
// ---------------------------------------------------------------------------

function renderProgress(rec, t) {
  const bits = [t.pct !== undefined && t.pct !== null ? `${Math.round(Number(t.pct))}%` : null, t.label || null].filter(Boolean);
  const lines = [`⏳ ${label(rec)} — ${bits.length ? bits.join(' ') : 'running'}`];
  if (t.note) lines.push(`📝 ${String(t.note).slice(0, 500)}`);
  lines.push(`${rec.id} · started ${new Date(rec.startedAt).toTimeString().slice(0, 5)}`);
  return lines.join('\n');
}

async function tgEdit(t, text) {
  try {
    await deps.telegram.call('editMessageText', { chat_id: t.chatId, message_id: t.messageId, text });
  } catch (err) {
    // Telegram answers an identical text with "message is not modified".
    if (!/not modified/i.test(err && err.message)) throw err;
  }
  t.text = text;
  t.lastEditAt = now();
}

async function ensureProgressMessage(rec) {
  const chatId = tgChatOf(rec);
  if (chatId == null) return null;
  const st = load();
  const t = st.jobs[rec.id] || (st.jobs[rec.id] = { chatId });
  if (t.messageId) return t;
  const text = renderProgress(rec, t);
  const sent = await deps.sendControlMessage(chatId, text);
  const last = sent && sent[sent.length - 1];
  if (!last) return null;
  Object.assign(t, { messageId: last.messageId, text, lastEditAt: now() });
  save();
  return t;
}

async function flushProgress(rec) {
  timers.delete(rec.id);
  let live = null;
  try { live = jobs().get(rec.id, 'owner'); } catch {}
  if (!live || live.status !== 'running') return; // the outcome closes it
  const t = await ensureProgressMessage(rec);
  if (!t || load().jobs[rec.id] !== t) return;
  const text = renderProgress(rec, t);
  if (text === t.text) return;
  await tgEdit(t, text);
  save();
}

function track(rec, patch) {
  if (rec.status !== 'running' || tgChatOf(rec) == null) return false;
  const st = load();
  const t = st.jobs[rec.id] || (st.jobs[rec.id] = { chatId: tgChatOf(rec) });
  Object.assign(t, patch);
  if (timers.has(rec.id)) return true;
  // Throttled with a trailing edit: the latest state always lands.
  const every = deps.progressEditMs != null ? deps.progressEditMs : PROGRESS_EDIT_MS;
  const wait = Math.max(0, (t.lastEditAt || 0) + every - now());
  const fire = () => serial(rec.id, () => flushProgress(rec)).catch((err) => console.warn('[horst-jobs] progress edit failed:', err.message));
  if (wait === 0 && t.messageId) { timers.set(rec.id, null); fire(); return true; }
  const timer = setTimeout(fire, wait || 0);
  if (timer.unref) timer.unref();
  timers.set(rec.id, timer);
  return true;
}

function progress(rec, { pct, label: text } = {}) { return track(rec, { pct, label: text || null }); }
function note(rec, text) { return track(rec, { note: String(text) }); }

// The outcome closes the progress message with its final line.
async function closeProgress(rec) {
  const timer = timers.get(rec.id);
  if (timer) clearTimeout(timer);
  timers.delete(rec.id);
  dropQuestions(rec.id);
  const st = load();
  const t = st.jobs[rec.id];
  if (!t) return;
  delete st.jobs[rec.id];
  save();
  if (!t.messageId) return;
  const final = `${STATUS_ICON[rec.status] || 'ℹ️'} ${label(rec)} ${rec.status} (${fmtDuration((rec.endedAt || now()) - rec.startedAt)}) · ${rec.id}`;
  try { await tgEdit(t, final); } catch (err) { console.warn('[horst-jobs] progress close failed:', err.message); }
}

// ---------------------------------------------------------------------------
// Chat tools (the __platform__ pack, platform-horst.registerPlatformToolPack)
// ---------------------------------------------------------------------------

function horstJob(jobId) {
  const rec = jobs().get(jobId, 'owner');
  if (!rec.caller || rec.caller.type !== 'horst') throw new Error(`No Horst job "${jobId}"`);
  return rec;
}

function ownerChatOnly(caller) {
  if (!caller || caller.type !== 'horst') throw new Error('only Horst\'s owner chat manages his long-running tools');
}

const jobIdProp = { type: 'string', description: 'The job id (tj_…) from the "Started" message.' };
function tools() {
  const text = (t) => ({ content: [{ type: 'text', text: t }] });
  return [
    {
      def: {
        name: 'horst_job_status',
        description: 'Read-only: the long-running app tools started from Horst\'s chat. With jobId: its full record, progress, open question and result; without: the recent ones, newest first.',
        inputSchema: { type: 'object', properties: { jobId: jobIdProp } },
        expose: 'platform',
        sideEffects: 'none',
      },
      handler: async (args) => {
        if (!args || !args.jobId) {
          const list = jobs().list('owner').filter((j) => j.caller && j.caller.type === 'horst').slice(0, 20).map((j) => ({
            id: j.id, tool: j.name, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt,
            ...(j.progress ? { progress: j.progress } : {}),
            ...(j.pendingQuestion ? { question: j.pendingQuestion.text } : {}),
          }));
          return text(list.length ? JSON.stringify({ jobs: list }) : 'No long-running tools started from chat.');
        }
        const rec = horstJob(args.jobId);
        const lines = [jobs().formatOutcome(rec, { full: true })];
        if (rec.progress) lines.push(`Progress: ${[rec.progress.pct !== undefined ? `${rec.progress.pct}%` : null, rec.progress.label].filter(Boolean).join(' ')}`);
        if (rec.pendingQuestion) lines.push(`Asks: ${rec.pendingQuestion.text} (answer with horst_job_reply)`);
        return text(lines.join('\n'));
      },
    },
    {
      def: {
        name: 'horst_job_cancel',
        description: 'Cancel a running long-running app tool that was started from this chat, when the owner asks for it.',
        inputSchema: { type: 'object', properties: { jobId: jobIdProp }, required: ['jobId'] },
        expose: 'platform',
        sideEffects: 'writes',
      },
      handler: async (args, caller) => {
        ownerChatOnly(caller);
        horstJob(args.jobId);
        return text(JSON.stringify(jobs().cancel(args.jobId, 'owner')));
      },
    },
    {
      def: {
        name: 'horst_job_reply',
        description: 'Pass the owner\'s answer to the question a long-running app tool asked (the "❓ … asks:" message).',
        inputSchema: { type: 'object', properties: { jobId: jobIdProp, text: { type: 'string', description: 'The owner\'s answer.' } }, required: ['jobId', 'text'] },
        expose: 'platform',
        sideEffects: 'writes',
      },
      handler: async (args, caller) => {
        ownerChatOnly(caller);
        horstJob(args.jobId);
        const r = jobs().reply(args.jobId, String(args.text ?? ''), 'owner');
        dropQuestions(args.jobId);
        return text(JSON.stringify(r));
      },
    },
  ];
}

module.exports = {
  init, stage, launch, decided, answerFromTelegram, tools, outcomeText, fileLines, runningJobs,
  MAX_RUNNING, PROGRESS_EDIT_MS,
};
