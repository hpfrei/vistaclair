# Platform extras & toolchains (`platform-extras.js`)

Big optional components live in `EXTRAS`, installed from Apps → Setup → Extras
with persisted, broadcast progress (a restart marks a stale install
`interrupted`). Each has a cheap `probe()`, a fixed root under `/opt`, and
exported path constants consumers join off — never a PATH lookup: `ffmpeg`,
`music-ml` (`/opt/vistaclair-ml`, `ML_BIN`), `android-build`
(`/opt/vistaclair-android`, `ANDROID_SDK` / `ANDROID_ENV`), `blender`
(`/opt/vistaclair-blender`, `BLENDER_BIN` / `BLENDER_ENV` / `BLENDER_FETCH` /
`BLENDER_CAPS`, `BLENDER_VERSIONS/<BLENDER_VERSION>`), `rust`
(`/opt/vistaclair-rust`, `RUSTUP_HOME` / `CARGO_HOME` / `RUST_ENV` / `RUST_CAPS`),
`godot` (`/opt/vistaclair-godot`, `GODOT_BIN` / `GODOT_ENV` / `GODOT_CAPS` /
`GODOT_EXE` / `GODOT_TEMPLATES` / `GODOT_VENDORS`; own module
`platform-extras-godot.js`, re-exported by `platform-extras.js`), `unity`
(`/opt/vistaclair-unity`, `UNITY_BIN` / `UNITY_ENV` / `UNITY_LICENSE` / `UNITY_CAPS`; own module
`platform-extras-unity.js`, all of it in `docs/extras-unity.md`).

Debian packages go through `aptInstall()` only: `DEBIAN_FRONTEND=noninteractive`
and `NEEDRESTART_SUSPEND=1` passed through `sudo env` (needrestart otherwise
waits on a "restart which services?" question), confold for conffiles, and
`DPkg::Lock::Timeout` with the lock holder in the progress label
(`aptLockHolder`). `sh()` closes stdin and on timeout signals the whole process
group, so no prompt blocks and no orphaned apt keeps the dpkg lock.

`android-build` is bootstrap only — OpenJDK 17 (resolved from
`/usr/lib/jvm/java-17-openjdk*`, never PATH), cmdline-tools, licences,
platform-tools, and the `bin/android-env` an app sources. SDK platform and
build-tools belong to the app, next to the gradle files that dictate them —
except Godot's: the `godot` install adds `platforms;android-36`,
`build-tools;36.1.0` and `ndk;29.0.14206865` (`GODOT_ANDROID_SDK_PACKAGES`),
which Godot's own gradle build template pins, not an app.

`blender` is the pinned LTS (`BLENDER_VERSION`) from blender.org:
`bin/blender-fetch <ver>` downloads, sha256-verifies and unpacks a release (the
installer uses it too); `bin/blender` pins the version (`VC_BLENDER_VERSION`)
and sets `BLENDER_USER_RESOURCES` to `config/<ver>`; `bin/blender-env` exports
`VC_BLENDER*`. The install is verified by rendering: `blender-probe.py` runs
Workbench, Cycles and Eevee with no display, `parseProbeLines` reads its
`PROBE` lines, and the result is `capabilities.json` (Workbench required, the
others recorded). The script bodies are pure `renderBlender*()` functions
(`test/platform-extras.test.js`).

`rust` is bootstrap plus the Android pieces. A sha256-verified, pinned
`rustup-init` (`RUSTUP_VERSION`) installs the pinned default `RUST_VERSION`
(minimal profile, clippy, rustfmt, `wasm32-unknown-unknown`). `installRust`
also adds the `RUST_ANDROID_TARGET` (`aarch64-linux-android`) target and
`cargo-ndk` (`CARGO_NDK_VERSION`, into `CARGO_HOME/bin`) — the one place they
are installed; the `godot` and `unity` extras only use them, and `probe('rust')`
requires both. It runs with
`--no-modify-path`, so `~/.cargo` and the rc files are never touched. rustup's
`auto-self-update` is disabled, so an app's `rustup toolchain install` never
replaces the pinned rustup.
`bin/rust-env` (`renderRustEnv`) exports `RUSTUP_HOME`, `CARGO_HOME` and `PATH`,
and unsets `CARGO_TARGET_DIR`. Every app shares the one crates.io cache, while
build output stays in the crate's own `target/`. An app's
`rust-toolchain.toml` pulls other versions into the same `rustup/`. Crates,
maturin and napi/wasm tooling belong to the app. The install is verified by
building: `rust-probe.sh` builds a native binary and checks the Android target
and cargo-ndk (required), builds PyO3, napi-rs and wasm modules (recorded), and
cross-builds a cdylib with `cargo ndk -t arm64-v8a` against the highest NDK
under `ANDROID_SDK/ndk` (`pickAndroidNdk`; recorded, `SKIP` without one — a
later `android-build` install does not re-run it). `parseRustProbeLines` turns
its `PROBE` lines into `capabilities.json` (`checks`, plus
`android: { target, cargoNdk, ndk }`). `listAppFiles` skips any directory holding a
`CACHEDIR.TAG` (every cargo `target/`), so build output never reaches snapshots
or a session's file list.

`godot` is the pinned `GODOT_VERSION` (4.7.2-stable), installed by
`renderGodotFetch()`: the official linux zip, the full export templates `.tpz`
and the godot_openxr_vendors `GODOT_VENDORS_VERSION` addon, each checked
against a pinned hash (`GODOT_DOWNLOADS`: sha512 from the release's
SHA512-SUMS.txt, the addon's GitHub asset sha256) in `dl/`, which a rerun
reuses. Unpacks go through `.part` + rename with a `dl/<file>.installed`
stamp; the binary is compared byte for byte with the zip's. Self-contained
mode (`._sc_`): settings, templates (`editor_data/export_templates/4.7.2.stable/`)
and caches live in `versions/<ver>/editor_data/`, which is never replaced.
`bin/godot` / `bin/godot-env` (`renderGodotWrapper` / `renderGodotEnv`) export
`VC_GODOT_ROOT`, `VC_GODOT_VERSION`, `VC_GODOT`, `VC_GODOT_VENDORS`. With
`android-build` present it installs the SDK pins above, generates a debug
keystore once (`keytool` of JDK 17) and upserts `java_sdk_path`,
`android_sdk_path` and `debug_keystore[_user|_pass]` into
`editor_settings-4.7.tres` (`renderGodotEditorSettings`). Release signing holds
no key: Godot reads `GODOT_ANDROID_KEYSTORE_RELEASE_PATH/_USER/_PASSWORD` itself
when the preset's `keystore/release*` fields are empty, the app fills them from
its secrets, and `godot-env` defines `vc_godot_release_signing <path> <alias>
<password>` to export them (it refuses an empty value or a missing keystore).
`renderGodotReadme()` writes `/opt/vistaclair-godot/README.md` with this. With
`rust` present the GDExtension checks run on the rust extra's target and
cargo-ndk; godot installs neither. The install is verified by exporting:
`godot-probe.sh` runs `--version` (required), a headless debug export to a
signed APK (required with `android-build`), a release export signed through
`vc_godot_release_signing` with a throwaway keystore (`android_release`,
recorded), the same debug export through the gradle template, and a gdext `GDEXT_VERSION` (`api-4-7`)
crate built for host and `aarch64-linux-android`, loaded headless and packed
into an APK (recorded); `parseGodotProbeLines` turns its `PROBE` lines into
`capabilities.json`.

An app advertises what it needs with `manifest.toolchains: ["android"|"blender"|"rust"|"godot"|"unity"]` —
documentation plus the app-row badge (`renderCardToolchains`), never a gate on
this host; the app's own script fails loudly when the extra is missing. The
key → extra map is each `EXTRAS` entry's `toolchain` (chip label `badge`),
exported as `TOOLCHAINS`, carried on `list()` rows for the badge, and resolved
by `extrasForToolchains(keys)` → `{ ids, unknown }` with `ids` in install
order: an extra follows the ones its `after` names (`rust` after
`android-build`, `godot` after both, `unity` after `rust`) — order only, never
an extra the app did not declare.

**On a slave**, publishing an app installs its missing toolchain extras there
(`docs/federation.md`, the `toolchains` step) through the slave's peer routes
`GET /api/peer/extras` and `POST /api/peer/extras/:id/install`, which call
`list()` / `install()` — the same install the slave's Setup → Extras shows
live. `ownerActions(ids)` names what an installed extra still needs from the
owner on that machine: today an inactive Unity licence (`unityLicenseStatus()`;
the slave's owner signs in once under its own Setup → Extras → Unity, which the
publish wizard links). `my-cams`
carries the `com.ipcam` Android firmware as a `git subtree` at
`my-cams/android/` and builds it with `bin/apk-build`. App-facing paths and
Blender 5 / Godot export recipes: the `toolchains` sidecar in `_api-reference.md`.
