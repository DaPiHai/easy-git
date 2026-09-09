//! Commit operations (m1-plan R-07): create/amend commits from the index,
//! with partial-staging confirmation and identity resolution from config.

use eg_types::{CommitOutcome, CommitRequest, EgError};
use git2::Repository;

use super::{merge, repo, status};

/// Files that are staged AND still carry unstaged edits: committing includes
/// only the staged part, so `allow_partial` confirmation is required.
pub fn partially_staged(repo: &Repository) -> Result<Vec<String>, EgError> {
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(false);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| EgError::Internal {
            context: format!("status failed: {e}"),
        })?;
    let mut partial = Vec::new();
    for entry in statuses.iter() {
        let flags = entry.status();
        let staged = flags.intersects(
            git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED
                | git2::Status::INDEX_TYPECHANGE,
        );
        let unstaged = flags.intersects(
            git2::Status::WT_MODIFIED
                | git2::Status::WT_DELETED
                | git2::Status::WT_RENAMED
                | git2::Status::WT_TYPECHANGE,
        );
        if staged && unstaged {
            if let Ok(path) = entry.path() {
                partial.push(path.to_string());
            }
        }
    }
    Ok(partial)
}

/// Creates (or amends) a commit from the current index.
pub fn commit(
    repo: &Repository,
    repo_id: &str,
    req: &CommitRequest,
) -> Result<CommitOutcome, EgError> {
    let subject = req.subject.trim();
    if subject.is_empty() {
        return Err(EgError::Internal {
            context: "commit message is empty".into(),
        });
    }

    let amend = req.amend && repo.head().is_ok();

    // `git commit --amend` on an unborn HEAD is invalid.
    if req.amend && repo.head().is_err() {
        return Err(EgError::Internal {
            context: "cannot amend: repository has no commits yet".into(),
        });
    }

    // Merge finalize (R-19): a parked merge must be fully resolved first,
    // and committing it creates the two-parent merge commit.
    // On a read error treat as not mid-merge; the merge commit path will
    // surface real problems when writing.
    let mid_merge = merge::merge_state(repo).ok().flatten();
    let mut index = repo.index().map_err(index_err("open"))?;
    if let Some(state) = &mid_merge {
        if index.has_conflicts() {
            return Err(EgError::ConflictState {
                state: format!(
                    "还有未解决的冲突：{}",
                    state.message.as_deref().unwrap_or("")
                ),
            });
        }
    }

    // Partial-staging guard: only the staged part would land. Skipped while
    // finalizing a merge — the worktree often keeps post-merge edits there.
    let partial = partially_staged(repo)?;
    if mid_merge.is_none() && !partial.is_empty() && !req.allow_partial && !amend {
        return Err(EgError::UnsafeOperation {
            confirm_required: format!("部分暂存：{}", partial.join("、")),
        });
    }

    // Nothing to commit (index matches HEAD) — unless amending or finishing
    // a merge (git also allows an empty-diff merge commit).
    if !amend && mid_merge.is_none() {
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        let index_tree = index.write_tree().map_err(index_err("write tree"))?;
        if let Some(head_tree) = head_tree {
            if head_tree.id() == index_tree {
                return Err(EgError::Internal {
                    context: "nothing staged to commit".into(),
                });
            }
        }
    }

    let (author, committer) = signature_for(repo)?;
    let message = if req.body.trim().is_empty() {
        subject.to_string()
    } else {
        format!("{}\n\n{}", subject, req.body.trim())
    };

    let tree_id = index.write_tree().map_err(index_err("write tree"))?;
    let tree = repo.find_tree(tree_id).map_err(index_err("find tree"))?;

    let (parents, author): (Vec<git2::Commit<'_>>, git2::Signature) = match repo.head().ok() {
        Some(head) => {
            let head_commit = head.peel_to_commit().map_err(index_err("peel head"))?;
            let mut parents: Vec<git2::Commit<'_>> = if amend && mid_merge.is_none() {
                head_commit.parents().collect()
            } else {
                vec![head_commit.clone()]
            };
            if mid_merge.is_some() {
                // Merge commit: HEAD first, then every MERGE_HEAD tip.
                for oid in merge::merge_head_oids(repo)? {
                    parents.push(
                        repo.find_commit(oid)
                            .map_err(index_err("find merge head"))?,
                    );
                }
            }
            // Amend keeps the original author (name/email/date), like real git.
            let author = if amend {
                let orig = head_commit.author();
                git2::Signature::new(
                    orig.name().unwrap_or_default(),
                    orig.email().unwrap_or_default(),
                    &orig.when(),
                )
                .map_err(|e| EgError::Internal {
                    context: format!("signature failed: {e}"),
                })?
            } else {
                author
            };
            (parents, author)
        }
        None => (Vec::new(), author),
    };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();

    // Amending rewrites the tip with the ORIGINAL commit's parents, so the new
    // commit's first parent never equals the current tip and git2's
    // Some("HEAD") shortcut always rejects it ("current tip is not the first
    // parent"). Create the commit object directly, then force-move the branch
    // reference (head() resolves to e.g. refs/heads/main).
    let commit_id = if amend {
        let branch_name = repo
            .head()
            .ok()
            .and_then(|h| h.name().ok().map(str::to_string))
            .unwrap_or_else(|| "HEAD".to_string());
        let oid = repo
            .commit(None, &author, &committer, &message, &tree, &parent_refs)
            .map_err(|e| EgError::Internal {
                context: format!("commit failed: {e}"),
            })?;
        repo.reference(&branch_name, oid, true, "commit (amend)")
            .map_err(|e| EgError::Internal {
                context: format!("move branch failed: {e}"),
            })?;
        oid
    } else {
        repo.commit(
            Some("HEAD"),
            &author,
            &committer,
            &message,
            &tree,
            &parent_refs,
        )
        .map_err(|e| EgError::Internal {
            context: format!("commit failed: {e}"),
        })?
    };

    // Merge finalize completed: git-style cleanup of the parking files.
    if mid_merge.is_some() {
        merge::clear_merge_files(repo);
    }

    Ok(CommitOutcome {
        commit_id: commit_id.to_string(),
        amended: amend,
        summary: repo::summarize(repo_id, repo, repo.workdir().expect("workdir"))?,
        status: status::status(repo_id, repo)?,
    })
}

/// Resolves the committer identity from repo-local then global config.
/// Amend keeps the original author, so the committer is all we need — but a
/// missing identity is still required by libgit2, surfaced as a clear error.
fn signature_for(repo: &Repository) -> Result<(git2::Signature<'_>, git2::Signature<'_>), EgError> {
    let config = repo.config().map_err(index_err("config"))?;
    let name = config.get_string("user.name").ok();
    let email = config.get_string("user.email").ok();
    match (name, email) {
        (Some(name), Some(email)) => {
            let sig = git2::Signature::now(&name, &email).map_err(|e| EgError::Internal {
                context: format!("signature failed: {e}"),
            })?;
            Ok((sig.clone(), sig))
        }
        _ => Err(EgError::Internal {
            context: "user.name / user.email not configured".into(),
        }),
    }
}

fn index_err(stage: &'static str) -> impl Fn(git2::Error) -> EgError {
    move |e| EgError::Internal {
        context: format!("index {stage} failed: {e}"),
    }
}
