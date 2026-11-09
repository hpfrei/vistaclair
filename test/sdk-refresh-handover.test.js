// The SDK panel and an orchestrator a refresh replaced (public/sdk-panel.js):
// its last envelopes (its exit status) never become a worker box of the run,
// and a box adopted earlier goes when the run lists it as retired.
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
const { _panels: panels, handleMessage } = window.sdkPanel;
const { applyRun } = window.sdkPanel._Panel.prototype;

// The new orchestrator's panel, as far as adopt() looks at it.
function fakePanel(run) {
  const added = [];
  const p = {
    runId: run.runId, run, main: { sessId: 'NEW' }, added,
    addWorker(id) { added.push(id); return { receive() {} }; },
    fetchRun() {},
  };
  panels.set('tab-new', p);
  return p;
}
const status = (sessId, runId) => ({ type: 'sdk:event', sessId, ...(runId ? { runId } : {}), ts: 1, ev: { platform: { kind: 'status', state: 'replaced' } } });

test('the retired orchestrator\'s last envelopes become no worker box; a new worker\'s still does', () => {
  const p = fakePanel({ runId: 'r1', workers: [], retiredOrchestrators: ['OLD'] });
  handleMessage(status('OLD'));            // the server no longer names the run
  handleMessage(status('OLD', 'r1'));      // and an older server's envelope
  assert.deepStrictEqual(p.added, []);
  handleMessage(status('W2', 'r1'));       // a worker launched after the last fetch
  assert.deepStrictEqual(p.added, ['W2']);
  panels.delete('tab-new');
});

test('a box adopted before the run listed it as retired goes at the next run update', () => {
  let destroyed = 0;
  const workers = new Map([['OLD', { destroy() { destroyed++; } }]]);
  const self = { main: null, workers, layoutWorkers() {}, renderToolbar() {}, allAreas: () => [] };
  applyRun.call(self, { runId: 'r1', workers: [], retiredOrchestrators: ['OLD'] });
  assert.strictEqual(destroyed, 1);
  assert.strictEqual(workers.has('OLD'), false);
});
