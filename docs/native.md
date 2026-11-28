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

On Windows the OS entry points are Rust crates (`tao`, `muda`, `tray-icon`
and this project's own `sweetview-platform-*` crates) compiled into one
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
  // error: the Error the handler threw, that object itself (a thrown non-error is wrapped, with the value as its cause)
  // kind: where it came from, such as "tray.onClick"
  // name: for webview.bind and webview.bindRaw, the name the function was bound under; for a fault the
  //   binding caught itself, the binding's name for the callback; otherwise absent
});
```

```ts
function onCallbackError(handler: (error: Error, source: CallbackErrorSource) => void): () => void;
type CallbackErrorSource = { readonly kind: CallbackKind; readonly name?: string };
```

It is also exported by `@n1h/sweetview` and `@n1h/sweetview-native`, with
the types `CallbackErrorHandler`, `CallbackErrorSource` and `CallbackKind`.
It returns the function that removes the listener; any number can be set,
and each is called in the order it was added, on the UI thread. It is a
call of the UI thread: from a `Worker`, where no callback of the native
module runs, it throws `sweetview: this call must be made on the UI thread`.

- With no listener set, Sweetview does what it always did: the
  `console.error` line in the table below.
- With a listener set, the listener is called in place of that line, and
  before the callback's fallback, which still applies: a hook lets the event
  through, a menu function that throws opens no menu, a close request is
  still taken.
- A listener that throws never takes the application down: Sweetview
  catches it, prints its own line for the original error and
  `sweetview: an onCallbackError handler threw:` for the listener's, and
  calls the next listener.
- A fault raised while the listeners run (a listener that calls back into
  Sweetview, whose callback then throws) is printed with its line and not
  delivered again, so a report always ends and the fault is not lost.
- A listener may end the application: `process.exit(code)` from inside it
  ends the process with that code, from inside either loop.

On macOS, until the macOS goal of the Rust rewrite, no listener is called:
every catch prints what it printed before, and an input hook handler's
exception leaves the bindings package as it always did.

| `kind` | The callback | Printed with no listener | Its fallback |
|---|---|---|---|
| `tray.onClick`, `tray.onDoubleClick` | `Tray` `onClick`, `onDoubleClick` | `sweetview: message window handler threw:` | none |
| `tray.menu` | a `Tray`'s `menu` function | `sweetview: message window handler threw:` | no menu opens |
| `menu.click` | a tray menu item's `click` | `sweetview: message window handler threw:` | none |
| `notifier.onClick` | `Notifier` `onClick` | `sweetview: notification onClick threw:` | none |
| `window.onClose`, `window.onResize`, `window.onMove` | those `Window` listeners | `sweetview: onClose handler threw:` (`onResize`, `onMove`) | a close request is still taken: the window stays open |
| `window.onFileDrop`, `window.onNewTab`, `window.onTabSelect`, `window.onTabClose` | those `Window` listeners | `sweetview: onFileDrop handler threw:` (and the others by name) | none |
| `window.onMaximizeChange` | `Window` `onMaximizeChange`, the listener `windowChromeEvents` of `@n1h/sweetview/window-chrome` installs included | `sweetview: onMaximizeChange handler threw:` | none |
| `hitRegions.refine` | the refiner of `setHitRegions(polygons, refine)` | `sweetview: hit region poll threw:` | the polygon's answer stands |
| `mouseHook`, `keyboardHook` | `installMouseHook`, `installKeyboardHook` handlers | `sweetview: mouse hook handler threw:` (`keyboard hook`) | the event is not swallowed |
| `singleInstance.onSecondInstance`, `onOpenUrl` | those listeners | `sweetview: onSecondInstance handler threw:`, `sweetview: onOpenUrl handler threw:` | the other listeners still run |
| `webview.bind` | a function bound with the raw webview class's `bind` (`name` is its name), which throws or whose promise rejects | nothing; for a value thrown at once whose reading throws (a `Proxy` whose traps throw), `sweetview: a binding threw:` with what the reading threw, as before | the page's call is rejected |
| `webview.bindRaw` | a function bound with `bindRaw` (caught by the binding itself; `name` is the name it was bound under) | `sweetview: a binding threw:` | the page's call is left unanswered |
| `webview.setRequestHandler` | the raw webview class's request handler, which throws or whose promise rejects | nothing; for a returned value whose check for a Promise throws (its `then`, an `instanceof` trap), `sweetview: a request handler threw:`, as before | the request is answered `500` |
| `webview.setFileDropHandler` | the raw webview class's file drop handler | nothing | none |
| `worker` | an `onEvent` listener of a `createApp` application or a `WebView`, called as the worker's events are delivered on the UI thread | `sweetview: UI dispatch failed:` (several in one delivery: one `AggregateError`) | the other listeners and the page still get the event, and the delivery goes on. An event delivered while Sweetview cleans up after the worker failed is not reported: that cleanup prints `sweetview: draining the failed worker's replies threw:` |
| `internal` | the native module's own code at a callback boundary (the tab frame's callbacks, a window's dispose hooks, its own native timeouts, intervals and deferred jobs, which no public call makes); a fault here is a defect of Sweetview's | its own line | that boundary's |

What a listener is not told about, each handled as with no listener
([app](app.md#exceptions-in-page-calls-requests-and-the-worker)):

- a page's `uiMethods` or `deferredUiMethods` method, and an `onRequest`
  function: the call is rejected or the request answered `500`, and nothing
  is printed;
- `onReady` and `onReadyTimeout`: `sweetview: onReady handler threw:`
  (`onReadyTimeout`), printed with a listener too;
- the worker: a method of its service that throws (the call is rejected), a
  method called with `notify` (printed in the worker as `<method> failed:`),
  its route handler (`500`), its own crash (`sweetview: the worker failed:`,
  printed with a listener too), and any other fault inside it;
- an `onEvent` listener's exception while Sweetview cleans up after the
  worker failed: `sweetview: draining the failed worker's replies threw:`;
- the tab machinery of `@n1h/sweetview` on Windows (moving a tab to a new
  window, detaching a tab from the strip, opening a page's new-window request
  as a tab): its error is printed with `console.error`;
- a `Menu.popup` item's `click` on Windows, which runs after the menu has
  closed, inside `Menu.popup`, so its exception comes out of `Menu.popup` to
  the code that called it. On Windows, a fault
the binding itself catches past these (its `sweetview: <kind> threw:` line
on stderr) reaches the listener too: the error is the value the callback
threw, and `name` is the binding's name for the callback, or for a function
bound with `bindRaw` the name it was bound under.

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

In 1.0 a fault caught at a callback boundary never reaches
`process.on("uncaughtException")`, and the application goes on: one whose
`uncaughtException` listener writes its fault log writes these faults from
its `onCallbackError` listener, as above.

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
