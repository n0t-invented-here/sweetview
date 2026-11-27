//! The decisions the Windows hooks (`WH_MOUSE_LL`, `WH_KEYBOARD_LL`) make
//! about an event, without calling the OS: the OS's answers they need (the
//! asynchronous key state, `MapVirtualKeyW`) come in as closures. Ported from
//! the C++ fork's `mouse_hook.hh`, `keyboard_hook.hh` and `input_hooks.hh`.
//!
//! The constants are the Win32 values the decisions read; the platform crate
//! checks them against the `windows` crate's.

use crate::{modifier, KeyEventKind, KeysDown, MouseEventKind};

/// The window messages a low-level hook receives in its `wParam`.
pub mod message {
  pub const WM_KEYDOWN: u32 = 0x0100;
  pub const WM_KEYUP: u32 = 0x0101;
  pub const WM_SYSKEYDOWN: u32 = 0x0104;
  pub const WM_SYSKEYUP: u32 = 0x0105;
  pub const WM_MOUSEMOVE: u32 = 0x0200;
  pub const WM_LBUTTONDOWN: u32 = 0x0201;
  pub const WM_LBUTTONUP: u32 = 0x0202;
  pub const WM_RBUTTONDOWN: u32 = 0x0204;
  pub const WM_RBUTTONUP: u32 = 0x0205;
  pub const WM_MBUTTONDOWN: u32 = 0x0207;
  pub const WM_MBUTTONUP: u32 = 0x0208;
  pub const WM_MOUSEWHEEL: u32 = 0x020A;
  pub const WM_XBUTTONDOWN: u32 = 0x020B;
  pub const WM_XBUTTONUP: u32 = 0x020C;
  pub const WM_MOUSEHWHEEL: u32 = 0x020E;
}

/// The virtual-key codes the decisions name.
pub mod vk {
  pub const VK_RETURN: u32 = 0x0D;
  pub const VK_SHIFT: u32 = 0x10;
  pub const VK_CONTROL: u32 = 0x11;
  pub const VK_MENU: u32 = 0x12;
  pub const VK_PAUSE: u32 = 0x13;
  pub const VK_PRIOR: u32 = 0x21;
  pub const VK_NEXT: u32 = 0x22;
  pub const VK_END: u32 = 0x23;
  pub const VK_HOME: u32 = 0x24;
  pub const VK_LEFT: u32 = 0x25;
  pub const VK_UP: u32 = 0x26;
  pub const VK_RIGHT: u32 = 0x27;
  pub const VK_DOWN: u32 = 0x28;
  pub const VK_SNAPSHOT: u32 = 0x2C;
  pub const VK_INSERT: u32 = 0x2D;
  pub const VK_DELETE: u32 = 0x2E;
  pub const VK_LWIN: u32 = 0x5B;
  pub const VK_RWIN: u32 = 0x5C;
  pub const VK_APPS: u32 = 0x5D;
  pub const VK_DIVIDE: u32 = 0x6F;
  pub const VK_F24: u32 = 0x87;
  pub const VK_NUMLOCK: u32 = 0x90;
  pub const VK_LSHIFT: u32 = 0xA0;
  pub const VK_RSHIFT: u32 = 0xA1;
  pub const VK_LCONTROL: u32 = 0xA2;
  pub const VK_RCONTROL: u32 = 0xA3;
  pub const VK_LMENU: u32 = 0xA4;
  pub const VK_RMENU: u32 = 0xA5;
  pub const VK_PACKET: u32 = 0xE7;
}

/// `WHEEL_DELTA`: one notch of the wheel.
pub const WHEEL_DELTA: i16 = 120;

/// The kind a mouse hook reports for a message, or `None` for the messages it
/// passes on unreported: the X buttons and the horizontal wheel.
pub fn mouse_event_kind(message: u32) -> Option<MouseEventKind> {
  use message::*;
  match message {
    WM_MOUSEMOVE => Some(MouseEventKind::Move),
    WM_LBUTTONDOWN => Some(MouseEventKind::LeftDown),
    WM_LBUTTONUP => Some(MouseEventKind::LeftUp),
    WM_RBUTTONDOWN => Some(MouseEventKind::RightDown),
    WM_RBUTTONUP => Some(MouseEventKind::RightUp),
    WM_MBUTTONDOWN => Some(MouseEventKind::MiddleDown),
    WM_MBUTTONUP => Some(MouseEventKind::MiddleUp),
    WM_MOUSEWHEEL => Some(MouseEventKind::Wheel),
    _ => None,
  }
}

/// The notches a `WM_MOUSEWHEEL` turned, from `MSLLHOOKSTRUCT::mouseData`:
/// its high word is the signed delta, [`WHEEL_DELTA`] per notch, positive away
/// from the user. A fine-grained wheel gives fractions.
pub fn wheel_notches(mouse_data: u32) -> f64 {
  let delta = (mouse_data >> 16) as u16 as i16;
  f64::from(delta) / f64::from(WHEEL_DELTA)
}

/// Whether a keyboard hook's message is a key going down (`WM_KEYDOWN` or
/// `WM_SYSKEYDOWN`); everything else is a key going up.
pub fn is_key_down_message(message: u32) -> bool {
  message == message::WM_KEYDOWN || message == message::WM_SYSKEYDOWN
}

/// The key's scan code with `0xE000` added for an extended key, which is how
/// [`crate::dom_code_from_windows_scan`] names it.
///
/// `vk_code`, `scan_code` and `extended` are the hook's
/// `KBDLLHOOKSTRUCT::vkCode`, `scanCode` and `LLKHF_EXTENDED` flag.
/// Injected input may carry no scan code at all (a `SendInput` with only a
/// virtual key); the virtual key then names it, through `map_vk_to_vsc_ex`,
/// which is `MapVirtualKeyW(vk, MAPVK_VK_TO_VSC_EX)` and is called only then.
/// A Unicode character injected as `VK_PACKET` has no physical key: 0, which
/// the table names "Unidentified".
pub fn dom_scan(vk_code: u32, scan_code: u32, extended: bool, map_vk_to_vsc_ex: impl FnOnce(u32) -> u32) -> u32 {
  use vk::*;
  if vk_code == VK_PACKET {
    return 0;
  }
  let mut scan = scan_code & 0xFF;
  let mut extended = extended;
  if scan == 0 {
    match vk_code {
      // MapVirtualKey says E1 1D, the key's prefix, not 45.
      VK_PAUSE => return 0x0045,
      // MapVirtualKey says 54, the Alt+PrintScreen code.
      VK_SNAPSHOT => return 0xE037,
      _ => {}
    }
    let mapped = map_vk_to_vsc_ex(vk_code);
    scan = mapped & 0xFF;
    extended = (mapped & 0xFF00) == 0xE000;
    // MapVirtualKey's answer for the navigation cluster is the numpad's code
    // without the extended prefix; the virtual key says which it is.
    if matches!(
      vk_code,
      VK_INSERT
        | VK_DELETE
        | VK_HOME
        | VK_END
        | VK_PRIOR
        | VK_NEXT
        | VK_LEFT
        | VK_UP
        | VK_RIGHT
        | VK_DOWN
        | VK_NUMLOCK
        | VK_RCONTROL
        | VK_RMENU
        | VK_LWIN
        | VK_RWIN
        | VK_APPS
        | VK_DIVIDE
    ) {
      extended = true;
    }
  }
  scan | if extended { 0xE000 } else { 0 }
}

/// The Shift events the keyboard makes up around a numpad key pressed with
/// Shift under Num Lock (scan 2A or 36 with the extended prefix): no key went
/// down, so the hook does not report them.
pub fn is_fake_shift(scan: u32) -> bool {
  scan == 0xE02A || scan == 0xE036
}

/// The modifier keys held right now, as [`modifier`] bits, from `key_down`,
/// which is whether a virtual key is down by the asynchronous key state. What
/// the mouse hook reports: inside a low-level hook the asynchronous state is
/// the keyboard as it was for that event.
pub fn modifiers_now(key_down: impl Fn(u32) -> bool) -> u32 {
  let mut bits = 0;
  if key_down(vk::VK_SHIFT) {
    bits |= modifier::SHIFT;
  }
  if key_down(vk::VK_CONTROL) {
    bits |= modifier::CONTROL;
  }
  if key_down(vk::VK_MENU) {
    bits |= modifier::ALT;
  }
  if key_down(vk::VK_LWIN) || key_down(vk::VK_RWIN) {
    bits |= modifier::META;
  }
  bits
}

/// The modifier keys held after a key event, as [`modifier`] bits: what the
/// keyboard hook reports, so a modifier's own down has its bit set and its up
/// has it clear. The asynchronous state (`key_down`) does not yet include the
/// event the hook is looking at, so the event's own key is taken from the
/// event: its down sets the bit and its up clears it, unless the other key of
/// the pair is still held. A generic code (`VK_SHIFT`) stands for either side;
/// an injected event may carry one.
pub fn modifiers_after_key(vk_code: u32, down: bool, key_down: impl Fn(u32) -> bool) -> u32 {
  let side = |side_vk: u32, generic: u32| {
    if vk_code == side_vk || vk_code == generic {
      down
    } else {
      key_down(side_vk)
    }
  };
  let held = |left: u32, right: u32, generic: u32| side(left, generic) || side(right, generic);
  let mut bits = 0;
  if held(vk::VK_LSHIFT, vk::VK_RSHIFT, vk::VK_SHIFT) {
    bits |= modifier::SHIFT;
  }
  if held(vk::VK_LCONTROL, vk::VK_RCONTROL, vk::VK_CONTROL) {
    bits |= modifier::CONTROL;
  }
  if held(vk::VK_LMENU, vk::VK_RMENU, vk::VK_MENU) {
    bits |= modifier::ALT;
  }
  // The Windows key has no generic code; the C++ passes 0, kept so the answers match.
  if held(vk::VK_LWIN, vk::VK_RWIN, 0) {
    bits |= modifier::META;
  }
  bits
}

/// The kind of a key event, recording it in `keys`. The low-level message has
/// no repeat count: a down for a key the hook saw go down and not yet up is
/// the OS's auto-repeat, provided the key is still held (`still_held`, the
/// asynchronous key state, asked only then): an up the hook never saw (the
/// secure desktop, another hook) must not turn the next press into a repeat.
pub fn key_event_kind(keys: &mut KeysDown, vk_code: u32, down: bool, still_held: impl FnOnce() -> bool) -> KeyEventKind {
  let key = vk_code & 0xFF;
  if down {
    let kind = if keys.is_down(key) && still_held() { KeyEventKind::Repeat } else { KeyEventKind::Down };
    keys.set(key, true);
    kind
  } else {
    keys.set(key, false);
    KeyEventKind::Up
  }
}

#[cfg(test)]
mod tests {
  use super::message::*;
  use super::vk::*;
  use super::*;

  /// `MapVirtualKeyW(vk, MAPVK_VK_TO_VSC_EX)` as a US keyboard answers it, for
  /// the keys the tests use.
  fn us_map(vk: u32) -> u32 {
    match vk {
      VK_RETURN => 0x1C,
      0x5A => 0x2C, // 'Z'
      VK_F24 => 0x76,
      // The navigation cluster: the numpad's codes, no prefix.
      VK_DELETE => 0x53,
      VK_HOME => 0x47,
      VK_LEFT => 0x4B,
      // These come back with the prefix already.
      VK_NUMLOCK => 0xE045,
      VK_RCONTROL => 0xE01D,
      VK_LWIN => 0xE05B,
      VK_DIVIDE => 0xE035,
      VK_LSHIFT => 0x2A,
      _ => 0,
    }
  }

  /// C++ fork, `unit_tests.cc`: "Keyboard hook: scan code from a bare virtual
  /// key on Windows", with the OS's `MapVirtualKeyW` answers as a closure; the
  /// platform crate runs the same cases against the real call.
  #[test]
  fn keyboard_hook_scan_code_from_a_bare_virtual_key_on_windows() {
    let bare = |vk: u32| dom_scan(vk, 0, false, us_map);
    assert_eq!(bare(VK_DELETE), 0xE053);
    assert_eq!(bare(VK_HOME), 0xE047);
    assert_eq!(bare(VK_LEFT), 0xE04B);
    assert_eq!(bare(VK_RETURN), 0x001C);
    assert_eq!(bare(VK_PAUSE), 0x0045);
    assert_eq!(bare(VK_NUMLOCK), 0xE045);
    assert_eq!(bare(VK_SNAPSHOT), 0xE037);
    assert_eq!(bare(VK_RCONTROL), 0xE01D);
    assert_eq!(bare(VK_LWIN), 0xE05B);
    assert_eq!(bare(VK_DIVIDE), 0xE035);
    assert_eq!(bare(VK_PACKET), 0);
    assert_eq!(bare(0x5A), 0x002C);
    // A scan code that is there is used as it is, with the extended flag.
    assert_eq!(dom_scan(VK_DELETE, 0x53, true, us_map), 0xE053);
    // The numpad's decimal under Num Lock off.
    assert_eq!(dom_scan(VK_DELETE, 0x53, false, us_map), 0x0053);
  }

  #[test]
  fn a_scan_code_that_is_there_never_asks_the_os() {
    let scan = dom_scan(VK_F24, 0x176, false, |_| panic!("MapVirtualKeyW was not needed"));
    assert_eq!(scan, 0x76, "only the low byte of scanCode is the key");
    assert_eq!(crate::dom_code_from_windows_scan(scan), "F24");
    assert_eq!(dom_scan(VK_PACKET, 0x1E, true, |_| panic!("not asked")), 0, "VK_PACKET has no key");
  }

  #[test]
  fn the_made_up_shifts_around_a_numpad_key_are_not_reported() {
    assert!(is_fake_shift(0xE02A));
    assert!(is_fake_shift(0xE036));
    assert!(!is_fake_shift(0x002A), "the real ShiftLeft");
    assert!(!is_fake_shift(0x0036), "the real ShiftRight");
  }

  #[test]
  fn each_mouse_message_has_its_kind_and_the_rest_pass_unreported() {
    let reported = [
      (WM_MOUSEMOVE, MouseEventKind::Move),
      (WM_LBUTTONDOWN, MouseEventKind::LeftDown),
      (WM_LBUTTONUP, MouseEventKind::LeftUp),
      (WM_RBUTTONDOWN, MouseEventKind::RightDown),
      (WM_RBUTTONUP, MouseEventKind::RightUp),
      (WM_MBUTTONDOWN, MouseEventKind::MiddleDown),
      (WM_MBUTTONUP, MouseEventKind::MiddleUp),
      (WM_MOUSEWHEEL, MouseEventKind::Wheel),
    ];
    for (message, kind) in reported {
      assert_eq!(mouse_event_kind(message), Some(kind));
    }
    for message in [WM_XBUTTONDOWN, WM_XBUTTONUP, WM_MOUSEHWHEEL, WM_KEYDOWN, 0] {
      assert_eq!(mouse_event_kind(message), None);
    }
  }

  #[test]
  fn wheel_notches_are_the_signed_high_word_over_wheel_delta() {
    assert_eq!(wheel_notches(120 << 16), 1.0);
    assert_eq!(wheel_notches(((-120i16) as u16 as u32) << 16), -1.0);
    assert_eq!(wheel_notches(((-360i16) as u16 as u32) << 16), -3.0);
    assert_eq!(wheel_notches(60 << 16), 0.5, "a fine-grained wheel gives fractions");
    assert_eq!(wheel_notches(0x0000_FFFF), 0.0, "the low word is not the delta");
  }

  #[test]
  fn down_messages_are_keydown_and_syskeydown() {
    assert!(is_key_down_message(WM_KEYDOWN));
    assert!(is_key_down_message(WM_SYSKEYDOWN));
    assert!(!is_key_down_message(WM_KEYUP));
    assert!(!is_key_down_message(WM_SYSKEYUP));
  }

  #[test]
  fn modifiers_now_reads_the_four_from_the_key_state() {
    assert_eq!(modifiers_now(|_| false), 0);
    assert_eq!(modifiers_now(|vk| vk == VK_SHIFT), modifier::SHIFT);
    assert_eq!(modifiers_now(|vk| vk == VK_CONTROL || vk == VK_MENU), modifier::CONTROL | modifier::ALT);
    assert_eq!(modifiers_now(|vk| vk == VK_RWIN), modifier::META);
    assert_eq!(modifiers_now(|_| true), 0b1111);
  }

  #[test]
  fn modifiers_after_a_key_include_its_own_down_and_exclude_its_own_up() {
    let none = |_| false;
    // A modifier's own down sets its bit before the key state knows of it.
    assert_eq!(modifiers_after_key(VK_LSHIFT, true, none), modifier::SHIFT);
    assert_eq!(modifiers_after_key(VK_RCONTROL, true, none), modifier::CONTROL);
    assert_eq!(modifiers_after_key(VK_LMENU, true, none), modifier::ALT);
    assert_eq!(modifiers_after_key(VK_RWIN, true, none), modifier::META);
    // Its own up clears it although the key state still says down.
    assert_eq!(modifiers_after_key(VK_LSHIFT, false, |vk| vk == VK_LSHIFT), 0);
    // ...unless the other side is still held.
    assert_eq!(modifiers_after_key(VK_LSHIFT, false, |vk| vk == VK_RSHIFT), modifier::SHIFT);
    // A generic code stands for both sides.
    assert_eq!(modifiers_after_key(VK_SHIFT, true, none), modifier::SHIFT);
    assert_eq!(modifiers_after_key(VK_CONTROL, false, |vk| vk == VK_LCONTROL), 0);
    // Another key reports what the key state says.
    assert_eq!(modifiers_after_key(VK_F24, true, |vk| vk == VK_LCONTROL || vk == VK_LWIN), modifier::CONTROL | modifier::META);
    // The generic VK_SHIFT in the key state is not read: the sides are.
    assert_eq!(modifiers_after_key(VK_F24, true, |vk| vk == VK_SHIFT), 0);
  }

  #[test]
  fn a_second_down_of_a_held_key_is_a_repeat() {
    let mut keys = KeysDown::new();
    assert_eq!(key_event_kind(&mut keys, VK_F24, true, || panic!("not asked for a first down")), KeyEventKind::Down);
    assert_eq!(key_event_kind(&mut keys, VK_F24, true, || true), KeyEventKind::Repeat);
    assert_eq!(key_event_kind(&mut keys, VK_F24, true, || true), KeyEventKind::Repeat);
    assert_eq!(key_event_kind(&mut keys, VK_F24, false, || panic!("not asked for an up")), KeyEventKind::Up);
    assert_eq!(key_event_kind(&mut keys, VK_F24, true, || panic!("not asked")), KeyEventKind::Down);
  }

  #[test]
  fn a_down_after_an_up_the_hook_never_saw_is_a_down() {
    let mut keys = KeysDown::new();
    key_event_kind(&mut keys, VK_F24, true, || true);
    // The up went elsewhere (the secure desktop); the key state says it is up.
    assert_eq!(key_event_kind(&mut keys, VK_F24, true, || false), KeyEventKind::Down);
  }
}
