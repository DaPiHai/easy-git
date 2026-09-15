//! Guard for the IPC command registry (TDD §3 / generate-bindings contract).
//!
//! A Tauri command has to be listed in **two** places:
//! - `src/lib.rs` inside `collect_commands![…]` — this is the real one: the
//!   builder's output is handed to `.invoke_handler(...)`, so a command
//!   missing here does not exist at runtime.
//! - `src/bin/generate-bindings.rs` inside `collect_commands![…]` — this is
//!   only the CI binding generator, which never launches the app.
//!
//! They are maintained by hand, and forgetting the first one is silent:
//! Rust compiles, `cargo check` passes, TS types exist, bindings export, the
//! frontend even typechecks and its unit tests pass. The command simply is
//! not registered, so invoking it fails at runtime with "not found" — and
//! because that error is not an `EgError`, the UI degraded it to the generic
//! fallback with no log line (真机: `ssh_init_repo` shipped exactly like
//! this; 在此初始化仓库 looked like a dead button).
//!
//! Pin the two lists together so the failure mode cannot come back silently.

const LIB_RS: &str = include_str!("../src/lib.rs");
const GENERATE_BINDINGS_RS: &str = include_str!("../src/bin/generate-bindings.rs");

/// Pulls the `commands::…` entries out of a `collect_commands![…]` block.
/// Accepts both spellings (`commands::x` in lib.rs, `easy_git::commands::x`
/// in the generator).
fn registered_commands(source: &str, file: &str) -> Vec<String> {
    const MARKER: &str = "collect_commands![";
    let start = source
        .find(MARKER)
        .unwrap_or_else(|| panic!("{file}: no collect_commands![ block found"));
    let body = &source[start + MARKER.len()..];
    let end = body
        .find("])")
        .unwrap_or_else(|| panic!("{file}: collect_commands![ block is not closed with `])`"));

    let mut names: Vec<String> = body[..end]
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let after_marker = line.find("commands::")? + "commands::".len();
            let name: String = line[after_marker..]
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            (!name.is_empty()).then_some(name)
        })
        .collect();
    names.sort();
    names
}

#[test]
fn runtime_handler_and_binding_generator_register_the_same_commands() {
    let runtime = registered_commands(LIB_RS, "src/lib.rs");
    let generated = registered_commands(GENERATE_BINDINGS_RS, "src/bin/generate-bindings.rs");

    assert!(
        !runtime.is_empty(),
        "src/lib.rs must register at least one command"
    );
    assert_eq!(
        runtime,
        generated,
        "src/lib.rs (runtime invoke handler) and src/bin/generate-bindings.rs (CI binding \
         generator) list different commands.\n\
         A command only in the generator has TS types but is NOT callable at runtime; \
         one only in lib.rs is callable but invisible to the frontend.\n\
         Add new commands to BOTH lists.\n\
         only in lib.rs: {:?}\n\
         only in generate-bindings.rs: {:?}",
        runtime
            .iter()
            .filter(|c| !generated.contains(c))
            .collect::<Vec<_>>(),
        generated
            .iter()
            .filter(|c| !runtime.contains(c))
            .collect::<Vec<_>>(),
    );
}
