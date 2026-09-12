//! Error model (TDD §6). Serialized as a flat tagged enum
//! `{ code, ...params }`; humanized Chinese copy lives in the frontend
//! mapping table (`src/lib/ipc/errors.ts`) so wording never requires a Rust
//! rebuild. Destructive operations pass through eg-safety, which turns
//! `UnsafeOperation` into an explicit confirmation round-trip.

use serde::Serialize;
use specta::Type;

#[derive(Debug, Clone, Serialize, Type, thiserror::Error)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum EgError {
    /// Path is not a Git repository (or cannot be opened).
    RepoNotFound { path: String },
    /// The worktree has uncommitted changes that the operation would clobber.
    DirtyWorktree { paths: Vec<String> },
    /// Remote connection failed; `kind` distinguishes dns/timeout/proxy.
    Network { kind: String, url: String },
    /// Remote rejected our credentials.
    Auth { provider: String },
    /// Repository is mid-merge/rebase with unresolved conflicts.
    ConflictState { state: String },
    /// Destructive operation requires an explicit UI confirmation round-trip.
    UnsafeOperation { confirm_required: String },
    /// Feature exists in the model but is not implemented yet.
    NotSupported { feature: String },
    /// The `git` executable is not available on PATH (PRD §7: EasyGit never
    /// bundles git; the UI guides the user through installing it instead).
    GitMissing,
    /// A long task was cancelled by the user.
    Cancelled,
    /// Anything unexpected; `context` lands in the local log file.
    #[serde(rename = "internal")]
    Internal { context: String },
}

impl EgError {
    /// Stable machine-readable code, mirroring the serde tag.
    pub fn code(&self) -> &'static str {
        match self {
            EgError::RepoNotFound { .. } => "repo_not_found",
            EgError::DirtyWorktree { .. } => "dirty_worktree",
            EgError::Network { .. } => "network",
            EgError::Auth { .. } => "auth",
            EgError::ConflictState { .. } => "conflict_state",
            EgError::UnsafeOperation { .. } => "unsafe_operation",
            EgError::NotSupported { .. } => "not_supported",
            EgError::GitMissing => "git_missing",
            EgError::Cancelled => "cancelled",
            EgError::Internal { .. } => "internal",
        }
    }

    /// True when the error is UI control flow rather than a malfunction
    /// (worktree guards, confirmations, mid-merge states, user cancellation).
    /// The logging layer keeps these off error level so real failures stay
    /// visible in the file sink.
    pub fn is_expected(&self) -> bool {
        matches!(
            self,
            EgError::DirtyWorktree { .. }
                | EgError::ConflictState { .. }
                | EgError::UnsafeOperation { .. }
                | EgError::NotSupported { .. }
                | EgError::Cancelled
        )
    }
}

impl std::fmt::Display for EgError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // English developer-facing text; user-facing copy is the frontend's job.
        write!(f, "{}", self.code())
    }
}
