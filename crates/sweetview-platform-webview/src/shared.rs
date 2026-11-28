//! What crosses threads: the queue of work for the UI thread, the ids of
//! answers already submitted, the table of open streamed bodies, and the
//! [`Responder`] that feeds them from any thread. Safe code with no OS call,
//! ported from `engine_base.hh` (`complete_request`, `begin_response`,
//! `write_response_chunk`, `end_response`, the alive token) and the streaming
//! half of `win32_edge.hh`.
//!
//! Lock order: `streams` before a stream's own lock; a stream's lock before
//! `queue`. `queue` and `submitted` are never held while another is taken.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::thread::ThreadId;

use sweetview_http::{validate_body_len, validate_request_id, validate_response_head, ErrorCode, Header};

use crate::stream::StreamState;
pub use crate::stream::BACKLOG_LIMIT;

/// Work queued for the UI thread, run by `WebviewExtras::drain`.
pub(crate) enum Job {
    /// An answer from [`Responder::complete`].
    Complete { id: u64, status: i32, headers: Vec<Header>, body: Vec<u8> },
    /// The head of a streamed answer from [`Responder::begin`].
    BeginStream { id: u64, status: i32, headers: Vec<Header>, stream: Arc<StreamState> },
    /// WebView2 let go of a streamed body before it ended; forget it if it is
    /// still the one registered (`key` is its address).
    ForgetAbandoned { id: u64, key: usize },
    /// Paths of a file drop, delivered after the drop event has returned.
    FileDrop(Vec<String>),
}

struct Queue {
    alive: bool,
    jobs: VecDeque<Job>,
}

pub(crate) struct Shared {
    queue: Mutex<Queue>,
    submitted: Mutex<HashSet<u64>>,
    streams: Mutex<HashMap<u64, Arc<StreamState>>>,
    wake: Arc<dyn Fn() + Send + Sync>,
    /// The thread that made this (the UI thread): its writes to a streamed
    /// body never wait.
    ui_thread: ThreadId,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn stream_key(stream: &Arc<StreamState>) -> usize {
    Arc::as_ptr(stream) as usize
}

/// Request ids handed to the request handler: never 0 and never reused across
/// the whole process, so a late answer carrying an id from a dropped webview
/// can never match a request of a newer one.
pub(crate) fn next_request_id() -> u64 {
    // Global state in a form `UNSAFE-POLICY.md` lists: a `OnceLock`, holding the
    // atomic every thread counts with.
    static COUNTER: OnceLock<AtomicU64> = OnceLock::new();
    COUNTER.get_or_init(|| AtomicU64::new(1)).fetch_add(1, Ordering::Relaxed)
}

impl Shared {
    pub(crate) fn new(wake: Arc<dyn Fn() + Send + Sync>) -> Arc<Self> {
        Arc::new(Self {
            queue: Mutex::new(Queue { alive: true, jobs: VecDeque::new() }),
            submitted: Mutex::new(HashSet::new()),
            streams: Mutex::new(HashMap::new()),
            wake,
            ui_thread: std::thread::current().id(),
        })
    }

    fn open_stream(&self, id: u64) -> Option<Arc<StreamState>> {
        lock(&self.streams).get(&id).cloned()
    }

    pub(crate) fn is_alive(&self) -> bool {
        lock(&self.queue).alive
    }

    /// Queues `job` and wakes the UI thread; refused once the webview is going.
    pub(crate) fn dispatch(&self, job: Job) -> Result<(), ErrorCode> {
        {
            let mut queue = lock(&self.queue);
            if !queue.alive {
                return Err(ErrorCode::InvalidState);
            }
            queue.jobs.push_back(job);
        }
        (self.wake)();
        Ok(())
    }

    /// The oldest queued job, taken out of the lock so running it may queue more.
    pub(crate) fn next_job(&self) -> Option<Job> {
        let mut queue = lock(&self.queue);
        if !queue.alive {
            return None;
        }
        queue.jobs.pop_front()
    }

    /// True while an answer or a streamed head for `id` is queued and the UI
    /// thread has not taken it yet.
    pub(crate) fn is_submitted(&self, id: u64) -> bool {
        lock(&self.submitted).contains(&id)
    }

    pub(crate) fn forget_submitted(&self, id: u64) {
        lock(&self.submitted).remove(&id);
    }

    fn mark_submitted(&self, id: u64) -> bool {
        lock(&self.submitted).insert(id)
    }

    /// Aborts `stream` and forgets it, if it is still the one registered.
    pub(crate) fn drop_stream(&self, id: u64, stream: &Arc<StreamState>) {
        let mut streams = lock(&self.streams);
        stream.abort();
        if streams.get(&id).is_some_and(|s| Arc::ptr_eq(s, stream)) {
            streams.remove(&id);
        }
    }

    /// UI thread, for [`Job::ForgetAbandoned`]: the stream already aborted itself.
    pub(crate) fn forget_abandoned_stream(&self, id: u64, key: usize) {
        let mut streams = lock(&self.streams);
        if streams.get(&id).is_some_and(|s| stream_key(s) == key) {
            streams.remove(&id);
        }
    }

    /// Teardown, first step: from here on every answering call is refused with
    /// [`ErrorCode::InvalidState`] and queued work never runs; every open
    /// streamed body is aborted, so a read blocked on WebView2's thread returns.
    /// Returns the queued work, for the caller to drop outside any lock.
    pub(crate) fn close(&self) -> VecDeque<Job> {
        let jobs = {
            let mut queue = lock(&self.queue);
            queue.alive = false;
            std::mem::take(&mut queue.jobs)
        };
        let streams = std::mem::take(&mut *lock(&self.streams));
        for stream in streams.values() {
            stream.abort();
        }
        lock(&self.submitted).clear();
        jobs
    }

    #[cfg(test)]
    pub(crate) fn open_stream_count(&self) -> usize {
        lock(&self.streams).len()
    }
}

/// Answers requests from any thread. After the `WebviewExtras` it came from is
/// dropped, every call returns [`ErrorCode::InvalidState`].
#[derive(Clone)]
pub struct Responder {
    shared: Arc<Shared>,
}

impl std::fmt::Debug for Responder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Responder").field("alive", &self.shared.is_alive()).finish()
    }
}

impl Responder {
    pub(crate) fn new(shared: Arc<Shared>) -> Self {
        Self { shared }
    }

    /// Answers request `id` with `status` (100-599), headers (a JSON object or
    /// an array of `[name, value]` pairs; `None` or `""` for none) and a body
    /// of at most 4 GiB - 1. The arguments are checked and copied before it
    /// returns; the answer is set on the UI thread. Answering a request twice,
    /// or one the browser cancelled, does nothing.
    pub fn complete(&self, id: u64, status: i32, headers_json: Option<&str>, body: Option<&[u8]>) -> ErrorCode {
        if !self.shared.is_alive() {
            return ErrorCode::InvalidState;
        }
        let headers = match validate_response_head(id, status, headers_json) {
            Ok(headers) => headers,
            Err(code) => return code,
        };
        let body = body.unwrap_or_default();
        if let Err(code) = validate_body_len(body.len()) {
            return code;
        }
        // Recorded before the answer is queued, so a handler that answers and
        // then panics does not have its answer replaced by the fallback 500.
        // Only the call that recorded the id undoes it on failure.
        let inserted = self.shared.mark_submitted(id);
        let job = Job::Complete { id, status, headers, body: body.to_vec() };
        match self.shared.dispatch(job) {
            Ok(()) => ErrorCode::Ok,
            Err(code) => {
                if inserted {
                    self.shared.forget_submitted(id);
                }
                code
            }
        }
    }

    /// Starts a streamed answer: checked exactly like [`complete`](Self::complete).
    /// [`ErrorCode::Duplicate`] when a stream for `id` is already open.
    /// Beginning a request already answered or cancelled does nothing, and its
    /// chunks are dropped.
    pub fn begin(&self, id: u64, status: i32, headers_json: Option<&str>) -> ErrorCode {
        if !self.shared.is_alive() {
            return ErrorCode::InvalidState;
        }
        let headers = match validate_response_head(id, status, headers_json) {
            Ok(headers) => headers,
            Err(code) => return code,
        };
        let inserted = self.shared.mark_submitted(id);
        let result = self.begin_stream(id, status, headers);
        if result.is_err() && inserted {
            self.shared.forget_submitted(id);
        }
        result.into()
    }

    fn begin_stream(&self, id: u64, status: i32, headers: Vec<Header>) -> Result<(), ErrorCode> {
        let stream = Arc::new(StreamState::new());
        {
            // When WebView2 lets go of the body early (the page cancelled it),
            // the state drops its buffer itself and this queues forgetting it.
            // It holds the shared state weakly, so nothing keeps itself alive.
            let weak: Weak<Shared> = Arc::downgrade(&self.shared);
            let key = stream_key(&stream);
            stream.set_on_abandoned(move || {
                if let Some(shared) = weak.upgrade() {
                    let _ = shared.dispatch(Job::ForgetAbandoned { id, key });
                }
            });
        }
        {
            let mut streams = lock(&self.shared.streams);
            if streams.contains_key(&id) {
                return Err(ErrorCode::Duplicate);
            }
            streams.insert(id, stream.clone());
        }
        let job = Job::BeginStream { id, status, headers, stream: stream.clone() };
        if let Err(code) = self.shared.dispatch(job) {
            self.shared.drop_stream(id, &stream);
            return Err(code);
        }
        Ok(())
    }

    /// Appends body bytes (at most 4 GiB - 1) to a streamed answer; copied
    /// before it returns, with no trip to the UI thread. A chunk for a stream
    /// that ended, was never begun, or that the browser let go of does nothing.
    ///
    /// Back-pressure: on any thread but the UI thread, while the stream is
    /// [`backlogged`](Self::backlogged) the call waits (blocked, not spinning)
    /// until the page has read it down to half of [`BACKLOG_LIMIT`], or the
    /// stream ends or is let go, or the webview goes (then
    /// [`ErrorCode::InvalidState`]). So such a writer never has more than the
    /// limit and one chunk unread, and nothing is dropped or reordered. On the
    /// UI thread it never waits: the bytes are kept however far behind the
    /// page is, and a writer there paces itself with `backlogged`.
    pub fn write_chunk(&self, id: u64, chunk: &[u8]) -> ErrorCode {
        if !self.shared.is_alive() {
            return ErrorCode::InvalidState;
        }
        if let Err(code) = validate_request_id(id).and_then(|()| validate_body_len(chunk.len())) {
            return code;
        }
        if chunk.is_empty() {
            return ErrorCode::Ok;
        }
        let stream = {
            let mut streams = lock(&self.shared.streams);
            let Some(stream) = streams.get(&id) else {
                return ErrorCode::Ok;
            };
            if stream.is_abandoned() {
                // Nobody will read these bytes: stop keeping them.
                stream.abort();
                streams.remove(&id);
                return ErrorCode::Ok;
            }
            stream.clone()
        };
        if std::thread::current().id() == self.shared.ui_thread {
            stream.push(chunk);
        } else if !stream.push_paced(chunk) && !self.shared.is_alive() {
            return ErrorCode::InvalidState;
        }
        ErrorCode::Ok
    }

    /// True while streamed answer `id` has [`BACKLOG_LIMIT`] or more bytes the
    /// page has not read, until the page brings them down to half of that;
    /// false for a stream that is not open.
    pub fn backlogged(&self, id: u64) -> bool {
        self.shared.open_stream(id).is_some_and(|stream| stream.is_backlogged())
    }

    /// Bytes of streamed answer `id` written and not yet read by the page; 0
    /// for a stream that is not open.
    pub fn backlog(&self, id: u64) -> usize {
        self.shared.open_stream(id).map_or(0, |stream| stream.buffered())
    }

    /// Ends a streamed answer. Ending one twice, or one never begun, does nothing.
    pub fn end(&self, id: u64) -> ErrorCode {
        if !self.shared.is_alive() {
            return ErrorCode::InvalidState;
        }
        if let Err(code) = validate_request_id(id) {
            return code;
        }
        let mut streams = lock(&self.shared.streams);
        if let Some(stream) = streams.remove(&id) {
            // Finished while still registered, so there is never a moment when
            // the stream is open but out of reach of teardown.
            stream.finish();
        }
        ErrorCode::Ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stream::ReadEnd;
    use std::sync::atomic::AtomicUsize;

    fn setup() -> (Arc<Shared>, Responder, Arc<AtomicUsize>) {
        let wakes = Arc::new(AtomicUsize::new(0));
        let counter = wakes.clone();
        let shared = Shared::new(Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }));
        let responder = Responder::new(shared.clone());
        (shared, responder, wakes)
    }

    fn assert_send_sync<T: Send + Sync + Clone>() {}

    #[test]
    fn responder_is_clone_send_sync() {
        assert_send_sync::<Responder>();
    }

    #[test]
    fn request_ids_are_never_zero_and_increase() {
        let a = next_request_id();
        let b = next_request_id();
        assert!(a > 0 && b > a);
    }

    // engine_base.hh complete_request: arguments refused before anything is
    // queued; a good answer is queued, marked submitted and wakes the UI thread.
    #[test]
    fn complete_checks_then_queues() {
        let (shared, r, wakes) = setup();
        assert_eq!(r.complete(0, 200, None, None), ErrorCode::InvalidArgument);
        assert_eq!(r.complete(7, 99, None, None), ErrorCode::InvalidArgument);
        assert_eq!(r.complete(7, 200, Some("{\"X\":\"a\r\nb\"}"), None), ErrorCode::InvalidArgument);
        assert!(shared.next_job().is_none());
        assert_eq!(wakes.load(Ordering::SeqCst), 0);

        assert_eq!(r.complete(7, 201, Some("[[\"A\",\"1\"],[\"A\",\"2\"]]"), Some(b"body")), ErrorCode::Ok);
        assert!(shared.is_submitted(7));
        assert_eq!(wakes.load(Ordering::SeqCst), 1);
        match shared.next_job() {
            Some(Job::Complete { id, status, headers, body }) => {
                assert_eq!((id, status, body.as_slice()), (7, 201, b"body".as_slice()));
                assert_eq!(headers.len(), 2);
            }
            _ => panic!("expected a completion"),
        }
    }

    // request-handler.md "Streaming": duplicate begin, chunk rules, end twice.
    #[test]
    fn streaming_rules() {
        let (shared, r, _) = setup();
        assert_eq!(r.begin(0, 200, None), ErrorCode::InvalidArgument);
        assert_eq!(r.begin(5, 600, None), ErrorCode::InvalidArgument);
        assert_eq!(r.begin(5, 200, Some("{\"Content-Type\":\"text/plain\"}")), ErrorCode::Ok);
        assert_eq!(r.begin(5, 200, None), ErrorCode::Duplicate);
        // The duplicate did not undo the first begin's submission.
        assert!(shared.is_submitted(5));
        let Some(Job::BeginStream { stream, .. }) = shared.next_job() else { panic!("expected a stream head") };
        assert_eq!(r.write_chunk(0, b"x"), ErrorCode::InvalidArgument);
        assert_eq!(r.write_chunk(5, b""), ErrorCode::Ok);
        assert_eq!(r.write_chunk(5, b"ab"), ErrorCode::Ok);
        assert_eq!(r.write_chunk(99, b"never begun"), ErrorCode::Ok);
        assert_eq!(r.end(5), ErrorCode::Ok);
        assert_eq!(r.end(5), ErrorCode::Ok);
        assert_eq!(r.write_chunk(5, b"after end"), ErrorCode::Ok);
        let mut buf = [0u8; 8];
        assert_eq!(stream.read(&mut buf), (ReadEnd::Ended, 2));
        assert_eq!(&buf[..2], b"ab");
        assert_eq!(shared.open_stream_count(), 0);
    }

    // D45: a writer on another thread is held to the page's reading; the UI thread is never held.
    #[test]
    fn writers_off_the_ui_thread_wait_while_backlogged() {
        let (shared, r, _) = setup();
        assert_eq!(r.begin(11, 200, None), ErrorCode::Ok);
        let Some(Job::BeginStream { stream, .. }) = shared.next_job() else { panic!("expected a stream head") };
        assert!(!r.backlogged(11));
        // This thread made the shared state, so it is the UI thread here: it is never held.
        let big = vec![1u8; BACKLOG_LIMIT];
        assert_eq!(r.write_chunk(11, &big), ErrorCode::Ok);
        assert_eq!(r.write_chunk(11, &big), ErrorCode::Ok);
        assert!(r.backlogged(11));
        assert_eq!(r.backlog(11), 2 * BACKLOG_LIMIT);
        assert_eq!(r.backlog(12), 0, "no such stream");
        assert!(!r.backlogged(12));
        let writer = {
            let r = r.clone();
            std::thread::spawn(move || r.write_chunk(11, b"tail"))
        };
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!writer.is_finished(), "a writer on another thread waits while the stream is backlogged");
        let mut buf = vec![0u8; BACKLOG_LIMIT];
        assert_eq!(stream.read(&mut buf), (ReadEnd::Filled, BACKLOG_LIMIT));
        assert!(!writer.is_finished(), "still above half the limit");
        assert_eq!(stream.read(&mut buf[..BACKLOG_LIMIT / 2]), (ReadEnd::Filled, BACKLOG_LIMIT / 2));
        assert_eq!(writer.join().unwrap(), ErrorCode::Ok, "released once the page is down to half the limit");
        assert_eq!(r.backlog(11), BACKLOG_LIMIT / 2 + 4);
        assert_eq!(r.end(11), ErrorCode::Ok);
        let mut rest = Vec::new();
        loop {
            let (end, n) = stream.read(&mut buf);
            rest.extend_from_slice(&buf[..n]);
            if end == ReadEnd::Ended {
                break;
            }
        }
        assert_eq!(rest.len(), BACKLOG_LIMIT / 2 + 4);
        assert!(rest.ends_with(b"tail"), "the waiting chunk was kept, after the bytes before it");

        // A writer held when the webview goes is released and told so.
        assert_eq!(r.begin(13, 200, None), ErrorCode::Ok);
        assert!(matches!(shared.next_job(), Some(Job::BeginStream { .. })));
        assert_eq!(r.write_chunk(13, &big), ErrorCode::Ok);
        let writer = {
            let r = r.clone();
            std::thread::spawn(move || r.write_chunk(13, b"x"))
        };
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!writer.is_finished());
        drop(shared.close());
        assert_eq!(writer.join().unwrap(), ErrorCode::InvalidState);
    }

    // streaming_istream.hh: a body WebView2 let go of is forgotten on the UI
    // thread, and chunks written to it are dropped.
    #[test]
    fn abandoned_stream_is_forgotten() {
        let (shared, r, _) = setup();
        assert_eq!(r.begin(9, 200, None), ErrorCode::Ok);
        let Some(Job::BeginStream { stream, .. }) = shared.next_job() else { panic!() };
        stream.on_consumer_released();
        assert_eq!(r.write_chunk(9, b"nobody reads this"), ErrorCode::Ok);
        assert_eq!(shared.open_stream_count(), 0);
        match shared.next_job() {
            Some(Job::ForgetAbandoned { id, key }) => {
                assert_eq!(id, 9);
                shared.forget_abandoned_stream(id, key);
            }
            _ => panic!("expected the abandon notice"),
        }
    }

    // requests.md "Teardown": after close every call is InvalidState, open
    // streams are aborted, queued work is handed back to be dropped.
    #[test]
    fn close_refuses_and_aborts() {
        let (shared, r, _) = setup();
        assert_eq!(r.begin(3, 200, None), ErrorCode::Ok);
        assert_eq!(r.complete(4, 200, None, None), ErrorCode::Ok);
        let open = lock(&shared.streams).get(&3).cloned().unwrap();
        let queued = shared.close();
        assert_eq!(queued.len(), 2);
        let mut buf = [0u8; 4];
        assert_eq!(open.read(&mut buf), (ReadEnd::Aborted, 0));
        assert_eq!(r.complete(4, 200, None, None), ErrorCode::InvalidState);
        assert_eq!(r.begin(5, 200, None), ErrorCode::InvalidState);
        assert_eq!(r.write_chunk(3, b"x"), ErrorCode::InvalidState);
        assert_eq!(r.end(3), ErrorCode::InvalidState);
        assert!(shared.next_job().is_none());
        assert!(!shared.is_submitted(4));
    }

    // A responder racing the close from another thread never crashes and gets
    // either Ok (queued before) or InvalidState (after).
    #[test]
    fn responder_racing_close() {
        for _ in 0..200 {
            let (shared, r, _) = setup();
            let worker = std::thread::spawn(move || {
                let mut codes = Vec::new();
                for id in 1..50 {
                    codes.push(r.complete(id, 200, None, Some(b"x")));
                    codes.push(r.begin(id + 1000, 200, None));
                    codes.push(r.write_chunk(id + 1000, b"y"));
                }
                codes
            });
            drop(shared.close());
            for code in worker.join().unwrap() {
                assert!(matches!(code, ErrorCode::Ok | ErrorCode::InvalidState), "{code:?}");
            }
        }
    }
}
