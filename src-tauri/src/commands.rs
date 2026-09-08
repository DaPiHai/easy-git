use std::path::Path;
use std::sync::Arc;

use eg_git_core::worker::{ChangeSink, DiscardOutcome};
use eg_git_core::RepoManager;
use eg_safety::Safety;
use eg_types::{AppVersion, EgError, IgnoreMode, RepoSummary, StageMode, StatusReport};
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
    run_blocking(move || handle.request_status()).await
}

/// Stages or unstages whole files and returns the fresh status (m1-plan R-05).
#[tauri::command]
#[specta::specta]
pub async fn stage(
    manager: State<'_, RepoManager>,
    repo_id: String,
    paths: Vec<String>,
    mode: StageMode,
) -> Result<StatusReport, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.stage(paths, mode)).await
}

/// Discard behind a safety snapshot; returns fresh status + the op id for the
/// 撤销 toast (m1-plan R-05, AGENTS.md 红线).
#[tauri::command]
#[specta::specta]
pub async fn discard_changes(
    manager: State<'_, RepoManager>,
    safety: State<'_, Safety>,
    repo_id: String,
    paths: Vec<String>,
) -> Result<DiscardOutcome, EgError> {
    let handle = manager.get(&repo_id)?;
    let safety = std::sync::Arc::new(safety.inner().clone());
    run_blocking(move || handle.discard(paths, safety)).await
}

/// Lists untracked entries for the clean confirmation dialog (m1-plan R-06).
#[tauri::command]
#[specta::specta]
pub async fn clean_preview(
    manager: State<'_, RepoManager>,
    repo_id: String,
) -> Result<Vec<String>, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.clean_preview()).await
}

/// Snapshot-guarded cleanup of untracked paths (m1-plan R-06); returns the
/// fresh status plus the op id for the 撤销 toast.
#[tauri::command]
#[specta::specta]
pub async fn clean_execute(
    manager: State<'_, RepoManager>,
    safety: State<'_, Safety>,
    repo_id: String,
    paths: Vec<String>,
) -> Result<DiscardOutcome, EgError> {
    let handle = manager.get(&repo_id)?;
    let safety = std::sync::Arc::new(safety.inner().clone());
    run_blocking(move || handle.clean_execute(paths, safety)).await
}

/// Appends ignore rules to .gitignore (m1-plan F-10).
#[tauri::command]
#[specta::specta]
pub async fn ignore_paths(
    manager: State<'_, RepoManager>,
    repo_id: String,
    paths: Vec<String>,
    mode: IgnoreMode,
) -> Result<StatusReport, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.ignore(paths, mode)).await
}

/// Restores the pre-operation content of a discard/clean (m1-plan W3).
#[tauri::command]
#[specta::specta]
pub async fn undo_operation(
    manager: State<'_, RepoManager>,
    safety: State<'_, Safety>,
    repo_id: String,
    op_id: String,
) -> Result<StatusReport, EgError> {
    let handle = manager.get(&repo_id)?;
    let safety = std::sync::Arc::new(safety.inner().clone());
    run_blocking(move || handle.undo(op_id, safety)).await
}

async fn run_blocking<T, F>(f: F) -> Result<T, EgError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, EgError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| EgError::Internal {
            context: format!("worker task join failed: {e}"),
        })?
}
