//! Rig Doctor Globe's macOS privileged helper.
//!
//! The app registers it with SMAppService as a launch daemon bundled in the signed app
//! (Contents/MacOS/rig-doctor-helper, plist in Contents/Library/LaunchDaemons). The user approves it
//! once in System Settings > General > Login Items. After that it runs as root and turns the relay
//! tunnel on and off with Homebrew's wg-quick, so On and Off no longer ask for a password.
//!
//! It serves one Unix socket and only answers a process signed as the app by the same Apple team
//! as itself, checked from the connection's audit token. It never runs the user's config file:
//! every config is parsed with the app's own rules (no PostUp hooks, no DNS, no default route),
//! re-rendered, and written to a root-only folder before wg-quick sees it.

#[path = "../../src-tauri/src/wgconf.rs"]
#[allow(dead_code)]
mod wgconf;

#[path = "../../src-tauri/src/helper_proto.rs"]
#[allow(dead_code)]
mod helper_proto;

mod request;

#[cfg(target_os = "macos")]
mod mac;

fn main() {
    #[cfg(target_os = "macos")]
    std::process::exit(mac::serve());
    #[cfg(not(target_os = "macos"))]
    {
        eprintln!("rig-doctor-helper only runs on macOS.");
        std::process::exit(1);
    }
}
