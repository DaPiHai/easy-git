//! W3 tests (m1-plan R-05/R-06/F-10): staging, snapshot-guarded discard and
//! clean with undo round-trips (execute -> undo -> assert content restored),
//! and .gitignore generation.

use std::path::Path;

use eg_git_core::ops;
use eg_git_core::status::status;
use eg_safety::{OpKind, Safety};
use eg_types::{ChangeKind, StageMode};
use git2::{Repository, Signature};
use tempfile::TempDir;

fn init_repo() -> (TempDir, Repository) {
    let dir = TempDir::new().expect("temp dir");
    let repo = Repository::init(dir.path()).expect("git init");
    // Pin line endings locally: `Repository::init` inherits the developer's
    // global/system git config, so on a Windows box with `core.autocrlf=true`
    // every checkout rewrites LF as CRLF and the "undo restores the exact
    // content" assertions below compare "x\r\n" against "x\n". The product
    // behaviour is fine — it is the fixture that must not depend on the
    // machine it runs on (CI on Linux/macOS never sees this).
    repo.config()
        .expect("repo config")
        .set_bool("core.autocrlf", false)
        .expect("pin core.autocrlf=false for the test repo");
    (dir, repo)
}

fn commit_file(repo: &Repository, path: &str, content: &str, msg: &str) {
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
        .expect("commit");
}

fn paths(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| (*s).to_string()).collect()
}

fn safety() -> (TempDir, Safety) {
    let dir = TempDir::new().expect("temp dir");
    let engine = Safety::for_tests(dir.path());
    (dir, engine)
}

#[test]
fn stage_and_unstage_whole_file() {
    let (_dir, repo) = init_repo();
    commit_file(&repo, "a.txt", "one\n", "init");
    std::fs::write(repo.workdir().unwrap().join("a.txt"), "two\n").unwrap();
    std::fs::write(repo.workdir().unwrap().join("new.txt"), "n\n").unwrap();

    ops::stage(&repo, &paths(&["a.txt", "new.txt"]), StageMode::Stage).expect("stage");
    let report = status("r", &repo).unwrap();
    assert_eq!(report.staged.len(), 2);
    assert!(report.unstaged.is_empty());

    ops::stage(&repo, &paths(&["new.txt"]), StageMode::Unstage).expect("unstage");
    let report = status("r", &repo).unwrap();
    // new.txt is back to untracked; a.txt stays staged.
    assert_eq!(report.staged.len(), 1);
    assert_eq!(report.unstaged[0].path, "new.txt");
    assert_eq!(report.unstaged[0].kind, ChangeKind::Untracked);
}

#[test]
fn unstage_staged_new_file_with_unborn_head() {
    let (_dir, repo) = init_repo();
    std::fs::write(repo.workdir().unwrap().join("x.txt"), "x\n").unwrap();
    ops::stage(&repo, &paths(&["x.txt"]), StageMode::Stage).expect("stage");
    ops::stage(&repo, &paths(&["x.txt"]), StageMode::Unstage).expect("unstage");
    let report = status("r", &repo).unwrap();
    assert!(report.staged.is_empty());
    assert_eq!(report.unstaged[0].kind, ChangeKind::Untracked);
}

#[test]
fn discard_modified_file_then_undo_restores_exact_content() {
    let (_dir, mut repo) = init_repo();
    let (_safety_dir, safety) = safety();
    commit_file(&repo, "a.txt", "original\n", "init");

    std::fs::write(repo.workdir().unwrap().join("a.txt"), "messy edits\n").unwrap();
    let op_id = ops::discard(&repo, "r1", &safety, &paths(&["a.txt"])).expect("discard");

    let content = std::fs::read_to_string(repo.workdir().unwrap().join("a.txt")).unwrap();
    assert_eq!(content, "original\n", "discard restores HEAD content");
    assert!(status("r1", &repo).unwrap().is_clean());

    // Undo: the pre-discard content must come back.
    ops::undo_operation(&mut repo, "r1", &safety, &op_id).expect("undo");
    let content = std::fs::read_to_string(repo.workdir().unwrap().join("a.txt")).unwrap();
    assert_eq!(content, "messy edits\n", "undo restores the discarded edit");

    let record = safety.find("r1", &op_id).unwrap();
    assert!(record.undone);
    assert_eq!(record.kind, OpKind::Discard);
}

#[test]
fn discard_staged_deletion_and_undo_restores_file() {
    let (_dir, mut repo) = init_repo();
    let (_safety_dir, safety) = safety();
    commit_file(&repo, "doomed.txt", "precious\n", "init");

    // Delete + stage the deletion.
    std::fs::remove_file(repo.workdir().unwrap().join("doomed.txt")).unwrap();
    ops::stage(&repo, &paths(&["doomed.txt"]), StageMode::Stage).unwrap();

    let op_id = ops::discard(&repo, "r1", &safety, &paths(&["doomed.txt"])).expect("discard");
    // Discarding a staged deletion cancels the deletion: the file is restored
    // at HEAD content (no data was ever lost, so the snapshot has no entry).
    let content = std::fs::read_to_string(repo.workdir().unwrap().join("doomed.txt"))
        .expect("discard of staged deletion restores the file");
    assert_eq!(content, "precious\n");
    assert!(status("r1", &repo).unwrap().is_clean());

    ops::undo_operation(&mut repo, "r1", &safety, &op_id).expect("undo is a safe no-op");
    assert!(repo.workdir().unwrap().join("doomed.txt").exists());
}

#[test]
fn discard_untracked_directory_and_undo_restores_files() {
    let (_dir, mut repo) = init_repo();
    let (_safety_dir, safety) = safety();
    commit_file(&repo, "keep.txt", "k\n", "init");

    let assets = repo.workdir().unwrap().join("assets");
    std::fs::create_dir_all(assets.join("nested")).unwrap();
    std::fs::write(assets.join("a.png"), "A").unwrap();
    std::fs::write(assets.join("nested/b.png"), "B").unwrap();

    let op_id = ops::discard(&repo, "r1", &safety, &paths(&["assets/"])).expect("discard");
    assert!(!assets.exists(), "untracked dir removed by discard");

    ops::undo_operation(&mut repo, "r1", &safety, &op_id).expect("undo");
    assert_eq!(
        std::fs::read_to_string(assets.join("a.png")).unwrap(),
        "A",
        "undo restores untracked dir content"
    );
    assert_eq!(
        std::fs::read_to_string(assets.join("nested/b.png")).unwrap(),
        "B",
        "nested files restored"
    );
}

#[test]
fn clean_only_untracked_and_undo_restores() {
    let (_dir, mut repo) = init_repo();
    let (_safety_dir, safety) = safety();
    commit_file(&repo, "a.txt", "one\n", "init");
    std::fs::write(repo.workdir().unwrap().join("junk.log"), "junk\n").unwrap();

    // Refuses tracked files.
    let err = ops::clean(&repo, "r1", &safety, &paths(&["a.txt"])).unwrap_err();
    assert_eq!(err.code(), "unsafe_operation");

    let op_id = ops::clean(&repo, "r1", &safety, &paths(&["junk.log"])).expect("clean");
    assert!(!repo.workdir().unwrap().join("junk.log").exists());

    ops::undo_operation(&mut repo, "r1", &safety, &op_id).expect("undo");
    assert_eq!(
        std::fs::read_to_string(repo.workdir().unwrap().join("junk.log")).unwrap(),
        "junk\n"
    );
}

#[test]
fn double_undo_is_rejected() {
    let (_dir, mut repo) = init_repo();
    let (_safety_dir, safety) = safety();
    commit_file(&repo, "a.txt", "one\n", "init");
    std::fs::write(repo.workdir().unwrap().join("a.txt"), "two\n").unwrap();

    let op_id = ops::discard(&repo, "r1", &safety, &paths(&["a.txt"])).expect("discard");
    ops::undo_operation(&mut repo, "r1", &safety, &op_id).expect("first undo");
    let err = ops::undo_operation(&mut repo, "r1", &safety, &op_id).unwrap_err();
    assert_eq!(err.code(), "not_supported");
}

#[test]
fn ignore_writes_rules_and_filters_status() {
    let (_dir, repo) = init_repo();
    commit_file(&repo, "a.txt", "one\n", "init");
    std::fs::write(repo.workdir().unwrap().join("debug.log"), "d\n").unwrap();
    std::fs::write(repo.workdir().unwrap().join("app.log"), "a\n").unwrap();

    let added = ops::ignore(&repo, &paths(&["debug.log"]), eg_types::IgnoreMode::ByPath).unwrap();
    assert_eq!(added, vec!["/debug.log"]);
    // By-extension for the remaining file dedupes to one rule.
    let added = ops::ignore(
        &repo,
        &paths(&["app.log"]),
        eg_types::IgnoreMode::ByExtension,
    )
    .unwrap();
    assert_eq!(added, vec!["*.log"]);

    let gitignore = std::fs::read_to_string(repo.workdir().unwrap().join(".gitignore")).unwrap();
    assert!(gitignore.contains("/debug.log"));
    assert!(gitignore.contains("*.log"));

    // Ignored files disappear from status (only .gitignore itself remains).
    let report = status("r", &repo).unwrap();
    assert_eq!(report.unstaged.len(), 1, "got {report:?}");
    assert_eq!(report.unstaged[0].path, ".gitignore");
}

#[test]
fn gitignore_template_missing_and_write_semantics() {
    let (_dir, repo) = init_repo();

    // Fresh repo without .gitignore: missing=true, write creates the template.
    assert!(ops::gitignore_missing(&repo).unwrap());
    assert!(ops::write_default_gitignore(&repo).unwrap());
    let content = std::fs::read_to_string(repo.workdir().unwrap().join(".gitignore")).unwrap();
    assert!(content.contains("node_modules/"), "template marker");
    assert!(content.contains(".DS_Store"), "template marker");
    assert!(content.contains(".env"), "template marker");

    // An existing .gitignore is never touched: missing=false, write is a no-op.
    std::fs::write(repo.workdir().unwrap().join(".gitignore"), "custom\n").unwrap();
    assert!(!ops::gitignore_missing(&repo).unwrap());
    assert!(!ops::write_default_gitignore(&repo).unwrap());
    let content = std::fs::read_to_string(repo.workdir().unwrap().join(".gitignore")).unwrap();
    assert_eq!(
        content, "custom\n",
        "existing .gitignore must stay untouched"
    );
}
