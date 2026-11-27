//! The folder dialog, through `rfd`.

use sweetview_platform_window::ForeignWindow;

use crate::error::Result;
use crate::runtime::Runtime;

/// Shows the OS folder dialog titled `title`, owned by the window `owner` names
/// (none when `None`, or when the value names no window), and returns the chosen
/// folder's path, or `None` when the user cancels. Blocks until the dialog
/// closes; the UI thread's signals, timers and wakes go on arriving meanwhile,
/// because the dialog's own message loop dispatches them.
pub fn pick_folder(owner: Option<isize>, title: &str) -> Result<Option<String>> {
  // The runtime first: making it initialises COM on this thread as a single-threaded
  // apartment, which the dialog needs, and sets the DPI awareness every window shares.
  Runtime::get()?;
  let mut dialog = rfd::FileDialog::new().set_title(title);
  let owner = owner.and_then(ForeignWindow::from_handle_value);
  if let Some(owner) = &owner {
    dialog = dialog.set_parent(owner);
  }
  Ok(dialog.pick_folder().map(|path| path.to_string_lossy().into_owned()))
}
