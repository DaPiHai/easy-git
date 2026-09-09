//! `repo://changed` fs-watch event (TDD §4.6, m1-plan R-03).
//! Lives in the app crate because the tauri-specta `Event` derive pulls in
//! tauri; DTO shapes used by commands stay in eg-types. The wire name is
//! pinned to `repo://changed` per TDD §4.6.

use specta::Type;

/// The frontend refreshes status for `repo_id` (debounced 300ms upstream).
#[derive(Debug, Clone, serde::Serialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "repo://changed")]
pub struct RepoChanged {
    pub repo_id: String,
}

impl RepoChanged {
    pub fn new(repo_id: impl Into<String>) -> Self {
        Self {
            repo_id: repo_id.into(),
        }
    }
}

/// Sync task strip progress (m1-plan R-22/F-27): network operations stream
/// their `git --progress` lines here. `percent` is Some when parseable.
#[derive(Debug, Clone, serde::Serialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "sync://progress")]
pub struct SyncProgressEvent {
    pub repo_id: String,
    /// fetch | pull | push | clone | test
    pub task: String,
    pub message: String,
    pub percent: Option<u32>,
    /// Final event of the task (strip may clear afterwards).
    pub done: bool,
}

impl SyncProgressEvent {
    pub fn new(
        repo_id: impl Into<String>,
        task: impl Into<String>,
        message: impl Into<String>,
        percent: Option<u32>,
        done: bool,
    ) -> Self {
        Self {
            repo_id: repo_id.into(),
            task: task.into(),
            message: message.into(),
            percent,
            done,
        }
    }
}
