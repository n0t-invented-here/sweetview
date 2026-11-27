//! Tray icons, popup menus, the folder dialog, and the application-wide settings.
//!
//! Menus arrive as data the TypeScript layer built from the application's
//! template, with each item numbered from 1 in template order; the chosen
//! number goes back, and the TypeScript layer runs the handler it keeps under
//! that number. The object shapes JavaScript passes live here (`#[napi(object)]`
//! compiles under `forbid(unsafe_code)`, D12) with their conversion to the
//! runtime's menu data; the export table in `sweetview-platform-node` only forwards.

use std::rc::Rc;

use napi::bindgen_prelude::{BigInt, Function, Uint8Array};
use napi::Env;
use napi_derive::napi;
use sweetview_runtime::app::{self, ActivationPolicy};
use sweetview_runtime::icon::IconBytes as RuntimeIconBytes;
use sweetview_runtime::menu::{self, MenuData, MenuItem, PopupCorner};
use sweetview_runtime::tray::{Tray as RuntimeTray, TrayInit};
use sweetview_runtime::{dialogs, threads};

use crate::callback::JsCallback;
use crate::errors::OrThrow;

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

/// The runtime's icon from the binding's.
pub fn icon_bytes(icon: IconBytes) -> RuntimeIconBytes {
  RuntimeIconBytes { ico: icon.ico.map(|b| b.to_vec()), png: icon.png.map(|b| b.to_vec()), symbol: icon.symbol, template: icon.template }
}

/// The runtime's menu data from the binding's: a missing `enabled` is true, a
/// missing `checked` false, a missing `id` 0 (an item that reports nothing when
/// chosen), and an entry of an unknown `kind` is left out.
pub fn menu_data(items: Vec<MenuItemData>) -> MenuData {
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

/// A window handle as JavaScript passes it: a `bigint` holding the `HWND`'s value.
pub fn handle_value(handle: &BigInt) -> isize {
  handle.get_i64().0 as isize
}

/// `Menu.popup`: shows `menu` owned by the window `owner`, at the screen point `at` or at the
/// cursor, and returns the chosen item's number after the menu closes; `null` when dismissed.
/// With `above`, the menu's bottom-left corner is at the point (the tray's menu); otherwise its top-left.
pub fn popup_menu(owner: BigInt, menu: Vec<MenuItemData>, at: Option<Point>, above: Option<bool>) -> napi::Result<Option<u32>> {
  let corner = if above == Some(true) { PopupCorner::BottomLeft } else { PopupCorner::TopLeft };
  menu::popup(handle_value(&owner), &menu_data(menu), at.map(|p| (p.x, p.y)), corner).or_throw()
}

/// `buildMenu`: builds `menu` and returns its popup menu handle for the application's own
/// `TrackPopupMenu`; each item's command id is its `id`. Kept alive until `destroy_menu`.
pub fn build_menu(menu: Vec<MenuItemData>) -> napi::Result<BigInt> {
  threads::require_ui_thread().or_throw()?;
  let handle = menu::build_handed_out(&menu_data(menu)).or_throw()?;
  Ok(BigInt::from(handle as i64))
}

/// `destroyMenu`: frees a menu `build_menu` made; false when it was freed already.
pub fn destroy_menu(handle: BigInt) -> napi::Result<bool> {
  threads::require_ui_thread().or_throw()?;
  Ok(menu::destroy_handed_out(handle_value(&handle)))
}

/// `windowMenu`: the system menu of a window of this thread, at the cursor; the chosen command is carried out.
pub fn window_menu(owner: BigInt) -> napi::Result<()> {
  menu::window_menu(handle_value(&owner)).or_throw()
}

/// The OS folder dialog. Blocks until it closes; the path, or `null` when cancelled.
pub fn pick_folder(owner: Option<BigInt>, title: String) -> napi::Result<Option<String>> {
  threads::require_ui_thread().or_throw()?;
  dialogs::pick_folder(owner.as_ref().map(handle_value), &title).or_throw()
}

/// macOS: the application menu and the Edit menu. Windows: nothing.
pub fn install_app_menu(app_name: String, about_text: String) -> napi::Result<()> {
  app::install_app_menu(&app_name, &about_text).or_throw()
}

/// macOS: the Dock tile's image. Windows: nothing.
pub fn set_app_icon(icon: IconBytes) -> napi::Result<()> {
  app::set_app_icon(&icon_bytes(icon)).or_throw()
}

/// macOS: the activation policy, by name. Windows: nothing.
pub fn set_activation_policy(policy: String) -> napi::Result<()> {
  let policy = match policy.as_str() {
    "regular" => ActivationPolicy::Regular,
    "accessory" => ActivationPolicy::Accessory,
    "prohibited" => ActivationPolicy::Prohibited,
    other => return Err(napi::Error::from_reason(format!("sweetview: unknown activation policy \"{other}\""))),
  };
  app::set_activation_policy(policy).or_throw()
}

/// A tray icon whose events call JavaScript functions.
pub struct Tray(RuntimeTray);

/// The JavaScript functions a tray calls.
pub struct TrayFunctions<'a> {
  pub on_click: Option<Function<'a, (), ()>>,
  pub on_double_click: Option<Function<'a, (), ()>>,
  /// Returns the menu to show, as the binding's menu objects.
  pub open_menu: Function<'a, (), Vec<MenuItemData>>,
  pub menu_chosen: Function<'a, u32, ()>,
}

fn handler(env: Env, function: Option<Function<'_, (), ()>>, kind: &'static str) -> napi::Result<Option<Rc<dyn Fn()>>> {
  Ok(match function {
    Some(function) => {
      let callback = JsCallback::new(env, &function, kind)?;
      Some(Rc::new(move || {
        callback.call(());
      }))
    }
    None => None,
  })
}

impl Tray {
  pub fn new(env: Env, tooltip: String, icon: Option<IconBytes>, has_menu: bool, functions: TrayFunctions<'_>) -> napi::Result<Self> {
    let open_menu = JsCallback::new(env, &functions.open_menu, "a tray menu function")?;
    let menu_chosen = JsCallback::new(env, &functions.menu_chosen, "a tray menu handler")?;
    let init = TrayInit {
      tooltip,
      icon: icon.map(icon_bytes),
      has_menu,
      on_click: handler(env, functions.on_click, "a tray click handler")?,
      on_double_click: handler(env, functions.on_double_click, "a tray double-click handler")?,
      // A function that throws opens no menu.
      open_menu: Rc::new(move || open_menu.call(()).map(menu_data).unwrap_or_default()),
      menu_chosen: Rc::new(move |id| {
        menu_chosen.call(id);
      }),
    };
    Ok(Self(RuntimeTray::new(init).or_throw()?))
  }

  pub fn set_tooltip(&self, text: String) -> napi::Result<()> {
    self.0.set_tooltip(&text).or_throw()
  }

  pub fn set_icon(&self, icon: Option<IconBytes>) -> napi::Result<()> {
    self.0.set_icon(icon.map(icon_bytes).as_ref()).or_throw()
  }

  pub fn set_has_menu(&self, has: bool) {
    self.0.set_has_menu(has);
  }

  /// The icon's own window, which the shell posts its mouse messages to. `0n` once disposed.
  pub fn window_handle(&self) -> BigInt {
    BigInt::from(self.0.window_handle_value() as i64)
  }

  pub fn dispose(&self) {
    self.0.dispose();
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn item(kind: &str) -> MenuItemData {
    MenuItemData { kind: kind.into(), id: None, label: None, enabled: None, checked: None, icon: None, items: None }
  }

  #[test]
  fn missing_fields_take_their_defaults_and_unknown_kinds_are_left_out() {
    let data = menu_data(vec![
      item("item"),
      item("separator"),
      MenuItemData { items: Some(vec![item("item"), item("sideways")]), ..item("submenu") },
      item("sideways"),
    ]);
    assert_eq!(
      data,
      vec![
        MenuItem::Item { id: 0, label: String::new(), enabled: true, checked: false, icon: None },
        MenuItem::Separator,
        MenuItem::Submenu {
          label: String::new(),
          enabled: true,
          icon: None,
          items: vec![MenuItem::Item { id: 0, label: String::new(), enabled: true, checked: false, icon: None }],
        },
      ]
    );
  }
}
