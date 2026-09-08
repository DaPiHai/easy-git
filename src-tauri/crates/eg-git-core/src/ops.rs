//! Working-tree operations for the changes view (m1-plan R-05/R-06/F-10):
//! whole-file stage/unstage, snapshot-guarded discard and clean, .gitignore
//! generation. Hunk-level staging arrives in W6 (R-13).

use std::fs;
use std::path::Path;

use eg_types::{ChangeKind, EgError, IgnoreMode, StageMode, StatusReport};
use git2::build::CheckoutBuilder;
use git2::Repository;

use crate::status;

fn normalize(path: &str) -> &str {
    path.trim_end_matches('/')
}

/// Stages or unstages whole files. Untracked directory entries ("dir/") are
/// accepted and expand naturally via pathspecs / recursive removal.
pub fn stage(repo: &Repository, paths: &[String], mode: StageMode) -> Result<(), EgError> {
    let mut index = repo.index().map_err(index_err("open"))?;
    let specs: Vec<&str> = paths.iter().map(|p| normalize(p)).collect();

    match mode {
        StageMode::Stage => {
            index
                .add_all(&specs, git2::IndexAddOption::DEFAULT, None)
                .map_err(index_err("add"))?;
            index.write().map_err(index_err("write"))?;
        }
        StageMode::Unstage => {
            if let Ok(head_obj) = repo.revparse_single("HEAD") {
                // `git reset HEAD -- <paths>`: index entries restored from HEAD,
                // paths absent from HEAD are dropped (libgit2 writes the index).
                // Note: git2's reset_default(None) does NOT mean HEAD here.
                let targets: Vec<&Path> = specs.iter().map(Path::new).collect();
                repo.reset_default(Some(&head_obj), &targets)
                    .map_err(index_err("reset default"))?;
            } else {
                // Unborn HEAD: unstaging just removes entries from the index.
                for spec in specs {
                    match index.remove_path(Path::new(spec)) {
                        Ok(()) => {}
                        Err(e) if e.code() == git2::ErrorCode::NotFound => {}
                        Err(e) => return Err(index_err("remove")(e)),
                    }
                }
                index.write().map_err(index_err("write"))?;
            }
        }
    }
    Ok(())
}

/// Discards changes for whole files behind a safety snapshot (m1-plan R-05,
/// AGENTS.md 红线): `eg_safety::snapshot_worktree` runs first, then unstage
/// + restore-from-index + delete-untracked normalizes every path to HEAD.
///
/// Returns the op id for undo (`undo_operation`).
pub fn discard(
    repo: &Repository,
    repo_id: &str,
    safety: &eg_safety::Safety,
    paths: &[String],
) -> Result<String, EgError> {
    // AGENTS.md 红线: the snapshot MUST exist before anything is destroyed —
    // a failed snapshot aborts the whole discard.
    let op_id = uuid::Uuid::new_v4().to_string();
    let snapshot_ref = Some(eg_safety::snapshot_worktree(
        repo,
        &op_id,
        eg_safety::OpKind::Discard,
        paths,
    )?);
    safety.record(
        repo_id,
        &eg_safety::OpRecord {
            op_id: op_id.clone(),
            time: now_secs(),
            kind: eg_safety::OpKind::Discard,
            paths: paths.to_vec(),
            snapshot_ref,
            undone: false,
        },
    )?;

    // 1. Index := HEAD for every path (no-op when unborn).
    stage(repo, paths, StageMode::Unstage)?;

    // 2. Normalize the worktree to the (freshly reset) index.
    let report = status::status(repo_id, repo)?;
    for path in paths {
        let entry = find_entry(&report, path);
        let clean = normalize(path);
        let abs = repo
            .workdir()
            .ok_or_else(|| EgError::NotSupported {
                feature: "bare repository discard".into(),
            })?
            .join(clean);
        match entry.map(|e| e.kind) {
            Some(ChangeKind::Untracked) => {
                if abs.is_dir() {
                    fs::remove_dir_all(&abs).map_err(fs_err("remove untracked dir"))?;
                } else if abs.is_file() {
                    fs::remove_file(&abs).map_err(fs_err("remove untracked file"))?;
                }
            }
            Some(ChangeKind::Modified | ChangeKind::Deleted | ChangeKind::Renamed) => {
                let mut builder = CheckoutBuilder::new();
                builder.force().update_index(true).path(clean);
                repo.checkout_index(None, Some(&mut builder))
                    .map_err(|e| EgError::Internal {
                        context: format!("discard checkout failed: {e}"),
                    })?;
            }
            _ => {}
        }
    }
    Ok(op_id)
}

/// Preview-style clean (m1-plan R-06): validates that every path is currently
/// untracked, snapshots them, then deletes from disk. Returns the op id.
pub fn clean(
    repo: &Repository,
    repo_id: &str,
    safety: &eg_safety::Safety,
    paths: &[String],
) -> Result<String, EgError> {
    let report = status::status(repo_id, repo)?;
    for path in paths {
        let entry = find_entry(&report, path);
        if entry.map(|e| e.kind) != Some(ChangeKind::Untracked) {
            return Err(EgError::UnsafeOperation {
                confirm_required: format!("「{path}」当前不是未跟踪文件，拒绝清理"),
            });
        }
    }

    let op_id = uuid::Uuid::new_v4().to_string();
    let snapshot_ref = eg_safety::snapshot_worktree(repo, &op_id, eg_safety::OpKind::Clean, paths)?;
    safety
        .record(
            repo_id,
            &eg_safety::OpRecord {
                op_id: op_id.clone(),
                time: now_secs(),
                kind: eg_safety::OpKind::Clean,
                paths: paths.to_vec(),
                snapshot_ref: Some(snapshot_ref),
                undone: false,
            },
        )
        .map_err(|e| match e {
            EgError::Internal { context } => EgError::Internal {
                context: format!("safety log: {context}"),
            },
            other => other,
        })?;

    let workdir = repo.workdir().ok_or_else(|| EgError::NotSupported {
        feature: "bare repository clean".into(),
    })?;
    for path in paths {
        let clean_path = normalize(path);
        let abs = workdir.join(clean_path);
        if abs.is_dir() {
            fs::remove_dir_all(&abs).map_err(fs_err("clean dir"))?;
        } else if abs.is_file() {
            fs::remove_file(&abs).map_err(fs_err("clean file"))?;
        }
    }
    Ok(op_id)
}

/// Restores the pre-operation content of a logged discard/clean op and marks
/// the record undone (m1-plan W3 退出标准: 丢弃的修改可从快照点找回).
pub fn undo_operation(
    repo: &Repository,
    repo_id: &str,
    safety: &eg_safety::Safety,
    op_id: &str,
) -> Result<(), EgError> {
    let record = safety
        .find(repo_id, op_id)
        .ok_or_else(|| EgError::Internal {
            context: "operation not found".into(),
        })?;
    if record.undone {
        return Err(EgError::NotSupported {
            feature: "该操作已经撤销过".into(),
        });
    }
    let Some(snapshot_ref) = &record.snapshot_ref else {
        return Err(EgError::NotSupported {
            feature: "该操作没有可恢复的快照".into(),
        });
    };
    eg_safety::restore_snapshot(repo, snapshot_ref, &record.paths)?;
    safety.record(
        repo_id,
        &eg_safety::OpRecord {
            op_id: record.op_id.clone(),
            time: now_secs(),
            kind: record.kind,
            paths: record.paths,
            snapshot_ref: Some(snapshot_ref.clone()),
            undone: true,
        },
    )?;
    Ok(())
}

/// Appends ignore rules to `.gitignore` (m1-plan F-10). Existing identical
/// rules are not duplicated.
pub fn ignore(
    repo: &Repository,
    paths: &[String],
    mode: IgnoreMode,
) -> Result<Vec<String>, EgError> {
    let workdir = repo.workdir().ok_or_else(|| EgError::NotSupported {
        feature: "bare repository ignore".into(),
    })?;
    let gitignore = workdir.join(".gitignore");

    let mut rules: Vec<String> = match mode {
        IgnoreMode::ByPath => paths.iter().map(|p| format!("/{}", normalize(p))).collect(),
        IgnoreMode::ByExtension => {
            let mut exts: Vec<String> = paths
                .iter()
                .filter_map(|p| {
                    Path::new(normalize(p))
                        .extension()
                        .map(|e| format!("*.{}", e.to_string_lossy()))
                })
                .collect();
            exts.sort();
            exts.dedup();
            exts
        }
    };
    rules.retain(|rule| !rule.is_empty());

    let existing = fs::read_to_string(&gitignore).unwrap_or_default();
    let fresh: Vec<String> = rules
        .into_iter()
        .filter(|rule| {
            existing.lines().all(|line| {
                line.trim() != rule.trim_start_matches('/').trim() || rule.starts_with('/')
            })
        })
        .collect();

    if !fresh.is_empty() {
        let mut content = existing;
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(&fresh.join("\n"));
        content.push('\n');
        fs::write(&gitignore, content).map_err(fs_err("write .gitignore"))?;
    }
    Ok(fresh)
}

fn find_entry(report: &StatusReport, path: &str) -> Option<eg_types::ChangeEntry> {
    let norm = normalize(path);
    report
        .conflicted
        .iter()
        .chain(&report.staged)
        .chain(&report.unstaged)
        .find(|e| normalize(&e.path) == norm)
        .cloned()
}

/// True when at least one path currently has worktree or index content.
#[allow(dead_code)]
fn paths_had_content(repo: &Repository, paths: &[String]) -> bool {
    let Some(workdir) = repo.workdir() else {
        return false;
    };
    let Ok(index) = repo.index() else {
        return false;
    };
    paths.iter().any(|p| {
        let clean = normalize(p);
        let abs = workdir.join(clean);
        abs.exists() || index.get_path(Path::new(clean), 0).is_some()
    })
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn index_err(stage: &'static str) -> impl Fn(git2::Error) -> EgError {
    move |e| EgError::Internal {
        context: format!("index {stage} failed: {e}"),
    }
}

fn fs_err(stage: &'static str) -> impl Fn(std::io::Error) -> EgError {
    move |e| EgError::Internal {
        context: format!("{stage} failed: {e}"),
    }
}
