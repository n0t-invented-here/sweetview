//! The UI thread's loop under the conditions real applications put it in, with real OS input
//! and read-back: a tray's menu opened by a right click, the application's own window clicked
//! and repainted behind a busy timer, and the application's own modal loops (a message box, a
//! popup menu) opened from a page's call.
//! Each runs in both loop modes where the mode matters: the blocking run, and the loop pumped in
//! short bursts as `pumpEvents` from a Bun timer.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use sweetview_platform_window::test_support as os;
use sweetview_platform_window::{end_menu_for_tests, escape_menus_of_this_process_for_tests};

use crate::runtime::testing::on_ui_thread;
use crate::runtime::{Runtime, TimeoutId};

/// The two ways an application runs the loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
  Blocking,
  Pumped,
}

/// Runs the loop in `mode` until `done`, or for at most `limit`: the blocking run until a job
/// asks it to end (`finish` below), or a pump every `pump_every`.
fn run_loop(runtime: &Rc<Runtime>, mode: Mode, done: &Cell<bool>, pump_every: Duration, limit: Duration) {
  match mode {
    Mode::Blocking => {
      let quitter = runtime.clone();
      let limit = runtime.set_timeout(limit.as_millis() as u32, move || quitter.request_exit()).expect("limit");
      runtime.run_blocking().expect("blocking run");
      runtime.clear_timeout(limit);
    }
    Mode::Pumped => {
      let deadline = Instant::now() + limit;
      while !done.get() && Instant::now() < deadline {
        runtime.pump();
        std::thread::sleep(pump_every);
      }
    }
  }
}

/// Marks the run done; the blocking run is asked to end.
fn finish(runtime: &Runtime, mode: Mode, done: &Cell<bool>) {
  done.set(true);
  if mode == Mode::Blocking {
    runtime.request_exit();
  }
}

/// Webviews made by these tests keep their profile in the system temp folder, not in
/// `%APPDATA%\<test executable>`, which would be a new folder for every build.
pub(crate) fn use_test_webview_profile() {
  static SET: OnceLock<()> = OnceLock::new();
  SET.get_or_init(|| std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", std::env::temp_dir().join("sweetview-runtime-tests-webview2")));
}

// ---- a tray's menu, opened by a right click, with timers due (D38) -------------------------------

/// The message `tray-icon` gives the shell for its icon's mouse events, with the mouse message
/// in the low word of `lParam` (`tray-icon`'s own constant, not exported).
const WM_USER_TRAYICON: u32 = 6002;
const WM_RBUTTONDOWN: isize = 0x0204;
const WM_RBUTTONUP: isize = 0x0205;

/// One menu: how often the interval ticked while it was open, and when first.
#[derive(Debug, Clone, Copy)]
struct MenuRound {
  ticks: u32,
  first_tick: Option<Duration>,
  rescued: bool,
}

/// What the tray's menu function and the rounds share.
#[derive(Default)]
struct TrayMenuState {
  /// The menu function has run for this round: the menu is about to open.
  opening: Cell<bool>,
  opened_at: Cell<Option<Instant>>,
  ticks: Cell<u32>,
  first_tick: Cell<Option<Duration>>,
  rounds: RefCell<Vec<MenuRound>>,
  /// Rounds played again because something else on the shared desktop closed the menu before
  /// the interval's third tick (it ends the menu itself after three).
  replayed: Cell<u32>,
  done: Cell<bool>,
}

/// D38 (the second review's G1): with native timers on `WM_TIMER`, a tray menu opened from a
/// deferred job, with every timer already due when its loop first looked at the queue, took
/// `tao`'s paint request for idle and waited with the timers due. Here a real `Tray` gets the
/// right click the shell posts; its menu function waits longer than the interval's period and the
/// pump guard's before it returns, so every timer is due when the menu's loop first looks. An
/// interval set just before the click must tick inside every menu, its first tick within 250 ms of
/// the opening (the period is 10 ms). A menu still open 1.5 s after it opened is closed with
/// Escape by a watchdog and counted, so a menu whose loop delivers nothing fails the test. A menu
/// something else on the shared desktop closes before the third tick is played again (at most
/// three times a mode), not judged.
#[test]
fn an_interval_set_just_before_a_right_click_ticks_inside_every_tray_menu_in_both_loop_modes() {
  use crate::menu::MenuItem;
  use crate::tray::{Tray, TrayInit};
  const ROUNDS: usize = 8;
  const FIRST_TICK_LIMIT: Duration = Duration::from_millis(250);
  on_ui_thread(|runtime| {
    let start = Instant::now();
    let armed = Arc::new(AtomicI64::new(-1));
    let rescues = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let watchdog = {
      let (armed, rescues, stop) = (armed.clone(), rescues.clone(), stop.clone());
      std::thread::spawn(move || {
        while !stop.load(Ordering::SeqCst) {
          std::thread::sleep(Duration::from_millis(20));
          let at = armed.load(Ordering::SeqCst);
          if at >= 0 && start.elapsed().as_millis() as i64 - at > 1500 && escape_menus_of_this_process_for_tests() > 0 {
            rescues.fetch_add(1, Ordering::SeqCst);
            armed.store(-1, Ordering::SeqCst);
          }
        }
      })
    };
    let mut report = Vec::new();
    for mode in [Mode::Blocking, Mode::Pumped] {
      let state = Rc::new(TrayMenuState::default());
      let (opening, armed_by_menu) = (state.clone(), armed.clone());
      let tray = Tray::new(TrayInit {
        tooltip: format!("sweetview runtime tray menu timers {}", std::process::id()),
        icon: None,
        has_menu: true,
        on_click: None,
        on_double_click: None,
        open_menu: Rc::new(move || {
          // Longer than the interval's 10 ms and the pump guard's 15 ms.
          std::thread::sleep(Duration::from_millis(40));
          opening.opening.set(true);
          opening.opened_at.set(Some(Instant::now()));
          armed_by_menu.store(start.elapsed().as_millis() as i64, Ordering::SeqCst);
          vec![MenuItem::Item { id: 1, label: "One".into(), enabled: true, checked: false, icon: None }]
        }),
        menu_chosen: Rc::new(|_| {}),
      })
      .expect("tray");
      let tray_window = tray.window_handle_value();

      /// One round: an interval, then the right click; the next round once the menu has opened
      /// and closed again (or after 8 s).
      fn round(runtime: Rc<Runtime>, mode: Mode, state: Rc<TrayMenuState>, tray_window: isize, armed: Arc<AtomicI64>, rescues: Arc<AtomicUsize>) {
        if state.rounds.borrow().len() == ROUNDS {
          return finish(&runtime, mode, &state.done);
        }
        state.opening.set(false);
        state.opened_at.set(None);
        state.ticks.set(0);
        state.first_tick.set(None);
        let started = Instant::now();
        let rescued_before = rescues.load(Ordering::SeqCst);
        let ticking = state.clone();
        let interval = runtime
          .set_interval(10, move || {
            if !ticking.opening.get() || os::popup_menus_open() == 0 {
              return;
            }
            if ticking.ticks.get() == 0 {
              ticking.first_tick.set(ticking.opened_at.get().map(|at| at.elapsed()));
            }
            ticking.ticks.set(ticking.ticks.get() + 1);
            if ticking.ticks.get() == 3 {
              end_menu_for_tests();
            }
          })
          .expect("interval");
        assert!(os::post(tray_window, WM_USER_TRAYICON, 0, WM_RBUTTONDOWN) && os::post(tray_window, WM_USER_TRAYICON, 0, WM_RBUTTONUP), "the right click was posted to the tray's window");
        let watch_id: Rc<Cell<Option<TimeoutId>>> = Rc::default();
        let (own_id, inner) = (watch_id.clone(), runtime.clone());
        let watch = runtime
          .set_interval(20, move || {
            let over = (state.opening.get() && os::popup_menus_open() == 0) || started.elapsed() > Duration::from_secs(8);
            if !over {
              return;
            }
            if let Some(id) = own_id.take() {
              inner.clear_timeout(id);
            }
            inner.clear_timeout(interval);
            armed.store(-1, Ordering::SeqCst);
            let rescued = rescues.load(Ordering::SeqCst) > rescued_before;
            let closed_elsewhere = state.opening.get() && !rescued && state.ticks.get() < 3;
            if closed_elsewhere && state.replayed.get() < 3 {
              state.replayed.set(state.replayed.get() + 1);
            } else {
              state.rounds.borrow_mut().push(MenuRound { ticks: state.ticks.get(), first_tick: state.first_tick.get(), rescued });
            }
            let (runtime, state, armed, rescues) = (inner.clone(), state.clone(), armed.clone(), rescues.clone());
            inner.set_timeout(100, move || round(runtime, mode, state, tray_window, armed, rescues)).expect("next round");
          })
          .expect("watch");
        watch_id.set(Some(watch));
      }

      let (first, first_state, first_armed, first_rescues) = (runtime.clone(), state.clone(), armed.clone(), rescues.clone());
      runtime.set_timeout(300, move || round(first, mode, first_state, tray_window, first_armed, first_rescues)).expect("first round");
      run_loop(&runtime, mode, &state.done, Duration::from_millis(5), Duration::from_secs(90));
      tray.dispose();
      eprintln!("{mode:?}: {} rounds played again after something else closed the menu", state.replayed.get());
      report.push((mode, state.done.get(), state.rounds.borrow().clone()));
    }
    stop.store(true, Ordering::SeqCst);
    watchdog.join().expect("watchdog");
    for (mode, done, rounds) in &report {
      eprintln!("{mode:?}: {rounds:?}");
      assert!(*done && rounds.len() == ROUNDS, "{mode:?}: every round ran ({} of {ROUNDS})", rounds.len());
      for (i, played) in rounds.iter().enumerate() {
        assert!(!played.rescued, "{mode:?} round {i}: the watchdog had to close the menu: {played:?}");
        assert!(played.ticks >= 3, "{mode:?} round {i}: the interval ticked inside the menu: {played:?}");
        assert!(played.first_tick.is_some_and(|first| first <= FIRST_TICK_LIMIT), "{mode:?} round {i}: the first tick came within {FIRST_TICK_LIMIT:?} of the opening: {played:?}");
      }
    }
  });
}

// ---- a busy interval and the application's own window (D38) --------------------------------------

const WM_PAINT: u32 = 0x000f;
const WM_LBUTTONDOWN: u32 = 0x0201;

/// What the busy-interval rounds share with the window's procedure.
#[derive(Default)]
struct BusyState {
  ticks: Cell<u32>,
  asked_input: Cell<Option<Instant>>,
  asked_paint: Cell<Option<Instant>>,
  input: RefCell<Vec<Duration>>,
  paint: RefCell<Vec<Duration>>,
  round: Cell<usize>,
  tries: Cell<u32>,
  not_run: RefCell<Option<String>>,
  done: Cell<bool>,
}

/// D38 (the third review's H1): ticks are posted messages, which come ahead of input and paint;
/// a timer's next period starts when its job returns, and a tick taken while input waits is
/// posted again shortly after, so a 10 ms interval whose job takes 15 ms leaves a window its input
/// and paint. A window of the application's own (its own class and procedure, as one made through
/// `bun:ffi` is), shown at a fixed place, is clicked with real input and asked to repaint, in
/// turns; each wait, from the request to the procedure's `WM_LBUTTONDOWN` or `WM_PAINT`, must
/// stay within 100 ms. Before, the next tick was always queued when the job returned.
#[test]
fn a_busy_interval_leaves_the_applications_own_window_its_input_and_paint_in_both_loop_modes() {
  const ROUNDS: usize = 10;
  const LIMIT: Duration = Duration::from_millis(100);
  const AT: (i32, i32, i32, i32) = (240, 240, 320, 220);
  const CENTRE: (i32, i32) = (AT.0 + AT.2 / 2, AT.1 + AT.3 / 2);
  on_ui_thread(|runtime| {
    let original = os::cursor();
    let mut report = Vec::new();
    for mode in [Mode::Blocking, Mode::Pumped] {
      let state = Rc::new(BusyState::default());
      let seen = state.clone();
      let own = Rc::new(
        os::OwnWindow::new("sweetview runtime busy interval", AT, move |message| {
          if message == WM_LBUTTONDOWN {
            if let Some(at) = seen.asked_input.take() {
              seen.input.borrow_mut().push(at.elapsed());
            }
          } else if message == WM_PAINT {
            if let Some(at) = seen.asked_paint.take() {
              seen.paint.borrow_mut().push(at.elapsed());
            }
          }
        })
        .expect("the application's own window"),
      );
      os::take_foreground(own.handle_value());
      let ticking = state.clone();
      let interval = runtime
        .set_interval(10, move || {
          ticking.ticks.set(ticking.ticks.get() + 1);
          std::thread::sleep(Duration::from_millis(15));
        })
        .expect("interval");

      fn step(runtime: Rc<Runtime>, mode: Mode, state: Rc<BusyState>, own: Rc<os::OwnWindow>) {
        let again = |ms: u32, runtime: &Rc<Runtime>, state: &Rc<BusyState>, own: &Rc<os::OwnWindow>| {
          let (next, state, own) = (runtime.clone(), state.clone(), own.clone());
          runtime.set_timeout(ms, move || step(next, mode, state, own)).expect("step");
        };
        let waiting = state.asked_input.get().or(state.asked_paint.get());
        if let Some(asked) = waiting {
          // The last request is still waiting: look again shortly, at most 2 s in all.
          if asked.elapsed() > Duration::from_secs(2) {
            return finish(&runtime, mode, &state.done);
          }
          return again(20, &runtime, &state, &own);
        }
        if state.round.get() >= ROUNDS {
          return finish(&runtime, mode, &state.done);
        }
        if state.round.get() % 2 == 0 {
          os::set_cursor(CENTRE.0, CENTRE.1);
          if os::window_at(CENTRE.0, CENTRE.1) != own.handle_value() || os::buttons_down() {
            state.tries.set(state.tries.get() + 1);
            if state.tries.get() > 20 {
              *state.not_run.borrow_mut() = Some(format!(
                "the window was not under the cursor (window {:#x} is), or a button was held, on the shared desktop",
                os::window_at(CENTRE.0, CENTRE.1)
              ));
              return finish(&runtime, mode, &state.done);
            }
            return again(100, &runtime, &state, &own);
          }
          state.asked_input.set(Some(Instant::now()));
          os::send_left_button(true);
          os::send_left_button(false);
        } else {
          state.asked_paint.set(Some(Instant::now()));
          own.invalidate();
        }
        state.round.set(state.round.get() + 1);
        again(120, &runtime, &state, &own);
      }

      let (first, first_state, first_own) = (runtime.clone(), state.clone(), own.clone());
      runtime.set_timeout(400, move || step(first, mode, first_state, first_own)).expect("first step");
      run_loop(&runtime, mode, &state.done, Duration::from_millis(2), Duration::from_secs(60));
      runtime.clear_timeout(interval);
      os::send_left_button(false);
      drop(own);
      report.push((mode, state));
    }
    os::set_cursor(original.0, original.1);
    for (mode, state) in &report {
      let (input, paint) = (state.input.borrow(), state.paint.borrow());
      eprintln!("{mode:?}: {} ticks; input waited {input:?}; paint waited {paint:?}", state.ticks.get());
      if let Some(why) = state.not_run.borrow().as_ref() {
        panic!("{mode:?}: refused to judge: {why}; run again");
      }
      assert!(state.ticks.get() >= 20, "{mode:?}: the interval ran ({} ticks)", state.ticks.get());
      assert_eq!((input.len(), paint.len()), (ROUNDS / 2, ROUNDS / 2), "{mode:?}: every click and every repaint arrived");
      for waited in input.iter().chain(paint.iter()) {
        assert!(*waited <= LIMIT, "{mode:?}: a request waited {waited:?} behind the interval: input {input:?}, paint {paint:?}");
      }
    }
  });
}

// ---- the application's own modal loops, opened from a page's call (W1.8) ----------------------------

/// Which of the application's modal loops is open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Modal {
  Box,
  Menu,
}

impl Modal {
  fn name(self) -> &'static str {
    match self {
      Modal::Box => "box",
      Modal::Menu => "menu",
    }
  }
}

/// Counted only while that modal loop is open. `replies_seen_by_page`: the page reported an
/// answer it received to a call made while that loop was open, and the report arrived while it
/// still was.
#[derive(Debug, Default, Clone, Copy)]
struct Inside {
  page_calls: u32,
  replies_seen_by_page: u32,
  drains: u32,
  timeouts: u32,
}

impl Inside {
  fn complete(&self) -> bool {
    self.page_calls >= 3 && self.replies_seen_by_page >= 3 && self.drains >= 1 && self.timeouts >= 1
  }
}

#[derive(Default)]
struct ModalState {
  open: Cell<Option<Modal>>,
  inside_box: Cell<Inside>,
  inside_menu: Cell<Inside>,
  box_returned: Cell<bool>,
  menu_returned: Cell<Option<i32>>,
  /// What the other thread wrote, in the order the drains read it.
  frames: RefCell<Vec<String>>,
  done: Cell<bool>,
}

impl ModalState {
  /// Counts into the loop that is open, if any.
  fn count(&self, f: impl FnOnce(&mut Inside)) {
    let cell = match self.open.get() {
      Some(Modal::Box) => &self.inside_box,
      Some(Modal::Menu) => &self.inside_menu,
      None => return,
    };
    let mut inside = cell.get();
    f(&mut inside);
    cell.set(inside);
  }

  fn inside(&self, modal: Modal) -> Inside {
    match modal {
      Modal::Box => self.inside_box.get(),
      Modal::Menu => self.inside_menu.get(),
    }
  }
}

/// The wake token the other thread's writes are drained under.
const DRAIN_TOKEN: u64 = 7801;

/// Checklist item W1.8: a handler run on the UI thread (a page's call) opens a modal loop of the
/// application's own and, while it is open, the page's calls are still answered and the answers
/// reach the page, another thread's wake still drains (what a `Worker` does) and a native timeout
/// still fires. Two modal loops, one after the other: a message box, then a popup menu made and
/// tracked with the OS's own calls; a native interval inside each closes it (`WM_CLOSE` posted to
/// the box, `EndMenu` for the menu) once all of that has happened, or after 6 s.
#[test]
#[cfg(feature = "webview")]
fn page_calls_wakes_and_timeouts_are_served_inside_the_applications_own_modal_loops_in_both_loop_modes() {
  use crate::engine::{Engine, Host, SizeHint};
  use_test_webview_profile();
  on_ui_thread(|runtime| {
    for mode in [Mode::Blocking, Mode::Pumped] {
      let state = Rc::new(ModalState::default());
      let box_title = format!("sweetview runtime modal test {} {mode:?}", std::process::id());
      // The other thread: writes what it is asked to, then wakes the UI thread, as a Worker does.
      // `None` ends it.
      let written: Arc<Mutex<Vec<String>>> = Arc::default();
      let (ask, asked) = mpsc::channel::<Option<String>>();
      let stop_writer = ask.clone();
      let writer = {
        let written = written.clone();
        std::thread::spawn(move || {
          while let Ok(Some(text)) = asked.recv() {
            written.lock().expect("frames").push(text);
            crate::wake(DRAIN_TOKEN);
          }
        })
      };
      let drained = state.clone();
      runtime.set_drain(
        DRAIN_TOKEN,
        Some(Rc::new(move || {
          let frames: Vec<String> = std::mem::take(&mut *written.lock().expect("frames"));
          if !frames.is_empty() {
            drained.count(|inside| inside.drains += 1);
            drained.frames.borrow_mut().extend(frames);
          }
        })),
      );

      let engine = Engine::create(false, Host::Own, None).expect("webview");
      engine.set_title("sweetview runtime modal test");
      // While `modal` is open: a native timeout fires and asks the other thread to write and wake;
      // an interval closes the loop once everything has happened inside it, or after 6 s.
      let inside_loop = {
        let (runtime, state) = (runtime.clone(), state.clone());
        move |modal: Modal, close: Rc<dyn Fn()>| {
          let (timed, ask) = (state.clone(), ask.clone());
          runtime
            .set_timeout(150, move || {
              timed.count(|inside| inside.timeouts += 1);
              let _ = ask.send(Some(format!("written while the {} was open", modal.name())));
            })
            .expect("timeout");
          let opened = Instant::now();
          let closer: Rc<Cell<Option<TimeoutId>>> = Rc::default();
          let (own, inner, watched) = (closer.clone(), runtime.clone(), state.clone());
          let id = runtime
            .set_interval(50, move || {
              if !watched.inside(modal).complete() && opened.elapsed() < Duration::from_secs(6) {
                return;
              }
              close();
              if let Some(id) = own.take() {
                inner.clear_timeout(id);
              }
            })
            .expect("closer");
          closer.set(Some(id));
        }
      };
      // The bindings name the webview by its id: a clone of it in its own bindings would keep it alive.
      let id = engine.id();
      let reply = move |seq: &str, json: &str| {
        if let Some(engine) = Engine::from_id(id) {
          engine.return_value(seq, 0, json);
        }
      };
      {
        let state = state.clone();
        engine.bind(
          "ping",
          Rc::new(move |seq, _| {
            state.count(|inside| inside.page_calls += 1);
            let answer = state.open.get().map_or("null".to_owned(), |modal| format!("\"{}\"", modal.name()));
            reply(seq, &answer);
          }),
        );
      }
      {
        let state = state.clone();
        engine.bind(
          "record",
          Rc::new(move |seq, params| {
            let answer: Vec<Option<String>> = serde_json::from_str(params).unwrap_or_default();
            if let (Some(Some(answer)), Some(open)) = (answer.first(), state.open.get()) {
              if answer == open.name() {
                state.count(|inside| inside.replies_seen_by_page += 1);
              }
            }
            reply(seq, "");
          }),
        );
      }
      {
        let (state, inside_loop, box_title) = (state.clone(), inside_loop.clone(), box_title.clone());
        engine.bind(
          "openModal",
          Rc::new(move |seq, _| {
            state.open.set(Some(Modal::Box));
            let title = box_title.clone();
            inside_loop(
              Modal::Box,
              Rc::new(move || {
                let found = os::window_titled(&title);
                if found != 0 {
                  os::post(found, 0x0010, 0, 0); // WM_CLOSE
                }
              }),
            );
            os::message_box("Open while the page keeps calling.", &box_title);
            state.open.set(None);
            state.box_returned.set(true);
            reply(seq, "\"closed\"");
          }),
        );
      }
      {
        let (state, inside_loop) = (state.clone(), inside_loop.clone());
        engine.bind(
          "openMenu",
          Rc::new(move |seq, _| {
            state.open.set(Some(Modal::Menu));
            inside_loop(
              Modal::Menu,
              Rc::new(|| {
                end_menu_for_tests();
              }),
            );
            // In front first, as an application does before `TrackPopupMenu`: a menu whose owner is
            // not in front is closed by the next activation anywhere on the shared desktop.
            let owner = Engine::from_id(id).map_or(0, |engine| engine.window_handle());
            os::take_foreground(owner);
            let chosen = os::own_popup_menu(owner);
            state.open.set(None);
            state.menu_returned.set(Some(chosen));
            reply(seq, "\"closed\"");
          }),
        );
      }
      {
        let (state, runtime) = (state.clone(), runtime.clone());
        engine.bind(
          "finish",
          Rc::new(move |seq, _| {
            reply(seq, "");
            finish(&runtime, mode, &state.done);
          }),
        );
      }
      engine.set_html(
        "<!doctype html><body><script>
          (async () => {
            const pinger = setInterval(() => { ping().then((answer) => record(answer)).catch(() => {}); }, 30);
            await openModal();
            await openMenu();
            clearInterval(pinger);
            await finish();
          })();
        </script>",
      );
      engine.set_size(420, 240, SizeHint::None);
      run_loop(&runtime, mode, &state.done, Duration::from_millis(8), Duration::from_secs(30));
      engine.destroy();
      runtime.set_drain(DRAIN_TOKEN, None);
      drop(inside_loop);
      let _ = stop_writer.send(None);
      writer.join().expect("the writing thread");
      let deadline = Instant::now() + Duration::from_millis(200);
      while Instant::now() < deadline {
        runtime.pump();
      }

      let (in_box, in_menu) = (state.inside_box.get(), state.inside_menu.get());
      eprintln!("{mode:?}: box {in_box:?}, menu {in_menu:?}, frames {:?}", state.frames.borrow());
      assert!(state.done.get(), "{mode:?}: the page finished");
      assert!(state.box_returned.get(), "{mode:?}: the message box closed and returned");
      assert!(in_box.complete(), "{mode:?}: inside the message box, page calls were answered and seen by the page, a wake drained and a timeout fired: {in_box:?}");
      assert_eq!(state.menu_returned.get(), Some(0), "{mode:?}: the popup menu was ended with nothing chosen");
      assert!(in_menu.complete(), "{mode:?}: inside the popup menu, the same: {in_menu:?}");
      assert_eq!(*state.frames.borrow(), ["written while the box was open", "written while the menu was open"], "{mode:?}");
    }
  });
}
