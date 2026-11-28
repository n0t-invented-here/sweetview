//! Menus as data, built into `muda` menus fresh for every showing.
//!
//! The application describes a menu as plain data each time it opens (its
//! labels, check marks and enabled state follow application state with no
//! bookkeeping). Each item that can be chosen carries a number the caller
//! assigned, and the built menu's OS item carries the same number as its
//! command id; showing the menu answers with the number of the chosen item, and
//! the caller runs the handler it keeps under that number.
//!
//! A menu can also be handed to the application as a menu handle for its own
//! `TrackPopupMenu` ([`build_handed_out`]); it is kept here until the
//! application frees it ([`destroy_handed_out`]) or the UI thread ends.

use std::cell::RefCell;
use std::collections::HashMap;

use muda::{CheckMenuItem, IconMenuItem, IsMenuItem, Menu, MenuId, MenuItem as MudaItem, PredefinedMenuItem, Submenu};
use sweetview_platform_window::{check_item, is_on_this_thread, menu_handle_value, set_command_id, show_popup, show_system_menu, BorrowedWindow, PopupAt};
pub use sweetview_platform_window::PopupCorner;

use crate::error::{Error, Result};
use crate::icon::IconBytes;
use crate::runtime::Runtime;
use crate::screen;

/// One entry of a menu.
#[derive(Debug, Clone, PartialEq)]
pub enum MenuItem {
  /// An item that can be chosen. `id` is the caller's number for it, 1 or more.
  Item { id: u32, label: String, enabled: bool, checked: bool, icon: Option<IconBytes> },
  /// An item that opens a submenu.
  Submenu { label: String, enabled: bool, icon: Option<IconBytes>, items: Vec<MenuItem> },
  Separator,
}

/// A menu: its entries in order.
pub type MenuData = Vec<MenuItem>;

/// The prefix of the `muda` id of every item built here; the number after it
/// is the caller's, and becomes the OS item's command id.
const ID_PREFIX: &str = "sweetview.menu.";

/// The largest number an item may carry: `WM_COMMAND` reports 16 bits of a
/// command id, and an application tracking a handed-out menu without
/// `TPM_RETURNCMD` reads it there.
const MAX_ID: u32 = 0xFFFF;

/// The menu-item icon size. `muda` draws an item's icon into a 16 x 16 bitmap
/// whatever it is given, so the icon is decoded at exactly that size.
const MENU_ICON_SIZE: u32 = 16;

/// A literal `&` in a label. `muda` passes labels to the OS, where a single `&`
/// marks the next letter as the item's access key (Windows) or is dropped (macOS).
pub fn escape_label(label: &str) -> String {
  label.replace('&', "&&")
}

/// The caller's number for the item a `muda` id names, when the id is one of ours.
fn id_of(menu_id: &MenuId) -> Option<u32> {
  menu_id.as_ref().strip_prefix(ID_PREFIX)?.parse().ok()
}

fn menu_icon(icon: Option<&IconBytes>) -> Option<muda::Icon> {
  let rgba = match icon?.rgba(MENU_ICON_SIZE) {
    Ok(rgba) => rgba?,
    Err(reason) => {
      eprintln!("sweetview: menu icon skipped: {reason}");
      return None;
    }
  };
  match muda::Icon::from_rgba(rgba.pixels, rgba.size, rgba.size) {
    Ok(icon) => Some(icon),
    Err(reason) => {
      eprintln!("sweetview: menu icon skipped: {reason}");
      None
    }
  }
}

/// A `muda` menu built from data, with the items it is made of.
pub struct BuiltMenu {
  pub menu: Menu,
  /// The items stay owned for as long as the menu is.
  _items: Vec<Box<dyn IsMenuItem>>,
}

/// Builds `data` into a `muda` menu whose items carry the caller's numbers as
/// their command ids. Item icons that cannot be decoded are left out, with the
/// reason logged; the item is still shown.
pub fn build(data: &[MenuItem]) -> Result<BuiltMenu> {
  let menu = Menu::new();
  let mut built = Building { items: Vec::new(), checks: Vec::new(), commands: Vec::new() };
  fill(&menu, data, &mut Vec::new(), &mut built)?;
  for (path, enabled) in &built.checks {
    if !check_item(&menu, path, *enabled) {
      eprintln!("sweetview: the check mark of a menu item with an icon could not be set");
    }
  }
  for (path, id) in &built.commands {
    if *id > MAX_ID {
      return Err(Error::state(format!("sweetview: a menu item's number is {id}; the largest is {MAX_ID}")));
    }
    if !set_command_id(&menu, path, *id) {
      return Err(Error::state("sweetview: a menu item's command id could not be set"));
    }
  }
  Ok(BuiltMenu { menu, _items: built.items })
}

struct Building {
  items: Vec<Box<dyn IsMenuItem>>,
  /// Items with an icon that are checked, by their path of positions, with whether they are enabled.
  checks: Vec<(Vec<u32>, bool)>,
  /// Items that can be chosen, by their path of positions, with the caller's number.
  commands: Vec<(Vec<u32>, u32)>,
}

/// A `muda` menu or submenu, which items are appended to.
trait Container {
  fn add(&self, item: &dyn IsMenuItem) -> muda::Result<()>;
}

impl Container for Menu {
  fn add(&self, item: &dyn IsMenuItem) -> muda::Result<()> {
    self.append(item)
  }
}

impl Container for Submenu {
  fn add(&self, item: &dyn IsMenuItem) -> muda::Result<()> {
    self.append(item)
  }
}

fn fill(parent: &dyn Container, data: &[MenuItem], path: &mut Vec<u32>, built: &mut Building) -> Result<()> {
  for (position, entry) in data.iter().enumerate() {
    path.push(u32::try_from(position).unwrap_or(u32::MAX));
    let item = build_item(entry, path, built)?;
    parent.add(item.as_ref()).map_err(|e| Error::os("a menu item could not be added", e))?;
    // Only an item made from `MenuItem::Item` has one of our ids; separators and submenus have `muda`'s.
    if let Some(id) = id_of(item.id()) {
      built.commands.push((path.clone(), id));
    }
    built.items.push(item);
    path.pop();
  }
  Ok(())
}

/// The `muda` item for one entry at `path`.
fn build_item(entry: &MenuItem, path: &mut Vec<u32>, built: &mut Building) -> Result<Box<dyn IsMenuItem>> {
  Ok(match entry {
    MenuItem::Separator => Box::new(PredefinedMenuItem::separator()),
    MenuItem::Item { id, label, enabled, checked, icon } => {
      let menu_id = MenuId::new(format!("{ID_PREFIX}{id}"));
      let text = escape_label(label);
      match (menu_icon(icon.as_ref()), *checked) {
        (Some(icon), checked) => {
          // `muda` has no item with both an icon and a check mark; the check mark is set on the OS menu after.
          if checked {
            built.checks.push((path.clone(), *enabled));
          }
          Box::new(IconMenuItem::with_id(menu_id, text, *enabled, Some(icon), None))
        }
        (None, true) => Box::new(CheckMenuItem::with_id(menu_id, text, *enabled, true, None)),
        (None, false) => Box::new(MudaItem::with_id(menu_id, text, *enabled, None)),
      }
    }
    MenuItem::Submenu { label, enabled, icon, items } => {
      let submenu = Submenu::new(escape_label(label), *enabled);
      if let Some(icon) = menu_icon(icon.as_ref()) {
        submenu.set_icon(Some(icon));
      }
      fill(&submenu, items, path, built)?;
      Box::new(submenu)
    }
  })
}

/// Shows `menu` owned by `owner` and returns the chosen item's number after the
/// menu closes, or `None` when it was dismissed.
pub fn show(menu: &BuiltMenu, owner: &BorrowedWindow<'_>, at: PopupAt) -> Option<u32> {
  match show_popup(&menu.menu, owner, at) {
    0 => None,
    id => Some(id),
  }
}

/// Where a popup menu opens: `at` (physical pixels) or the cursor.
fn popup_point(at: Option<(f64, f64)>, corner: PopupCorner) -> Result<PopupAt> {
  let (x, y) = match at {
    Some((x, y)) => (x.round() as i32, y.round() as i32),
    None => {
      let cursor = screen::cursor()?;
      (cursor.x, cursor.y)
    }
  };
  Ok(PopupAt { x, y, corner })
}

/// `Menu.popup`: shows `data` as a popup menu owned by the window `owner`
/// names, at the screen point `at` (physical pixels) or at the cursor, with
/// `corner` of the menu there, and returns the chosen item's number after it
/// closes. An empty menu, or an owner that is no window, shows nothing and
/// returns `None`.
pub fn popup(owner: isize, data: &[MenuItem], at: Option<(f64, f64)>, corner: PopupCorner) -> Result<Option<u32>> {
  // The runtime is made first: making it sets the thread's DPI awareness, which the menu's position depends on.
  Runtime::get()?;
  if data.is_empty() {
    return Ok(None);
  }
  if BorrowedWindow::with_handle_value(owner, |_| ()).is_none() {
    return Ok(None);
  }
  let built = build(data)?;
  let at = popup_point(at, corner)?;
  if crate::window::is_no_activate(owner) {
    return popup_for_a_no_activate_owner(owner, &built, at);
  }
  Ok(BorrowedWindow::with_handle_value(owner, |owner| show(&built, owner, at)).flatten())
}

/// A menu's owner is made the foreground window to track it, and a window made with `no_activate`
/// must never take the foreground (D9). So the menu of such an owner is tracked by a hidden
/// stand-in owner, made as the tray's menu owner is ([`hidden_menu_owner`]), and the window that
/// was in front before gets the foreground back (`pass_foreground_back`, which also keeps the
/// stand-in from being left with it): at once when nothing was chosen; after the chosen item's
/// handler has run when one was (it runs when this returns, so the hand-back waits for the loop's
/// next turn), and then only if the stand-in still holds the foreground, so a window the handler
/// showed or focused stays in front.
///
/// One hand-back is pending at a time on a thread. A popup opened while one is pending (an item's
/// handler opens another at once) takes it over: it keeps the window that was in front before the
/// first, and the first's deferred hand-back, now stale, does nothing; no hand-back runs while a
/// popup is open.
fn popup_for_a_no_activate_owner(owner: isize, built: &BuiltMenu, at: PopupAt) -> Result<Option<u32>> {
  let stand_in = stand_in_owner()?;
  let before = match PENDING.with(|pending| pending.borrow_mut().take()) {
    Some(pending) => pending.before,
    // In front now is the stand-in itself when a popup opens before anything else took the
    // foreground back: then there is no earlier window to give it to.
    None => Some(sweetview_platform_window::foreground_handle_value()).filter(|&window| window != stand_in).unwrap_or(0),
  };
  let generation = GENERATION.with(|counter| {
    counter.set(counter.get() + 1);
    counter.get()
  });
  OPEN.with(|open| open.set(open.get() + 1));
  let chosen = BorrowedWindow::with_handle_value(stand_in, |menu_owner| show(built, menu_owner, at)).flatten();
  OPEN.with(|open| open.set(open.get() - 1));
  match (chosen, Runtime::existing()) {
    (Some(_), Some(runtime)) => {
      PENDING.with(|pending| *pending.borrow_mut() = Some(PendingHandBack { before, overlay: owner, generation }));
      defer_hand_back(&runtime, stand_in, generation);
    }
    _ => {
      let _gave = sweetview_platform_window::pass_foreground_back(stand_in, before, owner);
    }
  }
  Ok(chosen)
}

/// The hand-back a chosen item leaves pending until its handler has run.
#[derive(Clone, Copy)]
struct PendingHandBack {
  before: isize,
  overlay: isize,
  generation: u64,
}

thread_local! {
  static PENDING: RefCell<Option<PendingHandBack>> = const { RefCell::new(None) };
  static GENERATION: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
  /// How many `no_activate` popups are open on this thread (one inside another's handler's loop).
  static OPEN: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// Runs the pending hand-back of `generation` on the loop's next turn: not at all when a later
/// popup took it over, and later again while a popup is open.
fn defer_hand_back(runtime: &Runtime, stand_in: isize, generation: u64) {
  runtime.defer(move || {
    let current = PENDING.with(|pending| pending.borrow().filter(|pending| pending.generation == generation));
    let Some(pending) = current else { return };
    if OPEN.with(std::cell::Cell::get) > 0 {
      if let Some(runtime) = Runtime::existing() {
        defer_hand_back(&runtime, stand_in, generation);
      }
      return;
    }
    PENDING.with(|slot| slot.borrow_mut().take());
    let _gave = sweetview_platform_window::pass_foreground_back(stand_in, pending.before, pending.overlay);
  });
}

/// For tests: the stand-in owner's handle value; 0 when none is made.
#[cfg(test)]
pub(crate) fn stand_in_for_tests() -> isize {
  STAND_IN.with(|slot| slot.borrow().as_ref().map_or(0, window_handle_value))
}

thread_local! {
  /// The hidden owner of the menus of `no_activate` owners, made on first use and kept: destroying
  /// the foreground window would let the OS activate another of this thread's windows, the overlay
  /// among them. Released with the menus (`release_all`).
  static STAND_IN: RefCell<Option<tao::window::Window>> = const { RefCell::new(None) };
}

/// The handle value of the stand-in owner, made on first use.
fn stand_in_owner() -> Result<isize> {
  if STAND_IN.with(|slot| slot.borrow().is_none()) {
    let window = hidden_menu_owner("sweetview.popup-menu", "a popup menu's owner window could not be made")?;
    STAND_IN.with(|slot| *slot.borrow_mut() = Some(window));
  }
  let handle = STAND_IN.with(|slot| slot.borrow().as_ref().map_or(0, window_handle_value));
  BorrowedWindow::with_handle_value(handle, |_| handle).ok_or_else(|| Error::state("sweetview: the popup menu's owner window is gone"))
}

/// A hidden window that can own a popup menu and hold the foreground for it: the tray's menu owner
/// (whose icon window cannot be activated) and the stand-in for a `no_activate` owner. One way to
/// make it, for both.
/// `failure` is the error's wording when it cannot be made: each caller's own, as it always was.
pub(crate) fn hidden_menu_owner(title: &str, failure: &'static str) -> Result<tao::window::Window> {
  let runtime = Runtime::get()?;
  runtime
    .with_target(|target| tao::window::WindowBuilder::new().with_visible(false).with_title(title).build(target))?
    .map_err(|e| Error::os(failure, e))
}

#[cfg(windows)]
pub(crate) fn window_handle_value(window: &tao::window::Window) -> isize {
  use tao::platform::windows::WindowExtWindows;
  window.hwnd()
}

#[cfg(not(windows))]
pub(crate) fn window_handle_value(_window: &tao::window::Window) -> isize {
  0
}

thread_local! {
  /// The menus handed to the application, by their handle value, until it frees them.
  static HANDED_OUT: RefCell<HashMap<isize, BuiltMenu>> = RefCell::new(HashMap::new());
}

/// `buildMenu`: builds `data` and hands the application its popup menu handle,
/// for its own `TrackPopupMenu`. Each item's command id is its number in
/// `data`. The menu (its submenus and item bitmaps with it) stays alive until
/// [`destroy_handed_out`] is called with the handle.
pub fn build_handed_out(data: &[MenuItem]) -> Result<isize> {
  Runtime::get()?;
  let built = build(data)?;
  let handle = menu_handle_value(&built.menu);
  if handle == 0 {
    return Err(Error::state("sweetview: a menu handle for TrackPopupMenu is a Windows call"));
  }
  HANDED_OUT.with(|menus| menus.borrow_mut().insert(handle, built));
  Ok(handle)
}

/// `destroyMenu`: frees a menu [`build_handed_out`] made. False when `handle`
/// names no such menu (freed already, or never handed out).
pub fn destroy_handed_out(handle: isize) -> bool {
  // The menu is dropped after the borrow ends.
  let built = HANDED_OUT.with(|menus| menus.borrow_mut().remove(&handle));
  built.is_some()
}

/// Frees every menu [`build_handed_out`] made that the application did not free.
pub(crate) fn release_all() {
  // Dropped after the borrow ends.
  let built: Vec<BuiltMenu> = HANDED_OUT.try_with(|menus| menus.borrow_mut().drain().map(|(_, menu)| menu).collect()).unwrap_or_default();
  drop(built);
  let _pending = PENDING.try_with(|slot| slot.borrow_mut().take());
  let stand_in = STAND_IN.try_with(|slot| slot.borrow_mut().take()).ok().flatten();
  drop(stand_in);
}

/// `windowMenu` and `Window#showSystemMenu`: shows the system menu (Restore,
/// Move, Size, Minimize, Maximize, Close) of the window `owner` names at the
/// cursor and carries out the chosen command, as tag `pre-rust-rewrite`'s
/// `windowMenu(hwnd)` did for every window (see the platform crate's
/// `show_system_menu`). A value that names no window, or a window of another
/// thread, shows nothing.
pub fn window_menu(owner: isize) -> Result<()> {
  Runtime::get()?;
  let cursor = screen::cursor()?;
  BorrowedWindow::with_handle_value(owner, |owner| {
    if is_on_this_thread(owner) {
      show_system_menu(owner, cursor);
    }
  });
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn ampersands_are_doubled() {
    assert_eq!(escape_label("Fish & Chips"), "Fish && Chips");
    assert_eq!(escape_label("&&"), "&&&&");
  }

  #[test]
  fn only_ids_of_this_module_are_taken() {
    assert_eq!(id_of(&MenuId::new("sweetview.menu.7")), Some(7));
    assert_eq!(id_of(&MenuId::new("7")), None);
    assert_eq!(id_of(&MenuId::new("sweetview.menu.x")), None);
  }
}
