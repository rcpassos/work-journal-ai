//! Exercise actual IPC authorization using the build's generated capabilities
//! and harmless handlers, so no journal or user settings are needed.

use std::collections::BTreeMap;
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::utils::acl::{capability::Capability, manifest::Manifest, resolved::Resolved};
use tauri::utils::platform::Target;

#[tauri::command]
fn journal_transaction() -> &'static str {
    "reached"
}
#[tauri::command]
fn dismiss_capture() -> &'static str {
    "reached"
}
#[tauri::command]
fn repository_branches() -> &'static str {
    "reached"
}
#[tauri::command]
fn repository_identities() -> &'static str {
    "reached"
}
#[tauri::command]
fn compare_and_set_observing() -> &'static str {
    "reached"
}

#[test]
fn existing_desktop_commands_still_reach_their_handlers() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let acl: BTreeMap<String, Manifest> = serde_json::from_str(
        &std::fs::read_to_string(root.join("gen/schemas/acl-manifests.json")).unwrap(),
    )
    .unwrap();
    let capabilities: BTreeMap<String, Capability> = serde_json::from_str(
        &std::fs::read_to_string(root.join("gen/schemas/capabilities.json")).unwrap(),
    )
    .unwrap();
    let resolved = Resolved::resolve(&acl, capabilities, Target::MacOS).unwrap();
    let mut context = mock_context(noop_assets());
    *context.runtime_authority_mut() = tauri::runtime_authority!(acl, resolved);
    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![
            journal_transaction,
            dismiss_capture,
            repository_identities,
            repository_branches,
            compare_and_set_observing
        ])
        .build(context)
        .unwrap();
    for window in ["main", "capture", "task-creation"] {
        let webview = tauri::WebviewWindowBuilder::new(&app, window, Default::default())
            .build()
            .unwrap();
        for command in [
            "journal_transaction",
            "dismiss_capture",
            "repository_identities",
            "repository_branches",
            "compare_and_set_observing",
        ] {
            let response = get_ipc_response(
                &webview,
                tauri::webview::InvokeRequest {
                    cmd: command.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::default(),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.to_string(),
                },
            )
            .map(|body| body.deserialize::<String>().unwrap());
            if window == "task-creation" && command == "compare_and_set_observing" {
                assert!(response.is_err());
            } else {
                assert_eq!(response, Ok("reached".into()), "{window}: {command}");
            }
        }
    }
}
