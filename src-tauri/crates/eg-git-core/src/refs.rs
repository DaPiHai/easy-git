//! Branch and tag operations (m1-plan R-15/R-16/R-17): CRUD, safe switch
//! with dirty-worktree detection, and delete-into-recycle-bin so the 撤销
//! toast can restore either. Tag deletion uses the same trash flow.

use eg_types::{BranchInfo, EgError, StatusReport, TagInfo};
use git2::build::CheckoutBuilder;
use git2::{BranchType, Repository};

use crate::status;

fn err(context: &'static str) -> impl Fn(git2::Error) -> EgError {
    move |e| EgError::Internal {
        context: format!("refs {context} failed: {e}"),
    }
}

fn branch_err(context: &'static str) -> impl Fn(git2::Error) -> EgError {
    move |e| EgError::Internal {
        context: format!("branch {context} failed: {e}"),
    }
}

/// Tip metadata shared by branches and tags.
fn tip_of(
    _repo: &Repository,
    reference: &git2::Reference<'_>,
) -> Result<(String, String, f64), EgError> {
    let commit = reference.peel_to_commit().map_err(err("peel"))?;
    Ok((
        commit.id().to_string(),
        commit
            .summary()
            .unwrap_or_default()
            .unwrap_or("")
            .to_string(),
        commit.time().seconds() as f64,
    ))
}

/// All local branches, current branch first (m1-plan F-21).
pub fn list_branches_info(repo: &Repository) -> Result<Vec<BranchInfo>, EgError> {
    let mut branches = Vec::new();
    let iter = repo
        .branches(Some(BranchType::Local))
        .map_err(branch_err("list"))?;
    for branch in iter {
        let (branch, _) = branch.map_err(branch_err("list"))?;
        let name = branch.name().unwrap_or(None).unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let reference = branch.get();
        let (tip_oid, tip_subject, tip_time) = tip_of(repo, reference)?;
        let (upstream, ahead, behind) = match branch.upstream() {
            Ok(up) => {
                let up_oid = up.get().peel_to_commit().map_err(err("peel"))?.id();
                let (a, b) = repo
                    .graph_ahead_behind(
                        reference.peel_to_commit().map_err(err("peel"))?.id(),
                        up_oid,
                    )
                    .map_err(err("graph"))?;
                (
                    up.get().shorthand().unwrap_or("").to_string(),
                    a as u32,
                    b as u32,
                )
            }
            Err(_) => (String::new(), 0, 0),
        };
        branches.push(BranchInfo {
            is_current: branch.is_head(),
            upstream: if upstream.is_empty() {
                None
            } else {
                Some(upstream)
            },
            ahead,
            behind,
            name,
            tip_oid,
            tip_subject,
            tip_time,
        });
    }
    branches.sort_by(|a, b| {
        b.is_current
            .cmp(&a.is_current)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(branches)
}

/// Creates a branch at `oid` (hex) or HEAD; refuses duplicates (R-15).
pub fn create_branch(
    repo: &Repository,
    name: &str,
    oid: Option<&str>,
) -> Result<BranchInfo, EgError> {
    let target = match oid {
        Some(hex) => {
            let id = git2::Oid::from_str(hex).map_err(|e| EgError::Internal {
                context: format!("invalid commit id: {e}"),
            })?;
            repo.find_commit(id).map_err(err("find commit"))?
        }
        None => repo
            .head()
            .map_err(err("head"))?
            .peel_to_commit()
            .map_err(err("peel"))?,
    };
    repo.branch(name, &target, false)
        .map_err(|e| EgError::Internal {
            context: format!("创建分支失败（名称不合法或已存在）：{e}"),
        })?;
    let created = repo
        .find_branch(name, BranchType::Local)
        .map_err(branch_err("find"))?;
    let (tip_oid, tip_subject, tip_time) = tip_of(repo, created.get())?;
    Ok(BranchInfo {
        name: name.to_string(),
        is_current: created.is_head(),
        upstream: None,
        ahead: 0,
        behind: 0,
        tip_oid,
        tip_subject,
        tip_time,
    })
}

/// Renames a branch; renaming the current branch moves HEAD with it (R-15).
pub fn rename_branch(repo: &Repository, old_name: &str, new_name: &str) -> Result<(), EgError> {
    let mut branch = repo
        .find_branch(old_name, BranchType::Local)
        .map_err(branch_err("find"))?;
    branch
        .rename(new_name, false)
        .map_err(|e| EgError::Internal {
            context: format!("重命名失败（名称不合法或已存在）：{e}"),
        })?;
    Ok(())
}

/// Deletes a branch into the recycle bin (R-16): a trash ref keeps the tip
/// alive and a RefDelete record powers the 撤销 toast. The current branch
/// cannot be deleted (same as git).
pub fn delete_branch(
    repo: &Repository,
    repo_id: &str,
    safety: &eg_safety::Safety,
    name: &str,
) -> Result<String, EgError> {
    let mut branch = repo
        .find_branch(name, BranchType::Local)
        .map_err(branch_err("find"))?;
    if branch.is_head() {
        return Err(EgError::Internal {
            context: "不能删除当前所在的分支，请先切换到其他分支".into(),
        });
    }
    let target = branch.get().peel_to_commit().map_err(err("peel"))?.id();

    let op_id = uuid::Uuid::new_v4().to_string();
    let trash_ref = format!("{}/branch-{op_id}", eg_safety::TRASH_REF_PREFIX);
    repo.reference(&trash_ref, target, true, &format!("branch:{name}"))
        .map_err(err("trash"))?;
    safety
        .record(
            repo_id,
            &eg_safety::OpRecord {
                op_id: op_id.clone(),
                time: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
                kind: eg_safety::OpKind::RefDelete,
                paths: vec![name.to_string()],
                snapshot_ref: Some(trash_ref),
                undone: false,
            },
        )
        .map_err(|e| EgError::Internal {
            context: format!("安全日志写入失败：{e}"),
        })?;

    branch.delete().map_err(branch_err("delete"))?;
    Ok(op_id)
}

/// Switches to `name` (R-15). A dirty worktree (tracked changes or untracked
/// files the target branch would overwrite) aborts with `dirty_worktree` so
/// the UI can suggest stashing first.
pub fn switch_branch(
    repo: &Repository,
    repo_id: &str,
    name: &str,
) -> Result<StatusReport, EgError> {
    let branch = repo
        .find_branch(name, BranchType::Local)
        .map_err(branch_err("find"))?;
    let target_commit = branch.get().peel_to_commit().map_err(err("peel"))?;

    // Dirty check: tracked modifications block the switch; untracked files
    // block only when the target branch contains the same path.
    let mut dirty = Vec::new();
    let statuses = repo.statuses(None).map_err(err("status"))?;
    for entry in statuses.iter() {
        let Ok(path) = entry.path() else { continue };
        let flags = entry.status();
        let tracked_dirty = flags.intersects(
            git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED
                | git2::Status::INDEX_TYPECHANGE
                | git2::Status::WT_MODIFIED
                | git2::Status::WT_DELETED
                | git2::Status::WT_RENAMED
                | git2::Status::WT_TYPECHANGE,
        );
        let untracked_conflict = flags.contains(git2::Status::WT_NEW)
            && target_commit
                .tree()
                .and_then(|t| t.get_path(std::path::Path::new(path)))
                .is_ok();
        if tracked_dirty || untracked_conflict {
            dirty.push(path.to_string());
        }
    }
    if !dirty.is_empty() {
        return Err(EgError::DirtyWorktree { paths: dirty });
    }

    repo.set_head(&format!("refs/heads/{name}"))
        .map_err(branch_err("set head"))?;
    // Safe checkout: only reachable with a clean worktree, but a conflict
    // (e.g. an untracked file racing in) still surfaces as dirty_worktree.
    repo.checkout_head(Some(&mut CheckoutBuilder::new()))
        .map_err(|_| EgError::DirtyWorktree { paths: Vec::new() })?;
    status::status(repo_id, repo)
}

/// All tags, newest creation time first (m1-plan R-17).
pub fn list_tags(repo: &Repository) -> Result<Vec<TagInfo>, EgError> {
    let mut tags = Vec::new();
    let refs = repo.references().map_err(err("list"))?;
    for reference in refs {
        let Ok(reference) = reference else { continue };
        let Ok(full) = reference.name() else { continue };
        let Some(name) = full.strip_prefix("refs/tags/") else {
            continue;
        };
        if let Ok(tag) = reference.peel_to_tag() {
            let message = tag.message().unwrap_or(None).map(str::to_string);
            let time = tag.tagger().map(|s| s.when().seconds() as f64);
            tags.push(TagInfo {
                name: name.to_string(),
                target_oid: tag.target_id().to_string(),
                annotated: true,
                message,
                time: time.unwrap_or_default(),
            });
        } else if let Ok(commit) = reference.peel_to_commit() {
            tags.push(TagInfo {
                name: name.to_string(),
                target_oid: commit.id().to_string(),
                annotated: false,
                message: None,
                time: commit.time().seconds() as f64,
            });
        }
    }
    tags.sort_by(|a, b| b.time.total_cmp(&a.time).then_with(|| a.name.cmp(&b.name)));
    Ok(tags)
}

/// Creates a lightweight or (with `message`) annotated tag at `oid` (R-17).
pub fn create_tag(
    repo: &Repository,
    name: &str,
    oid: &str,
    message: Option<&str>,
) -> Result<TagInfo, EgError> {
    let id = git2::Oid::from_str(oid).map_err(|e| EgError::Internal {
        context: format!("invalid commit id: {e}"),
    })?;
    let target = repo.find_object(id, None).map_err(err("find object"))?;
    let tagger = || git2::Signature::now("EasyGit", "easygit@invalid");
    match message {
        Some(msg) if !msg.trim().is_empty() => {
            let sig = tagger().map_err(err("signature"))?;
            repo.tag(name, &target, &sig, msg, false)
                .map_err(|e| EgError::Internal {
                    context: format!("创建标签失败（名称不合法或已存在）：{e}"),
                })?;
        }
        _ => {
            repo.tag_lightweight(name, &target, false)
                .map_err(|e| EgError::Internal {
                    context: format!("创建标签失败（名称不合法或已存在）：{e}"),
                })?;
        }
    }
    let reference = repo
        .find_reference(&format!("refs/tags/{name}"))
        .map_err(err("find tag"))?;
    let (target_oid, _subject, commit_time) = tip_of(repo, &reference)?;
    let annotated = reference.peel_to_tag().is_ok();
    let message = reference
        .peel_to_tag()
        .ok()
        .and_then(|t| t.message().unwrap_or(None).map(str::to_string));
    let time = reference
        .peel_to_tag()
        .ok()
        .and_then(|t| t.tagger().map(|s| s.when().seconds() as f64))
        .unwrap_or(commit_time);
    Ok(TagInfo {
        name: name.to_string(),
        target_oid,
        annotated,
        message,
        time,
    })
}

/// Deletes a tag into the recycle bin; the 撤销 toast recreates it (R-17).
/// Annotated tags stay annotated: the trash ref keeps the tag object id.
pub fn delete_tag(
    repo: &Repository,
    repo_id: &str,
    safety: &eg_safety::Safety,
    name: &str,
) -> Result<String, EgError> {
    let mut reference = repo
        .find_reference(&format!("refs/tags/{name}"))
        .map_err(err("find tag"))?;
    let target = reference.target().ok_or_else(|| EgError::Internal {
        context: "tag reference has no direct target".into(),
    })?;

    let op_id = uuid::Uuid::new_v4().to_string();
    let trash_ref = format!("{}/tag-{op_id}", eg_safety::TRASH_REF_PREFIX);
    repo.reference(&trash_ref, target, true, &format!("tag:{name}"))
        .map_err(err("trash"))?;
    safety
        .record(
            repo_id,
            &eg_safety::OpRecord {
                op_id: op_id.clone(),
                time: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
                kind: eg_safety::OpKind::RefDelete,
                paths: vec![name.to_string()],
                snapshot_ref: Some(trash_ref),
                undone: false,
            },
        )
        .map_err(|e| EgError::Internal {
            context: format!("安全日志写入失败：{e}"),
        })?;
    reference.delete().map_err(err("delete"))?;
    Ok(op_id)
}
