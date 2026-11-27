# sweetview-platform-window

Job: the window-level OS calls `tao` has no API for, and the events of any window by subclass.

`tao` makes every window Sweetview owns. This crate adds what it does not model, on any window of the UI thread, owned or an application's own:

| Item | What it gives | Why `tao` does not serve |
|---|---|---|
| `WindowSubclass` | resize, move, close request, file drop and destroy events, delivered from inside whichever message loop dispatches them | `tao` delivers `WindowEvent`s through its event handler, which it holds back while that handler is running (a handler with a modal dialog open) and never calls under a loop it does not run; and `tao` cannot observe a window it did not make (`Window.fromHandle`) |
| `ExStylePolicy` held by the subclass | `WS_EX_TOOLWINDOW` for `hideFromTaskbar`, `WS_EX_LAYERED` for `colorKey` and `opacity`, the click-through bits, `WS_EX_ACCEPTFILES` only while a drop listener exists, kept through every style change | `tao` rewrites the whole extended style from its own flags whenever one changes, and has no flag for any of these |
| `BorrowedWindow` | a window lent by its handle value for the length of one call (`with_handle_value`: an application's own window, adopted or with a webview mounted in it; a Sweetview window; the tray icon's window that owns its menu), checked with `IsWindow`, or for as long as a `tao` window is borrowed (`of`); it cannot be kept, so a window Sweetview did not make is kept as its handle value and lent again for each call; implements `HasWindowHandle` and `HasDisplayHandle`, so a webview can be mounted in it and `rfd` and `muda` can show a dialog or menu for it | `tao` wraps only windows it made, and `raw-window-handle`'s `WindowHandle::borrow_raw` is `unsafe`: it trusts the caller that the handle names a window |
| `set_placement` | outer position, size, z-order band and frame refresh in one `SetWindowPos`, never activating | `tao` sets an outer position (asynchronously) and an inner size as two calls, and its topmost flag through a style rewrite |
| `show_as`, `set_title`, `press_frame` | hide, minimise, maximise, restore, the title, and a press handed to the OS move or size loop, for a window `tao` did not make (the runtime uses `tao`'s own calls for its windows, except `press_frame` for the tab frame, which waits for the loop to end) | `tao` wraps only windows it made; its `drag_window` and `drag_resize_window` post the press and return at once |
| `set_layered_attributes` | `colorKey`, `opacity` | no `tao` API |
| `show`, `bring_to_front` | today's `show()` semantics: restore if minimised, no activation for `noActivate`, the foreground otherwise | `tao`'s `set_visible` shows with `SW_SHOW`, which activates even a `WS_EX_NOACTIVATE` window (seen in the runtime's `show_activates_unless_no_activate` test) |
| `WindowSubclass::set_hold_visibility` | a style rewrite never changes `WS_VISIBLE`, so `tao`, told afterwards that the window is visible, neither hides it nor activates it | `tao` writes `GWL_STYLE` from its own visibility flag, which is stale after a show it did not make |
| `WindowIcons` | caption and taskbar icons from `.ico` bytes, the best image for each size; dropping it destroys only icons no live window shows (an adopted window that is released keeps its icons) | `tao`'s `set_window_icon` (`ICON_SMALL`) and `WindowExtWindows::set_taskbar_icon` (`ICON_BIG`) take an RGBA image each (`Icon::from_rgba`), so each `.ico` entry would be decoded and scaled here instead of by `CreateIconFromResourceEx`, and `None` would clear the icons instead of setting the stock one; an adopted window has no `tao` window |
| `mouse_buttons_down`, `left_button_down` | `GetAsyncKeyState` | no `tao` API outside its event handler |
| `work_area` | a monitor's work area | `tao`'s `MonitorHandle` has bounds and scale, not the work area |
| `GeometrySnapshot` | styles and outer bounds across a webview mount (`preserveGeometry`) | no `tao` API |
| `chrome` | frame and resizability of an adopted window, from its styles | `tao` wraps only windows it made |
| `show_popup` | a `muda` menu shown as a popup owned by a window, at a point on the screen or at the cursor, returning after it closes | `muda`'s `ContextMenu::show_context_menu_for_hwnd` is `unsafe` (it trusts the caller with the window handle) and takes a point relative to the window; the screen point is converted with `ScreenToClient`, and the `WM_NULL` the shell asks for after such a menu is posted here |
| `double_click_time_ms`, `small_icon_size` | the user's double-click interval and the small-icon size at the system DPI | `tray-icon` leaves telling a single click from a double click to the application; neither `tray-icon` nor `muda` sizes the icons it is given |

This is a platform crate: it may hold `unsafe`, under `rust-rewrite/UNSAFE-POLICY.md`.
