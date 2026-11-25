// The public modules pick their implementation lazily and synchronously, and
// never evaluate the other platform's code (which dlopens its OS libraries).

import { describe, expect, test } from "bun:test";
import { createNotifier, Menu, Notifier, pickFolder, Screen, Tray, Window } from "./index";

describe("public modules", () => {
  test("Window.fromHandle resolves to this platform's implementation on first call", () => {
    // A bogus handle: no window is touched, IsWindowVisible / isVisible just reports false.
    const win = Window.fromHandle(1n);
    expect(typeof win.show).toBe("function");
    if (process.platform === "win32") expect(win.isVisible()).toBe(false);
    win.dispose();
  });

  test("pickFolder and createNotifier are plain synchronous functions", () => {
    expect(pickFolder.constructor.name).toBe("Function");
    expect(createNotifier.constructor.name).toBe("Function");
  });

  test.if(process.platform === "win32")("Notifier works standalone without creating a Tray first", () => {
    const notifier = createNotifier();
    expect(notifier).toBeInstanceOf(Notifier);
    notifier.dispose();
    notifier.dispose(); // idempotent
  });

  test.if(process.platform === "win32")("Screen exposes primary, all, at, bounds, and cursor without a window", () => {
    const primary = Screen.primary();
    expect(primary.primary).toBe(true);
    expect(primary.bounds.width).toBeGreaterThan(0);
    expect(primary.bounds.height).toBeGreaterThan(0);
    expect(primary.workArea.width).toBeGreaterThan(0);
    expect(primary.workArea.height).toBeGreaterThan(0);
    expect(primary.scale).toBeGreaterThan(0);

    const all = Screen.all();
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all.some((s) => s.primary)).toBe(true);

    const atPrimary = Screen.at({ x: primary.bounds.x + 10, y: primary.bounds.y + 10 });
    expect(atPrimary.bounds).toEqual(primary.bounds);

    const far = Screen.at({ x: 999_999, y: 999_999 });
    expect(far.bounds.width).toBeGreaterThan(0);

    const combined = Screen.bounds();
    expect(combined.width).toBeGreaterThanOrEqual(primary.bounds.width);
    expect(combined.height).toBeGreaterThanOrEqual(primary.bounds.height);

    const pt = Screen.cursor();
    expect(typeof pt.x).toBe("number");
    expect(typeof pt.y).toBe("number");
  });

  test("Menu and Tray classes are exported", () => {
    expect(typeof Menu.popup).toBe("function");
    expect(typeof Tray).toBe("function");
  });
});
