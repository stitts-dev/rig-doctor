//! The daemon: socket, caller check, and wg-quick. macOS only.

use crate::helper_proto::{encode_reply, APP_ID, HELPER_SOCKET};
use crate::request::{self, Request, MAX_REQUEST};
use std::ffi::{c_char, c_void, CStr, CString};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

/// Root-only folder for the config wg-quick runs. Never the user's own copy.
const DIR: &str = "/Library/Application Support/RigDoctor";
/// Same file name as the app's copy, so wg-quick names the interface the same (`rigrelay`) and a
/// tunnel started with the old password prompt can still be turned off here.
const CONF: &str = "/Library/Application Support/RigDoctor/rigrelay.conf";
const LOG: &str = "/Library/Application Support/RigDoctor/wg-quick.log";
/// Homebrew's wireguard-tools, Apple silicon then Intel. Never a path from the request.
const WG_QUICK: [&str; 2] = ["/opt/homebrew/bin/wg-quick", "/usr/local/bin/wg-quick"];
const PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

// ---------- Core Foundation and Security ----------

type CFTypeRef = *const c_void;
type OSStatus = i32;
const UTF8: u32 = 0x0800_0100;
/// kSecCSSigningInformation
const SIGNING_INFO: u32 = 1 << 1;
/// SOL_LOCAL and LOCAL_PEERTOKEN from sys/un.h.
const SOL_LOCAL: i32 = 0;
const LOCAL_PEERTOKEN: i32 = 6;

#[repr(C)]
struct KeyCallBacks([usize; 6]);
#[repr(C)]
struct ValueCallBacks([usize; 5]);

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFTypeDictionaryKeyCallBacks: KeyCallBacks;
    static kCFTypeDictionaryValueCallBacks: ValueCallBacks;
    fn CFRelease(cf: CFTypeRef);
    fn CFDataCreate(alloc: CFTypeRef, bytes: *const u8, len: isize) -> CFTypeRef;
    fn CFDictionaryCreate(alloc: CFTypeRef, keys: *const CFTypeRef, values: *const CFTypeRef, n: isize, k: *const KeyCallBacks, v: *const ValueCallBacks) -> CFTypeRef;
    fn CFDictionaryGetValue(dict: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
    fn CFStringCreateWithCString(alloc: CFTypeRef, s: *const c_char, encoding: u32) -> CFTypeRef;
    fn CFStringGetCString(s: CFTypeRef, buf: *mut c_char, size: isize, encoding: u32) -> u8;
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
}

#[link(name = "Security", kind = "framework")]
extern "C" {
    static kSecGuestAttributeAudit: CFTypeRef;
    static kSecCodeInfoTeamIdentifier: CFTypeRef;
    fn SecCodeCopySelf(flags: u32, me: *mut CFTypeRef) -> OSStatus;
    fn SecCodeCopySigningInformation(code: CFTypeRef, flags: u32, info: *mut CFTypeRef) -> OSStatus;
    fn SecCodeCopyGuestWithAttributes(host: CFTypeRef, attrs: CFTypeRef, flags: u32, guest: *mut CFTypeRef) -> OSStatus;
    fn SecRequirementCreateWithString(text: CFTypeRef, flags: u32, req: *mut CFTypeRef) -> OSStatus;
    fn SecCodeCheckValidity(code: CFTypeRef, flags: u32, req: CFTypeRef) -> OSStatus;
}

extern "C" {
    fn getsockopt(fd: i32, level: i32, name: i32, value: *mut c_void, len: *mut u32) -> i32;
}

/// Releases a CF object when dropped. Null is allowed.
struct Cf(CFTypeRef);

impl Drop for Cf {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) }
        }
    }
}

fn cf_string(s: &str) -> Option<Cf> {
    let c = CString::new(s).ok()?;
    let r = unsafe { CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), UTF8) };
    (!r.is_null()).then_some(Cf(r))
}

/// The Apple team id this helper is signed with. None when unsigned or ad-hoc signed.
fn own_team() -> Option<String> {
    unsafe {
        let mut me = std::ptr::null();
        if SecCodeCopySelf(0, &mut me) != 0 {
            return None;
        }
        let me = Cf(me);
        let mut info = std::ptr::null();
        if SecCodeCopySigningInformation(me.0, SIGNING_INFO, &mut info) != 0 {
            return None;
        }
        let info = Cf(info);
        let team = CFDictionaryGetValue(info.0, kSecCodeInfoTeamIdentifier);
        if team.is_null() || CFGetTypeID(team) != CFStringGetTypeID() {
            return None;
        }
        let mut buf = [0 as c_char; 64];
        if CFStringGetCString(team, buf.as_mut_ptr(), buf.len() as isize, UTF8) == 0 {
            return None;
        }
        Some(CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned())
    }
}

fn requirement(text: &str) -> Option<Cf> {
    let s = cf_string(text)?;
    let mut req = std::ptr::null();
    let ok = unsafe { SecRequirementCreateWithString(s.0, 0, &mut req) } == 0;
    ok.then_some(Cf(req))
}

/// True when the process on the other end of the socket meets `req`. Uses the audit token, not the
/// pid, so a process that exits and has its pid reused cannot pass as the app.
fn peer_allowed(stream: &UnixStream, req: &Cf) -> bool {
    let mut token = [0u8; 32];
    let mut len = token.len() as u32;
    let got = unsafe { getsockopt(stream.as_raw_fd(), SOL_LOCAL, LOCAL_PEERTOKEN, token.as_mut_ptr().cast(), &mut len) };
    if got != 0 || len as usize != token.len() {
        return false;
    }
    unsafe {
        let data = Cf(CFDataCreate(std::ptr::null(), token.as_ptr(), token.len() as isize));
        if data.0.is_null() {
            return false;
        }
        let keys = [kSecGuestAttributeAudit];
        let values = [data.0];
        let attrs = Cf(CFDictionaryCreate(std::ptr::null(), keys.as_ptr(), values.as_ptr(), 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks));
        if attrs.0.is_null() {
            return false;
        }
        let mut guest = std::ptr::null();
        if SecCodeCopyGuestWithAttributes(std::ptr::null(), attrs.0, 0, &mut guest) != 0 {
            return false;
        }
        let guest = Cf(guest);
        SecCodeCheckValidity(guest.0, 0, req.0) == 0
    }
}

// ---------- tunnel ----------

fn wg_quick() -> Option<PathBuf> {
    WG_QUICK.iter().map(PathBuf::from).find(|p| p.is_file())
}

/// Creates DIR as root-only and refuses one that is a symlink or not root's: /Library/Application
/// Support is writable by admin users, so a planted link could otherwise redirect root's writes.
fn private_dir() -> Result<(), String> {
    let dir = Path::new(DIR);
    if std::fs::symlink_metadata(dir).is_err() {
        std::fs::create_dir(dir).map_err(|e| format!("Creating {DIR}: {e}"))?;
    }
    let meta = std::fs::symlink_metadata(dir).map_err(|e| format!("Checking {DIR}: {e}"))?;
    if !meta.is_dir() || meta.uid() != 0 {
        return Err(format!("{DIR} is not a folder owned by root. Remove it and try again."));
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| format!("Securing {DIR}: {e}"))
}

fn write_conf(text: &str) -> Result<(), String> {
    private_dir()?;
    let tmp = format!("{CONF}.tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut f = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp).map_err(|e| format!("Writing the relay config: {e}"))?;
    f.write_all(text.as_bytes()).and_then(|_| f.sync_all()).map_err(|e| format!("Writing the relay config: {e}"))?;
    std::fs::rename(&tmp, CONF).map_err(|e| format!("Saving the relay config: {e}"))
}

/// Runs `wg-quick <verb> CONF` with a fixed PATH and nothing from the caller's environment. Output
/// goes to a file rather than a pipe, so wg-quick's background route monitor cannot hold us up.
fn wg(quick: &Path, verb: &str) -> Result<(), String> {
    private_dir()?;
    let log = File::create(LOG).map_err(|e| format!("Opening {LOG}: {e}"))?;
    let err = log.try_clone().map_err(|e| e.to_string())?;
    let status = Command::new(quick)
        .arg(verb)
        .arg(CONF)
        .env_clear()
        .env("PATH", PATH)
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(err)
        .status()
        .map_err(|e| format!("Starting wg-quick: {e}"))?;
    if status.success() {
        return Ok(());
    }
    let out = std::fs::read_to_string(LOG).unwrap_or_default();
    let tail: Vec<&str> = out.lines().filter(|l| !l.trim().is_empty()).collect();
    let tail = tail[tail.len().saturating_sub(3)..].join(" ");
    Err(if tail.is_empty() { format!("wg-quick {verb} failed (exit {:?}).", status.code()) } else { format!("wg-quick {verb} failed: {tail}") })
}

/// wg-quick down, or, when that fails (never started here, or half started), remove
/// wireguard-go's socket so it exits and takes the utun with it.
fn down(quick: Option<&Path>) {
    if let Some(q) = quick {
        if Path::new(CONF).exists() && wg(q, "down").is_ok() {
            return;
        }
    }
    for f in ["rigrelay.sock", "rigrelay.name"] {
        let _ = std::fs::remove_file(Path::new("/var/run/wireguard").join(f));
    }
}

fn handle(req: Request) -> Result<(), String> {
    let quick = wg_quick();
    match req {
        Request::Down => {
            down(quick.as_deref());
            Ok(())
        }
        Request::Up(conf) => {
            let q = quick.ok_or("WireGuard tools are not installed. Run `brew install wireguard-tools` and try again.")?;
            down(Some(&q));
            write_conf(&conf)?;
            wg(&q, "up")
        }
    }
}

fn serve_one(mut stream: UnixStream, req: &Cf) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let result = if !peer_allowed(&stream, req) {
        Err("Only Rig Doctor Globe, signed by its developer, can use this helper.".into())
    } else {
        let mut buf = Vec::new();
        match (&mut stream).take(MAX_REQUEST as u64 + 1).read_to_end(&mut buf) {
            Ok(_) => request::parse(&buf).and_then(handle),
            Err(e) => Err(format!("Reading the request: {e}")),
        }
    };
    let _ = stream.write_all(encode_reply(&result).as_bytes());
}

pub fn serve() -> i32 {
    if unsafe { libc_geteuid() } != 0 {
        eprintln!("rig-doctor-helper must run as root (launchd starts it).");
        return 1;
    }
    let Some(text) = own_team().and_then(|t| request::client_requirement(APP_ID, &t)) else {
        eprintln!("rig-doctor-helper is not signed with a Developer ID team, so it serves no one.");
        return 1;
    };
    let Some(req) = requirement(&text) else {
        eprintln!("Could not build the code requirement: {text}");
        return 1;
    };
    let _ = std::fs::remove_file(HELPER_SOCKET);
    let listener = match UnixListener::bind(HELPER_SOCKET) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Binding {HELPER_SOCKET}: {e}");
            return 1;
        }
    };
    // Anyone may connect. peer_allowed decides who is answered.
    if let Err(e) = std::fs::set_permissions(HELPER_SOCKET, std::fs::Permissions::from_mode(0o666)) {
        eprintln!("Opening {HELPER_SOCKET} to the app: {e}");
        return 1;
    }
    for conn in listener.incoming().flatten() {
        serve_one(conn, &req);
    }
    0
}

extern "C" {
    #[link_name = "geteuid"]
    fn libc_geteuid() -> u32;
}
