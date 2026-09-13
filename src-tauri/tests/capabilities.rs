//! Guard for the compiled ACL. Tauri builds its permission set from
//! `capabilities/*.json`, and a permission written as a bare string carries no
//! scope at all. `opener:allow-open-path` is one of those, and the opener plugin
//! denies every path while its allow list is empty (`Error::ForbiddenPath`) —
//! rc.2 shipped exactly that, so 打开文件夹 failed with only a generic toast.
//! Pin the scope declaration here so the failure mode cannot come back silently.

use serde_json::Value;

const CAPABILITIES: &str = include_str!("../capabilities/default.json");

#[test]
fn open_path_permission_declares_a_path_scope() {
    let capability: Value =
        serde_json::from_str(CAPABILITIES).expect("capabilities/default.json must be valid JSON");
    let permissions = capability["permissions"]
        .as_array()
        .expect("permissions must be an array");

    let scoped = permissions
        .iter()
        .find(|entry| entry["identifier"] == "opener:allow-open-path")
        .expect("opener:allow-open-path must be an object carrying an `allow` scope");

    let allow = scoped["allow"]
        .as_array()
        .expect("opener:allow-open-path must carry an allow list");

    assert!(
        allow
            .iter()
            .any(|entry| entry["path"].as_str().is_some_and(|path| !path.is_empty())),
        "an empty path scope makes the opener plugin reject every openPath call"
    );
}
