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

## Exceptions thrown by your callbacks

The functions an application hands Sweetview to call later (a tray's
`onClick`, a menu item's `click`, a `Window` listener, a page's UI-thread
method, ...) run on the UI thread, called from inside the event loop. An
exception one of them throws is caught there: it never ends the loop, and
it never reaches `process.on("uncaughtException")`. What Sweetview does with
it on Windows:

| Callback | What happens to its exception |
|---|---|
| `Tray` `onClick`, `onDoubleClick`, its `menu` function, a tray menu item's `click` | logged `sweetview: message window handler threw:` with the error; a `menu` function that throws opens no menu |
| A `Menu.popup` item's `click` | thrown from `Menu.popup`, to the code that called it: the click runs after the menu has closed, inside that call |
| `Window` `onResize`, `onMove`, `onClose` | logged `sweetview: onResize handler threw:` (`onMove`, `onClose`); a close request is still taken, so the window stays open |
| `Window` `onFileDrop`, `onNewTab`, `onTabSelect`, `onTabClose` | logged `sweetview: onFileDrop handler threw:` (and the others by name) |
| `Notifier` `onClick` | logged `sweetview: notification onClick threw:` |
| A hit-region refiner (`setHitRegions(polygons, refine)`) | logged `sweetview: hit region poll threw:`; the polygon's answer stands |
| `installMouseHook`, `installKeyboardHook` handlers | logged `sweetview: mouse hook handler threw:` (`keyboard hook`); the event is not swallowed. On macOS the hooks are still the bindings package's, which does not catch: Bun throws the exception at the JavaScript that was running the loop |
| `singleInstance` `onSecondInstance`, `onOpenUrl` listeners | logged `sweetview: onSecondInstance handler threw:`, `sweetview: onOpenUrl handler threw:`; the other listeners still run |
| `uiMethods`, `deferredUiMethods` | not logged: the page's call is rejected with the error's message ([app](app.md#exceptions-in-page-calls-requests-and-the-worker)) |
| An `onRequest` function | not logged: the request is answered `500 Internal Server Error` |
| `onReady`, `onReadyTimeout` | logged `sweetview: onReady handler threw:` (`onReadyTimeout`) |
| A method of the worker's service | the page's call is rejected with the error; see [app](app.md#exceptions-in-page-calls-requests-and-the-worker) |

Each logged line is one `console.error(message, error)` call. Should
anything get past these, the binding writes `sweetview: <kind> threw:
<reason>` to stderr from native code, without `console.error`. An executable
compiled with `--windows-hide-console` has no stderr, so in a shipped
application nobody sees any of these lines unless the application routes
them somewhere.

To see its own faults, an application can:

- wrap each handler it hands Sweetview so that an exception goes to its own
  `uncaughtException` listeners, as an unhandled one would. This wrapper
  rethrows afterwards, so Sweetview's fallback still applies (the line is
  logged, the page's call rejects, a hook lets the event through):

  ```ts
  /**
   * Wraps a handler Sweetview calls (a click, a listener, a UI-thread method). An exception it throws
   * goes to the process's "uncaughtException" listeners, as an unhandled exception would, then on to
   * Sweetview as before (logged; a page call is rejected; a hook lets the event through).
   */
  function reported<A extends unknown[], R>(handler: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      try {
        return handler(...args);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (!process.emit("uncaughtException", error, "uncaughtException")) console.error(error);
        throw err;
      }
    };
  }
  ```

  ```ts
  process.on("uncaughtException", (err) => {
    writeFaultLog(err); // the application's own reporter
    process.exit(1);
  });
  const tray = new Tray({ tooltip: "Notes", onClick: reported(() => win.show()), menu: [{ label: "Export", click: reported(exportNotes) }] });
  const win = new Window({ title: "Notes", onClose: reported(() => win.hide()) });
  ```

  A listener that exits ends the process from inside Sweetview's call.
- replace `console.error` with a function that also writes to its own log.
  It then receives every line in the table that says "logged", with the
  error as its second argument. It does not receive the rejected page calls,
  the `500` answers or the binding's last-resort line.
- in the page, `await` each call (or attach a `catch`), so that a rejected
  call is seen there.

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
