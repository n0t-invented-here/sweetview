//! Tray icons, popup menus, the folder dialog, and the application-wide settings.
//!
//! Menus arrive as data the TypeScript layer built from the application's
//! template, with each item numbered from 1; the chosen number goes back, and
//! the TypeScript layer runs the handler it keeps under that number.

use std::rc::Rc;

use napi::bindgen_prelude::{BigInt, FromNapiValue, Function};
use napi::Env;
use sweetview_runtime::app::{self, ActivationPolicy};
use sweetview_runtime::icon::IconBytes;
use sweetview_runtime::menu::{self, MenuData};
use sweetview_runtime::tray::{Tray as RuntimeTray, TrayInit};
use sweetview_runtime::{dialogs, threads};

use crate::callback::JsCallback;
use crate::errors::OrThrow;

/// A window handle as JavaScript passes it: a `bigint` holding the `HWND`'s value.
pub fn handle_value(handle: &BigInt) -> isize {
  handle.get_i64().0 as isize
}

/// `Menu.popup`: shows `menu` owned by the window `owner`, at the screen point `at` or at the
/// cursor, and returns the chosen item's number after the menu closes; `null` when dismissed.
pub fn popup_menu(owner: BigInt, menu: MenuData, at: Option<(f64, f64)>) -> napi::Result<Option<u32>> {
  menu::popup(handle_value(&owner), &menu, at).or_throw()
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
  app::set_app_icon(&icon).or_throw()
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
pub struct TrayFunctions<'a, M: FromNapiValue> {
  pub on_click: Option<Function<'a, (), ()>>,
  pub on_double_click: Option<Function<'a, (), ()>>,
  /// Returns the menu to show, as the binding's menu objects; `menu_data` converts them.
  pub open_menu: Function<'a, (), M>,
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
  /// `menu_data` converts what `open_menu` returns into the runtime's menu data.
  pub fn new<M: FromNapiValue + 'static>(
    env: Env,
    tooltip: String,
    icon: Option<IconBytes>,
    has_menu: bool,
    functions: TrayFunctions<'_, M>,
    menu_data: fn(M) -> MenuData,
  ) -> napi::Result<Self> {
    let open_menu = JsCallback::new(env, &functions.open_menu, "a tray menu function")?;
    let menu_chosen = JsCallback::new(env, &functions.menu_chosen, "a tray menu handler")?;
    let init = TrayInit {
      tooltip,
      icon,
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
    self.0.set_icon(icon.as_ref()).or_throw()
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
