import { expect, test } from "bun:test";
import { LAST_TAB, shortcutFor, type Key } from "./shortcuts";

const key = (virtualKey: number, modifiers = "ctrl"): Key => ({
  virtualKey,
  control: modifiers.includes("ctrl"),
  shift: modifiers.includes("shift"),
  alt: modifiers.includes("alt"),
});
const T = 0x54;
const W = 0x57;
const TAB = 0x09;
const F4 = 0x73;

test("the keys every tabbed Windows app answers to", () => {
  expect(shortcutFor(key(T))).toBe("new");
  expect(shortcutFor(key(W))).toBe("close");
  expect(shortcutFor(key(F4))).toBe("close");
  expect(shortcutFor(key(TAB))).toBe("next");
  expect(shortcutFor(key(TAB, "ctrl shift"))).toBe("previous");
  expect(shortcutFor(key(0x22))).toBe("next"); // Page Down
  expect(shortcutFor(key(0x21))).toBe("previous"); // Page Up
  expect(shortcutFor(key(F4, "alt"))).toBe("closeWindow");
});

test("Ctrl+1 to Ctrl+8 pick a tab by place, Ctrl+9 the last", () => {
  expect(shortcutFor(key(0x31))).toEqual({ select: 0 });
  expect(shortcutFor(key(0x38))).toEqual({ select: 7 });
  expect(shortcutFor(key(0x39))).toEqual({ select: LAST_TAB });
});

test("everything else is left to the page and the browser", () => {
  expect(shortcutFor(key(T, ""))).toBeUndefined();
  expect(shortcutFor(key(T, "ctrl shift"))).toBeUndefined();
  expect(shortcutFor(key(W, "ctrl alt"))).toBeUndefined();
  expect(shortcutFor(key(0x46))).toBeUndefined();
  expect(shortcutFor(key(0x52))).toBeUndefined();
  expect(shortcutFor(key(F4, "ctrl alt"))).toBeUndefined();
  expect(shortcutFor(key(0x30))).toBeUndefined();
});
