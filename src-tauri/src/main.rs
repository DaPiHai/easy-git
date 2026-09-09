// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// WSLg ships a software-rendering compositing stack whose accelerated
/// WebKit path inflates the renderer by ~150 MB (and breaks screenshot
/// capture). Disable accelerated compositing only there; real Linux desktops
/// keep their normal path. Must run before the first webview is created.
#[cfg(target_os = "linux")]
fn apply_wslg_workarounds() {
    let wsl = std::env::var("WSL_DISTRO_NAME").is_ok()
        || std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .map(|v| v.to_lowercase().contains("microsoft"))
            .unwrap_or(false);
    if wsl {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }
}

#[cfg(not(target_os = "linux"))]
fn apply_wslg_workarounds() {}

fn main() {
    apply_wslg_workarounds();
    easy_git::run()
}
