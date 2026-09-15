use std::path::{Path, PathBuf};
use std::sync::Arc;

use eg_git_core::worker::{ChangeSink, DiscardOutcome};
use eg_git_core::RepoManager;
use eg_safety::Safety;
use eg_types::{
    AppVersion, BranchInfo, CommitDetail, CommitOutcome, CommitRequest, ConfigScope, ConflictFile,
    DiffRequest, DiffResponse, EgError, EnvStatus, IgnoreMode, LogFilter, LogPage, MergeOutcome,
    MergeState, PushCredentials, RemoteInfo, RepoSummary, ResetMode, ResetOutcome,
    SshCredentialsOverview, StageLinesRequest, StageMode, StashEntry, StatusReport, SyncStrategy,
    TagInfo, TimelineEntry, UndoRedoState,
};
use tauri::{AppHandle, State};
use tauri_specta::Event;

use crate::events::{RepoChanged, SyncProgressEvent};

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

/// Startup environment probe (PRD §7: 检测系统 git ≥ 2.30，缺失时引导安装).
/// `git_version` is None when no usable git answers on PATH; the frontend
/// guides the user through installing git instead of failing later with raw
/// spawn errors.
#[tauri::command]
#[specta::specta]
pub fn env_check() -> Result<EnvStatus, EgError> {
    Ok(eg_git_core::env::env_status())
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
    let summary = manager.open(Path::new(&path), change_sink(&app));
    match &summary {
        Ok(s) => tracing::info!(repo = %s.repo_id, path = %path, branch = ?s.branch, "repo opened"),
        Err(e) => tracing::warn!(path = %path, error = ?e, "repo open failed"),
    }
    summary
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
    let summary = manager.open(target, change_sink(&app));
    match &summary {
        Ok(s) => tracing::info!(repo = %s.repo_id, path = %path, "repo initialized"),
        Err(e) => tracing::warn!(path = %path, error = ?e, "repo open after init failed"),
    }
    summary
}

/// Closes the repository worker and stops watching its worktree.
#[tauri::command]
#[specta::specta]
pub fn repo_close(manager: State<'_, RepoManager>, repo_id: String) -> Result<(), EgError> {
    manager.close(&repo_id);
    tracing::info!(repo = %repo_id, "repo closed");
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

/// True when the repository workdir has no `.gitignore` (通用模板提醒依据).
#[tauri::command]
#[specta::specta]
pub async fn gitignore_missing(
    manager: State<'_, RepoManager>,
    repo_id: String,
) -> Result<bool, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.gitignore_missing()).await
}

/// Writes the generic .gitignore template when absent; returns whether the
/// file was created (an existing .gitignore is never touched).
#[tauri::command]
#[specta::specta]
pub async fn gitignore_write(
    manager: State<'_, RepoManager>,
    repo_id: String,
) -> Result<bool, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.gitignore_write_template()).await
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

/// Reads one global config key without an open repository (F-14). Machine
/// level settings such as the commit identity must be editable from the
/// settings page before any repository is open, so this bypasses RepoWorker.
#[tauri::command]
#[specta::specta]
pub async fn global_config_get(key: String) -> Result<Option<String>, EgError> {
    run_blocking(move || eg_git_core::config::config_get(None, ConfigScope::Global, &key)).await
}

/// Writes one global config key without an open repository (F-14).
#[tauri::command]
#[specta::specta]
pub async fn global_config_set(key: String, value: String) -> Result<(), EgError> {
    run_blocking(move || eg_git_core::config::config_set(None, ConfigScope::Global, &key, &value))
        .await
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

/// Streams `git --progress` lines from a blocking network task to the sync
/// task strip, then emits the final event (m1-plan R-22/F-27).
fn sync_progress_sink(
    app: &AppHandle,
    repo_id: String,
    task: &'static str,
) -> (
    std::sync::mpsc::Sender<eg_git_core::remote::SyncProgress>,
    tauri::async_runtime::JoinHandle<()>,
) {
    let handle = app.clone();
    let (tx, rx) = std::sync::mpsc::channel::<eg_git_core::remote::SyncProgress>();
    let join = tauri::async_runtime::spawn(async move {
        while let Ok(progress) = rx.recv() {
            let _ = SyncProgressEvent::new(
                repo_id.clone(),
                task,
                progress.message,
                progress.percent,
                false,
            )
            .emit(&handle);
        }
    });
    (tx, join)
}

async fn finish_progress_sink(
    app: &AppHandle,
    repo_id: String,
    task: &'static str,
    join: tauri::async_runtime::JoinHandle<()>,
    ok: bool,
) {
    let _ = SyncProgressEvent::new(repo_id, task, if ok { "完成" } else { "失败" }, None, true)
        .emit(app);
    let _ = join.await;
}

/// Fetches a remote (m1-plan R-22): CLI with live progress, then a worker
/// status refresh (fs-watch also fires from the ref updates). SSH remotes run
/// the fetch over the SSH channel via the handle dispatch.
#[tauri::command]
#[specta::specta]
pub async fn sync_fetch(
    app: AppHandle,
    manager: State<'_, RepoManager>,
    repo_id: String,
    remote: String,
    prune: bool,
) -> Result<StatusReport, EgError> {
    let handle = manager.get(&repo_id)?;
    let (tx, join) = sync_progress_sink(&app, repo_id.clone(), "fetch");
    let result = run_blocking(move || handle.sync_fetch(&remote, prune, Some(&tx))).await;
    finish_progress_sink(&app, repo_id.clone(), "fetch", join, result.is_ok()).await;
    result?;
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.request_status()).await
}

/// Pulls (R-22/F-27): CLI fetch with progress, then the W8 merge machinery
/// integrates the upstream — conflicts land in the wizard, ff-only refuses
/// divergence so the 分叉情况选择 can offer a merge.
#[tauri::command]
#[specta::specta]
pub async fn sync_pull(
    app: AppHandle,
    manager: State<'_, RepoManager>,
    repo_id: String,
    remote: String,
    branch: String,
    strategy: SyncStrategy,
) -> Result<MergeOutcome, EgError> {
    let handle = manager.get(&repo_id)?;
    let (tx, join) = sync_progress_sink(&app, repo_id.clone(), "pull");
    let fetch_remote = remote.clone();
    let fetched = run_blocking(move || handle.sync_fetch(&fetch_remote, false, Some(&tx))).await;
    finish_progress_sink(&app, repo_id.clone(), "pull", join, fetched.is_ok()).await;
    fetched?;
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.pull_integrate(remote, branch, strategy)).await
}

/// Pushes the current branch (R-22). Force pushes record the pre-push remote
/// tip in eg-safety first (强推可回滚): undo pushes the old tip back.
///
/// `credentials` is the optional one-shot HTTPS user/password for legacy
/// servers; None keeps the ambient system helpers. It is never logged.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn sync_push(
    app: AppHandle,
    manager: State<'_, RepoManager>,
    safety: State<'_, Safety>,
    repo_id: String,
    remote: String,
    branch: String,
    force: bool,
    credentials: Option<eg_types::PushCredentials>,
) -> Result<StatusReport, EgError> {
    let handle = manager.get(&repo_id)?;
    let safety = std::sync::Arc::new(safety.inner().clone());
    let (tx, join) = sync_progress_sink(&app, repo_id.clone(), "push");
    let safety_for_task = safety.clone();
    let push_repo_id = repo_id.clone();
    let result = run_blocking(move || {
        handle.sync_push(
            &push_repo_id,
            &remote,
            &branch,
            force,
            &safety_for_task,
            Some(&tx),
            credentials.as_ref(),
        )
    })
    .await;
    finish_progress_sink(&app, repo_id.clone(), "push", join, result.is_ok()).await;
    result?;
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.request_status()).await
}

/// Connectivity test (R-24): `git ls-remote`, reports ref count.
#[tauri::command]
#[specta::specta]
pub async fn remote_test(
    app: AppHandle,
    manager: State<'_, RepoManager>,
    repo_id: String,
    remote: String,
) -> Result<u32, EgError> {
    let handle = manager.get(&repo_id)?;
    let (tx, join) = sync_progress_sink(&app, repo_id.clone(), "test");
    let result = run_blocking(move || handle.test_remote(&remote, Some(&tx))).await;
    finish_progress_sink(&app, repo_id, "test", join, result.is_ok()).await;
    result
}

/// Clones a repository (W2 顺延 + m1-plan R-22), then opens it (F-06 clone 入口).
/// `credentials` is an optional session-only askpass fallback for private
/// servers (same contract as `sync_push`); never persisted, never logged.
#[tauri::command]
#[specta::specta]
pub async fn repo_clone(
    app: AppHandle,
    manager: State<'_, RepoManager>,
    url: String,
    path: String,
    credentials: Option<PushCredentials>,
) -> Result<RepoSummary, EgError> {
    let (tx, join) = sync_progress_sink(&app, "clone".to_string(), "clone");
    let clone_path = path.clone();
    let clone_url = url.clone();
    let result = run_blocking(move || {
        eg_git_core::remote::clone_repo(
            &clone_url,
            std::path::Path::new(&clone_path),
            Some(&tx),
            credentials.as_ref(),
        )
    })
    .await;
    finish_progress_sink(&app, "clone".to_string(), "clone", join, result.is_ok()).await;
    match &result {
        Ok(()) => {
            tracing::info!(url = %eg_types::sensitive::redact_url(&url), path = %path, "clone finished")
        }
        Err(e) => tracing::warn!(
            url = %eg_types::sensitive::redact_url(&url),
            path = %path,
            error = ?e,
            "clone failed"
        ),
    }
    result?;
    let summary = manager.open(std::path::Path::new(&path), change_sink(&app));
    if let Ok(s) = &summary {
        tracing::info!(repo = %s.repo_id, path = %path, "cloned repo opened");
    }
    summary
}

/// Tests an SSH repository location (SSH wizard 连通性测试): connectivity
/// plus `probe_repo`, the same validation `repo_open` runs. Accepts the same
/// `ssh://…` / `user@host:path` forms. Returns the canonical URI on success.
///
/// Deliberately as strict as open: a host that connects but has no repository
/// at the path must fail HERE (真机: `echo ok` passed for `/`, then open
/// failed with "not a git repository").
#[tauri::command]
#[specta::specta]
pub async fn ssh_test_connection(location: String) -> Result<String, EgError> {
    let target = eg_types::parse_ssh_target(&location).ok_or_else(|| EgError::Internal {
        context: format!("不是有效的 SSH 地址：{location}"),
    })?;
    run_blocking(move || {
        eg_git_core::ssh::test_connection(&target, None)?;
        eg_git_core::ssh::probe_repo(&target, None)?;
        Ok(target.uri())
    })
    .await
}

/// Initializes a Git repository on the SSH host at `location`. Offered by
/// the wizard when `repo_open` rejects a path with `SshNotARepo` because the
/// directory exists but has no `.git` (a missing directory stays an error —
/// no silent path creation).
#[tauri::command]
#[specta::specta]
pub async fn ssh_init_repo(location: String) -> Result<(), EgError> {
    let target = eg_types::parse_ssh_target(&location).ok_or_else(|| EgError::Internal {
        context: format!("不是有效的 SSH 地址：{location}"),
    })?;
    run_blocking(move || eg_git_core::ssh::ssh_init(&target)).await
}

/// Lists a directory on an SSH host (SSH wizard 远端目录浏览). `dir` must be
/// absolute or `~/`-relative; entries are bare names (`-p` marks dirs).
#[tauri::command]
#[specta::specta]
pub async fn ssh_browse_dir(location: String, dir: String) -> Result<Vec<String>, EgError> {
    let mut target = eg_types::parse_ssh_target(&location).ok_or_else(|| EgError::Internal {
        context: format!("不是有效的 SSH 地址：{location}"),
    })?;
    // The browse dir overrides the location path when the user navigates.
    target.path = dir.clone();
    run_blocking(move || eg_git_core::ssh::browse_dir(&target, &dir, None)).await
}

/// Reads the local ssh-agent state and `~/.ssh/*.pub` for the settings
/// "管理凭据" section. Read-only — no private keys, no remote calls.
#[tauri::command]
#[specta::specta]
pub async fn ssh_credentials_overview() -> Result<SshCredentialsOverview, EgError> {
    run_blocking(eg_git_core::ssh::ssh_credentials_overview).await
}

#[tauri::command]
#[specta::specta]
pub async fn remote_list(
    manager: State<'_, RepoManager>,
    repo_id: String,
) -> Result<Vec<RemoteInfo>, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.remote_list()).await
}

/// Adds a remote (R-24); the summary refreshes via fs-watch.
#[tauri::command]
#[specta::specta]
pub async fn remote_add(
    manager: State<'_, RepoManager>,
    repo_id: String,
    name: String,
    url: String,
) -> Result<(), EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.remote_add(name, url)).await
}

#[tauri::command]
#[specta::specta]
pub async fn remote_rename(
    manager: State<'_, RepoManager>,
    repo_id: String,
    old_name: String,
    new_name: String,
) -> Result<(), EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.remote_rename(old_name, new_name).map(|_| ())).await
}

#[tauri::command]
#[specta::specta]
pub async fn remote_remove(
    manager: State<'_, RepoManager>,
    repo_id: String,
    name: String,
) -> Result<(), EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.remote_remove(name)).await
}

#[tauri::command]
#[specta::specta]
pub async fn remote_set_url(
    manager: State<'_, RepoManager>,
    repo_id: String,
    name: String,
    url: String,
) -> Result<(), EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.remote_set_url(name, url)).await
}

/// Redoes the most recent undone operation (R-25 撤销/重做引擎).
#[tauri::command]
#[specta::specta]
pub async fn redo_operation(
    manager: State<'_, RepoManager>,
    safety: State<'_, Safety>,
    repo_id: String,
) -> Result<DiscardOutcome, EgError> {
    let handle = manager.get(&repo_id)?;
    let safety = std::sync::Arc::new(safety.inner().clone());
    run_blocking(move || handle.redo(safety)).await
}

/// 操作时间线 (m1-plan F-28): reflog + safety op log merged, newest first.
#[tauri::command]
#[specta::specta]
pub async fn timeline_get(
    manager: State<'_, RepoManager>,
    safety: State<'_, Safety>,
    repo_id: String,
    limit: Option<u32>,
) -> Result<Vec<TimelineEntry>, EgError> {
    let handle = manager.get(&repo_id)?;
    let safety = std::sync::Arc::new(safety.inner().clone());
    run_blocking(move || handle.timeline(limit.unwrap_or(100), safety)).await
}

/// 恢复到此状态 (F-28): snapshot-protected hard reset to a timeline entry.
#[tauri::command]
#[specta::specta]
pub async fn timeline_restore(
    manager: State<'_, RepoManager>,
    safety: State<'_, Safety>,
    repo_id: String,
    oid: String,
) -> Result<ResetOutcome, EgError> {
    let handle = manager.get(&repo_id)?;
    let safety = std::sync::Arc::new(safety.inner().clone());
    run_blocking(move || handle.restore_to(oid, safety)).await
}

/// Sets (or clears) a branch's upstream (W7 顺延, m1-plan W9).
#[tauri::command]
#[specta::specta]
pub async fn branch_set_upstream(
    manager: State<'_, RepoManager>,
    repo_id: String,
    branch: String,
    upstream: Option<String>,
) -> Result<BranchInfo, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.branch_set_upstream(branch, upstream)).await
}

/// Bottom-bar 撤销/重做 availability (m1-plan R-25).
#[tauri::command]
#[specta::specta]
pub async fn undo_redo_state(
    manager: State<'_, RepoManager>,
    safety: State<'_, Safety>,
    repo_id: String,
) -> Result<UndoRedoState, EgError> {
    let handle = manager.get(&repo_id)?;
    let safety = std::sync::Arc::new(safety.inner().clone());
    run_blocking(move || handle.undo_state(safety)).await
}

/// Remote branch short names for the set-upstream dialog.
#[tauri::command]
#[specta::specta]
pub async fn remote_branch_list(
    manager: State<'_, RepoManager>,
    repo_id: String,
) -> Result<Vec<String>, EgError> {
    let handle = manager.get(&repo_id)?;
    run_blocking(move || handle.remote_branch_list()).await
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

// ---------------------------------------------------------------------------
// Log file access (in-app viewer, frontend exception entry) — TDD §1 file sink.
// ---------------------------------------------------------------------------

fn app_logs_dir(app: &AppHandle) -> Result<PathBuf, EgError> {
    use tauri::Manager;
    let app_data = app.path().app_data_dir().map_err(|e| EgError::Internal {
        context: format!("app data dir unavailable: {e}"),
    })?;
    Ok(crate::logs::logs_dir(&app_data))
}

/// Absolute path of the rolling log directory (viewer header + 打开文件夹).
#[tauri::command]
#[specta::specta]
pub fn logs_dir(app: AppHandle) -> Result<String, EgError> {
    Ok(app_logs_dir(&app)?.to_string_lossy().into_owned())
}

/// Rolling log files, newest first (viewer file picker).
#[tauri::command]
#[specta::specta]
pub fn logs_list(app: AppHandle) -> Result<Vec<crate::logs::LogFileInfo>, EgError> {
    Ok(crate::logs::list_log_files(&app_logs_dir(&app)?))
}

/// Tail of one log file (viewer content pane).
#[tauri::command]
#[specta::specta]
pub fn logs_read(
    app: AppHandle,
    file_name: String,
    max_bytes: Option<u32>,
) -> Result<crate::logs::LogContent, EgError> {
    let dir = app_logs_dir(&app)?;
    crate::logs::read_log_tail(
        &dir,
        &file_name,
        max_bytes.unwrap_or(crate::logs::MAX_READ_BYTES),
    )
    .map_err(|e| EgError::Internal {
        context: format!("log read failed: {e}"),
    })
}

/// Frontend-originated log line (window errors, manual appLog calls). Routed
/// through tracing so web lines share the file sink; best-effort by design.
#[tauri::command]
#[specta::specta]
pub fn log_write(level: String, scope: String, message: String) -> Result<(), EgError> {
    crate::logs::write_web_log(&level, &scope, &message);
    Ok(())
}
