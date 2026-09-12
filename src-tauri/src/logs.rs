//! Local log file plumbing (TDD §1: tracing + tracing-subscriber, file sink;
//! TDD §7: local-only, credentials redacted, no telemetry).
//!
//! The tracing subscriber writes daily-rolling files (`easygit.log.YYYY-MM-DD`
//! via tracing-appender) under `<app-data>/logs`. This module owns everything
//! around the sink: retention cleanup, the in-app viewer's read/list commands
//! and the frontend exception entry point (which routes back through tracing
//! so web and Rust lines share one file and one format).

use std::path::{Path, PathBuf};

use eg_types::sensitive::redact_text;
use serde::Serialize;
use specta::Type;

/// Subdirectory under the app data dir holding the daily log files.
pub const LOG_DIR_NAME: &str = "logs";
/// File stem of the rolling sink (`easygit.log.2026-09-12`).
pub const LOG_FILE_PREFIX: &str = "easygit.log";
/// Daily files older than this are deleted at startup (best-effort).
pub const RETENTION_DAYS: u64 = 14;
/// Upper bound for one viewer read; a busy day can produce megabytes.
pub const MAX_READ_BYTES: u64 = 512 * 1024;
/// Upper bound for one frontend log line (stack traces included).
const MAX_WEB_MESSAGE_CHARS: usize = 4000;

pub fn logs_dir(app_data: &Path) -> PathBuf {
    app_data.join(LOG_DIR_NAME)
}

/// One rolling log file for the in-app viewer, newest first from [`list_log_files`].
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogFileInfo {
    pub file_name: String,
    pub size_bytes: u64,
    pub modified_at: u64,
}

/// Tail content of one log file. `truncated` marks that the head was cut so
/// the viewer can say "仅显示末尾部分".
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogContent {
    pub file_name: String,
    pub content: String,
    pub truncated: bool,
}

/// Deletes daily log files older than `keep_days` (best-effort; failures are
/// ignored so a locked file can never block startup).
pub fn cleanup_old_logs(dir: &Path, keep_days: u64) {
    let cutoff = date_suffix_days_ago(keep_days);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(date) = date_suffix(&name) else {
            continue;
        };
        if date.as_str() < cutoff.as_str() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// All rolling log files, newest first. Non-log files are ignored.
pub fn list_log_files(dir: &Path) -> Vec<LogFileInfo> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if date_suffix(&name).is_none() {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let modified_at = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(LogFileInfo {
            file_name: name,
            size_bytes: meta.len(),
            modified_at,
        });
    }
    out.sort_by(|a, b| b.file_name.cmp(&a.file_name));
    out
}

/// Reads the tail of one log file (most of the time that's all a reader
/// needs). The file name is validated against the rolling sink's exact shape
/// so this can never read outside the logs directory.
pub fn read_log_tail(dir: &Path, file_name: &str, max_bytes: u64) -> Result<LogContent, String> {
    if date_suffix(file_name).is_none() {
        return Err(format!("not a log file: {file_name:?}"));
    }
    let path = dir.join(file_name);
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    let start = size.saturating_sub(max_bytes);
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    use std::io::{Read, Seek, SeekFrom};
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity((size - start).min(max_bytes) as usize);
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let truncated = start > 0;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        // Drop the partial first line left by the seek.
        if let Some(pos) = text.find('\n') {
            text.drain(..=pos);
        } else {
            text.clear();
        }
    }
    Ok(LogContent {
        file_name: file_name.to_string(),
        content: text,
        truncated,
    })
}

/// Entry point for frontend-originated logs (window.onerror, unhandled
/// rejections, manual `appLog` calls). Routed through tracing with the
/// `web` target so the lines share the subscriber's format and sink.
/// Never fails: bad levels/messages degrade instead of erroring the caller.
pub fn write_web_log(level: &str, scope: &str, message: &str) {
    let scope = redact_text(&scope.chars().take(120).collect::<String>());
    let message = redact_text(
        &message
            .chars()
            .take(MAX_WEB_MESSAGE_CHARS)
            .collect::<String>(),
    );
    match level {
        "error" => tracing::error!(target: "web", scope, "{message}"),
        "warn" => tracing::warn!(target: "web", scope, "{message}"),
        _ => tracing::info!(target: "web", scope, "{message}"),
    }
}

/// The date suffix of a rolling log file name (`easygit.log.2026-09-12` →
/// `2026-09-12`), or None for anything else (which also rejects path
/// traversal for [`read_log_tail`]).
fn date_suffix(file_name: &str) -> Option<String> {
    let date = file_name.strip_prefix(LOG_FILE_PREFIX)?.strip_prefix('.')?;
    if date.len() != 10 || !date.bytes().all(|b| b.is_ascii_digit() || b == b'-') {
        return None;
    }
    // Structural check: 4-2-4 dash positions.
    if date.as_bytes()[4] == b'-' && date.as_bytes()[7] == b'-' {
        Some(date.to_string())
    } else {
        None
    }
}

/// `YYYY-MM-DD` for the date `keep_days` before today, comparable with file
/// name suffixes (lexicographic order == chronological order for this shape).
fn date_suffix_days_ago(keep_days: u64) -> String {
    let today = days_since_epoch();
    let (y, m, d) = civil_from_days(today - keep_days as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

fn days_since_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64 / 86_400)
        .unwrap_or(0)
}

/// Howard Hinnant's civil_from_days: days since 1970-01-01 → (y, m, d).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_file(dir: &Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).unwrap();
    }

    #[test]
    fn date_suffix_accepts_only_rolling_shapes() {
        assert_eq!(
            date_suffix("easygit.log.2026-09-12").as_deref(),
            Some("2026-09-12")
        );
        assert_eq!(date_suffix("easygit.log"), None);
        assert_eq!(date_suffix("easygit.log.2026-09-12.old"), None);
        assert_eq!(date_suffix("other.log.2026-09-12"), None);
        assert_eq!(date_suffix("easygit.log.2026-09-12/../evil"), None);
        assert_eq!(date_suffix("easygit.log.20260912"), None);
    }

    #[test]
    fn cleanup_removes_files_older_than_retention() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "easygit.log.2020-01-01", "old");
        write_file(dir.path(), "easygit.log.2099-01-01", "new");
        write_file(dir.path(), "unrelated.txt", "keep me? no, ignored");
        cleanup_old_logs(dir.path(), RETENTION_DAYS);
        assert!(!dir.path().join("easygit.log.2020-01-01").exists());
        assert!(dir.path().join("easygit.log.2099-01-01").exists());
        assert!(dir.path().join("unrelated.txt").exists());
    }

    #[test]
    fn list_returns_only_log_files_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "easygit.log.2026-01-01", "a");
        write_file(dir.path(), "easygit.log.2026-01-02", "bb");
        write_file(dir.path(), "noise.txt", "x");
        let files = list_log_files(dir.path());
        let names: Vec<&str> = files.iter().map(|f| f.file_name.as_str()).collect();
        assert_eq!(names, ["easygit.log.2026-01-02", "easygit.log.2026-01-01"]);
        assert_eq!(files[0].size_bytes, 2);
    }

    #[test]
    fn read_tail_returns_end_and_marks_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let body = "first\nsecond\nthird\n";
        write_file(dir.path(), "easygit.log.2026-09-12", body);

        let full = read_log_tail(dir.path(), "easygit.log.2026-09-12", 1024).unwrap();
        assert_eq!(full.content, body);
        assert!(!full.truncated);

        let tail = read_log_tail(dir.path(), "easygit.log.2026-09-12", 12).unwrap();
        assert!(tail.truncated);
        // 12 bytes land inside "second", so the partial head line is dropped.
        assert_eq!(tail.content, "third\n");
    }

    #[test]
    fn read_tail_rejects_non_log_names() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_log_tail(dir.path(), "../Cargo.toml", 10).is_err());
        assert!(read_log_tail(dir.path(), "easygit.log", 10).is_err());
    }

    #[test]
    fn date_math_round_trips_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1)); // 2024-01-01
        assert_eq!(date_suffix_days_ago(0), date_suffix_days_ago(0));
        // Retention cutoff must parse as the same shape we filter on.
        let cutoff = date_suffix_days_ago(RETENTION_DAYS);
        assert_eq!(cutoff.len(), 10);
        assert!(date_suffix(&format!("{LOG_FILE_PREFIX}.{cutoff}")).is_some());
    }
}
