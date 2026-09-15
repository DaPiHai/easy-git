//! Per-repository worker threads (TDD §4.1, m1-plan R-01) with fs-watch and
//! a 300ms debounce feeding the `repo://changed` event (R-03).
//!
//! `git2::Repository` is neither `Sync` nor shareable across threads, so each
//! open repository owns one thread that holds it for its whole lifetime.
//! Commands travel through an mpsc queue and execute strictly in order, which
//! removes lock contention by construction. The notify watcher lives on the
//! worker too; filesystem events coalesce here so the frontend receives at
//! most one `repo://changed` per quiet period.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use eg_types::{ConfigScope, EgError, IgnoreMode, RepoId, RepoSummary, StageMode, StatusReport};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use uuid::Uuid;

use super::{
    commit, config, conflicts, diff, log, merge, ops, refs, remote, repo, ssh_backend, stash,
    status, timeline,
};

/// Quiet period before a burst of filesystem events triggers one change event.
pub const FS_DEBOUNCE: Duration = Duration::from_millis(300);

/// How long a repo must be idle (no commands, no pending user work) before a
/// silent `gc --auto` / pack-refs pass runs (PRD §5.11).
const MAINTENANCE_IDLE: Duration = Duration::from_secs(300);

/// Upper bound for a blocking command round-trip; the UI stays responsive
/// because commands run on the worker, never on the IPC caller.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

enum RepoCommand {
    Status(Sender<Result<StatusReport, EgError>>),
    Summary(Sender<Result<RepoSummary, EgError>>),
    Stage {
        paths: Vec<String>,
        mode: StageMode,
        reply: Sender<Result<StatusReport, EgError>>,
    },
    Discard {
        paths: Vec<String>,
        safety: Arc<eg_safety::Safety>,
        reply: Sender<Result<DiscardOutcome, EgError>>,
    },
    CleanPreview {
        reply: Sender<Result<Vec<String>, EgError>>,
    },
    CleanExecute {
        paths: Vec<String>,
        safety: Arc<eg_safety::Safety>,
        reply: Sender<Result<DiscardOutcome, EgError>>,
    },
    Ignore {
        paths: Vec<String>,
        mode: IgnoreMode,
        reply: Sender<Result<StatusReport, EgError>>,
    },
    GitignoreMissing {
        reply: Sender<Result<bool, EgError>>,
    },
    GitignoreWriteTemplate {
        reply: Sender<Result<bool, EgError>>,
    },
    Undo {
        op_id: String,
        safety: Arc<eg_safety::Safety>,
        reply: Sender<Result<StatusReport, EgError>>,
    },
    Commit {
        request: eg_types::CommitRequest,
        reply: Sender<Result<eg_types::CommitOutcome, EgError>>,
    },
    ConfigGet {
        scope: ConfigScope,
        key: String,
        reply: Sender<Result<Option<String>, EgError>>,
    },
    ConfigSet {
        scope: ConfigScope,
        key: String,
        value: String,
        reply: Sender<Result<(), EgError>>,
    },
    LogPage {
        offset: u32,
        limit: u32,
        filter: eg_types::LogFilter,
        reply: Sender<Result<eg_types::LogPage, EgError>>,
    },
    CommitDetail {
        oid: String,
        reply: Sender<Result<eg_types::CommitDetail, EgError>>,
    },
    ListBranches {
        reply: Sender<Result<Vec<String>, EgError>>,
    },
    DiffFile {
        request: eg_types::DiffRequest,
        reply: Sender<Result<eg_types::DiffResponse, EgError>>,
    },
    StageLines {
        request: eg_types::StageLinesRequest,
        reply: Sender<Result<StatusReport, EgError>>,
    },
    BranchList {
        reply: Sender<Result<Vec<eg_types::BranchInfo>, EgError>>,
    },
    BranchCreate {
        name: String,
        oid: Option<String>,
        reply: Sender<Result<eg_types::BranchInfo, EgError>>,
    },
    BranchRename {
        old_name: String,
        new_name: String,
        reply: Sender<Result<(), EgError>>,
    },
    BranchDelete {
        name: String,
        safety: Arc<eg_safety::Safety>,
        reply: Sender<Result<String, EgError>>,
    },
    BranchSwitch {
        name: String,
        reply: Sender<Result<StatusReport, EgError>>,
    },
    TagList {
        reply: Sender<Result<Vec<eg_types::TagInfo>, EgError>>,
    },
    TagCreate {
        name: String,
        oid: String,
        message: Option<String>,
        reply: Sender<Result<eg_types::TagInfo, EgError>>,
    },
    TagDelete {
        name: String,
        safety: Arc<eg_safety::Safety>,
        reply: Sender<Result<String, EgError>>,
    },
    StashList {
        reply: Sender<Result<Vec<eg_types::StashEntry>, EgError>>,
    },
    StashPush {
        message: Option<String>,
        include_untracked: bool,
        reply: Sender<Result<StatusReport, EgError>>,
    },
    StashApply {
        index: u32,
        pop: bool,
        reply: Sender<Result<StatusReport, EgError>>,
    },
    StashDrop {
        index: u32,
        reply: Sender<Result<Vec<eg_types::StashEntry>, EgError>>,
    },
    MergeStart {
        name: String,
        no_ff: bool,
        reply: Sender<Result<eg_types::MergeOutcome, EgError>>,
    },
    MergeState {
        reply: Sender<Result<Option<eg_types::MergeState>, EgError>>,
    },
    MergeAbort {
        reply: Sender<Result<StatusReport, EgError>>,
    },
    ConflictsGet {
        reply: Sender<Result<Vec<eg_types::ConflictFile>, EgError>>,
    },
    ConflictResolve {
        path: String,
        content: String,
        reply: Sender<Result<StatusReport, EgError>>,
    },
    Revert {
        oids: Vec<String>,
        reply: Sender<Result<StatusReport, EgError>>,
    },
    ResetCmd {
        mode: eg_types::ResetMode,
        target: Option<String>,
        safety: Arc<eg_safety::Safety>,
        reply: Sender<Result<eg_types::ResetOutcome, EgError>>,
    },
    RemoteList {
        reply: Sender<Result<Vec<eg_types::RemoteInfo>, EgError>>,
    },
    RemoteAdd {
        name: String,
        url: String,
        reply: Sender<Result<(), EgError>>,
    },
    RemoteRename {
        old_name: String,
        new_name: String,
        reply: Sender<Result<Vec<String>, EgError>>,
    },
    RemoteRemove {
        name: String,
        reply: Sender<Result<(), EgError>>,
    },
    RemoteSetUrl {
        name: String,
        url: String,
        reply: Sender<Result<(), EgError>>,
    },
    PullIntegrate {
        remote: String,
        branch: String,
        strategy: eg_types::SyncStrategy,
        reply: Sender<Result<eg_types::MergeOutcome, EgError>>,
    },
    Redo {
        safety: Arc<eg_safety::Safety>,
        reply: Sender<Result<DiscardOutcome, EgError>>,
    },
    Timeline {
        limit: u32,
        safety: Arc<eg_safety::Safety>,
        reply: Sender<Result<Vec<eg_types::TimelineEntry>, EgError>>,
    },
    RestoreTo {
        oid: String,
        safety: Arc<eg_safety::Safety>,
        reply: Sender<Result<eg_types::ResetOutcome, EgError>>,
    },
    BranchSetUpstream {
        branch: String,
        upstream: Option<String>,
        reply: Sender<Result<eg_types::BranchInfo, EgError>>,
    },
    UndoState {
        safety: Arc<eg_safety::Safety>,
        reply: Sender<Result<eg_types::UndoRedoState, EgError>>,
    },
    RemoteBranchList {
        reply: Sender<Result<Vec<String>, EgError>>,
    },
    Close(Sender<()>),
}

impl RepoCommand {
    /// Short name for the per-command log line (the enum itself can't derive
    /// Debug: the reply channels are not).
    fn label(&self) -> &'static str {
        match self {
            RepoCommand::Status(_) => "status",
            RepoCommand::Summary(_) => "summary",
            RepoCommand::Stage { .. } => "stage",
            RepoCommand::Discard { .. } => "discard",
            RepoCommand::CleanPreview { .. } => "clean_preview",
            RepoCommand::CleanExecute { .. } => "clean_execute",
            RepoCommand::Ignore { .. } => "ignore",
            RepoCommand::GitignoreMissing { .. } => "gitignore_missing",
            RepoCommand::GitignoreWriteTemplate { .. } => "gitignore_write_template",
            RepoCommand::Undo { .. } => "undo",
            RepoCommand::Commit { .. } => "commit",
            RepoCommand::ConfigGet { .. } => "config_get",
            RepoCommand::ConfigSet { .. } => "config_set",
            RepoCommand::LogPage { .. } => "log_page",
            RepoCommand::CommitDetail { .. } => "commit_detail",
            RepoCommand::ListBranches { .. } => "list_branches",
            RepoCommand::DiffFile { .. } => "diff_file",
            RepoCommand::StageLines { .. } => "stage_lines",
            RepoCommand::BranchList { .. } => "branch_list",
            RepoCommand::BranchCreate { .. } => "branch_create",
            RepoCommand::BranchRename { .. } => "branch_rename",
            RepoCommand::BranchDelete { .. } => "branch_delete",
            RepoCommand::BranchSwitch { .. } => "branch_switch",
            RepoCommand::TagList { .. } => "tag_list",
            RepoCommand::TagCreate { .. } => "tag_create",
            RepoCommand::TagDelete { .. } => "tag_delete",
            RepoCommand::StashList { .. } => "stash_list",
            RepoCommand::StashPush { .. } => "stash_push",
            RepoCommand::StashApply { .. } => "stash_apply",
            RepoCommand::StashDrop { .. } => "stash_drop",
            RepoCommand::MergeStart { .. } => "merge_start",
            RepoCommand::MergeState { .. } => "merge_state",
            RepoCommand::MergeAbort { .. } => "merge_abort",
            RepoCommand::ConflictsGet { .. } => "conflicts_get",
            RepoCommand::ConflictResolve { .. } => "conflict_resolve",
            RepoCommand::Revert { .. } => "revert",
            RepoCommand::ResetCmd { .. } => "reset",
            RepoCommand::RemoteList { .. } => "remote_list",
            RepoCommand::RemoteAdd { .. } => "remote_add",
            RepoCommand::RemoteRename { .. } => "remote_rename",
            RepoCommand::RemoteRemove { .. } => "remote_remove",
            RepoCommand::RemoteSetUrl { .. } => "remote_set_url",
            RepoCommand::PullIntegrate { .. } => "pull",
            RepoCommand::Redo { .. } => "redo",
            RepoCommand::Timeline { .. } => "timeline",
            RepoCommand::RestoreTo { .. } => "restore_to",
            RepoCommand::BranchSetUpstream { .. } => "branch_set_upstream",
            RepoCommand::UndoState { .. } => "undo_state",
            RepoCommand::RemoteBranchList { .. } => "remote_branch_list",
            RepoCommand::Close(_) => "close",
        }
    }
}

/// Discard result: the fresh status plus the op id for the 撤销 toast.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscardOutcome {
    pub op_id: String,
    pub status: StatusReport,
}

/// Cloneable handle to a live worker thread (local) or a polled SSH session
/// (remote). All public methods keep the local signatures: they dispatch on
/// the backend internally, so the IPC layer needs no per-backend branches
/// except for the handful of network commands that used `canonical_path`.
#[derive(Clone)]
pub struct WorkerHandle {
    pub repo_id: RepoId,
    /// Stable identity + display coordinate (canonical local path / SSH URI).
    pub location: eg_types::RepoLocation,
    kind: HandleKind,
}

#[derive(Clone)]
enum HandleKind {
    Local {
        tx: Sender<RepoCommand>,
    },
    Ssh {
        target: eg_types::SshTarget,
        /// Closing this stops the polling thread (best-effort).
        stop: Sender<()>,
    },
}

impl WorkerHandle {
    /// Local-only workdir path (fetch/push/test helpers). `None` for SSH
    /// remotes, which run those commands over the SSH channel instead.
    pub fn local_path(&self) -> Option<std::path::PathBuf> {
        match &self.location {
            eg_types::RepoLocation::Local(path) => Some(path.clone()),
            eg_types::RepoLocation::Ssh(_) => None,
        }
    }

    pub fn is_ssh(&self) -> bool {
        self.location.is_ssh()
    }
}

fn worker_gone() -> EgError {
    EgError::Internal {
        context: "repo worker stopped".into(),
    }
}

impl WorkerHandle {
    pub fn request_status(&self) -> Result<StatusReport, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::status(&self.repo_id, target, None);
        }
        self.request(RepoCommand::Status)
    }

    pub fn request_summary(&self) -> Result<RepoSummary, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::summarize(&self.repo_id, target, &target.uri());
        }
        self.request(RepoCommand::Summary)
    }

    pub fn stage(&self, paths: Vec<String>, mode: StageMode) -> Result<StatusReport, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            ssh_backend::stage(target, &paths, mode, None)?;
            return ssh_backend::status(&self.repo_id, target, None);
        }
        self.request(|reply| RepoCommand::Stage { paths, mode, reply })
    }

    pub fn discard(
        &self,
        paths: Vec<String>,
        safety: Arc<eg_safety::Safety>,
    ) -> Result<DiscardOutcome, EgError> {
        if self.is_ssh() {
            let _ = (paths, safety);
            return Err(ssh_backend::refuse("丢弃修改"));
        }
        self.request(|reply| RepoCommand::Discard {
            paths,
            safety,
            reply,
        })
    }

    pub fn clean_preview(&self) -> Result<Vec<String>, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            // Preview stays available remotely (read-only); execution refuses.
            return Ok(ssh_backend::status(&self.repo_id, target, None)?
                .unstaged
                .into_iter()
                .filter(|e| e.kind == eg_types::ChangeKind::Untracked)
                .map(|e| e.path)
                .collect());
        }
        self.request(|reply| RepoCommand::CleanPreview { reply })
    }

    pub fn clean_execute(
        &self,
        paths: Vec<String>,
        safety: Arc<eg_safety::Safety>,
    ) -> Result<DiscardOutcome, EgError> {
        if self.is_ssh() {
            let _ = (paths, safety);
            return Err(ssh_backend::refuse("清理未跟踪"));
        }
        self.request(|reply| RepoCommand::CleanExecute {
            paths,
            safety,
            reply,
        })
    }

    pub fn ignore(&self, paths: Vec<String>, mode: IgnoreMode) -> Result<StatusReport, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            ssh_backend::ignore(target, &paths, mode, None)?;
            return ssh_backend::status(&self.repo_id, target, None);
        }
        self.request(|reply| RepoCommand::Ignore { paths, mode, reply })
    }

    /// True when the workdir has no `.gitignore` (创建/打开仓库时的提醒依据).
    pub fn gitignore_missing(&self) -> Result<bool, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::gitignore_missing(target);
        }
        self.request(|reply| RepoCommand::GitignoreMissing { reply })
    }

    /// Writes the generic template if absent; returns whether it was created.
    pub fn gitignore_write_template(&self) -> Result<bool, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::write_default_gitignore(target);
        }
        self.request(|reply| RepoCommand::GitignoreWriteTemplate { reply })
    }

    pub fn undo(
        &self,
        op_id: String,
        safety: Arc<eg_safety::Safety>,
    ) -> Result<StatusReport, EgError> {
        if self.is_ssh() {
            let _ = (op_id, safety);
            return Err(ssh_backend::refuse("撤销"));
        }
        self.request(|reply| RepoCommand::Undo {
            op_id,
            safety,
            reply,
        })
    }

    pub fn commit(
        &self,
        request: eg_types::CommitRequest,
    ) -> Result<eg_types::CommitOutcome, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::commit(&self.repo_id, target, &request, None);
        }
        self.request(|reply| RepoCommand::Commit { request, reply })
    }

    pub fn config_get(&self, scope: ConfigScope, key: String) -> Result<Option<String>, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::config_get(target, scope, &key);
        }
        self.request(|reply| RepoCommand::ConfigGet { scope, key, reply })
    }

    pub fn config_set(
        &self,
        scope: ConfigScope,
        key: String,
        value: String,
    ) -> Result<(), EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::config_set(target, scope, &key, &value);
        }
        self.request(|reply| RepoCommand::ConfigSet {
            scope,
            key,
            value,
            reply,
        })
    }

    pub fn log_page(
        &self,
        offset: u32,
        limit: u32,
        filter: eg_types::LogFilter,
    ) -> Result<eg_types::LogPage, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::log_page(
                &self.repo_id,
                target,
                &ssh_backend::LogPageRequest {
                    offset,
                    limit,
                    filter,
                },
                None,
            );
        }
        self.request(|reply| RepoCommand::LogPage {
            offset,
            limit,
            filter,
            reply,
        })
    }

    pub fn commit_detail(&self, oid: String) -> Result<eg_types::CommitDetail, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::commit_detail(target, &oid);
        }
        self.request(|reply| RepoCommand::CommitDetail { oid, reply })
    }

    pub fn list_branches(&self) -> Result<Vec<String>, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::list_branches(target);
        }
        self.request(|reply| RepoCommand::ListBranches { reply })
    }

    pub fn diff_file(
        &self,
        request: eg_types::DiffRequest,
    ) -> Result<eg_types::DiffResponse, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::diff_file(&self.repo_id, target, &request, None);
        }
        self.request(|reply| RepoCommand::DiffFile { request, reply })
    }

    pub fn stage_lines(
        &self,
        request: eg_types::StageLinesRequest,
    ) -> Result<StatusReport, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::stage_lines(&self.repo_id, target, &request, None);
        }
        self.request(|reply| RepoCommand::StageLines { request, reply })
    }

    pub fn branch_list(&self) -> Result<Vec<eg_types::BranchInfo>, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::branch_list(target);
        }
        self.request(|reply| RepoCommand::BranchList { reply })
    }

    pub fn branch_create(
        &self,
        name: String,
        oid: Option<String>,
    ) -> Result<eg_types::BranchInfo, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::create_branch(target, &name, oid.as_deref(), None);
        }
        self.request(|reply| RepoCommand::BranchCreate { name, oid, reply })
    }

    pub fn branch_rename(&self, old_name: String, new_name: String) -> Result<(), EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::rename_branch(target, &old_name, &new_name);
        }
        self.request(|reply| RepoCommand::BranchRename {
            old_name,
            new_name,
            reply,
        })
    }

    pub fn branch_delete(
        &self,
        name: String,
        safety: Arc<eg_safety::Safety>,
    ) -> Result<String, EgError> {
        if self.is_ssh() {
            let _ = (name, safety);
            return Err(ssh_backend::refuse("删除分支"));
        }
        self.request(|reply| RepoCommand::BranchDelete {
            name,
            safety,
            reply,
        })
    }

    pub fn branch_switch(&self, name: String) -> Result<StatusReport, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::switch_branch(&self.repo_id, target, &name, None);
        }
        self.request(|reply| RepoCommand::BranchSwitch { name, reply })
    }

    pub fn tag_list(&self) -> Result<Vec<eg_types::TagInfo>, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::tag_list(target);
        }
        self.request(|reply| RepoCommand::TagList { reply })
    }

    pub fn tag_create(
        &self,
        name: String,
        oid: String,
        message: Option<String>,
    ) -> Result<eg_types::TagInfo, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::create_tag(target, &name, &oid, message.as_deref());
        }
        self.request(|reply| RepoCommand::TagCreate {
            name,
            oid,
            message,
            reply,
        })
    }

    pub fn tag_delete(
        &self,
        name: String,
        safety: Arc<eg_safety::Safety>,
    ) -> Result<String, EgError> {
        if self.is_ssh() {
            let _ = (name, safety);
            return Err(ssh_backend::refuse("删除标签"));
        }
        self.request(|reply| RepoCommand::TagDelete {
            name,
            safety,
            reply,
        })
    }

    pub fn stash_list(&self) -> Result<Vec<eg_types::StashEntry>, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::stash_list(target);
        }
        self.request(|reply| RepoCommand::StashList { reply })
    }

    pub fn stash_push(
        &self,
        message: Option<String>,
        include_untracked: bool,
    ) -> Result<StatusReport, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::stash_push(
                &self.repo_id,
                target,
                message.as_deref(),
                include_untracked,
                None,
            );
        }
        self.request(|reply| RepoCommand::StashPush {
            message,
            include_untracked,
            reply,
        })
    }

    pub fn stash_apply(&self, index: u32, pop: bool) -> Result<StatusReport, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::stash_apply(&self.repo_id, target, index, pop, None);
        }
        self.request(|reply| RepoCommand::StashApply { index, pop, reply })
    }

    pub fn stash_drop(&self, index: u32) -> Result<Vec<eg_types::StashEntry>, EgError> {
        if self.is_ssh() {
            let _ = index;
            return Err(ssh_backend::refuse("删除储藏"));
        }
        self.request(|reply| RepoCommand::StashDrop { index, reply })
    }

    pub fn merge_start(
        &self,
        name: String,
        no_ff: bool,
    ) -> Result<eg_types::MergeOutcome, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::merge_start(&self.repo_id, target, &name, no_ff, None);
        }
        self.request(|reply| RepoCommand::MergeStart { name, no_ff, reply })
    }

    pub fn merge_state(&self) -> Result<Option<eg_types::MergeState>, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::merge_state(target);
        }
        self.request(|reply| RepoCommand::MergeState { reply })
    }

    pub fn merge_abort(&self) -> Result<StatusReport, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::merge_abort(&self.repo_id, target, None);
        }
        self.request(|reply| RepoCommand::MergeAbort { reply })
    }

    pub fn conflicts_get(&self) -> Result<Vec<eg_types::ConflictFile>, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::conflicts_get(target, None);
        }
        self.request(|reply| RepoCommand::ConflictsGet { reply })
    }

    pub fn conflict_resolve(&self, path: String, content: String) -> Result<StatusReport, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::conflict_resolve(&self.repo_id, target, &path, &content, None);
        }
        self.request(|reply| RepoCommand::ConflictResolve {
            path,
            content,
            reply,
        })
    }

    pub fn revert(&self, oids: Vec<String>) -> Result<StatusReport, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::revert(&self.repo_id, target, &oids, None);
        }
        self.request(|reply| RepoCommand::Revert { oids, reply })
    }

    pub fn reset(
        &self,
        mode: eg_types::ResetMode,
        target: Option<String>,
        safety: Arc<eg_safety::Safety>,
    ) -> Result<eg_types::ResetOutcome, EgError> {
        if self.is_ssh() {
            let _ = (mode, target, safety);
            return Err(ssh_backend::refuse("重置"));
        }
        self.request(|reply| RepoCommand::ResetCmd {
            mode,
            target,
            safety,
            reply,
        })
    }

    pub fn remote_list(&self) -> Result<Vec<eg_types::RemoteInfo>, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::remote_list(target);
        }
        self.request(|reply| RepoCommand::RemoteList { reply })
    }

    pub fn remote_add(&self, name: String, url: String) -> Result<(), EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::remote_add(target, &name, &url);
        }
        self.request(|reply| RepoCommand::RemoteAdd { name, url, reply })
    }

    pub fn remote_rename(
        &self,
        old_name: String,
        new_name: String,
    ) -> Result<Vec<String>, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::remote_rename(target, &old_name, &new_name);
        }
        self.request(|reply| RepoCommand::RemoteRename {
            old_name,
            new_name,
            reply,
        })
    }

    pub fn remote_remove(&self, name: String) -> Result<(), EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::remote_remove(target, &name);
        }
        self.request(|reply| RepoCommand::RemoteRemove { name, reply })
    }

    pub fn remote_set_url(&self, name: String, url: String) -> Result<(), EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::remote_set_url(target, &name, &url);
        }
        self.request(|reply| RepoCommand::RemoteSetUrl { name, url, reply })
    }

    pub fn pull_integrate(
        &self,
        remote: String,
        branch: String,
        strategy: eg_types::SyncStrategy,
    ) -> Result<eg_types::MergeOutcome, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::pull_integrate(
                &self.repo_id,
                target,
                &remote,
                &branch,
                strategy,
                None,
            );
        }
        self.request(|reply| RepoCommand::PullIntegrate {
            remote,
            branch,
            strategy,
            reply,
        })
    }

    pub fn redo(&self, safety: Arc<eg_safety::Safety>) -> Result<DiscardOutcome, EgError> {
        if self.is_ssh() {
            let _ = safety;
            return Err(ssh_backend::refuse("重做"));
        }
        self.request(|reply| RepoCommand::Redo { safety, reply })
    }

    pub fn timeline(
        &self,
        limit: u32,
        safety: Arc<eg_safety::Safety>,
    ) -> Result<Vec<eg_types::TimelineEntry>, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            let _ = safety;
            return ssh_backend::timeline(&self.repo_id, target, limit);
        }
        self.request(|reply| RepoCommand::Timeline {
            limit,
            safety,
            reply,
        })
    }

    pub fn restore_to(
        &self,
        oid: String,
        safety: Arc<eg_safety::Safety>,
    ) -> Result<eg_types::ResetOutcome, EgError> {
        if self.is_ssh() {
            let _ = (oid, safety);
            return Err(ssh_backend::refuse("恢复到此状态"));
        }
        self.request(|reply| RepoCommand::RestoreTo { oid, safety, reply })
    }

    pub fn undo_state(
        &self,
        safety: Arc<eg_safety::Safety>,
    ) -> Result<eg_types::UndoRedoState, EgError> {
        if self.is_ssh() {
            let _ = safety;
            // No safety log over SSH (destructive ops are refused): no undo.
            return Ok(ssh_backend::undo_state());
        }
        self.request(|reply| RepoCommand::UndoState { safety, reply })
    }

    pub fn remote_branch_list(&self) -> Result<Vec<String>, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            return ssh_backend::remote_branch_list(target);
        }
        self.request(|reply| RepoCommand::RemoteBranchList { reply })
    }

    pub fn branch_set_upstream(
        &self,
        branch: String,
        upstream: Option<String>,
    ) -> Result<eg_types::BranchInfo, EgError> {
        if let HandleKind::Ssh { target, .. } = &self.kind {
            ssh_backend::set_branch_upstream(target, &branch, upstream.as_deref())?;
            return ssh_backend::branch_list(target)?
                .into_iter()
                .find(|b| b.name == branch)
                .ok_or_else(|| EgError::Internal {
                    context: "branch vanished after upstream set".into(),
                });
        }
        self.request(|reply| RepoCommand::BranchSetUpstream {
            branch,
            upstream,
            reply,
        })
    }

    // -- Network commands (previously driven by `canonical_path` in the IPC
    // layer). Local handles run the existing path-based helpers; SSH handles
    // run the same operation over the SSH channel. Progress flows through
    // the caller's channel like the local variants.

    pub fn sync_fetch(
        &self,
        remote: &str,
        prune: bool,
        on_progress: Option<&Sender<remote::SyncProgress>>,
    ) -> Result<(), EgError> {
        match &self.kind {
            HandleKind::Local { .. } => {
                let path = self.local_path().expect("local handle has a path");
                super::remote::fetch_at(&path, remote, prune, on_progress)
            }
            HandleKind::Ssh { target, .. } => {
                ssh_backend::fetch(target, remote, prune, on_progress)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn sync_push(
        &self,
        repo_id: &str,
        remote: &str,
        branch: &str,
        force: bool,
        safety: &eg_safety::Safety,
        on_progress: Option<&Sender<remote::SyncProgress>>,
        credentials: Option<&eg_types::PushCredentials>,
    ) -> Result<(), EgError> {
        match &self.kind {
            HandleKind::Local { .. } => {
                let path = self.local_path().expect("local handle has a path");
                super::remote::push_with_rollback(
                    &path,
                    repo_id,
                    remote,
                    branch,
                    force,
                    safety,
                    on_progress,
                    credentials,
                )
            }
            HandleKind::Ssh { target, .. } => {
                if force {
                    return Err(ssh_backend::refuse("强推"));
                }
                ssh_backend::push(target, remote, branch, true, on_progress, credentials)
            }
        }
    }

    pub fn test_remote(
        &self,
        remote: &str,
        on_progress: Option<&Sender<remote::SyncProgress>>,
    ) -> Result<u32, EgError> {
        match &self.kind {
            HandleKind::Local { .. } => {
                let path = self.local_path().expect("local handle has a path");
                super::remote::test_remote(&path, remote, on_progress)
            }
            HandleKind::Ssh { target, .. } => {
                ssh_backend::ls_remote(target, remote, on_progress).map(|refs| refs.len() as u32)
            }
        }
    }

    fn request<T>(
        &self,
        make: impl FnOnce(Sender<Result<T, EgError>>) -> RepoCommand,
    ) -> Result<T, EgError> {
        match &self.kind {
            HandleKind::Local { tx } => Self::request_via(tx, &self.repo_id, make),
            HandleKind::Ssh { .. } => Err(worker_gone()),
        }
    }

    fn request_via<T>(
        tx: &Sender<RepoCommand>,
        repo_id: &str,
        make: impl FnOnce(Sender<Result<T, EgError>>) -> RepoCommand,
    ) -> Result<T, EgError> {
        let (tx_reply, rx) = channel();
        if tx.send(make(tx_reply)).is_err() {
            tracing::error!(repo = %repo_id, "repo worker stopped");
            return Err(worker_gone());
        }
        match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(result) => {
                if let Err(error) = &result {
                    // Guards (dirty worktree, confirmations, mid-merge) are UI
                    // control flow, not malfunctions — keep them off error level.
                    if error.is_expected() {
                        tracing::debug!(
                            repo = %repo_id,
                            code = error.code(),
                            error = ?error,
                            "repo command refused"
                        );
                    } else {
                        tracing::error!(
                            repo = %repo_id,
                            code = error.code(),
                            error = ?error,
                            "repo command failed"
                        );
                    }
                }
                result
            }
            Err(_) => {
                tracing::error!(repo = %repo_id, "repo worker request timed out");
                Err(EgError::Internal {
                    context: "repo worker request timed out".into(),
                })
            }
        }
    }

    /// Drains the queue and stops the thread (TDD §4.1: close = drain + drop).
    /// For SSH remotes this stops the polling thread (best-effort).
    pub fn close(&self) {
        match &self.kind {
            HandleKind::Local { tx } => {
                let (done_tx, done_rx) = channel();
                if tx.send(RepoCommand::Close(done_tx)).is_ok() {
                    let _ = done_rx.recv_timeout(Duration::from_secs(2));
                }
            }
            HandleKind::Ssh { stop, .. } => {
                let _ = stop.send(());
            }
        }
    }
}

/// Closure invoked (at most once per debounce window) with the repo id.
pub type ChangeSink = Arc<dyn Fn(&str) + Send + Sync + 'static>;

/// Spawns the worker thread that owns `repo` for the rest of its life.
pub fn spawn(
    repo: git2::Repository,
    repo_id: RepoId,
    canonical_path: PathBuf,
    on_change: ChangeSink,
) -> Result<WorkerHandle, EgError> {
    let (tx, rx) = channel::<RepoCommand>();

    let (fs_tx, fs_rx) = channel::<notify::Result<notify::Event>>();
    let mut watcher: RecommendedWatcher =
        notify::recommended_watcher(fs_tx).map_err(|e| EgError::Internal {
            context: format!("fs-watch init failed: {e}"),
        })?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| EgError::NotSupported {
            feature: "bare repository watching".into(),
        })?
        .to_path_buf();
    watcher
        .watch(&workdir, RecursiveMode::Recursive)
        .map_err(|e| EgError::Internal {
            context: format!("fs-watch setup failed: {e}"),
        })?;

    let handle = WorkerHandle {
        repo_id: repo_id.clone(),
        location: eg_types::RepoLocation::Local(canonical_path.clone()),
        kind: HandleKind::Local { tx },
    };

    let thread_repo_id = repo_id.clone();
    std::thread::Builder::new()
        .name(format!("eg-repo-{}", &repo_id[..8.min(repo_id.len())]))
        .spawn(move || {
            // Held for the thread lifetime; dropping it unregisters the watch.
            let _watcher = watcher;
            run_loop(
                repo,
                rx,
                fs_rx,
                workdir,
                thread_repo_id,
                canonical_path,
                on_change,
            );
        })
        .map_err(|e| EgError::Internal {
            context: format!("worker spawn failed: {e}"),
        })?;

    Ok(handle)
}

/// How often the SSH polling thread re-checks the remote HEAD + status
/// snapshot. Remote polling replaces the local fs-watch (there is no local
/// workdir to watch); manual refresh in the UI stays the primary trigger.
pub const SSH_POLL_INTERVAL: Duration = Duration::from_secs(30);

/// Spawns the SSH polling thread for a remote-host repository. Unlike the
/// local worker this thread owns no `git2::Repository`: every poll and every
/// user command opens a fresh SSH channel through `ssh_backend`, so commands
/// execute directly on the caller's thread while the poller only emits
/// `repo://changed` when the remote HEAD or status snapshot moves.
pub fn spawn_ssh(
    target: eg_types::SshTarget,
    repo_id: RepoId,
    on_change: ChangeSink,
) -> Result<WorkerHandle, EgError> {
    // Validate the target up front so `repo_open` fails fast instead of
    // registering a dead handle.
    super::ssh::test_connection(&target, None)?;
    super::ssh::probe_repo(&target, None)?;

    let (stop_tx, stop_rx) = channel::<()>();
    let handle = WorkerHandle {
        repo_id: repo_id.clone(),
        location: eg_types::RepoLocation::Ssh(target.clone()),
        kind: HandleKind::Ssh {
            target: target.clone(),
            stop: stop_tx,
        },
    };

    let thread_repo_id = repo_id.clone();
    std::thread::Builder::new()
        .name(format!("eg-ssh-{}", &repo_id[..8.min(repo_id.len())]))
        .spawn(move || {
            ssh_poll_loop(target, thread_repo_id, on_change, stop_rx);
        })
        .map_err(|e| EgError::Internal {
            context: format!("ssh worker spawn failed: {e}"),
        })?;

    Ok(handle)
}

/// Polls `rev-parse HEAD` plus a compact status snapshot; any change emits
/// the change sink once (debounced by the poll interval itself).
fn ssh_poll_loop(
    target: eg_types::SshTarget,
    repo_id: RepoId,
    on_change: ChangeSink,
    stop: std::sync::mpsc::Receiver<()>,
) {
    let snapshot = || -> Option<String> {
        let head = super::ssh_backend::status(&repo_id, &target, None)
            .ok()
            .map(|report| {
                let mut parts = vec![
                    report.branch.unwrap_or_default(),
                    report.head_oid.unwrap_or_default(),
                ];
                for e in report
                    .staged
                    .iter()
                    .chain(&report.unstaged)
                    .chain(&report.conflicted)
                {
                    parts.push(format!("{:?}:{}", e.kind, e.path));
                }
                parts.join("|")
            });
        head
    };
    let mut last = snapshot();
    loop {
        match stop.recv_timeout(SSH_POLL_INTERVAL) {
            Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }
        let current = snapshot();
        if current != last {
            last = current;
            on_change(&repo_id);
        }
    }
}

fn run_loop(
    mut repo: git2::Repository,
    rx: std::sync::mpsc::Receiver<RepoCommand>,
    fs_rx: std::sync::mpsc::Receiver<notify::Result<notify::Event>>,
    workdir: PathBuf,
    repo_id: RepoId,
    canonical_path: PathBuf,
    on_change: ChangeSink,
) {
    let mut dirty: Option<Instant> = None;
    // Idle maintenance marker (PRD §5.11): bumped by every incoming command
    // and after each maintenance pass, so gc runs at most once per idle
    // window.
    let mut last_activity = Instant::now();
    loop {
        // 1. Coalesce filesystem bursts into a single pending change flag.
        while let Ok(event) = fs_rx.try_recv() {
            if let Ok(event) = event {
                let relevant = event.paths.iter().any(|p| !is_git_internal(&workdir, p));
                if relevant && dirty.is_none() {
                    dirty = Some(Instant::now());
                }
            }
        }

        // 2. Emit once the quiet period has elapsed.
        if let Some(seen) = dirty {
            if seen.elapsed() >= FS_DEBOUNCE {
                on_change(&repo_id);
                dirty = None;
            }
        }

        // 2b. Silent maintenance while the repo has been idle (PRD §5.11):
        // no pending user work and no command traffic for the idle window.
        if dirty.is_none() && last_activity.elapsed() >= MAINTENANCE_IDLE {
            if let Err(e) = crate::remote::GitCli::for_path(&workdir).maintenance() {
                tracing::warn!(repo = %repo_id, error = ?e, "idle maintenance skipped");
            }
            last_activity = Instant::now();
        }

        // 3. Wait for commands; wake in time for the pending debounce.
        let wait = dirty
            .map(|seen| FS_DEBOUNCE.saturating_sub(seen.elapsed()))
            .unwrap_or(FS_DEBOUNCE)
            .max(Duration::from_millis(10));
        let received = rx.recv_timeout(wait);
        if received.is_ok() {
            last_activity = Instant::now();
        }
        // Per-command audit line (debug): one site covers the whole dispatch
        // without instrumenting every arm.
        let started = Instant::now();
        let command_label = received.as_ref().ok().map(RepoCommand::label);
        match received {
            Ok(RepoCommand::Status(tx)) => {
                let _ = tx.send(status::status(&repo_id, &repo));
            }
            Ok(RepoCommand::Summary(tx)) => {
                let _ = tx.send(repo::summarize(&repo_id, &repo, &canonical_path));
            }
            Ok(RepoCommand::Stage { paths, mode, reply }) => {
                let _ = reply.send(
                    ops::stage(&repo, &paths, mode).and_then(|()| status::status(&repo_id, &repo)),
                );
            }
            Ok(RepoCommand::Discard {
                paths,
                safety,
                reply,
            }) => {
                let _ = reply.send(ops::discard(&repo, &repo_id, &safety, &paths).and_then(
                    |op_id| {
                        status::status(&repo_id, &repo)
                            .map(|status| DiscardOutcome { op_id, status })
                    },
                ));
            }
            Ok(RepoCommand::CleanPreview { reply }) => {
                let _ = reply.send(status::status(&repo_id, &repo).map(|report| {
                    report
                        .unstaged
                        .into_iter()
                        .filter(|e| e.kind == eg_types::ChangeKind::Untracked)
                        .map(|e| e.path)
                        .collect()
                }));
            }
            Ok(RepoCommand::CleanExecute {
                paths,
                safety,
                reply,
            }) => {
                let _ = reply.send(ops::clean(&repo, &repo_id, &safety, &paths).and_then(
                    |op_id| {
                        status::status(&repo_id, &repo)
                            .map(|status| DiscardOutcome { op_id, status })
                    },
                ));
            }
            Ok(RepoCommand::Ignore { paths, mode, reply }) => {
                let _ = reply.send(
                    ops::ignore(&repo, &paths, mode)
                        .and_then(|_added| status::status(&repo_id, &repo)),
                );
            }
            Ok(RepoCommand::GitignoreMissing { reply }) => {
                let _ = reply.send(ops::gitignore_missing(&repo));
            }
            Ok(RepoCommand::GitignoreWriteTemplate { reply }) => {
                let _ = reply.send(ops::write_default_gitignore(&repo));
            }
            Ok(RepoCommand::Undo {
                op_id,
                safety,
                reply,
            }) => {
                let _ = reply.send(
                    ops::undo_operation(&mut repo, &repo_id, &safety, &op_id)
                        .and_then(|()| status::status(&repo_id, &repo)),
                );
            }
            Ok(RepoCommand::Commit { request, reply }) => {
                let _ = reply.send(commit::commit(&repo, &repo_id, &request));
            }
            Ok(RepoCommand::ConfigGet { scope, key, reply }) => {
                let _ = reply.send(config::config_get(Some(&repo), scope, &key));
            }
            Ok(RepoCommand::ConfigSet {
                scope,
                key,
                value,
                reply,
            }) => {
                let _ = reply.send(config::config_set(Some(&repo), scope, &key, &value));
            }
            Ok(RepoCommand::LogPage {
                offset,
                limit,
                filter,
                reply,
            }) => {
                let _ = reply.send(log::log_page(&repo, &repo_id, offset, limit, &filter));
            }
            Ok(RepoCommand::CommitDetail { oid, reply }) => {
                let _ = reply.send(log::commit_detail(&repo, &oid));
            }
            Ok(RepoCommand::ListBranches { reply }) => {
                let _ = reply.send(log::list_branches(&repo));
            }
            Ok(RepoCommand::DiffFile { request, reply }) => {
                let _ = reply.send(diff::diff_file(&repo, &repo_id, &request));
            }
            Ok(RepoCommand::StageLines { request, reply }) => {
                let _ = reply.send(diff::stage_lines(&repo, &repo_id, &request));
            }
            Ok(RepoCommand::BranchList { reply }) => {
                let _ = reply.send(refs::list_branches_info(&repo));
            }
            Ok(RepoCommand::BranchCreate { name, oid, reply }) => {
                let _ = reply.send(refs::create_branch(&repo, &name, oid.as_deref()));
            }
            Ok(RepoCommand::BranchRename {
                old_name,
                new_name,
                reply,
            }) => {
                let _ = reply.send(refs::rename_branch(&repo, &old_name, &new_name));
            }
            Ok(RepoCommand::BranchDelete {
                name,
                safety,
                reply,
            }) => {
                let _ = reply.send(refs::delete_branch(&repo, &repo_id, &safety, &name));
            }
            Ok(RepoCommand::BranchSwitch { name, reply }) => {
                let _ = reply.send(refs::switch_branch(&repo, &repo_id, &name));
            }
            Ok(RepoCommand::TagList { reply }) => {
                let _ = reply.send(refs::list_tags(&repo));
            }
            Ok(RepoCommand::TagCreate {
                name,
                oid,
                message,
                reply,
            }) => {
                let _ = reply.send(refs::create_tag(&repo, &name, &oid, message.as_deref()));
            }
            Ok(RepoCommand::TagDelete {
                name,
                safety,
                reply,
            }) => {
                let _ = reply.send(refs::delete_tag(&repo, &repo_id, &safety, &name));
            }
            Ok(RepoCommand::StashList { reply }) => {
                let _ = reply.send(stash::list_stashes(&mut repo));
            }
            Ok(RepoCommand::StashPush {
                message,
                include_untracked,
                reply,
            }) => {
                let _ = reply.send(stash::stash_push(
                    &mut repo,
                    &repo_id,
                    message.as_deref(),
                    include_untracked,
                ));
            }
            Ok(RepoCommand::StashApply { index, pop, reply }) => {
                let _ = reply.send(stash::stash_apply(&mut repo, &repo_id, index, pop));
            }
            Ok(RepoCommand::StashDrop { index, reply }) => {
                let _ = reply.send(stash::stash_drop(&mut repo, index));
            }
            Ok(RepoCommand::MergeStart { name, no_ff, reply }) => {
                let _ = reply.send(merge::merge_start(&mut repo, &repo_id, &name, no_ff));
            }
            Ok(RepoCommand::MergeState { reply }) => {
                let _ = reply.send(merge::merge_state(&repo));
            }
            Ok(RepoCommand::MergeAbort { reply }) => {
                let _ = reply.send(merge::merge_abort(&mut repo, &repo_id));
            }
            Ok(RepoCommand::ConflictsGet { reply }) => {
                let _ = reply.send(conflicts::conflicts_get(&repo, &repo_id));
            }
            Ok(RepoCommand::ConflictResolve {
                path,
                content,
                reply,
            }) => {
                let _ = reply.send(conflicts::conflict_resolve(
                    &repo, &repo_id, &path, &content,
                ));
            }
            Ok(RepoCommand::Revert { oids, reply }) => {
                let _ = reply.send(merge::revert_commits(&mut repo, &repo_id, &oids));
            }
            Ok(RepoCommand::ResetCmd {
                mode,
                target,
                safety,
                reply,
            }) => {
                let _ = reply.send(merge::reset(
                    &mut repo,
                    &repo_id,
                    mode,
                    target.as_deref(),
                    &safety,
                ));
            }
            Ok(RepoCommand::RemoteList { reply }) => {
                let _ = reply.send(remote::remote_list(&repo));
            }
            Ok(RepoCommand::RemoteAdd { name, url, reply }) => {
                let _ = reply.send(remote::remote_add(&repo, &name, &url));
            }
            Ok(RepoCommand::RemoteRename {
                old_name,
                new_name,
                reply,
            }) => {
                let _ = reply.send(remote::remote_rename(&repo, &old_name, &new_name));
            }
            Ok(RepoCommand::RemoteRemove { name, reply }) => {
                let _ = reply.send(remote::remote_remove(&repo, &name));
            }
            Ok(RepoCommand::RemoteSetUrl { name, url, reply }) => {
                let _ = reply.send(remote::remote_set_url(&repo, &name, &url));
            }
            Ok(RepoCommand::PullIntegrate {
                remote,
                branch,
                strategy,
                reply,
            }) => {
                let _ = reply.send(remote::pull_integrate(
                    &mut repo, &repo_id, &remote, &branch, strategy,
                ));
            }
            Ok(RepoCommand::Redo { safety, reply }) => {
                let _ = reply.send(ops::redo_last(&mut repo, &repo_id, &safety).and_then(
                    |op_id| {
                        status::status(&repo_id, &repo)
                            .map(|status| DiscardOutcome { op_id, status })
                    },
                ));
            }
            Ok(RepoCommand::Timeline {
                limit,
                safety,
                reply,
            }) => {
                let _ = reply.send(timeline::timeline(&repo, &repo_id, &safety, limit));
            }
            Ok(RepoCommand::RestoreTo { oid, safety, reply }) => {
                let _ = reply.send(timeline::restore_to(&mut repo, &repo_id, &safety, &oid));
            }
            Ok(RepoCommand::BranchSetUpstream {
                branch,
                upstream,
                reply,
            }) => {
                let _ = reply.send(
                    refs::set_branch_upstream(&repo, &branch, upstream.as_deref()).and_then(|()| {
                        let name = branch.clone();
                        refs::list_branches_info(&repo).and_then(|list| {
                            list.into_iter().find(|b| b.name == name).ok_or_else(|| {
                                EgError::Internal {
                                    context: "branch vanished after upstream set".into(),
                                }
                            })
                        })
                    }),
                );
            }
            Ok(RepoCommand::UndoState { safety, reply }) => {
                let history = safety.history(&repo_id);
                let undoable = history.iter().find(|r| !r.undone);
                let label = undoable
                    .map(|r| match r.kind {
                        eg_safety::OpKind::Discard => "丢弃修改",
                        eg_safety::OpKind::Clean => "清理未跟踪",
                        eg_safety::OpKind::RefDelete => "删除分支/标签",
                        eg_safety::OpKind::Reset => "重置",
                        eg_safety::OpKind::ForcePush => "强制推送",
                    })
                    .unwrap_or_default()
                    .to_string();
                let _ = reply.send(Ok(eg_types::UndoRedoState {
                    undoable_op_id: undoable.map(|r| r.op_id.clone()),
                    undoable_label: label,
                    redoable: history.iter().any(|r| r.undone),
                }));
            }
            Ok(RepoCommand::RemoteBranchList { reply }) => {
                let _ = reply.send(refs::list_remote_branches(&repo));
            }
            Ok(RepoCommand::Close(tx)) => {
                let _ = tx.send(());
                break;
            }
            Err(RecvTimeoutError::Timeout) => continue,
            // All handles dropped: shut down.
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if let Some(label) = command_label {
            tracing::debug!(
                repo = %repo_id,
                command = label,
                elapsed_ms = started.elapsed().as_millis() as u64,
                "repo command finished"
            );
        }
    }
}

/// Ignores churn inside `.git` (index refresh, gc, our own safety writes).
fn is_git_internal(workdir: &Path, path: &Path) -> bool {
    path.strip_prefix(workdir)
        .map(|rel| rel.iter().next() == Some(std::ffi::OsStr::new(".git")))
        .unwrap_or(true)
}

/// Registry of open repositories, one worker thread each (TDD §4.1).
/// Lives in Tauri managed state; all methods are panic-free.
#[derive(Default)]
pub struct RepoManager {
    workers: Mutex<HashMap<RepoId, WorkerHandle>>,
}

impl RepoManager {
    /// Opens the repository at `path` (searching upwards like git), or returns
    /// the summary of the already-open worker for the same canonical path.
    /// SSH locations (`ssh://…` / `user@host:path`) open a remote session
    /// instead of a local worker — see [`RepoManager::open_ssh`].
    pub fn open(&self, path: &Path, on_change: ChangeSink) -> Result<RepoSummary, EgError> {
        let path_str = path.to_string_lossy();
        if eg_types::is_ssh_location(&path_str) {
            let target =
                eg_types::parse_ssh_target(&path_str).ok_or_else(|| EgError::Internal {
                    context: format!("invalid SSH location: {path_str}"),
                })?;
            return self.open_ssh(target, on_change);
        }
        let canonical = path.canonicalize().map_err(|e| EgError::RepoNotFound {
            path: eg_types::paths::display_path(path),
            detail: Some(e.to_string()),
        })?;
        let location = eg_types::RepoLocation::Local(canonical.clone());

        if let Some(existing) = self.find_by_location(&location) {
            return existing.request_summary();
        }

        let repo = repo::open(&canonical)?;
        let repo_id = Uuid::new_v4().to_string();
        let sink: ChangeSink = Arc::new(move |id| on_change(id));
        let handle = spawn(repo, repo_id, canonical, sink)?;
        self.register(handle)
    }

    /// Opens a remote-host repository over SSH (fail-fast connectivity +
    /// repo validation, dedupe by SSH URI, polled change events).
    pub fn open_ssh(
        &self,
        target: eg_types::SshTarget,
        on_change: ChangeSink,
    ) -> Result<RepoSummary, EgError> {
        let location = eg_types::RepoLocation::Ssh(target.clone());
        if let Some(existing) = self.find_by_location(&location) {
            return existing.request_summary();
        }
        let repo_id = Uuid::new_v4().to_string();
        let sink: ChangeSink = Arc::new(move |id| on_change(id));
        let handle = spawn_ssh(target, repo_id, sink)?;
        self.register(handle)
    }

    /// Inserts a freshly opened handle after its first summary succeeds;
    /// tears it down when the summary fails.
    fn register(&self, handle: WorkerHandle) -> Result<RepoSummary, EgError> {
        let summary = handle.request_summary();
        match summary {
            Ok(s) => {
                self.workers
                    .lock()
                    .expect("repo manager mutex")
                    .insert(handle.repo_id.clone(), handle);
                Ok(s)
            }
            Err(err) => {
                handle.close();
                Err(err)
            }
        }
    }

    fn find_by_location(&self, location: &eg_types::RepoLocation) -> Option<WorkerHandle> {
        let key = location.key();
        let workers = self.workers.lock().expect("repo manager mutex");
        workers.values().find(|w| w.location.key() == key).cloned()
    }

    pub fn get(&self, repo_id: &str) -> Result<WorkerHandle, EgError> {
        self.workers
            .lock()
            .expect("repo manager mutex")
            .get(repo_id)
            .cloned()
            .ok_or_else(|| EgError::RepoNotFound {
                path: repo_id.to_string(),
                detail: None,
            })
    }

    /// Closes the repository (drain + stop thread). Unknown ids are a no-op
    /// so the frontend can close stale tabs idempotently.
    pub fn close(&self, repo_id: &str) {
        if let Some(handle) = self
            .workers
            .lock()
            .expect("repo manager mutex")
            .remove(repo_id)
        {
            handle.close();
        }
    }

    /// Shuts every worker down (app exit).
    pub fn close_all(&self) {
        let handles: Vec<WorkerHandle> = self
            .workers
            .lock()
            .expect("repo manager mutex")
            .drain()
            .map(|(_, h)| h)
            .collect();
        for handle in handles {
            handle.close();
        }
    }
}
