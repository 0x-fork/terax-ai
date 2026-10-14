//! Conversation message files, one atomically replaced file per session.
//!
//! Messages cross the IPC boundary as raw UTF-8 JSON bytes and are written
//! verbatim: nothing here builds a JSON document tree, so a save costs one
//! streaming validation pass plus the write. Durability is explicit. Saves
//! during a streaming turn are plain atomic replaces (tempfile and rename),
//! because the next save is seconds away. The turn-end, switch, migration and
//! close saves ask for `durable`, which adds a file sync, and a directory sync
//! when the file is new.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde::Deserialize;
use serde_json::{Map, Value};
use tauri::ipc::{Request, Response};
use tauri::{Manager, State};

use super::ipc_body;

/// A conversation larger than this is refused rather than held in memory.
const MAX_CONVERSATION_BYTES: usize = 128 * 1024 * 1024;
const MAX_OPTIONS_BYTES: usize = 1024;
const LEGACY_BACKUP: &str = "terax-ai-sessions.before-message-files.json";
const LEGACY_STORE: &str = "terax-ai-sessions.json";
const LEGACY_KEY_PREFIX: &str = "messages:";

#[derive(Default)]
pub struct SessionFilesState {
    gate: Arc<tokio::sync::Mutex<()>>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn message_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("invalid conversation id".into());
    }
    Ok(root
        .join("conversations")
        .join(format!("session-{id}.json")))
}

fn quarantine_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".corrupt");
    path.with_file_name(name)
}

/// Cheap structural check without building a document: the bytes must be one
/// complete, valid JSON array. `IgnoredAny` streams over the value and skips
/// allocating it, and `from_slice` also rejects invalid UTF-8 and trailing
/// data.
fn validate_conversation(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_CONVERSATION_BYTES {
        return Err(format!(
            "conversation exceeds {} MiB",
            MAX_CONVERSATION_BYTES / (1024 * 1024)
        ));
    }
    let first = bytes.iter().find(|b| !b.is_ascii_whitespace());
    let last = bytes.iter().rev().find(|b| !b.is_ascii_whitespace());
    if first != Some(&b'[') || last != Some(&b']') {
        return Err("conversation messages must be an array".into());
    }
    serde_json::from_slice::<serde::de::IgnoredAny>(bytes)
        .map(|_| ())
        .map_err(|e| format!("conversation is not valid JSON: {e}"))
}

/// Reads one conversation. A missing file is `None`. A file that does not
/// validate is moved aside (kept for recovery) and reported as `corrupt:`, so a
/// later save starts a fresh file instead of failing forever, and one bad file
/// never affects another session.
fn read_messages(root: &Path, id: &str) -> Result<Option<Vec<u8>>, String> {
    let path = message_path(root, id)?;
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if bytes.len() > MAX_CONVERSATION_BYTES {
        return Err("conversation is too large to open".into());
    }
    if let Err(reason) = validate_conversation(&bytes) {
        let moved = fs::rename(&path, quarantine_path(&path));
        log::warn!("conversation {id} is unreadable ({reason}); quarantined: {moved:?}");
        return Err(format!("corrupt: {reason}"));
    }
    Ok(Some(bytes))
}

fn message_file_is_valid(root: &Path, id: &str) -> bool {
    message_path(root, id)
        .ok()
        .and_then(|path| fs::read(path).ok())
        .is_some_and(|bytes| validate_conversation(&bytes).is_ok())
}

#[derive(Clone, Copy)]
struct Commit {
    /// Replace an existing file. Migration passes false so it never clobbers
    /// a newer file written after a failed run.
    replace: bool,
    /// File sync (and a directory sync when the file is new).
    durable: bool,
}

fn atomic_write(path: &Path, bytes: &[u8], commit: Commit) -> Result<(), String> {
    let parent = path.parent().ok_or("missing conversation directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temporary.write_all(bytes).map_err(|e| e.to_string())?;
    commit_file(temporary, path, commit)
}

fn commit_file(
    temporary: tempfile::NamedTempFile,
    path: &Path,
    commit: Commit,
) -> Result<(), String> {
    if commit.durable {
        temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    }
    #[cfg(unix)]
    let created = !path.exists();
    if commit.replace {
        temporary.persist(path).map_err(|e| e.error.to_string())?;
    } else if let Err(error) = temporary.persist_noclobber(path) {
        if error.error.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(error.error.to_string());
        }
    }
    #[cfg(unix)]
    if commit.durable && created {
        fs::File::open(path.parent().ok_or("missing conversation directory")?)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Keeps the pre-migration store next to the new files until the migration is
/// verified, so an interrupted run can still be recovered by hand.
fn ensure_backup(root: &Path) -> Result<(), String> {
    let backup = root.join(LEGACY_BACKUP);
    if backup.exists() {
        return Ok(());
    }
    let mut legacy = fs::File::open(root.join(LEGACY_STORE)).map_err(|e| e.to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(root).map_err(|e| e.to_string())?;
    std::io::copy(&mut legacy, temporary.as_file_mut()).map_err(|e| e.to_string())?;
    commit_file(
        temporary,
        &backup,
        Commit {
            replace: false,
            durable: true,
        },
    )
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct SaveOptions {
    id: String,
    migrate: bool,
    durable: bool,
}

fn write_messages(
    root: &Path,
    id: &str,
    bytes: &[u8],
    migrate: bool,
    durable: bool,
) -> Result<(), String> {
    validate_conversation(bytes)?;
    let path = message_path(root, id)?;
    if migrate {
        ensure_backup(root)?;
        // A readable file already there is newer than the legacy record.
        if read_messages(root, id)?.is_some() {
            return Ok(());
        }
    }
    atomic_write(
        &path,
        bytes,
        Commit {
            replace: !migrate,
            durable: durable || migrate,
        },
    )
}

/// Drops a session from the pre-migration copy, if it still exists, so deleting
/// a conversation does not leave its text behind in the backup.
fn scrub_backup(root: &Path, id: &str) -> Result<(), String> {
    let backup = root.join(LEGACY_BACKUP);
    let bytes = match fs::read(&backup) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let Ok(mut entries) = serde_json::from_slice::<Map<String, Value>>(&bytes) else {
        // An unreadable backup cannot be edited; it must not outlive the data.
        return fs::remove_file(&backup).map_err(|e| e.to_string());
    };
    if entries
        .remove(&format!("{LEGACY_KEY_PREFIX}{id}"))
        .is_none()
    {
        return Ok(());
    }
    if entries
        .keys()
        .all(|key| !key.starts_with(LEGACY_KEY_PREFIX))
    {
        return fs::remove_file(&backup).map_err(|e| e.to_string());
    }
    let rewritten = serde_json::to_vec(&entries).map_err(|e| e.to_string())?;
    atomic_write(
        &backup,
        &rewritten,
        Commit {
            replace: true,
            durable: false,
        },
    )
}

fn delete_messages(root: &Path, id: &str) -> Result<(), String> {
    let path = message_path(root, id)?;
    for target in [quarantine_path(&path), path] {
        match fs::remove_file(target) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    scrub_backup(root, id)
}

/// Deletes the pre-migration copy once every migrated conversation reads back
/// valid. Returns whether it is gone; any doubt keeps it.
fn finish_migration(root: &Path, ids: &[String]) -> Result<bool, String> {
    if !ids.iter().all(|id| message_file_is_valid(root, id)) {
        return Ok(false);
    }
    remove_backup(root)
}

fn remove_backup(root: &Path) -> Result<bool, String> {
    match fs::remove_file(root.join(LEGACY_BACKUP)) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error.to_string()),
    }
}

/// Backups left by an earlier build, where nothing is waiting to migrate, are
/// removed once they are old enough.
fn prune_backup(root: &Path, max_age: Duration, now: SystemTime) -> Result<bool, String> {
    let modified = match fs::metadata(root.join(LEGACY_BACKUP)).and_then(|m| m.modified()) {
        Ok(modified) => modified,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    if now.duration_since(modified).unwrap_or_default() < max_age {
        return Ok(false);
    }
    remove_backup(root)
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_session_load(
    app: tauri::AppHandle,
    state: State<'_, SessionFilesState>,
    id: String,
) -> Result<Response, String> {
    let root = data_dir(&app)?;
    let guard = state.gate.clone().lock_owned().await;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        read_messages(&root, &id)
    })
    .await
    .map_err(|e| e.to_string())??;
    // An empty body means "no such conversation".
    Ok(Response::new(bytes.unwrap_or_default()))
}

/// Body: the conversation as raw JSON bytes. Header `x-terax-session`:
/// `{ "id", "migrate"?, "durable"? }`.
#[tauri::command]
pub async fn ai_session_save(
    app: tauri::AppHandle,
    state: State<'_, SessionFilesState>,
    request: Request<'_>,
) -> Result<(), String> {
    let options: SaveOptions = request
        .headers()
        .get("x-terax-session")
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() <= MAX_OPTIONS_BYTES)
        .ok_or("missing or oversized conversation options")
        .and_then(|value| {
            serde_json::from_str(value).map_err(|_| "invalid conversation options")
        })?;
    // The task outlives the borrowed IPC buffer; conversations are small
    // relative to the cost of keeping the borrow across a blocking write.
    let bytes = ipc_body::bytes_of(
        request.body(),
        MAX_CONVERSATION_BYTES,
        ipc_body::JSON_FALLBACK_MAX_BYTES,
    )?
    .into_owned();
    let root = data_dir(&app)?;
    let guard = state.gate.clone().lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        write_messages(&root, &options.id, &bytes, options.migrate, options.durable)
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
    let root = data_dir(&app)?;
    let guard = state.gate.clone().lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        delete_messages(&root, &id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Verifies the migrated conversations and removes the pre-migration copy.
#[tauri::command]
pub async fn ai_session_finish_migration(
    app: tauri::AppHandle,
    state: State<'_, SessionFilesState>,
    ids: Vec<String>,
) -> Result<bool, String> {
    let root = data_dir(&app)?;
    let guard = state.gate.clone().lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        finish_migration(&root, &ids)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ai_session_prune_backup(
    app: tauri::AppHandle,
    state: State<'_, SessionFilesState>,
    max_age_secs: u64,
) -> Result<bool, String> {
    let root = data_dir(&app)?;
    let guard = state.gate.clone().lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        prune_backup(&root, Duration::from_secs(max_age_secs), SystemTime::now())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> Vec<u8> {
        text.as_bytes().to_vec()
    }

    fn save(root: &Path, id: &str, text: &str) -> Result<(), String> {
        write_messages(root, id, text.as_bytes(), false, false)
    }

    fn read(root: &Path, id: &str) -> Option<String> {
        read_messages(root, id)
            .unwrap()
            .map(|bytes| String::from_utf8(bytes).unwrap())
    }

    #[test]
    fn messages_are_independent_atomic_files_and_missing_sessions_are_empty() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(read(root.path(), "one"), None);
        save(root.path(), "one", r#"[{"text":"old"}]"#).unwrap();
        save(root.path(), "two", r#"[{"text":"other"}]"#).unwrap();
        save(root.path(), "one", r#"[{"text":"new"}]"#).unwrap();
        assert_eq!(
            read(root.path(), "one").as_deref(),
            Some(r#"[{"text":"new"}]"#)
        );
        assert_eq!(
            read(root.path(), "two").as_deref(),
            Some(r#"[{"text":"other"}]"#)
        );
        assert_eq!(
            fs::read_dir(root.path().join("conversations"))
                .unwrap()
                .count(),
            2,
            "no temporary files are left behind"
        );
    }

    #[test]
    fn bytes_are_written_verbatim_without_reserialization() {
        let root = tempfile::tempdir().unwrap();
        let exact = "[ {\"b\": 1,\n \"a\" : \"\\u00e9\"} ]\n";
        save(root.path(), "one", exact).unwrap();
        assert_eq!(read(root.path(), "one").as_deref(), Some(exact));
    }

    #[test]
    fn validation_rejects_anything_but_one_complete_json_array() {
        for good in ["[]", " [1, 2] \n", r#"[{"a":[{}]}]"#] {
            assert!(validate_conversation(good.as_bytes()).is_ok(), "{good}");
        }
        for bad in [
            "",
            "{}",
            "null",
            "[",
            "[1,]",
            "[] []",
            "[1] x",
            "\"[]\"",
            "[\"\u{0}\"]",
        ] {
            assert!(validate_conversation(bad.as_bytes()).is_err(), "{bad:?}");
        }
        assert!(
            validate_conversation(&[b'[', 0xff, b']']).is_err(),
            "invalid UTF-8"
        );
        // Skipping values is iterative, so pathological nesting cannot overflow
        // the small blocking-pool stack.
        let nested = format!("{}{}", "[".repeat(200_000), "]".repeat(200_000));
        assert!(validate_conversation(nested.as_bytes()).is_ok());
        assert!(validate_conversation(&nested.as_bytes()[1..]).is_err());
        let oversized = vec![b' '; MAX_CONVERSATION_BYTES + 1];
        assert!(validate_conversation(&oversized)
            .unwrap_err()
            .contains("exceeds"));
    }

    #[test]
    fn invalid_ids_and_non_arrays_never_reach_the_disk() {
        let root = tempfile::tempdir().unwrap();
        for id in ["", "../escape", "a/b", "a\\b", ".", &"x".repeat(129)] {
            assert!(message_path(root.path(), id).is_err(), "{id:?}");
            assert!(save(root.path(), id, "[]").is_err(), "{id:?}");
        }
        assert_eq!(
            message_path(root.path(), "CON")
                .unwrap()
                .file_name()
                .unwrap(),
            "session-CON.json"
        );
        assert!(save(root.path(), "one", "{}").is_err());
        assert!(!root.path().join("conversations").exists());
    }

    #[test]
    fn a_corrupt_file_is_quarantined_so_other_sessions_and_later_saves_still_work() {
        let root = tempfile::tempdir().unwrap();
        save(root.path(), "good", "[1]").unwrap();
        save(root.path(), "bad", "[2]").unwrap();
        let bad = message_path(root.path(), "bad").unwrap();
        fs::write(&bad, b"{ not json").unwrap();

        let error = read_messages(root.path(), "bad").unwrap_err();
        assert!(error.starts_with("corrupt:"), "{error}");
        assert_eq!(fs::read(quarantine_path(&bad)).unwrap(), b"{ not json");
        assert!(!bad.exists());

        assert_eq!(read(root.path(), "good").as_deref(), Some("[1]"));
        assert_eq!(
            read(root.path(), "bad"),
            None,
            "the damaged session reads as empty now"
        );
        save(root.path(), "bad", "[3]").unwrap();
        assert_eq!(read(root.path(), "bad").as_deref(), Some("[3]"));
        assert!(
            quarantine_path(&bad).exists(),
            "the damaged copy is kept for recovery"
        );
    }

    #[test]
    fn deleting_a_session_also_removes_its_quarantined_copy() {
        let root = tempfile::tempdir().unwrap();
        save(root.path(), "one", "[1]").unwrap();
        let path = message_path(root.path(), "one").unwrap();
        fs::write(&path, b"broken").unwrap();
        let _ = read_messages(root.path(), "one");
        assert!(quarantine_path(&path).exists());
        delete_messages(root.path(), "one").unwrap();
        assert!(!quarantine_path(&path).exists());
        delete_messages(root.path(), "one").expect("deleting nothing is fine");
    }

    #[test]
    fn migration_preserves_a_backup_and_never_overwrites_newer_messages() {
        let root = tempfile::tempdir().unwrap();
        let legacy = br#"{"messages:one":[{"text":"legacy"}]}"#;
        fs::write(root.path().join(LEGACY_STORE), legacy).unwrap();
        write_messages(
            root.path(),
            "one",
            &json(r#"[{"text":"legacy"}]"#),
            true,
            false,
        )
        .unwrap();
        save(root.path(), "one", r#"[{"text":"newer"}]"#).unwrap();
        write_messages(
            root.path(),
            "one",
            &json(r#"[{"text":"legacy"}]"#),
            true,
            false,
        )
        .unwrap();
        assert_eq!(
            read(root.path(), "one").as_deref(),
            Some(r#"[{"text":"newer"}]"#)
        );
        assert_eq!(fs::read(root.path().join(LEGACY_BACKUP)).unwrap(), legacy);
    }

    #[test]
    fn a_corrupt_target_fails_migration_without_discarding_legacy_data() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join(LEGACY_STORE), b"{}").unwrap();
        fs::create_dir(root.path().join("conversations")).unwrap();
        let target = message_path(root.path(), "one").unwrap();
        fs::write(&target, b"invalid").unwrap();
        let result = write_messages(root.path(), "one", &json("[]"), true, false);
        assert!(result.unwrap_err().starts_with("corrupt:"));
        assert_eq!(fs::read(quarantine_path(&target)).unwrap(), b"invalid");
        assert!(root.path().join(LEGACY_BACKUP).exists());
    }

    #[test]
    fn the_backup_is_removed_only_after_every_migrated_session_reads_back() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join(LEGACY_STORE), b"{}").unwrap();
        write_messages(root.path(), "a", &json("[1]"), true, false).unwrap();
        write_messages(root.path(), "b", &json("[2]"), true, false).unwrap();
        let backup = root.path().join(LEGACY_BACKUP);
        assert!(backup.exists());

        let ids = vec!["a".to_string(), "b".to_string(), "missing".to_string()];
        assert_eq!(finish_migration(root.path(), &ids), Ok(false));
        assert!(backup.exists(), "an unverifiable session keeps the backup");

        fs::write(message_path(root.path(), "b").unwrap(), b"torn").unwrap();
        assert_eq!(
            finish_migration(root.path(), &["a".into(), "b".into()]),
            Ok(false)
        );
        assert!(
            backup.exists(),
            "an unreadable migrated file keeps the backup"
        );

        save(root.path(), "b", "[2]").unwrap();
        assert_eq!(
            finish_migration(root.path(), &["a".into(), "b".into()]),
            Ok(true)
        );
        assert!(!backup.exists());
        assert_eq!(
            finish_migration(root.path(), &["a".into()]),
            Ok(true),
            "idempotent"
        );
    }

    #[test]
    fn an_old_leftover_backup_is_pruned_but_a_recent_one_is_kept() {
        let root = tempfile::tempdir().unwrap();
        let day = Duration::from_secs(24 * 60 * 60);
        assert_eq!(
            prune_backup(root.path(), 7 * day, SystemTime::now()),
            Ok(false)
        );
        fs::write(root.path().join(LEGACY_BACKUP), b"{}").unwrap();
        assert_eq!(
            prune_backup(root.path(), 7 * day, SystemTime::now()),
            Ok(false)
        );
        assert!(root.path().join(LEGACY_BACKUP).exists());
        let later = SystemTime::now() + 8 * day;
        assert_eq!(prune_backup(root.path(), 7 * day, later), Ok(true));
        assert!(!root.path().join(LEGACY_BACKUP).exists());
    }

    #[test]
    fn deleting_a_session_scrubs_its_text_from_the_backup() {
        let root = tempfile::tempdir().unwrap();
        let legacy = r#"{"sessions":[{"id":"a"}],"messages:a":[{"text":"secret"}],"messages:b":[{"text":"keep"}]}"#;
        fs::write(root.path().join(LEGACY_STORE), legacy).unwrap();
        write_messages(root.path(), "a", &json("[1]"), true, false).unwrap();
        write_messages(root.path(), "b", &json("[2]"), true, false).unwrap();

        delete_messages(root.path(), "a").unwrap();
        let backup = fs::read_to_string(root.path().join(LEGACY_BACKUP)).unwrap();
        assert!(!backup.contains("secret"));
        assert!(backup.contains("keep"));
        assert!(!message_path(root.path(), "a").unwrap().exists());

        delete_messages(root.path(), "b").unwrap();
        assert!(
            !root.path().join(LEGACY_BACKUP).exists(),
            "the backup goes once it holds no conversations"
        );
    }

    #[test]
    fn an_unparseable_backup_does_not_survive_a_session_delete() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join(LEGACY_BACKUP), b"not json at all").unwrap();
        delete_messages(root.path(), "a").unwrap();
        assert!(!root.path().join(LEGACY_BACKUP).exists());
    }

    #[test]
    fn replacing_an_existing_session_leaves_no_partial_file_even_when_not_durable() {
        let root = tempfile::tempdir().unwrap();
        save(root.path(), "one", "[1]").unwrap();
        let big = format!("[{}]", "0,".repeat(200_000) + "0");
        save(root.path(), "one", &big).unwrap();
        assert_eq!(read(root.path(), "one").unwrap().len(), big.len());
        write_messages(root.path(), "one", b"[2]", false, true).unwrap();
        assert_eq!(read(root.path(), "one").as_deref(), Some("[2]"));
    }

    #[test]
    fn options_deserialize_with_defaults_so_a_plain_save_is_not_durable() {
        let options: SaveOptions = serde_json::from_str(r#"{"id":"s-1"}"#).unwrap();
        assert!(!options.migrate && !options.durable);
        let options: SaveOptions =
            serde_json::from_str(r#"{"id":"s-1","durable":true,"migrate":true}"#).unwrap();
        assert!(options.migrate && options.durable);
    }
}
