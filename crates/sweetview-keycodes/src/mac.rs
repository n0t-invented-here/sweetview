//! The decisions the macOS hooks (one `CGEventTap`) make about an event,
//! without calling the OS: the event's type, flags and fields come in as
//! numbers. Ported from the C++ fork's `mouse_hook.hh`, `keyboard_hook.hh` and
//! `input_hooks.hh`, for the macOS goal to call.

use crate::{modifier, KeyEventKind, KeysDown, MouseEventKind};

/// `CGEventType` values.
pub mod event_type {
  pub const LEFT_MOUSE_DOWN: u32 = 1;
  pub const LEFT_MOUSE_UP: u32 = 2;
  pub const RIGHT_MOUSE_DOWN: u32 = 3;
  pub const RIGHT_MOUSE_UP: u32 = 4;
  pub const MOUSE_MOVED: u32 = 5;
  pub const LEFT_MOUSE_DRAGGED: u32 = 6;
  pub const RIGHT_MOUSE_DRAGGED: u32 = 7;
  pub const KEY_DOWN: u32 = 10;
  pub const KEY_UP: u32 = 11;
  pub const FLAGS_CHANGED: u32 = 12;
  pub const SCROLL_WHEEL: u32 = 22;
  pub const OTHER_MOUSE_DOWN: u32 = 25;
  pub const OTHER_MOUSE_UP: u32 = 26;
  pub const OTHER_MOUSE_DRAGGED: u32 = 27;
}

/// `CGEventFlags` masks.
pub mod flags {
  pub const ALPHA_SHIFT: u64 = 0x0001_0000;
  pub const SHIFT: u64 = 0x0002_0000;
  pub const CONTROL: u64 = 0x0004_0000;
  pub const ALTERNATE: u64 = 0x0008_0000;
  pub const COMMAND: u64 = 0x0010_0000;
  pub const SECONDARY_FN: u64 = 0x0080_0000;
}

/// The mouse button number (`kCGMouseEventButtonNumber`) of the middle button.
pub const MIDDLE_BUTTON: i64 = 2;

/// The kind a mouse hook reports for an event, or `None` for the events it
/// passes on unreported. A drag with any button is a move. `button` is the
/// event's `kCGMouseEventButtonNumber`, read only for the "other" buttons:
/// button 2 is the middle one, the rest are not the hook's business.
pub fn mouse_event_kind(event_type: u32, button: impl FnOnce() -> i64) -> Option<MouseEventKind> {
  use event_type::*;
  match event_type {
    MOUSE_MOVED | LEFT_MOUSE_DRAGGED | RIGHT_MOUSE_DRAGGED | OTHER_MOUSE_DRAGGED => Some(MouseEventKind::Move),
    LEFT_MOUSE_DOWN => Some(MouseEventKind::LeftDown),
    LEFT_MOUSE_UP => Some(MouseEventKind::LeftUp),
    RIGHT_MOUSE_DOWN => Some(MouseEventKind::RightDown),
    RIGHT_MOUSE_UP => Some(MouseEventKind::RightUp),
    OTHER_MOUSE_DOWN | OTHER_MOUSE_UP => {
      if button() != MIDDLE_BUTTON {
        return None;
      }
      Some(if event_type == OTHER_MOUSE_DOWN { MouseEventKind::MiddleDown } else { MouseEventKind::MiddleUp })
    }
    SCROLL_WHEEL => Some(MouseEventKind::Wheel),
    _ => None,
  }
}

/// An event's flags as [`modifier`] bits: on macOS every event carries the
/// modifiers as they were for it, so both hooks report these.
pub fn modifiers_from_flags(event_flags: u64) -> u32 {
  let mut bits = 0;
  if event_flags & flags::SHIFT != 0 {
    bits |= modifier::SHIFT;
  }
  if event_flags & flags::CONTROL != 0 {
    bits |= modifier::CONTROL;
  }
  if event_flags & flags::ALTERNATE != 0 {
    bits |= modifier::ALT;
  }
  if event_flags & flags::COMMAND != 0 {
    bits |= modifier::META;
  }
  bits
}

/// A modifier key's flags: the flag it toggles (what callers read), the
/// per-side bit the hardware sets in the same flags word (`IOLLEvent.h`'s
/// `NX_DEVICE*KEYMASK`), and both sides' bits; the side bits are 0 for Caps
/// Lock and Fn, which have no sides. All 0 for a key that is no modifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModifierFlags {
  pub flag: u64,
  pub side: u64,
  pub both_sides: u64,
}

/// The [`ModifierFlags`] of a keycode.
pub fn modifier_flags_for_keycode(keycode: u32) -> ModifierFlags {
  const LSHIFT: u64 = 0x02;
  const RSHIFT: u64 = 0x04;
  const LCTRL: u64 = 0x01;
  const RCTRL: u64 = 0x2000;
  const LALT: u64 = 0x20;
  const RALT: u64 = 0x40;
  const LCMD: u64 = 0x08;
  const RCMD: u64 = 0x10;
  let (flag, side, both_sides) = match keycode {
    0x38 => (flags::SHIFT, LSHIFT, LSHIFT | RSHIFT),
    0x3C => (flags::SHIFT, RSHIFT, LSHIFT | RSHIFT),
    0x3B => (flags::CONTROL, LCTRL, LCTRL | RCTRL),
    0x3E => (flags::CONTROL, RCTRL, LCTRL | RCTRL),
    0x3A => (flags::ALTERNATE, LALT, LALT | RALT),
    0x3D => (flags::ALTERNATE, RALT, LALT | RALT),
    0x37 => (flags::COMMAND, LCMD, LCMD | RCMD),
    0x36 => (flags::COMMAND, RCMD, LCMD | RCMD),
    0x39 => (flags::ALPHA_SHIFT, 0, 0),
    0x3F => (flags::SECONDARY_FN, 0, 0),
    _ => (0, 0, 0),
  };
  ModifierFlags { flag, side, both_sides }
}

/// The kind of a key event, recording it in `keys`, or `None` for an event
/// the hook passes on unreported. `keycode` is the event's
/// `kCGKeyboardEventKeycode` (its low byte names the key), `event_flags` its
/// flags, `autorepeat` its `kCGKeyboardEventAutorepeat`.
///
/// A modifier key's press and release both arrive as flags-changed. The
/// hardware sets a bit per side, which says whether this side is down whatever
/// the other side does. An event without side bits is synthesized
/// (`CGEventPost` with flags set by hand): its flag clear is the up, and its
/// flag set is the down unless the hook saw this key go down already. Caps
/// Lock's flag is the lock state, so its down turns the lock on and its up
/// turns it off. A flags-changed for a key that is no modifier (a remapper's,
/// with keycode 0) is nothing to report.
pub fn key_event_kind(keys: &mut KeysDown, event_type: u32, keycode: u32, event_flags: u64, autorepeat: bool) -> Option<KeyEventKind> {
  let key = keycode & 0xFF;
  match event_type {
    event_type::KEY_DOWN => {
      keys.set(key, true);
      Some(if autorepeat { KeyEventKind::Repeat } else { KeyEventKind::Down })
    }
    event_type::KEY_UP => {
      keys.set(key, false);
      Some(KeyEventKind::Up)
    }
    event_type::FLAGS_CHANGED => {
      let m = modifier_flags_for_keycode(key);
      if m.flag == 0 {
        return None;
      }
      let is_down = if m.both_sides != 0 && event_flags & m.both_sides != 0 {
        event_flags & m.side != 0
      } else if event_flags & m.flag == 0 {
        false
      } else {
        !keys.is_down(key)
      };
      keys.set(key, is_down);
      Some(if is_down { KeyEventKind::Down } else { KeyEventKind::Up })
    }
    _ => None,
  }
}

#[cfg(test)]
mod tests {
  use super::event_type::*;
  use super::*;

  #[test]
  fn each_mouse_event_has_its_kind_and_only_button_2_is_the_middle() {
    let never = || panic!("the button is read only for the other buttons");
    assert_eq!(mouse_event_kind(MOUSE_MOVED, never), Some(MouseEventKind::Move));
    assert_eq!(mouse_event_kind(LEFT_MOUSE_DRAGGED, never), Some(MouseEventKind::Move));
    assert_eq!(mouse_event_kind(RIGHT_MOUSE_DRAGGED, never), Some(MouseEventKind::Move));
    assert_eq!(mouse_event_kind(OTHER_MOUSE_DRAGGED, never), Some(MouseEventKind::Move));
    assert_eq!(mouse_event_kind(LEFT_MOUSE_DOWN, never), Some(MouseEventKind::LeftDown));
    assert_eq!(mouse_event_kind(LEFT_MOUSE_UP, never), Some(MouseEventKind::LeftUp));
    assert_eq!(mouse_event_kind(RIGHT_MOUSE_DOWN, never), Some(MouseEventKind::RightDown));
    assert_eq!(mouse_event_kind(RIGHT_MOUSE_UP, never), Some(MouseEventKind::RightUp));
    assert_eq!(mouse_event_kind(SCROLL_WHEEL, never), Some(MouseEventKind::Wheel));
    assert_eq!(mouse_event_kind(OTHER_MOUSE_DOWN, || 2), Some(MouseEventKind::MiddleDown));
    assert_eq!(mouse_event_kind(OTHER_MOUSE_UP, || 2), Some(MouseEventKind::MiddleUp));
    assert_eq!(mouse_event_kind(OTHER_MOUSE_DOWN, || 3), None);
    assert_eq!(mouse_event_kind(OTHER_MOUSE_UP, || 4), None);
    assert_eq!(mouse_event_kind(KEY_DOWN, never), None);
  }

  #[test]
  fn modifiers_come_from_the_flags_and_lock_keys_are_none() {
    assert_eq!(modifiers_from_flags(0), 0);
    assert_eq!(modifiers_from_flags(flags::SHIFT | flags::COMMAND), modifier::SHIFT | modifier::META);
    assert_eq!(modifiers_from_flags(flags::CONTROL | flags::ALTERNATE), modifier::CONTROL | modifier::ALT);
    assert_eq!(modifiers_from_flags(flags::ALPHA_SHIFT | flags::SECONDARY_FN), 0);
  }

  #[test]
  fn key_down_up_and_autorepeat() {
    let mut keys = KeysDown::new();
    assert_eq!(key_event_kind(&mut keys, KEY_DOWN, 0x00, 0, false), Some(KeyEventKind::Down));
    assert!(keys.is_down(0x00));
    assert_eq!(key_event_kind(&mut keys, KEY_DOWN, 0x00, 0, true), Some(KeyEventKind::Repeat));
    assert_eq!(key_event_kind(&mut keys, KEY_UP, 0x00, 0, false), Some(KeyEventKind::Up));
    assert!(!keys.is_down(0x00));
    assert_eq!(key_event_kind(&mut keys, SCROLL_WHEEL, 0x00, 0, false), None);
  }

  #[test]
  fn a_hardware_modifier_is_down_by_its_own_side_bit() {
    let mut keys = KeysDown::new();
    let left_shift = 0x38;
    let right_shift = 0x3C;
    // Left down.
    assert_eq!(key_event_kind(&mut keys, FLAGS_CHANGED, left_shift, flags::SHIFT | 0x02, false), Some(KeyEventKind::Down));
    // Right down while left is held.
    assert_eq!(key_event_kind(&mut keys, FLAGS_CHANGED, right_shift, flags::SHIFT | 0x02 | 0x04, false), Some(KeyEventKind::Down));
    // Left up while right is held: the flag is still set, the left side bit is not.
    assert_eq!(key_event_kind(&mut keys, FLAGS_CHANGED, left_shift, flags::SHIFT | 0x04, false), Some(KeyEventKind::Up));
    // Right up: no flag, no side bit.
    assert_eq!(key_event_kind(&mut keys, FLAGS_CHANGED, right_shift, 0, false), Some(KeyEventKind::Up));
  }

  #[test]
  fn a_synthesized_modifier_without_side_bits_is_told_by_the_hooks_own_state() {
    let mut keys = KeysDown::new();
    let command = 0x37;
    assert_eq!(key_event_kind(&mut keys, FLAGS_CHANGED, command, flags::COMMAND, false), Some(KeyEventKind::Down));
    // The same flags again: the hook saw it go down, so this is its up.
    assert_eq!(key_event_kind(&mut keys, FLAGS_CHANGED, command, flags::COMMAND, false), Some(KeyEventKind::Up));
    assert_eq!(key_event_kind(&mut keys, FLAGS_CHANGED, command, flags::COMMAND, false), Some(KeyEventKind::Down));
    // Flag clear is always the up.
    assert_eq!(key_event_kind(&mut keys, FLAGS_CHANGED, command, 0, false), Some(KeyEventKind::Up));
  }

  #[test]
  fn caps_lock_is_down_when_the_lock_turns_on_and_up_when_it_turns_off() {
    let mut keys = KeysDown::new();
    assert_eq!(key_event_kind(&mut keys, FLAGS_CHANGED, 0x39, flags::ALPHA_SHIFT, false), Some(KeyEventKind::Down));
    assert_eq!(key_event_kind(&mut keys, FLAGS_CHANGED, 0x39, 0, false), Some(KeyEventKind::Up));
  }

  #[test]
  fn a_flags_changed_for_a_key_that_is_no_modifier_is_not_reported() {
    let mut keys = KeysDown::new();
    assert_eq!(key_event_kind(&mut keys, FLAGS_CHANGED, 0x00, flags::SHIFT, false), None);
    assert!(!keys.is_down(0x00));
  }

  #[test]
  fn modifier_flags_name_each_side() {
    assert_eq!(modifier_flags_for_keycode(0x3E), ModifierFlags { flag: flags::CONTROL, side: 0x2000, both_sides: 0x2001 });
    assert_eq!(modifier_flags_for_keycode(0x3F), ModifierFlags { flag: flags::SECONDARY_FN, side: 0, both_sides: 0 });
    assert_eq!(modifier_flags_for_keycode(0x00), ModifierFlags { flag: 0, side: 0, both_sides: 0 });
  }
}
