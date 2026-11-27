// The Windows backend of a tabbed `Window` (`new Window({ tabs: true })`): a
// frame window from tab-window.ts, with the same events and file drops as a
// plain window. Still bun:ffi until the tabs group moves it to the binding;
// win32/window.ts reaches it through `createTabbedWindow` only.

import { ptr } from "bun:ffi";
import type { Rect, WindowBackend, WindowOptions } from "../window";
import { advapi32, shell32, wstr } from "./api";
import { clearWindowIcon, setWindowIcon } from "./icon";
import { STRIP_HEIGHT } from "./strip-shared";
import { createFrameWindow } from "./tab-window";

type EventBucket = {
  resize: Set<(bounds: Rect) => void>;
  move: Set<(bounds: Rect) => void>;
  close: Set<() => void>;
  fileDrop: Set<(paths: string[]) => void>;
};

const eventsByHwnd = new Map<bigint, EventBucket>();

function bucketFor(hwnd: bigint): EventBucket {
  let b = eventsByHwnd.get(hwnd);
  if (!b) {
    b = { resize: new Set(), move: new Set(), close: new Set(), fileDrop: new Set() };
    eventsByHwnd.set(hwnd, b);
  }
  return b;
}

function hasAnyListeners(b: EventBucket | undefined): boolean {
  return b !== undefined && (b.resize.size > 0 || b.move.size > 0 || b.close.size > 0 || b.fileDrop.size > 0);
}

function subscribeFileDrop(hwnd: bigint, handler: (paths: string[]) => void): () => void {
  const bucket = bucketFor(hwnd);
  if (bucket.fileDrop.size === 0) shell32.DragAcceptFiles(hwnd, 1);
  const listener = (paths: string[]) => handler(paths);
  bucket.fileDrop.add(listener);
  return () => {
    if (!bucket.fileDrop.delete(listener) || bucket.fileDrop.size > 0 || eventsByHwnd.get(hwnd) !== bucket) return;
    shell32.DragAcceptFiles(hwnd, 0);
    if (!hasAnyListeners(bucket)) eventsByHwnd.delete(hwnd);
  };
}

function fireFileDrop(hwnd: bigint, drop: bigint): void {
  const listeners = eventsByHwnd.get(hwnd)?.fileDrop;
  const paths: string[] = [];
  try {
    if (!listeners?.size) return;
    const count = shell32.DragQueryFileW(drop, 0xffff_ffff, null, 0);
    for (let index = 0; index < count; index++) {
      const length = shell32.DragQueryFileW(drop, index, null, 0);
      const buffer = Buffer.alloc((length + 1) * 2);
      const copied = shell32.DragQueryFileW(drop, index, buffer, length + 1);
      if (copied > 0) paths.push(buffer.toString("utf16le", 0, copied * 2));
    }
  } catch (err) {
    console.error("sweetview: could not read dropped files:", err);
  } finally {
    shell32.DragFinish(drop);
  }
  if (!paths.length) return;
  for (const handler of [...(listeners ?? [])]) {
    try {
      handler(paths);
    } catch (err) {
      console.error("sweetview: onFileDrop handler threw:", err);
    }
  }
}

function fire(set: Set<(bounds: Rect) => void> | undefined, bounds: () => Rect, name: string): void {
  if (!set || set.size === 0) return;
  const r = bounds();
  for (const fn of [...set]) {
    try {
      fn(r);
    } catch (err) {
      console.error(`sweetview: ${name} handler threw:`, err);
    }
  }
}

function fireClose(hwnd: bigint): boolean {
  const b = eventsByHwnd.get(hwnd);
  if (!b || b.close.size === 0) return false;
  for (const fn of [...b.close]) {
    try {
      fn();
    } catch (err) {
      console.error("sweetview: onClose handler threw:", err);
    }
  }
  return true;
}

function cleanupHwnd(hwnd: bigint): void {
  const fileDrop = eventsByHwnd.get(hwnd)?.fileDrop;
  if (fileDrop?.size) {
    shell32.DragAcceptFiles(hwnd, 0);
    fileDrop.clear();
  }
  eventsByHwnd.delete(hwnd);
  clearWindowIcon(hwnd);
}

/** Diagnostic for tests: per-window entries this module still keeps. */
export function tabbedTrackedCount(hwnd: bigint): number {
  return eventsByHwnd.has(hwnd) ? 1 : 0;
}

const HKEY_CURRENT_USER = 0xffffffff80000001n;
const RRF_RT_REG_DWORD = 0x10;
const PERSONALIZE_KEY = wstr("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");
const APPS_USE_LIGHT_THEME = wstr("AppsUseLightTheme");

/** True when Windows apps are set to the dark theme. */
export function systemIsDark(): boolean {
  const value = new Uint32Array([1]);
  const bytes = new Uint32Array([4]);
  const status = advapi32.RegGetValueW(HKEY_CURRENT_USER, ptr(PERSONALIZE_KEY), ptr(APPS_USE_LIGHT_THEME), RRF_RT_REG_DWORD, null, ptr(value), ptr(bytes));
  return status === 0 && value[0] === 0;
}

export function createTabbedWindow(options: WindowOptions): WindowBackend {
  const appearance = options.appearance ?? "system";

  let disposed = false;
  let ownerDispose = () => self.dispose();
  const frame = createFrameWindow({
    title: options.title ?? "",
    bounds: options.bounds,
    width: options.bounds ? undefined : 1040,
    height: options.bounds ? undefined : 720 + STRIP_HEIGHT,
    // Outer-frame minimums in physical pixels; the frame supplies a DIP-scaled default when omitted.
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    stripHeight: STRIP_HEIGHT,
    appearance,
    systemDark: appearance === "system" ? systemIsDark() : undefined,
    resizable: options.resizable,
    topmost: options.topmost,
    opacity: options.opacity,
    hideFromTaskbar: options.hideFromTaskbar,
    noActivate: options.noActivate,
    onCloseRequest() {
      if (fireClose(frame.hwnd)) return;
      ownerDispose();
    },
    onActivate() {},
    onResized() {
      fire(eventsByHwnd.get(frame.hwnd)?.resize, () => frame.bounds(), "onResize");
    },
    onMoved() {
      fire(eventsByHwnd.get(frame.hwnd)?.move, () => frame.bounds(), "onMove");
    },
    onFileDrop(drop) {
      fireFileDrop(frame.hwnd, drop);
    },
  });

  if (options.icon?.windows) setWindowIcon(frame.hwnd, options.icon.windows.ico);

  const self: WindowBackend = {
    handle: frame.hwnd,
    isVisible: () => !disposed && frame.isVisible(),
    show: () => {
      if (!disposed) frame.show();
    },
    hide: () => {
      if (!disposed) frame.hide();
    },
    toggle: () => {
      if (self.isVisible()) self.hide();
      else self.show();
    },
    bounds: () => frame.bounds(),
    setBounds: (r) => {
      if (!disposed) frame.setBounds(r);
    },
    moveTo: (x, y) => {
      if (disposed) return;
      const b = frame.bounds();
      frame.setBounds({ x, y, width: b.width, height: b.height });
    },
    resize: (width, height) => {
      if (disposed) return;
      const b = frame.bounds();
      frame.setBounds({ x: b.x, y: b.y, width, height });
    },
    scale: () => frame.scale(),
    setTitle: (title) => {
      if (!disposed) frame.setTitle(title);
    },
    setIcon: (icon) => {
      if (!disposed) setWindowIcon(frame.hwnd, icon?.windows?.ico);
    },
    minimize: () => {
      if (!disposed) frame.minimize();
    },
    toggleMaximize: () => {
      if (!disposed) frame.toggleMaximize();
    },
    isMaximized: () => !disposed && frame.isMaximized(),
    setTopmost: (on) => {
      if (!disposed) frame.setTopmost(on);
    },
    startDrag: () => {
      if (!disposed) frame.startDrag();
    },
    startResize: (edge) => {
      if (!disposed) frame.startResize(edge);
    },
    setClickThrough() {},
    setHitRegions() {},
    onResize(handler) {
      const b = bucketFor(frame.hwnd);
      b.resize.add(handler);
      return () => b.resize.delete(handler);
    },
    onMove(handler) {
      const b = bucketFor(frame.hwnd);
      b.move.add(handler);
      return () => b.move.delete(handler);
    },
    onClose(handler) {
      const b = bucketFor(frame.hwnd);
      b.close.add(handler);
      return () => b.close.delete(handler);
    },
    onFileDrop(handler) {
      return subscribeFileDrop(frame.hwnd, handler);
    },
    setOwnerDispose(fn) {
      ownerDispose = fn;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      cleanupHwnd(frame.hwnd);
      frame.destroy();
    },
  };
  return self;
}
