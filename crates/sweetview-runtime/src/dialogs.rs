//! The folder dialog: on Windows the platform crate's `IFileOpenDialog`, whose
//! COM failures are errors (D46); elsewhere `rfd`.

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
  // A closure, not the function: it is general over the lent window's lifetime, the function is not.
  #[allow(clippy::redundant_closure)]
  pick_folder_with(owner, title, |owner, title| sweetview_platform_window::pick_folder(owner, title))
}

/// `pick_folder` with the platform's dialog given: what the runtime does around it (the
/// runtime first, the owner lent, a refused step turned into the error the binding throws).
#[cfg(windows)]
fn pick_folder_with(
  owner: Option<isize>,
  title: &str,
  dialog: impl Fn(Option<&BorrowedWindow<'_>>, &str) -> std::result::Result<Option<String>, sweetview_platform_window::FolderDialogError>,
) -> Result<Option<String>> {
  // The runtime first: making it initialises COM on this thread as a single-threaded
  // apartment, which the dialog needs, and sets the DPI awareness every window shares.
  Runtime::get()?;
  let pick = |owner: Option<&BorrowedWindow<'_>>| dialog(owner, title).map_err(|e| crate::error::Error::Os(e.to_string()));
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

#[cfg(all(test, windows))]
mod tests {
  use super::*;
  use crate::runtime::testing::on_ui_thread;
  use sweetview_platform_window::FolderDialogError;

  /// Review round 5, R5-7: a step of the folder dialog that COM refuses comes out of the runtime as
  /// the error the binding throws, `<step> failed: HRESULT 0x<code>`, with the owner lent to the
  /// dialog when the value names a window and the dialog unowned when it does not. (A real step
  /// cannot be made to fail on the UI thread, whose COM apartment the runtime enters; the
  /// platform's own test fails one on a thread without COM.)
  #[test]
  fn a_refused_dialog_step_is_the_error_the_binding_throws() {
    on_ui_thread(|runtime| {
      let own = runtime
        .with_target(|target| tao::window::WindowBuilder::new().with_visible(false).with_title("rt dialog owner").build(target))
        .expect("target")
        .expect("window");
      let owner = sweetview_platform_window::handle_value(&own);
      let owned = std::cell::Cell::new(None);
      let refused = pick_folder_with(Some(owner), "never shown", |lent, _| {
        owned.set(Some(lent.map(sweetview_platform_window::handle_value)));
        Err(FolderDialogError { step: "Show", hresult: 0x8007_0005_u32 as i32 })
      });
      assert_eq!(refused.map_err(|e| e.to_string()), Err("Show failed: HRESULT 0x80070005".to_string()));
      assert_eq!(owned.get(), Some(Some(owner)), "the owner is lent to the dialog");
      let unowned = pick_folder_with(Some(1), "never shown", |lent, _| {
        owned.set(Some(lent.map(sweetview_platform_window::handle_value)));
        Ok(None)
      });
      assert_eq!((unowned.ok(), owned.get()), (Some(None), Some(None)), "a value that names no window: unowned");
    });
  }
}
