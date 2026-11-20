#!/usr/bin/env bash
# The rust extra's install-time proof (platform-extras.js installRust): build
# one tiny crate per way an app uses the toolchain, into <workdir>.
#
#   . /opt/vistaclair-rust/bin/rust-env && VC_NODE=<node> bash rust-probe.sh <workdir>
#
# Prints one marker line per fact, which parseRustProbeLines() reads:
#   PROBE rustc|cargo|rustup <version line>
#   PROBE <native|pyo3|napi|wasm|android_target|cargo_ndk|android_cdylib> ok
#   PROBE <check> FAIL <last error line> | PROBE <check> SKIP <why>
# Each check runs on its own, so one failing does not hide the others. native,
# android_target and cargo_ndk are offline and are the ones the install
# requires; pyo3 and napi fetch their (exactly pinned) crates into the shared
# CARGO_HOME, warming it for apps. android_cdylib cross-builds a cdylib with
# `cargo ndk -t arm64-v8a` against VC_ANDROID_NDK (an NDK dir, optional): SKIP
# when none is given — recorded, not required.
set -u
WORK="${1:?usage: rust-probe.sh <workdir>}"
NODE="${VC_NODE:-node}"
PY="${VC_PYTHON:-python3}"
mkdir -p "$WORK"

say() { echo "PROBE $*"; }

# check <name> <fn>: run fn in a subshell, report ok or the last error line.
# Not `if out=$(…)`: inside an if condition bash ignores the subshell's set -e.
check() {
  local name=$1 out rc
  out=$( ( set -e; "$2" ) 2>&1 ); rc=$?
  if [ "$rc" = 0 ]; then
    say "$name ok"
  else
    say "$name FAIL $(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -n 1 | cut -c1-200)"
  fi
}

crate() { # crate <dir> <crate-type|bin> [deps...] — writes Cargo.toml
  local dir="$WORK/$1" kind=$2; shift 2
  mkdir -p "$dir/src"
  {
    printf '[package]\nname = "%s"\nversion = "0.0.0"\nedition = "2021"\n\n' "$(basename "$dir")"
    [ "$kind" = bin ] || printf '[lib]\ncrate-type = ["%s"]\n\n' "$kind"
    printf '[dependencies]\n'
    for d in "$@"; do printf '%s\n' "$d"; done
  } > "$dir/Cargo.toml"
  echo "$dir"
}

native() {
  local d; d=$(crate vc_native bin)
  echo 'fn main() { println!("{}", (1..=10u64).sum::<u64>()); }' > "$d/src/main.rs"
  cargo build --release --offline --quiet --manifest-path "$d/Cargo.toml"
  [ "$("$d/target/release/vc_native")" = 55 ]
}

pyo3() {
  local d; d=$(crate vc_pyo3 cdylib 'pyo3 = { version = "=0.29.3", features = ["extension-module", "abi3-py39"] }')
  cat > "$d/src/lib.rs" <<'EOF'
use pyo3::prelude::*;

#[pyfunction]
fn add(a: i64, b: i64) -> i64 { a + b }

#[pymodule]
fn vc_pyo3(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(add, m)?)
}
EOF
  printf '[build-system]\nrequires = ["maturin>=1,<2"]\nbuild-backend = "maturin"\n\n[project]\nname = "vc_pyo3"\nversion = "0.0.0"\n' > "$d/pyproject.toml"
  "$PY" -m venv "$WORK/venv"
  "$WORK/venv/bin/pip" install --quiet maturin==1.15.0
  "$WORK/venv/bin/maturin" build --release -m "$d/Cargo.toml" -o "$d/dist" -i "$WORK/venv/bin/python"
  "$WORK/venv/bin/pip" install --quiet "$d"/dist/*.whl
  "$WORK/venv/bin/python" -c 'import vc_pyo3, sys; sys.exit(vc_pyo3.add(2, 3) != 5)'
}

napi() {
  # napi-derive-backend is pinned too: its unlocked 6.1.6 emits calls napi 3.14.2 lacks.
  local d; d=$(crate vc_napi cdylib 'napi = "=3.14.2"' 'napi-derive = "=3.6.12"' 'napi-derive-backend = "=6.1.5"')
  printf '\n[build-dependencies]\nnapi-build = "=2.6.0"\n' >> "$d/Cargo.toml"
  echo 'fn main() { napi_build::setup(); }' > "$d/build.rs"
  cat > "$d/src/lib.rs" <<'EOF'
use napi_derive::napi;

#[napi]
pub fn add(a: i32, b: i32) -> i32 { a + b }
EOF
  cargo build --release --quiet --manifest-path "$d/Cargo.toml"
  cp "$d/target/release/libvc_napi.so" "$d/vc_napi.node"
  "$NODE" -e "process.exit(require('$d/vc_napi.node').add(2, 3) === 5 ? 0 : 1)"
}

wasm() {
  local d; d=$(crate vc_wasm cdylib)
  echo '#[no_mangle] pub extern "C" fn add(a: i32, b: i32) -> i32 { a + b }' > "$d/src/lib.rs"
  cargo build --release --offline --quiet --target wasm32-unknown-unknown --manifest-path "$d/Cargo.toml"
  [ "$(head -c 4 "$d/target/wasm32-unknown-unknown/release/vc_wasm.wasm" | od -An -tx1 | tr -d ' \n')" = 0061736d ]
}

android_target() {
  rustup target list --installed | grep -qx "${VC_ANDROID_TARGET:-aarch64-linux-android}"
}

cargo_ndk() {
  cargo ndk --version | grep -qF "${VC_CARGO_NDK_VERSION:-cargo-ndk}"
}

android_cdylib() {
  local d; d=$(crate vc_android cdylib)
  echo '#[no_mangle] pub extern "C" fn add(a: i32, b: i32) -> i32 { a + b }' > "$d/src/lib.rs"
  (cd "$d" && ANDROID_NDK_HOME="$VC_ANDROID_NDK" cargo ndk -t arm64-v8a build --release --quiet)
  [ -s "$d/target/aarch64-linux-android/release/libvc_android.so" ]
}

say "rustc $(rustc --version | cut -d' ' -f2-)"
say "cargo $(cargo --version | cut -d' ' -f2-)"
say "rustup $(rustup --version 2>/dev/null | cut -d' ' -f2-)"
check native native
check pyo3 pyo3
check napi napi
check wasm wasm
check android_target android_target
check cargo_ndk cargo_ndk
if [ -n "${VC_ANDROID_NDK:-}" ] && [ -d "$VC_ANDROID_NDK" ]; then
  check android_cdylib android_cdylib
else
  say "android_cdylib SKIP no Android NDK (android-build extra with an NDK not installed)"
fi
