//! IPC DTOs (TDD §4.6). Wire format is camelCase to keep the generated TS
//! bindings idiomatic.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Answer to the pipeline-proving `app_version` command (m1-plan F-01).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppVersion {
    pub app_version: String,
    pub tauri_version: String,
    pub os: String,
}

/// Opaque per-open-repository identifier issued by the RepoManager.
pub type RepoId = String;

/// Summary returned when opening a repository (R-01) and by the top-bar
/// switcher. `branch` is `None` for unborn HEADs and detached HEAD.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub repo_id: RepoId,
    pub path: String,
    pub name: String,
    pub branch: Option<String>,
    pub head_oid: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// True when the repository has no commits yet (unborn HEAD).
    pub is_empty: bool,
}

/// Change classification driving the semantic icons/colors (UI doc §3.3/§9).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Conflicted,
    Untracked,
}

/// `stage(repo, paths, mode)` per TDD §4.6 (m1-plan R-05).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum StageMode {
    Stage,
    Unstage,
}

/// How a context-menu「忽略」entry writes .gitignore lines (m1-plan F-10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum IgnoreMode {
    ByPath,
    ByExtension,
}

/// One row of the three-zone changes view (PRD §5.2, m1-plan R-02).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEntry {
    /// Repository-relative path with forward slashes; untracked directories
    /// are collapsed and keep a trailing slash.
    pub path: String,
    /// Previous path when `kind` is `renamed`.
    pub old_path: Option<String>,
    pub kind: ChangeKind,
}

/// `status_get` answer: pre-grouped for the three-zone view.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    pub repo_id: RepoId,
    pub branch: Option<String>,
    pub head_oid: Option<String>,
    /// Index-vs-HEAD deltas (已暂存).
    pub staged: Vec<ChangeEntry>,
    /// Worktree-vs-index deltas plus untracked files/dirs (未暂存).
    pub unstaged: Vec<ChangeEntry>,
    /// Entries stuck in an unresolved merge state (冲突).
    pub conflicted: Vec<ChangeEntry>,
}

impl StatusReport {
    pub fn is_clean(&self) -> bool {
        self.staged.is_empty() && self.unstaged.is_empty() && self.conflicted.is_empty()
    }
}
