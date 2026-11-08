# relay-gain-check.ps1 - estimate what a Chicago relay would save a League NA player, with no tunnel.
# PS 5.1, ASCII-only. Read-only: sends pings and a traceroute, reads League's own match logs, looks
# up the ISP's network number at stat.ripe.net and shares the result with a relay (see Sharing).
# Changes no network setting, installs nothing.
#
# Run (tester, no download step):
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/stitts-dev/rig-doctor/main/tools/relay-gain-check.ps1)))
# With a relay invite, which shares the result with that relay:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/stitts-dev/rig-doctor/main/tools/relay-gain-check.ps1))) -Invite 'rigrelay1....'
# Or from a clone:  .\tools\relay-gain-check.ps1 [-Invite 'rigrelay1....'] [-NoUpload]
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
# Sharing: with -Invite, or on a PC that joined a relay in the Rig Doctor app, the result goes to that
# relay's gain table for the player's ISP network. It uploads only the ISP's network number (ASN), the
# two ping numbers and the match count; no addresses or names. The invite still works for joining
# afterwards. Only results with League's in-game ping are shared. -NoUpload skips it.
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
  [string]$Invite,
  [switch]$NoUpload,
  [string]$AppDataDir = (Join-Path $env:APPDATA 'dev.jaden.rigdoctor.globe'),
  [switch]$NoClipboard,
  [switch]$TestOnly
)

$script:Version = 1
$script:GainBarMs = 10
$script:InvitePrefix = 'rigrelay1.'

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
  if ($R.asn) { $L.Add("ISP network: AS$($R.asn)") }
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

# ---------- sharing with a relay (pure helpers, unit-tested) ----------
# API contract: POST /v1/gain on the relay API (relay/api.py), Bearer = a device token or an invite secret.

function Get-UnixNow {
  return [long][Math]::Floor(([DateTime]::UtcNow - (New-Object DateTime 1970, 1, 1, 0, 0, 0, ([DateTimeKind]::Utc))).TotalSeconds)
}

# Where to send and how: the relay API's https://host:port, its pinned certificate (DER bytes), and the
# bearer. Ok = $false with Why (plain words, never quoting the invite) when it cannot be used.
function New-RelayCred {
  param($Why, $Api, $Cert, $Bearer, $From)
  return [pscustomobject]@{ Ok = (-not $Why); Why = $Why; Api = $Api; Cert = $Cert; Bearer = $Bearer; From = $From }
}

function Test-RelayApi {
  param($Api)
  return ($Api -is [string]) -and ($Api -cmatch '^https://[^/@?#\s]+:\d+/?$')
}

# The relay API's own self-signed TLS certificate, base64 DER. Returns the DER bytes, or $null.
function ConvertFrom-RelayCert {
  param($B64)
  if (-not ($B64 -is [string]) -or -not $B64) { return $null }
  try { $der = [Convert]::FromBase64String($B64) } catch { return $null }
  if ($der.Length -lt 100 -or $der.Length -gt 4096 -or $der[0] -ne 0x30) { return $null }
  return ,$der
}

# A relay invite from relay/invite.sh: rigrelay1.<base64url JSON, no padding> with v, name, api, cert,
# relay_key, secret and expires (unix seconds, 0 = never). Same checks as the app's
# (desktop/src-tauri/src/relay_api.rs) for the fields used here. Bearer = the invite secret.
function ConvertFrom-RelayInvite {
  param([string]$Text, [long]$NowUnix = (Get-UnixNow))
  $t = "$Text".Trim()
  if (-not $t.StartsWith($script:InvitePrefix, [StringComparison]::Ordinal)) { return (New-RelayCred -Why 'that is not a relay invite (it should start with rigrelay1.)') }
  if ($t.Length -gt 8192) { return (New-RelayCred -Why 'the invite is too long') }
  try {
    $blob = $t.Substring($script:InvitePrefix.Length).TrimEnd('=')
    if ($blob -cnotmatch '^[A-Za-z0-9_-]+$') { throw 'not base64url' }
    $b64 = $blob.Replace('-', '+').Replace('_', '/') + ('=' * ((4 - $blob.Length % 4) % 4))
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
  } catch { return (New-RelayCred -Why 'the invite is damaged (bad encoding); copy it again') }
  $o = $null
  try { $o = ConvertFrom-Json -InputObject $json } catch { $o = $null }
  $bad = 'the invite is damaged (bad contents); copy it again'
  if (-not ($o -is [System.Management.Automation.PSCustomObject])) { return (New-RelayCred -Why $bad) }
  if (-not ($o.v -is [int] -or $o.v -is [long])) { return (New-RelayCred -Why $bad) }
  if ($o.v -ne 1) { return (New-RelayCred -Why "the invite is version $($o.v); this script reads version 1") }
  if (-not (Test-RelayApi $o.api)) { return (New-RelayCred -Why "the invite's relay address is not valid") }
  if (-not ($o.secret -is [string]) -or $o.secret -cnotmatch '^[A-Za-z0-9_-]{43}$') { return (New-RelayCred -Why "the invite's secret is damaged; copy it again") }
  $der = ConvertFrom-RelayCert $o.cert
  if ($null -eq $der) { return (New-RelayCred -Why "the invite's relay certificate is damaged; copy it again") }
  $exp = $o.expires
  if ($null -eq $exp) { $exp = 0 }
  if (-not ($exp -is [int] -or $exp -is [long]) -or $exp -lt 0) { return (New-RelayCred -Why $bad) }
  if ($exp -ne 0 -and $exp -lt $NowUnix) { return (New-RelayCred -Why 'the invite has expired; ask for a new one') }
  return (New-RelayCred -Api $o.api -Cert $der -Bearer $o.secret -From 'invite')
}

# A relay this PC joined in the Rig Doctor app: <app data>\relay\saved\<id>.api.json holds api, cert,
# relay_key, token and prefix_version. The newest usable file wins; Bearer = its device token. Reads
# only those files, never the tunnel configs beside them. $null when there is none.
function Find-SavedRelay {
  param([string]$Dir)
  if (-not $Dir) { return $null }
  $saved = Join-Path (Join-Path $Dir 'relay') 'saved'
  if (-not (Test-Path -LiteralPath $saved -PathType Container)) { return $null }
  $files = @(Get-ChildItem -LiteralPath $saved -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*.api.json' } | Sort-Object LastWriteTime -Descending)
  foreach ($f in $files) {
    $o = $null
    try { $o = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($f.FullName)) } catch { continue }
    if (-not ($o -is [System.Management.Automation.PSCustomObject]) -or -not (Test-RelayApi $o.api)) { continue }
    if (-not ($o.token -is [string]) -or $o.token -cnotmatch '^[\x21-\x7E]{16,512}$') { continue }
    $der = ConvertFrom-RelayCert $o.cert
    if ($null -eq $der) { continue }
    return (New-RelayCred -Api $o.api -Cert $der -Bearer $o.token -From 'app')
  }
  return $null
}

# The address to look the ISP up by: the first hop that answered from a public address. Stops at Riot's
# network (riotdirect.net names): hops from there on are Riot's, not the ISP's.
function Get-FirstPublicHopIp {
  param($Hops)
  foreach ($h in @($Hops)) {
    if ($null -eq $h) { continue }
    if ($h.Name -and ($h.Name -match 'riotdirect' -or (Get-RiotCity $h.Name))) { return $null }
    if ($h.Ip -and -not (Test-PrivateIp $h.Ip)) { return [string]$h.Ip }
  }
  return $null
}

# ASN from a RIPEstat network-info answer: data.asns[0], which RIPEstat sends as a string ("7922").
# $null for an address nobody announces (empty list) or an answer that is not what was expected.
function Get-AsnFromRipe {
  param($Answer)
  if ($null -eq $Answer -or $Answer -is [string]) { return $null }
  $first = @($Answer.data.asns) | Select-Object -First 1
  if ($null -eq $first) { return $null }
  if ("$first".Trim() -notmatch '^(?:AS)?([0-9]{1,10})$') { return $null }
  $n = [long]$Matches[1]
  if ($n -lt 1 -or $n -gt 4294967295) { return $null }
  return $n
}

# The body for POST /v1/gain, source "estimate", or $null when this result cannot be shared: the direct
# number must be League's in-game ping (never a traceroute), and both numbers known and in 0-1000 ms.
function New-GainReport {
  param($R, $Asn)
  if ($null -eq $R -or $null -eq $Asn) { return $null }
  $a = [long]0
  if (-not [long]::TryParse("$Asn", [ref]$a) -or $a -lt 1 -or $a -gt 4294967295) { return $null }
  if ($R.direct_source -ne 'in-game' -or $null -eq $R.direct_ms -or $null -eq $R.relay_est_ms) { return $null }
  $n = [int]$R.matches; $d = [double]$R.direct_ms; $rl = [double]$R.relay_est_ms
  if ($n -lt 1 -or $d -le 0 -or $d -gt 1000 -or $rl -le 0 -or $rl -gt 1000) { return $null }
  return [ordered]@{
    v = 1; game = 'league'; source = 'estimate'; asn = $a; region = $null
    direct_ms = $d; relay_ms = $rl; direct_loss = $null; relay_loss = $null; direct_n = $n; relay_n = 0
  }
}

# Why this result is not shared with a relay, or $null when it can be.
function Get-NoShareReason {
  param([bool]$NoUpload, $Cred, $Asn, $R)
  if ($NoUpload) { return '-NoUpload was given' }
  if ($null -eq $Cred) { return 'this PC has not joined one and no -Invite was given. Send the text above' }
  if (-not $Cred.Ok) { return $Cred.Why }
  if ($R.direct_source -ne 'in-game') { return 'only League in-game ping is shared, and no recent match played direct was found. Play a match, then run this again' }
  if ($null -eq $R.relay_est_ms) { return 'Vultr Chicago did not answer, so there is no relay number' }
  if ($null -eq $Asn) { return 'the ISP network (ASN) could not be looked up' }
  if ($null -eq (New-GainReport $R $Asn)) { return 'a ping number is outside the 0-1000 ms the relay takes' }
  return $null
}

# The relay's 200 answer in plain words: this ASN's whole-network rows (region null).
function Format-GainRows {
  param($Answer, $Asn)
  $bar = $script:GainBarMs
  if ($null -ne $Answer -and ($Answer.bar_ms -is [int] -or $Answer.bar_ms -is [long] -or $Answer.bar_ms -is [double] -or $Answer.bar_ms -is [decimal])) { $bar = [double]$Answer.bar_ms }
  $rows = @(@($Answer.rows) | Where-Object { $null -ne $_ -and $null -eq $_.region -and "$($_.asn)" -eq "$Asn" })
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($src in @('in_game', 'estimate')) {
    $row = $rows | Where-Object { $_.source -eq $src } | Select-Object -First 1
    if ($null -eq $row) { continue }
    $p = [int]$row.players
    $who = if ($p -eq 1) { '1 player' } else { "$p players" }
    $g = [Math]::Round([double]$row.median_gain_ms, 1)
    if ($src -eq 'in_game') { $parts.Add("in game $g ms median gain ($who, $([int]$row.gaining) by $bar ms or more)") }
    else { $parts.Add("gain checks $g ms ($who)") }
  }
  if ($parts.Count -eq 0) { return "Shared with the relay. No results for AS$Asn yet." }
  return "Shared with the relay. Players on AS$Asn so far: $($parts -join '; ')."
}

# One plain reason for a failed upload: the relay's own error text for an HTTP error, else what went
# wrong on the way. Never holds the relay address, the token or the invite.
function Format-UploadFailure {
  param([int]$Status, $Answer, [string]$NetStatus, [bool]$CertRejected)
  if ($Status -gt 0) {
    $msg = ''
    if ($null -ne $Answer -and -not ($Answer -is [string]) -and $Answer.error -is [string]) { $msg = ($Answer.error -replace '[^\x20-\x7E]', '').Trim() }
    if ($msg.Length -gt 200) { $msg = $msg.Substring(0, 200) }
    if ($msg) { return "the relay answered $Status ($msg)" }
    return "the relay answered $Status"
  }
  if ($CertRejected) { return "the relay's certificate did not match the one pinned for it, so nothing was sent" }
  if ($NetStatus -eq 'Timeout') { return 'the relay did not answer within 10 s' }
  if ($NetStatus -eq 'ConnectFailure') { return 'could not reach the relay' }
  if ($NetStatus) { return "the upload failed ($NetStatus)" }
  return 'the upload failed'
}

# TLS pin for the relay API. Its certificate is self-signed for a bare IP, so normal validation always
# fails; the server is accepted only when its DER bytes equal the pinned ones. C#, not a PowerShell
# scriptblock: .NET can run the callback on a thread with no PowerShell runspace. C# 5 only, since
# PS 5.1 compiles it with the .NET Framework compiler. Set per request, never globally.
$script:PinSource = @'
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;

public static class RigDoctorGainPin1
{
    public static byte[] Expected;
    public static bool Rejected;

    public static bool SameBytes(byte[] a, byte[] b)
    {
        if (a == null || b == null || a.Length != b.Length) { return false; }
        for (int i = 0; i < a.Length; i++) { if (a[i] != b[i]) { return false; } }
        return true;
    }

    public static bool Check(object sender, X509Certificate cert, X509Chain chain, SslPolicyErrors errors)
    {
        bool ok = cert != null && SameBytes(cert.GetRawCertData(), Expected);
        if (!ok) { Rejected = true; }
        return ok;
    }

    public static readonly RemoteCertificateValidationCallback Callback = Check;
}
'@

# PS 5.1 fails Add-Type on any compiler warning, even one about the machine's LIB path, hence -IgnoreWarnings.
function Initialize-GainPin {
  if (-not ('RigDoctorGainPin1' -as [type])) { Add-Type -TypeDefinition $script:PinSource -IgnoreWarnings }
}

# League's own in-match ping: the median of each recent match's median. With -OnlyFolders, only
# matches whose log folder is in it count.
function Get-LeagueInGame {
  param([string]$Dir, [int]$Newest = 5, [int]$MaxAgeDays = 30, [hashtable]$OnlyFolders = $null)
  $logs = @((Join-Path $Dir 'Logs\GameLogs'), (Join-Path $Dir 'Game\Logs\GameLogs')) | Where-Object { Test-Path $_ }
  $files = @($logs | ForEach-Object { Get-ChildItem -Path $_ -Recurse -Filter '*_netstats.csv' -ErrorAction SilentlyContinue } |
    Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-$MaxAgeDays) -and ($null -eq $OnlyFolders -or $OnlyFolders.ContainsKey($_.Directory.Name)) } |
    Sort-Object LastWriteTime -Descending | Select-Object -First $Newest)
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

# The match folders Rig Doctor's own log (match-log.jsonl) says were played direct, or $null when this
# PC has no such log. Where the app runs, a match may have gone through the relay, so only these count
# as direct ping. A log that can't be read gives none.
function Get-DirectMatchIds {
  param([string]$AppDataDir)
  if (-not $AppDataDir) { return $null }
  $p = Join-Path $AppDataDir 'match-log.jsonl'
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { return $null }
  $ids = @{}
  try {
    $fs = [IO.File]::Open($p, 'Open', 'Read', 'ReadWrite')
    try { $txt = (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
  } catch { return $ids }
  foreach ($line in ($txt -split "`r?`n")) {
    if (-not $line.Trim()) { continue }
    $m = $null
    try { $m = ConvertFrom-Json -InputObject $line -ErrorAction Stop } catch { continue }
    if ($m -is [System.Management.Automation.PSCustomObject] -and $m.path -ceq 'direct' -and $m.id -is [string] -and $m.id) { $ids[$m.id] = $true }
  }
  return $ids
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

# One RIPEstat query: which network (ASN) announces the ISP's first public hop.
function Get-IspAsn {
  param([string]$Ip)
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $a = Invoke-RestMethod "https://stat.ripe.net/data/network-info/data.json?resource=$([Uri]::EscapeDataString($Ip))&sourceapp=rig-doctor" -TimeoutSec 10 -ErrorAction Stop
    return (Get-AsnFromRipe $a)
  } catch { return $null }
}

# POST /v1/gain to the relay API, accepted only from the server whose certificate is the pinned one.
# Returns @{ Status (0 = no answer); Answer; Why (plain reason when not 200) }. Prints nothing.
function Send-GainReport {
  param([string]$Api, [byte[]]$Cert, [string]$Bearer, $Body, [int]$TimeoutMs = 10000)
  $status = 0; $text = $null; $netStatus = $null; $resp = $null
  try {
    Initialize-GainPin
    [RigDoctorGainPin1]::Expected = $Cert
    [RigDoctorGainPin1]::Rejected = $false
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $data = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Compress))
    $req = [System.Net.HttpWebRequest]([System.Net.WebRequest]::Create($Api.TrimEnd('/') + '/v1/gain'))
    $req.Method = 'POST'
    $req.ContentType = 'application/json'
    $req.Accept = 'application/json'
    $req.UserAgent = 'rig-doctor-relay-gain-check'
    $req.Timeout = $TimeoutMs
    $req.ReadWriteTimeout = $TimeoutMs
    $req.AllowAutoRedirect = $false
    $req.KeepAlive = $false
    $req.ServerCertificateValidationCallback = [RigDoctorGainPin1]::Callback
    $req.Headers.Add('Authorization', 'Bearer ' + $Bearer)
    try { $req.ServicePoint.Expect100Continue = $false } catch {}
    $req.ContentLength = $data.Length
    $s = $req.GetRequestStream()
    try { $s.Write($data, 0, $data.Length) } finally { $s.Close() }
    $resp = $req.GetResponse()
  } catch {
    # Exception messages can name the relay's address, so only the status name is kept.
    $ex = $_.Exception
    while ($null -ne $ex -and -not ($ex -is [System.Net.WebException])) { $ex = $ex.InnerException }
    if ($null -ne $ex -and $null -ne $ex.Response) { $resp = $ex.Response }
    elseif ($null -ne $ex) {
      $netStatus = [string]$ex.Status
      # .NET Core (pwsh) reports a refused connection as UnknownError around a SocketException.
      if ($netStatus -eq 'UnknownError') { $e = $ex.InnerException; while ($null -ne $e) { if ($e -is [System.Net.Sockets.SocketException]) { $netStatus = 'ConnectFailure'; break }; $e = $e.InnerException } }
    }
    else { $e = $_.Exception; while ($null -ne $e.InnerException) { $e = $e.InnerException }; $netStatus = $e.GetType().Name }
  }
  if ($null -ne $resp) {
    try {
      $status = [int]$resp.StatusCode
      $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8)
      try { $text = $sr.ReadToEnd() } finally { $sr.Close() }
    } catch {} finally { $resp.Close() }
  }
  $answer = $null
  if ($text) { try { $answer = ConvertFrom-Json -InputObject $text } catch { $answer = $null } }
  $why = $null
  if ($status -ne 200) {
    $rejected = $false
    if ('RigDoctorGainPin1' -as [type]) { $rejected = [RigDoctorGainPin1]::Rejected }
    $why = Format-UploadFailure -Status $status -Answer $answer -NetStatus $netStatus -CertRejected $rejected
  }
  return [pscustomobject]@{ Status = $status; Answer = $answer; Why = $why }
}

Write-Host 'Rig Doctor relay gain check. Read-only: pings, a traceroute and an ISP lookup, no network changes.'
Write-Host 'Turn off any VPN or ping booster first, or the numbers describe that instead.'
$cred = $null
if (-not $NoUpload) { if ($Invite) { $cred = ConvertFrom-RelayInvite $Invite } else { $cred = Find-SavedRelay $AppDataDir } }
if ($cred -and -not $cred.Ok) { Write-Host "Not sharing with a relay: $($cred.Why). The check still runs." }
elseif ($cred) { Write-Host 'Will share the result with your relay: ISP network number, the two ping numbers and the match count. No addresses or names. -NoUpload skips it.' }
Write-Host ''
Write-Host "1/3 League match logs in $LeagueDir ..."
$onlyDirect = Get-DirectMatchIds $AppDataDir
if ($null -ne $onlyDirect) { Write-Host '  Rig Doctor is installed here, so only matches it logged as played direct count' }
$ingame = Get-LeagueInGame -Dir $LeagueDir -OnlyFolders $onlyDirect
if ($ingame) { Write-Host "  in-game ping $($ingame.MedianMs) ms over $($ingame.Matches) recent match(es)" } else { Write-Host '  none found (play a match first for the best number)' }

Write-Host "2/3 $Count pings to Vultr Chicago ($RelayCityHost) ..."
$city = Measure-Ping -Target $RelayCityHost -N $Count
Write-Host $(if ($city.MedianMs -ne $null) { "  $($city.MedianMs) ms median, $($city.Replies)/$($city.Sent) replies ($($city.Method))" } else { '  no replies' })

Write-Host '3/3 traceroute toward League NA game server ...'
$hops = Get-Trace -Target $GameServer -Max $MaxHops
$asnIp = Get-FirstPublicHopIp $hops
$asn = $null
if ($asnIp) { $asn = Get-IspAsn $asnIp }
if ($asn) { Write-Host "  ISP network: AS$asn" } elseif ($asnIp) { Write-Host '  ISP network: not found at stat.ripe.net' } else { Write-Host '  ISP network: unknown (no public ISP hop in the trace)' }

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
  version = $script:Version; date = (Get-Date).ToString('yyyy-MM-dd'); isp = $isp; asn = $asn
  direct_ms = $directMs; direct_source = $directSrc; matches = $(if ($ingame) { $ingame.Matches } else { 0 })
  riot_entry = $entry; riot_entry_hop = $entryHop
  relay_city_ms = $city.MedianMs; relay_city_method = $city.Method; relay_overhead_ms = $RelayOverheadMs; relay_est_ms = $relayEst
  gain_ms = $(if ($gain) { $gain.GainMs } else { $null }); verdict = $(if ($gain) { $gain.Verdict } else { $null })
  uploaded = $false
  hops = @($hops | Where-Object { -not $_.Private } | ForEach-Object { [ordered]@{ hop = $_.Hop; ip = (Hide-Ip $_.Ip); name = $_.Name; ms = $_.Ms } })
}

$text = Format-ShareText $result
Write-Host ''
Write-Host '---- copy everything below and send it back ----'
Write-Host $text
Write-Host '------------------------------------------------'

$why = Get-NoShareReason -NoUpload $NoUpload.IsPresent -Cred $cred -Asn $asn -R $result
if ($why) { Write-Host "Not shared with a relay: $why." }
else {
  $up = Send-GainReport -Api $cred.Api -Cert $cred.Cert -Bearer $cred.Bearer -Body (New-GainReport $result $asn)
  if ($up.Status -eq 200) {
    $result.uploaded = $true
    $line = 'Shared with the relay.'
    try { $line = Format-GainRows $up.Answer $asn } catch {}
    Write-Host $line
  } else {
    # An invite stops working for sharing once it is used to join; the joined app's token takes over.
    $tail = ''
    if ($up.Status -eq 401 -and $cred.From -eq 'invite') { $tail = ' If this PC has joined the relay since, run this again without -Invite.' }
    Write-Host "Not shared with a relay: $($up.Why).$tail"
  }
}

try {
  if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
  $json = Join-Path $OutDir ("relay-gain-check-" + (Get-Date).ToString('yyyyMMdd-HHmmss') + '.json')
  $result | ConvertTo-Json -Depth 5 | Set-Content -Path $json -Encoding ASCII
  Write-Host "Saved: $json"
} catch { Write-Host "Could not save the JSON: $($_.Exception.Message)" }

if (-not $NoClipboard) { try { Set-Clipboard -Value $text; Write-Host 'Result copied to the clipboard.' } catch {} }
