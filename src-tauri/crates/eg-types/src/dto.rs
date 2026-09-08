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

/// Commit request (m1-plan R-07). `allow_partial` confirms committing while
/// some staged files also carry unstaged edits (only the staged part lands).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    pub subject: String,
    pub body: String,
    pub amend: bool,
    pub allow_partial: bool,
}

/// Commit result: new commit id plus refreshed summary/status for the UI.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutcome {
    pub commit_id: String,
    pub amended: bool,
    pub summary: RepoSummary,
    pub status: StatusReport,
}

/// Which config file a get/set targets (m1-plan R-09).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ConfigScope {
    Repo,
    Global,
}

/// Graph geometry for one history row (m1-plan R-10). Lanes are pre-computed
/// in Rust so the frontend canvas only draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphLine {
    /// Lane index in the row above (or this row, for pass-through lines).
    pub from: u32,
    /// Lane index in the row below; `from == to` is a straight vertical.
    pub to: u32,
    /// Index into the 8-color branch palette (UI doc §3.4).
    pub color: u8,
}

/// Node marker of one history row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub lane: u32,
    pub color: u8,
    /// Merge commits render as a diamond (UI doc §6.7).
    pub merge: bool,
}

/// Branch/tag decorations on a commit, e.g. `main`, `origin/main`, `v1.0`.
#[derive(Debug, Clone, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitRefs {
    /// Local branches (short names), the current one first.
    pub branches: Vec<String>,
    /// Remote-tracking branches (short `origin/xxx` form).
    pub remotes: Vec<String>,
    /// Tags (short names).
    pub tags: Vec<String>,
}

/// One row of the history DAG (PRD §5.3, m1-plan F-15).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitLogEntry {
    pub oid: String,
    pub short_oid: String,
    /// First line of the commit message.
    pub subject: String,
    /// Body after the subject line (without the leading blank line).
    pub body: String,
    pub author_name: String,
    pub author_email: String,
    /// Author time, seconds since the Unix epoch. f64 keeps specta's TS
    /// export happy (i64 is forbidden); git timestamps are far below 2^53.
    pub author_time: f64,
    /// Number of parents; > 1 means merge (rendered as a diamond).
    pub parent_count: u32,
    /// True for the commit HEAD points at.
    pub is_head: bool,
    pub refs: CommitRefs,
    pub node: GraphNode,
    /// Lines drawn below the node towards the next row.
    pub lines: Vec<GraphLine>,
    /// Number of lanes in this row (canvas sizing / pass-through drawing).
    pub lane_count: u32,
}

/// Log filters (m1-plan F-17). `None` fields mean no restriction.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogFilter {
    /// Start the walk from this branch instead of HEAD (short name).
    pub branch: Option<String>,
    /// Case-insensitive substring on the author name.
    pub author: Option<String>,
    /// Case-insensitive substring on the commit message.
    pub message: Option<String>,
}

/// One page of the topo-sorted, lane-annotated log (m1-plan R-10).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub repo_id: RepoId,
    pub entries: Vec<CommitLogEntry>,
    /// Offset to request next; `None` when the walk is exhausted.
    pub next_offset: Option<u32>,
    /// Current branch short name (for the HEAD ring / filter dropdown).
    pub branch: Option<String>,
}

/// One file changed by a commit (m1-plan F-16 detail panel).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub old_path: Option<String>,
    pub kind: ChangeKind,
    pub added: u32,
    pub deleted: u32,
}

/// Commit detail payload (m1-plan F-16).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub oid: String,
    pub short_oid: String,
    pub subject: String,
    pub body: String,
    pub author_name: String,
    pub author_email: String,
    pub author_time: f64,
    pub refs: CommitRefs,
    pub files: Vec<CommitFile>,
}

/// Which side of the diff a read targets (m1-plan R-12 / F-18).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DiffSourceKind {
    /// Worktree vs index (未暂存视图); line staging applies INTO the index.
    Worktree,
    /// Index vs HEAD (已暂存视图); line staging rewrites the index back.
    Index,
    /// Commit vs first parent (历史详情); read-only.
    Commit,
}

/// One file's diff request (m1-plan F-18).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffRequest {
    pub path: String,
    pub old_path: Option<String>,
    pub source: DiffSourceKind,
    /// Commit oid when `source` is `commit`.
    pub commit_oid: Option<String>,
}

/// Intra-line highlight span: the differing middle of a paired -/+ line
/// (R-12 词级高亮), measured in UTF-8 bytes from the line content start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WordSpan {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DiffLineKind {
    Context,
    Added,
    Deleted,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
    /// Line content WITHOUT the trailing newline.
    pub content: String,
    /// Differing byte span for a line that is word-paired with its neighbor.
    pub word: Option<WordSpan>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    /// Original `@@ -a,b +c,d @@ ctx` header text.
    pub header: String,
    pub old_start: u32,
    pub new_start: u32,
    pub lines: Vec<DiffLine>,
}

/// One file's unified diff (m1-plan R-12).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffResponse {
    pub repo_id: RepoId,
    pub path: String,
    pub old_path: Option<String>,
    pub kind: ChangeKind,
    pub added: u32,
    pub deleted: u32,
    pub is_binary: bool,
    /// True when the payload was capped (huge files fold in the UI).
    pub truncated: bool,
    pub hunks: Vec<DiffHunk>,
}

/// Line selection inside one hunk (m1-plan R-13): indexes into that hunk's
/// `lines` array; only added/deleted rows are selectable.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SelectedHunk {
    pub hunk_index: u32,
    pub line_indexes: Vec<u32>,
}

/// Stages (or unstages, per `source`) the selected hunks/lines by regenerating
/// a filtered patch and applying it to the index (`git apply --cached`).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StageLinesRequest {
    pub path: String,
    pub source: DiffSourceKind,
    pub hunks: Vec<SelectedHunk>,
}

/// One local branch for the branch board (m1-plan F-21 / R-15).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    /// Short name, e.g. `main`, `feature/dag`.
    pub name: String,
    /// The branch HEAD points at (false when HEAD is detached).
    pub is_current: bool,
    /// Upstream short name, e.g. `origin/main`; None when unset (W9).
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub tip_oid: String,
    pub tip_subject: String,
    /// Tip commit author time, epoch seconds.
    pub tip_time: f64,
}

/// One tag (m1-plan R-17).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    /// The peeled commit the tag ultimately points at.
    pub target_oid: String,
    pub annotated: bool,
    /// Annotation message for annotated tags.
    pub message: Option<String>,
    /// Tag creation time (annotated) or target commit time (lightweight).
    pub time: f64,
}

/// One entry of the stash list, newest first (m1-plan R-18).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    /// Index inside the stash reflog; 0 is the newest.
    pub index: u32,
    /// Auto-generated message like `WIP on main: abc1234 subject`.
    pub message: String,
    pub oid: String,
}
