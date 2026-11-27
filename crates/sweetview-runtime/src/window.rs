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

use sweetview_platform_window::{self as platform, ExStylePolicy, ForeignWindow, WindowEvent, WindowIcons, WindowSubclass};
use sweetview_window_logic::{self as logic, HitState, HitStep, MinSize};
use tao::dpi::{PhysicalPosition, PhysicalSize};
use tao::window::{Theme, WindowBuilder};

use crate::error::{Error, Result};
use crate::runtime::{Runtime, TimeoutId};
use crate::screen;
use crate::{Point, Rect, ResizeEdge};

pub use platform::{Chrome, GeometrySnapshot};

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
}

pub type RectListener = Rc<dyn Fn(Rect)>;
pub type Listener = Rc<dyn Fn()>;
pub type DropListener = Rc<dyn Fn(Vec<String>)>;
/// Asked whether the window-local point `(x, y)` is solid; answered through
/// [`Window::answer_hit`] with the same sequence number.
pub type Refiner = Rc<dyn Fn(i32, i32, u32)>;

#[derive(Default)]
struct Listeners {
  resize: Vec<(u64, RectListener)>,
  moved: Vec<(u64, RectListener)>,
  close: Vec<(u64, Listener)>,
  drop: Vec<(u64, DropListener)>,
}

impl Listeners {
  fn len(&self) -> usize {
    self.resize.len() + self.moved.len() + self.close.len() + self.drop.len()
  }

  fn remove_wrapper(&mut self, wrapper: u64) {
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
  handle: isize,
  /// The window by handle, for the platform crate's calls.
  native: ForeignWindow,
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
  icons: RefCell<Option<WindowIcons>>,
  /// Live wrappers of this window.
  wrappers: Cell<usize>,
}

thread_local! {
  /// Every window Sweetview knows on this thread, by handle value.
  static WINDOWS: RefCell<HashMap<isize, Rc<Core>>> = RefCell::new(HashMap::new());
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
  fn new(native: ForeignWindow, tao: Option<tao::window::Window>, chrome: Chrome, no_activate: bool, min: MinSize, topmost: bool) -> Rc<Self> {
    Rc::new(Self {
      handle: platform::handle_value(&native),
      owned: tao.is_some(),
      native,
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
      icons: RefCell::new(None),
      wrappers: Cell::new(0),
    })
  }

  /// Subclasses the window, with the core reached weakly from the procedure.
  fn subclass(self: &Rc<Self>) -> Result<()> {
    let weak = Rc::downgrade(self);
    let subclass = WindowSubclass::install(&self.native, move |event| on_event(&weak, event)).map_err(Error::state)?;
    *self.subclass.borrow_mut() = Some(subclass);
    Ok(())
  }

  /// Calls `f` with the `tao` window of an owned window. No borrow is held
  /// during the call: a listener the OS reaches from inside it may destroy the window.
  fn with_tao<R>(&self, f: impl FnOnce(&tao::window::Window) -> R) -> Option<R> {
    let tao = self.tao.borrow().clone();
    tao.map(|tao| f(&tao))
  }

  fn set_policy(&self, policy: ExStylePolicy) {
    self.policy.set(policy);
    match self.subclass.borrow().as_ref() {
      Some(subclass) => subclass.set_policy(policy),
      None => platform::apply_ex_style(&self.native, &policy),
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

  fn bounds(&self) -> Rect {
    platform::outer_bounds(&self.native).unwrap_or_default()
  }

  fn set_bounds(&self, rect: Rect) {
    platform::set_outer_bounds(&self.native, rect, self.topmost.get());
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
    let subclass = self.subclass.borrow_mut().take();
    drop(subclass);
    let tao = self.tao.borrow_mut().take();
    if let Some(tao) = tao {
      // Destroyed now, not when `tao` gets to its own deferred destroy, so
      // `dispose()` and a default close leave no window behind.
      platform::destroy_now(&tao);
      drop(tao);
    }
    // The icons outlive the window that drew them.
    self.icons.borrow_mut().take();
    let _ = WINDOWS.try_with(|w| w.borrow_mut().remove(&self.handle));
    // Listeners are dropped last, outside every borrow: one may own the last
    // reference to something whose drop calls back in.
    drop((listeners, default_close));
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
    let bounds = init.bounds.unwrap_or_else(default_bounds);
    let frame = init.frame;
    let resizable = frame && init.resizable;
    let theme = match init.appearance {
      Appearance::System => None,
      Appearance::Light => Some(Theme::Light),
      Appearance::Dark => Some(Theme::Dark),
    };
    let builder = platform_builder(
      WindowBuilder::new()
        .with_visible(false)
        .with_title(init.title.clone())
        .with_decorations(frame)
        .with_resizable(resizable)
        .with_maximizable(resizable)
        .with_transparent(init.transparent)
        .with_always_on_top(init.topmost)
        .with_focusable(!init.no_activate)
        .with_focused(!init.no_activate)
        .with_theme(theme)
        .with_position(PhysicalPosition::new(bounds.x, bounds.y))
        .with_inner_size(PhysicalSize::new(bounds.width.max(1) as u32, bounds.height.max(1) as u32)),
    );
    let tao = runtime.with_target(|target| builder.build(target))?.map_err(|e| Error::os("the window could not be made", e))?;
    let native = ForeignWindow::of(&tao);
    let min = MinSize::from_options(init.min_width, init.min_height);
    let min_options = (init.min_width, init.min_height);
    let core = Core::new(native, Some(tao), Chrome { frame, resizable }, init.no_activate, min, init.topmost);
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
      subclass.set_fill_child(true);
      subclass.set_hold_visibility(true);
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
      platform::set_layered_attributes(&core.native, color_key, init.opacity).map_err(Error::state)?;
    }
    core.set_bounds(bounds);
    platform::refresh_frame(&core.native, init.topmost);
    if min.0.is_some() || min.1.is_some() {
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
      let icons = WindowIcons::set(&core.native, Some(ico)).map_err(Error::state)?;
      *core.icons.borrow_mut() = Some(icons);
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
    let native = ForeignWindow::from_handle_value(handle).ok_or_else(|| Error::state(format!("sweetview: not a window: {handle:#x}")))?;
    let chrome = platform::chrome(&native);
    let on_this_thread = platform::is_on_this_thread(&native);
    let core = Core::new(native, None, chrome, false, logic::DEFAULT_MIN_SIZE, false);
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
    self.live() && platform::is_visible(&self.core.native)
  }

  /// Shows the window: a minimised one is restored; one that may activate is
  /// brought to the front and given the foreground unless it is topmost.
  pub fn show(&self) -> Result<()> {
    if !self.live() {
      return Ok(());
    }
    let core = &self.core;
    // Shown the way `show()` always has: `tao`'s own show activates the window.
    platform::show(&core.native, core.no_activate, core.topmost.get());
    core.with_tao(|tao| {
      // `tao` learns the window is visible and not minimised, so its later
      // style rewrites agree; the subclass keeps those from touching `WS_VISIBLE`.
      tao.set_visible(true);
      tao.set_minimized(false);
    });
    if core.owned {
      platform::fill_first_child(&core.native);
    }
    core.start_hit_poll()
  }

  pub fn hide(&self) {
    if !self.live() {
      return;
    }
    self.core.stop_hit_poll();
    if self.core.with_tao(|tao| tao.set_visible(false)).is_none() {
      platform::hide(&self.core.native);
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
      platform::move_outer(&self.core.native, x, y, self.core.topmost.get());
    }
  }

  pub fn resize(&self, width: i32, height: i32) {
    if self.live() {
      platform::resize_outer(&self.core.native, width, height);
    }
  }

  /// The window's DPI over 96.
  pub fn scale(&self) -> f64 {
    self.core.with_tao(|tao| tao.scale_factor()).unwrap_or_else(|| platform::dpi_scale(&self.core.native))
  }

  pub fn set_title(&self, title: &str) {
    if !self.live() {
      return;
    }
    if self.core.with_tao(|tao| tao.set_title(title)).is_none() {
      platform::set_title(&self.core.native, title);
    }
  }

  /// Caption and taskbar icons from `.ico` bytes; `None` for the stock icon.
  pub fn set_icon(&self, ico: Option<&[u8]>) -> Result<()> {
    if !self.live() {
      return Ok(());
    }
    let icons = WindowIcons::set(&self.core.native, ico).map_err(Error::state)?;
    // The old icons go only after the window has switched to the new ones.
    let old = self.core.icons.borrow_mut().replace(icons);
    drop(old);
    Ok(())
  }

  pub fn minimize(&self) {
    if !self.live() {
      return;
    }
    if self.core.with_tao(|tao| tao.set_minimized(true)).is_none() {
      platform::minimize(&self.core.native);
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
        platform::toggle_zoom(&core.native);
      }
      return Ok(());
    }
    let work_area = screen::of_window(core.handle)?.work_area;
    let (next, restore) = logic::toggle_frameless_maximize(core.restore.get(), core.bounds(), work_area);
    core.restore.set(restore);
    core.set_bounds(next);
    Ok(())
  }

  pub fn is_maximized(&self) -> bool {
    if !self.live() {
      return false;
    }
    let core = &self.core;
    if core.chrome.frame {
      core.with_tao(|tao| tao.is_maximized()).unwrap_or_else(|| platform::is_zoomed(&core.native))
    } else {
      core.restore.get().is_some()
    }
  }

  pub fn set_topmost(&self, on: bool) {
    if !self.live() {
      return;
    }
    self.core.topmost.set(on);
    if self.core.with_tao(|tao| tao.set_always_on_top(on)).is_none() {
      platform::set_topmost(&self.core.native, on);
    }
  }

  /// Hands the left button's press to the OS move loop.
  pub fn start_drag(&self) {
    if !self.live() {
      return;
    }
    let dragged = self.core.with_tao(|tao| tao.drag_window().is_ok());
    if dragged != Some(true) {
      platform::start_os_drag(&self.core.native);
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
    if platform::is_visible(&core.native) {
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
  pub fn preserve_geometry(&self) -> GeometrySnapshot {
    GeometrySnapshot::take(&self.core.native)
  }

  /// Puts back what [`Window::preserve_geometry`] saw, and lays the mounted widget out.
  pub fn restore_geometry(&self, snapshot: &GeometrySnapshot) {
    if self.live() {
      snapshot.restore(&self.core.native);
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

#[cfg(windows)]
fn platform_builder(builder: WindowBuilder) -> WindowBuilder {
  use tao::platform::windows::WindowBuilderExtWindows;
  // Drops arrive through the subclass, as `WM_DROPFILES`; `tao`'s OLE drop
  // target would take them first. A frameless window has no shadow, as before.
  builder.with_drag_and_drop(false).with_undecorated_shadow(false)
}

#[cfg(not(windows))]
fn platform_builder(builder: WindowBuilder) -> WindowBuilder {
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

/// The window `handle` names, for mounting a webview in it: one of
/// Sweetview's own windows, or an application's own window of this thread.
/// The result implements `raw_window_handle::HasWindowHandle`.
pub fn mount_target(handle: isize) -> Option<ForeignWindow> {
  if let Some(core) = core_of(handle) {
    return core.alive.get().then(|| core.native.clone());
  }
  ForeignWindow::from_handle_value(handle).filter(platform::is_on_this_thread)
}

/// Destroys every window this thread made. Tests only: the runtime is dropped next.
pub(crate) fn destroy_all_for_tests() {
  let cores: Vec<Rc<Core>> = WINDOWS.try_with(|w| w.borrow().values().cloned().collect()).unwrap_or_default();
  for core in cores {
    core.destroy();
  }
}

#[cfg(all(test, windows))]
#[path = "window_tests.rs"]
mod tests;
