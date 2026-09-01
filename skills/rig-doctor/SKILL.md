---
name: rig-doctor
description: Diagnose stability/performance issues on a Windows gaming PC by sweeping live telemetry, thermals, crash history, tuning drift vs a known-good baseline, recent system changes, disk health, and stale game installs, then reporting prioritized findings with fixes. Use whenever the user reports stutter, frame drops, freezes, crashes/BSOD, thermal worries, "feels slow", high latency, disk filling up, duplicate game installs, or "something's off" with the PC or a game. Triggers: "rig doctor", "diagnose my pc", "why is my game stuttering", "fps tanked", "it crashed", "check my system", "performance issue", "capture baseline", "which install is real", "clean up installs".
---

# rig-doctor

A diagnostic runbook for Windows gaming PCs. Most "problems" on a tuned machine are *regressions* from a known-good state — a Windows update re-enabled Game Mode, a driver install reset a power limit, EXPO/XMP dropped after a failed boot. So this skill keeps a **baseline** of the machine's intended tuning and, on every run, checks live telemetry AND drift from that baseline, then hands back a prioritized fix list.

**Procedure lives here; machine data lives in the baseline.** Never inline this machine's values into this file — that's what the baseline is for, and mixing them makes the runbook unshareable.

**Baseline resolution order:**
1. `baseline.md` next to this file — a hand-curated baseline with rationale, known issues, and tooling. **If it exists it wins**; read it before running anything.
2. `$env:USERPROFILE\.rig-doctor\baseline.json` — auto-captured snapshot (Phase 0).
3. Neither → run the full sweep anyway, report absolute findings, offer to capture a baseline once the machine is healthy.

**Requirements:** Windows 10/11, PowerShell. NVIDIA checks use `nvidia-smi` when present; AMD/Intel GPUs get the generic checks only. Nothing here writes anything without the user's explicit OK.

The tone: assume the user tunes their own machine — skip beginner hand-holding, report concrete numbers, apply changes only with an explicit OK (offer to apply the safe ones).

## Phase 0 — Capture / update baseline

Run only when the user asks to capture a baseline, or on first run with no baseline present. Only capture while the machine is **working well** — say so if they're capturing mid-problem.

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

Then show the snapshot and ask whether any value is *not* how they want it — the baseline is the **intended** state, not whatever happens to be set. Offer to fill `watch_processes`: names of tuning tools that must be running to hold an overclock, fan curve, or frame cap (the sweep flags any that aren't). Edit the JSON directly for corrections.

## How to run a diagnosis

If the user named a symptom, weight the findings by it — but always run the **full sweep, Phases 1–6** (regressions hide in unrelated subsystems); run **Phase 7** (install hygiene) only when a drive is low on space, the user mentions duplicate or mystery installs, or a launcher/overlay lists the same game more than once. Run **Phase 8** (DPC/ISR latency) only when the complaint is audio clicks/pops/crackle, micro-stutter or input-polling hitches that Phases 1–6 don't explain, or the user names DPC latency / LatencyMon directly — it's a deeper, slower probe than the rest of the sweep. Run the phases, read the output, then produce the report.

When the complaint is framed around FPS/stutter specifically (not crashes/thermals), also offer `tools\bench.ps1` for a quantified before/after instead of eyeballing Task Manager numbers — e.g. `.\tools\bench.ps1 -ProcessName EscapeFromTarkov.exe -Seconds 120 -Label "before"`, make the change, re-run with `-Label "after"`, compare the two `.json` sidecars. Requires Intel PresentMon; see `tools\bench.ps1`'s header comment for full usage.

> **PowerShell notes.** `nvidia-smi` writes progress to stderr — under PowerShell that surfaces as `NativeCommandError` with exit code 0; ignore it. For best signal, run the live-telemetry phase **while the problem is happening** (e.g. with the game running). On builds where `wmic` is removed, everything here already uses CIM/registry. When a `foreach`/`switch` block feeds a formatter, assign to a variable first (`$r = foreach (...) {...}` then `$r | Format-Table`) — piping a statement block directly is a PS 5.1 parser error ("empty pipe element") and costs a round trip. Keep any `.ps1` you write ASCII-only; PS 5.1 chokes on em-dashes and other Unicode in scripts.

### Phase 1 — Live telemetry (is anything throttling or maxed right now)

```powershell
$nvsmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($nvsmi) {
  "### GPU - clocks, temps, power, throttle reasons"
  & nvidia-smi --query-gpu=name,driver_version,temperature.gpu,utilization.gpu,clocks.gr,clocks.max.gr,clocks.mem,power.draw,power.limit,power.default_limit,pstate,pcie.link.gen.gpucurrent,pcie.link.gen.max --format=csv
  "`n### GPU - active throttle/perf-cap reasons (all should read 'Not Active' under load except possibly GpuIdle)"
  & nvidia-smi -q -d PERFORMANCE | Select-String 'Clocks (Event|Throttle) Reasons' -Context 0,9
} else {
  "### GPU (no nvidia-smi - generic info only; use GPU-Z/HWiNFO for clocks/temps)"
  Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, @{n='VRAM_GB';e={[math]::Round($_.AdapterRAM/1GB,1)}} | Format-Table -Auto
}

"`n### CPU - current vs base clock, load"
Get-CimInstance Win32_Processor | Select-Object @{n='CurMHz';e={$_.CurrentClockSpeed}}, @{n='MaxMHz';e={$_.MaxClockSpeed}}, @{n='Load%';e={$_.LoadPercentage}} | Format-Table -Auto
"Top 8 CPU consumers:"
Get-Process | Sort-Object CPU -Descending | Select-Object -First 8 Name, Id, @{n='CPU_s';e={[int]$_.CPU}}, @{n='RAM_MB';e={[int]($_.WS/1MB)}} | Format-Table -Auto

"`n### Memory - pressure + rated speed still applied"
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
"RAM used: {0:N1} / {1:N1} GB  ({2:P0})" -f (($cs.TotalPhysicalMemory-($os.FreePhysicalMemory*1KB))/1GB), ($cs.TotalPhysicalMemory/1GB), (1-($os.FreePhysicalMemory*1KB/$cs.TotalPhysicalMemory))
"RAM ConfiguredClockSpeed: " + ((Get-CimInstance Win32_PhysicalMemory | Select-Object -First 1).ConfiguredClockSpeed)
"Top 8 RAM consumers:"
Get-Process | Sort-Object WS -Descending | Select-Object -First 8 Name, @{n='RAM_MB';e={[int]($_.WS/1MB)}} | Format-Table -Auto
```

**Read it:** GPU under load should sit near its boost clock with throttle reasons "Not Active" — `SwThermalSlowdown`/`HwThermalSlowdown` = cooling problem; `SwPowerCap` = hitting the power limit (normal at full load); `HwSlowdown` = serious (PSU/thermal). Power limit below baseline = the OC tool didn't apply (is it running?). PCIe gen below max *while under load* = reseat/riser/power-saving (idle downshift is normal; a permanent cap with zero WHEA errors is a platform/training issue, not signal integrity). RAM clock far below the kit's rating (e.g. 4800 on a 6000 kit) = **XMP/EXPO dropped** (BIOS reset / failed memory training) — top-priority fix. CPU stuck far below boost under load with high temps = thermal/power throttle.

### Phase 2 — Thermals

```powershell
"GPU temps come from Phase 1 (NVIDIA). For authoritative CPU/VRM/NVMe temps use HWiNFO or similar."
"Best-effort ACPI CPU temp (often unreliable on desktops):"
try { (Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop |
  ForEach-Object { "{0:N1} C" -f ($_.CurrentTemperature/10-273.15) }) } catch { "ACPI thermal zone not exposed - use HWiNFO" }
```

Windows exposes CPU package temp poorly; for a thermal complaint, have the user open HWiNFO (or Ryzen Master / XTU) and read Tctl/Tdie, VRM, and NVMe temps. Rules of thumb: brief spikes to Tjmax are normal, *sustained* pegging is not; NVMe >70 °C throttles (stutter on map/level loads); VRM throttling shows as CPU clock dips with a cool CPU, common on ITX boards under all-core load. Cross-check WHEA thermal events in Phase 3.

### Phase 3 — Stability & crash history

```powershell
$since = (Get-Date).AddDays(-14)
"Uptime / last boot:"
(Get-CimInstance Win32_OperatingSystem).LastBootUpTime
"`n### Critical/Error system events (last 14 days) - crashes, hardware errors, driver resets"
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
"`n### Minidumps present (needed to read a stop code after the fact):"
(Get-ChildItem (Join-Path $env:SystemRoot 'Minidump\*.dmp') -ErrorAction SilentlyContinue | Measure-Object).Count
```

**Interpret:** Kernel-Power **41** = hard lock/reset — on an overclocked rig suspect the GPU OC, undervolt curve, or XMP/EXPO first; on a stock rig suspect PSU/drivers. **BugCheck 1001** = BSOD; read the stop code (0x124 WHEA = hardware/OC, 0x13A/0x1A = memory-instability fingerprint). **WHEA-Logger** = real hardware errors — recurring WHEA on a tuned machine points at the curve optimizer/undervolt or memory OC. **4101 TDR** spikes = GPU OC too aggressive or driver issue. App-Error buckets naming one game's exe = game-side; don't chase ghosts in Windows. If bugchecks are logged but the minidump count is 0, Storage Sense or a cleaner ate them — have the user exclude `C:\Windows\Minidump` before the next repro, or the stop code is unrecoverable.

### Phase 4 — Tuning drift sweep

Compare against the baseline. With `baseline.md`, walk its tables and check each documented knob; with `baseline.json`, run the loop below. Skip the comparison entirely if neither exists.

```powershell
# baseline.json fallback ONLY - if baseline.md exists next to SKILL.md, walk its tables and do NOT run this
$bfile = Join-Path $env:USERPROFILE '.rig-doctor\baseline.json'
if (-not (Test-Path $bfile)) { "NO BASELINE (no baseline.md next to SKILL.md, no $bfile) - skipping drift sweep" } else {
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

Any `<-- DRIFT` line is a likely root cause. Classic silent regressions after a Windows update or failed boot: **XMP/EXPO drop** (RAM at JEDEC), **a tuning tool not running** (GPU back at stock power limit, no fan curve, no frame cap), **GameDVR re-enabling itself**, **Memory Integrity re-enabled by Defender**, **power plan reset to Balanced**, and **vendor driver installs wiping their own registry tweaks**. Driver or OS-build changes aren't inherently bad — note them and check whether problems started right after. If the user *intended* a change, update the baseline rather than "fixing" it.

Note: anti-cheat (BattlEye, Vanguard, EAC) blocks `ProcessorAffinity` reads on a protected game from a non-elevated PowerShell — the mask reads 0, which is not evidence the affinity rule is missing. Verify affinity in the tuning tool's own GUI.

### Phase 5 — Resource hogs, recent changes, driver faults

```powershell
"### Problem devices (Device Manager errors):"
Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object Status -ne 'OK' | Select-Object Status, Class, FriendlyName | Format-Table -Auto
"`n### Software installed in last 21 days (a culprit often arrived recently):"
Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Get-ItemProperty | Where-Object { $_.InstallDate -match '^\d{8}$' -and ([datetime]::ParseExact($_.InstallDate,'yyyyMMdd',$null) -gt (Get-Date).AddDays(-21)) } |
  Select-Object DisplayName, DisplayVersion, InstallDate | Sort-Object InstallDate -Descending | Format-Table -Auto
"`n### Recent Windows updates (can reset HAGS/power/driver settings):"
Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 5 HotFixID, InstalledOn | Format-Table -Auto
"`n### Startup entries:"
Get-CimInstance Win32_StartupCommand | Select-Object Name, Command | Format-Table -Auto -Wrap
```

### Phase 6 — Disk health

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

**Watch for:** `HealthStatus` not `Healthy`, `Wear` climbing, NVMe over 70 °C, nonzero read/write errors, or a game/OS drive under ~10% free (Windows and most games stutter when the drive is near-full). If a drive is tight, run Phase 7 before suggesting anything be uninstalled.

### Phase 7 — Install hygiene (stale duplicate game installs)

Run when a drive is low on space, when the user mentions duplicate or mystery installs, or when a launcher/overlay lists the same game several times. Duplicates are not cosmetic: they eat the drive whose free space Phase 6 just flagged, and they spawn duplicate per-game driver/overlay profiles so tuning lands on a copy the user never launches.

**Never guess which copy is live from folder names or sizes.** Rank the evidence:

1. **Launcher config** — the authoritative install root and branch. Steam: `steamapps\appmanifest_<appid>.acf` (`StateFlags`, `BytesDownloaded` vs `BytesToDownload` reveal a stalled or partial install). Riot: `C:\ProgramData\Riot Games\RiotClientInstalls.json`. Battlestate: `%APPDATA%\Battlestate Games\BsgLauncher\settings` (`gamesRootDir` + `selectedBranch`) — **this file also holds auth tokens, so read the fields you need and never echo it wholesale.** Epic: `C:\ProgramData\Epic\UnrealEngineLauncher\LauncherInstalled.dat` (plain JSON despite the extension). Caveats: a Steam manifest can claim FullyInstalled while the folder is absent (mid reinstall/delete) — `Test-Path` every resolved path; and Steam's real "stalled update" signal is StateFlags bit 512 (UpdatePaused), not a bytes-downloaded delta.
2. **Registry uninstall entries** — `InstallLocation` under `HKLM:\SOFTWARE\{,WOW6432Node\}Microsoft\Windows\CurrentVersion\Uninstall\*`. What the vendor thinks is installed. Epic often registers NO uninstall key at all (Fortnite doesn't) — registry absence is not evidence a copy is untracked. Identical DisplayNames can point at different (or nonexistent) paths, so key on InstallLocation, and filter out entries with a blank one.
3. **Log/save directory mtime inside each copy** — proof of *actually played*. A game's own `Logs\` folder timestamps beat file dates on the exe (which only show when it was patched).

```powershell
# Phase 7 - install hygiene: tier 1+2 evidence first, exe-scan only as a last-resort fallback.
# Point $name at a family regex matching the game's DisplayName/exe/manifest, e.g. 'Tarkov','LeagueClient','Fortnite'
# Read-only. Never deletes or modifies anything.
$name = 'Tarkov'

function Decode-StateFlags([int]$s) {
  $map = @(
    @(1,'Uninstalled'), @(2,'UpdateRequired'), @(4,'FullyInstalled'), @(8,'Encrypted'),
    @(16,'Locked'), @(32,'FilesMissing'), @(64,'AppRunning'), @(128,'FilesCorrupt'),
    @(256,'UpdateRunning'), @(512,'UpdatePaused'), @(1024,'UpdateStarted'), @(2048,'Uninstalling'),
    @(4096,'BackupRunning'), @(8192,'Reconfiguring'), @(16384,'Validating'), @(32768,'AddingFiles'),
    @(65536,'Preallocating'), @(131072,'Downloading'), @(262144,'Staging'), @(524288,'Committing')
  )
  # Array of pairs, not an [ordered]@{ int = name } hashtable - PS 5.1's OrderedDictionary
  # resolves an Int32 indexer positionally, not by key, and silently returns the wrong entry.
  $names = foreach ($pair in $map) { if ($s -band $pair[0]) { $pair[1] } }
  if ($names) { $names -join '+' } else { "Unknown($s)" }
}

$candidates = New-Object System.Collections.Generic.List[object]
function Add-Candidate {
  param($Path, $Source, $Tier, $Note, $KnownGB, $KnownLastPlayed)
  if (-not $Path) { return }
  $norm = $Path.TrimEnd('\','/').Replace('/','\')
  $candidates.Add([pscustomobject]@{
    Path = $norm; Source = $Source; Tier = $Tier; Note = $Note
    KnownGB = $KnownGB; KnownLastPlayed = $KnownLastPlayed
  })
}

# ---------- Tier 1: launcher configs (fast, no disk crawl) ----------

# Steam - every library from libraryfolders.vdf
$steamRoot = (Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam' -Name InstallPath -ErrorAction SilentlyContinue).InstallPath
if (-not $steamRoot) { $steamRoot = 'C:\Program Files (x86)\Steam' }
$vdf = Join-Path $steamRoot 'steamapps\libraryfolders.vdf'
$libRoots = @()
if (Test-Path $vdf) {
  $vc = Get-Content $vdf -Raw
  $libRoots = [regex]::Matches($vc, '"path"\s*"([^"]+)"') | ForEach-Object { $_.Groups[1].Value -replace '\\\\', '\' }
}
if (-not $libRoots) { $libRoots = @($steamRoot) }
foreach ($lib in $libRoots) {
  $appsDir = Join-Path $lib 'steamapps'
  if (-not (Test-Path $appsDir)) { continue }
  Get-ChildItem $appsDir -Filter 'appmanifest_*.acf' -ErrorAction SilentlyContinue | ForEach-Object {
    $c = Get-Content $_.FullName -Raw
    if ($c -notmatch $name) { return }
    $idir  = if ($c -match '"installdir"\s*"([^"]+)"') { $Matches[1] } else { $null }
    $state = if ($c -match '"StateFlags"\s*"(\d+)"') { [int]$Matches[1] } else { -1 }
    $lp    = if ($c -match '"LastPlayed"\s*"(\d+)"') { [int64]$Matches[1] } else { 0 }
    $sod   = if ($c -match '"SizeOnDisk"\s*"(\d+)"') { [int64]$Matches[1] } else { $null }
    if ($idir) {
      $lastPlayed = if ($lp -gt 0) { [DateTimeOffset]::FromUnixTimeSeconds($lp).LocalDateTime } else { $null }
      $knownGB = if ($sod) { [math]::Round($sod/1GB,2) } else { $null }
      Add-Candidate (Join-Path $appsDir "common\$idir") 'Steam-manifest' 1 (Decode-StateFlags $state) $knownGB $lastPlayed
    }
  }
}

# Riot - associated_client KEYS are the live install paths
$riotFile = 'C:\ProgramData\Riot Games\RiotClientInstalls.json'
if (Test-Path $riotFile) {
  $rj = Get-Content $riotFile -Raw | ConvertFrom-Json
  $rj.associated_client.PSObject.Properties | Where-Object { $_.Name -match $name } | ForEach-Object {
    Add-Candidate $_.Name 'Riot-client' 1 $null $null $null
  }
}

# Battlestate - read ONLY gamesRootDir; the file holds auth tokens ('login','at','atet','rt') - never echo it
$bsgFile = Join-Path $env:APPDATA 'Battlestate Games\BsgLauncher\settings'
if (Test-Path $bsgFile) {
  $bj = Get-Content $bsgFile -Raw | ConvertFrom-Json
  $root = $bj.gamesRootDir
  if ($root -and (Test-Path $root)) {
    Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $name } | ForEach-Object {
      Add-Candidate $_.FullName 'BSG-gamesRootDir' 1 $null $null $null
    }
  }
}

# Epic - LauncherInstalled.dat is plain JSON
$epicFile = 'C:\ProgramData\Epic\UnrealEngineLauncher\LauncherInstalled.dat'
if (Test-Path $epicFile) {
  $ej = Get-Content $epicFile -Raw | ConvertFrom-Json
  $ej.InstallationList | Where-Object { $_.AppName -match $name -or $_.ArtifactId -match $name } | ForEach-Object {
    Add-Candidate $_.InstallLocation 'Epic-manifest' 1 $null $null $null
  }
}

# ---------- Tier 2: registry uninstall InstallLocation ----------
$regRoots = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
$regRows = foreach ($r in $regRoots) {
  Get-ItemProperty $r -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -match $name -and $_.InstallLocation }
}
foreach ($row in $regRows) {
  Add-Candidate $row.InstallLocation "Registry:$($row.DisplayName)" 2 $null $null $null
}

# ---------- Dedupe by normalized path, keep best (lowest) tier, merge source labels ----------
$grouped = $candidates | Group-Object Path
$candidateSet = @(foreach ($g in $grouped) {
  $best = $g.Group | Sort-Object Tier | Select-Object -First 1
  $srcs = ($g.Group | Select-Object -ExpandProperty Source -Unique) -join ' + '
  [pscustomobject]@{
    Path = $g.Name; Tier = $best.Tier; Sources = $srcs; Note = $best.Note
    KnownGB = $best.KnownGB; KnownLastPlayed = $best.KnownLastPlayed
  }
})

# ---------- Tier 3 fallback: exe crawl, ONLY when tier 1+2 found nothing (untracked copy) ----------
if ($candidateSet.Count -eq 0) {
  "No launcher-config or registry evidence for '$name' - falling back to exe search (fixed drives only)"
  $fixedRoots = (Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3').DeviceID | ForEach-Object { "$_\" }
  $found = foreach ($d in $fixedRoots) {
    Get-ChildItem $d -Recurse -Filter "$name*.exe" -Force -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty DirectoryName
  }
  $found = $found | Sort-Object -Unique
  $candidateSet = @(foreach ($p in $found) {
    [pscustomobject]@{ Path = $p; Tier = 3; Sources = 'exe-scan (untracked)'; Note = $null; KnownGB = $null; KnownLastPlayed = $null }
  })
}

# ---------- Only now touch disk, only for the candidate set - skip work the manifest already gave us ----------
$out = @(foreach ($c in $candidateSet) {
  $exists = Test-Path $c.Path
  $gb = $c.KnownGB
  $lastPlayed = $c.KnownLastPlayed
  if ($exists -and (-not $gb)) {
    $gb = [math]::Round(((Get-ChildItem $c.Path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum/1GB),2)
  }
  if ($exists -and (-not $lastPlayed)) {
    $log = Get-ChildItem $c.Path -Recurse -Directory -Filter 'Logs' -ErrorAction SilentlyContinue |
           ForEach-Object { Get-ChildItem $_.FullName -ErrorAction SilentlyContinue } |
           Sort-Object LastWriteTime -Descending | Select-Object -First 1
    $lastPlayed = $log.LastWriteTime
  }
  [pscustomobject]@{
    Path = $c.Path; Tier = $c.Tier; Sources = $c.Sources; Exists = $exists
    GB = $gb; LastPlayed = $lastPlayed; Note = $c.Note
  }
})
$out | Sort-Object Tier, Exists -Descending | Format-Table Path, Tier, Sources, Exists, GB, LastPlayed, Note -Auto
```

Read the table: `Exists=False` = ghost registry/vdf entry, nothing to clean on disk. `Exists=True` at tier 2/3 only (no launcher corroboration) with an old or empty `LastPlayed` = the stale-copy signal. A path corroborated by both a launcher config and the registry is the live one. A stray `Win32Exception` error line during the tier-3 crawl (broken reparse point or cloud placeholder) is non-fatal — `-ErrorAction SilentlyContinue` doesn't suppress it, but results still return.

**Deleting a game install is irreversible (re-download only) — confirm the exact paths with the user first, list what's kept, and never infer approval from an earlier unrelated cleanup.** Uninstall through the launcher when the launcher owns it (Steam especially, so the manifest goes too). For copies no launcher tracks: if the registry uninstall entry still has a working `UninstallString`, run that vendor uninstaller first — it's more likely to release file locks and clean its own registry/driver-profile leftovers than a manual delete. Delete the folder by hand and remove the matching registry uninstall key yourself only when the vendor uninstaller is missing or broken. Either way, if an anti-cheat service (BattlEye, EAC, Vanguard) is still running, its driver can keep game files locked and turn the delete into a partial one — stop the service, or reboot, first.

After removing installs, the vendor overlay's profile list is stale — see the NVIDIA note below.

### Phase 8 — DPC/ISR latency (audio pops/crackle, micro-stutter, input hitches unexplained by Phases 1-6)

DPC (Deferred Procedure Call) and ISR (Interrupt Service Routine) latency is a distinct failure mode from anything Phases 1-6 catch: a driver that runs too long at DISPATCH_LEVEL blocks every other interrupt on that CPU core, which shows up as audio clicks/pops, micro-stutter (sub-frame hitches, not full freezes or drops), or jittery mouse polling — with GPU clocks, CPU load, and temps all looking perfectly normal. Only run this phase when the symptom fits and the rest of the sweep came back clean; it's slower than Phases 1-6 and its deep pass needs the user to run a command themselves.

**Screening pass — non-elevated, always safe, run this first:**

```powershell
"### DPC/ISR screening - non-elevated PDH counters (same data Task Manager/Resource Monitor use, no admin needed)"
try {
  $agg = Get-Counter -Counter '\Processor(_Total)\% DPC Time','\Processor(_Total)\% Interrupt Time','\Processor(_Total)\Interrupts/sec' -SampleInterval 1 -MaxSamples 5 -ErrorAction Stop
  $agg.CounterSamples | Group-Object Path | ForEach-Object {
    $avg = ($_.Group.CookedValue | Measure-Object -Average).Average
    "{0,-45} avg/5s = {1:N3}" -f $_.Name, $avg
  }
} catch { "Get-Counter failed: $_ (perf counter DB may need 'lodctr /r' from an elevated prompt - not something to run automatically)" }

"`n### Per-core DPC queue - a hot core hiding behind a calm aggregate is the real tell"
try {
  $perCore = (Get-Counter -Counter '\Processor(*)\DPCs Queued/sec' -SampleInterval 1 -MaxSamples 3 -ErrorAction Stop).CounterSamples |
    Group-Object InstanceName | ForEach-Object {
      [pscustomobject]@{ Core = $_.Name; AvgPerSec = [math]::Round(($_.Group.CookedValue | Measure-Object -Average).Average, 1) }
    }
  $total = ($perCore | Where-Object Core -eq '_total').AvgPerSec
  $cores = $perCore | Where-Object Core -ne '_total' | Sort-Object AvgPerSec -Descending
  $cores | Select-Object -First 5 | Format-Table -Auto
  "Total (all cores): $total /sec"
  if ($total -gt 0 -and $cores[0].AvgPerSec -gt ($total * 0.4)) {
    "<-- core {0} alone carries {1:P0} of all DPCs - one device is likely IRQ/MSI-pinned there, not a system-wide problem" -f $cores[0].Core, ($cores[0].AvgPerSec/$total)
  }
} catch { "Get-Counter failed: $_" }
```

These are ordinary PDH performance counters (`\Processor(_Total)\% DPC Time`, `\Processor(*)\DPCs Queued/sec`) — the same data source behind Task Manager and Resource Monitor, readable by any local user, no elevation, no ETW session, no ADK. `Get-WinEvent` is **not** a path to this data: Kernel-Power and every other classic Event Log provider log power-state transitions and crashes (already covered in Phase 3), never per-DPC execution time — there is no Windows Event Log channel for that. DPC/ISR *duration* only exists inside an ETW kernel trace, which is what the elevated pass below is for.

**Read it:** there's no single industry-agreed "problem" percentage for the aggregate counters — most gaming rigs sit under roughly 1% sustained `% DPC Time` and `% Interrupt Time` at idle or light load, with brief spikes into the low single digits during heavy disk/network activity being normal and not by itself a sign of trouble. The more diagnostic signal is the **per-core breakdown**: a system-wide average can look calm while one core is doing almost all the work. If one core's `DPCs Queued/sec` is a large majority of the machine's total while the rest sit near zero, that's a specific device's interrupts pinned to that core (IRQ/MSI-X affinity) — it narrows the search to "one busy device," but `Get-Counter` cannot name which driver; that needs the deep pass or LatencyMon.

Classic offending drivers, worth naming to the user even before a trace confirms it: **ndis.sys** (Wi-Fi/Ethernet, especially wireless combined with aggressive power-saving), **nvlddmkm.sys** (NVIDIA GPU kernel driver, especially with MSI mode disabled or aggressive P-states), **storport.sys** (storage HBA — SATA/NVMe controller queueing, common on laptops under CPU throttling), **ACPI.sys** (BIOS/firmware table issues, thermal zone polling), and **usbport.sys/USBXHCI** (USB controllers, occasionally an SD/MMC card reader). Microsoft's own driver-design guidance is that a single ISR should run under about 25 microseconds and a single DPC under about 100 microseconds — sustained or recurring executions well beyond that (hundreds of microseconds into low milliseconds) are what produce audible/visible stutter, and that per-event timing is exactly what the aggregate PDH counters above cannot show.

**LatencyMon** (Resplendence Software, free, third-party GUI) gives that per-driver microsecond breakdown live, with its own built-in verdict bands (green under ~1000 microseconds highest measured interrupt-to-process latency, yellow ~1000-2000, red over ~2000). It is the easiest path to real attribution if the user is willing to install something — confirm it isn't already present (`Get-Command latencymon* -ErrorAction SilentlyContinue`, check the uninstall registry keys and `Program Files`) and offer it only as an optional suggestion; never install it without the user's explicit OK.

**Elevated deep pass — hand the commands to the user, do not self-elevate:**

```powershell
# Phase 8 elevated deep pass - agent writes+validates the profile (non-elevated), hands wpr/tracerpt commands to the user
$dpcDir = Join-Path $env:TEMP 'rig-doctor-dpcisr'
if (-not (Test-Path $dpcDir)) { New-Item -ItemType Directory $dpcDir | Out-Null }
$wprp = Join-Path $dpcDir 'dpcisr.wprp'
$etl  = Join-Path $dpcDir 'dpcisr-trace.etl'
$csv  = Join-Path $dpcDir 'dpcisr-dump.csv'

# In-box wpr.exe's built-in "CPU" profile does NOT capture DPC/Interrupt keywords (verified via
# 'wpr -profiledetails CPU.verbose' - only CpuConfig/CSwitch/IdealProcessor/Loader/MemoryInfo/Power/
# ProcessThread/ReadyThread/SampledProfile/ThreadPriority). DPC and Interrupt ARE valid SystemProvider
# keyword values in WPR's own profile schema though (Microsoft Learn: Keyword (in SystemProvider)),
# so a hand-authored .wprp captures real DPC/ISR events without installing the ADK.
@'
<?xml version="1.0" encoding="utf-8"?>
<WindowsPerformanceRecorder Version="1.0" Author="rig-doctor" Comments="Minimal DPC/ISR duration capture, no ADK required" Company="rig-doctor">
  <Profiles>
    <SystemCollector Id="DpcIsr_SystemCollector" Name="NT Kernel Logger">
      <BufferSize Value="1024"/>
      <Buffers Value="64"/>
    </SystemCollector>
    <SystemProvider Id="DpcIsr_SystemProvider">
      <Keywords>
        <Keyword Value="DPC"/>
        <Keyword Value="Interrupt"/>
        <Keyword Value="CSwitch"/>
        <Keyword Value="ProcessThread"/>
        <Keyword Value="Loader"/>
      </Keywords>
      <Stacks>
        <Stack Value="CSwitch"/>
      </Stacks>
    </SystemProvider>
    <Profile Id="DpcIsr.Verbose.File" Name="DpcIsr" DetailLevel="Verbose" LoggingMode="File" Description="DPC and ISR duration capture">
      <ProblemCategories>
        <ProblemCategory Value="First Level Triage"/>
      </ProblemCategories>
      <Collectors>
        <SystemCollectorId Value="DpcIsr_SystemCollector">
          <SystemProviderId Value="DpcIsr_SystemProvider"/>
        </SystemCollectorId>
      </Collectors>
    </Profile>
    <Profile Id="DpcIsr.Verbose.Memory" Name="DpcIsr" DetailLevel="Verbose" LoggingMode="Memory" Description="DPC and ISR duration capture">
      <ProblemCategories>
        <ProblemCategory Value="First Level Triage"/>
      </ProblemCategories>
      <Collectors>
        <SystemCollectorId Value="DpcIsr_SystemCollector">
          <SystemProviderId Value="DpcIsr_SystemProvider"/>
        </SystemCollectorId>
      </Collectors>
    </Profile>
  </Profiles>
</WindowsPerformanceRecorder>
'@ | Out-File $wprp -Encoding utf8

"### Validating the profile read-only (parses/checks schema, does NOT start a trace)"
& wpr.exe -profiledetails "$wprp!DpcIsr.Verbose" 2>&1
if ($LASTEXITCODE -ne 0) { "wpr -profiledetails failed (exit $LASTEXITCODE) - do not hand the commands below to the user until this is clean" }
else {
"
Profile OK. Hand these to the user - run in an ELEVATED PowerShell or cmd (this agent will not self-elevate):

  wpr -start `"$wprp!DpcIsr.Verbose`" -filemode
  REM reproduce the stutter/pop/hitch now, 30-60 seconds is enough
  wpr -stop `"$etl`" `"DPC ISR repro`"

wpr.exe's own manifest is asInvoker (no UAC shield) - run non-elevated it will start and then fail
INSIDE the tool when it opens the NT Kernel Logger session, since that needs Administrator group
membership. Treat any non-zero exit or 'Error' text from wpr as 'not elevated' rather than matching
one specific message - the exact wording is not guaranteed across builds.
"
}

"### Once the user hands back the .etl, this is fully in-box CLI post-processing (no ADK/xperf/wpa needed):"
"  tracerpt `"$etl`" -o `"$csv`" -of CSV -y"
"Filter the CSV for the PerfInfo/SystemTrace provider (guid ce1dbfb4-137e-4da6-87b0-3f59aa102cbc) and"
"group by the resolved module column to rank drivers by DPC/ISR event count. This gives raw event rows,"
"not WPA's automatic per-driver duration rollup - for that, the practical path is installing the free"
"'Windows Performance Analyzer (Preview)' Store app (much smaller than the full ADK) and opening the"
"same .etl there, DPC/ISR graph grouped by module."
```

**Why this specific design:** `wpr.exe` ships in-box on every Windows 10/11 install and needs nothing downloaded, but `xperf.exe`/`wpa.exe`/`wpaexporter.exe` do not — they only exist if the user has separately installed the Windows ADK's Windows Performance Toolkit (check with `Get-Command xperf -ErrorAction SilentlyContinue` before ever assuming it's there; don't tell the user to run `xperf -i` without confirming it exists first). Starting the actual trace requires Administrator group membership at the ETW/kernel layer, independent of `wpr.exe`'s own UAC manifest — so a non-admin invocation won't show a shield-icon UAC prompt, it will simply start and then fail inside the tool. That's why the agent hands the commands to the user rather than trying to run `-start` itself, and why the profile is validated with the read-only `-profiledetails` query first — it catches a malformed `.wprp` before anyone runs an elevated command that would otherwise fail for the wrong reason.

## Vendor GUIs: elevation and per-game profiles

Two failure modes waste whole sessions if you don't recognize them.

**Elevated apps swallow synthetic input (UIPI).** If the target app runs elevated and the agent session doesn't, every click and keystroke is dropped *silently* — no error, the cursor doesn't even move, screenshots keep showing the old state. Both computer-use and windows-mcp fail identically. Symptom to recognize: repeated clicks with correct coordinates change nothing and the reported cursor position never updates. Confirm before burning more turns:

```powershell
# Probe the WINDOW-OWNING instance - helper processes can sit at a different integrity level.
# Access-denied on the handle of a process you own = it is running at higher integrity.
$app = 'NVIDIA App'   # <- set to the app under test
$p = Get-Process $app -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { "$app has no window-owning process - is it running?" }
else {
  try { $null = $p.Handle; 'reachable - synthetic input should land' }
  catch [System.ComponentModel.Win32Exception] { 'ELEVATED - synthetic input will be dropped (UIPI)' }
  catch { 'process exited mid-probe - re-run Get-Process' }
}
whoami /groups | Select-String 'Mandatory Level'
```

Multi-process apps (anything CEF-based) can have a mix, so test the instance that owns the window, and re-test after the app restarts — a relaunch through a different path can land at a different integrity level. When it is elevated: do the work through files or a vendor CLI if one exists, otherwise hand the user the exact clicks. Do not try to self-elevate a helper to click for them; that is a bigger privilege grant than the task deserves, and the harness may refuse it outright.

**NVIDIA App has two separate stores — know which one you're looking at.**

| What you see | Where it lives | Editable how |
|---|---|---|
| Home > Library game tiles | `%LOCALAPPDATA%\NVIDIA Corporation\NVIDIA app\NvBackend\ApplicationStorage.json` (+ per-app files in `NvBackend\ApplicationState\`) | Plain JSON. Close the app first (it rewrites on exit), back up, filter by `LocalId`, relaunch |
| Graphics > Program Settings profiles + every driver setting | `C:\ProgramData\NVIDIA Corporation\Drs\nvdrsdb0.bin` | **Binary, proprietary, held open by the driver — do not hand-edit.** Write it via the app's GUI, or NVIDIA Profile Inspector (`.nip` import), which wraps the supported NVAPI `DRS_*` calls |

Editing the JSON cleans the library tiles but leaves Program Settings untouched — they're different stores, and a "the ghosts are gone" claim based on the JSON alone is wrong. Uninstalling a game does **not** remove its driver profile; each install path keeps its own, so a machine with several copies of one game accumulates several profiles and a tuning change can land on the copy the user never launches. After an install cleanup, verify which profile survives and re-apply per-game settings there.

**Scripting per-game driver profiles (NVIDIA Profile Inspector).** Facts verified against NVPI Revamped 2.4.2.3:
- The exe's embedded manifest is `requireAdministrator` — it will not even start non-elevated. But the manifest lives on the apphost wrapper, not the managed code: `dotnet nvidiaProfileInspector.dll <args>` runs identical code non-elevated, no UAC, and DRS reads/writes work from there. A non-elevated GUI instance is also automatable (standard WinForms UIA), unlike the elevated exe.
- There is **no CLI export flag** in this build — export is GUI-only (`File > Export`). **Import IS scriptable**: `dotnet nvidiaProfileInspector.dll <file>.nip -silentImport` applies a profile headlessly.
- A `.nip` is plain XML (UTF-16): root `<Profiles>`, each `<Profile>` carrying `<ProfileName>`, `<Executeables>` (the real match key), and `<Settings><ProfileSetting>` entries with decimal `<SettingID>`/`<SettingValue>` and `<ValueType>`. Setting IDs and value enums come from the `CustomSettingNames.xml` the tool ships with (dump it via `-createCSN`). Two useful ones: CUDA Sysmem Fallback Policy = `0x10ECECC9` (0=driver default, 1=prefer no sysmem fallback), Ultra Low Latency CPL State = `0x0005F543` (0/1/2=off/on/ultra) plus companion Enabled flag `0x10835000`.
- To write a specific game's profile without a GUI export: confirm the driver's predefined profile name first (guessing a name creates a duplicate profile matching the same exe), then hand-craft a minimal `.nip` with an empty `<Executeables />` (updates the existing profile by name instead of re-adding exes) and only the settings you intend. Keep a copy of the pre-change values so the import is reversible. Driver-profile writes are a machine state change — get the user's OK before `-silentImport`.

## Producing the report

Synthesize — **don't dump raw tables back**. Give:

1. **Verdict line** — healthy, or the single most-likely root cause.
2. **Findings table** ranked by severity: `🔴 critical / 🟠 degraded / 🟡 minor / ✅ confirmed-good`, each with observed value vs baseline and a one-line cause.
3. **Fix plan** — concrete, ordered. Mark safe-to-auto-apply (re-assert power plan, relaunch a tuning tool, clear a stuck process) vs needs-user (BIOS re-enable XMP/EXPO, dial back an OC, reseat hardware, anything inside an elevated GUI). **Apply only with the user's OK**; show the exact command or diff first.
4. If nothing's wrong system-side and the complaint is game-specific, say so and point at in-game settings or known game issues rather than chasing ghosts in Windows.

## Maintenance

After any *intentional* retune (new BIOS, different XMP/EXPO profile, GPU OC change, fresh Windows install), update the baseline — edit `baseline.md` if that's what this machine uses, or re-run Phase 0. Drift detection is only as good as the baseline. Findings that are *procedure* (a new failure mode, a better probe) belong here in SKILL.md and are worth upstreaming to the public plugin; findings that are *this machine's values* belong in the baseline. Keep the two from mixing.
