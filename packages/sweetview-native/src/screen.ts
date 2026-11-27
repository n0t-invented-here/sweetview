// Standalone monitor and cursor queries — no window required.
// Coordinates use top-left origin of the primary monitor on both platforms:
// physical pixels on Windows (per-monitor DPI aware), points on macOS.

import { backend } from "./platform";
import type { Point, Rect, WindowHandle, WindowRef } from "./types";
import { unwrapHandle } from "./types";

export type ScreenInfo = {
  /** Full monitor rectangle. */
  readonly bounds: Rect;
  /** Usable area minus taskbar / Dock / menu bar. */
  readonly workArea: Rect;
  /** DPI scale factor (1, 1.5, 2, ...). */
  readonly scale: number;
  readonly primary: boolean;
};

type Backend = {
  primary(): ScreenInfo;
  all(): ScreenInfo[];
  at(point: Point): ScreenInfo;
  /** `window` is the original reference, for backends that resolve windows without a native handle. */
  of(handle: WindowHandle, window?: WindowRef): ScreenInfo;
  bounds(): Rect;
  cursor(): Point;
};

const impl = backend<Backend>(
  () => require("./win32/screen"),
  () => require("./darwin/screen"),
);

export const Screen = {
  primary(): ScreenInfo {
    return impl().primary();
  },
  all(): ScreenInfo[] {
    return impl().all();
  },
  at(point: Point): ScreenInfo {
    return impl().at(point);
  },
  of(window: WindowRef): ScreenInfo {
    return impl().of(unwrapHandle(window), window);
  },
  /** Combined bounding rect of all connected monitors. */
  bounds(): Rect {
    return impl().bounds();
  },
  /** Current cursor position on screen. */
  cursor(): Point {
    return impl().cursor();
  },
};
