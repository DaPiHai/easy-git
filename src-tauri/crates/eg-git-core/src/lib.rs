//! eg-git-core: the only place git logic lives (besides eg-safety).
//! Every behavior must match real git and ship with assertion tests.

pub mod commit;
pub mod config;
pub mod diff;
pub mod log;
pub mod ops;
pub mod refs;
pub mod repo;
pub mod stash;
pub mod status;
pub mod worker;

pub use worker::{RepoManager, WorkerHandle};

#[cfg(test)]
mod tests {
    use git2::Repository;
    use tempfile::TempDir;

    /// Compile-level check that the libgit2 backend works and behaves like
    /// `git init`: a fresh repository has an unborn HEAD and a workdir.
    #[test]
    fn init_temp_repo_matches_git_init_semantics() {
        let dir = TempDir::new().expect("temp dir");
        let repo = Repository::init(dir.path()).expect("git init");

        assert!(repo.head().is_err(), "fresh repo must have an unborn HEAD");
        assert_eq!(
            repo.workdir().expect("workdir").canonicalize().unwrap(),
            dir.path().canonicalize().unwrap()
        );
    }
}
