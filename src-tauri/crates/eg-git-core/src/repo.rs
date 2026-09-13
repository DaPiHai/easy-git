//! Repository open/summarize helpers (m1-plan R-01).

use std::path::Path;
use std::sync::Mutex;

use eg_types::{paths::display_path, EgError, RepoSummary};

/// Serializes `safe.directory` writes so concurrent opens of different repos
/// cannot double-add the same entry.
static TRUST_LOCK: Mutex<()> = Mutex::new(());

/// Opens the repository containing `path`, searching upwards like real git.
pub fn open(path: &Path) -> Result<git2::Repository, EgError> {
    open_with(path, |p| git2::Repository::discover(p))
}

/// Opens exactly `path` (no upward search) — post-clone / known-root callers.
pub fn open_exact(path: &Path) -> Result<git2::Repository, EgError> {
    open_with(path, |p| git2::Repository::open(p))
}

/// Opens through `opener`, reconciling libgit2's owner validation with real
/// git.
///
/// libgit2 refuses folders owned by `BUILTIN\Administrators` when the process
/// runs as a non-elevated administrator (its owner check drops the
/// administrator-owner flag and `CheckTokenMembership` fails on the deny-only
/// group), while the git CLI opens the same folder fine. EasyGit runs most
/// operations through the CLI, so an open that the CLI accepts must not fail
/// here: trust the folder through `safe.directory` (the mechanism git itself
/// uses) and retry. When the CLI refuses too, the folder is genuinely
/// untrusted and gets its own error instead of a misleading "not a repo".
fn open_with(
    path: &Path,
    opener: impl Fn(&Path) -> Result<git2::Repository, git2::Error>,
) -> Result<git2::Repository, EgError> {
    match opener(path) {
        Ok(repo) => Ok(repo),
        Err(e) if e.code() == git2::ErrorCode::Owner => {
            // `path` may be a subdirectory of the repository, while libgit2
            // validates (and the trust entry must match) the repository root —
            // let the CLI name the folder to trust.
            let Some(root) = git_cli_trust_root(path) else {
                return Err(EgError::RepoOwnership {
                    path: display_path(path),
                    detail: Some(e.to_string()),
                });
            };
            trust_in_safe_directory(&root)?;
            match opener(path) {
                Ok(repo) => Ok(repo),
                Err(e) if e.code() == git2::ErrorCode::Owner => Err(EgError::RepoOwnership {
                    path: display_path(path),
                    detail: Some(e.to_string()),
                }),
                Err(e) => Err(not_found(path, &e)),
            }
        }
        Err(e) => Err(not_found(path, &e)),
    }
}

fn not_found(path: &Path, e: &git2::Error) -> EgError {
    EgError::RepoNotFound {
        path: display_path(path),
        detail: Some(e.to_string()),
    }
}

/// Asks the real git CLI whether it accepts the repository — its own
/// ownership rules included, which is exactly the judgement EasyGit aligns
/// with — and returns the folder to trust, already in the POSIX form libgit2
/// compares against: the worktree root for normal repositories, the git dir
/// for bare ones. `None` means git refuses the repository too.
fn git_cli_trust_root(path: &Path) -> Option<String> {
    git_rev_parse(path, "--show-toplevel").or_else(|| git_rev_parse(path, "--absolute-git-dir"))
}

fn git_rev_parse(path: &Path, what: &str) -> Option<String> {
    let output = crate::process::hidden_command("git")
        .arg("-C")
        .arg(path)
        .args(["rev-parse", what])
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        return None;
    }
    Some(safe_directory_value(Path::new(&value)))
}

/// The value libgit2 matches against its internal POSIX-style workdir path:
/// forward slashes, no trailing slash, no verbatim prefix.
fn safe_directory_value(path: &Path) -> String {
    let text = path.to_string_lossy();
    let stripped = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!("//{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text.into_owned()
    };
    stripped.replace('\\', "/")
}

/// Adds `value` (a normalized folder path from `git_cli_trust_root`) to the
/// global `safe.directory` list, idempotently. Written through the git CLI so
/// the entry lands in the same file git reads and the user can inspect or
/// remove it with plain `git config`.
fn trust_in_safe_directory(value: &str) -> Result<(), EgError> {
    let _guard = TRUST_LOCK.lock().expect("trust lock");
    if safe_directory_contains(value) {
        return Ok(());
    }
    let output = crate::process::hidden_command("git")
        .args(["config", "--global", "--add", "safe.directory"])
        .arg(value)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| EgError::Internal {
            context: format!("git config spawn failed: {e}"),
        })?;
    if !output.status.success() {
        return Err(EgError::Internal {
            context: format!(
                "git config --add safe.directory failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        });
    }
    tracing::info!(
        path = %value,
        "trusted folder in global safe.directory (libgit2 owner check vs git CLI)"
    );
    Ok(())
}

fn safe_directory_contains(value: &str) -> bool {
    let Ok(output) = crate::process::hidden_command("git")
        .args(["config", "--global", "--get-all", "safe.directory"])
        .stdin(std::process::Stdio::null())
        .output()
    else {
        return false;
    };
    contains_entry(&String::from_utf8_lossy(&output.stdout), value)
}

/// One `safe.directory` entry per line; exact match keeps the check in step
/// with libgit2's own comparison.
fn contains_entry(list: &str, value: &str) -> bool {
    list.lines().any(|line| line.trim() == value)
}

/// `git init` at `path`. Opening a directory that already is a repository is
/// idempotent (returns `Ok`), matching the wizard's expectation.
pub fn init(path: &Path) -> Result<(), EgError> {
    if path.join(".git").exists() {
        return Ok(());
    }
    git2::Repository::init(path)
        .map_err(|e| {
            if e.code() == git2::ErrorCode::Owner {
                // libgit2 validates ownership on the repository it opens after
                // creating it; a folder it refuses (git CLI would too) is not
                // an internal malfunction, so say what it actually is.
                EgError::RepoOwnership {
                    path: display_path(path),
                    detail: Some(e.to_string()),
                }
            } else {
                EgError::Internal {
                    context: format!("git init failed: {e}"),
                }
            }
        })
        .map(drop)
}

/// True when HEAD points at a nonexistent ref (fresh `git init`).
pub fn head_is_unborn(repo: &git2::Repository) -> bool {
    matches!(repo.head(), Err(e) if e.code() == git2::ErrorCode::UnbornBranch)
}

/// Short branch name; `None` for unborn or detached HEAD.
pub fn current_branch(repo: &git2::Repository) -> Option<String> {
    let head = repo.head().ok()?;
    if head.is_branch() {
        head.shorthand().ok().map(str::to_string)
    } else {
        None
    }
}

fn head_commit(repo: &git2::Repository) -> Option<git2::Commit<'_>> {
    repo.head().ok()?.peel_to_commit().ok()
}

/// Builds the switcher/wizard summary: branch, HEAD oid, ahead/behind vs the
/// configured upstream (zeros when there is none or HEAD is unborn).
pub fn summarize(
    repo_id: &str,
    repo: &git2::Repository,
    path: &Path,
) -> Result<RepoSummary, EgError> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string());

    let head_oid = head_commit(repo).map(|c| c.id().to_string());
    let is_empty = head_oid.is_none();

    let mut ahead = 0;
    let mut behind = 0;
    if let Ok(head) = repo.head() {
        let local = head.target();
        let upstream = git2::Branch::wrap(head)
            .upstream()
            .ok()
            .and_then(|b| b.get().target());
        if let (Some(local), Some(upstream)) = (local, upstream) {
            if let Ok((a, b)) = repo.graph_ahead_behind(local, upstream) {
                ahead = a as u32;
                behind = b as u32;
            }
        }
    }

    Ok(RepoSummary {
        repo_id: repo_id.to_string(),
        path: path.display().to_string(),
        name,
        branch: current_branch(repo),
        head_oid,
        ahead,
        behind,
        is_empty,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_directory_value_uses_posix_form_without_prefix() {
        assert_eq!(
            safe_directory_value(Path::new(r"\\?\C:\Users\a\repo")),
            "C:/Users/a/repo"
        );
        assert_eq!(
            safe_directory_value(Path::new(r"C:\Users\a\repo")),
            "C:/Users/a/repo"
        );
        assert_eq!(
            safe_directory_value(Path::new(r"\\?\UNC\srv\share\repo")),
            "//srv/share/repo"
        );
    }

    #[test]
    fn contains_entry_matches_whole_lines_only() {
        let list = "C:/a/b\nC:/a/bc\nD:/x\n";
        assert!(contains_entry(list, "C:/a/b"));
        assert!(contains_entry(list, "D:/x"));
        assert!(!contains_entry(list, "C:/a"), "prefix must not match");
        assert!(!contains_entry(list, "C:/a/bc/d"));
    }

    #[test]
    fn git_cli_trust_root_names_the_repo_and_none_for_a_plain_dir() {
        let repo_dir = tempfile::TempDir::new().unwrap();
        git2::Repository::init(repo_dir.path()).unwrap();
        let root = git_cli_trust_root(repo_dir.path()).expect("git accepts a real repository");
        assert!(
            !root.contains('\\'),
            "trust entry must use the POSIX form libgit2 compares: {root}"
        );
        assert!(Path::new(&root).is_dir(), "trusted path must exist: {root}");

        // A subdirectory resolves to the repository root, not itself.
        let sub = repo_dir.path().join("src");
        std::fs::create_dir_all(&sub).unwrap();
        assert_eq!(git_cli_trust_root(&sub).as_deref(), Some(root.as_str()));

        let plain_dir = tempfile::TempDir::new().unwrap();
        assert_eq!(git_cli_trust_root(plain_dir.path()), None);
    }
}
