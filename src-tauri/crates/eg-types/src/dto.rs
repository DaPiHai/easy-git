//! IPC DTOs (TDD §4.6). Wire format is camelCase to keep the generated TS
//! bindings idiomatic.

use serde::Serialize;
use specta::Type;

/// Answer to the pipeline-proving `app_version` command (m1-plan F-01).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppVersion {
    pub app_version: String,
    pub tauri_version: String,
    pub os: String,
}
