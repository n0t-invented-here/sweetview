# @n1h/sweetview/native

Native desktop pieces for a Bun app: windows, monitors, menus, trays,
notifications, URL activation, dialogs, the clipboard, the OS event loop and
icons. The module is `@n1h/sweetview/native` in the facade, or the standalone
package `@n1h/sweetview-native`. Install and the overview are in the
[package README](../README.md).

## Two kinds of module

| Kind | Examples | Runs on |
|---|---|---|
| OS entry points: on Windows the Rust binding (N-API), on macOS `bun:ffi` until the macOS goal of the Rust rewrite | `Window`, `Screen`, `Menu.popup`, `Tray`, `Notifier`, `pickFolder`, `Clipboard`, `setAppMenu`, `setAppIcon`, `runEventLoop`, `singleInstance` | Windows and macOS, on the UI thread (the main thread of the Bun process) |
| Pure TypeScript | menu templates (`resolveMenu`), hit-region geometry, icon encoders and the PNG decoder, the regular-file helpers | any OS Bun runs on, any thread |

An OS entry point picks its Windows or macOS backend on its first call. On
any other OS that call throws
`sweetview: <platform> is not supported (win32 and darwin are)`. Importing
the module never throws, so a cross-platform build script can import the
icon encoders from the same module.

On Windows the OS entry points are Rust crates (`tao`, `muda`, `tray-icon`,
`rfd` and this project's own `sweetview-platform-*` crates) compiled into one
N-API binding, `prebuilt/sweetview.win32-x64-msvc.node`, which ships inside
`@n1h/sweetview-native` and loads on the first call. `SWEETVIEW_NATIVE_PATH`
names a binding you built yourself; `just native` builds it from source (see
[Rebuilding](webview-library.md#rebuilding)). On macOS, until the macOS goal of
the Rust rewrite, they call AppKit through `bun:ffi`. Either way an
application's own `bun:ffi` calls on the UI thread, its own modal dialogs and
popup menus included, keep working inside Sweetview's event loop.

A tray-only or menu-bar-only app uses the native module without a webview, a
worker or a page. On macOS the module never loads the webview library
(`@n1h/sweetview-webview-bun`) for these; the `RawWebview` class and the
input hooks it exports for macOS do.

## Windows start-up initialization

The Windows entry points that live on the UI thread (`Window`, `Screen`,
`Tray`, `Notifier`, `Menu.popup`, the event loop and single-instance
activation) start the binding's runtime on first use. Starting it is
idempotent and does three things: `tao`'s event loop declares the process
per-monitor DPI aware (`PER_MONITOR_AWARE_V2`), COM is entered in a
single-threaded apartment, and `tao` creates a hidden top-level window of its
own before any window of Sweetview's, which is the first window Windows 11
needs as a z-order anchor. Creation order therefore does not matter: querying
`Screen` or creating a `Tray` before the first `Window` does not lose DPI
awareness or topmost behaviour. macOS needs no equivalent; AppKit is
initialized when the shared `NSApplication` is first touched.

## Guides

| Guide | Covers |
|---|---|
| [Windows and screens](native/windows.md) | `Window`, `createWindow`, `WindowOptions`, coordinates, framed / frameless / transparent / tabbed windows, `Window.fromHandle`, dragging and resizing, closing, file drops, `Screen` |
| [Overlays and hit regions](native/overlays-and-hit-regions.md) | click-through overlays, `setClickThrough`, `setHitRegions`, `HitRelay` and the geometry helpers, `colorKey` vs `transparent` |
| [Menus and the tray](native/menus-and-tray.md) | `Menu.popup`, `MenuTemplate`, `resolveMenu`, `Tray`, `setAppMenu`, `setActivationPolicy` |
| [Notifications](native/notifications.md) | `Notifier`, `NotificationOptions`, WinRT toasts vs `UNUserNotificationCenter` |
| [Activation and single instance](native/activation-and-single-instance.md) | `registerUrlScheme`, `singleInstance`, `onOpenUrl`, `extractUrlFromArgs`, `signalReady` |
| [Dialogs, clipboard and files](native/dialogs-clipboard-files.md) | `pickFolder`, `Clipboard`, `readTextFile`, `readFileBytes`, chunked file handles |
| [Event loop and icons](native/event-loop-and-icons.md) | `runEventLoop`, `pumpEvents`, `quitEventLoop`, `setAppIcon`, `Window.setIcon`, the icon encoders and PNG decoder |

The hit-region helpers are also importable alone, without `bun:ffi`, from
`@n1h/sweetview/native/hit-regions`, so a page bundle can use them.
