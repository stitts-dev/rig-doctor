//! Peak-hour trace log. A Windows scheduled task starts this app with `--peak-sample` on an
//! interval inside a daily window. Each start traces and pings one destination, appends one JSON
//! line to `peak-log.jsonl` in the app data folder, and exits without opening a window.
//! The log stays on this machine. The app reads it back to show which paths were taken and how fast.

use crate::{cmd, ping_blocking, Config, PingStats};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Write;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;

/// Riot's published NA ping address, used when the config names no target.
pub const DEFAULT_TARGET: &str = "104.160.131.3";
pub const TASK_NAME: &str = "RigDoctorPeakTrace";
pub const LOG_FILE: &str = "peak-log.jsonl";
/// Same folder Tauri uses for app data: %APPDATA%\<identifier> on Windows.
const IDENTIFIER: &str = "dev.jaden.rigdoctor.globe";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PeakConfig {
    pub target: String,
    /// "HH:MM" local time. End "24:00" means midnight.
    pub start: String,
    pub end: String,
    pub every_min: u32,
    pub days: u32,
    /// Last moment of the scheduled run, as given to the task, so the app can say when it ends.
    #[serde(default)]
    pub until: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PeakHop {
    pub hop: u32,
    pub ip: Option<String>,
    pub rtts: Vec<Option<f64>>,
    pub avg: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rdns: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PeakSample {
    /// Unix time in milliseconds.
    pub ts: u64,
    pub target: String,
    pub hops: Vec<PeakHop>,
    pub ping: Option<PingStats>,
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
}

pub fn data_dir() -> PathBuf {
    dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join(IDENTIFIER)
}

pub fn target_from(config: &Config) -> String {
    config
        .peak
        .as_ref()
        .map(|p| p.target.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| DEFAULT_TARGET.to_string())
}

fn read_config(dir: &Path) -> Config {
    std::fs::read_to_string(dir.join("config.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// Hops of one `tracert -d` run, with reverse DNS for each public router.
fn trace_blocking(target: &str, max_hops: u32) -> Result<Vec<PeakHop>, String> {
    let out = cmd("tracert")
        .args(["-d", "-w", "800", "-h", &max_hops.to_string(), target])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("tracert: {e}"))?;
    let mut hops = Vec::new();
    let mut last_other: Option<String> = None;
    for line in out.stdout.split(|b| *b == b'\n').map(|b| String::from_utf8_lossy(b).trim_end_matches('\r').to_string()) {
        match crate::parse_tracert_line(&line) {
            Some(ev) => hops.push(PeakHop { hop: ev.hop, ip: ev.ip, rtts: ev.rtts, avg: ev.avg, rdns: None }),
            None if !line.trim().is_empty() => last_other = Some(line),
            None => {}
        }
    }
    let (ok, error) = crate::trace_outcome(out.status.success(), hops.len(), last_other.as_deref());
    if !ok {
        return Err(error.unwrap_or_else(|| "tracert failed".into()));
    }
    let ips: HashSet<String> = hops.iter().filter_map(|h| h.ip.clone()).filter(|ip| ip.parse::<IpAddr>().map(|a| crate::is_public(&a)).unwrap_or(false)).collect();
    let lookups: Vec<_> = ips
        .into_iter()
        .map(|ip| {
            std::thread::spawn(move || {
                let name = ip.parse::<IpAddr>().ok().and_then(|a| dns_lookup::lookup_addr(&a).ok()).filter(|n| *n != ip);
                (ip, name)
            })
        })
        .collect();
    for l in lookups {
        if let Ok((ip, Some(name))) = l.join() {
            for h in hops.iter_mut().filter(|h| h.ip.as_deref() == Some(ip.as_str())) {
                h.rdns = Some(name.clone());
            }
        }
    }
    Ok(hops)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// One trace and ten pings to `target`, appended to the log as one line.
pub fn sample_and_append(dir: &Path, target: &str) -> Result<PeakSample, String> {
    let ts = now_ms();
    let ping = ping_blocking(target.to_string(), 10).ok();
    let (hops, error) = match trace_blocking(target, 30) {
        Ok(h) => (h, None),
        Err(e) => (Vec::new(), Some(e)),
    };
    let sample = PeakSample { ts, target: target.to_string(), ok: error.is_none(), hops, ping, error };
    append(dir, &sample)?;
    Ok(sample)
}

fn append(dir: &Path, sample: &PeakSample) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut line = serde_json::to_string(sample).map_err(|e| e.to_string())?;
    line.push('\n');
    // One write per line, so a scheduled run and a manual one never interleave inside a line.
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(LOG_FILE)).map_err(|e| e.to_string())?;
    f.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

/// Every readable line of the log. A line cut short by a crash is skipped, not fatal.
pub fn parse_log(text: &str) -> Vec<PeakSample> {
    text.lines().filter_map(|l| serde_json::from_str(l.trim()).ok()).collect()
}

pub fn read_log(dir: &Path) -> Vec<PeakSample> {
    std::fs::read_to_string(dir.join(LOG_FILE)).map(|s| parse_log(&s)).unwrap_or_default()
}

/// Entry for `--peak-sample`: no window, exit code 0 when the sample was written.
pub fn sample_cli() -> i32 {
    let dir = data_dir();
    let target = target_from(&read_config(&dir));
    match sample_and_append(&dir, &target) {
        Ok(_) => 0,
        Err(_) => 1,
    }
}

// ---------- scheduling ----------

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct SchedulePlan {
    /// Local time of the first window's start, "YYYY-MM-DDTHH:MM:SS".
    pub start_boundary: String,
    /// Local time after which no run starts.
    pub end_boundary: String,
    pub every_min: u32,
    /// Window length; runs repeat every `every_min` inside it.
    pub duration_min: u32,
}

fn is_local_datetime(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 19
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b'T',
            13 | 16 => *c == b':',
            _ => c.is_ascii_digit(),
        })
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// Task Scheduler XML for a daily trigger that repeats inside the window. It runs only while
/// the user is signed in, as that user, without elevation, so it needs no password or admin.
pub fn task_xml(plan: &SchedulePlan, exe: &str, user: Option<&str>) -> Result<String, String> {
    if !is_local_datetime(&plan.start_boundary) || !is_local_datetime(&plan.end_boundary) {
        return Err("start and end must be YYYY-MM-DDTHH:MM:SS".into());
    }
    if plan.end_boundary <= plan.start_boundary {
        return Err("the run must end after it starts".into());
    }
    if !(1..=1440).contains(&plan.every_min) || !(1..=1440).contains(&plan.duration_min) {
        return Err("interval and window must be 1 to 1440 minutes".into());
    }
    let user_id = user.map(|u| format!("<UserId>{}</UserId>", xml_escape(u))).unwrap_or_default();
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Rig Doctor Globe peak-hour trace log</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <Repetition><Interval>PT{every}M</Interval><Duration>PT{dur}M</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <StartBoundary>{start}</StartBoundary>
      <EndBoundary>{end}</EndBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals><Principal id="Author">{user_id}<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>false</StartWhenAvailable>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>{exe}</Command><Arguments>--peak-sample</Arguments></Exec></Actions>
</Task>
"#,
        every = plan.every_min,
        dur = plan.duration_min,
        start = plan.start_boundary,
        end = plan.end_boundary,
        exe = xml_escape(exe),
    ))
}

/// schtasks reads task XML as UTF-16 with a byte order mark.
fn utf16_bom(s: &str) -> Vec<u8> {
    let mut out = vec![0xFF, 0xFE];
    for u in s.encode_utf16() {
        out.extend_from_slice(&u.to_le_bytes());
    }
    out
}

fn schtasks(args: &[&str]) -> Result<String, String> {
    let out = cmd("schtasks").args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).output().map_err(|e| format!("schtasks: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { "schtasks failed".into() } else { err })
    }
}

pub fn schedule(plan: &SchedulePlan) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let user = match (std::env::var("USERDOMAIN"), std::env::var("USERNAME")) {
        (Ok(d), Ok(u)) => Some(format!("{d}\\{u}")),
        _ => None,
    };
    let xml = task_xml(plan, &exe.to_string_lossy(), user.as_deref())?;
    let file = std::env::temp_dir().join("rig-doctor-peak-task.xml");
    std::fs::write(&file, utf16_bom(&xml)).map_err(|e| e.to_string())?;
    let r = schtasks(&["/Create", "/TN", TASK_NAME, "/XML", &file.to_string_lossy(), "/F"]);
    let _ = std::fs::remove_file(&file);
    r.map(|_| ())
}

pub fn unschedule() -> Result<(), String> {
    schtasks(&["/Delete", "/TN", TASK_NAME, "/F"]).map(|_| ())
}

pub fn is_scheduled() -> bool {
    schtasks(&["/Query", "/TN", TASK_NAME]).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> SchedulePlan {
        SchedulePlan { start_boundary: "2026-11-07T18:00:00".into(), end_boundary: "2026-11-14T00:00:00".into(), every_min: 10, duration_min: 360 }
    }

    #[test]
    fn task_xml_repeats_inside_the_window() {
        let x = task_xml(&plan(), r"C:\Program Files\Rig Doctor Globe\rig-doctor-globe.exe", Some(r"TOASTER\jaden")).unwrap();
        assert!(x.contains("<Interval>PT10M</Interval><Duration>PT360M</Duration>"));
        assert!(x.contains("<StartBoundary>2026-11-07T18:00:00</StartBoundary>"));
        assert!(x.contains("<EndBoundary>2026-11-14T00:00:00</EndBoundary>"));
        assert!(x.contains(r"<Command>C:\Program Files\Rig Doctor Globe\rig-doctor-globe.exe</Command><Arguments>--peak-sample</Arguments>"));
        assert!(x.contains(r"<UserId>TOASTER\jaden</UserId><LogonType>InteractiveToken</LogonType>"));
    }

    #[test]
    fn task_xml_escapes_and_validates() {
        let x = task_xml(&plan(), r"C:\A&B\x.exe", None).unwrap();
        assert!(x.contains(r"C:\A&amp;B\x.exe"));
        assert!(!x.contains("<UserId>"));
        let mut bad = plan();
        bad.start_boundary = "2026-11-07 18:00".into();
        assert!(task_xml(&bad, "x", None).is_err());
        let mut back = plan();
        back.end_boundary = "2026-11-06T00:00:00".into();
        assert!(task_xml(&back, "x", None).is_err());
        let mut zero = plan();
        zero.every_min = 0;
        assert!(task_xml(&zero, "x", None).is_err());
    }

    #[test]
    fn utf16_has_bom() {
        assert_eq!(utf16_bom("<a"), vec![0xFF, 0xFE, b'<', 0, b'a', 0]);
    }

    #[test]
    fn log_round_trips_and_skips_torn_lines() {
        let dir = std::env::temp_dir().join(format!("rd-peak-test-{}", now_ms()));
        let s = PeakSample {
            ts: 1,
            target: "203.0.113.9".into(),
            hops: vec![PeakHop { hop: 1, ip: Some("10.0.0.1".into()), rtts: vec![Some(1.0), None, Some(2.0)], avg: Some(1.5), rdns: None }],
            ping: None,
            ok: true,
            error: None,
        };
        append(&dir, &s).unwrap();
        std::fs::OpenOptions::new().append(true).open(dir.join(LOG_FILE)).unwrap().write_all(b"{\"ts\":2,\"tar").unwrap();
        let back = read_log(&dir);
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].hops, s.hops);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn target_defaults_to_riot_na() {
        assert_eq!(target_from(&Config::default()), DEFAULT_TARGET);
        let c = Config { peak: Some(PeakConfig { target: " 192.0.2.1 ".into(), start: "18:00".into(), end: "24:00".into(), every_min: 10, days: 7, until: None }), ..Default::default() };
        assert_eq!(target_from(&c), "192.0.2.1");
    }
}
