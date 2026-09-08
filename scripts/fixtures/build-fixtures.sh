#!/usr/bin/env bash
# Builds the acceptance fixture repositories (PRD 附录 B) under .fixtures/:
#   tiny-demo          10 commits, single branch (onboarding/demo)
#   feature-flow       multi-branch + merges + a resolved-conflict history;
#                      --conflicted additionally leaves feature-flow-conflicted
#                      mid-merge with unresolved conflicts (conflict wizard, W8)
#   mid-size           ~5000 commits, 50 branches (M1 performance baseline)
#   huge-repo          ~100k synthetic commits, opt-in via --huge (M3 baseline)
#
# Everything is deterministic (fixed authors, dates incrementing per commit)
# so test assertions stay stable across machines. huge-repo is synthesized
# locally instead of shallow-cloning the Linux kernel: no network needed and
# still satisfies the 10万+ 提交 shape (附录 B allows either).
#
# Usage: scripts/fixtures/build-fixtures.sh [--out DIR] [--huge] [--conflicted] [name...]
set -euo pipefail

OUT_DIR=".fixtures"
BUILD_HUGE=0
BUILD_CONFLICTED=0
WANT=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT_DIR="$2"; shift 2 ;;
    --huge) BUILD_HUGE=1; shift ;;
    --conflicted) BUILD_CONFLICTED=1; shift ;;
    -h|--help)
      sed -n '2,20p' "$0"; exit 0 ;;
    *) WANT+=("$1"); shift ;;
  esac
done
if [[ ${#WANT[@]} -eq 0 ]]; then
  WANT=(tiny-demo feature-flow mid-size)
  [[ $BUILD_HUGE -eq 1 ]] && WANT+=(huge-repo)
fi

mkdir -p "$OUT_DIR"
export GIT_AUTHOR_NAME="EasyGit Fixture"
export GIT_AUTHOR_EMAIL="fixture@easygit.invalid"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="fixture@easygit.invalid"
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
BASE_TS=1600000000

commit_file() { # repo path content message ts
  local repo="$1" path="$2" content="$3" msg="$4" ts="$5"
  mkdir -p "$(dirname "$repo/$path")"
  printf '%s\n' "$content" >"$repo/$path"
  git -C "$repo" add "$path"
  GIT_AUTHOR_DATE="@$((BASE_TS + ts)) +0000" \
    GIT_COMMITTER_DATE="@$((BASE_TS + ts)) +0000" \
    git -C "$repo" commit -q -m "$msg"
}

count_commits() { git -C "$1" rev-list --count "${2:-HEAD}"; }

verify() { # repo expected_commits label
  local repo="$1" expected="$2" label="$3"
  local n
  n=$(count_commits "$repo")
  if [[ "$n" -lt "$expected" ]]; then
    echo "FAIL: $label expected ≥ $expected commits, got $n" >&2
    exit 1
  fi
  printf '  %-28s %5s commits\n' "$label" "$n"
}

build_tiny_demo() {
  local repo="$OUT_DIR/tiny-demo"
  rm -rf "$repo"; git init -q -b main "$repo"
  local i
  for i in $(seq 1 10); do
    commit_file "$repo" "notes/step-$i.md" "step $i of the tiny demo" "tiny demo step $i" "$i"
  done
  verify "$repo" 10 "tiny-demo"
}

build_feature_flow() {
  local repo="$OUT_DIR/feature-flow"
  rm -rf "$repo"; git init -q -b main "$repo"

  commit_file "$repo" "README.md" "feature flow fixture" "init" 0
  commit_file "$repo" "src/base.txt" "base" "add base" 1
  git -C "$repo" tag v0.1.0

  # feature/login: two commits, no-ff merge back
  git -C "$repo" checkout -q -b feature/login
  commit_file "$repo" "src/login.txt" "login v1" "feat(login): form" 2
  commit_file "$repo" "src/login.txt" "login v2" "feat(login): remember me" 3
  git -C "$repo" checkout -q main
  GIT_AUTHOR_DATE="@$((BASE_TS + 4)) +0000" GIT_COMMITTER_DATE="@$((BASE_TS + 4)) +0000" \
    git -C "$repo" merge -q --no-ff feature/login -m "merge feature/login"

  # feature/shared: edits shared.txt one way
  git -C "$repo" checkout -q -b feature/shared
  commit_file "$repo" "src/shared.txt" "from feature/shared" "feat(shared): feature wording" 5

  # main edits shared.txt the other way, then merges -> real conflict, resolved
  git -C "$repo" checkout -q main
  commit_file "$repo" "src/shared.txt" "from main" "docs(shared): main wording" 6
  GIT_AUTHOR_DATE="@$((BASE_TS + 7)) +0000" GIT_COMMITTER_DATE="@$((BASE_TS + 7)) +0000" \
    git -C "$repo" merge --no-commit --no-ff feature/shared >/dev/null 2>&1 || true
  printf 'merged wording\n' >"$repo/src/shared.txt"
  git -C "$repo" add src/shared.txt
  GIT_AUTHOR_DATE="@$((BASE_TS + 8)) +0000" GIT_COMMITTER_DATE="@$((BASE_TS + 8)) +0000" \
    git -C "$repo" commit -q -m "merge feature/shared (conflict resolved)"

  # a stale branch for the branch board
  git -C "$repo" branch experiment/parked
  git -C "$repo" branch feature/drop-me
  verify "$repo" 8 "feature-flow"
}

build_feature_flow_conflicted() {
  # Leaves the repository mid-merge with unresolved conflicts.
  local repo="$OUT_DIR/feature-flow-conflicted"
  rm -rf "$repo"; git init -q -b main "$repo"
  commit_file "$repo" "src/plan.txt" "line: base" "init" 0
  git -C "$repo" checkout -q -b feature/plan
  commit_file "$repo" "src/plan.txt" "line: theirs" "feat(plan): theirs" 1
  git -C "$repo" checkout -q main
  commit_file "$repo" "src/plan.txt" "line: ours" "feat(plan): ours" 2
  git -C "$repo" merge --no-ff feature/plan >/dev/null 2>&1 || true
  if [[ ! -f "$repo/.git/MERGE_HEAD" ]]; then
    echo "FAIL: feature-flow-conflicted is not mid-merge" >&2
    exit 1
  fi
  printf '  %-28s   conflicted (mid-merge)\n' "feature-flow-conflicted"
}

build_mid_size() {
  local repo="$OUT_DIR/mid-size"
  rm -rf "$repo"; git init -q -b main "$repo"

  # Seed commit with a stable tree; perf runs only need DAG shape, so every
  # commit reuses the same tree (keeps generation to one process per commit).
  commit_file "$repo" "README.md" "mid-size fixture" "seed" 0
  local tree
  tree=$(git -C "$repo" rev-parse 'HEAD^{tree}')
  local parent main_parent
  parent=$(git -C "$repo" rev-parse HEAD)
  main_parent="$parent"

  # main: 4500 linear commits; every 90 commits a parked branch grows 10 of
  # its own commits. Totals: 1 + 4500 + 50*10 = 5001 commits, 50 branches.
  local i j ts msg oid branch_base branch_name
  for i in $(seq 1 4500); do
    ts=$((i * 60))
    msg=$(printf 'c%04d' "$i")
    GIT_AUTHOR_DATE="@$((BASE_TS + ts)) +0000" GIT_COMMITTER_DATE="@$((BASE_TS + ts)) +0000" \
      oid=$(git -C "$repo" commit-tree "$tree" -p "$main_parent" -m "$msg")
    main_parent="$oid"

    if [[ $((i % 90)) -eq 0 ]]; then
      branch_base="$main_parent"
      branch_name="branch/fork-$(printf '%03d' $((i / 90)))"
      for j in $(seq 1 10); do
        ts=$((ts + 1))
        GIT_AUTHOR_DATE="@$((BASE_TS + ts)) +0000" GIT_COMMITTER_DATE="@$((BASE_TS + ts)) +0000" \
          oid=$(git -C "$repo" commit-tree "$tree" -p "$branch_base" -m "${msg}-${j}")
        branch_base="$oid"
      done
      git -C "$repo" update-ref "refs/heads/$branch_name" "$branch_base"
    fi
  done
  git -C "$repo" update-ref refs/heads/main "$main_parent"

  local all_commits
  all_commits=$(git -C "$repo" rev-list --all --count)
  if [[ "$all_commits" -lt 5000 ]]; then
    echo "FAIL: mid-size expected ≥ 5000 total commits, got $all_commits" >&2
    exit 1
  fi
  printf '  %-28s %5s commits (all refs)\n' "mid-size" "$all_commits"
  local branches
  branches=$(git -C "$repo" branch --list | wc -l)
  if [[ "$branches" -lt 50 ]]; then
    echo "FAIL: mid-size expected ≥ 50 branches, got $branches" >&2
    exit 1
  fi
  printf '  %-28s %5s branches\n' "" "$branches"
}

build_huge_repo() {
  local repo="$OUT_DIR/huge-repo"
  rm -rf "$repo"; git init -q -b main "$repo"
  commit_file "$repo" "README.md" "huge repo fixture" "seed" 0
  local tree parent total=100000 i
  tree=$(git -C "$repo" rev-parse 'HEAD^{tree}')
  parent=$(git -C "$repo" rev-parse HEAD)
  for i in $(seq 1 "$total"); do
    GIT_AUTHOR_DATE="@$((BASE_TS + i)) +0000" GIT_COMMITTER_DATE="@$((BASE_TS + i)) +0000" \
      oid=$(git -C "$repo" commit-tree "$tree" -p "$parent" -m "c$i")
    parent="$oid"
  done
  git -C "$repo" update-ref refs/heads/main "$parent"
  verify "$repo" 100000 "huge-repo"
}

for name in "${WANT[@]}"; do
  case "$name" in
    tiny-demo) build_tiny_demo ;;
    feature-flow)
      build_feature_flow
      [[ $BUILD_CONFLICTED -eq 1 ]] && build_feature_flow_conflicted
      ;;
    feature-flow-conflicted) build_feature_flow_conflicted ;;
    mid-size) build_mid_size ;;
    huge-repo) build_huge_repo ;;
    *) echo "unknown fixture: $name" >&2; exit 1 ;;
  esac
done

echo "fixtures ready under $OUT_DIR"
