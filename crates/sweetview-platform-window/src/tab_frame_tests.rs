use std::cell::RefCell;
use std::rc::Rc;
use std::sync::PoisonError;

use windows::Win32::Graphics::Gdi::{CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, GetDC, GetPixel, ReleaseDC, SelectObject, HBITMAP, HGDIOBJ};
use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, GWL_STYLE, WA_ACTIVE, WA_INACTIVE, WM_ACTIVATE, WS_OVERLAPPEDWINDOW};

use super::*;
use crate::platform::tests::TestWindow;
use crate::platform::{client_size, dpi_of, set_style_of};
use crate::{handle_counts, outer_bounds, style, WindowEvent, WindowSubclass};

fn serial() -> std::sync::MutexGuard<'static, ()> {
  crate::TEST_SERIAL.lock().unwrap_or_else(PoisonError::into_inner)
}

#[test]
fn a_hidden_window_is_never_the_foreground_window() {
  let _serial = serial();
  let window = TestWindow::new();
  assert!(!is_foreground(&window.foreign()));
}

#[test]
fn the_subclass_reports_activation_and_keeps_forced_style_bits() {
  let _serial = serial();
  let window = TestWindow::new();
  let seen: Rc<RefCell<Vec<WindowEvent>>> = Rc::new(RefCell::new(Vec::new()));
  let sink = seen.clone();
  let subclass = WindowSubclass::install(&window.foreign(), move |event| {
    sink.borrow_mut().push(event.clone());
    false
  })
  .expect("subclass");
  for state in [WA_ACTIVE, WA_INACTIVE] {
    window.send(WM_ACTIVATE, state as usize);
  }
  // The default procedure may report a state again (focus moves inside it); the order is what counts.
  let mut events = seen.borrow().clone();
  events.dedup();
  assert_eq!(events, vec![WindowEvent::Activated(true), WindowEvent::Activated(false)]);

  assert_eq!(style(&window.foreign()) & FRAME_STYLE, 0);
  subclass.force_style(FRAME_STYLE);
  assert_eq!(style(&window.foreign()) & FRAME_STYLE, FRAME_STYLE);
  // A later rewrite of the whole style, as `tao` makes, keeps the bit.
  set_style_of(window.0, GWL_STYLE, WS_OVERLAPPEDWINDOW.0 as isize);
  assert_eq!(style(&window.foreign()) & FRAME_STYLE, FRAME_STYLE);
}

#[test]
fn popup_menus_give_every_handle_back() {
  let _serial = serial();
  let entries = [
    PopupEntry::Item { label: "New tab\tCtrl+T".into(), enabled: true },
    PopupEntry::Separator,
    PopupEntry::Item { label: "Fish & chips".into(), enabled: false },
  ];
  let build = || {
    let menu = OwnedMenu::new().expect("menu");
    for (index, entry) in entries.iter().enumerate() {
      menu.append(entry, index + 1).expect("append");
    }
    menu
  };
  drop(build());
  let before = handle_counts();
  for _ in 0..100 {
    drop(build());
  }
  let after = handle_counts();
  // `<=`: another test's thread may be exiting meanwhile, freeing objects of its own.
  assert!(after.user_objects <= before.user_objects, "USER objects returned to the starting count: {before:?} -> {after:?}");
  assert!(after.gdi_objects <= before.gdi_objects, "GDI objects returned to the starting count: {before:?} -> {after:?}");
}

#[test]
fn the_system_theme_reads_without_failing() {
  // Either answer is right; the call must not panic or need a window.
  let _dark = system_is_dark();
}

const LIGHT: Backdrop = Backdrop { strip_height: 40, strip: (0xe9, 0xea, 0xee), page: (0xf9, 0xf9, 0xfb) };
const DARK: Backdrop = Backdrop { strip_height: 40, strip: (0x29, 0x2a, 0x30), page: (0x15, 0x16, 0x1a) };

/// A colour as `GetPixel` answers it: red in the low byte.
fn colorref((red, green, blue): (u8, u8, u8)) -> u32 {
  u32::from(red) | (u32::from(green) << 8) | (u32::from(blue) << 16)
}

/// Has `window` erase its background into a bitmap of this test's own, as it
/// erases on the screen, and reads back a pixel in the strip (`strip_y`) and
/// one at the bottom of the client area.
fn erased_pixels(window: &TestWindow, strip_y: i32) -> (u32, u32) {
  let (width, height) = client_size(window.0).expect("client rect");
  // SAFETY: the screen's device context, released below.
  let screen = unsafe { GetDC(None) };
  // SAFETY: a memory device context compatible with the screen's, deleted below.
  let memory = unsafe { CreateCompatibleDC(Some(screen)) };
  // SAFETY: a bitmap the size of the client area, deleted below.
  let bitmap: HBITMAP = unsafe { CreateCompatibleBitmap(screen, width, height) };
  // SAFETY: selects this test's bitmap into its memory context; the previous object is put back below.
  let previous: HGDIOBJ = unsafe { SelectObject(memory, bitmap.into()) };
  // SAFETY: the message WM_ERASEBKGND with this test's own device context, to this test's own window.
  unsafe { SendMessageW(window.0, WM_ERASEBKGND, Some(WPARAM(memory.0 as usize)), Some(LPARAM(0))) };
  // SAFETY: reads a pixel of this test's own bitmap, selected into its own memory context.
  let pixel = |y| unsafe { GetPixel(memory, 4, y) }.0;
  let (strip, page) = (pixel(strip_y), pixel(height - 2));
  // SAFETY: puts back the object the context held.
  unsafe { SelectObject(memory, previous) };
  // SAFETY: the bitmap is no longer selected into any context.
  let _ = unsafe { DeleteObject(bitmap.into()) };
  // SAFETY: the memory context made above.
  let _ = unsafe { DeleteDC(memory) };
  // SAFETY: the screen's context taken above.
  unsafe { ReleaseDC(None, screen) };
  (strip, page)
}

#[test]
fn the_frame_paints_the_strip_and_the_page_in_their_own_colours() {
  let _serial = serial();
  let window = TestWindow::new();
  let scale = f64::from(dpi_of(window.0)) / 96.0;
  let strip_bottom = (40.0 * scale).round() as i32;
  let messages = FrameMessages::install(&window.foreign(), LIGHT).expect("frame messages");
  assert_eq!(erased_pixels(&window, strip_bottom - 2), (colorref(LIGHT.strip), colorref(LIGHT.page)), "light");
  messages.set_backdrop(DARK).expect("dark");
  assert_eq!(erased_pixels(&window, strip_bottom - 2), (colorref(DARK.strip), colorref(DARK.page)), "dark");
  // The first row below the strip is the page's.
  assert_eq!(erased_pixels(&window, strip_bottom).0, colorref(DARK.page));
  drop(messages);
  // Removed: the window's own procedure erases again (with its class brush, not the backdrop).
  assert_ne!(erased_pixels(&window, strip_bottom - 2).0, colorref(DARK.strip));
}

#[test]
fn a_dpi_change_applies_the_suggested_rectangle() {
  let _serial = serial();
  let window = TestWindow::new();
  let _messages = FrameMessages::install(&window.foreign(), LIGHT).expect("frame messages");
  let dpi = dpi_of(window.0);
  let suggested = RECT { left: 70, top: 90, right: 70 + 420, bottom: 90 + 330 };
  // The scale itself does not change (one monitor): the rectangle must still be taken.
  let wparam = WPARAM(((dpi << 16) | dpi) as usize);
  // SAFETY: WM_DPICHANGED with a RECT owned by this frame for the call, to this test's own window.
  unsafe { SendMessageW(window.0, WM_DPICHANGED, Some(wparam), Some(LPARAM(&suggested as *const RECT as isize))) };
  let mut now = RECT::default();
  // SAFETY: `now` is owned by this frame for the call to fill.
  unsafe { GetWindowRect(window.0, &mut now) }.expect("window rect");
  assert_eq!((now.left, now.top, now.right, now.bottom), (70, 90, 490, 420));
  assert_eq!(outer_bounds(&window.foreign()), Some(Rect::new(70, 90, 420, 330)));
}

#[test]
fn frame_messages_give_every_handle_back() {
  let _serial = serial();
  let window = TestWindow::new();
  // A first round of both backdrops: the system keeps a few solid brushes of its own once one is made.
  let first = FrameMessages::install(&window.foreign(), LIGHT).expect("frame messages");
  first.set_backdrop(DARK).expect("backdrop");
  drop(first);
  let before = handle_counts();
  for round in 0..100 {
    let messages = FrameMessages::install(&window.foreign(), LIGHT).expect("frame messages");
    messages.set_backdrop(if round % 2 == 0 { DARK } else { LIGHT }).expect("backdrop");
    drop(messages);
  }
  let after = handle_counts();
  // `<=`: another test's thread may be exiting meanwhile, freeing objects of its own.
  assert!(after.gdi_objects <= before.gdi_objects, "GDI objects returned to the starting count: {before:?} -> {after:?}");
  assert!(after.user_objects <= before.user_objects, "USER objects returned to the starting count: {before:?} -> {after:?}");
}

#[test]
fn a_destroyed_frame_forgets_its_messages_and_a_late_drop_is_harmless() {
  let _serial = serial();
  let window = TestWindow::new();
  let messages = FrameMessages::install(&window.foreign(), LIGHT).expect("frame messages");
  let hwnd = window.0;
  drop(window);
  assert!(frame_state(hwnd).is_none());
  assert!(messages.set_backdrop(DARK).is_ok());
  drop(messages);
}
