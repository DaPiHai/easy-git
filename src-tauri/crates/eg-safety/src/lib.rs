//! eg-safety v0 (m1-plan W3, TDD §4.3): snapshot points for destructive
//! worktree operations (discard / clean) plus an append-only operation log
//! so every destructive action can be undone.
//!
//! Snapshot model: before the operation, the affected paths' current content
//! (worktree, falling back to the index for staged deletions) is committed to
//! `refs/easy-git/backup/<op_id>` with no parents. Undo force-checks the
//! paths back out of that tree. Ref-level backups, trash refs, the full
//! undo/redo stack and crash recovery land in W9.

use std::fs;
use std::path::{Path, PathBuf};

use eg_types::EgError;
use git2::build::CheckoutBuilder;
use git2::{Repository, Signature};
use serde::{Deserialize, Serialize};

pub const BACKUP_REF_PREFIX: &str = "refs/easy-git/backup";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpKind {
    Discard,
    Clean,
}

/// One append-only log line (`<root>/<repo-id>/operations.jsonl`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpRecord {
    pub op_id: String,
    /// Unix epoch seconds.
    pub time: u64,
    pub kind: OpKind,
    pub paths: Vec<String>,
    /// Backup ref holding the pre-operation content, if anything existed.
    pub snapshot_ref: Option<String>,
    /// Log is append-only: the latest record for an op_id wins, so undo
    /// appends a copy with `undone: true`.
    #[serde(default)]
    pub undone: bool,
}

#[derive(Debug, Clone)]
pub struct Safety {
    root: PathBuf,
}

fn sanitize(repo_id: &str) -> String {
    let cleaned = repo_id.replace(['/', '\\'], "_");
    if cleaned.contains("..") {
        cleaned.replace("..", "_")
    } else {
        cleaned
    }
}

impl Safety {
    pub fn new(app_data_dir: &Path) -> Self {
        Self {
            root: app_data_dir.join("safety"),
        }
    }

    /// Test/helper constructor rooted exactly at `root` (no `safety` join).
    #[doc(hidden)]
    pub fn for_tests(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
        }
    }

    fn log_path(&self, repo_id: &str) -> PathBuf {
        self.root.join(sanitize(repo_id)).join("operations.jsonl")
    }

    /// Appends one record; failures surface as `EgError::Internal` because a
    /// broken safety log must block destructive operations, not corrupt them.
    pub fn record(&self, repo_id: &str, record: &OpRecord) -> Result<(), EgError> {
        let path = self.log_path(repo_id);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(io_err("create safety dir"))?;
        }
        let mut line = serde_json::to_string(record).map_err(|e| EgError::Internal {
            context: format!("serialize op record failed: {e}"),
        })?;
        line.push('\n');
        use std::io::Write;
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .and_then(|mut f| f.write_all(line.as_bytes()))
            .map_err(io_err("append op record"))?;
        Ok(())
    }

    /// All records, deduplicated by op_id keeping the latest entry.
    pub fn history(&self, repo_id: &str) -> Vec<OpRecord> {
        let content = match fs::read_to_string(self.log_path(repo_id)) {
            Ok(c) => c,
            Err(_) => return Vec::new(),
        };
        let mut latest: Vec<OpRecord> = Vec::new();
        for line in content.lines() {
            let Ok(record) = serde_json::from_str::<OpRecord>(line) else {
                continue; // torn tail line from a crash: skip
            };
            if let Some(existing) = latest.iter_mut().find(|r| r.op_id == record.op_id) {
                *existing = record;
            } else {
                latest.push(record);
            }
        }
        latest
    }

    pub fn find(&self, repo_id: &str, op_id: &str) -> Option<OpRecord> {
        self.history(repo_id).into_iter().find(|r| r.op_id == op_id)
    }
}

fn io_err(stage: &'static str) -> impl Fn(std::io::Error) -> EgError {
    move |e| EgError::Internal {
        context: format!("{stage} failed: {e}"),
    }
}

/// Captures the current content of `paths` (worktree; index content for
/// missing files, i.e. staged deletions) into a parent-less backup commit.
/// Returns the backup ref name. Paths are repo-relative; a trailing slash
/// marks an untracked directory and is expanded recursively.
pub fn snapshot_worktree(
    repo: &Repository,
    op_id: &str,
    kind: OpKind,
    paths: &[String],
) -> Result<String, EgError> {
    let workdir = repo.workdir().ok_or_else(|| EgError::NotSupported {
        feature: "bare repository snapshots".into(),
    })?;

    // (repo-relative components, blob id, mode) triples from disk / index.
    let mut files: Vec<(PathBuf, git2::Oid, i32)> = Vec::new();
    for path in paths {
        let clean = path.trim_end_matches('/');
        let abs = workdir.join(clean);
        if abs.is_dir() {
            for file in collect_files(&abs) {
                let rel = file
                    .strip_prefix(workdir)
                    .expect("inside workdir")
                    .to_path_buf();
                let data = fs::read(&file).map_err(io_err("read snapshot file"))?;
                let oid = repo.blob(&data).map_err(|e| EgError::Internal {
                    context: format!("snapshot blob failed: {e}"),
                })?;
                files.push((rel, oid, file_mode(&file)));
            }
        } else if abs.is_file() {
            let data = fs::read(&abs).map_err(io_err("read snapshot file"))?;
            let oid = repo.blob(&data).map_err(|e| EgError::Internal {
                context: format!("snapshot blob failed: {e}"),
            })?;
            files.push((PathBuf::from(clean), oid, file_mode(&abs)));
        } else {
            // Missing on disk (staged deletion): fall back to index content.
            let fallback = index_fallback(repo, clean)?;
            if let Some((data, mode)) = fallback {
                let oid = repo.blob(&data).map_err(|e| EgError::Internal {
                    context: format!("snapshot blob failed: {e}"),
                })?;
                files.push((PathBuf::from(clean), oid, mode));
            }
        }
    }
    let tree_id = write_tree_recursive(repo, &group_by_dir(files))?;

    let tree = repo.find_tree(tree_id).map_err(|e| EgError::Internal {
        context: format!("snapshot find tree failed: {e}"),
    })?;
    let sig = Signature::now("EasyGit Safety", "safety@easygit.invalid").map_err(|e| {
        EgError::Internal {
            context: format!("snapshot signature failed: {e}"),
        }
    })?;
    let refname = format!("{BACKUP_REF_PREFIX}/{op_id}");
    let message = format!("EasyGit snapshot before {kind:?} ({:?})", paths);
    repo.commit(Some(&refname), &sig, &sig, &message, &tree, &[])
        .map_err(|e| EgError::Internal {
            context: format!("snapshot commit failed: {e}"),
        })?;
    Ok(refname)
}

/// Restores `paths` from a backup snapshot into the worktree (force). Paths
/// the snapshot does not contain are skipped — checkout with a pathspec that
/// misses the target tree would otherwise delete unrelated worktree files.
pub fn restore_snapshot(
    repo: &Repository,
    snapshot_ref: &str,
    paths: &[String],
) -> Result<(), EgError> {
    let reference = repo
        .find_reference(snapshot_ref)
        .map_err(|_| EgError::Internal {
            context: format!("snapshot ref missing: {snapshot_ref}"),
        })?;
    let tree = reference.peel_to_tree().map_err(|e| EgError::Internal {
        context: format!("snapshot peel failed: {e}"),
    })?;

    let mut builder = CheckoutBuilder::new();
    builder.force().update_index(false);
    let mut matched = 0;
    for path in paths {
        let clean = path.trim_end_matches('/');
        if tree.get_path(Path::new(clean)).is_ok() {
            builder.path(clean);
            matched += 1;
        }
    }
    if matched == 0 {
        return Ok(());
    }
    repo.checkout_tree(tree.as_object(), Some(&mut builder))
        .map_err(|e| EgError::Internal {
            context: format!("snapshot restore failed: {e}"),
        })?;
    Ok(())
}

fn collect_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                files.push(p);
            }
        }
    }
    files.sort();
    files
}

#[cfg(unix)]
fn file_mode(path: &Path) -> i32 {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(path)
        .map(|m| m.permissions().mode())
        .unwrap_or(0o644);
    if mode & 0o111 != 0 {
        0o100755
    } else {
        0o100644
    }
}

#[cfg(not(unix))]
fn file_mode(_path: &Path) -> i32 {
    0o100644
}

fn index_fallback(repo: &Repository, rel: &str) -> Result<Option<(Vec<u8>, i32)>, EgError> {
    let real_index = repo.index().map_err(|e| EgError::Internal {
        context: format!("index open failed: {e}"),
    })?;
    let Some(entry) = real_index.get_path(Path::new(rel), 0) else {
        return Ok(None); // nothing recorded anywhere; not recoverable anyway
    };
    let content = repo
        .find_blob(entry.id)
        .map(|b| b.content().to_vec())
        .map_err(|e| EgError::Internal {
            context: format!("snapshot index blob failed: {e}"),
        })?;
    Ok(Some((content, entry.mode as i32)))
}

/// Nested file list -> (directory node tree) grouping.
struct DirNode {
    files: Vec<(PathBuf, git2::Oid, i32)>,
    dirs: std::collections::BTreeMap<String, DirNode>,
}

fn group_by_dir(files: Vec<(PathBuf, git2::Oid, i32)>) -> DirNode {
    let mut root = DirNode {
        files: Vec::new(),
        dirs: std::collections::BTreeMap::new(),
    };
    for (path, oid, mode) in files {
        let mut node = &mut root;
        let mut components = path.components().peekable();
        while let Some(component) = components.next() {
            let name = component.as_os_str().to_string_lossy().to_string();
            if components.peek().is_none() {
                node.files.push((PathBuf::from(name), oid, mode));
            } else {
                node.dirs.entry(name.clone()).or_insert_with(|| DirNode {
                    files: Vec::new(),
                    dirs: std::collections::BTreeMap::new(),
                });
                node = node.dirs.get_mut(&name).expect("just inserted");
            }
        }
    }
    root
}

fn write_tree_recursive(repo: &Repository, node: &DirNode) -> Result<git2::Oid, EgError> {
    let mut builder = repo.treebuilder(None).map_err(|e| EgError::Internal {
        context: format!("snapshot treebuilder failed: {e}"),
    })?;
    for (name, oid, mode) in &node.files {
        builder
            .insert(name.to_string_lossy().as_ref(), *oid, *mode)
            .map_err(|e| EgError::Internal {
                context: format!("snapshot tree insert failed: {e}"),
            })?;
    }
    for (name, child) in &node.dirs {
        let child_oid = write_tree_recursive(repo, child)?;
        builder
            .insert(name, child_oid, 0o040000)
            .map_err(|e| EgError::Internal {
                context: format!("snapshot tree insert failed: {e}"),
            })?;
    }
    builder.write().map_err(|e| EgError::Internal {
        context: format!("snapshot tree write failed: {e}"),
    })
}
