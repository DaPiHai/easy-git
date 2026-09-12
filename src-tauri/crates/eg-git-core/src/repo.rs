//! Repository open/summarize helpers (m1-plan R-01).

use std::path::Path;

use eg_types::{EgError, RepoSummary};

/// Opens the repository containing `path`, searching upwards like real git.
pub fn open(path: &Path) -> Result<git2::Repository, EgError> {
    git2::Repository::discover(path).map_err(|e| EgError::RepoNotFound {
        path: path.display().to_string(),
        detail: Some(e.to_string()),
    })
}

/// `git init` at `path`. Opening a directory that already is a repository is
/// idempotent (returns `Ok`), matching the wizard's expectation.
pub fn init(path: &Path) -> Result<(), EgError> {
    if path.join(".git").exists() {
        return Ok(());
    }
    git2::Repository::init(path)
        .map_err(|e| EgError::Internal {
            context: format!("git init failed: {e}"),
        })
        .map(drop)
}

/// True when HEAD points at a nonexistent ref (fresh `git init`).
pub fn head_is_unborn(repo: &git2::Repository) -> bool {
    matches!(repo.head(), Err(e) if e.code() == git2::ErrorCode::UnbornBranch)
}

/// Short branch name; `None` for unborn or detached HEAD.
pub fn current_branch(repo: &git2::Repository) -> Option<String> {
    let head = repo.head().ok()?;
    if head.is_branch() {
        head.shorthand().ok().map(str::to_string)
    } else {
        None
    }
}

fn head_commit(repo: &git2::Repository) -> Option<git2::Commit<'_>> {
    repo.head().ok()?.peel_to_commit().ok()
}

/// Builds the switcher/wizard summary: branch, HEAD oid, ahead/behind vs the
/// configured upstream (zeros when there is none or HEAD is unborn).
pub fn summarize(
    repo_id: &str,
    repo: &git2::Repository,
    path: &Path,
) -> Result<RepoSummary, EgError> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string());

    let head_oid = head_commit(repo).map(|c| c.id().to_string());
    let is_empty = head_oid.is_none();

    let mut ahead = 0;
    let mut behind = 0;
    if let Ok(head) = repo.head() {
        let local = head.target();
        let upstream = git2::Branch::wrap(head)
            .upstream()
            .ok()
            .and_then(|b| b.get().target());
        if let (Some(local), Some(upstream)) = (local, upstream) {
            if let Ok((a, b)) = repo.graph_ahead_behind(local, upstream) {
                ahead = a as u32;
                behind = b as u32;
            }
        }
    }

    Ok(RepoSummary {
        repo_id: repo_id.to_string(),
        path: path.display().to_string(),
        name,
        branch: current_branch(repo),
        head_oid,
        ahead,
        behind,
        is_empty,
    })
}
