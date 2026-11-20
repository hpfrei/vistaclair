# The `unity` platform extra (`platform-extras-unity.js`)

Unity for headless Android / Meta Quest builds at `/opt/vistaclair-unity`
(`UNITY_ROOT`), installed from Apps → Setup → Extras like every extra
(`docs/extras.md`: persisted progress, `probe()`, fixed paths). Its own module,
re-exported by `platform-extras.js`; the files it ships live in `src/apps/unity/`.
App-facing recipes: the **Unity** section of the `toolchains` sidecar in
`_api-reference.md`.

## Layout

| Path | Constant | What |
|---|---|---|
| `versions/<ver>/Editor/Unity` | `UNITY_EDITOR` | The editor, one self-contained tree per version |
| `versions/<ver>/Editor/Data/PlaybackEngines/AndroidPlayer/` | `UNITY_ANDROID` | Android Build Support with `OpenJDK/`, `NDK/`, `SDK/` where Unity expects them |
| `versions/<ver>/.vc-stamps/` | | One stamp per unpacked download (its hash) |
| `bin/unity` | `UNITY_BIN` | `renderUnityWrapper`: licence check, then the editor of `$VC_UNITY_VERSION` |
| `bin/unity-env` | `UNITY_ENV` | `renderUnityEnv`: `VC_UNITY_ROOT`, `VC_UNITY_VERSION`, `VC_UNITY`, `VC_UNITY_EDITOR`, `VC_UNITY_ANDROID`, `VC_UNITY_CLI`, `VC_UNITY_LICENSE`, `VC_UNITY_BUILD_PACKAGE`, `UNITY_CLI_HOME`, `VC_UNITY_UPM`, `VC_UNITY_UPM_MANIFEST` |
| `bin/unity-license` | `UNITY_LICENSE` | `renderUnityLicense`: `status` / `account` / `ensure` / `login` / `activate` |
| `license-mode` | `UNITY_LICENSE_MODE` | `serial` while a Pro / Industry serial is stored (no secret) |
| `bin/unity-login` | `UNITY_LOGIN` | `renderUnityLogin`: the owner's one-time terminal sign-in |
| `cli/bin/unity` | `UNITY_CLI` | The Unity CLI (`UNITY_CLI_VERSION`), `UNITY_CLI_HOME=cli/` |
| `upm/<name>-<ver>.tgz`, `upm/<ver>/manifest.json` | `UNITY_UPM`, `unityUpmManifest(ver)` | The offline UPM package set (below) |
| `packages/com.vistaclair.build/` | `UNITY_BUILD_PACKAGE` | UPM package: Android signing from env (below) |
| `keystores/debug.keystore` | `UNITY_DEBUG_KEYSTORE` | Shared debug keystore, generated once by the editor's `keytool` |
| `dl/` | `UNITY_DL` | Every download, kept verified for reruns |
| `capabilities.json`, `README.md` | `UNITY_CAPS`, `UNITY_README` | Probe verdict; the paths for a human (`renderUnityReadme`) |

## Pins and fetch

`UNITY_RELEASES[<ver>]` holds one installable version: changeset, the Linux
editor tarball, the Android `.pkg`, and the sub-modules the release API pins
(`services.api.unity.com/unity/editor/release/v1/releases`), each with
`dest` (under `AndroidPlayer/`) and `sub` (the zip's top dir — the API's
`extractedPathRename`). Hashes: Unity md5 (the API's base64, stored hex),
OpenJDK sha256 (in its file name), cmdline-tools sha384 (API), Google zips sha1
(`repository2-3.xml`). The CLI binary comes straight from
`public-cdn.cloud.unity3d.com/hub/prod/cli/<ver>/unity-linux-x64` with the sha256
of that version's `latest.json` (not `install.sh`: it edits rc files and
`~/.config/unityhub/cli-install.json`). `UNITY_VERSION` (6000.3.28f1) is the
default; the installer fetches every row, side by side.

`renderUnityFetch(ver)` verifies all downloads before unpacking; each unpack
goes through `.part` + rename with a stamp. A new editor replaces the version
tree whole (stamps with it); the Android `.pkg` (xar → gzip cpio, via `7z` +
`cpio`) replaces `AndroidPlayer/` and resets the sub-module stamps. Debs:
`UNITY_DEBS`. The NDK is Unity's r27c, separate from `android-build`'s.

## Licence

Personal has no serial / password / `.ulf` path: the Unity CLI's `auth login`
prints a one-time URL (~5 min) the owner approves in any browser, then `license
activate --personal --accept-eula`. State: the running user's `~/.config/unityhub/`
plus the per-user licensing client (reached through `XDG_RUNTIME_DIR`).

`bin/unity-license`: `status` (the CLI's JSON; exit 0 active, 3 not), `account`
(`auth status --json`), `ensure` (re-activates a lapsed Personal licence while
signed in, under a per-user `flock`; with `license-mode` = `serial` it never
falls back to Personal; exit 3 otherwise), `login [args]` (args to `auth login`),
`activate` (Personal, or `--serial "$UNITY_LICENSE_SERIAL"` when that env is set).
The CLI ignores `BROWSER` and runs `xdg-open`: `login` puts no-op stubs of
`UNITY_BROWSER_OPENERS` first on `PATH` and drops `DISPLAY` / `WAYLAND_DISPLAY`,
so no browser opens on the server's desktop. `bin/unity` runs `ensure` before the
editor (not for a lone `-version`; `VC_UNITY_SKIP_LICENSE=1` skips it) and exits 3
with a pointer to Setup → Extras.

Server side, `platform-extras-unity-license.js` (through `bin/unity-license` only):

| Part | What |
|---|---|
| State | `<appsDir>/.unity-license.json` (no secrets): `status { active, signedIn, products, licenses[{ product, type, expires }], account { name, email }, error, checkedAt }`, `signIn`, `alert`, `lastReactivation`. On the unity row of `app:extras:status` as `license` (`snapshot()`); a dashboard read older than 60 s refreshes it in the background (`kick`) |
| Sign-in | `startSignIn()` spawns `unity-license login --json --non-interactive`; `parseUnityLoginUrl` reads the `auth_url=` progress line (or the human `Sign-in URL:` form). `signInReducer`: `idle → starting → waiting { url, expiresAt } → activating → done \| failed \| expired \| cancelled`; the child is ended after 6 min; exit 0 = approved, then `activate`. Every step persisted and broadcast; a server restart turns an open flow into `failed` |
| Re-activate | `reactivate()`: `activate`, then status (the owner's button when signed in but lapsed) |
| Hourly check | internal cron job `unity:license-check` (`17 * * * *`, handler `unity.license-check`, registered at boot once installed). `licenceVerdict`: active → nothing; signed in → `activate`; signed out or re-activation failed → `observe()` listeners once per lapse (`alert`, cleared when active) |
| Alert | sense `toolchain:license-lapsed` (`capabilities/exec.js`, `notify` → the owner's Telegram): `{ toolchain, reason: signed-out \| reactivation-failed, error }` |
| Pro / Industry | `setSerial()`: the serial in `<appsDir>/.unity-license.enc` (core `secretStore`), never in the snapshot or a log; `activate` gets it in its env only (the CLI takes it as an argument — it has no stdin form). Writes / removes `license-mode`. Sign-in stays the URL flow |
| Scripts | `start()` (boot) rewrites `bin/unity-license` and `bin/unity-login` when they differ from the render, so a licence-script fix reaches an installed extra without a reinstall |
| WS | `app:extras:unity:signIn` / `:cancel` / `:reactivate` / `:serial { serial }` — owner only (core `isOwnerConnection`) |

Dashboard: the unity row in Setup → Extras (`renderUnityLicence` in
`public/apps.js`) shows the licence and account, **Re-activate** when signed in
but lapsed, the last alert and the Pro / Industry serial field. **Sign in to
Unity** is one click: the handler opens a blank tab synchronously (popup
blockers allow it), the server starts `login`, and `steerUnitySignInTab` points
that tab at the approval URL from the next `app:extras:status`; the card follows
to signed in and active. The link (clickable, Copy link, Cancel) stays on the
card for a blocked popup, a reload or a phone. A missing / lapsed licence marks
the row, the Extras nav item and the Setup button (`unityLicenceAttention`; the
extras rows are sent on every dashboard connect).
`parseUnityLicenseStatus(text, { detail })`, `unityLicenseStatus({ bin })`
(never throws), `reprobeUnity()` (re-runs the probe, rewrites
`capabilities.json`). Tests: `test/platform-extras-unity-license.test.js`.

## Packages (offline UPM)

Builds resolve UPM packages with no registry, through `file:` tarball
references — a documented UPM source that needs no network, no cache and no
server; the user's Unity config and global cache stay untouched, so online use
is unaffected. (A seeded `UPM_CACHE_ROOT` also resolves offline, but leans on
UPM's internal cache layout, cached CRLs and its fetch-failure fallback, and
needs a licensed editor run to seed; a scoped registry needs an HTTP server.)

- `UNITY_RELEASES[<ver>].packages`: a Quest app's direct packages;
  `.upm`: their registry closure as that editor resolves it (its
  `Data/Resources/PackageManager/Editor/manifest.json` minimum versions lift
  the indirect ones), `[name, version, sha1]` with the registry's `dist.shasum`
  (Unity's registry publishes no sha512). A direct package absent from `.upm`
  is an editor core package (URP 17.3.0).
- `UNITY_UPM_OPTIONAL`: the Meta XR Core SDK (`npm.developer.oculus.com`,
  sha512 from its `dist.integrity`) and `com.unity.xr.hands` it needs —
  fetched, recorded in `capabilities.json` → `upm.optional`, never required.
- `renderUnityUpmFetch(unityUpmDownloads())`: every tarball into `upm/`,
  checked against its hash (a verified one is kept, a bad one replaced,
  downloads through `.part`); a required failure stops the install, an optional
  one is left out. One fetch over every version's set.
- `renderUnityUpmManifest(release)` → `upm/<ver>/manifest.json`: core
  packages by version, every `.upm` row as `file:/opt/vistaclair-unity/upm/…`,
  plus `com.vistaclair.build`. The app starts its `Packages/manifest.json`
  from it (`$VC_UNITY_UPM_MANIFEST`); the probe builds with exactly it.
- New projects: `-upmNoDefaultPackages` on the first run (Unity's default
  set is not in `upm/`).

## Signing

`com.vistaclair.build` (`src/apps/unity/com.vistaclair.build`, `.meta` files with
fixed GUIDs — `/opt` is not app-writable) is an Editor
`IPreprocessBuildWithReport`: on Android it sets `PlayerSettings.Android.keystore*`
from `UNITY_ANDROID_KEYSTORE_PATH/_PASS/_ALIAS/_ALIAS_PASS` (alias pass defaults
to the store pass; missing pass/alias fails the build), else from the shared
debug keystore (`android` / `androiddebugkey`). The postprocess step restores
the project's values and clears the passwords. No key material in the repo.

## Probe

`runUnityProbe(h)` runs `src/apps/unity/probe.sh` on a fresh copy of
`src/apps/unity/probe/` with `Packages/manifest.json` =
`renderUnityUpmManifest()` (the offline set) and,
with the `rust` extra, the `probe-rust` cdylib built for the host and
`aarch64-linux-android` (`cargo ndk -P 29`, the editor's NDK). A first editor run
(`VCProbeBuild.Prepare`) sets the Android target and Active Input Handling, which
take effect only in the next run; then `VCProbeBuild.Build`
configures URP, XR Management + OpenXR (Meta Quest feature, touch profile,
`SinglePassInstanced` = multiview, auto-fixable validation errors fixed),
Vulkan, IL2CPP ARM64, and builds the APK; then the APK is checked
(`libil2cpp.so`, `libopenxr_loader.so`, `libvc_probe.so`, the VR category and
Vulkan feature in the manifest, signer = the debug keystore) and rebuilt with a
throwaway release keystore through the env convention. Offline proof
(`upm_offline`): every editor run gets a fresh empty `UPM_CACHE_ROOT` and a
dead `UPM_REGISTRY`; `Prepare` (resolve + import) also runs in `bwrap
--unshare-net` when bwrap can (`unshare -rn` is barred by AppArmor's userns
restriction); the APK builds keep the network for gradle's maven dependencies.
`ok` = Prepare finished, the debug APK built, and `packages-lock.json` names no
`registry` source. `parseUnityProbeLines`
reads the `PROBE` lines. Required: `-version`; with an active licence, the APK.
Everything else is recorded in `capabilities.json`:
`{ version, default, versions, changeset, cli, license, checks, apkBytes,
android, packages, upm, rust, checkedAt }`. Tests: `test/platform-extras-unity.test.js`.

## Not built

- Offline gradle / maven dependencies for the Android build (`~/.gradle`).
- Floating licences; service-account sign-in (the CLI: service-account sessions cannot activate licences).
