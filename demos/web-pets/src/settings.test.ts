import { describe, expect, test } from "bun:test";
import { BOTTOM_MAX, BOTTOM_MIN, DEFAULT_PET_SETTINGS, SCALE_MAX, SCALE_MIN, sanitizePetSettings } from "./settings";

describe("sanitizePetSettings", () => {
  test("fills gaps with the current values (the defaults when none) and ignores junk", () => {
    expect(sanitizePetSettings(undefined)).toEqual(DEFAULT_PET_SETTINGS);
    expect(sanitizePetSettings({ bottom: "high", scale: null })).toEqual(DEFAULT_PET_SETTINGS);
    expect(sanitizePetSettings({ bottom: 7 }, { scale: 2, bottom: 0 })).toEqual({ scale: 2, bottom: 7 });
  });
  test("keeps values in range, bottom negative included", () => {
    expect(sanitizePetSettings({ bottom: -300 }).bottom).toBe(-300);
    expect(sanitizePetSettings({ bottom: -1e9 }).bottom).toBe(BOTTOM_MIN);
    expect(sanitizePetSettings({ bottom: 1e9 }).bottom).toBe(BOTTOM_MAX);
    expect(sanitizePetSettings({ scale: 0 }).scale).toBe(SCALE_MIN);
    expect(sanitizePetSettings({ scale: 100 }).scale).toBe(SCALE_MAX);
    expect(sanitizePetSettings({ scale: 1.2345 }).scale).toBe(1.23);
    expect(sanitizePetSettings({ bottom: 12.6 }).bottom).toBe(13);
  });
});
