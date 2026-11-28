//! Which Sweetview binding owns this process (D50). Two bindings of the same crates exist, the
//! native package's and `@n1h/sweetview`'s; a process must run one Sweetview runtime, whichever
//! thread or package loads a binding. The first load in a process records its file in a
//! process-wide named file mapping (`Local\sweetview-binding-owner-<pid>`), and every later load,
//! of either binding, on any thread, reads it there and uses that file.

/// The file of the binding that owns this process: `file` when this is the first claim in the
/// process, else the file the first claim recorded.
pub fn claim(file: &str) -> Result<String, String> {
  imp::claim(file)
}

#[cfg(not(windows))]
mod imp {
  pub fn claim(file: &str) -> Result<String, String> {
    Ok(file.to_owned())
  }
}

#[cfg(windows)]
mod imp {
  use std::sync::atomic::{AtomicU32, Ordering};
  use std::sync::{Mutex, OnceLock, PoisonError};
  use std::time::{Duration, Instant};

  use windows::core::HSTRING;
  use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, INVALID_HANDLE_VALUE};
  use windows::Win32::System::Memory::{CreateFileMappingW, MapViewOfFile, UnmapViewOfFile, FILE_MAP_ALL_ACCESS, MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE};

  /// The record: a `u32` count of UTF-16 units, written last, then the units.
  const UNITS: usize = 2048;
  const BYTES: usize = 4 + UNITS * 2;

  /// The mapping and its view, held for the life of this library and released by `Drop`.
  struct Record {
    handle: HANDLE,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
  }

  // SAFETY: the handle and the view are process-wide kernel objects, valid on any thread; every
  // access goes through the `Mutex` below.
  unsafe impl Send for Record {}

  impl Drop for Record {
    fn drop(&mut self) {
      // SAFETY: `view` was returned by `MapViewOfFile` and is unmapped once, here.
      let _unmapped = unsafe { UnmapViewOfFile(self.view) };
      // SAFETY: `handle` was returned by `CreateFileMappingW` and is closed once, here.
      let _closed = unsafe { CloseHandle(self.handle) };
    }
  }

  static RECORD: OnceLock<Mutex<Option<Record>>> = OnceLock::new();

  pub fn claim(file: &str) -> Result<String, String> {
    let slot = RECORD.get_or_init(|| Mutex::new(None));
    let mut slot = slot.lock().unwrap_or_else(PoisonError::into_inner);
    if slot.is_none() {
      *slot = Some(open(file)?);
    }
    let record = slot.as_ref().map_or(std::ptr::null_mut(), |r| r.view.Value.cast::<u8>());
    read(record)
  }

  /// Opens the process's record, writing `file` into it when this call made it.
  fn open(file: &str) -> Result<Record, String> {
    let name = HSTRING::from(format!("Local\\sweetview-binding-owner-{}", std::process::id()));
    // SAFETY: a mapping of the paging file (no file handle), of `BYTES` bytes, named by a valid
    // string that outlives the call.
    let handle = unsafe { CreateFileMappingW(INVALID_HANDLE_VALUE, None, PAGE_READWRITE, 0, BYTES as u32, &name) }
      .map_err(|e| format!("sweetview: CreateFileMappingW failed: {e}"))?;
    // SAFETY: reads this thread's last error, set by the call above.
    let existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    // SAFETY: `handle` is the mapping just opened; the whole of it is mapped.
    let view = unsafe { MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, BYTES) };
    if view.Value.is_null() {
      // SAFETY: the handle opened above, closed once, here.
      let _closed = unsafe { CloseHandle(handle) };
      return Err("sweetview: MapViewOfFile failed for the binding owner record".into());
    }
    let record = Record { handle, view };
    if !existed {
      let units: Vec<u16> = file.encode_utf16().take(UNITS).collect();
      let (count, text) = parts(view.Value.cast::<u8>());
      for (i, unit) in units.iter().enumerate() {
        text[i * 2..i * 2 + 2].copy_from_slice(&unit.to_le_bytes());
      }
      // Written last, with release order: a reader that sees a count sees the units.
      count.store(units.len() as u32, Ordering::Release);
    }
    Ok(record)
  }

  /// The record's count and its units, over the view of `BYTES` bytes at `base`.
  fn parts<'a>(base: *mut u8) -> (&'a AtomicU32, &'a mut [u8]) {
    // SAFETY: `base` is a page-aligned view of `BYTES` bytes, mapped while `RECORD` holds it (the
    // life of the library); its first four bytes are the count, only ever accessed atomically.
    let count = unsafe { &*base.cast::<AtomicU32>() };
    // SAFETY: the `UNITS * 2` bytes after the count, inside the same view; each claim writes them only
    // before it sets the count, and reads them only after it sees one.
    let text = unsafe { std::slice::from_raw_parts_mut(base.wrapping_add(4), UNITS * 2) };
    (count, text)
  }

  /// The file the record names, waiting up to a second for the first claim to finish writing it.
  fn read(base: *mut u8) -> Result<String, String> {
    if base.is_null() {
      return Err("sweetview: the binding owner record is not open".into());
    }
    let (count, text) = parts(base);
    let until = Instant::now() + Duration::from_secs(1);
    loop {
      let count = count.load(Ordering::Acquire) as usize;
      if count > 0 && count <= UNITS {
        let units: Vec<u16> = (0..count).map(|i| u16::from_le_bytes([text[i * 2], text[i * 2 + 1]])).collect();
        return String::from_utf16(&units).map_err(|_| "sweetview: the binding owner record is not UTF-16".into());
      }
      if Instant::now() > until {
        return Err("sweetview: the binding owner record was never written".into());
      }
      std::thread::yield_now();
    }
  }

  #[cfg(test)]
  mod tests {
    #[test]
    fn the_first_claim_owns_the_process_and_later_ones_read_it() {
      let first = super::claim("C:\\first.node").expect("claim");
      assert_eq!(super::claim("C:\\second.node").expect("claim"), first);
      let other = std::thread::spawn(|| super::claim("C:\\third.node").expect("claim")).join().expect("thread");
      assert_eq!(other, first);
    }
  }
}
