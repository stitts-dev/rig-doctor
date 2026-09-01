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

# T6: leak scan - machine-specific strings must never enter the public skill
$leaks = 'toaster','lexxwifi','MoCA','Bitsum','9950X3D','X870','Solidigm','SN8100','Unheard','PG27UCDM','Odyssey','jadenrs10','D:\\Battlestate'
foreach ($s in $leaks) {
  Assert-True ($md -notmatch $s) "T6 no leak: $s"
}

""
"{0} tests, {1} failures" -f $script:tests, $script:fails
if ($script:fails -gt 0) { exit 1 } else { exit 0 }
