//! The tray icon: `tray-icon`, with Sweetview's click rules and its menu built on each open.
//!
//! `tray-icon` reports the shell's mouse messages as `TrayIconEvent`s from the
//! icon's own window procedure, to one handler per process. That handler only
//! queues the event as a deferred job of the runtime; the job runs on the next
//! turn of whichever message loop the UI thread is in, a modal one included.
//! Application code never runs inside `tray-icon`'s window procedure, which
//! holds its own state borrowed across the handler call, so a handler may
//! dispose of the tray, change its icon or open a modal loop freely.
//!
//! Clicks follow Windows conventions: a left click that does not become a double
//! click within the user's double-click time is a click; a double click is a
//! double click and no click; a right click opens the menu.
//!
//! The icon is re-added when Explorer restarts by `tray-icon` itself: its window
//! procedure answers the registered `TaskbarCreated` message by registering the
//! icon again (tray-icon 0.27.0, `src/platform_impl/windows/mod.rs`, the arm
//! `_ if msg == *S_U_TASKBAR_RESTART`).

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::{Rc, Weak};
use std::sync::Once;

use sweetview_platform_window::{double_click_time_ms, small_icon_size, BorrowedWindow, PopupAt, PopupCorner};
use tray_icon::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent, TrayIconId};

use crate::error::{Error, Result};
use crate::icon::IconBytes;
use crate::menu::{self, MenuData};
use crate::runtime::{Runtime, TimeoutId};

// ---- the single and double click rule ------------------------------------------

/// What the click rule asks of its owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClickAction {
  /// Start (or restart) the double-click timer.
  StartTimer,
  /// Cancel the double-click timer.
  CancelTimer,
  /// Call the click handler.
  Click,
  /// Call the double-click handler.
  DoubleClick,
}

/// Tells a single left click from a double click, from the shell's messages.
///
/// The shell reports a double click as down, up, double-click, up. The first
/// up starts a timer of the user's double-click time; the double-click message
/// cancels it and is the double click; the up after it is swallowed. A timer
/// that runs out is a single click.
#[derive(Debug, Default)]
pub struct ClickRule {
  swallow_next_up: bool,
}

impl ClickRule {
  /// A left button went up. `wants_clicks`: a click handler is set.
  pub fn left_up(&mut self, wants_clicks: bool) -> Vec<ClickAction> {
    if std::mem::take(&mut self.swallow_next_up) {
      return Vec::new();
    }
    if wants_clicks {
      vec![ClickAction::StartTimer]
    } else {
      Vec::new()
    }
  }

  /// The shell reported a left double click.
  pub fn left_double(&mut self) -> Vec<ClickAction> {
    self.swallow_next_up = true;
    vec![ClickAction::CancelTimer, ClickAction::DoubleClick]
  }

  /// The double-click timer ran out.
  pub fn timer_elapsed(&mut self) -> Vec<ClickAction> {
    vec![ClickAction::CancelTimer, ClickAction::Click]
  }
}

// ---- the tray ---------------------------------------------------------------------

/// A Windows stock icon id (`SHSTOCKICONID`): `SIID_APPLICATION`, the stock application
/// image shown when a tray has no icon of its own.
#[cfg(windows)]
const SIID_APPLICATION: i32 = 2;

/// What a tray is made with.
pub struct TrayInit {
  pub tooltip: String,
  pub icon: Option<IconBytes>,
  /// Whether a right click opens the menu.
  pub has_menu: bool,
  pub on_click: Option<Rc<dyn Fn()>>,
  pub on_double_click: Option<Rc<dyn Fn()>>,
  /// Called each time the menu is about to open; returns the menu to show.
  pub open_menu: Rc<dyn Fn() -> MenuData>,
  /// Called after the menu closes with an item chosen, with that item's number.
  pub menu_chosen: Rc<dyn Fn(u32)>,
}

struct TrayState {
  icon: RefCell<Option<TrayIcon>>,
  has_menu: Cell<bool>,
  menu_open: Cell<bool>,
  /// The hidden window that owns the menu, made when the menu first opens. The icon's own
  /// window cannot own it: `tray-icon` makes that window unable to activate, and a menu whose
  /// owner cannot come to the foreground takes no keyboard and does not close on a click elsewhere.
  menu_owner: RefCell<Option<tao::window::Window>>,
  clicks: RefCell<ClickRule>,
  click_timer: Cell<Option<TimeoutId>>,
  on_click: Option<Rc<dyn Fn()>>,
  on_double_click: Option<Rc<dyn Fn()>>,
  open_menu: Rc<dyn Fn() -> MenuData>,
  menu_chosen: Rc<dyn Fn(u32)>,
}

/// A tray icon. Dropping it, or [`Tray::dispose`], removes the icon.
pub struct Tray {
  id: String,
  state: Rc<TrayState>,
}

thread_local! {
  /// The live trays of this thread, by their `tray-icon` id.
  static TRAYS: RefCell<HashMap<String, Weak<TrayState>>> = RefCell::new(HashMap::new());
  static NEXT_ID: Cell<u64> = const { Cell::new(1) };
}

static EVENT_HANDLER: Once = Once::new();

/// What a tray event asks the tray to do, taken out of `tray-icon`'s event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayInput {
  LeftUp,
  LeftDouble,
  RightUp,
}

fn input_of(event: &TrayIconEvent) -> Option<TrayInput> {
  match event {
    TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } => Some(TrayInput::LeftUp),
    TrayIconEvent::Click { button: MouseButton::Right, button_state: MouseButtonState::Up, .. } => Some(TrayInput::RightUp),
    TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => Some(TrayInput::LeftDouble),
    _ => None,
  }
}

/// `tray-icon`'s handler: runs inside the icon's window procedure, so it only queues.
fn on_tray_event(event: TrayIconEvent) {
  let Some(input) = input_of(&event) else { return };
  let id = event.id().as_ref().to_owned();
  let Some(state) = TRAYS.try_with(|trays| trays.borrow().get(&id).cloned()).ok().flatten() else { return };
  if let Some(runtime) = Runtime::existing() {
    runtime.defer(move || {
      if let Some(state) = state.upgrade() {
        state.handle(input);
      }
    });
  }
}

fn tray_image(icon: Option<&IconBytes>) -> Result<Option<tray_icon::Icon>> {
  let Some(rgba) = icon.map(|icon| icon.rgba(small_icon_size())).transpose().map_err(|e| Error::state(format!("sweetview: the tray icon could not be decoded: {e}")))?.flatten() else {
    return Ok(None);
  };
  tray_icon::Icon::from_rgba(rgba.pixels, rgba.size, rgba.size).map(Some).map_err(|e| Error::os("the tray icon could not be made", e))
}

impl Tray {
  /// Adds an icon to the notification area. Only the UI thread may.
  pub fn new(init: TrayInit) -> Result<Self> {
    // The runtime first: the deferred jobs and timers the tray uses are its, and making it
    // sets the thread's DPI awareness before the icon's window exists.
    Runtime::get()?;
    EVENT_HANDLER.call_once(|| TrayIconEvent::set_event_handler(Some(on_tray_event)));
    let image = tray_image(init.icon.as_ref())?;
    let id = NEXT_ID.with(|next| {
      let id = next.get();
      next.set(id + 1);
      format!("sweetview.tray.{id}")
    });
    let mut builder = TrayIconBuilder::new().with_id(TrayIconId::new(&id)).with_tooltip(&init.tooltip).with_menu_on_right_click(false);
    builder = match image {
      Some(image) => builder.with_icon(image),
      None => with_stock_icon(builder),
    };
    let icon = builder.build().map_err(|e| Error::os("the tray icon could not be added", e))?;
    let state = Rc::new(TrayState {
      icon: RefCell::new(Some(icon)),
      has_menu: Cell::new(init.has_menu),
      menu_open: Cell::new(false),
      menu_owner: RefCell::new(None),
      clicks: RefCell::new(ClickRule::default()),
      click_timer: Cell::new(None),
      on_click: init.on_click,
      on_double_click: init.on_double_click,
      open_menu: init.open_menu,
      menu_chosen: init.menu_chosen,
    });
    TRAYS.with(|trays| trays.borrow_mut().insert(id.clone(), Rc::downgrade(&state)));
    Ok(Self { id, state })
  }

  pub fn set_tooltip(&self, text: &str) -> Result<()> {
    if let Some(icon) = self.state.icon.borrow().as_ref() {
      icon.set_tooltip(Some(text)).map_err(|e| Error::os("the tray tooltip could not be set", e))?;
    }
    Ok(())
  }

  /// Replaces the icon. `None`, or an icon with nothing for this platform, shows the stock image.
  pub fn set_icon(&self, icon: Option<&IconBytes>) -> Result<()> {
    let image = tray_image(icon)?;
    if let Some(tray) = self.state.icon.borrow().as_ref() {
      match image {
        Some(image) => tray.set_icon(Some(image)),
        None => set_stock_icon(tray),
      }
      .map_err(|e| Error::os("the tray icon could not be set", e))?;
    }
    Ok(())
  }

  /// Whether a right click opens the menu.
  pub fn set_has_menu(&self, has: bool) {
    self.state.has_menu.set(has);
  }

  /// The handle value of the icon's own window, which the shell posts its mouse messages to.
  /// 0 once disposed.
  pub fn window_handle_value(&self) -> isize {
    self.state.icon.borrow().as_ref().map_or(0, window_handle_of)
  }

  /// Removes the icon. Safe to call twice.
  pub fn dispose(&self) {
    let _ = TRAYS.try_with(|trays| trays.borrow_mut().remove(&self.id));
    self.state.release();
  }
}

/// Removes every tray icon of this thread that is still there, as [`Tray::dispose`] does.
pub(crate) fn release_all() {
  let states: Vec<Rc<TrayState>> = TRAYS.try_with(|trays| trays.borrow_mut().drain().filter_map(|(_, state)| state.upgrade()).collect()).unwrap_or_default();
  for state in states {
    state.release();
  }
}

impl Drop for Tray {
  fn drop(&mut self) {
    self.dispose();
  }
}

#[cfg(windows)]
fn with_stock_icon(builder: TrayIconBuilder) -> TrayIconBuilder {
  builder.with_native_icon(tray_icon::NativeIcon::Raw(SIID_APPLICATION))
}

#[cfg(not(windows))]
fn with_stock_icon(builder: TrayIconBuilder) -> TrayIconBuilder {
  builder
}

#[cfg(windows)]
fn set_stock_icon(tray: &TrayIcon) -> tray_icon::Result<()> {
  tray.set_native_icon(Some(tray_icon::NativeIcon::Raw(SIID_APPLICATION)))
}

#[cfg(not(windows))]
fn set_stock_icon(tray: &TrayIcon) -> tray_icon::Result<()> {
  tray.set_icon(None)
}

#[cfg(windows)]
fn window_handle_of(tray: &TrayIcon) -> isize {
  tray.window_handle() as isize
}

#[cfg(not(windows))]
fn window_handle_of(_tray: &TrayIcon) -> isize {
  0
}

impl TrayState {
  fn is_live(&self) -> bool {
    self.icon.borrow().is_some()
  }

  /// Removes the icon and the menu's owner window. Safe to call twice.
  fn release(&self) {
    if let Some(timer) = self.click_timer.take() {
      if let Some(runtime) = Runtime::existing() {
        runtime.clear_timeout(timer);
      }
    }
    // Taken out before it is dropped: dropping destroys the icon's window, which may run code that reads the slot.
    let icon = self.icon.try_borrow_mut().ok().and_then(|mut icon| icon.take());
    drop(icon);
    let owner = self.menu_owner.try_borrow_mut().ok().and_then(|mut owner| owner.take());
    drop(owner);
  }

  fn handle(self: &Rc<Self>, input: TrayInput) {
    if !self.is_live() {
      return;
    }
    let actions = match input {
      TrayInput::LeftUp => self.clicks.borrow_mut().left_up(self.on_click.is_some()),
      TrayInput::LeftDouble => self.clicks.borrow_mut().left_double(),
      TrayInput::RightUp => return self.open_menu(),
    };
    self.run(actions);
  }

  fn run(self: &Rc<Self>, actions: Vec<ClickAction>) {
    for action in actions {
      match action {
        ClickAction::StartTimer => {
          self.cancel_timer();
          let Some(runtime) = Runtime::existing() else { return };
          let state = Rc::downgrade(self);
          let timer = runtime.set_timeout(double_click_time_ms(), move || {
            if let Some(state) = state.upgrade() {
              state.click_timer.set(None);
              let actions = state.clicks.borrow_mut().timer_elapsed();
              state.run(actions);
            }
          });
          match timer {
            Ok(timer) => self.click_timer.set(Some(timer)),
            Err(e) => eprintln!("sweetview: the tray's double-click timer could not be set: {e}"),
          }
        }
        ClickAction::CancelTimer => self.cancel_timer(),
        ClickAction::Click => {
          if let (true, Some(handler)) = (self.is_live(), self.on_click.clone()) {
            handler();
          }
        }
        ClickAction::DoubleClick => {
          if let (true, Some(handler)) = (self.is_live(), self.on_double_click.clone()) {
            handler();
          }
        }
      }
    }
  }

  fn cancel_timer(&self) {
    if let (Some(timer), Some(runtime)) = (self.click_timer.take(), Runtime::existing()) {
      runtime.clear_timeout(timer);
    }
  }

  fn open_menu(self: &Rc<Self>) {
    if !self.has_menu.get() || self.menu_open.get() {
      return;
    }
    let open = self.open_menu.clone();
    let data = open();
    // The function that made the menu may have disposed of the tray.
    if data.is_empty() || !self.is_live() {
      return;
    }
    let owner = match self.menu_owner() {
      Ok(owner) => owner,
      Err(e) => return eprintln!("{e}"),
    };
    let built = match menu::build(&data) {
      Ok(built) => built,
      Err(e) => return eprintln!("{e}"),
    };
    // At the cursor, opening upward: the menu sits above the taskbar the icon is on.
    let at = match crate::screen::cursor() {
      Ok(cursor) => PopupAt { x: cursor.x, y: cursor.y, corner: PopupCorner::BottomLeft },
      Err(e) => return eprintln!("{e}"),
    };
    self.menu_open.set(true);
    let chosen = BorrowedWindow::with_handle_value(owner, |owner| menu::show(&built, owner, at)).flatten();
    self.menu_open.set(false);
    if let Some(id) = chosen {
      let chosen_handler = self.menu_chosen.clone();
      chosen_handler(id);
    }
  }

  /// The hidden window that owns the menu, made on first use.
  fn menu_owner(&self) -> Result<isize> {
    if self.menu_owner.borrow().is_none() {
      let window = menu::hidden_menu_owner("sweetview.tray-menu")?;
      *self.menu_owner.borrow_mut() = Some(window);
    }
    let handle = self.menu_owner.borrow().as_ref().map_or(0, menu::window_handle_value);
    BorrowedWindow::with_handle_value(handle, |_| handle).ok_or_else(|| Error::state("sweetview: the tray menu's window is gone"))
  }
}


#[cfg(test)]
mod tests {
  use super::*;

  /// Feeds the rule the shell's left-button messages and timer expiries; returns the handlers called.
  fn replay(steps: &[&str]) -> Vec<ClickAction> {
    let mut rule = ClickRule::default();
    let mut pending = false;
    let mut called = Vec::new();
    for step in steps {
      let actions = match *step {
        "up" => rule.left_up(true),
        "double" => rule.left_double(),
        "timeout" if pending => rule.timer_elapsed(),
        "timeout" => Vec::new(),
        other => panic!("unknown step {other}"),
      };
      for action in actions {
        match action {
          ClickAction::StartTimer => pending = true,
          ClickAction::CancelTimer => pending = false,
          ClickAction::Click | ClickAction::DoubleClick => called.push(action),
        }
      }
    }
    called
  }

  #[test]
  fn a_click_left_alone_is_a_click_once_the_double_click_time_passes() {
    assert_eq!(replay(&["up"]), vec![]);
    assert_eq!(replay(&["up", "timeout"]), vec![ClickAction::Click]);
  }

  #[test]
  fn a_double_click_is_a_double_click_and_no_click() {
    // What the shell posts for a double click: down, up, double-click, up.
    assert_eq!(replay(&["up", "double", "up", "timeout"]), vec![ClickAction::DoubleClick]);
  }

  #[test]
  fn two_clicks_further_apart_than_the_double_click_time_are_two_clicks() {
    assert_eq!(replay(&["up", "timeout", "up", "timeout"]), vec![ClickAction::Click, ClickAction::Click]);
  }

  #[test]
  fn a_click_after_a_double_click_is_a_click_again() {
    assert_eq!(replay(&["up", "double", "up", "up", "timeout"]), vec![ClickAction::DoubleClick, ClickAction::Click]);
  }

  #[test]
  fn with_no_click_handler_no_timer_runs() {
    let mut rule = ClickRule::default();
    assert!(rule.left_up(false).is_empty());
    assert_eq!(rule.left_double(), vec![ClickAction::CancelTimer, ClickAction::DoubleClick]);
  }

  #[test]
  fn only_left_and_right_button_ups_and_left_double_clicks_are_inputs() {
    let rect = tray_icon::Rect::default();
    let position = tray_icon::dpi::PhysicalPosition::new(0.0, 0.0);
    let id = TrayIconId::new("t");
    let click = |button, button_state| TrayIconEvent::Click { id: id.clone(), position, rect, button, button_state };
    assert_eq!(input_of(&click(MouseButton::Left, MouseButtonState::Up)), Some(TrayInput::LeftUp));
    assert_eq!(input_of(&click(MouseButton::Right, MouseButtonState::Up)), Some(TrayInput::RightUp));
    assert_eq!(input_of(&click(MouseButton::Left, MouseButtonState::Down)), None);
    assert_eq!(input_of(&click(MouseButton::Middle, MouseButtonState::Up)), None);
    let double = TrayIconEvent::DoubleClick { id: id.clone(), position, rect, button: MouseButton::Left };
    assert_eq!(input_of(&double), Some(TrayInput::LeftDouble));
  }
}
