// What the Windows goal added to the macOS window code and holds back until the macOS goal
// (decision D42, rust-rewrite/HANDOFF-macos.md section 8): each answer here is the tag's
// behaviour while `macosKeepsTagPath()` holds. Pure, so the macOS seam test decides it on any
// machine; `darwin/window.ts` asks it before running the added code.

import { macosKeepsTagPath } from "../platform";

/**
 * The `contentSize` a macOS window is made from: none while the seam holds, so the window is
 * made from `bounds` or the default, as at tag `pre-rust-rewrite` (the option did not exist).
 * Held back: the owned window's `initWithContentRect:` path grows the frame twice under
 * `createApp` (the attach reads the outer bounds and sets them as the content size), its
 * centring passes `NaN` through to AppKit, and a tabbed window took the page size as its frame.
 */
export function macosContentSize(options: { contentSize?: { width: number; height: number } }): { width: number; height: number } | undefined {
  return macosKeepsTagPath() ? undefined : options.contentSize;
}

/**
 * Whether `onMaximizeChange` listens on macOS: not while the seam holds (it registers nothing,
 * as at the tag, where the call did not exist). Held back: the resize-notification listener
 * reads `isZoomed` of an `NSWindow` a disposed window has released.
 */
export function macosMaximizeEvents(): boolean {
  return !macosKeepsTagPath();
}
