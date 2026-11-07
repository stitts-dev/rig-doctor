//! Request parsing and the client signature rule. No OS calls, so it is tested on every platform.

use crate::wgconf;

/// The verb line plus a config at the app's size limit.
pub const MAX_REQUEST: usize = wgconf::MAX_CONF_BYTES + 16;

#[derive(Debug, PartialEq)]
pub enum Request {
    /// The config re-rendered from the allowlist, ready to write.
    Up(String),
    Down,
}

pub fn parse(bytes: &[u8]) -> Result<Request, String> {
    if bytes.len() > MAX_REQUEST {
        return Err("Request is too large.".into());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "Request is not text.".to_string())?;
    let (verb, rest) = text.split_once('\n').unwrap_or((text, ""));
    match verb.trim() {
        "up" => Ok(Request::Up(wgconf::render_config(&wgconf::parse_config(rest)?))),
        "down" => Ok(Request::Down),
        other => Err(format!("Unknown request \"{}\".", other.chars().take(16).collect::<String>())),
    }
}

/// Only the app, signed by a Developer ID from the helper's own team, may talk to the helper.
/// None when the team id is not the 10 letters and digits Apple issues.
pub fn client_requirement(app_id: &str, team: &str) -> Option<String> {
    let ok = team.len() == 10 && team.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    ok.then(|| format!("anchor apple generic and identifier \"{app_id}\" and certificate leaf[subject.OU] = \"{team}\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRIV: &str = "cGxhY2Vob2xkZXIta2V5LW5vdC1yZWFsLTAwMDAwMDA=";
    const PUB: &str = "cGxhY2Vob2xkZXItcGVlci1ub3QtcmVhbC0xMTExMTE=";

    fn conf() -> String {
        format!("[Interface]\nPrivateKey = {PRIV}\nAddress = 10.66.66.2/32\n\n[Peer]\nPublicKey = {PUB}\nEndpoint = 203.0.113.10:51820\nAllowedIPs = 10.66.66.1/32\n")
    }

    #[test]
    fn up_is_rechecked_and_rerendered() {
        let with_comment = format!("# from the app\n{}", conf());
        assert_eq!(parse(format!("up\n{with_comment}").as_bytes()), Ok(Request::Up(conf())));
        let hook = conf().replace("Address = 10.66.66.2/32", "Address = 10.66.66.2/32\nPostUp = touch /tmp/x");
        assert!(parse(format!("up\n{hook}").as_bytes()).unwrap_err().contains("runs commands"));
        let wide = conf().replace("AllowedIPs = 10.66.66.1/32", "AllowedIPs = 0.0.0.0/0");
        assert!(parse(format!("up\n{wide}").as_bytes()).unwrap_err().contains("all traffic"));
        assert!(parse(b"up\n").is_err());
    }

    #[test]
    fn other_requests() {
        assert_eq!(parse(b"down\n"), Ok(Request::Down));
        assert_eq!(parse(b"down"), Ok(Request::Down));
        assert!(parse(b"rm -rf /\n").is_err());
        assert!(parse(&[0xff, 0xfe]).is_err());
        assert!(parse(&vec![b'a'; MAX_REQUEST + 1]).is_err());
    }

    #[test]
    fn requirement_needs_a_real_team_id() {
        assert_eq!(
            client_requirement("dev.jaden.rigdoctor.globe", "AB12CD34EF").unwrap(),
            r#"anchor apple generic and identifier "dev.jaden.rigdoctor.globe" and certificate leaf[subject.OU] = "AB12CD34EF""#
        );
        assert!(client_requirement("x", "").is_none());
        assert!(client_requirement("x", "AB12CD34E\"").is_none());
        assert!(client_requirement("x", "ab12cd34ef").is_none());
    }
}
