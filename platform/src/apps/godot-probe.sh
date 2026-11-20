#!/usr/bin/env bash
# The godot extra's install-time proof (platform-extras-godot.js installGodot):
# export and build tiny projects the way an app will, into <workdir>.
#
#   VC_GODOT=<bin/godot> [VC_ANDROID_ENV=<android-env>] [VC_ANDROID_NDK=<ndk dir>]
#   [VC_APKSIGNER=<apksigner>] [VC_GODOT_ENV=<godot-env>] [VC_RUST_ENV=<rust-env>] [VC_GDEXT_VERSION=<x.y.z>]
#   bash godot-probe.sh <workdir>
#
# Prints one marker line per fact, which parseGodotProbeLines() reads:
#   PROBE version <godot --version>
#   PROBE <check> ok | PROBE <check> FAIL <last error line> | PROBE <check> SKIP <why>
# Checks: android_export (a GDScript project → signed debug APK, headless,
# no gradle), android_release (a release APK signed through the
# GODOT_ANDROID_KEYSTORE_RELEASE_* convention: godot-env's
# vc_godot_release_signing with a throwaway keystore; recorded, not required),
# android_gradle (the same through Godot's gradle build template:
# the SDK pins), gdext_host / gdext_android (a godot-rust gdext crate builds
# for x86_64 and aarch64-linux-android), gdext_load (the host build loads in a
# headless run), gdext_export (the android build is packed into a signed APK).
# Each check runs on its own, so one failing does not hide the others; a check
# whose prerequisite is absent prints SKIP.
set -u
WORK="${1:?usage: godot-probe.sh <workdir>}"
GODOT="${VC_GODOT:?VC_GODOT must name bin/godot}"
GDEXT="${VC_GDEXT_VERSION:-0.5.5}"
mkdir -p "$WORK"
# Gradle's own cache stays inside the probe dir, so the probe leaves nothing in ~/.gradle.
# No daemon: it would outlive the probe (and its deleted cache dir).
export GRADLE_USER_HOME="$WORK/gradle-home"
mkdir -p "$GRADLE_USER_HOME" && echo 'org.gradle.daemon=false' > "$GRADLE_USER_HOME/gradle.properties"

say() { echo "PROBE $*"; }

# check <name> <fn>: run fn in a subshell, report ok or the last error line.
# Not `if out=$(…)`: inside an if condition bash ignores the subshell's set -e.
check() {
  local name=$1 out rc
  out=$( ( set -e; "$2" ) 2>&1 ); rc=$?
  if [ "$rc" = 0 ]; then
    say "$name ok"
  else
    say "$name FAIL $(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | grep -iE 'error|fail|not|missing|cannot' | tail -n 1 | cut -c1-200)"
    printf '%s\n' "$out" | tail -n 40 | sed "s/^/  [$name] /"
  fi
}

skip() { say "$1 SKIP $2"; }

# project <dir> [main.gd body] — a minimal project with an Android preset.
project() {
  local d=$1 gradle=${2:-false}
  mkdir -p "$d"
  cat > "$d/project.godot" <<'EOF'
config_version=5

[application]
config/name="vc-godot-probe"
run/main_scene="res://main.tscn"

[rendering]
textures/vram_compression/import_etc2_astc=true
EOF
  cat > "$d/main.tscn" <<'EOF'
[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://main.gd" id="1"]

[node name="Main" type="Node"]
script = ExtResource("1")
EOF
  cat > "$d/main.gd" <<'EOF'
extends Node

func _ready() -> void:
	if ClassDB.class_exists("VcProbe"):
		var o = ClassDB.instantiate("VcProbe")
		print("GDEXT_ADD ", o.add(2, 3))
	print("PROBE_RUN done")
	get_tree().quit()
EOF
  cat > "$d/export_presets.cfg" <<EOF
[preset.0]

name="Android"
platform="Android"
runnable=true
export_filter="all_resources"
include_filter=""
exclude_filter=""
export_path="out/probe.apk"

[preset.0.options]

gradle_build/use_gradle_build=$gradle
architectures/armeabi-v7a=false
architectures/arm64-v8a=true
architectures/x86=false
architectures/x86_64=false
package/unique_name="org.vistaclair.godotprobe"
package/name="vc godot probe"
version/code=1
version/name="1.0"
EOF
}

# export_apk <dir> [godot args...] — import, then a headless debug export; the
# APK must verify.
export_apk() {
  local d=$1; shift
  mkdir -p "$d/out"
  "$GODOT" --headless --path "$d" --import >/dev/null 2>&1 || true
  "$GODOT" --headless --path "$d" "$@" --export-debug Android "$d/out/probe.apk" 2>&1 | tail -n 30
  [ -s "$d/out/probe.apk" ] || { echo "error: no APK written"; return 1; }
  "$APKSIGNER" verify "$d/out/probe.apk"
}

android_export() {
  local d="$WORK/android"
  project "$d" false
  export_apk "$d"
}

android_release() {
  local d="$WORK/release" ks="$WORK/release.keystore"
  project "$d" false
  mkdir -p "$d/out"
  keytool -genkeypair -keystore "$ks" -storepass vcprobepw -keypass vcprobepw -alias vcprobe \
    -keyalg RSA -keysize 2048 -validity 2 -dname "CN=vc godot release probe" -noprompt >/dev/null 2>&1
  # The same function an app calls (godot-env), then the headless release export.
  . "${VC_GODOT_ENV:?VC_GODOT_ENV must name bin/godot-env}"
  vc_godot_release_signing "$ks" vcprobe vcprobepw
  "$GODOT" --headless --path "$d" --import >/dev/null 2>&1 || true
  "$GODOT" --headless --path "$d" --export-release Android "$d/out/release.apk" 2>&1 | tail -n 30
  [ -s "$d/out/release.apk" ] || { echo "error: no release APK written"; return 1; }
  "$APKSIGNER" verify --print-certs "$d/out/release.apk" | grep -q 'CN=vc godot release probe' \
    || { echo "error: the release APK is not signed with the release keystore"; return 1; }
}

android_gradle() {
  local d="$WORK/gradle"
  project "$d" true
  # The flag unpacks android_source.zip into android/build/ before the export.
  export_apk "$d" --install-android-build-template
}

gdext_crate() {
  local c="$WORK/gdext"
  mkdir -p "$c/src"
  cat > "$c/Cargo.toml" <<EOF
[package]
name = "vc_gdext"
version = "0.0.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
godot = { version = "=$GDEXT", features = ["api-4-7"] }
EOF
  cat > "$c/src/lib.rs" <<'EOF'
use godot::prelude::*;

struct VcProbeExt;

#[gdextension]
unsafe impl ExtensionLibrary for VcProbeExt {}

#[derive(GodotClass)]
#[class(init, base = RefCounted)]
struct VcProbe {
    base: Base<RefCounted>,
}

#[godot_api]
impl VcProbe {
    #[func]
    fn add(&self, a: i64, b: i64) -> i64 {
        a + b
    }
}
EOF
  echo "$c"
}

gdext_host() {
  local c; c=$(gdext_crate)
  cargo build --release --quiet --manifest-path "$c/Cargo.toml"
  [ -s "$c/target/release/libvc_gdext.so" ]
}

gdext_android() {
  local c="$WORK/gdext"
  [ -d "$c" ] || c=$(gdext_crate)
  (cd "$c" && ANDROID_NDK_HOME="$VC_ANDROID_NDK" cargo ndk -t arm64-v8a build --release --quiet)
  [ -s "$c/target/aarch64-linux-android/release/libvc_gdext.so" ]
}

# gdext_project <dir> — the probe project with the extension wired in.
gdext_project() {
  local d=$1 c="$WORK/gdext"
  project "$d" false
  mkdir -p "$d/lib"
  [ -s "$c/target/release/libvc_gdext.so" ] && cp "$c/target/release/libvc_gdext.so" "$d/lib/libvc_gdext.linux.so"
  [ -s "$c/target/aarch64-linux-android/release/libvc_gdext.so" ] && cp "$c/target/aarch64-linux-android/release/libvc_gdext.so" "$d/lib/libvc_gdext.android.so"
  cat > "$d/vc_gdext.gdextension" <<'EOF'
[configuration]
entry_symbol = "gdext_rust_init"
compatibility_minimum = 4.7

[libraries]
linux.debug.x86_64 = "res://lib/libvc_gdext.linux.so"
linux.release.x86_64 = "res://lib/libvc_gdext.linux.so"
android.debug.arm64 = "res://lib/libvc_gdext.android.so"
android.release.arm64 = "res://lib/libvc_gdext.android.so"
EOF
}

gdext_load() {
  local d="$WORK/gdext-load" out
  gdext_project "$d"
  "$GODOT" --headless --path "$d" --import >/dev/null 2>&1 || true
  out=$("$GODOT" --headless --path "$d" 2>&1 | tail -n 30)
  printf '%s\n' "$out"
  printf '%s\n' "$out" | grep -q '^GDEXT_ADD 5$' || { echo "error: the extension did not load (no GDEXT_ADD 5)"; return 1; }
}

gdext_export() {
  local d="$WORK/gdext-apk"
  gdext_project "$d"
  export_apk "$d"
  unzip -l "$d/out/probe.apk" | grep -q 'lib/arm64-v8a/libvc_gdext.android.so' \
    || { echo "error: the APK does not carry lib/arm64-v8a/libvc_gdext.android.so"; return 1; }
}

say "version $("$GODOT" --headless --version 2>/dev/null | tail -n 1)"

if [ -n "${VC_ANDROID_ENV:-}" ] && [ -f "$VC_ANDROID_ENV" ]; then
  . "$VC_ANDROID_ENV"
  APKSIGNER="${VC_APKSIGNER:?VC_APKSIGNER must name build-tools apksigner}"
  check android_export android_export
  check android_gradle android_gradle
  # keytool comes from android-env's JAVA_HOME PATH.
  check android_release android_release
  HAVE_ANDROID=1
else
  skip android_export "android-build extra not installed"
  skip android_gradle "android-build extra not installed"
  skip android_release "android-build extra not installed"
  HAVE_ANDROID=
fi

if [ -n "${VC_RUST_ENV:-}" ] && [ -f "$VC_RUST_ENV" ]; then
  . "$VC_RUST_ENV"
  check gdext_host gdext_host
  check gdext_load gdext_load
  if [ -n "$HAVE_ANDROID" ] && [ -n "${VC_ANDROID_NDK:-}" ]; then
    check gdext_android gdext_android
    check gdext_export gdext_export
  else
    skip gdext_android "android-build extra not installed"
    skip gdext_export "android-build extra not installed"
  fi
else
  for c in gdext_host gdext_load gdext_android gdext_export; do skip "$c" "rust extra not installed"; done
fi
