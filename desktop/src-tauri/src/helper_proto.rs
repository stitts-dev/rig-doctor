//! Wire format between the app and its macOS privileged helper (desktop/mac-helper, which includes
//! this file). The helper listens on a root-owned Unix socket. The app writes one request and
//! closes its write side: `up\n` followed by the relay config, or `down\n`. The helper answers one
//! line: `ok`, or `err ` and a message for the user.

pub const APP_ID: &str = "dev.jaden.rigdoctor.globe";
pub const HELPER_LABEL: &str = "dev.jaden.rigdoctor.globe.helper";
/// Name of the launchd plist in the app's Contents/Library/LaunchDaemons, as SMAppService wants it.
pub const HELPER_PLIST: &str = "dev.jaden.rigdoctor.globe.helper.plist";
pub const HELPER_SOCKET: &str = "/var/run/dev.jaden.rigdoctor.globe.helper.sock";

pub fn request(verb: &str, conf: Option<&str>) -> String {
    format!("{verb}\n{}", conf.unwrap_or(""))
}

pub fn encode_reply(r: &Result<(), String>) -> String {
    match r {
        Ok(()) => "ok\n".into(),
        Err(e) => format!("err {}\n", e.replace(['\r', '\n'], " ")),
    }
}

pub fn decode_reply(s: &str) -> Result<(), String> {
    let line = s.lines().next().unwrap_or("").trim();
    if line == "ok" {
        return Ok(());
    }
    Err(match line.strip_prefix("err ") {
        Some(msg) if !msg.trim().is_empty() => msg.trim().to_string(),
        _ => "The Rig Doctor helper gave no answer.".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies_round_trip() {
        assert_eq!(decode_reply(&encode_reply(&Ok(()))), Ok(()));
        let e = Err("wg-quick failed:\nline two".to_string());
        assert_eq!(decode_reply(&encode_reply(&e)), Err("wg-quick failed: line two".into()));
        assert!(decode_reply("").is_err());
        assert!(decode_reply("err ").is_err());
        assert_eq!(request("down", None), "down\n");
        assert_eq!(request("up", Some("[Interface]\n")), "up\n[Interface]\n");
    }
}
