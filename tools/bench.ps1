# bench.ps1 - PresentMon frametime capture + stats for A/B tuning runs.
# PS 5.1, ASCII-only. Requires Intel PresentMon (console app) installed.
#
# Capture:            .\bench.ps1 -ProcessName EscapeFromTarkov.exe -Seconds 120 -Label "timer-res-on"
# Multi-run:          .\bench.ps1 -ProcessName EscapeFromTarkov.exe -Seconds 120 -Runs 3 -Label "timer-res-on"
# Stats of a CSV:      .\bench.ps1 -Csv path\to\run.csv
# Compare two runs:    .\bench.ps1 -Compare runA.json,runB.json   (comma-separated - see note below)
# Dot-source for functions only: . .\bench.ps1 -StatsOnly
#
# Definitions (CapFrameX-style percentile boundaries):
#   1% low FPS   = 1000 / (frametime of the Nth worst frame, N = ceil(frames*0.01))
#   0.1% low FPS = 1000 / (frametime of the Nth worst frame, N = ceil(frames*0.001))
#   Avg FPS      = frames / total capture time
#
# -Compare takes a comma-separated array ("-Compare a.json,b.json"), not two space-separated
# tokens. Verified empirically: PowerShell 5.1 binds "-Compare a.json b.json" (space-separated)
# by taking ONLY "a.json" into a [string[]] parameter and silently discarding "b.json" - no error,
# no warning. A space-separated two-token form would look correct and quietly compare a.json
# against itself. Comma-separated is the only invocation this script accepts for -Compare.
#
# CSV columns verified against PresentMon 2.5.1 default (v2-metrics) output:
# Application, ProcessID, SwapChainAddress, PresentRuntime, SyncInterval, PresentFlags,
# AllowsTearing, PresentMode, TimeInMs, MsBetweenSimulationStart, MsBetweenPresents,
# MsBetweenDisplayChange, MsInPresentAPI, MsRenderPresentLatency, MsUntilDisplayed,
# CPUStartTimeInMs, MsBetweenAppStart, MsCPUBusy, MsCPUWait, MsGPULatency, MsGPUTime,
# MsGPUBusy, MsGPUWait, MsAnimationError, AnimationTime, MsFlipDelay,
# MsAllInputToPhotonLatency, MsClickToPhotonLatency.
# There is no literal "FrameTime" or "DisplayLatency" column in 2.5.1 (v2 or --v1_metrics);
# the frame-time fallback below is kept because PSObject property lookup is case-insensitive
# and --v1_metrics output uses lowercase "msBetweenPresents", which the same fallback string
# still matches. Click/input-to-photon latency columns exist but read "NA" unless the captured
# process is itself instrumented with click events (not true for an arbitrary process).
#
# -SkipFirstSeconds defaults to 2 (both for fresh captures and for -Csv analysis of an existing
# file) to drop warmup/loading-screen frames. This is a default-on behavior CHANGE from earlier
# versions of this script, which always used 100% of the frames in a CSV - pass
# -SkipFirstSeconds 0 to reproduce the old behavior against an existing capture (see README's
# Benchmarking section for the same callout).
param(
  [string]$ProcessName,
  [int]$Seconds = 60,
  [string]$Label = 'run',
  [string]$Csv,
  [string]$OutDir = (Join-Path $env:USERPROFILE '.rig-doctor\bench'),
  [int]$SkipFirstSeconds = 2,
  [int]$Runs = 1,
  [string[]]$Compare,
  [switch]$StatsOnly
)

function Get-FrameStats {
  param([double[]]$FrameTimesMs)
  $n = $FrameTimesMs.Count
  if ($n -lt 10) { return $null }
  $desc = $FrameTimesMs | Sort-Object -Descending
  $i1   = [Math]::Max([Math]::Ceiling($n * 0.01)  - 1, 0)
  $i01  = [Math]::Max([Math]::Ceiling($n * 0.001) - 1, 0)
  $sum  = ($FrameTimesMs | Measure-Object -Sum).Sum
  [pscustomobject]@{
    Frames            = $n
    AvgFps            = [Math]::Round(1000.0 * $n / $sum, 2)
    AvgFrameTimeMs    = [Math]::Round($sum / $n, 3)
    OnePctLowFps      = [Math]::Round(1000.0 / $desc[$i1], 2)
    PointOnePctLowFps = [Math]::Round(1000.0 / $desc[$i01], 2)
    WorstFrameMs      = [Math]::Round($desc[0], 2)
  }
}

function Get-Median {
  param([double[]]$Values)
  $n = $Values.Count
  if ($n -eq 0) { return $null }
  $s = $Values | Sort-Object
  if ($n % 2 -eq 1) { return [double]$s[($n - 1) / 2] }
  return ([double]$s[$n / 2 - 1] + [double]$s[$n / 2]) / 2.0
}

function Get-StdDev {
  # Sample standard deviation (n-1). Returns 0 for fewer than 2 values.
  param([double[]]$Values)
  $n = $Values.Count
  if ($n -lt 2) { return 0.0 }
  $mean = ($Values | Measure-Object -Average).Average
  $ssq = ($Values | ForEach-Object { ($_ - $mean) * ($_ - $mean) } | Measure-Object -Sum).Sum
  [Math]::Sqrt($ssq / ($n - 1))
}

function Get-FrameTimeColumn {
  # Resolve the per-frame frame-time column name present in a PresentMon CSV's rows.
  param([object[]]$Rows)
  if ($Rows.Count -eq 0) { return $null }
  $p = $Rows[0].PSObject.Properties
  if ($p['FrameTime']) { return 'FrameTime' }
  return 'MsBetweenPresents'
}

function Read-PresentMonCsv {
  # Reads a PresentMon CSV and returns its rows, optionally dropping warmup frames
  # (loading/focus-change pollution) whose capture-relative timestamp is below
  # -SkipFirstSeconds. Handles both the default v2 "TimeInMs" column and the
  # --v1_metrics "TimeInSeconds" column; if neither is present, trimming is skipped
  # rather than failing the whole capture. Never throws on a header-only/0-row CSV.
  param([string]$Path, [double]$SkipFirstSeconds = 0)
  $rows = @(Import-Csv $Path)
  if ($rows.Count -eq 0) { return ,[object[]]@() }
  if ($SkipFirstSeconds -le 0) { return ,[object[]]$rows }
  $p = $rows[0].PSObject.Properties
  if ($p['TimeInSeconds']) {
    return ,[object[]]@($rows | Where-Object { [double]$_.TimeInSeconds -ge $SkipFirstSeconds })
  }
  if ($p['TimeInMs']) {
    $skipMs = $SkipFirstSeconds * 1000.0
    return ,[object[]]@($rows | Where-Object { [double]$_.TimeInMs -ge $skipMs })
  }
  ,[object[]]$rows
}

function Get-EngineBoundStats {
  # Per-frame CPU-bound vs GPU-bound split and present-mode distribution.
  # "Bound" heuristic: whichever engine was busier that frame is the constraint
  # (MsGPUBusy vs MsCPUBusy) - a lazy but directionally-correct read, not a
  # rigorous profiler-grade classification. Returns null fields when the CSV doesn't
  # carry the v2 MsCPUBusy/MsGPUBusy columns (e.g. an old capture or --v1_metrics).
  param([object[]]$Rows)
  $n = $Rows.Count
  if ($n -eq 0) { return $null }
  $p = $Rows[0].PSObject.Properties
  $modes = $null
  if ($p['PresentMode']) {
    $modes = ($Rows | Group-Object PresentMode | Sort-Object Count -Descending |
      ForEach-Object { "{0}: {1:P0}" -f $_.Name, ($_.Count / $n) }) -join '; '
  }
  if (-not ($p['MsCPUBusy'] -and $p['MsGPUBusy'])) {
    return [pscustomobject]@{ GpuBoundPct = $null; CpuBoundPct = $null; PresentModes = $modes }
  }
  $gpu = 0
  foreach ($r in $Rows) {
    if ([double]$r.MsGPUBusy -gt [double]$r.MsCPUBusy) { $gpu++ }
  }
  [pscustomobject]@{
    GpuBoundPct = [Math]::Round(100.0 * $gpu / $n, 1)
    CpuBoundPct = [Math]::Round(100.0 * ($n - $gpu) / $n, 1)
    PresentModes = $modes
  }
}

function Get-BenchRunStats {
  # One capture's stats: frame-time percentiles plus (when available) engine-bound split.
  param([string]$Csv, [double]$SkipFirstSeconds)
  $rows = Read-PresentMonCsv -Path $Csv -SkipFirstSeconds $SkipFirstSeconds
  if ($rows.Count -eq 0) { return $null }
  $ftCol = Get-FrameTimeColumn -Rows $rows
  $ft = [double[]]@($rows | ForEach-Object { [double]$_.$ftCol })
  $stats = Get-FrameStats -FrameTimesMs $ft
  if (-not $stats) { return $null }
  $engine = Get-EngineBoundStats -Rows $rows
  if ($engine) {
    Add-Member -InputObject $stats -NotePropertyName GpuBoundPct   -NotePropertyValue $engine.GpuBoundPct
    Add-Member -InputObject $stats -NotePropertyName CpuBoundPct   -NotePropertyValue $engine.CpuBoundPct
    Add-Member -InputObject $stats -NotePropertyName PresentModes  -NotePropertyValue $engine.PresentModes
  }
  $stats
}

function Invoke-PresentMonCapture {
  # Runs one timed capture. The exe's exit code is always 0 whether or not it found
  # a presenting process (verified empirically), so the only reliable success signal
  # is whether the output CSV actually got created. The trailing "| Out-Null" matters:
  # without it, PresentMon's "Started/Stopped recording." stdout text becomes a SECOND
  # object in this function's return value alongside the Test-Path boolean, so the
  # caller's "$ok = Invoke-PresentMonCapture ..." captures a 2-element array instead of
  # a bool - and "-not $ok" on a non-empty array is always $false, silently masking a
  # real capture failure.
  param([string]$PmExePath, [string]$ProcessName, [int]$Seconds, [string]$OutCsv)
  & $PmExePath --process_name $ProcessName --output_file $OutCsv --timed $Seconds --terminate_after_timed --stop_existing_session --no_console_stats 2>$null | Out-Null
  Test-Path $OutCsv
}

if ($StatsOnly) { return }

if ($Compare) {
  if ($Compare.Count -ne 2) { "-Compare needs exactly 2 comma-separated paths: -Compare runA.json,runB.json"; exit 1 }
  foreach ($cp in $Compare) { if (-not (Test-Path $cp)) { "not found: $cp"; exit 1 } }

  function Get-ComparableRecord {
    param([string]$Path)
    $r = Get-Content $Path -Raw | ConvertFrom-Json
    if ($r.Aggregate) {
      [pscustomobject]@{
        Label = $r.Label; N = $r.N
        AvgFps = $r.Aggregate.AvgFps.Median; AvgFpsStdDev = $r.Aggregate.AvgFps.StdDev
        OnePctLowFps = $r.Aggregate.OnePctLowFps.Median; OnePctLowFpsStdDev = $r.Aggregate.OnePctLowFps.StdDev
        PointOnePctLowFps = $r.Aggregate.PointOnePctLowFps.Median; PointOnePctLowFpsStdDev = $r.Aggregate.PointOnePctLowFps.StdDev
      }
    } else {
      [pscustomobject]@{
        Label = $r.Label; N = 1
        AvgFps = $r.Stats.AvgFps; AvgFpsStdDev = $null
        OnePctLowFps = $r.Stats.OnePctLowFps; OnePctLowFpsStdDev = $null
        PointOnePctLowFps = $r.Stats.PointOnePctLowFps; PointOnePctLowFpsStdDev = $null
      }
    }
  }

  $a = Get-ComparableRecord -Path $Compare[0]
  $b = Get-ComparableRecord -Path $Compare[1]
  "Comparing '$($a.Label)' (N=$($a.N)) vs '$($b.Label)' (N=$($b.N))"
  foreach ($metric in 'AvgFps', 'OnePctLowFps', 'PointOnePctLowFps') {
    $va = $a.$metric
    $vb = $b.$metric
    $sdA = $a.($metric + 'StdDev')
    $sdB = $b.($metric + 'StdDev')
    $delta = $vb - $va
    $pct = 0
    if ($va -ne 0) { $pct = 100.0 * $delta / $va }
    $verdict = ''
    if (($null -ne $sdA) -and ($null -ne $sdB)) {
      # Two-band overlap check: "median +/- stddev" from each side. Non-overlapping
      # bands are treated as a real difference; overlapping bands are noise. This is
      # a simplification of a two-sample test, not a formal significance test -
      # CapFrameX itself doesn't do formal significance testing either: it flags an
      # individual run as an outlier when it differs from the run-set median by more
      # than a flat 3% threshold, then aggregates the rest.
      $noiseBand = $sdA + $sdB
      if ([Math]::Abs($delta) -gt $noiseBand) { $verdict = 'SIGNIFICANT (exceeds combined run-to-run stddev)' }
      else { $verdict = 'within noise (stddev bands overlap)' }
    } else {
      # No repeat-run data on at least one side - fall back to CapFrameX's own flat
      # noise-floor number (3%) as a rule of thumb, clearly labeled as unverified.
      if ([Math]::Abs($pct) -lt 3.0) { $verdict = 'likely noise (<3%, single-run heuristic - rerun with -Runs 3 to confirm)' }
      else { $verdict = 'likely real (>3%, single-run heuristic - rerun with -Runs 3 to confirm)' }
    }
    "{0,-20} A={1,-9} B={2,-9} delta={3,-9} ({4,6:N1}%)  {5}" -f $metric, [Math]::Round($va, 2), [Math]::Round($vb, 2), [Math]::Round($delta, 2), $pct, $verdict
  }
  return
}

$pm = 'C:\Program Files\Intel\PresentMon\PresentMonConsoleApplication'
$pmExe = Get-ChildItem $pm -Filter 'PresentMon-*-x64.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $pmExe -and -not $Csv) { "PresentMon console app not found under $pm - install Intel.PresentMon"; exit 1 }

if ($Csv -and $Runs -gt 1) { "-Runs > 1 captures fresh runs; it is not compatible with -Csv (pass -ProcessName instead)"; exit 1 }

if ($Runs -le 1) {
  if (-not $Csv) {
    if (-not $ProcessName) { "Pass -ProcessName (e.g. EscapeFromTarkov.exe) or -Csv"; exit 1 }
    if ($SkipFirstSeconds -ge $Seconds) { "-SkipFirstSeconds ($SkipFirstSeconds) must be less than -Seconds ($Seconds)"; exit 1 }
    if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory $OutDir -Force | Out-Null }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $Csv = Join-Path $OutDir ("{0}-{1}.csv" -f $stamp, $Label)
    "capturing $ProcessName for $Seconds s -> $Csv"
    $ok = Invoke-PresentMonCapture -PmExePath $pmExe.FullName -ProcessName $ProcessName -Seconds $Seconds -OutCsv $Csv
    if (-not $ok) { "no CSV produced - is the process presenting frames, and is ETW access available?"; exit 1 }
  }

  $stats = Get-BenchRunStats -Csv $Csv -SkipFirstSeconds $SkipFirstSeconds
  if (-not $stats) { "too few frames captured (after dropping the first $SkipFirstSeconds s) - capture longer, check the process name, or pass -SkipFirstSeconds 0"; exit 1 }
  $stats | Format-List
  $rec = [pscustomobject]@{ Label = $Label; Csv = $Csv; Captured = (Get-Date).ToString('s'); SkipFirstSeconds = $SkipFirstSeconds; Stats = $stats }
  $rec | ConvertTo-Json -Depth 4 | Out-File ($Csv -replace '\.csv$', '.json') -Encoding utf8
  return
}

# -Runs > 1: repeat the capture, report per-run stats, then aggregate (median + stddev).
if (-not $ProcessName) { "Pass -ProcessName for -Runs > 1"; exit 1 }
if ($SkipFirstSeconds -ge $Seconds) { "-SkipFirstSeconds ($SkipFirstSeconds) must be less than -Seconds ($Seconds)"; exit 1 }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory $OutDir -Force | Out-Null }

# A plain array built with += (not System.Collections.Generic.List[object]) - wrapping a
# Generic.List[object] with @() throws "Argument types do not match" under PS 5.1 when that
# array is later embedded as a [pscustomobject] property value. += is O(n^2) but Runs is at
# most a handful of captures, so it's cheap and it sidesteps the interop issue entirely.
$runRecords = @()
for ($i = 1; $i -le $Runs; $i++) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $runCsv = Join-Path $OutDir ("{0}-{1}-run{2}.csv" -f $stamp, $Label, $i)
  "run $i/$Runs : capturing $ProcessName for $Seconds s -> $runCsv"
  $ok = Invoke-PresentMonCapture -PmExePath $pmExe.FullName -ProcessName $ProcessName -Seconds $Seconds -OutCsv $runCsv
  if (-not $ok) { "  run $i - no CSV produced, skipping"; continue }
  $s = Get-BenchRunStats -Csv $runCsv -SkipFirstSeconds $SkipFirstSeconds
  if (-not $s) { "  run $i - too few frames after trim, skipping"; continue }
  "  run $i : AvgFps=$($s.AvgFps)  1pctLow=$($s.OnePctLowFps)  0.1pctLow=$($s.PointOnePctLowFps)"
  $runRecords += [pscustomobject]@{ Run = $i; Csv = $runCsv; Stats = $s }
}
if ($runRecords.Count -eq 0) { "all $Runs runs failed - nothing to aggregate"; exit 1 }

$agg = [ordered]@{}
foreach ($metric in 'AvgFps', 'OnePctLowFps', 'PointOnePctLowFps', 'AvgFrameTimeMs') {
  $vals = [double[]]@($runRecords | ForEach-Object { $_.Stats.$metric })
  $agg[$metric] = [pscustomobject]@{ Median = Get-Median $vals; StdDev = Get-StdDev $vals }
}
"`n=== Aggregate over $($runRecords.Count)/$Runs successful runs ==="
$agg.GetEnumerator() | ForEach-Object { "{0,-20} median={1,-8} stddev={2}" -f $_.Key, ([Math]::Round($_.Value.Median, 2)), ([Math]::Round($_.Value.StdDev, 3)) }

$rec = [pscustomobject]@{ Label = $Label; Captured = (Get-Date).ToString('s'); SkipFirstSeconds = $SkipFirstSeconds; N = $Runs; Runs = $runRecords; Aggregate = $agg }
$recPath = Join-Path $OutDir ("{0}-{1}-aggregate.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $Label)
$rec | ConvertTo-Json -Depth 6 | Out-File $recPath -Encoding utf8
"Aggregate record: $recPath"
