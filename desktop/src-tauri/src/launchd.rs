//! macOS equivalent of the RigDoctorPeakTrace scheduled task: a per-user launchd agent.
//! launchd has no repeating window or end date, so the agent lists one calendar entry per run time
//! of the daily window, and passes the window's first and last moments to `--peak-sample`, which
//! skips runs before the start and removes the agent once the end has passed.

use crate::peak::SchedulePlan;

pub const LABEL: &str = "dev.jaden.rigdoctor.globe.peaktrace";
/// Environment variables the agent sets for `--peak-sample`.
pub const ENV_FROM: &str = "RIG_PEAK_FROM";
pub const ENV_UNTIL: &str = "RIG_PEAK_UNTIL";

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// Minutes after midnight of the "HH:MM" in a "YYYY-MM-DDTHH:MM:SS" local time.
fn minute_of_day(s: &str) -> Option<u32> {
    let h: u32 = s.get(11..13)?.parse().ok()?;
    let m: u32 = s.get(14..16)?.parse().ok()?;
    (h < 24 && m < 60).then_some(h * 60 + m)
}

/// The (hour, minute) of every run in the daily window, in order, without repeats.
/// A window that crosses midnight wraps into the next day's hours.
pub fn run_times(plan: &SchedulePlan) -> Result<Vec<(u32, u32)>, String> {
    let start = minute_of_day(&plan.start_boundary).ok_or("start must be YYYY-MM-DDTHH:MM:SS")?;
    let mut seen = std::collections::HashSet::new();
    Ok((0..plan.duration_min.min(1440))
        .step_by(plan.every_min.max(1) as usize)
        .map(|i| ((start + i) % 1440 / 60, (start + i) % 60))
        .filter(|t| seen.insert(*t))
        .collect())
}

/// The LaunchAgent property list. Validation matches the Windows task XML.
pub fn agent_plist(plan: &SchedulePlan, exe: &str) -> Result<String, String> {
    crate::peak::task_xml(plan, exe, None)?;
    let times = run_times(plan)?;
    let entries: String = times
        .iter()
        .map(|(h, m)| format!("    <dict><key>Hour</key><integer>{h}</integer><key>Minute</key><integer>{m}</integer></dict>\n"))
        .collect();
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>{exe}</string><string>--peak-sample</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>{ENV_FROM}</key><string>{from}</string><key>{ENV_UNTIL}</key><string>{until}</string></dict>
  <key>StartCalendarInterval</key>
  <array>
{entries}  </array>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
"#,
        exe = xml_escape(exe),
        from = plan.start_boundary,
        until = plan.end_boundary,
    ))
}

/// What a `--peak-sample` run started by the agent does at local time `now`.
#[derive(Debug, PartialEq)]
pub enum Gate {
    Run,
    /// Before the first window: exit without sampling.
    Early,
    /// After the last window: remove the agent and exit.
    Expired,
}

pub fn gate(now: &str, from: Option<&str>, until: Option<&str>) -> Gate {
    // All three are "YYYY-MM-DDTHH:MM:SS", so string order is time order.
    if until.is_some_and(|u| now >= u) {
        Gate::Expired
    } else if from.is_some_and(|f| now < f) {
        Gate::Early
    } else {
        Gate::Run
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use crate::cmd;
    use std::path::PathBuf;
    use std::process::Stdio;

    fn run(program: &str, args: &[&str]) -> Result<String, String> {
        let out = cmd(program).args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).output().map_err(|e| format!("{program}: {e}"))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(if err.is_empty() { format!("{program} failed ({})", out.status) } else { err })
        }
    }

    fn domain() -> Result<String, String> {
        Ok(format!("gui/{}", run("id", &["-u"])?))
    }

    fn plist_path() -> Result<PathBuf, String> {
        let home = dirs::home_dir().ok_or("no home folder")?;
        Ok(home.join("Library").join("LaunchAgents").join(format!("{LABEL}.plist")))
    }

    pub fn schedule(plan: &SchedulePlan) -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let plist = agent_plist(plan, &exe.to_string_lossy())?;
        let path = plist_path()?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let d = domain()?;
        // Replacing a loaded agent needs it unloaded first; not loaded is fine.
        let _ = run("launchctl", &["bootout", &format!("{d}/{LABEL}")]);
        std::fs::write(&path, plist).map_err(|e| e.to_string())?;
        run("launchctl", &["bootstrap", &d, &path.to_string_lossy()]).map(|_| ())
    }

    pub fn unschedule() -> Result<(), String> {
        let path = plist_path()?;
        let removed = std::fs::remove_file(&path).is_ok();
        let unloaded = run("launchctl", &["bootout", &format!("{}/{LABEL}", domain()?)]);
        if removed {
            Ok(())
        } else {
            unloaded.map(|_| ())
        }
    }

    pub fn is_scheduled() -> bool {
        domain().and_then(|d| run("launchctl", &["print", &format!("{d}/{LABEL}")])).is_ok()
    }

    /// Local time now as "YYYY-MM-DDTHH:MM:SS".
    pub fn local_now() -> Option<String> {
        run("date", &["+%Y-%m-%dT%H:%M:%S"]).ok()
    }
}

#[cfg(target_os = "macos")]
pub use mac::{is_scheduled, local_now, schedule, unschedule};

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> SchedulePlan {
        SchedulePlan { start_boundary: "2026-11-07T18:00:00".into(), end_boundary: "2026-11-14T00:00:00".into(), every_min: 10, duration_min: 360 }
    }

    #[test]
    fn runs_every_interval_inside_the_window() {
        let t = run_times(&plan()).unwrap();
        assert_eq!(t.len(), 36);
        assert_eq!(t[0], (18, 0));
        assert_eq!(t[1], (18, 10));
        assert_eq!(*t.last().unwrap(), (23, 50));
    }

    #[test]
    fn window_wraps_past_midnight() {
        let p = SchedulePlan { start_boundary: "2026-11-07T23:30:00".into(), end_boundary: "2026-11-08T01:00:00".into(), every_min: 20, duration_min: 90 };
        assert_eq!(run_times(&p).unwrap(), vec![(23, 30), (23, 50), (0, 10), (0, 30), (0, 50)]);
    }

    #[test]
    fn plist_names_the_app_and_its_window() {
        let x = agent_plist(&plan(), "/Applications/Rig Doctor Globe.app/Contents/MacOS/rig-doctor-globe").unwrap();
        assert!(x.contains(&format!("<key>Label</key><string>{LABEL}</string>")));
        assert!(x.contains("<string>/Applications/Rig Doctor Globe.app/Contents/MacOS/rig-doctor-globe</string><string>--peak-sample</string>"));
        assert!(x.contains("<key>RIG_PEAK_FROM</key><string>2026-11-07T18:00:00</string><key>RIG_PEAK_UNTIL</key><string>2026-11-14T00:00:00</string>"));
        assert!(x.contains("<key>Hour</key><integer>23</integer><key>Minute</key><integer>50</integer>"));
        assert_eq!(x.matches("<key>Hour</key>").count(), 36);
        assert!(agent_plist(&plan(), "/A&B/x").unwrap().contains("/A&amp;B/x"));
        let mut bad = plan();
        bad.every_min = 0;
        assert!(agent_plist(&bad, "x").is_err());
    }

    // cargo test live_os -- --ignored, on macOS: plutil must accept the agent.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn live_os_plist_lints() {
        let path = std::env::temp_dir().join(format!("{LABEL}.plist"));
        std::fs::write(&path, agent_plist(&plan(), "/Applications/Rig Doctor Globe.app/Contents/MacOS/rig-doctor-globe").unwrap()).unwrap();
        let out = std::process::Command::new("plutil").arg("-lint").arg(&path).output().unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stdout));
        assert!(local_now().is_some_and(|n| n.len() == 19));
    }

    #[test]
    fn gate_skips_early_and_expires_late() {
        let (f, u) = (Some("2026-11-07T18:00:00"), Some("2026-11-14T00:00:00"));
        assert_eq!(gate("2026-11-06T18:00:00", f, u), Gate::Early);
        assert_eq!(gate("2026-11-07T18:00:00", f, u), Gate::Run);
        assert_eq!(gate("2026-11-14T00:00:00", f, u), Gate::Expired);
        assert_eq!(gate("2026-11-10T12:00:00", None, None), Gate::Run);
    }
}
