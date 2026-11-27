# sweetview-platform-window

Job: the window-level OS calls `tao` has no API for.

| Item | What it gives | Why no crate serves |
|---|---|---|
| `OwnerWindow` | a window named by its handle value (a Sweetview window, an application's own, the tray icon's window), checked with `IsWindow`, handed to `rfd` and `muda` through `raw-window-handle` | `raw-window-handle`'s `WindowHandle::borrow_raw` is `unsafe`: it trusts the caller that the handle names a window |
| `show_popup` | a `muda` menu shown as a popup owned by a window, at a point on the screen or at the cursor, returning after it closes | `muda`'s `ContextMenu::show_context_menu_for_hwnd` is `unsafe` (it trusts the caller with the window handle) and takes a point relative to the window; the screen point is converted with `ScreenToClient`, and the `WM_NULL` the shell asks for after such a menu is posted here |
| `double_click_time_ms`, `small_icon_size` | the user's double-click interval and the small-icon size at the system DPI | `tray-icon` leaves telling a single click from a double click to the application; neither `tray-icon` nor `muda` sizes the icons it is given |

This is a platform crate: it may hold `unsafe`, under `rust-rewrite/UNSAFE-POLICY.md`.
