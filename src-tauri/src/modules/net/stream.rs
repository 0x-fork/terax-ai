use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use futures_util::future::{AbortHandle, AbortRegistration};
use tokio::sync::Semaphore;

pub const CHUNK_BYTES: usize = 64 * 1024;
const WINDOW_CHUNKS: u32 = 2;
const MAX_REQUESTS: usize = 16;
type Key = (String, String);

#[derive(Clone, Default)]
pub struct AiStreamState(Arc<Mutex<HashMap<Key, Arc<StreamControl>>>>);

pub struct StreamControl {
    abort: AbortHandle,
    permits: Semaphore,
    credit: Mutex<Credit>,
}

#[derive(Default)]
struct Credit {
    sent: u64,
    acknowledged: u64,
    boundaries: VecDeque<u64>,
}

pub struct StreamLease {
    state: AiStreamState,
    key: Key,
    pub control: Arc<StreamControl>,
}

impl AiStreamState {
    pub fn start(
        &self,
        window: &str,
        id: &str,
    ) -> Result<(StreamLease, AbortRegistration), String> {
        if id.is_empty()
            || id.len() > 64
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err("invalid AI request id".into());
        }
        let key = (window.to_owned(), id.to_owned());
        let mut requests = self.0.lock().unwrap();
        if requests.contains_key(&key) {
            return Err("AI request id is already active".into());
        }
        if requests.len() >= MAX_REQUESTS {
            return Err("too many active AI requests".into());
        }
        let (abort, registration) = AbortHandle::new_pair();
        let control = Arc::new(StreamControl {
            abort,
            permits: Semaphore::new(WINDOW_CHUNKS as usize),
            credit: Mutex::new(Credit::default()),
        });
        requests.insert(key.clone(), control.clone());
        Ok((
            StreamLease {
                state: self.clone(),
                key,
                control,
            },
            registration,
        ))
    }

    pub fn cancel(&self, window: &str, id: &str) {
        let request = self
            .0
            .lock()
            .unwrap()
            .get(&(window.to_owned(), id.to_owned()))
            .cloned();
        if let Some(request) = request {
            request.abort.abort();
        }
    }

    pub fn cancel_window(&self, window: &str) {
        let requests: Vec<_> = self
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|((owner, _), _)| owner == window)
            .map(|(_, request)| request.clone())
            .collect();
        for request in requests {
            request.abort.abort();
        }
    }

    pub fn acknowledge(&self, window: &str, id: &str, bytes: u64) -> Result<(), String> {
        let request = self
            .0
            .lock()
            .unwrap()
            .get(&(window.to_owned(), id.to_owned()))
            .cloned();
        match request {
            Some(request) => request.acknowledge(bytes),
            None => Ok(()),
        }
    }
}

impl Drop for StreamLease {
    fn drop(&mut self) {
        self.state.0.lock().unwrap().remove(&self.key);
    }
}

impl StreamControl {
    pub async fn reserve(&self, bytes: usize) -> Result<(), String> {
        if bytes == 0 || bytes > CHUNK_BYTES {
            return Err("invalid AI stream chunk size".into());
        }
        let permit = self
            .permits
            .acquire()
            .await
            .map_err(|_| "AI stream closed")?;
        let mut credit = self.credit.lock().unwrap();
        credit.sent = credit
            .sent
            .checked_add(bytes as u64)
            .ok_or("AI stream byte offset overflow")?;
        let end = credit.sent;
        credit.boundaries.push_back(end);
        permit.forget();
        Ok(())
    }

    pub async fn drained(&self) -> Result<(), String> {
        let _permit = self
            .permits
            .acquire_many(WINDOW_CHUNKS)
            .await
            .map_err(|_| "AI stream closed")?;
        Ok(())
    }

    fn acknowledge(&self, bytes: u64) -> Result<(), String> {
        let mut credit = self.credit.lock().unwrap();
        if bytes <= credit.acknowledged {
            return Ok(());
        }
        let count = credit
            .boundaries
            .iter()
            .position(|boundary| *boundary == bytes)
            .ok_or("invalid AI stream acknowledgment")?
            + 1;
        credit.boundaries.drain(..count);
        credit.acknowledged = bytes;
        drop(credit);
        self.permits.add_permits(count);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{future::Abortable, FutureExt};

    #[test]
    fn credits_bound_chunks_and_reject_duplicate_or_unearned_credit() {
        let state = AiStreamState::default();
        let (lease, _) = state.start("main", "request").unwrap();
        let c = &lease.control;
        assert_eq!(c.reserve(CHUNK_BYTES).now_or_never(), Some(Ok(())));
        assert_eq!(c.reserve(10).now_or_never(), Some(Ok(())));
        assert!(c.reserve(10).now_or_never().is_none());
        assert!(state.acknowledge("main", "request", 1).is_err());
        assert_eq!(c.permits.available_permits(), 0);
        state
            .acknowledge("main", "request", CHUNK_BYTES as u64 + 10)
            .unwrap();
        state
            .acknowledge("main", "request", CHUNK_BYTES as u64)
            .unwrap();
        state
            .acknowledge("main", "request", CHUNK_BYTES as u64 + 10)
            .unwrap();
        assert_eq!(c.permits.available_permits(), 2);
        assert_eq!(c.drained().now_or_never(), Some(Ok(())));
    }

    #[test]
    fn cancellation_is_owned_by_the_calling_window_and_releases_registration() {
        let state = AiStreamState::default();
        let (lease, registration) = state.start("main", "request").unwrap();
        state.cancel("settings", "request");
        assert!(!lease.control.abort.is_aborted());
        state.cancel("main", "request");
        assert!(Abortable::new(std::future::pending::<()>(), registration)
            .now_or_never()
            .unwrap()
            .is_err());
        drop(lease);
        assert!(state.0.lock().unwrap().is_empty());
    }

    #[test]
    fn closing_a_window_aborts_requests_waiting_for_consumer_credit() {
        let state = AiStreamState::default();
        let (lease, registration) = state.start("main", "request").unwrap();
        lease.control.reserve(10).now_or_never().unwrap().unwrap();
        lease.control.reserve(10).now_or_never().unwrap().unwrap();
        state.cancel_window("main");
        assert!(Abortable::new(lease.control.drained(), registration)
            .now_or_never()
            .unwrap()
            .is_err());
    }

    #[test]
    fn registrations_are_bounded_and_ids_cannot_replace_live_owners() {
        let state = AiStreamState::default();
        let leases: Vec<_> = (0..MAX_REQUESTS)
            .map(|i| state.start("main", &i.to_string()).unwrap())
            .collect();
        assert!(state.start("main", "0").is_err());
        assert!(state.start("main", "overflow").is_err());
        drop(leases);
        assert!(state.start("main", "new").is_ok());
        assert!(state.start("main", "../invalid").is_err());
    }
}
