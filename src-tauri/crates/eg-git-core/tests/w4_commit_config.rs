//! W4 tests (m1-plan R-07/R-09): commit + amend from the index, partial
//! staging confirmation, identity resolution, config get/set.

use std::path::Path;
use std::sync::Mutex;

use eg_git_core::{commit, config};
use eg_types::{CommitRequest, ConfigScope};
use git2::Repository;
use tempfile::TempDir;

/// Tests touching process-global libgit2 config state (search paths, the
/// default/global config) must not run concurrently: sealing or repointing
/// search paths in one test breaks set/get in another. git2 state is
/// per-process, so an in-file lock serializes exactly those tests.
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

fn init_repo() -> (TempDir, Repository) {
    let dir = TempDir::new().expect("temp dir");
    let repo = Repository::init(dir.path()).expect("git init");
    (dir, repo)
}

fn set_identity(repo: &Repository) {
    let mut config = repo.config().unwrap();
    config.set_str("user.name", "Tester").unwrap();
    config
        .set_str("user.email", "tester@easygit.invalid")
        .unwrap();
}

fn write_and_stage(repo: &Repository, path: &str, content: &str) {
    let file = repo.workdir().unwrap().join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, content).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(path)).unwrap();
    index.write().unwrap();
}

fn request(subject: &str) -> CommitRequest {
    CommitRequest {
        subject: subject.into(),
        body: String::new(),
        amend: false,
        allow_partial: false,
    }
}

#[test]
fn commit_creates_head_from_index() {
    let (_dir, repo) = init_repo();
    set_identity(&repo);
    assert!(repo.head().is_err(), "fresh repo");

    write_and_stage(&repo, "a.txt", "one\n");
    let outcome = commit::commit(&repo, "r1", &request("first commit")).expect("commit");

    assert!(!outcome.amended);
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.id().to_string(), outcome.commit_id);
    assert_eq!(head.summary().unwrap(), Some("first commit"));
    assert_eq!(head.parent_count(), 0, "root commit");

    let blob = head.tree().unwrap().get_path(Path::new("a.txt")).unwrap();
    assert_eq!(repo.find_blob(blob.id()).unwrap().content(), b"one\n");

    // Fresh status must be clean and ahead of nothing (no upstream).
    assert!(outcome.status.is_clean());
    assert_eq!(
        outcome.summary.branch.as_deref(),
        repo.head().unwrap().shorthand().ok()
    );
}

#[test]
fn second_commit_gets_parent_and_identity() {
    let (_dir, repo) = init_repo();
    set_identity(&repo);
    write_and_stage(&repo, "a.txt", "one\n");
    commit::commit(&repo, "r1", &request("first")).unwrap();

    write_and_stage(&repo, "a.txt", "two\n");
    let second = commit::commit(&repo, "r1", &request("second")).expect("commit");
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 1);
    assert_eq!(head.author().email().unwrap(), "tester@easygit.invalid");
    assert_eq!(
        second.summary.branch.as_deref(),
        repo.head().unwrap().shorthand().ok()
    );
}

#[test]
fn amend_keeps_author_updates_message() {
    let (_dir, repo) = init_repo();
    set_identity(&repo);
    write_and_stage(&repo, "a.txt", "one\n");
    let first = commit::commit(&repo, "r1", &request("first")).unwrap();

    // Amend without changing the index.
    let req = CommitRequest {
        subject: "amended message".into(),
        body: "with body".into(),
        amend: true,
        allow_partial: false,
    };
    let outcome = commit::commit(&repo, "r1", &req).expect("amend");

    assert!(outcome.amended);
    let new_head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_ne!(
        new_head.id().to_string(),
        first.commit_id,
        "amend rewrites the commit"
    );
    assert_eq!(new_head.parent_count(), 0, "root commit stays root");
    assert_eq!(new_head.author().name().unwrap(), "Tester");
    assert_eq!(new_head.author().email().unwrap(), "tester@easygit.invalid");
    assert_eq!(new_head.summary().unwrap(), Some("amended message"));
    assert!(new_head.message().unwrap().contains("with body"));
    // The branch ref moved; HEAD is not detached.
    assert!(repo
        .head()
        .unwrap()
        .name()
        .unwrap()
        .starts_with("refs/heads/"));
}

#[test]
fn amend_non_root_keeps_parent_link() {
    let (_dir, repo) = init_repo();
    set_identity(&repo);
    write_and_stage(&repo, "a.txt", "one\n");
    commit::commit(&repo, "r1", &request("first")).unwrap();
    write_and_stage(&repo, "a.txt", "two\n");
    commit::commit(&repo, "r1", &request("second")).unwrap();

    let parent_before = repo
        .head()
        .unwrap()
        .peel_to_commit()
        .unwrap()
        .parent(0)
        .unwrap()
        .id();
    let req = CommitRequest {
        subject: "second amended".into(),
        body: String::new(),
        amend: true,
        allow_partial: false,
    };
    commit::commit(&repo, "r1", &req).expect("amend");

    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.summary().unwrap(), Some("second amended"));
    assert_eq!(head.parent_count(), 1);
    assert_eq!(head.parent(0).unwrap().id(), parent_before);
    assert!(repo
        .head()
        .unwrap()
        .name()
        .unwrap()
        .starts_with("refs/heads/"));
}

#[test]
fn partial_staging_requires_confirmation() {
    let (_dir, repo) = init_repo();
    set_identity(&repo);
    write_and_stage(&repo, "a.txt", "one\n");
    commit::commit(&repo, "r1", &request("init")).unwrap();

    // Staged change, then further unstaged edits on the same file.
    write_and_stage(&repo, "a.txt", "staged line\n");
    std::fs::write(
        repo.workdir().unwrap().join("a.txt"),
        "staged line\n+ dirty\n",
    )
    .unwrap();

    let err = commit::commit(&repo, "r1", &request("partial")).unwrap_err();
    assert_eq!(err.code(), "unsafe_operation");

    let req = CommitRequest {
        subject: "partial".into(),
        body: String::new(),
        amend: false,
        allow_partial: true,
    };
    commit::commit(&repo, "r1", &req).expect("confirmed partial commit");
    // Only the staged content landed.
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    let blob = head.tree().unwrap().get_path(Path::new("a.txt")).unwrap();
    assert_eq!(
        repo.find_blob(blob.id()).unwrap().content(),
        b"staged line\n"
    );
}

#[test]
fn missing_identity_is_a_clear_error() {
    let _guard = CONFIG_LOCK.lock().unwrap();
    // Hermetic: repoint libgit2's global/xdg/system config search paths at an
    // empty dir so the "no identity" precondition holds on any host. libgit2
    // reads env once at init, so GIT_CONFIG_GLOBAL env vars don't work here.
    let empty = std::env::temp_dir().join(format!("eg-empty-config-{}", std::process::id()));
    std::fs::create_dir_all(&empty).unwrap();
    let prev_global = unsafe { git2::opts::get_search_path(git2::ConfigLevel::Global) }.ok();
    let prev_xdg = unsafe { git2::opts::get_search_path(git2::ConfigLevel::XDG) }.ok();
    let prev_system = unsafe { git2::opts::get_search_path(git2::ConfigLevel::System) }.ok();
    unsafe {
        git2::opts::set_search_path(git2::ConfigLevel::Global, &empty).unwrap();
        git2::opts::set_search_path(git2::ConfigLevel::XDG, &empty).unwrap();
        git2::opts::set_search_path(git2::ConfigLevel::System, &empty).unwrap();
    }
    let (_dir, repo) = init_repo();
    write_and_stage(&repo, "a.txt", "one\n");
    let err = commit::commit(&repo, "r1", &request("no identity")).unwrap_err();
    assert_eq!(err.code(), "internal");
    assert!(format!("{err:?}").contains("user.name"));
    if let Some(p) = prev_global {
        unsafe {
            git2::opts::set_search_path(git2::ConfigLevel::Global, p.to_string_lossy().as_ref())
        }
        .ok();
    }
    if let Some(p) = prev_xdg {
        unsafe {
            git2::opts::set_search_path(git2::ConfigLevel::XDG, p.to_string_lossy().as_ref())
        }
        .ok();
    }
    if let Some(p) = prev_system {
        unsafe {
            git2::opts::set_search_path(git2::ConfigLevel::System, p.to_string_lossy().as_ref())
        }
        .ok();
    }
    let _ = std::fs::remove_dir_all(&empty);
}

#[test]
fn empty_subject_rejected() {
    let (_dir, repo) = init_repo();
    set_identity(&repo);
    write_and_stage(&repo, "a.txt", "one\n");
    let err = commit::commit(&repo, "r1", &request("   ")).unwrap_err();
    assert_eq!(err.code(), "internal");
}

#[test]
fn config_repo_and_global_roundtrip() {
    let _guard = CONFIG_LOCK.lock().unwrap();
    let (_dir, repo) = init_repo();

    config::config_set(Some(&repo), ConfigScope::Repo, "core.autocrlf", "input").unwrap();
    assert_eq!(
        config::config_get(Some(&repo), ConfigScope::Repo, "core.autocrlf").unwrap(),
        Some("input".into())
    );

    // Global config roundtrip (writes the real ~/.gitconfig in tests? git2
    // open_default honors GIT_CONFIG_GLOBAL; keep to a namespaced key).
    unsafe {
        std::env::set_var("GIT_CONFIG_GLOBAL", "/tmp/eg-test-gitconfig-w4");
    }
    config::config_set(Some(&repo), ConfigScope::Global, "easygit.testkey", "42").unwrap();
    assert_eq!(
        config::config_get(Some(&repo), ConfigScope::Global, "easygit.testkey").unwrap(),
        Some("42".into())
    );
    let _ = std::fs::remove_file("/tmp/eg-test-gitconfig-w4");

    // Missing keys read as None, not errors.
    assert_eq!(
        config::config_get(Some(&repo), ConfigScope::Repo, "no.such.key").unwrap(),
        None
    );
}

#[test]
fn config_global_roundtrip_without_open_repo() {
    let _guard = CONFIG_LOCK.lock().unwrap();
    // The settings page must write the commit identity with NO repository
    // open (rc.2 regression): the Global branch of config_get/config_set is
    // repo-free, `None` must be accepted end to end.
    unsafe {
        std::env::set_var("GIT_CONFIG_GLOBAL", "/tmp/eg-test-gitconfig-w4-norepo");
    }
    config::config_set(None, ConfigScope::Global, "easygit.testkey", "ok").unwrap();
    assert_eq!(
        config::config_get(None, ConfigScope::Global, "easygit.testkey").unwrap(),
        Some("ok".into())
    );
    let _ = std::fs::remove_file("/tmp/eg-test-gitconfig-w4-norepo");
}
