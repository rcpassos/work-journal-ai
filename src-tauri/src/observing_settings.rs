//! Observing is transformed in TypeScript, but only Rust can serialize its
//! replacement across webviews. See ADR 0046.

use super::OBSERVING_KEY;
use serde::Serialize;
use serde_json::Value;
use std::sync::Mutex;
use tauri::Runtime;
use tauri_plugin_store::{Store, StoreExt};

// Every Observing writer holds this through comparison, replacement and save.
static OBSERVING_WRITES: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize, PartialEq)]
#[serde(untagged)]
pub enum CompareAndSet {
    Written { written: bool },
    Conflict { written: bool, current: Value },
}

#[tauri::command]
pub fn compare_and_set_observing<R: Runtime>(
    app: tauri::AppHandle<R>,
    expected: Value,
    next: Value,
) -> Result<CompareAndSet, String> {
    let store = app
        .store_builder(super::SETTINGS_FILE)
        .disable_auto_save()
        .build()
        .map_err(|error| error.to_string())?;
    compare_and_set(&store, expected, next)
}

fn compare_and_set<R: Runtime>(
    store: &Store<R>,
    expected: Value,
    next: Value,
) -> Result<CompareAndSet, String> {
    let _writing = OBSERVING_WRITES.lock().map_err(|error| error.to_string())?;
    let previous = store.get(OBSERVING_KEY);
    let current = previous.clone().unwrap_or(Value::Null);
    if current != expected {
        return Ok(CompareAndSet::Conflict {
            written: false,
            current,
        });
    }
    store.set(OBSERVING_KEY, next);
    if let Err(error) = store.save() {
        // A failed save must not leave an unsaved Pause/consent change for a
        // later settings write to persist or a subsequent retry to read.
        if let Some(previous) = previous {
            store.set(OBSERVING_KEY, previous);
        } else {
            store.delete(OBSERVING_KEY);
        }
        return Err(error.to_string());
    }
    Ok(CompareAndSet::Written { written: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tauri::test::{mock_builder, mock_context, noop_assets};

    #[test]
    fn concurrent_replacements_of_one_read_have_exactly_one_winner() {
        let app = mock_builder()
            .plugin(tauri_plugin_store::Builder::default().build())
            .build(mock_context(noop_assets()))
            .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let store = app
            .store_builder(&path)
            .disable_auto_save()
            .build()
            .unwrap();
        let barrier = std::sync::Barrier::new(2);
        let results = std::thread::scope(|scope| {
            let writes: Vec<_> = [json!({"pause": true}), json!({"identities": ["me"]})]
                .into_iter()
                .map(|next| {
                    let store = &store;
                    let barrier = &barrier;
                    scope.spawn(move || {
                        let expected = store.get(OBSERVING_KEY).unwrap_or(Value::Null);
                        barrier.wait();
                        compare_and_set(store, expected, next).unwrap()
                    })
                })
                .collect();
            writes
                .into_iter()
                .map(|write| write.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, CompareAndSet::Written { written: true }))
                .count(),
            1
        );
        let persisted: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let conflict = results
            .into_iter()
            .find(|result| matches!(result, CompareAndSet::Conflict { .. }))
            .unwrap();
        assert_eq!(
            serde_json::to_value(conflict).unwrap(),
            json!({"written": false, "current": persisted[OBSERVING_KEY]})
        );
    }

    #[test]
    fn stale_replacements_return_the_current_value_without_overwriting_disk() {
        let app = mock_builder()
            .plugin(tauri_plugin_store::Builder::default().build())
            .build(mock_context(noop_assets()))
            .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let store = app
            .store_builder(&path)
            .disable_auto_save()
            .build()
            .unwrap();
        let initial = json!({"enabled": true, "pauses": {}});
        let paused = json!({"enabled": true, "pauses": {"repo": [{"from": 1000, "until": null}]}});
        store.set(OBSERVING_KEY, initial.clone());
        store.set("theme", json!("dark"));

        assert_eq!(
            compare_and_set(&store, initial.clone(), paused.clone()).unwrap(),
            CompareAndSet::Written { written: true }
        );
        assert_eq!(
            compare_and_set(&store, initial, json!({"identities": ["me"]})).unwrap(),
            CompareAndSet::Conflict {
                written: false,
                current: paused.clone()
            }
        );
        let persisted: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(persisted[OBSERVING_KEY], paused);
        assert_eq!(persisted["theme"], "dark");
    }

    #[test]
    fn absent_values_can_be_written_and_failed_saves_leave_the_next_write_usable() {
        let app = mock_builder()
            .plugin(tauri_plugin_store::Builder::default().build())
            .build(mock_context(noop_assets()))
            .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let store = app
            .store_builder(&path)
            .disable_auto_save()
            .build()
            .unwrap();
        // A directory at the file's destination forces persistence to fail.
        std::fs::create_dir(&path).unwrap();
        assert!(compare_and_set(&store, Value::Null, json!({"enabled": true})).is_err());
        assert_eq!(store.get(OBSERVING_KEY), None);
        std::fs::remove_dir(&path).unwrap();

        assert_eq!(
            compare_and_set(&store, Value::Null, json!({"enabled": false})).unwrap(),
            CompareAndSet::Written { written: true }
        );
        assert!(path.is_file());
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(
            compare_and_set(&store, json!({"enabled": false}), json!({"enabled": true})).is_err()
        );
        assert_eq!(store.get(OBSERVING_KEY), Some(json!({"enabled": false})));
    }
}
