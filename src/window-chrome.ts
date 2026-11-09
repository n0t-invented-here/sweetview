// A frameless window whose page draws its own chrome: the title bar, the
// minimise / maximise / close buttons and the resize handles are the page's,
// what the user does with them is the OS's. The page tells the UI thread
// which part was pressed, and the UI thread hands the gesture to the window
// manager (sweetnative's Overlay.startDrag / startResize), so moving snaps
// and docks like a real window and resizing lays the page out live.
//
// Two halves, one method table between them, both in this module because it
// imports nothing native (the sweetnative and sweetipc imports are types):
//
//   UI thread:  uiMethods: { ...windowChromeMethods(settingsWindow, { chrome: "page" }), ... }
//   page:       const chrome = windowChromeControls(webviewTransport());
//               <div onPointerDown={chrome.onTitlePointerDown}>…</div>
//               {resizeHandles().map((h) => <div key={h.edge} style={{ position: "absolute", ...h.style }} onPointerDown={chrome.onHandlePointerDown(h.edge)} />)}
//
// The window: createOverlayWindow({ transparent: true, topmost: false, hideFromTaskbar: false, noActivate: false, … })
// and createWebviewApp({ window: it.handle, transparent: true, … }); the page is see-through outside what it draws.

import type { Transport } from "./ipc";
import type { Overlay, ResizeEdge } from "./native";

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
  /** What the page's close button does; `windowChromeMethods` hides the window unless told otherwise. */
  "window.close": [void, void];
};

export type WindowChromeMethodTable = { [K in keyof WindowChromeMethods]: (params: WindowChromeMethods[K][0]) => WindowChromeMethods[K][1] };

export type WindowChromeOptions = {
  /** What `window.info` reports; the page renders bare when it says "os". Default "page". */
  chrome?: WindowChromeKind;
  /** What the close button does. Default: hide the window (a tray or a menu shows it again); pass `app.quit` for a main window. */
  close?: () => void;
};

/** The UI-thread half: the `window.*` methods, answered by the window they are given. Spread into `uiMethods`. */
export function windowChromeMethods(window: Overlay, options: WindowChromeOptions = {}): WindowChromeMethodTable {
  const chrome = options.chrome ?? "page";
  const close = options.close ?? (() => window.hide());
  return {
    "window.info": () => ({ chrome, maximized: window.maximized() }),
    "window.drag": () => window.startDrag(),
    "window.resize": (edge) => window.startResize(edge),
    "window.minimize": () => window.minimize(),
    "window.maximize": () => window.toggleMaximize(),
    "window.close": close,
  };
}

/** The page half: what to call from the chrome's elements. Framework-free; pass `webviewTransport()`. */
export type WindowChromeControls = {
  /** Whether to draw the chrome at all, and the maximised state (for the restore glyph and square corners). Ask again after `toggleMaximize`. */
  info(): Promise<WindowChromeInfo>;
  /** For the title bar's pointer-down: a primary-button press hands the move to the OS. Other buttons are ignored. */
  onTitlePointerDown(event: { button: number }): void;
  /** For a resize handle's pointer-down, one handler per edge. */
  onHandlePointerDown(edge: ResizeEdge): (event: { button: number }) => void;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
};

export function windowChromeControls(transport: Transport): WindowChromeControls {
  const call = <K extends keyof WindowChromeMethods>(method: K, params: WindowChromeMethods[K][0] | null = null) => transport.notify(method, params);
  return {
    info: () => transport.call("window.info", null) as Promise<WindowChromeInfo>,
    onTitlePointerDown: (e) => {
      if (e.button === 0) call("window.drag");
    },
    onHandlePointerDown: (edge) => (e) => {
      if (e.button === 0) call("window.resize", edge);
    },
    minimize: () => call("window.minimize"),
    toggleMaximize: () => call("window.maximize"),
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
