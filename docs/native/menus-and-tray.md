# Menus and the tray

Menus in Sweetview are data: an array of items, or a function returning one.
The same template drives a context menu (`Menu.popup`), a tray menu (`Tray`),
and menu-item icons. This page also covers the macOS application menu bar and
activation policy, which have no per-window equivalent on Windows. Part of
the [native module](../native.md).

- [Menu templates](#menu-templates)
- [Menu.popup](#menupopup)
- [Tray](#tray)
  - [Clicks: why macOS differs](#clicks-why-macos-differs)
- [setAppMenu](#setappmenu)
- [setActivationPolicy](#setactivationpolicy)

## Menu templates

```ts
import { quitEventLoop, type MenuTemplate } from "@n1h/sweetview/native";

let paused = false;
const exportPng = () => console.log("exporting as PNG");

const menu = (): MenuTemplate => [
  { label: "Pause", checked: paused, click: () => { paused = !paused; } },
  { label: "Export", submenu: [{ label: "As PNG", click: exportPng }, { label: "As SVG", enabled: false }] },
  { type: "separator" },
  { label: "Quit", click: () => quitEventLoop() },
];
```

The [tray example](#tray) runs a template like this one end to end.

| Item | Fields |
|---|---|
| item (`type` omitted or `"item"`) | `label`; `enabled` (default `true`); `checked`; `icon`; `click` |
| submenu (`type` omitted or `"submenu"`) | `label`; `enabled`; `icon`; `submenu: MenuTemplate` |
| separator | `{ type: "separator" }` |

`MenuSource` is a `MenuTemplate` or a function returning one. The function
form is called every time the menu is about to open, so labels, check marks
and enabled state follow app state without bookkeeping. `resolveMenu(source)`
performs that resolution: `undefined` gives `[]`, a function is called, an
array is returned as is.

A menu item `icon` is an [`Icon`](event-loop-and-icons.md#icon): the 16 px
image from `icon.windows.ico` on Windows, and on macOS `icon.macos.symbol` or
`icon.macos.png` as a 16 pt template image.

Click handlers run on the UI thread, from inside the OS menu loop. Return
quickly. Under the blocking `webview.run()` loop Bun's own event loop is not
turning, so a handler cannot await anything; defer work to the worker or to a
`runEventLoop` app ([event loop](event-loop-and-icons.md)).

## Menu.popup

```ts
import { Clipboard, Menu, type MenuTemplate, type Window } from "@n1h/sweetview/native";

let selection = "Hello";
const copy = () => Clipboard.writeText(selection);
const paste = () => { selection = Clipboard.readText() ?? selection; };

const contextMenu = (): MenuTemplate => [
  { label: "Copy", click: copy },
  { label: "Paste", enabled: Clipboard.readText() !== null, click: paste },
];

// Call from a UI-thread callback: a deferredUiMethods handler, a tray click, a window callback.
export const showContextMenu = (win: Window): boolean => Menu.popup(win, contextMenu);
```

`Menu.popup(owner, menu: MenuSource, at?: Point, options?: MenuPopupOptions): boolean`,
where `owner` is a `Window`, any object with a `handle`, or a raw
`WindowHandle`, opens a context menu at screen point `at`, or at the cursor
when `at` is omitted, blocks until it closes, runs the chosen item's `click`,
and returns `true` if an item was chosen. An empty template returns `false`
without showing anything.

The menu opens downward: its top-left corner is at the point. With
`{ above: true }` it opens upward instead, its bottom-left corner at the
point, as the [tray's menu](#clicks-why-macos-differs) does, so a menu shown
near the bottom of the screen (over the taskbar) sits above the point:

```ts
import { Menu, Screen, type MenuTemplate, type Window } from "@n1h/sweetview/native";

const statusMenu: MenuTemplate = [{ label: "Open" }, { label: "Quit" }];

// At the cursor, upward; `at` may be given too.
export const showStatusMenu = (win: Window): boolean => Menu.popup(win, statusMenu, Screen.cursor(), { above: true });
```

| `MenuPopupOptions` | Meaning |
|---|---|
| `above` | `true`: the menu's bottom-left corner at the point, so it opens upward. Default `false`: its top-left corner there. Near a screen edge the OS moves the menu to fit either way. macOS: accepted and has no effect until the macOS goal of the Rust rewrite; the menu opens downward. |

`owner` is structural: a `Window`, any object with a `handle` (a wrapper from
another library), or a raw handle. The platforms use it differently:

- Windows: `TrackPopupMenu` needs an owner `HWND` to receive the menu's
  messages, and the owner is brought to the foreground first so the menu
  closes when the user clicks elsewhere. Pass the window the menu belongs to.
  An item is chosen with either mouse button (letting go of the right button
  over it, so a menu opened by a right click is worked in one gesture) or
  from the keyboard.
- macOS: the menu opens with
  `popUpMenuPositioningItem:atLocation:inView:` and no view, positioned in
  screen coordinates. AppKit menus are not owned by windows, so `owner` is
  ignored and may be `null`.

### Windows: the menu handle, and a window's system menu

`Menu.popup` owns its menu from start to end: it builds the native menu from
the template (check marks, icons, submenus, separators, disabled items),
shows it, tracks it until it closes, runs the chosen item's `click` and frees
the menu. An `HMENU` that the application tracks itself, with its own
`TrackPopupMenu`, or sets as a window's menu bar, has no public call in 1.0.

[`Window#showSystemMenu()`](windows.md#window-members) shows a `Window`'s
system menu (Restore, Move, Size, Minimize, Maximize, Close) at the cursor,
with Restore enabled while the OS has the window maximized (`IsZoomed`), Move,
Size and Maximize while it has not, and Minimize always, and posts the chosen
command as the title bar's own menu does.
For any other window of the UI thread, one the application made itself
included, wrap it once and call `showSystemMenu()` on that one object each
time, for example from the window's right-click handler:

```ts
import { Window } from "@n1h/sweetview-native";

const win = Window.fromHandle(hwnd); // once, when the window is made
// in the right-click handler:
win.showSystemMenu();
// when the window goes:
win.dispose();
```

The wrapper is kept until `win.dispose()` or the end of the application, so
wrapping the window again on each click keeps one more each time. One thing
differs from the tag's `windowMenu(hwnd)`, which only borrowed the handle for
the call: `Window.fromHandle` throws for a null handle and for a value that
names no window, where `windowMenu` did nothing. A wrapper used only for the
menu changes nothing of the window: a window Sweetview did not make gets a
subclass only while a listener is attached to a wrapper of it (`onResize`,
`onMove`, `onMaximizeChange`, `onClose`, `onFileDrop`), as before 1.0.

## Tray

A complete tray app, runnable as `bun run tray.ts`: a status item with a
menu, a settings window it opens, and a Quit that ends the loop. Nothing
follows the loop: when the script ends, Sweetview removes the tray and closes
the window ([the end of the application](../app.md#the-end-of-the-application)).
On macOS, until the macOS goal of the Rust rewrite, dispose both and call
`process.exit()` after the loop instead.
The settings window is a bare native window here; attach a page to it
with [`WebView.attach`](../app.md#webviewattach) for real content.

```ts
// tray.ts
import { Tray, Window, dotIco, quitEventLoop, runEventLoop, setActivationPolicy, type MenuTemplate } from "@n1h/sweetview/native";

setActivationPolicy("accessory"); // macOS: no Dock icon; a no-op on Windows

const settings = new Window({ title: "Settings", bounds: { x: 200, y: 200, width: 420, height: 300 } });
settings.onClose(() => settings.hide()); // keep it for the next Open Settings
const openSettings = () => settings.show();

let paused = false;
const menu = (): MenuTemplate => [
  { label: "Open Settings", click: openSettings },
  {
    label: "Pause",
    checked: paused,
    click: () => {
      paused = !paused;
      tray.setTooltip(paused ? "My app (paused)" : "My app");
    },
  },
  { type: "separator" },
  { label: "Quit", click: () => quitEventLoop() },
];

const tray = new Tray({
  tooltip: "My app",
  icon: { windows: { ico: dotIco() }, macos: { symbol: "gearshape" } },
  menu,
  onDoubleClick: openSettings, // Windows only: macOS opens the menu instead
});

await runEventLoop(); // after Quit the script ends: Sweetview removes the tray and closes the window
```

A `Tray` is an icon in the Windows notification area, or a status item in the
macOS menu bar. `createTray(options)` is the same as `new Tray(options)`.

| Option | Meaning |
|---|---|
| `tooltip` | Hover text. |
| `icon` | An [`Icon`](event-loop-and-icons.md#icon). Windows uses the `.ico` (a 16 px image, plus 20, 24 and 32 px for higher DPI); macOS uses the SF Symbol or the PNG at 18 x 18 points (36 px for Retina), as a template image by default. |
| `menu` | A `MenuSource`, resolved each time it opens. |
| `onClick` | Left single click. Fires only when the click did not become a double click. |
| `onDoubleClick` | Left double click. |

| Method | Meaning |
|---|---|
| `setTooltip(text)` | Changes the tooltip. |
| `setIcon(icon)` | Changes the icon. |
| `setMenu(menu)` | Replaces the menu; `undefined` removes it. |
| `dispose()` | Removes the icon now. On Windows the icon is removed when the application ends anyway ([the end of the application](../app.md#the-end-of-the-application)); call it for a tray that should go before that. Safe to call twice. |

Without an icon, Windows shows the stock application icon (`IDI_APPLICATION`)
and macOS shows the text `●` in the menu bar, so a tray is never invisible.
On Windows the icon survives an Explorer restart: Sweetview re-adds it when
the taskbar is recreated.

### Clicks: why macOS differs

The two shells have different conventions, and Sweetview follows each:

| | Windows | macOS |
|---|---|---|
| Menu opens on | right click | any click, when a menu is set |
| `onClick` / `onDoubleClick` | always | only when no menu is set |

On Windows the tray icon is a button: left click is the app's primary action,
right click is its menu, which opens upward from the cursor (its bottom-left
corner at the cursor), above the taskbar. On macOS a menu bar status item is a menu: users
expect any click to open it, as with every other item in the menu bar. So
when a tray has a menu, macOS opens it on left and right click alike and
`onClick` and `onDoubleClick` never fire.

A tray that should behave the same on both platforms puts its primary action
in the menu, as the first item, and uses `onClick` / `onDoubleClick` only as
a Windows shortcut for it, as the [tray example](#tray) does with Open
Settings.

A macOS tray with no menu receives left clicks in `onClick` and
`onDoubleClick`, which suits a status item that toggles a popover window.

## setAppMenu

```ts
import { setAppMenu } from "@n1h/sweetview/native";

setAppMenu({ appName: "Notes", aboutText: "Notes 1.0" });
```

macOS has one menu bar at the top of the screen, owned by the active
application rather than by any window. The webview library creates
`NSApplication` without one, so without `setAppMenu` the app has no menu bar
entries and Cmd+Q, Cmd+C, Cmd+V and Cmd+Z do nothing in the page.
`setAppMenu` installs the standard pair:

- the application menu: About (showing `aboutText`) and Quit (Cmd+Q);
- an Edit menu: Undo, Redo, Cut, Copy, Paste, Select All, routed to the
  focused view so the webview handles them.

It also sets the activation policy to `regular`, since only a regular app
shows a menu bar. Call it on the UI thread before the loop starts.

On Windows it does nothing. Windows has no application-wide menu bar: menus
belong to a window (a page-drawn menu, or a native one) or to the tray, and
editing shortcuts work in the webview without one.

## setActivationPolicy

```ts
import { setActivationPolicy } from "@n1h/sweetview/native";

setActivationPolicy("accessory"); // a menu-bar app: no Dock icon, no Cmd+Tab
```

`ActivationPolicy` is macOS's `NSApplicationActivationPolicy`, a property of
the whole process:

| Policy | Dock icon and Cmd+Tab | Menu bar | Windows and menus |
|---|---|---|---|
| `regular` | yes | owns it when active | yes |
| `accessory` | no | no | yes |
| `prohibited` | no | no | no |

Use `accessory` for a menu-bar or tray app. On Windows the call is a no-op,
because taskbar and Alt+Tab presence is decided per window, with
[`hideFromTaskbar`](windows.md#stacking-focus-and-the-taskbar).

The reverse also holds: `hideFromTaskbar: true` on any macOS window switches
the whole app to `accessory`, since macOS cannot hide one window from the
Dock and Cmd+Tab. `setAppMenu` switches it back to `regular`. When both are
used, the last call wins.
