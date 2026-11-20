#!/bin/bash
# The unity extra's install-time probe (runUnityProbe in platform-extras-unity.js).
# Usage: probe.sh <workdir>. Env: VC_UNITY_ENV (bin/unity-env), VC_PROBE_SRC
# (src/apps/unity), VC_PROBE_MANIFEST (upm/<ver>/manifest.json: the offline set),
# VC_UNITY_DEBUG_KEYSTORE, VC_ANDROID_API, VC_RUST_ENV (optional: the rust extra).
# Speaks `PROBE <check> ok|FAIL|SKIP [detail]` lines; the exit code is no verdict.
set -u
W="$1"
mkdir -p "$W/out"
. "$VC_UNITY_ENV"
say() { echo "PROBE $*"; }
J="$VC_UNITY_ANDROID/OpenJDK"
BT="$VC_UNITY_ANDROID/SDK/build-tools/36.0.0"

# --- version (required) and licence (recorded)
v=$("$VC_UNITY" -version 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+[abfp][0-9]+' | tail -1)
say version "$v"
lic=$("$VC_UNITY_LICENSE" status 2>/dev/null | tr -d '\n')
say license_json "$lic"
licensed=0
if "$VC_UNITY_LICENSE" ensure; then licensed=1; say license ok; else say license FAIL no active Unity licence; fi

# --- the project: a fresh copy, manifest from the one package list
P="$W/project"
mkdir -p "$P/Packages" "$P/Assets/Plugins/Android/arm64-v8a" "$P/Assets/Plugins/x86_64"
cp -r "$VC_PROBE_SRC/probe/Assets/." "$P/Assets/"
cp "$VC_PROBE_MANIFEST" "$P/Packages/manifest.json"

# --- the Rust cdylib: host + aarch64-linux-android (cargo-ndk, the editor's own NDK)
if [ -n "${VC_RUST_ENV:-}" ] && [ -f "$VC_RUST_ENV" ]; then
  cp -r "$VC_PROBE_SRC/probe-rust" "$W/rust"
  if (. "$VC_RUST_ENV" && cd "$W/rust" && cargo build --release --locked) >"$W/rust-host.log" 2>&1 \
    && cp "$W/rust/target/release/libvc_probe.so" "$P/Assets/Plugins/x86_64/"; then
    say rust_host ok
  else say rust_host FAIL "$(tail -c 300 "$W/rust-host.log")"; fi
  if (. "$VC_RUST_ENV" && cd "$W/rust" && ANDROID_NDK_HOME="$VC_UNITY_ANDROID/NDK" \
      cargo ndk -t arm64-v8a -P "${VC_ANDROID_API:-29}" build --release --locked) >"$W/rust-android.log" 2>&1 \
    && cp "$W/rust/target/aarch64-linux-android/release/libvc_probe.so" "$P/Assets/Plugins/Android/arm64-v8a/"; then
    say rust_android ok
  else say rust_android FAIL "$(tail -c 300 "$W/rust-android.log")"; fi
else
  say rust_host SKIP no rust extra
  say rust_android SKIP no rust extra
fi

if [ $licensed = 0 ]; then
  say apk SKIP no active Unity licence
  exit 0
fi

# --- the packages come only from the offline set (file: tarballs + editor core
# packages): every editor run gets a fresh, empty UPM cache and a dead registry,
# so a package missing from the set fails the build; the first run (which
# resolves and imports them) also runs without any network when bwrap can.
# The APK builds keep the network for gradle's maven dependencies.
export UPM_CACHE_ROOT="$W/upm-cache" UPM_REGISTRY=http://127.0.0.1:9
mkdir -p "$UPM_CACHE_ROOT"
NONET=() offline="no registry, empty UPM cache"
if command -v bwrap >/dev/null && bwrap --dev-bind / / --unshare-net true 2>/dev/null; then
  NONET=(bwrap --dev-bind / / --unshare-net --) offline="no network, $offline"
fi

# --- the Unity build: niced, ≤ 4 IL2CPP jobs; a run that never reached the
# build method (a domain reload on first import) is retried once
export IL2CPP_JOBS="${IL2CPP_JOBS:-4}"
unity_build() { # unity_build <name> <apk>
  local log="$W/unity-$1.log" rc
  for attempt in 1 2; do
    : > "$W/out/$1.probe"
    VC_PROBE_OUT="$W/out/$1.probe" VC_PROBE_APK="$2" nice -n 10 "$VC_UNITY" -batchmode -nographics -quit \
      -projectPath "$P" -buildTarget Android -upmNoDefaultPackages -executeMethod VCProbeBuild.Build -logFile "$log"
    rc=$?
    grep -q '^\[VCProbe\] start' "$log" 2>/dev/null && break
    cp -f "$log" "$log.first" 2>/dev/null
  done
  return $rc
}
cert() { # the SHA-256 of an APK's signer, lowercase hex
  JAVA_HOME="$J" PATH="$J/bin:$PATH" "$BT/apksigner" verify --print-certs "$1" 2>/dev/null \
    | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | tr -d ': ' | tr 'A-F' 'a-f'
}
ks_cert() { # ks_cert <keystore> <storepass> <alias>
  "$J/bin/keytool" -list -v -keystore "$1" -storepass "$2" -alias "$3" 2>/dev/null \
    | sed -n 's/^[[:space:]]*SHA256: //p' | tr -d ': ' | tr 'A-F' 'a-f'
}

# The first run: package import, the Android target, Active Input Handling
# (VCProbeBuild.Prepare — these take effect only in the next editor run). The
# licence was ensured above (bin/unity-license needs the network).
# -upmNoDefaultPackages: a new project would otherwise get Unity's default set.
VC_UNITY_SKIP_LICENSE=1 "${NONET[@]}" nice -n 10 "$VC_UNITY" -batchmode -nographics -quit -projectPath "$P" -buildTarget Android \
  -upmNoDefaultPackages -executeMethod VCProbeBuild.Prepare -logFile "$W/unity-prepare.log"
prepared=0
if grep -q '^\[VCProbe\] prepared' "$W/unity-prepare.log"; then prepared=1
else echo "prepare did not finish: $(grep -E 'error CS[0-9]+|prepare FAILED|\[Package Manager\].*(rror|cannot)' "$W/unity-prepare.log" | tail -3 | tr '\n' ' ')"; fi

APK="$W/out/debug.apk"
unity_build debug "$APK"
grep -v '^PROBE build ' "$W/out/debug.probe"
if [ -s "$APK" ]; then
  say apk ok "$(stat -c %s "$APK")" "$(sed -n 's/^PROBE build ok //p' "$W/out/debug.probe")"
else
  say apk FAIL "$(grep -E 'PROBE build|error CS[0-9]+|\[VCProbe\] build error|BuildFailedException' "$W/out/debug.probe" "$W/unity-debug.log" 2>/dev/null | tail -5 | tr '\n' ' ' | cut -c1-600)"
  exit 0
fi
# offline: the APK built, and the lock resolves nothing from a registry
LOCK="$P/Packages/packages-lock.json"
reg=$(grep -c '"source": "registry"' "$LOCK" 2>/dev/null)
if [ $prepared = 1 ] && [ -s "$LOCK" ] && [ "${reg:-1}" = 0 ]; then
  say upm_offline ok "$offline: $(grep -c '"source": "local-tarball"' "$LOCK") tarballs, $(grep -c '"source": "builtin"' "$LOCK") built-in"
else say upm_offline FAIL "prepare=$prepared registry packages in the lock: ${reg:-no lock}"; fi
files=$(unzip -Z1 "$APK")
echo "$files" | grep -qx 'lib/arm64-v8a/libil2cpp.so' && say il2cpp_arm64 ok || say il2cpp_arm64 FAIL no lib/arm64-v8a/libil2cpp.so
echo "$files" | grep -qx 'lib/arm64-v8a/libopenxr_loader.so' && say openxr_loader ok || say openxr_loader FAIL no lib/arm64-v8a/libopenxr_loader.so
if [ -f "$P/Assets/Plugins/Android/arm64-v8a/libvc_probe.so" ]; then
  echo "$files" | grep -qx 'lib/arm64-v8a/libvc_probe.so' && say rust_apk ok || say rust_apk FAIL no lib/arm64-v8a/libvc_probe.so
else say rust_apk SKIP no android cdylib; fi
manifest=$("$BT/aapt2" dump xmltree --file AndroidManifest.xml "$APK" 2>/dev/null)
if echo "$manifest" | grep -q 'com.oculus.intent.category.VR' && echo "$manifest" | grep -q 'android.hardware.vulkan.version'; then
  say quest_manifest ok
else say quest_manifest FAIL no com.oculus.intent.category.VR / vulkan feature in AndroidManifest.xml; fi
want=$(ks_cert "$VC_UNITY_DEBUG_KEYSTORE" android androiddebugkey)
got=$(cert "$APK")
[ -n "$want" ] && [ "$got" = "$want" ] && say signed_debug ok || say signed_debug FAIL "signer $got, shared debug keystore $want"

# --- release signing by the env convention (an incremental rebuild)
RKS="$W/release.keystore"
RPASS="probe-$$-$RANDOM"
"$J/bin/keytool" -genkeypair -keystore "$RKS" -storepass "$RPASS" -keypass "$RPASS" -alias probe -keyalg RSA -keysize 2048 \
  -validity 30 -dname "CN=vistaclair unity probe" -noprompt >/dev/null 2>&1
RAPK="$W/out/release.apk"
UNITY_ANDROID_KEYSTORE_PATH="$RKS" UNITY_ANDROID_KEYSTORE_PASS="$RPASS" UNITY_ANDROID_KEYSTORE_ALIAS=probe \
  UNITY_ANDROID_KEYSTORE_ALIAS_PASS="$RPASS" unity_build release "$RAPK"
want=$(ks_cert "$RKS" "$RPASS" probe)
got=$( [ -s "$RAPK" ] && cert "$RAPK")
[ -n "$want" ] && [ "$got" = "$want" ] && say signed_release ok || say signed_release FAIL "signer ${got:-none}, release keystore $want"
exit 0
