//! The window-level OS calls `tao` has no API for, and the events of any window by subclass.
//!
//! * [`WindowSubclass`] delivers resize, move, close, file drop and destroy
//!   events of any window on this thread, one Sweetview made through `tao` or
//!   one an application made itself, from inside whichever message loop
//!   dispatches them. It also holds the window's [`ExStylePolicy`].
//! * [`BorrowedWindow`] lends a window named by its handle value for the
//!   length of one call ([`BorrowedWindow::with_handle_value`]), checked to be
//!   a window when it is lent: an application's own window (adopted, or a
//!   webview mounted in it), or the window a popup menu or a dialog is shown
//!   for. Nothing outside an owning type keeps a window handle: a window
//!   Sweetview did not make is kept as its handle value and lent again for
//!   each call.
//! * The free functions are one OS call each (or one short sequence), on a
//!   [`NativeWindow`]: a `tao` window or a [`BorrowedWindow`].
//!
//! The public API has no raw handle in it: windows are named by the types
//! that own or borrow them, and handle values are plain integers.
#![deny(unsafe_op_in_unsafe_fn)]
#![deny(clippy::undocumented_unsafe_blocks)]
#![deny(clippy::multiple_unsafe_ops_per_block)]
#![deny(clippy::missing_safety_doc)]

pub use sweetview_window_logic::{ExStylePolicy, Point, Rect, ResizeEdge};

/// Where [`set_placement`] puts a window in the z-order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ZOrder {
  /// Its place in the z-order is kept.
  #[default]
  Keep,
  /// Into (or re-asserted in) the topmost band.
  Topmost,
  /// Out of the topmost band.
  NotTopmost,
}

/// One change of a window's outer frame and z-order, made in one step
/// ([`set_placement`]) and never activating the window. The default changes nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Placement {
  /// The outer frame's new top-left corner, in screen pixels; `None` keeps it.
  pub position: Option<Point>,
  /// The outer frame's new width and height; `None` keeps them.
  pub size: Option<(i32, i32)>,
  pub z: ZOrder,
  /// The frame is measured again after a style change.
  pub frame_changed: bool,
}

impl Placement {
  /// The whole outer frame. A topmost window is re-asserted topmost; any
  /// other keeps its place in the z-order.
  pub fn bounds(rect: Rect, topmost: bool) -> Self {
    Self {
      position: Some(Point { x: rect.x, y: rect.y }),
      size: Some((rect.width, rect.height)),
      z: if topmost { ZOrder::Topmost } else { ZOrder::Keep },
      frame_changed: false,
    }
  }
}

/// A show state [`show_as`] puts a window in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShowAs {
  Hidden,
  Minimized,
  Maximized,
  /// Back from minimised or maximised.
  Restored,
}

/// The part of a window's frame a press is handed to the OS as ([`press_frame`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FramePart {
  /// The title bar: the OS move loop.
  Caption,
  /// An edge or corner: the OS size loop.
  Edge(ResizeEdge),
}

#[cfg(windows)]
#[path = "windows.rs"]
mod platform;
#[cfg(not(windows))]
#[path = "unported.rs"]
mod platform;

pub use platform::*;

mod size_hint;
pub use size_hint::*;

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
  /// The window's outer bounds after a move, and whether it is minimised
  /// (its bounds are then the OS's iconic position): a tab frame tells its
  /// move listeners then too, any other window does not.
  Moved { bounds: Rect, minimized: bool },
  /// The user asked to close the window (close button, Alt+F4, `WM_CLOSE`).
  CloseRequested,
  /// Files were dropped on the window: every path of one drop, in order.
  FilesDropped(Vec<String>),
  /// The window became the active window (`true`) or stopped being it (`false`).
  Activated(bool),
  /// The window is being destroyed. The last delivery; the subclass is gone after it.
  Destroyed,
}

/// The process's own state, for tests that check every handle is given back:
/// `sweetview-platform-loop`'s counts, read in one place for every platform crate.
pub use sweetview_platform_loop::ResourceCounts as HandleCounts;

/// Tests that count the process's handles run one at a time.
#[cfg(test)]
pub(crate) static TEST_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
#[cfg(windows)]
mod folder_dialog;
mod metrics;
mod popup;

/// Reads back what the OS shows, for the tests of this crate and of the
/// runtime (which enables the `test-support` feature as a dev-dependency only).
#[cfg(all(windows, any(test, feature = "test-support")))]
#[path = "test_support.rs"]
pub mod test_support;

#[cfg(windows)]
pub use folder_dialog::{pick_folder, FolderDialogError};
pub use metrics::{double_click_time_ms, small_icon_size};
pub use popup::{check_item, end_menu_for_tests, escape_menus_of_this_process_for_tests, menu_handle_value, set_command_id, show_popup, PopupAt, PopupCorner};
