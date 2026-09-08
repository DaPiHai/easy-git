//! Three-zone working-tree status (m1-plan R-02), matching
//! `git status` semantics: staged = index-vs-HEAD, unstaged = worktree-vs-index
//! (plus untracked), conflicted = unresolved merge entries. Untracked
//! directories stay collapsed into one `dir/` entry, like git.

use eg_types::{ChangeEntry, ChangeKind, EgError, StatusReport};

use super::repo;

fn to_kind(flags: git2::Status, staged: bool) -> Option<ChangeKind> {
    let kind = if staged {
        if flags.contains(git2::Status::INDEX_NEW) {
            ChangeKind::Added
        } else if flags.contains(git2::Status::INDEX_MODIFIED) {
            ChangeKind::Modified
        } else if flags.contains(git2::Status::INDEX_DELETED) {
            ChangeKind::Deleted
        } else if flags.contains(git2::Status::INDEX_RENAMED) {
            ChangeKind::Renamed
        } else {
            return None;
        }
    } else if flags.contains(git2::Status::WT_NEW) {
        ChangeKind::Untracked
    } else if flags.contains(git2::Status::WT_MODIFIED)
        || flags.contains(git2::Status::WT_TYPECHANGE)
    {
        ChangeKind::Modified
    } else if flags.contains(git2::Status::WT_DELETED) {
        ChangeKind::Deleted
    } else if flags.contains(git2::Status::WT_RENAMED) {
        ChangeKind::Renamed
    } else {
        return None;
    };
    Some(kind)
}

pub fn status(repo_id: &str, repo: &git2::Repository) -> Result<StatusReport, EgError> {
    if repo.is_bare() {
        return Err(EgError::NotSupported {
            feature: "bare repository status".into(),
        });
    }

    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true)
        .exclude_submodules(true)
        .include_ignored(false);

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| EgError::Internal {
            context: format!("status failed: {e}"),
        })?;

    let mut report = StatusReport {
        repo_id: repo_id.to_string(),
        branch: repo::current_branch(repo),
        head_oid: repo
            .head()
            .ok()
            .and_then(|h| h.target())
            .map(|t| t.to_string()),
        staged: Vec::new(),
        unstaged: Vec::new(),
        conflicted: Vec::new(),
    };

    for entry in statuses.iter() {
        let flags = entry.status();
        let path = match entry.path() {
            Ok(p) if !p.is_empty() => p.to_string(),
            _ => continue,
        };

        if flags.contains(git2::Status::CONFLICTED) {
            report.conflicted.push(ChangeEntry {
                path,
                old_path: None,
                kind: ChangeKind::Conflicted,
            });
            continue;
        }

        if let Some(kind) = to_kind(flags, true) {
            // For renames libgit2 reports the old path as the entry path; the
            // delta's new_file is the authoritative current path.
            let delta = entry.head_to_index();
            let staged_path = delta
                .as_ref()
                .and_then(|d| d.new_file().path().map(|p| p.to_string_lossy().to_string()))
                .unwrap_or_else(|| path.clone());
            report.staged.push(ChangeEntry {
                old_path: delta
                    .and_then(|d| d.old_file().path().map(|p| p.to_string_lossy().to_string())),
                path: staged_path,
                kind,
            });
        }
        if let Some(kind) = to_kind(flags, false) {
            report.unstaged.push(ChangeEntry {
                old_path: entry
                    .index_to_workdir()
                    .and_then(|d| d.old_file().path().map(|p| p.to_string_lossy().to_string())),
                path,
                kind,
            });
        }
    }

    Ok(report)
}
