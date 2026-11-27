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
use sweetview_platform_window::{check_item, is_on_this_thread, menu_handle_value, set_command_id, show_popup, show_system_menu, ForeignWindow, PopupAt};
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
pub fn show(menu: &BuiltMenu, owner: &ForeignWindow, at: PopupAt) -> Option<u32> {
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
  let Some(owner) = ForeignWindow::from_handle_value(owner) else { return Ok(None) };
  let built = build(data)?;
  let at = popup_point(at, corner)?;
  Ok(show(&built, &owner, at))
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

/// `windowMenu`: shows the system menu (Restore, Move, Size, Minimize,
/// Maximize, Close) of the window `owner` names at the cursor, with its items
/// enabled for the window's maximised state, and carries out the chosen
/// command as the title bar's own menu does. A value that names no window, or a
/// window of another thread, shows nothing.
pub fn window_menu(owner: isize) -> Result<()> {
  Runtime::get()?;
  let Some(owner) = ForeignWindow::from_handle_value(owner) else { return Ok(()) };
  if !is_on_this_thread(&owner) {
    return Ok(());
  }
  show_system_menu(&owner, screen::cursor()?);
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
