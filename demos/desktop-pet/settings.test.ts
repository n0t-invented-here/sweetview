import { describe, expect, test } from "bun:test";
import { BOTTOM_MAX, BOTTOM_MIN, DEFAULT_SETTINGS, SCALE_MAX, SCALE_MIN, sanitize } from "./settings";

describe("sanitize", () => {
  test("fills gaps with defaults and ignores junk", () => {
    expect(sanitize(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitize({ bottom: "high", scale: null, clickThrough: 1 })).toEqual(DEFAULT_SETTINGS);
  });
  test("keeps values in range, bottom negative included", () => {
    expect(sanitize({ bottom: -300 }).bottom).toBe(-300);
    expect(sanitize({ bottom: -1e9 }).bottom).toBe(BOTTOM_MIN);
    expect(sanitize({ bottom: 1e9 }).bottom).toBe(BOTTOM_MAX);
    expect(sanitize({ scale: 0 }).scale).toBe(SCALE_MIN);
    expect(sanitize({ scale: 100 }).scale).toBe(SCALE_MAX);
    expect(sanitize({ scale: 1.2345 }).scale).toBe(1.23);
    expect(sanitize({ bottom: 12.6 }).bottom).toBe(13);
  });
});
