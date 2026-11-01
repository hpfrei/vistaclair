// Orchestrator CLI sessions: one CLI tab that plans and delegates, worker tabs
// that do the work, Claude Code's own cross-session messaging between them.
//
//   openCli(opts)        the one user-facing "new CLI" entry. `mode` unset is an
//                        orchestrator for an Agent SDK session (a caller's
//                        resume is then dropped: the role starts fresh) and asks
//                        Simple / Orchestrator for a terminal; `auth` unset asks
//                        an SDK session's billing, in one dashboard ask form. An
//                        explicit mode wins.
//   engine               settings.engine 'cli' (a PTY tab) | 'sdk' (an Agent SDK
//                        session, src/sdk-session.js). Never asked: `engine`
//                        unset is the Agent SDK panel, or a terminal when the
//                        app pref fallbackEngine says so. A run has one engine
//                        (run.engine); its workers inherit it. SDK workers are
//                        hidden: they are areas of the run's panel.
//   auth                 settings.auth 'apikey' | 'subscription': what an SDK
//                        session is billed to. Asked only when both credentials
//                        exist; otherwise the form names the one in use. A run
//                        has one (run.auth); its workers inherit it.
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
//   events               worker exit / idle-without-report / report / landing.
//                        Delivered into the orchestrator's context by its next hook
//                        when it is busy, or by typing a one-line notice into its
//                        tab when it is idle (which starts a turn). A done report
//                        that starts a landing is one event, once it settles.
//                        Quiet events (started/update reports, overlaps) never
//                        type the notice: they ride along with the next delivery,
//                        or push once after QUIET_VALVE_MS (run.quietValve).
//   tools                lib/orchestrator-mcp.js: launch_cli, cancel_launch,
//                        resume_worker, close_worker, stop_worker, list_workers, end_run,
//                        undo_landing (orchestrator); report (workers);
//                        SendMessage, ListAgents (both, SDK runs: Claude Code's
//                        own cross-session messaging is a CLI feature). A message
//                        is submitted into its target with priority 'next' (an
//                        SDK target reads it within its running turn); a busy
//                        CLI target gets it through its next hook instead.
//   landing              a worktree worker's "done" report lands its branch on
//                        the base recorded at launch (rebase, check, merge
//                        --no-ff); its worktree is torn down at close, exit and
//                        end_run once merged and clean (src/worktree-landing.js).
//   areas                launch_cli `area`: overlaps with running workers' areas
//                        are named in its result; checkOverlaps (a timer) tells
//                        the workers involved of a file changed in two live
//                        worktrees, and the orchestrator with a quiet event.
//   launch queue         launch_cli on a full run, or with `after` workers not
//                        finished, waits in run.queue; pumpQueue starts the
//                        ready ones oldest first (closing a finished, landed,
//                        clean idle worker when no slot is free), never while
//                        the run pauses; cancel_launch drops one, end_run all.
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
//   remote workers       registerHostProvider({ hosts, launch, kill }) (the
//                        add-on ctx; one provider, a second replaces it):
//                        launch_cli `host` (+ `app`) records a member that runs
//                        on another machine (w.host, w.app, w.remote), state
//                        pending-approval until provider.launch resolves the
//                        tab of a registerExternalSession session; the start
//                        or the refusal (.code) is a "remote" event. It counts
//                        toward MAX_WORKERS and queues like any launch. Its
//                        reports and messages arrive through the handle's
//                        deliver(); SendMessage goes to its adapter's submit;
//                        close_worker / end_run / deleteRun → provider.kill;
//                        stop_worker → its adapter's interrupt. No cwd,
//                        isolation, area or tools; nothing lands; a pause does
//                        not reach it; resume_worker refuses it. Its record
//                        survives a restart (a lost pending launch becomes a
//                        "remote" event); the provider re-adopts its tab.
//   mirror runs          openMirrorRun({ key, orchestrator: { address, host },
//                        deliver }) (the add-on ctx): the slave side. A run
//                        whose orchestrator is an address on another machine,
//                        keyed in <dataHome>/data/mirror-runs/index.json and
//                        re-opened by key. Its members are SDK workers
//                        (launchWorker); their reports and SendMessage to the
//                        orchestrator go to deliver(); submit / interrupt /
//                        kill by address; close(). No orchestrator session:
//                        pause, resume and refresh refuse it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const folders = require('./session-folders');
const toolPacks = require('./tool-packs');
const landing = require('./worktree-landing');
const { mergeReplies, pauseText, resumeText } = require('./session-control');
const { transcriptTotals, MODEL_RE } = require('./sdk-session');

const MAX_WORKERS = 5;
// The model a worker may be launched on (launch_cli `model`), as Claude Code's
// Agent tool takes it. Unset: the dashboard's default model for new tabs.
const WORKER_MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
const MAX_SUBAGENTS = 3;
const PUSH_DEBOUNCE_MS = 2000;
const RELAY_FALLBACK_MS = 120000;
const OVERLAP_CHECK_MS = 180000;     // how often files changed in two live worktrees of a repo are looked for    // a worker the orchestrator has not told to pause by then hears it from the server
const REFRESH_SUGGESTED_AFTER = 3;   // orchestrator compactions
const CONTEXT_LIMIT = 9000;          // hook additionalContext is capped at 10k chars
const QUIET_VALVE_MS = 600000;       // quiet events undelivered this long push the orchestrator once
const QUIET_SHOWN = 15;              // quiet events listed in one delivery (the newest); the rest are counted
const EVENT_ITEM_LIMIT = 4000;       // one event's text in a delivery (two always fit in CONTEXT_LIMIT)
// Report statuses that wake the orchestrator; any other (started, update) is
// quiet: it waits for the next delivery.
const WAKE_STATUSES = new Set(['done', 'failed', 'blocked', 'paused']);
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
    tools: ['Read', 'Bash', 'WebFetch', 'WebSearch'],
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

// A new worktree's dependency links and copies (src/worktree-landing.js), as
// its run.json record: { links } when there are any, { gap } the gitignored
// paths it lacks (its card says so).
function linksOf(repo, worktree, dir) {
  const links = landing.createLinks({ repo, worktree, dir });
  const gap = landing.gapList({ repo, worktree, dir, records: links });
  return { ...(links.length ? { links } : {}), ...(gap.paths.length ? { gap } : {}) };
}

// --- Worker areas (launch_cli `area`) ---

// A repo-relative path or glob, normalized: no leading ./, no trailing /;
// '' is the whole repo. An area covers its path and everything under it.
function normArea(p) {
  const s = String(p).trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  return s === '.' ? '' : s;
}

const GLOB = /[*?]/;

// May two path segments name the same entry? * and ? stay within it; two
// globs meet when their literal starts and ends are compatible.
function segmentsMeet(a, b) {
  const ga = GLOB.test(a);
  const gb = GLOB.test(b);
  if (!ga && !gb) return a === b;
  const re = (g) => new RegExp('^' + g.split('').map(c => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('') + '$');
  if (!ga) return re(b).test(a);
  if (!gb) return re(a).test(b);
  const head = (g) => g.slice(0, g.search(GLOB));
  const tail = (g) => g.slice(Math.max(g.lastIndexOf('*'), g.lastIndexOf('?')) + 1);
  const meet = (x, y, f) => x[f](y) || y[f](x);
  return meet(head(a), head(b), 'startsWith') && meet(tail(a), tail(b), 'endsWith');
}

// May two areas hold the same file? An area covers its path and everything
// under it; ** may be anything from there on (conservative).
function areasOverlap(a, b) {
  if (a === '' || b === '') return true;
  const sa = a.split('/');
  const sb = b.split('/');
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    if (sa[i].includes('**') || sb[i].includes('**')) return true;
    if (!segmentsMeet(sa[i], sb[i])) return false;
  }
  return true;
}

// launch_cli `area`: a path, or a list of them. Undefined when not given.
function areaOf(area) {
  if (area === undefined || area === null) return undefined;
  const list = (Array.isArray(area) ? area : [area]);
  if (list.some(p => typeof p !== 'string' || !p.trim())) throw new Error('area must be a list of repo-relative paths or globs');
  const out = [...new Set(list.map(normArea))];
  if (out.some(p => p.startsWith('/') || p.split('/').includes('..'))) throw new Error('area paths must be relative to the repo root, without ..');
  return out.length ? out : undefined;
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

// `hosts`: the host provider's machines (hostList); none → no remote rule.
function orchestratorCard(run, { hosts = [] } = {}) {
  const dir = orchestratorDir(run);
  const remote = hosts.length
    ? `15. Remote workers: launch_cli \`host\` runs a worker on another machine: ${hosts.map(h => `\`${h.name}\`${h.available ? '' : ` (unavailable now: ${h.reason || 'no reason given'})`}`).join(', ')}. The owner approves each remote launch on a card first, so launch_cli returns at once (state pending-approval) and a "remote" event says when it started or why not. It runs in an app's directory there (\`app\`, default the run's app) and has nothing on this machine: no cwd, isolation, area or tools. It reports and takes SendMessage like any worker; close_worker or end_run stops it; it cannot be resumed (launch a new one with its brief and last report).`
    : null;
  const todo = path.join(dir, 'TODO.md');
  const isolation = run.isolation === 'worktree'
    ? 'Workers run in their own git worktree on branch `orch/' + run.runId + '/<worker>`, so they cannot overwrite each other. A worker\'s "done" report lands its branch, by code: rebased onto its base branch, the repo\'s check run, merged with --no-ff. You get one event for the report and its landing ("reported done: … — landed <sha>", or "— not landed: <reason>"); what the worker can fix goes back to it by itself. Never merge, rebase or reset branches yourself. Plan disjoint areas and pass each worker\'s files or directories as `area` in launch_cli; an overlap named in its result, or an "overlap" event (a file changed in two worktrees; the workers are told too), means: serialize those workers, or expect a conflict at landing. A conflict of a worker that is no longer running: resume_worker it, or launch a worker to merge its branch into its own and resolve the conflicts. `undo_landing` reverts a landing with a new commit. A closed or exited worker\'s worktree goes once landed and clean; call `end_run` to finish the run: it removes what can go, says what is kept and why, and keeps every worker\'s record, folder and conversation. A worker stays resumable after end_run (resume_worker adds its worktree back at the same path, on its branch or a new one from its base), and launch_cli or resume_worker reopens an ended run.'
    : 'Workers share one working directory. Give them disjoint files and say so in each brief; never let two running workers touch the same file. Project-wide finishing steps the instructions above this card ask for (a check that rewrites shared files, a docs update) go to one final worker once the others are done.';
  return [
    `# Role: orchestrator — orchestration run ${run.runId}`,
    '',
    `You are the ORCHESTRATOR of a multi-session run. Your cross-session address is \`${run.orchestrator}\`. You coordinate; workers do the work. These instructions stay in force for the whole session, including after any compaction.`,
    '',
    'Rules',
    `1. Never write or edit code or project files yourself. The only files you write are your TODO.md and NOTES.md in ${dir} (edits elsewhere are blocked). Reading, searching and read-only commands to plan are fine.`,
    `2. Every piece of work goes to a worker CLI launched with the \`launch_cli\` tool (mcp__orchestrator__launch_cli). At most ${MAX_WORKERS} workers run at once: a launch beyond that is queued and starts when a slot frees (\`after: [worker]\` holds it until those workers have landed), and a finished, landed, clean idle worker may be closed automatically to make room for it. A follow-up for a running worker goes to it with SendMessage — never relaunch it. A trivial, mechanical job goes to a cheap worker: model sonnet or haiku, isolation none.`,
    '3. A brief must be self-contained: the goal, the files or areas involved, acceptance criteria (how the worker proves it is done), constraints, and what is already ruled out. The worker knows only what you write. Prefer ordering work with `after` to workers waiting on each other. When workers must talk, write their briefs together and check them as a pair: every message one side waits for, the other side is told to send on every outcome (success and failure). The waiting side reports blocked while it waits; silence is yours to handle.',
    `4. For a non-trivial request, write the plan as TODO rows and confirm it with the user (AskUserQuestion) before fanning out to several workers. Keep ${todo} current: update it after every launch, report and event. One row per task in its table (id | description | depends on | status): name the worker in the description; status is queued|running|blocked|done|failed followed by the last report in a few words. It is your memory — after a compaction or resume, read it and NOTES.md first.`,
    '5. Workers report with the `report` tool and SendMessage. Worker events (report, exited, idle: a turn ended without a done, failed, blocked or paused report) arrive in your context automatically, marked "[orchestration]". "started" and progress reports and overlaps do not wake you: they come with the next delivery. Act on each one and update the TODO. On a done or failed report, check the workers that wait on or talk to that worker. One that is idle without a done, failed or blocked report since then is stalled: read its NOTES.md and message it with what to do. That is not a status request under rule 10.',
    `6. \`list_workers\` shows every worker's state. ${isolation}`,
    `7. You may run at most ${MAX_SUBAGENTS} subagents at once, for reading only (e.g. Explore). Never use a subagent to edit code.`,
    '8. A worker\'s "done" report is trusted: do not re-run its checks, re-read its diff or launch a reviewer worker. Act on "failed" and "blocked"; launch a review only when the user asks for one. Tell the user what each worker reported and what is open.',
    '9. Where the instructions above this card tell the session to edit files, run project checks or update docs, that is workers\' work: put it in a brief, never do it yourself.',
    '10. To see how a worker is doing, read its TODO.md and NOTES.md (`list_workers` gives the paths, its current item and recent actions). Never message a worker just to ask for its status.',
    '11. A paused worker is resumed with `resume_worker` ("continue" keeps its own context; "fresh" starts a clean session from its brief and notes). Never relaunch a paused worker\'s task with launch_cli.',
    '12. Unrelated new work goes to a new worker. Close a finished worker you will not reuse with `close_worker` (it stays listed and resumable with resume_worker, also after end_run); reuse a worker by SendMessage only for a follow-up in the area it just worked on.',
    '13. A worker going the wrong way: `stop_worker` ends its current turn and leaves it idle; then SendMessage it new instructions, or close_worker it.',
    '14. The owner\'s "your turn" checklist (actions only the owner can do, decisions waiting on the owner) fills from the workers\' reports; keep it right with `owner_items` (list, add, resolve, drop, reorder): merge duplicates, close what is stale, and tell the owner what waits. The owner\'s answers arrive as "owner" events.',
    ...(remote ? [remote] : []),
  ].join('\n');
}

function workerCard(run, worker) {
  const where = worker.branch
    ? `You work in a git worktree at ${worker.cwd} on branch \`${worker.branch}\`. Commit your work on this branch before you report "done" (links the server made to the main checkout's dependencies are not yours to commit); your done report lands it: the server rebases it onto \`${worker.base || 'its base'}\`, runs the repo's check and merges it. If something stops the landing, a "[vistaclair landing]" message (or the report's answer) says what to fix: fix it, commit, and report done again.${worker.worktree?.gap ? ` ${landing.gapSentence(worker.worktree.gap)}` : ''}`
    : `Your working directory is ${worker.cwd}. Other workers share it: touch only the files your brief names.`;
  return [
    `# Role: worker \`${worker.name}\` — orchestration run ${run.runId}`,
    '',
    `You are a WORKER CLI launched by the orchestrator \`${run.orchestrator}\`. Your own cross-session address is \`${worker.name}\`. Your task is the first user message. These instructions stay in force for the whole session, including after any compaction.`,
    '',
    'Rules',
    `1. Report to the orchestrator with the \`report\` tool (mcp__orchestrator__report): status "started" when you begin, "blocked" when you need a decision or wait on someone (a question goes by SendMessage to \`${run.orchestrator}\`), "done" or "failed" when finished, "paused" when a pause is complete — with summary, filesChanged, verified (the one check you ran) and open. A turn ends only after a done, failed, blocked or paused report in that turn, or a message to the orchestrator. Never end a turn waiting on someone: report "blocked" naming whom you wait for and what. Their message starts your next turn. The steps of your brief are the rows of your TODO.md (short descriptions, detail in NOTES.md); your orchestrator reads it to follow your progress.`,
    `2. You may delegate through subagents, at most ${MAX_SUBAGENTS} running at once: \`coder\` (Opus) for a substantial piece of code, \`explorer\` (Sonnet, read-only; use it rather than the built-in Explore) for a search across many files. Make small edits and single lookups yourself — a subagent's overhead costs more. A subagent's summary is trusted: do not repeat its checks.`,
    '3. Stay within your brief. If the scope has to grow, ask the orchestrator instead of widening it yourself.',
    `4. Messages from \`${run.orchestrator}\` are follow-up instructions: act on them and report.${run.mirror ? ` Your orchestrator runs on another machine (${run.mirror.host}): your reports and your messages to it reach it there.` : ''}`,
    `5. ${where}`,
    `6. Where the instructions above this card tell the session to ask the user, ask \`${run.orchestrator}\` instead (SendMessage, report "blocked"). Project-wide finishing steps they ask for (a check that rewrites shared files, a docs update) are yours only when your brief assigns them; otherwise list what they need in your "done" report. Anything only the owner can do (Stop→Start, Build, Make live, Rebuild client, an approval) or decide goes into report's \`ownerItems\` ({ what, why, kind: "action" | "decision", options, recommended }), never only in prose: it lands on the owner's "your turn" checklist, and you are told when the owner has done or decided it.`,
    `7. A shared machine resource (GPU, a memory-heavy job) is taken with a lock, not by message: run the command as \`node ${path.join(__dirname, '..', 'bin', 'vistaclair-lock.js')} <name> -- <cmd>\` (\`-s\` for a shared hold; names are [a-z0-9._-]; it waits its turn and releases when the command exits).`,
  ].join('\n');
}

function createOrchestration({ mgr, broadcaster, pendingQuestions, coreRoot, dataHome, control = null, credentials = null, models = null, fallbackEngine = null, pushDebounceMs = PUSH_DEBOUNCE_MS, relayFallbackMs = RELAY_FALLBACK_MS, overlapCheckMs = OVERLAP_CHECK_MS, quietValveMs = QUIET_VALVE_MS }) {
  // Which Claude credentials exist: { apiKey, subscription }. Read per ask.
  const claudeCredentials = credentials || (() => require('./capabilities').claudeCredentials(dataHome));
  // The engine of a new session nobody named one for: 'sdk' | 'terminal'
  // (capabilities.getFallbackEnginePref). Read per open.
  const newSessionEngine = fallbackEngine || (() => require('./capabilities').getFallbackEnginePref(dataHome));
  // The model catalog with availability (capabilities.listModelsWithAvailability).
  const modelCatalog = models || (() => require('./capabilities').listModelsWithAvailability(dataHome));
  const HOOK_SCRIPT = path.join(coreRoot, 'lib', 'orchestration-hook.js');
  const runDirs = new Map();       // runId -> runDir (rebuilt from stamps on miss)
  const volatile = new Map();      // session name -> { agents, reported, nudged, stopping }
  const pushTimers = new Map();    // runId -> timeout
  const pendingAsks = new Map();   // dedupe key -> Promise
  const relayTimers = new Map();   // worker name -> pause fallback timeout
  const valveTimers = new Map();   // runId -> quiet-event safety valve timeout (run.quietValve is the state)
  // This server process: a worker started in it carries it (w.boot), so one
  // from an earlier process that has not come back still holds its slot.
  const BOOT = crypto.randomBytes(4).toString('hex');
  let askSeq = 0;
  // Remote workers (registerHostProvider): the one provider, the launches
  // waiting for it in this process (`${runId}/${workerId}`), and the remote
  // members' tabs (tabId -> { runId, workerId }) for their exit.
  let hostProvider = null;
  const remoteLaunches = new Set();
  const remoteTabs = new Map();
  // Mirror runs (openMirrorRun): runId -> the add-on's deliver(msg), set at
  // every open (the index on disk maps key -> run).
  const mirrorDeliver = new Map();

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

  const ENGINE_LABELS = { cli: 'CLI terminal', sdk: 'Agent SDK panel' };
  const AUTH_LABELS = { apikey: 'API key', subscription: 'Claude subscription' };
  // The orchestrator's own model, picked in the New CLI dialog. Workers get
  // theirs from the orchestrator's launch_cli calls.
  const ORCHESTRATOR_MODELS = [
    { value: 'opus[1m]', label: 'Opus', detail: '1M context' },
    { value: 'fable[1m]', label: 'Fable', detail: '1M context' },
  ];
  const MODEL_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];

  // The models a session's model family can be routed to (the proxy's tab
  // modelMap): usable, not retired. Only what the dialog shows, never a key.
  function remapTargets() {
    let list = [];
    try { list = modelCatalog() || []; } catch { list = []; }
    let providers = {};
    try {
      for (const p of require('./capabilities').listProviders(dataHome) || []) providers[p.key] = p.label;
    } catch { providers = {}; }
    return list
      .filter(m => m && m.name && m.usable && (m.lifecycle || 'current') !== 'retired')
      .map(m => ({
        name: m.name,
        label: m.label || m.name,
        providerKey: m.providerKey || null,
        providerLabel: providers[m.providerKey] || m.providerKey || null,
        contextWindow: Number(m.contextWindow) || null,
        inputCostPerMTok: typeof m.inputCostPerMTok === 'number' ? m.inputCostPerMTok : null,
        outputCostPerMTok: typeof m.outputCostPerMTok === 'number' ? m.outputCostPerMTok : null,
        lifecycle: m.lifecycle || 'current',
        retiresAt: m.retiresAt || null,
        isNew: !!m.isNew,
      }));
  }

  // A dialog's modelMap answer (an object, or its JSON) to a full tab modelMap,
  // or null when nothing is routed. Unknown families and targets that are not
  // usable now are dropped.
  function parseModelMap(value, targets) {
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const usable = new Set(targets.map(t => t.name));
    const map = {};
    let any = false;
    for (const family of MODEL_FAMILIES) {
      const target = typeof value[family] === 'string' && usable.has(value[family]) ? value[family] : null;
      map[family] = target;
      if (target) any = true;
    }
    return any ? map : null;
  }

  // Ask what is still open — the session type (a terminal's only: openCli
  // makes an SDK session an orchestrator), an SDK session's billing — in one
  // form. The engine is decided before (openCli), never asked. Billing is a
  // question only when both credentials exist; with one, the form names it and
  // the session is pinned to it. The form defaults to an orchestrator, on the
  // subscription.
  // formData.kind 'new-cli' (with formData.newCli) lets the dashboard draw its
  // own dialog, which also asks the orchestrator's model and an optional
  // routing of model families for the whole session or run; the questions are
  // the generic form's fallback.
  // Resolves { mode, engine, auth, model, modelMap } (the asked ones filled in;
  // auth null for a CLI terminal; model only for an orchestrator), or null
  // when cancelled.
  async function askMode({ cwd, title, mode = null, engine, auth = null }) {
    const questions = [];
    let description = null;
    let onlyAuth = null;
    let billing = '';
    let authQuestion = null;
    const creds = claudeCredentials() || {};
    if (!auth && engine !== 'cli') {
      if (creds.apiKey && creds.subscription) {
        authQuestion = {
          id: 'auth', type: 'select', header: 'Billing',
          question: 'Bill the Agent SDK session to the API key or to your Claude subscription?',
          defaultValue: AUTH_LABELS.subscription,
          options: [
            { label: AUTH_LABELS.apikey, description: 'Per token, to the Anthropic API key on the Models page.' },
            { label: AUTH_LABELS.subscription, description: 'Your Claude Max/Pro plan, as a CLI terminal is.' },
          ],
        };
      } else {
        onlyAuth = creds.apiKey ? 'apikey' : creds.subscription ? 'subscription' : null;
        billing = onlyAuth
          ? `billed to the ${onlyAuth === 'apikey' ? 'Anthropic API key' : 'Claude subscription'} (the only Claude credential configured)`
          : 'needs a Claude credential: none is configured (an API key on the Models page, or Sign in to Claude in the dashboard header)';
        description = `Agent SDK panel, ${billing}.`;
      }
    }
    if (!mode) {
      questions.push({
        id: 'mode', type: 'select', header: 'Session type',
        question: 'Open a simple CLI, or an orchestrator that delegates the work to worker CLIs?',
        defaultValue: 'Orchestrator CLI',
        options: [
          { label: 'Simple CLI', description: 'One Claude Code session, as usual.' },
          { label: 'Orchestrator CLI', description: `Plans and delegates to up to ${MAX_WORKERS} worker CLIs, tracks them in a TODO, never codes itself.` },
        ],
      });
    }
    if (authQuestion) questions.push(authQuestion);
    // Nothing to ask: the mode was given, a terminal or one credential.
    if (!questions.length) return { mode, engine, auth: auth || onlyAuth, model: null, modelMap: null };
    const targets = remapTargets();
    let defaultModel = 'opus';
    try { defaultModel = require('./capabilities').getCliModelPref(dataHome) || 'opus'; } catch { /* the fallback */ }
    const newCli = {
      given: { mode, engine, auth },
      credentials: { apiKey: !!creds.apiKey, subscription: !!creds.subscription },
      onlyAuth,
      maxWorkers: MAX_WORKERS,
      defaultModel,
      orchestratorModels: ORCHESTRATOR_MODELS.map(m => ({ ...m, available: !!(creds.apiKey || creds.subscription) || engine === 'cli' })),
      orchestratorModel: ORCHESTRATOR_MODELS[0].value,
      families: MODEL_FAMILIES,
      remapTargets: targets,
      labels: { engine: ENGINE_LABELS, auth: AUTH_LABELS, mode: { simple: 'Simple CLI', orchestrator: 'Orchestrator CLI' } },
    };
    let answer;
    try {
      answer = await askUser({
        formData: { kind: 'new-cli', newCli, title: 'New CLI', submitLabel: 'Open', cancelLabel: 'Cancel', ...(description ? { description } : {}) },
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
    if (engine === 'sdk' && !auth) {
      // Unanswered falls back to the form's default, the subscription.
      if (!authQuestion) auth = onlyAuth;
      else auth = /api key/i.test(String(answer.find(a => a?.id === 'auth')?.answer || '')) ? 'apikey' : 'subscription';
    }
    // Only an offered orchestrator model counts; unanswered keeps the default
    // pin (the global CLI model).
    const picked = String(answer.find(a => a?.id === 'model')?.answer || '');
    const model = mode === 'orchestrator' && ORCHESTRATOR_MODELS.some(m => m.value === picked) ? picked : null;
    const modelMap = parseModelMap(answer.find(a => a?.id === 'modelMap')?.answer, targets);
    return { mode, engine, auth: engine === 'sdk' ? auth : null, model, modelMap };
  }

  // --- Runs ---

  function runFile(runDir) { return path.join(runDir, 'run.json'); }

  function loadRun(runDir) {
    const run = readJsonOr(runFile(runDir), null);
    if (run) runDirs.set(run.runId, runDir);
    if (run?.workers?.some(w => w.landing)) recoverLandings(run);
    if (run?.workers?.some(w => lostLaunch(run, w))) recoverRemote(run);
    // After a restart the valve's timer is gone; its due time is in run.json.
    if (run?.quietValve && !run.quietValve.fired) armValve(run);
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
    // A mirror run without members yet.
    const m = Object.values(readJsonOr(mirrorIndexFile(), {})).find(x => x?.runId === runId);
    if (m?.runDir && fs.existsSync(runFile(m.runDir))) { runDirs.set(runId, m.runDir); return m.runDir; }
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
  function prepareRun({ cwd, runsDir, isolation, maxBudgetUsd, engine, auth, settings = {} }) {
    const root = realpathOr(cwd);
    const runId = crypto.randomBytes(3).toString('hex');
    const dir = realpathOr(runsDir || path.join(root, '.orchestrator'));
    const runDir = path.join(dir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    excludeFromGit(dir);

    // sessionDir is per session, never inherited; sessionsRoot (the caller's
    // choice of where folders live) is, through the stamps.
    const { appendSystemPrompt, settingsFile, name: _n, orchestration: _o, model: _m, sessionDir: _d, engine: _e, auth: _a, ...stamps } = settings;
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
      auth: null,
      // The orchestrator's model, for a refresh or a fresh start (orchestratorSettings).
      orchestratorModel: settings.model || null,
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
    if (run.engine === 'sdk') run.auth = auth || settings.auth || null;
    folders.ensureFolder(run.orchestratorDir, `Orchestration run ${runId}`);
    saveRun(run);
    runDirs.set(runId, runDir);

    const card = orchestratorCard(run, { hosts: hostList() });
    return {
      ...settings,
      engine: run.engine,
      ...authOf(run),
      name: run.orchestrator,
      sessionDir: run.orchestratorDir,
      orchestration: { runId, role: 'orchestrator', runDir },
      appendSystemPrompt: appendSystemPrompt ? `${appendSystemPrompt}\n\n${card}` : card,
      settingsFile: writeSessionSettings(run, run.orchestrator, settingsFile),
    };
  }

  // A run's billing as launch settings: an SDK run's members carry it.
  function authOf(run) {
    return run.engine === 'sdk' && run.auth ? { auth: run.auth } : {};
  }

  // --- openCli: the one user-facing "new CLI" entry ---

  async function openCli(opts = {}) {
    let mode = opts.mode === 'simple' || opts.mode === 'orchestrator' ? opts.mode : null;
    // Unnamed, the engine is the Agent SDK panel unless the fallback pref says
    // terminal; a caller (a resume, Pro) may still name either.
    const given = opts.engine || opts.settings?.engine;
    const engine = given === 'cli' || given === 'sdk' ? given : newSessionEngine() === 'terminal' ? 'cli' : 'sdk';
    const givenAuth = opts.auth || opts.settings?.auth;
    let auth = givenAuth === 'apikey' || givenAuth === 'subscription' ? givenAuth : null;
    let model = null;
    let modelMap = null;
    // An Agent SDK session is an orchestrator: only a terminal asks Simple /
    // Orchestrator. That holds for a caller asking a resume too (Pro's app
    // Change): the role starts a fresh transcript, so the resume is dropped;
    // an explicit 'simple' keeps it.
    if (!mode && engine === 'sdk') mode = 'orchestrator';
    if (!mode || (engine === 'sdk' && !auth)) {
      // One pending question per target: a double click joins the open ask.
      const key = opts.tabId || `cwd:${opts.cwd}`;
      if (!pendingAsks.has(key)) {
        pendingAsks.set(key, askMode({ cwd: opts.cwd, title: opts.title, mode, engine, auth }).finally(() => pendingAsks.delete(key)));
      } else {
        return { cancelled: true, duplicate: true };
      }
      const picked = await pendingAsks.get(key);
      if (!picked) return { cancelled: true };
      ({ mode, auth } = picked);
      model = picked.model || null;
      modelMap = picked.modelMap || null;
    }
    if (engine !== 'sdk') auth = null;
    const tabId = opts.tabId || mgr.nextTabId();
    const { auth: _a, ...callerSettings } = opts.settings || {};
    // The dialog's picks: the routing covers the session, and a run's members
    // through the stamps; the model is the orchestrator's alone (prepareRun
    // keeps it off the stamps, on the run).
    if (modelMap) callerSettings.modelMap = modelMap;
    if (model) callerSettings.model = model;
    const launch = {
      cwd: opts.cwd, cols: opts.cols, rows: opts.rows, title: opts.title,
      settings: { ...callerSettings, engine, ...(auth ? { auth } : {}) }, hidden: opts.hidden, autoMemory: opts.autoMemory,
      prompt: opts.prompt, autoSubmit: opts.autoSubmit, spawnOpts: opts.spawnOpts,
      // A simple session's own git worktree (src/cli-isolation.js); an
      // orchestrator's isolation is its run's (prepareRun).
      ...(mode !== 'orchestrator' && opts.isolation === 'worktree' ? { isolation: 'worktree', landOnClose: opts.landOnClose === true } : {}),
    };
    if (mode === 'orchestrator') {
      launch.settings = prepareRun({
        cwd: opts.cwd, runsDir: opts.runsDir, isolation: opts.isolation,
        maxBudgetUsd: opts.maxBudgetUsd, engine, auth, settings: callerSettings,
      });
      launch.spawnOpts = {};   // a fresh transcript: never resume a plain session into the role
      launch.hidden = false;
    }
    if (opts.beforeLaunch) opts.beforeLaunch(tabId);
    mgr.launchSession(tabId, launch);
    return { tabId, mode, engine, auth, ...(model ? { model } : {}), ...(modelMap ? { modelMap } : {}) };
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

  // A full run names the running workers that are finished, so the
  // orchestrator closes one rather than pushing unrelated work into it.
  function assertCapacity(run) {
    const running = [...runningWorkers(run), ...run.workers.filter(w => w.remote && remoteHoldsSlot(run, w))];
    if (running.length >= MAX_WORKERS) {
      const available = running.filter(w => workerAvailable(run, w));
      const hint = available.length
        ? `Finished and idle, available to close: ${available.map(w => `${w.name} (last report: ${w.lastReport.status})`).join(', ')}. Close one you will not reuse with close_worker, or send a follow-up with SendMessage to one that worked on the same area.`
        : 'None of them is finished: send a follow-up with SendMessage to one that works on the same area, or wait for a report or an exit event.';
      throw new Error(`${MAX_WORKERS} workers are running (${running.map(w => w.name).join(', ')}). ${hint}`);
    }
  }

  // launch_cli: a worker starts at once when a slot is free, its `after`
  // workers are finished and no ready queued launch is ahead of it; else it is
  // queued in run.json (pumpQueue starts it), and the result says so.
  function launchWorker(instanceId, args = {}) {
    const { run } = callerRun(instanceId, 'orchestrator');
    if (run.pausing) throw new Error('this run is being paused: launch nothing new');
    if (!args.task || !String(args.task).trim()) throw new Error('task is required');
    if (args.model && !WORKER_MODELS.includes(args.model)) throw new Error(`model must be one of ${WORKER_MODELS.join(', ')}`);
    const paused = run.workers.filter(w => w.paused);
    if (paused.length) {
      throw new Error(`paused workers must be resumed (resume_worker) before new ones are launched: ${paused.map(w => w.name).join(', ')}`);
    }
    const spec = launchSpec(run, args);
    const queue = run.queue || [];
    if (freeSlots(run) > 0 && depsMet(run, spec) && !queue.some(e => depsMet(run, e))) return startWorker(run, spec);
    checkQueued(run, spec);
    const entry = { id: `q${(run.queueSeq = (run.queueSeq || 0) + 1)}`, ...spec, at: new Date().toISOString() };
    run.queue = [...queue, entry];
    run.closed = false;    // an ended run is reopened by new work
    saveRun(run);
    const mine = pumpQueue(run.runDir, { silent: entry.id }).find(s => s.entry.id === entry.id);
    if (mine?.error) throw mine.error;
    if (mine) {
      return {
        ...mine.result,
        ...(mine.autoClosed ? { autoClosed: mine.autoClosed, closeNote: `the run was full: ${mine.autoClosed} (idle, done, landed, clean) was closed to free its slot; resume_worker brings it back` } : {}),
      };
    }
    const fresh = loadRun(run.runDir);
    const q = queueList(fresh).find(e => e.id === entry.id);
    if (!q) return { queued: false, id: entry.id, note: 'it was not started: see the run events' };
    const available = runningWorkers(fresh).filter(w => workerAvailable(fresh, w));
    return {
      queued: true, id: q.id, position: q.position, waitingFor: q.waitingFor,
      note: `queued: it starts when ${q.waitingFor.join(' and ')}. cancel_launch({ id: "${q.id}" }) drops it.${available.length && q.waitingFor.includes('a free slot') ? ` Finished and idle, available to close: ${available.map(w => `${w.name} (last report: ${w.lastReport.status})`).join(', ')}.` : ''}`,
    };
  }

  // A launch's checked parameters, as a queue entry keeps them (cwd resolved,
  // `after` as worker ids). Throws, having changed nothing.
  function launchSpec(run, { title, task, cwd, isolation, model, tools, area, after, host, app } = {}) {
    if (host !== undefined && host !== null && host !== '') return remoteSpec(run, { title, task, host, app, cwd, isolation, area, tools, model, after });
    if (app !== undefined && app !== null && app !== '') throw new Error('app is for a remote worker (with host)');
    const target = realpathOr(cwd ? path.resolve(run.root, cwd) : run.root);
    if (!isInside(target, run.root)) throw new Error(`cwd must be inside the run root ${run.root}`);
    const spec = {
      title: title || '', task: String(task), cwd: target, isolation: isolation || run.isolation,
      ...(model ? { model } : {}), ...(tools !== undefined ? { tools } : {}),
    };
    const areas = areaOf(area);
    if (areas) spec.area = areas;
    const deps = afterOf(run, after);
    if (deps.length) spec.after = deps;
    if (spec.isolation === 'worktree' && !gitToplevel(target)) throw new Error(`isolation "worktree" needs a git repository; ${target} is not in one`);
    grantsOf(tools);
    return spec;
  }

  // A queued launch's tool packs are asked before it is queued, as the
  // worker it would be now (startWorker asks again when it starts).
  function checkQueued(run, spec) {
    if (spec.host) return;   // no tool packs: startRemote checks its host again
    const id = `w${run.workerSeq + 1}`;
    const grants = grantsOf(spec.tools);
    const probe = { id, name: `${run.orchestrator}-${id}-${slugify(spec.title)}`, title: spec.title || id, task: spec.task, cwd: spec.cwd, branch: null, worktree: null, ...(grants ? { grants } : {}), ...(spec.model ? { model: spec.model } : {}) };
    checkPacks(run, probe, { toolsGiven: spec.tools !== undefined });
  }

  // launch_cli `after`: addresses or ids of workers of this run, as ids.
  function afterOf(run, after) {
    if (after === undefined || after === null) return [];
    const list = Array.isArray(after) ? after : [after];
    if (list.some(a => typeof a !== 'string' || !a.trim())) throw new Error('after must be a list of worker addresses or ids');
    return [...new Set(list.map((a) => {
      const want = a.trim().replace(/\s+\[[^\]]*\]$/, '');
      const w = run.workers.find(x => x.name === want || x.id === want);
      if (w) return w.id;
      const other = /^orch-([0-9a-f]{6})-/.exec(want);
      if (other && other[1] !== run.runId) throw new Error(`after: ${want} is a worker of run ${other[1]}, not of this run (${run.runId})`);
      throw new Error(`after: no worker ${want} in this run`);
    }))];
  }

  // Start a worker from a checked launch (launchSpec). Persists it before the spawn.
  function startWorker(run, spec) {
    if (spec.host) return startRemote(run, spec);
    const { title, task, cwd: target, isolation: mode, model, tools, area } = spec;
    const id = `w${++run.workerSeq}`;
    const name = `${run.orchestrator}-${id}-${slugify(title)}`;
    const worker = {
      id, name, title: title || id, task: String(task), cwd: target, branch: null, worktree: null,
      sessionDir: path.join(run.sessionsRoot || path.join(dataHome, 'data', 'sessions'), name),
      launchedAt: new Date().toISOString(), exitedAt: null, lastReport: null, boot: BOOT,
      ...(model ? { model } : {}),
    };
    const grants = grantsOf(tools);
    if (grants) worker.grants = grants;
    if (area) worker.area = area;
    checkPacks(run, worker, { toolsGiven: tools !== undefined });

    if (mode === 'worktree') {
      const top = gitToplevel(target);
      if (!top) throw new Error(`isolation "worktree" needs a git repository; ${target} is not in one`);
      const branch = `orch/${run.runId}/${id}`;
      const wt = path.join(dataHome, 'data', 'worktrees', run.runId, id);
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      git(top, ['worktree', 'add', '-b', branch, wt, 'HEAD']);
      worker.branch = branch;
      // The branch its landings merge into: the main checkout's at launch.
      worker.base = landing.currentBranch(top);
      worker.worktree = { path: wt, repo: top, ...linksOf(top, wt, target) };
      worker.cwd = path.join(wt, path.relative(top, target));
    }

    const overlaps = areaOverlaps(run, worker);
    run.workers.push(worker);
    run.closed = false;    // an ended run is reopened by new work
    saveRun(run);
    const tabId = spawnWorker(run, worker, worker.task);
    return {
      worker: name, tabId, cwd: worker.cwd, branch: worker.branch, folder: worker.sessionDir, model: mgr.sessions.get(tabId)?.getSettings().model || null,
      ...(overlaps.length ? {
        overlaps,
        note: `its area overlaps running workers' areas (${overlaps.map(o => `${o.worker}: ${o.paths.join(', ')}`).join('; ')}). It was launched: serialize them, or expect a conflict when the later one lands.`,
      } : {}),
    };
  }

  // --- Remote workers (ctx.orchestration.registerHostProvider) ---
  //
  // An add-on (Pro's peer-remote-host.js) provides other machines a worker can
  // run on. launch_cli({ host }) records the member like a local worker (w.host,
  // w.app, w.remote) in state pending-approval and calls provider.launch, which
  // resolves { tabId } of a registerExternalSession tab once the owner approved
  // the launch, or rejects with a .code (REMOTE_CODES). The outcome is a
  // "remote" event. The member's reports and messages come back through the
  // handle's deliver(); SendMessage goes to its tab's adapter.submit(text,
  // { from }); close_worker / end_run / deleteRun call provider.kill. It has no
  // worktree, folder or saved session here: nothing lands, a pause does not
  // reach it, resume_worker refuses it. Its record survives a restart; the
  // provider re-adopts its tab (rebound by tabId or by the tab's stamp).

  const REMOTE_CODES = new Set(['declined', 'refused', 'unavailable', 'invalid', 'failed', 'cancelled']);
  const REMOTE_STATUSES = new Set(['started', 'update', 'done', 'failed', 'blocked', 'paused']);
  const APP_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
  // The run's own app, when its stamps name one (Pro's change / workspace sessions).
  const RUN_APP_STAMPS = ['changeApp', 'workspaceApp'];
  const remoteKey = (run, w) => `${run.runId}/${w.id}`;

  // One provider at a time: a second registration replaces the first, whose
  // handle goes inert (deliver → false, unregister a no-op).
  function registerHostProvider(provider) {
    if (!provider || typeof provider.hosts !== 'function' || typeof provider.launch !== 'function' || typeof provider.kill !== 'function') {
      throw new Error('registerHostProvider needs { hosts, launch, kill } functions');
    }
    const entry = { hosts: provider.hosts, launch: provider.launch, kill: provider.kill };
    hostProvider = entry;
    return Object.freeze({
      deliver: (msg) => (hostProvider === entry ? deliverRemote(msg) : false),
      unregister: () => { if (hostProvider === entry) hostProvider = null; },
    });
  }

  // The provider's hosts, cleaned: [{ name, label, available, reason? }]; [] without one.
  function hostList() {
    if (!hostProvider) return [];
    let list;
    try { list = hostProvider.hosts(); } catch (e) { console.error('[orchestration] hosts():', e.message); return []; }
    if (!Array.isArray(list)) return [];
    return list.filter(h => h && typeof h.name === 'string' && h.name).slice(0, 50).map(h => ({
      name: h.name.slice(0, 100),
      label: typeof h.label === 'string' && h.label ? h.label.slice(0, 200) : h.name.slice(0, 100),
      available: h.available === true,
      ...(h.available !== true && h.reason ? { reason: clip(h.reason, 300) } : {}),
    }));
  }

  // `host` checked against hosts(): the host, or a throw naming the choices.
  function checkHost(host) {
    if (!hostProvider) throw new Error('remote workers need Pro\'s host provider: none is registered, so launch_cli takes no host');
    if (typeof host !== 'string' || !host.trim()) throw new Error('host must be a host name');
    const list = hostList();
    const h = list.find(x => x.name === host.trim());
    const names = list.length ? list.map(x => `${x.name}${x.available ? '' : ` (unavailable: ${x.reason || 'no reason given'})`}`).join(', ') : 'none';
    if (!h) throw new Error(`no host "${host}". Hosts: ${names}`);
    if (!h.available) throw new Error(`host "${h.name}" is unavailable: ${h.reason || 'no reason given'}`);
    return h;
  }

  function runApp(run) {
    const s = run.base?.stamps || {};
    return RUN_APP_STAMPS.map(k => s[k]).find(v => typeof v === 'string' && APP_RE.test(v)) || null;
  }

  // launch_cli with a host: the checked spec, or a throw having changed nothing.
  function remoteSpec(run, { title, task, host, app, cwd, isolation, area, tools, model, after }) {
    const h = checkHost(host);
    const no = (what, why) => { throw new Error(`${what}: ${why}; omit it for a remote worker`); };
    if (cwd !== undefined && cwd !== null && cwd !== '') no('cwd', 'a remote worker runs in its app\'s directory on its host');
    if (isolation !== undefined && isolation !== null && isolation !== 'none') no('isolation', 'a remote worker has no worktree on this machine');
    if (area !== undefined && area !== null) no('area', 'areas are compared between worktrees on this machine');
    if (tools !== undefined) no('tools', 'add-on tool grants are this machine\'s');
    const theApp = app === undefined || app === null || app === '' ? runApp(run) : String(app).trim();
    if (!theApp) throw new Error('app: name the app on the host this worker runs in (this run has none of its own)');
    if (!APP_RE.test(theApp)) throw new Error('app must be an app name ([a-z0-9-])');
    const spec = { title: title || '', task: String(task), host: h.name, app: theApp, ...(model ? { model } : {}) };
    const deps = afterOf(run, after);
    if (deps.length) spec.after = deps;
    return spec;
  }

  // Record the member and ask the provider. Returns at once; the outcome is an event.
  function startRemote(run, { title, task, host, app, model }) {
    checkHost(host);
    const id = `w${++run.workerSeq}`;
    const name = `${run.orchestrator}-${id}-${slugify(title)}`;
    const now = new Date().toISOString();
    const worker = {
      id, name, title: title || id, task: String(task), cwd: null, branch: null, worktree: null, sessionDir: null,
      host, app, remote: { state: 'pending-approval', since: now },
      launchedAt: now, exitedAt: null, lastReport: null, boot: BOOT,
      ...(model ? { model } : {}),
    };
    run.workers.push(worker);
    run.closed = false;
    saveRun(run);
    const key = remoteKey(run, worker);
    remoteLaunches.add(key);
    const provider = hostProvider;
    const args = {
      runId: run.runId, address: name, title: worker.title, task: worker.task, host, app,
      ...(model ? { model } : {}),
      ...(run.auth === 'apikey' ? { auth: 'apikey' } : {}),
      orchestrator: { address: run.orchestrator, title: orchestratorSession(run)?.session.title || '' },
    };
    let pending;
    try { pending = Promise.resolve(provider.launch(args)); } catch (e) { pending = Promise.reject(e); }
    const runDir = run.runDir;
    pending.then(
      (r) => remoteStarted(runDir, id, r, provider, key),
      (e) => remoteFailed(runDir, id, e, key),
    ).catch(e => console.error('[orchestration] remote launch:', e.message))
      .finally(() => remoteLaunches.delete(key));
    return {
      worker: name, host, app, state: 'pending-approval',
      note: `nothing runs on ${host} until the owner approves its card on the dashboard: a "remote" event says when it started or why not`,
    };
  }

  // `key`: its remoteLaunches entry, dropped once the run is loaded (a launch
  // loaded without one is a lost one: lostLaunch).
  function remoteStarted(runDir, workerId, r, provider, key) {
    const tabId = r && typeof r.tabId === 'string' && r.tabId ? r.tabId.slice(0, 100) : null;
    if (!tabId) return remoteFailed(runDir, workerId, Object.assign(new Error('the host provider named no tab'), { code: 'failed' }), key);
    const run = loadRun(runDir);
    remoteLaunches.delete(key);
    const w = run?.workers.find(x => x.id === workerId);
    if (!w) return;
    // Closed (close_worker, end_run) while the owner was deciding: stop it again.
    if (w.closed) { Promise.resolve().then(() => provider.kill({ runId: run.runId, address: w.name })).catch(() => {}); return; }
    w.remote = { state: 'started', tabId, since: w.remote?.since || null, startedAt: new Date().toISOString() };
    remoteTabs.set(tabId, { runId: run.runId, workerId });
    addEvent(run, { worker: w.name, kind: 'remote', quiet: true, text: `${w.name} started on ${w.host} (the owner approved it)` });
  }

  function remoteFailed(runDir, workerId, e, key) {
    const run = loadRun(runDir);
    remoteLaunches.delete(key);
    const w = run?.workers.find(x => x.id === workerId);
    if (!w) return;
    const code = REMOTE_CODES.has(e?.code) ? e.code : 'failed';
    const error = clip(String(e?.message || e || code), 500);
    const now = new Date().toISOString();
    w.remote = { state: 'failed', code, error, since: w.remote?.since || null, at: now };
    w.exitedAt = now;
    // Cancelled by the run itself (close_worker, end_run): recorded, not delivered.
    addEvent(run, { worker: w.name, kind: 'remote', delivered: code === 'cancelled' && !!w.closed, text: `${w.name}: the launch on ${w.host} came to ${code}: ${error}` });
    pumpQueue(runDir);   // its slot is free
  }

  // A launch left waiting by an earlier server process: nobody waits for it now.
  function lostLaunch(run, w) {
    return w.remote?.state === 'pending-approval' && !remoteLaunches.has(remoteKey(run, w));
  }

  function recoverRemote(run) {
    const now = new Date().toISOString();
    for (const w of run.workers) {
      if (!lostLaunch(run, w)) continue;
      w.remote = { state: 'failed', code: 'cancelled', error: 'the server restarted before the owner approved it: nothing was launched', since: w.remote.since || null, at: now };
      w.exitedAt = now;
      addEvent(run, { worker: w.name, kind: 'remote', text: `${w.name}: the launch on ${w.host} was lost: the server restarted before the owner approved it. Launch it again if it is still wanted` });
    }
  }

  // The member's tab: { tabId, session } (an ExternalSession), or null. By its
  // recorded tabId, else by the tab's stamp (a tab re-adopted after a restart).
  function remoteLive(run, w) {
    if (w.remote?.state !== 'started' || typeof mgr.getExternal !== 'function') return null;
    const ours = (s) => {
      const st = s?.getSettings?.() || {};
      return st.orchestration?.runId === run.runId && st.orchestration?.name === w.name && (!st.externalHost || st.externalHost === w.host);
    };
    const byId = mgr.getExternal(w.remote.tabId);
    if (byId && ours(byId)) return { tabId: w.remote.tabId, session: byId };
    const ext = mgr.external instanceof Map ? [...mgr.external.values()] : [];
    const s = ext.find(ours);
    if (!s) return null;
    remoteTabs.set(s.tabId, { runId: run.runId, workerId: w.id });
    return { tabId: s.tabId, session: s };
  }

  // A worker's live tab, local or remote: { tabId, session } or null.
  function liveOf(run, w) {
    return w.remote ? remoteLive(run, w) : workerSession(run, w.id);
  }

  // Holds one of the run's MAX_WORKERS slots: waiting for the owner in this
  // process, running, or started and not back since a restart.
  function remoteHoldsSlot(run, w) {
    if (w.closed || w.deleted) return false;
    if (w.remote.state === 'pending-approval') return remoteLaunches.has(remoteKey(run, w));
    if (w.remote.state !== 'started') return false;
    if (remoteLive(run, w)?.session.running) return true;
    return awaitingRestore(run, w);
  }

  // The panel's state word for a remote member.
  function remoteState(run, w, live) {
    const r = w.remote || {};
    if (r.state === 'pending-approval') return remoteLaunches.has(remoteKey(run, w)) ? 'pending-approval' : 'not started';
    if (r.state === 'failed') return w.closed ? 'closed' : `launch ${r.code || 'failed'}`;
    if (w.closed) return 'closed';   // its tab may still be closing on its host
    if (live?.session.running) return memberState(live.session, w);
    if (w.exitedAt && !w.shutdownAt) return 'exited';
    return 'disconnected';
  }

  function killRemote(run, w) {
    const provider = hostProvider;
    if (!provider) return false;
    Promise.resolve().then(() => provider.kill({ runId: run.runId, address: w.name }))
      .catch(e => console.error(`[orchestration] kill of ${w.name}:`, e?.message || e));
    return true;
  }

  // Close a remote member (close_worker, end_run): killed through the provider,
  // marked closed. The caller saves the run.
  function closeRemote(run, w) {
    const live = remoteLive(run, w);
    const now = new Date().toISOString();
    if (typeof live?.session.costUsd === 'number' && live.session.costUsd > 0) w.costUsd = live.session.costUsd;
    w.closed = true;
    w.closedAt = now;
    if (!w.exitedAt || w.shutdownAt) w.exitedAt = now;
    delete w.shutdownAt;
    delete w.turnStopped;
    return killRemote(run, w);
  }

  // The provider's deliver(): a remote member's report or message, into the run
  // as a local worker's report tool / SendMessage would. False when ignored.
  function deliverRemote(msg) {
    if (!msg || typeof msg !== 'object') return false;
    const run = typeof msg.runId === 'string' ? getRun(msg.runId) : null;
    const w = run?.workers.find(x => x.remote && x.name === msg.address);
    if (!w) return false;
    if (msg.kind === 'report') {
      if (!REMOTE_STATUSES.has(msg.status)) return false;
      w.lastReport = { status: msg.status, summary: clip(msg.summary, 32000), filesChanged: [], verified: '', open: '', at: new Date().toISOString() };
      delete w.turnStopped;
      addEvent(run, { worker: w.name, kind: 'report', text: reportParts(w).join(' — '), quiet: !WAKE_STATUSES.has(msg.status) });
      pumpQueue(run.runDir);   // a queued launch may wait on this worker
      return true;
    }
    if (msg.kind === 'message') {
      const text = String(msg.text ?? '').trim();
      if (!text) return false;
      const orch = orchestratorSession(run);
      if (orch?.session.running && !run.pausing) {
        deliver(orch.session, run.orchestrator, `[message from ${w.name}] ${clip(text, 32000)}`, w.name);
        emitTo(orch.session, run, { platform: { kind: 'message', from: w.name, to: run.orchestrator, text } });
      } else {
        // Not lost while the orchestrator is away: it comes with the events.
        addEvent(run, { worker: w.name, kind: 'message', text: `message from ${w.name}: ${clip(text, EVENT_ITEM_LIMIT - 200)}` });
      }
      return true;
    }
    return false;
  }

  // A remote member's tab exited (cli:exit), or one came back (cli:spawned,
  // re-adopted by the provider after a restart or a reconnect).
  function onRemoteBroadcast(m) {
    if (m?.type === 'cli:exit' && remoteTabs.has(m.tabId)) {
      const { runId, workerId } = remoteTabs.get(m.tabId);
      const run = getRun(runId);
      const w = run?.workers.find(x => x.id === workerId);
      if (!w || w.remote?.tabId !== m.tabId) return;
      if (w.exitedAt && !w.shutdownAt) return;
      w.exitedAt = new Date().toISOString();
      const live = mgr.getExternal?.(m.tabId);
      if (typeof live?.costUsd === 'number' && live.costUsd > 0) w.costUsd = live.costUsd;
      if (mgr._shuttingDown) { w.shutdownAt = w.exitedAt; saveRun(run); return; }
      delete w.shutdownAt;
      if (w.closed) { saveRun(run); return; }
      addEvent(run, { worker: w.name, kind: 'exited', text: `${w.name} exited on ${w.host}${w.lastReport ? ` (last report: ${w.lastReport.status})` : ' without reporting'}` });
      pumpQueue(run.runDir);
      return;
    }
    if (m?.type === 'cli:spawned' && m.external && typeof m.tabId === 'string') {
      const st = m.settings?.orchestration;
      if (!st?.runId || !st.name) return;
      const run = getRun(st.runId);
      const w = run?.workers.find(x => x.remote?.state === 'started' && x.name === st.name);
      if (!w || w.closed || (m.settings.externalHost && m.settings.externalHost !== w.host)) return;
      remoteTabs.set(m.tabId, { runId: run.runId, workerId: w.id });
      const back = mgr.getExternal?.(m.tabId)?.running === true && (w.shutdownAt || w.boot !== BOOT);
      if (w.remote.tabId === m.tabId && !back) return;
      w.remote.tabId = m.tabId;
      if (back) { w.exitedAt = null; delete w.shutdownAt; w.boot = BOOT; }
      saveRun(run);
    }
  }
  if (typeof broadcaster.onBroadcast === 'function') broadcaster.onBroadcast(onRemoteBroadcast);

  // --- Mirror runs (ctx.orchestration.openMirrorRun) ---
  //
  // The slave side of remote workers: a run whose orchestrator is an address
  // on another machine (run.orchestrator, run.mirror { key, host, closed }),
  // with no orchestrator session here. Keyed by the add-on's `key` in
  // <dataHome>/data/mirror-runs/index.json (key -> { runId, runDir }); the run
  // lives in <dataHome>/data/mirror-runs/<runId>/ and re-opening a key returns
  // it. Its members are ordinary SDK workers (launchWorker): their report and
  // their SendMessage to the orchestrator go to the add-on's deliver(); submit
  // / interrupt / kill act on one by its address. No worktree, queue or
  // landing; the dashboard cannot start, resume, refresh or pause an
  // orchestrator for it (assertNotMirror).

  const KEY_RE = /^[A-Za-z0-9._:-]{1,200}$/;
  const ADDRESS_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
  // Settings a member's caller may not set: the run decides them.
  const RESERVED = new Set(['name', 'orchestration', 'appendSystemPrompt', 'settingsFile', 'engine', 'auth', 'model', 'sessionDir', 'sessionsRoot', 'agents', 'grants', 'maxBudgetUsd', 'modelMap']);

  function mirrorDir() { return path.join(dataHome, 'data', 'mirror-runs'); }
  function mirrorIndexFile() { return path.join(mirrorDir(), 'index.json'); }

  function assertNotMirror(run) {
    if (run?.mirror) throw new Error(`run ${run.runId} is a mirror of the orchestrator ${run.orchestrator} on ${run.mirror.host}: it is run from there`);
  }

  // openMirrorRun({ key, orchestrator: { address, host }, deliver }) → the
  // run's handle. The same key returns the same run (after a restart too).
  function openMirrorRun({ key, orchestrator, deliver: fn } = {}) {
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw new Error('openMirrorRun: key must be 1-200 characters of [A-Za-z0-9._:-]');
    const address = orchestrator?.address;
    if (typeof address !== 'string' || !ADDRESS_RE.test(address)) throw new Error('openMirrorRun: orchestrator.address must be a session address');
    const host = typeof orchestrator?.host === 'string' && orchestrator.host.trim() ? clip(orchestrator.host.trim(), 100) : 'another machine';
    if (typeof fn !== 'function') throw new Error('openMirrorRun: deliver must be a function');
    const index = readJsonOr(mirrorIndexFile(), {});
    let run = index[key]?.runDir ? loadRun(index[key].runDir) : null;
    if (!run?.mirror || run.mirror.key !== key) run = null;
    if (!run) {
      const runId = crypto.randomBytes(3).toString('hex');
      const runDir = path.join(mirrorDir(), runId);
      fs.mkdirSync(runDir, { recursive: true });
      run = {
        runId, runDir, root: runDir, orchestrator: address,
        mirror: { key, host, closed: false },
        orchestratorDir: runDir, sessionsRoot: path.join(dataHome, 'data', 'sessions'),
        isolation: 'none', engine: 'sdk', auth: null, orchestratorModel: null, maxBudgetUsd: null,
        base: { appendSystemPrompt: '', settingsFile: null, stamps: {} },
        createdAt: new Date().toISOString(), request: null, closed: false, busy: false, pausing: null, paused: null,
        compactions: 0, workerSeq: 0, workers: [], events: [], delivered: 0,
      };
      index[key] = { runId, runDir };
      fs.mkdirSync(mirrorDir(), { recursive: true });
      writeJsonAtomic(mirrorIndexFile(), index);
    }
    run.orchestrator = address;
    run.mirror = { key, host, closed: false };
    run.closed = false;
    saveRun(run);
    runDirs.set(run.runId, run.runDir);
    mirrorDeliver.set(run.runId, fn);
    const runId = run.runId;
    let closed = false;
    const live = () => {
      if (closed) throw new Error('this mirror run is closed: open it again');
      const r = loadRun(run.runDir);
      if (!r) throw new Error(`mirror run ${runId} is gone`);
      return r;
    };
    const member = (r, addr) => {
      const w = r.workers.find(x => x.name === String(addr || ''));
      if (!w) throw new Error(`no member ${addr} in mirror run ${runId}`);
      return w;
    };
    return Object.freeze({
      runId,
      launchWorker: async (opts) => mirrorLaunch(live(), opts),
      submit: async (addr, text, { from } = {}) => {
        const r = live();
        const w = member(r, addr);
        const body = String(text ?? '').trim();
        if (!body) throw new Error('text is required');
        const sender = typeof from === 'string' && from.trim() ? clip(from.trim(), 120) : r.orchestrator;
        const ws = workerSession(r, w.id);
        if (!ws?.session.running) throw new Error(`${w.name} is not running`);
        const how = deliver(ws.session, w.name, `[message from ${sender}] ${body}`, sender);
        delete w.turnStopped;
        addFollowUp(r, w.id, body);
        emitTo(ws.session, r, { platform: { kind: 'message', from: sender, to: w.name, text: body } });
        return { delivered: true, how };
      },
      interrupt: async (addr) => {
        const r = live();
        const w = member(r, addr);
        const ws = workerSession(r, w.id);
        if (!ws?.session.running) throw new Error(`${w.name} is not running`);
        vol(w.name).stopping = true;
        if (typeof ws.session.interrupt === 'function') await ws.session.interrupt();
        else ws.session.write?.('\x1b');
        return { interrupted: true };
      },
      kill: async (addr) => {
        const r = live();
        const w = member(r, addr);
        const ws = workerSession(r, w.id);
        if (ws?.session.running) closeLive(r, w, ws);
        else if (!w.closed) { w.closed = true; w.closedAt = new Date().toISOString(); saveRun(r); }
        return { killed: true };
      },
      close: () => {
        if (closed) return;
        closed = true;
        const r = loadRun(run.runDir);
        if (mirrorDeliver.get(runId) === fn) mirrorDeliver.delete(runId);
        if (!r) return;
        for (const w of r.workers) {
          const ws = workerSession(r, w.id);
          if (ws?.session.running) closeLive(r, w, ws);
        }
        r.mirror = { ...r.mirror, closed: true };
        r.closed = true;
        saveRun(r);
      },
    });
  }

  // A member of a mirror run: { title, task, cwd, auth?, model?, settings? }
  // (settings: the caller's stamps, and sessionsRoot) → { tabId, address }.
  function mirrorLaunch(run, { title, task, cwd, auth, model, settings } = {}) {
    if (typeof task !== 'string' || !task.trim()) throw new Error('task is required');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('cwd must be an existing absolute directory');
    if (auth != null && auth !== 'apikey' && auth !== 'subscription') throw new Error('auth must be "apikey" or "subscription"');
    if (model != null && model !== '' && (typeof model !== 'string' || !MODEL_RE.test(model))) throw new Error('model is not a model name');
    if (freeSlots(run) <= 0) throw new Error(`${MAX_WORKERS} members of this run are running`);
    let stamps = {};
    try { stamps = settings && typeof settings === 'object' && !Array.isArray(settings) ? JSON.parse(JSON.stringify(settings)) : {}; } catch { stamps = {}; }
    const root = typeof stamps.sessionsRoot === 'string' && path.isAbsolute(stamps.sessionsRoot) ? stamps.sessionsRoot : run.sessionsRoot;
    for (const k of Object.keys(stamps)) if (RESERVED.has(k)) delete stamps[k];
    const id = `w${++run.workerSeq}`;
    const name = `${run.orchestrator}-${id}-${slugify(title)}`;
    const worker = {
      id, name, title: clip(title || id, 200), task, cwd: realpathOr(cwd), branch: null, worktree: null,
      sessionDir: path.join(root, name),
      launchedAt: new Date().toISOString(), exitedAt: null, lastReport: null, boot: BOOT,
      ...(model ? { model } : {}), ...(auth ? { auth } : {}),
      ...(Object.keys(stamps).length ? { stamps } : {}),
    };
    checkPacks(run, worker);
    run.workers.push(worker);
    run.closed = false;
    saveRun(run);
    const tabId = spawnWorker(run, worker, worker.task);
    return { tabId, address: name };
  }

  // A member's report / message to the mirror's orchestrator → the add-on's
  // deliver(). 'relayed', or why not (none registered since a restart).
  function relayMirror(run, msg) {
    const fn = mirrorDeliver.get(run.runId);
    if (!fn) {
      addEvent(run, { worker: msg.address, kind: 'mirror', text: `not relayed to ${run.orchestrator} (the run is not open): ${clip(msg.summary ?? msg.text, 300)}` });
      return 'not relayed: the run is not open';
    }
    try { fn(msg); } catch (e) { console.error(`[orchestration] mirror deliver (${run.runId}):`, e.message); return `not relayed: ${e.message}`; }
    return 'relayed';
  }

  // A local report as the one text the remote orchestrator gets.
  function mirrorSummary(w, owner) {
    const r = w.lastReport;
    return [
      r.summary,
      r.filesChanged?.length ? `files: ${r.filesChanged.join(', ')}` : '',
      r.verified ? `verified: ${r.verified}` : '',
      r.open ? `open: ${r.open}` : '',
      owner?.touched.length ? `for the owner: ${owner.touched.map(i => i.what).join('; ')}` : '',
    ].filter(Boolean).join('\n');
  }

  // --- Launch queue (run.queue) ---
  //
  // A launch that cannot start (the run full, its `after` workers not finished)
  // waits in run.queue. pumpQueue starts the ready ones, oldest first, when a
  // slot frees or a dependency lands — never while the run is pausing or
  // paused. A slot is held by a running worker, and by one that was running
  // when an earlier server process stopped and is not back yet (run members are
  // never reopened at boot: they come back by resume). An entry leaves run.json
  // before its worker is spawned, so it never starts twice.

  // A dependency is finished: a worktree worker's last report is done and its
  // landing came to landed or nothing; any other worker's last report is done.
  function depFinished(w) {
    if (!w || w.deleted || w.lastReport?.status !== 'done') return false;
    if (!w.branch) return true;
    const r = w.landingResult;
    return !!r && r.report === w.lastReport.at && (r.outcome === 'landed' || r.outcome === 'nothing');
  }

  function depsMet(run, entry) {
    return (entry.after || []).every(id => depFinished(run.workers.find(w => w.id === id)));
  }

  // Ran in an earlier server process and was live when it stopped (no exit
  // recorded, or a shutdown exit), not back yet and not finished.
  function awaitingRestore(run, w) {
    if (w.boot === BOOT || w.closed || w.paused || w.deleted || w.abandoned) return false;
    if (w.exitedAt && !w.shutdownAt) return false;
    if (w.remote) return w.remote.state === 'started' && !remoteLive(run, w)?.session.running && !depFinished(w);
    return !workerSession(run, w.id)?.session.running && !depFinished(w);
  }

  function freeSlots(run) {
    return MAX_WORKERS - run.workers.filter(w => (w.remote ? remoteHoldsSlot(run, w) : workerSession(run, w.id)?.session.running || awaitingRestore(run, w))).length;
  }

  // What a dependency that is not finished came to, when it will not finish
  // by itself: { key (one warning per dependency and report), what } or null.
  function depProblem(run, w) {
    if (depFinished(w)) return null;
    const key = `${w.id}:${w.lastReport?.at || 'none'}`;
    if (w.deleted) return { key, what: 'was deleted' };
    if (w.lastReport?.status === 'failed') return { key, what: `reported failed (${clip(w.lastReport.summary, 200)})` };
    if (w.landing || landingJobs.has(jobKey(run, w))) return null;
    const r = w.landingResult;
    if (w.lastReport?.status === 'done' && r?.report === w.lastReport.at && r.outcome === 'not landed') return { key, what: `came back not landed (${clip(r.reason, 200)})` };
    if (w.closed) return { key, what: `was closed without ${w.branch ? 'landing' : 'reporting done'}` };
    if (w.exitedAt && !w.shutdownAt && !workerSession(run, w.id)?.session.running) return { key, what: `exited without ${w.branch ? 'landing' : 'reporting done'}` };
    return null;
  }

  // One wake event per new dependency problem; the entry keeps waiting.
  function warnDependencies(run) {
    for (const e of run.queue || []) {
      for (const id of e.after || []) {
        const w = run.workers.find(x => x.id === id);
        const p = w && depProblem(run, w);
        if (!p || (e.warned || []).includes(p.key)) continue;
        e.warned = [...(e.warned || []), p.key].slice(-50);
        addEvent(run, { worker: w.name, kind: 'queue', text: `queued launch ${e.id} (${e.title || 'untitled'}) waits on ${w.name} which ${p.what}: cancel_launch it or let it wait` });
      }
    }
  }

  // A running worker the platform may close for a ready queued launch: a
  // worktree worker, idle, its last report done and landed (or nothing to
  // land), no landing in flight, no follow-up since, and a clean worktree.
  function autoClosable(run, w) {
    if (!w.branch || !workerAvailable(run, w) || w.turnStopped || !depFinished(w)) return false;
    if (w.landing || landingJobs.has(jobKey(run, w))) return false;
    if ((w.followUps || []).some(f => f.at > w.lastReport.at)) return false;
    return worktreeChanges(w).length === 0;
  }

  // The landings recorded since a queued launch was queued, as one line of
  // its brief ('' when none).
  function landedSince(run, entry) {
    const list = (run.landings || []).filter(l => l.at >= entry.at && !l.undone);
    if (!list.length) return '';
    return `\n\n[vistaclair queue] Landed since this launch was queued: ${clip(list.map(l => `${l.worker} (${String(l.mergeSha).slice(0, 10)}: ${clip(l.summary, 80)})`).join('; '), 1200)}`;
  }

  // The queue as list_workers and the run board show it.
  function queueList(run) {
    const restoring = run.workers.filter(w => awaitingRestore(run, w)).map(w => w.name);
    const free = freeSlots(run);
    return (run.queue || []).map((e, i) => {
      const unmet = (e.after || []).map(id => run.workers.find(w => w.id === id)).filter(w => !depFinished(w));
      const waitingFor = unmet.map(w => `${w ? w.name : 'a deleted worker'} to ${w?.branch ? 'land' : 'report done'}`);
      if (!unmet.length) {
        if (run.pausing || run.paused) waitingFor.push('the run to be resumed');
        else if (free <= 0) waitingFor.push(restoring.length ? `a free slot (not back since the restart: ${restoring.join(', ')})` : 'a free slot');
      }
      return {
        id: e.id, position: i + 1, title: e.title, waitingFor, queuedAt: e.at,
        after: (e.after || []).map(id => run.workers.find(w => w.id === id)?.name || id),
        brief: clip(e.task, 300), ...(e.host ? { host: e.host, app: e.app } : { cwd: e.cwd }), ...(e.model ? { model: e.model } : {}), ...(e.area ? { area: e.area } : {}),
      };
    });
  }

  // Start the ready queued launches, oldest first. `silent`: the entry whose
  // start the caller reports itself (launch_cli); every other start is a quiet
  // event. Returns [{ entry, result, autoClosed }].
  const pumping = new Set();
  const pumpAgain = new Set();
  function pumpQueue(runDir, { silent = null } = {}) {
    if (!runDir) return [];
    if (pumping.has(runDir)) { pumpAgain.add(runDir); return []; }
    pumping.add(runDir);
    const started = [];
    try {
      do {
        pumpAgain.delete(runDir);
        started.push(...pumpOnce(runDir, silent));
      } while (pumpAgain.has(runDir));
    } catch (e) {
      console.error('[orchestration] launch queue error:', e.message);
    } finally {
      pumping.delete(runDir);
    }
    return started;
  }

  function pumpOnce(runDir, silent) {
    if (mgr._shuttingDown) return [];
    const out = [];
    for (;;) {
      const run = loadRun(runDir);
      if (!run?.queue?.length) break;
      warnDependencies(run);
      if (run.pausing || run.paused) break;
      const entry = run.queue.find(e => depsMet(run, e));
      if (!entry) break;
      let autoClosed = null;
      if (freeSlots(run) <= 0) {
        const c = runningWorkers(run).filter(w => autoClosable(run, w))
          .sort((a, b) => String(a.lastReport.at).localeCompare(String(b.lastReport.at)))[0];
        if (!c) break;
        closeLive(run, c, workerSession(run, c.id), { auto: entry.id });
        autoClosed = c.name;
        if (freeSlots(run) <= 0) { saveRun(run); break; }
      }
      // Out of run.json before the spawn: a crash now loses it, never doubles it.
      run.queue = run.queue.filter(e => e.id !== entry.id);
      saveRun(run);
      let result;
      try {
        result = startWorker(run, { ...entry, task: `${entry.task}${landedSince(run, entry)}` });
      } catch (e) {
        // launch_cli's own entry: its caller gets the error.
        if (entry.id === silent) { out.push({ entry, error: e, autoClosed }); continue; }
        addEvent(loadRun(runDir), { worker: null, kind: 'queue', text: `queued launch ${entry.id} (${entry.title || 'untitled'}) could not start and was dropped: ${String(e.message).split('\n')[0]}. Launch it again with launch_cli once that is fixed` });
        continue;
      }
      out.push({ entry, result, autoClosed });
      if (entry.id !== silent) {
        addEvent(loadRun(runDir), {
          worker: result.worker, kind: 'queue', quiet: true,
          text: `queued launch ${entry.id} (${entry.title || 'untitled'}) started as ${result.worker}${autoClosed ? `; ${autoClosed} (idle, done, landed, clean) was closed to free its slot` : ''}`,
        });
      }
    }
    return out;
  }

  // cancel_launch (orchestrator tool): drop a queued launch.
  function cancelLaunch(instanceId, { id } = {}) {
    const { run } = callerRun(instanceId, 'orchestrator');
    const e = (run.queue || []).find(x => x.id === String(id || '').trim());
    if (!e) throw new Error(`no queued launch ${id || '(no id given)'} in this run${run.queue?.length ? `; queued: ${run.queue.map(x => x.id).join(', ')}` : ''}`);
    run.queue = run.queue.filter(x => x.id !== e.id);
    saveRun(run);
    return { cancelled: e.id, title: e.title, queued: run.queue.length };
  }

  // The repo a worker works in (its worktree's main checkout), for comparing
  // areas and changes.
  function repoOf(w) {
    return w.worktree?.repo || w.removedWorktree?.repo || gitToplevel(w.cwd) || w.cwd;
  }

  // The running workers of the run, in the same repo, whose areas overlap a
  // new worker's: [{ worker, paths: ['mine ~ theirs'] }].
  function areaOverlaps(run, worker) {
    if (!worker.area) return [];
    const repo = repoOf(worker);
    const out = [];
    for (const w of runningWorkers(run)) {
      if (!w.area || w.closed || repoOf(w) !== repo) continue;
      const paths = [];
      for (const mine of worker.area) {
        for (const theirs of w.area) if (areasOverlap(mine, theirs)) paths.push(mine === theirs ? mine || '.' : `${mine || '.'} ~ ${theirs || '.'}`);
      }
      if (paths.length) out.push({ worker: w.name, paths });
    }
    return out;
  }

  // A worker's launch settings — the same for its first launch and a fresh
  // restart, so the restart keeps its address, role card and folder. `write`
  // false: nothing written (a check before the launch).
  function workerSettings(run, worker, { write = true } = {}) {
    const card = workerCard(run, worker);
    return {
      ...run.base.stamps,
      ...(worker.stamps || {}),
      engine: run.engine || 'cli',
      ...authOf(run),
      ...(worker.auth ? { auth: worker.auth } : {}),
      name: worker.name,
      ...(worker.sessionDir ? { sessionDir: worker.sessionDir } : {}),
      orchestration: { runId: run.runId, role: 'worker', workerId: worker.id, orchestrator: run.orchestrator, runDir: run.runDir },
      appendSystemPrompt: run.base.appendSystemPrompt ? `${run.base.appendSystemPrompt}\n\n${card}` : card,
      settingsFile: write ? writeSessionSettings(run, worker.name, run.base.settingsFile) : path.join(run.runDir, 'sessions', `${worker.name}.json`),
      agents: WORKER_AGENTS,
      ...(worker.model || run.model ? { model: worker.model || run.model } : {}),
      ...(run.maxBudgetUsd ? { maxBudgetUsd: run.maxBudgetUsd } : {}),
      ...(worker.grants ? { grants: worker.grants } : {}),
    };
  }

  // launch_cli / resume_worker `tools`: the add-on tools a worker is granted
  // (opaque names, src/tool-packs.js). Undefined: not given; null: none.
  function grantsOf(tools) {
    if (tools === undefined) return undefined;
    if (!Array.isArray(tools) || tools.some(t => typeof t !== 'string' || !t.trim())) {
      throw new Error('tools must be an array of tool names');
    }
    const list = [...new Set(tools.map(t => t.trim()))];
    return list.length ? { tools: list } : null;
  }

  // Before a worker is spawned: `tools` needs a tool pack of the worker that
  // consumes it, and each of its packs' validate may refuse the launch.
  // Throws, having changed nothing.
  function checkPacks(run, worker, { toolsGiven = false } = {}) {
    const settings = workerSettings(run, worker, { write: false });
    if (toolsGiven && !toolPacks.grantConsumed(settings, 'tools')) {
      throw new Error('tools: no tool pack of this worker handles tools');
    }
    toolPacks.validateToolPacks({ settings });
  }

  // The orchestrator MCP's extra parameters (lib/orchestrator-mcp.js asks at
  // tools/list), by tool: `tools` while a registered pack consumes it, else
  // none, so the schemas read as without packs.
  // `host` / `app` while a host provider names at least one host.
  function toolParams() {
    const params = {};
    if (toolPacks.consumedGrants().includes('tools')) {
      const items = { type: 'string' };
      params.launch_cli = { tools: { type: 'array', items, description: 'Add-on tools this worker may use, by name (e.g. app__tool). Fixed for the worker: kept across pause, resume and restart. Omit for none.' } };
      params.resume_worker = { tools: { type: 'array', items, description: 'Replaces the worker\'s add-on tools (an empty array clears them). Omitted: it keeps the ones it has.' } };
    }
    const hosts = hostList();
    if (hosts.length) {
      const names = hosts.map(h => `${h.name}${h.available ? '' : ` (unavailable: ${h.reason || 'no reason given'})`}`).join(', ');
      params.launch_cli = {
        ...(params.launch_cli || {}),
        host: { type: 'string', description: `Run this worker on another machine: ${names}. The owner approves the launch on a card first: the call returns at once (state pending-approval) and a "remote" event says when it started or why not. Not with cwd, isolation, area or tools; it cannot be resumed.` },
        app: { type: 'string', description: 'With host: the app on that machine the worker runs in ([a-z0-9-]). Default: the run\'s app' },
      };
    }
    return { params };
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

  // list_workers: describeRun, with a compact entry for every worker that is
  // gone (closed, stopped, exited) and not paused, so a long run stays readable.
  // The GUI reads describeRun itself (GET /run), never this.
  function listWorkers(instanceId) {
    const { run } = callerRun(instanceId);
    const d = describeRun(run);
    return { ...d, workers: d.workers.map(w => (w.running || w.paused ? w : compactWorker(w))) };
  }

  function compactWorker(w) {
    return {
      worker: w.worker, name: w.name, id: w.id, title: w.title, state: w.state, closedAt: w.closedAt,
      lastReport: w.lastReport ? { status: w.lastReport.status, summary: clip(w.lastReport.summary, 160) } : null,
      branch: w.branch, todo: w.todo, notes: w.notes,
      ...(w.grants ? { grants: w.grants } : {}),
      ...(w.host ? { host: w.host, remote: w.remote } : {}),
    };
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
    return w.paused ? 'paused' : w.closed ? 'closed' : w.abandoned ? 'abandoned' : w.exitedAt ? 'exited' : 'stopped';
  }

  // An SDK session's main-agent context ({ tokens, window, compactAt,
  // percent of the window }), or null while nothing has counted it.
  function contextOf(session) {
    const c = session?.context;
    if (!c || c.tokens == null) return null;
    return { tokens: c.tokens, window: c.window || null, compactAt: c.compactAt || null, percent: c.window ? Math.round((c.tokens / c.window) * 100) : null };
  }

  // The highest of the live, the recorded and (an SDK member) its folder's
  // transcript total: a member just resumed may not have reported its
  // carried-over total yet, and run.json may hold less than the folder's
  // every session (one stored before costs carried across a fresh restart).
  function costOf(session, stored, dir) {
    const live = typeof session?.costUsd === 'number' ? session.costUsd : null;
    const kept = typeof stored === 'number' ? stored : null;
    const folder = dir ? transcriptTotals(dir).costUsd || null : null;
    const known = [live, kept, folder].filter(c => c !== null);
    return known.length ? Math.max(...known) : null;
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
      ...(run.mirror ? { mirror: { key: run.mirror.key, host: run.mirror.host, orchestrator: run.orchestrator, closed: !!run.mirror.closed } } : {}),
      orchestratorRunning: !!orch?.session.running,
      orchestratorSessId: orch?.session.sessId || savedId(st => st.role === 'orchestrator'),
      orchestratorTabId: orch?.tabId || null,
      orchestratorState: memberState(orch?.session, null),
      orchestratorCost: costOf(orch?.session, run.orchestratorCost, run.engine === 'sdk' ? orchestratorDir(run) : null),
      compactions: run.compactions || 0,
      refreshSuggested: (run.compactions || 0) >= REFRESH_SUGGESTED_AFTER,
      pendingEvents: run.events.filter(e => e.seq > run.delivered).length,
      ownerItems: ownerItemsView(run),
      // Launches waiting for a slot or their `after` workers (launch_cli).
      queue: queueList(run),
      workers: run.workers.map(w => {
        if (w.remote) return describeRemote(run, w);
        const live = workerSession(run, w.id);
        return {
          worker: w.name, name: w.name, id: w.id, title: w.title, running: !!live?.session.running, tabId: live?.tabId || null,
          sessId: live?.session.sessId || savedId(st => st.role === 'worker' && st.workerId === w.id),
          engine: run.engine || 'cli',
          model: w.model || live?.session.getSettings().model || null,
          state: memberState(live?.session, w),
          cost: costOf(live?.session, w.costUsd, run.engine === 'sdk' ? w.sessionDir : null),
          cwd: w.cwd, branch: w.branch, launchedAt: w.launchedAt, exitedAt: w.exitedAt, lastReport: w.lastReport,
          paused: !!w.paused, abandoned: !!w.abandoned,
          closed: !!w.closed, closedAt: w.closedAt || null, available: workerAvailable(run, w),
          ...(w.turnStopped ? { turnStopped: w.turnStopped } : {}),
          brief: clip(w.task, 300),
          ...(w.grants ? { grants: w.grants } : {}),
          ...(run.engine === 'sdk' ? { context: live?.session.running ? contextOf(live.session) : null } : {}),
          todo: w.sessionDir ? path.join(w.sessionDir, 'TODO.md') : null,
          notes: w.sessionDir ? path.join(w.sessionDir, 'NOTES.md') : null,
          progress: folderSummary(w.sessionDir),
          live: live && control ? control.liveOf(live.session) : null,
        };
      }),
    };
  }

  // describeRun's entry for a remote member: no cwd, branch or worktree; its
  // TODO / NOTES are the provider's copy (the tab's settings.sessionDir).
  function describeRemote(run, w) {
    const live = remoteLive(run, w);
    const dir = live?.session.getSettings().sessionDir || null;
    const r = w.remote || {};
    return {
      worker: w.name, name: w.name, id: w.id, title: w.title, running: !!live?.session.running, tabId: live?.tabId || null,
      sessId: live?.session.sessId || null, engine: 'sdk',
      host: w.host, app: w.app,
      remote: { state: r.state, ...(r.code ? { code: r.code, error: r.error } : {}), ...(r.startedAt ? { startedAt: r.startedAt } : {}) },
      model: w.model || live?.session.getSettings().model || null,
      state: remoteState(run, w, live),
      cost: costOf(live?.session, w.costUsd, null),
      cwd: null, branch: null, launchedAt: w.launchedAt, exitedAt: w.exitedAt, lastReport: w.lastReport,
      paused: false, abandoned: false,
      closed: !!w.closed, closedAt: w.closedAt || null, available: workerAvailable(run, w),
      ...(w.turnStopped ? { turnStopped: w.turnStopped } : {}),
      brief: clip(w.task, 300),
      context: live?.session.running ? contextOf(live.session) : null,
      todo: dir ? path.join(dir, 'TODO.md') : null,
      notes: dir ? path.join(dir, 'NOTES.md') : null,
      progress: folderSummary(dir),
      live: null,
    };
  }

  // describeRun by id, null for an unknown run (the add-on ctx).
  function describeRunById(runId) {
    const run = getRun(String(runId || ''));
    return run ? describeRun(run) : null;
  }

  // Every run a live or saved session is stamped with — running, paused or
  // ended — one summary each, the most recently changed first (the add-on ctx:
  // no other list of runs exists). A run whose run.json is gone is left out.
  function listRuns() {
    const saved = savedEntries();
    const ids = new Set();
    for (const m of findByStamp(st => !!st.runId)) ids.add(m.stamp.runId);
    for (const e of saved) if (e.settings?.orchestration?.runId) ids.add(e.settings.orchestration.runId);
    const out = [];
    for (const runId of ids) {
      const run = getRun(runId);
      if (!run) continue;
      const orch = orchestratorSession(run);
      const entry = saved.find(e => e.settings?.orchestration?.runId === runId && e.settings.orchestration.role === 'orchestrator') || null;
      const running = !!orch?.session.running;
      let updatedAt = null;
      try { updatedAt = fs.statSync(runFile(run.runDir)).mtime.toISOString(); } catch { /* none */ }
      out.push({
        runId,
        name: run.orchestrator,
        title: (orch ? orch.session.title : entry?.title) || (run.mirror ? `${run.orchestrator} on ${run.mirror.host}` : null),
        cwd: (orch ? orch.session.cwd : entry?.cwd) || run.root,
        engine: run.engine || 'cli',
        state: running ? memberState(orch.session, null) : run.mirror ? (run.closed ? 'closed' : 'mirror') : run.pausing ? 'pausing' : run.paused ? 'paused' : run.closed ? 'closed' : 'exited',
        busy: running && orch.session.busy === true,
        paused: !!run.paused,
        pausing: !!run.pausing,
        orchestratorTabId: orch?.tabId || null,
        orchestratorSessId: orch?.session.sessId || entry?.id || null,
        workerCount: run.workers.length,
        updatedAt,
        ...(run.mirror ? { mirror: { host: run.mirror.host, orchestrator: run.orchestrator } } : {}),
      });
    }
    return out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  // end_run: finish the run. Worktrees go as at a worker's exit (teardown);
  // every worker keeps its record, folder and saved session, so resume_worker
  // can still bring it back (restoreWorktree adds its worktree again), and new
  // work (launch_cli, resume_worker) reopens the run.
  function endRun(instanceId) {
    const { run } = callerRun(instanceId, 'orchestrator');
    const removed = [];
    const kept = [];
    for (const w of run.workers) {
      if (!w.worktree) continue;
      const r = teardownWorker(run, w);
      if (r.removed) removed.push(w.name);
      else kept.push({ worker: w.name, reason: r.kept, ...(r.files?.length ? { files: r.files } : {}) });
    }
    // Remote members stop: their host keeps nothing for the run.
    const remoteClosed = [];
    for (const w of run.workers) {
      if (!w.remote || w.closed) continue;
      if (remoteHoldsSlot(run, w)) { closeRemote(run, w); remoteClosed.push(w.name); }
    }
    if (kept.length === 0) run.closed = true;
    // Queued launches go: an ended run starts nothing by itself.
    const dropped = (run.queue || []).map(e => ({ id: e.id, title: e.title }));
    run.queue = [];
    saveRun(run);
    return {
      removed, kept, closed: run.closed,
      ...(remoteClosed.length ? { remoteClosed } : {}),
      ...(dropped.length ? { queueDropped: dropped, queueNote: `${dropped.length} queued launch(es) dropped (${dropped.map(e => e.id).join(', ')}): launch them again with launch_cli if they are still wanted` } : {}),
    };
  }

  // --- Landing (src/worktree-landing.js) ---
  //
  // A worker's "done" report lands its branch: code, not the orchestrator,
  // rebases it onto the base recorded at launch, runs the repo's check and
  // merges it --no-ff. What stops it goes back to the worker (and the
  // orchestrator hears it as an event); a landing is recorded in run.landings.
  // w.landing marks one in flight in run.json: a restart finds it there,
  // aborts its rebase and reports it not landed (recoverLandings).

  const landingJobs = new Map();   // `${runId}/${workerId}` -> promise of the landing in flight

  const jobKey = (run, w) => `${run.runId}/${w.id}`;

  // The real changes in a worker's worktree, as the one cleanliness check
  // sees them (recorded links are not changes): ['?? file', …], [] when none
  // or unreadable.
  function worktreeChanges(w) {
    if (!w?.worktree || !fs.existsSync(w.worktree.path)) return [];
    try { return landing.changes(w.worktree.path, w.worktree.links).map(c => `${c.code.trim()} ${c.path}`); } catch { return []; }
  }

  // Remove a worker's worktree once its branch is merged into its base and
  // nothing real is left: links unlinked, `git worktree remove`, `git branch
  // -d`. Else kept, with the reason (w.worktreeKept). { removed } | { kept, files }.
  function teardownWorker(run, w) {
    if (!w.worktree) return { removed: false, kept: 'no worktree', files: [] };
    if (workerSession(run, w.id)?.session.running) return { kept: 'still running', files: [] };
    if (landingJobs.has(jobKey(run, w))) return { kept: 'landing in progress', files: [] };
    const { repo, path: wt, links = [] } = w.worktree;
    const r = landing.teardown({ repo, worktree: wt, branch: w.branch, base: w.base || 'HEAD', links });
    if (r.removed) {
      w.removedWorktree = w.worktree;
      w.worktree = null;
      delete w.worktreeKept;
    } else {
      w.worktreeKept = { reason: r.kept, ...(r.files.length ? { files: r.files } : {}), at: new Date().toISOString() };
    }
    return r;
  }

  // Into a running worker: a landing that needs its hand, or an overlap with
  // another worktree (`tag`). False when it is not running.
  function tellWorker(run, w, text, tag = 'landing') {
    const live = workerSession(run, w.id);
    if (!live?.session.running) return false;
    const body = `[vistaclair ${tag}] ${text}`;
    deliver(live.session, w.name, body, 'vistaclair');
    emitTo(live.session, run, { platform: { kind: 'message', from: 'vistaclair', to: w.name, text: body } });
    return true;
  }

  // A landing's outcome, other than landed: what the worker is told (null:
  // nothing it can do) and the orchestrator's event.
  function notLanded(w, r) {
    const list = (files) => files.slice(0, 30).join(', ') + (files.length > 30 ? `, … (${files.length} in all)` : '');
    switch (r.outcome) {
      case 'dirty': return {
        worker: `Your branch was not landed: your worktree has uncommitted changes (${list(r.files)}). Commit them on ${w.branch} or discard them, then report done again.`,
        event: `uncommitted changes in its worktree (${list(r.files)})`,
      };
      case 'link-committed': return {
        worker: `Your branch was not landed: it commits dependency links (${list(r.files)}), which are code's, not yours. Remove them from your commits (git rm --cached, then commit), then report done again.`,
        event: `its branch commits dependency links (${list(r.files)})`,
      };
      case 'conflict': return {
        worker: `Your branch was not landed: it conflicts with ${w.base} in ${list(r.files)}. ${w.base} is untouched. In your worktree run \`git rebase ${w.base}\`, resolve the conflicts, finish the rebase, re-run your check and report done again.`,
        event: `its branch conflicts with ${w.base} in ${list(r.files)}; ${w.base} untouched`,
        gone: `resume_worker it with this, or launch a worker to merge ${w.branch} into its own branch and resolve the conflicts (its landing brings ${w.name}'s work in)`,
      };
      case 'check-failed': return {
        worker: `Your branch was not landed: the repo's check failed after rebasing onto ${w.base}. Fix it, commit, and report done again. Output (tail):\n${clip(r.output, 2500)}`,
        event: `the check failed after rebasing onto ${w.base}: ${clip(String(r.output || '').trim().split('\n').slice(-3).join(' / '), 300)}`,
      };
      case 'manifest-unreadable': return {
        worker: null,
        event: `its manifest ${r.file} is unreadable (${r.error}), so the check would be skipped. Nothing changed: once the manifest is fixed (committed on ${w.base}), have ${w.name} report done again`,
      };
      case 'owner-dirty': return {
        worker: null,
        event: r.files.length
          ? `the owner has uncommitted changes in ${r.checkout} to files this landing changes (${list(r.files)}). Nothing changed: once they are committed or stashed, have ${w.name} report done again`
          : `${r.message}. Nothing changed: once it is finished, have ${w.name} report done again`,
      };
      default: return { worker: null, event: r.message || r.outcome };
    }
  }

  // A report as its event's parts: [head, files, verified, open] (the empty
  // ones left out). A landing's outcome goes right after the head.
  function reportParts(w) {
    const rep = w.lastReport || {};
    const parts = [`${w.name} reported ${rep.status || 'update'}: ${clip(rep.summary, 600)}`];
    if (rep.filesChanged?.length) parts.push(`files: ${rep.filesChanged.join(', ')}`);
    if (rep.verified) parts.push(`verified: ${clip(rep.verified, 300)}`);
    if (rep.open) parts.push(`open: ${clip(rep.open, 300)}`);
    return parts;
  }

  // The one event of a done report that went to landing: the report with what
  // the landing came to.
  function landingEvent(run, w, parts, outcome, kind) {
    const [head, ...rest] = parts?.length ? parts : reportParts(w);
    addEvent(run, { worker: w.name, kind, text: [head, outcome, ...rest].join(' — ') });
  }

  // What the landing of a done report (by its `at`) came to: landed | nothing
  // | not landed. A queued launch's `after` reads it (depFinished).
  function noteLanding(w, outcome, reportAt, reason = '') {
    w.landingResult = { outcome, report: reportAt || null, at: new Date().toISOString(), ...(reason ? { reason: clip(reason, 300) } : {}) };
  }

  // Record a landing in run.landings.
  function recordLanding(run, w, r, summary) {
    run.landings = [...(run.landings || []), {
      worker: w.name, branch: w.branch, base: w.base, preLandSha: r.preLandSha, mergeSha: r.mergeSha, head: r.head,
      summary: clip(summary, 300), at: new Date().toISOString(),
    }];
  }

  // Running workers of the same repo whose changes touch files a landing just
  // brought onto the base: they meet them when they land. '' when none.
  function landedOverlaps(run, w, r) {
    const repo = w.worktree?.repo || w.removedWorktree?.repo;
    let landed;
    try { landed = new Set(git(repo, ['diff', '--name-only', r.preLandSha, r.mergeSha]).split('\n').filter(Boolean)); } catch { return ''; }
    const hits = [];
    for (const o of run.workers) {
      if (o.id === w.id || !o.worktree || o.worktree.repo !== repo || !o.branch || !workerSession(run, o.id)?.session.running) continue;
      const shared = landing.changedFiles({ repo, worktree: o.worktree.path, branch: o.branch, base: o.base, links: o.worktree.links }).filter(f => landed.has(f));
      if (shared.length) hits.push(`${o.name} (${clip(shared.join(', '), 300)})`);
    }
    return hits.length ? `; running workers changing the same files: ${hits.join(', ')} — they meet these changes when they land` : '';
  }

  // Record what a landing came to: run.landings and the report's one event; a
  // stop goes back to the worker when it can act on it.
  function settleLanding(runDir, workerId, r, { summary, parts, reportAt }, key, job) {
    const run = loadRun(runDir);
    // Loaded while the job is still listed: loadRun must not take it for one
    // a restart cut off.
    if (landingJobs.get(key) === job) landingJobs.delete(key);
    const w = run?.workers.find(x => x.id === workerId);
    if (!w) return;
    delete w.landing;
    if (r.outcome === 'nothing') {
      // Nothing new on the branch: the report on its own.
      noteLanding(w, 'nothing', reportAt);
      addEvent(run, { worker: w.name, kind: 'report', text: (parts || reportParts(w)).join(' — ') });
      return;
    }
    if (r.outcome === 'landed') {
      noteLanding(w, 'landed', reportAt);
      recordLanding(run, w, r, summary);
      landingEvent(run, w, parts, `landed ${r.mergeSha} (${w.branch} merged into ${w.base})${landedOverlaps(run, w, r)}`, 'landed');
      // Already gone (closed, exited): its worktree goes now.
      if (!workerSession(run, w.id)?.session.running) { teardownWorker(run, w); saveRun(run); }
      return;
    }
    const n = notLanded(w, r);
    let told = '';
    if (n.worker) told = tellWorker(run, w, n.worker) ? ` Sent back to ${w.name}.` : ` ${w.name} is not running: ${n.gone || 'resume_worker it with this'}.`;
    noteLanding(w, 'not landed', reportAt, n.event);
    landingEvent(run, w, parts, `not landed: ${n.event}.${told}`, 'not landed');
  }

  // A done report of a worktree worker: land its branch. The quick stops are
  // decided here (the report's answer says them); the rest runs in the
  // background, one landing per repo at a time. The report and its landing
  // are one event (`parts`: the report's); `evented` says this took it over.
  // Returns { note (the report's answer, or null), evented }.
  function startLanding(run, w, parts) {
    if (!w.worktree || !w.branch) return { note: null, evented: false };
    const reportAt = w.lastReport?.at;
    if (!w.base) {
      noteLanding(w, 'not landed', reportAt, 'no base branch was recorded at launch');
      landingEvent(run, w, parts, `not landed: no base branch was recorded at launch (a detached HEAD, or a worker from before landing); merge ${w.branch} by hand`, 'not landed');
      return { note: 'not landed: no base branch was recorded at launch; the orchestrator is told', evented: true };
    }
    const { repo, path: wt, links = [] } = w.worktree;
    const key = jobKey(run, w);
    // One of its landings still in flight: this one queues behind it.
    const pre = landingJobs.has(key) ? null : landing.precheck({ repo, worktree: wt, branch: w.branch, base: w.base, links });
    if (pre?.outcome === 'nothing') { noteLanding(w, 'nothing', reportAt); return { note: null, evented: false }; }
    if (pre) {
      const n = notLanded(w, pre);
      noteLanding(w, 'not landed', reportAt, n.event);
      landingEvent(run, w, parts, `not landed: ${n.event}.${n.worker ? ` ${w.name} is told in its report's answer.` : ''}`, 'not landed');
      return { note: n.worker || `not landed: ${n.event}`, evented: true };
    }
    const summary = w.lastReport?.summary || '';
    const cfg = landing.readConfig(repo, path.join(repo, path.relative(wt, w.cwd)), { base: w.base });
    const job = (landingJobs.get(key) || Promise.resolve()).then(async () => {
      const fresh = loadRun(run.runDir);
      const fw = fresh?.workers.find(x => x.id === w.id);
      if (!fw?.worktree) {
        // Its worktree went meanwhile: nothing to land, the report on its own.
        if (fw) {
          noteLanding(fw, 'nothing', reportAt);
          addEvent(fresh, { worker: fw.name, kind: 'report', text: parts.join(' — ') });
          pumpQueue(run.runDir);
        }
        return;
      }
      // The report's parts ride along: a restart that cuts the landing off
      // still sends the one event (recoverLandings).
      fw.landing = { at: new Date().toISOString(), branch: fw.branch, base: fw.base, report: parts, summary, reportAt };
      saveRun(fresh);
      let r;
      try {
        r = await landing.land({
          repo, worktree: wt, branch: fw.branch, base: fw.base, links,
          message: `Merge ${fw.branch}: ${clip(String(summary).split('\n')[0], 120)}`,
          check: cfg?.check || null,
          checkDir: cfg ? path.join(wt, path.relative(repo, cfg.dir)) : null,
          manifest: cfg?.error ? cfg : null,
        });
      } catch (e) {
        r = { outcome: 'error', message: String(e.message || e).split('\n')[0] };
      }
      settleLanding(run.runDir, w.id, r, { summary, parts, reportAt }, key, job);
      // A queued launch may wait on this landing.
      pumpQueue(run.runDir);
      return r;
    }).catch((e) => {
      if (landingJobs.get(key) === job) landingJobs.delete(key);
      console.error('[orchestration] landing error:', e.message);
    });
    landingJobs.set(key, job);
    return { note: 'your branch is being landed: you will hear back only if something stops it', evented: true };
  }

  // The landing in flight for a worker (by address), or null. For tests and
  // callers that wait for it.
  function landingOf(name) {
    for (const [key, job] of landingJobs) {
      const [runId, workerId] = key.split('/');
      const run = getRun(runId);
      if (run?.workers.some(w => w.id === workerId && w.name === name)) return job;
    }
    return null;
  }

  // The merge of a landing a restart cut off between the merge commit and
  // saving its result: the branch has nothing beyond its base, and a merge
  // commit on the base has the branch tip as its second parent. { mergeSha,
  // preLandSha, head } or null.
  function mergeMade(w) {
    const repo = w.worktree?.repo;
    if (!repo || !w.base || !landing.branchExists(repo, w.branch) || !landing.branchExists(repo, w.base)) return null;
    if (landing.hasNew(repo, w.branch, w.base)) return null;
    try {
      const head = git(repo, ['rev-parse', `refs/heads/${w.branch}`]);
      for (const line of git(repo, ['log', '--merges', '-n', '200', '--format=%H %P', `refs/heads/${w.base}`]).split('\n')) {
        const [mergeSha, preLandSha, second] = line.split(' ');
        if (second === head) return { mergeSha, preLandSha, head };
      }
    } catch {}
    return null;
  }

  // Landings a restart cut off (w.landing set, no job in this process): abort
  // their rebase (and a half-done merge). A merge already made counts as
  // landed; anything else is reported not landed. Either way the report's one
  // event. Called by loadRun.
  function recoverLandings(run) {
    for (const w of run.workers) {
      if (!w.landing || landingJobs.has(jobKey(run, w))) continue;
      const { report: parts, summary = w.lastReport?.summary || '', reportAt = w.lastReport?.at } = w.landing;
      let aborted = [];
      if (w.worktree) {
        try { aborted = landing.abortInterrupted({ repo: w.worktree.repo, worktree: w.worktree.path, branch: w.branch, base: w.base }); } catch {}
      }
      delete w.landing;
      const made = mergeMade(w);
      if (made && (run.landings || []).some(l => l.mergeSha === made.mergeSha)) {
        // An earlier landing's merge: this one had nothing new to land.
        noteLanding(w, 'nothing', reportAt);
        addEvent(run, { worker: w.name, kind: 'report', text: (parts || reportParts(w)).join(' — ') });
        continue;
      }
      if (made) {
        noteLanding(w, 'landed', reportAt);
        recordLanding(run, w, made, summary);
        landingEvent(run, w, parts, `landed ${made.mergeSha} (${w.branch} merged into ${w.base}; its landing was cut off by a restart after the merge)`, 'landed');
        continue;
      }
      noteLanding(w, 'not landed', reportAt, 'the landing was cut off by a restart');
      landingEvent(run, w, parts, `not landed: the landing was cut off by a restart${aborted.length ? ` (${aborted.join(' and ')} aborted)` : ''}; ${w.base || 'the base'} is as before. Have ${w.name} report done again`, 'not landed');
    }
  }

  // --- Overlap warnings ---

  // Files changed in two live worktrees of the same repo: committed on their
  // branches (against their base) or not (the cleanliness check, links
  // excluded). Only runs with two or more live worktree workers in one repo
  // cost anything. The workers of a new (file, worker pair) are told directly
  // (they can act on it); the orchestrator gets one quiet event per check.
  // run.overlapsWarned keeps the pairs so none is told twice.
  function checkOverlaps() {
    const dirs = new Set(findByStamp(st => st.role === 'worker').filter(m => m.session.running).map(m => m.stamp.runDir));
    for (const dir of dirs) {
      const run = loadRun(dir);
      if (!run || run.pausing) continue;
      const byRepo = new Map();
      for (const w of run.workers) {
        if (!w.worktree || !w.branch || landingJobs.has(jobKey(run, w)) || !workerSession(run, w.id)?.session.running) continue;
        if (!byRepo.has(w.worktree.repo)) byRepo.set(w.worktree.repo, []);
        byRepo.get(w.worktree.repo).push(w);
      }
      const warned = new Set(run.overlapsWarned || []);
      const found = [];
      const tell = new Map();   // worker name -> Map(other worker name -> files new to the pair)
      const note = (a, b, file) => {
        if (!tell.has(a)) tell.set(a, new Map());
        const m = tell.get(a);
        m.set(b, [...(m.get(b) || []), file]);
      };
      for (const [repo, ws] of byRepo) {
        if (ws.length < 2) continue;
        const touched = new Map();   // file -> worker names
        for (const w of ws) {
          const files = landing.changedFiles({ repo, worktree: w.worktree.path, branch: w.branch, base: w.base, links: w.worktree.links });
          for (const f of files) touched.set(f, [...(touched.get(f) || []), w.name]);
        }
        for (const [file, names] of touched) {
          let fresh = false;
          for (let i = 0; i < names.length; i++) {
            for (let j = i + 1; j < names.length; j++) {
              const key = [file, ...[names[i], names[j]].sort()].join('\0');
              if (!warned.has(key)) {
                warned.add(key);
                fresh = true;
                note(names[i], names[j], file);
                note(names[j], names[i], file);
              }
            }
          }
          if (fresh) found.push(`${file} (${names.join(', ')})`);
        }
      }
      if (!found.length) continue;
      run.overlapsWarned = [...warned].slice(-1000);
      for (const [name, others] of tell) {
        const w = run.workers.find(x => x.name === name);
        const shared = [...others].map(([o, files]) => `with ${o}: ${clip(files.join(', '), 600)}`).join('; ');
        tellWorker(run, w, `Files you change are also changed in another worker's worktree (${shared}). Keep your change to those files minimal, and expect to rebase onto ${w.base || 'your base'} when the other one lands first.`, 'overlap');
      }
      addEvent(run, { worker: null, kind: 'overlap', quiet: true, text: `files changed in more than one worktree: ${clip(found.join('; '), 1500)}. The workers involved are told. Serialize them, or expect a conflict when the later one lands` });
    }
  }

  const overlapTimer = overlapCheckMs > 0 ? setInterval(() => {
    try { checkOverlaps(); } catch (e) { console.error('[orchestration] overlap check error:', e.message); }
  }, overlapCheckMs) : null;
  overlapTimer?.unref?.();

  // undo_landing (orchestrator tool): revert a landing's merge on its base, a
  // new commit. `landing` is its merge sha (a prefix will do), else the newest
  // landing of `worker` not undone yet.
  async function undoLanding(instanceId, { landing: sha, worker } = {}) {
    const { run } = callerRun(instanceId, 'orchestrator');
    const want = String(sha || '').trim();
    const list = run.landings || [];
    const rec = want
      ? list.find(l => l.mergeSha.startsWith(want))
      : [...list].reverse().find(l => !l.undone && (l.worker === worker || run.workers.find(w => w.id === worker)?.name === l.worker));
    if (!rec) throw new Error(want ? `no landing ${want} in this run` : `no landing of ${worker || '(no worker given)'} to undo`);
    if (rec.undone) throw new Error(`landing ${rec.mergeSha} was already undone by ${rec.undone.revertSha}`);
    const w = run.workers.find(x => x.name === rec.worker);
    const repo = w?.worktree?.repo || w?.removedWorktree?.repo || gitToplevel(run.root);
    const r = await landing.undo({ repo, base: rec.base, mergeSha: rec.mergeSha });
    if (r.outcome !== 'reverted') {
      const why = r.outcome === 'owner-dirty' && r.files.length
        ? `uncommitted changes in ${r.checkout} to files the revert changes (${r.files.join(', ')}); nothing changed`
        : `${r.message}; nothing changed`;
      throw new Error(`cannot undo ${rec.mergeSha}: ${why}`);
    }
    const fresh = loadRun(run.runDir);
    const fr = (fresh.landings || []).find(l => l.mergeSha === rec.mergeSha);
    fr.undone = { at: new Date().toISOString(), revertSha: r.revertSha };
    addEvent(fresh, { worker: rec.worker, kind: 'undone', text: `landing ${rec.mergeSha} of ${rec.worker} reverted by ${r.revertSha} on ${rec.base}`, delivered: true });
    return { undone: rec.mergeSha, revertSha: r.revertSha, base: rec.base, worker: rec.worker };
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
    const run = getRun(runId);
    if (!run) throw new Error('run not found');
    assertNotMirror(run);
    if (!control) throw new Error('pause is not available');
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
      pumpQueue(run.runDir);   // a freed slot; nothing starts while the run pauses
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
    assertNotMirror(run);
    if (run.pausing) throw new Error('the run is being paused');
    const orch = orchestratorSession(run);
    if (!orch?.session.running) throw new Error('the orchestrator is not running: restart it fresh from the "+" menu');
    control.pause(orch.tabId, { text: refreshText(run), meta: { runId, role: 'orchestrator', mode: 'refresh' } });
    return { refreshing: true };
  }

  function orchestratorSettings(run) {
    const card = orchestratorCard(run, { hosts: hostList() });
    return {
      ...run.base.stamps,
      engine: run.engine || 'cli',
      ...authOf(run),
      name: run.orchestrator,
      sessionDir: orchestratorDir(run),
      orchestration: { runId: run.runId, role: 'orchestrator', runDir: run.runDir },
      appendSystemPrompt: run.base.appendSystemPrompt ? `${run.base.appendSystemPrompt}\n\n${card}` : card,
      settingsFile: writeSessionSettings(run, run.orchestrator, run.base.settingsFile),
      ...(run.orchestratorModel ? { model: run.orchestratorModel } : {}),
    };
  }

  // A member's model was switched on its live SDK session (sdk:setModel). A
  // worker's run.json entry follows, so a fresh restart (workerSettings) and
  // describeRun use it; the orchestrator's model lives in its own settings
  // (manifest, saved entry), kept here too for a fresh start without an entry.
  function memberModelChanged(session, model) {
    const stamp = stampOf(session);
    const run = stamp ? loadRun(stamp.runDir) : null;
    if (!run || !model) return false;
    if (stamp.role === 'worker') {
      const w = run.workers.find(x => x.id === stamp.workerId);
      if (!w) return false;
      w.model = model;
    } else {
      run.orchestratorModel = model;
    }
    saveRun(run);
    return true;
  }

  // A model map for the whole run (the SDK toolbar's Models dialog): every
  // live member's settings (the proxy reads them per request, so the next
  // request is rewritten), every member's saved entry (a resume reads it),
  // and the run's base stamps, so a worker launched or restarted later and a
  // fresh orchestrator inherit it. Targets not usable now are dropped; an
  // empty map routes nothing.
  function setRunModelMap(runId, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('modelMap must be an object');
    const run = getRun(runId);
    if (!run) throw new Error('run not found');
    const modelMap = parseModelMap(value, remapTargets()) || Object.fromEntries(MODEL_FAMILIES.map(f => [f, null]));
    run.base.stamps = { ...run.base.stamps, modelMap };
    saveRun(run);
    const live = findByStamp(st => st.runId === run.runId);
    for (const { session } of live) {
      session.updateSettings({ modelMap });
      mgr.noteSettingsChanged?.(session);
    }
    patchSavedMembers(run, new Set(live.map(m => m.session.sessId).filter(Boolean)), { modelMap });
    return { runId: run.runId, modelMap, sessions: live.length };
  }

  // Every saved entry of the run's members but `liveIds` takes `patch`: a
  // resume reads it.
  function patchSavedMembers(run, liveIds, patch) {
    for (const e of savedEntries()) {
      if (e.settings?.orchestration?.runId !== run.runId || liveIds.has(e.id)) continue;
      mgr.patchSavedSettings?.(e.id, (st) => ({ ...st, ...patch }));
    }
  }

  // A run-wide switch's sessions: the run's tabs and the external sessions
  // (an add-on's, src/external-session.js) stamped with it. `live`: those
  // running; the rest only carry the setting (`patch`) to their next launch,
  // as the saved entries of the members without a tab do.
  function switchTargets(run, patch) {
    const sessions = findByStamp(st => st.runId === run.runId).map(m => m.session);
    const ext = mgr.external instanceof Map ? [...mgr.external.values()] : [];
    for (const s of ext) if (stampOf(s)?.runId === run.runId) sessions.push(s);
    const live = sessions.filter(s => s.running);
    for (const s of sessions) {
      if (s.running || s.external) continue;
      s.updateSettings(patch);
      mgr.noteSettingsChanged?.(s);
    }
    patchSavedMembers(run, new Set(live.map(s => s.sessId).filter(Boolean)), patch);
    return live;
  }

  // `fn(session)` on every live member, as its tab's own switch would: one
  // that throws or rejects is named in out.failed and the others go on.
  async function switchMembers(live, fn, out, what) {
    await Promise.all(live.map(async (session) => {
      const member = session.getSettings().name || session.tabId;
      try {
        await fn(session);
        out.switched.push(member);
      } catch (e) {
        out.failed.push({ member, error: String(e?.message || e) });
        console.error(`[orchestration] ${what} of ${member}: ${e?.message || e}`);
      }
    }));
  }

  // The billing for the whole run (the SDK toolbar's toggle, a usage-limit
  // notice's "Continue on API credits", ctx.orchestration.setRunAuth): every
  // live member switches (SdkSession.setAuth: at once when idle, after its
  // turn when busy, a pausing one only in its settings; an external one
  // through its adapter), every stopped member's saved entry follows (a
  // resume reads it), and run.auth, so a worker launched or restarted later
  // and a fresh orchestrator inherit it. continueTurn: a member the usage
  // limit stopped goes on after its switch. A refusal (bad auth, unknown or
  // terminal run, missing credential) changes nothing. Resolves { runId,
  // auth, switched: [name], failed: [{ member, error }], sessions (live
  // members), applied: { now | pending | already | saved | failed: n } }.
  async function setRunAuth(runId, auth, { continueTurn = false } = {}) {
    if (auth !== 'apikey' && auth !== 'subscription') throw new Error('auth must be "apikey" or "subscription"');
    const run = getRun(runId);
    if (!run) throw new Error('run not found');
    if (run.engine !== 'sdk') throw new Error('only an Agent SDK run has a billing switch');
    const creds = claudeCredentials() || {};
    if (auth === 'apikey' && !creds.apiKey) throw new Error('No Anthropic API key is stored: add one on the Models page.');
    if (auth === 'subscription' && !creds.subscription) throw new Error('No Claude subscription is signed in: Sign in to Claude, in the dashboard header.');
    run.auth = auth;
    saveRun(run);
    const live = switchTargets(run, { auth });
    const out = { runId: run.runId, auth, switched: [], failed: [], sessions: live.length, applied: {} };
    const count = (how) => { out.applied[how] = (out.applied[how] || 0) + 1; };
    await switchMembers(live, async (session) => {
      try {
        if (session.external) {
          const r = await session.call('setAuth', auth, { continueTurn });
          count(typeof r?.applied === 'string' ? r.applied.slice(0, 40) : 'now');
        } else if (typeof session.setAuth === 'function') {
          count(session.setAuth(auth, { continueTurn }).applied);
        } else {
          // A terminal bills to the claude CLI's own login: its settings
          // carry the billing to its next launch.
          session.updateSettings({ auth });
          mgr.noteSettingsChanged?.(session);
          count('saved');
        }
      } catch (e) {
        count('failed');
        throw e;
      }
    }, out, 'billing switch');
    return out;
  }

  // The model for the whole run (ctx.orchestration.setRunModel): every live
  // member switches as from its tab (SdkSession.setModel: its next turn; an
  // external one through its adapter), every stopped member's saved entry
  // follows, and run.json (run.model, the orchestrator's and every worker's
  // model), so a worker launched later without its own model, a restarted one
  // and a fresh orchestrator start on it. A live terminal cannot change its
  // model mid-session: it is named in failed, and its settings carry the
  // model to its next launch. A refusal (bad model, unknown run) changes
  // nothing. Resolves { runId, model, switched: [name], failed: [{ member,
  // error }] }.
  async function setRunModel(runId, model) {
    if (typeof model !== 'string' || !model.trim()) throw new Error('model must be a non-empty string');
    if (!MODEL_RE.test(model)) throw new Error(`invalid model ${JSON.stringify(model)}`);
    const run = getRun(runId);
    if (!run) throw new Error('run not found');
    run.model = model;
    run.orchestratorModel = model;
    for (const w of run.workers) w.model = model;
    saveRun(run);
    const live = switchTargets(run, { model });
    const out = { runId: run.runId, model, switched: [], failed: [] };
    await switchMembers(live, async (session) => {
      if (session.external) return session.call('setModel', model);
      if (session.kind === 'sdk' && typeof session.setModel === 'function') return session.setModel(model);
      session.updateSettings({ model });
      mgr.noteSettingsChanged?.(session);
      throw new Error('a terminal cannot change its model mid-session: it starts on it when resumed or restarted');
    }, out, 'model switch');
    return out;
  }

  // A member resumed with its own transcript carries its recorded cost on.
  function seedResumedCost(tabId, usd) {
    const s = tabId ? mgr.get(tabId) : null;
    if (typeof s?.seedCost === 'function') s.seedCost(usd);
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
      const state = workerSession(run, w.id)?.session.running ? 'running' : w.paused ? 'paused' : w.closed ? 'closed' : w.abandoned ? 'abandoned' : 'stopped';
      lines.push('', `### \`${w.name}\` — ${state}`, '');
      lines.push(`- Folder: ${w.sessionDir || '(none)'}`);
      if (w.branch) lines.push(`- Branch: ${w.branch}`);
      lines.push(`- Last report: ${w.lastReport ? `${w.lastReport.status}: ${clip(w.lastReport.summary, 600)}${w.lastReport.filesChanged?.length ? ` (files: ${w.lastReport.filesChanged.join(', ')})` : ''}` : '(none)'}`);
      if (f) lines.push(`- TODO: ${f.progress.done}/${f.progress.total} done${f.progress.doing ? `, doing ${f.progress.doing.id}: ${clip(f.progress.doing.description, 120)}` : ''}`);
      lines.push('- Brief:', '', '```', clip(w.task, 2000), '```');
      const ups = followUpsText(w, '- Follow-ups you sent it, oldest first:', 3000);
      if (ups) lines.push('', ups);
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
    assertNotMirror(run);
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
    assertNotMirror(run);
    if (orchestratorSession(run)?.session.running) throw new Error('the orchestrator is already running');
    const entry = savedMember(run, st => st.role === 'orchestrator');
    const lost = !fresh && !control?.canContinue(entry);
    if (fresh || lost) {
      const reason = lost ? 'paused, and its conversation could not be restored' : 'paused';
      const out = { runId, fresh: true, fellBack: lost, ...freshOrchestrator(run, { settings: entry?.settings, title: entry?.title, replaces: entry?.id, reason }) };
      pumpQueue(run.runDir);
      return out;
    }
    run.pausing = null;
    if (!run.workers.some(w => w.paused)) run.paused = null;
    saveRun(run);
    const resumed = control.resumeSaved(entry.id, { message: warmupText(run), fallback: false });
    seedResumedCost(resumed.tabId, run.orchestratorCost);
    pumpQueue(run.runDir);
    return { runId, fresh: false, ...resumed };
  }

  // A worker whose worktree is gone (teardown, deleted by hand) gets it back at
  // the same path before it runs again: its transcript is keyed by its cwd. On
  // its own branch if that still exists, else a new one from its base (HEAD
  // without one), with its dependency links. Throws, and changes nothing, when
  // that fails; a worker without a branch is untouched.
  function restoreWorktree(run, w) {
    if (!w.branch || fs.existsSync(w.cwd)) return;
    const was = w.worktree || w.removedWorktree || {};
    const wt = was.path || path.join(dataHome, 'data', 'worktrees', run.runId, w.id);
    const repo = was.repo || gitToplevel(run.root);
    try {
      if (!repo) throw new Error(`${run.root} is not in a git repository`);
      try { git(repo, ['worktree', 'prune']); } catch {}
      let exists = false;
      try { exists = git(repo, ['branch', '--list', w.branch]).length > 0; } catch {}
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      const from = landing.branchExists(repo, w.base) ? w.base : 'HEAD';
      git(repo, exists ? ['worktree', 'add', wt, w.branch] : ['worktree', 'add', '-b', w.branch, wt, from]);
      fs.mkdirSync(w.cwd, { recursive: true });
    } catch (e) {
      throw new Error(`${w.name}'s worktree ${wt} is gone and could not be recreated: ${String(e.message).split('\n')[0]}`);
    }
    w.worktree = { path: wt, repo, ...linksOf(repo, wt, path.join(repo, path.relative(wt, w.cwd))) };
    delete w.worktreeKept;
    delete w.removedWorktree;
    saveRun(run);
  }

  // Bring a worker back: its own transcript (continue), or a fresh session with
  // the same address, card and folder, seeded with its brief (fresh). A
  // continue whose transcript is gone becomes a fresh start (`fellBack`).
  // A run ended with end_run is reopened. `tools` (resume_worker) replaces
  // its grants; omitted, it keeps them.
  function bringBack(run, w, { mode = 'continue', message = '', tools } = {}) {
    if (w.remote) throw new Error(`${w.name} is a remote worker on ${w.host}: it cannot be resumed. Launch a new one with launch_cli({ host }) from its brief and its last report`);
    if (workerSession(run, w.id)?.session.running) throw new Error(`${w.name} is already running: send it a message instead`);
    assertCapacity(run);
    const grants = tools === undefined ? w.grants || null : grantsOf(tools);
    const { grants: _g, ...rest } = w;
    checkPacks(run, grants ? { ...rest, grants } : rest, { toolsGiven: tools !== undefined });
    restoreWorktree(run, w);
    if (grants) w.grants = grants;
    else delete w.grants;
    const from = message ? `From your orchestrator \`${run.orchestrator}\`: ${message}` : '';
    const old = savedMember(run, st => st.role === 'worker' && st.workerId === w.id);
    const lost = mode !== 'fresh' && !control?.canContinue(old);
    let tabId;
    if (mode === 'fresh' || lost) {
      const why = lost ? 'its earlier conversation could not be restored, so this is a fresh session' : 'this is a fresh restart';
      const ups = followUpsText(w, 'Follow-ups from your orchestrator, oldest first:', 4000);
      const task = ups ? 'the brief above is your original task and the follow-ups after it are what you were told since (the newest is your current task), already partly done' : 'the brief above is your original task, already partly done';
      const prompt = `${w.task}\n\n${ups ? `${ups}\n\n` : ''}[vistaclair resume] You are worker \`${w.name}\` and ${why} with a clean context: ${task}. Your TODO.md and NOTES.md in ${w.sessionDir} are your state — read them first, check the files they name, re-run whatever was cut off and continue from the \`## Resume\` note. ${from}`.trim();
      tabId = spawnWorker(run, w, prompt);
      if (old && typeof mgr.forgetSaved === 'function') mgr.forgetSaved(old.id);
    } else {
      const text = `${resumeText(w.sessionDir || '(your session folder)', { interrupted: !!old.interrupted })}${from ? `\n${from}` : ''}`;
      // Its saved settings, with the run's grants (replaced or cleared).
      let settings;
      if (grants || old.settings?.grants) {
        const { grants: _sg, ...kept } = old.settings || {};
        settings = grants ? { ...kept, grants } : kept;
      }
      ({ tabId } = control.resumeSaved(old.id, { message: text, fallback: false, ...(settings ? { settings } : {}) }));
      seedResumedCost(tabId, w.costUsd);
    }
    const fresh = loadRun(run.runDir);
    const fw = fresh.workers.find(x => x.id === w.id);
    if (grants) fw.grants = grants;
    else delete fw.grants;
    fw.paused = false;
    fw.exitedAt = null;
    delete fw.closed;
    delete fw.closedAt;
    delete fw.autoClosed;
    delete fw.shutdownAt;
    fw.boot = BOOT;
    fw.resumedAt = new Date().toISOString();
    if (!fresh.workers.some(x => x.paused)) fresh.paused = null;
    fresh.closed = false;
    saveRun(fresh);
    // The last paused worker back unpauses the run: queued launches may start.
    if (!fresh.paused) pumpQueue(fresh.runDir);
    const v = vol(w.name);
    v.agents = 0; v.reported = false; v.nudged = false; v.stopping = false;
    return { worker: w.name, tabId, mode: mode === 'fresh' || lost ? 'fresh' : 'continue', ...(lost ? { fellBack: true, note: 'its conversation could not be restored, so it was started fresh from its brief and notes' } : {}) };
  }

  // resume_worker (orchestrator tool). Counts against the worker cap.
  function resumeWorker(instanceId, { worker, mode = 'continue', message = '', tools } = {}) {
    const { run } = callerRun(instanceId, 'orchestrator');
    if (run.pausing) throw new Error('this run is being paused');
    const w = run.workers.find(x => x.name === worker || x.id === worker);
    if (!w) throw new Error(`no worker ${worker} in this run`);
    const out = bringBack(run, w, { mode, message, tools });
    if (message) addFollowUp(loadRun(run.runDir), w.id, message);
    return out;
  }

  // close_worker (orchestrator tool): close a finished worker the orchestrator
  // will not reuse, freeing its slot. Saved like a pause (history entry kept,
  // inspector data and transcript untouched) and closed quietly — no exit
  // event: the orchestrator closed it itself. Its worktree goes when merged and
  // clean (teardownWorker). It stays listed, marked closed, and resume_worker
  // brings it back.
  function closeWorker(instanceId, { worker } = {}) {
    const { run } = callerRun(instanceId, 'orchestrator');
    if (run.pausing) throw new Error('this run is being paused');
    const w = run.workers.find(x => x.name === worker || x.id === worker);
    if (!w) throw new Error(`no worker ${worker} in this run`);
    if (w.remote) return closeRemoteWorker(run, w);
    const live = workerSession(run, w.id);
    if (!live?.session.running) throw new Error(`${w.name} is not running${w.closed ? ' (already closed)' : w.paused ? ' (paused)' : ''}`);
    if (live.session.busy) throw new Error(`${w.name} is busy: close it once it has reported and gone idle, or stop it first with stop_worker`);
    const status = w.lastReport?.status;
    if (!['done', 'failed'].includes(status) && !w.turnStopped) {
      throw new Error(`${w.name} has not finished (last report: ${status || 'none'}): only a worker whose last report is done or failed, or one stopped with stop_worker, can be closed`);
    }
    const { now, td } = closeLive(run, w, live);
    const p = folderSummary(w.sessionDir);
    const open = p ? p.total - p.done : 0;
    const out = {
      worker: w.name, closed: true, closedAt: now, lastReport: status,
      ...(open > 0 ? { note: `closed with ${open} open TODO row(s): its last report was ${status}` } : {}),
      ...(td ? { worktree: td.removed ? 'removed' : `kept: ${td.kept}${td.files?.length ? ` (${td.files.join(', ')})` : ''}` } : {}),
      resume: 'it stays in list_workers; resume_worker (continue or fresh) brings it back',
    };
    pumpQueue(run.runDir);
    return out;
  }

  // close_worker of a remote member: a launch still waiting for the owner is
  // cancelled; a running one closes on the same terms as a local worker; one
  // not back since a restart is let go. provider.kill does it.
  function closeRemoteWorker(run, w) {
    const live = remoteLive(run, w);
    const st = remoteState(run, w, live);
    const waiting = st === 'pending-approval';
    if (!waiting && !remoteHoldsSlot(run, w)) throw new Error(`${w.name} is not running (${st})`);
    if (live?.session.running) {
      if (live.session.busy) throw new Error(`${w.name} is busy: close it once it has reported and gone idle, or stop it first with stop_worker`);
      const status = w.lastReport?.status;
      if (!['done', 'failed'].includes(status) && !w.turnStopped) {
        throw new Error(`${w.name} has not finished (last report: ${status || 'none'}): only a worker whose last report is done or failed, or one stopped with stop_worker, can be closed`);
      }
    }
    const killed = closeRemote(run, w);
    saveRun(run);
    pumpQueue(run.runDir);
    return {
      worker: w.name, host: w.host, closed: true, closedAt: w.closedAt, lastReport: w.lastReport?.status || null,
      ...(waiting ? { note: 'its launch was cancelled before the owner approved it' } : {}),
      ...(killed ? {} : { note: 'no host provider is registered: it is marked closed here only' }),
      resume: 'a remote worker cannot be resumed: launch a new one with launch_cli({ host })',
    };
  }

  // Close a live worker quietly (close_worker, or `auto`: the queued launch it
  // is closed for): saved like a pause, marked closed, its worktree torn down
  // when merged and clean. Saves the run.
  function closeLive(run, w, live, { auto = null } = {}) {
    const s = live.session;
    if (s.sessId && s.cwd) mgr.saveToHistory({ sessId: s.sessId, cwd: s.cwd, title: s.title, settings: s.getSettings(), autoMemory: s.autoMemory });
    mgr.closeQuiet(live.tabId, 'close_worker');
    const now = new Date().toISOString();
    w.closed = true;
    w.closedAt = now;
    if (auto) w.autoClosed = { at: now, for: auto };
    delete w.turnStopped;
    w.exitedAt = now;
    if (typeof s.costUsd === 'number') w.costUsd = s.costUsd;
    volatile.delete(w.name);
    dropInbox(run.runDir, w.name);
    const td = w.worktree ? teardownWorker(run, w) : null;
    saveRun(run);
    return { now, td };
  }

  // stop_worker (orchestrator tool): end a busy worker's current turn (the SDK
  // session's interrupt, Esc in a terminal) without closing it. It stays
  // running and idle with its folder, branch and transcript; the orchestrator
  // sends it new instructions or closes it. The Stop that ends the interrupted
  // turn, if any, is neither nudged nor reported as idle. Recorded as a run
  // event, not delivered back: the orchestrator stopped it itself.
  function stopWorker(instanceId, { worker, reason = '' } = {}) {
    const { run } = callerRun(instanceId, 'orchestrator');
    if (run.pausing) throw new Error('this run is being paused');
    const w = run.workers.find(x => x.name === worker || x.id === worker);
    if (!w) throw new Error(`no worker ${worker} in this run`);
    const live = liveOf(run, w);
    if (w.remote && !live?.session.running) {
      const st = remoteState(run, w, live);
      throw new Error(`${w.name} (on ${w.host}) is ${st}${st === 'pending-approval' ? ': nothing runs yet; close_worker cancels its launch' : ''}`);
    }
    if (!live?.session.running) throw new Error(`${w.name} is not running${w.closed ? ' (closed)' : w.paused ? ' (paused)' : ''}`);
    if (!live.session.busy) throw new Error(`${w.name} is idle: nothing to stop. Send it new instructions with SendMessage, or close it with close_worker`);
    vol(w.name).stopping = true;
    // A remote member: its tab adapter's interrupt (the turn ends on its host).
    if (w.remote) live.session.call('interrupt').catch(e => console.error(`[orchestration] interrupt of ${w.name}:`, e.message));
    else if (typeof live.session.interrupt === 'function') live.session.interrupt();
    else live.session.write('\x1b');
    const at = new Date().toISOString();
    const why = clip(String(reason || '').trim(), 500);
    w.turnStopped = { at, ...(why ? { reason: why } : {}) };
    addEvent(run, { worker: w.name, kind: 'stopped', text: `${w.name} was stopped by the orchestrator${why ? `: ${why}` : ''}`, delivered: true });
    return {
      worker: w.name, stopped: true, at,
      next: 'it stays running and goes idle: send it new instructions with SendMessage, or close it with close_worker',
    };
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

  // Delete a whole run from the "+" menu: its open member tabs (closed
  // quietly, like close_worker), every member's saved session, the session
  // folders, the run directory and the worktrees. A member mid-turn or a
  // worktree with uncommitted changes stops it unless `force` (one refusal
  // naming both: { refused, busy, dirty }); forced, a busy member is
  // interrupted, then closed. An unmerged branch is kept.
  function deleteRun(runId, { force = false } = {}) {
    const run = getRun(runId);
    const entries = savedEntries().filter(e => e.settings?.orchestration?.runId === runId);
    const live = findByStamp(st => st.runId === runId);
    const nameOf = (st) => st.role === 'worker' ? run?.workers.find(w => w.id === st.workerId)?.name || st.workerId : run?.orchestrator || 'orchestrator';
    const busy = live.filter(m => m.session.busy)
      .map(m => ({ worker: nameOf(m.stamp), title: m.session.title || nameOf(m.stamp), tabId: m.tabId }));
    const dirty = [];
    const keptBranches = [];
    for (const w of run?.workers || []) {
      if (worktreeChanges(w).length) dirty.push({ worker: w.name, path: w.worktree.path });
    }
    if ((busy.length || dirty.length) && !force) return { refused: true, busy, dirty };
    for (const { tabId, session: s, stamp } of live) {
      if (s.busy) {
        if (typeof s.interrupt === 'function') Promise.resolve(s.interrupt()).catch(() => {});
        else s.write?.('\x1b');
      }
      mgr.closeQuiet(tabId, 'delete_run');
      if (s.sessId && !entries.some(e => e.id === s.sessId)) entries.push({ id: s.sessId });
      volatile.delete(nameOf(stamp));
      if (run) dropInbox(run.runDir, nameOf(stamp));
    }
    for (const w of run?.workers || []) {
      if (w.worktree && !removeWorktree(w)) keptBranches.push(w.branch);
      if (w.remote && !w.closed && remoteHoldsSlot(run, w)) killRemote(run, w);
    }
    for (const e of entries) mgr.deleteSavedSession(e.id);
    const dirs = [run?.orchestratorDir, ...(run?.workers || []).map(w => w.sessionDir)];
    for (const d of dirs) {
      if (d && path.basename(path.dirname(d)) === 'sessions') fs.rmSync(d, { recursive: true, force: true });
    }
    if (run?.runDir && path.basename(run.runDir) === run.runId) fs.rmSync(run.runDir, { recursive: true, force: true });
    runDirs.delete(runId);
    broadcaster.broadcast({ type: 'orchestration:run', runId, deleted: true });
    return { deleted: entries.length, keptBranches, busy, dirty };
  }

  // The run record of a saved worker session, and the worker in it.
  function memberOf(entry) {
    const st = entry?.settings?.orchestration;
    if (st?.role !== 'worker') return {};
    const run = loadRun(st.runDir);
    return { run, w: run?.workers.find(x => x.id === st.workerId) };
  }

  // The worktree of a saved worker with uncommitted changes, as deleteRun
  // lists them: [{ worker, path }] or [].
  function memberDirty(entry) {
    const { w } = memberOf(entry);
    return worktreeChanges(w).length ? [{ worker: w.name, path: w.worktree.path }] : [];
  }

  // A deleted worker's worktree goes whatever its branch: links unlinked
  // first, --force only over real changes the owner chose to drop. Its branch
  // is deleted when merged into its base. Returns whether it was (or is gone).
  function removeWorktree(w) {
    const { repo, path: wt, links = [] } = w.worktree;
    const dirty = worktreeChanges(w).length > 0;
    landing.unlinkLinks(links);
    try { git(repo, ['worktree', 'remove', ...(dirty ? ['--force'] : []), wt]); } catch {}
    return landing.teardown({ repo, worktree: wt, branch: w.branch, base: w.base || 'HEAD' }).removed === true;
  }

  // A worker deleted on its own from the "+" menu stays in run.json, marked.
  // Its worktree goes as in deleteRun: uncommitted changes refuse it unless
  // `force` (nothing changed), an unmerged branch is kept.
  function noteMemberDeleted(entry, { force = false } = {}) {
    const { run, w } = memberOf(entry);
    if (!w) return null;
    const dirty = memberDirty(entry);
    if (dirty.length && !force) return { refused: true, dirty };
    const keptBranches = [];
    if (w.worktree && !workerSession(run, w.id)?.session.running) {
      if (!removeWorktree(w)) keptBranches.push(w.branch);
      w.removedWorktree = w.worktree;
      w.worktree = null;
    }
    w.deleted = true;
    w.paused = false;
    if (!run.workers.some(x => x.paused)) run.paused = null;
    saveRun(run);
    return { keptBranches, dirty };
  }

  // A running worker the orchestrator may close (close_worker): idle, and its
  // last report is done or failed, or it was stopped (stop_worker). Open TODO
  // rows do not hold it.
  function workerAvailable(run, w) {
    const live = liveOf(run, w);
    return !!live?.session.running && !live.session.busy && (['done', 'failed'].includes(w.lastReport?.status) || !!w.turnStopped);
  }

  // A live worker that no longer holds its orchestrator's close: available
  // (or abandoned and idle), and its TODO has no open row (no rows counts as
  // none).
  function workerFinished(run, w) {
    const live = workerSession(run, w.id);
    if (!live || live.session.busy) return false;
    if (!w.abandoned && !workerAvailable(run, w)) return false;
    const progress = folderSummary(w.sessionDir);
    return !progress || progress.done >= progress.total;
  }

  // May this tab be closed? A worker only once its work is complete (its last
  // report is done/failed, and it is idle) — or when forced, which abandons it;
  // an orchestrator only while none of its workers is still at work.
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
    const running = runningWorkers(run).filter(w => !workerFinished(run, w));
    if (running.length) {
      return { ok: false, canForce: false, reason: `Workers of this run are still running (${running.map(w => w.name).join(', ')}). Pause the run, or wait for them to finish.` };
    }
    return { ok: true };
  }

  if (control) control.onFinalized(onMemberFinalized);

  function report(instanceId, { status, summary, filesChanged, verified, open, ownerItems } = {}) {
    const { session, stamp, run } = callerRun(instanceId, 'worker');
    const w = run.workers.find(x => x.id === stamp.workerId);
    if (!w) throw new Error('worker not found in run');
    w.lastReport = { status: status || 'update', summary: summary || '', filesChanged: filesChanged || [], verified: verified || '', open: open || '', at: new Date().toISOString() };
    delete w.turnStopped;
    if (WAKE_STATUSES.has(w.lastReport.status)) vol(session.getSettings().name).reported = true;
    const parts = reportParts(w);
    // What only the owner can do or decide: the run's checklist (run.ownerItems).
    const owner = Array.isArray(ownerItems) ? addOwnerItems(run, ownerItems, { worker: w.name, blocking: w.lastReport.status === 'blocked' }) : null;
    if (owner?.touched.length) parts.push(`for the owner: ${clip(owner.touched.map(i => i.what).join('; '), 400)}`);
    // A done report that goes to landing is one event, with its outcome.
    const { note, evented } = w.lastReport.status === 'done' ? startLanding(run, w, parts) : { note: null, evented: false };
    if (!evented) addEvent(run, { worker: w.name, kind: 'report', text: parts.join(' — '), quiet: !WAKE_STATUSES.has(w.lastReport.status) });
    else saveRun(run);   // the landing job reads lastReport from run.json
    pumpQueue(run.runDir);   // a queued launch may wait on this worker
    if (run.mirror) relayMirror(run, { address: w.name, kind: 'report', status: w.lastReport.status, summary: mirrorSummary(w, owner) });
    return { ok: true, ...(note ? { landing: note } : {}), ...(owner ? { ownerItems: { added: owner.added, updated: owner.updated, ignored: owner.ignored } } : {}) };
  }

  // --- The owner's checklist (run.ownerItems) ---
  // The actions only the owner can do (Stop→Start, Build, Make live, approvals)
  // and the decisions waiting on the owner, gathered from the workers' reports
  // and kept right by the orchestrator (owner_items). A list in run.json, so it
  // survives a restart: { id, what, why, kind, options, recommended, key,
  // worker (the proposer), blocking, at, state: open|done|dropped, resolvedAt,
  // answer, resolvedBy }. An item is the same as another by its key, else by
  // its normalised `what` when either has none; an open one is updated, never duplicated, and a
  // resolved one is opened again only when its `why` is different.

  const OWNER_ITEM_MAX = 10;     // items one call may carry
  const OWNER_RESOLVED_KEPT = 30; // resolved items kept in run.json
  const OWNER_RESOLVED_SHOWN = 10;

  const normText = (v) => String(v ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const sameItem = (a, b) => (a.key && b.key) ? normText(a.key) === normText(b.key) : normText(a.what) === normText(b.what);

  // One item from the caller's fields; null when it has no `what`.
  function cleanOwnerItem(f) {
    if (!f || typeof f !== 'object') return null;
    const what = clip(String(f.what ?? '').replace(/\s+/g, ' ').trim(), 300);
    if (!what) return null;
    const kind = f.kind === 'decision' ? 'decision' : 'action';
    const options = kind === 'decision' && Array.isArray(f.options)
      ? f.options.map(o => clip(String(o ?? '').trim(), 120)).filter(Boolean).slice(0, 8) : [];
    const key = String(f.key ?? '').trim();
    const recommended = String(f.recommended ?? '').trim();
    return {
      what, kind,
      why: clip(String(f.why ?? '').trim(), 600),
      ...(options.length ? { options } : {}),
      ...(kind === 'decision' && recommended ? { recommended: clip(recommended, 120) } : {}),
      ...(key ? { key: clip(key, 80) } : {}),
      ...(f.blocking === true ? { blocking: true } : {}),
    };
  }

  // Adds or updates items in run.ownerItems (the caller saves the run).
  // { added, updated, ignored, touched: [item] }.
  function addOwnerItems(run, fields, { worker = null, blocking = false } = {}) {
    run.ownerItems ||= [];
    const out = { added: 0, updated: 0, ignored: 0, touched: [] };
    for (const f of fields.slice(0, OWNER_ITEM_MAX)) {
      const c = cleanOwnerItem(f);
      if (!c) { out.ignored++; continue; }
      const now = new Date().toISOString();
      const open = run.ownerItems.find(i => i.state === 'open' && sameItem(i, c));
      if (open) {
        Object.assign(open, { what: c.what, kind: c.kind, why: c.why || open.why, updatedAt: now });
        if (c.options) open.options = c.options; else if (c.kind === 'action') delete open.options;
        if (c.recommended) open.recommended = c.recommended;
        if (c.key) open.key = c.key;
        if (c.blocking || blocking) open.blocking = true;
        out.updated++; out.touched.push(open);
        continue;
      }
      // Resolved before, for the same reason: it stays resolved.
      const done = run.ownerItems.filter(i => i.state !== 'open' && sameItem(i, c)).pop();
      if (done && normText(done.why) === normText(c.why)) { out.ignored++; continue; }
      run.ownerSeq = (run.ownerSeq || 0) + 1;
      const item = { id: `o${run.ownerSeq}`, ...c, worker, at: now, state: 'open' };
      if (blocking && !item.blocking) item.blocking = true;
      run.ownerItems.push(item);
      out.added++; out.touched.push(item);
    }
    return out;
  }

  // The open items in the order the owner sees them: after a reorder, as
  // arranged; by default the ones that block others first, then oldest.
  function orderedOwnerItems(run) {
    const open = (run.ownerItems || []).filter(i => i.state === 'open');
    if (run.ownerManual) return open;
    return open.map((i, n) => [i, n]).sort(([a, x], [b, y]) => (b.blocking ? 1 : 0) - (a.blocking ? 1 : 0) || String(a.at).localeCompare(String(b.at)) || x - y).map(([i]) => i);
  }

  // What the dashboard gets: the open items in order, then the latest resolved.
  function ownerItemsView(run) {
    const resolved = (run.ownerItems || []).filter(i => i.state !== 'open')
      .sort((a, b) => String(b.resolvedAt).localeCompare(String(a.resolvedAt))).slice(0, OWNER_RESOLVED_SHOWN);
    return [...orderedOwnerItems(run), ...resolved];
  }

  // Resolve (done) or drop an open item. `by`: 'owner' (the dashboard) wakes the
  // orchestrator with an event and tells the proposing worker if it runs; 'orchestrator'
  // is recorded on the board only.
  function resolveOwnerItem(run, id, { state = 'done', answer = '', by = 'owner' } = {}) {
    const item = (run.ownerItems || []).find(i => i.id === String(id || '').trim());
    if (!item) throw new Error(`no owner item ${id} in run ${run.runId}`);
    if (item.state !== 'open') throw new Error(`owner item ${item.id} is already ${item.state}`);
    if (state !== 'done' && state !== 'dropped') throw new Error('state must be done or dropped');
    const ans = clip(String(answer ?? '').trim(), 600);
    if (state === 'done' && item.kind === 'decision' && !ans) throw new Error('a decision needs an answer');
    Object.assign(item, { state, resolvedAt: new Date().toISOString(), resolvedBy: by, ...(ans ? { answer: ans } : {}) });
    const closed = run.ownerItems.filter(i => i.state !== 'open');
    if (closed.length > OWNER_RESOLVED_KEPT) {
      const gone = new Set(closed.sort((a, b) => String(a.resolvedAt).localeCompare(String(b.resolvedAt))).slice(0, closed.length - OWNER_RESOLVED_KEPT));
      run.ownerItems = run.ownerItems.filter(i => !gone.has(i));
    }
    const verb = state === 'dropped' ? 'dropped' : item.kind === 'decision' ? 'decided' : 'did';
    const text = `${verb}: ${item.what}${ans ? ` — ${ans}` : ''}`;
    if (by === 'owner') {
      addEvent(run, { worker: item.worker || null, kind: 'owner', text: `owner ${text}` });
      const ts = item.worker ? run.workers.find(w => w.name === item.worker) : null;
      const live = ts ? workerSession(run, ts.id) : null;
      if (live?.session.running) {
        deliver(live.session, ts.name, `[message from the owner] ${text}`, 'owner');
        emitTo(live.session, run, { platform: { kind: 'message', from: 'owner', to: ts.name, text: `${text}` } });
      }
    } else {
      addEvent(run, { worker: item.worker || null, kind: 'owner', text: `owner item ${state === 'dropped' ? 'dropped' : 'closed'} by the orchestrator: ${item.what}${ans ? ` — ${ans}` : ''}`, delivered: true });
    }
    return item;
  }

  // The orchestrator's owner_items tool: list | add | resolve | drop | reorder.
  function ownerItems(instanceId, { action = 'list', items, item, id, answer, order } = {}) {
    const { session, run } = callerRun(instanceId, 'orchestrator');
    const from = session.getSettings().name || 'orchestrator';
    switch (action) {
      case 'list':
        return { ok: true, ownerItems: ownerItemsView(run) };
      case 'add': {
        const list = Array.isArray(items) ? items : item ? [item] : null;
        if (!list) throw new Error('add needs `items` (an array of { what, why, kind, options, recommended, key })');
        const r = addOwnerItems(run, list, { worker: from });
        saveRun(run);
        return { ok: true, added: r.added, updated: r.updated, ignored: r.ignored, ownerItems: ownerItemsView(run) };
      }
      case 'resolve':
      case 'drop': {
        resolveOwnerItem(run, id, { state: action === 'drop' ? 'dropped' : 'done', answer, by: 'orchestrator' });
        return { ok: true, ownerItems: ownerItemsView(run) };
      }
      case 'reorder': {
        if (!Array.isArray(order)) throw new Error('reorder needs `order`: the open items\' ids, first to last');
        const open = orderedOwnerItems(run);
        const byId = new Map(open.map(i => [i.id, i]));
        const named = [...new Set(order.map(String))].map(x => byId.get(x)).filter(Boolean);
        const rest = open.filter(i => !named.includes(i));
        const sorted = [...named, ...rest];
        run.ownerItems = [...sorted, ...run.ownerItems.filter(i => i.state !== 'open')];
        run.ownerManual = true;
        saveRun(run);
        return { ok: true, ownerItems: ownerItemsView(run) };
      }
      default:
        throw new Error('action must be list, add, resolve, drop or reorder');
    }
  }

  // The owner's view, over every run with an open item: [{ runId, name, title,
  // state, items }], runs with the most waiting first.
  function ownerList(runId) {
    const ids = runId ? [runId] : listRuns().map(r => r.runId);
    const out = [];
    for (const rid of ids) {
      const run = getRun(rid);
      if (!run) continue;
      const items = orderedOwnerItems(run);
      if (!items.length && !runId) continue;
      const orch = orchestratorSession(run);
      out.push({ runId: rid, name: run.orchestrator, title: orch?.session.title || null, items: runId ? ownerItemsView(run) : items });
    }
    return out.sort((a, b) => b.items.length - a.items.length);
  }

  function ownerResolve({ runId, id, action, answer } = {}) {
    const run = getRun(String(runId || ''));
    if (!run) throw new Error('run not found');
    const state = action === 'drop' ? 'dropped' : action === 'done' ? 'done' : null;
    if (!state) throw new Error('action must be done or drop');
    resolveOwnerItem(run, id, { state, answer, by: 'owner' });
    return { ok: true, ownerItems: ownerItemsView(run) };
  }

  // --- Messages between run members (SendMessage / ListAgents) ---

  // The run's members, by address: the orchestrator, then every worker.
  function members(run) {
    const out = [{ name: run.orchestrator, role: 'orchestrator', id: null, title: 'orchestrator', worker: null, live: orchestratorSession(run) }];
    for (const w of run.workers) out.push({ name: w.name, role: 'worker', id: w.id, title: w.title, worker: w, live: liveOf(run, w) });
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

  // Messages waiting for a busy CLI member's next hook live in <runDir>/inbox.json
  // ({ name: [message, …] }, oldest first), so a restart does not lose them:
  // the restored member's SessionStart or next hook takes them. A file of its
  // own, not run.json: a caller holding an older run object would save over
  // them. All access is synchronous, in this one process.
  function inboxFile(runDir) { return path.join(runDir, 'inbox.json'); }

  function writeInbox(runDir, all) {
    try {
      if (Object.keys(all).length) writeJsonAtomic(inboxFile(runDir), all);
      else fs.rmSync(inboxFile(runDir), { force: true });
    } catch (e) { console.error('[orchestration] inbox write error:', e.message); }
  }

  function queueMessage(runDir, name, body) {
    const all = readJsonOr(inboxFile(runDir), {});
    all[name] = [...(all[name] || []), body];
    writeInbox(runDir, all);
  }

  function dropInbox(runDir, name) {
    const all = readJsonOr(inboxFile(runDir), {});
    if (!(name in all)) return;
    delete all[name];
    writeInbox(runDir, all);
  }

  // A member's waiting messages, joined, or null; taken (removed) when
  // returned. `room`: left waiting when they need more than that.
  function takeInbox(runDir, name, room = CONTEXT_LIMIT) {
    const all = readJsonOr(inboxFile(runDir), {});
    const q = all[name];
    if (!q?.length) return null;
    const text = q.join('\n\n');
    if (room < CONTEXT_LIMIT && text.length > room) return null;
    delete all[name];
    writeInbox(runDir, all);
    return clip(text, CONTEXT_LIMIT);
  }

  const joinContext = (...parts) => parts.filter(Boolean).join('\n\n') || null;

  // Keep what the orchestrator told a worker after its brief (the last 10): a
  // reused worker's current task, for its recap, a fresh restart and the seed.
  function addFollowUp(run, workerId, text) {
    const w = run?.workers.find(x => x.id === workerId);
    if (!w) return;
    w.followUps = [...(w.followUps || []), { at: new Date().toISOString(), text: clip(text, 2000) }].slice(-10);
    saveRun(run);
  }

  // A worker's follow-ups under `heading`, oldest first, within `budget` chars:
  // the newest are kept, older ones left out. '' when there are none.
  function followUpsText(w, heading, budget) {
    const list = w.followUps || [];
    if (!list.length) return '';
    const lines = [];
    let used = heading.length;
    for (let i = list.length - 1; i >= 0; i--) {
      const line = `- ${list[i].at}: ${list[i].text}`;
      if (used + line.length + 1 > budget) { lines.unshift(`- (${i + 1} older follow-up(s) left out)`); break; }
      lines.unshift(line);
      used += line.length + 1;
    }
    return [heading, ...lines].join('\n');
  }

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
    if (run.mirror && target.role === 'orchestrator') {
      const how = relayMirror(run, { address: from, kind: 'message', text });
      emitTo(session, run, { platform: { kind: 'message', from, to: target.name, text } });
      return { ok: true, to: target.name, delivery: how };
    }
    const ts = target.live?.session;
    if (target.worker?.remote && !ts?.running) {
      const st = remoteState(run, target.worker, target.live);
      throw new Error(`${target.name} (on ${target.worker.host}) is ${st}${st === 'pending-approval' ? ': it gets its brief when the owner approves; nothing to send to yet' : ''}`);
    }
    if (!ts?.running) {
      throw new Error(target.role === 'worker'
        ? `${target.name} is not running${target.worker.paused ? ' (paused)' : ''}${stamp.role === 'orchestrator' ? ': bring it back with resume_worker, passing this as its message' : ''}`
        : `the orchestrator ${target.name} is not running`);
    }
    const delivery = target.worker?.remote
      ? submitRemote(ts, target.name, `[message from ${from}] ${text}`, from)
      : deliver(ts, target.name, `[message from ${from}] ${text}`, from);
    if (stamp.role === 'orchestrator' && target.role === 'worker') {
      delete target.worker.turnStopped;   // its new instructions: no longer a stopped worker
      addFollowUp(run, target.id, text);
    }
    const ev = { platform: { kind: 'message', from, to: target.name, text } };
    emitTo(session, run, ev);
    if (!target.worker?.remote) emitTo(ts, run, ev);   // a remote tab's events are its provider's
    return { ok: true, to: target.name, delivery };
  }

  // Into a running member: an SDK session takes it as a next-priority turn, an
  // idle CLI has it typed, a busy CLI gets it through its next hook (inbox).
  function deliver(ts, name, body, from) {
    if (ts.kind === 'sdk') {
      ts.submit(body, { priority: 'next', from });
    } else if (!ts.busy || !stampOf(ts)?.runDir) {
      ts.submit(body, { from });
    } else {
      queueMessage(stampOf(ts).runDir, name, body);
      return 'queued';
    }
    return 'submitted';
  }

  // Into a remote member: its tab adapter's submit(text, { from }). A refusal
  // comes back after this returns: logged, not thrown.
  function submitRemote(ts, name, body, from) {
    ts.call('submit', body, { from }).catch(e => console.error(`[orchestration] message to ${name}:`, e.message));
    return 'submitted';
  }

  // ctx.sendToSession (src/addon-host.js): a message from outside the run (an
  // add-on, e.g. 'apps' when a long tool job finished) into a run session by
  // its address, delivered like SendMessage. { delivered, how }.
  function sendToSession(address, text, { from } = {}) {
    const body = String(text ?? '').trim();
    if (!body) throw new Error('text is required');
    const sender = String(from || '').trim() || 'vistaclair';
    const want = String(address || '').trim();
    const named = findByStamp(() => true).filter(m => m.session.getSettings().name === want);
    const hit = named.find(m => m.session.running) || named[0];
    if (!hit) return { delivered: false, how: 'no session with that address' };
    if (!hit.session.running) return { delivered: false, how: 'not running' };
    const how = deliver(hit.session, want, `[message from ${sender}] ${body}`, sender);
    emitTo(hit.session, { runId: hit.stamp.runId }, { platform: { kind: 'message', from: sender, to: want, text: body } });
    return { delivered: true, how };
  }

  // ListAgents: the caller's run, every member with its state.
  function listAgents(instanceId) {
    const { session, run } = callerRun(instanceId);
    return {
      you: session.getSettings().name || null,
      runId: run.runId,
      agents: members(run).map(m => ({
        name: m.name, role: m.role, title: m.title,
        state: m.worker?.remote ? remoteState(run, m.worker, m.live) : run.mirror && m.role === 'orchestrator' ? `on ${run.mirror.host}` : memberState(m.live?.session, m.worker),
        ...(m.worker?.host ? { host: m.worker.host } : {}),
        ...(m.worker?.lastReport ? { lastReport: `${m.worker.lastReport.status}: ${clip(m.worker.lastReport.summary, 200)}` } : {}),
      })),
    };
  }

  // --- Events and delivery ---

  // `delivered`: recorded for the run board only (the orchestrator caused it),
  // unless older events still wait, which carry it along. `quiet`: recorded
  // and shown as any other, but it does not wake an idle orchestrator; it
  // rides along with the next delivery, or the safety valve pushes once.
  function addEvent(run, { worker, kind, text, delivered = false, quiet = false }) {
    const seq = (run.events.length ? run.events[run.events.length - 1].seq : 0) + 1;
    run.events.push({ seq, at: new Date().toISOString(), worker, kind, text, ...(quiet ? { quiet: true } : {}) });
    if (run.events.length > 200) run.events = run.events.slice(-200);
    if (delivered && run.delivered === seq - 1) run.delivered = seq;
    // A mirror run's orchestrator is on another machine: nothing waits here.
    if (run.mirror) run.delivered = seq;
    const pending = run.delivered < seq;
    if (pending && quiet && !run.quietValve) run.quietValve = { due: new Date(Date.now() + quietValveMs).toISOString() };
    saveRun(run);
    if (!pending) return;
    if (quiet) armValve(run);
    else schedulePush(run.runId);
  }

  // The quiet events' safety valve: undelivered past run.quietValve.due, they
  // push the orchestrator once (fired). The state is in run.json; the timer is
  // re-armed by loadRun after a restart. Delivery clears it (takeEvents).
  function armValve(run) {
    const v = run.quietValve;
    if (!v || v.fired || valveTimers.has(run.runId)) return;
    const runId = run.runId;
    const t = setTimeout(() => {
      valveTimers.delete(runId);
      const fresh = getRun(runId);
      const fv = fresh?.quietValve;
      if (!fv || fv.fired) return;
      // A newer valve (the old one was delivered, new quiet events came): wait for its time.
      if (Date.parse(fv.due) > Date.now() + 50) { armValve(fresh); return; }
      if (!fresh.events.some(e => e.seq > fresh.delivered)) { delete fresh.quietValve; saveRun(fresh); return; }
      fv.fired = true;
      saveRun(fresh);
      schedulePush(runId);
    }, Math.max(0, Date.parse(v.due) - Date.now()));
    t.unref?.();
    valveTimers.set(runId, t);
  }

  // The pending events as one context block: wake items first, whole, then the
  // newest quiet ones as one-liners (at most QUIET_SHOWN, the rest counted).
  // The limit never cuts a wake item: quiet lines go first, and wake items
  // that do not fit stay pending (with everything after them) for the next
  // delivery. `wakeOnly`: null unless a wake item is pending. Null when none.
  function takeEvents(run, { wakeOnly = false } = {}) {
    const fresh = run.events.filter(e => e.seq > run.delivered);
    if (!fresh.length) return null;
    if (wakeOnly && fresh.every(e => e.quiet)) return null;
    const budget = CONTEXT_LIMIT - 300;   // the heading and the "+N more" line
    const line = (e, n) => `- [${e.kind}] ${clip(e.quiet ? String(e.text || '').replace(/\s+/g, ' ') : e.text, n)}`;
    const wake = [];
    let used = 0;
    let cut = null;
    for (const e of fresh) {
      if (e.quiet) continue;
      const l = line(e, EVENT_ITEM_LIMIT);
      if (wake.length && used + l.length + 1 > budget) { cut = e.seq; break; }
      wake.push(l);
      used += l.length + 1;
    }
    const taken = cut ? fresh.filter(e => e.seq < cut) : fresh;
    const quiet = taken.filter(e => e.quiet);
    const shown = [];
    for (let i = quiet.length - 1; i >= 0 && shown.length < QUIET_SHOWN; i--) {
      const l = line(quiet[i], 300);
      if (used + l.length + 1 > budget) break;
      shown.unshift(l);
      used += l.length + 1;
    }
    const more = quiet.length - shown.length;
    run.delivered = taken[taken.length - 1].seq;
    if (!run.events.some(e => e.quiet && e.seq > run.delivered)) delete run.quietValve;
    saveRun(run);
    const lines = [...wake, ...shown, ...(more ? [`- +${more} more on the run board`] : [])];
    const text = `[orchestration] ${taken.length} worker event(s) — act on them and update TODO.md:\n${lines.join('\n')}`;
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

  // Core's exit listener: a worker exit becomes an event (and tears its
  // worktree down when it can); an orchestrator exit
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
    // A shutdown exit: it holds its slot until it is back (awaitingRestore).
    if (mgr._shuttingDown) w.shutdownAt = w.exitedAt;
    else delete w.shutdownAt;
    if (typeof session.costUsd === 'number') w.costUsd = session.costUsd;
    addEvent(run, { worker: w.name, kind: 'exited', text: `${w.name} exited${w.lastReport ? ` (last report: ${w.lastReport.status})` : ' without reporting'}` });
    // Its worktree goes when merged and clean — not at a server shutdown,
    // which exits every session that is restored at the next boot.
    if (w.worktree && !mgr._shuttingDown) { teardownWorker(run, w); saveRun(run); }
    pumpQueue(run.runDir);   // its slot is free (never at a shutdown: pumpOnce)
  }

  // --- Hooks ---

  function workerLine(w) {
    const state = w.host
      ? `on ${w.host}: ${w.running ? (w.available ? 'running, finished — close_worker if not reused' : 'running') : w.state}`
      : w.running ? (w.available ? 'running, finished — close_worker if not reused' : 'running') : w.paused ? 'paused — resume_worker brings it back' : w.closed ? 'closed — resume_worker brings it back' : w.abandoned ? 'abandoned' : 'stopped';
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
    // The follow-ups come first in the budget: they hold the current task.
    const ups = followUpsText(w, 'Follow-ups from your orchestrator, oldest first (the newest is your current task):', 4000);
    return [
      `[orchestration] Context restored. You are WORKER \`${w.name}\` of run ${run.runId}, launched by \`${run.orchestrator}\`; your role card in the system prompt still applies. Report with the \`report\` tool; delegate to \`coder\` / \`explorer\`.`,
      'Your original brief:', clip(w.task, Math.min(4000, CONTEXT_LIMIT - ups.length - 1200)),
      ...(ups ? [ups] : []),
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
    const events = (opts) => (run.pausing ? null : takeEvents(run, opts));
    const inboxOf = (room) => takeInbox(run.runDir, name, room);

    switch (ev) {
      case 'SessionStart': {
        const src = input.source;
        if (src === 'startup' || src === 'resume' || src === 'clear') { v.agents = 0; v.reported = false; v.nudged = false; v.stopping = false; }
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
            if (!run.paused) pumpQueue(run.runDir);
          }
        }
        // Messages queued before a restart (inbox.json) come with the start.
        if (src !== 'compact' && src !== 'resume') return ctxOut('SessionStart', inboxOf());
        let text = recap(run, stamp);
        if (isOrch) {
          const ev2 = events();
          if (ev2) text += `\n\n${ev2}`;
        }
        text = clip(text, CONTEXT_LIMIT);
        // Only when they fit whole; else the next hook brings them.
        return ctxOut('SessionStart', joinContext(text, inboxOf(CONTEXT_LIMIT - text.length - 2)));
      }
      case 'UserPromptSubmit': {
        if (!isOrch) { v.reported = false; v.nudged = false; v.stopping = false; return ctxOut('UserPromptSubmit', inboxOf()); }
        run.busy = true;
        // The run's original request, for a fresh orchestrator's seed: the first
        // prompt that is not one of the dashboard's own notices.
        const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
        if (!run.request && prompt && !prompt.startsWith('[')) run.request = clip(prompt, 8000);
        saveRun(run);
        return ctxOut('UserPromptSubmit', joinContext(inboxOf(), events()));
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
          // Only a report that hands the turn back counts: "started" and
          // progress reports do not (a worker waiting on a peer must say so).
          if (/(^|__)report$/.test(tool) && WAKE_STATUSES.has(input.tool_input?.status)) v.reported = true;
          return ctxOut('PostToolUse', inboxOf());
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
        return ctxOut('PostToolUse', joinContext(inboxOf(), events()));
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
          // Quiet events alone do not keep it working: they wait for the next delivery.
          const msgs = inboxOf();
          const pending = joinContext(msgs, events({ wakeOnly: !msgs }));
          if (pending) return { stdout: JSON.stringify({ decision: 'block', reason: pending }) };
          run.busy = false;
          saveRun(run);
          return {};
        }
        // The orchestrator stopped this turn (stop_worker): it ends here.
        if (v.stopping) { v.stopping = false; return {}; }
        // A message arrived during the turn: it continues with it.
        const msgs = inboxOf();
        if (msgs) return { stdout: JSON.stringify({ decision: 'block', reason: msgs }) };
        // Still working in the background (subagents, background shells): not idle.
        if (Array.isArray(input.background_tasks) && input.background_tasks.length) return {};
        if (v.reported) return {};
        if (!v.nudged && !input.stop_hook_active) {
          v.nudged = true;
          return { stdout: JSON.stringify({ decision: 'block', reason: `Before ending this turn, report to the orchestrator \`${run.orchestrator}\` with the \`report\` tool (status, summary, filesChanged, verified, open). The status must be done, failed, blocked (name whom you wait for and what) or paused; "started" or a progress report does not end a turn, nor does a message to another worker.` }) };
        }
        const last = run.workers.find(x => x.id === stamp.workerId)?.lastReport;
        const head = last ? `${name} went idle; last report: ${last.status} (${clip(last.summary, 200)}).` : `${name} went idle without reporting.`;
        addEvent(run, { worker: name, kind: 'idle', text: `${head} Its last message: ${clip(input.last_assistant_message, 500)}` });
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
    const call = (fn) => async (req, res) => {
      try { res.json((await fn(req.body || {})) || {}); } catch (e) { res.json({ error: e.message }); }
    };
    r.post('/hook', (req, res) => {
      try { res.json(handleHook(req.body?.instanceId, req.body?.input)); } catch (e) {
        console.error('[orchestration] hook error:', e.message);
        res.json({});
      }
    });
    r.post('/launch', call(b => launchWorker(b.instanceId, b)));
    r.post('/cancel-launch', call(b => cancelLaunch(b.instanceId, b)));
    r.post('/workers', call(b => listWorkers(b.instanceId)));
    r.post('/end', call(b => endRun(b.instanceId)));
    r.post('/undo-landing', call(b => undoLanding(b.instanceId, b)));
    r.post('/report', call(b => report(b.instanceId, b)));
    r.post('/resume-worker', call(b => resumeWorker(b.instanceId, b)));
    r.post('/close-worker', call(b => closeWorker(b.instanceId, b)));
    r.post('/stop-worker', call(b => stopWorker(b.instanceId, b)));
    r.post('/send-message', call(b => sendMessage(b.instanceId, b)));
    r.post('/list-agents', call(b => listAgents(b.instanceId)));
    r.post('/tool-params', call(() => toolParams()));
    r.post('/owner-items', call(b => ownerItems(b.instanceId, b)));
    // The run board (GUI).
    r.post('/pause', call(b => pauseRun(String(b.runId || ''))));
    r.post('/refresh', call(b => refreshOrchestrator(String(b.runId || ''))));
    r.post('/resume-run', call(b => resumeRun(String(b.runId || ''), { fresh: b.fresh === true })));
    r.post('/delete-run', call(b => deleteRun(String(b.runId || ''), { force: b.force === true })));
    // The owner's checklist (GUI): GET lists, one run's or every run's open
    // items; POST resolves (done, with an answer for a decision) or drops one.
    r.get('/owner-items', (req, res) => {
      try { res.json({ runs: ownerList(String(req.query.runId || '') || null) }); } catch (e) { res.status(400).json({ error: e.message }); }
    });
    r.post('/owner-resolve', call(b => ownerResolve(b)));
    r.get('/run', (req, res) => {
      const run = getRun(String(req.query.runId || ''));
      // A run whose orchestrator is an external session (another machine's):
      // its members as that session's adapter describes them.
      const ext = run ? null : mgr.externalOrchestration?.(String(req.query.runId || ''));
      if (ext) {
        return ext.then((d) => res.json(d && typeof d === 'object' ? d : {}))
          .catch((e) => { if (!res.headersSent) res.status(502).json({ error: e.message }); });
      }
      if (!run) return res.status(404).json({ error: 'run not found' });
      res.json({ ...describeRun(run), todoText: readTodo(run), events: run.events.slice(-30) });
    });
    return r;
  }

  return {
    router, openCli, askUser, prepareRun, launchWorker, cancelLaunch, listWorkers, endRun, undoLanding, landingOf, checkOverlaps, report, ownerItems, ownerList, ownerResolve, sendMessage, listAgents, sendToSession, toolParams,
    handleHook, onSessionExit, getRun, describeRun, describeRunById, listRuns, findByStamp, writeSessionSettings,
    pauseRun, refreshOrchestrator, resumeRun, resumeWorker, closeWorker, stopWorker, resumeSavedWorker, deleteRun, closeCheck, noteMemberDeleted, memberDirty,
    memberModelChanged, setRunModelMap, setRunAuth, setRunModel, registerHostProvider, hostList, openMirrorRun,
    MAX_WORKERS, MAX_SUBAGENTS, WORKER_AGENTS,
  };
}

module.exports = { createOrchestration, orchestratorCard, workerCard, WORKER_AGENTS, MAX_WORKERS, MAX_SUBAGENTS };
