//! What the C++ webview library's `webview_set_size` did to a window it was
//! given (`webview_create` with a window handle), which a webview mounted in an
//! application's own window still does:
//!
//! * `FIXED` takes `WS_THICKFRAME` and `WS_MAXIMIZEBOX` off the window's
//!   style; every other hint puts them on.
//! * `NONE` and `FIXED` size the window so its client area is `width` x
//!   `height` device-independent pixels at the window's DPI (the frame from
//!   `AdjustWindowRectExForDpi` with the new style), without moving it,
//!   activating it or changing its z-order, and re-read the frame.
//! * `MIN` and `MAX` change only the style: the library kept the bound for
//!   its own window's `WM_GETMINMAXINFO`, which a given window never runs.
//! * The window is never shown: the library showed only a window it made.

// The style and the scaled size, decided without an OS call, in `sweetview-window-logic`.
pub use sweetview_window_logic::given_size::{scale_to_dpi, style_for_size_hint, GivenWindowSizeHint};

#[cfg(windows)]
pub use imp::apply_given_window_size;

#[cfg(windows)]
mod imp {
  use windows::Win32::Foundation::{HWND, RECT};
  use windows::Win32::UI::HiDpi::AdjustWindowRectExForDpi;
  use windows::Win32::UI::WindowsAndMessaging::{
    GWL_STYLE, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOZORDER, WINDOW_EX_STYLE, WINDOW_STYLE,
  };

  use super::{scale_to_dpi, style_for_size_hint, GivenWindowSizeHint};
  use crate::platform::{dpi_of, set_style_of, set_window_pos};
  use crate::{style, NativeWindow, Rect};

  /// Applies `webview_set_size(width, height, hint)` to a window the webview
  /// was given, as the C++ library did (see the module). False when the OS
  /// refused a step; a window that is gone refuses every step.
  pub fn apply_given_window_size(window: &impl NativeWindow, width: u32, height: u32, hint: GivenWindowSizeHint) -> bool {
    // The window named by `NativeWindow`; the OS validates it on each call below.
    let hwnd: HWND = window.hwnd();
    let new_style = style_for_size_hint(style(window), hint);
    // On a window that is gone the call fails with ERROR_INVALID_WINDOW_HANDLE and writes nothing.
    let _previous = set_style_of(hwnd, GWL_STYLE, new_style as isize);
    if matches!(hint, GivenWindowSizeHint::Min | GivenWindowSizeHint::Max) {
      return true;
    }
    let dpi = dpi_of(hwnd);
    let mut frame = RECT { left: 0, top: 0, right: scale_to_dpi(width, dpi), bottom: scale_to_dpi(height, dpi) };
    // As the library: the window's style, no menu, no extended style.
    // SAFETY: `frame` is a RECT owned by this frame for the call to adjust in place.
    let adjusted = unsafe { AdjustWindowRectExForDpi(&mut frame, WINDOW_STYLE(new_style), false, WINDOW_EX_STYLE(0), dpi) };
    if adjusted.is_err() {
      return false;
    }
    let flags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOMOVE | SWP_FRAMECHANGED;
    set_window_pos(hwnd, None, Rect::new(0, 0, frame.right - frame.left, frame.bottom - frame.top), flags)
  }
}

/// Stand-in: there is no given window to size on this platform yet.
#[cfg(not(windows))]
pub fn apply_given_window_size(_window: &impl crate::NativeWindow, _width: u32, _height: u32, _hint: GivenWindowSizeHint) -> bool {
  false
}

#[cfg(all(test, windows))]
mod live_tests {
  use std::sync::PoisonError;

  use super::*;
  use crate::platform::client_size;
  use crate::platform::tests::TestWindow;
  use crate::{dpi_scale, is_visible, style};

  #[test]
  fn a_given_window_is_restyled_and_resized_as_the_library_did_and_never_shown() {
    let _serial = crate::TEST_SERIAL.lock().unwrap_or_else(PoisonError::into_inner);
    // A hidden top-level window of this thread, as an application would hand one over.
    let window = TestWindow::new();
    let given = window.foreign();
    let client = || client_size(window.0).expect("GetClientRect");
    let resizable = 0x0004_0000 | 0x0001_0000;
    let dpi = (dpi_scale(&given) * 96.0).round() as u32;

    assert!(apply_given_window_size(&given, 420, 260, GivenWindowSizeHint::None));
    assert_eq!(client(), (scale_to_dpi(420, dpi), scale_to_dpi(260, dpi)));
    assert_eq!(style(&given) & resizable, resizable);

    assert!(apply_given_window_size(&given, 400, 250, GivenWindowSizeHint::Fixed));
    assert_eq!(client(), (scale_to_dpi(400, dpi), scale_to_dpi(250, dpi)));
    assert_eq!(style(&given) & resizable, 0);

    // MIN and MAX: the style only.
    assert!(apply_given_window_size(&given, 100, 100, GivenWindowSizeHint::Min));
    assert!(apply_given_window_size(&given, 900, 900, GivenWindowSizeHint::Max));
    assert_eq!(client(), (scale_to_dpi(400, dpi), scale_to_dpi(250, dpi)));
    assert_eq!(style(&given) & resizable, resizable);

    assert!(!is_visible(&given));
  }
}
