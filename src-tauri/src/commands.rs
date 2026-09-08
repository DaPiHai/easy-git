use std::path::Path;
use std::sync::Arc;

use eg_git_core::worker::ChangeSink;
use eg_git_core::RepoManager;
use eg_types::{AppVersion, EgError, RepoSummary, StatusReport};
use tauri::{AppHandle, State};
use tauri_specta::Event;

use crate::events::RepoChanged;

/// Sample command proving the tauri-specta pipeline end to end (F-01).
#[tauri::command]
#[specta::specta]
pub fn app_version() -> Result<AppVersion, EgError> {
    Ok(AppVersion {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        tauri_version: tauri::VERSION.to_string(),
        os: std::env::consts::OS.to_string(),
    })
}

fn change_sink(app: &AppHandle) -> ChangeSink {
    let handle = app.clone();
    Arc::new(move |repo_id| {
        // The window may be gone during shutdown; emission errors are moot.
        let _ = RepoChanged::new(repo_id).emit(&handle);
    })
}

/// Opens (or focuses) the repository at `path` and starts its fs-watch worker
/// (m1-plan R-01/R-03).
#[tauri::command]
#[specta::specta]
pub fn repo_open(
    app: AppHandle,
    manager: State<'_, RepoManager>,
    path: String,
) -> Result<RepoSummary, EgError> {
    manager.open(Path::new(&path), change_sink(&app))
}

/// `git init` at `path`; opening an existing repository is idempotent
/// (m1-plan F-06 新建入口).
#[tauri::command]
#[specta::specta]
pub fn repo_init(
    app: AppHandle,
    manager: State<'_, RepoManager>,
    path: String,
) -> Result<RepoSummary, EgError> {
    let target = Path::new(&path);
    eg_git_core::repo::init(target)?;
    manager.open(target, change_sink(&app))
}

/// Closes the repository worker and stops watching its worktree.
#[tauri::command]
#[specta::specta]
pub fn repo_close(manager: State<'_, RepoManager>, repo_id: String) -> Result<(), EgError> {
    manager.close(&repo_id);
    Ok(())
}

/// Three-zone working-tree status; runs on the repo worker thread off the
/// IPC path (m1-plan R-02).
#[tauri::command]
#[specta::specta]
pub async fn status_get(
    manager: State<'_, RepoManager>,
    repo_id: String,
) -> Result<StatusReport, EgError> {
    let handle = manager.get(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || handle.request_status())
        .await
        .map_err(|e| EgError::Internal {
            context: format!("status task join failed: {e}"),
        })?
}
