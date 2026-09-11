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

#[cfg(test)]
mod tests {
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
