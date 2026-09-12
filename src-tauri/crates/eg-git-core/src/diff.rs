//! File diff (m1-plan R-12) and hunk/line-level staging (R-13).
//!
//! The diff payload feeds the DiffView directly: hunks, per-line numbers and
//! word-level spans for paired -/+ lines. Line staging regenerates a filtered
//! patch and applies it to the index via the git CLI (`git apply --cached`),
//! the exact behavior of `git add -p` — TDD §2 allows the CLI hybrid for
//! complex operations.

use eg_types::{
    ChangeKind, DiffHunk, DiffLine, DiffLineKind, DiffRequest, DiffResponse, DiffSourceKind,
    EgError, StageLinesRequest, StatusReport, WordSpan,
};
use git2::{Diff, DiffOptions, Repository};

/// Per-file cap on emitted diff lines; the UI folds beyond this.
pub const MAX_DIFF_LINES: usize = 5000;

fn err(context: &'static str) -> impl Fn(git2::Error) -> EgError {
    move |e| EgError::Internal {
        context: format!("diff {context} failed: {e}"),
    }
}

/// Builds the git2 diff for the request's source, narrowed to one path.
fn build_diff<'a>(
    repo: &'a Repository,
    req: &DiffRequest,
) -> Result<Option<(Diff<'a>, ChangeKind)>, EgError> {
    let mut opts = DiffOptions::new();
    opts.pathspec(&req.path);
    opts.include_untracked(true);
    opts.recurse_untracked_dirs(true);
    // Whole-file diffs for untracked entries (otherwise they print no hunks).
    opts.show_untracked_content(true);

    let diff = match req.source {
        DiffSourceKind::Worktree => {
            // NOTE: this libgit2 build ignores the index when old_tree is
            // None (observed: whole files come back as Added). Snapshot the
            // current index into a tree explicitly — semantics are identical
            // to `git diff` (index vs workdir).
            let mut index = repo.index().map_err(err("index"))?;
            index.write().map_err(err("index write"))?;
            let index_tree_id = index.write_tree().map_err(err("index tree"))?;
            let index_tree = repo.find_tree(index_tree_id).map_err(err("find tree"))?;
            repo.diff_tree_to_workdir(Some(&index_tree), Some(&mut opts))
                .map_err(err("worktree"))?
        }
        DiffSourceKind::Index => {
            let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
            repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
                .map_err(err("index"))?
        }
        DiffSourceKind::Commit => {
            let oid = req.commit_oid.as_deref().ok_or_else(|| EgError::Internal {
                context: "commit diff requires commit_oid".into(),
            })?;
            let oid = git2::Oid::from_str(oid).map_err(|e| EgError::Internal {
                context: format!("invalid commit id: {e}"),
            })?;
            let commit = repo.find_commit(oid).map_err(err("commit"))?;
            let commit_tree = commit.tree().map_err(err("tree"))?;
            let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
            repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), Some(&mut opts))
                .map_err(err("tree"))?
        }
    };

    // Renames match the changes-view vocabulary (and the caller's pathspec).
    let mut diff = diff;
    diff.find_similar(None).map_err(err("find"))?;

    let mut kind = ChangeKind::Modified;
    let mut found = false;
    for delta in diff.deltas() {
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().replace('\\', "/"));
        if path.as_deref() == Some(req.path.as_str()) {
            kind = match delta.status() {
                git2::Delta::Added => ChangeKind::Added,
                git2::Delta::Deleted => ChangeKind::Deleted,
                git2::Delta::Renamed | git2::Delta::Copied => ChangeKind::Renamed,
                _ => ChangeKind::Modified,
            };
            found = true;
            break;
        }
    }
    if !found {
        return Ok(None); // clean file (or raced away) — an empty diff
    }
    Ok(Some((diff, kind)))
}

fn strip_newline(bytes: &[u8]) -> String {
    let mut s = String::from_utf8_lossy(bytes).to_string();
    if s.ends_with('\n') {
        s.pop();
        if s.ends_with('\r') {
            s.pop();
        }
    }
    s
}

/// Common prefix/suffix byte lengths of two lines (word-level pairing).
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

/// "@@ -12,3 +12,5 @@ fn main" → (12, 12)
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

/// Word-level spans for single-line deleted→added pairs (R-12 词级高亮).
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

/// Parses the patch print into structured hunks with word-level spans.
/// The print callback must always return `true`: `false` aborts libgit2's
/// walk with a user-error instead of stopping gracefully.
#[allow(clippy::type_complexity)]
fn parse_hunks(diff: &Diff) -> Result<(Vec<DiffHunk>, bool, u32, u32, bool), EgError> {
    let mut hunks: Vec<DiffHunk> = Vec::new();
    let mut truncated = false;
    let mut binary = false;
    let mut current: Option<usize> = None;

    let print = |_delta: git2::DiffDelta<'_>,
                 _hunk: Option<git2::DiffHunk<'_>>,
                 line: git2::DiffLine<'_>|
     -> bool {
        match line.origin() {
            'B' => {
                binary = true;
            }
            'H' => {
                let header = strip_newline(line.content());
                let (old_start, new_start) = parse_hunk_header(&header);
                hunks.push(DiffHunk {
                    header,
                    old_start,
                    new_start,
                    lines: Vec::new(),
                });
                current = Some(hunks.len() - 1);
            }
            '+' | '-' | ' ' => {
                let Some(index) = current else { return true };
                if hunks[index].lines.len() >= MAX_DIFF_LINES {
                    truncated = true; // skip extra lines, keep the walk alive
                    return true;
                }
                let kind = match line.origin() {
                    '+' => DiffLineKind::Added,
                    '-' => DiffLineKind::Deleted,
                    _ => DiffLineKind::Context,
                };
                hunks[index].lines.push(DiffLine {
                    kind,
                    old_lineno: line.old_lineno(),
                    new_lineno: line.new_lineno(),
                    content: strip_newline(line.content()),
                    word: None,
                });
            }
            _ => {}
        }
        true
    };
    diff.print(git2::DiffFormat::Patch, print)
        .map_err(err("print"))?;

    mark_word_pairs(&mut hunks);
    let stats = diff.stats().map_err(err("stats"))?;
    Ok((
        hunks,
        truncated,
        stats.insertions() as u32,
        stats.deletions() as u32,
        binary,
    ))
}

/// One file's unified diff (m1-plan R-12 / F-18).
pub fn diff_file(
    repo: &Repository,
    repo_id: &str,
    req: &DiffRequest,
) -> Result<DiffResponse, EgError> {
    let Some((diff, kind)) = build_diff(repo, req)? else {
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
    };
    let flag_binary = diff
        .deltas()
        .any(|d| d.flags().contains(git2::DiffFlags::BINARY));

    let (hunks, truncated, added, deleted, print_binary) = if flag_binary {
        (Vec::new(), false, 0, 0, true)
    } else {
        parse_hunks(&diff)?
    };
    let binary = flag_binary || print_binary;

    Ok(DiffResponse {
        repo_id: repo_id.to_string(),
        path: req.path.clone(),
        old_path: req.old_path.clone(),
        kind,
        added,
        deleted,
        is_binary: binary,
        truncated,
        hunks,
    })
}

/// The verbatim file header block from the patch print ("diff --git…+++").
fn file_header(diff: &Diff) -> Result<String, EgError> {
    let mut header = String::new();
    let print = |_delta: git2::DiffDelta<'_>,
                 _hunk: Option<git2::DiffHunk<'_>>,
                 line: git2::DiffLine<'_>|
     -> bool {
        if header.is_empty() && line.origin() == 'F' {
            header.push_str(&String::from_utf8_lossy(line.content()));
        }
        true
    };
    diff.print(git2::DiffFormat::Patch, print)
        .map_err(err("print"))?;
    Ok(header)
}

/// Regenerates the patch limited to the selected hunks/lines (R-13). Whole
/// hunks pass through verbatim; partial selections get recomputed headers
/// (zero-count sides included) that `git apply --cached --unidiff-zero` takes.
fn rebuild_patch(diff: &Diff, req: &StageLinesRequest) -> Result<String, EgError> {
    // Unstaging applies the REVERSED index-diff to the index: the index is
    // the patch's old side, so +↔- swap and the header starts swap too.
    let reverse = req.source == DiffSourceKind::Index;
    let header = file_header(diff)?;

    // Collect hunk headers and their raw +/-/space rows, in print order.
    let mut hunks: Vec<(String, Vec<(char, String)>)> = Vec::new();
    let mut current: Option<usize> = None;
    let print = |_delta: git2::DiffDelta<'_>,
                 _hunk: Option<git2::DiffHunk<'_>>,
                 line: git2::DiffLine<'_>|
     -> bool {
        match line.origin() {
            'H' => {
                hunks.push((strip_newline(line.content()), Vec::new()));
                current = Some(hunks.len() - 1);
            }
            '+' | '-' | ' ' => {
                if let Some(index) = current {
                    hunks[index]
                        .1
                        .push((line.origin(), strip_newline(line.content())));
                }
            }
            _ => {}
        }
        true
    };
    diff.print(git2::DiffFormat::Patch, print)
        .map_err(err("print"))?;

    let mut out = header;
    for selected in &req.hunks {
        let Some((header_ref, raw_lines)) = hunks.get(selected.hunk_index as usize) else {
            return Err(EgError::Internal {
                context: format!("hunk {} out of range", selected.hunk_index),
            });
        };
        let mut original_header = header_ref.clone();
        let mut lines = raw_lines.clone();
        if reverse {
            for (origin, _) in lines.iter_mut() {
                *origin = match *origin {
                    '+' => '-',
                    '-' => '+',
                    c => c,
                };
            }
            let (old_s, new_s) = parse_hunk_header(&original_header);
            let old_count = lines.iter().filter(|(o, _)| *o != '+').count();
            let new_count = lines.iter().filter(|(o, _)| *o != '-').count();
            original_header = format!("@@ -{new_s},{old_count} +{old_s},{new_count} @@");
        }
        let selected_rows: Vec<usize> = selected
            .line_indexes
            .iter()
            .map(|i| *i as usize)
            .filter(|i| *i < lines.len())
            .collect();
        let change_selected = selected_rows.iter().filter(|i| lines[**i].0 != ' ').count();
        if change_selected == 0 {
            continue;
        }
        let change_total = lines.iter().filter(|(o, _)| *o != ' ').count();

        if change_selected == change_total {
            // Whole hunk: verbatim is always applyable.
            out.push_str(&original_header);
            out.push('\n');
            for (origin, content) in &lines {
                out.push(*origin);
                out.push_str(content);
                out.push('\n');
            }
            continue;
        }

        // Partial hunk: keep context + selected changes, recompute the header.
        let is_selected = |i: usize| selected_rows.contains(&i);
        let kept: Vec<(char, String)> = lines
            .iter()
            .enumerate()
            .filter(|(i, (o, _))| *o == ' ' || is_selected(*i))
            .map(|(_, (o, c))| (*o, c.clone()))
            .collect();
        let (mut old_count, mut new_count) = (0u32, 0u32);
        for (origin, _) in &kept {
            match origin {
                '-' => old_count += 1,
                '+' => new_count += 1,
                _ => {
                    old_count += 1;
                    new_count += 1;
                }
            }
        }

        // First kept row position decides the header start; the hunk header
        // numbers are 1-based, so base = start - 1.
        let (base_old, base_new) = {
            let (hs, ns) = parse_hunk_header(&original_header);
            (hs.saturating_sub(1), ns.saturating_sub(1))
        };
        let mut old_before = 0u32;
        let mut new_before = 0u32;
        let (mut old_start, mut new_start) = (0u32, 0u32);
        let mut found = false;
        for (i, (origin, _)) in lines.iter().enumerate() {
            if !found && (*origin == ' ' || is_selected(i)) {
                found = true;
                old_start = if *origin == '+' {
                    base_old + old_before
                } else {
                    base_old + old_before + 1
                };
                new_start = if *origin == '-' {
                    base_new + new_before
                } else {
                    base_new + new_before + 1
                };
            }
            match origin {
                '-' => old_before += 1,
                '+' => new_before += 1,
                _ => {
                    old_before += 1;
                    new_before += 1;
                }
            }
        }

        out.push_str(&format!(
            "@@ -{old_start},{old_count} +{new_start},{new_count} @@\n"
        ));
        for (origin, content) in &kept {
            out.push(*origin);
            out.push_str(content);
            out.push('\n');
        }
    }
    Ok(out)
}

/// Applies the filtered patch to the index via the git CLI (R-13).
fn apply_to_index(repo: &Repository, patch: &str) -> Result<(), EgError> {
    use std::io::Write;
    let workdir = repo.workdir().ok_or_else(|| EgError::Internal {
        context: "bare repository has no worktree".into(),
    })?;
    let mut child = crate::process::hidden_command("git")
        .arg("-C")
        .arg(workdir)
        .args(["apply", "--cached", "--unidiff-zero", "--recount", "-"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| crate::process::classify_spawn_error("git", &e))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(patch.as_bytes());
    }
    let output = child.wait_with_output().map_err(|e| EgError::Internal {
        context: format!("git apply wait failed: {e}"),
    })?;
    if !output.status.success() {
        return Err(EgError::Internal {
            context: format!(
                "git apply failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        });
    }
    Ok(())
}

/// Stages (source=worktree) or unstages (source=index) the selected hunks or
/// individual lines (m1-plan R-13 / F-19); returns the fresh status.
pub fn stage_lines(
    repo: &Repository,
    repo_id: &str,
    req: &StageLinesRequest,
) -> Result<StatusReport, EgError> {
    if req.hunks.is_empty() {
        return Err(EgError::Internal {
            context: "no hunks selected".into(),
        });
    }
    let diff_req = DiffRequest {
        path: req.path.clone(),
        old_path: None,
        source: req.source,
        commit_oid: None,
    };
    let Some((diff, _)) = build_diff(repo, &diff_req)? else {
        return Err(EgError::Internal {
            context: "没有可暂存的选中行".into(),
        });
    };
    let patch = rebuild_patch(&diff, req)?;
    if patch.ends_with(&file_header(&diff)?) {
        return Err(EgError::Internal {
            context: "没有可暂存的选中行".into(),
        });
    }
    apply_to_index(repo, &patch)?;
    crate::status::status(repo_id, repo)
}
