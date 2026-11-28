//! The hooks installed for real and driven with synthetic input from the test.
//!
//! These tests share the desktop with whatever else runs on the machine, so
//! they keep their input small: the pointer moves a few pixels and is put
//! back; button presses and the wheel are swallowed by the test's own handler
//! so no window receives them; keys are F24 (bound to nothing) and Shift; a
//! guard sends every key's up whatever happens. They run one at a time.
#![cfg(windows)]
#![deny(clippy::undocumented_unsafe_blocks)]
#![deny(clippy::multiple_unsafe_ops_per_block)]

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use sweetview_platform_input::{modifier, HookError, KeyEvent, KeyEventKind, KeyboardHook, MouseEvent, MouseEventKind, MouseHook};
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::Input::KeyboardAndMouse::{
  GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
  KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN,
  MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
  MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY, VK_F24, VK_LBUTTON, VK_LSHIFT,
  VK_MBUTTON, VK_RBUTTON,
};
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetSystemMetrics, SetCursorPos, SM_CXSCREEN, SM_CYSCREEN};

// Dispatches this thread's messages, through which the OS calls its hooks.
use sweetview_platform_loop::dispatch_waiting as pump;

const F24: u32 = VK_F24.0 as u32;
const LSHIFT: u32 = VK_LSHIFT.0 as u32;

static SERIAL: Mutex<()> = Mutex::new(());

/// One test at a time, in a process whose coordinates are physical pixels, as
/// the hook's are.
fn serial() -> MutexGuard<'static, ()> {
  let guard = SERIAL.lock().unwrap_or_else(PoisonError::into_inner);
  // SAFETY: takes a constant awareness context; a second call fails harmlessly, the awareness already set.
  let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
  guard
}

/// Pumps until `done` or two seconds pass; returns `done()`.
fn pump_until(done: impl Fn() -> bool) -> bool {
  let deadline = Instant::now() + Duration::from_secs(2);
  while !done() && Instant::now() < deadline {
    pump();
    std::thread::sleep(Duration::from_millis(1));
  }
  done()
}

/// Pumps for a while, for checks that something did not happen.
fn pump_for(ms: u64) {
  let deadline = Instant::now() + Duration::from_millis(ms);
  while Instant::now() < deadline {
    pump();
    std::thread::sleep(Duration::from_millis(1));
  }
}

/// Injects input from another thread while this one pumps, as real input
/// arrives. Injected from the hook's own thread, the first event's hook call
/// can wait on a thread that is busy inside `SendInput`; the OS then gives up
/// on the hook for that event and passes it on unseen.
fn send(inputs: &[INPUT]) {
  let inputs = inputs.to_vec();
  let expected = inputs.len();
  let sender = std::thread::spawn(move || {
    // SAFETY: `inputs` is a vector of fully initialised INPUTs owned by this closure for the whole call,
    // and the size is INPUT's.
    unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) }
  });
  while !sender.is_finished() {
    pump();
    std::thread::sleep(Duration::from_millis(1));
  }
  let sent = sender.join().expect("the sending thread");
  assert_eq!(sent as usize, expected, "SendInput queued every input");
}

fn key(vk: u32, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
  INPUT {
    r#type: INPUT_KEYBOARD,
    Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk as u16), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
  }
}

fn key_down_input(vk: u32) -> INPUT {
  key(vk, 0, KEYBD_EVENT_FLAGS(0))
}

fn key_up_input(vk: u32) -> INPUT {
  key(vk, 0, KEYEVENTF_KEYUP)
}

fn mouse(dx: i32, dy: i32, data: i32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
  INPUT {
    r#type: INPUT_MOUSE,
    Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
  }
}

fn primary_size() -> (i32, i32) {
  // SAFETY: GetSystemMetrics takes an index and touches no memory of ours.
  let width = unsafe { GetSystemMetrics(SM_CXSCREEN) };
  // SAFETY: as above.
  let height = unsafe { GetSystemMetrics(SM_CYSCREEN) };
  (width, height)
}

/// An absolute move to a pixel of the primary display.
fn move_to(x: i32, y: i32) -> INPUT {
  let (width, height) = primary_size();
  // The normalised coordinate whose pixel is exactly (x, y): pixel = normalised * size / 65536.
  let nx = ((i64::from(x) * 65536 + i64::from(width) - 1) / i64::from(width)) as i32;
  let ny = ((i64::from(y) * 65536 + i64::from(height) - 1) / i64::from(height)) as i32;
  mouse(nx, ny, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE)
}

fn cursor() -> (i32, i32) {
  let mut at = POINT::default();
  // SAFETY: `at` is a valid POINT for the call to fill.
  unsafe { GetCursorPos(&mut at) }.expect("GetCursorPos");
  (at.x, at.y)
}

/// A spot on the primary display near the cursor, a few pixels from any edge.
fn spot_near_cursor() -> (i32, i32) {
  let (width, height) = primary_size();
  let (x, y) = cursor();
  (x.clamp(20, width - 20), y.clamp(20, height - 20))
}

fn near(event: &MouseEvent, (x, y): (i32, i32)) -> bool {
  (event.x - f64::from(x)).abs() <= 1.0 && (event.y - f64::from(y)).abs() <= 1.0
}

fn is_down(vk: u32) -> bool {
  // SAFETY: GetAsyncKeyState takes a key number and touches no memory of ours.
  let state = unsafe { GetAsyncKeyState(vk as i32) };
  state < 0
}

/// Puts the pointer back where it was when dropped.
struct CursorBack((i32, i32));

impl CursorBack {
  fn here() -> Self {
    Self(cursor())
  }
}

impl Drop for CursorBack {
  fn drop(&mut self) {
    // SAFETY: SetCursorPos takes two numbers and touches no memory of ours.
    let _ = unsafe { SetCursorPos(self.0 .0, self.0 .1) };
  }
}

/// Sends the up of each key when dropped, so no test leaves a key down. Made
/// before any hook, so it drops after them and its ups reach the system.
struct KeysUp(&'static [u32]);

impl Drop for KeysUp {
  fn drop(&mut self) {
    let ups: Vec<INPUT> = self.0.iter().map(|&vk| key_up_input(vk)).collect();
    send(&ups);
    pump_until(|| self.0.iter().all(|&vk| !is_down(vk)));
  }
}

/// Releases, when dropped, each mouse button that is down then but was not
/// when this was made: should a press ever get past the hook while its
/// release is swallowed, the button would otherwise stay down for the whole
/// desktop. Made before the hook, so it drops after it.
struct ButtonsUp(Vec<(u32, MOUSE_EVENT_FLAGS)>);

impl ButtonsUp {
  fn now() -> Self {
    let buttons = [(VK_LBUTTON, MOUSEEVENTF_LEFTUP), (VK_RBUTTON, MOUSEEVENTF_RIGHTUP), (VK_MBUTTON, MOUSEEVENTF_MIDDLEUP)];
    Self(buttons.into_iter().map(|(vk, up)| (u32::from(vk.0), up)).filter(|&(vk, _)| !is_down(vk)).collect())
  }
}

impl Drop for ButtonsUp {
  fn drop(&mut self) {
    let ups: Vec<INPUT> = self.0.iter().filter(|&&(vk, _)| is_down(vk)).map(|&(_, up)| mouse(0, 0, 0, up)).collect();
    if !ups.is_empty() {
      send(&ups);
      pump_for(50);
    }
  }
}

type Seen<T> = Rc<RefCell<Vec<T>>>;

// ---- mouse ----------------------------------------------------------------------

/// W3.1: every kind, screen coordinates, wheel notches, and swallow per event.
#[test]
fn the_mouse_hook_reports_every_kind_where_it_happened_and_swallows_what_the_handler_says() {
  let _serial = serial();
  let _back = CursorBack::here();
  let _buttons_up = ButtonsUp::now();
  let seen: Seen<MouseEvent> = Rc::default();
  let swallow_moves = Rc::new(Cell::new(false));
  let (sink, swallow) = (seen.clone(), swallow_moves.clone());
  // Buttons and the wheel are always swallowed, so no window under the pointer gets them.
  let hook = MouseHook::install(move |event| {
    sink.borrow_mut().push(*event);
    event.kind != MouseEventKind::Move || swallow.get()
  })
  .expect("mouse hook");

  // Put the pointer on a known spot, and see the move reported there.
  let at = spot_near_cursor();
  send(&[move_to(at.0, at.1)]);
  assert!(pump_until(|| seen.borrow().iter().any(|e| e.kind == MouseEventKind::Move && near(e, at))), "the move to {at:?} was reported");
  assert!(pump_until(|| cursor() == at), "the move went on: the pointer is at {:?}", cursor());
  let at = cursor();
  seen.borrow_mut().clear();

  send(&[
    mouse(0, 0, 0, MOUSEEVENTF_LEFTDOWN),
    mouse(0, 0, 0, MOUSEEVENTF_LEFTUP),
    mouse(0, 0, 0, MOUSEEVENTF_RIGHTDOWN),
    mouse(0, 0, 0, MOUSEEVENTF_RIGHTUP),
    mouse(0, 0, 0, MOUSEEVENTF_MIDDLEDOWN),
    mouse(0, 0, 0, MOUSEEVENTF_MIDDLEUP),
    mouse(0, 0, 120, MOUSEEVENTF_WHEEL),
    mouse(0, 0, -240, MOUSEEVENTF_WHEEL),
    mouse(0, 0, 60, MOUSEEVENTF_WHEEL),
  ]);
  let presses = || seen.borrow().iter().filter(|e| e.kind != MouseEventKind::Move).copied().collect::<Vec<_>>();
  assert!(
    pump_until(|| presses().len() >= 9),
    "every press arrived: {:?} (the system drops a press of a button it already holds down; left down at the start: {})",
    seen.borrow(),
    !_buttons_up.0.iter().any(|&(vk, _)| vk == u32::from(VK_LBUTTON.0))
  );
  let presses = presses();
  let kinds: Vec<MouseEventKind> = presses.iter().map(|e| e.kind).collect();
  use MouseEventKind::*;
  assert_eq!(kinds, [LeftDown, LeftUp, RightDown, RightUp, MiddleDown, MiddleUp, Wheel, Wheel, Wheel]);
  let wheels: Vec<f64> = presses.iter().map(|e| e.wheel).collect();
  assert_eq!(wheels, [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, -2.0, 0.5], "wheel notches, positive away from the user");
  for event in &presses {
    assert!(near(event, at), "{event:?} happened at the pointer, {at:?}");
  }
  assert!(MouseEventKind::ALL.iter().all(|k| *k == Move || kinds.contains(k)));

  // A swallowed move does not move the pointer.
  swallow_moves.set(true);
  let target = (at.0 + 4, at.1 + 4);
  send(&[move_to(target.0, target.1)]);
  assert!(pump_until(|| seen.borrow().iter().any(|e| e.kind == Move && near(e, target))), "the swallowed move was reported");
  pump_for(50);
  assert_eq!(cursor(), at, "the swallowed move did not move the pointer");
  drop(hook);
}

/// W3.1: the modifier keys held, by the asynchronous key state, on a mouse event.
#[test]
fn a_mouse_event_carries_the_modifiers_held() {
  let _serial = serial();
  let _keys_up = KeysUp(&[LSHIFT]);
  let _back = CursorBack::here();
  let seen: Seen<MouseEvent> = Rc::default();
  let sink = seen.clone();
  // Every move is swallowed: the pointer stays where it is.
  let _hook = MouseHook::install(move |event| {
    sink.borrow_mut().push(*event);
    event.kind == MouseEventKind::Move
  })
  .expect("mouse hook");
  let at = spot_near_cursor();
  let (held, released) = ((at.0 + 3, at.1), (at.0 + 5, at.1));
  send(&[key_down_input(LSHIFT), move_to(held.0, held.1), key_up_input(LSHIFT), move_to(released.0, released.1)]);
  let find = |spot| seen.borrow().iter().find(|e| e.kind == MouseEventKind::Move && near(e, spot)).copied();
  assert!(pump_until(|| find(held).is_some() && find(released).is_some()), "both moves arrived: {:?}", seen.borrow());
  assert_ne!(find(held).unwrap().modifiers & modifier::SHIFT, 0, "Shift was held for the first move");
  assert_eq!(find(released).unwrap().modifiers & modifier::SHIFT, 0, "Shift was up for the second move");
}

/// W3.1: a hook dropped from inside its own handler unhooks safely and sees nothing more.
#[test]
fn the_mouse_hook_can_be_dropped_from_inside_its_handler() {
  let _serial = serial();
  let _back = CursorBack::here();
  let slot: Rc<RefCell<Option<MouseHook>>> = Rc::default();
  let calls = Rc::new(Cell::new(0u32));
  let (inner_slot, inner_calls) = (slot.clone(), calls.clone());
  let hook = MouseHook::install(move |_| {
    inner_calls.set(inner_calls.get() + 1);
    // Drops the hook whose procedure is running this handler.
    inner_slot.borrow_mut().take();
    true
  })
  .expect("mouse hook");
  *slot.borrow_mut() = Some(hook);
  let at = spot_near_cursor();
  send(&[move_to(at.0 + 2, at.1 + 2)]);
  assert!(pump_until(|| calls.get() >= 1));
  send(&[move_to(at.0 + 4, at.1 + 4)]);
  pump_for(100);
  assert_eq!(calls.get(), 1, "nothing arrived after the hook was dropped");
  assert!(slot.borrow().is_none());
  let again = MouseHook::install(|_| false).expect("the process's one place is free again");
  drop(again);
}

/// A panic in the handler is caught at the hook procedure, and the event is not swallowed.
#[test]
fn a_mouse_handler_that_panics_does_not_swallow_the_event() {
  let _serial = serial();
  let _back = CursorBack::here();
  let calls = Rc::new(Cell::new(0u32));
  let inner = calls.clone();
  let _hook = MouseHook::install(move |event| {
    if event.kind == MouseEventKind::Move {
      inner.set(inner.get() + 1);
      panic!("a handler that panics is caught at the hook procedure");
    }
    false
  })
  .expect("mouse hook");
  let at = spot_near_cursor();
  let target = (at.0 + 3, at.1 + 3);
  send(&[move_to(target.0, target.1)]);
  assert!(pump_until(|| calls.get() >= 1));
  assert!(pump_until(|| cursor() == target), "the move went on: the pointer is at {:?}, not {target:?}", cursor());
}

// ---- keyboard -------------------------------------------------------------------

/// W3.2: down, repeat and up, the DOM code, the raw code, no modifiers.
#[test]
fn the_keyboard_hook_reports_down_repeat_and_up_with_the_dom_and_raw_codes() {
  let _serial = serial();
  let _keys_up = KeysUp(&[F24]);
  let seen: Seen<KeyEvent> = Rc::default();
  let sink = seen.clone();
  let _hook = KeyboardHook::install(move |event| {
    if event.raw == F24 {
      sink.borrow_mut().push(*event);
    }
    false
  })
  .expect("keyboard hook");
  send(&[key_down_input(F24)]);
  assert!(pump_until(|| seen.borrow().len() == 1 && is_down(F24)), "the down went on to the system");
  send(&[key_down_input(F24)]);
  assert!(pump_until(|| seen.borrow().len() == 2));
  send(&[key_up_input(F24)]);
  assert!(pump_until(|| seen.borrow().len() == 3 && !is_down(F24)));
  let seen = seen.borrow();
  let kinds: Vec<KeyEventKind> = seen.iter().map(|e| e.kind).collect();
  assert_eq!(kinds, [KeyEventKind::Down, KeyEventKind::Repeat, KeyEventKind::Up]);
  for event in seen.iter() {
    assert_eq!(event.code, "F24");
    assert_eq!(event.raw, F24);
    assert_eq!(event.modifiers, 0);
  }
}

/// W3.2: swallow per event. A swallowed down never reaches the system, so the
/// next down of the same key is a down, not a repeat.
#[test]
fn a_swallowed_key_does_not_reach_the_system() {
  let _serial = serial();
  let _keys_up = KeysUp(&[F24]);
  let seen: Seen<KeyEvent> = Rc::default();
  let sink = seen.clone();
  let _hook = KeyboardHook::install(move |event| {
    if event.raw != F24 {
      return false;
    }
    sink.borrow_mut().push(*event);
    event.kind != KeyEventKind::Up
  })
  .expect("keyboard hook");
  send(&[key_down_input(F24)]);
  assert!(pump_until(|| seen.borrow().len() == 1));
  pump_for(30);
  assert!(!is_down(F24), "the swallowed down did not reach the system");
  send(&[key_down_input(F24)]);
  assert!(pump_until(|| seen.borrow().len() == 2));
  send(&[key_up_input(F24)]);
  assert!(pump_until(|| seen.borrow().len() == 3));
  let kinds: Vec<KeyEventKind> = seen.borrow().iter().map(|e| e.kind).collect();
  assert_eq!(kinds, [KeyEventKind::Down, KeyEventKind::Down, KeyEventKind::Up], "the key was never held, so no repeat");
}

/// `input-hooks.test.ts` "a handler returning true swallows per event: the swallowed press never
/// reaches the system, so the next press is a down again, not a repeat": the same hook swallows the
/// first press and lets the second through, and the system's key state says so after each.
#[test]
fn a_swallowed_press_never_reaches_the_system_and_the_same_hook_lets_the_next_one_through() {
  let _serial = serial();
  let _keys_up = KeysUp(&[F24]);
  let seen: Seen<KeyEvent> = Rc::default();
  let swallow = Rc::new(Cell::new(true));
  let (sink, deciding) = (seen.clone(), swallow.clone());
  let _hook = KeyboardHook::install(move |event| {
    if event.raw != F24 {
      return false;
    }
    sink.borrow_mut().push(*event);
    deciding.get() && event.kind != KeyEventKind::Up
  })
  .expect("keyboard hook");
  send(&[key_down_input(F24)]);
  assert!(pump_until(|| seen.borrow().len() == 1));
  pump_for(30);
  let down_after_swallowed = is_down(F24);
  // The same press, now let through: the system sees a first press, and the hook a down.
  swallow.set(false);
  send(&[key_down_input(F24)]);
  assert!(pump_until(|| seen.borrow().len() == 2 && is_down(F24)));
  let down_after_passed = is_down(F24);
  send(&[key_up_input(F24)]);
  assert!(pump_until(|| seen.borrow().len() == 3 && !is_down(F24)));
  assert_eq!((down_after_swallowed, down_after_passed), (false, true), "swallowed: up for the system; let through: down");
  let kinds: Vec<KeyEventKind> = seen.borrow().iter().map(|e| e.kind).collect();
  assert_eq!(kinds, [KeyEventKind::Down, KeyEventKind::Down, KeyEventKind::Up]);
  assert!(!is_down(F24));
}

/// W3.2: the modifiers after the event: a modifier's own down has its bit, its
/// own up has it clear, and other keys see what is held.
#[test]
fn key_events_carry_the_modifiers_after_the_event() {
  let _serial = serial();
  let _keys_up = KeysUp(&[F24, LSHIFT]);
  let seen: Seen<KeyEvent> = Rc::default();
  let swallow_shift = Rc::new(Cell::new(true));
  let (sink, swallow) = (seen.clone(), swallow_shift.clone());
  let _hook = KeyboardHook::install(move |event| {
    if event.raw != F24 && event.raw != LSHIFT {
      return false;
    }
    sink.borrow_mut().push(*event);
    event.raw == LSHIFT && swallow.get()
  })
  .expect("keyboard hook");

  // Swallowed, so the system never sees Shift: only the event itself says it is down.
  send(&[key_down_input(LSHIFT), key_up_input(LSHIFT)]);
  assert!(pump_until(|| seen.borrow().len() == 2));
  {
    let seen = seen.borrow();
    assert_eq!((seen[0].kind, seen[0].code, seen[0].modifiers), (KeyEventKind::Down, "ShiftLeft", modifier::SHIFT));
    assert_eq!((seen[1].kind, seen[1].code, seen[1].modifiers), (KeyEventKind::Up, "ShiftLeft", 0));
  }
  seen.borrow_mut().clear();

  // Shift held for real around F24.
  swallow_shift.set(false);
  send(&[key_down_input(LSHIFT), key_down_input(F24), key_up_input(F24), key_up_input(LSHIFT)]);
  assert!(pump_until(|| seen.borrow().len() == 4), "{:?}", seen.borrow());
  let seen = seen.borrow();
  let got: Vec<(&str, KeyEventKind, u32)> = seen.iter().map(|e| (e.code, e.kind, e.modifiers)).collect();
  assert_eq!(
    got,
    [
      ("ShiftLeft", KeyEventKind::Down, modifier::SHIFT),
      ("F24", KeyEventKind::Down, modifier::SHIFT),
      ("F24", KeyEventKind::Up, modifier::SHIFT),
      ("ShiftLeft", KeyEventKind::Up, 0),
    ]
  );
}

/// W3.2: a key injected by scan code is named by it; an extended scan code
/// with no name is "Unidentified".
#[test]
fn keys_injected_by_scan_code_are_named_by_it() {
  let _serial = serial();
  let _keys_up = KeysUp(&[F24]);
  let seen: Seen<KeyEvent> = Rc::default();
  let sink = seen.clone();
  // E0 76 is no key; it is swallowed so nothing else sees it.
  let _hook = KeyboardHook::install(move |event| {
    if event.code == "F24" || event.code == "Unidentified" {
      sink.borrow_mut().push(*event);
    }
    event.code == "Unidentified"
  })
  .expect("keyboard hook");
  send(&[key(0, 0x76, KEYEVENTF_SCANCODE), key(0, 0x76, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP)]);
  assert!(pump_until(|| seen.borrow().len() >= 2));
  let extended = KEYEVENTF_SCANCODE | KEYEVENTF_EXTENDEDKEY;
  send(&[key(0, 0x76, extended), key(0, 0x76, extended | KEYEVENTF_KEYUP)]);
  assert!(pump_until(|| seen.borrow().len() >= 4));
  let seen = seen.borrow();
  assert_eq!((seen[0].code, seen[0].kind, seen[0].raw), ("F24", KeyEventKind::Down, F24));
  assert_eq!((seen[1].code, seen[1].kind, seen[1].raw), ("F24", KeyEventKind::Up, F24));
  assert_eq!((seen[2].code, seen[2].kind), ("Unidentified", KeyEventKind::Down));
  assert_eq!((seen[3].code, seen[3].kind), ("Unidentified", KeyEventKind::Up));
}

#[test]
fn the_keyboard_hook_can_be_dropped_from_inside_its_handler() {
  let _serial = serial();
  let _keys_up = KeysUp(&[F24]);
  let slot: Rc<RefCell<Option<KeyboardHook>>> = Rc::default();
  let calls = Rc::new(Cell::new(0u32));
  let (inner_slot, inner_calls) = (slot.clone(), calls.clone());
  let hook = KeyboardHook::install(move |event| {
    if event.raw == F24 {
      inner_calls.set(inner_calls.get() + 1);
      inner_slot.borrow_mut().take();
    }
    false
  })
  .expect("keyboard hook");
  *slot.borrow_mut() = Some(hook);
  send(&[key_down_input(F24)]);
  assert!(pump_until(|| calls.get() >= 1));
  send(&[key_up_input(F24)]);
  pump_for(100);
  assert_eq!(calls.get(), 1, "the up was not delivered after the hook was dropped");
  assert!(slot.borrow().is_none());
  drop(KeyboardHook::install(|_| false).expect("the process's one place is free again"));
}

#[test]
fn a_keyboard_handler_that_panics_does_not_swallow_the_key() {
  let _serial = serial();
  let _keys_up = KeysUp(&[F24]);
  let calls = Rc::new(Cell::new(0u32));
  let inner = calls.clone();
  let _hook = KeyboardHook::install(move |event| {
    if event.raw == F24 && event.kind == KeyEventKind::Down {
      inner.set(inner.get() + 1);
      panic!("a handler that panics is caught at the hook procedure");
    }
    false
  })
  .expect("keyboard hook");
  send(&[key_down_input(F24)]);
  assert!(pump_until(|| calls.get() >= 1));
  assert!(pump_until(|| is_down(F24)), "the down went on to the system");
}

// ---- lifecycle -------------------------------------------------------------------

/// C++ fork, `unit_tests.cc`: "Mouse hook: install once, remove once" and
/// "Keyboard hook: install once, remove once". The null-handler and
/// remove-without-a-hook cases have no Rust form: a closure cannot be null and
/// removing takes the hook.
#[test]
fn one_hook_of_each_kind_per_process() {
  let _serial = serial();
  let mouse = MouseHook::install(|_| false).expect("mouse hook");
  let second = MouseHook::install(|_| false).err().expect("a second mouse hook is refused");
  assert_eq!(second, HookError::AlreadyInstalled);
  assert_eq!(second.code(), 1, "WEBVIEW_ERROR_DUPLICATE");
  let elsewhere = std::thread::spawn(|| MouseHook::install(|_| false).err()).join().expect("thread");
  assert_eq!(elsewhere, Some(HookError::AlreadyInstalled), "one per process, not per thread");
  assert_eq!(mouse.remove(), Ok(()));
  drop(MouseHook::install(|_| false).expect("installs again after removal"));

  let keys = KeyboardHook::install(|_| false).expect("keyboard hook");
  assert_eq!(KeyboardHook::install(|_| false).err(), Some(HookError::AlreadyInstalled));
  let elsewhere = std::thread::spawn(|| KeyboardHook::install(|_| false).err()).join().expect("thread");
  assert_eq!(elsewhere, Some(HookError::AlreadyInstalled));
  assert_eq!(keys.remove(), Ok(()));
  drop(KeyboardHook::install(|_| false).expect("installs again after removal"));
}

/// C++ fork, `unit_tests.cc`: "Mouse and keyboard hooks: either order, either removed first".
#[test]
fn mouse_and_keyboard_hooks_either_order_either_removed_first() {
  let _serial = serial();
  let mouse = MouseHook::install(|_| false).expect("mouse hook");
  let keys = KeyboardHook::install(|_| false).expect("keyboard hook");
  // Removing the mouse hook leaves the keyboard hook installed.
  drop(mouse);
  assert_eq!(KeyboardHook::install(|_| false).err(), Some(HookError::AlreadyInstalled));
  // And the other way round, keyboard first.
  let mouse = MouseHook::install(|_| false).expect("mouse hook");
  drop(keys);
  assert_eq!(MouseHook::install(|_| false).err(), Some(HookError::AlreadyInstalled));
  drop(mouse);
  drop(KeyboardHook::install(|_| false).expect("the keyboard hook was removed"));
}

/// Installing and dropping both hooks, by drop and by `remove`, gives back
/// every USER object, GDI object and kernel handle: each count returns to its
/// starting value, read once it has stopped moving.
#[test]
fn installing_and_dropping_returns_every_handle() {
  let _serial = serial();
  // One round first, so one-time costs (lazily loaded modules) are paid.
  drop((MouseHook::install(|_| false), KeyboardHook::install(|_| false)));
  let before = sweetview_platform_loop::testing::settled_counts();
  for round in 0..200 {
    let mouse = MouseHook::install(|_| false).expect("mouse hook");
    let keys = KeyboardHook::install(|_| false).expect("keyboard hook");
    if round % 2 == 0 {
      drop((mouse, keys));
    } else {
      assert_eq!(mouse.remove(), Ok(()));
      assert_eq!(keys.remove(), Ok(()));
    }
  }
  let after = sweetview_platform_loop::testing::settled_counts();
  eprintln!("(USER, GDI, kernel) before {before:?}, after 200 rounds {after:?}");
  assert_eq!(after, before, "every count returned to its starting value");
}
