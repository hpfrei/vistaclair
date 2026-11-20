// The godot platform extra (platform-extras.js is the entry point: it lists,
// probes and installs it; this file holds the constants, the pure script
// bodies and the installer). Godot editor + headless CLI in self-contained
// mode with every export template, the OpenXR vendors addon, Godot's Android
// SDK pins in the android-build SDK, a debug keystore, and a README with the
// release-signing convention. The Rust android target + cargo-ndk belong to
// the rust extra (platform-extras.js installRust); godot only uses them.
// docs/extras.md.
const fs = require('fs');
const os = require('os');
const path = require('path');

const GODOT_ROOT = '/opt/vistaclair-godot';
// Pinned so every box exports with the same engine and templates; an app
// selects another one already present under versions/ with VC_GODOT_VERSION.
const GODOT_VERSION = '4.7.2';
const GODOT_VERSIONS = path.join(GODOT_ROOT, 'versions');
const GODOT_HOME = path.join(GODOT_VERSIONS, GODOT_VERSION);
const GODOT_EXE = path.join(GODOT_HOME, `Godot_v${GODOT_VERSION}-stable_linux.x86_64`);
const GODOT_BIN = path.join(GODOT_ROOT, 'bin', 'godot');
const GODOT_ENV = path.join(GODOT_ROOT, 'bin', 'godot-env');
const GODOT_CAPS = path.join(GODOT_ROOT, 'capabilities.json');
const GODOT_README = path.join(GODOT_ROOT, 'README.md');
const GODOT_DL = path.join(GODOT_ROOT, 'dl');
// Self-contained mode: `._sc_` beside the binary makes Godot keep its settings,
// templates and caches in editor_data/ (never ~/.local/share/godot).
const GODOT_EDITOR_DATA = path.join(GODOT_HOME, 'editor_data');
const GODOT_TEMPLATES = path.join(GODOT_EDITOR_DATA, 'export_templates', `${GODOT_VERSION}.stable`);
const GODOT_EDITOR_SETTINGS = path.join(GODOT_EDITOR_DATA, `editor_settings-${GODOT_VERSION.split('.').slice(0, 2).join('.')}.tres`);
const GODOT_DEBUG_KEYSTORE = path.join(GODOT_EDITOR_DATA, 'keystores', 'debug.keystore');
const GODOT_VENDORS_VERSION = '5.1.0';
const GODOT_VENDORS = path.join(GODOT_ROOT, 'vendors', GODOT_VENDORS_VERSION, 'asset', 'addons', 'godotopenxrvendors');
const GODOT_PROBE = path.join(__dirname, 'godot-probe.sh');

// Every download with its pinned hash: Godot's from the release's
// SHA512-SUMS.txt, the vendors addon's from its GitHub release asset digest
// (the release publishes no sums file).
const GODOT_RELEASE = `https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}-stable`;
const GODOT_DOWNLOADS = [
  { file: 'godot.zip', url: `${GODOT_RELEASE}/Godot_v${GODOT_VERSION}-stable_linux.x86_64.zip`, algo: 'sha512',
    hash: '9aa00f7a605200940bce3027a567b782f49bd8e940dd06ae9e987bd65aee1b1467edd56ed84fcdcbdd44354bf613bdbb4e5d2913e925850368e150c59ed54c65' },
  { file: 'templates.tpz', url: `${GODOT_RELEASE}/Godot_v${GODOT_VERSION}-stable_export_templates.tpz`, algo: 'sha512',
    hash: 'ca4d71c4d7b81dfc15d1a98baa07534aa95b03fdda78a0075b06672e1648d2e5f40980c9adc28d23e1b92e732ee7bf3461997aa804af74ec2fcd7a93ccb84079' },
  { file: 'vendors.zip', url: `https://github.com/GodotVR/godot_openxr_vendors/releases/download/${GODOT_VENDORS_VERSION}-stable/godotopenxrvendorsaddon.zip`, algo: 'sha256',
    hash: '6a838dbdf4115549e4511ebee0da9a5dcc8f9f6258d4cc2f2ee57a907a3e2911' },
];

// Dictated by Godot 4.7.2's gradle build template (not by any app's gradle
// files): installed into the android-build SDK so a gradle export just works.
const GODOT_ANDROID_PLATFORM = 'android-36';
const GODOT_ANDROID_BUILD_TOOLS = '36.1.0';
const GODOT_ANDROID_NDK = '29.0.14206865';
const GODOT_ANDROID_SDK_PACKAGES = [`platforms;${GODOT_ANDROID_PLATFORM}`, `build-tools;${GODOT_ANDROID_BUILD_TOOLS}`,
  `ndk;${GODOT_ANDROID_NDK}`, 'platform-tools'];
// The gdext the probe builds (api-4-7: prebuilt bindings, no libclang).
const GDEXT_VERSION = '0.5.5';

const GODOT_DEBS = ['unzip', 'curl'];

// --- the files apps meet (pure, so tests never touch /opt) ---

// bin/godot — the one executable apps run.
function renderGodotWrapper(ver) {
  return [
    '#!/bin/sh',
    '# Written by vistaclair-pro platform-extras (godot). The godot apps run.',
    '# Runs versions/$VC_GODOT_VERSION in self-contained mode (._sc_ + editor_data/',
    '# beside the binary: never ~/.local/share/godot).',
    `ROOT=${GODOT_ROOT}`,
    `VER="\${VC_GODOT_VERSION:-${ver}}"`,
    'BIN="$ROOT/versions/$VER/Godot_v$VER-stable_linux.x86_64"',
    '[ -x "$BIN" ] || { echo "godot $VER missing under $ROOT/versions — install under Apps → Setup → Extras" >&2; exit 127; }',
    'exec "$BIN" "$@"',
    '',
  ].join('\n');
}

// bin/godot-env — sourced, like android-env. Besides the VC_GODOT* exports it
// defines vc_godot_release_signing, the one way an app arms a signed
// `--export-release`: Godot 4 reads GODOT_ANDROID_KEYSTORE_RELEASE_PATH /
// _USER / _PASSWORD itself when the preset's keystore/release* fields are
// empty, so an app only has to export them from its secrets.
function renderGodotEnv(ver, vendorsVer) {
  return [
    '#!/bin/sh',
    '# Written by vistaclair-pro platform-extras (godot). Source, do not run.',
    '#',
    '# Signed release APK/AAB: the platform holds no release key. The app keeps the',
    '# keystore and passwords in its secrets and calls, before --export-release:',
    '#   vc_godot_release_signing <keystore path> <key alias> <keystore password>',
    '#   "$VC_GODOT" --headless --path <project> --export-release "<preset>" <out>.apk',
    '# (leave keystore/release, _user, _password empty in export_presets.cfg).',
    `VC_GODOT_ROOT=${GODOT_ROOT}`,
    `VC_GODOT_VERSION="\${VC_GODOT_VERSION:-${ver}}"`,
    'VC_GODOT="$VC_GODOT_ROOT/bin/godot"',
    `VC_GODOT_VENDORS="$VC_GODOT_ROOT/vendors/${vendorsVer}/asset/addons/godotopenxrvendors"`,
    'export VC_GODOT_ROOT VC_GODOT_VERSION VC_GODOT VC_GODOT_VENDORS',
    '',
    '# vc_godot_release_signing <keystore path> <key alias> <password> — exports the',
    '# three variables Godot reads for a release export; fails (return 1) when the',
    '# keystore file is missing or an argument is empty, so a build never falls',
    '# through to an unsigned release.',
    'vc_godot_release_signing() {',
    '  if [ "$#" -ne 3 ] || [ -z "$1" ] || [ -z "$2" ] || [ -z "$3" ]; then',
    '    echo "vc_godot_release_signing: usage: <keystore path> <key alias> <password>" >&2; return 1',
    '  fi',
    '  [ -f "$1" ] || { echo "vc_godot_release_signing: keystore not found: $1" >&2; return 1; }',
    '  GODOT_ANDROID_KEYSTORE_RELEASE_PATH=$1',
    '  GODOT_ANDROID_KEYSTORE_RELEASE_USER=$2',
    '  GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD=$3',
    '  export GODOT_ANDROID_KEYSTORE_RELEASE_PATH GODOT_ANDROID_KEYSTORE_RELEASE_USER GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD',
    '}',
    '',
  ].join('\n');
}

// README.md under /opt/vistaclair-godot — a short orientation for whoever
// opens the directory (the full app-facing text is the toolchains sidecar).
function renderGodotReadme(ver = GODOT_VERSION, vendorsVer = GODOT_VENDORS_VERSION) {
  return [
    '# /opt/vistaclair-godot',
    '',
    `Godot ${ver}-stable, headless, self-contained (settings, templates and caches in`,
    `versions/${ver}/editor_data/, never ~/.local/share/godot), with every export template`,
    `and the godot_openxr_vendors ${vendorsVer} addon. Written by the vistaclair platform extra \`godot\``,
    '(Apps → Setup → Extras); do not edit by hand, a reinstall rewrites it.',
    '',
    '    . /opt/vistaclair-godot/bin/godot-env      # VC_GODOT, VC_GODOT_VERSION, VC_GODOT_VENDORS',
    '    "$VC_GODOT" --headless --path <project> --import',
    '    "$VC_GODOT" --headless --path <project> --export-debug "<preset>" out.apk',
    '',
    '- `bin/godot` wrapper (VC_GODOT_VERSION picks versions/<ver>/), `bin/godot-env` sourced env.',
    '- `capabilities.json`: what the install-time test exports proved (read it, do not rediscover).',
    '- Android (needs the android-build extra): SDK pins platforms;android-36, build-tools;36.1.0,',
    '  ndk;29.0.14206865 in /opt/vistaclair-android/sdk; debug keystore + editor settings preset.',
    '- Rust GDExtension (needs the rust extra): the aarch64-linux-android target and cargo-ndk',
    '  are installed and recorded by the rust extra, see /opt/vistaclair-rust/capabilities.json.',
    '',
    '## Signed release export',
    '',
    'The platform holds no release key. The app keeps keystore + passwords in its secrets and,',
    'before `--export-release`, sets the variables Godot reads natively (leave the preset\'s',
    '`keystore/release*` fields empty; never commit a keystore or passwords):',
    '',
    '    GODOT_ANDROID_KEYSTORE_RELEASE_PATH=<keystore file>',
    '    GODOT_ANDROID_KEYSTORE_RELEASE_USER=<key alias>',
    '    GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD=<keystore/key password>',
    '',
    'godot-env defines `vc_godot_release_signing <path> <alias> <password>` which exports',
    'them and refuses an empty value or a missing keystore. Then',
    '`"$VC_GODOT" --headless --path <project> --export-release "<preset>" out.apk` and check',
    'the file exists and `apksigner verify --print-certs` shows your certificate.',
    '',
  ].join('\n');
}

// The fetch: every download lands in dl/ and is checked against its pinned
// hash (a verified file already there is reused, an unverifiable one is
// replaced). Each unpack writes a .part and renames it at the end, and leaves
// a dl/<file>.installed stamp, so an interrupted run never leaves a half tree
// that looks installed and a rerun skips what is done. editor_data/ is never
// replaced: it holds the keystore and the editor settings.
function renderGodotFetch(ver = GODOT_VERSION, vendorsVer = GODOT_VENDORS_VERSION, downloads = GODOT_DOWNLOADS) {
  const dl = Object.fromEntries(downloads.map((d) => [d.file, d]));
  const exe = `Godot_v${ver}-stable_linux.x86_64`;
  return [
    'set -eu',
    `ROOT=${GODOT_ROOT}`,
    'DL="$ROOT/dl"',
    `HOME_DIR="$ROOT/versions/${ver}"`,
    `T="$HOME_DIR/editor_data/export_templates/${ver}.stable"`,
    `V="$ROOT/vendors/${vendorsVer}"`,
    'mkdir -p "$DL" "$HOME_DIR/editor_data/export_templates" "$ROOT/vendors"',
    'trap \'rm -rf "$T.part" "$V.part" "$HOME_DIR/.godot.part"\' EXIT',
    'fetch() { # fetch <file> <url> <sha256|sha512> <hash>',
    '  f="$DL/$1"',
    '  if [ -f "$f" ] && echo "$4  $f" | "$3sum" -c --status; then echo "FETCH cached $1"; return 0; fi',
    '  echo "FETCH downloading $1"',
    '  curl -fL --retry 3 -sS -o "$f.part" "$2"',
    '  echo "FETCH verifying $1"',
    '  echo "$4  $f.part" | "$3sum" -c --status || { rm -f "$f.part"; echo "checksum mismatch: $1 ($2)" >&2; exit 1; }',
    '  mv "$f.part" "$f"',
    '}',
    'stamped() { [ "$(cat "$DL/$1.installed" 2>/dev/null)" = "$2" ]; }',
    ...downloads.map((d) => `fetch ${d.file} '${d.url}' ${d.algo} ${d.hash}`),
    // The binary: compared byte for byte with the verified zip's.
    `if ! unzip -p "$DL/godot.zip" ${exe} | cmp -s - "$HOME_DIR/${exe}"; then`,
    '  echo "FETCH unpacking godot"',
    `  unzip -p "$DL/godot.zip" ${exe} > "$HOME_DIR/.godot.part"`,
    '  chmod 755 "$HOME_DIR/.godot.part"',
    `  mv "$HOME_DIR/.godot.part" "$HOME_DIR/${exe}"`,
    'fi',
    'touch "$HOME_DIR/._sc_"',
    // All export templates (android, linux, windows, macos, ios, web).
    `if ! stamped templates.tpz ${dl['templates.tpz'].hash} || [ ! -f "$T/version.txt" ]; then`,
    '  echo "FETCH unpacking templates"',
    '  rm -rf "$T.part" && mkdir -p "$T.part"',
    '  unzip -q "$DL/templates.tpz" -d "$T.part"',
    '  mv "$T.part/templates/"* "$T.part/" && rmdir "$T.part/templates"',
    `  [ "$(cat "$T.part/version.txt")" = "${ver}.stable" ] || { echo "templates are not ${ver}.stable" >&2; exit 1; }`,
    '  rm -rf "$T" && mv "$T.part" "$T"',
    `  echo ${dl['templates.tpz'].hash} > "$DL/templates.tpz.installed"`,
    'fi',
    `if ! stamped vendors.zip ${dl['vendors.zip'].hash} || [ ! -f "$V/asset/addons/godotopenxrvendors/plugin.gdextension" ]; then`,
    '  echo "FETCH unpacking vendors"',
    '  rm -rf "$V.part" && mkdir -p "$V.part"',
    '  unzip -q "$DL/vendors.zip" -d "$V.part"',
    '  [ -f "$V.part/asset/addons/godotopenxrvendors/plugin.gdextension" ] || { echo "vendors zip has no asset/addons/godotopenxrvendors" >&2; exit 1; }',
    '  rm -rf "$V" && mv "$V.part" "$V"',
    `  echo ${dl['vendors.zip'].hash} > "$DL/vendors.zip.installed"`,
    'fi',
    'echo "FETCH done"',
    '',
  ].join('\n');
}

// Upsert `key = value` lines into an editor_settings-*.tres (Godot keeps the
// rest; a missing file becomes a minimal one Godot completes on first run).
// Values are strings, written as Godot string literals.
function renderGodotEditorSettings(text, values) {
  let lines = String(text || '').split('\n');
  if (!lines.some((l) => l.trim() === '[resource]')) {
    lines = ['[gd_resource type="EditorSettings" format=3]', '', '[resource]', ''];
  }
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  for (const [key, value] of Object.entries(values)) {
    const line = `${key} = ${JSON.stringify(String(value))}`;
    const at = lines.findIndex((l) => l.startsWith(`${key} = `));
    if (at >= 0) lines[at] = line;
    else lines.push(line);
  }
  return lines.join('\n') + '\n';
}

// Read godot-probe.sh's marker lines. A check the output never mentions (the
// script died before reaching it) or a SKIP counts as false.
const GODOT_CHECKS = ['android_export', 'android_gradle', 'android_release', 'gdext_host', 'gdext_load', 'gdext_android', 'gdext_export'];
function parseGodotProbeLines(text) {
  const out = { version: null, checks: Object.fromEntries(GODOT_CHECKS.map((c) => [c, false])) };
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^PROBE (\S+) (.*)$/);
    if (!m) continue;
    if (m[1] === 'version') out.version = m[2].trim() || null;
    else if (GODOT_CHECKS.includes(m[1])) out.checks[m[1]] = /^ok\b/.test(m[2]);
  }
  return out;
}

function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

function probeGodot() {
  return isExecutable(GODOT_EXE) && fs.existsSync(GODOT_BIN) && fs.existsSync(GODOT_ENV)
    && fs.existsSync(path.join(GODOT_TEMPLATES, 'version.txt'))
    && fs.existsSync(path.join(GODOT_VENDORS, 'plugin.gdextension'))
    && fs.existsSync(GODOT_CAPS);
}

// h: the helpers platform-extras.js owns — setProgress, sh, aptInstall,
// missingDebs, androidJavaHome, probe, and the android/rust path and pin constants.
async function installGodot(id, h) {
  const user = process.env.USER || process.env.LOGNAME || 'root';

  h.setProgress(id, 2, `creating ${GODOT_ROOT}`);
  await h.sh(`sudo -n mkdir -p ${path.dirname(GODOT_BIN)} ${GODOT_VERSIONS} ${GODOT_DL} && sudo -n chown -R ${user}: ${GODOT_ROOT}`);

  const missing = h.missingDebs(GODOT_DEBS);
  if (missing.length) await h.aptInstall(id, 4, missing);

  h.setProgress(id, 6, 'writing bin/godot, godot-env, README.md');
  for (const [file, body, mode] of [[GODOT_BIN, renderGodotWrapper(GODOT_VERSION), 0o755],
    [GODOT_ENV, renderGodotEnv(GODOT_VERSION, GODOT_VENDORS_VERSION), 0o755],
    [GODOT_README, renderGodotReadme(GODOT_VERSION, GODOT_VENDORS_VERSION), 0o644]]) {
    fs.writeFileSync(file, body);
    fs.chmodSync(file, mode);
  }

  h.setProgress(id, 8, `fetching Godot ${GODOT_VERSION}, all export templates, OpenXR vendors ${GODOT_VENDORS_VERSION} (~1.4 GB)`);
  const phase = (line) => {
    const m = line.match(/^FETCH (\w+) ?(\S*)/);
    if (!m) return;
    const at = { downloading: 10, verifying: 30, cached: 30, unpacking: 40 }[m[1]];
    if (at) h.setProgress(id, at, `${m[1]} ${m[2] || ''}`.trim());
  };
  await h.sh(renderGodotFetch(), { timeout: 3600000, onLine: phase });

  // Android: Godot's SDK pins into the android-build SDK, the debug keystore,
  // and the editor settings that point Godot at the JDK, SDK and keystore.
  const javaHome = h.probe('android-build') ? h.androidJavaHome() : null;
  if (javaHome) {
    const sdkm = path.join(h.ANDROID_SDK, 'cmdline-tools', 'latest', 'bin', 'sdkmanager');
    const env = `JAVA_HOME=${javaHome} ANDROID_HOME=${h.ANDROID_SDK} ANDROID_SDK_ROOT=${h.ANDROID_SDK} PATH=${javaHome}/bin:$PATH`;
    h.setProgress(id, 50, `installing ${GODOT_ANDROID_SDK_PACKAGES.join(', ')} (Godot's gradle pins)`);
    await h.sh(`${env} yes 2>/dev/null | ${env} ${sdkm} --sdk_root=${h.ANDROID_SDK} --licenses >/dev/null`);
    await h.sh(`${env} ${sdkm} --sdk_root=${h.ANDROID_SDK} ${GODOT_ANDROID_SDK_PACKAGES.map((p) => `"${p}"`).join(' ')} >/dev/null`, { timeout: 3600000 });

    h.setProgress(id, 60, 'debug keystore and editor settings');
    if (!fs.existsSync(GODOT_DEBUG_KEYSTORE)) {
      fs.mkdirSync(path.dirname(GODOT_DEBUG_KEYSTORE), { recursive: true });
      await h.sh(`${javaHome}/bin/keytool -genkeypair -keystore ${GODOT_DEBUG_KEYSTORE} -storepass android -keypass android`
        + ' -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US" -noprompt');
    }
    let current = '';
    try { current = fs.readFileSync(GODOT_EDITOR_SETTINGS, 'utf-8'); } catch {}
    fs.mkdirSync(GODOT_EDITOR_DATA, { recursive: true });
    fs.writeFileSync(GODOT_EDITOR_SETTINGS, renderGodotEditorSettings(current, {
      'export/android/java_sdk_path': javaHome,
      'export/android/android_sdk_path': h.ANDROID_SDK,
      'export/android/debug_keystore': GODOT_DEBUG_KEYSTORE,
      'export/android/debug_keystore_user': 'androiddebugkey',
      'export/android/debug_keystore_pass': 'android',
    }));
  }

  // Rust GDExtension: the rust extra owns the android target and cargo-ndk
  // (installRust); here they are only used, when that extra is present.
  const rustReady = h.probe('rust');

  // Verify by exporting, the way apps will. The exit code is not the verdict —
  // the marker lines are.
  h.setProgress(id, 72, 'test exports: Android APK (prebuilt + gradle), Rust GDExtension (fetches crates and gradle)');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-godot-probe-'));
  const log = path.join(workDir, 'probe.log');
  let caps;
  try {
    const env = [`VC_GODOT=${GODOT_BIN}`, `VC_GODOT_ENV=${GODOT_ENV}`, `VC_GDEXT_VERSION=${GDEXT_VERSION}`];
    if (javaHome) {
      env.push(`VC_ANDROID_ENV=${h.ANDROID_ENV}`, `VC_ANDROID_NDK=${path.join(h.ANDROID_SDK, 'ndk', GODOT_ANDROID_NDK)}`,
        `VC_APKSIGNER=${path.join(h.ANDROID_SDK, 'build-tools', GODOT_ANDROID_BUILD_TOOLS, 'apksigner')}`);
    }
    if (rustReady) env.push(`VC_RUST_ENV=${h.RUST_ENV}`);
    await h.sh(`cd ${workDir} && env -u DISPLAY -u WAYLAND_DISPLAY ${env.join(' ')} bash ${GODOT_PROBE} ${workDir}/w > ${log} 2>&1; true`, {
      timeout: 3600000,
    });
    const text = fs.readFileSync(log, 'utf-8');
    caps = parseGodotProbeLines(text);
    const tail = text.trim().slice(-600);
    if (!caps.version) throw new Error(`godot --version did not run: ${tail}`);
    if (javaHome && !caps.checks.android_export) throw new Error(`godot runs but cannot export a signed Android APK headless: ${tail}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  fs.writeFileSync(GODOT_CAPS, JSON.stringify({
    ...caps,
    templates: `${GODOT_VERSION}.stable`,
    vendors: GODOT_VENDORS_VERSION,
    android: javaHome ? { platform: GODOT_ANDROID_PLATFORM, buildTools: GODOT_ANDROID_BUILD_TOOLS, ndk: GODOT_ANDROID_NDK } : null,
    rust: rustReady ? { target: h.RUST_ANDROID_TARGET, cargoNdk: h.CARGO_NDK_VERSION, gdext: GDEXT_VERSION } : null,
    checkedAt: new Date().toISOString(),
  }, null, 2) + '\n');

  h.setProgress(id, 98, 'verifying');
  if (!probeGodot()) throw new Error('install finished but verification probe failed');
}

module.exports = {
  GODOT_ROOT, GODOT_VERSION, GODOT_VERSIONS, GODOT_HOME, GODOT_EXE, GODOT_BIN, GODOT_ENV, GODOT_CAPS, GODOT_DL,
  GODOT_EDITOR_DATA, GODOT_TEMPLATES, GODOT_EDITOR_SETTINGS, GODOT_DEBUG_KEYSTORE, GODOT_VENDORS_VERSION, GODOT_VENDORS,
  GODOT_DOWNLOADS, GODOT_ANDROID_SDK_PACKAGES, GODOT_ANDROID_NDK, GDEXT_VERSION, GODOT_README,
  renderGodotWrapper, renderGodotEnv, renderGodotReadme, renderGodotFetch, renderGodotEditorSettings, parseGodotProbeLines,
  probeGodot, installGodot,
};
