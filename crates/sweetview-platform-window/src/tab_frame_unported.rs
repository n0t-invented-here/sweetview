//! Platforms whose goal has not built the tab frame yet: the same signatures,
//! each a neutral answer. See `tab_frame.rs` for the contract.

use crate::{NativeWindow, Point};

pub const FRAME_STYLE: u32 = 0;

pub fn is_foreground(_window: &impl NativeWindow) -> bool {
  false
}
pub fn show_system_menu(_window: &impl NativeWindow, _at: Point) {}

pub use sweetview_window_logic::system_menu::{SystemCommand, SystemMenuState};

pub fn track_system_menu(_window: &impl NativeWindow, _at: Point, _state: SystemMenuState) -> Option<SystemCommand> {
  None
}

pub fn post_system_command(_window: &impl NativeWindow, _command: SystemCommand) {}
pub fn request_close(_window: &impl NativeWindow) {}

/// See the Windows implementation for the contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PopupEntry {
  Item { label: String, enabled: bool },
  Separator,
}

pub fn popup_menu(_window: &impl NativeWindow, _entries: &[PopupEntry], _at: Point) -> Result<Option<usize>, String> {
  Err("sweetview: popup menus are not ported to this platform yet".into())
}
pub fn system_is_dark() -> bool {
  false
}

/// See the Windows implementation for the contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backdrop {
  pub strip_height: u32,
  pub strip: (u8, u8, u8),
  pub page: (u8, u8, u8),
}

/// See the Windows implementation for the contract.
pub struct FrameMessages {
  _not_send: std::marker::PhantomData<*const ()>,
}

impl FrameMessages {
  pub fn install(_window: &impl NativeWindow, _backdrop: Backdrop) -> Result<Self, String> {
    Err("sweetview: tab frames are not ported to this platform yet".into())
  }
  pub fn set_backdrop(&self, _backdrop: Backdrop) -> Result<(), String> {
    Ok(())
  }
}
