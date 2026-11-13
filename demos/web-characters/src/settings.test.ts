import { describe, expect, test } from "bun:test";
import { BOTTOM_MAX, BOTTOM_MIN, DEFAULT_CHARACTER_SETTINGS, SCALE_MAX, SCALE_MIN, sanitizeCharacterSettings } from "./settings";

describe("sanitizeCharacterSettings", () => {
  test("fills gaps with the current values (the defaults when none) and ignores junk", () => {
    expect(sanitizeCharacterSettings(undefined)).toEqual(DEFAULT_CHARACTER_SETTINGS);
    expect(sanitizeCharacterSettings({ bottom: "high", scale: null })).toEqual(DEFAULT_CHARACTER_SETTINGS);
    expect(sanitizeCharacterSettings({ bottom: 7 }, { scale: 2, bottom: 0 })).toEqual({ scale: 2, bottom: 7 });
  });
  test("keeps values in range, bottom negative included", () => {
    expect(sanitizeCharacterSettings({ bottom: -300 }).bottom).toBe(-300);
    expect(sanitizeCharacterSettings({ bottom: -1e9 }).bottom).toBe(BOTTOM_MIN);
    expect(sanitizeCharacterSettings({ bottom: 1e9 }).bottom).toBe(BOTTOM_MAX);
    expect(sanitizeCharacterSettings({ scale: 0 }).scale).toBe(SCALE_MIN);
    expect(sanitizeCharacterSettings({ scale: 100 }).scale).toBe(SCALE_MAX);
    expect(sanitizeCharacterSettings({ scale: 1.2345 }).scale).toBe(1.23);
    expect(sanitizeCharacterSettings({ bottom: 12.6 }).bottom).toBe(13);
  });
});
