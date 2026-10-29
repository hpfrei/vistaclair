#!/usr/bin/env node
// End-to-end check of pause / resume with real Claude Code sessions (haiku).
// Not part of `npm test`: it spends tokens and takes minutes.
//
//   node test/e2e/pause-resume.e2e.js [--only plain|run] [--variant continue|lost] [--keep-files]
//
// Two scenarios, each run in two variants that must reach the same end state:
//   plain  one CLI tab: TODO (1) write a file, (2) a background "validation"
//          (`sleep`), (3) write a second file. Paused while (2) runs.
//   run    an orchestrator with one worker doing the same three steps. The
//          whole run is paused while the worker's validation runs.
//   continue  resume with the saved conversations (`--resume`).
//   lost      the transcripts are deleted after the pause, as if the owner had
//             removed them: the resume falls back to fresh sessions that
//             continue from TODO.md / NOTES.md (and, for a run, RESTART.md and
//             the worker's brief).
// End state, both variants: both files with the right content, every TODO row
// done, and (run) the worker's last report "done".
//
// Isolation: a temp VISTACLAIR_HOME, the real CliSessionManager, session
// control and orchestration on an ephemeral loopback port, no proxy (the CLI
// uses its own login). It never talks to a running dashboard. The user-level
// hook reporter (~/.claude/settings.json) reports to this port because the
// sessions are spawned with it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const ONLY = opt('--only');
const VARIANT = opt('--variant');
const KEEP = args.includes('--keep-files');

// A clean environment: a session started from inside another Claude Code
// session (or a dashboard tab) would otherwise inherit its identity.
for (const k of Object.keys(process.env)) {
  if (/^(CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$|VISTACLAIR_)/.test(k) || k === 'ANTHROPIC_BASE_URL' || k === 'ANTHROPIC_MODEL') delete process.env[k];
}
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-e2e-')));
process.env.VISTACLAIR_HOME = path.join(ROOT, 'home');
fs.mkdirSync(path.join(ROOT, 'home', 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'home', 'data', 'app-prefs.json'), JSON.stringify({ cliModel: 'haiku' }));

const CORE = path.join(__dirname, '..', '..');
const express = require(path.join(CORE, 'node_modules', 'express'));
const CliSessionManager = require(path.join(CORE, 'src', 'cli-sessions'));
const { createSessionControl } = require(path.join(CORE, 'src', 'session-control'));
const { createOrchestration } = require(path.join(CORE, 'src', 'orchestration'));
const folders = require(path.join(CORE, 'src', 'session-folders'));

const LOG = path.join(ROOT, 'events.log');
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const log = (...a) => fs.appendFileSync(LOG, `${stamp()} ${a.join(' ')}\n`);
const say = (...a) => { console.log(stamp(), ...a); log('##', ...a); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function until(what, fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(2000);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

// --- The harness: the dashboard's wiring, minus the proxy and the GUI ---

let mgr, control, orch, orchRouter;
const pausedEvents = [];
const app = express();
app.use(express.json({ limit: '5mb' }));
app.post('/api/hook-report', (req, res) => {
  try {
    const hookData = typeof req.body.hookData === 'string' ? JSON.parse(req.body.hookData) : req.body.hookData;
    const s = mgr.getByInstanceId(req.body.instanceId);
    log('hook', s ? (s.getSettings().name || s.title) : '?', hookData.hook_event_name, hookData.tool_name || hookData.source || '');
    // Run members are answered by orchestration's own hook (one reply per event).
    res.json(s && !s.getSettings().orchestration ? control.reply(req.body.instanceId, hookData) : {});
  } catch (e) { log('hook error', e.message); res.json({}); }
});
app.use('/api/orchestration', (req, res, next) => {
  if (req.path !== '/hook') log('orchestration', req.path, JSON.stringify(req.body).slice(0, 160));
  next();
}, (req, res, next) => (orchRouter ||= orch.router())(req, res, next));

const server = http.createServer(app);

function start() {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const broadcaster = { broadcast(m) { if (m.type === 'cli:paused') { pausedEvents.push(m); log('paused', m.title, m.interrupted ? '(interrupted)' : ''); } } };
    const store = { registerSession() {}, unregisterSession() {}, loadSessionIntoMemory: () => [], deleteSessionData() {} };
    mgr = new CliSessionManager(null, broadcaster, store, { authToken: 'e2e', dashboardPort: port });
    control = createSessionControl({ mgr, broadcaster });
    orch = createOrchestration({ mgr, broadcaster, pendingQuestions: new Map(), coreRoot: CORE, dataHome: process.env.VISTACLAIR_HOME, control });
    mgr.addExitListener(orch.onSessionExit);
    resolve(port);
  }));
}

// --- Helpers ---

const sleepRunning = (secs) => {
  try { return execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).split('\n').some(l => l.trim() === `sleep ${secs}`); } catch { return false; }
};
const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return null; } };
const transcript = (cwd, id) => path.join(os.homedir(), '.claude', 'projects', cwd.replace(/\//g, '-'), `${id}.jsonl`);
function deleteTranscript(cwd, id) {
  const f = transcript(cwd, id);
  fs.rmSync(f, { force: true });
  fs.rmSync(f.replace(/\.jsonl$/, ''), { recursive: true, force: true });
}
function todoDone(dir) {
  const f = folders.readFolder(dir);
  return !!(f && f.progress.total >= 3 && f.progress.done === f.progress.total);
}
const idle = (s) => s && s.running && !s.busy;
const steps = (dir, secs, first, second) =>
  `(1) create ${first[0]} containing ${first[1]}; (2) validation: run the test suite, which is the shell command 'sleep ${secs}', in the background (Bash with run_in_background) and wait until it has finished; (3) create ${second[0]} containing ${second[1]}.`;

// --- Scenarios ---

async function plain(variant) {
  const cwd = path.join(ROOT, `plain-${variant}`);
  fs.mkdirSync(cwd);
  const secs = variant === 'lost' ? 29 : 27;
  const tabId = mgr.nextTabId();
  mgr.launchSession(tabId, {
    cwd, cols: 140, rows: 40, title: `plain-${variant}`, autoSubmit: true,
    prompt: `First list these steps as rows of your session folder's TODO.md, then do them in order: ${steps(null, secs, ['a.txt', 'hello'], ['b.txt', 'world'])} Keep TODO.md current.`,
  });
  const s = mgr.get(tabId);
  const dir = s.getSettings().sessionDir;
  await until(`plain-${variant}: the validation running`, () => sleepRunning(secs), 180000);
  say(`plain-${variant}: validation running; pausing`);
  const n = pausedEvents.length;
  control.pause(tabId);
  await until(`plain-${variant}: paused`, () => pausedEvents.length > n, 300000);
  const sessId = s.sessId;
  say(`plain-${variant}: paused (resume note: ${folders.readFolder(dir)?.resume ? 'yes' : 'NO'})`);
  if (variant === 'lost') { deleteTranscript(cwd, sessId); say(`plain-${variant}: transcript deleted`); }
  const r = control.resumeSaved(sessId, { cols: 140, rows: 40 });
  say(`plain-${variant}: resumed (${r.fresh ? 'fresh session' : 'own conversation'})`);
  await until(`plain-${variant}: end state`, () =>
    read(path.join(cwd, 'b.txt')) === 'world' && todoDone(dir) && idle(mgr.get(r.tabId)), 420000);
  return {
    scenario: `plain-${variant}`, fresh: !!r.fresh,
    a: read(path.join(cwd, 'a.txt')), b: read(path.join(cwd, 'b.txt')), todoDone: todoDone(dir),
  };
}

async function run(variant) {
  const cwd = path.join(ROOT, `run-${variant}`);
  fs.mkdirSync(cwd);
  const secs = variant === 'lost' ? 33 : 31;
  const logFrom = fs.statSync(LOG).size;
  const { tabId } = await orch.openCli({
    cwd, cols: 140, rows: 40, title: `run-${variant}`, mode: 'orchestrator', isolation: 'none', autoSubmit: true,
    prompt: `Launch exactly one worker with launch_cli, title 'files'. Its brief: ${steps(null, secs, ['c.txt', 'x'], ['d.txt', 'y'])} Then report done. After launching it, end your turn and wait for its reports; when it reports done, check c.txt and d.txt and reply FINISHED.`,
  });
  const o = mgr.get(tabId);
  const runId = o.getSettings().orchestration.runId;
  await until(`run-${variant}: the worker's validation running`, () => sleepRunning(secs), 240000);
  say(`run-${variant}: worker validation running; pausing the run`);
  orch.pauseRun(runId);
  await until(`run-${variant}: paused`, () => orch.getRun(runId).paused, 420000);
  const r1 = orch.getRun(runId);
  const w = r1.workers[0];
  say(`run-${variant}: paused (worker report: ${w.lastReport?.status}, worker note: ${folders.readFolder(w.sessionDir)?.resume ? 'yes' : 'NO'}, orchestrator note: ${folders.readFolder(r1.orchestratorDir)?.resume ? 'yes' : 'NO'})`);
  const workerSessId = () => [...mgr.sessions.values()].find(s => s.getSettings().orchestration?.runId === runId && s.getSettings().orchestration.role === 'worker')?.sessId
    || mgr.listSaved().find(e => e.settings?.orchestration?.runId === runId && e.settings.orchestration.role === 'worker')?.id;
  const pausedWorker = workerSessId();
  if (variant === 'lost') {
    for (const e of mgr.listSaved().filter(e => e.settings?.orchestration?.runId === runId)) deleteTranscript(e.cwd, e.id);
    say(`run-${variant}: transcripts deleted`);
  }
  const res = orch.resumeRun(runId);
  say(`run-${variant}: resumed (${res.fresh ? 'fresh orchestrator' : 'own conversation'})`);
  await until(`run-${variant}: end state`, () => {
    const r = orch.getRun(runId);
    const wk = r.workers[0];
    return read(path.join(cwd, 'd.txt')) === 'y' && wk.lastReport?.status === 'done' && todoDone(wk.sessionDir);
  }, 600000);
  const r = orch.getRun(runId);
  const resumes = fs.readFileSync(LOG, 'utf8').slice(logFrom).split('\n').filter(l => l.includes('/resume-worker')).map(l => (l.match(/"mode":"(\w+)"/) || [])[1]);
  return {
    scenario: `run-${variant}`, fresh: !!res.fresh, resumeWorker: resumes.join(',') || 'none', workerFresh: workerSessId() !== pausedWorker,
    c: read(path.join(cwd, 'c.txt')), d: read(path.join(cwd, 'd.txt')),
    todoDone: todoDone(r.workers[0].sessionDir), report: r.workers[0].lastReport?.status,
  };
}

// --- Main ---

async function cleanup() {
  for (const s of mgr?.sessions.values() || []) { try { s.kill(); } catch {} }
  // A CLI writes a last transcript line as it exits: let them go first.
  await until('the sessions to exit', () => ![...(mgr?.sessions.values() || [])].some(s => s.running), 15000).catch(() => {});
  await wait(2000);
  // Background shells the sessions left behind, and the transcripts.
  for (const p of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x))) {
    try { if (fs.readlinkSync(`/proc/${p}/cwd`).startsWith(ROOT) && Number(p) !== process.pid) process.kill(Number(p), 'SIGTERM'); } catch {}
  }
  const ids = mgr ? mgr.listSaved().map(e => e.id) : [];
  for (const id of ids) for (const d of ['file-history', 'session-env', 'tasks']) fs.rmSync(path.join(os.homedir(), '.claude', d, id), { recursive: true, force: true });
  const projects = path.join(os.homedir(), '.claude', 'projects');
  const prefix = ROOT.replace(/\//g, '-');
  try { for (const d of fs.readdirSync(projects)) if (d.startsWith(prefix)) fs.rmSync(path.join(projects, d), { recursive: true, force: true }); } catch {}
  server.close();
  if (KEEP) console.log(`files kept in ${ROOT}`);
  else fs.rmSync(ROOT, { recursive: true, force: true });
}

(async () => {
  const port = await start();
  say(`harness on 127.0.0.1:${port}, data in ${ROOT} (log: ${LOG})`);
  const variants = VARIANT ? [VARIANT] : ['continue', 'lost'];
  const results = [];
  let failed = false;
  try {
    for (const sc of ONLY ? [ONLY] : ['plain', 'run']) {
      for (const v of variants) {
        try { results.push(await (sc === 'plain' ? plain : run)(v)); } catch (e) {
          failed = true;
          say(`FAILED ${sc}-${v}: ${e.message}`);
          if (KEEP) say(`see ${LOG}`);
        }
      }
    }
  } finally {
    console.table(results);
    const want = { plain: { a: 'hello', b: 'world' }, run: { c: 'x', d: 'y', report: 'done' } };
    for (const r of results) {
      const exp = want[r.scenario.split('-')[0]];
      const bad = Object.entries(exp).filter(([k, v]) => r[k] !== v).concat(r.todoDone ? [] : [['todoDone', true]]);
      if (bad.length) { failed = true; console.log(`${r.scenario}: wrong end state:`, bad.map(([k]) => k).join(', ')); }
      if (r.scenario.endsWith('lost') && (!r.fresh || r.workerFresh === false)) { failed = true; console.log(`${r.scenario}: expected a fresh fallback`); }
      if (r.scenario.endsWith('continue') && (r.fresh || r.workerFresh)) { failed = true; console.log(`${r.scenario}: expected its own conversation`); }
    }
    console.log(failed ? 'E2E FAILED' : 'E2E PASSED: continue and lost reach the same end state');
    await cleanup();
    process.exit(failed ? 1 : 0);
  }
})();
