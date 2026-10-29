// Add-on tab actions and badges (public/tab-hooks.js): the registry the
// dashboard exposes as window.dashboard.registerTabAction / unregisterTabAction
// / setTabBadge, the tab info actions see, and that core.js, cli.js and
// sdk-panel.js wire it in.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createTabHooks, tabInfo } = require('../public/tab-hooks.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');

const ORCH = tabInfo('tab-1', { kind: 'sdk', settings: { name: 'orch-abc123', orchestration: { runId: 'abc123', role: 'orchestrator' } } });
const WORKER = tabInfo('tab-2', { kind: 'cli', settings: { name: 'orch-abc123-w1', orchestration: { runId: 'abc123', role: 'worker' } } });
const PLAIN = tabInfo('tab-3', { kind: 'cli', settings: {} });

test('tabInfo: name, engine, role and runId from a tab as cli.js keeps it', () => {
  assert.deepStrictEqual(ORCH, { tabId: 'tab-1', name: 'orch-abc123', engine: 'sdk', role: 'orchestrator', runId: 'abc123' });
  assert.deepStrictEqual(WORKER, { tabId: 'tab-2', name: 'orch-abc123-w1', engine: 'cli', role: 'worker', runId: 'abc123' });
  assert.deepStrictEqual(PLAIN, { tabId: 'tab-3', name: null, engine: 'cli', role: null, runId: null });
  assert.deepStrictEqual(tabInfo('tab-4', undefined), { tabId: 'tab-4', name: null, engine: 'cli', role: null, runId: null });
});

test('nothing registered: no actions, no badges', () => {
  const h = createTabHooks();
  assert.deepStrictEqual(h.actionsFor(ORCH), []);
  assert.strictEqual(h.badgeFor('orch-abc123'), null);
  assert.strictEqual(h.badgeFor(null), null);
});

test('registerTabAction: when() picks the tabs, in registration order; unregister drops it', () => {
  const h = createTabHooks();
  let changes = 0;
  h.onChange(() => changes++);
  const clicks = [];
  const off = h.registerTabAction({ id: 'tg', label: 'Continue on Telegram', title: 'hint', when: (i) => i.role === 'orchestrator', onClick: (i) => clicks.push(i.tabId) });
  h.registerTabAction({ id: 'all', label: 'Everywhere', onClick() {} });
  h.registerTabAction({ id: 'broken', label: 'Broken', when() { throw new Error('x'); }, onClick() {} });
  assert.strictEqual(changes, 3);
  assert.deepStrictEqual(h.actionsFor(ORCH).map(a => a.id), ['tg', 'all']);
  assert.deepStrictEqual(h.actionsFor(WORKER).map(a => a.id), ['all'], 'a when() that throws hides its action');
  const [tg] = h.actionsFor(ORCH);
  assert.strictEqual(tg.title, 'hint');
  h.runAction(tg, ORCH);
  assert.deepStrictEqual(clicks, ['tab-1']);

  // A re-registration replaces and moves to the end; the old unregister
  // function no longer removes the new one.
  h.registerTabAction({ id: 'tg', label: 'Again', onClick() {} });
  assert.deepStrictEqual(h.actionsFor(PLAIN).map(a => a.label), ['Everywhere', 'Again']);
  off();
  assert.deepStrictEqual(h.actionsFor(PLAIN).map(a => a.id), ['all', 'tg']);
  h.unregisterTabAction('tg');
  h.unregisterTabAction('all');
  h.unregisterTabAction('broken');
  const before = changes;
  h.unregisterTabAction('unknown');
  assert.strictEqual(changes, before, 'unregistering nothing is no change');
  assert.deepStrictEqual(h.actionsFor(ORCH), []);
});

test('a toggle action: active() picks the label, the title and the pressed state per tab', () => {
  const h = createTabHooks();
  const bound = new Set(['abc123']);
  h.registerTabAction({
    id: 'tg', label: 'Follow', title: 'Follow it', activeLabel: 'Following', activeTitle: 'Click to stop',
    when: (i) => !!i.runId, active: (i) => bound.has(i.runId), onClick() {},
  });
  h.registerTabAction({ id: 'half', label: 'Half', title: 'hint', active: () => true, onClick() {} });
  h.registerTabAction({ id: 'broken', label: 'Broken', active() { throw new Error('x'); }, onClick() {} });
  const [tg, half, broken] = h.actionsFor(ORCH);
  assert.deepStrictEqual([tg.label, tg.title, tg.active], ['Following', 'Click to stop', true]);
  assert.deepStrictEqual([half.label, half.title, half.active], ['Half', 'hint', true], 'no activeLabel: the label stays');
  assert.strictEqual(broken.active, false, 'an active() that throws is not active');
  bound.clear();
  const [off] = h.actionsFor(ORCH);
  assert.deepStrictEqual([off.label, off.title, off.active], ['Follow', 'Follow it', false]);
  assert.strictEqual(h.actionsFor(PLAIN).find(a => a.id === 'half').active, true);
  assert.strictEqual(h.actionsFor(PLAIN)[0].id, 'half', 'when() still picks the tabs');
  assert.throws(() => h.registerTabAction({ id: 'x', label: 'x', onClick() {}, active: true }), /active/);
});

test('registerTabAction refuses a malformed action; runAction never throws', () => {
  const h = createTabHooks();
  assert.throws(() => h.registerTabAction({ label: 'x', onClick() {} }), /id/);
  assert.throws(() => h.registerTabAction({ id: 'x', onClick() {} }), /label/);
  assert.throws(() => h.registerTabAction({ id: 'x', label: 'x' }), /onClick/);
  assert.throws(() => h.registerTabAction({ id: 'x', label: 'x', onClick() {}, when: true }), /when/);
  const orig = console.error;
  console.error = () => {};
  try {
    h.runAction({ id: 'boom', onClick() { throw new Error('boom'); } }, PLAIN);
    h.runAction({ id: 'reject', onClick: () => Promise.reject(new Error('later')) }, PLAIN);
  } finally { console.error = orig; }
});

test('setTabBadge: keyed by session name, replaced, removed by null', () => {
  const h = createTabHooks();
  let changes = 0;
  h.onChange(() => changes++);
  const onClick = () => {};
  h.setTabBadge('orch-abc123', { text: 'TG', title: 'On Telegram', onClick });
  assert.deepStrictEqual(h.badgeFor('orch-abc123'), { text: 'TG', title: 'On Telegram', onClick });
  assert.strictEqual(h.badgeFor('orch-abc123-w1'), null);
  h.setTabBadge('orch-abc123', { text: 'TG 2' });
  assert.deepStrictEqual(h.badgeFor('orch-abc123'), { text: 'TG 2', title: null, onClick: null });
  h.setTabBadge('orch-abc123', null);
  assert.strictEqual(h.badgeFor('orch-abc123'), null);
  assert.strictEqual(changes, 3);
  h.setTabBadge('orch-abc123', null);
  assert.strictEqual(changes, 3, 'removing nothing is no change');
  assert.throws(() => h.setTabBadge('', { text: 'x' }), /name/);
  assert.throws(() => h.setTabBadge('n', { text: '' }), /text/);
  assert.throws(() => h.setTabBadge('n', { text: 'x', onClick: 'no' }), /onClick/);
});

test('the dashboard wires the registry: window.dashboard, the tab strip, the × menu and the SDK toolbar', () => {
  const html = read('index.html');
  assert.ok(html.indexOf('tab-hooks.js') > 0 && html.indexOf('tab-hooks.js') < html.indexOf('src="core.js"'), 'loads before core.js');
  const core = read('core.js');
  for (const fn of ['registerTabAction', 'unregisterTabAction', 'setTabBadge']) {
    assert.match(core, new RegExp(`dashboard\\.${fn} = tabHooks\\.${fn};`));
  }
  const cli = read('cli.js');
  assert.match(cli, /_tabBadgeEl\(tab\.settings\?\.name/, 'a badge on the tab');
  assert.match(cli, /_tabHooks\.actionsFor\(info\)/, 'actions in the × menu');
  assert.match(cli, /_tabHooks\.onChange\(\(\) => renderTabStrip\(\)\)/, 're-rendered on a change');
  const sdk = read('sdk-panel.js');
  assert.match(sdk, /_tabBadgeEl\(info\.settings\?\.name/, 'a badge on the toolbar');
  assert.match(sdk, /this\.actionsEl\.replaceChildren\(\.\.\.this\.tabActions\(tabInfo\)\.map\(/, 'a toolbar button per action');
  assert.match(sdk, /action\.active \? ' on' : ''/, 'a toggle that is on shows pressed');
  assert.ok(!/openMore|data-act="more"/.test(sdk), 'no ⋯ menu');
  assert.match(sdk, /_tabHooks\.onChange\(/);
});

// cli.js's renderTabStrip, run on a stub DOM. A throw there also stops
// switchTab before sdkPanel.setActive, which leaves every SDK box unshown and
// its Live feed empty (it never asks for sdk:history).
function renderStrip(tabList) {
  const src = read('cli.js');
  const start = src.indexOf('  function renderTabStrip() {');
  const end = src.indexOf('\n  }\n', start);
  assert.ok(start > 0 && end > start, 'renderTabStrip found in cli.js');
  const node = () => ({
    children: [], dataset: {}, style: {}, classList: { add() {} },
    appendChild(c) { this.children.push(c); }, addEventListener() {},
  });
  const strip = { ...node(), querySelectorAll: () => [], insertBefore(c) { this.children.push(c); } };
  const run = new Function('tabStrip', 'tabNewBtn', 'tabs', 'activeTabId', 'pendingAskOverlays', 'isSdk', 'computeTabLabel', 'updateStreamingState', 'scheduleCloseMenuClose', 'document', 'window',
    src.slice(start, end + 4) + '\nrenderTabStrip();');
  const tabs = new Map(tabList.map((t, i) => [`tab-${i + 1}`, t]));
  run(strip, null, tabs, 'tab-1', new Map(), (t) => t?.kind === 'sdk', (id) => id, () => {}, () => {},
    { createElement: node }, { dashboard: { _tabBadgeEl: () => null } });
  // [Sessions, ...one button per tab]; a tab's buttons by their class.
  return strip.children.slice(1).map(b => b.children.map(c => c.className).filter(Boolean));
}

test('renderTabStrip draws orchestration and worktree tabs without throwing', () => {
  const orchestration = (role) => ({ runId: 'abc123', role });
  const wt = { branch: 'b', base: 'main' };
  const buttons = renderStrip([
    { kind: 'sdk', status: 'running', settings: { orchestration: orchestration('orchestrator') } },
    { kind: 'cli', status: 'running', settings: { orchestration: orchestration('orchestrator') } },
    { kind: 'cli', status: 'running', settings: { orchestration: orchestration('worker'), worktree: wt } },
    { kind: 'cli', status: 'running', settings: { worktree: wt } },
  ]);
  const has = (i, cls) => buttons[i].some(c => c.includes(cls));
  assert.ok(!has(0, 'cli-pause-btn'), 'an SDK tab pauses from its toolbar');
  assert.ok(has(1, 'cli-pause-btn'), 'an orchestrator terminal tab pauses its run');
  assert.ok(!has(2, 'cli-pause-btn') && !has(2, 'cli-land-btn'), 'a worker neither pauses nor lands by itself');
  assert.ok(has(3, 'cli-pause-btn') && has(3, 'cli-land-btn'), 'a plain isolated tab pauses and lands');
});
