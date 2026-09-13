//! Path helpers shared by error construction and logging.
//!
//! Windows canonicalization yields verbatim paths (`\\?\C:\…`); those are
//! correct for filesystem calls but confusing in user-facing copy, so error
//! values carry the display form instead.

use std::path::Path;

/// Strips the Windows verbatim prefix (`\\?\`, `\\?\UNC\`). Paths without the
/// prefix (and non-Windows paths) pass through unchanged.
pub fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    text.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_path_strips_verbatim_prefixes() {
        assert_eq!(display_path(Path::new(r"\\?\C:\demo")), r"C:\demo");
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\server\share\repo")),
            r"\\server\share\repo"
        );
    }

    #[test]
    fn display_path_keeps_ordinary_paths() {
        assert_eq!(display_path(Path::new(r"C:\demo")), r"C:\demo");
        assert_eq!(display_path(Path::new("/tmp/demo")), "/tmp/demo");
    }
}
