//! The extended-style bits Sweetview keeps on a window whoever changes its style.
//!
//! `tao` rewrites a window's whole extended style from its own flags whenever
//! one of them changes. Bits `tao` has no flag for would be lost each time, so
//! the window's subclass applies this policy to every style change on its way
//! in. The values are the `WS_EX_*` constants of the Windows SDK.

pub const WS_EX_ACCEPTFILES: u32 = 0x0000_0010;
pub const WS_EX_TRANSPARENT: u32 = 0x0000_0020;
pub const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
pub const WS_EX_APPWINDOW: u32 = 0x0004_0000;
pub const WS_EX_LAYERED: u32 = 0x0008_0000;
pub const WS_EX_NOACTIVATE: u32 = 0x0800_0000;

/// What one window wants of its extended style.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ExStylePolicy {
  /// `hideFromTaskbar`: `WS_EX_TOOLWINDOW` on and `WS_EX_APPWINDOW` off, so no
  /// taskbar button and no Alt+Tab entry.
  pub tool_window: bool,
  /// `colorKey` or `opacity`: the window is layered for its own sake.
  pub layered: bool,
  /// `None` until click-through is first set; then whether the window lets
  /// clicks through.
  pub click_through: Option<bool>,
  /// `None` leaves `WS_EX_ACCEPTFILES` alone; `Some` forces it on or off.
  pub accept_files: Option<bool>,
}

impl ExStylePolicy {
  /// The click-through bits: `WS_EX_TRANSPARENT`, plus `WS_EX_LAYERED` when
  /// the window is not layered for another reason (a transparent window
  /// receives no mouse input only when it is also layered).
  pub fn click_through_bits(&self) -> u32 {
    WS_EX_TRANSPARENT | if self.layered { 0 } else { WS_EX_LAYERED }
  }

  /// `style` with every bit this policy decides set the way it decides.
  pub fn apply(&self, style: u32) -> u32 {
    let mut on = 0u32;
    let mut off = 0u32;
    if self.tool_window {
      on |= WS_EX_TOOLWINDOW;
      off |= WS_EX_APPWINDOW;
    }
    match self.click_through {
      Some(true) => on |= self.click_through_bits(),
      Some(false) => off |= self.click_through_bits(),
      None => {}
    }
    if self.layered {
      on |= WS_EX_LAYERED;
      off &= !WS_EX_LAYERED;
    }
    match self.accept_files {
      Some(true) => on |= WS_EX_ACCEPTFILES,
      Some(false) => off |= WS_EX_ACCEPTFILES,
      None => {}
    }
    (style & !off) | on
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// What `tao` writes for a plain visible window: it always asks for files and a taskbar button.
  const TAO_DEFAULT: u32 = WS_EX_ACCEPTFILES | WS_EX_APPWINDOW | 0x100;

  #[test]
  fn an_empty_policy_changes_nothing() {
    assert_eq!(ExStylePolicy::default().apply(TAO_DEFAULT), TAO_DEFAULT);
  }

  #[test]
  fn hide_from_taskbar_forces_the_tool_window_bits() {
    let policy = ExStylePolicy { tool_window: true, ..Default::default() };
    let out = policy.apply(TAO_DEFAULT);
    assert_eq!(out & WS_EX_TOOLWINDOW, WS_EX_TOOLWINDOW);
    assert_eq!(out & WS_EX_APPWINDOW, 0);
  }

  #[test]
  fn click_through_adds_layered_only_when_not_layered_for_another_reason() {
    let plain = ExStylePolicy { click_through: Some(true), ..Default::default() };
    assert_eq!(plain.apply(0), WS_EX_TRANSPARENT | WS_EX_LAYERED);
    let off = ExStylePolicy { click_through: Some(false), ..Default::default() };
    assert_eq!(off.apply(WS_EX_TRANSPARENT | WS_EX_LAYERED | 0x100), 0x100);

    let keyed = ExStylePolicy { layered: true, click_through: Some(true), ..Default::default() };
    assert_eq!(keyed.apply(0), WS_EX_TRANSPARENT | WS_EX_LAYERED);
    let keyed_off = ExStylePolicy { layered: true, click_through: Some(false), ..Default::default() };
    // Click-through off never strips the layering a colour key needs.
    assert_eq!(keyed_off.apply(WS_EX_TRANSPARENT | WS_EX_LAYERED), WS_EX_LAYERED);
  }

  #[test]
  fn accept_files_follows_the_drop_listeners() {
    let none = ExStylePolicy { accept_files: Some(false), ..Default::default() };
    assert_eq!(none.apply(TAO_DEFAULT) & WS_EX_ACCEPTFILES, 0);
    let some = ExStylePolicy { accept_files: Some(true), ..Default::default() };
    assert_eq!(some.apply(0), WS_EX_ACCEPTFILES);
  }

  #[test]
  fn applying_twice_is_applying_once() {
    let policy = ExStylePolicy { tool_window: true, layered: true, click_through: Some(true), accept_files: Some(false) };
    let once = policy.apply(TAO_DEFAULT | WS_EX_NOACTIVATE);
    assert_eq!(policy.apply(once), once);
    assert_eq!(once & WS_EX_NOACTIVATE, WS_EX_NOACTIVATE, "bits the policy does not decide pass through");
  }
}
