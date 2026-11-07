//! macOS: On and Off through the privileged helper (desktop/mac-helper), so the relay tunnel
//! changes without a password prompt once the user has allowed the helper in System Settings.
//!
//! The signed app registers the helper with SMAppService the first time the tunnel changes. Until
//! the helper is allowed and answering, and in dev or unsigned builds where registration fails,
//! `run` returns None and the caller uses the password prompt as before.

use crate::helper_proto as proto;
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Status {
    NotRegistered,
    Enabled,
    RequiresApproval,
    NotFound,
    /// No SMAppService (macOS 12 or older) or no service object.
    Unavailable,
}

/// SMAppServiceStatus values.
pub fn status_from(n: isize) -> Status {
    match n {
        0 => Status::NotRegistered,
        1 => Status::Enabled,
        2 => Status::RequiresApproval,
        3 => Status::NotFound,
        _ => Status::Unavailable,
    }
}

pub const APPROVE: &str = "One-time step: turn on \"Rig Doctor Globe\" under System Settings > General > Login Items (opened for you), then try again. After that, On and Off no longer ask for your password.";

/// Asks for approval once per app run. After that, a user who has not approved gets the password prompt.
static ASKED: AtomicBool = AtomicBool::new(false);

/// What to do with the helper's state: Some(true) use it, Some(false) tell the user to approve it,
/// None fall back to the password prompt.
pub fn plan(status: Status, asked_before: bool) -> Option<bool> {
    match status {
        Status::Enabled => Some(true),
        Status::RequiresApproval if !asked_before => Some(false),
        _ => None,
    }
}

/// None: the helper cannot take this change, use the password prompt.
pub fn run(verb: &str, conf: &Path) -> Option<Result<(), String>> {
    let mut status = sm::status();
    if status == Status::NotRegistered {
        status = sm::register();
    }
    match plan(status, ASKED.load(Ordering::SeqCst))? {
        true => send(verb, conf),
        false => {
            ASKED.store(true, Ordering::SeqCst);
            sm::open_login_items();
            Some(Err(APPROVE.into()))
        }
    }
}

fn send(verb: &str, conf: &Path) -> Option<Result<(), String>> {
    let body = if verb == "up" {
        match std::fs::read_to_string(conf) {
            Ok(t) => Some(t),
            Err(e) => return Some(Err(format!("Reading the relay config: {e}"))),
        }
    } else {
        None
    };
    // Right after approval launchd may still be starting the helper.
    let mut stream = None;
    for _ in 0..10 {
        if let Ok(s) = UnixStream::connect(proto::HELPER_SOCKET) {
            stream = Some(s);
            break;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    let mut s = stream?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(40)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(10)));
    let mut reply = String::new();
    let io = s
        .write_all(proto::request(verb, body.as_deref()).as_bytes())
        .and_then(|_| s.shutdown(Shutdown::Write))
        .and_then(|_| s.read_to_string(&mut reply));
    Some(match io {
        Ok(_) => proto::decode_reply(&reply),
        Err(e) => Err(format!("The Rig Doctor helper did not answer: {e}")),
    })
}

/// SMAppService through the Objective-C runtime. Each call runs in its own autorelease pool.
#[cfg(target_os = "macos")]
mod sm {
    use super::{status_from, Status};
    use crate::helper_proto::HELPER_PLIST;
    use std::ffi::{c_char, c_void, CStr, CString};

    type Id = *mut c_void;
    type Sel = *const c_void;

    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> Sel;
        fn objc_msgSend();
        fn objc_autoreleasePoolPush() -> *mut c_void;
        fn objc_autoreleasePoolPop(pool: *mut c_void);
    }

    #[link(name = "ServiceManagement", kind = "framework")]
    extern "C" {}

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(alloc: *const c_void, s: *const c_char, encoding: u32) -> Id;
        fn CFRelease(cf: *const c_void);
    }

    fn sel(name: &CStr) -> Sel {
        unsafe { sel_registerName(name.as_ptr()) }
    }

    fn pooled<T>(f: impl FnOnce() -> T) -> T {
        let pool = unsafe { objc_autoreleasePoolPush() };
        let out = f();
        unsafe { objc_autoreleasePoolPop(pool) };
        out
    }

    fn class() -> Option<Id> {
        let c = unsafe { objc_getClass(c"SMAppService".as_ptr()) };
        (!c.is_null()).then_some(c)
    }

    /// +[SMAppService daemonServiceWithPlistName:], autoreleased.
    fn service() -> Option<Id> {
        let cls = class()?;
        let name = CString::new(HELPER_PLIST).ok()?;
        unsafe {
            let ns = CFStringCreateWithCString(std::ptr::null(), name.as_ptr(), 0x0800_0100);
            if ns.is_null() {
                return None;
            }
            let f: unsafe extern "C" fn(Id, Sel, Id) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let svc = f(cls, sel(c"daemonServiceWithPlistName:"), ns);
            CFRelease(ns);
            (!svc.is_null()).then_some(svc)
        }
    }

    fn status_of(svc: Id) -> Status {
        let f: unsafe extern "C" fn(Id, Sel) -> isize = unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
        status_from(unsafe { f(svc, sel(c"status")) })
    }

    pub fn status() -> Status {
        pooled(|| service().map(status_of).unwrap_or(Status::Unavailable))
    }

    /// Registers the daemon and returns the status after. The BOOL result is not read: the status
    /// says what happened (Enabled, or RequiresApproval until the user allows it).
    pub fn register() -> Status {
        pooled(|| {
            let Some(svc) = service() else { return Status::Unavailable };
            let mut err: Id = std::ptr::null_mut();
            let f: unsafe extern "C" fn(Id, Sel, *mut Id) -> u8 = unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
            unsafe { f(svc, sel(c"registerAndReturnError:"), &mut err) };
            status_of(svc)
        })
    }

    pub fn open_login_items() {
        pooled(|| {
            if let Some(cls) = class() {
                let f: unsafe extern "C" fn(Id, Sel) = unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
                unsafe { f(cls, sel(c"openSystemSettingsLoginItems")) };
            }
        })
    }
}

/// Other Unix builds compile this file for its tests only: there is no helper.
#[cfg(not(target_os = "macos"))]
mod sm {
    use super::Status;
    pub fn status() -> Status {
        Status::Unavailable
    }
    pub fn register() -> Status {
        Status::Unavailable
    }
    pub fn open_login_items() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_uses_helper_only_when_enabled() {
        assert_eq!(plan(Status::Enabled, false), Some(true));
        assert_eq!(plan(Status::Enabled, true), Some(true));
        assert_eq!(plan(Status::RequiresApproval, false), Some(false));
        assert_eq!(plan(Status::RequiresApproval, true), None);
        for s in [Status::NotRegistered, Status::NotFound, Status::Unavailable] {
            assert_eq!(plan(s, false), None);
        }
        assert_eq!(status_from(1), Status::Enabled);
        assert_eq!(status_from(9), Status::Unavailable);
    }

    #[test]
    fn helper_files_agree() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let conf: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join("tauri.conf.json")).unwrap()).unwrap();
        assert_eq!(conf["identifier"], proto::APP_ID);
        let plist = std::fs::read_to_string(root.join("macos").join(proto::HELPER_PLIST)).unwrap();
        assert!(plist.contains(&format!("<string>{}</string>", proto::HELPER_LABEL)));
        assert!(plist.contains("<string>Contents/MacOS/rig-doctor-helper</string>"));
        assert!(plist.contains(&format!("<string>{}</string>", proto::APP_ID)));
        let overlay: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join("tauri.helper.conf.json")).unwrap()).unwrap();
        assert_eq!(overlay["bundle"]["externalBin"][0], "binaries/rig-doctor-helper");
        let files = overlay["bundle"]["macOS"]["files"].as_object().unwrap();
        assert_eq!(files[&format!("Library/LaunchDaemons/{}", proto::HELPER_PLIST)], format!("macos/{}", proto::HELPER_PLIST));
    }
}
