//! Windows tunnel service setup, using only the official WireGuard for Windows install.
//!
//! The first On (one UAC prompt) copies the relay config to %ProgramData%\RigDoctor, a folder
//! owned by Administrators that only SYSTEM and Administrators can write, installs the WireGuard
//! tunnel service from that copy with `wireguard.exe /installtunnelservice`, sets it to manual
//! start, and grants this user start and stop rights on that one service. After that, On and Off
//! are `sc start` and `sc stop` with no prompt. A program running as the user can still edit the
//! config in the app's folder, but the service never reads it: a changed config differs from the
//! protected copy, so the next On runs setup again behind a UAC prompt. Nothing is bundled or
//! downloaded.

use super::TUNNEL;
use crate::cmd;
use std::path::{Path, PathBuf};
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

/// Folder under %ProgramData% that holds the copy the tunnel service runs.
pub const PROTECTED_DIR: &str = "RigDoctor";

/// The copy the tunnel service runs. The file name must stay `<tunnel>.conf`: WireGuard names the
/// service after it.
pub fn protected_conf(program_data: &Path) -> PathBuf {
    program_data.join(PROTECTED_DIR).join(format!("{TUNNEL}.conf"))
}

/// %ProgramData%, read only to compare configs. Setup itself asks Windows for the folder.
pub fn program_data() -> PathBuf {
    std::env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
}

/// True when the protected copy is missing or differs from the user's config, so On must run
/// setup (UAC) instead of a silent `sc start`.
pub fn needs_setup(user_conf: &[u8], protected: Option<&[u8]>) -> bool {
    protected != Some(user_conf)
}

/// Security descriptor for the protected folder: owned by Administrators, SYSTEM and
/// Administrators full control, this user (or, without a SID, all users) read only. It replaces the
/// whole DACL and blocks inheritance, so neither %ProgramData%'s "users may create" rule nor an ACE
/// planted on a folder made in advance survives.
pub fn protected_sddl(sid: Option<&str>) -> String {
    let reader = sid.unwrap_or("S-1-5-32-545");
    format!("O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;{reader})")
}

/// PowerShell, run elevated, that writes `conf` (the bytes On just compared, not a path the user
/// could swap in the meantime) into the protected folder, installs the tunnel
/// service from that copy, makes it start only on request, and (with a SID) lets `sid` start, stop
/// and query it. The folder may have been made by a user beforehand, so the script refuses a link,
/// sets the owner and the whole DACL, and removes any old file before copying, so a planted hard
/// link cannot point the copy at another file. The ACE goes at the end of the DACL, before any SACL.
pub fn windows_install_ps(manager: &str, conf: &[u8], sid: Option<&str>) -> String {
    let svc = service_name();
    let ace = sid.map(|sid| {
        format!(
            "$sd = ((sc.exe sdshow '{svc}') -join '').Trim(); \
             $ace = '(A;;RPWPLCRC;;;{sid})'; \
             if (-not $sd.Contains($ace)) {{ $i = $sd.IndexOf('S:'); if ($i -ge 0) {{ $sd = $sd.Substring(0, $i) + $ace + $sd.Substring($i) }} else {{ $sd = $sd + $ace }}; sc.exe sdset '{svc}' $sd | Out-Null; if ($LASTEXITCODE) {{ exit $LASTEXITCODE }} }}; "
        )
    });
    format!(
        "$ErrorActionPreference='Stop'; \
         $d = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) '{dir}'; \
         if (Test-Path -LiteralPath $d) {{ $i = Get-Item -LiteralPath $d -Force; if (-not $i.PSIsContainer -or ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) {{ throw \"$d is not a plain folder\" }} }} else {{ New-Item -ItemType Directory -Path $d | Out-Null }}; \
         $s = New-Object Security.AccessControl.DirectorySecurity; $s.SetSecurityDescriptorSddlForm('{sddl}'); Set-Acl -LiteralPath $d -AclObject $s; \
         $t = Join-Path $d '{tunnel}.conf'; \
         if (Test-Path -LiteralPath $t) {{ $i = Get-Item -LiteralPath $t -Force; if ($i.PSIsContainer -or ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) {{ throw \"$t is not a plain file\" }}; Remove-Item -LiteralPath $t -Force }}; \
         [IO.File]::WriteAllBytes($t, [Convert]::FromBase64String('{c}')); \
         Start-Process -FilePath '{m}' -ArgumentList '/uninstalltunnelservice {tunnel}' -Wait -WindowStyle Hidden; \
         $p = Start-Process -FilePath '{m}' -ArgumentList ('/installtunnelservice \"' + $t + '\"') -Wait -PassThru -WindowStyle Hidden; if ($p.ExitCode) {{ exit $p.ExitCode }}; \
         sc.exe config '{svc}' start= demand | Out-Null; if ($LASTEXITCODE) {{ exit $LASTEXITCODE }}; \
         {ace}exit 0",
        dir = PROTECTED_DIR,
        sddl = protected_sddl(sid),
        m = manager.replace('\'', "''"),
        c = base64(conf),
        tunnel = TUNNEL,
        ace = ace.unwrap_or_default(),
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
    fn windows_install_runs_the_protected_copy() {
        let ps = windows_install_ps(r"C:\Program Files\WireGuard\wireguard.exe", b"foo", Some("S-1-5-21-1-2-3-1001"));
        // The service is installed from the copy in the protected folder, never the user's file.
        assert!(ps.contains("GetFolderPath('CommonApplicationData')) 'RigDoctor'"), "{ps}");
        assert!(ps.contains("[IO.File]::WriteAllBytes($t, [Convert]::FromBase64String('Zm9v'))"), "{ps}");
        assert!(ps.contains(r#"-FilePath 'C:\Program Files\WireGuard\wireguard.exe' -ArgumentList ('/installtunnelservice "' + $t + '"')"#), "{ps}");
        assert!(!ps.contains("Copy-Item") && !ps.contains(r"C:\Users"), "{ps}");
        // Ownership and DACL are reset before the copy, and old files are removed, not written through.
        let (acl, rm, copy) = (ps.find("Set-Acl -LiteralPath $d").unwrap(), ps.find("Remove-Item -LiteralPath $t").unwrap(), ps.find("WriteAllBytes").unwrap());
        assert!(acl < rm && rm < copy, "{ps}");
        assert!(ps.contains("ReparsePoint"));
        assert!(ps.contains("SetSecurityDescriptorSddlForm('O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;S-1-5-21-1-2-3-1001)')"), "{ps}");
        assert!(ps.contains("start= demand"));
        assert!(ps.contains("(A;;RPWPLCRC;;;S-1-5-21-1-2-3-1001)"));
    }

    #[test]
    fn windows_install_without_sid_grants_no_service_rights() {
        let ps = windows_install_ps(r"C:\WG\wireguard.exe", b"[Interface]\n", None);
        assert!(!ps.contains("sdset"), "{ps}");
        assert!(ps.contains("(A;OICI;0x1200a9;;;S-1-5-32-545)"), "{ps}");
        assert!(ps.ends_with("exit 0"));
    }

    #[test]
    fn protected_folder_gives_the_user_read_only() {
        for sddl in [protected_sddl(Some("S-1-5-21-9-9-9-1001")), protected_sddl(None)] {
            // Protected (P): nothing inherited from %ProgramData%. Owner is Administrators.
            assert!(sddl.starts_with("O:BAD:PAI("), "{sddl}");
            let aces: Vec<&str> = sddl["O:BAD:PAI".len()..].trim_matches(|c| c == '(' || c == ')').split(")(").collect();
            assert_eq!(aces.len(), 3, "{sddl}");
            for ace in aces {
                let f: Vec<&str> = ace.split(';').collect();
                assert_eq!(f[0], "A");
                // Full access only for SYSTEM and Administrators; anyone else gets read and execute.
                if f[5] != "SY" && f[5] != "BA" {
                    assert_eq!(f[2], "0x1200a9", "{ace}");
                }
            }
        }
    }

    #[test]
    fn protected_conf_path_keeps_the_tunnel_name() {
        let p = protected_conf(Path::new(r"C:\ProgramData"));
        assert_eq!(p.file_name().unwrap(), "rigrelay.conf");
        assert_eq!(p.parent().unwrap().file_name().unwrap(), "RigDoctor");
    }

    #[test]
    fn setup_runs_when_the_copy_is_missing_or_differs() {
        assert!(needs_setup(b"[Interface]\n", None));
        assert!(needs_setup(b"[Interface]\nA", Some(b"[Interface]\nB")));
        assert!(!needs_setup(b"[Interface]\n", Some(b"[Interface]\n")));
    }
}
