//! Offline GeoIP from the DB-IP Lite databases (city and ASN, MMDB format).
//!
//! DB-IP Lite is CC BY 4.0: free for commercial use as long as the app credits DB-IP
//! ("IP Geolocation by DB-IP", linked to https://db-ip.com). The online providers in
//! lib.rs forbid commercial use on their free tiers, so they are only used while no
//! database is installed.
//!
//! The databases are downloaded at runtime into `<app data>/geoip/`, never shipped in the
//! repo. Each release is its own file (`dbip-city-lite-2026-11.mmdb`), so an update never
//! rewrites a file that is memory-mapped: it writes the new release, swaps the reader, and
//! removes older releases once nothing maps them.

use crate::Geo;
use maxminddb::{geoip2, Mmap, Reader};
use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

pub const ATTRIBUTION: &str = "IP Geolocation by DB-IP";
pub const ATTRIBUTION_URL: &str = "https://db-ip.com";
pub const LICENSE: &str = "CC BY 4.0";
const DOWNLOAD_BASE: &str = "https://download.db-ip.com/free/";
const META_FILE: &str = "geoip.json";

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    City,
    Asn,
}

impl Kind {
    fn stem(self) -> &'static str {
        match self {
            Kind::City => "dbip-city-lite",
            Kind::Asn => "dbip-asn-lite",
        }
    }
    fn file(self, release: &str) -> String {
        format!("{}-{release}.mmdb", self.stem())
    }
    fn url(self, release: &str) -> String {
        format!("{DOWNLOAD_BASE}{}-{release}.mmdb.gz", self.stem())
    }
}

/// The release named in a file name, e.g. "2026-11" from "dbip-city-lite-2026-11.mmdb".
fn release_of(kind: Kind, file_name: &str) -> Option<String> {
    let r = file_name.strip_prefix(kind.stem())?.strip_prefix('-')?.strip_suffix(".mmdb")?;
    let ok = r.len() == 7 && r.as_bytes()[4] == b'-' && r.bytes().enumerate().all(|(i, b)| i == 4 || b.is_ascii_digit());
    ok.then(|| r.to_string())
}

/// The newest complete release of `kind` in `dir`.
fn newest(dir: &Path, kind: Kind) -> Option<(String, PathBuf)> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|e| Some((release_of(kind, e.file_name().to_str()?)?, e.path())))
        .max_by(|a, b| a.0.cmp(&b.0))
}

fn open(path: &Path) -> Result<Reader<Mmap>, String> {
    // SAFETY: the file lives in the app's private data dir and is never written after it is
    // renamed into place. Updates write a new file under a new name (see the module docs).
    unsafe { Reader::open_mmap(path) }.map_err(|e| format!("{}: {e}", path.display()))
}

pub struct OfflineDb {
    pub release: String,
    city: Reader<Mmap>,
    asn: Option<Reader<Mmap>>,
}

impl OfflineDb {
    /// Opens the newest city database in `dir`, plus the newest ASN database if there is one.
    /// None when no city database is installed or it cannot be read.
    pub fn open_dir(dir: &Path) -> Option<Self> {
        let (release, path) = newest(dir, Kind::City)?;
        let city = open(&path).ok()?;
        let asn = newest(dir, Kind::Asn).and_then(|(_, p)| open(&p).ok());
        Some(Self { release, city, asn })
    }

    /// Opens a given pair of files (tests use the fixtures).
    pub fn open_files(city: &Path, asn: Option<&Path>) -> Result<Self, String> {
        Ok(Self { release: String::new(), city: open(city)?, asn: asn.map(open).transpose()? })
    }

    /// The answer for `ip`, filed under `query`. None when the database has no coordinates for it.
    pub fn lookup(&self, query: &str, ip: IpAddr) -> Option<Geo> {
        let found = self.city.lookup(ip).ok()?;
        let c: geoip2::City = found.decode().ok()??;
        let (lat, lon) = (c.location.latitude?, c.location.longitude?);
        let text = |s: Option<&str>| s.map(str::trim).filter(|s| !s.is_empty()).map(String::from);
        let asn = self.asn.as_ref().and_then(|r| r.lookup(ip).ok()?.decode::<geoip2::Asn>().ok()?);
        let org = asn.as_ref().and_then(|a| text(a.autonomous_system_organization));
        Some(Geo {
            query: query.into(),
            status: "success".into(),
            city: text(c.city.names.english),
            region: c.subdivisions.first().and_then(|s| text(s.names.english)),
            country: text(c.country.names.english),
            lat: Some(lat),
            lon: Some(lon),
            isp: org.clone(),
            // ip-api's "AS<number> <owner>" form, which route.ts splits.
            asn: asn.and_then(|a| a.autonomous_system_number).map(|n| match &org {
                Some(o) => format!("AS{n} {o}"),
                None => format!("AS{n}"),
            }),
        })
    }
}

// ---------- state shared with the Tauri commands ----------

pub struct GeoDb {
    dir: PathBuf,
    db: RwLock<Option<Arc<OfflineDb>>>,
    updating: AtomicBool,
}

impl GeoDb {
    pub fn load(dir: PathBuf) -> Self {
        let db = OfflineDb::open_dir(&dir).map(Arc::new);
        let me = Self { dir, db: RwLock::new(db), updating: AtomicBool::new(false) };
        me.remove_old_releases();
        me
    }

    /// The installed database, or None to use the online fallback.
    pub fn current(&self) -> Option<Arc<OfflineDb>> {
        self.db.read().unwrap().clone()
    }

    fn remove_old_releases(&self) {
        // A file another lookup still maps cannot be removed on Windows; the next start retries.
        for kind in [Kind::City, Kind::Asn] {
            let Some((keep, _)) = newest(&self.dir, kind) else { continue };
            for e in std::fs::read_dir(&self.dir).into_iter().flatten().flatten() {
                let name = e.file_name();
                let Some(name) = name.to_str() else { continue };
                let stale = release_of(kind, name).is_some_and(|r| r != keep) || name.ends_with(".part");
                if stale {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }

    pub fn status(&self) -> GeoDbStatus {
        let meta = read_meta(&self.dir);
        let db = self.current();
        GeoDbStatus {
            installed: db.is_some(),
            release: db.as_ref().map(|d| d.release.clone()),
            has_asn: db.as_ref().is_some_and(|d| d.asn.is_some()),
            updated_at_ms: meta.and_then(|m| m.updated_at_ms),
            updating: self.updating.load(Ordering::SeqCst),
            dir: self.dir.to_string_lossy().into_owned(),
            source: if db.is_some() { "DB-IP Lite (offline)" } else { "online fallback (no database installed)" }.into(),
            attribution: ATTRIBUTION.into(),
            attribution_url: ATTRIBUTION_URL.into(),
            license: LICENSE.into(),
        }
    }

    /// True when the installed release is older than this month's, or none is installed.
    pub fn is_stale(&self, now_secs: u64) -> bool {
        self.current().is_none_or(|d| d.release < year_month(now_secs))
    }

    /// Downloads this month's release (last month's while this month's is not out yet) of any
    /// database that is missing or older, then swaps it in. One update runs at a time.
    pub async fn update(&self, client: &reqwest::Client, now_secs: u64) -> Result<GeoDbStatus, String> {
        if self.updating.swap(true, Ordering::SeqCst) {
            return Err("a GeoIP database update is already running".into());
        }
        let result = self.update_inner(client, now_secs).await;
        self.updating.store(false, Ordering::SeqCst);
        result?;
        Ok(self.status())
    }

    async fn update_inner(&self, client: &reqwest::Client, now_secs: u64) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let releases = [year_month(now_secs), year_month(now_secs.saturating_sub(31 * 86_400))];
        let mut got = Vec::new();
        for kind in [Kind::City, Kind::Asn] {
            let have = newest(&self.dir, kind).map(|(r, _)| r);
            let mut last_err = String::new();
            for release in releases.iter().filter(|r| have.as_ref().is_none_or(|h| h < *r)) {
                match download(client, &self.dir, kind, release).await {
                    Ok(()) => {
                        got.push(release.clone());
                        last_err.clear();
                        break;
                    }
                    Err(e) => last_err = e,
                }
            }
            // Missing the city database is an error. An already-installed or ASN-only miss is not.
            if !last_err.is_empty() && kind == Kind::City && have.is_none() {
                return Err(last_err);
            }
        }
        if !got.is_empty() {
            let fresh = OfflineDb::open_dir(&self.dir).ok_or("downloaded GeoIP database does not open")?;
            let release = fresh.release.clone();
            *self.db.write().unwrap() = Some(Arc::new(fresh));
            write_meta(&self.dir, &Meta { release: Some(release), updated_at_ms: Some(now_secs * 1000), attribution: ATTRIBUTION.into(), license: LICENSE.into(), source: DOWNLOAD_BASE.into() });
            self.remove_old_releases();
        }
        Ok(())
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct GeoDbStatus {
    pub installed: bool,
    pub release: Option<String>,
    pub has_asn: bool,
    pub updated_at_ms: Option<u64>,
    pub updating: bool,
    pub dir: String,
    pub source: String,
    pub attribution: String,
    pub attribution_url: String,
    pub license: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Meta {
    release: Option<String>,
    updated_at_ms: Option<u64>,
    attribution: String,
    license: String,
    source: String,
}

fn read_meta(dir: &Path) -> Option<Meta> {
    serde_json::from_str(&std::fs::read_to_string(dir.join(META_FILE)).ok()?).ok()
}

fn write_meta(dir: &Path, meta: &Meta) {
    if let Ok(s) = serde_json::to_string_pretty(meta) {
        let _ = std::fs::write(dir.join(META_FILE), s);
    }
}

/// Fetches one gzipped release, unpacks it beside the others and checks it opens before it
/// gets its final name, so a cut-off download never becomes the live database.
async fn download(client: &reqwest::Client, dir: &Path, kind: Kind, release: &str) -> Result<(), String> {
    use std::io::Write;
    let url = kind.url(release);
    let mut r = client.get(&url).send().await.map_err(|e| format!("{url}: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("{url}: HTTP {}", r.status()));
    }
    let gz = dir.join(format!("{}.gz.part", kind.file(release)));
    let mut f = std::fs::File::create(&gz).map_err(|e| e.to_string())?;
    while let Some(chunk) = r.chunk().await.map_err(|e| format!("{url}: {e}"))? {
        f.write_all(&chunk).map_err(|e| e.to_string())?;
    }
    drop(f);
    let (dir, file) = (dir.to_path_buf(), kind.file(release));
    tauri::async_runtime::spawn_blocking(move || {
        let part = dir.join(format!("{file}.part"));
        let unpack = || -> Result<(), String> {
            let mut src = flate2::read::GzDecoder::new(std::fs::File::open(&gz).map_err(|e| e.to_string())?);
            let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
            std::io::copy(&mut src, &mut out).map_err(|e| format!("unpack {file}: {e}"))?;
            out.sync_all().map_err(|e| e.to_string())?;
            drop(out);
            // Opens and is readable, or it is not installed.
            open(&part)?.lookup("1.1.1.1".parse().unwrap()).map_err(|e| format!("{file}: {e}"))?;
            std::fs::rename(&part, dir.join(&file)).map_err(|e| e.to_string())
        };
        let res = unpack();
        let _ = std::fs::remove_file(&gz);
        let _ = std::fs::remove_file(&part);
        res
    })
    .await
    .map_err(|e| e.to_string())?
}

/// This machine's public address, for the "self" lookup. Both services are free with no
/// commercial-use restriction and return only the address.
pub async fn public_ip(client: &reqwest::Client) -> Option<IpAddr> {
    if let Some(ip) = get_text(client, "https://api.ipify.org").await.and_then(|t| t.trim().parse().ok()) {
        return Some(ip);
    }
    let trace = get_text(client, "https://1.1.1.1/cdn-cgi/trace").await?;
    parse_cf_trace(&trace)
}

async fn get_text(client: &reqwest::Client, url: &str) -> Option<String> {
    let r = client.get(url).send().await.ok()?;
    r.status().is_success().then_some(())?;
    r.text().await.ok()
}

fn parse_cf_trace(text: &str) -> Option<IpAddr> {
    text.lines().find_map(|l| l.strip_prefix("ip=")?.trim().parse().ok())
}

/// "YYYY-MM" in UTC for a Unix time, the DB-IP release naming.
pub fn year_month(secs: u64) -> String {
    // Howard Hinnant's civil_from_days.
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}")
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn download_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
    }

    fn db() -> OfflineDb {
        OfflineDb::open_files(&fixture("geoip-city-test.mmdb"), Some(&fixture("geoip-asn-test.mmdb"))).unwrap()
    }

    #[test]
    fn looks_up_city_region_country_and_asn() {
        let g = db().lookup("riot", "198.51.100.7".parse().unwrap()).unwrap();
        assert_eq!(g.query, "riot");
        assert_eq!(g.status, "success");
        assert_eq!(g.city.as_deref(), Some("Chicago"));
        assert_eq!(g.region.as_deref(), Some("Illinois"));
        assert_eq!(g.country.as_deref(), Some("United States"));
        assert!((g.lat.unwrap() - 41.8781).abs() < 1e-6 && (g.lon.unwrap() + 87.6298).abs() < 1e-6);
        assert_eq!(g.asn.as_deref(), Some("AS6507 Riot Games, Inc"));
        assert_eq!(g.isp.as_deref(), Some("Riot Games, Inc"));
    }

    #[test]
    fn ipv6_and_missing_asn() {
        let g = db().lookup("v6", "2001:db8::1".parse().unwrap()).unwrap();
        assert_eq!(g.city.as_deref(), Some("Frankfurt am Main"));
        assert_eq!(g.region, None);
        assert_eq!(g.asn, None);
        let no_asn_db = OfflineDb::open_files(&fixture("geoip-city-test.mmdb"), None).unwrap();
        assert_eq!(no_asn_db.lookup("q", "198.51.100.7".parse().unwrap()).unwrap().asn, None);
    }

    #[test]
    fn no_coordinates_or_no_record_is_no_answer() {
        assert!(db().lookup("q", "203.0.113.9".parse().unwrap()).is_none(), "country-only record");
        assert!(db().lookup("q", "192.0.2.1".parse().unwrap()).is_none(), "not in the database");
    }

    #[test]
    fn year_month_is_utc_civil_date() {
        assert_eq!(year_month(0), "1970-01");
        assert_eq!(year_month(1_794_009_600), "2026-11"); // 2026-11-07 00:00 UTC
        assert_eq!(year_month(1_772_323_199), "2026-02"); // 2026-02-28 23:59:59 UTC
        assert_eq!(year_month(1_772_323_200), "2026-03");
        assert_eq!(year_month(1_709_164_800), "2024-02"); // 2024-02-29, leap day
    }

    #[test]
    fn release_names_and_urls() {
        assert_eq!(release_of(Kind::City, "dbip-city-lite-2026-11.mmdb").as_deref(), Some("2026-11"));
        assert_eq!(release_of(Kind::City, "dbip-city-lite-2026-11.mmdb.part"), None);
        assert_eq!(release_of(Kind::City, "dbip-asn-lite-2026-11.mmdb"), None);
        assert_eq!(release_of(Kind::Asn, "dbip-asn-lite-26-11.mmdb"), None);
        assert_eq!(Kind::Asn.url("2026-11"), "https://download.db-ip.com/free/dbip-asn-lite-2026-11.mmdb.gz");
    }

    #[test]
    fn picks_newest_release_and_clears_old_ones() {
        let dir = std::env::temp_dir().join(format!("rig-geoip-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (src, name) in [
            ("geoip-city-test.mmdb", "dbip-city-lite-2026-10.mmdb"),
            ("geoip-city-test.mmdb", "dbip-city-lite-2026-11.mmdb"),
            ("geoip-asn-test.mmdb", "dbip-asn-lite-2026-11.mmdb"),
        ] {
            std::fs::copy(fixture(src), dir.join(name)).unwrap();
        }
        std::fs::write(dir.join("dbip-city-lite-2026-12.mmdb.part"), b"cut off").unwrap();
        let state = GeoDb::load(dir.clone());
        let s = state.status();
        assert!(s.installed && s.has_asn);
        assert_eq!(s.release.as_deref(), Some("2026-11"));
        assert_eq!(s.attribution, "IP Geolocation by DB-IP");
        assert!(!state.is_stale(1_794_009_600));
        assert!(state.is_stale(1_794_009_600 + 40 * 86_400));
        assert!(state.current().unwrap().lookup("q", "198.51.100.1".parse().unwrap()).is_some());
        let left: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().into_string().unwrap()).collect();
        // Windows cannot remove a mapped file, but the old release is not mapped here.
        assert!(!left.iter().any(|n| n.contains("2026-10") || n.ends_with(".part")), "{left:?}");
        drop(state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_dir_means_online_fallback() {
        let state = GeoDb::load(std::env::temp_dir().join("rig-geoip-test-none"));
        assert!(state.current().is_none());
        assert!(state.is_stale(0));
        assert_eq!(state.status().source, "online fallback (no database installed)");
    }

    #[test]
    fn reads_cloudflare_trace() {
        assert_eq!(parse_cf_trace("fl=1\nh=1.1.1.1\nip=198.51.100.4\nts=1\n"), Some("198.51.100.4".parse().unwrap()));
        assert_eq!(parse_cf_trace("fl=1\n"), None);
    }

    /// Reads a real DB-IP Lite city file. Run with
    /// `GEOIP_CITY_MMDB=path/to/dbip-city-lite.mmdb cargo test -- --ignored real_dbip_file`.
    #[test]
    #[ignore]
    fn real_dbip_file() {
        let city = std::env::var("GEOIP_CITY_MMDB").expect("set GEOIP_CITY_MMDB");
        let db = OfflineDb::open_files(Path::new(&city), None).unwrap();
        for ip in ["8.8.8.8", "104.160.131.3", "2606:4700:4700::1111"] {
            let g = db.lookup(ip, ip.parse().unwrap()).unwrap_or_else(|| panic!("{ip}: no answer"));
            assert!(g.lat.is_some() && g.country.is_some() && g.city.is_some(), "{g:?}");
            println!("{g:?}");
        }
    }

    /// Downloads the real current DB-IP Lite release. Run with `cargo test -- --ignored live_dbip`.
    #[test]
    #[ignore]
    fn live_dbip_download() {
        tauri::async_runtime::block_on(async {
            let dir = std::env::temp_dir().join("rig-geoip-live");
            let state = GeoDb::load(dir);
            let s = state.update(&download_client().unwrap(), now_secs()).await.unwrap();
            assert!(s.installed && s.has_asn, "{s:?}");
            let g = state.current().unwrap().lookup("q", "8.8.8.8".parse().unwrap()).unwrap();
            assert!(g.lat.is_some() && g.asn.as_deref().is_some_and(|a| a.starts_with("AS15169")), "{g:?}");
            println!("{s:?}\n{g:?}");
        });
    }
}
