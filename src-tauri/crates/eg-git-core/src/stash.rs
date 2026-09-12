//! Stash operations (m1-plan R-18): push (with untracked), apply/pop/drop.
//! Stash entries live on refs/stash as a reflog; libgit2 drives everything.

use eg_types::{EgError, StatusReport};

use crate::status;
use git2::Repository;

fn err(context: &'static str) -> impl Fn(git2::Error) -> EgError {
    move |e| EgError::Internal {
        context: format!("stash {context} failed: {e}"),
    }
}

fn identity(repo: &Repository) -> git2::Signature<'static> {
    // Stash is a local safety mechanism; fall back to a fixed identity when
    // user.name/user.email are not configured (unlike commits, stashes are
    // never attributed).
    let config = repo.config().ok();
    let name = config
        .as_ref()
        .and_then(|c| c.get_string("user.name").ok())
        .unwrap_or_else(|| "EasyGit".to_string());
    let email = config
        .as_ref()
        .and_then(|c| c.get_string("user.email").ok())
        .unwrap_or_else(|| "easygit@invalid".to_string());
    git2::Signature::now(&name, &email).expect("signature")
}

/// Saves worktree + index into a new stash entry and cleans the worktree.
/// Untracked files join the stash when `include_untracked` is set.
pub fn stash_push(
    repo: &mut Repository,
    repo_id: &str,
    message: Option<&str>,
    include_untracked: bool,
) -> Result<StatusReport, EgError> {
    // A clean worktree has nothing to stash; libgit2 would error cryptically.
    let dirty = {
        let statuses = repo.statuses(None).map_err(err("status"))?;
        statuses.iter().any(|e| !e.status().is_empty())
    };
    if !dirty {
        return Err(EgError::Internal {
            context: "工作区是干净的，没有可储藏的修改".into(),
        });
    }

    let mut flags = git2::StashFlags::empty();
    if include_untracked {
        flags.insert(git2::StashFlags::INCLUDE_UNTRACKED);
    }
    let sig = identity(repo);
    repo.stash_save2(&sig, message, Some(flags))
        .map_err(|e| EgError::Internal {
            context: format!("储藏失败：{e}"),
        })?;
    status::status(repo_id, repo)
}

/// Applies stash `index`; with `pop` the entry is dropped afterwards. Index
/// changes are reinstated so a stash round-trip is lossless (m1-plan exit).
pub fn stash_apply(
    repo: &mut Repository,
    repo_id: &str,
    index: u32,
    pop: bool,
) -> Result<StatusReport, EgError> {
    let mut options = git2::StashApplyOptions::new();
    options.reinstantiate_index();
    repo.stash_apply(index as usize, Some(&mut options))
        .map_err(|e| EgError::ConflictState {
            state: format!("储藏应用冲突：{e}"),
            detail: None,
        })?;
    if pop {
        repo.stash_drop(index as usize).map_err(err("drop"))?;
    }
    status::status(repo_id, repo)
}

/// Drops stash `index` (destructive; the UI confirms first). The stash commit
/// itself survives in the object database until a gc, like real git.
pub fn stash_drop(repo: &mut Repository, index: u32) -> Result<Vec<eg_types::StashEntry>, EgError> {
    repo.stash_drop(index as usize).map_err(err("drop"))?;
    list_stashes(repo)
}

pub fn list_stashes(repo: &mut Repository) -> Result<Vec<eg_types::StashEntry>, EgError> {
    let mut entries = Vec::new();
    repo.stash_foreach(|index, message, oid| {
        entries.push(eg_types::StashEntry {
            index: index as u32,
            message: message.to_string(),
            oid: oid.to_string(),
        });
        true
    })
    .map_err(err("list"))?;
    Ok(entries)
}
