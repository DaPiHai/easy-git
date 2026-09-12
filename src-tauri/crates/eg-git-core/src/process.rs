//! Construction of external child processes.
//!
//! The app is a Windows GUI-subsystem binary (`windows_subsystem = "windows"`
//! in release), so it owns no console. A console program spawned from it
//! without `CREATE_NO_WINDOW` makes Windows allocate a *visible* console for
//! the child — the blank cmd window users see flash on every git CLI call.
//! Build every console child through [`hidden_command`] so that cannot happen.

/// Returns a [`std::process::Command`] for an external console program that
/// never displays a console window.
///
/// On Windows the child is created with `CREATE_NO_WINDOW`, which gives it a
/// hidden console. Deliberately *not* `DETACHED_PROCESS`: with no console at
/// all, each grandchild would allocate its own visible one — the `GIT_ASKPASS`
/// helper is a `.bat` run through `cmd.exe`, so detaching would trade one flash
/// for another. A hidden console is inherited by descendants, which covers
/// them too. Elsewhere this is a plain passthrough.
pub fn hidden_command(program: &str) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Maps a spawn failure onto the error taxonomy: a missing executable means
/// git is not installed (or not on this process's PATH), which deserves the
/// dedicated `git_missing` guidance instead of a raw `internal` error.
pub fn classify_spawn_error(program: &str, error: &std::io::Error) -> eg_types::EgError {
    if error.kind() == std::io::ErrorKind::NotFound {
        tracing::error!(program, "git executable not found on PATH");
        eg_types::EgError::GitMissing
    } else {
        tracing::error!(program, error = %error, "spawn failed");
        eg_types::EgError::Internal {
            context: format!("{program} spawn failed: {error}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_found_maps_to_git_missing() {
        let err = classify_spawn_error("git", &std::io::Error::from(std::io::ErrorKind::NotFound));
        assert_eq!(err.code(), "git_missing");
    }

    #[test]
    fn other_spawn_errors_stay_internal() {
        let err = classify_spawn_error(
            "git",
            &std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied"),
        );
        assert_eq!(err.code(), "internal");
    }

    /// Spawning a console program through the helper must still work (the flag
    /// only affects console allocation). Also covers the non-Windows
    /// passthrough path.
    #[test]
    fn hidden_command_spawns_program() {
        let output = super::hidden_command("git")
            .arg("--version")
            .output()
            .expect("git must be spawnable through hidden_command");
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("git version"));
    }

    /// The mechanism itself is Windows-only, so prove it on a real console
    /// child there.
    #[cfg(windows)]
    #[test]
    fn hidden_command_spawns_console_child() {
        let output = super::hidden_command("cmd")
            .args(["/C", "echo", "ok"])
            .output()
            .expect("cmd must be spawnable through hidden_command");
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "ok");
    }
}
