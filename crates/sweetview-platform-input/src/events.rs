//! What the hooks hand their handlers, and how an install fails.

use std::fmt;

use sweetview_keycodes::{KeyEventKind, MouseEventKind};

/// One mouse event, as the C API's `webview_mouse_hook_fn_t` reports it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MouseEvent {
  pub kind: MouseEventKind,
  /// The cursor on the screen in the platform's screen units (physical pixels
  /// on Windows, points on macOS, where they can be fractional), origin at the
  /// top-left corner of the primary display.
  pub x: f64,
  /// See [`MouseEvent::x`].
  pub y: f64,
  /// For [`MouseEventKind::Wheel`] the notches turned, positive away from the
  /// user (a fine wheel or trackpad gives fractions); 0 otherwise.
  pub wheel: f64,
  /// The modifier keys held when the event was generated, as
  /// [`modifier`](crate::modifier) bits: on Windows the asynchronous key
  /// state inside the hook.
  pub modifiers: u32,
}

/// One key event, as the C API's `webview_keyboard_hook_fn_t` reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyEvent {
  pub kind: KeyEventKind,
  /// The physical key as the DOM's `KeyboardEvent.code` names it (`"KeyA"`,
  /// `"Delete"`, `"ArrowLeft"`, `"ShiftLeft"`...); `"Unidentified"`
  /// ([`UNIDENTIFIED`](crate::UNIDENTIFIED)) for a key without a name.
  pub code: &'static str,
  /// The platform's own code for the key: the virtual-key code on Windows,
  /// the virtual keycode on macOS.
  pub raw: u32,
  /// The modifier keys held after this event, as [`modifier`](crate::modifier)
  /// bits, so a modifier's own down has its bit set and its up has it clear.
  pub modifiers: u32,
}

/// Why a hook could not be installed or removed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HookError {
  /// A hook of this kind is already installed in this process.
  AlreadyInstalled,
  /// macOS: the event tap could not be created, which is the permission
  /// [`permissions::needed`](crate::permissions::needed) names missing.
  PermissionDenied,
  /// The OS refused (on Windows `SetWindowsHookExW` or `UnhookWindowsHookEx`
  /// failed), or the platform has no hooks. The text says which.
  Os(String),
}

impl HookError {
  /// The `webview_error_t` the C API's `webview_*_hook_install` returns in
  /// this case: `WEBVIEW_ERROR_DUPLICATE` (1),
  /// `WEBVIEW_ERROR_MISSING_DEPENDENCY` (-5) or `WEBVIEW_ERROR_UNSPECIFIED`
  /// (-1).
  pub fn code(&self) -> i32 {
    match self {
      HookError::AlreadyInstalled => 1,
      HookError::PermissionDenied => -5,
      HookError::Os(_) => -1,
    }
  }
}

impl fmt::Display for HookError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      HookError::AlreadyInstalled => f.write_str("a hook of this kind is already installed"),
      HookError::PermissionDenied => f.write_str(
        "the process needs the Device Control and Data Access permission (System Settings > Privacy & Security)",
      ),
      HookError::Os(why) => f.write_str(why),
    }
  }
}

impl std::error::Error for HookError {}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn each_error_has_the_c_api_code() {
    assert_eq!(HookError::AlreadyInstalled.code(), 1);
    assert_eq!(HookError::PermissionDenied.code(), -5);
    assert_eq!(HookError::Os("SetWindowsHookEx(WH_MOUSE_LL) failed".into()).code(), -1);
  }
}
