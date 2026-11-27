# sweetview-platform-window

Job: the window-level OS calls `tao` has no API for, and the events of any window by subclass.

`tao` makes every window Sweetview owns. This crate adds what it does not model, on any window of the UI thread, owned or an application's own:

| Item | What it gives | Why `tao` does not serve |
|---|---|---|
| `WindowSubclass` | resize, move, close request, file drop and destroy events, delivered from inside whichever message loop dispatches them | `tao` delivers `WindowEvent`s through its event handler, which it holds back while that handler is running (a handler with a modal dialog open) and never calls under a loop it does not run; and `tao` cannot observe a window it did not make (`Window.fromHandle`) |
| `ExStylePolicy` held by the subclass | `WS_EX_TOOLWINDOW` for `hideFromTaskbar`, `WS_EX_LAYERED` for `colorKey` and `opacity`, the click-through bits, `WS_EX_ACCEPTFILES` only while a drop listener exists, kept through every style change | `tao` rewrites the whole extended style from its own flags whenever one changes, and has no flag for any of these |
| `ForeignWindow` | an application's own window by handle, checked with `IsWindow`; implements `HasWindowHandle` so a webview can be mounted in it | `tao` wraps only windows it made |
| `set_outer_bounds`, `move_outer`, `resize_outer` | outer position and size in one `SetWindowPos` | `tao` sets an outer position and an inner size, as two calls |
| `set_layered_attributes` | `colorKey`, `opacity` | no `tao` API |
| `show` (for windows `tao` did not make), `bring_to_front` | today's `show()` semantics: restore if minimised, no activation for `noActivate`, the foreground otherwise | `tao`'s `set_visible` activates, and `set_focus` is refused for a window that is not yet visible |
| `WindowIcons` | caption and taskbar icons from `.ico` bytes, the best image for each size, destroyed when replaced | `tao::window::Icon` takes one RGBA image for both sizes |
| `mouse_buttons_down`, `left_button_down` | `GetAsyncKeyState` | no `tao` API outside its event handler |
| `work_area` | a monitor's work area | `tao`'s `MonitorHandle` has bounds and scale, not the work area |
| `GeometrySnapshot` | styles and outer bounds across a webview mount (`preserveGeometry`) | no `tao` API |
| `chrome` | frame and resizability of an adopted window, from its styles | `tao` wraps only windows it made |

This is a platform crate: it may hold `unsafe`, under `rust-rewrite/UNSAFE-POLICY.md`.
