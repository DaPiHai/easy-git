//! W10 tests (m1-plan X-02): silent idle maintenance — `gc --auto` packs
//! loose objects, pack-refs compacts refs, eg-safety snapshot refs survive.

use std::path::Path;
use std::process::Command;

use eg_git_core::remote::GitCli;
use eg_safety::Safety;
use git2::{Oid, Repository, Signature, Time};
use tempfile::TempDir;

fn init_repo() -> (TempDir, Repository) {
    let dir = TempDir::new().expect("temp dir");
    let repo = Repository::init(dir.path()).expect("git init");
    repo.set_head("refs/heads/main").unwrap();
    let mut config = repo.config().unwrap();
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

fn loose_object_count(repo: &Repository) -> usize {
    let objects = repo.path().join("objects");
    let mut count = 0;
    for entry in std::fs::read_dir(&objects).expect("objects dir") {
        let name = entry.expect("entry").file_name();
        let name = name.to_string_lossy().into_owned();
        if name.len() == 2 && name.chars().all(|c| c.is_ascii_hexdigit()) {
            count += std::fs::read_dir(objects.join(&name))
                .expect("fan out")
                .count();
        }
    }
    count
}

fn pack_count(repo: &Repository) -> usize {
    let pack_dir = repo.path().join("objects").join("pack");
    std::fs::read_dir(&pack_dir)
        .map(|entries| entries.filter_map(|e| e.ok()).count())
        .unwrap_or(0)
}

#[test]
fn maintenance_packs_loose_objects_and_preserves_safety_refs() {
    let (dir, repo) = init_repo();
    let safety = Safety::for_tests(dir.path());
    // Low gc threshold so `gc --auto` definitely acts on this tiny repo.
    {
        let mut config = repo.config().unwrap();
        config.set_i32("gc.auto", 10).unwrap();
    }
    let mut base = commit_all(&repo, &[], "base", &[("a.txt", "0\n")]);
    for i in 1..=12 {
        base = commit_all(
            &repo,
            &[&base],
            &format!("c{i}"),
            &[("a.txt", &format!("{i}\n"))],
        );
    }
    // A discard-style snapshot (eg-safety backup ref) must survive gc.
    let paths = vec!["a.txt".to_string()];
    eg_git_core::ops::discard(&repo, "r1", &safety, &paths).expect("snapshot recorded");

    assert!(loose_object_count(&repo) > 10, "fixture should be loose");
    assert_eq!(pack_count(&repo), 0);

    GitCli::for_path(repo.workdir().unwrap())
        .maintenance()
        .expect("maintenance runs");

    assert!(pack_count(&repo) > 0, "gc --auto should create packs");
    let refs = git_out(repo.workdir().unwrap(), &["for-each-ref", "refs/"]);
    assert!(refs.contains("refs/heads/main"), "branch survives gc");
    assert!(
        refs.contains("refs/easy-git/"),
        "eg-safety snapshot refs survive gc"
    );
    // Repo still fully usable after maintenance.
    let head = git_out(repo.workdir().unwrap(), &["log", "--oneline", "-1"]);
    assert!(!head.is_empty());
}

#[test]
fn maintenance_is_noop_but_safe_on_clean_repo() {
    let (_dir, repo) = init_repo();
    let _base = commit_all(&repo, &[], "base", &[("a.txt", "1\n")]);
    GitCli::for_path(repo.workdir().unwrap())
        .maintenance()
        .expect("maintenance on clean repo");
    let head = git_out(repo.workdir().unwrap(), &["rev-parse", "HEAD"]);
    assert!(!head.is_empty());
}
