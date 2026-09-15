//! SSH transport for remote-host repositories (feat/ssh-remote-manage).
//!
//! Repositories on a server without a desktop run their git commands through
//! the system `ssh` client spawned via [`crate::process::hidden_command`]
//! (same ambient model as `GitCli`: the system SSH agent, `~/.ssh/config`
//! and key files behave exactly like the command line; EasyGit never touches
//! private key material). No new Tauri capability is needed: everything runs
//! in Rust child processes, never through Tauri frontend plugins.
//!
//! Security posture:
//! - Only commands on [`ALLOWED_GIT`] (plus a few read-only shell probes)
//!   ever cross the wire. There is no interactive shell: stdin is always
//!   null and `BatchMode=yes` turns any prompt (password, host-key
//!   confirmation, passphrase) into a fast, classifiable failure instead of
//!   a hang.
//! - Host-key verification is never silently disabled. Unknown keys fail
//!   closed and surface as actionable errors; changed keys surface as a
//!   dedicated MITM warning, never an auto-accepted connection.
//! - Secrets never enter argv or logs: remote paths ride in the single
//!   remote-shell command string (not separate argv words), and everything
//!   logged passes through `sensitive::redact_text`.

use std::io::{BufRead, BufReader};
use std::sync::mpsc::Sender;
use std::time::Duration;

use eg_types::{
    EgError, SshAgentStatus, SshCredentialsOverview, SshKeyInfo, SshPublicKey, SshTarget,
};

use super::remote::SyncProgress;
pub(crate) use super::remote::{CLI_TIMEOUT_NETWORK, CLI_TIMEOUT_QUICK};

/// `git` subcommands allowed over the SSH channel. Read-only inspection first,
/// then the safe write set (commit/fetch/pull/push/branch/stash). Anything
/// destructive at the ref level (reset --hard, push --force, branch -D, clean
/// -fd, checkout -- .) is intentionally absent: remote destructive writes are
/// disabled by policy (see `is_destructive_remote_op` in the worker layer).
const ALLOWED_GIT: &[&str] = &[
    // Read-only inspection.
    "status",
    "log",
    "diff",
    "show",
    "rev-parse",
    "rev-list",
    "ls-remote",
    "ls-files",
    "branch",
    "tag",
    "stash",
    "remote",
    "config",
    "describe",
    "name-rev",
    "merge-base",
    "check-ignore",
    "count-objects",
    "fsck",
    "var",
    "for-each-ref",
    "reflog",
    "--version",
    // Safe writes: committing, staging, stashing, syncing, non-forced refs,
    // guarded reverts. Anything history-rewriting or deleting stays out.
    "add",
    "restore",
    "commit",
    "fetch",
    "pull",
    "push",
    "merge",
    "rebase",
    "apply",
    "checkout",
    "switch",
    "clean",
    "gc",
    "rm",
    "reset",
    "revert",
    // Bootstrap a fresh repository on a host that doesn't have one yet
    // (the wizard's "initialize here" recovery flow); safe in itself — no
    // existing history can be touched, and the path's existence is checked
    // before this is offered.
    "init",
];

/// Read-only shell probes allowed outside `git -C` (connectivity, directory
/// checks, file reads for conflict inspection).
const ALLOWED_PROBE: &[&str] = &["echo", "test", "ls", "cat"];

/// True when `args` (a `git` invocation's subcommand list) is allowed over
/// the SSH channel. The first token selects the subcommand; global `-c`
/// options before it are skipped.
///
/// Beyond the subcommand allowlist this also refuses the destructive flag
/// variants defense-in-depth (remote destructive writes are disabled by
/// policy; the worker layer rejects them first, the transport never lets
/// them through even if a caller slips past):
/// - `--force` anywhere (`push --force`, ref restores),
/// - `reset` except the index-only unstage form (`reset HEAD -- paths`
///   / `reset -q HEAD -- paths`; `--hard/--soft/--mixed` all refused),
/// - `rm` except `rm --cached` (unstage fallback on unborn HEAD),
/// - `revert` only with `--no-commit` (working-tree revert, committed via
///   the normal commit flow),
/// - `branch -D`,
/// - `clean` that really deletes (`-f` without a `-n` dry run).
pub fn is_allowed_git_args(args: &[&str]) -> bool {
    let mut tokens = args.iter().peekable();
    // Skip leading `-c key=value` pairs and other global flags before the
    // subcommand (mirrors how GitCli builds `git -c … <subcommand>`).
    while let Some(tok) = tokens.peek() {
        if **tok == "-c" {
            tokens.next();
            tokens.next();
        } else if tok.starts_with('-') {
            tokens.next();
        } else {
            break;
        }
    }
    let sub = match tokens.next() {
        Some(sub) => *sub,
        None => return false,
    };
    if !ALLOWED_GIT.contains(&sub) {
        return false;
    }
    if args.contains(&"--force") {
        return false;
    }
    match sub {
        // Index-only unstage: `reset [flags] HEAD -- paths`. Any mode flag
        // (--hard/--soft/--mixed), a non-HEAD commit, or a missing `--`
        // separator is refused.
        "reset" => {
            if args.contains(&"--hard") || args.contains(&"--soft") || args.contains(&"--mixed") {
                return false;
            }
            match args.iter().position(|&a| a == "--") {
                Some(sep) => args[..sep].contains(&"HEAD"),
                None => false,
            }
        }
        // Only the unstage fallback (`rm --cached -r -- paths`).
        "rm" => args.contains(&"--cached"),
        // Only working-tree reverts staged through the commit flow.
        "revert" => args.contains(&"--no-commit"),
        "branch" => !args.contains(&"-D"),
        // A real `clean` delete is `-f`, possibly clustered (`-fd`, `-fdx`);
        // dry runs (`-n` / `--dry-run`) stay available for previews.
        "clean" => {
            !has_short_flag(args, 'f') || args.contains(&"-n") || args.contains(&"--dry-run")
        }
        _ => true,
    }
}

/// True when any single-dash cluster arg (e.g. `-fd`) contains `flag`.
/// Double-dash long options are ignored (handled separately above).
fn has_short_flag(args: &[&str], flag: char) -> bool {
    args.iter()
        .any(|a| a.starts_with('-') && !a.starts_with("--") && a.chars().skip(1).any(|c| c == flag))
}

/// Executes one remote command over SSH and collects its output.
///
/// The contract mirrors `GitCli::run`: `(combined stdout+stderr text,
/// success flag)`. Progress lines stream to `on_progress` as message-only
/// updates (remote git rarely carries `--progress` percentages through the
/// extra hop; fetch/push keep their own `--progress` parsing via
/// [`parse_ssh_progress`]).
pub fn ssh_run(
    target: &SshTarget,
    remote_cmd: &str,
    on_progress: Option<&Sender<SyncProgress>>,
    timeout: Duration,
) -> Result<(String, bool), EgError> {
    let mut child = crate::process::hidden_command("ssh");
    child
        .arg("-p")
        .arg(target.port.to_string())
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg(format!("ConnectTimeout={}", CONNECT_TIMEOUT_SECS))
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg(target.destination())
        .arg(remote_cmd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0");
    let mut child = child.spawn().map_err(|e| classify_ssh_spawn_error(&e))?;

    let stderr = child.stderr.take();
    let reader = stderr.map(|s| {
        let tx = on_progress.cloned();
        std::thread::spawn(move || {
            let mut collected = String::new();
            for line in BufReader::new(s).lines().map_while(Result::ok) {
                collected.push_str(&line);
                collected.push('\n');
                if let Some(tx) = &tx {
                    let _ = tx.send(parse_ssh_progress(&line));
                }
            }
            collected
        })
    });

    let started = std::time::Instant::now();
    tracing::debug!(
        host = %target.host,
        "ssh command started"
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
                        host = %target.host,
                        timeout_secs = timeout.as_secs(),
                        "ssh command timed out and was killed"
                    );
                    return Err(EgError::Internal {
                        context: format!(
                            "ssh {} timed out (exceeded {} seconds), the process has been terminated\n{text}",
                            target.host,
                            timeout.as_secs()
                        ),
                    });
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                return Err(EgError::Internal {
                    context: format!("ssh wait failed: {e}"),
                })
            }
        }
    };
    let output = child.wait_with_output().map_err(|e| EgError::Internal {
        context: format!("ssh wait failed: {e}"),
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
    if !status.success() {
        tracing::warn!(
            host = %target.host,
            tail = %eg_types::sensitive::redact_text(
                &text.lines().rev().take(3).collect::<Vec<_>>().join(" | ")
            ),
            "ssh command exited with failure"
        );
    }
    Ok((text, status.success()))
}

/// Quick connectivity probe: `echo ok` over the channel. Fails fast on
/// unknown hosts, missing keys or unreachable networks instead of waiting
/// for a git-level timeout.
pub fn test_connection(
    target: &SshTarget,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<(), EgError> {
    let (text, ok) = ssh_run(target, "echo easy-git-ok", on_progress, CLI_TIMEOUT_QUICK)?;
    if ok && text.contains("easy-git-ok") {
        Ok(())
    } else {
        Err(humanize_ssh(&text, &target.uri(), target))
    }
}

/// Lists directory entries on the host (for the open-wizard remote browser).
/// Output is one path per line; symlinks are resolved.
pub fn browse_dir(
    target: &SshTarget,
    dir: &str,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<Vec<String>, EgError> {
    if !is_allowed_probe_dir(dir) {
        return Err(EgError::Internal {
            context: "remote browse path is not absolute or home-relative".into(),
        });
    }
    let probe = format!(
        "test -d {} && ls -a -p {} 2>/dev/null || echo __EASYGIT_NOT_A_DIR__",
        shell_quote(dir),
        shell_quote(dir)
    );
    let (text, ok) = ssh_run(target, &probe, on_progress, CLI_TIMEOUT_QUICK)?;
    if !ok {
        return Err(humanize_ssh(&text, &target.uri(), target));
    }
    if text.contains("__EASYGIT_NOT_A_DIR__") {
        return Err(EgError::RepoNotFound {
            path: format!("{}:{}", target.uri(), dir),
            detail: None,
        });
    }
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && *l != "./" && *l != "../")
        .map(str::to_string)
        .collect())
}

/// `git -C <path> rev-parse` triple used by `repo_open` validation on SSH
/// targets: toplevel, absolute git dir, and HEAD validity.
pub fn probe_repo(
    target: &SshTarget,
    on_progress: Option<&Sender<SyncProgress>>,
) -> Result<(String, String), EgError> {
    let cmd = git_cmd(&target.path, &["rev-parse", "--show-toplevel"]);
    let (text, ok) = ssh_run(target, &cmd, on_progress, CLI_TIMEOUT_QUICK)?;
    if !ok {
        return Err(humanize_ssh(&text, &target.uri(), target));
    }
    let toplevel = text.lines().next().unwrap_or_default().trim().to_string();
    let cmd = git_cmd(&target.path, &["rev-parse", "--absolute-git-dir"]);
    let (text, ok) = ssh_run(target, &cmd, on_progress, CLI_TIMEOUT_QUICK)?;
    if !ok {
        return Err(humanize_ssh(&text, &target.uri(), target));
    }
    let git_dir = text.lines().next().unwrap_or_default().trim().to_string();
    if toplevel.is_empty() || git_dir.is_empty() {
        return Err(EgError::RepoNotFound {
            path: target.uri(),
            detail: None,
        });
    }
    Ok((toplevel, git_dir))
}

/// Builds the remote-shell command string for `git -C <path> <args>`.
/// Refuses anything outside [`ALLOWED_GIT`].
pub fn git_cmd(path: &str, args: &[&str]) -> String {
    assert!(
        is_allowed_git_args(args),
        "refused git subcommand over SSH: {:?}",
        args.first()
    );
    let mut parts = vec!["git".to_string(), "-C".to_string(), shell_quote(path)];
    parts.extend(args.iter().map(|a| shell_quote(a)));
    parts.join(" ")
}

/// Builds a read-only shell probe (`echo`/`test`/`ls`/`cat`) with quoted args.
pub fn probe_cmd(program: &str, args: &[&str]) -> String {
    assert!(
        ALLOWED_PROBE.contains(&program),
        "refused probe program over SSH: {program}"
    );
    let mut parts = vec![program.to_string()];
    parts.extend(args.iter().map(|a| shell_quote(a)));
    parts.join(" ")
}

/// POSIX shell single-quote escaping for one word.
///
/// `~` (and `~/…`) is left unquoted so the remote shell still expands it to
/// the login home directory: quoting it would turn `~/repo` into a literal
/// `~` directory lookup (`fatal: cannot change to '~/'`).
pub fn shell_quote(word: &str) -> String {
    if word.is_empty() {
        return "''".to_string();
    }
    // Split a leading `~` / `~/` off: the tilde must stay unquoted for
    // expansion while the remainder is quoted normally.
    let (prefix, rest) = match word.strip_prefix("~/") {
        Some(rest) => ("~/", rest),
        None if word == "~" => ("~", ""),
        None => ("", word),
    };
    if rest.is_empty() {
        return prefix.to_string();
    }
    let safe = rest
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_./=+:,@%".contains(c));
    if safe {
        return word.to_string();
    }
    format!("{prefix}'{}'", rest.replace('\'', "'\\''"))
}

fn is_allowed_probe_dir(dir: &str) -> bool {
    dir.starts_with('/') || dir.starts_with("~/") || dir == "~"
}

/// Maps an `ssh` spawn failure onto the error taxonomy. A missing executable
/// means no OpenSSH client on PATH (same guidance class as `git_missing`).
fn classify_ssh_spawn_error(error: &std::io::Error) -> EgError {
    if error.kind() == std::io::ErrorKind::NotFound {
        tracing::error!("ssh executable not found on PATH");
        EgError::GitMissing
    } else {
        tracing::error!(error = %error, "ssh spawn failed");
        EgError::Internal {
            context: format!("ssh spawn failed: {error}"),
        }
    }
}

/// Maps SSH + remote-git stderr onto the EgError taxonomy (TDD §6). SSH
/// connection failures are classified before delegating git-level output to
/// the same buckets `humanize_network` uses, so the existing Chinese
/// templates in `errors.ts` keep working.
pub fn humanize_ssh(stderr: &str, uri: &str, target: &SshTarget) -> EgError {
    let tail: String = stderr
        .lines()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    let tail = eg_types::sensitive::redact_text(&tail);
    tracing::error!(tail = %tail, uri = %eg_types::sensitive::redact_text(uri), "ssh command failed");
    let lower = stderr.to_lowercase();
    // Host-key problems fail closed: unknown keys (BatchMode refuses the
    // yes/no prompt) and — critically — changed keys (possible MITM).
    if lower.contains("host key verification failed")
        || lower.contains("no matching host key type found")
    {
        return EgError::Auth {
            provider: "ssh-host-key".into(),
            detail: Some(tail),
        };
    }
    if lower.contains("could not resolve hostname")
        || lower.contains("name or service not known")
        || lower.contains("nodename nor servname")
    {
        return EgError::Network {
            kind: "dns".into(),
            url: uri.to_string(),
            detail: Some(tail),
        };
    }
    if lower.contains("connection refused")
        || lower.contains("connection timed out")
        || lower.contains("operation timed out")
        || lower.contains("network is unreachable")
        || lower.contains("no route to host")
        || lower.contains("connect to host")
    {
        return EgError::Network {
            kind: "connect".into(),
            url: uri.to_string(),
            detail: Some(tail),
        };
    }
    // No usable key / agent has no identities / key file unreadable.
    if lower.contains("permission denied")
        || lower.contains("no such identity")
        || lower.contains("key_load_public")
        || lower.contains("no identities")
        || lower.contains("could not open a connection to your authentication agent")
    {
        return EgError::Auth {
            provider: "ssh-key".into(),
            detail: Some(tail),
        };
    }
    // Passphrase/keyboard-interactive prompts die under BatchMode: the user
    // must unlock the key in the agent first.
    if lower.contains("terminal prompts disabled")
        || lower.contains("read_passphrase")
        || lower.contains("passphrase")
    {
        return EgError::Auth {
            provider: "ssh-passphrase".into(),
            detail: Some(tail),
        };
    }
    // Not an SSH failure: remote git output — reuse the network buckets.
    if lower.contains("could not resolve host")
        || lower.contains("connection refused")
        || lower.contains("timed out")
        || lower.contains("failed to connect")
    {
        return EgError::Network {
            kind: "connect".into(),
            url: uri.to_string(),
            detail: Some(tail),
        };
    }
    if lower.contains("authentication")
        || lower.contains("403")
        || lower.contains("could not read username")
        || lower.contains("unencrypted")
    {
        return EgError::Auth {
            provider: "git".into(),
            detail: Some(tail),
        };
    }
    if lower.contains("rejected") && lower.contains("fetch first") {
        return EgError::ConflictState {
            state: "远端有本地没有的新提交（先获取）".into(),
            detail: Some(tail),
        };
    }
    if lower.contains("non-fast-forward") {
        return EgError::ConflictState {
            state: "远端被本地之外的提交更新过（需要先获取整合）".into(),
            detail: Some(tail),
        };
    }
    if lower.contains("not a git repository") {
        // Distinguish a missing path (likely a typo, refuse to offer init)
        // from an existing directory that just lacks a `.git` (offer init).
        let exists = probe_dir_exists(target);
        return EgError::SshNotARepo {
            target: target.clone(),
            exists,
            detail: Some(tail),
        };
    }
    EgError::Internal {
        context: format!("ssh command failed: {tail}"),
    }
}

/// True when `target.path` resolves to an existing directory on the host.
/// Uses `test -d` so symlinks and unreadable parents fail closed (returning
/// `false`, which keeps the user from being invited to `git init` something
/// they cannot reach).
fn probe_dir_exists(target: &SshTarget) -> bool {
    let probe = format!(
        "test -d {} && echo yes || echo no",
        shell_quote(&target.path)
    );
    match ssh_run(target, &probe, None, CLI_TIMEOUT_QUICK) {
        Ok((text, _)) => text.lines().any(|line| line.trim() == "yes"),
        Err(_) => false,
    }
}

/// Runs `git init` on the remote directory. The caller must have classified
/// the path as `SshNotARepo { exists: true }` first — a missing path stays
/// an error and never reaches this function (silent path creation would
/// invite the user to `git init` something they cannot reach).
pub fn ssh_init(target: &SshTarget) -> Result<(), EgError> {
    let cmd = git_cmd(&target.path, &["init", "-b", "main"]);
    let (text, ok) = ssh_run(target, &cmd, None, CLI_TIMEOUT_QUICK)?;
    if !ok {
        return Err(humanize_ssh(&text, &target.uri(), target));
    }
    Ok(())
}

/// Progress extraction for SSH-channeled git output: keeps the `--progress`
/// percentage parsing for fetch/push/clone, degrades everything else to
/// message-only updates for the sync strip.
fn parse_ssh_progress(line: &str) -> SyncProgress {
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

/// Per-connection server handshake timeout passed to `ssh -o
/// ConnectTimeout=`. The overall call still obeys the caller-supplied
/// `timeout` budget.
const CONNECT_TIMEOUT_SECS: u32 = 15;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_accepts_read_and_safe_write() {
        for args in [
            vec!["status", "--porcelain=v1"],
            vec!["log", "--oneline", "-50"],
            vec!["fetch", "--progress", "origin"],
            vec!["push", "--progress", "origin", "main:main"],
            vec!["commit", "-m", "msg"],
            vec!["-c", "gc.autoDetach=false", "gc"],
            vec!["stash", "push", "-m", "x"],
            // Unstage forms (index-only, no worktree/history rewrite).
            vec!["reset", "HEAD", "--", "a.rs"],
            vec!["rm", "--cached", "-r", "--", "a.rs"],
            // Guarded revert (working tree only, committed via commit flow).
            vec!["revert", "--no-commit", "abc123"],
            vec!["for-each-ref", "--format=%(refname:short)", "refs/heads"],
            vec!["reflog", "show", "HEAD"],
            vec!["switch", "feature"],
        ] {
            assert!(is_allowed_git_args(&args), "{args:?} must be allowed");
        }
    }

    #[test]
    fn allowlist_refuses_destructive_and_unknown() {
        for args in [
            vec!["reset", "--hard", "HEAD~1"],
            // Every history-rewriting reset mode is refused, even --soft;
            // remote resets are disabled by policy (no snapshot safety net).
            vec!["reset", "--soft", "HEAD~1"],
            vec!["reset", "--mixed", "HEAD~1"],
            vec!["reset", "HEAD~1"],
            vec!["reset", "HEAD", "--hard", "--", "a.rs"],
            vec!["rm", "-rf", "."],
            vec!["revert", "abc123"],
            vec!["push", "--force", "origin", "main"],
            vec!["branch", "-D", "feature"],
            vec!["clean", "-fd"],
            vec!["bash"],
            Vec::<&str>::new(),
        ] {
            assert!(!is_allowed_git_args(&args), "{args:?} must be refused");
        }
        // ...but the non-destructive siblings of those stay available.
        for args in [
            vec!["branch", "-d", "feature"],
            vec!["push", "--force-with-lease", "origin", "main:main"],
            vec!["clean", "-nd"],
        ] {
            assert!(is_allowed_git_args(&args), "{args:?} must be allowed");
        }
    }

    #[test]
    fn git_cmd_quotes_paths_with_spaces() {
        let cmd = git_cmd("/srv/my repo", &["status", "--porcelain=v1"]);
        assert_eq!(cmd, "git -C '/srv/my repo' status --porcelain=v1");
    }

    #[test]
    #[should_panic(expected = "refused git subcommand")]
    fn git_cmd_panics_on_disallowed_subcommand() {
        git_cmd("/srv/repo", &["reset", "--hard"]);
    }

    #[test]
    fn shell_quote_handles_tricky_words() {
        assert_eq!(shell_quote("plain"), "plain");
        assert_eq!(shell_quote("/srv/my repo/x"), "'/srv/my repo/x'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("-C"), "-C");
        // Tilde must stay expandable by the remote shell (真机: quoting it
        // breaks `git -C '~/…'` with `cannot change to '~'`).
        assert_eq!(shell_quote("~"), "~");
        assert_eq!(shell_quote("~/repos/app"), "~/repos/app");
        assert_eq!(shell_quote("~/my repo"), "~/'my repo'");
    }

    #[test]
    fn humanize_ssh_classifies_connection_failures() {
        let target = SshTarget {
            host: "host".into(),
            port: 22,
            user: None,
            path: "/srv/repo".into(),
        };
        let uri = "ssh://root@host/srv/repo";
        let err = humanize_ssh(
            "ssh: Could not resolve hostname badhost: Name or service not known",
            uri,
            &target,
        );
        assert_eq!(err.code(), "network");
        let err = humanize_ssh(
            "ssh: connect to host 1.2.3.4 port 22: Connection refused",
            uri,
            &target,
        );
        assert_eq!(err.code(), "network");
        let err = humanize_ssh("root@host: Permission denied (publickey).", uri, &target);
        assert_eq!(err.code(), "auth");
        let err = humanize_ssh("Host key verification failed.", uri, &target);
        assert!(matches!(err, EgError::Auth { provider, .. } if provider == "ssh-host-key"));
        // Old behavior moved: a "not a git repository" stderr now classifies
        // as ssh_not_a_repo (frontend decides whether to offer init based on
        // the existence probe below).
        let err = humanize_ssh(
            "fatal: not a git repository (or any of the parent directories): .git",
            uri,
            &target,
        );
        assert_eq!(err.code(), "ssh_not_a_repo");
    }

    #[test]
    fn humanize_ssh_redacts_secrets_in_detail() {
        let target = SshTarget {
            host: "host".into(),
            port: 22,
            user: Some("root".into()),
            path: "/srv/repo".into(),
        };
        let err = humanize_ssh(
            "fatal: unable to access 'https://u:pw@host/a.git': failed",
            "ssh://root@host/srv/repo",
            &target,
        );
        let detail = match &err {
            EgError::Internal { context } => context.clone(),
            other => panic!("expected internal, got {other:?}"),
        };
        assert!(detail.contains("https://u:***@host/a.git"), "{detail}");
        assert!(!detail.contains("pw"), "{detail}");
    }

    /// The `not a git repository` branch probes the remote path with
    /// `test -d` to fill `SshNotARepo::exists`. The probe target here is a
    /// closed port so the SSH call fails fast (connection refused) and the
    /// test never depends on a real host being reachable — a reachable host
    /// with a valid key would flip `exists` to true and break the assertion
    /// (真机: this machine has a key for 192.168.5.3, so probing it "worked").
    #[test]
    fn humanize_ssh_carries_target_into_ssh_not_repo() {
        let target = SshTarget {
            host: "127.0.0.1".into(),
            port: 1,
            user: Some("hhdlj".into()),
            path: "/home/hhdlj/easy-desktop".into(),
        };
        let err = humanize_ssh(
            "fatal: not a git repository (or any of the parent directories): .git",
            "ssh://hhdlj@127.0.0.1:1/home/hhdlj/easy-desktop",
            &target,
        );
        match err {
            EgError::SshNotARepo {
                target: inner,
                exists,
                ..
            } => {
                assert_eq!(inner.path, "/home/hhdlj/easy-desktop");
                assert_eq!(inner.user.as_deref(), Some("hhdlj"));
                // Unreachable host: the probe fails closed, keeping init
                // hidden (we never offer to init a path we cannot verify).
                assert!(!exists);
            }
            other => panic!("expected SshNotARepo, got {other:?}"),
        }
    }
}

// --- SSH credentials overview (settings "管理凭据") ---------------------
//
// Reads the local ssh-agent state and `~/.ssh/*.pub`. Read-only: private
// keys are never opened, no new data crosses the wire, no env var (besides
// what the user already set) is consulted. The command always succeeds —
// missing agent or absent `~/.ssh` are first-class results, not errors.

/// Hard timeout for any single local probe (`ssh-add -L`, `ssh-keygen -lf`).
/// Both should respond in milliseconds; 5 s covers a wedged agent without
/// freezing the settings page.
const OVERVIEW_TIMEOUT: Duration = Duration::from_secs(5);

/// Resolves the user's home directory without pulling in a `dirs` dependency.
fn user_home() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(std::path::PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(std::path::PathBuf::from)
    }
}

/// Snapshots the local SSH credential setup for the settings page. Safe to
/// call from the IPC thread: every subprocess is bounded by
/// [`OVERVIEW_TIMEOUT`] and isolated failures (agent down, missing `ssh-add`
/// or `ssh-keygen` binary, unreadable `~/.ssh`) degrade to empty fields
/// instead of bubbling up.
pub fn ssh_credentials_overview() -> Result<SshCredentialsOverview, EgError> {
    let home = user_home();
    let ssh_dir = home.as_ref().map(|h| h.join(".ssh"));
    let ssh_dir_present = ssh_dir.as_ref().is_some_and(|p| p.is_dir());

    let agent = read_agent_status();
    let public_keys = if ssh_dir_present {
        ssh_dir.as_deref().map(list_public_keys).unwrap_or_default()
    } else {
        Vec::new()
    };

    Ok(SshCredentialsOverview {
        agent,
        public_keys,
        home_dir: home.map(|p| p.to_string_lossy().into_owned()),
        ssh_dir_present,
    })
}

fn read_agent_status() -> SshAgentStatus {
    let auth_sock = std::env::var("SSH_AUTH_SOCK")
        .ok()
        .filter(|s| !s.is_empty());
    match run_local_with_timeout("ssh-add", &["-L"], OVERVIEW_TIMEOUT) {
        Ok((stdout, _, true)) => SshAgentStatus {
            running: true,
            auth_sock,
            keys: parse_ssh_add_lines(&stdout),
        },
        // Agent not running, missing binary, or any other failure: surface
        // it as "not running" so the UI's fix instructions are honest.
        _ => SshAgentStatus {
            running: false,
            auth_sock,
            keys: Vec::new(),
        },
    }
}

fn list_public_keys(ssh_dir: &std::path::Path) -> Vec<SshPublicKey> {
    let entries = match std::fs::read_dir(ssh_dir) {
        Ok(it) => it,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        // Only `.pub` files. A private key (e.g. `id_ed25519`) must never
        // be opened, even with `ssh-keygen -lf` on the file directly.
        if path.extension().and_then(|s| s.to_str()) != Some("pub") {
            continue;
        }
        let path_str = path.to_string_lossy().into_owned();
        let (stdout, _, ok) =
            match run_local_with_timeout("ssh-keygen", &["-lf", &path_str], OVERVIEW_TIMEOUT) {
                Ok(t) => t,
                Err(_) => continue,
            };
        if !ok {
            continue;
        }
        if let Some(info) = parse_ssh_keygen_line(&stdout) {
            out.push(SshPublicKey {
                path: path_str,
                fingerprint: info.fingerprint,
                comment: info.comment,
                key_type: info.key_type,
            });
        }
    }
    // Stable order so the UI doesn't reshuffle between refreshes.
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// Parses one `ssh-keygen -lf <file>.pub` line.
///
/// Real output (note the trailing key type in parens):
/// ```text
/// 256 SHA256:yqXgIItLIlkrJFafqrRjl7oRIKdiIRlld/PK9zSGHHU comment-test (ED25519)
/// ```
/// Bits before the fingerprint and the `(TYPE)` tail are kept verbatim in
/// `key_type` so the UI can show e.g. `RSA 4096` without re-deriving it.
fn parse_ssh_keygen_line(stdout: &str) -> Option<SshKeyInfo> {
    // Trim the trailing newline; fields are whitespace-separated.
    let line = stdout.trim();
    let mut parts = line.splitn(4, char::is_whitespace);
    let _bits = parts.next()?;
    let fingerprint = parts.next()?.to_string();
    let comment = parts.next().unwrap_or_default().to_string();
    let key_type = if let Some(rest) = parts.next() {
        // Strip the trailing "(ED25519)" or "(RSA)" parens if present —
        // older ssh-keygen sometimes omits them.
        rest.trim()
            .trim_matches(|c| c == '(' || c == ')')
            .to_string()
    } else {
        String::new()
    };
    if fingerprint.is_empty() {
        return None;
    }
    Some(SshKeyInfo {
        fingerprint,
        comment,
        key_type,
    })
}

/// Parses one `ssh-add -L` line. Format is identical to `ssh-keygen -lf`.
fn parse_ssh_add_lines(stdout: &str) -> Vec<SshKeyInfo> {
    stdout.lines().filter_map(parse_ssh_keygen_line).collect()
}

/// Spawns a local command with stdout+stderr captured and stdin closed,
/// bounded by `timeout`. Returns `(stdout, stderr, success)`. Spawn errors
/// (binary not found, etc.) come back as `Err(())` so callers can degrade
/// to empty results without poisoning the whole overview with an
/// `EgError`.
fn run_local_with_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<(String, String, bool), ()> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;

    let mut child = crate::process::hidden_command(program)
        .args(args.iter().copied())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|_| ())?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_handle = stdout.map(|s| {
        std::thread::spawn(move || {
            let mut buf = String::new();
            for line in BufReader::new(s).lines().map_while(Result::ok) {
                buf.push_str(&line);
                buf.push('\n');
            }
            buf
        })
    });
    let stderr_handle = stderr.map(|s| {
        std::thread::spawn(move || {
            let mut buf = String::new();
            for line in BufReader::new(s).lines().map_while(Result::ok) {
                buf.push_str(&line);
                buf.push('\n');
            }
            buf
        })
    });

    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout_text = stdout_handle
                    .and_then(|h| h.join().ok())
                    .unwrap_or_default();
                let stderr_text = stderr_handle
                    .and_then(|h| h.join().ok())
                    .unwrap_or_default();
                return Ok((stdout_text, stderr_text, status.success()));
            }
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return Err(()),
        }
    }
}

#[cfg(test)]
mod credentials_overview_tests {
    use super::*;

    #[test]
    fn parses_a_well_formed_ssh_keygen_line() {
        // What `ssh-keygen -lf id_ed25519.pub` prints.
        let line =
            "256 SHA256:yqXgIItLIlkrJFafqrRjl7oRIKdiIRlld/PK9zSGHHU comment-test (ED25519)\n";
        let info = parse_ssh_keygen_line(line).expect("must parse");
        assert_eq!(
            info.fingerprint,
            "SHA256:yqXgIItLIlkrJFafqrRjl7oRIKdiIRlld/PK9zSGHHU"
        );
        assert_eq!(info.comment, "comment-test");
        assert_eq!(info.key_type, "ED25519");
    }

    #[test]
    fn parses_rsa_with_bits_in_the_type_field() {
        let line = "4096 SHA256:tI0bRq8Wi4k06dQ7iY0WnP9gPjF1N3K2aBcDeFgHiJk user@host (RSA)\n";
        let info = parse_ssh_keygen_line(line).expect("must parse");
        assert_eq!(info.key_type, "RSA");
    }

    #[test]
    fn parses_a_line_without_key_type_parens() {
        // Older ssh-keygen and some 3rd-party tools omit the (TYPE) tail.
        let line = "256 SHA256:abcd1234 legacy-key\n";
        let info = parse_ssh_keygen_line(line).expect("must parse");
        assert_eq!(info.fingerprint, "SHA256:abcd1234");
        assert_eq!(info.comment, "legacy-key");
        assert_eq!(info.key_type, "");
    }

    #[test]
    fn rejects_a_blank_line() {
        assert!(parse_ssh_keygen_line("").is_none());
        assert!(parse_ssh_keygen_line("\n\n").is_none());
    }

    #[test]
    fn parse_ssh_add_lines_groups_multiple_keys() {
        let stdout = "256 SHA256:aaaa user1@host1 (ED25519)\n\
                       4096 SHA256:bbbb user2@host2 (RSA)\n";
        let keys = parse_ssh_add_lines(stdout);
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0].comment, "user1@host1");
        assert_eq!(keys[1].key_type, "RSA");
    }
}
