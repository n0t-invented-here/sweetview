//! The folder dialog on Windows: `IFileOpenDialog` with `FOS_PICKFOLDERS`, the
//! calls tag `pre-rust-rewrite` made, so a COM failure is an error that names
//! its step, as it threw there. `rfd` 0.18.0 answers `None` for every failure
//! as for a cancel (`src/backend/win_cid/file_dialog.rs`, `run(self).ok()`),
//! which cannot carry that (D44).
//!
//! The calling thread must be in a single-threaded COM apartment, as the
//! runtime's UI thread is. The dialog runs its own message loop until it closes.

use std::fmt;

use windows::core::HSTRING;
use windows::Win32::Foundation::ERROR_CANCELLED;
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_INPROC_SERVER};
use windows::Win32::UI::Shell::{
  FileOpenDialog, IFileOpenDialog, FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
};

use crate::NativeWindow;

/// A step of the folder dialog that COM refused, with the `HRESULT` it gave.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderDialogError {
  pub step: &'static str,
  pub hresult: i32,
}

impl fmt::Display for FolderDialogError {
  /// `<step> failed: HRESULT 0x<code>`, the tag's words.
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "{} failed: HRESULT 0x{:x}", self.step, self.hresult as u32)
  }
}

impl std::error::Error for FolderDialogError {}

/// Shows the folder dialog titled `title`, modal to `owner` (unowned when
/// `None`), and returns the chosen folder's path, or `None` when the user
/// cancels. Blocks until the dialog closes.
pub fn pick_folder(owner: Option<&impl NativeWindow>, title: &str) -> Result<Option<String>, FolderDialogError> {
  let failed = |step: &'static str| move |e: windows::core::Error| FolderDialogError { step, hresult: e.code().0 };
  // SAFETY: the class and interface are the Shell's own pair; no outer object is passed. A thread
  // outside a COM apartment gets an error, not undefined behaviour.
  let dialog: IFileOpenDialog = unsafe { CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER) }.map_err(failed("CoCreateInstance(FileOpenDialog)"))?;
  // SAFETY: a method of the live interface `dialog` owns; it fills a value it returns.
  let options = unsafe { dialog.GetOptions() }.map_err(failed("GetOptions"))?;
  let options = options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR;
  // SAFETY: a method of the live interface, given a value.
  unsafe { dialog.SetOptions(options) }.map_err(failed("SetOptions"))?;
  let title = HSTRING::from(title);
  // SAFETY: `title` is a NUL-terminated wide string alive for the call; the dialog copies it.
  unsafe { dialog.SetTitle(&title) }.map_err(failed("SetTitle"))?;
  // SAFETY: the owner's handle is named by `NativeWindow` and lent for the whole call, which is
  // the dialog's whole life; the OS validates it.
  match unsafe { dialog.Show(owner.map(|owner| owner.hwnd())) } {
    Err(e) if e.code() == ERROR_CANCELLED.to_hresult() => return Ok(None),
    shown => shown.map_err(failed("Show"))?,
  }
  // SAFETY: a method of the live interface; it returns an owned `IShellItem`.
  let item = unsafe { dialog.GetResult() }.map_err(failed("GetResult"))?;
  // SAFETY: a method of the live item; it returns a string COM allocated, freed below.
  let path = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) }.map_err(failed("GetDisplayName"))?;
  // SAFETY: `path` is the NUL-terminated wide string the call returned, not yet freed.
  let text = String::from_utf16_lossy(unsafe { path.as_wide() });
  // SAFETY: `path` was allocated by COM for this caller and is freed once, after its last read.
  unsafe { CoTaskMemFree(Some(path.0 as *const core::ffi::c_void)) };
  Ok(Some(text))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::BorrowedWindow;

  #[test]
  fn a_com_failure_is_an_error_that_names_its_step_not_a_cancel() {
    // A thread of its own that never entered a COM apartment: the dialog cannot be made.
    let refused = std::thread::spawn(|| pick_folder(None::<&BorrowedWindow<'_>>, "never shown").map_err(|e| e.to_string()))
      .join()
      .expect("thread");
    assert_eq!(refused, Err("CoCreateInstance(FileOpenDialog) failed: HRESULT 0x800401f0".to_string()));
  }
}
