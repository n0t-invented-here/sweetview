// Shared geometry and handle types with zero runtime dependencies so browser-safe
// subpaths (`native/hit-regions`, `window-chrome`) can import them cleanly.

import type { Pointer } from "bun:ffi";

/** A native window handle (HWND on Windows, NSWindow* on macOS). */
export type WindowHandle = Pointer | bigint | number | null;

/** Either a Window instance or a raw WindowHandle. */
export type WindowRef = { readonly handle: WindowHandle } | WindowHandle;

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };

/** Unwraps a Window instance or raw WindowHandle to its underlying WindowHandle. */
export const unwrapHandle = (win: WindowRef | null | undefined): WindowHandle =>
  win !== null && win !== undefined && typeof win === "object" && "handle" in win ? win.handle : (win ?? null);
