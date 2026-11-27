# sweetview-platform-window

Job: the window-level OS calls `tao` has no API for, and the events of any window by subclass.

`tao` makes every window Sweetview owns. This crate adds what it does not model, on any window of the UI thread, owned or an application's own:

| Item | What it gives | Why `tao` does not serve |
|---|---|---|
| `WindowSubclass` | resize, move, close request, file drop and destroy events, delivered from inside whichever message loop dispatches them | `tao` delivers `WindowEvent`s through its event handler, which it holds back while that handler is running (a handler with a modal dialog open) and never calls under a loop it does not run; and `tao` cannot observe a window it did not make (`Window.fromHandle`) |
| `ExStylePolicy` held by the subclass | `WS_EX_TOOLWINDOW` for `hideFromTaskbar`, `WS_EX_LAYERED` for `colorKey` and `opacity`, the click-through bits, `WS_EX_ACCEPTFILES` only while a drop listener exists, kept through every style change | `tao` rewrites the whole extended style from its own flags whenever one changes, and has no flag for any of these |
| `ForeignWindow` | a window named by its handle value (an application's own window, adopted or with a webview mounted in it; a Sweetview window; the tray icon's window that owns its menu), checked with `IsWindow`; implements `HasWindowHandle` and `HasDisplayHandle`, so a webview can be mounted in it and `rfd` and `muda` can show a dialog or menu for it | `tao` wraps only windows it made, and `raw-window-handle`'s `WindowHandle::borrow_raw` is `unsafe`: it trusts the caller that the handle names a window |
| `set_outer_bounds`, `move_outer`, `resize_outer` | outer position and size in one `SetWindowPos` | `tao` sets an outer position and an inner size, as two calls |
| `set_layered_attributes` | `colorKey`, `opacity` | no `tao` API |
| `show`, `bring_to_front` | today's `show()` semantics: restore if minimised, no activation for `noActivate`, the foreground otherwise | `tao`'s `set_visible` shows with `SW_SHOW`, which activates even a `WS_EX_NOACTIVATE` window (seen in the runtime's `show_activates_unless_no_activate` test) |
| `WindowSubclass::set_hold_visibility` | a style rewrite never changes `WS_VISIBLE`, so `tao`, told afterwards that the window is visible, neither hides it nor activates it | `tao` writes `GWL_STYLE` from its own visibility flag, which is stale after a show it did not make |
| `WindowIcons` | caption and taskbar icons from `.ico` bytes, the best image for each size, destroyed when replaced | `tao::window::Icon` takes one RGBA image for both sizes |
| `mouse_buttons_down`, `left_button_down` | `GetAsyncKeyState` | no `tao` API outside its event handler |
| `work_area` | a monitor's work area | `tao`'s `MonitorHandle` has bounds and scale, not the work area |
| `GeometrySnapshot` | styles and outer bounds across a webview mount (`preserveGeometry`) | no `tao` API |
| `chrome` | frame and resizability of an adopted window, from its styles | `tao` wraps only windows it made |
| `show_popup`, `set_command_id` | a `muda` menu tracked as a popup owned by a window, at a point on the screen with its top-left or bottom-left corner there, returning the chosen item's command id after it closes; the command id of an item | `muda` 0.22's `ContextMenu::show_context_menu_for_hwnd` is `unsafe`, passes `TPM_LEFTALIGN \| TPM_RETURNCMD` only (no right-button choice, no bottom alignment) and reports the item through its process-wide `MenuEvent`; here `TrackPopupMenu` is called with `TPM_RIGHTBUTTON \| TPM_RETURNCMD` (and `TPM_BOTTOMALIGN` for the tray), the items carry the caller's numbers as command ids, and the `WM_NULL` the shell asks for after such a menu is posted |
| `double_click_time_ms`, `small_icon_size` | the user's double-click interval and the small-icon size at the system DPI | `tray-icon` leaves telling a single click from a double click to the application; neither `tray-icon` nor `muda` sizes the icons it is given |

This is a platform crate: it may hold `unsafe`, under `rust-rewrite/UNSAFE-POLICY.md`.
