// A worktree worker's landing as the dashboard shows it: src/landing-state.js
// (from its run.json entry) and the worker box's chip and line
// (public/sdk-panel.js landingLabel / reportChip). The recording itself is in
// test/orchestration.test.js ("landing state: …").
//
//   node --test test/

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert');
const { landingView } = require('../src/landing-state');

const at = '2026-11-09T10:00:00.000Z';
const worker = (landingResult, extra = {}) => ({ branch: 'orch/r/w1', base: 'main', lastReport: { status: 'done', at }, landingResult, ...extra });

test('landingView: none for a worker without a branch or a landing yet', () => {
  assert.strictEqual(landingView({ lastReport: { status: 'done', at } }), null);
  assert.strictEqual(landingView(worker(undefined), { inFlight: false }), null);
});

test('landingView: landing (a job runs, or w.landing set), landed with sha and undo, not landed with its reason, nothing', () => {
  assert.strictEqual(landingView(worker({ outcome: 'landing', report: at, at }), { inFlight: true }).state, 'landing');
  assert.strictEqual(landingView(worker(undefined, { landing: { at } }), { inFlight: false }).state, 'landing');
  const landed = worker({ outcome: 'landed', report: at, at, sha: 'abcdef1234', base: 'main' });
  assert.deepStrictEqual(landingView(landed, { inFlight: false }), { state: 'landed', base: 'main', sha: 'abcdef1234', reason: null, at, current: true, undone: null });
  assert.strictEqual(landingView(landed, { inFlight: false, landings: [{ mergeSha: 'abcdef1234', undone: { revertSha: 'rev1' } }] }).undone, 'rev1');
  const nl = landingView(worker({ outcome: 'not landed', report: at, at, reason: 'its branch conflicts with main in a.txt' }), { inFlight: false });
  assert.deepStrictEqual([nl.state, nl.reason, nl.sha], ['not-landed', 'its branch conflicts with main in a.txt', null]);
  assert.strictEqual(landingView(worker({ outcome: 'nothing', report: at, at }), { inFlight: false }).state, 'nothing');
  assert.strictEqual(landingView(worker({ outcome: 'landed', report: 'older', at, sha: 's' }), { inFlight: false }).current, false, 'a report since');
});

test('landingView: a recorded landing with no job reads not landed in the server, landing for a run.json reader', () => {
  const w = worker({ outcome: 'landing', report: at, at });
  const v = landingView(w, { inFlight: false });
  assert.deepStrictEqual([v.state, v.current], ['not-landed', true]);
  assert.match(v.reason, /cut off/);
  assert.strictEqual(landingView(w).state, 'landing', 'unknown in flight (src/run-summary.js)');
});

// The panel's helpers, loaded as the dashboard does.
const doc = { activeElement: null, addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
const dashboard = {
  sendWs() {}, state: {}, escHtml: String, renderMarkdown() {}, renderMarkdownDebounced() {}, cancelRenderDebounce() {},
  registerModule() {}, _tabHooks: { onChange() {} }, isPhone: () => false,
};
const window = { dashboard };
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'sdk-panel.js'), 'utf8'), vm.createContext({ window, document: doc, console }));
const { landingLabel, reportChip } = window.sdkPanel._landing;

test('worker box: the report chip says done · landed / landing… / not landed; the line says where and why', () => {
  const done = { status: 'done', summary: 's' };
  const landed = { state: 'landed', base: 'main', sha: '2a2f67d0123', current: true };
  assert.deepStrictEqual({ ...reportChip(done, landed) }, { text: 'done · landed', cls: 'sdk-report-landed' });
  assert.strictEqual(landingLabel(landed).line, 'landed on main as 2a2f67d');
  assert.deepStrictEqual({ ...reportChip(done, { state: 'landing', base: 'main', current: true }) }, { text: 'done · landing…', cls: 'sdk-report-landing' });
  assert.strictEqual(landingLabel({ state: 'landing', base: 'main' }).line, 'landing on main…');
  const nl = { state: 'not-landed', base: 'main', reason: 'its branch conflicts with main in a.txt', current: true };
  assert.deepStrictEqual({ ...reportChip(done, nl) }, { text: 'done · not landed', cls: 'sdk-report-notlanded' });
  assert.strictEqual(landingLabel(nl).line, 'not landed: its branch conflicts with main in a.txt');
  assert.strictEqual(landingLabel({ ...landed, undone: 'ffeeddcc99' }).line, 'landed on main as 2a2f67d, undone by ffeeddc');

  // No landing, another status, or a landing of an earlier report: the status alone.
  assert.deepStrictEqual({ ...reportChip(done, null) }, { text: 'done', cls: 'sdk-report-done' });
  assert.deepStrictEqual({ ...reportChip({ status: 'blocked' }, landed) }, { text: 'blocked', cls: 'sdk-report-blocked' });
  assert.deepStrictEqual({ ...reportChip(done, { ...landed, current: false }) }, { text: 'done', cls: 'sdk-report-done' });
  assert.strictEqual(landingLabel(null), null);
});
