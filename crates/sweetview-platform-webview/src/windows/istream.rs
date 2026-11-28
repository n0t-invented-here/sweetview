//! The `IStream` WebView2 reads a streamed response body from, ported from
//! `streaming_istream` in the C++ fork's `streaming_istream.hh`.
//!
//! Read-only and forward-only. Owned only by COM references once handed to
//! WebView2; when the last one goes, its `Drop` tells the [`StreamState`] its
//! reader is gone. Objects made with `#[implement]` are agile (they report
//! `IAgileObject` and aggregate the free-threaded marshaler), so COM never
//! marshals `Read` back to the UI thread, which would deadlock the blocking
//! read against the thread that feeds it.

use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;

use windows::core::{implement, Ref, HRESULT};
use windows::Win32::Foundation::{E_ABORT, E_NOTIMPL, E_POINTER, E_UNEXPECTED, STG_E_INVALIDPOINTER, S_FALSE, S_OK};
use windows::Win32::System::Com::{
    ISequentialStream_Impl, IStream, IStream_Impl, LOCKTYPE, STATFLAG, STATSTG, STGC, STGTY_STREAM, STREAM_SEEK,
};

use crate::stream::{ReadEnd, StreamState};

#[implement(IStream)]
pub(super) struct StreamingIStream {
    state: Arc<StreamState>,
}

impl StreamingIStream {
    /// A new `IStream` over `state`, holding one reference, owned by the caller.
    pub(super) fn create(state: Arc<StreamState>) -> IStream {
        Self { state }.into()
    }

    fn read(&self, pv: *mut c_void, cb: u32, pcbread: *mut u32) -> HRESULT {
        if !pcbread.is_null() {
            // SAFETY: `pcbread` is non-null, and the `ISequentialStream::Read`
            // contract makes a non-null `pcbread` a writable u32 for the call.
            unsafe { pcbread.write(0) };
        }
        if cb == 0 {
            return S_OK; // nothing asked for: never wait
        }
        if pv.is_null() {
            return E_POINTER;
        }
        // The caller's buffer may hold uninitialised bytes (WebView2 lends its own
        // storage), so no `&mut [u8]` is formed over it: each piece is copied to it by pointer.
        let out = pv.cast::<u8>();
        let (end, n) = self.state.read_with(cb as usize, |offset, bytes| {
            // SAFETY: the `ISequentialStream::Read` contract makes `pv` (non-null, checked
            // above) writable for `cb` bytes for the call, and `read_with` keeps
            // `offset + bytes.len()` within `cb`, so the destination range is inside it;
            // `bytes` borrows the stream's own buffer, a different allocation, so the two
            // do not overlap. `wrapping_add` stays inside the same allocation.
            unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), out.wrapping_add(offset), bytes.len()) };
        });
        if end == ReadEnd::Aborted {
            return E_ABORT; // *pcbread is already 0
        }
        if !pcbread.is_null() {
            // SAFETY: as above, a non-null `pcbread` is a writable u32; `n` is at
            // most `cb`, so it fits.
            unsafe { pcbread.write(n as u32) };
        }
        if end == ReadEnd::Filled {
            S_OK
        } else {
            S_FALSE
        }
    }
}

/// `ISequentialStream::Read` of up to `buf.len()` bytes into `buf`, with the
/// number of bytes read written to `read`. The request body is read through
/// here, and the tests read this crate's own stream the same way.
pub(super) fn read_into(stream: &IStream, buf: &mut [u8], read: &mut u32) -> HRESULT {
    // Larger buffers are read in part, as a short read is.
    let len = u32::try_from(buf.len()).unwrap_or(u32::MAX);
    // SAFETY: `buf` is a `&mut [u8]`, so it is writable for `buf.len()` bytes for the whole
    // call, and `len` is at most that length; `read` is a `&mut u32`, writable for the call.
    unsafe { stream.Read(buf.as_mut_ptr().cast(), len, Some(read)) }
}

impl Drop for StreamingIStream {
    fn drop(&mut self) {
        // The last COM reference is gone: nobody reads this body again. This runs
        // inside COM's `Release` on WebView2's thread, so nothing may unwind.
        let _ = catch_unwind(AssertUnwindSafe(|| self.state.on_consumer_released()));
    }
}

impl ISequentialStream_Impl for StreamingIStream_Impl {
    /// Fills `pv` with exactly `cb` bytes (`S_OK`), waiting for them as needed,
    /// unless the stream ends first: then what was left (`S_FALSE`, possibly 0
    /// bytes). `E_ABORT`, nothing read, once the stream is aborted. A zero-byte
    /// read never waits. As `ISequentialStream::Read` is documented: `S_OK`
    /// only when every byte asked for was read.
    fn Read(&self, pv: *mut c_void, cb: u32, pcbread: *mut u32) -> HRESULT {
        catch_unwind(AssertUnwindSafe(|| self.read(pv, cb, pcbread))).unwrap_or(E_UNEXPECTED)
    }

    fn Write(&self, _pv: *const c_void, _cb: u32, _pcbwritten: *mut u32) -> HRESULT {
        E_NOTIMPL
    }
}

impl IStream_Impl for StreamingIStream_Impl {
    fn Seek(&self, _dlibmove: i64, _dworigin: STREAM_SEEK, _plibnewposition: *mut u64) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn SetSize(&self, _libnewsize: u64) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn CopyTo(&self, _pstm: Ref<IStream>, _cb: u64, _pcbread: *mut u64, _pcbwritten: *mut u64) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn Commit(&self, _grfcommitflags: &STGC) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn Revert(&self) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn LockRegion(&self, _liboffset: u64, _cb: u64, _dwlocktype: &LOCKTYPE) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn UnlockRegion(&self, _liboffset: u64, _cb: u64, _dwlocktype: u32) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    /// The size is not known while the body is still being produced.
    fn Stat(&self, pstatstg: *mut STATSTG, _grfstatflag: &STATFLAG) -> windows::core::Result<()> {
        if pstatstg.is_null() {
            return Err(STG_E_INVALIDPOINTER.into());
        }
        catch_unwind(AssertUnwindSafe(|| {
            let stat = STATSTG { r#type: STGTY_STREAM.0 as u32, cbSize: 0, ..Default::default() };
            // SAFETY: `pstatstg` is non-null, and the `IStream::Stat` contract makes it
            // a writable STATSTG for the call; the struct is the `windows` crate's.
            unsafe { pstatstg.write(stat) };
        }))
        .map_err(|_| E_UNEXPECTED.into())
    }

    fn Clone(&self) -> windows::core::Result<IStream> {
        Err(E_NOTIMPL.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::core::{IUnknown, Interface};
    use windows::Win32::System::Com::{ISequentialStream, STATFLAG_NONAME, STREAM_SEEK_SET};

    fn read(stream: &IStream, buf: &mut [u8]) -> (HRESULT, u32) {
        // Not 0, so a stream that left the count unwritten would show.
        let mut n = 99u32;
        let hr = read_into(stream, buf, &mut n);
        (hr, n)
    }

    // C++: "Streaming IStream: push, read, end of stream, abort" (the COM
    // surface: a read-only, forward-only, agile IStream).
    #[test]
    fn com_surface() {
        let state = Arc::new(StreamState::new());
        let stream = StreamingIStream::create(state.clone());
        assert!(stream.cast::<ISequentialStream>().is_ok());
        assert!(stream.cast::<IUnknown>().is_ok());
        assert!(stream.cast::<windows_core::imp::IAgileObject>().is_ok());
        // SAFETY: a plain call on a live stream with no out-pointer.
        let seek = unsafe { stream.Seek(0, STREAM_SEEK_SET, None) };
        assert_eq!(seek.unwrap_err().code(), E_NOTIMPL);
        // SAFETY: `x` is a one-byte static buffer and no written count is asked for.
        let write = unsafe { stream.Write(b"x".as_ptr().cast(), 1, None) };
        assert_eq!(write, E_NOTIMPL);
        // SAFETY: a plain call on a live stream.
        let clone = unsafe { stream.Clone() };
        assert_eq!(clone.unwrap_err().code(), E_NOTIMPL);
        let mut stat = STATSTG::default();
        // SAFETY: `stat` is a local STATSTG for the call to fill.
        unsafe { stream.Stat(&mut stat, STATFLAG_NONAME) }.unwrap();
        assert_eq!(stat.r#type, STGTY_STREAM.0 as u32);
        assert_eq!(stat.cbSize, 0);

        assert!(state.push(b"hello"));
        let mut buf = [0u8; 16];
        assert_eq!(read(&stream, &mut buf[..3]), (S_OK, 3));
        assert_eq!(&buf[..3], b"hel");
        assert_eq!(read(&stream, &mut buf[..0]), (S_OK, 0));
        assert!(state.push(b"!"));
        state.finish();
        assert_eq!(read(&stream, &mut buf), (S_FALSE, 3));
        assert_eq!(&buf[..3], b"lo!");
        assert_eq!(read(&stream, &mut buf), (S_FALSE, 0));

        // Abandoned only once the IStream's last reference is gone.
        let second = stream.clone();
        drop(stream);
        assert!(!state.is_abandoned());
        drop(second);
        assert!(state.is_abandoned());
        assert_eq!(Arc::strong_count(&state), 1);

        let aborted = Arc::new(StreamState::new());
        let stream = StreamingIStream::create(aborted.clone());
        assert!(aborted.push(b"kept?"));
        aborted.abort();
        assert_eq!(read(&stream, &mut buf), (E_ABORT, 0));
    }

    // Every result `Read` gives, through the COM vtable. Each data supplier is another thread,
    // so a `Read` that returned early (a short read of an open stream) fails here instead of
    // hanging: `S_OK` means every byte asked for, as `ISequentialStream::Read` is documented.
    #[test]
    fn every_read_result_at_the_com_surface() {
        // Each supplier pushes only once the read is waiting for bytes (no sleep stages it), so
        // a read that returned early with what it had is seen.
        let later = |state: &Arc<StreamState>, bytes: &'static [u8], end: bool| {
            let state = state.clone();
            std::thread::spawn(move || {
                assert!(state.wait_for_waiting_reader(std::time::Duration::from_secs(10)), "the read waits for the rest");
                assert!(state.push(bytes));
                if end {
                    state.finish();
                }
            })
        };
        let mut buf = [0u8; 8];

        let state = Arc::new(StreamState::new());
        let stream = StreamingIStream::create(state.clone());
        assert!(state.push(b"12345678"));
        assert_eq!(read(&stream, &mut buf), (S_OK, 8), "filled from what is there");
        assert_eq!(&buf, b"12345678");

        assert!(state.push(b"ab"));
        let supplier = later(&state, b"cdefghij", false);
        assert_eq!(read(&stream, &mut buf), (S_OK, 8), "filled once the rest is written, never short while open");
        supplier.join().unwrap();
        assert_eq!(&buf, b"abcdefgh");

        let supplier = later(&state, b"k", true);
        assert_eq!(read(&stream, &mut buf), (S_FALSE, 3), "the end comes first: what was left");
        supplier.join().unwrap();
        assert_eq!(&buf[..3], b"ijk");
        assert_eq!(read(&stream, &mut buf), (S_FALSE, 0), "after the end: nothing");

        let cut = Arc::new(StreamState::new());
        let stream = StreamingIStream::create(cut.clone());
        assert!(cut.push(b"abc"));
        let aborter = {
            let cut = cut.clone();
            std::thread::spawn(move || {
                assert!(cut.wait_for_waiting_reader(std::time::Duration::from_secs(10)), "the read waits for the rest");
                cut.abort();
            })
        };
        assert_eq!(read(&stream, &mut buf), (E_ABORT, 0), "aborted while waiting: nothing counts as read");
        aborter.join().unwrap();
    }

    // A COM caller may hand `Read` writable storage it has not initialised (WebView2's own
    // buffer is such storage). Run under Miri with `-Zmiri-recursive-validation`, which checks
    // what a reference points at, so a `&mut [u8]` formed over these bytes is reported.
    #[test]
    fn a_read_into_uninitialised_storage_writes_only_the_bytes_read() {
        let state = Arc::new(StreamState::new());
        let stream = StreamingIStream::create(state.clone());
        assert!(state.push(b"abc"));
        state.finish();
        let mut storage = [std::mem::MaybeUninit::<u8>::uninit(); 8];
        let mut n = 99u32;
        // SAFETY: `storage` is 8 writable bytes owned by this frame for the call, and `n` a local
        // u32 for the count; `Read` writes at most `cb` bytes and initialises what it reports.
        let hr = unsafe { stream.Read(storage.as_mut_ptr().cast(), 8, Some(&mut n)) };
        assert_eq!((hr, n), (S_FALSE, 3));
        // SAFETY: `Read` reported 3 bytes written, so the first 3 are initialised.
        let read = unsafe { std::slice::from_raw_parts(storage.as_ptr().cast::<u8>(), 3) };
        assert_eq!(read, b"abc");
    }

    // `Read` writes the bytes it reports and nothing after them: the caller's buffer past them
    // is as it was (here a pattern, where `a_read_into_uninitialised_storage...` has storage
    // that may not be read).
    #[test]
    fn a_read_leaves_the_rest_of_the_buffer_untouched() {
        let state = Arc::new(StreamState::new());
        let stream = StreamingIStream::create(state.clone());
        assert!(state.push(b"abc"));
        state.finish();
        let mut buf = [0xA5u8; 8];
        assert_eq!(read(&stream, &mut buf), (S_FALSE, 3));
        assert_eq!(&buf[..3], b"abc");
        assert_eq!(&buf[3..], &[0xA5; 5], "nothing written past the bytes read");
    }

    // Nothing unwinds out of the last `Release`: a panic in what the stream's release runs
    // (here the abandon callback the request path sets) stays inside the stream.
    #[test]
    fn a_panic_during_the_last_release_does_not_unwind() {
        let state = Arc::new(StreamState::new());
        state.set_on_abandoned(|| panic!("provoked by the test"));
        let stream = StreamingIStream::create(state.clone());
        drop(stream);
        assert!(state.is_abandoned());
        assert_eq!(Arc::strong_count(&state), 1);
    }

    // C++: "Streaming IStream: Read contract" (a NULL buffer for a non-zero
    // read is E_POINTER, a zero-byte read with a NULL buffer is S_OK).
    #[test]
    fn null_buffer_rules() {
        let stream = StreamingIStream::create(Arc::new(StreamState::new()));
        let mut n = 99u32;
        // SAFETY: a zero-byte read touches no buffer; `n` is a local u32.
        let hr = unsafe { stream.Read(std::ptr::null_mut(), 0, Some(&mut n)) };
        assert_eq!((hr, n), (S_OK, 0));
        n = 99;
        // SAFETY: the stream refuses a null buffer before touching it; `n` is a local u32.
        let hr = unsafe { stream.Read(std::ptr::null_mut(), 4, Some(&mut n)) };
        assert_eq!((hr, n), (E_POINTER, 0));
    }
}
