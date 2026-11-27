//! The frame of a tabbed window (`new Window({ tabs: true })` on Windows).
//!
//! The frame is an ordinary Sweetview window (made by [`Window::create`] with
//! `tab_strip_height`), so its events, styles, icon and close behaviour are
//! every window's. What it adds is here: the layout of the strip and the page
//! below it, activation, the strip's drag and resize gestures, the system
//! menu and the tab menu, and its light or dark state.
//!
//! The strip and the tabs are webviews made as children of the frame
//! ([`crate::engine::Host::Child`]); the tabs library places them in the
//! rectangles this module reports and shows one tab at a time.
//!
//! [`Window::create`]: super::Window::create

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use sweetview_platform_window as platform;
pub use sweetview_platform_window::PopupEntry;
use tao::dpi::{LogicalSize, PhysicalSize};
use tao::window::Theme;

use super::{core_of, screen, Appearance, Core, WINDOWS};
use crate::error::{Error, Result};
use crate::{Rect, ResizeEdge};

/// The page the frame is sized for when no bounds are given, in device-independent pixels.
const DEFAULT_PAGE: (f64, f64) = (1040.0, 720.0);
/// The smallest page the frame can be resized to when no minimum is given.
const DEFAULT_MIN_PAGE: (f64, f64) = (560.0, 420.0);

/// The colour the frame paints where no webview covers it: the page's, light or dark.
const PAGE_LIGHT: (u8, u8, u8, u8) = (0xf9, 0xf9, 0xfb, 0xff);
const PAGE_DARK: (u8, u8, u8, u8) = (0x15, 0x16, 0x1a, 0xff);

/// Called with `true` when the frame becomes the active window, `false` when it stops being it.
pub type ActivateListener = Rc<dyn Fn(bool)>;

/// What a window keeps for being a tab frame.
pub(super) struct TabState {
  strip_height: u32,
  appearance: Appearance,
  /// The frame's effective dark state: its explicit appearance, or the last system state.
  dark: Cell<bool>,
  activate: RefCell<Option<ActivateListener>>,
}

impl TabState {
  pub(super) fn new(strip_height: u32, appearance: Appearance) -> Self {
    let dark = match appearance {
      Appearance::System => platform::system_is_dark(),
      Appearance::Light => false,
      Appearance::Dark => true,
    };
    Self { strip_height, appearance, dark: Cell::new(dark), activate: RefCell::new(None) }
  }

  pub(super) fn backdrop(&self) -> (u8, u8, u8, u8) {
    if self.dark.get() {
      PAGE_DARK
    } else {
      PAGE_LIGHT
    }
  }

  pub(super) fn listener(&self) -> Option<ActivateListener> {
    self.activate.borrow().clone()
  }

  pub(super) fn take_listener(&self) -> Option<ActivateListener> {
    self.activate.borrow_mut().take()
  }
}

/// Sizes a new frame: a default size from its page when no bounds were
/// given, and its minimum. Bounds and minimums are the outer frame, as for
/// every window; the frame's edges are measured, not assumed.
pub(super) fn finish(core: &Rc<Core>, tab: &TabState, default_bounds: bool, min: (Option<i32>, Option<i32>)) {
  let scale = platform::dpi_scale(&core.native);
  let (edge_w, edge_h) = frame_edges(core);
  let strip = f64::from(tab.strip_height);
  if default_bounds {
    let width = (DEFAULT_PAGE.0 * scale).round() as i32 + edge_w;
    let height = ((DEFAULT_PAGE.1 + strip) * scale).round() as i32 + edge_h;
    let area = screen::primary().map(|s| s.work_area).unwrap_or(Rect::new(0, 0, width, height));
    let x = area.x + (area.width - width) / 2;
    let y = area.y + ((area.height - height) / 2).max(0);
    core.set_bounds(Rect::new(x, y, width, height));
  }
  // `tao` enforces an undecorated window's minimum inner size plus the frame's
  // edges (outer less client) as the outer minimum the OS tracks.
  core.with_tao(|tao| match min {
    (None, None) => {
      // The default is a page and the strip, and follows the frame's DPI: a logical size.
      tao.set_min_inner_size(Some(LogicalSize::new(DEFAULT_MIN_PAGE.0, DEFAULT_MIN_PAGE.1 + strip)));
    }
    (width, height) => {
      // A side given no minimum keeps the default's, at the frame's DPI now.
      let inner = |outer: Option<i32>, edge: i32, default: f64| match outer {
        Some(outer) => (outer - edge).max(0) as u32,
        None => (default * scale).round() as u32,
      };
      let size = PhysicalSize::new(inner(width, edge_w, DEFAULT_MIN_PAGE.0), inner(height, edge_h, DEFAULT_MIN_PAGE.1 + strip));
      tao.set_min_inner_size(Some(size));
    }
  });
  if tab.appearance == Appearance::System {
    // `tao` follows the system theme for a window with no theme of its own.
    let dark = core.with_tao(|tao| tao.theme() == Theme::Dark).unwrap_or(false);
    tab.dark.set(dark);
    core.with_tao(|tao| tao.set_background_color(Some(tab.backdrop())));
  }
}

/// The outer frame less the client area: what the system's border takes.
fn frame_edges(core: &Core) -> (i32, i32) {
  match (platform::outer_bounds(&core.native), platform::client_rect(&core.native)) {
    (Some(outer), Some(client)) => ((outer.width - client.width).max(0), (outer.height - client.height).max(0)),
    _ => (0, 0),
  }
}

/// The frame of a tabbed window.
#[derive(Clone)]
pub struct TabFrame {
  core: Rc<Core>,
}

impl TabFrame {
  /// The live tab frame with this handle value.
  pub fn of(handle: isize) -> Option<TabFrame> {
    core_of(handle).filter(|core| core.tab.is_some() && core.alive.get()).map(|core| TabFrame { core })
  }

  /// Every live tab frame of this thread.
  pub fn all() -> Vec<TabFrame> {
    let cores: Vec<Rc<Core>> = WINDOWS.try_with(|w| w.borrow().values().cloned().collect()).unwrap_or_default();
    cores.into_iter().filter(|core| core.tab.is_some() && core.alive.get()).map(|core| TabFrame { core }).collect()
  }

  fn tab(&self) -> &TabState {
    // `of` and `all` hand out frames only.
    self.core.tab.as_ref().expect("a tab frame has its tab state")
  }

  pub fn handle(&self) -> isize {
    self.core.handle
  }

  /// False once the window is destroyed.
  pub fn is_live(&self) -> bool {
    self.core.alive.get()
  }

  fn scale(&self) -> f64 {
    platform::dpi_scale(&self.core.native)
  }

  fn client(&self) -> Rect {
    platform::client_rect(&self.core.native).unwrap_or_default()
  }

  /// The strip's height in physical pixels at the frame's DPI, never more than the client area.
  pub fn strip_height(&self) -> i32 {
    let client = self.client();
    ((f64::from(self.tab().strip_height) * self.scale()).round() as i32).min(client.height).max(0)
  }

  /// The strip, in the frame's client coordinates: across the top.
  pub fn strip_rect(&self) -> Rect {
    Rect::new(0, 0, self.client().width, self.strip_height())
  }

  /// The page area, in the frame's client coordinates: everything below the strip.
  pub fn page_rect(&self) -> Rect {
    let client = self.client();
    let strip = self.strip_height();
    Rect::new(0, strip, client.width, client.height - strip)
  }

  /// The strip on the screen, for a tab dropped on it from another window.
  pub fn strip_screen_rect(&self) -> Rect {
    let origin = platform::client_origin(&self.core.native).unwrap_or_default();
    let strip = self.strip_rect();
    Rect::new(origin.x, origin.y, strip.width, strip.height)
  }

  /// True when the frame is the window the user is typing into.
  pub fn is_foreground(&self) -> bool {
    self.is_live() && platform::is_foreground(&self.core.native)
  }

  /// The frame's activation listener; `None` removes it. One per frame.
  pub fn on_activate(&self, listener: Option<ActivateListener>) {
    let previous = std::mem::replace(&mut *self.tab().activate.borrow_mut(), listener);
    drop(previous);
  }

  /// How far the cursor is from where the strip point `held` (in
  /// device-independent pixels from the strip's top-left corner) is now:
  /// the press that started a gesture happened there, and the cursor has
  /// moved on by the time the UI thread hears of it.
  fn travelled_since(&self, held: (f64, f64)) -> Result<(i32, i32)> {
    let cursor = screen::cursor()?;
    let scale = self.scale();
    let origin = platform::client_origin(&self.core.native).unwrap_or_default();
    let x = origin.x + (held.0 * scale).round() as i32;
    let y = origin.y + (held.1 * scale).round() as i32;
    Ok((cursor.x - x, cursor.y - y))
  }

  /// Hands the left button's press on the strip to the OS move loop and
  /// returns when the button is released. With `held`, the window first moves
  /// so that point of the strip is under the cursor again. Nothing happens
  /// when the left button is not down.
  pub fn start_drag_at(&self, held: Option<(f64, f64)>) -> Result<()> {
    if !self.is_live() || !platform::left_button_down() {
      return Ok(());
    }
    if let Some(held) = held {
      if !platform::is_zoomed(&self.core.native) {
        let (dx, dy) = self.travelled_since(held)?;
        let bounds = self.core.bounds();
        platform::move_outer(&self.core.native, bounds.x + dx, bounds.y + dy, self.core.topmost.get());
      }
    }
    platform::move_with_mouse(&self.core.native);
    Ok(())
  }

  /// Hands the left button's press on the strip's top edge or corners to the
  /// OS size loop and returns when the button is released. With `held`, the
  /// dragged edges first catch up with the cursor. Nothing happens when the
  /// window is not resizable, is maximised, or the left button is not down.
  pub fn start_resize_at(&self, edge: ResizeEdge, held: Option<(f64, f64)>) -> Result<()> {
    let core = &self.core;
    if !self.is_live() || !core.chrome.resizable || !platform::left_button_down() || platform::is_zoomed(&core.native) {
      return Ok(());
    }
    if let Some(held) = held {
      let (dx, dy) = self.travelled_since(held)?;
      let b = core.bounds();
      let (mut left, mut top, mut right) = (b.x, b.y, b.x + b.width);
      let bottom = b.y + b.height;
      if matches!(edge, ResizeEdge::Top | ResizeEdge::TopLeft | ResizeEdge::TopRight) {
        top += dy;
      }
      if matches!(edge, ResizeEdge::Left | ResizeEdge::TopLeft | ResizeEdge::BottomLeft) {
        left += dx;
      }
      if matches!(edge, ResizeEdge::Right | ResizeEdge::TopRight | ResizeEdge::BottomRight) {
        right += dx;
      }
      core.set_bounds(Rect::from_edges(left, top, right, bottom));
    }
    platform::size_with_mouse(&core.native, edge);
    Ok(())
  }

  /// Asks the window to close, as its close button does, and returns once the
  /// request was handled: the window's close listeners ran, or it is destroyed.
  pub fn request_close(&self) {
    if self.is_live() {
      platform::request_close(&self.core.native);
    }
  }

  /// Shows the window's system menu at the cursor, as a right-click on a title bar does.
  pub fn show_system_menu(&self) -> Result<()> {
    if self.is_live() {
      platform::show_system_menu(&self.core.native, screen::cursor()?);
    }
    Ok(())
  }

  /// Shows a popup menu of `entries` at the cursor and returns the index of
  /// the chosen one when it closes, `None` when it was dismissed.
  pub fn show_menu(&self, entries: &[PopupEntry]) -> Result<Option<usize>> {
    if !self.is_live() || entries.is_empty() {
      return Ok(None);
    }
    platform::popup_menu(&self.core.native, entries, screen::cursor()?).map_err(Error::state)
  }

  /// The appearance the frame was made with.
  pub fn appearance(&self) -> Appearance {
    self.tab().appearance
  }

  /// The frame's effective dark state.
  pub fn is_dark(&self) -> bool {
    self.tab().dark.get()
  }

  /// The system's dark state, as the strip's page sees it. Only a frame that
  /// follows the system changes: its title bar theme and its backdrop.
  pub fn set_system_dark(&self, dark: bool) {
    let tab = self.tab();
    if !self.is_live() || tab.appearance != Appearance::System || tab.dark.get() == dark {
      return;
    }
    tab.dark.set(dark);
    self.core.with_tao(|tao| {
      tao.set_theme(Some(if dark { Theme::Dark } else { Theme::Light }));
      tao.set_background_color(Some(tab.backdrop()));
    });
  }
}

/// True when the system's app theme is dark.
pub fn system_is_dark() -> bool {
  platform::system_is_dark()
}

/// True while the left mouse button is down.
pub fn left_button_down() -> bool {
  platform::left_button_down()
}

/// True when `handle` names a window now.
pub fn window_exists(handle: isize) -> bool {
  platform::ForeignWindow::from_handle_value(handle).is_some()
}

/// What a tab menu entry is made from: a label, or `None` for a separator.
pub fn popup_entry(label: Option<String>, enabled: bool) -> PopupEntry {
  match label {
    Some(label) => PopupEntry::Item { label, enabled },
    None => PopupEntry::Separator,
  }
}
