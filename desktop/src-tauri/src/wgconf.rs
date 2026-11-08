//! WireGuard client config parsing and rendering, std only. Shared by the app (relay.rs) and the
//! macOS privileged helper (desktop/mac-helper), so both refuse the same configs: the helper
//! re-checks every config it is handed before running it as root.

use std::net::IpAddr;

pub const MAX_CONF_BYTES: usize = 64 * 1024;

/// Most IPv4 addresses AllowedIPs may cover in total: a /12, about a million. Riot's whole AS6507
/// list is about 22,000, so a game's list fits with room to spare, and many wide ranges do not.
pub const MAX_ROUTED_V4: u128 = 1 << 20;
/// The same total for IPv6: a /16, the widest single range allowed. The relay carries IPv4 only.
pub const MAX_ROUTED_V6: u128 = 1 << 112;

// ---------- config parsing and validation ----------

#[derive(Clone, Debug, PartialEq)]
pub struct Cidr {
    pub addr: IpAddr,
    pub len: u8,
}

impl Cidr {
    pub fn parse(s: &str) -> Result<Cidr, String> {
        let s = s.trim();
        let (a, l) = s.split_once('/').unwrap_or((s, ""));
        let addr: IpAddr = a.parse().map_err(|_| format!("\"{s}\" is not an IP address or CIDR"))?;
        let max = if addr.is_ipv4() { 32 } else { 128 };
        let len = if l.is_empty() { max } else { l.parse::<u8>().map_err(|_| format!("\"{s}\" has a bad prefix length"))? };
        if len > max {
            return Err(format!("\"{s}\" has a bad prefix length"));
        }
        Ok(Cidr { addr, len })
    }

    pub fn contains(&self, ip: &IpAddr) -> bool {
        match (self.addr, ip) {
            (IpAddr::V4(n), IpAddr::V4(x)) => {
                let mask = if self.len == 0 { 0 } else { u32::MAX << (32 - self.len as u32) };
                u32::from(n) & mask == u32::from(*x) & mask
            }
            (IpAddr::V6(n), IpAddr::V6(x)) => {
                let mask = if self.len == 0 { 0 } else { u128::MAX << (128 - self.len as u32) };
                u128::from(n) & mask == u128::from(*x) & mask
            }
            _ => false,
        }
    }

    /// First and last address as numbers, host bits ignored. IPv4 sits in the low 32 bits.
    fn span(&self) -> (u128, u128) {
        let (a, bits) = match self.addr {
            IpAddr::V4(a) => (u32::from(a) as u128, 32),
            IpAddr::V6(a) => (u128::from(a), 128),
        };
        let host = bits - self.len as u32;
        let low = if host == 0 { 0 } else { u128::MAX >> (128 - host) };
        (a & !low, a | low)
    }
}

/// How many addresses of one family the ranges cover, overlaps counted once.
pub(crate) fn covered(cidrs: &[Cidr], v4: bool) -> u128 {
    let mut spans: Vec<(u128, u128)> = cidrs.iter().filter(|c| c.addr.is_ipv4() == v4).map(Cidr::span).collect();
    spans.sort_unstable();
    let mut total: u128 = 0;
    let mut run: Option<(u128, u128)> = None;
    for (s, e) in spans {
        run = match run {
            Some((rs, re)) if s <= re => Some((rs, re.max(e))),
            Some((rs, re)) => {
                total = total.saturating_add(re - rs).saturating_add(1);
                Some((s, e))
            }
            None => Some((s, e)),
        };
    }
    if let Some((rs, re)) = run {
        total = total.saturating_add(re - rs).saturating_add(1);
    }
    total
}

impl std::fmt::Display for Cidr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.addr, self.len)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct WgConfig {
    pub private_key: String,
    pub address: Vec<Cidr>,
    pub listen_port: Option<u16>,
    pub mtu: Option<u16>,
    pub public_key: String,
    pub preshared_key: Option<String>,
    pub endpoint_host: String,
    pub endpoint_port: u16,
    pub allowed_ips: Vec<Cidr>,
    pub keepalive: Option<u16>,
}

/// A WireGuard key: 32 bytes in standard base64, so 43 characters, the last of which carries only
/// 4 bits (its low 2 bits are zero), then one "=".
pub fn valid_key(k: &str) -> bool {
    let b = k.as_bytes();
    b.len() == 44
        && b[43] == b'='
        && b[..43].iter().all(|c| c.is_ascii_alphanumeric() || *c == b'+' || *c == b'/')
        && b"AEIMQUYcgkosw048".contains(&b[42])
}

fn parse_endpoint(v: &str) -> Result<(String, u16), String> {
    let bad = || format!("Endpoint \"{v}\" must be host:port");
    let (host, port) = if let Some(rest) = v.strip_prefix('[') {
        let (h, p) = rest.split_once("]:").ok_or_else(bad)?;
        h.parse::<std::net::Ipv6Addr>().map_err(|_| bad())?;
        (h.to_string(), p)
    } else {
        let (h, p) = v.rsplit_once(':').ok_or_else(bad)?;
        (h.to_string(), p)
    };
    let host_ok = !host.is_empty() && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'));
    let port: u16 = port.parse().map_err(|_| bad())?;
    if !host_ok || port == 0 {
        return Err(bad());
    }
    Ok((host, port))
}

fn set_once<T>(slot: &mut Option<T>, key: &str, v: T) -> Result<(), String> {
    if slot.is_some() {
        return Err(format!("{key} is set twice"));
    }
    *slot = Some(v);
    Ok(())
}

fn num<T: std::str::FromStr>(key: &str, v: &str) -> Result<T, String> {
    v.parse().map_err(|_| format!("{key} \"{v}\" is not a valid number"))
}

/// Parses and checks a client config. Keys and section names are case-insensitive, as in wg-quick.
pub fn parse_config(text: &str) -> Result<WgConfig, String> {
    if text.len() > MAX_CONF_BYTES {
        return Err("Config file is too large to be a WireGuard config.".into());
    }
    #[derive(PartialEq)]
    enum Sec {
        None,
        Iface,
        Peer,
    }
    let mut sec = Sec::None;
    let (mut ifaces, mut peers) = (0, 0);
    let (mut private_key, mut listen_port, mut mtu) = (None, None, None);
    let (mut public_key, mut preshared_key, mut endpoint, mut keepalive) = (None, None, None, None);
    let (mut address, mut allowed_ips) = (Vec::new(), Vec::new());
    for (n, raw) in text.lines().enumerate() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            sec = match line[1..line.len() - 1].trim().to_ascii_lowercase().as_str() {
                "interface" => {
                    ifaces += 1;
                    Sec::Iface
                }
                "peer" => {
                    peers += 1;
                    Sec::Peer
                }
                other => return Err(format!("Line {}: unknown section [{other}]", n + 1)),
            };
            continue;
        }
        let (k, v) = line.split_once('=').ok_or_else(|| format!("Line {}: expected Key = Value", n + 1))?;
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
        let list = || v.split(',').map(str::trim).filter(|s| !s.is_empty()).map(Cidr::parse).collect::<Result<Vec<_>, _>>();
        match (&sec, k.as_str()) {
            (Sec::None, _) => return Err(format!("Line {}: setting outside [Interface] or [Peer]", n + 1)),
            (_, "preup" | "postup" | "predown" | "postdown") => {
                return Err(format!("Config has {k}, which runs commands as admin. Use the config from rig-relay-add-peer."))
            }
            (Sec::Iface, "dns") => return Err("Config sets DNS, which would send every lookup through the relay. Remove the DNS line.".into()),
            (Sec::Iface, "privatekey") => set_once(&mut private_key, "PrivateKey", v.to_string())?,
            (Sec::Iface, "address") => address.extend(list()?),
            (Sec::Iface, "listenport") => set_once(&mut listen_port, "ListenPort", num::<u16>("ListenPort", v)?)?,
            (Sec::Iface, "mtu") => set_once(&mut mtu, "MTU", num::<u16>("MTU", v)?)?,
            (Sec::Peer, "publickey") => set_once(&mut public_key, "PublicKey", v.to_string())?,
            (Sec::Peer, "presharedkey") => set_once(&mut preshared_key, "PresharedKey", v.to_string())?,
            (Sec::Peer, "endpoint") => set_once(&mut endpoint, "Endpoint", parse_endpoint(v)?)?,
            (Sec::Peer, "allowedips") => allowed_ips.extend(list()?),
            (Sec::Peer, "persistentkeepalive") => set_once(&mut keepalive, "PersistentKeepalive", num::<u16>("PersistentKeepalive", v)?)?,
            (_, other) => return Err(format!("Line {}: \"{other}\" is not supported in a relay config", n + 1)),
        }
    }
    if ifaces != 1 || peers != 1 {
        return Err(format!("Config needs exactly one [Interface] and one [Peer] (found {ifaces} and {peers})."));
    }
    let private_key = private_key.ok_or("Config has no PrivateKey.")?;
    let public_key = public_key.ok_or("Config has no PublicKey.")?;
    if !valid_key(&private_key) || !valid_key(&public_key) || preshared_key.as_deref().is_some_and(|k| !valid_key(k)) {
        return Err("A key in the config is not a valid WireGuard key.".into());
    }
    let (endpoint_host, endpoint_port) = endpoint.ok_or("Config has no Endpoint.")?;
    if address.is_empty() {
        return Err("Config has no Address.".into());
    }
    if allowed_ips.is_empty() {
        return Err("Config has no AllowedIPs.".into());
    }
    if let Some(wide) = allowed_ips.iter().find(|c| c.len < if c.addr.is_ipv4() { 8 } else { 16 }) {
        return Err(format!("AllowedIPs has {wide}, which would send all traffic through the relay. Relay configs only cover game servers."));
    }
    for (v4, max, total) in [(true, MAX_ROUTED_V4, "a /12 of IPv4"), (false, MAX_ROUTED_V6, "a /16 of IPv6")] {
        if covered(&allowed_ips, v4) > max {
            return Err(format!("AllowedIPs adds up to more than {total} addresses, which would send a large part of the internet through the relay. Relay configs only cover game servers."));
        }
    }
    Ok(WgConfig { private_key, address, listen_port, mtu, public_key, preshared_key, endpoint_host, endpoint_port, allowed_ips, keepalive })
}

/// The config as stored: only the allowlisted keys, no comments.
pub fn render_config(c: &WgConfig) -> String {
    let join = |v: &[Cidr]| v.iter().map(Cidr::to_string).collect::<Vec<_>>().join(", ");
    let mut s = format!("[Interface]\nPrivateKey = {}\nAddress = {}\n", c.private_key, join(&c.address));
    if let Some(p) = c.listen_port {
        s += &format!("ListenPort = {p}\n");
    }
    if let Some(m) = c.mtu {
        s += &format!("MTU = {m}\n");
    }
    let host = if c.endpoint_host.contains(':') { format!("[{}]", c.endpoint_host) } else { c.endpoint_host.clone() };
    s += &format!("\n[Peer]\nPublicKey = {}\n", c.public_key);
    if let Some(k) = &c.preshared_key {
        s += &format!("PresharedKey = {k}\n");
    }
    s += &format!("Endpoint = {host}:{}\nAllowedIPs = {}\n", c.endpoint_port, join(&c.allowed_ips));
    if let Some(k) = c.keepalive {
        s += &format!("PersistentKeepalive = {k}\n");
    }
    s
}
