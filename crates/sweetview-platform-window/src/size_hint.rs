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

/// The hint of a size, as the C API numbered it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GivenWindowSizeHint {
  None,
  Min,
  Max,
  Fixed,
}

/// The style the window gets for `hint`, from the style it has.
pub fn style_for_size_hint(style: u32, hint: GivenWindowSizeHint) -> u32 {
  const WS_THICKFRAME: u32 = 0x0004_0000;
  const WS_MAXIMIZEBOX: u32 = 0x0001_0000;
  if hint == GivenWindowSizeHint::Fixed {
    style & !(WS_THICKFRAME | WS_MAXIMIZEBOX)
  } else {
    style | WS_THICKFRAME | WS_MAXIMIZEBOX
  }
}

/// `width` device-independent pixels at `dpi`, as the library scaled them (`MulDiv`, rounded).
pub fn scale_to_dpi(value: u32, dpi: u32) -> i32 {
  let scaled = (u64::from(value) * u64::from(dpi) + 48) / 96;
  i32::try_from(scaled).unwrap_or(i32::MAX)
}

#[cfg(windows)]
pub use imp::apply_given_window_size;

#[cfg(windows)]
mod imp {
  use std::ffi::c_void;

  use windows::Win32::Foundation::{HWND, RECT};
  use windows::Win32::UI::HiDpi::{AdjustWindowRectExForDpi, GetDpiForWindow};
  use windows::Win32::UI::WindowsAndMessaging::{
    SetWindowLongPtrW, SetWindowPos, GWL_STYLE, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOZORDER, WINDOW_EX_STYLE,
    WINDOW_STYLE,
  };

  use super::{scale_to_dpi, style_for_size_hint, GivenWindowSizeHint};
  use crate::{handle_value, style, NativeWindow};

  /// Applies `webview_set_size(width, height, hint)` to a window the webview
  /// was given, as the C++ library did (see the module). False when the OS
  /// refused a step; a window that is gone refuses every step.
  pub fn apply_given_window_size(window: &impl NativeWindow, width: u32, height: u32, hint: GivenWindowSizeHint) -> bool {
    // The value of a window named by `NativeWindow`: checked when it was named.
    let hwnd = HWND(handle_value(window) as *mut c_void);
    let new_style = style_for_size_hint(style(window), hint);
    // SAFETY: writes one window long of a handle named by `NativeWindow`; on a
    // window that is gone the call fails with ERROR_INVALID_WINDOW_HANDLE and writes nothing.
    let _previous = unsafe { SetWindowLongPtrW(hwnd, GWL_STYLE, new_style as isize) };
    if matches!(hint, GivenWindowSizeHint::Min | GivenWindowSizeHint::Max) {
      return true;
    }
    // SAFETY: a window function on a handle named by `NativeWindow`; an invalid one returns 0.
    let dpi = match unsafe { GetDpiForWindow(hwnd) } {
      0 => 96,
      dpi => dpi,
    };
    let mut frame = RECT { left: 0, top: 0, right: scale_to_dpi(width, dpi), bottom: scale_to_dpi(height, dpi) };
    // As the library: the window's style, no menu, no extended style.
    // SAFETY: `frame` is a RECT owned by this frame for the call to adjust in place.
    let adjusted = unsafe { AdjustWindowRectExForDpi(&mut frame, WINDOW_STYLE(new_style), false, WINDOW_EX_STYLE(0), dpi) };
    if adjusted.is_err() {
      return false;
    }
    let flags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOMOVE | SWP_FRAMECHANGED;
    // SAFETY: a window function on a handle named by `NativeWindow`, with no insert-after window.
    unsafe { SetWindowPos(hwnd, None, 0, 0, frame.right - frame.left, frame.bottom - frame.top, flags) }.is_ok()
  }
}

/// Stand-in: there is no given window to size on this platform yet.
#[cfg(not(windows))]
pub fn apply_given_window_size(_window: &impl crate::NativeWindow, _width: u32, _height: u32, _hint: GivenWindowSizeHint) -> bool {
  false
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn fixed_takes_the_resize_frame_and_the_maximize_box_off_and_every_other_hint_puts_them_on() {
    const OVERLAPPED: u32 = 0x00CF_0000;
    const WITHOUT: u32 = OVERLAPPED & !(0x0004_0000 | 0x0001_0000);
    assert_eq!(style_for_size_hint(OVERLAPPED, GivenWindowSizeHint::Fixed), WITHOUT);
    for hint in [GivenWindowSizeHint::None, GivenWindowSizeHint::Min, GivenWindowSizeHint::Max] {
      assert_eq!(style_for_size_hint(WITHOUT, hint), OVERLAPPED);
    }
  }

  #[test]
  fn sizes_scale_with_the_dpi_and_round_as_muldiv_does() {
    assert_eq!(scale_to_dpi(500, 96), 500);
    assert_eq!(scale_to_dpi(500, 144), 750);
    assert_eq!(scale_to_dpi(333, 120), 416);
    assert_eq!(scale_to_dpi(u32::MAX, 960), i32::MAX);
  }
}

#[cfg(all(test, windows))]
mod live_tests {
  use std::sync::PoisonError;

  use windows::core::w;
  use windows::Win32::Foundation::{HWND, RECT};
  use windows::Win32::System::LibraryLoader::GetModuleHandleW;
  use windows::Win32::UI::HiDpi::GetDpiForWindow;
  use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, GetClientRect, IsWindowVisible, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW};

  use super::*;
  use crate::{style, ForeignWindow};

  /// A hidden top-level window of this thread, as an application would hand one over; destroyed on drop.
  struct GivenWindow(HWND);

  impl GivenWindow {
    fn new() -> Self {
      // SAFETY: a null module name asks for the handle of the process's own executable.
      let module = unsafe { GetModuleHandleW(None) }.expect("module handle");
      // SAFETY: the class is the system's STATIC class and every string is static.
      let hwnd = unsafe {
        CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), w!("sweetview size hint test"), WS_OVERLAPPEDWINDOW, 40, 40, 300, 200, None, None, Some(module.into()), None)
      }
      .expect("CreateWindowExW");
      Self(hwnd)
    }

    fn client(&self) -> (i32, i32) {
      let mut rect = RECT::default();
      // SAFETY: `rect` is a RECT owned by this frame for the call to fill, on this test's own window.
      unsafe { GetClientRect(self.0, &mut rect) }.expect("GetClientRect");
      (rect.right, rect.bottom)
    }

    fn dpi(&self) -> u32 {
      // SAFETY: a window function on this test's own window.
      unsafe { GetDpiForWindow(self.0) }.max(96)
    }

    fn visible(&self) -> bool {
      // SAFETY: a window function on this test's own window.
      unsafe { IsWindowVisible(self.0) }.as_bool()
    }
  }

  impl Drop for GivenWindow {
    fn drop(&mut self) {
      // SAFETY: the window was made by `new` on this thread and is destroyed only here.
      let _ = unsafe { DestroyWindow(self.0) };
    }
  }

  #[test]
  fn a_given_window_is_restyled_and_resized_as_the_library_did_and_never_shown() {
    let _serial = crate::TEST_SERIAL.lock().unwrap_or_else(PoisonError::into_inner);
    let window = GivenWindow::new();
    let given = ForeignWindow::from_handle_value(window.0 .0 as isize).expect("a live window");
    let resizable = 0x0004_0000 | 0x0001_0000;
    let dpi = window.dpi();

    assert!(apply_given_window_size(&given, 420, 260, GivenWindowSizeHint::None));
    assert_eq!(window.client(), (scale_to_dpi(420, dpi), scale_to_dpi(260, dpi)));
    assert_eq!(style(&given) & resizable, resizable);

    assert!(apply_given_window_size(&given, 400, 250, GivenWindowSizeHint::Fixed));
    assert_eq!(window.client(), (scale_to_dpi(400, dpi), scale_to_dpi(250, dpi)));
    assert_eq!(style(&given) & resizable, 0);

    // MIN and MAX: the style only.
    assert!(apply_given_window_size(&given, 100, 100, GivenWindowSizeHint::Min));
    assert!(apply_given_window_size(&given, 900, 900, GivenWindowSizeHint::Max));
    assert_eq!(window.client(), (scale_to_dpi(400, dpi), scale_to_dpi(250, dpi)));
    assert_eq!(style(&given) & resizable, resizable);

    assert!(!window.visible());
  }
}
