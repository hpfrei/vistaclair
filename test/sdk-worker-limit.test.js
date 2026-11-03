// The orchestrator tab's "Workers: N" select (public/sdk-panel.js,
// Panel#renderWorkers): shown on an orchestrator's tab only, set from the
// run's maxWorkers (GET /api/orchestration/run), left alone while the owner
// has it open, and its tooltip explains it.
//
//   node --test test/

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert');

const doc = { activeElement: null, addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
const dashboard = {
  sendWs() {}, state: {}, escHtml: String, renderMarkdown() {}, renderMarkdownDebounced() {}, cancelRenderDebounce() {},
  registerModule() {}, _tabHooks: { onChange() {} }, isPhone: () => false,
};
const window = { dashboard };
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'sdk-panel.js'), 'utf8'),
  vm.createContext({ window, document: doc, console }));
const { renderWorkers } = window.sdkPanel._Panel.prototype;

function select() {
  const cls = new Set(['sdk-tb-btn', 'sdk-tb-workers', 'hidden']);
  return { value: '1', title: '', dataset: {}, classList: { toggle(c, on) { if (on) cls.add(c); else cls.delete(c); }, contains: (c) => cls.has(c) } };
}
const panel = (run, runId = 'abc123') => ({ runId, run, workersSel: select() });

test('an orchestrator tab shows the run\'s limit; a worker tab, a plain tab and a mirror run do not', () => {
  const p = panel({ runId: 'abc123', maxWorkers: 3, workers: [{ running: true }, { running: false }] });
  renderWorkers.call(p, false);
  assert.strictEqual(p.workersSel.classList.contains('hidden'), false);
  assert.strictEqual(p.workersSel.value, '3');
  assert.match(p.workersSel.title, /may run at once \(now 3; default 5\)/);
  assert.match(p.workersSel.title, /Raising it starts queued launches/);
  assert.match(p.workersSel.title, /Running now: 1\./);

  const w = panel({ runId: 'abc123', maxWorkers: 3, workers: [] });
  renderWorkers.call(w, true);
  assert.strictEqual(w.workersSel.classList.contains('hidden'), true, 'a worker tab');
  const plain = panel(null, null);
  renderWorkers.call(plain, false);
  assert.strictEqual(plain.workersSel.classList.contains('hidden'), true, 'a plain tab');
  const mirror = panel({ runId: 'abc123', maxWorkers: 3, mirror: { key: 'k' }, workers: [] });
  renderWorkers.call(mirror, false);
  assert.strictEqual(mirror.workersSel.classList.contains('hidden'), true, 'a mirror run');
});

test('another client\'s change shows; an open dropdown keeps its value until the value changes', () => {
  const p = panel({ runId: 'abc123', maxWorkers: 5, workers: [] });
  renderWorkers.call(p, false);
  doc.activeElement = p.workersSel;
  p.workersSel.value = '8';          // the owner is choosing
  renderWorkers.call(p, false);      // a push with the same value
  assert.strictEqual(p.workersSel.value, '8');
  p.run = { ...p.run, maxWorkers: 2, workers: [{ running: true }, { running: true }, { running: true }] };
  renderWorkers.call(p, false);      // another client set 2
  assert.strictEqual(p.workersSel.value, '2');
  assert.match(p.workersSel.title, /Running now: 3, above the limit/);
  doc.activeElement = null;
});
