# Regression tests for tools\relay-gain-check.ps1.
# PS 5.1, ASCII-only, no framework, no network. Exit 0 = all pass, 1 = failures.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tests\Invoke-RelayGainCheckTests.ps1
param(
  [string]$ScriptPath = (Join-Path (Join-Path (Split-Path $PSScriptRoot -Parent) 'tools') 'relay-gain-check.ps1')
)

$script:fails = 0
$script:tests = 0
function Assert-True($cond, $label) {
  $script:tests++
  if ($cond) { "PASS  $label" } else { $script:fails++; "FAIL  $label" }
}

if (-not (Test-Path $ScriptPath)) { "FATAL: relay-gain-check.ps1 not found at $ScriptPath"; exit 1 }
$src = Get-Content $ScriptPath -Raw

$errs = $null
$null = [System.Management.Automation.PSParser]::Tokenize($src, [ref]$errs)
Assert-True ($errs.Count -eq 0) "T1 parses (errors: $($errs.Count))"
Assert-True ([regex]::Matches($src, '[^\x00-\x7F]').Count -eq 0) "T2 ASCII-only"

# Read-only: no tunnel, route, adapter, firewall or registry change anywhere in code.
$code = ($src -split "`r?`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
Assert-True ($code -notmatch '(?i)wireguard|wg\.exe|route\s+(add|delete|change)|netsh|New-NetRoute|Set-Net|New-NetFirewall|Set-ItemProperty|New-ItemProperty|Start-Process') "T3 no network or system change in code"
# Public repo: the only literal IPv4 allowed is the League NA game server default (already public in desktop/src/backend.ts).
$ips = @([regex]::Matches($src, '\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b') | ForEach-Object { $_.Value } | Sort-Object -Unique)
Assert-True (($ips.Count -eq 1) -and ($ips[0] -eq '192.207.0.5')) "T4 no IPv4 literal besides the League NA server (found: $($ips -join ', '))"

. $ScriptPath -TestOnly

Assert-True ((Get-Median @(3, 1, 2)) -eq 2) "T5 median odd"
Assert-True ((Get-Median @(4, 1, 2, 3)) -eq 2.5) "T6 median even"
Assert-True ($null -eq (Get-Median @())) "T7 median empty = null"
Assert-True ((Get-Median @(0)) -eq 0) "T8 median of a single 0 is 0, not null"

Assert-True ((Hide-Ip '198.51.100.23') -eq '198.51.x.x') "T9 IPv4 masked to a.b.x.x"
Assert-True ((Hide-Ip '2001:db8:1:2::5') -eq '2001:db8:x') "T10 IPv6 masked to two groups"
Assert-True ((Test-PrivateIp '192.168.1.1') -and (Test-PrivateIp '10.0.0.1') -and (Test-PrivateIp '172.20.0.1') -and (Test-PrivateIp '100.70.1.1')) "T11 private and CGNAT ranges"
Assert-True (-not (Test-PrivateIp '172.32.0.1') -and -not (Test-PrivateIp '198.51.100.1')) "T12 public ranges not private"

Assert-True ((Get-IspFromName 'po-1-rur01.example.tn.nash.comcast.net') -eq 'Comcast (Xfinity)') "T13 Comcast from rDNS"
Assert-True ((Get-IspFromName 'lag-1.chrcnctr01.charter.com.') -eq 'Spectrum') "T14 Spectrum from rDNS, trailing dot"
Assert-True ((Get-IspFromName 'core1.example-isp.net') -eq 'example-isp.net') "T15 unknown ISP falls back to domain"
Assert-True ((Get-IspFromName 'notcomcast.net') -eq 'notcomcast.net') "T16 suffix match needs a dot boundary"

$rc = Get-RiotCity 'ae3.er02.chi01.riotdirect.net'
Assert-True ($rc -and $rc.City -eq 'Chicago' -and $rc.Code -eq 'chi') "T17 Riot Chicago hop"
$rc = Get-RiotCity 'ae1.er02.was01.riotdirect.net'
Assert-True ($rc -and $rc.City -eq 'Ashburn VA') "T18 Riot Ashburn hop"
Assert-True ($null -eq (Get-RiotCity 'po-1.chi01.comcast.net')) "T19 non-Riot hop is not an entry"

$csv = @"
game.time,network.status,network.rtt_average,network.rtt_jitter,network.packets_lost,network.packets_sent
10,Connecting,0.090,0.001,0,10
20,Connected,0.031,0.001,0,100
30,Connected,0.0305,0.001,1,100
40,Connected,0.032,0.002,0,100
50,Connected,7.5,0.002,0,100
"@
$r = Read-NetstatsRtts $csv
Assert-True ($r.Count -eq 3 -and $r[0] -eq 31 -and $r[1] -eq 30.5) "T20 netstats: Connected rows only, seconds to ms, junk dropped (got $($r -join ','))"
$r = Read-NetstatsRtts ("network.status,game.time,network.rtt_average`nConnected,1,0.040")
Assert-True ($r.Count -eq 1 -and $r[0] -eq 40) "T21 netstats: columns found by name"
Assert-True ((Read-NetstatsRtts "a,b`n1,2").Count -eq 0) "T22 netstats: no rtt column = nothing"

$hops = @(
  [pscustomobject]@{ Hop = 1; Ms = 1 }, [pscustomobject]@{ Hop = 2; Ms = 12 },
  [pscustomobject]@{ Hop = 3; Ms = 26 }, [pscustomobject]@{ Hop = 4; Ms = 24 },
  [pscustomobject]@{ Hop = 5; Ms = $null }
)
Assert-True ((Get-TraceDirectMs $hops) -eq 26) "T23 trace direct = slowest of last two answering hops"
Assert-True ($null -eq (Get-TraceDirectMs @([pscustomobject]@{ Hop = 1; Ms = $null }))) "T24 trace with no answers = null"

Assert-True ((Get-GainVerdict -DirectMs 45 -RelayMs 30).Verdict -eq 'Likely worth it') "T25 15 ms gain clears the 10 ms bar"
Assert-True ((Get-GainVerdict -DirectMs 36 -RelayMs 30).Verdict -eq 'Small gain') "T26 6 ms = small gain"
$g = Get-GainVerdict -DirectMs 31 -RelayMs 30
Assert-True ($g.Verdict -eq 'No gain expected' -and $g.GainMs -eq 1) "T27 1 ms = no gain"
Assert-True ((Get-GainVerdict -DirectMs 28 -RelayMs 30).GainMs -eq -2) "T28 relay slower shows a negative gain"

$res = [ordered]@{ version = 1; date = '2026-11-07'; isp = 'Comcast (Xfinity)'; direct_ms = 31; direct_source = 'in-game'; matches = 5
  riot_entry = 'Ashburn VA (was)'; riot_entry_hop = 9; relay_city_ms = 26; relay_overhead_ms = 4; relay_est_ms = 30; gain_ms = 1; verdict = 'No gain expected'
  hops = @(@{ ip = '198.51.x.x' }) }
$t = Format-ShareText $res
Assert-True ($t -match 'Direct to League NA: 31 ms \(League in-game ping, 5 match') "T29 share text: direct from in-game"
Assert-True ($t -match 'Estimated gain: 1 ms -> No gain expected') "T30 share text: gain and verdict"
Assert-True ($t -match 'Estimate only\. Only in-match ping') "T31 share text: honesty line"
Assert-True ($t -notmatch '\d{1,3}\.\d{1,3}\.') "T32 share text holds no IP, masked or not"
$res.direct_ms = $null; $res.relay_city_ms = $null; $res.gain_ms = $null
$t = Format-ShareText $res
Assert-True ($t -match 'not measured' -and $t -notmatch 'Estimated gain') "T33 share text: missing numbers say so, no gain line"

""
"$($script:tests - $script:fails)/$($script:tests) passed"
if ($script:fails -gt 0) { exit 1 } else { exit 0 }
