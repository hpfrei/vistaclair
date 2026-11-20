// The blender and rust extras without touching /opt: the listing (not installed
// on a box that never ran the installer), the generated script bodies, and the
// probe-output parsers the installers' verdicts rest on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const extras = require('../src/apps/platform-extras');

const appsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-extras-'));
extras.init({ appsDir, broadcaster: { broadcast() {} } });
test.after(() => fs.rmSync(appsDir, { recursive: true, force: true }));

test('blender is listed, and not installed where /opt/vistaclair-blender is absent', () => {
  const entry = extras.list().find((e) => e.id === 'blender');
  assert.ok(entry, 'blender is an extra');
  assert.equal(entry.title, 'Blender (headless 3D pipelines)');
  assert.equal(entry.installing, false);
  if (fs.existsSync(extras.BLENDER_ROOT)) return; // installed box — the probe answers for real
  assert.equal(entry.installed, false);
});

test('the wrapper pins the version, relocates user resources and honours VC_BLENDER_VERSION', () => {
  const body = extras.renderBlenderWrapper('5.2.2');
  assert.match(body, /^#!\/bin\/sh\n/);
  assert.ok(body.includes(`ROOT=${extras.BLENDER_ROOT}`));
  assert.ok(body.includes('VER="${VC_BLENDER_VERSION:-5.2.2}"'));
  assert.ok(body.includes('BLENDER_USER_RESOURCES="$ROOT/config/$VER"'));
  assert.ok(body.includes('exec "$ROOT/versions/$VER/blender" "$@"'), 'runs versions/5.2.2/blender by default');
});

test('blender-env exports the four VC_BLENDER variables', () => {
  const body = extras.renderBlenderEnv('5.2.2');
  const exported = (body.match(/^export (.+)$/m) || [])[1].split(/\s+/);
  assert.deepEqual(exported.sort(), ['VC_BLENDER', 'VC_BLENDER_PYTHON', 'VC_BLENDER_ROOT', 'VC_BLENDER_VERSION']);
  assert.ok(body.includes('VC_BLENDER_VERSION="${VC_BLENDER_VERSION:-5.2.2}"'));
  assert.ok(body.includes('/python/bin/"python3*'), 'the bundled python is globbed at source time');
});

test('blender-fetch verifies against the release checksum list before unpacking', () => {
  const body = extras.renderBlenderFetch();
  assert.ok(body.includes('https://download.blender.org/release/Blender$MM'));
  assert.ok(body.indexOf('sha256sum -c -') < body.indexOf('tar -xJf'));
  assert.ok(body.includes('mv "$DEST.part" "$DEST"'), 'a half-unpacked tree never looks installed');
});

test('parseProbeLines maps the marker lines to the capabilities shape', () => {
  const sample = [
    'Blender 5.2.2 LTS (hash d13f752e3b9c)',
    'PROBE version 5.2.2 LTS',
    'PROBE python 3.13.13',
    "00:03.644  render | Saved: '/tmp/x/blender_workbench.png'",
    'PROBE BLENDER_WORKBENCH ok 0.98',
    'PROBE CYCLES ok 0.21',
    'PROBE BLENDER_EEVEE FAIL Unable to open a display',
  ].join('\n');
  assert.deepEqual(extras.parseProbeLines(sample), {
    version: '5.2.2 LTS',
    python: '3.13.13',
    engines: { workbench: true, eevee: false, cycles: true },
  });
  assert.deepEqual(extras.parseProbeLines('Segmentation fault').engines, { workbench: false, eevee: false, cycles: false },
    'an engine never reported counts as failed');
});

test('rust is listed, and not installed where /opt/vistaclair-rust is absent', () => {
  const entry = extras.list().find((e) => e.id === 'rust');
  assert.ok(entry, 'rust is an extra');
  assert.equal(entry.title, 'Rust toolchain (rustc + cargo)');
  if (fs.existsSync(extras.RUST_ROOT)) return; // installed box — the probe answers for real
  assert.equal(entry.installed, false);
});

test('rust-env points rustup and cargo at the install root and keeps build output per crate', () => {
  const body = extras.renderRustEnv();
  assert.match(body, /^#!\/bin\/sh\n/);
  const exported = (body.match(/^export (.+)$/m) || [])[1].split(/\s+/);
  assert.deepEqual(exported.sort(), ['CARGO_HOME', 'PATH', 'RUSTUP_HOME', 'VC_RUST_ROOT']);
  assert.ok(body.includes(`VC_RUST_ROOT=${extras.RUST_ROOT}`));
  assert.ok(body.includes('PATH="$CARGO_HOME/bin:$PATH"'), 'the pinned proxies win over any rustc on PATH');
  assert.match(body, /^unset CARGO_TARGET_DIR$/m, 'an inherited shared target dir would mix apps');
  assert.ok(!body.includes('.cargo') && !body.includes('$HOME'), 'never the user\'s ~/.cargo');
});

test('parseRustProbeLines maps the marker lines to the capabilities shape', () => {
  const sample = [
    'PROBE rustc 1.99.0 (b940084d7 2026-09-28)',
    'PROBE cargo 1.99.0 (5f94df478 2026-08-27)',
    'PROBE rustup 1.29.1 (2026-06-30)',
    'PROBE native ok',
    'PROBE pyo3 ok',
    'PROBE napi FAIL error: linking with `cc` failed: exit status: 1',
    'PROBE wasm ok',
    'PROBE android_target ok',
    'PROBE cargo_ndk ok',
    'PROBE android_cdylib SKIP no Android NDK (android-build extra with an NDK not installed)',
  ].join('\n');
  assert.deepEqual(extras.parseRustProbeLines(sample), {
    rustc: '1.99.0 (b940084d7 2026-09-28)',
    cargo: '1.99.0 (5f94df478 2026-08-27)',
    rustup: '1.29.1 (2026-06-30)',
    checks: { native: true, pyo3: true, napi: false, wasm: true, android_target: true, cargo_ndk: true, android_cdylib: false },
  });
  assert.deepEqual(extras.parseRustProbeLines('bash: cargo: command not found').checks,
    { native: false, pyo3: false, napi: false, wasm: false, android_target: false, cargo_ndk: false, android_cdylib: false },
    'a check never reported (or skipped) counts as failed');
});

test('the rust extra pins the Android target and cargo-ndk the godot and unity extras use', () => {
  assert.equal(extras.RUST_ANDROID_TARGET, 'aarch64-linux-android');
  assert.equal(extras.CARGO_NDK_VERSION, '4.1.2');
  assert.equal(extras.GODOT_RUST_TARGET, undefined, 'one implementation: godot no longer owns the pins');
  assert.match(extras.list().find((e) => e.id === 'rust').description, /aarch64-linux-android/);
});

test('pickAndroidNdk takes the highest numeric NDK version', () => {
  assert.equal(extras.pickAndroidNdk(['27.2.12479018', '29.0.14206865', '9.0.1', '.DS_Store']), '29.0.14206865');
  assert.equal(extras.pickAndroidNdk(['27.2.12479018']), '27.2.12479018');
  assert.equal(extras.pickAndroidNdk([]), null);
  assert.equal(extras.pickAndroidNdk(['readme']), null);
});

test('aptLockHolder names the process holding the apt lock', () => {
  assert.equal(extras.aptLockHolder('Waiting for cache lock: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 3426 (unattended-upgr)...'),
    'unattended-upgr (pid 3426)');
  assert.equal(extras.aptLockHolder('Setting up pkg-config (1.8.1-2) ...'), null);
});

test('godot is listed, and not installed until its capabilities.json exists', () => {
  const entry = extras.list().find((e) => e.id === 'godot');
  assert.ok(entry, 'godot is an extra');
  assert.equal(entry.title, 'Godot (headless game builds, Android + Rust)');
  if (fs.existsSync(extras.GODOT_CAPS)) return; // installed box — the probe answers for real
  assert.equal(entry.installed, false);
});

test('the godot paths keep the layout apps depend on', () => {
  assert.equal(extras.GODOT_ROOT, '/opt/vistaclair-godot');
  assert.equal(extras.GODOT_BIN, '/opt/vistaclair-godot/bin/godot');
  assert.equal(extras.GODOT_ENV, '/opt/vistaclair-godot/bin/godot-env');
  assert.equal(extras.GODOT_EXE, '/opt/vistaclair-godot/versions/4.7.2/Godot_v4.7.2-stable_linux.x86_64');
  assert.equal(extras.GODOT_TEMPLATES, '/opt/vistaclair-godot/versions/4.7.2/editor_data/export_templates/4.7.2.stable');
  assert.equal(extras.GODOT_EDITOR_SETTINGS, '/opt/vistaclair-godot/versions/4.7.2/editor_data/editor_settings-4.7.tres');
  assert.equal(extras.GODOT_VENDORS, '/opt/vistaclair-godot/vendors/5.1.0/asset/addons/godotopenxrvendors');
  assert.deepEqual(extras.GODOT_ANDROID_SDK_PACKAGES, ['platforms;android-36', 'build-tools;36.1.0', 'ndk;29.0.14206865', 'platform-tools']);
});

test('the godot wrapper runs the pinned binary and fails loudly when it is missing', () => {
  const body = extras.renderGodotWrapper('4.7.2');
  assert.match(body, /^#!\/bin\/sh\n/);
  assert.ok(body.includes(`ROOT=${extras.GODOT_ROOT}`));
  assert.ok(body.includes('VER="${VC_GODOT_VERSION:-4.7.2}"'));
  assert.ok(body.includes('BIN="$ROOT/versions/$VER/Godot_v$VER-stable_linux.x86_64"'));
  assert.ok(body.includes('install under Apps → Setup → Extras') && body.includes('exit 127'));
  assert.ok(body.includes('exec "$BIN" "$@"'));
});

test('godot-env exports the four VC_GODOT variables', () => {
  const body = extras.renderGodotEnv('4.7.2', '5.1.0');
  const exported = (body.match(/^export (.+)$/m) || [])[1].split(/\s+/);
  assert.deepEqual(exported.sort(), ['VC_GODOT', 'VC_GODOT_ROOT', 'VC_GODOT_VENDORS', 'VC_GODOT_VERSION']);
  assert.ok(body.includes('VC_GODOT_VERSION="${VC_GODOT_VERSION:-4.7.2}"'));
  assert.ok(body.includes('VC_GODOT_VENDORS="$VC_GODOT_ROOT/vendors/5.1.0/asset/addons/godotopenxrvendors"'));
});

test('godot-env defines the release-signing helper over the three variables Godot reads', () => {
  const body = extras.renderGodotEnv('4.7.2', '5.1.0');
  assert.match(body, /^vc_godot_release_signing\(\) \{$/m);
  for (const v of ['PATH', 'USER', 'PASSWORD']) assert.ok(body.includes(`GODOT_ANDROID_KEYSTORE_RELEASE_${v}=`), v);
  assert.ok(body.includes('keystore not found'), 'a missing keystore fails loudly');
  // Run it for real under sh: arguments set the variables, bad input fails.
  const { spawnSync } = require('child_process');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-godot-env-'));
  try {
    const envFile = path.join(dir, 'godot-env');
    const ks = path.join(dir, 'k.keystore');
    fs.writeFileSync(envFile, body);
    fs.writeFileSync(ks, 'x');
    const run = (call) => spawnSync('sh', ['-c', `. ${envFile}; ${call}; echo "rc=$? $GODOT_ANDROID_KEYSTORE_RELEASE_PATH|$GODOT_ANDROID_KEYSTORE_RELEASE_USER|$GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD"`], { encoding: 'utf-8' });
    assert.equal(run(`vc_godot_release_signing ${ks} alias pw`).stdout.trim(), `rc=0 ${ks}|alias|pw`);
    assert.match(run(`vc_godot_release_signing ${dir}/nope alias pw`).stdout, /^rc=1 \|\|$/m);
    assert.match(run('vc_godot_release_signing "" alias pw').stdout, /^rc=1 \|\|$/m);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the godot README states the signed release export convention', () => {
  const body = extras.renderGodotReadme('4.7.2', '5.1.0');
  for (const v of ['PATH', 'USER', 'PASSWORD']) assert.ok(body.includes(`GODOT_ANDROID_KEYSTORE_RELEASE_${v}`), v);
  assert.ok(body.includes('vc_godot_release_signing') && body.includes('--export-release'));
  assert.ok(body.includes('Godot 4.7.2-stable') && body.includes('godot_openxr_vendors 5.1.0'));
  assert.equal(extras.GODOT_README, '/opt/vistaclair-godot/README.md');
});

test('the godot fetch verifies every download against its pinned hash before unpacking', () => {
  const body = extras.renderGodotFetch();
  for (const d of extras.GODOT_DOWNLOADS) {
    assert.match(d.hash, d.algo === 'sha512' ? /^[0-9a-f]{128}$/ : /^[0-9a-f]{64}$/, `${d.file} has a full ${d.algo}`);
    assert.ok(body.includes(`fetch ${d.file} '${d.url}' ${d.algo} ${d.hash}`));
  }
  assert.ok(body.includes('"$3sum" -c --status'));
  assert.ok(body.lastIndexOf('fetch vendors.zip') < body.indexOf('unzip -p'), 'nothing unpacks before all three verified');
  assert.ok(body.includes('Godot_v4.7.2-stable_export_templates.tpz') && !body.includes('mono'), 'the full, non-mono templates');
  assert.ok(body.includes('mv "$T.part" "$T"') && body.includes('mv "$V.part" "$V"'), 'a half-unpacked tree never looks installed');
  assert.ok(body.includes('touch "$HOME_DIR/._sc_"'), 'self-contained mode');
  assert.ok(!/rm -rf "\$HOME_DIR"|rm -rf "\$HOME_DIR\/editor_data"/.test(body), 'editor_data (keystore, settings) is never replaced');
});

test('renderGodotEditorSettings upserts keys and keeps the rest', () => {
  const before = '[gd_resource type="EditorSettings" format=3]\n\n[resource]\nfoo = 1\nexport/android/android_sdk_path = "/old"\n';
  const after = extras.renderGodotEditorSettings(before, {
    'export/android/android_sdk_path': '/opt/vistaclair-android/sdk',
    'export/android/debug_keystore_user': 'androiddebugkey',
  });
  assert.equal(after, '[gd_resource type="EditorSettings" format=3]\n\n[resource]\nfoo = 1\n'
    + 'export/android/android_sdk_path = "/opt/vistaclair-android/sdk"\nexport/android/debug_keystore_user = "androiddebugkey"\n');
  assert.equal(extras.renderGodotEditorSettings('', { a: 'b' }), '[gd_resource type="EditorSettings" format=3]\n\n[resource]\na = "b"\n',
    'a missing file becomes a minimal one');
});

test('parseGodotProbeLines maps the marker lines to the capabilities shape', () => {
  const sample = [
    'PROBE version 4.7.2.stable.official.ed1daf0bf',
    'PROBE android_export ok',
    'PROBE android_gradle FAIL error: Gradle build failed',
    '  [android_gradle] BUILD FAILED',
    'PROBE gdext_host ok',
    'PROBE gdext_load ok',
    'PROBE gdext_android SKIP android-build extra not installed',
  ].join('\n');
  assert.deepEqual(extras.parseGodotProbeLines(sample), {
    version: '4.7.2.stable.official.ed1daf0bf',
    checks: { android_export: true, android_release: false, android_gradle: false, gdext_host: true, gdext_load: true, gdext_android: false, gdext_export: false },
  });
  assert.equal(extras.parseGodotProbeLines('PROBE version ').version, null, 'an empty --version is no version');
});
