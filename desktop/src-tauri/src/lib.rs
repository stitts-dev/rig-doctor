//! Rig Doctor Globe backend: enumerates live connections, streams tracert hops,
//! samples ping, geolocates hops, and stores relay config.
//! Everything shells out to the stock Windows tools, so no driver or admin is needed.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::net::IpAddr;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn cmd(program: &str) -> Command {
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

#[tauri::command]
fn list_connections() -> Result<Vec<Conn>, String> {
    let text = run_capture("netstat", &["-ano"])?;
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let name_of = |pid: u32| -> String {
        sys.process(sysinfo::Pid::from_u32(pid))
            .map(|p| p.name().to_string_lossy().trim_end_matches(".exe").to_string())
            .unwrap_or_else(|| format!("pid {pid}"))
    };
    let mut out = Vec::new();
    for line in text.lines() {
        let t: Vec<&str> = line.split_whitespace().collect();
        if t.len() < 4 {
            continue;
        }
        let (proto, local, remote, state, pid) = match t[0] {
            "TCP" if t.len() >= 5 => ("tcp", t[1], t[2], t[3], t[4]),
            "UDP" => ("udp", t[1], t[2], "", t[3]),
            _ => continue,
        };
        let Some((rip, rport)) = split_addr(remote) else { continue };
        let Ok(ip) = rip.parse::<IpAddr>() else { continue };
        if !is_public(&ip) {
            continue;
        }
        let Ok(pid) = pid.parse::<u32>() else { continue };
        out.push(Conn {
            pid,
            process: name_of(pid),
            proto: proto.into(),
            local: local.into(),
            remote_ip: rip,
            remote_port: rport,
            state: state.into(),
        });
    }
    Ok(out)
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

fn parse_tracert_line(line: &str) -> Option<HopEvent> {
    let mut toks = line.split_whitespace().peekable();
    let hop: u32 = toks.next()?.parse().ok()?;
    let mut rtts: Vec<Option<f64>> = Vec::new();
    while rtts.len() < 3 {
        let t = toks.next()?;
        if t == "*" {
            rtts.push(None);
        } else if t == "<1" {
            toks.next(); // "ms"
            rtts.push(Some(0.5));
        } else if let Ok(v) = t.parse::<f64>() {
            match toks.peek() {
                Some(&"ms") => {
                    toks.next();
                    rtts.push(Some(v));
                }
                _ => return None,
            }
        } else {
            return None;
        }
    }
    let rest: Vec<&str> = toks.collect();
    let ip = rest.first().and_then(|s| s.parse::<IpAddr>().ok()).map(|i| i.to_string());
    let good: Vec<f64> = rtts.iter().flatten().copied().collect();
    let avg = if good.is_empty() { None } else { Some(good.iter().sum::<f64>() / good.len() as f64) };
    Some(HopEvent { id: String::new(), hop, ip, rtts, avg })
}

#[tauri::command]
fn trace(app: AppHandle, id: String, target: String, max_hops: u32) -> Result<(), String> {
    std::thread::spawn(move || {
        let hops = max_hops.clamp(1, 40).to_string();
        let child = cmd("tracert")
            .args(["-d", "-w", "800", "-h", &hops, &target])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                let _ = app.emit("trace:done", DoneEvent { id, ok: false, error: Some(e.to_string()) });
                return;
            }
        };
        let stdout = child.stdout.take().unwrap();
        let reader = BufReader::new(stdout);
        let mut seen: HashSet<String> = HashSet::new();
        for line in reader.lines().map_while(Result::ok) {
            if let Some(mut ev) = parse_tracert_line(&line) {
                ev.id = id.clone();
                if let Some(ip) = ev.ip.clone() {
                    if seen.insert(ip.clone()) {
                        let app2 = app.clone();
                        let id2 = id.clone();
                        let hop = ev.hop;
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
                let _ = app.emit("trace:hop", ev);
            }
        }
        let _ = child.wait();
        let _ = app.emit("trace:done", DoneEvent { id, ok: true, error: None });
    });
    Ok(())
}

// ---------- ping ----------

#[derive(Serialize, Clone, Debug)]
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

fn ping_blocking(host: String, count: u32) -> Result<PingStats, String> {
    let n = count.clamp(1, 200);
    let text = run_capture("ping", &["-n", &n.to_string(), "-w", "1000", &host])?;
    let mut rtts: Vec<f64> = Vec::new();
    for line in text.lines() {
        if let Some(i) = line.find("time=") {
            let s = &line[i + 5..];
            let num: String = s.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
            if let Ok(v) = num.parse::<f64>() {
                rtts.push(v);
            }
        } else if line.contains("time<1ms") {
            rtts.push(0.5);
        }
    }
    let received = rtts.len() as u32;
    if rtts.is_empty() {
        return Ok(PingStats { host, sent: n, received, min: None, avg: None, max: None, p95: None, jitter: None });
    }
    let mut sorted = rtts.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let avg = rtts.iter().sum::<f64>() / rtts.len() as f64;
    let var = rtts.iter().map(|v| (v - avg).powi(2)).sum::<f64>() / rtts.len() as f64;
    let p95 = sorted[((sorted.len() - 1) as f64 * 0.95).floor() as usize];
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

// ---------- geolocation (ip-api.com, cached on disk) ----------

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

const GEO_FIELDS: &str = "status,message,query,city,regionName,country,lat,lon,isp,as";

#[tauri::command]
async fn geolocate(app: AppHandle, ips: Vec<String>) -> Result<Vec<Geo>, String> {
    let state = app.state::<AppState>();
    let mut result: Vec<Geo> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    {
        let cache = state.geo.lock().unwrap();
        for ip in ips.iter() {
            match cache.map.get(ip) {
                Some(g) => result.push(g.clone()),
                None => missing.push(ip.clone()),
            }
        }
    }
    if missing.is_empty() {
        return Ok(result);
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    // "self" asks ip-api for this machine's public address.
    let wants_self = missing.iter().any(|s| s == "self");
    let batch: Vec<String> = missing.iter().filter(|s| *s != "self").cloned().collect();
    let mut fetched: Vec<Geo> = Vec::new();
    if wants_self {
        let url = format!("http://ip-api.com/json/?fields={GEO_FIELDS}");
        if let Ok(r) = client.get(url).send().await {
            if let Ok(mut g) = r.json::<Geo>().await {
                g.query = "self".into();
                fetched.push(g);
            }
        }
    }
    for chunk in batch.chunks(100) {
        let url = format!("http://ip-api.com/batch?fields={GEO_FIELDS}");
        match client.post(url).json(&chunk).send().await {
            Ok(r) => {
                if let Ok(v) = r.json::<Vec<Geo>>().await {
                    fetched.extend(v);
                }
            }
            Err(e) => return Err(format!("ip-api: {e}")),
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
        .setup(|app| {
            let dir = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
            app.manage(AppState {
                geo: Mutex::new(GeoCache::load(dir.join("geo-cache.json"))),
                config_path: dir.join("config.json"),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_connections,
            trace,
            ping_stats,
            geolocate,
            read_config,
            write_config,
            tailscale_peers
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_normal_hop() {
        let h = parse_tracert_line("  8    18 ms    31 ms    26 ms  96.110.37.98").unwrap();
        assert_eq!(h.hop, 8);
        assert_eq!(h.ip.as_deref(), Some("96.110.37.98"));
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
    fn public_ip_filter() {
        assert!(!is_public(&"10.0.0.1".parse().unwrap()));
        assert!(!is_public(&"100.121.10.40".parse().unwrap()));
        assert!(!is_public(&"127.0.0.1".parse().unwrap()));
        assert!(is_public(&"104.160.131.1".parse().unwrap()));
        assert!(!is_public(&"fe80::1".parse().unwrap()));
        assert!(is_public(&"2606:4700::1".parse().unwrap()));
    }
}
