//! eg-git-core: the only place git logic lives (besides eg-safety).
//! Command implementations per TDD §4.2 start landing in W2 (R-01/R-02).
//! Every behavior must match real git and ship with assertion tests.

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
