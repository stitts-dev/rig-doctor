//! Windows tunnel service setup, using only the official WireGuard for Windows install.
//!
//! The first On installs the WireGuard tunnel service with `wireguard.exe /installtunnelservice`
//! (one UAC prompt), sets it to manual start, and grants this user start and stop rights on that one
//! service. After that, On and Off are `sc start` and `sc stop` with no prompt. WireGuard for
//! Windows never runs config scripts unless an admin turns on DangerousScriptExecution, so the
//! user-writable config can't escalate. Nothing is bundled or downloaded.

use super::TUNNEL;
use crate::cmd;
use std::process::Stdio;

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
