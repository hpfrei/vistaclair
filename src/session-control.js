// Session control: live state of every dashboard CLI session, read from its
// hook events, and the pause / resume flow built on it.
//
//   live state      busy (UserPromptSubmit → Stop/StopFailure), running
//                   subagents, recent actions, edited files, TODO.md progress.
//   hook replies    reply(instanceId, input) is called exactly once per hook
//                   event: by /api/hook-report (lib/hook-reporter.js) for a plain
//                   session, by orchestration.handleHook for a run member. Its
//                   answer ({ stdout?, exitCode?, stderr? }) is what the hook
//                   script reproduces — the only channel that reaches subagents.
//   pause           the session is asked (typed when idle, through hook context
//                   when busy, a Stop block as the last resort) to stop
//                   non-critical long-running work, finish its step and write the
//                   `## Resume` section of its NOTES.md. When it stops with no
//                   subagent or background task left and a fresh resume note, it
//                   is saved to history as `paused` and closed quietly (no exit
//                   events). No timeout; interrupt() is the manual way out.
//   resume          resumeSaved() reopens a saved session with its own transcript
//                   and settings, and tells it to pick up from its folder; when
//                   the transcript is gone, a fresh session in the same folder
//                   continues from the notes instead.
//
// The trusted-channel line in every system prompt (session-folders
// CONTROL_TRUST) is what makes a model follow the [vistaclair pause] text.

const fs = require('fs');
const path = require('path');
const folders = require('./session-folders');

const LAUNCH_TOOLS = new Set(['Agent', 'Task', 'Workflow']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TODO_REMIND_AFTER = 30;     // tool calls of a busy session without a TODO.md change
const RECENT_ACTIONS = 8;
const FINALIZE_DELAY_MS = 600;    // let the Stop hook return before the pty is closed
const INTERRUPT_SETTLE_MS = 1500;

function pauseText(dir) {
  return [
    '[vistaclair pause] The owner is pausing this session (for example for a reboot). It will be resumed later from its notes.',
    '1. Stop the long-running work you started that is not critical to lose: tests, probes, builds, watchers, background tasks, subagents doing validation (TaskStop / KillShell). Never touch the app\'s own process or the vistaclair server. Finishing a productive edit is worth it; finishing a validation is not.',
    '2. Finish the step in progress; start nothing new.',
    `3. Bring TODO.md up to date and write the \`## Resume\` section of NOTES.md (${dir}): where you are inside the item you were doing, uncommitted state, what you stopped that must be re-run, the next concrete step.`,
    '4. Reply PAUSED.',
  ].join('\n');
}

const SUBAGENT_PAUSE = '[vistaclair pause] The owner is pausing the session that launched you. Finish the step in progress, start no new work, and return your result now, saying what is left undone.';

function resumeText(dir, { interrupted } = {}) {
  return `[vistaclair resume] This session was ${interrupted ? 'interrupted (the server stopped mid-turn)' : 'paused'} and is now resumed. Read TODO.md and the \`## Resume\` section of NOTES.md in ${dir}, check the step that was in progress (re-run a command that was cut off), then continue the work.`;
}

// A resume whose conversation is gone (its transcript was deleted) starts a
// fresh session in the same folder instead: the notes carry the work forward.
function freshText(dir) {
  return `[vistaclair resume] This session's earlier conversation could not be restored, so this is a fresh session with a clean context continuing the same work. Your state is in ${dir}: read TODO.md and the \`## Resume\` section of NOTES.md first, check the files they name, re-run whatever was cut off, then continue the work until TODO.md is done.`;
}

function blockReply(reason) {
  return { stdout: JSON.stringify({ decision: 'block', reason }) };
}

function contextReply(event, text) {
  return text ? { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }) } : {};
}

function parseOut(r) {
  try { return r && r.stdout ? JSON.parse(r.stdout) : null; } catch { return null; }
}

// Combine two hook answers for one event: a deny (exit 2) or a Stop block wins;
// two additionalContexts are joined.
function mergeReplies(event, a = {}, b = {}) {
  if (a.exitCode === 2) return a;
  if (b.exitCode === 2) return b;
  const pa = parseOut(a);
  const pb = parseOut(b);
  if (pa?.decision === 'block') return a;
  if (pb?.decision === 'block') return b;
  const ca = pa?.hookSpecificOutput?.additionalContext;
  const cb = pb?.hookSpecificOutput?.additionalContext;
  if (ca && cb) return contextReply(event, `${ca}\n\n${cb}`);
  return a.stdout ? a : b;
}

function describeAction(tool, input = {}) {
  const ti = input || {};
  const target = ti.file_path || ti.notebook_path || ti.path || ti.pattern || ti.command || ti.url || ti.description || '';
  const s = String(target).replace(/\s+/g, ' ').trim();
  return s ? `${tool} ${s.length > 120 ? s.slice(0, 120) + '…' : s}` : tool;
}

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function createSessionControl({ mgr, broadcaster, finalizeDelayMs = FINALIZE_DELAY_MS, interruptSettleMs = INTERRUPT_SETTLE_MS }) {
  const live = new Map();       // instanceId -> state
  const pausing = new Map();    // sessId -> pause entry
  const finalizedListeners = [];

  function stateOf(instanceId) {
    let s = live.get(instanceId);
    if (!s) {
      s = { busy: false, agents: 0, actions: [], edited: new Set(), sinceTodo: 0, reminded: false, todoMtime: 0, delivered: new Set() };
      live.set(instanceId, s);
    }
    return s;
  }

  function folderOf(session) {
    return session?.getSettings?.().sessionDir || null;
  }

  function tabIdOf(session) {
    for (const [tabId, s] of mgr.sessions) if (s === session) return tabId;
    return session?.tabId || null;
  }

  function setBusy(session, busy) {
    if (session.busy === busy) return;
    session.busy = busy;
    mgr.noteSessionState?.(session);
  }

  // Did the session write a resume note since the pause began?
  function freshResume(session, since) {
    const dir = folderOf(session);
    if (!dir) return true;   // no folder: nothing to wait for
    const notes = path.join(dir, 'NOTES.md');
    if (mtimeOf(notes) < since) return false;
    try { return !!folders.resumeSection(fs.readFileSync(notes, 'utf8')); } catch { return false; }
  }

  function typeInto(session, text) {
    session.writeWhenReady(text);
    session.writeWhenReady('\r', undefined, 400);
  }

  // --- Hook replies ---

  function reply(instanceId, input = {}) {
    const session = mgr.getByInstanceId(instanceId);
    if (!session) return {};
    const st = stateOf(instanceId);
    const ev = input.hook_event_name;
    const tool = input.tool_name || '';
    const sub = !!input.agent_id;
    const p = session.sessId ? pausing.get(session.sessId) : null;

    switch (ev) {
      case 'SessionStart':
        st.agents = 0;
        st.delivered.clear();
        return {};
      case 'UserPromptSubmit':
        setBusy(session, true);
        return {};
      case 'SubagentStart':
        st.agents++;
        return {};
      case 'SubagentStop':
        st.agents = Math.max(0, st.agents - 1);
        return {};
      case 'StopFailure':
        setBusy(session, false);
        return {};
      case 'PreToolUse': {
        if (p && (LAUNCH_TOOLS.has(tool) || /__(launch_cli|resume_worker)$/.test(tool))) {
          return { exitCode: 2, stderr: '[vistaclair pause] The owner is pausing this session: no new subagents, workflows or sessions. Finish the step in progress instead.' };
        }
        return {};
      }
      case 'PostToolUse': {
        st.actions.push({ at: Date.now(), agent: input.agent_id || null, text: describeAction(tool, input.tool_input) });
        if (st.actions.length > RECENT_ACTIONS) st.actions.shift();
        if (EDIT_TOOLS.has(tool)) {
          const f = input.tool_input?.file_path || input.tool_input?.notebook_path;
          if (f) st.edited.add(path.resolve(input.cwd || session.cwd || '/', f));
        }
        const out = [];
        const dir = folderOf(session);
        if (dir && !sub) {
          const m = mtimeOf(path.join(dir, 'TODO.md'));
          if (m !== st.todoMtime) {
            st.todoMtime = m;
            st.sinceTodo = 0;
            st.reminded = false;
            broadcaster?.broadcast({ type: 'cli:progress', sessId: session.sessId });
          } else if (++st.sinceTodo >= TODO_REMIND_AFTER && !st.reminded) {
            st.reminded = true;
            out.push(`[vistaclair] ${TODO_REMIND_AFTER} tool calls without a TODO.md update — bring ${path.join(dir, 'TODO.md')} up to date if your work has moved on.`);
          }
        }
        if (p) {
          const key = input.agent_id || 'main';
          if (!st.delivered.has(key)) {
            st.delivered.add(key);
            out.push(sub ? SUBAGENT_PAUSE : (p.hookText || p.text));
            if (!sub && !p.hookText) p.seen = true;
          }
        }
        return contextReply('PostToolUse', out.join('\n\n'));
      }
      case 'Stop': {
        setBusy(session, false);
        if (!p) return {};
        return pauseOnStop(session, st, p, input);
      }
      default:
        return {};
    }
  }

  function pauseOnStop(session, st, p, input) {
    const background = Array.isArray(input.background_tasks) ? input.background_tasks.length : 0;
    if (st.agents > 0 || background) {
      if (!p.bgBlocked && !input.stop_hook_active) {
        p.bgBlocked = true;
        return blockReply(`[vistaclair pause] ${st.agents + background} subagent(s) or background task(s) are still running. Stop the ones doing validation (TaskStop / KillShell); let a productive one finish. Then complete the pause steps.`);
      }
      return {};   // the next Stop, when they are done, decides
    }
    // Busy when the pause began and no tool call since: it has not seen the text.
    if (!p.seen && p.type !== false && !input.stop_hook_active) {
      p.seen = true;
      return blockReply(p.text);
    }
    // E.g. an orchestrator waiting for its workers: it idles; deliver() wakes it.
    if (p.holdUntil && p.holdUntil()) return {};
    if (p.needsNote !== false && !freshResume(session, p.since)) {
      if (!p.blocked && !input.stop_hook_active) {
        p.blocked = true;
        return blockReply(p.stopText || p.text);
      }
      // Asked once and it still stopped without a note: pause anyway — the
      // TODO and the transcript stand in for it.
    }
    setTimeout(() => finalize(session, { interrupted: false }), finalizeDelayMs);
    return {};
  }

  // --- Pause ---

  // Start pausing a session. opts:
  //   text        what to type (idle) / deliver by hook (busy); default pauseText
  //   hookText    a different, shorter hook-context text (e.g. a worker waiting
  //               for its orchestrator's relay)
  //   stopText    what the Stop block says when the note is missing
  //   type        false: do not type `text` now (a worker waiting for its
  //               orchestrator's relay; deliver() types it later)
  //   holdUntil   () => true while the session must not be closed yet
  //   needsNote   false: close without waiting for a resume note
  //   meta        kept on the entry (runId, role, mode) for listeners
  function pause(tabId, opts = {}) {
    const session = mgr.get(tabId);
    if (!session || !session.running) throw new Error('that tab is not running');
    if (!session.sessId) throw new Error('that tab has no session');
    if (pausing.has(session.sessId)) return { already: true };
    const dir = folderOf(session);
    const p = {
      tabId, since: Date.now(), text: opts.text || pauseText(dir), hookText: opts.hookText || null,
      stopText: opts.stopText || null, holdUntil: opts.holdUntil || null, needsNote: opts.needsNote,
      meta: opts.meta || {}, type: opts.type, blocked: false, bgBlocked: false, seen: false,
    };
    pausing.set(session.sessId, p);
    session.pausing = true;
    stateOf(session.instanceId).delivered.clear();
    if (!session.busy && opts.type !== false) { typeInto(session, p.text); p.seen = true; }
    mgr.broadcastTabs?.();
    return { pausing: true };
  }

  // Give a pausing session a (new) instruction and restart its note clock:
  // typed when idle, else by hook context and, failing that, its Stop block.
  function deliver(tabId, text, { resetClock = true } = {}) {
    const session = mgr.get(tabId);
    const p = session?.sessId ? pausing.get(session.sessId) : null;
    if (!p) return false;
    if (resetClock) { p.since = Date.now(); p.blocked = false; }
    if (text) {
      p.text = text;
      p.stopText = text;
      p.hookText = null;
      p.type = true;
      stateOf(session.instanceId).delivered.delete('main');
      if (session.busy) p.seen = false;
      else { typeInto(session, text); p.seen = true; }
    }
    return true;
  }

  function isPausing(session) {
    return !!(session?.sessId && pausing.has(session.sessId));
  }

  function pauseEntry(session) {
    return session?.sessId ? pausing.get(session.sessId) || null : null;
  }

  // Close a pausing session now: Esc ends its turn, then it is saved as
  // interrupted. The manual way out of a pause that does not finish.
  function interrupt(tabId) {
    const session = mgr.get(tabId);
    if (!session || !isPausing(session)) throw new Error('that tab is not pausing');
    session.write('\x1b');
    setTimeout(() => finalize(session, { interrupted: true }), interruptSettleMs);
    return { ok: true };
  }

  function finalize(session, { interrupted }) {
    const p = pausing.get(session.sessId);
    if (!p || p.finalized) return;
    p.finalized = true;
    pausing.delete(session.sessId);
    session.pausing = false;
    const tabId = tabIdOf(session);
    mgr.saveToHistory({
      sessId: session.sessId, cwd: session.cwd, title: session.title, settings: session.getSettings(),
      autoMemory: session.autoMemory, flags: { paused: !interrupted, interrupted: !!interrupted, pausedAt: Date.now() },
    });
    live.delete(session.instanceId);
    if (tabId) mgr.closeQuiet(tabId);
    broadcaster?.broadcast({ type: 'cli:paused', sessId: session.sessId, title: session.title, interrupted: !!interrupted });
    for (const fn of finalizedListeners) {
      try { fn(session, p, { interrupted: !!interrupted }); } catch (e) { console.error('[session-control] finalize listener:', e.message); }
    }
  }

  function onFinalized(fn) { finalizedListeners.push(fn); }

  // --- Resume ---

  // Can this saved session be reopened with its own conversation?
  function canContinue(entry) {
    return !!(entry && mgr.transcriptExists(entry.cwd, entry.id));
  }

  // Reopen a saved session with its own transcript. `message` is typed once it
  // is ready; by default a paused or interrupted session gets the resume text.
  // When the transcript is gone, a fresh session with the same settings and
  // folder takes its place (`fresh: true`), told to continue from its notes
  // (`freshMessage` overrides that text); `fallback: false` throws instead.
  function resumeSaved(sessId, { message, freshMessage, fallback = true, cols = 120, rows = 32 } = {}) {
    const entry = mgr.findSaved(sessId);
    if (!entry) throw new Error('no saved session with that id');
    for (const s of mgr.sessions.values()) {
      if (s.sessId === sessId && s.running) throw new Error('that session is already running');
    }
    if (!canContinue(entry)) {
      if (!fallback) throw new Error('its transcript is gone; it cannot be resumed');
      const tabId = mgr.nextTabId();
      mgr.launchSession(tabId, {
        cwd: entry.cwd, cols, rows, title: entry.title || undefined, settings: entry.settings || {},
        autoMemory: entry.autoMemory === true,
        prompt: freshMessage || freshText(entry.settings?.sessionDir || '(your session folder)'), autoSubmit: true,
      });
      mgr.forgetSaved(sessId);
      return { tabId, fresh: true };
    }
    const tabId = mgr.nextTabId();
    const session = mgr.getOrCreate(tabId);
    session.title = entry.title || null;
    if (entry.settings) session.updateSettings(entry.settings);
    mgr.spawn(tabId, entry.cwd, cols, rows, { resumeSessionId: sessId, autoMemory: entry.autoMemory === true });
    const text = message !== undefined ? message
      : (entry.paused || entry.interrupted) ? resumeText(entry.settings?.sessionDir || '(your session folder)', { interrupted: !!entry.interrupted }) : null;
    if (text) typeInto(session, text);
    return { tabId, fresh: false };
  }

  // --- Peek ---

  function liveOf(session) {
    if (!session) return null;
    const st = live.get(session.instanceId);
    return {
      busy: !!session.busy,
      pausing: isPausing(session),
      subagents: st ? st.agents : 0,
      recent: st ? st.actions.slice(-5).map(a => a.text) : [],
      edited: st ? [...st.edited] : [],
    };
  }

  return {
    reply, pause, deliver, interrupt, isPausing, pauseEntry, onFinalized, resumeSaved, canContinue, liveOf,
    texts: { pauseText, resumeText, freshText, SUBAGENT_PAUSE },
  };
}

module.exports = { createSessionControl, mergeReplies, pauseText, resumeText, freshText, SUBAGENT_PAUSE };
