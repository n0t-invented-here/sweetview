use std::cell::RefCell;
use std::sync::PoisonError;

use windows::core::w;
use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW};

use super::*;
use sweetview_window_logic::style::{WS_EX_ACCEPTFILES, WS_EX_APPWINDOW, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT};

/// A plain hidden top-level window of this thread, destroyed on drop: what an
/// application hands to `Window.fromHandle`. The other test modules of this
/// crate use it too.
pub(crate) struct TestWindow(pub(crate) HWND);

impl TestWindow {
  pub(crate) fn new() -> Self {
    // SAFETY: the class is the system's STATIC class, a system-global class that needs no
    // module handle, and every string is static; no parent or creation data is passed.
    let hwnd = unsafe {
      CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), w!("sweetview platform-window test"), WS_OVERLAPPEDWINDOW, 40, 40, 300, 200, None, None, None, None)
    }
    .expect("CreateWindowExW");
    Self(hwnd)
  }

  /// The window, lent for as long as this value is borrowed: it is destroyed only in its `Drop`.
  pub(crate) fn foreign(&self) -> BorrowedWindow<'_> {
    BorrowedWindow { hwnd: self.0, _window: PhantomData, _not_send: PhantomData }
  }

  pub(crate) fn send(&self, message: u32, wparam: usize) -> LRESULT {
    // SAFETY: a plain message with integer parameters to this test's own window.
    unsafe { SendMessageW(self.0, message, Some(WPARAM(wparam)), Some(LPARAM(0))) }
  }

  fn set_ex_style(&self, style: u32) {
    set_style_of(self.0, GWL_EXSTYLE, style as isize);
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
fn a_handle_value_is_lent_only_when_it_names_a_window() {
  let _serial = serial();
  assert!(BorrowedWindow::with_handle_value(0, |_| ()).is_none());
  assert!(BorrowedWindow::with_handle_value(1, |_| ()).is_none());
  let window = TestWindow::new();
  let value = window.0 .0 as isize;
  let lent = BorrowedWindow::with_handle_value(value, |borrowed| {
    assert_eq!(handle_value(borrowed), value);
    assert!(is_on_this_thread(borrowed));
    assert!(is_window(borrowed));
    let raw = borrowed.window_handle().expect("a handle").as_raw();
    assert!(matches!(raw, RawWindowHandle::Win32(h) if h.hwnd.get() == value));
    // Destroyed by code the call runs: the OS refuses the handle from then on.
    // SAFETY: the test's own window, destroyed on this thread; `TestWindow`'s later drop fails harmlessly.
    unsafe { DestroyWindow(window.0) }.expect("DestroyWindow");
    assert!(!is_window(borrowed));
    assert!(matches!(borrowed.window_handle(), Err(HandleError::Unavailable)));
    assert!(outer_bounds(borrowed).is_none(), "the OS validates the handle on each call");
  });
  assert_eq!(lent, Some(()));
  assert!(BorrowedWindow::with_handle_value(value, |_| ()).is_none(), "a value that names no window is not lent");
}

thread_local! {
  /// What ran, in order, in the order test below: the application's own subclass and the listener.
  static RAN: RefCell<Vec<&'static str>> = const { RefCell::new(Vec::new()) };
}

/// The application's own subclass of its window, installed before Sweetview's, so it runs after
/// Sweetview's forwards the message: it notes each `WM_SIZE` and `WM_MOVE`.
extern "system" fn application_subclass(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
  if message == WM_SIZE || message == WM_MOVE {
    RAN.with(|ran| ran.borrow_mut().push("procedure"));
  }
  forward(hwnd, message, wparam, lparam)
}

/// Round 4, P4: with `set_listen_first`, size and move events reach the listener before the
/// window's own procedure, as the tag's subclass of a window it did not make did; without, after.
#[test]
fn size_and_move_reach_the_listener_before_the_windows_own_procedure_when_listening_first() {
  let _serial = serial();
  for listen_first in [false, true] {
    let window = TestWindow::new();
    // SAFETY: the procedure is a safe `extern "system"` function of this module with the
    // signature the call takes; the window is this thread's own, and the subclass is removed below.
    assert!(unsafe { SetWindowSubclass(window.0, Some(application_subclass), 0x7e57, 0) }.as_bool());
    let subclass = WindowSubclass::install(&window.foreign(), |event| {
      if matches!(event, WindowEvent::Resized(_) | WindowEvent::Moved { .. }) {
        RAN.with(|ran| ran.borrow_mut().push("listener"));
      }
      false
    })
    .expect("subclass");
    subclass.set_listen_first(listen_first);
    RAN.with(|ran| ran.borrow_mut().clear());
    assert!(set_placement(&window.foreign(), Placement::bounds(Rect::new(60, 70, 320, 240), false)));
    let ran = RAN.with(|ran| ran.borrow().clone());
    let pair = if listen_first { ["listener", "procedure"] } else { ["procedure", "listener"] };
    assert_eq!(ran, [pair, pair].concat(), "listening first: {listen_first}");
    drop(subclass);
    // SAFETY: removes the subclass installed above, from this thread's own window.
    let _removed = unsafe { RemoveWindowSubclass(window.0, Some(application_subclass), 0x7e57) };
  }
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

  assert!(set_placement(&window.foreign(), Placement::bounds(Rect::new(60, 70, 320, 240), false)));
  assert_eq!(outer_bounds(&window.foreign()), Some(Rect::new(60, 70, 320, 240)));
  {
    let seen = seen.borrow();
    assert!(seen.contains(&WindowEvent::Resized(Rect::new(60, 70, 320, 240))), "{seen:?}");
    assert!(seen.contains(&WindowEvent::Moved { bounds: Rect::new(60, 70, 320, 240), minimized: false }), "{seen:?}");
  }

  // A taken close request leaves the window open; one not taken reaches the window's own procedure.
  window.send(WM_CLOSE, 0);
  assert!(is_window(&window.foreign()));
  take_close.set(false);
  seen.borrow_mut().clear();
  // STATIC's default procedure destroys the window on WM_CLOSE: the subclass sees it go.
  window.send(WM_CLOSE, 0);
  assert_eq!(seen.borrow().as_slice(), &[WindowEvent::CloseRequested, WindowEvent::Destroyed]);
  assert!(!is_window(&window.foreign()));
  drop(subclass);
}

/// After its window is gone, a `WindowSubclass` does nothing with the handle
/// value it was installed on, which may name another window by then: not the
/// next window's state, not its subclass, not its styles.
#[test]
fn a_subclass_whose_window_is_gone_leaves_a_later_window_alone() {
  let _serial = serial();
  // The real sequence: the window goes first, then its subclass's methods and drop do nothing.
  let first = TestWindow::new();
  let stale = WindowSubclass::install(&first.foreign(), |_| false).expect("subclass");
  drop(first);
  assert!(stale.state.gone.get(), "WM_NCDESTROY marked the subclass gone");
  stale.set_policy(ExStylePolicy { tool_window: true, ..Default::default() });
  stale.force_style(WS_CLIPCHILDREN_FOR_TEST);
  drop(stale);

  // The handle value given to a later window, which the OS does: a subclass of the
  // earlier window, gone, holding the same value as the later window's live subclass.
  let later = TestWindow::new();
  let later_events = Rc::new(Cell::new(0u32));
  let sink = later_events.clone();
  let current = WindowSubclass::install(&later.foreign(), move |_| {
    sink.set(sink.get() + 1);
    false
  })
  .expect("subclass");
  let earlier_state = Rc::new(SubclassState {
    handler: Rc::new(|_| false),
    policy: Cell::new(ExStylePolicy::default()),
    fill_child: Cell::new(false),
    hold_visibility: Cell::new(false),
    listen_first: Cell::new(false),
    forced_style: Cell::new(0),
    gone: Cell::new(true),
  });
  let earlier = WindowSubclass { hwnd: later.0, state: earlier_state, _not_send: PhantomData };
  let (style_before, ex_before) = (style(&later.foreign()), ex_style(&later.foreign()));
  earlier.set_policy(ExStylePolicy { tool_window: true, click_through: Some(true), ..Default::default() });
  earlier.force_style(WS_CLIPCHILDREN_FOR_TEST);
  assert_eq!((style(&later.foreign()), ex_style(&later.foreign())), (style_before, ex_before), "no style written to the later window");
  drop(earlier);
  assert!(state_of(later.0).is_some_and(|known| Rc::ptr_eq(&known, &current.state)), "the later window's state is kept");
  // The later window's subclass is still installed and delivering.
  later_events.set(0);
  assert!(set_placement(&later.foreign(), Placement::bounds(Rect::new(50, 60, 310, 210), false)));
  assert!(later_events.get() > 0, "the later window's events still arrive");
  drop(current);
}

const WS_CLIPCHILDREN_FOR_TEST: u32 = 0x0200_0000;

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
    BorrowedWindow::with_handle_value(value, |foreign| (is_on_this_thread(foreign), WindowSubclass::install(foreign, |_| false).err()))
      .expect("a live window")
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
  set_placement(&foreign, Placement::bounds(Rect::new(0, 0, 100, 100), false));
  snapshot.restore(&foreign);
  assert_eq!(GeometrySnapshot::take(&foreign), snapshot);
}

#[test]
fn owning_types_give_every_handle_back() {
  let _serial = serial();
  let ico = test_ico();
  sweetview_platform_loop::testing::assert_gives_back_every_handle(100, || {
    let window = TestWindow::new();
    let subclass = WindowSubclass::install(&window.foreign(), |_| true).expect("subclass");
    let first = WindowIcons::set(&window.foreign(), Some(&ico)).expect("icons");
    let second = WindowIcons::set(&window.foreign(), Some(&ico)).expect("icons");
    drop(first);
    let _stock = WindowIcons::set(&window.foreign(), None).expect("stock icons");
    drop(second);
    drop(subclass);
  });
}

/// Icons a window still shows survive the drop of their `WindowIcons` (an
/// adopted window that is released): the window goes on showing icons
/// `GetIconInfo` accepts. Once the window is gone they are destroyed at the
/// next icon change, so the loop gives every handle back.
#[test]
fn icons_a_live_window_shows_outlive_their_owner_and_go_with_the_window() {
  let _serial = serial();
  let ico = test_ico();
  let window = TestWindow::new();
  let icons = WindowIcons::set(&window.foreign(), Some(&ico)).expect("icons");
  assert!(crate::test_support::shows_valid_icons(&window.foreign()));
  drop(icons);
  assert!(crate::test_support::shows_valid_icons(&window.foreign()), "the released window's icons are still valid");
  // Replaced by other icons: the parked ones are no longer shown and go at the next change.
  let replaced = WindowIcons::set(&window.foreign(), Some(&ico)).expect("new icons");
  assert!(crate::test_support::shows_valid_icons(&window.foreign()));
  drop(replaced);
  drop(window);

  sweetview_platform_loop::testing::assert_gives_back_every_handle(100, || {
    let window = TestWindow::new();
    drop(WindowIcons::set(&window.foreign(), Some(&ico)).expect("icons"));
    assert!(crate::test_support::shows_valid_icons(&window.foreign()));
    drop(window);
    // The next change destroys the icons of the window that is gone.
    let other = TestWindow::new();
    drop(WindowIcons::set(&other.foreign(), None).expect("stock icons"));
  });
}

/// A parked window of another thread that stops answering does not hold up a later
/// `WindowIcons::set`, and its icons stay parked until it is gone (the review's G5).
#[test]
fn a_parked_window_that_does_not_answer_keeps_its_icons_and_holds_up_nothing() {
  use std::sync::mpsc;
  use std::time::{Duration, Instant};
  use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, PeekMessageW, MSG, PM_REMOVE};
  let _serial = serial();
  let ico = test_ico();
  let (orders, order) = mpsc::channel::<&'static str>();
  let (made, window_value) = mpsc::channel::<isize>();
  let other = std::thread::spawn(move || {
    let window = TestWindow::new();
    made.send(window.0 .0 as isize).expect("the test waits for the window");
    let pump = || {
      let mut message = MSG::default();
      // SAFETY: `message` is a MSG owned by this frame for the call to fill; this thread's queue.
      while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
        // SAFETY: a message the OS just took off this thread's queue.
        unsafe { DispatchMessageW(&message) };
      }
    };
    loop {
      pump();
      match order.try_recv() {
        Ok("hang") => std::thread::sleep(Duration::from_millis(1500)),
        Ok(_) => break,
        Err(_) => std::thread::sleep(Duration::from_millis(1)),
      }
    }
    drop(window);
  });
  let value = window_value.recv().expect("the other thread's window");
  let theirs = BorrowedWindow { hwnd: HWND(value as *mut c_void), _window: PhantomData, _not_send: PhantomData };
  drop(WindowIcons::set(&theirs, Some(&ico)).expect("icons"));
  let parked = || PARKED.with(|list| list.borrow().iter().any(|icons| icons.window == value));
  assert!(parked(), "the other thread's window shows them, so they are parked");

  orders.send("hang").expect("the other thread is pumping");
  std::thread::sleep(Duration::from_millis(50));
  let mine = TestWindow::new();
  let started = Instant::now();
  drop(WindowIcons::set(&mine.foreign(), Some(&ico)).expect("icons of this thread's window"));
  let took = started.elapsed();
  assert!(took < Duration::from_millis(1000), "setIcon waited {took:?} for a window that did not answer");
  assert!(parked(), "a window that did not answer keeps its icons parked");

  orders.send("end").expect("the other thread");
  other.join().expect("the other thread");
  drop(WindowIcons::set(&mine.foreign(), None).expect("stock icons"));
  assert!(!parked(), "the icons went with their window");
}

/// Many parked windows that do not answer hold up a `WindowIcons::set` by no more than one sweep's
/// budget in all, not by each window's limit in turn; the ones not asked in time keep their icons
/// parked (the third review's H8).
#[test]
fn a_sweep_of_many_parked_windows_that_do_not_answer_stays_within_its_budget() {
  use std::sync::mpsc;
  use std::time::{Duration, Instant};
  use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, PeekMessageW, MSG, PM_REMOVE};
  const WINDOWS: usize = 6;
  let _serial = serial();
  let ico = test_ico();
  let (orders, order) = mpsc::channel::<&'static str>();
  let (made, window_values) = mpsc::channel::<Vec<isize>>();
  let other = std::thread::spawn(move || {
    let windows: Vec<TestWindow> = (0..WINDOWS).map(|_| TestWindow::new()).collect();
    made.send(windows.iter().map(|window| window.0 .0 as isize).collect()).expect("the test waits for the windows");
    let pump = || {
      let mut message = MSG::default();
      // SAFETY: `message` is a MSG owned by this frame for the call to fill; this thread's queue.
      while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
        // SAFETY: a message the OS just took off this thread's queue.
        unsafe { DispatchMessageW(&message) };
      }
    };
    loop {
      pump();
      match order.try_recv() {
        Ok("hang") => std::thread::sleep(Duration::from_millis(2500)),
        Ok(_) => break,
        Err(_) => std::thread::sleep(Duration::from_millis(1)),
      }
    }
    drop(windows);
  });
  let values = window_values.recv().expect("the other thread's windows");
  for value in &values {
    let theirs = BorrowedWindow { hwnd: HWND(*value as *mut c_void), _window: PhantomData, _not_send: PhantomData };
    drop(WindowIcons::set(&theirs, Some(&ico)).expect("icons"));
  }
  let parked = || PARKED.with(|list| list.borrow().iter().filter(|icons| values.contains(&icons.window)).count());
  assert_eq!(parked(), WINDOWS, "every one of the other thread's windows shows its icons");

  orders.send("hang").expect("the other thread is pumping");
  std::thread::sleep(Duration::from_millis(50));
  let mine = TestWindow::new();
  let started = Instant::now();
  drop(WindowIcons::set(&mine.foreign(), Some(&ico)).expect("icons of this thread's window"));
  let took = started.elapsed();
  assert!(took < Duration::from_millis(400), "setIcon waited {took:?} for {WINDOWS} windows that did not answer");
  assert_eq!(parked(), WINDOWS, "windows that did not answer, or were not asked, keep their icons parked");

  orders.send("end").expect("the other thread");
  other.join().expect("the other thread");
  drop(WindowIcons::set(&mine.foreign(), None).expect("stock icons"));
  assert_eq!(parked(), 0, "the icons went with their windows");
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

/// A file drop as the shell hands one to a window: a movable global block
/// holding a `DROPFILES` header followed by the NUL-separated wide paths and a
/// final NUL. The window that receives it owns it and frees it with `DragFinish`.
fn shell_drop(paths: &[&str]) -> windows::Win32::Foundation::HGLOBAL {
  use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT};
  use windows::Win32::UI::Shell::DROPFILES;
  let text: Vec<u16> = paths.iter().flat_map(|path| path.encode_utf16().chain([0])).chain([0]).collect();
  let header = DROPFILES { pFiles: size_of::<DROPFILES>() as u32, fWide: true.into(), ..Default::default() };
  let bytes = size_of::<DROPFILES>() + text.len() * 2;
  // SAFETY: GlobalAlloc takes its flags and size by value and reads no memory of ours.
  let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes) }.expect("GlobalAlloc");
  // SAFETY: `memory` is the block just allocated, owned by this function until it is handed over.
  let base = unsafe { GlobalLock(memory) }.cast::<u8>();
  assert!(!base.is_null(), "GlobalLock");
  // SAFETY: the locked block is `bytes` long, at least a DROPFILES, which the `windows` crate lays
  // out; the write is unaligned-safe.
  unsafe { base.cast::<DROPFILES>().write_unaligned(header) };
  let after_header = base.wrapping_add(size_of::<DROPFILES>());
  // SAFETY: the block has exactly `text.len() * 2` bytes after the header (its size above), and
  // `text` is a separate Rust buffer, so the ranges do not overlap.
  unsafe { std::ptr::copy_nonoverlapping(text.as_ptr().cast::<u8>(), after_header, text.len() * 2) };
  // SAFETY: balances the GlobalLock above on the same, still allocated block.
  let _unlocked = unsafe { GlobalUnlock(memory) };
  memory
}

/// The drop a window receives is read and then finished exactly once, and
/// finishing it frees it: the owning type of `WM_DROPFILES`.
#[test]
fn a_shell_drop_is_read_and_freed_by_the_window() {
  use windows::Win32::System::Memory::GlobalSize;
  let _serial = serial();
  let window = TestWindow::new();
  let seen: Rc<RefCell<Vec<WindowEvent>>> = Rc::new(RefCell::new(Vec::new()));
  let sink = seen.clone();
  let subclass = WindowSubclass::install(&window.foreign(), move |event| {
    sink.borrow_mut().push(event.clone());
    false
  })
  .expect("subclass");
  subclass.set_policy(ExStylePolicy { accept_files: Some(true), ..Default::default() });
  let paths = [r"C:\sweetview test\one.txt", "C:\\sweetview test\\t\u{e9}st two.png"];
  sweetview_platform_loop::testing::assert_gives_back_every_handle(50, || {
    // SAFETY: GlobalSize takes a handle value by value and only reports on it, 0 for a value
    // that names no block; nothing of ours is read or written.
    let block_size = |block| unsafe { GlobalSize(block) };
    seen.borrow_mut().clear();
    let drop = shell_drop(&paths);
    assert!(block_size(drop) > 0, "the drop is a live block before the window gets it");
    window.send(WM_DROPFILES, drop.0 as usize);
    assert_eq!(seen.borrow().as_slice(), &[WindowEvent::FilesDropped(paths.iter().map(|p| (*p).to_owned()).collect())]);
    assert_eq!(block_size(drop), 0, "DragFinish freed the drop");
  });
  drop(subclass);
}
