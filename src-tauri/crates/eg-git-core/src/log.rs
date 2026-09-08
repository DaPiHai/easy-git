//! History DAG backend (m1-plan R-10): topo-sorted, lane-annotated log pages
//! plus commit details. The lane geometry is pre-computed here so the
//! frontend canvas only draws.

use std::collections::HashMap;

use eg_types::{
    ChangeKind, CommitDetail, CommitFile, CommitLogEntry, CommitRefs, EgError, GraphLine,
    GraphNode, LogFilter, LogPage,
};
use git2::{Oid, Repository, Sort};

/// Hard cap on scanned commits per page so author/message filters can always
/// terminate on huge histories (they may return fewer than `limit` rows).
const MAX_SCAN: u32 = 100_000;

/// Branch palette index cycling (UI doc §3.4); lane 0 (current branch trunk)
/// always keeps color 0.
struct Lanes {
    lanes: Vec<(Oid, u8)>,
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

    /// Processes one commit, mutating lane state for the rows below and
    /// returning the row's geometry.
    ///
    /// Line semantics for the renderer (between row top and row bottom):
    /// - `from == to`: straight vertical through the row;
    /// - `to == node.lane`, `from != node.lane`: joins into the node from
    ///   above (fork point where lanes coalesce);
    /// - `from == node.lane`, `to != node.lane`: merge line from the node
    ///   down to the parent's lane;
    /// - any other `from != to`: lane shifted left after termination, a
    ///   full-height diagonal.
    ///
    /// `node.lane` and every `from` live in the row's own (pre-compaction)
    /// lane space; `to` values point into the compacted space of the row
    /// below — except join lines, whose target is this row's node.
    fn emit(&mut self, oid: Oid, parents: &[Oid]) -> (GraphNode, Vec<GraphLine>, u32) {
        let above_len = self.lanes.len();
        let matches: Vec<usize> = (0..above_len).filter(|&i| self.lanes[i].0 == oid).collect();

        let node_lane;
        let node_color;
        if matches.is_empty() {
            // Branch tip: no child claimed a lane for it yet.
            node_color = if self.lanes.is_empty() {
                0 // current branch trunk (lane 0) is branch-1 (UI doc §3.4)
            } else {
                self.alloc_color()
            };
            self.lanes.push((oid, node_color));
            node_lane = self.lanes.len() - 1;
        } else {
            node_lane = matches[0];
            node_color = self.lanes[node_lane].1;
        }

        let mut lines: Vec<GraphLine> = Vec::new();
        // Lanes consumed by this row: duplicate-oid lanes coalesce into the
        // node lane (join); the node lane itself dies on a root commit.
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
            // First parent continues straight down the node lane.
            self.lanes[node_lane].0 = parents[0];
            lines.push(GraphLine {
                from: node_lane as u32,
                to: node_lane as u32,
                color: node_color,
            });
            // Extra parents branch off to the right (new lane) or join an
            // existing lane (usual merge case).
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
                        self.lanes.push((*p, color));
                        lines.push(GraphLine {
                            from: node_lane as u32,
                            to: (self.lanes.len() - 1) as u32,
                            color,
                        });
                    }
                }
            }
        }

        // Pass-through lines for every untouched lane; the compaction remap
        // below turns `to` into the shifted (post-removal) index, which yields
        // the full-height diagonals for lanes sliding left.
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

        // Compact: drop removed lanes, keeping order. `to` endpoints move into
        // the compacted space; `from` and the node stay in this row's space.
        let mut removed_sorted = removed.clone();
        removed_sorted.sort_unstable();
        removed_sorted.dedup();
        let mut new_index = vec![usize::MAX; self.lanes.len()];
        let mut kept: Vec<(Oid, u8)> = Vec::with_capacity(self.lanes.len());
        for (old, entry) in self.lanes.iter().enumerate() {
            if removed_sorted.contains(&old) {
                continue;
            }
            new_index[old] = kept.len();
            kept.push(*entry);
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

/// Short display refs for one commit, from the pre-built decoration map.
fn refs_for(map: &HashMap<Oid, CommitRefs>, oid: Oid) -> CommitRefs {
    map.get(&oid).cloned().unwrap_or(CommitRefs {
        branches: Vec::new(),
        remotes: Vec::new(),
        tags: Vec::new(),
    })
}

/// Builds oid → decorated refs (branches first with the current one leading).
fn build_ref_map(repo: &Repository) -> Result<(HashMap<Oid, CommitRefs>, Option<String>), EgError> {
    let mut map: HashMap<Oid, CommitRefs> = HashMap::new();

    let refs = repo.references().map_err(ref_err("list"))?;
    for reference in refs {
        let Ok(reference) = reference else { continue };
        let Ok(full) = reference.name() else { continue };
        let Ok(target) = reference.peel_to_commit() else {
            continue;
        };
        if let Some(branch) = full.strip_prefix("refs/heads/") {
            map.entry(target.id())
                .or_default()
                .branches
                .push(branch.to_string());
        } else if let Some(remote) = full.strip_prefix("refs/remotes/") {
            map.entry(target.id())
                .or_default()
                .remotes
                .push(remote.to_string());
        } else if let Some(tag) = full.strip_prefix("refs/tags/") {
            map.entry(target.id())
                .or_default()
                .tags
                .push(tag.to_string());
        }
    }

    // Current branch leads its commit's decoration list.
    let mut branch = None;
    if let Ok(head_ref) = repo.head() {
        if let Ok(name) = head_ref.name() {
            if let Some(short) = name.strip_prefix("refs/heads/") {
                branch = Some(short.to_string());
                if let Ok(head_commit) = head_ref.peel_to_commit() {
                    if let Some(refs) = map.get_mut(&head_commit.id()) {
                        if let Some(pos) = refs.branches.iter().position(|b| b == short) {
                            let b = refs.branches.remove(pos);
                            refs.branches.insert(0, b);
                        }
                    }
                }
            }
        }
    }
    Ok((map, branch))
}

fn ref_err(stage: &'static str) -> impl Fn(git2::Error) -> EgError {
    move |e| EgError::Internal {
        context: format!("refs {stage} failed: {e}"),
    }
}

fn walk_err(context: &'static str) -> impl Fn(git2::Error) -> EgError {
    move |e| EgError::Internal {
        context: format!("log {context} failed: {e}"),
    }
}

/// Splits a commit message into subject / body (body excludes the separator).
fn split_message(message: &str) -> (String, String) {
    let mut parts = message.splitn(2, "\n\n");
    let subject = parts.next().unwrap_or("").trim().to_string();
    let body = parts.next().unwrap_or("").trim_end().to_string();
    (subject, body)
}

/// One page of the annotated log. `offset` counts SCANNED commits so
/// filtered walks stay stable across page requests.
pub fn log_page(
    repo: &Repository,
    repo_id: &str,
    offset: u32,
    limit: u32,
    filter: &LogFilter,
) -> Result<LogPage, EgError> {
    let (ref_map, current_branch) = build_ref_map(repo)?;

    // Unborn HEAD without an explicit branch filter: empty page.
    let start_ref: Option<String> = match (&filter.branch, repo.head()) {
        (Some(b), _) => Some(format!("refs/heads/{b}")),
        (None, Ok(_)) => None, // push_head below
        (None, Err(_)) => {
            return Ok(LogPage {
                repo_id: repo_id.to_string(),
                entries: Vec::new(),
                next_offset: None,
                branch: None,
            })
        }
    };

    let mut walk = repo.revwalk().map_err(walk_err("init"))?;
    match &start_ref {
        Some(r) => {
            let tip = repo.refname_to_id(r).map_err(walk_err("resolve"))?;
            walk.push(tip).map_err(walk_err("push"))?;
        }
        None => walk.push_head().map_err(walk_err("push"))?,
    }
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
        .map_err(walk_err("sort"))?;

    let author_needle = filter.author.as_deref().map(str::to_lowercase);
    let message_needle = filter.message.as_deref().map(str::to_lowercase);
    let head_oid = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .map(|c| c.id());

    let mut lanes = Lanes::new();
    let mut entries = Vec::with_capacity(limit as usize);
    let mut scanned: u32 = 0;
    let mut skipped: u32 = 0;
    let mut exhausted = true;

    for item in walk {
        let oid = match item {
            Ok(o) => o,
            Err(_) => break,
        };
        if scanned >= MAX_SCAN {
            exhausted = false;
            break;
        }
        scanned += 1;

        let Ok(commit) = repo.find_commit(oid) else {
            continue;
        };

        if let Some(needle) = &author_needle {
            let name = commit.author().name().unwrap_or("").to_lowercase();
            if !name.contains(needle) {
                continue;
            }
        }
        if let Some(needle) = &message_needle {
            let msg = commit.message().unwrap_or("").to_lowercase();
            if !msg.contains(needle) {
                continue;
            }
        }

        let parents: Vec<Oid> = (0..commit.parent_count())
            .filter_map(|i| commit.parent_id(i).ok())
            .collect();

        if skipped < offset {
            skipped += 1;
            // Lane state must advance even for skipped rows.
            lanes.emit(oid, &parents);
            continue;
        }

        let (node, lines, lane_count) = lanes.emit(oid, &parents);
        let (subject, body) = split_message(commit.message().unwrap_or(""));
        let author = commit.author();
        entries.push(CommitLogEntry {
            oid: oid.to_string(),
            short_oid: oid.to_string()[..7].to_string(),
            subject,
            body,
            author_name: author.name().unwrap_or("").to_string(),
            author_email: author.email().unwrap_or("").to_string(),
            author_time: author.when().seconds() as f64,
            parent_count: commit.parent_count() as u32,
            is_head: head_oid == Some(oid),
            refs: refs_for(&ref_map, oid),
            node,
            lines,
            lane_count,
        });

        if entries.len() == limit as usize {
            exhausted = false;
            break;
        }
    }

    Ok(LogPage {
        repo_id: repo_id.to_string(),
        entries,
        next_offset: if exhausted { None } else { Some(scanned) },
        branch: current_branch,
    })
}

fn kind_from_delta(status: git2::Delta) -> Option<ChangeKind> {
    match status {
        git2::Delta::Added => Some(ChangeKind::Added),
        git2::Delta::Modified | git2::Delta::Typechange => Some(ChangeKind::Modified),
        git2::Delta::Deleted => Some(ChangeKind::Deleted),
        git2::Delta::Renamed | git2::Delta::Copied => Some(ChangeKind::Renamed),
        _ => None,
    }
}

/// Full detail of one commit for the detail panel (m1-plan F-16): metadata
/// plus the changed-file list with per-file line counts.
pub fn commit_detail(repo: &Repository, oid: &str) -> Result<CommitDetail, EgError> {
    let oid = Oid::from_str(oid).map_err(|e| EgError::Internal {
        context: format!("invalid commit id: {e}"),
    })?;
    let commit = repo.find_commit(oid).map_err(|e| EgError::Internal {
        context: format!("commit not found: {e}"),
    })?;

    let mut diff_opts = git2::DiffOptions::new();
    let commit_tree = commit.tree().ok();
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let mut diff = repo
        .diff_tree_to_tree(
            parent_tree.as_ref(),
            commit_tree.as_ref(),
            Some(&mut diff_opts),
        )
        .map_err(walk_err("diff"))?;
    // Detect renames so the file list matches the changes view vocabulary
    // (libgit2 defaults: renames on, 50% similarity).
    diff.find_similar(None).map_err(walk_err("find"))?;

    let mut files: Vec<CommitFile> = Vec::new();
    for delta in diff.deltas() {
        let Some(kind) = kind_from_delta(delta.status()) else {
            continue;
        };
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let old_path = if kind == ChangeKind::Renamed {
            delta
                .old_file()
                .path()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
        } else {
            None
        };
        files.push(CommitFile {
            path,
            old_path,
            kind,
            added: 0,
            deleted: 0,
        });
    }

    // Per-file line counts: DiffStats in git2 is aggregate-only, so count
    // patch lines per delta while printing.
    let mut counts: HashMap<String, (u32, u32)> = HashMap::new();
    let print = |delta: git2::DiffDelta<'_>,
                 _hunk: Option<git2::DiffHunk<'_>>,
                 line: git2::DiffLine<'_>|
     -> bool {
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let e = counts.entry(path).or_insert((0, 0));
        match line.origin() {
            '+' => e.0 += 1,
            '-' => e.1 += 1,
            _ => {}
        }
        true
    };
    diff.print(git2::DiffFormat::Patch, print)
        .map_err(walk_err("print"))?;
    for file in &mut files {
        if let Some((added, deleted)) = counts.get(&file.path) {
            file.added = *added;
            file.deleted = *deleted;
        }
    }

    let (subject, body) = split_message(commit.message().unwrap_or(""));
    let (ref_map, _) = build_ref_map(repo)?;
    let author = commit.author();
    Ok(CommitDetail {
        short_oid: oid.to_string()[..7].to_string(),
        oid: oid.to_string(),
        subject,
        body,
        author_name: author.name().unwrap_or("").to_string(),
        author_email: author.email().unwrap_or("").to_string(),
        author_time: author.when().seconds() as f64,
        refs: refs_for(&ref_map, oid),
        files,
    })
}

/// Short names of local branches, current branch first (F-17 branch filter
/// dropdown; the W7 board builds on this).
pub fn list_branches(repo: &Repository) -> Result<Vec<String>, EgError> {
    let mut branches = Vec::new();
    let refs = repo.references().map_err(ref_err("list"))?;
    for reference in refs {
        let Ok(reference) = reference else { continue };
        let Ok(full) = reference.name() else { continue };
        if let Some(short) = full.strip_prefix("refs/heads/") {
            branches.push(short.to_string());
        }
    }
    let current = repo
        .head()
        .ok()
        .and_then(|h| h.name().ok().map(str::to_string))
        .and_then(|n| n.strip_prefix("refs/heads/").map(str::to_string));
    if let Some(cur) = &current {
        if let Some(pos) = branches.iter().position(|b| b == cur) {
            let b = branches.remove(pos);
            branches.insert(0, b);
        }
    }
    branches.sort_by(|a, b| {
        let ac = Some(a) == current.as_ref();
        let bc = Some(b) == current.as_ref();
        bc.cmp(&ac).then_with(|| a.cmp(b))
    });
    Ok(branches)
}
