//! W6 tests (m1-plan R-12/R-13): file diffs from three sources with word
//! spans and truncation, plus hunk/line-level staging round-trips.

use std::path::Path;

use eg_git_core::diff;
use eg_types::{
    ChangeKind, DiffLineKind, DiffRequest, DiffSourceKind, SelectedHunk, StageLinesRequest,
};
use git2::{Oid, Repository, Signature, Time};
use tempfile::TempDir;

fn init_repo() -> (TempDir, Repository) {
    let dir = TempDir::new().expect("temp dir");
    let repo = Repository::init(dir.path()).expect("git init");
    (dir, repo)
}

fn commit_all(repo: &Repository, parents: &[&Oid], msg: &str, time: i64) -> Oid {
    let mut index = repo.index().unwrap();
    index
        .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
        .unwrap();
    index.write().unwrap();
    let tree_id = index.write_tree().unwrap();
    let sig = Signature::new("张三", "z@ex.com", &Time::new(time, 0)).unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    let parent_commits: Vec<git2::Commit> = parents
        .iter()
        .map(|o| repo.find_commit(**o).unwrap())
        .collect();
    let parent_refs: Vec<&git2::Commit> = parent_commits.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parent_refs)
        .unwrap()
}

fn write(repo: &Repository, path: &str, content: &str) {
    let file = repo.workdir().unwrap().join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, content).unwrap();
}

fn req(path: &str, source: DiffSourceKind) -> DiffRequest {
    DiffRequest {
        path: path.into(),
        old_path: None,
        source,
        commit_oid: None,
    }
}

fn find_line<'a>(
    resp: &'a eg_types::DiffResponse,
    kind: DiffLineKind,
    needle: &str,
) -> &'a eg_types::DiffLine {
    resp.hunks
        .iter()
        .flat_map(|h| h.lines.iter())
        .find(|l| l.kind == kind && l.content.contains(needle))
        .unwrap_or_else(|| panic!("missing {kind:?} line containing {needle}"))
}

#[test]
fn worktree_diff_hunks_and_lines() {
    let (_dir, repo) = init_repo();
    write(&repo, "a.txt", "one\ntwo\nalpha beta gamma\nfour\nfive\n");
    let _base = commit_all(&repo, &[], "base", 1);
    write(&repo, "a.txt", "one\ntwo\nalpha BETA gamma\nfour\nfive\n");

    let resp = diff::diff_file(&repo, "r1", &req("a.txt", DiffSourceKind::Worktree)).unwrap();
    assert_eq!(resp.kind, ChangeKind::Modified);
    assert!(!resp.is_binary);
    assert_eq!(resp.added, 1);
    assert_eq!(resp.deleted, 1);
    assert_eq!(resp.hunks.len(), 1);
    let hunk = &resp.hunks[0];
    // Two context lines above the change pull the hunk start to line 1.
    assert_eq!(hunk.old_start, 1);
    assert_eq!(hunk.new_start, 1);

    // Line numbers and kinds on the paired change.
    let deleted = find_line(&resp, DiffLineKind::Deleted, "alpha beta")
        .content
        .clone();
    let added = find_line(&resp, DiffLineKind::Added, "alpha BETA");
    assert_eq!(added.old_lineno, None);
    assert!(added.new_lineno.is_some());
    let context = find_line(&resp, DiffLineKind::Context, "one");
    assert!(context.old_lineno.is_some() && context.new_lineno.is_some());

    // The paired -/+ lines carry a word-level span over the middle segment.
    assert!(deleted_row(&resp).word.is_some());
    assert!(added.word.is_some());
    let _ = deleted;
}

fn deleted_row(resp: &eg_types::DiffResponse) -> &eg_types::DiffLine {
    resp.hunks
        .iter()
        .flat_map(|h| h.lines.iter())
        .find(|l| l.kind == DiffLineKind::Deleted)
        .unwrap()
}

#[test]
fn index_and_commit_sources() {
    let (_dir, repo) = init_repo();
    write(&repo, "a.txt", "one\ntwo\n");
    let base = commit_all(&repo, &[], "base", 1);
    write(&repo, "a.txt", "one\ntwo\nthree\n");
    // Stage the addition → index source must see it, worktree source not.
    let mut index = repo.index().unwrap();
    index.add_path(Path::new("a.txt")).unwrap();
    index.write().unwrap();

    let index_resp = diff::diff_file(&repo, "r1", &req("a.txt", DiffSourceKind::Index)).unwrap();
    assert_eq!(index_resp.added, 1);
    assert!(index_resp.hunks[0]
        .lines
        .iter()
        .any(|l| l.kind == DiffLineKind::Added && l.content.contains("three")));

    let work_resp = diff::diff_file(&repo, "r1", &req("a.txt", DiffSourceKind::Worktree)).unwrap();
    assert_eq!(work_resp.added, 0, "workdir matches the index now");

    // Commit the change → commit source diffs parent→commit.
    let second = commit_all(&repo, &[&base], "second", 2);
    let mut commit_req = req("a.txt", DiffSourceKind::Commit);
    commit_req.commit_oid = Some(second.to_string());
    let resp = diff::diff_file(&repo, "r1", &commit_req).unwrap();
    assert_eq!(resp.added, 1);
}

#[test]
fn binary_and_truncation() {
    let (_dir, repo) = init_repo();
    write(&repo, "bin.dat", "hello");
    let _base = commit_all(&repo, &[], "base", 1);
    write(&repo, "bin.dat", "hi\x00\u{1}\u{2}world");

    let resp = diff::diff_file(&repo, "r1", &req("bin.dat", DiffSourceKind::Worktree)).unwrap();
    assert!(resp.is_binary);
    assert!(resp.hunks.is_empty());

    // > MAX_DIFF_LINES (5000) total lines gets truncated but stays valid.
    let big: String = (0..5200).map(|i| format!("line {i}\n")).collect();
    write(&repo, "big.txt", &big);
    let resp = diff::diff_file(&repo, "r1", &req("big.txt", DiffSourceKind::Worktree)).unwrap();
    assert!(resp.truncated);
    let total: usize = resp.hunks.iter().map(|h| h.lines.len()).sum();
    assert!(total <= diff::MAX_DIFF_LINES);
}

#[test]
fn stage_whole_hunk_and_unstage() {
    let (_dir, repo) = init_repo();
    write(&repo, "a.txt", "one\ntwo\nthree\n");
    let _base = commit_all(&repo, &[], "base", 1);
    write(&repo, "a.txt", "one\ntwo\nthree\nfour\nfive\n");

    // Stage the single whole hunk (all changed lines selected).
    let resp = diff::diff_file(&repo, "r1", &req("a.txt", DiffSourceKind::Worktree)).unwrap();
    let selected: Vec<u32> = resp.hunks[0]
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| l.kind != DiffLineKind::Context)
        .map(|(i, _)| i as u32)
        .collect();
    let status = diff::stage_lines(
        &repo,
        "r1",
        &StageLinesRequest {
            path: "a.txt".into(),
            source: DiffSourceKind::Worktree,
            hunks: vec![SelectedHunk {
                hunk_index: 0,
                line_indexes: selected,
            }],
        },
    )
    .unwrap();

    // Index holds the addition; worktree is clean relative to the index.
    assert_eq!(status.staged.len(), 1);
    assert_eq!(status.unstaged.len(), 0);
    let index_resp = diff::diff_file(&repo, "r1", &req("a.txt", DiffSourceKind::Index)).unwrap();
    assert_eq!(index_resp.added, 2);

    // Unstage the same hunk from the index source: back to HEAD content.
    let status = diff::stage_lines(
        &repo,
        "r1",
        &StageLinesRequest {
            path: "a.txt".into(),
            source: DiffSourceKind::Index,
            hunks: vec![SelectedHunk {
                hunk_index: 0,
                line_indexes: index_resp.hunks[0]
                    .lines
                    .iter()
                    .enumerate()
                    .filter(|(_, l)| l.kind != DiffLineKind::Context)
                    .map(|(i, _)| i as u32)
                    .collect(),
            }],
        },
    )
    .unwrap();
    assert_eq!(status.staged.len(), 0);
    let index_resp = diff::diff_file(&repo, "r1", &req("a.txt", DiffSourceKind::Index)).unwrap();
    assert_eq!(index_resp.added, 0);
    // Worktree still has the edit (staging never touches the worktree).
    let work_resp = diff::diff_file(&repo, "r1", &req("a.txt", DiffSourceKind::Worktree)).unwrap();
    assert_eq!(work_resp.added, 2);
}

#[test]
fn stage_partial_hunk_lines() {
    let (_dir, repo) = init_repo();
    write(&repo, "a.txt", "one\ntwo\nthree\n");
    let _base = commit_all(&repo, &[], "base", 1);
    // One hunk with three changed line pairs; stage only the first pair.
    write(&repo, "a.txt", "one\nTWO\nTHREE\nFOUR\n");

    let resp = diff::diff_file(&repo, "r1", &req("a.txt", DiffSourceKind::Worktree)).unwrap();
    assert_eq!(resp.hunks.len(), 1, "contiguous changes form one hunk");
    let hunk = &resp.hunks[0];
    // Pick exactly the first deleted row and its added pair.
    let first_del = hunk
        .lines
        .iter()
        .position(|l| l.kind == DiffLineKind::Deleted)
        .unwrap();
    let first_add = hunk
        .lines
        .iter()
        .position(|l| l.kind == DiffLineKind::Added)
        .unwrap();
    let pick = if first_del < first_add {
        vec![first_del as u32, first_add as u32]
    } else {
        vec![first_add as u32, first_del as u32]
    };

    diff::stage_lines(
        &repo,
        "r1",
        &StageLinesRequest {
            path: "a.txt".into(),
            source: DiffSourceKind::Worktree,
            hunks: vec![SelectedHunk {
                hunk_index: 0,
                line_indexes: pick,
            }],
        },
    )
    .unwrap();

    // Index: exactly one line changed; worktree: still three.
    let index_resp = diff::diff_file(&repo, "r1", &req("a.txt", DiffSourceKind::Index)).unwrap();
    assert_eq!(index_resp.added, 1);
    assert_eq!(index_resp.deleted, 1);
    let work_resp = diff::diff_file(&repo, "r1", &req("a.txt", DiffSourceKind::Worktree)).unwrap();
    assert!(
        work_resp.added >= 1 && work_resp.deleted >= 1,
        "workdir edits remain"
    );

    assert_eq!(
        std::fs::read_to_string(repo.workdir().unwrap().join("a.txt")).unwrap(),
        "one\nTWO\nTHREE\nFOUR\n"
    );

    // The staged blob holds HEAD + only the first replacement.
    let head_blob = {
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let entry = head.tree().unwrap().get_path(Path::new("a.txt")).unwrap();
        repo.find_blob(entry.id()).unwrap().content().to_vec()
    };
    let staged = {
        let index = repo.index().unwrap();
        let entry = index.get_path(Path::new("a.txt"), 0).unwrap();
        repo.find_blob(entry.id).unwrap().content().to_vec()
    };
    assert_eq!(
        String::from_utf8_lossy(&staged),
        "one\nTWO\nthree\n",
        "index = HEAD + first replacement only"
    );
    assert_eq!(String::from_utf8_lossy(&head_blob), "one\ntwo\nthree\n");
}

#[test]
fn stage_second_hunk_only() {
    let (_dir, repo) = init_repo();
    write(&repo, "a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n");
    let _base = commit_all(&repo, &[], "base", 1);
    // Two widely separated changes → two hunks even with 3 context lines.
    write(
        &repo,
        "a.txt",
        "ONE\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\nTWELVE\n",
    );

    let resp = diff::diff_file(&repo, "r1", &req("a.txt", DiffSourceKind::Worktree)).unwrap();
    assert_eq!(resp.hunks.len(), 2);
    let all_changed = |hunk_index: usize| -> Vec<u32> {
        resp.hunks[hunk_index]
            .lines
            .iter()
            .enumerate()
            .filter(|(_, l)| l.kind != DiffLineKind::Context)
            .map(|(i, _)| i as u32)
            .collect()
    };
    diff::stage_lines(
        &repo,
        "r1",
        &StageLinesRequest {
            path: "a.txt".into(),
            source: DiffSourceKind::Worktree,
            hunks: vec![SelectedHunk {
                hunk_index: 1,
                line_indexes: all_changed(1),
            }],
        },
    )
    .unwrap();

    // Only the second change is staged.
    let staged = {
        let index = repo.index().unwrap();
        let entry = index.get_path(Path::new("a.txt"), 0).unwrap();
        repo.find_blob(entry.id).unwrap().content().to_vec()
    };
    assert_eq!(
        String::from_utf8_lossy(&staged),
        "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\nTWELVE\n"
    );
}
