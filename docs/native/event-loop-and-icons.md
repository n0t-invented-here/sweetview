# Event loop and icons

How the OS event loop runs without a webview, how an app and its windows get
their icons, and the pure-TypeScript encoders that produce those icons. Part
of the [native module](../native.md).

- [The event loop](#the-event-loop)
  - [runEventLoop and quitEventLoop](#runeventloop-and-quiteventloop)
  - [pumpEvents](#pumpevents)
- [App icon vs window icon](#app-icon-vs-window-icon)
- [Icon](#icon)
- [Icon encoders and the PNG decoder](#icon-encoders-and-the-png-decoder)

## The event loop

Every window, tray, notifier and menu belongs to the UI thread, and their
callbacks only run while that thread is dispatching OS events. There are two
ways to do that. `webview.run()` / `app.run()` call the webview library's
blocking loop, which stops Bun's own event loop on that thread until it
returns. `runEventLoop` turns it around: a Bun timer dispatches pending OS
events every few milliseconds, so timers, promises and I/O keep working on
the UI thread and the app needs no worker. The
[app reference](../app.md#the-event-loop) compares the two.

### runEventLoop and quitEventLoop

```ts
import { Tray, dotIco, quitEventLoop, runEventLoop, setActivationPolicy } from "@n1h/sweetview/native";

setActivationPolicy("accessory");
new Tray({
  icon: { windows: { ico: dotIco() }, macos: { symbol: "clock" } },
  menu: [{ label: "Quit", click: quitEventLoop }],
});
await runEventLoop();
```

```ts
runEventLoop(options?: { intervalMs?: number }): Promise<void>
quitEventLoop(): void
```

`runEventLoop` calls [`pumpEvents`](#pumpevents) every `intervalMs`
(default 16) and resolves when `quitEventLoop()` is called or the OS ends the
loop (a `WM_QUIT` on Windows). Create trays, notifiers and windows before or
after calling it, on the same thread. A click reaches its handler at most one
interval late; once a menu is open, it tracks at native speed inside the
pump. At 16 ms the idle cost is one wake per interval.

| Condition | Error |
|---|---|
| `intervalMs` not a number of at least 1 | `RangeError` `intervalMs must be a number of at least 1, got <value>` |
| A loop is already running | `Error` `sweetview: runEventLoop is already running` |
| Unsupported OS | `Error` `sweetview: <platform> is not supported (win32 and darwin are)`, thrown synchronously |

`quitEventLoop()` resolves the running loop's promise, and does nothing when
no loop runs. It is to `runEventLoop` what `quit()` is to `webview.run()`.

### pumpEvents

```ts
pumpEvents(): boolean
```

Dispatches every OS event waiting for the UI thread and returns at once, for
an app that drives its own loop.

- Windows: `PeekMessage` / `TranslateMessage` / `DispatchMessage` until the
  queue is empty. Returns `false` when it dequeues `WM_QUIT` (from
  `PostQuitMessage`): the loop is over and the caller should stop pumping.
- macOS: on the first call, `[NSApp finishLaunching]`, so the app registers
  with the window server, status items appear and notification delegates
  start receiving callbacks. Each call runs one non-blocking
  `CFRunLoopRunInMode` pass, which services timers, Mach ports and WebKit's
  main-queue dispatches that an event fetch alone can skip, then hands every
  queued `NSEvent` to `sendEvent:`, inside its own autorelease pool. Always
  returns `true`: AppKit has no quit message, and `terminate:` ends the
  process itself.

## App icon vs window icon

```ts
import { Window, icoFromPng, icnsFromPng, setAppIcon } from "@n1h/sweetview/native";

const png = new Uint8Array(await Bun.file("icon.png").arrayBuffer());
setAppIcon({ macos: { png } });                              // Dock and Cmd+Tab
const win = new Window({ title: "Editor", icon: { windows: { ico: icoFromPng(png) } } }); // title bar, taskbar
```

The two platforms attach icons to different things:

- macOS has one icon per application. The Dock tile and the Cmd+Tab
  switcher show the app, not a window, and windows have no icon of their
  own. `setAppIcon(icon)` sets `NSApplication.applicationIconImage` from
  `icon.macos`, replacing the bundle's `CFBundleIconFile` or the generic
  executable icon for the running process. Finder and Launchpad still show
  the bundle's `.icns`; write one with
  [`writeIconFiles` and `makeMacApp`](../build.md).
- Windows has an icon per window and one in the executable. Each `HWND`
  carries its own title bar, taskbar and Alt+Tab icon, set with
  `WindowOptions.icon` or `Window.setIcon(icon)` from `icon.windows.ico`.
  Explorer, shortcuts and pinned taskbar buttons read the `.ico` resource
  embedded in the `.exe` at build time (`bun build --compile
  --windows-icon=app.ico`). There is no process-wide runtime icon, so
  `setAppIcon` is a no-op on Windows, and `Window.setIcon` is a no-op on
  macOS.

## Icon

```ts
type Icon = {
  windows?: { ico: Uint8Array };
  macos?: { symbol?: string; png?: Uint8Array; template?: boolean };
};
```

One shape serves trays, menu items, windows and the app icon; each platform
reads only its own section, and an omitted section means that platform's
stock image.

| Field | Meaning |
|---|---|
| `windows.ico` | A `.ico` file's bytes. The best-fitting image is chosen per use: 16 px for trays and menus, 32 px for toasts and balloons, both for a window. |
| `macos.symbol` | An SF Symbol name, preferred over `png` when both are set. |
| `macos.png` | PNG bytes, sized by the use: 18 x 18 points in the menu bar, 16 x 16 in menus, as is for the Dock. Supply 2x pixels for Retina. |
| `macos.template` | Monochrome, recolored by the system for light and dark. Default `true` in the menu bar and menus, `false` for the Dock. |

## Icon encoders and the PNG decoder

These are pure TypeScript with no native code and no image library: they
run on any OS and any thread, which lets a build script on Linux produce a
Windows `.ico` and a macOS `.icns`.

```ts
import { decodePng, icnsFromPng, icoFromPng, trimTransparent } from "@n1h/sweetview/native";

const png = new Uint8Array(await Bun.file("art/pet.png").arrayBuffer());
await Bun.write("dist/app.ico", icoFromPng(png));   // every Windows size, 16 to 256 px
await Bun.write("dist/app.icns", icnsFromPng(png)); // for CFBundleIconFile
const tight = trimTransparent(decodePng(png));      // crop padding before making a 16 px menu icon
```

From a picture:

| Function | Produces |
|---|---|
| `icoFromPng(png, sizes = APP_ICO_SIZES)` | A multi-size `.ico` from a square PNG, resampled to each size. |
| `icoFromRgba(size, rgba, sizes = APP_ICO_SIZES)` | The same from square top-down RGBA. Sizes above the source are enlarged. |
| `icnsFromPng(png, sizes = [16, 32, 64, 128, 256])` | An `.icns` from a square PNG. Sizes above the source are upscaled. |
| `icnsFromRgba(size, rgba, sizes = [16, 32, 64, 128, 256])` | The same from square RGBA. |
| `APP_ICO_SIZES` | `[16, 20, 24, 32, 40, 48, 64, 128, 256]`: every size Windows draws an icon at. Without the large ones, Explorer and Alt+Tab stretch a small image and the icon blurs. |

A placeholder disc, so an app has an icon before it has art
(`DotIconOptions` is `{ color?: "#rrggbb" or "#rgb", default violet; ring?: hex color of a thin outer ring; sizes? }`):

| Function | Produces |
|---|---|
| `dotIco(opts?)` | A `.ico` of the disc, sizes `opts.sizes` (default 16, 24, 32). |
| `dotPng(size, opts?)` | The disc as a PNG. |
| `dotIcns(opts?)` | An `.icns` of the disc at 16 to 1024 px. |
| `renderDot(size, opts?)` | The anti-aliased disc as top-down RGBA. |

Low-level:

| Function | Does |
|---|---|
| `decodePng(bytes)` | A PNG as `DecodedPng` (`{ width, height, rgba }`, top-down RGBA). Supports 8-bit greyscale, RGB, palette with `tRNS` alpha, greyscale with alpha and RGBA, non-interlaced: what image editors and asset packs write. |
| `trimTransparent(image, margin = 1, threshold = 8)` | Crops to the pixels whose alpha is above `threshold`, as a square centered on them with `margin` transparent pixels around. A fully transparent image comes back unchanged. |
| `encodePng(size, rgba)` | Square RGBA as an 8-bit RGBA PNG. |
| `encodeIco(images)` | A `Map` of pixel size to RGBA as a `.ico`: the 256 px entry stored as PNG, the others as 32-bit bitmaps, largest first. |
| `encodeIcns(images)` | A `Map` of pixel size to PNG bytes as an `.icns`, for sizes 16, 32, 64, 128, 256, 512 and 1024. |

`encodeIco` writes the largest image first on purpose: `bun build --compile
--windows-icon` numbers the file's images in order, and Windows takes the
program's large icon from image number 1. Smallest-first files make Explorer
draw large icons from 16 pixels.

Errors name the problem:

| Condition | Message |
|---|---|
| Not a PNG | `not a PNG` |
| Unsupported PNG | `interlaced PNGs are not supported`, `<n>-bit PNGs are not supported (8-bit only)`, `PNG colour type <n> is not supported`, and truncation messages |
| Non-square input to `icoFromPng` / `icnsFromPng` | `PNG is <w>x<h>; icons want a square image` |
| `.ico` image size outside 1 to 256 | `an .ico image is 1 to 256 pixels a side, not <n>` |
| `.icns` size without an element type | `encodeIcns: no element type for <n>px (use 16, 32, 64, 128, 256, 512, 1024)` |
| `encodePng` with the wrong byte count | `encodePng: <n> bytes is not <s>x<s> RGBA` |
| Bad color | `not a #rgb or #rrggbb colour: <value>` |
