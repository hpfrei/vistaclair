// The unity platform extra (platform-extras.js is the entry point: it lists,
// probes and installs it; this file holds the constants, the pure script
// bodies, the licence helpers and the installer). Unity editor + Android Build
// Support with the SDK / NDK / OpenJDK the release pins, self-contained per
// version under versions/<ver>/, the Unity CLI (licence), a shared debug
// keystore and the com.vistaclair.build UPM package (env-driven Android
// signing). docs/extras-unity.md.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const UNITY_ROOT = '/opt/vistaclair-unity';
// Pinned so every box builds with the same editor; an app selects another one
// present under versions/ with VC_UNITY_VERSION.
const UNITY_VERSION = '6000.3.28f1';
const UNITY_VERSIONS = path.join(UNITY_ROOT, 'versions');
const UNITY_BIN = path.join(UNITY_ROOT, 'bin', 'unity');
const UNITY_ENV = path.join(UNITY_ROOT, 'bin', 'unity-env');
const UNITY_LOGIN = path.join(UNITY_ROOT, 'bin', 'unity-login');
const UNITY_LICENSE = path.join(UNITY_ROOT, 'bin', 'unity-license');
const UNITY_CAPS = path.join(UNITY_ROOT, 'capabilities.json');
const UNITY_README = path.join(UNITY_ROOT, 'README.md');
const UNITY_DL = path.join(UNITY_ROOT, 'dl');
const UNITY_CLI_HOME = path.join(UNITY_ROOT, 'cli');
const UNITY_CLI = path.join(UNITY_CLI_HOME, 'bin', 'unity');
const UNITY_DEBUG_KEYSTORE = path.join(UNITY_ROOT, 'keystores', 'debug.keystore');
const UNITY_BUILD_PACKAGE = path.join(UNITY_ROOT, 'packages', 'com.vistaclair.build');
const UNITY_UPM = path.join(UNITY_ROOT, 'upm');
const UNITY_ASSETS = path.join(__dirname, 'unity');
const UNITY_PROBE = path.join(UNITY_ASSETS, 'probe.sh');

const unityEditor = (ver) => path.join(UNITY_VERSIONS, ver, 'Editor', 'Unity');
const unityAndroid = (ver) => path.join(UNITY_VERSIONS, ver, 'Editor', 'Data', 'PlaybackEngines', 'AndroidPlayer');
const unityUpmManifest = (ver) => path.join(UNITY_UPM, ver, 'manifest.json');
const UNITY_EDITOR = unityEditor(UNITY_VERSION);
const UNITY_ANDROID = unityAndroid(UNITY_VERSION);

// The Unity CLI binary itself (not unity.com/install.sh, which rewrites shell
// rc files and ~/.config/unityhub/cli-install.json); sha256 from the version's
// manifest public-cdn.cloud.unity3d.com/hub/prod/cli/<ver>/latest.json.
const UNITY_CLI_VERSION = '1.0.0-beta.17';
const UNITY_CLI_DOWNLOAD = {
  file: `unity-cli-${UNITY_CLI_VERSION}-linux-x64`,
  url: `https://public-cdn.cloud.unity3d.com/hub/prod/cli/${UNITY_CLI_VERSION}/unity-linux-x64`,
  algo: 'sha256', hash: '2f5246ee5bea5032da2917f5f0125d3cfe803c85dc34f78bd75a427db13a0b3c',
};

// One row per installable version, from the release API
// (services.api.unity.com/unity/editor/release/v1/releases): the editor and the
// Android module with their md5 (the API's base64, as hex), and the module's
// sub-modules — OpenJDK (sha256 in its file name), cmdline-tools (the API's
// sha384), the Google zips (sha1 from dl.google.com/android/repository/
// repository2-3.xml). `dest` is under AndroidPlayer/, `sub` the zip's top
// directory (`.` = the zip root) — the API's destination + extractedPathRename.
const U = (cs) => `https://download.unity3d.com/download_unity/${cs}`;
const G = 'https://dl.google.com/android/repository';
const UNITY_RELEASES = {
  '6000.3.28f1': {
    changeset: '8f082d2fe476',
    editor: { file: 'Unity-6000.3.28f1.tar.xz', url: `${U('8f082d2fe476')}/LinuxEditorInstaller/Unity-6000.3.28f1.tar.xz`,
      algo: 'md5', hash: 'ccbe0a59c4fbee234991a841d9506ad8' },
    android: { file: 'UnitySetup-Android-Support-for-Editor-6000.3.28f1.pkg',
      url: `${U('8f082d2fe476')}/MacEditorTargetInstaller/UnitySetup-Android-Support-for-Editor-6000.3.28f1.pkg`,
      algo: 'md5', hash: 'ed56803c5dde268316a5a8554521e1f9' },
    modules: [
      { file: 'jdk17.0.18-8_86b9da7ec57717bdf4d79c35f1c2dde77b5a587fb706909085a8902cf37ead51.zip',
        url: 'https://download.unity3d.com/download_unity/open-jdk/open-jdk-linux-x64/jdk17.0.18-8_86b9da7ec57717bdf4d79c35f1c2dde77b5a587fb706909085a8902cf37ead51.zip',
        algo: 'sha256', hash: '86b9da7ec57717bdf4d79c35f1c2dde77b5a587fb706909085a8902cf37ead51', dest: 'OpenJDK', sub: '.' },
      { file: 'android-ndk-r27c-linux.zip', url: `${G}/android-ndk-r27c-linux.zip`,
        algo: 'sha1', hash: '090e8083a715fdb1a3e402d0763c388abb03fb4e', dest: 'NDK', sub: 'android-ndk-r27c' },
      { file: 'cmake-3.22.1-linux.zip', url: `${G}/cmake-3.22.1-linux.zip`,
        algo: 'sha1', hash: 'fd0a48b4a758310df8c7aa51f59840ed48fe7ed8', dest: 'SDK/cmake/3.22.1', sub: '.' },
      { file: 'build-tools_r36_linux.zip', url: `${G}/build-tools_r36_linux.zip`,
        algo: 'sha1', hash: 'b0b6376977657e8ad9b969bacf4093601da2c6fb', dest: 'SDK/build-tools/36.0.0', sub: 'android-16' },
      { file: 'platform-tools_r37.0.1-linux.zip', url: `${G}/platform-tools_r37.0.1-linux.zip`,
        algo: 'sha1', hash: '477254aa5f903c15cf51001717bdf347fb6b53e0', dest: 'SDK/platform-tools', sub: 'platform-tools' },
      { file: 'platform-34-ext7_r02.zip', url: `${G}/platform-34-ext7_r02.zip`,
        algo: 'sha1', hash: 'f09b07da8aea238a81b71d6fedb815e13aa13e58', dest: 'SDK/platforms/android-34', sub: 'android-34' },
      { file: 'platform-36_r02.zip', url: `${G}/platform-36_r02.zip`,
        algo: 'sha1', hash: '2c1a80dd4d9f7d0e6dd336ec603d9b5c55a6f576', dest: 'SDK/platforms/android-36', sub: 'android-36' },
      { file: 'commandlinetools-linux-12266719_latest.zip', url: `${G}/commandlinetools-linux-12266719_latest.zip`,
        algo: 'sha384', hash: 'd09cf68e0f1a0b60d606af35d925ee6af53773593209dd4df237eca0a5b8791e31cad3eecd8befe6d81e74b0d50d5b44',
        dest: 'SDK/cmdline-tools/16.0', sub: 'cmdline-tools' },
    ],
    androidPins: { jdk: '17.0.18+8', ndk: 'r27c (27.2.12479018)', cmake: '3.22.1', buildTools: '36.0.0',
      platformTools: '37.0.1', platforms: ['android-34', 'android-36'], cmdlineTools: '16.0' },
    // The UPM packages of a Quest app — the ONE list (the probe builds with it).
    // `packages`: the direct dependencies; one not in `upm` is an editor core
    // package (Data/Resources/PackageManager/BuiltInPackages). `upm`: every
    // registry package of their closure as this editor resolves it (its
    // minimumVersion table lifts the indirect ones), [name, version, sha1 =
    // the registry's dist.shasum]; kept under upm/ for `file:` references.
    packages: {
      'com.unity.render-pipelines.universal': '17.3.0',
      'com.unity.xr.management': '4.7.0',
      'com.unity.xr.openxr': '1.19.0',
      'com.unity.xr.meta-openxr': '2.7.0',
      'com.unity.xr.compositionlayers': '2.6.1',
      'com.unity.inputsystem': '1.20.1',
    },
    upm: [
      ['com.unity.burst', '1.8.31', 'bfa84123c21a3f0463163b6dbc1112f2f6da87e6'],
      ['com.unity.collections', '2.7.1', '88d5bf65ce666aa2dd0127d0a84e7bbf758a76e6'],
      ['com.unity.editorcoroutines', '1.1.0', '87a15ed012c21ed5d88f4ba868a5b1948294627b'],
      ['com.unity.inputsystem', '1.20.1', '2436e68c60c469edbccef8f6b3c319b9441f4675'],
      ['com.unity.mathematics', '1.3.3', '19a9377c4ffa59370edad3e6a34e4445529badde'],
      ['com.unity.nuget.mono-cecil', '1.11.6', 'ecb9724e46fff855c46a4f37f0a3377a3cfffc06'],
      ['com.unity.searcher', '4.9.5', 'a463122f2c00f83398f41790942a0793431e70ea'],
      ['com.unity.test-framework.performance', '3.5.0', '8b56083ec0f03c33121bea5c806c91b0fa2f2b69'],
      ['com.unity.xr.arfoundation', '6.6.0', '41a353b6038bf510cce1950cef8fd90d6eb3c3e5'],
      ['com.unity.xr.compositionlayers', '2.6.1', '93955c91f014ea14e4f5ab6823bd2eef601a4a31'],
      ['com.unity.xr.core-utils', '2.6.0', 'a8b900321199038fe4200211a52f46d2f4bae786'],
      ['com.unity.xr.legacyinputhelpers', '2.1.13', '9535ff2c27ac3e8dfb63877c36641a1cc1a48c14'],
      ['com.unity.xr.management', '4.7.0', '2ad85c7dd480d2c8bfb047d40fa76e0745f5128d'],
      ['com.unity.xr.meta-openxr', '2.7.0', 'be94766ae5f973ac1eb3203d1504ce889ba04c27'],
      ['com.unity.xr.openxr', '1.19.0', '55edf9b26dd2bdec9d513fbcb0b9e4a9e5d790e9'],
    ],
  },
};

// Optional UPM packages: fetched and verified like the set, recorded in
// capabilities.json, not in upm/<ver>/manifest.json (an app adds them).
// The Meta XR Core SDK (Meta's npm registry; sha512 = its dist.integrity) and
// the registry package it needs beyond the set.
const UNITY_UPM_OPTIONAL = [
  { name: 'com.meta.xr.sdk.core', version: '207.0.1', algo: 'sha512',
    hash: 'bbca9ea05b6f5889d5f61ff97bf9e69e85045b1eab3b381cd6d78e21fc46554ce521cbc77ac4b5a785bd3efe5a00901b93ccba0f759ae96edb7f081e5e7e3666',
    url: 'https://npm.developer.oculus.com/com.meta.xr.sdk.core/-/com.meta.xr.sdk.core-207.0.1.tgz' },
  { name: 'com.unity.xr.hands', version: '1.7.2', algo: 'sha1', hash: '6361f2b63a8e1db97ee084a3438b607baa923cde' },
];

const upmFile = (name, version) => `${name}-${version}.tgz`;
const upmUrl = (name, version) => `https://download.packages.unity.com/${name}/-/${upmFile(name, version)}`;
// Every download of a release's package set (required ones first), as fetch rows.
function unityUpmDownloads(release = UNITY_RELEASES[UNITY_VERSION], optional = UNITY_UPM_OPTIONAL) {
  return [
    ...release.upm.map(([name, version, hash]) => ({ name, version, file: upmFile(name, version), url: upmUrl(name, version), algo: 'sha1', hash })),
    ...optional.map((o) => ({ ...o, file: upmFile(o.name, o.version), url: o.url || upmUrl(o.name, o.version), optional: true })),
  ];
}
const UNITY_RUST_TARGET = 'aarch64-linux-android';
const UNITY_ANDROID_API = 29; // cargo ndk -P: the Rust cdylib's platform level (Quest OS ≥ 29)

const UNITY_DEBS = ['curl', 'unzip', 'xz-utils', 'cpio', 'p7zip-full', 'util-linux'];

// --- the files apps meet (pure, so tests never touch /opt) ---

// bin/unity — the one executable apps run.
function renderUnityWrapper(ver) {
  return [
    '#!/bin/bash',
    '# Written by vistaclair-pro platform-extras (unity). The unity apps run.',
    '# Runs versions/$VC_UNITY_VERSION/Editor/Unity (-batchmode -nographics friendly).',
    '# The licence comes first (bin/unity-license ensure: a lapsed Personal licence is',
    '# re-activated while the account is still signed in); exit 3 when there is none.',
    '# `unity -version` needs none.',
    `ROOT=${UNITY_ROOT}`,
    `VC_UNITY_VERSION="\${VC_UNITY_VERSION:-${ver}}"`,
    'BIN="$ROOT/versions/$VC_UNITY_VERSION/Editor/Unity"',
    '[ -x "$BIN" ] || { echo "unity $VC_UNITY_VERSION missing under $ROOT/versions — install under Apps → Setup → Extras" >&2; exit 127; }',
    'VC_UNITY_ROOT=$ROOT',
    'VC_UNITY_ANDROID="$ROOT/versions/$VC_UNITY_VERSION/Editor/Data/PlaybackEngines/AndroidPlayer"',
    'export VC_UNITY_ROOT VC_UNITY_VERSION VC_UNITY_ANDROID',
    'if [ "$#" = 1 ] && { [ "$1" = -version ] || [ "$1" = --version ]; }; then exec "$BIN" "$@"; fi',
    'if [ "${VC_UNITY_SKIP_LICENSE:-}" != 1 ] && ! "$ROOT/bin/unity-license" ensure >/dev/null; then',
    '  echo "unity: no active Unity licence for $(id -un) — the owner signs in once: Apps → Setup → Extras → Unity (or $ROOT/bin/unity-login)" >&2',
    '  exit 3',
    'fi',
    'exec "$BIN" "$@"',
    '',
  ].join('\n');
}

// bin/unity-env — sourced, like godot-env.
function renderUnityEnv(ver) {
  return [
    '#!/bin/sh',
    '# Written by vistaclair-pro platform-extras (unity). Source, do not run.',
    `VC_UNITY_ROOT=${UNITY_ROOT}`,
    `VC_UNITY_VERSION="\${VC_UNITY_VERSION:-${ver}}"`,
    'VC_UNITY="$VC_UNITY_ROOT/bin/unity"',
    'VC_UNITY_EDITOR="$VC_UNITY_ROOT/versions/$VC_UNITY_VERSION/Editor/Unity"',
    'VC_UNITY_ANDROID="$VC_UNITY_ROOT/versions/$VC_UNITY_VERSION/Editor/Data/PlaybackEngines/AndroidPlayer"',
    'VC_UNITY_CLI="$VC_UNITY_ROOT/cli/bin/unity"',
    'VC_UNITY_LICENSE="$VC_UNITY_ROOT/bin/unity-license"',
    'VC_UNITY_BUILD_PACKAGE="$VC_UNITY_ROOT/packages/com.vistaclair.build"',
    'UNITY_CLI_HOME="$VC_UNITY_ROOT/cli"',
    'UNITY_NO_BANNER=1',
    'export VC_UNITY_ROOT VC_UNITY_VERSION VC_UNITY VC_UNITY_EDITOR VC_UNITY_ANDROID VC_UNITY_CLI VC_UNITY_LICENSE VC_UNITY_BUILD_PACKAGE UNITY_CLI_HOME UNITY_NO_BANNER',
    '# the offline UPM package set: tarballs, and the Packages/manifest.json dependencies for this version',
    'VC_UNITY_UPM="$VC_UNITY_ROOT/upm"',
    'VC_UNITY_UPM_MANIFEST="$VC_UNITY_UPM/$VC_UNITY_VERSION/manifest.json"',
    'export VC_UNITY_UPM VC_UNITY_UPM_MANIFEST',
    '',
  ].join('\n');
}

// The commands the Unity CLI may run to open the sign-in URL in a browser. It
// ignores BROWSER and runs xdg-open from PATH, which on a desktop session opens
// a browser on that screen. `login` puts no-op stubs of these first on PATH.
const UNITY_BROWSER_OPENERS = ['xdg-open', 'gio', 'gnome-open', 'kde-open', 'kde-open5', 'wslview',
  'sensible-browser', 'x-www-browser', 'www-browser'];
// $ROOT/license-mode holds `serial` while the owner has stored a Pro / Industry
// serial; `ensure` then never activates Personal in its place.
const UNITY_LICENSE_MODE = path.join(UNITY_ROOT, 'license-mode');

// bin/unity-license — the licence commands, for bin/unity, bin/unity-login and
// the server. The state is the running user's ~/.config/unityhub; no password
// ever reaches this box (Personal has no password / serial / .ulf activation).
function renderUnityLicense() {
  return [
    '#!/bin/bash',
    '# Written by vistaclair-pro platform-extras (unity). The Unity licence of the user',
    '# running it (state in ~/.config/unityhub). No password ever reaches this box.',
    '#   status    print `unity license status --json`; exit 0 active, 3 not',
    '#   account   print `unity auth status --json` (who is signed in)',
    '#   ensure    exit 0 when active; a lapsed Personal licence is re-activated while the',
    '#             account is still signed in; else a message and exit 3',
    '#   login     sign in: prints a one-time URL to approve in any browser (~5 min); never',
    '#             opens a browser itself (extra args go to `unity auth login`, e.g. --json)',
    '#   activate  activate Unity Personal (accepts its EULA), or the serial in',
    '#             $UNITY_LICENSE_SERIAL (Pro / Industry; the account must be signed in)',
    'set -u',
    `ROOT=${UNITY_ROOT}`,
    'CLI="$ROOT/cli/bin/unity"',
    'export UNITY_CLI_HOME="$ROOT/cli" UNITY_NO_BANNER=1',
    '[ -x "$CLI" ] || { echo "unity-license: no Unity CLI at $CLI — install under Apps → Setup → Extras" >&2; exit 127; }',
    'status_json() { "$CLI" license status --json --non-interactive 2>/dev/null; }',
    'active() { printf \'%s\' "$1" | grep -q \'"active": *true\'; }',
    'signed_in() { printf \'%s\' "$1" | grep -q \'"signedIn": *true\'; }',
    'case "${1:-}" in',
    '  status)',
    '    s=$(status_json); printf \'%s\\n\' "$s"; active "$s" || exit 3 ;;',
    '  account) exec "$CLI" auth status --json --non-interactive ;;',
    '  ensure)',
    '    s=$(status_json); active "$s" && exit 0',
    '    if [ "$(cat "$ROOT/license-mode" 2>/dev/null)" = serial ]; then',
    '      echo "unity-license: the Unity Pro / Industry licence of $(id -un) is not active — the owner re-activates it under Apps → Setup → Extras → Unity" >&2',
    '      exit 3',
    '    fi',
    '    # one re-activation at a time per user (parallel builds all find it lapsed)',
    '    exec 9>"/tmp/vistaclair-unity-license-$(id -u).lock"; flock -w 120 9 || true',
    '    s=$(status_json); active "$s" && exit 0',
    '    if signed_in "$s"; then',
    '      echo "unity-license: licence not active — re-activating Unity Personal" >&2',
    '      "$CLI" license activate --personal --accept-eula --non-interactive >&2 || true',
    '      s=$(status_json); active "$s" && exit 0',
    '      echo "unity-license: re-activation failed for $(id -un)" >&2',
    '    else',
    '      echo "unity-license: $(id -un) is not signed in to a Unity account — the owner signs in under Apps → Setup → Extras → Unity (or runs $ROOT/bin/unity-login)" >&2',
    '    fi',
    '    exit 3 ;;',
    '  login)',
    '    # The CLI ignores BROWSER and runs xdg-open: no-op openers first on PATH, no display.',
    '    NB=$(mktemp -d /tmp/vistaclair-unity-nobrowser.XXXXXX)',
    '    trap \'rm -rf "$NB"\' EXIT; trap \'exit 143\' TERM INT HUP',
    `    for b in ${UNITY_BROWSER_OPENERS.join(' ')}; do printf '#!/bin/sh\\nexit 0\\n' > "$NB/$b"; chmod 755 "$NB/$b"; done`,
    '    shift; env -u DISPLAY -u WAYLAND_DISPLAY BROWSER=true PATH="$NB:$PATH" "$CLI" auth login "$@" ;;',
    '  activate)',
    '    if [ -n "${UNITY_LICENSE_SERIAL:-}" ]; then exec "$CLI" license activate --serial "$UNITY_LICENSE_SERIAL" --non-interactive',
    '    else exec "$CLI" license activate --personal --accept-eula; fi ;;',
    '  *) echo "usage: unity-license status|account|ensure|login|activate" >&2; exit 64 ;;',
    'esac',
    '',
  ].join('\n');
}

// bin/unity-login — the owner's one-time step on a terminal.
function renderUnityLogin() {
  return [
    '#!/bin/bash',
    '# Written by vistaclair-pro platform-extras (unity). One-time owner step: sign in to',
    '# the Unity account (prints a link: open it in ANY browser within ~5 minutes and',
    '# approve), then activate Unity Personal. Run it as the user the apps run as.',
    'set -eu',
    `L=${UNITY_LICENSE}`,
    'if ! "$L" status 2>/dev/null | grep -q \'"signedIn": *true\'; then "$L" login; fi',
    '"$L" activate',
    '"$L" status',
    '',
  ].join('\n');
}

// The fetch for one version: every download lands in dl/ and is checked
// against its pinned hash (a verified file already there is reused, an
// unverifiable one is replaced). Each unpack goes to a .part and is renamed at
// the end, with a stamp in versions/<ver>/.vc-stamps/, so an interrupted run
// never leaves a half tree that looks installed and a rerun skips what is
// done. A new editor drops the old tree (and its stamps) whole.
function renderUnityFetch(ver = UNITY_VERSION, release = UNITY_RELEASES[UNITY_VERSION], cli = UNITY_CLI_DOWNLOAD) {
  const all = [cli, release.editor, release.android, ...release.modules];
  return [
    'set -euo pipefail',
    `ROOT=${UNITY_ROOT}`,
    'DL="$ROOT/dl"',
    `V="$ROOT/versions/${ver}"`,
    'A="$V/Editor/Data/PlaybackEngines/AndroidPlayer"',
    'ST="$V/.vc-stamps"',
    `W="$ROOT/.work-${ver}"`,
    'mkdir -p "$DL" "$ROOT/versions" "$ROOT/cli/bin"',
    'rm -rf "$W" "$V.part" && mkdir -p "$W"',
    'trap \'rm -rf "$W" "$V.part"\' EXIT',
    'fetch() { # fetch <file> <url> <md5|sha1|sha256|sha384> <hash>',
    '  f="$DL/$1"',
    '  if [ -f "$f" ] && echo "$4  $f" | "$3sum" -c --status; then echo "FETCH cached $1"; return 0; fi',
    '  echo "FETCH downloading $1"',
    '  curl -fL --retry 3 -sS -o "$f.part" "$2"',
    '  echo "FETCH verifying $1"',
    '  echo "$4  $f.part" | "$3sum" -c --status || { rm -f "$f.part"; echo "checksum mismatch: $1 ($2)" >&2; exit 1; }',
    '  mv "$f.part" "$f"',
    '}',
    'stamped() { [ "$(cat "$ST/$1" 2>/dev/null)" = "$2" ]; }',
    'stamp() { mkdir -p "$ST" && echo "$2" > "$ST/$1"; }',
    'put() { # put <file> <hash> <dest under AndroidPlayer> <top dir in the zip | .>',
    '  d="$A/$3"',
    '  if stamped "$1" "$2" && [ -d "$d" ]; then return 0; fi',
    '  echo "FETCH unpacking $1"',
    '  rm -rf "$d.part" && mkdir -p "$d.part"',
    '  unzip -q "$DL/$1" -d "$d.part"',
    '  if [ "$4" = . ]; then rm -rf "$d" && mv "$d.part" "$d"',
    '  else [ -d "$d.part/$4" ] || { echo "$1 has no $4/" >&2; exit 1; }; rm -rf "$d" && mv "$d.part/$4" "$d" && rm -rf "$d.part"; fi',
    '  stamp "$1" "$2"',
    '}',
    ...all.map((d) => `fetch ${d.file} '${d.url}' ${d.algo} ${d.hash}`),
    // The CLI: compared byte for byte with the verified download.
    `if ! cmp -s "$DL/${cli.file}" "$ROOT/cli/bin/unity"; then`,
    `  cp "$DL/${cli.file}" "$ROOT/cli/bin/.unity.part" && chmod 755 "$ROOT/cli/bin/.unity.part"`,
    '  mv "$ROOT/cli/bin/.unity.part" "$ROOT/cli/bin/unity"',
    'fi',
    `if ! stamped ${release.editor.file} ${release.editor.hash} || [ ! -x "$V/Editor/Unity" ]; then`,
    '  echo "FETCH unpacking editor (~4.5 GB xz)"',
    '  mkdir -p "$V.part"',
    `  tar -xJf "$DL/${release.editor.file}" -C "$V.part"`,
    '  [ -x "$V.part/Editor/Unity" ] || { echo "the editor tarball has no Editor/Unity" >&2; exit 1; }',
    '  rm -rf "$V" && mv "$V.part" "$V"',
    `  stamp ${release.editor.file} ${release.editor.hash}`,
    'fi',
    // Android Build Support: a macOS .pkg (xar) whose Payload is a (gzip) cpio
    // of the AndroidPlayer tree; its sub-modules then go inside it.
    `if ! stamped ${release.android.file} ${release.android.hash} || [ ! -f "$A/UnityEditor.Android.Extensions.dll" ]; then`,
    '  echo "FETCH unpacking android"',
    '  mkdir -p "$W/pkg" "$W/pay"',
    `  7z x -y -o"$W/pkg" "$DL/${release.android.file}" >/dev/null`,
    '  PAY=$(find "$W/pkg" -name \'Payload*\' -type f | head -1)',
    '  [ -n "$PAY" ] || { echo "the Android pkg has no Payload" >&2; exit 1; }',
    '  if [ "$(head -c2 "$PAY" | od -An -tx1 | tr -d \' \')" = 1f8b ]; then gzip -dc "$PAY"; else cat "$PAY"; fi | (cd "$W/pay" && cpio -idm --quiet)',
    '  rm -rf "$W/pkg"',
    '  SRC=$(find "$W/pay" -maxdepth 3 -type d -name AndroidPlayer | head -1)',
    '  [ -n "$SRC" ] || SRC="$W/pay"',
    '  [ -f "$SRC/UnityEditor.Android.Extensions.dll" ] || { echo "the Android payload has no UnityEditor.Android.Extensions.dll" >&2; exit 1; }',
    '  rm -rf "$A" && mv "$SRC" "$A"',
    ...release.modules.map((m) => `  rm -f "$ST/${m.file}"`),
    `  stamp ${release.android.file} ${release.android.hash}`,
    'fi',
    ...release.modules.map((m) => `put ${m.file} ${m.hash} ${m.dest} ${m.sub}`),
    'chmod -R u+rwX,go+rX "$V" "$ROOT/cli"',
    'echo "FETCH done"',
    '',
  ].join('\n');
}

// The UPM package set: every tarball into upm/, checked against its pinned
// hash (a verified file there is kept, a bad one replaced; a download goes
// through .part). A required one that fails stops the install; an optional
// one prints `UPM optional-missing <file>` and is left out.
function renderUnityUpmFetch(downloads = unityUpmDownloads()) {
  return [
    'set -euo pipefail',
    `U=${UNITY_UPM}`,
    'mkdir -p "$U"',
    'fetch() { # fetch <file> <url> <sha1|sha512> <hash>',
    '  f="$U/$1"',
    '  if [ -f "$f" ] && echo "$4  $f" | "$3sum" -c --status; then echo "UPM cached $1"; return 0; fi',
    '  echo "UPM downloading $1"',
    '  curl -fL --retry 3 -sS -o "$f.part" "$2" || { rm -f "$f.part"; echo "download failed: $1 ($2)" >&2; return 1; }',
    '  echo "$4  $f.part" | "$3sum" -c --status || { rm -f "$f.part"; echo "checksum mismatch: $1 ($2)" >&2; return 1; }',
    '  mv "$f.part" "$f"',
    '}',
    ...downloads.map((d) => d.optional
      ? `fetch ${d.file} '${d.url}' ${d.algo} ${d.hash} || { rm -f "$U/${d.file}"; echo "UPM optional-missing ${d.file}"; }`
      : `fetch ${d.file} '${d.url}' ${d.algo} ${d.hash}`),
    'chmod -R u+rwX,go+rX "$U"',
    'echo "UPM done"',
    '',
  ].join('\n');
}

// upm/<ver>/manifest.json — a Packages/manifest.json for a Quest app on this
// editor: the editor core packages by version, every registry package of the
// set as a file: tarball (so nothing is fetched from a registry), and the
// signing package. The probe builds with exactly this.
function renderUnityUpmManifest(release = UNITY_RELEASES[UNITY_VERSION], upmDir = UNITY_UPM, buildPackage = UNITY_BUILD_PACKAGE) {
  const tarballs = new Map(release.upm.map(([name, version]) => [name, `file:${upmDir}/${upmFile(name, version)}`]));
  const core = Object.entries(release.packages).filter(([name]) => !tarballs.has(name));
  return JSON.stringify({
    dependencies: { ...Object.fromEntries(core), ...Object.fromEntries(tarballs), 'com.vistaclair.build': `file:${buildPackage}` },
  }, null, 2) + '\n';
}

// README.md written into the root.
function renderUnityReadme(ver = UNITY_VERSION, release = UNITY_RELEASES[UNITY_VERSION]) {
  const p = release.androidPins;
  return [
    '# /opt/vistaclair-unity — the `unity` platform extra',
    '',
    'Written by vistaclair-pro (Apps → Setup → Extras → Unity). Reinstalling rewrites',
    'everything here except `dl/` and `upm/` (verified downloads) and `keystores/`.',
    '',
    '| Path | What |',
    '|---|---|',
    `| \`bin/unity\` | The editor wrapper — always run this. \`versions/$VC_UNITY_VERSION/Editor/Unity\` (default ${ver}); licence check first, exit 3 when none, 127 when the version is absent |`,
    '| `bin/unity-env` | Source it: `VC_UNITY_ROOT`, `VC_UNITY_VERSION`, `VC_UNITY`, `VC_UNITY_EDITOR`, `VC_UNITY_ANDROID`, `VC_UNITY_CLI`, `VC_UNITY_LICENSE`, `VC_UNITY_BUILD_PACKAGE`, `UNITY_CLI_HOME`, `VC_UNITY_UPM`, `VC_UNITY_UPM_MANIFEST` |',
    '| `bin/unity-license` | `status` (JSON; exit 0 active / 3 not), `ensure` (re-activates a lapsed Personal licence while signed in), `login`, `activate` |',
    '| `bin/unity-login` | One-time owner step: prints a URL to approve in any browser, then activates Unity Personal |',
    `| \`versions/<ver>/Editor/\` | The editor; \`Data/PlaybackEngines/AndroidPlayer/\` holds Android Build Support with \`OpenJDK\` (${p.jdk}), \`NDK\` (${p.ndk}), \`SDK\` (build-tools ${p.buildTools}, platform-tools ${p.platformTools}, ${p.platforms.join(' / ')}, cmake ${p.cmake}, cmdline-tools ${p.cmdlineTools}) |`,
    `| \`cli/bin/unity\` | The Unity CLI ${UNITY_CLI_VERSION} (\`UNITY_CLI_HOME=${UNITY_CLI_HOME}\`) |`,
    `| \`upm/\` | The offline UPM package set: \`<name>-<version>.tgz\` (registry-hash verified) and \`upm/<ver>/manifest.json\` — the \`Packages/manifest.json\` dependencies of a Quest app on that editor, every registry package as a \`file:\` tarball, so no build needs a registry (\`$VC_UNITY_UPM_MANIFEST\`) |`,
    '| `packages/com.vistaclair.build/` | UPM package (`"com.vistaclair.build": "file:/opt/vistaclair-unity/packages/com.vistaclair.build"`): Android signing from `UNITY_ANDROID_KEYSTORE_PATH/_PASS/_ALIAS/_ALIAS_PASS`, else `keystores/debug.keystore` |',
    '| `keystores/debug.keystore` | The shared debug keystore (store/key password `android`, alias `androiddebugkey`) |',
    '| `capabilities.json` | The install-time probe: version, licence, the hello-world Quest APK build, the Rust P/Invoke |',
    '| `dl/` | Every download, verified against its pinned hash |',
    '',
    'The licence state lives in the running user\'s `~/.config/unityhub/`. Recipes: the',
    'toolchains sidecar (`.vistaclair/api/toolchains.md`, **Unity**) of any app session.',
    '',
  ].join('\n');
}

// Read probe.sh's marker lines. A check the output never mentions (the script
// died before reaching it) or a SKIP / FAIL counts as false.
const UNITY_CHECKS = ['license', 'rust_host', 'rust_android', 'project', 'urp', 'openxr', 'multiview', 'vulkan', 'rust_editor',
  'apk', 'il2cpp_arm64', 'openxr_loader', 'quest_manifest', 'rust_apk', 'signed_debug', 'signed_release', 'upm_offline'];
function parseUnityProbeLines(text) {
  const out = { version: null, license: null, apkBytes: null, checks: Object.fromEntries(UNITY_CHECKS.map((c) => [c, false])) };
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^PROBE (\S+) ?(.*)$/);
    if (!m) continue;
    if (m[1] === 'version') out.version = m[2].trim() || null;
    else if (m[1] === 'license_json') out.license = parseUnityLicenseStatus(m[2]);
    else if (UNITY_CHECKS.includes(m[1])) {
      out.checks[m[1]] = /^ok\b/.test(m[2]);
      const bytes = m[1] === 'apk' && m[2].match(/^ok (\d+)/);
      if (bytes) out.apkBytes = Number(bytes[1]);
    }
  }
  return out;
}

// `unity license status --json` → { active, signedIn, products } (null when it
// is not that JSON — the CLI missing, or a network error it printed instead).
// { detail: true } adds `licenses: [{ product, type, expires }]` (expires null
// when the CLI gives none, as for Personal) for the dashboard.
function parseUnityLicenseStatus(text, { detail = false } = {}) {
  let j;
  try { j = JSON.parse(String(text || '').trim()); } catch { return null; }
  const d = j && j.data;
  if (!d || typeof d !== 'object') return null;
  const list = Array.isArray(d.licenses) ? d.licenses.filter((l) => l && l.product) : [];
  const out = {
    active: d.active === true,
    signedIn: d.signedIn === true,
    products: list.map((l) => l.product),
  };
  if (detail) out.licenses = list.map((l) => ({ product: String(l.product), type: l.type ? String(l.type) : null, expires: l.expires ? String(l.expires) : null }));
  return out;
}

// The licence of the user this process runs as. Never throws: no CLI or a
// failed call reads { active: false, signedIn: false, error }.
function unityLicenseStatus({ timeout = 60000, detail = false, bin = UNITY_LICENSE } = {}) {
  return new Promise((resolve) => {
    execFile(bin, ['status'], { timeout }, (err, stdout, stderr) => {
      const s = parseUnityLicenseStatus(stdout, { detail });
      if (s) return resolve(s);
      resolve({ active: false, signedIn: false, products: [], error: String(stderr || (err && err.message) || 'no status').trim().slice(-300) });
    });
  });
}

function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

// Installed versions (every versions/<ver> with an editor), sorted.
function listUnityVersions() {
  try {
    return fs.readdirSync(UNITY_VERSIONS).filter((v) => !v.startsWith('.') && !v.endsWith('.part') && isExecutable(unityEditor(v))).sort();
  } catch { return []; }
}

function probeUnity() {
  return isExecutable(UNITY_EDITOR) && isExecutable(UNITY_CLI)
    && fs.existsSync(path.join(UNITY_ANDROID, 'UnityEditor.Android.Extensions.dll'))
    && fs.existsSync(path.join(UNITY_ANDROID, 'NDK', 'source.properties'))
    && [UNITY_BIN, UNITY_ENV, UNITY_LICENSE, UNITY_LOGIN].every(isExecutable)
    && fs.existsSync(path.join(UNITY_BUILD_PACKAGE, 'package.json'))
    && fs.existsSync(unityUpmManifest(UNITY_VERSION))
    && fs.existsSync(UNITY_DEBUG_KEYSTORE)
    && fs.existsSync(UNITY_CAPS);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// The optional UPM tarballs present (the fetch leaves out one it cannot verify).
function unityUpmOptional(optional = UNITY_UPM_OPTIONAL, upmDir = UNITY_UPM) {
  return Object.fromEntries(optional.map((o) => [o.name, fs.existsSync(path.join(upmDir, upmFile(o.name, o.version))) ? o.version : null]));
}

// The install-time probe, also re-runnable alone (after the owner signs in):
// -version (required), the licence (recorded), and with an active licence a
// headless hello-world URP + OpenXR (Meta Quest) APK — Vulkan, multiview,
// IL2CPP ARM64 — that P/Invokes a Rust cdylib, its packages from the offline
// set with no registry (required: the APK; the rest recorded). Writes
// capabilities.json and returns it. h: setProgress (optional),
// sh, probe, RUST_ENV.
async function runUnityProbe(h, id = 'unity') {
  const progress = (p, label) => h.setProgress && h.setProgress(id, p, label);
  const rustReady = h.probe('rust');
  progress(72, 'probe: -version, licence, Rust cdylib, a hello-world Quest APK from the offline UPM set (fetches gradle deps; ~15–25 min)');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-unity-probe-'));
  const log = path.join(workDir, 'probe.log');
  let caps;
  try {
    fs.writeFileSync(path.join(workDir, 'manifest.json'), renderUnityUpmManifest());
    const env = [`VC_UNITY_ENV=${UNITY_ENV}`, `VC_PROBE_SRC=${UNITY_ASSETS}`, `VC_PROBE_MANIFEST=${workDir}/manifest.json`,
      `VC_UNITY_DEBUG_KEYSTORE=${UNITY_DEBUG_KEYSTORE}`, `VC_ANDROID_API=${UNITY_ANDROID_API}`];
    if (rustReady) env.push(`VC_RUST_ENV=${h.RUST_ENV}`);
    const phase = (line) => {
      const m = line.match(/^PROBE (\S+)/);
      if (m) progress(80, `probe: ${m[1]}`);
    };
    await h.sh(`cd ${workDir} && env -u DISPLAY -u WAYLAND_DISPLAY ${env.join(' ')} bash ${UNITY_PROBE} ${workDir}/w 2>&1 | tee ${log} | grep --line-buffered '^PROBE'; true`, {
      timeout: 7200000, onLine: phase,
    });
    const text = fs.readFileSync(log, 'utf-8');
    caps = parseUnityProbeLines(text);
    const tail = text.trim().slice(-800);
    if (!caps.version) throw new Error(`unity -version did not run: ${tail}`);
    if (caps.checks.license && !caps.checks.apk) throw new Error(`unity runs and is licensed but cannot build the Quest APK headless: ${tail}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  const release = UNITY_RELEASES[UNITY_VERSION];
  const out = {
    version: caps.version,
    default: UNITY_VERSION,
    versions: listUnityVersions(),
    changeset: release.changeset,
    cli: UNITY_CLI_VERSION,
    license: caps.license,
    checks: caps.checks,
    apkBytes: caps.apkBytes,
    android: release.androidPins,
    packages: release.packages,
    upm: { dir: UNITY_UPM, manifest: unityUpmManifest(UNITY_VERSION), tarballs: release.upm.length, offline: caps.checks.upm_offline,
      optional: unityUpmOptional() },
    rust: rustReady ? { target: UNITY_RUST_TARGET, api: UNITY_ANDROID_API, ndk: 'the editor\'s AndroidPlayer/NDK' } : null,
    checkedAt: new Date().toISOString(),
  };
  fs.writeFileSync(UNITY_CAPS, JSON.stringify(out, null, 2) + '\n');
  return out;
}

// h: the helpers platform-extras.js owns — setProgress, sh, aptInstall,
// missingDebs, probe, RUST_ENV.
async function installUnity(id, h) {
  const user = process.env.USER || process.env.LOGNAME || 'root';

  h.setProgress(id, 2, `creating ${UNITY_ROOT}`);
  await h.sh(`sudo -n mkdir -p ${path.dirname(UNITY_BIN)} ${UNITY_VERSIONS} ${UNITY_DL} && sudo -n chown -R ${user}: ${UNITY_ROOT}`);

  const missing = h.missingDebs(UNITY_DEBS);
  if (missing.length) await h.aptInstall(id, 4, missing);

  h.setProgress(id, 6, 'writing bin/unity, unity-env, unity-license, unity-login, README.md');
  for (const [file, body] of [[UNITY_BIN, renderUnityWrapper(UNITY_VERSION)], [UNITY_ENV, renderUnityEnv(UNITY_VERSION)],
    [UNITY_LICENSE, renderUnityLicense()], [UNITY_LOGIN, renderUnityLogin()]]) {
    fs.writeFileSync(file, body);
    fs.chmodSync(file, 0o755);
  }
  fs.writeFileSync(UNITY_README, renderUnityReadme());

  // Every version in the table; the pinned default last so its tree is fresh.
  const versions = [...Object.keys(UNITY_RELEASES).filter((v) => v !== UNITY_VERSION), UNITY_VERSION];
  for (const ver of versions) {
    h.setProgress(id, 8, `fetching Unity ${ver} + Android Build Support, OpenJDK, NDK, SDK (~7.5 GB, verified)`);
    const phase = (line) => {
      const m = line.match(/^FETCH (\w+) ?(.*)/);
      if (!m) return;
      const at = { downloading: 10, verifying: 30, cached: 30, unpacking: 45 }[m[1]];
      if (at) h.setProgress(id, at, `Unity ${ver}: ${m[1]} ${m[2] || ''}`.trim());
    };
    await h.sh(renderUnityFetch(ver, UNITY_RELEASES[ver]), { timeout: 7200000, onLine: phase });
  }

  h.setProgress(id, 62, `UPM package set (${UNITY_RELEASES[UNITY_VERSION].upm.length} tarballs + Meta XR Core SDK, verified)`);
  const upmPhase = (line) => {
    const m = line.match(/^UPM (\S+) ?(.*)/);
    if (m && m[1] !== 'done') h.setProgress(id, 63, `UPM: ${m[1]} ${m[2] || ''}`.trim());
  };
  // One fetch over every version's set (a tarball shared by two versions is
  // fetched once), then each version's manifest.
  const downloads = new Map();
  for (const ver of versions) for (const d of unityUpmDownloads(UNITY_RELEASES[ver])) downloads.set(d.file, d);
  await h.sh(renderUnityUpmFetch([...downloads.values()]), { timeout: 3600000, onLine: upmPhase });
  for (const ver of versions) {
    fs.mkdirSync(path.dirname(unityUpmManifest(ver)), { recursive: true });
    fs.writeFileSync(unityUpmManifest(ver), renderUnityUpmManifest(UNITY_RELEASES[ver]));
  }

  h.setProgress(id, 65, 'com.vistaclair.build package, shared debug keystore');
  // The package is replaced whole (it is ours); Unity reads it from a file: dependency.
  const pkgPart = `${UNITY_BUILD_PACKAGE}.part`;
  fs.rmSync(pkgPart, { recursive: true, force: true });
  copyDir(path.join(UNITY_ASSETS, 'com.vistaclair.build'), pkgPart);
  fs.rmSync(UNITY_BUILD_PACKAGE, { recursive: true, force: true });
  fs.renameSync(pkgPart, UNITY_BUILD_PACKAGE);
  if (!fs.existsSync(UNITY_DEBUG_KEYSTORE)) {
    fs.mkdirSync(path.dirname(UNITY_DEBUG_KEYSTORE), { recursive: true });
    await h.sh(`${path.join(UNITY_ANDROID, 'OpenJDK', 'bin', 'keytool')} -genkeypair -keystore ${UNITY_DEBUG_KEYSTORE}.part -storepass android -keypass android`
      + ' -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US" -noprompt'
      + ` && mv ${UNITY_DEBUG_KEYSTORE}.part ${UNITY_DEBUG_KEYSTORE}`);
  }

  await runUnityProbe(h, id);

  h.setProgress(id, 98, 'verifying');
  if (!probeUnity()) throw new Error('install finished but verification probe failed');
}

module.exports = {
  UNITY_ROOT, UNITY_VERSION, UNITY_VERSIONS, UNITY_BIN, UNITY_ENV, UNITY_LOGIN, UNITY_LICENSE, UNITY_CAPS, UNITY_README,
  UNITY_DL, UNITY_CLI_HOME, UNITY_CLI, UNITY_CLI_VERSION, UNITY_LICENSE_MODE, UNITY_BROWSER_OPENERS, UNITY_CLI_DOWNLOAD, UNITY_EDITOR, UNITY_ANDROID,
  UNITY_DEBUG_KEYSTORE, UNITY_BUILD_PACKAGE, UNITY_RELEASES, UNITY_RUST_TARGET, UNITY_ANDROID_API,
  UNITY_UPM, UNITY_UPM_OPTIONAL, unityUpmManifest, unityUpmDownloads, unityUpmOptional,
  renderUnityWrapper, renderUnityEnv, renderUnityLicense, renderUnityLogin, renderUnityFetch, renderUnityUpmFetch, renderUnityUpmManifest,
  renderUnityReadme, parseUnityProbeLines, parseUnityLicenseStatus, unityLicenseStatus, listUnityVersions,
  probeUnity, runUnityProbe, installUnity,
};
