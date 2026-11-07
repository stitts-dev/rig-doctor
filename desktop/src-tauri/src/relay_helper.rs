//! One-time elevation, so turning the relay on and off doesn't ask for admin every time.
//!
//! macOS and Linux: the first On runs one admin prompt that copies this binary to a root-owned
//! path and adds a sudoers rule letting this user run exactly `<helper> --relay-helper up` and
//! `... down` without a password. The helper runs as root, reads the user's config, validates and
//! rewrites it with the same allowlist as an import, stores the copy root-only, and runs wg-quick on
//! that copy. A config with hooks or a full-tunnel route is refused, so the rule can only switch a
//! game-only tunnel. The paths to the config and wg-quick are fixed at install, not taken from the
//! caller.
//!
//! Windows: the first On installs the WireGuard tunnel service (one UAC prompt), sets it to manual
//! start, and grants this user start and stop rights on that one service. After that, On and Off
//! are `sc start` and `sc stop` with no prompt. WireGuard for Windows never runs config scripts
//! unless an admin turns on DangerousScriptExecution, so the user-writable config can't escalate.

use super::{sh_quote, TUNNEL};
use crate::cmd;
use std::path::Path;
use std::process::Stdio;

pub const HELPER_ARG: &str = "--relay-helper";

pub fn helper_path() -> &'static str {
    if cfg!(target_os = "macos") {
        "/Library/PrivilegedHelperTools/dev.jaden.rigdoctor.relay-helper"
    } else {
        "/usr/local/libexec/rig-doctor-relay-helper"
    }
}

pub fn root_dir() -> &'static str {
    if cfg!(target_os = "macos") {
        "/Library/Application Support/RigDoctorRelay"
    } else {
        "/etc/rig-doctor-relay"
    }
}

pub const SUDOERS: &str = "/etc/sudoers.d/rig-doctor-relay";

/// Sudoers names are matched loosely, so only plain account names get a rule.
pub fn valid_user(u: &str) -> bool {
    !u.is_empty() && u.len() <= 64 && u.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) && !u.starts_with('-')
}

pub fn sudoers_line(user: &str, helper: &str) -> String {
    format!("{user} ALL=(root) NOPASSWD: {helper} {HELPER_ARG} up, {helper} {HELPER_ARG} down")
}

/// Root shell that installs the helper and the sudoers rule. visudo checks the rule before it is
/// put in place, so a bad rule can never break sudo.
pub fn install_script(exe: &str, user: &str, uid: u32, source_conf: &str, quick: &str, macos: bool) -> String {
    let helper = helper_path();
    let dir = root_dir();
    let tools_dir = if macos { "/Library/PrivilegedHelperTools" } else { "/usr/local/libexec" };
    let q = sh_quote;
    [
        "set -e".to_string(),
        "umask 022".to_string(),
        format!("mkdir -p {}", q(tools_dir)),
        format!("cp -f {} {}.new", q(exe), q(helper)),
        format!("chown 0:0 {}.new", q(helper)),
        format!("chmod 0755 {}.new", q(helper)),
        // A copy of a downloaded app keeps its quarantine flag, which can stop it running.
        if macos { format!("xattr -c {}.new 2>/dev/null || true", q(helper)) } else { "true".to_string() },
        format!("mv -f {}.new {}", q(helper), q(helper)),
        format!("mkdir -p {}", q(dir)),
        format!("chown 0:0 {}", q(dir)),
        format!("chmod 0700 {}", q(dir)),
        format!("printf '%s\\n' {} > {}", q(source_conf), q(&format!("{dir}/source"))),
        format!("printf '%s\\n' {uid} > {}", q(&format!("{dir}/uid"))),
        format!("printf '%s\\n' {} > {}", q(quick), q(&format!("{dir}/wg-quick"))),
        "t=$(mktemp)".to_string(),
        format!("printf '%s\\n' {} > \"$t\"", q(&sudoers_line(user, helper))),
        "visudo -cf \"$t\" >/dev/null".to_string(),
        format!("chown 0:0 \"$t\"; chmod 0440 \"$t\"; mv -f \"$t\" {}", q(SUDOERS)),
    ]
    .join("; ")
}

fn whoami() -> Option<(String, u32)> {
    let id = |flag: &str| cmd("id").arg(flag).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let user = id("-un").filter(|u| valid_user(u))?;
    let uid = id("-u")?.parse().ok()?;
    Some((user, uid))
}

/// Whether sudo lets this user run the helper without a password. `sudo -n -l` never prompts.
pub fn unix_ready() -> bool {
    Path::new(helper_path()).is_file()
        && cmd("sudo").args(["-n", "-l", helper_path(), HELPER_ARG, "up"]).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
}

/// Runs the installed helper with no prompt.
pub fn unix_run(verb: &str) -> std::io::Result<std::process::Output> {
    cmd("sudo").args(["-n", helper_path(), HELPER_ARG, verb]).output()
}

/// The root shell line for the first On: install, then bring the tunnel up through the helper.
/// None when this account can't be given a rule; the caller then falls back to a prompt per change.
pub fn unix_first_up(quick: &str, conf: &Path) -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let (user, uid) = whoami()?;
    let script = install_script(&exe.to_string_lossy(), &user, uid, &conf.to_string_lossy(), quick, cfg!(target_os = "macos"));
    Some(format!("{script}; {} {HELPER_ARG} up", sh_quote(helper_path())))
}

#[cfg(unix)]
fn read_trim(p: &str) -> Result<String, String> {
    std::fs::read_to_string(p).map(|s| s.trim().to_string()).map_err(|e| format!("{p}: {e}"))
}

/// Entry point when sudo runs the helper as root: `--relay-helper up|down`.
#[cfg(unix)]
pub fn helper_main(args: &[String]) -> i32 {
    match helper_run(args.first().map(String::as_str).unwrap_or("")) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

#[cfg(unix)]
fn helper_run(verb: &str) -> Result<(), String> {
    use super::{parse_config, render_config, unix_line, write_private};
    use std::os::unix::fs::MetadataExt;
    use std::path::PathBuf;
    if verb != "up" && verb != "down" {
        return Err(format!("usage: {HELPER_ARG} up|down"));
    }
    let dir = root_dir();
    let quick = read_trim(&format!("{dir}/wg-quick"))?;
    let root_conf = PathBuf::from(format!("{dir}/{}", super::CONF_FILE));
    if verb == "up" {
        let source = read_trim(&format!("{dir}/source"))?;
        let uid: u32 = read_trim(&format!("{dir}/uid"))?.parse().map_err(|_| "bad uid file".to_string())?;
        // Only a plain file owned by the user who installed the helper is read, so the rule can't
        // be pointed at another file through a link.
        let meta = std::fs::symlink_metadata(&source).map_err(|e| format!("Relay config: {e}"))?;
        if !meta.is_file() || meta.uid() != uid || meta.len() > 64 * 1024 {
            return Err("Relay config is not a plain file owned by this user. Import it again in the app.".into());
        }
        let text = std::fs::read_to_string(&source).map_err(|e| format!("Relay config: {e}"))?;
        let cfg = parse_config(&text).map_err(|_| "Relay config failed validation. Import it again in the app.".to_string())?;
        let tmp = root_conf.with_extension("conf.tmp");
        write_private(&tmp, render_config(&cfg).as_bytes())?;
        std::fs::rename(&tmp, &root_conf).map_err(|e| e.to_string())?;
    }
    let line = unix_line(&quick, verb, &root_conf.to_string_lossy(), cfg!(target_os = "macos"));
    let out = std::process::Command::new("/bin/sh")
        .args(["-c", &line])
        .env("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(not(unix))]
pub fn helper_main(_args: &[String]) -> i32 {
    eprintln!("{HELPER_ARG} is for macOS and Linux");
    1
}

// ---------- Windows ----------

/// Standard base64, for PowerShell's -EncodedCommand.
pub fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= c.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// A script as PowerShell's -EncodedCommand wants it: UTF-16LE, then base64. No quoting to get wrong.
pub fn ps_encoded(script: &str) -> String {
    base64(&script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect::<Vec<_>>())
}

pub fn service_name() -> String {
    format!("WireGuardTunnel${TUNNEL}")
}

/// The SID on the `whoami /user` line for this account.
pub fn parse_whoami_sid(text: &str) -> Option<String> {
    text.split_whitespace().find(|t| t.starts_with("S-1-") && t[4..].chars().all(|c| c.is_ascii_digit() || c == '-')).map(str::to_string)
}

pub fn windows_sid() -> Option<String> {
    let out = cmd("whoami").arg("/user").output().ok()?;
    parse_whoami_sid(&String::from_utf8_lossy(&out.stdout))
}

/// PowerShell, run elevated, that installs the tunnel service, makes it start only on request, and
/// lets `sid` start, stop and query it. The ACE goes at the end of the DACL, before any SACL.
pub fn windows_install_ps(manager: &str, conf: &str, sid: &str) -> String {
    let svc = service_name();
    format!(
        "$ErrorActionPreference='Stop'; \
         Start-Process -FilePath '{m}' -ArgumentList '/uninstalltunnelservice {tunnel}' -Wait -WindowStyle Hidden; \
         $p = Start-Process -FilePath '{m}' -ArgumentList '/installtunnelservice \"{c}\"' -Wait -PassThru -WindowStyle Hidden; if ($p.ExitCode) {{ exit $p.ExitCode }}; \
         sc.exe config '{svc}' start= demand | Out-Null; \
         $sd = ((sc.exe sdshow '{svc}') -join '').Trim(); \
         $ace = '(A;;RPWPLCRC;;;{sid})'; \
         if (-not $sd.Contains($ace)) {{ $i = $sd.IndexOf('S:'); if ($i -ge 0) {{ $sd = $sd.Substring(0, $i) + $ace + $sd.Substring($i) }} else {{ $sd = $sd + $ace }}; sc.exe sdset '{svc}' $sd | Out-Null }}; \
         exit $LASTEXITCODE",
        m = manager.replace('\'', "''"),
        c = conf.replace('\'', "''"),
        tunnel = TUNNEL,
    )
}

/// `sc start` or `sc stop` without elevation. Ok(false) when the service is missing or this user
/// has no rights on it, so the caller can fall back to the one-time install.
pub fn windows_sc(verb: &str) -> Result<bool, String> {
    let out = cmd("sc").args([verb, &service_name()]).stdout(Stdio::piped()).stderr(Stdio::null()).output().map_err(|e| format!("sc: {e}"))?;
    // 0 ok, 1056 already running, 1062 not started: all fine. 5 access denied, 1060 no service.
    Ok(matches!(out.status.code(), Some(0) | Some(1056) | Some(1062)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sudoers_rule_names_only_up_and_down() {
        let l = sudoers_line("jdoe", "/Library/PrivilegedHelperTools/dev.jaden.rigdoctor.relay-helper");
        assert_eq!(l, "jdoe ALL=(root) NOPASSWD: /Library/PrivilegedHelperTools/dev.jaden.rigdoctor.relay-helper --relay-helper up, /Library/PrivilegedHelperTools/dev.jaden.rigdoctor.relay-helper --relay-helper down");
        assert!(valid_user("jdoe") && valid_user("j.doe_2"));
        for bad in ["", "-x", "a b", "root,ALL", "a:b", "%admin"] {
            assert!(!valid_user(bad), "{bad}");
        }
    }

    #[test]
    fn install_script_validates_before_placing_rule() {
        let s = install_script("/Applications/Rig Doctor.app/Contents/MacOS/rig-doctor-globe", "jdoe", 501, "/Users/jdoe/Library/Application Support/dev.jaden.rigdoctor.globe/relay/rigrelay.conf", "/opt/homebrew/bin/wg-quick", true);
        assert!(s.starts_with("set -e; "));
        assert!(s.contains("xattr -c"));
        assert!(s.contains("cp -f '/Applications/Rig Doctor.app/Contents/MacOS/rig-doctor-globe'"));
        let visudo = s.find("visudo -cf").unwrap();
        let place = s.find(&format!("mv -f \"$t\" '{SUDOERS}'")).unwrap();
        assert!(visudo < place);
        assert!(s.contains("printf '%s\\n' 501 >"));
    }

    #[test]
    fn install_script_runs_in_sh() {
        // Checks the generated script parses; it is not run.
        let s = install_script("/tmp/a b/app", "jdoe", 1000, "/home/jdoe/o'neil/rigrelay.conf", "/usr/bin/wg-quick", false);
        let st = std::process::Command::new("sh").args(["-n", "-c", &s]).status().unwrap();
        assert!(st.success());
    }

    #[test]
    fn base64_matches_reference() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"placeholder-key-not-real-0000000"), "cGxhY2Vob2xkZXIta2V5LW5vdC1yZWFsLTAwMDAwMDA=");
        assert_eq!(ps_encoded("hi"), "aABpAA==");
    }

    #[test]
    fn whoami_sid() {
        let t = "\r\nUSER INFORMATION\r\n----------------\r\n\r\nUser Name     SID\r\n============= ==============================================\r\ntoaster\\jaden S-1-5-21-1111111111-2222222222-3333333333-1001\r\n";
        assert_eq!(parse_whoami_sid(t).as_deref(), Some("S-1-5-21-1111111111-2222222222-3333333333-1001"));
        assert_eq!(parse_whoami_sid("no sid here"), None);
    }

    #[test]
    fn windows_install_grants_start_stop() {
        let ps = windows_install_ps(r"C:\Program Files\WireGuard\wireguard.exe", r"C:\Users\o'neil\rigrelay.conf", "S-1-5-21-1-2-3-1001");
        assert!(ps.contains(r#"-FilePath 'C:\Program Files\WireGuard\wireguard.exe' -ArgumentList '/installtunnelservice "C:\Users\o''neil\rigrelay.conf"'"#), "{ps}");
        assert!(ps.contains("start= demand"));
        assert!(ps.contains("(A;;RPWPLCRC;;;S-1-5-21-1-2-3-1001)"));
    }
}
