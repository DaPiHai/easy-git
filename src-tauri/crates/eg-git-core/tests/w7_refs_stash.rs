//! W7 tests (m1-plan R-15/R-16/R-17/R-18): branch CRUD + recycle bin, safe
//! switch, tags and stash round-trips.

use std::path::Path;

use eg_git_core::{ops, refs, stash};
use eg_safety::Safety;
use eg_types::EgError;
use git2::{Oid, Repository, Signature, Time};
use tempfile::TempDir;

fn init_repo() -> (TempDir, Repository) {
    let dir = TempDir::new().expect("temp dir");
    let repo = Repository::init(dir.path()).expect("git init");
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

fn head_branch(repo: &Repository) -> String {
    let reference = repo.head().unwrap();
    reference
        .name()
        .unwrap()
        .strip_prefix("refs/heads/")
        .unwrap()
        .to_string()
}

#[test]
fn branch_crud_and_recycle_bin() {
    let dir = TempDir::new().unwrap();
    let safety = Safety::for_tests(dir.path());
    let (_repo_dir, mut repo) = init_repo();
    let base = commit_all(&repo, &[], "base", &[("a.txt", "1\n")]);

    // Create at HEAD and at an explicit commit.
    let feature = refs::create_branch(&repo, "feature/x", None).unwrap();
    assert!(!feature.is_current);
    refs::create_branch(&repo, "at-base", Some(&base.to_string())).unwrap();

    let list = refs::list_branches_info(&repo).unwrap();
    assert!(list[0].is_current, "current branch sorts first");
    let names: Vec<&str> = list.iter().map(|b| b.name.as_str()).collect();
    assert!(names.contains(&"feature/x"));
    assert!(names.contains(&"at-base"));

    // Duplicate creation fails with a friendly message.
    match refs::create_branch(&repo, "feature/x", None) {
        Err(EgError::Internal { context }) => assert!(context.contains("已存在")),
        other => panic!("wrong error: {other:?}"),
    }

    // Rename keeps tip and (for the current branch) moves HEAD.
    let head_before = repo.head().unwrap().peel_to_commit().unwrap().id();
    refs::rename_branch(&repo, &head_branch(&repo), "renamed").unwrap();
    assert_eq!(head_branch(&repo), "renamed");
    assert_eq!(
        repo.head().unwrap().peel_to_commit().unwrap().id(),
        head_before
    );

    // Deleting the current branch is refused.
    let err = refs::delete_branch(&repo, "r1", &safety, "renamed").unwrap_err();
    assert!(matches!(err, EgError::Internal { .. }));

    // Deleting another branch parks the tip in the recycle bin and the 撤销
    // toast restores it under the same name.
    refs::switch_branch(&repo, "r1", "renamed").unwrap(); // leave feature/x
    refs::switch_branch(&repo, "r1", "feature/x").unwrap(); // current = feature
    let trash_count = |repo: &Repository| {
        repo.references_glob("refs/easy-git/trash/*")
            .unwrap()
            .count()
    };
    assert!(refs::delete_branch(&repo, "r1", &safety, "renamed").is_ok());
    assert!(repo
        .find_branch("renamed", git2::BranchType::Local)
        .is_err());
    assert_eq!(trash_count(&repo), 1, "delete parks one trash ref");
    let op_id = refs::delete_branch(&repo, "r1", &safety, "at-base").unwrap();
    assert_eq!(trash_count(&repo), 2, "both deletes parked a trash ref");
    ops::undo_operation(&mut repo, "r1", &safety, &op_id).unwrap();
    let restored = repo
        .find_branch("at-base", git2::BranchType::Local)
        .unwrap();
    assert_eq!(restored.get().peel_to_commit().unwrap().id(), base);
    // The restored op's trash ref is cleaned up; the undone-free one stays.
    assert_eq!(trash_count(&repo), 1, "restored op's trash ref removed");
}

#[test]
fn switch_rejects_dirty_worktree_but_allows_untracked() {
    let (_dir, repo) = init_repo();
    commit_all(&repo, &[], "base", &[("a.txt", "1\n")]);
    refs::create_branch(&repo, "other", None).unwrap();

    // Untracked file that the target branch does not contain: allowed.
    std::fs::write(repo.workdir().unwrap().join("scratch.txt"), "note\n").unwrap();
    refs::switch_branch(&repo, "r1", "other").unwrap();
    assert_eq!(head_branch(&repo), "other");

    // Tracked modification: refused with the file named.
    std::fs::write(repo.workdir().unwrap().join("a.txt"), "modified\n").unwrap();
    let err = refs::switch_branch(&repo, "r1", "master").unwrap_err();
    match err {
        EgError::DirtyWorktree { paths } => assert_eq!(paths, vec!["a.txt"]),
        other => panic!("wrong error: {other:?}"),
    }

    // Untracked file that WOULD be overwritten by the target: refused too.
    std::fs::write(repo.workdir().unwrap().join("a.txt"), "1\n").unwrap();
    std::fs::write(repo.workdir().unwrap().join("scratch.txt"), "clobber\n").unwrap();
    // scratch.txt does not exist on master… make it exist there:
    let head = repo.head().unwrap().peel_to_commit().unwrap().id();
    commit_all(
        &repo,
        &[&head],
        "add scratch",
        &[("scratch.txt", "from master\n")],
    );
    // a.txt clean now, but scratch.txt is untracked on feature side? No — it
    // was committed. Write a fresh untracked file that exists on the other
    // branch instead:
    refs::switch_branch(&repo, "r1", "master").unwrap();
    std::fs::write(repo.workdir().unwrap().join("a.txt"), "clean\n").unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new("a.txt")).unwrap();
    index.write().unwrap();
    let _ = index.write_tree().unwrap();
    repo.checkout_head(Some(&mut git2::build::CheckoutBuilder::new().force()))
        .unwrap();
    std::fs::write(repo.workdir().unwrap().join("scratch.txt"), "clobber\n").unwrap();
    let mut index = repo.index().unwrap();
    index.remove_path(Path::new("scratch.txt")).unwrap();
    index.write().unwrap();
    // Now: scratch.txt untracked here, present on master… we're ON master.
    // Switch to other (which lacks scratch.txt? it has it). Create the branch
    // state where target contains the path:
    let err = refs::switch_branch(&repo, "r1", "other").unwrap_err();
    assert!(
        matches!(err, EgError::DirtyWorktree { .. }),
        "untracked conflict must block the switch"
    );
}

#[test]
fn tag_crud_and_recycle_bin() {
    let dir = TempDir::new().unwrap();
    let safety = Safety::for_tests(dir.path());
    let (_repo_dir, mut repo) = init_repo();
    let first = commit_all(&repo, &[], "first", &[("a.txt", "1\n")]);
    let second = commit_all(&repo, &[&first], "second", &[("a.txt", "2\n")]);

    let light = refs::create_tag(&repo, "v1", &first.to_string(), None).unwrap();
    assert!(!light.annotated);
    assert_eq!(light.target_oid, first.to_string());

    let annot = refs::create_tag(&repo, "release-1", &second.to_string(), Some("正式版")).unwrap();
    assert!(annot.annotated);
    assert_eq!(annot.message.as_deref(), Some("正式版"));

    let tags = refs::list_tags(&repo).unwrap();
    assert_eq!(tags.len(), 2);

    // Duplicate name refused.
    assert!(refs::create_tag(&repo, "v1", &second.to_string(), None).is_err());

    // Delete + undo restores the ANNOTATED tag object, not just the commit.
    let op_id = refs::delete_tag(&repo, "r1", &safety, "release-1").unwrap();
    assert!(repo.find_reference("refs/tags/release-1").is_err());
    ops::undo_operation(&mut repo, "r1", &safety, &op_id).unwrap();
    {
        let restored = repo.find_reference("refs/tags/release-1").unwrap();
        assert!(
            restored.peel_to_tag().is_ok(),
            "annotated tag object survives"
        );
    }

    // Lightweight restore keeps pointing at the commit.
    let op_id = refs::delete_tag(&repo, "r1", &safety, "v1").unwrap();
    ops::undo_operation(&mut repo, "r1", &safety, &op_id).unwrap();
    {
        let restored = repo.find_reference("refs/tags/v1").unwrap();
        assert_eq!(restored.peel_to_commit().unwrap().id(), first);
    }
}

#[test]
fn stash_round_trip_lossless() {
    let (_dir, mut repo) = init_repo();
    commit_all(&repo, &[], "base", &[("a.txt", "1\n")]);

    // Worktree + INDEX changes + untracked file, all stashed together.
    std::fs::write(repo.workdir().unwrap().join("a.txt"), "dirty\n").unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new("a.txt")).unwrap();
    index.write().unwrap();
    std::fs::write(repo.workdir().unwrap().join("new.txt"), "untracked\n").unwrap();

    let status = stash::stash_push(&mut repo, "r1", Some("save my work"), true).unwrap();
    assert!(status.is_clean(), "worktree clean after stash");
    let entries = stash::list_stashes(&mut repo).unwrap();
    assert_eq!(entries.len(), 1);
    assert!(entries[0].message.contains("save my work"));

    // Apply restores BOTH the content and the index state (reinstate index =
    // lossless round trip).
    let status = stash::stash_apply(&mut repo, "r1", 0, false).unwrap();
    assert_eq!(status.unstaged.len(), 1, "a.txt edit restored to worktree");
    let staged = {
        let index = repo.index().unwrap();
        let entry = index.get_path(Path::new("a.txt"), 0).unwrap();
        let content = repo.find_blob(entry.id).unwrap().content().to_vec();
        content
    };
    assert_eq!(
        staged,
        b"dirty\n".to_vec(),
        "staged edit reinstated in index"
    );
    assert!(repo.workdir().unwrap().join("new.txt").exists());

    // Pop = apply + drop (a fresh unstaged edit exists again).
    std::fs::write(repo.workdir().unwrap().join("a.txt"), "changed\n").unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new("a.txt")).unwrap();
    index.write().unwrap();
    let _ = stash::stash_push(&mut repo, "r1", None, false).unwrap();
    let before = stash::list_stashes(&mut repo).unwrap().len();
    stash::stash_apply(&mut repo, "r1", 0, true).unwrap();
    let after = stash::list_stashes(&mut repo).unwrap().len();
    assert_eq!(after, before - 1, "pop removes the entry");

    // Explicit drop (UI confirms first).
    let entries = stash::stash_drop(&mut repo, 0).unwrap();
    assert_eq!(entries.len(), after - 1);
}

#[test]
fn stash_push_includes_untracked_files() {
    let (_dir, repo) = init_repo();
    commit_all(&repo, &[], "base", &[("a.txt", "1\n")]);
    std::fs::write(repo.workdir().unwrap().join("u.txt"), "untracked\n").unwrap();
    let mut mutable_repo = repo;
    stash::stash_push(&mut mutable_repo, "r1", None, true).unwrap();
    assert!(!mutable_repo.workdir().unwrap().join("u.txt").exists());
    stash::stash_apply(&mut mutable_repo, "r1", 0, true).unwrap();
    assert_eq!(
        std::fs::read_to_string(mutable_repo.workdir().unwrap().join("u.txt")).unwrap(),
        "untracked\n"
    );
    // Pop with apply: entry gone.
    assert!(stash::list_stashes(&mut mutable_repo).unwrap().is_empty());
}

fn read_file_norm(repo: &Repository, path: &str) -> String {
    std::fs::read_to_string(repo.workdir().unwrap().join(path))
        .unwrap()
        .replace("\r\n", "\n")
}

/// Regression (fix/switch-worktree-sync): switching branches must sync the
/// workdir and the on-disk index to the target tree. The old order (set_head
/// moved HEAD, then checkout_head made baseline == target, so the SAFE
/// strategy skipped every differing file) left the old branch's content on
/// disk behind a new-branch HEAD — status showed unstaged/staged diffs.
#[test]
fn switch_branch_syncs_workdir_to_target() {
    let (_dir, repo) = init_repo();
    let base = commit_all(
        &repo,
        &[],
        "base",
        &[
            ("a.txt", "base-a\n"),
            ("b.txt", "base-b\n"),
            ("c.txt", "delete-me\n"),
        ],
    );
    // Whatever the default branch is called on this machine (master/main).
    let home_branch = head_branch(&repo);
    refs::create_branch(&repo, "other", Some(&base.to_string())).unwrap();

    // The home branch diverges: b.txt modified.
    let main_tip = commit_all(&repo, &[&base], "main work", &[("b.txt", "main-b\n")]);

    // other diverges: a.txt modified, d.txt added, c.txt deleted (manual
    // commit because commit_all only writes files).
    repo.set_head("refs/heads/other").unwrap();
    repo.checkout_head(Some(&mut git2::build::CheckoutBuilder::new().force()))
        .unwrap();
    let feature_tip = commit_all(
        &repo,
        &[&base],
        "other work",
        &[("a.txt", "other-a\n"), ("d.txt", "d\n")],
    );
    std::fs::remove_file(repo.workdir().unwrap().join("c.txt")).unwrap();
    {
        let mut index = repo.index().unwrap();
        index.remove_all(["c.txt"], None).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let sig = Signature::new("张三", "z@ex.com", &Time::new(2, 0)).unwrap();
        let parent = repo.find_commit(feature_tip).unwrap();
        repo.commit(
            Some("HEAD"),
            &sig,
            &sig,
            "other deletes c.txt",
            &tree,
            &[&parent],
        )
        .unwrap();
    }
    // Back on the home branch for the test.
    repo.set_head(&format!("refs/heads/{home_branch}")).unwrap();
    repo.checkout_head(Some(&mut git2::build::CheckoutBuilder::new().force()))
        .unwrap();
    assert_eq!(
        main_tip,
        repo.head().unwrap().peel_to_commit().unwrap().id()
    );

    // home → other: workdir and index follow the target tree, status clean.
    let outcome = refs::switch_branch(&repo, "r1", "other").unwrap();
    assert_eq!(head_branch(&repo), "other");
    assert_eq!(read_file_norm(&repo, "a.txt"), "other-a\n");
    assert_eq!(read_file_norm(&repo, "b.txt"), "base-b\n");
    assert_eq!(read_file_norm(&repo, "d.txt"), "d\n");
    assert!(
        !repo.workdir().unwrap().join("c.txt").exists(),
        "deleted on other, so the switch removes it"
    );
    assert!(outcome.staged.is_empty(), "staged: {:?}", outcome.staged);
    assert!(
        outcome.unstaged.is_empty(),
        "unstaged: {:?}",
        outcome.unstaged
    );
    assert!(outcome.conflicted.is_empty());

    // other → home: everything restored, still clean.
    let outcome = refs::switch_branch(&repo, "r1", &home_branch).unwrap();
    assert_eq!(read_file_norm(&repo, "b.txt"), "main-b\n");
    assert_eq!(read_file_norm(&repo, "a.txt"), "base-a\n");
    assert_eq!(read_file_norm(&repo, "c.txt"), "delete-me\n");
    assert!(
        !repo.workdir().unwrap().join("d.txt").exists(),
        "d.txt only exists on other"
    );
    assert!(outcome.staged.is_empty());
    assert!(outcome.unstaged.is_empty());
    assert!(outcome.conflicted.is_empty());
}
