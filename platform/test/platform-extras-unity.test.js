// The unity extra without touching /opt: the listing, the generated script
// bodies, the probe manifest, and the parsers the installer's and the licence
// helpers' verdicts rest on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const extras = require('../src/apps/platform-extras');

const appsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-extras-unity-'));
extras.init({ appsDir, broadcaster: { broadcast() {} } });
test.after(() => fs.rmSync(appsDir, { recursive: true, force: true }));

test('unity is listed, and not installed until its capabilities.json exists', () => {
  const entry = extras.list().find((e) => e.id === 'unity');
  assert.ok(entry, 'unity is an extra');
  assert.equal(entry.title, 'Unity (headless Quest / Android builds, + Rust)');
  if (fs.existsSync(extras.UNITY_CAPS)) return; // installed box — the probe answers for real
  assert.equal(entry.installed, false);
});

test('the unity paths keep the layout apps depend on', () => {
  assert.equal(extras.UNITY_ROOT, '/opt/vistaclair-unity');
  assert.equal(extras.UNITY_VERSION, '6000.3.28f1');
  assert.equal(extras.UNITY_BIN, '/opt/vistaclair-unity/bin/unity');
  assert.equal(extras.UNITY_ENV, '/opt/vistaclair-unity/bin/unity-env');
  assert.equal(extras.UNITY_LICENSE, '/opt/vistaclair-unity/bin/unity-license');
  assert.equal(extras.UNITY_LOGIN, '/opt/vistaclair-unity/bin/unity-login');
  assert.equal(extras.UNITY_CAPS, '/opt/vistaclair-unity/capabilities.json');
  assert.equal(extras.UNITY_CLI, '/opt/vistaclair-unity/cli/bin/unity');
  assert.equal(extras.UNITY_EDITOR, '/opt/vistaclair-unity/versions/6000.3.28f1/Editor/Unity');
  assert.equal(extras.UNITY_ANDROID, '/opt/vistaclair-unity/versions/6000.3.28f1/Editor/Data/PlaybackEngines/AndroidPlayer');
  assert.equal(extras.UNITY_BUILD_PACKAGE, '/opt/vistaclair-unity/packages/com.vistaclair.build');
  assert.equal(extras.UNITY_DEBUG_KEYSTORE, '/opt/vistaclair-unity/keystores/debug.keystore');
  assert.equal(typeof extras.reprobeUnity, 'function');
  assert.equal(extras.installUnity, undefined, 'the installer runs only through install()');
});

test('every pinned download carries a hash of its algorithm\'s length', () => {
  const len = { md5: 32, sha1: 40, sha256: 64, sha384: 96 };
  for (const [ver, rel] of Object.entries(extras.UNITY_RELEASES)) {
    assert.ok(/^[0-9a-f]{12}$/.test(rel.changeset), ver);
    for (const d of [rel.editor, rel.android, ...rel.modules, extras.UNITY_CLI_DOWNLOAD]) {
      assert.ok(len[d.algo], `${d.file}: ${d.algo}`);
      assert.match(d.hash, new RegExp(`^[0-9a-f]{${len[d.algo]}}$`), d.file);
      assert.ok(d.url.startsWith('https://') && d.url.endsWith(d.file.replace(/^unity-cli-.*-linux-x64$/, 'unity-linux-x64')), d.file);
    }
    for (const m of rel.modules) assert.ok(m.dest && m.sub, m.file);
  }
  const rel = extras.UNITY_RELEASES['6000.3.28f1'];
  assert.ok(rel.editor.url.includes('/8f082d2fe476/LinuxEditorInstaller/'));
  assert.ok(rel.modules.some((m) => m.file === 'android-ndk-r27c-linux.zip' && m.dest === 'NDK'), 'NDK r27c where Unity expects it');
});

test('the unity wrapper checks the licence first, skips it for -version, exits 3 without one', () => {
  const body = extras.renderUnityWrapper('6000.3.28f1');
  assert.ok(body.startsWith('#!/bin/bash\n'));
  assert.ok(body.includes('VC_UNITY_VERSION="${VC_UNITY_VERSION:-6000.3.28f1}"'));
  assert.ok(body.includes('BIN="$ROOT/versions/$VC_UNITY_VERSION/Editor/Unity"'));
  assert.ok(body.includes('exit 127'));
  assert.ok(body.includes('"$ROOT/bin/unity-license" ensure') && body.includes('exit 3'));
  assert.ok(body.includes('Apps → Setup → Extras'));
  assert.ok(body.indexOf('-version') < body.indexOf('unity-license" ensure'), '-version runs before the licence check');
  assert.ok(body.trim().endsWith('exec "$BIN" "$@"'));
});

test('unity-env exports the VC_UNITY variables and UNITY_CLI_HOME', () => {
  const body = extras.renderUnityEnv('6000.3.28f1');
  for (const v of ['VC_UNITY_ROOT', 'VC_UNITY_VERSION', 'VC_UNITY', 'VC_UNITY_EDITOR', 'VC_UNITY_ANDROID', 'VC_UNITY_CLI',
    'VC_UNITY_LICENSE', 'VC_UNITY_BUILD_PACKAGE', 'UNITY_CLI_HOME', 'VC_UNITY_UPM', 'VC_UNITY_UPM_MANIFEST']) {
    assert.match(body, new RegExp(`export .*\\b${v}\\b`), v);
  }
  assert.ok(body.includes('VC_UNITY_ANDROID="$VC_UNITY_ROOT/versions/$VC_UNITY_VERSION/Editor/Data/PlaybackEngines/AndroidPlayer"'));
  assert.ok(body.includes('UNITY_CLI_HOME="$VC_UNITY_ROOT/cli"'));
  assert.ok(body.includes('VC_UNITY_UPM_MANIFEST="$VC_UNITY_UPM/$VC_UNITY_VERSION/manifest.json"'));
});

test('the generated scripts are valid shell', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-unity-sh-'));
  try {
    for (const [name, body] of [['unity', extras.renderUnityWrapper('6000.3.28f1')], ['unity-env', extras.renderUnityEnv('6000.3.28f1')],
      ['unity-license', extras.renderUnityLicense()], ['unity-login', extras.renderUnityLogin()], ['fetch', extras.renderUnityFetch()], ['upm-fetch', extras.renderUnityUpmFetch()]]) {
      const f = path.join(dir, name);
      fs.writeFileSync(f, body);
      execFileSync('bash', ['-n', f]);
    }
    execFileSync('bash', ['-n', path.join(__dirname, '..', 'src', 'apps', 'unity', 'probe.sh')]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unity-license: status, ensure (re-activate while signed in), login, activate — no password anywhere', () => {
  const body = extras.renderUnityLicense();
  assert.ok(body.includes('license status --json --non-interactive'));
  assert.ok(body.includes('license activate --personal --accept-eula --non-interactive'), 'ensure re-activates unattended');
  assert.ok(body.includes('PATH="$NB:$PATH" "$CLI" auth login "$@"'), 'login runs with no-op browser openers first on PATH');
  assert.ok(body.includes('env -u DISPLAY -u WAYLAND_DISPLAY BROWSER=true'));
  assert.ok(body.includes('flock'), 'one re-activation at a time');
  assert.ok(!/password/i.test(body.replace(/No password ever reaches this box\./, '')));
  assert.ok(body.includes('--serial "$UNITY_LICENSE_SERIAL"'), 'a serial only from the env');
  const login = extras.renderUnityLogin();
  assert.ok(login.includes('/opt/vistaclair-unity/bin/unity-license'));
  assert.ok(login.indexOf('"$L" login') < login.indexOf('"$L" activate'));
});

test('the unity fetch verifies every download before unpacking, and unpacks via .part + stamps', () => {
  const body = extras.renderUnityFetch();
  const rel = extras.UNITY_RELEASES['6000.3.28f1'];
  for (const d of [rel.editor, rel.android, ...rel.modules, extras.UNITY_CLI_DOWNLOAD]) {
    assert.ok(body.includes(`fetch ${d.file} '${d.url}' ${d.algo} ${d.hash}`), d.file);
  }
  const lastFetch = body.lastIndexOf('\nfetch ');
  assert.ok(lastFetch < body.indexOf('tar -xJf'), 'every hash is checked before the first unpack');
  assert.ok(lastFetch < body.indexOf('7z x'));
  assert.ok(body.includes('"$3sum" -c --status'));
  assert.ok(body.includes('rm -rf "$V" && mv "$V.part" "$V"'), 'the editor tree is swapped in whole');
  assert.ok(body.includes('put android-ndk-r27c-linux.zip 090e8083a715fdb1a3e402d0763c388abb03fb4e NDK android-ndk-r27c'));
  assert.ok(body.includes('put build-tools_r36_linux.zip b0b6376977657e8ad9b969bacf4093601da2c6fb SDK/build-tools/36.0.0 android-16'));
  assert.ok(body.includes('cmp -s "$DL/unity-cli-1.0.0-beta.17-linux-x64" "$ROOT/cli/bin/unity"'));
  assert.ok(!body.includes('vr-moritz'), 'no app path');
});

test('the UPM set: the direct Quest packages, their closure pinned with a registry sha1 each', () => {
  const r = extras.UNITY_RELEASES['6000.3.28f1'];
  for (const k of ['com.unity.render-pipelines.universal', 'com.unity.xr.openxr', 'com.unity.xr.meta-openxr', 'com.unity.xr.management',
    'com.unity.xr.compositionlayers', 'com.unity.inputsystem']) assert.ok(r.packages[k], k);
  const pinned = new Map(r.upm.map(([n, v]) => [n, v]));
  assert.equal(pinned.size, r.upm.length, 'one row per package');
  for (const [n, v, h] of r.upm) {
    assert.match(v, /^\d+\.\d+\.\d+$/, n);
    assert.match(h, /^[0-9a-f]{40}$/, n);
  }
  // every direct package is either in the set at the same version or an editor core package (URP)
  for (const [n, v] of Object.entries(r.packages)) if (pinned.has(n)) assert.equal(pinned.get(n), v, n);
  assert.ok(!pinned.has('com.unity.render-pipelines.universal'));
  assert.ok(pinned.has('com.unity.xr.arfoundation') && pinned.has('com.unity.burst'), 'the closure, not only the direct ones');
});

test('upm/<ver>/manifest.json: core packages by version, every set package as a file: tarball, the build package', () => {
  const m = JSON.parse(extras.renderUnityUpmManifest());
  assert.deepEqual(Object.keys(m), ['dependencies']);
  const d = m.dependencies;
  assert.equal(d['com.unity.render-pipelines.universal'], '17.3.0');
  assert.equal(d['com.unity.xr.openxr'], 'file:/opt/vistaclair-unity/upm/com.unity.xr.openxr-1.19.0.tgz');
  assert.equal(d['com.unity.xr.arfoundation'], 'file:/opt/vistaclair-unity/upm/com.unity.xr.arfoundation-6.6.0.tgz');
  assert.equal(d['com.vistaclair.build'], 'file:/opt/vistaclair-unity/packages/com.vistaclair.build');
  assert.equal(Object.values(d).filter((v) => !v.startsWith('file:')).length, 1, 'only the editor core package is a version');
  assert.ok(!d['com.meta.xr.sdk.core'], 'optional packages are the app\'s choice');
  const custom = JSON.parse(extras.renderUnityUpmManifest({ packages: { a: '1', b: '2' }, upm: [['b', '2', 'x']] }, '/u', '/x'));
  assert.deepEqual(custom.dependencies, { a: '1', b: 'file:/u/b-2.tgz', 'com.vistaclair.build': 'file:/x' });
});

test('the UPM fetch verifies every tarball; an optional one may be missing, a required one stops it', () => {
  const rows = extras.unityUpmDownloads();
  const r = extras.UNITY_RELEASES['6000.3.28f1'];
  assert.equal(rows.filter((x) => !x.optional).length, r.upm.length);
  const meta = rows.find((x) => x.name === 'com.meta.xr.sdk.core');
  assert.ok(meta.optional && meta.algo === 'sha512' && /^[0-9a-f]{128}$/.test(meta.hash) && meta.url.startsWith('https://npm.developer.oculus.com/'));
  const body = extras.renderUnityUpmFetch();
  assert.ok(body.startsWith('set -euo pipefail'));
  assert.ok(body.includes('U=/opt/vistaclair-unity/upm'));
  assert.ok(body.includes("fetch com.unity.xr.openxr-1.19.0.tgz 'https://download.packages.unity.com/com.unity.xr.openxr/-/com.unity.xr.openxr-1.19.0.tgz' sha1 55edf9b26dd2bdec9d513fbcb0b9e4a9e5d790e9\n"));
  assert.match(body, /fetch com\.meta\.xr\.sdk\.core-207\.0\.1\.tgz '[^']+' sha512 [0-9a-f]{128} \|\| \{ rm -f "\$U\/com\.meta\.xr\.sdk\.core-207\.0\.1\.tgz"; echo "UPM optional-missing/);
  assert.ok(body.includes('"$3sum" -c --status') && body.includes('mv "$f.part" "$f"'));
});

test('the UPM fetch runs: a verified tarball is kept, a bad one replaced, an unverifiable optional one dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-unity-upm-'));
  try {
    const good = path.join(dir, 'src-good.tgz');
    fs.writeFileSync(good, 'good');
    const sha1 = require('crypto').createHash('sha1').update('good').digest('hex');
    const body = extras.renderUnityUpmFetch([
      { file: 'a-1.tgz', url: `file://${good}`, algo: 'sha1', hash: sha1 },
      { file: 'o-1.tgz', url: `file://${dir}/missing.tgz`, algo: 'sha1', hash: sha1, optional: true },
    ]).replace('U=/opt/vistaclair-unity/upm', `U=${dir}/upm`);
    const run = () => execFileSync('bash', ['-c', body], { encoding: 'utf-8' });
    let out = run();
    assert.match(out, /UPM downloading a-1\.tgz/);
    assert.match(out, /UPM optional-missing o-1\.tgz/);
    assert.equal(fs.readFileSync(path.join(dir, 'upm', 'a-1.tgz'), 'utf-8'), 'good');
    assert.ok(!fs.existsSync(path.join(dir, 'upm', 'o-1.tgz')));
    out = run();
    assert.match(out, /UPM cached a-1\.tgz/);
    fs.writeFileSync(path.join(dir, 'upm', 'a-1.tgz'), 'tampered');
    out = run();
    assert.match(out, /UPM downloading a-1\.tgz/);
    assert.equal(fs.readFileSync(path.join(dir, 'upm', 'a-1.tgz'), 'utf-8'), 'good');
    fs.writeFileSync(good, 'evil');
    fs.rmSync(path.join(dir, 'upm', 'a-1.tgz'));
    assert.throws(run, /checksum mismatch: a-1\.tgz/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseUnityLicenseStatus reads `unity license status --json`', () => {
  const sample = JSON.stringify({ success: true, command: 'license status', data: { active: true, signedIn: true, authMode: 'oauth',
    licenses: [{ product: 'Unity Personal', type: 'Assigned' }, { product: 'Asset Store' }] } }, null, 2);
  assert.deepEqual(extras.parseUnityLicenseStatus(sample), { active: true, signedIn: true, products: ['Unity Personal', 'Asset Store'] });
  assert.deepEqual(extras.parseUnityLicenseStatus('{"data":{"active":false}}'), { active: false, signedIn: false, products: [] });
  assert.equal(extras.parseUnityLicenseStatus(''), null);
  assert.equal(extras.parseUnityLicenseStatus('Error: network'), null);
  assert.equal(extras.parseUnityLicenseStatus('{"success":false}'), null);
});

test('parseUnityProbeLines maps the marker lines to the capabilities shape', () => {
  const sample = [
    'noise',
    'PROBE version 6000.3.28f1',
    'PROBE license_json {"data":{"active":true,"signedIn":true,"licenses":[{"product":"Unity Personal"}]}}',
    'PROBE license ok',
    'PROBE rust_host ok',
    'PROBE rust_android ok',
    'PROBE project ok 6000.3.28f1',
    'PROBE vulkan ok Vulkan',
    'PROBE urp ok UniversalRenderPipelineAsset',
    'PROBE openxr ok MetaQuestFeature=True validationErrors=0',
    'PROBE multiview ok SinglePassInstanced',
    'PROBE rust_editor ok vc_probe_add(2, 3) = 5',
    'PROBE apk ok 41234567 612s',
    'PROBE il2cpp_arm64 ok',
    'PROBE openxr_loader ok',
    'PROBE quest_manifest FAIL no com.oculus.intent.category.VR',
    'PROBE rust_apk ok',
    'PROBE signed_debug ok',
    'PROBE signed_release SKIP',
    'PROBE upm_offline ok netns, no registry package in packages-lock.json',
    'PROBE unknown ok',
  ].join('\n');
  const out = extras.parseUnityProbeLines(sample);
  assert.equal(out.version, '6000.3.28f1');
  assert.deepEqual(out.license, { active: true, signedIn: true, products: ['Unity Personal'] });
  assert.equal(out.apkBytes, 41234567);
  assert.equal(out.checks.apk, true);
  assert.equal(out.checks.quest_manifest, false);
  assert.equal(out.checks.signed_release, false, 'SKIP is false');
  assert.equal(out.checks.upm_offline, true);
  assert.equal(out.checks.unknown, undefined);
  assert.deepEqual(Object.keys(out.checks).filter((k) => !out.checks[k]), ['quest_manifest', 'signed_release']);
  const empty = extras.parseUnityProbeLines('PROBE version \nPROBE license FAIL no active Unity licence\nPROBE apk SKIP no licence');
  assert.equal(empty.version, null, 'an empty -version is no version');
  assert.equal(empty.license, null);
  assert.equal(empty.apkBytes, null);
  assert.ok(Object.values(empty.checks).every((v) => v === false));
});

test('the README names every path apps meet', () => {
  const body = extras.renderUnityReadme();
  for (const p of ['bin/unity', 'bin/unity-env', 'bin/unity-license', 'bin/unity-login', 'cli/bin/unity', 'packages/com.vistaclair.build',
    'keystores/debug.keystore', 'capabilities.json', 'UNITY_ANDROID_KEYSTORE_PATH', 'r27c', 'upm/', 'VC_UNITY_UPM_MANIFEST']) {
    assert.ok(body.includes(p), p);
  }
});

test('the com.vistaclair.build package ships its .meta files (the install dir is not app-writable)', () => {
  const pkg = path.join(__dirname, '..', 'src', 'apps', 'unity', 'com.vistaclair.build');
  assert.equal(JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf-8')).name, 'com.vistaclair.build');
  const guids = new Set();
  for (const f of ['package.json', 'Editor', 'Editor/Vistaclair.Build.Editor.asmdef', 'Editor/AndroidSigning.cs']) {
    const meta = fs.readFileSync(path.join(pkg, `${f}.meta`), 'utf-8');
    const g = meta.match(/^guid: ([0-9a-f]{32})$/m);
    assert.ok(g, f);
    guids.add(g[1]);
  }
  assert.equal(guids.size, 4, 'unique guids');
  const cs = fs.readFileSync(path.join(pkg, 'Editor', 'AndroidSigning.cs'), 'utf-8');
  for (const v of ['UNITY_ANDROID_KEYSTORE_PATH', 'UNITY_ANDROID_KEYSTORE_PASS', 'UNITY_ANDROID_KEYSTORE_ALIAS', 'UNITY_ANDROID_KEYSTORE_ALIAS_PASS']) {
    assert.ok(cs.includes(`"${v}"`), v);
  }
});
