# Regression tests for tools\drift-guard.ps1.
# PS 5.1, ASCII-only, no framework. Exit 0 = all pass, 1 = failures.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tests\Invoke-DriftGuardTests.ps1 [-ScriptPath <path>]
param(
  [string]$ScriptPath = (Join-Path (Split-Path $PSScriptRoot -Parent) 'tools\drift-guard.ps1')
)

$script:fails = 0
$script:tests = 0
function Assert-True($cond, $label) {
  $script:tests++
  if ($cond) { "PASS  $label" } else { $script:fails++; "FAIL  $label" }
}

if (-not (Test-Path $ScriptPath)) { "FATAL: drift-guard.ps1 not found at $ScriptPath"; exit 1 }
$src = Get-Content $ScriptPath -Raw

# T1: parses clean under PS 5.1
$errs = $null
$null = [System.Management.Automation.PSParser]::Tokenize($src, [ref]$errs)
Assert-True ($errs.Count -eq 0) "T1 drift-guard.ps1 parses (errors: $($errs.Count))"

# T2: ASCII-only
$nonAscii = [regex]::Matches($src, '[^\x00-\x7F]').Count
Assert-True ($nonAscii -eq 0) "T2 drift-guard.ps1 ASCII-only (non-ASCII chars: $nonAscii)"

# T3/T4: never touches what the spec explicitly excludes
Assert-True ($src -notmatch '(Set-ItemProperty|New-ItemProperty|New-Item)[^\r\n]*HKLM') "T3 no HKLM write anywhere in the file"
Assert-True ($src -notmatch 'powercfg\s+/(setactive|setacvalueindex|setdcvalueindex|import)') "T4 never calls a powercfg mutator"

# T5/T6: the two SAFE-list HKCU fixes are present and forced to the documented target
Assert-True ($src -match "Prop 'AutoGameModeEnabled' -Target 0") "T5 game_mode fix targets AutoGameModeEnabled=0 (HKCU)"
Assert-True ($src -match "Prop 'GameDVR_Enabled' -Target 0") "T6 gamedvr fix targets GameDVR_Enabled=0 (HKCU)"

# T17/T18: design guards from code review - no toast that spoofs Explorer's AppId, and the
# script never registers/calls schtasks itself (that's SKILL.md's "hand the user a command"
# job, not this script's). Scanned against code lines only (whole-line comments stripped) so
# the header's own design-rationale prose - which names the rejected approach on purpose - does
# not trip these guards.
$codeOnlyT17 = ($src -split "`r?`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
Assert-True ($codeOnlyT17 -notmatch 'Microsoft\.Windows\.Explorer') "T17a no Explorer AppId spoofing in executable code"
Assert-True ($codeOnlyT17 -notmatch 'ToastNotificationManager') "T17b no WinRT toast mechanism in executable code (console + JSON report only)"
Assert-True ($codeOnlyT17 -notmatch 'schtasks(\.exe)?\s+/(create|delete|change)') "T18 script never invokes schtasks itself (registration is a hand-the-user-a-command doc step)"

# T7+: dot-source in TestOnly mode (loads functions, runs nothing) and unit-test with fixtures
. $ScriptPath -TestOnly

Assert-True ((Test-Drift 1 1) -eq $false) "T7 Test-Drift: equal values = no drift"
Assert-True ((Test-Drift 1 0) -eq $true)  "T8 Test-Drift: different values = drift"
Assert-True ((Test-Drift 5 $null) -eq $false) "T9 Test-Drift: null baseline = untracked, never drift"

Assert-True ((Test-SafeFixEligible -BaselineValue 0 -ActualValue 1 -TargetValue 0) -eq $true) `
  "T10 SafeFix: eligible when baseline wants 0 and machine drifted to 1"
Assert-True ((Test-SafeFixEligible -BaselineValue 1 -ActualValue 0 -TargetValue 0) -eq $false) `
  "T11 SafeFix: NOT eligible when the baseline itself wants 1 (never overwrites user intent)"
Assert-True ((Test-SafeFixEligible -BaselineValue 0 -ActualValue 0 -TargetValue 0) -eq $false) `
  "T12 SafeFix: NOT eligible when there is no drift to begin with"

# T13-15: prune-by-KeepLast, exercised against real (temp, disposable) fixture files
$fx = Join-Path $env:TEMP ("dg-fixture-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fx -Force | Out-Null
try {
  1..5 | ForEach-Object { New-Item -ItemType File -Path (Join-Path $fx ("drift-2026010{0}-000000.json" -f $_)) -Force | Out-Null }
  $prune = Get-PruneCandidates -Dir $fx -KeepLast 3
  Assert-True ($prune.Count -eq 2) "T13 Get-PruneCandidates: keeps 3 of 5, flags 2 for deletion"
  Assert-True ((($prune.Name | Sort-Object) -join ',') -eq 'drift-20260101-000000.json,drift-20260102-000000.json') `
    "T14 Get-PruneCandidates: flags the OLDEST files, keeps the newest 3"
  Assert-True ((Get-PruneCandidates -Dir $fx -KeepLast 10).Count -eq 0) "T15 Get-PruneCandidates: nothing to prune under the cap"
} finally {
  Remove-Item -Path $fx -Recurse -Force -ErrorAction SilentlyContinue
}

# T16: Resolve-WatchProcessPath never guesses - only a valid, existing path resolves
Assert-True ($null -eq (Resolve-WatchProcessPath -Name 'TotallyMadeUpProcXYZ' -BaselinePaths $null)) `
  "T16 Resolve-WatchProcessPath: returns null rather than guessing a path"

""
"{0} tests, {1} failures" -f $script:tests, $script:fails
if ($script:fails -gt 0) { exit 1 } else { exit 0 }
