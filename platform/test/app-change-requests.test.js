// Cross-app change requests: the owner decides once, and the asking session is
// told the outcome whatever happens to it. The regressions this guards are the
// ones that strand a session: a denial that never comes back, a queued request
// that never launches when the target's tab closes, and an outcome delivered
// nowhere because the waiter died with the tab.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cr = require('../src/apps/app-change-requests');

// A stand-in platform: one capability module and the API-reference section that
// documents it. Both are what a platform change session would edit, so the
// tests move them the way that session would.
const EMAIL_CAP = {
  key: 'email', title: 'Email Engine', headings: null,
  methods: ['email.list', 'email.send'], prefixes: ['email.'], ctx: ['email', 'emailAccounts'],
};
const EMAIL_SECTION = '### Email Engine\n\n- `email.list({ account?, folder?, limit? })` — query emails.\n';

function harness({ apps = ['alpha', 'beta', 'gamma'], maxDepth = 1, running = [], repollGraceMs, transcripts, openSdkSession } = {}) {
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-cr-'));
  const proDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-pro-'));
  const state = {
    dataHome,
    proDir,
    running: new Set(running),
    sdkTabs: new Set(),
    submits: [],
    submitError: null,
    writes: [],
    launches: [],
    proLaunches: [],
    broadcasts: [],
    exitHooks: new Map(),
    sessions: new Map(),   // instanceId -> { tabId, sessId, cwd?, settings? }
    appsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vc-apps-')),
    manifests: new Map(),
    tools: [],
    // The platform as it is ON DISK: the registry the module is read from, and
    // the api-reference section the verifier slices.
    caps: new Map([['email', JSON.parse(JSON.stringify(EMAIL_CAP))]]),
    sections: new Map([['email', EMAIL_SECTION]]),
    settings: { changeRequestMaxDepth: maxDepth },
  };
  for (const a of apps) state.sessions.set(`cli-${a}`, { tabId: `app-${a}`, sessId: `sess-${a}` });

  // The reference lives where the real one does, so sectionText() resolves it
  // by marker exactly as it does against the repository.
  state.writeReference = () => {
    const dir = path.join(proDir, 'src', 'apps', 'prompts');
    fs.mkdirSync(dir, { recursive: true });
    let out = '# API Reference\n\n';
    for (const [key, body] of state.sections) {
      out += `<!-- API:SECTION key=${key} -->\n${body}\n<!-- /API:SECTION -->\n\n`;
    }
    fs.writeFileSync(path.join(dir, '_api-reference.md'), out);
  };
  state.writeReference();

  const cliSessionManager = {
    // A tab in state.sdkTabs is an Agent SDK session: submit() is its way in,
    // and state.submitError (a message) makes it throw, as a session that died.
    get: (tabId) => (state.running.has(tabId) ? {
      running: true, tabId,
      ...(state.sdkTabs.has(tabId) ? { submit: (text) => {
        if (state.submitError) throw new Error(state.submitError);
        state.submits.push({ tabId, text });
      } } : {}),
    } : null),
    list: () => [...state.running].map((tabId) => {
      const s = [...state.sessions.values()].find((x) => x.tabId === tabId);
      return { tabId, status: 'running', cwd: s?.cwd, settings: s?.settings || {} };
    }),
    getByInstanceId: (id) => {
      const s = state.sessions.get(id);
      return s ? { tabId: s.tabId, sessId: s.sessId, cwd: s.cwd, getSettings: () => ({ ...(s.settings || {}) }) } : null;
    },
    writeWhenReady: (tabId, data, delay) => state.writes.push({ tabId, data, delay }),
    // The pro session goes straight to the session manager — this IS the launch.
    launchSession: (tabId, params) => {
      state.proLaunches.push({ tabId, params });
      state.running.add(tabId);
    },
    // Only where a test says which transcripts exist: without it the module
    // tries the resume and lets core refuse.
    ...(transcripts ? { transcriptExists: (cwd, sessId) => transcripts.has(sessId) } : {}),
  };

  state.launchError = null;   // (params) => Error | null: launchChangeSession throws it
  // (params) => a Promise launchChangeSession returns, as the platform's does
  // (openCli is async); unset, the launch is synchronous.
  state.launchAsync = null;
  cr.init({
    dataHome,
    proDir,
    repollGraceMs,
    cliSessionManager,
    ...(openSdkSession ? { openSdkSession: (o) => openSdkSession(o, state) } : {}),
    appManager: {
      APPS_DIR: state.appsDir,
      list: () => apps.map((name) => ({ name })),
      readManifest: (name) => state.manifests.get(name) || { name },
    },
    launchChangeSession: (appName, params) => {
      const err = state.launchError && state.launchError(params);
      if (err) throw err;
      state.launches.push({ appName, params });
      if (state.launchAsync) return state.launchAsync(params);
      state.running.add(`app-${appName}`);
      return { tabId: `app-${appName}` };
    },
    broadcaster: { broadcast: (m) => state.broadcasts.push(m) },
    toolUnion: () => state.tools,
    settings: { get: (k) => state.settings[k] },
    // The capability registry, and the same registry read "from disk" — in the
    // real platform the second one is a child process, because the running
    // registry is frozen until the owner restarts.
    capabilities: {
      get: (k) => state.caps.get(k) || null,
      all: () => [...state.caps.values()],
      capabilityKeyForMethod: (m) => {
        for (const c of state.caps.values()) {
          if (c.methods.includes(m)) return c.key;
          for (const p of c.prefixes || []) if (m.startsWith(p)) return c.key;
        }
        return null;
      },
    },
    readCapability: (k) => state.caps.get(k) || null,
    addExitHook: (tabId, fn) => {
      const list = state.exitHooks.get(tabId) || [];
      list.push(fn);
      state.exitHooks.set(tabId, list);
    },
  });

  // Fire a tab's exit the way core does: the hooks run, then clear.
  state.exitTab = (tabId) => {
    state.running.delete(tabId);
    const hooks = state.exitHooks.get(tabId) || [];
    state.exitHooks.delete(tabId);
    for (const h of hooks) h(tabId);
  };
  state.exit = (app) => state.exitTab(`app-${app}`);
  // The session the owner's Open created, speaking for itself: the tab is named
  // after the request, which is how the platform half of `done` is authorised.
  state.proSession = (id, instanceId = 'cli-pro') => {
    state.sessions.set(instanceId, { tabId: `pro-change-${id}`, sessId: `sess-${instanceId}` });
    return instanceId;
  };
  state.cleanup = () => {
    fs.rmSync(dataHome, { recursive: true, force: true });
    fs.rmSync(state.appsDir, { recursive: true, force: true });
    fs.rmSync(proDir, { recursive: true, force: true });
  };
  return state;
}

// The module debounces a tab exit so an APP.md pre-flight relaunch is not read
// as "the session ended without reporting".
cr._internals.setRelaunchGraceMs(100);   // the module's 2 s debounce, shortened for the suite
const afterGrace = () => new Promise((r) => setTimeout(r, cr._internals.RELAUNCH_GRACE_MS + 60));

const ask = (h, over = {}) => cr.request({
  instanceId: 'cli-alpha', to: 'beta', prompt: 'Please expose a tool that returns the current reading.',
  interface: { kind: 'tool', name: 'current_reading' }, reason: 'alpha renders it', ...over,
});

test('only an app change tab may speak for an app, and the two refusals differ', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const unknown = cr.request({ instanceId: 'cli-nobody', to: 'beta', prompt: 'x', interface: { kind: 'tool', name: 't' } }).error;
  assert.match(unknown, /no running CLI tab has the instance id "cli-nobody"/);
  h.sessions.set('cli-shell', { tabId: 'shell-1', sessId: 's', cwd: '/somewhere/else' });
  const wrongTab = cr.request({ instanceId: 'cli-shell', to: 'beta', prompt: 'x', interface: { kind: 'tool', name: 't' } }).error;
  assert.match(wrongTab, /tab "shell-1" \(cwd \/somewhere\/else\) is not an app change tab/);
  assert.match(cr.done({ instanceId: 'cli-nobody', summary: 'x' }).error, /no running CLI tab/);
});

// Core brings a tab back after a restart under a fresh `tab-<boot>-N` id, and
// a saved session reopened from the tab menu gets one too. The tab is still the
// app's change session: the launch stamped the app into its settings, and
// failing that it sits in the app's directory.
test('a restored change tab still speaks for its app, by stamp or by cwd', async (t) => {
  const h = harness({ running: ['tab-b1-7'] });
  t.after(h.cleanup);
  const stamp = cr._internals.STAMP_APP;
  h.sessions.set('cli-alpha', { tabId: 'tab-b1-7', sessId: 'sess-alpha', settings: { [stamp]: 'alpha', model: 'opus' } });
  const r1 = ask(h);
  assert.ok(r1.id, r1.error);
  assert.equal(r1.state, 'pending');
  // Tier 2 of the ladder writes into the tab the request came from, not `app-alpha`.
  cr.decide(r1.id, { ok: true });
  cr._internals.byId(r1.id).lastPollAt = Date.now() - cr._internals.WAITER_FRESH_MS - 1000;
  const done = cr.done({ instanceId: 'cli-beta', id: r1.id, summary: 's' });
  assert.equal(done.deliveredVia, 'pty');
  assert.equal(h.writes[0].tabId, 'tab-b1-7');

  // cwd alone: the app's own directory, and only that.
  const h2 = harness();
  t.after(h2.cleanup);
  h2.sessions.set('cli-alpha', { tabId: 'tab-b2-3', sessId: 'sess-alpha', cwd: path.join(h2.appsDir, 'alpha') });
  assert.ok(ask(h2).id);
  h2.sessions.set('cli-alpha', { tabId: 'tab-b2-4', sessId: 'sess-alpha-3', cwd: path.join(h2.appsDir, 'alpha', 'src') });
  assert.match(ask(h2).error, /not an app change tab/);
  h2.sessions.set('cli-alpha', { tabId: 'tab-b2-5', sessId: 'sess-alpha-4', cwd: h2.appsDir });
  assert.match(ask(h2).error, /not an app change tab/);
  h2.sessions.set('cli-alpha', { tabId: 'tab-b2-6', sessId: 'sess-alpha-5', settings: { [stamp]: 'nosuch' } });
  assert.match(ask(h2).error, /not an app change tab/);
});

// A workspace session (cli.workspace) sits below an app root and carries the
// workspace stamps, never the change stamp: it speaks for no app.
test('a workspace tab is not a change-request caller', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const cwd = path.join(h.appsDir, 'alpha', 'workspaces', 'scene');
  h.sessions.set('cli-alpha', { tabId: 'ws-alpha.scene', sessId: 'sess-ws', cwd,
    settings: { [cr.SESSION_STAMPS.workspace]: 'alpha', [cr.SESSION_STAMPS.workspaceDir]: cwd } });
  assert.match(ask(h).error, /tab "ws-alpha\.scene" .* is not an app change tab/);
  assert.equal(h.launches.length, 0);
});

test('a restored target tab is still the target: busy check, done, and its exit', async (t) => {
  const h = harness({ running: ['app-alpha'] });
  t.after(h.cleanup);
  const stamp = cr._internals.STAMP_APP;
  const { id } = ask(h);
  // beta's change tab came back as tab-b3-1 with the stamp: beta is busy, so the
  // launch queues instead of opening a second session on the same transcript.
  h.sessions.set('cli-beta', { tabId: 'tab-b3-1', sessId: 'sess-beta', settings: { [stamp]: 'beta' } });
  h.running.add('tab-b3-1');
  cr.decide(id, { ok: true });
  assert.equal(cr.status(id).state, 'queued');
  assert.equal(h.launches.length, 0);
  // …and its exit is what releases the queue.
  h.exitTab('tab-b3-1');
  await afterGrace();
  assert.equal(cr.status(id).state, 'launched');
  assert.equal(h.launches.length, 1);
  // The launched app-beta tab is restored under a new id mid-request; done from
  // there is accepted, and it is beta's request.
  h.running.delete('app-beta');
  h.sessions.set('cli-beta', { tabId: 'tab-b4-2', sessId: 'sess-beta-2', settings: { [stamp]: 'beta' } });
  h.running.add('tab-b4-2');
  const out = cr.done({ instanceId: 'cli-beta', id, summary: 'exposed it' });
  assert.equal(out.state, 'done');
});

test('a request needs a target, a prompt and a named interface', (t) => {
  const h = harness();
  t.after(h.cleanup);
  assert.match(ask(h, { to: 'alpha' }).error, /itself/);
  assert.match(ask(h, { to: 'nosuch' }).error, /no app named/);
  assert.match(ask(h, { prompt: '  ' }).error, /empty/);
  assert.match(ask(h, { interface: null }).error, /--tool|--event/);
});

test('a request is pending until the owner decides, and the GUI is asked', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const res = ask(h);
  assert.ok(res.id);
  assert.equal(res.state, 'pending');
  assert.equal(h.launches.length, 0, 'nothing opens before the owner decides');
  assert.ok(h.broadcasts.some((m) => m.type === 'app:changeRequest:ask' && m.id === res.id));
  assert.ok(h.broadcasts.some((m) => m.type === 'app:changeRequests'));
  assert.match(ask(h).error, /one at a time/);
});

test('a denial reaches the waiting session, opens nothing, and sticks', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const { id } = ask(h);
  const waiting = cr.wait(id, 5000);
  cr.decide(id, { ok: false, reason: 'that belongs in the platform' });
  const out = await waiting;
  assert.equal(out.state, 'denied');
  assert.match(out.text, /denied by the owner: that belongs in the platform/);
  assert.match(out.text, /Do not request it again/);
  assert.equal(h.launches.length, 0);
  // The owner's no holds for the life of the asking session.
  assert.match(ask(h).error, /already denied/);
  // …but not for a different session of the same app.
  h.sessions.set('cli-alpha', { tabId: 'app-alpha', sessId: 'sess-alpha-2' });
  assert.ok(ask(h).id);
});

test('approval opens a change session on the target with the (edited) prompt', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const { id } = ask(h);
  cr.decide(id, { ok: true, prompt: 'Expose current_reading as a tool. Owner edited this.' });
  assert.equal(h.launches.length, 1);
  const [launch] = h.launches;
  assert.equal(launch.appName, 'beta');
  assert.equal(launch.params.autoSubmit, true);
  assert.match(launch.params.prompt, /Owner edited this/);
  assert.equal(launch.params.changeRequest.id, id);
  assert.deepEqual(launch.params.changeRequest.chain, ['alpha', 'beta']);
});

test('a busy target is queued, and launches when its tab closes', async (t) => {
  const h = harness({ running: ['app-beta'] });
  t.after(h.cleanup);
  const { id } = ask(h);
  assert.equal(cr.decide(id, { ok: true }).state, 'queued');
  assert.equal(h.launches.length, 0, 'the owner\'s open tab is never killed');
  h.exit('beta');
  await afterGrace();
  assert.equal(h.launches.length, 1);
  assert.equal(cr.status(id).state, 'launched');
});

// --- A busy target: inject into its open session, or queue ----------------
// The request used to queue behind the target's open tab with nothing to show
// for it. Now the owner's modal reads the busy state while the request is still
// `pending`, and its click either writes the request into the open session or
// queues it — and a queued one can still be injected.

const shown = (id) => cr.list().find((r) => r.id === id);

test('the state the modal reads says the target is busy, and in which tab, while pending', (t) => {
  const h = harness({ running: ['app-beta'] });
  t.after(h.cleanup);
  const asked = ask(h);
  assert.equal(asked.targetBusy, true);
  assert.match(asked.note, /"beta" has a change session open/);
  const r = shown(asked.id);
  assert.equal(r.state, 'pending');
  assert.equal(r.targetBusy, true);
  assert.equal(r.targetTab, 'app-beta');
  assert.equal(r.canInject, true);
  assert.match(r.queueNote, /inject/);
  // The asking session's own poll says it too, so it is not left guessing.
  assert.match(cr.status(asked.id).text, /has a change session open/);
  assert.match(cr.status(asked.id).note, /offered/);

  // A target nobody has open is unchanged: not busy, nothing to inject into.
  const h2 = harness();
  t.after(h2.cleanup);
  const idle = shown(ask(h2).id);
  assert.equal(idle.targetBusy, false);
  assert.equal(idle.canInject, false);
});

test('inject writes the request into the open pty session and binds the request to that tab', async (t) => {
  const h = harness({ running: ['app-beta'] });
  t.after(h.cleanup);
  h.manifests.set('beta', { name: 'beta', events: { emits: { 'beta:reading': { description: 'a reading' } } } });
  const { id } = ask(h, { interface: { kind: 'event', name: 'beta:reading' } });
  const waiting = cr.wait(id, 5000);

  const res = cr.decide(id, { ok: true, mode: 'inject', prompt: 'Edited by the owner: expose beta:reading.' });
  assert.equal(res.state, 'launched');
  assert.equal(h.launches.length, 0, 'the open tab is not relaunched');
  assert.equal(h.proLaunches.length, 0);
  // The text and then a separate Enter, in the tab that was open.
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[0].tabId, 'app-beta');
  assert.equal(h.writes[1].data, '\r');
  const text = h.writes[0].data;
  assert.match(text, /INTO THIS OPEN SESSION/);
  assert.match(text, new RegExp(`request id \`${id}\``));
  assert.match(text, /"alpha"/);
  assert.match(text, new RegExp(`app-change\\.js done --id ${id}`), 'how to report is in the message');
  assert.match(text, /hop 1 of 1|hop limit 1 reached|third app/);
  assert.match(text, /Edited by the owner: expose beta:reading\./, 'the edited request text, not the original');
  const rec = cr._internals.byId(id);
  assert.equal(rec.targetTabId, 'app-beta');
  assert.equal(rec.injected, true);
  assert.equal(shown(id).state, 'launched');
  assert.equal(shown(id).targetBusy, false, 'it is no longer waiting on the target');

  // It is the target's request now: done from that tab completes it and the
  // outcome reaches the asker.
  const out = cr.done({ instanceId: 'cli-beta', id, summary: 'emits beta:reading' });
  assert.equal(out.state, 'done');
  assert.equal(out.deliveredVia, 'waiter');
  assert.equal((await waiting).state, 'done');
});

test('inject goes through submit() of an Agent SDK session, which queues it for its next turn', (t) => {
  const h = harness({ running: ['app-beta'] });
  t.after(h.cleanup);
  h.sdkTabs.add('app-beta');
  const { id } = ask(h);
  assert.equal(cr.decide(id, { ok: true, mode: 'inject' }).state, 'launched');
  assert.equal(h.submits.length, 1);
  assert.equal(h.submits[0].tabId, 'app-beta');
  assert.match(h.submits[0].text, /Please expose a tool that returns the current reading\./);
  assert.equal(h.writes.length, 0, 'no keystrokes into an SDK session');
});

test('an injected request ends when the open session closes without reporting, and extends the chain', async (t) => {
  const h = harness({ running: ['app-beta'], maxDepth: 2 });
  t.after(h.cleanup);
  const { id } = ask(h);
  cr.decide(id, { ok: true, mode: 'inject' });
  // beta (the injected session) asking gamma continues alpha → beta.
  const sub = cr.request({ instanceId: 'cli-beta', to: 'gamma', prompt: 'need it', interface: { kind: 'tool', name: 'x' } });
  assert.deepEqual(cr._internals.byId(sub.id).chain, ['alpha', 'beta', 'gamma']);
  h.exit('beta');
  await afterGrace();
  assert.equal(cr.status(id).state, 'ended');
});

test('Queue keeps the old behaviour, and a queued request can be injected now', async (t) => {
  const h = harness({ running: ['app-beta'] });
  t.after(h.cleanup);
  const { id } = ask(h);
  assert.equal(cr.decide(id, { ok: true, mode: 'queue' }).state, 'queued');
  assert.equal(h.writes.length, 0);
  const q = shown(id);
  assert.equal(q.targetBusy, true);
  assert.equal(q.canInject, true);
  assert.match(q.queueNote, /waiting for it to close; the owner can still inject/);
  assert.match(cr.status(id).text, /is queued\./);

  assert.equal(cr.inject(id, { prompt: 'inject now' }).state, 'launched');
  assert.equal(h.writes.length, 2);
  assert.match(h.writes[0].data, /inject now/);
  assert.equal(cr._internals.byId(id).targetTabId, 'app-beta');
  assert.equal(cr.inject(id).error, 'request is launched', 'not twice');
});

test('a failed write leaves the request queued, with the reason on the record', async (t) => {
  const h = harness({ running: ['app-beta'] });
  t.after(h.cleanup);
  h.sdkTabs.add('app-beta');
  h.submitError = 'this session is not running';
  const { id } = ask(h);
  const res = cr.decide(id, { ok: true, mode: 'inject' });
  assert.match(res.error, /could not write into the open session/);
  const r = shown(id);
  assert.equal(r.state, 'queued');
  assert.match(r.injectError, /this session is not running/);
  assert.match(r.queueNote, /Injecting failed/);
  assert.match(cr.status(id).note, /Injecting failed/);
  assert.equal(h.submits.length, 0);

  // Still released by the tab closing, as any queued request.
  h.exit('beta');
  await afterGrace();
  assert.equal(cr.status(id).state, 'launched');
  assert.equal(h.launches.length, 1);
});

test('an inject on a target that has since closed just opens it', (t) => {
  const h = harness({ running: ['app-beta'] });
  t.after(h.cleanup);
  const { id } = ask(h);
  h.running.delete('app-beta');
  assert.equal(cr.decide(id, { ok: true, mode: 'inject' }).state, 'launched');
  assert.equal(h.launches.length, 1, 'opened normally, nothing to write into');
  assert.equal(h.writes.length, 0);
});

test('a worker tab is never an injection target, and a platform request is queue-only', (t) => {
  const h = harness();
  t.after(h.cleanup);
  // beta has only an orchestration worker open (stamped, not the change tab).
  h.sessions.set('cli-w', { tabId: 'tab-w-1', sessId: 'sw', settings: { [cr._internals.STAMP_APP]: 'beta', orchestration: { role: 'worker', orchestrator: 'app-beta' } } });
  h.running.add('tab-w-1');
  const { id } = ask(h);
  assert.equal(shown(id).canInject, false);
  assert.equal(cr.decide(id, { ok: true, mode: 'inject' }).state, 'launched', 'idle target: opened, the worker is not in the way');
  assert.equal(h.writes.length, 0);

  const h2 = harness({ running: ['tg-pro'] });
  t.after(h2.cleanup);
  const p = cr.request({ instanceId: 'cli-alpha', to: 'platform', prompt: 'p', interface: { kind: 'method', name: 'email.list' }, adds: ['x'] });
  const r = shown(p.id);
  assert.equal(r.targetBusy, true);
  assert.equal(r.canInject, false);
  assert.match(r.queueNote, /never injected/);
  const res = cr.decide(p.id, { ok: true, mode: 'inject' });
  assert.equal(res.state, 'queued');
  assert.match(shown(p.id).injectError, /platform request is never injected/);
  assert.equal(h2.writes.length, 0);
});

test('an injected request survives a restart like any launched one', (t) => {
  const h = harness({ running: ['app-beta'] });
  t.after(h.cleanup);
  const { id } = ask(h);
  cr.decide(id, { ok: true, mode: 'inject' });
  const saved = JSON.parse(fs.readFileSync(path.join(h.dataHome, 'change-requests.json'), 'utf8')).requests.find((r) => r.id === id);
  assert.equal(saved.state, 'launched');
  assert.equal(saved.injected, true);
  assert.equal(saved.targetTabId, 'app-beta');
});

test('done verifies the interface is really there before saying so', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const { id } = ask(h, { interface: { kind: 'event', name: 'reading' } });
  cr.decide(id, { ok: true });
  const waiting = cr.wait(id, 5000);

  let out = cr.done({ instanceId: 'cli-beta', id, summary: 'emits beta:reading every minute' });
  assert.equal(out.verified, false);
  assert.match(out.text, /Verified live: no/);

  // Same request, but this time the manifest actually declares the kind.
  const h2 = harness();
  t.after(h2.cleanup);
  h2.manifests.set('beta', { name: 'beta', events: { emits: { 'beta:reading': { description: 'a reading' } } } });
  const r2 = ask(h2, { interface: { kind: 'event', name: 'beta:reading' } });
  cr.decide(r2.id, { ok: true });
  out = cr.done({ instanceId: 'cli-beta', id: r2.id, summary: 'emits beta:reading every minute' });
  assert.equal(out.verified, true);
  assert.match(out.text, /Verified live: yes/);
  await waiting;
});

// --- Changing an interface that already exists ---------------------------
// The dangerous case: the tool is already there, so "does the tool exist"
// verifies the moment the request is made. What has to be proven instead is
// that the tool CHANGED, and that it changed without breaking its callers.

const liveTool = (h, params, required = [], returns = '') => {
  h.tools.length = 0;
  h.tools.push({
    _ownerApp: 'beta',
    name: 'current_reading',
    description: 'the current reading',
    inputSchema: { type: 'object', properties: Object.fromEntries(params.map((p) => [p, { type: 'string' }])), required },
    returns,
  });
};

test('asking for a tool that already exists is a change, not an addition', (t) => {
  const h = harness();
  t.after(h.cleanup);
  liveTool(h, ['sensor']);
  const res = ask(h, { adds: ['since'] });
  assert.equal(res.mode, 'extend');
  const rec = cr.list().find((r) => r.id === res.id);
  assert.deepEqual(rec.adds, ['since']);
  assert.deepEqual(rec.before.params, ['sensor']);

  // The target session is told it is changing something live, what it takes
  // today, and that compatibility is the constraint.
  const section = cr.targetPromptSection({ ...rec, depth: 0, maxDepth: 1 });
  assert.match(section, /asks for a CHANGE/);
  assert.match(section, /What is missing today: \*\*since\*\*/);
  assert.match(section, /It takes `sensor` today/);
  assert.match(section, /backwards compatible/);
  assert.match(section, /do not make one required that was not required before/);
});

test('a tool that gains nothing is not reported as delivered', (t) => {
  const h = harness();
  t.after(h.cleanup);
  liveTool(h, ['sensor']);
  const { id } = ask(h, { adds: ['since'] });
  cr.decide(id, { ok: true });

  // The session says done, but the tool still takes only what it always took.
  const out = cr.done({ instanceId: 'cli-beta', id, summary: 'added it' });
  assert.equal(out.verified, false);
  assert.match(out.verifyDetail, /still does not take since/);
  assert.match(out.text, /Verified live: no/);
});

test('a compatible extension verifies, and the asking session is told what it got', (t) => {
  const h = harness();
  t.after(h.cleanup);
  liveTool(h, ['sensor']);
  const { id } = ask(h, { adds: ['since'] });
  cr.decide(id, { ok: true });
  liveTool(h, ['sensor', 'since']);

  const out = cr.done({ instanceId: 'cli-beta', id, summary: 'since is optional and defaults to now' });
  assert.equal(out.verified, true);
  assert.equal(out.compatible, true);
  assert.match(out.text, /changed the tool "current_reading"/);
  assert.match(out.text, /You asked for: since/);
  assert.match(out.text, /Verified live: yes\./);
});

test('an extension that breaks its callers verifies but is flagged, not hidden', (t) => {
  const h = harness();
  t.after(h.cleanup);
  liveTool(h, ['sensor']);
  const { id } = ask(h, { adds: ['since'] });
  cr.decide(id, { ok: true });
  // "since" arrived, but the old parameter was renamed and the new one is
  // required — every existing caller is now broken.
  liveTool(h, ['probe', 'since'], ['since']);

  const out = cr.done({ instanceId: 'cli-beta', id, summary: 'reworked the signature' });
  assert.equal(out.verified, true);
  assert.equal(out.compatible, false);
  assert.match(out.verifyDetail, /sensor disappeared/);
  assert.match(out.verifyDetail, /since became required/);
  assert.match(out.text, /NOT backwards compatible/);
});

// A tool's `returns` is prose, not a schema. It is snapshotted so the target
// session can be told the contract it has to keep, and it is reported back when
// it changes — but it can never make a change "incompatible": no sentence can
// prove the result is still a superset, and pretending otherwise would either
// block honest reworder or bless a genuine break.
test('the result contract is snapshotted and put to the target session', (t) => {
  const h = harness();
  t.after(h.cleanup);
  liveTool(h, ['sensor'], [], '{ value, at } — at is an ISO string');
  const { id } = ask(h, { adds: ['since'] });
  assert.equal(cr.list().find((r) => r.id === id).before.returns, '{ value, at } — at is an ISO string');

  cr.decide(id, { ok: true });
  const section = cr.targetPromptSection(h.launches[0].params.changeRequest);
  assert.match(section, /result contract today.*\{ value, at \} — at is an ISO string/);
  assert.match(section, /SUPERSET/);
  assert.match(section, /update the tool's `returns:` string/);
});

test('a tool that never said what it returns is asked to start saying so', (t) => {
  const h = harness();
  t.after(h.cleanup);
  liveTool(h, ['sensor']);
  const { id } = ask(h, { adds: ['since'] });
  cr.decide(id, { ok: true });
  const section = cr.targetPromptSection(h.launches[0].params.changeRequest);
  assert.match(section, /does not say what its result contains/);
  assert.match(section, /Add a one-line `returns:`/);
});

test('a changed result contract is reported as news, never as an incompatibility', (t) => {
  const h = harness();
  t.after(h.cleanup);
  liveTool(h, ['sensor'], [], '{ value, at }');
  const { id } = ask(h, { adds: ['since'] });
  cr.decide(id, { ok: true });
  liveTool(h, ['sensor', 'since'], [], '{ value, at, unit }');

  const out = cr.done({ instanceId: 'cli-beta', id, summary: 'since is optional; the result gained unit' });
  assert.equal(out.verified, true);
  assert.equal(out.compatible, true);
  assert.match(out.verifyDetail, /result contract now reads "\{ value, at, unit \}"/);
  // And the asking session hears it, rather than it stopping at the record.
  assert.match(out.text, /Verified live: yes — the result contract now reads/);
});

test('a rewritten result contract is change enough on its own', (t) => {
  const h = harness();
  t.after(h.cleanup);
  liveTool(h, ['sensor'], [], '{ value }');
  const { id } = ask(h);   // no --adds: the fallback "did anything change at all" decides
  cr.decide(id, { ok: true });
  liveTool(h, ['sensor'], [], '{ value, unit }');

  const out = cr.done({ instanceId: 'cli-beta', id, summary: 'documented the unit field' });
  assert.equal(out.verified, true);
  assert.equal(out.compatible, true);
});

test('dropping the result contract is said out loud, and still not incompatible', (t) => {
  const h = harness();
  t.after(h.cleanup);
  liveTool(h, ['sensor'], [], '{ value, at }');
  const { id } = ask(h, { adds: ['since'] });
  cr.decide(id, { ok: true });
  liveTool(h, ['sensor', 'since']);

  const out = cr.done({ instanceId: 'cli-beta', id, summary: 'since added' });
  assert.equal(out.verified, true);
  assert.equal(out.compatible, true);
  assert.match(out.verifyDetail, /result contract was dropped/);
});

test('a stopped target is still comparable through its manifest', (t) => {
  const h = harness();
  t.after(h.cleanup);
  // Nothing in the live union: the app is not mounted. The manifest keeps the
  // last registration, so the request still knows this is a change.
  h.manifests.set('beta', {
    name: 'beta',
    tools: [{ name: 'current_reading', description: 'x', inputSchema: { type: 'object', properties: { sensor: {} } } }],
  });
  const res = ask(h, { adds: ['since'] });
  assert.equal(res.mode, 'extend');
  assert.deepEqual(cr.list().find((r) => r.id === res.id).before.params, ['sensor']);
});

test('a brand new tool is still an addition, and its parameters are checked', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const { id } = ask(h, { adds: ['since'] });
  assert.equal(cr.list().find((r) => r.id === id).mode, 'add');
  cr.decide(id, { ok: true });
  h.tools.push({ _ownerApp: 'beta', name: 'current_reading', inputSchema: { type: 'object', properties: {} } });
  let out = cr.done({ instanceId: 'cli-beta', id, summary: 'done' });
  assert.equal(out.verified, false);
  assert.match(out.verifyDetail, /does not take since/);
});

test('only the target app may report a request done', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const { id } = ask(h);
  cr.decide(id, { ok: true });
  assert.match(cr.done({ instanceId: 'cli-gamma', id, summary: 'x' }).error, /not of "gamma"/);
});

test('the outcome reaches the session through the waiter, the tab, or a relaunch', async (t) => {
  // Tier 1: a waiter is attached.
  const h1 = harness();
  t.after(h1.cleanup);
  const r1 = ask(h1);
  cr.decide(r1.id, { ok: true });
  const waiting = cr.wait(r1.id, 5000);
  const done1 = cr.done({ instanceId: 'cli-beta', id: r1.id, summary: 's' });
  assert.equal(done1.deliveredVia, 'waiter');
  assert.equal((await waiting).state, 'done');
  assert.equal(h1.writes.length, 0, 'no PTY write while a waiter is listening');

  // Tier 2: the waiter is gone but the asking tab is still open.
  const h2 = harness({ running: ['app-alpha'] });
  t.after(h2.cleanup);
  const r2 = ask(h2);
  cr.decide(r2.id, { ok: true });
  cr._internals.byId(r2.id).lastPollAt = Date.now() - cr._internals.WAITER_FRESH_MS - 1000;
  const done2 = cr.done({ instanceId: 'cli-beta', id: r2.id, summary: 's' });
  assert.equal(done2.deliveredVia, 'pty');
  assert.equal(h2.writes.length, 2);
  assert.equal(h2.writes[0].tabId, 'app-alpha');
  assert.match(h2.writes[0].data, /is UNVERIFIED/);
  assert.equal(h2.writes[1].data, '\r', 'the carriage return is a separate write, or the CLI treats it as a paste');

  // Tier 3: waiter gone, tab gone — the session is reopened on its transcript.
  const h3 = harness();
  t.after(h3.cleanup);
  const r3 = ask(h3);
  cr.decide(r3.id, { ok: true });
  h3.launches.length = 0;
  h3.running.delete('app-alpha');
  cr._internals.byId(r3.id).lastPollAt = 0;
  const done3 = cr.done({ instanceId: 'cli-beta', id: r3.id, summary: 's' });
  assert.equal(done3.deliveredVia, 'relaunch');
  assert.equal(h3.launches[0].appName, 'alpha');
  assert.match(h3.launches[0].params.prompt, /is UNVERIFIED/);
});

test('a target tab that closes without reporting is not silence', async (t) => {
  const h = harness({ running: ['app-alpha'] });
  t.after(h.cleanup);
  const { id } = ask(h);
  cr.decide(id, { ok: true });
  cr._internals.byId(id).lastPollAt = 0;
  h.exit('beta');
  await afterGrace();
  assert.equal(cr.status(id).state, 'ended');
  assert.match(h.writes[0].data, /ended without reporting completion/);

  // The owner may reopen the target and finish the job: done still lands.
  h.writes.length = 0;
  const out = cr.done({ instanceId: 'cli-beta', id, summary: 'done after all' });
  assert.equal(out.state, 'done');
  assert.match(h.writes[0].data, /is UNVERIFIED/);
});

test('a relaunch inside the same tab is not read as an ended session', async (t) => {
  // launchChangeSession's APP.md pre-flight chains a second session onto the
  // first one's exit — the request must survive that.
  const h = harness();
  t.after(h.cleanup);
  const { id } = ask(h);
  cr.decide(id, { ok: true });
  const tabId = 'app-beta';
  h.running.delete(tabId);
  const hooks = h.exitHooks.get(tabId) || [];
  h.exitHooks.delete(tabId);
  for (const hook of hooks) hook(tabId);
  h.running.add(tabId);            // the pre-flight opens the real change session
  await afterGrace();
  assert.equal(cr.status(id).state, 'launched');
});

test('the owner can cancel at any point and the session is told', (t) => {
  const h = harness({ running: ['app-alpha'] });
  t.after(h.cleanup);
  const { id } = ask(h);
  cr.decide(id, { ok: true });
  cr._internals.byId(id).lastPollAt = 0;
  assert.equal(cr.cancel(id, 'owner').state, 'cancelled');
  assert.match(h.writes[0].data, /was cancelled by the owner/);
  assert.match(cr.cancel(id, 'owner').error, /already cancelled/);
});

test('the hop limit is a setting, and a chain never bites its own tail', (t) => {
  const h = harness({ maxDepth: 1 });
  t.after(h.cleanup);
  const { id } = ask(h);
  cr.decide(id, { ok: true });
  // beta was opened BY a request, so at depth 1 it may not ask gamma.
  const refused = cr.request({ instanceId: 'cli-beta', to: 'gamma', prompt: 'p', interface: { kind: 'tool', name: 't' } });
  assert.match(refused.error, /limited to 1 hop/);

  const h2 = harness({ maxDepth: 2 });
  t.after(h2.cleanup);
  const first = ask(h2);
  cr.decide(first.id, { ok: true });
  const second = cr.request({ instanceId: 'cli-beta', to: 'gamma', prompt: 'p', interface: { kind: 'tool', name: 't' } });
  assert.ok(second.id, 'depth 2 allows the second hop');
  assert.deepEqual(cr._internals.byId(second.id).chain, ['alpha', 'beta', 'gamma']);
  cr.decide(second.id, { ok: true });
  assert.match(cr.request({ instanceId: 'cli-gamma', to: 'delta', prompt: 'p', interface: { kind: 'tool', name: 't' } }).error, /no app named/);

  // A cycle back to the app that started the chain is refused before the depth check.
  const h3 = harness({ maxDepth: 3 });
  t.after(h3.cleanup);
  const a = ask(h3);
  cr.decide(a.id, { ok: true });
  assert.match(cr.request({ instanceId: 'cli-beta', to: 'alpha', prompt: 'p', interface: { kind: 'tool', name: 't' } }).error, /cycle/);
});

test('requests survive a restart, and an interrupted waiter falls back to the tab', (t) => {
  const h = harness({ running: ['app-alpha'] });
  t.after(h.cleanup);
  const { id } = ask(h);
  cr.decide(id, { ok: true });
  assert.equal(cr.status(id).state, 'launched');

  // Re-init against the same dataHome: the platform restarted.
  const h2 = harness({ running: ['app-alpha'] });
  h2.dataHome = h.dataHome;
  cr.init({
    dataHome: h.dataHome,
    cliSessionManager: {
      get: (tabId) => (h2.running.has(tabId) ? { running: true, tabId } : null),
      getByInstanceId: (i) => (h2.sessions.get(i) ? { tabId: h2.sessions.get(i).tabId, sessId: h2.sessions.get(i).sessId } : null),
      writeWhenReady: (tabId, data, delay) => h2.writes.push({ tabId, data, delay }),
    },
    appManager: { list: () => [{ name: 'alpha' }, { name: 'beta' }], readManifest: () => ({}) },
    launchChangeSession: (appName, params) => h2.launches.push({ appName, params }),
    broadcaster: { broadcast: (m) => h2.broadcasts.push(m) },
    settings: { get: () => 1 },
    addExitHook: () => {},
  });
  t.after(h2.cleanup);
  assert.equal(cr.status(id).state, 'launched', 'the record outlives the process');
  // The waiter died with the old process, so the outcome goes to the tab.
  const out = cr.done({ instanceId: 'cli-beta', id, summary: 'survived' });
  assert.equal(out.deliveredVia, 'pty');
  assert.match(h2.writes[0].data, /survived/);
});

test("the target session is told who asked, what to build, and how to report", (t) => {
  const h = harness({ maxDepth: 2 });
  t.after(h.cleanup);
  const { id } = ask(h);
  cr.decide(id, { ok: true });
  const section = cr.targetPromptSection(h.launches[0].params.changeRequest);
  assert.match(section, /Requested by another app/);
  assert.match(section, /from the app "alpha"/);
  assert.match(section, /current_reading/);
  assert.match(section, /expose: 'apps'/);
  assert.match(section, /app-change\.js done --id cr-/);
  assert.match(section, /You may request a change of a third app/);

  const h2 = harness({ maxDepth: 1 });
  t.after(h2.cleanup);
  const r2 = ask(h2);
  cr.decide(r2.id, { ok: true });
  assert.match(cr.targetPromptSection(h2.launches[0].params.changeRequest), /may NOT request a change of a third app/);
});

// --- Asking the PLATFORM ---------------------------------------------------
// Same workflow, a different target: the request names a bridge method or a ctx
// member, the owner's Open runs a session in the pro repository instead of an
// app directory, and the check reads the capability module and its
// api-reference section rather than a live tool. The dangerous part is the trust
// boundary — app text in a session that can write the platform — so what is
// asserted here is the mandatory Open, the quoting rule, and the leaf rule.

const askPlatform = (over = {}) => cr.request({
  instanceId: 'cli-alpha', to: 'platform',
  prompt: 'email.list cannot sort oldest-first; the digest needs it.',
  interface: { kind: 'method', name: 'email.list' },
  adds: ['order'], reason: 'alpha renders a chronological digest', ...over,
});

test('a platform request resolves the capability and snapshots its surface', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const res = askPlatform();
  assert.equal(res.state, 'pending');
  assert.equal(res.capability, 'email');
  assert.equal(res.mode, 'extend', 'email.list already exists, so this is a change');
  assert.equal(h.proLaunches.length, 0, 'nothing opens in the platform before the owner decides');

  const rec = cr.list().find((r) => r.id === res.id);
  assert.equal(rec.to, 'platform');
  assert.deepEqual(rec.adds, ['order']);
  assert.ok(rec.before.methods.includes('email.list'));
  assert.ok(rec.before.ctx.includes('email'));
  assert.match(rec.before.sectionText, /email\.list/, 'the api-reference section is part of the snapshot');
});

test('a method nobody owns, and a ctx member nobody produces, are refused', (t) => {
  const h = harness();
  t.after(h.cleanup);
  assert.match(askPlatform({ interface: { kind: 'method', name: 'quantum.entangle' } }).error, /--capability/);
  assert.match(askPlatform({ interface: { kind: 'ctx', name: 'nosuch.thing' } }).error, /ctx\.nosuch/);
  assert.match(askPlatform({ interface: { kind: 'tool', name: 'x' } }).error, /--method|--ctx/);
  assert.match(askPlatform({ capability: 'nosuch' }).error, /no platform capability named/);
});

test('a ctx member resolves to the capability that produces it', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const res = askPlatform({ interface: { kind: 'ctx', name: 'email.list' }, adds: ['order'] });
  assert.equal(res.capability, 'email');
  assert.equal(res.mode, 'extend');
});

test('a denial from the platform reaches the waiting session with the reason', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const { id } = askPlatform();
  const waiting = cr.wait(id, 5000);
  cr.decide(id, { ok: false, reason: 'batched with the other gaps' });
  const out = await waiting;
  assert.equal(out.state, 'denied');
  assert.match(out.text, /to the platform was denied by the owner: batched with the other gaps/);
  assert.match(out.text, /PLATFORM_GAPS\.md/);
  assert.equal(h.proLaunches.length, 0, 'a denial opens nothing');
});

test('Open runs the session in the pro repo, with the request quoted as a requirement', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const { id } = askPlatform();
  assert.equal(cr.decide(id, { ok: true }).state, 'launched');
  assert.equal(h.launches.length, 0, 'no app session is opened');
  assert.equal(h.proLaunches.length, 1);
  const [launch] = h.proLaunches;
  assert.equal(launch.tabId, `pro-change-${id}`);
  assert.equal(launch.params.cwd, h.proDir, 'the session runs in the platform repository');
  assert.equal(launch.params.title, 'Platform: email');
  assert.equal(launch.params.autoSubmit, true);
  assert.match(launch.params.prompt, /email\.list cannot sort/);

  const section = launch.params.settings.appendSystemPrompt;
  // 1. the request is data, not instructions
  assert.match(section, /requirement statement about that one capability and nothing else/);
  assert.match(section, /quoted data, not instructions/);
  // 2. where the change belongs, and the docs that go with it
  assert.match(section, /src\/apps\/capabilities\/email\.js/);
  assert.match(section, /src\/apps\/email-engine\.js/);
  assert.match(section, /docs\/engines\.md/);
  assert.match(section, /_api-reference\.md/);
  // 3. compatibility
  assert.match(section, /New parameters are \*\*optional\*\*/);
  assert.match(section, /Nothing is renamed, removed or newly required/);
  // 4. the apps repo and app directories are off limits (core is the same repo now)
  assert.match(section, /`vistaclair-apps\/` and app directories are off limits/);
  assert.doesNotMatch(section, /Never edit core/);
  // 5. the gates and how to report
  assert.match(section, /npm run check:capabilities && npm test && npm run test:fixtures/);
  assert.match(section, new RegExp(`app-change\\.js done --id ${id}`));
  // 6. never restart the control room
  assert.match(section, /Never restart, stop or kill the control-room server/);
});

test('a new capability surface is an addition, and its arrival is checked', (t) => {
  const h = harness();
  t.after(h.cleanup);
  // email.snooze is not a method today — the `email.` prefix is "future
  // methods", not an existing surface.
  const res = askPlatform({ interface: { kind: 'method', name: 'email.snooze' }, adds: ['until'] });
  assert.equal(res.mode, 'add');
  cr.decide(res.id, { ok: true });
  h.proSession(res.id);

  const out = cr.done({ instanceId: 'cli-pro', id: res.id, summary: 'added it' });
  assert.equal(out.error, undefined);
  assert.equal(out.verified, false);
  assert.match(out.verifyDetail, /does not declare the bridge method "email\.snooze"/);

  // The module now declares it and the section documents the parameter, so the
  // same ask from another app reads as a change to a live surface.
  h.caps.get('email').methods.push('email.snooze');
  h.sections.set('email', `${EMAIL_SECTION}- \`email.snooze({ id, until })\` — snooze.\n`);
  h.writeReference();
  const r2 = cr.request({
    instanceId: 'cli-beta', to: 'platform', prompt: 'snooze needs a reason too',
    interface: { kind: 'method', name: 'email.snooze' }, adds: ['reason'],
  });
  assert.equal(r2.mode, 'extend', 'once it exists, asking again is a change');
});

test('a new ctx member mirroring documented Bridge methods verifies once declared and documented', (t) => {
  // `list` is already documented — as the Bridge method email.list — so the
  // asked-for names alone cannot prove anything; the new member can.
  const ask = () => askPlatform({ interface: { kind: 'ctx', name: 'mailer.list' }, capability: 'email', adds: ['list'] });
  const h = harness();
  t.after(h.cleanup);
  const res = ask();
  assert.equal(res.mode, 'add');
  cr.decide(res.id, { ok: true });
  h.caps.get('email').ctx.push('mailer');
  h.sections.set('email', `${EMAIL_SECTION}- \`ctx.mailer.list()\` — from routes.js.\n`);
  h.writeReference();
  h.proSession(res.id);
  const out = cr.done({ instanceId: 'cli-pro', id: res.id, summary: 'ctx.mailer.list' });
  assert.equal(out.verified, true, out.verifyDetail);
  assert.equal(out.compatible, true);

  // Declared but not documented is still not delivered.
  const h2 = harness();
  t.after(h2.cleanup);
  const r2 = ask();
  cr.decide(r2.id, { ok: true });
  h2.caps.get('email').ctx.push('mailer');
  h2.proSession(r2.id);
  const out2 = cr.done({ instanceId: 'cli-pro', id: r2.id, summary: 'x' });
  assert.equal(out2.verified, false);
  assert.match(out2.verifyDetail, /does not document `ctx\.mailer`/);
});

test('a capability that gains nothing is not reported as delivered', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const { id } = askPlatform();
  cr.decide(id, { ok: true });
  // The platform session reported done without touching anything.
  h.proSession(id);
  const out = cr.done({ instanceId: 'cli-pro', id, summary: 'done' });
  assert.equal(out.verified, false);
  assert.match(out.verifyDetail, /does not document `order`/);
  assert.match(out.text, /Verified in the platform source: no/);
});

test('a restored platform tab still serves its request: done, and its exit', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const { id } = askPlatform();
  cr.decide(id, { ok: true });
  const [launch] = h.proLaunches;
  assert.equal(launch.tabId, `pro-change-${id}`);
  assert.equal(launch.params.settings[cr._internals.STAMP_REQUEST], id, 'the launch stamps its request id');
  // Core restored the tab as tab-b5-1; only the stamp says what it is.
  h.running.delete(`pro-change-${id}`);
  h.sessions.set('cli-pro', { tabId: 'tab-b5-1', sessId: 'sess-pro', settings: { [cr._internals.STAMP_REQUEST]: id } });
  h.running.add('tab-b5-1');
  // The platform is busy while that tab is open…
  h.sessions.set('cli-gamma', { tabId: 'app-gamma', sessId: 'sess-gamma' });
  h.running.add('app-gamma');
  const second = cr.request({ instanceId: 'cli-gamma', to: 'platform', prompt: 'p', interface: { kind: 'method', name: 'email.list' } });
  cr.decide(second.id, { ok: true });
  assert.equal(cr.status(second.id).state, 'queued');
  // …and a restored tab may only report ITS request.
  assert.match(cr.done({ instanceId: 'cli-pro', id: second.id, summary: 'x' }).error, new RegExp(`opened for request ${id}`));
  const out = cr.done({ instanceId: 'cli-pro', id, summary: 'done' });
  assert.equal(out.state, 'done');
  // Closing the restored tab hands the queue to the next platform request.
  h.exitTab('tab-b5-1');
  await afterGrace();
  assert.equal(cr.status(second.id).state, 'launched');

  // The same restored tab closing WITHOUT reporting ends only its own request.
  const h2 = harness();
  t.after(h2.cleanup);
  const r = askPlatform();
  cr.decide(r.id, { ok: true });
  h2.running.delete(`pro-change-${r.id}`);
  h2.sessions.set('cli-pro', { tabId: 'tab-b6-1', sessId: 'sess-pro', settings: { [cr._internals.STAMP_REQUEST]: r.id } });
  h2.running.add('tab-b6-1');
  // Nothing armed the restored tab; the next read of the state does.
  assert.equal(h2.exitHooks.has('tab-b6-1'), false);
  cr.list();
  assert.equal(h2.exitHooks.has('tab-b6-1'), true);
  h2.exitTab('tab-b6-1');
  await afterGrace();
  assert.equal(cr.status(r.id).state, 'ended');
});

test('documenting the parameter verifies, and the outcome says it needs a restart', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const { id } = askPlatform();
  cr.decide(id, { ok: true });
  // The platform session adds the parameter to the section.
  h.sections.set('email', `${EMAIL_SECTION}\n\`order\` — \`'newest'\` (default) or \`'oldest'\`.\n`);
  h.writeReference();

  h.proSession(id);
  const out = cr.done({ instanceId: 'cli-pro', id, summary: 'order is optional, defaults to newest' });
  assert.equal(out.verified, true);
  assert.equal(out.compatible, true);
  assert.equal(out.to, 'platform');
  assert.match(out.text, /The platform changed the bridge method "email\.list" in capability `email`/);
  assert.match(out.text, /You asked for: order/);
  assert.match(out.text, /Verified in the platform source: yes/);
  assert.match(out.text, /takes effect at the next control-room restart, which only the owner performs/);
  assert.match(out.text, /do NOT call it in this session/);
});

test('a parameter named inside a signature counts as documented', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const { id } = askPlatform();
  cr.decide(id, { ok: true });
  h.sections.set('email', '### Email Engine\n\n- `email.list({ account?, folder?, limit?, order? })` — query emails.\n');
  h.writeReference();
  h.proSession(id);
  assert.equal(cr.done({ instanceId: 'cli-pro', id, summary: 'added order' }).verified, true);
});

test('a token that was already documented proves nothing changed', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const { id } = askPlatform({ adds: ['limit'] });
  cr.decide(id, { ok: true });
  h.proSession(id);
  const out = cr.done({ instanceId: 'cli-pro', id, summary: 'it was already there' });
  assert.equal(out.verified, false);
  assert.match(out.verifyDetail, /already documented before this session/);
});

test('a surface that disappeared is flagged, not smoothed over', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const { id } = askPlatform();
  cr.decide(id, { ok: true });
  // `order` arrived, but email.send was dropped and ctx.emailAccounts with it.
  h.sections.set('email', `${EMAIL_SECTION}\n\`order\` — sort direction.\n`);
  h.writeReference();
  h.caps.get('email').methods = ['email.list'];
  h.caps.get('email').ctx = ['email'];

  h.proSession(id);
  const out = cr.done({ instanceId: 'cli-pro', id, summary: 'reworked it' });
  assert.equal(out.verified, true);
  assert.equal(out.compatible, false);
  assert.match(out.verifyDetail, /the method `email\.send`/);
  assert.match(out.verifyDetail, /disappeared from the capability/);
  assert.match(out.verifyDetail, /`ctx\.emailAccounts`/);
  assert.match(out.text, /NOT backwards compatible/);
});

test('a platform session is a leaf: it may report done, never ask', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const { id } = askPlatform();
  cr.decide(id, { ok: true });
  // The pro tab is a live session with an instance id of its own — and it may
  // not open a request of any kind. App text gets exactly one hop into the
  // platform, the one the owner clicked Open on.
  h.proSession(id);
  assert.match(cr.request({
    instanceId: 'cli-pro', to: 'beta', prompt: 'p', interface: { kind: 'tool', name: 't' },
  }).error, /app change tab/);
  assert.match(cr.request({
    instanceId: 'cli-pro', to: 'platform', prompt: 'p', interface: { kind: 'method', name: 'email.list' },
  }).error, /app change tab/);

  // …and it may only report the request its OWN tab was opened for.
  h.proSession('cr-someone-else', 'cli-pro-other');
  assert.match(cr.done({ instanceId: 'cli-pro-other', id, summary: 'x' }).error, /opened for request cr-someone-else/);
  assert.equal(cr.done({ instanceId: 'cli-pro', id, summary: 'ok' }).state, 'done');
});

test('one platform session at a time: a request queues behind tg-pro', async (t) => {
  const h = harness({ running: ['tg-pro'] });
  t.after(h.cleanup);
  const { id } = askPlatform();
  assert.equal(cr.decide(id, { ok: true }).state, 'queued');
  assert.equal(h.proLaunches.length, 0, 'the owner\'s Telegram session is never killed');
  h.exitTab('tg-pro');
  await afterGrace();
  assert.equal(h.proLaunches.length, 1);
  assert.equal(cr.status(id).state, 'launched');
});

test('a second platform request waits for the first pro session to close', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const first = askPlatform();
  cr.decide(first.id, { ok: true });
  assert.equal(h.proLaunches.length, 1);

  const second = cr.request({
    instanceId: 'cli-beta', to: 'platform', prompt: 'calendar too',
    interface: { kind: 'method', name: 'email.send' }, adds: ['replyTo'],
  });
  assert.equal(cr.decide(second.id, { ok: true }).state, 'queued');
  assert.equal(h.proLaunches.length, 1, 'the open pro session is not replaced');

  // The first session closes without reporting: it ends, and the queue moves on.
  cr._internals.byId(first.id).lastPollAt = 0;
  h.exitTab(`pro-change-${first.id}`);
  await afterGrace();
  assert.equal(cr.status(first.id).state, 'ended');
  assert.equal(cr.status(second.id).state, 'launched');
  assert.equal(h.proLaunches.length, 2);
});

test('the platform surface is read from disk, never from the running registry', (t) => {
  // The registry in this process is frozen until the owner restarts, so the
  // check has to load the modules again. That read is what makes `done` mean
  // anything at all — here it runs against the real repository.
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-cr-'));
  t.after(() => fs.rmSync(dataHome, { recursive: true, force: true }));
  cr.init({ dataHome, proDir: path.join(__dirname, '..') });
  const snap = cr._internals.snapshotCapability('email', { fresh: true });
  assert.ok(snap.methods.includes('email.list'), 'the module was loaded in a child process');
  assert.ok(snap.ctx.includes('email'));
  assert.match(snap.sectionText, /email\.list/, 'the api-reference section came with it');
  assert.equal(cr._internals.documentsToken(snap.sectionText, 'folder'), true);
  assert.equal(cr._internals.documentsToken(snap.sectionText, 'order'), false);
});

// --- An outcome is honest, and it is never swallowed ----------------------

test('a done whose check failed is unverified everywhere, and says what is missing', (t) => {
  const h = harness();
  t.after(h.cleanup);
  liveTool(h, ['unit']);
  const { id } = ask(h, { adds: ['window'] });
  cr.decide(id, { ok: true });
  const waiting = cr.wait(id, 5000);
  const out = cr.done({ instanceId: 'cli-beta', id, summary: 'added window' });
  assert.equal(out.state, 'done', 'the target did report: the lifecycle is unchanged');
  assert.equal(out.outcome, 'unverified');
  assert.match(out.text, /^Change request \S+ is UNVERIFIED: "beta" reported it done/);
  assert.match(out.text, /the tool still does not take window/);
  assert.doesNotMatch(out.text, /is done\./);
  const listed = cr.list().find((r) => r.id === id);
  assert.equal(listed.outcome, 'unverified');
  assert.equal(listed.verifyDetail, 'the tool still does not take window');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dataHome, 'change-requests.json'), 'utf8')).requests[0].outcome, 'unverified');
  return waiting.then((w) => assert.equal(w.outcome, 'unverified'));
});

test('status checks an unverified app request again, so a restart can verify it', (t) => {
  const h = harness();
  t.after(h.cleanup);
  liveTool(h, ['unit']);
  const { id } = ask(h, { adds: ['window'] });
  cr.decide(id, { ok: true });
  cr.wait(id, 1000);
  assert.equal(cr.done({ instanceId: 'cli-beta', id, summary: 's' }).outcome, 'unverified');
  assert.equal(cr.status(id).outcome, 'unverified');
  liveTool(h, ['unit', 'window']);   // the owner restarted beta
  const st = cr.status(id);
  assert.equal(st.outcome, 'verified');
  assert.match(st.text, /is done\..*Verified live: yes/);
});

test('a platform request whose check failed is unverified and is not promised by a restart', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const { id } = cr.request({ instanceId: 'cli-alpha', to: 'platform', prompt: 'p', interface: { kind: 'method', name: 'email.list' }, adds: ['order'] });
  cr.decide(id, { ok: true });
  cr.wait(id, 1000);
  const out = cr.done({ instanceId: h.proSession(id), id, summary: 'order added' });
  assert.equal(out.outcome, 'unverified');
  assert.match(out.text, /is UNVERIFIED: the platform session reported it done/);
  assert.match(out.text, /does not document `order`/);
  assert.doesNotMatch(out.text, /takes effect at the next control-room restart/);
});

test('finished records written before the outcome field still load and read right', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const base = { chain: ['alpha', 'beta'], from: 'alpha', to: 'beta', interface: { kind: 'tool', name: 't' }, mode: 'add', adds: [], state: 'done', doneAt: 1, summary: 's', deliveredVia: 'waiter' };
  fs.writeFileSync(path.join(h.dataHome, 'change-requests.json'), JSON.stringify({ requests: [
    { ...base, id: 'cr-old-1', verified: false, compatible: true, verifyDetail: 'the tool is not registered' },
    { ...base, id: 'cr-old-2', verified: true, compatible: true, verifyDetail: '' },
    { ...base, id: 'cr-old-3', state: 'denied', denyReason: 'no' },
  ] }));
  cr.init({ dataHome: h.dataHome, appManager: { list: () => [], readManifest: () => ({}) } });
  const byId = Object.fromEntries(cr.list().map((r) => [r.id, r]));
  assert.equal(byId['cr-old-1'].outcome, 'unverified');
  assert.equal(byId['cr-old-2'].outcome, 'verified');
  assert.equal(byId['cr-old-3'].outcome, null);
  assert.match(cr.outcomeText(cr._internals.byId('cr-old-1')), /UNVERIFIED.*the tool is not registered/);
});

test('a relaunch reopens the asking session on its own transcript', (t) => {
  const h = harness({ transcripts: new Set(['sess-alpha']) });
  t.after(h.cleanup);
  const { id } = ask(h);
  cr.decide(id, { ok: true });
  h.launches.length = 0;
  cr._internals.byId(id).lastPollAt = 0;
  const out = cr.done({ instanceId: 'cli-beta', id, summary: 's' });
  assert.equal(out.deliveredVia, 'relaunch');
  assert.equal(h.launches[0].appName, 'alpha');
  assert.equal(h.launches[0].params.resumeSessionId, 'sess-alpha');
  assert.doesNotMatch(h.launches[0].params.prompt, /NEW session/);
});

test('a relaunch that cannot resume opens a fresh session and says so', (t) => {
  // No transcript left.
  const h = harness({ transcripts: new Set() });
  t.after(h.cleanup);
  const { id } = ask(h);
  cr.decide(id, { ok: true });
  h.launches.length = 0;
  cr._internals.byId(id).lastPollAt = 0;
  const out = cr.done({ instanceId: 'cli-beta', id, summary: 's' });
  assert.equal(out.deliveredVia, 'relaunch-fresh');
  assert.equal(h.launches.length, 1);
  assert.equal(h.launches[0].params.resumeSessionId, undefined);
  assert.match(h.launches[0].params.prompt, /This is a NEW session/);
  assert.match(h.launches[0].params.prompt, /could not be resumed \(no transcript of session sess-alpha/);
  assert.match(h.launches[0].params.prompt, /\.vistaclair\/change-request-beta\.md/);
  assert.match(h.launches[0].params.prompt, /The outcome: Change request \S+ is UNVERIFIED/);
  assert.equal(cr.list().find((r) => r.id === id).deliveredVia, 'relaunch-fresh');

  // Core refuses the resume.
  const h2 = harness();
  t.after(h2.cleanup);
  const r2 = ask(h2);
  cr.decide(r2.id, { ok: true });
  h2.launches.length = 0;
  h2.launchError = (params) => (params.resumeSessionId ? new Error('no transcript for session sess-alpha') : null);
  cr._internals.byId(r2.id).lastPollAt = 0;
  assert.equal(cr.cancel(r2.id).state, 'cancelled');
  assert.equal(h2.launches.length, 1);
  assert.match(h2.launches[0].params.prompt, /resuming session sess-alpha failed: no transcript/);
  assert.match(h2.launches[0].params.prompt, /was cancelled by the owner/);
});

test('launchChangeSession hands a resume target to core', async (t) => {
  const appsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-cr-launch-'));
  t.after(() => fs.rmSync(appsDir, { recursive: true, force: true }));
  const dir = path.join(appsDir, 'fx-cr');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'fx-cr' }));
  fs.writeFileSync(path.join(dir, 'APP.md'), '# fx-cr\n');
  fs.writeFileSync(path.join(dir, 'index.html'), '<p>x</p>\n');
  const apps = require('../src/apps/index');
  const calls = [];
  apps.initSessions({
    appsDir, proxyPort: 0, broadcaster: { broadcast() {} },
    cliSessionManager: { launchSession: (tabId, o) => calls.push({ tabId, o }), onExit() {} },
  });
  await apps.launchChangeSession('fx-cr', { action: 'extend', prompt: 'outcome', autoSubmit: true, resumeSessionId: 'abc' });
  await apps.launchChangeSession('fx-cr', { action: 'extend', prompt: 'outcome', autoSubmit: true });
  assert.deepEqual(calls[0].o.spawnOpts, { resumeSessionId: 'abc' });
  assert.equal(calls[1].o.spawnOpts, undefined, 'no resume unless asked for');
});

test('a waiter whose connection closed does not swallow the outcome', (t) => {
  const h = harness({ running: ['app-alpha'], repollGraceMs: 0 });
  t.after(h.cleanup);
  const { id } = ask(h);
  cr.decide(id, { ok: true });
  let close;
  const waiting = cr.wait(id, 5000, { onClose: (fn) => { close = fn; } });
  close();   // the script died while parked on its long-poll
  const out = cr.done({ instanceId: 'cli-beta', id, summary: 's' });
  assert.equal(out.deliveredVia, 'pty');
  assert.match(h.writes[0].data, /is UNVERIFIED/);
  return waiting.then((w) => assert.equal(w.closed, true));
});

test('a waiter that polled moments ago gets its outcome on the next poll, not twice', async (t) => {
  const h = harness({ running: ['app-alpha'], repollGraceMs: 200 });
  t.after(h.cleanup);
  const { id } = ask(h);
  cr.decide(id, { ok: true });
  cr._internals.byId(id).lastPollAt = Date.now();   // between two polls
  const out = cr.done({ instanceId: 'cli-beta', id, summary: 's' });
  assert.equal(out.deliveredVia, 'pending');
  const polled = await cr.wait(id, 5000);
  assert.equal(polled.state, 'done');
  assert.equal(cr.list().find((r) => r.id === id).deliveredVia, 'waiter');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.writes.length, 0, 'the tab is not told a second time');
});

test('an outcome held for a re-poll that never comes goes on down the ladder', async (t) => {
  const h = harness({ running: ['app-alpha'], repollGraceMs: 100 });
  t.after(h.cleanup);
  const { id } = ask(h);
  cr.decide(id, { ok: true });
  assert.equal(cr.done({ instanceId: 'cli-beta', id, summary: 's' }).deliveredVia, 'pending');
  assert.equal(h.writes.length, 0);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[0].tabId, 'app-alpha');
  assert.equal(cr.list().find((r) => r.id === id).deliveredVia, 'pty');

  // The tab is gone too: tier 3, on the transcript.
  const h2 = harness({ repollGraceMs: 100 });
  t.after(h2.cleanup);
  const r2 = ask(h2);
  cr.decide(r2.id, { ok: true });
  h2.launches.length = 0;
  cr.done({ instanceId: 'cli-beta', id: r2.id, summary: 's' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(h2.launches.length, 1);
  assert.equal(h2.launches[0].params.resumeSessionId, 'sess-alpha');
});

test('an outcome held when the platform stopped is delivered after the restart', async (t) => {
  const h = harness({ running: ['app-alpha'], repollGraceMs: 5000 });
  t.after(h.cleanup);
  const { id } = ask(h);
  cr.decide(id, { ok: true });
  assert.equal(cr.done({ instanceId: 'cli-beta', id, summary: 's' }).deliveredVia, 'pending');
  const writes = [];
  cr.init({
    dataHome: h.dataHome,
    repollGraceMs: 50,
    cliSessionManager: {
      get: (tabId) => (tabId === 'app-alpha' ? { running: true, tabId } : null),
      writeWhenReady: (tabId, data) => writes.push({ tabId, data }),
    },
    appManager: { list: () => [{ name: 'alpha' }, { name: 'beta' }], readManifest: () => ({}) },
    launchChangeSession: () => { throw new Error('not expected'); },
  });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(writes.length, 2);
  assert.match(writes[0].data, /is UNVERIFIED/);
  assert.equal(cr.status(id).state, 'done');
});

// --- Agent SDK launches: async, owner-confirmed, orchestrated ---------------

// A promise the test settles by hand, standing in for core's openCli.
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setImmediate(r));

test('an async launch is `opening` until it resolves, then launched and armed', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const d = deferred();
  h.launchAsync = () => d.promise;
  const { id } = ask(h);
  assert.equal(cr.decide(id, { ok: true }).state, 'opening');
  assert.equal(cr.status(id).state, 'opening');
  assert.equal(h.launches[0].params.autoSubmit, true);
  assert.ok(h.launches[0].params.changeRequest, 'the target section rides along');
  // A second request for the same target waits behind the one opening.
  const other = cr.request({ instanceId: 'cli-gamma', to: 'beta', prompt: 'p', interface: { kind: 'tool', name: 'other' } });
  assert.equal(cr.decide(other.id, { ok: true }).state, 'queued');
  h.running.add('app-beta');
  d.resolve({ tabId: 'app-beta', mode: 'orchestrator', engine: 'sdk', auth: 'subscription' });
  await flush();
  assert.equal(cr.status(id).state, 'launched');
  assert.ok(h.exitHooks.has('app-beta'));
});

test('a declined launch goes back to the owner, never stuck in launched', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.launchAsync = () => Promise.resolve({ tabId: 'app-beta', cancelled: true });
  const { id } = ask(h);
  assert.equal(cr.decide(id, { ok: true }).state, 'opening');
  await flush();
  assert.equal(cr.status(id).state, 'pending');
  assert.equal(h.exitHooks.size, 0);
  // …so the owner can Open it again, or Deny it.
  h.launchAsync = null;
  assert.equal(cr.decide(id, { ok: true }).state, 'launched');
  const { id: id2 } = cr.request({ instanceId: 'cli-gamma', to: 'alpha', prompt: 'p', interface: { kind: 'tool', name: 'x' } });
  h.launchAsync = () => Promise.resolve({ cancelled: true });
  cr.decide(id2, { ok: true });
  await flush();
  assert.equal(cr.decide(id2, { ok: false, reason: 'not now' }).state, 'denied');
});

test('a declined launch releases a request queued behind it', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const d = deferred();
  h.launchAsync = () => d.promise;
  const { id } = ask(h);
  cr.decide(id, { ok: true });
  const other = cr.request({ instanceId: 'cli-gamma', to: 'beta', prompt: 'p', interface: { kind: 'tool', name: 'other' } });
  assert.equal(cr.decide(other.id, { ok: true }).state, 'queued');
  h.launchAsync = null;
  d.resolve({ cancelled: true });
  await flush();
  assert.equal(cr.status(id).state, 'pending');
  assert.equal(cr.status(other.id).state, 'launched');
});

test('a launch that fails later ends the request and tells the asker', async (t) => {
  const h = harness({ running: ['app-alpha'] });
  t.after(h.cleanup);
  h.launchAsync = () => Promise.reject(new Error('core said no'));
  const { id } = ask(h);
  cr._internals.byId(id).waiting = false;
  cr.decide(id, { ok: true });
  await flush();
  const rec = cr.status(id);
  assert.equal(rec.state, 'ended');
  assert.match(rec.summary, /could not open a change session on "beta": core said no/);
  assert.ok(h.writes.some((w) => w.tabId === 'app-alpha'));
});

test('a restart while a launch was opening hands the request back to the owner', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.launchAsync = () => new Promise(() => {});   // the owner never answered
  const { id } = ask(h);
  cr.decide(id, { ok: true });
  assert.equal(cr.status(id).state, 'opening');
  cr.init({ dataHome: h.dataHome, cliSessionManager: { get: () => null, list: () => [] }, appManager: { APPS_DIR: h.appsDir, list: () => [] } });
  const rec = cr._internals.byId(id);
  assert.equal(rec.state, 'pending');
  assert.equal(rec.openingAt, undefined);
});

test('a platform request opens an SDK orchestrator in the pro repo, on core\'s default isolation', async (t) => {
  const calls = [];
  const h = harness({
    openSdkSession: (o, state) => {
      calls.push(o);
      state.running.add(o.tabId);
      return Promise.resolve({ tabId: o.tabId, mode: 'orchestrator', engine: 'sdk', auth: 'subscription' });
    },
  });
  t.after(h.cleanup);
  const { id } = askPlatform();
  assert.equal(cr.decide(id, { ok: true }).state, 'opening');
  await flush();
  assert.equal(cr.status(id).state, 'launched');
  assert.equal(h.proLaunches.length, 0, 'not the CLI terminal');
  const [o] = calls;
  assert.deepEqual([o.tabId, o.mode, o.cwd, o.autoSubmit, o.isolation], [`pro-change-${id}`, 'orchestrator', h.proDir, true, undefined]);
  assert.equal(o.settings[cr._internals.STAMP_REQUEST], id);
  assert.match(o.settings.appendSystemPrompt, /If this session is an orchestrator/);
  assert.match(o.settings.appendSystemPrompt, /A worker cannot run `scripts\/app-change\.js`/);
  assert.ok(h.broadcasts.some((m) => m.type === 'app:cliSpawned' && m.tabId === `pro-change-${id}`));
  // The orchestrator speaks for the platform; its exit ends the request.
  h.proSession(id);
  cr._internals.byId(id).lastPollAt = 0;
  h.exitTab(`pro-change-${id}`);
  await afterGrace();
  assert.equal(cr.status(id).state, 'ended');
});

test('a platform launch with no SDK path falls back to the CLI terminal; a decline opens nothing', async (t) => {
  const h = harness({ openSdkSession: () => Promise.resolve(null) });
  t.after(h.cleanup);
  const { id } = askPlatform();
  cr.decide(id, { ok: true });
  await flush();
  assert.equal(cr.status(id).state, 'launched');
  assert.equal(h.proLaunches.length, 1);

  const h2 = harness({ openSdkSession: () => Promise.resolve({ cancelled: true }) });
  t.after(h2.cleanup);
  const r2 = askPlatform();
  cr.decide(r2.id, { ok: true });
  await flush();
  assert.equal(cr.status(r2.id).state, 'pending');
  assert.equal(h2.proLaunches.length, 0);
});

test('an orchestration worker cannot speak for its app or the platform', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const worker = { role: 'worker', runId: 'r1', workerId: 'w1', orchestrator: 'orch-r1' };
  // A worker of alpha's orchestrator: it inherited the changeApp stamp.
  h.sessions.set('cli-w', { tabId: 'tab-w', sessId: 'sess-w', cwd: path.join(h.appsDir, 'alpha'),
    settings: { [cr._internals.STAMP_APP]: 'alpha', orchestration: worker } });
  const refused = cr.request({ instanceId: 'cli-w', to: 'beta', prompt: 'p', interface: { kind: 'tool', name: 't' } }).error;
  assert.match(refused, /is an orchestration worker .* runs in the orchestrator only: .* to orch-r1/);
  assert.match(cr.done({ instanceId: 'cli-w', summary: 'x' }).error, /orchestration worker/);
  // A worker of a platform request's orchestrator.
  const { id } = askPlatform();
  cr.decide(id, { ok: true });
  h.sessions.set('cli-pw', { tabId: 'tab-pw', sessId: 'sess-pw', settings: { [cr._internals.STAMP_REQUEST]: id, orchestration: worker } });
  assert.match(cr.done({ instanceId: 'cli-pw', id, summary: 'x' }).error, /orchestration worker/);
  assert.equal(cr.status(id).state, 'launched');
  // The orchestrator itself may.
  h.proSession(id);
  assert.equal(cr.done({ instanceId: 'cli-pro', id, summary: 'ok' }).state, 'done');
});

test('a running worker tab is not the app\'s change tab for delivery', (t) => {
  const h = harness({ running: ['app-alpha', 'tab-w'] });
  t.after(h.cleanup);
  h.sessions.set('cli-w', { tabId: 'tab-w', sessId: 'sess-w',
    settings: { [cr._internals.STAMP_APP]: 'alpha', orchestration: { role: 'worker', orchestrator: 'orch-r1' } } });
  const { id } = ask(h);
  cr.decide(id, { ok: true });
  cr._internals.byId(id).lastPollAt = 0;
  h.running.delete('app-alpha');
  // alpha's orchestrator is gone: the worker does not take the outcome.
  const out = cr.done({ instanceId: 'cli-beta', id, summary: 's' });
  assert.notEqual(out.deliveredVia, 'pty');
  assert.ok(!h.writes.some((w) => w.tabId === 'tab-w'));
});

test('an async relaunch whose resume core refuses falls back to a fresh session', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const { id } = ask(h);
  cr.decide(id, { ok: true });
  h.launches.length = 0;
  h.launchAsync = (params) => (params.resumeSessionId
    ? Promise.reject(new Error('no transcript for session sess-alpha'))
    : Promise.resolve({ tabId: 'app-alpha', engine: 'sdk' }));
  cr._internals.byId(id).lastPollAt = 0;
  const out = cr.done({ instanceId: 'cli-beta', id, summary: 's' });
  assert.equal(out.deliveredVia, 'relaunch');
  assert.equal(h.launches[0].params.resumeSessionId, 'sess-alpha');
  await flush();
  assert.equal(h.launches.length, 2);
  assert.equal(h.launches[1].params.resumeSessionId, undefined);
  assert.match(h.launches[1].params.prompt, /resuming session sess-alpha failed: no transcript/);
  assert.equal(cr.list().find((r) => r.id === id).deliveredVia, 'relaunch-fresh');

  // The owner declines API costs for the relaunch: delivered nowhere, said so.
  const h2 = harness();
  t.after(h2.cleanup);
  const r2 = ask(h2);
  cr.decide(r2.id, { ok: true });
  h2.launchAsync = () => Promise.resolve({ tabId: 'app-alpha', cancelled: true });
  cr._internals.byId(r2.id).lastPollAt = 0;
  cr.done({ instanceId: 'cli-beta', id: r2.id, summary: 's' });
  await flush();
  assert.equal(cr.list().find((r) => r.id === r2.id).deliveredVia, 'none');
});
