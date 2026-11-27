//! The application-wide settings that are per window, or absent, on Windows.
//!
//! macOS has one menu bar, one Dock tile and one activation policy per
//! application; Windows has none of the three. On Windows each of these does
//! nothing, which is the documented behaviour: the tray menu is the app's menu,
//! the taskbar and Alt+Tab icons are per window (`Window.setIcon`) or from the
//! executable's resources, and taskbar presence is per window
//! (`WindowOptions.hideFromTaskbar`). macOS keeps its own implementation in
//! the native package until the macOS goal ports it.

use crate::error::Result;
use crate::icon::IconBytes;

/// macOS `NSApplicationActivationPolicy`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationPolicy {
  Regular,
  Accessory,
  Prohibited,
}

/// The application menu with About and Quit, and an Edit menu. Windows: nothing.
pub fn install_app_menu(_app_name: &str, _about_text: &str) -> Result<()> {
  Ok(())
}

/// The running application's icon (the Dock tile on macOS). Windows: nothing.
pub fn set_app_icon(_icon: &IconBytes) -> Result<()> {
  Ok(())
}

/// The process's activation policy. Windows: nothing.
pub fn set_activation_policy(_policy: ActivationPolicy) -> Result<()> {
  Ok(())
}
