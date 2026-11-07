//! Rig Doctor Globe backend: enumerates live connections, streams tracert hops,
//! samples ping, geolocates hops, and stores relay config.
//! Everything shells out to the stock OS tools (see platform.rs), so no driver or admin is needed.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::net::IpAddr;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub mod geoip;
pub mod launchd;
pub mod peak;
pub mod platform;
pub mod proof;
pub mod relay;
pub mod route_auto;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn cmd(program: &str) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))] // only Windows sets creation flags
    let mut c = Command::new(program);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

fn run_capture(program: &str, args: &[&str]) -> Result<String, String> {
    let out = cmd(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("{program}: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// ---------- connections ----------

#[derive(Serialize, Clone, Debug)]
pub struct Conn {
    pub pid: u32,
    pub process: String,
    pub proto: String,
    pub local: String,
    pub remote_ip: String,
    pub remote_port: u16,
    pub state: String,
}

fn split_addr(s: &str) -> Option<(String, u16)> {
    let (host, port) = s.rsplit_once(':')?;
    let host = host.trim_start_matches('[').trim_end_matches(']').to_string();
    let port = port.parse().ok()?;
    Some((host, port))
}

fn is_public(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            !(v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || v.is_multicast()
                || v.is_broadcast()
                || v.is_unspecified()
                || (o[0] == 100 && (64..=127).contains(&o[1])) // CGNAT and Tailscale
                || o[0] == 0)
        }
        IpAddr::V6(v) => {
            let seg = v.segments();
            !(v.is_loopback()
                || v.is_unspecified()
                || v.is_multicast()
                || (seg[0] & 0xffc0) == 0xfe80 // link local
                || (seg[0] & 0xfe00) == 0xfc00) // unique local
        }
    }
}

/// One outbound connection from a `netstat -ano` line, before its process is named.
/// Skips rows owned by PID 0: those are sockets in TIME_WAIT that no process owns any more,
/// and naming them shows a "[System Process]" that is not talking to anyone.
/// The state column is localized on some Windows editions, so PID 0 is the test, not the word.
#[cfg_attr(not(windows), allow(dead_code))] // tests run it everywhere
fn parse_netstat_line(line: &str) -> Option<(u32, &'static str, String, String, u16, String)> {
    let t: Vec<&str> = line.split_whitespace().collect();
    if t.len() < 4 {
        return None;
    }
    let (proto, local, remote, state, pid) = match t[0] {
        "TCP" if t.len() >= 5 => ("tcp", t[1], t[2], t[3], t[4]),
        "UDP" => ("udp", t[1], t[2], "", t[3]),
        _ => return None,
    };
    let (rip, rport) = split_addr(remote)?;
    let ip = rip.parse::<IpAddr>().ok()?;
    if !is_public(&ip) {
        return None;
    }
    let pid = pid.parse::<u32>().ok()?;
    if pid == 0 || state.eq_ignore_ascii_case("TIME_WAIT") {
        return None;
    }
    Some((pid, proto, local.to_string(), rip, rport, state.to_string()))
}

/// The game server from a League r3dlog line: `Connecting to address (1.2.3.4) port (7239)`.
fn parse_league_connect(line: &str) -> Option<(String, u16)> {
    let rest = &line[line.find("Connecting to address (")? + "Connecting to address (".len()..];
    let (ip, rest) = rest.split_once(')')?;
    let port = rest.split_once("port (")?.1.split_once(')')?.0;
    let ip: IpAddr = ip.trim().parse().ok()?;
    let port: u16 = port.trim().parse().ok()?;
    is_public(&ip).then(|| (ip.to_string(), port))
}

/// League install folders: the Riot Client's product settings name them, else the default path.
fn league_install_dirs() -> Vec<PathBuf> {
    let meta = platform::league_metadata_dir();
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(&meta)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("league_of_legends."))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let text = std::fs::read_to_string(e.path().join(format!("{name}.product_settings.yaml"))).ok()?;
            let line = text.lines().find(|l| l.trim_start().starts_with("product_install_full_path:"))?;
            Some(PathBuf::from(line.split_once(':')?.1.trim().trim_matches('"')))
        })
        .collect();
    let default = platform::league_default_dir();
    if !dirs.contains(&default) {
        dirs.push(default);
    }
    dirs
}

/// The server of the running game: the last "Connecting to address" in the newest game log.
fn league_game_server() -> Option<(String, u16)> {
    let newest = league_install_dirs()
        .into_iter()
        .flat_map(|d| platform::league_game_log_dirs(&d))
        .flat_map(|logs| std::fs::read_dir(logs).into_iter().flatten().flatten())
        .flat_map(|game| std::fs::read_dir(game.path()).into_iter().flatten().flatten())
        .filter(|f| f.file_name().to_string_lossy().ends_with("_r3dlog.txt"))
        .filter_map(|f| Some((f.metadata().ok()?.modified().ok()?, f.path())))
        .max_by_key(|(t, _)| *t)?
        .1;
    let bytes = std::fs::read(newest).ok()?;
    String::from_utf8_lossy(&bytes).lines().rev().find_map(parse_league_connect)
}

#[tauri::command]
fn list_connections() -> Result<Vec<Conn>, String> {
    let rows = platform::connection_rows()?;
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let name_of = |pid: u32| -> String {
        sys.process(sysinfo::Pid::from_u32(pid))
            .map(|p| p.name().to_string_lossy().trim_end_matches(".exe").to_string())
            .unwrap_or_else(|| format!("pid {pid}"))
    };
    // League's game socket is unconnected UDP, so netstat shows its remote as *:*. The game
    // writes the server it joins to its own log, which is the only place left to read it from
    // (Vanguard blocks reading the game process's command line).
    let league = sys
        .processes()
        .iter()
        .find(|(_, p)| platform::is_league_game(&p.name().to_string_lossy()))
        .and_then(|(pid, p)| {
            let (ip, port) = league_game_server()?;
            Some(Conn {
                pid: pid.as_u32(),
                process: p.name().to_string_lossy().trim_end_matches(".exe").to_string(),
                proto: "udp".into(),
                local: String::new(),
                remote_ip: ip,
                remote_port: port,
                state: "GAME".into(),
            })
        });
    Ok(rows
        .into_iter()
        .map(|(pid, proto, local, remote_ip, remote_port, state)| Conn {
            pid,
            process: name_of(pid),
            proto: proto.into(),
            local,
            remote_ip,
            remote_port,
            state,
        })
        .chain(league)
        .collect())
}

// ---------- traceroute ----------

#[derive(Serialize, Clone, Debug)]
pub struct HopEvent {
    pub id: String,
    pub hop: u32,
    pub ip: Option<String>,
    pub rtts: Vec<Option<f64>>,
    pub avg: Option<f64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct RdnsEvent {
    pub id: String,
    pub hop: u32,
    pub ip: String,
    pub name: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct DoneEvent {
    pub id: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// A round-trip time token: "12", "<1", or either with the unit glued on ("12ms", "<1ms").
/// Returns the value and whether a unit was attached.
fn rtt_token(t: &str) -> Option<(f64, bool)> {
    let (sub_ms, rest) = match t.strip_prefix('<') {
        Some(r) => (true, r),
        None => (false, t),
    };
    let end = rest.find(|c: char| !c.is_ascii_digit() && c != '.').unwrap_or(rest.len());
    if end == 0 {
        return None;
    }
    let v: f64 = rest[..end].parse().ok()?;
    let glued = end < rest.len();
    if glued && rest[end..].chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((if sub_ms { v / 2.0 } else { v }, glued))
}

/// Parses one hop row of Windows `tracert -d`. The unit after each time is localized
/// ("ms", "мс", or mangled bytes in a non-UTF-8 code page), so any token without a digit
/// that follows a number is taken as its unit instead of matching the English "ms".
fn parse_tracert_line(line: &str) -> Option<HopEvent> {
    let mut toks = line.split_whitespace().peekable();
    let hop: u32 = toks.next()?.parse().ok()?;
    let mut rtts: Vec<Option<f64>> = Vec::new();
    while rtts.len() < 3 {
        let t = toks.next()?;
        if t == "*" {
            rtts.push(None);
            continue;
        }
        let (v, glued) = rtt_token(t)?;
        if !glued {
            match toks.peek() {
                Some(u) if *u != "*" && !u.chars().any(|c| c.is_ascii_digit()) => {
                    toks.next();
                }
                _ => return None,
            }
        }
        rtts.push(Some(v));
    }
    let rest: Vec<&str> = toks.collect();
    let ip = rest
        .first()
        .map(|s| s.trim_start_matches('[').trim_end_matches(']'))
        .and_then(|s| s.parse::<IpAddr>().ok())
        .map(|i| i.to_string());
    let good: Vec<f64> = rtts.iter().flatten().copied().collect();
    let avg = if good.is_empty() { None } else { Some(good.iter().sum::<f64>() / good.len() as f64) };
    Some(HopEvent { id: String::new(), hop, ip, rtts, avg })
}

/// How a finished tracert run is reported. A run that exits non-zero, or never printed a hop,
/// failed: tracert prints its reason ("Unable to resolve target system name ...") as the last line.
fn trace_outcome(exit_ok: bool, hops: usize, last_other_line: Option<&str>) -> (bool, Option<String>) {
    if exit_ok && hops > 0 {
        return (true, None);
    }
    let why = last_other_line.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    (false, Some(why.unwrap_or_else(|| if hops == 0 { "tracert returned no hops".into() } else { "tracert failed".into() })))
}

/// Lines of a child's output, decoded lossily. Non-English tracert prints in the console's OEM
/// code page, which is not UTF-8; `BufRead::lines` errors on such a line and ends the trace early.
fn lossy_lines<R: std::io::Read>(r: R) -> impl Iterator<Item = String> {
    BufReader::new(r)
        .split(b'\n')
        .map_while(Result::ok)
        .map(|b| String::from_utf8_lossy(&b).trim_end_matches('\r').to_string())
}

#[tauri::command]
fn trace(app: AppHandle, id: String, target: String, max_hops: u32) -> Result<(), String> {
    if !platform::valid_target(&target) {
        return Err(format!("\"{target}\" is not an IP address or hostname"));
    }
    std::thread::spawn(move || {
        let (prog, args) = platform::trace_command(&target, max_hops.clamp(1, 40));
        let child = cmd(prog).args(&args).stdout(Stdio::piped()).stderr(platform::trace_stderr()).spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                let _ = app.emit("trace:done", DoneEvent { id, ok: false, error: Some(e.to_string()) });
                return;
            }
        };
        let stdout = child.stdout.take().unwrap();
        let mut seen: HashSet<String> = HashSet::new();
        let mut hops_seen = 0usize;
        let mut last_other: Option<String> = None;
        for line in lossy_lines(stdout) {
            let parsed = platform::parse_hop_line(&line);
            if parsed.is_none() && !line.trim().is_empty() {
                last_other = Some(line.clone());
            }
            if let Some(mut ev) = parsed {
                hops_seen += 1;
                ev.id = id.clone();
                let hop = ev.hop;
                let lookup = ev.ip.clone().filter(|ip| seen.insert(ip.clone()));
                // Emit the hop before starting its lookup, so its rDNS answer can never arrive first.
                let _ = app.emit("trace:hop", ev);
                if let Some(ip) = lookup {
                    let app2 = app.clone();
                    let id2 = id.clone();
                    std::thread::spawn(move || {
                        if let Ok(addr) = ip.parse::<IpAddr>() {
                            if let Ok(name) = dns_lookup::lookup_addr(&addr) {
                                if name != ip {
                                    let _ = app2.emit("trace:rdns", RdnsEvent { id: id2, hop, ip, name });
                                }
                            }
                        }
                    });
                }
            }
        }
        if let Some(mut err) = child.stderr.take() {
            let mut text = String::new();
            let _ = std::io::Read::read_to_string(&mut err, &mut text);
            if let Some(why) = platform::trace_stderr_reason(&text) {
                last_other = Some(why);
            }
        }
        let exit_ok = child.wait().map(|s| s.success()).unwrap_or(false);
        let (ok, error) = trace_outcome(exit_ok, hops_seen, last_other.as_deref());
        let _ = app.emit("trace:done", DoneEvent { id, ok, error });
    });
    Ok(())
}

// ---------- ping ----------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PingStats {
    pub host: String,
    pub sent: u32,
    pub received: u32,
    pub min: Option<f64>,
    pub avg: Option<f64>,
    pub max: Option<f64>,
    pub p95: Option<f64>,
    pub jitter: Option<f64>,
}

/// Reply times from Windows `ping` output, in any display language.
/// A reply row is unindented (the statistics block is indented) and its time is the last
/// `=N` or `<N` before "TTL", which is never translated. IPv6 replies have no TTL, so there the
/// last `=N`/`<N` on the row is the time. The words around it ("time", "Zeit", "temps", "время")
/// and the unit are never read. "<1" counts as 0.5 ms.
fn parse_ping_rtts(text: &str) -> Vec<f64> {
    let mut rtts = Vec::new();
    for line in text.lines() {
        if line.starts_with(char::is_whitespace) {
            continue;
        }
        let head = match line.find("TTL") {
            Some(i) => &line[..i],
            None => line,
        };
        let Some(i) = head.rfind(['=', '<']) else { continue };
        let after = head[i + 1..].trim_start();
        let num: String = after.chars().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',').collect();
        // A number with no unit after it is not a time ("Sent = 4" style counters).
        let unit = after[num.len()..].trim_start();
        if num.is_empty() || unit.is_empty() || unit.starts_with(|c: char| c.is_ascii_digit()) {
            continue;
        }
        if let Ok(v) = num.replace(',', ".").parse::<f64>() {
            rtts.push(if head.as_bytes()[i] == b'<' { v / 2.0 } else { v });
        }
    }
    rtts
}

/// Nearest-rank percentile of sorted samples: the smallest value with at least `p` of samples at or
/// below it. With 4 samples the 95th percentile is the largest, not the third.
fn percentile(sorted: &[f64], p: f64) -> f64 {
    let rank = (p * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

fn ping_blocking(host: String, count: u32) -> Result<PingStats, String> {
    if !platform::valid_target(&host) {
        return Err(format!("\"{host}\" is not an IP address or hostname"));
    }
    let n = count.clamp(1, 200);
    let (prog, args) = platform::ping_command(&host, n);
    let text = run_capture(prog, &args.iter().map(String::as_str).collect::<Vec<_>>())?;
    let rtts = platform::parse_ping(&text);
    let received = rtts.len() as u32;
    if rtts.is_empty() {
        return Ok(PingStats { host, sent: n, received, min: None, avg: None, max: None, p95: None, jitter: None });
    }
    let mut sorted = rtts.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let avg = rtts.iter().sum::<f64>() / rtts.len() as f64;
    let var = rtts.iter().map(|v| (v - avg).powi(2)).sum::<f64>() / rtts.len() as f64;
    let p95 = percentile(&sorted, 0.95);
    Ok(PingStats {
        host,
        sent: n,
        received,
        min: Some(sorted[0]),
        avg: Some(avg),
        max: Some(*sorted.last().unwrap()),
        p95: Some(p95),
        jitter: Some(var.sqrt()),
    })
}

#[tauri::command]
async fn ping_stats(host: String, count: u32) -> Result<PingStats, String> {
    tauri::async_runtime::spawn_blocking(move || ping_blocking(host, count))
        .await
        .map_err(|e| e.to_string())?
}

// ---------- geolocation (offline DB-IP Lite only, see geoip.rs) ----------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Geo {
    pub query: String,
    pub status: String,
    #[serde(default)]
    pub city: Option<String>,
    #[serde(default, rename = "regionName")]
    pub region: Option<String>,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub lat: Option<f64>,
    #[serde(default)]
    pub lon: Option<f64>,
    #[serde(default)]
    pub isp: Option<String>,
    #[serde(default, rename = "as")]
    pub asn: Option<String>,
}

struct GeoCache {
    path: PathBuf,
    map: HashMap<String, Geo>,
}

impl GeoCache {
    fn load(path: PathBuf) -> Self {
        let map = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self { path, map }
    }
    fn save(&self) {
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(s) = serde_json::to_string(&self.map) {
            let _ = std::fs::write(&self.path, s);
        }
    }
}

struct AppState {
    geo: Mutex<GeoCache>,
    config_path: PathBuf,
}

/// Splits a request into cached answers and the queries that must be fetched.
/// "self" is never answered from the cache: this machine's public address, and so its
/// home location, changes when it moves to another network.
fn split_cached(cache: &HashMap<String, Geo>, ips: &[String]) -> (Vec<Geo>, Vec<String>) {
    let mut hit = Vec::new();
    let mut missing = Vec::new();
    for ip in ips {
        match cache.get(ip).filter(|_| ip != "self") {
            Some(g) => hit.push(g.clone()),
            None => missing.push(ip.clone()),
        }
    }
    (hit, missing)
}

fn fail_geo(query: &str) -> Geo {
    Geo { query: query.into(), status: "fail".into(), city: None, region: None, country: None, lat: None, lon: None, isp: None, asn: None }
}

/// One lookup. `ip` None asks for this machine's own public address. Only the offline database
/// answers: the free online GeoIP services forbid commercial use, so none is asked.
async fn fetch_geo(client: &reqwest::Client, db: Option<&geoip::OfflineDb>, query: &str, ip: Option<&str>) -> Geo {
    let Some(db) = db else { return fail_geo(query) };
    let addr = match ip {
        Some(ip) => ip.parse().ok(),
        None => geoip::public_ip(client).await,
    };
    addr.and_then(|a| db.lookup(query, a)).unwrap_or_else(|| fail_geo(query))
}

#[tauri::command]
async fn geolocate(app: AppHandle, ips: Vec<String>) -> Result<Vec<Geo>, String> {
    let state = app.state::<AppState>();
    // On first launch the database is still downloading: wait for it rather than answer nothing.
    let offline = app.state::<geoip::GeoDb>().ready(std::time::Duration::from_secs(180)).await;
    // Offline answers are local and current, so the cache (which may hold older answers) is skipped.
    let (mut result, missing) = match offline {
        Some(_) => (Vec::new(), ips.clone()),
        None => split_cached(&state.geo.lock().unwrap().map, &ips),
    };
    if missing.is_empty() {
        return Ok(result);
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    // "self" looks up this machine's public address.
    let wants_self = missing.iter().any(|s| s == "self");
    let mut fetched: Vec<Geo> = Vec::new();
    // Lookups take addresses, so a relay given as a hostname is resolved first
    // and its answer is filed back under the hostname the UI asked for.
    // Several names can resolve to one address, so each address keeps every name that asked for it.
    let mut asked_as: HashMap<String, Vec<String>> = HashMap::new();
    let mut batch: Vec<String> = Vec::new();
    let mut ask = |ip: String, q: &String| {
        let names = asked_as.entry(ip.clone()).or_default();
        if names.is_empty() {
            batch.push(ip);
        }
        names.push(q.clone());
    };
    for q in missing.iter().filter(|s| *s != "self") {
        if q.parse::<IpAddr>().is_ok() {
            ask(q.clone(), q);
            continue;
        }
        let host = q.clone();
        let resolved = tauri::async_runtime::spawn_blocking(move || {
            // Prefer IPv4, fall back to IPv6 for a v6-only relay.
            let addrs: Vec<IpAddr> = dns_lookup::lookup_host(&host).ok()?.collect();
            addrs.iter().find(|a| a.is_ipv4()).or_else(|| addrs.first()).copied()
        })
            .await
            .ok()
            .flatten();
        match resolved {
            Some(ip) => ask(ip.to_string(), q),
            None => fetched.push(fail_geo(q)),
        }
    }
    if wants_self {
        let fresh = Some(fetch_geo(&client, offline.as_deref(), "self", None).await).filter(|g| g.status == "success");
        // No database or no network: the last known home is better than none.
        let g = fresh.or_else(|| state.geo.lock().unwrap().map.get("self").cloned());
        if let Some(mut g) = g {
            g.query = "self".into();
            fetched.push(g);
        }
    }
    // A few lookups at a time keeps a full trace quick.
    for chunk in batch.chunks(6) {
        let jobs: Vec<_> = chunk
            .iter()
            .map(|ip| {
                let (client, ip, db) = (client.clone(), ip.clone(), offline.clone());
                tauri::async_runtime::spawn(async move { fetch_geo(&client, db.as_deref(), &ip, Some(&ip)).await })
            })
            .collect();
        for job in jobs {
            let g = job.await.map_err(|e| format!("geolocate: {e}"))?;
            match asked_as.get(&g.query) {
                Some(names) => fetched.extend(names.iter().map(|n| Geo { query: n.clone(), ..g.clone() })),
                None => fetched.push(g),
            }
        }
    }
    {
        let mut cache = state.geo.lock().unwrap();
        for g in fetched.iter() {
            if g.status == "success" {
                cache.map.insert(g.query.clone(), g.clone());
            }
        }
        cache.save();
    }
    result.extend(fetched);
    Ok(result)
}

#[tauri::command]
fn geoip_status(app: AppHandle) -> geoip::GeoDbStatus {
    app.state::<geoip::GeoDb>().status()
}

/// Downloads the current DB-IP Lite city and ASN databases when they are missing or older.
#[tauri::command]
async fn geoip_update(app: AppHandle) -> Result<geoip::GeoDbStatus, String> {
    let client = geoip::download_client()?;
    app.state::<geoip::GeoDb>().update(&client, geoip::now_secs()).await
}

// ---------- config ----------

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Relay {
    pub name: String,
    pub host: String,
    #[serde(default)]
    pub lat: Option<f64>,
    #[serde(default)]
    pub lng: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Config {
    #[serde(default)]
    pub relays: Vec<Relay>,
    #[serde(default)]
    pub focus: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peak: Option<peak::PeakConfig>,
}

#[tauri::command]
fn read_config(app: AppHandle) -> Result<Config, String> {
    let p = &app.state::<AppState>().config_path;
    match std::fs::read_to_string(p) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| e.to_string()),
        Err(_) => Ok(Config::default()),
    }
}

#[tauri::command]
fn write_config(app: AppHandle, config: Config) -> Result<(), String> {
    let p = &app.state::<AppState>().config_path;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let s = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(p, s).map_err(|e| e.to_string())
}

// ---------- peak-hour trace log ----------

fn app_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| peak::data_dir())
}

#[derive(Serialize, Clone, Debug)]
pub struct PeakStatus {
    pub scheduled: bool,
    pub log_path: String,
    pub samples: usize,
}

#[tauri::command]
fn peak_status(app: AppHandle) -> PeakStatus {
    let dir = app_dir(&app);
    PeakStatus { scheduled: peak::is_scheduled(), log_path: dir.join(peak::LOG_FILE).to_string_lossy().into_owned(), samples: peak::read_log(&dir).len() }
}

#[tauri::command]
fn peak_log(app: AppHandle) -> Vec<peak::PeakSample> {
    peak::read_log(&app_dir(&app))
}

#[tauri::command]
async fn peak_sample_now(app: AppHandle, target: String) -> Result<peak::PeakSample, String> {
    let dir = app_dir(&app);
    tauri::async_runtime::spawn_blocking(move || peak::sample_and_append(&dir, &target)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn peak_schedule(plan: peak::SchedulePlan) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || peak::schedule(&plan)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn peak_unschedule() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(peak::unschedule).await.map_err(|e| e.to_string())?
}

// ---------- tailscale peers (optional relay candidates) ----------

#[derive(Serialize, Clone, Debug)]
pub struct TsPeer {
    pub name: String,
    pub ip: String,
    pub online: bool,
    pub exit_node_option: bool,
}

#[tauri::command]
fn tailscale_peers() -> Result<Vec<TsPeer>, String> {
    let text = run_capture("tailscale", &["status", "--json"])?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    if let Some(peers) = v.get("Peer").and_then(|p| p.as_object()) {
        for (_, p) in peers {
            let name = p.get("DNSName").and_then(|s| s.as_str()).unwrap_or("").trim_end_matches('.').to_string();
            let ip = p
                .get("TailscaleIPs")
                .and_then(|a| a.as_array())
                .and_then(|a| a.first())
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            out.push(TsPeer {
                name,
                ip,
                online: p.get("Online").and_then(|b| b.as_bool()).unwrap_or(false),
                exit_node_option: p.get("ExitNodeOption").and_then(|b| b.as_bool()).unwrap_or(false),
            });
        }
    }
    Ok(out)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
            app.manage(AppState {
                geo: Mutex::new(GeoCache::load(dir.join("geo-cache.json"))),
                config_path: dir.join("config.json"),
            });
            app.manage(geoip::GeoDb::load(dir.join("geoip")));
            // Fetch this month's database in the background when it is missing or stale.
            // The update is claimed here, before the webview loads, so the first lookup waits for it.
            if app.state::<geoip::GeoDb>().is_stale(geoip::now_secs()) && app.state::<geoip::GeoDb>().claim_update() {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let db = handle.state::<geoip::GeoDb>();
                    let res = match geoip::download_client() {
                        Ok(client) => db.run_claimed_update(&client, geoip::now_secs()).await.map(|_| ()),
                        Err(e) => {
                            db.release_update();
                            Err(e)
                        }
                    };
                    if let Err(e) = res {
                        eprintln!("geoip update: {e}");
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_connections,
            trace,
            ping_stats,
            geolocate,
            read_config,
            write_config,
            tailscale_peers,
            peak_status,
            peak_log,
            peak_sample_now,
            peak_schedule,
            peak_unschedule,
            geoip_status,
            geoip_update,
            relay::relay_import,
            relay::relay_config,
            relay::relay_list,
            relay::relay_remove,
            relay::relay_status,
            relay::relay_up,
            relay::relay_down,
            relay::relay_ping,
            relay::relay_compare,
            proof::proof_history,
            route_auto::route_auto,
            route_auto::route_check
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_normal_hop() {
        let h = parse_tracert_line("  8    18 ms    31 ms    26 ms  192.0.2.31").unwrap();
        assert_eq!(h.hop, 8);
        assert_eq!(h.ip.as_deref(), Some("192.0.2.31"));
        assert_eq!(h.avg, Some(25.0));
    }

    #[test]
    fn parses_timeout_hop() {
        let h = parse_tracert_line("  9     *        *        *     Request timed out.").unwrap();
        assert_eq!(h.hop, 9);
        assert!(h.ip.is_none());
        assert!(h.avg.is_none());
    }

    #[test]
    fn parses_sub_ms_and_mixed() {
        let h = parse_tracert_line("  1    <1 ms     *     2 ms  10.0.0.1").unwrap();
        assert_eq!(h.rtts, vec![Some(0.5), None, Some(2.0)]);
        assert_eq!(h.ip.as_deref(), Some("10.0.0.1"));
    }

    #[test]
    fn ignores_header_lines() {
        assert!(parse_tracert_line("Tracing route to 192.207.0.5 over a maximum of 20 hops").is_none());
        assert!(parse_tracert_line("").is_none());
    }

    #[test]
    fn self_is_always_refetched() {
        let geo = |q: &str| Geo { query: q.into(), status: "success".into(), city: None, region: None, country: None, lat: Some(1.0), lon: Some(2.0), isp: None, asn: None };
        let cache: HashMap<String, Geo> = [("self".to_string(), geo("self")), ("1.1.1.1".to_string(), geo("1.1.1.1"))].into();
        let (hit, missing) = split_cached(&cache, &["self".into(), "1.1.1.1".into(), "8.8.8.8".into()]);
        assert_eq!(hit.iter().map(|g| g.query.as_str()).collect::<Vec<_>>(), vec!["1.1.1.1"]);
        assert_eq!(missing, vec!["self".to_string(), "8.8.8.8".to_string()]);
    }

    #[test]
    fn parses_localized_tracert_rows() {
        // German and Russian units, a unit mangled by a non-UTF-8 code page, and units glued on.
        let de = parse_tracert_line("  3    12 ms    11 ms    <1 ms  192.0.2.11").unwrap();
        assert_eq!(de.rtts, vec![Some(12.0), Some(11.0), Some(0.5)]);
        let ru = parse_tracert_line("  4    16 мс    10 мс    17 мс  192.0.2.12").unwrap();
        assert_eq!(ru.avg, Some(43.0 / 3.0));
        assert_eq!(ru.ip.as_deref(), Some("192.0.2.12"));
        let mangled = parse_tracert_line("  5    10 \u{fffd}\u{fffd}     *     8 \u{fffd}\u{fffd}  192.0.2.13").unwrap();
        assert_eq!(mangled.rtts, vec![Some(10.0), None, Some(8.0)]);
        let glued = parse_tracert_line("  6   23ms   <1ms   16ms  2606:4700::1").unwrap();
        assert_eq!(glued.rtts, vec![Some(23.0), Some(0.5), Some(16.0)]);
        assert_eq!(glued.ip.as_deref(), Some("2606:4700::1"));
        let de_timeout = parse_tracert_line("  9     *        *        *     Zeitüberschreitung der Anforderung.").unwrap();
        assert!(de_timeout.ip.is_none());
        assert!(parse_tracert_line("Routenverfolgung zu 192.207.0.5 über maximal 25 Hops").is_none());
        assert!(parse_tracert_line("  1  2  3  4").is_none());
    }

    #[test]
    fn tracert_lines_survive_oem_code_page_bytes() {
        // German tracert in code page 850: "ü" is 0x81, which is not UTF-8.
        // The header carries it, so a strict UTF-8 reader stops before the first hop.
        let raw: &[u8] = b"\r\nRoutenverfolgung zu 1.1.1.1 \x81ber maximal 2 Hops\r\n\r\n  1    <1 ms    <1 ms    <1 ms  10.0.0.1\r\n  2     *        *        *     Zeit\x81berschreitung der Anforderung.\r\n  3    12 ms    11 ms    13 ms  1.1.1.1\r\n";
        let hops: Vec<HopEvent> = lossy_lines(raw).filter_map(|l| parse_tracert_line(&l)).collect();
        assert_eq!(hops.iter().map(|h| h.hop).collect::<Vec<_>>(), vec![1, 2, 3]);
        assert_eq!(hops[2].ip.as_deref(), Some("1.1.1.1"));
    }

    #[test]
    fn failed_tracert_is_not_success() {
        // tracert no.such.host.invalid: exit 1, no hops, reason on its own line.
        let (ok, err) = trace_outcome(false, 0, Some("Unable to resolve target system name no.such.host.invalid."));
        assert!(!ok);
        assert_eq!(err.as_deref(), Some("Unable to resolve target system name no.such.host.invalid."));
        assert_eq!(trace_outcome(true, 0, None), (false, Some("tracert returned no hops".into())));
        assert_eq!(trace_outcome(true, 12, Some("Trace complete.")), (true, None));
        assert!(!trace_outcome(false, 3, None).0);
    }

    #[test]
    fn parses_ping_in_any_language() {
        let en = "\r\nPinging 1.1.1.1 with 32 bytes of data:\r\nReply from 1.1.1.1: bytes=32 time=12ms TTL=57\r\nReply from 1.1.1.1: bytes=32 time<1ms TTL=57\r\nRequest timed out.\r\n\r\nPing statistics for 1.1.1.1:\r\n    Packets: Sent = 3, Received = 2, Lost = 1 (33% loss),\r\nApproximate round trip times in milli-seconds:\r\n    Minimum = 0ms, Maximum = 12ms, Average = 6ms\r\n";
        assert_eq!(parse_ping_rtts(en), vec![12.0, 0.5]);
        let de = "Antwort von 1.1.1.1: Bytes=32 Zeit=14ms TTL=57\nZeitüberschreitung der Anforderung.\n    Pakete: Gesendet = 2, Empfangen = 1, Verloren = 1\n    Minimum = 14ms, Maximum = 14ms, Mittelwert = 14ms\n";
        assert_eq!(parse_ping_rtts(de), vec![14.0]);
        let fr = "Réponse de 1.1.1.1 : octets=32 temps=15 ms TTL=57\n";
        assert_eq!(parse_ping_rtts(fr), vec![15.0]);
        let ru = "Ответ от 1.1.1.1: число байт=32 время=16мс TTL=57\n";
        assert_eq!(parse_ping_rtts(ru), vec![16.0]);
        let ja = "1.1.1.1 からの応答: バイト数 =32 時間 <1ms TTL=57\n";
        assert_eq!(parse_ping_rtts(ja), vec![0.5]);
        let v6 = "Reply from 2606:4700:4700::1111: time=11ms\nReply from 10.0.0.1: TTL expired in transit.\nReply from 10.0.0.1: Destination host unreachable.\n";
        assert_eq!(parse_ping_rtts(v6), vec![11.0]);
    }

    #[test]
    fn netstat_skips_time_wait_and_pid_0() {
        assert!(parse_netstat_line("  TCP    192.168.1.50:52310   203.0.113.43:443   TIME_WAIT       0").is_none());
        // Localized state column (German "WARTEND"): PID 0 alone is enough.
        assert!(parse_netstat_line("  TCP    192.168.1.50:52311   203.0.113.43:443   WARTEND         0").is_none());
        let (pid, proto, _, ip, port, state) = parse_netstat_line("  TCP    192.168.1.50:52312   203.0.113.43:443   ESTABLISHED     7124").unwrap();
        assert_eq!((pid, proto, ip.as_str(), port, state.as_str()), (7124, "tcp", "203.0.113.43", 443, "ESTABLISHED"));
        let (pid, proto, ..) = parse_netstat_line("  UDP    192.168.1.50:41641   203.0.113.42:3478   3300").unwrap();
        assert_eq!((pid, proto), (3300, "udp"));
        assert!(parse_netstat_line("  UDP    0.0.0.0:5353       *:*                    3300").is_none());
        assert!(parse_netstat_line("  TCP    192.168.1.50:52313   10.0.0.1:443   ESTABLISHED     7124").is_none());
    }

    #[test]
    fn reads_league_game_server_from_r3dlog() {
        let line = "000001.294| ALWAYS|  CONN| Connecting to address (104.160.131.1) port (7239)";
        assert_eq!(parse_league_connect(line), Some(("104.160.131.1".into(), 7239)));
        // The session line and the command line also carry the address; only the connect line counts.
        assert_eq!(parse_league_connect("CONN| Starting Multiplayer Session: PlayerClient ServerAddress(104.160.131.1:7239)"), None);
        assert_eq!(parse_league_connect("CONN| Connecting to address (127.0.0.1) port (7239)"), None);
        assert_eq!(parse_league_connect("CONN| Connecting to address (104.160.131.1) port (x)"), None);
    }

    #[test]
    fn p95_is_nearest_rank() {
        assert_eq!(percentile(&[10.0, 12.0, 16.0, 24.0], 0.95), 24.0);
        assert_eq!(percentile(&[5.0], 0.95), 5.0);
        let twenty: Vec<f64> = (1..=20).map(f64::from).collect();
        assert_eq!(percentile(&twenty, 0.95), 19.0);
    }

    #[test]
    fn public_ip_filter() {
        assert!(!is_public(&"10.0.0.1".parse().unwrap()));
        assert!(!is_public(&"100.121.10.40".parse().unwrap()));
        assert!(!is_public(&"127.0.0.1".parse().unwrap()));
        assert!(is_public(&"104.160.131.1".parse().unwrap()));
        assert!(!is_public(&"fe80::1".parse().unwrap()));
        assert!(is_public(&"2606:4700::1".parse().unwrap()));
    }
}
