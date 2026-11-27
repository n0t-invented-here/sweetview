//! Text on the system clipboard, synchronously, on the UI thread.
//!
//! The work is done by `sweetview-platform-shell`; its errors carry the
//! messages today's code throws.

use sweetview_platform_shell::clipboard;

use crate::error::{Error, Result};
use crate::runtime::Runtime;
use crate::threads;

/// The clipboard's text, or `None` when it holds no text.
pub fn read_text() -> Result<Option<String>> {
  threads::require_ui_thread()?;
  clipboard::read_text().map_err(|e| Error::Os(e.0))
}

/// Replaces the whole clipboard (every format) with `text`.
pub fn write_text(text: &str) -> Result<()> {
  threads::require_ui_thread()?;
  // The write makes a hidden owner window; the runtime's event loop has made
  // the process per-monitor DPI aware first, as `ensureWin32Init` did.
  Runtime::get()?;
  clipboard::write_text(text).map_err(|e| Error::Os(e.0))
}

/// Empties the clipboard.
pub fn clear() -> Result<()> {
  threads::require_ui_thread()?;
  clipboard::clear().map_err(|e| Error::Os(e.0))
}

#[cfg(all(test, windows))]
mod tests {
  use super::*;
  use crate::runtime::testing::on_ui_thread;

  #[test]
  fn another_thread_is_refused() {
    on_ui_thread(|_runtime| {
      let refused = std::thread::spawn(|| (read_text().err(), write_text("x").err(), clear().err())).join().expect("thread");
      assert_eq!(refused, (Some(Error::NotUiThread), Some(Error::NotUiThread), Some(Error::NotUiThread)));
    });
  }

  #[test]
  fn text_round_trips_and_the_clipboard_is_restored() {
    on_ui_thread(|_runtime| {
      let before = read_text().expect("read first");
      let text = "Sweetview runtime \u{1f950}";
      let outcome = std::panic::catch_unwind(|| {
        write_text(text).expect("write");
        assert_eq!(read_text().expect("read").as_deref(), Some(text));
        clear().expect("clear");
        assert_eq!(read_text().expect("read"), None);
      });
      match &before {
        Some(previous) => write_text(previous).expect("restore"),
        None => clear().expect("restore"),
      }
      outcome.expect("round trip");
    });
  }
}
