// The public modules pick their implementation lazily and synchronously, and
// never evaluate the other platform's code (which dlopens its OS libraries).

import { describe, expect, test } from "bun:test";
import { createNotifier, nativeWindow, pickFolder } from "./index";

describe("public modules", () => {
  test("nativeWindow resolves to this platform's implementation on first call", () => {
    // A bogus handle: no window is touched, IsWindowVisible / isVisible just reports false.
    const win = nativeWindow(1n);
    expect(typeof win.show).toBe("function");
    if (process.platform === "win32") expect(win.isVisible()).toBe(false);
  });

  test("pickFolder and createNotifier are plain synchronous functions", () => {
    expect(pickFolder.constructor.name).toBe("Function");
    expect(createNotifier.constructor.name).toBe("Function");
  });

  test.if(process.platform === "win32")("createNotifier without a tray says so", () => {
    expect(() => createNotifier()).toThrow(/create the tray before/);
  });
});
