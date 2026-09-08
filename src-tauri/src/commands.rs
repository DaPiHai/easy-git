use eg_types::{AppVersion, EgError};

/// Sample command proving the tauri-specta pipeline end to end (F-01).
/// The real command surface (TDD §4.6) lands from W2 (R-01/R-02) onwards.
#[tauri::command]
#[specta::specta]
pub fn app_version() -> Result<AppVersion, EgError> {
    Ok(AppVersion {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        tauri_version: tauri::VERSION.to_string(),
        os: std::env::consts::OS.to_string(),
    })
}
