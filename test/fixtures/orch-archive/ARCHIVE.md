# ARCHIVE — run 7d1c23
| t0 | Bench A–H + design (w1) | done — landed de38dbdb/7633db06: vrm_core/ski/examples/ski_bench.rs, 104 rows: 74 meets · 9 partly · 10 fails · 11 impossible; DESIGN/PLAN in sessions/orch-7d1c23-w1-ski-scenario-bench |
| t1a | Slice 1 kernel V12 + skiweb lockstep (w2) | done — landed b915ce02: leaf, reader (fore gain, look gain, arm reach, inside hand low, tuck hold), preset.rs SkiMode/apply_mode, tunables ski.modes; bench 88 gated rows PASS; parity 144 rows; skiweb 12/12; quest core 235 tests |
| t1c | Mode UI Quest + desktop (w3) | done — landed 4361cac3: Quest Controls row "Ski mode" via qw_ski_menu (no ffi change), core ski.rs apply_mode; desktop key G + HUD chip, skimode.js; check-skidesk/i18n/cargo/quest-build --check PASS |
| t2 | Slice 2 V13 (w4) | done — landed 4fb9d2e4: plant pivot, down-up unweight, turn_plant, rise-latched release, edge set, hockey steady push mu_h 0.8, flat sideslip fix, plough gesture removed; bench 98 gated rows PASS; parity 156; skiweb 12/12; quest core 238 / ffi 25 |
| t5 | Hockey spray burst (w5) | done — landed e08c617a: quest/world/show/src/tracks/spray.rs fan burst own + peers, Quest + desktop; before 16 m/s stop 25 puffs (saturated); spray.mjs row i + twins PASS; skiweb rebuilt |
| t6 | Plough texts (w6) | done — landed 088d2eab: ski.assist help, skihud, quest-world-ski scenario, ski.mjs row d -> "NO plough" (syntax-checked only; runs in next check-quest-world vs live) |
| t2b | plant_any mode-key routing (w4) | done — landed 26dadee4: skimode.js modeScope from ski.physics/body, MODE_PHYS removed, rows-mode f + twin; check-skidesk 9/9 |
| t1d | Quest train 24 (w7) | done — installed 22:40 on Quest 3 over WiFi, main 26dadee4, sha 753e37e8…, adb reverse 8443, VRM abi ok + welcome; APP_QUESTNATIVE train line 3c563957 |
| t8 | lighting.winter derive (w8) | done — 5876c2d8: pipeline/winterlight.py at create/re-frame, oberengadin backfilled 30.4/170.1, check-snow row + twin |

| t4 | Dashboard shows each player's ski mode | done — w10, gs.js SKI_MODES whitelist, desktop telemetry ski_mode, players chip; check-serve 401/401; Quest sends none (o19) |
| t9 | New world complete at create + oberengadin backfill | done — w9 5037eca6: panorama.ring written at create/re-frame + newregion.py --complete; only fatal gap; check-newworld 29/29 |
