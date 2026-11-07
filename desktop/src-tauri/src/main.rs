// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started by the peak-hour scheduled task: one sample, no window.
    if std::env::args().any(|a| a == "--peak-sample") {
        std::process::exit(rig_doctor_globe_lib::peak::sample_cli());
    }
    // Terminal control of the relay tunnel: --relay import FILE | up | down | status | ping.
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--relay") {
        std::process::exit(rig_doctor_globe_lib::relay::cli(&args[i + 1..]));
    }
    rig_doctor_globe_lib::run()
}
