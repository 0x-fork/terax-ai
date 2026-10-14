//! Latest-query-wins bookkeeping for interactive searches.
//!
//! Commands bump a named counter the moment they are dispatched, before any
//! blocking work starts, so an older search that is still walking sees the new
//! generation and stops. Searches of unrelated callers use different keys and
//! never cancel each other.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

const MAX_KEYS: usize = 16;
const MAX_KEY_LEN: usize = 64;

#[derive(Default)]
pub struct Supersede {
    counters: Mutex<HashMap<String, Arc<AtomicU64>>>,
}

pub struct Ticket {
    counter: Arc<AtomicU64>,
    mine: u64,
}

impl Ticket {
    pub fn is_current(&self) -> bool {
        self.counter.load(Ordering::SeqCst) == self.mine
    }

    pub fn is_superseded(&self) -> bool {
        !self.is_current()
    }
}

impl Supersede {
    pub fn begin(&self, key: &str) -> Ticket {
        let end = (0..=key.len().min(MAX_KEY_LEN))
            .rev()
            .find(|&i| key.is_char_boundary(i))
            .unwrap_or(0);
        let key = &key[..end];
        let counter = {
            let mut counters = self.counters.lock().unwrap_or_else(|e| e.into_inner());
            if !counters.contains_key(key) && counters.len() >= MAX_KEYS {
                counters.clear();
            }
            counters
                .entry(key.to_owned())
                .or_insert_with(|| Arc::new(AtomicU64::new(0)))
                .clone()
        };
        let mine = counter.fetch_add(1, Ordering::SeqCst) + 1;
        Ticket { counter, mine }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_newer_query_for_the_same_key_supersedes_the_older_one() {
        let state = Supersede::default();
        let first = state.begin("palette");
        assert!(first.is_current());
        let second = state.begin("palette");
        assert!(first.is_superseded());
        assert!(second.is_current());
    }

    #[test]
    fn unrelated_callers_never_cancel_each_other() {
        let state = Supersede::default();
        let explorer = state.begin("explorer");
        let agent = state.begin("agent");
        assert!(explorer.is_current());
        assert!(agent.is_current());
    }

    #[test]
    fn key_table_is_bounded_and_survivors_stay_consistent() {
        let state = Supersede::default();
        let keep = state.begin("keep");
        for i in 0..(MAX_KEYS * 2) {
            let _ = state.begin(&format!("k{i}"));
        }
        assert!(state.counters.lock().unwrap().len() <= MAX_KEYS);
        assert!(keep.is_current(), "eviction must not fake a supersession");
        assert!(state.begin("keep").is_current());
    }

    #[test]
    fn truncation_respects_utf8_boundaries() {
        let state = Supersede::default();
        let long = "\u{20ac}".repeat(100);
        let first = state.begin(&long);
        assert!(state.begin(&long).is_current());
        assert!(first.is_superseded());
    }

    #[test]
    fn oversized_keys_are_truncated_not_rejected() {
        let state = Supersede::default();
        let long = "x".repeat(500);
        let first = state.begin(&long);
        let second = state.begin(&long);
        assert!(first.is_superseded());
        assert!(second.is_current());
    }
}
