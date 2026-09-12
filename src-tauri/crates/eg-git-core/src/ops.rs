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
/// Discard action without the safety record (redo replays this primitive).
pub fn discard_apply(repo: &Repository, paths: &[String]) -> Result<(), EgError> {
    let inner = || -> Result<(), EgError> {
        // 1. Index := HEAD for every path (no-op when unborn).
        stage(repo, paths, StageMode::Unstage)?;

        // 2. Normalize the worktree to the (freshly reset) index.
        let report = status::status("discard", repo)?;
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
                    repo.checkout_index(None, Some(&mut builder)).map_err(|e| {
                        EgError::Internal {
                            context: format!("discard checkout failed: {e}"),
                        }
                    })?;
                }
                _ => {}
            }
        }
        Ok(())
    };
    inner()
}

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
            target: None,
            undone: false,
        },
    )?;

    discard_apply(repo, paths)?;
    Ok(op_id)
}

/// Preview-style clean (m1-plan R-06): validates that every path is currently
/// untracked, snapshots them, then deletes from disk. Returns the op id.
/// Deletion action without the safety record (redo replays this primitive).
pub fn clean_apply(repo: &Repository, paths: &[String]) -> Result<(), EgError> {
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
    Ok(())
}

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
                target: None,
                undone: false,
            },
        )
        .map_err(|e| match e {
            EgError::Internal { context } => EgError::Internal {
                context: format!("safety log: {context}"),
            },
            other => other,
        })?;

    clean_apply(repo, paths)?;
    Ok(op_id)
}

/// Restores the pre-operation content of a logged discard/clean op and marks
/// the record undone (m1-plan W3 退出标准: 丢弃的修改可从快照点找回).
pub fn undo_operation(
    repo: &mut Repository,
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
    match record.kind {
        // 强推可回滚 (R-22): restore the remote ref by force-pushing the old
        // tip back. paths[0]=remote branch, paths[1]=old remote tip,
        // paths[2]=remote name; no local snapshot involved.
        eg_safety::OpKind::ForcePush => {
            let branch = record.paths.first().cloned().unwrap_or_default();
            let old_tip = record.paths.get(1).cloned().unwrap_or_default();
            let remote = record.paths.get(2).cloned().unwrap_or_default();
            let cli = crate::remote::GitCli::new(repo)?;
            cli.push_restore(&remote, &old_tip, &format!("refs/heads/{branch}"))?;
        }
        eg_safety::OpKind::Reset => {
            crate::merge::undo_reset(repo, &record)?;
        }
        // Deleted branches/tags restore from their trash ref.
        eg_safety::OpKind::RefDelete => {
            let snapshot_ref = record
                .snapshot_ref
                .as_deref()
                .ok_or_else(|| EgError::Internal {
                    context: "ref delete record has no trash ref".into(),
                })?;
            let Some(name) = record.paths.first() else {
                return Err(EgError::Internal {
                    context: "ref delete record is missing the name".into(),
                });
            };
            let reference = repo
                .find_reference(snapshot_ref)
                .map_err(|e| EgError::Internal {
                    context: format!("回收站引用缺失：{e}"),
                })?;
            let target = reference.target().ok_or_else(|| EgError::Internal {
                context: "trash ref has no target".into(),
            })?;
            // The trash ref name encodes the kind (branch-<uuid>/tag-<uuid>).
            let is_tag = snapshot_ref.contains("/tag-");
            let refname = if is_tag {
                format!("refs/tags/{name}")
            } else {
                format!("refs/heads/{name}")
            };
            repo.reference(&refname, target, true, &format!("easy-git restore {name}"))
                .map_err(|e| EgError::Internal {
                    context: format!("恢复失败（名称可能已被占用）：{e}"),
                })?;
            repo.find_reference(snapshot_ref)
                .and_then(|mut r| r.delete())
                .ok();
        }
        // Worktree ops restore from backup snapshots.
        eg_safety::OpKind::Discard | eg_safety::OpKind::Clean => {
            let snapshot_ref =
                record
                    .snapshot_ref
                    .as_deref()
                    .ok_or_else(|| EgError::NotSupported {
                        feature: "该操作没有可恢复的快照".into(),
                    })?;
            eg_safety::restore_snapshot(repo, snapshot_ref, &record.paths)?;
        }
    }
    safety.record(
        repo_id,
        &eg_safety::OpRecord {
            op_id: record.op_id.clone(),
            time: now_secs(),
            kind: record.kind,
            paths: record.paths,
            snapshot_ref: record.snapshot_ref,
            target: record.target,
            undone: true,
        },
    )?;
    Ok(())
}

/// Redoes the most recent undone operation (m1-plan R-25 撤销/重做引擎,
/// 引用快照树 decision): replays the original op semantics. Returns the
/// replayed op id (new log line, undone=false) for the toast.
pub fn redo_last(
    repo: &mut Repository,
    repo_id: &str,
    safety: &eg_safety::Safety,
) -> Result<String, EgError> {
    // history() dedups by op_id keeping the latest line; the last undone
    // record (log order) is the redo candidate.
    let record = safety
        .history(repo_id)
        .into_iter()
        .rfind(|r| r.undone)
        .ok_or_else(|| EgError::NotSupported {
            feature: "没有可重做的操作".into(),
        })?;

    // Replay WITHOUT a fresh record, then re-activate the original op
    // (same op_id, undone=false) — undoing the redone op still unwinds to
    // its original snapshot, so the chain stays consistent (引用快照树).
    match record.kind {
        eg_safety::OpKind::ForcePush => {
            // Re-force the recorded target tip to the remote branch.
            let branch = record.paths.first().cloned().unwrap_or_default();
            let remote = record.paths.get(2).cloned().unwrap_or_default();
            let new_tip = record.target.clone().unwrap_or_default();
            let cli = crate::remote::GitCli::new(repo)?;
            cli.push_restore(&remote, &new_tip, &format!("refs/heads/{branch}"))?;
        }
        // Discard/Clean records carry just the affected paths.
        eg_safety::OpKind::Discard => {
            discard_apply(repo, &record.paths)?;
        }
        eg_safety::OpKind::Clean => {
            clean_apply(repo, &record.paths)?;
        }
        eg_safety::OpKind::RefDelete => {
            let name = record.paths.first().cloned().unwrap_or_default();
            let is_tag = record
                .snapshot_ref
                .as_deref()
                .map(|r| r.contains("/tag-"))
                .unwrap_or(false);
            if is_tag {
                crate::refs::delete_tag_apply(repo, &name)?;
            } else {
                crate::refs::delete_branch_apply(repo, &name)?;
            }
        }
        eg_safety::OpKind::Reset => {
            // Replays the reset AND re-activates the original record.
            crate::merge::reset_with_record(
                repo,
                repo_id,
                eg_types::ResetMode::Hard,
                record.target.as_deref(),
                safety,
                Some(record.clone()),
            )?;
            return Ok(record.op_id);
        }
    }
    safety.record(
        repo_id,
        &eg_safety::OpRecord {
            op_id: record.op_id.clone(),
            time: now_secs(),
            kind: record.kind,
            paths: record.paths.clone(),
            snapshot_ref: record.snapshot_ref.clone(),
            target: record.target.clone(),
            undone: false,
        },
    )?;
    Ok(record.op_id)
}

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

/// Generic .gitignore template offered when a repository has none (system
/// files, editors, logs, common build artifacts, env files; 中文注释).
pub const DEFAULT_GITIGNORE: &str = include_str!("default-gitignore.txt");

/// True when the workdir has no `.gitignore` (bare repositories: unsupported).
pub fn gitignore_missing(repo: &Repository) -> Result<bool, EgError> {
    let workdir = repo.workdir().ok_or_else(|| EgError::NotSupported {
        feature: "bare repository gitignore".into(),
    })?;
    Ok(!workdir.join(".gitignore").exists())
}

/// Writes the generic template when the workdir has no `.gitignore`.
/// Returns whether the file was created — an existing file is never touched.
pub fn write_default_gitignore(repo: &Repository) -> Result<bool, EgError> {
    let workdir = repo.workdir().ok_or_else(|| EgError::NotSupported {
        feature: "bare repository gitignore".into(),
    })?;
    let gitignore = workdir.join(".gitignore");
    if gitignore.exists() {
        return Ok(false);
    }
    fs::write(&gitignore, DEFAULT_GITIGNORE).map_err(fs_err("write .gitignore"))?;
    Ok(true)
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
