# Fleet peer specs (`host-specs.js`)

What a host can do — OS, CPU, RAM, GPUs, display, load, installed extras — for
the app-facing fleet API: `ctx.fleet.peers()[].specs`, `ctx.fleet.self()`,
Bridge `fleet.peers` / `fleet.self`, flag `fleet.specs`
(`capabilities/fleet.js`; app text in `_api-reference.md` "Fleet").

## Shape

```
specs: { os: { platform, release, arch, distro },
  cpu: { model, cores, threads, mhz }, ram: { totalBytes, availBytes },
  gpus: [{ vendor, model, driver, renderNode, vramBytes }],
  display: { x11, wayland, display, hwGL, glRenderer },
  load: { avg1, avg5 }, extras: { <extraId>: '<version>' }, at }
```

`null` leaves where a fact is unknown; `peers()[].specs` is `null` for a slave
that predates the field or has not measured yet. `renderNode` is `null` for an
NVIDIA GPU seen only by `nvidia-smi`.

## Measuring (`host-specs.js`)

| Field | Source |
|---|---|
| `os` | `os.*`; `distro` = `PRETTY_NAME` of `/etc/os-release` |
| `cpu` | `os.cpus()` (threads, mhz, model); `cores` = distinct physical/core ids in `/proc/cpuinfo`, else threads |
| `ram` | `os.totalmem()`; `availBytes` = `MemAvailable` of `/proc/meminfo`, else `os.freemem()` |
| `gpus` | one per `/sys/class/drm/renderD*`: `device/{vendor,device}`, the `driver` link, amdgpu `mem_info_vram_total`; model from `lspci -mm -nn`; `nvidia-smi` (name, `memory.total`) for NVIDIA when on PATH |
| `display` | `x11` = a socket in `/tmp/.X11-unix`; `wayland` = `wayland-*` in `$XDG_RUNTIME_DIR`; `display` = `$DISPLAY`, else the first X socket |
| `hwGL`, `glRenderer` | `glxinfo -B` (X11, with that `DISPLAY`), else `eglinfo -B`; `hwGL` = a renderer that is not llvmpipe / softpipe / swrast / SwiftShader; both `null` with no tool, no display or no output |
| `load` | `os.loadavg()` 1 and 5 minutes |
| `extras` | installed entries of `platform-extras.list()`; version = the pinned release (`BLENDER_VERSION`, `RUST_VERSION`, `GODOT_VERSION`, `UNITY_VERSION`), else `'installed'` |

External tools run through `execFile` (no shell, 4 s timeout, 256 KB output).
A missing tool, a failed read or a bad parse gives a null field; nothing throws.

## When

`get()` caches the slow facts and re-measures them when older than 5 minutes
(`FULL_TTL_MS`, single-flight; `at` = that measurement). `load` and
`ram.availBytes` are read fresh on every `get()`. A slave calls `get()` for
every channel snapshot (`slaveSnapshot`: at connect, on a health change, and
a keepalive every 5 minutes); `ctx.fleet.self()` calls it on the master.

## Transport and sanitising

The slave's `hello` / `status` snapshot (`peer-channel.js`) carries `specs`: no
new port or route. The master's `applySnapshot` passes it through `clean()`:
strings control-char-stripped and cut to 200 chars, numbers finite and
non-negative, at most 8 GPUs, a `renderNode` only as `/dev/dri/renderD<n>`, at
most 64 extras with slug keys and versions ≤ 64 chars, booleans strictly
`true`. A snapshot without valid `specs` keeps the previous ones, so an offline
slave shows its last specs with their `at`. `fleetState().peers[].specs` is the
same object; `fleet_status` (Horst, direct lane) shows it and `self`.

## Not built

Specs persisted across a master restart (they refill at the next connect);
disk free in `specs` (the data publish's `disk` carries it); GPU utilisation
or temperature; Windows / macOS probes.
