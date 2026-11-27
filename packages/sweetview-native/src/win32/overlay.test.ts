// A colour key, `#rrggbb`, becomes the window's COLORREF (0x00bbggrr); the
// parsing lives in the Rust logic crate (`sweetview-window-logic`, `color`),
// and this reads the result back from a real layered window.

import { describe, expect, test } from "bun:test";
import { Window } from "../window";

const onWindows = process.platform === "win32";

/** GetLayeredWindowAttributes: the colour key, alpha and flags of a layered window. */
async function layeredAttributes(hwnd: bigint): Promise<{ key: number; alpha: number; flags: number }> {
  const { layeredAttributes: read } = await import("../../test/win32-os");
  const attributes = read(hwnd);
  expect(attributes).not.toBeNull();
  return attributes!;
}

describe.if(onWindows)("colorKey", () => {
  test("swaps #rrggbb into COLORREF 0x00bbggrr", async () => {
    for (const [colorKey, colorref] of [["#ff00ff", 0x00ff00ff], ["#112233", 0x00332211], ["00ff00", 0x0000ff00]] as const) {
      const win = new Window({ title: `overlay.test ${colorKey}`, frame: false, colorKey });
      try {
        const { key, flags } = await layeredAttributes(BigInt(win.handle!));
        expect(key).toBe(colorref);
        expect(flags & 0x1).toBe(0x1); // LWA_COLORKEY
      } finally {
        win.dispose();
      }
    }
  });

  test("rejects anything else", () => {
    expect(() => new Window({ colorKey: "#fff" })).toThrow("sweetview: color key must be #rrggbb, got #fff");
    expect(() => new Window({ colorKey: "magenta" })).toThrow("sweetview: color key must be #rrggbb, got magenta");
  });

  test("opacity sets the layered alpha, alone or with a colour key", async () => {
    const win = new Window({ title: "overlay.test opacity", frame: false, opacity: 0.5, colorKey: "#010203" });
    try {
      const { key, alpha, flags } = await layeredAttributes(BigInt(win.handle!));
      expect(alpha).toBe(128);
      expect(key).toBe(0x00030201);
      expect(flags).toBe(0x1 | 0x2); // LWA_COLORKEY | LWA_ALPHA
    } finally {
      win.dispose();
    }
  });
});
