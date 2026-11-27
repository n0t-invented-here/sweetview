//! Text on the system clipboard, read and written synchronously on the
//! calling thread.
//!
//! Only one process can have the clipboard open at a time, and clipboard
//! managers and remote-desktop clients hold it briefly, so opening it is tried
//! up to 5 times, 5 ms apart, as today.

use crate::ShellError;

/// How many times opening the clipboard is tried, and the pause between tries.
pub const OPEN_ATTEMPTS: u32 = 5;
pub const OPEN_RETRY_MS: u64 = 5;

/// Decodes `CF_UNICODETEXT` bytes up to the first NUL. `bytes` is the whole
/// global block (`GlobalSize` bounds it); a trailing odd byte is padding.
pub fn decode_unicode_text(bytes: &[u8]) -> Result<String, ShellError> {
  let units: Vec<u16> = bytes.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
  let end = units.iter().position(|&unit| unit == 0).ok_or_else(|| ShellError("sweetview: CF_UNICODETEXT has no NUL terminator".into()))?;
  Ok(String::from_utf16_lossy(&units[..end]))
}

/// The bytes written as `CF_UNICODETEXT`: UTF-16LE with a NUL terminator.
pub fn encode_unicode_text(text: &str) -> Vec<u8> {
  text.encode_utf16().chain([0]).flat_map(u16::to_le_bytes).collect()
}

#[cfg(windows)]
mod imp {
  use std::marker::PhantomData;
  use std::time::Duration;

  use windows::core::HSTRING;
  use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND};
  use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData};
  use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
  use windows::Win32::System::Ole::CF_UNICODETEXT;

  use super::{decode_unicode_text, encode_unicode_text, OPEN_ATTEMPTS, OPEN_RETRY_MS};
  use crate::win::{default_procedure, last_error, MessageWindow};
  use crate::ShellError;

  /// The clipboard, open on this thread until dropped. It borrows the owner
  /// window it was opened with, so that window outlives the open clipboard.
  struct OpenedClipboard<'a> {
    _owner: PhantomData<&'a MessageWindow>,
    _not_send: PhantomData<*const ()>,
  }

  impl<'a> OpenedClipboard<'a> {
    /// Opens the clipboard for `owner` (none: the open is not associated with a window).
    fn open(owner: Option<&'a MessageWindow>) -> Result<Self, ShellError> {
      let hwnd: Option<HWND> = owner.map(MessageWindow::hwnd);
      let mut error = 0;
      for attempt in 0..OPEN_ATTEMPTS {
        // SAFETY: `hwnd` is none or the window of `owner`, which this value borrows for as
        // long as the clipboard stays open, so the window outlives the open.
        let opened = unsafe { OpenClipboard(hwnd) };
        if opened.is_ok() {
          return Ok(Self { _owner: PhantomData, _not_send: PhantomData });
        }
        error = last_error();
        if attempt + 1 < OPEN_ATTEMPTS {
          std::thread::sleep(Duration::from_millis(OPEN_RETRY_MS));
        }
      }
      Err(ShellError(format!("sweetview: OpenClipboard failed ({error})")))
    }

    fn empty(&self) -> Result<(), ShellError> {
      // SAFETY: the clipboard is open on this thread while `self` lives.
      let emptied = unsafe { EmptyClipboard() };
      emptied.map_err(|_| ShellError(format!("sweetview: EmptyClipboard failed ({})", last_error())))
    }
  }

  impl Drop for OpenedClipboard<'_> {
    fn drop(&mut self) {
      // SAFETY: this value exists only while this thread has the clipboard open.
      let closed = unsafe { CloseClipboard() };
      let _ = closed;
    }
  }

  /// A global memory block locked until dropped. It borrows the block: the
  /// clipboard or an [`OwnedGlobal`] owns it, and outlives this lock.
  struct LockedGlobal<'a> {
    memory: HGLOBAL,
    address: *mut u8,
    _block: PhantomData<&'a ()>,
  }

  impl<'a> LockedGlobal<'a> {
    fn lock(memory: HGLOBAL) -> Result<Self, ShellError> {
      // SAFETY: `memory` is a movable global block that the caller's owner keeps allocated
      // for `'a`; GlobalLock reads no memory of ours.
      let address = unsafe { GlobalLock(memory) };
      if address.is_null() {
        return Err(ShellError(format!("sweetview: GlobalLock failed ({})", last_error())));
      }
      Ok(Self { memory, address: address.cast(), _block: PhantomData })
    }

    /// The whole block, as `GlobalSize` reports it.
    fn bytes(&self) -> &[u8] {
      // SAFETY: GlobalSize takes the handle by value and reads no memory of ours.
      let size = unsafe { GlobalSize(self.memory) };
      // SAFETY: `address` points at the locked block, which is `size` bytes long, stays
      // locked and allocated while `self` lives, and is not written through while this
      // shared borrow of `self` lives.
      unsafe { std::slice::from_raw_parts(self.address, size) }
    }

    /// Copies `data` to the start of the block, which must be at least that long.
    fn write(&mut self, data: &[u8]) -> Result<(), ShellError> {
      // SAFETY: GlobalSize takes the handle by value and reads no memory of ours.
      let size = unsafe { GlobalSize(self.memory) };
      if size < data.len() {
        return Err(ShellError(format!("sweetview: GlobalAlloc returned {size} bytes for {}", data.len())));
      }
      // SAFETY: the block is locked at `address` and at least `data.len()` bytes long (checked
      // just above), `data` is a separate Rust buffer, so the ranges do not overlap, and the
      // exclusive borrow of `self` keeps any other view of the block from existing.
      unsafe { std::ptr::copy_nonoverlapping(data.as_ptr(), self.address, data.len()) };
      Ok(())
    }
  }

  impl Drop for LockedGlobal<'_> {
    fn drop(&mut self) {
      // SAFETY: balances the GlobalLock of `lock` on the same block, which is still allocated.
      let unlocked = unsafe { GlobalUnlock(self.memory) };
      // GlobalUnlock reports "not locked any more" as an error; that is the state wanted.
      let _ = unlocked;
    }
  }

  /// A global memory block this value allocated and frees, until it is handed
  /// to the clipboard.
  struct OwnedGlobal(Option<HGLOBAL>);

  impl OwnedGlobal {
    fn alloc(bytes: usize) -> Result<Self, ShellError> {
      // SAFETY: GlobalAlloc takes its flags and size by value and reads no memory of ours.
      let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes) };
      memory.map(|m| Self(Some(m))).map_err(|_| ShellError(format!("sweetview: GlobalAlloc failed ({})", last_error())))
    }

    fn handle(&self) -> HGLOBAL {
      self.0.unwrap_or_default()
    }

    /// The clipboard took the block: it frees it from now on.
    fn transferred(mut self) {
      self.0 = None;
    }
  }

  impl Drop for OwnedGlobal {
    fn drop(&mut self) {
      if let Some(memory) = self.0 {
        // SAFETY: `memory` was allocated by `alloc` for this value alone, was not handed to
        // the clipboard (`transferred` clears it), and is not locked: every lock borrows it
        // and has ended.
        let freed = unsafe { windows::Win32::Foundation::GlobalFree(Some(memory)) };
        let _ = freed;
      }
    }
  }

  pub fn read_text() -> Result<Option<String>, ShellError> {
    let _open = OpenedClipboard::open(None)?;
    // SAFETY: the clipboard is open on this thread (`_open`) for the whole use of the handle.
    let data = unsafe { GetClipboardData(u32::from(CF_UNICODETEXT.0)) };
    let Ok(handle) = data else { return Ok(None) };
    // The clipboard owns the block and keeps it while the clipboard stays open.
    let lock = LockedGlobal::lock(HGLOBAL(handle.0))?;
    // GlobalSize bounds the scan. Padding after the terminator is not text.
    decode_unicode_text(lock.bytes()).map(Some)
  }

  pub fn write_text(text: &str) -> Result<(), ShellError> {
    // EmptyClipboard assigns the open window as owner. No window cannot own new data.
    let owner = MessageWindow::new(&HSTRING::from("SweetviewClipboardOwner"), &HSTRING::from("sweetview.clipboard"), Some(default_procedure))?;
    let open = OpenedClipboard::open(Some(&owner))?;
    let data = encode_unicode_text(text);
    let memory = OwnedGlobal::alloc(data.len())?;
    LockedGlobal::lock(memory.handle())?.write(&data)?;
    open.empty()?;
    // SAFETY: the clipboard is open on this thread (`open`), and `memory` is an unlocked
    // movable block holding NUL-terminated UTF-16 text, as CF_UNICODETEXT requires.
    let set = unsafe { SetClipboardData(u32::from(CF_UNICODETEXT.0), Some(HANDLE(memory.handle().0))) };
    match set {
      Ok(_) => {
        memory.transferred();
        Ok(())
      }
      Err(_) => Err(ShellError(format!("sweetview: SetClipboardData failed ({})", last_error()))),
    }
  }

  pub fn clear() -> Result<(), ShellError> {
    OpenedClipboard::open(None)?.empty()
  }
}

#[cfg(not(windows))]
mod imp {
  use crate::{unported, ShellError};

  pub fn read_text() -> Result<Option<String>, ShellError> {
    Err(unported("the clipboard"))
  }

  pub fn write_text(_text: &str) -> Result<(), ShellError> {
    Err(unported("the clipboard"))
  }

  pub fn clear() -> Result<(), ShellError> {
    Err(unported("the clipboard"))
  }
}

/// The clipboard's text, or `None` when it holds no text. Fails when the
/// clipboard stays busy for every attempt or its text is malformed.
pub fn read_text() -> Result<Option<String>, ShellError> {
  imp::read_text()
}

/// Replaces the whole clipboard (every format) with `text`.
pub fn write_text(text: &str) -> Result<(), ShellError> {
  imp::write_text(text)
}

/// Empties the clipboard.
pub fn clear() -> Result<(), ShellError> {
  imp::clear()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn text_is_framed_as_nul_terminated_utf16() {
    assert_eq!(encode_unicode_text("A\u{e9}"), [0x41, 0, 0xe9, 0, 0, 0]);
    assert_eq!(decode_unicode_text(&encode_unicode_text("h\u{e9}llo \u{1f600}")).unwrap(), "h\u{e9}llo \u{1f600}");
    assert_eq!(decode_unicode_text(&encode_unicode_text("")).unwrap(), "");
    // Padding after the terminator, and an odd trailing byte, are not text.
    assert_eq!(decode_unicode_text(&[0x41, 0, 0, 0, 0x42, 0, 7]).unwrap(), "A");
    assert_eq!(decode_unicode_text(&[0x41, 0, 0x42]).unwrap_err().0, "sweetview: CF_UNICODETEXT has no NUL terminator");
  }

  #[cfg(windows)]
  mod live {
    use super::super::*;
    use crate::win::test_support::counts;

    /// Restores the clipboard's text when the test ends, passed or failed.
    struct Restore(Option<String>);

    impl Drop for Restore {
      fn drop(&mut self) {
        let restored = match &self.0 {
          Some(text) => write_text(text),
          None => clear(),
        };
        restored.expect("restore the clipboard");
      }
    }

    #[test]
    fn unicode_and_empty_text_round_trip_and_clear_empties() {
      let _serial = crate::serial();
      let _restore = Restore(read_text().expect("read the clipboard first"));
      let text = "Sweetview \u{2014} \u{65e5}\u{672c}\u{8a9e} \u{1f600}\r\nsecond line";
      write_text(text).expect("write");
      assert_eq!(read_text().expect("read").as_deref(), Some(text));
      write_text("").expect("write empty");
      assert_eq!(read_text().expect("read").as_deref(), Some(""));
      clear().expect("clear");
      assert_eq!(read_text().expect("read"), None);
    }

    #[test]
    fn writing_returns_every_handle() {
      let _serial = crate::serial();
      let _restore = Restore(read_text().expect("read the clipboard first"));
      // One round first, so one-time costs (the window class) are paid.
      write_text("warm").expect("write");
      let before = counts();
      for round in 0..100 {
        write_text(&format!("round {round}")).expect("write");
        assert!(read_text().expect("read").is_some());
      }
      clear().expect("clear");
      let after = counts();
      // `<=`: an earlier test's thread may still be exiting, freeing its own USER objects.
      assert!(after.0 <= before.0 && after.1 <= before.1, "USER and GDI objects returned to the starting count: {before:?} -> {after:?}");
      assert!(after.2 <= before.2 + 2, "kernel handles returned to the starting count: {before:?} -> {after:?}");
    }
  }
}
