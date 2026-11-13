# Permissions

A window that lists the macOS privacy permissions from
`@n1h/sweetview/native`: what macOS says about each right now, an Ask button
that shows the system's prompt for it, and a Settings button that opens its
pane in System Settings > Privacy & Security. The list is read again every
two seconds, so an answer given in a prompt or a switch flipped in Settings
shows up in the window without a click, and the status that changed flashes.

The accent is on the button that moves a row forward: Ask while macOS has no
answer, Settings after a "no", because macOS shows each prompt once. The
three folders read "Ask to find out" until asked, since macOS has no call
that reads them without asking. The line at the bottom says what the last
click did, including the error when a request is refused.

Everything is answered on the UI thread through `uiMethods`; there is no
worker.

| Recipe | Does |
|---|---|
| `just demos permissions open` | macOS: builds the page, compiles the binary, wraps it in `dist/Permissions.app` with a usage description for every permission, and launches it. The app asks in its own name, `dev.mrowr.permissions`. |
| `just demos permissions app` | Runs it uncompiled. macOS files the answers under the app that launched it, such as the terminal, and that app's `Info.plist` decides whether a request is allowed at all: macOS ends a process that asks for a permission its launcher has no usage description for. |
| `just demos permissions compile` | The page, the Windows exe, the macOS binary and the `.app`, into `dist/`. |

The bundle is signed ad-hoc, and macOS knows such a bundle by its exact
contents: after a rebuild the old answers no longer apply to it.
`tccutil reset All dev.mrowr.permissions` clears them.

Every status, every change and every request is appended to
`~/Library/Logs/sweetview-permissions.log` on macOS and
`%LOCALAPPDATA%\sweetview-permissions.log` on Windows, because a launched app
has no console.

Windows: these are macOS permissions, so every row reads "Not applicable" and
the buttons are off.
