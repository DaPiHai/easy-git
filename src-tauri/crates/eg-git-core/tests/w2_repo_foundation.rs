//! W2 behavior tests (m1-plan R-01/R-02/R-03): status must match real git
//! semantics; the worker lifecycle and fs-watch debounce must hold up.

use std::path::Path;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use eg_git_core::worker::RepoManager;
use eg_git_core::{repo, status};
use eg_types::ChangeKind;
use git2::{Repository, Signature};
use tempfile::TempDir;

fn init_repo() -> (TempDir, Repository) {
    let dir = TempDir::new().expect("temp dir");
    let repo = Repository::init(dir.path()).expect("git init");
    (dir, repo)
}

fn commit_file(repo: &Repository, path: &str, content: &str, msg: &str) -> git2::Oid {
    let workdir = repo.workdir().expect("workdir");
    let file = workdir.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).expect("mkdir");
    std::fs::write(&file, content).expect("write");

    let mut index = repo.index().expect("index");
    index.add_path(Path::new(path)).expect("add");
    index.write().expect("index write");
    let tree_id = index.write_tree().expect("tree");
    let tree = repo.find_tree(tree_id).expect("find tree");

    let sig = Signature::now("EasyGit Test", "test@easygit.invalid").expect("signature");
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
        .expect("commit")
}

fn status_of(repo_id: &str, repo: &Repository) -> eg_types::StatusReport {
    status::status(repo_id, repo).expect("status")
}

#[test]
fn clean_repo_has_empty_three_zones() {
    let (_dir, repo) = init_repo();
    commit_file(&repo, "a.txt", "one\n", "init");

    let report = status_of("r1", &repo);
    assert!(report.is_clean(), "expected clean, got {report:?}");
    assert_eq!(
        report.branch.as_deref(),
        repo::current_branch(&repo).as_deref()
    );
    assert!(report.head_oid.is_some());
}

#[test]
fn modified_file_lands_in_unstaged_then_staged() {
    let (_dir, repo) = init_repo();
    commit_file(&repo, "a.txt", "one\n", "init");

    // Unstaged modification.
    std::fs::write(repo.workdir().unwrap().join("a.txt"), "two\n").expect("write");
    let report = status_of("r1", &repo);
    assert!(report.staged.is_empty());
    assert_eq!(report.unstaged.len(), 1);
    assert_eq!(report.unstaged[0].path, "a.txt");
    assert_eq!(report.unstaged[0].kind, ChangeKind::Modified);

    // Staged: same file moves to the staged zone.
    let mut index = repo.index().expect("index");
    index.add_path(Path::new("a.txt")).expect("add");
    index.write().expect("index write");
    let report = status_of("r1", &repo);
    assert!(
        report.unstaged.is_empty(),
        "fully staged file leaves unstaged"
    );
    assert_eq!(report.staged.len(), 1);
    assert_eq!(report.staged[0].kind, ChangeKind::Modified);
}

#[test]
fn staged_new_file_is_added_and_untracked_file_is_separate() {
    let (_dir, repo) = init_repo();
    commit_file(&repo, "a.txt", "one\n", "init");

    std::fs::write(repo.workdir().unwrap().join("new.txt"), "n\n").expect("write");
    let mut index = repo.index().expect("index");
    index.add_path(Path::new("new.txt")).expect("add");
    index.write().expect("index write");

    let report = status_of("r1", &repo);
    assert_eq!(report.staged[0].kind, ChangeKind::Added);
    assert_eq!(report.staged[0].path, "new.txt");
    assert!(report.unstaged.is_empty());
}

#[test]
fn untracked_directory_is_collapsed_like_git() {
    let (_dir, repo) = init_repo();
    commit_file(&repo, "keep.txt", "k\n", "init");

    let sub = repo.workdir().unwrap().join("assets");
    std::fs::create_dir_all(&sub).expect("mkdir");
    std::fs::write(sub.join("a.png"), "x").expect("write");
    std::fs::write(sub.join("b.png"), "y").expect("write");

    let report = status_of("r1", &repo);
    assert_eq!(
        report.unstaged.len(),
        1,
        "whole untracked dir collapses to one entry"
    );
    assert_eq!(report.unstaged[0].path, "assets/");
    assert_eq!(report.unstaged[0].kind, ChangeKind::Untracked);
}

#[test]
fn staged_rename_is_detected_with_old_path() {
    let (_dir, repo) = init_repo();
    let content = "the quick brown fox\n".repeat(20);
    commit_file(&repo, "old-name.txt", &content, "init");

    // Rename on disk and stage both sides.
    let workdir = repo.workdir().unwrap();
    std::fs::rename(workdir.join("old-name.txt"), workdir.join("new-name.txt")).expect("rename");
    let mut index = repo.index().expect("index");
    index.remove_path(Path::new("old-name.txt")).expect("rm");
    index.add_path(Path::new("new-name.txt")).expect("add");
    index.write().expect("index write");

    let report = status_of("r1", &repo);
    assert_eq!(
        report.staged.len(),
        1,
        "rename collapses to one entry, got {report:?}"
    );
    assert_eq!(report.staged[0].kind, ChangeKind::Renamed);
    assert_eq!(report.staged[0].path, "new-name.txt");
    assert_eq!(report.staged[0].old_path.as_deref(), Some("old-name.txt"));
}

#[test]
fn merge_conflict_is_reported_in_conflicted_zone() {
    let (_dir, repo) = init_repo();
    commit_file(&repo, "f.txt", "base\n", "base");
    let base = repo.head().unwrap().peel_to_commit().unwrap();

    // "theirs": a commit on refs/heads/feature built without a checkout.
    let mut index = repo.index().unwrap();
    index.add_path(Path::new("f.txt")).unwrap();
    index.write().unwrap();
    let _ = index.write_tree(); // refresh bookkeeping; we build the tree manually below
    let blob = repo.blob(b"theirs\n").unwrap();
    let mut tree_builder = repo.treebuilder(None).unwrap();
    tree_builder.insert("f.txt", blob, 0o100644).unwrap();
    let theirs_tree = repo.find_tree(tree_builder.write().unwrap()).unwrap();
    let sig = Signature::now("EasyGit Test", "test@easygit.invalid").unwrap();
    let theirs = repo
        .commit(
            Some("refs/heads/feature"),
            &sig,
            &sig,
            "theirs",
            &theirs_tree,
            &[&base],
        )
        .unwrap();

    // "ours": normal commit on HEAD.
    commit_file(&repo, "f.txt", "ours\n", "ours");

    // Merge feature into HEAD -> conflict on f.txt.
    let theirs_annotated = repo.find_annotated_commit(theirs).unwrap();
    let mut merge_opts = git2::MergeOptions::new();
    repo.merge(&[&theirs_annotated], Some(&mut merge_opts), None)
        .expect("merge");

    let report = status_of("r1", &repo);
    assert_eq!(report.conflicted.len(), 1);
    assert_eq!(report.conflicted[0].path, "f.txt");
    assert_eq!(report.conflicted[0].kind, ChangeKind::Conflicted);
}

#[test]
fn worker_open_close_and_path_dedupe() {
    let manager = RepoManager::default();
    let (dir, repo) = init_repo();
    commit_file(&repo, "a.txt", "one\n", "init");
    drop(repo);

    let sink: eg_git_core::worker::ChangeSink = Arc::new(|_| {});
    let first = manager.open(dir.path(), sink.clone()).expect("open");
    assert!(!first.is_empty, "committed repo is not empty");
    assert_eq!(
        first.name,
        dir.path().file_name().unwrap().to_string_lossy()
    );

    // Re-opening the same canonical path focuses the existing worker.
    let second = manager.open(dir.path(), sink.clone()).expect("reopen");
    assert_eq!(first.repo_id, second.repo_id);

    let report = manager
        .get(&first.repo_id)
        .unwrap()
        .request_status()
        .unwrap();
    assert!(report.is_clean());

    manager.close(&first.repo_id);
    assert!(
        manager.get(&first.repo_id).is_err(),
        "closed worker is gone"
    );
    // Closing again is idempotent.
    manager.close(&first.repo_id);
}

#[test]
fn opening_non_repo_returns_repo_not_found() {
    let manager = RepoManager::default();
    let dir = TempDir::new().expect("temp dir");
    let sink: eg_git_core::worker::ChangeSink = Arc::new(|_| {});
    let err = manager.open(dir.path(), sink).expect_err("not a repo");
    assert_eq!(err.code(), "repo_not_found");
}

#[test]
fn fs_change_triggers_sink_after_debounce_within_one_second() {
    let manager = RepoManager::default();
    let (dir, repo) = init_repo();
    commit_file(&repo, "a.txt", "one\n", "init");
    drop(repo);

    let (tx, rx) = mpsc::channel::<String>();
    let sink: eg_git_core::worker::ChangeSink = Arc::new(move |repo_id| {
        let _ = tx.send(repo_id.to_string());
    });
    let opened = manager.open(dir.path(), sink).expect("open");

    let start = Instant::now();
    std::fs::write(dir.path().join("a.txt"), "changed\n").expect("write");

    let repo_id = rx
        .recv_timeout(Duration::from_secs(3))
        .expect("fs-watch event must arrive (debounce 300ms + inotify)");
    assert_eq!(repo_id, opened.repo_id);
    assert!(
        start.elapsed() < Duration::from_secs(1),
        "W2 exit criterion: change reflects within 1s, took {:?}",
        start.elapsed()
    );

    manager.close(&opened.repo_id);
}

/// W2 exit criterion: opening the 5000-commit mid-size fixture with the first
/// status must finish within 1.5s. Requires `scripts/fixtures/build-fixtures.sh
/// mid-size` beforehand; run explicitly via `cargo test -- --ignored`.
#[test]
#[ignore = "needs .fixtures-dev/mid-size; measures the W2 performance budget"]
fn mid_size_opens_within_one_and_a_half_seconds() {
    // Integration tests run with cwd = crates/eg-git-core.
    let path = std::path::Path::new("../../../.fixtures-dev/mid-size");
    if !path.exists() {
        panic!("run scripts/fixtures/build-fixtures.sh mid-size first");
    }

    let manager = RepoManager::default();
    let sink: eg_git_core::worker::ChangeSink = Arc::new(|_| {});

    let start = Instant::now();
    let summary = manager.open(path, sink).expect("open mid-size");
    let report = manager
        .get(&summary.repo_id)
        .unwrap()
        .request_status()
        .expect("status");
    let elapsed = start.elapsed();

    assert_eq!(summary.branch.as_deref(), Some("main"));
    assert!(report.is_clean(), "fixture worktree must be clean");
    assert!(
        elapsed < Duration::from_millis(1500),
        "mid-size (5000 commits) must open+status within 1.5s, took {elapsed:?}"
    );
    manager.close(&summary.repo_id);
}

/// 手动验证（默认忽略）：在 libgit2 所有权误报的 Windows 机器上（目录属于
/// `BUILTIN\Administrators`、进程为非提升管理员），本仓库路径会触发
/// `code=Owner`；修复后 `repo::open` 应通过 git CLI 对齐放行并成功打开。
/// 跑法：`cargo test -p eg-git-core --test w2_repo_foundation -- --ignored`。
#[test]
#[ignore = "环境相关：需要 libgit2 所有权误报的机器（Windows 管理员组拥有的目录）"]
fn owner_denied_repo_opens_via_git_alignment() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let repo = eg_git_core::repo::open(&root);
    assert!(repo.is_ok(), "repo::open failed: {:?}", repo.err());
}
