// Windows screens and the cursor, over the Rust binding: monitors from `tao`,
// work areas from the platform crate. Physical pixels, per-monitor DPI aware.

import { binding } from "../binding";
import type { ScreenInfo } from "../screen";
import type { Point, Rect, WindowHandle } from "../types";
import { asHwnd } from "./window";

export function all(): ScreenInfo[] {
  return binding().screens();
}

export function primary(): ScreenInfo {
  const list = all();
  return list.find((s) => s.primary) ?? list[0]!;
}

export function at(point: Point): ScreenInfo {
  return binding().screenAt(point.x, point.y);
}

export function of(handle: WindowHandle): ScreenInfo {
  return binding().screenOf(asHwnd(handle));
}

export function bounds(): Rect {
  return binding().virtualScreen();
}

export function cursor(): Point {
  return binding().cursor();
}
