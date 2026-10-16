// Run cards: one read-only summary per orchestration run, for the CLI view's
// Sessions tab (cli:savedSessions `runs`) and the Inspector's grouped session
// cards. Built from the saved sessions (src/cli-sessions.js getSavedSessions,
// whose entries carry `group`), the run records (run.json) and the live
// sessions. Nothing here changes a run: resume, pause and delete stay in
// src/orchestration.js.

const fs = require('fs');
const path = require('path');
const folders = require('./session-folders');

// How many of the orchestrator's TODO rows a card shows.
const TODO_TAIL = 5;

function readRun(runDir) {
  if (!runDir) return null;
  try { return JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')); } catch { return null; }
}

const ms = (v) => (typeof v === 'number' ? v : Date.parse(v || '') || 0);
const finished = (w) => !!w && (w.abandoned || ['done', 'failed'].includes(w.lastReport?.status));

// A live session's state word: busy / idle / awaiting (SDK) while it runs.
function liveState(session) {
  if (session.state && session.state !== 'exited') return session.state;
  return session.busy ? 'busy' : 'idle';
}

// A worker's state word: its live state while it runs, else why it is not
// running (its last report counts once it is done or failed).
function workerState(w, live) {
  if (live?.running) return liveState(live);
  if (!w) return 'stopped';
  if (w.paused) return 'paused';
  if (w.abandoned) return 'abandoned';
  if (['done', 'failed'].includes(w.lastReport?.status)) return w.lastReport.status;
  return w.exitedAt ? 'exited' : 'stopped';
}

// running / pausing / paused / closed / completed / stopped, or missing when
// the run record is gone.
function runStatus(run, anyRunning) {
  if (!run) return 'missing';
  if (run.pausing) return 'pausing';
  if (anyRunning) return 'running';
  if (run.paused) return 'paused';
  if (run.closed) return 'closed';
  const workers = run.workers || [];
  if (workers.length && workers.every(finished)) return 'completed';
  return 'stopped';
}

/**
 * One summary per run named by the saved sessions, newest activity first.
 * @param {object[]} entries  getSavedSessions() output, newest first
 * @param {object} [opts]
 * @param {Map<string, object>} [opts.runs]  runDir → run.json already read
 * @param {(sessId: string) => object|null} [opts.liveOf]  the live session
 */
function summarizeRuns(entries, { runs = new Map(), liveOf = () => null } = {}) {
  const members = new Map(); // runId → entries
  for (const e of entries) {
    const runId = e.group?.runId;
    if (!runId) continue;
    if (!members.has(runId)) members.set(runId, []);
    members.get(runId).push(e);
  }
  const out = [];
  for (const [runId, list] of members) {
    const stamp = list.find(e => e.settings?.orchestration?.runDir)?.settings.orchestration || {};
    if (!runs.has(stamp.runDir)) runs.set(stamp.runDir, readRun(stamp.runDir));
    const run = runs.get(stamp.runDir);
    const orchEntry = list.find(e => e.group.role === 'orchestrator') || null;
    const orchLive = orchEntry ? liveOf(orchEntry.id) : null;
    const workerEntry = (id) => list.find(e => e.group.role === 'worker' && e.group.workerId === id) || null;

    // The run record lists every worker; without it, the saved workers do.
    const recorded = run?.workers || list.filter(e => e.group.role === 'worker' && e.group.workerId)
      .filter((e, i, a) => a.findIndex(x => x.group.workerId === e.group.workerId) === i)
      .map(e => ({ id: e.group.workerId, name: e.settings?.name || e.group.workerId, title: e.title }));
    const workers = recorded.map(w => {
      const entry = workerEntry(w.id);
      const live = entry ? liveOf(entry.id) : null;
      const r = w.lastReport;
      return {
        id: w.id,
        name: w.name || entry?.settings?.name || w.id,
        title: w.title || entry?.title || null,
        sessId: entry?.id || null,
        running: !!live?.running,
        state: workerState(run ? w : null, live),
        model: w.model || entry?.settings?.model || null,
        lastReport: r ? { status: r.status, summary: String(r.summary || '').slice(0, 200), at: r.at || null } : null,
        lastActivityAt: Math.max(entry?.lastInteractionAt || 0, ms(r?.at), ms(w.exitedAt), ms(w.launchedAt)) || null,
        completed: finished(w),
      };
    });

    // The orchestrator's TODO: its saved entry carries the tail; a run whose
    // orchestrator entry is gone reads the folder from the record.
    let todo = null;
    if (orchEntry?.todoTail) {
      todo = { ...orchEntry.progress, rows: orchEntry.todoTail };
    } else if (run) {
      const f = folders.readFolder(run.orchestratorDir || run.runDir);
      if (f) todo = { ...f.progress, updatedAt: f.todoUpdatedAt, rows: tailOf(f.items) };
    }

    const running = workers.filter(w => w.running).length;
    const orchestratorRunning = !!orchLive?.running;
    const lastActivityAt = Math.max(
      0, ...list.map(e => e.lastInteractionAt || e.savedAt || 0),
      ...workers.map(w => w.lastActivityAt || 0),
      ms(run?.events?.at?.(-1)?.at),
    ) || null;
    out.push({
      runId,
      orchestrator: run?.orchestrator || stamp.orchestrator || orchEntry?.group.orchestrator || null,
      title: orchEntry?.title || null,
      cwd: run?.root || orchEntry?.cwd || list[0].cwd || null,
      engine: run?.engine || orchEntry?.kind || 'cli',
      isolation: run?.isolation || null,
      model: orchEntry?.settings?.model || null,
      status: runStatus(run, orchestratorRunning || running > 0),
      paused: !!run?.paused,
      closed: !!run?.closed,
      runMissing: !run,
      orchestratorSessId: orchEntry?.id || null,
      orchestratorRunning,
      orchestratorState: orchLive?.running ? liveState(orchLive) : (orchEntry?.paused ? 'paused' : orchEntry?.interrupted ? 'interrupted' : 'stopped'),
      startedAt: Math.min(...list.map(e => e.startedAt || e.savedAt || Infinity)) || null,
      lastActivityAt,
      workers: { total: workers.length, running, list: workers },
      todo,
    });
  }
  return out.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
}

function tailOf(items) {
  return items.slice(-TODO_TAIL).map(i => ({ id: i.id, description: i.description, status: i.status }));
}

module.exports = { summarizeRuns, runStatus, workerState, readRun, tailOf, TODO_TAIL };
