//! Live directory change notifications for the explorer and editor tabs.
//!
//! The frontend registers the directories it shows (and the files open in
//! editors) and receives debounced `fs:changed` events carrying the watched
//! directories that changed plus any registered file whose own stamp moved.
//! Backends only report directory-level activity, so a package install or a
//! build never turns into per-file work here.

mod plan;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(not(target_os = "macos"))]
mod portable;

use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use super::blocking;
use super::index::FileIndexState;
use super::to_canon;
use crate::modules::workspace::{resolve_path, WorkspaceEnv, WorkspaceRegistry};
use plan::{Batch, DirSet, FileStamp, Pending, WatchSet};

// Quiet-gap before a batch flushes; MAX_WINDOW caps latency under a long stream.
const DEBOUNCE: Duration = Duration::from_millis(150);
const MAX_WINDOW: Duration = Duration::from_millis(1000);

#[cfg(target_os = "macos")]
type PlatformBackend = macos::FsEvents;
#[cfg(not(target_os = "macos"))]
type PlatformBackend = portable::Notify;

trait Backend: Send {
    /// Brings the OS watches in line with `set`. Called after every change to
    /// the set; implementations must be a no-op when nothing relevant moved.
    fn sync(&mut self, set: &WatchSet);
}

/// What a backend callback needs: the live set of watched directories to
/// filter against, a way to report a batch, and the file-list cache.
#[derive(Clone)]
struct Sink {
    tx: mpsc::Sender<Batch>,
    dirs: Arc<RwLock<Arc<DirSet>>>,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    index: FileIndexState,
}

impl Sink {
    fn send(&self, batch: Batch) {
        if !batch.is_empty() {
            let _ = self.tx.send(batch);
        }
    }

    fn dirs(&self) -> Arc<DirSet> {
        self.dirs.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Any directory-level change, watched or not, can stale a file list.
    #[cfg(target_os = "macos")]
    fn note_path(&self, path: &[u8]) {
        if let Ok(text) = std::str::from_utf8(path) {
            self.index.note_change(text);
        }
    }
}

struct Shared {
    set: Mutex<WatchSet>,
    dirs: Arc<RwLock<Arc<DirSet>>>,
}

struct Running {
    shared: Arc<Shared>,
    backend: Box<dyn Backend>,
}

#[derive(Default)]
pub struct FsWatchState {
    inner: Mutex<Option<Running>>,
}

#[derive(Clone, serde::Serialize)]
struct ChangedPayload {
    paths: Vec<String>,
}

fn start(app: &AppHandle) -> Result<Running, String> {
    let (tx, rx) = mpsc::channel::<Batch>();
    let shared = Arc::new(Shared {
        set: Mutex::new(WatchSet::default()),
        dirs: Arc::new(RwLock::new(Arc::new(DirSet::new()))),
    });
    let index = app.state::<FileIndexState>().inner().clone();
    let sink = Sink {
        tx,
        dirs: shared.dirs.clone(),
        index: index.clone(),
    };
    let backend: Box<dyn Backend> = Box::new(PlatformBackend::new(sink)?);

    let drain_shared = shared.clone();
    let app = app.clone();
    std::thread::Builder::new()
        .name("terax-fs-watch".into())
        .stack_size(256 * 1024)
        .spawn(move || drain_loop(rx, drain_shared, app, index))
        .map_err(|e| e.to_string())?;
    Ok(Running { shared, backend })
}

fn drain_loop(
    rx: mpsc::Receiver<Batch>,
    shared: Arc<Shared>,
    app: AppHandle,
    index: FileIndexState,
) {
    loop {
        let Ok(first) = rx.recv() else { return };
        let mut pending = Pending::default();
        pending.merge(first);

        let deadline = Instant::now() + MAX_WINDOW;
        loop {
            let timeout = DEBOUNCE.min(deadline.saturating_duration_since(Instant::now()));
            match rx.recv_timeout(timeout) {
                Ok(batch) => pending.merge(batch),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
            if Instant::now() >= deadline {
                break;
            }
        }

        let paths = resolve_changes(pending, &shared);
        if paths.is_empty() {
            continue;
        }
        for path in &paths {
            index.note_change(path);
        }
        let _ = app.emit("fs:changed", ChangedPayload { paths });
    }
}

/// Watched directories that changed, plus registered files inside them whose
/// stamp moved.
fn resolve_changes(pending: Pending, shared: &Shared) -> Vec<String> {
    let mut set = shared.set.lock().unwrap_or_else(|e| e.into_inner());
    let dirs = pending.resolve(set.dir_keys());
    let stamp_of = |path: &str| FileStamp::of(std::path::Path::new(path));
    let mut paths = dirs.clone();
    for dir in &dirs {
        paths.extend(set.changed_files_in(dir, &stamp_of));
    }
    paths
}

// Canonical keys keep add/remove symmetric regardless of how the path was spelled.
fn prepare_dirs(
    registry: &WorkspaceRegistry,
    workspace: &WorkspaceEnv,
    paths: Vec<String>,
) -> Vec<PathBuf> {
    paths
        .into_iter()
        .filter_map(|raw| {
            let resolved = resolve_path(&raw, workspace);
            let canonical = std::fs::canonicalize(&resolved).ok()?;
            if !canonical.is_dir()
                || plan::is_skipped(&canonical)
                || !registry.is_authorized(&canonical)
            {
                return None;
            }
            Some(canonical)
        })
        .collect()
}

/// A file is identified by its canonical directory plus its own name, so the
/// path we report matches what editor tabs store even when the file itself no
/// longer exists.
fn canonical_file(workspace: &WorkspaceEnv, raw: &str) -> Option<(String, String, PathBuf)> {
    let resolved = resolve_path(raw, workspace);
    let name = resolved.file_name()?.to_owned();
    let parent = std::fs::canonicalize(resolved.parent()?).ok()?;
    let file = parent.join(name);
    Some((to_canon(&parent), to_canon(&file), file))
}

impl FsWatchState {
    fn with_running<T>(
        &self,
        app: &AppHandle,
        create: bool,
        f: impl FnOnce(&mut Running) -> T,
    ) -> Result<Option<T>, String> {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            if !create {
                return Ok(None);
            }
            *guard = Some(start(app)?);
        }
        Ok(guard.as_mut().map(f))
    }
}

impl Running {
    /// `change` reports whether the set of watched directories moved; file
    /// bookkeeping alone never touches the OS watches.
    fn apply(&mut self, change: impl FnOnce(&mut WatchSet) -> bool) {
        let mut set = self.shared.set.lock().unwrap_or_else(|e| e.into_inner());
        if !change(&mut set) {
            return;
        }
        *self.shared.dirs.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(set.snapshot());
        self.backend.sync(&set);
    }
}

#[tauri::command]
pub async fn fs_watch_add(
    app: AppHandle,
    paths: Vec<String>,
    files: Option<Vec<String>>,
    workspace: Option<WorkspaceEnv>,
) -> Result<(), String> {
    blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let dirs = prepare_dirs(&app.state::<WorkspaceRegistry>(), &workspace, paths);
        let files: Vec<_> = files
            .unwrap_or_default()
            .iter()
            .filter_map(|raw| canonical_file(&workspace, raw))
            .map(|(dir, key, path)| {
                let stamp = FileStamp::of(&path);
                (dir, key, stamp)
            })
            .collect();
        if dirs.is_empty() && files.is_empty() {
            return Ok(());
        }
        app.state::<FsWatchState>()
            .with_running(&app, true, |running| {
                running.apply(|set| {
                    let mut moved = false;
                    for dir in dirs {
                        moved |= set.add_dir(to_canon(&dir), dir);
                    }
                    for (dir, key, stamp) in files {
                        set.add_file(dir, key, stamp);
                    }
                    moved
                });
            })?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn fs_watch_remove(
    app: AppHandle,
    paths: Vec<String>,
    files: Option<Vec<String>>,
    workspace: Option<WorkspaceEnv>,
) -> Result<(), String> {
    blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        // A removed/renamed dir no longer canonicalizes; fall back so the
        // refcount entry is still released.
        let dirs: Vec<String> = paths
            .into_iter()
            .map(|raw| {
                let resolved = resolve_path(&raw, &workspace);
                to_canon(std::fs::canonicalize(&resolved).unwrap_or(resolved))
            })
            .collect();
        let files: Vec<(String, String)> = files
            .unwrap_or_default()
            .iter()
            .filter_map(|raw| canonical_file(&workspace, raw))
            .map(|(dir, key, _)| (dir, key))
            .collect();
        app.state::<FsWatchState>()
            .with_running(&app, false, |running| {
                running.apply(|set| {
                    let mut moved = false;
                    for dir in &dirs {
                        moved |= set.remove_dir(dir);
                    }
                    for (dir, key) in &files {
                        set.remove_file(dir, key);
                    }
                    moved
                });
            })?;
        Ok(())
    })
    .await
}
