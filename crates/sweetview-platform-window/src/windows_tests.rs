use std::cell::RefCell;
use std::sync::PoisonError;

use windows::core::w;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW};

use super::*;
use sweetview_window_logic::style::{WS_EX_ACCEPTFILES, WS_EX_APPWINDOW, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT};

/// A plain hidden top-level window of this thread, destroyed on drop: what an
/// application hands to `Window.fromHandle`.
struct TestWindow(HWND);

impl TestWindow {
  fn new() -> Self {
    // SAFETY: a null module name asks for the handle of the process's own executable.
    let module = unsafe { GetModuleHandleW(None) }.expect("module handle");
    // SAFETY: the class is the system's STATIC class and every string is static.
    let hwnd = unsafe {
      CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), w!("sweetview platform-window test"), WS_OVERLAPPEDWINDOW, 40, 40, 300, 200, None, None, Some(module.into()), None)
    }
    .expect("CreateWindowExW");
    Self(hwnd)
  }

  fn foreign(&self) -> ForeignWindow {
    ForeignWindow::from_handle_value(self.0 .0 as isize).expect("a live window")
  }

  fn send(&self, message: u32, wparam: usize) -> LRESULT {
    // SAFETY: a plain message with integer parameters to this test's own window.
    unsafe { SendMessageW(self.0, message, Some(WPARAM(wparam)), Some(LPARAM(0))) }
  }

  fn set_ex_style(&self, style: u32) {
    // SAFETY: writes the extended style of this test's own window.
    unsafe { SetWindowLongPtrW(self.0, GWL_EXSTYLE, style as isize) };
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
fn a_handle_value_names_a_window_only_when_it_is_one() {
  let _serial = serial();
  assert!(ForeignWindow::from_handle_value(0).is_none());
  assert!(ForeignWindow::from_handle_value(1).is_none());
  let window = TestWindow::new();
  let foreign = window.foreign();
  assert_eq!(handle_value(&foreign), window.0 .0 as isize);
  assert!(is_on_this_thread(&foreign));
  assert!(is_window(&foreign));
  let raw = foreign.window_handle().expect("a handle").as_raw();
  assert!(matches!(raw, RawWindowHandle::Win32(h) if h.hwnd.get() == window.0 .0 as isize));
  drop(window);
  assert!(!is_window(&foreign));
  assert!(matches!(foreign.window_handle(), Err(HandleError::Unavailable)));
}

#[test]
fn the_subclass_delivers_bounds_close_and_destroy() {
  let _serial = serial();
  let window = TestWindow::new();
  let seen: Rc<RefCell<Vec<WindowEvent>>> = Rc::new(RefCell::new(Vec::new()));
  let take_close = Rc::new(Cell::new(true));
  let (sink, take) = (seen.clone(), take_close.clone());
  let subclass = WindowSubclass::install(&window.foreign(), move |event| {
    sink.borrow_mut().push(event.clone());
    matches!(event, WindowEvent::CloseRequested) && take.get()
  })
  .expect("subclass");
  assert!(WindowSubclass::install(&window.foreign(), |_| false).is_err(), "one subclass per window");

  assert!(set_outer_bounds(&window.foreign(), Rect::new(60, 70, 320, 240), false));
  assert_eq!(outer_bounds(&window.foreign()), Some(Rect::new(60, 70, 320, 240)));
  {
    let seen = seen.borrow();
    assert!(seen.contains(&WindowEvent::Resized(Rect::new(60, 70, 320, 240))), "{seen:?}");
    assert!(seen.contains(&WindowEvent::Moved(Rect::new(60, 70, 320, 240))), "{seen:?}");
  }

  // A taken close request leaves the window open; one not taken reaches the window's own procedure.
  window.send(WM_CLOSE, 0);
  assert!(is_window(&window.foreign()));
  take_close.set(false);
  seen.borrow_mut().clear();
  // STATIC's default procedure destroys the window on WM_CLOSE: the subclass sees it go.
  window.send(WM_CLOSE, 0);
  assert_eq!(seen.borrow().as_slice(), &[WindowEvent::CloseRequested, WindowEvent::Destroyed]);
  assert!(!is_window(&window.foreign_unchecked()));
  drop(subclass);
}

impl TestWindow {
  fn foreign_unchecked(&self) -> ForeignWindow {
    ForeignWindow { hwnd: self.0, _not_send: PhantomData }
  }
}

#[test]
fn the_style_policy_holds_whoever_changes_the_style() {
  let _serial = serial();
  let window = TestWindow::new();
  let foreign = window.foreign();
  let subclass = WindowSubclass::install(&foreign, |_| false).expect("subclass");
  subclass.set_policy(ExStylePolicy { tool_window: true, accept_files: Some(false), ..Default::default() });
  assert_eq!(ex_style(&foreign) & (WS_EX_TOOLWINDOW | WS_EX_APPWINDOW), WS_EX_TOOLWINDOW);
  // Someone else (here: `tao`'s style rewrite) asks for a taskbar button and files.
  window.set_ex_style(WS_EX_APPWINDOW | WS_EX_ACCEPTFILES);
  assert_eq!(ex_style(&foreign) & (WS_EX_TOOLWINDOW | WS_EX_APPWINDOW | WS_EX_ACCEPTFILES), WS_EX_TOOLWINDOW);

  subclass.set_policy(ExStylePolicy { click_through: Some(true), ..subclass.policy() });
  assert_eq!(ex_style(&foreign) & (WS_EX_TRANSPARENT | WS_EX_LAYERED), WS_EX_TRANSPARENT | WS_EX_LAYERED);
  window.set_ex_style(0);
  assert_eq!(ex_style(&foreign) & WS_EX_TRANSPARENT, WS_EX_TRANSPARENT);
  subclass.set_policy(ExStylePolicy { click_through: Some(false), ..subclass.policy() });
  assert_eq!(ex_style(&foreign) & (WS_EX_TRANSPARENT | WS_EX_LAYERED), 0);

  // Removed: the policy no longer applies.
  drop(subclass);
  window.set_ex_style(WS_EX_APPWINDOW);
  assert_eq!(ex_style(&foreign) & WS_EX_APPWINDOW, WS_EX_APPWINDOW);
}

#[test]
fn a_subclass_on_a_window_of_another_thread_is_refused() {
  let _serial = serial();
  let window = TestWindow::new();
  let value = window.0 .0 as isize;
  let refused = std::thread::spawn(move || {
    let foreign = ForeignWindow::from_handle_value(value).expect("a live window");
    (is_on_this_thread(&foreign), WindowSubclass::install(&foreign, |_| false).err())
  })
  .join()
  .expect("thread");
  assert_eq!(refused, (false, Some("sweetview: a window of another thread cannot be observed".into())));
}

#[test]
fn layered_attributes_chrome_and_geometry_restore() {
  let _serial = serial();
  let window = TestWindow::new();
  let foreign = window.foreign();
  apply_ex_style(&foreign, &ExStylePolicy { layered: true, ..Default::default() });
  set_layered_attributes(&foreign, Some(0x00ff00ff), Some(0.5)).expect("layered attributes");
  assert_eq!(chrome(&foreign), Chrome { frame: true, resizable: true });

  let snapshot = GeometrySnapshot::take(&foreign);
  window.set_ex_style(0);
  set_outer_bounds(&foreign, Rect::new(0, 0, 100, 100), false);
  snapshot.restore(&foreign);
  assert_eq!(GeometrySnapshot::take(&foreign), snapshot);
}

#[test]
fn owning_types_give_every_handle_back() {
  let _serial = serial();
  let ico = test_ico();
  // One round first, so one-time costs (classes, lazily loaded modules) are paid.
  {
    let window = TestWindow::new();
    let _subclass = WindowSubclass::install(&window.foreign(), |_| true).expect("subclass");
    let _icons = WindowIcons::set(&window.foreign(), Some(&ico)).expect("icons");
  }
  let before = handle_counts();
  for _ in 0..100 {
    let window = TestWindow::new();
    let subclass = WindowSubclass::install(&window.foreign(), |_| true).expect("subclass");
    let first = WindowIcons::set(&window.foreign(), Some(&ico)).expect("icons");
    let second = WindowIcons::set(&window.foreign(), Some(&ico)).expect("icons");
    drop(first);
    let _stock = WindowIcons::set(&window.foreign(), None).expect("stock icons");
    drop(second);
    drop(subclass);
  }
  let after = handle_counts();
  assert_eq!(after.user_objects, before.user_objects, "USER objects returned to the starting count");
  assert_eq!(after.gdi_objects, before.gdi_objects, "GDI objects returned to the starting count");
  assert!(after.kernel_handles <= before.kernel_handles + 2, "kernel handles returned to the starting count");
}

#[test]
fn a_bad_ico_is_an_error() {
  let _serial = serial();
  let window = TestWindow::new();
  assert_eq!(WindowIcons::set(&window.foreign(), Some(b"nope")).err(), Some("not a .ico file".into()));
}

/// A one-image 16x16 32bpp `.ico`, as `dotIco` writes one.
fn test_ico() -> Vec<u8> {
  let size = 16u32;
  let pixels = (size * size * 4) as usize;
  let mask = (size * size / 8) as usize;
  let image_len = 40 + pixels + mask;
  let mut out = vec![0, 0, 1, 0, 1, 0];
  out.extend([16, 16, 0, 0, 1, 0, 32, 0]);
  out.extend((image_len as u32).to_le_bytes());
  out.extend(22u32.to_le_bytes());
  out.extend(40u32.to_le_bytes());
  out.extend((size as i32).to_le_bytes());
  out.extend((size as i32 * 2).to_le_bytes());
  out.extend(1u16.to_le_bytes());
  out.extend(32u16.to_le_bytes());
  out.extend([0u8; 24]);
  for _ in 0..size * size {
    out.extend([0x40, 0x80, 0xff, 0xff]);
  }
  out.extend(std::iter::repeat_n(0u8, mask));
  out
}
