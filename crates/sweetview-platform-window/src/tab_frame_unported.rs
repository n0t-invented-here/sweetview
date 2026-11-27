//! Platforms whose goal has not built the tab frame yet: the same signatures,
//! each a neutral answer. See `tab_frame.rs` for the contract.

use sweetview_window_logic::ResizeEdge;

use crate::{NativeWindow, Point, Rect};

pub const FRAME_STYLE: u32 = 0;

pub fn client_rect(_window: &impl NativeWindow) -> Option<Rect> {
  None
}
pub fn client_origin(_window: &impl NativeWindow) -> Option<Point> {
  None
}
pub fn is_foreground(_window: &impl NativeWindow) -> bool {
  false
}
pub fn move_with_mouse(_window: &impl NativeWindow) {}
pub fn size_with_mouse(_window: &impl NativeWindow, _edge: ResizeEdge) {}
pub fn show_system_menu(_window: &impl NativeWindow, _at: Point) {}

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
