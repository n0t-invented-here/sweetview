import { describe, expect, test } from "bun:test";
import { colorRef } from "./color-ref";

describe("colorRef", () => {
  test("swaps #rrggbb into COLORREF 0x00bbggrr", () => {
    expect(colorRef("#ff00ff")).toBe(0x00ff00ff);
    expect(colorRef("#112233")).toBe(0x00332211);
    expect(colorRef("00ff00")).toBe(0x0000ff00);
  });
  test("rejects anything else", () => {
    expect(() => colorRef("#fff")).toThrow();
    expect(() => colorRef("magenta")).toThrow();
  });
});
