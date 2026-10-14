// Orchestrator CLI sessions: one CLI tab that plans and delegates, worker tabs
// that do the work, Claude Code's own cross-session messaging between them.
//
//   openCli(opts)        the one user-facing "new CLI" entry. `mode` unset asks
//                        Simple / Orchestrator, `engine` unset asks CLI terminal
//                        / Agent SDK panel, in one dashboard ask form.
//   engine               settings.engine 'cli' (a PTY tab) | 'sdk' (an Agent SDK
//                        session, src/sdk-session.js). A run has one engine
//                        (run.engine); its workers inherit it. SDK workers are
//                        hidden: they are areas of the run's panel.
//   run directory        <runsDir>/<runId>/ — run.json (server-owned: workers,
//                        events, delivery cursor), TODO.md (the orchestrator's),
//                        sessions/<name>.json (each session's --settings file).
//   identity             settings.name (--name, the messaging address) and the
//                        settings.orchestration stamp. Both persist with the tab,
//                        so a restored tab keeps its address and role.
//   compaction-proof     the role card rides in --append-system-prompt (never
//                        summarized); a SessionStart compact|resume hook
//                        re-injects role, TODO and worker state; TODO.md is the
//                        ground truth the card tells the orchestrator to re-read.
//   hooks                every session's settings file routes its hook events to
//                        lib/orchestration-hook.js, which forwards them here
//                        (handleHook). Caps, guards, report enforcement and event
//                        delivery are all decided in this one process.
//   events               worker exit / idle-without-report / report. Delivered
//                        into the orchestrator's context by its next hook when it
//                        is busy, or by typing a one-line notice into its tab when
//                        it is idle (which starts a turn).
//   tools                lib/orchestrator-mcp.js: launch_cli, resume_worker,
//                        list_workers, end_run (orchestrator); report (workers);
//                        SendMessage, ListAgents (both, SDK runs: Claude Code's
//                        own cross-session messaging is a CLI feature). A message
//                        is submitted into its target with priority 'next' (an
//                        SDK target reads it within its running turn); a busy
//                        CLI target gets it through its next hook instead.
//   session folders      every member keeps TODO.md / NOTES.md in
//                        <sessionsRoot>/<name>/ (session-folders.js); the
//                        orchestrator reads its workers' folders (list_workers
//                        names them) instead of messaging them.
//   pause / resume       pauseRun: the orchestrator relays the pause to its
//                        workers (the server falls back after a delay), each
//                        writes its resume note and is closed quietly; the
//                        orchestrator pauses last. resumeRun reopens the
//                        orchestrator (own transcript, or fresh from the notes);
//                        it warms the workers up with resume_worker
//                        (continue | fresh). refreshOrchestrator replaces a
//                        drifted orchestrator with a fresh one at any time.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const folders = require('./session-folders');
const { mergeReplies, pauseText, resumeText } = require('./session-control');

const MAX_WORKERS = 3;
// The model a worker may be launched on (launch_cli `model`), as Claude Code's
// Agent tool takes it. Unset: the dashboard's default model for new tabs.
const WORKER_MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
const MAX_SUBAGENTS = 3;
const PUSH_DEBOUNCE_MS = 2000;
const RELAY_FALLBACK_MS = 120000;    // a worker the orchestrator has not told to pause by then hears it from the server
const REFRESH_SUGGESTED_AFTER = 3;   // orchestrator compactions
const CONTEXT_LIMIT = 9000;          // hook additionalContext is capped at 10k chars
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop'];

// The subagents every worker gets (--agents). Model is fixed per agent so a
// worker cannot drift into running coding work on a cheaper model or reading
// on an expensive one. A subagent does not see its parent's system prompt, so
// each carries the trusted pause channel itself.
const WORKER_AGENTS = {
  coder: {
    description: 'Writes and changes code. Give it a precise, self-contained change request: what to change, where, and how to verify it.',
    prompt: `You are a coding subagent working for one worker session. Make exactly the change you were asked for, following the surrounding code style. Run the one check that proves this change (the project gate, or the single test that touches it) — no exploratory probe scripts, no repeated full suites. Return a short summary: files changed, the check you ran, and anything left open. ${folders.CONTROL_TRUST}`,
    model: 'opus',
  },
  explorer: {
    description: 'Read-only search and reading: finds code, traces call paths, answers questions about the codebase. Never modifies files.',
    prompt: `You are a read-only exploration subagent. Search and read to answer the question you were given. Do not modify any file. Return concise conclusions with file:line references, not file dumps. ${folders.CONTROL_TRUST}`,
    model: 'sonnet',
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch'],
  },
};

function slugify(s, max = 20) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'task';
}

function realpathOr(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitToplevel(dir) {
  try { return git(dir, ['rev-parse', '--show-toplevel']); } catch { return null; }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function readJsonOr(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function clip(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// --- Role cards (system prompt) ---

// The orchestrator's own folder: its session folder for a run created with
// one, the run directory for an older run.
function orchestratorDir(run) {
  return run.orchestratorDir || run.runDir;
}

function orchestratorCard(run) {
  const dir = orchestratorDir(run);
  const todo = path.join(dir, 'TODO.md');
  const isolation = run.isolation === 'worktree'
    ? 'Workers run in their own git worktree on branch `orch/' + run.runId + '/<worker>`, so they cannot overwrite each other. When a worker is done, merge its branch (git via Bash), or launch a worker to merge and resolve conflicts; then call `end_run` to remove merged worktrees.'
    : 'Workers share one working directory. Give them disjoint files and say so in each brief; never let two running workers touch the same file. Project-wide finishing steps the instructions above this card ask for (a check that rewrites shared files, a docs update) go to one final worker once the others are done.';
  return [
    `# Role: orchestrator — orchestration run ${run.runId}`,
    '',
    `You are the ORCHESTRATOR of a multi-session run. Your cross-session address is \`${run.orchestrator}\`. You coordinate; workers do the work. These instructions stay in force for the whole session, including after any compaction.`,
    '',
    'Rules',
    `1. Never write or edit code or project files yourself. The only files you write are your TODO.md and NOTES.md in ${dir} (edits elsewhere are blocked). Reading, searching and read-only commands to plan are fine.`,
    `2. Every piece of work goes to a worker CLI launched with the \`launch_cli\` tool (mcp__orchestrator__launch_cli). At most ${MAX_WORKERS} workers run at once. A follow-up for a running worker goes to it with SendMessage — never relaunch it.`,
    '3. A brief must be self-contained: the goal, the files or areas involved, acceptance criteria (how the worker proves it is done), constraints, and what is already ruled out. The worker knows only what you write.',
    `4. Keep ${todo} current: update it after every launch, report and event. One row per task in its table (id | description | depends on | status): name the worker in the description; status is queued|running|blocked|done|failed followed by the last report in a few words. It is your memory — after a compaction or resume, read it and NOTES.md first.`,
    '5. Workers report with the `report` tool and SendMessage. Worker events (report, exited, idle without reporting) arrive in your context automatically, marked "[orchestration]". Act on each one and update the TODO.',
    `6. \`list_workers\` shows every worker's state. ${isolation}`,
    `7. You may run at most ${MAX_SUBAGENTS} subagents at once, for reading only (e.g. Explore). Never use a subagent to edit code.`,
    '8. A worker\'s "done" report is trusted: do not re-run its checks, re-read its diff or launch a reviewer worker. Act on "failed" and "blocked"; launch a review only when the user asks for one. Tell the user what each worker reported and what is open.',
    '9. Where the instructions above this card tell the session to edit files, run project checks or update docs, that is workers\' work: put it in a brief, never do it yourself.',
    '10. To see how a worker is doing, read its TODO.md and NOTES.md (`list_workers` gives the paths, its current item and recent actions). Never message a worker just to ask for its status.',
    '11. A paused worker is resumed with `resume_worker` ("continue" keeps its own context; "fresh" starts a clean session from its brief and notes). Never relaunch a paused worker\'s task with launch_cli.',
  ].join('\n');
}

function workerCard(run, worker) {
  const where = worker.branch
    ? `You work in a git worktree at ${worker.cwd} on branch \`${worker.branch}\`. Commit your work on this branch when it is done; the orchestrator merges it.`
    : `Your working directory is ${worker.cwd}. Other workers share it: touch only the files your brief names.`;
  return [
    `# Role: worker \`${worker.name}\` — orchestration run ${run.runId}`,
    '',
    `You are a WORKER CLI launched by the orchestrator \`${run.orchestrator}\`. Your own cross-session address is \`${worker.name}\`. Your task is the first user message. These instructions stay in force for the whole session, including after any compaction.`,
    '',
    'Rules',
    `1. Report to the orchestrator with the \`report\` tool (mcp__orchestrator__report): status "started" when you begin, "blocked" when you need a decision (and SendMessage the question to \`${run.orchestrator}\`), "done" or "failed" when finished, "paused" when a pause is complete — with summary, filesChanged, verified (the one check you ran) and open. Never end a turn without reporting. The steps of your brief are the rows of your TODO.md; your orchestrator reads it to follow your progress.`,
    `2. You may delegate through subagents, at most ${MAX_SUBAGENTS} running at once: \`coder\` (Opus) for a substantial piece of code, \`explorer\` (Sonnet, read-only; use it rather than the built-in Explore) for a search across many files. Make small edits and single lookups yourself — a subagent's overhead costs more. A subagent's summary is trusted: do not repeat its checks.`,
    '3. Stay within your brief. If the scope has to grow, ask the orchestrator instead of widening it yourself.',
    `4. Messages from \`${run.orchestrator}\` are follow-up instructions: act on them and report.`,
    `5. ${where}`,
    `6. Where the instructions above this card tell the session to ask the user, ask \`${run.orchestrator}\` instead (SendMessage, report "blocked"). Project-wide finishing steps they ask for (a check that rewrites shared files, a docs update) are yours only when your brief assigns them; otherwise list what they need in your "done" report.`,
  ].join('\n');
}

function createOrchestration({ mgr, broadcaster, pendingQuestions, coreRoot, dataHome, control = null, pushDebounceMs = PUSH_DEBOUNCE_MS, relayFallbackMs = RELAY_FALLBACK_MS }) {
  const HOOK_SCRIPT = path.join(coreRoot, 'lib', 'orchestration-hook.js');
  const runDirs = new Map();       // runId -> runDir (rebuilt from stamps on miss)
  const volatile = new Map();      // session name -> { agents, reported, nudged }
  const pushTimers = new Map();    // runId -> timeout
  const pendingAsks = new Map();   // dedupe key -> Promise
  const relayTimers = new Map();   // worker name -> pause fallback timeout
  const inbox = new Map();         // session name -> messages for a busy CLI member
  let askSeq = 0;

  // --- Ask (the dashboard form, shared with /api/ask) ---

  // Broadcast a form and wait for the answer. The entry keeps the broadcast so a
  // dashboard that (re)connects while it is pending gets it again (dashboard-ws).
  function askUser({ formData = {}, questions = [], ctx = null, title = null, cwd = null, tabId = null, onPending } = {}) {
    const askId = `ask-${Date.now()}-${++askSeq}`;
    // The dashboard renders a form from formData.questions (the MCP ask tool
    // sends them there); a caller may pass them separately.
    if (!formData.questions) formData = { ...formData, questions };
    const message = {
      type: 'ask:question',
      askId,
      toolUseIds: [askId],
      forms: [{ toolUseId: askId, formData, questions }],
      title,
      cwd,
      ...(tabId ? { tabId } : {}),
    };
    const promise = new Promise((resolve, reject) => {
      pendingQuestions.set(askId, { formData, questions, resolve, reject, ctx, message });
    }).finally(() => pendingQuestions.delete(askId));
    if (onPending) onPending(askId);
    broadcaster.broadcast(message);
    return promise;
  }

  const ENGINE_LABELS = { cli: 'CLI terminal', sdk: 'Agent SDK panel (API billing)' };

  // Ask what is still open — the session type, the engine, or both — in one
  // form. Resolves { mode, engine } (the asked ones filled in), or null when
  // cancelled.
  async function askMode({ cwd, title, mode = null, engine = null }) {
    const questions = [];
    if (!mode) {
      questions.push({
        id: 'mode', type: 'select', header: 'Session type',
        question: 'Open a simple CLI, or an orchestrator that delegates the work to worker CLIs?',
        defaultValue: 'Simple CLI',
        options: [
          { label: 'Simple CLI', description: 'One Claude Code session, as usual.' },
          { label: 'Orchestrator CLI', description: `Plans and delegates to up to ${MAX_WORKERS} worker CLIs, tracks them in a TODO, never codes itself.` },
        ],
      });
    }
    if (!engine) {
      questions.push({
        id: 'engine', type: 'select', header: 'Engine',
        question: 'Run it in a terminal, or in the Agent SDK panel?',
        defaultValue: ENGINE_LABELS.cli,
        options: [
          { label: ENGINE_LABELS.cli, description: 'Claude Code in a terminal tab, on your usual Claude credential.' },
          { label: ENGINE_LABELS.sdk, description: 'The same Claude Code in an HTML panel (live thinking, tool calls, images), billed to the Anthropic API key.' },
        ],
      });
    }
    let answer;
    try {
      answer = await askUser({
        formData: { title: 'New CLI', submitLabel: 'Open', cancelLabel: 'Cancel' },
        questions,
        title: title || 'New CLI',
        cwd,
      });
    } catch { return null; }
    if (!Array.isArray(answer) || answer.some(a => a?.id === '_cancelled')) return null;
    if (!mode) {
      const value = String(answer.find(a => a?.id === 'mode')?.answer || '');
      if (/orchestrat/i.test(value)) mode = 'orchestrator';
      else if (/simple/i.test(value)) mode = 'simple';
      else return null;
    }
    if (!engine) {
      // Unanswered falls back to the form's default.
      const value = String(answer.find(a => a?.id === 'engine')?.answer || '');
      engine = /sdk/i.test(value) ? 'sdk' : 'cli';
    }
    return { mode, engine };
  }

  // --- Runs ---

  function runFile(runDir) { return path.join(runDir, 'run.json'); }

  function loadRun(runDir) {
    const run = readJsonOr(runFile(runDir), null);
    if (run) runDirs.set(run.runId, runDir);
    return run;
  }

  function saveRun(run) {
    writeJsonAtomic(runFile(run.runDir), run);
    broadcaster.broadcast({ type: 'orchestration:run', runId: run.runId });
  }

  function findRunDir(runId) {
    if (runDirs.has(runId)) return runDirs.get(runId);
    for (const s of mgr.sessions.values()) {
      const st = s.getSettings?.().orchestration;
      if (st?.runId === runId && st.runDir) { runDirs.set(runId, st.runDir); return st.runDir; }
    }
    // A paused run has no live session: its members' saved entries know it.
    for (const e of savedEntries()) {
      const st = e.settings?.orchestration;
      if (st?.runId === runId && st.runDir) { runDirs.set(runId, st.runDir); return st.runDir; }
    }
    return null;
  }

  function savedEntries() {
    return typeof mgr.listSaved === 'function' ? mgr.listSaved() : [];
  }

  // The newest saved session of a run member.
  function savedMember(run, pred) {
    return savedEntries().find(e => {
      const st = e.settings?.orchestration;
      return st?.runId === run.runId && pred(st);
    }) || null;
  }

  function getRun(runId) {
    const dir = findRunDir(runId);
    return dir ? loadRun(dir) : null;
  }

  function stampOf(session) {
    return session?.getSettings?.().orchestration || null;
  }

  // Live sessions carrying a stamp, by stamp — never by tab id: core restores a
  // tab under a fresh `tab-<boot>-N`.
  function findByStamp(pred) {
    const out = [];
    for (const [tabId, s] of mgr.sessions) {
      const st = stampOf(s);
      if (st && pred(st)) out.push({ tabId, session: s, stamp: st });
    }
    return out;
  }

  function workerSession(run, workerId) {
    return findByStamp(st => st.runId === run.runId && st.role === 'worker' && st.workerId === workerId)[0] || null;
  }

  function orchestratorSession(run) {
    return findByStamp(st => st.runId === run.runId && st.role === 'orchestrator')[0] || null;
  }

  function vol(name) {
    let v = volatile.get(name);
    if (!v) { v = { agents: 0, reported: false, nudged: false }; volatile.set(name, v); }
    return v;
  }

  // Keep a run directory that sits inside a git checkout out of `git status`
  // without touching a tracked file: .git/info/exclude is local to the clone.
  function excludeFromGit(runsDir) {
    const top = gitToplevel(runsDir);
    if (!top) return;
    try { git(top, ['check-ignore', '-q', runsDir]); return; } catch {}
    try {
      const excludeFile = path.resolve(top, git(top, ['rev-parse', '--git-path', 'info/exclude']));
      const pattern = '/' + path.relative(top, runsDir).split(path.sep).join('/') + '/';
      const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
      if (!current.split('\n').includes(pattern)) {
        fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
        fs.appendFileSync(excludeFile, (current && !current.endsWith('\n') ? '\n' : '') + pattern + '\n');
      }
    } catch {}
  }

  // A session's --settings file: the caller's own settings file (Pro's
  // read-ledger hooks) merged with the orchestration hooks.
  function writeSessionSettings(run, name, baseSettingsFile) {
    const base = baseSettingsFile ? readJsonOr(baseSettingsFile, {}) : {};
    const hooks = { ...(base.hooks || {}) };
    const command = `node ${JSON.stringify(HOOK_SCRIPT)}`;
    for (const ev of HOOK_EVENTS) {
      hooks[ev] = [...(hooks[ev] || []), { matcher: '', hooks: [{ type: 'command', command, timeout: 10 }] }];
    }
    const settings = { ...base, hooks, crossSessionInbound: 'accept' };
    const dir = path.join(run.runDir, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.json`);
    writeJsonAtomic(file, settings);
    return file;
  }

  // Create a run and return the settings that make a launch its orchestrator.
  // `settings` is the caller's own launch settings: its system prompt, settings
  // file and stamps become the base every worker inherits.
  function prepareRun({ cwd, runsDir, isolation, maxBudgetUsd, engine, settings = {} }) {
    const root = realpathOr(cwd);
    const runId = crypto.randomBytes(3).toString('hex');
    const dir = realpathOr(runsDir || path.join(root, '.orchestrator'));
    const runDir = path.join(dir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    excludeFromGit(dir);

    // sessionDir is per session, never inherited; sessionsRoot (the caller's
    // choice of where folders live) is, through the stamps.
    const { appendSystemPrompt, settingsFile, name: _n, orchestration: _o, model: _m, sessionDir: _d, engine: _e, ...stamps } = settings;
    const sessionsRoot = settings.sessionsRoot || path.join(dataHome, 'data', 'sessions');
    const orchestrator = `orch-${runId}`;
    const run = {
      runId,
      runDir,
      root,
      orchestrator,
      orchestratorDir: path.join(sessionsRoot, orchestrator),
      sessionsRoot,
      isolation: isolation || (gitToplevel(root) ? 'worktree' : 'none'),
      engine: (engine || settings.engine) === 'sdk' ? 'sdk' : 'cli',
      maxBudgetUsd: maxBudgetUsd || null,
      base: { appendSystemPrompt: appendSystemPrompt || '', settingsFile: settingsFile || null, stamps },
      createdAt: new Date().toISOString(),
      request: null,
      closed: false,
      busy: false,
      pausing: null,
      paused: null,
      compactions: 0,
      workerSeq: 0,
      workers: [],
      events: [],
      delivered: 0,
    };
    folders.ensureFolder(run.orchestratorDir, `Orchestration run ${runId}`);
    saveRun(run);
    runDirs.set(runId, runDir);

    const card = orchestratorCard(run);
    return {
      ...settings,
      engine: run.engine,
      name: run.orchestrator,
      sessionDir: run.orchestratorDir,
      orchestration: { runId, role: 'orchestrator', runDir },
      appendSystemPrompt: appendSystemPrompt ? `${appendSystemPrompt}\n\n${card}` : card,
      settingsFile: writeSessionSettings(run, run.orchestrator, settingsFile),
    };
  }

  // --- openCli: the one user-facing "new CLI" entry ---

  async function openCli(opts = {}) {
    let mode = opts.mode === 'simple' || opts.mode === 'orchestrator' ? opts.mode : null;
    const given = opts.engine || opts.settings?.engine;
    let engine = given === 'cli' || given === 'sdk' ? given : null;
    if (!mode || !engine) {
      // One pending question per target: a double click joins the open ask.
      const key = opts.tabId || `cwd:${opts.cwd}`;
      if (!pendingAsks.has(key)) {
        pendingAsks.set(key, askMode({ cwd: opts.cwd, title: opts.title, mode, engine }).finally(() => pendingAsks.delete(key)));
      } else {
        return { cancelled: true, duplicate: true };
      }
      const picked = await pendingAsks.get(key);
      if (!picked) return { cancelled: true };
      ({ mode, engine } = picked);
    }
    const tabId = opts.tabId || mgr.nextTabId();
    const launch = {
      cwd: opts.cwd, cols: opts.cols, rows: opts.rows, title: opts.title,
      settings: { ...(opts.settings || {}), engine }, hidden: opts.hidden, autoMemory: opts.autoMemory,
      prompt: opts.prompt, autoSubmit: opts.autoSubmit, spawnOpts: opts.spawnOpts,
    };
    if (mode === 'orchestrator') {
      launch.settings = prepareRun({
        cwd: opts.cwd, runsDir: opts.runsDir, isolation: opts.isolation,
        maxBudgetUsd: opts.maxBudgetUsd, engine, settings: opts.settings || {},
      });
      launch.spawnOpts = {};   // a fresh transcript: never resume a plain session into the role
      launch.hidden = false;
    }
    if (opts.beforeLaunch) opts.beforeLaunch(tabId);
    mgr.launchSession(tabId, launch);
    return { tabId, mode, engine };
  }

  // --- Workers ---

  function runningWorkers(run) {
    return run.workers.filter(w => workerSession(run, w.id)?.session.running);
  }

  function callerRun(instanceId, role) {
    const session = mgr.getByInstanceId(instanceId);
    const stamp = stampOf(session);
    if (!stamp || (role && stamp.role !== role)) {
      throw new Error(role === 'orchestrator' ? 'only an orchestrator session can do this' : 'not an orchestration session');
    }
    const run = loadRun(stamp.runDir);
    if (!run) throw new Error(`run ${stamp.runId} not found`);
    return { session, stamp, run };
  }

  function assertCapacity(run) {
    const running = runningWorkers(run);
    if (running.length >= MAX_WORKERS) {
      throw new Error(`${MAX_WORKERS} workers are running (${running.map(w => w.name).join(', ')}). Send a follow-up to one of them, or wait for an exit event.`);
    }
  }

  function launchWorker(instanceId, { title, task, cwd, isolation, model } = {}) {
    const { run } = callerRun(instanceId, 'orchestrator');
    if (run.closed) throw new Error('this run has been ended');
    if (run.pausing) throw new Error('this run is being paused: launch nothing new');
    if (!task || !String(task).trim()) throw new Error('task is required');
    if (model && !WORKER_MODELS.includes(model)) throw new Error(`model must be one of ${WORKER_MODELS.join(', ')}`);
    const paused = run.workers.filter(w => w.paused);
    if (paused.length) {
      throw new Error(`paused workers must be resumed (resume_worker) before new ones are launched: ${paused.map(w => w.name).join(', ')}`);
    }
    assertCapacity(run);
    const target = realpathOr(cwd ? path.resolve(run.root, cwd) : run.root);
    if (!isInside(target, run.root)) throw new Error(`cwd must be inside the run root ${run.root}`);

    const id = `w${++run.workerSeq}`;
    const name = `${run.orchestrator}-${id}-${slugify(title)}`;
    const worker = {
      id, name, title: title || id, task: String(task), cwd: target, branch: null, worktree: null,
      sessionDir: path.join(run.sessionsRoot || path.join(dataHome, 'data', 'sessions'), name),
      launchedAt: new Date().toISOString(), exitedAt: null, lastReport: null,
      ...(model ? { model } : {}),
    };

    const mode = isolation || run.isolation;
    if (mode === 'worktree') {
      const top = gitToplevel(target);
      if (!top) throw new Error(`isolation "worktree" needs a git repository; ${target} is not in one`);
      const branch = `orch/${run.runId}/${id}`;
      const wt = path.join(dataHome, 'data', 'worktrees', run.runId, id);
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      git(top, ['worktree', 'add', '-b', branch, wt, 'HEAD']);
      worker.branch = branch;
      worker.worktree = { path: wt, repo: top };
      worker.cwd = path.join(wt, path.relative(top, target));
    }

    run.workers.push(worker);
    saveRun(run);
    const tabId = spawnWorker(run, worker, worker.task);
    return { worker: name, tabId, cwd: worker.cwd, branch: worker.branch, folder: worker.sessionDir, model: mgr.sessions.get(tabId)?.getSettings().model || null };
  }

  // A worker's launch settings — the same for its first launch and a fresh
  // restart, so the restart keeps its address, role card and folder.
  function workerSettings(run, worker) {
    const card = workerCard(run, worker);
    return {
      ...run.base.stamps,
      engine: run.engine || 'cli',
      name: worker.name,
      ...(worker.sessionDir ? { sessionDir: worker.sessionDir } : {}),
      orchestration: { runId: run.runId, role: 'worker', workerId: worker.id, orchestrator: run.orchestrator, runDir: run.runDir },
      appendSystemPrompt: run.base.appendSystemPrompt ? `${run.base.appendSystemPrompt}\n\n${card}` : card,
      settingsFile: writeSessionSettings(run, worker.name, run.base.settingsFile),
      agents: WORKER_AGENTS,
      ...(worker.model ? { model: worker.model } : {}),
      ...(run.maxBudgetUsd ? { maxBudgetUsd: run.maxBudgetUsd } : {}),
    };
  }

  // A new session (fresh transcript) for a worker, with `prompt` auto-submitted.
  function spawnWorker(run, worker, prompt) {
    const tabId = mgr.nextTabId();
    if (worker.sessionDir) folders.ensureFolder(worker.sessionDir, `${worker.title} (${worker.id})`);
    mgr.launchSession(tabId, {
      cwd: worker.cwd, cols: 120, rows: 32, title: `${worker.title} (${worker.id})`,
      settings: workerSettings(run, worker), prompt, promptFrom: run.orchestrator, autoSubmit: true,
      ...(run.engine === 'sdk' ? { hidden: true } : {}),
    });
    return tabId;
  }

  function listWorkers(instanceId) {
    const { run } = callerRun(instanceId);
    return describeRun(run);
  }

  // What a session folder shows at a glance: progress, the item in progress,
  // the TODO's age and whether a resume note exists.
  function folderSummary(dir) {
    const f = dir ? folders.readFolder(dir) : null;
    if (!f) return null;
    return {
      done: f.progress.done, total: f.progress.total, doing: f.progress.doing,
      todoUpdatedAt: f.todoUpdatedAt ? new Date(f.todoUpdatedAt).toISOString() : null,
      hasResumeNote: !!f.resume,
    };
  }

  // The panel's state word for a member: busy / idle / awaiting (SDK) while it
  // runs, else why it is not running.
  function memberState(session, w) {
    if (session?.running) return session.state && session.state !== 'exited' ? session.state : session.busy ? 'busy' : 'idle';
    if (!w) return 'exited';
    return w.paused ? 'paused' : w.abandoned ? 'abandoned' : w.exitedAt ? 'exited' : 'stopped';
  }

  function costOf(session, stored) {
    return typeof session?.costUsd === 'number' ? session.costUsd : (typeof stored === 'number' ? stored : null);
  }

  function describeRun(run) {
    const orch = orchestratorSession(run);
    const saved = savedEntries();
    // A member that is not running is known by its newest saved session (its
    // sessId keys the SDK panel's history).
    const savedId = (pred) => saved.find(e => {
      const st = e.settings?.orchestration;
      return st?.runId === run.runId && pred(st);
    })?.id || null;
    return {
      runId: run.runId,
      orchestrator: run.orchestrator,
      engine: run.engine || 'cli',
      root: run.root,
      isolation: run.isolation,
      closed: run.closed,
      todo: path.join(orchestratorDir(run), 'TODO.md'),
      notes: path.join(orchestratorDir(run), 'NOTES.md'),
      pausing: !!run.pausing,
      paused: run.paused || null,
      orchestratorRunning: !!orch?.session.running,
      orchestratorSessId: orch?.session.sessId || savedId(st => st.role === 'orchestrator'),
      orchestratorTabId: orch?.tabId || null,
      orchestratorState: memberState(orch?.session, null),
      orchestratorCost: costOf(orch?.session, run.orchestratorCost),
      compactions: run.compactions || 0,
      refreshSuggested: (run.compactions || 0) >= REFRESH_SUGGESTED_AFTER,
      pendingEvents: run.events.filter(e => e.seq > run.delivered).length,
      workers: run.workers.map(w => {
        const live = workerSession(run, w.id);
        return {
          worker: w.name, name: w.name, id: w.id, title: w.title, running: !!live?.session.running, tabId: live?.tabId || null,
          sessId: live?.session.sessId || savedId(st => st.role === 'worker' && st.workerId === w.id),
          engine: run.engine || 'cli',
          model: w.model || live?.session.getSettings().model || null,
          state: memberState(live?.session, w),
          cost: costOf(live?.session, w.costUsd),
          cwd: w.cwd, branch: w.branch, launchedAt: w.launchedAt, exitedAt: w.exitedAt, lastReport: w.lastReport,
          paused: !!w.paused, abandoned: !!w.abandoned,
          todo: w.sessionDir ? path.join(w.sessionDir, 'TODO.md') : null,
          notes: w.sessionDir ? path.join(w.sessionDir, 'NOTES.md') : null,
          progress: folderSummary(w.sessionDir),
          live: live && control ? control.liveOf(live.session) : null,
        };
      }),
    };
  }

  function endRun(instanceId) {
    const { run } = callerRun(instanceId, 'orchestrator');
    const removed = [];
    const kept = [];
    for (const w of run.workers) {
      if (!w.worktree) continue;
      if (workerSession(run, w.id)?.session.running) { kept.push({ worker: w.name, reason: 'still running' }); continue; }
      let merged = false;
      try { merged = git(w.worktree.repo, ['branch', '--merged', 'HEAD', '--list', w.branch]).length > 0; } catch {}
      if (!merged) { kept.push({ worker: w.name, reason: `branch ${w.branch} not merged into HEAD` }); continue; }
      try {
        git(w.worktree.repo, ['worktree', 'remove', w.worktree.path]);
        try { git(w.worktree.repo, ['branch', '-d', w.branch]); } catch {}
        removed.push(w.name);
        w.worktree = null;
      } catch (e) {
        kept.push({ worker: w.name, reason: e.message.split('\n')[0] });
      }
    }
    if (kept.length === 0) run.closed = true;
    saveRun(run);
    return { removed, kept, closed: run.closed };
  }

  // --- Pause, refresh, resume ---

  function relayText(run, names) {
    return [
      `[vistaclair pause] The owner is pausing this run (for example for a reboot). It will be resumed later from everyone's notes.`,
      `1. Now send each running worker (${names.map(n => `\`${n}\``).join(', ')}) its pause instructions with SendMessage: what to finish (a productive edit in progress), what to drop (tests, probes, builds, validation — they are re-run after the resume), and to bring its TODO.md up to date, write \`## Resume\` in its NOTES.md and report "paused".`,
      '2. Launch nothing new. Then stop and wait: you will be told when every worker is paused.',
    ].join('\n');
  }

  function finalText(run) {
    return `[vistaclair pause] Every worker of run ${run.runId} is paused. Bring your TODO.md up to date and write the \`## Resume\` section of your NOTES.md (${orchestratorDir(run)}) for the whole run: each worker's state (its own folder holds its notes), decisions taken, what is open, the next steps. Reply PAUSED.`;
  }

  function refreshText(run) {
    return `[vistaclair pause] The owner is refreshing you: this session will be replaced by a fresh orchestrator with a clean context that continues run ${run.runId} from your notes. Workers keep running. Bring your TODO.md up to date and write the \`## Resume\` section of your NOTES.md (${orchestratorDir(run)}): each worker's state, decisions taken, what is open, the next steps. Reply PAUSED.`;
  }

  function workerPauseText(run, w) {
    return `${pauseText(w.sessionDir || '(your session folder)')}\nBefore replying, report status "paused" with the \`report\` tool (summary: your resume note in two lines).`;
  }

  function warmupText(run) {
    const paused = run.workers.filter(w => w.paused).map(w => `\`${w.name}\``);
    return [
      `[vistaclair resume] Run ${run.runId} was paused and is now resumed. Read your TODO.md and the \`## Resume\` section of your NOTES.md (${orchestratorDir(run)}), then each paused worker's TODO.md and NOTES.md (list_workers gives the paths).`,
      paused.length
        ? `Warm up the run: for each paused worker (${paused.join(', ')}) call resume_worker with mode "continue" (it keeps its own context) or "fresh" (a clean session from its brief and notes — use it when its notes and its reported files disagree, or it looked confused before the pause), and a message saying what to do first. Never relaunch a paused worker's task with launch_cli.`
        : 'No worker is paused: continue the run from your TODO.',
    ].join('\n');
  }

  // Pause a whole run. The orchestrator relays the pause to its running workers
  // (a worker it has not messaged within relayFallbackMs hears it from the
  // server); each worker writes its resume note and is closed; the orchestrator
  // writes its own last and is closed too. A run whose orchestrator is not
  // running pauses its workers directly.
  function pauseRun(runId) {
    if (!control) throw new Error('pause is not available');
    const run = getRun(runId);
    if (!run) throw new Error('run not found');
    if (run.pausing) return { already: true };
    const orch = orchestratorSession(run);
    if (orch && control.isPausing(orch.session)) throw new Error('the orchestrator is being refreshed; pause the run once the fresh one is up');
    const orchRunning = !!orch?.session.running;
    const workers = runningWorkers(run);
    run.pausing = { at: new Date().toISOString(), workers: workers.map(w => w.name), relayed: [], finalTyped: !workers.length };
    saveRun(run);
    for (const w of workers) {
      const ws = workerSession(run, w.id);
      const text = workerPauseText(run, w);
      control.pause(ws.tabId, {
        type: !orchRunning, text, stopText: text,
        hookText: orchRunning ? `[vistaclair pause] The owner is pausing this run. Start no new work; your orchestrator \`${run.orchestrator}\` is sending you what to finish.` : null,
        meta: { runId, role: 'worker', workerId: w.id },
      });
      if (orchRunning) relayTimers.set(w.name, setTimeout(() => relayFallback(runId, w.id), relayFallbackMs));
    }
    if (orchRunning) {
      const text = workers.length ? relayText(run, workers.map(w => w.name)) : finalText(run);
      control.pause(orch.tabId, {
        text, hookText: text, stopText: finalText(run),
        holdUntil: () => workersStillPausing(runId),
        meta: { runId, role: 'orchestrator', mode: 'pause' },
      });
    } else if (!workers.length) {
      run.pausing = null;
      run.paused = { at: new Date().toISOString(), workers: [] };
      saveRun(run);
    }
    return { pausing: true, workers: workers.map(w => w.name), orchestrator: orchRunning };
  }

  function workersStillPausing(runId) {
    const run = getRun(runId);
    if (!run?.pausing) return false;
    return run.pausing.workers.some(name => {
      const w = run.workers.find(x => x.name === name);
      const ws = w && workerSession(run, w.id);
      return !!(ws?.session.running && control.isPausing(ws.session));
    });
  }

  function relayFallback(runId, workerId) {
    const run = getRun(runId);
    const w = run?.workers.find(x => x.id === workerId);
    if (!run?.pausing || !w) return;
    relayTimers.delete(w.name);
    if (run.pausing.relayed.includes(w.name)) return;
    const ws = workerSession(run, w.id);
    if (ws && control.isPausing(ws.session)) control.deliver(ws.tabId, workerPauseText(run, w));
  }

  // A pausing member was saved and closed (session-control). Workers: mark
  // paused; the last one tells the orchestrator to write its own note.
  // Orchestrator: a pause ends the run's pausing; a refresh starts the fresh one.
  function onMemberFinalized(session, p) {
    const stamp = stampOf(session);
    if (!stamp) return;
    const run = loadRun(stamp.runDir);
    if (!run) return;
    if (stamp.role === 'worker') {
      const w = run.workers.find(x => x.id === stamp.workerId);
      if (!w) return;
      w.paused = true;
      w.pausedAt = new Date().toISOString();
      if (typeof session.costUsd === 'number') w.costUsd = session.costUsd;
      clearTimeout(relayTimers.get(w.name));
      relayTimers.delete(w.name);
      saveRun(run);
      if (run.pausing && !workersStillPausing(run.runId)) {
        const orch = orchestratorSession(run);
        if (orch?.session.running && control.isPausing(orch.session)) {
          if (!run.pausing.finalTyped) {
            run.pausing.finalTyped = true;
            saveRun(run);
            control.deliver(orch.tabId, finalText(run));
          }
        } else {
          run.paused = { at: new Date().toISOString(), workers: run.pausing.workers };
          run.pausing = null;
          saveRun(run);
        }
      }
      return;
    }
    if (p.meta?.mode === 'refresh') {
      freshOrchestrator(run, { settings: session.getSettings(), title: session.title, replaces: session.sessId, reason: 'refreshed' });
      return;
    }
    run.paused = { at: new Date().toISOString(), workers: run.pausing?.workers || [] };
    run.pausing = null;
    saveRun(run);
  }

  // Replace a running orchestrator with a fresh one: it writes its notes, is
  // closed, and a new session (same address, card and folder, clean context)
  // continues from them. The remedy for an orchestrator that drifted.
  function refreshOrchestrator(runId) {
    if (!control) throw new Error('refresh is not available');
    const run = getRun(runId);
    if (!run) throw new Error('run not found');
    if (run.pausing) throw new Error('the run is being paused');
    const orch = orchestratorSession(run);
    if (!orch?.session.running) throw new Error('the orchestrator is not running: restart it fresh from the "+" menu');
    control.pause(orch.tabId, { text: refreshText(run), meta: { runId, role: 'orchestrator', mode: 'refresh' } });
    return { refreshing: true };
  }

  function orchestratorSettings(run) {
    const card = orchestratorCard(run);
    return {
      ...run.base.stamps,
      engine: run.engine || 'cli',
      name: run.orchestrator,
      sessionDir: orchestratorDir(run),
      orchestration: { runId: run.runId, role: 'orchestrator', runDir: run.runDir },
      appendSystemPrompt: run.base.appendSystemPrompt ? `${run.base.appendSystemPrompt}\n\n${card}` : card,
      settingsFile: writeSessionSettings(run, run.orchestrator, run.base.settingsFile),
    };
  }

  // The seed of a fresh orchestrator: ground truth from run.json and every
  // member's folder, written next to its TODO so it can be re-read.
  function writeSeed(run, reason) {
    const dir = orchestratorDir(run);
    const own = folders.readFolder(dir);
    const lines = [
      `# Fresh restart — orchestration run ${run.runId}`,
      '',
      `Written by the dashboard at ${new Date().toISOString()} (the previous orchestrator session was ${reason}). Everything below comes from the server's run record and the session folders. Your own TODO.md and NOTES.md are in ${dir}.`,
      '',
      '## The original request',
      '',
      run.request || '(not recorded — see your TODO.md and NOTES.md)',
      '',
      '## Your resume note',
      '',
      own?.resume || '(none written)',
      '',
      '## Your TODO.md',
      '',
      clip(readTodo(run), 6000),
      '',
      '## Workers',
    ];
    for (const w of run.workers) {
      const f = w.sessionDir ? folders.readFolder(w.sessionDir) : null;
      const state = workerSession(run, w.id)?.session.running ? 'running' : w.paused ? 'paused' : w.abandoned ? 'abandoned' : 'stopped';
      lines.push('', `### \`${w.name}\` — ${state}`, '');
      lines.push(`- Folder: ${w.sessionDir || '(none)'}`);
      if (w.branch) lines.push(`- Branch: ${w.branch}`);
      lines.push(`- Last report: ${w.lastReport ? `${w.lastReport.status}: ${clip(w.lastReport.summary, 600)}${w.lastReport.filesChanged?.length ? ` (files: ${w.lastReport.filesChanged.join(', ')})` : ''}` : '(none)'}`);
      if (f) lines.push(`- TODO: ${f.progress.done}/${f.progress.total} done${f.progress.doing ? `, doing ${f.progress.doing.id}: ${clip(f.progress.doing.description, 120)}` : ''}`);
      lines.push('- Brief:', '', '```', clip(w.task, 2000), '```');
      if (f?.resume) lines.push('', '- Resume note:', '', clip(f.resume, 2000));
    }
    const recent = run.events.slice(-15);
    if (recent.length) {
      lines.push('', '## Recent events', '');
      for (const e of recent) lines.push(`- ${e.at} [${e.kind}] ${clip(e.text, 300)}`);
    }
    const file = path.join(dir, 'RESTART.md');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  }

  function freshOrchestrator(run, { settings, title, replaces, reason = 'paused' } = {}) {
    const seed = writeSeed(run, reason);
    const paused = run.workers.filter(w => w.paused).length;
    const prompt = [
      `[vistaclair resume] You are a fresh orchestrator session continuing orchestration run ${run.runId} with a clean context; the previous orchestrator session was ${reason}.`,
      `Read ${seed} first — it holds the original request, every worker's brief, last report and resume note — then your TODO.md and NOTES.md in ${orchestratorDir(run)}.`,
      'Judge the notes against the reports and the workers\' folders rather than trusting them blindly.',
      paused ? 'Then warm up the run: resume each paused worker with resume_worker (mode "continue" keeps its context, "fresh" starts it clean from its brief and notes), with a message saying what to do first. Never relaunch a paused worker\'s task with launch_cli.' : 'Then continue the run from your TODO.',
    ].join(' ');
    const tabId = mgr.nextTabId();
    mgr.launchSession(tabId, {
      cwd: run.root, cols: 120, rows: 32, title: title || run.orchestrator,
      settings: settings || orchestratorSettings(run), prompt, autoSubmit: true, hidden: false,
    });
    if (replaces && typeof mgr.forgetSaved === 'function') mgr.forgetSaved(replaces);
    const fresh = loadRun(run.runDir) || run;
    fresh.compactions = 0;
    fresh.refreshedAt = new Date().toISOString();
    fresh.pausing = null;
    fresh.busy = false;
    if (!fresh.workers.some(w => w.paused)) fresh.paused = null;
    saveRun(fresh);
    return { tabId, seed };
  }

  // Reopen a paused run from the "+" menu: the orchestrator continues its own
  // transcript and warms the workers up, or (fresh) a new orchestrator starts
  // from the notes. A continue whose transcript is gone becomes a fresh start.
  function resumeRun(runId, { fresh = false } = {}) {
    const run = getRun(runId);
    if (!run) throw new Error('run not found');
    if (orchestratorSession(run)?.session.running) throw new Error('the orchestrator is already running');
    const entry = savedMember(run, st => st.role === 'orchestrator');
    const lost = !fresh && !control?.canContinue(entry);
    if (fresh || lost) {
      const reason = lost ? 'paused, and its conversation could not be restored' : 'paused';
      return { runId, fresh: true, fellBack: lost, ...freshOrchestrator(run, { settings: entry?.settings, title: entry?.title, replaces: entry?.id, reason }) };
    }
    run.pausing = null;
    if (!run.workers.some(w => w.paused)) run.paused = null;
    saveRun(run);
    return { runId, fresh: false, ...control.resumeSaved(entry.id, { message: warmupText(run), fallback: false }) };
  }

  // Bring a worker back: its own transcript (continue), or a fresh session with
  // the same address, card and folder, seeded with its brief (fresh). A
  // continue whose transcript is gone becomes a fresh start (`fellBack`).
  function bringBack(run, w, { mode = 'continue', message = '' } = {}) {
    if (workerSession(run, w.id)?.session.running) throw new Error(`${w.name} is already running: send it a message instead`);
    assertCapacity(run);
    const from = message ? `From your orchestrator \`${run.orchestrator}\`: ${message}` : '';
    const old = savedMember(run, st => st.role === 'worker' && st.workerId === w.id);
    const lost = mode !== 'fresh' && !control?.canContinue(old);
    let tabId;
    if (mode === 'fresh' || lost) {
      const why = lost ? 'its earlier conversation could not be restored, so this is a fresh session' : 'this is a fresh restart';
      const prompt = `${w.task}\n\n[vistaclair resume] You are worker \`${w.name}\` and ${why} with a clean context: the brief above is your original task, already partly done. Your TODO.md and NOTES.md in ${w.sessionDir} are your state — read them first, check the files they name, re-run whatever was cut off and continue from the \`## Resume\` note. ${from}`.trim();
      tabId = spawnWorker(run, w, prompt);
      if (old && typeof mgr.forgetSaved === 'function') mgr.forgetSaved(old.id);
    } else {
      const text = `${resumeText(w.sessionDir || '(your session folder)', { interrupted: !!old.interrupted })}${from ? `\n${from}` : ''}`;
      ({ tabId } = control.resumeSaved(old.id, { message: text, fallback: false }));
    }
    const fresh = loadRun(run.runDir);
    const fw = fresh.workers.find(x => x.id === w.id);
    fw.paused = false;
    fw.exitedAt = null;
    fw.resumedAt = new Date().toISOString();
    if (!fresh.workers.some(x => x.paused)) fresh.paused = null;
    saveRun(fresh);
    const v = vol(w.name);
    v.agents = 0; v.reported = false; v.nudged = false;
    return { worker: w.name, tabId, mode: mode === 'fresh' || lost ? 'fresh' : 'continue', ...(lost ? { fellBack: true, note: 'its conversation could not be restored, so it was started fresh from its brief and notes' } : {}) };
  }

  // resume_worker (orchestrator tool). Counts against the worker cap.
  function resumeWorker(instanceId, { worker, mode = 'continue', message = '' } = {}) {
    const { run } = callerRun(instanceId, 'orchestrator');
    if (run.pausing) throw new Error('this run is being paused');
    const w = run.workers.find(x => x.name === worker || x.id === worker);
    if (!w) throw new Error(`no worker ${worker} in this run`);
    return bringBack(run, w, { mode, message });
  }

  // A worker row clicked in the "+" menu: the same as resume_worker "continue",
  // so a lost transcript still restarts it from its brief, not a bare prompt.
  function resumeSavedWorker(sessionId) {
    const entry = typeof mgr.findSaved === 'function' ? mgr.findSaved(sessionId) : null;
    const st = entry?.settings?.orchestration;
    if (st?.role !== 'worker') throw new Error('not a worker session');
    const run = loadRun(st.runDir);
    const w = run?.workers.find(x => x.id === st.workerId);
    if (!w) throw new Error('its run is gone; delete it from the list');
    return bringBack(run, w, { mode: 'continue' });
  }

  // Delete a whole run from the "+" menu: every member's saved session, the
  // session folders, the run directory and the worktrees. A worktree with
  // uncommitted changes stops it unless `force`; an unmerged branch is kept.
  function deleteRun(runId, { force = false } = {}) {
    const run = getRun(runId);
    const entries = savedEntries().filter(e => e.settings?.orchestration?.runId === runId);
    for (const s of mgr.sessions.values()) {
      if (s.getSettings?.().orchestration?.runId === runId && s.running) throw new Error('a member of this run is still running');
    }
    const dirty = [];
    const keptBranches = [];
    for (const w of run?.workers || []) {
      if (!w.worktree) continue;
      let changes = '';
      try { changes = git(w.worktree.path, ['status', '--porcelain']); } catch {}
      if (changes) dirty.push({ worker: w.name, path: w.worktree.path });
    }
    if (dirty.length && !force) return { refused: true, dirty };
    for (const w of run?.workers || []) {
      if (!w.worktree) continue;
      try { git(w.worktree.repo, ['worktree', 'remove', '--force', w.worktree.path]); } catch {}
      let merged = false;
      try { merged = git(w.worktree.repo, ['branch', '--merged', 'HEAD', '--list', w.branch]).length > 0; } catch {}
      if (merged) { try { git(w.worktree.repo, ['branch', '-d', w.branch]); } catch {} } else keptBranches.push(w.branch);
    }
    for (const e of entries) mgr.deleteSavedSession(e.id);
    const dirs = [run?.orchestratorDir, ...(run?.workers || []).map(w => w.sessionDir)];
    for (const d of dirs) {
      if (d && path.basename(path.dirname(d)) === 'sessions') fs.rmSync(d, { recursive: true, force: true });
    }
    if (run?.runDir && path.basename(run.runDir) === run.runId) fs.rmSync(run.runDir, { recursive: true, force: true });
    runDirs.delete(runId);
    broadcaster.broadcast({ type: 'orchestration:run', runId, deleted: true });
    return { deleted: entries.length, keptBranches, dirty };
  }

  // A worker deleted on its own from the "+" menu stays in run.json, marked.
  function noteMemberDeleted(entry) {
    const st = entry?.settings?.orchestration;
    if (st?.role !== 'worker') return;
    const run = loadRun(st.runDir);
    const w = run?.workers.find(x => x.id === st.workerId);
    if (!w) return;
    w.deleted = true;
    w.paused = false;
    if (!run.workers.some(x => x.paused)) run.paused = null;
    saveRun(run);
  }

  // May this tab be closed? A worker only once its work is complete (its last
  // report is done/failed, and it is idle) — or when forced, which abandons it;
  // an orchestrator only while none of its workers runs.
  function closeCheck(tabId, { force = false } = {}) {
    const session = mgr.get ? mgr.get(tabId) : mgr.sessions.get(tabId);
    const stamp = stampOf(session);
    if (!stamp) return { ok: true };
    const run = loadRun(stamp.runDir);
    if (!run) return { ok: true };
    if (stamp.role === 'worker') {
      const w = run.workers.find(x => x.id === stamp.workerId);
      if (!w) return { ok: true };
      const complete = w.abandoned || ['done', 'failed'].includes(w.lastReport?.status);
      if (complete && !session.busy) return { ok: true };
      if (force) {
        w.abandoned = true;
        saveRun(run);
        return { ok: true, abandoned: true };
      }
      return { ok: false, canForce: true, reason: `${w.name} has not finished its work. A worker is paused through its orchestrator, and closes once it reports done or failed. Force-closing abandons it.` };
    }
    const running = runningWorkers(run);
    if (running.length) {
      return { ok: false, canForce: false, reason: `Workers of this run are still running (${running.map(w => w.name).join(', ')}). Pause the run, or wait for them to finish.` };
    }
    return { ok: true };
  }

  if (control) control.onFinalized(onMemberFinalized);

  function report(instanceId, { status, summary, filesChanged, verified, open } = {}) {
    const { session, stamp, run } = callerRun(instanceId, 'worker');
    const w = run.workers.find(x => x.id === stamp.workerId);
    if (!w) throw new Error('worker not found in run');
    w.lastReport = { status: status || 'update', summary: summary || '', filesChanged: filesChanged || [], verified: verified || '', open: open || '', at: new Date().toISOString() };
    const parts = [`${w.name} reported ${w.lastReport.status}: ${clip(summary, 600)}`];
    if (w.lastReport.filesChanged.length) parts.push(`files: ${w.lastReport.filesChanged.join(', ')}`);
    if (verified) parts.push(`verified: ${clip(verified, 300)}`);
    if (open) parts.push(`open: ${clip(open, 300)}`);
    addEvent(run, { worker: w.name, kind: 'report', text: parts.join(' — ') });
    vol(session.getSettings().name).reported = true;
    return { ok: true };
  }

  // --- Messages between run members (SendMessage / ListAgents) ---

  // The run's members, by address: the orchestrator, then every worker.
  function members(run) {
    const out = [{ name: run.orchestrator, role: 'orchestrator', id: null, title: 'orchestrator', worker: null, live: orchestratorSession(run) }];
    for (const w of run.workers) out.push({ name: w.name, role: 'worker', id: w.id, title: w.title, worker: w, live: workerSession(run, w.id) });
    return out;
  }

  // `to` is an address (optionally with Claude Code's ` [ref]` suffix), a
  // worker id (w2) or "orchestrator".
  function resolveMember(run, to) {
    const want = String(to || '').trim().replace(/\s+\[[^\]]*\]$/, '');
    if (!want) throw new Error('`to` is required');
    const list = members(run);
    const m = list.find(x => x.name === want) || list.find(x => x.id && x.id === want) || (want === 'orchestrator' ? list[0] : null);
    if (!m) throw new Error(`no member ${want} in run ${run.runId}. Members: ${list.map(x => x.name).join(', ')}`);
    return m;
  }

  // An SDK panel event for one member (kept in its transcript); a CLI member
  // has no panel, so it is only broadcast.
  function emitTo(session, run, ev) {
    if (typeof session?.emitEvent === 'function') session.emitEvent(ev);
    else if (session?.sessId) broadcaster.broadcast({ type: 'sdk:event', sessId: session.sessId, runId: run.runId, ts: Date.now(), ev });
  }

  // Messages waiting for a busy CLI member's next hook, or null.
  function takeInbox(name) {
    const q = inbox.get(name);
    if (!q?.length) return null;
    inbox.delete(name);
    return clip(q.join('\n\n'), CONTEXT_LIMIT);
  }

  const joinContext = (...parts) => parts.filter(Boolean).join('\n\n') || null;

  // SendMessage: deliver `message` to a member of the caller's run as a user
  // turn "[message from <name>] …". An SDK target takes it with priority 'next'
  // (busy: read after its running tool calls, in the same turn; idle: starts a
  // turn); an idle CLI target has it typed; a busy CLI target gets it through
  // its next hook (tool result, prompt, or a Stop block).
  function sendMessage(instanceId, { to, message } = {}) {
    const { session, stamp, run } = callerRun(instanceId);
    const from = session.getSettings().name || stamp.role;
    const text = String(message ?? '').trim();
    if (!text) throw new Error('message is required');
    const target = resolveMember(run, to);
    if (target.name === from) throw new Error('that is your own address');
    const ts = target.live?.session;
    if (!ts?.running) {
      throw new Error(target.role === 'worker'
        ? `${target.name} is not running${target.worker.paused ? ' (paused)' : ''}${stamp.role === 'orchestrator' ? ': bring it back with resume_worker, passing this as its message' : ''}`
        : `the orchestrator ${target.name} is not running`);
    }
    const body = `[message from ${from}] ${text}`;
    let delivery = 'submitted';
    if (ts.kind === 'sdk') {
      ts.submit(body, { priority: 'next', from });
    } else if (!ts.busy) {
      ts.submit(body, { from });
    } else {
      const q = inbox.get(target.name) || [];
      q.push(body);
      inbox.set(target.name, q);
      delivery = 'queued';
    }
    const ev = { platform: { kind: 'message', from, to: target.name, text } };
    emitTo(session, run, ev);
    emitTo(ts, run, ev);
    return { ok: true, to: target.name, delivery };
  }

  // ListAgents: the caller's run, every member with its state.
  function listAgents(instanceId) {
    const { session, run } = callerRun(instanceId);
    return {
      you: session.getSettings().name || null,
      runId: run.runId,
      agents: members(run).map(m => ({
        name: m.name, role: m.role, title: m.title,
        state: memberState(m.live?.session, m.worker),
        ...(m.worker?.lastReport ? { lastReport: `${m.worker.lastReport.status}: ${clip(m.worker.lastReport.summary, 200)}` } : {}),
      })),
    };
  }

  // --- Events and delivery ---

  function addEvent(run, { worker, kind, text }) {
    const seq = (run.events.length ? run.events[run.events.length - 1].seq : 0) + 1;
    run.events.push({ seq, at: new Date().toISOString(), worker, kind, text });
    if (run.events.length > 200) run.events = run.events.slice(-200);
    saveRun(run);
    schedulePush(run.runId);
  }

  function takeEvents(run) {
    const fresh = run.events.filter(e => e.seq > run.delivered);
    if (!fresh.length) return null;
    run.delivered = fresh[fresh.length - 1].seq;
    saveRun(run);
    const lines = fresh.map(e => `- [${e.kind}] ${e.text}`);
    const text = clip(`[orchestration] ${fresh.length} worker event(s) — act on them and update TODO.md:\n${lines.join('\n')}`, CONTEXT_LIMIT);
    // Hook context never shows in the SDK stream: the panel gets it as a notice.
    orchestratorSession(run)?.session.emitEvent?.({ platform: { kind: 'notice', text } });
    return text;
  }

  function schedulePush(runId) {
    if (pushTimers.has(runId)) return;
    pushTimers.set(runId, setTimeout(() => {
      pushTimers.delete(runId);
      const run = getRun(runId);
      if (!run) return;
      const pending = run.events.filter(e => e.seq > run.delivered).length;
      if (!pending || run.busy || run.pausing) return;   // busy: its next hook picks them up; pausing: the resume does
      const orch = orchestratorSession(run);
      if (!orch?.session.running) return; // not running: SessionStart(resume) delivers
      if (control?.isPausing(orch.session)) return;      // being refreshed: the fresh one gets them
      // Idle: type a one-line notice, which starts a turn; its UserPromptSubmit
      // hook then attaches the events themselves.
      run.busy = true;
      saveRun(run);
      orch.session.submit(`[orchestration] ${pending} worker event(s) pending`, { from: 'orchestration' });
    }, pushDebounceMs));
  }

  // Core's exit listener: a worker exit becomes an event; an orchestrator exit
  // clears its busy flag so the next event after a restart is pushed again.
  function onSessionExit(tabId, session) {
    const stamp = stampOf(session);
    if (!stamp) return;
    const run = loadRun(stamp.runDir);
    if (!run) return;
    if (stamp.role === 'orchestrator') {
      run.busy = false;
      if (typeof session.costUsd === 'number') run.orchestratorCost = session.costUsd;
      saveRun(run);
      return;
    }
    const w = run.workers.find(x => x.id === stamp.workerId);
    if (!w) return;
    w.exitedAt = new Date().toISOString();
    if (typeof session.costUsd === 'number') w.costUsd = session.costUsd;
    addEvent(run, { worker: w.name, kind: 'exited', text: `${w.name} exited${w.lastReport ? ` (last report: ${w.lastReport.status})` : ' without reporting'}` });
  }

  // --- Hooks ---

  function workerLine(w) {
    const state = w.running ? 'running' : w.paused ? 'paused — resume_worker brings it back' : w.abandoned ? 'abandoned' : 'stopped';
    const p = w.progress;
    const progress = p ? ` — TODO ${p.done}/${p.total}${p.doing ? `, doing ${p.doing.id}: ${clip(p.doing.description, 80)}` : ''}${p.hasResumeNote ? ', has a resume note' : ''}` : '';
    const last = w.lastReport ? ` — last report: ${w.lastReport.status}: ${clip(w.lastReport.summary, 200)}` : '';
    return `- ${w.worker} [${state}] ${w.title}${progress}${last}${w.todo ? ` (folder: ${path.dirname(w.todo)})` : ''}`;
  }

  function recap(run, stamp) {
    if (stamp.role === 'orchestrator') {
      const todo = readTodo(run);
      const d = describeRun(run);
      const workers = d.workers.map(workerLine).join('\n') || '- none launched yet';
      return [
        `[orchestration] Context restored. You are the ORCHESTRATOR \`${run.orchestrator}\` of run ${run.runId}; your role card in the system prompt still applies.`,
        `TODO (${d.todo}):`, clip(todo, 5000),
        'Workers:', workers,
      ].join('\n');
    }
    const w = run.workers.find(x => x.id === stamp.workerId) || {};
    return [
      `[orchestration] Context restored. You are WORKER \`${w.name}\` of run ${run.runId}, launched by \`${run.orchestrator}\`; your role card in the system prompt still applies. Report with the \`report\` tool; delegate to \`coder\` / \`explorer\`.`,
      'Your original brief:', clip(w.task, 4000),
      w.lastReport ? `Your last report: ${w.lastReport.status}: ${clip(w.lastReport.summary, 500)}` : 'You have not reported yet.',
    ].join('\n');
  }

  function readTodo(run) {
    try { return fs.readFileSync(path.join(orchestratorDir(run), 'TODO.md'), 'utf8'); } catch { return '(TODO.md missing)'; }
  }

  function readNotes(dir) {
    try { return fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf8'); } catch { return ''; }
  }

  const ctxOut = (event, text) => (text ? { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }) } : {});
  const deny = (msg) => ({ exitCode: 2, stderr: msg });

  // Decide one hook event. Returns { exitCode?, stdout?, stderr? } for the hook
  // script to reproduce. Unknown sessions get {} (no effect). The session
  // control's answer (live state, the pause channel) is merged in; while the
  // session is pausing, its Stop is decided by the pause alone.
  function handleHook(instanceId, input = {}) {
    const ctl = control ? control.reply(instanceId, input) : {};
    const session = mgr.getByInstanceId(instanceId);
    if (input.hook_event_name === 'Stop' && control?.isPausing(session)) return ctl;
    return mergeReplies(input.hook_event_name, decideHook(session, input), ctl);
  }

  function decideHook(session, input) {
    const stamp = stampOf(session);
    if (!stamp) return {};
    const run = loadRun(stamp.runDir);
    if (!run) return {};
    const name = session.getSettings().name || stamp.role;
    const v = vol(name);
    const ev = input.hook_event_name;
    const tool = input.tool_name || '';
    const isOrch = stamp.role === 'orchestrator';
    // A pausing run delivers no worker events: the resume brings them.
    const events = () => (run.pausing ? null : takeEvents(run));

    switch (ev) {
      case 'SessionStart': {
        const src = input.source;
        if (src === 'startup' || src === 'resume' || src === 'clear') { v.agents = 0; v.reported = false; v.nudged = false; }
        if (isOrch) {
          run.busy = false;
          if (src === 'compact') run.compactions = (run.compactions || 0) + 1;
          saveRun(run);
        } else {
          // Back from a pause, however it was resumed (resume_worker, the "+" menu).
          const w = run.workers.find(x => x.id === stamp.workerId);
          if (w?.paused && src !== 'compact') {
            w.paused = false;
            if (!run.workers.some(x => x.paused)) run.paused = null;
            saveRun(run);
          }
        }
        if (src !== 'compact' && src !== 'resume') return {};
        let text = recap(run, stamp);
        if (isOrch) {
          const ev2 = events();
          if (ev2) text += `\n\n${ev2}`;
        }
        return ctxOut('SessionStart', clip(text, CONTEXT_LIMIT));
      }
      case 'UserPromptSubmit': {
        if (!isOrch) { v.reported = false; v.nudged = false; return ctxOut('UserPromptSubmit', takeInbox(name)); }
        run.busy = true;
        // The run's original request, for a fresh orchestrator's seed: the first
        // prompt that is not one of the dashboard's own notices.
        const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
        if (!run.request && prompt && !prompt.startsWith('[')) run.request = clip(prompt, 8000);
        saveRun(run);
        return ctxOut('UserPromptSubmit', joinContext(takeInbox(name), events()));
      }
      case 'PreToolUse': {
        if (tool === 'Workflow') return deny('Workflows are disabled in orchestration sessions (they would bypass the subagent cap). Use the Agent tool, at most 3 at once.');
        if (AGENT_TOOLS.has(tool)) {
          if (v.agents >= MAX_SUBAGENTS) return deny(`${MAX_SUBAGENTS} subagents are already running in this session. Wait for one to finish, then launch the next.`);
          v.agents++;
          return {};
        }
        if (isOrch && EDIT_TOOLS.has(tool)) {
          const target = input.tool_input?.file_path || input.tool_input?.notebook_path || '';
          const abs = path.resolve(input.cwd || run.root, target);
          const own = orchestratorDir(run);
          if (!isInside(abs, run.runDir) && !isInside(abs, own)) {
            return deny(`The orchestrator does not edit project files (${abs}). Delegate this change to a worker with launch_cli, or message the worker that owns it. You may only edit your TODO.md and NOTES.md under ${own}.`);
          }
        }
        return {};
      }
      case 'PostToolUse': {
        // Exact address, optionally with a ` [ref]` suffix — a sibling worker's
        // name also starts with the orchestrator's. Claude Code's own
        // SendMessage and the orchestrator server's (mcp__orchestrator__SendMessage,
        // SDK runs) alike.
        const to = /(^|__)SendMessage$/.test(tool) && typeof input.tool_input?.to === 'string' ? input.tool_input.to : null;
        const addressed = (n) => to === n || (to || '').startsWith(`${n} [`);
        if (!isOrch) {
          if (to && (addressed(run.orchestrator) || to === 'orchestrator')) v.reported = true;
          if (/(^|__)report$/.test(tool)) v.reported = true;
          return ctxOut('PostToolUse', takeInbox(name));
        }
        if (to && run.pausing) {
          // The orchestrator relayed the pause to a worker: no server fallback.
          const w = run.workers.find(x => addressed(x.name) || to === x.id);
          if (w && !run.pausing.relayed.includes(w.name)) {
            run.pausing.relayed.push(w.name);
            clearTimeout(relayTimers.get(w.name));
            relayTimers.delete(w.name);
            saveRun(run);
          }
        }
        return ctxOut('PostToolUse', joinContext(takeInbox(name), events()));
      }
      case 'PostToolUseFailure': {
        if (AGENT_TOOLS.has(tool)) v.agents = Math.max(0, v.agents - 1);
        return {};
      }
      case 'SubagentStop': {
        v.agents = Math.max(0, v.agents - 1);
        return {};
      }
      case 'StopFailure': {
        if (isOrch) { run.busy = false; saveRun(run); }
        return {};
      }
      case 'Stop': {
        if (isOrch) {
          const pending = joinContext(takeInbox(name), events());
          if (pending) return { stdout: JSON.stringify({ decision: 'block', reason: pending }) };
          run.busy = false;
          saveRun(run);
          return {};
        }
        // A message arrived during the turn: it continues with it.
        const msgs = takeInbox(name);
        if (msgs) return { stdout: JSON.stringify({ decision: 'block', reason: msgs }) };
        // Still working in the background (subagents, background shells): not idle.
        if (Array.isArray(input.background_tasks) && input.background_tasks.length) return {};
        if (v.reported) return {};
        if (!v.nudged && !input.stop_hook_active) {
          v.nudged = true;
          return { stdout: JSON.stringify({ decision: 'block', reason: `Before ending this turn, report to the orchestrator \`${run.orchestrator}\` with the \`report\` tool (status, summary, filesChanged, verified, open).` }) };
        }
        addEvent(run, { worker: name, kind: 'idle', text: `${name} went idle without reporting. Its last message: ${clip(input.last_assistant_message, 500)}` });
        return {};
      }
      default:
        return {};
    }
  }

  // /api/orchestration — mounted behind the dashboard's auth: the hook script
  // and the MCP server call over loopback with the internal header, the GUI
  // with its owner session.
  function router() {
    const express = require('express');
    const r = express.Router();
    const call = (fn) => (req, res) => {
      try { res.json(fn(req.body || {}) || {}); } catch (e) { res.json({ error: e.message }); }
    };
    r.post('/hook', (req, res) => {
      try { res.json(handleHook(req.body?.instanceId, req.body?.input)); } catch (e) {
        console.error('[orchestration] hook error:', e.message);
        res.json({});
      }
    });
    r.post('/launch', call(b => launchWorker(b.instanceId, b)));
    r.post('/workers', call(b => listWorkers(b.instanceId)));
    r.post('/end', call(b => endRun(b.instanceId)));
    r.post('/report', call(b => report(b.instanceId, b)));
    r.post('/resume-worker', call(b => resumeWorker(b.instanceId, b)));
    r.post('/send-message', call(b => sendMessage(b.instanceId, b)));
    r.post('/list-agents', call(b => listAgents(b.instanceId)));
    // The run board (GUI).
    r.post('/pause', call(b => pauseRun(String(b.runId || ''))));
    r.post('/refresh', call(b => refreshOrchestrator(String(b.runId || ''))));
    r.post('/resume-run', call(b => resumeRun(String(b.runId || ''), { fresh: b.fresh === true })));
    r.post('/delete-run', call(b => deleteRun(String(b.runId || ''), { force: b.force === true })));
    r.get('/run', (req, res) => {
      const run = getRun(String(req.query.runId || ''));
      if (!run) return res.status(404).json({ error: 'run not found' });
      res.json({ ...describeRun(run), todoText: readTodo(run), events: run.events.slice(-30) });
    });
    return r;
  }

  return {
    router, openCli, askUser, prepareRun, launchWorker, listWorkers, endRun, report, sendMessage, listAgents,
    handleHook, onSessionExit, getRun, describeRun, findByStamp, writeSessionSettings,
    pauseRun, refreshOrchestrator, resumeRun, resumeWorker, resumeSavedWorker, deleteRun, closeCheck, noteMemberDeleted,
    MAX_WORKERS, MAX_SUBAGENTS, WORKER_AGENTS,
  };
}

module.exports = { createOrchestration, orchestratorCard, workerCard, WORKER_AGENTS, MAX_WORKERS, MAX_SUBAGENTS };
