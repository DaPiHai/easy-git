//! Shared EasyGit types. Every DTO crossing IPC lives here so the Rust core
//! and the React frontend speak one schema (TDD §4.6), generated to TS via
//! tauri-specta.

pub mod error;
pub mod paths;
pub mod sensitive;
pub mod ssh;

pub use error::EgError;

pub use ssh::{
    is_ssh_location, parse_ssh_target, RepoLocation, SshAgentStatus, SshCredentialsOverview,
    SshGenerateKeyRequest, SshHostKeyInfo, SshKeyInfo, SshPublicKey, SshTarget, DEFAULT_SSH_PORT,
};

mod dto;

pub use dto::{
    AppVersion, BranchInfo, ChangeEntry, ChangeKind, CommitDetail, CommitFile, CommitLogEntry,
    CommitOutcome, CommitRefs, CommitRequest, ConfigScope, ConflictBlock, ConflictFile, DiffHunk,
    DiffLine, DiffLineKind, DiffRequest, DiffResponse, DiffSourceKind, EnvStatus, GraphLine,
    GraphNode, IgnoreMode, LogFilter, LogPage, MergeOutcome, MergeState, PushCredentials,
    RemoteInfo, RepoId, RepoSummary, ResetMode, ResetOutcome, SelectedHunk, StageLinesRequest,
    StageMode, StashEntry, StatusReport, SyncStrategy, TagInfo, TimelineEntry, UndoRedoState,
    WordSpan,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_version_serializes_camel_case() {
        let json = serde_json::to_string(&AppVersion {
            app_version: "0.1.0".into(),
            tauri_version: "2.0.0".into(),
            os: "linux".into(),
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"appVersion":"0.1.0","tauriVersion":"2.0.0","os":"linux"}"#
        );
    }

    #[test]
    fn eg_error_serializes_with_code_tag() {
        let json = serde_json::to_string(&EgError::RepoNotFound {
            path: "/tmp/demo".into(),
            detail: None,
        })
        .unwrap();
        assert_eq!(json, r#"{"code":"repo_not_found","path":"/tmp/demo"}"#);

        let json = serde_json::to_string(&EgError::Cancelled).unwrap();
        assert_eq!(json, r#"{"code":"cancelled"}"#);

        let json = serde_json::to_string(&EgError::GitMissing).unwrap();
        assert_eq!(json, r#"{"code":"git_missing"}"#);
    }

    #[test]
    fn eg_error_detail_serializes_only_when_present() {
        let with_detail = serde_json::to_string(&EgError::Network {
            kind: "connect".into(),
            url: "https://user:s3cret@host/repo.git".into(),
            detail: Some("fatal: could not read Username".into()),
        })
        .unwrap();
        // detail rides along when present; the raw URL is the caller's
        // responsibility to redact (sensitive::redact_url).
        assert_eq!(
            with_detail,
            r#"{"code":"network","kind":"connect","url":"https://user:s3cret@host/repo.git","detail":"fatal: could not read Username"}"#
        );

        let without_detail = serde_json::to_string(&EgError::Auth {
            provider: "git".into(),
            host: None,
            detail: None,
        })
        .unwrap();
        assert_eq!(
            without_detail, r#"{"code":"auth","provider":"git"}"#,
            "absent detail must not appear as null"
        );

        let ssh_host_key = serde_json::to_string(&EgError::SshHostKey {
            host: "github.com".into(),
            port: 22,
            changed: true,
            fingerprint: Some("SHA256:abc".into()),
            key_type: Some("ED25519".into()),
            detail: None,
        })
        .unwrap();
        assert_eq!(
            ssh_host_key,
            r#"{"code":"ssh_host_key","host":"github.com","port":22,"changed":true,"fingerprint":"SHA256:abc","key_type":"ED25519"}"#,
        );
    }

    #[test]
    fn env_status_serializes_camel_case() {
        let json = serde_json::to_string(&EnvStatus {
            git_version: Some("git version 2.53.0".into()),
        })
        .unwrap();
        assert_eq!(json, r#"{"gitVersion":"git version 2.53.0"}"#);

        let json = serde_json::to_string(&EnvStatus { git_version: None }).unwrap();
        assert_eq!(json, r#"{"gitVersion":null}"#);
    }
}
