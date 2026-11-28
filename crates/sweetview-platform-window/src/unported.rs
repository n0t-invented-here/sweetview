//! Platforms whose goal has not built the window calls yet.
//!
//! The types and functions exist with the same signatures so shared code
//! compiles; each reports that the platform is not ported or answers with a
//! neutral value. The macOS goal replaces this file's use on macOS.

use std::marker::PhantomData;

use raw_window_handle::{DisplayHandle, HandleError, HasDisplayHandle, HasWindowHandle, WindowHandle};

use crate::{Chrome, ExStylePolicy, FramePart, HandleCounts, Placement, Rect, ShowAs, WindowEvent};

const NOT_PORTED: &str = "sweetview: window calls are not ported to this platform yet";

mod sealed {
  pub trait Sealed {}
}

/// See the Windows implementation for the contract.
pub trait NativeWindow: sealed::Sealed {}

impl sealed::Sealed for tao::window::Window {}
impl NativeWindow for tao::window::Window {}

/// See the Windows implementation for the contract.
#[derive(Debug)]
pub struct BorrowedWindow<'a> {
  _window: PhantomData<&'a ()>,
  _not_send: PhantomData<*const ()>,
}

impl sealed::Sealed for BorrowedWindow<'_> {}
impl NativeWindow for BorrowedWindow<'_> {}

impl BorrowedWindow<'_> {
  pub fn with_handle_value<R>(_value: isize, _f: impl FnOnce(&BorrowedWindow<'_>) -> R) -> Option<R> {
    None
  }
}

impl<'a> BorrowedWindow<'a> {
  pub fn of(_window: &'a tao::window::Window) -> Self {
    Self { _window: PhantomData, _not_send: PhantomData }
  }
}

impl HasWindowHandle for BorrowedWindow<'_> {
  fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
    Err(HandleError::NotSupported)
  }
}

impl HasDisplayHandle for BorrowedWindow<'_> {
  fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
    Err(HandleError::NotSupported)
  }
}

pub fn handle_value(_window: &impl NativeWindow) -> isize {
  0
}
pub fn is_window(_window: &impl NativeWindow) -> bool {
  false
}
pub fn is_on_this_thread(_window: &impl NativeWindow) -> bool {
  false
}
pub fn is_visible(_window: &impl NativeWindow) -> bool {
  false
}
pub fn is_active(_window: &impl NativeWindow) -> bool {
  false
}
pub fn is_minimized(_window: &impl NativeWindow) -> bool {
  false
}
pub fn restores_maximized(_window: &impl NativeWindow) -> bool {
  false
}
pub fn is_zoomed(_window: &impl NativeWindow) -> bool {
  false
}
pub fn outer_bounds(_window: &impl NativeWindow) -> Option<Rect> {
  None
}
pub fn dpi_scale(_window: &impl NativeWindow) -> f64 {
  1.0
}
pub fn ex_style(_window: &impl NativeWindow) -> u32 {
  0
}
pub fn style(_window: &impl NativeWindow) -> u32 {
  0
}
pub fn chrome(_window: &impl NativeWindow) -> Chrome {
  Chrome { frame: true, resizable: true }
}
pub fn set_placement(_window: &impl NativeWindow, _placement: Placement) -> bool {
  false
}
pub fn bring_to_front(_window: &impl NativeWindow) {}
pub fn show(_window: &impl NativeWindow, _no_activate: bool, _topmost: bool) {}
/// A window kept off the screen while it is shown. Not served on this platform: never made.
pub struct Cloak;
impl Cloak {
  pub fn new(_window: &impl NativeWindow) -> Option<Self> {
    None
  }
}
pub fn show_as(_window: &impl NativeWindow, _state: ShowAs) {}
pub fn set_title(_window: &impl NativeWindow, _title: &str) -> bool {
  false
}
pub fn press_frame(_window: &impl NativeWindow, _part: FramePart) {}
pub fn fill_first_child(_window: &impl NativeWindow) {}
pub fn apply_ex_style(_window: &impl NativeWindow, _policy: &ExStylePolicy) {}
pub fn set_layered_attributes(_window: &impl NativeWindow, _color_key: Option<u32>, _opacity: Option<f64>) -> Result<(), String> {
  Err(NOT_PORTED.into())
}
pub fn destroy_now(window: tao::window::Window) {
  drop(window);
}
pub fn mouse_buttons_down() -> bool {
  false
}
pub fn left_button_down() -> bool {
  false
}
pub fn work_area(_monitor: &tao::monitor::MonitorHandle) -> Option<Rect> {
  None
}
pub fn handle_counts() -> HandleCounts {
  HandleCounts { user_objects: 0, gdi_objects: 0, kernel_handles: 0 }
}

/// See the Windows implementation for the contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct GeometrySnapshot;

impl GeometrySnapshot {
  pub fn take(_window: &impl NativeWindow) -> Self {
    Self
  }
  pub fn restore(&self, _window: &impl NativeWindow) {}
}

/// See the Windows implementation for the contract.
#[derive(Debug)]
pub struct WindowIcons;

impl WindowIcons {
  pub fn set(_window: &impl NativeWindow, _ico: Option<&[u8]>) -> Result<Self, String> {
    Err(NOT_PORTED.into())
  }
}

/// See the Windows implementation for the contract.
pub struct WindowSubclass {
  _not_send: PhantomData<*const ()>,
}

impl WindowSubclass {
  pub fn install(_window: &impl NativeWindow, _handler: impl Fn(&WindowEvent) -> bool + 'static) -> Result<Self, String> {
    Err(NOT_PORTED.into())
  }
  pub fn policy(&self) -> ExStylePolicy {
    ExStylePolicy::default()
  }
  pub fn set_policy(&self, _policy: ExStylePolicy) {}
  pub fn set_hold_visibility(&self, _on: bool) {}
  pub fn set_fill_child(&self, _on: bool) {}
  pub fn force_style(&self, _bits: u32) {}
}
