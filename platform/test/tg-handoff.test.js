// public/tg-handoff.js in a vm sandbox: a fake window.dashboard (the tab-hook
// registry and module routing core provides) and a fake fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'tg-handoff.js'), 'utf8');
const tick = () => new Promise((r) => setImmediate(r));
const ORCH = { tabId: 't1', name: 'orch-r1', engine: 'sdk', role: 'orchestrator', runId: 'r1' };

function boot({ hooks = true, bindings = { status: 200, body: { runs: [] } }, post = {}, confirm = true } = {}) {
  const actions = new Map();
  const badges = new Map();
  const handlers = [];
  const toasts = [];
  const calls = [];
  const listeners = {};
  const dashboard = {
    registerModule: (prefix, handler) => handlers.push({ prefix, handler }),
    showToast: (t) => toasts.push(t),
    showConfirm: async () => confirm,
  };
  if (hooks) {
    dashboard.registerTabAction = (a) => { actions.set(a.id, a); return () => actions.delete(a.id); };
    dashboard.setTabBadge = (name, badge) => { if (badge) badges.set(name, badge); else badges.delete(name); };
  }
  const fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const r = url.endsWith('/bindings') ? bindings : (post[url.split('/').pop()] || { status: 200, body: { ok: true } });
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  const window = { dashboard };
  const document = {
    visibilityState: 'visible',
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const ctx = vm.createContext({ window, document, fetch, console, setImmediate });
  vm.runInContext(SRC, ctx);
  const visible = () => listeners.visibilitychange();
  const broadcast = (msg) => { for (const h of handlers) if (msg.type.startsWith(h.prefix)) h.handler(msg); };
  // As core's tab hooks resolve them: a toggle that is on says its activeLabel.
  const visibleActions = (info) => [...actions.values()].filter((a) => !a.when || a.when(info))
    .map((a) => (a.active && a.active(info) ? a.activeLabel || a.label : a.label));
  return { bindings, actions, badges, handlers, toasts, calls, broadcast, visible, visibleActions };
}

test('inert without the tab hooks', async () => {
  const t = boot({ hooks: false });
  await tick();
  assert.equal(t.calls.length, 0);
  assert.equal(t.handlers.length, 0);
  assert.equal(t.actions.size, 0);
});

test('bindings 404: nothing registered, broadcasts ignored', async () => {
  const t = boot({ bindings: { status: 404, body: { error: 'Orchestration runs are not available on this server' } } });
  await tick();
  assert.equal(t.actions.size, 0);
  t.broadcast({ type: 'tg:binding', runId: 'r1', name: 'orch-r1', bound: true });
  assert.equal(t.badges.size, 0);
  t.visible();
  await tick();
  assert.equal(t.calls.filter((c) => c.url.endsWith('/bindings')).length, 1, 'no retry once unavailable');
});

test('action shows only on orchestrator tabs with a runId', async () => {
  const t = boot();
  await tick();
  assert.equal(t.visibleActions(ORCH).length, 1);
  assert.equal(t.visibleActions({ ...ORCH, role: 'worker' }).length, 0);
  assert.equal(t.visibleActions({ ...ORCH, role: null, runId: null }).length, 0);
  assert.equal(t.visibleActions({ ...ORCH, runId: null }).length, 0);
});

test('one toggle: active and its label follow the bound state', async () => {
  const t = boot();
  await tick();
  assert.deepEqual([...t.actions.keys()], ['tg-handoff:follow']);
  const follow = t.actions.get('tg-handoff:follow');
  assert.deepEqual(t.visibleActions(ORCH), ['📱 Follow on Telegram']);
  assert.equal(follow.active(ORCH), false);
  t.broadcast({ type: 'tg:binding', runId: 'r1', name: 'orch-r1', bound: true });
  assert.equal(follow.active(ORCH), true);
  assert.deepEqual(t.visibleActions(ORCH), ['📱 Following on Telegram']);
  assert.match(follow.activeTitle, /click to stop/);
  assert.deepEqual(t.visibleActions({ ...ORCH, runId: 'r2' }), ['📱 Follow on Telegram']);
  t.broadcast({ type: 'tg:binding', runId: 'r1', name: 'orch-r1', bound: false });
  assert.deepEqual(t.visibleActions(ORCH), ['📱 Follow on Telegram']);
});

test('a click binds a run not followed and unbinds a followed one, toasting the outcome', async () => {
  const t = boot({ bindings: { status: 200, body: { runs: ['r1'] } } });
  await tick();
  const follow = t.actions.get('tg-handoff:follow');
  await follow.onClick({ ...ORCH, runId: 'r2' });
  assert.deepEqual(t.calls.at(-1), { url: '/pro/tg-handoff/bind', method: 'POST', body: { runId: 'r2' } });
  assert.equal(t.toasts.at(-1).level, 'success');
  assert.match(t.toasts.at(-1).message, /on Telegram/);
  await follow.onClick(ORCH);
  assert.deepEqual(t.calls.at(-1), { url: '/pro/tg-handoff/unbind', method: 'POST', body: { runId: 'r1' } });
});

test('a server error is toasted verbatim', async () => {
  const t = boot({ post: { bind: { status: 400, body: { error: 'Telegram is not configured: set up the control bot' } } } });
  await tick();
  await t.actions.get('tg-handoff:follow').onClick(ORCH);
  assert.deepEqual([t.toasts.at(-1).level, t.toasts.at(-1).message], ['error', 'Telegram is not configured: set up the control bot']);
});

test('badges follow the seed and tg:binding messages', async () => {
  const t = boot({ bindings: { status: 200, body: { runs: ['r1', 'r2'] } } });
  await tick();
  assert.deepEqual([...t.badges.keys()].sort(), ['orch-r1', 'orch-r2']);
  assert.equal(t.badges.get('orch-r1').text, '📱');
  t.broadcast({ type: 'tg:binding', runId: 'r3', name: 'my-run', bound: true });
  assert.ok(t.badges.has('my-run'));
  t.broadcast({ type: 'tg:binding', runId: 'r1', name: 'orch-r1', bound: false });
  assert.ok(!t.badges.has('orch-r1'));
  t.broadcast({ type: 'tg:binding', runId: 'r9', bound: false });   // never bound: no-op
  assert.deepEqual([...t.badges.keys()].sort(), ['my-run', 'orch-r2']);
});

test('a name falls back to orch-<runId>', async () => {
  const t = boot();
  await tick();
  t.broadcast({ type: 'tg:binding', runId: 'r5', bound: true });
  assert.ok(t.badges.has('orch-r5'));
});

test('badge click confirms, then unbinds', async () => {
  const t = boot({ bindings: { status: 200, body: { runs: ['r1'] } }, confirm: false });
  await tick();
  t.badges.get('orch-r1').onClick('orch-r1');
  await tick();
  assert.equal(t.calls.filter((c) => c.method === 'POST').length, 0, 'declined');

  const u = boot({ bindings: { status: 200, body: { runs: ['r1'] } } });
  await tick();
  u.badges.get('orch-r1').onClick('orch-r1');
  await tick();
  assert.deepEqual(u.calls.at(-1), { url: '/pro/tg-handoff/unbind', method: 'POST', body: { runId: 'r1' } });
});

test('re-seeds on visibilitychange, dropping runs no longer bound', async () => {
  const t = boot({ bindings: { status: 200, body: { runs: ['r1'] } } });
  await tick();
  assert.ok(t.badges.has('orch-r1'));
  // while hidden: r1 was unbound and r2 bound, and no broadcast arrived
  t.bindings.body = { runs: ['r2'] };
  t.visible();
  await tick();
  assert.deepEqual([...t.badges.keys()], ['orch-r2']);
  assert.deepEqual(t.visibleActions(ORCH), ['📱 Follow on Telegram']);
});
