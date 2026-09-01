# bench.ps1 - PresentMon frametime capture + stats for A/B tuning runs.
# PS 5.1, ASCII-only. Requires Intel PresentMon (console app) installed.
#
# Capture:  .\bench.ps1 -ProcessName EscapeFromTarkov.exe -Seconds 120 -Label "timer-res-on"
# Stats of an existing CSV:  .\bench.ps1 -Csv path\to\run.csv
# Dot-source for the stats function only:  . .\bench.ps1 -StatsOnly
#
# Definitions (CapFrameX-style percentile boundaries):
#   1% low FPS   = 1000 / (frametime of the Nth worst frame, N = ceil(frames*0.01))
#   0.1% low FPS = 1000 / (frametime of the Nth worst frame, N = ceil(frames*0.001))
#   Avg FPS      = frames / total capture time
param(
  [string]$ProcessName,
  [int]$Seconds = 60,
  [string]$Label = 'run',
  [string]$Csv,
  [string]$OutDir = (Join-Path $env:USERPROFILE '.rig-doctor\bench'),
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

function Read-PresentMonCsv {
  param([string]$Path)
  $rows = Import-Csv $Path
  # PresentMon v2 column is FrameTime; v1 used MsBetweenPresents
  $col = if ($rows[0].PSObject.Properties['FrameTime']) { 'FrameTime' } else { 'MsBetweenPresents' }
  ,($rows | ForEach-Object { [double]$_.$col })
}

if ($StatsOnly) { return }

$pm = 'C:\Program Files\Intel\PresentMon\PresentMonConsoleApplication'
$pmExe = Get-ChildItem $pm -Filter 'PresentMon-*-x64.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $pmExe -and -not $Csv) { "PresentMon console app not found under $pm - install Intel.PresentMon"; exit 1 }

if (-not $Csv) {
  if (-not $ProcessName) { "Pass -ProcessName (e.g. EscapeFromTarkov.exe) or -Csv"; exit 1 }
  if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory $OutDir -Force | Out-Null }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $Csv = Join-Path $OutDir ("{0}-{1}.csv" -f $stamp, $Label)
  "capturing $ProcessName for $Seconds s -> $Csv"
  & $pmExe.FullName --process_name $ProcessName --output_file $Csv --timed $Seconds --terminate_after_timed --stop_existing_session --no_console_stats 2>$null
  if (-not (Test-Path $Csv)) { "no CSV produced - is the process presenting frames, and is ETW access available?"; exit 1 }
}

$ft = Read-PresentMonCsv -Path $Csv
$stats = Get-FrameStats -FrameTimesMs $ft
if (-not $stats) { "too few frames captured ($($ft.Count)) - capture longer or check the process name"; exit 1 }
$stats | Format-List
# Persist a run record next to the CSV for later A/B comparison
$rec = [pscustomobject]@{ Label = $Label; Csv = $Csv; Captured = (Get-Date).ToString('s'); Stats = $stats }
$rec | ConvertTo-Json -Depth 4 | Out-File ($Csv -replace '\.csv$', '.json') -Encoding utf8
