// The API-equivalent cost of an agy worker (billed $0) reaches the worker panels
// and survives a reload and a close: the transcript's status records carry
// apiUsd, the folder totals and the sdk:history totals sum it, and the panel's
// caption, shelf card and toolbar show "≈ $X" with the billed-$0 tooltip.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

process.env.VISTACLAIR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-api-cost-'));

const SdkSession = require('../src/sdk-session');
const AgySession = require('../src/agy-session');
const { agyPricing } = require('../src/agy-pricing');
const { getModelPricing } = require('../src/capabilities');

const ROOT = path.join(__dirname, '..');
const lookup = (name) => getModelPricing(ROOT, name);
const neon = agyPricing('gemini-4-neon-medium', lookup);
const OWNER = { input_tokens: 16387, output_tokens: 953, cache_read_input_tokens: 0 };
const OWNER_USD = 16387 * 3 / 1e6 + 953 * 15 / 1e6;
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

// An agy session with the real emitEvent / _emitStatus / addRequestCost, writing a real transcript.
function agy(dir, sessId) {
  const me = Object.create(AgySession.prototype);
  Object.assign(me, {
    sessId, settings: { sessionDir: dir, model: 'gemini-4-neon-medium' }, state: 'busy', costUsd: 0, apiUsd: 0,
    context: {}, blocked: null, broadcaster: { broadcast() {} },
  });
  return me;
}

test('a worker\'s calls land in its transcript: folder totals and sdk:history totals carry apiUsd, billed stays 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-w-'));
  const s = agy(dir, '11111111-1111-1111-1111-111111111111');
  s.addRequestCost(OWNER, neon);
  s.addRequestCost(OWNER, neon);
  const t = SdkSession.transcriptTotals(dir);
  near(t.apiUsd, 2 * OWNER_USD);
  assert.strictEqual(t.costUsd, 0, 'billed stays $0');
  // A reload / a closed worker: no live session, only the transcript.
  const h = SdkSession.historyTotals(dir);
  near(h.apiUsd, 2 * OWNER_USD);
  assert.strictEqual(h.costUsd, 0);
  // The live session's own figure counts too (before its status is written).
  near(SdkSession.historyTotals(dir, { costUsd: 0, apiUsd: 3 * OWNER_USD }).apiUsd, 3 * OWNER_USD);
  // The panel's history reply, via the session itself.
  near(s.historyPage().totals.apiUsd, 2 * OWNER_USD);
});

test('per session id the highest apiUsd wins; ids in one folder add up; a restart seeds from the transcript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-w-'));
  const a = agy(dir, 'aaaaaaaa-1111-1111-1111-111111111111');
  a.addRequestCost(OWNER, neon);
  const b = agy(dir, 'bbbbbbbb-1111-1111-1111-111111111111');
  b.addRequestCost(OWNER, neon);
  near(SdkSession.transcriptTotals(dir).apiUsd, 2 * OWNER_USD);
  const t = SdkSession.transcriptTotals(dir);
  near(t.apiOwn('aaaaaaaa-1111-1111-1111-111111111111'), OWNER_USD);
  // a resume of `a` keeps counting from its recorded figure (never drops below it)
  const again = agy(dir, 'aaaaaaaa-1111-1111-1111-111111111111');
  again.apiUsd = t.apiOwn('aaaaaaaa-1111-1111-1111-111111111111');
  again.addRequestCost(OWNER, neon);
  near(SdkSession.transcriptTotals(dir).apiUsd, 3 * OWNER_USD);
});

test('a Claude folder and an agy call without a figure have no apiUsd', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-w-'));
  const s = agy(dir, 'cccccccc-1111-1111-1111-111111111111');
  s.addRequestCost(OWNER, agyPricing('gemini-pro-orchestrator-neon', lookup));
  assert.strictEqual(SdkSession.transcriptTotals(dir).apiUsd, 0);
  assert.ok(!('apiUsd' in SdkSession.historyTotals(dir)));
  assert.deepStrictEqual(SdkSession.historyTotals(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-w-'))), { costUsd: 0, compactions: 0 });
});

// ---- the panel ----
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sdk-panel.js'), 'utf8');
const dashboard = {
  sendWs() {}, state: {}, escHtml: String, renderMarkdown() {}, renderMarkdownDebounced() {}, cancelRenderDebounce() {},
  registerModule() {}, _tabHooks: { onChange() {} }, isPhone: () => false,
};
function classList() {
  const s = new Set();
  return { toggle(c, on) { if (on === undefined ? !s.has(c) : on) s.add(c); else s.delete(c); }, contains: (c) => s.has(c), add: (c) => s.add(c), remove: (c) => s.delete(c) };
}
function node() {
  const n = { children: [], classList: classList(), attrs: {}, parent: null, listeners: {} };
  n.setAttribute = (k, v) => { n.attrs[k] = v; };
  n.insertBefore = (e, at) => {
    if (e.parent) e.remove();
    const i = at ? n.children.indexOf(at) : n.children.length;
    n.children.splice(i < 0 ? n.children.length : i, 0, e);
    e.parent = n;
  };
  n.remove = () => { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = null; };
  return n;
}
const doc = {
  createElement() { const n = node(); n.append = (...c) => c.forEach(x => n.insertBefore(x, null)); n.addEventListener = (t, f) => { n.listeners[t] = f; }; n.type = ''; n.title = ''; n.textContent = ''; n.className = ''; return n; },
  activeElement: null, addEventListener() {}, removeEventListener() {}, visibilityState: 'visible',
};
const ctx = vm.createContext({ window: { dashboard }, document: doc, console });
vm.runInContext(src, ctx);
const P = ctx.window.sdkPanel;

test('caption: an agy worker shows "≈ $X" with the billed-$0 tooltip; a Claude worker is unchanged', () => {
  const { costCaption, API_NOTE } = P._cost;
  assert.match(costCaption(0, OWNER_USD), /^≈ \$0\.06\d$/);
  assert.strictEqual(costCaption(0, 0), '$0.000');
  assert.strictEqual(costCaption(1.5, 0), '$1.50');
  assert.strictEqual(costCaption(null, 0), '');
  assert.match(API_NOTE, /Billed: \$0/);
});

test('a closed agy worker\'s shelf card shows its API-equivalent cost', () => {
  const Q = P._Panel.prototype;
  const w = { sessId: 's1', workerId: 'w1', label: 'w1', el: node(), cost: 0, apiCost: OWNER_USD, ended: () => true, shelved() { return true; }, setShown() {} };
  const claude = { sessId: 's2', workerId: 'w2', label: 'w2', el: node(), cost: 1.5, ended: () => true, shelved() { return true; }, setShown() {} };
  const p = {
    openIds: new Set(), cards: new Map(), rowList: [], active: true, workers: new Map([[w.sessId, w], [claude.sessId, claude]]),
    workersEl: node(), shelfEl: node(), shelfTitle: {}, shelfList: node(), panelEl: node(), main: { setShown() {} }, drawLinksSoon() {},
  };
  for (const m of ['sortedWorkers', 'layoutWorkers', 'syncShown', 'renderShelf', 'renderShelfAges', 'openShelved']) p[m] = Q[m];
  p.layoutWorkers();
  const c = p.cards.get('s1');
  assert.match(c.cost.textContent, /^≈ \$0\.06\d$/);
  assert.match(c.cost.title, /API-equivalent/);
  assert.strictEqual(p.cards.get('s2').cost.textContent, '$1.50');
  assert.strictEqual(p.cards.get('s2').cost.title, '');
});

test('the panel reads the totals\' apiUsd, the run board\'s apiCost and the status\' apiUsd', () => {
  assert.match(src, /t\.apiUsd === 'number'\) this\.apiCost = t\.apiUsd/);
  assert.match(src, /typeof w\.apiCost === 'number'\) a\.apiCost = w\.apiCost/);
  assert.match(src, /run\.orchestratorApiCost === 'number'\) this\.main\.apiCost/);
  assert.match(src, /p\.apiUsd === 'number'\) this\.apiCost = p\.apiUsd/);
});
