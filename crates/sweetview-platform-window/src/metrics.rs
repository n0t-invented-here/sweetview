//! System metrics the tray and menus size and time themselves by.
//!
//! Neither `tao`, `muda` nor `tray-icon` reads them: `tray-icon` reports a
//! double click as the shell delivers it but leaves telling a single click from
//! the first half of a double click to the application, and both crates take
//! an icon at whatever size it is given.

#[cfg(windows)]
mod imp {
  use windows::UI::ViewManagement::UISettings;
  use windows::Win32::UI::WindowsAndMessaging::SM_CXSMICON;

  use crate::platform::metric;

  /// The user's double-click time through WinRT's `UISettings`, a safe call
  /// of the `windows` crate that reads the same setting as `GetDoubleClickTime`
  /// (the test below compares the two).
  pub fn double_click_time_ms() -> u32 {
    // The factory the `windows` crate caches for `UISettings` must not outlive its DLL (D48).
    sweetview_platform_loop::hold_com_for_the_process();
    let ms = UISettings::new().and_then(|settings| settings.DoubleClickTime()).unwrap_or(0);
    if ms == 0 {
      500
    } else {
      ms
    }
  }

  pub fn small_icon_size() -> u32 {
    u32::try_from(metric(SM_CXSMICON, 16)).ok().filter(|size| *size > 0).unwrap_or(16)
  }
}

#[cfg(not(windows))]
mod imp {
  pub fn double_click_time_ms() -> u32 {
    500
  }

  pub fn small_icon_size() -> u32 {
    16
  }
}

/// The user's double-click interval in milliseconds (Windows: `UISettings::DoubleClickTime`,
/// the setting `GetDoubleClickTime` reads). A second click inside it makes a double click.
pub fn double_click_time_ms() -> u32 {
  imp::double_click_time_ms()
}

/// The size, in pixels, of a small icon at the system DPI (Windows: `SM_CXSMICON`):
/// what the notification area and menu items draw. 16 when the OS gives none.
pub fn small_icon_size() -> u32 {
  imp::small_icon_size()
}

#[cfg(test)]
mod tests {
  #[test]
  fn metrics_are_sane() {
    assert!((100..=5000).contains(&super::double_click_time_ms()));
    assert!((16..=256).contains(&super::small_icon_size()));
  }

  /// The safe WinRT reading is the one the Win32 call gives.
  #[cfg(windows)]
  #[test]
  fn the_double_click_time_is_the_one_win32_reports() {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetDoubleClickTime;
    // SAFETY: GetDoubleClickTime takes no arguments and only reads a user setting.
    let win32 = unsafe { GetDoubleClickTime() };
    // Read without the fallback, so a failed WinRT call cannot pass as the default.
    let winrt = windows::UI::ViewManagement::UISettings::new().and_then(|settings| settings.DoubleClickTime()).expect("UISettings");
    eprintln!("double-click time: GetDoubleClickTime {win32} ms, UISettings::DoubleClickTime {winrt} ms");
    assert_eq!(winrt, win32);
    assert_eq!(super::double_click_time_ms(), win32);
  }
}
