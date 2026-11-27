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

  use raw_window_handle::{HasWindowHandle, RawWindowHandle};
  use sweetview_platform_loop::MessageWindow;
  use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND};
  use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData};
  use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
  use windows::Win32::System::Ole::CF_UNICODETEXT;

  use super::{decode_unicode_text, encode_unicode_text, OPEN_ATTEMPTS, OPEN_RETRY_MS};
  use crate::win::last_error;
  use crate::ShellError;

  /// The clipboard, open on this thread until dropped. It borrows the owner
  /// window it was opened with, so that window outlives the open clipboard.
  pub(super) struct OpenedClipboard<'a> {
    _owner: PhantomData<&'a MessageWindow>,
    _not_send: PhantomData<*const ()>,
  }

  impl<'a> OpenedClipboard<'a> {
    /// Opens the clipboard for `owner` (none: the open is not associated with a window).
    fn open(owner: Option<&'a MessageWindow>) -> Result<Self, ShellError> {
      // The owner's handle, borrowed from `owner` for as long as `'a`.
      let hwnd: Option<HWND> = owner.and_then(|owner| match owner.window_handle().ok()?.as_raw() {
        RawWindowHandle::Win32(handle) => Some(HWND(handle.hwnd.get() as *mut core::ffi::c_void)),
        _ => None,
      });
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

  /// The owner of a global block that a [`LockedGlobal`] borrows for as long as it is locked.
  pub(super) enum Block<'a> {
    /// A block this process allocated and has not handed over, borrowed exclusively:
    /// no other lock of it, and no free, while this one lives.
    Owned(&'a mut OwnedGlobal),
    /// The clipboard's `CF_UNICODETEXT` block, which the clipboard keeps allocated
    /// while it stays open, which the borrow of the open clipboard guarantees.
    ClipboardText(&'a OpenedClipboard<'a>),
  }

  /// A global memory block locked until dropped. It borrows the block's owner
  /// (see [`Block`]), so the block stays allocated for as long as it is locked.
  pub(super) struct LockedGlobal<'a> {
    memory: HGLOBAL,
    address: *mut u8,
    /// The block's length, as `GlobalSize` reported it once the block was locked.
    size: usize,
    _block: PhantomData<Block<'a>>,
  }

  impl<'a> LockedGlobal<'a> {
    /// Locks the block `block` names; `None` when the clipboard holds no text.
    pub(super) fn lock(block: Block<'a>) -> Result<Option<Self>, ShellError> {
      let memory = match block {
        Block::Owned(owned) => owned.handle(),
        Block::ClipboardText(_open) => {
          // SAFETY: the clipboard is open on this thread for as long as `_open` is borrowed,
          // which is `'a`, the life of this lock and of every use of the handle.
          let data = unsafe { GetClipboardData(u32::from(CF_UNICODETEXT.0)) };
          let Ok(handle) = data else { return Ok(None) };
          HGLOBAL(handle.0)
        }
      };
      // SAFETY: `memory` is a movable global block that `block`'s owner keeps allocated for
      // `'a` (see `Block`); GlobalLock reads no memory of ours.
      let address = unsafe { GlobalLock(memory) };
      if address.is_null() {
        return Err(ShellError(format!("sweetview: GlobalLock failed ({})", last_error())));
      }
      // SAFETY: GlobalSize takes the handle by value and reads no memory of ours. The block is
      // locked and kept allocated for `'a`, so its size cannot change while this lock lives.
      let size = unsafe { GlobalSize(memory) };
      Ok(Some(Self { memory, address: address.cast(), size, _block: PhantomData }))
    }

    /// The whole block, as `GlobalSize` reports it.
    fn bytes(&self) -> &[u8] {
      // SAFETY: `address` points at the locked block, which is `self.size` bytes long, stays
      // locked and allocated while `self` lives, and is not written through while this
      // shared borrow of `self` lives.
      unsafe { std::slice::from_raw_parts(self.address, self.size) }
    }

    /// Copies `data` to the start of the block, which must be at least that long.
    pub(super) fn write(&mut self, data: &[u8]) -> Result<(), ShellError> {
      let size = self.size;
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
  pub(super) struct OwnedGlobal(Option<HGLOBAL>);

  impl OwnedGlobal {
    pub(super) fn alloc(bytes: usize) -> Result<Self, ShellError> {
      // SAFETY: GlobalAlloc takes its flags and size by value and reads no memory of ours.
      let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes) };
      memory.map(|m| Self(Some(m))).map_err(|_| ShellError(format!("sweetview: GlobalAlloc failed ({})", last_error())))
    }

    pub(super) fn handle(&self) -> HGLOBAL {
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
        // the clipboard (`transferred` clears it), and is not locked: a lock borrows this
        // value exclusively (`Block::Owned`), so every lock has ended before this drop.
        let freed = unsafe { windows::Win32::Foundation::GlobalFree(Some(memory)) };
        let _ = freed;
      }
    }
  }

  pub fn read_text() -> Result<Option<String>, ShellError> {
    let open = OpenedClipboard::open(None)?;
    // The clipboard owns the block and keeps it while `open` is borrowed.
    let Some(lock) = LockedGlobal::lock(Block::ClipboardText(&open))? else { return Ok(None) };
    // GlobalSize bounds the scan. Padding after the terminator is not text.
    decode_unicode_text(lock.bytes()).map(Some)
  }

  pub fn write_text(text: &str) -> Result<(), ShellError> {
    // EmptyClipboard assigns the open window as owner. No window cannot own new data.
    let owner = MessageWindow::new("SweetviewClipboardOwner", "sweetview.clipboard", |_, _, _| None)
      .map_err(|e| ShellError(format!("sweetview: {}(SweetviewClipboardOwner) failed ({})", e.call(), e.code())))?;
    let open = OpenedClipboard::open(Some(&owner))?;
    let data = encode_unicode_text(text);
    let mut memory = OwnedGlobal::alloc(data.len())?;
    if let Some(mut lock) = LockedGlobal::lock(Block::Owned(&mut memory))? {
      lock.write(&data)?;
    }
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
      let mut round = 0u32;
      sweetview_platform_loop::testing::assert_gives_back_every_handle(100, || {
        round += 1;
        write_text(&format!("round {round}")).expect("write");
        assert!(read_text().expect("read").is_some());
      });
      clear().expect("clear");
    }

    /// The handle counts do not include global memory, so the block a write
    /// allocates is checked directly: one that is not handed to the clipboard
    /// is freed when its owner drops.
    #[test]
    fn a_global_block_not_handed_over_is_freed() {
      use windows::Win32::System::Memory::GlobalSize;
      let text = encode_unicode_text("never handed to the clipboard");
      let mut memory = super::super::imp::OwnedGlobal::alloc(text.len()).expect("alloc");
      super::super::imp::LockedGlobal::lock(super::super::imp::Block::Owned(&mut memory)).expect("lock").expect("a block").write(&text).expect("write");
      let handle = memory.handle();
      // SAFETY: GlobalSize takes a handle value by value and only reports on it, 0 for a value
      // that names no block; nothing of ours is read or written.
      let block_size = |block| unsafe { GlobalSize(block) };
      assert!(block_size(handle) >= text.len(), "a live block while owned");
      drop(memory);
      assert_eq!(block_size(handle), 0, "freed by the owner's drop");
    }
  }
}
