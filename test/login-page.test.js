// Login page challenge flow (public/login.js createLoginFlow), driven with a
// fake clock, a scripted fetch and a recording view: start → QR shown,
// rotation passes `replaces`, denied → "Login refused" + fresh code,
// expired → fresh code, ok → navigate('/'), no providers → token form only,
// hidden tab pauses, network errors back off. Plus the QR/link sanitizers.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const { createLoginFlow, qrDataUrl, safeLink } = require('../public/login.js');

const tick = () => new Promise(r => setImmediate(r));
async function settle(n = 10) { for (let i = 0; i < n; i++) await tick(); }

function harness({ start, poll, rotateMs = 30000 }) {
  let t = 0;
  let timers = [];
  let seq = 0;
  const calls = [];
  const events = [];
  const pending = []; // unresolved poll promises (long-poll)
  const clock = {
    setTimeout(fn, ms) { const id = ++seq; timers.push({ id, at: t + ms, fn }); return id; },
    clearTimeout(id) { timers = timers.filter(x => x.id !== id); },
    now: () => t,
  };
  async function advance(ms) {
    const end = t + ms;
    for (;;) {
      await settle(); // let fetch promises resolve and register their timers
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      t = next.at;
      next.fn();
    }
    t = end;
  }
  const reply = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });
  function fetch(path, opts) {
    const body = JSON.parse(opts.body);
    calls.push({ path, body });
    if (path.endsWith('/start')) return start(body, calls);
    const p = poll(body, calls);
    if (p !== 'hang') return p;
    return new Promise((resolve, reject) => {
      pending.push(resolve);
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  }
  const view = {
    show: (ch) => events.push(['show', ch.nonce, ch.providers.length]),
    hide: () => events.push(['hide']),
    setStatus: (text, kind) => events.push(['status', text, kind]),
    setCountdown: (s) => events.push(['countdown', s]),
  };
  const navigated = [];
  const flow = createLoginFlow({ fetch, ...clock, view, navigate: (u) => navigated.push(u), rotateMs });
  return { flow, calls, events, navigated, advance, reply, pending, timers: () => timers };
}

const provider = { id: 'demo', label: 'Demo', link: 'https://example.test/x', qrSvg: '<svg></svg>' };
let n = 0;
const challenge = (extra = {}) => ({ nonce: `n${++n}`, code: 'ABC123', expiresInMs: 120000, providers: [provider], ...extra });

test('no providers: hides the panel and makes no further requests', async () => {
  const h = harness({ start: async () => ({ ok: true, status: 200, json: async () => ({ nonce: 'x', code: 'c', expiresInMs: 1, providers: [] }) }), poll: () => assert.fail('no poll') });
  h.flow.start();
  await h.advance(0);
  assert.deepStrictEqual(h.events, [['hide']]);
  await h.advance(120000);
  assert.strictEqual(h.calls.length, 1);
  assert.strictEqual(h.flow.state().stopped, true);
});

test('start 404 (no challenge backend) is treated as no providers', async () => {
  const h = harness({ start: async () => ({ ok: false, status: 404, json: async () => ({}) }), poll: () => assert.fail('no poll') });
  h.flow.start();
  await h.advance(0);
  assert.deepStrictEqual(h.events, [['hide']]);
  await h.advance(60000);
  assert.strictEqual(h.calls.length, 1);
});

test('shows the challenge, long-polls, rotates every 30 s with replaces', async () => {
  const h = harness({ start: async () => h.reply(200, challenge()), poll: () => 'hang' });
  h.flow.start();
  await h.advance(0);
  assert.deepStrictEqual(h.events[0][0], 'show');
  const first = h.events[0][1];
  assert.ok(h.events.some(e => e[0] === 'status' && e[1] === 'Waiting for approval…'));
  assert.ok(h.events.some(e => e[0] === 'countdown' && e[1] === 30));
  assert.strictEqual(h.calls[0].body.replaces, undefined);
  assert.deepStrictEqual(h.calls[1], { path: 'login/challenge/poll', body: { nonce: first } });
  await h.advance(10000);
  assert.ok(h.events.some(e => e[0] === 'countdown' && e[1] === 20));
  await h.advance(20000);
  const starts = h.calls.filter(c => c.path.endsWith('/start'));
  assert.strictEqual(starts.length, 2);
  assert.strictEqual(starts[1].body.replaces, first);
  // The old long-poll was aborted; a new one polls the new nonce.
  const second = h.flow.state().nonce;
  assert.notStrictEqual(second, first);
  assert.deepStrictEqual(h.calls.at(-1).body, { nonce: second });
});

test('denied: shows "Login refused" and fetches a fresh code that keeps the message', async () => {
  let polls = 0;
  const h = harness({ start: async () => h.reply(200, challenge()), poll: async () => h.reply(200, { status: ++polls === 1 ? 'denied' : 'pending' }) });
  h.flow.start();
  await h.advance(0);
  assert.strictEqual(h.calls.filter(c => c.path.endsWith('/start')).length, 1, 'fresh start waits for the 10 s gap');
  await h.advance(10000);
  const first = h.events[0][1];
  const iRefused = h.events.findIndex(e => e[0] === 'status' && e[1] === 'Login refused' && e[2] === 'error');
  assert.ok(iRefused > 0);
  const after = h.events.slice(iRefused + 1).filter(e => !(e[0] === 'countdown' && e[1] === null));
  assert.strictEqual(after[0][0], 'show');
  assert.notStrictEqual(after[0][1], first);
  assert.ok(!after.some(e => e[0] === 'status'), 'refusal stays visible over the fresh code');
  assert.strictEqual(h.calls.filter(c => c.path.endsWith('/start'))[1].body.replaces, first);
  h.flow.setHidden(true); // stop the pending-poll loop
});

test('expired: fetches a fresh code', async () => {
  let polls = 0;
  const h = harness({ start: async () => h.reply(200, challenge()), poll: async () => (++polls === 1 ? h.reply(200, { status: 'expired' }) : 'hang') });
  h.flow.start();
  await h.advance(10000);
  assert.strictEqual(h.events.filter(e => e[0] === 'show').length, 2);
  assert.ok(!h.events.some(e => e[1] === 'Login refused'));
});

test('ok: navigates to / and stops', async () => {
  const h = harness({ start: async () => h.reply(200, challenge()), poll: async () => h.reply(200, { status: 'ok' }) });
  h.flow.start();
  await h.advance(0);
  assert.deepStrictEqual(h.navigated, ['/']);
  assert.ok(h.events.some(e => e[0] === 'status' && e[1] === 'Logged in'));
  const before = h.calls.length;
  await h.advance(60000);
  assert.strictEqual(h.calls.length, before);
  assert.strictEqual(h.timers().length, 0);
});

test('hidden tab pauses polling and rotation; visible resumes', async () => {
  const h = harness({ start: async () => h.reply(200, challenge()), poll: () => 'hang' });
  h.flow.start();
  await h.advance(0);
  assert.strictEqual(h.flow.state().polling, true);
  h.flow.setHidden(true);
  await h.advance(0);
  assert.strictEqual(h.flow.state().polling, false);
  const before = h.calls.length;
  await h.advance(5 * 60000);
  assert.strictEqual(h.calls.length, before, 'no requests while hidden');
  h.flow.setHidden(false);
  await h.advance(0);
  // The code went stale while hidden: a fresh one replaces it, then polling.
  const last = h.calls.slice(before);
  assert.strictEqual(last[0].path, 'login/challenge/start');
  assert.ok(last[0].body.replaces);
  assert.strictEqual(last[1].path, 'login/challenge/poll');
});

test('hidden briefly: resumes the same code without a new start', async () => {
  const h = harness({ start: async () => h.reply(200, challenge()), poll: () => 'hang' });
  h.flow.start();
  await h.advance(0);
  h.flow.setHidden(true);
  await h.advance(5000);
  h.flow.setHidden(false);
  await h.advance(0);
  assert.strictEqual(h.calls.filter(c => c.path.endsWith('/start')).length, 1);
  assert.strictEqual(h.flow.state().polling, true);
});

test('start while hidden waits until visible', async () => {
  const h = harness({ start: async () => h.reply(200, challenge()), poll: () => 'hang' });
  h.flow.setHidden(true);
  h.flow.start();
  await h.advance(60000);
  assert.strictEqual(h.calls.length, 0);
  h.flow.setHidden(false);
  await h.advance(0);
  assert.strictEqual(h.calls[0].path, 'login/challenge/start');
});

test('poll network errors back off exponentially, then recover', async () => {
  let fails = 3;
  const h = harness({ start: async () => h.reply(200, challenge()), poll: () => (fails-- > 0 ? Promise.reject(new Error('net')) : 'hang') });
  h.flow.start();
  await h.advance(0);
  const pollTimes = () => h.calls.filter(c => c.path.endsWith('/poll')).length;
  assert.strictEqual(pollTimes(), 1);
  await h.advance(999); assert.strictEqual(pollTimes(), 1);
  await h.advance(1); assert.strictEqual(pollTimes(), 2);   // +1 s
  await h.advance(1999); assert.strictEqual(pollTimes(), 2);
  await h.advance(1); assert.strictEqual(pollTimes(), 3);   // +2 s
  await h.advance(4000); assert.strictEqual(pollTimes(), 4); // +4 s, now hangs
  assert.strictEqual(h.flow.state().polling, true);
});

test('start 429 retries with backoff and then shows the code', async () => {
  let starts = 0;
  const h = harness({ start: async () => (++starts <= 2 ? h.reply(429, { error: 'slow down' }) : h.reply(200, challenge())), poll: () => 'hang' });
  h.flow.start();
  await h.advance(0);
  assert.ok(!h.events.some(e => e[0] === 'show'));
  assert.ok(h.events.some(e => e[0] === 'status' && e[2] === 'error'));
  await h.advance(14999); assert.strictEqual(starts, 1);
  await h.advance(1); assert.strictEqual(starts, 2);       // +15 s
  await h.advance(29999); assert.strictEqual(starts, 2);
  await h.advance(1); assert.strictEqual(starts, 3);       // +30 s
  assert.ok(h.events.some(e => e[0] === 'show'));
  h.flow.setHidden(true);
});

test('start 429 honours Retry-After when longer than the backoff', async () => {
  let starts = 0;
  const h = harness({ start: async () => (++starts === 1 ? h.reply(429, {}, { 'retry-after': '45' }) : h.reply(200, challenge())), poll: () => 'hang' });
  h.flow.start();
  await h.advance(44999); assert.strictEqual(starts, 1);
  await h.advance(1); assert.strictEqual(starts, 2);
  h.flow.setHidden(true);
});

test('backoff survives hide/show: toggling visibility does not hammer start', async () => {
  let starts = 0;
  const h = harness({ start: async () => { starts++; return h.reply(429, {}); }, poll: () => 'hang' });
  h.flow.start();
  await h.advance(0);
  for (let i = 0; i < 10; i++) { h.flow.setHidden(true); await h.advance(500); h.flow.setHidden(false); await h.advance(500); }
  assert.strictEqual(starts, 1, '10 s of toggling stays inside the 15 s backoff');
});

test('starts never exceed one per 10 s (denied every time)', async () => {
  const h = harness({ start: async () => h.reply(200, challenge()), poll: async () => h.reply(200, { status: 'denied' }) });
  h.flow.start();
  await h.advance(60000);
  const starts = h.calls.filter(c => c.path.endsWith('/start')).length;
  assert.ok(starts <= 7, `≤ 7 starts in 60 s, got ${starts}`);
  h.flow.setHidden(true);
});

test('a pending answer that comes back at once does not hot-loop', async () => {
  const h = harness({ start: async () => h.reply(200, challenge({ expiresInMs: 600000 })), poll: async () => h.reply(200, { status: 'pending' }) });
  h.flow.start();
  await h.advance(0);
  await h.advance(10000);
  const polls = h.calls.filter(c => c.path.endsWith('/poll')).length;
  assert.ok(polls >= 10 && polls <= 12, `~1 poll/s, got ${polls}`);
  h.flow.setHidden(true);
});

test('qrDataUrl accepts only SVG markup; safeLink only https', () => {
  assert.match(qrDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'), /^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
  assert.ok(qrDataUrl('<?xml version="1.0"?>\n<svg></svg>'));
  assert.strictEqual(qrDataUrl('<img src=x onerror=alert(1)>'), null);
  assert.strictEqual(qrDataUrl(undefined), null);
  assert.strictEqual(safeLink('https://t.example/x'), 'https://t.example/x');
  assert.strictEqual(safeLink('javascript:alert(1)'), null);
  assert.strictEqual(safeLink('http://plain.example/'), null);
});
