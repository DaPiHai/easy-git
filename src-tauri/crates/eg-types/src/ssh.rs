//! SSH remote-host coordinates (feat/ssh-remote-manage).
//!
//! A repository EasyGit manages is either a local directory (`Local`) or a
//! directory on a remote host reached over SSH (`Ssh`). The frontend passes
//! the SSH form as a URI string through the existing `repo_open(path)`
//! command, so parsing lives here next to the other IPC-adjacent types.
//!
//! Canonical display form: `ssh://[user@]host[:port]/path` (port omitted
//! when it is the SSH default 22).

use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;

/// Default SSH port, used when the user does not specify one.
pub const DEFAULT_SSH_PORT: u16 = 22;

/// One key reported by either `ssh-add -L` (the live agent) or
/// `ssh-keygen -lf <file>.pub` (a public key file on disk). Private key
/// material is never read or returned — the type deliberately does not have
/// a place to carry it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyInfo {
    /// Output of `ssh-keygen -lf`: SHA256 for modern keys, legacy MD5 for
    /// older ones. We keep whatever the tools report so the UI does not
    /// have to second-guess.
    pub fingerprint: String,
    /// Trailing comment from the .pub line, often `user@host`.
    pub comment: String,
    /// Algorithm and bits as printed by the tools, e.g. `ED25519`,
    /// `RSA 4096`, `ECDSA 256`.
    pub key_type: String,
}

/// Status of the local ssh-agent and the keys it currently holds. Computed
/// once per `ssh_credentialsOverview()` IPC call from the backend; the UI
/// treats `running = false` as "tell the user to start their agent".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SshAgentStatus {
    /// True when an ssh-agent socket is reachable and `ssh-add -L` returned
    /// success. False covers every "agent missing / dead / wrong env"
    /// condition the user can fix by starting their agent.
    pub running: bool,
    /// Value of `SSH_AUTH_SOCK` at command time. Surfaced so the UI can
    /// show the actual path (an old leftover socket is a common reason the
    /// agent "isn't running" after a session reconnect).
    pub auth_sock: Option<String>,
    /// Keys currently loaded in the agent. Empty when `running` is false.
    pub keys: Vec<SshKeyInfo>,
}

/// One public key file under the user's `~/.ssh/` directory. The matching
/// private key is never opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SshPublicKey {
    /// Absolute path to the `.pub` file.
    pub path: String,
    pub fingerprint: String,
    pub comment: String,
    pub key_type: String,
}

/// Read-only snapshot of the local SSH credential setup, returned by the
/// `ssh_credentials_overview` IPC command and shown by the
/// "管理凭据" section on the settings page. EasyGit never stores
/// credentials and never reads private keys — this is purely a status
/// report so the user can tell whether their agent is up and which keys
/// are available.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SshCredentialsOverview {
    pub agent: SshAgentStatus,
    pub public_keys: Vec<SshPublicKey>,
    /// Resolved home directory (parent of `.ssh/`). `None` when no home
    /// directory is discoverable on the platform.
    pub home_dir: Option<String>,
    /// True when `~/.ssh` exists. Drives the UI's empty-state message.
    pub ssh_dir_present: bool,
}

/// A repository living on a remote host, addressed over SSH.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SshTarget {
    pub host: String,
    pub port: u16,
    /// Login user. `None` means "let ssh pick" (usually the local username).
    pub user: Option<String>,
    /// Absolute path (or `~/`-relative) of the repository on the host.
    pub path: String,
}

impl SshTarget {
    /// Canonical display/identity string, e.g. `ssh://root@host:22/srv/repo`
    /// (home-relative paths render as `ssh://root@host/~/repo`).
    pub fn uri(&self) -> String {
        let user_part = match &self.user {
            Some(user) if !user.is_empty() => format!("{user}@"),
            _ => String::new(),
        };
        let port_part = if self.port == DEFAULT_SSH_PORT {
            String::new()
        } else {
            format!(":{}", self.port)
        };
        // scp-like `~/…` paths carry no leading slash; the URI form needs
        // one as the authority/path separator (真机: `ssh://user@host~/`
        // lost the separator and confused the error surface).
        let path_part = if self.path.starts_with('/') {
            self.path.clone()
        } else {
            format!("/{}", self.path)
        };
        format!("ssh://{user_part}{}{port_part}{path_part}", self.host)
    }

    /// `user@host` (or just `host`) for the `ssh` destination argument.
    pub fn destination(&self) -> String {
        match &self.user {
            Some(user) if !user.is_empty() => format!("{user}@{}", self.host),
            _ => self.host.clone(),
        }
    }
}

/// Where a managed repository lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RepoLocation {
    Local(PathBuf),
    Ssh(SshTarget),
}

impl RepoLocation {
    /// Stable identity key for the RepoManager registry (dedupe + lookup).
    /// Local paths must already be canonicalized by the caller.
    pub fn key(&self) -> String {
        match self {
            RepoLocation::Local(path) => format!("local:{}", path.to_string_lossy()),
            RepoLocation::Ssh(target) => format!("ssh:{}", target.uri()),
        }
    }

    /// User-facing text: verbatim-prefix-stripped local path or SSH URI.
    pub fn display(&self) -> String {
        match self {
            RepoLocation::Local(path) => super::paths::display_path(path),
            RepoLocation::Ssh(target) => target.uri(),
        }
    }

    pub fn is_ssh(&self) -> bool {
        matches!(self, RepoLocation::Ssh(_))
    }
}

/// Parses user input into an [`SshTarget`]. Accepts:
/// - `ssh://[user@]host[:port]/path`
/// - scp-like `[user@]host:/absolute/path` (port always 22)
///
/// Returns `None` when the input is not SSH-shaped (e.g. a local path —
/// including Windows `C:\…` drive paths, which superficially resemble the
/// scp-like form).
pub fn parse_ssh_target(input: &str) -> Option<SshTarget> {
    let text = input.trim();
    if text.is_empty() {
        return None;
    }
    if let Some(rest) = text.strip_prefix("ssh://") {
        return parse_ssh_scheme(rest);
    }
    parse_scp_like(text)
}

/// True when `input` parses as an SSH target (either accepted form).
pub fn is_ssh_location(input: &str) -> bool {
    parse_ssh_target(input).is_some()
}

fn parse_ssh_scheme(rest: &str) -> Option<SshTarget> {
    // Split authority from path at the first '/'.
    let slash = rest.find('/')?;
    let (authority, path) = (&rest[..slash], &rest[slash..]);
    if authority.is_empty() || path.len() < 2 {
        return None;
    }
    let (user, host_port) = split_user(authority);
    let (host, port) = split_host_port(host_port)?;
    if host.is_empty() {
        return None;
    }
    Some(SshTarget {
        host,
        port,
        user,
        path: path.to_string(),
    })
}

fn parse_scp_like(text: &str) -> Option<SshTarget> {
    // Reject anything with "://" (a non-ssh scheme) and Windows drive paths.
    if text.contains("://") || is_windows_drive_path(text) {
        return None;
    }
    let colon = text.find(':')?;
    let (host_part, path) = (&text[..colon], &text[colon + 1..]);
    if host_part.is_empty() || path.is_empty() {
        return None;
    }
    // Host part must not contain '/' (that would be a local path).
    if host_part.contains('/') || host_part.contains('\\') {
        return None;
    }
    // Remote paths are absolute or home-relative; a bare `host:file` is a
    // relative path on the host, which we refuse to guess about.
    if !path.starts_with('/') && !path.starts_with("~/") && path != "~" {
        return None;
    }
    let (user, host) = split_user(host_part);
    if host.is_empty() {
        return None;
    }
    Some(SshTarget {
        host: host.to_string(),
        port: DEFAULT_SSH_PORT,
        user,
        path: path.to_string(),
    })
}

fn split_user(authority: &str) -> (Option<String>, &str) {
    match authority.rfind('@') {
        Some(at) => {
            let user = &authority[..at];
            let user = if user.is_empty() {
                None
            } else {
                Some(user.to_string())
            };
            (user, &authority[at + 1..])
        }
        None => (None, authority),
    }
}

fn split_host_port(host_port: &str) -> Option<(String, u16)> {
    // Bracketed IPv6: [::1] or [::1]:2222.
    if let Some(bracketed) = host_port.strip_prefix('[') {
        let end = bracketed.find(']')?;
        let host = bracketed[..end].to_string();
        let rest = &bracketed[end + 1..];
        let port = if let Some(port_text) = rest.strip_prefix(':') {
            port_text.parse::<u16>().ok()?
        } else if rest.is_empty() {
            DEFAULT_SSH_PORT
        } else {
            return None;
        };
        return Some((host, port));
    }
    // Bare IPv6 (multiple colons, no brackets) carries no port.
    if host_port.chars().filter(|&c| c == ':').count() > 1 {
        return Some((host_port.to_string(), DEFAULT_SSH_PORT));
    }
    match host_port.rfind(':') {
        Some(colon) => {
            let host = host_port[..colon].to_string();
            let port = host_port[colon + 1..].parse::<u16>().ok()?;
            Some((host, port))
        }
        None => Some((host_port.to_string(), DEFAULT_SSH_PORT)),
    }
}

fn is_windows_drive_path(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes.len() == 2 || bytes[2] == b'\\' || bytes[2] == b'/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ssh_scheme_full() {
        let target = parse_ssh_target("ssh://root@192.168.1.10:2222/srv/repo.git").unwrap();
        assert_eq!(target.host, "192.168.1.10");
        assert_eq!(target.port, 2222);
        assert_eq!(target.user.as_deref(), Some("root"));
        assert_eq!(target.path, "/srv/repo.git");
        assert_eq!(target.uri(), "ssh://root@192.168.1.10:2222/srv/repo.git");
    }

    #[test]
    fn parses_ssh_scheme_defaults() {
        let target = parse_ssh_target("ssh://host/srv/repo").unwrap();
        assert_eq!(target.host, "host");
        assert_eq!(target.port, DEFAULT_SSH_PORT);
        assert_eq!(target.user, None);
        assert_eq!(target.uri(), "ssh://host/srv/repo");
    }

    #[test]
    fn parses_scp_like() {
        let target = parse_ssh_target("git@github.com:/srv/repo.git").unwrap();
        assert_eq!(target.host, "github.com");
        assert_eq!(target.user.as_deref(), Some("git"));
        assert_eq!(target.port, DEFAULT_SSH_PORT);
        assert_eq!(target.uri(), "ssh://git@github.com/srv/repo.git");
    }

    #[test]
    fn parses_home_relative_scp_path() {
        let target = parse_ssh_target("root@host:~/repos/app").unwrap();
        assert_eq!(target.path, "~/repos/app");
        // The URI form keeps the authority/path separator (no `host~/`).
        assert_eq!(target.uri(), "ssh://root@host/~/repos/app");
    }

    #[test]
    fn rejects_local_paths() {
        for local in [
            r"C:\Users\demo\repo",
            "C:/Users/demo/repo",
            "/home/demo/repo",
            "./relative/repo",
            "just-a-dir",
            "host:relative/path",
            "ssh://host",
            "ssh://",
            "ssh:///path-only",
            "https://github.com/u/r.git",
            "",
        ] {
            assert!(!is_ssh_location(local), "{local} must not parse as SSH");
            assert_eq!(parse_ssh_target(local), None, "{local}");
        }
    }

    #[test]
    fn repo_location_keys_and_display() {
        let local = RepoLocation::Local(PathBuf::from(r"C:\demo"));
        assert!(local.key().starts_with("local:"));
        assert!(!local.is_ssh());

        let ssh = RepoLocation::Ssh(parse_ssh_target("root@host:/srv/repo").unwrap());
        assert!(ssh.is_ssh());
        assert_eq!(ssh.key(), "ssh:ssh://root@host/srv/repo");
        assert_eq!(ssh.display(), "ssh://root@host/srv/repo");
    }

    #[test]
    fn ssh_target_serializes_camel_case() {
        let json = serde_json::to_string(&SshTarget {
            host: "host".into(),
            port: 22,
            user: Some("root".into()),
            path: "/srv/repo".into(),
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"host":"host","port":22,"user":"root","path":"/srv/repo"}"#
        );
    }

    #[test]
    fn destination_skips_empty_user() {
        let with_user = SshTarget {
            host: "h".into(),
            port: 22,
            user: Some("u".into()),
            path: "/r".into(),
        };
        assert_eq!(with_user.destination(), "u@h");
        let without_user = SshTarget {
            user: None,
            ..with_user.clone()
        };
        assert_eq!(without_user.destination(), "h");
    }
}
