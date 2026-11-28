// How a demo asks for its window's size. On Windows: the page's size in CSS pixels
// (`contentSize`), which Sweetview frames at the screen's scale and centres. On macOS, until the
// macOS goal of the Rust rewrite, the outer frame the demo passed at tag `pre-rust-rewrite`
// (`rust-rewrite/HANDOFF-macos.md`, section 8): macOS keeps the tag's path there.

import type { Rect } from "@n1h/sweetview/native";

export function demoWindowSize(page: { width: number; height: number }, tagBounds: () => Rect): { contentSize: { width: number; height: number } } | { bounds: Rect } {
  return process.platform === "darwin" ? { bounds: tagBounds() } : { contentSize: page };
}
