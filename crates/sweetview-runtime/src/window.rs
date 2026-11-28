//! Windows: the ones Sweetview makes through `tao`, and an application's own,
//! wrapped by handle (`Window.fromHandle`).
//!
//! One [`Core`] exists per native window, in a registry by handle value. It
//! holds the window's subclass (its events and extended-style policy), the
//! listeners every wrapper of it registered, its hit-region poll and its
//! resize gesture. A [`Window`] is one wrapper: the owner made by
//! [`Window::create`], or any number made by [`Window::adopt`]. Adopting one
//! of Sweetview's own windows finds its core, so the wrapper sees the real
//! window: its frame and resizability, its listeners, its default close.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::{Rc, Weak};

use sweetview_platform_window::{
  self as platform, BorrowedWindow, ExStylePolicy, FramePart, Placement, ShowAs, WindowEvent, WindowIcons, WindowSubclass, ZOrder,
};
use sweetview_window_logic::{self as logic, HitState, HitStep, MinSize};
use tao::dpi::{PhysicalPosition, PhysicalSize};
use tao::window::{Theme, WindowBuilder};

use crate::error::{Error, Result};
use crate::runtime::{Runtime, TimeoutId};
use crate::screen;
use crate::{Point, Rect, ResizeEdge};

pub use platform::{Chrome, GeometrySnapshot};
pub use sweetview_window_logic::Dips;

pub mod tab_frame;
use tab_frame::TabState;

/// How often the hit-region poll and the resize gesture read the cursor.
const POLL_MS: u32 = 10;

/// A framed window's title bar: light, dark, or following the system.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Appearance {
  #[default]
  System,
  Light,
  Dark,
}

impl Appearance {
  pub fn parse(name: &str) -> Option<Self> {
    Some(match name {
      "system" => Self::System,
      "light" => Self::Light,
      "dark" => Self::Dark,
      _ => return None,
    })
  }
}

/// Everything a new window is made with. Bounds are the outer frame.
#[derive(Debug, Clone, Default)]
pub struct WindowInit {
  pub title: String,
  /// Default: 320 x 240, centred on the primary monitor's work area.
  pub bounds: Option<Rect>,
  /// The client area (a tab frame's: the page below the strip) in
  /// device-independent pixels, at the scale of the screen the window opens
  /// on; the window is centred on the primary monitor's work area. Not with
  /// `bounds`.
  pub content_size: Option<logic::Dips>,
  /// `#rrggbb`: what the window shows where nothing has painted. `None`: what
  /// the system or `appearance` gives. Not applied to a transparent window.
  pub background_color: Option<String>,
  pub min_width: Option<i32>,
  pub min_height: Option<i32>,
  pub frame: bool,
  pub resizable: bool,
  pub appearance: Appearance,
  /// `.ico` bytes for the caption and taskbar icons.
  pub icon: Option<Vec<u8>>,
  pub transparent: bool,
  /// `#rrggbb`: pixels of exactly this colour are transparent and click-through.
  pub color_key: Option<String>,
  /// Whole-window opacity, 0 to 1.
  pub opacity: Option<f64>,
  pub topmost: bool,
  pub hide_from_taskbar: bool,
  pub no_activate: bool,
  /// Makes the window the frame of a tabbed window: its caption is removed
  /// and the top `tab_strip_height` device-independent pixels are the tab
  /// strip. `frame`, `transparent` and `color_key` do not apply to it.
  /// Default bounds: a 1040 x 720 page plus the strip, centred.
  pub tab_strip_height: Option<u32>,
}

pub type RectListener = Rc<dyn Fn(Rect)>;
pub type Listener = Rc<dyn Fn()>;
pub type DropListener = Rc<dyn Fn(Vec<String>)>;
/// Called with `true` when the window becomes maximised, `false` when it is restored.
pub type BoolListener = Rc<dyn Fn(bool)>;
/// Asked whether the window-local point `(x, y)` is solid; answered through
/// [`Window::answer_hit`] with the same sequence number.
pub type Refiner = Rc<dyn Fn(i32, i32, u32)>;

#[derive(Default)]
struct Listeners {
  resize: Vec<(u64, RectListener)>,
  moved: Vec<(u64, RectListener)>,
  close: Vec<(u64, Listener)>,
  drop: Vec<(u64, DropListener)>,
  maximize: Vec<(u64, BoolListener)>,
}

impl Listeners {
  fn len(&self) -> usize {
    self.resize.len() + self.moved.len() + self.close.len() + self.drop.len() + self.maximize.len()
  }

  fn remove_wrapper(&mut self, wrapper: u64) {
    self.maximize.retain(|(w, _)| *w != wrapper);
    self.resize.retain(|(w, _)| *w != wrapper);
    self.moved.retain(|(w, _)| *w != wrapper);
    self.close.retain(|(w, _)| *w != wrapper);
    self.drop.retain(|(w, _)| *w != wrapper);
  }
}

fn set_listener<T: ?Sized>(list: &mut Vec<(u64, Rc<T>)>, wrapper: u64, listener: Option<Rc<T>>) {
  list.retain(|(w, _)| *w != wrapper);
  if let Some(listener) = listener {
    list.push((wrapper, listener));
  }
}

struct HitSlot {
  state: HitState,
  refine: Option<Refiner>,
  /// The wrapper that set the regions; its disposal clears them.
  owner: u64,
}

struct Gesture {
  edge: ResizeEdge,
  from: Rect,
  start: Point,
}

/// One native window and everything Sweetview keeps for it.
struct Core {
  /// The window's handle value. A window Sweetview did not make is kept as
  /// this number only, and lent to each platform call for its length
  /// ([`Core::with_native`]); an owned one through its `tao` window.
  handle: isize,
  /// The `tao` window of an owned window, until it is destroyed. Shared so a
  /// call into `tao` holds no borrow while the OS calls back into Sweetview.
  tao: RefCell<Option<Rc<tao::window::Window>>>,
  owned: bool,
  alive: Cell<bool>,
  chrome: Chrome,
  no_activate: bool,
  min: MinSize,
  topmost: Cell<bool>,
  subclass: RefCell<Option<WindowSubclass>>,
  policy: Cell<ExStylePolicy>,
  listeners: RefCell<Listeners>,
  default_close: RefCell<Option<Listener>>,
  hit: RefCell<Option<HitSlot>>,
  hit_timer: Cell<Option<TimeoutId>>,
  passing: Cell<Option<bool>>,
  gesture: RefCell<Option<Gesture>>,
  gesture_timer: Cell<Option<TimeoutId>>,
  restore: Cell<Option<Rect>>,
  /// Whether the window was maximised when that was last looked at, for `on_maximize_change`.
  maximized: Cell<bool>,
  icons: RefCell<Option<WindowIcons>>,
  /// Live wrappers of this window.
  wrappers: Cell<usize>,
  /// The frame of a tabbed window: what [`tab_frame::TabFrame`] keeps.
  tab: Option<TabState>,
  /// What a window without tabs paints where no webview covers it, from its appearance
  /// (red, green, blue). `None` for a transparent or colour-keyed window, and one Sweetview did not make.
  backdrop: Cell<Option<(u8, u8, u8)>>,
}

thread_local! {
  /// Every window Sweetview knows on this thread, by handle value.
  static WINDOWS: RefCell<HashMap<isize, Rc<Core>>> = RefCell::new(HashMap::new());
  /// Windows disposed while a call into `tao` further up the stack still held them, waiting
  /// for a later turn to be destroyed.
  static UNDESTROYED: RefCell<Vec<Rc<tao::window::Window>>> = const { RefCell::new(Vec::new()) };
  static NEXT_WRAPPER: Cell<u64> = const { Cell::new(1) };
}

fn core_of(handle: isize) -> Option<Rc<Core>> {
  WINDOWS.try_with(|w| w.borrow().get(&handle).cloned()).ok().flatten()
}

fn next_wrapper() -> u64 {
  NEXT_WRAPPER.with(|n| {
    let id = n.get();
    n.set(id + 1);
    id
  })
}

impl Core {
  fn new(handle: isize, tao: Option<tao::window::Window>, chrome: Chrome, no_activate: bool, min: MinSize, topmost: bool, tab: Option<TabState>) -> Rc<Self> {
    Rc::new(Self {
      handle,
      owned: tao.is_some(),
      tao: RefCell::new(tao.map(Rc::new)),
      alive: Cell::new(true),
      chrome,
      no_activate,
      min,
      topmost: Cell::new(topmost),
      subclass: RefCell::new(None),
      policy: Cell::new(ExStylePolicy::default()),
      listeners: RefCell::new(Listeners::default()),
      default_close: RefCell::new(None),
      hit: RefCell::new(None),
      hit_timer: Cell::new(None),
      passing: Cell::new(None),
      gesture: RefCell::new(None),
      gesture_timer: Cell::new(None),
      restore: Cell::new(None),
      maximized: Cell::new(false),
      icons: RefCell::new(None),
      wrappers: Cell::new(0),
      tab,
      backdrop: Cell::new(None),
    })
  }

  /// Subclasses the window, with the core reached weakly from the procedure.
  fn subclass(self: &Rc<Self>) -> Result<()> {
    let weak = Rc::downgrade(self);
    let installed = self.with_native(|window| WindowSubclass::install(window, move |event| on_event(&weak, event)));
    let subclass = installed.ok_or_else(|| Error::state("sweetview: the window is gone"))?.map_err(Error::state)?;
    *self.subclass.borrow_mut() = Some(subclass);
    Ok(())
  }

  /// Whether the window is maximised now: the OS's own state for a framed
  /// window, the work-area toggle for a frameless one.
  fn maximized_now(&self) -> bool {
    if self.chrome.frame {
      self.with_native(|window| platform::is_zoomed(window)).unwrap_or(false)
    } else {
      self.restore.get().is_some()
    }
  }

  /// Tells the maximise listeners when the window's maximised state changed
  /// since it was last looked at. A minimised window is not looked at: it
  /// keeps the state it is restored to.
  fn note_maximized(&self) {
    if !self.alive.get() || self.with_native(|window| platform::is_minimized(window)).unwrap_or(true) {
      return;
    }
    let now = self.maximized_now();
    if self.maximized.replace(now) == now {
      return;
    }
    let listeners: Vec<BoolListener> = self.listeners.borrow().maximize.iter().map(|(_, l)| l.clone()).collect();
    listeners.iter().for_each(|l| l(now));
  }

  /// Calls `f` with the `tao` window of an owned window. No borrow is held
  /// during the call: a listener the OS reaches from inside it may destroy the window.
  fn with_tao<R>(&self, f: impl FnOnce(&tao::window::Window) -> R) -> Option<R> {
    let tao = self.tao.borrow().clone();
    tao.map(|tao| f(&tao))
  }

  /// Lends the window to `f` for the length of the call, for the platform
  /// crate: an owned window through its `tao` window, any other by its handle
  /// value, checked to name a window now. `None` (and `f` is not called) once
  /// the window is gone.
  fn with_native<R>(&self, f: impl FnOnce(&BorrowedWindow<'_>) -> R) -> Option<R> {
    if self.owned {
      return self.with_tao(|tao| f(&BorrowedWindow::of(tao)));
    }
    BorrowedWindow::with_handle_value(self.handle, f)
  }

  fn set_policy(&self, policy: ExStylePolicy) {
    self.policy.set(policy);
    match self.subclass.borrow().as_ref() {
      Some(subclass) => subclass.set_policy(policy),
      None => {
        self.with_native(|window| platform::apply_ex_style(window, &policy));
      }
    }
  }

  /// True while the window is visible. `tao`'s `is_visible` for an owned window
  /// (it makes the same call); the platform crate's for any other.
  fn is_visible(&self) -> bool {
    match self.with_tao(|tao| tao.is_visible()) {
      Some(visible) => visible,
      None => self.with_native(|window| platform::is_visible(window)).unwrap_or(false),
    }
  }

  fn place(&self, placement: Placement) {
    self.with_native(|window| platform::set_placement(window, placement));
  }

  /// The z-order of a move or resize: a topmost window is re-asserted topmost.
  fn keep_band(&self) -> ZOrder {
    if self.topmost.get() {
      ZOrder::Topmost
    } else {
      ZOrder::Keep
    }
  }

  fn update_policy(&self, change: impl FnOnce(&mut ExStylePolicy)) {
    let mut policy = self.policy.get();
    change(&mut policy);
    if policy != self.policy.get() {
      self.set_policy(policy);
    }
  }

  /// Turns click-through on or off; a repeat of the current state does nothing.
  fn pass_through(&self, on: bool) {
    if self.passing.get() == Some(on) {
      return;
    }
    self.passing.set(Some(on));
    self.update_policy(|p| p.click_through = Some(on));
  }

  /// The outer frame, read with one `GetWindowRect`: `tao`'s `outer_position`
  /// and `outer_size` read it twice and panic on a window destroyed by other code.
  fn bounds(&self) -> Rect {
    self.with_native(|window| platform::outer_bounds(window)).flatten().unwrap_or_default()
  }

  fn set_bounds(&self, rect: Rect) {
    self.place(Placement::bounds(rect, self.topmost.get()));
  }

  fn clear_timer(slot: &Cell<Option<TimeoutId>>) {
    if let Some(id) = slot.take() {
      if let Some(runtime) = Runtime::existing() {
        runtime.clear_timeout(id);
      }
    }
  }

  fn stop_hit_poll(&self) {
    Self::clear_timer(&self.hit_timer);
  }

  fn start_hit_poll(self: &Rc<Self>) -> Result<()> {
    if self.hit_timer.get().is_some() || self.hit.borrow().is_none() {
      return Ok(());
    }
    let weak = Rc::downgrade(self);
    let id = Runtime::get()?.set_interval(POLL_MS, move || {
      if let Some(core) = weak.upgrade() {
        core.poll_hit();
      }
    })?;
    self.hit_timer.set(Some(id));
    Ok(())
  }

  fn clear_hit(&self) {
    self.hit.borrow_mut().take();
    self.stop_hit_poll();
  }

  /// One tick of the hit-region poll.
  fn poll_hit(&self) {
    if !self.alive.get() {
      return;
    }
    let buttons = platform::mouse_buttons_down();
    let cursor = if buttons { Point::default() } else { cursor_position().unwrap_or_default() };
    let window = self.bounds();
    let step = match self.hit.borrow_mut().as_mut() {
      Some(slot) => slot.state.poll(buttons, cursor, window),
      None => return,
    };
    self.apply_hit_step(step);
  }

  fn apply_hit_step(&self, step: HitStep) {
    match step {
      HitStep::Nothing => {}
      HitStep::Pass(on) => self.pass_through(on),
      HitStep::Ask { pass, x, y, seq } => {
        if let Some(on) = pass {
          self.pass_through(on);
        }
        // Cloned out: the refiner may set new regions from inside its call.
        let refine = self.hit.borrow().as_ref().and_then(|slot| slot.refine.clone());
        if let Some(refine) = refine {
          refine(x, y, seq);
        }
      }
    }
  }

  /// One tick of the resize gesture: follows the cursor until the left button is up.
  fn track_gesture(&self) {
    if !platform::left_button_down() || !self.alive.get() {
      self.gesture.borrow_mut().take();
      Self::clear_timer(&self.gesture_timer);
      return;
    }
    let Ok(cursor) = cursor_position() else { return };
    let next = match self.gesture.borrow().as_ref() {
      Some(g) => logic::resize_from_edge(g.edge, g.from, g.start, cursor, self.min),
      None => return,
    };
    if next != self.bounds() {
      self.set_bounds(next);
    }
  }

  /// Destroys an owned window now, or forgets an adopted one, and releases
  /// everything kept for it. Safe to call twice.
  fn destroy(&self) {
    if !self.alive.replace(false) {
      return;
    }
    self.stop_hit_poll();
    Self::clear_timer(&self.gesture_timer);
    self.hit.borrow_mut().take();
    self.gesture.borrow_mut().take();
    let listeners = std::mem::take(&mut *self.listeners.borrow_mut());
    let default_close = self.default_close.borrow_mut().take();
    let activate = self.tab.as_ref().and_then(TabState::take_listener);
    let subclass = self.subclass.borrow_mut().take();
    drop(subclass);
    let tao = self.tao.borrow_mut().take();
    // A webview made in this window whose drop waits for a later turn (it was destroyed from
    // inside a webview callback) goes first: the window is hidden now and destroyed after it, by
    // a job queued behind the webview's own (D46, R3 of its first review).
    let tao = match tao {
      Some(tao) if crate::engine::drop_waits_in(self.handle) => match Runtime::existing() {
        Some(runtime) => {
          tao.set_visible(false);
          let _ = UNDESTROYED.try_with(|pending| pending.borrow_mut().push(tao));
          runtime.defer(destroy_undestroyed);
          None
        }
        None => Some(tao),
      },
      other => other,
    };
    if let Some(tao) = tao {
      // Destroyed now, not when `tao` gets to its own deferred destroy, so
      // `dispose()` and a default close leave no window behind.
      match Rc::try_unwrap(tao) {
        Ok(tao) => platform::destroy_now(tao),
        // A call into `tao` further up the stack still holds the window (a
        // listener disposed of it from inside that call): it is destroyed on
        // the next turn, once that call has returned.
        // Kept in `UNDESTROYED` rather than in the job, so the end of the application
        // destroys it too when the job never runs (the process ends first).
        Err(shared) => match Runtime::existing() {
          Some(runtime) => {
            let _ = UNDESTROYED.try_with(|pending| pending.borrow_mut().push(shared));
            runtime.defer(destroy_undestroyed);
          }
          None => drop(shared),
        },
      }
    }
    // Dropped after the window: `WindowIcons` destroys icons no window shows
    // any more, and keeps those an adopted window that lives on still shows.
    self.icons.borrow_mut().take();
    let _ = WINDOWS.try_with(|w| w.borrow_mut().remove(&self.handle));
    // Listeners are dropped last, outside every borrow: one may own the last
    // reference to something whose drop calls back in.
    drop((listeners, default_close, activate));
  }

  /// An adopted window nobody holds or listens to any more is let go: its
  /// subclass is removed and it leaves the registry.
  fn release_if_unused(&self) {
    let unused = !self.owned
      && self.wrappers.get() == 0
      && self.listeners.borrow().len() == 0
      && self.hit.borrow().is_none()
      && self.gesture.borrow().is_none();
    if unused {
      self.destroy();
    }
  }
}

fn cursor_position() -> Result<Point> {
  screen::cursor()
}

/// The subclass procedure's handler: runs inside whichever message loop
/// dispatched the message. Returns whether a close request was taken.
fn on_event(weak: &Weak<Core>, event: &WindowEvent) -> bool {
  let Some(core) = weak.upgrade() else { return false };
  // Every list is cloned out first: a listener may add or remove listeners,
  // or dispose the window, from inside its own call.
  match event {
    WindowEvent::Resized(bounds) => {
      let listeners: Vec<RectListener> = core.listeners.borrow().resize.iter().map(|(_, l)| l.clone()).collect();
      listeners.iter().for_each(|l| l(*bounds));
      core.note_maximized();
      false
    }
    WindowEvent::Moved(bounds) => {
      let listeners: Vec<RectListener> = core.listeners.borrow().moved.iter().map(|(_, l)| l.clone()).collect();
      listeners.iter().for_each(|l| l(*bounds));
      false
    }
    WindowEvent::CloseRequested => {
      let listeners: Vec<Listener> = core.listeners.borrow().close.iter().map(|(_, l)| l.clone()).collect();
      if !listeners.is_empty() {
        listeners.iter().for_each(|l| l());
        return true;
      }
      let default_close = core.default_close.borrow().clone();
      if let Some(default_close) = default_close {
        default_close();
        return true;
      }
      if core.owned {
        // Closing a window never ends the loop: with no one to ask, it is destroyed.
        core.destroy();
        return true;
      }
      false
    }
    WindowEvent::FilesDropped(paths) => {
      let listeners: Vec<DropListener> = core.listeners.borrow().drop.iter().map(|(_, l)| l.clone()).collect();
      listeners.iter().for_each(|l| l(paths.clone()));
      true
    }
    WindowEvent::Activated(active) => {
      let listener = core.tab.as_ref().and_then(TabState::listener);
      if let Some(listener) = listener {
        listener(*active);
      }
      false
    }
    WindowEvent::Destroyed => {
      // Someone else destroyed the window: nothing kept for it is any use now.
      core.destroy();
      false
    }
  }
}

/// One wrapper of a native window.
pub struct Window {
  core: Rc<Core>,
  id: u64,
  /// The wrapper `create` returned: disposing it destroys the window.
  owner: bool,
  detected: Option<Chrome>,
  disposed: Cell<bool>,
}

fn default_bounds() -> Rect {
  let area = screen::primary().map(|s| s.work_area).unwrap_or(Rect::new(0, 0, 1024, 768));
  let (width, height) = (320, 240);
  Rect::new(area.x + (area.width - width) / 2, area.y + (area.height - height) / 2, width, height)
}

impl Window {
  /// Makes a window, hidden. Show it once it is positioned and wired.
  pub fn create(init: WindowInit) -> Result<Window> {
    let runtime = Runtime::get()?;
    let color_key = init.color_key.as_deref().map(logic::parse_color_key).transpose().map_err(Error::state)?;
    if init.bounds.is_some() && init.content_size.is_some() {
      return Err(Error::state("sweetview: bounds and contentSize cannot both be given"));
    }
    let background = init.background_color.as_deref().map(logic::parse_background_color).transpose().map_err(Error::state)?;
    let tabbed = init.tab_strip_height.is_some();
    // A transparent window shows what is behind it; its background colour does not apply.
    let background = if init.transparent && !tabbed { None } else { background };
    let bounds = init.bounds.unwrap_or_else(default_bounds);
    // A tab frame is framed: the system keeps its border, shadow, snap and
    // maximise; only the caption goes, to the strip.
    let frame = init.frame || tabbed;
    let resizable = frame && init.resizable;
    let color_key = if tabbed { None } else { color_key };
    let tab = init.tab_strip_height.map(|strip| TabState::new(strip, init.appearance, background));
    let theme = match init.appearance {
      Appearance::System => None,
      Appearance::Light => Some(Theme::Light),
      Appearance::Dark => Some(Theme::Dark),
    };
    let builder = platform_builder(
      WindowBuilder::new()
        .with_visible(false)
        .with_title(init.title.clone())
        .with_decorations(frame && !tabbed)
        .with_resizable(resizable)
        .with_maximizable(resizable)
        .with_transparent(init.transparent && !tabbed)
        .with_always_on_top(init.topmost)
        .with_focusable(!init.no_activate)
        .with_focused(!init.no_activate)
        .with_theme(theme)
        .with_position(PhysicalPosition::new(bounds.x, bounds.y))
        .with_inner_size(PhysicalSize::new(bounds.width.max(1) as u32, bounds.height.max(1) as u32)),
      tab.as_ref(),
    );
    let tao = runtime.with_target(|target| builder.build(target))?.map_err(|e| Error::os("the window could not be made", e))?;
    // Where no webview covers it (before its page paints, or once its webview is gone) a window
    // shows its `backgroundColor`, or with none its appearance's page colour: never the white of a
    // client area nothing paints (D46). A transparent window, and a colour-keyed one given no
    // colour, show through there instead, as they always have. Set here, on the window still
    // hidden, for `System` to read the theme `tao` gave it. A tab frame paints its own (`TabState`).
    let backdrop = if tabbed {
      None
    } else {
      background.or_else(|| (!init.transparent && color_key.is_none()).then(|| backdrop_for(init.appearance, &tao)))
    };
    if let Some((red, green, blue)) = backdrop {
      tao.set_background_color(Some((red, green, blue, 0xff)));
    }
    let handle = platform::handle_value(&tao);
    let min = MinSize::from_options(init.min_width, init.min_height);
    let min_options = (init.min_width, init.min_height);
    let core = Core::new(handle, Some(tao), Chrome { frame, resizable }, init.no_activate, min, init.topmost, tab);
    core.backdrop.set(backdrop);
    WINDOWS.with(|w| w.borrow_mut().insert(core.handle, core.clone()));
    // From here on a failure must not leave a half-made window behind.
    let made = Self::finish(&core, &init, color_key, bounds, min_options);
    if let Err(error) = made {
      core.destroy();
      return Err(error);
    }
    Ok(Self::wrap(core, true, None))
  }

  fn finish(core: &Rc<Core>, init: &WindowInit, color_key: Option<u32>, bounds: Rect, min: (Option<i32>, Option<i32>)) -> Result<()> {
    core.subclass()?;
    if let Some(subclass) = core.subclass.borrow().as_ref() {
      // The widget of a webview mounted in the window fills its client area.
      // A tab frame's children (the strip and the tabs) are placed by the tabs library.
      subclass.set_fill_child(core.tab.is_none());
      subclass.set_hold_visibility(true);
      if core.tab.is_some() {
        subclass.force_style(platform::FRAME_STYLE);
      }
    }
    let layered = color_key.is_some() || init.opacity.is_some();
    core.set_policy(ExStylePolicy {
      tool_window: init.hide_from_taskbar,
      layered,
      click_through: None,
      // `tao` always asks for files; Sweetview only while a drop listener exists.
      accept_files: Some(false),
    });
    if layered {
      let set = core.with_native(|window| platform::set_layered_attributes(window, color_key, init.opacity));
      set.unwrap_or(Ok(())).map_err(Error::state)?;
    }
    core.set_bounds(bounds);
    // The frame is measured again after the style changes, in the band the window asked for.
    let band = if init.topmost { ZOrder::Topmost } else { ZOrder::NotTopmost };
    core.place(Placement { z: band, frame_changed: true, ..Placement::default() });
    if core.tab.is_none() {
      if let Some(content) = init.content_size {
        // The frame's edges and the scale are the window's own, measured where it was made: on the primary monitor.
        let scale = core.with_tao(platform::dpi_scale).unwrap_or(1.0);
        let (width, height) = logic::outer_size_for_content(content, scale, tab_frame::frame_edges(core));
        let area = screen::primary().map(|s| s.work_area).unwrap_or(Rect::new(0, 0, width, height));
        core.set_bounds(logic::centred(width, height, area));
      }
    }
    if let Some(tab) = &core.tab {
      let page = if init.bounds.is_none() { Some(init.content_size.unwrap_or(tab_frame::DEFAULT_PAGE)) } else { None };
      tab_frame::finish(core, tab, page, min);
    } else if min.0.is_some() || min.1.is_some() {
      core.with_tao(|tao| {
        // `tao` takes an inner minimum; the frame is what separates it from the outer one.
        let (outer, inner) = (tao.outer_size(), tao.inner_size());
        let frame_w = outer.width.saturating_sub(inner.width) as i32;
        let frame_h = outer.height.saturating_sub(inner.height) as i32;
        let width = (min.0.unwrap_or(0).max(0) - frame_w).max(0) as u32;
        let height = (min.1.unwrap_or(0).max(0) - frame_h).max(0) as u32;
        tao.set_min_inner_size(Some(PhysicalSize::new(width, height)));
      });
    }
    if let Some(ico) = &init.icon {
      if let Some(icons) = core.with_native(|window| WindowIcons::set(window, Some(ico))) {
        *core.icons.borrow_mut() = Some(icons.map_err(Error::state)?);
      }
    }
    Ok(())
  }

  /// Wraps a window by its handle value. One of Sweetview's own windows gives
  /// a wrapper that shares it; any other must be a window now, and is wrapped
  /// without changing it: its events come from a subclass when it belongs to
  /// this thread.
  pub fn adopt(handle: isize) -> Result<Window> {
    crate::threads::require_ui_thread()?;
    if handle == 0 {
      return Err(Error::state("sweetview: window handle is NULL"));
    }
    if let Some(core) = core_of(handle) {
      let detected = Some(core.chrome);
      return Ok(Self::wrap(core, false, detected));
    }
    let (chrome, on_this_thread) = BorrowedWindow::with_handle_value(handle, |window| (platform::chrome(window), platform::is_on_this_thread(window)))
      .ok_or_else(|| Error::state(format!("sweetview: not a window: {handle:#x}")))?;
    let core = Core::new(handle, None, chrome, false, logic::DEFAULT_MIN_SIZE, false, None);
    if on_this_thread {
      core.subclass()?;
    }
    WINDOWS.with(|w| w.borrow_mut().insert(handle, core.clone()));
    Ok(Self::wrap(core, false, Some(chrome)))
  }

  fn wrap(core: Rc<Core>, owner: bool, detected: Option<Chrome>) -> Window {
    core.wrappers.set(core.wrappers.get() + 1);
    Window { core, id: next_wrapper(), owner, detected, disposed: Cell::new(false) }
  }

  fn live(&self) -> bool {
    !self.disposed.get() && self.core.alive.get()
  }

  /// The window's handle value: the `HWND`.
  pub fn handle(&self) -> isize {
    self.core.handle
  }

  /// For a wrapper from [`Window::adopt`]: the window's frame and resizability.
  pub fn detected(&self) -> Option<Chrome> {
    self.detected
  }

  pub fn is_visible(&self) -> bool {
    self.live() && self.core.is_visible()
  }

  /// Shows the window: a minimised one is restored; one that may activate is
  /// brought to the front and given the foreground unless it is topmost.
  pub fn show(&self) -> Result<()> {
    if !self.live() {
      return Ok(());
    }
    let core = &self.core;
    // Shown the way `show()` always has: `tao`'s own show activates the window (D9).
    core.with_native(|window| platform::show(window, core.no_activate, core.topmost.get()));
    core.with_tao(|tao| {
      // `tao` learns the window is visible and not minimised, so its later
      // style rewrites agree; the subclass keeps those from touching `WS_VISIBLE`.
      tao.set_visible(true);
      tao.set_minimized(false);
      if core.tab.is_none() {
        // The widget of a webview mounted in it fills the client area; `tao` has no call for a child.
        platform::fill_first_child(tao);
      }
    });
    core.start_hit_poll()
  }

  pub fn hide(&self) {
    if !self.live() {
      return;
    }
    self.core.stop_hit_poll();
    if self.core.with_tao(|tao| tao.set_visible(false)).is_none() {
      self.core.with_native(|window| platform::show_as(window, ShowAs::Hidden));
    }
  }

  /// The outer frame.
  pub fn bounds(&self) -> Rect {
    self.core.bounds()
  }

  pub fn set_bounds(&self, rect: Rect) {
    if self.live() {
      self.core.set_bounds(rect);
    }
  }

  pub fn move_to(&self, x: i32, y: i32) {
    if self.live() {
      self.core.place(Placement { position: Some(Point { x, y }), z: self.core.keep_band(), ..Placement::default() });
    }
  }

  pub fn resize(&self, width: i32, height: i32) {
    if self.live() {
      self.core.place(Placement { size: Some((width, height)), ..Placement::default() });
    }
  }

  /// The window's DPI over 96.
  pub fn scale(&self) -> f64 {
    match self.core.with_tao(|tao| tao.scale_factor()) {
      Some(scale) => scale,
      None => self.core.with_native(|window| platform::dpi_scale(window)).unwrap_or(1.0),
    }
  }

  pub fn set_title(&self, title: &str) {
    if !self.live() {
      return;
    }
    if self.core.with_tao(|tao| tao.set_title(title)).is_none() {
      self.core.with_native(|window| platform::set_title(window, title));
    }
  }

  /// Caption and taskbar icons from `.ico` bytes; `None` for the stock icon.
  pub fn set_icon(&self, ico: Option<&[u8]>) -> Result<()> {
    if !self.live() {
      return Ok(());
    }
    let Some(icons) = self.core.with_native(|window| WindowIcons::set(window, ico)) else { return Ok(()) };
    let icons = icons.map_err(Error::state)?;
    // The old icons are no longer shown, so dropping them destroys them.
    let old = self.core.icons.borrow_mut().replace(icons);
    drop(old);
    Ok(())
  }

  pub fn minimize(&self) {
    if !self.live() {
      return;
    }
    if self.core.with_tao(|tao| tao.set_minimized(true)).is_none() {
      self.core.with_native(|window| platform::show_as(window, ShowAs::Minimized));
    }
  }

  /// A framed window maximises through the OS; a frameless one toggles
  /// between its bounds and the work area of the screen it is on.
  pub fn toggle_maximize(&self) -> Result<()> {
    if !self.live() {
      return Ok(());
    }
    let core = &self.core;
    if core.chrome.frame {
      if core.with_tao(|tao| tao.set_maximized(!tao.is_maximized())).is_none() {
        core.with_native(|window| {
          let state = if platform::is_zoomed(window) { ShowAs::Restored } else { ShowAs::Maximized };
          platform::show_as(window, state);
        });
      }
      return Ok(());
    }
    let work_area = screen::of_window(core.handle)?.work_area;
    let (next, restore) = logic::toggle_frameless_maximize(core.restore.get(), core.bounds(), work_area);
    core.restore.set(restore);
    core.set_bounds(next);
    // The bounds may not have changed size (no resize to notice it by).
    core.note_maximized();
    Ok(())
  }

  pub fn is_maximized(&self) -> bool {
    if !self.live() {
      return false;
    }
    let core = &self.core;
    if core.chrome.frame {
      match core.with_tao(|tao| tao.is_maximized()) {
        Some(maximized) => maximized,
        None => core.with_native(|window| platform::is_zoomed(window)).unwrap_or(false),
      }
    } else {
      core.restore.get().is_some()
    }
  }

  /// True while the OS has the window minimised (`IsIconic`), framed or
  /// frameless; a hidden window that is not minimised reads as false.
  pub fn is_minimized(&self) -> bool {
    if !self.live() {
      return false;
    }
    let core = &self.core;
    match core.with_tao(|tao| tao.is_minimized()) {
      Some(minimized) => minimized,
      None => core.with_native(|window| platform::is_minimized(window)).unwrap_or(false),
    }
  }

  pub fn set_topmost(&self, on: bool) {
    if !self.live() {
      return;
    }
    self.core.topmost.set(on);
    if self.core.with_tao(|tao| tao.set_always_on_top(on)).is_none() {
      let band = if on { ZOrder::Topmost } else { ZOrder::NotTopmost };
      self.core.place(Placement { z: band, ..Placement::default() });
    }
  }

  /// Hands the left button's press to the OS move loop.
  pub fn start_drag(&self) {
    if !self.live() {
      return;
    }
    let dragged = self.core.with_tao(|tao| tao.drag_window().is_ok());
    if dragged != Some(true) {
      self.core.with_native(|window| platform::press_frame(window, FramePart::Caption));
    }
  }

  /// Resizes the window from `edge`, following the cursor every 10 ms until
  /// the left button is released, never below the window's minimum size.
  pub fn start_resize(&self, edge: ResizeEdge) -> Result<()> {
    if !self.live() {
      return Ok(());
    }
    let core = &self.core;
    let start = cursor_position()?;
    *core.gesture.borrow_mut() = Some(Gesture { edge, from: core.bounds(), start });
    if core.gesture_timer.get().is_none() {
      let weak = Rc::downgrade(core);
      let id = Runtime::get()?.set_interval(POLL_MS, move || {
        if let Some(core) = weak.upgrade() {
          core.track_gesture();
        }
      })?;
      core.gesture_timer.set(Some(id));
    }
    Ok(())
  }

  /// The whole window lets clicks through, or none of it. Clears hit regions.
  pub fn set_click_through(&self, on: bool) {
    if !self.live() {
      return;
    }
    self.core.clear_hit();
    self.core.pass_through(on);
  }

  /// Only the packed polygons take clicks (the format of `packRegions`);
  /// `None` restores normal hit testing. With a refiner, the page is asked
  /// for the exact answer while the cursor is inside a polygon.
  pub fn set_hit_regions(&self, packed: Option<Vec<i32>>, refine: Option<Refiner>) -> Result<()> {
    if !self.live() {
      return Ok(());
    }
    let core = &self.core;
    let Some(packed) = packed else {
      core.clear_hit();
      core.pass_through(false);
      return Ok(());
    };
    let refining = refine.is_some();
    {
      let mut hit = core.hit.borrow_mut();
      let state = match hit.as_ref() {
        Some(previous) => previous.state.replaced(packed, refining),
        None => HitState::new(packed, refining),
      };
      *hit = Some(HitSlot { state, refine, owner: self.id });
    }
    if core.is_visible() {
      core.start_hit_poll()?;
    }
    core.poll_hit();
    Ok(())
  }

  /// The refiner's answer to the question numbered `seq`.
  pub fn answer_hit(&self, seq: u32, solid: bool) {
    if !self.live() {
      return;
    }
    let pass = self.core.hit.borrow().as_ref().and_then(|slot| slot.state.answer(seq, solid, platform::mouse_buttons_down()));
    if let Some(on) = pass {
      self.core.pass_through(on);
    }
  }

  fn require_subclass(&self) -> Result<()> {
    if self.core.subclass.borrow().is_none() {
      return Err(Error::state("sweetview: a window of another thread cannot be observed"));
    }
    Ok(())
  }

  /// This wrapper's resize listener, with the outer bounds; `None` removes it.
  pub fn on_resize(&self, listener: Option<RectListener>) -> Result<()> {
    if !self.live() {
      return Ok(());
    }
    if listener.is_some() {
      self.require_subclass()?;
    }
    set_listener(&mut self.core.listeners.borrow_mut().resize, self.id, listener);
    Ok(())
  }

  /// This wrapper's maximise listener: `true` when the window becomes
  /// maximised (a frameless one: fills its work area through
  /// `toggle_maximize`), `false` when it is restored, by any means. A window
  /// minimised and restored to the state it had reports nothing. `None` removes it.
  pub fn on_maximize_change(&self, listener: Option<BoolListener>) -> Result<()> {
    if !self.live() {
      return Ok(());
    }
    if listener.is_some() {
      self.require_subclass()?;
      if self.core.listeners.borrow().maximize.is_empty() {
        self.core.maximized.set(self.core.maximized_now());
      }
    }
    set_listener(&mut self.core.listeners.borrow_mut().maximize, self.id, listener);
    Ok(())
  }

  /// This wrapper's move listener, with the outer bounds; `None` removes it.
  pub fn on_move(&self, listener: Option<RectListener>) -> Result<()> {
    if !self.live() {
      return Ok(());
    }
    if listener.is_some() {
      self.require_subclass()?;
    }
    set_listener(&mut self.core.listeners.borrow_mut().moved, self.id, listener);
    Ok(())
  }

  /// This wrapper's close listener. While any wrapper has one, a close
  /// request goes to the listeners and the window stays open.
  pub fn on_close_request(&self, listener: Option<Listener>) -> Result<()> {
    if !self.live() {
      return Ok(());
    }
    if listener.is_some() {
      self.require_subclass()?;
    }
    set_listener(&mut self.core.listeners.borrow_mut().close, self.id, listener);
    Ok(())
  }

  /// For the owner of a window: what a close request with no listener does.
  /// Without one, the window is destroyed.
  pub fn on_default_close(&self, action: Option<Listener>) {
    if self.live() && self.owner {
      *self.core.default_close.borrow_mut() = action;
    }
  }

  /// This wrapper's file-drop listener, with every path of one drop. The
  /// window accepts dropped files only while some wrapper has one.
  pub fn on_file_drop(&self, listener: Option<DropListener>) -> Result<()> {
    if !self.live() {
      return Ok(());
    }
    if listener.is_some() {
      self.require_subclass()?;
    }
    let any = {
      let mut listeners = self.core.listeners.borrow_mut();
      set_listener(&mut listeners.drop, self.id, listener);
      !listeners.drop.is_empty()
    };
    // An adopted window's own setting is left alone until Sweetview first takes drops.
    if any || self.core.policy.get().accept_files.is_some() {
      self.core.update_policy(|p| p.accept_files = Some(any));
    }
    Ok(())
  }

  /// The window's styles and outer bounds now, to put back after a webview is mounted in it.
  /// Of a window that is gone, a snapshot that restores nothing.
  pub fn preserve_geometry(&self) -> GeometrySnapshot {
    self.core.with_native(|window| GeometrySnapshot::take(window)).unwrap_or_default()
  }

  /// Puts back what [`Window::preserve_geometry`] saw, and lays the mounted widget out.
  pub fn restore_geometry(&self, snapshot: &GeometrySnapshot) {
    if self.live() {
      self.core.with_native(|window| snapshot.restore(window));
    }
  }

  /// The owner destroys the window; any other wrapper removes what it added
  /// and leaves the window as it is. Safe to call twice.
  pub fn dispose(&self) {
    if self.disposed.replace(true) {
      return;
    }
    let core = &self.core;
    core.wrappers.set(core.wrappers.get().saturating_sub(1));
    if self.owner {
      core.destroy();
      return;
    }
    let had_drop = core.listeners.borrow().drop.iter().any(|(w, _)| *w == self.id);
    core.listeners.borrow_mut().remove_wrapper(self.id);
    if had_drop && core.listeners.borrow().drop.is_empty() && core.alive.get() {
      core.update_policy(|p| p.accept_files = Some(false));
    }
    let owns_hit = core.hit.borrow().as_ref().is_some_and(|slot| slot.owner == self.id);
    if owns_hit {
      core.clear_hit();
    }
    core.release_if_unused();
  }
}

impl Drop for Window {
  /// A wrapper that is collected without `dispose()` keeps its listeners, as
  /// a subscription on a window always has; it only stops counting as a holder.
  fn drop(&mut self) {
    if !self.disposed.replace(true) {
      self.core.wrappers.set(self.core.wrappers.get().saturating_sub(1));
      self.core.release_if_unused();
    }
  }
}

/// The page colour of a window of this appearance, the same a tab frame paints. For `System`,
/// the theme `tao` gave the window: `tao` follows the system's for a window with no theme of its own.
fn backdrop_for(appearance: Appearance, tao: &tao::window::Window) -> (u8, u8, u8) {
  let dark = match appearance {
    Appearance::System => tao.theme() == Theme::Dark,
    Appearance::Light => false,
    Appearance::Dark => true,
  };
  if dark {
    tab_frame::PAGE_DARK
  } else {
    tab_frame::PAGE_LIGHT
  }
}

/// The colour a window Sweetview made paints where no webview covers it, for a webview made in
/// it to show until its page paints: a tab frame's page colour, or a window's `backgroundColor`
/// or appearance's. `None` for a transparent window, a colour-keyed one given no colour, and a
/// window Sweetview did not make.
pub fn backdrop_of(handle: isize) -> Option<(u8, u8, u8)> {
  let core = core_of(handle)?;
  if !core.alive.get() {
    return None;
  }
  match &core.tab {
    Some(tab) => {
      let (red, green, blue, _) = tab.backdrop();
      Some((red, green, blue))
    }
    None => core.backdrop.get(),
  }
}

#[cfg(windows)]
fn platform_builder(builder: WindowBuilder, tab: Option<&TabState>) -> WindowBuilder {
  use tao::platform::windows::WindowBuilderExtWindows;
  // Drops arrive through the subclass, as `WM_DROPFILES`; `tao`'s OLE drop
  // target would take them first. A frameless window has no shadow, as before;
  // a tab frame keeps the system's border and shadow with its caption removed,
  // and paints the page's colour wherever no webview covers it.
  let builder = builder.with_drag_and_drop(false).with_undecorated_shadow(tab.is_some());
  match tab {
    Some(tab) => builder.with_background_color(tab.backdrop()),
    None => builder,
  }
}

#[cfg(not(windows))]
fn platform_builder(builder: WindowBuilder, _tab: Option<&TabState>) -> WindowBuilder {
  builder
}

/// The number of things kept for the window `handle`: its record, each
/// listener, its default close, its hit regions and its resize gesture. Zero
/// when Sweetview keeps nothing for it. For tests that check nothing leaks.
pub fn tracked_count(handle: isize) -> usize {
  let Some(core) = core_of(handle) else { return 0 };
  let count = 1
    + core.listeners.borrow().len()
    + usize::from(core.default_close.borrow().is_some())
    + usize::from(core.hit.borrow().is_some())
    + usize::from(core.gesture.borrow().is_some());
  count
}

/// Lends the window `handle` names to `f` for the length of the call, for
/// mounting a webview in it or a call on a window a webview was given: one of
/// Sweetview's own windows while it lives, or an application's own window of
/// this thread. The window implements `raw_window_handle::HasWindowHandle`.
/// `None` (and `f` is not called) when the handle names neither.
pub fn with_mount_target<R>(handle: isize, f: impl FnOnce(&BorrowedWindow<'_>) -> R) -> Option<R> {
  if let Some(core) = core_of(handle) {
    return if core.alive.get() { core.with_native(f) } else { None };
  }
  BorrowedWindow::with_handle_value(handle, |window| platform::is_on_this_thread(window).then(|| f(window))).flatten()
}

/// Destroys the windows whose destroy waited for a later turn. One still held up the stack is
/// let go of, and `tao` destroys it when its loop next runs, as a dropped window always was.
fn destroy_undestroyed() {
  let pending: Vec<Rc<tao::window::Window>> = UNDESTROYED.try_with(|pending| std::mem::take(&mut *pending.borrow_mut())).unwrap_or_default();
  for shared in pending {
    if let Ok(tao) = Rc::try_unwrap(shared) {
      platform::destroy_now(tao);
    }
  }
}

/// Hides every visible window Sweetview made on this thread, so none is on the screen while the
/// webviews in it go and before it is destroyed: the step of the end of the application before the webviews (D46).
pub(crate) fn hide_all() {
  let cores: Vec<Rc<Core>> = WINDOWS.try_with(|w| w.borrow().values().cloned().collect()).unwrap_or_default();
  for core in cores {
    if core.owned && core.alive.get() && core.is_visible() {
      core.stop_hit_poll();
      core.with_tao(|tao| tao.set_visible(false));
    }
  }
}

/// Destroys every window Sweetview knows on this thread, as each one's `dispose` does: the
/// windows it made are destroyed, and an application's own window it wraps is let go of.
/// Those disposed earlier whose destroy was still waiting for a later turn are destroyed too.
pub(crate) fn destroy_all() {
  let cores: Vec<Rc<Core>> = WINDOWS.try_with(|w| w.borrow().values().cloned().collect()).unwrap_or_default();
  for core in cores {
    core.destroy();
  }
  destroy_undestroyed();
}

#[cfg(all(test, windows))]
#[path = "window_tests.rs"]
mod tests;
