// Platform Extras — big optional components (ffmpeg, local music ML, the
// Android, Blender, Rust, Godot and Unity toolchains) installable from the Setup panel with
// one click + live progress.
//
// Installs run as background child processes with phase-based progress that is
// persisted to disk (.platform-extras.json) and broadcast over the dashboard
// WS, so a GUI reload mid-install re-shows the running install (docs/apps.md
// GUI-reload resilience). A server restart marks any stale 'installing' record
// as interrupted — the user just clicks Install again (all steps are
// idempotent / resumable: apt and pip skip what's present, the HF model cache
// survives).
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const godot = require('./platform-extras-godot');
const unity = require('./platform-extras-unity');
const unityLicense = require('./platform-extras-unity-license');

const ML_ROOT = '/opt/vistaclair-ml';
const ML_VENV = path.join(ML_ROOT, 'venv');
const ML_BIN = path.join(ML_ROOT, 'bin');
const ML_HF_CACHE = path.join(ML_ROOT, 'hf-cache');
const WRAPPER_SRC = path.join(__dirname, 'ml-bin');

const ANDROID_ROOT = '/opt/vistaclair-android';
const ANDROID_SDK = path.join(ANDROID_ROOT, 'sdk');
const ANDROID_BIN = path.join(ANDROID_ROOT, 'bin');
const ANDROID_ENV = path.join(ANDROID_BIN, 'android-env');
// Pinned so a reinstall two years from now reproduces today's bootstrap.
const CMDLINE_TOOLS = '11076708';

const BLENDER_ROOT = '/opt/vistaclair-blender';
// Pinned LTS, so every box renders with the same Blender; an app that needs
// another one fetches it beside this (bin/blender-fetch) and picks it with
// VC_BLENDER_VERSION.
const BLENDER_VERSION = '5.2.2';
const BLENDER_VERSIONS = path.join(BLENDER_ROOT, 'versions');
const BLENDER_BIN = path.join(BLENDER_ROOT, 'bin', 'blender');
const BLENDER_ENV = path.join(BLENDER_ROOT, 'bin', 'blender-env');
const BLENDER_FETCH = path.join(BLENDER_ROOT, 'bin', 'blender-fetch');
const BLENDER_CAPS = path.join(BLENDER_ROOT, 'capabilities.json');
const BLENDER_PROBE = path.join(__dirname, 'blender-probe.py');
// What the official build dlopens even in -b mode (X11 client libs, EGL/Mesa
// for Workbench and Eevee), plus what the fetch needs.
const BLENDER_DEBS = ['libx11-6', 'libxi6', 'libxxf86vm1', 'libxfixes3', 'libxrender1', 'libxkbcommon0',
  'libsm6', 'libgl1', 'libegl1', 'libgl1-mesa-dri', 'xz-utils', 'curl'];

const RUST_ROOT = '/opt/vistaclair-rust';
const RUSTUP_HOME = path.join(RUST_ROOT, 'rustup');
const CARGO_HOME = path.join(RUST_ROOT, 'cargo');
const RUST_ENV = path.join(RUST_ROOT, 'bin', 'rust-env');
const RUST_CAPS = path.join(RUST_ROOT, 'capabilities.json');
const RUST_PROBE = path.join(__dirname, 'rust-probe.sh');
// The default toolchain, pinned so every box compiles with the same rustc; an
// app that needs another one names it in its crate's rust-toolchain.toml and
// rustup fetches it beside this one.
const RUST_VERSION = '1.99.0';
// The Android side of the rust extra, for cdylibs an app loads on a device
// (Godot GDExtension, Unity P/Invoke): the rustup target and cargo-ndk, both
// pinned here and installed by installRust — the godot and unity extras only
// use them. cargo-ndk lives in CARGO_HOME/bin.
const RUST_ANDROID_TARGET = 'aarch64-linux-android';
const CARGO_NDK_VERSION = '4.1.2';
// rustup-init itself, pinned with its published sha256 (archive URL, not the
// moving /dist one).
const RUSTUP_VERSION = '1.29.1';
const RUSTUP_INIT_URL = `https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu`;
// cc is the linker rustc drives; pkg-config is what -sys crates look for first.
const RUST_DEBS = ['build-essential', 'pkg-config', 'curl'];

let appsDir = null;
let broadcaster = null;
// id → { progress, label, startedAt } while an install is running
const running = new Map();

// `toolchain` is the manifest.toolchains key that names the extra (one map: the
// app-row badge reads it from list(), publish from extrasForToolchains), `badge`
// the chip label, `after` the extras installed before it when both are missing.
const EXTRAS = [
  {
    id: 'ffmpeg',
    title: 'ffmpeg (audio & video processing)',
    description: 'Full ffmpeg/ffprobe suite. Powers ai.transcribe preprocessing, and any app that cuts, converts, mixes or probes audio/video.',
    size: '~300 MB',
    needsSudo: true,
  },
  {
    id: 'music-ml',
    title: 'Local music generation (MusicGen)',
    description: 'Meta MusicGen running locally on CPU — no API keys. Gives every app text-to-music plus beat/tempo analysis via the ai.music.* bridge. Python venv with torch (~1.5 GB) + model weights (~2.2 GB, downloaded once). Note: MusicGen weights are CC-BY-NC (non-commercial).',
    size: '~3.7 GB',
    needsSudo: true,
  },
  {
    id: 'android-build',
    title: 'Android build toolchain (SDK + JDK 17)',
    description: 'Android SDK command-line tools, platform-tools (adb) and OpenJDK 17. Lets any app carrying an android/ source tree build, sign and push an APK — my-cams builds the com.ipcam camera firmware with it. Bootstrap only: each app installs the SDK platform and build-tools it declares on its first build (~250 MB more, cached), so the platform never pins one app\'s SDK level.',
    size: '~350 MB',
    needsSudo: true,
    toolchain: 'android', badge: 'Android SDK',
  },
  {
    id: 'blender',
    title: 'Blender (headless 3D pipelines)',
    description: 'The pinned Blender LTS from blender.org under /opt/vistaclair-blender, with its own config directory (never ~/.config/blender). Works without a display: Workbench, Eevee and Cycles are test-rendered at install. Powers my-blender\'s model pipelines and videomaker\'s Blender renders.',
    size: '~385 MB download, ~1 GB installed',
    needsSudo: true,
    toolchain: 'blender', badge: 'Blender',
  },
  {
    id: 'rust',
    title: 'Rust toolchain (rustc + cargo)',
    description: 'rustup with the pinned stable Rust (clippy, rustfmt, the wasm32 and aarch64-linux-android targets, cargo-ndk) under /opt/vistaclair-rust, sharing one crates.io cache (never ~/.cargo). Lets an app compile its own native kernels: Python extensions (PyO3 + maturin), Node addons (napi-rs), WebAssembly and Android cdylibs (Godot GDExtension, Unity plugins). A native, PyO3, napi, wasm and, with the Android NDK present, an Android cdylib build are tested at install. The crates, maturin and any other Rust version belong to the app.',
    size: '~150 MB download, ~800 MB installed',
    needsSudo: true,
    toolchain: 'rust', badge: 'Rust',
    // its probe cross-builds an Android cdylib against the NDK when android-build is present
    after: ['android-build'],
  },
  {
    id: 'godot',
    title: 'Godot (headless game builds, Android + Rust)',
    description: 'The pinned Godot 4.7.2 editor and headless CLI under /opt/vistaclair-godot in self-contained mode (never ~/.local/share/godot), with every export template and the OpenXR vendors addon. With the Android extra it adds Godot\'s SDK pins and a debug keystore; with the Rust extra the aarch64-linux-android target and cargo-ndk for GDExtensions. A signed Android APK and a Rust GDExtension are test-exported at install.',
    size: '~1.4 GB download, ~3 GB installed',
    needsSudo: true,
    toolchain: 'godot', badge: 'Godot',
    after: ['android-build', 'rust'],
  },
  {
    id: 'unity',
    title: 'Unity (headless Quest / Android builds, + Rust)',
    description: 'The pinned Unity 6000.3.28f1 editor under /opt/vistaclair-unity with Android Build Support and the OpenJDK, NDK r27c and SDK it pins (all hash-verified), the Unity CLI for the licence, a shared debug keystore and the com.vistaclair.build package (Android signing from env). Needs a Unity licence: the owner signs in once (Personal is free). A hello-world URP + OpenXR Meta Quest APK that P/Invokes a Rust cdylib is test-built at install.',
    size: '~7.5 GB download, ~20 GB installed',
    needsSudo: true,
    toolchain: 'unity', badge: 'Unity',
    // its probe P/Invokes a Rust cdylib when rust is present
    after: ['rust'],
  },
];

function statusFile() {
  return path.join(appsDir, '.platform-extras.json');
}

function readStatusFile() {
  try { return JSON.parse(fs.readFileSync(statusFile(), 'utf-8')) || {}; } catch { return {}; }
}

function writeStatusFile(data) {
  const tmp = statusFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, statusFile());
}

function onPath(bin) {
  try {
    execFileSync('which', [bin], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch { return false; }
}

// The one JDK the frozen AGP accepts. apt names the directory by arch, so it
// is resolved rather than assumed (and never inherited from PATH — this box
// defaults to JDK 25, which AGP 8.2.2 rejects).
function androidJavaHome() {
  try {
    const base = '/usr/lib/jvm';
    const hit = fs.readdirSync(base).find((d) => /^java-17-openjdk/.test(d) || /^temurin-17/.test(d));
    return hit ? path.join(base, hit) : null;
  } catch { return null; }
}

function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

function hasSudo() {
  try { return require('./env-detect').detect().hasSudo; } catch { return false; }
}

// --- Probes (cheap, re-run on every status request) ---

function probe(id) {
  switch (id) {
    case 'ffmpeg':
      return onPath('ffmpeg') && onPath('ffprobe');
    case 'android-build': {
      // Bootstrap only — platforms/ and build-tools/ are the app's business.
      const javac = androidJavaHome();
      if (!javac || !fs.existsSync(path.join(javac, 'bin', 'javac'))) return false;
      if (!fs.existsSync(path.join(ANDROID_SDK, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'))) return false;
      if (!fs.existsSync(path.join(ANDROID_SDK, 'licenses', 'android-sdk-license'))) return false;
      if (!fs.existsSync(path.join(ANDROID_SDK, 'platform-tools', 'adb'))) return false;
      return fs.existsSync(ANDROID_ENV);
    }
    case 'blender':
      return isExecutable(path.join(BLENDER_VERSIONS, BLENDER_VERSION, 'blender'))
        && fs.existsSync(BLENDER_BIN) && fs.existsSync(BLENDER_CAPS);
    case 'rust': {
      if (!isExecutable(path.join(CARGO_HOME, 'bin', 'cargo')) || !isExecutable(path.join(CARGO_HOME, 'bin', 'rustc'))) return false;
      try {
        if (!fs.readdirSync(path.join(RUSTUP_HOME, 'toolchains')).some((d) => d.startsWith(`${RUST_VERSION}-`))) return false;
      } catch { return false; }
      if (!rustAndroidInstalled() || !fs.existsSync(RUST_ENV)) return false;
      // An install from before the Android pieces recorded no `android`: not done.
      try { return !!JSON.parse(fs.readFileSync(RUST_CAPS, 'utf-8')).android; } catch { return false; }
    }
    case 'godot':
      return godot.probeGodot();
    case 'unity':
      return unity.probeUnity();
    case 'music-ml': {
      if (!fs.existsSync(path.join(ML_VENV, 'bin', 'python'))) return false;
      if (!fs.existsSync(path.join(ML_BIN, 'musicgen'))) return false;
      if (!fs.existsSync(path.join(ML_BIN, 'beatgrid'))) return false;
      // Model weights present? (warm-up step downloads them at install time)
      try {
        return fs.readdirSync(path.join(ML_HF_CACHE, 'hub')).some((d) => /musicgen/.test(d));
      } catch { return false; }
    }
    default:
      return false;
  }
}

function list() {
  const persisted = readStatusFile();
  return EXTRAS.map((e) => {
    const run = running.get(e.id);
    const p = persisted[e.id] || {};
    const installed = probe(e.id);
    const row = {
      id: e.id,
      title: e.title,
      description: e.description,
      size: e.size,
      toolchain: e.toolchain || null,
      badge: e.badge || null,
      installed,
      installing: !!run,
      progress: run ? run.progress : 0,
      label: run ? run.label : '',
      error: run ? null : p.error || null,
      sudoOk: hasSudo(),
    };
    // The Unity licence (platform-extras-unity-license.js): cached state, refreshed in the background.
    if (e.id === 'unity' && installed) {
      row.license = unityLicense.snapshot();
      unityLicense.kick();
    }
    return row;
  });
}

// manifest.toolchains key → { extra, label }.
const TOOLCHAINS = Object.fromEntries(EXTRAS.filter((e) => e.toolchain).map((e) => [e.toolchain, { extra: e.id, label: e.badge }]));

// The extras a manifest.toolchains list names, in install order: every extra
// after the ones its `after` names (within the set), otherwise in EXTRAS order.
// Order only — `after` never adds an extra the app did not declare.
function extrasForToolchains(keys) {
  const unknown = [];
  const want = new Set();
  for (const k of Array.isArray(keys) ? keys : []) {
    if (TOOLCHAINS[k]) want.add(TOOLCHAINS[k].extra);
    else unknown.push(String(k));
  }
  const ids = [];
  const visit = (id, stack) => {
    if (ids.includes(id) || stack.includes(id)) return;
    const e = EXTRAS.find((x) => x.id === id);
    for (const dep of e.after || []) if (want.has(dep)) visit(dep, [...stack, id]);
    ids.push(id);
  };
  for (const e of EXTRAS) if (want.has(e.id)) visit(e.id, []);
  return { ids, unknown };
}

// What an installed extra still needs from the owner on this machine — today
// the Unity licence (per machine: a Personal licence is activated by a sign-in
// on the box that builds). [{ id, action, detail }]; never throws.
async function ownerActions(ids) {
  const out = [];
  if (ids.includes('unity') && probe('unity')) {
    const lic = await unity.unityLicenseStatus().catch((err) => ({ active: false, signedIn: false, error: err.message }));
    if (!lic.active) {
      out.push({
        id: 'unity',
        action: lic.signedIn
          ? 'Unity licence not active (signed in; bin/unity re-activates it on the next build, or Setup → Extras → Unity)'
          : `Unity licence missing: sign in once under Setup → Extras → Unity (or ${unity.UNITY_LOGIN})`,
        detail: lic.error || null,
      });
    }
  }
  return out;
}

function broadcastStatus() {
  broadcaster?.broadcast({ type: 'app:extras:status', extras: list() });
}

function setProgress(id, progress, label) {
  const run = running.get(id);
  if (!run) return;
  run.progress = progress;
  run.label = label;
  const persisted = readStatusFile();
  persisted[id] = { installing: true, progress, label, startedAt: run.startedAt };
  writeStatusFile(persisted);
  broadcastStatus();
}

function finish(id, error) {
  running.delete(id);
  const persisted = readStatusFile();
  persisted[id] = error
    ? { error, finishedAt: Date.now() }
    : { installedAt: Date.now() };
  writeStatusFile(persisted);
  broadcastStatus();
}

// Run a shell command, resolving on exit 0, rejecting with a stderr-tail error
// otherwise. onLine (optional) sees each output line for progress parsing.
// stdin is closed, so a prompt nothing will answer fails instead of hanging.
// The command runs in its own process group and a timeout signals the whole
// group: killing bash alone would leave a sudo'd apt holding the dpkg lock.
function sh(command, { timeout = 1800000, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], {
      env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let tail = '';
    const eat = (d) => {
      const s = d.toString();
      tail = (tail + s).slice(-1200);
      if (onLine) s.split('\n').forEach((l) => l.trim() && onLine(l.trim()));
    };
    child.stdout.on('data', eat);
    child.stderr.on('data', eat);
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch {} };
    const timer = setTimeout(() => {
      killGroup('SIGTERM'); // sudo relays it to apt, which releases its lock
      setTimeout(() => killGroup('SIGKILL'), 10000).unref();
      reject(new Error('timed out: ' + command.slice(0, 80)));
    }, timeout);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`exit ${code}: ${tail.trim().slice(-600)}`));
    });
  });
}

// --- apt: the one way an extra installs Debian packages ---

// sudo resets the environment, so the variables go through env. Without them
// Ubuntu's needrestart (an apt post-invoke hook) asks which services to
// restart and waits forever; suspended, it neither asks nor restarts anything
// (this server included). Conffile questions keep the local file. A lock held
// by unattended-upgrades is waited for, visibly, up to the lock timeout.
const APT_LOCK_TIMEOUT_S = 900;
const APT = 'sudo -n env DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 apt-get'
  + ` -o DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_S}`
  + ' -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold';

// apt's lock-wait line → "<process> (pid <n>)", else null.
function aptLockHolder(line) {
  const m = String(line || '').match(/Could not get lock .*held by process (\d+) \(([^)]+)\)/);
  return m ? `${m[2]} (pid ${m[1]})` : null;
}

async function aptInstall(id, progress, pkgs) {
  let label;
  const onLine = (line) => {
    const holder = aptLockHolder(line);
    if (holder) setProgress(id, progress, `${label} — waiting for the apt lock held by ${holder}`);
  };
  label = 'updating package lists';
  setProgress(id, progress, label);
  await sh(`${APT} update`, { onLine });
  label = `installing ${pkgs.join(', ')}`;
  setProgress(id, progress, label);
  await sh(`${APT} install -y ${pkgs.join(' ')}`, { onLine });
}

// --- Installers (phase-based progress) ---

async function installFfmpeg(id) {
  await aptInstall(id, 10, ['ffmpeg']);
  setProgress(id, 95, 'verifying');
  if (!onPath('ffmpeg') || !onPath('ffprobe')) throw new Error('install finished but ffmpeg/ffprobe not on PATH');
  try { require('./env-detect').invalidate(); } catch {}
}

async function installMusicMl(id) {
  const pip = path.join(ML_VENV, 'bin', 'pip');
  const user = process.env.USER || process.env.LOGNAME || 'root';

  setProgress(id, 2, 'creating /opt/vistaclair-ml');
  await sh(`sudo -n mkdir -p ${ML_BIN} ${ML_HF_CACHE} && sudo -n chown -R ${user}: ${ML_ROOT}`);

  if (!fs.existsSync(path.join(ML_VENV, 'bin', 'python'))) {
    setProgress(id, 5, 'creating Python venv');
    if (!onPath('python3')) await aptInstall(id, 5, ['python3', 'python3-venv']);
    try {
      await sh(`python3 -m venv ${ML_VENV}`);
    } catch (e) {
      // Debian/Ubuntu ship python3 without venv — install it and retry once.
      if (/ensurepip|venv/.test(e.message)) {
        await aptInstall(id, 6, ['python3-venv']);
        await sh(`python3 -m venv ${ML_VENV}`);
      } else throw e;
    }
  }

  // Coarse in-phase progress from pip's per-package "Collecting"/"Installing" lines.
  let pipTick = 0;
  const pipProgress = (base, span, label) => (line) => {
    if (/^(Collecting|Downloading|Installing collected)/.test(line)) {
      pipTick = Math.min(pipTick + 1, 30);
      setProgress(id, Math.round(base + (span * pipTick) / 30), label);
    }
  };

  setProgress(id, 10, 'installing PyTorch (CPU) — the big one, ~1.5 GB');
  pipTick = 0;
  await sh(`${pip} install --index-url https://download.pytorch.org/whl/cpu torch`, { onLine: pipProgress(10, 35, 'installing PyTorch (CPU)') });

  setProgress(id, 48, 'installing transformers, librosa, soundfile');
  pipTick = 0;
  await sh(`${pip} install transformers scipy librosa soundfile accelerate`, { onLine: pipProgress(48, 22, 'installing Python deps') });

  setProgress(id, 72, 'installing CLI wrappers');
  for (const bin of ['musicgen', 'beatgrid']) {
    fs.copyFileSync(path.join(WRAPPER_SRC, bin), path.join(ML_BIN, bin));
    fs.chmodSync(path.join(ML_BIN, bin), 0o755);
  }

  // Warm-up generation forces the ~2.2 GB HF model download now, so the user's
  // first real generation isn't a surprise multi-GB download.
  setProgress(id, 75, 'downloading MusicGen model (~2.2 GB) + test generation');
  const warmOut = path.join(ML_ROOT, '.warmup.wav');
  await sh(`${path.join(ML_BIN, 'musicgen')} --prompt "warmup" --duration 2 --out ${warmOut}`, { timeout: 3600000 });
  try { fs.unlinkSync(warmOut); } catch {}

  setProgress(id, 98, 'verifying');
  if (!probe('music-ml')) throw new Error('install finished but verification probe failed');
}

async function installAndroidBuild(id) {
  const user = process.env.USER || process.env.LOGNAME || 'root';

  setProgress(id, 2, `creating ${ANDROID_ROOT}`);
  await sh(`sudo -n mkdir -p ${ANDROID_SDK} ${ANDROID_BIN} && sudo -n chown -R ${user}: ${ANDROID_ROOT}`);

  // OpenJDK 17: AGP 8.2 requires exactly 17.
  if (!androidJavaHome()) await aptInstall(id, 8, ['openjdk-17-jdk-headless', 'unzip', 'curl']);
  const javaHome = androidJavaHome();
  if (!javaHome) throw new Error('installed openjdk-17 but no java-17-openjdk* under /usr/lib/jvm');

  const sdkm = path.join(ANDROID_SDK, 'cmdline-tools', 'latest', 'bin', 'sdkmanager');
  if (!fs.existsSync(sdkm)) {
    setProgress(id, 25, 'downloading Android command-line tools');
    const zip = `/tmp/vc-cmdline-tools-${CMDLINE_TOOLS}.zip`;
    await sh(`curl -fsSL -o ${zip} https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip`);
    setProgress(id, 38, 'unpacking command-line tools');
    // The archive unpacks as cmdline-tools/; sdkmanager insists on living at
    // <sdk>/cmdline-tools/latest/.
    await sh(`rm -rf /tmp/vc-ct && mkdir -p /tmp/vc-ct && unzip -q ${zip} -d /tmp/vc-ct`
      + ` && mkdir -p ${path.join(ANDROID_SDK, 'cmdline-tools')}`
      + ` && rm -rf ${path.join(ANDROID_SDK, 'cmdline-tools', 'latest')}`
      + ` && mv /tmp/vc-ct/cmdline-tools ${path.join(ANDROID_SDK, 'cmdline-tools', 'latest')}`
      + ` && rm -rf /tmp/vc-ct ${zip}`);
  }

  const env = `JAVA_HOME=${javaHome} ANDROID_HOME=${ANDROID_SDK} ANDROID_SDK_ROOT=${ANDROID_SDK} PATH=${javaHome}/bin:$PATH`;
  setProgress(id, 50, 'accepting SDK licences');
  await sh(`${env} yes 2>/dev/null | ${env} ${sdkm} --sdk_root=${ANDROID_SDK} --licenses >/dev/null`);

  setProgress(id, 65, 'installing platform-tools (adb)');
  await sh(`${env} ${sdkm} --sdk_root=${ANDROID_SDK} "platform-tools" >/dev/null`);

  setProgress(id, 88, 'writing android-env');
  // The one file apps source. Keeping the resolution here means an app's build
  // wrapper stays machine-independent.
  fs.writeFileSync(ANDROID_ENV, [
    '#!/bin/sh',
    '# Written by vistaclair platform-extras (android-build). Source, do not run.',
    `JAVA_HOME=${javaHome}`,
    `ANDROID_HOME=${ANDROID_SDK}`,
    `ANDROID_SDK_ROOT=${ANDROID_SDK}`,
    'export JAVA_HOME ANDROID_HOME ANDROID_SDK_ROOT',
    `PATH="${javaHome}/bin:${ANDROID_SDK}/platform-tools:${ANDROID_SDK}/cmdline-tools/latest/bin:$PATH"`,
    'export PATH',
    '',
  ].join('\n'));
  fs.chmodSync(ANDROID_ENV, 0o755);

  setProgress(id, 98, 'verifying');
  if (!probe('android-build')) throw new Error('install finished but verification probe failed');
}

// --- Blender: the three files apps meet (pure, so tests never touch /opt) ---

// bin/blender — the one executable apps run. Pins the version and moves user
// config/scripts/add-ons into the install root.
function renderBlenderWrapper(ver) {
  return [
    '#!/bin/sh',
    '# Written by vistaclair platform-extras (blender). The blender apps run.',
    '# VC_BLENDER_VERSION selects another version fetched with bin/blender-fetch.',
    `ROOT=${BLENDER_ROOT}`,
    `VER="\${VC_BLENDER_VERSION:-${ver}}"`,
    'if [ ! -x "$ROOT/versions/$VER/blender" ]; then',
    '  echo "blender $VER is not installed — run $ROOT/bin/blender-fetch $VER" >&2',
    '  exit 127',
    'fi',
    'BLENDER_USER_RESOURCES="$ROOT/config/$VER"',
    'export BLENDER_USER_RESOURCES',
    'mkdir -p "$BLENDER_USER_RESOURCES"',
    'exec "$ROOT/versions/$VER/blender" "$@"',
    '',
  ].join('\n');
}

// bin/blender-env — sourced, like android-env. The bundled Python is globbed at
// source time: its minor version belongs to the Blender release, not to us.
function renderBlenderEnv(ver) {
  return [
    '#!/bin/sh',
    '# Written by vistaclair platform-extras (blender). Source, do not run.',
    `VC_BLENDER_ROOT=${BLENDER_ROOT}`,
    'VC_BLENDER="$VC_BLENDER_ROOT/bin/blender"',
    `VC_BLENDER_VERSION="\${VC_BLENDER_VERSION:-${ver}}"`,
    '_vc_mm=$(echo "$VC_BLENDER_VERSION" | cut -d. -f1,2)',
    'VC_BLENDER_PYTHON=',
    'for _vc_py in "$VC_BLENDER_ROOT/versions/$VC_BLENDER_VERSION/$_vc_mm/python/bin/"python3*; do',
    '  [ -x "$_vc_py" ] && { VC_BLENDER_PYTHON="$_vc_py"; break; }',
    'done',
    'unset _vc_mm _vc_py',
    'export VC_BLENDER_ROOT VC_BLENDER VC_BLENDER_VERSION VC_BLENDER_PYTHON',
    '',
  ].join('\n');
}

// bin/blender-fetch <ver> — the one download path, used by the installer for the
// pinned version too. Verifies against the release's sha256 list and unpacks
// into a .part directory renamed at the end, so an interrupted fetch never
// leaves a half tree that looks installed. The download sits under the root
// (not /tmp, often a small tmpfs).
function renderBlenderFetch() {
  return [
    '#!/bin/sh',
    '# Written by vistaclair platform-extras (blender). Usage: blender-fetch <version>',
    'set -eu',
    `ROOT=${BLENDER_ROOT}`,
    'VER="${1:?usage: blender-fetch <version>, e.g. 5.2.2}"',
    'case "$VER" in *[!0-9.]*) echo "bad version: $VER" >&2; exit 2 ;; esac',
    'DEST="$ROOT/versions/$VER"',
    'if [ -x "$DEST/blender" ]; then echo "FETCH present $DEST"; exit 0; fi',
    'MM=$(echo "$VER" | cut -d. -f1,2)',
    'TAR="blender-$VER-linux-x64.tar.xz"',
    'SUMS="blender-$VER.sha256"',
    'URL="https://download.blender.org/release/Blender$MM"',
    'mkdir -p "$ROOT/versions"',
    'TMP=$(mktemp -d "$ROOT/.fetch.XXXXXX")',
    'trap \'rm -rf "$TMP" "$DEST.part"\' EXIT',
    'echo "FETCH downloading $TAR"',
    'curl -fsSL -o "$TMP/$TAR" "$URL/$TAR"',
    'curl -fsSL -o "$TMP/$SUMS" "$URL/$SUMS"',
    'echo "FETCH verifying"',
    '(cd "$TMP" && grep -F "$TAR" "$SUMS" | sha256sum -c -)',
    'echo "FETCH unpacking"',
    'rm -rf "$DEST.part" && mkdir -p "$DEST.part"',
    'tar -xJf "$TMP/$TAR" --strip-components=1 -C "$DEST.part"',
    'rm -rf "$DEST" && mv "$DEST.part" "$DEST"',
    'echo "FETCH done $DEST"',
    '',
  ].join('\n');
}

// Read blender-probe.py's marker lines. An engine the output never mentions
// (Blender crashed before reaching it) counts as failed.
const PROBE_ENGINES = { BLENDER_WORKBENCH: 'workbench', BLENDER_EEVEE: 'eevee', CYCLES: 'cycles' };
function parseProbeLines(text) {
  const out = { version: null, python: null, engines: { workbench: false, eevee: false, cycles: false } };
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^PROBE (\S+) (.*)$/);
    if (!m) continue;
    if (m[1] === 'version') out.version = m[2].trim();
    else if (m[1] === 'python') out.python = m[2].trim();
    else if (PROBE_ENGINES[m[1]]) out.engines[PROBE_ENGINES[m[1]]] = /^ok\b/.test(m[2]);
  }
  return out;
}

function missingDebs(pkgs) {
  return pkgs.filter((p) => {
    try { execFileSync('dpkg', ['-s', p], { stdio: 'ignore', timeout: 5000 }); return false; } catch { return true; }
  });
}

async function installBlender(id) {
  const user = process.env.USER || process.env.LOGNAME || 'root';

  setProgress(id, 2, `creating ${BLENDER_ROOT}`);
  await sh(`sudo -n mkdir -p ${BLENDER_VERSIONS} ${path.dirname(BLENDER_BIN)} && sudo -n chown -R ${user}: ${BLENDER_ROOT}`);

  const missing = missingDebs(BLENDER_DEBS);
  if (missing.length) await aptInstall(id, 6, missing);

  setProgress(id, 12, 'writing bin/blender, blender-env, blender-fetch');
  for (const [file, body] of [[BLENDER_BIN, renderBlenderWrapper(BLENDER_VERSION)],
    [BLENDER_ENV, renderBlenderEnv(BLENDER_VERSION)], [BLENDER_FETCH, renderBlenderFetch()]]) {
    fs.writeFileSync(file, body);
    fs.chmodSync(file, 0o755);
  }

  if (!isExecutable(path.join(BLENDER_VERSIONS, BLENDER_VERSION, 'blender'))) {
    setProgress(id, 15, `downloading Blender ${BLENDER_VERSION} (~385 MB)`);
    const phase = { verifying: [55, 'verifying checksum'], unpacking: [65, 'unpacking (~1 GB)'] };
    await sh(`${BLENDER_FETCH} ${BLENDER_VERSION}`, {
      onLine: (line) => {
        const hit = phase[(line.match(/^FETCH (\w+)/) || [])[1]];
        if (hit) setProgress(id, hit[0], hit[1]);
      },
    });
  }

  // Verify by rendering, with no display: the case every app runs in. The exit
  // code is not the verdict (a GL crash in one engine exits non-zero) — the
  // marker lines are.
  setProgress(id, 85, 'test-rendering with Workbench, Cycles and Eevee (no display)');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-blender-probe-'));
  const log = path.join(outDir, 'probe.log');
  let caps;
  try {
    await sh(`env -u DISPLAY -u WAYLAND_DISPLAY ${BLENDER_BIN} -b --factory-startup -noaudio`
      + ` --python ${BLENDER_PROBE} -- ${outDir} > ${log} 2>&1; true`, { timeout: 900000 });
    const text = fs.readFileSync(log, 'utf-8');
    caps = parseProbeLines(text);
    const tail = text.trim().slice(-600);
    if (!caps.version) throw new Error(`blender did not start: ${tail}`);
    if (!caps.engines.workbench) throw new Error(`blender started but cannot render headless (Workbench failed): ${tail}`);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.writeFileSync(BLENDER_CAPS, JSON.stringify({ ...caps, headless: true, checkedAt: new Date().toISOString() }, null, 2) + '\n');

  setProgress(id, 98, 'verifying');
  if (!probe('blender')) throw new Error('install finished but verification probe failed');
}

// --- Rust: the one file apps meet, and the test-build verdict (pure) ---

// bin/rust-env — sourced, like android-env. Build output stays per crate
// (<crate>/target inside the app): an inherited CARGO_TARGET_DIR would mix
// every app's artifacts in one directory.
function renderRustEnv() {
  return [
    '#!/bin/sh',
    '# Written by vistaclair platform-extras (rust). Source, do not run.',
    `VC_RUST_ROOT=${RUST_ROOT}`,
    'RUSTUP_HOME="$VC_RUST_ROOT/rustup"',
    'CARGO_HOME="$VC_RUST_ROOT/cargo"',
    'PATH="$CARGO_HOME/bin:$PATH"',
    'export VC_RUST_ROOT RUSTUP_HOME CARGO_HOME PATH',
    'unset CARGO_TARGET_DIR',
    '',
  ].join('\n');
}

// The Android target's rustlib dir and the cargo-ndk binary: what installRust
// adds beyond the bootstrap, and what probe('rust') requires.
function rustAndroidInstalled() {
  try {
    const tc = fs.readdirSync(path.join(RUSTUP_HOME, 'toolchains')).find((d) => d.startsWith(`${RUST_VERSION}-`));
    return !!tc && fs.existsSync(path.join(RUSTUP_HOME, 'toolchains', tc, 'lib', 'rustlib', RUST_ANDROID_TARGET, 'lib'))
      && isExecutable(path.join(CARGO_HOME, 'bin', 'cargo-ndk'));
  } catch { return false; }
}

// The NDK the android cdylib probe links with: the highest version under
// <sdk>/ndk (cargo-ndk works with any; the app picks its own at build time).
function pickAndroidNdk(names) {
  const key = (n) => String(n).split('.').map((x) => parseInt(x, 10) || 0);
  const sorted = (names || []).filter((n) => /^\d+(\.\d+)*$/.test(n)).sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) if ((ka[i] || 0) !== (kb[i] || 0)) return (ka[i] || 0) - (kb[i] || 0);
    return 0;
  });
  return sorted.length ? sorted[sorted.length - 1] : null;
}

// Read rust-probe.sh's marker lines. A check the output never mentions (the
// script died before reaching it) counts as failed.
const RUST_CHECKS = ['native', 'pyo3', 'napi', 'wasm', 'android_target', 'cargo_ndk', 'android_cdylib'];
function parseRustProbeLines(text) {
  const out = { rustc: null, cargo: null, rustup: null, checks: Object.fromEntries(RUST_CHECKS.map((c) => [c, false])) };
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^PROBE (\S+) (.*)$/);
    if (!m) continue;
    if (m[1] === 'rustc' || m[1] === 'cargo' || m[1] === 'rustup') out[m[1]] = m[2].trim();
    else if (RUST_CHECKS.includes(m[1])) out.checks[m[1]] = /^ok\b/.test(m[2]);
  }
  return out;
}

async function installRust(id) {
  const user = process.env.USER || process.env.LOGNAME || 'root';
  const env = `RUSTUP_HOME=${RUSTUP_HOME} CARGO_HOME=${CARGO_HOME}`;
  const rustup = path.join(CARGO_HOME, 'bin', 'rustup');

  setProgress(id, 2, `creating ${RUST_ROOT}`);
  await sh(`sudo -n mkdir -p ${RUSTUP_HOME} ${CARGO_HOME} ${path.dirname(RUST_ENV)} && sudo -n chown -R ${user}: ${RUST_ROOT}`);

  const missing = missingDebs(RUST_DEBS);
  if (missing.length) await aptInstall(id, 5, missing);

  if (!isExecutable(rustup)) {
    // The download sits under the root (not /tmp, often a small tmpfs) and is
    // checked against the release's sha256 before it runs. --no-modify-path:
    // ~/.profile and the shell rc files are never touched; the skip-path-check
    // lets it install beside a distro rustc on PATH, which apps never see.
    setProgress(id, 10, `downloading rustup ${RUSTUP_VERSION}`);
    const fetchDir = path.join(RUST_ROOT, '.fetch');
    await sh(`rm -rf ${fetchDir} && mkdir -p ${fetchDir} && cd ${fetchDir}`
      + ` && curl -fsSL -o rustup-init ${RUSTUP_INIT_URL}/rustup-init`
      + ` && curl -fsSL -o rustup-init.sha256 ${RUSTUP_INIT_URL}/rustup-init.sha256`
      + ' && sha256sum -c rustup-init.sha256 && chmod +x rustup-init'
      + ` && ${env} RUSTUP_INIT_SKIP_PATH_CHECK=yes ./rustup-init -y --no-modify-path --profile minimal --default-toolchain none`
      + ` && cd / && rm -rf ${fetchDir}`);
  }

  // An app's `rustup toolchain install` would otherwise replace the pinned
  // rustup with the latest the first time a newer one exists.
  await sh(`${env} ${rustup} set auto-self-update disable`);

  // Separate from rustup-init so a resumed install (rustup present, toolchain
  // half-fetched) lands here too. Idempotent.
  setProgress(id, 20, `installing Rust ${RUST_VERSION}`);
  // Without a tty rustup prints no per-component lines, only these phases.
  await sh(`${env} ${rustup} toolchain install ${RUST_VERSION} --profile minimal -c clippy -c rustfmt -t wasm32-unknown-unknown`
    + ` && ${env} ${rustup} default ${RUST_VERSION}`, {
    onLine: (line) => {
      const n = (line.match(/^info: downloading (\d+) components/) || [])[1];
      if (n) setProgress(id, 25, `downloading ${n} Rust ${RUST_VERSION} components (~150 MB)`);
      else if (/ installed - rustc /.test(line)) setProgress(id, 65, `Rust ${RUST_VERSION} installed`);
    },
  });

  // The Android pieces: apps load a Rust cdylib on a device (godot, unity).
  // Idempotent: the target add is a no-op when present, cargo-ndk is only
  // built when the pinned version is not already there.
  setProgress(id, 62, `adding the ${RUST_ANDROID_TARGET} target and cargo-ndk ${CARGO_NDK_VERSION}`);
  await sh(`export ${env} PATH=${CARGO_HOME}/bin:$PATH`
    + ` && rustup target add --toolchain ${RUST_VERSION} ${RUST_ANDROID_TARGET}`
    + ` && { cargo ndk --version 2>/dev/null | grep -qF ' ${CARGO_NDK_VERSION}'`
    + ` || cargo install --locked --root ${CARGO_HOME} cargo-ndk@${CARGO_NDK_VERSION}; }`, { timeout: 1800000 });

  setProgress(id, 70, 'writing bin/rust-env');
  fs.writeFileSync(RUST_ENV, renderRustEnv());
  fs.chmodSync(RUST_ENV, 0o755);

  // Verify by building, the way apps will: rust-env sourced, a PyO3 module
  // imported from a venv, a napi addon loaded by this node, a wasm module. The
  // exit code is not the verdict — the marker lines are.
  setProgress(id, 75, 'test builds: native, PyO3, napi-rs, wasm, Android cdylib (fetches a few crates)');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-rust-probe-'));
  const log = path.join(workDir, 'probe.log');
  let caps;
  try {
    // The NDK is recorded, not required: android-build may come later.
    let ndkName = null;
    try { ndkName = pickAndroidNdk(fs.readdirSync(path.join(ANDROID_SDK, 'ndk'))); } catch {}
    const ndk = ndkName ? path.join(ANDROID_SDK, 'ndk', ndkName) : null;
    await sh(`. ${RUST_ENV} && VC_NODE=${process.execPath} VC_ANDROID_TARGET=${RUST_ANDROID_TARGET} VC_CARGO_NDK_VERSION=${CARGO_NDK_VERSION}${ndk ? ` VC_ANDROID_NDK=${ndk}` : ''} bash ${RUST_PROBE} ${workDir}/w > ${log} 2>&1; true`, { timeout: 1200000 });
    const text = fs.readFileSync(log, 'utf-8');
    caps = parseRustProbeLines(text);
    caps.android = { target: RUST_ANDROID_TARGET, cargoNdk: CARGO_NDK_VERSION, ndk: ndkName };
    const tail = text.trim().slice(-600);
    if (!caps.rustc) throw new Error(`rustc did not run: ${tail}`);
    if (!caps.checks.native) throw new Error(`rustc runs but cannot build and link a binary: ${tail}`);
    if (!caps.checks.android_target || !caps.checks.cargo_ndk) throw new Error(`the ${RUST_ANDROID_TARGET} target or cargo-ndk is not usable: ${tail}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  fs.writeFileSync(RUST_CAPS, JSON.stringify({ ...caps, checkedAt: new Date().toISOString() }, null, 2) + '\n');

  setProgress(id, 98, 'verifying');
  if (!probe('rust')) throw new Error('install finished but verification probe failed');
}

// The godot installer lives in its own module and gets the helpers it shares.
function installGodot(id) {
  return godot.installGodot(id, {
    setProgress, sh, aptInstall, missingDebs, androidJavaHome, probe,
    ANDROID_SDK, ANDROID_ENV, RUSTUP_HOME, CARGO_HOME, RUST_ENV, RUST_VERSION, RUST_ANDROID_TARGET, CARGO_NDK_VERSION,
  });
}

// The unity installer likewise; reprobeUnity re-runs its probe alone (after the
// owner signs in) and rewrites capabilities.json.
function installUnity(id) {
  return unity.installUnity(id, { setProgress, sh, aptInstall, missingDebs, probe, RUST_ENV });
}
function reprobeUnity() {
  return unity.runUnityProbe({ sh, probe, RUST_ENV });
}

const INSTALLERS = { ffmpeg: installFfmpeg, 'music-ml': installMusicMl, 'android-build': installAndroidBuild, blender: installBlender, rust: installRust, godot: installGodot, unity: installUnity };

function install(id) {
  const extra = EXTRAS.find((e) => e.id === id);
  if (!extra) throw new Error(`unknown extra "${id}"`);
  if (running.has(id)) return { ok: true, alreadyRunning: true };
  if (probe(id)) return { ok: true, alreadyInstalled: true };
  if (extra.needsSudo && !hasSudo()) {
    throw new Error('Passwordless sudo is required to install this component. Grant it to the user running vistaclair, or install manually.');
  }
  running.set(id, { progress: 0, label: 'starting', startedAt: Date.now() });
  setProgress(id, 1, 'starting');
  INSTALLERS[id](id).then(
    () => {
      console.log(`[extras] ${id} installed`);
      finish(id, null);
      if (id === 'unity') unityLicense.ensureCheckJob();
    },
    (err) => {
      console.warn(`[extras] ${id} install failed: ${err.message}`);
      finish(id, err.message);
    }
  );
  return { ok: true, started: true };
}

function init(options) {
  appsDir = options.appsDir;
  broadcaster = options.broadcaster;
  unityLicense.init({ appsDir, onChange: broadcastStatus, secretStore: options.secretStore || null, installed: () => probe('unity') });
  // Installs don't survive a server restart — mark stale records interrupted.
  const persisted = readStatusFile();
  let dirty = false;
  for (const [id, rec] of Object.entries(persisted)) {
    if (rec.installing) {
      persisted[id] = { error: 'interrupted by server restart — click Install to resume', finishedAt: Date.now() };
      dirty = true;
    }
  }
  if (dirty) writeStatusFile(persisted);
}

module.exports = {
  init, list, install, probe, TOOLCHAINS, extrasForToolchains, ownerActions, ML_BIN, ANDROID_ROOT, ANDROID_SDK, ANDROID_BIN, ANDROID_ENV,
  BLENDER_ROOT, BLENDER_VERSION, BLENDER_VERSIONS, BLENDER_BIN, BLENDER_ENV, BLENDER_FETCH, BLENDER_CAPS,
  renderBlenderWrapper, renderBlenderEnv, renderBlenderFetch, parseProbeLines, aptLockHolder,
  RUST_ROOT, RUST_VERSION, RUSTUP_HOME, CARGO_HOME, RUST_ENV, RUST_CAPS, RUST_ANDROID_TARGET, CARGO_NDK_VERSION, renderRustEnv, parseRustProbeLines, pickAndroidNdk,
  ...Object.fromEntries(Object.entries(godot).filter(([k]) => k !== 'installGodot')),
  ...Object.fromEntries(Object.entries(unity).filter(([k]) => k !== 'installUnity' && k !== 'runUnityProbe')),
  reprobeUnity,
};
