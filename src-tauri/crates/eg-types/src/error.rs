//! Error model (TDD §6). Serialized as a flat tagged enum
//! `{ code, ...params }`; humanized Chinese copy lives in the frontend
//! mapping table (`src/lib/ipc/errors.ts`) so wording never requires a Rust
//! rebuild. Destructive operations pass through eg-safety, which turns
//! `UnsafeOperation` into an explicit confirmation round-trip.

use serde::Serialize;
use specta::Type;

use crate::SshTarget;

#[derive(Debug, Clone, Serialize, Type, thiserror::Error)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum EgError {
    /// Path is not a Git repository (or cannot be opened). `detail` carries
    /// the underlying libgit2/IO message when there is one.
    RepoNotFound {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    /// SSH remote directory exists but is not a Git repository (and the user
    /// has not initialized one yet). The frontend uses `exists` to offer a
    /// guided `git init`; a missing path stays under `RepoNotFound` to avoid
    /// inviting the user to create something that was simply mistyped.
    SshNotARepo {
        target: SshTarget,
        exists: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    /// The repository exists but its folder is owned by another user, and the
    /// real git CLI agrees with the refusal (libgit2-only refusals are aligned
    /// away silently in eg-git-core). The user must explicitly allow the
    /// folder via `safe.directory`.
    RepoOwnership {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    /// The worktree has uncommitted changes that the operation would clobber.
    DirtyWorktree { paths: Vec<String> },
    /// Remote connection failed; `kind` distinguishes dns/timeout/proxy.
    /// `detail` carries the redacted git stderr tail (the actual reason).
    Network {
        kind: String,
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    /// Remote rejected our credentials. SSH failures carry the target host so
    /// the frontend can route them to the SSH setup wizard instead of the
    /// HTTPS username/password dialog.
    Auth {
        provider: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        host: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    /// The server's SSH host key is not trusted yet (first connection) or no
    /// longer matches `known_hosts` (possible MITM). The UI must show the
    /// fingerprint and let the user confirm before anything is written;
    /// `changed` distinguishes the dangerous direction.
    SshHostKey {
        host: String,
        port: u16,
        changed: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        fingerprint: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        key_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    /// Repository is mid-merge/rebase with unresolved conflicts.
    ConflictState {
        state: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
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
            // Must match the serde tag specta derives from the variant name
            // (`rename_all = "snake_case"`): `SshNotARepo` -> `ssh_not_a_repo`.
            // A mismatch here silently breaks every frontend code match.
            EgError::SshNotARepo { .. } => "ssh_not_a_repo",
            EgError::RepoOwnership { .. } => "repo_ownership",
            EgError::DirtyWorktree { .. } => "dirty_worktree",
            EgError::Network { .. } => "network",
            EgError::Auth { .. } => "auth",
            EgError::SshHostKey { .. } => "ssh_host_key",
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
                | EgError::SshHostKey { .. }
                | EgError::Cancelled
        ) || matches!(
            self,
            EgError::Auth { provider, .. } if provider.starts_with("ssh-")
        )
    }
}

impl std::fmt::Display for EgError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // English developer-facing text; user-facing copy is the frontend's job.
        write!(f, "{}", self.code())
    }
}
