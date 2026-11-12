# Menubar Notify

A menu-bar app. A bell in the macOS menu bar, or an amber dot in the Windows
tray, with a menu that sends a system notification: at once, or five seconds
later so the pointer has left the menu by the time it lands. A window lists
everything that happened, newest first: sent, scheduled, clicked. It opens
from the menu and from the window's own buttons, and a notification click
opens it and adds a line naming the clicked notification and when it was
sent, which is the click's `id` and `data` coming back.

The worker owns the five-second timer, because `run()` blocks Bun's event
loop on the UI thread. `setActivationPolicy("accessory")` keeps the app out
of the Dock when it runs uncompiled; the `.app` bundle gets the same from
`LSUIElement` in its `Info.plist`.

| Recipe | Does |
|---|---|
| `just demos menubar-notify app` | Runs it uncompiled. On macOS the menu and window work but notifications need a bundle id, so they do not show; the status line says so. |
| `just demos menubar-notify open` | macOS: builds the page, compiles the binary, wraps it in `dist/Menubar Notify.app` and launches it. The first notification asks for permission. |
| `just demos menubar-notify compile` | The page, the Windows exe, the macOS binary and the `.app`, into `dist/`. |

Everything the app does, and every `sweetnative:` error from the library, is
appended to `~/Library/Logs/menubar-notify.log` on macOS and
`%LOCALAPPDATA%\menubar-notify.log` on Windows, because a launched app has
no console.

Windows: the menu opens on right click, and the notification is the tray
icon's toast. macOS: any click opens the menu.
