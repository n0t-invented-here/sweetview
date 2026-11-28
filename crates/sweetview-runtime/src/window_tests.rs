use std::cell::RefCell;

use sweetview_window_logic::style::{WS_EX_ACCEPTFILES, WS_EX_APPWINDOW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT};

use super::*;
use crate::runtime::testing::on_ui_thread;

const WS_EX_TOPMOST: u32 = 0x0000_0008;

fn init(title: &str) -> WindowInit {
  WindowInit { title: title.into(), frame: true, resizable: true, ..Default::default() }
}

/// Lends `window`'s native window to `f`.
fn native<R>(window: &Window, f: impl FnOnce(&BorrowedWindow<'_>) -> R) -> R {
  BorrowedWindow::with_handle_value(window.handle(), f).expect("a live window")
}

fn alive(handle: isize) -> bool {
  BorrowedWindow::with_handle_value(handle, |_| ()).is_some()
}

#[test]
fn hidden_windows_take_their_exact_outer_bounds_and_dispose_destroys_them() {
  on_ui_thread(|_runtime| {
    let framed = Window::create(WindowInit { bounds: Some(Rect::new(100, 100, 400, 300)), ..init("rt framed") }).expect("framed");
    let frameless = Window::create(WindowInit {
      bounds: Some(Rect::new(120, 120, 200, 150)),
      frame: false,
      transparent: true,
      ..init("rt frameless")
    })
    .expect("frameless");
    assert!(!framed.is_visible() && !frameless.is_visible());
    assert_eq!(framed.bounds(), Rect::new(100, 100, 400, 300));
    assert_eq!(frameless.bounds(), Rect::new(120, 120, 200, 150));
    assert!(framed.scale() > 0.0);
    let (h1, h2) = (framed.handle(), frameless.handle());
    assert!(tracked_count(h1) >= 1);
    framed.dispose();
    framed.dispose();
    assert!(!alive(h1), "destroyed at once");
    assert_eq!(tracked_count(h1), 0);
    assert!(alive(h2));
    frameless.dispose();
    assert!(!alive(h2));
    assert_eq!(tracked_count(h2), 0, "the frameless window is released too");
  });
}

#[test]
fn every_option_shows_in_the_window_styles_and_survives_a_style_rewrite() {
  on_ui_thread(|_runtime| {
    let overlay = Window::create(WindowInit {
      frame: false,
      topmost: true,
      hide_from_taskbar: true,
      no_activate: true,
      color_key: Some("#ff00ff".into()),
      opacity: Some(0.5),
      ..init("rt overlay")
    })
    .expect("overlay");
    let ex = native(&overlay, |w| platform::ex_style(w));
    assert_eq!(ex & WS_EX_TOPMOST, WS_EX_TOPMOST, "topmost");
    assert_eq!(ex & (WS_EX_TOOLWINDOW | WS_EX_APPWINDOW), WS_EX_TOOLWINDOW, "off the taskbar");
    assert_eq!(ex & WS_EX_NOACTIVATE, WS_EX_NOACTIVATE, "no activation");
    assert_eq!(ex & WS_EX_LAYERED, WS_EX_LAYERED, "layered for the colour key and opacity");
    assert_eq!(ex & WS_EX_ACCEPTFILES, 0, "no drops without a listener");
    // `tao` rewrites the whole extended style when one of its flags changes.
    overlay.set_topmost(false);
    let ex = native(&overlay, |w| platform::ex_style(w));
    assert_eq!(ex & WS_EX_TOPMOST, 0);
    assert_eq!(ex & (WS_EX_TOOLWINDOW | WS_EX_APPWINDOW | WS_EX_LAYERED | WS_EX_ACCEPTFILES), WS_EX_TOOLWINDOW | WS_EX_LAYERED);
    overlay.set_topmost(true);
    assert_eq!(native(&overlay, |w| platform::ex_style(w)) & WS_EX_TOPMOST, WS_EX_TOPMOST);
    overlay.dispose();

    let plain = Window::create(init("rt plain")).expect("plain");
    let ex = native(&plain, |w| platform::ex_style(w));
    assert_eq!(ex & (WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED), 0);
    plain.dispose();

    assert!(Window::create(WindowInit { color_key: Some("#fff".into()), ..init("rt bad key") }).is_err());
  });
}

#[test]
fn show_activates_unless_no_activate() {
  on_ui_thread(|runtime| {
    let quiet = Window::create(WindowInit { no_activate: true, bounds: Some(Rect::new(-2000, -2000, 200, 200)), ..init("rt quiet") }).expect("quiet");
    quiet.show().expect("show");
    runtime.pump();
    assert!(quiet.is_visible());
    assert!(!native(&quiet, |w| platform::is_active(w)), "a noActivate window is shown without activation");
    // A later `tao` style rewrite (here: topmost) neither hides nor activates it.
    quiet.set_topmost(true);
    assert!(quiet.is_visible() && !native(&quiet, |w| platform::is_active(w)));
    quiet.minimize();
    assert!(native(&quiet, |w| platform::is_minimized(w)));
    quiet.show().expect("restore");
    runtime.pump();
    assert!(!native(&quiet, |w| platform::is_minimized(w)) && quiet.is_visible());
    // As at tag `pre-rust-rewrite`: a window restores with `SW_RESTORE`, `noActivate` or not (R5-4).
    assert!(native(&quiet, |w| platform::is_active(w)), "a minimised noActivate window is restored as the tag restored it");
    quiet.hide();
    assert!(!quiet.is_visible());
    quiet.dispose();

    // The tab frame restored a minimised `noActivate` frame without activating it (audit finding 15).
    let frame = Window::create(WindowInit { tab_strip_height: Some(40), no_activate: true, bounds: Some(Rect::new(-2000, -2000, 400, 300)), ..init("rt quiet frame") }).expect("frame");
    frame.show().expect("show");
    runtime.pump();
    frame.minimize();
    assert!(native(&frame, |w| platform::is_minimized(w)));
    frame.show().expect("restore");
    runtime.pump();
    assert!(!native(&frame, |w| platform::is_minimized(w)) && frame.is_visible());
    assert!(!native(&frame, |w| platform::is_active(w)), "a minimised noActivate tab frame is restored without activation");
    frame.dispose();

    let loud = Window::create(WindowInit { bounds: Some(Rect::new(-2000, -2000, 200, 200)), ..init("rt loud") }).expect("loud");
    loud.show().expect("show");
    assert!(native(&loud, |w| platform::is_active(w)), "an ordinary window is activated by show()");
    loud.dispose();
  });
}

#[test]
fn events_reach_every_wrapper_and_close_follows_the_listeners() {
  on_ui_thread(|_runtime| {
    let window = Window::create(WindowInit { bounds: Some(Rect::new(100, 100, 300, 200)), ..init("rt events") }).expect("window");
    let seen: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
    let (a, b, c) = (seen.clone(), seen.clone(), seen.clone());
    window.on_resize(window.id, Some(Rc::new(move |r| a.borrow_mut().push(format!("resize {}x{}", r.width, r.height))))).expect("resize");
    window.on_move(window.id, Some(Rc::new(move |r| b.borrow_mut().push(format!("move {},{}", r.x, r.y))))).expect("move");
    window.resize(420, 310);
    window.move_to(180, 160);
    assert!(seen.borrow().contains(&"resize 420x310".to_string()), "{:?}", seen.borrow());
    assert!(seen.borrow().contains(&"move 180,160".to_string()), "{:?}", seen.borrow());

    // A wrapper of the same window shares it, and its listeners are its own.
    let borrowed = Window::adopt(window.handle()).expect("adopt own window");
    assert_eq!(borrowed.detected(), Some(Chrome { frame: true, resizable: true }));
    borrowed.on_close_request(Some(Rc::new(move || c.borrow_mut().push("borrowed close".into())))).expect("close");
    let closed_by_default = Rc::new(Cell::new(0u32));
    let count = closed_by_default.clone();
    window.on_default_close(Some(Rc::new(move || count.set(count.get() + 1))));
    send_close(&window);
    assert!(seen.borrow().contains(&"borrowed close".to_string()));
    assert_eq!(closed_by_default.get(), 0, "a listener took the request");
    borrowed.dispose();
    send_close(&window);
    assert_eq!(closed_by_default.get(), 1, "no listener: the owner's default");
    assert!(alive(window.handle()));
    // No listener and no default: the window is destroyed, and the loop goes on.
    window.on_default_close(None);
    let handle = window.handle();
    send_close(&window);
    assert!(!alive(handle));
    assert_eq!(tracked_count(handle), 0);
    window.dispose();
  });
}

/// `WM_CLOSE`, as the close button sends it, through the platform crate's
/// `request_close` (the runtime has no unsafe).
fn send_close(window: &Window) {
  native(window, |w| platform::request_close(w));
}

#[test]
fn click_through_and_hit_regions_set_the_style_bits() {
  on_ui_thread(|_runtime| {
    let window = Window::create(WindowInit { frame: false, ..init("rt hits") }).expect("window");
    let bits = || native(&window, |w| platform::ex_style(w)) & (WS_EX_TRANSPARENT | WS_EX_LAYERED);
    window.set_click_through(true);
    assert_eq!(bits(), WS_EX_TRANSPARENT | WS_EX_LAYERED);
    window.set_click_through(false);
    assert_eq!(bits(), 0);
    // No polygon: the whole window lets clicks through, at once and while polling.
    if !platform::mouse_buttons_down() {
      window.set_hit_regions(Some(Vec::new()), None).expect("regions");
      assert_eq!(bits(), WS_EX_TRANSPARENT | WS_EX_LAYERED);
      assert!(tracked_count(window.handle()) >= 2);
    }
    window.set_hit_regions(None, None).expect("no regions");
    assert_eq!(bits(), 0);
    window.dispose();
  });
}

#[test]
fn frameless_maximise_uses_the_work_area_of_its_own_screen() {
  on_ui_thread(|_runtime| {
    let window = Window::create(WindowInit { frame: false, bounds: Some(Rect::new(110, 120, 320, 240)), ..init("rt max") }).expect("window");
    let work_area = screen::of_window(window.handle()).expect("screen").work_area;
    assert!(!window.is_maximized());
    window.toggle_maximize().expect("maximise");
    assert!(window.is_maximized());
    assert_eq!(window.bounds(), work_area);
    window.toggle_maximize().expect("restore");
    assert!(!window.is_maximized());
    assert_eq!(window.bounds(), Rect::new(110, 120, 320, 240));
    window.dispose();
  });
}

/// Round 4, P2: `windowMenu` (and `Window#showSystemMenu`) gives every window the tag's menu: Restore
/// enabled when `IsZoomed`, Move, Size and Maximize when not, Minimize always, whatever Sweetview
/// knows of the window. A minimised frameless window, one maximised by its own work-area toggle
/// (which the OS does not call zoomed) and one that cannot be sized.
#[test]
fn the_system_menu_of_every_window_is_enabled_from_is_zoomed_alone() {
  on_ui_thread(|runtime| {
    let at = Some(Rect::new(-2000, -2000, 320, 240));
    let frameless = Window::create(WindowInit { frame: false, no_activate: true, bounds: at, ..init("rt menu frameless") }).expect("window");
    let fixed = Window::create(WindowInit { resizable: false, no_activate: true, bounds: at, ..init("rt menu fixed") }).expect("window");
    // The items as the menu shows them: read inside its loop, then the menu is closed.
    let shown = |window: &Window| {
      let read: Rc<Cell<Option<[bool; 5]>>> = Rc::default();
      let (into, handle) = (read.clone(), window.handle());
      let tick = runtime
        .set_interval(20, move || {
          if into.get().is_none() {
            into.set(BorrowedWindow::with_handle_value(handle, |w| platform::test_support::system_menu_enabled(w)).flatten());
            platform::end_menu_for_tests();
          }
        })
        .expect("interval");
      crate::menu::window_menu(handle).expect("menu");
      runtime.clear_timeout(tick);
      read.get().expect("the menu was open")
    };
    let tag = |zoomed: bool| [zoomed, !zoomed, !zoomed, true, !zoomed];
    frameless.show().expect("show");
    frameless.minimize();
    assert_eq!(shown(&frameless), tag(false), "a minimised frameless window");
    frameless.show().expect("restore");
    frameless.toggle_maximize().expect("maximise");
    assert!(frameless.is_maximized() && !native(&frameless, |w| platform::is_zoomed(w)));
    assert_eq!(shown(&frameless), tag(false), "a frameless window maximised by its own toggle");
    fixed.show().expect("show");
    assert_eq!(shown(&fixed), tag(false), "a window that cannot be sized");
    frameless.dispose();
    fixed.dispose();
  });
}

/// Round 4, P3: a frameless window's restore sets its bounds and only then forgets the bounds it
/// kept, as tag `pre-rust-rewrite`'s `toggleMaximize` did: a resize listener that reads
/// `is_maximized()` during the restore reads `true`, and during the maximise reads `true` too.
#[test]
fn a_frameless_restore_is_still_maximised_while_its_resize_is_delivered() {
  on_ui_thread(|_runtime| {
    let window = Rc::new(Window::create(WindowInit { frame: false, no_activate: true, bounds: Some(Rect::new(110, 120, 320, 240)), ..init("rt restore order") }).expect("window"));
    window.show().expect("show");
    let read: Rc<RefCell<Vec<bool>>> = Rc::default();
    let (into, reader) = (read.clone(), Rc::downgrade(&window));
    window.on_resize(window.id, Some(Rc::new(move |_| into.borrow_mut().extend(reader.upgrade().map(|w| w.is_maximized()))))).expect("resize");
    window.toggle_maximize().expect("maximise");
    window.toggle_maximize().expect("restore");
    assert_eq!(*read.borrow(), [true, true], "maximised while the maximise and the restore are delivered");
    assert!(!window.is_maximized());
    window.dispose();
  });
}

/// Round 4, P4: a window has one list of resize, move and maximise listeners, whichever wrapper
/// added them, as the tag had one set per window: they are told in the order they were added
/// (A1, B1, A2 for A1, B1, A2), the same function added again, through any wrapper, is one
/// listener, taking it out takes it out for every wrapper, and disposing a wrapper takes out
/// what it added.
#[test]
fn a_windows_listeners_are_one_list_in_the_order_they_were_added() {
  on_ui_thread(|_runtime| {
    let window = Window::create(WindowInit { frame: false, no_activate: true, bounds: Some(Rect::new(-2000, -2000, 320, 240)), ..init("rt one list") }).expect("window");
    let a = Window::adopt(window.handle()).expect("wrapper A");
    let b = Window::adopt(window.handle()).expect("wrapper B");
    let heard: Rc<RefCell<Vec<String>>> = Rc::default();
    let rect = |kind: &'static str, name: &'static str| -> RectListener {
      let sink = heard.clone();
      Rc::new(move |_| sink.borrow_mut().push(format!("{kind} {name}")))
    };
    let flag = |name: &'static str| -> BoolListener {
      let sink = heard.clone();
      Rc::new(move |_| sink.borrow_mut().push(format!("maximise {name}")))
    };
    for (wrapper, key, name) in [(&a, 1, "A1"), (&b, 2, "B1"), (&a, 3, "A2"), (&b, 1, "A1 again")] {
      wrapper.on_resize(key, Some(rect("resize", name))).expect("resize");
      wrapper.on_move(key, Some(rect("move", name))).expect("move");
      wrapper.on_maximize_change(key, Some(flag(name))).expect("maximise");
    }
    // The listeners of `kind` told while `f` runs, in order.
    let told = |kind: &str, f: &dyn Fn()| -> Vec<String> {
      heard.borrow_mut().clear();
      f();
      heard.borrow().iter().filter_map(|h| h.strip_prefix(kind).map(|n| n.trim().to_string())).collect()
    };
    let all = ["A1", "B1", "A2"];
    assert_eq!(told("resize", &|| window.set_bounds(Rect::new(-2000, -2000, 330, 240))), all);
    assert_eq!(told("move", &|| window.set_bounds(Rect::new(-1990, -2000, 330, 240))), all);
    assert_eq!(told("maximise", &|| window.toggle_maximize().expect("maximise")), all);
    window.toggle_maximize().expect("restore");
    // Taken out through B, which added it second: gone for A too.
    b.on_resize(1, None).expect("take out");
    assert_eq!(told("resize", &|| window.set_bounds(Rect::new(-2000, -2000, 340, 240))), ["B1", "A2"]);
    // Disposing A takes out what A added (A2, and A1 under move); B's own stays.
    a.dispose();
    assert_eq!(told("move", &|| window.set_bounds(Rect::new(-1980, -2000, 340, 240))), ["B1"]);
    b.dispose();
    window.dispose();
  });
}

/// Round 4, Q3: a listener that changes the maximised state from inside its call, every time it is
/// told, costs no other listener a delivery, whichever wrapper each was added through and in either
/// order: the other hears the change and then the one further delivery; the change made during
/// that one is refused (printed), and the window keeps the state it is in.
#[test]
fn a_listener_that_changes_the_maximised_state_costs_no_other_listener_a_delivery() {
  on_ui_thread(|_runtime| {
    for toggler_first in [true, false] {
      let window = Window::create(WindowInit { frame: false, bounds: Some(Rect::new(140, 140, 320, 240)), ..init("rt no lost delivery") }).expect("window");
      let changer = Window::adopt(window.handle()).expect("the changer's wrapper");
      let witness = Window::adopt(window.handle()).expect("the witness's wrapper");
      let toggler = Rc::new(Window::adopt(window.handle()).expect("a wrapper to toggle with"));
      let (heard, calls) = (Rc::new(RefCell::new(Vec::new())), Rc::new(Cell::new(0)));
      let add_changer = || {
        let (toggle, count) = (toggler.clone(), calls.clone());
        changer
          .on_maximize_change(
            1,
            Some(Rc::new(move |_| {
              count.set(count.get() + 1);
              toggle.toggle_maximize().expect("toggle");
            })),
          )
          .expect("changer");
      };
      let add_witness = || {
        let sink = heard.clone();
        witness.on_maximize_change(2, Some(Rc::new(move |maximized| sink.borrow_mut().push(maximized)))).expect("witness");
      };
      if toggler_first {
        add_changer();
        add_witness();
      } else {
        add_witness();
        add_changer();
      }
      window.toggle_maximize().expect("maximise");
      assert_eq!((heard.borrow().clone(), calls.get()), (vec![true, false], 2), "toggler first: {toggler_first}");
      // The refused change was made: the window is maximised again, and no one was told.
      assert!(window.is_maximized());
      for w in [&changer, &witness] {
        w.dispose();
      }
      toggler.dispose();
      window.dispose();
    }
  });
}

/// Round 4, P4: a tab frame's move listeners are told while it is minimised too, as the tag's tab
/// frame told them; another window's are not.
#[test]
fn a_tab_frames_move_is_told_while_it_is_minimised() {
  on_ui_thread(|runtime| {
    for tab in [true, false] {
      let tab_strip_height = tab.then_some(32);
      let window = Window::create(WindowInit { tab_strip_height, no_activate: true, bounds: Some(Rect::new(140, 140, 400, 300)), ..init("rt minimised move") }).expect("window");
      window.show().expect("show");
      runtime.pump();
      let moves = Rc::new(Cell::new(0));
      let count = moves.clone();
      window.on_move(window.id, Some(Rc::new(move |_| count.set(count.get() + 1)))).expect("move");
      window.minimize();
      runtime.pump();
      assert!(window.is_minimized());
      assert_eq!(moves.get() > 0, tab, "tab frame: {tab}, moves while minimising: {}", moves.get());
      window.dispose();
    }
  });
}

/// Round 4, P6: a window Sweetview did not make is subclassed with its first listener and let go
/// with its last, as at the tag: wrapping it to read its bounds gives it no subclass. Whether
/// Sweetview's subclass is on it is read by installing another, which the platform refuses then.
#[test]
fn a_wrapped_window_is_subclassed_only_while_it_has_a_listener() {
  on_ui_thread(|runtime| {
    let own = runtime
      .with_target(|target| tao::window::WindowBuilder::new().with_visible(false).with_title("rt lazy subclass").build(target))
      .expect("target")
      .expect("window");
    let handle = platform::handle_value(&own);
    let subclassed = || BorrowedWindow::with_handle_value(handle, |w| platform::WindowSubclass::install(w, |_| false).is_err()).expect("a window");
    let wrapped = Window::adopt(handle).expect("adopt");
    assert!(wrapped.bounds().width > 0 && !subclassed(), "wrapped to read its bounds: no subclass");
    wrapped.on_resize(1, Some(Rc::new(|_| {}))).expect("listen");
    wrapped.on_close_request(Some(Rc::new(|| {}))).expect("listen");
    assert!(subclassed(), "subclassed with its first listener");
    wrapped.on_resize(1, None).expect("stop");
    assert!(subclassed(), "a listener is left");
    wrapped.on_close_request(None).expect("stop");
    assert!(!subclassed(), "let go with its last listener");
    wrapped.on_maximize_change(2, Some(Rc::new(|_| {}))).expect("listen again");
    assert!(subclassed());
    wrapped.dispose();
    assert!(!subclassed(), "let go when its wrapper is disposed");
    drop(own);
  });
}

/// Review round 5, R5-2: a window Sweetview did not make that its application destroys while a
/// wrapper with no listener (so no subclass) still holds it is not handed back by a later
/// `adopt` of its handle: that throws, as for any value that names no window, and the stale
/// record is let go.
#[test]
fn adopting_the_handle_of_a_destroyed_window_throws_even_while_an_old_wrapper_remains() {
  on_ui_thread(|runtime| {
    let own = runtime
      .with_target(|target| tao::window::WindowBuilder::new().with_visible(false).with_title("rt destroyed under a wrapper").build(target))
      .expect("target")
      .expect("window");
    let handle = platform::handle_value(&own);
    let wrapped = Window::adopt(handle).expect("adopt");
    platform::destroy_now(own);
    let again = Window::adopt(handle);
    assert!(matches!(&again, Err(e) if e.to_string().contains("not a window")), "{:?}", again.as_ref().err());
    assert!(!wrapped.is_visible(), "the old wrapper reads the window as gone");
    wrapped.dispose();
  });
}

#[test]
fn is_minimized_follows_the_os_for_an_owned_and_an_adopted_window() {
  on_ui_thread(|runtime| {
    let window = Window::create(WindowInit { bounds: Some(Rect::new(-2000, -2000, 200, 200)), ..init("rt minimized") }).expect("window");
    assert!(!window.is_minimized(), "a hidden window is not minimised");
    window.show().expect("show");
    runtime.pump();
    assert!(!window.is_minimized());
    window.minimize();
    assert!(window.is_minimized() && native(&window, |w| platform::is_minimized(w)));
    window.show().expect("restore");
    assert!(!window.is_minimized() && !native(&window, |w| platform::is_minimized(w)));
    window.dispose();
    assert!(!window.is_minimized(), "a disposed window is not minimised");

    // The application's own window, which `tao` made outside `Window::create`: read through the OS.
    let own = runtime
      .with_target(|target| tao::window::WindowBuilder::new().with_visible(false).with_title("rt own minimized").build(target))
      .expect("target")
      .expect("window");
    let adopted = Window::adopt(platform::handle_value(&own)).expect("adopt");
    assert!(!adopted.is_minimized());
    adopted.minimize();
    assert!(adopted.is_minimized() && platform::is_minimized(&own));
    adopted.show().expect("restore");
    assert!(!adopted.is_minimized() && !platform::is_minimized(&own));
    adopted.dispose();
    drop(own);
  });
}

#[test]
fn content_size_is_the_client_area_at_the_windows_scale_and_a_maximise_change_is_reported_once() {
  on_ui_thread(|runtime| {
    let window = Window::create(WindowInit { content_size: Some(Dips::new(500.0, 300.0)), ..init("rt content size") }).expect("window");
    let scale = window.scale();
    let inner = window.core.with_tao(|tao| tao.inner_size()).expect("a tao window");
    assert_eq!((inner.width, inner.height), ((500.0 * scale).round() as u32, (300.0 * scale).round() as u32));
    let area = screen::primary().expect("primary").work_area;
    let bounds = window.bounds();
    assert_eq!(bounds, logic::centred(bounds.width, bounds.height, area));

    let both = Window::create(WindowInit { bounds: Some(Rect::new(0, 0, 100, 100)), content_size: Some(Dips::new(100.0, 100.0)), ..init("rt both") });
    assert!(matches!(both, Err(e) if e.to_string().contains("bounds and contentSize cannot both be given")));
    let bad = Window::create(WindowInit { background_color: Some("teal".into()), ..init("rt bad colour") });
    assert!(matches!(bad, Err(e) if e.to_string().contains("background color must be #rrggbb, got teal")));

    let seen = Rc::new(RefCell::new(Vec::new()));
    let sink = seen.clone();
    window.on_maximize_change(window.id, Some(Rc::new(move |maximized| sink.borrow_mut().push(maximized)))).expect("listener");
    window.show().expect("show");
    runtime.pump();
    window.toggle_maximize().expect("maximise");
    window.minimize();
    window.show().expect("restore, maximised");
    window.toggle_maximize().expect("restore");
    assert_eq!(*seen.borrow(), vec![true, false]);
    window.on_maximize_change(window.id, None).expect("removed");
    window.toggle_maximize().expect("maximise again");
    assert_eq!(*seen.borrow(), vec![true, false]);
    window.dispose();
  });
}

/// Review finding 3, as `onMaximizeChange`'s sentence 1 says it since round 3: every maximise
/// listener ends with the window's own state, when a listener changes the state from inside its
/// call, or a resize listener does.
#[test]
fn maximise_listeners_see_each_change_in_order_when_a_listener_changes_the_state() {
  on_ui_thread(|_runtime| {
    let window = Window::create(WindowInit { frame: false, bounds: Some(Rect::new(140, 140, 320, 240)), ..init("rt nested maximise") }).expect("window");
    let other = Window::adopt(window.handle()).expect("a second wrapper");
    let seen_a = Rc::new(RefCell::new(Vec::new()));
    let seen_b = Rc::new(RefCell::new(Vec::new()));
    let (sink_a, sink_b) = (seen_a.clone(), seen_b.clone());
    let toggler = Rc::new(Window::adopt(window.handle()).expect("a wrapper to toggle with"));
    let toggle = toggler.clone();
    // A restores the window as soon as it hears it was maximised.
    window
      .on_maximize_change(window.id, Some(Rc::new(move |maximized| {
        sink_a.borrow_mut().push(maximized);
        if maximized {
          toggle.toggle_maximize().expect("restore from inside");
        }
      })))
      .expect("listener A");
    other.on_maximize_change(other.id, Some(Rc::new(move |maximized| sink_b.borrow_mut().push(maximized)))).expect("listener B");
    window.toggle_maximize().expect("maximise");
    assert!(!window.is_maximized(), "restored by A");
    assert_eq!(*seen_a.borrow(), vec![true, false]);
    // B is told the change A was told of, then, once that delivery is done, the one A made.
    assert_eq!(*seen_b.borrow(), vec![true, false], "B ends with the window's state");
    window.on_maximize_change(window.id, None).expect("A removed");
    other.on_maximize_change(other.id, None).expect("B removed");

    // A resize listener that restores the window while it is being maximised.
    let seen = Rc::new(RefCell::new(Vec::new()));
    let sink = seen.clone();
    window.on_maximize_change(window.id, Some(Rc::new(move |maximized| sink.borrow_mut().push(maximized)))).expect("listener");
    let restorer = toggler.clone();
    let restored = Rc::new(Cell::new(false));
    let once = restored.clone();
    other
      .on_resize(other.id, Some(Rc::new(move |_bounds| {
        if !once.replace(true) {
          restorer.toggle_maximize().expect("restore from a resize listener");
        }
      })))
      .expect("resize listener");
    window.toggle_maximize().expect("maximise");
    assert!(restored.get() && !window.is_maximized());
    assert_eq!(*seen.borrow(), vec![true, false], "neither change is lost");
    other.dispose();
    toggler.dispose();
    window.dispose();
  });
}

/// Review N5: a listener subscribed while the window is minimised from maximised hears nothing
/// when the window is restored to maximised: nothing changed.
#[test]
fn a_maximise_listener_subscribed_while_minimised_hears_no_change_on_restore() {
  on_ui_thread(|runtime| {
    let window = Window::create(WindowInit { bounds: Some(Rect::new(150, 150, 320, 240)), ..init("rt minimised subscribe") }).expect("window");
    window.show().expect("show");
    runtime.pump();
    window.toggle_maximize().expect("maximise");
    window.minimize();
    assert!(native(&window, |w| platform::is_minimized(w)));
    let seen = Rc::new(RefCell::new(Vec::new()));
    let sink = seen.clone();
    window.on_maximize_change(window.id, Some(Rc::new(move |maximized| sink.borrow_mut().push(maximized)))).expect("listener");
    window.show().expect("restore, maximised");
    assert!(window.is_maximized());
    assert_eq!(*seen.borrow(), Vec::<bool>::new(), "restoring to the state it had is no change");
    window.toggle_maximize().expect("restore");
    assert_eq!(*seen.borrow(), vec![false]);
    window.dispose();
  });
}

/// Round 3, measure B, `onMaximizeChange`'s sentences. 1: a listener hears a change once, after it
/// happened, and the last value each listener heard is what `is_maximized` then returns, also when a
/// listener changes the state itself (once, or there and back), in either order of listeners.
#[test]
fn a_maximise_listener_hears_each_change_once_and_ends_with_the_windows_state() {
  on_ui_thread(|_runtime| {
    for (changer_first, there_and_back) in [(true, false), (false, false), (true, true), (false, true)] {
      let window = Window::create(WindowInit { frame: false, bounds: Some(Rect::new(140, 140, 320, 240)), ..init("rt sentence 1") }).expect("window");
      let changer = Window::adopt(window.handle()).expect("the changer's wrapper");
      let listener = Window::adopt(window.handle()).expect("the listener's wrapper");
      let toggler = Rc::new(Window::adopt(window.handle()).expect("a wrapper to toggle with"));
      let (by_changer, by_listener) = (Rc::new(RefCell::new(Vec::new())), Rc::new(RefCell::new(Vec::new())));
      let register_changer = || {
        let (sink, toggle, done) = (by_changer.clone(), toggler.clone(), Rc::new(Cell::new(false)));
        changer
          .on_maximize_change(changer.id, Some(Rc::new(move |maximized| {
            sink.borrow_mut().push(maximized);
            if maximized && !done.replace(true) {
              toggle.toggle_maximize().expect("restore");
              if there_and_back {
                toggle.toggle_maximize().expect("and maximise again");
              }
            }
          })))
          .expect("changer");
      };
      let register_listener = || {
        let sink = by_listener.clone();
        listener.on_maximize_change(listener.id, Some(Rc::new(move |maximized| sink.borrow_mut().push(maximized)))).expect("listener");
      };
      if changer_first {
        register_changer();
        register_listener();
      } else {
        register_listener();
        register_changer();
      }
      window.toggle_maximize().expect("maximise");
      let state = window.is_maximized();
      assert_eq!(state, there_and_back);
      for heard in [&by_changer, &by_listener] {
        let heard = heard.borrow();
        assert_eq!(heard.last(), Some(&state), "first {changer_first}, back {there_and_back}: {heard:?}");
        // Never the same change twice in a row.
        assert!(heard.windows(2).all(|pair| pair[0] != pair[1]), "first {changer_first}, back {there_and_back}: {heard:?}");
      }
      for wrapper in [&changer, &listener] {
        wrapper.dispose();
      }
      toggler.dispose();
      window.dispose();
    }
  });
}

/// Sentence 2: a change goes to the listeners subscribed when it happened. One removed, or the
/// window disposed, during delivery hears nothing more; one added during delivery does not hear it.
#[test]
fn a_maximise_change_goes_to_the_listeners_subscribed_when_it_happened() {
  on_ui_thread(|_runtime| {
    // Removed by the listener before it.
    let window = Window::create(WindowInit { frame: false, bounds: Some(Rect::new(140, 140, 320, 240)), ..init("rt sentence 2") }).expect("window");
    let first = Rc::new(Window::adopt(window.handle()).expect("first"));
    let second = Rc::new(Window::adopt(window.handle()).expect("second"));
    let late = Rc::new(Window::adopt(window.handle()).expect("late"));
    let heard_second = Rc::new(RefCell::new(Vec::new()));
    let heard_late = Rc::new(RefCell::new(Vec::new()));
    let (remove, add, late_sink) = (second.clone(), late.clone(), heard_late.clone());
    first
      .on_maximize_change(first.id, Some(Rc::new(move |_| {
        remove.on_maximize_change(remove.id, None).expect("remove the second");
        let sink = late_sink.clone();
        add.on_maximize_change(add.id, Some(Rc::new(move |maximized| sink.borrow_mut().push(maximized)))).expect("add one late");
      })))
      .expect("first");
    let sink = heard_second.clone();
    second.on_maximize_change(second.id, Some(Rc::new(move |maximized| sink.borrow_mut().push(maximized)))).expect("second");
    window.toggle_maximize().expect("maximise");
    assert_eq!(*heard_second.borrow(), Vec::<bool>::new(), "removed during delivery");
    assert_eq!(*heard_late.borrow(), Vec::<bool>::new(), "added during delivery");
    first.on_maximize_change(first.id, None).expect("first removed");
    window.toggle_maximize().expect("restore");
    assert_eq!(*heard_late.borrow(), vec![false], "the next change reaches the late one");
    for w in [&first, &second, &late] {
      w.dispose();
    }
    window.dispose();

    // The window disposed by the listener before it.
    let window = Rc::new(Window::create(WindowInit { frame: false, bounds: Some(Rect::new(140, 140, 320, 240)), ..init("rt sentence 2 dispose") }).expect("window"));
    let other = Window::adopt(window.handle()).expect("other");
    let owner = window.clone();
    window.on_maximize_change(window.id, Some(Rc::new(move |_| owner.dispose()))).expect("disposer");
    let heard = Rc::new(RefCell::new(Vec::new()));
    let sink = heard.clone();
    other.on_maximize_change(other.id, Some(Rc::new(move |maximized| sink.borrow_mut().push(maximized)))).expect("other");
    window.toggle_maximize().expect("maximise");
    assert_eq!(*heard.borrow(), Vec::<bool>::new(), "the window was disposed during delivery");
    other.dispose();
  });
}

/// Sentence 3: a listener that changes the state every time it is told does not hang the
/// application: the change made while it is told of its own change is not told (a fault, printed),
/// and the window stays usable.
#[test]
fn a_maximise_listener_that_changes_the_state_every_time_does_not_hang() {
  on_ui_thread(|_runtime| {
    let window = Window::create(WindowInit { frame: false, bounds: Some(Rect::new(140, 140, 320, 240)), ..init("rt sentence 3") }).expect("window");
    let runaway = Window::adopt(window.handle()).expect("runaway");
    let toggler = Rc::new(Window::adopt(window.handle()).expect("toggler"));
    let toggle = toggler.clone();
    let calls = Rc::new(Cell::new(0));
    let count = calls.clone();
    runaway
      .on_maximize_change(runaway.id, Some(Rc::new(move |_| {
        count.set(count.get() + 1);
        toggle.toggle_maximize().expect("toggle");
      })))
      .expect("runaway");
    window.toggle_maximize().expect("maximise");
    assert!(calls.get() <= 2, "told {} times", calls.get());
    runaway.on_maximize_change(runaway.id, None).expect("removed");
    // Usable: its state is its own, and the next change is told.
    let seen = Rc::new(RefCell::new(Vec::new()));
    let sink = seen.clone();
    window.on_maximize_change(window.id, Some(Rc::new(move |maximized| sink.borrow_mut().push(maximized)))).expect("listener");
    let before = window.is_maximized();
    window.toggle_maximize().expect("toggle");
    assert_eq!(*seen.borrow(), vec![!before]);
    runaway.dispose();
    toggler.dispose();
    window.dispose();
  });
}
/// Review round 2, M6: a frameless window whose minimum size is larger than the work area is
/// maximised by `toggle_maximize`, as at tag `pre-rust-rewrite`, and the next toggle gives back the
/// bounds it had. Not reproduced: the minimum applies to the OS's sizing, not to Sweetview's own
/// `set_bounds`, so the maximised bounds are the work area.
#[test]
fn a_frameless_maximise_larger_than_the_work_area_is_still_a_maximise() {
  on_ui_thread(|_runtime| {
    let area = screen::primary().expect("primary").work_area;
    let start = Rect::new(area.x + 100, area.y + 100, 400, 300);
    let window = Window::create(WindowInit { frame: false, bounds: Some(start), min_width: Some(area.width + 600), ..init("rt big minimum") }).expect("window");
    let start = window.bounds(); // the minimum applies from the start
    window.toggle_maximize().expect("maximise");
    assert!(window.is_maximized(), "maximised: {:?}", window.bounds());
    assert_eq!(window.bounds(), area, "maximised to the work area");
    window.toggle_maximize().expect("restore");
    assert_eq!((window.is_maximized(), window.bounds()), (false, start));
    window.dispose();
  });
}

/// Review round 2, finding 5. Class: wrapping an application's own window in every state (normal,
/// maximised, minimised from normal, minimised from maximised): restoring it to the state it was
/// in reports nothing, and a real change after that reports once.
#[test]
fn a_window_wrapped_in_any_state_reports_only_real_maximise_changes() {
  on_ui_thread(|runtime| {
    for (maximised, minimised) in [(false, false), (true, false), (false, true), (true, true)] {
      // The application's own window: made here with `tao`, not by `Window::create`.
      let own = runtime
        .with_target(|target| tao::window::WindowBuilder::new().with_title("rt own wrapped state").with_inner_size(tao::dpi::PhysicalSize::new(300, 200)).build(target))
        .expect("target")
        .expect("window");
      own.set_maximized(maximised);
      own.set_minimized(minimised);
      runtime.pump();
      let wrapped = Window::adopt(platform::handle_value(&own)).expect("adopt");
      let seen = Rc::new(RefCell::new(Vec::new()));
      let sink = seen.clone();
      wrapped.on_maximize_change(wrapped.id, Some(Rc::new(move |maximized| sink.borrow_mut().push(maximized)))).expect("listener");
      own.set_minimized(false);
      runtime.pump();
      assert_eq!(*seen.borrow(), Vec::<bool>::new(), "maximised {maximised}, minimised {minimised}: restoring to its state is no change");
      own.set_maximized(!maximised);
      runtime.pump();
      assert_eq!(*seen.borrow(), vec![!maximised], "maximised {maximised}, minimised {minimised}");
      wrapped.dispose();
      drop(own);
    }
  });
}

#[test]
fn adopting_a_handle_that_is_not_a_window_fails() {
  on_ui_thread(|_runtime| {
    assert!(Window::adopt(0).is_err());
    assert!(Window::adopt(1).is_err());
    assert!(with_mount_target(1, |_| ()).is_none());
  });
}

#[test]
fn owned_windows_give_every_handle_back() {
  on_ui_thread(|runtime| {
    let ico = test_ico();
    let mut i = 0u32;
    sweetview_platform_loop::testing::assert_gives_back_every_handle(40, || {
      i += 1;
      let w = Window::create(WindowInit { opacity: Some(0.9), hide_from_taskbar: i % 2 == 0, icon: Some(ico.clone()), ..init("rt count") })
        .expect("window");
      w.on_resize(w.id, Some(Rc::new(|_| {}))).expect("resize");
      w.set_hit_regions(Some(vec![]), None).expect("regions");
      let borrowed = Window::adopt(w.handle()).expect("adopt");
      assert!(with_mount_target(w.handle(), |_| ()).is_some());
      borrowed.dispose();
      w.dispose();
      runtime.pump();
    });
  });
}

/// A `.ico` with one 16 by 16 image, made with the `ico` crate.
fn test_ico() -> Vec<u8> {
  let image = ico::IconImage::from_rgba_data(16, 16, [0x40, 0x80, 0xff, 0xff].repeat(16 * 16));
  let mut dir = ico::IconDir::new(ico::ResourceType::Icon);
  dir.add_entry(ico::IconDirEntry::encode(&image).expect("encode"));
  let mut bytes = Vec::new();
  dir.write(&mut bytes).expect("write");
  bytes
}

/// An application's own window given icons through `Window.fromHandle(h).setIcon(...)`
/// and then released still shows valid icons: releasing the wrapper does not
/// destroy icons a live window draws.
#[test]
fn an_adopted_window_keeps_valid_icons_after_it_is_released() {
  on_ui_thread(|runtime| {
    // The application's own window: made here with `tao`, not by `Window::create`.
    let own = runtime
      .with_target(|target| tao::window::WindowBuilder::new().with_visible(false).with_title("rt own window").build(target))
      .expect("target")
      .expect("window");
    let handle = platform::handle_value(&own);
    let adopted = Window::adopt(handle).expect("adopt");
    adopted.set_icon(Some(&test_ico())).expect("icon");
    assert!(platform::test_support::shows_valid_icons(&own));
    adopted.dispose();
    assert_eq!(tracked_count(handle), 0, "released");
    assert!(alive(handle), "the application's window lives on");
    assert!(platform::test_support::shows_valid_icons(&own), "its icons are still valid after the release");
    drop(adopted);
    drop(own);
  });
}


#[test]
fn a_tab_frame_keeps_the_system_frame_and_lays_out_a_strip_and_a_page() {
  use tab_frame::TabFrame;
  const WS_THICKFRAME: u32 = 0x0004_0000;
  const WS_MAXIMIZEBOX: u32 = 0x0001_0000;
  const WS_CAPTION: u32 = 0x00c0_0000;
  on_ui_thread(|_runtime| {
    let frame = Window::create(WindowInit { tab_strip_height: Some(40), appearance: Appearance::Dark, ..init("rt tab frame") }).expect("frame");
    let fixed = Window::create(WindowInit { tab_strip_height: Some(40), resizable: false, appearance: Appearance::Light, ..init("rt fixed tab frame") })
      .expect("fixed frame");
    let plain = Window::create(init("rt plain")).expect("plain");
    assert!(TabFrame::of(plain.handle()).is_none(), "only frames are tab frames");
    let tabs = TabFrame::of(frame.handle()).expect("a tab frame");
    assert_eq!(TabFrame::all().len(), 2);

    // The caption and the resize border stay in the styles: snap, maximise and the system menu are the system's.
    let style = native(&frame, |w| platform::style(w));
    assert_eq!(style & (WS_CAPTION | WS_THICKFRAME | WS_MAXIMIZEBOX), WS_CAPTION | WS_THICKFRAME | WS_MAXIMIZEBOX);
    assert_eq!(style & platform::FRAME_STYLE, platform::FRAME_STYLE, "children are clipped");
    assert_eq!(native(&fixed, |w| platform::style(w)) & (WS_THICKFRAME | WS_MAXIMIZEBOX), 0);

    // With no bounds: a 1040 x 720 page under a 40 pixel strip, at the window's scale.
    let scale = frame.scale();
    let strip = tabs.strip_rect();
    let page = tabs.page_rect();
    assert_eq!(strip, Rect::new(0, 0, (1040.0 * scale).round() as i32, (40.0 * scale).round() as i32));
    assert_eq!(page, Rect::new(0, strip.height, strip.width, (720.0 * scale).round() as i32));
    // The caption is gone: the client area reaches the top of the frame (less the one pixel line Windows 11 draws).
    let outer = frame.bounds();
    let on_screen = tabs.strip_screen_rect();
    assert!(on_screen.y - outer.y <= (scale.round() as i32), "strip starts at the top: {on_screen:?} in {outer:?}");

    assert!(tabs.is_dark());
    let light = TabFrame::of(fixed.handle()).expect("a tab frame");
    light.set_system_dark(true);
    assert!(!light.is_dark(), "an explicit appearance ignores the system");

    let activations = Rc::new(RefCell::new(Vec::new()));
    let sink = activations.clone();
    tabs.on_activate(Some(Rc::new(move |active| sink.borrow_mut().push(active))));
    assert!(!tabs.is_foreground());

    let handle = frame.handle();
    frame.dispose();
    assert!(TabFrame::of(handle).is_none());
    assert!(!tabs.is_live());
    assert_eq!(tracked_count(handle), 0);
    fixed.dispose();
    plain.dispose();
    assert!(TabFrame::all().is_empty());
  });
}

/// A window disposed from inside a call into `tao` (a listener run by `set_bounds`, say) waits for
/// a later turn to be destroyed. When the application ends in that same turn, the job never
/// runs: the release must destroy it all the same.
#[test]
fn a_window_disposed_while_a_call_holds_it_is_destroyed_by_the_release_in_the_same_turn() {
  on_ui_thread(|_runtime| {
    let window = Window::create(WindowInit { no_activate: true, bounds: Some(Rect::new(-2000, -2000, 200, 200)), ..init("rt held") }).expect("window");
    let handle = window.handle();
    // What a call into `tao` further up the stack holds while a listener runs.
    let held = core_of(handle).and_then(|core| core.tao.borrow().clone()).expect("the window's tao window");
    window.dispose();
    assert!(alive(handle), "held further up the stack, its destroy waits for a later turn");
    // The call returns; no turn of the loop runs before the application ends.
    drop(held);
    crate::lifetime::release_all();
    assert!(!alive(handle), "the release destroyed the window whose destroy was waiting");
  });
}
