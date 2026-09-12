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

/// Environment probe result (PRD §7: detect system git ≥ 2.30, guide the
/// install when missing). `git_version` is `None` when no usable `git`
/// answers on PATH.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EnvStatus {
    pub git_version: Option<String>,
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

/// Result of starting a merge (m1-plan R-19).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    /// True when the branch was fast-forwarded (no merge commit created).
    pub fast_forwarded: bool,
    /// Conflicted paths when the merge stopped for manual resolution.
    pub conflicts: Vec<String>,
    pub status: StatusReport,
}

/// Mid-merge state detected from `.git/MERGE_HEAD` (m1-plan R-19/F-24).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeState {
    /// Prefilled merge commit message (from MERGE_MSG).
    pub message: Option<String>,
    /// Names (or short oids) of the branches being merged in.
    pub theirs: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ResetMode {
    /// Move HEAD only; index keeps the changes (撤销最近一次提交，保留暂存).
    Soft,
    /// Move HEAD + reset index; worktree untouched (修改留在工作区).
    Mixed,
    /// Move HEAD + index + worktree; destructive, snapshot-protected.
    Hard,
}

/// Result of a reset; `op_id` is Some for hard resets (撤销 toast).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResetOutcome {
    pub op_id: Option<String>,
    pub status: StatusReport,
}

/// One `<<<<<<<…=======…>>>>>>>` region of a conflicted file (m1-plan R-21).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictBlock {
    /// Lines from our side (between <<<<<<< and =======).
    pub ours: Vec<String>,
    /// Lines from their side (between ======= and >>>>>>>).
    pub theirs: Vec<String>,
}

/// One conflicted file for the wizard (m1-plan R-21 / F-24).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    /// Full three-stage contents when available (IndexConflict stages).
    pub base_content: Option<String>,
    pub ours_content: Option<String>,
    pub theirs_content: Option<String>,
    /// Marker-parsed regions; `segments.len() == blocks.len() + 1` when the
    /// file was parseable, so composing is segments interleaved with blocks.
    pub segments: Vec<String>,
    pub blocks: Vec<ConflictBlock>,
    pub is_binary: bool,
}

/// One configured remote (m1-plan R-24 / F-29).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
    /// Distinct push URL when configured (rare; None means same as url).
    pub push_url: Option<String>,
}

/// HTTPS username/password for pushing to legacy servers (R-22 auth
/// fallback). Session-memory only on the frontend: never persisted, never
/// logged, and forwarded to the git CLI via an ephemeral askpass helper.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PushCredentials {
    pub username: String,
    pub password: String,
}

/// How pull integrates a fetched upstream (F-27 分叉情况选择).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SyncStrategy {
    /// Fast-forward or refuse (git pull --ff-only).
    FfOnly,
    /// Merge into the current branch; conflicts land in the wizard (W8).
    Merge,
}

/// One line of the 操作时间线 (m1-plan F-28, UI §6.10): reflog entries and
/// eg-safety operation records merged into a single feed.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEntry {
    /// Commit oid the entry points at (reflog: id_new; op log: target).
    pub oid: Option<String>,
    pub subject: String,
    /// commit | merge | reset | discard | clean | ref_delete | fetch | other
    pub kind: String,
    /// Danger entries get the danger outline (重置/强推/丢弃/删除).
    pub danger: bool,
    /// Unix epoch seconds (f64 — specta forbids BigInt-style types).
    pub time: f64,
}

/// Availability of the bottom-bar 撤销/重做 buttons (m1-plan R-25).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UndoRedoState {
    /// Op id of the latest non-undone record (undoable), if any.
    pub undoable_op_id: Option<String>,
    /// Human label for the undo toast target (e.g. 丢弃修改).
    pub undoable_label: String,
    /// True when some undone record exists to replay.
    pub redoable: bool,
}
