//! The body of a streamed response, ported from `stream_state` in the C++
//! fork's `streaming_istream.hh`. Safe code with no OS call: the COM `IStream`
//! over it lives in the Windows module.
//!
//! The state is shared (`Arc`) between the webview's table of open responses
//! and the `IStream` handed to WebView2, so whichever lets go last frees it.
//! Only bytes not yet read are held.

use std::sync::{Condvar, Mutex, MutexGuard};

/// How a read ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReadEnd {
    /// Every byte asked for was read (`S_OK`).
    Filled,
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
    on_abandoned: Option<OnAbandoned>,
    /// Tests only: how many reads are waiting for bytes now.
    #[cfg(test)]
    waiting: usize,
}

impl Inner {
    fn abort(&mut self) {
        self.aborted = true;
        self.buffer = Vec::new();
        self.read_pos = 0;
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

    /// Appends bytes for the reader, however far behind it is, and returns at
    /// once, from any thread, as the C++ fork's writer did. False, and nothing
    /// kept, once the stream has ended or been aborted. An empty push does
    /// nothing and is true.
    pub(crate) fn push(&self, data: &[u8]) -> bool {
        if data.is_empty() {
            return true;
        }
        {
            let mut inner = self.lock();
            if inner.eof || inner.aborted {
                return false;
            }
            inner.compact();
            inner.buffer.extend_from_slice(data);
        }
        self.cv.notify_all();
        true
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
    #[cfg(test)]
    pub(crate) fn buffered(&self) -> usize {
        let inner = self.lock();
        inner.buffer.len() - inner.read_pos
    }

    /// Tests only: waits (on the condition variable, up to `limit`) until a read
    /// is waiting for bytes, so a test can supply them only once it is; true
    /// when one is.
    #[cfg(test)]
    pub(crate) fn wait_for_waiting_reader(&self, limit: std::time::Duration) -> bool {
        let (inner, timeout) = self.cv.wait_timeout_while(self.lock(), limit, |i| i.waiting == 0).unwrap_or_else(|e| e.into_inner());
        drop(inner);
        !timeout.timed_out()
    }

    /// True once the consumer has been released for good, so nobody will read
    /// what is pushed.
    pub(crate) fn is_abandoned(&self) -> bool {
        self.lock().consumer_released
    }

    /// `ISequentialStream::Read`: fills `out` (waiting for bytes as needed)
    /// unless the stream ends first, in which case it returns what was left.
    /// Nothing counts as read once the stream is aborted. A zero-byte read
    /// never waits.
    #[cfg(test)]
    pub(crate) fn read(&self, out: &mut [u8]) -> (ReadEnd, usize) {
        self.read_with(out.len(), |offset, bytes| out[offset..offset + bytes.len()].copy_from_slice(bytes))
    }

    /// [`read`](Self::read) of `wanted` bytes into storage the caller owns and
    /// this function never sees: `put(offset, bytes)` is called with each piece
    /// in order, `offset` counting from 0, and `offset + bytes.len()` is never
    /// more than `wanted`. Lets a COM `Read` copy into a caller's buffer whose
    /// bytes may not be initialised, without forming a slice over it.
    pub(crate) fn read_with(&self, wanted: usize, mut put: impl FnMut(usize, &[u8])) -> (ReadEnd, usize) {
        if wanted == 0 {
            return (ReadEnd::Filled, 0);
        }
        let mut total = 0;
        let mut inner = self.lock();
        while total < wanted && !inner.aborted {
            if inner.read_pos == inner.buffer.len() {
                if inner.eof {
                    break;
                }
                #[cfg(test)]
                {
                    inner.waiting += 1;
                    self.cv.notify_all();
                }
                inner = self
                    .cv
                    .wait_while(inner, |i| !(i.aborted || i.eof || i.read_pos < i.buffer.len()))
                    .unwrap_or_else(|e| e.into_inner());
                #[cfg(test)]
                {
                    inner.waiting -= 1;
                }
                continue;
            }
            let available = inner.buffer.len() - inner.read_pos;
            let n = (wanted - total).min(available);
            let start = inner.read_pos;
            put(total, &inner.buffer[start..start + n]);
            inner.read_pos += n;
            total += n;
            if inner.read_pos == inner.buffer.len() {
                inner.buffer.clear();
                inner.read_pos = 0;
            }
        }
        if inner.aborted {
            return (ReadEnd::Aborted, 0);
        }
        if total == wanted {
            (ReadEnd::Filled, total)
        } else {
            (ReadEnd::Ended, total)
        }
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

    // C++: "Streaming IStream: Read contract"
    #[test]
    fn read_contract() {
        let state = Arc::new(StreamState::new());
        let mut buf = [0u8; 8];
        let start = Instant::now();
        assert_eq!(state.read(&mut buf[..0]), (ReadEnd::Filled, 0));
        assert!(start.elapsed() < Duration::from_millis(500));

        assert!(state.push(b"ab"));
        let writer = {
            let state = state.clone();
            thread::spawn(move || {
                sleep(50);
                state.push(b"cde");
                sleep(50);
                state.push(b"fghXY");
            })
        };
        assert_eq!(state.read(&mut buf), (ReadEnd::Filled, 8));
        writer.join().unwrap();
        assert_eq!(&buf, b"abcdefgh");
        assert_eq!(state.buffered(), 2);

        let ender = {
            let state = state.clone();
            thread::spawn(move || {
                sleep(50);
                state.push(b"Z");
                state.finish();
            })
        };
        assert_eq!(state.read(&mut buf), (ReadEnd::Ended, 3));
        ender.join().unwrap();
        assert_eq!(&buf[..3], b"XYZ");
        assert_eq!(state.read(&mut buf), (ReadEnd::Ended, 0));
        assert_eq!(state.read(&mut buf[..0]), (ReadEnd::Filled, 0));

        let exact = StreamState::new();
        assert!(exact.push(b"12345678"));
        exact.finish();
        assert_eq!(exact.read(&mut buf), (ReadEnd::Filled, 8));
        assert_eq!(&buf, b"12345678");
        assert_eq!(exact.read(&mut buf), (ReadEnd::Ended, 0));

        let cut = Arc::new(StreamState::new());
        assert!(cut.push(b"abc"));
        let aborter = {
            let cut = cut.clone();
            thread::spawn(move || {
                sleep(50);
                cut.abort();
            })
        };
        assert_eq!(cut.read(&mut buf), (ReadEnd::Aborted, 0));
        aborter.join().unwrap();
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
