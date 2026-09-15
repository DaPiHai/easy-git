//! W5 tests (m1-plan R-10/F-16): lane-annotated log pages, pagination,
//! filters, ref decorations and commit details.

use std::path::Path;
use std::time::Instant;

use eg_git_core::log;
use eg_types::LogFilter;
use git2::{Oid, Repository, Signature, Time};
use tempfile::TempDir;

fn init_repo() -> (TempDir, Repository) {
    let dir = TempDir::new().expect("temp dir");
    let repo = Repository::init(dir.path()).expect("git init");
    // Pin LF (see w2_repo_foundation.rs): never inherit the machine's
    // `core.autocrlf`, or checkouts come back CRLF and byte-exact content
    // assertions fail on Windows only.
    repo.config()
        .expect("repo config")
        .set_bool("core.autocrlf", false)
        .expect("pin core.autocrlf=false for the test repo");
    (dir, repo)
}

/// Creates a commit on `refname` with `files` (path → content, appended as
/// `path:content` writes) and returns its oid.
fn commit_on(
    repo: &Repository,
    parents: &[&Oid],
    refname: &str,
    msg: &str,
    author: (&str, &str),
    time: i64,
    files: &[(&str, &str)],
) -> Oid {
    for (path, content) in files {
        let file = repo.workdir().unwrap().join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, content).unwrap();
    }
    let mut index = repo.index().unwrap();
    for (path, _) in files {
        index.add_path(Path::new(path)).unwrap();
    }
    index.write().unwrap();
    let tree_id = index.write_tree().unwrap();
    let sig = Signature::new(author.0, author.1, &Time::new(time, 0)).unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    let parent_commits: Vec<git2::Commit> = parents
        .iter()
        .map(|o| repo.find_commit(**o).unwrap())
        .collect();
    let parent_refs: Vec<&git2::Commit> = parent_commits.iter().collect();
    repo.commit(Some(refname), &sig, &sig, msg, &tree, &parent_refs)
        .unwrap()
}

/// Diamond fixture: base → (main: m1; feature: f1→f2) → merge M on main.
struct Diamond {
    base: Oid,
    m1: Oid,
    f1: Oid,
    f2: Oid,
    merge: Oid,
}

fn build_diamond(repo: &Repository) -> Diamond {
    let base = commit_on(
        repo,
        &[],
        "HEAD",
        "base",
        ("张三", "z@ex.com"),
        1,
        &[("f.txt", "1\n")],
    );
    let m1 = commit_on(
        repo,
        &[&base],
        "HEAD",
        "main step",
        ("张三", "z@ex.com"),
        3,
        &[("f.txt", "2\n")],
    );
    let f1 = commit_on(
        repo,
        &[&base],
        "refs/heads/feature",
        "feature one",
        ("李四", "l@ex.com"),
        2,
        &[("g.txt", "a\nb\nc\n")],
    );
    let f2 = commit_on(
        repo,
        &[&f1],
        "refs/heads/feature",
        "feature two",
        ("李四", "l@ex.com"),
        4,
        &[("g.txt", "a\nb\nc\nd\n")],
    );
    let merge = commit_on(
        repo,
        &[&m1, &f2],
        "HEAD",
        "merge feature",
        ("张三", "z@ex.com"),
        5,
        &[("f.txt", "2\n")],
    );
    Diamond {
        base,
        m1,
        f1,
        f2,
        merge,
    }
}

fn find_subject<'a>(page: &'a eg_types::LogPage, needle: &str) -> &'a eg_types::CommitLogEntry {
    page.entries
        .iter()
        .find(|e| e.subject.contains(needle))
        .unwrap_or_else(|| panic!("missing row {needle}"))
}

#[test]
fn linear_log_single_lane() {
    let (_dir, repo) = init_repo();
    let mut parent: Option<Oid> = None;
    for i in 1..=3 {
        let parents: Vec<&Oid> = parent.iter().collect();
        parent = Some(commit_on(
            &repo,
            &parents,
            "HEAD",
            &format!("c{i}"),
            ("张三", "z@ex.com"),
            i,
            &[("f.txt", &format!("{i}\n"))],
        ));
    }

    let page = log::log_page(&repo, "r1", 0, 10, &LogFilter::default()).unwrap();
    assert_eq!(page.entries.len(), 3);
    assert_eq!(page.branch.as_deref(), Some("master"));
    assert!(page.next_offset.is_none());
    for entry in &page.entries {
        assert_eq!(entry.node.lane, 0, "linear history stays on lane 0");
        assert_eq!(entry.node.color, 0, "lane 0 keeps the branch-1 color");
        assert!(!entry.node.merge);
        assert_eq!(entry.lane_count, 1);
        assert_eq!(entry.author_name, "张三");
    }
    // Non-root rows continue lane 0 straight down.
    for entry in &page.entries[..2] {
        assert!(entry.lines.iter().any(|l| l.from == 0 && l.to == 0));
    }
    // Root row terminates its lane: no line continues below it.
    assert!(page.entries[2].lines.is_empty());
}

#[test]
fn diamond_branch_and_merge_geometry() {
    let (_dir, repo) = init_repo();
    let d = build_diamond(&repo);

    let page = log::log_page(&repo, "r1", 0, 20, &LogFilter::default()).unwrap();
    assert_eq!(page.entries.len(), 5);

    // Merge first (topo order), on lane 0, rendered as a diamond, with a
    // merge line from lane 0 down to the new lane 1 for the feature parent.
    let merge = find_subject(&page, "merge feature");
    assert_eq!(merge.oid, d.merge.to_string());
    assert!(merge.node.merge);
    assert_eq!(merge.parent_count, 2);
    assert_eq!(merge.node.lane, 0);
    assert_eq!(merge.lane_count, 2);
    assert!(merge.lines.iter().any(|l| l.from == 0 && l.to == 0));
    assert!(merge.lines.iter().any(|l| l.from == 0 && l.to == 1));

    // Feature parent occupies lane 1; main parent lane 0.
    assert_eq!(find_subject(&page, "feature two").oid, d.f2.to_string());
    assert_eq!(find_subject(&page, "feature one").oid, d.f1.to_string());
    assert_eq!(find_subject(&page, "feature two").node.lane, 1);
    assert_eq!(find_subject(&page, "feature one").node.lane, 1);
    let m1 = find_subject(&page, "main step");
    assert_eq!(m1.oid, d.m1.to_string());
    assert_eq!(m1.node.lane, 0);
    // m1's row passes the pending feature lane straight through.
    assert!(m1.lines.iter().any(|l| l.from == 1 && l.to == 1));

    // The base commit coalesces both lanes: a join line into its node and
    // the lane count collapses back to 1.
    let base = find_subject(&page, "base");
    assert_eq!(base.node.lane, 0);
    // The row still spans two lanes at its TOP (the join line starts in the
    // second lane) even though both lanes terminate below it.
    assert_eq!(base.lane_count, 2);
    assert!(base.lines.iter().any(|l| l.from == 1 && l.to == 0));
}

#[test]
fn refs_and_head_decorations() {
    let (_dir, repo) = init_repo();
    let d = build_diamond(&repo);

    repo.reference("refs/heads/main", d.merge, true, "main")
        .unwrap();
    repo.reference("refs/remotes/origin/main", d.merge, true, "remote")
        .unwrap();
    repo.reference("refs/tags/v1", d.base, true, "tag").unwrap();
    // HEAD is detached now (we moved nothing), restore symbolic HEAD→main.
    repo.set_head("refs/heads/main").unwrap();

    let page = log::log_page(&repo, "r1", 0, 20, &LogFilter::default()).unwrap();
    let merge = find_subject(&page, "merge feature");
    assert!(merge.is_head);
    assert!(merge.refs.branches.contains(&"main".to_string()));
    assert_eq!(
        merge.refs.branches[0], "main",
        "current branch decorates first"
    );
    assert!(merge.refs.remotes.contains(&"origin/main".to_string()));
    assert!(find_subject(&page, "feature two")
        .refs
        .branches
        .contains(&"feature".to_string()));
    assert!(find_subject(&page, "base")
        .refs
        .tags
        .contains(&"v1".to_string()));
    assert_eq!(page.branch.as_deref(), Some("main"));
}

#[test]
fn pagination_continuity() {
    let (_dir, repo) = init_repo();
    let mut parent: Option<Oid> = None;
    let mut subjects = Vec::new();
    for i in 1..=10 {
        let parents: Vec<&Oid> = parent.iter().collect();
        let msg = format!("c{i:02}");
        parent = Some(commit_on(
            &repo,
            &parents,
            "HEAD",
            &msg,
            ("张三", "z@ex.com"),
            i,
            &[("f.txt", &format!("{i}\n"))],
        ));
        subjects.insert(0, msg); // log walks newest-first
    }

    let mut collected = Vec::new();
    let mut offset = 0;
    for _ in 0..10 {
        let page = log::log_page(&repo, "r1", offset, 3, &LogFilter::default()).unwrap();
        let more = page.next_offset;
        collected.extend(page.entries.into_iter().map(|e| e.subject));
        match more {
            Some(next) => offset = next,
            None => break,
        }
    }
    assert_eq!(collected.len(), subjects.len());
    assert_eq!(collected, subjects);

    // Lane geometry stays on lane 0 across page boundaries.
    let tail = log::log_page(&repo, "r1", 7, 3, &LogFilter::default()).unwrap();
    for entry in &tail.entries {
        assert_eq!(entry.node.lane, 0);
        assert_eq!(entry.lane_count, 1);
    }
}

#[test]
fn filters_author_message_branch() {
    let (_dir, repo) = init_repo();
    build_diamond(&repo);

    // Author filter: 李四 wrote only the feature commits.
    let page = log::log_page(
        &repo,
        "r1",
        0,
        20,
        &LogFilter {
            branch: None,
            author: Some("李四".into()),
            message: None,
        },
    )
    .unwrap();
    assert_eq!(page.entries.len(), 2);
    for entry in &page.entries {
        assert_eq!(entry.author_name, "李四");
    }

    // Message search, case-insensitive.
    let page = log::log_page(
        &repo,
        "r1",
        0,
        20,
        &LogFilter {
            branch: None,
            author: None,
            message: Some("MERGE".into()),
        },
    )
    .unwrap();
    assert_eq!(page.entries.len(), 1);
    assert!(page.entries[0].subject.contains("merge"));

    // Branch filter walks the feature lineage only (f2 → f1 → base).
    let page = log::log_page(
        &repo,
        "r1",
        0,
        20,
        &LogFilter {
            branch: Some("feature".into()),
            author: None,
            message: None,
        },
    )
    .unwrap();
    let subjects: Vec<&str> = page.entries.iter().map(|e| e.subject.as_str()).collect();
    assert_eq!(subjects, vec!["feature two", "feature one", "base"]);

    // Combined filters narrow further.
    let page = log::log_page(
        &repo,
        "r1",
        0,
        20,
        &LogFilter {
            branch: Some("feature".into()),
            author: Some("李四".into()),
            message: Some("two".into()),
        },
    )
    .unwrap();
    assert_eq!(page.entries.len(), 1);
    assert!(page.entries[0].subject.contains("two"));
}

#[test]
fn commit_detail_files_and_counts() {
    let (_dir, repo) = init_repo();
    let base = commit_on(
        &repo,
        &[],
        "HEAD",
        "base",
        ("张三", "z@ex.com"),
        1,
        &[("f.txt", "1\n2\n3\n")],
    );
    let second = commit_on(
        &repo,
        &[&base],
        "HEAD",
        "edit files\n\nLonger body\nacross lines\n",
        ("李四", "l@ex.com"),
        2,
        &[("f.txt", "1\n2X\n3\n4\n5\n"), ("new.txt", "n1\n")],
    );

    let detail = log::commit_detail(&repo, &second.to_string()).unwrap();
    assert_eq!(detail.subject, "edit files");
    assert!(detail.body.contains("Longer body"));
    assert_eq!(detail.author_name, "李四");
    assert_eq!(detail.files.len(), 2);

    let modified = detail.files.iter().find(|f| f.path == "f.txt").unwrap();
    assert_eq!(modified.kind, eg_types::ChangeKind::Modified);
    assert_eq!(modified.added, 3, "2X rewrite + two appended lines");
    assert_eq!(modified.deleted, 1);

    let added = detail.files.iter().find(|f| f.path == "new.txt").unwrap();
    assert_eq!(added.kind, eg_types::ChangeKind::Added);
    assert_eq!(added.added, 1);
    assert_eq!(added.deleted, 0);

    // Root commit diffs against an empty tree.
    let root_detail = log::commit_detail(&repo, &base.to_string()).unwrap();
    assert_eq!(root_detail.files.len(), 1);
    assert_eq!(root_detail.files[0].kind, eg_types::ChangeKind::Added);
    assert_eq!(root_detail.files[0].added, 3);
}

#[test]
fn list_branches_current_first() {
    let (_dir, repo) = init_repo();
    build_diamond(&repo);
    repo.set_head("refs/heads/feature").unwrap();

    let branches = log::list_branches(&repo).unwrap();
    // default branch is master here (init without init.defaultBranch).
    assert_eq!(branches[0], "feature");
    assert!(branches.contains(&"master".to_string()));
}

#[test]
fn empty_repo_returns_empty_page() {
    let (_dir, repo) = init_repo();
    let page = log::log_page(&repo, "r1", 0, 10, &LogFilter::default()).unwrap();
    assert!(page.entries.is_empty());
    assert!(page.next_offset.is_none());
    assert!(page.branch.is_none());
}

/// W5 exit criterion: a 500-row log page over the 5000-commit mid-size
/// fixture (plus the lane-heavy offset jump to page 10) must render-fast:
/// budget 1s per page, cold-cache tolerant. Requires
/// `scripts/fixtures/build-fixtures.sh mid-size`; run via `cargo test -- --ignored`.
#[test]
#[ignore = "needs .fixtures-dev/mid-size; measures the W5 performance budget"]
fn mid_size_log_page_is_fast() {
    let path = std::path::Path::new("../../../.fixtures-dev/mid-size");
    assert!(
        path.exists(),
        "run scripts/fixtures/build-fixtures.sh mid-size first"
    );
    let repo = Repository::open(path).unwrap();

    let started = Instant::now();
    let page = log::log_page(&repo, "r1", 0, 500, &LogFilter::default()).unwrap();
    assert_eq!(page.entries.len(), 500);
    let first = started.elapsed();

    let started = Instant::now();
    let page = log::log_page(&repo, "r1", 4500, 500, &LogFilter::default()).unwrap();
    let skipped = started.elapsed();
    assert!(!page.entries.is_empty());

    assert!(
        first.as_millis() < 1000,
        "first log page took {first:?} (budget 1s, cold-cache tolerant)"
    );
    assert!(
        skipped.as_millis() < 1000,
        "deep-offset log page took {skipped:?} (budget 1s, cold-cache tolerant)"
    );
}
