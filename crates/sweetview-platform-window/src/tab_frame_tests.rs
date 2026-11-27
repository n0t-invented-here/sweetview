use std::cell::RefCell;
use std::rc::Rc;
use std::sync::PoisonError;

use windows::core::w;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
  CreateWindowExW, DestroyWindow, GetWindowLongPtrW, SetWindowLongPtrW, GWL_STYLE, WA_ACTIVE, WA_INACTIVE, WINDOW_EX_STYLE,
  WM_ACTIVATE, WS_OVERLAPPEDWINDOW,
};

use super::*;
use crate::{handle_counts, ForeignWindow, WindowEvent, WindowSubclass};

/// A plain hidden top-level window of this thread, destroyed on drop.
struct TestWindow(HWND);

impl TestWindow {
  fn new() -> Self {
    // SAFETY: a null module name asks for the handle of the process's own executable.
    let module = unsafe { GetModuleHandleW(None) }.expect("module handle");
    // SAFETY: the class is the system's STATIC class and every string is static.
    let hwnd = unsafe {
      CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), w!("sweetview tab-frame test"), WS_OVERLAPPEDWINDOW, 40, 40, 300, 200, None, None, Some(module.into()), None)
    }
    .expect("CreateWindowExW");
    Self(hwnd)
  }

  fn foreign(&self) -> ForeignWindow {
    ForeignWindow::from_handle_value(self.0 .0 as isize).expect("a live window")
  }

  fn style(&self) -> u32 {
    // SAFETY: reads the style of this test's own window.
    unsafe { GetWindowLongPtrW(self.0, GWL_STYLE) as u32 }
  }
}

impl Drop for TestWindow {
  fn drop(&mut self) {
    // SAFETY: the window was made by `new` on this thread and is destroyed only here.
    let _ = unsafe { DestroyWindow(self.0) };
  }
}

fn serial() -> std::sync::MutexGuard<'static, ()> {
  crate::TEST_SERIAL.lock().unwrap_or_else(PoisonError::into_inner)
}

#[test]
fn the_client_area_starts_at_its_origin_on_the_screen() {
  let _serial = serial();
  let window = TestWindow::new();
  let foreign = window.foreign();
  let client = client_rect(&foreign).expect("a client area");
  assert_eq!((client.x, client.y), (0, 0));
  assert!(client.width > 0 && client.height > 0);
  let outer = crate::outer_bounds(&foreign).expect("outer bounds");
  let origin = client_origin(&foreign).expect("an origin");
  // The client area sits inside the frame, below the caption.
  assert!(origin.x > outer.x && origin.y > outer.y);
  assert!(!is_foreground(&foreign), "a hidden window is never the foreground window");
  drop(window);
  assert_eq!(client_rect(&foreign), None);
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
    // SAFETY: a plain message with integer parameters to this test's own window.
    unsafe { SendMessageW(window.0, WM_ACTIVATE, Some(WPARAM(state as usize)), Some(LPARAM(0))) };
  }
  // The default procedure may report a state again (focus moves inside it); the order is what counts.
  let mut events = seen.borrow().clone();
  events.dedup();
  assert_eq!(events, vec![WindowEvent::Activated(true), WindowEvent::Activated(false)]);

  assert_eq!(window.style() & FRAME_STYLE, 0);
  subclass.force_style(FRAME_STYLE);
  assert_eq!(window.style() & FRAME_STYLE, FRAME_STYLE);
  // A later rewrite of the whole style, as `tao` makes, keeps the bit.
  // SAFETY: writes the style of this test's own window.
  unsafe { SetWindowLongPtrW(window.0, GWL_STYLE, WS_OVERLAPPEDWINDOW.0 as isize) };
  assert_eq!(window.style() & FRAME_STYLE, FRAME_STYLE);
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
  assert_eq!(after.user_objects, before.user_objects, "USER objects returned to the starting count");
  assert_eq!(after.gdi_objects, before.gdi_objects, "GDI objects returned to the starting count");
}

#[test]
fn the_system_theme_reads_without_failing() {
  // Either answer is right; the call must not panic or need a window.
  let _dark = system_is_dark();
}
