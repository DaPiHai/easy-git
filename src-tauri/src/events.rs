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
