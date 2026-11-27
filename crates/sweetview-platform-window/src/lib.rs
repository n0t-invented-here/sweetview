//! The window-level OS calls `tao` has no API for, and the events of any window by subclass.
//!
//! * [`WindowSubclass`] delivers resize, move, close, file drop and destroy
//!   events of any window on this thread, one Sweetview made through `tao` or
//!   one an application made itself, from inside whichever message loop
//!   dispatches them. It also holds the window's [`ExStylePolicy`].
//! * [`ForeignWindow`] names a window this process did not make through
//!   Sweetview, checked when it is made.
//! * The free functions are one OS call each (or one short sequence), on a
//!   [`NativeWindow`]: a `tao` window or a [`ForeignWindow`].
//!
//! The public API has no raw handle in it: windows are named by the types
//! that own or check them, and handle values are plain integers.
#![deny(unsafe_op_in_unsafe_fn)]
#![deny(clippy::undocumented_unsafe_blocks)]
#![deny(clippy::multiple_unsafe_ops_per_block)]
#![deny(clippy::missing_safety_doc)]

pub use sweetview_window_logic::{ExStylePolicy, Point, Rect};

#[cfg(windows)]
#[path = "windows.rs"]
mod platform;
#[cfg(not(windows))]
#[path = "unported.rs"]
mod platform;

pub use platform::*;

#[cfg(windows)]
#[path = "tab_frame.rs"]
mod tab_frame;
#[cfg(not(windows))]
#[path = "tab_frame_unported.rs"]
mod tab_frame;

pub use tab_frame::*;

/// The chrome of a window as its styles say: what `Window.fromHandle` reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Chrome {
  /// Not a popup: the window has a frame.
  pub frame: bool,
  /// The frame can be dragged to resize.
  pub resizable: bool,
}

/// One delivery from a [`WindowSubclass`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowEvent {
  /// The window's outer bounds after a size change; not sent while it is minimised.
  Resized(Rect),
  /// The window's outer bounds after a move; not sent while it is minimised.
  Moved(Rect),
  /// The user asked to close the window (close button, Alt+F4, `WM_CLOSE`).
  CloseRequested,
  /// Files were dropped on the window: every path of one drop, in order.
  FilesDropped(Vec<String>),
  /// The window became the active window (`true`) or stopped being it (`false`).
  Activated(bool),
  /// The window is being destroyed. The last delivery; the subclass is gone after it.
  Destroyed,
}

/// The process's own state, for tests that check every handle is given back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HandleCounts {
  /// `GetGuiResources(GR_USEROBJECTS)`: windows, icons, menus, hooks.
  pub user_objects: u32,
  /// `GetGuiResources(GR_GDIOBJECTS)`.
  pub gdi_objects: u32,
  /// `GetProcessHandleCount`: kernel handles.
  pub kernel_handles: u32,
}

/// Tests that count the process's handles run one at a time.
#[cfg(test)]
pub(crate) static TEST_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
