use std::path::Path;
use std::sync::Arc;

use eg_git_core::worker::{ChangeSink, DiscardOutcome};
use eg_git_core::RepoManager;
use eg_safety::Safety;
use eg_types::{
    AppVersion, BranchInfo, CommitDetail, CommitOutcome, CommitRequest, ConfigScope, ConflictFile,
    DiffRequest, DiffResponse, EgError, IgnoreMode, LogFilter, LogPage, MergeOutcome, MergeState,
    RepoSummary, ResetMode, ResetOutcome, StageLinesRequest, StageMode, StashEntry, StatusReport,
    TagInfo,
};
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

/// Commits the index (or amends); rejects partial staging unless confirmed
/// (m1-plan R-07 / F-12).
#[tauri::command]
#[specta::specta]
pub async fn commit(
    manager: State<'_, RepoManager>,
    repo_id: String,
    request: CommitRequest,
) -> Result<CommitOutcome, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.commit(request)).await
}

/// Reads one config key in the repo or global scope (m1-plan R-09 / F-14).
#[tauri::command]
#[specta::specta]
pub async fn config_get(
    manager: State<'_, RepoManager>,
    repo_id: String,
    scope: ConfigScope,
    key: String,
) -> Result<Option<String>, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.config_get(scope, key)).await
}

/// Writes one config key in the repo or global scope (m1-plan R-09 / F-14).
#[tauri::command]
#[specta::specta]
pub async fn config_set(
    manager: State<'_, RepoManager>,
    repo_id: String,
    scope: ConfigScope,
    key: String,
    value: String,
) -> Result<(), EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.config_set(scope, key, value)).await
}

/// One page of the lane-annotated history log (m1-plan R-10 / F-15).
#[tauri::command]
#[specta::specta]
pub async fn log_page(
    manager: State<'_, RepoManager>,
    repo_id: String,
    offset: u32,
    limit: u32,
    filter: LogFilter,
) -> Result<LogPage, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.log_page(offset, limit, filter)).await
}

/// Commit detail with changed files (m1-plan F-16).
#[tauri::command]
#[specta::specta]
pub async fn commit_detail(
    manager: State<'_, RepoManager>,
    repo_id: String,
    oid: String,
) -> Result<CommitDetail, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.commit_detail(oid)).await
}

/// Local branch short names, current first (m1-plan F-17).
#[tauri::command]
#[specta::specta]
pub async fn list_branches(
    manager: State<'_, RepoManager>,
    repo_id: String,
) -> Result<Vec<String>, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.list_branches()).await
}

/// One file's unified diff (m1-plan R-12 / F-18).
#[tauri::command]
#[specta::specta]
pub async fn diff_file(
    manager: State<'_, RepoManager>,
    repo_id: String,
    request: DiffRequest,
) -> Result<DiffResponse, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.diff_file(request)).await
}

/// Hunk/line-level staging into the index (m1-plan R-13 / F-19).
#[tauri::command]
#[specta::specta]
pub async fn stage_lines(
    manager: State<'_, RepoManager>,
    repo_id: String,
    request: StageLinesRequest,
) -> Result<StatusReport, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.stage_lines(request)).await
}

/// Branch board data (m1-plan F-21 / R-15).
#[tauri::command]
#[specta::specta]
pub async fn branch_list(
    manager: State<'_, RepoManager>,
    repo_id: String,
) -> Result<Vec<BranchInfo>, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.branch_list()).await
}

/// Creates a branch at HEAD or the given commit (m1-plan R-15).
#[tauri::command]
#[specta::specta]
pub async fn branch_create(
    manager: State<'_, RepoManager>,
    repo_id: String,
    name: String,
    oid: Option<String>,
) -> Result<BranchInfo, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.branch_create(name, oid)).await
}

/// Renames a branch (m1-plan R-15); renaming the current one moves HEAD.
#[tauri::command]
#[specta::specta]
pub async fn branch_rename(
    manager: State<'_, RepoManager>,
    repo_id: String,
    old_name: String,
    new_name: String,
) -> Result<(), EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.branch_rename(old_name, new_name)).await
}

/// Deletes a branch into the recycle bin (m1-plan R-16); returns the op id
/// for the 撤销 toast.
#[tauri::command]
#[specta::specta]
pub async fn branch_delete(
    manager: State<'_, RepoManager>,
    safety: State<'_, Safety>,
    repo_id: String,
    name: String,
) -> Result<String, EgError> {
    let handle = manager.get(&repo_id)?;
    let safety = std::sync::Arc::new(safety.inner().clone());
    run_blocking(move || handle.branch_delete(name, safety)).await
}

/// Switches branches (m1-plan R-15); rejects a dirty worktree.
#[tauri::command]
#[specta::specta]
pub async fn branch_switch(
    manager: State<'_, RepoManager>,
    repo_id: String,
    name: String,
) -> Result<StatusReport, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.branch_switch(name)).await
}

/// Tag list (m1-plan R-17).
#[tauri::command]
#[specta::specta]
pub async fn tag_list(
    manager: State<'_, RepoManager>,
    repo_id: String,
) -> Result<Vec<TagInfo>, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.tag_list()).await
}

/// Creates a lightweight or annotated tag (m1-plan R-17).
#[tauri::command]
#[specta::specta]
pub async fn tag_create(
    manager: State<'_, RepoManager>,
    repo_id: String,
    name: String,
    oid: String,
    message: Option<String>,
) -> Result<TagInfo, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.tag_create(name, oid, message)).await
}

/// Deletes a tag into the recycle bin (m1-plan R-17); returns the op id.
#[tauri::command]
#[specta::specta]
pub async fn tag_delete(
    manager: State<'_, RepoManager>,
    safety: State<'_, Safety>,
    repo_id: String,
    name: String,
) -> Result<String, EgError> {
    let handle = manager.get(&repo_id)?;
    let safety = std::sync::Arc::new(safety.inner().clone());
    run_blocking(move || handle.tag_delete(name, safety)).await
}

/// Stash list (m1-plan R-18 / F-22).
#[tauri::command]
#[specta::specta]
pub async fn stash_list(
    manager: State<'_, RepoManager>,
    repo_id: String,
) -> Result<Vec<StashEntry>, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.stash_list()).await
}

/// Stashes worktree + index; untracked files optional (m1-plan R-18).
#[tauri::command]
#[specta::specta]
pub async fn stash_push(
    manager: State<'_, RepoManager>,
    repo_id: String,
    message: Option<String>,
    include_untracked: bool,
) -> Result<StatusReport, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.stash_push(message, include_untracked)).await
}

/// Applies (and with `pop` drops) a stash entry (m1-plan R-18).
#[tauri::command]
#[specta::specta]
pub async fn stash_apply(
    manager: State<'_, RepoManager>,
    repo_id: String,
    index: u32,
    pop: bool,
) -> Result<StatusReport, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.stash_apply(index, pop)).await
}

/// Drops a stash entry after explicit confirmation (m1-plan R-18).
#[tauri::command]
#[specta::specta]
pub async fn stash_drop(
    manager: State<'_, RepoManager>,
    repo_id: String,
    index: u32,
) -> Result<Vec<StashEntry>, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.stash_drop(index)).await
}

/// Starts merging `name` into the current branch (m1-plan R-19). A conflicted
/// merge parks itself (`MERGE_HEAD` + conflict index) and reports its files.
#[tauri::command]
#[specta::specta]
pub async fn merge_start(
    manager: State<'_, RepoManager>,
    repo_id: String,
    name: String,
    no_ff: bool,
) -> Result<MergeOutcome, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.merge_start(name, no_ff)).await
}

/// Merge progress while parked on conflicts (m1-plan R-19 / F-24).
#[tauri::command]
#[specta::specta]
pub async fn merge_state(
    manager: State<'_, RepoManager>,
    repo_id: String,
) -> Result<Option<MergeState>, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.merge_state()).await
}

/// Aborts a parked merge and hard-resets to the pre-merge state (R-19).
#[tauri::command]
#[specta::specta]
pub async fn merge_abort(
    manager: State<'_, RepoManager>,
    repo_id: String,
) -> Result<StatusReport, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.merge_abort()).await
}

/// Conflicted files with three-stage contents and parsed blocks (R-21 / F-24).
#[tauri::command]
#[specta::specta]
pub async fn conflicts_get(
    manager: State<'_, RepoManager>,
    repo_id: String,
) -> Result<Vec<ConflictFile>, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.conflicts_get()).await
}

/// Writes one resolved conflict file and stages it (m1-plan R-21).
#[tauri::command]
#[specta::specta]
pub async fn conflict_resolve(
    manager: State<'_, RepoManager>,
    repo_id: String,
    path: String,
    content: String,
) -> Result<StatusReport, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.conflict_resolve(path, content)).await
}

/// Reverts the given commits into the index + worktree (m1-plan R-20).
#[tauri::command]
#[specta::specta]
pub async fn revert_commits(
    manager: State<'_, RepoManager>,
    repo_id: String,
    oids: Vec<String>,
) -> Result<StatusReport, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.revert(oids)).await
}

/// Resets to `target` with the three git modes (m1-plan R-20). Hard resets
/// snapshot first and return an op id for the 撤销 toast.
#[tauri::command]
#[specta::specta]
pub async fn reset_commits(
    manager: State<'_, RepoManager>,
    safety: State<'_, Safety>,
    repo_id: String,
    mode: ResetMode,
    target: Option<String>,
) -> Result<ResetOutcome, EgError> {
    let handle = manager.get(&repo_id)?;
    let safety = std::sync::Arc::new(safety.inner().clone());
    run_blocking(move || handle.reset(mode, target, safety)).await
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
