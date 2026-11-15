// Inspector instance views (public/inspector.js): each open session tab owns
// a content box — { key, title, root, setShown, destroy } from
// inspectorModule.createInstanceView — built once, shown or hidden, destroyed
// on close, and working wherever its root is placed. Several can render live
// at once (the base for Desks windows). Runs the real inspector.js on the fake
// DOM of test/inspector-fake-dom.js.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const { loadInspector, turn } = require('./inspector-sandbox');

const ids = (root, sel, attr) => root.querySelectorAll(sel).map(e => e.dataset[attr]);
const laneTurns = root => ids(root, '.ln-turn', 'id');
const tlTurns = root => ids(root, '.turn-group[data-turn-id]', 'turnId');

function twoViews() {
  const s = loadInspector();
  const { mod, dom, document } = s;
  mod.handleMessage({ type: 'init', sessions: [
    { instanceId: 'cli-a', kind: 'cli', status: 'running', label: 'A' },
    { instanceId: 'cli-b', kind: 'cli', status: 'running', label: 'B' },
  ] });
  const boxes = ['c1', 'c2', 'c3'].map(id => {
    const el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
    return el;
  });
  const a = mod.createInstanceView('cli-a');
  const b = mod.createInstanceView('cli-b');
  boxes[0].appendChild(a.root);
  boxes[1].appendChild(b.root);
  a.setShown(true);
  b.setShown(true);
  mod.handleMessage({ type: 'inspector:snapshot', instanceId: 'cli-a', interactions: [turn('cli-a', 'a1')], hasMore: false });
  mod.handleMessage({ type: 'inspector:snapshot', instanceId: 'cli-b', interactions: [turn('cli-b', 'b1')], hasMore: false });
  dom.flushFrames();
  return { ...s, a, b, boxes };
}

test('(a) two views in two boxes each render their own session as events arrive', () => {
  const { mod, dom, a, b, boxes, sent } = twoViews();
  assert.strictEqual(a.key, 'cli-a');
  assert.strictEqual(b.key, 'cli-b');
  assert.strictEqual(a.title, 'A');
  assert.ok(sent.some(m => m.type === 'inspector:subscribe' && m.instanceId === 'cli-a'), 'a view subscribes to its session');
  assert.ok(sent.some(m => m.type === 'inspector:subscribe' && m.instanceId === 'cli-b'));

  mod.handleMessage({ type: 'interaction:start', interaction: turn('cli-a', 'a2') });
  mod.handleMessage({ type: 'interaction:start', interaction: turn('cli-b', 'b2') });
  mod.handleMessage({ type: 'interaction:start', interaction: turn('cli-a', 'a3') });
  dom.flushFrames();

  assert.deepStrictEqual(laneTurns(boxes[0]), ['a1', 'a2', 'a3']);
  assert.deepStrictEqual(laneTurns(boxes[1]), ['b1', 'b2']);
  assert.deepStrictEqual(tlTurns(boxes[0]), ['a1', 'a2', 'a3']);
  assert.deepStrictEqual(tlTurns(boxes[1]), ['b1', 'b2']);
  assert.strictEqual(a.root.parentNode, boxes[0]);
  assert.strictEqual(b.root.parentNode, boxes[1]);
});

test('(b) a root moved elsewhere keeps updating, with no lookups by element id', () => {
  const { mod, dom, a, b, boxes } = twoViews();
  boxes[2].appendChild(a.root);           // the window manager moves it
  a.setShown(true);
  dom.counters.getElementById.length = 0;
  mod.handleMessage({ type: 'interaction:start', interaction: turn('cli-a', 'a2') });
  mod.handleMessage({ type: 'interaction:start', interaction: turn('cli-a', 'a3', { status: 'pending' }) });
  mod.handleMessage({ type: 'interaction:update', interaction: { ...turn('cli-a', 'a3', { status: 'streaming' }) } });
  mod.handleMessage({ type: 'interaction:complete', interaction: turn('cli-a', 'a3') });
  mod.handleMessage({ type: 'interaction:start', interaction: turn('cli-b', 'b2') });
  dom.flushFrames();
  dom.advance(1000);
  dom.flushFrames();

  assert.deepStrictEqual(laneTurns(boxes[2]), ['a1', 'a2', 'a3']);
  assert.deepStrictEqual(tlTurns(boxes[2]), ['a1', 'a2', 'a3']);
  assert.deepStrictEqual(laneTurns(boxes[0]), []);
  assert.deepStrictEqual(tlTurns(boxes[1]), ['b1', 'b2']);
  // Nothing inside a view is found through the document: ids repeat across
  // views, so document.getElementById would land in the wrong one.
  const inView = new Set([a.root, ...a.root.querySelectorAll('[id]')].map(e => e.id).filter(Boolean));
  const looked = dom.counters.getElementById.filter(id => inView.has(id));
  assert.deepStrictEqual(looked, []);
});

test('(c) a hidden view does no DOM work; shown again it catches up', () => {
  const { mod, dom, a, b } = twoViews();
  a.setShown(false);
  const before = a.root.innerHTML;
  mod.handleMessage({ type: 'interaction:start', interaction: turn('cli-a', 'a2') });
  mod.handleMessage({ type: 'interaction:start', interaction: turn('cli-a', 'a3', { status: 'streaming' }) });
  mod.handleMessage({ type: 'sse_event', interactionId: 'a3', instanceId: 'cli-a', event: { eventType: 'message_start', data: { message: { usage: { input_tokens: 3 } } } } });
  mod.handleMessage({ type: 'interaction:start', interaction: turn('cli-b', 'b2') });
  dom.flushFrames();
  dom.advance(5000);
  dom.flushFrames();
  assert.strictEqual(a.root.innerHTML, before, 'hidden: its DOM is untouched');
  assert.deepStrictEqual(laneTurns(b.root), ['b1', 'b2'], 'the other view still renders');

  a.setShown(true);
  dom.flushFrames();
  assert.deepStrictEqual(laneTurns(a.root), ['a1', 'a2', 'a3']);
  assert.deepStrictEqual(tlTurns(a.root).slice(0, 2), ['a1', 'a2']);
});

test('(d) destroy() clears its timers and observers, unsubscribes, drops its data', () => {
  const s = loadInspector();
  const { mod, dom, document, sent } = s;
  mod.handleMessage({ type: 'init', sessions: [{ instanceId: 'cli-a', kind: 'cli', status: 'running', label: 'A' }] });
  dom.advance(5000);
  const baseTimers = dom.activeTimers();
  const baseObservers = dom.observers.length;
  const box = document.createElement('div');
  document.body.appendChild(box);
  const a = mod.createInstanceView('cli-a');
  box.appendChild(a.root);
  a.setShown(true);
  mod.handleMessage({ type: 'inspector:snapshot', instanceId: 'cli-a', hasMore: false, interactions: [
    turn('cli-a', 'a1'), turn('cli-a', 'a2', { status: 'streaming' }),
  ] });
  dom.flushFrames();
  assert.ok(dom.activeTimers() > baseTimers, 'a live view runs timers (lane status, the streaming badge)');
  assert.ok(dom.observers.length > baseObservers, 'and observers');

  a.destroy();
  dom.advance(5000);
  dom.flushFrames();
  assert.strictEqual(dom.activeTimers(), baseTimers, 'no timer of the view is left');
  assert.strictEqual(dom.frames.size, 0, 'no frame queued');
  for (const o of dom.observers.slice(baseObservers)) assert.strictEqual(o.targets.size, 0, `${o.kind} observer disconnected`);
  assert.ok(sent.some(m => m.type === 'inspector:unsubscribe' && m.instanceId === 'cli-a'));
  assert.strictEqual(a.root.isConnected, false);
  // Events for it after that change nothing and do not throw.
  mod.handleMessage({ type: 'interaction:start', interaction: turn('cli-a', 'a3') });
  assert.strictEqual(dom.activeTimers(), baseTimers);
});

test('the tab strip: open, switch, close, the Sessions grid and the footer, as before', () => {
  const s = loadInspector();
  const { mod, dom, document, sent } = s;
  const strip = document.getElementById('inspectorTabStrip');
  const grid = document.getElementById('inspectorSessions');
  const shownBodies = () => document.querySelectorAll('#view-dashboard .inspector-body').filter(e => !e.classList.contains('hidden'));
  mod.handleMessage({ type: 'init', sessions: [
    { instanceId: 'cli-a', kind: 'cli', status: 'running', label: 'A' },
    { instanceId: 'cli-b', kind: 'cli', status: 'running', label: 'B' },
  ] });
  assert.ok(!grid.classList.contains('hidden'), 'the Sessions grid first');
  assert.strictEqual(grid.querySelectorAll('.insp-card').length, 2);
  assert.strictEqual(shownBodies().length, 0);

  grid.querySelector('[data-instance-id="cli-a"]').click();
  mod.handleMessage({ type: 'inspector:snapshot', instanceId: 'cli-a', interactions: [turn('cli-a', 'a1'), turn('cli-a', 'a2')], hasMore: false });
  dom.flushFrames();
  assert.ok(grid.classList.contains('hidden'));
  assert.deepStrictEqual(strip.querySelectorAll('.view-tab').map(b => b.dataset.instanceId), ['sessions', 'cli-a']);
  assert.strictEqual(strip.querySelector('.view-tab.active').dataset.instanceId, 'cli-a');
  assert.strictEqual(shownBodies().length, 1);
  assert.deepStrictEqual(laneTurns(shownBodies()[0]), ['a1', 'a2']);
  assert.deepStrictEqual(tlTurns(shownBodies()[0]), ['a1', 'a2']);
  assert.match(document.getElementById('footerTokens').textContent, /20.*10/, 'the footer adds up the open tab');

  mod.openSession('cli-b');
  mod.handleMessage({ type: 'inspector:snapshot', instanceId: 'cli-b', interactions: [turn('cli-b', 'b1')], hasMore: false });
  dom.flushFrames();
  assert.strictEqual(strip.querySelector('.view-tab.active').dataset.instanceId, 'cli-b');
  assert.strictEqual(shownBodies().length, 1);
  assert.deepStrictEqual(laneTurns(shownBodies()[0]), ['b1']);
  assert.match(document.getElementById('footerTokens').textContent, /10.*5/);

  // Back to A: what arrived meanwhile is there.
  mod.handleMessage({ type: 'interaction:start', interaction: turn('cli-a', 'a3') });
  strip.querySelector('[data-instance-id="cli-a"]').click();
  dom.flushFrames();
  assert.deepStrictEqual(laneTurns(shownBodies()[0]), ['a1', 'a2', 'a3']);
  assert.deepStrictEqual(tlTurns(shownBodies()[0]), ['a1', 'a2', 'a3']);

  // A click on a lane turn opens the detail modal.
  shownBodies()[0].querySelector('.ln-turn[data-id="a2"] .ln-body')?.click();
  shownBodies()[0].querySelector('.ln-turn[data-id="a2"]').click();
  assert.strictEqual(document.getElementById('turn-modal').hidden, false);
  document.querySelector('.turn-modal-close').click();
  assert.strictEqual(document.getElementById('turn-modal').hidden, true);

  // Close A: B is shown; A's subscription ends.
  strip.querySelector('[data-instance-id="cli-a"] .view-tab-close').click();
  dom.flushFrames();
  assert.ok(sent.some(m => m.type === 'inspector:unsubscribe' && m.instanceId === 'cli-a'));
  assert.deepStrictEqual(strip.querySelectorAll('.view-tab').map(b => b.dataset.instanceId), ['sessions', 'cli-b']);
  assert.strictEqual(shownBodies().length, 1);
  assert.deepStrictEqual(laneTurns(shownBodies()[0]), ['b1']);

  strip.querySelector('[data-instance-id="sessions"]').click();
  assert.ok(!grid.classList.contains('hidden'));
  assert.strictEqual(shownBodies().length, 0);
});

test('streaming, selection and the view\'s own buttons act on that view only', () => {
  const { mod, dom, a, b } = twoViews();
  const live = { ...turn('cli-a', 's1', { status: 'pending' }), isStreaming: true };
  mod.handleMessage({ type: 'interaction:start', interaction: live });
  const ev = (eventType, data) => mod.handleMessage({ type: 'sse_event', instanceId: 'cli-a', interactionId: 's1', event: { eventType, data } });
  ev('message_start', { message: { usage: { input_tokens: 4 } } });
  ev('content_block_start', { index: 0, content_block: { type: 'text' } });
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Streaming into A' } });
  dom.flushFrames();
  assert.strictEqual(a.root.querySelectorAll('.footer-streaming-badge').length, 1, 'A\'s footer has the live turn');
  assert.strictEqual(b.root.querySelectorAll('.footer-streaming-badge').length, 0);
  assert.match(a.root.querySelector('.ln-turn[data-id="s1"]').textContent, /Streaming into A/);
  assert.doesNotMatch(b.root.textContent, /Streaming into A/);

  // A click on a timeline entry selects it in its own view.
  a.root.querySelector('.turn-entry[data-id="a1"]').click();
  assert.ok(a.root.querySelector('.turn-entry[data-id="a1"]').classList.contains('selected'));
  assert.strictEqual(b.root.querySelectorAll('.selected').length, 0);

  // Focus mode and Clear are per view.
  a.root.querySelector('#detail-focus-btn').click();
  assert.ok(a.root.classList.contains('focus-active'));
  assert.ok(!b.root.classList.contains('focus-active'));
  b.root.querySelector('#timeline-clear-btn').click();
  dom.flushFrames();
  assert.deepStrictEqual(laneTurns(b.root), []);
  assert.deepStrictEqual(laneTurns(a.root), ['a1', 's1']);
});
