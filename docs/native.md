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
names a binding you built yourself. A clone of this repository does not
contain the binding: `just native build` builds it from source with the Rust
toolchain, and the recipes that run the demos and the tests build it first
(see [Rebuilding](webview-library.md#rebuilding)). On macOS, until the macOS goal of
the Rust rewrite, they call AppKit through `bun:ffi`. Either way an
application's own `bun:ffi` calls on the UI thread, its own modal dialogs and
popup menus included, keep working inside Sweetview's event loop.

A tray-only or menu-bar-only app uses the native module without a webview, a
worker or a page. On macOS the module does not need the webview library
(`@n1h/sweetview-webview-bun`) for these: it loads the library when imported
if it is installed, and only the `RawWebview` class, the input hooks and
`permissions` throw without it, when used.

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

## Exceptions thrown by your callbacks

The functions an application hands the native module to call later (a
tray's `onClick`, a menu item's `click`, a `Window` listener, a hook, ...)
run on the UI thread, called from inside the event loop. An exception one of
them throws is caught there: it never ends the loop, and it never reaches
`process.on("uncaughtException")` by itself. To see these faults, set one
listener:

```ts
import { onCallbackError } from "@n1h/sweetview/native";

onCallbackError((error, { kind, name }) => {
  // error: the Error the handler threw (a thrown non-error is wrapped, with the value as its cause)
  // kind: where it came from, such as "tray.onClick"; name: the binding's own name, when it caught it
});
```

```ts
function onCallbackError(handler: (error: Error, source: CallbackErrorSource) => void): () => void;
type CallbackErrorSource = { readonly kind: CallbackKind; readonly name?: string };
```

It is also exported by `@n1h/sweetview` and `@n1h/sweetview-native`, with
the types `CallbackErrorHandler`, `CallbackErrorSource` and `CallbackKind`.
It returns the function that removes the listener; any number can be set,
and each is called in the order it was added, on the UI thread.

- With no listener set, Sweetview does what it always did: the
  `console.error` line in the table below.
- With a listener set, the listener is called in place of that line. The
  callback's fallback still applies: a hook lets the event through, a menu
  function that throws opens no menu, a close request is still taken.
- A listener that throws never takes the application down: Sweetview
  catches it, prints its own line for the original error and
  `sweetview: an onCallbackError handler threw:` for the listener's, and
  calls the next listener.
- A listener may end the application: `process.exit(code)` from inside it
  ends the process with that code, from inside either loop.

On macOS, until the macOS goal of the Rust rewrite, no listener is called:
every catch prints what it printed before, and an input hook handler's
exception leaves the bindings package as it always did.

| `kind` | The callback | Printed with no listener | Its fallback |
|---|---|---|---|
| `tray.onClick`, `tray.onDoubleClick` | `Tray` `onClick`, `onDoubleClick` | `sweetview: message window handler threw:` | none |
| `tray.menu` | a `Tray`'s `menu` function | `sweetview: message window handler threw:` | no menu opens |
| `menu.click` | a tray menu item's `click` (on macOS also a `Menu.popup` item's) | `sweetview: message window handler threw:` | none |
| `notifier.onClick` | `Notifier` `onClick` | `sweetview: notification onClick threw:` | none |
| `window.onClose`, `window.onResize`, `window.onMove` | those `Window` listeners | `sweetview: onClose handler threw:` (`onResize`, `onMove`) | a close request is still taken: the window stays open |
| `window.onFileDrop`, `window.onNewTab`, `window.onTabSelect`, `window.onTabClose` | those `Window` listeners | `sweetview: onFileDrop handler threw:` (and the others by name) | none |
| `window.onMaximizeChange` | `Window` `onMaximizeChange` | `sweetview: onMaximizeChange handler threw:` | none |
| `windowChromeEvents` | the listener `windowChromeEvents` of `@n1h/sweetview/window-chrome` installs on the window (sending `window.maximized` to the page) | `sweetview: onMaximizeChange handler threw:` | none |
| `hitRegions.refine` | the refiner of `setHitRegions(polygons, refine)` | `sweetview: hit region poll threw:` | the polygon's answer stands |
| `mouseHook`, `keyboardHook` | `installMouseHook`, `installKeyboardHook` handlers | `sweetview: mouse hook handler threw:` (`keyboard hook`) | the event is not swallowed |
| `singleInstance.onSecondInstance`, `onOpenUrl` | those listeners | `sweetview: onSecondInstance handler threw:`, `sweetview: onOpenUrl handler threw:` | the other listeners still run |
| `worker` | the delivery of the worker's replies and events on the UI thread, the application's `onEvent` listeners included | `sweetview: UI dispatch failed:` | the next delivery still runs |
| `timeout`, `interval`, `deferred` | a native timeout, interval or deferred job | `sweetview: message window handler threw:`, the binding's line, `sweetview: UI dispatch failed:` | an interval keeps its schedule |
| `internal` | the native module's own code at a callback boundary (the tab frame's callbacks, a window's dispose hooks); a fault here is a defect of Sweetview's | its own line | that boundary's |

What a listener is not told about: the faults `@n1h/sweetview` catches (a
page's UI-thread method, a request handler, the ready hooks, the worker's
crash and its rejected calls, the tab machinery), which are handled as with
no listener ([app](app.md#exceptions-in-page-calls-requests-and-the-worker));
a fault inside the worker; and a `Menu.popup` item's `click` on Windows,
which runs after the menu has closed, inside `Menu.popup`, so its exception
comes out of `Menu.popup` to the code that called it. On Windows, a fault
the binding itself catches past these (its `sweetview: <kind> threw:` line
on stderr) reaches the listener too, with the binding's name for the
callback as `name` and the binding's text of the exception (such as
`Error: boom`) as the message.

A shipped application has no console: an executable compiled with
`--windows-hide-console` has no stderr, so without a listener these lines
reach nobody. One listener sends them to the application's own reporter:

```ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { onCallbackError } from "@n1h/sweetview/native";

const faultLog = join(process.env.LOCALAPPDATA ?? ".", "my-app", "faults.log");
mkdirSync(dirname(faultLog), { recursive: true });
onCallbackError((error, { kind, name }) => {
  appendFileSync(faultLog, `${new Date().toISOString()} ${kind}${name ? ` ${name}` : ""}: ${error.stack ?? error.message}\n`);
});
```

An application whose `process.on("uncaughtException")` listener already
writes its fault log and exits hands the faults on with one line:
`onCallbackError((error) => void process.emit("uncaughtException", error, "uncaughtException"))`.

In the page, `await` each call (or `catch` it): a call a page never awaits
is rejected unseen there, whatever the UI thread does with the fault.

## Guides

| Guide | Covers |
|---|---|
| [Windows and screens](native/windows.md) | `Window`, `createWindow`, `WindowOptions`, coordinates, framed / frameless / transparent / tabbed windows, `Window.fromHandle`, dragging and resizing, closing, file drops, `Screen` |
| [Overlays and hit regions](native/overlays-and-hit-regions.md) | click-through overlays, `setClickThrough`, `setHitRegions`, `HitRelay` and the geometry helpers, `colorKey` vs `transparent` |
| [Menus and the tray](native/menus-and-tray.md) | `Menu.popup` (and `MenuPopupOptions`, for a menu that opens upward), `MenuTemplate`, `resolveMenu`, `Tray`, `setAppMenu`, `setActivationPolicy` |
| [Notifications](native/notifications.md) | `Notifier`, `NotificationOptions`, WinRT toasts vs `UNUserNotificationCenter` |
| [Activation and single instance](native/activation-and-single-instance.md) | `registerUrlScheme`, `singleInstance`, `onOpenUrl`, `extractUrlFromArgs`, `signalReady` |
| [Dialogs, clipboard and files](native/dialogs-clipboard-files.md) | `pickFolder`, `Clipboard`, `readTextFile`, `readFileBytes`, chunked file handles |
| [Event loop and icons](native/event-loop-and-icons.md) | `runEventLoop`, `pumpEvents`, `quitEventLoop`, `setAppIcon`, `Window.setIcon`, the icon encoders and PNG decoder |

The hit-region helpers are also importable alone, without `bun:ffi`, from
`@n1h/sweetview/native/hit-regions`, so a page bundle can use them.
