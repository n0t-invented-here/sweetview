// A frameless window whose page draws its own chrome: the title bar, the
// minimise / maximise / close buttons and the resize handles are the page's,
// what the user does with them is the OS's. The page tells the UI thread
// which part was pressed, and the UI thread hands the gesture to the window
// manager (Window.startDrag / startResize), so moving snaps
// and docks like a real window and resizing lays the page out live.
//
// Two halves, one method table between them, both in this module because it
// imports nothing native (the native and ipc imports are type-only):
//
//   UI thread:  uiMethods: { ...windowChromeMethods(settingsWindow, { chrome: "page" }), ... }
//               windowChromeEvents(settingsWindow, view);   // after WebView.attach: maximise changes reach the page
//   page:       const chrome = windowChromeControls(webviewTransport());
//               chrome.onMaximizeChange((maximized) => …);
//               <div onPointerDown={chrome.onTitlePointerDown}>…</div>
//               {resizeHandles().map((h) => <div key={h.edge} style={{ position: "absolute", ...h.style }} onPointerDown={chrome.onHandlePointerDown(h.edge)} />)}
//
// The window: new Window({ frame: false, transparent: true, ... })
// paired with WebView.attach(win, { ... }); the page is see-through outside what it draws.

import type { Transport } from "@n1h/sweetview-ipc";
import type { ResizeEdge, Window } from "@n1h/sweetview-native";

/** Who draws the frame: the page (frameless, see-through window) or the OS (a plain framed window hosting the same page). */
export type WindowChromeKind = "page" | "os";

export type WindowChromeInfo = { chrome: WindowChromeKind; maximized: boolean };

/** The UI-thread methods a page-drawn chrome calls. Add to the app's method map: `type Methods = WindowChromeMethods & { … }`. */
export type WindowChromeMethods = {
  /** Whether the page draws the chrome ("page") or the OS does ("os"), and whether the window is maximised. */
  "window.info": [void, WindowChromeInfo];
  /** The page's title bar was pressed: the OS moves the window with the cursor until the button comes up. */
  "window.drag": [void, void];
  /** One of the page's resize handles was pressed: the OS resizes from that edge until the button comes up. */
  "window.resize": [ResizeEdge, void];
  "window.minimize": [void, void];
  /** Toggles: maximised <-> previous bounds. */
  "window.maximize": [void, void];
  /** The page's title bar was right-clicked: the window's system menu at the cursor (Windows; nothing on macOS). */
  "window.systemMenu": [void, void];
  /** What the page's close button does; `windowChromeMethods` hides the window unless told otherwise. */
  "window.close": [void, void];
};

/** The UI-thread event a page-drawn chrome listens to. Add to the app's event map: `type Events = WindowChromeEvents & { … }`. */
export type WindowChromeEvents = {
  /** The window became maximised or was restored, by any means (`Window#onMaximizeChange`). */
  "window.maximized": { maximized: boolean };
};

type Method<K extends keyof WindowChromeMethods> = (params: WindowChromeMethods[K][0]) => WindowChromeMethods[K][1];
/** `window.systemMenu` is absent on macOS, whose table is the tag's. */
export type WindowChromeMethodTable = { [K in Exclude<keyof WindowChromeMethods, "window.systemMenu">]: Method<K> } & { "window.systemMenu"?: Method<"window.systemMenu"> };

export type WindowChromeOptions = {
  /** What `window.info` reports; the page renders bare when it says "os". Default "page". */
  chrome?: WindowChromeKind;
  /** What the close button does. Default: hide the window (a tray or a menu shows it again); pass `() => app.quit()` for a main window. */
  onClose?: () => void;
};

/** The UI-thread half: the `window.*` methods, answered by the window they are given. Spread into `uiMethods`. */
export function windowChromeMethods(
  window: Pick<Window, "hide" | "isMaximized" | "startDrag" | "startResize" | "minimize" | "toggleMaximize"> & Partial<Pick<Window, "showSystemMenu">>,
  options: WindowChromeOptions = {},
): WindowChromeMethodTable {
  const chrome = options.chrome ?? "page";
  const onClose = options.onClose ?? (() => window.hide());
  const table = {
    "window.info": () => ({ chrome, maximized: window.isMaximized() }),
    "window.drag": () => window.startDrag(),
    "window.resize": (edge: ResizeEdge) => window.startResize(edge),
    "window.minimize": () => window.minimize(),
    "window.maximize": () => window.toggleMaximize(),
    "window.close": onClose,
  };
  // macOS keeps the tag's table until its goal (rust-rewrite/HANDOFF-macos.md, section 8): no
  // window.systemMenu there, which would replace an application's own method of that name with one
  // that does nothing. This module loads in pages too, so it asks the platform itself rather than
  // the native package's macosKeepsTagPath().
  if (typeof process !== "undefined" && process.platform === "darwin") return table as WindowChromeMethodTable;
  // A window object without showSystemMenu gets no window.systemMenu: an application's own method of that name stays its own.
  if (window.showSystemMenu === undefined) return table as WindowChromeMethodTable;
  return { ...table, "window.systemMenu": () => window.showSystemMenu!() };
}

/**
 * The UI-thread half of the maximise state: sends `window.maximized` to the
 * page each time `window` becomes maximised or is restored (the page's button
 * or a double click on its title bar, the system menu, `toggleMaximize()`
 * from anywhere).
 * Call it once the webview is attached; returns the function that stops it.
 */
export function windowChromeEvents(
  window: Pick<Window, "onMaximizeChange">,
  view: { emit(name: "window.maximized", payload: { maximized: boolean }): void },
): () => void {
  return window.onMaximizeChange((maximized) => view.emit("window.maximized", { maximized }));
}

/** The page half: what to call from the chrome's elements. Framework-free; pass `webviewTransport()`. */
export type WindowChromeControls = {
  /** Whether to draw the chrome at all, and the maximised state (for the restore glyph and square corners) when the page asks. */
  info(): Promise<WindowChromeInfo>;
  /** Called with each change of the maximised state, which `windowChromeEvents` sends from the UI thread. Returns the function that stops it. */
  onMaximizeChange(fn: (maximized: boolean) => void): () => void;
  /** For the title bar's pointer-down: a primary-button press hands the move to the OS. Other buttons are ignored. */
  onTitlePointerDown(event: { button: number }): void;
  /** For a resize handle's pointer-down, one handler per edge. */
  onHandlePointerDown(edge: ResizeEdge): (event: { button: number }) => void;
  minimize(): void;
  toggleMaximize(): void;
  /** For the title bar's context menu event: the window's system menu (call `preventDefault()` on the event yourself). */
  showSystemMenu(): void;
  close(): void;
};

export function windowChromeControls(transport: Transport): WindowChromeControls {
  const call = <K extends keyof WindowChromeMethods>(method: K, params: WindowChromeMethods[K][0] | null = null) => transport.notify(method, params);
  return {
    info: () => transport.call("window.info", null) as Promise<WindowChromeInfo>,
    onMaximizeChange: (fn) =>
      transport.onEvent((name, payload) => {
        if (name === "window.maximized") fn((payload as WindowChromeEvents["window.maximized"]).maximized);
      }),
    onTitlePointerDown: (e) => {
      if (e.button === 0) call("window.drag");
    },
    onHandlePointerDown: (edge) => (e) => {
      if (e.button === 0) call("window.resize", edge);
    },
    minimize: () => call("window.minimize"),
    toggleMaximize: () => call("window.maximize"),
    showSystemMenu: () => call("window.systemMenu"),
    close: () => call("window.close"),
  };
}

export type ResizeHandle = {
  edge: ResizeEdge;
  /** Absolute placement inside the window, CSS pixels, plus the cursor; add `position: "absolute"`. */
  style: { top?: number; right?: number; bottom?: number; left?: number; width?: number; height?: number; cursor: string };
};

/**
 * The eight resize handles along the window's edges: four strips `thickness`
 * CSS pixels wide and four corner squares twice that, each with the cursor
 * the OS would show there. Lay them over the page (hidden while maximised).
 */
export function resizeHandles(thickness = 6): ResizeHandle[] {
  const t = thickness;
  const c = thickness * 2;
  return [
    { edge: "top", style: { top: 0, left: t, right: t, height: t, cursor: "ns-resize" } },
    { edge: "bottom", style: { bottom: 0, left: t, right: t, height: t, cursor: "ns-resize" } },
    { edge: "left", style: { left: 0, top: t, bottom: t, width: t, cursor: "ew-resize" } },
    { edge: "right", style: { right: 0, top: t, bottom: t, width: t, cursor: "ew-resize" } },
    { edge: "top-left", style: { top: 0, left: 0, width: c, height: c, cursor: "nwse-resize" } },
    { edge: "bottom-right", style: { bottom: 0, right: 0, width: c, height: c, cursor: "nwse-resize" } },
    { edge: "top-right", style: { top: 0, right: 0, width: c, height: c, cursor: "nesw-resize" } },
    { edge: "bottom-left", style: { bottom: 0, left: 0, width: c, height: c, cursor: "nesw-resize" } },
  ];
}
