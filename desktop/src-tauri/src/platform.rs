//! Per-OS command lines and output parsers for the live data: connections, traces and pings.
//! Windows uses `netstat -ano`, `tracert` and `ping -n`, parsed by the functions in lib.rs.
//! macOS (and other Unix) uses `lsof`, `traceroute` and `ping -c`, parsed here.
//! The parsers compile on every OS so their tests run in CI on Linux.

use crate::{is_public, split_addr, HopEvent};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;

/// One outbound connection before its process is named: pid, proto, local, remote ip, port, state.
pub type ConnRow = (u32, &'static str, String, String, u16, String);

fn is_v6(target: &str) -> bool {
    target.trim_start_matches('[').trim_end_matches(']').parse::<std::net::Ipv6Addr>().is_ok()
}

// ---------- connections ----------

#[cfg(windows)]
pub fn connection_rows() -> Result<Vec<ConnRow>, String> {
    // A failed netstat must surface as an error, not as "no connections".
    let out = crate::cmd("netstat")
        .args(["-ano"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("netstat: {e}"))?;
    if !out.status.success() {
        return Err(format!("netstat failed ({}): {}", out.status, String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).lines().filter_map(crate::parse_netstat_line).collect())
}

/// `lsof -nP -i -F pcPnT`: every internet socket of this user's processes, in field form.
/// lsof exits 1 with nothing on stderr when there is simply no socket to list.
#[cfg(not(windows))]
pub fn connection_rows() -> Result<Vec<ConnRow>, String> {
    let out = crate::cmd("lsof")
        .args(["-nP", "-i", "-F", "pcPnT"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("lsof: {e}"))?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() && out.stdout.is_empty() && !stderr.trim().is_empty() {
        return Err(format!("lsof failed ({}): {}", out.status, stderr.trim()));
    }
    Ok(parse_lsof(&String::from_utf8_lossy(&out.stdout)))
}

/// Parses `lsof -F pcPnT` output. Each line is one field: `p` starts a process, `f` a socket,
/// `P` is its protocol, `n` is `local->remote` (no arrow for a listening or unconnected socket),
/// and `TST=` its TCP state. Rows to private addresses, and TIME_WAIT rows, are skipped, as on Windows.
pub fn parse_lsof(text: &str) -> Vec<ConnRow> {
    struct Sock {
        pid: u32,
        proto: Option<&'static str>,
        name: Option<String>,
        state: String,
    }
    fn finish(s: Option<Sock>, out: &mut Vec<ConnRow>) {
        let Some(s) = s else { return };
        let (Some(proto), Some(name)) = (s.proto, s.name) else { return };
        let Some((local, remote)) = name.split_once("->") else { return };
        let Some((rip, rport)) = split_addr(remote) else { return };
        let Ok(ip) = rip.parse::<IpAddr>() else { return };
        if s.pid == 0 || !is_public(&ip) || s.state.eq_ignore_ascii_case("TIME_WAIT") {
            return;
        }
        out.push((s.pid, proto, local.to_string(), ip.to_string(), rport, s.state));
    }
    let mut out = Vec::new();
    let mut pid = 0u32;
    let mut cur: Option<Sock> = None;
    for line in text.lines() {
        let Some(tag) = line.chars().next() else { continue };
        let val = &line[tag.len_utf8()..];
        match tag {
            'p' => {
                finish(cur.take(), &mut out);
                pid = val.parse().unwrap_or(0);
            }
            'f' => {
                finish(cur.take(), &mut out);
                cur = Some(Sock { pid, proto: None, name: None, state: String::new() });
            }
            'P' => {
                if let Some(s) = cur.as_mut() {
                    s.proto = match val {
                        "TCP" => Some("tcp"),
                        "UDP" => Some("udp"),
                        _ => None,
                    };
                }
            }
            'n' => {
                if let Some(s) = cur.as_mut() {
                    s.name = Some(val.to_string());
                }
            }
            'T' => {
                if let (Some(s), Some(st)) = (cur.as_mut(), val.strip_prefix("ST=")) {
                    s.state = st.to_string();
                }
            }
            _ => {}
        }
    }
    finish(cur, &mut out);
    out
}

// ---------- League of Legends ----------

/// Where the Riot Client keeps one `<product>.product_settings.yaml` per installed product.
pub fn league_metadata_dir() -> PathBuf {
    PathBuf::from(if cfg!(windows) { r"C:\ProgramData\Riot Games\Metadata" } else { "/Users/Shared/Riot Games/Metadata" })
}

/// League's default install folder: a plain folder on Windows, an app bundle on macOS.
pub fn league_default_dir() -> PathBuf {
    PathBuf::from(if cfg!(windows) { r"C:\Riot Games\League of Legends" } else { "/Applications/League of Legends.app" })
}

/// Folders that may hold the per-game log folders under an install. On Windows that is
/// `Logs\GameLogs`. On macOS the install is a bundle and the logs sit in `Contents/LoL/Logs/GameLogs`
/// (Riot support's Mac logs page); `Logs/GameLogs` is kept for installs that are plain folders.
pub fn league_game_log_dirs(install: &Path) -> Vec<PathBuf> {
    let flat = install.join("Logs").join("GameLogs");
    if cfg!(windows) {
        vec![flat]
    } else {
        vec![install.join("Contents").join("LoL").join("Logs").join("GameLogs"), flat]
    }
}

/// Whether a process name is the in-game League process (not the client or launcher).
/// Windows: "League of Legends.exe". macOS: the game app's binary, "LeagueofLegends",
/// matched with spaces and case ignored so "League of Legends" also counts.
pub fn is_league_game(name: &str) -> bool {
    if cfg!(windows) {
        return name.eq_ignore_ascii_case("League of Legends.exe");
    }
    let n: String = name.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_ascii_lowercase();
    n == "leagueoflegends"
}

// ---------- traceroute ----------

/// True for an IP address or a plain hostname. Targets reach `ping` and `tracert`/`traceroute` as
/// arguments, so anything that could read as an option ("-") or carry other characters is refused.
pub fn valid_target(t: &str) -> bool {
    if t.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    !t.is_empty()
        && t.len() <= 253
        && t.split('.').all(|l| !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}

/// Program and arguments for a numeric trace of at most `max_hops` hops, 3 probes each.
pub fn trace_command(target: &str, max_hops: u32) -> (&'static str, Vec<String>) {
    let hops = max_hops.to_string();
    if cfg!(windows) {
        return ("tracert", vec!["-d".into(), "-w".into(), "800".into(), "-h".into(), hops, target.into()]);
    }
    let prog = if cfg!(target_os = "macos") && is_v6(target) { "traceroute6" } else { "traceroute" };
    (prog, vec!["-n".into(), "-q".into(), "3".into(), "-w".into(), "1".into(), "-m".into(), hops, target.into()])
}

/// Where the trace program's stderr goes. tracert writes nothing useful there. traceroute writes
/// its header and its failure reason ("unknown host") there, so it is read after the hops.
pub fn trace_stderr() -> Stdio {
    if cfg!(windows) {
        Stdio::null()
    } else {
        Stdio::piped()
    }
}

/// The failure reason in traceroute's stderr: its last line that is not the "traceroute to" header.
pub fn trace_stderr_reason(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("traceroute to") && !l.starts_with("traceroute6 to") && !l.starts_with("warning:"))
        .last()
        .map(str::to_string)
}

/// One hop row of the trace program's output.
pub fn parse_hop_line(line: &str) -> Option<HopEvent> {
    if cfg!(windows) {
        crate::parse_tracert_line(line)
    } else {
        parse_traceroute_line(line)
    }
}

/// Parses one hop row of Unix `traceroute -n`:
/// ` 3  10.0.0.1  12.3 ms  * 11.9 ms`. The first address is the hop. A row where later probes were
/// answered by another router names that router mid-row, which is not read. `!H`-style flags are skipped.
pub fn parse_traceroute_line(line: &str) -> Option<HopEvent> {
    let mut toks = line.split_whitespace().peekable();
    let hop: u32 = toks.next()?.parse().ok()?;
    let mut ip: Option<String> = None;
    let mut rtts: Vec<Option<f64>> = Vec::new();
    while let Some(t) = toks.next() {
        if t == "*" {
            rtts.push(None);
        } else if let Ok(a) = t.trim_start_matches('(').trim_end_matches(')').parse::<IpAddr>() {
            ip.get_or_insert_with(|| a.to_string());
        } else if let Ok(v) = t.parse::<f64>() {
            if toks.peek() == Some(&"ms") {
                toks.next();
            }
            rtts.push(Some(v));
        } else if t.starts_with('!') {
            continue;
        } else {
            // A hostname column (traceroute run without -n) or anything else unknown: the row is
            // still a hop, the token is just not used.
            continue;
        }
    }
    if rtts.is_empty() {
        return None;
    }
    rtts.truncate(3);
    let good: Vec<f64> = rtts.iter().flatten().copied().collect();
    let avg = if good.is_empty() { None } else { Some(good.iter().sum::<f64>() / good.len() as f64) };
    Some(HopEvent { id: String::new(), hop, ip, rtts, avg })
}

// ---------- ping ----------

/// Program and arguments for `count` echo requests that wait about a second for each reply.
pub fn ping_command(host: &str, count: u32) -> (&'static str, Vec<String>) {
    let n = count.to_string();
    if cfg!(windows) {
        ("ping", vec!["-n".into(), n, "-w".into(), "1000".into(), host.into()])
    } else if cfg!(target_os = "macos") {
        if is_v6(host) {
            // macOS ping6 has no per-reply wait flag.
            ("ping6", vec!["-c".into(), n, host.into()])
        } else {
            // macOS -W is the wait for each reply in milliseconds.
            ("ping", vec!["-c".into(), n, "-W".into(), "1000".into(), host.into()])
        }
    } else {
        // Linux -W is in seconds.
        ("ping", vec!["-c".into(), n, "-W".into(), "1".into(), host.into()])
    }
}

/// Reply times from the ping program's output.
pub fn parse_ping(text: &str) -> Vec<f64> {
    if cfg!(windows) {
        crate::parse_ping_rtts(text)
    } else {
        parse_unix_ping(text)
    }
}

/// Reply times from Unix `ping` output: `64 bytes from 1.2.3.4: icmp_seq=0 ttl=117 time=12.345 ms`.
/// The summary line (`round-trip min/avg/max/stddev = ...`) has no `time=` and is not counted.
/// `time<1` (some Linux builds) counts as 0.5 ms, as on Windows.
pub fn parse_unix_ping(text: &str) -> Vec<f64> {
    text.lines()
        .filter_map(|line| {
            let (i, sub_ms) = match (line.find("time="), line.find("time<")) {
                (Some(i), _) => (i, false),
                (None, Some(i)) => (i, true),
                _ => return None,
            };
            let after = &line[i + 5..];
            let num: String = after.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
            let v: f64 = num.parse().ok()?;
            Some(if sub_ms { v / 2.0 } else { v })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const LSOF: &str = "p501\nccom.apple.WebKi\nf23\nPTCP\nn192.168.1.20:52144->104.160.131.3:443\nTST=ESTABLISHED\nTQR=0\nTQS=0\nf24\nPTCP\nn*:7000\nTST=LISTEN\nf25\nPUDP\nn*:5353\np777\ncLeague of Legends\nf40\nPUDP\nn192.168.1.20:61000->198.51.100.7:5100\nf41\nPTCP\nn[2001:db8:1::5]:50000->[2001:db8::5]:443\nTST=ESTABLISHED\nf42\nPTCP\nn192.168.1.20:52000->10.0.0.8:22\nTST=ESTABLISHED\nf43\nPTCP\nn192.168.1.20:52001->1.1.1.1:443\nTST=TIME_WAIT\n";

    #[test]
    fn lsof_keeps_public_connected_sockets() {
        let rows = parse_lsof(LSOF);
        assert_eq!(rows.len(), 3, "{rows:?}");
        assert_eq!(rows[0], (501, "tcp", "192.168.1.20:52144".into(), "104.160.131.3".into(), 443, "ESTABLISHED".into()));
        assert_eq!(rows[1], (777, "udp", "192.168.1.20:61000".into(), "198.51.100.7".into(), 5100, String::new()));
        assert_eq!(rows[2].3, "2001:db8::5");
        assert_eq!(rows[2].4, 443);
    }

    #[test]
    fn lsof_empty_and_garbage_are_empty() {
        assert!(parse_lsof("").is_empty());
        assert!(parse_lsof("nonsense\n\nn1.2.3.4:1->5.6.7.8:2\n").is_empty());
    }

    #[test]
    fn parses_macos_traceroute_rows() {
        let h = parse_traceroute_line(" 1  192.168.1.1  3.123 ms  2.456 ms  2.001 ms").unwrap();
        assert_eq!((h.hop, h.ip.as_deref()), (1, Some("192.168.1.1")));
        assert_eq!(h.rtts, vec![Some(3.123), Some(2.456), Some(2.001)]);
        assert!((h.avg.unwrap() - 2.5267).abs() < 0.001);

        let t = parse_traceroute_line(" 2  * * *").unwrap();
        assert_eq!((t.hop, t.ip, t.rtts.len(), t.avg), (2, None, 3, None));

        let m = parse_traceroute_line(" 3  * 10.0.0.1  12.3 ms *").unwrap();
        assert_eq!(m.ip.as_deref(), Some("10.0.0.1"));
        assert_eq!(m.rtts, vec![None, Some(12.3), None]);

        let two = parse_traceroute_line(" 4  192.0.2.31  5.000 ms 192.0.2.35  6.100 ms  7.200 ms").unwrap();
        assert_eq!(two.ip.as_deref(), Some("192.0.2.31"));
        assert_eq!(two.rtts.len(), 3);

        let flag = parse_traceroute_line("12  104.160.131.3  30.1 ms !H  29.8 ms !H *").unwrap();
        assert_eq!(flag.rtts, vec![Some(30.1), Some(29.8), None]);

        let v6 = parse_traceroute_line(" 5  2001:db8:3::1  9.9 ms  9.8 ms  9.7 ms").unwrap();
        assert_eq!(v6.ip.as_deref(), Some("2001:db8:3::1"));
    }

    #[test]
    fn traceroute_header_and_errors_are_not_hops() {
        assert!(parse_traceroute_line("traceroute to 104.160.131.3 (104.160.131.3), 30 hops max, 52 byte packets").is_none());
        assert!(parse_traceroute_line("traceroute: unknown host nope.invalid").is_none());
        assert!(parse_traceroute_line("").is_none());
        let err = "traceroute to 1.2.3.4 (1.2.3.4), 30 hops max, 52 byte packets\ntraceroute: sendto: No route to host\n";
        assert_eq!(trace_stderr_reason(err).as_deref(), Some("traceroute: sendto: No route to host"));
        assert_eq!(trace_stderr_reason("traceroute to x (1.2.3.4), 30 hops max\n"), None);
    }

    #[test]
    fn parses_macos_ping() {
        let text = "PING 104.160.131.3 (104.160.131.3): 56 data bytes\n64 bytes from 104.160.131.3: icmp_seq=0 ttl=52 time=28.412 ms\nRequest timeout for icmp_seq 1\n64 bytes from 104.160.131.3: icmp_seq=2 ttl=52 time=31.007 ms\n\n--- 104.160.131.3 ping statistics ---\n3 packets transmitted, 2 packets received, 33.3% packet loss\nround-trip min/avg/max/stddev = 28.412/29.710/31.007/1.298 ms\n";
        assert_eq!(parse_unix_ping(text), vec![28.412, 31.007]);
    }

    #[test]
    fn parses_linux_ping_sub_ms() {
        let text = "64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time<1 ms\n64 bytes from 127.0.0.1: icmp_seq=2 ttl=64 time=0.045 ms\nrtt min/avg/max/mdev = 0.045/0.045/0.045/0.000 ms\n";
        assert_eq!(parse_unix_ping(text), vec![0.5, 0.045]);
    }

    #[test]
    fn commands_per_os() {
        let (p, a) = ping_command("104.160.131.3", 10);
        let (t, ta) = trace_command("104.160.131.3", 30);
        if cfg!(windows) {
            assert_eq!((p, a[0].as_str()), ("ping", "-n"));
            assert_eq!(t, "tracert");
        } else {
            assert_eq!((p, a[0].as_str(), a[1].as_str()), ("ping", "-c", "10"));
            assert_eq!(t, "traceroute");
            assert_eq!(ta, ["-n", "-q", "3", "-w", "1", "-m", "30", "104.160.131.3"]);
        }
        assert!(is_v6("2606:4700::1"));
        assert!(!is_v6("104.160.131.3"));
    }

    #[test]
    fn league_paths_and_process_per_os() {
        let logs = league_game_log_dirs(&league_default_dir());
        if cfg!(windows) {
            assert!(is_league_game("League of Legends.exe"));
            assert!(!is_league_game("LeagueClient.exe"));
            assert_eq!(logs, vec![PathBuf::from(r"C:\Riot Games\League of Legends\Logs\GameLogs")]);
        } else {
            assert!(is_league_game("LeagueofLegends"));
            assert!(is_league_game("League of Legends"));
            assert!(!is_league_game("LeagueClient"));
            assert!(!is_league_game("LeagueClientUx Helper"));
            assert!(!is_league_game("League of Legends.exe"));
            assert_eq!(logs[0], PathBuf::from("/Applications/League of Legends.app/Contents/LoL/Logs/GameLogs"));
            assert_eq!(league_metadata_dir(), PathBuf::from("/Users/Shared/Riot Games/Metadata"));
        }
    }

    #[test]
    fn targets_never_read_as_options() {
        for ok in ["104.160.131.20", "::1", "2001:db8::1", "relay.example.net", "localhost", "a-b.example"] {
            assert!(valid_target(ok), "{ok}");
        }
        for bad in ["", "-n", "-w 1 192.0.2.1", "--help", "192.0.2.1 -t", "a..b", ".a", "a.-b", "a b", "a;b", "a/b", "é.example", &"a".repeat(64)] {
            assert!(!valid_target(bad), "{bad}");
        }
    }

    // Runs the real OS tools against loopback, so it needs no network. CI runs these on macOS and
    // Windows:
    // cargo test live_os -- --ignored
    #[test]
    #[ignore]
    fn live_os_ping_loopback() {
        let s = crate::ping_blocking("127.0.0.1".into(), 3).unwrap();
        assert_eq!(s.received, 3, "{s:?}");
    }

    #[test]
    #[ignore]
    fn live_os_trace_loopback() {
        let (prog, args) = trace_command("127.0.0.1", 3);
        let out = crate::cmd(prog).args(&args).stdout(Stdio::piped()).stderr(trace_stderr()).output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        let hops: Vec<_> = text.lines().filter_map(parse_hop_line).collect();
        assert_eq!(hops.first().and_then(|h| h.ip.as_deref()), Some("127.0.0.1"), "{text}");
    }

    #[test]
    #[ignore]
    fn live_os_lists_connections() {
        connection_rows().unwrap();
    }
}
