//! Shared EasyGit types. Every DTO crossing IPC lives here so the Rust core
//! and the React frontend speak one schema (TDD §4.6), generated to TS via
//! tauri-specta.

pub mod error;

pub use error::EgError;

mod dto;

pub use dto::AppVersion;

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
    }
}
