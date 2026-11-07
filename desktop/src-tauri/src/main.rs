// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started by the peak-hour scheduled task: one sample, no window.
    if std::env::args().any(|a| a == "--peak-sample") {
        std::process::exit(rig_doctor_globe_lib::peak::sample_cli());
    }
    rig_doctor_globe_lib::run()
}
