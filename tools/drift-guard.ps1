# drift-guard.ps1 - Headless Phase 4 tuning-drift sweep for rig-doctor, with an optional
# manual-only safe auto-fix. PS 5.1, ASCII-only.
#
# AUTHORITATIVE CHECK LIST: skills\rig-doctor\SKILL.md's Phase 4 is the source of truth for
# which fields count as tuning drift. This script mirrors that field list by hand (same
# registry paths, same nvidia-smi fields, same string-equality drift semantics as SKILL.md's
# chk()) so it can run headless/unattended without an agent walking the skill. If you add a
# new check to Phase 4, add the matching Add-DriftCheck call here too, or this script silently
# falls behind what SKILL.md promises to catch.
#
# Scope: read-only against the system EXCEPT the drift report files it writes under
# %USERPROFILE%\.rig-doctor\drift\, and, only when -AutoFix is passed, the two HKCU values on
# the SAFE list below. It never touches power plan/services, HKLM values, BIOS-level anything,
# or driver settings - if a drifted item isn't on the SAFE list it is reported only, never
# changed.
#
# -AutoFix is MANUAL-ONLY. Never register a scheduled task that passes -AutoFix - an
# unattended trigger silently rewriting registry values with no per-change confirmation
# breaks this skill's "nothing writes without an explicit OK" rule (SKILL.md line 17). The
# detect-only invocation below (no -AutoFix) is the only variant meant to run unattended; see
# SKILL.md's "Drift guard" section for the schtasks command to hand the user, which this
# script does not call itself.
#
# No toast/notification mechanism: earlier drafts of this script used
# ToastNotificationManager.CreateToastNotifier('Microsoft.Windows.Explorer') to raise a
# desktop toast, which was rejected in review - a non-packaged script has no AUMID of its
# own, and borrowing File Explorer's makes a rig-doctor alert visually present as coming from
# Explorer (and ties its visibility to whatever Focus Assist/notification settings the user
# has for Explorer, for unrelated reasons). Drift is instead reported to the console output
# stream (suppress with -Quiet) and always to the JSON report file - no desktop popup.
#
# Baseline: reads %USERPROFILE%\.rig-doctor\baseline.json (the Phase 0 auto-capture) and
# mirrors the SKILL.md Phase 4 field list exactly. It does NOT read baseline.md - the curated
# baseline is a human/agent-facing document with rationale; walking it is an agent's job, not
# this script's.
#
# watch_processes relaunch: baseline.json's watch_processes is names-only (see Phase 0), which
# is not enough to relaunch anything. This script also reads an optional, backward-compatible
# baseline.watch_process_paths object (name -> full exe path) if present, and falls back to a
# read-only lookup of HKLM:\...\App Paths\<name>.exe. If neither resolves a path, the drift is
# still reported, just not auto-relaunched - never guessed, never searched the drive.
#
# Usage:
#   Detect only (default):        .\drift-guard.ps1
#   Detect + safe auto-fix:       .\drift-guard.ps1 -AutoFix
#   Custom retention:             .\drift-guard.ps1 -KeepLast 90
#   Suppress console alert line:  .\drift-guard.ps1 -Quiet
#   Load functions only (tests):  . .\drift-guard.ps1 -TestOnly
#
# Exit codes: 0 = no baseline present, or no unresolved drift after this run.
#             1 = drift remains unresolved after this run.
#             2 = script-level error (report dir unwritable, baseline.json unreadable, etc).
[CmdletBinding()]
param(
  [switch]$AutoFix,
  [int]$KeepLast = 60,
  [string]$BaselinePath = (Join-Path $env:USERPROFILE '.rig-doctor\baseline.json'),
  [string]$ReportDir = (Join-Path $env:USERPROFILE '.rig-doctor\drift'),
  [switch]$Quiet,
  [switch]$TestOnly
)

# ---------- pure-ish helpers (fixture-testable, no system writes) ----------

function Test-Drift {
  # Mirrors SKILL.md Phase 4's chk(): unset/blank baseline means "not tracked", never drift.
  param($Actual, $Baseline)
  if ($null -eq $Baseline -or "$Baseline" -eq '') { return $false }
  return ("$Actual" -ne "$Baseline")
}

function Test-SafeFixEligible {
  # A SAFE-list fix only fires when (a) there is real drift AND (b) the baseline's own
  # intended value already agrees with the safe target - so this never fights a baseline
  # that intentionally wants Game Mode / GameDVR on. If the user intended the change, Phase
  # 4's own guidance is to update the baseline, not have a script overwrite their choice.
  param($BaselineValue, $ActualValue, $TargetValue = 0)
  if (-not (Test-Drift $ActualValue $BaselineValue)) { return $false }
  return ("$BaselineValue" -eq "$TargetValue")
}

function Get-PruneCandidates {
  # Returns the FileInfo objects to delete to keep only the newest $KeepLast reports.
  # Filenames are 'drift-yyyyMMdd-HHmmss.json' so lexicographic Name sort == chronological.
  param([string]$Dir, [int]$KeepLast)
  if (-not (Test-Path $Dir)) { return @() }
  $files = @(Get-ChildItem -Path $Dir -Filter 'drift-*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
  if ($files.Count -le $KeepLast) { return @() }
  return $files | Select-Object -Skip $KeepLast
}

function Resolve-WatchProcessPath {
  # Read-only path resolution. Never crawls the filesystem.
  param([string]$Name, $BaselinePaths)
  if ($BaselinePaths -and $BaselinePaths.PSObject.Properties[$Name]) {
    $p = $BaselinePaths.$Name
    if ($p -and (Test-Path $p)) { return $p }
  }
  $appPathsKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$Name.exe"
  if (Test-Path $appPathsKey) {
    $v = (Get-ItemProperty -Path $appPathsKey -ErrorAction SilentlyContinue).'(default)'
    if ($v -and (Test-Path $v)) { return $v }
  }
  return $null
}

function Add-DriftCheck {
  param($List, $Name, $Actual, $Baseline, [string]$Kind = 'check', $Meta = $null)
  $List.Add([pscustomobject]@{
    Name = $Name; Actual = $Actual; Baseline = $Baseline; Kind = $Kind
    Drift = (Test-Drift $Actual $Baseline); Meta = $Meta
  }) | Out-Null
}

# ---------- SAFE-list fix appliers (the only functions in this file that write anything) ----------

function Set-SafeHkcuFix {
  # SAFE list, HKCU only. Never called against anything outside GameDVR_Enabled / AutoGameModeEnabled.
  param([string]$Name, [string]$Path, [string]$Prop, $Target, $Before)
  $rec = [pscustomobject]@{ Name = $Name; Before = $Before; After = $null; Applied = $false; Error = $null }
  try {
    if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
    Set-ItemProperty -Path $Path -Name $Prop -Value $Target -Type DWord -ErrorAction Stop
    $rec.After = (Get-ItemProperty -Path $Path -Name $Prop -ErrorAction SilentlyContinue).$Prop
    $rec.Applied = ($rec.After -eq $Target)
  } catch {
    $rec.Error = $_.Exception.Message
  }
  return $rec
}

function Invoke-WatchProcessRelaunch {
  param([string]$Name, [string]$Path)
  $rec = [pscustomobject]@{ Name = "watch_process:$Name"; Before = 'not_running'; After = $null; Applied = $false; Error = $null }
  if (-not $Path) {
    $rec.Error = 'no known executable path (add to baseline.watch_process_paths, or register HKLM App Paths) - not relaunched'
    return $rec
  }
  try {
    Start-Process -FilePath $Path -ErrorAction Stop | Out-Null
    Start-Sleep -Milliseconds 500
    $stillDown = -not (Get-Process -Name $Name -ErrorAction SilentlyContinue)
    $rec.Applied = -not $stillDown
    $rec.After = if ($rec.Applied) { 'running' } else { 'still_not_running (relaunch may still be starting)' }
  } catch {
    $rec.Error = $_.Exception.Message
  }
  return $rec
}

# ---------- report I/O ----------

function Write-DriftReport {
  param([string]$ReportDir, $Checks, $Fixes, [bool]$BaselineFound, [bool]$AutoFixRequested)
  if (-not (Test-Path $ReportDir)) { New-Item -ItemType Directory -Path $ReportDir -Force | Out-Null }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $file = Join-Path $ReportDir "drift-$stamp.json"
  $driftCount = @($Checks | Where-Object { $_.Drift -and $_.Kind -ne 'note' }).Count
  $report = [ordered]@{
    generated         = (Get-Date).ToString('s')
    host              = $env:COMPUTERNAME
    baseline_found    = $BaselineFound
    autofix_requested = $AutoFixRequested
    drift_count       = $driftCount
    checks            = $Checks
    fixes             = $Fixes
  }
  $report | ConvertTo-Json -Depth 6 | Out-File -FilePath $file -Encoding utf8
  return $file
}

# ---------- entry point ----------

if ($TestOnly) { return }

try {
  $baselineFound = Test-Path $BaselinePath
  $b = $null
  if ($baselineFound) {
    try { $b = Get-Content -Path $BaselinePath -Raw | ConvertFrom-Json }
    catch { $baselineFound = $false }
  }

  $checks = New-Object System.Collections.Generic.List[object]

  if ($baselineFound) {
    $nvsmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($nvsmi) {
      $gpuLimit = $null
      try { $gpuLimit = [int](& nvidia-smi --query-gpu=power.limit --format=csv,noheader,nounits) } catch { $gpuLimit = $null }
      Add-DriftCheck $checks 'gpu_power_limit_w' $gpuLimit $b.gpu_power_limit_w
      $gpuDriver = $null
      try { $gpuDriver = (& nvidia-smi --query-gpu=driver_version --format=csv,noheader) } catch { $gpuDriver = $null }
      Add-DriftCheck $checks 'gpu_driver' $gpuDriver $b.gpu_driver 'note'
    }
    Add-DriftCheck $checks 'ram_clock' ((Get-CimInstance Win32_PhysicalMemory | Select-Object -First 1).ConfiguredClockSpeed) $b.ram_clock
    Add-DriftCheck $checks 'pagefile_auto' ((Get-CimInstance Win32_ComputerSystem).AutomaticManagedPagefile) $b.pagefile_auto
    Add-DriftCheck $checks 'pagefile' (((Get-CimInstance Win32_PageFileSetting | ForEach-Object { "$($_.InitialSize)/$($_.MaximumSize)" }) -join ',')) $b.pagefile
    Add-DriftCheck $checks 'power_plan' (((powercfg /getactivescheme) -replace '.*\(' -replace '\).*')) $b.power_plan
    Add-DriftCheck $checks 'hags' ((Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers' -Name HwSchMode -ErrorAction SilentlyContinue).HwSchMode) $b.hags
    Add-DriftCheck $checks 'win32_priority' ((Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\PriorityControl' -Name Win32PrioritySeparation -ErrorAction SilentlyContinue).Win32PrioritySeparation) $b.win32_priority
    Add-DriftCheck $checks 'mouse_accel' ((Get-ItemProperty 'HKCU:\Control Panel\Mouse' -Name MouseSpeed -ErrorAction SilentlyContinue).MouseSpeed) $b.mouse_accel
    Add-DriftCheck $checks 'game_mode' ((Get-ItemProperty 'HKCU:\Software\Microsoft\GameBar' -Name AutoGameModeEnabled -ErrorAction SilentlyContinue).AutoGameModeEnabled) $b.game_mode
    Add-DriftCheck $checks 'gamedvr' ((Get-ItemProperty 'HKCU:\System\GameConfigStore' -Name GameDVR_Enabled -ErrorAction SilentlyContinue).GameDVR_Enabled) $b.gamedvr
    Add-DriftCheck $checks 'vbs_hvci' ((Get-CimInstance -Namespace root\Microsoft\Windows\DeviceGuard -ClassName Win32_DeviceGuard -ErrorAction SilentlyContinue).VirtualizationBasedSecurityStatus) $b.vbs_hvci
    Add-DriftCheck $checks 'os_build' ((Get-CimInstance Win32_OperatingSystem).BuildNumber) $b.os_build 'note'

    foreach ($p in $b.watch_processes) {
      $running = [bool](Get-Process -Name $p -ErrorAction SilentlyContinue)
      Add-DriftCheck $checks "watch_process:$p" $(if ($running) { 'running' } else { 'not_running' }) 'running' 'watch_process' $p
    }
  }

  $fixes = New-Object System.Collections.Generic.List[object]

  if ($AutoFix -and $baselineFound) {
    foreach ($item in $checks) {
      if (-not $item.Drift) { continue }
      if ($item.Kind -eq 'check' -and ($item.Name -eq 'game_mode' -or $item.Name -eq 'gamedvr')) {
        if (Test-SafeFixEligible -BaselineValue $item.Baseline -ActualValue $item.Actual -TargetValue 0) {
          if ($item.Name -eq 'game_mode') {
            $fixes.Add((Set-SafeHkcuFix -Name 'game_mode' -Path 'HKCU:\Software\Microsoft\GameBar' -Prop 'AutoGameModeEnabled' -Target 0 -Before $item.Actual)) | Out-Null
          } else {
            $fixes.Add((Set-SafeHkcuFix -Name 'gamedvr' -Path 'HKCU:\System\GameConfigStore' -Prop 'GameDVR_Enabled' -Target 0 -Before $item.Actual)) | Out-Null
          }
        }
      } elseif ($item.Kind -eq 'watch_process') {
        $path = Resolve-WatchProcessPath -Name $item.Meta -BaselinePaths $b.watch_process_paths
        $fixes.Add((Invoke-WatchProcessRelaunch -Name $item.Meta -Path $path)) | Out-Null
      }
    }
  }

  $driftItems = @($checks | Where-Object { $_.Drift -and $_.Kind -ne 'note' })
  $fixedNames = @($fixes | Where-Object { $_.Applied } | Select-Object -ExpandProperty Name)
  $unresolved = @($driftItems | Where-Object { $fixedNames -notcontains $_.Name })

  if ($driftItems.Count -gt 0 -and -not $Quiet) {
    $names = ($driftItems | Select-Object -ExpandProperty Name) -join ', '
    if ($names.Length -gt 180) { $names = $names.Substring(0, 177) + '...' }
    $title = if ($fixes.Count -gt 0 -and $unresolved.Count -eq 0) { 'rig-doctor: drift auto-fixed' } else { 'rig-doctor: tuning drift detected' }
    "$title -- $($driftItems.Count) item(s) off baseline: $names"
  }

  $reportFile = Write-DriftReport -ReportDir $ReportDir -Checks $checks -Fixes $fixes -BaselineFound $baselineFound -AutoFixRequested ([bool]$AutoFix)

  $prune = Get-PruneCandidates -Dir $ReportDir -KeepLast $KeepLast
  foreach ($f in $prune) { Remove-Item -Path $f.FullName -Force -ErrorAction SilentlyContinue }

  "drift-guard: baseline_found=$baselineFound drift=$($driftItems.Count) fixed=$($fixes.Count) unresolved=$($unresolved.Count) report=$reportFile"

  if (-not $baselineFound) { exit 0 }
  if ($unresolved.Count -gt 0) { exit 1 }
  exit 0
} catch {
  "drift-guard: FATAL - $($_.Exception.Message)"
  exit 2
}
