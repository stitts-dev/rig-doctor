# relay-gain-check.ps1 - estimate what a Chicago relay would save a League NA player, with no tunnel.
# PS 5.1, ASCII-only. Read-only: sends pings and a traceroute, reads League's own match logs,
# changes no network setting, installs nothing.
#
# Run (tester, no download step):
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/stitts-dev/rig-doctor/main/tools/relay-gain-check.ps1)))
# Or from a clone:  .\tools\relay-gain-check.ps1
# Dot-source for functions only (tests): . .\relay-gain-check.ps1 -TestOnly
#
# What it measures:
#   Direct  = League's own in-game ping from the newest match logs (netstats.csv, what the game
#             shows). With no match logs, the traceroute toward the League NA game server: the last
#             hop that answers is a lower bound, since the server itself drops ping.
#   Relay   = ping to Vultr's public Chicago test host (same city and network as our relay) plus
#             RelayOverheadMs for the relay -> Riot hand-off. 4 ms is calibrated from one in-match
#             test on 2026-11-07 (in-game 30-31 ms via relay vs 26 ms ping to Vultr Chicago).
#   Entry   = where the traceroute first reaches Riot's network (riotdirect.net hop name). A player
#             whose ISP hands off to Riot far from Chicago is the one a Chicago relay can help.
# The result is an estimate. Only in-match ping with the relay on confirms it.
#
# Share text has no IP addresses. The JSON saved locally keeps hop IPs masked to a.b.x.x.
param(
  [int]$Count = 20,
  [double]$RelayOverheadMs = 4,
  [string]$RelayCityHost = 'il-us-ping.vultr.com',
  [string]$GameServer = '192.207.0.5',
  [string]$LeagueDir = 'C:\Riot Games\League of Legends',
  [int]$MaxHops = 20,
  [string]$OutDir = (Join-Path $env:USERPROFILE '.rig-doctor'),
  [switch]$NoClipboard,
  [switch]$TestOnly
)

$script:Version = 1
$script:GainBarMs = 10

# ---------- pure helpers (unit-tested) ----------

function Get-Median {
  param([double[]]$Values)
  if ($null -eq $Values -or $Values.Count -eq 0) { return $null }
  $s = @($Values | Sort-Object)
  $n = $s.Count
  if ($n % 2 -eq 1) { return [double]$s[[int](($n - 1) / 2)] }
  return ([double]$s[$n / 2 - 1] + [double]$s[$n / 2]) / 2
}

function Hide-Ip {
  param([string]$Ip)
  if (-not $Ip) { return $null }
  if ($Ip -match '^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$') { return "$($Matches[1]).$($Matches[2]).x.x" }
  if ($Ip -match ':') { $g = $Ip.Split(':'); return "$($g[0]):$($g[1]):x" }
  return 'x'
}

function Test-PrivateIp {
  param([string]$Ip)
  if ($Ip -notmatch '^(\d{1,3})\.(\d{1,3})\.') { return $false }
  $a = [int]$Matches[1]; $b = [int]$Matches[2]
  return ($a -eq 10) -or ($a -eq 127) -or ($a -eq 192 -and $b -eq 168) -or ($a -eq 172 -and $b -ge 16 -and $b -le 31) -or
         ($a -eq 100 -and $b -ge 64 -and $b -le 127) -or ($a -eq 169 -and $b -eq 254)
}

# ISP name from a hop's reverse-DNS name. Offline, no lookup service.
function Get-IspFromName {
  param([string]$Name)
  if (-not $Name) { return $null }
  $n = $Name.ToLowerInvariant().TrimEnd('.')
  $known = [ordered]@{
    'comcast.net' = 'Comcast (Xfinity)'; 'charter.com' = 'Spectrum'; 'rr.com' = 'Spectrum'; 'spectrum.com' = 'Spectrum'
    'att.net' = 'AT&T'; 'sbcglobal.net' = 'AT&T'; 'verizon.net' = 'Verizon'; 'myvzw.com' = 'Verizon'
    'cox.net' = 'Cox'; 'frontiernet.net' = 'Frontier'; 'ftr.com' = 'Frontier'; 'centurylink.net' = 'CenturyLink'
    'qwest.net' = 'CenturyLink'; 'lumen.tech' = 'Lumen'; 'optonline.net' = 'Optimum'; 'altice.net' = 'Optimum'
    'suddenlink.net' = 'Optimum'; 'mediacomcc.com' = 'Mediacom'; 'wowinc.com' = 'WOW'; 'windstream.net' = 'Windstream'
    't-mobile.com' = 'T-Mobile'; 'tmodns.net' = 'T-Mobile'; 'googlefiber.net' = 'Google Fiber'; 'starlinkisp.net' = 'Starlink'
    'astound.net' = 'Astound'; 'rcn.net' = 'Astound'; 'sparklight.net' = 'Sparklight'; 'cableone.net' = 'Sparklight'
  }
  foreach ($k in $known.Keys) { if ($n -eq $k -or $n.EndsWith(".$k")) { return $known[$k] } }
  $parts = $n.Split('.')
  if ($parts.Count -ge 2) { return ($parts[-2] + '.' + $parts[-1]) }
  return $null
}

# Riot hop names look like "ae3.er02.chi01.riotdirect.net". Returns @{ Code; City } or $null.
function Get-RiotCity {
  param([string]$Name)
  if (-not $Name) { return $null }
  if ($Name.ToLowerInvariant() -notmatch '\.([a-z]{3})\d{2}\.riotdirect\.net\.?$') { return $null }
  $code = $Matches[1]
  $cities = @{ chi = 'Chicago'; was = 'Ashburn VA'; iad = 'Ashburn VA'; nyc = 'New York'; ewr = 'New Jersey';
               atl = 'Atlanta'; dfw = 'Dallas'; dal = 'Dallas'; mia = 'Miami'; lax = 'Los Angeles'; sjc = 'San Jose';
               sea = 'Seattle'; den = 'Denver'; tor = 'Toronto'; yyz = 'Toronto'; phx = 'Phoenix'; slc = 'Salt Lake City' }
  $city = $cities[$code]
  if (-not $city) { $city = $code }
  return @{ Code = $code; City = $city }
}

# In-game RTTs (ms) from a League netstats.csv. Same rules as desktop/src-tauri/src/matches.rs:
# columns by header name, Connected rows only, network.rtt_average is in seconds.
function Read-NetstatsRtts {
  param([string]$Text)
  $lines = @($Text -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
  if ($lines.Count -lt 2) { return @() }
  $head = @($lines[0].Split(',') | ForEach-Object { $_.Trim() })
  $iRtt = [array]::IndexOf($head, 'network.rtt_average')
  $iSt  = [array]::IndexOf($head, 'network.status')
  if ($iRtt -lt 0) { return @() }
  $out = New-Object System.Collections.Generic.List[double]
  foreach ($l in $lines[1..($lines.Count - 1)]) {
    $f = @($l.Split(',') | ForEach-Object { $_.Trim() })
    if ($iSt -ge 0 -and $iSt -lt $f.Count -and $f[$iSt] -ne 'Connected') { continue }
    if ($iRtt -ge $f.Count) { continue }
    $v = 0.0
    if (-not [double]::TryParse($f[$iRtt], [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$v)) { continue }
    if ($v -le 0 -or $v -ge 5) { continue }
    $out.Add([Math]::Round($v * 1000, 1))
  }
  return ,$out.ToArray()
}

# Direct estimate from the trace when there are no match logs: the slowest of the last two hops
# that answered (the game server itself never answers). A lower bound on in-game ping.
function Get-TraceDirectMs {
  param($Hops)
  $ans = @($Hops | Where-Object { $_.Ms -ne $null })
  if ($ans.Count -eq 0) { return $null }
  $tail = @($ans | Select-Object -Last 2)
  return [double](($tail | Measure-Object -Property Ms -Maximum).Maximum)
}

function Get-GainVerdict {
  param([double]$DirectMs, [double]$RelayMs, [double]$BarMs = $script:GainBarMs)
  $gain = [Math]::Round($DirectMs - $RelayMs, 0)
  $verdict = if ($gain -ge $BarMs) { 'Likely worth it' } elseif ($gain -ge 3) { 'Small gain' } else { 'No gain expected' }
  return [pscustomobject]@{ GainMs = $gain; Verdict = $verdict }
}

function Format-ShareText {
  param($R)
  $L = New-Object System.Collections.Generic.List[string]
  $L.Add("Rig Doctor relay gain check v$($R.version) ($($R.date))")
  $isp = if ($R.isp) { $R.isp } else { 'unknown' }
  $L.Add("ISP: $isp")
  if ($R.direct_ms -ne $null) {
    $src = if ($R.direct_source -eq 'in-game') { "League in-game ping, $($R.matches) match(es)" } else { 'traceroute, lower bound' }
    $L.Add("Direct to League NA: $($R.direct_ms) ms ($src)")
  } else {
    $L.Add('Direct to League NA: not measured (no match logs, trace got no answers)')
  }
  $entry = if ($R.riot_entry) { "$($R.riot_entry) at hop $($R.riot_entry_hop)" } else { 'not seen in trace' }
  $L.Add("Enters Riot network: $entry")
  if ($R.relay_city_ms -ne $null) {
    $L.Add("Via Chicago relay (est): $($R.relay_est_ms) ms = $($R.relay_city_ms) ms to Vultr Chicago + $($R.relay_overhead_ms) ms relay leg")
  } else {
    $L.Add('Via Chicago relay (est): not measured (Vultr Chicago did not answer)')
  }
  if ($R.gain_ms -ne $null) { $L.Add("Estimated gain: $($R.gain_ms) ms -> $($R.verdict)") }
  $L.Add('Estimate only. Only in-match ping with the relay on confirms it.')
  return ($L -join "`r`n")
}

if ($TestOnly) { return }

# ---------- live measurement ----------

function Resolve-NameQuick {
  param([string]$Ip, [int]$TimeoutMs = 1500)
  try {
    $ar = [System.Net.Dns]::BeginGetHostEntry($Ip, $null, $null)
    if ($ar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return ([System.Net.Dns]::EndGetHostEntry($ar)).HostName }
  } catch {}
  return $null
}

function Measure-Ping {
  param([string]$Target, [int]$N)
  $p = New-Object System.Net.NetworkInformation.Ping
  $ok = New-Object System.Collections.Generic.List[double]
  for ($i = 0; $i -lt $N; $i++) {
    try { $r = $p.Send($Target, 1500); if ($r.Status -eq 'Success') { $ok.Add([double]$r.RoundtripTime) } } catch {}
    Start-Sleep -Milliseconds 200
  }
  $method = 'icmp'
  if ($ok.Count -eq 0) {
    # Some networks block ICMP: fall back to timing a TCP handshake on 443.
    $method = 'tcp443'
    for ($i = 0; $i -lt [Math]::Min($N, 10); $i++) {
      $c = New-Object System.Net.Sockets.TcpClient
      $sw = [Diagnostics.Stopwatch]::StartNew()
      try { $t = $c.BeginConnect($Target, 443, $null, $null); if ($t.AsyncWaitHandle.WaitOne(1500) -and $c.Connected) { $sw.Stop(); $ok.Add([Math]::Round($sw.Elapsed.TotalMilliseconds, 1)) } } catch {}
      $c.Close()
    }
  }
  $med = Get-Median $ok.ToArray()
  return [pscustomobject]@{ MedianMs = $(if ($med -ne $null) { [Math]::Round($med, 0) } else { $null }); Replies = $ok.Count; Sent = $N; Method = $method }
}

function Get-Trace {
  param([string]$Target, [int]$Max)
  $p = New-Object System.Net.NetworkInformation.Ping
  $buf = New-Object byte[] 32
  $hops = New-Object System.Collections.Generic.List[object]
  $silent = 0
  for ($ttl = 1; $ttl -le $Max; $ttl++) {
    $opt = New-Object System.Net.NetworkInformation.PingOptions($ttl, $true)
    $ip = $null; $times = New-Object System.Collections.Generic.List[double]; $reached = $false
    for ($k = 0; $k -lt 3; $k++) {
      $sw = [Diagnostics.Stopwatch]::StartNew()
      try { $r = $p.Send($Target, 1000, $buf, $opt) } catch { $r = $null }
      $sw.Stop()
      if ($r -and ($r.Status -eq 'TtlExpired' -or $r.Status -eq 'Success')) {
        $ip = $r.Address.ToString()
        # RoundtripTime reads 0 for TtlExpired on .NET Framework, so time the call.
        $times.Add([Math]::Round($(if ($r.RoundtripTime -gt 0) { $r.RoundtripTime } else { $sw.Elapsed.TotalMilliseconds }), 1))
        if ($r.Status -eq 'Success') { $reached = $true }
      }
    }
    $name = if ($ip -and -not (Test-PrivateIp $ip)) { Resolve-NameQuick $ip } else { $null }
    $ms = $null; $mm = Get-Median $times.ToArray(); if ($mm -ne $null) { $ms = [Math]::Round($mm, 0) }
    $hops.Add([pscustomobject]@{ Hop = $ttl; Ip = $ip; Name = $name; Ms = $ms; Private = [bool]($ip -and (Test-PrivateIp $ip)) })
    Write-Host ("  hop {0,2}  {1,5}  {2}" -f $ttl, $(if ($ms -ne $null) { "$ms ms" } else { '*' }), $(if ($name) { $name } elseif ($ip) { Hide-Ip $ip } else { '' }))
    if ($reached) { break }
    if ($ip) { $silent = 0 } else { $silent++ }
    if ($silent -ge 3 -and $ttl -ge 6) { break }
  }
  return ,$hops.ToArray()
}

function Get-LeagueInGame {
  param([string]$Dir, [int]$Newest = 5, [int]$MaxAgeDays = 30)
  $logs = @((Join-Path $Dir 'Logs\GameLogs'), (Join-Path $Dir 'Game\Logs\GameLogs')) | Where-Object { Test-Path $_ }
  $files = @($logs | ForEach-Object { Get-ChildItem -Path $_ -Recurse -Filter '*_netstats.csv' -ErrorAction SilentlyContinue } |
    Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-$MaxAgeDays) } | Sort-Object LastWriteTime -Descending | Select-Object -First $Newest)
  $meds = New-Object System.Collections.Generic.List[double]
  foreach ($f in $files) {
    try {
      $fs = [IO.File]::Open($f.FullName, 'Open', 'Read', 'ReadWrite')
      try { $txt = (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
      $r = Read-NetstatsRtts $txt
      if ($r.Count -ge 6) { $meds.Add((Get-Median $r)) }
    } catch {}
  }
  if ($meds.Count -eq 0) { return $null }
  return [pscustomobject]@{ MedianMs = [Math]::Round((Get-Median $meds.ToArray()), 0); Matches = $meds.Count }
}

Write-Host 'Rig Doctor relay gain check. Read-only: pings and a traceroute, no network changes.'
Write-Host 'Turn off any VPN or ping booster first, or the numbers describe that instead.'
Write-Host ''
Write-Host "1/3 League match logs in $LeagueDir ..."
$ingame = Get-LeagueInGame -Dir $LeagueDir
if ($ingame) { Write-Host "  in-game ping $($ingame.MedianMs) ms over $($ingame.Matches) recent match(es)" } else { Write-Host '  none found (play a match first for the best number)' }

Write-Host "2/3 $Count pings to Vultr Chicago ($RelayCityHost) ..."
$city = Measure-Ping -Target $RelayCityHost -N $Count
Write-Host $(if ($city.MedianMs -ne $null) { "  $($city.MedianMs) ms median, $($city.Replies)/$($city.Sent) replies ($($city.Method))" } else { '  no replies' })

Write-Host '3/3 traceroute toward League NA game server ...'
$hops = Get-Trace -Target $GameServer -Max $MaxHops

$isp = $null
foreach ($h in $hops) { if ($h.Name -and -not (Get-RiotCity $h.Name) -and $h.Name -notmatch 'riotdirect') { $isp = Get-IspFromName $h.Name; if ($isp) { break } } }
$entry = $null; $entryHop = $null
foreach ($h in $hops) { $rc = Get-RiotCity $h.Name; if ($rc) { $entry = "$($rc.City) ($($rc.Code))"; $entryHop = $h.Hop; break } }

$directMs = $null; $directSrc = $null
if ($ingame) { $directMs = $ingame.MedianMs; $directSrc = 'in-game' }
else { $t = Get-TraceDirectMs $hops; if ($t -ne $null) { $directMs = $t; $directSrc = 'trace' } }

$relayEst = $null
if ($city.MedianMs -ne $null) { $relayEst = [Math]::Round($city.MedianMs + $RelayOverheadMs, 0) }
$gain = $null
if ($directMs -ne $null -and $relayEst -ne $null) { $gain = Get-GainVerdict -DirectMs $directMs -RelayMs $relayEst }

$result = [ordered]@{
  version = $script:Version; date = (Get-Date).ToString('yyyy-MM-dd'); isp = $isp
  direct_ms = $directMs; direct_source = $directSrc; matches = $(if ($ingame) { $ingame.Matches } else { 0 })
  riot_entry = $entry; riot_entry_hop = $entryHop
  relay_city_ms = $city.MedianMs; relay_city_method = $city.Method; relay_overhead_ms = $RelayOverheadMs; relay_est_ms = $relayEst
  gain_ms = $(if ($gain) { $gain.GainMs } else { $null }); verdict = $(if ($gain) { $gain.Verdict } else { $null })
  hops = @($hops | Where-Object { -not $_.Private } | ForEach-Object { [ordered]@{ hop = $_.Hop; ip = (Hide-Ip $_.Ip); name = $_.Name; ms = $_.Ms } })
}

$text = Format-ShareText $result
Write-Host ''
Write-Host '---- copy everything below and send it back ----'
Write-Host $text
Write-Host '------------------------------------------------'

try {
  if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
  $json = Join-Path $OutDir ("relay-gain-check-" + (Get-Date).ToString('yyyyMMdd-HHmmss') + '.json')
  $result | ConvertTo-Json -Depth 5 | Set-Content -Path $json -Encoding ASCII
  Write-Host "Saved: $json"
} catch { Write-Host "Could not save the JSON: $($_.Exception.Message)" }

if (-not $NoClipboard) { try { Set-Clipboard -Value $text; Write-Host 'Result copied to the clipboard.' } catch {} }
