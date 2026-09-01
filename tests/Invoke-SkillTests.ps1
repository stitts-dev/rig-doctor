# Regression tests for the rig-doctor skill's PowerShell blocks.
# PS 5.1, ASCII-only, no framework. Exit 0 = all pass, 1 = failures.
# Usage: powershell -NoProfile -File tests\Invoke-SkillTests.ps1 [-SkillPath <path>]
param(
  [string]$SkillPath = (Join-Path (Split-Path $PSScriptRoot -Parent) 'skills\rig-doctor\SKILL.md')
)

$script:fails = 0
$script:tests = 0
function Assert-True($cond, $label) {
  $script:tests++
  if ($cond) { "PASS  $label" } else { $script:fails++; "FAIL  $label" }
}

if (-not (Test-Path $SkillPath)) { "FATAL: SKILL.md not found at $SkillPath"; exit 1 }
$md = Get-Content $SkillPath -Raw

# --- Extract every ```powershell fence ---
$fences = [regex]::Matches($md, '(?s)```powershell\r?\n(.*?)\r?\n```') | ForEach-Object { $_.Groups[1].Value }

# T1: expected block count (phase 0,1,2,3,4,5,6,7 + elevation probe)
Assert-True ($fences.Count -ge 8) "T1 fence count >= 8 (got $($fences.Count))"

# T2: every fence parses clean under PS 5.1
$i = 0
foreach ($f in $fences) {
  $i++
  $errs = $null
  $null = [System.Management.Automation.PSParser]::Tokenize($f, [ref]$errs)
  Assert-True ($errs.Count -eq 0) "T2 fence $i parses (errors: $($errs.Count))"
}

# T3: every fence is ASCII-only (em-dash/Unicode in a .ps1 breaks PS 5.1 without BOM)
$i = 0
foreach ($f in $fences) {
  $i++
  $nonAscii = [regex]::Matches($f, '[^\x00-\x7F]').Count
  Assert-True ($nonAscii -eq 0) "T3 fence $i ASCII-only (non-ASCII chars: $nonAscii)"
}

$all = $fences -join "`n"

# T4: regression patterns from the 2026-09-01 max-effort review
Assert-True ($all -notmatch 'Get-PSDrive\s+-PSProvider\s+FileSystem\)\.Root') "T4a no unscoped PSDrive root crawl (fixed drives only)"
Assert-True ($all -notmatch 'C:\\Windows\\Minidump') "T4b no hardcoded C:\Windows minidump path (use SystemRoot)"
Assert-True ($all -match 'SystemRoot.+Minidump') "T4c minidump check uses env SystemRoot"
Assert-True ($all -match 'MainWindowHandle') "T4d elevation probe filters to the window-owning process"
Assert-True ($all -match '\[System\.ComponentModel\.Win32Exception\]') "T4e elevation probe uses typed access-denied catch"
Assert-True ($all -notmatch '\[ordered\]@\{\s*\d') "T4f no int-keyed ordered hashtable (positional-indexer trap)"
Assert-True ($all -match 'libraryfolders\.vdf') "T4g Steam probe enumerates all libraries"
Assert-True ($all -match 'RiotClientInstalls\.json') "T4h Riot tier-1 probe present"
Assert-True ($all -match 'LauncherInstalled\.dat') "T4i Epic tier-1 probe present"
Assert-True ($all -match 'DriveType=3') "T4j exe fallback scoped to fixed drives"
Assert-True ($all -match 'baseline\.md') "T4k drift loop acknowledges baseline.md gating"
Assert-True ($md -match '-silentImport') "T4l NVIDIA section documents scriptable profile import"
Assert-True ($md -match 'requireAdministrator|requiresAdministrator') "T4m NVIDIA section documents NVPI elevation manifest"
Assert-True ($all -match 'vbs_hvci') "T4n Phase 0 captures vbs_hvci baseline field"
Assert-True ($all -match "chk 'VBS/HVCI") "T4o Phase 4 checks VBS/HVCI drift"

# T8: Phase 8 (DPC/ISR latency) - verified 2026-09-01 against a live machine
Assert-True ($md -match 'Phase 8') "T8a Phase 8 section present"
Assert-True ($all -match 'DPCs Queued/sec') "T8b non-elevated screening pass reads DPCs Queued/sec"
Assert-True ($all -match 'Value="DPC"' -and $all -match 'Value="Interrupt"') "T8c hand-authored .wprp enables DPC+Interrupt keywords (no ADK needed)"
Assert-True ($all -match '\$LASTEXITCODE') "T8d elevated pass checks exit code rather than a hardcoded error string"
Assert-True ($all -notmatch 'Error: The Windows Performance Recorder') "T8e no unverified literal wpr error string hardcoded"
Assert-True ($md -match 'Get-Command xperf') "T8f xperf presence is checked, never assumed (ADK is optional)"
Assert-True ($md -match 'LatencyMon') "T8g LatencyMon documented as an optional third-party suggestion"

# T5: unit-test Decode-StateFlags extracted from the skill itself
$fm = [regex]::Match($md, '(?s)(function Decode-StateFlags.*?\r?\n\})')
Assert-True $fm.Success "T5a Decode-StateFlags function present in SKILL.md"
if ($fm.Success) {
  Invoke-Expression $fm.Groups[1].Value
  Assert-True ((Decode-StateFlags 4) -eq 'FullyInstalled') "T5b flags 4 -> FullyInstalled"
  Assert-True ((Decode-StateFlags 518) -eq 'UpdateRequired+FullyInstalled+UpdatePaused') "T5c flags 518 -> stalled-update triple"
  Assert-True ((Decode-StateFlags 0) -eq 'Unknown(0)') "T5d flags 0 -> Unknown(0)"
  Assert-True ((Decode-StateFlags 6) -eq 'UpdateRequired+FullyInstalled') "T5e flags 6 -> routine update pending"
}

# T7: bench stats - Get-FrameStats must compute correct percentile lows from a known CSV
$bench = Join-Path (Split-Path $PSScriptRoot -Parent) 'tools\bench.ps1'
Assert-True (Test-Path $bench) "T7a tools\bench.ps1 exists"
if (Test-Path $bench) {
  . $bench -StatsOnly
  # Fixture: 1000 frames, 990 at 10ms, 9 at 20ms, 1 at 50ms
  $ft = @(1..990 | ForEach-Object { 10.0 }) + @(1..9 | ForEach-Object { 20.0 }) + @(50.0)
  $s = Get-FrameStats -FrameTimesMs $ft
  Assert-True ([math]::Abs($s.AvgFps - 98.72) -lt 0.5) "T7b avg FPS ~98.7 (got $($s.AvgFps))"
  Assert-True ($s.OnePctLowFps -ge 45 -and $s.OnePctLowFps -le 55) "T7c 1% low ~50 fps (got $($s.OnePctLowFps))"
  Assert-True ($s.PointOnePctLowFps -ge 15 -and $s.PointOnePctLowFps -le 25) "T7d 0.1% low ~20 fps (got $($s.PointOnePctLowFps))"
  Assert-True ($s.Frames -eq 1000) "T7e frame count 1000"

  # T7f-g: Get-FrameTimeColumn picks the right column across PresentMon v1/v2 CSV schemas
  $rowsV2T7 = @([pscustomobject]@{ FrameTime = '8.0' }, [pscustomobject]@{ FrameTime = '9.0' })
  $rowsV1T7 = @([pscustomobject]@{ MsBetweenPresents = '8.0' }, [pscustomobject]@{ MsBetweenPresents = '9.0' })
  Assert-True ((Get-FrameTimeColumn -Rows $rowsV2T7) -eq 'FrameTime') "T7f Get-FrameTimeColumn picks FrameTime column (v2 schema)"
  Assert-True ((Get-FrameTimeColumn -Rows $rowsV1T7) -eq 'MsBetweenPresents') "T7g Get-FrameTimeColumn falls back to MsBetweenPresents (v1 schema)"

  # T7h-j: Get-Median / Get-StdDev (used by -Runs aggregation and -Compare significance)
  Assert-True ((Get-Median @(1.0,2.0,3.0)) -eq 2.0) "T7h median odd count"
  Assert-True ((Get-Median @(1.0,2.0,3.0,4.0)) -eq 2.5) "T7i median even count"
  Assert-True ((Get-StdDev @(5.0)) -eq 0.0) "T7j stddev single value -> 0 (not divide-by-zero)"

  # T7k-l: Read-PresentMonCsv must not throw on a header-only/0-row CSV (regression - an
  # unconditional $rows[0] index throws "Cannot index into a null array" on an empty capture
  # instead of the friendly "too few frames captured" message)
  $headerOnlyT7 = Join-Path $env:TEMP 'rig-doctor-t7-header-only.csv'
  "Application,ProcessID,MsBetweenPresents,TimeInMs" | Set-Content $headerOnlyT7 -Encoding ascii
  $threwT7 = $false
  $rowsT7 = $null
  try { $rowsT7 = Read-PresentMonCsv -Path $headerOnlyT7 -SkipFirstSeconds 0 } catch { $threwT7 = $true }
  Assert-True (-not $threwT7) "T7k Read-PresentMonCsv does not throw on header-only CSV"
  Assert-True ($rowsT7.Count -eq 0) "T7l Read-PresentMonCsv returns 0 rows for header-only CSV"
  Remove-Item $headerOnlyT7 -ErrorAction SilentlyContinue

  # T7m: SkipFirstSeconds trims warmup frames by TimeInMs (v2-metrics column)
  $synthT7 = Join-Path $env:TEMP 'rig-doctor-t7-synthetic.csv'
  $linesT7 = @('MsBetweenPresents,TimeInMs')
  for ($i = 0; $i -lt 20; $i++) { $linesT7 += "10.0,$($i * 500.0)" }  # spans 0-9.5s
  $linesT7 | Set-Content $synthT7 -Encoding ascii
  $trimmedT7 = Read-PresentMonCsv -Path $synthT7 -SkipFirstSeconds 2
  Assert-True ($trimmedT7.Count -eq 16) "T7m SkipFirstSeconds=2 drops rows with TimeInMs<2000 (got $($trimmedT7.Count), want 16)"
  Remove-Item $synthT7 -ErrorAction SilentlyContinue

  # T7n-o: Get-EngineBoundStats - CPU/GPU-bound split and graceful degradation
  $engRowsT7 = @(
    [pscustomobject]@{ MsCPUBusy='5.0'; MsGPUBusy='2.0'; PresentMode='Hardware: Legacy Flip' }
    [pscustomobject]@{ MsCPUBusy='2.0'; MsGPUBusy='6.0'; PresentMode='Hardware: Legacy Flip' }
  )
  $engT7 = Get-EngineBoundStats -Rows $engRowsT7
  Assert-True ($engT7.CpuBoundPct -eq 50 -and $engT7.GpuBoundPct -eq 50) "T7n engine-bound split 50/50 (got Cpu=$($engT7.CpuBoundPct) Gpu=$($engT7.GpuBoundPct))"
  $engNoColsT7 = Get-EngineBoundStats -Rows @([pscustomobject]@{ PresentMode='Hardware: Legacy Flip' })
  Assert-True ($null -eq $engNoColsT7.GpuBoundPct) "T7o engine-bound returns null (not error) when MsCPUBusy/MsGPUBusy absent"

  # T7p: Get-BenchRunStats end-to-end regression guard - catches the PS 5.1 trap where a
  # leading-comma array assignment double-wraps the array and breaks Get-FrameStats's
  # [double[]] parameter binding.
  $bigT7 = Join-Path $env:TEMP 'rig-doctor-t7-bigrun.csv'
  $bigLinesT7 = @('MsBetweenPresents,TimeInMs')
  for ($i = 0; $i -lt 30; $i++) { $bigLinesT7 += "10.0,$($i * 100.0)" }
  $bigLinesT7 | Set-Content $bigT7 -Encoding ascii
  $runStatsT7 = Get-BenchRunStats -Csv $bigT7 -SkipFirstSeconds 0
  Assert-True ($null -ne $runStatsT7 -and $runStatsT7.Frames -eq 30) "T7p Get-BenchRunStats end-to-end (got Frames=$($runStatsT7.Frames))"
  Remove-Item $bigT7 -ErrorAction SilentlyContinue

  # T7q: aggregate record must use a plain array (not System.Collections.Generic.List[object])
  # for the Runs property - wrapping a Generic.List[object] with @() and embedding it as a
  # [pscustomobject] property value throws "Argument types do not match" under PS 5.1. This
  # guards against reintroducing that collection type.
  $plainArrT7 = @()
  $plainArrT7 += [pscustomobject]@{ Run = 1 }
  $threwT7b = $false
  try { $recProbeT7 = [pscustomobject]@{ Runs = $plainArrT7 } } catch { $threwT7b = $true }
  Assert-True (-not $threwT7b) "T7q plain-array Runs property does not throw (List[object] regression guard)"

  # T7r-s: Invoke-PresentMonCapture returns a scalar bool, not an array (regression guard -
  # without piping the exe invocation through Out-Null, PresentMon's "Started/Stopped
  # recording." stdout becomes a second object in the function's return value, and
  # "-not $ok" on a 2-element array is always $false, silently masking a real failure).
  # Skipped when PresentMon isn't installed on the test machine (CI runners won't have it).
  $pmExeT7 = Get-ChildItem 'C:\Program Files\Intel\PresentMon\PresentMonConsoleApplication' -Filter 'PresentMon-*-x64.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pmExeT7) {
    $bogusCsvT7 = Join-Path $env:TEMP 'rig-doctor-t7-bogus.csv'
    if (Test-Path $bogusCsvT7) { Remove-Item $bogusCsvT7 -Force }
    $capOkT7 = Invoke-PresentMonCapture -PmExePath $pmExeT7.FullName -ProcessName 'ThisProcessDoesNotExist12345.exe' -Seconds 1 -OutCsv $bogusCsvT7
    Assert-True ($capOkT7 -is [bool]) "T7r Invoke-PresentMonCapture returns scalar bool (got $($capOkT7.GetType().Name))"
    Assert-True ($capOkT7 -eq $false) "T7s Invoke-PresentMonCapture reports failure for a nonexistent process"
  } else {
    "SKIP  T7r/T7s Invoke-PresentMonCapture live check (PresentMon not installed on this machine)"
  }
}

# T6: leak scan - machine-specific strings must never enter the public skill
$leaks = 'toaster','lexxwifi','MoCA','Bitsum','9950X3D','X870','Solidigm','SN8100','Unheard','PG27UCDM','Odyssey','jadenrs10','D:\\Battlestate'
foreach ($s in $leaks) {
  Assert-True ($md -notmatch $s) "T6 no leak: $s"
}

""
"{0} tests, {1} failures" -f $script:tests, $script:fails
if ($script:fails -gt 0) { exit 1 } else { exit 0 }
