//! Merge (m1-plan R-19), revert and reset (R-20). A conflicted merge is
//! parked the git way: merged index with conflict stages on disk plus
//! `.git/MERGE_HEAD`/`MERGE_MSG`, so `status` shows conflicts and the final
//! commit goes through the regular commit path (which reads MERGE_HEAD for
//! the second parent).

use eg_types::{EgError, MergeOutcome, MergeState, ResetMode, ResetOutcome, StatusReport};
use git2::build::CheckoutBuilder;
use git2::{AnnotatedCommit, Repository, ResetType};

use crate::status;

fn err(context: &'static str) -> impl Fn(git2::Error) -> EgError {
    move |e| EgError::Internal {
        context: format!("merge {context} failed: {e}"),
    }
}

fn io_err(stage: &'static str) -> impl Fn(std::io::Error) -> EgError {
    move |e| EgError::Internal {
        context: format!("merge {stage} failed: {e}"),
    }
}

fn git_dir(repo: &Repository) -> std::path::PathBuf {
    repo.path().to_path_buf()
}

/// Removes the git-style parking files after a merge is committed or aborted.
pub fn clear_merge_files(repo: &Repository) {
    if let Some(root) = repo.path().to_str().map(str::to_string) {
        for name in ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE"] {
            let _ = std::fs::remove_file(format!("{root}/{name}"));
        }
    }
}

/// Raw MERGE_HEAD tips (oids) for the commit finalize path — unlike
/// `merge_state` these are never prettified into branch names.
pub fn merge_head_oids(repo: &Repository) -> Result<Vec<git2::Oid>, EgError> {
    let raw = std::fs::read_to_string(merge_head_path(repo)).map_err(io_err("read MERGE_HEAD"))?;
    raw.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| {
            git2::Oid::from_str(l).map_err(|e| EgError::Internal {
                context: format!("merge MERGE_HEAD oid invalid: {e}"),
            })
        })
        .collect()
}

/// Path of the git-style `.git/MERGE_HEAD` parking file.
pub fn merge_head_path(repo: &Repository) -> std::path::PathBuf {
    git_dir(repo).join("MERGE_HEAD")
}

pub fn merge_state(repo: &Repository) -> Result<Option<MergeState>, EgError> {
    if !merge_head_path(repo).exists() {
        return Ok(None);
    }
    let raw_head =
        std::fs::read_to_string(merge_head_path(repo)).map_err(|e| EgError::Internal {
            context: format!("merge read MERGE_HEAD failed: {e}"),
        })?;
    let theirs = raw_head
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|oid| {
            let Ok(id) = git2::Oid::from_str(oid.trim()) else {
                return oid.trim().to_string();
            };
            // Prefer a branch/tag name pointing at the oid; else short hash.
            let short = id.to_string()[..7].to_string();
            let mut named = short;
            if let Ok(iter) = repo.references_glob("refs/*") {
                for reference in iter.flatten() {
                    if reference.target() == Some(id) {
                        if let Ok(full) = reference.name() {
                            named = full
                                .trim_start_matches("refs/heads/")
                                .trim_start_matches("refs/tags/")
                                .to_string();
                            break;
                        }
                    }
                }
            }
            named
        })
        .collect();
    let message = std::fs::read_to_string(git_dir(repo).join("MERGE_MSG"))
        .ok()
        .map(|m| m.lines().next().unwrap_or("").trim().to_string())
        .filter(|m| !m.is_empty());
    Ok(Some(MergeState { message, theirs }))
}

/// Blocks a tracked-dirty worktree (merge/revert need a clean tree; untracked
/// files are allowed, like git).
fn ensure_clean(repo: &Repository) -> Result<(), EgError> {
    let statuses = repo.statuses(None).map_err(err("status"))?;
    let dirty: Vec<String> = statuses
        .iter()
        .filter_map(|e| {
            let tracked = e.status().intersects(
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
            if tracked {
                e.path().ok().map(|p| p.to_string())
            } else {
                None
            }
        })
        .collect();
    if dirty.is_empty() {
        Ok(())
    } else {
        Err(EgError::DirtyWorktree { paths: dirty })
    }
}

fn identity(repo: &Repository) -> Result<git2::Signature<'static>, EgError> {
    let config = repo.config().map_err(err("config"))?;
    let name = config.get_string("user.name").ok();
    let email = config.get_string("user.email").ok();
    match (name, email) {
        (Some(name), Some(email)) => git2::Signature::now(&name, &email).map_err(err("signature")),
        _ => Err(EgError::Internal {
            context: "user.name / user.email not configured".into(),
        }),
    }
}

/// Starts merging `name` into the current branch (m1-plan R-19). `no_ff`
/// forces a merge commit even when a fast-forward would be possible; the
/// 简洁-mode default is auto (fast-forward when possible).
pub fn merge_start(
    repo: &mut Repository,
    repo_id: &str,
    name: &str,
    no_ff: bool,
) -> Result<MergeOutcome, EgError> {
    if merge_head_path(repo).exists() {
        return Err(EgError::ConflictState {
            state: "上一次合并尚未完成，请先解决冲突或中止".into(),
        });
    }
    ensure_clean(repo)?;

    let branch_ref = repo
        .find_reference(&format!("refs/heads/{name}"))
        .map_err(err("find branch"))?;
    let their_commit = branch_ref.peel_to_commit().map_err(err("peel"))?;
    let annotated: AnnotatedCommit<'_> = repo
        .reference_to_annotated_commit(&branch_ref)
        .map_err(err("annotated"))?;
    let (analysis, _) = repo
        .merge_analysis(&[&annotated])
        .map_err(err("analysis"))?;

    if analysis.is_up_to_date() {
        return Ok(MergeOutcome {
            fast_forwarded: false,
            conflicts: Vec::new(),
            status: status::status(repo_id, repo)?,
        });
    }

    if analysis.is_fast_forward() && !no_ff {
        // Fast-forward: move the branch ref and check out the target tree.
        let head = repo.head().map_err(err("head"))?;
        let branch_ref_name = head.name().ok().unwrap_or("HEAD").to_string();
        // Safe checkout: tracked files sync to the target tree (including
        // deletions), missing files recreated; an untracked collision still
        // refuses, like real git.
        let mut builder = CheckoutBuilder::new();
        builder.recreate_missing(true);
        repo.checkout_tree(their_commit.as_object(), Some(&mut builder))
            .map_err(|_| EgError::DirtyWorktree { paths: Vec::new() })?;
        repo.reference(
            &branch_ref_name,
            their_commit.id(),
            true,
            &format!("merge: fast-forward {name}"),
        )
        .map_err(err("ff ref"))?;
        return Ok(MergeOutcome {
            fast_forwarded: true,
            conflicts: Vec::new(),
            status: status::status(repo_id, repo)?,
        });
    }

    // Normal merge (diverged or forced no-ff).
    let our_commit = repo
        .head()
        .map_err(err("head"))?
        .peel_to_commit()
        .map_err(err("peel"))?;
    let mut merged = repo
        .merge_commits(&our_commit, &their_commit, None)
        .map_err(err("merge"))?;

    if merged.has_conflicts() {
        // Park the merge: conflict stages go into the on-disk index (the
        // merged index from merge_commits is in-memory only and cannot be
        // written directly), then MERGE_HEAD/MERGE_MSG so status/wizard and
        // real git pick the state up.
        let mut real = repo.index().map_err(err("index"))?;
        real.clear().map_err(err("index clear"))?;
        for entry in merged.iter() {
            real.add(&entry).map_err(err("index add"))?;
        }
        real.write().map_err(err("index write"))?;
        std::fs::write(merge_head_path(repo), format!("{}\n", their_commit.id()))
            .map_err(io_err("write MERGE_HEAD"))?;
        std::fs::write(
            git_dir(repo).join("MERGE_MSG"),
            format!("Merge branch '{name}'\n"),
        )
        .map_err(io_err("write MERGE_MSG"))?;
        let conflicts: Vec<String> = merged
            .conflicts()
            .map_err(err("conflicts"))?
            .filter_map(|c| c.ok())
            .filter_map(|c| {
                let path = c
                    .our
                    .as_ref()
                    .or(c.their.as_ref())
                    .or(c.ancestor.as_ref())
                    .map(|e| String::from_utf8_lossy(&e.path).replace('\\', "/"))?;
                write_conflict_workdir(repo, &c, &path, name);
                Some(path)
            })
            .collect();
        return Ok(MergeOutcome {
            fast_forwarded: false,
            conflicts,
            status: status::status(repo_id, repo)?,
        });
    }

    // Clean merge: commit right away with two parents.
    let tree_id = merged.write_tree_to(repo).map_err(err("write tree"))?;
    let tree = repo.find_tree(tree_id).map_err(err("find tree"))?;
    let sig = identity(repo)?;
    let message = format!("Merge branch '{name}'");
    let _commit_id = repo
        .commit(
            Some("HEAD"),
            &sig,
            &sig,
            &message,
            &tree,
            &[&our_commit, &their_commit],
        )
        .map_err(|e| EgError::Internal {
            context: format!("merge commit failed: {e}"),
        })?;
    // Real git leaves the workdir at the merged tree; sync it in.
    let mut builder = CheckoutBuilder::new();
    builder.recreate_missing(true);
    repo.checkout_head(Some(&mut builder))
        .map_err(err("checkout merged"))?;
    Ok(MergeOutcome {
        fast_forwarded: false,
        conflicts: Vec::new(),
        status: status::status(repo_id, repo)?,
    })
}

/// Writes one conflicted file into the workdir with `<<<<<<<` markers (real
/// git's merge behavior; the wizard parses these back). Binary files keep
/// the ours content on disk, like git.
fn write_conflict_workdir(
    repo: &Repository,
    conflict: &git2::IndexConflict,
    path: &str,
    name: &str,
) -> Option<()> {
    let workdir = repo.workdir()?;
    let blob = |entry: &Option<git2::IndexEntry>| -> Option<Vec<u8>> {
        let entry = entry.as_ref()?;
        Some(repo.find_blob(entry.id).ok()?.content().to_vec())
    };
    let ours = blob(&conflict.our)?;
    let theirs = blob(&conflict.their)?;
    let is_binary = ours.contains(&0) || theirs.contains(&0);
    let content = if is_binary {
        ours
    } else {
        let mut out = Vec::new();
        for (label, body) in [("<<<<<<< HEAD\n", &ours), ("=======\n", &theirs)] {
            out.extend_from_slice(label.as_bytes());
            out.extend_from_slice(body);
            if !body.ends_with(b"\n") {
                out.push(b'\n');
            }
        }
        out.extend_from_slice(format!(">>>>>>> {name}\n").as_bytes());
        out
    };
    std::fs::write(workdir.join(path), content).ok()
}

/// Aborts a parked merge: clears MERGE_* and hard-resets to HEAD (the
/// pre-merge worktree was verified clean, so nothing user-made is lost).
pub fn merge_abort(repo: &mut Repository, repo_id: &str) -> Result<StatusReport, EgError> {
    if !merge_head_path(repo).exists() {
        return Err(EgError::Internal {
            context: "当前没有进行中的合并".into(),
        });
    }
    clear_merge_files(repo);
    let head = repo
        .head()
        .map_err(err("head"))?
        .peel_to_commit()
        .map_err(err("peel"))?;
    repo.reset(head.as_object(), ResetType::Hard, None)
        .map_err(err("abort reset"))?;
    status::status(repo_id, repo)
}

/// Reverts the given commits into the index + worktree (m1-plan R-20).
/// Requires a clean tree; a mid-sequence failure rolls everything back to
/// the original HEAD so no half-reverted state is left behind.
///
/// libgit2's `repo.revert` always uses HEAD as "ours", so sequential
/// reverts cannot stack staged results. Each step is therefore a plain
/// three-way tree merge: base = the commit being reverted, theirs = its
/// parent, ours = the current index — exactly what `git revert --no-commit`
/// accumulates.
pub fn revert_commits(
    repo: &mut Repository,
    repo_id: &str,
    oids: &[String],
) -> Result<StatusReport, EgError> {
    ensure_clean(repo)?;
    let original_head = repo
        .head()
        .map_err(err("head"))?
        .peel_to_commit()
        .map_err(err("peel"))?;

    for hex in oids {
        let id = git2::Oid::from_str(hex.trim()).map_err(|e| EgError::Internal {
            context: format!("invalid commit id: {e}"),
        })?;
        let commit = repo.find_commit(id).map_err(err("find commit"))?;
        let base_tree = commit.tree().map_err(err("base tree"))?;
        let parent = commit.parent(0).map_err(|_| EgError::Internal {
            context: "根提交没有可回滚的父提交".into(),
        })?;
        let their_tree = parent.tree().map_err(err("their tree"))?;

        // Ours = the current index (previous reverts already staged there).
        let mut index = repo.index().map_err(err("index"))?;
        let our_tree_id = index.write_tree().map_err(err("our tree"))?;
        let our_tree = repo.find_tree(our_tree_id).map_err(err("find tree"))?;

        let merged = repo
            .merge_trees(&base_tree, &our_tree, &their_tree, None)
            .map_err(err("revert merge"))?;
        if merged.has_conflicts() {
            // Roll back the partial sequence to the original clean state.
            let _ = repo.reset(original_head.as_object(), ResetType::Hard, None);
            return Err(EgError::ConflictState {
                state: format!("回滚产生冲突，已整体还原：{}", hex),
            });
        }
        // Land the merged result: on-disk index + workdir sync.
        let mut real = repo.index().map_err(err("index"))?;
        real.clear().map_err(err("index clear"))?;
        for entry in merged.iter() {
            real.add(&entry).map_err(err("index add"))?;
        }
        real.write().map_err(err("index write"))?;
        let mut builder = CheckoutBuilder::new();
        builder.force().recreate_missing(true);
        repo.checkout_index(Some(&mut real), Some(&mut builder))
            .map_err(err("revert checkout"))?;
    }
    status::status(repo_id, repo)
}

/// Reset with the three git modes (m1-plan R-20). Hard resets snapshot the
/// doomed content first and return an op id for the 撤销 toast; soft/mixed
/// destroy nothing.
pub fn reset(
    repo: &mut Repository,
    repo_id: &str,
    mode: ResetMode,
    target_hex: Option<&str>,
    safety: &eg_safety::Safety,
) -> Result<ResetOutcome, EgError> {
    let target = match target_hex {
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

    let prev_head = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .map(|c| c.id());
    let changed_paths: Vec<String> = if mode == ResetMode::Hard {
        let head_tree = prev_head
            .and_then(|id| repo.find_commit(id).ok())
            .and_then(|c| c.tree().ok());
        let target_tree = target.tree().ok();
        match (head_tree, target_tree) {
            (Some(old), Some(new)) => repo
                .diff_tree_to_tree(Some(&old), Some(&new), None)
                .map_err(err("diff"))?
                .deltas()
                .filter_map(|d| {
                    d.new_file()
                        .path()
                        .or_else(|| d.old_file().path())
                        .map(|p| p.to_string_lossy().replace('\\', "/"))
                })
                .collect(),
            _ => Vec::new(),
        }
    } else {
        Vec::new()
    };

    let op_id = if mode == ResetMode::Hard {
        let id = uuid::Uuid::new_v4().to_string();
        let paths: Vec<String> = changed_paths.clone();
        let snapshot_ref = if paths.is_empty() {
            None
        } else {
            Some(eg_safety::snapshot_worktree(
                repo,
                &id,
                eg_safety::OpKind::Reset,
                &paths,
            )?)
        };
        let prev_hex = prev_head.map(|o| o.to_string()).unwrap_or_default();
        let mut record_paths = vec![prev_hex];
        record_paths.extend(paths);
        safety
            .record(
                repo_id,
                &eg_safety::OpRecord {
                    op_id: id.clone(),
                    time: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs(),
                    kind: eg_safety::OpKind::Reset,
                    paths: record_paths,
                    snapshot_ref,
                    undone: false,
                },
            )
            .map_err(|e| EgError::Internal {
                context: format!("安全日志写入失败：{e}"),
            })?;
        Some(id)
    } else {
        None
    };

    let reset_type = match mode {
        ResetMode::Soft => ResetType::Soft,
        ResetMode::Mixed => ResetType::Mixed,
        ResetMode::Hard => ResetType::Hard,
    };
    repo.reset(target.as_object(), reset_type, None)
        .map_err(err("reset"))?;

    Ok(ResetOutcome {
        op_id,
        status: status::status(repo_id, repo)?,
    })
}

/// Restores a hard reset from the 撤销 toast: rebuild the doomed files from
/// the snapshot, then mixed-reset to the pre-reset tip — the branch moves
/// back and the restored files show up as unstaged edits.
pub fn undo_reset(repo: &mut Repository, record: &eg_safety::OpRecord) -> Result<(), EgError> {
    let mut paths = record.paths.iter();
    let prev_hex = paths.next().cloned().unwrap_or_default();
    let files: Vec<String> = paths.cloned().collect();
    if let Some(snapshot_ref) = &record.snapshot_ref {
        eg_safety::restore_snapshot(repo, snapshot_ref, &files)?;
    }
    let prev_id = git2::Oid::from_str(&prev_hex).map_err(|e| EgError::Internal {
        context: format!("invalid prev oid: {e}"),
    })?;
    let prev_commit = repo.find_commit(prev_id).map_err(err("find commit"))?;
    repo.reset(prev_commit.as_object(), ResetType::Mixed, None)
        .map_err(err("undo reset"))?;
    Ok(())
}
