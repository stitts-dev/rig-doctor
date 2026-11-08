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

# pwsh off Windows has no USERPROFILE or APPDATA, and the script's parameter defaults join paths onto them.
foreach ($v in @('USERPROFILE', 'APPDATA')) {
  if (-not [Environment]::GetEnvironmentVariable($v)) { [Environment]::SetEnvironmentVariable($v, [IO.Path]::GetTempPath()) }
}
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

# ---------- sharing with a relay (documentation addresses and placeholder keys only) ----------

$t = Format-ShareText ([ordered]@{ version = 1; date = '2026-11-08'; isp = 'Comcast (Xfinity)'; asn = 7922; direct_ms = 31; direct_source = 'in-game'; matches = 5
  relay_city_ms = 26; relay_overhead_ms = 4; relay_est_ms = 30; gain_ms = 1; verdict = 'No gain expected' })
Assert-True ($t -match '(?m)^ISP network: AS7922\r?$' -and $t -notmatch '\d{1,3}\.\d{1,3}\.') "T34 share text: ISP network line when the ASN is known"
Assert-True ((Format-ShareText $res) -notmatch 'ISP network') "T35 share text: no ISP network line without an ASN"

function ConvertTo-TestB64Url([string]$s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
$der = [byte[]](@(0x30, 0x82) + @(7) * 300)
$certB64 = [Convert]::ToBase64String($der)
$secret = 'A' * 43
$relayKey = 'cGxhY2Vob2xkZXJwbGFjZWhvbGRlcnBsYWNlaG9sZGU='
function New-TestInvite($Patch, [string[]]$Drop) {
  $j = [ordered]@{ v = 1; name = 'alice'; api = 'https://198.51.100.1:51821'; cert = $certB64; relay_key = $relayKey; secret = $secret; expires = 0 }
  if ($Patch) { foreach ($k in $Patch.Keys) { $j[$k] = $Patch[$k] } }
  foreach ($k in @($Drop)) { if ($k) { $j.Remove($k) } }
  'rigrelay1.' + (ConvertTo-TestB64Url ($j | ConvertTo-Json -Compress))
}
$now = [long]1762560000
$bad = { param($Patch) ConvertFrom-RelayInvite (New-TestInvite $Patch) -NowUnix $now }

$c = ConvertFrom-RelayInvite ('  ' + (New-TestInvite) + "`r`n") -NowUnix $now
Assert-True ($c.Ok -and $c.From -eq 'invite' -and $c.Api -eq 'https://198.51.100.1:51821' -and $c.Bearer -eq $secret -and $c.Cert.Length -eq 302 -and $c.Cert[0] -eq 0x30) "T36 invite: a good one decodes (api, pinned cert bytes, bearer = secret)"
Assert-True ((ConvertFrom-RelayInvite ((New-TestInvite) + '==') -NowUnix $now).Ok) "T37 invite: trailing padding tolerated"
Assert-True ((ConvertFrom-RelayInvite 'hello').Why -match 'rigrelay1\.' -and -not (ConvertFrom-RelayInvite '').Ok) "T38 invite: wrong prefix says so"
Assert-True ((ConvertFrom-RelayInvite 'rigrelay1.!!!').Why -match 'bad encoding' -and (ConvertFrom-RelayInvite 'rigrelay1.A').Why -match 'bad encoding') "T39 invite: bad base64url"
Assert-True ((ConvertFrom-RelayInvite ('rigrelay1.' + (ConvertTo-TestB64Url 'not json'))).Why -match 'bad contents' -and (ConvertFrom-RelayInvite ('rigrelay1.' + (ConvertTo-TestB64Url '"x"'))).Why -match 'bad contents') "T40 invite: not a JSON object"
Assert-True ((& $bad @{ v = 2 }).Why -match 'version 2' -and (& $bad @{ v = '1' }).Why -match 'bad contents') "T41 invite: only version 1, as a number"
$apis = @('http://198.51.100.1:51821', 'https://198.51.100.1:51821/x', 'https://u@198.51.100.1:1', 'https://198.51.100.1', 'nope', 'https://198.51.100.1:51821?x=1', 'https://198.51.100.1 :51821')
Assert-True (@($apis | Where-Object { (& $bad @{ api = $_ }).Why -notmatch 'address' }).Count -eq 0) "T42 invite: bad relay addresses refused"
Assert-True ((& $bad @{ api = 'https://[2001:db8::1]:51821/' }).Ok) "T43 invite: IPv6 relay address with a trailing slash accepted"
Assert-True ((& $bad @{ secret = 'x' }).Why -match 'secret' -and (& $bad @{ secret = ('A' * 42) + '!' }).Why -match 'secret' -and (& $bad @{ secret = 'A' * 44 }).Why -match 'secret') "T44 invite: bad secret refused"
$short = [Convert]::ToBase64String([byte[]](@(0x30) + @(1) * 50))
$notSeq = [Convert]::ToBase64String([byte[]](@(0x31) + @(1) * 300))
$huge = [Convert]::ToBase64String([byte[]](@(0x30) + @(1) * 4096))
$certWhys = @(@('AAAA', $short, $notSeq, $huge, 'not base64!', 5) | ForEach-Object { (& $bad @{ cert = $_ }).Why })
Assert-True ($certWhys.Count -eq 6 -and @($certWhys | Where-Object { $_ -notmatch 'certificate' }).Count -eq 0) "T45 invite: bad certificate refused (short, not DER, over 4096 bytes, not base64)"
Assert-True ((& $bad @{ expires = $now - 1 }).Why -match 'expired') "T46 invite: expired refused"
Assert-True ((& $bad @{ expires = $now + 3600 }).Ok -and (& $bad @{ expires = 0 }).Ok -and (& $bad @{ expires = $now }).Ok) "T47 invite: future, now or 0 (never) expiry accepted"
Assert-True ((ConvertFrom-RelayInvite (New-TestInvite -Drop 'expires') -NowUnix $now).Ok -and (& $bad @{ expires = 'soon' }).Why -match 'bad contents') "T48 invite: no expires = never; a non-number is damaged"
$whys = @(@{ v = 2 }, @{ api = 'nope' }, @{ secret = 'x' }, @{ cert = 'AAAA' }, @{ expires = 1 }) | ForEach-Object { & $bad $_ }
Assert-True (@($whys | Where-Object { $_.Ok -or $_.Why -match '198\.51|AAAAAAAA|alice' -or $null -ne $_.Bearer -or $null -ne $_.Api }).Count -eq 0) "T49 invite: refusals carry no address, secret or name"

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('rgc-test-' + [Guid]::NewGuid().ToString('N'))
$savedDir = Join-Path (Join-Path $tmp 'relay') 'saved'
New-Item -ItemType Directory -Path $savedDir -Force | Out-Null
function Write-TestFile([string]$Name, [string]$Text, [int]$AgeMin) {
  $p = Join-Path $savedDir $Name
  [IO.File]::WriteAllText($p, $Text)
  [IO.File]::SetLastWriteTime($p, (Get-Date).AddMinutes(-$AgeMin))
}
function New-TestApiJson([string]$Api, [string]$Token) {
  [ordered]@{ api = $Api; cert = $certB64; relay_key = $relayKey; token = $Token; prefix_version = 'v1' } | ConvertTo-Json
}
Assert-True ($null -eq (Find-SavedRelay $tmp) -and $null -eq (Find-SavedRelay (Join-Path $tmp 'missing')) -and $null -eq (Find-SavedRelay '')) "T50 saved relay: none joined = null"
$tokOld = 'o' * 43; $tokNew = 'n' * 43
Write-TestFile 'old.api.json' (New-TestApiJson 'https://198.51.100.1:51821' $tokOld) 60
Write-TestFile 'new.api.json' (New-TestApiJson 'https://203.0.113.9:51821' $tokNew) 5
Write-TestFile 'newest.conf' (New-TestApiJson 'https://203.0.113.7:51821' ('c' * 43)) 0
$c = Find-SavedRelay $tmp
Assert-True ($c.Ok -and $c.From -eq 'app' -and $c.Bearer -eq $tokNew -and $c.Api -eq 'https://203.0.113.9:51821' -and $c.Cert.Length -eq 302) "T51 saved relay: newest .api.json wins, bearer = its token, tunnel configs not read"
Write-TestFile 'new.api.json' '{ broken' 1
Write-TestFile 'bad-api.api.json' (New-TestApiJson 'http://203.0.113.9:51821' $tokNew) 2
Assert-True ((Find-SavedRelay $tmp).Bearer -eq $tokOld) "T52 saved relay: damaged newer files fall back to the next"
Remove-Item -LiteralPath $tmp -Recurse -Force

$h = @(
  [pscustomobject]@{ Hop = 1; Ip = '192.168.1.1'; Name = $null },
  [pscustomobject]@{ Hop = 2; Ip = $null; Name = $null },
  [pscustomobject]@{ Hop = 3; Ip = '100.70.1.1'; Name = $null },
  [pscustomobject]@{ Hop = 4; Ip = '198.51.100.7'; Name = 'po-1.example.comcast.net' },
  [pscustomobject]@{ Hop = 5; Ip = '203.0.113.5'; Name = 'ae3.er02.chi01.riotdirect.net' }
)
Assert-True ((Get-FirstPublicHopIp $h) -eq '198.51.100.7') "T53 ASN hop: first public hop, past private, CGNAT and silent hops"
Assert-True ((Get-FirstPublicHopIp @($h[0], [pscustomobject]@{ Hop = 2; Ip = '203.0.113.2'; Name = $null })) -eq '203.0.113.2') "T54 ASN hop: a hop with no name counts"
Assert-True ($null -eq (Get-FirstPublicHopIp @($h[0], $h[4], [pscustomobject]@{ Hop = 6; Ip = '203.0.113.6'; Name = $null }))) "T55 ASN hop: Riot's network first = null (its hops are not the ISP)"
Assert-True ($null -eq (Get-FirstPublicHopIp @($h[0], $h[1], $h[2])) -and $null -eq (Get-FirstPublicHopIp @())) "T56 ASN hop: no public hop = null"

$a = Get-AsnFromRipe ('{"status":"ok","data":{"asns":["7922"],"prefix":"198.51.100.0/24"}}' | ConvertFrom-Json)
Assert-True ($a -eq 7922 -and $a -is [long]) "T57 RIPEstat: data.asns[0] (a string) as an integer"
Assert-True ((Get-AsnFromRipe ('{"data":{"asns":[4200000000,64500]}}' | ConvertFrom-Json)) -eq 4200000000) "T58 RIPEstat: numbers and 32-bit ASNs read too"
Assert-True ($null -eq (Get-AsnFromRipe ('{"data":{"asns":[],"prefix":null}}' | ConvertFrom-Json))) "T59 RIPEstat: empty asns = null"
$junk = @($null, 'oops', ('{"data":{"asns":["abc"]}}' | ConvertFrom-Json), ('{"data":{"asns":["0"]}}' | ConvertFrom-Json),
  ('{"data":{"asns":["99999999999"]}}' | ConvertFrom-Json), ('{"messages":[["error","bad"]]}' | ConvertFrom-Json), ('{"data":null}' | ConvertFrom-Json))
Assert-True (@($junk | Where-Object { $null -ne (Get-AsnFromRipe $_) }).Count -eq 0) "T60 RIPEstat: junk = null"

$r = [ordered]@{ direct_ms = 31; direct_source = 'in-game'; matches = 5; relay_est_ms = 30 }
$g = New-GainReport $r 7922
$keys = @($g.Keys) -join ','
Assert-True ($keys -eq 'v,game,source,asn,region,direct_ms,relay_ms,direct_loss,relay_loss,direct_n,relay_n') "T61 gain report: the contract's fields (got $keys)"
Assert-True ($g.v -eq 1 -and $g.game -eq 'league' -and $g.source -eq 'estimate' -and $g.asn -eq 7922 -and $null -eq $g.region -and $g.direct_ms -eq 31 -and
  $g.relay_ms -eq 30 -and $null -eq $g.direct_loss -and $null -eq $g.relay_loss -and $g.direct_n -eq 5 -and $g.relay_n -eq 0) "T62 gain report: values"
$j = $g | ConvertTo-Json -Compress
Assert-True ($j -match '^\{"v":1,"game":"league","source":"estimate","asn":7922,"region":null,"direct_ms":31(\.0)?,"relay_ms":30(\.0)?,"direct_loss":null,"relay_loss":null,"direct_n":5,"relay_n":0\}$') "T63 gain report: JSON body (got $j)"
$r.direct_source = 'trace'
$traceWithCount = New-GainReport $r 7922
$r.matches = 0
Assert-True ($null -eq $traceWithCount -and $null -eq (New-GainReport $r 7922)) "T64 gain report: a traceroute direct number is never shared"
$r.direct_source = 'in-game'; $r.matches = 5; $r.relay_est_ms = $null
Assert-True ($null -eq (New-GainReport $r 7922)) "T65 gain report: no relay number = null"
$r.relay_est_ms = 30
Assert-True ($null -eq (New-GainReport $r $null) -and $null -eq (New-GainReport $r 0) -and $null -eq (New-GainReport $r 'x')) "T66 gain report: no ASN = null"
$r.matches = 0
Assert-True ($null -eq (New-GainReport $r 7922)) "T67 gain report: zero matches = null"
$r.matches = 5; $r.direct_ms = 1500
Assert-True ($null -eq (New-GainReport $r 7922)) "T68 gain report: outside the API's 0-1000 ms = null"

$r = [ordered]@{ direct_ms = 31; direct_source = 'in-game'; matches = 5; relay_est_ms = 30 }
$ok = New-RelayCred -Api 'https://198.51.100.1:51821' -Cert $der -Bearer $secret -From 'invite'
Assert-True ((Get-NoShareReason -NoUpload $true -Cred $ok -Asn 7922 -R $r) -match 'NoUpload') "T69 not shared: -NoUpload"
Assert-True ((Get-NoShareReason -NoUpload $false -Cred $null -Asn 7922 -R $r) -eq 'this PC has not joined one and no -Invite was given. Send the text above') "T70 not shared: nothing joined, no invite"
Assert-True ((Get-NoShareReason -NoUpload $false -Cred (& $bad @{ expires = 1 }) -Asn 7922 -R $r) -match 'expired') "T71 not shared: a bad invite says why"
$r.direct_source = 'trace'
Assert-True ((Get-NoShareReason -NoUpload $false -Cred $ok -Asn 7922 -R $r) -match 'in-game ping') "T72 not shared: no match logs"
$r.direct_source = 'in-game'; $r.relay_est_ms = $null
Assert-True ((Get-NoShareReason -NoUpload $false -Cred $ok -Asn 7922 -R $r) -match 'Vultr Chicago') "T73 not shared: no relay number"
$r.relay_est_ms = 30
Assert-True ((Get-NoShareReason -NoUpload $false -Cred $ok -Asn $null -R $r) -match 'ASN' -and $null -eq (Get-NoShareReason -NoUpload $false -Cred $ok -Asn 7922 -R $r)) "T74 not shared: no ASN; all there = shared"

$ans = @'
{"game": "league", "asn": 7922, "bar_ms": 10, "rows": [
  {"source": "estimate", "asn": 7922, "region": null, "players": 6, "median_gain_ms": 9.0, "gaining": 2, "median_direct_ms": 40.0, "median_relay_ms": 31.0},
  {"source": "in_game", "asn": 7922, "region": null, "players": 4, "median_gain_ms": 12.0, "gaining": 3, "median_direct_ms": 44.0, "median_relay_ms": 32.0},
  {"source": "in_game", "asn": 7922, "region": "Pennsylvania, United States", "players": 3, "median_gain_ms": 13.5, "gaining": 2, "median_direct_ms": 45.0, "median_relay_ms": 31.0}
]}
'@ | ConvertFrom-Json
Assert-True ((Format-GainRows $ans 7922) -eq 'Shared with the relay. Players on AS7922 so far: in game 12 ms median gain (4 players, 3 by 10 ms or more); gain checks 9 ms (6 players).') "T75 relay rows: in-game and gain-check rows in plain words, region rows left out"
$ans = '{"bar_ms":10,"rows":[{"source":"estimate","asn":7922,"region":null,"players":1,"median_gain_ms":-2.5,"gaining":0},{"source":"in_game","asn":64500,"region":null,"players":9,"median_gain_ms":20,"gaining":9}]}' | ConvertFrom-Json
Assert-True ((Format-GainRows $ans 7922) -eq 'Shared with the relay. Players on AS7922 so far: gain checks -2.5 ms (1 player).') "T76 relay rows: this ASN only, one player"
Assert-True ((Format-GainRows ('{"rows":[]}' | ConvertFrom-Json) 7922) -eq 'Shared with the relay. No results for AS7922 yet.' -and (Format-GainRows $null 7922) -match 'No results') "T77 relay rows: none yet"

Assert-True ((Format-UploadFailure -Status 401 -Answer ('{"error":"unknown or revoked token"}' | ConvertFrom-Json)) -eq 'the relay answered 401 (unknown or revoked token)') "T78 upload failure: the relay's own error text"
Assert-True ((Format-UploadFailure -Status 0 -NetStatus 'TrustFailure' -CertRejected $true) -match 'certificate did not match') "T79 upload failure: certificate pin mismatch"
Assert-True ((Format-UploadFailure -Status 0 -NetStatus 'Timeout') -match '10 s' -and (Format-UploadFailure -Status 0 -NetStatus 'ConnectFailure') -eq 'could not reach the relay' -and
  (Format-UploadFailure -Status 502 -Answer 'x') -eq 'the relay answered 502') "T80 upload failure: timeout, unreachable, an error with no JSON"

$pin = $false; $exact = $false; $cb = $false
try {
  Initialize-GainPin
  $pin = [bool]('RigDoctorGainPin1' -as [type])
  $flip = [byte[]]$der.Clone(); $flip[150] = 8
  $exact = [RigDoctorGainPin1]::SameBytes($der, [byte[]]$der.Clone()) -and -not [RigDoctorGainPin1]::SameBytes($der, $flip) -and
    -not [RigDoctorGainPin1]::SameBytes($der, [byte[]]$der[0..300]) -and -not [RigDoctorGainPin1]::SameBytes($der, $null)
  $cb = [RigDoctorGainPin1]::Callback -is [System.Net.Security.RemoteCertificateValidationCallback]
} catch { "  pin error: $($_.Exception.Message)" }
Assert-True $pin "T81 cert pin: the C# pin compiles (Add-Type)"
Assert-True $exact "T82 cert pin: exact DER bytes only (one byte off, shorter, none all refused)"
Assert-True $cb "T83 cert pin: a static RemoteCertificateValidationCallback"

# ---------- where Rig Doctor runs, direct ping comes only from matches it logged as direct ----------

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('rgc-test-' + [Guid]::NewGuid().ToString('N'))
$app = Join-Path $tmp 'app'
New-Item -ItemType Directory -Path $app -Force | Out-Null
Assert-True ($null -eq (Get-DirectMatchIds $app) -and $null -eq (Get-DirectMatchIds '') -and $null -eq (Get-DirectMatchIds (Join-Path $tmp 'missing'))) "T84 direct matches: no Rig Doctor match log = no filter"
$log = @(
  '{"v":1,"id":"2026-11-01T10-00-00","ts":1,"path":"direct","samples":60,"median_ms":50,"loss":0}',
  '{"v":1,"id":"2026-11-02T10-00-00","ts":2,"path":"relay-a","samples":60,"median_ms":30,"loss":0}',
  '{"v":1,"id":"2026-11-03T10-00-00","ts":3,"path":"mixed"}',
  '{"v":1,"id":"2026-11-04T10-00-00","ts":4,"path":"unknown"}',
  '{ broken', '"direct"', '{"id":5,"path":"direct"}', '{"id":"2026-11-05T10-00-00","path":"Direct"}', '',
  '{"v":1,"id":"2026-11-06T10-00-00","ts":6,"path":"direct"}'
) -join "`n"
[IO.File]::WriteAllText((Join-Path $app 'match-log.jsonl'), $log + "`n")
$ids = Get-DirectMatchIds $app
Assert-True ($ids -is [hashtable] -and $ids.Count -eq 2 -and $ids.ContainsKey('2026-11-01T10-00-00') -and $ids.ContainsKey('2026-11-06T10-00-00')) "T85 direct matches: only ones logged direct (relay, mixed, unknown and damaged lines left out)"

$league = Join-Path $tmp 'league'
function Write-TestMatch([string]$Folder, [string]$RttS, [int]$AgeMin) {
  $d = Join-Path (Join-Path (Join-Path $league 'Logs') 'GameLogs') $Folder
  New-Item -ItemType Directory -Path $d -Force | Out-Null
  $rows = @('network.status,game.time,network.rtt_average') + @(1..8 | ForEach-Object { "Connected,$_,$RttS" })
  $f = Join-Path $d ($Folder + '_netstats.csv')
  [IO.File]::WriteAllText($f, ($rows -join "`n"))
  [IO.File]::SetLastWriteTime($f, (Get-Date).AddMinutes(-$AgeMin))
}
Write-TestMatch '2026-11-01T10-00-00' '0.050' 50
Write-TestMatch '2026-11-06T10-00-00' '0.052' 40
Write-TestMatch '2026-11-02T10-00-00' '0.030' 30
Write-TestMatch '2026-11-03T10-00-00' '0.031' 20
Write-TestMatch '2026-11-04T10-00-00' '0.029' 10
$all = Get-LeagueInGame -Dir $league
$direct = Get-LeagueInGame -Dir $league -OnlyFolders $ids
Assert-True ($all.Matches -eq 5 -and $all.MedianMs -eq 31) "T86 in-game ping: no filter = newest matches whatever their path (got $($all.MedianMs) ms over $($all.Matches))"
Assert-True ($direct.Matches -eq 2 -and $direct.MedianMs -eq 51) "T87 in-game ping: with Rig Doctor's log, relayed matches are left out (got $($direct.MedianMs) ms over $($direct.Matches))"
Assert-True ($null -eq (Get-LeagueInGame -Dir $league -OnlyFolders @{})) "T88 in-game ping: no match logged direct = none"
Remove-Item -LiteralPath $tmp -Recurse -Force

""
"$($script:tests - $script:fails)/$($script:tests) passed"
if ($script:fails -gt 0) { exit 1 } else { exit 0 }
