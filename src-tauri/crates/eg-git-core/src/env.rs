//! Environment probe (PRD §7: detect system git ≥ 2.30, guide the install
//! when missing). EasyGit never bundles git; everything local runs in-process
//! via libgit2, but sync/stage-lines need the real CLI.

use eg_types::EnvStatus;

use crate::process::hidden_command;

/// Lowest supported git version (PRD §7: 检测系统 git ≥ 2.30).
pub const MIN_GIT_VERSION: (u32, u32, u32) = (2, 30, 0);

/// Parses `git version 2.53.0.windows.1` style output into `(2, 53, 0)`.
/// Returns `None` for anything unexpected rather than guessing.
pub fn parse_git_version(output: &str) -> Option<(u32, u32, u32)> {
    let line = output.lines().next()?.trim();
    let rest = line.strip_prefix("git version")?.trim();
    let mut parts = rest.split(['.', '-', 'v']);
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

/// True when the parsed version satisfies the PRD minimum.
pub fn is_supported(version: (u32, u32, u32)) -> bool {
    version >= MIN_GIT_VERSION
}

/// Runs `git --version` with a short timeout. `None` means git is missing or
/// unusable — the caller guides the user to install it; the exact failure is
/// not surfaced (the guide page is the same either way).
pub fn git_version() -> Option<String> {
    let mut child = hidden_command("git")
        .arg("--version")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    };
    if !status.success() {
        return None;
    }
    use std::io::Read;
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    parse_git_version(&out)?;
    // Trim to the line git printed; the UI shows the bare version string.
    Some(out.lines().next()?.trim().to_string())
}

/// Startup probe for the `env_check` command (F-01 pipeline sibling).
pub fn env_status() -> EnvStatus {
    EnvStatus {
        git_version: git_version(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_and_windows_suffixed_versions() {
        assert_eq!(parse_git_version("git version 2.53.0\n"), Some((2, 53, 0)));
        assert_eq!(
            parse_git_version("git version 2.53.0.windows.1\n"),
            Some((2, 53, 0))
        );
        assert_eq!(parse_git_version("git version 2.29.3\n"), Some((2, 29, 3)));
        assert_eq!(parse_git_version(""), None);
        assert_eq!(parse_git_version("not git at all"), None);
    }

    #[test]
    fn supported_threshold_follows_prd_minimum() {
        assert!(is_supported((2, 30, 0)));
        assert!(is_supported((2, 53, 0)));
        assert!(!is_supported((2, 29, 3)));
        assert!(!is_supported((1, 9, 0)));
    }
}
