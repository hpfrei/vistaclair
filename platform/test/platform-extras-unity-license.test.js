// The Unity licence of the unity extra without /opt or the real Unity CLI: the
// parsers on recorded CLI output, the sign-in state machine, the rendered
// bin/unity-license against a fake CLI (no browser is ever opened), and the
// server flow (platform-extras-unity-license.js) against a fake unity-license.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const unity = require('../src/apps/platform-extras-unity');
const lic = require('../src/apps/platform-extras-unity-license');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-unity-licence-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Recorded from Unity CLI 1.0.0-beta.17 (state / challenge shortened).
const URL = 'https://services.api.unity.com/app-linking/v1/login/redirect/aHR0cHM6Ly9pbXBsaWNpdA==/https%3A%2F%2Fapi.unity.com%2Fv1%2Foauth2%2Fauthorize?client_id=unity_hub&state=4m7A&code_challenge=4oGn&code_challenge_method=S256&response_type=code';
const LOGIN_JSON_STDERR = `{"type":"progress","command":"auth","message":"auth_url=${URL}"}\n\nSign-in cancelled.\n`;
const LOGIN_HUMAN_STDERR = [
  'Unity CLI sends usage analytics and crash reports to help us improve it. To turn this off or learn more: https://docs.unity.com/en-us/unity-cli/data-collection-privacy-controls',
  'Sign-in URL:',
  `  ${URL}`,
  '  (If your browser doesn\'t open, or you\'re on a remote/headless machine, copy this URL into a browser on a device where you can sign in to your Unity account.)',
  'Opening browser for sign-in…',
  'Complete sign-in in the browser. Waiting for confirmation… (Ctrl-C to cancel)',
].join('\n');
const AUTH_STATUS = JSON.stringify({ success: true, command: 'auth status', data: { loggedIn: true, sessionState: 'fresh', mode: 'oauth',
  credentialSource: 'keyring', user: { name: 'Owner Name', email: 'owner@example.com' }, account: { foreignKey: '1', source: 'global' } }, errors: [], warnings: [] }, null, 2);
const LICENSE_STATUS = (active, signedIn = true) => JSON.stringify({ success: active, command: 'license status', data: { active, signedIn, authMode: 'oauth',
  licenses: active ? [{ product: 'Unity Personal', type: 'Assigned', organization: '', expires: '' }, { product: 'Asset Store', type: 'Assigned', expires: '' }] : [],
  floatingServer: null } }, null, 2);

test('parseUnityLoginUrl finds the URL in the --json and the human output, and nothing else', () => {
  const pick = (text) => text.split('\n').map(lic.parseUnityLoginUrl).filter(Boolean);
  assert.deepEqual(pick(LOGIN_JSON_STDERR), [URL]);
  assert.deepEqual(pick(LOGIN_HUMAN_STDERR), [URL], 'the analytics notice URL is not the sign-in URL');
  assert.equal(lic.parseUnityLoginUrl(`Sign-in URL: ${URL}`), URL);
  assert.equal(lic.parseUnityLoginUrl('{"type":"progress","message":"auth_url=http://insecure"}'), null);
  assert.equal(lic.parseUnityLoginUrl('{"type":"progress","message":"other"}'), null);
  assert.equal(lic.parseUnityLoginUrl('{ broken'), null);
  assert.equal(lic.parseUnityLoginUrl(''), null);
});

test('parseUnityAccount and the detailed licence status read the recorded JSON', () => {
  assert.deepEqual(lic.parseUnityAccount(AUTH_STATUS), { loggedIn: true, sessionState: 'fresh', name: 'Owner Name', email: 'owner@example.com' });
  assert.deepEqual(lic.parseUnityAccount('{"data":{"loggedIn":false,"sessionState":"none"}}'), { loggedIn: false, sessionState: 'none', name: null, email: null });
  assert.equal(lic.parseUnityAccount('not json'), null);
  const d = unity.parseUnityLicenseStatus(LICENSE_STATUS(true), { detail: true });
  assert.deepEqual(d.licenses, [{ product: 'Unity Personal', type: 'Assigned', expires: null }, { product: 'Asset Store', type: 'Assigned', expires: null }]);
  assert.equal(unity.parseUnityLicenseStatus(LICENSE_STATUS(true)).licenses, undefined, 'the probe shape is unchanged');
});

test('signInReducer: start → waiting(url) → activating → done, and every way out', () => {
  const R = lic.signInReducer;
  let s = R(undefined, { type: 'start' }, 1000);
  assert.equal(s.state, 'starting');
  assert.equal(R(s, { type: 'start' }, 1001), s, 'a second start while in flight changes nothing');
  s = R(s, { type: 'url', url: URL }, 2000);
  assert.deepEqual([s.state, s.url, s.expiresAt], ['waiting', URL, 2000 + lic.LOGIN_URL_TTL_MS]);
  assert.equal(R(s, { type: 'url', url: 'https://other' }, 2001), s, 'the first URL stays');
  const act = R(s, { type: 'loginExit', code: 0 }, 3000);
  assert.equal(act.state, 'activating');
  assert.equal(R(act, { type: 'activated', active: true }, 4000).state, 'done');
  const bad = R(act, { type: 'activated', active: false, error: 'no seat' }, 4000);
  assert.deepEqual([bad.state, bad.error], ['failed', 'no seat']);
  assert.equal(R(s, { type: 'loginExit', code: 1, error: 'boom' }, 3000).state, 'failed');
  assert.equal(R(s, { type: 'loginExit', code: 1 }, 2000 + lic.LOGIN_URL_TTL_MS).state, 'expired', 'a late non-zero exit is an expiry');
  assert.equal(R(s, { type: 'timeout' }, 9000).state, 'expired');
  assert.equal(R(s, { type: 'cancel' }, 9000).state, 'cancelled');
  assert.equal(R(s, { type: 'interrupted' }, 9000).state, 'failed');
  const done = R(act, { type: 'activated', active: true }, 4000);
  for (const t of ['cancel', 'interrupted', 'timeout', 'loginExit']) assert.equal(R(done, { type: t, code: 0 }, 5000), done, `${t} after done`);
  assert.equal(R(done, { type: 'start' }, 6000).state, 'starting', 'a finished sign-in can start again');
});

test('licenceVerdict: active ok, signed in → reactivate, signed out → alert', () => {
  assert.equal(lic.licenceVerdict({ active: true, signedIn: true }).action, 'ok');
  assert.equal(lic.licenceVerdict({ active: false, signedIn: true }).action, 'reactivate');
  assert.deepEqual(lic.licenceVerdict({ active: false, signedIn: false }), { action: 'alert', reason: 'signed-out' });
  assert.equal(lic.licenceVerdict({ active: false, signedIn: false, error: 'no CLI' }).action, 'unknown');
  assert.equal(lic.licenceVerdict(null).action, 'unknown');
});

// The rendered bin/unity-license, rooted in a temp dir with a fake Unity CLI.
function scriptRoot(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, 'cli', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  const script = unity.renderUnityLicense().replace(`ROOT=${unity.UNITY_ROOT}`, `ROOT=${root}`);
  fs.writeFileSync(path.join(root, 'bin', 'unity-license'), script, { mode: 0o755 });
  // The fake CLI: records what it sees; `license status` reads $ROOT/status.json.
  fs.writeFileSync(path.join(root, 'cli', 'bin', 'unity'), [
    '#!/bin/bash',
    `R=${root}`,
    'echo "$*" >> "$R/calls.log"',
    'case "$1 $2" in',
    '  "auth login")',
    '    { echo "opener=$(command -v xdg-open)"; echo "display=${DISPLAY:-}"; echo "wayland=${WAYLAND_DISPLAY:-}"; } > "$R/login.env"',
    `    echo '{"type":"progress","command":"auth","message":"auth_url=${URL}"}' >&2`,
    `    xdg-open '${URL}'; echo "opener_exit=$?" >> "$R/login.env"; exit 0 ;;`,
    '  "license status") cat "$R/status.json" ;;',
    '  "license activate") echo "activate $*" >> "$R/activate.log" ;;',
    '  "auth status") echo \'{"data":{"loggedIn":true}}\' ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  return root;
}

test('unity-license login never reaches a real browser opener and leaves no shim behind', () => {
  const root = scriptRoot('login');
  const r = spawnSync(path.join(root, 'bin', 'unity-license'), ['login', '--json'], {
    env: { ...process.env, DISPLAY: ':1', WAYLAND_DISPLAY: 'wayland-0' }, encoding: 'utf-8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stderr.includes(`auth_url=${URL}`));
  const env = fs.readFileSync(path.join(root, 'login.env'), 'utf-8');
  const opener = env.match(/^opener=(.*)$/m)[1];
  assert.match(opener, /\/tmp\/vistaclair-unity-nobrowser\.[^/]+\/xdg-open$/, `xdg-open resolves to the no-op stub, not ${opener}`);
  assert.ok(/^display=$/m.test(env) && /^wayland=$/m.test(env), 'no display reaches the CLI');
  assert.ok(/^opener_exit=0$/m.test(env));
  assert.ok(!fs.existsSync(path.dirname(opener)), 'the stub dir is removed on exit');
  assert.equal(fs.readFileSync(path.join(root, 'calls.log'), 'utf-8').trim(), 'auth login --json', 'extra args reach the CLI');
  for (const b of unity.UNITY_BROWSER_OPENERS) assert.ok(unity.renderUnityLicense().includes(b), b);
});

test('unity-license activate: Personal, or the serial from the env; ensure respects serial mode', () => {
  const root = scriptRoot('activate');
  const bin = path.join(root, 'bin', 'unity-license');
  const run = (args, env = {}) => spawnSync(bin, args, { env: { ...process.env, ...env }, encoding: 'utf-8' });
  const activations = () => { try { return fs.readFileSync(path.join(root, 'activate.log'), 'utf-8').trim().split('\n'); } catch { return []; } };

  assert.equal(run(['activate']).status, 0);
  assert.deepEqual(activations(), ['activate license activate --personal --accept-eula']);
  assert.equal(run(['activate'], { UNITY_LICENSE_SERIAL: 'SC-1234-5678' }).status, 0);
  assert.equal(activations()[1], 'activate license activate --serial SC-1234-5678 --non-interactive');

  fs.writeFileSync(path.join(root, 'status.json'), LICENSE_STATUS(false, true));
  fs.writeFileSync(path.join(root, 'license-mode'), 'serial\n');
  const ensureSerial = run(['ensure']);
  assert.equal(ensureSerial.status, 3);
  assert.match(ensureSerial.stderr, /Pro \/ Industry/);
  assert.equal(activations().length, 2, 'serial mode never falls back to Personal');

  fs.rmSync(path.join(root, 'license-mode'));
  assert.equal(run(['ensure']).status, 3, 'the fake stays lapsed');
  assert.equal(activations()[2], 'activate license activate --personal --accept-eula --non-interactive', 'Personal is re-activated while signed in');
  fs.writeFileSync(path.join(root, 'status.json'), LICENSE_STATUS(true));
  assert.equal(run(['ensure']).status, 0);
  assert.equal(run(['account']).stdout.trim(), '{"data":{"loggedIn":true}}');
});

// --- the server flow against a fake bin/unity-license ---

// login: prints the URL, then waits for $D/approve (exit 0) or $D/deny (exit 1).
// status / account read files in $D; activate makes the licence active (and
// records whether a serial came in the env).
function fakeLicenseBin(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'unity-license');
  fs.writeFileSync(bin, [
    '#!/bin/bash',
    `D=${dir}`,
    'case "$1" in',
    `  login) echo "login $*" >> "$D/calls.log"; echo '{"type":"progress","command":"auth","message":"auth_url=${URL}"}' >&2`,
    '    for i in $(seq 1 200); do [ -f "$D/approve" ] && exit 0; [ -f "$D/deny" ] && { echo "Sign-in denied." >&2; exit 1; }; sleep 0.05; done; exit 1 ;;',
    '  status) cat "$D/status.json"; grep -q \'"active": true\' "$D/status.json" || exit 3 ;;',
    '  account) cat "$D/account.json" ;;',
    '  activate) echo "activate serial=${UNITY_LICENSE_SERIAL:-}" >> "$D/calls.log"; [ -f "$D/activate-fails" ] && { echo "no seat" >&2; exit 1; }',
    `    cat > "$D/status.json" <<'J'`,
    LICENSE_STATUS(true),
    'J',
    '    ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'status.json'), LICENSE_STATUS(false, false));
  fs.writeFileSync(path.join(dir, 'account.json'), AUTH_STATUS);
  return bin;
}

const until = async (cond, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

function memoryStore() {
  const files = new Map();
  return {
    files,
    readSecretFile: (p, _dir, { fallback } = {}) => (files.has(p) ? JSON.parse(files.get(p)) : fallback),
    writeSecretFile: (p, data) => { files.set(p, JSON.stringify(data)); fs.writeFileSync(p, 'ENCRYPTED'); },
  };
}

function setup(name) {
  const appsDir = path.join(tmp, name, 'apps');
  fs.mkdirSync(appsDir, { recursive: true });
  const dir = path.join(tmp, name, 'fake');
  const licenseBin = fakeLicenseBin(dir);
  let changes = 0;
  const store = memoryStore();
  const jobs = [];
  const handlers = new Map();
  const cron = { list: () => jobs, addJob: (j) => { jobs.push(j); return { ok: true }; }, registerInternal: (n, fn) => handlers.set(n, fn) };
  const opts = { appsDir, onChange: () => { changes++; }, secretStore: store, installed: () => true, licenseBin, modeFile: path.join(dir, 'license-mode'), cron };
  lic.init(opts);
  return { appsDir, dir, opts, store, jobs, handlers, changes: () => changes };
}

test('sign-in: the URL is captured, persisted for a reload, and approval activates the licence', async () => {
  const { appsDir, dir, jobs, handlers, changes } = setup('signin');
  assert.equal(typeof handlers.get(lic.CHECK_HANDLER), 'function', 'the hourly handler is registered at init');
  lic.startSignIn();
  await until(() => lic.snapshot().signIn.state === 'waiting');
  const snap = lic.snapshot();
  assert.equal(snap.signIn.url, URL);
  const persisted = JSON.parse(fs.readFileSync(path.join(appsDir, '.unity-license.json'), 'utf-8'));
  assert.equal(persisted.signIn.url, URL, 'a dashboard reload reads the same URL');
  assert.match(fs.readFileSync(path.join(dir, 'calls.log'), 'utf-8'), /^login login --json --non-interactive$/m);
  fs.writeFileSync(path.join(dir, 'approve'), '');
  await until(() => lic.snapshot().signIn.state === 'done');
  const s = lic.snapshot();
  assert.equal(s.status.active, true);
  assert.deepEqual(s.status.account, { name: 'Owner Name', email: 'owner@example.com' });
  assert.equal(s.status.licenses[0].product, 'Unity Personal');
  assert.equal(s.lastReactivation.ok, true);
  assert.deepEqual(jobs, [{ name: 'unity:license-check', schedule: '17 * * * *', target: { type: 'internal', handler: 'unity.license-check' } }],
    'the hourly check is registered once the licence is active');
  assert.ok(changes() >= 3, 'every step is broadcast');
});

test('sign-in: cancel ends the child; a denied login fails; a restart mid-flow is reported', async () => {
  const { appsDir, dir, opts } = setup('cancel');
  lic.startSignIn();
  await until(() => lic.snapshot().signIn.state === 'waiting');
  lic.cancelSignIn();
  assert.equal(lic.snapshot().signIn.state, 'cancelled');
  fs.writeFileSync(path.join(dir, 'approve'), ''); // too late: nothing activates
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!/activate/.test(fs.readFileSync(path.join(dir, 'calls.log'), 'utf-8')));
  fs.rmSync(path.join(dir, 'approve'));

  lic.startSignIn();
  await until(() => lic.snapshot().signIn.state === 'waiting');
  fs.writeFileSync(path.join(dir, 'deny'), '');
  await until(() => lic.snapshot().signIn.state === 'failed');
  assert.match(lic.snapshot().signIn.error, /denied/);
  fs.rmSync(path.join(dir, 'deny'));

  lic.startSignIn();
  await until(() => lic.snapshot().signIn.state === 'waiting');
  lic.init(opts); // a server restart
  assert.equal(lic.snapshot().signIn.state, 'failed');
  assert.match(lic.snapshot().signIn.error, /restart/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(appsDir, '.unity-license.json'), 'utf-8')).signIn.state, 'failed');
});

test('the hourly check: re-activates while signed in, alerts once when it cannot, clears when active', async () => {
  const { dir } = setup('check');
  const seen = [];
  const off = lic.observe((ev) => seen.push(ev));
  try {
    fs.writeFileSync(path.join(dir, 'status.json'), LICENSE_STATUS(false, true));
    assert.deepEqual(await lic.check(), { active: true, reactivated: true });

    fs.writeFileSync(path.join(dir, 'status.json'), LICENSE_STATUS(false, false));
    assert.equal((await lic.check()).alerted, 'signed-out');
    assert.equal((await lic.check()).alerted, 'signed-out');
    assert.deepEqual(seen.map((e) => e.reason), ['signed-out'], 'one alert per lapse');
    assert.equal(lic.snapshot().alert.reason, 'signed-out');

    fs.writeFileSync(path.join(dir, 'status.json'), LICENSE_STATUS(false, true));
    fs.writeFileSync(path.join(dir, 'activate-fails'), '');
    const r = await lic.check();
    assert.equal(r.alerted, 'reactivation-failed');
    assert.match(r.error, /no seat/);
    assert.deepEqual(seen.map((e) => e.reason), ['signed-out', 'reactivation-failed']);

    fs.rmSync(path.join(dir, 'activate-fails'));
    fs.writeFileSync(path.join(dir, 'status.json'), LICENSE_STATUS(true));
    assert.deepEqual(await lic.check(), { active: true });
    assert.equal(lic.snapshot().alert, null);
  } finally { off(); }
  lic.init({ ...setup('check-off').opts, installed: () => false });
  assert.deepEqual(await lic.check(), { skipped: 'unity not installed' });
});

test('a stored serial is encrypted, never in the snapshot, and reaches activate through the env only', async () => {
  const { appsDir, dir, store } = setup('serial');
  assert.throws(() => lic.setSerial('not a serial!'), /serial/);
  lic.setSerial('SC-AAAA-BBBB-CCCC');
  const enc = path.join(appsDir, '.unity-license.enc');
  assert.equal(fs.readFileSync(enc, 'utf-8'), 'ENCRYPTED');
  assert.equal(JSON.parse(store.files.get(enc)).serial, 'SC-AAAA-BBBB-CCCC');
  assert.equal(fs.readFileSync(path.join(dir, 'license-mode'), 'utf-8'), 'serial\n');
  assert.equal(lic.snapshot().serial, true);
  assert.ok(!JSON.stringify(lic.snapshot()).includes('SC-AAAA'), 'the dashboard sees only that one is stored');
  assert.ok(!fs.readFileSync(path.join(appsDir, '.unity-license.json'), 'utf-8').includes('SC-AAAA'));
  fs.writeFileSync(path.join(dir, 'status.json'), LICENSE_STATUS(false, true));
  await lic.reactivate();
  assert.match(fs.readFileSync(path.join(dir, 'calls.log'), 'utf-8'), /^activate serial=SC-AAAA-BBBB-CCCC$/m);
  lic.setSerial('');
  assert.ok(!fs.existsSync(enc) && !fs.existsSync(path.join(dir, 'license-mode')));
  assert.equal(lic.snapshot().serial, false);
});
