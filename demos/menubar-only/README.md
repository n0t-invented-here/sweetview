# Menubar Only

A menu-bar app with no window at all. A timer glyph in the macOS menu bar, or
a teal dot in the Windows tray, with a menu: how long the app has been up, a
"Clock in Tooltip" check box that puts the time in the icon's tooltip once a
second, and Quit.

There is no webview and no worker. `runEventLoop` from `@n1h/sweetview/native`
pumps the OS loop from Bun's own event loop, so the uptime line and the clock
are a plain `setInterval` on the UI thread. `setActivationPolicy("accessory")`
keeps the app out of the Dock when it runs uncompiled; the `.app` bundle gets
the same from `LSUIElement` in its `Info.plist`.

| Recipe | Does |
|---|---|
| `just demos menubar-only app` | Runs it uncompiled. |
| `just demos menubar-only open` | macOS: compiles the binary, wraps it in `dist/Menubar Only.app` and launches it. |
| `just demos menubar-only compile` | The Windows exe, the macOS binary and the `.app`, into `dist/`. |

Windows: the menu opens on right click. macOS: any click opens the menu.
