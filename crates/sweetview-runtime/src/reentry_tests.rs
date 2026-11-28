//! Callbacks that remove, replace or dispose their own owner from inside their own call, where
//! the runtime holds the owner (checklist item W1.4): what the W1.4 tests of `callbacks.test.ts`
//! proved through the binding, with closures where JavaScript functions were. What is decided in
//! TypeScript (a forgotten deferred job, a cancelled timeout's flag, a `Window`'s own handler
//! sets, the tabs library's callbacks, dispose hooks, `onOpenUrl`) stays proven there.

use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};

use sweetview_platform_window::test_support as os;
use sweetview_platform_window::BorrowedWindow;

use crate::menu::MenuItem;
use crate::menu_tray_os_tests::{pump_until, when_menu_opens};
use crate::runtime::testing::on_ui_thread;
use crate::tray::{Tray, TrayInit};
use crate::window::tab_frame::TabFrame;
use crate::window::{Refiner, Window, WindowInit};
use crate::Rect;

const WM_CLOSE: u32 = 0x0010;
const WM_ACTIVATE: u32 = 0x0006;
const WM_USER_TRAYICON: u32 = 6002;
const WM_LBUTTONDOWN: isize = 0x0201;
const WM_LBUTTONUP: isize = 0x0202;
const WM_RBUTTONDOWN: isize = 0x0204;
const WM_RBUTTONUP: isize = 0x0205;
const VK_DOWN: u16 = 0x28;
const VK_RETURN: u16 = 0x0d;
const VK_ESCAPE: u16 = 0x1b;
const F24: u16 = 0x87;

fn alive(handle: isize) -> bool {
  BorrowedWindow::with_handle_value(handle, |_| ()).is_some()
}

fn offscreen(title: &str) -> WindowInit {
  WindowInit {
    title: title.into(),
    frame: false,
    no_activate: true,
    hide_from_taskbar: true,
    bounds: Some(Rect::new(-3000, -3000, 300, 200)),
    ..Default::default()
  }
}

/// A slot a callback reaches its own owner through, filled once the owner exists.
type Slot<T> = Rc<RefCell<Weak<T>>>;

fn slot<T>() -> Slot<T> {
  Rc::new(RefCell::new(Weak::new()))
}

fn owner_of<T>(slot: &Slot<T>) -> Option<Rc<T>> {
  slot.borrow().upgrade()
}

/// "W1.4 an onClose / onFileDrop / onResize handler disposes its window from inside its own call".
#[test]
fn a_close_drop_or_resize_listener_disposes_its_window_from_inside_its_own_call() {
  on_ui_thread(|runtime| {
    for via in ["close", "drop", "resize"] {
      let window = Rc::new(Window::create(offscreen(&format!("rt reentry dispose from {via}"))).expect("window"));
      let handle = window.handle();
      let calls = Rc::new(Cell::new(0u32));
      let (count, me) = (calls.clone(), Rc::downgrade(&window));
      let dispose = move || {
        count.set(count.get() + 1);
        if let Some(window) = me.upgrade() {
          window.dispose();
        }
      };
      match via {
        "close" => {
          window.on_close_request(Some(Rc::new(dispose))).expect("close");
          os::send(handle, WM_CLOSE, 0, 0);
        }
        "drop" => {
          window.on_file_drop(Some(Rc::new(move |_| dispose()))).expect("drop");
          os::send_file_drop(handle, &[r"C:\example\one.txt"]);
        }
        _ => {
          window.on_resize(Some(Rc::new(move |_| dispose()))).expect("resize");
          window.set_bounds(Rect::new(-3000, -3000, 333, 200));
        }
      }
      pump_until(&runtime, 50, || false);
      assert_eq!(calls.get(), 1, "{via}");
      assert!(!alive(handle), "{via}: the window is gone");
      // Calls on the disposed window do nothing.
      window.set_bounds(Rect::new(-3000, -3000, 300, 200));
      assert!(!window.is_visible(), "{via}");
    }
  });
}

/// "W1.4 the binding's onActivate listener removes itself, and another replaces itself, from inside
/// its own call" and "W1.4 an onActivate listener disposes its window from inside its own call".
#[test]
fn a_tab_frames_activation_listener_removes_replaces_or_disposes_from_inside_its_own_call() {
  on_ui_thread(|runtime| {
    let window = Window::create(WindowInit { tab_strip_height: Some(40), ..offscreen("rt reentry activate") }).expect("tabbed");
    let handle = window.handle();
    let activate = |on: bool| os::send(handle, WM_ACTIVATE, usize::from(on), 0);
    let calls: Rc<RefCell<Vec<String>>> = Rc::default();
    let tab = Rc::new(TabFrame::of(handle).expect("a tab frame"));
    // Removes itself on its first call.
    let (sink, me) = (calls.clone(), Rc::downgrade(&tab));
    tab.on_activate(Some(Rc::new(move |active| {
      sink.borrow_mut().push(format!("once {active}"));
      if let Some(tab) = me.upgrade() {
        tab.on_activate(None);
      }
    })));
    activate(true);
    activate(false);
    assert_eq!(*calls.borrow(), ["once true"]);
    // Replaces itself; the replacement is called from the next call on (the default procedure may
    // report the same state again, which the replacement then gets first).
    let (sink, me) = (calls.clone(), Rc::downgrade(&tab));
    tab.on_activate(Some(Rc::new(move |active| {
      sink.borrow_mut().push(format!("A {active}"));
      let again = sink.clone();
      if let Some(tab) = me.upgrade() {
        tab.on_activate(Some(Rc::new(move |active| again.borrow_mut().push(format!("B {active}")))));
      }
    })));
    activate(true);
    activate(false);
    activate(true);
    let seen = calls.borrow().clone();
    assert_eq!(seen[..2], ["once true", "A true"]);
    assert_eq!(seen.iter().filter(|c| c.starts_with('A')).count(), 1);
    let mut replacement: Vec<&String> = seen[2..].iter().collect();
    replacement.dedup();
    assert!(replacement.iter().all(|c| c.starts_with("B ")), "{replacement:?}");
    assert_eq!(replacement[replacement.len() - 2..], [&"B false".to_owned(), &"B true".to_owned()]);
    assert!(tab.is_live());
    window.dispose();

    // Disposes its window.
    let window = Rc::new(Window::create(WindowInit { tab_strip_height: Some(40), ..offscreen("rt reentry activate disposes") }).expect("tabbed"));
    let handle = window.handle();
    let tab = TabFrame::of(handle).expect("a tab frame");
    let count = Rc::new(Cell::new(0u32));
    let (counted, me) = (count.clone(), Rc::downgrade(&window));
    tab.on_activate(Some(Rc::new(move |_| {
      counted.set(counted.get() + 1);
      if let Some(window) = me.upgrade() {
        window.dispose();
      }
    })));
    os::send(handle, WM_ACTIVATE, 1, 0);
    pump_until(&runtime, 50, || false);
    assert_eq!(count.get(), 1);
    assert!(!alive(handle) && !tab.is_live() && TabFrame::of(handle).is_none(), "the window and its frame are gone");
    os::send(handle, WM_ACTIVATE, 0, 0);
    assert_eq!(count.get(), 1, "nothing is called again");
  });
}

/// "W1.4 a refiner replaces itself from inside its own call, and the replacement is asked instead"
/// and "W1.4 a refiner disposes its window from inside its own call, and nothing is asked
/// afterwards", with the real cursor.
#[test]
fn a_hit_region_refiner_replaces_itself_or_disposes_its_window_from_inside_its_own_call() {
  on_ui_thread(|runtime| {
    let saved = os::cursor();
    let bounds = Rect::new(280, 260, 300, 200);
    let left_half = || vec![4, 0, 0, 150, 200, 0, 0, 150, 0, 150, 200, 0, 200];
    let at = |x: i32, y: i32| os::set_cursor(bounds.x + x, bounds.y + y);
    for attempt in 0..5 {
      if !os::buttons_down() {
        break;
      }
      assert!(attempt < 4, "refused to judge: a mouse button is held on the shared desktop, which freezes the poll; run again");
      pump_until(&runtime, 250, || false);
    }
    let make = |what: &str| {
      let window = Rc::new(Window::create(WindowInit { topmost: true, bounds: Some(bounds), ..offscreen(what) }).expect("window"));
      window.show().expect("show");
      window
    };

    // Replaces itself.
    let window = make("rt reentry refiner replaces");
    let asked: Rc<RefCell<Vec<&'static str>>> = Rc::default();
    at(250, 50);
    pump_until(&runtime, 60, || false);
    let (sink, me) = (asked.clone(), Rc::downgrade(&window));
    let original: Refiner = Rc::new(move |_x, _y, seq| {
      sink.borrow_mut().push("original");
      let Some(window) = me.upgrade() else { return };
      window.answer_hit(seq, true);
      let (sink, me) = (sink.clone(), me.clone());
      let replacement: Refiner = Rc::new(move |_x, _y, seq| {
        sink.borrow_mut().push("replacement");
        if let Some(window) = me.upgrade() {
          window.answer_hit(seq, true);
        }
      });
      window.set_hit_regions(Some(left_half()), Some(replacement)).expect("replaced");
    });
    window.set_hit_regions(Some(left_half()), Some(original)).expect("regions");
    at(40, 40);
    pump_until(&runtime, 2000, || !asked.borrow().is_empty());
    at(60, 70);
    pump_until(&runtime, 2000, || asked.borrow().len() >= 2);
    at(70, 80);
    pump_until(&runtime, 2000, || asked.borrow().len() >= 3);
    assert_eq!(*asked.borrow(), ["original", "replacement", "replacement"]);
    window.dispose();

    // Disposes its window.
    let window = make("rt reentry refiner disposes");
    let handle = window.handle();
    at(250, 50);
    pump_until(&runtime, 60, || false);
    let count = Rc::new(Cell::new(0u32));
    let (counted, me) = (count.clone(), Rc::downgrade(&window));
    window
      .set_hit_regions(
        Some(left_half()),
        Some(Rc::new(move |_x, _y, _seq| {
          counted.set(counted.get() + 1);
          if let Some(window) = me.upgrade() {
            window.dispose();
          }
        })),
      )
      .expect("regions");
    at(40, 40);
    pump_until(&runtime, 2000, || count.get() >= 1);
    at(60, 70);
    pump_until(&runtime, 100, || false);
    os::set_cursor(saved.0, saved.1);
    assert_eq!(count.get(), 1, "nothing is asked after the dispose");
    assert!(!alive(handle));
  });
}

fn tray_init(tooltip: &str) -> TrayInit {
  TrayInit { tooltip: tooltip.into(), icon: None, has_menu: false, on_click: None, on_double_click: None, open_menu: Rc::new(Vec::new), menu_chosen: Rc::new(|_| {}) }
}

fn post_tray(handle: isize, messages: &[isize]) {
  for &message in messages {
    assert!(os::post(handle, WM_USER_TRAYICON, 0, message), "posted to the tray's window");
  }
}

/// "W1.4 a click handler disposes the tray from inside its own call", "W1.4 a menu function disposes
/// the tray from inside its own call" (no menu opens) and "W1.4 a menu item's click disposes the
/// tray from inside the binding's call".
#[test]
fn a_trays_click_menu_function_or_chosen_item_disposes_the_tray_from_inside_its_own_call() {
  on_ui_thread(|runtime| {
    let tooltip = |what: &str| format!("sweetview-rt reentry {what} {}", std::process::id());

    // The click handler.
    let me: Slot<Tray> = slot();
    let clicks = Rc::new(Cell::new(0u32));
    let (count, owner) = (clicks.clone(), me.clone());
    let tray = Rc::new(
      Tray::new(TrayInit {
        on_click: Some(Rc::new(move || {
          count.set(count.get() + 1);
          if let Some(tray) = owner_of(&owner) {
            tray.dispose();
          }
        })),
        ..tray_init(&tooltip("click"))
      })
      .expect("tray"),
    );
    *me.borrow_mut() = Rc::downgrade(&tray);
    let handle = tray.window_handle_value();
    post_tray(handle, &[WM_LBUTTONDOWN, WM_LBUTTONUP]);
    let wait = u64::from(sweetview_platform_window::double_click_time_ms()) + 2000;
    pump_until(&runtime, wait, || clicks.get() == 1);
    pump_until(&runtime, 100, || false);
    assert_eq!(clicks.get(), 1);
    assert!(!alive(handle) && tray.window_handle_value() == 0, "the tray is gone");

    // The menu function: the menu it returns after disposing is not shown.
    let me: Slot<Tray> = slot();
    let opened = Rc::new(Cell::new(0u32));
    let (count, owner) = (opened.clone(), me.clone());
    let tray = Rc::new(
      Tray::new(TrayInit {
        has_menu: true,
        open_menu: Rc::new(move || {
          count.set(count.get() + 1);
          if let Some(tray) = owner_of(&owner) {
            tray.dispose();
          }
          vec![MenuItem::Item { id: 1, label: "After dispose".into(), enabled: true, checked: false, icon: None }]
        }),
        ..tray_init(&tooltip("menu function"))
      })
      .expect("tray"),
    );
    *me.borrow_mut() = Rc::downgrade(&tray);
    let handle = tray.window_handle_value();
    // Should a menu open anyway, it is dismissed, and the assertion below fails.
    let menu_seen = Rc::new(Cell::new(false));
    let seen = menu_seen.clone();
    when_menu_opens(&runtime, move |menu_window| {
      seen.set(true);
      os::press_keys(menu_window, &[VK_ESCAPE]);
    });
    post_tray(handle, &[WM_RBUTTONDOWN, WM_RBUTTONUP]);
    pump_until(&runtime, 5000, || opened.get() == 1);
    pump_until(&runtime, 300, || false);
    assert_eq!(opened.get(), 1);
    assert!(!menu_seen.get() && os::open_popup_menu() == 0, "no menu opened for a disposed tray");
    assert!(!alive(handle));

    // The chosen item.
    let me: Slot<Tray> = slot();
    let chosen = Rc::new(Cell::new(0u32));
    let (count, owner) = (chosen.clone(), me.clone());
    let tray = Rc::new(
      Tray::new(TrayInit {
        has_menu: true,
        open_menu: Rc::new(|| vec![MenuItem::Item { id: 1, label: "Quit".into(), enabled: true, checked: false, icon: None }]),
        menu_chosen: Rc::new(move |_| {
          count.set(count.get() + 1);
          if let Some(tray) = owner_of(&owner) {
            tray.dispose();
          }
        }),
        ..tray_init(&tooltip("menu item"))
      })
      .expect("tray"),
    );
    *me.borrow_mut() = Rc::downgrade(&tray);
    let handle = tray.window_handle_value();
    when_menu_opens(&runtime, |menu_window| os::press_keys(menu_window, &[VK_DOWN, VK_RETURN]));
    post_tray(handle, &[WM_RBUTTONDOWN, WM_RBUTTONUP]);
    pump_until(&runtime, 5000, || chosen.get() == 1);
    pump_until(&runtime, 100, || false);
    assert_eq!(chosen.get(), 1);
    assert_eq!(os::open_popup_menu(), 0);
    assert!(!alive(handle));
  });
}

/// "W1.4 a keyboard hook disposes itself from inside its handler and is not called again", through
/// the runtime's hook slot, with real input (F24, swallowed by nothing: the hook lets it pass).
#[test]
fn a_keyboard_hook_removed_from_inside_its_handler_through_the_runtime_is_called_no_more() {
  use crate::input::{install_keyboard_hook, remove_keyboard_hook};
  on_ui_thread(|runtime| {
    let calls = Rc::new(Cell::new(0u32));
    let count = calls.clone();
    assert_eq!(
      install_keyboard_hook(move |event| {
        if event.raw == u32::from(F24) {
          count.set(count.get() + 1);
          assert_eq!(remove_keyboard_hook(), Ok(0), "removed from inside its own call");
        }
        false
      }),
      Ok(0)
    );
    let tap = |up: bool| {
      let sender = std::thread::spawn(move || os::send_key(F24, up));
      while !sender.is_finished() {
        runtime.pump();
      }
      assert!(sender.join().expect("the sending thread"));
    };
    tap(false);
    pump_until(&runtime, 3000, || calls.get() > 0);
    tap(true);
    pump_until(&runtime, 150, || false);
    assert_eq!(calls.get(), 1, "the up was not delivered after the hook was removed");
    assert_eq!(remove_keyboard_hook(), Ok(2), "nothing left to remove");
    // The process's one place is free again.
    assert_eq!(install_keyboard_hook(|_| false), Ok(0));
    assert_eq!(remove_keyboard_hook(), Ok(0));
  });
}
