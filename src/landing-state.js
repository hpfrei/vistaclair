// What a worktree worker's landing came to, as the dashboard shows it on the
// worker's box (public/sdk-panel.js) and run card (src/run-summary.js). Read
// from its run.json entry: `landingResult` (src/orchestration.js noteLanding:
// outcome landing | landed | nothing | not landed, the report's `at`, sha,
// base, reason) and `landing` (a landing in flight). Pure: no git, no I/O.
//
// landingView(w, { inFlight, landings }) → null (not a worktree worker, or
// none yet) or { state, base, sha, reason, at, current, undone }:
//   state    landing | landed | not-landed | nothing (no new commits to land)
//   current  it belongs to the worker's last report (false: reported since)
//   undone   the revert's sha when undo_landing reverted it
// `inFlight` (true / false / undefined: unknown, as in a reader of run.json
// without the server's jobs) says whether a landing job runs now; a recorded
// `landing` with none running (a restart cut it off) reads not-landed.

function landingView(w, { inFlight, landings = [] } = {}) {
  if (!w?.branch) return null;
  const r = w.landingResult || null;
  const running = inFlight === undefined ? !!w.landing || r?.outcome === 'landing' : !!inFlight || !!w.landing;
  if (running) {
    return { state: 'landing', base: w.base || r?.base || null, sha: null, reason: null, at: w.landing?.at || r?.at || null, current: true, undone: null };
  }
  if (!r) return null;
  const state = r.outcome === 'landed' ? 'landed' : r.outcome === 'nothing' ? 'nothing' : 'not-landed';
  const reason = state === 'not-landed' ? (r.outcome === 'landing' ? 'the landing was cut off before it finished; report done again' : r.reason || null) : null;
  const sha = state === 'landed' ? r.sha || null : null;
  const rec = sha ? landings.find(l => l.mergeSha === sha) : null;
  return {
    state, base: r.base || w.base || null, sha, reason, at: r.at || null,
    current: !w.lastReport || !r.report || r.report === w.lastReport.at,
    undone: rec?.undone?.revertSha || null,
  };
}

module.exports = { landingView };
