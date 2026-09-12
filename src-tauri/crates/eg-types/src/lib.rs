//! Shared EasyGit types. Every DTO crossing IPC lives here so the Rust core
//! and the React frontend speak one schema (TDD §4.6), generated to TS via
//! tauri-specta.

pub mod error;

pub use error::EgError;

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
        })
        .unwrap();
        assert_eq!(json, r#"{"code":"repo_not_found","path":"/tmp/demo"}"#);

        let json = serde_json::to_string(&EgError::Cancelled).unwrap();
        assert_eq!(json, r#"{"code":"cancelled"}"#);

        let json = serde_json::to_string(&EgError::GitMissing).unwrap();
        assert_eq!(json, r#"{"code":"git_missing"}"#);
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
