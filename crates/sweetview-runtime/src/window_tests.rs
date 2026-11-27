use std::cell::RefCell;

use sweetview_window_logic::style::{WS_EX_ACCEPTFILES, WS_EX_APPWINDOW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT};

use super::*;
use crate::runtime::testing::{on_ui_thread, pump_until};

const WS_EX_TOPMOST: u32 = 0x0000_0008;

fn init(title: &str) -> WindowInit {
  WindowInit { title: title.into(), frame: true, resizable: true, ..Default::default() }
}

fn native(window: &Window) -> ForeignWindow {
  ForeignWindow::from_handle_value(window.handle()).expect("a live window")
}

fn alive(handle: isize) -> bool {
  ForeignWindow::from_handle_value(handle).is_some()
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
    let ex = platform::ex_style(&native(&overlay));
    assert_eq!(ex & WS_EX_TOPMOST, WS_EX_TOPMOST, "topmost");
    assert_eq!(ex & (WS_EX_TOOLWINDOW | WS_EX_APPWINDOW), WS_EX_TOOLWINDOW, "off the taskbar");
    assert_eq!(ex & WS_EX_NOACTIVATE, WS_EX_NOACTIVATE, "no activation");
    assert_eq!(ex & WS_EX_LAYERED, WS_EX_LAYERED, "layered for the colour key and opacity");
    assert_eq!(ex & WS_EX_ACCEPTFILES, 0, "no drops without a listener");
    // `tao` rewrites the whole extended style when one of its flags changes.
    overlay.set_topmost(false);
    let ex = platform::ex_style(&native(&overlay));
    assert_eq!(ex & WS_EX_TOPMOST, 0);
    assert_eq!(ex & (WS_EX_TOOLWINDOW | WS_EX_APPWINDOW | WS_EX_LAYERED | WS_EX_ACCEPTFILES), WS_EX_TOOLWINDOW | WS_EX_LAYERED);
    overlay.set_topmost(true);
    assert_eq!(platform::ex_style(&native(&overlay)) & WS_EX_TOPMOST, WS_EX_TOPMOST);
    overlay.dispose();

    let plain = Window::create(init("rt plain")).expect("plain");
    let ex = platform::ex_style(&native(&plain));
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
    assert!(!platform::is_active(&native(&quiet)), "a noActivate window is shown without activation");
    // A later `tao` style rewrite (here: topmost) neither hides nor activates it.
    quiet.set_topmost(true);
    assert!(quiet.is_visible() && !platform::is_active(&native(&quiet)));
    quiet.minimize();
    assert!(platform::is_minimized(&native(&quiet)));
    quiet.show().expect("restore");
    assert!(!platform::is_minimized(&native(&quiet)) && quiet.is_visible());
    quiet.hide();
    assert!(!quiet.is_visible());
    quiet.dispose();

    let loud = Window::create(WindowInit { bounds: Some(Rect::new(-2000, -2000, 200, 200)), ..init("rt loud") }).expect("loud");
    loud.show().expect("show");
    assert!(platform::is_active(&native(&loud)), "an ordinary window is activated by show()");
    loud.dispose();
  });
}

#[test]
fn events_reach_every_wrapper_and_close_follows_the_listeners() {
  on_ui_thread(|_runtime| {
    let window = Window::create(WindowInit { bounds: Some(Rect::new(100, 100, 300, 200)), ..init("rt events") }).expect("window");
    let seen: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
    let (a, b, c) = (seen.clone(), seen.clone(), seen.clone());
    window.on_resize(Some(Rc::new(move |r| a.borrow_mut().push(format!("resize {}x{}", r.width, r.height))))).expect("resize");
    window.on_move(Some(Rc::new(move |r| b.borrow_mut().push(format!("move {},{}", r.x, r.y))))).expect("move");
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

fn send_close(window: &Window) {
  platform_send_close(&native(window));
}

/// `WM_CLOSE`, as the close button sends it. Reached through the platform
/// crate's own subclass test helper: the runtime has no unsafe.
fn platform_send_close(window: &ForeignWindow) {
  sweetview_platform_window::send_close_for_tests(window);
}

#[test]
fn click_through_and_hit_regions_set_the_style_bits() {
  on_ui_thread(|_runtime| {
    let window = Window::create(WindowInit { frame: false, ..init("rt hits") }).expect("window");
    let bits = || platform::ex_style(&native(&window)) & (WS_EX_TRANSPARENT | WS_EX_LAYERED);
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

#[test]
fn adopting_a_handle_that_is_not_a_window_fails() {
  on_ui_thread(|_runtime| {
    assert!(Window::adopt(0).is_err());
    assert!(Window::adopt(1).is_err());
    assert!(mount_target(1).is_none());
  });
}

#[test]
fn owned_windows_give_every_handle_back() {
  on_ui_thread(|runtime| {
    // One round first, so one-time costs (window classes, the theme, modules) are paid.
    for _ in 0..2 {
      let w = Window::create(init("rt warm")).expect("window");
      w.set_hit_regions(Some(vec![]), None).expect("regions");
      w.dispose();
    }
    runtime.pump();
    let before = platform::handle_counts();
    for i in 0..40 {
      let w = Window::create(WindowInit { opacity: Some(0.9), hide_from_taskbar: i % 2 == 0, ..init("rt count") }).expect("window");
      w.on_resize(Some(Rc::new(|_| {}))).expect("resize");
      w.set_hit_regions(Some(vec![]), None).expect("regions");
      let borrowed = Window::adopt(w.handle()).expect("adopt");
      assert!(mount_target(w.handle()).is_some());
      borrowed.dispose();
      w.dispose();
    }
    pump_until(&runtime, false_after_a_moment);
    let after = platform::handle_counts();
    assert_eq!(after.user_objects, before.user_objects, "USER objects returned to the starting count");
    assert_eq!(after.gdi_objects, before.gdi_objects, "GDI objects returned to the starting count");
    assert!(after.kernel_handles <= before.kernel_handles + 4, "kernel handles: {} then {}", before.kernel_handles, after.kernel_handles);
  });
}

thread_local! {
  static STARTED: Cell<Option<std::time::Instant>> = const { Cell::new(None) };
}

/// True once 100 ms have passed since its first call in this test.
fn false_after_a_moment() -> bool {
  STARTED.with(|s| {
    let start = s.get().unwrap_or_else(|| {
      let now = std::time::Instant::now();
      s.set(Some(now));
      now
    });
    start.elapsed() > std::time::Duration::from_millis(100)
  })
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
    let style = platform::style(&native(&frame));
    assert_eq!(style & (WS_CAPTION | WS_THICKFRAME | WS_MAXIMIZEBOX), WS_CAPTION | WS_THICKFRAME | WS_MAXIMIZEBOX);
    assert_eq!(style & platform::FRAME_STYLE, platform::FRAME_STYLE, "children are clipped");
    assert_eq!(platform::style(&native(&fixed)) & (WS_THICKFRAME | WS_MAXIMIZEBOX), 0);

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
