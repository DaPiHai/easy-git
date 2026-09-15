//! W9 tests (m1-plan R-22/R-24/R-25): remote CRUD, CLI sync round-trips
//! against a local bare origin (fetch/pull/push), force-push rollback,
//! undo/redo engine (引用快照树), timeline merge and upstream setting.

use std::path::Path;
use std::process::Command;

use eg_git_core::{merge, ops, refs, remote, timeline};
use eg_safety::Safety;
use eg_types::{ResetMode, SyncStrategy};
use git2::{Oid, Repository, Signature, Time};
use tempfile::TempDir;

fn init_repo() -> (TempDir, Repository) {
    let dir = TempDir::new().expect("temp dir");
    let repo = Repository::init(dir.path()).expect("git init");
    repo.set_head("refs/heads/main").unwrap();
    let mut config = repo.config().unwrap();
    // Pin LF (see w2_repo_foundation.rs): never inherit the machine's
    // `core.autocrlf`, or checkouts come back CRLF and byte-exact content
    // assertions fail on Windows only.
    config.set_bool("core.autocrlf", false).unwrap();
    config.set_str("user.name", "张三").unwrap();
    config.set_str("user.email", "z@ex.com").unwrap();
    (dir, repo)
}

fn commit_all(repo: &Repository, parents: &[&Oid], msg: &str, files: &[(&str, &str)]) -> Oid {
    for (path, content) in files {
        let file = repo.workdir().unwrap().join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, content).unwrap();
    }
    let mut index = repo.index().unwrap();
    index
        .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
        .unwrap();
    index.write().unwrap();
    let tree_id = index.write_tree().unwrap();
    let sig = Signature::new("张三", "z@ex.com", &Time::new(1, 0)).unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    let parent_commits: Vec<git2::Commit> = parents
        .iter()
        .map(|o| repo.find_commit(**o).unwrap())
        .collect();
    let parent_refs: Vec<&git2::Commit> = parent_commits.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parent_refs)
        .unwrap()
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("git run");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn git_out(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("git run");
    assert!(out.status.success(), "git {args:?} failed");
    String::from_utf8_lossy(&out.stdout).to_string()
}

/// bare origin + work repo with `origin` remote wired to it.
struct Fixture {
    _origin_dir: TempDir,
    _work_dir: TempDir,
    origin_path: std::path::PathBuf,
    work_path: std::path::PathBuf,
    safety: Safety,
}

fn fixture_with_origin() -> Fixture {
    let origin_dir = TempDir::new().unwrap();
    let origin_path = origin_dir.path().join("origin.git");
    Command::new("git")
        .args(["init", "-q", "--bare", "-b", "main"])
        .arg(&origin_path)
        .output()
        .expect("bare init");
    Command::new("git")
        .arg("-C")
        .arg(&origin_path)
        .args(["config", "user.name", "seed"])
        .output()
        .expect("config");
    let work_dir = TempDir::new().unwrap();
    let work_path = work_dir.path().join("work");
    Command::new("git")
        .args([
            "clone",
            "-q",
            origin_path.to_str().unwrap(),
            work_path.to_str().unwrap(),
        ])
        .output()
        .expect("clone");
    // Pin LF (see w2_repo_foundation.rs): this clone is made by the real git
    // CLI, so it inherits the machine's `core.autocrlf` — on Windows that turns
    // every later checkout (fetch/pull) into CRLF and breaks the byte-exact
    // content assertions below. `init_repo()` cannot help here; pin it inline.
    git(&work_path, &["config", "core.autocrlf", "false"]);
    // Empty clone warns but succeeds; make an initial commit and push it.
    git(&work_path, &["config", "user.name", "张三"]);
    git(&work_path, &["config", "user.email", "z@ex.com"]);
    std::fs::write(work_path.join("a.txt"), "1\n").unwrap();
    git(&work_path, &["add", "."]);
    git(&work_path, &["commit", "-q", "-m", "base"]);
    git(&work_path, &["push", "-q", "origin", "main"]);
    let safety_dir = TempDir::new().unwrap();
    let safety = Safety::for_tests(safety_dir.path());
    std::mem::forget(origin_dir);
    std::mem::forget(work_dir);
    std::mem::forget(safety_dir);
    Fixture {
        _origin_dir: TempDir::new().unwrap(),
        _work_dir: TempDir::new().unwrap(),
        origin_path,
        work_path,
        safety,
    }
}

#[test]
fn remote_crud_roundtrip() {
    let (_dir, repo) = init_repo();
    assert!(remote::remote_list(&repo).unwrap().is_empty());
    remote::remote_add(&repo, "origin", "/tmp/does-not-matter.git").unwrap();
    remote::remote_add(&repo, "upstream", "/tmp/other.git").unwrap();
    let list = remote::remote_list(&repo).unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].name, "origin");

    // Duplicate refused.
    assert!(remote::remote_add(&repo, "origin", "/tmp/x.git").is_err());

    let problems = remote::remote_rename(&repo, "upstream", "up").unwrap();
    assert!(problems.is_empty());
    remote::remote_set_url(&repo, "origin", "/tmp/new.git").unwrap();
    let list = remote::remote_list(&repo).unwrap();
    assert_eq!(
        list.iter().find(|r| r.name == "origin").unwrap().url,
        "/tmp/new.git"
    );

    remote::remote_remove(&repo, "up").unwrap();
    assert_eq!(remote::remote_list(&repo).unwrap().len(), 1);
}

#[test]
fn fetch_and_push_roundtrip_via_bare_origin() {
    let f = fixture_with_origin();
    let _repo = Repository::open(&f.work_path).unwrap();

    // Local pushes its own commit first.
    std::fs::write(f.work_path.join("c.txt"), "local\n").unwrap();
    git(&f.work_path, &["add", "."]);
    git(&f.work_path, &["commit", "-q", "-m", "local commit"]);
    remote::push_with_rollback(
        &f.work_path,
        "r1",
        "origin",
        "main",
        false,
        &f.safety,
        None,
        None,
    )
    .unwrap();
    let origin_main = git_out(&f.origin_path, &["log", "--format=%s", "-1", "main"]);
    assert!(origin_main.contains("local commit"));

    // A peer pushes on top; our fetch must see it.
    let mirror = TempDir::new().unwrap();
    Command::new("git")
        .args([
            "clone",
            "-q",
            f.origin_path.to_str().unwrap(),
            mirror.path().to_str().unwrap(),
        ])
        .output()
        .expect("clone mirror");
    git(mirror.path(), &["config", "user.name", "李四"]);
    git(mirror.path(), &["config", "user.email", "l@ex.com"]);
    std::fs::write(mirror.path().join("b.txt"), "from peer\n").unwrap();
    git(mirror.path(), &["add", "."]);
    git(mirror.path(), &["commit", "-q", "-m", "peer commit"]);
    git(mirror.path(), &["push", "-q", "origin", "main"]);

    remote::fetch_at(&f.work_path, "origin", true, None).unwrap();
    let fetched = Repository::open(&f.work_path).unwrap();
    let upstream = fetched
        .find_reference("refs/remotes/origin/main")
        .unwrap()
        .peel_to_commit()
        .unwrap();
    assert_eq!(upstream.summary().unwrap(), Some("peer commit"));
}

#[test]
fn pull_ff_and_divergence() {
    let f = fixture_with_origin();
    // origin moves forward; local has no new commits → ff-only works.
    let mirror = TempDir::new().unwrap();
    Command::new("git")
        .args([
            "clone",
            "-q",
            f.origin_path.to_str().unwrap(),
            mirror.path().to_str().unwrap(),
        ])
        .output()
        .expect("clone");
    git(mirror.path(), &["config", "user.name", "李四"]);
    git(mirror.path(), &["config", "user.email", "l@ex.com"]);
    std::fs::write(mirror.path().join("peer.txt"), "peer\n").unwrap();
    git(mirror.path(), &["add", "."]);
    git(mirror.path(), &["commit", "-q", "-m", "peer"]);
    git(mirror.path(), &["push", "-q", "origin", "main"]);

    let mut repo = Repository::open(&f.work_path).unwrap();
    remote::fetch_at(&f.work_path, "origin", false, None).unwrap();
    let outcome =
        remote::pull_integrate(&mut repo, "r1", "origin", "main", SyncStrategy::FfOnly).unwrap();
    assert!(outcome.fast_forwarded);
    assert_eq!(
        std::fs::read_to_string(f.work_path.join("peer.txt")).unwrap(),
        "peer\n"
    );

    // Now both sides move: ff-only must refuse with the 分叉 error.
    let mirror2 = TempDir::new().unwrap();
    Command::new("git")
        .args([
            "clone",
            "-q",
            f.origin_path.to_str().unwrap(),
            mirror2.path().to_str().unwrap(),
        ])
        .output()
        .expect("clone2");
    git(mirror2.path(), &["config", "user.name", "李四"]);
    git(mirror2.path(), &["config", "user.email", "l@ex.com"]);
    std::fs::write(mirror2.path().join("d.txt"), "peer2\n").unwrap();
    git(mirror2.path(), &["add", "."]);
    git(mirror2.path(), &["commit", "-q", "-m", "peer two"]);
    git(mirror2.path(), &["push", "-q", "origin", "main"]);

    std::fs::write(f.work_path.join("local2.txt"), "local2\n").unwrap();
    git(&f.work_path, &["add", "."]);
    git(&f.work_path, &["commit", "-q", "-m", "local two"]);
    remote::fetch_at(&f.work_path, "origin", false, None).unwrap();
    let err = remote::pull_integrate(&mut repo, "r1", "origin", "main", SyncStrategy::FfOnly)
        .unwrap_err();
    assert!(
        matches!(&err, eg_types::EgError::ConflictState { state, .. } if state.contains("分叉")),
        "expected divergence error, got {err:?}"
    );

    // Merge strategy integrates (clean here) with two parents.
    let outcome =
        remote::pull_integrate(&mut repo, "r1", "origin", "main", SyncStrategy::Merge).unwrap();
    assert!(!outcome.fast_forwarded);
    assert!(outcome.conflicts.is_empty());
    let repo2 = Repository::open(&f.work_path).unwrap();
    assert_eq!(
        repo2
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .parent_count(),
        2
    );
}

#[test]
fn force_push_records_rollback_anchor_and_undo_restores_remote() {
    let f = fixture_with_origin();
    // Force the local branch backwards: origin/main goes from base to base~? —
    // instead, move origin forward, then force-push an OLDER local tip over it.
    let mirror = TempDir::new().unwrap();
    Command::new("git")
        .args([
            "clone",
            "-q",
            f.origin_path.to_str().unwrap(),
            mirror.path().to_str().unwrap(),
        ])
        .output()
        .expect("clone");
    git(mirror.path(), &["config", "user.name", "李四"]);
    git(mirror.path(), &["config", "user.email", "l@ex.com"]);
    std::fs::write(mirror.path().join("peer.txt"), "peer\n").unwrap();
    git(mirror.path(), &["add", "."]);
    git(mirror.path(), &["commit", "-q", "-m", "peer"]);
    git(mirror.path(), &["push", "-q", "origin", "main"]);

    // Rewrite the local tip (模拟历史重写) so the force push is meaningful.
    // git2's Some("HEAD") rejects parents that are not the current tip, so
    // create the object directly and move the branch (W4 amend pattern).
    {
        let repo = Repository::open(&f.work_path).unwrap();
        let base = repo.head().unwrap().peel_to_commit().unwrap();
        let sig = Signature::new("张三", "z@ex.com", &Time::new(2, 0)).unwrap();
        let tree = base.tree().unwrap();
        let rewritten = repo
            .commit(None, &sig, &sig, "rewritten base", &tree, &[])
            .unwrap();
        repo.reference("refs/heads/main", rewritten, true, "rewrite tip")
            .unwrap();
    }

    remote::push_with_rollback(
        &f.work_path,
        "r1",
        "origin",
        "main",
        true,
        &f.safety,
        None,
        None,
    )
    .unwrap();
    let pushed = git_out(&f.origin_path, &["log", "--format=%s", "-1", "main"]);
    assert!(pushed.contains("rewritten base"));

    // The rollback anchor: latest op record carries the pre-force remote tip.
    let history = f.safety.history("r1");
    let record = history
        .iter()
        .find(|r| r.kind == eg_safety::OpKind::ForcePush)
        .unwrap();
    assert_eq!(record.paths[0], "main");
    let old_tip = Oid::from_str(&record.paths[1]).unwrap();
    let old_subject = {
        let repo = Repository::open(&f.work_path).unwrap();
        let commit = repo.find_commit(old_tip).unwrap();
        let subject = commit.summary().unwrap().unwrap().to_string();
        subject
    };
    assert_eq!(
        old_subject, "peer",
        "the anchor is the pre-force remote tip"
    );

    // Undo restores the remote to the pre-force tip.
    let mut repo = Repository::open(&f.work_path).unwrap();
    ops::undo_operation(&mut repo, "r1", &f.safety, &record.op_id).unwrap();
    let restored = git_out(&f.origin_path, &["log", "--format=%s", "-1", "main"]);
    assert!(
        restored.contains("peer"),
        "remote should be back at the peer tip"
    );
}

#[test]
fn undo_redo_discard_roundtrip() {
    let (dir, mut repo) = init_repo();
    let safety = Safety::for_tests(dir.path());
    let _base = commit_all(&repo, &[], "base", &[("a.txt", "1\n")]);

    // Discard a worktree change → undo restores it → redo discards again.
    std::fs::write(repo.workdir().unwrap().join("a.txt"), "2\n").unwrap();
    let op_id = ops::discard(&repo, "r1", &safety, &["a.txt".to_string()]).unwrap();
    assert_eq!(
        std::fs::read_to_string(repo.workdir().unwrap().join("a.txt")).unwrap(),
        "1\n"
    );

    ops::undo_operation(&mut repo, "r1", &safety, &op_id).unwrap();
    assert_eq!(
        std::fs::read_to_string(repo.workdir().unwrap().join("a.txt")).unwrap(),
        "2\n"
    );

    // Redo re-activates the SAME op (引用快照树: undo unwinds to the
    // original snapshot), so the id is reused.
    let redo_op_id = ops::redo_last(&mut repo, "r1", &safety).unwrap();
    assert_eq!(redo_op_id, op_id);
    assert_eq!(
        std::fs::read_to_string(repo.workdir().unwrap().join("a.txt")).unwrap(),
        "1\n"
    );

    // Redo without anything undone is a clear error.
    let err = ops::redo_last(&mut repo, "r1", &safety).unwrap_err();
    assert!(matches!(err, eg_types::EgError::NotSupported { .. }));
}

#[test]
fn undo_redo_reset_roundtrip() {
    let (dir, mut repo) = init_repo();
    let safety = Safety::for_tests(dir.path());
    let base = commit_all(&repo, &[], "base", &[("a.txt", "1\n")]);
    let c2 = commit_all(&repo, &[&base], "c2", &[("a.txt", "2\n")]);

    // Hard reset back to base, undo (files + branch return), redo re-resets.
    let outcome = merge::reset(
        &mut repo,
        "r1",
        ResetMode::Hard,
        Some(&base.to_string()),
        &safety,
    )
    .unwrap();
    let op_id = outcome.op_id.expect("snapshot op id");
    assert_eq!(
        std::fs::read_to_string(repo.workdir().unwrap().join("a.txt")).unwrap(),
        "1\n"
    );

    ops::undo_operation(&mut repo, "r1", &safety, &op_id).unwrap();
    assert_eq!(
        repo.head().unwrap().peel_to_commit().unwrap().id(),
        c2,
        "undo moves the branch back"
    );

    ops::redo_last(&mut repo, "r1", &safety).unwrap();
    assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id(), base);
    assert_eq!(
        std::fs::read_to_string(repo.workdir().unwrap().join("a.txt")).unwrap(),
        "1\n"
    );
}

#[test]
fn timeline_merges_reflog_and_op_log() {
    let (dir, mut repo) = init_repo();
    let safety = Safety::for_tests(dir.path());
    let base = commit_all(&repo, &[], "base", &[("a.txt", "1\n")]);
    let _c2 = commit_all(&repo, &[&base], "c2", &[("a.txt", "2\n")]);

    // An op row (hard reset) plus reflog rows (commits + reset) all appear.
    merge::reset(
        &mut repo,
        "r1",
        ResetMode::Hard,
        Some(&base.to_string()),
        &safety,
    )
    .unwrap();
    let entries = timeline::timeline(&repo, "r1", &safety, 50).unwrap();
    assert!(
        entries.iter().any(|e| e.kind == "reset"),
        "reset rows present: {:?}",
        entries
            .iter()
            .map(|e| (&e.kind, &e.subject))
            .collect::<Vec<_>>()
    );
    assert!(entries.iter().any(|e| e.kind == "commit"));
    // Newest first.
    for pair in entries.windows(2) {
        assert!(pair[0].time >= pair[1].time);
    }

    // 恢复到此状态: restore to the c2 oid via the timeline API.
    let c2_oid = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .map(|c| c.id());
    drop(repo);
    // Point the branch at base first so the restore actually moves it.
    let mut repo = Repository::open(dir.path()).unwrap();
    {
        let base_commit = repo.find_commit(base).unwrap();
        repo.reset(base_commit.as_object(), git2::ResetType::Hard, None)
            .unwrap();
    }
    let c2_hex = c2_oid.unwrap().to_string();
    let outcome = timeline::restore_to(&mut repo, "r1", &safety, &c2_hex).unwrap();
    assert!(outcome.op_id.is_some());
    assert_eq!(
        repo.head().unwrap().peel_to_commit().unwrap().id(),
        c2_oid.unwrap()
    );
}

#[test]
fn upstream_setting_roundtrip() {
    let f = fixture_with_origin();
    // Fetch so refs/remotes/origin/main exists, then wire the upstream.
    remote::fetch_at(&f.work_path, "origin", false, None).unwrap();
    let repo = Repository::open(&f.work_path).unwrap();
    refs::set_branch_upstream(&repo, "main", Some("origin/main")).unwrap();
    let info = refs::list_branches_info(&repo).unwrap();
    let main = info.iter().find(|b| b.name == "main").unwrap();
    assert_eq!(main.upstream.as_deref(), Some("origin/main"));

    refs::set_branch_upstream(&repo, "main", None).unwrap();
    let info = refs::list_branches_info(&repo).unwrap();
    let main = info.iter().find(|b| b.name == "main").unwrap();
    assert_eq!(main.upstream, None);

    // Remote branch listing for the dialog.
    let remote_branches = refs::list_remote_branches(&repo).unwrap();
    assert!(remote_branches.iter().any(|b| b == "origin/main"));
    assert!(!remote_branches.iter().any(|b| b.ends_with("/HEAD")));
}

#[test]
fn clone_creates_working_repo() {
    let f = fixture_with_origin();
    let target = TempDir::new().unwrap();
    let clone_path = target.path().join("cloned");
    remote::clone_repo(f.origin_path.to_str().unwrap(), &clone_path, None, None).unwrap();
    let cloned = Repository::open(&clone_path).unwrap();
    assert!(cloned.head().unwrap().peel_to_commit().is_ok());
    // Cloning into a non-empty directory is refused.
    let err =
        remote::clone_repo(f.origin_path.to_str().unwrap(), &f.work_path, None, None).unwrap_err();
    assert!(matches!(err, eg_types::EgError::Internal { .. }));
}
