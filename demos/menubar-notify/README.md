# Menubar Notify

A menu-bar app with no window. A bell in the macOS menu bar, or an amber dot
in the Windows tray, with a menu that sends a system notification: at once, or
five seconds later so the pointer has left the menu by the time it lands. The
menu's first line shows what happened last: sent, clicked, or pending.

There is no webview and no worker. `runEventLoop` from `@n1h/sweetview/native`
pumps the OS loop from Bun's own event loop, so the five-second delay is a
plain `setTimeout` on the UI thread. `setActivationPolicy("accessory")` keeps
the app out of the Dock when it runs uncompiled; the `.app` bundle gets the
same from `LSUIElement` in its `Info.plist`.

| Recipe | Does |
|---|---|
| `just demos menubar-notify app` | Runs it uncompiled. On macOS the menu works but notifications need a bundle id, so they do not show; the status line says so. |
| `just demos menubar-notify open` | macOS: compiles the binary, wraps it in `dist/Menubar Notify.app` and launches it. The first notification asks for permission. |
| `just demos menubar-notify compile` | The Windows exe, the macOS binary and the `.app`, into `dist/`. |

Windows: the menu opens on right click, and the notification is the tray
icon's toast. macOS: any click opens the menu.
