use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;
use tauri::{Manager, State};

#[derive(Default)]
pub struct SessionFilesState {
    gate: Arc<tokio::sync::Mutex<()>>,
}

fn message_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("invalid conversation id".into());
    }
    Ok(root
        .join("conversations")
        .join(format!("session-{id}.json")))
}

fn read_messages(root: &Path, id: &str) -> Result<Option<Value>, String> {
    let path = message_path(root, id)?;
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if !value.is_array() {
        return Err("invalid conversation message file".into());
    }
    Ok(Some(value))
}

fn atomic_write(path: &Path, bytes: &[u8], replace: bool) -> Result<(), String> {
    let parent = path.parent().ok_or("missing conversation directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temporary.write_all(bytes).map_err(|e| e.to_string())?;
    commit_file(temporary, path, replace)
}

fn commit_file(
    temporary: tempfile::NamedTempFile,
    path: &Path,
    replace: bool,
) -> Result<(), String> {
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    if replace {
        temporary.persist(path).map_err(|e| e.error.to_string())?;
    } else if let Err(error) = temporary.persist_noclobber(path) {
        if error.error.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(error.error.to_string());
        }
    }
    #[cfg(unix)]
    fs::File::open(path.parent().ok_or("missing conversation directory")?)
        .and_then(|directory| directory.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn write_messages(root: &Path, id: &str, messages: &Value, migrate: bool) -> Result<(), String> {
    let path = message_path(root, id)?;
    if !messages.is_array() {
        return Err("conversation messages must be an array".into());
    }
    if migrate {
        let backup = root.join("terax-ai-sessions.before-message-files.json");
        if !backup.exists() {
            let mut legacy =
                fs::File::open(root.join("terax-ai-sessions.json")).map_err(|e| e.to_string())?;
            let mut temporary = tempfile::NamedTempFile::new_in(root).map_err(|e| e.to_string())?;
            std::io::copy(&mut legacy, temporary.as_file_mut()).map_err(|e| e.to_string())?;
            commit_file(temporary, &backup, false)?;
        }
        if read_messages(root, id)?.is_some() {
            return Ok(());
        }
    }
    let bytes = serde_json::to_vec(messages).map_err(|e| e.to_string())?;
    atomic_write(&path, &bytes, !migrate)
}

#[tauri::command]
pub async fn ai_session_load(
    app: tauri::AppHandle,
    state: State<'_, SessionFilesState>,
    id: String,
) -> Result<Option<Value>, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let guard = state.gate.clone().lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        read_messages(&root, &id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ai_session_save(
    app: tauri::AppHandle,
    state: State<'_, SessionFilesState>,
    id: String,
    messages: Value,
    migrate: Option<bool>,
) -> Result<(), String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let guard = state.gate.clone().lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        write_messages(&root, &id, &messages, migrate.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ai_session_delete(
    app: tauri::AppHandle,
    state: State<'_, SessionFilesState>,
    id: String,
) -> Result<(), String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let guard = state.gate.clone().lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        match fs::remove_file(message_path(&root, &id)?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn messages_are_independent_atomic_files_and_missing_sessions_are_empty() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(read_messages(root.path(), "one").unwrap(), None);
        write_messages(root.path(), "one", &json!([{"text":"old"}]), false).unwrap();
        write_messages(root.path(), "two", &json!([{"text":"other"}]), false).unwrap();
        write_messages(root.path(), "one", &json!([{"text":"new"}]), false).unwrap();
        assert_eq!(
            read_messages(root.path(), "one").unwrap(),
            Some(json!([{"text":"new"}]))
        );
        assert_eq!(
            read_messages(root.path(), "two").unwrap(),
            Some(json!([{"text":"other"}]))
        );
        assert_eq!(
            fs::read_dir(root.path().join("conversations"))
                .unwrap()
                .count(),
            2
        );
    }

    #[test]
    fn migration_preserves_a_backup_and_never_overwrites_newer_messages() {
        let root = tempfile::tempdir().unwrap();
        let legacy = br#"{"messages:one":[{"text":"legacy"}]}"#;
        fs::write(root.path().join("terax-ai-sessions.json"), legacy).unwrap();
        write_messages(root.path(), "one", &json!([{"text":"legacy"}]), true).unwrap();
        write_messages(root.path(), "one", &json!([{"text":"newer"}]), false).unwrap();
        write_messages(root.path(), "one", &json!([{"text":"legacy"}]), true).unwrap();
        assert_eq!(
            read_messages(root.path(), "one").unwrap(),
            Some(json!([{"text":"newer"}]))
        );
        assert_eq!(
            fs::read(
                root.path()
                    .join("terax-ai-sessions.before-message-files.json")
            )
            .unwrap(),
            legacy
        );
    }

    #[test]
    fn invalid_ids_and_corrupt_targets_fail_without_discarding_legacy_data() {
        let root = tempfile::tempdir().unwrap();
        for id in ["", "../escape", "a/b", "a\\b", "."] {
            assert!(message_path(root.path(), id).is_err());
        }
        assert_eq!(
            message_path(root.path(), "CON")
                .unwrap()
                .file_name()
                .unwrap(),
            "session-CON.json"
        );
        fs::write(root.path().join("terax-ai-sessions.json"), b"{}").unwrap();
        fs::create_dir(root.path().join("conversations")).unwrap();
        fs::write(message_path(root.path(), "one").unwrap(), b"invalid").unwrap();
        assert!(write_messages(root.path(), "one", &json!([]), true).is_err());
        assert_eq!(
            fs::read(message_path(root.path(), "one").unwrap()).unwrap(),
            b"invalid"
        );
    }
}
