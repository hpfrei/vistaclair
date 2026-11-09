'use strict';
// An AskUserQuestion form whose asking tool call has ended (src/ask-lifecycle.js).
//
// vista-AskUserQuestion (mcp-servers/integrated) POSTs /api/ask and waits for
// the owner's answer (orchestration.askUser, a pendingQuestions entry). The
// call can end first on the session side: an interrupt or Claude Code's MCP
// tool timeout (the tool destroys its request), the turn or the subagent
// ending, the session exiting, restarting, being paused, closed or replaced
// by an orchestrator refresh. The form then must not look live: the entry is
// EXPIRED (when, why), its waiter rejected, and the dashboard keeps the form
// with a banner and two buttons:
//   - "Send as message": one self-contained message (the questions with their
//     options, the answers, when asked / expired / answered) to the CURRENT
//     session at the asker's address — never to the dead call. A run member:
//     the session at its run address (after a refresh, the new orchestrator),
//     through orchestration's delivery (idle: a turn; busy: its next hook;
//     none running: its inbox, taken at its next start). A plain session: the
//     session in its tab; none running: queued here (late-answers-queue.json)
//     and submitted at its next SessionStart. Recorded in the run's owner log
//     (orchestration.noteLate).
//   - "Discard": closes it, recorded (no message).
//
// The asking call is told apart by tool_use_id: Claude Code passes none to an
// MCP tool, so the PreToolUse hook of the ask tool (instance, tool_use_id,
// agent_id) is matched to the next /api/ask of that instance.
//
// Protocol: server → dashboard `ask:expired` { askId, at, reason }; a replayed
// `ask:question` carries `expired`; `ask:closed` { askId, how }; `ask:lateResult`
// to the sender. Dashboard → server `ask:late` { toolUseId, answer, files },
// `ask:discard` { toolUseId }.

const fs = require('fs');
const path = require('path');

const ASK_TOOL = /(^|__)vista-AskUserQuestion$/;
// The message's first line. Not "[…]": it is owner text, kept by the owner
// filters (orchestration's ownerPrompt / isNotice), which skip re-recording it
// (noteLate records it once, at the send).
const LATE_PREFIX = 'Late answer to your question from';
const LATE_RE = /^Late answer to your question from \d\d:\d\d:/;
const CLOSE_GRACE_MS = 3000;
const GENERIC_REASON = 'tool call interrupted, timed out or its process ended';
const SWEEP_MS = 15000;

const END_REASONS = {
  exit: 'session exited',
  tab_close: 'tab closed',
  pause: 'session paused',
  refresh: 'session replaced by a refresh',
  close_worker: 'worker closed',
  delete_run: 'run deleted',
  respawn: 'session restarted',
  shutdown: 'server shutting down',
};

const pad = (n) => String(n).padStart(2, '0');
function hhmm(iso) { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function stamp(iso) { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm(iso)}`; }

function show(v) {
  if (v == null || v === '') return '(no answer)';
  if (Array.isArray(v)) return v.length ? v.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ') : '(no answer)';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

// The late message: self-contained, the questions verbatim with their options.
function lateText(entry, answer, answeredAt) {
  const { askedAt, expiredAt, reason } = entry;
  const formData = entry.formData || {};
  const questions = Array.isArray(entry.questions) && entry.questions.length ? entry.questions : (formData.questions || []);
  const lines = [
    `${LATE_PREFIX} ${hhmm(askedAt)}:`,
    `Your question had already ended at ${hhmm(expiredAt)} (${reason}); you may have continued without this answer. Check whether it changes anything you did since, adjust if needed, and tell the owner.`,
    '',
    `Asked ${stamp(askedAt)} · expired ${stamp(expiredAt)} · answered ${stamp(answeredAt)}.`,
    '',
    questions.length > 1 ? 'Your questions, verbatim:' : 'Your question, verbatim:',
  ];
  if (formData.title) lines.push(`Form title: ${formData.title}`);
  if (formData.description) lines.push(`Form description: ${formData.description}`);
  questions.forEach((q, i) => {
    if (!q || typeof q !== 'object') { lines.push(`${i + 1}. ${show(q)}`); return; }
    lines.push(`${i + 1}. ${q.header ? `[${q.header}] ` : ''}${q.question ?? ''}${q.multiSelect ? ' (several may be chosen)' : ''}`);
    if (Array.isArray(q.options) && q.options.length) {
      lines.push('   Options:');
      for (const o of q.options) {
        const label = o && typeof o === 'object' ? o.label : o;
        const desc = o && typeof o === 'object' && o.description ? ` — ${o.description}` : '';
        lines.push(`   - ${label}${desc}`);
      }
    }
  });
  lines.push('', 'The owner\'s answer:');
  const list = Array.isArray(answer) ? answer : [answer];
  const byId = new Map(questions.map((q, i) => [q?.id || `q${i}`, q]));
  list.forEach((a, i) => {
    if (a && typeof a === 'object' && 'answer' in a) {
      const q = byId.get(a.id);
      lines.push(`${i + 1}. ${a.question || q?.question || a.id || ''}`, `   → ${show(a.answer)}`);
    } else {
      lines.push(`${i + 1}. ${show(a)}`);
    }
  });
  return lines.join('\n');
}

function createAskLifecycle({ pendingQuestions, broadcaster, mgr, orchestration = null, dataHome, closeGraceMs = CLOSE_GRACE_MS, sweepMs = SWEEP_MS, now = () => new Date() }) {
  const tracked = new Map();    // askId -> { askId, instanceId, tabId, sessId, askedAt, toolUseId, agentId, address }
  const expired = new Map();    // askId -> tracked + { message, questions, formData, expiredAt, reason }
  const preCalls = new Map();   // instanceId -> [{ toolUseId, agentId }] ask-tool calls not matched to an /api/ask yet
  const closeTimers = new Map();
  const dir = path.join(dataHome, 'data');
  const auditFile = path.join(dir, 'late-answers.jsonl');
  const queueFile = path.join(dir, 'late-answers-queue.json');
  const iso = () => now().toISOString();

  function audit(rec) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(auditFile, JSON.stringify({ at: iso(), ...rec }) + '\n');
    } catch (e) { console.error('[ask-lifecycle] audit:', e.message); }
  }

  function readQueue() {
    try { const q = JSON.parse(fs.readFileSync(queueFile, 'utf8')); return Array.isArray(q) ? q : []; } catch { return []; }
  }
  function writeQueue(q) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (q.length) fs.writeFileSync(queueFile, JSON.stringify(q, null, 2));
      else fs.rmSync(queueFile, { force: true });
    } catch (e) { console.error('[ask-lifecycle] queue:', e.message); }
  }

  // An /api/ask of `instanceId` is pending as `askId`.
  function track(askId, { instanceId = null, tabId = null } = {}) {
    if (!askId || !pendingQuestions.has(askId)) return;
    const session = instanceId ? mgr.getByInstanceId(instanceId) : null;
    const calls = preCalls.get(instanceId) || [];
    const call = calls.shift() || null;
    if (!calls.length) preCalls.delete(instanceId);
    tracked.set(askId, {
      askId, instanceId, tabId: tabId || session?.tabId || null, sessId: session?.sessId || null,
      title: session?.title || null, askedAt: iso(), known: !!session,
      toolUseId: call?.toolUseId || null, agentId: call?.agentId || null,
      address: (session && orchestration?.askAddress?.(session)) || null,
    });
  }

  // Answered (or refused) while live: nothing to watch any more.
  function settled(askId) {
    tracked.delete(askId);
    clearTimeout(closeTimers.get(askId));
    closeTimers.delete(askId);
  }

  // The asking call ended: the form is kept, expired, its waiter rejected.
  function expire(askId, reason) {
    const t = tracked.get(askId);
    clearTimeout(closeTimers.get(askId));
    closeTimers.delete(askId);
    // Expired already by its closed request: a precise reason refines it.
    if (t?.generic) {
      tracked.delete(askId);
      const e = expired.get(askId);
      if (!e) return false;
      e.reason = reason;
      broadcaster.broadcast({ type: 'ask:expired', askId, at: e.expiredAt, reason });
      audit({ event: 'reason', askId, reason });
      return true;
    }
    const p = pendingQuestions.get(askId);
    if (!t || !p) { tracked.delete(askId); return false; }
    tracked.delete(askId);
    pendingQuestions.delete(askId);
    const at = iso();
    const entry = { ...t, message: p.message, questions: p.questions, formData: p.formData, expiredAt: at, reason };
    expired.set(askId, entry);
    try { p.reject?.(Object.assign(new Error(`the question expired: ${reason}`), { expired: true })); } catch {}
    broadcaster.broadcast({ type: 'ask:expired', askId, at, reason });
    audit({ event: 'expired', askId, instanceId: t.instanceId, toolUseId: t.toolUseId, reason, address: t.address?.name || t.tabId });
    return true;
  }

  function expireWhere(pred, reason) {
    const ids = [...tracked.values()].filter(pred).map(t => t.askId);
    for (const id of ids) expire(id, reason);
    return ids.length;
  }

  // /api/ask's response closed before an answer: the tool gave up (an
  // interrupt, a timeout) or its process died. Expired at once (an answer can
  // no longer reach the call); a precise reason (a hook, the session's end)
  // arriving within the grace refines the banner.
  function requestClosed(askId) {
    const t = tracked.get(askId);
    if (!t || t.generic || !expire(askId, GENERIC_REASON)) return;
    if (closeGraceMs <= 0) return;
    tracked.set(askId, { ...t, generic: true });
    const timer = setTimeout(() => { closeTimers.delete(askId); if (tracked.get(askId)?.generic) tracked.delete(askId); }, closeGraceMs);
    timer.unref?.();
    closeTimers.set(askId, timer);
  }

  function onHook(instanceId, h = {}) {
    if (!instanceId) return;
    const ev = h.hook_event_name;
    const agentId = h.agent_id || null;
    const isAsk = ASK_TOOL.test(h.tool_name || '');
    if (ev === 'PreToolUse' && isAsk && h.tool_use_id) {
      // The /api/ask of this call follows; one already waiting without an id
      // (the hook came late) takes it now.
      const waiting = [...tracked.values()].find(t => t.instanceId === instanceId && !t.toolUseId && !t.generic);
      if (waiting) { waiting.toolUseId = h.tool_use_id; waiting.agentId = agentId; return; }
      const list = preCalls.get(instanceId) || [];
      list.push({ toolUseId: h.tool_use_id, agentId });
      preCalls.set(instanceId, list.slice(-8));
      return;
    }
    if ((ev === 'PostToolUse' || ev === 'PostToolUseFailure') && isAsk) {
      const id = h.tool_use_id || null;
      const list = preCalls.get(instanceId);
      if (list && id) {
        const rest = list.filter(c => c.toolUseId !== id);
        if (rest.length) preCalls.set(instanceId, rest); else preCalls.delete(instanceId);
      }
      const reason = ev === 'PostToolUse' ? 'tool call ended without an answer'
        : h.is_interrupt ? 'tool call interrupted' : 'tool call failed';
      expireWhere(t => t.instanceId === instanceId && (id ? (t.toolUseId === id || !t.toolUseId) : true), reason);
      return;
    }
    if (ev === 'Stop' && !agentId) { expireWhere(t => t.instanceId === instanceId && !t.agentId, 'turn ended'); preCalls.delete(instanceId); return; }
    if (ev === 'SubagentStop' && agentId) { expireWhere(t => t.instanceId === instanceId && t.agentId === agentId, 'subagent ended'); return; }
    if (ev === 'SessionEnd') { expireWhere(t => t.instanceId === instanceId, `session ended${h.reason ? ` (${h.reason})` : ''}`); preCalls.delete(instanceId); return; }
    if (ev === 'SessionStart') {
      const src = h.source;
      if (src === 'startup' || src === 'resume' || src === 'clear') {
        expireWhere(t => t.instanceId === instanceId, src === 'clear' ? 'conversation cleared' : 'session restarted');
        preCalls.delete(instanceId);
        flushQueue(mgr.getByInstanceId(instanceId));
      }
    }
  }

  // A session ended (exited, closed, paused, replaced): its calls are gone.
  function onSessionEnd(tabId, session, why = 'exit') {
    const instanceId = session?.instanceId;
    if (!instanceId) return;
    const reason = orchestration?.isRefreshing?.(session) ? END_REASONS.refresh : (END_REASONS[why] || `session stopped (${why})`);
    expireWhere(t => t.instanceId === instanceId, reason);
    preCalls.delete(instanceId);
  }

  // The backstop: an ask whose session (one of this dashboard's, known when
  // it asked) is not running any more.
  function sweep() {
    expireWhere(t => {
      if (!t.known) return false;
      const s = mgr.getByInstanceId(t.instanceId);
      return !s || !s.running;
    }, 'session no longer running');
  }
  const sweeper = sweepMs > 0 ? setInterval(sweep, sweepMs) : null;
  sweeper?.unref?.();

  // --- The owner's choice on an expired form ---

  function plainTarget(entry) {
    const byTab = entry.tabId ? mgr.get(entry.tabId) : null;
    if (byTab && (!entry.sessId || !byTab.sessId || byTab.sessId === entry.sessId || byTab.running)) return byTab;
    return entry.sessId ? mgr.getBySessId?.(entry.sessId) || null : null;
  }

  function submitTo(session, text) {
    if (session.kind === 'sdk') session.submit(text, { priority: 'next', from: 'owner' });
    else session.submit(text);
  }

  // A plain session (not a run member): the session in its tab, else queued
  // for that tab's (or that conversation's) next start.
  function deliverPlain(entry, text) {
    const to = entry.title || entry.tabId || 'the session';
    const s = plainTarget(entry);
    if (s?.running) { submitTo(s, text); return { how: 'submitted', to }; }
    writeQueue([...readQueue(), { tabId: entry.tabId, sessId: entry.sessId, text, at: iso(), askId: entry.askId }]);
    return { how: 'queued-not-running', to };
  }

  // A plain session started: late answers queued for it are submitted.
  function flushQueue(session) {
    if (!session?.running || orchestration?.askAddress?.(session)) return 0;
    const q = readQueue();
    if (!q.length) return 0;
    const mine = q.filter(m => (m.tabId && m.tabId === session.tabId) || (m.sessId && m.sessId === session.sessId));
    if (!mine.length) return 0;
    writeQueue(q.filter(m => !mine.includes(m)));
    for (const m of mine) {
      try { submitTo(session, m.text); audit({ event: 'delivered-queued', askId: m.askId, to: session.tabId }); }
      catch (e) { console.error('[ask-lifecycle] queued late answer:', e.message); }
    }
    return mine.length;
  }

  const TOASTS = {
    submitted: (to) => `Late answer sent to ${to}.`,
    queued: (to) => `Late answer queued for ${to}: it gets it at its next step.`,
    'queued-not-running': (to) => `No session is running at ${to}: the late answer is queued for its next start.`,
  };

  // "Send as message". `answer` as an ask:answer carries it (files already
  // saved by the caller). { ok, how, to, message } or { ok: false, error }.
  function sendLate(askId, answer) {
    const entry = expired.get(askId);
    if (!entry) return { ok: false, error: 'that question is no longer open' };
    const answeredAt = iso();
    const text = lateText(entry, answer, answeredAt);
    let r;
    try {
      r = entry.address && orchestration?.deliverLate ? orchestration.deliverLate(entry.address, text) : deliverPlain(entry, text);
    } catch (e) {
      return { ok: false, error: `not delivered: ${e.message}` };
    }
    expired.delete(askId);
    if (entry.address) { try { orchestration?.noteLate?.(entry.address, text); } catch (e) { console.error('[ask-lifecycle] owner log:', e.message); } }
    audit({ event: 'sent', askId, how: r.how, to: r.to, text });
    broadcaster.broadcast({ type: 'ask:closed', askId, how: 'sent' });
    return { ok: true, how: r.how, to: r.to, message: (TOASTS[r.how] || TOASTS.submitted)(r.to) };
  }

  // "Discard": closed, recorded, nothing sent.
  function discard(askId) {
    const entry = expired.get(askId);
    if (!entry) return { ok: false, error: 'that question is no longer open' };
    expired.delete(askId);
    const qs = (entry.questions?.length ? entry.questions : entry.formData?.questions || []).map(q => q?.question ?? q).join(' | ');
    if (entry.address) {
      try { orchestration?.noteLate?.(entry.address, `(discarded) The owner discarded the form of the question asked at ${hhmm(entry.askedAt)} that had expired at ${hhmm(entry.expiredAt)} (${entry.reason}); nothing was sent. Q: ${qs}`, { discarded: true }); } catch (e) { console.error('[ask-lifecycle] owner log:', e.message); }
    }
    audit({ event: 'discarded', askId, address: entry.address?.name || entry.tabId, questions: qs });
    broadcaster.broadcast({ type: 'ask:closed', askId, how: 'discarded' });
    return { ok: true, how: 'discarded', message: 'Expired question discarded.' };
  }

  // A reconnecting dashboard: the expired forms, marked.
  function replay(send) {
    for (const e of expired.values()) {
      if (e.message) send({ ...e.message, expired: { at: e.expiredAt, reason: e.reason } });
    }
  }

  function expiredInfo(askId) {
    const e = expired.get(askId);
    return e ? { at: e.expiredAt, reason: e.reason } : null;
  }

  function stop() {
    if (sweeper) clearInterval(sweeper);
    for (const t of closeTimers.values()) clearTimeout(t);
    closeTimers.clear();
  }

  return { track, settled, expire, requestClosed, onHook, onSessionEnd, sweep, sendLate, discard, replay, expiredInfo, flushQueue, stop, tracked, expired };
}

module.exports = { createAskLifecycle, lateText, LATE_PREFIX, LATE_RE, hhmm };
