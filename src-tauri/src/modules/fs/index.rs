//! Per-root file-list cache behind `fs_search` and `fs_list_files`.
//!
//! A keystroke in the explorer search used to re-walk up to 50k entries. The
//! walk now happens once per root, the result is kept in a packed buffer, and
//! each query only ranks it. Entries go stale on watcher events, on our own
//! mutations, and after a TTL. A changed entry is dropped on the spot and
//! rebuilt lazily by the next query, so an idle app holds at most two bounded
//! buffers and runs nothing.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ignore::WalkBuilder;

use super::to_canon;

/// Hard cap on entries a walk may visit. Protects against roots like $HOME
/// where there is no .gitignore and the tree is effectively unbounded.
pub const MAX_SCANNED: usize = 50_000;

/// Directory names pruned unconditionally; they dominate scan time when present
/// and are rarely useful in a file finder.
pub const PRUNE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    ".venv",
    "__pycache__",
];

const MAX_SLOTS: usize = 2;
const TTL: Duration = Duration::from_secs(45);
/// Upper bound on the packed path text of one index (about 50k typical paths).
const MAX_PACKED_BYTES: usize = 16 * 1024 * 1024;
const DIR_BIT: u32 = 1 << 31;

/// Paths of one walk in a single string plus end offsets: about 12 bytes of
/// overhead per entry instead of a heap allocation each.
#[derive(Default)]
pub struct Packed {
    buf: String,
    ends: Vec<u32>,
}

impl Packed {
    /// False when the buffer budget is exhausted; the entry is not stored.
    pub(crate) fn push(&mut self, rel: &str, is_dir: bool) -> bool {
        if self.buf.len() + rel.len() > MAX_PACKED_BYTES || self.ends.len() >= MAX_SCANNED {
            return false;
        }
        self.buf.push_str(rel);
        let end = self.buf.len() as u32;
        self.ends.push(if is_dir { end | DIR_BIT } else { end });
        true
    }

    pub fn len(&self) -> usize {
        self.ends.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ends.is_empty()
    }

    pub fn get(&self, index: usize) -> (&str, bool) {
        let start = if index == 0 {
            0
        } else {
            (self.ends[index - 1] & !DIR_BIT) as usize
        };
        let raw = self.ends[index];
        (
            &self.buf[start..(raw & !DIR_BIT) as usize],
            raw & DIR_BIT != 0,
        )
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, bool)> {
        (0..self.len()).map(|i| self.get(i))
    }

    #[cfg(test)]
    fn heap_bytes(&self) -> usize {
        self.buf.capacity() + self.ends.capacity() * std::mem::size_of::<u32>()
    }
}

pub struct FileIndex {
    pub entries: Packed,
    /// The walk stopped at a budget; results are a prefix of the tree.
    pub truncated: bool,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct IndexKey {
    pub root: PathBuf,
    pub show_hidden: bool,
    pub max_depth: Option<usize>,
}

struct Slot {
    key: IndexKey,
    /// Canonical root with a trailing separator, to match watcher event paths.
    event_prefix: String,
    index: Arc<FileIndex>,
    built_at: Instant,
    last_used: Instant,
}

#[derive(Default)]
struct Inner {
    slots: Mutex<Vec<Slot>>,
    /// Serializes cold walks so concurrent queries for one root share a build.
    build: Mutex<()>,
}

#[derive(Clone, Default)]
pub struct FileIndexState(Arc<Inner>);

fn event_prefix(root: &Path) -> String {
    let canonical = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let mut prefix = to_canon(canonical);
    if !prefix.ends_with('/') {
        prefix.push('/');
    }
    prefix
}

/// Changes inside pruned directories never show up in an index, so they must
/// not invalidate one (a package install would otherwise rebuild per keystroke).
fn is_pruned_relative(relative: &str) -> bool {
    relative
        .split(['/', '\\'])
        .any(|component| PRUNE_DIRS.contains(&component))
}

impl FileIndexState {
    /// Returns the cached index for `key` or builds it.
    pub fn get_or_build(&self, key: &IndexKey) -> Arc<FileIndex> {
        self.get_or_build_with(key, Instant::now(), || build_index(key))
    }

    pub(crate) fn get_or_build_with(
        &self,
        key: &IndexKey,
        now: Instant,
        build: impl FnOnce() -> FileIndex,
    ) -> Arc<FileIndex> {
        if let Some(hit) = self.lookup(key, now) {
            return hit;
        }
        let _build = self.0.build.lock().unwrap_or_else(|e| e.into_inner());
        // Another caller may have finished the same walk while we waited.
        if let Some(hit) = self.lookup(key, now) {
            return hit;
        }
        let index = Arc::new(build());
        self.insert(key, index.clone(), now);
        index
    }

    fn lookup(&self, key: &IndexKey, now: Instant) -> Option<Arc<FileIndex>> {
        let mut slots = self.0.slots.lock().unwrap_or_else(|e| e.into_inner());
        slots.retain(|slot| now.saturating_duration_since(slot.built_at) < TTL);
        let slot = slots.iter_mut().find(|slot| slot.key == *key)?;
        slot.last_used = now;
        Some(slot.index.clone())
    }

    fn insert(&self, key: &IndexKey, index: Arc<FileIndex>, now: Instant) {
        let prefix = event_prefix(&key.root);
        let mut slots = self.0.slots.lock().unwrap_or_else(|e| e.into_inner());
        slots.retain(|slot| slot.key != *key);
        while slots.len() >= MAX_SLOTS {
            let oldest = slots
                .iter()
                .enumerate()
                .min_by_key(|(_, slot)| slot.last_used)
                .map(|(i, _)| i)
                .unwrap_or(0);
            slots.swap_remove(oldest);
        }
        slots.push(Slot {
            key: key.clone(),
            event_prefix: prefix,
            index,
            built_at: now,
            last_used: now,
        });
    }

    /// A filesystem change at `path` (an event path or a directory we mutated).
    /// Frees the matching buffers immediately; the next query rebuilds.
    pub fn note_change(&self, path: &str) {
        let path = path.trim_end_matches('/');
        let mut slots = self.0.slots.lock().unwrap_or_else(|e| e.into_inner());
        if slots.is_empty() {
            return;
        }
        slots.retain(|slot| {
            let root = slot.event_prefix.trim_end_matches('/');
            let covered = if path == root {
                true
            } else if let Some(rest) = path.strip_prefix(&slot.event_prefix) {
                !is_pruned_relative(rest)
            } else {
                // A change to an ancestor (rename of a parent) also invalidates.
                root.strip_prefix(path)
                    .is_some_and(|rest| rest.starts_with('/'))
            };
            !covered
        });
    }

    #[cfg(test)]
    fn slot_count(&self) -> usize {
        self.0.slots.lock().unwrap().len()
    }

    #[cfg(test)]
    fn cached_bytes(&self) -> usize {
        self.0
            .slots
            .lock()
            .unwrap()
            .iter()
            .map(|slot| slot.index.entries.heap_bytes())
            .sum()
    }
}

fn build_index(key: &IndexKey) -> FileIndex {
    let walker = WalkBuilder::new(&key.root)
        .hidden(!key.show_hidden)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .max_depth(key.max_depth)
        .filter_entry(|dent| {
            // Prune known-heavy dirs even when no .gitignore is present.
            if dent.depth() == 0 {
                return true;
            }
            match dent.file_name().to_str() {
                Some(name) => !PRUNE_DIRS.contains(&name),
                None => true,
            }
        })
        .build();

    let mut entries = Packed::default();
    let mut scanned = 0usize;
    let mut truncated = false;
    for dent in walker.flatten() {
        scanned += 1;
        if scanned > MAX_SCANNED {
            truncated = true;
            break;
        }
        let Ok(relative) = dent.path().strip_prefix(&key.root) else {
            continue;
        };
        let rel = to_canon(relative);
        if rel.is_empty() {
            continue;
        }
        let is_dir = dent.file_type().is_some_and(|t| t.is_dir());
        if !entries.push(&rel, is_dir) {
            truncated = true;
            break;
        }
    }
    FileIndex { entries, truncated }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn key(root: &Path) -> IndexKey {
        IndexKey {
            root: root.to_path_buf(),
            show_hidden: false,
            max_depth: None,
        }
    }

    fn tree() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src/deep")).unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        std::fs::write(dir.path().join("src/a.rs"), "").unwrap();
        std::fs::write(dir.path().join("src/deep/b.rs"), "").unwrap();
        std::fs::write(dir.path().join("node_modules/pkg/index.js"), "").unwrap();
        dir
    }

    #[test]
    fn packed_round_trips_entries_and_directory_flags() {
        let mut packed = Packed::default();
        assert!(packed.push("src", true));
        assert!(packed.push("src/a.rs", false));
        assert!(packed.push("", false));
        assert_eq!(packed.len(), 3);
        assert_eq!(packed.get(0), ("src", true));
        assert_eq!(packed.get(1), ("src/a.rs", false));
        assert_eq!(packed.get(2), ("", false));
        assert_eq!(packed.iter().count(), 3);
    }

    #[test]
    fn packed_refuses_entries_past_its_budgets() {
        let mut packed = Packed::default();
        for i in 0..MAX_SCANNED {
            assert!(packed.push(&i.to_string(), false));
        }
        assert!(!packed.push("one-too-many", false));
        let mut huge = Packed::default();
        assert!(!huge.push(&"x".repeat(MAX_PACKED_BYTES + 1), false));
    }

    #[test]
    fn walk_lists_files_and_dirs_and_prunes_heavy_directories() {
        let dir = tree();
        let index = build_index(&key(dir.path()));
        let mut rels: Vec<_> = index
            .entries
            .iter()
            .map(|(r, d)| (r.to_string(), d))
            .collect();
        rels.sort();
        assert_eq!(
            rels,
            vec![
                ("src".to_string(), true),
                ("src/a.rs".to_string(), false),
                ("src/deep".to_string(), true),
                ("src/deep/b.rs".to_string(), false),
            ]
        );
        assert!(!index.truncated);
    }

    #[test]
    fn depth_limit_is_part_of_the_walk() {
        let dir = tree();
        let mut shallow = key(dir.path());
        shallow.max_depth = Some(1);
        let index = build_index(&shallow);
        assert!(index.entries.iter().all(|(rel, _)| !rel.contains("deep/")));
    }

    #[test]
    fn a_fresh_index_is_reused_until_a_change_arrives() {
        let dir = tree();
        let state = FileIndexState::default();
        let builds = AtomicUsize::new(0);
        let now = Instant::now();
        let k = key(dir.path());
        let get = |at: Instant| {
            state.get_or_build_with(&k, at, || {
                builds.fetch_add(1, Ordering::SeqCst);
                build_index(&k)
            })
        };
        get(now);
        get(now + Duration::from_secs(1));
        assert_eq!(builds.load(Ordering::SeqCst), 1);

        let canonical = std::fs::canonicalize(dir.path()).unwrap();
        state.note_change(&to_canon(canonical.join("src")));
        assert_eq!(
            state.slot_count(),
            0,
            "changed index is dropped, not kept stale"
        );
        get(now + Duration::from_secs(2));
        assert_eq!(builds.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn changes_inside_pruned_directories_do_not_invalidate() {
        let dir = tree();
        let state = FileIndexState::default();
        let k = key(dir.path());
        let now = Instant::now();
        state.get_or_build_with(&k, now, || build_index(&k));
        let canonical = std::fs::canonicalize(dir.path()).unwrap();
        state.note_change(&to_canon(canonical.join("node_modules/pkg")));
        state.note_change(&to_canon(canonical.join("target")));
        state.note_change("/somewhere/else");
        assert_eq!(state.slot_count(), 1);
        state.note_change(&to_canon(&canonical));
        assert_eq!(state.slot_count(), 0, "a change at the root itself counts");
    }

    #[test]
    fn a_renamed_ancestor_invalidates_the_index() {
        let dir = tree();
        let state = FileIndexState::default();
        let k = key(&dir.path().join("src"));
        state.get_or_build_with(&k, Instant::now(), || build_index(&k));
        let canonical = std::fs::canonicalize(dir.path()).unwrap();
        state.note_change(&to_canon(&canonical));
        assert_eq!(state.slot_count(), 0);
    }

    #[test]
    fn entries_expire_after_the_ttl() {
        let dir = tree();
        let state = FileIndexState::default();
        let builds = AtomicUsize::new(0);
        let k = key(dir.path());
        let now = Instant::now();
        let get = |at: Instant| {
            state.get_or_build_with(&k, at, || {
                builds.fetch_add(1, Ordering::SeqCst);
                build_index(&k)
            })
        };
        get(now);
        get(now + TTL - Duration::from_secs(1));
        assert_eq!(builds.load(Ordering::SeqCst), 1);
        get(now + TTL + Duration::from_secs(1));
        assert_eq!(builds.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn memory_is_bounded_by_evicting_the_least_recently_used_root() {
        let state = FileIndexState::default();
        let dirs: Vec<_> = (0..3).map(|_| tree()).collect();
        let now = Instant::now();
        for (i, dir) in dirs.iter().enumerate() {
            let k = key(dir.path());
            state.get_or_build_with(&k, now + Duration::from_secs(i as u64), || build_index(&k));
        }
        assert_eq!(state.slot_count(), MAX_SLOTS);
        assert!(state.cached_bytes() < 64 * 1024);
        let slots = state.0.slots.lock().unwrap();
        assert!(slots.iter().all(|slot| slot.key.root != dirs[0].path()));
    }

    #[test]
    fn different_visibility_or_depth_are_separate_entries() {
        let dir = tree();
        let state = FileIndexState::default();
        let now = Instant::now();
        let mut hidden = key(dir.path());
        hidden.show_hidden = true;
        let shown = key(dir.path());
        let builds = AtomicUsize::new(0);
        for k in [&hidden, &shown, &hidden, &shown] {
            state.get_or_build_with(k, now, || {
                builds.fetch_add(1, Ordering::SeqCst);
                build_index(k)
            });
        }
        assert_eq!(builds.load(Ordering::SeqCst), 2);
    }
}
