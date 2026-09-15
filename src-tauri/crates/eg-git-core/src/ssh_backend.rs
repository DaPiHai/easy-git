//! SSH-backed git operations (feat/ssh-remote-manage).
//!
//! Every function here mirrors a local `eg-git-core` module's public contract
//! but executes against a remote host through [`crate::ssh`]: the command
//! string is built with `ssh::git_cmd` (allowlist-enforced), run with
//! `ssh::ssh_run`, and the text output is parsed back into the same DTOs the
//! frontend already renders. Pure parsing helpers that do not touch git2 live
//! in the local modules and are reused where possible; everything else is
//! re-parsed from porcelain/stable CLI output.
//!
//! Policy: destructive operations are refused here (reset, force push,
//! discard, clean, branch -D, stash drop, undo/redo, restore-to). The worker
//! layer rejects them first; these guards make the backend safe even if a
//! caller slips past.
//!
//! Timeouts mirror `remote.rs`: quick probes 45s, network/sync 300s.

use std::collections::HashMap;
use std::sync::mpsc::Sender;

use eg_types::{
    BranchInfo, ChangeEntry, ChangeKind, CommitDetail, CommitFile, CommitLogEntry, CommitOutcome,
    CommitRefs, CommitRequest, ConfigScope, DiffHunk, DiffLine, DiffLineKind, DiffRequest,
    DiffResponse, DiffSourceKind, EgError, GraphLine, GraphNode, IgnoreMode, LogFilter, LogPage,
    MergeOutcome, MergeState, PushCredentials, RemoteInfo, RepoSummary, ResetMode,
    StageLinesRequest, StageMode, StashEntry, StatusReport, SyncStrategy, TagInfo, TimelineEntry,
    UndoRedoState, WordSpan,
};

use super::remote::SyncProgress;
use super::ssh;
use super::ssh::{CLI_TIMEOUT_NETWORK, CLI_TIMEOUT_QUICK};
use eg_types::SshTarget;

/// Refuses remote destructive writes with a clear, actionable error.
fn remote_read_only(op: &str) -> EgError {
    EgError::NotSupported {
        feature: format!("远端仓库默认禁用危险写（{op}），请在服务器上直接操作"),
    }
}

/// The same refusal as a plain value for callers that already produce the
/// surrounding `Result` (e.g. the worker handle dispatch).
pub fn refuse(op: &str) -> EgError {
    remote_read_only(op)
}

/// Random heredoc delimiter so file content can never break out of the
/// remote write (content is user-controlled: resolved conflicts, patches).
fn heredoc_tag() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    format!(
        "EASYGIT_{}_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

/// Writes `content` to the remote file at `remote_path` via heredoc.
fn remote_write(
    target: &SshTarget,
    remote_path: &str,
    content: &str,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<(), EgError> {
    let tag = heredoc_tag();
    let writer = format!(
        "cat > {} <<'{tag}'\n{content}{eol}{tag}",
        ssh::shell_quote(remote_path),
        eol = if content.ends_with('\n') { "" } else { "\n" },
    );
    let (text, ok) = ssh::ssh_run(target, &writer, on_progress, CLI_TIMEOUT_QUICK)?;
    if !ok {
        return Err(ssh::humanize_ssh(&text, &target.uri(), target));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Small output parsers shared by the backend.
// ---------------------------------------------------------------------------

/// Splits a commit message into subject / body (mirrors `log::split_message`).
fn split_message(message: &str) -> (String, String) {
    let mut parts = message.splitn(2, "\n\n");
    let subject = parts.next().unwrap_or("").trim().to_string();
    let body = parts.next().unwrap_or("").trim_end().to_string();
    (subject, body)
}

/// `"12\t3\tpath"` numstat line → (added, deleted).
fn parse_numstat(line: &str) -> Option<(u32, u32, String)> {
    let mut parts = line.split('\t');
    let added = parts.next()?.parse::<u32>().ok()?;
    let deleted = parts.next()?.parse::<u32>().ok()?;
    let path = parts.next()?.to_string();
    Some((added, deleted, path))
}

/// Common prefix/suffix byte lengths of two lines (mirrors diff::common_span).
fn common_span(a: &str, b: &str) -> (usize, usize) {
    let (ab, bb) = (a.as_bytes(), b.as_bytes());
    let mut prefix = 0;
    while prefix < ab.len() && prefix < bb.len() && ab[prefix] == bb[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < ab.len() - prefix && suffix < bb.len() - prefix {
        if ab[ab.len() - 1 - suffix] != bb[bb.len() - 1 - suffix] {
            break;
        }
        suffix += 1;
    }
    (prefix, suffix)
}

/// `"@@ -12,3 +12,5 @@ fn"` → (12, 12) (mirrors diff::parse_hunk_header).
fn parse_hunk_header(header: &str) -> (u32, u32) {
    let mut old_start = 0;
    let mut new_start = 0;
    let Some(rest) = header.strip_prefix("@@") else {
        return (old_start, new_start);
    };
    for part in rest.split_whitespace() {
        if let Some(old) = part.strip_prefix('-') {
            old_start = old
                .split(',')
                .next()
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
        } else if let Some(new) = part.strip_prefix('+') {
            new_start = new
                .split(',')
                .next()
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
        }
    }
    (old_start, new_start)
}

/// Word-level spans for single-line deleted→added pairs (mirrors diff).
fn mark_word_pairs(hunks: &mut [DiffHunk]) {
    for hunk in hunks {
        let mut i = 0;
        while i + 1 < hunk.lines.len() {
            if hunk.lines[i].kind == DiffLineKind::Deleted
                && hunk.lines[i + 1].kind == DiffLineKind::Added
            {
                let deleted = hunk.lines[i].content.clone();
                let added = hunk.lines[i + 1].content.clone();
                let (prefix, suffix) = common_span(&deleted, &added);
                let changed = |s: &str| prefix + suffix < s.len();
                if changed(&deleted) && changed(&added) {
                    hunk.lines[i].word = Some(WordSpan {
                        start: prefix as u32,
                        end: (deleted.len() - suffix) as u32,
                    });
                    hunk.lines[i + 1].word = Some(WordSpan {
                        start: prefix as u32,
                        end: (added.len() - suffix) as u32,
                    });
                }
                i += 2;
                continue;
            }
            i += 1;
        }
    }
}

const MAX_DIFF_LINES: usize = 5000;

/// Parses unified-diff text into structured hunks (mirrors diff::parse_hunks).
fn parse_patch(patch: &str) -> (Vec<DiffHunk>, bool, bool) {
    let mut hunks: Vec<DiffHunk> = Vec::new();
    let mut truncated = false;
    let mut binary = false;
    let mut current: Option<usize> = None;
    let mut old_lineno = 0u32;
    let mut new_lineno = 0u32;

    for raw in patch.lines() {
        if raw.starts_with("Binary files ") || raw.starts_with("GIT binary patch") {
            binary = true;
            continue;
        }
        if let Some(header) = raw.strip_prefix("@@") {
            let header = format!("@@{header}");
            let (old_start, new_start) = parse_hunk_header(&header);
            old_lineno = old_start;
            new_lineno = new_start;
            hunks.push(DiffHunk {
                header,
                old_start,
                new_start,
                lines: Vec::new(),
            });
            current = Some(hunks.len() - 1);
            continue;
        }
        let Some(index) = current else { continue };
        if raw.is_empty() {
            continue;
        }
        let (kind, content) = match raw.as_bytes().first() {
            Some(b'+') => (DiffLineKind::Added, &raw[1..]),
            Some(b'-') => (DiffLineKind::Deleted, &raw[1..]),
            Some(b' ') => (DiffLineKind::Context, &raw[1..]),
            _ => continue, // diff headers, index lines, ---/+++ markers
        };
        if hunks[index].lines.len() >= MAX_DIFF_LINES {
            truncated = true;
            continue;
        }
        let (old_no, new_no) = match kind {
            DiffLineKind::Added => {
                let n = new_lineno;
                new_lineno += 1;
                (None, Some(n))
            }
            DiffLineKind::Deleted => {
                let n = old_lineno;
                old_lineno += 1;
                (Some(n), None)
            }
            DiffLineKind::Context => {
                let (o, n) = (old_lineno, new_lineno);
                old_lineno += 1;
                new_lineno += 1;
                (Some(o), Some(n))
            }
        };
        hunks[index].lines.push(DiffLine {
            kind,
            old_lineno: old_no,
            new_lineno: new_no,
            content: content.to_string(),
            word: None,
        });
    }
    mark_word_pairs(&mut hunks);
    (hunks, truncated, binary)
}

/// Splits workdir content into segments + conflict blocks (mirrors conflicts).
fn parse_blocks(content: &str) -> (Vec<String>, Vec<eg_types::ConflictBlock>) {
    let mut segments = Vec::new();
    let mut blocks = Vec::new();
    let mut current_segment = String::new();
    let mut state = "normal";
    let (mut ours, mut theirs) = (Vec::new(), Vec::new());
    for line in content.lines() {
        if line.starts_with("<<<<<<<") {
            segments.push(std::mem::take(&mut current_segment));
            state = "ours";
            ours.clear();
            theirs.clear();
        } else if line.starts_with("=======") && state == "ours" {
            state = "theirs";
        } else if line.starts_with(">>>>>>>") && state == "theirs" {
            blocks.push(eg_types::ConflictBlock {
                ours: ours.clone(),
                theirs: theirs.clone(),
            });
            state = "normal";
        } else if state == "normal" {
            current_segment.push_str(line);
            current_segment.push('\n');
        } else if state == "ours" {
            ours.push(line.to_string());
        } else {
            theirs.push(line.to_string());
        }
    }
    segments.push(current_segment);
    (segments, blocks)
}

fn looks_binary(text: &str) -> bool {
    text.as_bytes()[..text.len().min(8000)].contains(&0)
}

// ---------------------------------------------------------------------------
// Lane geometry (mirrors log::Lanes; operates on hex oid strings).
// ---------------------------------------------------------------------------

struct Lanes {
    lanes: Vec<(String, u8)>,
    next_color: u8,
}

impl Lanes {
    fn new() -> Self {
        Self {
            lanes: Vec::new(),
            next_color: 1,
        }
    }

    fn alloc_color(&mut self) -> u8 {
        let c = self.next_color;
        self.next_color = (self.next_color + 1) % 8;
        c
    }

    fn emit(&mut self, oid: &str, parents: &[String]) -> (GraphNode, Vec<GraphLine>, u32) {
        let above_len = self.lanes.len();
        let matches: Vec<usize> = (0..above_len).filter(|&i| self.lanes[i].0 == oid).collect();

        let node_lane;
        let node_color;
        if matches.is_empty() {
            node_color = if self.lanes.is_empty() {
                0
            } else {
                self.alloc_color()
            };
            self.lanes.push((oid.to_string(), node_color));
            node_lane = self.lanes.len() - 1;
        } else {
            node_lane = matches[0];
            node_color = self.lanes[node_lane].1;
        }

        let mut lines: Vec<GraphLine> = Vec::new();
        let mut removed: Vec<usize> = Vec::new();
        for &j in &matches {
            if j != node_lane {
                removed.push(j);
                lines.push(GraphLine {
                    from: j as u32,
                    to: node_lane as u32,
                    color: self.lanes[j].1,
                });
            }
        }

        if parents.is_empty() {
            removed.push(node_lane);
        } else {
            self.lanes[node_lane].0 = parents[0].clone();
            lines.push(GraphLine {
                from: node_lane as u32,
                to: node_lane as u32,
                color: node_color,
            });
            for p in &parents[1..] {
                match self.lanes.iter().position(|(o, _)| o == p) {
                    Some(k) if k != node_lane => {
                        let color = self.lanes[k].1;
                        lines.push(GraphLine {
                            from: node_lane as u32,
                            to: k as u32,
                            color,
                        });
                    }
                    _ => {
                        let color = self.alloc_color();
                        self.lanes.push((p.clone(), color));
                        lines.push(GraphLine {
                            from: node_lane as u32,
                            to: (self.lanes.len() - 1) as u32,
                            color,
                        });
                    }
                }
            }
        }

        for j in 0..above_len {
            if j == node_lane || removed.contains(&j) {
                continue;
            }
            let color = self.lanes[j].1;
            lines.push(GraphLine {
                from: j as u32,
                to: j as u32,
                color,
            });
        }

        let mut removed_sorted = removed.clone();
        removed_sorted.sort_unstable();
        removed_sorted.dedup();
        let mut new_index = vec![usize::MAX; self.lanes.len()];
        let mut kept: Vec<(String, u8)> = Vec::with_capacity(self.lanes.len());
        for (old, entry) in self.lanes.iter().enumerate() {
            if removed_sorted.contains(&old) {
                continue;
            }
            new_index[old] = kept.len();
            kept.push(entry.clone());
        }
        self.lanes = kept;

        for line in &mut lines {
            if line.to as usize != node_lane {
                line.to = new_index[line.to as usize] as u32;
            }
        }

        let lane_count = above_len.max(self.lanes.len()) as u32;
        (
            GraphNode {
                lane: node_lane as u32,
                color: node_color,
                merge: parents.len() > 1,
            },
            lines,
            lane_count,
        )
    }
}

// ---------------------------------------------------------------------------
// Command runner: one remote `git -C`, text + success, humanized on failure.
// ---------------------------------------------------------------------------

fn run_git(
    target: &SshTarget,
    args: &[&str],
    on_progress: Option<&Sender<SyncProgress>>,
    timeout: std::time::Duration,
) -> Result<String, EgError> {
    let cmd = ssh::git_cmd(&target.path, args);
    let (text, ok) = ssh::ssh_run(target, &cmd, on_progress, timeout)?;
    if ok {
        Ok(text)
    } else {
        Err(ssh::humanize_ssh(&text, &target.uri(), target))
    }
}

/// `git rev-parse` one-liner (empty string when the ref does not exist).
fn rev_parse(target: &SshTarget, expr: &str) -> Result<String, EgError> {
    let out = run_git(
        target,
        &["rev-parse", "--verify", "--quiet", expr],
        None,
        CLI_TIMEOUT_QUICK,
    )
    .or_else(|_| run_git(target, &["rev-parse", expr], None, CLI_TIMEOUT_QUICK))
    .unwrap_or_default();
    Ok(out.lines().next().unwrap_or_default().trim().to_string())
}

// ---------------------------------------------------------------------------
// Status / summary (mirrors status.rs + repo::summarize).
// ---------------------------------------------------------------------------

/// `git status --porcelain=v1 -z -uall` → three-zone report.
/// Rename detection mirrors the local vocabulary via `--find-renames`.
pub fn status(
    repo_id: &str,
    target: &SshTarget,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<StatusReport, EgError> {
    let out = run_git(
        target,
        &["status", "--porcelain=v1", "-z", "-uall", "--find-renames"],
        on_progress,
        CLI_TIMEOUT_QUICK,
    )?;
    let branch = run_git(
        target,
        &["branch", "--show-current"],
        None,
        CLI_TIMEOUT_QUICK,
    )
    .map(|s| {
        let b = s.trim().to_string();
        if b.is_empty() {
            None
        } else {
            Some(b)
        }
    })
    .unwrap_or(None);
    let head_oid = run_git(target, &["rev-parse", "HEAD"], None, CLI_TIMEOUT_QUICK)
        .map(|s| {
            let h = s.trim().to_string();
            if h.is_empty() || h.starts_with("HEAD") {
                None
            } else {
                Some(h)
            }
        })
        .unwrap_or(None);

    let mut report = StatusReport {
        repo_id: repo_id.to_string(),
        branch,
        head_oid,
        staged: Vec::new(),
        unstaged: Vec::new(),
        conflicted: Vec::new(),
    };

    // Porcelain v1 -z: `XY path\0` per entry, except renames/copies which
    // are `XY new-path\0old-path\0` (the old path rides as a following
    // NUL field with no XY prefix — NOT the ` -> ` text form, which only
    // appears without -z). Iterate with an explicit cursor so the old-path
    // field attaches to its rename entry instead of being skipped.
    let fields: Vec<&str> = out.split('\0').collect();
    let mut i = 0;
    while i < fields.len() {
        let entry = fields[i];
        i += 1;
        if entry.is_empty() {
            continue;
        }
        let bytes = entry.as_bytes();
        if bytes.len() < 4 {
            continue;
        }
        let (x, y) = (bytes[0] as char, bytes[1] as char);
        let mut path = entry[3..].to_string();
        let mut old_path: Option<String> = None;
        if (x == 'R' || x == 'C' || y == 'R' || y == 'C')
            && i < fields.len()
            && !fields[i].is_empty()
        {
            // Rename/copy old-path field (no XY prefix under -z).
            old_path = Some(fields[i].to_string());
            i += 1;
            // Legacy non-z form guard: some git builds print `old -> new`.
            if let Some((old, new)) = path.split_once(" -> ") {
                old_path = Some(old.to_string());
                path = new.to_string();
            }
        }
        if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
            report.conflicted.push(ChangeEntry {
                path,
                old_path: None,
                kind: ChangeKind::Conflicted,
            });
            continue;
        }
        if let Some(kind) = index_kind(x) {
            report.staged.push(ChangeEntry {
                path: path.clone(),
                old_path: old_path.clone(),
                kind,
            });
        }
        if let Some(kind) = worktree_kind(y) {
            report.unstaged.push(ChangeEntry {
                path,
                old_path,
                kind,
            });
        }
    }
    collapse_untracked_dirs(&mut report.unstaged);
    Ok(report)
}

fn index_kind(x: char) -> Option<ChangeKind> {
    match x {
        'M' => Some(ChangeKind::Modified),
        'A' => Some(ChangeKind::Added),
        'D' => Some(ChangeKind::Deleted),
        'R' => Some(ChangeKind::Renamed),
        'C' => Some(ChangeKind::Renamed),
        _ => None,
    }
}

fn worktree_kind(y: char) -> Option<ChangeKind> {
    match y {
        'M' => Some(ChangeKind::Modified),
        'D' => Some(ChangeKind::Deleted),
        'R' => Some(ChangeKind::Renamed),
        '?' => Some(ChangeKind::Untracked),
        _ => None,
    }
}

/// Collapses `dir/file` sequences back into one `dir/` entry like git does
/// with `recurse_untracked_dirs(false)` (local behavior).
fn collapse_untracked_dirs(unstaged: &mut Vec<ChangeEntry>) {
    let mut dirs: std::collections::HashSet<String> = Default::default();
    for e in unstaged.iter() {
        if e.kind == ChangeKind::Untracked {
            if let Some(slash) = e.path.find('/') {
                dirs.insert(e.path[..=slash].to_string());
            }
        }
    }
    if dirs.is_empty() {
        return;
    }
    unstaged.retain(|e| {
        if e.kind != ChangeKind::Untracked {
            return true;
        }
        match e.path.find('/') {
            Some(slash) => !dirs.contains(&e.path[..=slash]),
            None => true,
        }
    });
    let mut dir_entries: Vec<ChangeEntry> = dirs
        .into_iter()
        .map(|path| ChangeEntry {
            path,
            old_path: None,
            kind: ChangeKind::Untracked,
        })
        .collect();
    dir_entries.sort_by(|a, b| a.path.cmp(&b.path));
    unstaged.extend(dir_entries);
    unstaged.sort_by(|a, b| a.path.cmp(&b.path));
}

/// Mirrors `repo::summarize`: branch, HEAD, ahead/behind, emptiness.
pub fn summarize(repo_id: &str, target: &SshTarget, display: &str) -> Result<RepoSummary, EgError> {
    let branch = run_git(
        target,
        &["branch", "--show-current"],
        None,
        CLI_TIMEOUT_QUICK,
    )
    .map(|s| {
        let b = s.trim().to_string();
        if b.is_empty() {
            None
        } else {
            Some(b)
        }
    })
    .unwrap_or(None);
    let head_oid = rev_parse(target, "HEAD").ok().filter(|h| !h.is_empty());
    let is_empty = head_oid.is_none();
    let name = display.rsplit('/').next().unwrap_or(display).to_string();

    let (mut ahead, mut behind) = (0u32, 0u32);
    if let Some(branch) = &branch {
        let upstream = run_git(
            target,
            &[
                "rev-parse",
                "--abbrev-ref",
                &format!("{branch}@{{upstream}}"),
            ],
            None,
            CLI_TIMEOUT_QUICK,
        )
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
        if !upstream.is_empty() {
            if let Ok(counts) = run_git(
                target,
                &[
                    "rev-list",
                    "--count",
                    "--left-right",
                    &format!("HEAD...{upstream}"),
                ],
                None,
                CLI_TIMEOUT_QUICK,
            ) {
                // Output: "ahead\tbehind".
                let mut parts = counts.split_whitespace();
                ahead = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
                behind = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
            }
        }
    }

    Ok(RepoSummary {
        repo_id: repo_id.to_string(),
        path: display.to_string(),
        name,
        branch,
        head_oid,
        ahead,
        behind,
        is_empty,
    })
}

// ---------------------------------------------------------------------------
// Staging / .gitignore (mirrors ops.rs; safe writes stay, destructive refuse).
// ---------------------------------------------------------------------------

pub fn stage(
    target: &SshTarget,
    paths: &[String],
    mode: StageMode,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<(), EgError> {
    match mode {
        StageMode::Stage => {
            let mut args = vec!["add".to_string(), "--".to_string()];
            args.extend(paths.iter().cloned());
            let refs: Vec<&str> = args.iter().map(String::as_str).collect();
            run_git(target, &refs, on_progress, CLI_TIMEOUT_QUICK)?;
            Ok(())
        }
        StageMode::Unstage => {
            // `git reset HEAD -- <paths>`; unborn HEAD falls back to `rm --cached`.
            let mut args = vec!["reset".to_string(), "HEAD".to_string(), "--".to_string()];
            args.extend(paths.iter().cloned());
            let refs: Vec<&str> = args.iter().map(String::as_str).collect();
            match run_git(target, &refs, on_progress, CLI_TIMEOUT_QUICK) {
                Ok(_) => Ok(()),
                Err(_) => {
                    let mut rm = vec![
                        "rm".to_string(),
                        "--cached".to_string(),
                        "-r".to_string(),
                        "--".to_string(),
                    ];
                    rm.extend(paths.iter().cloned());
                    let refs: Vec<&str> = rm.iter().map(String::as_str).collect();
                    run_git(target, &refs, on_progress, CLI_TIMEOUT_QUICK)?;
                    Ok(())
                }
            }
        }
    }
}

pub fn discard(_target: &SshTarget, _paths: &[String]) -> Result<String, EgError> {
    Err(remote_read_only("丢弃修改"))
}

pub fn clean(_target: &SshTarget, _paths: &[String]) -> Result<String, EgError> {
    Err(remote_read_only("清理未跟踪"))
}

pub fn undo(_target: &SshTarget, _op_id: &str) -> Result<(), EgError> {
    Err(remote_read_only("撤销"))
}

pub fn redo(_target: &SshTarget) -> Result<String, EgError> {
    Err(remote_read_only("重做"))
}

pub fn restore_to(_target: &SshTarget, _oid: &str) -> Result<(), EgError> {
    Err(remote_read_only("恢复到此状态"))
}

pub fn reset(
    _target: &SshTarget,
    _mode: ResetMode,
    _target_ref: Option<&str>,
) -> Result<(), EgError> {
    Err(remote_read_only("重置"))
}

pub fn ignore(
    target: &SshTarget,
    paths: &[String],
    mode: IgnoreMode,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<Vec<String>, EgError> {
    // Read current .gitignore (missing file = empty), append fresh rules.
    let probe = ssh::probe_cmd("cat", &[&format!("{}/.gitignore", target.path)]);
    let existing = ssh::ssh_run(target, &probe, on_progress, CLI_TIMEOUT_QUICK)
        .map(|(t, _)| t)
        .unwrap_or_default();
    let mut rules: Vec<String> = match mode {
        IgnoreMode::ByPath => paths
            .iter()
            .map(|p| format!("/{}", p.trim_end_matches('/')))
            .collect(),
        IgnoreMode::ByExtension => {
            let mut exts: Vec<String> = paths
                .iter()
                .filter_map(|p| {
                    std::path::Path::new(p.trim_end_matches('/'))
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
        // Heredoc write keeps quoting simple and avoids nested escapes.
        remote_write(
            target,
            &format!("{}/.gitignore", target.path),
            &content,
            on_progress,
        )?;
    }
    Ok(fresh)
}

pub fn gitignore_missing(target: &SshTarget) -> Result<bool, EgError> {
    let probe = format!(
        "test -f {} && echo present || echo absent",
        ssh::shell_quote(&format!("{}/.gitignore", target.path))
    );
    let (text, _) = ssh::ssh_run(target, &probe, None, CLI_TIMEOUT_QUICK)?;
    Ok(!text.contains("present"))
}

pub fn write_default_gitignore(target: &SshTarget) -> Result<bool, EgError> {
    if !gitignore_missing(target)? {
        return Ok(false);
    }
    let template = include_str!("default-gitignore.txt");
    remote_write(
        target,
        &format!("{}/.gitignore", target.path),
        template,
        None,
    )?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Commit (mirrors commit.rs guards, executes `git commit` remotely).
// ---------------------------------------------------------------------------

pub fn commit(
    repo_id: &str,
    target: &SshTarget,
    req: &CommitRequest,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<CommitOutcome, EgError> {
    let subject = req.subject.trim();
    if subject.is_empty() {
        return Err(EgError::Internal {
            context: "commit message is empty".into(),
        });
    }
    // Mid-merge guard: refuse while conflicts remain.
    let merge_head = rev_parse(target, "MERGE_HEAD").unwrap_or_default();
    if !merge_head.is_empty() {
        let conflicts = conflicts_list(target)?;
        if !conflicts.is_empty() {
            return Err(EgError::ConflictState {
                state: "还有未解决的冲突".into(),
                detail: None,
            });
        }
    }
    // Partial-staging guard mirrors commit.rs.
    if merge_head.is_empty() && !req.allow_partial && !req.amend {
        let report = status(repo_id, target, None)?;
        let partial: Vec<String> = report
            .staged
            .iter()
            .filter(|e| {
                report
                    .unstaged
                    .iter()
                    .any(|u| u.path == e.path && u.kind != ChangeKind::Untracked)
            })
            .map(|e| e.path.clone())
            .collect();
        if !partial.is_empty() {
            return Err(EgError::UnsafeOperation {
                confirm_required: format!("部分暂存：{}", partial.join("、")),
            });
        }
    }
    // Nothing staged (unless amending / merge finalize).
    if !req.amend && merge_head.is_empty() {
        let staged_empty = run_git(
            target,
            &["diff", "--cached", "--quiet"],
            None,
            CLI_TIMEOUT_QUICK,
        );
        if staged_empty.is_ok() {
            return Err(EgError::Internal {
                context: "nothing staged to commit".into(),
            });
        }
    }

    let message = if req.body.trim().is_empty() {
        subject.to_string()
    } else {
        format!("{}\n\n{}", subject, req.body.trim())
    };
    let mut args = vec!["commit".to_string(), "-m".to_string(), message];
    if req.amend {
        args.push("--amend".to_string());
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(target, &refs, on_progress, CLI_TIMEOUT_NETWORK)?;
    let commit_id = rev_parse(target, "HEAD").unwrap_or_default();
    Ok(CommitOutcome {
        commit_id,
        amended: req.amend,
        summary: summarize(repo_id, target, &target.uri())?,
        status: status(repo_id, target, None)?,
    })
}

// ---------------------------------------------------------------------------
// Config (mirrors config.rs; Global scope edits the LOCAL machine config —
// refused for SSH targets to avoid surprising the user).
// ---------------------------------------------------------------------------

pub fn config_get(
    target: &SshTarget,
    scope: ConfigScope,
    key: &str,
) -> Result<Option<String>, EgError> {
    match scope {
        ConfigScope::Repo => {
            let out = run_git(target, &["config", "--get", key], None, CLI_TIMEOUT_QUICK)
                .unwrap_or_default();
            let value = out.lines().next().unwrap_or_default().trim().to_string();
            Ok(if value.is_empty() { None } else { Some(value) })
        }
        ConfigScope::Global => Err(EgError::NotSupported {
            feature: "远端仓库不支持修改本机全局配置，请在服务器上直接操作".into(),
        }),
    }
}

pub fn config_set(
    target: &SshTarget,
    scope: ConfigScope,
    key: &str,
    value: &str,
) -> Result<(), EgError> {
    match scope {
        ConfigScope::Repo => {
            run_git(target, &["config", key, value], None, CLI_TIMEOUT_QUICK)?;
            Ok(())
        }
        ConfigScope::Global => Err(EgError::NotSupported {
            feature: "远端仓库不支持修改本机全局配置，请在服务器上直接操作".into(),
        }),
    }
}

// ---------------------------------------------------------------------------
// Log / history (mirrors log.rs; rev-list --topo-order + decorations).
// ---------------------------------------------------------------------------

const MAX_SCAN: u32 = 100_000;

pub struct LogPageRequest {
    pub offset: u32,
    pub limit: u32,
    pub filter: LogFilter,
}

/// `git log --topo-order` with a tab-separated record format, decorations via
/// a second `for-each-ref` pass.
pub fn log_page(
    repo_id: &str,
    target: &SshTarget,
    req: &LogPageRequest,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<LogPage, EgError> {
    let start = match &req.filter.branch {
        Some(b) => format!("refs/heads/{b}"),
        None => "HEAD".to_string(),
    };
    // Verify the start ref exists (unborn HEAD → empty page like local).
    if req.filter.branch.is_none() && rev_parse(target, "HEAD").unwrap_or_default().is_empty() {
        let branch = current_branch(target)?;
        return Ok(LogPage {
            repo_id: repo_id.to_string(),
            entries: Vec::new(),
            next_offset: None,
            branch,
        });
    }
    let format = "%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B%x1e";
    let out = run_git(
        target,
        &["log", "--topo-order", &format!("--format={format}"), &start],
        on_progress,
        CLI_TIMEOUT_NETWORK,
    )?;
    let ref_map = build_ref_map(target)?;
    let head_oid = rev_parse(target, "HEAD").unwrap_or_default();
    let branch = current_branch(target)?;

    let author_needle = req.filter.author.as_deref().map(str::to_lowercase);
    let message_needle = req.filter.message.as_deref().map(str::to_lowercase);

    let mut lanes = Lanes::new();
    let mut entries = Vec::new();
    let mut scanned: u32 = 0;
    let mut skipped: u32 = 0;
    let mut exhausted = true;

    for record in out.split('\x1e') {
        let record = record.trim_start_matches('\n');
        if record.trim().is_empty() {
            continue;
        }
        if scanned >= MAX_SCAN {
            exhausted = false;
            break;
        }
        scanned += 1;
        let mut fields = record.splitn(6, '\x1f');
        let (Some(oid), Some(parents), Some(an), Some(ae), Some(at), Some(msg)) = (
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
        ) else {
            continue;
        };
        if let Some(needle) = &author_needle {
            if !an.to_lowercase().contains(needle) {
                continue;
            }
        }
        if let Some(needle) = &message_needle {
            if !msg.to_lowercase().contains(needle) {
                continue;
            }
        }
        let parents: Vec<String> = if parents.trim().is_empty() {
            Vec::new()
        } else {
            parents.split_whitespace().map(str::to_string).collect()
        };
        if skipped < req.offset {
            skipped += 1;
            lanes.emit(oid, &parents);
            continue;
        }
        let (node, lines, lane_count) = lanes.emit(oid, &parents);
        let (subject, body) = split_message(msg.trim_end_matches('\n'));
        let refs = ref_map.get(oid).cloned().unwrap_or(CommitRefs {
            branches: Vec::new(),
            remotes: Vec::new(),
            tags: Vec::new(),
        });
        entries.push(CommitLogEntry {
            oid: oid.to_string(),
            short_oid: oid.get(..7).unwrap_or(oid).to_string(),
            subject,
            body,
            author_name: an.to_string(),
            author_email: ae.to_string(),
            author_time: at.parse::<i64>().unwrap_or(0).max(0) as f64,
            parent_count: parents.len() as u32,
            is_head: *oid == head_oid,
            refs,
            node,
            lines,
            lane_count,
        });
        if entries.len() == req.limit as usize {
            exhausted = false;
            break;
        }
    }

    Ok(LogPage {
        repo_id: repo_id.to_string(),
        entries,
        next_offset: if exhausted { None } else { Some(scanned) },
        branch,
    })
}

fn build_ref_map(target: &SshTarget) -> Result<HashMap<String, CommitRefs>, EgError> {
    let mut map: HashMap<String, CommitRefs> = HashMap::new();
    let out = run_git(
        target,
        &[
            "for-each-ref",
            "--format=%(objectname) %(refname)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
        None,
        CLI_TIMEOUT_QUICK,
    )
    .unwrap_or_default();
    for line in out.lines() {
        let mut parts = line.split_whitespace();
        let (Some(oid), Some(full)) = (parts.next(), parts.next()) else {
            continue;
        };
        // Peel annotated tags / symbolic refs to commits.
        let commit = rev_parse(target, oid).unwrap_or_default();
        let commit = if commit.is_empty() {
            oid.to_string()
        } else {
            commit
        };
        let entry = map.entry(commit).or_insert(CommitRefs {
            branches: Vec::new(),
            remotes: Vec::new(),
            tags: Vec::new(),
        });
        if let Some(b) = full.strip_prefix("refs/heads/") {
            entry.branches.push(b.to_string());
        } else if let Some(r) = full.strip_prefix("refs/remotes/") {
            entry.remotes.push(r.to_string());
        } else if let Some(t) = full.strip_prefix("refs/tags/") {
            entry.tags.push(t.to_string());
        }
    }
    // Current branch leads its commit's decoration list.
    if let Ok(Some(branch)) = current_branch(target).map(|b| if b.is_some() { b } else { None }) {
        let head = rev_parse(target, "HEAD").unwrap_or_default();
        if let Some(refs) = map.get_mut(&head) {
            if let Some(pos) = refs.branches.iter().position(|b| b == &branch) {
                let b = refs.branches.remove(pos);
                refs.branches.insert(0, b);
            }
        }
    }
    Ok(map)
}

fn current_branch(target: &SshTarget) -> Result<Option<String>, EgError> {
    let out = run_git(
        target,
        &["branch", "--show-current"],
        None,
        CLI_TIMEOUT_QUICK,
    )
    .unwrap_or_default();
    let b = out.trim();
    Ok(if b.is_empty() {
        None
    } else {
        Some(b.to_string())
    })
}

pub fn commit_detail(target: &SshTarget, oid: &str) -> Result<CommitDetail, EgError> {
    let format = "%an%x1f%ae%x1f%at%x1f%B%x1e";
    let out = run_git(
        target,
        &["show", "-s", &format!("--format={format}"), oid],
        None,
        CLI_TIMEOUT_QUICK,
    )?;
    let record = out.split('\x1e').next().unwrap_or("");
    let mut fields = record.splitn(4, '\x1f');
    let (an, ae, at, msg) = (
        fields.next().unwrap_or(""),
        fields.next().unwrap_or(""),
        fields.next().unwrap_or(""),
        fields.next().unwrap_or(""),
    );
    let (subject, body) = split_message(msg.trim_end_matches('\n'));

    // Changed files with rename detection + per-file counts.
    let diffstat = run_git(
        target,
        &["show", "--format=", "--find-renames", "--numstat", oid],
        None,
        CLI_TIMEOUT_QUICK,
    )
    .unwrap_or_default();
    let mut files = Vec::new();
    for line in diffstat.lines() {
        // numstat rename form: "a\tb\told => new" (or "old => {x => y}").
        let Some((added, deleted, paths)) = parse_numstat(line) else {
            continue;
        };
        let (path, old_path, kind) = if paths.contains("=>") {
            // Braced or simple rename expansion: resolve to old/new pair.
            let (old, new) = expand_rename(&paths);
            (new, Some(old), ChangeKind::Renamed)
        } else {
            let kind = if added > 0 && deleted == 0 {
                // Ambiguous with pure modify; disambiguate via name-status.
                ChangeKind::Modified
            } else if added == 0 && deleted > 0 {
                ChangeKind::Deleted
            } else {
                ChangeKind::Modified
            };
            (paths.clone(), None, kind)
        };
        files.push(CommitFile {
            path,
            old_path,
            kind,
            added,
            deleted,
        });
    }
    // Precise kinds (A/D/R) from name-status with rename detection.
    let namestat = run_git(
        target,
        &["show", "--format=", "--find-renames", "--name-status", oid],
        None,
        CLI_TIMEOUT_QUICK,
    )
    .unwrap_or_default();
    for line in namestat.lines() {
        let mut parts = line.split('\t');
        match parts.next() {
            Some(s) if s.starts_with('R') => {
                if let (Some(old), Some(new)) = (parts.next(), parts.next()) {
                    if let Some(f) = files.iter_mut().find(|f| f.path == new) {
                        f.kind = ChangeKind::Renamed;
                        f.old_path = Some(old.to_string());
                    }
                }
            }
            Some("A") => {
                if let Some(p) = parts.next() {
                    if let Some(f) = files.iter_mut().find(|f| f.path == p) {
                        f.kind = ChangeKind::Added;
                    }
                }
            }
            Some("D") => {
                if let Some(p) = parts.next() {
                    if let Some(f) = files.iter_mut().find(|f| f.path == p) {
                        f.kind = ChangeKind::Deleted;
                    }
                }
            }
            _ => {}
        }
    }

    let ref_map = build_ref_map(target)?;
    let refs = ref_map.get(oid).cloned().unwrap_or(CommitRefs {
        branches: Vec::new(),
        remotes: Vec::new(),
        tags: Vec::new(),
    });
    Ok(CommitDetail {
        short_oid: oid.get(..7).unwrap_or(oid).to_string(),
        oid: oid.to_string(),
        subject,
        body,
        author_name: an.to_string(),
        author_email: ae.to_string(),
        author_time: at.parse::<i64>().unwrap_or(0).max(0) as f64,
        refs,
        files,
    })
}

/// Expands git's rename shorthands: `old => new` or `dir/{old => new}/f`.
fn expand_rename(paths: &str) -> (String, String) {
    if let Some((old, new)) = paths.split_once(" => ") {
        // Braced form: `dir/{a => b}/file`.
        if let (Some(l), Some(r)) = (old.find('{'), new.find('}')) {
            let prefix = &old[..l];
            let old_mid = &old[l + 1..];
            let new_mid = &new[..r];
            let suffix = &new[r + 1..];
            return (
                format!("{prefix}{old_mid}{suffix}"),
                format!("{prefix}{new_mid}{suffix}"),
            );
        }
        return (old.to_string(), new.to_string());
    }
    (paths.to_string(), paths.to_string())
}

pub fn list_branches(target: &SshTarget) -> Result<Vec<String>, EgError> {
    let out = run_git(
        target,
        &["branch", "--format=%(refname:short)"],
        None,
        CLI_TIMEOUT_QUICK,
    )?;
    let current = current_branch(target)?.unwrap_or_default();
    let mut branches: Vec<String> = out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    branches.sort_by(|a, b| {
        let ac = *a == current;
        let bc = *b == current;
        bc.cmp(&ac).then_with(|| a.cmp(b))
    });
    Ok(branches)
}

// ---------------------------------------------------------------------------
// Diff (mirrors diff.rs; `git diff` text re-parsed).
// ---------------------------------------------------------------------------

pub fn diff_file(
    repo_id: &str,
    target: &SshTarget,
    req: &DiffRequest,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<DiffResponse, EgError> {
    let args: Vec<String> = match req.source {
        DiffSourceKind::Worktree => vec![
            "diff".into(),
            "--no-color".into(),
            "--find-renames".into(),
            "--".into(),
            req.path.clone(),
        ],
        DiffSourceKind::Index => vec![
            "diff".into(),
            "--cached".into(),
            "--no-color".into(),
            "--find-renames".into(),
            "--".into(),
            req.path.clone(),
        ],
        DiffSourceKind::Commit => {
            let oid = req.commit_oid.as_deref().ok_or_else(|| EgError::Internal {
                context: "commit diff requires commit_oid".into(),
            })?;
            vec![
                "show".into(),
                "--format=".into(),
                "--no-color".into(),
                "--find-renames".into(),
                oid.into(),
                "--".into(),
                req.path.clone(),
            ]
        }
    };
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let patch = run_git(target, &refs, on_progress, CLI_TIMEOUT_NETWORK)?;
    if patch.trim().is_empty() {
        // Clean file (or raced away) — an empty diff, like local.
        return Ok(DiffResponse {
            repo_id: repo_id.to_string(),
            path: req.path.clone(),
            old_path: req.old_path.clone(),
            kind: ChangeKind::Modified,
            added: 0,
            deleted: 0,
            is_binary: false,
            truncated: false,
            hunks: Vec::new(),
        });
    }
    let (hunks, truncated, is_binary) = parse_patch(&patch);
    // Kind from name-status (cheap single call).
    let kind = diff_kind(target, req)?;
    let (added, deleted) = hunks.iter().fold((0u32, 0u32), |(a, d), h| {
        (
            a + h
                .lines
                .iter()
                .filter(|l| l.kind == DiffLineKind::Added)
                .count() as u32,
            d + h
                .lines
                .iter()
                .filter(|l| l.kind == DiffLineKind::Deleted)
                .count() as u32,
        )
    });
    Ok(DiffResponse {
        repo_id: repo_id.to_string(),
        path: req.path.clone(),
        old_path: req.old_path.clone(),
        kind,
        added,
        deleted,
        is_binary,
        truncated,
        hunks,
    })
}

fn diff_kind(target: &SshTarget, req: &DiffRequest) -> Result<ChangeKind, EgError> {
    let args: Vec<String> = match req.source {
        DiffSourceKind::Worktree => vec![
            "status".into(),
            "--porcelain=v1".into(),
            "-z".into(),
            "--".into(),
            req.path.clone(),
        ],
        DiffSourceKind::Index => vec![
            "status".into(),
            "--porcelain=v1".into(),
            "-z".into(),
            "--".into(),
            req.path.clone(),
        ],
        DiffSourceKind::Commit => {
            let oid = req.commit_oid.clone().unwrap_or_default();
            vec![
                "show".into(),
                "--format=".into(),
                "--name-status".into(),
                "--find-renames".into(),
                oid,
                "--".into(),
                req.path.clone(),
            ]
        }
    };
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_git(target, &refs, None, CLI_TIMEOUT_QUICK).unwrap_or_default();
    if req.source == DiffSourceKind::Commit {
        for line in out.lines() {
            if line.starts_with('R') {
                return Ok(ChangeKind::Renamed);
            }
            if line.starts_with('A') {
                return Ok(ChangeKind::Added);
            }
            if line.starts_with('D') {
                return Ok(ChangeKind::Deleted);
            }
        }
        return Ok(ChangeKind::Modified);
    }
    for entry in out.split('\0') {
        if entry.len() >= 4 {
            let (x, y) = (entry.as_bytes()[0] as char, entry.as_bytes()[1] as char);
            let relevant = match req.source {
                DiffSourceKind::Worktree => y,
                _ => x,
            };
            match relevant {
                'A' | '?' => {
                    return Ok(if relevant == '?' {
                        ChangeKind::Untracked
                    } else {
                        ChangeKind::Added
                    })
                }
                'D' => return Ok(ChangeKind::Deleted),
                'R' => return Ok(ChangeKind::Renamed),
                'M' => return Ok(ChangeKind::Modified),
                _ => {}
            }
        }
    }
    Ok(ChangeKind::Modified)
}

pub fn stage_lines(
    repo_id: &str,
    target: &SshTarget,
    req: &StageLinesRequest,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<StatusReport, EgError> {
    // Regenerate the full file patch, filter to the selected hunks/lines,
    // and apply with `git apply --cached` (or reverse for unstage) — the
    // same `git add -p` semantics as local stage_lines.
    let full = diff_file(
        repo_id,
        target,
        &DiffRequest {
            path: req.path.clone(),
            old_path: None,
            source: req.source,
            commit_oid: None,
        },
        None,
    )?;
    let mut kept: Vec<&DiffHunk> = Vec::new();
    let mut kept_lines: Vec<Vec<&DiffLine>> = Vec::new();
    for sel in &req.hunks {
        let Some(hunk) = full.hunks.get(sel.hunk_index as usize) else {
            continue;
        };
        let lines: Vec<&DiffLine> = sel
            .line_indexes
            .iter()
            .filter_map(|&i| hunk.lines.get(i as usize))
            .collect();
        if !lines.is_empty() {
            kept.push(hunk);
            kept_lines.push(lines);
        }
    }
    if kept.is_empty() {
        return Err(EgError::Internal {
            context: "no lines selected".into(),
        });
    }
    let mut patch = String::new();
    patch.push_str(&format!("diff --git a/{} b/{}\n", req.path, req.path));
    patch.push_str(&format!("--- a/{}\n", req.path));
    patch.push_str(&format!("+++ b/{}\n", req.path));
    for (hunk, lines) in kept.iter().zip(kept_lines.iter()) {
        // Recompute hunk counts for the filtered line set.
        let (mut add, mut del, mut ctx) = (0u32, 0u32, 0u32);
        for l in lines.iter() {
            match l.kind {
                DiffLineKind::Added => add += 1,
                DiffLineKind::Deleted => del += 1,
                DiffLineKind::Context => ctx += 1,
            }
        }
        patch.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            hunk.old_start,
            del + ctx,
            hunk.new_start,
            add + ctx
        ));
        for l in lines.iter() {
            let sigil = match l.kind {
                DiffLineKind::Added => '+',
                DiffLineKind::Deleted => '-',
                DiffLineKind::Context => ' ',
            };
            patch.push(sigil);
            patch.push_str(&l.content);
            patch.push('\n');
        }
    }
    let apply_args: &[&str] = match req.source {
        DiffSourceKind::Worktree => &["apply", "--cached"],
        DiffSourceKind::Index => &["apply", "--cached", "--reverse"],
        DiffSourceKind::Commit => {
            return Err(EgError::NotSupported {
                feature: "历史提交的 diff 是只读的".into(),
            })
        }
    };
    // Pipe the patch over stdin through a heredoc (stdin is null for git
    // itself, so the patch travels inside the remote shell command).
    // NOTE: this composes `git -C … apply` directly instead of `git_cmd`
    // because the patch is piped, not an argv word — the subcommand/flags
    // (`apply --cached`, optional `--reverse`) stay within the allowlist.
    let tag = heredoc_tag();
    let remote = format!(
        "patch=$(cat <<'{tag}'\n{patch}{eol}{tag}\n); printf '%s' \"$patch\" | git -C {} {} -",
        ssh::shell_quote(&target.path),
        apply_args.join(" "),
        eol = if patch.ends_with('\n') { "" } else { "\n" },
    );
    let (text, ok) = ssh::ssh_run(target, &remote, on_progress, CLI_TIMEOUT_QUICK)?;
    if !ok {
        return Err(ssh::humanize_ssh(&text, &target.uri(), target));
    }
    status(repo_id, target, None)
}

// ---------------------------------------------------------------------------
// Branches / tags (mirrors refs.rs; trash-bin deletes refused remotely).
// ---------------------------------------------------------------------------

pub fn branch_list(target: &SshTarget) -> Result<Vec<BranchInfo>, EgError> {
    let out = run_git(
        target,
        &[
            "for-each-ref",
            "--format=%(refname:short)%x1f%(objectname)%x1f%(upstream:short)%x1f%(contents:subject)%x1f%(*committerdate:unix)",
            "refs/heads",
        ],
        None,
        CLI_TIMEOUT_QUICK,
    )
    .unwrap_or_default();
    let current = current_branch(target)?.unwrap_or_default();
    let mut branches = Vec::new();
    for line in out.lines() {
        let mut f = line.split('\x1f');
        let (Some(name), Some(tip), Some(upstream), Some(subject), Some(time)) =
            (f.next(), f.next(), f.next(), f.next(), f.next())
        else {
            continue;
        };
        let (ahead, behind) = if upstream.is_empty() {
            (0, 0)
        } else {
            run_git(
                target,
                &[
                    "rev-list",
                    "--count",
                    "--left-right",
                    &format!("{name}...{upstream}"),
                ],
                None,
                CLI_TIMEOUT_QUICK,
            )
            .map(|s| {
                let mut p = s.split_whitespace();
                (
                    p.next().and_then(|n| n.parse().ok()).unwrap_or(0),
                    p.next().and_then(|n| n.parse().ok()).unwrap_or(0),
                )
            })
            .unwrap_or((0, 0))
        };
        let tip_time = if time.is_empty() {
            // Lightweight branch tip: fall back to the tip commit time.
            run_git(
                target,
                &["log", "-1", "--format=%ct", tip],
                None,
                CLI_TIMEOUT_QUICK,
            )
            .map(|s| s.trim().parse::<i64>().unwrap_or(0).max(0) as f64)
            .unwrap_or(0.0)
        } else {
            time.parse::<i64>().unwrap_or(0).max(0) as f64
        };
        branches.push(BranchInfo {
            name: name.to_string(),
            is_current: *name == current,
            upstream: if upstream.is_empty() {
                None
            } else {
                Some(upstream.to_string())
            },
            ahead,
            behind,
            tip_oid: tip.to_string(),
            tip_subject: subject.to_string(),
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

pub fn create_branch(
    target: &SshTarget,
    name: &str,
    oid: Option<&str>,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<BranchInfo, EgError> {
    let start = oid.unwrap_or("HEAD");
    match run_git(
        target,
        &["branch", name, start],
        on_progress,
        CLI_TIMEOUT_QUICK,
    ) {
        Ok(_) => {}
        Err(e) => {
            return Err(EgError::Internal {
                context: format!("创建分支失败（名称不合法或已存在）：{e}"),
            })
        }
    }
    branch_list(target)?
        .into_iter()
        .find(|b| b.name == name)
        .ok_or_else(|| EgError::Internal {
            context: "branch vanished after create".into(),
        })
}

pub fn rename_branch(target: &SshTarget, old_name: &str, new_name: &str) -> Result<(), EgError> {
    run_git(
        target,
        &["branch", "-m", old_name, new_name],
        None,
        CLI_TIMEOUT_QUICK,
    )
    .map_err(|e| EgError::Internal {
        context: format!("重命名失败（名称不合法或已存在）：{e}"),
    })?;
    Ok(())
}

pub fn delete_branch(_target: &SshTarget, _name: &str) -> Result<String, EgError> {
    // No trash bin over SSH (refs/easy-git/trash would be a server-side ref
    // with multi-writer races and no local undo); refuse by policy.
    Err(remote_read_only("删除分支"))
}

pub fn switch_branch(
    repo_id: &str,
    target: &SshTarget,
    name: &str,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<StatusReport, EgError> {
    run_git(target, &["switch", name], on_progress, CLI_TIMEOUT_NETWORK).map_err(|e| match &e {
        EgError::Internal { context } if context.contains("overwritten by checkout") => {
            EgError::DirtyWorktree { paths: Vec::new() }
        }
        other => EgError::Internal {
            context: format!("切换分支失败：{other}"),
        },
    })?;
    status(repo_id, target, None)
}

pub fn tag_list(target: &SshTarget) -> Result<Vec<TagInfo>, EgError> {
    let out = run_git(
        target,
        &[
            "for-each-ref",
            "--sort=-creatordate",
            "--format=%(refname:short)%x1f%(objectname)%x1f%(*objectname)%x1f%(objecttype)%x1f%(contents:subject)%x1f%(creatordate:unix)%x1f%(taggerdate:unix)",
            "refs/tags",
        ],
        None,
        CLI_TIMEOUT_QUICK,
    )
    .unwrap_or_default();
    let mut tags = Vec::new();
    for line in out.lines() {
        let mut f = line.split('\x1f');
        let (
            Some(name),
            Some(oid),
            Some(peeled),
            Some(objtype),
            Some(subject),
            Some(created),
            Some(taggerdate),
        ) = (
            f.next(),
            f.next(),
            f.next(),
            f.next(),
            f.next(),
            f.next(),
            f.next(),
        )
        else {
            continue;
        };
        let annotated = objtype == "tag";
        let target_oid = if peeled.is_empty() { oid } else { peeled }.to_string();
        let time = if annotated {
            taggerdate.parse::<i64>().unwrap_or(0).max(0) as f64
        } else {
            created.parse::<i64>().unwrap_or(0).max(0) as f64
        };
        tags.push(TagInfo {
            name: name.to_string(),
            target_oid,
            annotated,
            message: if annotated && !subject.is_empty() {
                Some(subject.to_string())
            } else {
                None
            },
            time,
        });
    }
    Ok(tags)
}

pub fn create_tag(
    target: &SshTarget,
    name: &str,
    oid: &str,
    message: Option<&str>,
) -> Result<TagInfo, EgError> {
    let result = match message {
        Some(msg) if !msg.trim().is_empty() => run_git(
            target,
            &["tag", "-a", name, oid, "-m", msg],
            None,
            CLI_TIMEOUT_QUICK,
        ),
        _ => run_git(target, &["tag", name, oid], None, CLI_TIMEOUT_QUICK),
    };
    if let Err(e) = result {
        return Err(EgError::Internal {
            context: format!("创建标签失败（名称不合法或已存在）：{e}"),
        });
    }
    tag_list(target)?
        .into_iter()
        .find(|t| t.name == name)
        .ok_or_else(|| EgError::Internal {
            context: "tag vanished after create".into(),
        })
}

pub fn delete_tag(_target: &SshTarget, _name: &str) -> Result<String, EgError> {
    Err(remote_read_only("删除标签"))
}

pub fn set_branch_upstream(
    target: &SshTarget,
    branch: &str,
    upstream: Option<&str>,
) -> Result<(), EgError> {
    match upstream {
        Some(up) => {
            run_git(
                target,
                &["branch", &format!("--set-upstream-to={up}"), branch],
                None,
                CLI_TIMEOUT_QUICK,
            )?;
            Ok(())
        }
        None => {
            run_git(
                target,
                &["branch", "--unset-upstream", branch],
                None,
                CLI_TIMEOUT_QUICK,
            )?;
            Ok(())
        }
    }
}

pub fn remote_branch_list(target: &SshTarget) -> Result<Vec<String>, EgError> {
    let out = run_git(
        target,
        &["branch", "-r", "--format=%(refname:short)"],
        None,
        CLI_TIMEOUT_QUICK,
    )
    .unwrap_or_default();
    let mut branches: Vec<String> = out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && !l.ends_with("/HEAD"))
        .collect();
    branches.sort();
    Ok(branches)
}

// ---------------------------------------------------------------------------
// Stash (mirrors stash.rs via CLI; drop refused by policy).
// ---------------------------------------------------------------------------

pub fn stash_list(target: &SshTarget) -> Result<Vec<StashEntry>, EgError> {
    let out = run_git(
        target,
        &["stash", "list", "--format=%gd%x1f%gs%x1f%H"],
        None,
        CLI_TIMEOUT_QUICK,
    )
    .unwrap_or_default();
    let mut entries = Vec::new();
    for line in out.lines() {
        let mut f = line.splitn(3, '\x1f');
        let (Some(gd), Some(msg), Some(oid)) = (f.next(), f.next(), f.next()) else {
            continue;
        };
        // `stash@{0}` → 0.
        let index = gd
            .trim_start_matches("stash@{")
            .trim_end_matches('}')
            .parse::<u32>()
            .unwrap_or(0);
        entries.push(StashEntry {
            index,
            message: msg.to_string(),
            oid: oid.to_string(),
        });
    }
    Ok(entries)
}

pub fn stash_push(
    repo_id: &str,
    target: &SshTarget,
    message: Option<&str>,
    include_untracked: bool,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<StatusReport, EgError> {
    let mut args = vec!["stash".to_string(), "push".to_string()];
    if include_untracked {
        args.push("-u".to_string());
    }
    if let Some(msg) = message {
        if !msg.trim().is_empty() {
            args.push("-m".to_string());
            args.push(msg.to_string());
        }
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(target, &refs, on_progress, CLI_TIMEOUT_NETWORK).map_err(|e| EgError::Internal {
        context: format!("储藏失败：{e}"),
    })?;
    status(repo_id, target, None)
}

pub fn stash_apply(
    repo_id: &str,
    target: &SshTarget,
    index: u32,
    pop: bool,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<StatusReport, EgError> {
    let what = format!("stash@{{{index}}}");
    let op = if pop { "pop" } else { "apply" };
    run_git(
        target,
        &["stash", op, "--index", &what],
        on_progress,
        CLI_TIMEOUT_NETWORK,
    )
    .map_err(|e| EgError::ConflictState {
        state: format!("储藏应用冲突：{e}"),
        detail: None,
    })?;
    status(repo_id, target, None)
}

pub fn stash_drop(_target: &SshTarget, _index: u32) -> Result<Vec<StashEntry>, EgError> {
    Err(remote_read_only("删除储藏"))
}

// ---------------------------------------------------------------------------
// Merge / conflicts / revert (mirrors merge.rs + conflicts.rs via CLI).
// ---------------------------------------------------------------------------

pub fn merge_start(
    repo_id: &str,
    target: &SshTarget,
    name: &str,
    no_ff: bool,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<MergeOutcome, EgError> {
    let mut args = vec!["merge".to_string()];
    if no_ff {
        args.push("--no-ff".to_string());
    }
    args.push(name.to_string());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    match run_git(target, &refs, on_progress, CLI_TIMEOUT_NETWORK) {
        Ok(_) => Ok(MergeOutcome {
            fast_forwarded: true,
            conflicts: Vec::new(),
            status: status(repo_id, target, None)?,
        }),
        Err(e) => {
            // A conflicted merge exits non-zero; distinguish from hard errors
            // by asking git whether we are now mid-merge.
            let mid = merge_state(target)?.is_some();
            if mid {
                Ok(MergeOutcome {
                    fast_forwarded: false,
                    conflicts: conflicts_list(target)?,
                    status: status(repo_id, target, None)?,
                })
            } else {
                Err(e)
            }
        }
    }
}

pub fn merge_state(target: &SshTarget) -> Result<Option<MergeState>, EgError> {
    let head = rev_parse(target, "MERGE_HEAD").unwrap_or_default();
    if head.is_empty() {
        return Ok(None);
    }
    let probe = format!(
        "cat {} 2>/dev/null; echo ---; cat {} 2>/dev/null",
        ssh::shell_quote(&format!("{}/.git/MERGE_MSG", target.path)),
        ssh::shell_quote(&format!("{}/.git/MERGE_HEAD", target.path)),
    );
    let (text, _) = ssh::ssh_run(target, &probe, None, CLI_TIMEOUT_QUICK)?;
    let mut parts = text.splitn(2, "---");
    let msg = parts.next().unwrap_or("").trim().to_string();
    let heads = parts.next().unwrap_or("").trim().to_string();
    let theirs: Vec<String> = heads
        .lines()
        .map(|l| l.trim().get(..7).unwrap_or(l.trim()).to_string())
        .filter(|l| !l.is_empty())
        .collect();
    Ok(Some(MergeState {
        message: if msg.is_empty() { None } else { Some(msg) },
        theirs,
    }))
}

pub fn merge_abort(
    repo_id: &str,
    target: &SshTarget,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<StatusReport, EgError> {
    run_git(
        target,
        &["merge", "--abort"],
        on_progress,
        CLI_TIMEOUT_NETWORK,
    )?;
    status(repo_id, target, None)
}

fn conflicts_list(target: &SshTarget) -> Result<Vec<String>, EgError> {
    let out = run_git(
        target,
        &["diff", "--name-only", "--diff-filter=U"],
        None,
        CLI_TIMEOUT_QUICK,
    )
    .unwrap_or_default();
    Ok(out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

pub fn conflicts_get(
    target: &SshTarget,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<Vec<eg_types::ConflictFile>, EgError> {
    let mut files = Vec::new();
    for path in conflicts_list(target)? {
        // Three stages via `git show :1:path / :2: / :3:`; missing stage = empty.
        let show = |stage: u8| {
            run_git(
                target,
                &["show", &format!(":{stage}:{path}")],
                None,
                CLI_TIMEOUT_QUICK,
            )
            .unwrap_or_default()
        };
        let base_content = some_if_nonempty(show(1));
        let ours_content = some_if_nonempty(show(2));
        let theirs_content = some_if_nonempty(show(3));
        // Prefer the on-disk content for marker parsing (user may have edited).
        let probe = ssh::probe_cmd("cat", &[&format!("{}/{}", target.path, path)]);
        let disk = ssh::ssh_run(target, &probe, on_progress, CLI_TIMEOUT_QUICK)
            .map(|(t, _)| t)
            .unwrap_or_default();
        let content = if disk.is_empty() {
            ours_content.clone().unwrap_or_default()
        } else {
            disk
        };
        let is_binary = looks_binary(&content);
        let (segments, blocks) = if is_binary {
            (Vec::new(), Vec::new())
        } else {
            parse_blocks(&content)
        };
        files.push(eg_types::ConflictFile {
            path,
            base_content,
            ours_content,
            theirs_content,
            segments,
            blocks,
            is_binary,
        });
    }
    Ok(files)
}

fn some_if_nonempty(s: String) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

pub fn conflict_resolve(
    repo_id: &str,
    target: &SshTarget,
    path: &str,
    content: &str,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<StatusReport, EgError> {
    // Write the resolved content, then `git add` the path (same finalize as
    // local conflict_resolve minus the local fs calls).
    remote_write(
        target,
        &format!("{}/{}", target.path, path),
        content,
        on_progress,
    )?;
    run_git(target, &["add", "--", path], on_progress, CLI_TIMEOUT_QUICK)?;
    status(repo_id, target, None)
}

pub fn revert(
    repo_id: &str,
    target: &SshTarget,
    oids: &[String],
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<StatusReport, EgError> {
    let mut args = vec!["revert".to_string(), "--no-commit".to_string()];
    args.extend(oids.iter().cloned());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(target, &refs, on_progress, CLI_TIMEOUT_NETWORK)?;
    status(repo_id, target, None)
}

// ---------------------------------------------------------------------------
// Remotes / sync (mirrors remote.rs network surface over the SSH channel).
// ---------------------------------------------------------------------------

pub fn remote_list(target: &SshTarget) -> Result<Vec<RemoteInfo>, EgError> {
    let out = run_git(target, &["remote", "-v"], None, CLI_TIMEOUT_QUICK).unwrap_or_default();
    let mut map: HashMap<String, RemoteInfo> = HashMap::new();
    for line in out.lines() {
        // "<name>\t<url> (fetch|push)".
        let mut parts = line.split_whitespace();
        let (Some(name), Some(url), Some(kind)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let entry = map.entry(name.to_string()).or_insert(RemoteInfo {
            name: name.to_string(),
            url: url.to_string(),
            push_url: None,
        });
        if kind == "(push)" && url != entry.url {
            entry.push_url = Some(url.to_string());
        }
    }
    let mut remotes: Vec<RemoteInfo> = map.into_values().collect();
    remotes.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(remotes)
}

pub fn remote_add(target: &SshTarget, name: &str, url: &str) -> Result<(), EgError> {
    let name = name.trim();
    if name.is_empty() || url.trim().is_empty() {
        return Err(EgError::Internal {
            context: "remote name / url is empty".into(),
        });
    }
    run_git(
        target,
        &["remote", "add", name, url],
        None,
        CLI_TIMEOUT_QUICK,
    )?;
    Ok(())
}

pub fn remote_rename(
    target: &SshTarget,
    old_name: &str,
    new_name: &str,
) -> Result<Vec<String>, EgError> {
    let out = run_git(
        target,
        &["remote", "rename", old_name, new_name],
        None,
        CLI_TIMEOUT_QUICK,
    )?;
    // `git remote rename` prints ref-update problems; surface them as lines.
    Ok(out
        .lines()
        .map(str::to_string)
        .filter(|l| !l.trim().is_empty())
        .collect())
}

pub fn remote_remove(target: &SshTarget, name: &str) -> Result<(), EgError> {
    run_git(target, &["remote", "remove", name], None, CLI_TIMEOUT_QUICK)?;
    Ok(())
}

pub fn remote_set_url(target: &SshTarget, name: &str, url: &str) -> Result<(), EgError> {
    run_git(
        target,
        &["remote", "set-url", name, url],
        None,
        CLI_TIMEOUT_QUICK,
    )?;
    Ok(())
}

/// `git ls-remote` on the host — the remote's refs, counted by the caller.
pub fn ls_remote(
    target: &SshTarget,
    remote: &str,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<Vec<(String, String)>, EgError> {
    let out = run_git(
        target,
        &["ls-remote", remote],
        on_progress,
        CLI_TIMEOUT_NETWORK,
    )?;
    let mut refs = Vec::new();
    for line in out.lines() {
        let mut parts = line.split_whitespace();
        if let (Some(oid), Some(name)) = (parts.next(), parts.next()) {
            refs.push((oid.to_string(), name.to_string()));
        }
    }
    Ok(refs)
}

pub fn fetch(
    target: &SshTarget,
    remote: &str,
    prune: bool,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<(), EgError> {
    let mut args = vec!["fetch".to_string(), "--progress".to_string()];
    if prune {
        args.push("--prune".to_string());
    }
    args.push(remote.to_string());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(target, &refs, on_progress, CLI_TIMEOUT_NETWORK)?;
    Ok(())
}

pub fn push(
    target: &SshTarget,
    remote: &str,
    branch: &str,
    set_upstream: bool,
    on_progress: Option<&Sender<SyncProgress>>,
    _credentials: Option<&PushCredentials>,
) -> Result<(), EgError> {
    // No --force: remote force pushes are disabled by policy.
    let mut args = vec!["push".to_string(), "--progress".to_string()];
    if set_upstream {
        args.push("-u".to_string());
    }
    args.push(remote.to_string());
    args.push(format!("{branch}:{branch}"));
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(target, &refs, on_progress, CLI_TIMEOUT_NETWORK)?;
    Ok(())
}

pub fn pull_fetch(
    target: &SshTarget,
    remote: &str,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<(), EgError> {
    fetch(target, remote, false, on_progress)
}

/// Post-fetch integration (mirrors `pull_integrate` ff-only/divergence math).
pub fn pull_integrate(
    repo_id: &str,
    target: &SshTarget,
    remote: &str,
    branch: &str,
    strategy: SyncStrategy,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<MergeOutcome, EgError> {
    let upstream_ref = format!("refs/remotes/{remote}/{branch}");
    let upstream_name = format!("{remote}/{branch}");
    let head = rev_parse(target, "HEAD").unwrap_or_default();
    let upstream_tip = rev_parse(target, &upstream_ref).unwrap_or_default();
    if head.is_empty() || upstream_tip.is_empty() {
        return Err(EgError::Internal {
            context: "HEAD 或上游引用不存在，无法整合".into(),
        });
    }
    let counts = run_git(
        target,
        &[
            "rev-list",
            "--count",
            "--left-right",
            &format!("{head}...{upstream_tip}"),
        ],
        None,
        CLI_TIMEOUT_QUICK,
    )
    .unwrap_or_default();
    let mut parts = counts.split_whitespace();
    let (ahead, behind): (u32, u32) = (
        parts.next().and_then(|n| n.parse().ok()).unwrap_or(0),
        parts.next().and_then(|n| n.parse().ok()).unwrap_or(0),
    );
    match strategy {
        SyncStrategy::FfOnly => {
            if ahead == 0 && behind == 0 {
                return Ok(MergeOutcome {
                    fast_forwarded: false,
                    conflicts: Vec::new(),
                    status: status(repo_id, target, None)?,
                });
            }
            if ahead > 0 && behind > 0 {
                return Err(EgError::ConflictState {
                    state: format!("本地与 {upstream_name} 出现分叉（ahead {ahead} / behind {behind}），请选择合并"),
                    detail: None,
                });
            }
            if ahead > 0 {
                return Ok(MergeOutcome {
                    fast_forwarded: false,
                    conflicts: Vec::new(),
                    status: status(repo_id, target, None)?,
                });
            }
            merge_start(repo_id, target, &upstream_name, false, on_progress)
        }
        SyncStrategy::Merge => merge_start(repo_id, target, &upstream_name, false, on_progress),
    }
}

// ---------------------------------------------------------------------------
// Timeline (reflog via CLI; safety ops unavailable remotely).
// ---------------------------------------------------------------------------

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

pub fn timeline(
    repo_id: &str,
    target: &SshTarget,
    limit: u32,
) -> Result<Vec<TimelineEntry>, EgError> {
    let _ = repo_id;
    let out = run_git(
        target,
        &[
            "reflog",
            "show",
            "HEAD",
            &format!("-n{limit}"),
            "--format=%H%x1f%gs%x1f%ct",
        ],
        None,
        CLI_TIMEOUT_QUICK,
    )
    .unwrap_or_default();
    let mut entries = Vec::new();
    for line in out.lines() {
        let mut f = line.splitn(3, '\x1f');
        let (Some(oid), Some(msg), Some(time)) = (f.next(), f.next(), f.next()) else {
            continue;
        };
        let (kind, danger) = classify_reflog(msg);
        entries.push(TimelineEntry {
            oid: Some(oid.to_string()),
            subject: if msg.is_empty() {
                format!(
                    "{} → {}",
                    &oid[..7.min(oid.len())],
                    &oid[..7.min(oid.len())]
                )
            } else {
                msg.to_string()
            },
            kind: kind.to_string(),
            danger,
            time: time.parse::<i64>().unwrap_or(0).max(0) as f64,
        });
    }
    Ok(entries)
}

pub fn undo_state() -> UndoRedoState {
    UndoRedoState {
        undoable_op_id: None,
        undoable_label: String::new(),
        redoable: false,
    }
}

// ---------------------------------------------------------------------------
// Unit tests: pure parsers (no SSH needed).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_parses_three_zones() {
        // XY entries joined by NUL: staged M, unstaged M, untracked, conflict,
        // plus one rename (`R  new\0old\0` — the old path rides as the next
        // NUL field with no XY prefix under -z).
        let sample = "M  src/a.rs\0 M src/b.rs\0?? new.txt\0UU both.rs\0R  new.rs\0old.rs\0";
        let fields: Vec<&str> = sample.split('\0').collect();
        let mut staged = 0;
        let mut unstaged = 0;
        let mut conflicted = 0;
        let mut renames = 0;
        let mut i = 0;
        while i < fields.len() {
            let entry = fields[i];
            i += 1;
            if entry.is_empty() {
                continue;
            }
            let bytes = entry.as_bytes();
            let (x, y) = (bytes[0] as char, bytes[1] as char);
            if x == 'R' || y == 'R' {
                renames += 1;
                i += 1; // consume the old-path NUL field
            }
            if x == 'U' || y == 'U' {
                conflicted += 1;
                continue;
            }
            if index_kind(x).is_some() {
                staged += 1;
            }
            if worktree_kind(y).is_some() {
                unstaged += 1;
            }
        }
        assert_eq!((staged, unstaged, conflicted, renames), (2, 2, 1, 1));
    }

    #[test]
    fn collapse_dirs_matches_git_vocabulary() {
        let mut unstaged = vec![
            ChangeEntry {
                path: "dir/a.txt".into(),
                old_path: None,
                kind: ChangeKind::Untracked,
            },
            ChangeEntry {
                path: "dir/b.txt".into(),
                old_path: None,
                kind: ChangeKind::Untracked,
            },
            ChangeEntry {
                path: "top.txt".into(),
                old_path: None,
                kind: ChangeKind::Untracked,
            },
            ChangeEntry {
                path: "mod.rs".into(),
                old_path: None,
                kind: ChangeKind::Modified,
            },
        ];
        collapse_untracked_dirs(&mut unstaged);
        let paths: Vec<&str> = unstaged.iter().map(|e| e.path.as_str()).collect();
        assert!(paths.contains(&"dir/"), "{paths:?}");
        assert!(paths.contains(&"top.txt"), "{paths:?}");
        assert!(paths.contains(&"mod.rs"), "{paths:?}");
        assert!(!paths.contains(&"dir/a.txt"), "{paths:?}");
    }

    #[test]
    fn patch_parser_rebuilds_hunks_and_word_spans() {
        let patch = "diff --git a/f.rs b/f.rs\n--- a/f.rs\n+++ b/f.rs\n@@ -1,2 +1,2 @@\n ctx\n-old line\n+new line\n";
        let (hunks, truncated, binary) = parse_patch(patch);
        assert!(!truncated && !binary);
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].lines.len(), 3);
        assert!(hunks[0].lines[1].word.is_some(), "word span expected");
        assert_eq!(hunks[0].lines[0].old_lineno, Some(1));
        assert_eq!(hunks[0].lines[2].new_lineno, Some(2));
    }

    #[test]
    fn lanes_match_local_geometry() {
        let mut lanes = Lanes::new();
        let (node, lines, count) = lanes.emit("a", &["b".to_string()]);
        assert_eq!((node.lane, node.merge, count), (0, false, 1));
        assert!(lines.iter().any(|l| l.from == 0 && l.to == 0));
        let (node2, _, _) = lanes.emit("b", &[]);
        assert_eq!(node2.lane, 0);
    }

    #[test]
    fn rename_expansion_handles_braces() {
        assert_eq!(
            expand_rename("src/{old.rs => new.rs}"),
            ("src/old.rs".to_string(), "src/new.rs".to_string())
        );
        assert_eq!(
            expand_rename("a.rs => b.rs"),
            ("a.rs".to_string(), "b.rs".to_string())
        );
    }

    #[test]
    fn conflict_markers_split_segments_and_blocks() {
        let content = "head\n<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> tip\ntail\n";
        let (segments, blocks) = parse_blocks(content);
        assert_eq!(segments.len(), 2);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].ours, vec!["mine"]);
        assert_eq!(blocks[0].theirs, vec!["theirs"]);
    }
}
