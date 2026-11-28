//! The body of a streamed response, ported from `stream_state` in the C++
//! fork's `streaming_istream.hh`. Safe code with no OS call: the COM `IStream`
//! over it lives in the Windows module.
//!
//! The state is shared (`Arc`) between the webview's table of open responses
//! and the `IStream` handed to WebView2, so whichever lets go last frees it.
//! Only bytes not yet read are held.
//!
//! Two things differ from the C++ fork, whose `Read` waited until the caller's
//! whole buffer was full: a read returns what is there as soon as anything is,
//! so a chunk reaches WebView2 when it is written and not once enough follow
//! it to fill WebView2's buffer; and the unread bytes are watched against
//! [`BACKLOG_LIMIT`], so a writer can be held back while the page is behind
//! ([`StreamState::push_paced`], [`StreamState::is_backlogged`]).

use std::sync::{Condvar, Mutex, MutexGuard};

/// Unread bytes at which a stream counts as backlogged. It stays backlogged
/// until the reader has brought them down to half of this.
pub const BACKLOG_LIMIT: usize = 1 << 20;

/// How a read ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReadEnd {
    /// Every byte asked for was read (`S_OK`).
    Filled,
    /// Fewer bytes than asked for, at least one, were read and the stream is
    /// still open: everything written so far (`S_OK`, a short read).
    Partial,
    /// The stream ended first; fewer bytes were read, possibly none (`S_FALSE`).
    Ended,
    /// The stream was aborted; nothing counts as read (`E_ABORT`).
    Aborted,
}

type OnAbandoned = Box<dyn FnOnce() + Send>;

#[derive(Default)]
struct Inner {
    buffer: Vec<u8>,
    read_pos: usize,
    eof: bool,
    aborted: bool,
    consumer_released: bool,
    /// Set when the unread bytes reach [`BACKLOG_LIMIT`], cleared when they
    /// are down to half of it, or the stream is aborted.
    backlogged: bool,
    on_abandoned: Option<OnAbandoned>,
}

impl Inner {
    fn unread(&self) -> usize {
        self.buffer.len() - self.read_pos
    }

    fn closed(&self) -> bool {
        self.eof || self.aborted
    }

    fn update_backlog(&mut self) {
        let unread = self.unread();
        if unread >= BACKLOG_LIMIT {
            self.backlogged = true;
        } else if unread <= BACKLOG_LIMIT / 2 {
            self.backlogged = false;
        }
    }

    fn abort(&mut self) {
        self.aborted = true;
        self.buffer = Vec::new();
        self.read_pos = 0;
        self.backlogged = false;
    }

    /// Drops bytes already read once they are most of the buffer.
    fn compact(&mut self) {
        if self.read_pos > 0 && self.read_pos >= self.buffer.len() / 2 {
            self.buffer.drain(..self.read_pos);
            self.read_pos = 0;
        }
    }
}

/// Bytes fed from any thread with [`push`](Self::push) and closed with
/// [`finish`](Self::finish) or [`abort`](Self::abort); read by one consumer.
#[derive(Default)]
pub(crate) struct StreamState {
    inner: Mutex<Inner>,
    cv: Condvar,
}

impl StreamState {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panic while the lock was held leaves plain data behind; keep going.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Called at most once, from the thread that drops the last reference to
    /// the consumer before the stream ended. It runs with the state's lock
    /// held, so it must not call back into the state; it only queues the
    /// owner's cleanup. `finish` and `abort` drop it.
    pub(crate) fn set_on_abandoned(&self, f: impl FnOnce() + Send + 'static) {
        let mut inner = self.lock();
        if inner.eof || inner.aborted {
            return;
        }
        inner.on_abandoned = Some(Box::new(f));
    }

    /// Appends bytes for the reader, however far behind it is. False, and
    /// nothing kept, once the stream has ended or been aborted. An empty push
    /// does nothing and is true.
    pub(crate) fn push(&self, data: &[u8]) -> bool {
        if data.is_empty() {
            return true;
        }
        let inner = self.lock();
        self.append(inner, data)
    }

    /// [`push`](Self::push), after waiting (blocked, not spinning) while the
    /// stream is backlogged: until the reader has brought the unread bytes
    /// down to half of [`BACKLOG_LIMIT`], or the stream ends, is aborted or is
    /// abandoned. So a writer that only pushes this way never has more than
    /// `BACKLOG_LIMIT` plus one chunk unread. For any thread but the UI
    /// thread, which must never wait.
    pub(crate) fn push_paced(&self, data: &[u8]) -> bool {
        if data.is_empty() {
            return true;
        }
        let inner = self.cv.wait_while(self.lock(), |i| !i.closed() && i.backlogged).unwrap_or_else(|e| e.into_inner());
        self.append(inner, data)
    }

    fn append(&self, mut inner: MutexGuard<'_, Inner>, data: &[u8]) -> bool {
        if inner.closed() {
            return false;
        }
        inner.compact();
        inner.buffer.extend_from_slice(data);
        inner.update_backlog();
        drop(inner);
        self.cv.notify_all();
        true
    }

    /// True from the moment the unread bytes reach [`BACKLOG_LIMIT`] until the
    /// reader has brought them down to half of it; false once aborted.
    pub(crate) fn is_backlogged(&self) -> bool {
        self.lock().backlogged
    }

    /// No more bytes: once what is buffered has been read, reads report the end.
    pub(crate) fn finish(&self) {
        let dropped = {
            let mut inner = self.lock();
            inner.eof = true;
            inner.on_abandoned.take()
        };
        drop(dropped);
        self.cv.notify_all();
    }

    /// Ends the stream at once: what is buffered is dropped and every read,
    /// blocked or not, ends [`ReadEnd::Aborted`].
    pub(crate) fn abort(&self) {
        let dropped = {
            let mut inner = self.lock();
            inner.abort();
            inner.on_abandoned.take()
        };
        drop(dropped);
        self.cv.notify_all();
    }

    #[cfg(test)]
    pub(crate) fn is_closed(&self) -> bool {
        let inner = self.lock();
        inner.eof || inner.aborted
    }

    /// Bytes pushed and not yet read.
    pub(crate) fn buffered(&self) -> usize {
        self.lock().unread()
    }

    /// True once the consumer has been released for good, so nobody will read
    /// what is pushed.
    pub(crate) fn is_abandoned(&self) -> bool {
        self.lock().consumer_released
    }

    /// `ISequentialStream::Read`: waits (blocked, not spinning) only while
    /// nothing is unread and the stream is open, then returns at once with as
    /// much as is there, up to `out.len()`: [`ReadEnd::Filled`] when that fills
    /// `out`, [`ReadEnd::Partial`] (a short read) when it does not and the
    /// stream is still open, [`ReadEnd::Ended`] when it does not and the
    /// stream has ended (possibly 0 bytes). Nothing counts as read once the
    /// stream is aborted. A zero-byte read never waits.
    pub(crate) fn read(&self, out: &mut [u8]) -> (ReadEnd, usize) {
        if out.is_empty() {
            return (ReadEnd::Filled, 0);
        }
        let mut inner = self.cv.wait_while(self.lock(), |i| !i.closed() && i.unread() == 0).unwrap_or_else(|e| e.into_inner());
        if inner.aborted {
            return (ReadEnd::Aborted, 0);
        }
        let n = out.len().min(inner.unread());
        let start = inner.read_pos;
        out[..n].copy_from_slice(&inner.buffer[start..start + n]);
        inner.read_pos += n;
        if inner.read_pos == inner.buffer.len() {
            inner.buffer.clear();
            inner.read_pos = 0;
        }
        let was_backlogged = inner.backlogged;
        inner.update_backlog();
        let end = if n == out.len() {
            ReadEnd::Filled
        } else if inner.eof {
            ReadEnd::Ended
        } else {
            ReadEnd::Partial
        };
        let room_made = was_backlogged && !inner.backlogged;
        drop(inner);
        if room_made {
            // A writer waiting in `push_paced` may go on.
            self.cv.notify_all();
        }
        (end, n)
    }

    /// The consumer is gone for good. Unless the stream already ended, nobody
    /// will read it again: drop what is buffered now and run `on_abandoned`.
    pub(crate) fn on_consumer_released(&self) {
        {
            let mut inner = self.lock();
            inner.consumer_released = true;
            if inner.eof || inner.aborted {
                inner.on_abandoned = None;
                return;
            }
            inner.abort();
            if let Some(f) = inner.on_abandoned.take() {
                // Nothing may unwind out of the consumer's release.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
            }
        }
        self.cv.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

    fn sleep(ms: u64) {
        thread::sleep(Duration::from_millis(ms));
    }

    // C++: "Streaming IStream: push, read, end of stream, abort" (the state
    // half; the COM surface is tested in the Windows module).
    #[test]
    fn push_read_end_of_stream_abort() {
        let state = Arc::new(StreamState::new());
        let mut buf = [0u8; 16];
        assert!(state.push(b"hello"));
        assert_eq!(state.read(&mut buf[..3]), (ReadEnd::Filled, 3));
        assert_eq!(&buf[..3], b"hel");
        assert_eq!(state.read(&mut buf[..2]), (ReadEnd::Filled, 2));
        assert_eq!(&buf[..2], b"lo");
        assert_eq!(state.buffered(), 0);

        let writer = {
            let state = state.clone();
            thread::spawn(move || {
                sleep(100);
                state.push(b"data: 1\n\n");
            })
        };
        let start = Instant::now();
        assert_eq!(state.read(&mut buf[..9]), (ReadEnd::Filled, 9));
        writer.join().unwrap();
        assert_eq!(&buf[..9], b"data: 1\n\n");
        assert!(start.elapsed() >= Duration::from_millis(50));

        assert!(state.push(b"tail"));
        state.finish();
        assert!(state.is_closed());
        assert!(!state.push(b"late"));
        assert_eq!(state.read(&mut buf), (ReadEnd::Ended, 4));
        assert_eq!(&buf[..4], b"tail");
        assert_eq!(state.read(&mut buf), (ReadEnd::Ended, 0));

        let aborted = Arc::new(StreamState::new());
        let aborter = {
            let aborted = aborted.clone();
            thread::spawn(move || {
                sleep(100);
                aborted.abort();
            })
        };
        assert_eq!(aborted.read(&mut buf), (ReadEnd::Aborted, 0));
        aborter.join().unwrap();
        assert!(!aborted.push(b"x"));

        let dropped = StreamState::new();
        assert!(dropped.push(b"kept?"));
        dropped.abort();
        assert_eq!(dropped.buffered(), 0);
        assert_eq!(dropped.read(&mut buf), (ReadEnd::Aborted, 0));
    }

    // C++: "Streaming IStream: Read contract", with the read returning what is
    // there instead of waiting for the whole buffer (DECISIONS D45): it waits
    // only while nothing is unread.
    #[test]
    fn read_contract() {
        let state = Arc::new(StreamState::new());
        let mut buf = [0u8; 8];
        let start = Instant::now();
        assert_eq!(state.read(&mut buf[..0]), (ReadEnd::Filled, 0));
        assert!(start.elapsed() < Duration::from_millis(500));

        // What is there comes back at once, as a short read.
        assert!(state.push(b"ab"));
        let start = Instant::now();
        assert_eq!(state.read(&mut buf), (ReadEnd::Partial, 2));
        assert_eq!(&buf[..2], b"ab");
        assert!(start.elapsed() < Duration::from_millis(40), "a read with bytes there does not wait");
        // With nothing there, the read waits for the next push and returns that.
        let writer = {
            let state = state.clone();
            thread::spawn(move || {
                sleep(50);
                state.push(b"cde");
                sleep(50);
                state.push(b"fghXYZ");
            })
        };
        let start = Instant::now();
        assert_eq!(state.read(&mut buf), (ReadEnd::Partial, 3));
        assert!(start.elapsed() >= Duration::from_millis(30), "it waited for the push");
        assert_eq!(&buf[..3], b"cde");
        assert_eq!(state.read(&mut buf[..4]), (ReadEnd::Filled, 4));
        writer.join().unwrap();
        assert_eq!(&buf[..4], b"fghX");
        assert_eq!(state.buffered(), 2);

        let ender = {
            let state = state.clone();
            thread::spawn(move || {
                sleep(50);
                state.finish();
            })
        };
        assert_eq!(state.read(&mut buf), (ReadEnd::Partial, 2), "unread bytes come back before the end is known");
        assert_eq!(&buf[..2], b"YZ");
        assert_eq!(state.read(&mut buf), (ReadEnd::Ended, 0), "then the read waits for the end");
        ender.join().unwrap();
        assert_eq!(state.read(&mut buf), (ReadEnd::Ended, 0));
        assert_eq!(state.read(&mut buf[..0]), (ReadEnd::Filled, 0));

        let exact = StreamState::new();
        assert!(exact.push(b"12345678"));
        exact.finish();
        assert_eq!(exact.read(&mut buf), (ReadEnd::Filled, 8));
        assert_eq!(&buf, b"12345678");
        assert_eq!(exact.read(&mut buf), (ReadEnd::Ended, 0));

        let rest = StreamState::new();
        assert!(rest.push(b"abc"));
        rest.finish();
        assert_eq!(rest.read(&mut buf), (ReadEnd::Ended, 3), "what is left after the end is a short S_FALSE read");

        let cut = Arc::new(StreamState::new());
        assert!(cut.push(b"abc"));
        assert_eq!(cut.read(&mut buf), (ReadEnd::Partial, 3));
        let aborter = {
            let cut = cut.clone();
            thread::spawn(move || {
                sleep(50);
                cut.abort();
            })
        };
        assert_eq!(cut.read(&mut buf), (ReadEnd::Aborted, 0), "a waiting read ends when the stream is aborted");
        aborter.join().unwrap();
    }

    #[test]
    fn a_backlog_is_set_at_the_limit_and_cleared_at_half() {
        let state = StreamState::new();
        let chunk = vec![7u8; BACKLOG_LIMIT / 4];
        for _ in 0..3 {
            assert!(state.push(&chunk));
        }
        assert!(!state.is_backlogged());
        assert!(state.push(&chunk));
        assert!(state.is_backlogged(), "at the limit");
        // The UI thread's push never waits, however far behind the reader is.
        let start = Instant::now();
        for _ in 0..8 {
            assert!(state.push(&chunk));
        }
        assert!(start.elapsed() < Duration::from_secs(2));
        assert_eq!(state.buffered(), 12 * chunk.len());
        let mut buf = vec![0u8; BACKLOG_LIMIT];
        // 12 quarters unread: reading down to 3 quarters leaves it backlogged, to 2 clears it.
        for _ in 0..9 {
            assert_eq!(state.read(&mut buf[..chunk.len()]), (ReadEnd::Filled, chunk.len()));
        }
        assert!(state.is_backlogged(), "still above half the limit");
        assert_eq!(state.read(&mut buf[..chunk.len()]), (ReadEnd::Filled, chunk.len()));
        assert!(!state.is_backlogged(), "down to half the limit");
        assert!(state.push(&chunk));
        assert!(!state.is_backlogged(), "below the limit again");
        state.abort();
        assert!(!state.is_backlogged());
    }

    #[test]
    fn a_paced_writer_waits_for_the_reader_and_loses_nothing() {
        let state = Arc::new(StreamState::new());
        let total = 6 * BACKLOG_LIMIT + 12_345;
        let max_unread = Arc::new(AtomicUsize::new(0));
        let writer = {
            let state = state.clone();
            let max_unread = max_unread.clone();
            thread::spawn(move || {
                let mut sent = 0usize;
                while sent < total {
                    let n = (total - sent).min(64 * 1024 + 3);
                    let chunk: Vec<u8> = (sent..sent + n).map(|i| (i % 251) as u8).collect();
                    assert!(state.push_paced(&chunk));
                    max_unread.fetch_max(state.buffered(), Ordering::SeqCst);
                    sent += n;
                }
                state.finish();
            })
        };
        // A slow reader: small reads with pauses.
        let mut got = 0usize;
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            let (end, n) = state.read(&mut buf);
            for (k, byte) in buf[..n].iter().enumerate() {
                assert_eq!(*byte, ((got + k) % 251) as u8, "byte {} out of order", got + k);
            }
            got += n;
            if end == ReadEnd::Ended {
                break;
            }
            if got % (1 << 20) < buf.len() {
                sleep(2);
            }
        }
        writer.join().unwrap();
        assert_eq!(got, total, "every byte arrived");
        let max = max_unread.load(Ordering::SeqCst);
        assert!(max <= BACKLOG_LIMIT + 64 * 1024 + 3, "never more than the limit and one chunk unread: {max}");
    }

    #[test]
    fn a_paced_writer_is_released_by_the_end_of_the_stream() {
        for close in ["abort", "finish", "abandon"] {
            let state = Arc::new(StreamState::new());
            assert!(state.push(&vec![0u8; BACKLOG_LIMIT]));
            assert!(state.is_backlogged());
            let writer = {
                let state = state.clone();
                thread::spawn(move || state.push_paced(b"more"))
            };
            sleep(100);
            assert!(!writer.is_finished(), "{close}: the writer waits while the stream is backlogged");
            match close {
                "abort" => state.abort(),
                "finish" => state.finish(),
                _ => state.on_consumer_released(),
            }
            assert!(!writer.join().unwrap(), "{close}: the waiting push is refused, not kept");
        }
    }

    // C++: "Streaming IStream: abandoned stream is reclaimed on release"
    #[test]
    fn abandoned_stream_is_reclaimed_on_release() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = |calls: &Arc<AtomicUsize>| {
            let calls = calls.clone();
            move || {
                calls.fetch_add(1, Ordering::SeqCst);
            }
        };
        let state = StreamState::new();
        state.set_on_abandoned(counter(&calls));
        assert!(state.push(b"buffered and never read"));
        assert_eq!(state.buffered(), 23);
        assert!(!state.is_abandoned());
        state.on_consumer_released();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(state.buffered(), 0);
        assert!(state.is_closed());
        assert!(state.is_abandoned());
        assert!(!state.push(b"late"));
        let mut buf = [0u8; 8];
        assert_eq!(state.read(&mut buf), (ReadEnd::Aborted, 0));
        state.finish();
        state.abort();
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let ended = StreamState::new();
        ended.set_on_abandoned(counter(&calls));
        assert!(ended.push(b"x"));
        ended.finish();
        ended.on_consumer_released();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(ended.buffered(), 1);
        assert!(ended.is_abandoned());
    }

    // C++: "Streaming IStream: concurrent finish and consumer release"
    #[test]
    fn concurrent_finish_and_consumer_release() {
        for _ in 0..2000 {
            let calls = Arc::new(AtomicUsize::new(0));
            let owned = Arc::new(StreamState::new());
            let watch = Arc::downgrade(&owned);
            {
                let calls = calls.clone();
                owned.set_on_abandoned(move || {
                    calls.fetch_add(1, Ordering::SeqCst);
                });
            }
            assert!(owned.push(b"chunk"));
            let consumer = owned.clone();
            let go = Arc::new(std::sync::Barrier::new(2));
            let ender = {
                let go = go.clone();
                thread::spawn(move || {
                    go.wait();
                    owned.finish();
                    drop(owned);
                })
            };
            let releaser = thread::spawn(move || {
                go.wait();
                consumer.on_consumer_released();
                drop(consumer);
            });
            ender.join().unwrap();
            releaser.join().unwrap();
            assert!(calls.load(Ordering::SeqCst) <= 1);
            assert!(watch.upgrade().is_none());
        }
    }
}
