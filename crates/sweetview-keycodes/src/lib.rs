//! The tables that turn an OS key or mouse message into the values
//! applications see.
//!
//! * [`dom_code_from_windows_scan`] and [`dom_code_from_mac_keycode`]: a
//!   physical key to its DOM `KeyboardEvent.code` name.
//! * [`MouseEventKind`], [`KeyEventKind`] and [`modifier`]: the numbers the C
//!   API (`webview_mouse_event_t`, `webview_key_event_t`,
//!   `webview_modifier_t`) and the bindings' `MouseEvent`, `KeyEvent` and
//!   `Modifier` enums use.
//! * [`win`] and [`mac`]: every other decision the hooks make about an OS
//!   event that needs no OS call: which message is which kind, wheel notches,
//!   the modifiers reported, down, up and repeat.
//!
//! Compiled on every platform, so the tables and decisions are tested where
//! the hooks themselves are not available.
#![forbid(unsafe_code)]

mod tables;
pub mod mac;
pub mod win;

pub use tables::{dom_code_from_mac_keycode, dom_code_from_windows_scan, UNIDENTIFIED};

/// The modifier keys held when a hook saw an event, as bits of an event's
/// `modifiers`: the DOM's four (`shiftKey`, `ctrlKey`, `altKey`, `metaKey`).
/// Lock keys are not modifiers. The values of the C API's
/// `webview_modifier_t` and the bindings' `Modifier`.
pub mod modifier {
  /// `WEBVIEW_MODIFIER_SHIFT`, the bindings' `Modifier.Shift`.
  pub const SHIFT: u32 = 1 << 0;
  /// `WEBVIEW_MODIFIER_CONTROL`, the bindings' `Modifier.Control`.
  pub const CONTROL: u32 = 1 << 1;
  /// Alt on Windows and Linux, Option on macOS. `WEBVIEW_MODIFIER_ALT`.
  pub const ALT: u32 = 1 << 2;
  /// The Windows key on Windows, Command on macOS. `WEBVIEW_MODIFIER_META`.
  pub const META: u32 = 1 << 3;
}

/// What a mouse hook saw. Any button but the left, right and middle, and a
/// horizontal wheel, never reach the hook. The values of the C API's
/// `webview_mouse_event_t` and the bindings' `MouseEvent`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(i32)]
pub enum MouseEventKind {
  /// The cursor moved, with or without a button held.
  Move = 0,
  LeftDown = 1,
  LeftUp = 2,
  RightDown = 3,
  RightUp = 4,
  MiddleDown = 5,
  MiddleUp = 6,
  /// The vertical wheel turned; the event's `wheel` is the amount.
  Wheel = 7,
}

impl MouseEventKind {
  /// Every kind, in the order of its number.
  pub const ALL: [MouseEventKind; 8] = [
    MouseEventKind::Move,
    MouseEventKind::LeftDown,
    MouseEventKind::LeftUp,
    MouseEventKind::RightDown,
    MouseEventKind::RightUp,
    MouseEventKind::MiddleDown,
    MouseEventKind::MiddleUp,
    MouseEventKind::Wheel,
  ];

  /// The number applications see.
  pub fn code(self) -> i32 {
    self as i32
  }

  /// The kind a number stands for; `None` for a number that is no kind.
  pub fn from_code(code: i32) -> Option<Self> {
    Self::ALL.into_iter().find(|kind| kind.code() == code)
  }
}

/// What a keyboard hook saw. The values of the C API's `webview_key_event_t`
/// and the bindings' `KeyEvent`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(i32)]
pub enum KeyEventKind {
  /// A key went down that was up.
  Down = 0,
  /// A key went up.
  Up = 1,
  /// A key that is held sent another down (the OS's auto-repeat).
  Repeat = 2,
}

impl KeyEventKind {
  /// Every kind, in the order of its number.
  pub const ALL: [KeyEventKind; 3] = [KeyEventKind::Down, KeyEventKind::Up, KeyEventKind::Repeat];

  /// The number applications see.
  pub fn code(self) -> i32 {
    self as i32
  }

  /// The kind a number stands for; `None` for a number that is no kind.
  pub fn from_code(code: i32) -> Option<Self> {
    Self::ALL.into_iter().find(|kind| kind.code() == code)
  }
}

/// Which keys, by the platform's raw code (its low byte), a keyboard hook has
/// seen go down and not yet up. On Windows a second down of a held key is the
/// OS's auto-repeat; on macOS it tells a synthesized modifier's flags-changed
/// down from its up. A new hook starts with every key up.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KeysDown([u64; 4]);

impl KeysDown {
  /// Every key up.
  pub fn new() -> Self {
    Self::default()
  }

  /// Whether the hook saw `key` go down and not yet up.
  pub fn is_down(&self, key: u32) -> bool {
    let key = key & 0xFF;
    self.0[(key / 64) as usize] & (1u64 << (key % 64)) != 0
  }

  /// Records `key` as down or up.
  pub fn set(&mut self, key: u32, down: bool) {
    let key = key & 0xFF;
    let bit = 1u64 << (key % 64);
    let word = &mut self.0[(key / 64) as usize];
    if down {
      *word |= bit;
    } else {
      *word &= !bit;
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// C++ fork, `unit_tests.cc`: "Key codes: Windows scan codes to DOM codes".
  #[test]
  fn key_codes_windows_scan_codes_to_dom_codes() {
    assert_eq!(dom_code_from_windows_scan(0x001E), "KeyA");
    assert_eq!(dom_code_from_windows_scan(0x002C), "KeyZ");
    assert_eq!(dom_code_from_windows_scan(0x0002), "Digit1");
    assert_eq!(dom_code_from_windows_scan(0x001C), "Enter");
    assert_eq!(dom_code_from_windows_scan(0xE01C), "NumpadEnter");
    assert_eq!(dom_code_from_windows_scan(0x001D), "ControlLeft");
    assert_eq!(dom_code_from_windows_scan(0xE01D), "ControlRight");
    assert_eq!(dom_code_from_windows_scan(0x0045), "Pause");
    assert_eq!(dom_code_from_windows_scan(0xE045), "NumLock");
    assert_eq!(dom_code_from_windows_scan(0x0053), "NumpadDecimal");
    assert_eq!(dom_code_from_windows_scan(0xE053), "Delete");
    assert_eq!(dom_code_from_windows_scan(0xE04B), "ArrowLeft");
    assert_eq!(dom_code_from_windows_scan(0xE05B), "MetaLeft");
    assert_eq!(dom_code_from_windows_scan(0x0058), "F12");
    assert_eq!(dom_code_from_windows_scan(0x0076), "F24");
    assert_eq!(dom_code_from_windows_scan(0x00FF), "Unidentified");
    assert_eq!(dom_code_from_windows_scan(0xE0FF), "Unidentified");
  }

  /// C++ fork, `unit_tests.cc`: "Key codes: macOS keycodes to DOM codes".
  #[test]
  fn key_codes_macos_keycodes_to_dom_codes() {
    assert_eq!(dom_code_from_mac_keycode(0x00), "KeyA");
    assert_eq!(dom_code_from_mac_keycode(0x06), "KeyZ");
    assert_eq!(dom_code_from_mac_keycode(0x12), "Digit1");
    assert_eq!(dom_code_from_mac_keycode(0x24), "Enter");
    assert_eq!(dom_code_from_mac_keycode(0x4C), "NumpadEnter");
    assert_eq!(dom_code_from_mac_keycode(0x33), "Backspace");
    assert_eq!(dom_code_from_mac_keycode(0x75), "Delete");
    assert_eq!(dom_code_from_mac_keycode(0x35), "Escape");
    assert_eq!(dom_code_from_mac_keycode(0x37), "MetaLeft");
    assert_eq!(dom_code_from_mac_keycode(0x3A), "AltLeft");
    assert_eq!(dom_code_from_mac_keycode(0x7B), "ArrowLeft");
    assert_eq!(dom_code_from_mac_keycode(0x7A), "F1");
    assert_eq!(dom_code_from_mac_keycode(0x7F), "Unidentified");
  }

  /// The tables hold exactly as many named keys as `key_codes.hh` does, each
  /// name a DOM code (no stray spelling slipped in during the port).
  #[test]
  fn the_tables_have_every_entry_of_the_cpp_tables() {
    let windows = (0..=0xFFFF).filter(|&scan| dom_code_from_windows_scan(scan) != UNIDENTIFIED).count();
    let mac = (0..=0xFF).filter(|&key| dom_code_from_mac_keycode(key) != UNIDENTIFIED).count();
    assert_eq!(windows, 149);
    assert_eq!(mac, 121);
    let names = (0..=0xFFFF).map(dom_code_from_windows_scan).chain((0..=0xFF).map(dom_code_from_mac_keycode));
    for name in names {
      assert!(!name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric()), "{name:?}");
    }
  }

  /// The numbers of the C API's `types.h` and the bindings' enums.
  #[test]
  fn the_kinds_and_modifiers_have_the_c_api_numbers() {
    let mouse: Vec<i32> = MouseEventKind::ALL.iter().map(|k| k.code()).collect();
    assert_eq!(mouse, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert_eq!(MouseEventKind::Wheel.code(), 7);
    assert_eq!(MouseEventKind::from_code(5), Some(MouseEventKind::MiddleDown));
    assert_eq!(MouseEventKind::from_code(8), None);
    assert_eq!(MouseEventKind::from_code(-1), None);
    assert_eq!(KeyEventKind::Down.code(), 0);
    assert_eq!(KeyEventKind::Up.code(), 1);
    assert_eq!(KeyEventKind::Repeat.code(), 2);
    assert_eq!(KeyEventKind::from_code(2), Some(KeyEventKind::Repeat));
    assert_eq!(KeyEventKind::from_code(3), None);
    assert_eq!((modifier::SHIFT, modifier::CONTROL, modifier::ALT, modifier::META), (1, 2, 4, 8));
  }

  #[test]
  fn keys_down_tracks_each_key_by_its_low_byte() {
    let mut keys = KeysDown::new();
    assert!(!keys.is_down(0x41));
    keys.set(0x41, true);
    keys.set(0xFF, true);
    assert!(keys.is_down(0x41) && keys.is_down(0xFF));
    assert!(keys.is_down(0x141), "only the low byte names the key");
    assert!(!keys.is_down(0x40) && !keys.is_down(0x42));
    keys.set(0x41, false);
    assert!(!keys.is_down(0x41) && keys.is_down(0xFF));
  }
}
