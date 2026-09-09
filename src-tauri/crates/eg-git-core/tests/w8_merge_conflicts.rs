//! W8 tests (m1-plan R-19/R-20/R-21): merge (ff / no-ff / conflict parking /
//! abort), conflict block parsing + resolve → two-parent finalize, revert
//! (single / multi / rollback), reset three modes + hard-reset undo.

use std::path::Path;

use eg_git_core::{commit as commit_mod, conflicts, merge, ops, refs};
use eg_safety::Safety;
use eg_types::{CommitRequest, EgError, ResetMode};
use git2::{Oid, Repository, Signature, Time};
use tempfile::TempDir;

fn init_repo() -> (TempDir, Repository) {
    let dir = TempDir::new().expect("temp dir");
    let repo = Repository::init(dir.path()).expect("git init");
    // libgit2 defaults to master; EasyGit fixtures use main.
    repo.set_head("refs/heads/main").unwrap();
    let mut config = repo.config().unwrap();
    config.set_str("user.name", "张三").unwrap();
    config.set_str("user.email", "z@ex.com").unwrap();
    (dir, repo)
}

/// Safety log dir OUTSIDE the repository workdir (the log would otherwise
/// show up as an untracked directory and dirty the status assertions).
fn safety_dir() -> (TempDir, Safety) {
    let dir = TempDir::new().unwrap();
    let safety = Safety::for_tests(dir.path());
    (dir, safety)
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

fn read_file(repo: &Repository, path: &str) -> String {
    std::fs::read_to_string(repo.workdir().unwrap().join(path)).unwrap()
}

fn checkout(repo: &Repository, refname: &str) {
    repo.set_head(refname).unwrap();
    repo.checkout_head(Some(&mut git2::build::CheckoutBuilder::new().force()))
        .unwrap();
}

/// feature-flow style: base → both branches edit `shared.txt` (conflict when
/// merged); main also keeps a private file.
fn diverged(repo: &Repository) -> (Oid, Oid) {
    let base = commit_all(
        repo,
        &[],
        "base",
        &[("shared.txt", "line1\n"), ("main.txt", "m\n")],
    );
    refs::create_branch(repo, "feature", Some(base.to_string().as_str())).unwrap();
    let main_tip = commit_all(
        repo,
        &[&base],
        "main work",
        &[("shared.txt", "main edit\n")],
    );
    checkout(repo, "refs/heads/feature");
    let feature_tip = commit_all(
        repo,
        &[&base],
        "feature work",
        &[("shared.txt", "feature edit\n")],
    );
    checkout(repo, "refs/heads/main");
    (main_tip, feature_tip)
}

fn merge_feature(repo: &mut Repository, no_ff: bool) -> eg_types::MergeOutcome {
    merge::merge_start(repo, "t", "feature", no_ff).unwrap()
}

#[test]
fn merge_fast_forward_moves_branch() {
    let (_dir, mut repo) = init_repo();
    let base = commit_all(&repo, &[], "base", &[("a.txt", "1\n")]);
    refs::create_branch(&repo, "feature", None).unwrap();
    checkout(&repo, "refs/heads/feature");
    let feature_tip = commit_all(&repo, &[&base], "f1", &[("a.txt", "2\n"), ("f.txt", "f\n")]);
    checkout(&repo, "refs/heads/main");

    let outcome = merge_feature(&mut repo, false);
    assert!(outcome.fast_forwarded);
    assert!(outcome.conflicts.is_empty());
    assert_eq!(head_branch(&repo), "main");
    assert_eq!(
        repo.head().unwrap().peel_to_commit().unwrap().id(),
        feature_tip
    );
    assert_eq!(read_file(&repo, "f.txt"), "f\n", "FF brings new files in");
    assert_eq!(read_file(&repo, "a.txt"), "2\n");
    assert!(
        merge::merge_state(&repo).unwrap().is_none(),
        "no parked merge"
    );
}

#[test]
fn merge_no_ff_forces_merge_commit() {
    let (_dir, mut repo) = init_repo();
    let base = commit_all(&repo, &[], "base", &[("a.txt", "1\n")]);
    refs::create_branch(&repo, "feature", None).unwrap();
    checkout(&repo, "refs/heads/feature");
    let feature_tip = commit_all(&repo, &[&base], "f1", &[("f.txt", "f\n")]);
    checkout(&repo, "refs/heads/main");

    let outcome = merge_feature(&mut repo, true);
    assert!(!outcome.fast_forwarded, "no_ff must refuse the shortcut");
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_ne!(head.id(), feature_tip);
    assert_eq!(head.parent_count(), 2);
    assert_eq!(
        head.parent_id(0).unwrap(),
        base,
        "first parent: old main tip"
    );
    assert_eq!(head.parent_id(1).unwrap(), feature_tip);
    assert_eq!(read_file(&repo, "f.txt"), "f\n");
}

#[test]
fn merge_diverged_clean_commits_two_parents() {
    let (_dir, mut repo) = init_repo();
    let base = commit_all(&repo, &[], "base", &[("a.txt", "1\n")]);
    refs::create_branch(&repo, "feature", Some(base.to_string().as_str())).unwrap();
    // Disjoint files: the merge has nothing to disagree about.
    let main_tip = commit_all(&repo, &[&base], "main work", &[("main.txt", "m\n")]);
    checkout(&repo, "refs/heads/feature");
    let extra = commit_all(&repo, &[&base], "f1", &[("other.txt", "o\n")]);
    checkout(&repo, "refs/heads/main");

    let outcome = merge_feature(&mut repo, false);
    assert!(!outcome.fast_forwarded);
    assert!(outcome.conflicts.is_empty());
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 2);
    assert_eq!(head.parent_id(0).unwrap(), main_tip);
    assert_eq!(head.parent_id(1).unwrap(), extra);
    assert_eq!(read_file(&repo, "other.txt"), "o\n");
    assert!(merge::merge_state(&repo).unwrap().is_none());
}

#[test]
fn merge_conflict_parks_git_style_state() {
    let (_dir, mut repo) = init_repo();
    diverged(&repo);

    let outcome = merge_feature(&mut repo, false);
    assert_eq!(outcome.conflicts, vec!["shared.txt".to_string()]);

    // Parked like real git: MERGE_HEAD + MERGE_MSG + conflict index + markers.
    let state = merge::merge_state(&repo).unwrap().expect("mid-merge");
    assert_eq!(state.message.as_deref(), Some("Merge branch 'feature'"));
    assert_eq!(state.theirs, vec!["feature".to_string()]);
    assert!(read_file(&repo, "shared.txt").contains("<<<<<<<"));
    assert!(read_file(&repo, "shared.txt").contains(">>>>>>>"));
    let index = repo.index().unwrap();
    assert!(index.has_conflicts());

    let report = eg_git_core::status::status("t", &repo).unwrap();
    assert!(report.conflicted.iter().any(|e| e.path == "shared.txt"));
}

#[test]
fn merge_abort_restores_pre_merge_state() {
    let (_dir, mut repo) = init_repo();
    let (main_tip, _) = diverged(&repo);
    merge_feature(&mut repo, false);
    assert!(merge::merge_state(&repo).unwrap().is_some());

    merge::merge_abort(&mut repo, "t").unwrap();
    assert!(merge::merge_state(&repo).unwrap().is_none(), "park cleared");
    assert_eq!(
        repo.head().unwrap().peel_to_commit().unwrap().id(),
        main_tip
    );
    assert_eq!(read_file(&repo, "shared.txt"), "main edit\n");
    let report = eg_git_core::status::status("t", &repo).unwrap();
    assert!(report.staged.is_empty() && report.unstaged.is_empty() && report.conflicted.is_empty());
}

#[test]
fn conflict_parse_and_resolve_finalizes_two_parent_commit() {
    let (_dir, mut repo) = init_repo();
    diverged(&repo);
    merge_feature(&mut repo, false);

    let files = conflicts::conflicts_get(&repo, "t").unwrap();
    assert_eq!(files.len(), 1);
    let file = &files[0];
    assert_eq!(file.path, "shared.txt");
    assert!(!file.is_binary);
    // The wizard payload: segments interleave blocks; contents from stages.
    assert_eq!(file.segments.len(), file.blocks.len() + 1);
    let block = &file.blocks[0];
    assert_eq!(block.ours, vec!["main edit".to_string()]);
    assert_eq!(block.theirs, vec!["feature edit".to_string()]);
    assert_eq!(file.ours_content.as_deref(), Some("main edit\n"));
    assert_eq!(file.theirs_content.as_deref(), Some("feature edit\n"));
    assert_eq!(file.base_content.as_deref(), Some("line1\n"));

    // 逐块决策（两者保留）→ composed content from segments + decisions.
    let mut composed = file.segments[0].clone();
    composed.push_str(&block.ours.join("\n"));
    composed.push('\n');
    composed.push_str(&block.theirs.join("\n"));
    composed.push('\n');
    composed.push_str(&file.segments[1]);
    let report = conflicts::conflict_resolve(&repo, "t", "shared.txt", &composed).unwrap();
    assert!(report.conflicted.is_empty(), "resolve stages the file");
    assert_eq!(read_file(&repo, "shared.txt"), composed);

    // Finish via the regular commit path: two parents + MERGE_* cleanup.
    let outcome = commit_mod::commit(
        &repo,
        "t",
        &CommitRequest {
            subject: "Merge branch 'feature'".into(),
            body: String::new(),
            amend: false,
            allow_partial: false,
        },
    )
    .unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.id().to_string(), outcome.commit_id);
    assert_eq!(head.parent_count(), 2);
    assert!(
        merge::merge_state(&repo).unwrap().is_none(),
        "MERGE_* cleared"
    );
    let report = eg_git_core::status::status("t", &repo).unwrap();
    assert!(report.staged.is_empty() && report.unstaged.is_empty());
}

#[test]
fn revert_single_commit_writes_inverse() {
    let (_dir, mut repo) = init_repo();
    let base = commit_all(&repo, &[], "base", &[("a.txt", "1\n")]);
    let c1 = commit_all(&repo, &[&base], "add b", &[("b.txt", "b\n")]);

    let report = merge::revert_commits(&mut repo, "t", &[c1.to_string()]).unwrap();
    assert!(
        !repo.workdir().unwrap().join("b.txt").exists(),
        "revert removes the file the commit introduced"
    );
    // The inverse lands staged, like real git revert.
    assert!(report.staged.iter().any(|e| e.path == "b.txt"));
    let index = repo.index().unwrap();
    assert!(
        index.get_path(Path::new("b.txt"), 0).is_none(),
        "b.txt dropped from the index"
    );
    assert_eq!(read_file(&repo, "a.txt"), "1\n");
}

#[test]
fn revert_multi_in_order_applies_all() {
    let (_dir, mut repo) = init_repo();
    let base = commit_all(&repo, &[], "base", &[("a.txt", "1\n")]);
    let c1 = commit_all(&repo, &[&base], "c1", &[("b.txt", "b\n")]);
    let c2 = commit_all(&repo, &[&c1], "c2", &[("a.txt", "2\n")]);

    // Newest first so the inverse chain applies without conflicts (the
    // second revert must not overwrite the first revert's staged edits).
    merge::revert_commits(&mut repo, "t", &[c2.to_string(), c1.to_string()]).unwrap();
    assert_eq!(read_file(&repo, "a.txt"), "1\n");
    assert!(!repo.workdir().unwrap().join("b.txt").exists());
}

#[test]
fn revert_conflict_rolls_back_whole_sequence() {
    let (_dir, mut repo) = init_repo();
    let base = commit_all(&repo, &[], "base", &[("a.txt", "1\n")]);
    let c1 = commit_all(&repo, &[&base], "c1", &[("a.txt", "2\n")]);
    let c2 = commit_all(&repo, &[&c1], "c2", &[("a.txt", "3\n")]);

    // Reverting c1 first collides: ours moved a 2→3 while the inverse moves
    // 2→1. The whole sequence must roll back to the original tip.
    let err = merge::revert_commits(&mut repo, "t", &[c1.to_string(), c2.to_string()]).unwrap_err();
    assert!(matches!(err, EgError::ConflictState { .. }));
    assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id(), c2);
    assert_eq!(
        read_file(&repo, "a.txt"),
        "3\n",
        "rollback restores the tip"
    );
    let report = eg_git_core::status::status("t", &repo).unwrap();
    assert!(report.staged.is_empty() && report.unstaged.is_empty() && report.conflicted.is_empty());
}

#[test]
fn reset_three_modes_match_git_semantics() {
    let (_safety_dir, safety) = safety_dir();
    let (_dir, mut repo) = init_repo();
    let base = commit_all(&repo, &[], "base", &[("a.txt", "1\n")]);
    let c2 = commit_all(&repo, &[&base], "c2", &[("a.txt", "2\n")]);

    // Stage a=3 on top of c2.
    std::fs::write(repo.workdir().unwrap().join("a.txt"), "3\n").unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new("a.txt")).unwrap();
    index.write().unwrap();

    // Soft: branch moves, index + worktree untouched (a=3 still staged).
    merge::reset(
        &mut repo,
        "t",
        ResetMode::Soft,
        Some(&base.to_string()),
        &safety,
    )
    .unwrap();
    assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id(), base);
    let report = eg_git_core::status::status("t", &repo).unwrap();
    assert!(report.staged.iter().any(|e| e.path == "a.txt"));
    assert_eq!(read_file(&repo, "a.txt"), "3\n");

    // Mixed: index := target, worktree untouched (a=3 becomes unstaged).
    merge::reset(
        &mut repo,
        "t",
        ResetMode::Mixed,
        Some(&c2.to_string()),
        &safety,
    )
    .unwrap();
    assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id(), c2);
    let report = eg_git_core::status::status("t", &repo).unwrap();
    assert!(report.staged.is_empty());
    assert!(report.unstaged.iter().any(|e| e.path == "a.txt"));
    assert_eq!(read_file(&repo, "a.txt"), "3\n");

    // Hard: worktree + index := target, snapshot op id for the 撤销 toast.
    let outcome = merge::reset(
        &mut repo,
        "t",
        ResetMode::Hard,
        Some(&base.to_string()),
        &safety,
    )
    .unwrap();
    assert!(outcome.op_id.is_some(), "hard reset must snapshot");
    let report = eg_git_core::status::status("t", &repo).unwrap();
    assert!(report.staged.is_empty() && report.unstaged.is_empty());
    assert_eq!(read_file(&repo, "a.txt"), "1\n");

    // Soft/mixed never snapshot.
    let outcome = merge::reset(
        &mut repo,
        "t",
        ResetMode::Mixed,
        Some(&c2.to_string()),
        &safety,
    )
    .unwrap();
    assert!(outcome.op_id.is_none());
}

#[test]
fn reset_hard_undo_restores_files_and_branch() {
    let (_safety_dir, safety) = safety_dir();
    let (_dir, mut repo) = init_repo();
    let base = commit_all(&repo, &[], "base", &[("a.txt", "1\n")]);
    let c2 = commit_all(
        &repo,
        &[&base],
        "c2",
        &[("a.txt", "2\n"), ("new.txt", "n\n")],
    );

    // Hard reset back to base: c2's content vanishes from the worktree.
    let outcome = merge::reset(
        &mut repo,
        "t",
        ResetMode::Hard,
        Some(&base.to_string()),
        &safety,
    )
    .unwrap();
    let op_id = outcome.op_id.expect("snapshot op id");
    assert_eq!(read_file(&repo, "a.txt"), "1\n");
    assert!(!repo.workdir().unwrap().join("new.txt").exists());

    // 撤销: files rebuilt from the snapshot, branch moves back to c2.
    ops::undo_operation(&mut repo, "t", &safety, &op_id).unwrap();
    assert_eq!(read_file(&repo, "a.txt"), "2\n");
    assert_eq!(read_file(&repo, "new.txt"), "n\n");
    assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id(), c2);
    let report = eg_git_core::status::status("t", &repo).unwrap();
    assert!(
        report.staged.is_empty() && report.unstaged.is_empty(),
        "undo lands clean"
    );
}

#[test]
fn merge_up_to_date_is_noop_and_dirty_tree_rejected() {
    let (_dir, mut repo) = init_repo();
    let (_, feature_tip) = diverged(&repo);

    // Resolve by taking theirs so main now CONTAINS feature.
    merge_feature(&mut repo, false);
    let files = conflicts::conflicts_get(&repo, "t").unwrap();
    let theirs = files[0].theirs_content.clone().unwrap();
    conflicts::conflict_resolve(&repo, "t", "shared.txt", &theirs).unwrap();
    commit_mod::commit(
        &repo,
        "t",
        &CommitRequest {
            subject: "Merge branch 'feature'".into(),
            body: String::new(),
            amend: false,
            allow_partial: false,
        },
    )
    .unwrap();

    // Already merged: no-op.
    let outcome = merge_feature(&mut repo, false);
    assert!(!outcome.fast_forwarded);
    assert!(outcome.conflicts.is_empty());
    assert_eq!(
        repo.head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .parent_count(),
        2
    );

    // Dirty tracked tree blocks a new merge (red-line: never clobber).
    std::fs::write(repo.workdir().unwrap().join("main.txt"), "dirty\n").unwrap();
    refs::create_branch(&repo, "other", Some(feature_tip.to_string().as_str())).unwrap();
    let err = merge::merge_start(&mut repo, "t", "other", false).unwrap_err();
    assert!(matches!(err, EgError::DirtyWorktree { .. }));
}
