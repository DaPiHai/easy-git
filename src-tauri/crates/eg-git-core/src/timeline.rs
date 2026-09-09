//! 操作时间线 (m1-plan F-28, UI §6.10): merges the HEAD reflog with the
//! eg-safety operation log into one feed. The undo/redo engine stores its
//! state in the snapshot-tree operation log (PRD §10.2 decision); reflog is
//! display-only.

use eg_types::{EgError, TimelineEntry};
use git2::Repository;

use crate::merge;

/// Classifies a reflog message (`commit:`, `merge:`, `reset:`, `pull:`,
/// `checkout:`, `clone:` …) into timeline kinds + danger flags.
fn classify_reflog(message: &str) -> (&'static str, bool) {
    let lower = message.to_lowercase();
    if lower.starts_with("commit (merge)") || lower.starts_with("merge") {
        ("merge", false)
    } else if lower.starts_with("commit") || lower.starts_with("commit (amend)") {
        ("commit", false)
    } else if lower.starts_with("reset") {
        ("reset", true)
    } else if lower.starts_with("pull") || lower.starts_with("fetch") {
        ("fetch", false)
    } else if lower.starts_with("rebase") {
        ("rebase", true)
    } else {
        ("other", false)
    }
}

/// HEAD reflog, newest first (m1-plan F-28). Unborn HEAD or a fresh clone
/// without a reflog yields an empty list, not an error.
pub fn reflog_head(repo: &Repository, limit: u32) -> Result<Vec<TimelineEntry>, EgError> {
    let Ok(reflog) = repo.reflog("HEAD") else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for entry in reflog.iter().rev() {
        if out.len() >= limit as usize {
            break;
        }
        let message = entry
            .message()
            .ok()
            .flatten()
            .unwrap_or_default()
            .to_string();
        let (kind, danger) = classify_reflog(&message);
        let time = entry.committer().when().seconds();
        out.push(TimelineEntry {
            oid: Some(entry.id_new().to_string()),
            subject: if message.is_empty() {
                format!(
                    "{} → {}",
                    &entry.id_old().to_string()[..7],
                    &entry.id_new().to_string()[..7]
                )
            } else {
                message
            },
            kind: kind.to_string(),
            danger,
            time: time.max(0) as f64,
        });
    }
    Ok(out)
}

/// Merges reflog entries with eg-safety operations, newest first (F-28).
/// Duplicates (e.g. a reset appears in both logs) keep both rows — the op
/// row carries the undo/redo affordance, the reflog row the git-native one.
pub fn timeline(
    repo: &Repository,
    repo_id: &str,
    safety: &eg_safety::Safety,
    limit: u32,
) -> Result<Vec<TimelineEntry>, EgError> {
    let mut entries = reflog_head(repo, limit)?;

    for record in safety.history(repo_id) {
        let (kind, danger, subject) = match record.kind {
            eg_safety::OpKind::Discard => (
                "discard",
                true,
                format!("丢弃修改（{} 个路径）", record.paths.len()),
            ),
            eg_safety::OpKind::Clean => (
                "clean",
                true,
                format!("清理未跟踪（{} 个路径）", record.paths.len()),
            ),
            eg_safety::OpKind::RefDelete => (
                "ref_delete",
                true,
                format!(
                    "删除 {}「{}」",
                    if record
                        .snapshot_ref
                        .as_deref()
                        .map(|r| r.contains("/tag-"))
                        .unwrap_or(false)
                    {
                        "标签"
                    } else {
                        "分支"
                    },
                    record.paths.first().cloned().unwrap_or_default()
                ),
            ),
            eg_safety::OpKind::Reset => ("reset", true, "重置".to_string()),
            eg_safety::OpKind::ForcePush => {
                let branch = record.paths.first().cloned().unwrap_or_default();
                let old_tip = record.paths.get(1).cloned().unwrap_or_default();
                let short_old = old_tip.get(..7).unwrap_or(&old_tip).to_string();
                (
                    "force_push",
                    true,
                    format!("强推 {branch}（远端先回到 {short_old}）"),
                )
            }
        };
        if record.undone {
            continue; // undone ops are the redo stack, not the visible feed
        }
        entries.push(TimelineEntry {
            oid: record.target.clone(),
            subject: if record.undone {
                format!("已撤销：{subject}")
            } else {
                subject
            },
            kind: kind.to_string(),
            danger,
            time: record.time as f64,
        });
    }

    entries.sort_by(|a, b| {
        b.time
            .partial_cmp(&a.time)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.subject.cmp(&a.subject))
    });
    entries.truncate(limit as usize);
    Ok(entries)
}

/// 恢复到此状态 (F-28): hard-reset the current branch to a timeline entry's
/// commit behind the full safety net (snapshot + undo toast). Refuses when
/// the worktree is dirty (same red line as merge/revert).
pub fn restore_to(
    repo: &mut Repository,
    repo_id: &str,
    safety: &eg_safety::Safety,
    oid_hex: &str,
) -> Result<eg_types::ResetOutcome, EgError> {
    merge::ensure_clean(repo)?;
    merge::reset(
        repo,
        repo_id,
        eg_types::ResetMode::Hard,
        Some(oid_hex),
        safety,
    )
}
