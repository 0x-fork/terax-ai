//! FSEvents backend.
//!
//! notify's macOS watcher asks for per-file events with zero latency and
//! rebuilds its stream on a new thread for every watch or unwatch. During a
//! package install or a build that is tens of thousands of callbacks a second,
//! each one walking every watched directory and allocating a path. This backend
//! instead keeps one stream over the fewest covering roots, asks for
//! directory-level events with a short coalescing latency, excludes the heavy
//! top-level directories at the source, and filters every event with a single
//! hash lookup. Callbacks run on a private dispatch queue, so no thread exists
//! while nothing is watched and the stream is only rebuilt when the covering
//! roots or exclusions change.

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::Path;

use fsevent_sys as fs;
use fsevent_sys::core_foundation as cf;

use super::plan::{self, WatchSet};
use super::{Backend, Sink};

/// FSEvents coalesces to this interval; the debounce downstream stays 150 ms.
const LATENCY_SECONDS: f64 = 0.1;

extern "C" {
    fn dispatch_queue_create(label: *const c_char, attr: *const c_void) -> *mut c_void;
    fn dispatch_release(object: *mut c_void);
    fn FSEventStreamSetDispatchQueue(stream: fs::FSEventStreamRef, queue: *mut c_void);
}

#[derive(Clone, PartialEq, Eq, Debug)]
struct StreamSpec {
    roots: Vec<String>,
    exclusions: Vec<String>,
}

struct CallbackContext {
    sink: Sink,
}

/// Freed by FSEvents when the stream is deallocated, which also covers any
/// callback that was already queued when the stream was stopped.
extern "C" fn release_context(info: *const c_void) {
    drop(unsafe { Box::from_raw(info as *mut CallbackContext) });
}

extern "C" fn callback(
    _stream: fs::FSEventStreamRef,
    info: *mut c_void,
    count: usize,
    paths: *mut c_void,
    event_flags: *const fs::FSEventStreamEventFlags,
    _ids: *const fs::FSEventStreamEventId,
) {
    let context = unsafe { &*(info as *const CallbackContext) };
    let paths = paths as *const *const c_char;
    // Without kFSEventStreamCreateFlagUseCFTypes the paths are plain C strings.
    let events = (0..count).map(|i| unsafe {
        (
            CStr::from_ptr(*paths.add(i)).to_bytes(),
            *event_flags.add(i),
        )
    });
    let dirs = context.sink.dirs();
    let batch = plan::reduce_directory_events(events, &dirs, &mut |path| {
        context.sink.note_path(path);
    });
    context.sink.send(batch);
}

struct Stream {
    raw: fs::FSEventStreamRef,
}

// The stream is only touched under the backend's `&mut self`.
unsafe impl Send for Stream {}

impl Stream {
    fn start(spec: &StreamSpec, queue: *mut c_void, context: CallbackContext) -> Option<Self> {
        let context = Box::into_raw(Box::new(context));
        let free_context = || release_context(context as *const c_void);
        unsafe {
            let paths = cf_string_array(&spec.roots);
            if paths.is_null() {
                free_context();
                return None;
            }
            let stream_context = fs::FSEventStreamContext {
                version: 0,
                info: context as *mut c_void,
                retain: None,
                release: Some(release_context),
                copy_description: None,
            };
            let raw = fs::FSEventStreamCreate(
                cf::kCFAllocatorDefault,
                callback,
                &stream_context,
                paths,
                fs::kFSEventStreamEventIdSinceNow,
                LATENCY_SECONDS,
                // Directory-level events only: no FileEvents, no NoDefer.
                fs::kFSEventStreamCreateFlagNone,
            );
            cf::CFRelease(paths);
            if raw.is_null() {
                free_context();
                return None;
            }
            if !spec.exclusions.is_empty() {
                let excluded = cf_string_array(&spec.exclusions);
                if !excluded.is_null() {
                    if fs::FSEventStreamSetExclusionPaths(raw, excluded) == 0 {
                        log::debug!("fsevents: exclusion paths rejected");
                    }
                    cf::CFRelease(excluded);
                }
            }
            FSEventStreamSetDispatchQueue(raw, queue);
            if fs::FSEventStreamStart(raw) == 0 {
                fs::FSEventStreamInvalidate(raw);
                fs::FSEventStreamRelease(raw);
                return None;
            }
            Some(Self { raw })
        }
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        unsafe {
            fs::FSEventStreamStop(self.raw);
            fs::FSEventStreamInvalidate(self.raw);
            fs::FSEventStreamRelease(self.raw);
        }
    }
}

/// A CFArray of CFStrings, or null if nothing could be converted.
unsafe fn cf_string_array(items: &[String]) -> cf::CFMutableArrayRef {
    let array = cf::CFArrayCreateMutable(cf::kCFAllocatorDefault, 0, &cf::kCFTypeArrayCallBacks);
    if array.is_null() {
        return array;
    }
    for item in items {
        let Ok(c_string) = CString::new(item.as_str()) else {
            continue;
        };
        let string = cf::CFStringCreateWithCString(
            cf::kCFAllocatorDefault,
            c_string.as_ptr(),
            cf::kCFStringEncodingUTF8,
        );
        if !string.is_null() {
            cf::CFArrayAppendValue(array, string);
            cf::CFRelease(string);
        }
    }
    if cf::CFArrayGetCount(array) == 0 {
        cf::CFRelease(array);
        return std::ptr::null_mut();
    }
    array
}

pub struct FsEvents {
    queue: *mut c_void,
    sink: Sink,
    spec: Option<StreamSpec>,
    stream: Option<Stream>,
}

// `queue` is an immutable libdispatch handle owned by this backend.
unsafe impl Send for FsEvents {}

impl FsEvents {
    pub fn new(sink: Sink) -> Result<Self, String> {
        let label = CString::new("app.crynta.terax.fsevents").expect("static label");
        let queue = unsafe { dispatch_queue_create(label.as_ptr(), std::ptr::null()) };
        if queue.is_null() {
            return Err("could not create the file-event queue".into());
        }
        Ok(Self {
            queue,
            sink,
            spec: None,
            stream: None,
        })
    }
}

impl Drop for FsEvents {
    fn drop(&mut self) {
        self.stream = None;
        unsafe { dispatch_release(self.queue) };
    }
}

fn is_dir(path: &str) -> bool {
    Path::new(path).is_dir()
}

impl Backend for FsEvents {
    fn sync(&mut self, set: &WatchSet) {
        let roots = set.covering_roots();
        let wanted = (!roots.is_empty()).then(|| StreamSpec {
            exclusions: plan::exclusion_paths(&roots, set, &is_dir),
            roots,
        });
        if wanted == self.spec {
            return;
        }
        // Drop the old stream before creating the next so no two streams ever
        // deliver the same change.
        self.stream = None;
        self.stream = wanted.as_ref().and_then(|spec| {
            let stream = Stream::start(
                spec,
                self.queue,
                CallbackContext {
                    sink: self.sink.clone(),
                },
            );
            if stream.is_none() {
                log::warn!("fsevents: could not start a stream for {:?}", spec.roots);
            }
            stream
        });
        // A failed start leaves the spec unset so the next change retries.
        self.spec = wanted.filter(|_| self.stream.is_some());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::fs::index::FileIndexState;
    use crate::modules::fs::to_canon;
    use plan::Batch;
    use std::sync::mpsc::{self, Receiver};
    use std::sync::{Arc, RwLock};
    use std::time::{Duration, Instant};

    struct Fixture {
        backend: FsEvents,
        sink: Sink,
        rx: Receiver<Batch>,
        set: WatchSet,
    }

    impl Fixture {
        fn new() -> Self {
            let (tx, rx) = mpsc::channel();
            let sink = Sink {
                tx,
                dirs: Arc::new(RwLock::new(Arc::new(plan::DirSet::new()))),
                index: FileIndexState::default(),
            };
            Self {
                backend: FsEvents::new(sink.clone()).unwrap(),
                sink,
                rx,
                set: WatchSet::default(),
            }
        }

        fn watch(&mut self, dir: &Path) {
            let canonical = std::fs::canonicalize(dir).unwrap();
            self.set.add_dir(to_canon(&canonical), canonical);
            *self.sink.dirs.write().unwrap() = Arc::new(self.set.snapshot());
            self.backend.sync(&self.set);
            // FSEvents attaches asynchronously; let the stream become live.
            std::thread::sleep(Duration::from_millis(300));
        }

        fn drain(&self, wait: Duration) -> Vec<String> {
            let deadline = Instant::now() + wait;
            let mut dirs = Vec::new();
            while let Some(left) = deadline.checked_duration_since(Instant::now()) {
                if let Ok(batch) = self.rx.recv_timeout(left.min(Duration::from_millis(100))) {
                    dirs.extend(batch.dirs);
                }
            }
            dirs.sort();
            dirs.dedup();
            dirs
        }
    }

    fn canon(path: &Path) -> String {
        to_canon(std::fs::canonicalize(path).unwrap())
    }

    #[test]
    fn changes_in_a_watched_directory_report_that_directory_only() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("src/nested")).unwrap();
        std::fs::create_dir_all(root.path().join("node_modules/pkg")).unwrap();
        let mut fx = Fixture::new();
        fx.watch(&root.path().join("src"));
        fx.drain(Duration::from_millis(300));

        std::fs::write(root.path().join("src/a.txt"), "one").unwrap();
        assert_eq!(
            fx.drain(Duration::from_millis(900)),
            vec![canon(&root.path().join("src"))]
        );

        // Content edits of an existing file are directory events too.
        std::fs::write(root.path().join("src/a.txt"), "two, longer").unwrap();
        assert_eq!(
            fx.drain(Duration::from_millis(900)),
            vec![canon(&root.path().join("src"))]
        );

        // A subdirectory nobody expanded is not reported.
        std::fs::write(root.path().join("src/nested/b.txt"), "x").unwrap();
        assert!(fx.drain(Duration::from_millis(900)).is_empty());
    }

    #[test]
    fn a_burst_of_file_events_collapses_to_one_directory_report() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("out")).unwrap();
        let mut fx = Fixture::new();
        fx.watch(root.path());
        fx.drain(Duration::from_millis(300));

        for i in 0..1500 {
            std::fs::write(root.path().join(format!("out/f{i}.txt")), "x").unwrap();
        }
        std::fs::write(root.path().join("top.txt"), "x").unwrap();
        let reported = fx.drain(Duration::from_millis(1200));
        assert_eq!(reported, vec![canon(root.path())]);
    }

    #[test]
    fn heavy_directories_under_a_root_are_excluded_unless_something_in_them_is_watched() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(root.path().join("src")).unwrap();
        let mut fx = Fixture::new();
        fx.watch(root.path());
        fx.watch(&root.path().join("src"));
        let spec = fx.backend.spec.clone().expect("stream running");
        assert_eq!(spec.roots, vec![canon(root.path())]);
        assert_eq!(
            spec.exclusions,
            vec![format!("{}/node_modules", canon(root.path()))]
        );

        fx.watch(&root.path().join("node_modules/pkg"));
        let spec = fx.backend.spec.clone().expect("stream restarted");
        assert!(
            spec.exclusions.is_empty(),
            "a watched directory inside is not excluded"
        );
        std::fs::write(root.path().join("node_modules/pkg/index.js"), "x").unwrap();
        assert!(fx
            .drain(Duration::from_millis(900))
            .contains(&canon(&root.path().join("node_modules/pkg"))));
    }

    #[test]
    fn the_stream_is_rebuilt_only_when_the_covering_roots_change() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("a/b")).unwrap();
        let mut fx = Fixture::new();
        fx.watch(root.path());
        let first = fx.backend.stream.as_ref().map(|s| s.raw as usize);
        fx.watch(&root.path().join("a"));
        fx.watch(&root.path().join("a/b"));
        assert_eq!(
            fx.backend.stream.as_ref().map(|s| s.raw as usize),
            first,
            "nested directories are covered by the existing stream"
        );
        fx.set.remove_dir(&canon(root.path()));
        fx.backend.sync(&fx.set);
        assert_eq!(
            fx.backend.spec.as_ref().map(|s| s.roots.clone()),
            Some(vec![canon(&root.path().join("a"))])
        );
    }

    #[test]
    fn unwatching_everything_stops_the_stream() {
        let root = tempfile::tempdir().unwrap();
        let mut fx = Fixture::new();
        fx.watch(root.path());
        assert!(fx.backend.stream.is_some());
        fx.set.remove_dir(&canon(root.path()));
        fx.backend.sync(&fx.set);
        assert!(fx.backend.stream.is_none());
        std::fs::write(root.path().join("late.txt"), "x").unwrap();
        assert!(fx.drain(Duration::from_millis(600)).is_empty());
    }
}
