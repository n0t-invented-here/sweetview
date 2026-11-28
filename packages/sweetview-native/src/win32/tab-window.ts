// Windows: the tab side of a tabbed window's frame. The frame is a `Window`
// made with `{ tabs: true }` (the binding's `Window.create` with a tab strip
// height: a `tao` window whose caption is removed, with the system's border,
// shadow, snap and maximise). This module is what the tabs library asks of
// it beyond a window: where the strip and the page go, activation, the
// strip's drag and resize, the system menu and the tab menu, and its light
// or dark state. The strip and each tab are child webviews of the frame,
// placed by the tabs library in `stripBounds()` and `pageRect()`.
//
// Zero webview imports: stays strictly inside @n1h/sweetview/native.

import { binding } from "../binding";
import { reportCallbackError } from "../callback-errors";
import type { TabFrame as NativeTabFrame, Window as NativeWindow } from "../../prebuilt/binding";
import type { MenuTemplate } from "../menu";
import { keyOf } from "./listener-keys";
import { popupMenu } from "./menu";
import type { Point, Rect } from "../types";
import type { Appearance, ResizeEdge } from "../window";

/** Callbacks a tabs library adds to a frame; each runs after the window's own listeners. */
export type FrameCallbacks = {
  onActivate?(active: boolean): void;
  onResized?(): void;
  onMoved?(): void;
};

export type FrameWindow = {
  readonly hwnd: bigint;
  /** The strip in the frame's client coordinates, physical pixels: where the strip's webview goes. */
  stripBounds(): Rect;
  /** The page area below the strip, in the frame's client coordinates: where the shown tab's webview goes. */
  pageRect(): Rect;
  /** The strip on the screen, physical pixels: a tab dropped inside it joins this window. */
  stripRect(): Rect;
  /** The page area's size in device-independent pixels. */
  pageSize(): { width: number; height: number };
  show(): void;
  hide(): void;
  isVisible(): boolean;
  bounds(): Rect;
  setBounds(rect: Rect): void;
  setTitle(title: string): void;
  scale(): number;
  isForeground(): boolean;
  isMaximized(): boolean;
  minimize(): void;
  toggleMaximize(): void;
  /** Hands the left button's press to the OS move loop; with `held` (strip DIPs), the window first catches up with the cursor. Returns when the button is released. */
  startDrag(held?: Point): void;
  /** Hands the left button's press to the OS size loop from `edge`. Returns when the button is released. */
  startResize(edge: ResizeEdge, held?: Point): void;
  setTopmost(on: boolean): void;
  /** Requested appearance of this frame. */
  appearance(): Appearance;
  /** Effective dark state of this frame (its explicit appearance, or the last system state for "system"). */
  isDark(): boolean;
  /** Updates the system dark state; only changes this frame when its appearance is "system". */
  setSystemDark(dark: boolean): void;
  /** Shows the window's system menu (Restore, Move, Size, Minimize, Maximize, Close) at the cursor. */
  showSystemMenu(): void;
  /** Asks the window to close, as its close button does: its onClose listeners run, or it is disposed. Returns once that happened. */
  requestClose(): void;
  /** Adds callbacks; returns a function that removes them again. */
  addCallbacks(callbacks: FrameCallbacks): () => void;
};

type Entry = { tab: NativeTabFrame; api: FrameWindow };
const frames = new Map<bigint, Entry>();

function callEach(list: Set<FrameCallbacks>, call: (c: FrameCallbacks) => void, name: string): void {
  for (const callbacks of [...list]) {
    try {
      call(callbacks);
    } catch (err) {
      reportCallbackError("internal", err, `sweetview: a tab frame's ${name} callback threw:`);
    }
  }
}

function frameApi(tab: NativeTabFrame): FrameWindow {
  const hwnd = tab.handle;
  // A wrapper of the frame window: it shares the window, its listeners are its own.
  const win: NativeWindow = binding().Window.adopt(hwnd);
  const extras = new Set<FrameCallbacks>();
  let listening = false;
  const listen = () => {
    if (listening || !tab.live) return;
    listening = true;
    tab.onActivate((active) => callEach(extras, (c) => c.onActivate?.(active), "onActivate"));
    const resized = () => callEach(extras, (c) => c.onResized?.(), "onResized");
    const moved = () => callEach(extras, (c) => c.onMoved?.(), "onMoved");
    win.onResize(keyOf(resized), resized);
    win.onMove(keyOf(moved), moved);
  };
  const held = (point?: Point): [number | undefined, number | undefined] => (point ? [point.x, point.y] : [undefined, undefined]);
  return {
    hwnd,
    stripBounds: () => tab.stripRect(),
    pageRect: () => tab.pageRect(),
    stripRect: () => tab.stripScreenRect(),
    pageSize() {
      const page = tab.pageRect();
      const scale = win.scale();
      return { width: Math.max(1, Math.round(page.width / scale)), height: Math.max(1, Math.round(page.height / scale)) };
    },
    show: () => void (tab.live && win.show()),
    hide: () => void (tab.live && win.hide()),
    isVisible: () => tab.live && win.isVisible(),
    bounds: () => win.bounds(),
    setBounds: (rect) => void (tab.live && win.setBounds(rect)),
    setTitle: (title) => void (tab.live && win.setTitle(title)),
    scale: () => win.scale(),
    isForeground: () => tab.isForeground(),
    isMaximized: () => tab.live && win.isMaximized(),
    minimize: () => void (tab.live && win.minimize()),
    toggleMaximize: () => void (tab.live && win.toggleMaximize()),
    startDrag: (point) => tab.startDrag(...held(point)),
    startResize: (edge, point) => tab.startResize(edge, ...held(point)),
    setTopmost: (on) => void (tab.live && win.setTopmost(on)),
    appearance: () => tab.appearance() as Appearance,
    isDark: () => tab.isDark(),
    setSystemDark: (dark) => tab.setSystemDark(dark),
    showSystemMenu: () => tab.showSystemMenu(),
    requestClose: () => tab.requestClose(),
    addCallbacks(callbacks) {
      const entry = { ...callbacks };
      extras.add(entry);
      listen();
      return () => void extras.delete(entry);
    },
  };
}

/** The tab side of the frame of a tabbed window, by its handle; `undefined` for any other window. */
export function getTabFrame(hwnd: bigint): FrameWindow | undefined {
  for (const [handle, entry] of frames) if (!entry.tab.live) frames.delete(handle);
  const known = frames.get(hwnd);
  if (known) return known.api;
  const tab = binding().TabFrame.of(hwnd);
  if (!tab) return undefined;
  const entry = { tab, api: frameApi(tab) };
  frames.set(hwnd, entry);
  return entry.api;
}

/**
 * Updates the system dark state of every frame whose appearance is "system".
 * Frames created with an explicit "light" or "dark" appearance are unaffected.
 * Prefer `FrameWindow.setSystemDark` to update a single frame.
 */
export function setDarkWindows(on: boolean): void {
  for (const tab of binding().TabFrame.all()) tab.setSystemDark(on);
}

export const windowExists = (hwnd: bigint): boolean => binding().windowExists(hwnd);
export const leftButtonDown = (): boolean => binding().leftButtonDown();
export const cursorPosition = (): Point => binding().cursor();

/**
 * Shows `template` as a popup menu at the cursor, owned by `owner` (a tabbed
 * window's frame, or any window of this thread), and runs the chosen item's
 * click handler. Blocks until the menu closes. The menu is the one
 * `Menu.popup` shows: submenus, icons, check marks, separators and disabled
 * items. Returns whether an item was chosen.
 */
export function showTabPopupMenu(owner: bigint, template: MenuTemplate): boolean {
  return popupMenu(owner, template);
}

/**
 * Shows the Windows system titlebar menu (Restore, Move, Size, Minimize,
 * Maximize, Close) of `hwnd`, any window of this thread, at the cursor, and
 * carries out the chosen command (`WM_SYSCOMMAND`). Blocks until it closes.
 */
export function windowMenu(hwnd: bigint): void {
  binding().windowMenu(hwnd);
}
