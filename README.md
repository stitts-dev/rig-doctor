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
2. **When something feels off**, say: `rig doctor` / "why is my game stuttering" / "it crashed". You get a full sweep — GPU/CPU/RAM telemetry, thermals, 14-day crash history, tuning drift, recent installs/updates, disk health — and a prioritized fix list.
3. **After an intentional retune**, re-capture the baseline.

Nothing is changed on your system without an explicit OK; fixes are proposed first.

## Requirements

- Windows 10/11 (PowerShell — commands are 5.1-compatible)
- NVIDIA GPU checks use `nvidia-smi` when available; other GPUs get the generic sweep
- HWiNFO (or similar) recommended for CPU/VRM/NVMe temps — Windows doesn't expose them reliably
