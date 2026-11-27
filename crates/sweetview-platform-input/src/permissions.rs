//! The permission model behind the input hooks: which system permission a
//! feature needs on this platform, whether the process holds it, how to ask
//! for it, and whether a failing install asks by itself.
//!
//! Only macOS has anything to ask: both hooks share one `CGEventTap` that
//! filters events, which takes Device Control and Data Access. Windows and
//! Linux need nothing, and report every permission as not applicable.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

/// A system permission a feature may need, as bits: the C API's
/// `webview_permission_t` and the bindings' `Permission`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum Permission {
  /// macOS "Device Control and Data Access": filter and post input events.
  /// What both hooks need there.
  DeviceControl = 1 << 0,
  /// macOS "Input Monitoring": watch input without filtering it. No feature
  /// needs it; it is modelled so an application can ask about it the same way.
  InputMonitoring = 1 << 1,
}

impl Permission {
  /// Every permission, in the order of its bit.
  pub const ALL: [Permission; 2] = [Permission::DeviceControl, Permission::InputMonitoring];

  /// The permission's bit.
  pub fn bit(self) -> u32 {
    self as u32
  }

  /// The permission a number stands for; `None` for a number that is not
  /// exactly one permission's bit, which the C API answers with
  /// [`ERROR_INVALID_ARGUMENT`].
  pub fn from_bits(bits: u32) -> Option<Self> {
    Self::ALL.into_iter().find(|p| p.bit() == bits)
  }
}

/// A feature that may need a permission: the C API's `webview_feature_t` and
/// the bindings' `Feature`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(i32)]
pub enum Feature {
  /// [`MouseHook`](crate::MouseHook).
  MouseHook = 0,
  /// [`KeyboardHook`](crate::KeyboardHook).
  KeyboardHook = 1,
}

impl Feature {
  /// The feature's number.
  pub fn code(self) -> i32 {
    self as i32
  }

  /// The feature a number stands for; `None` for a number that is no feature,
  /// which needs nothing (the C API answers 0).
  pub fn from_code(code: i32) -> Option<Self> {
    [Feature::MouseHook, Feature::KeyboardHook].into_iter().find(|f| f.code() == code)
  }
}

/// Whether the process holds a permission: the bindings' `PermissionStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Status {
  /// `"granted"`.
  Granted,
  /// `"missing"`: the user can grant it.
  Missing,
  /// `"not-applicable"`: this platform has no such permission.
  NotApplicable,
}

impl Status {
  /// The `webview_error_t` the C API's `webview_permission_status` and
  /// `webview_permission_request` return: `WEBVIEW_ERROR_OK` (0),
  /// `WEBVIEW_ERROR_MISSING_DEPENDENCY` (-5) or `WEBVIEW_ERROR_UNSPECIFIED` (-1).
  pub fn code(self) -> i32 {
    match self {
      Status::Granted => 0,
      Status::Missing => -5,
      Status::NotApplicable => -1,
    }
  }

  /// The bindings' string for it.
  pub fn as_str(self) -> &'static str {
    match self {
      Status::Granted => "granted",
      Status::Missing => "missing",
      Status::NotApplicable => "not-applicable",
    }
  }
}

/// `WEBVIEW_ERROR_INVALID_ARGUMENT`: what the C API's permission calls return
/// for a number that is not a [`Permission`] ([`Permission::from_bits`] gives
/// `None`).
pub const ERROR_INVALID_ARGUMENT: i32 = -2;

/// On by default, so an application that never asks about permissions still
/// gets the system's prompt the first time it installs a hook.
/// A `OnceLock` holding the flag (a form of global state `UNSAFE-POLICY.md`
/// lists): any thread may set it and any thread may install a hook.
fn auto_request_flag() -> &'static AtomicBool {
  static FLAG: OnceLock<AtomicBool> = OnceLock::new();
  FLAG.get_or_init(|| AtomicBool::new(true))
}

/// The permissions a feature needs on this platform, as [`Permission`] bits;
/// 0 when it needs none. On macOS both hooks need
/// [`Permission::DeviceControl`]; on Windows and Linux nothing needs anything.
pub fn needed(feature: Feature) -> u32 {
  match feature {
    Feature::MouseHook | Feature::KeyboardHook => platform_needed(),
  }
}

/// Whether the process holds a permission right now. Shows nothing to the
/// user.
pub fn status(permission: Permission) -> Status {
  platform_status(permission)
}

/// Asks the system for a permission. On macOS it adds the application to the
/// row in System Settings > Privacy & Security, and macOS decides whether to
/// show a prompt; the user grants it there. Same answers as [`status`];
/// [`Status::Missing`] means it is still missing after asking. Where the
/// permission does not exist nothing is shown.
pub fn request(permission: Permission) -> Status {
  platform_request(permission)
}

/// True when every permission the feature needs is granted (so, always, where
/// it needs none): the bindings' `permissions.ready`.
pub fn ready(feature: Feature) -> bool {
  let bits = needed(feature);
  Permission::ALL.into_iter().filter(|p| bits & p.bit() != 0).all(|p| status(p) == Status::Granted)
}

/// Whether an install that fails for a missing permission asks the system for
/// it by itself, once per process, as [`request`] would.
pub fn set_auto_request(on: bool) {
  auto_request_flag().store(on, Ordering::Relaxed);
}

/// The setting [`set_auto_request`] changes; `true` until it is changed.
pub fn auto_request() -> bool {
  auto_request_flag().load(Ordering::Relaxed)
}

// Windows and Linux: no such permissions.
#[cfg(not(target_os = "macos"))]
fn platform_needed() -> u32 {
  0
}

#[cfg(not(target_os = "macos"))]
fn platform_status(_permission: Permission) -> Status {
  Status::NotApplicable
}

#[cfg(not(target_os = "macos"))]
fn platform_request(permission: Permission) -> Status {
  platform_status(permission)
}

// macOS, until its goal builds the event tap: both hooks need Device Control
// and Data Access, which reads as not yet granted.
#[cfg(target_os = "macos")]
fn platform_needed() -> u32 {
  Permission::DeviceControl.bit()
}

#[cfg(target_os = "macos")]
fn platform_status(_permission: Permission) -> Status {
  Status::Missing
}

#[cfg(target_os = "macos")]
fn platform_request(permission: Permission) -> Status {
  platform_status(permission)
}

#[cfg(test)]
mod tests {
  use super::*;

  /// C++ fork, `unit_tests.cc`: "Input hooks: the permission model". The
  /// numbers that are no feature or permission are the binding's to map
  /// (`Feature::from_code`, `Permission::from_bits`).
  #[test]
  fn input_hooks_the_permission_model() {
    assert_eq!(needed(Feature::MouseHook), needed(Feature::KeyboardHook));
    assert_eq!(Feature::from_code(12345), None);
    assert_eq!(Permission::from_bits(0), None);
    assert_eq!(Permission::from_bits(3), None, "two permissions at once are not one permission");
    #[cfg(not(target_os = "macos"))]
    {
      assert_eq!(needed(Feature::MouseHook), 0);
      assert_eq!(status(Permission::DeviceControl), Status::NotApplicable);
      assert_eq!(status(Permission::InputMonitoring), Status::NotApplicable);
      assert_eq!(request(Permission::DeviceControl), Status::NotApplicable);
      assert_eq!(status(Permission::DeviceControl).code(), -1);
    }
    #[cfg(target_os = "macos")]
    {
      assert_eq!(needed(Feature::MouseHook), Permission::DeviceControl.bit());
      let status = status(Permission::DeviceControl);
      assert!(matches!(status, Status::Granted | Status::Missing));
      assert_eq!(request(Permission::DeviceControl), status);
    }
    set_auto_request(false);
    assert!(!auto_request());
    set_auto_request(true);
    assert!(auto_request());
  }

  #[test]
  fn the_numbers_are_the_c_apis() {
    assert_eq!(Permission::DeviceControl.bit(), 1);
    assert_eq!(Permission::InputMonitoring.bit(), 2);
    assert_eq!(Permission::from_bits(2), Some(Permission::InputMonitoring));
    assert_eq!(Feature::MouseHook.code(), 0);
    assert_eq!(Feature::KeyboardHook.code(), 1);
    assert_eq!(Feature::from_code(1), Some(Feature::KeyboardHook));
    assert_eq!((Status::Granted.code(), Status::Missing.code(), Status::NotApplicable.code()), (0, -5, -1));
    assert_eq!(
      (Status::Granted.as_str(), Status::Missing.as_str(), Status::NotApplicable.as_str()),
      ("granted", "missing", "not-applicable")
    );
    assert_eq!(ERROR_INVALID_ARGUMENT, -2);
  }

  #[test]
  fn ready_is_every_needed_permission_granted() {
    #[cfg(not(target_os = "macos"))]
    assert!(ready(Feature::MouseHook) && ready(Feature::KeyboardHook), "nothing is needed here");
    #[cfg(target_os = "macos")]
    assert_eq!(ready(Feature::MouseHook), status(Permission::DeviceControl) == Status::Granted);
  }
}
