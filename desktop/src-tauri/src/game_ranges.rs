//! League game server ranges the tunnel carries. The relay's prefix list is every range Riot
//! announces (AS6507): game servers, but also the client, chat, store and patch services. With
//! League picked, the tunnel narrows to the /24s of game servers seen in matches, so only game
//! traffic takes the relay. The relay's list stays the outer bound: a range it doesn't carry is
//! never added.
//!
//! Ranges come from two places: this device's own match logs ("match"), and the relay's shared
//! list of ranges its players have seen ("relay"). Until any is known the tunnel keeps the full
//! list. A match on a server outside the tunnel goes direct (the tunnel is split), is tagged
//! direct, and its /24 is learned for the next time the tunnel turns on.

use crate::relay::{Cidr, WgConfig};
use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use std::path::Path;

pub const FILE: &str = "game-ranges.json";
/// A cap so a broken relay can't grow the tunnel config without bound.
const MAX_RANGES: usize = 256;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Range {
    /// An IPv4 /24, "a.b.c.0/24".
    pub cidr: String,
    /// "match" when seen in this device's match logs, "relay" when the relay's shared list had it.
    pub source: String,
    /// Matches seen on it here.
    pub seen: u32,
    /// Last time it was seen or listed, ms since the epoch.
    pub last_ms: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct Store {
    v: u32,
    ranges: Vec<Range>,
}

/// The /24 holding a public IPv4 game server address.
pub fn slash24(ip: &IpAddr) -> Option<Cidr> {
    match ip {
        IpAddr::V4(v) if crate::is_public(ip) => {
            let o = v.octets();
            Some(Cidr { addr: IpAddr::from([o[0], o[1], o[2], 0]), len: 24 })
        }
        _ => None,
    }
}

/// A /24 as the relay lists it, checked: IPv4, public, exactly /24, host bits zero.
pub fn parse_range(s: &str) -> Option<Cidr> {
    let c = Cidr::parse(s).ok()?;
    (c.len == 24 && slash24(&c.addr).as_ref() == Some(&c)).then_some(c)
}

pub fn read(dir: &Path) -> Vec<Range> {
    std::fs::read_to_string(dir.join(FILE)).ok().and_then(|t| serde_json::from_str::<Store>(&t).ok()).map(|s| s.ranges).unwrap_or_default()
}

fn write(dir: &Path, ranges: &[Range]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&Store { v: 1, ranges: ranges.to_vec() }).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{FILE}.tmp"));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(FILE)).map_err(|e| e.to_string())
}

/// Notes a match on game server `ip`. Returns its /24 when it wasn't known from a match before.
pub fn learn(dir: &Path, ip: &IpAddr, now_ms: u64) -> Result<Option<Cidr>, String> {
    let Some(c) = slash24(ip) else { return Ok(None) };
    let key = c.to_string();
    let mut ranges = read(dir);
    let new = if let Some(r) = ranges.iter_mut().find(|r| r.cidr == key) {
        let first = r.source != "match";
        r.source = "match".into();
        r.seen += 1;
        r.last_ms = now_ms;
        first
    } else if ranges.len() < MAX_RANGES {
        ranges.push(Range { cidr: key, source: "match".into(), seen: 1, last_ms: now_ms });
        true
    } else {
        return Ok(None);
    };
    write(dir, &ranges)?;
    Ok(new.then_some(c))
}

/// Adds the relay's shared ranges not known here yet. Returns how many were added.
pub fn merge_relay(dir: &Path, listed: &[String], now_ms: u64) -> Result<usize, String> {
    let mut ranges = read(dir);
    let mut added = 0;
    for c in listed.iter().filter_map(|s| parse_range(s)) {
        let key = c.to_string();
        if ranges.len() >= MAX_RANGES || ranges.iter().any(|r| r.cidr == key) {
            continue;
        }
        ranges.push(Range { cidr: key, source: "relay".into(), seen: 0, last_ms: now_ms });
        added += 1;
    }
    if added > 0 {
        write(dir, &ranges)?;
    }
    Ok(added)
}

/// Ranges seen in this device's own matches, for reporting to a relay.
pub fn from_matches(dir: &Path) -> Vec<String> {
    read(dir).into_iter().filter(|r| r.source == "match").map(|r| r.cidr).collect()
}

/// Every known range, sorted so the tunnel config only changes when the set does.
pub fn known(dir: &Path) -> Vec<Cidr> {
    let mut v: Vec<Cidr> = read(dir).iter().filter_map(|r| parse_range(&r.cidr)).collect();
    v.sort_by_key(|c| match c.addr {
        IpAddr::V4(a) => u32::from(a),
        IpAddr::V6(_) => u32::MAX,
    });
    v.dedup();
    v
}

/// Whether `outer` covers all of `inner`.
fn covers(outer: &Cidr, inner: &Cidr) -> bool {
    outer.addr.is_ipv4() == inner.addr.is_ipv4() && outer.len <= inner.len && outer.contains(&inner.addr)
}

/// `full` with its game ranges cut down to the known ranges it carries. The relay's own tunnel
/// address stays. With none of `ranges` inside `full`, `full` is returned as is.
pub fn narrow(full: &WgConfig, ranges: &[Cidr]) -> WgConfig {
    let probe = crate::relay::probe_addr(full);
    let game: Vec<Cidr> = ranges.iter().filter(|r| full.allowed_ips.iter().any(|f| Some(f.addr) != probe && covers(f, r))).cloned().collect();
    if game.is_empty() {
        return full.clone();
    }
    let mut out = full.clone();
    out.allowed_ips = full.allowed_ips.iter().filter(|a| a.len == 32 && Some(a.addr) == probe).cloned().chain(game).collect();
    out
}

/// The config the tunnel runs for a saved relay: narrowed to known game ranges when League is the
/// picked game, else the relay's full list.
pub fn effective(dir: &Path, full: &WgConfig) -> WgConfig {
    if crate::route_auto::is_league(&crate::relay::game_name(dir)) {
        narrow(full, &known(dir))
    } else {
        full.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Documentation addresses only.
    fn full() -> WgConfig {
        crate::relay::parse_config(
            "[Interface]\nPrivateKey = ZGV2aWNla2V5ZGV2aWNla2V5ZGV2aWNla2V5ZGV2aWM=\nAddress = 10.66.66.2/32\n\n[Peer]\nPublicKey = cGxhY2Vob2xkZXJwbGFjZWhvbGRlcnBsYWNlaG9sZGU=\nEndpoint = 203.0.113.10:51820\nAllowedIPs = 10.66.66.1/32, 198.51.100.0/23, 192.0.2.0/24\n",
        )
        .unwrap()
    }

    fn c(s: &str) -> Cidr {
        Cidr::parse(s).unwrap()
    }

    fn tmp() -> std::path::PathBuf {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!("rd-ranges-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn slash24_only_for_public_v4() {
        assert_eq!(slash24(&"198.51.100.77".parse().unwrap()), Some(c("198.51.100.0/24")));
        assert_eq!(slash24(&"10.0.0.5".parse().unwrap()), None);
        assert_eq!(slash24(&"2606:4700::1".parse().unwrap()), None);
        assert_eq!(parse_range("198.51.100.0/24"), Some(c("198.51.100.0/24")));
        for bad in ["198.51.100.7/24", "198.51.100.0/23", "10.1.2.0/24", "nope", "198.51.100.0"] {
            assert_eq!(parse_range(bad), None, "{bad}");
        }
    }

    #[test]
    fn narrows_to_known_ranges_inside_the_relay_list() {
        let n = narrow(&full(), &[c("198.51.101.0/24"), c("203.0.113.0/24")]);
        assert_eq!(n.allowed_ips, vec![c("10.66.66.1/32"), c("198.51.101.0/24")], "outside range dropped, relay /32 kept");
        assert_eq!(n.public_key, full().public_key);
    }

    #[test]
    fn keeps_the_full_list_until_a_range_is_known() {
        assert_eq!(narrow(&full(), &[]), full());
        assert_eq!(narrow(&full(), &[c("203.0.113.0/24")]), full(), "nothing the relay carries");
    }

    #[test]
    fn a_server_outside_the_narrowed_tunnel_is_not_carried() {
        let n = narrow(&full(), &[c("198.51.100.0/24")]);
        assert!(crate::relay::routes_via_tunnel(&n, &"198.51.100.9".parse().unwrap()));
        assert!(!crate::relay::routes_via_tunnel(&n, &"192.0.2.9".parse().unwrap()), "relay carries it, the narrowed tunnel doesn't");
    }

    #[test]
    fn learns_once_and_merges_relay_ranges() {
        let d = tmp();
        let ip: IpAddr = "198.51.100.77".parse().unwrap();
        assert_eq!(learn(&d, &ip, 1).unwrap(), Some(c("198.51.100.0/24")));
        assert_eq!(learn(&d, &"198.51.100.5".parse().unwrap(), 2).unwrap(), None, "same /24");
        assert_eq!(learn(&d, &"10.0.0.1".parse().unwrap(), 3).unwrap(), None);
        assert_eq!(read(&d)[0].seen, 2);
        let listed = vec!["192.0.2.0/24".to_string(), "198.51.100.0/24".into(), "bad".into(), "10.1.2.0/24".into()];
        assert_eq!(merge_relay(&d, &listed, 4).unwrap(), 1);
        assert_eq!(known(&d), vec![c("192.0.2.0/24"), c("198.51.100.0/24")], "sorted");
        assert_eq!(from_matches(&d), vec!["198.51.100.0/24".to_string()], "only own matches are reported");
        // A relay-listed range then seen in a match becomes the device's own.
        assert_eq!(learn(&d, &"192.0.2.1".parse().unwrap(), 5).unwrap(), Some(c("192.0.2.0/24")));
        assert_eq!(from_matches(&d).len(), 2);
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn effective_narrows_only_for_league() {
        let d = tmp();
        learn(&d, &"192.0.2.1".parse().unwrap(), 1).unwrap();
        // No game picked means League.
        assert_eq!(effective(&d, &full()).allowed_ips, vec![c("10.66.66.1/32"), c("192.0.2.0/24")]);
        std::fs::write(d.join("config.json"), r#"{"game":"cs2"}"#).unwrap();
        assert_eq!(effective(&d, &full()), full());
        std::fs::remove_dir_all(d).unwrap();
    }
}
