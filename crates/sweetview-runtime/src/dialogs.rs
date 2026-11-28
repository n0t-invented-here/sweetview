//! The folder dialog: on Windows the platform crate's `IFileOpenDialog`, whose
//! COM failures are errors (D45); elsewhere `rfd`.

use sweetview_platform_window::BorrowedWindow;

use crate::error::Result;
use crate::runtime::Runtime;

/// Shows the OS folder dialog titled `title`, owned by the window `owner` names
/// (none when `None`, or when the value names no window), and returns the chosen
/// folder's path, or `None` when the user cancels. Blocks until the dialog
/// closes; the UI thread's signals, timers and wakes go on arriving meanwhile,
/// because the dialog's own message loop dispatches them. On Windows a step COM
/// refuses is an error, `<step> failed: HRESULT 0x<code>`.
#[cfg(windows)]
pub fn pick_folder(owner: Option<isize>, title: &str) -> Result<Option<String>> {
  // The runtime first: making it initialises COM on this thread as a single-threaded
  // apartment, which the dialog needs, and sets the DPI awareness every window shares.
  Runtime::get()?;
  let pick = |owner: Option<&BorrowedWindow<'_>>| {
    sweetview_platform_window::pick_folder(owner, title).map_err(|e| crate::error::Error::Os(e.to_string()))
  };
  // The owner is lent for the whole dialog, which is modal to it.
  let owned = owner.and_then(|owner| BorrowedWindow::with_handle_value(owner, |owner| pick(Some(owner))));
  match owned {
    Some(chosen) => chosen,
    None => pick(None),
  }
}

/// See the Windows `pick_folder`.
#[cfg(not(windows))]
pub fn pick_folder(owner: Option<isize>, title: &str) -> Result<Option<String>> {
  // The runtime first: making it initialises COM on this thread as a single-threaded
  // apartment, which the dialog needs, and sets the DPI awareness every window shares.
  Runtime::get()?;
  let dialog = rfd::FileDialog::new().set_title(title);
  let pick = |dialog: rfd::FileDialog| dialog.pick_folder().map(|path| path.to_string_lossy().into_owned());
  // The owner is lent for the whole dialog: `rfd` passes its handle to the OS dialog as its owner.
  let owned = owner.and_then(|owner| BorrowedWindow::with_handle_value(owner, |owner| pick(dialog.clone().set_parent(owner))));
  Ok(match owned {
    Some(chosen) => chosen,
    None => pick(dialog),
  })
}
