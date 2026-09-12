//! Remote operations (m1-plan R-22/R-24, W9). Network work runs through the
//! real `git` CLI (TDD §4 hybrid model): system credential helpers, SSH agent
//! and proxy config all behave exactly like the command line, and `--progress`
//! output feeds the sync task strip. Local-only remote CRUD uses libgit2.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;
use std::time::Duration;

use eg_types::{EgError, PushCredentials, RemoteInfo, SyncStrategy};
use git2::Repository;

/// Wall-clock budgets for CLI commands (PRD §4.2 timeout handling). Big
/// fetches are legitimate, so long-running ops get a generous ceiling; only
/// a wedged process (e.g. a stalled network) ever hits it.
const CLI_TIMEOUT_QUICK: Duration = Duration::from_secs(45);
const CLI_TIMEOUT_NETWORK: Duration = Duration::from_secs(300);
const CLI_TIMEOUT_CLONE: Duration = Duration::from_secs(600);
const CLI_TIMEOUT_LOCAL: Duration = Duration::from_secs(900);

/// Per-call authentication for one CLI invocation. `None` keeps the ambient
/// behavior (system credential helpers / SSH agent, TDD R-23 default).
#[derive(Debug, Clone, Default)]
pub struct CliAuth {
    pub credentials: Option<PushCredentials>,
}

/// Writes an ephemeral askpass helper answering from `creds` and returns its
/// path. The caller must delete the file after the child exits; its lifetime
/// is one `git push` at most. Permissions are owner-only (0600 on Unix).
/// Each call gets a unique directory so concurrent pushes (and parallel
/// tests) in one process never share a script path.
fn write_askpass_script(creds: &PushCredentials) -> Result<PathBuf, EgError> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "easy-git-askpass-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        SEQ.fetch_add(1, Ordering::Relaxed),
    ));
    std::fs::create_dir_all(&dir).map_err(|e| EgError::Internal {
        context: format!("askpass temp dir failed: {e}"),
    })?;
    #[cfg(windows)]
    let (path, body) = {
        let path = dir.join("askpass.bat");
        // git prompts are `Username for '…': ` / `Password for '…': `. Match
        // the leading word only: the password prompt embeds the username in
        // the URL (`Password for 'http://user@host': `), so a substring
        // "user" match would answer the username twice.
        let body = format!(
            "@echo off\r\necho %~1 | findstr /I /B /C:\"Username\" >nul\r\nif %errorlevel%==0 (\r\n  echo {username}\r\n) else (\r\n  echo {password}\r\n)\r\n",
            username = creds.username,
            password = creds.password,
        );
        (path, body)
    };
    #[cfg(not(windows))]
    let (path, body) = {
        let path = dir.join("askpass.sh");
        let body = format!(
            "#!/bin/sh\ncase \"$1\" in\n[Uu]sername*) printf '%s' '{username}';;\n*) printf '%s' '{password}';;\nesac\n",
            username = creds.username.replace('\'', "'\\''"),
            password = creds.password.replace('\'', "'\\''"),
        );
        (path, body)
    };
    std::fs::write(&path, body).map_err(|e| EgError::Internal {
        context: format!("askpass script write failed: {e}"),
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|e| {
            EgError::Internal {
                context: format!("askpass script chmod failed: {e}"),
            }
        })?;
    }
    Ok(path)
}

/// Removes the ephemeral helper and its parent temp dir (best-effort: the
/// secret must not outlive the push even if cleanup is partial).
fn remove_askpass_script(path: &Path) {
    let _ = std::fs::remove_file(path);
    if let Some(dir) = path.parent() {
        let _ = std::fs::remove_dir(dir);
    }
}

/// Progress events streamed to the sync task strip (F-27). `percent` is 0-100
/// when the CLI line carried one, otherwise None (message-only update).
#[derive(Debug, Clone)]
pub struct SyncProgress {
    pub message: String,
    pub percent: Option<u32>,
}

fn err(context: &'static str) -> impl Fn(git2::Error) -> EgError {
    move |e| EgError::Internal {
        context: format!("remote {context} failed: {e}"),
    }
}

/// All remotes with their fetch URLs, in `git remote` order (R-24).
pub fn remote_list(repo: &Repository) -> Result<Vec<RemoteInfo>, EgError> {
    let mut out = Vec::new();
    let names = repo.remotes().map_err(err("list"))?;
    for name in names.iter().filter_map(|r| r.ok().flatten()) {
        let remote = repo.find_remote(name).map_err(err("find"))?;
        out.push(RemoteInfo {
            name: name.to_string(),
            url: remote.url().unwrap_or_default().to_string(),
            push_url: remote.pushurl().ok().flatten().map(str::to_string),
        });
    }
    Ok(out)
}

pub fn remote_add(repo: &Repository, name: &str, url: &str) -> Result<(), EgError> {
    let name = name.trim();
    if name.is_empty() || url.trim().is_empty() {
        return Err(EgError::Internal {
            context: "remote name / url is empty".into(),
        });
    }
    if repo.find_remote(name).is_ok() {
        return Err(EgError::Internal {
            context: format!("remote {name} already exists"),
        });
    }
    repo.remote(name, url).map_err(err("add"))?;
    Ok(())
}

pub fn remote_rename(
    repo: &Repository,
    old_name: &str,
    new_name: &str,
) -> Result<Vec<String>, EgError> {
    let problems = repo
        .remote_rename(old_name, new_name)
        .map_err(err("rename"))?;
    Ok(problems
        .iter()
        .filter_map(|r| r.ok().flatten().map(str::to_string))
        .collect())
}

pub fn remote_set_url(repo: &Repository, name: &str, url: &str) -> Result<(), EgError> {
    repo.remote_set_url(name, url).map_err(err("set url"))
}

pub fn remote_remove(repo: &Repository, name: &str) -> Result<(), EgError> {
    repo.remote_delete(name).map_err(err("delete"))
}

/// Git CLI inside the repository workdir (network ops + plumbing hybrid).
pub struct GitCli {
    workdir: PathBuf,
}

impl GitCli {
    pub fn new(repo: &Repository) -> Result<Self, EgError> {
        let workdir = repo
            .workdir()
            .ok_or_else(|| EgError::NotSupported {
                feature: "bare repository remote operations".into(),
            })?
            .to_path_buf();
        Ok(Self { workdir })
    }

    pub fn for_path(path: &Path) -> Self {
        Self {
            workdir: path.to_path_buf(),
        }
    }

    /// Returns (stderr+stdout text, success flag). A wedged git process is
    /// killed after `timeout` (PRD §4.2: all CLI calls get timeout handling)
    /// so the sync buttons can never stay greyed forever.
    ///
    /// Authentication: `auth` carries one-shot HTTPS credentials for push to
    /// legacy servers (None = ambient system helpers, unchanged). With
    /// credentials, an ephemeral askpass helper answers git's prompts and is
    /// deleted when the child exits. `GIT_TERMINAL_PROMPT=0` + null stdin on
    /// every call means a missing credential fails fast instead of hanging
    /// until the timeout (TDD §4.2 bridge contract).
    fn run(
        &self,
        args: &[&str],
        on_progress: Option<&Sender<SyncProgress>>,
        timeout: Duration,
        auth: &CliAuth,
    ) -> Result<(String, bool), EgError> {
        // Owns the ephemeral askpass script; Drop deletes it so the secret
        // never outlives the child even on early return.
        struct AskpassGuard {
            path: Option<PathBuf>,
        }
        impl Drop for AskpassGuard {
            fn drop(&mut self) {
                if let Some(path) = self.path.take() {
                    remove_askpass_script(&path);
                }
            }
        }

        let mut guard = AskpassGuard { path: None };
        let mut child = crate::process::hidden_command("git");
        child
            .arg("-C")
            .arg(&self.workdir)
            .args(args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .stdin(std::process::Stdio::null())
            .env("GIT_TERMINAL_PROMPT", "0");
        if let Some(creds) = auth.credentials.as_ref().filter(|c| {
            // Empty credentials are ambient: don't install a helper that
            // would answer prompts with empty strings.
            !c.username.is_empty() || !c.password.is_empty()
        }) {
            let path = write_askpass_script(creds)?;
            child.env("GIT_ASKPASS", &path);
            guard.path = Some(path);
        }
        let mut child = child
            .spawn()
            .map_err(|e| crate::process::classify_spawn_error("git", &e))?;

        // git writes progress to stderr; --progress forces it even when not
        // attached to a tty. Stream it to the task strip while collecting.
        let stderr = child.stderr.take();
        let reader = stderr.map(|s| {
            let tx = on_progress.cloned();
            std::thread::spawn(move || {
                let mut collected = String::new();
                for line in BufReader::new(s).lines().map_while(Result::ok) {
                    collected.push_str(&line);
                    collected.push('\n');
                    if let Some(tx) = &tx {
                        let _ = tx.send(parse_progress(&line));
                    }
                }
                collected
            })
        });

        let started = std::time::Instant::now();
        tracing::debug!(
            command = %eg_types::sensitive::redact_text(&args.join(" ")),
            "git command started"
        );
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {
                    if started.elapsed() >= timeout {
                        let _ = child.kill();
                        let _ = child.wait();
                        let text = reader
                            .map(|h| h.join().unwrap_or_default())
                            .unwrap_or_default();
                        tracing::error!(
                            command = %eg_types::sensitive::redact_text(&args.join(" ")),
                            timeout_secs = timeout.as_secs(),
                            "git command timed out and was killed"
                        );
                        return Err(EgError::Internal {
                            context: format!(
                                "git {} timed out (exceeded {} seconds), the process has been terminated\n{text}",
                                args.join(" "),
                                timeout.as_secs()
                            ),
                        });
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    return Err(EgError::Internal {
                        context: format!("git wait failed: {e}"),
                    })
                }
            }
        };
        let output = child.wait_with_output().map_err(|e| EgError::Internal {
            context: format!("git wait failed: {e}"),
        })?;
        let mut text = reader
            .map(|h| h.join().unwrap_or_default())
            .unwrap_or_default();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if let Some(tx) = on_progress {
                let _ = tx.send(SyncProgress {
                    message: line.to_string(),
                    percent: None,
                });
            }
            text.push_str(line);
            text.push('\n');
        }
        let elapsed_ms = started.elapsed().as_millis() as u64;
        if status.success() {
            tracing::debug!(command = %args.first().unwrap_or(&"git"), elapsed_ms, "git command finished");
        } else {
            tracing::warn!(
                command = %eg_types::sensitive::redact_text(&args.join(" ")),
                elapsed_ms,
                tail = %stderr_tail(&text, 3),
                "git command exited with failure"
            );
        }
        Ok((text, status.success()))
    }

    /// Runs a network command, humanizing auth/network failures (TDD §6).
    fn run_network(
        &self,
        args: &[&str],
        on_progress: Option<&Sender<SyncProgress>>,
        timeout: Duration,
        auth: &CliAuth,
    ) -> Result<(), EgError> {
        let (stderr, ok) = self.run(args, on_progress, timeout, auth)?;
        if ok {
            return Ok(());
        }
        Err(humanize_network(&stderr))
    }

    /// Silent idle maintenance (PRD §5.11): full inline `git gc --quiet`
    /// (covers repack, prune and pack-refs). `--auto`'s sampled threshold
    /// proved unreliable on git 2.53, and on an already-packed repo gc is a
    /// cheap no-op. Inline (no detach) so the worker never races itself.
    pub fn maintenance(&self) -> Result<(), EgError> {
        let (text, ok) = self.run(
            &["-c", "gc.autoDetach=false", "gc", "--quiet"],
            None,
            CLI_TIMEOUT_LOCAL,
            &CliAuth::default(),
        )?;
        if !ok {
            return Err(EgError::Internal {
                context: format!("git gc failed: {text}"),
            });
        }
        Ok(())
    }

    /// `git ls-remote` — the connectivity test (R-24). Returns remote refs.
    pub fn ls_remote(
        &self,
        remote: &str,
        on_progress: Option<&Sender<SyncProgress>>,
    ) -> Result<Vec<(String, String)>, EgError> {
        let (stderr, ok) = self.run(
            &["ls-remote", remote],
            on_progress,
            CLI_TIMEOUT_QUICK,
            &CliAuth::default(),
        )?;
        if !ok {
            return Err(humanize_network(&stderr));
        }
        let mut out = Vec::new();
        for line in stderr.lines() {
            let mut parts = line.split_whitespace();
            if let (Some(oid), Some(name)) = (parts.next(), parts.next()) {
                out.push((oid.to_string(), name.to_string()));
            }
        }
        Ok(out)
    }

    /// `git fetch [--prune] [--depth N] <remote>` (R-22).
    pub fn fetch(
        &self,
        remote: &str,
        prune: bool,
        depth: Option<u32>,
        on_progress: Option<&Sender<SyncProgress>>,
    ) -> Result<(), EgError> {
        let mut args = vec!["fetch".to_string(), "--progress".to_string()];
        if prune {
            args.push("--prune".to_string());
        }
        if let Some(d) = depth {
            args.push("--depth".to_string());
            args.push(d.to_string());
        }
        args.push(remote.to_string());
        let argrefs: Vec<&str> = args.iter().map(String::as_str).collect();
        self.run_network(
            &argrefs,
            on_progress,
            CLI_TIMEOUT_NETWORK,
            &CliAuth::default(),
        )
    }

    /// `git push [--force] [-u] <remote> <branch>` (R-22). `--tags` pushes
    /// lightweight+annotated tags along, like real git.
    ///
    /// `credentials` enables the one-shot HTTPS askpass fallback for legacy
    /// servers; None keeps ambient system helpers. The secret is never part
    /// of argv, logs or progress messages.
    pub fn push(
        &self,
        remote: &str,
        branch: &str,
        force: bool,
        set_upstream: bool,
        on_progress: Option<&Sender<SyncProgress>>,
        credentials: Option<&PushCredentials>,
    ) -> Result<(), EgError> {
        let mut args = vec!["push".to_string(), "--progress".to_string()];
        if force {
            args.push("--force-with-lease".to_string());
        }
        if set_upstream {
            args.push("-u".to_string());
        }
        args.push(remote.to_string());
        args.push(format!("{branch}:{branch}"));
        let argrefs: Vec<&str> = args.iter().map(String::as_str).collect();
        self.run_network(
            &argrefs,
            on_progress,
            CLI_TIMEOUT_NETWORK,
            &CliAuth {
                credentials: credentials.cloned(),
            },
        )
    }

    /// `git clone --progress <url> <path>` (W2 顺延 F-06 clone 入口).
    pub fn clone(
        &self,
        url: &str,
        path: &Path,
        on_progress: Option<&Sender<SyncProgress>>,
    ) -> Result<(), EgError> {
        let not_empty = path.exists()
            && std::fs::read_dir(path)
                .map(|mut d| d.next().is_some())
                .unwrap_or(false);
        if not_empty {
            return Err(EgError::Internal {
                context: format!("target directory is not empty: {}", path.display()),
            });
        }
        let parent = path.parent().unwrap_or(Path::new("."));
        let child_args = [
            "-C".to_string(),
            parent.display().to_string(),
            "clone".to_string(),
            "--progress".to_string(),
            url.to_string(),
            path.display().to_string(),
        ];
        let argrefs: Vec<&str> = child_args.iter().map(String::as_str).collect();
        let (stderr, ok) = self.run(
            &argrefs,
            on_progress,
            CLI_TIMEOUT_CLONE,
            &CliAuth::default(),
        )?;
        if Repository::open(path).is_ok() && ok {
            Ok(())
        } else {
            Err(humanize_network(&stderr))
        }
    }

    /// Restores a remote ref by force-pushing an explicit oid (强推可回滚,
    /// undo of ForcePush records).
    pub fn push_restore(&self, remote: &str, oid: &str, remote_ref: &str) -> Result<(), EgError> {
        let args = [
            "push".to_string(),
            "--progress".to_string(),
            "--force".to_string(),
            remote.to_string(),
            format!("{oid}:{remote_ref}"),
        ];
        let argrefs: Vec<&str> = args.iter().map(String::as_str).collect();
        self.run_network(&argrefs, None, CLI_TIMEOUT_NETWORK, &CliAuth::default())
    }
}

/// Maps the last CLI stderr lines onto the EgError taxonomy (TDD §6).
fn humanize_network(stderr: &str) -> EgError {
    let tail: String = stderr
        .lines()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    tracing::error!(
        tail = %eg_types::sensitive::redact_text(&tail),
        "network command failed"
    );
    let lower = stderr.to_lowercase();
    if lower.contains("authentication")
        || lower.contains("403")
        || lower.contains("permission denied")
    {
        return EgError::Auth {
            provider: "git".into(),
        };
    }
    if lower.contains("could not resolve host")
        || lower.contains("connection refused")
        || lower.contains("timed out")
        || lower.contains("failed to connect")
    {
        return EgError::Network {
            kind: "connect".into(),
            url: String::new(),
        };
    }
    if lower.contains("rejected") && lower.contains("fetch first") {
        return EgError::ConflictState {
            state: "远端有本地没有的新提交（先获取）".into(),
        };
    }
    if lower.contains("non-fast-forward") {
        return EgError::ConflictState {
            state: "远端被本地之外的提交更新过（需要先获取整合）".into(),
        };
    }
    EgError::Internal {
        context: format!("network command failed: {tail}"),
    }
}

/// Last `n` lines joined for a compact single-line log entry, credentials
/// redacted (TDD §7).
fn stderr_tail(text: &str, n: usize) -> String {
    eg_types::sensitive::redact_text(
        &text
            .lines()
            .rev()
            .take(n)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" | "),
    )
}

/// Extracts "Receiving objects: 45% (90/200)" style percentages for the strip.
fn parse_progress(line: &str) -> SyncProgress {
    let percent = line.split(':').nth(1).and_then(|rest| {
        rest.split_whitespace().next().and_then(|tok| {
            tok.strip_suffix('%')
                .and_then(|num| num.parse::<u32>().ok())
        })
    });
    SyncProgress {
        message: line.chars().take(120).collect(),
        percent: percent.filter(|p| (0..=100).contains(p)),
    }
}

/// Pull integrate (R-22/F-27): after the CLI fetch, integrate the upstream
/// with the W8 merge machinery so conflicts land in the wizard. FF-only uses
/// the fast-forward path; Merge parks conflicts like a normal merge.
pub fn pull_integrate(
    repo: &mut Repository,
    repo_id: &str,
    remote: &str,
    branch: &str,
    strategy: SyncStrategy,
) -> Result<eg_types::MergeOutcome, EgError> {
    let upstream_ref = format!("refs/remotes/{remote}/{branch}");
    let upstream_name = format!("{remote}/{branch}");
    match strategy {
        SyncStrategy::FfOnly => {
            // FF or nothing: refuse when diverged, mirroring `git pull --ff-only`.
            let head = repo
                .head()
                .and_then(|h| h.peel_to_commit())
                .map(|c| c.id())
                .map_err(err("head"))?;
            let upstream_tip = repo
                .find_reference(&upstream_ref)
                .and_then(|r| r.peel_to_commit())
                .map(|c| c.id())
                .map_err(err("upstream ref"))?;
            let (ahead, behind) = repo
                .graph_ahead_behind(head, upstream_tip)
                .map_err(err("ahead behind"))?;
            if ahead == 0 && behind == 0 {
                return Ok(eg_types::MergeOutcome {
                    fast_forwarded: false,
                    conflicts: Vec::new(),
                    status: crate::status::status(repo_id, repo)?,
                });
            }
            if ahead > 0 && behind > 0 {
                return Err(EgError::ConflictState {
                    state: format!("本地与 {upstream_name} 出现分叉（ahead {ahead} / behind {behind}），请选择合并"),
                });
            }
            if ahead > 0 {
                return Ok(eg_types::MergeOutcome {
                    fast_forwarded: false,
                    conflicts: Vec::new(),
                    status: crate::status::status(repo_id, repo)?,
                });
            }
            crate::merge::merge_start(repo, repo_id, &upstream_name, false)
        }
        SyncStrategy::Merge => crate::merge::merge_start(repo, repo_id, &upstream_name, false),
    }
}

/// High-level entry points for the IPC layer: everything git-related stays
/// inside eg-git-core (TDD §3), the app crate only passes ids and handles.
fn open_repo(path: &Path) -> Result<Repository, EgError> {
    Repository::open(path).map_err(|e| EgError::RepoNotFound {
        path: format!("{} ({e})", path.display()),
    })
}

/// Records the pre-push remote tip and force-pushes (强推可回滚, R-22).
/// `credentials` is the one-shot HTTPS fallback for legacy servers; the
/// force-push pre-check fetch/ls-remote reuses it within this same push.
#[allow(clippy::too_many_arguments)]
pub fn push_with_rollback(
    path: &Path,
    repo_id: &str,
    remote: &str,
    branch: &str,
    force: bool,
    safety: &eg_safety::Safety,
    on_progress: Option<&Sender<SyncProgress>>,
    credentials: Option<&PushCredentials>,
) -> Result<(), EgError> {
    let repo = open_repo(path)?;
    let cli = GitCli::new(&repo)?;
    let old_tip = if force {
        // A fresh remote-tracking ref keeps --force-with-lease's baseline
        // current (a stale one fails with "stale info").
        cli.fetch(remote, false, None, None)?;
        cli.ls_remote(remote, None)?
            .into_iter()
            .find(|(_, name)| name == &format!("refs/heads/{branch}"))
            .map(|(oid, _)| oid)
    } else {
        None
    };
    cli.push(remote, branch, force, true, on_progress, credentials)?;
    if let Some(old) = old_tip {
        let branch_tip = repo
            .find_branch(branch, git2::BranchType::Local)
            .and_then(|b| b.get().peel_to_commit())
            .map(|c| c.id().to_string())
            .unwrap_or_default();
        safety.record(
            repo_id,
            &eg_safety::OpRecord {
                op_id: uuid::Uuid::new_v4().to_string(),
                time: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
                kind: eg_safety::OpKind::ForcePush,
                paths: vec![branch.to_string(), old, remote.to_string()],
                snapshot_ref: None,
                target: Some(branch_tip),
                undone: false,
            },
        )?;
    }
    Ok(())
}

/// Fetch with progress (R-22); returns nothing — the caller refreshes status.
pub fn fetch_at(
    path: &Path,
    remote: &str,
    prune: bool,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<(), EgError> {
    let repo = open_repo(path)?;
    GitCli::new(&repo)?.fetch(remote, prune, None, on_progress)
}

/// Connectivity test (R-24): number of refs on the remote.
pub fn test_remote(
    path: &Path,
    remote: &str,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<u32, EgError> {
    let repo = open_repo(path)?;
    GitCli::new(&repo)?
        .ls_remote(remote, on_progress)
        .map(|refs| refs.len() as u32)
}

/// Clone (W2 顺延 + R-22).
pub fn clone_repo(
    url: &str,
    path: &Path,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<(), EgError> {
    GitCli::for_path(Path::new(".")).clone(url, path, on_progress)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_creds() -> PushCredentials {
        PushCredentials {
            username: "老用户".into(),
            password: "s3cret!".into(),
        }
    }

    #[test]
    fn askpass_script_contains_credentials_and_is_removed_after_use() {
        let path = write_askpass_script(&test_creds()).expect("write script");
        assert!(path.is_file());
        let body = std::fs::read_to_string(&path).expect("read script");
        assert!(body.contains("老用户"), "helper must answer the username");
        assert!(body.contains("s3cret!"), "helper must answer the password");

        remove_askpass_script(&path);
        assert!(!path.exists(), "secret must not outlive the push");
    }

    #[test]
    fn askpass_script_routes_username_and_password_prompts() {
        let body = std::fs::read_to_string(write_askpass_script(&test_creds()).unwrap()).unwrap();
        // Both branches reference both secrets; the helper dispatches on the
        // prompt text at runtime (Username… vs Password…). Matching must
        // anchor on the leading `Username`: the password prompt embeds the
        // username in the URL (`Password for 'http://user@host': `), so a
        // "user" substring match would answer the username twice.
        assert!(body.contains("老用户"));
        assert!(body.contains("s3cret!"));
        #[cfg(windows)]
        assert!(
            body.contains("/B"),
            "windows helper must match Username at the start of the prompt"
        );
        #[cfg(not(windows))]
        assert!(
            body.contains("[Uu]sername*)"),
            "shell helper must match Username at the start of the prompt"
        );
    }

    #[test]
    fn askpass_script_is_owner_only_on_unix() {
        let path = write_askpass_script(&test_creds()).expect("write script");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(
                mode, 0o600,
                "the secret file must not be group/world readable"
            );
        }
        remove_askpass_script(&path);
    }
}
