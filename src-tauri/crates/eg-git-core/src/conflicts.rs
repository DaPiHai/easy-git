//! Conflict inspection and resolution (m1-plan R-21): three-stage contents
//! from the index plus marker-parsed blocks of the worktree file, and the
//! resolve path that writes the chosen content back and stages the file.

use eg_types::{ConflictBlock, ConflictFile, EgError, StatusReport};

use crate::status;
use git2::Repository;

fn err(context: &'static str) -> impl Fn(git2::Error) -> EgError {
    move |e| EgError::Internal {
        context: format!("conflicts {context} failed: {e}"),
    }
}

fn blob_content(repo: &Repository, entry: &git2::IndexEntry) -> Option<String> {
    let blob = repo.find_blob(entry.id).ok()?;
    Some(String::from_utf8_lossy(blob.content()).to_string())
}

/// Splits the workdir file into resolved segments and conflict blocks so the
/// wizard can recompose the file after per-block decisions:
/// content = seg0 + block0 + seg1 + block1 … + segN.
fn parse_blocks(content: &str) -> (Vec<String>, Vec<ConflictBlock>) {
    let mut segments = Vec::new();
    let mut blocks = Vec::new();
    let mut current_segment = String::new();
    let mut state = "normal"; // normal | ours | theirs
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
            blocks.push(ConflictBlock {
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

fn looks_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(8000)].contains(&0)
}

/// All conflicted files with wizard payloads (m1-plan R-21).
pub fn conflicts_get(repo: &Repository, _repo_id: &str) -> Result<Vec<ConflictFile>, EgError> {
    let index = repo.index().map_err(err("index"))?;
    if !index.has_conflicts() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for conflict in index.conflicts().map_err(err("list"))? {
        let Ok(c) = conflict else { continue };
        let entry = c.our.as_ref().or(c.their.as_ref()).or(c.ancestor.as_ref());
        let Some(entry) = entry else { continue };
        let path = String::from_utf8_lossy(&entry.path).replace('\\', "/");
        if path.is_empty() {
            continue;
        }
        let base_content = c.ancestor.as_ref().and_then(|e| blob_content(repo, e));
        let ours_content = c.our.as_ref().and_then(|e| blob_content(repo, e));
        let theirs_content = c.their.as_ref().and_then(|e| blob_content(repo, e));

        // Prefer the on-disk workdir content for marker parsing (the user may
        // have edited it); fall back to ours.
        let workdir = repo.workdir().map(|w| w.join(&path));
        let disk = workdir.and_then(|p| std::fs::read(p).ok());
        let content = disk.unwrap_or_else(|| {
            ours_content
                .as_ref()
                .map(|s| s.clone().into_bytes())
                .unwrap_or_default()
        });
        let is_binary = looks_binary(&content);
        let (segments, blocks) = if is_binary {
            (Vec::new(), Vec::new())
        } else {
            parse_blocks(&String::from_utf8_lossy(&content))
        };

        files.push(ConflictFile {
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

/// Writes the resolved content and stages the file; once the index has no
/// unmerged entries left the merge commit can be created normally (R-21).
pub fn conflict_resolve(
    repo: &Repository,
    repo_id: &str,
    path: &str,
    content: &str,
) -> Result<StatusReport, EgError> {
    let workdir = repo.workdir().ok_or_else(|| EgError::Internal {
        context: "bare repository has no worktree".into(),
    })?;
    let file = workdir.join(path);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| EgError::Internal {
            context: format!("mkdir failed: {e}"),
        })?;
    }
    std::fs::write(&file, content).map_err(|e| EgError::Internal {
        context: format!("write resolved file failed: {e}"),
    })?;

    let mut index = repo.index().map_err(err("index"))?;
    index.conflict_remove(std::path::Path::new(path)).ok();
    index
        .add_path(std::path::Path::new(path))
        .map_err(err("add"))?;
    index.write().map_err(err("index write"))?;
    status::status(repo_id, repo)
}
