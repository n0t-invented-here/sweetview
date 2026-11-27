//! Exports of `sweetview_napi::menus`, and the object shapes they take.
//!
//! The `#[napi(object)]` shapes live here because their derive expands to
//! `unsafe` conversion code; each is turned into the runtime's own type by a
//! field-for-field copy below, and nothing else is decided here.

use napi::bindgen_prelude::{BigInt, Function, Uint8Array};
use napi::Env;
use napi_derive::napi;
use sweetview_napi::menus as imp;
use sweetview_runtime::icon::IconBytes as RuntimeIconBytes;
use sweetview_runtime::menu::{MenuData, MenuItem};

/// One icon, as Sweetview's `Icon` type carries it. Windows reads `ico`, then `png`.
#[napi(object)]
pub struct IconBytes {
  pub ico: Option<Uint8Array>,
  pub png: Option<Uint8Array>,
  pub symbol: Option<String>,
  pub template: Option<bool>,
}

/// One menu entry. `kind` says which fields are read: an `item` has `id` (from 1), `label`,
/// `enabled`, `checked` and `icon`; a `submenu` has `label`, `enabled`, `icon` and `items`.
#[napi(object)]
pub struct MenuItemData {
  #[napi(ts_type = "'item' | 'submenu' | 'separator'")]
  pub kind: String,
  pub id: Option<u32>,
  pub label: Option<String>,
  pub enabled: Option<bool>,
  pub checked: Option<bool>,
  pub icon: Option<IconBytes>,
  pub items: Option<Vec<MenuItemData>>,
}

/// A point on the screen, in physical pixels.
#[napi(object)]
pub struct Point {
  pub x: f64,
  pub y: f64,
}

pub(crate) fn icon_bytes(icon: IconBytes) -> RuntimeIconBytes {
  RuntimeIconBytes { ico: icon.ico.map(|b| b.to_vec()), png: icon.png.map(|b| b.to_vec()), symbol: icon.symbol, template: icon.template }
}

fn menu_data(items: Vec<MenuItemData>) -> MenuData {
  items
    .into_iter()
    .filter_map(|item| match item.kind.as_str() {
      "separator" => Some(MenuItem::Separator),
      "submenu" => Some(MenuItem::Submenu {
        label: item.label.unwrap_or_default(),
        enabled: item.enabled.unwrap_or(true),
        icon: item.icon.map(icon_bytes),
        items: menu_data(item.items.unwrap_or_default()),
      }),
      "item" => Some(MenuItem::Item {
        id: item.id.unwrap_or(0),
        label: item.label.unwrap_or_default(),
        enabled: item.enabled.unwrap_or(true),
        checked: item.checked.unwrap_or(false),
        icon: item.icon.map(icon_bytes),
      }),
      _ => None,
    })
    .collect()
}

/// Shows `menu` as a popup menu owned by the window `owner`, at the screen point `at` (physical
/// pixels) or at the cursor, and returns the chosen item's `id` after it closes; `null` when dismissed.
#[napi(catch_unwind)]
pub fn popup_menu(owner: BigInt, menu: Vec<MenuItemData>, at: Option<Point>) -> napi::Result<Option<u32>> {
  imp::popup_menu(owner, menu_data(menu), at.map(|p| (p.x, p.y)))
}

/// The OS folder dialog, owned by the window `owner` when given. Blocks until it closes and
/// returns the chosen folder's path, or `null` when cancelled.
#[napi(catch_unwind)]
pub fn pick_folder(owner: Option<BigInt>, title: String) -> napi::Result<Option<String>> {
  imp::pick_folder(owner, title)
}

/// macOS: the application menu (About, Quit) and the Edit menu. Windows: nothing.
#[napi(catch_unwind)]
pub fn install_app_menu(app_name: String, about_text: String) -> napi::Result<()> {
  imp::install_app_menu(app_name, about_text)
}

/// macOS: the running application's Dock icon. Windows: nothing.
#[napi(catch_unwind)]
pub fn set_app_icon(icon: IconBytes) -> napi::Result<()> {
  imp::set_app_icon(icon_bytes(icon))
}

/// macOS: the process's activation policy. Windows: nothing.
#[napi(catch_unwind)]
pub fn set_activation_policy(#[napi(ts_arg_type = "'regular' | 'accessory' | 'prohibited'")] policy: String) -> napi::Result<()> {
  imp::set_activation_policy(policy)
}

/// A notification-area icon. Clicks, double clicks and the right-click menu call the functions
/// it was made with, from inside whichever loop the UI thread is in.
#[napi]
pub struct Tray(imp::Tray);

#[napi]
impl Tray {
  /// `openMenu` is called each time the menu is about to open and returns it; `menuChosen` is
  /// called after it closes with the chosen item's `id`.
  #[napi(constructor, catch_unwind)]
  #[allow(clippy::too_many_arguments)]
  pub fn new(
    env: Env,
    tooltip: String,
    icon: Option<IconBytes>,
    has_menu: bool,
    on_click: Option<Function<'_, (), ()>>,
    on_double_click: Option<Function<'_, (), ()>>,
    open_menu: Function<'_, (), Vec<MenuItemData>>,
    menu_chosen: Function<'_, u32, ()>,
  ) -> napi::Result<Self> {
    let functions = imp::TrayFunctions { on_click, on_double_click, open_menu, menu_chosen };
    imp::Tray::new(env, tooltip, icon.map(icon_bytes), has_menu, functions, menu_data).map(Self)
  }

  #[napi(catch_unwind)]
  pub fn set_tooltip(&self, text: String) -> napi::Result<()> {
    self.0.set_tooltip(text)
  }

  /// `null` shows the stock application icon.
  #[napi(catch_unwind)]
  pub fn set_icon(&self, icon: Option<IconBytes>) -> napi::Result<()> {
    self.0.set_icon(icon.map(icon_bytes))
  }

  /// Whether a right click opens the menu.
  #[napi(catch_unwind)]
  pub fn set_has_menu(&self, has: bool) {
    self.0.set_has_menu(has)
  }

  /// The icon's own window, which the shell posts its mouse messages to. `0n` once disposed.
  #[napi(getter, catch_unwind)]
  pub fn window_handle(&self) -> BigInt {
    self.0.window_handle()
  }

  /// Removes the icon. Safe to call twice.
  #[napi(catch_unwind)]
  pub fn dispose(&self) {
    self.0.dispose()
  }
}
