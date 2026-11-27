//! Exports of `sweetview_napi::menus`. The object shapes and their conversion
//! to the runtime's menu data live there (D12); each export here forwards.

use napi::bindgen_prelude::{BigInt, Function};
use napi::Env;
use napi_derive::napi;
use sweetview_napi::menus as imp;
pub use sweetview_napi::menus::{icon_bytes, IconBytes, MenuItemData, Point};

/// Shows `menu` as a popup menu owned by the window `owner`, at the screen point `at` (physical
/// pixels) or at the cursor, and returns the chosen item's `id` after it closes; `null` when dismissed.
/// With `above`, the menu opens upward from the point (its bottom-left corner there), as the tray's
/// menu does; otherwise downward (its top-left corner there). Either mouse button chooses an item.
#[napi(catch_unwind)]
pub fn popup_menu(owner: BigInt, menu: Vec<MenuItemData>, at: Option<Point>, above: Option<bool>) -> napi::Result<Option<u32>> {
  imp::popup_menu(owner, menu, at, above)
}

/// Builds `menu` and returns its popup menu handle (`HMENU`) for the application's own
/// `TrackPopupMenu`. Each item's command id is its `id`. The menu, its submenus and its item
/// bitmaps stay alive until `destroyMenu` is called with the handle.
#[napi(catch_unwind)]
pub fn build_menu(menu: Vec<MenuItemData>) -> napi::Result<BigInt> {
  imp::build_menu(menu)
}

/// Frees a menu `buildMenu` made. False when the handle names no such menu (freed already).
#[napi(catch_unwind)]
pub fn destroy_menu(handle: BigInt) -> napi::Result<bool> {
  imp::destroy_menu(handle)
}

/// Shows the system menu (Restore, Move, Size, Minimize, Maximize, Close) of `owner`, a window of
/// this thread, at the cursor, and carries out the chosen command. Any other value shows nothing.
#[napi(catch_unwind)]
pub fn window_menu(owner: BigInt) -> napi::Result<()> {
  imp::window_menu(owner)
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
  imp::set_app_icon(icon)
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
    imp::Tray::new(env, tooltip, icon, has_menu, functions).map(Self)
  }

  #[napi(catch_unwind)]
  pub fn set_tooltip(&self, text: String) -> napi::Result<()> {
    self.0.set_tooltip(text)
  }

  /// `null` shows the stock application icon.
  #[napi(catch_unwind)]
  pub fn set_icon(&self, icon: Option<IconBytes>) -> napi::Result<()> {
    self.0.set_icon(icon)
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
