---
name: rig-doctor
description: Diagnose stability/performance issues on a Windows gaming PC. Captures a known-good baseline of the machine's tuning on first run, then diagnoses problems by sweeping live telemetry, thermals, crash history, tuning drift vs the baseline, recent system changes, and disk health — and reports prioritized findings with fixes. Use whenever the user reports stutter, frame drops, freezes, crashes/BSOD, thermal worries, "feels slow", high latency, or "something's off" with their PC or a game. Triggers: "rig doctor", "diagnose my pc", "why is my game stuttering", "fps tanked", "it crashed", "check my system", "performance issue", "capture baseline".
---

# rig-doctor

A diagnostic runbook for Windows gaming PCs. The core idea: most "problems" on a tuned machine are *regressions* from a known-good state — a Windows update re-enabled Game Mode, a driver install reset a power limit, EXPO/XMP dropped after a failed boot. So this skill keeps a **baseline snapshot** of the machine's tuning and, on every diagnostic run, checks live telemetry AND drift from that baseline, then hands back a prioritized fix list.

**Requirements:** Windows 10/11, PowerShell. NVIDIA GPU checks use `nvidia-smi` when present; AMD/Intel GPUs get the generic checks only. Some checks read HKLM but nothing here writes anything without the user's explicit OK.

**Two modes:**
- **`baseline`** — user says "capture baseline", "save current state as good", or this is the first run and no baseline file exists: run Phase 0 to snapshot the current tuning to `$env:USERPROFILE\.rig-doctor\baseline.json`. Only do this when the machine is currently working well — say so if the user is capturing mid-problem.
- **`diagnose`** (default) — run Phases 1–6, compare against the baseline file, produce the report. If no baseline exists yet, still run everything (skip the drift comparison), report absolute findings, and offer to capture a baseline once the machine is healthy.

The tone: assume the user tunes their own machine — skip beginner hand-holding, report concrete numbers, and only apply changes with an explicit OK (offer to apply the safe ones).

## Phase 0 — Capture / update baseline

Run only in `baseline` mode. Snapshots the tunable knobs that Windows updates and driver installs are known to silently reset.

```powershell
$dir = Join-Path $env:USERPROFILE '.rig-doctor'
if (-not (Test-Path $dir)) { New-Item -ItemType Directory $dir | Out-Null }
$nvsmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue

$b = [ordered]@{
  captured   = (Get-Date).ToString('s')
  cpu        = (Get-CimInstance Win32_Processor).Name
  os_build   = (Get-CimInstance Win32_OperatingSystem).BuildNumber
  gpu_name   = if ($nvsmi) { (& nvidia-smi --query-gpu=name --format=csv,noheader) } else { (Get-CimInstance Win32_VideoController | Select-Object -First 1).Name }
  gpu_driver = if ($nvsmi) { (& nvidia-smi --query-gpu=driver_version --format=csv,noheader) } else { (Get-CimInstance Win32_VideoController | Select-Object -First 1).DriverVersion }
  gpu_power_limit_w = if ($nvsmi) { [int](& nvidia-smi --query-gpu=power.limit --format=csv,noheader,nounits) } else { $null }
  ram_total_gb      = [int]((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB)
  ram_clock         = (Get-CimInstance Win32_PhysicalMemory | Select-Object -First 1).ConfiguredClockSpeed
  pagefile_auto     = (Get-CimInstance Win32_ComputerSystem).AutomaticManagedPagefile
  pagefile          = (Get-CimInstance Win32_PageFileSetting | ForEach-Object { "$($_.InitialSize)/$($_.MaximumSize)" }) -join ','
  power_plan        = ((powercfg /getactivescheme) -replace '.*\(' -replace '\).*')
  hags              = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers' -Name HwSchMode -ErrorAction SilentlyContinue).HwSchMode
  win32_priority    = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\PriorityControl' -Name Win32PrioritySeparation -ErrorAction SilentlyContinue).Win32PrioritySeparation
  mouse_accel       = (Get-ItemProperty 'HKCU:\Control Panel\Mouse' -Name MouseSpeed -ErrorAction SilentlyContinue).MouseSpeed
  game_mode         = (Get-ItemProperty 'HKCU:\Software\Microsoft\GameBar' -Name AutoGameModeEnabled -ErrorAction SilentlyContinue).AutoGameModeEnabled
  gamedvr           = (Get-ItemProperty 'HKCU:\System\GameConfigStore' -Name GameDVR_Enabled -ErrorAction SilentlyContinue).GameDVR_Enabled
  watch_processes   = @()
}
$b | ConvertTo-Json | Out-File (Join-Path $dir 'baseline.json') -Encoding utf8
"Baseline saved: $(Join-Path $dir 'baseline.json')"
$b | Format-List
```

After capturing, show the user the snapshot and ask if any values are *not* how they want them — the baseline should be the *intended* state, not just whatever happens to be set. Also offer to fill `watch_processes`: an array of process names (e.g. `["MSIAfterburner","RTSS"]`) for tuning tools that must be running to hold an overclock, fan curve, or frame cap — the diagnose sweep flags any that aren't running. Edit the JSON directly for corrections.

## How to run a diagnosis

If the user named a symptom (stutter, crash, low FPS, etc.), keep it in mind to weight the findings — but always run the **full sweep**; regressions often hide in an unrelated subsystem. Run the phases below, read the output, then produce the report.

> Notes: `nvidia-smi` writes progress to stderr — under PowerShell that shows as `NativeCommandError` with exit code 0; ignore it. For best signal, run the live-telemetry phase **while the problem is happening** (e.g. with the game running). On builds where `wmic` is removed, everything here already uses CIM/registry.

### Phase 1 — Live telemetry (is anything throttling or maxed right now)

```powershell
$nvsmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($nvsmi) {
  "### GPU — clocks, temps, power, throttle reasons"
  & nvidia-smi --query-gpu=name,driver_version,temperature.gpu,utilization.gpu,clocks.gr,clocks.max.gr,clocks.mem,power.draw,power.limit,power.default_limit,pstate,pcie.link.gen.gpucurrent,pcie.link.gen.max --format=csv
  "`n### GPU — active throttle/perf-cap reasons (all should read 'Not Active' under load except possibly GpuIdle)"
  & nvidia-smi -q -d PERFORMANCE | Select-String 'Clocks (Event|Throttle) Reasons' -Context 0,9
} else {
  "### GPU (no nvidia-smi — generic info only; use GPU-Z/HWiNFO for clocks/temps)"
  Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, @{n='VRAM_GB';e={[math]::Round($_.AdapterRAM/1GB,1)}} | Format-Table -Auto
}

"`n### CPU — current vs base clock, load"
Get-CimInstance Win32_Processor | Select-Object @{n='CurMHz';e={$_.CurrentClockSpeed}}, @{n='MaxMHz';e={$_.MaxClockSpeed}}, @{n='Load%';e={$_.LoadPercentage}} | Format-Table -Auto
"Top 8 CPU consumers:"
Get-Process | Sort-Object CPU -Descending | Select-Object -First 8 Name, Id, @{n='CPU_s';e={[int]$_.CPU}}, @{n='RAM_MB';e={[int]($_.WS/1MB)}} | Format-Table -Auto

"`n### Memory — pressure + rated speed still applied"
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
"RAM used: {0:N1} / {1:N1} GB  ({2:P0})" -f (($cs.TotalPhysicalMemory-($os.FreePhysicalMemory*1KB))/1GB), ($cs.TotalPhysicalMemory/1GB), (1-($os.FreePhysicalMemory*1KB/$cs.TotalPhysicalMemory))
"RAM ConfiguredClockSpeed: " + ((Get-CimInstance Win32_PhysicalMemory | Select-Object -First 1).ConfiguredClockSpeed)
"Top 8 RAM consumers:"
Get-Process | Sort-Object WS -Descending | Select-Object -First 8 Name, @{n='RAM_MB';e={[int]($_.WS/1MB)}} | Format-Table -Auto
```

**Read it:** GPU under load should sit near its boost clock with throttle reasons "Not Active" — `SwThermalSlowdown`/`HwThermalSlowdown` = cooling problem; `SwPowerCap` = hitting the power limit (normal at full load); `HwSlowdown` = serious (PSU/thermal). PCIe gen current well below max *while under load* = reseat/riser/power-saving issue (idle downshift is normal). RAM clock far below the kit's rating (e.g. 4800 on a 6000 kit) = **XMP/EXPO dropped** (BIOS reset / failed memory training) — top-priority fix. CPU stuck far below boost under load with high temps = thermal/power throttle.

### Phase 2 — Thermals

```powershell
"GPU temps come from Phase 1 (NVIDIA). For authoritative CPU/VRM/NVMe temps use HWiNFO or similar."
"Best-effort ACPI CPU temp (often unreliable on desktops):"
try { (Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop |
  ForEach-Object { "{0:N1} C" -f ($_.CurrentTemperature/10-273.15) }) } catch { "ACPI thermal zone not exposed - use HWiNFO" }
```

Windows exposes CPU package temp poorly; if the user is chasing a thermal issue, have them open HWiNFO (or Ryzen Master / XTU) and read Tctl/Tdie, VRM, and NVMe temps directly. Rules of thumb: modern CPUs briefly spiking to Tjmax is normal, *sustained* pegging at Tjmax under load is not; NVMe >70 °C throttles (stutter on map/level loads); VRM throttling shows as CPU clock dips with cool CPU temps, common on ITX boards under all-core load. Also cross-check WHEA thermal events in Phase 3.

### Phase 3 — Stability & crash history

```powershell
$since = (Get-Date).AddDays(-14)
"Uptime / last boot:"
(Get-CimInstance Win32_OperatingSystem).LastBootUpTime
"`n### Critical/Error system events (last 14 days) — crashes, hardware errors, driver resets"
Get-WinEvent -FilterHashtable @{LogName='System'; Level=1,2; StartTime=$since} -ErrorAction SilentlyContinue |
  Where-Object { $_.Id -in 41,1001,6008,18,19,17,1018 -or $_.ProviderName -match 'WHEA|nvlddmkm|amdkmdag|Disk|Ntfs|volmgr|Kernel-Power|BugCheck' } |
  Group-Object Id, ProviderName | Sort-Object Count -Descending |
  Select-Object Count, @{n='Event';e={$_.Name}}, @{n='Latest';e={($_.Group | Sort-Object TimeCreated -Descending | Select-Object -First 1).TimeCreated}} |
  Format-Table -Auto
"`n### App crashes (Application Error / Hang) last 14d:"
Get-WinEvent -FilterHashtable @{LogName='Application'; Level=2; StartTime=$since} -ErrorAction SilentlyContinue |
  Where-Object { $_.Id -in 1000,1002 } | Group-Object {$_.Properties[0].Value} |
  Sort-Object Count -Descending | Select-Object Count, Name -First 10 | Format-Table -Auto
"`n### GPU TDR resets (event 4101 - 'display driver stopped responding'):"
(Get-WinEvent -FilterHashtable @{LogName='System'; Id=4101; StartTime=$since} -ErrorAction SilentlyContinue | Measure-Object).Count
```

**Interpret:** Kernel-Power **41** = hard lock/reset — on an overclocked rig suspect the GPU OC, undervolt curve, or XMP/EXPO first; on a stock rig suspect PSU/drivers. **BugCheck 1001** = BSOD; read the stop code (0x124 WHEA = hardware/OC, 0x13A/0x1A = memory-instability fingerprint). **WHEA-Logger** = real hardware errors — recurring WHEA on a tuned machine points at the curve optimizer/undervolt or memory OC. **4101 TDR** spikes = GPU OC too aggressive or driver issue. App-Error buckets naming one game's exe = game-side; don't chase ghosts in Windows.

### Phase 4 — Tuning drift sweep (did something reset the known-good state)

Skip the comparison if no baseline file exists (offer to capture one at the end instead).

```powershell
$bfile = Join-Path $env:USERPROFILE '.rig-doctor\baseline.json'
if (-not (Test-Path $bfile)) { "NO BASELINE ($bfile) - skipping drift sweep" } else {
$b = Get-Content $bfile -Raw | ConvertFrom-Json
function chk($name,$actual,$want){
  if ($null -eq $want -or "$want" -eq '') { return }
  $ok = "$actual" -eq "$want"
  "{0,-26} now={1,-14} baseline={2,-14} {3}" -f $name,$actual,$want,($(if($ok){'OK'}else{'<-- DRIFT'}))
}
$nvsmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($nvsmi) {
  chk 'GPU power.limit (W)' ([int](& nvidia-smi --query-gpu=power.limit --format=csv,noheader,nounits)) $b.gpu_power_limit_w
  chk 'GPU driver (note only)' (& nvidia-smi --query-gpu=driver_version --format=csv,noheader) $b.gpu_driver
}
chk 'RAM ConfiguredClock'  ((Get-CimInstance Win32_PhysicalMemory | Select-Object -First 1).ConfiguredClockSpeed) $b.ram_clock
chk 'Page file auto-mgmt'  ((Get-CimInstance Win32_ComputerSystem).AutomaticManagedPagefile) $b.pagefile_auto
chk 'Page file (init/max)' (((Get-CimInstance Win32_PageFileSetting | ForEach-Object { "$($_.InitialSize)/$($_.MaximumSize)" }) -join ',')) $b.pagefile
chk 'Power plan'           (((powercfg /getactivescheme) -replace '.*\(' -replace '\).*')) $b.power_plan
chk 'HAGS HwSchMode'       ((Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers' -Name HwSchMode -ErrorAction SilentlyContinue).HwSchMode) $b.hags
chk 'Win32PrioritySep'     ((Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\PriorityControl' -Name Win32PrioritySeparation -ErrorAction SilentlyContinue).Win32PrioritySeparation) $b.win32_priority
chk 'Mouse accel'          ((Get-ItemProperty 'HKCU:\Control Panel\Mouse' -Name MouseSpeed -ErrorAction SilentlyContinue).MouseSpeed) $b.mouse_accel
chk 'Game Mode'            ((Get-ItemProperty 'HKCU:\Software\Microsoft\GameBar' -Name AutoGameModeEnabled -ErrorAction SilentlyContinue).AutoGameModeEnabled) $b.game_mode
chk 'GameDVR_Enabled'      ((Get-ItemProperty 'HKCU:\System\GameConfigStore' -Name GameDVR_Enabled -ErrorAction SilentlyContinue).GameDVR_Enabled) $b.gamedvr
chk 'OS build (note only)' ((Get-CimInstance Win32_OperatingSystem).BuildNumber) $b.os_build
foreach ($p in $b.watch_processes) {
  "watch process {0,-17} running={1}" -f $p, $(if (Get-Process $p -ErrorAction SilentlyContinue) {'yes'} else {'NO <-- DRIFT'})
}
}
```

Any line marked `<-- DRIFT` is a likely root cause. The classic silent regressions after a Windows update or failed boot: **XMP/EXPO drop** (RAM clock at JEDEC), **a tuning tool from `watch_processes` not running** (GPU back at stock power limit, no fan curve, no frame cap), **GameDVR re-enabling itself after a cumulative update**, and **power plan reset to Balanced**. Driver or OS-build changes aren't necessarily bad — note them and check whether problems started right after the update. If the user *intended* a change (new driver, retune), update the baseline instead of "fixing" it.

### Phase 5 — Resource hogs, recent changes, driver faults

```powershell
"### Problem devices (Device Manager errors):"
Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object Status -ne 'OK' | Select-Object Status, Class, FriendlyName | Format-Table -Auto
"`n### Software installed in last 21 days (a culprit often arrived recently):"
Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Get-ItemProperty | Where-Object { $_.InstallDate -and ([datetime]::ParseExact($_.InstallDate,'yyyyMMdd',$null) -gt (Get-Date).AddDays(-21)) } |
  Select-Object DisplayName, DisplayVersion, InstallDate | Sort-Object InstallDate -Descending | Format-Table -Auto
"`n### Recent Windows updates (can reset HAGS/power/driver settings):"
Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 5 HotFixID, InstalledOn | Format-Table -Auto
"`n### Startup entries:"
Get-CimInstance Win32_StartupCommand | Select-Object Name, Command | Format-Table -Auto -Wrap
```

### Phase 6 — Disk health (SSD wear/temp/errors cause load-time stutter)

```powershell
Get-PhysicalDisk | ForEach-Object {
  $rc = $_ | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue
  [pscustomobject]@{
    Disk=$_.FriendlyName; Health=$_.HealthStatus
    Wear=$rc.Wear; TempC=$rc.Temperature; ReadErr=$rc.ReadErrorsTotal; WriteErr=$rc.WriteErrorsTotal
  }
} | Format-Table -Auto
"Free space:"
Get-Volume | Where-Object DriveLetter | Select-Object DriveLetter, @{n='FreeGB';e={[int]($_.SizeRemaining/1GB)}}, @{n='Free%';e={[int]($_.SizeRemaining/$_.Size*100)}} | Format-Table -Auto
```

**Watch for:** any disk `HealthStatus` not `Healthy`, `Wear` climbing (% of rated endurance used), NVMe temp over 70 °C, nonzero read/write errors, or a game/OS drive under ~10% free (Windows and most games stutter when the drive is near-full).

## Producing the report

After running the sweep, synthesize — **don't dump raw tables back**. Give:

1. **Verdict line** — healthy, or the single most-likely root cause.
2. **Findings table** ranked by severity: `🔴 critical / 🟠 degraded / 🟡 minor / ✅ confirmed-good`, each with the observed value vs baseline and a one-line cause.
3. **Fix plan** — concrete, ordered. Mark which are safe-to-auto-apply (re-assert power plan, relaunch a tuning tool, clear a stuck process) vs. needs-user (BIOS re-enable XMP/EXPO, dial back an OC, reseat hardware). **Apply only with the user's OK**; show the exact command/diff first.
4. If nothing's wrong system-side and the complaint is game-specific, say so and point at in-game settings/known game issues rather than chasing ghosts in Windows.

## Maintenance

After any *intentional* retune (new BIOS, different XMP profile, GPU OC change, fresh Windows install), re-run **baseline** mode so drift detection stays accurate. The baseline is the whole point.
