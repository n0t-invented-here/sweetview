//! Popup menus and the tray, read back from the OS and driven the way the shell and a person
//! would: what `tray-menu.test.ts` proved from Bun through `bun:ffi` probes. Most input is a
//! message posted to one of this process's own windows (a popup menu's, the tray icon's); one test
//! presses the right button over this process's own menu, two read the icon back from Explorer
//! (`tray-shell.ps1`, which clicks the overflow chevron only when the mouse is free).

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::{Duration, Instant};

use sweetview_platform_window::test_support::{self as os, MenuEntry};
use sweetview_platform_window::{self as platform, BorrowedWindow, PopupCorner};

use crate::icon::IconBytes;
use crate::menu::{self, MenuItem};
use crate::runtime::testing::on_ui_thread;
use crate::runtime::{Runtime, TimeoutId};
use crate::screen;
use crate::tray::{Tray, TrayInit};
use crate::window::{Window, WindowInit};
use crate::window::tab_frame::{PopupEntry, TabFrame};
use crate::Rect;

const VK_RETURN: u16 = 0x0d;
const VK_ESCAPE: u16 = 0x1b;
const VK_RIGHT: u16 = 0x27;
const VK_DOWN: u16 = 0x28;
/// The message `tray-icon` gives the shell for its icon's mouse events (its own constant).
const WM_USER_TRAYICON: u32 = 6002;
const WM_LBUTTONDOWN: isize = 0x0201;
const WM_LBUTTONUP: isize = 0x0202;
const WM_LBUTTONDBLCLK: isize = 0x0203;
const WM_RBUTTONDOWN: isize = 0x0204;
const WM_RBUTTONUP: isize = 0x0205;

pub(crate) fn pump_until(runtime: &Runtime, ms: u64, done: impl Fn() -> bool) -> bool {
  let deadline = Instant::now() + Duration::from_millis(ms);
  while !done() && Instant::now() < deadline {
    runtime.pump();
    std::thread::sleep(Duration::from_millis(5));
  }
  done()
}

/// A `.ico` of one solid colour at the given sizes, made with the `ico` crate.
fn solid_ico(rgba: [u8; 4], sizes: &[u32]) -> Vec<u8> {
  let mut dir = ico::IconDir::new(ico::ResourceType::Icon);
  for &size in sizes {
    let image = ico::IconImage::from_rgba_data(size, size, rgba.repeat((size * size) as usize));
    dir.add_entry(ico::IconDirEntry::encode(&image).expect("encode"));
  }
  let mut bytes = Vec::new();
  dir.write(&mut bytes).expect("write");
  bytes
}

fn icon(rgba: [u8; 4]) -> Option<IconBytes> {
  Some(IconBytes { ico: Some(solid_ico(rgba, &[16, 32])), ..Default::default() })
}

const RED: [u8; 4] = [255, 0, 0, 255];
const GREEN: [u8; 4] = [0, 255, 0, 255];

fn item(id: u32, label: &str) -> MenuItem {
  MenuItem::Item { id, label: label.into(), enabled: true, checked: false, icon: None }
}

/// Runs `step` from inside the popup menu's own modal loop once a popup menu of this process is
/// open, on a native interval (which the menu loop dispatches). A menu still open 3 s later is
/// closed, so a failing test never leaves one up.
pub(crate) fn when_menu_opens(runtime: &Rc<Runtime>, step: impl FnOnce(isize) + 'static) {
  let started = Instant::now();
  let step = RefCell::new(Some(step));
  let id: Rc<Cell<Option<TimeoutId>>> = Rc::default();
  let (own, inner) = (id.clone(), runtime.clone());
  let interval = runtime
    .set_interval(10, move || {
      let menu_window = os::open_popup_menu();
      let over = menu_window != 0 || started.elapsed() > Duration::from_secs(5);
      if !over {
        return;
      }
      if let Some(id) = own.take() {
        inner.clear_timeout(id);
      }
      if menu_window != 0 {
        inner
          .set_timeout(3000, || {
            if os::open_popup_menu() != 0 {
              platform::end_menu_for_tests();
            }
          })
          .expect("closer");
        if let Some(step) = step.borrow_mut().take() {
          step(menu_window);
        }
      }
    })
    .expect("watcher");
  id.set(Some(interval));
}

/// A rectangle as (left, top, right, bottom).
type Edges = (i32, i32, i32, i32);

/// The menu window's outer rectangle.
fn rect_of(window: isize) -> Edges {
  let r = BorrowedWindow::with_handle_value(window, |w| platform::outer_bounds(w)).flatten().expect("the menu's rectangle");
  (r.x, r.y, r.x + r.width, r.y + r.height)
}

fn labels(entries: &[MenuEntry]) -> Vec<String> {
  entries.iter().map(|e| e.label.clone()).collect()
}

// ---- popup menus -------------------------------------------------------------------------------------

/// "at a point: check marks, icons, submenus, separators and disabled items are on the real menu,
/// and the chosen item runs".
#[test]
fn a_popup_menu_at_a_point_shows_check_marks_icons_submenus_separators_and_disabled_items() {
  on_ui_thread(|runtime| {
    let owner = os::OwnWindow::new("rt os menu owner", (40, 40, 120, 80), |_| {}).expect("owner");
    let shown: Rc<RefCell<(Vec<MenuEntry>, Edges)>> = Rc::default();
    let seen = shown.clone();
    when_menu_opens(&runtime, move |menu_window| {
      *seen.borrow_mut() = (os::read_menu(os::menu_of_window(menu_window)), rect_of(menu_window));
      // The first Down selects the first item, the second the next; Return chooses it.
      os::press_keys(menu_window, &[VK_DOWN, VK_DOWN, VK_RETURN]);
    });
    let data = vec![
      MenuItem::Item { id: 1, label: "Fish & Chips".into(), enabled: true, checked: true, icon: None },
      MenuItem::Item { id: 2, label: "With icon".into(), enabled: true, checked: false, icon: icon(RED) },
      MenuItem::Separator,
      MenuItem::Submenu {
        label: "Sub".into(),
        enabled: true,
        icon: None,
        items: vec![
          MenuItem::Item { id: 3, label: "Child".into(), enabled: false, checked: false, icon: None },
          MenuItem::Item { id: 4, label: "Checked with icon".into(), enabled: true, checked: true, icon: icon(RED) },
        ],
      },
      MenuItem::Item { id: 5, label: "Off".into(), enabled: false, checked: false, icon: None },
    ];
    let chosen = menu::popup(owner.handle_value(), &data, Some((120.0, 140.0)), PopupCorner::TopLeft).expect("popup");
    assert_eq!(chosen, Some(2));
    let (entries, rect) = shown.borrow().clone();
    assert_eq!((rect.0, rect.1), (120, 140), "the menu's top-left corner is at the point");
    assert_eq!(labels(&entries), ["Fish && Chips", "With icon", "", "Sub", "Off"]);
    assert!(entries[0].checked && !entries[0].disabled && !entries[0].has_bitmap);
    assert!(!entries[1].checked && !entries[1].disabled && entries[1].has_bitmap);
    assert!(entries[2].separator);
    let sub = entries[3].submenu.clone().expect("a submenu");
    assert_eq!(labels(&sub), ["Child", "Checked with icon"]);
    assert!(sub[0].disabled);
    assert!(sub[1].checked && sub[1].has_bitmap && !sub[1].disabled);
    assert!(entries[4].disabled);
  });
}

/// As at the tag, and as before the change that gave the foreground back after every popup menu:
/// the owner of `Menu.popup`'s menu is made the foreground window to track it, and keeps it after
/// the menu closes, here dismissed, though another window was in front before (review of
/// `2a0b808`, F2).
#[test]
fn an_ordinary_owner_is_the_foreground_window_after_its_dismissed_menu() {
  on_ui_thread(|runtime| {
    let front = os::OwnWindow::new("rt os window in front", (40, 260, 160, 100), |_| {}).expect("front");
    let owner = os::OwnWindow::new("rt os ordinary owner", (240, 260, 160, 100), |_| {}).expect("owner");
    if !os::take_foreground(front.handle_value()) {
      panic!("not run: this desktop's foreground could not be given to the test's window");
    }
    when_menu_opens(&runtime, |menu_window| os::press_keys(menu_window, &[VK_ESCAPE]));
    let data = vec![item(1, "Open")];
    assert_eq!(menu::popup(owner.handle_value(), &data, Some((260.0, 280.0)), PopupCorner::TopLeft).expect("popup"), None);
    assert_eq!(os::foreground(), owner.handle_value(), "the owner holds the foreground after its menu");
  });
}

/// `Menu.popup` with a `noActivate` owner (review of `2a0b808`, F1 and F3; round 2, G2 to G4): the
/// overlay never holds the foreground, nor is it active, while its menu is open or after it, read
/// afresh inside each menu. A hidden stand-in, made once and released with the menus, owns the
/// menu. The window that was in front gets the foreground back at once when nothing is chosen; when
/// an item is chosen, the stand-in still holds it when the handler starts, and the earlier window
/// gets it after; a window the handler showed keeps it. When the earlier window is gone or can no
/// longer take it (minimised meanwhile), the foreground is neither the overlay's nor the stand-in's.
/// A second popup opened at once by a choice's handler keeps the window from before the first, and
/// nothing moves the foreground while it is open.
#[test]
fn a_no_activate_owner_never_takes_the_foreground_for_its_menu() {
  on_ui_thread(|runtime| {
    let bounds = Rect { x: 300, y: 300, width: 240, height: 160 };
    let overlay = Window::create(WindowInit { title: "rt os no-activate overlay".into(), bounds: Some(bounds), no_activate: true, topmost: true, ..Default::default() }).expect("overlay");
    overlay.show().expect("shown");
    let overlay_handle = overlay.handle();
    let data = vec![item(1, "Open"), item(2, "Close")];
    let popup = || menu::popup(overlay_handle, &data, Some((320.0, 320.0)), PopupCorner::TopLeft).expect("popup");
    let in_front = |window: isize| {
      if !os::take_foreground(window) {
        panic!("not run: this desktop's foreground could not be given to the test's window");
      }
    };
    // (foreground, active) read inside the open menu; (-1, -1) until a menu opened.
    let inside = Rc::new(Cell::new((-1isize, -1isize)));
    let open_then = |keys: &'static [u16]| {
      inside.set((-1, -1));
      let seen = inside.clone();
      when_menu_opens(&runtime, move |menu_window| {
        seen.set((os::foreground(), os::active()));
        os::press_keys(menu_window, keys);
      });
    };
    let overlay_was_left_alone = |case: &str| {
      let (foreground, active) = inside.get();
      assert!(foreground != -1, "{case}: the menu opened");
      assert!(foreground != overlay_handle && active != overlay_handle, "{case}: inside the menu the overlay is neither foreground nor active ({foreground}, {active})");
    };
    let front = os::OwnWindow::new("rt os window in front", (40, 260, 160, 100), |_| {}).expect("front");

    // Dismissed: the earlier window is in front again at once.
    in_front(front.handle_value());
    open_then(&[VK_ESCAPE]);
    assert_eq!(popup(), None);
    overlay_was_left_alone("dismissed");
    let stand_in = menu::stand_in_for_tests();
    assert!(stand_in != 0 && stand_in != overlay_handle, "a stand-in owned the menu");
    assert_eq!((os::foreground(), os::active() != overlay_handle), (front.handle_value(), true), "dismissed: the earlier window is in front");

    // Chosen, and the handler shows nothing: the stand-in holds the foreground when the handler
    // starts (here, when popup returns), and the earlier window has it once the loop turns.
    in_front(front.handle_value());
    open_then(&[VK_DOWN, VK_RETURN]);
    assert_eq!(popup(), Some(1));
    overlay_was_left_alone("chosen");
    assert_eq!(os::foreground(), stand_in, "chosen: not yet given back when the handler starts");
    pump_until(&runtime, 1000, || os::foreground() == front.handle_value());
    assert_eq!((os::foreground(), os::active() != overlay_handle), (front.handle_value(), true), "chosen: the earlier window is in front after the handler");

    // Chosen, and the handler shows a window of its own: that window keeps the foreground.
    let settings = os::OwnWindow::new("rt os window a handler shows", (40, 400, 160, 100), |_| {}).expect("settings");
    in_front(front.handle_value());
    open_then(&[VK_DOWN, VK_RETURN]);
    assert_eq!(popup(), Some(1));
    assert_eq!(os::foreground(), stand_in, "the handler starts with the stand-in in front");
    BorrowedWindow::with_handle_value(settings.handle_value(), |window| platform::show(window, false, false, false)); // the handler
    pump_until(&runtime, 300, || false);
    assert_eq!(os::foreground(), settings.handle_value(), "the window the handler showed is in front");

    // Chosen, and the handler opens a second popup at once (G3): while it is open nothing moves the
    // foreground (the first's deferred hand-back is stale), and after it the window from before the
    // first is in front.
    in_front(front.handle_value());
    open_then(&[VK_DOWN, VK_RETURN]);
    assert_eq!(popup(), Some(1));
    let during_second = Rc::new(Cell::new(-1isize));
    let (seen, timer_runtime) = (during_second.clone(), runtime.clone());
    when_menu_opens(&runtime, move |menu_window| {
      // Read after the loop has had its turns, inside the second menu.
      timer_runtime
        .set_timeout(300, move || {
          seen.set(os::foreground());
          os::press_keys(menu_window, &[VK_ESCAPE]);
        })
        .expect("a timeout inside the menu");
    });
    assert_eq!(popup(), None, "the second popup was dismissed");
    assert_eq!(during_second.get(), stand_in, "nothing gave the foreground away while the second popup was open");
    pump_until(&runtime, 300, || false);
    assert_eq!(os::foreground(), front.handle_value(), "after the second popup, the window from before the first is in front");

    // The earlier window destroyed while the menu was open, then one minimised meanwhile (it can no
    // longer take the foreground): the foreground is neither the overlay's nor the stand-in's.
    let doomed = Rc::new(RefCell::new(os::OwnWindow::new("rt os window destroyed", (40, 540, 160, 100), |_| {})));
    in_front(doomed.borrow().as_ref().expect("doomed").handle_value());
    let gone = doomed.clone();
    inside.set((-1, -1));
    let seen = inside.clone();
    when_menu_opens(&runtime, move |menu_window| {
      seen.set((os::foreground(), os::active()));
      drop(gone.borrow_mut().take());
      os::press_keys(menu_window, &[VK_ESCAPE]);
    });
    assert_eq!(popup(), None);
    overlay_was_left_alone("destroyed");
    pump_until(&runtime, 300, || false);
    let after = os::foreground();
    assert!(after != overlay_handle && after != stand_in && os::active() != overlay_handle, "destroyed: neither the overlay nor the stand-in holds the foreground ({after})");

    in_front(front.handle_value());
    let minimise = front.handle_value();
    inside.set((-1, -1));
    let seen = inside.clone();
    when_menu_opens(&runtime, move |menu_window| {
      seen.set((os::foreground(), os::active()));
      os::minimise(minimise);
      os::press_keys(menu_window, &[VK_ESCAPE]);
    });
    assert_eq!(popup(), None);
    overlay_was_left_alone("minimised");
    let after = os::foreground();
    assert!(after != overlay_handle && after != stand_in && after != front.handle_value(), "minimised: the foreground went to a window a person could use ({after})");

    // Made once, and released with the menus at the end of the application.
    assert_eq!(menu::stand_in_for_tests(), stand_in, "one stand-in for every menu");
    menu::release_all();
    assert_eq!(menu::stand_in_for_tests(), 0, "released with the menus");
    // A dropped tao window posts its own destruction, done when the loop next dispatches.
    pump_until(&runtime, 2000, || BorrowedWindow::with_handle_value(stand_in, |_| ()).is_none());
    assert!(BorrowedWindow::with_handle_value(stand_in, |_| ()).is_none(), "its window is gone once the loop has turned");
    overlay.dispose();
  });
}

/// The tab menu goes the one popup way (the fold, D26; round 2, G4): `TabFrame::show_menu` itself
/// shows its entries, a separator and a disabled item among them (a lone `&` shown as itself), with
/// the menu's top-left corner at the cursor, and returns the zero-based index of the item chosen.
#[test]
fn a_tab_frames_menu_shows_its_entries_at_the_cursor_and_returns_the_chosen_index() {
  on_ui_thread(|runtime| {
    let frame = Window::create(WindowInit { title: "rt os tab menu".into(), bounds: Some(Rect { x: 200, y: 200, width: 480, height: 320 }), tab_strip_height: Some(40), ..Default::default() }).expect("a frame");
    frame.show().expect("shown");
    let tabs = TabFrame::of(frame.handle()).expect("a tab frame");
    if !os::set_cursor(400, 300) {
      panic!("not run: the cursor could not be put where the test reads the menu");
    }
    let shown: Rc<RefCell<(Vec<MenuEntry>, Edges)>> = Rc::default();
    let seen = shown.clone();
    when_menu_opens(&runtime, move |menu_window| {
      *seen.borrow_mut() = (os::read_menu(os::menu_of_window(menu_window)), rect_of(menu_window));
      // The keyboard stops on the first item, on the disabled one, then on "Close tab".
      os::press_keys(menu_window, &[VK_DOWN, VK_DOWN, VK_DOWN, VK_RETURN]);
    });
    let entries = vec![
      PopupEntry::Item { label: "New tab\tCtrl+T".into(), enabled: true },
      PopupEntry::Separator,
      PopupEntry::Item { label: "Fish & chips".into(), enabled: false },
      PopupEntry::Item { label: "Close tab".into(), enabled: true },
    ];
    assert_eq!(tabs.show_menu(&entries).expect("the menu"), Some(3), "the zero-based index of the item chosen");
    let (read, rect) = shown.borrow().clone();
    assert_eq!(labels(&read), ["New tab\tCtrl+T", "", "Fish && chips", "Close tab"]);
    assert!(read[1].separator && read[2].disabled && !read[0].disabled && !read[3].disabled, "a separator and a disabled item: {read:?}");
    assert_eq!((rect.0, rect.1), (400, 300), "the menu's top-left corner at the cursor");
    frame.dispose();
  });
}

/// "an item in a submenu is chosen; a dismissed menu chooses nothing".
#[test]
fn an_item_in_a_submenu_is_chosen_and_a_dismissed_menu_chooses_nothing() {
  on_ui_thread(|runtime| {
    let owner = os::OwnWindow::new("rt os menu owner", (40, 40, 120, 80), |_| {}).expect("owner");
    let data = vec![item(1, "Open"), MenuItem::Submenu { label: "More".into(), enabled: true, icon: None, items: vec![item(2, "Deep")] }];
    when_menu_opens(&runtime, |menu_window| os::press_keys(menu_window, &[VK_DOWN, VK_DOWN, VK_RIGHT, VK_RETURN]));
    assert_eq!(menu::popup(owner.handle_value(), &data, Some((200.0, 200.0)), PopupCorner::TopLeft).expect("popup"), Some(2));
    when_menu_opens(&runtime, |menu_window| os::press_keys(menu_window, &[VK_ESCAPE]));
    assert_eq!(menu::popup(owner.handle_value(), &data, Some((200.0, 200.0)), PopupCorner::TopLeft).expect("popup"), None);
    assert_eq!(os::open_popup_menu(), 0);
    // An empty menu shows nothing, and an owner that is no window neither.
    assert_eq!(menu::popup(owner.handle_value(), &[], None, PopupCorner::TopLeft).expect("empty"), None);
    assert_eq!(menu::popup(1, &data, None, PopupCorner::TopLeft).expect("no owner"), None);
  });
}

/// "at the cursor when no point is given", "popupMenuAtCursor opens the menu above the cursor (its
/// bottom-left corner there), where a menu at a point opens below it", and "Menu.popup with
/// { above: true } puts the menu's bottom-left corner at the point; without the option, its top-left".
#[test]
fn a_menu_opens_at_the_cursor_or_a_point_below_it_or_above_it() {
  on_ui_thread(|runtime| {
    let owner = os::OwnWindow::new("rt os menu owner", (40, 40, 120, 80), |_| {}).expect("owner");
    let saved = os::cursor();
    let area = screen::primary().expect("primary").work_area;
    // The middle of the work area: room above and below, so the OS moves no menu.
    let point = (area.x + area.width / 2, area.y + area.height / 2);
    let data = vec![item(1, "One"), item(2, "Two"), item(3, "Three")];
    let placed = |at: Option<(f64, f64)>, corner: PopupCorner| {
      let read: Rc<Cell<(Edges, (i32, i32))>> = Rc::default();
      let sink = read.clone();
      when_menu_opens(&runtime, move |menu_window| {
        sink.set((rect_of(menu_window), os::cursor()));
        os::press_keys(menu_window, &[VK_ESCAPE]);
      });
      assert_eq!(menu::popup(owner.handle_value(), &data, at, corner).expect("popup"), None);
      read.get()
    };
    // At the cursor: opening above it, as the tray's menu and `popupMenuAtCursor` do, and below it,
    // as `Menu.popup` with no point does.
    let at_cursor = |corner: PopupCorner| {
      for _ in 0..5 {
        os::set_cursor(point.0, point.1);
        let (rect, cursor) = placed(None, corner);
        if cursor == point {
          return Some(rect);
        }
        pump_until(&runtime, 400, || false);
      }
      None
    };
    let (above, below) = (at_cursor(PopupCorner::BottomLeft), at_cursor(PopupCorner::TopLeft));
    os::set_cursor(saved.0, saved.1);
    let refused = || panic!("refused to judge: the cursor was moved on the shared desktop while the menu opened; run again");
    let (above, below) = (above.unwrap_or_else(refused), below.unwrap_or_else(refused));
    assert_eq!((above.0, above.3), point, "its bottom-left corner at the cursor");
    assert!(above.1 < point.1);
    assert_eq!((below.0, below.1), point, "with no point and no corner asked: its top-left corner at the cursor");
    assert!(below.3 > point.1);
    // At a point: above with the bottom-left corner, below with the top-left.
    let above = placed(Some((f64::from(point.0), f64::from(point.1))), PopupCorner::BottomLeft);
    assert_eq!((above.0 .0, above.0 .3), point);
    assert!(above.0 .1 < point.1);
    let below = placed(Some((f64::from(point.0), f64::from(point.1))), PopupCorner::TopLeft);
    assert_eq!((below.0 .0, below.0 .1), point);
    assert!(below.0 .3 > point.1);
  });
}

/// "letting go of the right button over an item chooses it (real input over the menu's own window)".
#[test]
fn letting_go_of_the_right_button_over_an_item_chooses_it() {
  on_ui_thread(|runtime| {
    let owner = os::OwnWindow::new("rt os menu owner", (40, 40, 120, 80), |_| {}).expect("owner");
    let saved = os::cursor();
    let area = screen::primary().expect("primary").work_area;
    let data = vec![item(1, "One"), item(2, "Two"), item(3, "Three")];
    let pressed = Rc::new(Cell::new(false));
    let mut result = None;
    for _ in 0..5 {
      let skipped: Rc<RefCell<Option<String>>> = Rc::default();
      let (skip, held, inner) = (skipped.clone(), pressed.clone(), runtime.clone());
      when_menu_opens(&runtime, move |menu_window| {
        // The second item's middle, on this process's own menu window, read from the OS.
        let Some((left, top, right, bottom)) = os::menu_item_rect(os::menu_of_window(menu_window), 1) else {
          *skip.borrow_mut() = Some("the item's rectangle could not be read".into());
          platform::end_menu_for_tests();
          return;
        };
        let target = ((left + right) / 2, (top + bottom) / 2);
        if os::buttons_down() {
          *skip.borrow_mut() = Some("a mouse button was already down on the shared desktop".into());
        } else {
          os::move_cursor_as_input(target.0, target.1);
          if os::window_at(target.0, target.1) != menu_window {
            *skip.borrow_mut() = Some("another window is over the menu on the shared desktop".into());
          }
        }
        if skip.borrow().is_some() {
          platform::end_menu_for_tests();
          return;
        }
        // A watchdog inside the menu's loop lets go of the button whatever happens.
        let watch = held.clone();
        inner
          .set_timeout(1500, move || {
            if watch.replace(false) {
              os::send_right_button(false);
            }
          })
          .expect("watchdog");
        held.set(true);
        os::send_right_button(true);
        if os::send_right_button(false) {
          held.set(false);
        }
      });
      let chosen = menu::popup(owner.handle_value(), &data, Some((f64::from(area.x + 80), f64::from(area.y + 80))), PopupCorner::TopLeft).expect("popup");
      if skipped.borrow().is_none() {
        result = Some(chosen);
        break;
      }
      pump_until(&runtime, 400, || false);
    }
    if pressed.get() {
      os::send_right_button(false);
    }
    os::set_cursor(saved.0, saved.1);
    let chosen = result.unwrap_or_else(|| panic!("refused to judge: the shared desktop's mouse was never free for the right-button choice; run again"));
    assert_eq!(chosen, Some(2), "with TPM_RIGHTBUTTON the release over an item chooses it");
  });
}

/// "buildMenu hands the application a menu for its own TrackPopupMenu: ids count from 1 in template
/// order, a key chooses, destroyMenu frees it" (the menu as the OS holds it; the template's ids and
/// clicks are `win32/menu.ts`'s).
#[test]
fn a_handed_out_menu_is_the_applications_to_track_and_its_destruction_gives_everything_back() {
  on_ui_thread(|runtime| {
    let owner = os::OwnWindow::new("rt os menu owner", (40, 40, 120, 80), |_| {}).expect("owner");
    let data = vec![
      item(1, "A & B"),
      MenuItem::Submenu {
        label: "Sub".into(),
        enabled: true,
        icon: None,
        items: vec![item(2, "B"), MenuItem::Item { id: 3, label: "C".into(), enabled: true, checked: true, icon: icon(RED) }],
      },
      MenuItem::Separator,
      MenuItem::Item { id: 4, label: "D".into(), enabled: false, checked: false, icon: None },
    ];
    let handle = menu::build_handed_out(&data).expect("built");
    assert!(os::is_menu(handle));
    let shown = os::read_menu(handle);
    assert_eq!(labels(&shown), ["A && B", "Sub", "", "D"]);
    let sub_entry = shown[1].submenu.clone().expect("a submenu")[1].clone();
    assert_eq!((sub_entry.label.as_str(), sub_entry.checked, sub_entry.has_bitmap), ("C", true, true));
    assert!(shown[3].disabled);
    let sub = os::sub_menu(handle, 1);
    assert_eq!([os::menu_item_id(handle, 0), os::menu_item_id(sub, 0), os::menu_item_id(sub, 1), os::menu_item_id(handle, 3)], [1, 2, 3, 4]);
    // The application tracks it itself; Down, Down, Right, Down, Return chooses "C" in the submenu.
    when_menu_opens(&runtime, |menu_window| os::press_keys(menu_window, &[VK_DOWN, VK_DOWN, VK_RIGHT, VK_DOWN, VK_RETURN]));
    assert_eq!(os::track_menu(handle, 150, 150, owner.handle_value()), 3);
    assert!(menu::destroy_handed_out(handle));
    assert!(!os::is_menu(handle) && !os::is_menu(sub), "the menu and its submenu are gone");
    assert!(!menu::destroy_handed_out(handle), "twice is safe");
    // Building and freeing gives every handle back, the item bitmaps included.
    sweetview_platform_loop::testing::assert_gives_back_every_handle(30, || {
      assert!(menu::destroy_handed_out(menu::build_handed_out(&data).expect("built")));
    });
  });
}

// ---- the tray -------------------------------------------------------------------------------------

fn tray_init(tooltip: &str) -> TrayInit {
  TrayInit {
    tooltip: tooltip.into(),
    icon: None,
    has_menu: false,
    on_click: None,
    on_double_click: None,
    open_menu: Rc::new(Vec::new),
    menu_chosen: Rc::new(|_| {}),
  }
}

fn unique(what: &str) -> String {
  static SERIAL: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
  format!("sweetview-rt {what} {}-{}", std::process::id(), SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

fn post_tray(tray: &Tray, messages: &[isize]) {
  for &message in messages {
    assert!(os::post(tray.window_handle_value(), WM_USER_TRAYICON, 0, message), "posted to the tray's window");
  }
}

/// "making and disposing trays and their menus returns every GDI and USER object".
#[test]
fn making_and_disposing_trays_and_opening_their_menus_gives_every_handle_back() {
  on_ui_thread(|runtime| {
    let round = || {
      let opened = Rc::new(Cell::new(0u32));
      let count = opened.clone();
      let tray = Tray::new(TrayInit {
        icon: icon(RED),
        has_menu: true,
        open_menu: Rc::new(move || {
          count.set(count.get() + 1);
          vec![
            MenuItem::Item { id: 1, label: "One".into(), enabled: true, checked: false, icon: icon(RED) },
            MenuItem::Item { id: 2, label: "Two".into(), enabled: true, checked: true, icon: icon(RED) },
          ]
        }),
        ..tray_init(&unique("tray handles"))
      })
      .expect("tray");
      when_menu_opens(&runtime, |menu_window| os::press_keys(menu_window, &[VK_ESCAPE]));
      post_tray(&tray, &[WM_RBUTTONUP]);
      pump_until(&runtime, 5000, || opened.get() == 1 && os::open_popup_menu() == 0);
      assert_eq!(opened.get(), 1);
      tray.dispose();
    };
    const ROUNDS: usize = 10;
    let growth = sweetview_platform_loop::testing::smallest_growth(ROUNDS, round);
    // Every USER and GDI object comes back. The runtime's timers (the menu watcher's closer) are
    // posted ticks, no USER objects. A kernel handle the tray leaked would leak every round; one
    // the shell's client side opens once, at a moment of its own, is not a leak.
    assert!(growth.user_objects <= 0 && growth.gdi_objects <= 0, "every USER and GDI object came back: {growth:?}");
    assert!(growth.kernel_handles < ROUNDS as i64, "no kernel handle is leaked per tray: {growth:?}");
  });
}

/// "a left click is a click once the double-click time has passed; a double click is a double
/// click and no click", with the messages the shell posts.
#[test]
fn a_posted_left_click_is_a_click_once_the_double_click_time_passes_and_a_double_click_is_no_click() {
  on_ui_thread(|runtime| {
    let seen: Rc<RefCell<Vec<&'static str>>> = Rc::default();
    let (a, b) = (seen.clone(), seen.clone());
    let tray = Tray::new(TrayInit {
      on_click: Some(Rc::new(move || a.borrow_mut().push("click"))),
      on_double_click: Some(Rc::new(move || b.borrow_mut().push("double"))),
      ..tray_init(&unique("tray clicks"))
    })
    .expect("tray");
    let interval = u64::from(platform::double_click_time_ms());
    post_tray(&tray, &[WM_LBUTTONDOWN, WM_LBUTTONUP]);
    pump_until(&runtime, interval / 2, || false);
    assert!(seen.borrow().is_empty(), "still waiting for a second click");
    pump_until(&runtime, interval + 2000, || !seen.borrow().is_empty());
    assert_eq!(*seen.borrow(), ["click"]);
    seen.borrow_mut().clear();
    post_tray(&tray, &[WM_LBUTTONDOWN, WM_LBUTTONUP, WM_LBUTTONDBLCLK, WM_LBUTTONUP]);
    pump_until(&runtime, interval + 300, || false);
    assert_eq!(*seen.borrow(), ["double"]);
    tray.dispose();
  });
}

/// "a right click opens the menu built from the function form; dismissed it chooses nothing,
/// chosen it runs the item" (the item's click is `tray.ts`'s; here, the number chosen), and
/// "setMenu ...; a removed menu opens nothing".
#[test]
fn a_right_click_opens_a_menu_built_on_each_open_and_only_while_the_tray_has_one() {
  on_ui_thread(|runtime| {
    let opened = Rc::new(Cell::new(0u32));
    let chosen: Rc<RefCell<Vec<u32>>> = Rc::default();
    let (count, pick) = (opened.clone(), chosen.clone());
    let tray = Tray::new(TrayInit {
      has_menu: true,
      open_menu: Rc::new(move || {
        count.set(count.get() + 1);
        vec![
          MenuItem::Item { id: 1, label: format!("Status {}", count.get()), enabled: false, checked: false, icon: None },
          MenuItem::Item { id: 2, label: "Pause".into(), enabled: true, checked: count.get() > 1, icon: None },
          MenuItem::Separator,
          item(3, "Quit"),
        ]
      }),
      menu_chosen: Rc::new(move |id| pick.borrow_mut().push(id)),
      ..tray_init(&unique("tray menu"))
    })
    .expect("tray");
    let shown: Rc<RefCell<Vec<MenuEntry>>> = Rc::default();
    let sink = shown.clone();
    when_menu_opens(&runtime, move |menu_window| {
      *sink.borrow_mut() = os::read_menu(os::menu_of_window(menu_window));
      platform::end_menu_for_tests(); // dismissed, as by a click elsewhere
    });
    post_tray(&tray, &[WM_RBUTTONDOWN, WM_RBUTTONUP]);
    pump_until(&runtime, 5000, || opened.get() == 1 && os::open_popup_menu() == 0 && !shown.borrow().is_empty());
    assert_eq!(labels(&shown.borrow()), ["Status 1", "Pause", "", "Quit"]);
    assert!(!shown.borrow()[1].checked);
    assert!(chosen.borrow().is_empty(), "dismissed: nothing chosen");

    let sink = shown.clone();
    when_menu_opens(&runtime, move |menu_window| {
      *sink.borrow_mut() = os::read_menu(os::menu_of_window(menu_window));
      os::press_keys(menu_window, &[VK_DOWN, VK_DOWN, VK_RETURN]); // the keyboard stops on the disabled first item too
    });
    post_tray(&tray, &[WM_RBUTTONDOWN, WM_RBUTTONUP]);
    pump_until(&runtime, 5000, || !chosen.borrow().is_empty());
    assert_eq!(opened.get(), 2, "built again on each open");
    assert_eq!(shown.borrow()[0].label, "Status 2");
    assert!(shown.borrow()[1].checked);
    assert_eq!(*chosen.borrow(), [2]);

    // Without a menu a right click opens nothing; with it again, it opens.
    tray.set_has_menu(false);
    post_tray(&tray, &[WM_RBUTTONUP]);
    pump_until(&runtime, 200, || false);
    assert_eq!(opened.get(), 2);
    tray.set_has_menu(true);
    when_menu_opens(&runtime, |menu_window| os::press_keys(menu_window, &[VK_ESCAPE]));
    post_tray(&tray, &[WM_RBUTTONUP]);
    pump_until(&runtime, 5000, || opened.get() == 3 && os::open_popup_menu() == 0);
    assert_eq!(opened.get(), 3);
    tray.dispose();
  });
}

/// A tray menu item whose handler shows a window gets that window to the foreground: nothing gives
/// the foreground away before the chosen item's handler has run, so the process still holds it
/// (its hidden menu owner does) when the handler asks for it (review of `2a0b808`, F2).
#[test]
fn a_tray_menu_items_handler_that_shows_a_window_gets_it_to_the_foreground() {
  on_ui_thread(|runtime| {
    let front = os::OwnWindow::new("rt os window in front", (40, 260, 160, 100), |_| {}).expect("front");
    let settings = os::OwnWindow::new("rt os window a handler shows", (240, 260, 160, 100), |_| {}).expect("settings");
    if !os::take_foreground(front.handle_value()) {
      panic!("not run: this desktop's foreground could not be given to the test's window");
    }
    let at_handler = Rc::new(Cell::new(0isize));
    let chosen = Rc::new(Cell::new(false));
    let (seen, done, target) = (at_handler.clone(), chosen.clone(), settings.handle_value());
    let tray = Tray::new(TrayInit {
      has_menu: true,
      open_menu: Rc::new(|| vec![item(1, "Settings")]),
      menu_chosen: Rc::new(move |_| {
        seen.set(os::foreground());
        // As a handler's `window.show()` does.
        BorrowedWindow::with_handle_value(target, |window| platform::show(window, false, false, false));
        done.set(true);
      }),
      ..tray_init(&unique("tray menu foreground"))
    })
    .expect("tray");
    when_menu_opens(&runtime, |menu_window| os::press_keys(menu_window, &[VK_DOWN, VK_RETURN]));
    post_tray(&tray, &[WM_RBUTTONDOWN, WM_RBUTTONUP]);
    pump_until(&runtime, 5000, || chosen.get());
    assert!(chosen.get(), "the item was chosen");
    assert_ne!(at_handler.get(), front.handle_value(), "the foreground was not given back before the handler ran");
    assert_eq!(os::foreground(), settings.handle_value(), "the window the handler showed is in front");
    // A second menu after that choice is chosen too: a choice is not lost to a foreground given
    // away by the menu before it (reentry_tests.rs, the tray that disposes itself, failed so).
    chosen.set(false);
    when_menu_opens(&runtime, |menu_window| os::press_keys(menu_window, &[VK_DOWN, VK_RETURN]));
    post_tray(&tray, &[WM_RBUTTONDOWN, WM_RBUTTONUP]);
    pump_until(&runtime, 5000, || chosen.get());
    tray.dispose();
    assert!(chosen.get(), "the second menu's item was chosen");
  });
}

/// "the icon is re-added when the taskbar is recreated (the registered TaskbarCreated message, as
/// Explorer broadcasts it)". Restarting Explorer is not safe on a shared desktop: the icon is
/// deleted from the shell behind the tray's back, as Explorer loses every icon when it restarts,
/// and read back from Explorer as gone; the broadcast is posted to the tray's window; the shell
/// holds the icon again, Explorer shows it, and a click arrives (`tray-icon` delivers one only
/// while the shell knows the icon).
#[test]
fn the_icon_lost_by_the_shell_is_added_again_when_the_taskbar_is_recreated() {
  on_ui_thread(|runtime| {
    let clicks = Rc::new(Cell::new(0u32));
    let count = clicks.clone();
    let tooltip = unique("tray taskbar");
    let tray = Tray::new(TrayInit { on_double_click: Some(Rc::new(move || count.set(count.get() + 1))), ..tray_init(&tooltip) }).expect("tray");
    let window = tray.window_handle_value();
    let uid = (1..=64).find(|&uid| os::shell_holds_icon(window, uid)).expect("the shell holds the tray's icon");
    assert!(matches!(shell_icon(&runtime, &tooltip, true), Shell::Found { .. }), "Explorer shows the icon");
    assert!(os::delete_shell_icon(window, uid), "the icon is deleted from the shell");
    assert!(!os::shell_holds_icon(window, uid));
    assert_eq!(shell_icon(&runtime, &tooltip, false), Shell::Missing, "Explorer shows no icon");
    assert!(os::post(window, os::registered_message("TaskbarCreated"), 0, 0));
    pump_until(&runtime, 2000, || os::shell_holds_icon(window, uid));
    assert!(os::shell_holds_icon(window, uid), "the tray added its icon again");
    assert!(matches!(shell_icon(&runtime, &tooltip, true), Shell::Found { .. }), "Explorer shows the icon again");
    post_tray(&tray, &[WM_LBUTTONDBLCLK]);
    pump_until(&runtime, 5000, || clicks.get() == 1);
    assert_eq!(clicks.get(), 1, "and a click arrives");
    tray.dispose();
  });
}

// ---- the tray, as Explorer shows it ---------------------------------------------------------------

/// What Explorer shows for a notification icon (`tray-shell.ps1`, in a second process): its UI
/// Automation name and the middle pixel of its image, or that it is not there.
#[derive(Debug, Clone, PartialEq)]
enum Shell {
  Found { name: String, pixel: [u8; 3] },
  Missing,
}

/// Reads the icon whose tooltip is `tooltip` back from Explorer, pumping meanwhile; asked again
/// while the answer is not yet `want_found` (Explorer applies a change on its own thread), and a
/// reading the shared desktop refused is asked again too, or the test refuses to judge.
fn shell_icon(runtime: &Runtime, tooltip: &str, want_found: bool) -> Shell {
  let script = concat!(env!("CARGO_MANIFEST_DIR"), "/src/tray-shell.ps1");
  let (mut last, mut refusals, mut reads, mut why) = (None, 0, 0, String::new());
  while reads < 4 && refusals < 6 {
    if reads + refusals > 0 {
      pump_until(runtime, 800, || false);
    }
    let mut child = std::process::Command::new("pwsh")
      .args(["-NoProfile", "-NonInteractive", "-File", script, "-Tooltip", tooltip])
      .stdout(std::process::Stdio::piped())
      .stderr(std::process::Stdio::piped())
      .spawn()
      .expect("pwsh");
    while child.try_wait().expect("the shell reader").is_none() {
      runtime.pump();
      std::thread::sleep(Duration::from_millis(20));
    }
    let output = child.wait_with_output().expect("the shell reader's output");
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().last().unwrap_or("").trim().to_owned();
    let answer: serde_json::Value = serde_json::from_str(&line).unwrap_or_else(|_| serde_json::json!({ "skip": format!("no answer: {line} {}", String::from_utf8_lossy(&output.stderr)) }));
    if let Some(skip) = answer.get("skip") {
      refusals += 1;
      why = skip.to_string();
      continue;
    }
    reads += 1;
    let read = if answer["found"] == serde_json::Value::Bool(true) {
      let channel = |i: usize| answer["pixel"][i].as_u64().unwrap_or(0) as u8;
      Shell::Found { name: answer["name"].as_str().unwrap_or("").to_owned(), pixel: [channel(0), channel(1), channel(2)] }
    } else {
      Shell::Missing
    };
    let found = matches!(read, Shell::Found { .. });
    last = Some(read);
    if found == want_found {
      break;
    }
  }
  last.unwrap_or_else(|| panic!("refused to judge: the shell's reading of the notification icon: {why}, after {refusals} attempts; run again"))
}

/// "a tray with no icon shows the stock icon", "setIcon and setTooltip reach the shell", and
/// "setTooltip: longer than the shell keeps, truncated, not refused", read back from Explorer.
#[test]
fn explorer_shows_the_trays_tooltip_and_icon_and_follows_set_icon_and_set_tooltip() {
  on_ui_thread(|runtime| {
    let tooltip = unique("tray shell");
    let tray = Tray::new(tray_init(&tooltip)).expect("tray");
    let Shell::Found { name, pixel: stock } = shell_icon(&runtime, &tooltip, true) else { panic!("Explorer shows the icon") };
    assert!(name.ends_with(&tooltip), "its tooltip: {name}");

    // setIcon and setTooltip reach the shell: the new tooltip, and a green image where the stock icon was.
    let changed = unique("tray tooltip");
    tray.set_icon(Some(&IconBytes { ico: Some(solid_ico(GREEN, &[16, 20, 24, 32, 40, 48])), ..Default::default() })).expect("set_icon");
    tray.set_tooltip(&changed).expect("set_tooltip");
    let mut green = shell_icon(&runtime, &changed, true);
    for _ in 0..3 {
      match &green {
        Shell::Found { pixel, .. } if pixel[1] < 200 => {
          pump_until(&runtime, 800, || false);
          green = shell_icon(&runtime, &changed, true);
        }
        _ => break,
      }
    }
    let Shell::Found { name, pixel } = green else { panic!("Explorer shows the changed icon") };
    assert!(name.ends_with(&changed));
    assert!(pixel[1] > 200 && pixel[0] < 60 && pixel[2] < 60, "green: {pixel:?}");
    assert_ne!(pixel, stock);
    assert_eq!(shell_icon(&runtime, &tooltip, false), Shell::Missing, "the old tooltip is gone");

    // Back to the stock icon.
    tray.set_icon(None).expect("stock icon");
    let near = |p: [u8; 3]| p.iter().zip(stock).all(|(a, b)| a.abs_diff(b) <= 8);
    let mut back = shell_icon(&runtime, &changed, true);
    for _ in 0..3 {
      match &back {
        Shell::Found { pixel, .. } if !near(*pixel) => {
          pump_until(&runtime, 800, || false);
          back = shell_icon(&runtime, &changed, true);
        }
        _ => break,
      }
    }
    let Shell::Found { pixel, .. } = back else { panic!("Explorer shows the stock icon again") };
    assert!(near(pixel), "the stock image again: {pixel:?} against {stock:?}");

    // Longer than the shell keeps: the first 127 characters (szTip holds 128 with its NUL).
    let long = format!("{:x<200}", unique("tray long "));
    tray.set_tooltip(&long).expect("a long tooltip is cut, not refused");
    assert!(matches!(shell_icon(&runtime, &long[..127], true), Shell::Found { .. }));
    assert!(tray.set_icon(Some(&IconBytes { ico: Some(vec![0, 1]), ..Default::default() })).is_err_and(|e| e.to_string().contains("the tray icon could not be decoded")));
    tray.dispose();
  });
}
