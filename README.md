# rig-doctor

A Claude Code plugin that diagnoses stability/performance problems on Windows gaming PCs.

The trick: most "my PC feels off" problems on a tuned machine are **regressions** — a Windows update re-enabled Game Mode, a driver install reset your GPU power limit, XMP/EXPO silently dropped after a failed boot. So rig-doctor first captures a **baseline** of your machine's tuning while it's healthy, then every diagnosis checks live telemetry *and* drift from that baseline.

## Install

From a Claude Code session:

```
/plugin marketplace add stitts-dev/rig-doctor
/plugin install rig-doctor@rig-doctor-marketplace
```

Or clone it and add the local path as a marketplace:

```
/plugin marketplace add C:\path\to\rig-doctor
```

## Use

1. **While your PC is running well**, say: `capture baseline` (or "rig doctor, save current state as good"). This snapshots your tuning knobs to `~\.rig-doctor\baseline.json`. Review the snapshot; optionally add `watch_processes` (e.g. `["MSIAfterburner","RTSS"]`) for tools that must be running to hold your OC/frame cap.
2. **When something feels off**, say: `rig doctor` / "why is my game stuttering" / "it crashed". You get a full sweep — GPU/CPU/RAM telemetry, thermals, 14-day crash history, tuning drift, recent installs/updates, disk health — and a prioritized fix list. Stale duplicate game installs get checked too when a drive's low on space, you mention duplicate/mystery installs, or a launcher lists the same game more than once.
3. **After an intentional retune**, re-capture the baseline.

Nothing is changed on your system without an explicit OK; fixes are proposed first.

### Curated baseline (optional)

The auto-captured JSON records values but not *why* they're set. If you'd rather hand-maintain your baseline — with rationale, known hardware issues, and the tuning tools you rely on — drop a `baseline.md` next to `SKILL.md` in your installed copy. If it exists, it takes priority over the JSON. Keeping machine data there rather than in `SKILL.md` means you can pull plugin updates without losing your notes.

## What it checks

| Phase | Covers |
|---|---|
| 0 | Baseline capture (run only when healthy) |
| 1 | Live telemetry — GPU clocks/power/throttle reasons, CPU boost, RAM pressure and rated speed |
| 2 | Thermals — ACPI best-effort plus what to read in HWiNFO |
| 3 | Crash history — Kernel-Power 41, bugchecks, WHEA, TDR resets, minidump presence |
| 4 | Tuning drift vs baseline, including tools that must be running |
| 5 | Problem devices, recent installs, recent Windows updates, startup entries |
| 6 | Disk health — wear, temp, errors, free space |
| 7 | Install hygiene — finds duplicate/stale game installs and identifies which copy is actually live |
| 8 | DPC/ISR latency — non-elevated screening for audio pops/micro-stutter, plus an elevated wpr deep-pass when the screening can't pin it down |

It also documents two things that eat whole debugging sessions: **elevated apps silently swallowing automated input (UIPI)**, and **NVIDIA App's two separate stores** — the JSON library cache versus the binary driver-profile database — so per-game settings get applied to the copy of the game you actually launch.

## Requirements

- Windows 10/11 (PowerShell — commands are 5.1-compatible)
- NVIDIA GPU checks use `nvidia-smi` when available; other GPUs get the generic sweep
- HWiNFO (or similar) recommended for CPU/VRM/NVMe temps — Windows doesn't expose them reliably
